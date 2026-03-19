// =============================================================================
// SkeletonLoader — shimmer/pulse placeholder for loading states
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, ViewStyle } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, borderRadius } from '../theme/spacing';

interface SkeletonLoaderProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export default function SkeletonLoader({
  width = 100,
  height = 20,
  borderRadius: radius = 6,
  style,
}: SkeletonLoaderProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        {
          width: width as number,
          height,
          borderRadius: radius,
          backgroundColor: colors.bg.elevated,
          opacity,
        },
        style,
      ]}
    />
  );
}

/**
 * SkeletonCard — a card-shaped skeleton with a few placeholder lines inside.
 * Use as a drop-in loading placeholder for list items or detail cards.
 */
export function SkeletonCard({ style }: { style?: ViewStyle }) {
  return (
    <View style={[cardStyles.card, style]}>
      <SkeletonLoader width="60%" height={16} borderRadius={4} />
      <SkeletonLoader width="90%" height={12} borderRadius={4} style={{ marginTop: spacing.sm }} />
      <SkeletonLoader width="75%" height={12} borderRadius={4} style={{ marginTop: spacing.xs }} />
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    width: '100%',
    height: 80,
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    justifyContent: 'center',
  },
});
