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

const mockChat = vi.fn();
vi.mock('../../adapters/adapter.factory', () => ({
  getLLMAdapter: vi.fn(() => ({ chat: mockChat })),
}));

const mockGetDecryptedKey = vi.fn();
vi.mock('../../services/api-key.service', () => ({
  getDecryptedKey: (...args: any[]) => mockGetDecryptedKey(...args),
}));

const mockGetLatestCore = vi.fn();
vi.mock('../../services/memory.service', () => ({
  getLatestCore: (...args: any[]) => mockGetLatestCore(...args),
}));

import {
  generateBotVoicedMessage,
  generateDialogue,
  invalidateDialogueCache,
  DIALOGUE_CONTEXTS,
} from '../../services/bot-voice.service';

// ── Helpers ─────────────────────────────────────────────────────────────────

const baseCtx = {
  botId: 'bot-1',
  botName: 'TestBot',
  userId: 'user-1',
  llmApiKeyId: 'key-1',
  llmModel: 'claude-haiku-4-5-20251001',
  selfAuthoredBlock: null as string | null,
};

const baseEvent = {
  type: 'tier_upgrade',
  description: 'Evolved to Companion tier!',
  details: { newTier: 100 },
};

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

// ── DIALOGUE_CONTEXTS ──────────────────────────────────────────────────────

describe('DIALOGUE_CONTEXTS', () => {
  it('is an array of valid context strings', () => {
    expect(Array.isArray(DIALOGUE_CONTEXTS)).toBe(true);
    expect(DIALOGUE_CONTEXTS.length).toBeGreaterThan(10);
    expect(DIALOGUE_CONTEXTS).toContain('just_hatched');
    expect(DIALOGUE_CONTEXTS).toContain('graduation');
    expect(DIALOGUE_CONTEXTS).toContain('error');
    expect(DIALOGUE_CONTEXTS).toContain('luminary');
  });
});

// ── generateBotVoicedMessage ───────────────────────────────────────────────

describe('generateBotVoicedMessage', () => {
  it('generates a message using LLM and caches it', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: 'I feel myself growing.' });
    // cacheBotVoice: insert
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // cacheBotVoice: cleanup
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('I feel myself growing.');
    expect(mockGetDecryptedKey).toHaveBeenCalledWith('key-1', 'user-1');
    expect(mockChat).toHaveBeenCalledOnce();
    // Verify cache was written
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO bot_voice_cache');
  });

  it('uses selfAuthoredBlock for identity when available', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: 'My identity shapes me.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const ctxWithIdentity = {
      ...baseCtx,
      selfAuthoredBlock: 'I am a curious researcher who values evidence.',
    };

    const result = await generateBotVoicedMessage(ctxWithIdentity, baseEvent);
    expect(result).toBe('My identity shapes me.');
    // Should include identity in system prompt
    const systemPrompt = mockChat.mock.calls[0][2][0].content;
    expect(systemPrompt).toContain('sense of self');
    expect(systemPrompt).toContain('curious researcher');
    // Should NOT call getLatestCore since selfAuthoredBlock is present
    expect(mockGetLatestCore).not.toHaveBeenCalled();
  });

  it('falls back to core identity when selfAuthoredBlock is null', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce({
      core_identity: 'A methodical thinker who questions assumptions.',
    });
    mockChat.mockResolvedValueOnce({ content: 'This is a big step.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('This is a big step.');
    expect(mockGetLatestCore).toHaveBeenCalledWith('bot-1');
    const systemPrompt = mockChat.mock.calls[0][2][0].content;
    expect(systemPrompt).toContain('methodical thinker');
  });

  it('works without any identity context', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce(null); // no core identity
    mockChat.mockResolvedValueOnce({ content: 'Something happened!' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('Something happened!');
    const systemPrompt = mockChat.mock.calls[0][2][0].content;
    expect(systemPrompt).not.toContain('sense of self');
  });

  it('returns fallback message when LLM returns empty content', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: '' });

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('TestBot: Evolved to Companion tier!');
  });

  it('returns fallback message when LLM content exceeds 300 chars', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: 'x'.repeat(301) });

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('TestBot: Evolved to Companion tier!');
  });

  it('returns fallback on LLM error', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockRejectedValueOnce(new Error('LLM API down'));

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('TestBot: Evolved to Companion tier!');
  });

  it('returns fallback when getDecryptedKey throws', async () => {
    mockGetDecryptedKey.mockRejectedValueOnce(new Error('Key not found'));

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('TestBot: Evolved to Companion tier!');
  });

  it('returns fallback when LLM returns null content', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: null });

    const result = await generateBotVoicedMessage(baseCtx, baseEvent);
    expect(result).toBe('TestBot: Evolved to Companion tier!');
  });

  it('passes correct LLM options (maxTokens, temperature)', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: 'Short message.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    await generateBotVoicedMessage(baseCtx, baseEvent);
    const llmOpts = mockChat.mock.calls[0][3];
    expect(llmOpts.maxTokens).toBe(100);
    expect(llmOpts.temperature).toBe(0.8);
  });

  it('truncates selfAuthoredBlock to 500 chars', async () => {
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: 'Thoughtful.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const longIdentity = 'A'.repeat(600);
    const ctxWithLong = { ...baseCtx, selfAuthoredBlock: longIdentity };

    await generateBotVoicedMessage(ctxWithLong, baseEvent);
    const systemPrompt = mockChat.mock.calls[0][2][0].content;
    // Should be truncated — the full 600 chars should not appear
    expect(systemPrompt).not.toContain('A'.repeat(600));
    expect(systemPrompt).toContain('A'.repeat(500));
  });
});

