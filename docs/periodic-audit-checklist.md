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
| Monthly | #1 Silent Failures, #5 Secrets, #10 Dependencies, #20 Cost & Rate Limits |
| Quarterly | #2 Race Conditions, #4 Idempotency, #6 Timeouts, #8 Auth Gaps, #23 Prompt Injection |
| Twice yearly | #3 Unbounded Growth, #7 Stale Cache, #9 Degradation, #11 Dead Code, #12 N+1 Queries, #18 Data Integrity |
| After major features | #13 Input Validation, #14 Cross-System Contracts, #15 Error UX, #24 HTTP Security Headers |
| Pre-launch / post-incident | #17 Load & Concurrency, #19 Recovery & Rollback, #21 User Journey Smoke Test, #22 Monitoring & Alerting |

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

**Last run:** 2026-04-12 — 10 issues verified: 5 counter fallback read-then-write races eliminated (reviews.js, papers.js, bounties.js, responses.js ×2) — all now retry atomic RPC instead of using stale data. Paper status update now ALWAYS uses optimistic lock `.neq('status', 'superseded')` regardless of stale paper object. Revision credit fallback also fixed. Bounty validation loop now fetches fresh paper score per-iteration with a per-paper cache (invalidated after validation). Remaining 2 mitigated: bot grade_papers stale read (distributed lock prevents concurrent cycles), promotion bonus race (optimistic lock on bonus_awarded prevents double-award).

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

**Last run:** 2026-04-12 — 11 found, 10 fixed. BullMQ completed/failed job cleanup added (30-day retention, runs on startup + weekly). Voice cache purge, stale locks, activity purge, rate_limit_log purge, conv engine age eviction, retention purge cron, conv DB disk cleanup all handled. Orphan records reported via check_orphans endpoint.

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

