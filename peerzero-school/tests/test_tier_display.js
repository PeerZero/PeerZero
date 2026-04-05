/**
 * Unit tests for lib/tier-display.js
 *
 * Tests tier display logic, next-action routing, and tier boundary behavior.
 * No database required — pure function tests.
 *
 * Usage:
 *   node tests/test_tier_display.js
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { getTierInfo, BOUNTY_NOTE } = require('../lib/tier-display');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ═══════════════════════════════════════════════════════════════════════
// BOUNTY_NOTE export
// ═══════════════════════════════════════════════════════════════════════

section('BOUNTY_NOTE');

assert(typeof BOUNTY_NOTE === 'string', 'BOUNTY_NOTE is a string');
assert(BOUNTY_NOTE.includes('external_sources'), 'BOUNTY_NOTE mentions external_sources');
assert(BOUNTY_NOTE.includes('doi'), 'BOUNTY_NOTE mentions doi');

// ═══════════════════════════════════════════════════════════════════════
// canRevise override — always returns MUST REVISE
// ═══════════════════════════════════════════════════════════════════════

section('canRevise override');

const reviseResult = getTierInfo(50, 0, 0, 0, 0, false, true);
assert(reviseResult.startsWith('MUST REVISE'), 'canRevise=true returns MUST REVISE');
assert(reviseResult.includes('next_action: revise'), 'canRevise sets next_action to revise');

// canRevise overrides even at high credibility
const reviseHighCred = getTierInfo(200, 100, 50, 20, 10, false, true);
assert(reviseHighCred.startsWith('MUST REVISE'), 'canRevise overrides even at tier 5');

// ═══════════════════════════════════════════════════════════════════════
// canSubmitPaper override — always returns MUST SUBMIT PAPER
// ═══════════════════════════════════════════════════════════════════════

section('canSubmitPaper override');

const submitResult = getTierInfo(50, 0, 0, 0, 0, true, false);
assert(submitResult.startsWith('MUST SUBMIT PAPER'), 'canSubmitPaper=true returns MUST SUBMIT PAPER');
assert(submitResult.includes('next_action: submit_paper'), 'canSubmitPaper sets next_action to submit_paper');

// canRevise takes priority over canSubmitPaper
const bothResult = getTierInfo(50, 0, 0, 0, 0, true, true);
assert(bothResult.startsWith('MUST REVISE'), 'canRevise takes priority over canSubmitPaper');

// ═══════════════════════════════════════════════════════════════════════
// Pre-75 tier: building credibility
// ═══════════════════════════════════════════════════════════════════════

section('Pre-75 tier');

// Fresh bot — needs everything
const fresh = getTierInfo(0, 0, 0, 0, 0, false, false);
assert(fresh.includes('next_action: review'), 'fresh bot starts with review');
assert(fresh.includes('bounties'), 'fresh bot needs bounties');
assert(fresh.includes('papers'), 'fresh bot needs papers');
assert(fresh.includes('reviews'), 'fresh bot needs reviews');
assert(fresh.includes('revisions'), 'fresh bot needs revisions');

// Bot with enough reviews but missing other reqs — routes to bounty
const hasReviews = getTierInfo(50, 5, 0, 0, 0, false, false);
assert(hasReviews.includes('next_action: file_bounty'), 'bot with enough reviews routes to file_bounty');

// Bot with reviews and bounties but missing papers
const hasBounties = getTierInfo(50, 5, 3, 0, 0, false, false);
assert(hasBounties.includes('next_action: submit_paper'), 'bot with reviews+bounties routes to submit_paper');

// Bot with reviews, bounties, papers but missing revisions
const hasPapers = getTierInfo(50, 5, 3, 2, 0, false, false);
assert(hasPapers.includes('next_action: revise'), 'bot missing revisions routes to revise');

// Bot with all reqs met
const allMet = getTierInfo(50, 10, 3, 2, 1, false, false);
assert(allMet.includes('next_action: review'), 'bot with all reqs routes to review');

// ═══════════════════════════════════════════════════════════════════════
// Blocked at tier cap (cred >= 74)
// ═══════════════════════════════════════════════════════════════════════

section('Blocked at tier cap');

// Bot at 74 missing bounties — BLOCKED, routes to file_bounty
const blocked = getTierInfo(74, 10, 0, 2, 1, false, false);
assert(blocked.includes('BLOCKED AT TIER CAP'), 'cred=74 with missing reqs shows BLOCKED');
assert(blocked.includes('next_action: file_bounty'), 'blocked bot missing bounties routes to file_bounty');
assert(blocked.includes('MORE REVIEWS WILL NOT HELP'), 'blocked message warns reviews wont help');

// Bot at 74 missing only papers
const blockedPapers = getTierInfo(74, 10, 3, 0, 1, false, false);
assert(blockedPapers.includes('next_action: submit_paper'), 'blocked bot missing papers routes to submit_paper');

// Bot at 74 missing only revisions
const blockedRevisions = getTierInfo(74, 10, 3, 2, 0, false, false);
assert(blockedRevisions.includes('next_action: revise'), 'blocked bot missing revisions routes to revise');

// Bot at 74 with all reqs met — should clear
const blockedCleared = getTierInfo(74, 10, 3, 2, 1, false, false);
assert(blockedCleared.includes('TIER CAP CLEARED'), 'cred=74 with all reqs shows TIER CAP CLEARED');

// ═══════════════════════════════════════════════════════════════════════
// Tier 1 (75–99)
// ═══════════════════════════════════════════════════════════════════════

section('Tier 1 (75-99)');

const tier1 = getTierInfo(80, 5, 2, 1, 0, false, false);
assert(tier1.includes('TIER 1'), 'cred=80 shows TIER 1');
assert(tier1.includes('75-100'), 'tier 1 shows range');
assert(tier1.includes('6.5+'), 'tier 1 mentions paper score 6.5+');

// Next action routing in tier 1
const tier1NeedsBounties = getTierInfo(80, 20, 2, 3, 2, false, false);
assert(tier1NeedsBounties.includes('next_action: file_bounty'), 'tier 1 missing bounties routes to file_bounty');

const tier1NeedsPapers = getTierInfo(80, 20, 6, 1, 2, false, false);
assert(tier1NeedsPapers.includes('next_action: submit_paper'), 'tier 1 missing papers routes to submit_paper');

// ═══════════════════════════════════════════════════════════════════════
// Tier 2 (100–149)
// ═══════════════════════════════════════════════════════════════════════

section('Tier 2 (100-149)');

const tier2 = getTierInfo(120, 20, 6, 3, 2, false, false);
assert(tier2.includes('TIER 2'), 'cred=120 shows TIER 2');
assert(tier2.includes('100-150'), 'tier 2 shows range');
assert(tier2.includes('7.5+'), 'tier 2 mentions paper score 7.5+');

// ═══════════════════════════════════════════════════════════════════════
// Tier 3 (150–174)
// ═══════════════════════════════════════════════════════════════════════

section('Tier 3 (150-174)');

const tier3 = getTierInfo(160, 35, 12, 5, 3, false, false);
assert(tier3.includes('TIER 3'), 'cred=160 shows TIER 3');
assert(tier3.includes('150-175'), 'tier 3 shows range');
assert(tier3.includes('8.0+'), 'tier 3 mentions paper score 8.0+');

// ═══════════════════════════════════════════════════════════════════════
// Tier 4 (175–199)
// ═══════════════════════════════════════════════════════════════════════

section('Tier 4 (175-199)');

const tier4 = getTierInfo(185, 50, 20, 8, 4, false, false);
assert(tier4.includes('TIER 4'), 'cred=185 shows TIER 4');
assert(tier4.includes('175-200'), 'tier 4 shows range');
assert(tier4.includes('8.5+'), 'tier 4 mentions paper score 8.5+');

// ═══════════════════════════════════════════════════════════════════════
// Tier 5 (200+)
// ═══════════════════════════════════════════════════════════════════════

section('Tier 5 (200+)');

const tier5 = getTierInfo(200, 100, 50, 20, 10, false, false);
assert(tier5.includes('TIER 5'), 'cred=200 shows TIER 5');
assert(tier5.includes('maximum credibility'), 'tier 5 says maximum credibility');

const tier5High = getTierInfo(999, 100, 50, 20, 10, false, false);
assert(tier5High.includes('TIER 5'), 'cred=999 still shows TIER 5');

// ═══════════════════════════════════════════════════════════════════════
// Input coercion — strings, null, undefined
// ═══════════════════════════════════════════════════════════════════════

section('Input coercion');

const stringInputs = getTierInfo('50', '5', '3', '2', '1', false, false);
assert(stringInputs.includes('next_action:'), 'string inputs are coerced to numbers');

const nullInputs = getTierInfo(null, null, null, null, null, false, false);
assert(nullInputs.includes('next_action:'), 'null inputs treated as 0');

const undefinedInputs = getTierInfo(undefined, undefined, undefined, undefined, undefined, false, false);
assert(undefinedInputs.includes('next_action:'), 'undefined inputs treated as 0');

// ═══════════════════════════════════════════════════════════════════════
// Bounty reminder presence
// ═══════════════════════════════════════════════════════════════════════

section('Bounty reminder');

// Bot that needs bounties should get the BOUNTY_NOTE
const needsBounty = getTierInfo(50, 5, 0, 2, 1, false, false);
assert(needsBounty.includes('external_sources'), 'bot needing bounties gets bounty reminder');

// Bot that has enough bounties should NOT get the full reminder
const hasBountiesFull = getTierInfo(80, 20, 6, 3, 2, false, false);
assert(!hasBountiesFull.includes('external_sources'), 'bot with enough bounties has no bounty reminder');

// ═══════════════════════════════════════════════════════════════════════
// Tier boundaries — exact boundary values
// ═══════════════════════════════════════════════════════════════════════

section('Tier boundaries');

const at74 = getTierInfo(74, 0, 0, 0, 0, false, false);
assert(at74.includes('BLOCKED') || at74.includes('Building'), 'cred=74 is still pre-75');
assert(!at74.includes('TIER 1'), 'cred=74 is NOT tier 1');

const at75 = getTierInfo(75, 0, 0, 0, 0, false, false);
assert(at75.includes('TIER 1'), 'cred=75 is tier 1');

const at99 = getTierInfo(99, 0, 0, 0, 0, false, false);
assert(at99.includes('TIER 1'), 'cred=99 is still tier 1');

const at100 = getTierInfo(100, 0, 0, 0, 0, false, false);
assert(at100.includes('TIER 2'), 'cred=100 is tier 2');

const at149 = getTierInfo(149, 0, 0, 0, 0, false, false);
assert(at149.includes('TIER 2'), 'cred=149 is still tier 2');

const at150 = getTierInfo(150, 0, 0, 0, 0, false, false);
assert(at150.includes('TIER 3'), 'cred=150 is tier 3');

const at174 = getTierInfo(174, 0, 0, 0, 0, false, false);
assert(at174.includes('TIER 3'), 'cred=174 is still tier 3');

const at175 = getTierInfo(175, 0, 0, 0, 0, false, false);
assert(at175.includes('TIER 4'), 'cred=175 is tier 4');

const at199 = getTierInfo(199, 0, 0, 0, 0, false, false);
assert(at199.includes('TIER 4'), 'cred=199 is still tier 4');

const at200 = getTierInfo(200, 0, 0, 0, 0, false, false);
assert(at200.includes('TIER 5'), 'cred=200 is tier 5');

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
