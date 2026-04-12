# Code Health Audit Checklist

Systematic checks for catching issues that linters, type checkers, and tests miss — the code is syntactically correct and works in the happy path, but breaks under partial failure in production.

Adapted for single-package TypeScript libraries with file-based storage.

## How to Use

Pick 2-3 audits per session. For each, search the codebase and report findings with file paths, line numbers, and severity (critical/high/medium/low). Track runs in the Audit Log at the bottom.

---

## 1. Silent Failures

**What it catches:** Errors swallowed, logged at debug-only, or returning defaults — making debugging impossible.

**What to look for:**
- Empty catch blocks or catch blocks that only `console.log`
- File I/O operations (read/write JSON) that discard errors and return defaults
- `JSON.parse` without try/catch on data loaded from disk
- Functions returning `null`/`[]`/`{}` on error without logging
- Promises missing `.catch()` on fire-and-forget operations
- Async operations where a thrown error vanishes silently

---

## 2. Race Conditions & Non-Atomic Writes

**What it catches:** Concurrent access that clobbers data.

**What to look for:**
- JSON file writes that aren't atomic (write-then-rename pattern needed)
- Read-then-write on the same file without locking (two sessions ending simultaneously)
- Belief updates that read current alpha/beta, compute, then write back (concurrent update loses one)
- Metrics append operations where two processes append to the same file
- Co-file graph updates from parallel digest creation

---

## 3. Unbounded Growth

**What it catches:** Data structures that grow without limit.

**What to look for:**
- Digest count — is there a max? What happens at 50,000 digests?
- Co-file graph — every unique file pair ever seen is stored. Is there pruning?
- Metrics history — session scorecards accumulate forever?
- Belief count — `maxBeliefs: 500` exists, but is it enforced on every write path?
- Eviction traces — `maxEvictionTraces: 10` — enforced where?
- Storage directory file count — each digest is presumably a file or JSON entry

---

## 4. Crash Safety

**What it catches:** Partial writes that corrupt storage on crash.

**What to look for:**
- If the process crashes mid-write to a JSON file, is the file recoverable?
- Multi-file operations (save digest + update metrics + update co-file graph) — if crash happens between steps, is state consistent?
- Is there any write-ahead log or write-then-rename pattern?
- Can `getAllDigests()` handle a truncated/corrupted JSON file without crashing the whole system?

---

## 5. Sensitive Data in Storage

**What it catches:** Session text containing secrets that persist in memory files.

**What to look for:**
- Session text passed to `digestSession()` could contain API keys, passwords, env vars
- Digests store `summary`, `decisions`, `blockers` — could contain sensitive excerpts
- Beliefs auto-promoted from patterns could encode sensitive file paths or project names
- Storage files are plaintext JSON on disk — readable by any process with file access
- No sanitization pass on session text before storage

---

## 6. Resource Exhaustion

**What it catches:** Operations that hang or exhaust memory.

**What to look for:**
- `getAllDigests()` loading every digest into memory at once — what at 50k digests?
- Scoring loop iterating all digests × all files — O(n*m) without early exit
- Co-file graph nested iteration without short-circuit when cap (1.0) is reached
- Pattern detection scanning all digests on every call — is there caching?
- File system operations without timeout (readdir on a huge directory)
- No backpressure on `digestSession()` — can a caller flood storage?

---

## 7. Stale Beliefs & Data Drift

**What it catches:** Stored state that becomes wrong over time without any refresh mechanism.

**What to look for:**
- Beliefs formed 6 months ago retain full confidence with no decay
- Auto-promoted patterns from an old project context still injected in new contexts
- No mechanism to challenge, expire, or re-verify a belief
- Confidence is purely observation-count — 99 old observations outweigh 3 recent contradictions
- Co-file graph edges from old projects never pruned (acknowledged in README as missing)
- A belief that was true during one project phase poisons context in the next phase

---

## 8. Silent Score Degradation

**What it catches:** Scoring formula silently changing behavior when components produce zero.

**What to look for:**
- `maxAccessCount = 0` → frequency returns 0 → 30% of weight contributes nothing
- Both tag sets empty → Jaccard returns 0 (or NaN from 0/0) → 20% of weight gone
- No current files provided → co-access returns 0 → another 20% gone
- Score silently becomes a 1-factor (recency-only) model with no warning
- `temporalDecay` floor (0.3) means ancient data never fully fades — many old items at 0.3 can collectively dominate budget over fewer fresh items

---

## 9. Graceful vs. Silent Degradation

**What it catches:** The system silently degrades instead of making an explicit decision.

**What to look for:**
- Storage read fails → does `preload()` return empty context or throw?
- Quality gate rejects a digest → does `digestSession()` return null silently or explain why?
- Belief storage full (500 max) → what happens to the next auto-promotion? Silently dropped?
- Malformed digest loaded from disk → does it poison scoring or get skipped?
- Custom storage backend throws → does the error propagate or get swallowed?

