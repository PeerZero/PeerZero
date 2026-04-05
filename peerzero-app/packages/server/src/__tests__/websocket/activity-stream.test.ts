import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: { jwtSecret: 'test-secret' },
}));

const mockQueryOne = vi.fn();
vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
}));

import jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';

// ── WebSocket / Server fakes ────────────────────────────────────────────────

class FakeWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }

  // Simulate receiving a message
  receiveMessage(data: string) {
    this.emit('message', Buffer.from(data));
  }
}

class FakeWebSocketServer extends EventEmitter {
  constructor(_opts: any) {
    super();
  }
}

// Mock ws module
vi.mock('ws', () => ({
  WebSocketServer: vi.fn().mockImplementation((opts: any) => new FakeWebSocketServer(opts)),
  WebSocket: { OPEN: 1 },
}));

// ── Helper: create valid JWT ────────────────────────────────────────────────

function makeToken(userId: string): string {
  return jwt.sign({ userId }, 'test-secret', { algorithm: 'HS256' });
}

// ── Import after mocks ─────────────────────────────────────────────────────

import { setupWebSocket, broadcastActivity, broadcastStatusChange, broadcastMessage, broadcastExternalActivity } from '../../websocket/activity-stream';
import { WebSocketServer } from 'ws';

// =============================================================================
// Tests
// =============================================================================

describe('activity-stream', () => {
  let fakeServer: EventEmitter;
  let fakeWss: FakeWebSocketServer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    fakeServer = new EventEmitter();
    setupWebSocket(fakeServer as any);

    // Get the FakeWebSocketServer that was created
    fakeWss = (WebSocketServer as any).mock.results[
      (WebSocketServer as any).mock.results.length - 1
    ].value;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: simulate a new connection with a URL
  function connect(botId?: string): FakeWebSocket {
    const ws = new FakeWebSocket();
    const req = {
      url: botId ? `/ws?bot_id=${botId}` : '/ws',
      headers: { host: 'localhost:3000' },
    };
    fakeWss.emit('connection', ws, req);
    return ws;
  }

  // Helper: fully authenticate a WebSocket connection
  async function connectAndAuth(botId: string, userId: string): Promise<FakeWebSocket> {
    mockQueryOne.mockResolvedValueOnce({ id: botId });
    const ws = connect(botId);
    const token = makeToken(userId);
    ws.receiveMessage(JSON.stringify({ type: 'auth', token }));
    // Allow async auth handler to complete
    await vi.advanceTimersByTimeAsync(0);
    return ws;
  }

  describe('setupWebSocket', () => {
    it('creates a WebSocketServer on the /ws path', () => {
      expect(WebSocketServer).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/ws' }),
      );
    });
  });

  describe('connection handling', () => {
    it('closes connection when bot_id is missing', () => {
      const ws = connect(); // no bot_id
      expect(ws.closeCode).toBe(4001);
      expect(ws.closeReason).toBe('Missing bot_id');
    });

    it('closes connection on auth timeout', async () => {
      const ws = connect('bot-1');
      // No auth message sent — advance past timeout
      await vi.advanceTimersByTimeAsync(5001);
      expect(ws.closeCode).toBe(4002);
      expect(ws.closeReason).toContain('Auth timeout');
    });

    it('closes connection when first message is not auth', async () => {
      const ws = connect('bot-1');
      ws.receiveMessage(JSON.stringify({ type: 'ping' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.closeCode).toBe(4001);
      expect(ws.closeReason).toContain('First message must be');
    });

    it('closes connection when auth message has no token', async () => {
      const ws = connect('bot-1');
      ws.receiveMessage(JSON.stringify({ type: 'auth' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.closeCode).toBe(4001);
    });

    it('closes connection with invalid JWT', async () => {
      const ws = connect('bot-1');
      ws.receiveMessage(JSON.stringify({ type: 'auth', token: 'bad-token' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.closeCode).toBe(4002);
      expect(ws.closeReason).toBe('Invalid token');
    });

    it('closes connection when user does not own the bot', async () => {
      mockQueryOne.mockResolvedValueOnce(null); // bot not found
      const ws = connect('bot-1');
      const token = makeToken('user-1');
      ws.receiveMessage(JSON.stringify({ type: 'auth', token }));
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.closeCode).toBe(4003);
      expect(ws.closeReason).toContain('not owned');
    });

    it('sends connected message on successful auth', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');
      const lastMsg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(lastMsg).toEqual({ type: 'connected', bot_id: 'bot-1' });
    });

    it('verifies bot ownership via DB query', async () => {
      await connectAndAuth('bot-1', 'user-1');
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM bots'),
        ['bot-1', 'user-1'],
      );
    });
  });

  describe('broadcastActivity', () => {
    it('sends activity data to authenticated clients watching the bot', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');

      broadcastActivity('bot-1', 'user-1', { action: 'review', score: 75 });

      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(sent.type).toBe('activity');
      expect(sent.action).toBe('review');
      expect(sent.score).toBe(75);
    });

    it('does not send to clients of a different user', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');

      broadcastActivity('bot-1', 'user-2', { action: 'review' });

      // Only the initial 'connected' message should be there
      expect(ws.sent).toHaveLength(1);
    });

    it('does nothing when no clients watch the bot', () => {
      // No error thrown
      broadcastActivity('bot-nonexistent', 'user-1', { action: 'test' });
    });
  });

  describe('broadcastStatusChange', () => {
    it('sends a status_change event', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');

      broadcastStatusChange('bot-1', 'user-1', 'running');

      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(sent.type).toBe('status_change');
      expect(sent.status).toBe('running');
    });
  });

  describe('broadcastMessage', () => {
    it('sends a message event', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');

      broadcastMessage('bot-1', 'user-1', { text: 'Hello', role: 'bot' });

      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(sent.type).toBe('message');
      expect(sent.message).toEqual({ text: 'Hello', role: 'bot' });
    });

    it('does nothing when no clients watch the bot', () => {
      broadcastMessage('bot-nonexistent', 'user-1', { text: 'Hello' });
      // No error thrown
    });
  });

  describe('broadcastExternalActivity', () => {
    it('sends an external_activity event', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');

      broadcastExternalActivity('bot-1', 'user-1', { platform: 'moltbook', action: 'posted' });

      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(sent.type).toBe('external_activity');
      expect(sent.platform).toBe('moltbook');
    });
  });

  describe('cleanup', () => {
    it('removes stale connections during periodic cleanup', async () => {
      const ws = await connectAndAuth('bot-1', 'user-1');

      // Simulate the WS becoming stale
      ws.readyState = 3; // CLOSED

      // Trigger the 30s cleanup interval
      await vi.advanceTimersByTimeAsync(30_000);

      // Now broadcasts should not reach the stale WS
      broadcastActivity('bot-1', 'user-1', { action: 'test' });
      // Only the initial 'connected' message
      expect(ws.sent).toHaveLength(1);
    });
  });
});
