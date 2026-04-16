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

/**
 * Run a callback inside a single transaction. Commits on success, rolls back
 * on any thrown error (including the BEGIN itself if it fails to start). The
 * returned `tx` has the same shape as the top-level query helpers so callers
 * don't have to think about whether they're in a transaction.
 *
 * Use this when you need two or more statements to succeed or fail together —
 * e.g. the checkout webhook marking a purchase completed AND inserting the
 * entitlement: if the process dies between them, the retry should see the
 * purchase still pending, not silently skip the entitlement insert.
 */
export interface Tx {
  query<R extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<R>>;
  queryRows<R extends QueryResultRow = any>(text: string, params?: any[]): Promise<R[]>;
  queryOne<R extends QueryResultRow = any>(text: string, params?: any[]): Promise<R | null>;
}

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tx: Tx = {
      query: (text, params) => client.query(text, params),
      queryRows: async (text, params) => (await client.query(text, params)).rows as any,
      queryOne: async (text, params) => ((await client.query(text, params)).rows[0] as any) ?? null,
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back / connection gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (for graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
