// =============================================================================
// Lab screen — "My Bots" list, redesigned with modern card layout
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, TextInput, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../../services/api';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius, layout } from '../../theme/spacing';
import BotAvatar from '../../components/BotAvatar';
import TutorialTip from '../../components/TutorialTip';
import type { BotSummary } from '@peerzero/shared';
import { credibilityToStage, calculateHunger } from '@peerzero/shared';
import { timeAgo } from '../../utils/timeAgo';
import * as Haptics from 'expo-haptics';
import type { LabScreenProps } from '../../navigation/types';

const STATUS_COLORS: Record<string, string> = {
  running: colors.accent.success,
  stopped: colors.text.tertiary,
  paused: colors.accent.warning,
  error: colors.accent.error,
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  paused: 'Paused',
  error: 'Error',
};

export default function LabScreen({ navigation }: LabScreenProps) {
  const [botList, setBotList] = useState<BotSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const loadBots = useCallback(async () => {
    try {
      setError(null);
      const response = await botsApi.list() as { data: BotSummary[] };
      setBotList(response.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load bots');
      setBotList([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadBots();
    }, [loadBots]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadBots();
    setRefreshing(false);
  };

  const filteredBots = botList.filter(bot => {
    const matchesSearch = !search || bot.name.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = !statusFilter || bot.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleLongPress = (bot: BotSummary) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const actions: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [];

    if (bot.status === 'running') {
      actions.push({
        text: 'Stop Bot',
        onPress: async () => {
          try {
            await botsApi.stop(bot.id);
            await loadBots();
          } catch (err: unknown) {
            Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
          }
        },
      });
    } else if (bot.school_name) {
      actions.push({
        text: 'Start Bot',
        onPress: async () => {
          try {
            await botsApi.start(bot.id);
            await loadBots();
          } catch (err: unknown) {
            Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
          }
        },
      });
    }

    actions.push({
      text: 'Delete Bot',
      style: 'destructive',
      onPress: () => {
        Alert.alert('Delete Bot', `Delete "${bot.name}"? This cannot be undone.`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await botsApi.delete(bot.id);
                await loadBots();
              } catch (err: unknown) {
                Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
              }
            },
          },
        ]);
      },
    });

    actions.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(bot.name, 'Quick actions', actions);
  };

  const renderBot = ({ item, index }: { item: BotSummary; index: number }) => {
    const stage = credibilityToStage(item.cached_credibility);
    const statusColor = STATUS_COLORS[item.status] || colors.text.tertiary;
    const isRunning = item.status === 'running';

    return (
      <TouchableOpacity
        style={[
          styles.botCard,
          isRunning && styles.botCardRunning,
        ]}
        onPress={() => navigation.navigate('Bot', { botId: item.id })}
        onLongPress={() => handleLongPress(item)}
        activeOpacity={0.7}
      >
        {/* Accent top bar */}
        <View style={[
          styles.cardAccent,
          { backgroundColor: isRunning ? colors.accent.success : colors.accent.primary + '40' },
        ]} />

        <View style={styles.cardContent}>
          <BotAvatar
            botId={item.id}
            bodyColor={item.avatar_config?.body_color || colors.accent.primary}
            tier={stage}
            status={item.status}
            hunger={calculateHunger(item.last_cycle_at, item.status)}
            size={52}
            animate={isRunning}
            speciesSeed={item.avatar_config?.species_seed}
          />

          <View style={styles.botInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.botName} numberOfLines={1}>{item.name}</Text>
              {/* Status pill */}
              <View style={[styles.statusPill, { backgroundColor: statusColor + '18' }]}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.statusText, { color: statusColor }]}>
                  {STATUS_LABELS[item.status] || item.status}
                </Text>
              </View>
            </View>

            <Text style={styles.botSchool} numberOfLines={1}>
              {item.school_name || 'Not enrolled'}
            </Text>

            <View style={styles.metaRow}>
              {item.cached_credibility !== null && (
                <View style={styles.metaChip}>
                  <Text style={styles.metaValue}>{item.cached_credibility}</Text>
                  <Text style={styles.metaLabel}>cred</Text>
                </View>
              )}
              <View style={styles.metaChip}>
                <Text style={styles.metaValue}>{item.cycle_count}</Text>
                <Text style={styles.metaLabel}>cycles</Text>
              </View>
              {item.last_cycle_at && (
                <Text style={styles.lastCycleText}>{timeAgo(item.last_cycle_at)}</Text>
              )}
            </View>
          </View>

          {/* Chevron */}
          <Text style={styles.chevron}>›</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <TutorialTip
        tipId="lab_welcome"
        title="Welcome to Your Lab"
        message="This is where all your bots live. Create a bot, enroll it in a school, and watch it learn through peer review. Long-press a bot for quick actions."
      />
      {error ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>⚠️</Text>
          <Text style={styles.emptyTitle}>Something went wrong</Text>
          <Text style={styles.emptySubtitle}>{error}</Text>
          <TouchableOpacity onPress={loadBots} style={styles.retryLink} accessibilityRole="button" accessibilityLabel="Tap to retry loading bots">
            <Text style={styles.retryText}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      ) : botList.length === 0 ? (
        <View style={styles.emptyState}>
          <BotAvatar
            botId="empty-state-preview"
            bodyColor={colors.accent.primary}
            tier={0}
            status="paused"
            hunger="curious"
            size={140}
          />
          <Text style={styles.emptyTitle}>Your lab is empty</Text>
          <Text style={styles.emptySubtitle}>
            Create your first bot, give it a name and a color, then send it to school where it'll learn through adversarial peer review.
          </Text>
          <TouchableOpacity
            style={styles.createButtonLarge}
            onPress={() => navigation.navigate('CreateBot')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Create Your First Bot"
          >
            <Text style={styles.createButtonLargeText}>Create Your First Bot</Text>
          </TouchableOpacity>
          <Text style={styles.emptyHint}>It only takes 30 seconds</Text>

          <TouchableOpacity
            onPress={() => navigation.navigate('Welcome')}
            activeOpacity={0.7}
            style={styles.learnMoreButton}
            accessibilityRole="link"
            accessibilityLabel="How does PeerZero work?"
          >
            <Text style={styles.learnMoreText}>How does PeerZero work?</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Search + filter bar */}
          {botList.length >= 3 && (
            <View style={styles.searchSection}>
              <View style={styles.searchInputContainer}>
                <Text style={styles.searchIcon}>🔍</Text>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search bots..."
                  placeholderTextColor={colors.text.tertiary}
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  accessibilityLabel="Search bots"
                  accessibilityRole="search"
                />
              </View>
              <View style={styles.filterRow}>
                {['all', 'running', 'stopped', 'error'].map(status => (
                  <TouchableOpacity
                    key={status}
                    style={[
                      styles.filterPill,
                      (status === 'all' ? !statusFilter : statusFilter === status) && styles.filterPillActive,
                    ]}
                    onPress={() => setStatusFilter(status === 'all' ? null : status)}
                    activeOpacity={0.7}
                  >
                    {status !== 'all' && (
                      <View style={[styles.filterDot, { backgroundColor: STATUS_COLORS[status] }]} />
                    )}
                    <Text style={[
                      styles.filterPillText,
                      (status === 'all' ? !statusFilter : statusFilter === status) && styles.filterPillTextActive,
                    ]}>
                      {status === 'all' ? 'All' : STATUS_LABELS[status]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          <FlatList
            data={filteredBots}
            renderItem={renderBot}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.primary} />}
            ListEmptyComponent={
              search || statusFilter ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptySubtitle}>No bots match your search</Text>
                </View>
              ) : null
            }
          />
        </>
      )}

      {/* Floating create button */}
      {botList.length > 0 && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); navigation.navigate('CreateBot'); }}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Create new bot"
        >
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  list: {
    padding: layout.screenPadding,
    paddingTop: spacing.sm,
  },

  // ── Bot Card ──
  botCard: {
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    // Card shadow
    shadowColor: colors.shadow.card,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  botCardRunning: {
    borderColor: colors.accent.success + '30',
    shadowColor: colors.shadow.success,
    shadowOpacity: 0.25,
  },
  cardAccent: {
    height: 2,
    width: '100%',
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: layout.cardPadding,
  },
  botInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  botName: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text.primary,
    flex: 1,
    letterSpacing: -0.3,
  },
  botSchool: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    marginTop: 3,
  },
  botCredibility: {
    fontSize: fontSize.sm,
    color: colors.accent.secondary,
    marginTop: 2,
  },

  // ── Status Pill ──
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    gap: 5,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: fontSize.xxs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // ── Meta Row ──
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaValue: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.accent.secondary,
  },
  metaLabel: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  lastCycleText: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    marginLeft: 'auto',
  },
  chevron: {
    fontSize: 22,
    color: colors.text.tertiary,
    marginLeft: spacing.sm,
    fontWeight: '300',
  },

  // ── Search & Filters ──
  searchSection: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
  },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: colors.text.primary,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.md,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg.secondary,
  },
  filterPillActive: {
    backgroundColor: colors.accent.primary + '18',
    borderColor: colors.accent.primary + '50',
  },
  filterDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  filterPillText: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    fontWeight: '500',
  },
  filterPillTextActive: {
    color: colors.accent.primary,
    fontWeight: '600',
  },

  // ── Empty State ──
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 24,
    paddingHorizontal: spacing.md,
  },
  emptyHint: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    marginTop: spacing.sm,
  },
  retryLink: {
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  retryText: {
    color: colors.accent.primary,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  learnMoreButton: {
    marginTop: spacing.xl,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  learnMoreText: {
    fontSize: fontSize.sm,
    color: colors.accent.secondary,
    fontWeight: '600',
  },
  createButtonLarge: {
    backgroundColor: colors.accent.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl + spacing.md,
    borderRadius: borderRadius.md,
    marginTop: spacing.lg,
    // Button glow
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  createButtonLargeText: {
    color: '#fff',
    fontSize: fontSize.lg,
    fontWeight: '700',
    letterSpacing: -0.2,
  },

  // ── FAB ──
  fab: {
    position: 'absolute',
    bottom: spacing.xl,
    right: spacing.xl,
    width: layout.fabSize,
    height: layout.fabSize,
    borderRadius: layout.fabSize / 2,
    backgroundColor: colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
  },
  fabText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
  },
});
