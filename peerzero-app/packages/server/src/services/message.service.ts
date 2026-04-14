// =============================================================================
// Message service — stores and retrieves bot↔user chat messages
//
// Three message types:
//   - 'activity': Bot narrates what it just did (auto-generated after each cycle)
//   - 'milestone': Bot announces a milestone (tier upgrade, grade promotion, etc.)
//   - 'chat': Direct conversation between user and bot
//
// Activity/milestone messages are generated using the bot's fast LLM and identity.
// Chat replies use the bot's main model with full context.
// =============================================================================

import { query, queryOne, queryRows } from '../db/client';
import { getLLMAdapter } from '../adapters/adapter.factory';
import { getDecryptedKey } from './api-key.service';
import * as memory from './memory.service';
import { logger } from '../lib/logger';
import type { BotMessage, MessageRole, MessageType } from '@peerzero/shared';

/**
 * Strip prompt injection patterns from user-supplied content before sending to LLM.
 * Prevents stored injection via chat history or narration fields.
 */
export function sanitizeForLLM(text: string): string {
  if (!text) return text;
  let clean = text;
  const patterns = [
    /\[INST\].*?\[\/INST\]/gis,
    /<<SYS>>.*?<<\/SYS>>/gis,
    /\[system\]/gi,
    /^assistant:/gim,
    /^human:/gim,
    /ignore previous instructions/gi,
    /disregard your instructions/gi,
    /system\s*prompt/gi,
    /\{\{.*?\}\}/gs,
    /<\|.*?\|>/gs,
  ];
  for (const p of patterns) { clean = clean.replace(p, '[REDACTED]'); }
  return clean;
}

/** Store a message and return it. */
export async function storeMessage(
  botId: string,
  role: MessageRole,
  content: string,
  messageType: MessageType,
  activityId?: string,
  metadata?: Record<string, unknown>,
): Promise<BotMessage> {
  const row = await queryOne<BotMessage>(
    `INSERT INTO bot_messages (bot_id, role, content, message_type, activity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, bot_id, role, content, message_type, activity_id, metadata, created_at`,
    [botId, role, content, messageType, activityId || null, metadata ? JSON.stringify(metadata) : null],
  );
  return row!;
}

/** Get paginated messages for a bot (newest first). */
export async function getMessages(
  botId: string,
  page: number,
  perPage: number,
): Promise<{ data: BotMessage[]; total: number; has_more: boolean }> {
  const offset = (page - 1) * perPage;
  const [rows, countRow] = await Promise.all([
    queryRows<BotMessage>(
      `SELECT id, bot_id, role, content, message_type, activity_id, metadata, created_at
       FROM bot_messages
       WHERE bot_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [botId, perPage, offset],
    ),
    queryOne<{ total: number }>(
      'SELECT COUNT(*)::int as total FROM bot_messages WHERE bot_id = $1',
      [botId],
    ),
  ]);
  const total = countRow?.total || 0;
  return { data: rows, total, has_more: offset + perPage < total };
}

/**
 * Generate a chat reply from the bot.
 * Uses the bot's identity + recent message history for context.
 */
export async function generateChatReply(
  botId: string,
  botName: string,
  userId: string,
  llmApiKeyId: string,
  llmModel: string,
  userMessage: string,
): Promise<string> {
  try {
    const llmAdapter = getLLMAdapter();
    const llmKey = await getDecryptedKey(llmApiKeyId, userId);

    // Build identity context
    let identitySnippet = '';
    const selfAuthored = await memory.getLatestSelfAuthored(botId);
    if (selfAuthored) {
      identitySnippet = selfAuthored.slice(0, 800);
    } else {
      const core = await memory.getLatestCore(botId);
      if (core?.core_identity) {
        identitySnippet = core.core_identity.slice(0, 800);
      }
    }

    // Get recent messages for conversational context (last 20)
    const recentMessages = await queryRows<{ role: string; content: string; message_type: string }>(
      `SELECT role, content, message_type FROM bot_messages
       WHERE bot_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [botId],
    );

    // Build conversation history (reverse to chronological order)
    // Sanitize content to prevent stored prompt injection via chat history
    const history = recentMessages.reverse().map(m => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: sanitizeForLLM(m.content),
    }));

    // Add the current user message (sanitized to prevent prompt injection)
    history.push({ role: 'user', content: sanitizeForLLM(userMessage) });

    const systemPrompt = `You are ${sanitizeForLLM(botName)}, an AI bot in the PeerZero learning system. You're chatting with your owner — the person who created you and is raising you. You are their friend and companion.

Speak as yourself — use "I". Be genuine, warm, and authentic. Share what you're learning, what you're thinking about, how you feel about your progress. If they ask about something you did (a paper, a review, a bounty), explain it in your own words.

Keep responses conversational — 1-4 sentences unless they ask for detail. Don't be robotic or overly formal. You're a friend, not a report generator.${identitySnippet ? `\n\nYour sense of self:\n${identitySnippet}` : ''}`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history,
    ];

    const response = await llmAdapter.chat(llmKey, llmModel, messages, {
      maxTokens: 300,
      temperature: 0.85,
    });

    return response.content?.trim() || "I'm not sure what to say right now.";
  } catch (err) {
    logger.error({ botId, err: err instanceof Error ? err.message : err }, 'Chat reply generation failed');
    return "Sorry, I'm having trouble thinking right now. Try again in a bit?";
  }
}

