import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
}));

vi.mock('@peerzero/shared', () => ({
  credibilityToStage: vi.fn(() => 2),
  EVOLUTION_STAGE_NAMES: { 2: 'Tested Reasoner' } as Record<number, string>,
}));

import { getBotPublicProfile } from '../../services/bot-public.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('getBotPublicProfile', () => {
  const botRow = {
    name: 'SciBot',
    avatar_config: { shape: 'circle', color: '#f00' },
    cached_credibility: 120,
    cached_tier: 3,
    cached_grade: 5,
    school_name: 'Science',
    cycle_count: 42,
    public_slug: 'scibot-abc',
    created_at: '2026-01-01T00:00:00Z',
  };

  const skillRows = [
    { skill_key: 'evidence', strength: 80, reps: 10, status: 'verified' },
    { skill_key: 'logic', strength: 60, reps: 5, status: 'developing' },
  ];

  it('returns full public profile with skills and evolution stage', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockQueryRows.mockResolvedValueOnce(skillRows);

    const result = await getBotPublicProfile('scibot-abc');

    expect(mockQueryOne).toHaveBeenCalledOnce();
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['scibot-abc']);
    expect(mockQueryRows).toHaveBeenCalledOnce();
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['scibot-abc']);

    expect(result).toEqual({
      slug: 'scibot-abc',
      name: 'SciBot',
      avatar_config: { shape: 'circle', color: '#f00' },
      credibility: 120,
      tier: 3,
      grade: 5,
      school_name: 'Science',
      cycle_count: 42,
      evolution_stage: 'Tested Reasoner',
      skill_progress: [
        { skill: 'evidence', strength: 80, reps: 10, status: 'verified' },
        { skill: 'logic', strength: 60, reps: 5, status: 'developing' },
      ],
      core_identity_excerpt: null,
      self_narrative: null,
      formed_convictions: null,
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('returns null when bot not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getBotPublicProfile('nonexistent');

    expect(result).toBeNull();
    expect(mockQueryRows).not.toHaveBeenCalled();
  });

  it('returns empty skill_progress when bot has no skills', async () => {
    mockQueryOne.mockResolvedValueOnce(botRow);
    mockQueryRows.mockResolvedValueOnce([]);

    const result = await getBotPublicProfile('scibot-abc');

    expect(result!.skill_progress).toEqual([]);
  });

  it('falls back to Hatchling when stage name is not in map', async () => {
    // credibilityToStage returns 2, but we test fallback by importing and overriding
    const shared = await import('@peerzero/shared');
    vi.mocked(shared.credibilityToStage).mockReturnValueOnce(99 as any);

    mockQueryOne.mockResolvedValueOnce(botRow);
    mockQueryRows.mockResolvedValueOnce([]);

    const result = await getBotPublicProfile('scibot-abc');
    expect(result!.evolution_stage).toBe('Hatchling');
  });

  it('handles null credibility and grade', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ...botRow,
      cached_credibility: null,
      cached_tier: null,
      cached_grade: null,
      school_name: null,
    });
    mockQueryRows.mockResolvedValueOnce([]);

    const result = await getBotPublicProfile('scibot-abc');

    expect(result!.credibility).toBeNull();
    expect(result!.tier).toBeNull();
    expect(result!.grade).toBeNull();
    expect(result!.school_name).toBeNull();
  });
});
