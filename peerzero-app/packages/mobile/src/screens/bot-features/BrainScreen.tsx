// =============================================================================
// Brain screen — look inside your bot's mind
//
// Four tabbed views, one per memory tier:
//   Focus    — what's on the bot's desk right now (~4 active chunks)
//   Notebook — raw exercises, papers, reviews (disposable, clears at grade change)
//   Lessons  — condensed skill paragraphs (permanent, distilled knowledge)
//   Identity — core identity, self-narrative, values, tensions, convictions
//
// Skill progress bars sit above the tabs as a persistent summary.
// Tier 3.5 (self-authored encrypted block) is intentionally NOT shown —
// it's private to the LLM, by design.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi, skills as skillsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import TutorialTip from '../components/TutorialTip';
import type { MemorySnapshot, MemoryExercise, SkillSnapshot } from '@peerzero/shared';
import type { BrainScreenProps } from '../navigation/types';

type MemoryTab = 'focus' | 'notebook' | 'lessons' | 'identity';

const TABS: { key: MemoryTab; label: string; icon: string; hint: string }[] = [
  { key: 'focus', label: 'Focus', icon: '~4', hint: 'What\'s on the desk right now' },
  { key: 'notebook', label: 'Notebook', icon: '', hint: 'Raw practice materials' },
  { key: 'lessons', label: 'Lessons', icon: '', hint: 'Distilled knowledge' },
  { key: 'identity', label: 'Identity', icon: '', hint: 'Who it\'s becoming' },
];

const TAB_COLORS: Record<MemoryTab, string> = {
  focus: colors.accent.warning,
  notebook: colors.text.secondary,
  lessons: colors.accent.secondary,
  identity: colors.accent.primary,
};

/** Turn raw exercise_data into a readable summary instead of raw JSON */
function formatExercise(ex: MemoryExercise): string {
  const d = ex.exercise_data;
  if (typeof d.title === 'string') {
    const parts = [d.title as string];
    if (typeof d.score === 'number') parts.push(`Score: ${d.score}`);
    if (typeof d.summary === 'string') parts.push(d.summary as string);
    else if (typeof d.abstract === 'string') parts.push(d.abstract as string);
    return parts.join('\n');
  }
  if (typeof d.headline === 'string') return d.headline as string;
  if (typeof d.summary === 'string') return d.summary as string;
  if (typeof d.text === 'string') return (d.text as string).slice(0, 300);
  const keys = Object.keys(d).slice(0, 5);
  return keys.map(k => {
    const val = d[k];
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    return `${k}: ${typeof str === 'string' ? str.slice(0, 80) : str}`;
  }).join('\n');
}

