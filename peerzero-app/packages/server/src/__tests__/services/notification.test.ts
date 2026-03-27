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

const mockStoreMilestoneMessage = vi.fn();
vi.mock('../../services/message.service', () => ({
  storeMilestoneMessage: (...args: any[]) => mockStoreMilestoneMessage(...args),
}));

const mockBroadcastMessage = vi.fn();
vi.mock('../../websocket/activity-stream', () => ({
  broadcastMessage: (...args: any[]) => mockBroadcastMessage(...args),
}));

// Mock dynamic import of bot-voice.service
const mockGenerateBotVoicedMessage = vi.fn();
vi.mock('../../services/bot-voice.service', () => ({
  generateBotVoicedMessage: (...args: any[]) => mockGenerateBotVoicedMessage(...args),
}));

// Mock global fetch for Expo Push API
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  registerPushToken,
  removePushToken,
  getUserPushTokens,
  getNotificationPrefs,
  updateNotificationPrefs,
  sendNotification,
  checkAndNotifyMilestones,
  notifyBotError,
  notifyGradePaymentNeeded,
  notifyBotStopped,
  notifyPlatformConnected,
  notifyPlatformError,
} from '../../services/notification.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

// ── registerPushToken ──────────────────────────────────────────────────────

describe('registerPushToken', () => {
  it('registers a valid ExponentPushToken', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await registerPushToken('user-1', 'ExponentPushToken[abc123]');
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO push_tokens');
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'ExponentPushToken[abc123]', null]);
  });

  it('registers a valid ExpoPushToken', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await registerPushToken('user-1', 'ExpoPushToken[xyz789]', 'iPhone');
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'ExpoPushToken[xyz789]', 'iPhone']);
  });

  it('throws for invalid token format', async () => {
    await expect(registerPushToken('user-1', 'invalid-token'))
      .rejects.toThrow('Invalid push token format');
  });

  it('throws for empty token', async () => {
    await expect(registerPushToken('user-1', ''))
      .rejects.toThrow('Invalid push token format');
  });
});

// ── removePushToken ────────────────────────────────────────────────────────

describe('removePushToken', () => {
  it('deletes the token', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await removePushToken('ExponentPushToken[abc123]');
    expect(mockQuery.mock.calls[0][0]).toContain('DELETE FROM push_tokens');
    expect(mockQuery.mock.calls[0][1]).toEqual(['ExponentPushToken[abc123]']);
  });
});

// ── getUserPushTokens ──────────────────────────────────────────────────────

describe('getUserPushTokens', () => {
  it('returns token strings for user', async () => {
    mockQueryRows.mockResolvedValueOnce([
      { token: 'ExponentPushToken[aaa]' },
      { token: 'ExponentPushToken[bbb]' },
    ]);

    const result = await getUserPushTokens('user-1');
    expect(result).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
  });

  it('returns empty array when user has no tokens', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    const result = await getUserPushTokens('user-1');
    expect(result).toEqual([]);
  });
});

// ── getNotificationPrefs ───────────────────────────────────────────────────

describe('getNotificationPrefs', () => {
  it('returns preferences for user', async () => {
    mockQueryOne.mockResolvedValueOnce({
      preferences: { tier_upgrade: true, bot_error: false },
    });

    const result = await getNotificationPrefs('user-1');
    expect(result).toEqual({ tier_upgrade: true, bot_error: false });
  });

  it('returns empty object when no preferences set', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await getNotificationPrefs('user-1');
    expect(result).toEqual({});
  });
});

// ── updateNotificationPrefs ────────────────────────────────────────────────

describe('updateNotificationPrefs', () => {
  it('merges updates with existing preferences', async () => {
    // getNotificationPrefs call (internally)
    mockQueryOne.mockResolvedValueOnce({
      preferences: { tier_upgrade: true, bot_error: false },
    });
    // upsert
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await updateNotificationPrefs('user-1', { bot_error: true, grade_promotion: false });
    expect(result).toEqual({
      tier_upgrade: true,
      bot_error: true,
      grade_promotion: false,
    });
  });

  it('creates new preferences when none exist', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // no existing prefs
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await updateNotificationPrefs('user-1', { tier_upgrade: false });
    expect(result).toEqual({ tier_upgrade: false });
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT');
  });
});

