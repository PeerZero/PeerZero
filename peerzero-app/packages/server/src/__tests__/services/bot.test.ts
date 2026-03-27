import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: { skipPayments: false },
}));

vi.mock('../../services/encryption.service', () => ({
  encrypt: vi.fn(() => ({
    encrypted: Buffer.from('enc'),
    iv: Buffer.from('iv'),
    fingerprint: 'fp',
  })),
  decrypt: vi.fn(() => 'decrypted-key'),
}));

const mockRegister = vi.fn();
vi.mock('../../adapters/adapter.factory', () => ({
  getSchoolAdapter: vi.fn(() => ({ register: mockRegister })),
}));

vi.mock('@peerzero/shared', () => ({
  SUPPORTED_MODEL_IDS: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  BOT_STATUSES: ['idle', 'running', 'paused', 'error', 'stopped'],
  sanitizeAvatarConfig: vi.fn((c: any) => c),
  validateBotName: vi.fn(() => ({ valid: true })),
  getGradePriceCents: vi.fn(() => 499),
  DEFAULT_FAST_MODELS: { anthropic: 'claude-haiku-4-5-20251001' },
}));

// Mock dynamic import of payment.service
const mockGetHighestUnlockedGrade = vi.fn();
const mockUnlockGradeOne = vi.fn();
vi.mock('../../services/payment.service', () => ({
  getHighestUnlockedGrade: (...args: any[]) => mockGetHighestUnlockedGrade(...args),
  unlockGradeOne: (...args: any[]) => mockUnlockGradeOne(...args),
}));

import { AppError } from '../../middleware/error-handler';
import {
  createBot,
  getUserBots,
  getBotDetail,
  updateBot,
  deleteBot,
  enrollBotInSchool,
  generatePhoneHomeToken,
  isBotGradeUnlocked,
  setBotStatus,
  getDecryptedSchoolKey,
} from '../../services/bot.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

// ── createBot ───────────────────────────────────────────────────────────────

describe('createBot', () => {
  it('creates a bot with default model when not specified', async () => {
    // entitlements
    mockQueryRows.mockResolvedValueOnce([{ quantity: 3 }]);
    // bot count
    mockQueryOne.mockResolvedValueOnce({ count: 1 });
    // key lookup
    mockQueryOne.mockResolvedValueOnce({ id: 'key-1', provider: 'anthropic' });
    // insert
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });

    const result = await createBot('user-1', 'TestBot', { color: 'blue' }, 'key-1');

    expect(result).toBe('bot-1');
    const insertCall = mockQueryOne.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO bots');
    expect(insertCall[1]).toContain('claude-opus-4-6'); // default model
    expect(insertCall[1]).toContain('claude-haiku-4-5-20251001'); // fast model
  });

  it('creates a bot with specified model', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: 3 }]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({ id: 'key-1', provider: 'anthropic' });
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-2' });

    const result = await createBot('user-1', 'TestBot', {}, 'key-1', 'claude-sonnet-4-6');
    expect(result).toBe('bot-2');
  });

  it('creates a bot with extendedThinking flag', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: 3 }]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({ id: 'key-1', provider: 'anthropic' });
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-3' });

    await createBot('user-1', 'TestBot', {}, 'key-1', undefined, true);
    const insertCall = mockQueryOne.mock.calls[2];
    expect(insertCall[1][6]).toBe(true); // extendedThinking param
  });

  it('throws 403 when no bot slots available', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: 1 }]);
    mockQueryOne.mockResolvedValueOnce({ count: 1 });

    try {
      await createBot('user-1', 'TestBot', {}, 'key-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(403);
    }
  });

  it('defaults to 1 slot when no entitlements exist', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: null }]);
    mockQueryOne.mockResolvedValueOnce({ count: 1 }); // already used the 1 free slot

    await expect(createBot('user-1', 'TestBot', {}, 'key-1'))
      .rejects.toThrow(AppError);
  });

  it('throws 400 when API key is invalid', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: 3 }]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce(null); // no key found

    try {
      await createBot('user-1', 'TestBot', {}, 'bad-key');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('Invalid API key');
    }
  });

  it('throws 400 for unsupported model', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: 3 }]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({ id: 'key-1', provider: 'anthropic' });

    try {
      await createBot('user-1', 'TestBot', {}, 'key-1', 'gpt-4');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('Unsupported LLM model');
    }
  });

  it('throws 500 when INSERT fails', async () => {
    mockQueryRows.mockResolvedValueOnce([{ quantity: 3 }]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({ id: 'key-1', provider: 'anthropic' });
    mockQueryOne.mockResolvedValueOnce(null); // INSERT returns null

    await expect(createBot('user-1', 'TestBot', {}, 'key-1'))
      .rejects.toThrow(AppError);
  });
});

