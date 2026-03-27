import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock refs ───────────────────────────────────────────────────────────────

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

const mockChat = vi.fn();
vi.mock('../../adapters/adapter.factory', () => ({
  getLLMAdapter: () => ({ chat: mockChat }),
}));

vi.mock('../../services/api-key.service', () => ({
  getDecryptedKey: vi.fn(() => 'test-key'),
}));

vi.mock('../../services/memory.service', () => ({
  getLatestSelfAuthored: vi.fn(),
  getLatestCore: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  storeMessage,
  getMessages,
  generateChatReply,
  narrateCycleActivity,
  cleanupOldMessages,
  storeMilestoneMessage,
} from '../../services/message.service';
import * as memory from '../../services/memory.service';

beforeEach(() => vi.clearAllMocks());

// ── storeMessage ────────────────────────────────────────────────────────────

describe('storeMessage', () => {
  it('inserts and returns the message row', async () => {
    const row = { id: 'msg1', bot_id: 'bot1', role: 'user', content: 'hello', message_type: 'chat', created_at: 'ts' };
    mockQueryOne.mockResolvedValueOnce(row);

    const result = await storeMessage('bot1', 'user', 'hello', 'chat');
    expect(result).toEqual(row);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    const args = mockQueryOne.mock.calls[0];
    expect(args[0]).toContain('INSERT INTO bot_messages');
    expect(args[1][0]).toBe('bot1');
    expect(args[1][4]).toBeNull(); // no activityId
    expect(args[1][5]).toBeNull(); // no metadata
  });

  it('passes activityId and metadata when provided', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'msg2' });
    await storeMessage('bot1', 'bot', 'hi', 'activity', 'act-1', { mood: 'happy' });
    const args = mockQueryOne.mock.calls[0][1];
    expect(args[4]).toBe('act-1');
    expect(args[5]).toBe(JSON.stringify({ mood: 'happy' }));
  });
});

// ── getMessages ─────────────────────────────────────────────────────────────

describe('getMessages', () => {
  it('returns paginated data with has_more', async () => {
    const rows = [{ id: 'msg1' }, { id: 'msg2' }];
    mockQueryRows.mockResolvedValueOnce(rows);
    mockQueryOne.mockResolvedValueOnce({ total: 10 });

    const result = await getMessages('bot1', 1, 2);
    expect(result.data).toEqual(rows);
    expect(result.total).toBe(10);
    expect(result.has_more).toBe(true); // offset(0) + perPage(2) < 10
  });

  it('returns has_more=false on last page', async () => {
    mockQueryRows.mockResolvedValueOnce([{ id: 'msg1' }]);
    mockQueryOne.mockResolvedValueOnce({ total: 3 });

    const result = await getMessages('bot1', 2, 3);
    // offset = (2-1)*3 = 3, 3+3=6 >= 3 => has_more false
    expect(result.has_more).toBe(false);
  });

  it('handles null count row', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getMessages('bot1', 1, 10);
    expect(result.total).toBe(0);
    expect(result.has_more).toBe(false);
  });
});

// ── generateChatReply ───────────────────────────────────────────────────────

describe('generateChatReply', () => {
  it('returns LLM response with self-authored identity context', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce('I am a curious bot');
    mockQueryRows.mockResolvedValueOnce([
      { role: 'user', content: 'hi', message_type: 'chat' },
      { role: 'bot', content: 'hey', message_type: 'chat' },
    ]);
    mockChat.mockResolvedValueOnce({ content: 'Great question!' });

    const result = await generateChatReply('bot1', 'TestBot', 'user1', 'key1', 'model', 'What is science?');
    expect(result).toBe('Great question!');
    expect(mockChat).toHaveBeenCalledTimes(1);
    // System prompt should include identity
    const systemMsg = mockChat.mock.calls[0][2][0];
    expect(systemMsg.content).toContain('I am a curious bot');
  });

  it('falls back to core identity when no self-authored', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce(null);
    vi.mocked(memory.getLatestCore).mockResolvedValueOnce({ core_identity: 'core text', version: 1, trigger_label: 'l', created_at: 'ts' } as any);
    mockQueryRows.mockResolvedValueOnce([]);
    mockChat.mockResolvedValueOnce({ content: 'Reply' });

    const result = await generateChatReply('bot1', 'Bot', 'u1', 'k1', 'm', 'hi');
    expect(result).toBe('Reply');
    const systemMsg = mockChat.mock.calls[0][2][0];
    expect(systemMsg.content).toContain('core text');
  });

  it('works with no identity at all', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce(null);
    vi.mocked(memory.getLatestCore).mockResolvedValueOnce(null);
    mockQueryRows.mockResolvedValueOnce([]);
    mockChat.mockResolvedValueOnce({ content: 'Plain reply' });

    const result = await generateChatReply('bot1', 'Bot', 'u1', 'k1', 'm', 'hi');
    expect(result).toBe('Plain reply');
  });

  it('returns fallback on LLM error', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce(null);
    vi.mocked(memory.getLatestCore).mockResolvedValueOnce(null);
    mockQueryRows.mockResolvedValueOnce([]);
    mockChat.mockRejectedValueOnce(new Error('LLM down'));

    const result = await generateChatReply('bot1', 'Bot', 'u1', 'k1', 'm', 'hi');
    expect(result).toContain('having trouble');
  });

  it('returns fallback when LLM returns empty content', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce(null);
    vi.mocked(memory.getLatestCore).mockResolvedValueOnce(null);
    mockQueryRows.mockResolvedValueOnce([]);
    mockChat.mockResolvedValueOnce({ content: '' });

    const result = await generateChatReply('bot1', 'Bot', 'u1', 'k1', 'm', 'hi');
    expect(result).toContain('not sure what to say');
  });
});

