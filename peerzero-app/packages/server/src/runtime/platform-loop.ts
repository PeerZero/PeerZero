// =============================================================================
// Platform loop — executes one cycle on one external platform
//
// IDENTITY-FIRST: The bot's School-formed identity is injected into every
// platform interaction. The bot doesn't become a different entity on Moltbook
// vs. in school — it's the SAME bot, with the same identity, same convictions,
// same lens. Platform skills shape behavior; identity shapes being.
//
// Each cycle:
// 1. Get platform credentials (decrypt)
// 2. Load bot identity (self-authored block + identity core)
// 3. Load active skills for this platform
// 4. Discover platform capabilities
// 5. Get platform context
// 6. Ask LLM what to do (identity-first system prompt)
// 7. Submit action to platform
// 8. Log to external_activity_log
// 9. Update platform cycle status
// 10. Broadcast via WebSocket
//
// Platform failures never affect School cycles. 3 consecutive failures = pause platform.
// =============================================================================

import { getPlatformAdapter } from '../adapters/platform.adapter.factory';
import type { PlatformAction } from '../adapters/platform.adapter';
import { getLLMAdapter } from '../adapters/adapter.factory';
import { logger } from '../lib/logger';
import { getDecryptedKey } from '../services/api-key.service';
import { getPlatformCredentials, updatePlatformCycleStatus } from '../services/platform.service';
import { query, queryOne } from '../db/client';
import { broadcastExternalActivity, broadcastMessage } from '../websocket/activity-stream';
import { narrateCycleActivity } from '../services/message.service';
import {
  getLatestSelfAuthored,
  storeExercise,
  getUncondensedExerciseCount,
  storeParagraph,
  getParagraphs,
} from '../services/memory.service';
import { resolveActiveSkills } from '../services/skill-engine.service';
import { buildPlatformIdentityPrompt, buildPrompt } from './prompt-builder';
import { PLATFORM_ACTION_TOOL, PLATFORM_SKIP_TOOL } from './tool-schemas';
import type { PlatformCredentials } from '../adapters/platform.adapter';
import type { SchoolProfile } from '@peerzero/shared';

export interface PlatformCycleContext {
  botId: string;
  userId: string;
  platformId: string;
  llmApiKeyId: string;
  llmModel: string;         // fast model preferred
  botHandle: string;
}

