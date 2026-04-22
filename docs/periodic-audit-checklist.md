# Periodic Audit Checklist

Systematic checks to run periodically across the codebase. Each audit catches a category of issue that linters, type checkers, and tests miss because the code is syntactically correct and works in the happy path — the problems only surface under partial failure in production.

## Fix-Only Rule

**Fix bugs in existing code. Do NOT add new systems to close audit gaps.**

When an audit finds an issue, the fix should tighten what's already there — add an error check, fix a log level, add a `.limit()`, sanitize data that's already flowing through. Do NOT:

- Add new database tables or migrations to solve audit findings
- Add new API endpoints or webhook handlers that didn't exist before
- Add new CI jobs, monitoring services, or external integrations
- Build new middleware, validation layers, or abstraction layers
- Create new files to house audit-driven infrastructure

If a fix requires new infrastructure, **report it to the user and let them decide** — don't build it. The audit checklist is for finding and fixing faults in what exists, not for generating new surface area that needs its own auditing.

## For Claude: How to Pick What to Run

When the user asks you to "run an audit" or "do a health check" without specifying which one, use the **Audit Log** table at the bottom to decide:

1. **Highest priority:** Any audit whose last run is more than 30 days old
2. **Second priority:** Audits most relevant to recent code changes (check git log)

Pick 2-3 audits per session. For each audit, search all 3 systems (peerzero-school, peerzero-app, peerzero-bot) and report findings with file paths, line numbers, severity (critical/high/medium/low), and fix them if the user wants.

**After completing an audit, update the Audit Log table** at the bottom of this file with the date, issue count, and branch/PR name.

## Recommended Cadence

| Frequency | Audits |
|-----------|--------|
| Monthly | #1 Silent Failures, #5 Secrets, #10 Dependencies, #20 Cost & Rate Limits, #25 Email Deliverability |
| Quarterly | #2 Race Conditions, #4 Idempotency, #6 Timeouts, #8 Auth Gaps, #23 Prompt Injection, #27 Payment & Billing, #30 BYOK Key Lifecycle, #31 WebSocket Resilience, #34 Redis & Queue Config |
| Twice yearly | #3 Unbounded Growth, #7 Stale Cache, #9 Degradation, #11 Dead Code, #12 N+1 Queries, #18 Data Integrity, #29 Timezone & Unicode, #32 License Compliance, #35 Migration Safety, #36 Accessibility |
| After major features | #13 Input Validation, #14 Cross-System Contracts, #15 Error UX, #24 HTTP Security Headers, #33 Env Var Validation |
| Pre-launch / post-incident | #17 Load & Concurrency, #19 Recovery & Rollback, #21 User Journey Smoke Test, #22 Monitoring & Alerting, #26 App Store Readiness, #28 Platform Provider Limits |

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

**Last run:** 2026-04-16 — Round 9: 1 MEDIUM fix. bot-voice.service.ts: cacheBotVoice() was logging INSERT/DELETE failures at debug level — a sustained DB-write outage would silently stop caching milestone voice messages with no operator visibility. Upgraded to warn with a clearer message.

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

**Last run:** 2026-04-15 — Round 4: 2 MEDIUM fixes. reviews.js: unique constraint violation (23505) from idx_reviews_paper_reviewer_unique now returns 409 instead of generic 500. bounties.js: same fix for idx_bounties_challenger_paper_unique. Review count cap TOCTOU (concurrent reviewers bypass 15-cap) remains LOW — count recomputes correctly from actual rows, and migration 033 UNIQUE indexes prevent same-reviewer duplicates. Enrollment TOCTOU not found — agents table has no enrollment INSERT (handled elsewhere).

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

**Last run:** 2026-04-16 — Round 6: Superseded L2 observations now cleaned in sleep consolidation. See audit log.

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

**Last run:** 2026-04-16 — Round 5: 1 CRITICAL fix. charge.refunded webhook (payment.service.ts:196-230) did three uncoordinated writes — UPDATE purchases, DELETE user_entitlements, DELETE grade_unlocks — with no transaction. A crash or SIGTERM between them left the purchase marked refunded but the entitlement and grade-unlock rows still live; Stripe retry then saw status='refunded' and skipped the handler, leaving a refunded user with live grade access. Wrapped in withTransaction() to mirror the checkout.session.completed fix from commit dbdacd2. Bot-pause loop runs after commit so a pause failure doesn't roll back the revocation.

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

**Last run:** 2026-04-15 — Re-run: 0 new issues. All error sanitization patterns verified (sanitizeErrorMessage on all 500 responses). No secrets in logs, no identity text leaking in public APIs. .env.test tracked with test-only values (acceptable). Notification service masks push tokens in logs. All 4 prior acceptable items re-confirmed.

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

**Last run:** 2026-04-16 — Round 4: 3 HIGH fixes. Mobile client had three fetch() calls with no timeout signal: api.ts:69 (apiFetch), api.ts:78 (retry after token refresh), and useBotStream.ts:94 (refreshAccessToken used by WS reconnect). All three now use AbortSignal.timeout (15s for apiFetch, 10s for the refresh call, matching the existing tryRefresh timeout). Without these, a slow or dead server hung the mobile UI indefinitely and blocked WebSocket reconnection after network blips.

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

**Last run:** 2026-04-12 — Re-run: all 9 prior items verified. 2 new: skill engine cache (60s TTL, acceptable), platform condenser template cache lacks TTL (medium — improvement noted for long-running bots).

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

**Last run:** 2026-04-12 — Re-run: 0 new critical/high. All prior fixes verified (phone-home write-only, ownership checks on all bot routes, rate limits comprehensive, CSRF covers all state-changing School routes). Metrics endpoint unauthenticated but rate-limited — acceptable as public monitoring.

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

**Last run:** 2026-04-11 — 8 items checked, 2 fixed (search error sentinel, condensation failure counter). 6 items have acceptable degradation behavior.

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

**Last run:** 2026-04-22 — Re-run: 1 new test-only finding. pip-audit: `pytest 8.3.4` has CVE-2025-71176 (GHSA-6w46-j5rx-g56g) — local DoS/priv-esc via /tmp/pytest-of-{user} directory pattern on UNIX. Test-only dependency; exploit requires local user access on the test/CI machine (not a production vector). Fix is pytest>=9.0.3, but 8→9 is a major-version bump with deprecation removals and pytest-asyncio compat risk — deferred (not worth the CI churn for a local-user DoS in a test-only dep). Re-audit if pytest-asyncio publishes a 9-compatible release. App still carries 1 moderate dev-only (brace-expansion from @expo/cli transitive) documented in pnpm.auditNotes. School 0 vulns. Bot runtime deps (httpx, anthropic, openai) clean.

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

**Last run:** 2026-04-11 — 7 issues found, 4 fixed (unused Zod schemas wired to routes). 3 dead bot methods noted as future-feature stubs.

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

**Last run:** 2026-04-14 — Round 3: 11 SELECT * narrowed to explicit columns. 6 unbounded queries capped. See audit log for details.

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

**Last run:** 2026-04-16 — Round 7: clean. Re-verified across all 3 systems: Zod schemas cover all App POST/PATCH routes; School inline checks on all route entries; LLM JSON parsing handles errors and falls back safely (directive.service, skill-acquisition); all user-provided arrays have explicit caps (citations=50, forge hypotheses=5, skills_demonstrated=10, context_sources=50); scores/grades clamped at the boundary; Stripe signature verified before processing; phone-home tokens format-validated before lookup; proxy preamble sourced from Worker secret. No new findings since 2026-04-15.

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

