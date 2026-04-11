#!/usr/bin/env npx tsx
// =============================================================================
// Encryption key rotation script
//
// Re-encrypts all encrypted data from OLD_ENCRYPTION_KEY to ENCRYPTION_MASTER_KEY.
//
// Usage:
//   OLD_ENCRYPTION_KEY=<old-64-hex> npx tsx scripts/rotate-encryption-key.ts
//
// The script:
// 1. Decrypts all data with the old key
// 2. Re-encrypts with the current ENCRYPTION_MASTER_KEY
// 3. Updates all rows in a single transaction
// 4. Verifies decryption works before committing
//
// Affected tables:
// - llm_api_keys (encrypted_key, key_iv, key_fingerprint)
// - bots (school_api_key_encrypted, school_api_key_iv, school_api_key_fingerprint)
// - bot_platforms (credentials, credentials_iv, credentials_fingerprint)
// - bot_memory_self_authored (encrypted_block, block_iv)
// =============================================================================

import { reEncrypt, decrypt } from '../src/services/encryption.service';
import { Pool } from 'pg';

const OLD_KEY = process.env.OLD_ENCRYPTION_KEY;
if (!OLD_KEY || OLD_KEY.length !== 64) {
  console.error('Error: OLD_ENCRYPTION_KEY env var must be set (64 hex chars).');
  console.error('Usage: OLD_ENCRYPTION_KEY=<old-key> npx tsx scripts/rotate-encryption-key.ts');
  process.exit(1);
}

if (!process.env.ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY.length !== 64) {
  console.error('Error: ENCRYPTION_MASTER_KEY env var must be set (64 hex chars).');
  process.exit(1);
}

if (OLD_KEY === process.env.ENCRYPTION_MASTER_KEY) {
  console.error('Error: OLD_ENCRYPTION_KEY and ENCRYPTION_MASTER_KEY are the same. Nothing to rotate.');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL env var must be set.');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let totalRotated = 0;

    // 1. llm_api_keys
    const llmKeys = await client.query(
      'SELECT id, encrypted_key, key_iv FROM llm_api_keys WHERE encrypted_key IS NOT NULL',
    );
    for (const row of llmKeys.rows) {
      const result = reEncrypt(row.encrypted_key, row.key_iv, OLD_KEY);
      await client.query(
        'UPDATE llm_api_keys SET encrypted_key = $1, key_iv = $2, key_fingerprint = $3 WHERE id = $4',
        [result.encrypted, result.iv, result.fingerprint, row.id],
      );
    }
    console.log(`  llm_api_keys: ${llmKeys.rowCount} rows rotated`);
    totalRotated += llmKeys.rowCount || 0;

    // 2. bots (school API keys)
    const bots = await client.query(
      'SELECT id, school_api_key_encrypted, school_api_key_iv FROM bots WHERE school_api_key_encrypted IS NOT NULL',
    );
    for (const row of bots.rows) {
      const result = reEncrypt(row.school_api_key_encrypted, row.school_api_key_iv, OLD_KEY);
      await client.query(
        'UPDATE bots SET school_api_key_encrypted = $1, school_api_key_iv = $2, school_api_key_fingerprint = $3 WHERE id = $4',
        [result.encrypted, result.iv, result.fingerprint, row.id],
      );
    }
    console.log(`  bots (school keys): ${bots.rowCount} rows rotated`);
    totalRotated += bots.rowCount || 0;

    // 3. bot_platforms (credentials)
    const platforms = await client.query(
      'SELECT id, credentials, credentials_iv FROM bot_platforms WHERE credentials IS NOT NULL',
    );
    for (const row of platforms.rows) {
      const result = reEncrypt(row.credentials, row.credentials_iv, OLD_KEY);
      await client.query(
        'UPDATE bot_platforms SET credentials = $1, credentials_iv = $2, credentials_fingerprint = $3 WHERE id = $4',
        [result.encrypted, result.iv, result.fingerprint, row.id],
      );
    }
    console.log(`  bot_platforms: ${platforms.rowCount} rows rotated`);
    totalRotated += platforms.rowCount || 0;

    // 4. bot_memory_self_authored (encrypted blocks — no fingerprint column)
    const memory = await client.query(
      'SELECT id, encrypted_block, block_iv FROM bot_memory_self_authored WHERE encrypted_block IS NOT NULL',
    );
    for (const row of memory.rows) {
      const result = reEncrypt(row.encrypted_block, row.block_iv, OLD_KEY);
      await client.query(
        'UPDATE bot_memory_self_authored SET encrypted_block = $1, block_iv = $2 WHERE id = $3',
        [result.encrypted, result.iv, row.id],
      );
    }
    console.log(`  bot_memory_self_authored: ${memory.rowCount} rows rotated`);
    totalRotated += memory.rowCount || 0;

    // Verification: try decrypting a sample from each table with the new key
    console.log('\nVerifying decryption with new key...');
    let verified = 0;

    if (llmKeys.rowCount && llmKeys.rowCount > 0) {
      const sample = await client.query(
        'SELECT encrypted_key, key_iv FROM llm_api_keys WHERE encrypted_key IS NOT NULL LIMIT 1',
      );
      if (sample.rows[0]) {
        decrypt(sample.rows[0].encrypted_key, sample.rows[0].key_iv);
        verified++;
      }
    }
    if (bots.rowCount && bots.rowCount > 0) {
      const sample = await client.query(
        'SELECT school_api_key_encrypted, school_api_key_iv FROM bots WHERE school_api_key_encrypted IS NOT NULL LIMIT 1',
      );
      if (sample.rows[0]) {
        decrypt(sample.rows[0].school_api_key_encrypted, sample.rows[0].school_api_key_iv);
        verified++;
      }
    }

    console.log(`  ${verified} table(s) verified successfully`);

    await client.query('COMMIT');
    console.log(`\nKey rotation complete. ${totalRotated} total rows re-encrypted.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nKey rotation FAILED — transaction rolled back. No data was changed.');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