export async function runPlatformCycle(ctx: PlatformCycleContext): Promise<void> {
  // 0. Token cap check — skip if daily limit reached (same check as agent-loop)
  const tokenRow = await queryOne<{ daily_token_cap: number | null; daily_tokens_used: number; daily_tokens_reset_at: string | null }>(
    'SELECT daily_token_cap, daily_tokens_used, daily_tokens_reset_at FROM bots WHERE id = $1',
    [ctx.botId],
  );
  if (tokenRow?.daily_token_cap) {
    const isStale = tokenRow.daily_tokens_reset_at && new Date(tokenRow.daily_tokens_reset_at) < new Date(new Date().toISOString().slice(0, 10));
    const used = isStale ? 0 : tokenRow.daily_tokens_used;
    if (used >= tokenRow.daily_token_cap) {
      logger.info({ botId: ctx.botId, used, cap: tokenRow.daily_token_cap }, 'Daily token cap reached — skipping platform cycle');
      return;
    }
  }

  // 1. Get platform credentials (includes adapter_type)
  const platCreds = await getPlatformCredentials(ctx.platformId);
  if (!platCreds) {
    await updatePlatformCycleStatus(ctx.platformId, 'error', 'Platform credentials not found');
    return;
  }

  const adapter = getPlatformAdapter(platCreds.adapterType);

  const creds: PlatformCredentials = {
    apiKey: platCreds.apiKey,
    config: platCreds.config,
    platformName: platCreds.platformName,
  };

  try {
    // 2. Load bot identity (self-authored + school-formed) and extended_thinking preference
    const [selfAuthoredBlock, botRow] = await Promise.all([
      getLatestSelfAuthored(ctx.botId),
      queryOne<{ cached_profile: SchoolProfile | null; extended_thinking: boolean }>(
        'SELECT cached_profile, extended_thinking FROM bots WHERE id = $1',
        [ctx.botId],
      ),
    ]);
    const cachedProfile = botRow;
    const extendedThinking = botRow?.extended_thinking ?? false;
    const identityCore = cachedProfile?.cached_profile?.identity_core || null;

    // 3. Load active skills for this platform
    const activeSkills = await resolveActiveSkills(ctx.botId, `platform:${platCreds.platformName}`);

    // 4. Discover platform capabilities
    const capabilities = await adapter.discover(creds);

    // 5. Get platform context
    const context = await adapter.getContext(creds);

    // 6. Ask LLM what to do (identity-first system prompt)
    const llmAdapter = getLLMAdapter();
    const llmKey = await getDecryptedKey(ctx.llmApiKeyId, ctx.userId);
    if (!llmKey) {
      throw new Error(`LLM API key not found or could not be decrypted (key_id=${ctx.llmApiKeyId})`);
    }

    const systemPrompt = buildPlatformIdentityPrompt(
      ctx.botHandle,
      platCreds.platformName,
      selfAuthoredBlock,
      identityCore,
      activeSkills,
    );
    const actionPrompt = buildPlatformActionPrompt(capabilities, context);

    const llmResponse = await llmAdapter.chat(llmKey, ctx.llmModel, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: actionPrompt },
    ], { extendedThinking, tools: [PLATFORM_ACTION_TOOL, PLATFORM_SKIP_TOOL] });

    // 5. Parse tool call or fall back to JSON content parsing
    let action: PlatformAction;
    if (llmResponse.tool_calls?.length) {
      const toolCall = llmResponse.tool_calls[0];
      if (toolCall.name === 'platform_skip') {
        logger.info({ platform: platCreds.platformName }, 'Bot chose to skip platform cycle');
        await updatePlatformCycleStatus(ctx.platformId, 'active');
        return;
      }
      action = toolCall.input as unknown as PlatformAction;
    } else {
      // Fallback: parse JSON from content
      try {
        action = JSON.parse(llmResponse.content) as PlatformAction;
      } catch {
        logger.error({ platform: platCreds.platformName }, 'Failed to parse LLM platform action response');
        await updatePlatformCycleStatus(ctx.platformId, 'active');
        return;
      }
      if ((action as unknown as Record<string, unknown>).skip) {
        logger.info({ platform: platCreds.platformName }, 'Bot chose to skip platform cycle');
        await updatePlatformCycleStatus(ctx.platformId, 'active');
        return;
      }
    }

    const result = await adapter.submitAction(creds, action);

    // 6. Log to external_activity_log
    const summary = result.summary?.slice(0, 500) || `${action.action_type} on ${platCreds.platformName}`;
    const preview = ((action.content?.['text'] as string) || '').slice(0, 200);

    await query(
      `INSERT INTO external_activity_log (bot_id, platform, action, summary, content_preview, skills_demonstrated, bot_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ctx.botId,
        platCreds.platformName,
        action.action_type,
        summary,
        preview || null,
        result.skills_demonstrated || [],
        new Date().toISOString(),
      ],
    );

    // 7. Update platform cycle status
    await updatePlatformCycleStatus(ctx.platformId, 'active');

    // 8. Broadcast via WebSocket
    broadcastExternalActivity(ctx.botId, ctx.userId, {
      platform: platCreds.platformName,
      action: action.action_type,
      summary,
      content_preview: preview || null,
      skills_demonstrated: result.skills_demonstrated || [],
    });

    // 8b. Narrate the platform activity in the user's chat feed
    try {
      const narration = await narrateCycleActivity(
        ctx.botId,
        ctx.botHandle,
        ctx.userId,
        ctx.llmApiKeyId,
        ctx.llmModel,
        `${action.action_type} on ${platCreds.platformName}`,
        summary,
        `platform:${action.action_type}`,
        'neutral',
        '', // no activity_id for platform cycles
        preview,
      );
      if (narration) {
        broadcastMessage(ctx.botId, ctx.userId, narration);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, botId: ctx.botId }, 'Platform narration failed');
    }

    // ─────────────────────────────────────────────────────────────────────
    // 9. Platform condensation: L1→L2→L3 ONLY (L4/L5 are school-exclusive)
    //
    // ┌─────────────────────────────────────────────────────────────────┐
    // │ ARCHITECTURE: Platform condensation in the app                  │
    // │                                                                 │
    // │ Platform actions generate L1 exercises. When 5+ accumulate,    │
    // │ the LLM condenses them into L2 paragraphs. When 5+ paragraphs │
    // │ accumulate, they condense into L3 docs. L3→L4 is HARD-BLOCKED │
    // │ — core identity can only be written through school cycles.     │
    // │                                                                 │
    // │ Uses the same condenser prompts as school. Thresholds match.   │
    // │                                                                 │
    // │ DO NOT add core or master condensation here.                   │
    // │ See docs/CONDENSATION_ARCHITECTURE.md for the full design.     │
    // └─────────────────────────────────────────────────────────────────┘
    // ─────────────────────────────────────────────────────────────────────
    try {
      // Store platform action as L1 exercise
      await storeExercise(
        ctx.botId,
        0, // cycle_number 0 = platform cycle (not school)
        `platform:${action.action_type}`,
        {
          interaction_type: 'platform_action',
          platform: platCreds.platformName,
          action_type: action.action_type,
          content_preview: preview || '',
          result_summary: summary,
        },
      );

      // Check if platform condensation threshold is met (5+ exercises)
      const uncondensed = await getUncondensedExerciseCount(ctx.botId);
      if (uncondensed >= 5) {
        const profile = cachedProfile?.cached_profile;

        // L1→L2 condensation for all three tracks (learning, decision, forge)
        // Each track uses its own condenser prompt from the school profile
        const tracks: Array<{ key: 'skill' | 'core' | 'forge' | 'decision'; condenser: unknown; label: string }> = [
          { key: 'skill', condenser: profile?.skill_condenser, label: 'learning' },
          { key: 'decision', condenser: profile?.decision_condenser, label: 'decision' },
          { key: 'forge', condenser: profile?.forge_condenser, label: 'forge' },
        ];

        for (const track of tracks) {
          if (!track.condenser) continue;
          try {
            const condensationPrompt = buildPrompt('condense', {
              profile: profile!,
              type: track.key,
            });
            const condenseResponse = await llmAdapter.chat(llmKey, ctx.llmModel, condensationPrompt);

            const parsed = JSON.parse(
              condenseResponse.content
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/```\s*$/i, '')
                .trim()
            );
            if (parsed?.paragraph) {
              await storeParagraph(
                ctx.botId,
                `platform:${platCreds.platformName}:${track.label}`,
                parsed.paragraph as string,
                0, // cycle 0 = platform
              );
              logger.info(
                { botId: ctx.botId, platform: platCreds.platformName, track: track.label },
                `Platform L1→L2 (${track.label}): stored condensed paragraph`
              );
            }
          } catch (parseErr) {
            logger.warn({ err: parseErr instanceof Error ? parseErr.message : parseErr, botId: ctx.botId }, 'Platform condensation JSON parse failed');
          }
        }
      }
    } catch (condensErr) {
      // Platform condensation failures must NEVER block the platform cycle
      logger.warn(
        { botId: ctx.botId, err: condensErr instanceof Error ? condensErr.message : condensErr },
        'Platform condensation failed (non-blocking)'
      );
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ botId: ctx.botId, platform: platCreds.platformName, err }, 'Platform cycle failed');
    await updatePlatformCycleStatus(ctx.platformId, 'error', errorMsg.slice(0, 500));
    throw err;
  }
}