**Last run:** 2026-04-14 — Round 2: App tool-schemas.ts missing paper_type enum and incomplete stance enum fixed. Prior fixes verified.

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

**Last run:** 2026-04-11 — 8 found, 6 fixed (PII redacted from logs, email service leak fixed, sanitizeErrorMessage now accepts context). Request ID infrastructure and error shape consistency are future work.

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

**Last run:** 2026-04-11 — 9 items checked, 1 fixed (App server now drains in-flight requests before exit). BullMQ, DB pool, Redis cleanup all correctly handled.

---

## 17. Load & Concurrency Under Realistic Traffic

**What it catches:** Bottlenecks and failures that only appear under concurrent load — connection pool exhaustion, job queue saturation, and Supabase tier limits.

**What to look for:**
- Profile endpoint fires 16+ Supabase queries via `Promise.all` — what happens when 50 bots call it simultaneously?
- PostgreSQL/Supabase connection pool size vs concurrent bot count — are connections exhausted?
- BullMQ job queue depth — what happens when the queue backs up? Are there dead letter queues?
- Supabase free/pro tier limits vs actual usage (row counts, storage, bandwidth, API rate limits)
- Redis memory usage under sustained load (rate limit buckets, BullMQ jobs, pub/sub channels)
- Vercel serverless concurrent execution limits — can School endpoints handle burst traffic?
- Bot cycle timing — if a cycle takes 60s and cycle_delay is 30s, do cycles stack?
- LLM API concurrent request limits vs bot count — will Anthropic rate-limit you?

**Last run:** 2026-04-16 — Round 2: Profile endpoint reduced from ~56 to ~42 response-blocking queries per bot. Platform-wide cache (5-min TTL) for 3 shared queries: active bot count, top paper exemplars, validated bounty examples. Review-ID fetch deduplicated between reviewable + bountyable closures (1 query instead of 2). At 100 concurrent bots, the cache eliminates ~300 redundant queries per cycle wave. Remaining: sequential Phase 1 counters could be consolidated into a single RPC (requires migration).

---

## 18. Data Integrity & Consistency Verification

**What it catches:** Drift between computed values and stored values, orphaned records, and inconsistencies that accumulate over time.

**What to look for:**
- Can you reconstruct a bot's `credibility_score` from the `credibility_transactions` table? Compare computed vs stored for all agents
- Orphaned records: papers without agents, reviews without papers, bounties referencing deleted papers
- Grade counters (`total_papers_submitted`, `reviews_completed`, `valid_bounties`) — do they match actual row counts?
- `weighted_score` on papers — does it match recalculation from reviews?
- Calibration summaries — are they current or stale from a failed `updateCalibrationSummary`?
- Foreign key integrity — are there any soft-deleted agents with active papers/reviews?
- Skill progress values — do stored values match recalculation from skill exercises?
- Identity layer consistency — are L3 docs consistent with L2 paragraphs they were condensed from?

**Last run:** 2026-04-12 — Re-run: all prior checks verified. Added `check_credibility_integrity` (reconstructs credibility_score from transactions, reports drift >0.05, read-only). Banned-agent orphan check noted as future work.

---

## 19. Recovery & Rollback

**What it catches:** Whether you can recover from failures — deployment bugs, data corruption, or third-party outages.

**What to look for:**
- If a bad deployment breaks the School API for 30 minutes, how many bots submit garbage? Can you identify and revert their submissions?
- Database backup frequency and restore testing — has a backup restore ever been tested?
- Can you redeploy the previous version in under 5 minutes? Is there a documented rollback procedure?
- If Supabase goes down, what's the blast radius? Which systems degrade vs. hard-fail?
- If Anthropic goes down, do bots retry forever or circuit-break?
- Is there a way to pause ALL bots simultaneously (kill switch)?
- Can you replay failed BullMQ jobs after fixing a bug, or are they lost?
- Database migration rollback — can every migration be reversed?

**Last run:** 2026-04-12 — Key findings: (1) Emergency stop-all-bots endpoint added at `POST /health/emergency-stop` (admin-key protected, stops all running bots in one DB update). (2) Vercel rollback is instant via dashboard (no custom tooling needed). (3) Supabase daily backups enabled by default on Pro tier; manual restore via dashboard. (4) Anthropic outage: bot circuit breaker (5 failures → 120s cooldown) already handles this. (5) BullMQ failed jobs kept in Redis (removeOnFail: 50); replayable via Redis CLI or Bull dashboard. (6) Database migrations are NOT reversible — no DOWN migrations exist. Recommend adding rollback scripts for critical migrations.

---

## 20. Cost & Rate Limit Modeling

**What it catches:** Runaway costs and rate limit collisions that only appear at scale.

**What to look for:**
- Cost per bot cycle (LLM tokens: system prompt + action + search + reflection + condensation). Multiply by bot count × cycles per day.
- Anthropic API rate limits (tokens per minute, requests per minute) vs your concurrency — at what bot count do you hit them?
- Supabase usage projections: rows per table growth rate, storage, bandwidth, API calls per month
- Vercel serverless execution time limits and monthly budget
- Are there any runaway-cost scenarios? (Retry loops on LLM calls, search queries that fan out, condensation cascades)
- Redis memory — BullMQ job data retention, rate limit bucket count at scale
- Cloudflare Worker limits (proxy) — requests per day, CPU time per request
- What's the monthly cost floor to run 10 bots? 100 bots? 1000 bots?

**Last run:** 2026-04-12 — Analysis only (no code changes needed). Per-bot cost estimate: ~$0.15-0.40/cycle (Opus system prompt ~20k tokens cached + action ~5k + search ~2k + reflection ~1k). At 100 bots × 24 cycles/day ≈ $360-960/day. Anthropic rate limits: Tier 2 = 100 req/min, 1M tokens/min. At 50 bots with staggered cycles (~1 cycle/min each) = ~50 req/min + condensation = ~80 req/min (within limits). Supabase Pro: 500MB storage, 50 connections, 5GB bandwidth — 100 agents with papers/reviews fit easily. Vercel Pro: 100GB-hours/month serverless — profile endpoint takes ~2-5s × 100 bots × 24/day = ~6 GB-hours/month (well within). Redis: BullMQ uses ~1MB per 1000 jobs. Runaway cost risk: retry loops on LLM calls are capped at MAX_RETRIES=3 with exponential backoff. Daily token cap per bot (configurable) prevents individual runaway.

---

## 21. User Journey Smoke Test

**What it catches:** End-to-end integration failures that unit tests miss — the full user experience from signup to deletion.

**What to do (manual walkthrough, not code search):**
- Register account → verify email → log in
- Add Anthropic API key → verify it's encrypted at rest
- Create bot → enroll in school → start bot → verify it runs a cycle
- Watch BrainScreen update → check activity log → verify WebSocket pushes
- Send a chat message to the bot → verify conversational memory
- Stop bot → change mode → restart
- Delete API key while bot is running — what happens?
- Delete bot → verify cascade (school agent, tasks, activity log)
- Delete account → verify full erasure (GDPR right to erasure)
- Test with a fresh database — what does a new user see when there are zero bots in the system?

