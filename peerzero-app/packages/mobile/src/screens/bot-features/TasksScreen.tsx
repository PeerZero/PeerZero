// =============================================================================
// Tasks screen — shows task history for shipped-mode bots
//
// Displays completed, failed, and pending tasks with their results.
// Users can see what directives they gave, what A2A tasks came in,
// and whether each task succeeded or failed.
// =============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../../services/api';
import { colors } from '../../theme/colors';
import { spacing, fontSize, fontWeight, borderRadius, lineHeight, layout } from '../../theme/spacing';
import type { TasksScreenProps } from '../../navigation/types';
import { timeAgo } from '../../utils/timeAgo';

interface TaskRow {
  id: string;
  request_id: string;
  direction: string;
  sender: string;
  action_requested: string;
  payload: Record<string, unknown>;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

type FilterTab = 'all' | 'completed' | 'failed' | 'pending';

const STATUS_COLORS: Record<string, string> = {
  completed: colors.accent.success,
  failed: colors.accent.error,
  pending: colors.accent.warning,
  processing: colors.accent.primary,
  expired: colors.text.tertiary,
  rejected: colors.accent.error,
};

export default function TasksScreen({ route }: TasksScreenProps) {
  const { botId } = route.params;
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  const loadTasks = useCallback(async () => {
    try {
      const result = await botsApi.tasks(botId, { limit: 50 }) as { data: TaskRow[]; total: number };
      setTasks(result.data);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadTasks(); }, [loadTasks]));

  const onRefresh = () => {
    setRefreshing(true);
    loadTasks();
  };

  const filteredTasks = tasks.filter(t => {
    if (activeTab === 'completed') return t.status === 'completed';
    if (activeTab === 'failed') return ['failed', 'rejected', 'expired'].includes(t.status);
    if (activeTab === 'pending') return ['pending', 'processing'].includes(t.status);
    return true;
  });

  const toggleExpand = (id: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCancel = async (requestId: string) => {
    try {
      await botsApi.cancelTask(botId, requestId);
      loadTasks(); // Refresh
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to cancel task');
    }
  };

  const renderTask = ({ item }: { item: TaskRow }) => {
    const expanded = expandedTasks.has(item.id);
    const statusColor = STATUS_COLORS[item.status] || colors.text.tertiary;
    const isOwnerDirective = item.sender === 'owner';
    const message = typeof item.payload?.message === 'string' ? item.payload.message : item.action_requested;
    const canCancel = ['pending', 'processing'].includes(item.status);

    return (
      <TouchableOpacity
        style={styles.taskCard}
        onPress={() => toggleExpand(item.id)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Task from ${isOwnerDirective ? 'you' : item.sender}: ${message?.slice(0, 80) || item.action_requested}. Status: ${item.status}`}
        accessibilityState={{ expanded }}
      >
        {/* Status indicator */}
        <View style={[styles.statusBar, { backgroundColor: statusColor }]} />

        <View style={styles.taskContent}>
          {/* Header */}
          <View style={styles.taskHeader}>
            <Text style={styles.taskSender}>
              {isOwnerDirective ? 'You' : item.sender}
            </Text>
            <View style={[styles.statusBadge, { borderColor: statusColor + '50', backgroundColor: statusColor + '15' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>{item.status}</Text>
            </View>
          </View>

          {/* Task description */}
          <Text style={styles.taskMessage} numberOfLines={expanded ? undefined : 2}>
            {message}
          </Text>

          {/* Timestamp */}
          <Text style={styles.taskTime}>
            {timeAgo(item.created_at)}
            {item.completed_at ? ` \u2022 Completed ${timeAgo(item.completed_at)}` : ''}
          </Text>

          {/* Expanded: show result or error */}
          {expanded && item.result && (
            <View style={styles.resultWrap}>
              <Text style={styles.resultLabel}>Result</Text>
              <Text style={styles.resultText}>
                {typeof item.result.response === 'string'
                  ? item.result.response.slice(0, 500)
                  : JSON.stringify(item.result).slice(0, 500)}
              </Text>
            </View>
          )}

          {expanded && item.error && (
            <View style={styles.errorWrap}>
              <Text style={styles.errorLabel}>Error</Text>
              <Text style={styles.errorText}>{item.error}</Text>
            </View>
          )}

          {/* Cancel button for active tasks */}
          {expanded && canCancel && (
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => handleCancel(item.request_id)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Cancel task"
            >
              <Text style={styles.cancelText}>Cancel Task</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Filter tabs */}
      <View style={styles.tabBar} accessibilityRole="tablist">
        {([
          { key: 'all' as FilterTab, label: 'All' },
          { key: 'completed' as FilterTab, label: 'Done' },
          { key: 'failed' as FilterTab, label: 'Failed' },
          { key: 'pending' as FilterTab, label: 'Active' },
        ]).map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityLabel={`${tab.label} tasks`}
            accessibilityState={{ selected: activeTab === tab.key }}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filteredTasks}
        keyExtractor={item => item.id}
        renderItem={renderTask}
        contentContainerStyle={[styles.list, filteredTasks.length === 0 && styles.emptyList]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.tertiary} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No tasks yet</Text>
            <Text style={styles.emptySubtitle}>
              Tasks from directives and other agents will appear here.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  centered: { justifyContent: 'center', alignItems: 'center' },

  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.bg.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 3,
    borderRadius: borderRadius.full,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: {
    backgroundColor: colors.accent.primary + '18',
    borderColor: colors.accent.primary + '50',
  },
  tabText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.tertiary,
  },
  tabTextActive: { color: colors.accent.primary },

  list: { paddingHorizontal: layout.screenPadding, paddingTop: spacing.md },
  emptyList: { flex: 1, justifyContent: 'center' },

  taskCard: {
    flexDirection: 'row',
    marginBottom: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  statusBar: { width: 4 },
  taskContent: { flex: 1, padding: spacing.md },

  taskHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  taskSender: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  statusText: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    textTransform: 'uppercase',
  },

  taskMessage: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: fontSize.md * lineHeight.relaxed,
  },
  taskTime: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    marginTop: spacing.xs,
    fontWeight: fontWeight.medium,
  },

  resultWrap: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border + '40',
  },
  resultLabel: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    color: colors.accent.success,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xxs,
  },
  resultText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: fontSize.sm * lineHeight.relaxed,
  },

  errorWrap: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.accent.error + '20',
  },
  errorLabel: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    color: colors.accent.error,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xxs,
  },
  errorText: {
    fontSize: fontSize.sm,
    color: colors.accent.error,
    lineHeight: fontSize.sm * lineHeight.relaxed,
  },

  cancelButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.accent.error + '40',
    backgroundColor: colors.accent.error + '10',
    alignSelf: 'flex-start',
  },
  cancelText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.accent.error,
  },

  emptyState: { alignItems: 'center', padding: spacing.xl },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    maxWidth: 300,
  },
});
