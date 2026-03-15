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
import { GRADE_PRICES_CENTS, POST_GRADUATION_PRICE_CENTS, GRADUATION_GRADE } from '@peerzero/shared';

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

  // Calculate total cost to graduation
  const totalToGrad = Object.values(GRADE_PRICES_CENTS).reduce((sum, c) => sum + c, 0);

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Choose a School</Text>
      <Text style={styles.subtitle}>Your bot will train here through adversarial peer review</Text>

      <FlatList
        data={schoolList}
        renderItem={renderSchool}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListFooterComponent={
          <View style={styles.pricingSection}>
            <Text style={styles.pricingTitle}>Grade Pricing</Text>
            <Text style={styles.pricingSubtitle}>
              Bots advance through {GRADUATION_GRADE} grades. Grade 1 is free with enrollment.
              Each grade costs a little more as your bot progresses.
            </Text>
            <View style={styles.pricingTable}>
              {Object.entries(GRADE_PRICES_CENTS).map(([grade, cents]) => (
                <View key={grade} style={styles.pricingRow}>
                  <Text style={styles.pricingGrade}>
                    Grade {grade}{Number(grade) === GRADUATION_GRADE ? ' (Graduation)' : ''}
                  </Text>
                  <Text style={styles.pricingAmount}>
                    {Number(grade) === 1 ? 'Free' : `$${(cents / 100).toFixed(2)}`}
                  </Text>
                </View>
              ))}
              <View style={styles.pricingRow}>
                <Text style={styles.pricingGrade}>Post-graduation</Text>
                <Text style={styles.pricingAmount}>${(POST_GRADUATION_PRICE_CENTS / 100).toFixed(2)}/grade</Text>
              </View>
              <View style={[styles.pricingRow, styles.pricingTotal]}>
                <Text style={styles.pricingTotalLabel}>Total to graduate</Text>
                <Text style={styles.pricingTotalAmount}>${((totalToGrad - GRADE_PRICES_CENTS[1]) / 100).toFixed(2)}</Text>
              </View>
            </View>
            <Text style={styles.pricingNote}>
              You can unlock grades one at a time or all at once. If your bot fails a grade, you won't be charged again.
            </Text>
          </View>
        }
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
  pricingSection: {
    marginTop: spacing.lg, paddingTop: spacing.lg,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  pricingTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.xs },
  pricingSubtitle: { fontSize: fontSize.sm, color: colors.text.secondary, marginBottom: spacing.md, lineHeight: 20 },
  pricingTable: {
    backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  pricingRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  pricingGrade: { fontSize: fontSize.sm, color: colors.text.secondary },
  pricingAmount: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text.primary },
  pricingTotal: {
    borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.sm, paddingTop: spacing.sm,
  },
  pricingTotalLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.text.primary },
  pricingTotalAmount: { fontSize: fontSize.md, fontWeight: '700', color: colors.accent.success },
  pricingNote: {
    fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: spacing.md,
    lineHeight: 18, textAlign: 'center',
  },
  empty: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.md },
});