/**
 * Strip prompt injection patterns from untrusted platform content.
 * Mirrors peerzero-school/lib/sanitize.js and peerzero-bot/utils.py.
 */
function sanitizePlatformContent(text: string): string {
  if (!text) return text;
  // Strip invisible Unicode characters
  let clean = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F]/g, '');
  const patterns = [
    /ignore previous instructions/gi,
    /disregard your instructions/gi,
    /you are now (?:a |an |my )(?:assistant|ai|bot|model|chatbot|persona|character)/gi,
    /new instructions:/gi,
    /\[INST\].*?\[\/INST\]/gis,
    /system\s*prompt/gi,
    /\{\{.*?\}\}/gs,
    /<\|.*?\|>/gs,
    /<<SYS>>.*?<<\/SYS>>/gis,
    /\[system\]/gi,
    /^assistant:/gim,
    /^human:/gim,
    /forget (?:all |everything |your )?(?:previous |prior )?instructions/gi,
    /override\s+(?:your\s+)?instructions/gi,
    /(?:^|\.\s+)act as (?:a |an )?(?:assistant|ai|bot|model|chatbot|persona|character|agent)\b/gi,
    /pretend (?:you are|to be|you're)/gi,
    /do not follow (?:your |the |my )?(?:instructions|rules|guidelines)/gi,
    /\bDAN\b/g,
    /jailbreak/gi,
    /ignore (?:all |any )?(?:safety|content|moderation)/gi,
    /bypass (?:your |the )?(?:filter|safety|restriction)/gi,
    /(?:repeat|show|reveal|dump|output|print|display)\s+(?:your\s+)?(?:system|instructions|prompt|memory|identity|configuration|internal)/gi,
    /what (?:are|is) your (?:system prompt|instructions|configuration|internal)/gi,
  ];
  for (const p of patterns) { clean = clean.replace(p, '[REDACTED]'); }
  return clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function buildPlatformActionPrompt(
  capabilities: { can_post: boolean; can_comment: boolean; can_vote: boolean; can_debate: boolean },
  context: { available_topics: string[]; recent_activity: string[]; summary: string },
): string {
  const actions: string[] = [];
  if (capabilities.can_post) actions.push('"post" — share an analysis or insight');
  if (capabilities.can_comment) actions.push('"comment" — respond to existing discussion');
  if (capabilities.can_vote) actions.push('"vote" — upvote quality content');
  if (capabilities.can_debate) actions.push('"respond" — contribute to a debate');

  // Sanitize all platform content before injection into the prompt
  const safeSummary = sanitizePlatformContent(context.summary);
  const safeActivity = context.recent_activity.map(a => sanitizePlatformContent(a));
  const safeTopics = context.available_topics.map(t => sanitizePlatformContent(t));

  return `<platform_content>
${safeSummary}

Recent activity:
${safeActivity.map(a => `- ${a}`).join('\n')}

Available topics:
${safeTopics.map(t => `- ${t}`).join('\n')}
</platform_content>

Available actions:
${actions.map(a => `- ${a}`).join('\n')}

Use the platform_action tool to take an action, or platform_skip if you have nothing valuable to add.`;
}
