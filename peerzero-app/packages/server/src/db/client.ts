// =============================================================================
// Database client — App's own Postgres (NOT the School's Supabase)
// Uses pg directly for simplicity. No ORM — raw SQL is transparent.
// =============================================================================

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const dbUrl = config.databaseUrl;
    const sslEnabled = dbUrl.includes('sslmode=');
    const statementTimeoutMs = Math.max(1000, parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10) || 30000);

    // Auto-detect Supabase pooler (PgBouncer) — uses port 6543 or has pgbouncer=true.
    // When behind the pooler, the app-side pool can be larger since PgBouncer manages
    // the actual Postgres connection limit. Our queries use unnamed prepared statements
    // (pool.query(text, params)) which work in PgBouncer transaction mode — no special
    // config needed beyond a higher pool max.
    const isPooler = dbUrl.includes('pgbouncer=true') || dbUrl.includes(':6543');
    const defaultMax = isPooler ? 50 : 20;

    pool = new Pool({
      connectionString: dbUrl,
      max: Math.max(1, parseInt(process.env.DB_POOL_MAX || String(defaultMax), 10) || defaultMax),
      idleTimeoutMillis: Math.max(1000, parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10) || 30000),
      connectionTimeoutMillis: Math.max(1000, parseInt(process.env.DB_POOL_CONN_TIMEOUT || '15000', 10) || 15000),
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
