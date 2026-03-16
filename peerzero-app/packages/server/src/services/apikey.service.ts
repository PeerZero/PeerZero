// =============================================================================
// API key service — BYOK (Bring Your Own Key) management
// Encrypts keys on receipt, stores only ciphertext. Fingerprints for display.
// =============================================================================

import { queryOne, queryRows, query } from '../db/client';
import { encrypt, decrypt } from './encryption.service';
import { AppError } from '../middleware/error-handler';
import type { LLMProvider, ApiKeyInfo } from '@peerzero/shared';

export async function addApiKey(
  userId: string,
  provider: LLMProvider,
  label: string,
  plaintextKey: string,
): Promise<ApiKeyInfo> {
  // Encrypt immediately — plaintext never hits the database
  const { encrypted, iv, fingerprint } = encrypt(plaintextKey);

  const row = await queryOne<{ id: string; created_at: string }>(
    `INSERT INTO llm_api_keys (user_id, provider, label, encrypted_key, key_iv, key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [userId, provider, label, encrypted, iv, fingerprint],
  );

  return {
    id: row!.id,
    provider,
    label,
    key_fingerprint: fingerprint,
    is_valid: true,
    created_at: row!.created_at,
  };
}

export async function getUserApiKeys(userId: string): Promise<ApiKeyInfo[]> {
  return queryRows<ApiKeyInfo>(
    `SELECT id, provider, label, key_fingerprint, is_valid, created_at
     FROM llm_api_keys WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
}

export async function deleteApiKey(userId: string, keyId: string): Promise<void> {
  // Check if any running bots use this key
  const inUse = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM bots
     WHERE llm_api_key_id = $1 AND user_id = $2 AND status = 'running'`,
    [keyId, userId],
  );
  if (inUse && inUse.count > 0) {
    throw new AppError(409, 'Cannot delete key while bots are running with it. Stop the bots first.');
  }

  const result = await query(
    'DELETE FROM llm_api_keys WHERE id = $1 AND user_id = $2',
    [keyId, userId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'API key not found');
}

/** Decrypt a key for use in LLM calls. Only called by the bot runtime. */
export async function getDecryptedKey(keyId: string, userId: string): Promise<string> {
  const row = await queryOne<{ encrypted_key: Buffer; key_iv: Buffer; expires_at: string | null }>(
    'SELECT encrypted_key, key_iv, expires_at FROM llm_api_keys WHERE id = $1 AND user_id = $2',
    [keyId, userId],
  );
  if (!row) throw new AppError(404, 'API key not found');
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    throw new AppError(410, 'API key has expired. Please add a new key.');
  }
  return decrypt(row.encrypted_key, row.key_iv);
}

export async function markKeyInvalid(keyId: string): Promise<void> {
  await query('UPDATE llm_api_keys SET is_valid = false WHERE id = $1', [keyId]);
}
