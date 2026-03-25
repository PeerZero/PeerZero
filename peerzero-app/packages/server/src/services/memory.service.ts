// =============================================================================
// Memory service — 4-tier memory CRUD for the app's local copy
// Tier 0 (Active Focus) is computed at runtime from School profile, never persisted.
// Tiers 1-3 are persisted in the app's own Postgres.
// =============================================================================

import { queryOne, queryRows, query } from '../db/client';
import { encrypt, decrypt } from './encryption.service';
import { logger } from '../lib/logger';
import type {
  MemorySnapshot,
  FocusChunk,
  MemoryExercise,
  MemoryParagraph,
  MemoryCore,
  MemorySelfIdentity,
} from '@peerzero/shared';

// ── Tier 0: Active Focus (computed, not stored) ──

/** Build Tier 0 from whatever the School's profile returned. */
export function buildLocalFocus(schoolFocus: { focus_chunks: FocusChunk[] } | null): FocusChunk[] {
  if (!schoolFocus) return [];
  return schoolFocus.focus_chunks.slice(0, 4);
}

// ── Tier 1: Raw Exercises ──

export async function storeExercise(
  botId: string,
  cycleNumber: number,
  actionType: string,
  exerciseData: Record<string, unknown>,
  schoolResponse?: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO bot_memory_exercises (bot_id, cycle_number, action_type, exercise_data, school_response)
     VALUES ($1, $2, $3, $4, $5)`,
    [botId, cycleNumber, actionType, JSON.stringify(exerciseData), schoolResponse ? JSON.stringify(schoolResponse) : null],
  );
}

export async function getRecentExercises(botId: string, limit = 20): Promise<MemoryExercise[]> {
  return queryRows<MemoryExercise>(
    `SELECT id, cycle_number, action_type, exercise_data, created_at
     FROM bot_memory_exercises WHERE bot_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [botId, limit],
  );
}

export async function getUncondensedExerciseCount(botId: string): Promise<number> {
  // Exercises created after the most recent paragraph
  const lastParagraph = await queryOne<{ created_at: string }>(
    'SELECT created_at FROM bot_memory_paragraphs WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 1',
    [botId],
  );

  if (!lastParagraph) {
    const result = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM bot_memory_exercises WHERE bot_id = $1',
      [botId],
    );
    return result?.count || 0;
  }

  const result = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM bot_memory_exercises WHERE bot_id = $1 AND created_at > $2',
    [botId, lastParagraph.created_at],
  );
  return result?.count || 0;
}

// ── Tier 2: Condensed Skill Paragraphs ──

export async function storeParagraph(
  botId: string,
  interactionType: string,
  paragraph: string,
  triggerCycle?: number,
): Promise<void> {
  await query(
    `INSERT INTO bot_memory_paragraphs (bot_id, interaction_type, paragraph, trigger_cycle)
     VALUES ($1, $2, $3, $4)`,
    [botId, interactionType, paragraph, triggerCycle || null],
  );
}

