// =============================================================================
// BotAvatar — Procedurally generated SVG creatures that evolve with the bot
//
// Each bot gets a unique creature based on its ID (deterministic seed).
// The creature evolves through 6 stages tied to credibility tiers:
//   Stage 0 (Newcomer)      — tiny, round, vulnerable. Big eyes, no features.
//   Stage 1 (Apprentice)    — small ears appear, blush marks.
//   Stage 2 (Tested)        — antenna/horn nubs, slightly larger body.
//   Stage 3 (Verified)      — full ears, tail, body pattern markings.
//   Stage 4 (Distinguished) — crown/halo, glowing aura, expressive face.
//   Stage 5 (Master)        — final form with wings, complex patterns, sparkles.
//
// Expressions react to the bot's current mood/status:
//   running  → happy, eyes open, slight bounce
//   stopped  → sleeping, closed eyes, zzz
//   paused   → curious, tilted head
//   error    → distressed, wavy mouth, sweat drop
//
// Body color comes from avatar_config.body_color (user-chosen at creation).
// Shape/species is deterministic from bot ID, so every bot is unique but stable.
//
// Utilities and types: ./avatar-utils.ts
// SVG render functions: ./avatar-parts.tsx
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import Svg from 'react-native-svg';

import { type AvatarProps, generateTraits } from './avatar-utils';
import {
  renderAura,
  renderWings,
  renderTail,
  renderEars,
  renderBody,
  renderPatterns,
  renderTierRibbon,
  renderFeet,
  renderEyes,
  renderCheeks,
  renderMouth,
  renderCrown,
  renderSparkles,
  renderHungerIndicator,
} from './avatar-parts';

export type { AvatarProps };

export default function BotAvatar({
  botId,
  bodyColor,
  tier = 0,
  status = 'stopped',
  mood = 'neutral',
  hunger = 'satisfied',
  size = 120,
  animate = true,
  speciesSeed,
}: AvatarProps) {
  const traits = generateTraits(speciesSeed || botId);
  const color = bodyColor || '#6C5CE7';
  const clampedTier = Math.max(0, Math.min(5, tier));

  // Idle breathing animation
  const breathAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!animate || status === 'stopped') {
      breathAnim.setValue(1);
      return;
    }

    const breathing = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, {
          toValue: 1.03,
          duration: status === 'error' ? 600 : 1800,
          useNativeDriver: true,
        }),
        Animated.timing(breathAnim, {
          toValue: 1,
          duration: status === 'error' ? 600 : 1800,
          useNativeDriver: true,
        }),
      ]),
    );
    breathing.start();
    return () => breathing.stop();
  }, [animate, status, breathAnim]);

  // Gentle bounce for running status
  const bounceAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate || status !== 'running') {
      bounceAnim.setValue(0);
      return;
    }

    const bounce = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, {
          toValue: -2,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(bounceAnim, {
          toValue: 0,
          duration: 1200,
          useNativeDriver: true,
        }),
      ]),
    );
    bounce.start();
    return () => bounce.stop();
  }, [animate, status, bounceAnim]);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Animated.View
        style={{
          transform: [
            { scale: breathAnim },
            { translateY: bounceAnim },
          ],
        }}
      >
        <Svg width={size} height={size} viewBox="0 0 100 100">
          {/* Background aura (tier 4+) */}
          {renderAura(color, clampedTier)}

          {/* Wings (tier 5) */}
          {renderWings(color, clampedTier)}

          {/* Tail (tier 3+) */}
          {renderTail(traits, color, clampedTier)}

          {/* Ears (tier 1+) */}
          {renderEars(traits, color, clampedTier)}

          {/* Body */}
          {renderBody(traits, color, clampedTier)}

          {/* Body patterns (tier 3+) */}
          {renderPatterns(traits, color, clampedTier)}

          {/* Tier 2 ribbon (Fledgling milestone) */}
          {renderTierRibbon(color, clampedTier)}

          {/* Feet */}
          {renderFeet(color, clampedTier)}

          {/* Eyes */}
          {renderEyes(traits, status, mood, clampedTier, color)}

          {/* Cheeks */}
          {renderCheeks(traits, color)}

          {/* Mouth */}
          {renderMouth(status, mood)}

          {/* Crown/halo (tier 4+) */}
          {renderCrown(clampedTier)}

          {/* Sparkles (tier 4+) */}
          {renderSparkles(clampedTier)}

          {/* Knowledge hunger indicator */}
          {renderHungerIndicator(hunger)}
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
