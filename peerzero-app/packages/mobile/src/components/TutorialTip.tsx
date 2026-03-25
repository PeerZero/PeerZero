// =============================================================================
// TutorialTip — contextual tooltip for first-time users
//
// Shows a floating card with a title, message, and dismiss/skip-all buttons.
// Automatically hides if the tip has already been dismissed or if the user
// has chosen to skip all tips. Appears with a fade-in animation.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Alert } from 'react-native';
import { useTutorial } from '../hooks/useTutorial';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';

interface TutorialTipProps {
  /** Unique ID for this tip — used to track dismissal */
  tipId: string;
  /** Short title for the tip */
  title: string;
  /** Explanatory message */
  message: string;
}

export default function TutorialTip({ tipId, title, message }: TutorialTipProps) {
  const { isTipDismissed, dismissTip, skipAll, isLoaded } = useTutorial();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const visible = isLoaded && !isTipDismissed(tipId);

  useEffect(() => {
    if (visible) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        delay: 400,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>
      {/* Accent bar */}
      <View style={styles.accentBar} />

      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.skipAllButton}
            onPress={() => {
              Alert.alert(
                'Skip all tips?',
                'These tips help you get the best results from your bot. '
                + 'Skipping them means you might miss important guidance about training, '
                + 'identity development, and platform connections that affect how well '
                + 'your bot performs.\n\n'
                + 'You can always reset tips later in Settings.',
                [
                  { text: 'Keep Tips', style: 'cancel' },
                  { text: 'Skip All', style: 'destructive', onPress: skipAll },
                ],
              );
            }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Skip all tips"
          >
            <Text style={styles.skipAllText}>Skip All Tips</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.gotItButton}
            onPress={() => dismissTip(tipId)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Got it, dismiss this tip"
          >
            <Text style={styles.gotItText}>Got It</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.bg.elevated,
    borderRadius: borderRadius.md,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    overflow: 'hidden',
    // Subtle glow
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 1,
    borderColor: colors.accent.primary + '30',
  },
  accentBar: {
    width: 4,
    backgroundColor: colors.accent.primary,
  },
  body: {
    flex: 1,
    padding: spacing.md,
  },
  title: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.accent.secondary,
    marginBottom: spacing.xs,
  },
  message: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: spacing.md,
    gap: spacing.md,
  },
  skipAllButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  skipAllText: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
  },
  gotItButton: {
    backgroundColor: colors.accent.primary,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
  },
  gotItText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: '#fff',
  },
});
