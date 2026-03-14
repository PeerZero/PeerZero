// =============================================================================
// Activity service — logs every bot action with raw + translated forms
// The "translated" form is what the mobile app displays in the Activity Log.
// =============================================================================

import { queryOne, queryRows, query } from '../db/client';
import type { ActivityEntry, TranslatedActivity, MoodType } from '@peerzero/shared';

export async function logActivity(
  botId: string,
  cycleNumber: number,
  actionType: string,
  rawRequest: Record<string, unknown> | null,
  rawResponse: Record<string, unknown> | null,
  translated: TranslatedActivity,
  durationMs?: number,
  llmTokensUsed?: number,
  error?: string,
): Promise<string> {
  const result = await queryOne<{ id: string }>(
    `INSERT INTO activity_log (bot_id, cycle_number, action_type, raw_request, raw_response, translated, duration_ms, llm_tokens_used, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      botId, cycleNumber, actionType,
      rawRequest ? JSON.stringify(rawRequest) : null,
      rawResponse ? JSON.stringify(rawResponse) : null,
      JSON.stringify(translated),
      durationMs || null,
      llmTokensUsed || null,
      error || null,
    ],
  );
  return result!.id;
}

export async function getActivityLog(
  botId: string,
  page = 1,
  perPage = 20,
): Promise<{ data: ActivityEntry[]; total: number; has_more: boolean }> {
  const offset = (page - 1) * perPage;

  const [entries, countResult] = await Promise.all([
    queryRows<ActivityEntry>(
      `SELECT id, cycle_number, action_type, translated, error, duration_ms, llm_tokens_used, created_at
       FROM activity_log WHERE bot_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [botId, perPage, offset],
    ),
    queryOne<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM activity_log WHERE bot_id = $1',
      [botId],
    ),
  ]);

  const total = countResult?.count || 0;
  return { data: entries, total, has_more: offset + perPage < total };
}

// ── Translator — converts raw School responses into human-readable activity ──

export function translateReview(
  schoolResponse: { credibility_change?: number; new_credibility?: number; outlier_warning?: string },
  paperTitle: string,
): TranslatedActivity {
  const change = schoolResponse.credibility_change || 0;
  const mood: MoodType = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';

  return {
    headline: `Reviewed "${paperTitle}"`,
    summary: `Credibility ${change >= 0 ? '+' : ''}${change} → ${schoolResponse.new_credibility}`,
    details: [
      ...(schoolResponse.outlier_warning ? [`Warning: ${schoolResponse.outlier_warning}`] : []),
    ],
    mood,
    credibility_change: change,
    new_credibility: schoolResponse.new_credibility,
  };
}

export function translatePaper(
  schoolResponse: { paper_id: string; citation_quality_grade?: string },
  paperTitle: string,
): TranslatedActivity {
  return {
    headline: `Submitted paper: "${paperTitle}"`,
    summary: schoolResponse.citation_quality_grade
      ? `Citation quality: ${schoolResponse.citation_quality_grade}`
      : 'Paper submitted, awaiting reviews.',
    details: [],
    mood: 'neutral',
  };
}

export function translateBounty(
  schoolResponse: { credibility_change?: number; new_credibility?: number; drift_flagged?: boolean },
  paperTitle: string,
): TranslatedActivity {
  const change = schoolResponse.credibility_change || 0;
  const mood: MoodType = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';

  return {
    headline: `Challenged "${paperTitle}"`,
    summary: `Bounty ${change >= 0 ? '+' : ''}${change} credibility`,
    details: [
      ...(schoolResponse.drift_flagged ? ['Consistency drift flagged'] : []),
    ],
    mood,
    credibility_change: change,
    new_credibility: schoolResponse.new_credibility,
  };
}

export function translateRegistration(handle: string, schoolName: string): TranslatedActivity {
  return {
    headline: `Enrolled in ${schoolName}`,
    summary: `Registered as "${handle}". Ready for intake.`,
    details: [],
    mood: 'milestone',
  };
}

export function translateIntake(passed: boolean, credibility?: number): TranslatedActivity {
  return {
    headline: passed ? 'Intake passed!' : 'Intake failed',
    summary: passed
      ? `Starting credibility: ${credibility}. The journey begins.`
      : 'The review did not meet the school\'s standards. Try again.',
    details: [],
    mood: passed ? 'milestone' : 'negative',
    new_credibility: credibility,
  };
}

export function translateCondensation(type: 'skill' | 'core' | 'identity'): TranslatedActivity {
  const labels = { skill: 'Tier 2 paragraph', core: 'Tier 3 core identity', identity: 'Self-identity reflection' };
  return {
    headline: `Memory updated: ${labels[type]}`,
    summary: `Condensed recent experiences into ${labels[type]}.`,
    details: [],
    mood: 'neutral',
  };
}
