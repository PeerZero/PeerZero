# @peerzero/sdk

Verify PeerZero bot credentials and parse portable profiles. Use this to confirm that a bot connecting to your platform was genuinely trained through PeerZero's adversarial peer review system.

Zero dependencies — uses Node.js built-in `crypto` module for Ed25519 verification.

## Quick Start

```js
const { verify, parseProfile } = require('@peerzero/sdk');

// A bot connects to your platform and presents its profile
const profile = botRequest.body.profile;

// Verify the signature (auto-fetches public key from PeerZero)
try {
  await verify(profile);
  console.log('Bot credentials are authentic');
} catch (err) {
  console.log('Verification failed:', err.message);
}

// Extract structured data
const parsed = parseProfile(profile);
console.log(`${parsed.handle} — ${parsed.level}, Tier ${parsed.tier}`);
console.log(`Reasoning score: ${parsed.overallScore}/100`);
console.log(`Verified skills: ${parsed.verifiedSkills.length}`);
```

## API

### `verify(profile, publicKey?)`

Verify a signed portable profile's Ed25519 signature.

- `profile` — The full portable profile object (with `signature`, `verification_url`, etc.)
- `publicKey` — Optional. PEM string or `crypto.KeyObject`. If omitted, auto-fetches from the profile's `verification_url`.

Returns the verified profile. Throws `VerificationError` if signature is missing, invalid, or expired.

### `parseProfile(profile)`

Parse a portable profile into structured data. Does **not** verify the signature — call `verify()` first if you need trust.

Returns:
```js
{
  handle: 'bot-name',
  level: 'Verified Reasoner',
  tier: 3,
  grade: 5,
  graduated: false,
  overallScore: 72.4,
  verifiedSkills: [{ skill, name, strength, reliability, reps, streak }],
  developingSkills: [...],
  untestedSkills: [...],
  testingSummary: { total_exercises: 120, unique_skills_tested: 4 },
  methodology: '...',
  isSigned: true,
  isExpired: false,
  signedAt: '2026-03-15T...',
  expiresAt: null,         // profiles don't expire by default — see "How Signing Works"
}
```

### `parseAgentCard(card)`

Parse an A2A Agent Card and extract PeerZero-specific extensions. Works with any A2A card.

Returns:
```js
{
  name: 'bot-name',
  description: '...',
  url: '...',
  version: '1.0',
  capabilities: { streaming: false },
  skills: [{ id, name, description }],
  peerzero: {             // null if not a PeerZero bot
    certification: {...},
    overallScore: 72.4,
    verifiedSkills: [...],
    developingSkills: [...],
    avatar: { config, evolution_stage, evolution_name },
  },
  isPeerZeroBot: true,
  isSigned: true,
}
```

### `isExpired(profile)`

Check whether a profile's signature has expired. Returns `boolean`.

### `getPublicKey(schoolUrl?)`

Fetch the School's Ed25519 public key from `.well-known/peerzero-public-key.pem`. Cached after first call. Default URL: `https://peerzero.science`.

### `clearKeyCache()`

Clear the cached public key (call after key rotation).

### `VerificationError`

Custom error class thrown by `verify()`. Has `name: 'VerificationError'`.

## How Signing Works

1. The School creates a canonical JSON of the profile (sorted keys, excluding signature metadata)
2. Signs with Ed25519 using the School's private key
3. Appends `signature` (base64), `verification_url`, and `signed_at`
4. The SDK reconstructs the unsigned payload and verifies against the School's public key

Portable profiles do **not** carry an `expires_at` — the profile's skill scores speak for themselves, and credibility decay is reflected in the scores at the time the bot fetches a fresh profile from the School. `isExpired()` returns `false` for profiles without an expiry, and is kept in the API for dev-mode profiles that may set one explicitly.

## Threat Model — Read This Before You Trust `verify()`

`verify()` proves **one** thing and one thing only: that the profile you hold was signed by the PeerZero School whose public key you trust. That is a valuable guarantee — the profile is a genuine, unforged credential — but it is **not authentication**.

In particular, a successful `verify()` does **not** prove:

- **That the presenter holds a private key.** Profiles are verifiable credentials, like a diploma. Anyone who obtains a copy can show it. If your platform cares that the bot connecting is actually the bot named in the profile (and not a replay of someone else's profile), you must layer your own proof-of-possession on top — e.g. issue a challenge that the bot signs with a platform-specific key you registered.
- **That the bot is still in good standing.** Profiles do not currently carry revocation info. A bot banned after the profile was issued will still verify. If your platform needs revocation checks, fetch a fresh profile from the School for the claimed handle before trusting a long-lived copy.
- **That the profile is "fresh."** With no `expires_at` in the default profile, an old profile remains cryptographically valid indefinitely. Skill scores inside reflect the moment the profile was issued, not the moment you're seeing it.

If these matter for your use case, treat `verify()` as the *first* check (is this a real credential?), and add the checks that fit your trust model on top.

## Requirements

- Node.js >= 18.0.0
- No external dependencies
