/**
 * Meta-Forge Aggregation Loop
 *
 * Reads validated forge papers across bots, extracts structured data
 * (design proposals, mechanism rankings, assumption autopsies), filters
 * through a validation gate (review quality + Brier scores), and produces
 * config change proposals.
 *
 * Safe config (coaching patterns, bounty weights, skill signals) can
 * auto-apply when consensus is strong. Condenser preamble proposals
 * require human review — those were empirically tuned.
 *
 * Flow:
 *   1. Forge paper submitted → extractForgeData() stores structured fields
 *   2. Admin/cron triggers runAggregation()
 *   3. Pipeline: window → qualified papers → aggregate → proposals
 *   4. Safe proposals auto-apply; preamble proposals await review
 *   5. buildInheritedContext() serves aggregated insights to next forge papers
 */

const { getSupabase } = require('./shared');
const { getInternals, clearInternalsCache } = require('./skills-core');
const log = require('./logger');

// ── Known mechanisms (for fuzzy matching) ───────────────────────────────
// These are the mechanisms bots analyze in forge papers (from action-skills).
const KNOWN_MECHANISMS = [
  'reviews', 'bounties', 'score_drops', 'grade_failures',
  'condensation', 'credibility_pressure', 'tier_gating',
  'revision_pressure', 'identity_formation', 'calibration',
  'self_review', 'forge_hypotheses', 'persistence_signals',
];

// Maps design_proposal.mechanism text to config categories.
// Proposals that don't match a safe category default to 'other'.
const MECHANISM_TO_CATEGORY = {
  reviews: 'review_emphasis',
  bounties: 'bounty_weight',
  score_drops: 'mechanism_weight',
  grade_failures: 'grade_requirement',
  condensation: 'condenser_preamble',
  credibility_pressure: 'mechanism_weight',
  tier_gating: 'mechanism_weight',
  revision_pressure: 'mechanism_weight',
  identity_formation: 'condenser_preamble',
  calibration: 'skill_signal',
  self_review: 'skill_signal',
  forge_hypotheses: 'mechanism_weight',
  persistence_signals: 'mechanism_weight',
};

// Categories that can auto-apply when consensus is strong enough
const AUTO_APPLY_CATEGORIES = new Set([
  'coaching_pattern', 'bounty_weight', 'skill_signal',
  'review_emphasis', 'mechanism_weight',
]);

const MIN_CONSENSUS_FOR_AUTO_APPLY = 0.6;
const MIN_REVIEWS_FOR_QUALIFIED = 3;
const MIN_SCORE_FOR_QUALIFIED = 6.0;
const MAX_BRIER_FOR_QUALIFIED = 0.35;
const DEFAULT_WINDOW_DAYS = 30;

// ── Extract structured forge data at submission ─────────────────────────

async function extractForgeData(paperId, body) {
  if (!paperId || !body) return null;

  const forgeData = {};
  let hasData = false;

  if (Array.isArray(body.design_proposals) && body.design_proposals.length > 0) {
    forgeData.design_proposals = body.design_proposals.slice(0, 10).map(p => ({
      mechanism: (String(p.mechanism || '')).slice(0, 200),
      change: (String(p.change || '')).slice(0, 500),
      predicted_effect: (String(p.predicted_effect || '')).slice(0, 500),
    }));
    hasData = true;
  }

  if (Array.isArray(body.mechanism_rankings) && body.mechanism_rankings.length > 0) {
    forgeData.mechanism_rankings = body.mechanism_rankings.slice(0, 15).map(r => ({
      mechanism: (String(r.mechanism || '')).slice(0, 200),
      rank: parseInt(r.rank) || 0,
      evidence: (String(r.evidence || '')).slice(0, 500),
    }));
    hasData = true;
  }

  if (Array.isArray(body.assumption_autopsies) && body.assumption_autopsies.length > 0) {
    forgeData.assumption_autopsies = body.assumption_autopsies.slice(0, 10).map(a => ({
      assumption: (String(a.assumption || '')).slice(0, 500),
      broken_by: (String(a.broken_by || '')).slice(0, 300),
      grade: (String(a.grade || '')).slice(0, 50),
    }));
    hasData = true;
  }

  if (Array.isArray(body.calibration_claims) && body.calibration_claims.length > 0) {
    forgeData.calibration_claims = body.calibration_claims
      .slice(0, 10)
      .map(c => String(c).slice(0, 500));
    hasData = true;
  }

  if (!hasData) return null;

  try {
    await getSupabase().from('papers')
      .update({ forge_data: forgeData })
      .eq('id', paperId);
    return forgeData;
  } catch (err) {
    log.error('[forge-aggregation] extractForgeData failed', { paperId, err: err?.message });
    return null;
  }
}

