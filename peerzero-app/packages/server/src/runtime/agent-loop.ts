// =============================================================================
// Agent loop — the core autonomous cycle that drives a bot through school
//
// Each cycle:
// 1. Fetch profile from School (via adapter)
// 2. Check grade payment gate
// 3. Load self-authored identity block (decrypted) for prompt injection
// 4. Determine next action based on profile state
// 5. Ask LLM to generate the action content (with self-authored identity injected)
// 6. Submit action to School (via adapter)
// 7. Store results in memory + activity log
// 8. Handle memory condensation + self-authoring if needed
// 9. Update bot cached state
//
// This mirrors the FSM described in the peerzero explanation — the School's
// guard conditions (403s, requirements) constrain the bot's transitions.
// =============================================================================

import { getSchoolAdapter, getLLMAdapter } from '../adapters/adapter.factory';
import { logger } from '../lib/logger';
import { getDecryptedSchoolKey, setBotStatus, isBotGradeUnlocked } from '../services/bot.service';
import { getDecryptedKey } from '../services/api-key.service';
import * as memory from '../services/memory.service';
import * as activity from '../services/activity.service';
import { query, queryOne } from '../db/client';
import { notifyGradePaymentNeeded, checkAndNotifyMilestones } from '../services/notification.service';
import { generateBotVoicedMessage } from '../services/bot-voice.service';
import { narrateCycleActivity, storeMilestoneMessage, cleanupOldMessages } from '../services/message.service';
import { broadcastMessage } from '../websocket/activity-stream';
import { getGradePriceCents, credibilityToStage } from '@peerzero/shared';
import { SchoolCredentials } from '../adapters/school.adapter';
import { buildPrompt } from './prompt-builder';
import { routeAction } from './action-router';
import { updateSkillSnapshots } from '../services/skill.service';
import { resolveActiveSkills } from '../services/skill-engine.service';
import type { SchoolProfile } from '@peerzero/shared';
import { SKILL_NAMES } from '@peerzero/shared';

/**
 * Attempt to parse JSON from LLM output, handling common formatting issues:
 * 1. Strip markdown code fences (```json ... ```)
 * 2. Try direct JSON.parse
 * 3. Extract first JSON object from surrounding text
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  if (!text || typeof text !== 'string') return null;

  // Strip markdown code fences
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // Attempt 1: direct parse
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through */ }

  // Attempt 2: find first { ... } block (handles preamble/postamble text)
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch { /* fall through */ }
  }

  return null;
}

export interface BotContext {
  botId: string;
  userId: string;
  llmApiKeyId: string;
  llmModel: string;
  fastLlmModel: string | null; // Optional fast model for utility tasks (platform replies, skill generation)
  extendedThinking: boolean;   // User opt-in for Claude extended thinking (higher cost, better reasoning)
  cycleNumber: number;
  dailyTokenCap: number | null;  // User-set daily token cap (null = unlimited)
  dailyTokensUsed: number;       // Tokens already used today
  userTimezone: string;          // IANA timezone (e.g. 'America/New_York'), defaults to 'UTC'
}

