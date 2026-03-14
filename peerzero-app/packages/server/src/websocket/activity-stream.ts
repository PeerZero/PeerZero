// =============================================================================
// WebSocket activity stream — pushes real-time bot activity to connected clients
// Mobile app connects to ws://server/ws?token=JWT&bot_id=UUID
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { JwtPayload } from '../middleware/auth';
import { queryOne } from '../db/client';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  botId: string;
}

const clients: Map<string, ConnectedClient[]> = new Map(); // botId → clients

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const botId = url.searchParams.get('bot_id');

    if (!token || !botId) {
      ws.close(4001, 'Missing token or bot_id');
      return;
    }

    // Verify JWT
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
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

    // Register client
    const client: ConnectedClient = { ws, userId: payload.userId, botId };
    const existing = clients.get(botId) || [];
    existing.push(client);
    clients.set(botId, existing);

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
    });

    // Send initial connected message
    ws.send(JSON.stringify({ type: 'connected', bot_id: botId }));
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
