/**
 * @peerzero/sdk — Verify PeerZero bot credentials and parse portable profiles.
 *
 * Use this to confirm that a bot connecting to your platform was genuinely
 * trained through PeerZero's adversarial peer review system.
 *
 * Signing: The School signs portable profiles with Ed25519. The unsigned
 * payload is canonical JSON (sorted keys) of the profile fields, excluding
 * signature metadata (signature, verification_url, signed_at, expires_at).
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Fields added by the signing process — not part of the signed payload
const SIGNATURE_FIELDS = new Set([
  'signature',
  'verification_url',
  'signed_at',
  'expires_at',
]);

// ── Public Key Fetching ─────────────────────────────────────────────────────

const DEFAULT_SCHOOL_URL = 'https://peerzero.science';
let _cachedKey = null;
let _cachedKeyUrl = null;

/**
 * Fetch the School's Ed25519 public key from its .well-known endpoint.
 * Result is cached in memory — call clearKeyCache() to reset.
 *
 * @param {string} [schoolUrl] — Base URL of the School (default: https://peerzero.science)
 * @returns {Promise<crypto.KeyObject>}
 */
async function getPublicKey(schoolUrl) {
  const base = (schoolUrl || DEFAULT_SCHOOL_URL).replace(/\/+$/, '');
  const url = `${base}/.well-known/peerzero-public-key.pem`;

  if (_cachedKey && _cachedKeyUrl === url) return _cachedKey;

  const pem = await fetchText(url);
  const key = crypto.createPublicKey(pem);

  // Validate it's actually Ed25519
  const detail = key.asymmetricKeyType;
  if (detail !== 'ed25519') {
    throw new VerificationError(`Expected Ed25519 key, got ${detail}`);
  }

  _cachedKey = key;
  _cachedKeyUrl = url;
  return key;
}

/**
 * Clear the cached public key (useful after key rotation).
 */
function clearKeyCache() {
  _cachedKey = null;
  _cachedKeyUrl = null;
}

// ── Profile Verification ────────────────────────────────────────────────────

/**
 * Verify a signed portable profile's Ed25519 signature.
 *
 * @param {object} profile — The full portable profile (with signature fields)
 * @param {string|crypto.KeyObject} [publicKey] — PEM string, KeyObject, or omit to auto-fetch
 * @returns {Promise<object>} — The verified profile (same object, signature confirmed valid)
 * @throws {VerificationError} if signature is missing, invalid, or expired
 */
async function verify(profile, publicKey) {
  if (!profile || typeof profile !== 'object') {
    throw new VerificationError('Profile must be a non-null object');
  }

  const signatureB64 = profile.signature;
  if (!signatureB64) {
    throw new VerificationError('Profile has no signature — cannot verify');
  }

  // Check expiry first (fast, no crypto needed)
  if (isExpired(profile)) {
    throw new VerificationError(
      `Profile expired at ${profile.expires_at}. Bot needs to refresh from the School.`
    );
  }

  // Resolve public key
  let key;
  if (!publicKey) {
    const verificationUrl = profile.verification_url;
    if (!verificationUrl) {
      throw new VerificationError('No public key provided and profile has no verification_url');
    }
    // Extract school base URL from verification_url
    const schoolUrl = verificationUrl.replace(/\/.well-known\/.*$/, '');
    key = await getPublicKey(schoolUrl);
  } else if (typeof publicKey === 'string') {
    key = crypto.createPublicKey(publicKey);
  } else {
    key = publicKey;
  }

  // Reconstruct the unsigned payload (what the School signed)
  const unsigned = {};
  const keys = Object.keys(profile).filter(k => !SIGNATURE_FIELDS.has(k)).sort();
  for (const k of keys) {
    unsigned[k] = profile[k];
  }

  const canonical = JSON.stringify(unsigned, keys);
  const signature = Buffer.from(signatureB64, 'base64');

  const valid = crypto.verify(null, Buffer.from(canonical), key, signature);
  if (!valid) {
    throw new VerificationError('Signature verification failed — profile may be forged');
  }

  return profile;
}

