// =============================================================================
// WebSocket activity stream — pushes real-time bot activity to connected clients
//
// Auth: Client connects to ws://server/ws?bot_id=UUID, then sends an auth
// message: { type: "auth", token: "JWT" }. The token is NOT passed in the URL
// to avoid leaking JWTs in server logs, proxies, and browser history.
//
// Federation: When Redis is available, broadcasts are published to a Redis
// pub/sub channel (ws:bot:{botId}) so that all server instances receive them.
// A dedicated subscriber connection listens for these messages and dispatches
// them to local WebSocket clients. If Redis is unavailable, broadcasting falls
// back to local-only delivery (the pre-federation behavior).
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { JwtPayload } from '../middleware/auth';
import { queryOne } from '../db/client';
import type { BotMessage } from '@peerzero/shared';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  botId: string;
}

const clients: Map<string, ConnectedClient[]> = new Map(); // botId → clients

const AUTH_TIMEOUT_MS = 5000; // Client must send auth message within 5s
const MAX_CONNECTIONS_PER_BOT = 10; // Prevent resource exhaustion per bot
const MAX_CONNECTIONS_PER_USER = 20; // Prevent a single user from hogging connections
const MAX_TOTAL_CONNECTIONS = 500; // Global limit

// Track per-user connection counts for limits
const userConnectionCounts: Map<string, number> = new Map();

// Monotonic sequence counter per bot — allows clients to detect missed messages after reconnect
const botSequence: Map<string, number> = new Map();
function nextSeq(botId: string): number {
  const seq = (botSequence.get(botId) || 0) + 1;
  botSequence.set(botId, seq);
  return seq;
}

// ── Redis pub/sub for multi-instance federation ──────────────────────────────
// Pub/sub requires a dedicated subscriber connection (subscribing puts the
// connection into subscriber mode, so it can't be shared with BullMQ or other
// command connections). Publisher reuses a separate connection.

const WS_CHANNEL_PREFIX = 'ws:bot:';

let redisPub: IORedis | null = null;
let redisSub: IORedis | null = null;
let redisReady = false; // true when both pub and sub are connected

/** Lazily initialize Redis pub/sub connections. Returns true if Redis is available. */
function ensureRedis(): boolean {
  if (redisReady) return true;
  if (!config.redisUrl) return false;
  // If already created but not yet ready, don't recreate
  if (redisPub && redisSub) return false;

  try {
    redisPub = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    redisSub = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });

    let pubReady = false;
    let subReady = false;

    const markReady = () => {
      if (pubReady && subReady) {
        redisReady = true;
        logger.info('WebSocket Redis pub/sub connected');
      }
    };

    redisPub.on('ready', () => { pubReady = true; markReady(); });
    redisSub.on('ready', () => { subReady = true; markReady(); });

    const handleError = (label: string) => (err: Error) => {
      logger.error({ err: err.message }, `WebSocket Redis ${label} error`);
      redisReady = false;
    };

    redisPub.on('error', handleError('publisher'));
    redisSub.on('error', handleError('subscriber'));

    // Subscribe to the channel pattern and dispatch to local clients
    redisSub.on('pmessage', (_pattern: string, channel: string, rawMessage: string) => {
      const botId = channel.slice(WS_CHANNEL_PREFIX.length);
      try {
        const { userId, payload } = JSON.parse(rawMessage) as { userId: string; payload: string };
        deliverLocal(botId, userId, payload);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err, channel }, 'Failed to parse Redis pub/sub message');
      }
    });

    // Connect both, then subscribe
    redisPub.connect().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Redis pub connection failed — WebSocket federation disabled');
      redisPub = null;
    });
    redisSub.connect().then(() => {
      redisSub!.psubscribe(`${WS_CHANNEL_PREFIX}*`).catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : err }, 'Failed to psubscribe to ws:bot:* pattern');
      });
    }).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Redis sub connection failed — WebSocket federation disabled');
      redisSub = null;
    });

    return false; // not ready yet — will be ready asynchronously
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Failed to create Redis pub/sub connections');
    redisPub = null;
    redisSub = null;
    return false;
  }
}