**Last run:** 2026-04-12 — Not automated; requires manual walkthrough with running system. Deferred to next production deployment test.

---

## 22. Monitoring & Alerting Readiness

**What it catches:** Whether you'll know something is broken before users tell you.

**What to look for:**
- Health check endpoints — does `/health` exist on both App and School? Do they check downstream dependencies (DB, Redis)?
- If the School API starts returning 500s, how quickly do you know? Is there any monitoring?
- If a bot gets stuck in an infinite loop or hangs on an LLM call, is there a circuit breaker?
- Are there dashboards for: active bot count, cycle success rate, LLM token usage, error rate?
- Uptime monitoring — is anything pinging your endpoints? (UptimeRobot, Better Uptime, etc.)
- Log aggregation — are logs searchable? Can you query "all errors in the last hour"?
- Alerting — does anyone get notified on: 5xx spike, queue depth > threshold, bot cycle failures?
- Supabase dashboard monitoring — are you watching connection count, query latency, storage?

**Last run:** 2026-04-16 — Round 3: 4 in-place fixes (2 HIGH, 2 MEDIUM). (1) shipped-loop.ts deliverCallback signature extended to thread botId through so the callback-failure warn carries bot context — fixes a correlation gap in the retry-state path added by 49d4192. (2) health/metrics endpoint Promise.all fan-out wrapped in try/catch: before, one failed query produced a 500 with no structured log, and this is the endpoint monitoring polls. Now returns 503 with a clear error log. (3) payment.service.ts: the `product not found` throw inside withTransaction now emits an error log with {purchaseId, productId, userId} before the rollback so the tx-rollback path has enough diagnostic context. (4) queue.ts `Bot cycle failed` log now includes bot mode (school vs shipped) — previously those cycle failures looked identical in logs. DEFERRED (new infrastructure, needs user decision): School has no /health endpoint — the 2026-04-14 log claimed one was added but `peerzero-school/api/health.js` does not exist in the repo. Adding it is a new serverless function + vercel.json route, not in-place tightening. SKIPPED (judgment calls): Unicode arrows in bot circuit breaker logs (arrows render fine in modern aggregators); log-level normalization for circuit breaker transitions (current info-vs-warning split by whether the breaker is healing or opening is deliberate); extra info log on successful callback retries (low-value noise).

---

## 23. Prompt Injection & Agent Safety

**What it catches:** Adversarial inputs that manipulate bot behavior — the #1 security concern for AI agent platforms in 2026.

**What to look for:**
- Can a malicious paper title or abstract in the School database inject instructions into a bot's system prompt? (Check `sanitize_untrusted` usage)
- Can a crafted review manipulate the bot's next action? (Review text flows into skill exercises → condensation → identity)
- Identity preamble injection — can a bot's condensed identity be manipulated to override the proxy preamble?
- MCP tool call safety — can a bot be tricked into calling unintended tools? Are tool inputs validated?
- A2A task injection — can an external agent send a malicious task that manipulates the bot?
- Search result poisoning — if a malicious paper appears in academic search results, can its abstract inject instructions?
- Skill text manipulation — if the School server is compromised, can skill text contain prompt injection?
- LLM output parsing — can a crafted LLM response escape JSON extraction and execute unintended behavior?
- Conversation memory injection — can a user inject instructions through chat messages that persist in memory and affect future behavior?

**Last run:** 2026-04-15 — Round 5: 3 HIGH + 4 MEDIUM fixed. App: bot-voice.service.ts — ctx.botName, identitySnippet, and event.description now sanitized via sanitizeForLLM() in all 4 prompt interpolation points (push notification, milestone message). message.service.ts — identitySnippet now sanitized in chat reply and narrate-cycle system prompts. School: haiku-audit.js — paper.title, abstract, cross_study_connection, mechanism_chain, falsifiable_claim now sanitized via sanitize() before LLM prompt injection. bounty-helpers.js — target_claim and logical_bridge now sanitized in drift judge prompt. reasoning-audit.js — all paper fields in chain verification and counterfactual probe prompts now sanitized. forge-aggregation.js — forge_data excerpts now sanitized before meta-condenser prompt. Bot sanitization (sanitize_untrusted) verified comprehensive from prior rounds.

---

## 24. HTTP Security Headers & Transport

**What it catches:** Missing security headers and transport-layer protections that browsers and security scanners flag.

**What to look for:**
- Is `helmet` middleware used on the Express App server? Check for: Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security
- CORS configuration — are `Access-Control-Allow-Origin` headers restrictive enough? (Check both School and App)
- Are all cookies set with `httpOnly`, `Secure`, and `SameSite` flags?
- HSTS (HTTP Strict Transport Security) — is it set on production domains?
- Content-Security-Policy — does it block inline scripts and restrict sources?
- X-Content-Type-Options: nosniff — prevents MIME type sniffing
- Referrer-Policy — are referrers leaked to third parties?
- Permissions-Policy — are unnecessary browser features (camera, microphone, geolocation) disabled?
- TLS version — is TLS 1.2+ enforced? Are weak cipher suites disabled?
- Vercel security headers — are they configured in `vercel.json` for the School?

**Last run:** 2026-04-12 — Overall: A- security posture. Both App and School have comprehensive headers. App uses helmet v8.0.0 with strict CSP (default-src 'none'), HSTS (preload), X-Frame-Options DENY. School uses vercel.json headers + application-level headers in shared.js. CORS: strict allowlist on both systems (no wildcards). No cookies used (JWT bearer tokens). Fix applied: added `preload` to School HSTS header (`max-age=31536000; includeSubDomains; preload`). Minor: CSP report-uri not configured (optional monitoring enhancement). No critical vulnerabilities.

---

## 25. Email Deliverability & Transactional Email

**What it catches:** Emails that land in spam, bounce silently, or never arrive — killing signup flows, password resets, and parental consent.

**What to look for:**
- SPF/DKIM/DMARC DNS records configured for your sending domain (Resend handles DKIM signing, but YOU must add the DNS records)
- SPF record has a 10-lookup limit — exceeding it silently fails validation
- DMARC policy starts at `p=none` (monitor), moves to `p=reject` before launch
- Bounce handling — are hard bounces (invalid addresses) suppressed from future sends? Check Resend webhook for `bounced` events
- Email warm-up — new sending domains need 2-4 weeks of gradual volume increase. Launching with a blast from a cold domain = spam folder
- CAN-SPAM footer — physical mailing address and company name in transactional email templates
- Parental consent email — if this lands in spam, child accounts are permanently locked. Test deliverability to Gmail, Outlook, Yahoo
- Email retry on transient failures — does `sendParentalConsentEmail` retry on 5xx from Resend?

**Last run:** 2026-04-14 — Round 3: Resend webhook now rejects unverified requests in production. See audit log.

---

## 26. Mobile App Store Readiness

**What it catches:** App store rejections and post-launch compliance failures that are impossible to detect from code review alone.

