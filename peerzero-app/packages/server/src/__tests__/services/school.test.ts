import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
}));

import { listSchools, getSchool } from '../../services/school.service';

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('listSchools', () => {
  it('returns active schools ordered by name', async () => {
    const schools = [
      { id: 's1', name: 'Comedy', description: 'Learn comedy', price_cents: 0, is_active: true },
      { id: 's2', name: 'Science', description: 'Learn science', price_cents: 500, is_active: true },
    ];
    mockQueryRows.mockResolvedValueOnce(schools);

    const result = await listSchools();

    expect(mockQueryRows).toHaveBeenCalledOnce();
    const [sql] = mockQueryRows.mock.calls[0];
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('ORDER BY name');
    expect(result).toEqual(schools);
  });

  it('returns empty array when no active schools exist', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    const result = await listSchools();
    expect(result).toEqual([]);
  });
});

describe('getSchool', () => {
  it('returns school by id', async () => {
    const school = { id: 's1', name: 'Science', description: 'Learn science', price_cents: 500, is_active: true };
    mockQueryOne.mockResolvedValueOnce(school);

    const result = await getSchool('s1');

    expect(mockQueryOne).toHaveBeenCalledOnce();
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['s1']);
    expect(result).toEqual(school);
  });

  it('returns null when school not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getSchool('nonexistent');
    expect(result).toBeNull();
  });
});
