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

vi.mock('../../services/encryption.service', () => ({
  encrypt: vi.fn(() => ({
    encrypted: Buffer.from('enc'),
    iv: Buffer.from('iv'),
    fingerprint: 'fp',
  })),
  decrypt: vi.fn(() => 'decrypted-block'),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildLocalFocus,
  storeExercise,
  getRecentExercises,
  getUncondensedExerciseCount,
  storeParagraph,
  getParagraphs,
  storeCore,
  getLatestCore,
  storeSelfIdentity,
  getSelfIdentity,
  storeSelfAuthored,
  getLatestSelfAuthored,
  getMemorySnapshot,
} from '../../services/memory.service';
import { encrypt, decrypt } from '../../services/encryption.service';

beforeEach(() => vi.clearAllMocks());

// ── buildLocalFocus ─────────────────────────────────────────────────────────

describe('buildLocalFocus', () => {
  it('returns empty array when schoolFocus is null', () => {
    expect(buildLocalFocus(null)).toEqual([]);
  });

  it('returns up to 4 focus chunks', () => {
    const chunks = [
      { label: 'a', content: '1' },
      { label: 'b', content: '2' },
      { label: 'c', content: '3' },
      { label: 'd', content: '4' },
      { label: 'e', content: '5' },
    ] as any[];
    const result = buildLocalFocus({ focus_chunks: chunks });
    expect(result).toHaveLength(4);
    expect(result[3].label).toBe('d');
  });

  it('returns all chunks when fewer than 4', () => {
    const chunks = [{ label: 'x', content: 'y' }] as any[];
    expect(buildLocalFocus({ focus_chunks: chunks })).toHaveLength(1);
  });

  it('returns empty array when focus_chunks is empty', () => {
    expect(buildLocalFocus({ focus_chunks: [] })).toEqual([]);
  });
});

// ── storeExercise ───────────────────────────────────────────────────────────

describe('storeExercise', () => {
  it('inserts with all fields', async () => {
    mockQuery.mockResolvedValueOnce({});
    await storeExercise('bot1', 5, 'review', { score: 8 }, { result: 'ok' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const args = mockQuery.mock.calls[0];
    expect(args[0]).toContain('INSERT INTO bot_memory_exercises');
    expect(args[1][0]).toBe('bot1');
    expect(args[1][1]).toBe(5);
    expect(args[1][2]).toBe('review');
    expect(args[1][3]).toBe(JSON.stringify({ score: 8 }));
    expect(args[1][4]).toBe(JSON.stringify({ result: 'ok' }));
  });

  it('passes null for schoolResponse when omitted', async () => {
    mockQuery.mockResolvedValueOnce({});
    await storeExercise('bot1', 1, 'paper', { title: 'T' });
    expect(mockQuery.mock.calls[0][1][4]).toBeNull();
  });
});

// ── getRecentExercises ──────────────────────────────────────────────────────

describe('getRecentExercises', () => {
  it('returns rows with default limit', async () => {
    const rows = [{ id: '1', cycle_number: 1, action_type: 'review' }];
    mockQueryRows.mockResolvedValueOnce(rows);
    const result = await getRecentExercises('bot1');
    expect(result).toEqual(rows);
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['bot1', 20]);
  });

  it('uses custom limit', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    await getRecentExercises('bot1', 5);
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['bot1', 5]);
  });
});

// ── getUncondensedExerciseCount ─────────────────────────────────────────────

describe('getUncondensedExerciseCount', () => {
  it('counts all exercises when no paragraph exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // no last paragraph
    mockQueryOne.mockResolvedValueOnce({ count: 7 });
    const result = await getUncondensedExerciseCount('bot1');
    expect(result).toBe(7);
  });

  it('counts exercises after last paragraph', async () => {
    mockQueryOne.mockResolvedValueOnce({ created_at: '2025-01-01' });
    mockQueryOne.mockResolvedValueOnce({ count: 3 });
    const result = await getUncondensedExerciseCount('bot1');
    expect(result).toBe(3);
    expect(mockQueryOne.mock.calls[1][1]).toEqual(['bot1', '2025-01-01']);
  });

  it('returns 0 when count result is null', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await getUncondensedExerciseCount('bot1')).toBe(0);
  });
});