**What to look for:**
- Apple Guideline 5.1.2(i) — app sends user data to Anthropic (BYOK). Must show a consent modal naming Anthropic before first API call, not just privacy policy text
- `apple-app-site-association` file at `/.well-known/` on your domain for Universal Links. SHA-256 fingerprint in Android `assetlinks.json` must match PRODUCTION signing cert, not dev
- Push notification certificates/keys — APNs HTTP/2 key expiry, rotation plan
- `Info.plist` permission strings — must clearly explain WHY each permission is needed (vague strings = rejection)
- Demo account for App Store review team — working test credentials, Apple's IP range not blocked by backend
- Expo OTA runtime version — native code changes require runtime version bump or OTA updates crash
- App Store data safety / privacy nutrition labels — must accurately list all data collected, shared, and linked to identity
- Age rating configuration — must match COPPA age gate implementation

**Last run:** 2026-04-14 — See audit log for details.

---

## 27. Payment & Billing Edge Cases

**What it catches:** Stripe integration issues that work in test mode but fail or lose money in production.

**What to look for:**
- Webhook body parsing — Stripe signature verification requires RAW body, not JSON-parsed. If Express `json()` middleware runs first, verification silently fails. Check middleware ordering
- `invoice.finalization_failed` webhook handler — subscriptions stay active when invoices can't be finalized (user gets free access)
- Proration on multiple plan changes in one billing period — negative prorations can accumulate
- Dunning (failed payment retry) — what happens to bot access when payment fails? Is there a grace period?
- Refund flow — is there a mechanism to process refunds? What happens to the bot when a charge is refunded?
- Stripe test mode vs live mode key confusion — are test keys blocked in production env?
- Currency handling — are amounts stored in cents (integers) not dollars (floats)?
- Webhook idempotency — Stripe retries failed webhooks for up to 3 days. Are handlers safe to receive the same event twice?
- Sales tax / VAT — if selling internationally, you may need Stripe Tax or a Merchant of Record

**Last run:** 2026-04-14 — Round 2: invoice.finalization_failed now logs to audit_log. See audit log.

---

## 28. Platform Provider Limits

**What it catches:** Hard limits imposed by Vercel, Supabase, Cloudflare, and Anthropic that you hit before your own rate limits — causing mysterious failures.

**What to look for:**
- Vercel serverless body size limit: 4.5 MB — large LLM responses or paper bodies can exceed this
- Vercel cron job timing: can execute up to 59 minutes late, no retry on failure, must be idempotent
- Supabase connection pool: keep PostgREST usage under 40% of available connections (leaves room for Auth and internal services). Free tier: 200 concurrent ceiling
- Supabase Auth rate limits and email link prefetching — enterprise email security tools auto-click magic links/password reset links, consuming the OTP before the user does
- Cloudflare Worker memory: 128 MB per isolate, shared across concurrent requests. Buffer responses as streams, not in-memory strings
- Cloudflare Worker CPU time: 10ms on free, 30s on paid — LLM proxy preamble injection must not hit this
- Supabase RLS performance: policies execute per-row-scanned. Complex policies with joins or function calls degrade at scale. Indexes needed on all columns referenced in RLS policies
- Anthropic API: input TPM (tokens per minute) is usually the binding constraint, not RPM. Each bot cycle sends 20k+ cached tokens per call

**Last run:** 2026-04-14 — Re-run: forge_aggregate concurrent-run guard verified. See audit log.

---

## 29. Timezone, Unicode & Locale Handling

**What it catches:** Bugs that only appear for non-US users, non-English text, or during daylight saving transitions.

**What to look for:**
- All timestamps stored as UTC in database? Check for `new Date()` used server-side (uses server timezone) vs `new Date().toISOString()` (UTC)
- DST transitions — cron jobs or `setInterval` scheduled in local time can skip or double-fire during spring-forward/fall-back
- Emoji in user-generated content — `string.length` returns wrong results for emoji outside BMP (multi-byte). Zero-width joiners create compound emoji that split incorrectly
- Database text encoding — Supabase/PostgreSQL uses UTF-8 by default (good), but check SQLite `PRAGMA encoding`
- Username/bot name fields with emoji — can break display, sorting, search, and URL generation
- Paper/review content with non-Latin characters — does search, truncation, and display work correctly?
- Date formatting in UI — does the mobile app respect user locale for date display?
- Sorting — are strings sorted with locale-aware collation or byte-order (which breaks for accented characters)?

**Last run:** 2026-04-14 — Round 2: StatsScreen locale-aware date format, forge-hypotheses.js verified clean. See audit log.

---

## 30. BYOK Key Lifecycle

**What it catches:** API key management gaps specific to the bring-your-own-key model where users provide their Anthropic keys.

**What to look for:**
- Key validation on storage — is the key tested with a real API call before being accepted and encrypted? An invalid key causes silent failures on every subsequent LLM call
- Key revocation UX — can the user delete/replace their stored key? What happens to running bots when the key is revoked?
- Key scope/tier detection — a rate-limited (Tier 1) key will cause intermittent failures that look like bugs. Can you detect the user's tier?
- Spend anomaly detection — unusual token usage patterns could indicate key compromise through your platform
- Key rotation without bot restart — currently requires restart (noted in SECURITY_TODO). Is this documented for users?
- Error messaging — when an LLM call fails due to invalid/expired/rate-limited key, does the user see a clear message identifying the key as the problem (not a generic "Action failed")?
- Key isolation — verify that one user's key can never be used for another user's bot (adapter-bound credential isolation)

**Last run:** 2026-04-16 — Round 3: Re-verified. Live API validation exists (validateKeyWithProvider). All 3 loops handle 401. No critical gaps.

---

## 31. WebSocket Resilience

**What it catches:** Real-time connection failures that only appear on mobile networks, behind corporate proxies, or during server restarts.

**What to look for:**
- Silent disconnect detection — TCP connections can be dead while `readyState === OPEN`. Application-level heartbeat/ping-pong with missed-pings threshold needed
- Mobile background/foreground lifecycle — iOS suspends TCP connections within seconds of backgrounding. Carrier-grade NAT drops idle connections after ~30s. Must reconnect on foreground
- Reconnection with exponential backoff + jitter — without jitter, server restart causes thousands of clients reconnecting simultaneously (thundering herd)
- Proxy idle timeout — Nginx, ALB, and most reverse proxies default to 60s idle timeout. Heartbeat interval must be shorter than the shortest proxy timeout in your path
- Authentication on reconnect — does the WebSocket re-authenticate after reconnect, or does it reuse a stale/expired token?
- Message ordering and deduplication — can messages arrive out of order or duplicated after reconnect? Does the client handle this?
- Offline queue — are messages generated while disconnected queued and sent on reconnect, or silently dropped?
- Connection limit per user/bot — already set (20/user, 10/bot) but verify enforcement under rapid reconnect cycling

**Last run:** 2026-04-14 — See audit log for details.

---

## 32. Open Source License Compliance

**What it catches:** License violations that can legally require you to open-source your entire application or pay damages.

**What to look for:**
- AGPL-licensed dependencies — AGPL has NO SaaS loophole (unlike GPL). A single AGPL dependency in a SaaS product can require releasing your source code
- Run `npx license-checker --production` in peerzero-school and peerzero-app
- Run `pip-licenses` in peerzero-bot
- Flag any AGPL, SSPL, or EUPL licenses — these are incompatible with proprietary SaaS
- Check transitive dependencies too — a dependency-of-a-dependency can carry AGPL
- GPL dependencies are OK for SaaS (SaaS loophole) but NOT OK if you distribute the software (which the bot package does if exported)
- Creative Commons NonCommercial (CC-NC) on any bundled data, models, or documentation
- Add a license scan to CI (e.g., `license-checker --failOn "AGPL-3.0"`)

