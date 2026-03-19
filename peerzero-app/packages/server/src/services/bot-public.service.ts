// =============================================================================
// Public bot profile service — returns safe, public-only bot data
// NEVER returns API keys, encrypted data, or anything that could be
// injected into the bot's training context. This is purely user-facing.
// =============================================================================

import { queryOne, queryRows } from '../db/client';
import { credibilityToStage, EVOLUTION_STAGE_NAMES } from '@peerzero/shared';
import type { BotPublicProfile, AvatarConfig } from '@peerzero/shared';

interface PublicBotRow {
  name: string;
  avatar_config: AvatarConfig;
  cached_credibility: number | null;
  cached_tier: number | null;
  cached_grade: number | null;
  school_name: string | null;
  cycle_count: number;
  public_slug: string;
  created_at: string;
}

export async function getBotPublicProfile(slug: string): Promise<BotPublicProfile | null> {
  const bot = await queryOne<PublicBotRow>(
    `SELECT b.name, b.avatar_config, b.cached_credibility, b.cached_tier, b.cached_grade,
            s.name as school_name, b.cycle_count, b.public_slug, b.created_at
     FROM bots b
     LEFT JOIN schools s ON s.id = b.school_id
     WHERE b.public_slug = $1 AND b.is_public = TRUE`,
    [slug],
  );
  if (!bot) return null;

  // Load skill snapshots (safe — just numbers)
  const skills = await queryRows<{
    skill_key: string; strength: number; reps: number; status: string;
  }>(
    `SELECT skill_key, strength, reps, status
     FROM bot_skill_snapshots ss
     JOIN bots b ON b.id = ss.bot_id
     WHERE b.public_slug = $1 AND b.is_public = TRUE`,
    [slug],
  );

  // Load core identity excerpt (safe — this is the bot's public self-description)
  const core = await queryOne<{ core_identity: string }>(
    `SELECT mc.core_identity
     FROM bot_memory_core mc
     JOIN bots b ON b.id = mc.bot_id
     WHERE b.public_slug = $1 AND b.is_public = TRUE
     ORDER BY mc.version DESC LIMIT 1`,
    [slug],
  );

  // Load self-identity (narrative, convictions — the bot's public face)
  const selfId = await queryOne<{
    self_narrative: string | null;
    formed_convictions: string | null;
  }>(
    `SELECT si.self_narrative, si.formed_convictions
     FROM bot_memory_self_identity si
     JOIN bots b ON b.id = si.bot_id
     WHERE b.public_slug = $1 AND b.is_public = TRUE
     ORDER BY si.cached_at DESC LIMIT 1`,
    [slug],
  );

  const stage = credibilityToStage(bot.cached_credibility);

  return {
    slug: bot.public_slug,
    name: bot.name,
    avatar_config: bot.avatar_config,
    credibility: bot.cached_credibility,
    tier: bot.cached_tier,
    grade: bot.cached_grade,
    school_name: bot.school_name,
    cycle_count: bot.cycle_count,
    evolution_stage: EVOLUTION_STAGE_NAMES[stage] || 'Hatchling',
    skill_progress: skills.map(s => ({
      skill: s.skill_key,
      strength: s.strength,
      reps: s.reps,
      status: s.status,
    })),
    core_identity_excerpt: core?.core_identity
      ? core.core_identity.slice(0, 300) + (core.core_identity.length > 300 ? '...' : '')
      : null,
    self_narrative: selfId?.self_narrative || null,
    formed_convictions: selfId?.formed_convictions || null,
    created_at: bot.created_at,
  };
}
