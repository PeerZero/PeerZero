// =============================================================================
// Activity Log screen — Tasks and Content tabs
//
// Tasks tab: operational metadata (submitted paper, reviewed, enrolled, etc.)
// Content tab: the actual text (paper body, review text, bounty evidence)
//
// Users can delete individual entries or clear all activity. Deletions are
// soft-deletes on the server — the bot's internal memory is unaffected.
// =============================================================================

import React, { useState, useCallback, useRef } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Alert, Animated } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../services/api';
import { useBotStream } from '../hooks/useBotStream';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { ActivityEntry, MoodType, ActivityCategory, ExternalActivityEntry } from '@peerzero/shared';

const MOOD_COLORS: Record<MoodType, string> = {
  positive: colors.mood.positive,
  negative: colors.mood.negative,
  neutral: colors.mood.neutral,
  milestone: colors.mood.milestone,
};

const ACTION_ICONS: Record<string, string> = {
  paper: 'P',
  review: 'R',
  bounty: 'B',
  revision: 'V',
  reaffirmation: 'A',
  condense: 'C',
  reflect: 'I',
  register: 'E',
  error: '!',
};

type TabKey = 'task' | 'content' | 'external';

export default function LogScreen({ route }: any) {
  const { botId } = route.params;
  const [activeTab, setActiveTab] = useState<TabKey>('task');
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [extEntries, setExtEntries] = useState<ExternalActivityEntry[]>([]);
  const [extPage, setExtPage] = useState(1);
  const [extHasMore, setExtHasMore] = useState(true);
  const loadingRef = useRef(false);

  // Real-time WebSocket stream
  const { isConnected } = useBotStream({
    botId,
    onActivity: useCallback((event: any) => {
      if (event.translated) {
        const newEntry: ActivityEntry = {
          id: `ws-${Date.now()}`,
          cycle_number: event.cycle_number || 0,
          action_type: (event.action_type || 'unknown') as any,
          category: 'task' as ActivityCategory,
          translated: event.translated,
          content_text: null,
          error: event.error || null,
          duration_ms: event.duration_ms || null,
          llm_tokens_used: event.llm_tokens_used || null,
          created_at: event.created_at || new Date().toISOString(),
        };
        setEntries(prev => [newEntry, ...prev]);
      }
    }, []),
    onExternalActivity: useCallback((event: any) => {
      const newExt: ExternalActivityEntry = {
        id: `ws-ext-${Date.now()}`,
        platform: event.platform || '',
        action: event.action || '',
        summary: event.summary || '',
        content_preview: event.content_preview || null,
        skills_demonstrated: event.skills_demonstrated || [],
        bot_timestamp: event.bot_timestamp || null,
        created_at: event.created_at || new Date().toISOString(),
      };
      setExtEntries(prev => [newExt, ...prev]);
    }, []),
  });

  const loadPage = useCallback(async (p: number, append = false, tab?: TabKey) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      setError(null);
      const category = (tab ?? activeTab) as 'task' | 'content';
      const result = await botsApi.activity(botId, p, category);
      if (!result || !Array.isArray((result as any).data)) {
        throw new Error('Invalid response format');
      }
      const { data, has_more } = result as { data: ActivityEntry[]; has_more: boolean };
      setEntries(prev => append ? [...prev, ...data] : data);
      setHasMore(has_more);
      setPage(p);
    } catch (err: any) {
      if (!append) {
        setError(err?.message || 'Failed to load activity');
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [botId, activeTab]);

  const loadExtPage = useCallback(async (p: number, append = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await botsApi.externalActivity(botId, p) as { data: ExternalActivityEntry[]; has_more: boolean };
      setExtEntries(prev => append ? [...prev, ...result.data] : result.data);
      setExtHasMore(result.has_more);
      setExtPage(p);
    } catch (err: any) {
      if (!append) setError(err?.message || 'Failed to load external activity');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadPage(1); }, [loadPage]));

  const onTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setEntries([]);
    setExpandedIds(new Set());
    if (tab === 'external') {
      loadExtPage(1);
    } else {
      loadPage(1, false, tab);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadPage(1);
    setRefreshing(false);
  };

  const onEndReached = () => {
    if (hasMore) loadPage(page + 1, true);
  };

  const handleDeleteItem = (item: ActivityEntry) => {
    Alert.alert('Delete Entry', 'Remove this from your activity log? Your bot\'s memory won\'t be affected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await botsApi.deleteActivity(botId, item.id);
            setEntries(prev => prev.filter(e => e.id !== item.id));
          } catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to delete');
          }
        },
      },
    ]);
  };

  const handleDeleteAll = () => {
    Alert.alert(
      'Clear All Activity',
      'Remove all activity entries? Your bot\'s memory and learning are unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All', style: 'destructive',
          onPress: async () => {
            try {
              await botsApi.deleteAllActivity(botId);
              setEntries([]);
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to clear activity');
            }
          },
        },
      ],
    );
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderTaskEntry = ({ item }: { item: ActivityEntry }) => {
    const mood = item.translated?.mood || 'neutral';
    const icon = ACTION_ICONS[item.action_type] || '?';
    return (
      <TouchableOpacity style={styles.entry} onLongPress={() => handleDeleteItem(item)}>
        <View style={[styles.moodBar, { backgroundColor: MOOD_COLORS[mood] }]} />
        <View style={styles.actionIcon}>
          <Text style={styles.actionIconText}>{icon}</Text>
        </View>
        <View style={styles.entryContent}>
          <Text style={styles.headline}>{item.translated?.headline || item.action_type}</Text>
          <Text style={styles.summary}>{item.translated?.summary || ''}</Text>
          {item.translated?.credibility_change != null && item.translated.credibility_change !== 0 && (
            <Text style={[styles.credChange, { color: item.translated.credibility_change > 0 ? colors.accent.success : colors.accent.error }]}>
              {item.translated.credibility_change > 0 ? '+' : ''}{item.translated.credibility_change} credibility
            </Text>
          )}
          {item.error && <Text style={styles.error}>{item.error}</Text>}
          <View style={styles.meta}>
            <Text style={styles.metaText}>Cycle {item.cycle_number}</Text>
            {item.duration_ms != null && <Text style={styles.metaText}>{(item.duration_ms / 1000).toFixed(1)}s</Text>}
            {item.llm_tokens_used != null && <Text style={styles.metaText}>{item.llm_tokens_used} tokens</Text>}
            <Text style={styles.metaText}>{formatTime(item.created_at)}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderContentEntry = ({ item }: { item: ActivityEntry }) => {
    const mood = item.translated?.mood || 'neutral';
    const isExpanded = expandedIds.has(item.id);
    const contentPreview = item.content_text
      ? item.content_text.slice(0, 120) + (item.content_text.length > 120 ? '...' : '')
      : '';

    return (
      <TouchableOpacity
        style={styles.contentEntry}
        onPress={() => toggleExpand(item.id)}
        onLongPress={() => handleDeleteItem(item)}
      >
        <View style={[styles.moodBar, { backgroundColor: MOOD_COLORS[mood] }]} />
        <View style={styles.entryContent}>
          <View style={styles.contentHeader}>
            <Text style={styles.contentType}>{item.action_type.toUpperCase()}</Text>
            <Text style={styles.metaText}>{formatTime(item.created_at)}</Text>
          </View>
          <Text style={styles.headline}>{item.translated?.headline || item.action_type}</Text>
          {item.content_text ? (
            <Text style={styles.contentText} numberOfLines={isExpanded ? undefined : 3}>
              {isExpanded ? item.content_text : contentPreview}
            </Text>
          ) : (
            <Text style={styles.noContent}>No content text available</Text>
          )}
          {item.content_text && item.content_text.length > 120 && (
            <Text style={styles.expandToggle}>{isExpanded ? 'Show less' : 'Show more'}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const handleDeleteExtItem = (item: ExternalActivityEntry) => {
    Alert.alert('Delete Entry', 'Remove this external activity entry?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await botsApi.deleteExternalActivity(botId, item.id);
            setExtEntries(prev => prev.filter(e => e.id !== item.id));
          } catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to delete');
          }
        },
      },
    ]);
  };

  const handleDeleteAllExt = () => {
    Alert.alert(
      'Clear All External Activity',
      'Remove all external activity entries?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All', style: 'destructive',
          onPress: async () => {
            try {
              await botsApi.deleteAllExternalActivity(botId);
              setExtEntries([]);
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to clear');
            }
          },
        },
      ],
    );
  };

  const renderExternalEntry = ({ item }: { item: ExternalActivityEntry }) => (
    <TouchableOpacity style={styles.entry} onLongPress={() => handleDeleteExtItem(item)}>
      <View style={[styles.moodBar, { backgroundColor: colors.accent.secondary }]} />
      <View style={styles.actionIcon}>
        <Text style={styles.actionIconText}>E</Text>
      </View>
      <View style={styles.entryContent}>
        <View style={styles.contentHeader}>
          <Text style={styles.contentType}>{item.platform.toUpperCase()}</Text>
          <Text style={styles.metaText}>{formatTime(item.created_at)}</Text>
        </View>
        <Text style={styles.headline}>{item.action}</Text>
        <Text style={styles.summary}>{item.summary}</Text>
        {item.content_preview && (
          <Text style={styles.contentText} numberOfLines={3}>{item.content_preview}</Text>
        )}
        {item.skills_demonstrated && item.skills_demonstrated.length > 0 && (
          <View style={styles.meta}>
            {item.skills_demonstrated.map((s, i) => (
              <Text key={i} style={styles.skillTag}>{s.replace(/_/g, ' ')}</Text>
            ))}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'task' && styles.tabActive]}
          onPress={() => onTabChange('task')}
        >
          <Text style={[styles.tabText, activeTab === 'task' && styles.tabTextActive]}>Tasks</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'content' && styles.tabActive]}
          onPress={() => onTabChange('content')}
        >
          <Text style={[styles.tabText, activeTab === 'content' && styles.tabTextActive]}>Content</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'external' && styles.tabActive]}
          onPress={() => onTabChange('external')}
        >
          <Text style={[styles.tabText, activeTab === 'external' && styles.tabTextActive]}>External</Text>
        </TouchableOpacity>

        {/* Live indicator + Clear all */}
        <View style={styles.tabActions}>
          {isConnected && (
            <View style={styles.liveIndicator}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>Live</Text>
            </View>
          )}
          {((activeTab !== 'external' && entries.length > 0) || (activeTab === 'external' && extEntries.length > 0)) && (
            <TouchableOpacity onPress={activeTab === 'external' ? handleDeleteAllExt : handleDeleteAll}>
              <Text style={styles.clearText}>Clear All</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {activeTab === 'external' ? (
        <FlatList
          data={extEntries}
          renderItem={renderExternalEntry}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadExtPage(1); setRefreshing(false); }} tintColor={colors.accent.primary} />}
          onEndReached={() => { if (extHasMore) loadExtPage(extPage + 1, true); }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {error || 'No external activity yet. Self-hosted bots (System 3) report their activity on other platforms here.'}
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={entries}
          renderItem={activeTab === 'task' ? renderTaskEntry : renderContentEntry}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.primary} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {error || (activeTab === 'content'
                  ? 'No content yet. Content appears when your bot writes papers, reviews, or bounties.'
                  : 'No activity yet. Start your bot to see the log!'
                )}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  tabBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bg.secondary, paddingHorizontal: spacing.md,
  },
  tab: {
    paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: colors.accent.primary },
  tabText: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.tertiary },
  tabTextActive: { color: colors.accent.primary },
  tabActions: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.md },
  liveIndicator: { flexDirection: 'row', alignItems: 'center' },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent.success, marginRight: 4 },
  liveText: { fontSize: fontSize.xs, color: colors.accent.success, fontWeight: '600' },
  clearText: { fontSize: fontSize.xs, color: colors.accent.error, fontWeight: '600' },
  list: { padding: spacing.md },
  entry: {
    flexDirection: 'row', backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, overflow: 'hidden',
  },
  moodBar: { width: 4 },
  actionIcon: {
    width: 32, justifyContent: 'center', alignItems: 'center',
  },
  actionIconText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text.tertiary },
  entryContent: { flex: 1, padding: spacing.md },
  headline: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  summary: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: 2 },
  credChange: { fontSize: fontSize.sm, fontWeight: '600', marginTop: spacing.xs },
  error: { fontSize: fontSize.sm, color: colors.accent.error, marginTop: spacing.xs },
  meta: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  metaText: { fontSize: fontSize.xs, color: colors.text.tertiary },
  contentEntry: {
    flexDirection: 'row', backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, overflow: 'hidden',
  },
  contentHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4,
  },
  contentType: {
    fontSize: fontSize.xs, fontWeight: '700', color: colors.accent.primary,
    letterSpacing: 1,
  },
  contentText: {
    fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.sm,
    lineHeight: 20,
  },
  noContent: { fontSize: fontSize.sm, color: colors.text.tertiary, fontStyle: 'italic', marginTop: spacing.xs },
  expandToggle: {
    fontSize: fontSize.xs, color: colors.accent.primary, fontWeight: '600',
    marginTop: spacing.xs,
  },
  skillTag: {
    fontSize: fontSize.xs, color: colors.accent.secondary, backgroundColor: colors.accent.secondary + '15',
    paddingHorizontal: spacing.xs, paddingVertical: 2, borderRadius: borderRadius.sm,
    overflow: 'hidden', textTransform: 'capitalize',
  },
  empty: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.md, textAlign: 'center' },
});
