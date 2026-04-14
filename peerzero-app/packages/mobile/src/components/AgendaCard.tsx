// =============================================================================
// AgendaCard — inline action desk display for the chat feed
//
// Shows the bot's current action plan with live-updating step statuses.
// Appears as an expandable card in the message stream. Collapsed shows a
// single progress line; expanded shows the full step list with status icons.
//
// Step status icons match the Action Desk convention:
//   [x] done (green)   [>] in_progress (animated)   [ ] pending (gray)
//   [!] failed (red)   [-] skipped (strikethrough)
// =============================================================================

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize, fontWeight, borderRadius, lineHeight } from '../theme/spacing';

interface AgendaStep {
  action: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  result?: string;
  task_type?: string;
  depends_on?: number[];
}

export interface AgendaState {
  directive: string;
  intention: string;
  identity_reasoning?: string;
  steps: AgendaStep[];
  status: string;           // 'planning' | 'active' | 'completed' | 'abandoned'
  progress_summary: string; // e.g., "3/5 done, 1 failed"
}

interface AgendaCardProps {
  agenda: AgendaState;
  taskId?: string;
  onCancel?: (taskId: string) => void;
}

const STATUS_ICON: Record<string, { icon: string; color: string }> = {
  done: { icon: '\u2713', color: colors.accent.success },
  in_progress: { icon: '\u25B6', color: colors.accent.primary },
  pending: { icon: '\u25CB', color: colors.text.tertiary },
  failed: { icon: '!', color: colors.accent.error },
  skipped: { icon: '\u2014', color: colors.text.tertiary },
};

export default function AgendaCard({ agenda, taskId, onCancel }: AgendaCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isComplete = agenda.status === 'completed';
  const isAbandoned = agenda.status === 'abandoned';
  const isPlanning = agenda.status === 'planning';

  return (
    <TouchableOpacity
      style={[
        styles.container,
        isComplete && styles.containerComplete,
        isAbandoned && styles.containerAbandoned,
      ]}
      onPress={() => setExpanded(!expanded)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Agenda: ${agenda.directive || 'Task'}. ${isComplete ? 'Complete' : isAbandoned ? 'Abandoned' : 'Active'}. ${expanded ? 'Tap to collapse' : 'Tap to expand'}`}
      accessibilityState={{ expanded }}
    >
      {/* Header — always visible */}
      <View style={styles.header}>
        <View style={[
          styles.statusDot,
          isComplete && styles.statusDotComplete,
          isAbandoned && styles.statusDotAbandoned,
          isPlanning && styles.statusDotPlanning,
          !isComplete && !isAbandoned && !isPlanning && styles.statusDotActive,
        ]} />
        <View style={styles.headerText}>
          <Text style={styles.directiveText} numberOfLines={expanded ? undefined : 1}>
            {agenda.directive}
          </Text>
          <Text style={styles.progressText}>
            {isPlanning ? 'Planning...' : agenda.progress_summary}
          </Text>
        </View>
        <Text style={styles.expandIcon}>{expanded ? '\u25B2' : '\u25BC'}</Text>
      </View>

      {/* Expanded: step list */}
      {expanded && (
        <View style={styles.stepList}>
          {agenda.intention ? (
            <Text style={styles.intentionText}>{agenda.intention}</Text>
          ) : null}

          {agenda.steps.map((step, i) => {
            const { icon, color } = STATUS_ICON[step.status] || STATUS_ICON.pending;
            return (
              <View key={i} style={styles.stepRow}>
                <View style={[styles.stepIcon, { borderColor: color }]}>
                  <Text style={[styles.stepIconText, { color }]}>{icon}</Text>
                </View>
                <View style={styles.stepContent}>
                  <Text style={[
                    styles.stepAction,
                    step.status === 'skipped' && styles.stepActionSkipped,
                    step.status === 'done' && styles.stepActionDone,
                  ]}>
                    {`${i + 1}. ${step.action}`}
                  </Text>
                  {step.result && step.status === 'done' && (
                    <Text style={styles.stepResult} numberOfLines={2}>{step.result}</Text>
                  )}
                  {step.status === 'failed' && step.result && (
                    <Text style={styles.stepError} numberOfLines={2}>{step.result}</Text>
                  )}
                </View>
              </View>
            );
          })}

          {agenda.identity_reasoning ? (
            <View style={styles.reasoningWrap}>
              <Text style={styles.reasoningLabel}>Reasoning</Text>
              <Text style={styles.reasoningText}>{agenda.identity_reasoning}</Text>
            </View>
          ) : null}

          {/* Cancel button for active/planning agendas */}
          {!isComplete && !isAbandoned && taskId && onCancel && (
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => onCancel(taskId)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Cancel task"
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: spacing.sm,
    marginHorizontal: spacing.xs,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.accent.primary + '30',
    borderLeftWidth: 3,
    borderLeftColor: colors.accent.primary,
    overflow: 'hidden',
  },
  containerComplete: {
    borderLeftColor: colors.accent.success,
    borderColor: colors.accent.success + '20',
    opacity: 0.85,
  },
  containerAbandoned: {
    borderLeftColor: colors.accent.error,
    borderColor: colors.accent.error + '20',
    opacity: 0.7,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.sm,
  },
  statusDotActive: {
    backgroundColor: colors.accent.primary,
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  statusDotComplete: {
    backgroundColor: colors.accent.success,
  },
  statusDotAbandoned: {
    backgroundColor: colors.accent.error,
  },
  statusDotPlanning: {
    backgroundColor: colors.accent.warning,
  },
  headerText: {
    flex: 1,
    marginRight: spacing.sm,
  },
  directiveText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    lineHeight: fontSize.sm * lineHeight.normal,
  },
  progressText: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    marginTop: 2,
    fontWeight: fontWeight.medium,
  },
  expandIcon: {
    fontSize: 10,
    color: colors.text.tertiary,
  },

  // Steps
  stepList: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border + '40',
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  intentionText: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    fontStyle: 'italic',
    marginBottom: spacing.sm,
    lineHeight: fontSize.xs * lineHeight.relaxed,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.xs + 2,
  },
  stepIcon: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
    marginTop: 1,
  },
  stepIconText: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
  },
  stepContent: {
    flex: 1,
  },
  stepAction: {
    fontSize: fontSize.sm,
    color: colors.text.primary,
    lineHeight: fontSize.sm * lineHeight.normal,
  },
  stepActionSkipped: {
    textDecorationLine: 'line-through',
    color: colors.text.tertiary,
  },
  stepActionDone: {
    color: colors.text.secondary,
  },
  stepResult: {
    fontSize: fontSize.xxs,
    color: colors.accent.success,
    marginTop: 2,
    lineHeight: fontSize.xxs * lineHeight.relaxed,
  },
  stepError: {
    fontSize: fontSize.xxs,
    color: colors.accent.error,
    marginTop: 2,
    lineHeight: fontSize.xxs * lineHeight.relaxed,
  },

  // Reasoning
  reasoningWrap: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border + '30',
  },
  reasoningLabel: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xxs,
  },
  reasoningText: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: fontSize.xs * lineHeight.relaxed,
  },

  // Cancel button
  cancelButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.accent.error + '40',
    backgroundColor: colors.accent.error + '10',
    alignSelf: 'flex-start',
  },
  cancelButtonText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.accent.error,
  },
});
