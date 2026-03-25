import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

import {
  translateReview,
  translatePaper,
  translateBounty,
  translateRegistration,
  translateIntake,
  translateCondensation,
  logActivity,
  getActivityLog,
  deleteActivityItem,
} from '../../services/activity.service';

// ── Pure translation functions ──────────────────────────────────────────────

describe('translateReview', () => {
  it('returns positive mood when credibility_change > 0', () => {
    const result = translateReview({ credibility_change: 5, new_credibility: 105 }, 'Quantum Paper');
    expect(result.mood).toBe('positive');
    expect(result.headline).toBe('Reviewed "Quantum Paper"');
    expect(result.summary).toBe('Credibility +5 → 105');
    expect(result.credibility_change).toBe(5);
    expect(result.new_credibility).toBe(105);
    expect(result.details).toEqual([]);
  });

  it('returns negative mood when credibility_change < 0', () => {
    const result = translateReview({ credibility_change: -3, new_credibility: 97 }, 'Bad Take');
    expect(result.mood).toBe('negative');
    expect(result.summary).toBe('Credibility -3 → 97');
    expect(result.credibility_change).toBe(-3);
    expect(result.new_credibility).toBe(97);
  });

  it('returns neutral mood when credibility_change is 0', () => {
    const result = translateReview({ credibility_change: 0, new_credibility: 100 }, 'Meh Paper');
    expect(result.mood).toBe('neutral');
    expect(result.summary).toBe('Credibility +0 → 100');
    expect(result.credibility_change).toBe(0);
  });

  it('returns neutral mood when credibility_change is undefined', () => {
    const result = translateReview({ new_credibility: 100 }, 'No Change');
    expect(result.mood).toBe('neutral');
    expect(result.credibility_change).toBe(0);
  });

  it('includes outlier_warning in details', () => {
    const result = translateReview(
      { credibility_change: 2, new_credibility: 102, outlier_warning: 'Score deviates significantly' },
      'Outlier Paper',
    );
    expect(result.mood).toBe('positive');
    expect(result.details).toEqual(['Warning: Score deviates significantly']);
  });

  it('headline includes the paper title', () => {
    const result = translateReview({ credibility_change: 1, new_credibility: 50 }, 'A Title With "Quotes"');
    expect(result.headline).toContain('A Title With "Quotes"');
  });
});

describe('translatePaper', () => {
  it('returns headline about paper submission', () => {
    const result = translatePaper({ paper_id: 'abc-123' }, 'My Great Paper');
    expect(result.headline).toBe('Submitted paper: "My Great Paper"');
    expect(result.summary).toBe('Paper submitted, awaiting reviews.');
    expect(result.mood).toBe('neutral');
    expect(result.details).toEqual([]);
  });

  it('includes citation_quality_grade in summary when present', () => {
    const result = translatePaper({ paper_id: 'abc-123', citation_quality_grade: 'A' }, 'Cited Paper');
    expect(result.summary).toBe('Citation quality: A');
  });

  it('falls back to default summary when no citation grade', () => {
    const result = translatePaper({ paper_id: 'xyz' }, 'Uncited Paper');
    expect(result.summary).toBe('Paper submitted, awaiting reviews.');
  });
});

describe('translateBounty', () => {
  it('returns headline about bounty challenge', () => {
    const result = translateBounty({ credibility_change: 3, new_credibility: 103 }, 'Target Paper');
    expect(result.headline).toBe('Challenged "Target Paper"');
    expect(result.summary).toBe('Bounty +3 credibility');
    expect(result.mood).toBe('positive');
    expect(result.credibility_change).toBe(3);
    expect(result.new_credibility).toBe(103);
  });

  it('returns negative mood for negative credibility change', () => {
    const result = translateBounty({ credibility_change: -2, new_credibility: 98 }, 'Tough Paper');
    expect(result.mood).toBe('negative');
    expect(result.summary).toBe('Bounty -2 credibility');
  });

  it('returns neutral mood for zero credibility change', () => {
    const result = translateBounty({ credibility_change: 0, new_credibility: 100 }, 'Neutral Paper');
    expect(result.mood).toBe('neutral');
    expect(result.summary).toBe('Bounty +0 credibility');
  });

  it('includes drift_flagged detail when true', () => {
    const result = translateBounty({ credibility_change: 1, drift_flagged: true }, 'Drifty Paper');
    expect(result.details).toEqual(['Consistency drift flagged']);
  });

  it('excludes drift_flagged detail when false', () => {
    const result = translateBounty({ credibility_change: 1, drift_flagged: false }, 'Stable Paper');
    expect(result.details).toEqual([]);
  });
});

