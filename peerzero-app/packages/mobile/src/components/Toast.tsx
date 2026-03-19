// =============================================================================
// Toast notification system — lightweight replacement for Alert.alert on success
// =============================================================================

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';

type ToastType = 'success' | 'error' | 'info';

interface ToastState {
  message: string;
  type: ToastType;
  id: number;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 2500;

const TYPE_CONFIG: Record<ToastType, { borderColor: string; iconBg: string; icon: string }> = {
  success: {
    borderColor: colors.accent.success,
    iconBg: colors.accent.success + '20',
    icon: '\u2713',
  },
  error: {
    borderColor: colors.accent.error,
    iconBg: colors.accent.error + '20',
    icon: '!',
  },
  info: {
    borderColor: colors.accent.secondary,
    iconBg: colors.accent.secondary + '20',
    icon: 'i',
  },
};

function ToastView({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(-80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Slide in
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-dismiss
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: -80,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => onDone());
    }, TOAST_DURATION);

    return () => clearTimeout(timer);
  }, []);

  const config = TYPE_CONFIG[toast.type];

  return (
    <Animated.View
      style={[
        styles.toastContainer,
        {
          top: insets.top + spacing.sm,
          transform: [{ translateY }],
          opacity,
          borderLeftColor: config.borderColor,
        },
      ]}
      pointerEvents="none"
    >
      <View style={[styles.iconArea, { backgroundColor: config.iconBg }]}>
        <Text style={[styles.iconText, { color: config.borderColor }]}>{config.icon}</Text>
      </View>
      <Text style={styles.messageText} numberOfLines={2}>
        {toast.message}
      </Text>
    </Animated.View>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const idRef = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    idRef.current += 1;
    setToast({ message, type, id: idRef.current });
  }, []);

  const handleDone = useCallback(() => {
    setToast(null);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && <ToastView key={toast.id} toast={toast} onDone={handleDone} />}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

const styles = StyleSheet.create({
  toastContainer: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    zIndex: 9999,
    elevation: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
    }),
  },
  iconArea: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  iconText: {
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  messageText: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.text.primary,
    fontWeight: '500',
  },
});
