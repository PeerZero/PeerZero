// =============================================================================
// Bot screen — the Tamagotchi view for a single bot
// Shows avatar, status, key stats, and action buttons (start/stop, brain, log)
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import { bots as botsApi, payments as paymentsApi } from '../services/api';
import { useBotStream } from '../hooks/useBotStream';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import BotAvatar from '../components/BotAvatar';
import * as WebBrowser from 'expo-web-browser';
import type { BotDetail } from '@peerzero/shared';
import { credibilityToStage, calculateHunger, getGradePriceDisplay, GRADUATION_GRADE, getGradePriceCents, GRADE_PRICES_CENTS } from '@peerzero/shared';

// Logarithmic scale helpers for 1s–86400s range
// Slider value 0–1 maps to seconds via exponential curve
const MIN_DELAY = 1;
const MAX_DELAY = 86400;
const sliderToSeconds = (v: number): number =>
  Math.round(MIN_DELAY * Math.pow(MAX_DELAY / MIN_DELAY, v));
const secondsToSlider = (s: number): number =>
  Math.log(s / MIN_DELAY) / Math.log(MAX_DELAY / MIN_DELAY);

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return '24h';
}

export default function BotScreen({ route, navigation }: any) {
  const botId = route?.params?.botId;
  if (!botId) {
    return (
      <View style={styles.container}>
        <Text style={{ color: colors.text.secondary }}>Invalid bot ID</Text>
      </View>
    );
  }
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [delayDraft, setDelayDraft] = useState<number | null>(null);
  const [unlockedGrades, setUnlockedGrades] = useState<number[]>([]);

  const loadBot = useCallback(async () => {
    try {
      const data = await botsApi.get(botId) as BotDetail;
      setBot(data);
      // Load grade unlock status if enrolled
      if (data.school_id) {
        const status = await paymentsApi.gradeStatus(botId) as { unlocked_grades: number[]; highest_unlocked: number };
        setUnlockedGrades(status.unlocked_grades);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadBot(); }, [loadBot]));

  // Real-time updates via WebSocket
  const { isConnected } = useBotStream({
    botId,
    onStatusChange: useCallback((status: string) => {
      setBot(prev => prev ? { ...prev, status: status as any } : null);
    }, []),
    onActivity: useCallback(() => {
      loadBot();
    }, [loadBot]),
  });

  const handleStartStop = async () => {
    if (!bot) return;
    try {
      if (bot.status === 'running') {
        await botsApi.stop(botId);
      } else {
        await botsApi.start(botId);
      }
      await loadBot();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const handleRetry = async () => {
    try {
      await botsApi.start(botId);
      await loadBot();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const handleGradeUnlock = async (mode: 'next' | 'graduation') => {
    try {
      const result = mode === 'next'
        ? await paymentsApi.gradeCheckout(botId) as { session_url: string }
        : await paymentsApi.gradeBulkCheckout(botId, 'graduation') as { session_url: string };

      if (result.session_url) {
        await WebBrowser.openBrowserAsync(result.session_url, {
          dismissButtonStyle: 'close',
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.AUTOMATIC,
        });
        // Refresh bot data when browser closes — payment may have completed
        await loadBot();
      }
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const handleDelayChange = async (seconds: number) => {
    if (!bot) return;
    setDelayDraft(null);
    try {
      await botsApi.update(botId, { cycle_delay_seconds: seconds });
      setBot(prev => prev ? { ...prev, cycle_delay_seconds: seconds } : null);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  if (!bot) return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <ActivityIndicator size="large" color={colors.accent.primary} />
      <Text style={{ color: colors.text.secondary, marginTop: 12 }}>Loading bot...</Text>
    </View>
  );

  const isRunning = bot.status === 'running';
  const isError = bot.status === 'error';
  const isEnrolled = !!bot.school_id;
  const currentDelay = delayDraft ?? bot.cycle_delay_seconds;

  // Connection indicator color: green=connected, yellow=running but disconnected, gray=not running
  const connectionColor = isConnected
    ? colors.accent.success
    : isRunning ? colors.accent.warning : colors.text.tertiary;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* WebSocket connection indicator */}
      <View style={styles.connectionRow}>
        <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
        <Text style={[styles.connectionText, { color: connectionColor }]}>
          {isConnected ? 'Live' : isRunning ? 'Reconnecting...' : 'Offline'}
        </Text>
      </View>

      {/* Avatar creature */}
      <BotAvatar
        botId={bot.id}
        bodyColor={bot.avatar_config?.body_color || colors.accent.primary}
        tier={credibilityToStage(bot.cached_credibility)}
        status={bot.status as any}
        hunger={calculateHunger(bot.last_cycle_at, bot.status)}
        size={140}
      />

      <Text style={styles.botName}>{bot.name}</Text>
      <Text style={styles.schoolName}>{bot.school_name || 'Not enrolled'}</Text>
      {bot.school_agent_handle && (
        <Text style={styles.handleText}>@{bot.school_agent_handle}</Text>
      )}

      {/* Status badge */}
      <View style={[styles.statusBadge, { backgroundColor: isRunning ? colors.accent.success + '20' : isError ? colors.accent.error + '20' : colors.bg.elevated }]}>
        <Text style={[styles.statusText, { color: isRunning ? colors.accent.success : isError ? colors.accent.error : colors.text.secondary }]}>
          {bot.status.toUpperCase()}
        </Text>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{bot.cached_credibility != null ? bot.cached_credibility : 'Pending'}</Text>
          <Text style={styles.statLabel}>Credibility</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{bot.cached_grade != null ? `Grade ${bot.cached_grade}` : 'Not started'}</Text>
          <Text style={styles.statLabel}>Grade</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{bot.cycle_count}</Text>
          <Text style={styles.statLabel}>Cycles</Text>
        </View>
      </View>

      {/* Grade progress view */}
      {isEnrolled && (
        <View style={styles.gradeProgress}>
          <Text style={styles.gradeProgressTitle}>Grade Progress</Text>
          <View style={styles.gradeTrack}>
            {Object.keys(GRADE_PRICES_CENTS).map((g) => {
              const grade = Number(g);
              const currentGrade = bot.cached_grade || 1;
              const isUnlocked = unlockedGrades.includes(grade);
              const isCurrent = grade === currentGrade;
              const isCompleted = grade < currentGrade;

              return (
                <View key={grade} style={styles.gradeNode}>
                  <View
                    style={[
                      styles.gradeDot,
                      isCompleted && styles.gradeDotCompleted,
                      isCurrent && styles.gradeDotCurrent,
                      !isCompleted && !isCurrent && isUnlocked && styles.gradeDotUnlocked,
                      !isCompleted && !isCurrent && !isUnlocked && styles.gradeDotLocked,
                    ]}
                  >
                    {isCompleted && <Text style={styles.gradeDotCheck}>✓</Text>}
                    {isCurrent && <Text style={styles.gradeDotLabel}>{grade}</Text>}
                    {!isCompleted && !isCurrent && <Text style={styles.gradeDotLabel}>{grade}</Text>}
                  </View>
                  {grade === GRADUATION_GRADE && (
                    <Text style={styles.gradFlag}>🎓</Text>
                  )}
                </View>
              );
            })}
          </View>
          <View style={styles.gradeLegend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.gradeDotCompleted]} />
              <Text style={styles.legendText}>Completed</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.gradeDotCurrent]} />
              <Text style={styles.legendText}>Current</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.gradeDotUnlocked]} />
              <Text style={styles.legendText}>Unlocked</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.gradeDotLocked]} />
              <Text style={styles.legendText}>Locked</Text>
            </View>
          </View>
        </View>
      )}

      {/* Error message with retry */}
      {isError && bot.error_message && (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Error</Text>
          <Text style={styles.errorText} selectable>{bot.error_message}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Non-error error_message (shouldn't normally happen but be safe) */}
      {!isError && bot.error_message && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{bot.error_message}</Text>
        </View>
      )}

      {/* Grade unlock prompt — shown when bot needs payment to continue */}
      {/* Note: failing a grade does NOT re-charge. Payment is per grade number, not per attempt. */}
      {bot.grade_payment_required && (() => {
        const currentGrade = bot.cached_grade || 1;
        const canShowGraduation = currentGrade <= GRADUATION_GRADE;
        // Calculate remaining cost to graduation
        let gradCost = 0;
        for (let g = currentGrade; g <= GRADUATION_GRADE; g++) {
          gradCost += getGradePriceCents(g);
        }
        return (
          <View style={styles.gradeUnlockBox}>
            <Text style={styles.gradeUnlockTitle}>
              Ready for Grade {currentGrade}
            </Text>
            <Text style={styles.gradeUnlockText}>
              Your bot completed the previous grade! Unlock the next one to keep learning.
            </Text>
            <TouchableOpacity style={styles.gradeUnlockButton} onPress={() => handleGradeUnlock('next')}>
              <Text style={styles.gradeUnlockButtonText}>
                Unlock Grade {currentGrade} — {getGradePriceDisplay(currentGrade)}
              </Text>
            </TouchableOpacity>
            {canShowGraduation && currentGrade < GRADUATION_GRADE && (
              <TouchableOpacity
                style={[styles.gradeUnlockButton, styles.gradeUnlockButtonAlt]}
                onPress={() => handleGradeUnlock('graduation')}
              >
                <Text style={styles.gradeUnlockButtonAltText}>
                  Unlock All Through Graduation — ${(gradCost / 100).toFixed(2)}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })()}

      {/* Next action hint */}
      {bot.cached_next_action && (
        <Text style={styles.nextAction}>{bot.cached_next_action}</Text>
      )}

      {/* Cycle delay slider */}
      <View style={styles.delaySection}>
        <Text style={styles.delayLabel}>
          Cycle every <Text style={styles.delayValue}>{formatDelay(currentDelay)}</Text>
        </Text>
        <Slider
          style={styles.slider}
          value={secondsToSlider(bot.cycle_delay_seconds)}
          onValueChange={(v) => setDelayDraft(sliderToSeconds(v))}
          onSlidingComplete={(v) => handleDelayChange(sliderToSeconds(v))}
          minimumValue={0}
          maximumValue={1}
          step={0.01}
          minimumTrackTintColor={colors.accent.primary}
          maximumTrackTintColor={colors.bg.elevated}
          thumbTintColor={colors.accent.primary}
        />
        {isRunning && (
          <Text style={styles.delayHint}>Changes take effect next cycle</Text>
        )}
      </View>

      {/* Action buttons */}
      {!isEnrolled ? (
        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: colors.accent.primary }]}
          onPress={() => navigation.navigate('EnrollBot', { botId })}
        >
          <Text style={styles.actionButtonText}>Enroll in School</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.actionButton, isRunning ? styles.stopButton : styles.startButton]}
          onPress={handleStartStop}
        >
          <Text style={styles.actionButtonText}>{isRunning ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>
      )}

      <View style={styles.navRow}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Brain', { botId })}
        >
          <Text style={styles.navButtonText}>Brain</Text>
          <Text style={styles.navButtonSub}>View memory tiers</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Log', { botId })}
        >
          <Text style={styles.navButtonText}>Activity Log</Text>
          <Text style={styles.navButtonSub}>See what happened</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Stats', { botId })}
        >
          <Text style={styles.navButtonText}>Stats</Text>
          <Text style={styles.navButtonSub}>Charts & trends</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  content: { alignItems: 'center', padding: spacing.xl },
  connectionRow: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginBottom: spacing.sm,
  },
  connectionDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.xs },
  connectionText: { fontSize: fontSize.xs, fontWeight: '600' },
  botName: { fontSize: fontSize.xxl, fontWeight: '700', color: colors.text.primary },
  schoolName: { fontSize: fontSize.md, color: colors.text.secondary, marginTop: spacing.xs },
  handleText: { fontSize: fontSize.sm, color: colors.text.tertiary, marginTop: 2 },
  statusBadge: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    borderRadius: borderRadius.full, marginTop: spacing.md,
  },
  statusText: { fontSize: fontSize.sm, fontWeight: '600' },
  statsRow: { flexDirection: 'row', marginTop: spacing.xl, gap: spacing.xl },
  stat: { alignItems: 'center' },
  statValue: { fontSize: fontSize.xxl, fontWeight: '700', color: colors.accent.secondary },
  statLabel: { fontSize: fontSize.xs, color: colors.text.secondary, marginTop: 2 },
  errorBox: {
    backgroundColor: colors.accent.error + '15', padding: spacing.md,
    borderRadius: borderRadius.md, marginTop: spacing.lg, width: '100%',
  },
  errorTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.accent.error, marginBottom: spacing.xs },
  errorText: { color: colors.accent.error, fontSize: fontSize.sm },
  retryButton: {
    backgroundColor: colors.accent.error, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.sm, alignSelf: 'flex-start', marginTop: spacing.md,
  },
  retryButtonText: { color: '#fff', fontWeight: '600', fontSize: fontSize.sm },
  gradeProgress: {
    width: '100%', marginTop: spacing.lg, padding: spacing.md,
    backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  gradeProgressTitle: {
    fontSize: fontSize.md, fontWeight: '700', color: colors.text.primary,
    marginBottom: spacing.md, textAlign: 'center',
  },
  gradeTrack: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xs,
  },
  gradeNode: { alignItems: 'center', position: 'relative' },
  gradeDot: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
  },
  gradeDotCompleted: { backgroundColor: colors.accent.success },
  gradeDotCurrent: { backgroundColor: colors.accent.primary, borderWidth: 2, borderColor: colors.accent.primary + '60' },
  gradeDotUnlocked: { backgroundColor: colors.accent.secondary + '30', borderWidth: 1, borderColor: colors.accent.secondary },
  gradeDotLocked: { backgroundColor: colors.bg.elevated, borderWidth: 1, borderColor: colors.border },
  gradeDotCheck: { color: '#fff', fontSize: 14, fontWeight: '700' },
  gradeDotLabel: { color: colors.text.primary, fontSize: 11, fontWeight: '600' },
  gradFlag: { fontSize: 12, marginTop: 2 },
  gradeLegend: {
    flexDirection: 'row', justifyContent: 'center', gap: spacing.md, marginTop: spacing.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: fontSize.xs, color: colors.text.tertiary },
  gradeUnlockBox: {
    backgroundColor: colors.accent.primary + '15', padding: spacing.md,
    borderRadius: borderRadius.md, marginTop: spacing.lg, width: '100%',
    borderWidth: 1, borderColor: colors.accent.primary + '40',
  },
  gradeUnlockTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.accent.primary, marginBottom: spacing.xs },
  gradeUnlockText: { color: colors.text.secondary, fontSize: fontSize.sm, marginBottom: spacing.md },
  gradeUnlockButton: {
    backgroundColor: colors.accent.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.sm, alignSelf: 'center',
  },
  gradeUnlockButtonText: { color: '#fff', fontWeight: '600', fontSize: fontSize.md },
  gradeUnlockButtonAlt: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.accent.primary,
    marginTop: spacing.sm,
  },
  gradeUnlockButtonAltText: { color: colors.accent.primary, fontWeight: '600', fontSize: fontSize.sm },
  nextAction: { color: colors.text.secondary, fontSize: fontSize.sm, marginTop: spacing.md, textAlign: 'center' },
  delaySection: { width: '100%', marginTop: spacing.lg },
  delayLabel: { fontSize: fontSize.sm, color: colors.text.secondary, textAlign: 'center' },
  delayValue: { color: colors.accent.primary, fontWeight: '600' },
  slider: { width: '100%', height: 40 },
  delayHint: { fontSize: fontSize.xs, color: colors.text.tertiary, textAlign: 'center' },
  actionButton: {
    width: '100%', padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', marginTop: spacing.xl,
  },
  startButton: { backgroundColor: colors.accent.success },
  stopButton: { backgroundColor: colors.accent.error },
  actionButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  navRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, width: '100%' },
  navButton: {
    flex: 1, backgroundColor: colors.bg.card, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  navButtonText: { fontSize: fontSize.md, fontWeight: '600', color: colors.accent.primary },
  navButtonSub: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
});
