import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/url-validation', () => ({
  validateExternalUrl: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { A2APlatformAdapter } from '../../adapters/platform.adapter.a2a';
import type { PlatformCredentials } from '../../adapters/platform.adapter';

function makeCreds(overrides: Partial<PlatformCredentials> = {}): PlatformCredentials {
  return {
    apiKey: 'test-key',
    config: { base_url: 'https://platform.example.com' },
    platformName: 'TestPlatform',
    ...overrides,
  };
}

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

describe('A2APlatformAdapter', () => {
  let adapter: A2APlatformAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new A2APlatformAdapter();
  });

  // ── discover ──

  describe('discover', () => {
    it('fetches agent card and maps capabilities', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        capabilities: { post: true, comment: true, vote: true, debate: false, content_types: ['text', 'markdown'], rate_limit: 60 },
      }));

      const caps = await adapter.discover(makeCreds());
      expect(caps.can_post).toBe(true);
      expect(caps.can_vote).toBe(true);
      expect(caps.can_debate).toBe(false);
      expect(caps.content_types).toEqual(['text', 'markdown']);
      expect(caps.rate_limit).toBe(60);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // Check URL includes agent card path
      expect(mockFetch.mock.calls[0][0]).toContain('/.well-known/agent-card.json');
    });

    it('uses custom agent_card_url from config', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ capabilities: {} }));
      const creds = makeCreds({ config: { base_url: 'https://example.com', agent_card_url: '/custom/card' } });
      await adapter.discover(creds);
      expect(mockFetch.mock.calls[0][0]).toContain('/custom/card');
    });

    it('returns defaults on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const caps = await adapter.discover(makeCreds());
      expect(caps.can_post).toBe(true);
      expect(caps.can_comment).toBe(true);
      expect(caps.can_vote).toBe(false);
      expect(caps.content_types).toEqual(['text']);
    });

    it('throws if no base_url in config', async () => {
      const creds = makeCreds({ config: {} });
      await expect(adapter.discover(creds)).rejects.toThrow(/base_url/);
    });

    it('sends Bearer authorization header', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ capabilities: {} }));
      await adapter.discover(makeCreds());
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer test-key');
    });
  });

  // ── getContext ──

  describe('getContext', () => {
    it('returns context from API', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        available_topics: ['AI', 'ML'],
        recent_activity: ['post-1'],
        pending_interactions: ['comment-1'],
        summary: 'Test context',
      }));

      const ctx = await adapter.getContext(makeCreds());
      expect(ctx.available_topics).toEqual(['AI', 'ML']);
      expect(ctx.summary).toBe('Test context');
    });

    it('maps alternate field names (topics, pending)', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        topics: ['topic1'],
        pending: ['pending1'],
      }));

      const ctx = await adapter.getContext(makeCreds());
      expect(ctx.available_topics).toEqual(['topic1']);
      expect(ctx.pending_interactions).toEqual(['pending1']);
    });

    it('returns empty context on failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const ctx = await adapter.getContext(makeCreds());
      expect(ctx.available_topics).toEqual([]);
      expect(ctx.summary).toContain('Unable to fetch');
    });
  });

  // ── submitAction ──

  describe('submitAction', () => {
    it('posts action and returns result', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        success: true,
        id: 'action-123',
        skills_demonstrated: ['reasoning'],
      }));

      const result = await adapter.submitAction(makeCreds(), {
        action_type: 'post',
        content: { text: 'Hello world' },
        reasoning: 'Testing',
      });

      expect(result.success).toBe(true);
      expect(result.action_type).toBe('post');
      expect(result.platform_name).toBe('TestPlatform');
      expect(result.skills_demonstrated).toEqual(['reasoning']);
      // Verify POST was sent to /api/actions
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/actions');
      expect(opts.method).toBe('POST');
    });

    it('propagates errors from non-ok responses', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Bad request' }, 400));
      await expect(adapter.submitAction(makeCreds(), {
        action_type: 'post',
        content: { text: 'test' },
        reasoning: 'test',
      })).rejects.toThrow(/400/);
    });
  });

  // ── publishAgentCard ──

  describe('publishAgentCard', () => {
    it('PUTs agent card to endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}));
      const card = { name: 'TestBot', description: 'A test bot', capabilities: {}, skills: [], extensions: {} };
      await adapter.publishAgentCard(makeCreds(), card as any);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/agent-card');
      expect(opts.method).toBe('PUT');
    });
  });
});
