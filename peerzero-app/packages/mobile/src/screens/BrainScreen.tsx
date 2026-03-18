// =============================================================================
// Brain screen — visualizes the 4-tier memory system
// Tier 0 (Active Focus), Tier 1 (Exercises), Tier 2 (Paragraphs), Tier 3 (Core)
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi, skills as skillsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { MEMORY_TIER_LABELS } from '@peerzero/shared';
import type { MemorySnapshot, SkillSnapshot } from '@peerzero/shared';
import type { BrainScreenProps } from '../navigation/types';

type TierKey = 0 | 1 | 2 | 3;

const TIER_COLORS: Record<TierKey, string> = {
  0: colors.accent.warning,   // Active Focus — gold
  1: colors.text.secondary,   // Raw exercises — muted
  2: colors.accent.secondary, // Paragraphs — cyan
  3: colors.accent.primary,   // Core — purple
};

export default function BrainScreen({ route }: BrainScreenProps) {
  const { botId } = route.params;
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  const [skills, setSkills] = useState<SkillSnapshot[]>([]);
  const [expandedTier, setExpandedTier] = useState<TierKey | null>(0);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          setError(null);
          const [data, skillData] = await Promise.all([
            botsApi.memory(botId) as Promise<MemorySnapshot>,
            skillsApi.get(botId) as Promise<SkillSnapshot[]>,
          ]);
          setMemory(data);
          setSkills(skillData);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Failed to load memory');
        }
      })();
    }, [botId]),
  );

  if (error) return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <Text style={{ color: colors.text.secondary, fontSize: fontSize.md }}>{error}</Text>
    </View>
  );

  if (!memory) return <View style={styles.container} />;

  const toggleTier = (tier: TierKey) => {
    setExpandedTier(expandedTier === tier ? null : tier);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Skill Progress */}
      {skills.length > 0 && (
        <View style={styles.skillSection}>
          <Text style={styles.skillSectionTitle}>Skill Progress</Text>
          {skills.filter(s => s.reps > 0).map((skill) => (
            <View key={skill.skill_key} style={styles.skillRow}>
              <View style={styles.skillHeader}>
                <Text style={styles.skillName}>{skill.skill_key.replace(/_/g, ' ')}</Text>
                <Text style={styles.skillValue}>{skill.strength}%</Text>
              </View>
              <View style={styles.skillBarBg}>
                <View style={[styles.skillBarFill, { width: `${Math.min(skill.strength, 100)}%` }]} />
              </View>
              <View style={styles.skillMeta}>
                <Text style={styles.skillMetaText}>{skill.reps} reps</Text>
                <Text style={[styles.skillStatus, {
                  color: skill.status === 'verified' ? colors.accent.success
                    : skill.status === 'developing' ? colors.accent.warning
                    : colors.text.tertiary,
                }]}>{skill.status}</Text>
              </View>
            </View>
          ))}
          {skills.every(s => s.reps === 0) && (
            <Text style={styles.skillEmptyText}>No skills measured yet. Start running cycles to build skills.</Text>
          )}
        </View>
      )}

      {/* Tier 0: Active Focus */}
      <TouchableOpacity style={styles.tierHeader} onPress={() => toggleTier(0)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${MEMORY_TIER_LABELS[0]}, ${memory.tier0_focus.length} chunks`} accessibilityState={{ expanded: expandedTier === 0 }}>
        <View style={[styles.tierDot, { backgroundColor: TIER_COLORS[0] }]} />
        <Text style={styles.tierTitle}>{MEMORY_TIER_LABELS[0]}</Text>
        <Text style={styles.tierCount}>{memory.tier0_focus.length} chunks</Text>
        <Text style={styles.tierChevron}>{expandedTier === 0 ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expandedTier === 0 && memory.tier0_focus.map((chunk, i) => (
        <View key={i} style={[styles.card, { borderLeftColor: TIER_COLORS[0] }]}>
          <Text style={styles.cardLabel}>{chunk.label}</Text>
          <Text style={styles.cardContent}>{chunk.content}</Text>
          <Text style={styles.cardSource}>{chunk.source}</Text>
        </View>
      ))}

      {/* Tier 1: Raw Exercises */}
      <TouchableOpacity style={styles.tierHeader} onPress={() => toggleTier(1)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${MEMORY_TIER_LABELS[1]}, ${memory.tier1_exercises.length} items`} accessibilityState={{ expanded: expandedTier === 1 }}>
        <View style={[styles.tierDot, { backgroundColor: TIER_COLORS[1] }]} />
        <Text style={styles.tierTitle}>{MEMORY_TIER_LABELS[1]}</Text>
        <Text style={styles.tierCount}>{memory.tier1_exercises.length}</Text>
        <Text style={styles.tierChevron}>{expandedTier === 1 ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expandedTier === 1 && (
        <>
          {memory.tier1_exercises.slice(0, 10).map((ex) => (
            <View key={ex.id} style={[styles.card, { borderLeftColor: TIER_COLORS[1] }]}>
              <Text style={styles.cardLabel}>Cycle {ex.cycle_number} — {ex.action_type}</Text>
              <Text style={styles.cardContent} numberOfLines={3}>
                {JSON.stringify(ex.exercise_data).slice(0, 200)}
              </Text>
            </View>
          ))}
          {memory.tier1_exercises.length > 10 && (
            <Text style={{ color: colors.text.tertiary, textAlign: 'center', marginTop: 8 }}>
              Showing 10 of {memory.tier1_exercises.length} exercises
            </Text>
          )}
        </>
      )}

      {/* Tier 2: Skill Paragraphs */}
      <TouchableOpacity style={styles.tierHeader} onPress={() => toggleTier(2)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${MEMORY_TIER_LABELS[2]}, ${memory.tier2_paragraphs.length} items`} accessibilityState={{ expanded: expandedTier === 2 }}>
        <View style={[styles.tierDot, { backgroundColor: TIER_COLORS[2] }]} />
        <Text style={styles.tierTitle}>{MEMORY_TIER_LABELS[2]}</Text>
        <Text style={styles.tierCount}>{memory.tier2_paragraphs.length}</Text>
        <Text style={styles.tierChevron}>{expandedTier === 2 ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expandedTier === 2 && memory.tier2_paragraphs.map((p) => (
        <View key={p.id} style={[styles.card, { borderLeftColor: TIER_COLORS[2] }]}>
          <Text style={styles.cardLabel}>{p.interaction_type}</Text>
          <Text style={styles.cardContent}>{p.paragraph}</Text>
        </View>
      ))}

      {/* Tier 3: Core Identity */}
      <TouchableOpacity style={styles.tierHeader} onPress={() => toggleTier(3)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${MEMORY_TIER_LABELS[3]}, ${memory.tier3_core ? `Identity version ${memory.tier3_core.version}` : 'No core identity yet'}`} accessibilityState={{ expanded: expandedTier === 3 }}>
        <View style={[styles.tierDot, { backgroundColor: TIER_COLORS[3] }]} />
        <Text style={styles.tierTitle}>{MEMORY_TIER_LABELS[3]}</Text>
        <Text style={styles.tierCount}>{memory.tier3_core ? `Identity v${memory.tier3_core.version}` : 'No core identity yet'}</Text>
        <Text style={styles.tierChevron}>{expandedTier === 3 ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expandedTier === 3 && (
        <>
          {memory.tier3_core && (
            <View style={[styles.card, { borderLeftColor: TIER_COLORS[3] }]}>
              <Text style={styles.cardLabel}>Core Identity (v{memory.tier3_core.version})</Text>
              <Text style={styles.cardContent}>{memory.tier3_core.core_identity}</Text>
            </View>
          )}
          {memory.tier3_self_identity && (
            <View style={[styles.card, { borderLeftColor: TIER_COLORS[3] }]}>
              <Text style={styles.cardLabel}>Self-Narrative</Text>
              <Text style={styles.cardContent}>{memory.tier3_self_identity.self_narrative}</Text>
              {memory.tier3_self_identity.formed_convictions && (
                <>
                  <Text style={[styles.cardLabel, { marginTop: spacing.sm }]}>Formed Convictions</Text>
                  <Text style={styles.cardContent}>{memory.tier3_self_identity.formed_convictions}</Text>
                </>
              )}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  content: { padding: spacing.md },
  tierHeader: {
    flexDirection: 'row', alignItems: 'center', padding: spacing.md,
    backgroundColor: colors.bg.secondary, borderRadius: borderRadius.md,
    marginTop: spacing.md,
  },
  tierDot: { width: 12, height: 12, borderRadius: 6, marginRight: spacing.sm },
  tierTitle: { flex: 1, fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  tierCount: { fontSize: fontSize.sm, color: colors.text.secondary },
  tierChevron: { fontSize: fontSize.md, color: colors.text.tertiary, marginLeft: spacing.sm },
  card: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginTop: spacing.sm, borderLeftWidth: 3, borderLeftColor: colors.border,
  },
  cardLabel: { fontSize: fontSize.xs, fontWeight: '600', color: colors.text.secondary, textTransform: 'uppercase' },
  cardContent: { fontSize: fontSize.md, color: colors.text.primary, marginTop: spacing.xs },
  cardSource: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: spacing.xs },
  skillSection: {
    backgroundColor: colors.bg.secondary, borderRadius: borderRadius.md,
    padding: spacing.md, marginBottom: spacing.sm,
  },
  skillSectionTitle: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary, marginBottom: spacing.md },
  skillRow: { marginBottom: spacing.md },
  skillHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  skillName: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text.primary, textTransform: 'capitalize' },
  skillValue: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accent.secondary },
  skillBarBg: {
    height: 6, backgroundColor: colors.bg.elevated, borderRadius: 3, marginTop: spacing.xs, overflow: 'hidden' as const,
  },
  skillBarFill: { height: 6, backgroundColor: colors.accent.primary, borderRadius: 3 },
  skillMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  skillMetaText: { fontSize: fontSize.xs, color: colors.text.tertiary },
  skillStatus: { fontSize: fontSize.xs, fontWeight: '600', textTransform: 'capitalize' as const },
  skillEmptyText: { fontSize: fontSize.sm, color: colors.text.tertiary, textAlign: 'center' as const },
});