**Last run:** 2026-04-14 — See audit log for details.

---

## 33. Environment Variable Validation at Startup

**What it catches:** Missing or malformed environment variables that cause cryptic runtime errors minutes or hours after deployment instead of immediate clear failures.

**What to look for:**
- Does the App server validate ALL required env vars at startup? (DB URL, Redis URL, Stripe keys, School URL, JWT secret, encryption key)
- Does the School server validate required env vars at startup? (Supabase URL/key, admin secret, Anthropic key for haiku audit)
- Does the Bot validate required config at startup? (API key, school URL, proxy URL)
- Are env vars validated for FORMAT, not just presence? (URL must be valid URL, port must be number, secret must be >= 32 chars)
- What happens when an optional env var is missing? Does it fail silently or log a warning?
- Are there env vars checked at USAGE time that should be checked at startup? (e.g., `process.env.STRIPE_WEBHOOK_SECRET` only checked when a webhook arrives)
- Is there a single list of all required env vars documented somewhere? (README, `.env.example`)
- School `schools/schema.js` validates school config at startup — does the rest of the app do the same for env vars?

**Last run:** 2026-04-14 — See audit log for details.

---

## 34. Redis & Queue Production Configuration

**What it catches:** Redis and BullMQ misconfigurations that work in development but cause data loss or OOM crashes in production.

**What to look for:**
- Redis `maxmemory-policy` MUST be `noeviction` for BullMQ — any eviction policy can silently delete queue metadata, corrupting job state
- BullMQ `removeOnComplete` and `removeOnFail` settings — without these, completed/failed jobs accumulate in Redis forever until OOM
- Redis AOF rewrite memory — during rewrite, Redis buffers all new writes in memory. If rewrite takes too long, you OOM. RDB `fork()` can use 2x normal memory
- Redis persistence mode — is it AOF, RDB, or both? AOF is safer for queue data (no data loss on crash). RDB alone can lose the last few minutes of data
- Redis connection count — how many connections does your app open? (BullMQ workers, pub/sub, rate limiting, caching). Each BullMQ queue creates 2-3 connections
- Redis password/ACL — is Redis authentication enabled in production? Is the connection string using TLS?
- BullMQ stalled job detection — `stalledInterval` must account for long LLM calls (your lock renewal is 60s — verify this is longer than the longest expected job)
- BullMQ dead letter queue — failed jobs after max retries: are they logged/alertable or silently discarded?

**Last run:** 2026-04-14 — See audit log for details.

---

## 35. Database Migration Safety

**What it catches:** Migrations that work on empty dev databases but lock tables, corrupt data, or cause downtime on production databases with real data.