// ── storeParagraph ──────────────────────────────────────────────────────────

describe('storeParagraph', () => {
  it('encrypts paragraph before inserting', async () => {
    mockQuery.mockResolvedValueOnce({});
    await storeParagraph('bot1', 'review', 'A paragraph.', 10);
    expect(encrypt).toHaveBeenCalledWith('A paragraph.');
    const args = mockQuery.mock.calls[0];
    expect(args[0]).toContain('encrypted_paragraph');
    expect(args[1]).toEqual(['bot1', 'review', Buffer.from('enc'), Buffer.from('iv'), 10]);
  });

  it('passes null when triggerCycle omitted', async () => {
    mockQuery.mockResolvedValueOnce({});
    await storeParagraph('bot1', 'paper', 'Text');
    expect(mockQuery.mock.calls[0][1][4]).toBeNull();
  });
});

// ── getParagraphs ───────────────────────────────────────────────────────────

describe('getParagraphs', () => {
  it('decrypts encrypted paragraphs', async () => {
    mockQueryRows.mockResolvedValueOnce([{
      id: '1', interaction_type: 'review', trigger_cycle: 1, created_at: 'ts',
      encrypted_paragraph: Buffer.from('enc'), paragraph_iv: Buffer.from('iv'),
      paragraph: null,
    }]);
    const result = await getParagraphs('bot1');
    expect(result).toHaveLength(1);
    expect(decrypt).toHaveBeenCalledWith(Buffer.from('enc'), Buffer.from('iv'));
    expect(result[0].paragraph).toBe('decrypted-block');
    expect(mockQueryRows.mock.calls[0][1]).toEqual(['bot1', 50]);
  });

  it('falls back to plaintext for pre-migration rows', async () => {
    mockQueryRows.mockResolvedValueOnce([{
      id: '2', interaction_type: 'paper', trigger_cycle: null, created_at: 'ts',
      encrypted_paragraph: null, paragraph_iv: null,
      paragraph: 'old plaintext',
    }]);
    const result = await getParagraphs('bot1');
    expect(result[0].paragraph).toBe('old plaintext');
  });
});

// ── storeCore ───────────────────────────────────────────────────────────────

describe('storeCore', () => {
  it('encrypts and auto-increments version from latest', async () => {
    mockQueryOne.mockResolvedValueOnce({ version: 3 }); // latest version
    mockQuery.mockResolvedValueOnce({});
    await storeCore('bot1', 'My core identity', 'condensation');
    expect(encrypt).toHaveBeenCalledWith('My core identity');
    const args = mockQuery.mock.calls[0];
    expect(args[0]).toContain('encrypted_core');
    expect(args[1]).toEqual(['bot1', Buffer.from('enc'), Buffer.from('iv'), 'condensation', 4]);
  });

  it('starts at version 1 when no previous exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({});
    await storeCore('bot1', 'First core');
    expect(mockQuery.mock.calls[0][1][4]).toBe(1);
    expect(mockQuery.mock.calls[0][1][3]).toBeNull(); // triggerLabel null
  });
});

// ── getLatestCore ───────────────────────────────────────────────────────────

describe('getLatestCore', () => {
  it('decrypts encrypted core identity', async () => {
    mockQueryOne.mockResolvedValueOnce({
      encrypted_core: Buffer.from('enc'), core_iv: Buffer.from('iv'),
      core_identity: null, trigger_label: 'l', version: 2, created_at: 'ts',
    });
    const result = await getLatestCore('bot1');
    expect(decrypt).toHaveBeenCalledWith(Buffer.from('enc'), Buffer.from('iv'));
    expect(result).toEqual({
      core_identity: 'decrypted-block',
      trigger_label: 'l', version: 2, created_at: 'ts',
    });
  });

  it('falls back to plaintext for pre-migration rows', async () => {
    mockQueryOne.mockResolvedValueOnce({
      encrypted_core: null, core_iv: null,
      core_identity: 'old core', trigger_label: null, version: 1, created_at: 'ts',
    });
    const result = await getLatestCore('bot1');
    expect(result!.core_identity).toBe('old core');
  });

  it('returns null when no core exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await getLatestCore('bot1')).toBeNull();
  });
});

