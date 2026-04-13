// =============================================================================
// Database client — App's own Postgres (NOT the School's Supabase)
// Uses pg directly for simplicity. No ORM — raw SQL is transparent.
// =============================================================================

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const sslEnabled = config.databaseUrl.includes('sslmode=');
    const statementTimeoutMs = Math.max(1000, parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000') || 30000);
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: Math.max(1, parseInt(process.env.DB_POOL_MAX || '20') || 20),
      idleTimeoutMillis: Math.max(1000, parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000') || 30000),
      connectionTimeoutMillis: Math.max(1000, parseInt(process.env.DB_POOL_CONN_TIMEOUT || '15000') || 15000),
      // Prevent runaway queries from blocking connections indefinitely
      statement_timeout: statementTimeoutMs,
      ...(sslEnabled && { ssl: { rejectUnauthorized: process.env.NODE_ENV === 'production' } }),
    });
  }
  return pool;
}

/** Run a parameterized query. Always use $1, $2 placeholders — never string interpolation. */
export async function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Run a query and return just the rows. */
export async function queryRows<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

/** Run a query and return the first row or null. */
export async function queryOne<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<T | null> {
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