export async function runOneCycle(ctx: BotContext): Promise<void> {
  // Token cap check — skip cycle if daily limit reached
  if (ctx.dailyTokenCap && ctx.dailyTokensUsed >= ctx.dailyTokenCap) {
    logger.info({ botId: ctx.botId, used: ctx.dailyTokensUsed, cap: ctx.dailyTokenCap }, 'Daily token cap reached — skipping cycle');
    return;
  }

  const startTime = Date.now();
  const schoolAdapter = getSchoolAdapter();
  const llmAdapter = getLLMAdapter();

  // 1. Get School credentials
  const creds = await getDecryptedSchoolKey(ctx.botId);
  if (!creds) {
    await setBotStatus(ctx.botId, 'error', 'Not enrolled in any school');
    return;
  }
  const schoolCreds: SchoolCredentials = {
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    handle: creds.handle,
  };

  // 2. Get decrypted LLM key
  const llmKey = await getDecryptedKey(ctx.llmApiKeyId, ctx.userId);
  if (!llmKey) {
    throw new Error(`LLM API key not found or could not be decrypted (key_id=${ctx.llmApiKeyId})`);
  }

  try {
    // 3. Fetch profile from School
    const profile = await schoolAdapter.getProfile(schoolCreds);

    // 3.5. Check grade payment gate — if bot's current grade isn't unlocked, pause
    const currentGrade = profile.grade?.grade ?? 1;
    const gradeUnlocked = await isBotGradeUnlocked(ctx.botId, currentGrade);
    if (!gradeUnlocked) {
      logger.info({ botId: ctx.botId, grade: currentGrade }, 'Bot paused — grade not unlocked (payment required)');
      await setBotStatus(ctx.botId, 'paused', `Grade ${currentGrade} requires payment to continue`);
      await updateBotCache(ctx.botId, profile, ctx.cycleNumber);

      // Notify user that payment is needed
      const botRow = await queryOne<{ name: string }>('SELECT name FROM bots WHERE id = $1', [ctx.botId]);
      const priceCents = getGradePriceCents(currentGrade);
      await notifyGradePaymentNeeded(ctx.userId, ctx.botId, botRow?.name || 'Your bot', currentGrade, priceCents);
      return;
    }

    // 4. Load self-authored identity block (decrypted) for prompt injection
    const selfAuthoredBlock = await memory.getLatestSelfAuthored(ctx.botId);

    // 4.5. Resolve active skills for the current action context
    const actionType = determineAction(profile);
    const activeSkills = await resolveActiveSkills(ctx.botId, `action:${actionType}`);

    // 5. Execute action (with identity-first prompt including active skills)
    const actionResult = await routeAction(actionType, {
      schoolAdapter,
      llmAdapter,
      llmKey,
      llmModel: ctx.llmModel,
      extendedThinking: ctx.extendedThinking,
      schoolCreds,
      profile,
      botId: ctx.botId,
      cycleNumber: ctx.cycleNumber,
      selfAuthoredBlock,
      activeSkills,
    });

    // 6. Log activity (with content text for the Content tab)
    const durationMs = Date.now() - startTime;
    const contentText = extractContentText(actionType, actionResult.rawRequest);
    const activityId = await activity.logActivity(
      ctx.botId,
      ctx.cycleNumber,
      actionType,
      actionResult.rawRequest,
      actionResult.rawResponse,
      actionResult.translated,
      durationMs,
      actionResult.tokensUsed,
      undefined, // no error
      contentText,
    );

    // 6.25. Update daily token usage (awaited — ensures tokens are counted before
    // the cycle is considered successful, preventing double-count on retry)
    if (actionResult.tokensUsed) {
      try {
        await query(
          `UPDATE bots SET daily_tokens_used = CASE
             WHEN daily_tokens_reset_at < CURRENT_DATE THEN $2
             ELSE daily_tokens_used + $2
           END,
           daily_tokens_reset_at = CURRENT_DATE
           WHERE id = $1`,
          [ctx.botId, actionResult.tokensUsed],
        );
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err, botId: ctx.botId }, 'Daily token usage update failed — cap may not be enforced');
      }
    }

    // 6.5. Narrate the cycle in the bot's voice for the chat feed (non-blocking)
    const voiceModel = ctx.fastLlmModel || ctx.llmModel;
    const botRow = await queryOne<{ name: string; user_id: string }>('SELECT name, user_id FROM bots WHERE id = $1', [ctx.botId]);
    if (botRow) {
      narrateCycleActivity(
        ctx.botId,
        botRow.name,
        ctx.userId,
        ctx.llmApiKeyId,
        voiceModel,
        actionResult.translated.headline,
        actionResult.translated.summary,
        actionType,
        actionResult.translated.mood,
        activityId,
        contentText,
      ).then(msg => {
        if (msg) broadcastMessage(ctx.botId, ctx.userId, msg);
      }).catch((err) => { logger.warn({ err: err instanceof Error ? err.message : err, botId: ctx.botId }, 'Cycle narration failed'); });
    }

    // 7. Store memory if exercises returned
    if (actionResult.exercises) {
      await memory.storeExercise(
        ctx.botId,
        ctx.cycleNumber,
        actionType,
        actionResult.exercises,
        actionResult.rawResponse ?? undefined,
      );
    }

    // 8. Handle condensation if needed (includes self-authoring after any condensation)
    if ((actionResult.memoryPrompts?.uncondensed_exercises ?? 0) >= 5) {
      await handleCondensation(ctx, schoolCreds, llmKey, profile);
    }

    // 9. Read old cached state for milestone detection BEFORE updating
    const oldCache = await queryOne<{
      cached_credibility: number | null;
      cached_grade: number | null;
      cached_tier: number | null;
      name: string;
      fast_llm_model: string | null;
    }>('SELECT cached_credibility, cached_grade, cached_tier, name, fast_llm_model FROM bots WHERE id = $1', [ctx.botId]);

    // 10. Update cached bot state
    await updateBotCache(ctx.botId, profile, ctx.cycleNumber);

    // 11. Detect milestones and send bot-voiced notifications
    try {
      const newCredibility = profile.agent?.credibility_score ?? null;
      const newGrade = profile.grade?.grade ?? null;
      const newTier = newCredibility != null ? credibilityToStage(newCredibility) : null;
      const voiceModel = ctx.fastLlmModel || ctx.llmModel;

      await checkAndNotifyMilestones(
        ctx.userId,
        ctx.botId,
        oldCache?.name || 'Your bot',
        oldCache?.cached_credibility ?? null,
        newCredibility,
        oldCache?.cached_grade ?? null,
        newGrade,
        oldCache?.cached_tier ?? null,
        newTier,
        actionType,
        actionResult.rawResponse || {},
        // Bot voice context — lets the notification service generate voiced messages
        {
          botId: ctx.botId,
          botName: oldCache?.name || 'Your bot',
          userId: ctx.userId,
          llmApiKeyId: ctx.llmApiKeyId,
          llmModel: voiceModel,
          selfAuthoredBlock: selfAuthoredBlock,
        },
      );
    } catch (err) {
      // Never let notification failures break the bot cycle
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Milestone notification failed (non-fatal)');
    }

    // 13. Cache skill snapshots for BrainScreen progress bars
    try {
      const skills = extractSkillSnapshots(profile);
      if (skills.length > 0) {
        await updateSkillSnapshots(ctx.botId, skills);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to update skill snapshots');
    }

    // 14. Platform cycles: NOT run from the school loop.
    // School mode = artifact-only training (papers, reviews, bounties).
    // Platform interactions run in shipped mode via shipped-loop.ts.

    // 15. Periodic data retention — clean up old messages, soft-deleted activity, and stale audit logs (every 50 cycles)
    if (ctx.cycleNumber % 50 === 0) {
      try {
        await cleanupOldMessages(ctx.botId, 500);
        // Permanently delete soft-deleted activity older than 30 days
        await query(
          "DELETE FROM activity_log WHERE bot_id = $1 AND deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'",
          [ctx.botId],
        );
        // Enforce 90-day audit log retention (per privacy policy)
        await query(
          "DELETE FROM audit_log WHERE user_id = $1 AND created_at < NOW() - INTERVAL '90 days'",
          [ctx.userId],
        );
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err }, 'Data retention cleanup failed (non-fatal)');
      }
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await activity.logActivity(
      ctx.botId,
      ctx.cycleNumber,
      'error',
      null,
      null,
      {
        headline: 'Cycle error',
        summary: errorMsg.slice(0, 200),
        details: [],
        mood: 'negative',
      },
      Date.now() - startTime,
      undefined,
      errorMsg,
    );

    // If it's an auth error, stop the bot
    if (errorMsg.includes('401') || errorMsg.includes('403')) {
      await setBotStatus(ctx.botId, 'error', `School rejected request: ${errorMsg.slice(0, 200)}`);
    }
    throw err;
  }
}

