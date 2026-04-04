# Security TODO

Last reviewed: 2026-03-30

---

## Infrastructure Checks (Manual)

These can't be fixed in code — verify with your hosting provider.

- [ ] **Redis server version** — must be 7.4.6+ or 8.0.4+ (CVE-2025-49844 "RediShell", CVSS 10.0, RCE via Lua sandbox escape). Affects any app using BullMQ/ioredis.
- [ ] **Node.js version** — must be 22.22.0+ or 20.20.0+ (Jan 2026 security release: HTTP/2 crash CVE-2025-59465, memory leak via TLS certs CVE-2025-59464, permission model bypasses).
- [ ] **React Native dev server** — bind to `--host 127.0.0.1` when developing (CVE-2025-11953 "Metro4Shell", CVSS 9.8, actively exploited since Dec 2025). Dev-time only, not production.

---

## Completed (2026-03-27)

### Code Fixes (14 issues across 19 files)

**HIGH:**
- [x] Validate LLM proxy URL against allowlist to prevent credential exfiltration (`config.py`)
- [x] Block shell metacharacters in MCP server command strings (`mcp.py`)
- [x] Check SQLite row size via `LENGTH()` before fetching to prevent OOM (`storage_sqlite.py`)

**MEDIUM:**
- [x] Replace PostgREST `.or()` string interpolation with parameterized queries (`bounties.js`)
- [x] Add rate limiting (10/hr per IP) to admin `/api/reconcile` endpoint (`reconcile.js`)
- [x] Validate ADMIN_SECRET is set and >=32 chars in production (`shared.js`)
- [x] Switch web token storage from localStorage to sessionStorage (`api.ts`)
- [x] Remove unsafe single-quote JSON cleanup fallback (`school.py`)
- [x] Add ReDoS timeout (2s SIGALRM) and improved pattern detection (`autonomy.py`)
- [x] Document per-isolate rate limit limitation in proxy (`index.ts`)

**LOW:**
- [x] Make TLS `verify=True` explicit on all httpx clients (8 files)
- [x] Upgrade security event logging from DEBUG to WARNING/INFO (`allowlist.py`, `credential_store.py`)
- [x] Fix `timingSafeEqual` to avoid early return on length mismatch (`index.ts`)
- [x] Add 10MB size limit on profiles before Ed25519 verification (`verify.py`)

### CVE-Specific Fixes
- [x] Fix JWT algorithm confusion (CVE-2026-22817): add `{ algorithms: ['HS256'] }` to `widgets.ts` and `activity-stream.ts`
- [x] Bump `jsonwebtoken` ^9.0.2 -> ^9.0.3 (transitive ReDoS via semver)
- [x] Bump `express` ^4.21.0 -> ^4.21.2 (transitive fixes in cookie, path-to-regexp)
- [x] Pin `h11` >=0.16.0 in bot deps (CVE-2025-43859: HTTP request smuggling)

### CI/CD Additions
- [x] Security scan job: dependency audits (npm audit + pip-audit) + Semgrep static analysis
- [x] `--ignore-scripts` on CI npm installs (mitigates npm supply chain worm, CISA Sep 2025)
- [x] Proxy test job added to CI
- [x] SDK test jobs (Node + Python) added to CI
- [x] School CI now runs all 4 unit test files (was running 2 of 4)
- [x] Schema security test: validates RLS on every table + JWT algorithm restriction check

### Code Fixes (2026-03-30)

**MEDIUM:**
- [x] Add `is_banned` check to `skill-reflections.js` (banned agents could still submit reflections)
- [x] Add ownership verification to bot stop endpoint in `bots.ts` (any logged-in user could stop another user's bot)
- [x] Escape LIKE wildcards (`%`, `_`) and PostgREST filter syntax (`.`, `,`) in `escapeForPostgrest()` (`sanitize.js`)
- [x] Sanitize error messages in `bounties.js` catch-all (was leaking raw Supabase errors to clients)
- [x] Add 90-day audit log cleanup in `agent-loop.ts` (privacy policy promised retention but no code enforced it)

### CVE-Specific Fixes (2026-03-30)
- [x] Update React 19.1.0 -> 19.1.5 (CVE-2025-55182 RSC RCE + CVE-2025-55183/55184/CVE-2026-23864)

### Verified Safe (No Action Needed) (2026-03-30)
- [x] `@supabase/auth-js` 2.99.2 — safe from CVE-2025-48370 (path traversal, needs >=2.69.1)
- [x] PostgreSQL 17.6.1 on Supabase — safe from CVE-2025-1094 (SQL injection) and CVE-2025-8713 (RLS bypass)
- [x] Wrangler 4.78.0 — safe from CVE-2026-0933
- [x] `h11` >=0.16.0 already pinned — safe from CVE-2025-43859

### Verified Safe (No Action Needed)
- [x] Ed25519 (Node SDK uses native `crypto`, not `node-forge` — safe from CVE-2026-33895)
- [x] AES-256-GCM nonces use `crypto.randomBytes()` — safe at current volume
- [x] bcryptjs 72-byte limit — passwords are normal length, API keys use SHA-256
- [x] Stripe webhook — already verified via `constructEvent()`
- [x] Cloudflare Workers — not affected by OpenNext SSRF (CVE-2026-3125)
- [x] No new CVEs for: Express, httpx, ioredis, BullMQ, helmet, Stripe SDK, Supabase JS

---

## Future Considerations

- [ ] Migrate web token storage from sessionStorage to httpOnly Secure cookies with SameSite=Strict
- [ ] Add credential rotation mechanism to bot (currently requires restart)
- [ ] Consider Cloudflare Durable Objects for distributed rate limiting in proxy
- [x] Add Content-Security-Policy header to school API responses (`default-src 'none'; frame-ancestors 'none'` in shared.js setCorsHeaders, added 2026-04-04)
- [ ] Consider pre-hashing long inputs with SHA-256 before bcrypt if input lengths grow
- [ ] Monitor OWASP Top 10 for LLM Applications (prompt injection #1, excessive agency #6, system prompt leakage #7)
- [ ] Monitor OWASP Top 10 for Agentic Applications (ASI01-ASI10, Dec 2025 release)
