// =============================================================================
// Stats screen — Bot performance charts and trends
//
// Uses react-native-svg for lightweight chart rendering (no native module deps).
// Charts are hand-drawn SVG — avoids heavy charting library dependencies while
// keeping the app Expo-compatible and bundle size small.
//
// Scalability: Stats are aggregated server-side from activity_log with
// date-range queries and partial indexes. No client-side computation needed.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Dimensions } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Svg, { Rect, Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';
import { bots as botsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { SKILL_DISPLAY_NAMES } from '@peerzero/shared';
import type { BotStats } from '@peerzero/shared';
import type { StatsScreenProps } from '../navigation/types';

const CHART_WIDTH = Dimensions.get('window').width - spacing.xl * 2;
const CHART_HEIGHT = 160;
const CHART_PADDING = { top: 20, right: 16, bottom: 24, left: 48 };

const ACTION_COLORS: Record<string, string> = {
  review: colors.accent.primary,
  paper: colors.accent.secondary,
  bounty: colors.accent.warning,
  revision: colors.accent.success,
  reaffirmation: colors.mood.milestone,
  condense: colors.text.tertiary,
  reflect: '#A8E6CF',
  error: colors.accent.error,
};

export default function StatsScreen({ route }: StatsScreenProps) {
  const { botId } = route.params;
  const [stats, setStats] = useState<BotStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setError(null);
      const data = await botsApi.stats(botId) as BotStats;
      setStats(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadStats(); }, [loadStats]));

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  if (error || !stats) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={styles.errorText}>{error || 'No stats available'}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Summary cards */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{stats.total_cycles}</Text>
          <Text style={styles.summaryLabel}>Total Cycles</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{formatTokens(stats.total_tokens)}</Text>
          <Text style={styles.summaryLabel}>Tokens Used</Text>
        </View>
      </View>

      {/* Credibility over time */}
      {stats.credibility_history.length > 1 && (
        <View style={styles.chartSection}>
          <Text style={styles.chartTitle}>Credibility Over Time</Text>
          <CredibilityChart data={stats.credibility_history} />
        </View>
      )}

      {/* Action breakdown */}
      {stats.action_breakdown.length > 0 && (
        <View style={styles.chartSection}>
          <Text style={styles.chartTitle}>Action Breakdown</Text>
          <ActionBreakdownChart data={stats.action_breakdown} />
        </View>
      )}

      {/* Skill progress */}
      {stats.skill_progress.length > 0 && (
        <View style={styles.chartSection}>
          <Text style={styles.chartTitle}>Skill Activity</Text>
          <SkillProgressChart data={stats.skill_progress} />
        </View>
      )}

      {/* Token usage trend */}
      {stats.token_usage_trend.length > 1 && (
        <View style={styles.chartSection}>
          <Text style={styles.chartTitle}>Token Usage (Daily)</Text>
          <TokenUsageChart data={stats.token_usage_trend} />
        </View>
      )}

      {stats.credibility_history.length <= 1 && stats.action_breakdown.length === 0 && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>Not enough data yet. Run more cycles to see charts!</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ── Mini chart components (SVG-based, no external charting library) ──

function CredibilityChart({ data }: { data: Array<{ date: string; value: number }> }) {
  const plotW = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  const values = data.map(d => d.value);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05;
  const range = maxVal - minVal || 1;

  const points = data.map((d, i) => {
    const x = CHART_PADDING.left + (i / (data.length - 1)) * plotW;
    const y = CHART_PADDING.top + plotH - ((d.value - minVal) / range) * plotH;
    return `${x},${y}`;
  }).join(' ');

  return (
    <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(frac => {
        const y = CHART_PADDING.top + plotH * (1 - frac);
        const val = Math.round(minVal + range * frac);
        return (
          <React.Fragment key={frac}>
            <Line x1={CHART_PADDING.left} y1={y} x2={CHART_WIDTH - CHART_PADDING.right} y2={y} stroke={colors.border} strokeWidth={0.5} />
            <SvgText x={CHART_PADDING.left - 4} y={y + 4} fontSize={9} fill={colors.text.tertiary} textAnchor="end">{val}</SvgText>
          </React.Fragment>
        );
      })}
      {/* Line */}
      <Polyline points={points} fill="none" stroke={colors.accent.secondary} strokeWidth={2} />
      {/* Data points */}
      {data.map((d, i) => {
        const x = CHART_PADDING.left + (i / (data.length - 1)) * plotW;
        const y = CHART_PADDING.top + plotH - ((d.value - minVal) / range) * plotH;
        return <Circle key={i} cx={x} cy={y} r={3} fill={colors.accent.secondary} />;
      })}
      {/* X-axis labels (first and last date) */}
      <SvgText x={CHART_PADDING.left} y={CHART_HEIGHT - 4} fontSize={9} fill={colors.text.tertiary}>{formatDate(data[0].date)}</SvgText>
      <SvgText x={CHART_WIDTH - CHART_PADDING.right} y={CHART_HEIGHT - 4} fontSize={9} fill={colors.text.tertiary} textAnchor="end">{formatDate(data[data.length - 1].date)}</SvgText>
    </Svg>
  );
}