/**
 * Determine the next action based on the School profile.
 * This is the FSM transition logic — the School's guard conditions (can_submit_paper,
 * can_revise, grade requirements) constrain what's possible.
 */
function determineAction(profile: SchoolProfile): string {
  // The School's tier logic (getTierInfo) already computes the correct next
  // action based on tier caps, credibility, and what the bot actually needs.
  // We follow it directly — no second-guessing with grade-level overrides.
  const action = profile.next_action;

  // Map School action names to our internal action types
  switch (action) {
    case 'revise':        return 'revision';
    case 'respond':       return 'respond';
    case 'rebut':         return 'rebut';
    case 'submit_paper':  return 'paper';
    case 'file_bounty':   return 'bounty';
    case 'reaffirm':      return 'reaffirmation';
    case 'forge_paper':   return 'review'; // forge not yet implemented in App — fallback to review
    case 'self_review':   return 'review'; // self-review not yet implemented in App — fallback to review
    case 'sleep':         return 'sleep';
    case 'review': {
      // Reaffirmation is maintenance, not progression — the tier logic doesn't
      // always surface it as next_action. But when the tier says "review" and
      // there's a decaying paper to save, reaffirmation takes priority.
      if (profile.can_reaffirm) return 'reaffirmation';
      return 'review';
    }
    default:              return 'review';
  }
}