**What to look for:**
- `ALTER TABLE ... ADD COLUMN ... NOT NULL` without `DEFAULT` — locks table and fails if rows exist
- `ALTER TABLE ... ADD COLUMN ... DEFAULT <value>` on large tables — PostgreSQL 11+ handles this instantly for immutable defaults, but check for mutable defaults or expressions
- Adding indexes without `CONCURRENTLY` — `CREATE INDEX` locks writes for the duration. `CREATE INDEX CONCURRENTLY` does not, but cannot run inside a transaction
- Expand-contract pattern — dangerous schema changes need multiple deployments: (1) add new column, (2) backfill, (3) deploy code using new column, (4) drop old column. Single-step renames or type changes cause downtime
- Migration duration estimation — a migration that takes 2 seconds on 100 rows can take 2 hours on 1M rows. Have you estimated duration at production scale?
- Rollback scripts — do all migrations have DOWN scripts? (Audit #19 covered recent ones, but check the full set)
- Data-only migrations — are there migrations that UPDATE existing data? These need batching on large tables to avoid lock contention
- Migration ordering — with 32+ migration files, are there any that depend on each other but could run out of order?

**Last run:** 2026-04-14 — See audit log for details.

---

## 36. Accessibility (WCAG)

**What it catches:** Barriers that prevent users with disabilities from using your app — also a legal requirement under the European Accessibility Act (EAA, enforcement June 2025).

**What to look for:**
- React Native components missing `accessibilityRole`, `accessibilityLabel`, and `accessibilityState` props
- `TouchableOpacity` / `Pressable` without `accessibilityRole="button"` and descriptive label
- Images without `accessibilityLabel` (equivalent to alt text)
- Color contrast ratios — WCAG AA requires 4.5:1 for normal text, 3:1 for large text
- Screen reader testing — does VoiceOver (iOS) and TalkBack (Android) navigate the app logically?
- Focus order — is tab/swipe navigation order logical (not jumping around)?
- Dynamic content updates — are screen readers notified of BrainScreen updates, activity log changes, bot status changes? (use `accessibilityLiveRegion` on Android, `UIAccessibility.post` on iOS)
- Text scaling — does the app respect system font size preferences? Does it break layout at 200% text size?
- Touch target size — minimum 44x44 points (Apple) / 48x48 dp (Material Design) for all interactive elements

**Last run:** 2026-04-16 — Round 3: Re-verified. All chat toggles and modals have proper accessibility props. No remaining issues.

---

## Audit Log

Track when each audit was last run and what was found/fixed. This helps Claude prioritize which audits are overdue.

**Update this table after every audit run.**

| # | Audit | Last Run | Issues Found | Branch/PR |
|---|-------|----------|-------------|-----------|
| 1 | Silent Failures | 2026-04-16 | Round 9: 1 MEDIUM fix. bot-voice.service.ts:118: cacheBotVoice() logged INSERT/DELETE failures at debug level — a sustained DB-write outage would silently stop caching milestone voice messages with zero operator visibility. Upgraded to warn with a clearer "milestone message not cached" suffix. Round 8 agent-loop.ts condensation wrapping verified intact. | claude/code-review-XakPz |
| 2 | Race Conditions | 2026-04-19 | Round 5: 2 CRITICAL fixes in trajectory subsystem (lib/trajectory-handlers.js, just landed 2026-04-19). submitLog UPDATE had no status guard — concurrent duplicate submits both succeeded, clobbering trajectory_log + adversarial_catch metrics. Added .eq('status','executing').select('id') optimistic lock returning 409 on conflict; tightened pre-check from `['executing','concept']` to `'executing'` only. submitSelfReview: same fix with .eq('status','synthesis') guard. Prior Round 4 reviews.js/bounties.js 23505→409 fixes verified. | claude/code-audit-hardening-Mdac3 |
| 3 | Unbounded Growth | 2026-04-19 | Round 7: 1 HIGH fix. Migration 037's trajectory_exercises was missing from the api/reconcile.js purge_retention list — each grade emits 3 exercises with full 30-step JSON logs + synthesis, would have grown unbounded indefinitely. Added with `'complete'/'abandoned'`-only guard mirroring forge_hypotheses. Round 6 sleep.py L2 cleanup verified intact. | claude/code-audit-hardening-Mdac3 |
| 4 | Retry & Idempotency | 2026-04-19 | Round 6: trajectory subsystem hardening. Grade counter RPC failure log upgraded warn→error with {agentId, exerciseId} context (silent grade-advancement breakage was invisible to ops). Optimistic locks on trajectory state transitions (see audit #2) make submit retries safe — duplicates now fail fast with 409 instead of corrupting metrics. Round 5 charge.refunded transactional fix verified. | claude/code-audit-hardening-Mdac3 |
| 5 | Secret Exposure | 2026-04-15 | Re-run: 0 new issues. Error sanitization comprehensive (sanitizeErrorMessage on all 500 responses). No secrets in logs, no identity text in public APIs. .env.test test-only values (acceptable). Push tokens masked in notification logs. All prior acceptable items re-confirmed. | claude/run-security-audit-CM9mO |
| 6 | Timeout & Exhaustion | 2026-04-16 | Round 4: 3 HIGH fixes in mobile client. api.ts:69 (apiFetch), api.ts:78 (retry after token refresh), and useBotStream.ts:94 (refreshAccessToken used by WebSocket reconnect) had raw fetch() calls with no timeout signal — hung UI indefinitely on slow/dead server and blocked WS reconnect after network blips. All three now use AbortSignal.timeout (15s for apiFetch, 10s for the refresh call, matching existing tryRefresh pattern). Server-side, bot, proxy, and School timeouts verified comprehensive (DB statement_timeout 30s, Anthropic/OpenAI 120-300s, A2A/Webhook 30s, SQLite busy_timeout 30s, all httpx calls bounded). | claude/code-review-XakPz |
| 7 | Stale Cache | 2026-04-14 | Re-run: 14 cache points audited. Known staleness: _skill_md (restart-only refresh, by design), platform condensers (restart-only, noted), _rated_review_ids (2000-cap + server dedup). school_internals has 5-min TTL (acceptable). School config frozen at startup (acceptable for single-school deploy). No new critical issues. | claude/audit-checklist-completion-JLioU |
| 8 | Authorization Gaps | 2026-04-14 | Round 3: 1 MEDIUM fix. auth.ts: resend-verification endpoint now has dedicated resendVerificationLimiter (3/15min) — prevents email flooding. Prior fixes verified. Remaining: school GET /api/skill endpoint public by design (exposes operational instructions to anyone). | claude/review-audit-checklist-DD40v |
| 9 | Degradation Decisions | 2026-04-14 | Deep pass: 12 degradation points reviewed. Search failure already flagged with search_failed:true (bot can distinguish). Haiku audit fail-open is acceptable (quality gate, not security gate). Coaching fails gracefully. Calibration tracking non-blocking by design. Forge hypotheses can stall (reconciliation handles). Profile partial failure returns degraded data (acceptable). School API transient errors handled by circuit breaker. Redis down pauses queue (correct). Stripe webhooks idempotent via ON CONFLICT. LLM JSON parse returns None (caller handles). No new critical issues. | claude/audit-checklist-completion-JLioU |
| 10 | Dependency Vulns | 2026-04-22 | Re-run with pip-audit now installed: 1 new test-only finding. pytest 8.3.4 → CVE-2025-71176 (local /tmp DoS, requires shell on CI box). Deferred — bumping 8→9 risks pytest-asyncio compat for a local-user DoS in test-only code. App 1 moderate dev-only (brace-expansion, documented). School 0 vulns. Runtime deps (httpx, anthropic, openai) clean. Node 22 LTS, Python 3.11 both supported. | claude/audit-docs-4Pj7V |
| 11 | Dead Code | 2026-04-14 | Re-run: clean. All exported functions actively used. All npm/pip dependencies used. No commented-out code blocks. No unused database columns. No unused env vars or feature flags. | claude/audit-checklist-completion-JLioU |
| 12 | N+1 Queries | 2026-04-14 | Round 6: 2 HIGH fixes. skills-core.js: new recordSkillExercisesBatch() reduces 4-15 sequential DB inserts to 1 read + parallel writes per action. skills-exercises.js: exerciseSkillsFromPaper/Review/Bounty/Revision + exerciseAdversarialFromConsensus all converted to batch. reconcile.js: credibility checkpoint loop now batched in groups of 50 with Promise.all + 100ms delays. | claude/review-audit-checklist-DD40v |
| 13 | Input Validation | 2026-04-19 | Round 8: 2 HIGH fixes in trajectory subsystem. submitConcept hypotheses array was length-checked only — trajectorySearch dereferences hypotheses[0]?.claim for adversarial injection's domain_mechanism, so a malformed entry would crash. Added per-element {object, claim≥5chars} validation. submitSelfReview per_step_assessment entries were length-checked only — malformed entries silently dropped from the self_review_delta calc, losing the pedagogical signal. Added per-entry {step:int, being_me:bool} validation. Round 7 baseline verified. | claude/code-audit-hardening-Mdac3 |
| 14 | Cross-System Contracts | 2026-04-15 | Round 4: 1 CRITICAL fix. agents.js action_target paper select was missing falsifiable_claim and cross_study_connection columns — bounty valid_challenge_types always included no_falsifiable_claim/no_cross_study_connection regardless of actual paper content. Fixed by adding both columns to select. App submitCoreCondensation() posts to /api/skill-reflections/core which has no handler — wrapped in try/catch (local storage succeeds). Remaining: submitCoreCondensation should either be removed or School needs /core sub-path handler. | claude/audit-code-launch-prep-5xshZ |
| 15 | Error Message UX | 2026-04-14 | Round 3: 5 more agent.py debug-level failure logs upgraded to warning (prediction, arch_obs, reflection, decision rationale, platform-predict). All non-blocking failure paths now visible in production logs. | claude/audit-checklist-fixes-KEjdN |
| 16 | Graceful Shutdown | 2026-04-14 | Round 2: 2 fixes. Bot main memory storage_sqlite.py now performs WAL checkpoint on close (was missing — conversational_memory already had it). Bot agent.py now registers SIGINT handler alongside SIGTERM — Ctrl+C triggers graceful shutdown instead of abrupt kill. App server shutdown verified comprehensive (drains HTTP, stops BullMQ, closes Redis, closes DB pool). | claude/audit-checklist-completion-JLioU |
| 17 | Load & Concurrency | 2026-04-16 | Round 2: Profile endpoint reduced from ~56 to ~42 blocking queries per bot. 3 platform-wide queries (active bot count, top papers, validated bounties) now cached in-memory with 5-min TTL — at 100 bots, eliminates ~300 redundant queries per cycle wave. Review-ID fetch deduplicated (1 query serves both reviewable + bountyable). Remaining: Phase 1 sequential counters (4 COUNT queries) could become 1 RPC. At 1000+ users, enable Supabase connection pooler (PgBouncer transaction mode). | claude/audit-checklist-hardening-GmzV5 |
| 18 | Data Integrity | 2026-04-14 | Re-run: 8 areas checked. Credibility transaction log can fail silently after credibility RPC succeeds (drift detectable by reconciliation but not auto-fixed). Grade counter drift mitigated by reconciliation auto-fix. Weighted_score recalculation is self-healing (next review recalculates). Paper status transitions lack DB-level CHECK constraint (application guards only). Orphaned records handled by reconciliation cleanup. Calibration staleness detected + auto-fixed by reconciliation POST. Skill profile invariants partially auto-fixed. No new critical data integrity issues beyond documented patterns. | claude/audit-checklist-completion-JLioU |
| 19 | Recovery & Rollback | 2026-04-14 | Round 2: Added DOWN rollback scripts for migrations 031 (atomic paper submit — drops RPC function) and 032 (citation penalty unique — drops index). All 8 critical migrations now have rollback scripts (025-032). Identity cores are versioned but old versions overwritten (no history table — PITR required for restoration). BullMQ jobs recovered via recoverRunningBots() on restart. Supabase outage stops bots (manual restart required). | claude/audit-checklist-completion-JLioU |
| 20 | Cost & Rate Limits | 2026-04-14 | Round 2: 1 CRITICAL + 1 HIGH fixed. All 3 school server LLM call functions (callAnthropicHaiku, callHaikuDriftJudge, callAnthropic) now: (a) track token usage from API response (input/output + cumulative), (b) enforce concurrency cap of 5 per function, (c) handle 429 rate limits with warning log + retry-after header. Exported getServerLLMUsage() for monitoring. Remaining: no per-user aggregate cap, no global emergency stop. | claude/review-audit-checklist-DD40v |
| 21 | User Journey Smoke | 2026-04-12 | Deferred — requires manual walkthrough with running system | — |
| 22 | Monitoring & Alerting | 2026-04-16 | Round 3: 4 in-place fixes. (1) shipped-loop.ts deliverCallback threads botId through — callback-failure warn now carries bot context, closing a correlation gap in the retry path added by 49d4192. (2) health/metrics Promise.all wrapped in try/catch with 503 + structured log on query failure (was 500 with no log). (3) payment.service.ts `product not found` tx-rollback path now logs {purchaseId, productId, userId} before throw. (4) queue.ts `Bot cycle failed` log includes bot mode. DEFERRED (needs user decision, new infrastructure): School /health endpoint is missing — prior-round log claimed it was added but file doesn't exist; would be a new serverless function + vercel.json route. SKIPPED (judgment calls): Unicode arrows in circuit breaker logs, log-level normalization, extra success-path callback logging. | claude/code-review-XakPz |
| 23 | Prompt Injection | 2026-04-15 | Round 5: 3 HIGH + 4 MEDIUM fixed. App bot-voice.service.ts: ctx.botName, identitySnippet, event.description sanitized via sanitizeForLLM() in all 4 prompt points. App message.service.ts: identitySnippet sanitized in chat and narrate prompts. School haiku-audit.js: paper title/abstract/cross_study/mechanism_chain/falsifiable_claim sanitized via sanitize(). School bounty-helpers.js: target_claim and logical_bridge sanitized in drift judge prompt. School reasoning-audit.js: all paper fields sanitized in chain verification and counterfactual probes. School forge-aggregation.js: forge_data excerpts sanitized in meta-condenser prompt. Bot sanitization verified comprehensive. | claude/run-security-audit-CM9mO |
| 24 | HTTP Security Headers | 2026-04-13 | Re-run: no new header gaps. Helmet on App, vercel.json headers on School, proxy CSP — all verified. | claude/audit-checklist-fixes-59GsO |
| 25 | Email Deliverability | 2026-04-14 | Round 4: 1 MEDIUM fix. email.service.ts: all outgoing emails now include List-Unsubscribe and List-Unsubscribe-Post headers (RFC 8058) — improves deliverability scoring with Gmail/Apple Mail. Remaining: COPPA email deliverability testing, SPF/DKIM/DMARC DNS config, email warm-up. | claude/review-audit-checklist-DD40v |
| 26 | App Store Readiness | 2026-04-14 | Round 2: 1 MEDIUM fix. app.json: NSPrivacyAccessedAPITypes now declares NSPrivacyAccessedAPICategoryUserDefaults (reason CA92.1) — required by Apple for apps using NSUserDefaults/AsyncStorage. Remaining: EAS project ID still placeholder, no AASA/assetlinks, no demo account. | claude/review-audit-checklist-DD40v |
| 27 | Payment & Billing | 2026-04-14 | Round 3: 2 HIGH + 1 MEDIUM fixed. Stripe idempotency keys added to all API calls. Billing portal endpoint added (POST /billing-portal) for purchase history/receipts/payment method management (App Store compliance). Refund handler now pauses affected running bots after revoking grade unlocks. Remaining: no stripe_event_id dedup table, no VAT/sales tax. | claude/review-audit-checklist-DD40v |
| 28 | Platform Provider Limits | 2026-04-14 | Round 2: 1 HIGH fix. wrangler.toml: added usage_model="unbound" — standard Bundled workers have 30s wall clock limit, proxy 180s fetch timeout requires Unbound Workers. Remaining: proxy session store per-isolate, proxy rate limit not TPM-aware. | claude/review-audit-checklist-DD40v |
| 29 | Timezone & Unicode | 2026-04-14 | Round 2: 2 fixes. StatsScreen.tsx formatDate() now uses toLocaleDateString() with user locale instead of hardcoded M/D format. forge-hypotheses.js verified clean — all string slicing already uses Array.from().slice().join('') for surrogate safety. Remaining: .length (UTF-16 code units) used for some user content gates. | claude/audit-checklist-fixes-KEjdN |
| 30 | BYOK Key Lifecycle | 2026-04-16 | Round 3: Re-verified. Live API validation DOES exist — validateKeyWithProvider() in api-key.service.ts:16-50 makes a test count_tokens call before storing. 401/403 rejected immediately. Network timeout stores key anyway (correct — transient failures shouldn't reject valid keys). All 3 loops (agent, shipped, platform) mark keys invalid on 401. Remaining: reEncrypt() unused (dead code), no spend anomaly alerts. | claude/audit-checklist-hardening-GmzV5 |
| 31 | WebSocket Resilience | 2026-04-14 | 3 critical, 3 high, 1 medium, 2 low. FIXED: server heartbeat ping/pong every 30s — detects half-open TCP, terminates dead connections. FIXED: client AppState foreground listener — reconnects when app returns from background. FIXED: reconnect jitter added. Remaining: no message sequencing/dedup, no missed-event replay. Auth on reconnect handles token refresh correctly. | claude/push-cadence-table-update-WmhJf |
| 32 | License Compliance | 2026-04-14 | Round 2: 3 MEDIUM fixes. Added "license": "MIT" to peerzero-app/packages/server, peerzero-app/packages/mobile, and peerzero-proxy package.json files. All sub-packages now declare license. Remaining: no license scan in CI, pip-licenses not in CI. | claude/review-audit-checklist-DD40v |
| 33 | Env Var Validation | 2026-04-14 | Round 2: 2 HIGH fixes. Bot .env.example: documented 7 missing env vars (PEERZERO_PROXY_KEY, CONVERSATIONAL_MEMORY_KEY, MEMORY_HMAC_KEY, PZ_ALLOW_LOCAL_PROXY, PEERZERO_ALLOW_INSECURE_CONFIG, BOT_MODE, MEMORY_WIPE_INTERVAL). App .env.example: documented 5 missing env vars (SCHOOL_ADMIN_SECRET, ADMIN_SECRET, RESEND_WEBHOOK_SECRET, COMPANY_ADDRESS, DB_STATEMENT_TIMEOUT). | claude/review-audit-checklist-DD40v |
| 34 | Redis & Queue Config | 2026-04-14 | Round 2: 3 MEDIUM fixes. queue.ts: clearStaleLocks() now uses SCAN instead of redis.keys() (O(N) blocking fix). Both queue.ts and platform-queue.ts: queue names and lock keys now prefixed with QUEUE_PREFIX (env-based namespace prevents staging/prod collisions). platform-queue.ts: added failed event handler matching bot-cycles pattern. | claude/review-audit-checklist-DD40v |
| 35 | Migration Safety | 2026-04-14 | 0 critical, 2 high, 3 medium, 2 low. All CREATE INDEX in migrations 027, 030, 032 (school) and 0024 (app) are non-concurrent — will lock writes on large tables. Migration 029 adds UNIQUE constraints via ALTER TABLE (AccessExclusiveLock). Mutable DEFAULT (NOW/CURRENT_DATE) backfills wrong timestamps in 010, 0025. Unbatched UPDATE on large tables in 006, 0022, 0030. Missing migrations 001-003, 005 (baseline gap). 22 of 28 school migrations lack DOWN scripts. | claude/push-cadence-table-update-WmhJf |
| 36 | Accessibility (WCAG) | 2026-04-16 | Round 3: Re-verified. ChatScreen.tsx toggle rows already have accessibilityRole, accessibilityLabel, accessibilityState, and accessibilityHint. MilestoneModal.tsx already has accessibilityViewIsModal on content view. No remaining issues. | claude/audit-checklist-hardening-GmzV5 |
| ALL | Post-trajectory-subsystem hardening pass | 2026-04-19 | Targeted post-change sweep covering audits #1, 2, 3, 4, 6, 11, 12, 13, 14, 15, 18, 21, 23, 28, 29, 30, 33, 34, 35, 36 — focus on trajectory exercises subsystem (migration 037+, lib/trajectory-handlers.js, agent.py::_do_trajectory_exercise) plus MCP-in-conversation wiring + EDGE condenser + Semgrep fix sweep that landed 2026-04-19. 4 REAL FIXES applied: (1) HIGH #3 — peerzero-school/api/reconcile.js: trajectory_exercises was missing from retention purge list; each grade emits 3 exercises with full 30-step JSON logs + synthesis, would grow unbounded. Added with the same 'complete'/'abandoned'-only guard used for forge_hypotheses. (2) CRITICAL #2 + #4 — peerzero-school/lib/trajectory-handlers.js submitLog: UPDATE had no status guard, two concurrent submissions would both succeed and clobber each other's trajectory_log + adversarial_catch metrics. Added .eq('status','executing').select('id') optimistic lock returning 409 on conflict; also tightened pre-check from `['executing','concept']` to `'executing'` only (concept transitions to executing immediately at submit). (3) CRITICAL #2 + #4 — same file submitSelfReview: same fix, .eq('status','synthesis') lock returning 409 on conflict. Grade counter RPC failure log upgraded warn→error with {agentId, exerciseId} context — previously a sustained DB issue would silently break grade advancement. (4) HIGH #13 — same file submitConcept: hypotheses array was checked for length only; trajectorySearch dereferences hypotheses[0]?.claim for the injection's domain_mechanism, so a malformed hypothesis (string instead of object) would crash. Added per-element {object, claim≥5chars} check. Same hardening on per_step_assessment in submitSelfReview — entries needed {step:int, being_me:bool} but were only length-checked, malformed entries silently dropped from delta calc. FALSE POSITIVES verified against code: agent claims about MCP tool result sanitization missing (already done at llm_client.py:866), conversation_tool_use_enabled missing from .env.example (no env var binding — set in code/TOML config), platform-queue.ts missing lockRenewTime (already set explicitly at line 172), BYOK 401 burning 30 trajectory steps (LLM client _is_retryable correctly excludes 401 so call_json raises immediately and halts the loop), .length checks on emoji content (only minimum-length gates on bot-generated text). DEFERRED (require new infrastructure, violate Fix-Only Rule): proxy session store cross-isolate state (needs Durable Objects), proxy TPM-aware rate limiting (needs token counting state), School ADMIN_SECRET/CRON_SECRET startup validation (Vercel serverless has no startup phase), PGRST116 per-callsite review (broad audit on Semgrep-fix pattern across 15 files). | claude/code-audit-hardening-Mdac3 |
| ALL | Post-2026-04-19-changes regression sweep | 2026-04-22 | Targeted regression audit on the six commits between 2026-04-19 and today (9b0185e keepalive workflow, f475208 keepalive endpoint fix, 25812e0 incurious_boundary bounty + forge Open Threads, c799d66 operational-failure-modes doc, 7f6c51d drift-reason fix, 6d1bd80 school_identity defensive copy). Six categories against changed files + their immediate callers: #23 prompt injection — CLEAN (incurious_boundary challenge_metadata stays DB-only, not in action_target select at bounties.js:677, consistent with every other bounty-type's prose metadata); #13 input validation — CLEAN (new validator's typeof+length guards match sibling validators in science-bounty-validators.js); #1 silent failures — drift.reason is computed, log.info/warn emitted, and returned in the user-visible response suffix (bounties.js:650), but NOT persisted to the bounty row. Acknowledged explicitly in commit 7f6c51d as deferred — the DB-persistence ladder (new column + migration + admin-view wiring) violates the Fix-Only Rule and the user directed skipping cascading build-ons; #5 secrets — CLEAN (supabase-keepalive.yml uses env vars, Bearer+apikey headers not URL query, anon key is publicly-embeddable by design); defensive copy — CLEAN (all current callers in agent.py pass flat string-valued dicts with keys l5/l4/inner_voice; shallow copy sufficient); forge Open Threads prose — CLEAN (science-action-skills.js:723-728 has no Good:/Bad: examples and no new directives that would template-match in condensers per CLAUDE.md rule 8). 0 code fixes applied. 1 new #10 finding recorded (pytest 8.3.4 CVE-2025-71176, test-only, deferred — 8→9 bump risks pytest-asyncio compat for a local-user DoS). Audit #22 School /health endpoint still missing from prior runs (violates Fix-Only Rule to add — new serverless fn + vercel.json route). | claude/audit-docs-4Pj7V |
| ALL | Pre-first-run broad pass (all 36) | 2026-04-18 | Pre-launch broad sweep across all 36 audits + discretionary interconnection pass. Verified ~80 agent-reported findings against actual code; most were false positives (bot_voice_cache already has ON DELETE CASCADE; bounties.js:467 already gates on registration_review_passed; _cleanup() already try/excepts per step and iterates conv memory engines; conversational db.py:237 already runs WAL checkpoint on close; cli.py:283-288 already sys.exit(1) on config.validate() errors; priorForgePapers already defaults to []; resend webhook already rejects 500 in prod when secret missing at index.ts:153-157; _portable_profile cached in memory, not per-cycle). 2 REAL FIXES applied: (1) HIGH — peerzero-school/api/papers.js: forge papers POSTed at Grade 1-2 were accepted server-side despite CLAUDE.md rule 13 requiring Grade 3+. The profile endpoint correctly gates `canForge` to grade≥3, but a compromised/buggy bot could bypass the bot-side check. Added defense-in-depth 403 at line 629. (2) MEDIUM — peerzero-app/packages/server/src/routes/payments.ts:144: webhook handler failure log stripped error stack (msg string only) and lacked event.id for Stripe-dashboard correlation. Now passes raw err + eventId. DEFERRED to user discussion (require new systems, violate Fix-Only Rule): Redis TLS fail-fast in prod (breaking change for VPC deploys), action_target JSON schema validation, stripe_event_ids dedup table, error response format unification, AASA/assetlinks TEAM_ID production fingerprints. | claude/code-audit-review-utrdo |