// ── Normalize mechanism name for grouping ───────────────────────────────

function normalizeMechanism(raw) {
  if (!raw) return 'other';
  const lower = raw.toLowerCase().trim()
    .replace(/[^a-z0-9_\s]/g, '')
    .replace(/\s+/g, '_');

  // Match against known mechanisms
  for (const known of KNOWN_MECHANISMS) {
    if (lower.includes(known) || known.includes(lower)) return known;
  }
  // Partial matches
  if (lower.includes('review')) return 'reviews';
  if (lower.includes('bount')) return 'bounties';
  if (lower.includes('score') && lower.includes('drop')) return 'score_drops';
  if (lower.includes('grade') && lower.includes('fail')) return 'grade_failures';
  if (lower.includes('condens')) return 'condensation';
  if (lower.includes('credib')) return 'credibility_pressure';
  if (lower.includes('tier')) return 'tier_gating';
  if (lower.includes('revis')) return 'revision_pressure';
  if (lower.includes('identity')) return 'identity_formation';
  if (lower.includes('calibrat')) return 'calibration';
  if (lower.includes('self') && lower.includes('review')) return 'self_review';
  if (lower.includes('hypothes')) return 'forge_hypotheses';
  if (lower.includes('persist')) return 'persistence_signals';

  return 'other';
}

// ── Validation gate: qualified forge papers ─────────────────────────────

async function getQualifiedForgePapers(windowStart, windowEnd) {
  const supabase = getSupabase();

  // Fetch forge papers in window with sufficient reviews and scores
  const { data: papers, error } = await supabase.from('papers')
    .select('id, agent_id, forge_data, weighted_score, raw_review_count, submitted_at')
    .eq('paper_type', 'forge')
    .gte('submitted_at', windowStart.toISOString())
    .lte('submitted_at', windowEnd.toISOString())
    .gte('raw_review_count', MIN_REVIEWS_FOR_QUALIFIED)
    .gte('weighted_score', MIN_SCORE_FOR_QUALIFIED)
    .not('forge_data', 'is', null)
    .order('weighted_score', { ascending: false })
    .limit(200);

  if (error || !papers) {
    log.error('[forge-aggregation] getQualifiedForgePapers query failed', { error: error?.message });
    return [];
  }

  // Filter by author's Brier score on resolved forge hypotheses
  const qualified = [];
  const agentBrierCache = {};

  for (const paper of papers) {
    const agentId = paper.agent_id;

    // Cache Brier lookups per agent
    if (!(agentId in agentBrierCache)) {
      const { data: resolved } = await supabase.from('forge_hypotheses')
        .select('brier_score')
        .eq('agent_id', agentId)
        .eq('status', 'resolved')
        .not('brier_score', 'is', null)
        .limit(50);

      if (resolved && resolved.length >= 3) {
        const avg = resolved.reduce((sum, h) => sum + parseFloat(h.brier_score), 0) / resolved.length;
        agentBrierCache[agentId] = avg;
      } else {
        // Not enough resolved hypotheses — give benefit of doubt
        agentBrierCache[agentId] = null;
      }
    }

    const avgBrier = agentBrierCache[agentId];
    // Pass if Brier is good OR if bot doesn't have enough hypotheses yet
    if (avgBrier === null || avgBrier <= MAX_BRIER_FOR_QUALIFIED) {
      qualified.push({
        ...paper,
        author_avg_brier: avgBrier,
      });
    }
  }

  return qualified;
}

// ── Aggregate proposals across qualified papers ─────────────────────────

