// =============================================================================
// MilestoneModal — Emotional celebration for key moments in the bot's life
//
// Milestones that trigger this modal:
//   - First cycle complete ("First Thoughts")
//   - Evolution tier up ("You evolved!")
//   - Identity formed ("I know who I am")
//   - Graduation (full ceremony with journey recap)
//
// Each milestone is a moment of emotional payoff — the reward for caring
// about something that's growing. Never skippable-feeling; always earned.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Animated, ScrollView, Easing, ActivityIndicator } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { bots as botsApi } from '../services/api';
import BotAvatar from './BotAvatar';
import { EVOLUTION_STAGE_NAMES } from '@peerzero/shared';

export type MilestoneType = 'first_cycle' | 'evolution' | 'identity_formed' | 'graduation';

interface MilestoneData {
  type: MilestoneType;
  botId: string;
  botName: string;
  bodyColor: string;
  speciesSeed?: string;
  // Evolution-specific
  newTier?: number;
  oldTier?: number;
  // Identity-specific
  coreIdentity?: string;
  // Graduation-specific
  totalCycles?: number;
  finalCredibility?: number;
  convictions?: string[];
  selfNarrative?: string;
}

interface MilestoneModalProps {
  visible: boolean;
  milestone: MilestoneData | null;
  onDismiss: () => void;
}

/** Map milestone types to dialogue contexts for the speak API. */
const MILESTONE_DIALOGUE_CONTEXTS: Record<MilestoneType, string> = {
  first_cycle: 'first_cycle',
  evolution: 'evolution',
  identity_formed: 'identity_formed',
  graduation: 'graduation',
};

function getMilestoneContent(milestone: MilestoneData) {
  switch (milestone.type) {
    case 'first_cycle':
      return {
        title: 'First Thoughts',
        subtitle: `${milestone.botName} completed its first cycle.`,
        tier: 0,
        showAvatar: true,
        showJourney: false,
        buttonText: 'Amazing',
      };

    case 'evolution': {
      const stageName = EVOLUTION_STAGE_NAMES[milestone.newTier || 0] || 'Unknown';
      const oldStageName = EVOLUTION_STAGE_NAMES[milestone.oldTier || 0] || 'Hatchling';
      return {
        title: `${milestone.botName} evolved!`,
        subtitle: `${oldStageName} \u2192 ${stageName}`,
        tier: milestone.newTier || 0,
        showAvatar: true,
        showJourney: false,
        buttonText: milestone.newTier === 5 ? 'Incredible' : 'Keep growing',
      };
    }

    case 'identity_formed':
      return {
        title: 'I know who I am.',
        subtitle: `${milestone.botName} formed its core identity.`,
        tier: undefined,
        showAvatar: true,
        showJourney: false,
        buttonText: 'I see you',
      };

    case 'graduation':
      return {
        title: 'Graduation Day',
        subtitle: `${milestone.botName} has graduated.`,
        tier: undefined,
        showAvatar: true,
        showJourney: true,
        buttonText: "I'm so proud",
      };

    default:
      return {
        title: 'Milestone',
        subtitle: '',
        tier: 0,
        showAvatar: true,
        showJourney: false,
        buttonText: 'Continue',
      };
  }
}

