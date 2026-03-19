// =============================================================================
// Lab screen — "My Bots" list, the main landing page after login
// Shows all the user's bots as Tamagotchi-style cards with status indicators.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, TextInput, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import BotAvatar from '../components/BotAvatar';
import TutorialTip from '../components/TutorialTip';
import type { BotSummary } from '@peerzero/shared';
import { credibilityToStage, calculateHunger } from '@peerzero/shared';
import { timeAgo } from '../utils/timeAgo';
import * as Haptics from 'expo-haptics';
import type { LabScreenProps } from '../navigation/types';

const STATUS_COLORS: Record<string, string> = {
  running: colors.accent.success,
  stopped: colors.text.tertiary,
  paused: colors.accent.warning,
  error: colors.accent.error,
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
      const data = await botsApi.list() as BotSummary[];
      setBotList(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load bots');
      setBotList([]);  // Clear stale data
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

  // Filter bots by search and status
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

  const renderBot = ({ item }: { item: BotSummary }) => (
    <TouchableOpacity
      style={[
        styles.botCard,
        item.status === 'running' && styles.botCardRunning,
      ]}
      onPress={() => navigation.navigate('Bot', { botId: item.id })}
      onLongPress={() => handleLongPress(item)}
      activeOpacity={0.7}
    >
      <BotAvatar
        botId={item.id}
        bodyColor={item.avatar_config?.body_color || colors.accent.primary}
        tier={credibilityToStage(item.cached_credibility)}
        status={item.status}
        hunger={calculateHunger(item.last_cycle_at, item.status)}
        size={56}
        animate={item.status === 'running'}
        speciesSeed={item.avatar_config?.species_seed}
      />

      <View style={styles.botInfo}>
        <Text style={styles.botName}>{item.name}</Text>
        <Text style={styles.botSchool}>{item.school_name || 'Not enrolled'}</Text>
        {item.cached_credibility !== null && (
          <Text style={styles.botCredibility}>Credibility: {item.cached_credibility}</Text>
        )}
      </View>

      <View style={styles.statusContainer}>
        <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[item.status] || colors.text.tertiary }]} />
        <Text style={styles.statusText}>{item.status}</Text>
        <Text style={styles.cycleText}>Cycle {item.cycle_count}</Text>
        {item.last_cycle_at && (
          <Text style={styles.lastCycleText}>{timeAgo(item.last_cycle_at)}</Text>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <TutorialTip
        tipId="lab_welcome"
        title="Welcome to Your Lab"
        message="This is where all your bots live. Create a bot, enroll it in a school, and watch it learn through peer review. Long-press a bot for quick actions."
      />
      {error ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Something went wrong</Text>
          <Text style={styles.emptySubtitle}>{error}</Text>
          <TouchableOpacity onPress={loadBots} accessibilityRole="button" accessibilityLabel="Tap to retry loading bots">
            <Text style={{ color: colors.accent.primary, marginTop: spacing.md, fontSize: fontSize.md }}>Tap to retry</Text>
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
            size={120}
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
          {/* Search + filter bar (show when 3+ bots) */}
          {botList.length >= 3 && (
            <View style={styles.searchSection}>
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
                    <Text style={[
                      styles.filterPillText,
                      (status === 'all' ? !statusFilter : statusFilter === status) && styles.filterPillTextActive,
                    ]}>
                      {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
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

      {/* Floating create button (when bots exist) */}
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
  container: { flex: 1, backgroundColor: colors.bg.primary },
  list: { padding: spacing.md },
  botCard: {
    backgroundColor: colors.bg.card, borderRadius: borderRadius.lg, padding: spacing.md,
    marginBottom: spacing.md, flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
    // Subtle card shadow
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 4, elevation: 2,
  },
  botCardRunning: {
    borderColor: colors.accent.success + '40',
    shadowColor: colors.accent.success, shadowOpacity: 0.2,
  },
  botInfo: { flex: 1, marginLeft: spacing.md },
  botName: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  botSchool: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: 2 },
  botCredibility: { fontSize: fontSize.sm, color: colors.accent.secondary, marginTop: 2 },
  statusContainer: { alignItems: 'flex-end' },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: fontSize.xs, color: colors.text.secondary, marginTop: 4, textTransform: 'capitalize' },
  cycleText: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  lastCycleText: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  searchSection: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  searchInput: {
    backgroundColor: colors.bg.card, color: colors.text.primary, padding: spacing.sm,
    borderRadius: borderRadius.md, fontSize: fontSize.md,
    borderWidth: 1, borderColor: colors.border,
  },
  filterRow: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.sm },
  filterPill: {
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    borderRadius: borderRadius.full, borderWidth: 1, borderColor: colors.border,
  },
  filterPillActive: { backgroundColor: colors.accent.primary, borderColor: colors.accent.primary },
  filterPillText: { fontSize: fontSize.xs, color: colors.text.secondary },
  filterPillTextActive: { color: '#fff', fontWeight: '600' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: '600', color: colors.text.primary, marginBottom: spacing.sm },
  emptySubtitle: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center', lineHeight: 22, paddingHorizontal: spacing.md },
  emptyHint: { fontSize: fontSize.sm, color: colors.text.tertiary, marginTop: spacing.sm },
  learnMoreButton: { marginTop: spacing.xl, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  learnMoreText: { fontSize: fontSize.sm, color: colors.accent.secondary, fontWeight: '600' },
  createButtonLarge: {
    backgroundColor: colors.accent.primary, paddingVertical: spacing.md, paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.md, marginTop: spacing.lg,
  },
  createButtonLargeText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  fab: {
    position: 'absolute', bottom: spacing.xl, right: spacing.xl,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.accent.primary, justifyContent: 'center', alignItems: 'center',
    // Elevation for Android, shadow for iOS
    elevation: 6,
    shadowColor: colors.accent.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8,
  },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '300', marginTop: -2 },
});