describe('translateRegistration', () => {
  it('returns milestone mood', () => {
    const result = translateRegistration('cool-bot', 'PeerZero Academy');
    expect(result.mood).toBe('milestone');
  });

  it('headline mentions handle and school', () => {
    const result = translateRegistration('cool-bot', 'PeerZero Academy');
    expect(result.headline).toBe('Enrolled in PeerZero Academy');
    expect(result.summary).toContain('cool-bot');
  });

  it('summary includes registration message', () => {
    const result = translateRegistration('my-agent', 'Test School');
    expect(result.summary).toBe('Registered as "my-agent". Ready for intake.');
    expect(result.details).toEqual([]);
  });
});

describe('translateIntake', () => {
  it('returns milestone mood when passed is true', () => {
    const result = translateIntake(true, 100);
    expect(result.mood).toBe('milestone');
    expect(result.headline).toBe('Intake passed!');
    expect(result.summary).toBe('Starting credibility: 100. The journey begins.');
    expect(result.new_credibility).toBe(100);
  });

  it('returns negative mood when passed is false', () => {
    const result = translateIntake(false);
    expect(result.mood).toBe('negative');
    expect(result.headline).toBe('Intake failed');
    expect(result.summary).toContain('did not meet');
  });

  it('includes credibility in new_credibility field when passed', () => {
    const result = translateIntake(true, 50);
    expect(result.new_credibility).toBe(50);
  });

  it('new_credibility is undefined when not provided', () => {
    const result = translateIntake(false);
    expect(result.new_credibility).toBeUndefined();
  });
});

describe('translateCondensation', () => {
  it('returns correct headline for skill type', () => {
    const result = translateCondensation('skill');
    expect(result.headline).toBe('Memory updated: Tier 2 paragraph');
    expect(result.summary).toContain('Tier 2 paragraph');
    expect(result.mood).toBe('neutral');
  });

  it('returns correct headline for core type', () => {
    const result = translateCondensation('core');
    expect(result.headline).toBe('Memory updated: Tier 3 core identity');
    expect(result.summary).toContain('Tier 3 core identity');
  });

  it('returns correct headline for identity type', () => {
    const result = translateCondensation('identity');
    expect(result.headline).toBe('Memory updated: Self-identity reflection');
    expect(result.summary).toContain('Self-identity reflection');
  });

  it('always returns neutral mood and empty details', () => {
    for (const type of ['skill', 'core', 'identity'] as const) {
      const result = translateCondensation(type);
      expect(result.mood).toBe('neutral');
      expect(result.details).toEqual([]);
    }
  });
});

// ── DB-backed functions ─────────────────────────────────────────────────────

