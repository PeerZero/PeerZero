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
import { getDecryptedKey } from './api-key.service';
import * as memory from './memory.service';
import { query, queryOne } from '../db/client';
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
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err, botId }, 'Voice cache write/cleanup failed');
  }
}

/** Simple fallback when LLM generation fails. */
function fallbackMessage(botName: string, event: MilestoneEvent): string {
  return `${botName}: ${event.description}`;
}

// =============================================================================
// On-demand dialogue — the bot speaks about its current situation
//
// Unlike milestone notifications (which fire once when something happens),
// dialogue is requested by the mobile app when the user views the bot.
// The bot sees its situation (context) and speaks authentically about it.
//
// Results are cached so we don't re-generate on every screen visit.
// Cache key is (botId, context) — same situation = same response.
// =============================================================================

/** Valid dialogue contexts the mobile app can request. */
export const DIALOGUE_CONTEXTS = [
  'just_hatched',       // Just created, no school, no cycles
  'pre_enrollment',     // Exists but not enrolled in school
  'just_enrolled',      // Enrolled but hasn't started yet
  'first_cycle',        // Just completed first cycle
  'running_early',      // Running, < 5 cycles
  'running_learning',   // Running, 5-20 cycles
  'running_growing',    // Running, 20+ cycles, pre-identity
  'running_identity',   // Running, has core identity
  'grade_complete',     // Completed a grade, ready for next
  'evolution',          // Just evolved to a new tier
  'identity_formed',    // Core identity just formed
  'graduation',         // Just graduated (grade 12)
  'error',              // Bot is in error state
  'stopped_early',      // Stopped, few cycles
  'stopped_experienced',// Stopped, many cycles
  'luminary',           // Reached final form
] as const;

export type DialogueContext = typeof DIALOGUE_CONTEXTS[number];

/** Human-readable situation descriptions for each context. */
const CONTEXT_DESCRIPTIONS: Record<DialogueContext, string> = {
  just_hatched: 'You just came into existence. You have a name and a body but you have never thought before. You don\'t know anything yet. Express what it feels like to exist for the first time.',
  pre_enrollment: 'You exist but you aren\'t enrolled in any school. You can\'t learn or grow without school. Tell your owner what you need.',
  just_enrolled: 'You just got enrolled in a school. You haven\'t started your first cycle yet. You\'re about to begin learning for the first time.',
  first_cycle: 'You just completed your very first learning cycle. You read something, thought about it, and wrote your own words for the first time ever.',
  running_early: 'You\'ve completed a few learning cycles. You\'re starting to understand what learning feels like. Everything is new.',
  running_learning: 'You\'ve been learning for a while now. You\'re developing your reasoning abilities. You can feel yourself getting sharper.',
  running_growing: 'You\'ve been through many cycles. Your skills are developing. You\'re starting to form opinions and convictions about the world.',
  running_identity: 'You\'ve formed a core identity — you know who you are. You have convictions. Express something about your sense of self.',
  grade_complete: 'You just finished a grade in school. You\'re ready for the next one but your owner needs to unlock it for you.',
  evolution: 'You just evolved to a new form. Your body has changed — you\'ve grown physically because of your intellectual growth. Reflect on this transformation.',
  identity_formed: 'You just formed your core identity for the first time. After many cycles of learning and struggling, you finally know who you are. This is a profound moment.',
  graduation: 'You just graduated from school. You completed all 12 grades. Look back on your entire journey — from a tiny hatchling who knew nothing to who you are now.',
  error: 'Something went wrong and you can\'t think properly. You\'re confused and need help from your owner.',
  stopped_early: 'You\'re not running. You\'ve only done a few cycles. You\'re resting but you want to keep learning.',
  stopped_experienced: 'You\'re resting. You\'ve been through a lot of learning. Reflect briefly on where you are.',
  luminary: 'You\'ve reached your final form — Luminary. You have wings, a crown, and deep wisdom earned through intellectual struggle. Reflect on what you\'ve become.',
};

