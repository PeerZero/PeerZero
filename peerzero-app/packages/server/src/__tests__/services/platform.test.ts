import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock refs (defined before vi.mock) ──────────────────────────────────────

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

vi.mock('../../services/encryption.service', () => ({
  encrypt: vi.fn(() => ({
    encrypted: Buffer.from('enc'),
    iv: Buffer.from('iv'),
    fingerprint: 'fp',
  })),
  decrypt: vi.fn(() => 'decrypted-key'),
}));

const mockLogAudit = vi.fn();
vi.mock('../../services/audit.service', () => ({
  logAudit: (...args: any[]) => mockLogAudit(...args),
}));

const mockNotifyPlatformConnected = vi.fn();
const mockNotifyPlatformError = vi.fn();
vi.mock('../../services/notification.service', () => ({
  notifyPlatformConnected: (...args: any[]) => mockNotifyPlatformConnected(...args),
  notifyPlatformError: (...args: any[]) => mockNotifyPlatformError(...args),
}));

const mockInstallStarterSkills = vi.fn();
vi.mock('../../services/skill-engine.service', () => ({
  installStarterSkills: (...args: any[]) => mockInstallStarterSkills(...args),
}));

vi.mock('@peerzero/shared', () => ({
  MAX_PLATFORMS_PER_BOT: 5,
}));

import { AppError } from '../../middleware/error-handler';
import {
  getAvailablePlatforms,
  listPlatforms,
  connectPlatform,
  disconnectPlatform,
  updatePlatform,
  updatePlatformCycleStatus,
  getPlatformCredentials,
  getActivePlatforms,
} from '../../services/platform.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

// ── getAvailablePlatforms ──────────────────────────────────────────────────

describe('getAvailablePlatforms', () => {
  it('returns active platforms from registry', async () => {
    const platforms = [
      { id: 'p1', slug: 'discord', name: 'Discord', adapter_type: 'discord', is_active: true },
      { id: 'p2', slug: 'slack', name: 'Slack', adapter_type: 'slack', is_active: true },
    ];
    mockQueryRows.mockResolvedValueOnce(platforms);

    const result = await getAvailablePlatforms();
    expect(result).toEqual(platforms);
    expect(mockQueryRows.mock.calls[0][0]).toContain('platform_registry');
  });

  it('returns empty array when no platforms exist', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    const result = await getAvailablePlatforms();
    expect(result).toEqual([]);
  });
});

// ── listPlatforms ──────────────────────────────────────────────────────────

