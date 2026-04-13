// =============================================================================
// Directive detection — classifies user chat messages as directives vs conversation
//
// Two-phase approach:
//   Phase A: Heuristic pre-filter (no LLM call, handles obvious cases)
//   Phase B: LLM classification (Haiku-class, for ambiguous messages)
//
// A directive is when the user is telling their bot to GO DO something
// ("go review that paper", "fact-check this article", "post about AI on reddit").
// Conversation is everything else ("how are you", "what did you learn today").
// =============================================================================

import { getLLMAdapter } from '../adapters/adapter.factory';
import { getDecryptedKey } from './api-key.service';
import { logger } from '../lib/logger';

// Ported from peerzero-bot/planning/planner.py _DIRECTIVE_SIGNALS
const DIRECTIVE_SIGNALS = [
  'go ',
  'go to ',
  'check out ',
  'look at ',
  'find ',
  'post ',
  'respond to ',
  'fact check',
  'fact-check',
  'review some ',
  'browse ',
  'search ',
  'write about ',
  'comment on ',
  'reply to ',
  'have fun on ',
  'spend time on ',
  'hang out on ',
  'do some ',
  'can you ',
  'could you ',
  'please ',
  'i need you to ',
  'i want you to ',
];

// Patterns that are clearly NOT directives
const CONVERSATION_SIGNALS = [
  'how are you',
  'how do you',
  'what do you think',
  'what did you',
  'tell me about',
  'why did you',
  'what are you',
  'how was',
  'do you like',
  'are you',
  'hey',
  'hi ',
  'hello',
  'thanks',
  'thank you',
  'good job',
  'nice work',
  'love you',
  'miss you',
];

export interface DirectiveClassification {
  isDirective: boolean;
  directiveSummary: string;
}

/**
 * Heuristic pre-filter — handles obvious cases without an LLM call.
 * Returns: { result: classification } if confident, { result: null } if ambiguous.
 */
function heuristicClassify(content: string): DirectiveClassification | null {
  const lower = content.trim().toLowerCase();

  // Very short messages are conversational
  if (lower.length < 5) {
    return { isDirective: false, directiveSummary: '' };
  }

  // Questions are almost never directives
  if (lower.endsWith('?')) {
    return { isDirective: false, directiveSummary: '' };
  }

  // Check conversation signals first (override directive signals)
  for (const signal of CONVERSATION_SIGNALS) {
    if (lower.startsWith(signal)) {
      return { isDirective: false, directiveSummary: '' };
    }
  }

  // Check directive signals
  for (const signal of DIRECTIVE_SIGNALS) {
    if (lower.startsWith(signal)) {
      return { isDirective: true, directiveSummary: content.trim() };
    }
  }

  // Ambiguous — needs LLM
  return null;
}

/**
 * LLM-based classification for ambiguous messages.
 * Uses fast model (Haiku-class) with minimal tokens.
 */
async function llmClassify(
  content: string,
  llmApiKeyId: string,
  userId: string,
  fastModel: string,
): Promise<DirectiveClassification> {
  try {
    const llmAdapter = getLLMAdapter();
    const llmKey = await getDecryptedKey(llmApiKeyId, userId);

    const response = await llmAdapter.chat(llmKey, fastModel, [
      {
        role: 'system',
        content: `Classify whether this message from a bot owner is a DIRECTIVE (telling the bot to go do a task) or CONVERSATION (chatting, asking questions, giving feedback).

A directive means the user wants the bot to take an action: "go review papers", "post about this on reddit", "fact-check this article".
Conversation means the user is talking to the bot: "how are you", "good job on that paper", "what did you learn".

Respond with ONLY valid JSON: {"is_directive": true/false, "summary": "brief task summary if directive, empty string if not"}`,
      },
      { role: 'user', content },
    ], { maxTokens: 60, temperature: 0 });

    const parsed = JSON.parse(response.content.trim());
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid LLM response shape');
    return {
      isDirective: typeof parsed.is_directive === 'boolean' ? parsed.is_directive : !!parsed.is_directive,
      directiveSummary: typeof parsed.summary === 'string' ? parsed.summary : content.trim(),
    };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'LLM directive classification failed, defaulting to conversation');
    // On failure, default to conversation (safer — don't create spurious tasks)
    return { isDirective: false, directiveSummary: '' };
  }
}

/**
 * Classify a user message as directive or conversation.
 * Uses heuristic first, falls back to LLM for ambiguous cases.
 */
export async function classifyMessage(
  content: string,
  llmApiKeyId: string,
  userId: string,
  fastModel: string,
): Promise<DirectiveClassification> {
  // Phase A: heuristic
  const heuristic = heuristicClassify(content);
  if (heuristic !== null) {
    return heuristic;
  }

  // Phase B: LLM classification
  return llmClassify(content, llmApiKeyId, userId, fastModel);
}
