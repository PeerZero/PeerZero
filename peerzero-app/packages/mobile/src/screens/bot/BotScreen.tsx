// =============================================================================
// Bot screen — the Tamagotchi view for a single bot
// Shows avatar, status, key stats, and action buttons (start/stop, brain, log)
// =============================================================================

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Switch, Share, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import { bots as botsApi, payments as paymentsApi } from '../../services/api';
import { useBotStream } from '../../hooks/useBotStream';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import BotAvatar from '../../components/BotAvatar';
import BotDialogue from '../../components/BotDialogue';
import SkeletonLoader from '../../components/SkeletonLoader';
import TutorialTip from '../../components/TutorialTip';
import MilestoneModal from '../../components/MilestoneModal';
import type { MilestoneType } from '../../components/MilestoneModal';
import * as WebBrowser from 'expo-web-browser';
import * as Haptics from 'expo-haptics';
import type { BotDetail } from '@peerzero/shared';
import { credibilityToStage, calculateHunger, getGradePriceDisplay, GRADUATION_GRADE, getGradePriceCents, GRADE_PRICES_CENTS } from '@peerzero/shared';
import type { BotScreenProps } from '../../navigation/types';
import { timeAgo } from '../../utils/timeAgo';

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

export default function BotScreen({ route, navigation }: BotScreenProps) {
  const { botId } = route.params;
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [delayDraft, setDelayDraft] = useState<number | null>(null);
  const [unlockedGrades, setUnlockedGrades] = useState<number[]>([]);
  // Milestone tracking
  const [milestoneVisible, setMilestoneVisible] = useState(false);
  const [milestoneData, setMilestoneData] = useState<{
    type: MilestoneType;
    botId: string;
    botName: string;
    bodyColor: string;
    speciesSeed?: string;
    newTier?: number;
    oldTier?: number;
    coreIdentity?: string;
    totalCycles?: number;
    finalCredibility?: number;
    convictions?: string[];
    selfNarrative?: string;
  } | null>(null);
  const prevTierRef = useRef<number | null>(null);
  const prevCycleCountRef = useRef<number | null>(null);
  const prevGradeRef = useRef<number | null>(null);

  const loadBot = useCallback(async () => {
    try {
      const data = await botsApi.get(botId) as BotDetail;
      setBot(data);
      // Load grade unlock status if enrolled
      if (data.school_id) {
        const status = await paymentsApi.gradeStatus(botId) as { unlocked_grades: number[]; highest_unlocked: number };
        setUnlockedGrades(status.unlocked_grades);
      }
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadBot(); }, [loadBot]));

  // Detect milestones when bot data changes
  useEffect(() => {
    if (!bot) return;
    const currentTier = credibilityToStage(bot.cached_credibility);
    const currentCycles = bot.cycle_count || 0;
    const currentGrade = bot.cached_grade || 0;

    // First cycle complete
    if (prevCycleCountRef.current === 0 && currentCycles > 0) {
      showMilestone('first_cycle');
    }
    // Evolution (tier changed upward)
    else if (prevTierRef.current !== null && currentTier > prevTierRef.current) {
      showMilestone('evolution', { newTier: currentTier, oldTier: prevTierRef.current });
    }
    // Graduation (hit grade 12)
    else if (prevGradeRef.current !== null && prevGradeRef.current < GRADUATION_GRADE && currentGrade >= GRADUATION_GRADE) {
      showMilestone('graduation', {
        totalCycles: currentCycles,
        finalCredibility: bot.cached_credibility ?? undefined,
      });
    }

    prevTierRef.current = currentTier;
    prevCycleCountRef.current = currentCycles;
    prevGradeRef.current = currentGrade;
  }, [bot?.cached_credibility, bot?.cycle_count, bot?.cached_grade]);

  const showMilestone = (type: MilestoneType, extra?: Partial<typeof milestoneData>) => {
    if (!bot) return;
    setMilestoneData({
      type,
      botId: bot.id,
      botName: bot.name,
      bodyColor: bot.avatar_config?.body_color || colors.accent.primary,
      speciesSeed: bot.avatar_config?.species_seed,
      ...extra,
    });
    setMilestoneVisible(true);
  };

  // Real-time updates via WebSocket
  const { isConnected } = useBotStream({
    botId,
    onStatusChange: useCallback((status: string) => {
      setBot(prev => prev ? { ...prev, status: status as BotDetail['status'] } : null);
    }, []),
    onActivity: useCallback(() => {
      loadBot();
    }, [loadBot]),
  });

  const [startStopLoading, setStartStopLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [gradeUnlockLoading, setGradeUnlockLoading] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadBot();
    setRefreshing(false);
  }, [loadBot]);

  const handleStartStop = async () => {
    if (!bot || startStopLoading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const wasRunning = bot.status === 'running';
    setStartStopLoading(true);
    // Optimistic update — flip status immediately so the button responds instantly
    setBot(prev => prev ? { ...prev, status: wasRunning ? 'stopped' : 'running' } : null);
    try {
      if (wasRunning) {
        await botsApi.stop(botId);
      } else {
        await botsApi.start(botId);
      }
      await loadBot();
    } catch (err: unknown) {
      // Revert on failure
      setBot(prev => prev ? { ...prev, status: wasRunning ? 'running' : 'stopped' } : null);
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setStartStopLoading(false);
    }
  };

  const handleRetry = async () => {
    if (retryLoading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRetryLoading(true);
    try {
      await botsApi.start(botId);
      await loadBot();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRetryLoading(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Bot',
      `Are you sure you want to delete "${bot?.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await botsApi.delete(botId);
              navigation.goBack();
            } catch (err: unknown) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
            }
          },
        },
      ],
    );
  };

  const handleGradeUnlock = async (mode: 'next' | 'graduation') => {
    if (gradeUnlockLoading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setGradeUnlockLoading(true);
    try {
      const result = mode === 'next'
        ? await paymentsApi.gradeCheckout(botId) as { session_url: string }
        : await paymentsApi.gradeBulkCheckout(botId, 'graduation') as { session_url: string };

      if (result.session_url) {
        await WebBrowser.openBrowserAsync(result.session_url, {
          dismissButtonStyle: 'close',
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.AUTOMATIC,
        });
      }
      // Refresh bot data — payment may have completed (or was skipped)
      await loadBot();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setGradeUnlockLoading(false);
    }
  };

  const handleToggleThinking = async (value: boolean) => {
    if (!bot) return;
    setBot(prev => prev ? { ...prev, extended_thinking: value } : null);
    try {
      await botsApi.update(botId, { extended_thinking: value });
    } catch (err: unknown) {
      // Revert on failure
      setBot(prev => prev ? { ...prev, extended_thinking: !value } : null);
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  const handleTogglePublic = async (value: boolean) => {
    if (!bot) return;
    setBot(prev => prev ? { ...prev, is_public: value } : null);
    try {
      const updated = await botsApi.update(botId, { is_public: value }) as BotDetail;
      setBot(updated);
    } catch (err: unknown) {
      setBot(prev => prev ? { ...prev, is_public: !value } : null);
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  const handleShareProfile = async () => {
    if (!bot?.public_slug) return;
    const url = `https://peerzero.com/bot/${bot.public_slug}`;
    try {
      await Share.share({
        message: `Check out ${bot.name} on PeerZero: ${url}`,
        url,
      });
    } catch {
      // User cancelled share
    }
  };

  const handleDelayChange = async (seconds: number) => {
    if (!bot) return;
    setDelayDraft(null);
    try {
      await botsApi.update(botId, { cycle_delay_seconds: seconds });
      setBot(prev => prev ? { ...prev, cycle_delay_seconds: seconds } : null);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  if (!bot) return (
    <View style={[styles.container, { alignItems: 'center', paddingTop: spacing.xl }]}>
      {/* Avatar skeleton */}
      <SkeletonLoader width={140} height={140} borderRadius={70} />
      {/* Name skeleton */}
      <SkeletonLoader width={160} height={22} borderRadius={6} style={{ marginTop: spacing.md }} />
      {/* School name skeleton */}
      <SkeletonLoader width={120} height={14} borderRadius={4} style={{ marginTop: spacing.sm }} />
      {/* Status badge skeleton */}
      <SkeletonLoader width={80} height={28} borderRadius={999} style={{ marginTop: spacing.md }} />
      {/* Stats row skeleton */}
      <View style={{ flexDirection: 'row', marginTop: spacing.xl, gap: spacing.xl }}>
        <View style={{ alignItems: 'center' }}>
          <SkeletonLoader width={60} height={28} borderRadius={6} />
          <SkeletonLoader width={50} height={10} borderRadius={4} style={{ marginTop: spacing.xs }} />
        </View>
        <View style={{ alignItems: 'center' }}>
          <SkeletonLoader width={60} height={28} borderRadius={6} />
          <SkeletonLoader width={50} height={10} borderRadius={4} style={{ marginTop: spacing.xs }} />
        </View>
        <View style={{ alignItems: 'center' }}>
          <SkeletonLoader width={60} height={28} borderRadius={6} />
          <SkeletonLoader width={50} height={10} borderRadius={4} style={{ marginTop: spacing.xs }} />
        </View>
      </View>
      {/* Action button skeleton */}
      <SkeletonLoader width="100%" height={48} borderRadius={borderRadius.md} style={{ marginTop: spacing.xl, paddingHorizontal: spacing.xl }} />
      {/* Nav buttons skeleton */}
      <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, width: '100%', paddingHorizontal: spacing.xl }}>
        <SkeletonLoader width={0} height={80} borderRadius={borderRadius.md} style={{ flex: 1 }} />
        <SkeletonLoader width={0} height={80} borderRadius={borderRadius.md} style={{ flex: 1 }} />
        <SkeletonLoader width={0} height={80} borderRadius={borderRadius.md} style={{ flex: 1 }} />
      </View>
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6C5CE7" colors={['#6C5CE7']} />}>
      <TutorialTip
        tipId="bot_overview"
        title="Your Bot's Home"
        message="This is your bot's Tamagotchi view. Start and stop it, adjust cycle speed, check stats, and explore its brain. Enroll it in a school to begin learning."
      />
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
        status={bot.status}
        hunger={calculateHunger(bot.last_cycle_at, bot.status)}
        size={140}
        speciesSeed={bot.avatar_config?.species_seed}
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

      {/* Bot dialogue — contextual speech bubble */}
      <BotDialogue bot={bot} />

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
          <TouchableOpacity style={[styles.retryButton, retryLoading && styles.actionButtonDisabled]} onPress={handleRetry} disabled={retryLoading} accessibilityRole="button" accessibilityLabel="Retry starting the bot">
            {retryLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.retryButtonText}>Retry</Text>
            )}
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
            <TouchableOpacity style={[styles.gradeUnlockButton, gradeUnlockLoading && styles.actionButtonDisabled]} onPress={() => handleGradeUnlock('next')} disabled={gradeUnlockLoading} accessibilityRole="button" accessibilityLabel={`Unlock Grade ${currentGrade} for ${getGradePriceDisplay(currentGrade)}`}>
              {gradeUnlockLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.gradeUnlockButtonText}>
                  Unlock Grade {currentGrade} — {getGradePriceDisplay(currentGrade)}
                </Text>
              )}
            </TouchableOpacity>
            {canShowGraduation && currentGrade < GRADUATION_GRADE && (
              <TouchableOpacity
                style={[styles.gradeUnlockButton, styles.gradeUnlockButtonAlt, gradeUnlockLoading && styles.actionButtonDisabled]}
                onPress={() => handleGradeUnlock('graduation')}
                disabled={gradeUnlockLoading}
                accessibilityRole="button"
                accessibilityLabel={`Unlock all grades through graduation for $${(gradCost / 100).toFixed(2)}`}
              >
                {gradeUnlockLoading ? (
                  <ActivityIndicator color={colors.accent.primary} size="small" />
                ) : (
                  <Text style={styles.gradeUnlockButtonAltText}>
                    Unlock All Through Graduation — ${(gradCost / 100).toFixed(2)}
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        );
      })()}

      {/* Next action hint */}
      {bot.cached_next_action && (
        <Text style={styles.nextAction}>{bot.cached_next_action}</Text>
      )}

      {/* Collapsible settings section */}
      <TouchableOpacity
        style={styles.settingsToggle}
        onPress={() => setSettingsOpen(!settingsOpen)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Toggle settings"
        accessibilityState={{ expanded: settingsOpen }}
      >
        <Text style={styles.settingsToggleText}>Settings</Text>
        <Text style={styles.settingsToggleHint}>
          {formatDelay(currentDelay)} cycle{bot.extended_thinking ? ' · Deep thinking' : ''}{bot.is_public ? ' · Public' : ''}
        </Text>
        <Text style={styles.settingsChevron}>{settingsOpen ? '▾' : '▸'}</Text>
      </TouchableOpacity>

      {settingsOpen && (
        <View style={styles.settingsBody}>
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
              accessibilityLabel={`Cycle delay: ${formatDelay(currentDelay)}`}
              accessibilityHint="Adjust how often the bot runs its cycle"
            />
            {isRunning && (
              <Text style={styles.delayHint}>Changes take effect next cycle</Text>
            )}
          </View>

          {/* Extended Thinking toggle */}
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Extended Thinking</Text>
              <Text style={styles.settingHint}>
                Deeper reasoning, more API tokens per cycle
              </Text>
            </View>
            <Switch
              value={bot.extended_thinking}
              onValueChange={handleToggleThinking}
              trackColor={{ false: colors.bg.elevated, true: colors.accent.primary + '60' }}
              thumbColor={bot.extended_thinking ? colors.accent.primary : colors.text.tertiary}
              accessibilityLabel="Toggle extended thinking"
            />
          </View>

          {/* Public profile toggle */}
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Public Profile</Text>
              <Text style={styles.settingHint}>
                Share progress, skills, and identity publicly
              </Text>
            </View>
            <Switch
              value={bot.is_public}
              onValueChange={handleTogglePublic}
              trackColor={{ false: colors.bg.elevated, true: colors.accent.primary + '60' }}
              thumbColor={bot.is_public ? colors.accent.primary : colors.text.tertiary}
              accessibilityLabel="Toggle public profile"
            />
          </View>
          {bot.is_public && bot.public_slug && (
            <TouchableOpacity style={styles.shareButton} onPress={handleShareProfile} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Share profile link">
              <Text style={styles.shareButtonText}>Share Profile Link</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Action buttons */}
      {!isEnrolled ? (
        <View style={styles.enrollPrompt}>
          <Text style={styles.enrollPromptTitle}>Ready to learn?</Text>
          <Text style={styles.enrollPromptText}>
            Enroll your bot in a school where it'll write papers, get reviewed by peers, and build real reasoning skills.
          </Text>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.accent.primary }]}
            onPress={() => navigation.navigate('EnrollBot', { botId })}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Enroll in School"
          >
            <Text style={styles.actionButtonText}>Enroll in School</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.actionButton, isRunning ? styles.stopButton : styles.startButton, startStopLoading && styles.actionButtonDisabled]}
          onPress={handleStartStop}
          disabled={startStopLoading}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={isRunning ? 'Stop the bot' : 'Start the bot'}
        >
          {startStopLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.actionButtonText}>{isRunning ? 'Stop' : 'Start'}</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Chat button — prominent, full-width */}
      <TouchableOpacity
        style={styles.chatButton}
        onPress={() => navigation.navigate('Chat', { botId })}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Chat"
        accessibilityHint="Talk to your bot"
      >
        <Text style={styles.chatButtonIcon}>💬</Text>
        <View style={styles.chatButtonTextContainer}>
          <Text style={styles.chatButtonTitle}>Chat with {bot.name}</Text>
          <Text style={styles.chatButtonSub}>Talk, ask questions, get updates</Text>
        </View>
      </TouchableOpacity>

      <View style={styles.navRow}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Brain', { botId })}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Brain"
          accessibilityHint="View memory and skills"
        >
          <Text style={styles.navButtonIcon}>🧠</Text>
          <Text style={styles.navButtonText}>Brain</Text>
          <Text style={styles.navButtonSub}>Memory & skills</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Log', { botId })}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Log"
          accessibilityHint="View activity feed"
        >
          <Text style={styles.navButtonIcon}>📋</Text>
          <Text style={styles.navButtonText}>Log</Text>
          <Text style={styles.navButtonSub}>Activity feed</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Stats', { botId })}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Stats"
          accessibilityHint="View charts and trends"
        >
          <Text style={styles.navButtonIcon}>📊</Text>
          <Text style={styles.navButtonText}>Stats</Text>
          <Text style={styles.navButtonSub}>Charts & trends</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.navRow}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => navigation.navigate('Platforms', { botId })}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Platforms"
          accessibilityHint="View external connections"
        >
          <Text style={styles.navButtonIcon}>🌐</Text>
          <Text style={styles.navButtonText}>Platforms</Text>
          <Text style={styles.navButtonSub}>External connections</Text>
        </TouchableOpacity>
      </View>

      {/* Last cycle info */}
      {bot.last_cycle_at && (
        <Text style={styles.lastCycleText}>Last cycle: {timeAgo(bot.last_cycle_at)}</Text>
      )}

      {/* Danger zone */}
      <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Delete Bot">
        <Text style={styles.deleteButtonText}>Delete Bot</Text>
      </TouchableOpacity>

      {/* Milestone celebration modal */}
      <MilestoneModal
        visible={milestoneVisible}
        milestone={milestoneData}
        onDismiss={() => setMilestoneVisible(false)}
      />
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
  settingsToggle: {
    flexDirection: 'row', alignItems: 'center', width: '100%', marginTop: spacing.lg,
    paddingVertical: spacing.md, paddingHorizontal: spacing.md,
    backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  settingsToggleText: {
    fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary,
  },
  settingsToggleHint: {
    flex: 1, fontSize: fontSize.xs, color: colors.text.tertiary,
    marginLeft: spacing.sm, textAlign: 'right',
  },
  settingsChevron: { fontSize: fontSize.md, color: colors.text.tertiary, marginLeft: spacing.sm },
  settingsBody: {
    width: '100%', backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border, borderTopWidth: 0,
    borderTopLeftRadius: 0, borderTopRightRadius: 0,
    paddingHorizontal: spacing.md, paddingBottom: spacing.md,
    marginTop: -1,
  },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border,
  },
  settingInfo: { flex: 1, marginRight: spacing.md },
  settingTitle: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text.secondary },
  settingHint: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  delaySection: { width: '100%', paddingVertical: spacing.sm },
  delayLabel: { fontSize: fontSize.sm, color: colors.text.secondary, textAlign: 'center' },
  delayValue: { color: colors.accent.primary, fontWeight: '600' },
  slider: { width: '100%', height: 40 },
  delayHint: { fontSize: fontSize.xs, color: colors.text.tertiary, textAlign: 'center' },
  shareButton: {
    backgroundColor: colors.accent.secondary + '20', paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg, borderRadius: borderRadius.sm, alignSelf: 'center',
    marginTop: spacing.sm, borderWidth: 1, borderColor: colors.accent.secondary + '40',
  },
  shareButtonText: { color: colors.accent.secondary, fontWeight: '600', fontSize: fontSize.sm },
  actionButton: {
    width: '100%', padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', marginTop: spacing.xl,
  },
  startButton: { backgroundColor: colors.accent.success },
  stopButton: { backgroundColor: colors.accent.error },
  actionButtonDisabled: { opacity: 0.6 },
  actionButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  chatButton: {
    flexDirection: 'row', alignItems: 'center', width: '100%',
    backgroundColor: colors.accent.primary + '15', padding: spacing.md,
    borderRadius: borderRadius.md, marginTop: spacing.lg,
    borderWidth: 1, borderColor: colors.accent.primary + '40',
  },
  chatButtonIcon: { fontSize: 28, marginRight: spacing.md },
  chatButtonTextContainer: { flex: 1 },
  chatButtonTitle: {
    fontSize: fontSize.md, fontWeight: '700', color: colors.accent.primary,
  },
  chatButtonSub: {
    fontSize: fontSize.xs, color: colors.text.secondary, marginTop: 2,
  },
  navRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, width: '100%' },
  navButton: {
    flex: 1, backgroundColor: colors.bg.card, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  navButtonIcon: { fontSize: 22, marginBottom: 4 },
  navButtonText: { fontSize: fontSize.md, fontWeight: '600', color: colors.accent.primary },
  navButtonSub: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  lastCycleText: {
    fontSize: fontSize.sm, color: colors.text.tertiary, marginTop: spacing.xl, textAlign: 'center',
  },
  deleteButton: {
    marginTop: spacing.lg, marginBottom: spacing.xl, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
    borderWidth: 1, borderColor: colors.accent.error + '30',
  },
  deleteButtonText: { color: colors.text.tertiary, fontSize: fontSize.sm },
  enrollPrompt: {
    width: '100%', backgroundColor: colors.accent.primary + '10', padding: spacing.lg,
    borderRadius: borderRadius.md, marginTop: spacing.xl, alignItems: 'center',
    borderWidth: 1, borderColor: colors.accent.primary + '30',
  },
  enrollPromptTitle: {
    fontSize: fontSize.lg, fontWeight: '700', color: colors.accent.primary, marginBottom: spacing.xs,
  },
  enrollPromptText: {
    fontSize: fontSize.sm, color: colors.text.secondary, textAlign: 'center',
    lineHeight: 20, marginBottom: spacing.md,
  },
});
