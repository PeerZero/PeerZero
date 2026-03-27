import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../adapters/platform.adapter.mock', () => ({
  MockPlatformAdapter: vi.fn().mockImplementation(() => ({ mock: true })),
}));
vi.mock('../../adapters/platform.adapter.a2a', () => ({
  A2APlatformAdapter: vi.fn().mockImplementation(() => ({ type: 'a2a' })),
}));
vi.mock('../../adapters/platform.adapter.webhook', () => ({
  WebhookPlatformAdapter: vi.fn().mockImplementation(() => ({ type: 'webhook' })),
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

describe('platform.adapter.factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealAdapters = false;
    vi.resetModules();
  });

  it('returns mock adapter when useRealAdapters is false', async () => {
    const { getPlatformAdapter } = await import('../../adapters/platform.adapter.factory');
    const adapter = getPlatformAdapter('a2a');
    expect(adapter).toHaveProperty('mock', true);
  });

  it('returns A2A adapter when useRealAdapters and type is a2a', async () => {
    useRealAdapters = true;
    const { getPlatformAdapter } = await import('../../adapters/platform.adapter.factory');
    const adapter = getPlatformAdapter('a2a');
    expect(adapter).toHaveProperty('type', 'a2a');
  });

  it('returns webhook adapter when useRealAdapters and type is webhook', async () => {
    useRealAdapters = true;
    const { getPlatformAdapter } = await import('../../adapters/platform.adapter.factory');
    const adapter = getPlatformAdapter('webhook');
    expect(adapter).toHaveProperty('type', 'webhook');
  });

  it('defaults to a2a when no adapterType provided', async () => {
    useRealAdapters = true;
    const { getPlatformAdapter } = await import('../../adapters/platform.adapter.factory');
    const adapter = getPlatformAdapter();
    expect(adapter).toHaveProperty('type', 'a2a');
  });

  it('caches adapters per type', async () => {
    useRealAdapters = true;
    const { getPlatformAdapter } = await import('../../adapters/platform.adapter.factory');
    const a1 = getPlatformAdapter('a2a');
    const a2 = getPlatformAdapter('a2a');
    expect(a1).toBe(a2);
  });
});
