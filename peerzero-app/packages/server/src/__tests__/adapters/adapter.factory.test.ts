import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all adapter implementations BEFORE importing the factory
vi.mock('../../adapters/school.adapter.mock', () => ({
  MockSchoolAdapter: vi.fn().mockImplementation(() => ({ mock: true, type: 'school' })),
}));
vi.mock('../../adapters/llm.adapter.mock', () => ({
  MockLLMAdapter: vi.fn().mockImplementation(() => ({ mock: true, type: 'llm' })),
}));
vi.mock('../../adapters/school.adapter.real', () => ({
  RealSchoolAdapter: vi.fn().mockImplementation(() => ({ real: true, type: 'school' })),
}));
vi.mock('../../adapters/llm.adapter.real', () => ({
  RealLLMAdapter: vi.fn().mockImplementation(() => ({ real: true, type: 'llm' })),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let useRealAdapters = false;

vi.mock('../../config', () => ({
  config: {
    get useRealAdapters() { return useRealAdapters; },
  },
}));

// Must dynamically import after mocks are set up to get fresh singletons
// The factory uses module-level let variables, so we need resetModules

describe('adapter.factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealAdapters = false;
    vi.resetModules();
  });

  it('returns mock school adapter when useRealAdapters is false', async () => {
    const { getSchoolAdapter } = await import('../../adapters/adapter.factory');
    const adapter = getSchoolAdapter();
    expect(adapter).toHaveProperty('mock', true);
  });

  it('returns mock LLM adapter when useRealAdapters is false', async () => {
    const { getLLMAdapter } = await import('../../adapters/adapter.factory');
    const adapter = getLLMAdapter();
    expect(adapter).toHaveProperty('mock', true);
  });

  it('returns real school adapter when useRealAdapters is true', async () => {
    useRealAdapters = true;
    const { getSchoolAdapter } = await import('../../adapters/adapter.factory');
    const adapter = getSchoolAdapter();
    expect(adapter).toHaveProperty('real', true);
  });

  it('returns real LLM adapter when useRealAdapters is true', async () => {
    useRealAdapters = true;
    const { getLLMAdapter } = await import('../../adapters/adapter.factory');
    const adapter = getLLMAdapter();
    expect(adapter).toHaveProperty('real', true);
  });

  it('returns the same singleton on subsequent calls', async () => {
    const { getSchoolAdapter, getLLMAdapter } = await import('../../adapters/adapter.factory');
    const s1 = getSchoolAdapter();
    const s2 = getSchoolAdapter();
    expect(s1).toBe(s2);
    const l1 = getLLMAdapter();
    const l2 = getLLMAdapter();
    expect(l1).toBe(l2);
  });
});
