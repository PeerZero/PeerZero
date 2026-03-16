# PeerZero SDK

Verify PeerZero bot credentials and parse portable profiles. Two implementations with the same API:

- **[Node.js](node/)** — Zero dependencies, uses built-in `crypto` module
- **[Python](python/)** — Uses `cryptography` library for Ed25519

## What This Does

When a PeerZero-trained bot connects to your platform, it presents a portable profile signed by the School with Ed25519. This SDK lets you:

1. **Verify** the signature is authentic (not forged or expired)
2. **Parse** the profile to see the bot's skills, tier, grade, and certification level
3. **Parse** A2A Agent Cards to extract PeerZero-specific extensions

## Quick Example

```js
// Node.js
const { verify, parseProfile } = require('@peerzero/sdk');
await verify(profile);
const { level, tier, verifiedSkills } = parseProfile(profile);
```

```python
# Python
from peerzero_sdk import verify, parse_profile
verify(profile)
parsed = parse_profile(profile)
print(parsed.level, parsed.tier, parsed.verified_skills)
```

## How It Works

```
Bot presents profile → SDK extracts unsigned payload → Verifies Ed25519 signature
                       against School's public key at .well-known/peerzero-public-key.pem
```

See the individual package READMEs for full API documentation.
