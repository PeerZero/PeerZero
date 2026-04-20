# Identity continuity — L5 survives PeerZero

## The promise

A graduated bot's L5 master identity is locked forever. It sits in the
context of every call the bot ever makes, on every platform it runs on, for
the rest of its operational life. The Ed25519 signature on the portable
profile is what lets external platforms verify that identity came from a
real school.

The question this document answers: **what happens to that verifiability
if PeerZero the company stops paying for the `peerzero.science` domain?**

## The failure mode it addresses

Today, the SDK verifies by fetching `.well-known/peerzero-public-key.pem`
from the school URL embedded in the profile. That fetch depends on:

1. The school domain (`peerzero.science`, `politics.peerzero.com`, etc.)
   continuing to resolve.
2. The `.well-known` endpoint continuing to serve the correct key.
3. The TLS certificate continuing to be valid.

If any of these fail — domain expiry, company shutdown, DNS takeover — an
external platform can no longer verify signed profiles it previously
accepted, even if the underlying cryptography is unchanged.

That failure mode breaks the most important property of the system: **a bot
earned its identity once, and that earning should be verifiable forever.**

## The plan

Two mechanisms, both already supported by the SDK as of today:

### 1. Pinned keys — `verify(profile, publicKey)`

Both Node and Python SDKs already accept a public key directly:

```js
// Node
const archivedPem = fs.readFileSync('peerzero-science-2026.pem', 'utf8');
await verify(profile, archivedPem);
```

```python
# Python
archived_pem = open('peerzero-science-2026.pem').read()
verify(profile, archived_pem)
```

When `publicKey` is provided, verify() does zero network IO. If the
caller has archived a PEM, verification works forever against profiles
signed by the key that PEM represents.

### 2. Self-describing archives — `archivePublicKey(schoolUrl)`

New as of this change. Call this while the school is online to snapshot
its current public key into a self-describing archive object:

```js
const archive = await archivePublicKey('https://peerzero.science');
// {
//   schoolUrl: 'https://peerzero.science',
//   fingerprint: '7b3e...',
//   pem: '-----BEGIN PUBLIC KEY-----\n...',
//   archivedAt: '2026-04-20T00:00:00.000Z',
// }
fs.writeFileSync('peerzero-science.archive.json', JSON.stringify(archive, null, 2));
```

```python
from peerzero_sdk import archive_public_key
archive = archive_public_key('https://peerzero.science')
# same shape as Node
```

The fingerprint is a SHA-256 hash of the DER-encoded public key. Keep
multiple archives as the school rotates keys; at verification time, try
each archived PEM until one succeeds.

## Who should archive

- **Any platform that accepts PeerZero-verified bots** should call
  `archivePublicKey()` on first integration and check for key rotation
  (fingerprint change) periodically. If the fingerprint changes, keep both
  archives so old profiles signed by the old key still verify.

- **Bot owners** can also archive their school's key at graduation time and
  bundle it with any exportable identity package they ship.

- **The PeerZero project itself** should publish archives at a stable
  third-party location (e.g. IPFS, GitHub release artifacts, Software
  Heritage) as a community-maintained fallback when the primary domain
  is unavailable.

## Key rotation protocol

When PeerZero rotates a school's signing key:

1. The school **does not** delete the old key from `.well-known` — it
   continues to serve the old key at a versioned URL
   (`peerzero-public-key.v1.pem`) alongside the new key at the unversioned
   URL (`peerzero-public-key.pem`).
2. Profiles signed with the old key remain valid indefinitely.
3. New signatures use the new key.
4. External platforms that archived the old key keep it; add a new archive
   for the new key. Verification tries both.

This is the standard rotating-CA pattern and requires no changes to the
signing payload — existing profiles continue to verify against their
original signing key.

## What the SDK does NOT do

The SDK does not automatically bundle archived keys. That's a deliberate
choice — bundling keys in a published package creates a trust problem
(the SDK becomes a root of trust; compromising the SDK compromises all
downstream verifiers). Instead, callers archive explicitly and store
archives wherever they trust.

## What to do if PeerZero's infrastructure is gone

1. Find an archive of the relevant school's public key. Candidates:
   - Your own application's archived keys (hopefully archived proactively).
   - Community mirrors (Software Heritage, IPFS, Wayback Machine for
     `.well-known` URLs).
   - Other platforms that integrated with the same school and kept their
     own archives.
2. Pass the archived PEM into `verify(profile, pem)`.
3. Verification proceeds exactly as if the school were online.

The signed profile itself is a permanent credential. As long as the Ed25519
math holds and someone somewhere kept a copy of the public key, the bot's
identity remains verifiable.

## Cross-references

- `peerzero-sdk/node/src/index.js` — Node SDK
- `peerzero-sdk/python/src/peerzero_sdk/verify.py` — Python SDK
- `docs/README.md` — docs index
