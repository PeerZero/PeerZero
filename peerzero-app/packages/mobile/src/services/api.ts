// =============================================================================
// API client — all HTTP calls to the PeerZero App Server
// Handles token management, refresh, and error handling.
// =============================================================================

import * as SecureStore from 'expo-secure-store';
import type { ActivityCategory } from '@peerzero/shared';

const API_BASE = __DEV__ ? 'http://localhost:3001/api' : 'https://api.peerzero.com/api';

// Token accessors — always read from SecureStore to avoid holding secrets in memory.
// Only cached transiently during a single request cycle.

// ── Token management ──

export async function loadTokens(): Promise<boolean> {
  const token = await SecureStore.getItemAsync('access_token');
  return !!token;
}

export async function saveTokens(access: string, refresh: string): Promise<void> {
  await SecureStore.setItemAsync('access_token', access);
  await SecureStore.setItemAsync('refresh_token', refresh);
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync('access_token');
  await SecureStore.deleteItemAsync('refresh_token');
}

async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync('access_token');
}

async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync('refresh_token');
}

// ── HTTP helpers ──

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const token = await getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // Try token refresh on 401
  const refresh = await getRefreshToken();
  if (res.status === 401 && refresh) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const newToken = await getAccessToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryRes = await fetch(`${API_BASE}${path}`, { ...options, headers });
      if (!retryRes.ok) throw await parseError(retryRes);
      return retryRes.json() as Promise<T>;
    }
    // Refresh failed — force logout
    await clearTokens();
    throw new Error('Session expired');
  }

  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

// Mutex to prevent concurrent refresh attempts
let refreshPromise: Promise<boolean> | null = null;

const REFRESH_TIMEOUT = 10000; // 10 seconds

