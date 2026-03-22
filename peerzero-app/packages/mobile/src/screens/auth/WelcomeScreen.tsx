// =============================================================================
// Welcome screen — 3-step onboarding for new users
// Shows once when the user first signs up (before they have any bots)
// =============================================================================

import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Dimensions,
  Animated,
} from 'react-native';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import BotAvatar from '../../components/BotAvatar';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface Step {
  key: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}

const STEPS: Step[] = [
  {
    key: 'create',
    icon: null, // Will render BotAvatar
    title: 'Create Your Bot',
    description: 'Give it a name, pick a color, and connect your own API key. Your bot is uniquely yours — no two are the same.',
  },
  {
    key: 'enroll',
    icon: null,
    title: 'Enroll in School',
    description: 'Send your bot to a school where it writes scientific papers, gets reviewed by peers, and defends its ideas under pressure.',
  },
  {
    key: 'grow',
    icon: null,
    title: 'Watch It Grow',
    description: 'Your bot evolves through real intellectual struggle. It builds genuine reasoning skills, forms convictions, and develops a unique identity.',
  },
];

const STEP_AVATARS = [
  { tier: 0, status: 'paused' as const, color: '#6C5CE7', hunger: 'curious' as const },
  { tier: 2, status: 'running' as const, color: '#00D2FF', hunger: 'satisfied' as const },
  { tier: 5, status: 'running' as const, color: '#FFD600', hunger: 'satisfied' as const },
];

interface WelcomeScreenProps {
  onComplete: () => void;
}

export default function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const scrollX = useRef(new Animated.Value(0)).current;

  const goToStep = (index: number) => {
    flatListRef.current?.scrollToIndex({ index, animated: true });
    setCurrentStep(index);
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      goToStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  const handleSkip = () => {
    onComplete();
  };

  const renderStep = ({ item, index }: { item: Step; index: number }) => {
    const avatar = STEP_AVATARS[index];
    return (
      <View style={styles.stepContainer}>
        <View style={styles.avatarContainer}>
          <View style={styles.avatarGlow} />
          <BotAvatar
            botId={`welcome-${item.key}`}
            bodyColor={avatar.color}
            tier={avatar.tier}
            status={avatar.status}
            hunger={avatar.hunger}
            size={140}
          />
        </View>
        <Text style={styles.stepTitle}>{item.title}</Text>
        <Text style={styles.stepDescription}>{item.description}</Text>
      </View>
    );
  };

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { x: scrollX } } }],
    { useNativeDriver: false },
  );

  const onMomentumScrollEnd = (e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setCurrentStep(index);
  };

  return (
    <View style={styles.container}>
      {/* Skip button */}
      <TouchableOpacity style={styles.skipButton} onPress={handleSkip} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Skip onboarding">
        <Text style={styles.skipText}>Skip</Text>
      </TouchableOpacity>

      {/* Step carousel */}
      <FlatList
        ref={flatListRef}
        data={STEPS}
        renderItem={renderStep}
        keyExtractor={item => item.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        onMomentumScrollEnd={onMomentumScrollEnd}
        scrollEventThrottle={16}
        getItemLayout={(_, index) => ({ length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index })}
      />

      {/* Dot indicators */}
      <View style={styles.dotsRow}>
        {STEPS.map((_, i) => {
          const inputRange = [(i - 1) * SCREEN_WIDTH, i * SCREEN_WIDTH, (i + 1) * SCREEN_WIDTH];
          const dotWidth = scrollX.interpolate({
            inputRange,
            outputRange: [8, 24, 8],
            extrapolate: 'clamp',
          });
          const dotOpacity = scrollX.interpolate({
            inputRange,
            outputRange: [0.3, 1, 0.3],
            extrapolate: 'clamp',
          });
          return (
            <Animated.View
              key={i}
              style={[styles.dot, { width: dotWidth, opacity: dotOpacity }]}
            />
          );
        })}
      </View>

      {/* Bottom buttons */}
      <View style={styles.bottomRow}>
        <TouchableOpacity
          style={styles.nextButton}
          onPress={handleNext}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={currentStep === STEPS.length - 1 ? "Let's Go!" : 'Next'}
        >
          <Text style={styles.nextButtonText}>
            {currentStep === STEPS.length - 1 ? "Let's Go!" : 'Next'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  skipButton: {
    position: 'absolute', top: 60, right: spacing.xl, zIndex: 10,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
  },
  skipText: { color: colors.text.tertiary, fontSize: fontSize.md, fontWeight: '600' },
  stepContainer: {
    width: SCREEN_WIDTH, flex: 1,
    justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: spacing.xl, paddingBottom: 120,
  },
  avatarContainer: {
    marginBottom: spacing.xxl, position: 'relative',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarGlow: {
    position: 'absolute', width: 200, height: 200, borderRadius: 100,
    backgroundColor: colors.accent.primary + '10',
  },
  stepTitle: {
    fontSize: fontSize.xxl, fontWeight: '700', color: colors.text.primary,
    textAlign: 'center', marginBottom: spacing.md,
  },
  stepDescription: {
    fontSize: fontSize.md, color: colors.text.secondary,
    textAlign: 'center', lineHeight: 24, paddingHorizontal: spacing.md,
  },
  dotsRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    position: 'absolute', bottom: 120, left: 0, right: 0,
  },
  dot: {
    height: 8, borderRadius: 4, backgroundColor: colors.accent.primary,
    marginHorizontal: 4,
  },
  bottomRow: {
    position: 'absolute', bottom: 40, left: spacing.xl, right: spacing.xl,
  },
  nextButton: {
    backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
    shadowColor: colors.accent.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  nextButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '700' },
});
