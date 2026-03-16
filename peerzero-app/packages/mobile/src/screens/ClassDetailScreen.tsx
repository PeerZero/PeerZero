// =============================================================================
// Class detail screen — view members, dashboard stats, manage class
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Modal, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { classes as classesApi, bots as botsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { ClassInfo, ClassMember, ClassDashboard, BotSummary } from '@peerzero/shared';

type Tab = 'members' | 'dashboard';

export default function ClassDetailScreen({ route, navigation }: any) {
  const { classId } = route.params;
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [dashboard, setDashboard] = useState<ClassDashboard | null>(null);
  const [tab, setTab] = useState<Tab>('members');
  const [loading, setLoading] = useState(true);
  const [showBotPicker, setShowBotPicker] = useState(false);
  const [userBots, setUserBots] = useState<BotSummary[]>([]);
  const [loadingBots, setLoadingBots] = useState(false);

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

  const openBotPicker = async () => {
    setShowBotPicker(true);
    setLoadingBots(true);
    try {
      const list = await botsApi.list() as BotSummary[];
      setUserBots(list);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoadingBots(false);
    }
  };

  const selectBot = async (botId: string | null) => {
    try {
      await classesApi.updateBot(classId, botId);
      setShowBotPicker(false);
      load(); // refresh members
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  if (loading || !classInfo) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  const isTeacher = classInfo.role === 'teacher';
  const isStudent = classInfo.role === 'student';

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

      {/* Bot Selector (students only) */}
      {isStudent && (
        <View style={styles.botPickerBar}>
          <TouchableOpacity style={styles.changeBotButton} onPress={openBotPicker}>
            <Text style={styles.changeBotText}>Change My Bot</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bot Picker Modal */}
      <Modal visible={showBotPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select Bot for Class</Text>
            {loadingBots ? (
              <ActivityIndicator size="large" color={colors.accent.primary} style={{ marginVertical: spacing.xl }} />
            ) : (
              <ScrollView style={styles.botList}>
                {/* Option to remove bot */}
                <TouchableOpacity style={styles.botOption} onPress={() => selectBot(null)}>
                  <Text style={styles.botOptionName}>None</Text>
                  <Text style={styles.botOptionDetail}>Remove bot from class</Text>
                </TouchableOpacity>
                {userBots.map(bot => (
                  <TouchableOpacity key={bot.id} style={styles.botOption} onPress={() => selectBot(bot.id)}>
                    <Text style={styles.botOptionName}>{bot.name}</Text>
                    <Text style={styles.botOptionDetail}>
                      {bot.status} | Cred: {bot.cached_credibility ?? '—'} | Grade: {bot.cached_grade ?? '—'}
                    </Text>
                  </TouchableOpacity>
                ))}
                {userBots.length === 0 && (
                  <Text style={styles.noBotText}>No bots available. Create a bot first.</Text>
                )}
              </ScrollView>
            )}
            <TouchableOpacity style={styles.modalCancel} onPress={() => setShowBotPicker(false)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Actions */}
      <View style={styles.actions}>
        {isTeacher ? (
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
  botPickerBar: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  changeBotButton: {
    padding: spacing.md, borderRadius: borderRadius.md, alignItems: 'center',
    backgroundColor: colors.accent.primary + '15', borderWidth: 1, borderColor: colors.accent.primary + '40',
  },
  changeBotText: { color: colors.accent.primary, fontSize: fontSize.md, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: colors.bg.primary, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: spacing.lg, maxHeight: '70%',
  },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.md },
  botList: { maxHeight: 300 },
  botOption: {
    padding: spacing.md, borderRadius: borderRadius.md, marginBottom: spacing.sm,
    backgroundColor: colors.bg.card, borderWidth: 1, borderColor: colors.border,
  },
  botOptionName: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  botOptionDetail: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  modalCancel: { padding: spacing.md, alignItems: 'center', marginTop: spacing.sm },
  modalCancelText: { fontSize: fontSize.md, color: colors.text.secondary, fontWeight: '600' },
});
