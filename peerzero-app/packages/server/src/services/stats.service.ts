// =============================================================================
// Stats service — aggregates bot performance data from activity_log
//
// Design decision: derive all stats from the existing activity_log table rather
// than maintaining a separate snapshots table. At scale (millions of users),
// the partial indexes and date-range queries keep this performant. If query
// latency becomes an issue, we can add materialized views or a snapshots table
// later without changing the API contract.
// =============================================================================

import { queryRows, queryOne } from '../db/client';
import type { BotStats } from '@peerzero/shared';

export async function getBotStats(botId: string, days = 30): Promise<BotStats> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Run all queries in parallel for speed
  const [credHistory, actionBreakdown, skillProgress, tokenTrend, totals] = await Promise.all([
    // Credibility over time: extract from translated JSONB
    queryRows<{ date: string; value: number }>(
      `SELECT DATE(created_at) as date,
              MAX((translated->>'new_credibility')::numeric) as value
       FROM activity_log
       WHERE bot_id = $1
         AND created_at >= $2
         AND translated->>'new_credibility' IS NOT NULL
         AND category = 'task'
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [botId, cutoff],
    ),

    // Action breakdown (all-time, excludes deleted)
    queryRows<{ action_type: string; count: number }>(
      `SELECT action_type, COUNT(*)::int as count
       FROM activity_log
       WHERE bot_id = $1 AND deleted_at IS NULL AND category = 'task'
       GROUP BY action_type
       ORDER BY count DESC`,
      [botId],
    ),

    // Skill progress: extract from raw_response JSONB skill_exercises
    // This is a best-effort extraction; real skill data comes from the School
    queryRows<{ skill: string; strength: number; reps: number }>(
      `SELECT DISTINCT ON (key)
              key as skill,
              0 as strength,
              COUNT(*)::int OVER (PARTITION BY key) as reps
       FROM activity_log,
            LATERAL jsonb_object_keys(COALESCE(raw_response->'skill_exercises', '{}')) as key
       WHERE bot_id = $1
         AND raw_response->'skill_exercises' IS NOT NULL
         AND category = 'task'
       ORDER BY key`,
      [botId],
    ).catch(() => []), // Graceful fallback if JSONB structure varies

    // Token usage trend (daily, within date range)
    queryRows<{ date: string; tokens: number }>(
      `SELECT DATE(created_at) as date,
              SUM(COALESCE(llm_tokens_used, 0))::int as tokens
       FROM activity_log
       WHERE bot_id = $1
         AND created_at >= $2
         AND category = 'task'
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [botId, cutoff],
    ),

    // Totals
    queryOne<{ total_cycles: number; total_tokens: number }>(
      `SELECT COUNT(*)::int as total_cycles,
              SUM(COALESCE(llm_tokens_used, 0))::int as total_tokens
       FROM activity_log
       WHERE bot_id = $1 AND category = 'task'`,
      [botId],
    ),
  ]);

  return {
    credibility_history: credHistory,
    action_breakdown: actionBreakdown,
    skill_progress: skillProgress,
    token_usage_trend: tokenTrend,
    total_cycles: totals?.total_cycles || 0,
    total_tokens: totals?.total_tokens || 0,
  };
}