// ── sendNotification ───────────────────────────────────────────────────────

describe('sendNotification', () => {
  it('sends push notification via Expo API', async () => {
    // prefs check
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    // tokens
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    // Expo API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await sendNotification('user-1', 'tier_upgrade' as any, 'Title', 'Body', { foo: 'bar' });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('exp.host');
    const body = JSON.parse(opts.body);
    expect(body[0].to).toBe('ExponentPushToken[aaa]');
    expect(body[0].title).toBe('Title');
    expect(body[0].body).toBe('Body');
  });

  it('skips when user has disabled the notification type', async () => {
    mockQueryOne.mockResolvedValueOnce({
      preferences: { tier_upgrade: false },
    });

    await sendNotification('user-1', 'tier_upgrade' as any, 'Title', 'Body');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when user has no push tokens', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([]);

    await sendNotification('user-1', 'tier_upgrade' as any, 'Title', 'Body');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('cleans up stale tokens (DeviceNotRegistered)', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([
      { token: 'ExponentPushToken[stale]' },
      { token: 'ExponentPushToken[good]' },
    ]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
          { status: 'ok' },
        ],
      }),
    });
    // removePushToken calls query
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await sendNotification('user-1', 'tier_upgrade' as any, 'Title', 'Body');
    expect(mockQuery.mock.calls[0][0]).toContain('DELETE FROM push_tokens');
  });

  it('handles Expo API error gracefully (does not throw)', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    // Should not throw
    await sendNotification('user-1', 'tier_upgrade' as any, 'Title', 'Body');
  });

  it('handles fetch failure gracefully (does not throw)', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await sendNotification('user-1', 'tier_upgrade' as any, 'Title', 'Body');
  });
});

// ── checkAndNotifyMilestones ───────────────────────────────────────────────

