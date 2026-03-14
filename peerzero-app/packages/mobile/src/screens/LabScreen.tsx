// =============================================================================
// Lab screen — "My Bots" list, the main landing page after login
// Shows all the user's bots as Tamagotchi-style cards with status indicators.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { BotSummary } from '@peerzero/shared';

const STATUS_COLORS: Record<string, string> = {
  running: colors.accent.success,
  stopped: colors.text.tertiary,
  paused: colors.accent.warning,
  error: colors.accent.error,
};

export default function LabScreen({ navigation }: any) {
  const [botList, setBotList] = useState<BotSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadBots = useCallback(async () => {
    try {
      const data = await botsApi.list() as BotSummary[];
      setBotList(data);
    } catch {
      // Silently fail — user will see empty state
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

  const renderBot = ({ item }: { item: BotSummary }) => (
    <TouchableOpacity
      style={styles.botCard}
      onPress={() => navigation.navigate('Bot', { botId: item.id })}
    >
      {/* Avatar placeholder — will be replaced with actual avatar renderer */}
      <View style={[styles.avatar, { backgroundColor: item.avatar_config?.body_color || colors.accent.primary }]}>
        <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
      </View>

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
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {botList.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No bots yet</Text>
          <Text style={styles.emptySubtitle}>Buy a bot shell to get started, then send it to school!</Text>
        </View>
      ) : (
        <FlatList
          data={botList}
          renderItem={renderBot}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.primary} />}
        />
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
  },
  avatar: {
    width: 56, height: 56, borderRadius: borderRadius.full, justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { fontSize: fontSize.xl, fontWeight: '700', color: '#fff' },
  botInfo: { flex: 1, marginLeft: spacing.md },
  botName: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  botSchool: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: 2 },
  botCredibility: { fontSize: fontSize.sm, color: colors.accent.secondary, marginTop: 2 },
  statusContainer: { alignItems: 'flex-end' },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: fontSize.xs, color: colors.text.secondary, marginTop: 4, textTransform: 'capitalize' },
  cycleText: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: '600', color: colors.text.primary, marginBottom: spacing.sm },
  emptySubtitle: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center' },
});
