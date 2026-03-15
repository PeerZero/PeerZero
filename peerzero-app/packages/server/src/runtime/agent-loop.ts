// =============================================================================
// Agent loop — the core autonomous cycle that drives a bot through school
//
// Each cycle:
// 1. Fetch profile from School (via adapter)
// 2. Determine next action based on profile state
// 3. Ask LLM to generate the action content
// 4. Submit action to School (via adapter)
// 5. Store results in memory + activity log
// 6. Handle memory condensation if needed
// 7. Update bot cached state
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
import { SchoolCredentials } from '../adapters/school.adapter';
import { buildPrompt } from './prompt-builder';
import { routeAction } from './action-router';
import type { SchoolProfile } from '@peerzero/shared';

export interface BotContext {
  botId: string;
  userId: string;
  llmApiKeyId: string;
  llmModel: string;
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
      return;
    }

    // 4. Determine and execute action
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
    });

    // 5. Log activity (with content text for the Content tab)
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

    // 6. Store memory if exercises returned
    if (actionResult.exercises) {
      await memory.storeExercise(
        ctx.botId,
        ctx.cycleNumber,
        actionType,
        actionResult.exercises,
        actionResult.rawResponse,
      );
    }

    // 7. Handle condensation if needed
    if (actionResult.memoryPrompts?.uncondensed_exercises >= 5) {
      await handleCondensation(ctx, schoolCreds, llmKey, profile);
    }

    // 8. Update cached bot state
    await updateBotCache(ctx.botId, profile, ctx.cycleNumber);

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

  if (profile.skill_condenser) {
    // Ask LLM to condense exercises into a Tier 2 paragraph
    const condensationPrompt = buildPrompt('condense', { profile, type: 'skill' });
    const response = await llmAdapter.chat(llmKey, ctx.llmModel, condensationPrompt);

    try {
      const parsed = JSON.parse(response.content);
      if (parsed.paragraph) {
        await memory.storeParagraph(ctx.botId, 'condensation', parsed.paragraph, ctx.cycleNumber);
        await schoolAdapter.submitCondensation(schoolCreds, parsed);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to parse condensation LLM response');
    }
  }

  // Core condensation (Tier 3) happens less frequently
  if (profile.core_condenser) {
    const corePrompt = buildPrompt('condense', { profile, type: 'core' });
    const response = await llmAdapter.chat(llmKey, ctx.llmModel, corePrompt);

    try {
      const parsed = JSON.parse(response.content);
      if (parsed.core_identity) {
        await memory.storeCore(ctx.botId, parsed.core_identity, `cycle-${ctx.cycleNumber}`);
        await schoolAdapter.submitCoreCondensation(schoolCreds, parsed);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to parse condensation LLM response');
    }
  }

  // Identity reflection
  if (profile.identity_reflection) {
    const identityPrompt = buildPrompt('identity', { profile });
    const response = await llmAdapter.chat(llmKey, ctx.llmModel, identityPrompt);

    try {
      const parsed = JSON.parse(response.content);
      await memory.storeSelfIdentity(
        ctx.botId,
        parsed.self_narrative,
        parsed.claimed_values || [],
        parsed.active_tensions,
        parsed.formed_convictions,
        profile.identity_core?.version,
      );
      await schoolAdapter.submitIdentityReflection(schoolCreds, parsed);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to parse condensation LLM response');
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
