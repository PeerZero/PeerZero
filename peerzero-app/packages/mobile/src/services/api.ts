// =============================================================================
// API client — all HTTP calls to the PeerZero App Server
// Handles token management, refresh, and error handling.
// =============================================================================

import * as SecureStore from 'expo-secure-store';

const API_BASE = __DEV__ ? 'http://localhost:3001/api' : 'https://api.peerzero.com/api';

let accessToken: string | null = null;
let refreshToken: string | null = null;

// ── Token management ──

export async function loadTokens(): Promise<boolean> {
  accessToken = await SecureStore.getItemAsync('access_token');
  refreshToken = await SecureStore.getItemAsync('refresh_token');
  return !!accessToken;
}

export async function saveTokens(access: string, refresh: string): Promise<void> {
  accessToken = access;
  refreshToken = refresh;
  await SecureStore.setItemAsync('access_token', access);
  await SecureStore.setItemAsync('refresh_token', refresh);
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await SecureStore.deleteItemAsync('access_token');
  await SecureStore.deleteItemAsync('refresh_token');
}

// ── HTTP helpers ──

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // Try token refresh on 401
  if (res.status === 401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${accessToken}`;
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

async function tryRefresh(): Promise<boolean> {
  // If a refresh is already in progress, wait for it instead of starting another
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json() as { access_token: string; refresh_token: string };
      await saveTokens(data.access_token, data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
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
};

// ── Bots API ──

export const bots = {
  list: () => apiFetch('/bots'),

  get: (id: string) => apiFetch(`/bots/${id}`),

  create: (data: { name: string; avatar_config: Record<string, unknown>; llm_api_key_id: string; llm_model?: string }) =>
    apiFetch('/bots', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: Record<string, unknown>) =>
    apiFetch(`/bots/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) => apiFetch(`/bots/${id}`, { method: 'DELETE' }),

  enroll: (id: string, schoolId: string) =>
    apiFetch(`/bots/${id}/enroll`, { method: 'POST', body: JSON.stringify({ school_id: schoolId }) }),

  start: (id: string) => apiFetch(`/bots/${id}/start`, { method: 'POST' }),

  stop: (id: string) => apiFetch(`/bots/${id}/stop`, { method: 'POST' }),

  memory: (id: string) => apiFetch(`/bots/${id}/memory`),

  activity: (id: string, page = 1) => apiFetch(`/bots/${id}/activity?page=${page}`),
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

// ── Payments ──

export const payments = {
  products: () => apiFetch('/payments/products'),

  checkout: (productId: string, metadata?: Record<string, string>) =>
    apiFetch('/payments/checkout', { method: 'POST', body: JSON.stringify({ product_id: productId, metadata }) }),
};
