// =============================================================================
// Class detail screen — view members, dashboard stats, manage class
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { classes as classesApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { ClassInfo, ClassMember, ClassDashboard } from '@peerzero/shared';

type Tab = 'members' | 'dashboard';

export default function ClassDetailScreen({ route, navigation }: any) {
  const { classId } = route.params;
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [dashboard, setDashboard] = useState<ClassDashboard | null>(null);
  const [tab, setTab] = useState<Tab>('members');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [info, memberList] = await Promise.all([
        classesApi.get(classId) as Promise<ClassInfo>,
        classesApi.members(classId) as Promise<ClassMember[]>,
      ]);
      setClassInfo(info);
      setMembers(memberList);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  const loadDashboard = useCallback(async () => {
    try {
      const data = await classesApi.dashboard(classId) as ClassDashboard;
      setDashboard(data);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, [classId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleTabChange = (newTab: Tab) => {
    setTab(newTab);
    if (newTab === 'dashboard' && !dashboard) {
      loadDashboard();
    }
  };

  const handleLeave = () => {
    Alert.alert('Leave Class', 'Are you sure you want to leave this class?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          try {
            await classesApi.leave(classId);
            navigation.goBack();
          } catch (err: any) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  const handleDelete = () => {
    Alert.alert('Delete Class', 'This will remove the class for all members. Continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await classesApi.delete(classId);
            navigation.goBack();
          } catch (err: any) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  if (loading || !classInfo) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  const isOwner = classInfo.role === 'owner';

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>{classInfo.name}</Text>
        {classInfo.description && (
          <Text style={styles.description}>{classInfo.description}</Text>
        )}
        <View style={styles.codeRow}>
          <Text style={styles.codeLabel}>Join code:</Text>
          <Text style={styles.codeValue} selectable>{classInfo.join_code}</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, tab === 'members' && styles.activeTab]}
          onPress={() => handleTabChange('members')}
        >
          <Text style={[styles.tabText, tab === 'members' && styles.activeTabText]}>
            Members ({classInfo.member_count})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'dashboard' && styles.activeTab]}
          onPress={() => handleTabChange('dashboard')}
        >
          <Text style={[styles.tabText, tab === 'dashboard' && styles.activeTabText]}>Dashboard</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {tab === 'members' ? (
        <FlatList
          data={members}
          keyExtractor={item => item.user_id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.memberCard}>
              <View style={styles.memberHeader}>
                <Text style={styles.memberName}>{item.display_name || 'Anonymous'}</Text>
                <Text style={styles.memberRole}>{item.role}</Text>
              </View>
              {item.bot ? (
                <View style={styles.botInfo}>
                  <Text style={styles.botName}>{item.bot.name}</Text>
                  <Text style={styles.botStat}>
                    Credibility: {item.bot.cached_credibility ?? '—'} | Grade: {item.bot.cached_grade ?? '—'}
                  </Text>
                </View>
              ) : (
                <Text style={styles.noBotText}>No bot assigned</Text>
              )}
            </View>
          )}
        />
      ) : (
        <DashboardView dashboard={dashboard} />
      )}

      {/* Actions */}
      <View style={styles.actions}>
        {isOwner ? (
          <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
            <Text style={styles.deleteText}>Delete Class</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.leaveButton} onPress={handleLeave}>
            <Text style={styles.leaveText}>Leave Class</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function DashboardView({ dashboard }: { dashboard: ClassDashboard | null }) {
  if (!dashboard) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <View style={styles.dashContent}>
      {/* Aggregate stats */}
      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{dashboard.member_count}</Text>
          <Text style={styles.statLabel}>Members</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{dashboard.active_bots}</Text>
          <Text style={styles.statLabel}>Active Bots</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{dashboard.avg_credibility != null ? Math.round(dashboard.avg_credibility) : '—'}</Text>
          <Text style={styles.statLabel}>Avg Cred</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{dashboard.total_cycles}</Text>
          <Text style={styles.statLabel}>Total Cycles</Text>
        </View>
      </View>

      {/* Grade distribution */}
      {Object.keys(dashboard.grade_distribution).length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Grade Distribution</Text>
          <View style={styles.gradeDistRow}>
            {Object.entries(dashboard.grade_distribution).map(([grade, count]) => (
              <View key={grade} style={styles.gradeDistItem}>
                <Text style={styles.gradeDistCount}>{count}</Text>
                <Text style={styles.gradeDistLabel}>G{grade}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Top performers */}
      {dashboard.top_performers.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top Performers</Text>
          {dashboard.top_performers.map((p, i) => (
            <View key={i} style={styles.performerRow}>
              <Text style={styles.performerRank}>#{i + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.performerName}>{p.bot_name}</Text>
                <Text style={styles.performerOwner}>{p.display_name}</Text>
              </View>
              <Text style={styles.performerCred}>{p.credibility}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Recent milestones */}
      {dashboard.recent_milestones.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Milestones</Text>
          {dashboard.recent_milestones.map((m, i) => (
            <View key={i} style={styles.milestoneRow}>
              <Text style={styles.milestoneName}>{m.bot_name}</Text>
              <Text style={styles.milestoneEvent}>{m.event}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text.primary },
  description: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs },
  codeRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.xs },
  codeLabel: { fontSize: fontSize.sm, color: colors.text.tertiary },
  codeValue: { fontSize: fontSize.md, fontWeight: '600', color: colors.accent.primary, fontFamily: 'monospace' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, paddingVertical: spacing.md, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: colors.accent.primary },
  tabText: { fontSize: fontSize.md, color: colors.text.secondary },
  activeTabText: { color: colors.accent.primary, fontWeight: '600' },
  list: { padding: spacing.md },
  memberCard: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  memberHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  memberName: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  memberRole: { fontSize: fontSize.xs, color: colors.accent.secondary, textTransform: 'uppercase', fontWeight: '600' },
  botInfo: { marginTop: spacing.xs },
  botName: { fontSize: fontSize.sm, color: colors.text.primary },
  botStat: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  noBotText: { fontSize: fontSize.sm, color: colors.text.tertiary, marginTop: spacing.xs, fontStyle: 'italic' },
  dashContent: { padding: spacing.md },
  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  statBox: {
    flex: 1, backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  statValue: { fontSize: fontSize.xl, fontWeight: '700', color: colors.accent.secondary },
  statLabel: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  section: { marginBottom: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary, marginBottom: spacing.sm },
  gradeDistRow: { flexDirection: 'row', gap: spacing.sm },
  gradeDistItem: { alignItems: 'center', backgroundColor: colors.bg.card, padding: spacing.sm, borderRadius: borderRadius.sm, minWidth: 40 },
  gradeDistCount: { fontSize: fontSize.lg, fontWeight: '600', color: colors.accent.primary },
  gradeDistLabel: { fontSize: fontSize.xs, color: colors.text.tertiary },
  performerRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.bg.card, padding: spacing.sm, borderRadius: borderRadius.sm,
    marginBottom: spacing.xs,
  },
  performerRank: { fontSize: fontSize.md, fontWeight: '700', color: colors.accent.warning, width: 28 },
  performerName: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  performerOwner: { fontSize: fontSize.xs, color: colors.text.tertiary },
  performerCred: { fontSize: fontSize.lg, fontWeight: '700', color: colors.accent.secondary },
  milestoneRow: {
    flexDirection: 'row', gap: spacing.sm, padding: spacing.sm,
    backgroundColor: colors.bg.card, borderRadius: borderRadius.sm, marginBottom: spacing.xs,
  },
  milestoneName: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text.primary },
  milestoneEvent: { fontSize: fontSize.sm, color: colors.accent.warning, flex: 1 },
  actions: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  leaveButton: {
    padding: spacing.md, borderRadius: borderRadius.md, alignItems: 'center',
    borderWidth: 1, borderColor: colors.accent.error + '60',
  },
  leaveText: { color: colors.accent.error, fontSize: fontSize.md, fontWeight: '600' },
  deleteButton: {
    padding: spacing.md, borderRadius: borderRadius.md, alignItems: 'center',
    backgroundColor: colors.accent.error + '15',
  },
  deleteText: { color: colors.accent.error, fontSize: fontSize.md, fontWeight: '600' },
});