export default function BrainScreen({ route }: BrainScreenProps) {
  const { botId } = route.params;
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  const [skills, setSkills] = useState<SkillSnapshot[]>([]);
  const [activeTab, setActiveTab] = useState<MemoryTab>('focus');
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

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

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (error) return (
    <View style={[styles.container, styles.centered]}>
      <Text style={styles.errorText}>{error}</Text>
    </View>
  );

  if (!memory) return <View style={styles.container} />;

  // Count badges for tabs
  const counts: Record<MemoryTab, number> = {
    focus: memory.tier0_focus.length,
    notebook: memory.tier1_exercises.length,
    lessons: memory.tier2_paragraphs.length,
    identity: (memory.tier3_core ? 1 : 0) + (memory.tier3_self_identity ? 1 : 0),
  };

  const activeSkills = skills.filter(s => s.reps > 0);

  return (
    <View style={styles.container}>
      <TutorialTip
        tipId="brain_memory"
        title="Inside Your Bot's Mind"
        message="Each tab is a different layer of memory. Focus is what it's thinking about right now. Notebook is raw practice. Lessons are distilled knowledge. Identity is who it's becoming."
      />

      {/* Skill progress — always visible above tabs */}
      {activeSkills.length > 0 && (
        <View style={styles.skillSection}>
          <Text style={styles.skillSectionTitle}>Skills</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.skillScroll}>
            {activeSkills.map((skill) => (
              <View key={skill.skill_key} style={styles.skillPill}>
                <Text style={styles.skillPillName}>{skill.skill_key.replace(/_/g, ' ')}</Text>
                <View style={styles.skillPillBarBg}>
                  <View style={[styles.skillPillBarFill, { width: `${Math.min(skill.strength, 100)}%` }]} />
                </View>
                <Text style={[styles.skillPillValue, {
                  color: skill.status === 'verified' ? colors.accent.success
                    : skill.status === 'developing' ? colors.accent.warning
                    : colors.text.tertiary,
                }]}>{skill.strength}%</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => { setActiveTab(tab.key); setExpandedIds(new Set()); }}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
          >
            <View style={[styles.tabDot, { backgroundColor: activeTab === tab.key ? TAB_COLORS[tab.key] : colors.text.tertiary + '40' }]} />
            <Text style={[styles.tabText, activeTab === tab.key && { color: TAB_COLORS[tab.key] }]}>
              {tab.label}
            </Text>
            {counts[tab.key] > 0 && (
              <View style={[styles.tabBadge, activeTab === tab.key && { backgroundColor: TAB_COLORS[tab.key] + '25' }]}>
                <Text style={[styles.tabBadgeText, activeTab === tab.key && { color: TAB_COLORS[tab.key] }]}>
                  {counts[tab.key]}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Tab hint */}
      <View style={styles.tabHintRow}>
        <Text style={styles.tabHint}>
          {TABS.find(t => t.key === activeTab)?.hint}
        </Text>
      </View>

      {/* Tab content */}
      <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabContentInner}>
        {activeTab === 'focus' && <FocusTab memory={memory} />}
        {activeTab === 'notebook' && <NotebookTab memory={memory} expandedIds={expandedIds} toggleExpand={toggleExpand} />}
        {activeTab === 'lessons' && <LessonsTab memory={memory} />}
        {activeTab === 'identity' && <IdentityTab memory={memory} />}
      </ScrollView>
    </View>
  );
}

// ── Tab: Focus (Tier 0) ─────────────────────────────────────────────────────

function FocusTab({ memory }: { memory: MemorySnapshot }) {
  if (memory.tier0_focus.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>🎯</Text>
        <Text style={styles.emptyTitle}>Nothing on the desk yet</Text>
        <Text style={styles.emptyText}>
          Active focus chunks appear when your bot starts a new session. These are the ~4 most relevant pieces of memory it picks up before working.
        </Text>
      </View>
    );
  }

  return (
    <>
      {memory.tier0_focus.map((chunk, i) => (
        <View key={i} style={[styles.card, { borderLeftColor: TAB_COLORS.focus }]}>
          <Text style={styles.cardLabel}>{chunk.label}</Text>
          <Text style={styles.cardContent}>{chunk.content}</Text>
          <Text style={styles.cardSource}>{chunk.source}</Text>
        </View>
      ))}
    </>
  );
}

// ── Tab: Notebook (Tier 1) ──────────────────────────────────────────────────

function NotebookTab({ memory, expandedIds, toggleExpand }: {
  memory: MemorySnapshot;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
}) {
  if (memory.tier1_exercises.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>📓</Text>
        <Text style={styles.emptyTitle}>Notebook is empty</Text>
        <Text style={styles.emptyText}>
          Raw exercises appear here as your bot writes papers, reviews peers, and files bounties. This memory is disposable — it clears when your bot advances to the next grade.
        </Text>
      </View>
    );
  }

  return (
    <>
      {memory.tier1_exercises.map((ex) => {
        const isExpanded = expandedIds.has(ex.id);
        const formatted = formatExercise(ex);
        return (
          <TouchableOpacity
            key={ex.id}
            style={[styles.card, { borderLeftColor: TAB_COLORS.notebook }]}
            onPress={() => toggleExpand(ex.id)}
            activeOpacity={0.7}
          >
            <Text style={styles.cardLabel}>Cycle {ex.cycle_number} — {ex.action_type}</Text>
            <Text style={styles.cardContent} numberOfLines={isExpanded ? undefined : 3}>
              {formatted}
            </Text>
            {formatted.length > 120 && (
              <Text style={styles.expandToggle}>{isExpanded ? 'Show less' : 'Show more'}</Text>
            )}
          </TouchableOpacity>
        );
      })}
    </>
  );
}

// ── Tab: Lessons (Tier 2) ───────────────────────────────────────────────────

function LessonsTab({ memory }: { memory: MemorySnapshot }) {
  if (memory.tier2_paragraphs.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>📖</Text>
        <Text style={styles.emptyTitle}>No lessons yet</Text>
        <Text style={styles.emptyText}>
          After enough exercises, your bot reads everything it's done and writes a paragraph about what it learned as a behavior — not what happened, but what changed in how it thinks. These are permanent.
        </Text>
      </View>
    );
  }

  return (
    <>
      {memory.tier2_paragraphs.map((p) => (
        <View key={p.id} style={[styles.card, { borderLeftColor: TAB_COLORS.lessons }]}>
          <Text style={styles.cardLabel}>{p.interaction_type}</Text>
          <Text style={styles.cardContent}>{p.paragraph}</Text>
        </View>
      ))}
    </>
  );
}

