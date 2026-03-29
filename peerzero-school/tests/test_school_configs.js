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
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
