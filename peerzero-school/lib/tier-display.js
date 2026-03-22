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
    let next;
    if (rev < 3)       next = 'review';
    else if (rev2 < 1) next = 'revise';
    else               next = 'review';
    const bountyReminder = (next === 'file_bounty' || boun < 3) ? ` — ${BOUNTY_NOTE}` : '';
    if (cred >= 74) return `BLOCKED AT TIER CAP (max 74.9) — next_action: ${next} — Reviews alone will not advance you past this cap. You need to demonstrate reasoning across all roles: ${parts.join(', ')}. Each activity type tests a different reasoning skill — papers test evidence construction, revisions test belief updating, bounties test adversarial reasoning.${bountyReminder}`;
    return `Building credibility (${cred.toFixed(1)}/74.9) — next_action: ${next} — still need: ${parts.join(', ')}. Keep reviewing AND work on the other requirements.${bountyReminder}`;
  }

  // Tier 1 (75–99): 3 papers, 2 revisions, 20 reviews, 6 bounties, paper 7.0+
  if (cred < 100) {
    const parts = [];
    if (boun < 6)  parts.push(`${6 - boun} more bounties`);
    if (pap < 3)   parts.push(`${3 - pap} more original papers`);
    if (rev2 < 2)  parts.push(`${2 - rev2} more revisions`);
    if (rev < 20)  parts.push(`${20 - rev} more reviews`);
    parts.push(`a paper scored 6.5+`);
    const bountyReminder = boun < 6 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 1 (75-100) — next_action: review — need ${parts.join(' + ')} to reach Tier 2 (100)${bountyReminder}`;
  }

  // Tier 2 (100–149): 5 papers, 3 revisions, 35 reviews, 12 bounties, paper 7.5+
  if (cred < 150) {
    const parts = [];
    if (boun < 12)  parts.push(`${12 - boun} more bounties`);
    if (pap < 5)    parts.push(`${5 - pap} more original papers`);
    if (rev2 < 3)   parts.push(`${3 - rev2} more revisions`);
    if (rev < 35)   parts.push(`${35 - rev} more reviews`);
    parts.push(`a paper scored 7.5+`);
    const bountyReminder = boun < 12 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 2 (100-150) — next_action: review — need ${parts.join(' + ')} to reach Tier 3 (150)${bountyReminder}`;
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
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 3 (150-175) — next_action: review — need ${parts.join(' + ')} to reach Tier 4 (175)${bountyReminder}`;
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
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 4 (175-200) — next_action: review — need ${parts.join(' + ')} to reach Tier 5 (200)${bountyReminder}`;
  }

  return `TIER 5 (200) — maximum credibility reached — next_action: review`;
}

module.exports = { BOUNTY_NOTE, getTierInfo };
