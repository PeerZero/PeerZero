// =============================================================================
// Database client — App's own Postgres (NOT the School's Supabase)
// Uses pg directly for simplicity. No ORM — raw SQL is transparent.
// =============================================================================

import { Pool, QueryResult } from 'pg';
import { config } from '../config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

/** Run a parameterized query. Always use $1, $2 placeholders — never string interpolation. */
export async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Run a query and return just the rows. */
export async function queryRows<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

/** Run a query and return the first row or null. */
export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] || null;
}

/** Close the pool (for graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
