// =============================================================================
// E2E test setup — real Express server + real Postgres
//
// Spins up the full app server (minus Redis/BullMQ workers) against a dedicated
// test database. All adapters run as configured — mock by default, real if
// USE_REAL_ADAPTERS=true. This tests the full HTTP stack: routes → middleware →
// services → database, with real SQL queries and real JWT auth.
//
// Usage:
//   const { api, cleanup, db } = await setupE2E();
//   afterAll(() => cleanup());
// =============================================================================

import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer, Server } from 'http';

// Env vars are set by vitest.e2e.config.ts (loaded from .env.test)
const TEST_DB_URL = process.env.DATABASE_URL || 'postgresql://peerzero:testpass@localhost:5432/peerzero_e2e_test';

/** HTTP client helper — wraps fetch with base URL and optional auth. */
export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setToken(token: string) {
    this.token = token;
  }

  clearToken() {
    this.token = null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async get(path: string, extra: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(extra) });
    const body: any = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async post(path: string, data?: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(extra),
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const body: any = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async patch(path: string, data: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: this.headers(extra),
      body: JSON.stringify(data),
    });
    const body: any = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async delete(path: string, extra: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers(extra),
    });
    const body: any = await res.json().catch(() => null);
    return { status: res.status, body };
  }
}

/** Reset the database — drop all tables and re-apply schema. */
async function resetDatabase(pool: Pool): Promise<void> {
  // Drop everything in public schema
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);

  // Apply schema.sql
  const schemaPath = resolve(__dirname, '../../db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);
}

export interface E2EContext {
  api: ApiClient;
  db: Pool;
  server: Server;
  cleanup: () => Promise<void>;
}

/** Spin up the full app server against the test database. */
export async function setupE2E(): Promise<E2EContext> {
  // Create a fresh pool for direct DB access in tests
  const pool = new Pool({ connectionString: TEST_DB_URL });

  // Reset database before tests
  await resetDatabase(pool);

  // Import app modules AFTER env vars are set
  // @ts-expect-error no type declarations for express-async-errors
  await import('express-async-errors'); // Must be imported before routes — patches Express to handle async errors
  const { errorHandler } = await import('../../middleware/error-handler');
  const authRoutes = (await import('../../routes/auth')).default;
  const botRoutes = (await import('../../routes/bots')).default;
  const apiKeyRoutes = (await import('../../routes/api-keys')).default;
  const schoolRoutes = (await import('../../routes/schools')).default;
  const healthRoutes = (await import('../../routes/health')).default;
  const skillRoutes = (await import('../../routes/skills')).default;

  // Build Express app (same as index.ts but without Redis, Stripe webhooks, WS)
  // No rate limiting in E2E tests — auth limiter would block after 10 requests
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '5mb' }));

  // Routes (no authLimiter — tests need unlimited auth requests)
  app.use('/api/auth', authRoutes);
  app.use('/api/bots', botRoutes);
  app.use('/api/keys', apiKeyRoutes);
  app.use('/api/schools', schoolRoutes);
  app.use('/api/skills', skillRoutes);
  app.use('/health', healthRoutes);

  // Error handler
  app.use(errorHandler);

  // Start on a random port
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://localhost:${port}`;

  const api = new ApiClient(baseUrl);

  const cleanup = async () => {
    server.close();
    // Close rate-limit Redis connection (prevents event loop hang)
    const { closeRateLimitRedis } = await import('../../middleware/rate-limit');
    await closeRateLimitRedis();
    // Reset the module-level cached pool in db/client so it doesn't leak
    const { closePool } = await import('../../db/client');
    await closePool();
    await pool.end();
  };

  return { api, db: pool, server, cleanup };
}

// ── Test data helpers ─────────────────────────────────────────────────────────

let userCounter = 0;

/** Register a fresh user and return their credentials + token. */
export async function registerUser(api: ApiClient, overrides: { email?: string; password?: string } = {}) {
  userCounter++;
  const email = overrides.email || `e2e-user-${userCounter}-${Date.now()}@test.com`;
  const password = overrides.password || 'TestPass123!';
  const res = await api.post('/api/auth/register', { email, password });
  if (res.status !== 201) {
    throw new Error(`Registration failed: ${JSON.stringify(res.body)}`);
  }
  api.setToken(res.body.access_token);
  return { email, password, ...res.body };
}

/** Add a fake LLM API key for the authenticated user. */
export async function addApiKey(api: ApiClient, opts: { provider?: string; label?: string; key?: string } = {}) {
  const res = await api.post('/api/keys', {
    provider: opts.provider || 'anthropic',
    label: opts.label || `test-key-${Date.now()}`,
    key: opts.key || 'sk-ant-test-key-that-is-long-enough-for-validation',
  });
  if (res.status !== 201) {
    throw new Error(`Add API key failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Create a bot for the authenticated user. Requires an API key ID. */
export async function createBot(api: ApiClient, apiKeyId: string, overrides: Record<string, unknown> = {}) {
  const res = await api.post('/api/bots', {
    name: overrides.name || `E2E Bot ${Date.now()}`,
    avatar_config: overrides.avatar_config || { body_color: '#6C5CE7', face_style: 'default' },
    llm_api_key_id: apiKeyId,
    llm_model: overrides.llm_model || 'claude-sonnet-4-6',
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`Create bot failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}