// ── generateDialogue ───────────────────────────────────────────────────────

describe('generateDialogue', () => {
  it('returns cached dialogue when available', async () => {
    mockQueryOne.mockResolvedValueOnce({ bot_message: 'Cached dialogue here.' });

    const result = await generateDialogue(baseCtx, 'just_hatched');
    expect(result).toBe('Cached dialogue here.');
    // Should NOT call LLM
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('generates dialogue via LLM when no cache exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // no cache
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce({ content: 'I just came into being.' });
    // cacheDialogue: delete old
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    // cacheDialogue: insert new
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateDialogue(baseCtx, 'just_hatched');
    expect(result).toBe('I just came into being.');
    expect(mockChat).toHaveBeenCalledOnce();
    // Verify the situation description was passed
    const userPrompt = mockChat.mock.calls[0][2][1].content;
    expect(userPrompt).toContain('exist for the first time');
  });

  it('uses selfAuthoredBlock in dialogue generation', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockResolvedValueOnce({ content: 'I know who I am now.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const ctxWithIdentity = {
      ...baseCtx,
      selfAuthoredBlock: 'I believe in rigorous methodology.',
    };

    const result = await generateDialogue(ctxWithIdentity, 'running_identity');
    expect(result).toBe('I know who I am now.');
    const systemPrompt = mockChat.mock.calls[0][2][0].content;
    expect(systemPrompt).toContain('rigorous methodology');
    expect(mockGetLatestCore).not.toHaveBeenCalled();
  });

  it('falls back to core identity when no selfAuthoredBlock', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce({
      core_identity: 'I value precision above all.',
    });
    mockChat.mockResolvedValueOnce({ content: 'Learning continues.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateDialogue(baseCtx, 'running_growing');
    expect(result).toBe('Learning continues.');
    const systemPrompt = mockChat.mock.calls[0][2][0].content;
    expect(systemPrompt).toContain('precision above all');
  });

  it('returns fallback when LLM fails for just_hatched context', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockRejectedValueOnce(new Error('LLM down'));

    const result = await generateDialogue(baseCtx, 'just_hatched');
    expect(result).toBe('...');
  });

  it('returns fallback for error context when LLM fails', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockRejectedValueOnce(new Error('LLM down'));

    const result = await generateDialogue(baseCtx, 'error');
    expect(result).toBe('Something is wrong. I need help.');
  });

  it('returns fallback for pre_enrollment context when LLM fails', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockRejectedValueOnce(new Error('LLM down'));

    const result = await generateDialogue(baseCtx, 'pre_enrollment');
    expect(result).toBe('I need to go to school.');
  });

  it('returns empty string fallback for context without custom fallback', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockChat.mockRejectedValueOnce(new Error('LLM down'));

    const result = await generateDialogue(baseCtx, 'running_learning');
    expect(result).toBe('');
  });

  it('returns fallback when LLM returns content over 500 chars', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce({ content: 'x'.repeat(501) });

    const result = await generateDialogue(baseCtx, 'just_hatched');
    expect(result).toBe('...');
  });

  it('returns fallback when LLM returns empty content', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce({ content: '' });

    const result = await generateDialogue(baseCtx, 'pre_enrollment');
    expect(result).toBe('I need to go to school.');
  });

  it('passes correct LLM options for dialogue (maxTokens 120, temp 0.9)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce({ content: 'Valid dialogue.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await generateDialogue(baseCtx, 'running_early');
    const llmOpts = mockChat.mock.calls[0][3];
    expect(llmOpts.maxTokens).toBe(120);
    expect(llmOpts.temperature).toBe(0.9);
  });

  it('caches generated dialogue (delete old + insert new)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockGetDecryptedKey.mockResolvedValueOnce('sk-test-key');
    mockGetLatestCore.mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce({ content: 'Fresh dialogue.' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // delete
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // insert

    await generateDialogue(baseCtx, 'first_cycle');
    // First query should be delete, second should be insert
    expect(mockQuery.mock.calls[0][0]).toContain('DELETE FROM bot_voice_cache');
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO bot_voice_cache');
    expect(mockQuery.mock.calls[1][1]).toContain('dialogue:first_cycle');
  });
});

// ── invalidateDialogueCache ────────────────────────────────────────────────

describe('invalidateDialogueCache', () => {
  it('deletes dialogue cache entries for a bot', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 });

    await invalidateDialogueCache('bot-1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM bot_voice_cache'),
      ['bot-1'],
    );
    expect(mockQuery.mock.calls[0][0]).toContain("dialogue:%");
  });

  it('does not throw when deletion fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    // Should NOT throw
    await expect(invalidateDialogueCache('bot-1')).resolves.toBeUndefined();
  });
});