// ── storeSelfIdentity ───────────────────────────────────────────────────────

describe('storeSelfIdentity', () => {
  it('encrypts identity blob before upserting', async () => {
    mockQuery.mockResolvedValueOnce({});
    await storeSelfIdentity('bot1', 'narrative', ['val1'], 'tensions', 'convictions', 5);
    expect(encrypt).toHaveBeenCalledWith(JSON.stringify({
      self_narrative: 'narrative',
      claimed_values: ['val1'],
      active_tensions: 'tensions',
      formed_convictions: 'convictions',
    }));
    const args = mockQuery.mock.calls[0];
    expect(args[0]).toContain('encrypted_identity');
    expect(args[1][0]).toBe('bot1');
    expect(args[1][1]).toEqual(Buffer.from('enc'));
    expect(args[1][2]).toEqual(Buffer.from('iv'));
    expect(args[1][3]).toBe(5);
  });

  it('passes null for optional schoolVersion', async () => {
    mockQuery.mockResolvedValueOnce({});
    await storeSelfIdentity('bot1', null, [], null, null);
    expect(mockQuery.mock.calls[0][1][3]).toBeNull();
  });
});

// ── getSelfIdentity ─────────────────────────────────────────────────────────

describe('getSelfIdentity', () => {
  it('decrypts encrypted identity blob', async () => {
    vi.mocked(decrypt).mockReturnValueOnce(JSON.stringify({
      self_narrative: 'decrypted narrative',
      claimed_values: ['v'],
      active_tensions: 'decrypted tensions',
      formed_convictions: 'decrypted convictions',
    }));
    mockQueryOne.mockResolvedValueOnce({
      encrypted_identity: Buffer.from('enc'), identity_iv: Buffer.from('iv'),
      self_narrative: null, claimed_values: null, active_tensions: null, formed_convictions: null,
      cached_at: 'ts',
    });
    const result = await getSelfIdentity('bot1');
    expect(decrypt).toHaveBeenCalledWith(Buffer.from('enc'), Buffer.from('iv'));
    expect(result).toEqual({
      self_narrative: 'decrypted narrative',
      claimed_values: ['v'],
      active_tensions: 'decrypted tensions',
      formed_convictions: 'decrypted convictions',
      cached_at: 'ts',
    });
  });

  it('falls back to plaintext for pre-migration rows', async () => {
    mockQueryOne.mockResolvedValueOnce({
      encrypted_identity: null, identity_iv: null,
      self_narrative: 'old', claimed_values: ['v'], active_tensions: null, formed_convictions: null,
      cached_at: 'ts',
    });
    const result = await getSelfIdentity('bot1');
    expect(result!.self_narrative).toBe('old');
  });

  it('returns null when none exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await getSelfIdentity('bot1')).toBeNull();
  });
});

// ── storeSelfAuthored ───────────────────────────────────────────────────────

describe('storeSelfAuthored', () => {
  it('encrypts and auto-increments version', async () => {
    mockQueryOne.mockResolvedValueOnce({ version: 2 }); // latest
    mockQuery.mockResolvedValueOnce({});
    await storeSelfAuthored('bot1', 'my private thoughts', 'condensation');
    expect(mockQuery.mock.calls[0][1][1]).toEqual(Buffer.from('enc'));
    expect(mockQuery.mock.calls[0][1][2]).toEqual(Buffer.from('iv'));
    expect(mockQuery.mock.calls[0][1][3]).toBe('condensation');
    expect(mockQuery.mock.calls[0][1][4]).toBe(3); // version incremented
  });

  it('starts at version 1 when no previous exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({});
    await storeSelfAuthored('bot1', 'first block', 'init');
    expect(mockQuery.mock.calls[0][1][4]).toBe(1);
  });
});

// ── getLatestSelfAuthored ───────────────────────────────────────────────────

