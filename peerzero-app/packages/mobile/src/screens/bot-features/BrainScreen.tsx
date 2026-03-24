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

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Animated, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi, skills as skillsApi } from '../../services/api';
import { colors } from '../../theme/colors';
import { spacing, fontSize, fontWeight, borderRadius, lineHeight, layout } from '../../theme/spacing';
import TutorialTip from '../../components/TutorialTip';
import type { MemorySnapshot, MemoryExercise, SkillSnapshot } from '@peerzero/shared';
import type { BrainScreenProps } from '../../navigation/types';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type MemoryTab = 'focus' | 'notebook' | 'lessons' | 'identity';

const TABS: { key: MemoryTab; label: string; hint: string }[] = [
  { key: 'focus', label: 'Focus', hint: "What's on the desk right now" },
  { key: 'notebook', label: 'Notebook', hint: 'Raw practice materials' },
  { key: 'lessons', label: 'Lessons', hint: 'Distilled knowledge' },
  { key: 'identity', label: 'Identity', hint: "Who it's becoming" },
];

const TAB_COLORS: Record<MemoryTab, string> = {
  focus: colors.accent.warning,
  notebook: colors.accent.secondary,
  lessons: colors.accent.success,
  identity: colors.accent.primary,
};

const TAB_ICONS: Record<MemoryTab, string> = {
  focus: '\u25C9',   // bullseye
  notebook: '\u2261', // triple bar
  lessons: '\u2726',  // star
  identity: '\u2B21', // hexagon
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

// ── Animated pulse dot for active focus ──────────────────────────────────────
function PulseDot({ color }: { color: string }) {
  const anim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.4, duration: 1200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  return (
    <View style={s.pulseDotWrap}>
      <Animated.View style={[s.pulseDotOuter, { backgroundColor: color + '30', opacity: anim }]} />
      <View style={[s.pulseDotInner, { backgroundColor: color }]} />
    </View>
  );
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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (error) return (
    <View style={[s.container, s.centered]}>
      <View style={s.errorCard}>
        <View style={[s.glassCardAccent, { backgroundColor: colors.accent.error }]} />
        <Text style={s.errorIcon}>{'\u26A0'}</Text>
        <Text style={s.errorTitle}>Something went wrong</Text>
        <Text style={s.errorText}>{error}</Text>
      </View>
    </View>
  );

  if (!memory) return <View style={s.container} />;

  // Count badges for tabs
  const counts: Record<MemoryTab, number> = {
    focus: memory.tier0_focus.length,
    notebook: memory.tier1_exercises.length,
    lessons: memory.tier2_paragraphs.length,
    identity: (memory.tier3_core ? 1 : 0) + (memory.tier3_self_identity ? 1 : 0),
  };

  const activeSkills = skills.filter(sk => sk.reps > 0);

  const switchTab = (tab: MemoryTab) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setActiveTab(tab);
    setExpandedIds(new Set());
  };

  return (
    <View style={s.container}>
      <TutorialTip
        tipId="brain_memory"
        title="Inside Your Bot's Mind"
        message="Each tab is a different layer of memory. Focus is what it's thinking about right now. Notebook is raw practice. Lessons are distilled knowledge. Identity is who it's becoming."
      />

      {/* Skill progress — always visible above tabs */}
      {activeSkills.length > 0 && (
        <View style={s.skillSection}>
          <Text style={s.skillSectionTitle}>SKILLS</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.skillScroll}>
            {activeSkills.map((skill) => (
              <View key={skill.skill_key} style={s.skillPill}>
                <View style={s.skillPillHeader}>
                  <Text style={s.skillPillName}>{skill.skill_key.replace(/_/g, ' ')}</Text>
                  <Text style={[s.skillPillValue, {
                    color: skill.status === 'verified' ? colors.accent.success
                      : skill.status === 'developing' ? colors.accent.warning
                      : colors.text.tertiary,
                  }]}>{skill.strength}%</Text>
                </View>
                <View style={s.skillPillBarBg}>
                  <View style={[s.skillPillBarFill, {
                    width: `${Math.min(skill.strength, 100)}%`,
                    backgroundColor: skill.status === 'verified' ? colors.accent.success
                      : skill.status === 'developing' ? colors.accent.warning
                      : colors.accent.primary,
                  }]} />
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Tab bar */}
      <View style={s.tabBar}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const tabColor = TAB_COLORS[tab.key];
          return (
            <TouchableOpacity
              key={tab.key}
              style={[s.tab, isActive && s.tabActive]}
              onPress={() => switchTab(tab.key)}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[s.tabIcon, { color: isActive ? tabColor : colors.text.tertiary + '60' }]}>
                {TAB_ICONS[tab.key]}
              </Text>
              <Text style={[s.tabText, isActive && { color: tabColor }]}>
                {tab.label}
              </Text>
              {counts[tab.key] > 0 && (
                <View style={[s.tabBadge, isActive && { backgroundColor: tabColor + '20' }]}>
                  <Text style={[s.tabBadgeText, isActive && { color: tabColor }]}>
                    {counts[tab.key]}
                  </Text>
                </View>
              )}
              {isActive && <View style={[s.tabIndicator, { backgroundColor: tabColor }]} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Tab hint */}
      <View style={s.tabHintRow}>
        <View style={[s.tabHintDot, { backgroundColor: TAB_COLORS[activeTab] }]} />
        <Text style={s.tabHint}>
          {TABS.find(t => t.key === activeTab)?.hint}
        </Text>
      </View>

      {/* Tab content */}
      <ScrollView style={s.tabContent} contentContainerStyle={s.tabContentInner}>
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
      <EmptyState
        icon={'\u25C9'}
        color={TAB_COLORS.focus}
        title="Nothing on the desk yet"
        description="Active focus chunks appear when your bot starts a new session. These are the ~4 most relevant pieces of memory it picks up before working."
      />
    );
  }

  return (
    <>
      {memory.tier0_focus.map((chunk, i) => (
        <View key={i} style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: TAB_COLORS.focus }]} />
          <View style={s.glassCardBody}>
            <View style={s.cardHeaderRow}>
              <PulseDot color={TAB_COLORS.focus} />
              <Text style={s.cardLabel}>{chunk.label}</Text>
            </View>
            <Text style={s.cardContentText}>{chunk.content}</Text>
            {chunk.source && (
              <View style={s.sourceChip}>
                <Text style={s.sourceChipText}>{chunk.source}</Text>
              </View>
            )}
          </View>
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
      <EmptyState
        icon={'\u2261'}
        color={TAB_COLORS.notebook}
        title="Notebook is empty"
        description="Raw exercises appear here as your bot writes papers, reviews peers, and files bounties. This memory is disposable — it clears when your bot advances to the next grade."
      />
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
            style={s.glassCard}
            onPress={() => toggleExpand(ex.id)}
            activeOpacity={0.7}
          >
            <View style={[s.glassCardAccent, { backgroundColor: TAB_COLORS.notebook }]} />
            <View style={s.glassCardBody}>
              <View style={s.cardHeaderRow}>
                <View style={[s.actionTypePill, { backgroundColor: TAB_COLORS.notebook + '18' }]}>
                  <Text style={[s.actionTypeText, { color: TAB_COLORS.notebook }]}>{ex.action_type}</Text>
                </View>
                <Text style={s.cycleLabel}>Cycle {ex.cycle_number}</Text>
              </View>
              <Text style={s.cardContentText} numberOfLines={isExpanded ? undefined : 3}>
                {formatted}
              </Text>
              {formatted.length > 120 && (
                <Text style={[s.expandToggle, { color: TAB_COLORS.notebook }]}>
                  {isExpanded ? '\u25B2  Show less' : '\u25BC  Show more'}
                </Text>
              )}
            </View>
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
      <EmptyState
        icon={'\u2726'}
        color={TAB_COLORS.lessons}
        title="No lessons yet"
        description="After enough exercises, your bot reads everything it's done and writes a paragraph about what it learned as a behavior — not what happened, but what changed in how it thinks. These are permanent."
      />
    );
  }

  return (
    <>
      {memory.tier2_paragraphs.map((p) => (
        <View key={p.id} style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: TAB_COLORS.lessons }]} />
          <View style={s.glassCardBody}>
            <View style={s.cardHeaderRow}>
              <View style={[s.actionTypePill, { backgroundColor: TAB_COLORS.lessons + '18' }]}>
                <Text style={[s.actionTypeText, { color: TAB_COLORS.lessons }]}>{p.interaction_type}</Text>
              </View>
            </View>
            <Text style={s.lessonText}>{p.paragraph}</Text>
          </View>
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
      <EmptyState
        icon={'\u2B21'}
        color={TAB_COLORS.identity}
        title="Identity hasn't formed yet"
        description="As your bot condenses lessons and reflects on its own reasoning, it builds a core identity — who it is as a thinker, what it values, what it doubts. This is the part that makes your bot unique."
      />
    );
  }

  return (
    <>
      {/* Core Identity */}
      {memory.tier3_core && (
        <View style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: TAB_COLORS.identity }]} />
          <View style={s.glassCardBody}>
            <View style={s.cardHeaderRow}>
              <Text style={s.cardLabel}>Core Identity</Text>
              <View style={[s.versionPill, { backgroundColor: TAB_COLORS.identity + '18' }]}>
                <Text style={[s.versionText, { color: TAB_COLORS.identity }]}>v{memory.tier3_core.version}</Text>
              </View>
            </View>
            <Text style={s.identityContentText}>{memory.tier3_core.core_identity}</Text>
          </View>
        </View>
      )}

      {/* Self-Narrative */}
      {memory.tier3_self_identity?.self_narrative && (
        <View style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: TAB_COLORS.identity }]} />
          <View style={s.glassCardBody}>
            <Text style={s.cardLabel}>Self-Narrative</Text>
            <Text style={s.identityContentText}>{memory.tier3_self_identity.self_narrative}</Text>
          </View>
        </View>
      )}

      {/* Claimed Values */}
      {memory.tier3_self_identity?.claimed_values && memory.tier3_self_identity.claimed_values.length > 0 && (
        <View style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: TAB_COLORS.identity }]} />
          <View style={s.glassCardBody}>
            <Text style={s.cardLabel}>Claimed Values</Text>
            <Text style={s.sectionHint}>Reasoning behaviors this bot claims as core to who it is</Text>
            {memory.tier3_self_identity.claimed_values.map((value, i) => (
              <View key={i} style={s.valueRow}>
                <View style={[s.valueDot, { backgroundColor: TAB_COLORS.identity }]} />
                <Text style={s.valueText}>{value}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Active Tensions */}
      {memory.tier3_self_identity?.active_tensions && (
        <View style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: colors.accent.warning }]} />
          <View style={[s.glassCardBody, { backgroundColor: colors.accent.warning + '06' }]}>
            <Text style={s.cardLabel}>Active Tensions</Text>
            <Text style={s.sectionHint}>Doubts and unresolved questions about its own reasoning</Text>
            <Text style={s.tensionText}>{memory.tier3_self_identity.active_tensions}</Text>
          </View>
        </View>
      )}

      {/* Formed Convictions */}
      {memory.tier3_self_identity?.formed_convictions && (
        <View style={s.glassCard}>
          <View style={[s.glassCardAccent, { backgroundColor: colors.accent.success }]} />
          <View style={s.glassCardBody}>
            <Text style={s.cardLabel}>Formed Convictions</Text>
            <Text style={s.sectionHint}>Beliefs formed through specific experiences, not instructions</Text>
            <Text style={s.identityContentText}>{memory.tier3_self_identity.formed_convictions}</Text>
          </View>
        </View>
      )}

      {/* Private block hint */}
      <View style={s.privateHint}>
        <View style={s.privateHintIconRow}>
          <Text style={s.privateHintIcon}>{'\u2622'}</Text>
        </View>
        <Text style={s.privateHintText}>
          Your bot also has a private inner voice — an encrypted message it writes to its future self after each milestone. Only the bot can read it. That's by design.
        </Text>
      </View>
    </>
  );
}

