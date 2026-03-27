import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/url-validation', () => ({
  validateExternalUrl: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { WebhookPlatformAdapter } from '../../adapters/platform.adapter.webhook';
import type { PlatformCredentials } from '../../adapters/platform.adapter';

function makeCreds(overrides: Partial<PlatformCredentials> = {}): PlatformCredentials {
  return {
    apiKey: 'test-webhook-key',
    config: { base_url: 'https://webhook.example.com' },
    platformName: 'WebhookPlatform',
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

describe('WebhookPlatformAdapter', () => {
  let adapter: WebhookPlatformAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new WebhookPlatformAdapter();
  });

  // ── discover ──

  describe('discover', () => {
    it('fetches /api/info and derives capabilities from events', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        events: ['post', 'comment', 'vote'],
        rate_limit: 30,
      }));

      const caps = await adapter.discover(makeCreds());
      expect(caps.can_post).toBe(true);
      expect(caps.can_comment).toBe(true);
      expect(caps.can_vote).toBe(true);
      expect(caps.can_debate).toBe(false);
      expect(caps.rate_limit).toBe(30);
    });

    it('uses capabilities object if present', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        capabilities: { post: true, debate: true, content_types: ['markdown'] },
      }));

      const caps = await adapter.discover(makeCreds());
      expect(caps.can_post).toBe(true);
      expect(caps.can_debate).toBe(true);
      expect(caps.content_types).toEqual(['markdown']);
    });

    it('falls back to config events on failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const creds = makeCreds({ config: { base_url: 'https://example.com', events: ['post', 'debate'] } });
      const caps = await adapter.discover(creds);
      expect(caps.can_post).toBe(true);
      expect(caps.can_debate).toBe(true);
      expect(caps.can_comment).toBe(false);
    });

    it('sends x-api-key header (not Bearer)', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ events: [] }));
      await adapter.discover(makeCreds());
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBe('test-webhook-key');
      expect(headers.Authorization).toBeUndefined();
    });

    it('throws if no base_url', async () => {
      await expect(adapter.discover(makeCreds({ config: {} }))).rejects.toThrow(/base_url/);
    });
  });

  // ── getContext ──

  describe('getContext', () => {
    it('returns context from API', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        available_topics: ['Science'],
        recent_activity: ['act-1'],
        summary: 'Webhook context',
      }));

      const ctx = await adapter.getContext(makeCreds());
      expect(ctx.available_topics).toEqual(['Science']);
      expect(ctx.summary).toBe('Webhook context');
    });

    it('returns empty context on failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fail'));
      const ctx = await adapter.getContext(makeCreds());
      expect(ctx.available_topics).toEqual([]);
      expect(ctx.summary).toContain('Unable to fetch');
    });
  });

  // ── submitAction ──

  describe('submitAction', () => {
    it('posts to action-type-specific endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true, id: 'post-1' }));

      const result = await adapter.submitAction(makeCreds(), {
        action_type: 'comment',
        content: { text: 'Nice post!' },
        target_id: 'thread-1',
        reasoning: 'Interesting discussion',
      });

      expect(result.success).toBe(true);
      expect(result.action_type).toBe('comment');
      expect(result.summary).toContain('webhook');
      // Verify endpoint is /api/comment (not /api/actions)
      expect(mockFetch.mock.calls[0][0]).toContain('/api/comment');
    });

    it('propagates API errors', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse('Server error', 500));
      await expect(adapter.submitAction(makeCreds(), {
        action_type: 'post',
        content: { text: 'test' },
        reasoning: 'test',
      })).rejects.toThrow(/500/);
    });
  });

  // ── publishAgentCard ──

  describe('publishAgentCard', () => {
    it('PUTs card to /api/agent-card', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}));
      await adapter.publishAgentCard(makeCreds(), { name: 'Bot', description: 'Test' } as any);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/agent-card');
      expect(opts.method).toBe('PUT');
    });
  });
});