describe('checkAndNotifyMilestones', () => {
  it('detects tier upgrade and sends notification', async () => {
    // getNotificationPrefs (called within checkAndNotifyMilestones)
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    // storeMilestoneMessage
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'Evolved!' });
    // sendNotification -> getNotificationPrefs
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    // sendNotification -> getUserPushTokens
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    // Expo API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      50, 60,   // credibility
      2, 2,     // grade (no change)
      75, 100,  // tier upgrade
      'review', {},
    );

    expect(mockStoreMilestoneMessage).toHaveBeenCalledOnce();
    expect(mockBroadcastMessage).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('detects grade promotion', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'Promoted!' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      100, 110,
      3, 4,      // grade promotion
      75, 75,
      'paper', {},
    );

    expect(mockStoreMilestoneMessage).toHaveBeenCalledOnce();
  });

  it('detects credibility milestone', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'Hit 100!' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      95, 105,  // crosses 100 milestone
      2, 2,
      75, 75,
      'review', {},
    );

    expect(mockStoreMilestoneMessage).toHaveBeenCalledOnce();
  });

  it('detects bounty win', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'Won bounty!' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      100, 110,
      2, 2,
      75, 75,
      'bounty', { credibility_change: 10 },
    );

    expect(mockStoreMilestoneMessage).toHaveBeenCalledOnce();
  });

  it('detects first paper accepted', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'First paper!' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      0, 5,     // first credibility from 0
      1, 1,
      0, 0,
      'paper', {},
    );

    expect(mockStoreMilestoneMessage).toHaveBeenCalledOnce();
  });

  it('does nothing when no milestones detected', async () => {
    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      50, 55,   // no milestone crossed
      2, 2,     // no grade change
      75, 75,   // no tier change
      'review', {},
    );

    expect(mockStoreMilestoneMessage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when all milestone types are disabled in prefs', async () => {
    mockQueryOne.mockResolvedValueOnce({
      preferences: { tier_upgrade: false },
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      50, 55,
      2, 2,
      75, 100, // tier upgrade, but disabled in prefs
      'review', {},
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('batches multiple milestones into one notification', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'combo!' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      95, 105,    // credibility milestone
      3, 4,       // grade promotion
      75, 100,    // tier upgrade
      'review', {},
    );

    // Should send only ONE fetch call (batched)
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].data.batched).toBe(true);
  });

  it('uses bot-voiced message when voiceCtx is provided', async () => {
    mockGenerateBotVoicedMessage.mockResolvedValueOnce('I evolved! Amazing.');
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'I evolved!' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    const voiceCtx = {
      botId: 'bot-1', botName: 'TestBot', userId: 'user-1',
      llmApiKeyId: 'key-1', llmModel: 'claude-haiku-4-5-20251001',
      selfAuthoredBlock: null,
    };

    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      50, 60,
      2, 2,
      75, 100, // tier upgrade
      'review', {},
      voiceCtx,
    );

    expect(mockGenerateBotVoicedMessage).toHaveBeenCalledOnce();
    // The bot-voiced message should be used in the stored milestone
    expect(mockStoreMilestoneMessage.mock.calls[0][1]).toBe('I evolved! Amazing.');
  });

  it('falls back when bot voice generation fails', async () => {
    mockGenerateBotVoicedMessage.mockRejectedValueOnce(new Error('LLM down'));
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockResolvedValueOnce({ id: 'msg-1', text: 'fallback' });
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    const voiceCtx = {
      botId: 'bot-1', botName: 'TestBot', userId: 'user-1',
      llmApiKeyId: 'key-1', llmModel: 'claude-haiku-4-5-20251001',
      selfAuthoredBlock: null,
    };

    // Should NOT throw
    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      50, 60, 2, 2, 75, 100,
      'review', {},
      voiceCtx,
    );

    expect(mockStoreMilestoneMessage).toHaveBeenCalledOnce();
  });

  it('handles storeMilestoneMessage failure gracefully', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockStoreMilestoneMessage.mockRejectedValueOnce(new Error('DB down'));
    // sendNotification still runs
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    // Should NOT throw
    await checkAndNotifyMilestones(
      'user-1', 'bot-1', 'TestBot',
      50, 60, 2, 2, 75, 100,
      'review', {},
    );

    // sendNotification should still be attempted
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ── notifyBotError ─────────────────────────────────────────────────────────

describe('notifyBotError', () => {
  it('sends bot error notification with default message', async () => {
    // sendNotification -> getNotificationPrefs
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    // sendNotification -> getUserPushTokens
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await notifyBotError('user-1', 'bot-1', 'TestBot', 'API key invalid');
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].body).toContain('API key invalid');
  });

  it('uses bot-voiced message when voiceCtx provided', async () => {
    mockGenerateBotVoicedMessage.mockResolvedValueOnce('I hit a wall. Cannot continue.');
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    const voiceCtx = {
      botId: 'bot-1', botName: 'TestBot', userId: 'user-1',
      llmApiKeyId: 'key-1', llmModel: 'claude-haiku-4-5-20251001',
      selfAuthoredBlock: null,
    };

    await notifyBotError('user-1', 'bot-1', 'TestBot', 'Some error', voiceCtx);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].body).toBe('I hit a wall. Cannot continue.');
  });
});

// ── notifyGradePaymentNeeded ───────────────────────────────────────────────

describe('notifyGradePaymentNeeded', () => {
  it('sends grade payment notification with price', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await notifyGradePaymentNeeded('user-1', 'bot-1', 'TestBot', 5, 499);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].title).toContain('Grade 5');
    expect(body[0].body).toContain('$4.99');
  });
});

// ── notifyBotStopped ───────────────────────────────────────────────────────

describe('notifyBotStopped', () => {
  it('sends bot stopped notification', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await notifyBotStopped('user-1', 'bot-1', 'TestBot', 'Manually stopped');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].title).toContain('TestBot');
    expect(body[0].body).toBe('Manually stopped');
  });
});

// ── notifyPlatformConnected ────────────────────────────────────────────────

describe('notifyPlatformConnected', () => {
  it('sends platform connected notification', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await notifyPlatformConnected('user-1', 'bot-1', 'TestBot', 'Discord');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].title).toContain('Discord');
    expect(body[0].body).toContain('Discord');
  });
});

// ── notifyPlatformError ────────────────────────────────────────────────────

describe('notifyPlatformError', () => {
  it('sends platform error notification', async () => {
    mockQueryOne.mockResolvedValueOnce({ preferences: {} });
    mockQueryRows.mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await notifyPlatformError('user-1', 'bot-1', 'TestBot', 'Discord', 'Rate limited');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0].title).toContain('Discord');
    expect(body[0].body).toContain('Rate limited');
  });
});
