# Periodic Audit Checklist

Systematic checks to run periodically across the codebase. Each audit catches a category of issue that linters, type checkers, and tests miss because the code is syntactically correct and works in the happy path — the problems only surface under partial failure in production.

## For Claude: How to Pick What to Run

When the user asks you to "run an audit" or "do a health check" without specifying which one, use the **Audit Log** table at the bottom to decide:

1. **Highest priority:** Any audit marked "Never" that hasn't been run at all
2. **Second priority:** Any audit whose last run is more than 30 days old
3. **Third priority:** Audits most relevant to recent code changes (check git log)

Pick 2-3 audits per session. For each audit, search all 3 systems (peerzero-school, peerzero-app, peerzero-bot) and report findings with file paths, line numbers, severity (critical/high/medium/low), and fix them if the user wants.

**After completing an audit, update the Audit Log table** at the bottom of this file with the date, issue count, and branch/PR name.

## Recommended Cadence

| Frequency | Audits |
|-----------|--------|
| Monthly | #1 Silent Failures, #5 Secrets, #10 Dependencies |
| Quarterly | #2 Race Conditions, #4 Idempotency, #6 Timeouts, #8 Auth Gaps |
| Twice yearly | #3 Unbounded Growth, #7 Stale Cache, #9 Degradation, #11 Dead Code, #12 N+1 Queries |
| After major features | #13 Input Validation, #14 Cross-System Contracts, #15 Error UX |

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

**Last run:** 2026-04-11 — 65 issues found and fixed (all severities, all 3 systems).

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
- Hardcoded credentials, test API keys, or placeholder secrets left in code