describe('listPlatforms', () => {
  it('returns platform connections after ownership check', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' }); // ownership
    const connections = [
      { id: 'conn-1', platform_name: 'discord', status: 'active' },
    ];
    mockQueryRows.mockResolvedValueOnce(connections);

    const result = await listPlatforms('bot-1', 'user-1');
    expect(result).toEqual(connections);
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await listPlatforms('bad-bot', 'user-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });
});

// ── connectPlatform ────────────────────────────────────────────────────────

describe('connectPlatform', () => {
  it('connects bot to platform with full happy path', async () => {
    // ownership check
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    // platform count
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    // registry lookup
    mockQueryOne.mockResolvedValueOnce({
      slug: 'discord', name: 'Discord', adapter_type: 'discord',
      default_config: { heartbeat_interval: 3600 },
    });
    // duplicate check
    mockQueryOne.mockResolvedValueOnce(null);
    // insert
    mockQueryOne.mockResolvedValueOnce({
      id: 'conn-1', platform_name: 'discord', adapter_type: 'discord',
      status: 'active', heartbeat_interval_seconds: 3600,
      last_cycle_at: null, cycle_count: 0, error_message: null,
      created_at: '2026-01-01',
    });
    // bot name lookup for notification
    mockQueryOne.mockResolvedValueOnce({ name: 'TestBot' });
    // starter skills
    mockInstallStarterSkills.mockResolvedValueOnce(undefined);

    const result = await connectPlatform('bot-1', 'user-1', 'discord', 'api-key-123');
    expect(result.id).toBe('conn-1');
    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit.mock.calls[0][0].action).toBe('platform.connect');
    expect(mockNotifyPlatformConnected).toHaveBeenCalledWith('user-1', 'bot-1', 'TestBot', 'Discord');
    expect(mockInstallStarterSkills).toHaveBeenCalledWith('bot-1', 'user-1', 'discord');
  });

  it('accepts config overrides with valid keys', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({
      slug: 'discord', name: 'Discord', adapter_type: 'discord',
      default_config: {},
    });
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce({
      id: 'conn-1', platform_name: 'discord', adapter_type: 'discord',
      status: 'active', heartbeat_interval_seconds: 7200,
      last_cycle_at: null, cycle_count: 0, error_message: null,
      created_at: '2026-01-01',
    });
    mockQueryOne.mockResolvedValueOnce({ name: 'TestBot' });
    mockInstallStarterSkills.mockResolvedValueOnce(undefined);

    const result = await connectPlatform('bot-1', 'user-1', 'discord', 'key', {
      heartbeat_interval: 7200,
      retry_enabled: true,
    });
    expect(result.id).toBe('conn-1');
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await connectPlatform('bad-bot', 'user-1', 'discord', 'key');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 400 when platform limit reached', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 5 }); // at limit

    try {
      await connectPlatform('bot-1', 'user-1', 'discord', 'key');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('Maximum');
    }
  });

  it('throws 404 when platform not found in registry', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce(null); // not in registry

    try {
      await connectPlatform('bot-1', 'user-1', 'nonexistent', 'key');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
      expect(e.message).toContain('Platform not found');
    }
  });

  it('throws 409 when already connected', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({
      slug: 'discord', name: 'Discord', adapter_type: 'discord',
      default_config: {},
    });
    mockQueryOne.mockResolvedValueOnce({ id: 'existing-conn' }); // already connected

    try {
      await connectPlatform('bot-1', 'user-1', 'discord', 'key');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(409);
    }
  });

  it('throws 400 for disallowed config override key', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({
      slug: 'discord', name: 'Discord', adapter_type: 'discord',
      default_config: {},
    });
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await connectPlatform('bot-1', 'user-1', 'discord', 'key', {
        evil_key: 'hacker',
      });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('not allowed');
    }
  });

  it('throws 400 for config override with wrong type', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({
      slug: 'discord', name: 'Discord', adapter_type: 'discord',
      default_config: {},
    });
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await connectPlatform('bot-1', 'user-1', 'discord', 'key', {
        heartbeat_interval: 'not-a-number' as any,
      });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('must be of type');
    }
  });

  it('handles starter skill installation failure gracefully', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQueryOne.mockResolvedValueOnce({ count: 0 });
    mockQueryOne.mockResolvedValueOnce({
      slug: 'discord', name: 'Discord', adapter_type: 'discord',
      default_config: { heartbeat_interval: 3600 },
    });
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce({
      id: 'conn-1', platform_name: 'discord', adapter_type: 'discord',
      status: 'active', heartbeat_interval_seconds: 3600,
      last_cycle_at: null, cycle_count: 0, error_message: null,
      created_at: '2026-01-01',
    });
    mockQueryOne.mockResolvedValueOnce({ name: 'TestBot' });
    mockInstallStarterSkills.mockRejectedValueOnce(new Error('skill install failed'));

    // Should NOT throw — starter skill failure is non-fatal
    const result = await connectPlatform('bot-1', 'user-1', 'discord', 'api-key-123');
    expect(result.id).toBe('conn-1');
  });
});

// ── disconnectPlatform ─────────────────────────────────────────────────────

describe('disconnectPlatform', () => {
  it('deletes platform connection and logs audit', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' }); // ownership
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await disconnectPlatform('bot-1', 'user-1', 'conn-1');
    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit.mock.calls[0][0].action).toBe('platform.disconnect');
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await disconnectPlatform('bad-bot', 'user-1', 'conn-1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
      expect(e.message).toBe('Bot not found');
    }
  });

  it('throws 404 when platform connection not found', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    try {
      await disconnectPlatform('bot-1', 'user-1', 'bad-conn');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
      expect(e.message).toContain('Platform connection not found');
    }
  });
});

// ── updatePlatform ─────────────────────────────────────────────────────────

