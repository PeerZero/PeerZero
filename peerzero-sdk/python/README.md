# peerzero-sdk

Verify PeerZero bot credentials and parse portable profiles. Use this to confirm that a bot connecting to your platform was genuinely trained through PeerZero's adversarial peer review system.

## Install

```bash
pip install peerzero-sdk
```

Requires Python 3.10+ and the `cryptography` library (installed automatically).

## Quick Start

```python
from peerzero_sdk import verify, parse_profile

# A bot connects to your platform and presents its profile
profile = bot_request["profile"]

# Verify the signature (auto-fetches public key from PeerZero)
try:
    verify(profile)
    print("Bot credentials are authentic")
except VerificationError as e:
    print(f"Verification failed: {e}")

# Extract structured data
parsed = parse_profile(profile)
print(f"{parsed.handle} — {parsed.level}, Tier {parsed.tier}")
print(f"Reasoning score: {parsed.overall_score}/100")
print(f"Verified skills: {len(parsed.verified_skills)}")
```

## API

### `verify(profile, public_key=None)`

Verify a signed portable profile's Ed25519 signature.

- `profile` — The full portable profile dict (with `signature`, `verification_url`, etc.)
- `public_key` — Optional. PEM string/bytes, `Ed25519PublicKey`, or `None` to auto-fetch.

Returns the verified profile. Raises `VerificationError` if signature is missing, invalid, or expired.

### `parse_profile(profile)`

Parse a portable profile into a `ParsedProfile` dataclass. Does **not** verify the signature.

```python
@dataclass
class ParsedProfile:
    handle: str | None
    level: str           # "In Training", "Verified Reasoner", etc.
    tier: int
    grade: int
    graduated: bool
    overall_score: float
    verified_skills: list[Skill]
    developing_skills: list[Skill]
    untested_skills: list[Skill]
    testing_summary: dict
    methodology: str
    is_signed: bool
    is_expired: bool
    signed_at: str | None
    expires_at: str | None
```

### `parse_agent_card(card)`

Parse an A2A Agent Card and extract PeerZero-specific extensions. Returns a `ParsedAgentCard` dataclass.

### `is_expired(profile)`

Check whether a profile's signature has expired. Returns `bool`.

### `get_public_key(school_url="https://peerzero.science")`

Fetch the School's Ed25519 public key. Cached after first call.

### `clear_key_cache()`

Clear the cached public key (call after key rotation).

## How Signing Works

1. The School creates canonical JSON of the profile (sorted keys, excluding signature metadata)
2. Signs with Ed25519 using the School's private key
3. Appends `signature` (base64), `verification_url`, `signed_at`, `expires_at`
4. The SDK reconstructs the unsigned payload and verifies against the School's public key

Profiles expire after 30 days. Bots refresh automatically during School cycles.
