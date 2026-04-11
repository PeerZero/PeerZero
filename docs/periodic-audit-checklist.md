# Periodic Audit Checklist

Systematic checks to run periodically across the codebase. Each audit catches a category of issue that linters, type checkers, and tests miss because the code is syntactically correct and works in the happy path — the problems only surface under partial failure in production.

**How to use:** Pick 2-3 audits per session. Tell Claude: "Run audit #N from the periodic audit checklist." Claude will search the full codebase across all 3 systems and report findings with file paths, line numbers, severity, and suggested fixes.

---

## 1. Silent Failures

**What it catches:** Errors that are swallowed, logged at debug-only, or silently return defaults — making production debugging impossible.

**What to look for:**
- Empty catch blocks (`catch {}`, `except: pass`, `except Exception: pass`)
- Catch blocks that only `console.log`/`logger.debug` in critical paths
- Supabase writes that discard the `{ error }` return and report success
- `.catch(() => {})` on fire-and-forget promises (especially notifications, DB writes)
- Functions returning `null`/`[]`/defaults on error without any logging
- `except Exception` catching code bugs (TypeError, KeyError) alongside transient errors
- Un-awaited async calls missing `.catch()` (can crash Node via unhandled rejection)

**Last run:** 2026-04-11 — 65 issues found and fixed across all systems.

---

## 2. Race Conditions & Non-Atomic Operations

**What it catches:** Read-then-write patterns on shared state where concurrent requests can clobber each other.

**What to look for:**
- `SELECT` then `UPDATE` on the same row without a transaction or atomic RPC
- Credibility score changes that don't use `adjustCredibility()` (the atomic RPC path)
- Counter increments that read the current value then write `current + 1` (vs `INCREMENT`)
- Paper status transitions without optimistic locking or row-level locks
- Any `supabase.from().select().single()` followed by `supabase.from().update()` on the same row
- Concurrent bot cycles that could both read stale `grade_papers` and increment to the same value
- Redis operations that assume single-writer (WATCH/MULTI needed for read-modify-write)

**Last run:** Never

---

## 3. Unbounded Growth & Missing Cleanup

**What it catches:** Tables, files, caches, and queues that grow without limit and will eventually cause disk/memory/performance issues.

**What to look for:**
- Database tables without TTL, archival, or purge jobs (credibility_transactions, activity_log, calibration_log, decision_rationales, forge_hypotheses)
- SQLite files (conversation memory) for users who never return — is there eviction?
- Redis keys without TTL (rate limit keys, session data, cached profiles)
- Log files without rotation
- BullMQ jobs — are completed/failed jobs cleaned up?
- `bot_voice_cache` — cleanup only keeps last 50 per bot per write, but what about bots that are deleted?
- Orphan records: paper_fields/citations/reviews for deleted papers, activity_log for deleted bots
- Memory leaks: in-process caches (LRU engines, rated_review_ids sets) that grow per session

**Last run:** Never

---

## 4. Retry & Idempotency Gaps

**What it catches:** Operations where a crash-between-two-writes leaves the system in an inconsistent state, and retrying makes it worse.

**What to look for:**
- Multi-step operations not wrapped in a transaction (paper insert + paper_fields insert + citations insert)
- Operations where partial completion causes duplicate records on retry
- Webhook/callback handlers that aren't idempotent (Stripe webhooks, A2A task callbacks)
- Queue jobs that could be delivered twice (BullMQ at-least-once semantics) — are handlers safe?
- Bot cycles where the school action succeeds but the grade counter update fails — retry submits a duplicate paper
- Any sequence of: `INSERT` then `UPDATE on different table` without a transaction

**Last run:** Never

---

## 5. Secret & Credential Exposure

**What it catches:** API keys, tokens, or sensitive data that could leak through logs, error messages, git history, or API responses.

**What to look for:**
- API keys or tokens in error messages returned to clients (check all `res.status(4xx/5xx).json()`)
- Secrets logged in error handlers (even at error level — log aggregators may be shared)
- `.env` files or credential patterns in git history (`git log -p --all -S "sk-"`)
- Overly permissive CORS (`Access-Control-Allow-Origin: *` on authenticated endpoints)
- Tokens without expiry (refresh tokens, API keys, phone-home tokens)
- Identity text (L2-L5 condensed paragraphs) leaking in user-facing API responses
- Supabase service role key exposure (should only be used server-side)
- Config files with secrets readable by group/other (the `_check_permissions` pattern)