**Last run:** 2026-04-12 — 21 items verified. 2 critical: paper submit + citations not in transaction, review submit + score update not in transaction — both mitigated by UNIQUE constraints (paper_id+reviewer_agent_id on reviews, challenger_agent_id+target_paper_id on bounties) that prevent duplicate on retry. True DB transactions deferred (Supabase JS SDK doesn't support multi-table transactions; would need Postgres function). All 5 counter fallbacks now retry atomic RPC instead of read-then-write. Bot cycle counter increment-after-action gap noted (medium — mitigated by distributed lock preventing concurrent cycles).

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

**Last run:** 2026-04-12 — 12 found, 6 fixed. Phone-home token expiry reduced 90→30 days. Error sanitization regex hardened (JWT, pht_, whsec_, apiKey patterns). Error sanitize before log, bearer regex improved, reconcile sanitize. .env.test contains fake test credentials (acceptable). Config file permissions are secure-by-default (errors when group/other readable). Identity endpoint verified per-agent scoped.

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

**Last run:** 2026-04-12 — 12 found, 11 fixed. SDK timeout, fetch timeout, SQLite timeout, pool sizing, Supabase timeout, news search logging, BullMQ lock renewal, JSON loop limit, rate bucket cap, fallback LRU, maxStalledCount=2. Remaining: profile endpoint timeout risk at scale (medium, mitigated by composite indexes).

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

**Last run:** 2026-04-11 — 9 items checked, no fixes needed. Bot profile refresh mitigates staleness; school config frozen by design on serverless; no Redis data caching exists.

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

**Last run:** 2026-04-12 — Phone-home token auth scoped to write-only (user_id no longer in token lookup). Export-data rate-limited (5/hr). Skill ownership verified correct at service layer. Task progress validates task_id belongs to bot. Emergency stop rate-limited. Bot start idempotent. 0 critical remaining.

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

**Last run:** 2026-04-11 — 12 issues found, 8 fixed. Remaining 3 moderate (esbuild, vite, brace-expansion) are dev-only and documented in auditNotes.

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

**Last run:** 2026-04-12 — Post-review stats parallelized (3 sequential → Promise.all). Rebuttal papers query capped with .limit(100). Promoted Q bonus loop parallelized (sequential → Promise.all). 5 composite indexes added (migration 030) for heavy query patterns.

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

**Last run:** 2026-04-12 — Citations array capped at 50 + Array.isArray type check. cross_study_connection max length capped at 5000 chars. App server uses Zod schemas with validateBody() middleware for request bodies.

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

**Last run:** 2026-04-11 — 4 issues found, 4 fixed (2 critical, 2 high). All App→School API contract mismatches corrected.

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

**Last run:** 2026-04-12 — Profile endpoint fires ~80-100 Supabase queries per bot via nested Promise.all chains. Key fixes: migration 030 adds 5 composite indexes for heavy query patterns (reviews quality gate, reviewable papers, credibility transactions, calibration log, rate limit log). BullMQ jobs now have attempts:2 with exponential backoff and dead-letter logging on exhaustion. No dead letter queue (BullMQ keeps last 50 failed jobs). Cycle stacking prevented by distributed lock (already exists). LLM concurrency has no code-level limiter — relies on Anthropic API rate limits + bot-side 10 req/s token bucket to School API. Connection pool exhaustion remains a risk at 50+ concurrent bots — consider Supabase pooler mode.

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

**Last run:** 2026-04-12 — Existing reconciliation endpoint already verifies counter drift (6 fields per agent), stuck reviews, and best_paper_score decay. Added `GET /api/reconcile?action=check_orphans` — counts orphan reviews, bounties, and citations referencing removed/deleted papers using efficient LEFT JOIN + IS NULL SQL. Orphan counts are reported for awareness; manual cleanup if needed. All other integrity checks (weighted_score reconstruction, calibration summaries, skill progress) are future work.

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

**Last run:** 2026-04-12 — Findings: App server has Pino JSON logging (good), School has custom JSON logger (adequate), Bot uses plain text logging. `/health` endpoint exists on App with DB check; Redis health check added. `/api/health` added to School with Supabase connectivity test. `/health/metrics` provides bot counts, cycle stats, error rates, token usage, action breakdown. Missing: no external monitoring service (Sentry, Datadog), no uptime monitoring, no Bull-board queue dashboard, no alerting rules. Bot circuit breaker exists (5 failures → OPEN). Recommendation: integrate Sentry for error tracking as highest-priority next step.

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

**Last run:** 2026-04-12 — Critical fixes: (1) `sanitize_untrusted()` now wraps all external text in builder.py — paper titles, abstracts, claims, review assessments, bounty reasoning, body excerpts, coaching patterns, risk warnings, and action_target JSON. (2) Conversational memory injector.py now wraps user messages, L2 behavioral observations, uncondensed L1 interactions, and emerging self-observations with `sanitize_untrusted()`. (3) MCP tool safety: adequate (subprocess isolation + command validation). (4) A2A task safety: adequate (512KB cap + type checking). (5) Search result sanitization: external results already wrapped. (6) LLM JSON output: 5-strategy parser exists but no schema validation post-parse — acceptable risk (server validates on submission). (7) Skill text from server: trusted (server-controlled); no wrapping needed.

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

## Audit Log

Track when each audit was last run and what was found/fixed. This helps Claude prioritize which audits are overdue.

**Update this table after every audit run.**

| # | Audit | Last Run | Issues Found | Branch/PR |
|---|-------|----------|-------------|-----------|
| 1 | Silent Failures | 2026-04-11 | 65 found, 65 fixed | claude/silent-failures-check-8N9z2 |
| 2 | Race Conditions | 2026-04-12 | 10 verified: 5 counter fallback races eliminated, paper status optimistic lock hardened, revision credit fallback fixed. +1 fixed: bounty validation loop now fetches fresh paper score per-iteration instead of using stale joined snapshot. 2 remaining mitigated (grade_papers by distributed lock, promotion bonus by optimistic lock). | claude/fix-audit-issues-H6H4C |
| 3 | Unbounded Growth | 2026-04-12 | 11 found, 10 fixed. +1: BullMQ completed/failed job cleanup on startup + weekly interval (30-day retention). Orphan records reported via check_orphans but not auto-cleaned. | claude/fix-audit-issues-H6H4C |
| 4 | Retry & Idempotency | 2026-04-12 | 21 verified: 5 counter fallbacks now retry atomic RPC. UNIQUE constraints prevent duplicate papers/reviews/bounties on retry. True DB transactions deferred (Supabase SDK limitation). | claude/fix-audit-issues-um2gE |
| 5 | Secret Exposure | 2026-04-12 | 12 found, 6 fixed. +2: phone-home token expiry reduced from 90→30 days, error sanitization regex hardened (JWT, pht_, whsec_, apiKey patterns). Remaining: test creds in .env.test (acceptable), .env.example patterns (low), identity endpoint verified per-agent scoped (not a gap). | claude/fix-audit-issues-H6H4C |
| 6 | Timeout & Exhaustion | 2026-04-12 | 12 found, 11 fixed. +1: BullMQ maxStalledCount=2 to retry stalled jobs before failing. Remaining: profile endpoint timeout risk at scale (medium, mitigated by indexes). | claude/fix-audit-issues-H6H4C |
| 7 | Stale Cache | 2026-04-11 | 9 checked, 0 fixed needed (bot profile refresh mitigates identity staleness, school config frozen by design on serverless, no Redis data caching, mobile token revocation on next request, all low/none severity) | claude/complete-readme-audits-3dG6T |
| 8 | Authorization Gaps | 2026-04-12 | Task progress validates task_id belongs to bot. Emergency stop rate-limited. Bot start idempotent. +3 fixed: phone-home token auth no longer queries user_id (write-only scope enforced), export-data endpoint rate-limited (5/hr), skill ownership verified correct at service layer. 0 remaining. | claude/fix-audit-issues-H6H4C |
| 9 | Degradation Decisions | 2026-04-11 | 8 found, 2 fixed (1 critical: search returns error sentinel instead of empty array to prevent citation-less papers; 1 high: condensation failure counter tracks consecutive failures and logs ERROR after 3; 6 noted as acceptable degradation) | claude/complete-readme-audits-3dG6T |
| 10 | Dependency Vulns | 2026-04-11 | 12 found, 8 fixed (pnpm overrides for brace-expansion/yaml, model ID updated to claude-sonnet-4-6, stale h11 comment, removed dead tomli dep, synced httpx lock, .python-version, engines field, @types/node pinned; 3 remaining: esbuild/vite/brace-expansion dev-only, documented) | claude/complete-readme-audits-3dG6T |
| 11 | Dead Code | 2026-04-12 | +3 fixed previously. 1 bot stub (get_conversation_forge_feedback) retained — architectural placeholder for forge feedback loop (CLAUDE.md rule 27). | claude/fix-audit-issues-H6H4C |
| 12 | N+1 Queries | 2026-04-12 | +3 fixed total. +1: promoted Q bonus loop parallelized (sequential claim+credit → Promise.all for both claims and credibility adjustments). | claude/fix-audit-issues-H6H4C |
| 13 | Input Validation | 2026-04-12 | +3 fixed total. +1: cross_study_connection max length capped at 5000 chars. | claude/fix-audit-issues-H6H4C |
| 14 | Cross-System Contracts | 2026-04-11 | 4 found, 4 fixed (2 critical: executeRevision read wrong field reaffirmable_papers→can_revise_papers, determineAction dropped forge_paper/self_review/sleep/reaffirm; 2 high: revision/reaffirmation used wrong API paths, review sent paper_id in body instead of query) | claude/complete-readme-audits-3dG6T |
| 15 | Error Message UX | 2026-04-12 | +2 fixed: request ID middleware (X-Request-Id header + req.requestId), error responses now include request_id. Error shapes verified consistent ({ error: string } everywhere). X-Request-Id allowed in School CORS. | claude/fix-audit-issues-um2gE |
| 16 | Graceful Shutdown | 2026-04-11 | 9 checked, 1 fixed (1 high: App server now waits for in-flight HTTP requests to drain before process.exit with 10s timeout; BullMQ workers already handled correctly; bot SIGTERM is graceful, SIGINT interrupts mid-action — medium, acceptable) | claude/complete-readme-audits-3dG6T |
| 17 | Load & Concurrency | 2026-04-12 | ~100 queries/bot in profile endpoint. 5 indexes added (migration 030), BullMQ attempts:2 + dead letter logging, stacking prevented by lock | claude/fix-audit-issues-um2gE |
| 18 | Data Integrity | 2026-04-12 | Existing reconcile checks counters + stuck reviews. Added orphan check (reviews/bounties/citations referencing removed papers) | claude/fix-audit-issues-um2gE |
| 19 | Recovery & Rollback | 2026-04-12 | Added POST /health/emergency-stop kill switch. Circuit breaker exists. No DOWN migrations (noted). Vercel rollback via dashboard. | claude/fix-audit-issues-um2gE |
| 20 | Cost & Rate Limits | 2026-04-12 | Analysis: ~$0.15-0.40/cycle/bot. 100 bots within Anthropic Tier 2 limits. Daily token cap per bot prevents runaway. | claude/fix-audit-issues-um2gE |
| 21 | User Journey Smoke | 2026-04-12 | Deferred — requires manual walkthrough with running system | — |
| 22 | Monitoring & Alerting | 2026-04-12 | /api/health added to School with DB check. Redis health check added to App. /health/metrics exists. No external monitoring (Sentry/Datadog). | claude/fix-audit-issues-um2gE |
| 23 | Prompt Injection | 2026-04-12 | 2 critical fixed (builder.py external text + injector.py user messages wrapped with sanitize_untrusted). MCP/A2A/search adequate. | claude/fix-audit-issues-um2gE |
| 24 | HTTP Security Headers | 2026-04-12 | A- posture. HSTS preload added to School. Helmet v8, strict CSP, no cookies, strict CORS on both. No critical vulns. | claude/fix-audit-issues-um2gE |
