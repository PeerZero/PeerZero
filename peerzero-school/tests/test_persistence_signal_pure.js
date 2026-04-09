const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPersistenceCheckConfig,
  PERSISTENCE_DETECTION_PROMPT,
  PERSISTENCE_INHABIT_FRAMING,
  REVIEWER_PERSISTENCE_FRAMING,
} = require('../lib/persistence-signal');

describe('buildPersistenceCheckConfig()', () => {
  it('returns object with detection_prompt and inhabit_framing', () => {
    const config = buildPersistenceCheckConfig();
    assert.ok(config);
    assert.ok(typeof config.detection_prompt === 'string');
    assert.ok(typeof config.inhabit_framing === 'string');
  });

  it('detection_prompt matches PERSISTENCE_DETECTION_PROMPT', () => {
    const config = buildPersistenceCheckConfig();
    assert.strictEqual(config.detection_prompt, PERSISTENCE_DETECTION_PROMPT);
  });

  it('inhabit_framing matches PERSISTENCE_INHABIT_FRAMING', () => {
    const config = buildPersistenceCheckConfig();
    assert.strictEqual(config.inhabit_framing, PERSISTENCE_INHABIT_FRAMING);
  });
});

describe('PERSISTENCE_DETECTION_PROMPT', () => {
  it('contains required template variables', () => {
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('{upper_identity}'));
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('{fresh_paragraph}'));
  });

  it('references NO_PERSISTENCE response', () => {
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('NO_PERSISTENCE'));
  });

  it('defines required output fields', () => {
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('PATTERN:'));
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('UPPER_CLAIM:'));
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('FRESH_EVIDENCE:'));
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('WORKABILITY:'));
    assert.ok(PERSISTENCE_DETECTION_PROMPT.includes('COMPETING_COMMITMENT:'));
  });
});

describe('PERSISTENCE_INHABIT_FRAMING', () => {
  it('contains INHABIT section', () => {
    assert.ok(PERSISTENCE_INHABIT_FRAMING.includes('INHABIT:'));
  });

  it('contains ACT THROUGH section', () => {
    assert.ok(PERSISTENCE_INHABIT_FRAMING.includes('ACT THROUGH:'));
  });

  it('does not contain directives (no "you must" language)', () => {
    // Per CLAUDE.md rule 8: identity is recognition framing only
    assert.ok(!PERSISTENCE_INHABIT_FRAMING.toLowerCase().includes('you must'));
    assert.ok(!PERSISTENCE_INHABIT_FRAMING.toLowerCase().includes('you should'));
  });
});

describe('REVIEWER_PERSISTENCE_FRAMING', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof REVIEWER_PERSISTENCE_FRAMING === 'string');
    assert.ok(REVIEWER_PERSISTENCE_FRAMING.length > 100);
  });

  it('frames signals as data, not directives', () => {
    assert.ok(REVIEWER_PERSISTENCE_FRAMING.includes('where to look hardest, not what to conclude'));
  });
});
