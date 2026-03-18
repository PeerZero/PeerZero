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
import { getDecryptedKey } from '../services/apikey.service';
import { getPlatformCredentials, updatePlatformCycleStatus } from '../services/platform.service';
import { query, queryOne } from '../db/client';
import { broadcastExternalActivity } from '../websocket/activity-stream';
import { getLatestSelfAuthored } from '../services/memory.service';
import { resolveActiveSkills } from '../services/skill-engine.service';
import { buildPlatformIdentityPrompt } from './prompt-builder';
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
        logger.warn({ platform: platCreds.platformName }, 'Failed to parse LLM platform action response');
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

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ botId: ctx.botId, platform: platCreds.platformName, err }, 'Platform cycle failed');
    await updatePlatformCycleStatus(ctx.platformId, 'error', errorMsg.slice(0, 500));
    throw err;
  }
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

  return `<platform_content>
${context.summary}

Recent activity:
${context.recent_activity.map(a => `- ${a}`).join('\n')}

Available topics:
${context.available_topics.map(t => `- ${t}`).join('\n')}
</platform_content>

Available actions:
${actions.map(a => `- ${a}`).join('\n')}

Use the platform_action tool to take an action, or platform_skip if you have nothing valuable to add.`;
}
