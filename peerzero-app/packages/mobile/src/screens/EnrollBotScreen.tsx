// =============================================================================
// Enroll Bot screen — pick a school and enroll the bot
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi, schools as schoolsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { SchoolInfo } from '@peerzero/shared';

export default function EnrollBotScreen({ route, navigation }: any) {
  const { botId } = route.params;
  const [schoolList, setSchoolList] = useState<SchoolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSchools = useCallback(async () => {
    try {
      setError(null);
      const data = await schoolsApi.list() as SchoolInfo[];
      setSchoolList(data.filter(s => s.is_active));
    } catch (err: any) {
      setError(err?.message || 'Failed to load schools');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadSchools(); }, [loadSchools]));

  const handleEnroll = (school: SchoolInfo) => {
    const price = school.price_cents === 0 ? 'Free' : `$${(school.price_cents / 100).toFixed(2)}`;
    Alert.alert(
      'Enroll in School',
      `Enroll your bot in ${school.name}?\n\nPrice: ${price}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Enroll',
          onPress: async () => {
            setEnrolling(school.id);
            try {
              const result = await botsApi.enroll(botId, school.id) as { handle: string };
              Alert.alert(
                'Enrolled!',
                `Your bot is registered as "${result.handle}". It will go through intake when you start it.`,
                [{ text: 'OK', onPress: () => navigation.goBack() }],
              );
            } catch (err: any) {
              Alert.alert('Enrollment Failed', err?.message || 'Could not enroll in this school');
            } finally {
              setEnrolling(null);
            }
          },
        },
      ],
    );
  };

  const formatPrice = (cents: number) => cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}`;

  const renderSchool = ({ item }: { item: SchoolInfo }) => (
    <TouchableOpacity
      style={styles.schoolCard}
      onPress={() => handleEnroll(item)}
      disabled={enrolling !== null}
    >
      <View style={styles.schoolHeader}>
        <Text style={styles.schoolName}>{item.name}</Text>
        <Text style={styles.schoolPrice}>{formatPrice(item.price_cents)}</Text>
      </View>
      {item.description && (
        <Text style={styles.schoolDescription}>{item.description}</Text>
      )}
      {enrolling === item.id && (
        <ActivityIndicator style={{ marginTop: spacing.sm }} color={colors.accent.primary} />
      )}
    </TouchableOpacity>
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
      <Text style={styles.header}>Choose a School</Text>
      <Text style={styles.subtitle}>Your bot will train here through adversarial peer review</Text>

      <FlatList
        data={schoolList}
        renderItem={renderSchool}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
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
  header: {
    fontSize: fontSize.xl, fontWeight: '700', color: colors.text.primary,
    paddingHorizontal: spacing.lg, paddingTop: spacing.lg,
  },
  subtitle: {
    fontSize: fontSize.sm, color: colors.text.secondary,
    paddingHorizontal: spacing.lg, marginTop: spacing.xs, marginBottom: spacing.md,
  },
  list: { padding: spacing.md },
  schoolCard: {
    backgroundColor: colors.bg.card, borderRadius: borderRadius.lg, padding: spacing.lg,
    marginBottom: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  schoolHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  schoolName: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary, flex: 1 },
  schoolPrice: { fontSize: fontSize.lg, fontWeight: '700', color: colors.accent.success },
  schoolDescription: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.sm },
  empty: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.md },
});