// ── getUserBots ─────────────────────────────────────────────────────────────

describe('getUserBots', () => {
  it('returns bot summaries for the user', async () => {
    const rows = [
      { id: 'bot-1', name: 'Bot A', status: 'idle' },
      { id: 'bot-2', name: 'Bot B', status: 'running' },
    ];
    mockQueryRows.mockResolvedValueOnce(rows);

    const result = await getUserBots('user-1');
    expect(result).toEqual(rows);
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('returns empty array when user has no bots', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    const result = await getUserBots('user-1');
    expect(result).toEqual([]);
  });
});

// ── getBotDetail ────────────────────────────────────────────────────────────

describe('getBotDetail', () => {
  it('returns bot detail with grade info', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: 'bot-1',
      name: 'TestBot',
      cached_grade: 3,
      cached_profile: null,
      cache_updated_at: null,
      is_public: false,
      public_slug: null,
    });
    mockGetHighestUnlockedGrade.mockResolvedValueOnce(3);

    const result = await getBotDetail('user-1', 'bot-1');
    expect(result.id).toBe('bot-1');
    expect(result.highest_unlocked_grade).toBe(3);
    expect(result.grade_payment_required).toBe(false);
  });

  it('flags grade_payment_required when grade exceeds unlocked', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: 'bot-1',
      name: 'TestBot',
      cached_grade: 5,
      cached_profile: null,
      cache_updated_at: null,
      is_public: true,
      public_slug: 'test-slug',
    });
    mockGetHighestUnlockedGrade.mockResolvedValueOnce(3);

    const result = await getBotDetail('user-1', 'bot-1');
    expect(result.grade_payment_required).toBe(true);
    expect(result.next_grade_price_cents).toBe(499);
  });

  it('marks cache as stale when cache_updated_at is old', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    mockQueryOne.mockResolvedValueOnce({
      id: 'bot-1',
      name: 'TestBot',
      cached_grade: 1,
      cached_profile: '{}',
      cache_updated_at: oldDate,
      is_public: false,
      public_slug: null,
    });
    mockGetHighestUnlockedGrade.mockResolvedValueOnce(1);

    const result = await getBotDetail('user-1', 'bot-1');
    expect(result.cache_stale).toBe(true);
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await getBotDetail('user-1', 'bot-999');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });
});

// ── updateBot ───────────────────────────────────────────────────────────────

