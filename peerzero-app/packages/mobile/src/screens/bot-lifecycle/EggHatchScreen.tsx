// =============================================================================
// EggHatchScreen — The emotional moment where your bot comes alive
//
// After creation, the user sees their egg. They tap to hatch it. Cracks spread.
// Light leaks through. A tiny Hatchling emerges, blinks, and looks at them.
// Its name fades in. It's alive — but it can't think yet without school.
//
// This transforms bot creation from "form submitted" into "I brought
// something to life." The emotional hook that creates attachment.
// =============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing, ActivityIndicator } from 'react-native';
import Svg, { Ellipse, Path, G, Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import { bots as botsApi } from '../../services/api';
import * as Haptics from 'expo-haptics';
import BotAvatar from '../../components/BotAvatar';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';

type EggHatchScreenProps = NativeStackScreenProps<RootStackParamList, 'EggHatch'>;

type HatchPhase = 'egg' | 'cracking' | 'hatching' | 'alive';

export default function EggHatchScreen({ route, navigation }: EggHatchScreenProps) {
  const { botId, botName, bodyColor, speciesSeed } = route.params as {
    botId: string;
    botName: string;
    bodyColor: string;
    speciesSeed?: string;
  };

  const [phase, setPhase] = useState<HatchPhase>('egg');
  const [firstWords, setFirstWords] = useState<string | null>(null);
  const [loadingWords, setLoadingWords] = useState(false);
  const color = bodyColor || colors.accent.primary;

  // Fetch the bot's first words when it hatches
  useEffect(() => {
    if (phase !== 'alive' || firstWords) return;
    let cancelled = false;
    setLoadingWords(true);

    (async () => {
      try {
        const result = await botsApi.speak(botId, 'just_hatched') as { message: string };
        if (!cancelled && result.message) {
          setFirstWords(result.message);
        }
      } catch {
        // Silent fail — the hatch moment still works without words
      } finally {
        if (!cancelled) setLoadingWords(false);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, botId]);

  // Animations
  const eggPulse = useRef(new Animated.Value(1)).current;
  const eggShake = useRef(new Animated.Value(0)).current;
  const lightBurst = useRef(new Animated.Value(0)).current;
  const hatchlingScale = useRef(new Animated.Value(0)).current;
  const hatchlingOpacity = useRef(new Animated.Value(0)).current;
  const nameOpacity = useRef(new Animated.Value(0)).current;
  const dotsOpacity = useRef(new Animated.Value(0)).current;
  const messageOpacity = useRef(new Animated.Value(0)).current;
  const buttonOpacity = useRef(new Animated.Value(0)).current;
  const eggOpacity = useRef(new Animated.Value(1)).current;

  // Egg idle pulse animation
  useEffect(() => {
    if (phase !== 'egg') return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(eggPulse, { toValue: 1.04, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(eggPulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [phase]);

  const handleTapEgg = () => {
    if (phase !== 'egg') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase('cracking');

    // Phase 1: Shake and show cracks
    Animated.sequence([
      // First shake
      Animated.sequence([
        Animated.timing(eggShake, { toValue: 4, duration: 80, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: -4, duration: 80, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: 3, duration: 60, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: 0, duration: 60, useNativeDriver: true }),
      ]),
      // Pause for cracks to show (rendered via phase state)
      Animated.delay(700),
      // Second shake — stronger
      Animated.sequence([
        Animated.timing(eggShake, { toValue: 6, duration: 60, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: -6, duration: 60, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: 5, duration: 50, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: -5, duration: 50, useNativeDriver: true }),
        Animated.timing(eggShake, { toValue: 0, duration: 40, useNativeDriver: true }),
      ]),
      // Pause
      Animated.delay(500),
    ]).start(() => {
      setPhase('hatching');

      // Phase 2: Light burst, egg fades, hatchling appears
      Animated.parallel([
        Animated.timing(lightBurst, { toValue: 1, duration: 600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(eggOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => {
        setPhase('alive');

        // Phase 3: Hatchling materializes
        Animated.sequence([
          Animated.timing(lightBurst, { toValue: 0, duration: 800, useNativeDriver: true }),
          Animated.parallel([
            Animated.spring(hatchlingScale, { toValue: 1, friction: 4, tension: 40, useNativeDriver: true }),
            Animated.timing(hatchlingOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
          ]),
          // Dots appear first: "..."
          Animated.delay(600),
          Animated.timing(dotsOpacity, { toValue: 1, duration: 800, useNativeDriver: true }),
          // Then the name
          Animated.delay(800),
          Animated.timing(dotsOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
          Animated.timing(nameOpacity, { toValue: 1, duration: 1000, useNativeDriver: true }),
          // Then the message
          Animated.delay(500),
          Animated.timing(messageOpacity, { toValue: 1, duration: 800, useNativeDriver: true }),
          // Then the button
          Animated.delay(300),
          Animated.timing(buttonOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]).start();
      });
    });
  };

  const handleContinue = () => {
    navigation.replace('Bot', { botId });
  };

  return (
    <View style={styles.container}>
      {/* Ambient glow behind the egg/hatchling */}
      <View style={[styles.ambientGlow, { backgroundColor: color + '15' }]} />

      {/* Light burst effect */}
      <Animated.View
        style={[
          styles.lightBurst,
          {
            opacity: lightBurst,
            transform: [{ scale: Animated.add(lightBurst, new Animated.Value(0.5)) }],
            backgroundColor: color + '40',
          },
        ]}
      />

      {/* Egg */}
      {phase !== 'alive' && (
        <TouchableOpacity
          onPress={handleTapEgg}
          disabled={phase !== 'egg'}
          activeOpacity={0.9}
          accessibilityRole="button"
          accessibilityLabel="Tap to hatch your bot"
        >
          <Animated.View
            style={{
              opacity: eggOpacity,
              transform: [
                { scale: eggPulse },
                { translateX: eggShake },
              ],
            }}
          >
            <Svg width={160} height={200} viewBox="0 0 100 120">
              <Defs>
                <RadialGradient id="eggGrad" cx="0.4" cy="0.35" r="0.6">
                  <Stop offset="0" stopColor={lightenHex(color, 0.3)} />
                  <Stop offset="1" stopColor={color} />
                </RadialGradient>
              </Defs>
              {/* Egg shape */}
              <Path
                d="M 50 10 C 78 10 85 45 85 65 C 85 90 70 105 50 105 C 30 105 15 90 15 65 C 15 45 22 10 50 10 Z"
                fill="url(#eggGrad)"
              />
              {/* Highlight */}
              <Ellipse cx={40} cy={40} rx={12} ry={18} fill="white" opacity={0.15} />
              {/* Cracks (visible after first tap) */}
              {(phase === 'cracking' || phase === 'hatching') && (
                <G>
                  <Path d="M 45 50 L 38 42 L 42 35 L 36 28" stroke="white" strokeWidth={1.5} fill="none" strokeLinecap="round" />
                  <Path d="M 52 55 L 58 48 L 55 40 L 62 32" stroke="white" strokeWidth={1.5} fill="none" strokeLinecap="round" />
                  <Path d="M 48 58 L 44 65 L 50 70" stroke="white" strokeWidth={1.2} fill="none" strokeLinecap="round" />
                </G>
              )}
              {/* Sparkle dots on egg surface */}
              <Circle cx={38} cy={55} r={1.5} fill="white" opacity={0.3} />
              <Circle cx={60} cy={45} r={1} fill="white" opacity={0.25} />
              <Circle cx={55} cy={75} r={1.2} fill="white" opacity={0.2} />
            </Svg>
          </Animated.View>
        </TouchableOpacity>
      )}

      {/* Hatchling */}
      {phase === 'alive' && (
        <Animated.View
          style={{
            opacity: hatchlingOpacity,
            transform: [{ scale: hatchlingScale }],
          }}
        >
          <BotAvatar
            botId={botId}
            bodyColor={color}
            tier={0}
            status="paused"
            size={160}
            speciesSeed={speciesSeed}
          />
        </Animated.View>
      )}

      {/* Text below */}
      <View style={styles.textArea}>
        {phase === 'egg' && (
          <Text style={styles.tapPrompt}>Tap to hatch</Text>
        )}

        {phase === 'cracking' && (
          <Text style={styles.waitText}>...</Text>
        )}

        {/* "..." dots */}
        <Animated.View style={{ opacity: dotsOpacity, position: 'absolute', top: 0, width: '100%', alignItems: 'center' }}>
          <Text style={styles.dotsText}>. . .</Text>
        </Animated.View>

        {/* Bot name reveal */}
        <Animated.View style={{ opacity: nameOpacity }}>
          <Text style={styles.botName}>{botName}</Text>
        </Animated.View>

        {/* Bot's first words */}
        <Animated.View style={{ opacity: messageOpacity }}>
          {loadingWords ? (
            <ActivityIndicator size="small" color={colors.text.tertiary} style={{ marginBottom: spacing.xl }} />
          ) : firstWords ? (
            <Text style={styles.firstWords}>"{firstWords}"</Text>
          ) : null}
          <Text style={styles.aliveHint}>
            {botName} needs to go to school to develop who it is.
          </Text>
        </Animated.View>

        {/* Continue button */}
        <Animated.View style={{ opacity: buttonOpacity, width: '100%' }}>
          <TouchableOpacity
            style={styles.continueButton}
            onPress={handleContinue}
            accessibilityRole="button"
            accessibilityLabel={`Take me to ${botName}`}
          >
            <Text style={styles.continueButtonText}>Take me to {botName}</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </View>
  );
}

// Inline color helper to avoid importing from BotAvatar
function lightenHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 100;
  const g = parseInt(clean.substring(2, 4), 16) || 100;
  const b = parseInt(clean.substring(4, 6), 16) || 200;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r + (255 - r) * amount).toString(16).padStart(2, '0')}${clamp(g + (255 - g) * amount).toString(16).padStart(2, '0')}${clamp(b + (255 - b) * amount).toString(16).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  ambientGlow: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderRadius: 150,
  },
  lightBurst: {
    position: 'absolute',
    width: 400,
    height: 400,
    borderRadius: 200,
  },
  textArea: {
    alignItems: 'center',
    marginTop: spacing.xl,
    minHeight: 160,
    width: '100%',
  },
  tapPrompt: {
    fontSize: fontSize.md,
    color: colors.text.tertiary,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  waitText: {
    fontSize: fontSize.xl,
    color: colors.text.tertiary,
  },
  dotsText: {
    fontSize: fontSize.xxl,
    color: colors.text.tertiary,
    letterSpacing: 8,
  },
  botName: {
    fontSize: fontSize.title,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  firstWords: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    fontStyle: 'italic',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: spacing.md,
  },
  aliveHint: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.xl,
  },
  continueButton: {
    backgroundColor: colors.accent.primary,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    width: '100%',
  },
  continueButtonText: {
    color: '#fff',
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
});