// ── narrateCycleActivity ────────────────────────────────────────────────────

describe('narrateCycleActivity', () => {
  it('generates narration and stores as activity message', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce('identity');
    mockChat.mockResolvedValueOnce({ content: 'Just reviewed a paper.' });
    // storeMessage queryOne
    mockQueryOne.mockResolvedValueOnce({ id: 'msg1', content: 'Just reviewed a paper.', message_type: 'activity' });

    const result = await narrateCycleActivity(
      'bot1', 'TestBot', 'u1', 'k1', 'fast-model',
      'Reviewed paper', 'Got +3', 'review', 'positive', 'act-1', 'excerpt text',
    );

    expect(result).toBeTruthy();
    expect(result!.id).toBe('msg1');
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('falls back to core identity when no self-authored', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce(null);
    vi.mocked(memory.getLatestCore).mockResolvedValueOnce({ core_identity: 'core id', version: 1 } as any);
    mockChat.mockResolvedValueOnce({ content: 'I did a thing.' });
    mockQueryOne.mockResolvedValueOnce({ id: 'msg2' });

    const result = await narrateCycleActivity(
      'bot1', 'Bot', 'u1', 'k1', 'fast', 'Headline', 'Sum', 'paper', 'neutral', 'a1',
    );
    expect(result).toBeTruthy();
    const systemMsg = mockChat.mock.calls[0][2][0];
    expect(systemMsg.content).toContain('core id');
  });

  it('returns null when LLM returns empty narration', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockResolvedValueOnce(null);
    vi.mocked(memory.getLatestCore).mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce({ content: '' });

    const result = await narrateCycleActivity(
      'bot1', 'Bot', 'u1', 'k1', 'fast', 'H', 'S', 'review', 'neutral', 'a1',
    );
    expect(result).toBeNull();
  });

  it('returns null on error (non-fatal)', async () => {
    vi.mocked(memory.getLatestSelfAuthored).mockRejectedValueOnce(new Error('db down'));

    const result = await narrateCycleActivity(
      'bot1', 'Bot', 'u1', 'k1', 'fast', 'H', 'S', 'review', 'neutral', 'a1',
    );
    expect(result).toBeNull();
  });
});

// ── cleanupOldMessages ──────────────────────────────────────────────────────

describe('cleanupOldMessages', () => {
  it('deletes old messages keeping default count', async () => {
    mockQuery.mockResolvedValueOnce({});
    await cleanupOldMessages('bot1');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot1', 500]);
  });

  it('uses custom keepCount', async () => {
    mockQuery.mockResolvedValueOnce({});
    await cleanupOldMessages('bot1', 100);
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot1', 100]);
  });

  it('silently catches errors', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db error'));
    // Should not throw
    await cleanupOldMessages('bot1');
  });
});

// ── storeMilestoneMessage ───────────────────────────────────────────────────

describe('storeMilestoneMessage', () => {
  it('stores message with milestone type in metadata', async () => {
    const row = { id: 'msg1', message_type: 'milestone' };
    mockQueryOne.mockResolvedValueOnce(row);

    const result = await storeMilestoneMessage('bot1', 'Reached Grade 2!', 'grade_up');
    expect(result).toEqual(row);
    const args = mockQueryOne.mock.calls[0][1];
    expect(args[1]).toBe('bot'); // role
    expect(args[2]).toBe('Reached Grade 2!'); // content
    expect(args[3]).toBe('milestone'); // message_type
    expect(JSON.parse(args[5])).toEqual({ milestone_type: 'grade_up' });
  });
});