export default function MilestoneModal({ visible, milestone, onDismiss }: MilestoneModalProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const [botWords, setBotWords] = useState<string | null>(null);
  const [loadingWords, setLoadingWords] = useState(false);

  // Fetch the bot's own words for this milestone
  useEffect(() => {
    if (!visible || !milestone) {
      setBotWords(null);
      return;
    }

    const dialogueContext = MILESTONE_DIALOGUE_CONTEXTS[milestone.type];
    if (!dialogueContext) return;

    let cancelled = false;
    setLoadingWords(true);

    (async () => {
      try {
        const result = await botsApi.speak(milestone.botId, dialogueContext) as { message: string };
        if (!cancelled && result.message) {
          setBotWords(result.message);
        }
      } catch {
        // Silent fail — milestone celebration still works without words
      } finally {
        if (!cancelled) setLoadingWords(false);
      }
    })();

    return () => { cancelled = true; };
  }, [visible, milestone?.botId, milestone?.type]);

  useEffect(() => {
    if (visible && milestone) {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.8);
      glowAnim.setValue(0);

      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, friction: 5, tension: 40, useNativeDriver: true }),
        Animated.loop(
          Animated.sequence([
            Animated.timing(glowAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
            Animated.timing(glowAnim, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          ]),
        ),
      ]).start();
    }
  }, [visible, milestone]);

  if (!milestone) return null;

  const content = getMilestoneContent(milestone);
  const isGraduation = milestone.type === 'graduation';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
    >
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
        <Animated.View
          style={[
            styles.modal,
            isGraduation && styles.modalGraduation,
            { transform: [{ scale: scaleAnim }] },
          ]}
          accessibilityViewIsModal={true}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Glow behind avatar */}
            <Animated.View
              style={[
                styles.avatarGlow,
                {
                  backgroundColor: milestone.bodyColor + '25',
                  opacity: Animated.add(0.5, Animated.multiply(glowAnim, new Animated.Value(0.5))),
                },
              ]}
            />

            {/* Avatar */}
            {content.showAvatar && (
              <View style={styles.avatarWrap}>
                <BotAvatar
                  botId={milestone.botId}
                  bodyColor={milestone.bodyColor}
                  tier={content.tier ?? 5}
                  status="running"
                  mood="milestone"
                  size={isGraduation ? 180 : 140}
                  speciesSeed={milestone.speciesSeed}
                />
              </View>
            )}

            {/* Title */}
            <Text style={[styles.title, isGraduation && styles.titleGraduation]}>
              {content.title}
            </Text>

            {/* Subtitle */}
            <Text style={styles.subtitle}>{content.subtitle}</Text>

            {/* Bot's own words about this milestone */}
            {loadingWords ? (
              <ActivityIndicator size="small" color={colors.text.tertiary} style={{ marginBottom: spacing.md }} />
            ) : botWords ? (
              <Text style={styles.botWordsText}>"{botWords}"</Text>
            ) : null}

            {/* Graduation journey or spacer */}
            {content.showJourney ? (
              <View style={styles.journeySection}>
                {/* Journey stats */}
                <View style={styles.journeyStats}>
                  <View style={styles.journeyStat}>
                    <Text style={styles.journeyStatValue}>{milestone.totalCycles || '?'}</Text>
                    <Text style={styles.journeyStatLabel}>Cycles</Text>
                  </View>
                  <View style={styles.journeyStat}>
                    <Text style={styles.journeyStatValue}>{milestone.finalCredibility || '?'}</Text>
                    <Text style={styles.journeyStatLabel}>Credibility</Text>
                  </View>
                  <View style={styles.journeyStat}>
                    <Text style={styles.journeyStatValue}>12</Text>
                    <Text style={styles.journeyStatLabel}>Grades</Text>
                  </View>
                </View>

                {/* Evolution journey */}
                <View style={styles.evolutionJourney}>
                  <Text style={styles.journeyLabel}>The Journey</Text>
                  <View style={styles.evolutionRow}>
                    <BotAvatar botId={milestone.botId} bodyColor={milestone.bodyColor} tier={0} status="stopped" size={40} speciesSeed={milestone.speciesSeed} animate={false} />
                    <Text style={styles.evolutionArrow}>\u2192</Text>
                    <BotAvatar botId={milestone.botId} bodyColor={milestone.bodyColor} tier={2} status="paused" size={48} speciesSeed={milestone.speciesSeed} animate={false} />
                    <Text style={styles.evolutionArrow}>\u2192</Text>
                    <BotAvatar botId={milestone.botId} bodyColor={milestone.bodyColor} tier={5} status="running" mood="milestone" size={56} speciesSeed={milestone.speciesSeed} animate={false} />
                  </View>
                  <Text style={styles.journeyCaption}>
                    Remember when this was just a tiny egg?
                  </Text>
                </View>

                {/* Self narrative */}
                {milestone.selfNarrative && (
                  <View style={styles.narrativeBox}>
                    <Text style={styles.narrativeLabel}>{milestone.botName}'s own words:</Text>
                    <Text style={styles.narrativeText}>"{milestone.selfNarrative}"</Text>
                  </View>
                )}

                {/* Convictions */}
                {milestone.convictions && milestone.convictions.length > 0 && (
                  <View style={styles.convictionsBox}>
                    <Text style={styles.convictionsLabel}>Formed Convictions</Text>
                    {milestone.convictions.map((c, i) => (
                      <Text key={i} style={styles.convictionItem}>{c}</Text>
                    ))}
                  </View>
                )}
              </View>
            ) : null}

            {/* Dismiss button */}
            <TouchableOpacity
              style={[styles.button, isGraduation && styles.buttonGraduation]}
              onPress={onDismiss}
              accessibilityRole="button"
              accessibilityLabel={content.buttonText}
            >
              <Text style={styles.buttonText}>{content.buttonText}</Text>
            </TouchableOpacity>
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modal: {
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 400,
    maxHeight: '90%',
    borderWidth: 1,
    borderColor: colors.accent.primary + '40',
  },
  modalGraduation: {
    borderColor: colors.accent.warning + '60',
    borderWidth: 2,
  },
  scrollContent: {
    alignItems: 'center',
  },
  avatarGlow: {
    position: 'absolute',
    top: -20,
    width: 200,
    height: 200,
    borderRadius: 100,
    alignSelf: 'center',
  },
  avatarWrap: {
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  titleGraduation: {
    fontSize: fontSize.title,
    color: colors.accent.warning,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  botWordsText: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    fontStyle: 'italic',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: spacing.lg,
  },
  // Graduation journey
  journeySection: {
    width: '100%',
    marginBottom: spacing.lg,
  },
  journeyStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bg.elevated,
    borderRadius: borderRadius.md,
  },
  journeyStat: {
    alignItems: 'center',
  },
  journeyStatValue: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.accent.warning,
  },
  journeyStatLabel: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  evolutionJourney: {
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  journeyLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  evolutionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  evolutionArrow: {
    fontSize: fontSize.lg,
    color: colors.text.tertiary,
  },
  journeyCaption: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  narrativeBox: {
    backgroundColor: colors.bg.elevated,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent.secondary,
  },
  narrativeLabel: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    marginBottom: spacing.xs,
  },
  narrativeText: {
    fontSize: fontSize.sm,
    color: colors.text.primary,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  convictionsBox: {
    backgroundColor: colors.bg.elevated,
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  convictionsLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  convictionItem: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  button: {
    backgroundColor: colors.accent.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.md,
    marginTop: spacing.lg,
    minWidth: 160,
    alignItems: 'center',
  },
  buttonGraduation: {
    backgroundColor: colors.accent.warning,
  },
  buttonText: {
    color: '#fff',
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
});