export async function getParagraphs(botId: string, limit = 50): Promise<MemoryParagraph[]> {
  return queryRows<MemoryParagraph>(
    `SELECT id, interaction_type, paragraph, trigger_cycle, created_at
     FROM bot_memory_paragraphs WHERE bot_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [botId, limit],
  );
}

// ── Tier 3: Core Identity ──

export async function storeCore(
  botId: string,
  coreIdentity: string,
  triggerLabel?: string,
): Promise<void> {
  // Auto-increment version
  const latest = await queryOne<{ version: number }>(
    'SELECT version FROM bot_memory_core WHERE bot_id = $1 ORDER BY version DESC LIMIT 1',
    [botId],
  );
  const nextVersion = (latest?.version || 0) + 1;

  await query(
    `INSERT INTO bot_memory_core (bot_id, core_identity, trigger_label, version)
     VALUES ($1, $2, $3, $4)`,
    [botId, coreIdentity, triggerLabel || null, nextVersion],
  );
}

export async function getLatestCore(botId: string): Promise<MemoryCore | null> {
  return queryOne<MemoryCore>(
    `SELECT core_identity, trigger_label, version, created_at
     FROM bot_memory_core WHERE bot_id = $1
     ORDER BY version DESC LIMIT 1`,
    [botId],
  );
}

// ── Self-Identity (cached from School) ──

export async function storeSelfIdentity(
  botId: string,
  narrative: string | null,
  claimedValues: string[],
  activeTensions: string | null,
  formedConvictions: string | null,
  schoolVersion?: number,
): Promise<void> {
  // Upsert — one row per bot
  await query(
    `INSERT INTO bot_memory_self_identity (bot_id, self_narrative, claimed_values, active_tensions, formed_convictions, school_version, cached_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (bot_id) DO UPDATE SET
       self_narrative = EXCLUDED.self_narrative,
       claimed_values = EXCLUDED.claimed_values,
       active_tensions = EXCLUDED.active_tensions,
       formed_convictions = EXCLUDED.formed_convictions,
       school_version = EXCLUDED.school_version,
       cached_at = NOW()`,
    [botId, narrative, claimedValues, activeTensions, formedConvictions, schoolVersion || null],
  );
}

export async function getSelfIdentity(botId: string): Promise<MemorySelfIdentity | null> {
  return queryOne<MemorySelfIdentity>(
    `SELECT self_narrative, claimed_values, active_tensions, formed_convictions, cached_at
     FROM bot_memory_self_identity WHERE bot_id = $1`,
    [botId],
  );
}

// ── Self-Authored Identity (encrypted, LLM-only) ──

/**
 * Store a self-authored identity block, encrypted at rest.
 * The LLM writes this for itself — nobody else needs to see it.
 */
export async function storeSelfAuthored(
  botId: string,
  plaintextBlock: string,
  triggerType: string,
): Promise<void> {
  const { encrypted, iv } = encrypt(plaintextBlock);

  // Auto-increment version
  const latest = await queryOne<{ version: number }>(
    'SELECT version FROM bot_memory_self_authored WHERE bot_id = $1 ORDER BY version DESC LIMIT 1',
    [botId],
  );
  const nextVersion = (latest?.version || 0) + 1;

  await query(
    `INSERT INTO bot_memory_self_authored (bot_id, encrypted_block, block_iv, trigger_type, version)
     VALUES ($1, $2, $3, $4, $5)`,
    [botId, encrypted, iv, triggerType, nextVersion],
  );
  logger.debug({ botId, version: nextVersion, triggerType }, 'Stored self-authored identity block');
}

/**
 * Retrieve and decrypt the latest self-authored identity block.
 * Returns null if none exists yet (bot hasn't been through condensation).
 */
export async function getLatestSelfAuthored(botId: string): Promise<string | null> {
  const row = await queryOne<{ encrypted_block: Buffer; block_iv: Buffer }>(
    `SELECT encrypted_block, block_iv FROM bot_memory_self_authored
     WHERE bot_id = $1 ORDER BY version DESC LIMIT 1`,
    [botId],
  );
  if (!row) return null;

  try {
    return decrypt(row.encrypted_block, row.block_iv);
  } catch (err) {
    logger.error({ botId, err: err instanceof Error ? err.message : err }, 'Failed to decrypt self-authored identity block');
    return null;
  }
}

// ── Full Snapshot (for the Brain view) ──
// Condensed layers (L2+) are REDACTED — users see metadata (count, type, date)
// but NOT the raw identity text. The condensed identity is the bot's internal
// reasoning substrate and must not be exposed to anyone.

export async function getMemorySnapshot(botId: string, schoolFocus: { focus_chunks: FocusChunk[] } | null): Promise<MemorySnapshot> {
  const [exercises, paragraphs, core, selfIdentity] = await Promise.all([
    getRecentExercises(botId),
    getParagraphs(botId),
    getLatestCore(botId),
    getSelfIdentity(botId),
  ]);

  return {
    tier0_focus: buildLocalFocus(schoolFocus),
    tier1_exercises: exercises,
    // Redact paragraph text — show metadata only
    tier2_paragraphs: paragraphs.map(p => ({
      ...p,
      paragraph: '[condensed — internal only]',
    })),
    // Redact core identity text
    tier3_core: core ? {
      ...core,
      core_identity: '[condensed — internal only]',
    } : null,
    // Redact self-identity text
    tier3_self_identity: selfIdentity ? {
      ...selfIdentity,
      self_narrative: selfIdentity.self_narrative ? '[condensed — internal only]' : null,
      claimed_values: [],
      active_tensions: selfIdentity.active_tensions ? '[condensed — internal only]' : null,
      formed_convictions: selfIdentity.formed_convictions ? '[condensed — internal only]' : null,
    } : null,
  };
}