function ActionBreakdownChart({ data }: { data: Array<{ action_type: string; count: number }> }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const barHeight = 28;
  const chartH = data.length * (barHeight + 8) + 8;

  return (
    <Svg width={CHART_WIDTH} height={chartH}>
      {data.map((d, i) => {
        const y = i * (barHeight + 8) + 4;
        const barW = Math.max(4, (d.count / total) * (CHART_WIDTH - 100));
        const color = ACTION_COLORS[d.action_type] || colors.text.tertiary;
        const pct = ((d.count / total) * 100).toFixed(0);
        return (
          <React.Fragment key={d.action_type}>
            <Rect x={80} y={y} width={barW} height={barHeight} fill={color} rx={4} opacity={0.8} />
            <SvgText x={76} y={y + barHeight / 2 + 4} fontSize={11} fill={colors.text.secondary} textAnchor="end">{d.action_type}</SvgText>
            <SvgText x={84 + barW} y={y + barHeight / 2 + 4} fontSize={10} fill={colors.text.tertiary}>{d.count} ({pct}%)</SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

function SkillProgressChart({ data }: { data: Array<{ skill: string; reps: number }> }) {
  const maxReps = Math.max(...data.map(d => d.reps), 1);
  const barHeight = 24;
  const chartH = data.length * (barHeight + 8) + 8;

  return (
    <Svg width={CHART_WIDTH} height={chartH}>
      {data.map((d, i) => {
        const y = i * (barHeight + 8) + 4;
        const barW = Math.max(4, (d.reps / maxReps) * (CHART_WIDTH - 180));
        const displayName = (d.skill in SKILL_DISPLAY_NAMES ? SKILL_DISPLAY_NAMES[d.skill as keyof typeof SKILL_DISPLAY_NAMES] : d.skill);
        // Truncate long names
        const shortName = displayName.length > 16 ? displayName.slice(0, 14) + '..' : displayName;
        return (
          <React.Fragment key={d.skill}>
            <Rect x={130} y={y} width={barW} height={barHeight} fill={colors.accent.primary} rx={4} opacity={0.7} />
            <SvgText x={126} y={y + barHeight / 2 + 4} fontSize={10} fill={colors.text.secondary} textAnchor="end">{shortName}</SvgText>
            <SvgText x={134 + barW} y={y + barHeight / 2 + 4} fontSize={10} fill={colors.text.tertiary}>{d.reps} exercises</SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

function TokenUsageChart({ data }: { data: Array<{ date: string; tokens: number }> }) {
  const plotW = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const maxTokens = Math.max(...data.map(d => d.tokens), 1);
  const barW = Math.max(4, Math.min(20, plotW / data.length - 2));

  return (
    <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
      {data.map((d, i) => {
        const x = CHART_PADDING.left + (i / data.length) * plotW + barW / 2;
        const barH = (d.tokens / maxTokens) * plotH;
        const y = CHART_PADDING.top + plotH - barH;
        return (
          <Rect key={i} x={x} y={y} width={barW} height={barH} fill={colors.accent.warning} rx={2} opacity={0.7} />
        );
      })}
      <SvgText x={CHART_PADDING.left} y={CHART_HEIGHT - 4} fontSize={9} fill={colors.text.tertiary}>{formatDate(data[0].date)}</SvgText>
      <SvgText x={CHART_WIDTH - CHART_PADDING.right} y={CHART_HEIGHT - 4} fontSize={9} fill={colors.text.tertiary} textAnchor="end">{formatDate(data[data.length - 1].date)}</SvgText>
      <SvgText x={CHART_PADDING.left - 4} y={CHART_PADDING.top + 4} fontSize={9} fill={colors.text.tertiary} textAnchor="end">{formatTokens(maxTokens)}</SvgText>
    </Svg>
  );
}

// ── Helpers ──

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  content: { padding: spacing.xl },
  summaryRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.xl },
  summaryCard: {
    flex: 1, backgroundColor: colors.bg.card, padding: spacing.lg,
    borderRadius: borderRadius.md, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  summaryValue: { fontSize: fontSize.xxl, fontWeight: '700', color: colors.accent.secondary },
  summaryLabel: { fontSize: fontSize.xs, color: colors.text.secondary, marginTop: 4 },
  chartSection: { marginBottom: spacing.xl },
  chartTitle: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary, marginBottom: spacing.sm },
  errorText: { color: colors.accent.error, fontSize: fontSize.md },
  emptyState: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.md, textAlign: 'center' },
});