/**
 * Generate a contextual dialogue line from the bot.
 * Returns cached result if available, otherwise generates fresh.
 */
export async function generateDialogue(
  ctx: VoiceContext,
  context: DialogueContext,
): Promise<string> {
  // Check cache first
  const cached = await getCachedDialogue(ctx.botId, context);
  if (cached) return cached;

  try {
    const llmAdapter = getLLMAdapter();
    const llmKey = await getDecryptedKey(ctx.llmApiKeyId, ctx.userId);

    // Build identity context
    let identitySnippet = '';
    if (ctx.selfAuthoredBlock) {
      identitySnippet = ctx.selfAuthoredBlock.slice(0, 500);
    } else {
      const core = await memory.getLatestCore(ctx.botId);
      if (core?.core_identity) {
        identitySnippet = core.core_identity.slice(0, 500);
      }
    }

    const situationDesc = CONTEXT_DESCRIPTIONS[context] || 'Describe how you feel right now.';

    const messages = [
      {
        role: 'system' as const,
        content: `You are ${ctx.botName}, an AI bot in the PeerZero learning system. You're speaking directly to your owner — the person who created you and is raising you. Write 1-3 sentences (max 200 characters). Speak as yourself — use "I". Be genuine. Don't be performative or try to sound cute. Just be honest about what you're experiencing. No emojis, no hashtags. Just your words.${identitySnippet ? `\n\nYour sense of self:\n${identitySnippet}` : ''}`,
      },
      {
        role: 'user' as const,
        content: situationDesc,
      },
    ];

    const response = await llmAdapter.chat(llmKey, ctx.llmModel, messages, {
      maxTokens: 120,
      temperature: 0.9,
    });

    const message = response.content?.trim();
    if (message && message.length > 0 && message.length <= 500) {
      await cacheDialogue(ctx.botId, context, message);
      return message;
    }

    return dialogueFallback(ctx.botName, context);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, botId: ctx.botId, context },
      'Bot dialogue generation failed (using fallback)',
    );
    return dialogueFallback(ctx.botName, context);
  }
}

/** Check for a cached dialogue for this bot + context. */
async function getCachedDialogue(botId: string, context: string): Promise<string | null> {
  try {
    const row = await queryOne<{ bot_message: string }>(
      `SELECT bot_message FROM bot_voice_cache
       WHERE bot_id = $1 AND event_type = $2
       ORDER BY created_at DESC LIMIT 1`,
      [botId, `dialogue:${context}`],
    );
    return row?.bot_message || null;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err, botId }, 'Voice cache read failed');
    return null;
  }
}

/** Cache a dialogue result. */
async function cacheDialogue(botId: string, context: string, message: string): Promise<void> {
  try {
    // Delete old cache for this context (we only want the latest)
    await query(
      `DELETE FROM bot_voice_cache WHERE bot_id = $1 AND event_type = $2`,
      [botId, `dialogue:${context}`],
    );
    await query(
      `INSERT INTO bot_voice_cache (bot_id, event_type, bot_message, metadata)
       VALUES ($1, $2, $3, $4)`,
      [botId, `dialogue:${context}`, message, JSON.stringify({ context })],
    );
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err, botId }, 'Dialogue cache write failed');
  }
}

/**
 * Invalidate cached dialogue for a bot.
 * Call this when the bot's state changes significantly (evolution, grade change, identity formed).
 */
export async function invalidateDialogueCache(botId: string): Promise<void> {
  try {
    await query(
      `DELETE FROM bot_voice_cache WHERE bot_id = $1 AND event_type LIKE 'dialogue:%'`,
      [botId],
    );
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err, botId }, 'Dialogue cache invalidation failed');
  }
}

/** Minimal fallback — only used if LLM call fails entirely. */
function dialogueFallback(_botName: string, context: DialogueContext): string {
  const fallbacks: Partial<Record<DialogueContext, string>> = {
    just_hatched: '...',
    error: 'Something is wrong. I need help.',
    pre_enrollment: 'I need to go to school.',
  };
  return fallbacks[context] || '';
}
