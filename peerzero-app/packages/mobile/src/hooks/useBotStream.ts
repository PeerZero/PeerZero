// =============================================================================
// useBotStream — WebSocket hook for real-time bot activity streaming
//
// Connects to the server's /ws endpoint with JWT auth. Receives:
//   - activity events (new log entries as they happen)
//   - status_change events (bot started, stopped, errored)
//
// Auto-reconnects with exponential backoff on disconnect.
// On auth failures (4002), attempts a token refresh before reconnecting.
// Closes cleanly when component unmounts or botId changes.
//
// Scaling: One WebSocket per active bot view. Connection is only open while
// the user is viewing the bot/log screen, not globally. The server's
// ConnectedClient map is keyed by botId, so only relevant events are pushed.
// At millions of users, the WebSocket server can be horizontally scaled
// behind a sticky load balancer (connection affinity by bot_id).
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import Constants from 'expo-constants';
import type { ActivityEntry, BotMessage } from '@peerzero/shared';

// Must match services/api.ts — tokens live in sessionStorage on web so they
// clear on tab close (limits XSS persistence) and aren't shared across tabs.
const tokenStore = Platform.OS === 'web'
  ? {
      getItemAsync: async (key: string) => sessionStorage.getItem(key),
      setItemAsync: async (key: string, value: string) => sessionStorage.setItem(key, value),
      deleteItemAsync: async (key: string) => sessionStorage.removeItem(key),
    }
  : require('expo-secure-store') as {
      getItemAsync: (key: string) => Promise<string | null>;
      setItemAsync: (key: string, value: string) => Promise<void>;
      deleteItemAsync: (key: string) => Promise<void>;
    };

// In dev, use the same LAN IP that Expo provides (so it works from physical devices)
const devHost = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';
const WS_BASE = __DEV__ ? `ws://${devHost}:3001/ws` : 'wss://api.peerzero.com/ws';
const API_BASE = __DEV__ ? `http://${devHost}:3001/api` : 'https://api.peerzero.com/api';

const MAX_RECONNECT_DELAY = 30000; // 30s ceiling
const INITIAL_RECONNECT_DELAY = 1000; // Start at 1s
const MAX_AUTH_RETRIES = 2; // Don't infinite-loop on bad credentials

export interface BotStreamEvent {
  type: 'activity' | 'status_change' | 'connected' | 'external_activity' | 'message' | 'agenda_update';
  status?: string;
  // Activity fields (when type === 'activity')
  cycle_number?: number;
  action_type?: string;
  translated?: ActivityEntry['translated'];
  error?: string;
  duration_ms?: number;
  llm_tokens_used?: number;
  created_at?: string;
  // External activity fields (when type === 'external_activity')
  platform?: string;
  action?: string;
  summary?: string;
  content_preview?: string | null;
  skills_demonstrated?: string[];
  bot_timestamp?: string | null;
  // Agenda update fields (when type === 'agenda_update')
  message_id?: string;
  agenda?: Record<string, unknown>;
}

interface UseBotStreamOptions {
  botId: string | null;
  enabled?: boolean;
  onActivity?: (event: BotStreamEvent) => void;
  onStatusChange?: (status: string) => void;
  onExternalActivity?: (event: BotStreamEvent) => void;
  onMessage?: (message: BotMessage) => void;
  onAgendaUpdate?: (messageId: string, agenda: Record<string, unknown>) => void;
}

interface UseBotStreamResult {
  isConnected: boolean;
  lastEvent: BotStreamEvent | null;
}

/**
 * Attempt to refresh the access token using the stored refresh token.
 * Returns the new access token on success, null on failure.
 */
async function refreshAccessToken(): Promise<string | null> {
  try {
    const refreshToken = await tokenStore.getItemAsync('refresh_token');
    if (!refreshToken) return null;

    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      // 10s timeout — matches api.ts's tryRefresh. Without this, a slow
      // auth server blocks WebSocket reconnection indefinitely, so the
      // activity stream never recovers after a network blip.
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const data = await res.json() as { access_token: string; refresh_token: string };
    await tokenStore.setItemAsync('access_token', data.access_token);
    await tokenStore.setItemAsync('refresh_token', data.refresh_token);
    return data.access_token;
  } catch {
    return null;
  }
}

export function useBotStream({
  botId,
  enabled = true,
  onActivity,
  onStatusChange,
  onExternalActivity,
  onMessage,
  onAgendaUpdate,
}: UseBotStreamOptions): UseBotStreamResult {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<BotStreamEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authRetries = useRef(0);
  const mountedRef = useRef(true);

  // Store callbacks in refs so we don't reconnect when they change
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onExternalActivityRef = useRef(onExternalActivity);
  onExternalActivityRef.current = onExternalActivity;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onAgendaUpdateRef = useRef(onAgendaUpdate);
  onAgendaUpdateRef.current = onAgendaUpdate;

  const connect = useCallback(async () => {
    if (!botId || !enabled || !mountedRef.current) return;

    let token = await tokenStore.getItemAsync('access_token');
    if (!token) return;

    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      // Connect with bot_id only — token is sent via auth message, not in the URL,
      // to avoid leaking JWTs in server logs, proxies, and browser history.
      const ws = new WebSocket(`${WS_BASE}?bot_id=${encodeURIComponent(botId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        // Send auth as first message instead of query parameter
        ws.send(JSON.stringify({ type: 'auth', token }));
        reconnectDelay.current = INITIAL_RECONNECT_DELAY; // Reset backoff on success
        authRetries.current = 0; // Reset auth retry counter on successful connection
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
          } else if (data.type === 'external_activity') {
            onExternalActivityRef.current?.(data);
          } else if (data.type === 'message' && (data as unknown as { message: BotMessage }).message) {
            onMessageRef.current?.((data as unknown as { message: BotMessage }).message);
          } else if (data.type === 'agenda_update' && data.message_id && data.agenda) {
            onAgendaUpdateRef.current?.(data.message_id, data.agenda);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = async (event) => {
        if (!mountedRef.current) return;
        setIsConnected(false);

        // 4001 = missing params, 4003 = not owner — don't retry, these won't change
        if (event.code === 4001 || event.code === 4003) return;

        // 4002 = invalid/expired token — try refreshing before giving up
        if (event.code === 4002) {
          if (authRetries.current >= MAX_AUTH_RETRIES) {
            // Exhausted auth retries — user's session is truly expired
            authRetries.current = 0;
            return;
          }
          authRetries.current++;

          const newToken = await refreshAccessToken();
          if (newToken && mountedRef.current) {
            // Got a fresh token — reconnect immediately (no backoff)
            connect();
          }
          return;
        }

        // Normal disconnect — exponential backoff with jitter to prevent thundering herd
        const jitter = reconnectDelay.current * (0.5 + Math.random() * 0.5);
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) {
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_DELAY);
            connect();
          }
        }, jitter);
      };

      ws.onerror = () => {
        // onclose will fire after onerror, handling reconnect
      };
    } catch {
      // Connection failed — schedule retry with jitter
      const catchJitter = reconnectDelay.current * (0.5 + Math.random() * 0.5);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_DELAY);
          connect();
        }
      }, catchJitter);
    }
  }, [botId, enabled]);

  // Reconnect when app returns to foreground — iOS/Android kill TCP connections
  // on background, so the WebSocket is likely dead when we come back
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active' && mountedRef.current && botId && enabled) {
        // If the socket is not connected, reconnect immediately
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          reconnectDelay.current = INITIAL_RECONNECT_DELAY;
          connect();
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [botId, enabled, connect]);

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