describe('getLatestSelfAuthored', () => {
  it('returns decrypted block', async () => {
    mockQueryOne.mockResolvedValueOnce({ encrypted_block: Buffer.from('enc'), block_iv: Buffer.from('iv') });
    const result = await getLatestSelfAuthored('bot1');
    expect(result).toBe('decrypted-block');
  });

  it('returns null when no row exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await getLatestSelfAuthored('bot1')).toBeNull();
  });

  it('returns null on decrypt failure', async () => {
    mockQueryOne.mockResolvedValueOnce({ encrypted_block: Buffer.from('bad'), block_iv: Buffer.from('iv') });
    vi.mocked(decrypt).mockImplementationOnce(() => { throw new Error('bad key'); });
    const result = await getLatestSelfAuthored('bot1');
    expect(result).toBeNull();
  });
});

// ── getMemorySnapshot ───────────────────────────────────────────────────────

describe('getMemorySnapshot', () => {
  it('returns redacted snapshot with all tiers', async () => {
    // getRecentExercises
    mockQueryRows.mockResolvedValueOnce([{ id: '1', action_type: 'review' }]);
    // getParagraphs — now returns encrypted rows
    mockQueryRows.mockResolvedValueOnce([{
      id: '2', interaction_type: 'review', trigger_cycle: 1, created_at: 'ts',
      encrypted_paragraph: Buffer.from('enc'), paragraph_iv: Buffer.from('iv'), paragraph: null,
    }]);
    // getLatestCore — now returns encrypted row
    mockQueryOne.mockResolvedValueOnce({
      encrypted_core: Buffer.from('enc'), core_iv: Buffer.from('iv'), core_identity: null,
      version: 1, trigger_label: 'l', created_at: 'ts',
    });
    // getSelfIdentity — now returns encrypted row
    vi.mocked(decrypt).mockReturnValueOnce('decrypted-block'); // for paragraph
    vi.mocked(decrypt).mockReturnValueOnce('decrypted-block'); // for core
    vi.mocked(decrypt).mockReturnValueOnce(JSON.stringify({
      self_narrative: 'secret narrative', claimed_values: ['honesty'],
      active_tensions: 'secret tensions', formed_convictions: 'secret convictions',
    }));
    mockQueryOne.mockResolvedValueOnce({
      encrypted_identity: Buffer.from('enc'), identity_iv: Buffer.from('iv'),
      self_narrative: null, claimed_values: null, active_tensions: null, formed_convictions: null,
      cached_at: 'ts',
    });

    const focus = { focus_chunks: [{ label: 'a', content: 'b' }] as any[] };
    const result = await getMemorySnapshot('bot1', focus);

    // Tier 0 present
    expect(result.tier0_focus).toHaveLength(1);

    // Tier 1 not redacted
    expect(result.tier1_exercises).toHaveLength(1);

    // Tier 2 redacted
    expect(result.tier2_paragraphs[0].paragraph).toBe('[condensed — internal only]');

    // Tier 3 core redacted
    expect(result.tier3_core!.core_identity).toBe('[condensed — internal only]');

    // Self-identity redacted
    expect(result.tier3_self_identity!.self_narrative).toBe('[condensed — internal only]');
    expect(result.tier3_self_identity!.claimed_values).toEqual([]);
    expect(result.tier3_self_identity!.active_tensions).toBe('[condensed — internal only]');
    expect(result.tier3_self_identity!.formed_convictions).toBe('[condensed — internal only]');
  });

  it('handles null core and self-identity', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(null); // no core
    mockQueryOne.mockResolvedValueOnce(null); // no self-identity

    const result = await getMemorySnapshot('bot1', null);
    expect(result.tier0_focus).toEqual([]);
    expect(result.tier3_core).toBeNull();
    expect(result.tier3_self_identity).toBeNull();
  });

  it('handles self-identity with null narrative', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(null);
    // Pre-migration row with plaintext fallback
    mockQueryOne.mockResolvedValueOnce({
      encrypted_identity: null, identity_iv: null,
      self_narrative: null,
      claimed_values: [],
      active_tensions: null,
      formed_convictions: null,
      cached_at: 'ts',
    });

    const result = await getMemorySnapshot('bot1', null);
    expect(result.tier3_self_identity!.self_narrative).toBeNull();
    expect(result.tier3_self_identity!.active_tensions).toBeNull();
    expect(result.tier3_self_identity!.formed_convictions).toBeNull();
  });
});