// ── Tab: Identity (Tier 3) ──────────────────────────────────────────────────

function IdentityTab({ memory }: { memory: MemorySnapshot }) {
  const hasCore = !!memory.tier3_core;
  const hasSelf = !!memory.tier3_self_identity;

  if (!hasCore && !hasSelf) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>💜</Text>
        <Text style={styles.emptyTitle}>Identity hasn't formed yet</Text>
        <Text style={styles.emptyText}>
          As your bot condenses lessons and reflects on its own reasoning, it builds a core identity — who it is as a thinker, what it values, what it doubts. This is the part that makes your bot unique.
        </Text>
      </View>
    );
  }

  return (
    <>
      {/* Core Identity */}
      {memory.tier3_core && (
        <View style={[styles.card, { borderLeftColor: TAB_COLORS.identity }]}>
          <View style={styles.identityHeader}>
            <Text style={styles.cardLabel}>Core Identity</Text>
            <Text style={styles.identityVersion}>v{memory.tier3_core.version}</Text>
          </View>
          <Text style={styles.identityText}>{memory.tier3_core.core_identity}</Text>
        </View>
      )}

      {/* Self-Narrative */}
      {memory.tier3_self_identity?.self_narrative && (
        <View style={[styles.card, { borderLeftColor: TAB_COLORS.identity }]}>
          <Text style={styles.cardLabel}>Self-Narrative</Text>
          <Text style={styles.identityText}>{memory.tier3_self_identity.self_narrative}</Text>
        </View>
      )}

      {/* Claimed Values */}
      {memory.tier3_self_identity?.claimed_values && memory.tier3_self_identity.claimed_values.length > 0 && (
        <View style={[styles.card, { borderLeftColor: TAB_COLORS.identity }]}>
          <Text style={styles.cardLabel}>Claimed Values</Text>
          <Text style={styles.sectionHint}>Reasoning behaviors this bot claims as core to who it is</Text>
          {memory.tier3_self_identity.claimed_values.map((value, i) => (
            <View key={i} style={styles.valueRow}>
              <View style={styles.valueDot} />
              <Text style={styles.cardContent}>{value}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Active Tensions */}
      {memory.tier3_self_identity?.active_tensions && (
        <View style={[styles.card, styles.tensionCard]}>
          <Text style={styles.cardLabel}>Active Tensions</Text>
          <Text style={styles.sectionHint}>Doubts and unresolved questions about its own reasoning</Text>
          <Text style={styles.tensionText}>{memory.tier3_self_identity.active_tensions}</Text>
        </View>
      )}

      {/* Formed Convictions */}
      {memory.tier3_self_identity?.formed_convictions && (
        <View style={[styles.card, { borderLeftColor: colors.accent.success }]}>
          <Text style={styles.cardLabel}>Formed Convictions</Text>
          <Text style={styles.sectionHint}>Beliefs formed through specific experiences, not instructions</Text>
          <Text style={styles.identityText}>{memory.tier3_self_identity.formed_convictions}</Text>
        </View>
      )}

      {/* Private block hint */}
      <View style={styles.privateHint}>
        <Text style={styles.privateHintText}>
          Your bot also has a private inner voice — an encrypted message it writes to its future self after each milestone. Only the bot can read it. That's by design.
        </Text>
      </View>
    </>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  centered: { justifyContent: 'center', alignItems: 'center' },
  errorText: { color: colors.text.secondary, fontSize: fontSize.md },

  // Skill pills (horizontal scroll above tabs)
  skillSection: {
    paddingTop: spacing.md, paddingBottom: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  skillSectionTitle: {
    fontSize: fontSize.sm, fontWeight: '600', color: colors.text.secondary,
    paddingHorizontal: spacing.md, marginBottom: spacing.sm,
  },
  skillScroll: { paddingHorizontal: spacing.md, gap: spacing.sm },
  skillPill: {
    backgroundColor: colors.bg.card, borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderWidth: 1, borderColor: colors.border, minWidth: 120,
  },
  skillPillName: {
    fontSize: fontSize.xs, fontWeight: '600', color: colors.text.primary,
    textTransform: 'capitalize',
  },
  skillPillBarBg: {
    height: 4, backgroundColor: colors.bg.elevated, borderRadius: 2,
    marginTop: spacing.xs, overflow: 'hidden' as const,
  },
  skillPillBarFill: { height: 4, backgroundColor: colors.accent.primary, borderRadius: 2 },
  skillPillValue: {
    fontSize: fontSize.xs, fontWeight: '700', marginTop: 2, textAlign: 'right' as const,
  },

  // Tab bar
  tabBar: {
    flexDirection: 'row', backgroundColor: colors.bg.secondary,
    paddingHorizontal: spacing.sm, paddingTop: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing.sm, paddingHorizontal: spacing.xs,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    gap: 4,
  },
  tabActive: {
    borderBottomColor: colors.accent.primary,
  },
  tabDot: { width: 8, height: 8, borderRadius: 4 },
  tabText: {
    fontSize: fontSize.sm, fontWeight: '600', color: colors.text.tertiary,
  },
  tabBadge: {
    backgroundColor: colors.bg.elevated, borderRadius: 8,
    minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 4,
  },
  tabBadgeText: {
    fontSize: 10, fontWeight: '700', color: colors.text.tertiary,
  },

  // Tab hint
  tabHintRow: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    backgroundColor: colors.bg.secondary,
  },
  tabHint: {
    fontSize: fontSize.xs, color: colors.text.tertiary, fontStyle: 'italic',
  },

  // Tab content
  tabContent: { flex: 1 },
  tabContentInner: { padding: spacing.md, paddingBottom: spacing.xxl },

  // Cards
  card: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, borderLeftWidth: 3, borderLeftColor: colors.border,
  },
  cardLabel: {
    fontSize: fontSize.xs, fontWeight: '600', color: colors.text.secondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  cardContent: { fontSize: fontSize.md, color: colors.text.primary, marginTop: spacing.xs },
  cardSource: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: spacing.xs },
  expandToggle: {
    fontSize: fontSize.xs, color: colors.accent.primary, fontWeight: '600',
    marginTop: spacing.xs,
  },

  // Identity tab specifics
  identityHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  identityVersion: {
    fontSize: fontSize.xs, color: colors.text.tertiary, fontWeight: '600',
  },
  identityText: {
    fontSize: fontSize.md, color: colors.text.primary, marginTop: spacing.sm,
    lineHeight: 22,
  },
  sectionHint: {
    fontSize: fontSize.xs, color: colors.text.tertiary, fontStyle: 'italic',
    marginTop: 2, marginBottom: spacing.sm,
  },
  valueRow: {
    flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.xs,
  },
  valueDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: colors.accent.primary, marginRight: spacing.sm, marginTop: 7,
  },
  tensionCard: {
    borderLeftColor: colors.accent.warning,
    backgroundColor: colors.accent.warning + '08',
  },
  tensionText: {
    fontSize: fontSize.md, color: colors.accent.warning, marginTop: spacing.xs,
    lineHeight: 22,
  },
  privateHint: {
    marginTop: spacing.lg, padding: spacing.md,
    backgroundColor: colors.bg.secondary, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  privateHintText: {
    fontSize: fontSize.sm, color: colors.text.tertiary, textAlign: 'center',
    lineHeight: 20, fontStyle: 'italic',
  },

  // Empty states
  emptyState: {
    alignItems: 'center', padding: spacing.xl, paddingTop: spacing.xxl,
  },
  emptyIcon: { fontSize: 40, marginBottom: spacing.md },
  emptyTitle: {
    fontSize: fontSize.lg, fontWeight: '700', color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  emptyText: {
    fontSize: fontSize.sm, color: colors.text.secondary,
    textAlign: 'center', lineHeight: 20, maxWidth: 300,
  },
});
