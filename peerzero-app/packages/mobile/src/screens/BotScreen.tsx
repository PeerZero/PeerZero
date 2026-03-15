// =============================================================================
// Bot screen — the Tamagotchi view for a single bot
// Shows avatar, status, key stats, and action buttons (start/stop, brain, log)
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { BotDetail } from '@peerzero/shared';

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

  const loadBot = useCallback(async () => {
    try {
      const data = await botsApi.get(botId) as BotDetail;
      setBot(data);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadBot(); }, [loadBot]));

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

  if (!bot) return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <ActivityIndicator size="large" color={colors.accent.primary} />
      <Text style={{ color: colors.text.secondary, marginTop: 12 }}>Loading bot...</Text>
    </View>
  );

  const isRunning = bot.status === 'running';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: bot.avatar_config?.body_color || colors.accent.primary }]}>
        <Text style={styles.avatarText}>{bot.name.charAt(0).toUpperCase()}</Text>
      </View>

      <Text style={styles.botName}>{bot.name}</Text>
      <Text style={styles.schoolName}>{bot.school_name || 'Not enrolled'}</Text>

      {/* Status badge */}
      <View style={[styles.statusBadge, { backgroundColor: isRunning ? colors.accent.success + '20' : colors.bg.elevated }]}>
        <Text style={[styles.statusText, { color: isRunning ? colors.accent.success : colors.text.secondary }]}>
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

      {/* Error message */}
      {bot.error_message && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{bot.error_message}</Text>
        </View>
      )}

      {/* Next action hint */}
      {bot.cached_next_action && (
        <Text style={styles.nextAction}>{bot.cached_next_action}</Text>
      )}

      {/* Action buttons */}
      <TouchableOpacity
        style={[styles.actionButton, isRunning ? styles.stopButton : styles.startButton]}
        onPress={handleStartStop}
      >
        <Text style={styles.actionButtonText}>{isRunning ? 'Stop' : 'Start'}</Text>
      </TouchableOpacity>

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
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  content: { alignItems: 'center', padding: spacing.xl },
  avatar: {
    width: 100, height: 100, borderRadius: 50, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md,
  },
  avatarText: { fontSize: 42, fontWeight: '700', color: '#fff' },
  botName: { fontSize: fontSize.xxl, fontWeight: '700', color: colors.text.primary },
  schoolName: { fontSize: fontSize.md, color: colors.text.secondary, marginTop: spacing.xs },
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
  errorText: { color: colors.accent.error, fontSize: fontSize.sm },
  nextAction: { color: colors.text.secondary, fontSize: fontSize.sm, marginTop: spacing.md, textAlign: 'center' },
  actionButton: {
    width: '100%', padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', marginTop: spacing.xl,
  },
  startButton: { backgroundColor: colors.accent.success },
  stopButton: { backgroundColor: colors.accent.error },
  actionButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  navRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg, width: '100%' },
  navButton: {
    flex: 1, backgroundColor: colors.bg.card, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  navButtonText: { fontSize: fontSize.md, fontWeight: '600', color: colors.accent.primary },
  navButtonSub: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
});
