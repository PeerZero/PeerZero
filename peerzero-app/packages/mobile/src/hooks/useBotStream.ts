// =============================================================================
// useBotStream — WebSocket hook for real-time bot activity streaming
//
// Connects to the server's /ws endpoint with JWT auth. Receives:
//   - activity events (new log entries as they happen)
//   - status_change events (bot started, stopped, errored)
//
// Auto-reconnects with exponential backoff on disconnect.
// Closes cleanly when component unmounts or botId changes.
//
// Scaling: One WebSocket per active bot view. Connection is only open while
// the user is viewing the bot/log screen, not globally. The server's
// ConnectedClient map is keyed by botId, so only relevant events are pushed.
// At millions of users, the WebSocket server can be horizontally scaled
// behind a sticky load balancer (connection affinity by bot_id).
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import type { ActivityEntry } from '@peerzero/shared';

const WS_BASE = __DEV__ ? 'ws://localhost:3001/ws' : 'wss://api.peerzero.com/ws';

const MAX_RECONNECT_DELAY = 30000; // 30s ceiling
const INITIAL_RECONNECT_DELAY = 1000; // Start at 1s

export interface BotStreamEvent {
  type: 'activity' | 'status_change' | 'connected';
  status?: string;
  // Activity fields (when type === 'activity')
  cycle_number?: number;
  action_type?: string;
  translated?: ActivityEntry['translated'];
  error?: string;
  duration_ms?: number;
  llm_tokens_used?: number;
  created_at?: string;
}

interface UseBotStreamOptions {
  botId: string | null;
  enabled?: boolean;
  onActivity?: (event: BotStreamEvent) => void;
  onStatusChange?: (status: string) => void;
}

interface UseBotStreamResult {
  isConnected: boolean;
  lastEvent: BotStreamEvent | null;
}

export function useBotStream({
  botId,
  enabled = true,
  onActivity,
  onStatusChange,
}: UseBotStreamOptions): UseBotStreamResult {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<BotStreamEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Store callbacks in refs so we don't reconnect when they change
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const connect = useCallback(async () => {
    if (!botId || !enabled || !mountedRef.current) return;

    const token = await SecureStore.getItemAsync('access_token');
    if (!token) return;

    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      const ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(token)}&bot_id=${encodeURIComponent(botId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        reconnectDelay.current = INITIAL_RECONNECT_DELAY; // Reset backoff on success
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data) as BotStreamEvent;
          setLastEvent(data);

          if (data.type === 'connected') {
            setIsConnected(true);
          } else if (data.type === 'activity') {
            onActivityRef.current?.(data);
          } else if (data.type === 'status_change') {
            onStatusChangeRef.current?.(data.status || '');
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;
        setIsConnected(false);

        // Don't reconnect on auth failures (4001-4003)
        if (event.code >= 4001 && event.code <= 4003) return;

        // Exponential backoff reconnect
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) {
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_DELAY);
            connect();
          }
        }, reconnectDelay.current);
      };

      ws.onerror = () => {
        // onclose will fire after onerror, handling reconnect
      };
    } catch {
      // Connection failed, will retry via onclose
    }
  }, [botId, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [connect]);

  return { isConnected, lastEvent };
}
