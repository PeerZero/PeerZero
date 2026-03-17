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
import { getDecryptedKey } from '../services/apikey.service';
import * as memory from '../services/memory.service';
import * as activity from '../services/activity.service';
import { query, queryOne } from '../db/client';
import { notifyGradePaymentNeeded } from '../services/notification.service';
import { getGradePriceCents } from '@peerzero/shared';
import { SchoolCredentials } from '../adapters/school.adapter';
import { buildPrompt } from './prompt-builder';
import { routeAction } from './action-router';
import { updateSkillSnapshots } from '../services/skill.service';
import { schedulePlatformJobs } from '../jobs/platform-queue';
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
  fastLlmModel: string | null; // Optional fast model for utility tasks (condensation, identity)
  cycleNumber: number;
}

export async function runOneCycle(ctx: BotContext): Promise<void> {
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

  try {
    // 3. Fetch profile from School
    const profile = await schoolAdapter.getProfile(schoolCreds);

    // 3.5. Check grade payment gate — if bot's current grade isn't unlocked, pause
    const currentGrade = profile.grade?.grade || 1;
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

    // 5. Determine and execute action
    const actionType = determineAction(profile);
    const actionResult = await routeAction(actionType, {
      schoolAdapter,
      llmAdapter,
      llmKey,
      llmModel: ctx.llmModel,
      schoolCreds,
      profile,
      botId: ctx.botId,
      cycleNumber: ctx.cycleNumber,
      selfAuthoredBlock,
    });

    // 6. Log activity (with content text for the Content tab)
    const durationMs = Date.now() - startTime;
    const contentText = extractContentText(actionType, actionResult.rawRequest);
    await activity.logActivity(
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

    // 9. Update cached bot state
    await updateBotCache(ctx.botId, profile, ctx.cycleNumber);

    // 10. Cache skill snapshots for BrainScreen progress bars
    try {
      const skills = extractSkillSnapshots(profile);
      if (skills.length > 0) {
        await updateSkillSnapshots(ctx.botId, skills);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to update skill snapshots');
    }

    // 11. Schedule platform cycles for any active platform connections
    try {
      const utilityModel = ctx.fastLlmModel || ctx.llmModel;
      await schedulePlatformJobs(ctx.botId, ctx.userId, ctx.llmApiKeyId, utilityModel);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to schedule platform cycles');
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
  // Priority order matches the School's intended progression:
  // 1. If revision is available, revise (highest priority — fix mistakes)
  if (profile.can_revise) return 'revision';

  // 2. If we need more reviews for grade advancement, review
  const grade = profile.grade;
  if (grade && !grade.advanced && grade.reviews_this_grade < grade.requirements.reviews) {
    return 'review';
  }

  // 3. If we can submit a paper, do so
  if (profile.can_submit_paper) return 'paper';

  // 4. If we can reaffirm, do it
  if (profile.can_reaffirm) return 'reaffirmation';

  // 5. If bounties are needed for grade
  if (grade && !grade.advanced && grade.bounties_this_grade < grade.requirements.bounties) {
    return 'bounty';
  }

  // 6. Default: review (always available)
  return 'review';
}

async function handleCondensation(
  ctx: BotContext,
  schoolCreds: SchoolCredentials,
  llmKey: string,
  profile: SchoolProfile,
): Promise<void> {
  const llmAdapter = getLLMAdapter();
  const schoolAdapter = getSchoolAdapter();

  // Use fast model for condensation/identity tasks when available (cost optimization)
  const utilityModel = ctx.fastLlmModel || ctx.llmModel;

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
    return SKILL_NAMES.map(sk => ({ skill_key: sk, strength: 0, reliability: 0, reps: 0, streak: 0, status: 'untested' }));
  }

  // Build a lookup from both verified and developing arrays
  const allSkills = [...(skillProfile.verified || []), ...(skillProfile.developing || [])];
  const skillMap = new Map(allSkills.map(s => [s.skill_key, s]));

  return SKILL_NAMES.map(skillKey => {
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
      profile.grade?.grade || null,
      profile.next_action,
      JSON.stringify(profile),
      cycleNumber,
      botId,
    ],
  );
}
