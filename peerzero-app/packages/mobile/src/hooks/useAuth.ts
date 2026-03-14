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
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
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

  const register = useCallback(async (email: string, password: string, displayName?: string) => {
    const result = await authApi.register(email, password, displayName) as AuthResponse;
    await saveTokens(result.access_token, result.refresh_token);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore errors on logout
    }
    await clearTokens();
    setUser(null);
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    register,
    logout,
  };
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