describe('updateBot', () => {
  it('updates name when valid', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updateBot('user-1', 'bot-1', { name: 'NewName' });
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toContain('UPDATE bots SET');
    expect(mockQuery.mock.calls[0][1]).toContain('NewName');
  });

  it('throws 400 for invalid name', async () => {
    const { validateBotName } = await import('@peerzero/shared');
    (validateBotName as any).mockReturnValueOnce({ valid: false, error: 'Too short' });

    await expect(updateBot('user-1', 'bot-1', { name: 'x' }))
      .rejects.toThrow(AppError);
  });

  it('validates API key belongs to user', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // key not found for user

    await expect(updateBot('user-1', 'bot-1', { llm_api_key_id: 'bad-key' }))
      .rejects.toThrow(AppError);
  });

  it('throws 400 for invalid cycle_delay_seconds', async () => {
    await expect(updateBot('user-1', 'bot-1', { cycle_delay_seconds: 5 }))
      .rejects.toThrow(AppError);
    try {
      await updateBot('user-1', 'bot-1', { cycle_delay_seconds: 5 });
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('cycle_delay_seconds');
    }
  });

  it('throws 400 for cycle_delay_seconds over max', async () => {
    await expect(updateBot('user-1', 'bot-1', { cycle_delay_seconds: 100000 }))
      .rejects.toThrow(AppError);
  });

  it('generates public_slug when setting is_public to true', async () => {
    // Existing bot has no slug
    mockQueryOne.mockResolvedValueOnce({ public_slug: null, name: 'TestBot' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updateBot('user-1', 'bot-1', { is_public: true });
    expect(mockQuery.mock.calls[0][0]).toContain('public_slug');
  });

  it('does nothing when updates object is empty', async () => {
    await updateBot('user-1', 'bot-1', {});
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── deleteBot ───────────────────────────────────────────────────────────────

describe('deleteBot', () => {
  it('deletes bot with ownership check', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await deleteBot('user-1', 'bot-1');
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot-1', 'user-1']);
  });

  it('throws 404 when bot not found', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    try {
      await deleteBot('user-1', 'bot-999');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });
});

// ── enrollBotInSchool ───────────────────────────────────────────────────────

describe('enrollBotInSchool', () => {
  it('registers bot with school, encrypts key, creates enrollment', async () => {
    // verify ownership
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', name: 'TestBot' });
    // school lookup
    mockQueryOne.mockResolvedValueOnce({ id: 'school-1', base_url: 'https://school.test', slug: 'science' });
    // not already enrolled
    mockQueryOne.mockResolvedValueOnce(null);
    // register returns success
    mockRegister.mockResolvedValueOnce({ success: true, api_key: 'school-key-123' });
    // update bot
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // create enrollment
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // unlockGradeOne
    mockUnlockGradeOne.mockResolvedValueOnce(undefined);

    const result = await enrollBotInSchool('user-1', 'bot-1', 'school-1');
    expect(result.handle).toContain('testbot');
    expect(result.schoolSlug).toBe('science');
    expect(mockRegister).toHaveBeenCalledOnce();
    expect(mockUnlockGradeOne).toHaveBeenCalledWith('bot-1');
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await enrollBotInSchool('user-1', 'bad-bot', 'school-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 404 when school not found', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', name: 'TestBot' });
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await enrollBotInSchool('user-1', 'bot-1', 'bad-school');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 409 when already enrolled', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', name: 'TestBot' });
    mockQueryOne.mockResolvedValueOnce({ id: 'school-1', base_url: 'https://school.test', slug: 'science' });
    mockQueryOne.mockResolvedValueOnce({ id: 'enrollment-1' }); // already exists

    try {
      await enrollBotInSchool('user-1', 'bot-1', 'school-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
    }
  });

  it('throws 502 when school registration fails', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', name: 'TestBot' });
    mockQueryOne.mockResolvedValueOnce({ id: 'school-1', base_url: 'https://school.test', slug: 'science' });
    mockQueryOne.mockResolvedValueOnce(null);
    mockRegister.mockResolvedValueOnce({ success: false, error: 'Connection refused' });

    try {
      await enrollBotInSchool('user-1', 'bot-1', 'school-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(502);
    }
  });
});

// ── generatePhoneHomeToken ──────────────────────────────────────────────────

describe('generatePhoneHomeToken', () => {
  it('generates pht_ token and stores hash', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const token = await generatePhoneHomeToken('user-1', 'bot-1');
    expect(token).toMatch(/^pht_/);
    expect(token.length).toBeGreaterThan(10);
    expect(mockQuery.mock.calls[0][0]).toContain('phone_home_token_hash');
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await generatePhoneHomeToken('user-1', 'bad-bot');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });
});

// ── isBotGradeUnlocked ─────────────────────────────────────────────────────

describe('isBotGradeUnlocked', () => {
  it('returns true when grade_unlocks row exists', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'unlock-1' });
    const result = await isBotGradeUnlocked('bot-1', 3);
    expect(result).toBe(true);
  });

  it('returns false when no grade_unlocks row', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await isBotGradeUnlocked('bot-1', 5);
    expect(result).toBe(false);
  });

  it('returns true when config.skipPayments is true', async () => {
    const { config } = await import('../../config');
    (config as any).skipPayments = true;

    const result = await isBotGradeUnlocked('bot-1', 99);
    expect(result).toBe(true);
    expect(mockQueryOne).not.toHaveBeenCalled();

    // Restore
    (config as any).skipPayments = false;
  });
});

// ── setBotStatus ────────────────────────────────────────────────────────────

describe('setBotStatus', () => {
  it('updates bot status', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await setBotStatus('bot-1', 'running');
    expect(mockQuery.mock.calls[0][1]).toEqual(['running', null, 'bot-1']);
  });

  it('updates bot status with error message', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await setBotStatus('bot-1', 'error', 'Something broke');
    expect(mockQuery.mock.calls[0][1]).toEqual(['error', 'Something broke', 'bot-1']);
  });

  it('throws for invalid status', async () => {
    await expect(setBotStatus('bot-1', 'invalid-status'))
      .rejects.toThrow('Invalid bot status');
  });
});

// ── getDecryptedSchoolKey ───────────────────────────────────────────────────

describe('getDecryptedSchoolKey', () => {
  it('returns decrypted key with handle and base URL', async () => {
    mockQueryOne.mockResolvedValueOnce({
      school_api_key_encrypted: Buffer.from('enc'),
      school_api_key_iv: Buffer.from('iv'),
      school_agent_handle: 'testbot-abc123',
      base_url: 'https://school.test',
    });

    const result = await getDecryptedSchoolKey('bot-1');
    expect(result).toEqual({
      apiKey: 'decrypted-key',
      handle: 'testbot-abc123',
      baseUrl: 'https://school.test',
    });
  });

  it('returns null when bot has no school key', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await getDecryptedSchoolKey('bot-1');
    expect(result).toBeNull();
  });
});