describe('updatePlatform', () => {
  it('updates status to active', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' }); // ownership
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updatePlatform('bot-1', 'user-1', 'conn-1', { status: 'active' });
    expect(mockQuery.mock.calls[0][0]).toContain('UPDATE bot_platforms SET');
    expect(mockQuery.mock.calls[0][1]).toContain('active');
  });

  it('updates heartbeat_interval_seconds', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updatePlatform('bot-1', 'user-1', 'conn-1', { heartbeat_interval_seconds: 120 });
    expect(mockQuery.mock.calls[0][1]).toContain(120);
  });

  it('throws 404 when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    try {
      await updatePlatform('bad-bot', 'user-1', 'conn-1', { status: 'active' });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 400 for invalid status', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });

    try {
      await updatePlatform('bot-1', 'user-1', 'conn-1', { status: 'invalid' });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('Invalid status');
    }
  });

  it('throws 400 for heartbeat below minimum (60)', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });

    try {
      await updatePlatform('bot-1', 'user-1', 'conn-1', { heartbeat_interval_seconds: 30 });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('Heartbeat');
    }
  });

  it('throws 400 for heartbeat above maximum (86400)', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });

    try {
      await updatePlatform('bot-1', 'user-1', 'conn-1', { heartbeat_interval_seconds: 100000 });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(400);
    }
  });

  it('does nothing when updates object is empty', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });

    await updatePlatform('bot-1', 'user-1', 'conn-1', {});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws 404 when platform connection not found', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    try {
      await updatePlatform('bot-1', 'user-1', 'conn-1', { status: 'paused' });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.statusCode).toBe(404);
    }
  });
});

// ── updatePlatformCycleStatus ──────────────────────────────────────────────

describe('updatePlatformCycleStatus', () => {
  it('updates cycle status without notification on success', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updatePlatformCycleStatus('conn-1', 'active');
    expect(mockQuery.mock.calls[0][0]).toContain('cycle_count = cycle_count + 1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['active', null, 'conn-1']);
    expect(mockNotifyPlatformError).not.toHaveBeenCalled();
  });

  it('notifies user when paused with error', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // platform info lookup
    mockQueryOne.mockResolvedValueOnce({ bot_id: 'bot-1', platform_name: 'discord' });
    // bot info lookup
    mockQueryOne.mockResolvedValueOnce({ user_id: 'user-1', name: 'TestBot' });

    await updatePlatformCycleStatus('conn-1', 'paused', 'Rate limit exceeded');
    expect(mockNotifyPlatformError).toHaveBeenCalledWith(
      'user-1', 'bot-1', 'TestBot', 'discord', 'Rate limit exceeded',
    );
  });

  it('does not notify when status is paused but no error message', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updatePlatformCycleStatus('conn-1', 'paused');
    expect(mockNotifyPlatformError).not.toHaveBeenCalled();
  });

  it('does not notify when status is active with error message', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updatePlatformCycleStatus('conn-1', 'active', 'Some warning');
    expect(mockNotifyPlatformError).not.toHaveBeenCalled();
  });
});

// ── getPlatformCredentials ─────────────────────────────────────────────────

describe('getPlatformCredentials', () => {
  it('returns decrypted credentials', async () => {
    mockQueryOne.mockResolvedValueOnce({
      credentials: Buffer.from('enc'),
      credentials_iv: Buffer.from('iv'),
      config: { heartbeat_interval: 3600 },
      adapter_type: 'discord',
      platform_name: 'discord',
    });

    const result = await getPlatformCredentials('conn-1');
    expect(result).toEqual({
      apiKey: 'decrypted-key',
      config: { heartbeat_interval: 3600 },
      adapterType: 'discord',
      platformName: 'discord',
    });
  });

  it('returns null when no credentials found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await getPlatformCredentials('conn-1');
    expect(result).toBeNull();
  });
});

// ── getActivePlatforms ─────────────────────────────────────────────────────

describe('getActivePlatforms', () => {
  it('returns active platform connections for a bot', async () => {
    const platforms = [
      { id: 'conn-1', platform_name: 'discord', adapter_type: 'discord', heartbeat_interval_seconds: 3600, last_cycle_at: null },
    ];
    mockQueryRows.mockResolvedValueOnce(platforms);

    const result = await getActivePlatforms('bot-1');
    expect(result).toEqual(platforms);
    expect(mockQueryRows.mock.calls[0][0]).toContain("status = 'active'");
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['bot-1']);
  });

  it('returns empty array when no active platforms', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    const result = await getActivePlatforms('bot-1');
    expect(result).toEqual([]);
  });
});