/** Deliver a pre-serialized payload to local WebSocket clients for a bot+user. */
function deliverLocal(botId: string, userId: string, payload: string): void {
  const botClients = clients.get(botId);
  if (!botClients) return;

  for (const client of botClients) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

/**
 * Publish a message via Redis pub/sub. Falls back to local-only delivery if
 * Redis is unavailable.
 */
function publishOrLocal(botId: string, userId: string, payload: string): void {
  // Attempt lazy initialization on first call
  ensureRedis();

  if (redisReady && redisPub) {
    const channel = `${WS_CHANNEL_PREFIX}${botId}`;
    const message = JSON.stringify({ userId, payload });
    redisPub.publish(channel, message).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err, botId }, 'Redis publish failed, falling back to local');
      deliverLocal(botId, userId, payload);
    });
  } else {
    // No Redis — deliver locally (single-instance behavior)
    deliverLocal(botId, userId, payload);
  }
}

/** Close Redis pub/sub connections (called during graceful shutdown). */
export async function closeActivityStreamRedis(): Promise<void> {
  redisReady = false;
  const closing: Promise<void>[] = [];
  if (redisSub) {
    closing.push(
      redisSub.punsubscribe(`${WS_CHANNEL_PREFIX}*`)
        .catch((err) => { logger.debug({ err }, 'Redis punsubscribe failed during shutdown'); })
        .then(() => redisSub!.quit())
        .then(() => { redisSub = null; })
        .catch((err) => { logger.debug({ err }, 'Redis sub quit failed during shutdown'); redisSub = null; }),
    );
  }
  if (redisPub) {
    closing.push(
      redisPub.quit()
        .then(() => { redisPub = null; })
        .catch((err) => { logger.debug({ err }, 'Redis pub quit failed during shutdown'); redisPub = null; }),
    );
  }
  await Promise.all(closing);
}

function getTotalConnections(): number {
  let total = 0;
  for (const botClients of clients.values()) {
    total += botClients.length;
  }
  return total;
}

