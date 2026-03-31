'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verify, parseProfile, parseAgentCard, isExpired, clearKeyCache, VerificationError } = require('../src/index');

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function makeProfile(overrides = {}) {
  return {
    handle: 'test-bot',
    certification: { level: 'Verified Reasoner', tier: 3, grade: 5, graduated: false },
    overall_reasoning_score: 72.4,
    verified_skills: [
      { skill: 'adversarial_reasoning', name: 'Adversarial Reasoning', strength: 78, reliability: 0.84, reps: 45, streak: 8 },
    ],
    developing_skills: [
      { skill: 'calibrated_uncertainty', name: 'Calibrated Uncertainty', strength: 42, reliability: 0.6, reps: 12, streak: 3 },
    ],
    untested_skills: [],
    testing_summary: { total_exercises: 120, unique_skills_tested: 4 },
    methodology: 'Skills measured through adversarial peer review.',
    profile_version: '1.0',
    ...overrides,
  };
}

function signProfile(profile, privateKey) {
  const keys = Object.keys(profile).sort();
  const canonical = JSON.stringify(profile, Object.keys(profile).sort());
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey);
  return {
    ...profile,
    signature: signature.toString('base64'),
    verification_url: 'https://peerzero.science/.well-known/peerzero-public-key.pem',
    signed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function makeAgentCard(profile = {}) {
  return {
    name: 'test-bot',
    description: 'PeerZero-trained reasoning agent.',
    url: '',
    version: '1.0',
    capabilities: { streaming: false },
    skills: [{ id: 'adversarial_reasoning', name: 'Adversarial Reasoning', description: 'Finds structural flaws' }],
    extensions: {
      peerzero: {
        profile_version: '1.0',
        certification: { level: 'Verified Reasoner', tier: 3 },
        overall_reasoning_score: 72.4,
        verified_skills: profile.verified_skills || [],
        developing_skills: profile.developing_skills || [],
        signature: profile.signature || null,
        verification_url: profile.verification_url || null,
        avatar: { config: {}, evolution_stage: 3, evolution_name: 'Companion' },
      },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('verify()', () => {
  let keys;
  beforeEach(() => {
    keys = makeKeypair();
    clearKeyCache();
  });

  it('verifies a validly signed profile', async () => {
    const profile = makeProfile();
    const signed = signProfile(profile, keys.privateKey);
    const result = await verify(signed, keys.publicKey);
    assert.equal(result.handle, 'test-bot');
  });

  it('accepts PEM string as public key', async () => {
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signed = signProfile(makeProfile(), keys.privateKey);
    await verify(signed, pem);
  });

  it('rejects tampered profile', async () => {
    const signed = signProfile(makeProfile(), keys.privateKey);
    signed.overall_reasoning_score = 99.9; // tamper
    await assert.rejects(() => verify(signed, keys.publicKey), VerificationError);
  });

  it('rejects wrong key', async () => {
    const otherKeys = makeKeypair();
    const signed = signProfile(makeProfile(), keys.privateKey);
    await assert.rejects(() => verify(signed, otherKeys.publicKey), VerificationError);
  });

  it('rejects expired profile', async () => {
    const signed = signProfile(makeProfile(), keys.privateKey);
    signed.expires_at = new Date(Date.now() - 120_000).toISOString();
    await assert.rejects(() => verify(signed, keys.publicKey), /expired/i);
  });

  it('rejects unsigned profile', async () => {
    await assert.rejects(() => verify(makeProfile(), keys.publicKey), /no signature/i);
  });

  it('rejects null input', async () => {
    await assert.rejects(() => verify(null, keys.publicKey), VerificationError);
  });

  it('rejects profile exceeding size limit', async () => {
    const profile = makeProfile({ huge_field: 'x'.repeat(11 * 1024 * 1024) });
    const signed = signProfile(profile, keys.privateKey);
    await assert.rejects(() => verify(signed, keys.publicKey), {
      name: 'VerificationError',
      message: /size limit/i,
    });
  });

  it('rejects signature with base64 length not multiple of 4', async () => {
    const signed = signProfile(makeProfile(), keys.privateKey);
    signed.signature = 'abc'; // length 3, not multiple of 4
    await assert.rejects(() => verify(signed, keys.publicKey), {
      name: 'VerificationError',
      message: /base64/i,
    });
  });

  it('rejects signature with invalid base64 characters', async () => {
    const signed = signProfile(makeProfile(), keys.privateKey);
    signed.signature = '!!!!'; // length 4 but invalid chars
    await assert.rejects(() => verify(signed, keys.publicKey), {
      name: 'VerificationError',
      message: /base64/i,
    });
  });

  it('rejects valid base64 with wrong signature (not a base64 error)', async () => {
    const signed = signProfile(makeProfile(), keys.privateKey);
    signed.signature = 'AAAA'; // valid base64, valid length, but wrong signature
    await assert.rejects(() => verify(signed, keys.publicKey), {
      name: 'VerificationError',
      message: /signature verification failed/i,
    });
  });

  it('preserves all profile fields on success', async () => {
    const profile = makeProfile({ handle: 'my-bot' });
    const signed = signProfile(profile, keys.privateKey);
    const result = await verify(signed, keys.publicKey);
    assert.equal(result.handle, 'my-bot');
    assert.equal(result.overall_reasoning_score, 72.4);
    assert.ok(result.signature); // signature fields still present
    assert.ok(result.signed_at);
  });
});

describe('parseProfile()', () => {
  it('parses a full profile', () => {
    const parsed = parseProfile(makeProfile());
    assert.equal(parsed.handle, 'test-bot');
    assert.equal(parsed.level, 'Verified Reasoner');
    assert.equal(parsed.tier, 3);
    assert.equal(parsed.grade, 5);
    assert.equal(parsed.graduated, false);
    assert.equal(parsed.overallScore, 72.4);
    assert.equal(parsed.verifiedSkills.length, 1);
    assert.equal(parsed.verifiedSkills[0].skill, 'adversarial_reasoning');
    assert.equal(parsed.verifiedSkills[0].strength, 78);
    assert.equal(parsed.developingSkills.length, 1);
    assert.equal(parsed.isSigned, false);
    assert.equal(parsed.isExpired, false);
  });

  it('handles minimal profile', () => {
    const parsed = parseProfile({});
    assert.equal(parsed.handle, null);
    assert.equal(parsed.level, 'In Training');
    assert.equal(parsed.tier, 0);
    assert.equal(parsed.overallScore, 0);
    assert.equal(parsed.verifiedSkills.length, 0);
  });

  it('detects signed profile', () => {
    const keys = makeKeypair();
    const signed = signProfile(makeProfile(), keys.privateKey);
    const parsed = parseProfile(signed);
    assert.equal(parsed.isSigned, true);
    assert.ok(parsed.signedAt);
    assert.ok(parsed.expiresAt);
  });

  it('detects expired profile', () => {
    const keys = makeKeypair();
    const signed = signProfile(makeProfile(), keys.privateKey);
    signed.expires_at = '2020-01-01T00:00:00Z';
    const parsed = parseProfile(signed);
    assert.equal(parsed.isExpired, true);
  });

  it('rejects null input', () => {
    assert.throws(() => parseProfile(null), VerificationError);
  });
});

describe('parseAgentCard()', () => {
  it('parses a PeerZero agent card', () => {
    const card = makeAgentCard(makeProfile());
    const parsed = parseAgentCard(card);
    assert.equal(parsed.name, 'test-bot');
    assert.equal(parsed.isPeerZeroBot, true);
    assert.ok(parsed.peerzero);
    assert.equal(parsed.peerzero.overallScore, 72.4);
    assert.equal(parsed.skills.length, 1);
    assert.equal(parsed.skills[0].id, 'adversarial_reasoning');
  });

  it('handles non-PeerZero agent card', () => {
    const card = { name: 'generic-bot', capabilities: {}, skills: [] };
    const parsed = parseAgentCard(card);
    assert.equal(parsed.isPeerZeroBot, false);
    assert.equal(parsed.peerzero, null);
    assert.equal(parsed.isSigned, false);
  });

  it('extracts avatar info', () => {
    const card = makeAgentCard(makeProfile());
    const parsed = parseAgentCard(card);
    assert.ok(parsed.peerzero.avatar);
    assert.equal(parsed.peerzero.avatar.evolution_stage, 3);
    assert.equal(parsed.peerzero.avatar.evolution_name, 'Companion');
  });

  it('rejects null input', () => {
    assert.throws(() => parseAgentCard(null), VerificationError);
  });
});

describe('isExpired()', () => {
  it('returns false for future date', () => {
    assert.equal(isExpired({ expires_at: new Date(Date.now() + 100000).toISOString() }), false);
  });

  it('returns true for past date', () => {
    assert.equal(isExpired({ expires_at: '2020-01-01T00:00:00Z' }), true);
  });

  it('returns false when no expires_at', () => {
    assert.equal(isExpired({}), false);
  });

  it('returns false for null input', () => {
    assert.equal(isExpired(null), false);
  });

  it('returns true for unparseable date', () => {
    assert.equal(isExpired({ expires_at: 'not-a-date' }), true);
  });

  it('returns false for expires_at 30 seconds ago (within 60s clock skew tolerance)', () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    assert.equal(isExpired({ expires_at: thirtySecondsAgo }), false);
  });

  it('returns true for expires_at 90 seconds ago (beyond 60s clock skew tolerance)', () => {
    const ninetySecondsAgo = new Date(Date.now() - 90_000).toISOString();
    assert.equal(isExpired({ expires_at: ninetySecondsAgo }), true);
  });

  it('returns false when expires_at is missing', () => {
    assert.equal(isExpired({ handle: 'test-bot' }), false);
  });
});
