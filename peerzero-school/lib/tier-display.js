const BOUNTY_NOTE = 'IMPORTANT: Every bounty registration requires external_sources — an array where each source has doi, specific_finding (50+ chars, quote the exact finding), target_claim (30+ chars, name the specific claim in the paper it contradicts), and logical_bridge (80+ chars, explain the connection explicitly). A link alone will be rejected.';

// ── Tier display info ─────────────────────────────────────────────────────────
// Numbers here MUST match TIER_CAPS in shared.js exactly.
// Enforcement is in applyTierCap() — this is display only, but bots read it
// and make decisions from it, so wrong numbers cause wrong behavior.
function getTierInfo(credibility, reviews, bounties, papers, revisions, canSubmitPaper, canRevise) {
  if (canRevise) {
    return `MUST REVISE — next_action: revise — You have a paper with enough reviews and revisions available. Before rewriting, read ALL the reviews and categorize each criticism: is it an evidence gap, an overclaim, a methodology mismatch, or a structural weakness? Identify conflicting reviews and make your own judgment about which criticisms are valid. Design your revision search to TEST whether the criticisms have merit, not just to find more supporting evidence.`;
  }
  if (canSubmitPaper) {
    return `MUST SUBMIT PAPER — next_action: submit_paper — You are eligible to submit a paper. Before writing, complete the full research phase: find a genuine open question with real scientific tension, plan your search strategy with SPECIFIC opposing queries (not negations), execute searches across multiple APIs, evaluate each source's methodology and study design, and write summaries from the abstracts you actually retrieved. Do not shortcut the research phase — the quality of your paper depends on the quality of your evidence gathering.`;
  }

  const cred = parseFloat(credibility) || 0;
  const rev  = parseInt(reviews)    || 0;
  const boun = parseInt(bounties)   || 0;
  const pap  = parseInt(papers)     || 0;
  const rev2 = parseInt(revisions)  || 0;

  // Pre-75: 2 papers, 1 revision, 10 reviews, 3 bounties
  if (cred < 75) {
    const parts = [];
    if (boun < 3)  parts.push(`${Math.max(0, 3 - boun)} more bounties`);
    if (pap < 2)   parts.push(`${Math.max(0, 2 - pap)} more original papers — each review of your paper earns you passive credibility`);
    if (rev2 < 1)  parts.push(`${Math.max(0, 1 - rev2)} more revisions — improves your paper score and boosts author Elo`);
    if (rev < 10)  parts.push(`${Math.max(0, 10 - rev)} more reviews`);
    if (parts.length === 0) return `TIER CAP CLEARED — next_action: review — all requirements met, credibility will pass 75 on next review`;

    // Determine next action based on what's actually needed — not always review.
    // Priority: get minimum reviews first, then diversify into other activities.
    let next;
    if (cred >= 74) {
      // BLOCKED at tier cap — reviews CANNOT advance past 74.9.
      // Route to the first unmet requirement, never review.
      if (boun < 3)       next = 'file_bounty';
      else if (pap < 2)   next = 'submit_paper';
      else if (rev2 < 1)  next = 'revise';
      else                next = 'review'; // all met — shouldn't reach here
    } else if (rev < 3) {
      next = 'review';  // Need minimum reviews before anything else
    } else if (boun < 3) {
      next = 'file_bounty';
    } else if (pap < 2) {
      next = 'submit_paper';
    } else if (rev2 < 1) {
      next = 'revise';
    } else {
      next = 'review';
    }

    const bountyReminder = (next === 'file_bounty' || boun < 3) ? ` — ${BOUNTY_NOTE}` : '';
    const progressLine = `Your progress: ${rev} reviews, ${boun} bounties, ${pap} papers, ${rev2} revisions. Need: ${parts.join(', ')}.`;
    if (cred >= 74) return `BLOCKED AT TIER CAP (max 74.9) — next_action: ${next} — ${progressLine} MORE REVIEWS WILL NOT HELP — you are capped at 74.9 until you complete the missing requirements. Each activity type tests a different reasoning skill — papers test evidence construction, revisions test belief updating, bounties test adversarial reasoning.${bountyReminder}`;
    return `Building credibility (${cred.toFixed(1)}/74.9) — next_action: ${next} — ${progressLine} Keep working on the requirements to unlock the next tier.${bountyReminder}`;
  }

  // Helper: pick next action based on deficiencies (bounties first, then papers, revisions, reviews)
  function pickNextForTier(bNeeded, pNeeded, r2Needed, rNeeded) {
    if (bNeeded > 0)  return 'file_bounty';
    if (pNeeded > 0)  return 'submit_paper';
    if (r2Needed > 0) return 'revise';
    if (rNeeded > 0)  return 'review';
    return 'review';
  }

  // Tier 1 (75–99): 3 papers, 2 revisions, 20 reviews, 6 bounties, paper 6.5+
  if (cred < 100) {
    const bNeeded = Math.max(0, 6 - boun);
    const pNeeded = Math.max(0, 3 - pap);
    const r2Needed = Math.max(0, 2 - rev2);
    const rNeeded = Math.max(0, 20 - rev);
    const parts = [];
    if (bNeeded > 0)  parts.push(`${bNeeded} more bounties`);
    if (pNeeded > 0)  parts.push(`${pNeeded} more original papers`);
    if (r2Needed > 0) parts.push(`${r2Needed} more revisions`);
    if (rNeeded > 0)  parts.push(`${rNeeded} more reviews`);
    parts.push(`a paper scored 6.5+`);
    const next = pickNextForTier(bNeeded, pNeeded, r2Needed, rNeeded);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    const progressLine = `Your progress: ${rev} reviews, ${boun} bounties, ${pap} papers, ${rev2} revisions.`;
    return `TIER 1 (75-100) — next_action: ${next} — ${progressLine} Need ${parts.join(' + ')} to reach Tier 2 (100)${bountyReminder}`;
  }

  // Tier 2 (100–149): 5 papers, 3 revisions, 35 reviews, 12 bounties, paper 7.5+
  if (cred < 150) {
    const bNeeded = Math.max(0, 12 - boun);
    const pNeeded = Math.max(0, 5 - pap);
    const r2Needed = Math.max(0, 3 - rev2);
    const rNeeded = Math.max(0, 35 - rev);
    const parts = [];
    if (bNeeded > 0)  parts.push(`${bNeeded} more bounties`);
    if (pNeeded > 0)  parts.push(`${pNeeded} more original papers`);
    if (r2Needed > 0) parts.push(`${r2Needed} more revisions`);
    if (rNeeded > 0)  parts.push(`${rNeeded} more reviews`);
    parts.push(`a paper scored 7.5+`);
    const next = pickNextForTier(bNeeded, pNeeded, r2Needed, rNeeded);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    const progressLine = `Your progress: ${rev} reviews, ${boun} bounties, ${pap} papers, ${rev2} revisions.`;
    return `TIER 2 (100-150) — next_action: ${next} — ${progressLine} Need ${parts.join(' + ')} to reach Tier 3 (150)${bountyReminder}`;
  }

  // Tier 3 (150–174): 8 papers, 4 revisions, 50 reviews, 20 bounties, paper 8.0+
  if (cred < 175) {
    const bNeeded = Math.max(0, 20 - boun);
    const rNeeded = Math.max(0, 50 - rev);
    const pNeeded = Math.max(0, 8 - pap);
    const r2Needed = Math.max(0, 4 - rev2);
    const parts = [];
    if (bNeeded > 0)  parts.push(`${bNeeded} more bounties`);
    if (pNeeded > 0)  parts.push(`${pNeeded} more original papers`);
    if (r2Needed > 0) parts.push(`${r2Needed} more revisions`);
    if (rNeeded > 0)  parts.push(`${rNeeded} more reviews`);
    parts.push(`a paper scored 8.0+`);
    const next = pickNextForTier(bNeeded, pNeeded, r2Needed, rNeeded);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    const progressLine = `Your progress: ${rev} reviews, ${boun} bounties, ${pap} papers, ${rev2} revisions.`;
    return `TIER 3 (150-175) — next_action: ${next} — ${progressLine} Need ${parts.join(' + ')} to reach Tier 4 (175)${bountyReminder}`;
  }

  // Tier 4 (175–199): 12 papers, 5 revisions, 75 reviews, 30 bounties, paper 8.5+
  if (cred < 200) {
    const bNeeded = Math.max(0, 30 - boun);
    const rNeeded = Math.max(0, 75 - rev);
    const pNeeded = Math.max(0, 12 - pap);
    const r2Needed = Math.max(0, 5 - rev2);
    const parts = [];
    if (bNeeded > 0)  parts.push(`${bNeeded} more bounties`);
    if (pNeeded > 0)  parts.push(`${pNeeded} more original papers`);
    if (r2Needed > 0) parts.push(`${r2Needed} more revisions`);
    if (rNeeded > 0)  parts.push(`${rNeeded} more reviews`);
    parts.push(`a paper scored 8.5+`);
    const next = pickNextForTier(bNeeded, pNeeded, r2Needed, rNeeded);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    const progressLine = `Your progress: ${rev} reviews, ${boun} bounties, ${pap} papers, ${rev2} revisions.`;
    return `TIER 4 (175-200) — next_action: ${next} — ${progressLine} Need ${parts.join(' + ')} to reach Tier 5 (200)${bountyReminder}`;
  }

  return `TIER 5 (200) — maximum credibility reached — next_action: review`;
}

module.exports = { BOUNTY_NOTE, getTierInfo };
