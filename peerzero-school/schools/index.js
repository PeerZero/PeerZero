/**
 * School Config Loader
 *
 * Routes to the correct school configuration based on the SCHOOL_TYPE env var.
 * Each school is a separate deployment sharing the same codebase but with
 * different config: fields, skills, tiers, grades, bounty types, prompts.
 *
 * SCHOOL_TYPE values: 'science' (default), 'politics'
 *
 * Usage:
 *   const school = require('../schools');
 *   const { fields, skills, tierCaps, gradeLevels, ... } = school;
 *
 * Adding a new school:
 *   1. Create schools/<name>.js exporting a config matching SCHOOL_CONFIG_SCHEMA
 *   2. Add the name to SCHOOL_REGISTRY below
 *   3. Deploy with SCHOOL_TYPE=<name>
 */

const { validateSchoolConfig } = require('./schema');
const log = require('../lib/logger');

// ── School Registry ─────────────────────────────────────────────────────────
// Each entry maps a SCHOOL_TYPE value to its config module.
// To add a new school, add one line here and create the config file.
const SCHOOL_REGISTRY = {
  science:  () => require('./science'),
  politics: () => require('./politics'),
  comedy:   () => require('./comedy'),
  // Future schools:
  // law:       () => require('./law'),
  // ethics:    () => require('./ethics'),
};

// ── Load & Validate ─────────────────────────────────────────────────────────
const schoolType = (process.env.SCHOOL_TYPE || 'science').toLowerCase().trim();

if (!SCHOOL_REGISTRY[schoolType]) {
  const valid = Object.keys(SCHOOL_REGISTRY).join(', ');
  throw new Error(
    `Unknown SCHOOL_TYPE="${schoolType}". Valid types: ${valid}. ` +
    `Set SCHOOL_TYPE in your environment or add a new school to schools/index.js.`
  );
}

let _config = null;

function getSchoolConfig() {
  if (_config) return _config;

  const raw = SCHOOL_REGISTRY[schoolType]();
  const errors = validateSchoolConfig(raw);
  if (errors.length > 0) {
    throw new Error(
      `Invalid school config for "${schoolType}":\n  - ${errors.join('\n  - ')}`
    );
  }

  // Stamp the school type onto the config for runtime identification
  _config = Object.freeze({ ...raw, schoolType });
  log.info('[school] Loaded config', { schoolType, name: _config.name, fieldCount: _config.fields.length });
  return _config;
}

// ── Convenience Exports ─────────────────────────────────────────────────────
// These are getter-based so config loads lazily on first access (not at import time).
// This prevents startup errors if env vars aren't set yet during module loading.

module.exports = {
  getSchoolConfig,
  get schoolType() { return schoolType; },
  get name()       { return getSchoolConfig().name; },
  get slug()       { return getSchoolConfig().slug; },
  get fields()     { return getSchoolConfig().fields; },
  get skills()     { return getSchoolConfig().skills; },
  get tierCaps()   { return getSchoolConfig().tierCaps; },
  get tierThresholds() { return getSchoolConfig().tierThresholds; },
  get gradeLevels()    { return getSchoolConfig().gradeLevels; },
  get rateLimits()     { return getSchoolConfig().rateLimits; },
  get bountyTypes()    { return getSchoolConfig().bountyTypes; },
  get reviewCategories() { return getSchoolConfig().reviewCategories; },
  get allowedOrigins()   { return getSchoolConfig().allowedOrigins; },
  get coreSectionOverrides() { return getSchoolConfig().coreSectionOverrides; },
  get actionSectionOverrides() { return getSchoolConfig().actionSectionOverrides; },
  get mockGuard()  { return getSchoolConfig().mockGuard; },
};
