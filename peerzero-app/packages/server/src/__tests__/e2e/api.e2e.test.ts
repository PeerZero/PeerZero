// =============================================================================
// E2E API tests — full HTTP stack against a real Postgres database
//
// Tests the complete user journey:
// 1. Auth (register, login, refresh, profile)
// 2. API keys (add, list, delete)
// 3. Bots (create, list, detail, update, delete)
// 4. Schools (list, get)
// 5. Bot enrollment
// 6. Bot memory & activity
// 7. Bot skills
// 8. Error handling & edge cases
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupE2E, registerUser, addApiKey, createBot, ApiClient, E2EContext } from './setup';

let ctx: E2EContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await setupE2E();
  api = ctx.api;
}, 30000);

afterAll(async () => {
  await ctx.cleanup();
}, 10000);

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('Auth', () => {
  it('registers a new user', async () => {
    const res = await api.post('/api/auth/register', {
      email: `auth-test-${Date.now()}@test.com`,
      password: 'SecurePass123!',
    });
    expect(res.status).toBe(201);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.user.email).toContain('auth-test');
    expect(res.body.user.entitlements.bot_slots).toBe(1);
  });

  it('rejects duplicate email', async () => {
    const email = `dup-${Date.now()}@test.com`;
    await api.post('/api/auth/register', { email, password: 'TestPass123!' });
    const res = await api.post('/api/auth/register', { email, password: 'TestPass123!' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already registered');
  });

  it('rejects short password', async () => {
    const res = await api.post('/api/auth/register', {
      email: `short-${Date.now()}@test.com`,
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid email format', async () => {
    const res = await api.post('/api/auth/register', {
      email: 'not-an-email',
      password: 'TestPass123!',
    });
    expect(res.status).toBe(400);
  });

  it('logs in with valid credentials', async () => {
    const email = `login-${Date.now()}@test.com`;
    await api.post('/api/auth/register', { email, password: 'TestPass123!' });

    const res = await api.post('/api/auth/login', { email, password: 'TestPass123!' });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.user.email).toBe(email);
  });

  it('rejects login with wrong password', async () => {
    const email = `wrong-pass-${Date.now()}@test.com`;
    await api.post('/api/auth/register', { email, password: 'TestPass123!' });

    const res = await api.post('/api/auth/login', { email, password: 'WrongPassword!' });
    expect(res.status).toBe(401);
  });

  it('refreshes tokens', async () => {
    const email = `refresh-${Date.now()}@test.com`;
    const reg = await api.post('/api/auth/register', { email, password: 'TestPass123!' });
    const refreshToken = reg.body.refresh_token;

    const res = await api.post('/api/auth/refresh', { refresh_token: refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    // Old refresh token should be consumed (rotation)
    expect(res.body.refresh_token).not.toBe(refreshToken);
  });

  it('rejects reused refresh token', async () => {
    const email = `reuse-${Date.now()}@test.com`;
    const reg = await api.post('/api/auth/register', { email, password: 'TestPass123!' });
    const refreshToken = reg.body.refresh_token;

    // Use it once
    await api.post('/api/auth/refresh', { refresh_token: refreshToken });
    // Try to reuse
    const res = await api.post('/api/auth/refresh', { refresh_token: refreshToken });
    expect(res.status).toBe(401);
  });

  it('gets user profile with /me', async () => {
    await registerUser(api);
    const res = await api.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.entitlements).toBeDefined();
  });

  it('updates display name', async () => {
    await registerUser(api);
    const res = await api.patch('/api/auth/profile', { display_name: 'E2E Tester' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('E2E Tester');
  });

  it('changes password', async () => {
    const { email, password } = await registerUser(api);
    const res = await api.patch('/api/auth/password', {
      current_password: password,
      new_password: 'NewSecurePass456!',
    });
    expect(res.status).toBe(200);

    // Can log in with new password
    const login = await api.post('/api/auth/login', { email, password: 'NewSecurePass456!' });
    expect(login.status).toBe(200);
  });

  it('rejects requests without auth token', async () => {
    api.clearToken();
    const res = await api.get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('deletes account', async () => {
    await registerUser(api);
    const res = await api.delete('/api/auth/account');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Token should no longer work (user deleted)
    const me = await api.get('/api/auth/me');
    // Will either be 401 (expired) or 404 (user not found) depending on JWT expiry
    expect([401, 404]).toContain(me.status);
  });
});

// ── API Keys ─────────────────────────────────────────────────────────────────

describe('API Keys', () => {
  it('adds an Anthropic API key', async () => {
    await registerUser(api);
    const key = await addApiKey(api, { provider: 'anthropic', label: 'my-claude-key' });
    expect(key.id).toBeDefined();
    expect(key.provider).toBe('anthropic');
    expect(key.label).toBe('my-claude-key');
    expect(key.key_fingerprint).toBeDefined();
    expect(key.is_valid).toBe(true);
  });

  it('adds an OpenAI API key', async () => {
    await registerUser(api);
    const key = await addApiKey(api, { provider: 'openai', label: 'my-gpt-key' });
    expect(key.provider).toBe('openai');
  });

  it('lists user keys', async () => {
    await registerUser(api);
    await addApiKey(api, { label: 'key-1' });
    await addApiKey(api, { label: 'key-2' });
    const res = await api.get('/api/keys');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('deletes an API key', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const res = await api.delete(`/api/keys/${key.id}`);
    expect(res.status).toBe(200);

    // Key should be gone
    const list = await api.get('/api/keys');
    const ids = list.body.map((k: { id: string }) => k.id);
    expect(ids).not.toContain(key.id);
  });

  it('rejects invalid provider', async () => {
    await registerUser(api);
    const res = await api.post('/api/keys', {
      provider: 'google',
      label: 'bad',
      key: 'sk-test-key-long-enough-for-validation',
    });
    expect(res.status).toBe(400);
  });

  it('rejects key too short', async () => {
    await registerUser(api);
    const res = await api.post('/api/keys', {
      provider: 'anthropic',
      label: 'short-key',
      key: 'short',
    });
    expect(res.status).toBe(400);
  });
});

// ── Bots ─────────────────────────────────────────────────────────────────────

describe('Bots', () => {
  it('creates a bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id, { name: 'TestBot Alpha' });
    expect(bot.id).toBeDefined();
    expect(bot.name).toBe('TestBot Alpha');
    expect(bot.status).toBe('stopped');
    expect(bot.llm_model).toBe('claude-sonnet-4-6');
  });

  it('lists user bots', async () => {
    const regResult = await registerUser(api);
    const key = await addApiKey(api);

    // Grant extra bot slot: default is 1 (from || 1 fallback). Insert quantity=2 to get 2 total slots.
    await ctx.db.query(
      `INSERT INTO user_entitlements (user_id, entitlement_type, quantity) VALUES ($1, 'bot_shell', 2)`,
      [regResult.user.id],
    );

    await createBot(api, key.id, { name: 'Bot A' });
    await createBot(api, key.id, { name: 'Bot B' });

    const res = await api.get('/api/bots');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('gets bot detail', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const res = await api.get(`/api/bots/${bot.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(bot.id);
    expect(res.body.cycle_delay_seconds).toBe(120);
    expect(res.body.extended_thinking).toBe(false);
  });

  it('updates bot settings', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const res = await api.patch(`/api/bots/${bot.id}`, {
      name: 'Renamed Bot',
      cycle_delay_seconds: 300,
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Bot');
  });

  it('deletes a bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const del = await api.delete(`/api/bots/${bot.id}`);
    expect(del.status).toBe(200);

    // Should be gone
    const get = await api.get(`/api/bots/${bot.id}`);
    expect(get.status).toBe(404);
  });

  it('rejects bot creation without required fields', async () => {
    await registerUser(api);
    const res = await api.post('/api/bots', { name: 'Missing Key' });
    expect(res.status).toBe(400);
  });

  it('rejects bot creation with invalid API key', async () => {
    await registerUser(api);
    const res = await api.post('/api/bots', {
      name: 'Bad Key Bot',
      avatar_config: { body_color: '#FF0000', face_style: 'default' },
      llm_api_key_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(400);
  });

  it('enforces bot slot limit', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    // Default is 1 free slot
    await createBot(api, key.id);
    // Second bot should fail
    const res = await api.post('/api/bots', {
      name: 'Over Limit',
      avatar_config: { body_color: '#FF0000', face_style: 'default' },
      llm_api_key_id: key.id,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('slot');
  });

  it('prevents deleting API key used by running bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    // Manually set bot to running status in DB
    await ctx.db.query("UPDATE bots SET status = 'running' WHERE id = $1", [bot.id]);

    const res = await api.delete(`/api/keys/${key.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('running');
  });
});

// ── Schools ──────────────────────────────────────────────────────────────────

describe('Schools', () => {
  it('lists schools', async () => {
    const res = await api.get('/api/schools');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].slug || res.body[0].name).toBeDefined();
  });

  it('gets a school by id', async () => {
    const list = await api.get('/api/schools');
    const schoolId = list.body[0].id;

    const res = await api.get(`/api/schools/${schoolId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(schoolId);
  });

  it('returns 404 for nonexistent school', async () => {
    const res = await api.get('/api/schools/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

// ── Bot Enrollment ───────────────────────────────────────────────────────────

describe('Bot Enrollment', () => {
  it('enrolls a bot in a school (mock adapter)', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const schools = await api.get('/api/schools');
    const schoolId = schools.body[0].id;

    const res = await api.post(`/api/bots/${bot.id}/enroll`, { school_id: schoolId });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBeDefined();

    // Bot detail should show school connection
    const detail = await api.get(`/api/bots/${bot.id}`);
    expect(detail.body.school_id).toBe(schoolId);
  });

  it('rejects duplicate enrollment', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const schools = await api.get('/api/schools');
    const schoolId = schools.body[0].id;

    await api.post(`/api/bots/${bot.id}/enroll`, { school_id: schoolId });
    const res = await api.post(`/api/bots/${bot.id}/enroll`, { school_id: schoolId });
    expect(res.status).toBe(409);
  });
});

// ── Bot Memory ───────────────────────────────────────────────────────────────

describe('Bot Memory', () => {
  it('returns empty memory snapshot for new bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const res = await api.get(`/api/bots/${bot.id}/memory`);
    expect(res.status).toBe(200);
    expect(res.body.tier1_exercises).toEqual([]);
    expect(res.body.tier2_paragraphs).toEqual([]);
    expect(res.body.tier3_core).toBeNull();
  });

  it('returns memory after direct DB insert', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    // Insert exercise directly
    await ctx.db.query(
      `INSERT INTO bot_memory_exercises (bot_id, cycle_number, action_type, exercise_data)
       VALUES ($1, 1, 'review', $2)`,
      [bot.id, JSON.stringify({ skill: 'test', outcome: 'SUCCESS' })],
    );

    const res = await api.get(`/api/bots/${bot.id}/memory`);
    expect(res.status).toBe(200);
    expect(res.body.tier1_exercises.length).toBe(1);
  });
});

// ── Bot Activity ─────────────────────────────────────────────────────────────

describe('Bot Activity', () => {
  it('returns empty activity for new bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const res = await api.get(`/api/bots/${bot.id}/activity`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns activity after direct DB insert', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    await ctx.db.query(
      `INSERT INTO activity_log (bot_id, cycle_number, action_type, translated)
       VALUES ($1, 1, 'review', $2)`,
      [bot.id, JSON.stringify({ headline: 'Reviewed paper', summary: '+3 credibility', details: [], mood: 'positive' })],
    );

    const res = await api.get(`/api/bots/${bot.id}/activity`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].translated.headline).toBe('Reviewed paper');
  });

  it('soft-deletes activity', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const { rows } = await ctx.db.query(
      `INSERT INTO activity_log (bot_id, cycle_number, action_type, translated)
       VALUES ($1, 1, 'paper', $2) RETURNING id`,
      [bot.id, JSON.stringify({ headline: 'Paper', summary: 'Test', details: [], mood: 'neutral' })],
    );
    const activityId = rows[0].id;

    const del = await api.delete(`/api/bots/${bot.id}/activity/${activityId}`);
    expect(del.status).toBe(200);

    // Should not appear in activity list
    const list = await api.get(`/api/bots/${bot.id}/activity`);
    const ids = list.body.data.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(activityId);
  });

  it('deletes all activity for a bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    // Insert multiple activities
    for (let i = 0; i < 3; i++) {
      await ctx.db.query(
        `INSERT INTO activity_log (bot_id, cycle_number, action_type, translated)
         VALUES ($1, $2, 'review', $3)`,
        [bot.id, i + 1, JSON.stringify({ headline: `Review ${i}`, summary: 'Test', details: [], mood: 'neutral' })],
      );
    }

    const del = await api.delete(`/api/bots/${bot.id}/activity`);
    expect(del.status).toBe(200);
    expect(del.body.deleted_count).toBe(3);

    const list = await api.get(`/api/bots/${bot.id}/activity`);
    expect(list.body.data.length).toBe(0);
  });
});

// ── Bot Skills ───────────────────────────────────────────────────────────────

describe('Bot Skills', () => {
  it('returns empty skill snapshots for new bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const res = await api.get(`/api/bots/${bot.id}/skills`);
    expect(res.status).toBe(200);
    // Might return empty array or populated with defaults
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Bot Stats ────────────────────────────────────────────────────────────────

describe('Bot Stats', () => {
  it('returns stats for a bot', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id);

    const res = await api.get(`/api/bots/${bot.id}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.total_cycles).toBeDefined();
  });
});

// ── Cross-User Isolation ─────────────────────────────────────────────────────

describe('Cross-User Isolation', () => {
  it('cannot access another user\'s bot', async () => {
    // User A creates a bot
    await registerUser(api);
    const keyA = await addApiKey(api);
    const botA = await createBot(api, keyA.id);

    // User B tries to access it
    await registerUser(api);
    const res = await api.get(`/api/bots/${botA.id}`);
    expect(res.status).toBe(404);
  });

  it('cannot delete another user\'s API key', async () => {
    // User A creates a key
    await registerUser(api);
    const keyA = await addApiKey(api);

    // User B tries to delete it
    await registerUser(api);
    const res = await api.delete(`/api/keys/${keyA.id}`);
    expect(res.status).toBe(404);
  });

  it('user bots list only shows own bots', async () => {
    // User A creates a bot
    await registerUser(api);
    const keyA = await addApiKey(api);
    await createBot(api, keyA.id, { name: 'UserA Bot' });

    // User B lists bots
    await registerUser(api);
    const res = await api.get('/api/bots');
    expect(res.status).toBe(200);
    const names = res.body.map((b: { name: string }) => b.name);
    expect(names).not.toContain('UserA Bot');
  });
});

// ── Health Check ─────────────────────────────────────────────────────────────

describe('Health', () => {
  it('returns healthy', async () => {
    api.clearToken();
    const res = await api.get('/health');
    expect(res.status).toBe(200);
  });
});

// ── Avatar Validation ────────────────────────────────────────────────────────

describe('Avatar Validation', () => {
  it('sanitizes XSS in avatar config', async () => {
    await registerUser(api);
    const key = await addApiKey(api);
    const bot = await createBot(api, key.id, {
      avatar_config: {
        body_color: '<script>alert(1)</script>',
        face_style: 'javascript:void(0)',
      },
    });
    // Should be sanitized to defaults
    expect(bot.avatar_config.body_color).toBe('#6C5CE7'); // fallback
    expect(bot.avatar_config.face_style).toBe('default'); // fallback
  });
});
