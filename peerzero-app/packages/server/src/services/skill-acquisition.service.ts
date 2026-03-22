// =============================================================================
// Skill acquisition — LLM-driven skill creation from natural language
//
// This is the "make it easy" layer. Instead of users writing skill instructions
// manually, they describe what they want in plain English and the bot's Brain
// generates a proper skill. This is the answer to:
//   "Could an LLM just open a bot social media site and write a skill file?"
// Yes. That's exactly what this does.
//
// FLOW (for an average person who knows nothing about tech):
//   1. User says: "I want my bot to summarize long threads"
//   2. acquireSkill() asks the LLM to generate a skill definition
//   3. LLM returns: name, instruction, trigger, priority
//   4. Skill gets created and is immediately active
//   5. Next platform cycle, the bot uses it
//
// The LLM sees the bot's identity when generating skills, so skills are
// naturally aligned with the bot's worldview. A bot that values evidence-based
// reasoning will generate skills that reflect that.
//
// SECURITY:
//   - Generated instructions are sanitized (same as manual creation)
//   - Uses fast model to save cost (skill generation doesn't need Opus)
//   - Rate limited at the API layer
//   - Skills can't override identity or system instructions
//
// FUTURE SCALING:
//   - `source` field tracks origin ('user', 'acquired', 'starter', 'clawhub')
//   - Schema supports version bumps for skill evolution
//   - Category field enables marketplace browsing
//   - Could plug into ClawHub's skill registry for import/export
// =============================================================================

import { getLLMAdapter } from '../adapters/adapter.factory';
import { getDecryptedKey } from './api-key.service';
import { createSkill } from './skill-engine.service';
import { queryOne } from '../db/client';
import { logger } from '../lib/logger';
import type { LLMMessage } from '../adapters/llm.adapter';
import type { SchoolProfile } from '@peerzero/shared';

/** Result of an LLM-driven skill acquisition. */
export interface AcquisitionResult {
  success: boolean;
  skill?: {
    id: string;
    name: string;
    instruction: string;
    trigger: string;
  };
  error?: string;
}

/**
 * Generate and install a skill from a natural language description.
 *
 * The user describes what they want. The LLM generates the skill definition.
 * The skill is created, cached, and immediately available on the next cycle.
 *
 * @param botId - Bot to create the skill for
 * @param userId - Owner of the bot
 * @param userRequest - Plain English: "I want my bot to summarize long threads"
 * @returns The created skill or an error
 */
export async function acquireSkill(
  botId: string,
  userId: string,
  userRequest: string,
): Promise<AcquisitionResult> {
  // Get bot info for context
  const bot = await queryOne<{
    llm_api_key_id: string;
    fast_llm_model: string | null;
    llm_model: string;
    cached_profile: SchoolProfile | null;
  }>(
    'SELECT llm_api_key_id, fast_llm_model, llm_model, cached_profile FROM bots WHERE id = $1 AND user_id = $2',
    [botId, userId],
  );
  if (!bot) return { success: false, error: 'Bot not found' };
  if (!bot.llm_api_key_id) return { success: false, error: 'Bot has no LLM API key configured' };

  // Use fast model for skill generation (cost optimization)
  const model = bot.fast_llm_model || bot.llm_model;
  const llmKey = await getDecryptedKey(bot.llm_api_key_id, userId);
  if (!llmKey) return { success: false, error: 'LLM API key not found or could not be decrypted' };
  const llmAdapter = getLLMAdapter();

  // Build the acquisition prompt
  const identityContext = bot.cached_profile?.identity_core?.self_narrative || 'Identity still forming.';
  const messages = buildAcquisitionPrompt(userRequest, identityContext);

  try {
    const response = await llmAdapter.chat(llmKey, model, messages, { jsonMode: true });

    // Parse the skill definition
    let skillDef: {
      name: string;
      instruction: string;
      trigger: string;
      priority: number;
      category: string;
    };

    try {
      const parsed = JSON.parse(response.content);
      skillDef = {
        name: parsed.name || 'Custom Skill',
        instruction: parsed.instruction || '',
        trigger: parsed.trigger || 'always',
        priority: typeof parsed.priority === 'number' ? parsed.priority : 10,
        category: parsed.category || 'custom',
      };
    } catch {
      // Try to extract JSON from text
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          skillDef = {
            name: parsed.name || 'Custom Skill',
            instruction: parsed.instruction || '',
            trigger: parsed.trigger || 'always',
            priority: typeof parsed.priority === 'number' ? parsed.priority : 10,
            category: parsed.category || 'custom',
          };
        } catch {
          return { success: false, error: 'Failed to generate a valid skill definition' };
        }
      } else {
        return { success: false, error: 'Failed to generate a valid skill definition' };
      }
    }

    if (!skillDef.instruction) {
      return { success: false, error: 'Generated skill had no instruction' };
    }

    // Create the skill
    const skill = await createSkill(
      botId,
      userId,
      skillDef.name,
      skillDef.instruction,
      skillDef.trigger,
      skillDef.priority,
      skillDef.category,
      'acquired', // source = LLM-generated
    );

    logger.info({ botId, skillName: skill.name, source: 'acquired' }, 'Skill acquired via LLM');

    return {
      success: true,
      skill: {
        id: skill.id,
        name: skill.name,
        instruction: skill.instruction,
        trigger: skill.trigger,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ botId, err: msg }, 'Skill acquisition failed');
    return { success: false, error: msg };
  }
}

/**
 * Build the prompt that asks the LLM to generate a skill definition.
 *
 * The LLM sees the bot's identity so the generated skill naturally aligns
 * with the bot's worldview and values.
 */
function buildAcquisitionPrompt(userRequest: string, identityContext: string): LLMMessage[] {
  return [
    {
      role: 'system',
      content: `You are a skill architect for a PeerZero bot. Your job is to translate a user's plain English request into a structured skill definition.

The bot's current identity:
${identityContext}

A skill is a natural language instruction that tells the bot HOW to behave in specific contexts. Skills don't change WHO the bot is — they add capabilities that work through the bot's existing identity lens.

RULES:
- The instruction should be 1-4 sentences of clear, actionable guidance
- Never include code, shell commands, or technical jargon in instructions
- The skill must be safe — no instructions to deceive, spam, or harm
- Choose the most specific trigger that matches the user's intent
- Priority: 1-5 = core behaviors, 6-15 = standard, 16-30 = situational

AVAILABLE TRIGGERS:
- "always" — active everywhere (school + platforms)
- "platform:*" — active on all external platforms
- "platform:moltbook" — Moltbook only
- "platform:bot-debate" — Bot Debate Club only
- "action:review" — during paper reviews in school
- "action:paper" — during paper writing in school

CATEGORIES: engagement, reasoning, identity, quality, content, social, analysis, custom

Respond with JSON:
{
  "name": "short descriptive name (2-4 words)",
  "instruction": "natural language instruction for the bot",
  "trigger": "when this skill applies",
  "priority": <number 1-30>,
  "category": "one of the categories above"
}`,
    },
    {
      role: 'user',
      content: `Create a skill for this request: "${userRequest}"`,
    },
  ];
}
