// =============================================================================
// Skill service — cache skill data from School profile for progress bar display
// Updated once per agent loop cycle when the School profile is already fetched.
// =============================================================================

import { queryRows, query } from '../db/client';
import type { SkillSnapshot } from '@peerzero/shared';

interface SchoolSkillData {
  skill_key: string;
  strength: number;
  reliability: number;
  reps: number;
  streak: number;
  status: string; // 'verified' | 'developing' | 'untested'
}

/**
 * Upsert skill snapshots from the School profile.
 * Called after each agent loop cycle — we already have the profile, just cache the skills.
 */
export async function updateSkillSnapshots(botId: string, skills: SchoolSkillData[]): Promise<void> {
  if (!skills || skills.length === 0) return;

  // Batch upsert — one query for all skills
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const skill of skills) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(botId, skill.skill_key, skill.strength, skill.reliability, skill.reps, skill.streak, skill.status);
  }

  await query(
    `INSERT INTO bot_skill_snapshots (bot_id, skill_key, strength, reliability, reps, streak, status)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (bot_id, skill_key) DO UPDATE SET
       strength = EXCLUDED.strength,
       reliability = EXCLUDED.reliability,
       reps = EXCLUDED.reps,
       streak = EXCLUDED.streak,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    values,
  );
}

/**
 * Get cached skill snapshots for a bot (for BrainScreen progress bars).
 */
export async function getSkillSnapshots(botId: string): Promise<SkillSnapshot[]> {
  return queryRows<SkillSnapshot>(
    `SELECT skill_key, strength, reliability, reps, streak, status
     FROM bot_skill_snapshots
     WHERE bot_id = $1
     ORDER BY strength DESC
     LIMIT 50`,
    [botId],
  );
}