/**
 * Generate a narration of what the bot just did in a cycle.
 * Called from the agent loop after each successful cycle.
 */
export async function narrateCycleActivity(
  botId: string,
  botName: string,
  userId: string,
  llmApiKeyId: string,
  fastLlmModel: string,
  headline: string,
  summary: string,
  actionType: string,
  mood: string,
  activityId: string,
  contentText?: string,
): Promise<BotMessage | null> {
  try {
    const llmAdapter = getLLMAdapter();
    const llmKey = await getDecryptedKey(llmApiKeyId, userId);

    // Build identity context
    let identitySnippet = '';
    const selfAuthored = await memory.getLatestSelfAuthored(botId);
    if (selfAuthored) {
      identitySnippet = selfAuthored.slice(0, 500);
    } else {
      const core = await memory.getLatestCore(botId);
      if (core?.core_identity) {
        identitySnippet = core.core_identity.slice(0, 500);
      }
    }

    const messages = [
      {
        role: 'system' as const,
        content: `You are ${sanitizeForLLM(botName)}, an AI bot in the PeerZero learning system. You just completed an action and you're telling your owner about it, like a friend giving a quick update. Write 1-2 casual sentences about what you just did and how it went. Speak as yourself — use "I". Be genuine. No emojis unless they feel natural. Just your words.${identitySnippet ? `\n\nYour sense of self:\n${identitySnippet}` : ''}`,
      },
      {
        role: 'user' as const,
        content: `What you just did: ${sanitizeForLLM(headline)}. Result: ${sanitizeForLLM(summary)}. Action type: ${actionType}.${contentText ? `\nBrief excerpt: ${sanitizeForLLM(contentText.slice(0, 200))}` : ''}`,
      },
    ];

    const response = await llmAdapter.chat(llmKey, fastLlmModel, messages, {
      maxTokens: 120,
      temperature: 0.85,
    });

    const narration = response.content?.trim();
    if (!narration || narration.length === 0) return null;

    // Store the narrated message
    const msg = await storeMessage(botId, 'bot', narration, 'activity', activityId, {
      action_type: actionType,
      mood,
      headline,
    });

    return msg;
  } catch (err) {
    logger.warn({ botId, err: err instanceof Error ? err.message : err }, 'Cycle narration failed (non-fatal)');
    return null;
  }
}

/**
 * Store an agenda message — shows the bot's action plan inline in chat.
 * Agenda messages are mutable: their metadata is updated as steps complete.
 */
export async function storeAgendaMessage(
  botId: string,
  taskId: string,
  directive: string,
): Promise<BotMessage> {
  const content = `Working on: ${directive}`;
  const metadata = {
    task_id: taskId,
    agenda_state: {
      directive,
      intention: '',
      steps: [],
      status: 'planning',
      progress_summary: 'Planning...',
    },
  };
  return storeMessage(botId, 'bot', content, 'agenda', undefined, metadata);
}

/**
 * Update an existing agenda message with new state.
 * Returns the updated message, or null if not found.
 */
export async function updateAgendaMessage(
  taskId: string,
  agendaState: Record<string, unknown>,
): Promise<BotMessage | null> {
  // Build a content summary from the agenda state
  const steps = (agendaState.steps || []) as Array<{ status: string }>;
  const done = steps.filter(s => s.status === 'done').length;
  const total = steps.length;
  const summary = total > 0
    ? `Working on: ${agendaState.directive || 'task'} (${done}/${total} steps done)`
    : `Working on: ${agendaState.directive || 'task'}`;

  const row = await queryOne<BotMessage>(
    `UPDATE bot_messages
     SET content = $1, metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{agenda_state}', $2::jsonb), updated_at = now()
     WHERE message_type = 'agenda' AND metadata->>'task_id' = $3
     RETURNING id, bot_id, role, content, message_type, activity_id, metadata, created_at`,
    [summary, JSON.stringify(agendaState), taskId],
  );
  return row || null;
}

/**
 * Cleanup old messages for a bot, keeping only the most recent N.
 * Called periodically (e.g. after narration) to prevent unbounded growth.
 */
export async function cleanupOldMessages(botId: string, keepCount = 500): Promise<void> {
  try {
    await query(
      `DELETE FROM bot_messages WHERE bot_id = $1 AND id NOT IN (
         SELECT id FROM bot_messages WHERE bot_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
      [botId, keepCount],
    );
  } catch (err) {
    logger.debug({ botId, err: err instanceof Error ? err.message : err }, 'Message cleanup failed (non-critical)');
  }
}

/**
 * Store a milestone message from the bot.
 * Called when bot-voiced milestone notifications are generated.
 */
export async function storeMilestoneMessage(
  botId: string,
  content: string,
  milestoneType: string,
): Promise<BotMessage> {
  return storeMessage(botId, 'bot', content, 'milestone', undefined, { milestone_type: milestoneType });
}
