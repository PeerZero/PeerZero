// =============================================================================
// Activity Log screen — scrollable feed of everything the bot has done
// Each entry has a headline, summary, mood indicator, and timestamp.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { ActivityEntry, MoodType } from '@peerzero/shared';

const MOOD_COLORS: Record<MoodType, string> = {
  positive: colors.mood.positive,
  negative: colors.mood.negative,
  neutral: colors.mood.neutral,
  milestone: colors.mood.milestone,
};

export default function LogScreen({ route }: any) {
  const { botId } = route.params;
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const loadPage = useCallback(async (p: number, append = false) => {
    try {
      const result = await botsApi.activity(botId, p) as { data: ActivityEntry[]; has_more: boolean };
      setEntries(prev => append ? [...prev, ...result.data] : result.data);
      setHasMore(result.has_more);
      setPage(p);
    } catch {
      // Silent fail
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadPage(1); }, [loadPage]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadPage(1);
    setRefreshing(false);
  };

  const onEndReached = () => {
    if (hasMore) loadPage(page + 1, true);
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderEntry = ({ item }: { item: ActivityEntry }) => {
    const mood = item.translated?.mood || 'neutral';
    return (
      <View style={styles.entry}>
        <View style={[styles.moodBar, { backgroundColor: MOOD_COLORS[mood] }]} />
        <View style={styles.entryContent}>
          <Text style={styles.headline}>{item.translated?.headline || item.action_type}</Text>
          <Text style={styles.summary}>{item.translated?.summary || ''}</Text>
          {item.error && <Text style={styles.error}>{item.error}</Text>}
          <View style={styles.meta}>
            <Text style={styles.metaText}>Cycle {item.cycle_number}</Text>
            {item.duration_ms && <Text style={styles.metaText}>{(item.duration_ms / 1000).toFixed(1)}s</Text>}
            {item.llm_tokens_used && <Text style={styles.metaText}>{item.llm_tokens_used} tokens</Text>}
            <Text style={styles.metaText}>{formatTime(item.created_at)}</Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={entries}
        renderItem={renderEntry}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.primary} />}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No activity yet. Start your bot to see the log!</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  list: { padding: spacing.md },
  entry: {
    flexDirection: 'row', backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, overflow: 'hidden',
  },
  moodBar: { width: 4 },
  entryContent: { flex: 1, padding: spacing.md },
  headline: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  summary: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: 2 },
  error: { fontSize: fontSize.sm, color: colors.accent.error, marginTop: spacing.xs },
  meta: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  metaText: { fontSize: fontSize.xs, color: colors.text.tertiary },
  empty: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.md, textAlign: 'center' },
});