const HEARTBEAT_INTERVAL_MS = 30_000; // Ping every 30s (shorter than typical proxy idle timeouts of 60s)
const PONG_TIMEOUT_MS = 10_000; // If no pong within 10s, consider connection dead

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Track liveness per connection for heartbeat
  const aliveMap = new WeakMap<WebSocket, boolean>();

  // Heartbeat: ping all clients every 30s — detect half-open/dead connections
  // that readyState alone cannot catch (NAT timeout, mobile radio drop, proxy kill)
  const heartbeatInterval = setInterval(() => {
    for (const botClients of clients.values()) {
      for (const client of botClients) {
        if (aliveMap.get(client.ws) === false) {
          // Missed the last pong — connection is dead, terminate it
          client.ws.terminate();
          continue;
        }
        // Mark as not-alive, then send ping — pong handler will mark alive again
        aliveMap.set(client.ws, false);
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Periodic cleanup of stale connections (every 30s)
  const cleanupInterval = setInterval(() => {
    for (const [botId, botClients] of clients.entries()) {
      const alive = botClients.filter(c => c.ws.readyState === WebSocket.OPEN);
      const removed = botClients.length - alive.length;
      if (alive.length === 0) {
        clients.delete(botId);
        botSequence.delete(botId);  // Prevent unbounded growth of sequence map
      } else if (removed > 0) {
        clients.set(botId, alive);
      }
      // Decrement user counts for each stale connection removed
      if (removed > 0) {
        const stale = botClients.filter(c => c.ws.readyState !== WebSocket.OPEN);
        for (const c of stale) {
          const count = userConnectionCounts.get(c.userId) || 0;
          if (count <= 1) {
            userConnectionCounts.delete(c.userId);
          } else {
            userConnectionCounts.set(c.userId, count - 1);
          }
        }
      }
    }
  }, 30_000);

  // Clean up intervals when server closes
  server.on('close', () => {
    clearInterval(cleanupInterval);
    clearInterval(heartbeatInterval);
  });

  // Build allowed-origin checker from CORS config (same source as Express CORS)
  const allowedOrigins = config.corsOrigins.split(',').map(s => s.trim()).filter(Boolean);
  function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return false; // Require origin header for browser connections
    if (config.isDev) {
      return /^https?:\/\/localhost(:\d+)?$/.test(origin)
        || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    }
    return allowedOrigins.includes(origin);
  }

  wss.on('connection', async (ws, req) => {
    try {
      // Origin validation — prevent cross-origin WebSocket hijacking
      const origin = req.headers.origin;
      if (!isOriginAllowed(origin)) {
        ws.close(4003, 'Origin not allowed');
        return;
      }

      // Global connection limit
      if (getTotalConnections() >= MAX_TOTAL_CONNECTIONS) {
        ws.close(4008, 'Server connection limit reached');
        return;
      }

      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const botId = url.searchParams.get('bot_id');

      if (!botId) {
        ws.close(4001, 'Missing bot_id');
        return;
      }

      // Per-bot connection limit (before auth, to prevent resource exhaustion)
      const existingBotClients = clients.get(botId) || [];
      if (existingBotClients.length >= MAX_CONNECTIONS_PER_BOT) {
        ws.close(4007, 'Too many connections for this bot');
        return;
      }

      // Wait for auth message instead of reading token from URL
      const authTimer = setTimeout(() => {
        ws.close(4002, 'Auth timeout — send { type: "auth", token: "JWT" }');
      }, AUTH_TIMEOUT_MS);

      ws.once('message', async (raw) => {
        clearTimeout(authTimer);

        try {
          const msg = JSON.parse(String(raw));
          if (msg.type !== 'auth' || !msg.token) {
            ws.close(4001, 'First message must be { type: "auth", token: "JWT" }');
            return;
          }

          // Verify JWT
          let payload: JwtPayload;
          try {
            // SECURITY: Always specify algorithms to prevent JWT algorithm confusion attacks (CVE-2026-22817)
            payload = jwt.verify(msg.token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
          } catch {
            ws.close(4002, 'Invalid token');
            return;
          }

          // Verify the user owns this bot before allowing subscription
          const bot = await queryOne<{ id: string }>(
            'SELECT id FROM bots WHERE id = $1 AND user_id = $2',
            [botId, payload.userId],
          );
          if (!bot) {
            ws.close(4003, 'Bot not found or not owned by user');
            return;
          }

          // Per-user connection limit
          const userCount = userConnectionCounts.get(payload.userId) || 0;
          if (userCount >= MAX_CONNECTIONS_PER_USER) {
            ws.close(4009, 'Too many connections for this user');
            return;
          }

          // Register client
          const client: ConnectedClient = { ws, userId: payload.userId, botId };
          const existing = clients.get(botId) || [];
          existing.push(client);
          clients.set(botId, existing);
          userConnectionCounts.set(payload.userId, userCount + 1);

          ws.on('close', () => {
            const botClients = clients.get(botId);
            if (botClients) {
              const filtered = botClients.filter(c => c.ws !== ws);
              if (filtered.length === 0) {
                clients.delete(botId);
                botSequence.delete(botId);  // Prevent unbounded growth of sequence map
              } else {
                clients.set(botId, filtered);
              }
            }
            // Decrement user connection count
            const currentCount = userConnectionCounts.get(payload.userId) || 1;
            if (currentCount <= 1) {
              userConnectionCounts.delete(payload.userId);
            } else {
              userConnectionCounts.set(payload.userId, currentCount - 1);
            }
          });

          // Register pong handler for heartbeat liveness detection
          aliveMap.set(ws, true);
          ws.on('pong', () => { aliveMap.set(ws, true); });

          // Send initial connected message with current sequence so client knows where it is
          ws.send(JSON.stringify({ type: 'connected', bot_id: botId, seq: botSequence.get(botId) || 0 }));
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : err }, 'WebSocket auth handler error');
          try { ws.close(4000, 'Internal server error'); } catch { /* already closed */ }
        }
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'WebSocket connection handler error');
      try {
        ws.close(4000, 'Internal server error');
      } catch {
        // WebSocket may already be closed
      }
    }
  });
}

/** Broadcast activity to all clients watching a specific bot. */
export function broadcastActivity(botId: string, userId: string, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'activity', seq: nextSeq(botId), ...data });
  publishOrLocal(botId, userId, payload);
}

/** Broadcast bot status change. */
export function broadcastStatusChange(botId: string, userId: string, status: string): void {
  broadcastActivity(botId, userId, { subtype: 'status_change', status });
}

/** Broadcast a new chat message (activity narration, milestone, or user chat). */
export function broadcastMessage(botId: string, userId: string, message: BotMessage | Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'message', seq: nextSeq(botId), message });
  publishOrLocal(botId, userId, payload);
}

/** Broadcast an agenda state update (action desk step completed/failed). */
export function broadcastAgendaUpdate(botId: string, userId: string, messageId: string, agendaState: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'agenda_update', seq: nextSeq(botId), message_id: messageId, agenda: agendaState });
  publishOrLocal(botId, userId, payload);
}

/** Broadcast external activity (phone-home from self-hosted bots). */
export function broadcastExternalActivity(botId: string, userId: string, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'external_activity', seq: nextSeq(botId), ...data });
  publishOrLocal(botId, userId, payload);
}
