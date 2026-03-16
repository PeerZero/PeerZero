// =============================================================================
// WebSocket activity stream — pushes real-time bot activity to connected clients
//
// Auth: Client connects to ws://server/ws?bot_id=UUID, then sends an auth
// message: { type: "auth", token: "JWT" }. The token is NOT passed in the URL
// to avoid leaking JWTs in server logs, proxies, and browser history.
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../lib/logger';
import { JwtPayload } from '../middleware/auth';
import { queryOne } from '../db/client';

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

function getTotalConnections(): number {
  let total = 0;
  for (const botClients of clients.values()) {
    total += botClients.length;
  }
  return total;
}

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Periodic cleanup of stale connections (every 30s)
  const cleanupInterval = setInterval(() => {
    for (const [botId, botClients] of clients.entries()) {
      const alive = botClients.filter(c => c.ws.readyState === WebSocket.OPEN);
      if (alive.length === 0) {
        clients.delete(botId);
      } else if (alive.length !== botClients.length) {
        clients.set(botId, alive);
      }
    }
    // Recount user connections after cleanup
    userConnectionCounts.clear();
    for (const botClients of clients.values()) {
      for (const c of botClients) {
        userConnectionCounts.set(c.userId, (userConnectionCounts.get(c.userId) || 0) + 1);
      }
    }
  }, 30_000);

  // Clean up interval when server closes
  server.on('close', () => clearInterval(cleanupInterval));

  wss.on('connection', async (ws, req) => {
    try {
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
            payload = jwt.verify(msg.token, config.jwtSecret) as JwtPayload;
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

          // Send initial connected message
          ws.send(JSON.stringify({ type: 'connected', bot_id: botId }));
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
  const botClients = clients.get(botId);
  if (!botClients) return;

  const message = JSON.stringify({ type: 'activity', ...data });

  for (const client of botClients) {
    // Only send to clients owned by this user
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

/** Broadcast bot status change. */
export function broadcastStatusChange(botId: string, userId: string, status: string): void {
  broadcastActivity(botId, userId, { type: 'status_change', status });
}

/** Broadcast external activity (phone-home from self-hosted bots). */
export function broadcastExternalActivity(botId: string, userId: string, data: Record<string, unknown>): void {
  const botClients = clients.get(botId);
  if (!botClients) return;

  const message = JSON.stringify({ type: 'external_activity', ...data });

  for (const client of botClients) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}