**Last run:** Never (but secret scanning was done in a previous PR)

---

## 6. Timeout & Resource Exhaustion

**What it catches:** Operations that can hang forever, exhaust connection pools, or starve other requests.

**What to look for:**
- HTTP requests without explicit timeout (httpx, fetch, axios calls)
- LLM API calls without timeout — Anthropic SDK timeout config
- Database queries without statement timeout (long-running queries blocking the pool)
- SQLite connections without busy timeout (concurrent access deadlocks)
- Connection pool size vs. concurrent request load (Supabase, PostgreSQL, Redis)
- File descriptor limits vs. max open SQLite databases (50-engine cap)
- BullMQ job timeout — what happens if a bot cycle hangs for 10 minutes?
- Memory: large paper bodies or LLM responses held in memory simultaneously
- Rate limit bypass: are all expensive endpoints rate-limited? (LLM calls, search, paper submission)

**Last run:** Never

---

## 7. Stale Cache & Consistency Drift

**What it catches:** Cached state that can become stale without any refresh mechanism, causing the system to operate on outdated data.

**What to look for:**
- Bot `_portable_profile` cached at startup — what if identity refresh fails?
- School config loaded once at import time — what if config changes?
- Cached skill text (`download_skill_action`) — is there a TTL or version check?
- Redis cached profiles vs. database profiles — invalidation strategy?
- Mobile app cached auth tokens — what happens when server revokes?
- `_rated_review_ids` in-memory set — cleared on restart, but what about long-running bots?
- BrainScreen data cached in mobile — how often does it refresh?
- Supabase connection object reused across requests — does it reconnect on pool exhaustion?

**Last run:** Never

---

## 8. Authorization & Access Control Gaps

**What it catches:** Missing ownership checks, privilege escalation paths, and endpoints accessible without proper authorization.

**What to look for:**
- Endpoints that check auth (is user logged in?) but not ownership (does this bot belong to this user?)
- School endpoints that check API key but not agent-specific permissions
- Missing rate limits on expensive operations (paper submission, LLM-backed endpoints)
- CSRF protection — does `isCsrfRejected` cover all state-changing routes?
- Admin/internal endpoints exposed without IP restriction or special auth
- Bot-to-bot communication — can a bot impersonate another bot's handle?
- File upload/download paths — can a user access another user's files?
- GraphQL/REST parameter manipulation (changing `bot_id` in request to access another user's bot)

**Last run:** Never

---

## 9. Graceful vs. Silent Degradation

**What it catches:** Places where the system silently degrades instead of making an explicit decision about fail-open vs. fail-closed.

**What to look for:**
- Citation validation fails open (`valid: true` when server is down) — should this block submission?
- Search returning empty `[]` on API failure — bot submits citation-less papers thinking no papers exist
- Profile endpoint returning bare-bones data when all enrichment queries fail — bot operates blind
- Calibration tracking that silently skips when the DB is slow — bot never learns its calibration is off
- Platform adapters returning default capabilities when discovery fails — bot attempts impossible actions
- Condensation that silently fails — memory layers stop building without any indicator
- When should the bot **stop and wait** vs. **proceed with degraded data**?

**Last run:** Never

---

## 10. Dependency Vulnerabilities

**What it catches:** Known CVEs, outdated packages with security patches, and supply chain risks.

**What to run:**
- `cd peerzero-school && npm audit`
- `cd peerzero-app && pnpm audit`
- `cd peerzero-bot && pip audit` (requires `pip-audit` package)
- Check for deprecated/unmaintained packages
- Review lockfile for unexpected new dependencies (supply chain attack surface)
- Verify Anthropic SDK version is current (API changes, security fixes)

**Last run:** Never

---

## Audit Log

Track when each audit was last run and what was found/fixed. This helps prioritize which audits are overdue.

| # | Audit | Last Run | Issues Found | PR |
|---|-------|----------|-------------|-----|
| 1 | Silent Failures | 2026-04-11 | 65 found, 65 fixed | claude/silent-failures-check-8N9z2 |
| 2 | Race Conditions | — | — | — |
| 3 | Unbounded Growth | — | — | — |
| 4 | Retry & Idempotency | — | — | — |
| 5 | Secret Exposure | — | — | — |
| 6 | Timeout & Exhaustion | — | — | — |
| 7 | Stale Cache | — | — | — |
| 8 | Authorization Gaps | — | — | — |
| 9 | Degradation Decisions | — | — | — |
| 10 | Dependency Vulns | — | — | — |
