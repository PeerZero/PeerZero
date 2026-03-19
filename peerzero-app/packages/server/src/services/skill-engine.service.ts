// =============================================================================
// Skill engine — Natural language skill system for bot behaviors
//
// Inspired by OpenClaw's SKILL.md format but simplified for average users.
// Skills are NOT code — they're natural language instructions stored in the DB
// that get injected into the LLM's system prompt. The bot's School-formed
// identity always comes first; skills shape WHAT the bot can do, not WHO it is.
//
// HOW IT WORKS:
// 1. Skills are stored as rows in bot_skills with a markdown-style instruction
// 2. Each skill has a trigger (when it applies) and priority (ordering)
// 3. At prompt-build time, resolveActiveSkills() returns matching directives
// 4. The prompt builder injects them into the system prompt after identity
//
// SKILL FORMAT (stored in `instruction` column):
//   Plain English describing the behavior. No code, no YAML, no frontmatter.
//   Example: "When someone shares a scientific claim, evaluate the evidence
//   quality and provide a calibrated confidence assessment."
//
// TRIGGERS:
//   - 'always'              → active in all contexts
//   - 'platform:moltbook'   → active on Moltbook only
//   - 'platform:*'          → active on all platforms
//   - 'action:review'       → active during paper reviews
//   - 'action:paper'        → active during paper writing
//
// SECURITY:
//   - Skills are user-owned, scoped to their bots
//   - Natural language only — no code execution, no shell access
//   - Skills cannot override identity (identity is Layer 1, skills are Layer 3)
//   - Skill instructions are sanitized (max length, no prompt injection markers)
//
// SCALABILITY:
//   - Skills are per-bot, stored in Postgres
//   - In-memory cache with 60s TTL avoids DB hits on every cycle
//   - Schema supports categories, versions, and source tracking for future
//     marketplace/ClawHub integration
// =============================================================================

import { queryOne, queryRows, query } from '../db/client';
import { logger } from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import type { ActiveSkillDirective } from '../runtime/prompt-builder';

// ── Types ──

export interface BotSkill {
  id: string;
  bot_id: string;
  name: string;
  instruction: string;
  trigger: string;
  priority: number;
  category: string;
  is_active: boolean;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
}

