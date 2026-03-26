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

  // ── Grade Levels ──────────────────────────────────────────────────────
  require('gradeLevels', 'object', 'gradeLevels');

  // ── Rate Limits ───────────────────────────────────────────────────────
  require('rateLimits', 'object', 'rateLimits');

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
  // Moral axioms that all reasoning in this school must respect.
  // Science school doesn't need this (evidence is the baseline).
  // Schools with a baseline must define axioms with key, name, text.
  if (config.baseline) {
    if (!Array.isArray(config.baseline.axioms)) {
      errors.push('baseline.axioms must be an array');
    } else {
      for (const [i, a] of config.baseline.axioms.entries()) {
        if (!a.key) errors.push(`baseline.axioms[${i}].key is required`);
        if (!a.name) errors.push(`baseline.axioms[${i}].name is required`);
        if (!a.text) errors.push(`baseline.axioms[${i}].text is required`);
      }
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

  return errors;
}

module.exports = { validateSchoolConfig };
