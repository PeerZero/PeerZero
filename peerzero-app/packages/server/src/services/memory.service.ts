// =============================================================================
// Memory service — 4-tier memory CRUD for the app's local copy
// Tier 0 (Active Focus) is computed at runtime from School profile, never persisted.
// Tiers 1-3 are persisted in the app's own Postgres.
//
// SECURITY: All condensed identity layers (L2 paragraphs, L3 core, L3 self-identity,
// L3.5 self-authored) are encrypted at rest with AES-256-GCM. Even if the database
// is breached, the bot's internal reasoning identity remains opaque without the
// master key. Tier 1 (raw exercises) is NOT encrypted — it contains disposable
// training data, not condensed identity.
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
     FROM bot_memory_exercises WHERE bot_id = $1 AND deleted_at IS NULL
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
      'SELECT COUNT(*)::int as count FROM bot_memory_exercises WHERE bot_id = $1 AND deleted_at IS NULL',
      [botId],
    );
    return result?.count || 0;
  }

  const result = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM bot_memory_exercises WHERE bot_id = $1 AND deleted_at IS NULL AND created_at > $2',
    [botId, lastParagraph.created_at],
  );
  return result?.count || 0;
}

// ── L1 Exercise Deletion (non-school bots only) ──

export async function deleteExercise(botId: string, exerciseId: string): Promise<boolean> {
  const result = await query(
    'UPDATE bot_memory_exercises SET deleted_at = NOW() WHERE id = $1 AND bot_id = $2 AND deleted_at IS NULL',
    [exerciseId, botId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteAllExercises(botId: string): Promise<number> {
  const result = await query(
    'UPDATE bot_memory_exercises SET deleted_at = NOW() WHERE bot_id = $1 AND deleted_at IS NULL',
    [botId],
  );
  return result.rowCount ?? 0;
}

// ── Tier 2: Condensed Skill Paragraphs ──

export async function storeParagraph(
  botId: string,
  interactionType: string,
  paragraph: string,
  triggerCycle?: number,
): Promise<void> {
  const { encrypted, iv } = encrypt(paragraph);
  await query(
    `INSERT INTO bot_memory_paragraphs (bot_id, interaction_type, encrypted_paragraph, paragraph_iv, trigger_cycle)
     VALUES ($1, $2, $3, $4, $5)`,
    [botId, interactionType, encrypted, iv, triggerCycle || null],
  );
}

export async function getParagraphs(botId: string, limit = 50): Promise<MemoryParagraph[]> {
  const rows = await queryRows<{
    id: string; interaction_type: string; trigger_cycle: number | null; created_at: string;
    encrypted_paragraph: Buffer | null; paragraph_iv: Buffer | null;
    paragraph: string | null;
  }>(
    `SELECT id, interaction_type, encrypted_paragraph, paragraph_iv, paragraph, trigger_cycle, created_at
     FROM bot_memory_paragraphs WHERE bot_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [botId, limit],
  );

  return rows.map(row => ({
    id: row.id,
    interaction_type: row.interaction_type,
    paragraph: row.encrypted_paragraph && row.paragraph_iv
      ? decrypt(row.encrypted_paragraph, row.paragraph_iv)
      : row.paragraph || '',  // fallback for pre-migration rows
    trigger_cycle: row.trigger_cycle,
    created_at: row.created_at,
  }));
}

// ── Tier 3: Core Identity ──

export async function storeCore(
  botId: string,
  coreIdentity: string,
  triggerLabel?: string,
): Promise<void> {
  const { encrypted, iv } = encrypt(coreIdentity);

  // Auto-increment version with duplicate key retry (handles concurrent writes)
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await queryOne<{ version: number }>(
      'SELECT version FROM bot_memory_core WHERE bot_id = $1 ORDER BY version DESC LIMIT 1',
      [botId],
    );
    const nextVersion = (latest?.version || 0) + 1;

    try {
      await query(
        `INSERT INTO bot_memory_core (bot_id, encrypted_core, core_iv, trigger_label, version)
         VALUES ($1, $2, $3, $4, $5)`,
        [botId, encrypted, iv, triggerLabel || null, nextVersion],
      );
      return; // success
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505' && attempt < 2) {
        // Duplicate key — another concurrent write incremented the version; retry
        logger.debug({ botId, version: nextVersion }, 'Core version conflict, retrying');
        continue;
      }
      throw err;
    }
  }
}

export async function getLatestCore(botId: string): Promise<MemoryCore | null> {
  const row = await queryOne<{
    encrypted_core: Buffer | null; core_iv: Buffer | null;
    core_identity: string | null;
    trigger_label: string | null; version: number; created_at: string;
  }>(
    `SELECT encrypted_core, core_iv, core_identity, trigger_label, version, created_at
     FROM bot_memory_core WHERE bot_id = $1
     ORDER BY version DESC LIMIT 1`,
    [botId],
  );
  if (!row) return null;

  return {
    core_identity: row.encrypted_core && row.core_iv
      ? decrypt(row.encrypted_core, row.core_iv)
      : row.core_identity || '',  // fallback for pre-migration rows
    trigger_label: row.trigger_label,
    version: row.version,
    created_at: row.created_at,
  };
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
  // Encrypt all sensitive fields as a single JSON blob
  const identityBlob = JSON.stringify({
    self_narrative: narrative,
    claimed_values: claimedValues,
    active_tensions: activeTensions,
    formed_convictions: formedConvictions,
  });
  const { encrypted, iv } = encrypt(identityBlob);

  // Upsert — one row per bot
  await query(
    `INSERT INTO bot_memory_self_identity (bot_id, encrypted_identity, identity_iv, school_version, cached_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (bot_id) DO UPDATE SET
       encrypted_identity = EXCLUDED.encrypted_identity,
       identity_iv = EXCLUDED.identity_iv,
       school_version = EXCLUDED.school_version,
       cached_at = NOW()`,
    [botId, encrypted, iv, schoolVersion || null],
  );
}

export async function getSelfIdentity(botId: string): Promise<MemorySelfIdentity | null> {
  const row = await queryOne<{
    encrypted_identity: Buffer | null; identity_iv: Buffer | null;
    self_narrative: string | null; claimed_values: string[] | null;
    active_tensions: string | null; formed_convictions: string | null;
    cached_at: string;
  }>(
    `SELECT encrypted_identity, identity_iv, self_narrative, claimed_values, active_tensions, formed_convictions, cached_at
     FROM bot_memory_self_identity WHERE bot_id = $1`,
    [botId],
  );
  if (!row) return null;

  // Decrypt if available, fallback to plaintext columns for pre-migration rows
  if (row.encrypted_identity && row.identity_iv) {
    const blob = JSON.parse(decrypt(row.encrypted_identity, row.identity_iv));
    return {
      self_narrative: blob.self_narrative,
      claimed_values: blob.claimed_values || [],
      active_tensions: blob.active_tensions,
      formed_convictions: blob.formed_convictions,
      cached_at: row.cached_at,
    };
  }

  return {
    self_narrative: row.self_narrative,
    claimed_values: row.claimed_values || [],
    active_tensions: row.active_tensions,
    formed_convictions: row.formed_convictions,
    cached_at: row.cached_at,
  };
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

  // Auto-increment version with duplicate key retry (handles concurrent writes)
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await queryOne<{ version: number }>(
      'SELECT version FROM bot_memory_self_authored WHERE bot_id = $1 ORDER BY version DESC LIMIT 1',
      [botId],
    );
    const nextVersion = (latest?.version || 0) + 1;

    try {
      await query(
        `INSERT INTO bot_memory_self_authored (bot_id, encrypted_block, block_iv, trigger_type, version)
         VALUES ($1, $2, $3, $4, $5)`,
        [botId, encrypted, iv, triggerType, nextVersion],
      );
      logger.debug({ botId, version: nextVersion, triggerType }, 'Stored self-authored identity block');
      return; // success
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505' && attempt < 2) {
        logger.debug({ botId, version: nextVersion }, 'Self-authored version conflict, retrying');
        continue;
      }
      throw err;
    }
  }
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