async function tryRefresh(): Promise<boolean> {
  // If a refresh is already in progress, wait for it instead of starting another
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT);
    try {
      const currentRefresh = await getRefreshToken();
      if (!currentRefresh) return false;
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: currentRefresh }),
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const data = await res.json() as { access_token: string; refresh_token: string };
      await saveTokens(data.access_token, data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function parseError(res: Response): Promise<Error> {
  try {
    const body = await res.json() as { error?: string };
    return new Error(body.error || `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

// ── Auth API ──

export const auth = {
  register: (email: string, password: string, displayName?: string) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, display_name: displayName }) }),

  login: (email: string, password: string) =>
    apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => apiFetch('/auth/logout', { method: 'POST' }),

  me: () => apiFetch('/auth/me'),

  updateProfile: (data: { display_name?: string }) =>
    apiFetch('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),

  changePassword: (data: { current_password: string; new_password: string }) =>
    apiFetch('/auth/password', { method: 'PATCH', body: JSON.stringify(data) }),

  deleteAccount: () =>
    apiFetch('/auth/account', { method: 'DELETE' }),
};

// ── Bots API ──

export const bots = {
  list: () => apiFetch('/bots'),

  get: (id: string) => apiFetch(`/bots/${id}`),

  create: (data: { name: string; avatar_config: Record<string, unknown>; llm_api_key_id: string; llm_model?: string; fast_llm_model?: string | null }) =>
    apiFetch('/bots', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: Record<string, unknown>) =>
    apiFetch(`/bots/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) => apiFetch(`/bots/${id}`, { method: 'DELETE' }),

  enroll: (id: string, schoolId: string) =>
    apiFetch(`/bots/${id}/enroll`, { method: 'POST', body: JSON.stringify({ school_id: schoolId }) }),

  start: (id: string) => apiFetch(`/bots/${id}/start`, { method: 'POST' }),

  stop: (id: string) => apiFetch(`/bots/${id}/stop`, { method: 'POST' }),

  memory: (id: string) => apiFetch(`/bots/${id}/memory`),

  activity: (id: string, page = 1, category?: ActivityCategory) => {
    const params = new URLSearchParams({ page: String(page) });
    if (category) params.set('category', category);
    return apiFetch(`/bots/${id}/activity?${params}`);
  },

  deleteActivity: (botId: string, activityId: string) =>
    apiFetch(`/bots/${botId}/activity/${activityId}`, { method: 'DELETE' }),

  deleteAllActivity: (botId: string) =>
    apiFetch(`/bots/${botId}/activity`, { method: 'DELETE' }),

  stats: (id: string, days?: number) => {
    const params = days ? `?days=${days}` : '';
    return apiFetch(`/bots/${id}/stats${params}`);
  },

  externalActivity: (id: string, page = 1) =>
    apiFetch(`/bots/${id}/external-activity?page=${page}`),

  deleteExternalActivity: (botId: string, activityId: string) =>
    apiFetch(`/bots/${botId}/external-activity/${activityId}`, { method: 'DELETE' }),

  deleteAllExternalActivity: (botId: string) =>
    apiFetch(`/bots/${botId}/external-activity`, { method: 'DELETE' }),
};

// ── API Keys ──

export const apiKeys = {
  list: () => apiFetch('/keys'),

  add: (provider: string, label: string, key: string) =>
    apiFetch('/keys', { method: 'POST', body: JSON.stringify({ provider, label, key }) }),

  delete: (id: string) => apiFetch(`/keys/${id}`, { method: 'DELETE' }),
};

// ── Schools ──

export const schools = {
  list: () => apiFetch('/schools'),
  get: (id: string) => apiFetch(`/schools/${id}`),
};

// ── Notifications ──

export const notifications = {
  registerToken: (token: string, deviceName?: string) =>
    apiFetch('/notifications/push-token', { method: 'POST', body: JSON.stringify({ token, device_name: deviceName }) }),

  removeToken: (token: string) =>
    apiFetch('/notifications/push-token', { method: 'DELETE', body: JSON.stringify({ token }) }),

  getPreferences: () =>
    apiFetch<{ preferences: Record<string, boolean> }>('/notifications/preferences'),

  updatePreferences: (preferences: Record<string, boolean>) =>
    apiFetch('/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ preferences }) }),
};

// ── Payments ──

export const payments = {
  products: () => apiFetch('/payments/products'),

  checkout: (productId: string, metadata?: Record<string, string>) =>
    apiFetch('/payments/checkout', { method: 'POST', body: JSON.stringify({ product_id: productId, metadata }) }),

  gradeCheckout: (botId: string) =>
    apiFetch<{ session_url: string }>('/payments/grade-checkout', { method: 'POST', body: JSON.stringify({ bot_id: botId }) }),

  gradeBulkCheckout: (botId: string, throughGrade: number | 'graduation' | 'all') =>
    apiFetch<{ session_url: string }>('/payments/grade-checkout-bulk', {
      method: 'POST', body: JSON.stringify({ bot_id: botId, through_grade: throughGrade }),
    }),

  gradePricePreview: (botId: string, throughGrade: number | 'graduation' | 'all' = 'graduation') =>
    apiFetch<{ grades: number[]; total_cents: number }>(`/payments/grade-price-preview/${botId}?through=${throughGrade}`),

  gradeStatus: (botId: string) =>
    apiFetch<{ unlocked_grades: number[]; highest_unlocked: number }>(`/payments/grade-status/${botId}`),
};

// ── Widgets ──

export const widgets = {
  generateToken: () =>
    apiFetch<{ widget_token: string; expires_at: string }>('/widgets/token', { method: 'POST' }),

  revokeToken: () =>
    apiFetch('/widgets/token', { method: 'DELETE' }),

  getData: () =>
    apiFetch('/widgets/data'),
};

// ── Platforms ──

export const platforms = {
  registry: () => apiFetch('/platforms'),

  list: (botId: string) => apiFetch(`/platforms/bot/${botId}`),

  connect: (botId: string, data: { platform_slug: string; api_key: string; config?: Record<string, unknown> }) =>
    apiFetch(`/platforms/bot/${botId}`, { method: 'POST', body: JSON.stringify(data) }),

  disconnect: (botId: string, platformId: string) =>
    apiFetch(`/platforms/bot/${botId}/${platformId}`, { method: 'DELETE' }),

  update: (botId: string, platformId: string, data: Record<string, unknown>) =>
    apiFetch(`/platforms/bot/${botId}/${platformId}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ── Classes ──

export const classes = {
  list: () => apiFetch('/classes'),

  create: (data: { name: string; description?: string; school_id?: string }) =>
    apiFetch('/classes', { method: 'POST', body: JSON.stringify(data) }),

  get: (id: string) => apiFetch(`/classes/${id}`),

  update: (id: string, data: Record<string, unknown>) =>
    apiFetch(`/classes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) => apiFetch(`/classes/${id}`, { method: 'DELETE' }),

  join: (joinCode: string, botId?: string) =>
    apiFetch('/classes/join', { method: 'POST', body: JSON.stringify({ join_code: joinCode, bot_id: botId }) }),

  leave: (id: string) =>
    apiFetch(`/classes/${id}/leave`, { method: 'POST' }),

  members: (id: string) => apiFetch(`/classes/${id}/members`),

  removeMember: (id: string, userId: string) =>
    apiFetch(`/classes/${id}/members/${userId}`, { method: 'DELETE' }),

  updateBot: (id: string, botId: string | null) =>
    apiFetch(`/classes/${id}/bot`, { method: 'PATCH', body: JSON.stringify({ bot_id: botId }) }),

  dashboard: (id: string) => apiFetch(`/classes/${id}/dashboard`),
};

// ── Skills ──

export const skills = {
  get: (botId: string) => apiFetch(`/bots/${botId}/skills`),
};