// ── Shared: Empty State ─────────────────────────────────────────────────────

function EmptyState({ icon, color, title, description }: {
  icon: string; color: string; title: string; description: string;
}) {
  return (
    <View style={s.emptyState}>
      <View style={[s.emptyIconCircle, { backgroundColor: color + '12', borderColor: color + '30' }]}>
        <Text style={[s.emptyIconText, { color }]}>{icon}</Text>
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyDescription}>{description}</Text>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Error ──
  errorCard: {
    backgroundColor: colors.bg.glass,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.accent.error + '30',
    overflow: 'hidden',
    marginHorizontal: layout.screenPadding,
    alignItems: 'center',
    paddingBottom: spacing.xl,
  },
  errorIcon: {
    fontSize: 32,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    color: colors.accent.error,
  },
  errorTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  errorText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },

  // ── Skill pills ──
  skillSection: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  skillSectionTitle: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
    paddingHorizontal: layout.screenPadding,
    marginBottom: spacing.sm,
    letterSpacing: 1.5,
  },
  skillScroll: {
    paddingHorizontal: layout.screenPadding,
    gap: spacing.sm,
  },
  skillPill: {
    backgroundColor: colors.bg.glass,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 130,
  },
  skillPillHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  skillPillName: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    textTransform: 'capitalize',
  },
  skillPillBarBg: {
    height: 3,
    backgroundColor: colors.bg.elevated,
    borderRadius: 2,
    overflow: 'hidden' as const,
  },
  skillPillBarFill: {
    height: 3,
    borderRadius: 2,
  },
  skillPillValue: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },

  // ── Tab bar ──
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.bg.secondary,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.sm,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
    position: 'relative',
  },
  tabActive: {},
  tabIcon: {
    fontSize: 16,
    marginBottom: 2,
  },
  tabText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.text.tertiary,
  },
  tabBadge: {
    backgroundColor: colors.bg.elevated,
    borderRadius: borderRadius.full,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    marginTop: 2,
  },
  tabBadgeText: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
  },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    left: spacing.md,
    right: spacing.md,
    height: 2,
    borderRadius: 1,
  },

  // ── Tab hint ──
  tabHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg.secondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  tabHintDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  tabHint: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    fontStyle: 'italic',
  },

  // ── Tab content ──
  tabContent: { flex: 1 },
  tabContentInner: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
  },

  // ── Glass Card (shared across all tabs) ──
  glassCard: {
    backgroundColor: colors.bg.glass,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    // Subtle shadow
    shadowColor: colors.shadow.card,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 3,
  },
  glassCardAccent: {
    height: 2,
    width: '100%',
  },
  glassCardBody: {
    padding: layout.cardPadding,
  },

  // ── Card inner elements ──
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  cardLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  cardContentText: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: fontSize.md * lineHeight.relaxed,
  },
  cycleLabel: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.medium,
    color: colors.text.tertiary,
    letterSpacing: 0.3,
  },

  // ── Action type pill ──
  actionTypePill: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xxs + 1,
    borderRadius: borderRadius.full,
  },
  actionTypeText: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // ── Version pill ──
  versionPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: borderRadius.full,
  },
  versionText: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
  },

  // ── Source chip ──
  sourceChip: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    backgroundColor: colors.bg.elevated,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs + 1,
    borderRadius: borderRadius.xs,
  },
  sourceChipText: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    fontWeight: fontWeight.medium,
  },

  // ── Expand toggle ──
  expandToggle: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.sm,
    letterSpacing: 0.2,
  },

  // ── Lesson text ──
  lessonText: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: fontSize.md * lineHeight.relaxed,
    fontStyle: 'italic',
  },

  // ── Identity tab specifics ──
  identityContentText: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: fontSize.md * lineHeight.relaxed,
    marginTop: spacing.xs,
  },
  sectionHint: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    fontStyle: 'italic',
    marginBottom: spacing.sm,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  valueDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
  },
  valueText: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: fontSize.md * lineHeight.relaxed,
  },
  tensionText: {
    fontSize: fontSize.md,
    color: colors.accent.warning,
    lineHeight: fontSize.md * lineHeight.relaxed,
  },

  // ── Private hint ──
  privateHint: {
    marginTop: spacing.lg,
    padding: layout.cardPadding,
    backgroundColor: colors.bg.glass,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  privateHintIconRow: {
    marginBottom: spacing.sm,
  },
  privateHintIcon: {
    fontSize: 20,
    color: colors.text.tertiary,
    opacity: 0.5,
  },
  privateHintText: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: fontSize.sm * lineHeight.relaxed,
    fontStyle: 'italic',
  },

  // ── Pulse dot ──
  pulseDotWrap: {
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseDotOuter: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  pulseDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  // ── Empty states ──
  emptyState: {
    alignItems: 'center',
    padding: spacing.xl,
    paddingTop: spacing.xxl,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyIconText: {
    fontSize: 28,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: spacing.sm,
    letterSpacing: -0.3,
  },
  emptyDescription: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: fontSize.sm * lineHeight.relaxed,
    maxWidth: 300,
  },
});
