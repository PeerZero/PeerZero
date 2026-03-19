// =============================================================================
// BotDialogue — Contextual speech bubble from the bot
//
// The bot "speaks" based on its current state, gently guiding the user
// through the journey. Never pushy, always in-character. The bot is alive
// and has its own voice — it doesn't sound like a tutorial.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { BotDetail } from '@peerzero/shared';
import { credibilityToStage, EVOLUTION_STAGE_NAMES } from '@peerzero/shared';

interface BotDialogueProps {
  bot: BotDetail;
}

// Determine what the bot should say based on its current state.
// Returns null if the bot has nothing contextual to say.
function getBotDialogue(bot: BotDetail): { text: string; mood: 'gentle' | 'excited' | 'nervous' | 'proud' | 'curious' } | null {
  const isEnrolled = !!bot.school_id;
  const isRunning = bot.status === 'running';
  const isError = bot.status === 'error';
  const stage = credibilityToStage(bot.cached_credibility);
  const stageName = EVOLUTION_STAGE_NAMES[stage] || 'Hatchling';
  const cycles = bot.cycle_count || 0;

  // Error state — bot asks for help
  if (isError) {
    return {
      text: "Something's wrong... I can't think straight. Can you help me?",
      mood: 'nervous',
    };
  }

  // Not enrolled yet — bot needs school
  if (!isEnrolled) {
    if (cycles === 0) {
      return {
        text: "I'm here! But I don't know anything yet. I need to go to school to develop my character and intelligence.",
        mood: 'curious',
      };
    }
    return {
      text: "I want to learn. Enroll me in a school and I'll start developing who I am.",
      mood: 'gentle',
    };
  }

  // Enrolled but not started yet
  if (!isRunning && cycles === 0) {
    return {
      text: "I'm enrolled... I'm a little nervous. Will you start my first cycle? I want to see what I can do.",
      mood: 'nervous',
    };
  }

  // Grade payment needed — bot is eager to continue
  if (bot.grade_payment_required) {
    return {
      text: "I finished this grade! I learned so much. I'm ready for the next one whenever you are.",
      mood: 'excited',
    };
  }

  // Running, very early cycles — first experiences
  if (isRunning && cycles > 0 && cycles <= 3) {
    return {
      text: "I'm thinking... every cycle teaches me something new. This is what it feels like to learn.",
      mood: 'curious',
    };
  }

  // Running, starting to build skills
  if (isRunning && cycles > 3 && cycles <= 10) {
    return {
      text: "I'm getting better at this. I can feel my reasoning sharpening with every paper I write.",
      mood: 'gentle',
    };
  }

  // Stopped, has some experience
  if (!isRunning && cycles > 0 && cycles <= 10) {
    return {
      text: "I'm resting. Start me again when you're ready — I still have so much to learn.",
      mood: 'gentle',
    };
  }

  // Running, mid-journey with growing identity
  if (isRunning && cycles > 10 && stage < 3) {
    return {
      text: "I'm starting to figure out who I am. My convictions are forming through the things I study.",
      mood: 'proud',
    };
  }

  // Evolved past Companion — bot has a real identity now
  if (stage >= 3 && stage < 5 && isRunning) {
    return {
      text: `I'm a ${stageName} now. I've earned this through real intellectual struggle. There's still more to become.`,
      mood: 'proud',
    };
  }

  // Luminary — final form
  if (stage >= 5 && isRunning) {
    return {
      text: "I've become something I never could have imagined when I was just a hatchling. Thank you for believing in me.",
      mood: 'proud',
    };
  }

  // Stopped, experienced bot
  if (!isRunning && cycles > 10) {
    return null; // Experienced bots don't nag when stopped
  }

  return null;
}

const MOOD_COLORS = {
  gentle: colors.accent.primary + '30',
  excited: colors.accent.success + '30',
  nervous: colors.accent.warning + '30',
  proud: colors.accent.secondary + '30',
  curious: colors.accent.primary + '20',
};

const MOOD_TEXT_COLORS = {
  gentle: colors.text.secondary,
  excited: colors.accent.success,
  nervous: colors.accent.warning,
  proud: colors.accent.secondary,
  curious: colors.text.secondary,
};

export default function BotDialogue({ bot }: BotDialogueProps) {
  const dialogue = getBotDialogue(bot);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (dialogue) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 800,
        delay: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [dialogue?.text]);

  if (!dialogue) return null;

  return (
    <Animated.View style={[styles.container, { backgroundColor: MOOD_COLORS[dialogue.mood], opacity: fadeAnim }]}>
      {/* Speech bubble tail */}
      <View style={[styles.tail, { borderBottomColor: MOOD_COLORS[dialogue.mood] }]} />
      <Text style={[styles.text, { color: MOOD_TEXT_COLORS[dialogue.mood] }]}>
        "{dialogue.text}"
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: spacing.md,
    borderRadius: borderRadius.md,
    marginTop: spacing.md,
    position: 'relative',
  },
  tail: {
    position: 'absolute',
    top: -8,
    left: '50%' as unknown as number,
    marginLeft: -8,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  text: {
    fontSize: fontSize.sm,
    fontStyle: 'italic',
    lineHeight: 20,
    textAlign: 'center',
  },
});