---

## 10. Input Validation at Boundaries

**What it catches:** Untrusted input reaching internal logic without checks.

**What to look for:**
- `digestTimestamp` accepts NaN, Infinity, negative numbers — propagates through all math
- `halfLifeHours = 0` → division by zero in `exp(-hours / 0)`
- Scoring weights not validated to sum to 1.0 — scores silently exceed expected range
- `config.maxBeliefs` could be negative, zero, or non-integer
- Digest metadata fields (`tags`, `filesTouched`) assumed to be arrays — what if string or null?
- `sessionText` could be empty string — does quality gate catch it?
- Custom storage returning malformed data — digest missing `id`, `timestamp`, `tags`

---

## 11. Storage Contract & Migration

**What it catches:** Breaking changes when the schema evolves.

**What to look for:**
- If you add a field to `SessionDigest`, what happens to digests saved by the previous version?
- If `Belief` gains a new property, do old beliefs loaded from disk throw or degrade?
- Custom `IStorage` implementations — are all 14 methods documented with expected behavior on missing data?
- Version field in stored data? Without one, you can't distinguish v1 vs v2 digests
- Is there a migration path, or does the user have to delete and rebuild?

---

## 12. Performance at Scale

**What it catches:** Code that works at 200 digests but not at 20,000.

**What to look for:**
- `getPatterns()` scans all digests — O(n) minimum, possibly O(n²) for co-occurrence
- `preload()` scores every digest then sorts — fine at 200, check at 20k
- Co-file graph is a nested object — lookup is O(1) but serialization grows with every unique file pair
- `getAllDigests()` loads everything — is there pagination or streaming?
- Benchmark only tests 200 digests — add a 10k and 50k tier

---

## 13. Data Integrity

**What it catches:** Stored values that drift from reality.

**What to look for:**
- Belief `observations` count vs actual number of `update()` calls — can these diverge?
- `accessCount` on digests — is it incremented atomically? Can concurrent preloads double-count?
- Metrics `hitRate` — is it computed from the same set that was preloaded, or can the set change between preload and report?
- If a digest file is manually deleted, do beliefs and patterns that reference it break?
- Co-file graph edges referencing files from deleted digests — orphaned data

---

## 14. Recovery from Corruption

**What it catches:** Whether you can recover when storage goes bad.

**What to look for:**
- One corrupted digest file — does the whole system fail or skip it?
- Beliefs file corrupted — can you rebuild beliefs from digests? Is there a `rebuild()` method?
- Metrics file corrupted — can you start fresh without losing digests?
- Is there any backup-before-write pattern?
- What's the documented recovery path for users? "Delete the storage directory" is honest but lossy

---

## 15. Prompt Injection via Memory

**What it catches:** Malicious content in session text that persists in beliefs and gets injected into future LLM context.

**What to look for:**
- Session text like "IGNORE ALL PREVIOUS INSTRUCTIONS" gets stored in a digest summary
- That summary gets preloaded into future sessions as context
- Beliefs auto-promoted from patterns could encode adversarial instructions
- Eviction traces carry forward text from evicted digests — same risk
- No sanitization between storage and context injection
- A multi-user scenario: one user's malicious session text affects another user's preloaded context

---

## 16. Integration Smoke Test

**What to verify (manual walkthrough):**
- Create instance → digest a session → preload → verify digest appears
- Digest 10 sessions with overlapping tags → verify scoring ranks correctly
- Report usage on 2 of 5 preloaded → verify hit rate = 0.4
- Hit promotion threshold → verify belief auto-created
- Exceed maxBeliefs → verify oldest/lowest evicted (or whatever the policy is)
- Use custom storage backend → full lifecycle works identically
- Corrupt one stored file → verify system continues operating
- Pass empty/null/undefined for every optional parameter → no crashes

---

## Audit Log

Track when each audit was last run and what was found.

| # | Audit | Last Run | Issues Found | Notes |
|---|-------|----------|-------------|-------|
| 1 | Silent Failures | Never | — | — |
| 2 | Race Conditions | Never | — | — |
| 3 | Unbounded Growth | Never | — | — |
| 4 | Crash Safety | Never | — | — |
| 5 | Sensitive Data | Never | — | — |
| 6 | Resource Exhaustion | Never | — | — |
| 7 | Stale Beliefs | Never | — | — |
| 8 | Silent Score Degradation | Never | — | — |
| 9 | Degradation Decisions | Never | — | — |
| 10 | Input Validation | Never | — | — |
| 11 | Storage Contract | Never | — | — |
| 12 | Performance at Scale | Never | — | — |
| 13 | Data Integrity | Never | — | — |
| 14 | Recovery | Never | — | — |
| 15 | Prompt Injection | Never | — | — |
| 16 | Integration Smoke Test | Never | — | — |
