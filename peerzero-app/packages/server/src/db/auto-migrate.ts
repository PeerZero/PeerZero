// =============================================================================
// Auto-migrate — runs pending .sql migrations on server startup.
// Reads files from src/db/migrations/, tracks applied ones in a
// `schema_migrations` table, and applies any new ones in order.
// =============================================================================

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getPool } from './client';
import { logger } from '../lib/logger';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Get already-applied migrations
  const { rows: applied } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  const appliedSet = new Set(applied.map(r => r.name));

  // Read migration files
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    logger.info({ migration: file }, 'Applying migration');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ migration: file, err }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  if (count > 0) {
    logger.info({ count }, 'Migrations applied');
  } else {
    logger.info('Database up to date');
  }
}
