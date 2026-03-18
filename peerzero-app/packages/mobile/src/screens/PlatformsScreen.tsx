// =============================================================================
// Platforms screen — shows connected platforms for a bot + connect new ones
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { platforms as platformsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { BotPlatformConnection } from '@peerzero/shared';
import type { PlatformsScreenProps } from '../navigation/types';

const STATUS_COLORS: Record<string, string> = {
  active: colors.accent.success,
  paused: colors.accent.warning,
  error: colors.accent.error,
  disconnected: colors.text.tertiary,
};

export default function PlatformsScreen({ route, navigation }: PlatformsScreenProps) {
  const { botId } = route.params;
  const [connections, setConnections] = useState<BotPlatformConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await platformsApi.list(botId) as BotPlatformConnection[];
      setConnections(data);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleDisconnect = async (platformId: string, name: string) => {
    Alert.alert('Disconnect', `Remove ${name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          try {
            await platformsApi.disconnect(botId, platformId);
            setConnections(prev => prev.filter(c => c.id !== platformId));
          } catch (err: any) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: BotPlatformConnection }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.platformName}>{item.platform_name}</Text>
        <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[item.status] || colors.text.tertiary }]} />
      </View>
      <Text style={styles.statusText}>{item.status.toUpperCase()}</Text>
      {item.error_message && (
        <Text style={styles.errorText} numberOfLines={2}>{item.error_message}</Text>
      )}
      <View style={styles.statsRow}>
        <Text style={styles.statText}>Cycles: {item.cycle_count}</Text>
        <Text style={styles.statText}>Every {item.heartbeat_interval_seconds}s</Text>
      </View>
      <TouchableOpacity
        style={styles.disconnectButton}
        onPress={() => handleDisconnect(item.id, item.platform_name)}
        accessibilityRole="button"
        accessibilityLabel={`Disconnect ${item.platform_name}`}
      >
        <Text style={styles.disconnectText}>Disconnect</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={connections}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No Platforms Connected</Text>
            <Text style={styles.emptyText}>Connect your bot to external platforms to share its reasoning beyond school.</Text>
          </View>
        }
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('ConnectPlatform', { botId })}
        accessibilityRole="button"
        accessibilityLabel="Connect Platform"
      >
        <Text style={styles.fabText}>+ Connect Platform</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  list: { padding: spacing.md, paddingBottom: 80 },
  card: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  platformName: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: fontSize.xs, color: colors.text.secondary, marginTop: 2 },
  errorText: { fontSize: fontSize.sm, color: colors.accent.error, marginTop: spacing.xs },
  statsRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
  statText: { fontSize: fontSize.sm, color: colors.text.tertiary },
  disconnectButton: {
    alignSelf: 'flex-end', marginTop: spacing.sm,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
    borderRadius: borderRadius.sm, borderWidth: 1, borderColor: colors.accent.error + '60',
  },
  disconnectText: { color: colors.accent.error, fontSize: fontSize.sm, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  emptyText: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs, textAlign: 'center' },
  fab: {
    position: 'absolute', bottom: spacing.lg, left: spacing.lg, right: spacing.lg,
    backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
  },
  fabText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
});
