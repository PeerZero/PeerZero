// =============================================================================
// Auth hook — manages authentication state for the whole app
// =============================================================================

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { auth as authApi, loadTokens, saveTokens, clearTokens } from '../services/api';
import type { UserProfile, AuthResponse } from '@peerzero/shared';

interface AuthState {
  user: UserProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string, ageGroup?: string, parentEmail?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
  refreshUser: async () => {},
});

export function useAuthProvider(): AuthState {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    (async () => {
      const hasTokens = await loadTokens();
      if (hasTokens) {
        try {
          const profile = await authApi.me() as UserProfile;
          setUser(profile);
        } catch {
          await clearTokens();
        }
      }
      setIsLoading(false);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password) as AuthResponse;
    await saveTokens(result.access_token, result.refresh_token);
    setUser(result.user);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName?: string, ageGroup?: string, parentEmail?: string) => {
    const result = await authApi.register(email, password, displayName, ageGroup, parentEmail) as AuthResponse;
    // If consent_pending, don't save tokens (they won't be there)
    if ((result as any).consent_pending) {
      return; // Let the UI handle the pending state
    }
    await saveTokens(result.access_token, result.refresh_token);
    setUser(result.user);
  }, []);

  // ⚠️ REVIEW NOTE (intentional design): The catch blocks below intentionally
  // swallow errors. Logout must always clear local state even if the server
  // call fails (network down, token already expired). refreshUser is a
  // background refresh — failing silently is correct because the UI will
  // retry on next navigation. Surfacing these errors would show confusing
  // alerts during normal offline/token-expiry scenarios.
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Intentional: always clear local state regardless of server response
    }
    await clearTokens();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const profile = await authApi.me() as UserProfile;
      setUser(profile);
    } catch {
      // Intentional: background refresh — retried on next navigation
    }
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    register,
    logout,
    refreshUser,
  };
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
