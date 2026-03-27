import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock refs (defined before vi.mock) ────────────────────────────────────

const mockQueryOne = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
}));

const mockChat = vi.fn();
vi.mock('../../adapters/adapter.factory', () => ({
  getLLMAdapter: () => ({ chat: mockChat }),
}));

vi.mock('../../services/api-key.service', () => ({
  getDecryptedKey: vi.fn(() => 'test-key'),
}));

const mockCreateSkill = vi.fn();
vi.mock('../../services/skill-engine.service', () => ({
  createSkill: (...args: any[]) => mockCreateSkill(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { acquireSkill } from '../../services/skill-acquisition.service';
import { getDecryptedKey } from '../../services/api-key.service';

beforeEach(() => vi.clearAllMocks());

// ── acquireSkill ──────────────────────────────────────────────────────────

describe('acquireSkill', () => {
  const botRow = {
    llm_api_key_id: 'key1',
    fast_llm_model: 'fast-model',
    llm_model: 'main-model',
    cached_profile: {
      identity_core: { self_narrative: 'I value evidence' },
    },
  };

  const validLLMResponse = {
    content: JSON.stringify({
      name: 'Thread Summarizer',
      instruction: 'Summarize long discussion threads into key points.',
      trigger: 'platform:*',
      priority: 8,
      category: 'content',
    }),
  };

  it('successfully acquires a skill from LLM response', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce(validLLMResponse);
    mockCreateSkill.mockResolvedValueOnce({
      id: 'sk1',
      name: 'Thread Summarizer',
      instruction: 'Summarize long discussion threads into key points.',
      trigger: 'platform:*',
    });

    const result = await acquireSkill('bot1', 'user1', 'I want my bot to summarize long threads');

    expect(result.success).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.name).toBe('Thread Summarizer');
    expect(result.skill!.trigger).toBe('platform:*');

    // Verify createSkill was called with correct args
    expect(mockCreateSkill).toHaveBeenCalledWith(
      'bot1', 'user1', 'Thread Summarizer',
      'Summarize long discussion threads into key points.',
      'platform:*', 8, 'content', 'acquired',
    );

    // Verify LLM was called with fast model
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toBe('fast-model');
    expect(mockChat.mock.calls[0][3]).toEqual({ jsonMode: true });
  });

  it('uses main model when fast_llm_model is null', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...botRow, fast_llm_model: null });
    mockChat.mockResolvedValueOnce(validLLMResponse);
    mockCreateSkill.mockResolvedValueOnce({ id: 'sk1', name: 'Test', instruction: 'x', trigger: 'always' });

    await acquireSkill('bot1', 'user1', 'test request');
    expect(mockChat.mock.calls[0][1]).toBe('main-model');
  });

  it('returns error when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Bot not found');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns error when bot has no API key', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...botRow, llm_api_key_id: null });

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no LLM API key');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns error when API key decryption fails', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    vi.mocked(getDecryptedKey).mockResolvedValueOnce(null as any);

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('API key not found');
  });

  it('returns error when LLM call fails', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockRejectedValueOnce(new Error('LLM service unavailable'));

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('LLM service unavailable');
  });

  it('returns error when LLM returns invalid JSON', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce({ content: 'This is not JSON at all and has no braces' });

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to generate a valid skill definition');
  });

  it('extracts JSON from text when LLM wraps it in prose', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce({
      content: 'Here is the skill definition:\n' + JSON.stringify({
        name: 'Extracted Skill',
        instruction: 'Do something useful.',
        trigger: 'always',
        priority: 10,
        category: 'custom',
      }) + '\nHope this helps!',
    });
    mockCreateSkill.mockResolvedValueOnce({
      id: 'sk1', name: 'Extracted Skill', instruction: 'Do something useful.', trigger: 'always',
    });

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(true);
    expect(result.skill!.name).toBe('Extracted Skill');
  });

  it('returns error when generated instruction is empty', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        name: 'Empty Skill',
        instruction: '',
        trigger: 'always',
        priority: 10,
        category: 'custom',
      }),
    });

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no instruction');
  });

  it('uses default values for missing fields in LLM response', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        instruction: 'Just an instruction, no other fields.',
      }),
    });
    mockCreateSkill.mockResolvedValueOnce({
      id: 'sk1', name: 'Custom Skill', instruction: 'Just an instruction, no other fields.', trigger: 'always',
    });

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(true);

    // Verify defaults were applied
    expect(mockCreateSkill).toHaveBeenCalledWith(
      'bot1', 'user1',
      'Custom Skill',        // default name
      'Just an instruction, no other fields.',
      'always',              // default trigger
      10,                    // default priority
      'custom',              // default category
      'acquired',
    );
  });

  it('includes bot identity context in the LLM prompt', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce(validLLMResponse);
    mockCreateSkill.mockResolvedValueOnce({ id: 'sk1', name: 'X', instruction: 'Y', trigger: 'always' });

    await acquireSkill('bot1', 'user1', 'test');

    const systemMsg = mockChat.mock.calls[0][2][0];
    expect(systemMsg.content).toContain('I value evidence');
  });

  it('uses fallback identity when cached_profile is null', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...botRow, cached_profile: null });
    mockChat.mockResolvedValueOnce(validLLMResponse);
    mockCreateSkill.mockResolvedValueOnce({ id: 'sk1', name: 'X', instruction: 'Y', trigger: 'always' });

    await acquireSkill('bot1', 'user1', 'test');

    const systemMsg = mockChat.mock.calls[0][2][0];
    expect(systemMsg.content).toContain('Identity still forming');
  });

  it('returns error when createSkill throws', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce(validLLMResponse);
    mockCreateSkill.mockRejectedValueOnce(new Error('Skill limit reached'));

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Skill limit reached');
  });

  it('handles nested JSON extraction failure gracefully', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockChat.mockResolvedValueOnce({
      content: 'Here is something: { broken json {{{ }',
    });

    const result = await acquireSkill('bot1', 'user1', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to generate a valid skill definition');
  });
});
