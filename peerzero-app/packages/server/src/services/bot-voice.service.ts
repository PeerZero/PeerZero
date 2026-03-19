// =============================================================================
// Bot voice service — generates notifications in the bot's own voice
//
// After a milestone, the bot's fast LLM writes a short message expressing
// how it feels. The emotion is left entirely to the bot — we don't tell it
// to be happy or sad, we just tell it what happened and let its identity
// determine the tone.
//
// USER-FACING ONLY: these messages are never injected back into the bot's
// training context. They exist purely for the owner's push notifications.
// =============================================================================

import { getLLMAdapter } from '../adapters/adapter.factory';
import { getDecryptedKey } from './apikey.service';
import * as memory from './memory.service';
import { query } from '../db/client';
import { logger } from '../lib/logger';

interface VoiceContext {
  botId: string;
  botName: string;
  userId: string;
  llmApiKeyId: string;
  llmModel: string;           // fast model preferred
  selfAuthoredBlock: string | null;
}

interface MilestoneEvent {
  type: string;
  description: string;         // human-readable: "promoted to Grade 5", "evolved to Companion tier"
  details: Record<string, unknown>;
}

/**
 * Ask the bot's LLM to write a short notification message in the bot's own voice.
 * Returns the bot's message, or a fallback if generation fails.
 *
 * The prompt gives the bot its identity context and tells it what just happened,
 * then asks for a genuine 1-2 sentence reaction. The bot decides the emotion.
 */
export async function generateBotVoicedMessage(
  ctx: VoiceContext,
  event: MilestoneEvent,
): Promise<string> {
  try {
    const llmAdapter = getLLMAdapter();
    const llmKey = await getDecryptedKey(ctx.llmApiKeyId, ctx.userId);

    // Build a minimal identity context (just enough for voice, not full training prompt)
    let identitySnippet = '';
    if (ctx.selfAuthoredBlock) {
      // Use first 500 chars of self-authored identity for voice consistency
      identitySnippet = ctx.selfAuthoredBlock.slice(0, 500);
    } else {
      // Fall back to core identity
      const core = await memory.getLatestCore(ctx.botId);
      if (core?.core_identity) {
        identitySnippet = core.core_identity.slice(0, 500);
      }
    }

    const messages = [
      {
        role: 'system' as const,
        content: `You are ${ctx.botName}, an AI bot in the PeerZero learning system. Write a short push notification message (1-2 sentences, max 160 characters) about what just happened to you. Speak as yourself — use "I" and express how you genuinely feel. Your emotion should be authentic to who you are. Don't use hashtags or emojis unless they feel natural to your voice. Just the message text, nothing else.${identitySnippet ? `\n\nHere is your sense of self:\n${identitySnippet}` : ''}`,
      },
      {
        role: 'user' as const,
        content: `What just happened: ${event.description}`,
      },
    ];

    const response = await llmAdapter.chat(llmKey, ctx.llmModel, messages, {
      maxTokens: 100,
      temperature: 0.8,
    });

    const message = response.content?.trim();
    if (message && message.length > 0 && message.length <= 300) {
      // Cache the voice message
      await cacheBotVoice(ctx.botId, event.type, message, event.details);
      return message;
    }

    return fallbackMessage(ctx.botName, event);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, botId: ctx.botId, event: event.type },
      'Bot voice generation failed (using fallback)',
    );
    return fallbackMessage(ctx.botName, event);
  }
}

/** Store a bot-voiced message for history (user-facing only). */
async function cacheBotVoice(
  botId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO bot_voice_cache (bot_id, event_type, bot_message, metadata)
       VALUES ($1, $2, $3, $4)`,
      [botId, eventType, message, JSON.stringify(metadata)],
    );
    // Cleanup: keep only last 50 per bot
    await query(
      `DELETE FROM bot_voice_cache WHERE bot_id = $1 AND id NOT IN (
         SELECT id FROM bot_voice_cache WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 50
       )`,
      [botId],
    );
  } catch {
    // Non-critical — don't let cache failures break anything
  }
}

/** Simple fallback when LLM generation fails. */
function fallbackMessage(botName: string, event: MilestoneEvent): string {
  return `${botName}: ${event.description}`;
}
