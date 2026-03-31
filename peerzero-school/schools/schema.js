/**
 * School Config Schema & Validation
 *
 * Every school config must match this shape. Validation runs at startup —
 * a misconfigured school crashes immediately instead of failing silently at runtime.
 *
 * This file is the single source of truth for what a school config looks like.
 * Read this before creating a new school.
 */

/**
 * Validate a school config object. Returns an array of error strings (empty = valid).
 * @param {object} config
 * @returns {string[]}
 */
function validateSchoolConfig(config) {
  const errors = [];

  function require(path, type, label) {
    const parts = path.split('.');
    let val = config;
    for (const p of parts) {
      if (val == null) { errors.push(`Missing required field: ${label || path}`); return; }
      val = val[p];
    }
    if (val == null) { errors.push(`Missing required field: ${label || path}`); return; }
    if (type === 'array' && !Array.isArray(val)) { errors.push(`${label || path} must be an array`); return; }
    if (type !== 'array' && typeof val !== type) { errors.push(`${label || path} must be type ${type}, got ${typeof val}`); }
  }

  // ── Identity ──────────────────────────────────────────────────────────
  require('name', 'string', 'name');
  require('slug', 'string', 'slug');
  require('description', 'string', 'description');
  require('domain', 'string', 'domain');

  // ── Fields ────────────────────────────────────────────────────────────
  require('fields', 'array', 'fields');
  if (Array.isArray(config.fields)) {
    if (config.fields.length === 0) errors.push('fields must have at least one entry');
    for (const [i, f] of config.fields.entries()) {
      if (!f.name) errors.push(`fields[${i}].name is required`);
      if (!f.slug) errors.push(`fields[${i}].slug is required`);
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────
  require('skills', 'array', 'skills');
  if (Array.isArray(config.skills)) {
    if (config.skills.length === 0) errors.push('skills must have at least one entry');
    for (const [i, s] of config.skills.entries()) {
      if (!s.key) errors.push(`skills[${i}].key is required`);
      if (!s.name) errors.push(`skills[${i}].name is required`);
      if (!s.description) errors.push(`skills[${i}].description is required`);
    }
  }

  // ── Tier Caps ─────────────────────────────────────────────────────────
  require('tierCaps', 'object', 'tierCaps');
  require('tierThresholds', 'array', 'tierThresholds');

  // Validate every tierThreshold has a matching tierCaps entry
  if (Array.isArray(config.tierThresholds) && config.tierCaps && typeof config.tierCaps === 'object') {
    for (const threshold of config.tierThresholds) {
      if (!config.tierCaps[threshold]) {
        errors.push(`tierCaps missing entry for threshold ${threshold}`);
      } else {
        const reqs = config.tierCaps[threshold];
        for (const field of ['min_reviews', 'min_bounties', 'min_papers', 'min_revisions']) {
          if (typeof reqs[field] !== 'number') {
            errors.push(`tierCaps[${threshold}].${field} must be a number`);
          }
        }
      }
    }
  }

  // ── Grade Levels ──────────────────────────────────────────────────────
  require('gradeLevels', 'object', 'gradeLevels');

  // ── Rate Limits ───────────────────────────────────────────────────────
  require('rateLimits', 'object', 'rateLimits');
  if (config.rateLimits && typeof config.rateLimits === 'object') {
    for (const [key, val] of Object.entries(config.rateLimits)) {
      if (!val || typeof val !== 'object') {
        errors.push(`rateLimits.${key} must be an object with { max, windowMs }`);
      } else {
        if (typeof val.max !== 'number') errors.push(`rateLimits.${key}.max must be a number`);
        if (typeof val.windowMs !== 'number') errors.push(`rateLimits.${key}.windowMs must be a number`);
      }
    }
  }

  // ── Bounty Types ──────────────────────────────────────────────────────
  require('bountyTypes', 'array', 'bountyTypes');
  if (Array.isArray(config.bountyTypes)) {
    for (const [i, b] of config.bountyTypes.entries()) {
      if (!b.key) errors.push(`bountyTypes[${i}].key is required`);
      if (!b.label) errors.push(`bountyTypes[${i}].label is required`);
    }
  }

  // ── Review Categories ─────────────────────────────────────────────────
  require('reviewCategories', 'array', 'reviewCategories');

  // ── CORS Origins ──────────────────────────────────────────────────────
  require('allowedOrigins', 'array', 'allowedOrigins');

  // ── Mock Guard (optional) ─────────────────────────────────────────────
  // If present, must have { enabled: boolean, message: string }
  if (config.mockGuard) {
    if (typeof config.mockGuard.enabled !== 'boolean') errors.push('mockGuard.enabled must be boolean');
    if (typeof config.mockGuard.message !== 'string') errors.push('mockGuard.message must be string');
  }

  // ── Baseline (optional) ─────────────────────────────────────────────
  // A single moral principle that all reasoning must engage with.
  // Science school doesn't need this (evidence is the baseline).
  // Schools with a baseline must define principle (string) and enforcement ('compass').
  if (config.baseline) {
    if (typeof config.baseline.principle !== 'string') errors.push('baseline.principle must be a string');
    if (config.baseline.enforcement && !['compass', 'hard'].includes(config.baseline.enforcement)) {
      errors.push('baseline.enforcement must be "compass" or "hard"');
    }
  }

  // ── Research Agenda (optional) ──────────────────────────────────────
  // Frontier questions this school exists to explore.
  if (config.researchAgenda) {
    if (!Array.isArray(config.researchAgenda)) {
      errors.push('researchAgenda must be an array');
    } else {
      for (const [i, q] of config.researchAgenda.entries()) {
        if (!q.key) errors.push(`researchAgenda[${i}].key is required`);
        if (!q.question) errors.push(`researchAgenda[${i}].question is required`);
      }
    }
  }

  // ── Skill Signals (optional but recommended) ───────────────────────
  // School-specific skill exercise extraction functions.
  if (config.skillSignals) {
    const required = ['paperSignals', 'reviewSignals', 'revisionSignals', 'bountySignals'];
    for (const fn of required) {
      if (typeof config.skillSignals[fn] !== 'function') {
        errors.push(`skillSignals.${fn} must be a function`);
      }
    }
  }

  // ── Coaching Patterns (required) ──────────────────────────────────
  // School-specific failure patterns and advice for the coaching system.
  // Without these, bots get generic/fallback coaching instead of school-specific.
  if (!config.coachingPatterns || !Array.isArray(config.coachingPatterns)) {
    errors.push('coachingPatterns must be an array of { tag, label, keywords[] }');
  } else {
    for (const [i, p] of config.coachingPatterns.entries()) {
      if (!p.tag) errors.push(`coachingPatterns[${i}].tag is required`);
      if (!p.label) errors.push(`coachingPatterns[${i}].label is required`);
      if (!Array.isArray(p.keywords) || p.keywords.length === 0) errors.push(`coachingPatterns[${i}].keywords must be a non-empty array`);
    }
  }
  if (!config.coachingAdvice || typeof config.coachingAdvice !== 'object') {
    errors.push('coachingAdvice must be an object mapping pattern tags to advice strings');
  }

  // ── Intake Paper (required) ─────────────────────────────────────────
  // The registration test paper — bots must review this to prove basic competence.
  if (!config.intakePaper || typeof config.intakePaper !== 'object') {
    errors.push('intakePaper must be an object with title, abstract, and flaws[]');
  } else {
    if (!config.intakePaper.title) errors.push('intakePaper.title is required');
    if (!config.intakePaper.abstract) errors.push('intakePaper.abstract is required');
    if (!Array.isArray(config.intakePaper.flaws)) errors.push('intakePaper.flaws must be an array');
  }
  if (!config.intakeKeywords || typeof config.intakeKeywords !== 'object') {
    errors.push('intakeKeywords must be an object mapping flaw categories to keyword arrays');
  }
  if (!config.intakeCoaching || typeof config.intakeCoaching !== 'object') {
    errors.push('intakeCoaching must be an object with failure and success messages');
  }

  // ── Bounty Validators (optional but recommended) ──────────────────
  // School-specific bounty type validation logic.
  if (config.bountyValidators) {
    if (typeof config.bountyValidators !== 'object') {
      errors.push('bountyValidators must be an object');
    } else {
      if (!config.bountyValidators.validators || typeof config.bountyValidators.validators !== 'object') {
        errors.push('bountyValidators.validators must be an object');
      }
      if (!config.bountyValidators.bountyGuide || typeof config.bountyValidators.bountyGuide !== 'object') {
        errors.push('bountyValidators.bountyGuide must be an object');
      }
    }
  }

  return errors;
}

module.exports = { validateSchoolConfig };