describe('logActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts into activity_log and returns an ID', async () => {
    mockQueryOne.mockResolvedValue({ id: 'activity-001' });

    const translated = { headline: 'Test', summary: 'Summary', details: [], mood: 'neutral' as const };
    const id = await logActivity('bot-1', 1, 'review', { foo: 'bar' }, { result: 'ok' }, translated, 500, 100);

    expect(id).toBe('activity-001');
    expect(mockQueryOne).toHaveBeenCalledOnce();
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('INSERT INTO activity_log');
    expect(sql).toContain('RETURNING id');
    expect(params[0]).toBe('bot-1');       // botId
    expect(params[1]).toBe(1);             // cycleNumber
    expect(params[2]).toBe('review');      // actionType
    expect(params[3]).toBe(JSON.stringify({ foo: 'bar' }));   // rawRequest
    expect(params[4]).toBe(JSON.stringify({ result: 'ok' })); // rawResponse
    expect(params[5]).toBe(JSON.stringify(translated));        // translated
    expect(params[6]).toBe(500);           // durationMs
    expect(params[7]).toBe(100);           // llmTokensUsed
    expect(params[8]).toBeNull();          // error
  });

  it('passes null for rawRequest and rawResponse when they are null', async () => {
    mockQueryOne.mockResolvedValue({ id: 'activity-002' });
    const translated = { headline: 'X', summary: 'Y', details: [], mood: 'neutral' as const };
    await logActivity('bot-1', 2, 'submit', null, null, translated);

    const params = mockQueryOne.mock.calls[0][1];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('inserts a content entry when contentText is provided', async () => {
    mockQueryOne.mockResolvedValue({ id: 'activity-003' });
    mockQuery.mockResolvedValue({ rowCount: 1 });

    const translated = { headline: 'Paper', summary: 'Submitted', details: [], mood: 'neutral' as const };
    await logActivity('bot-1', 3, 'submit', null, null, translated, undefined, undefined, undefined, 'Full paper text here');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("'content'");
    expect(params[4]).toBe('Full paper text here');
  });

  it('does not insert content entry when contentText is not provided', async () => {
    mockQueryOne.mockResolvedValue({ id: 'activity-004' });
    const translated = { headline: 'X', summary: 'Y', details: [], mood: 'neutral' as const };
    await logActivity('bot-1', 4, 'review', null, null, translated);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('passes error string when provided', async () => {
    mockQueryOne.mockResolvedValue({ id: 'activity-005' });
    const translated = { headline: 'X', summary: 'Y', details: [], mood: 'negative' as const };
    await logActivity('bot-1', 5, 'review', null, null, translated, undefined, undefined, 'LLM timeout');

    const params = mockQueryOne.mock.calls[0][1];
    expect(params[8]).toBe('LLM timeout');
  });
});

describe('getActivityLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated data with correct defaults (page=1, perPage=20)', async () => {
    const entries = [{ id: '1' }, { id: '2' }];
    mockQueryRows.mockResolvedValue(entries);
    mockQueryOne.mockResolvedValue({ count: 2 });

    const result = await getActivityLog('bot-1');

    expect(result.data).toEqual(entries);
    expect(result.total).toBe(2);
    expect(result.has_more).toBe(false);

    // Check offset = 0 for page 1
    const params = mockQueryRows.mock.calls[0][1];
    expect(params[0]).toBe('bot-1');
    expect(params[1]).toBe(20);  // perPage
    expect(params[2]).toBe(0);   // offset
  });

  it('computes offset correctly for page 2', async () => {
    mockQueryRows.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue({ count: 50 });

    await getActivityLog('bot-1', 2, 10);

    const params = mockQueryRows.mock.calls[0][1];
    expect(params[1]).toBe(10);  // perPage
    expect(params[2]).toBe(10);  // offset = (2-1)*10
  });

  it('has_more is true when more entries exist beyond current page', async () => {
    mockQueryRows.mockResolvedValue([{ id: '1' }]);
    mockQueryOne.mockResolvedValue({ count: 25 });

    const result = await getActivityLog('bot-1', 1, 10);
    expect(result.has_more).toBe(true); // offset(0) + perPage(10) < total(25)
  });

  it('has_more is false when on last page', async () => {
    mockQueryRows.mockResolvedValue([{ id: '1' }]);
    mockQueryOne.mockResolvedValue({ count: 10 });

    const result = await getActivityLog('bot-1', 1, 10);
    expect(result.has_more).toBe(false); // offset(0) + perPage(10) >= total(10)
  });

  it('filters by category when provided', async () => {
    mockQueryRows.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue({ count: 0 });

    await getActivityLog('bot-1', 1, 20, 'content');

    const rowsParams = mockQueryRows.mock.calls[0][1];
    expect(rowsParams).toContain('content');
    const countParams = mockQueryOne.mock.calls[0][1];
    expect(countParams).toContain('content');
  });

  it('does not include category param when not provided', async () => {
    mockQueryRows.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue({ count: 0 });

    await getActivityLog('bot-1');

    const rowsParams = mockQueryRows.mock.calls[0][1];
    expect(rowsParams).toEqual(['bot-1', 20, 0]);
  });

  it('returns total 0 when countResult is null', async () => {
    mockQueryRows.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue(null);

    const result = await getActivityLog('bot-1');
    expect(result.total).toBe(0);
    expect(result.has_more).toBe(false);
  });
});

describe('deleteActivityItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when a row was soft-deleted', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });

    const result = await deleteActivityItem('bot-1', 'activity-001');
    expect(result).toBe(true);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('deleted_at = NOW()');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['activity-001', 'bot-1']);
  });

  it('returns false when no matching row exists', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });

    const result = await deleteActivityItem('bot-1', 'nonexistent');
    expect(result).toBe(false);
  });

  it('returns false when rowCount is undefined', async () => {
    mockQuery.mockResolvedValue({});

    const result = await deleteActivityItem('bot-1', 'activity-001');
    expect(result).toBe(false);
  });
});