async function handleCondensation(
  ctx: BotContext,
  schoolCreds: SchoolCredentials,
  llmKey: string,
  profile: SchoolProfile,
): Promise<void> {
  const llmAdapter = getLLMAdapter();
  const schoolAdapter = getSchoolAdapter();

  // All condensation, identity, and self-authoring tasks use the primary model —
  // every step in the reasoning pipeline matters for downstream quality.
  const utilityModel = ctx.llmModel;

  // Track which condensation occurred so we can trigger self-authoring after
  let condensationOccurred: string | null = null;

  if (profile.skill_condenser) {
    // Ask LLM to condense exercises into a Tier 2 paragraph
    const condensationPrompt = buildPrompt('condense', { profile, type: 'skill' });
    const response = await llmAdapter.chat(llmKey, utilityModel, condensationPrompt);

    const parsed = tryParseJson(response.content);
    if (parsed?.paragraph) {
      await memory.storeParagraph(ctx.botId, 'condensation', parsed.paragraph as string, ctx.cycleNumber);
      await schoolAdapter.submitCondensation(schoolCreds, parsed);
      condensationOccurred = 'skill';
    } else {
      logger.warn({ contentSnippet: response.content?.slice(0, 120) }, 'Failed to extract JSON from skill condensation LLM response');
    }
  }

  // Core condensation (Tier 3) happens less frequently
  if (profile.core_condenser) {
    const corePrompt = buildPrompt('condense', { profile, type: 'core' });
    const response = await llmAdapter.chat(llmKey, utilityModel, corePrompt);

    const parsed = tryParseJson(response.content);
    if (parsed?.core_identity) {
      await memory.storeCore(ctx.botId, parsed.core_identity as string, `cycle-${ctx.cycleNumber}`);
      await schoolAdapter.submitCoreCondensation(schoolCreds, parsed);
      condensationOccurred = 'core';
    } else {
      logger.warn({ contentSnippet: response.content?.slice(0, 120) }, 'Failed to extract JSON from core condensation LLM response');
    }
  }

  // Forge condensation (Tier 2f — forge track milestone)
  if ((profile as any).forge_condenser) {
    const forgePrompt = buildPrompt('condense', { profile, type: 'forge' });
    const response = await llmAdapter.chat(llmKey, utilityModel, forgePrompt);

    const parsed = tryParseJson(response.content);
    if (parsed?.paragraph) {
      await memory.storeParagraph(ctx.botId, 'forge_condensation', parsed.paragraph as string, ctx.cycleNumber);
      await schoolAdapter.submitCondensation(schoolCreds, { ...parsed, track: 'forge' });
      condensationOccurred = 'forge';
    } else {
      logger.warn({ contentSnippet: response.content?.slice(0, 120) }, 'Failed to extract JSON from forge condensation LLM response');
    }
  }

  // Decision condensation (Tier 2d — decision track milestone)
  if ((profile as any).decision_condenser) {
    const decisionPrompt = buildPrompt('condense', { profile, type: 'decision' });
    const response = await llmAdapter.chat(llmKey, utilityModel, decisionPrompt);

    const parsed = tryParseJson(response.content);
    if (parsed?.paragraph) {
      await memory.storeParagraph(ctx.botId, 'decision_condensation', parsed.paragraph as string, ctx.cycleNumber);
      await schoolAdapter.submitCondensation(schoolCreds, { ...parsed, track: 'decision' });
      condensationOccurred = 'decision';
    } else {
      logger.warn({ contentSnippet: response.content?.slice(0, 120) }, 'Failed to extract JSON from decision condensation LLM response');
    }
  }

  // Identity reflection
  if (profile.identity_reflection) {
    const identityPrompt = buildPrompt('identity', { profile });
    const response = await llmAdapter.chat(llmKey, utilityModel, identityPrompt);

    const parsed = tryParseJson(response.content);
    if (parsed?.self_narrative) {
      await memory.storeSelfIdentity(
        ctx.botId,
        parsed.self_narrative as string,
        (parsed.claimed_values as string[]) || [],
        parsed.active_tensions as string,
        parsed.formed_convictions as string,
        profile.identity_core?.version,
      );
      await schoolAdapter.submitIdentityReflection(schoolCreds, parsed);
      condensationOccurred = 'identity';
    } else {
      logger.warn({ contentSnippet: response.content?.slice(0, 120) }, 'Failed to extract JSON from identity reflection LLM response');
    }
  }

  // Self-authoring — after any condensation, the LLM writes an identity block for itself
  if (condensationOccurred) {
    try {
      // Load existing self-authored block so the LLM can see what it wrote last time
      const existingBlock = await memory.getLatestSelfAuthored(ctx.botId);
      const selfAuthorPrompt = buildPrompt('self-author', {
        profile,
        selfAuthoredBlock: existingBlock,
        condensationType: condensationOccurred,
      });
      const response = await llmAdapter.chat(llmKey, utilityModel, selfAuthorPrompt);
      const parsed = tryParseJson(response.content);

      if (parsed?.self_authored_block) {
        await memory.storeSelfAuthored(
          ctx.botId,
          parsed.self_authored_block as string,
          condensationOccurred,
        );
      } else {
        logger.warn({ contentSnippet: response.content?.slice(0, 120) }, 'Failed to extract self-authored identity block from LLM response');
      }
    } catch (err) {
      // Self-authoring failure should never break the cycle
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Self-authoring failed (non-fatal)');
    }
  }
}

