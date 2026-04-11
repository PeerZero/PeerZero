// =============================================================================
// API client — all HTTP calls to the PeerZero App Server
// Handles token management, refresh, and error handling.
// =============================================================================

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { ActivityCategory } from '@peerzero/shared';

// In dev, Expo's debuggerHost gives us the computer's IP (e.g. "192.168.1.5:8081")
const devHost = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';
const API_BASE = __DEV__ ? `http://${devHost}:3001/api` : 'https://api.peerzero.com/api';

// Token storage — use SecureStore on native, sessionStorage on web.
// SECURITY: sessionStorage is preferred over localStorage because:
//   - Tokens are cleared when the tab/window closes (limits XSS exposure window)
//   - Not shared across tabs (limits blast radius of a compromised tab)
// For stronger protection, migrate to httpOnly Secure cookies with SameSite=Strict.
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

// ── Token management ──

export async function loadTokens(): Promise<boolean> {
  const token = await tokenStore.getItemAsync('access_token');
  return !!token;
}

export async function saveTokens(access: string, refresh: string): Promise<void> {
  await tokenStore.setItemAsync('access_token', access);
  await tokenStore.setItemAsync('refresh_token', refresh);
}

export async function clearTokens(): Promise<void> {
  await tokenStore.deleteItemAsync('access_token');
  await tokenStore.deleteItemAsync('refresh_token');
}

async function getAccessToken(): Promise<string | null> {
  return tokenStore.getItemAsync('access_token');
}

async function getRefreshToken(): Promise<string | null> {
  return tokenStore.getItemAsync('refresh_token');
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

  const promise = (async () => {
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

  // Assign before awaiting so concurrent callers see the same promise
  refreshPromise = promise;
  return promise;
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
  register: (email: string, password: string, displayName?: string, ageGroup?: string, parentEmail?: string) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, display_name: displayName, age_group: ageGroup || 'adult', parent_email: parentEmail }) }),

  verifyParentalConsent: (token: string) =>
    apiFetch('/auth/parental-consent/verify', { method: 'POST', body: JSON.stringify({ token }) }),

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

  forgotPassword: (email: string) =>
    apiFetch<{ message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  resetPassword: (email: string, code: string, newPassword: string) =>
    apiFetch<{ message: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, code, new_password: newPassword }) }),
};

// ── Bots API ──

export const bots = {
  list: () => apiFetch('/bots'),

  get: (id: string) => apiFetch(`/bots/${id}`),

  create: (data: { name: string; avatar_config: Record<string, unknown>; llm_api_key_id: string; llm_model?: string; extended_thinking?: boolean }) =>
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

  publicProfile: (slug: string) =>
    apiFetch(`/bots/public/${slug}`),

  speak: (id: string, context: string) =>
    apiFetch(`/bots/${id}/speak`, { method: 'POST', body: JSON.stringify({ context }) }),

  messages: (id: string, page = 1) =>
    apiFetch(`/bots/${id}/messages?page=${page}`),

  sendMessage: (id: string, content: string) =>
    apiFetch(`/bots/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),

  tasks: (id: string, opts?: { direction?: string; status?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.direction) params.set('direction', opts.direction);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return apiFetch(`/bots/${id}/tasks?${params.toString()}`);
  },

  cancelTask: (botId: string, requestId: string) =>
    apiFetch(`/bots/${botId}/tasks/${requestId}/cancel`, { method: 'POST' }),
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

// ── Skills ──

export const skills = {
  get: (botId: string) => apiFetch(`/bots/${botId}/skills`),
};