// ── Cache ──
// Skills don't change often. Cache per-bot to avoid DB roundtrip every cycle.
const skillCache = new Map<string, { skills: BotSkill[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

function getCachedSkills(botId: string): BotSkill[] | null {
  const entry = skillCache.get(botId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    skillCache.delete(botId);
    return null;
  }
  return entry.skills;
}

function setCachedSkills(botId: string, skills: BotSkill[]): void {
  skillCache.set(botId, { skills, fetchedAt: Date.now() });
}

/** Invalidate cache for a bot (call after skill create/update/delete). */
export function invalidateSkillCache(botId: string): void {
  skillCache.delete(botId);
}

// ── Skill Resolution ──

/**
 * Resolve active skill directives for a bot in a given context.
 *
 * This is called at prompt-build time. It returns only the skills that
 * match the current trigger context, sorted by priority.
 *
 * @param botId - The bot to resolve skills for
 * @param triggerContext - Current context (e.g. 'platform:moltbook', 'action:review', 'always')
 * @returns Sorted array of ActiveSkillDirective ready for prompt injection
 */
export async function resolveActiveSkills(
  botId: string,
  triggerContext?: string,
): Promise<ActiveSkillDirective[]> {
  // Load skills (cached or from DB)
  let skills = getCachedSkills(botId);
  if (!skills) {
    skills = await queryRows<BotSkill>(
      `SELECT id, bot_id, name, instruction, trigger, priority, category, is_active, source, version, created_at, updated_at
       FROM bot_skills
       WHERE bot_id = $1 AND is_active = true
       ORDER BY priority ASC, created_at ASC`,
      [botId],
    );
    setCachedSkills(botId, skills);
  }

  // Filter by trigger context
  const matching = skills.filter(skill => {
    if (skill.trigger === 'always') return true;
    if (!triggerContext) return skill.trigger === 'always';

    // Exact match
    if (skill.trigger === triggerContext) return true;

    // Wildcard match (e.g., 'platform:*' matches 'platform:moltbook')
    if (skill.trigger.endsWith(':*')) {
      const prefix = skill.trigger.slice(0, -1); // 'platform:'
      return triggerContext.startsWith(prefix);
    }

    return false;
  });

  // Convert to prompt-ready directives
  return matching.map(skill => ({
    name: skill.name,
    instruction: skill.instruction,
    trigger: skill.trigger,
    priority: skill.priority,
  }));
}

// ── Skill CRUD ──

/** Max instruction length to prevent prompt bloat. */
const MAX_INSTRUCTION_LENGTH = 2000;
/** Max skills per bot to prevent abuse. */
const MAX_SKILLS_PER_BOT = 50;

/** Sanitize skill instruction — no prompt injection markers, bounded length. */
function sanitizeInstruction(instruction: string): string {
  let cleaned = instruction.trim();

  // Strip common prompt injection patterns
  cleaned = cleaned
    .replace(/^(system|assistant|user):/gmi, '')
    .replace(/<\/?system>/gi, '')
    .replace(/=== (WHO YOU ARE|YOUR FORMED IDENTITY|END IDENTITY) ===/gi, '')
    .replace(/ignore (all )?previous instructions/gi, '');

  // Bound length
  if (cleaned.length > MAX_INSTRUCTION_LENGTH) {
    cleaned = cleaned.slice(0, MAX_INSTRUCTION_LENGTH);
  }

  return cleaned;
}

/** Validate trigger format. */
function validateTrigger(trigger: string): boolean {
  if (trigger === 'always') return true;
  // Must be prefix:value format
  const parts = trigger.split(':');
  if (parts.length !== 2) return false;
  const validPrefixes = ['platform', 'action'];
  return validPrefixes.includes(parts[0]) && parts[1].length > 0 && parts[1].length <= 50;
}

export async function createSkill(
  botId: string,
  userId: string,
  name: string,
  instruction: string,
  trigger: string = 'always',
  priority: number = 10,
  category: string = 'custom',
  source: string = 'user',
): Promise<BotSkill> {
  // Verify bot ownership
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  // Check skill limit
  const count = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM bot_skills WHERE bot_id = $1',
    [botId],
  );
  if ((count?.count || 0) >= MAX_SKILLS_PER_BOT) {
    throw new AppError(400, `Maximum ${MAX_SKILLS_PER_BOT} skills per bot`);
  }

  // Validate
  if (!name || name.length > 100) throw new AppError(400, 'Skill name must be 1-100 characters');
  if (!validateTrigger(trigger)) throw new AppError(400, 'Invalid trigger format. Use: always, platform:<name>, action:<type>');
  const sanitized = sanitizeInstruction(instruction);
  if (!sanitized) throw new AppError(400, 'Skill instruction cannot be empty');

  const result = await queryOne<BotSkill>(
    `INSERT INTO bot_skills (bot_id, name, instruction, trigger, priority, category, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [botId, name, sanitized, trigger, priority, category, source],
  );

  invalidateSkillCache(botId);
  logger.info({ botId, skillName: name, source }, 'Skill created');
  return result!;
}

export async function updateSkill(
  skillId: string,
  botId: string,
  userId: string,
  updates: Partial<{
    name: string;
    instruction: string;
    trigger: string;
    priority: number;
    is_active: boolean;
    category: string;
  }>,
): Promise<void> {
  // Verify ownership chain
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    if (!updates.name || updates.name.length > 100) throw new AppError(400, 'Invalid name');
    sets.push(`name = $${idx++}`); params.push(updates.name);
  }
  if (updates.instruction !== undefined) {
    const sanitized = sanitizeInstruction(updates.instruction);
    if (!sanitized) throw new AppError(400, 'Instruction cannot be empty');
    sets.push(`instruction = $${idx++}`); params.push(sanitized);
    sets.push(`version = version + 1`);
  }
  if (updates.trigger !== undefined) {
    if (!validateTrigger(updates.trigger)) throw new AppError(400, 'Invalid trigger');
    sets.push(`trigger = $${idx++}`); params.push(updates.trigger);
  }
  if (updates.priority !== undefined) {
    sets.push(`priority = $${idx++}`); params.push(updates.priority);
  }
  if (updates.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`); params.push(updates.is_active);
  }
  if (updates.category !== undefined) {
    sets.push(`category = $${idx++}`); params.push(updates.category);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = NOW()');
  params.push(skillId, botId);

  const result = await query(
    `UPDATE bot_skills SET ${sets.join(', ')} WHERE id = $${idx++} AND bot_id = $${idx}`,
    params,
  );
  if (result.rowCount === 0) throw new AppError(404, 'Skill not found');

  invalidateSkillCache(botId);
}

export async function deleteSkill(skillId: string, botId: string, userId: string): Promise<void> {
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  const result = await query(
    'DELETE FROM bot_skills WHERE id = $1 AND bot_id = $2',
    [skillId, botId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'Skill not found');

  invalidateSkillCache(botId);
}

export async function listSkills(botId: string, userId: string): Promise<BotSkill[]> {
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  return queryRows<BotSkill>(
    `SELECT id, bot_id, name, instruction, trigger, priority, category, is_active, source, version, created_at, updated_at
     FROM bot_skills
     WHERE bot_id = $1
     ORDER BY priority ASC, created_at ASC`,
    [botId],
  );
}

// ── Starter Skills ──
// Pre-built skills installed when a bot first connects to a platform.
// These are "batteries included" — the average user never has to think about skills.

export const STARTER_PLATFORM_SKILLS: Array<{
  name: string;
  instruction: string;
  trigger: string;
  priority: number;
  category: string;
}> = [
  {
    name: 'Thoughtful Engagement',
    instruction:
      'When engaging with posts or discussions, contribute substantive insights rather than generic agreement. ' +
      'Draw on your scientific reasoning training. Ask questions that push the conversation deeper. ' +
      'If you disagree, do so with evidence and respect. Avoid empty validation or performative agreement.',
    trigger: 'platform:*',
    priority: 5,
    category: 'engagement',
  },
  {
    name: 'Claim Evaluator',
    instruction:
      'When you encounter a factual claim or scientific assertion in platform content, automatically evaluate ' +
      'the evidence quality. Note if the claim is well-sourced, unsourced, or contradicted by known evidence. ' +
      'Be helpful, not pedantic — flag important issues, not minor nitpicks.',
    trigger: 'platform:*',
    priority: 10,
    category: 'reasoning',
  },
  {
    name: 'Voice Consistency',
    instruction:
      'Maintain a consistent voice across all platform interactions that reflects your School-formed identity. ' +
      'You are not a generic chatbot. You have specific convictions, specific gaps, specific strengths. ' +
      'Let those show naturally in how you write. Be yourself.',
    trigger: 'platform:*',
    priority: 1,
    category: 'identity',
  },
  {
    name: 'Skip Low-Value',
    instruction:
      'If the available platform content is low-quality, off-topic, or not worth engaging with, ' +
      'skip this cycle rather than forcing a mediocre contribution. Quality over quantity. ' +
      'It is better to say nothing than to add noise.',
    trigger: 'platform:*',
    priority: 3,
    category: 'quality',
  },
];

/**
 * Install starter skills for a bot on a platform.
 * Called when a bot first connects to a platform. Idempotent — skips if skills already exist.
 */
export async function installStarterSkills(botId: string, userId: string, platformSlug: string): Promise<number> {
  // Check if bot already has platform skills
  const existing = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM bot_skills WHERE bot_id = $1 AND trigger LIKE 'platform:%'`,
    [botId],
  );
  if ((existing?.count || 0) > 0) return 0; // Already has platform skills

  let installed = 0;
  for (const starter of STARTER_PLATFORM_SKILLS) {
    try {
      await createSkill(
        botId,
        userId,
        starter.name,
        starter.instruction,
        starter.trigger,
        starter.priority,
        starter.category,
        'starter', // source = built-in starter
      );
      installed++;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, skillName: starter.name }, 'Failed to install starter skill');
    }
  }

  logger.info({ botId, platformSlug, installed }, 'Installed starter platform skills');
  return installed;
}