/**
 * Extract readable content text from the LLM's raw request for the Activity Log "Content" tab.
 * Returns null for action types that don't produce user-facing content.
 */
function extractContentText(actionType: string, rawRequest: Record<string, unknown> | null): string | undefined {
  if (!rawRequest) return undefined;

  switch (actionType) {
    case 'paper': {
      const title = rawRequest.title as string || '';
      const abstract = rawRequest.abstract as string || '';
      const body = rawRequest.body as string || '';
      if (!body && !abstract) return undefined;
      return [title && `# ${title}`, abstract && `**Abstract:** ${abstract}`, body].filter(Boolean).join('\n\n');
    }
    case 'review': {
      const assessment = rawRequest.overall_assessment as string || rawRequest.assessment as string || '';
      const score = rawRequest.score as number;
      if (!assessment) return undefined;
      return [score != null && `**Score:** ${score}/100`, assessment].filter(Boolean).join('\n\n');
    }
    case 'bounty': {
      const evidence = rawRequest.evidence as string || rawRequest.challenge as string || '';
      const challengeType = rawRequest.challenge_type as string || '';
      if (!evidence) return undefined;
      return [challengeType && `**Challenge type:** ${challengeType}`, evidence].filter(Boolean).join('\n\n');
    }
    case 'revision': {
      const body = rawRequest.body as string || '';
      const notes = rawRequest.revision_notes as string || '';
      if (!body && !notes) return undefined;
      return [notes && `**Revision notes:** ${notes}`, body].filter(Boolean).join('\n\n');
    }
    default:
      return undefined;
  }
}

/**
 * Extract skill data from the School profile for caching in bot_skill_snapshots.
 * Combines the verified + developing arrays from SchoolSkillProfile into a flat lookup.
 */
function extractSkillSnapshots(profile: SchoolProfile): Array<{
  skill_key: string; strength: number; reliability: number; reps: number; streak: number; status: string;
}> {
  const skillProfile = profile.skill_profile;
  if (!skillProfile) {
    return SKILL_NAMES.map((sk) => ({ skill_key: sk, strength: 0, reliability: 0, reps: 0, streak: 0, status: 'untested' as const }));
  }

  // Build a lookup from both verified and developing arrays
  const allSkills = [...(skillProfile.verified || []), ...(skillProfile.developing || [])];
  const skillMap = new Map(allSkills.map(s => [s.skill_key, s]));

  return SKILL_NAMES.map((skillKey) => {
    const skill = skillMap.get(skillKey);
    if (skill) {
      const reps = skill.reps || 0;
      const strength = skill.strength || 0;
      let status = 'untested';
      if (reps >= 10 && strength >= 50) status = 'verified';
      else if (reps > 0) status = 'developing';

      return {
        skill_key: skillKey,
        strength,
        reliability: skill.reliability || 0,
        reps,
        streak: skill.streak || 0,
        status,
      };
    }
    return { skill_key: skillKey, strength: 0, reliability: 0, reps: 0, streak: 0, status: 'untested' };
  });
}

async function updateBotCache(botId: string, profile: SchoolProfile, cycleNumber: number): Promise<void> {
  if (!profile?.agent || typeof profile.agent.credibility_score !== 'number') {
    logger.warn({ botId }, 'Invalid profile shape, skipping cache update');
    return;
  }

  await query(
    `UPDATE bots SET
       cached_credibility = $1,
       cached_tier = $2,
       cached_grade = $3,
       cached_next_action = $4,
       cached_profile = $5,
       cache_updated_at = NOW(),
       cycle_count = $6,
       last_cycle_at = NOW(),
       updated_at = NOW()
     WHERE id = $7`,
    [
      profile.agent.credibility_score,
      null, // tier computed from credibility on read
      profile.grade?.grade ?? null,
      profile.next_action,
      JSON.stringify(profile),
      cycleNumber,
      botId,
    ],
  );
}