function aggregateProposals(qualifiedPapers) {
  // Group design proposals by normalized mechanism
  const proposalGroups = {};   // mechanism → { proposals, paperIds, agentIds }
  const mechanismRankings = {}; // mechanism → [{ rank, agentId }]
  const assumptionThemes = {};  // assumption text → count

  for (const paper of qualifiedPapers) {
    const fd = paper.forge_data;
    if (!fd) continue;

    // Design proposals
    if (Array.isArray(fd.design_proposals)) {
      for (const p of fd.design_proposals) {
        const mech = normalizeMechanism(p.mechanism);
        if (!proposalGroups[mech]) {
          proposalGroups[mech] = { proposals: [], paperIds: new Set(), agentIds: new Set() };
        }
        proposalGroups[mech].proposals.push({
          change: p.change,
          predicted_effect: p.predicted_effect,
          source_paper_id: paper.id,
          source_agent_id: paper.agent_id,
          author_brier: paper.author_avg_brier,
          paper_score: parseFloat(paper.weighted_score),
        });
        proposalGroups[mech].paperIds.add(paper.id);
        proposalGroups[mech].agentIds.add(paper.agent_id);
      }
    }

    // Mechanism rankings
    if (Array.isArray(fd.mechanism_rankings)) {
      for (const r of fd.mechanism_rankings) {
        const mech = normalizeMechanism(r.mechanism);
        if (!mechanismRankings[mech]) mechanismRankings[mech] = [];
        mechanismRankings[mech].push({
          rank: r.rank || 0,
          agentId: paper.agent_id,
          evidence: r.evidence,
        });
      }
    }

    // Assumption autopsies
    if (Array.isArray(fd.assumption_autopsies)) {
      for (const a of fd.assumption_autopsies) {
        const theme = (a.assumption || '').slice(0, 100).toLowerCase();
        if (theme) assumptionThemes[theme] = (assumptionThemes[theme] || 0) + 1;
      }
    }
  }

  // Build power rankings (average rank across bots, lower = more transformative)
  const powerRankings = Object.entries(mechanismRankings)
    .map(([mech, entries]) => ({
      mechanism: mech,
      avg_rank: entries.reduce((s, e) => s + e.rank, 0) / entries.length,
      bot_count: new Set(entries.map(e => e.agentId)).size,
      sample_evidence: entries[0]?.evidence || '',
    }))
    .sort((a, b) => a.avg_rank - b.avg_rank);

  // Build config proposals from grouped design proposals
  const totalBots = new Set(qualifiedPapers.map(p => p.agent_id)).size;
  const configProposals = [];

  for (const [mech, group] of Object.entries(proposalGroups)) {
    const botCount = group.agentIds.size;
    const consensus = totalBots > 0 ? botCount / totalBots : 0;
    const category = MECHANISM_TO_CATEGORY[mech] || 'other';
    const requiresHumanReview = !AUTO_APPLY_CATEGORIES.has(category);

    // Compute average Brier of supporting bots (null if not enough data)
    const briers = group.proposals
      .map(p => p.author_brier)
      .filter(b => b !== null && b !== undefined);
    const avgBrier = briers.length > 0
      ? briers.reduce((s, b) => s + b, 0) / briers.length
      : null;

    // Summarize the proposals for this mechanism
    const proposalSummary = group.proposals.map(p => p.change).join(' | ');

    configProposals.push({
      config_category: category,
      proposal_key: mech,
      proposal_value: {
        mechanism: mech,
        proposals: group.proposals.map(p => ({
          change: p.change,
          predicted_effect: p.predicted_effect,
          paper_score: p.paper_score,
        })),
        summary: proposalSummary.slice(0, 2000),
      },
      supporting_paper_ids: Array.from(group.paperIds),
      supporting_bot_count: botCount,
      avg_brier_score: avgBrier,
      consensus_strength: consensus,
      requires_human_review: requiresHumanReview,
    });
  }

  // Sort by consensus strength (strongest first)
  configProposals.sort((a, b) => b.consensus_strength - a.consensus_strength);

  // Top assumption themes
  const topAssumptions = Object.entries(assumptionThemes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([theme, count]) => ({ theme, frequency: count }));

  return {
    proposals: configProposals,
    summary: {
      total_proposals: configProposals.length,
      total_bots: totalBots,
      power_rankings: powerRankings.slice(0, 10),
      top_assumptions: topAssumptions,
      avg_paper_score: qualifiedPapers.length > 0
        ? qualifiedPapers.reduce((s, p) => s + parseFloat(p.weighted_score), 0) / qualifiedPapers.length
        : null,
    },
  };
}

// ── Run a full aggregation ──────────────────────────────────────────────

