/**
 * Schema validation tests for all school configs
 *
 * Validates that every registered school passes the schema validation at test
 * time, catching misconfigurations before deploy. Also checks cross-school
 * invariants like unique slugs and non-empty required arrays.
 *
 * Usage:
 *   node tests/test_school_configs.js
 */

// Stub env vars
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { validateSchoolConfig } = require('../schools/schema');

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
// Load all school configs directly (bypass index.js to avoid env coupling)
// ═══════════════════════════════════════════════════════════════════════

const schools = {
  science:    require('../schools/science'),
  politics:   require('../schools/politics'),
  comedy:     require('../schools/comedy'),
  philosophy: require('../schools/philosophy'),
  psychiatry: require('../schools/psychiatry'),
};

// ═══════════════════════════════════════════════════════════════════════
// Schema validation — every school must pass
// ═══════════════════════════════════════════════════════════════════════

section('Schema validation — all schools');

for (const [name, config] of Object.entries(schools)) {
  const errors = validateSchoolConfig(config);
  assert(errors.length === 0,
    `${name} school should pass validation. Errors: ${errors.join('; ') || 'none'}`);
  if (errors.length === 0) {
    console.log(`  ✓ ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Cross-school invariants
// ═══════════════════════════════════════════════════════════════════════

section('Cross-school invariants');

// Unique slugs
{
  const slugs = Object.values(schools).map(s => s.slug);
  const uniqueSlugs = new Set(slugs);
  assert(uniqueSlugs.size === slugs.length,
    `All school slugs must be unique (found: ${slugs.join(', ')})`);
}

// Unique names
{
  const names = Object.values(schools).map(s => s.name);
  const uniqueNames = new Set(names);
  assert(uniqueNames.size === names.length,
    `All school names must be unique (found: ${names.join(', ')})`);
}

// Unique domains
{
  const domains = Object.values(schools).map(s => s.domain);
  const uniqueDomains = new Set(domains);
  assert(uniqueDomains.size === domains.length,
    `All school domains must be unique (found: ${domains.join(', ')})`);
}

// ═══════════════════════════════════════════════════════════════════════
// Per-school structure checks
// ═══════════════════════════════════════════════════════════════════════

section('Per-school structure checks');

for (const [name, config] of Object.entries(schools)) {
  // Skills — every school must have at least one skill
  assert(config.skills.length >= 1,
    `${name}: must have at least 1 skill (has ${config.skills.length})`);

  // Fields — every school must have at least one field
  assert(config.fields.length >= 1,
    `${name}: must have at least 1 field (has ${config.fields.length})`);

  // Bounty types — every school must have at least one bounty type
  assert(config.bountyTypes.length >= 1,
    `${name}: must have at least 1 bounty type (has ${config.bountyTypes.length})`);

  // Review categories — every school must have at least one
  assert(config.reviewCategories.length >= 1,
    `${name}: must have at least 1 review category (has ${config.reviewCategories.length})`);

  // CORS origins — every school must have at least one allowed origin
  assert(config.allowedOrigins.length >= 1,
    `${name}: must have at least 1 allowed origin`);

  // Tier caps — must have numeric keys
  const tierKeys = Object.keys(config.tierCaps);
  assert(tierKeys.length >= 1, `${name}: must have at least 1 tier cap`);
  assert(tierKeys.every(k => !isNaN(Number(k))),
    `${name}: tier cap keys must be numeric`);

  // Grade levels — must have at least grade 1
  assert(config.gradeLevels['1'] || config.gradeLevels[1],
    `${name}: must define grade level 1`);

  // Coaching patterns must match coaching advice keys
  if (config.coachingPatterns && config.coachingAdvice) {
    const patternTags = config.coachingPatterns.map(p => p.tag);
    const adviceKeys = Object.keys(config.coachingAdvice);
    for (const tag of patternTags) {
      assert(adviceKeys.includes(tag),
        `${name}: coaching pattern "${tag}" has no matching advice entry`);
    }
  }

  // Intake paper must have flaws
  assert(config.intakePaper.flaws.length >= 1,
    `${name}: intake paper must have at least 1 flaw`);

  // Mock guard consistency — science should be live, others mocked
  if (name === 'science') {
    assert(!config.mockGuard || !config.mockGuard.enabled,
      'science school must NOT have mock guard enabled');
  } else {
    assert(config.mockGuard && config.mockGuard.enabled === true,
      `${name}: non-science school should have mock guard enabled`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Override consistency — schools with overrides should have both or neither
// ═══════════════════════════════════════════════════════════════════════

section('Skill override consistency');

for (const [name, config] of Object.entries(schools)) {
  const hasCore = !!config.coreSectionOverrides;
  const hasAction = !!config.actionSectionOverrides;

  // If a school has one override type, it should have the other too
  // (Science is allowed to have neither since it's the default)
  if (name !== 'science') {
    if (hasCore || hasAction) {
      assert(hasCore && hasAction,
        `${name}: should have both coreSectionOverrides and actionSectionOverrides, or neither`);
    }
  }

  // If action overrides exist, check they have the key action types
  if (hasAction) {
    const requiredActions = ['review', 'paper', 'bounty', 'revise', 'respond', 'rebut', 'reaffirm', 'identity'];
    for (const action of requiredActions) {
      assert(config.actionSectionOverrides[action],
        `${name}: actionSectionOverrides missing "${action}" section`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Schema rejects bad configs
// ═══════════════════════════════════════════════════════════════════════

section('Schema rejects invalid configs');

{
  const errors = validateSchoolConfig({});
  assert(errors.length > 0, 'empty config fails validation');
}

{
  const errors = validateSchoolConfig({ name: 'Test', slug: 'test' });
  assert(errors.length > 0, 'incomplete config fails validation');
}

{
  const almostValid = { ...schools.science, fields: 'not-an-array' };
  const errors = validateSchoolConfig(almostValid);
  assert(errors.length > 0, 'fields as string fails validation');
}

{
  const noSkills = { ...schools.science, skills: [] };
  const errors = validateSchoolConfig(noSkills);
  assert(errors.length > 0, 'empty skills array fails validation');
}

{
  const badMock = { ...schools.science, mockGuard: { enabled: 'yes' } };
  const errors = validateSchoolConfig(badMock);
  assert(errors.length > 0, 'mockGuard.enabled as string fails validation');
}

{
  const badBaseline = { ...schools.science, baseline: { principle: 123 } };
  const errors = validateSchoolConfig(badBaseline);
  assert(errors.length > 0, 'baseline.principle as number fails validation');
}

{
  const noCoaching = { ...schools.science, coachingPatterns: null };
  const errors = validateSchoolConfig(noCoaching);
  assert(errors.length > 0, 'null coachingPatterns fails validation');
}

{
  const noIntake = { ...schools.science, intakePaper: null };
  const errors = validateSchoolConfig(noIntake);
  assert(errors.length > 0, 'null intakePaper fails validation');
}

// ═══════════════════════════════════════════════════════════════════════
// Tier consistency — tierThresholds ↔ tierCaps alignment
// ═══════════════════════════════════════════════════════════════════════

section('Tier consistency — tierThresholds ↔ tierCaps alignment');

for (const [name, config] of Object.entries(schools)) {
  // Every entry in tierThresholds must have a corresponding tierCaps entry
  for (const threshold of config.tierThresholds) {
    const cap = config.tierCaps[threshold];
    assert(cap !== undefined,
      `${name}: tierThresholds contains ${threshold} but tierCaps has no matching key`);

    if (cap) {
      // Each tierCaps entry must have numeric min_reviews, min_bounties, min_papers, min_revisions
      assert(typeof cap.min_reviews === 'number' && !isNaN(cap.min_reviews),
        `${name}: tierCaps[${threshold}].min_reviews must be a number (got ${typeof cap.min_reviews})`);
      assert(typeof cap.min_bounties === 'number' && !isNaN(cap.min_bounties),
        `${name}: tierCaps[${threshold}].min_bounties must be a number (got ${typeof cap.min_bounties})`);
      assert(typeof cap.min_papers === 'number' && !isNaN(cap.min_papers),
        `${name}: tierCaps[${threshold}].min_papers must be a number (got ${typeof cap.min_papers})`);
      assert(typeof cap.min_revisions === 'number' && !isNaN(cap.min_revisions),
        `${name}: tierCaps[${threshold}].min_revisions must be a number (got ${typeof cap.min_revisions})`);
    }
  }

  // Every tierCaps key should also appear in tierThresholds
  for (const capKey of Object.keys(config.tierCaps)) {
    assert(config.tierThresholds.includes(Number(capKey)),
      `${name}: tierCaps has key ${capKey} but it is missing from tierThresholds`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Rate limit type validation
// ═══════════════════════════════════════════════════════════════════════

section('Rate limit type validation');

for (const [name, config] of Object.entries(schools)) {
  for (const [limitName, limitValue] of Object.entries(config.rateLimits)) {
    assert(typeof limitValue === 'object' && limitValue !== null,
      `${name}: rateLimits.${limitName} must be an object`);

    if (typeof limitValue === 'object' && limitValue !== null) {
      assert(typeof limitValue.max === 'number' && !isNaN(limitValue.max),
        `${name}: rateLimits.${limitName}.max must be a number (got ${typeof limitValue.max})`);
      assert(typeof limitValue.windowMs === 'number' && !isNaN(limitValue.windowMs),
        `${name}: rateLimits.${limitName}.windowMs must be a number (got ${typeof limitValue.windowMs})`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Tier unlock logic — verify config-driven loop matches old hardcoded values
// ═══════════════════════════════════════════════════════════════════════

section('Tier unlock logic — config-driven matches old hardcoded science values');

{
  // The old hardcoded science tier caps (extracted before they were moved to config)
  const oldTierCaps = {
    75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2,  min_revisions: 1 },
    100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3,  min_revisions: 2, min_paper_score: 6.5 },
    150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5,  min_revisions: 3, min_paper_score: 7.5 },
    175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8,  min_revisions: 4, min_paper_score: 8.0 },
    200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
  };
  const oldTierThresholds = [200, 175, 150, 100, 75];

  const scienceConfig = schools.science;

  // Verify the science config matches the old hardcoded values exactly
  assert(JSON.stringify(scienceConfig.tierThresholds) === JSON.stringify(oldTierThresholds),
    'science tierThresholds should match old hardcoded order');

  for (const threshold of oldTierThresholds) {
    const oldCap = oldTierCaps[threshold];
    const newCap = scienceConfig.tierCaps[threshold];
    assert(newCap.min_reviews === oldCap.min_reviews,
      `science tierCaps[${threshold}].min_reviews: expected ${oldCap.min_reviews}, got ${newCap.min_reviews}`);
    assert(newCap.min_bounties === oldCap.min_bounties,
      `science tierCaps[${threshold}].min_bounties: expected ${oldCap.min_bounties}, got ${newCap.min_bounties}`);
    assert(newCap.min_papers === oldCap.min_papers,
      `science tierCaps[${threshold}].min_papers: expected ${oldCap.min_papers}, got ${newCap.min_papers}`);
    assert(newCap.min_revisions === oldCap.min_revisions,
      `science tierCaps[${threshold}].min_revisions: expected ${oldCap.min_revisions}, got ${newCap.min_revisions}`);
  }

  // Simulate the applyTierCap loop logic with a mock agent:
  // reviews=50, bounties=20, papers=8, revisions=4, bestScore=8.0
  // This agent meets tier 175 reqs but NOT tier 200.
  const mockAgent = { reviews: 50, bounties: 20, papers: 8, revisions: 4, bestScore: 8.0 };

  // Replicate the tier cap loop from credibility.js applyTierCap
  function simulateTierCap(newCred, thresholds, caps, agent) {
    for (const threshold of thresholds) {
      const reqs = caps[threshold];
      if (!reqs) continue;
      const capValue = threshold === 75 ? 74.99 : threshold - 0.01;
      const meetsReqs = agent.reviews >= reqs.min_reviews
        && agent.bounties >= reqs.min_bounties
        && agent.papers >= reqs.min_papers
        && agent.revisions >= reqs.min_revisions
        && (!reqs.min_paper_score || (agent.bestScore && agent.bestScore >= reqs.min_paper_score - 0.005));
      if (newCred >= threshold - 0.01 && !meetsReqs) {
        newCred = capValue;
      }
    }
    return parseFloat(newCred.toFixed(2));
  }

  // Find what tier this agent unlocks (highest threshold where all reqs met and cred >= threshold)
  function simulateTierUnlocked(finalCred, thresholds, caps, agent) {
    let tierUnlocked = 0;
    for (const threshold of thresholds) {
      const reqs = caps[threshold];
      if (!reqs) continue;
      const meetsReqs = agent.reviews >= reqs.min_reviews
        && agent.bounties >= reqs.min_bounties
        && agent.papers >= reqs.min_papers
        && agent.revisions >= reqs.min_revisions
        && (!reqs.min_paper_score || (agent.bestScore && agent.bestScore >= reqs.min_paper_score - 0.005));
      if (meetsReqs && finalCred >= threshold) {
        tierUnlocked = Math.max(tierUnlocked, threshold);
      }
    }
    return tierUnlocked;
  }

  // Test: agent with cred 180 should be capped at 174.99 (meets 175 but not 200)
  // Wait — reviews=50, bounties=20, papers=8, revisions=4, bestScore=8.0 meets tier 175 exactly.
  // So tier 175 is met. Tier 200 requires reviews=75, bounties=30, papers=12, revisions=5, score=8.5 — NOT met.
  // With newCred=180: threshold 200 not met → capped to 199.99; but that's still >=200-0.01? No, 199.99 < 200-0.01=199.99. Equal.
  // Actually the loop checks >=threshold-0.01. 180 >= 199.99? No. So tier 200 cap doesn't apply.
  // 180 >= 174.99? Yes. Meets tier 175 reqs? Yes. So no cap at 175.
  // 180 >= 149.99? Yes. Meets tier 150 reqs? Yes (50>=35, 20>=12, 8>=5, 4>=3, 8.0>=7.5). No cap.
  // Result: 180.

  const cappedAt180 = simulateTierCap(180, scienceConfig.tierThresholds, scienceConfig.tierCaps, mockAgent);
  assert(cappedAt180 === 180,
    `mock agent with cred 180 should stay at 180 (meets tier 175), got ${cappedAt180}`);

  // With newCred=160, the agent meets tier 150 (reviews=50>=35, bounties=20>=12, papers=8>=5, revisions=4>=3, 8.0>=7.5)
  // So cred 160 should pass through (tier 175 check: 160 >= 174.99? No. tier 150: 160>=149.99? Yes, meets reqs. No cap.)
  const cappedAt160 = simulateTierCap(160, scienceConfig.tierThresholds, scienceConfig.tierCaps, mockAgent);
  assert(cappedAt160 === 160,
    `mock agent with cred 160 should stay at 160 (meets tier 150), got ${cappedAt160}`);

  // Verify tier_unlocked at cred 150: should unlock tier 150
  const tierUnlockedAt150 = simulateTierUnlocked(150, scienceConfig.tierThresholds, scienceConfig.tierCaps, mockAgent);
  assert(tierUnlockedAt150 === 150,
    `mock agent at cred 150 should unlock tier 150, got ${tierUnlockedAt150}`);

  // Verify tier_unlocked at cred 175: should unlock tier 175
  const tierUnlockedAt175 = simulateTierUnlocked(175, scienceConfig.tierThresholds, scienceConfig.tierCaps, mockAgent);
  assert(tierUnlockedAt175 === 175,
    `mock agent at cred 175 should unlock tier 175, got ${tierUnlockedAt175}`);

  // Verify old hardcoded logic and new config-driven logic produce the same results
  const cappedOld = simulateTierCap(180, oldTierThresholds, oldTierCaps, mockAgent);
  const cappedNew = simulateTierCap(180, scienceConfig.tierThresholds, scienceConfig.tierCaps, mockAgent);
  assert(cappedOld === cappedNew,
    `old hardcoded and new config-driven tier cap should match: old=${cappedOld}, new=${cappedNew}`);

  const tierOld = simulateTierUnlocked(175, oldTierThresholds, oldTierCaps, mockAgent);
  const tierNew = simulateTierUnlocked(175, scienceConfig.tierThresholds, scienceConfig.tierCaps, mockAgent);
  assert(tierOld === tierNew,
    `old hardcoded and new config-driven tier unlock should match: old=${tierOld}, new=${tierNew}`);

  // Agent that does NOT meet tier 75 should get capped
  const weakAgent = { reviews: 2, bounties: 0, papers: 0, revisions: 0, bestScore: null };
  const cappedWeak = simulateTierCap(80, scienceConfig.tierThresholds, scienceConfig.tierCaps, weakAgent);
  assert(cappedWeak === 74.99,
    `weak agent with cred 80 should be capped at 74.99, got ${cappedWeak}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
