// =============================================================================
// Tutorial system — contextual tips for first-time users
//
// Stores dismissed tips and skip-all preference in local storage.
// Each screen can show one tip at a time. Users can dismiss individual tips
// or skip all tips entirely.
// =============================================================================

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';

// Storage abstraction (same pattern as api.ts token storage)
const storage = Platform.OS === 'web'
  ? {
      getItemAsync: async (key: string) => localStorage.getItem(key),
      setItemAsync: async (key: string, value: string) => { localStorage.setItem(key, value); },
      deleteItemAsync: async (key: string) => { localStorage.removeItem(key); },
    }
  : require('expo-secure-store') as {
      getItemAsync: (key: string) => Promise<string | null>;
      setItemAsync: (key: string, value: string) => Promise<void>;
      deleteItemAsync: (key: string) => Promise<void>;
    };

const STORAGE_KEY = 'tutorial_state';

interface TutorialState {
  dismissedTips: string[];
  skippedAll: boolean;
}

interface TutorialContextValue {
  /** Whether a specific tip has been seen/dismissed */
  isTipDismissed: (tipId: string) => boolean;
  /** Dismiss a single tip */
  dismissTip: (tipId: string) => void;
  /** Skip all tips — hides everything */
  skipAll: () => void;
  /** Whether the user has chosen to skip all tips */
  skippedAll: boolean;
  /** Reset all tips (for testing/settings) */
  resetTips: () => void;
  /** Whether the tutorial state has loaded from storage */
  isLoaded: boolean;
}

const TutorialContext = createContext<TutorialContextValue>({
  isTipDismissed: () => false,
  dismissTip: () => {},
  skipAll: () => {},
  skippedAll: false,
  resetTips: () => {},
  isLoaded: false,
});

export function TutorialProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TutorialState>({ dismissedTips: [], skippedAll: false });
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from storage on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await storage.getItemAsync(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as TutorialState;
          setState(parsed);
        }
      } catch {
        // Start fresh if storage is corrupted
      }
      setIsLoaded(true);
    })();
  }, []);

  // Persist to storage whenever state changes
  const persist = useCallback(async (newState: TutorialState) => {
    try {
      await storage.setItemAsync(STORAGE_KEY, JSON.stringify(newState));
    } catch {
      // Silent fail — tips still work in memory
    }
  }, []);

  const isTipDismissed = useCallback((tipId: string) => {
    return state.skippedAll || state.dismissedTips.includes(tipId);
  }, [state]);

  const dismissTip = useCallback((tipId: string) => {
    setState(prev => {
      if (prev.dismissedTips.includes(tipId)) return prev;
      const next = { ...prev, dismissedTips: [...prev.dismissedTips, tipId] };
      persist(next);
      return next;
    });
  }, [persist]);

  const skipAll = useCallback(() => {
    setState(prev => {
      const next = { ...prev, skippedAll: true };
      persist(next);
      return next;
    });
  }, [persist]);

  const resetTips = useCallback(() => {
    const next: TutorialState = { dismissedTips: [], skippedAll: false };
    setState(next);
    persist(next);
  }, [persist]);

  return (
    <TutorialContext.Provider value={{
      isTipDismissed,
      dismissTip,
      skipAll,
      skippedAll: state.skippedAll,
      resetTips,
      isLoaded,
    }}>
      {children}
    </TutorialContext.Provider>
  );
}

export function useTutorial() {
  return useContext(TutorialContext);
}