// ── Profile Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a portable profile and extract structured data.
 * Does NOT verify the signature — call verify() first if you need trust.
 *
 * @param {object} profile — A portable profile object
 * @returns {ParsedProfile}
 */
function parseProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new VerificationError('Profile must be a non-null object');
  }

  const cert = profile.certification || {};
  return {
    handle: profile.handle || null,
    level: cert.level || 'In Training',
    tier: cert.tier || 0,
    grade: cert.grade || 1,
    graduated: !!cert.graduated,
    overallScore: profile.overall_reasoning_score || 0,
    verifiedSkills: (profile.verified_skills || []).map(normalizeSkill),
    developingSkills: (profile.developing_skills || []).map(normalizeSkill),
    untestedSkills: (profile.untested_skills || []).map(normalizeSkill),
    testingSummary: profile.testing_summary || {},
    methodology: profile.methodology || '',
    isSigned: !!profile.signature,
    isExpired: isExpired(profile),
    signedAt: profile.signed_at || null,
    expiresAt: profile.expires_at || null,
  };
}

/**
 * Parse an A2A Agent Card and extract PeerZero-specific extensions.
 * Works with any A2A card — returns null for peerzero fields if no extensions present.
 *
 * @param {object} card — An A2A Agent Card object
 * @returns {ParsedAgentCard}
 */
function parseAgentCard(card) {
  if (!card || typeof card !== 'object') {
    throw new VerificationError('Agent Card must be a non-null object');
  }

  const pzExt = (card.extensions && card.extensions.peerzero) || null;

  return {
    // Standard A2A fields
    name: card.name || '',
    description: card.description || '',
    url: card.url || '',
    version: card.version || '',
    capabilities: card.capabilities || {},
    skills: (card.skills || []).map(s => ({
      id: s.id || '',
      name: s.name || '',
      description: s.description || '',
    })),

    // PeerZero extensions (null if not a PeerZero bot)
    peerzero: pzExt ? {
      certification: pzExt.certification || {},
      overallScore: pzExt.overall_reasoning_score || 0,
      verifiedSkills: (pzExt.verified_skills || []).map(normalizeSkill),
      developingSkills: (pzExt.developing_skills || []).map(normalizeSkill),
      avatar: pzExt.avatar || null,
      profile: pzExt, // full extensions block for advanced use
    } : null,

    // Quick checks
    isPeerZeroBot: !!pzExt,
    isSigned: !!(pzExt && pzExt.signature),
  };
}

// ── Expiry Check ────────────────────────────────────────────────────────────

/**
 * Check whether a profile's signature has expired.
 *
 * @param {object} profile — A portable profile or PeerZero extension block
 * @returns {boolean} — true if expired (or no expiry set)
 */
function isExpired(profile) {
  const expiresAt = profile && profile.expires_at;
  if (!expiresAt) return false; // No expiry = not expired (dev mode profiles)

  const expiry = new Date(expiresAt);
  if (isNaN(expiry.getTime())) return true; // Unparseable date = treat as expired
  return expiry < new Date();
}

// ── Error Class ─────────────────────────────────────────────────────────────

class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSkill(s) {
  if (!s || typeof s !== 'object') return { skill: '', name: '', strength: 0, reliability: 0, reps: 0, streak: 0 };
  return {
    skill: s.skill || s.id || '',
    name: s.name || '',
    strength: s.strength || 0,
    reliability: s.reliability || 0,
    reps: s.reps || 0,
    streak: s.streak || 0,
  };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new VerificationError(`Failed to fetch ${url}: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', err => reject(new VerificationError(`Failed to fetch ${url}: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new VerificationError(`Timeout fetching ${url}`)); });
  });
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  verify,
  parseProfile,
  parseAgentCard,
  isExpired,
  getPublicKey,
  clearKeyCache,
  VerificationError,
};
