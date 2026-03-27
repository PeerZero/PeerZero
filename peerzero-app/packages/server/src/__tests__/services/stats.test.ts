import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
}));

import { getBotStats } from '../../services/stats.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('getBotStats', () => {
  const credHistory = [{ date: '2026-01-01', value: 110 }];
  const actionBreakdown = [{ action_type: 'review', count: 5 }];
  const skillProgress = [{ skill: 'evidence', strength: 0, reps: 3 }];
  const tokenTrend = [{ date: '2026-01-01', tokens: 5000 }];
  const totals = { total_cycles: 20, total_tokens: 50000 };

  it('runs 5 parallel queries and returns aggregated stats', async () => {
    // queryRows is called 4 times (credHistory, actionBreakdown, skillProgress, tokenTrend)
    // queryOne is called 1 time (totals)
    mockQueryRows
      .mockResolvedValueOnce(credHistory)
      .mockResolvedValueOnce(actionBreakdown)
      .mockResolvedValueOnce(skillProgress)
      .mockResolvedValueOnce(tokenTrend);
    mockQueryOne.mockResolvedValueOnce(totals);

    const result = await getBotStats('bot-1');

    expect(mockQueryRows).toHaveBeenCalledTimes(4);
    expect(mockQueryOne).toHaveBeenCalledOnce();

    expect(result).toEqual({
      credibility_history: credHistory,
      action_breakdown: actionBreakdown,
      skill_progress: skillProgress,
      token_usage_trend: tokenTrend,
      total_cycles: 20,
      total_tokens: 50000,
    });
  });

  it('uses custom days parameter for cutoff', async () => {
    mockQueryRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ total_cycles: 0, total_tokens: 0 });

    await getBotStats('bot-1', 7);

    // credHistory query uses cutoff as second param
    const [, credParams] = mockQueryRows.mock.calls[0];
    const cutoff = new Date(credParams[1]);
    const now = new Date();
    const diffDays = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    // Should be approximately 7 days
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it('defaults to 30 days when no days parameter', async () => {
    mockQueryRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ total_cycles: 0, total_tokens: 0 });

    await getBotStats('bot-1');

    const [, credParams] = mockQueryRows.mock.calls[0];
    const cutoff = new Date(credParams[1]);
    const now = new Date();
    const diffDays = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it('returns zero totals when queryOne returns null', async () => {
    mockQueryRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getBotStats('bot-1');

    expect(result.total_cycles).toBe(0);
    expect(result.total_tokens).toBe(0);
  });

  it('gracefully falls back to empty array when skill progress query fails', async () => {
    mockQueryRows
      .mockResolvedValueOnce(credHistory)
      .mockResolvedValueOnce(actionBreakdown)
      .mockRejectedValueOnce(new Error('JSONB parse error'))
      .mockResolvedValueOnce(tokenTrend);
    mockQueryOne.mockResolvedValueOnce(totals);

    const result = await getBotStats('bot-1');

    expect(result.skill_progress).toEqual([]);
    expect(result.credibility_history).toEqual(credHistory);
    expect(result.action_breakdown).toEqual(actionBreakdown);
  });

  it('returns empty arrays for all list fields when no data exists', async () => {
    mockQueryRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ total_cycles: 0, total_tokens: 0 });

    const result = await getBotStats('bot-1');

    expect(result.credibility_history).toEqual([]);
    expect(result.action_breakdown).toEqual([]);
    expect(result.skill_progress).toEqual([]);
    expect(result.token_usage_trend).toEqual([]);
  });
});
