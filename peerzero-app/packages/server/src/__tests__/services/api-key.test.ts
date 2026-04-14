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

vi.mock('../../services/encryption.service', () => ({
  encrypt: vi.fn(() => ({
    encrypted: Buffer.from('enc'),
    iv: Buffer.from('iv'),
    fingerprint: 'fp-1234',
  })),
  decrypt: vi.fn(() => 'decrypted-key'),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock global fetch so validateKeyWithProvider doesn't make real API calls
const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
vi.stubGlobal('fetch', mockFetch);

import { AppError } from '../../middleware/error-handler';
import {
  addApiKey,
  getUserApiKeys,
  deleteApiKey,
  getDecryptedKey,
  markKeyInvalid,
} from '../../services/api-key.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('addApiKey', () => {
  it('encrypts the key and inserts, returning ApiKeyInfo', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'key-1', created_at: '2026-01-01T00:00:00Z' });

    const result = await addApiKey('user-1', 'anthropic' as any, 'My Key', 'sk-plain');

    expect(mockQueryOne).toHaveBeenCalledOnce();
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('INSERT INTO llm_api_keys');
    expect(params).toEqual([
      'user-1',
      'anthropic',
      'My Key',
      Buffer.from('enc'),
      Buffer.from('iv'),
      'fp-1234',
    ]);
    expect(result).toEqual({
      id: 'key-1',
      provider: 'anthropic',
      label: 'My Key',
      key_fingerprint: 'fp-1234',
      is_valid: true,
      created_at: '2026-01-01T00:00:00Z',
    });
  });
});

describe('getUserApiKeys', () => {
  it('returns rows for the given user', async () => {
    const rows = [
      { id: 'k1', provider: 'anthropic', label: 'A', key_fingerprint: 'fp-1', is_valid: true, created_at: '2026-01-01' },
    ];
    mockQueryRows.mockResolvedValueOnce(rows);

    const result = await getUserApiKeys('user-1');

    expect(mockQueryRows).toHaveBeenCalledOnce();
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['user-1']);
    expect(result).toEqual(rows);
  });

  it('returns empty array when user has no keys', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    const result = await getUserApiKeys('user-1');
    expect(result).toEqual([]);
  });
});

describe('deleteApiKey', () => {
  it('deletes the key when no running bots use it', async () => {
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await deleteApiKey('user-1', 'key-1');

    expect(mockQueryOne).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][1]).toEqual(['key-1', 'user-1']);
  });

  it('throws 409 when running bots use the key', async () => {
    mockQueryOne.mockResolvedValueOnce({ count: 2 });

    try {
      await deleteApiKey('user-1', 'key-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(409);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws 404 when key not found (rowCount 0)', async () => {
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    try {
      await deleteApiKey('user-1', 'key-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });
});

describe('getDecryptedKey', () => {
  it('returns decrypted key for valid row', async () => {
    mockQueryOne.mockResolvedValueOnce({
      encrypted_key: Buffer.from('enc'),
      key_iv: Buffer.from('iv'),
      expires_at: null,
    });

    const result = await getDecryptedKey('key-1', 'user-1');
    expect(result).toBe('decrypted-key');
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['key-1', 'user-1']);
  });

  it('throws 404 when key not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await getDecryptedKey('key-1', 'user-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 410 when key is expired', async () => {
    mockQueryOne.mockResolvedValueOnce({
      encrypted_key: Buffer.from('enc'),
      key_iv: Buffer.from('iv'),
      expires_at: '2020-01-01T00:00:00Z', // past date
    });

    try {
      await getDecryptedKey('key-1', 'user-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(410);
    }
  });

  it('does not throw when expires_at is in the future', async () => {
    mockQueryOne.mockResolvedValueOnce({
      encrypted_key: Buffer.from('enc'),
      key_iv: Buffer.from('iv'),
      expires_at: '2099-01-01T00:00:00Z',
    });

    const result = await getDecryptedKey('key-1', 'user-1');
    expect(result).toBe('decrypted-key');
  });
});

describe('markKeyInvalid', () => {
  it('updates is_valid to false', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await markKeyInvalid('key-1');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('is_valid = false');
    expect(params).toEqual(['key-1']);
  });
});