**Last run:** Never (partial coverage: secret scanning was done in a previous PR)

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
- Unbounded loops or retries that could spin forever

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
- REST parameter manipulation (changing `bot_id` in request to access another user's bot)
- Missing `requireAuth` middleware on routes that should be protected

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
- Check Node.js and Python runtime versions against EOL dates

**Last run:** Never

---

## 11. Dead Code & Unused Exports

**What it catches:** Code that is no longer called from anywhere, adding maintenance burden and confusion. Also catches feature flags that were never cleaned up and commented-out code blocks.

**What to look for:**
- Exported functions/classes never imported anywhere (use grep for the function name across all 3 systems)
- Routes defined but never mounted on the Express/Vercel router
- Python methods defined on classes but never called (check with grep, not just IDE "find references")
- Database columns that are written but never read (or vice versa)
- Migration files that added tables/columns no longer used
- Feature flags or environment variables checked in code but never set in any `.env` or deployment config
- Commented-out code blocks older than 3 months (check git blame)
- `bots.py` references or patterns that leaked into production code (CLAUDE.md says it's deprecated)
- Unused npm/pip dependencies in package.json/requirements.txt

**Last run:** Never

---

## 12. N+1 Queries & Database Performance

**What it catches:** Database queries inside loops, missing indexes, full table scans, and patterns that work fine at small scale but degrade as data grows.

**What to look for:**
- Queries inside `for` loops (N+1 pattern) — especially in agents.js profile, reviews.js scoring, bounties.js validation
- `SELECT *` when only specific columns are needed (wastes bandwidth + memory)
- Missing indexes on columns used in `WHERE`, `ORDER BY`, or `JOIN` clauses
- `.eq()` filters on non-indexed columns in Supabase queries
- Queries that filter in JavaScript instead of SQL (fetch all rows then `.filter()`)
- Supabase queries without `.limit()` on tables that could have thousands of rows
- Sequential queries that could be parallelized with `Promise.all` / `asyncio.gather`
- Full table scans in the audit log, activity log, or credibility transactions
- PostgreSQL queries missing `EXPLAIN ANALYZE` verification for hot paths

**Last run:** Never

---

## 13. Input Validation at Boundaries

**What it catches:** User input, API requests, or webhook payloads that reach internal logic without proper validation, creating injection risks or unexpected behavior.

**What to look for:**
- Request body fields used without type checking (trusting `req.body.score` is a number)
- String inputs passed to SQL without parameterization (should be none, but verify)
- JSON payloads from external webhooks (Stripe, Expo, platform callbacks) not validated against a schema
- File paths constructed from user input without sanitization
- LLM output parsed as JSON without validation against expected shape
- URL parameters used in redirects without allowlist checking (open redirect)
- HTML/markdown content from users or LLMs rendered without XSS sanitization
- Integer overflow: scores, counts, or amounts that could be negative or extremely large
- Array inputs without length limits (could a user submit 10,000 citations?)

**Last run:** Never

---

## 14. Cross-System Contract Alignment

**What it catches:** Mismatches between what one system sends and what another expects, causing silent data loss or broken features.

**What to look for:**
- School API response fields that the bot expects but the server doesn't always include
- App server calling School endpoints with parameters the School doesn't validate
- Bot sending fields to School that the School ignores (wasted tokens / stale bot code)
- Error response format differences between systems (does the bot handle all School error shapes?)
- Enum values (action types, paper statuses, bounty types) that exist in one system but not another
- Database schema assumptions: does the App assume column names that the School migration hasn't added yet?
- API versioning: if the School adds a required field, do all deployed bots handle it?
- Condenser prompt format: does the School serve prompts in the shape the bot's condenser expects?

**Last run:** Never

---

## 15. Error Message UX & Observability

**What it catches:** Error messages that are unhelpful to users or operators, making debugging harder than it needs to be.

**What to look for:**
- Generic "Internal server error" responses that could include actionable context
- Error messages that expose implementation details (stack traces, SQL errors, file paths) to end users
- Missing correlation IDs / request IDs in logs (can you trace a single request across systems?)
- Inconsistent error response shapes across endpoints (`{ error: string }` vs `{ message: string }` vs `{ errors: [] }`)
- Log messages without enough context (just "Failed" with no entity ID, user ID, or action)
- PII in logs (email addresses, names, IP addresses) that shouldn't be there
- Log levels that are wrong: errors logged as warnings, warnings logged as debug
- Missing structured logging fields (all three systems should log `agentId`/`botId`/`userId` consistently)

**Last run:** Never

---

## 16. Graceful Shutdown & Process Lifecycle

**What it catches:** What happens when a server restarts, deploys, or crashes — are in-flight operations completed or lost?

**What to look for:**
- SIGTERM handling: does the App server finish in-flight HTTP requests before exiting?
- BullMQ workers: are running jobs completed or abandoned on shutdown? (check `connection.quit()`)
- Database connections: are pools drained on shutdown?
- Redis pub/sub: are subscriptions cleaned up?
- Bot main loop: does it finish the current cycle on SIGINT or abort mid-action?
- SQLite: are WAL checkpoints done on bot shutdown? Are connections closed?
- Conversation memory engines: are all engines closed on bot shutdown?
- Vercel serverless: are there any operations that assume long-lived processes? (Vercel functions are ephemeral)
- Scheduled jobs (setInterval): are they cleared on shutdown to prevent duplicate execution?

**Last run:** Never

---

## Audit Log

Track when each audit was last run and what was found/fixed. This helps Claude prioritize which audits are overdue.

**Update this table after every audit run.**

| # | Audit | Last Run | Issues Found | Branch/PR |
|---|-------|----------|-------------|-----------|
| 1 | Silent Failures | 2026-04-11 | 65 found, 65 fixed | claude/silent-failures-check-8N9z2 |
| 2 | Race Conditions | 2026-04-11 | 18 found, 8 fixed (3 critical, 4 high) | claude/silent-failures-check-8N9z2 |
| 3 | Unbounded Growth | 2026-04-11 | 11 found, 3 fixed (2 critical, 1 high) | claude/complete-audits-w4oXD |
| 4 | Retry & Idempotency | 2026-04-11 | 21 found, noted (2 critical need transactions) | claude/silent-failures-check-8N9z2 |
| 5 | Secret Exposure | 2026-04-11 | 12 found, 2 fixed (1 critical downgraded, 3 high design-level) | claude/complete-audits-w4oXD |
| 6 | Timeout & Exhaustion | 2026-04-11 | 12 found, 4 fixed (2 critical, 2 high) | claude/complete-audits-w4oXD |
| 7 | Stale Cache | — | — | — |
| 8 | Authorization Gaps | 2026-04-11 | 9 found, 3 fixed (0 critical, 3 medium) | claude/silent-failures-check-8N9z2 |
| 9 | Degradation Decisions | — | — | — |
| 10 | Dependency Vulns | — | — | — |
| 11 | Dead Code | — | — | — |
| 12 | N+1 Queries | 2026-04-11 | 13 found, 2 fixed (2 critical N+1 patterns batched) | claude/complete-audits-w4oXD |
| 13 | Input Validation | 2026-04-11 | 12 found, 3 fixed (3 critical type/bounds checks) | claude/complete-audits-w4oXD |
| 14 | Cross-System Contracts | — | — | — |
| 15 | Error Message UX | — | — | — |
| 16 | Graceful Shutdown | — | — | — |