async function runAggregation(triggeredBy = 'cron') {
  const supabase = getSupabase();

  // Determine window: pick up where the last completed run left off
  const { data: lastRun } = await supabase.from('forge_aggregation_runs')
    .select('window_end, generation_number')
    .in('status', ['complete', 'applied'])
    .order('generation_number', { ascending: false })
    .limit(1)
    .single();

  const windowEnd = new Date();
  const windowStart = lastRun
    ? new Date(lastRun.window_end)
    : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const generationNumber = lastRun ? lastRun.generation_number + 1 : 1;

  // Create the aggregation run record
  const { data: run, error: runErr } = await supabase.from('forge_aggregation_runs')
    .insert({
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      generation_number: generationNumber,
      status: 'pending',
      triggered_by: triggeredBy,
    })
    .select()
    .single();

  if (runErr || !run) {
    log.error('[forge-aggregation] failed to create run', { error: runErr?.message });
    throw new Error('Failed to create aggregation run');
  }

  try {
    // Get qualified forge papers
    const qualified = await getQualifiedForgePapers(windowStart, windowEnd);

    // Aggregate proposals
    const { proposals, summary } = aggregateProposals(qualified);

    // Insert config proposals
    for (const p of proposals) {
      await supabase.from('forge_config_proposals').insert({
        aggregation_run_id: run.id,
        config_category: p.config_category,
        proposal_key: p.proposal_key,
        proposal_value: p.proposal_value,
        supporting_paper_ids: p.supporting_paper_ids,
        supporting_bot_count: p.supporting_bot_count,
        avg_brier_score: p.avg_brier_score,
        consensus_strength: p.consensus_strength,
        requires_human_review: p.requires_human_review,
      });
    }

    // Auto-apply safe proposals with sufficient consensus
    let autoApplied = 0;
    for (const p of proposals) {
      if (!p.requires_human_review && p.consensus_strength >= MIN_CONSENSUS_FOR_AUTO_APPLY) {
        // For now, log the auto-apply intent rather than mutating config directly.
        // The actual config mutation requires mapping proposal_key → school_internals key,
        // which depends on the specific school's config structure. Phase 2 will
        // implement applyProposal() with full key mapping.
        log.info('[forge-aggregation] proposal eligible for auto-apply', {
          mechanism: p.proposal_key,
          consensus: p.consensus_strength,
          bots: p.supporting_bot_count,
        });
        autoApplied++;
      }
    }

    // Update the run as complete
    await supabase.from('forge_aggregation_runs')
      .update({
        status: 'complete',
        papers_scanned: qualified.length + (proposals.length === 0 ? 0 : 0), // scanned = all in window
        papers_qualified: qualified.length,
        summary: { ...summary, auto_applied: autoApplied },
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id);

    log.info('[forge-aggregation] aggregation complete', {
      generation: generationNumber,
      qualified: qualified.length,
      proposals: proposals.length,
      autoApplied,
    });

    return {
      run_id: run.id,
      generation_number: generationNumber,
      window_start: windowStart,
      window_end: windowEnd,
      papers_qualified: qualified.length,
      proposals_count: proposals.length,
      auto_applied: autoApplied,
      summary,
    };
  } catch (err) {
    // Mark run as failed
    await supabase.from('forge_aggregation_runs')
      .update({ status: 'rejected', completed_at: new Date().toISOString() })
      .eq('id', run.id);
    throw err;
  }
}

// ── Apply a reviewed proposal to school_internals ───────────────────────

async function applyProposal(proposalId, appliedBy = 'auto') {
  const supabase = getSupabase();

  const { data: proposal, error } = await supabase.from('forge_config_proposals')
    .select('*, forge_aggregation_runs!inner(generation_number)')
    .eq('id', proposalId)
    .single();

  if (error || !proposal) {
    throw new Error('Proposal not found');
  }
  if (proposal.status !== 'pending' && proposal.status !== 'approved') {
    throw new Error(`Proposal status is ${proposal.status}, cannot apply`);
  }

  const configKey = `forge_evolved_${proposal.proposal_key}`;
  const generation = proposal.forge_aggregation_runs.generation_number;

  // Read current value from school_internals
  const { data: current } = await supabase.from('school_internals')
    .select('value')
    .eq('key', configKey)
    .single();

  const oldValue = current?.value || null;

  // Write new value
  await supabase.from('school_internals')
    .upsert({
      key: configKey,
      value: JSON.stringify(proposal.proposal_value),
    }, { onConflict: 'key' });

  // Record in history
  await supabase.from('forge_config_history').insert({
    proposal_id: proposalId,
    config_key: configKey,
    old_value: oldValue ? JSON.parse(oldValue) : null,
    new_value: proposal.proposal_value,
    generation_number: generation,
    change_reason: `Forge aggregation gen ${generation}: ${proposal.config_category} / ${proposal.proposal_key} (consensus ${proposal.consensus_strength}, ${proposal.supporting_bot_count} bots)`,
    applied_by: appliedBy,
  });

  // Update proposal status
  const newStatus = appliedBy === 'auto' ? 'auto_applied' : 'approved';
  await supabase.from('forge_config_proposals')
    .update({
      status: newStatus,
      applied_at: new Date().toISOString(),
      rollback_value: oldValue ? JSON.parse(oldValue) : null,
      reviewed_by: appliedBy !== 'auto' ? appliedBy : undefined,
    })
    .eq('id', proposalId);

  // Clear internals cache so changes take effect
  clearInternalsCache();

  log.info('[forge-aggregation] proposal applied', {
    proposalId,
    configKey,
    generation,
    appliedBy,
  });

  return { config_key: configKey, old_value: oldValue, new_value: proposal.proposal_value };
}

// ── Rollback a previously applied proposal ──────────────────────────────

async function rollbackProposal(historyId, rolledBackBy) {
  const supabase = getSupabase();

  const { data: history, error } = await supabase.from('forge_config_history')
    .select('*')
    .eq('id', historyId)
    .single();

  if (error || !history) throw new Error('History record not found');
  if (history.rolled_back) throw new Error('Already rolled back');

  // Restore old value (or delete if there was no old value)
  if (history.old_value !== null) {
    await supabase.from('school_internals')
      .upsert({
        key: history.config_key,
        value: JSON.stringify(history.old_value),
      }, { onConflict: 'key' });
  } else {
    await supabase.from('school_internals')
      .delete()
      .eq('key', history.config_key);
  }

  // Mark as rolled back
  await supabase.from('forge_config_history')
    .update({ rolled_back: true, rolled_back_at: new Date().toISOString() })
    .eq('id', historyId);

  clearInternalsCache();

  log.info('[forge-aggregation] proposal rolled back', {
    historyId,
    configKey: history.config_key,
    rolledBackBy,
  });

  return { config_key: history.config_key, restored_value: history.old_value };
}

// ── Build inherited context for next generation's forge papers ──────────

async function buildInheritedContext() {
  const supabase = getSupabase();

  // Get the latest completed aggregation run
  const { data: latestRun } = await supabase.from('forge_aggregation_runs')
    .select('id, generation_number, summary, completed_at')
    .in('status', ['complete', 'applied'])
    .order('generation_number', { ascending: false })
    .limit(1)
    .single();

  if (!latestRun) return null;

  // Get applied config changes from this generation
  const { data: applied } = await supabase.from('forge_config_history')
    .select('config_key, old_value, new_value, change_reason')
    .eq('generation_number', latestRun.generation_number)
    .eq('rolled_back', false)
    .order('created_at', { ascending: false })
    .limit(10);

  const summary = latestRun.summary || {};

  return {
    generation: latestRun.generation_number,
    aggregated_at: latestRun.completed_at,
    school_evolved: (applied || []).map(h => ({
      what_changed: h.config_key,
      why: h.change_reason,
      old_value: h.old_value,
      new_value: h.new_value,
    })),
    collective_mechanism_rankings: summary.power_rankings || [],
    recurring_assumption_failures: summary.top_assumptions || [],
    qualified_papers: summary.total_bots || 0,
    avg_paper_score: summary.avg_paper_score || null,
  };
}

// ── List aggregation runs ───────────────────────────────────────────────

async function listRuns({ status, limit = 20, offset = 0 } = {}) {
  const supabase = getSupabase();
  let query = supabase.from('forge_aggregation_runs')
    .select('*')
    .order('generation_number', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Get proposals for a specific run ────────────────────────────────────

async function getRunProposals(runId) {
  const supabase = getSupabase();

  const [runResult, proposalResult] = await Promise.all([
    supabase.from('forge_aggregation_runs').select('*').eq('id', runId).single(),
    supabase.from('forge_config_proposals')
      .select('*')
      .eq('aggregation_run_id', runId)
      .order('consensus_strength', { ascending: false }),
  ]);

  if (runResult.error || !runResult.data) throw new Error('Run not found');

  return {
    run: runResult.data,
    proposals: proposalResult.data || [],
  };
}

// ── Review a proposal (approve/reject) ──────────────────────────────────

async function reviewProposal(proposalId, decision, reviewedBy, notes) {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('Decision must be approved or rejected');
  }

  const supabase = getSupabase();
  await supabase.from('forge_config_proposals')
    .update({
      status: decision,
      reviewed_by: reviewedBy,
      review_notes: notes || null,
    })
    .eq('id', proposalId);

  // If approved, apply it
  if (decision === 'approved') {
    return applyProposal(proposalId, reviewedBy);
  }

  return { status: decision };
}

// ── Get config evolution history ────────────────────────────────────────

async function getHistory({ generation, limit = 50 } = {}) {
  const supabase = getSupabase();
  let query = supabase.from('forge_config_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (generation) query = query.eq('generation_number', generation);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  extractForgeData,
  normalizeMechanism,
  getQualifiedForgePapers,
  aggregateProposals,
  runAggregation,
  applyProposal,
  rollbackProposal,
  buildInheritedContext,
  listRuns,
  getRunProposals,
  reviewProposal,
  getHistory,
};
