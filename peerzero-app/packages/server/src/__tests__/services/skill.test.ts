import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

const mockQueryRows = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

import { updateSkillSnapshots, getSkillSnapshots } from '../../services/skill.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('updateSkillSnapshots', () => {
  const skills = [
    { skill_key: 'evidence', strength: 80, reliability: 0.9, reps: 10, streak: 3, status: 'verified' },
    { skill_key: 'logic', strength: 60, reliability: 0.7, reps: 5, streak: 1, status: 'developing' },
  ];

  it('batch upserts all skills in a single query', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });

    await updateSkillSnapshots('bot-1', skills);

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO bot_skill_snapshots');
    expect(sql).toContain('ON CONFLICT');
    // 7 params per skill x 2 skills = 14
    expect(params).toHaveLength(14);
    expect(params[0]).toBe('bot-1');
    expect(params[1]).toBe('evidence');
    expect(params[7]).toBe('bot-1');
    expect(params[8]).toBe('logic');
  });

  it('returns early without querying when skills array is empty', async () => {
    await updateSkillSnapshots('bot-1', []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns early without querying when skills is null-ish', async () => {
    await updateSkillSnapshots('bot-1', null as any);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('handles a single skill', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updateSkillSnapshots('bot-1', [skills[0]]);

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toHaveLength(7);
    expect(params).toEqual(['bot-1', 'evidence', 80, 0.9, 10, 3, 'verified']);
  });
});

describe('getSkillSnapshots', () => {
  it('returns skill snapshot rows ordered by strength DESC', async () => {
    const rows = [
      { skill_key: 'evidence', strength: 80, reliability: 0.9, reps: 10, streak: 3, status: 'verified' },
      { skill_key: 'logic', strength: 60, reliability: 0.7, reps: 5, streak: 1, status: 'developing' },
    ];
    mockQueryRows.mockResolvedValueOnce(rows);

    const result = await getSkillSnapshots('bot-1');

    expect(mockQueryRows).toHaveBeenCalledOnce();
    const [sql, params] = mockQueryRows.mock.calls[0];
    expect(sql).toContain('ORDER BY strength DESC');
    expect(params).toEqual(['bot-1']);
    expect(result).toEqual(rows);
  });

  it('returns empty array when bot has no skill snapshots', async () => {
    mockQueryRows.mockResolvedValueOnce([]);

    const result = await getSkillSnapshots('bot-1');
    expect(result).toEqual([]);
  });
});
