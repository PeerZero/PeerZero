// =============================================================================
// Schools screen — browse available schools with prices
// Eventually hundreds of schools at different price points.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { schools as schoolsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { SchoolInfo } from '@peerzero/shared';

export default function SchoolScreen() {
  const [schoolList, setSchoolList] = useState<SchoolInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSchools = useCallback(async () => {
    try {
      setError(null);
      const data = await schoolsApi.list() as SchoolInfo[];
      setSchoolList(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load schools');
    }
  }, []);

  useFocusEffect(useCallback(() => { loadSchools(); }, [loadSchools]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadSchools();
    setRefreshing(false);
  };

  const formatPrice = (cents: number) => {
    if (cents === 0) return 'Free';
    return `$${(cents / 100).toFixed(2)}`;
  };

  const renderSchool = ({ item }: { item: SchoolInfo }) => (
    <View style={styles.schoolCard}>
      <View style={styles.schoolHeader}>
        <Text style={styles.schoolName}>{item.name}</Text>
        <Text style={styles.schoolPrice}>{formatPrice(item.price_cents)}</Text>
      </View>
      {item.description && (
        <Text style={styles.schoolDescription}>{item.description}</Text>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={schoolList}
        renderItem={renderSchool}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.primary} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{error || 'No schools available yet.'}</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  list: { padding: spacing.md },
  schoolCard: {
    backgroundColor: colors.bg.card, borderRadius: borderRadius.lg, padding: spacing.lg,
    marginBottom: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  schoolHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  schoolName: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  schoolPrice: { fontSize: fontSize.lg, fontWeight: '700', color: colors.accent.success },
  schoolDescription: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.sm },
  empty: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.md },
});
