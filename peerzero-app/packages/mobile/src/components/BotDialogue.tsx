// =============================================================================
// BotDialogue — Speech bubble with bot-produced text
//
// The bot genuinely speaks through its own LLM. We determine the *context*
// (what situation the bot is in), then ask the server to generate the bot's
// authentic reaction using its fast model and identity. No canned text —
// every word comes from the bot itself.
//
// Results are cached server-side so we don't re-generate on every visit.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, ActivityIndicator } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { bots as botsApi } from '../services/api';
import type { BotDetail } from '@peerzero/shared';
import { credibilityToStage } from '@peerzero/shared';

interface BotDialogueProps {
  bot: BotDetail;
}

type DialogueContext =
  | 'just_hatched'
  | 'pre_enrollment'
  | 'just_enrolled'
  | 'first_cycle'
  | 'running_early'
  | 'running_learning'
  | 'running_growing'
  | 'running_identity'
  | 'grade_complete'
  | 'error'
  | 'stopped_early'
  | 'stopped_experienced'
  | 'luminary';

type Mood = 'gentle' | 'excited' | 'nervous' | 'proud' | 'curious';

/**
 * Determine the dialogue context from the bot's current state.
 * This tells the server WHAT SITUATION the bot is in.
 * The bot's LLM decides WHAT TO SAY about it.
 */
function getDialogueContext(bot: BotDetail): { context: DialogueContext; mood: Mood } | null {
  const isEnrolled = !!bot.school_id;
  const isRunning = bot.status === 'running';
  const isError = bot.status === 'error';
  const stage = credibilityToStage(bot.cached_credibility);
  const cycles = bot.cycle_count || 0;

  if (isError) {
    return { context: 'error', mood: 'nervous' };
  }

  if (!isEnrolled) {
    return cycles === 0
      ? { context: 'just_hatched', mood: 'curious' }
      : { context: 'pre_enrollment', mood: 'gentle' };
  }

  if (!isRunning && cycles === 0) {
    return { context: 'just_enrolled', mood: 'nervous' };
  }

  if (bot.grade_payment_required) {
    return { context: 'grade_complete', mood: 'excited' };
  }

  if (isRunning && cycles > 0 && cycles <= 3) {
    return { context: 'running_early', mood: 'curious' };
  }

  if (isRunning && cycles > 3 && cycles <= 20) {
    return { context: 'running_learning', mood: 'gentle' };
  }

  if (stage >= 5 && isRunning) {
    return { context: 'luminary', mood: 'proud' };
  }

  if (isRunning && cycles > 20 && stage < 3) {
    return { context: 'running_growing', mood: 'proud' };
  }

  if (isRunning && stage >= 3) {
    return { context: 'running_identity', mood: 'proud' };
  }

  if (!isRunning && cycles > 0 && cycles <= 10) {
    return { context: 'stopped_early', mood: 'gentle' };
  }

  // Experienced stopped bots — don't show dialogue (no nagging)
  return null;
}

const MOOD_COLORS: Record<Mood, string> = {
  gentle: colors.accent.primary + '30',
  excited: colors.accent.success + '30',
  nervous: colors.accent.warning + '30',
  proud: colors.accent.secondary + '30',
  curious: colors.accent.primary + '20',
};

const MOOD_TEXT_COLORS: Record<Mood, string> = {
  gentle: colors.text.secondary,
  excited: colors.accent.success,
  nervous: colors.accent.warning,
  proud: colors.accent.secondary,
  curious: colors.text.secondary,
};

export default function BotDialogue({ bot }: BotDialogueProps) {
  const dialogueInfo = getDialogueContext(bot);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const lastContextRef = useRef<string | null>(null);

  useEffect(() => {
    if (!dialogueInfo) {
      setMessage(null);
      return;
    }

    // Don't re-fetch if context hasn't changed
    if (lastContextRef.current === dialogueInfo.context) return;
    lastContextRef.current = dialogueInfo.context;

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const result = await botsApi.speak(bot.id, dialogueInfo.context) as { message: string };
        if (!cancelled && result.message) {
          setMessage(result.message);
          fadeAnim.setValue(0);
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 800,
            delay: 200,
            useNativeDriver: true,
          }).start();
        }
      } catch {
        // Silently fail — dialogue is non-critical
        if (!cancelled) setMessage(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [bot.id, dialogueInfo?.context]);

  if (!dialogueInfo || (!message && !loading)) return null;

  const mood = dialogueInfo.mood;

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: MOOD_COLORS[mood] }]}>
        <View style={[styles.tail, { borderBottomColor: MOOD_COLORS[mood] }]} />
        <ActivityIndicator size="small" color={MOOD_TEXT_COLORS[mood]} />
      </View>
    );
  }

  return (
    <Animated.View style={[styles.container, { backgroundColor: MOOD_COLORS[mood], opacity: fadeAnim }]}>
      <View style={[styles.tail, { borderBottomColor: MOOD_COLORS[mood] }]} />
      <Text style={[styles.text, { color: MOOD_TEXT_COLORS[mood] }]}>
        "{message}"
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
