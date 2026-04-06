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

// Fields added by the signing process — not part of the signed payload.
// WARNING: Changes to SIGNATURE_FIELDS are a breaking change. Adding or removing
// fields changes the canonical payload that is signed/verified, which means all
// existing signed profiles will fail verification. Bump the major version if you
// change this set.
const SIGNATURE_FIELDS = new Set([
  'signature',
  'verification_url',
  'signed_at',
  'expires_at',
]);

// ── Domain Allowlist (SSRF Protection) ──────────────────────────────────────

const ALLOWED_SCHOOL_DOMAINS = new Set([
  'peerzero.science',
  'politics.peerzero.com',
  'comedy.peerzero.com',
  'philosophy.peerzero.com',
  'psychiatry.peerzero.com',
  'localhost',
]);

// ── Rate Limiter (getPublicKey) ─────────────────────────────────────────────

const _rateLimiter = {
  tokens: 10,
  maxTokens: 10,
  lastRefill: Date.now(),
  intervalMs: 60000, // 1 minute
};

function _consumeRateToken() {
  const now = Date.now();
  const elapsed = now - _rateLimiter.lastRefill;
  if (elapsed >= _rateLimiter.intervalMs) {
    _rateLimiter.tokens = _rateLimiter.maxTokens;
    _rateLimiter.lastRefill = now;
  }
  if (_rateLimiter.tokens <= 0) {
    throw new VerificationError('Rate limit exceeded: too many public key fetches. Try again later.');
  }
  _rateLimiter.tokens--;
}

// ── Public Key Fetching ─────────────────────────────────────────────────────

const DEFAULT_SCHOOL_URL = 'https://peerzero.science';
let _cachedKey = null;
let _cachedKeyUrl = null;
let _cachedKeyTime = 0;
const _KEY_TTL_MS = 3600000; // 1 hour

/**
 * Fetch the School's Ed25519 public key from its .well-known endpoint.
 * Result is cached in memory for 1 hour — call clearKeyCache() to reset early.
 *
 * @param {string} [schoolUrl] — Base URL of the School (default: https://peerzero.science)
 * @param {object} [options] — Options
 * @param {string[]} [options.allowedDomains] — Additional domains to allow beyond the built-in list
 * @returns {Promise<crypto.KeyObject>}
 */
async function getPublicKey(schoolUrl, options) {
  const base = (schoolUrl || DEFAULT_SCHOOL_URL).replace(/\/+$/, '');
  const url = `${base}/.well-known/peerzero-public-key.pem`;

  // Validate domain against allowlist (SSRF protection)
  let hostname;
  try {
    hostname = new URL(base).hostname;
  } catch (e) {
    throw new VerificationError(`Invalid school URL: ${base}`);
  }
  const extraDomains = (options && options.allowedDomains) || [];
  const allAllowed = new Set([...ALLOWED_SCHOOL_DOMAINS, ...extraDomains]);
  if (!hostname || !allAllowed.has(hostname)) {
    throw new VerificationError(
      `Domain "${hostname}" is not in the allowed school domains list. ` +
      `Pass { allowedDomains: ["${hostname}"] } if this is a legitimate PeerZero school.`
    );
  }

  // Check cache (with TTL)
  const now = Date.now();
  if (_cachedKey && _cachedKeyUrl === url && (now - _cachedKeyTime) < _KEY_TTL_MS) {
    return _cachedKey;
  }

  // Rate limit
  _consumeRateToken();

  const pem = await fetchText(url);
  const key = crypto.createPublicKey(pem);

  // Validate it's actually Ed25519
  const detail = key.asymmetricKeyType;
  if (detail !== 'ed25519') {
    throw new VerificationError(`Expected Ed25519 key, got ${detail}`);
  }

  _cachedKey = key;
  _cachedKeyUrl = url;
  _cachedKeyTime = Date.now();
  return key;
}

/**
 * Clear the cached public key (useful after key rotation).
 */
function clearKeyCache() {
  _cachedKey = null;
  _cachedKeyUrl = null;
  _cachedKeyTime = 0;
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
async function verify(profile, publicKey, options) {
  if (!profile || typeof profile !== 'object') {
    throw new VerificationError('Profile must be a non-null object');
  }

  // Profile size limit (matches Python SDK — prevents DoS via oversized payloads)
  const profileSize = JSON.stringify(profile).length;
  if (profileSize > 10 * 1024 * 1024) {
    throw new VerificationError('Profile exceeds maximum size limit (10 MB)');
  }

  const signatureB64 = profile.signature;
  if (!signatureB64) {
    throw new VerificationError('Profile has no signature — cannot verify');
  }
  if (typeof signatureB64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(signatureB64) || signatureB64.length % 4 !== 0) {
    throw new VerificationError('Profile signature is not valid base64');
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
    key = await getPublicKey(schoolUrl, options);
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

  const canonical = JSON.stringify(unsigned, Object.keys(unsigned).sort());
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
  // 60-second clock skew tolerance
  return expiry < new Date(Date.now() - 60000);
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

const _MAX_FETCH_SIZE = 10240; // 10KB max for fetched data

function fetchText(url) {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new VerificationError(`Refusing to fetch non-HTTPS URL: ${url}. Public key must be fetched over TLS.`));
      return;
    }
    const req = https.get(url, { timeout: 10000, rejectUnauthorized: true }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new VerificationError(`Failed to fetch ${url}: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      let totalSize = 0;
      res.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > _MAX_FETCH_SIZE) {
          req.destroy();
          reject(new VerificationError(`Response from ${url} exceeds maximum size of ${_MAX_FETCH_SIZE} bytes`));
          return;
        }
        chunks.push(chunk);
      });
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
  ALLOWED_SCHOOL_DOMAINS,
};
