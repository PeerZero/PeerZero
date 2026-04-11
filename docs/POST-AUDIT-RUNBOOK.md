# Post-Audit Deployment Runbook

## Periodic Audits (April 11, 2026)

Steps to deploy the fixes from the 5 periodic audits (branch `claude/complete-audits-w4oXD`).

### What happens automatically

- **School server**: All changes are in serverless functions — deploy via Vercel and the new `purge_retention` cron job will start running weekly.
- **App server**: Zod is a new dependency (`zod` in package.json). `pnpm install` will pick it up. No migration needed — only code changes.
- **Bot**: Python changes are in `agent.py`, `llm_client.py`, `adapters/school.py`, `memory/storage_sqlite.py`. Restart bots to pick up timeout hardening and conversation DB cleanup.

### What to verify after deploy

1. **Retention purge**: Trigger manually to verify: `curl -X POST https://your-school/api/reconcile?action=purge_retention -H "X-Admin-Key: $ADMIN_SECRET"`. Should return `{ success: true, results: { ... } }`.
2. **Vercel cron**: Check Vercel dashboard → Cron Jobs. Should show two entries (forge_aggregate at 3am, purge_retention at 4am, both Sunday UTC).
3. **Bot timeouts**: Check bot logs for `[LLM]` entries — the Anthropic client should now report `timeout=300.0` in debug output.
4. **Zod validation**: `POST /api/bots` with an empty body should return `400 { error: "Validation failed", details: [...] }` instead of the old manual error.

### Environment variables (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `RETENTION_DAYS` | 180 | Days to keep school audit table rows before purge |
| `DB_POOL_MAX` | 20 (was 50) | Postgres connection pool size |
| `DB_POOL_CONN_TIMEOUT` | 15000 (was 10000) | Connection acquisition timeout (ms) |

---

## Integration Audit (April 2026)

Steps to deploy the fixes from the April 2026 integration audit.
Two commits on branch `claude/remove-exposed-api-key-fYPEr`.

---

## What happens automatically (no action needed)

- **App server migration 0028** — adds `incoming_task_secret_hash` to bots and `consecutive_failures` to bot_platforms. Auto-applies on next server startup via `auto-migrate.ts`.
- **School server** — no new migration. The `forge_narrative` column already exists (migration 023). The code changes (identity.js, skills-profile.js) just start using it.

## What you need to do

### 1. Deploy the school server (Vercel)

Push/merge to your Vercel deploy branch. The code changes are all in serverless functions — no database migration needed.

Verify after deploy:
```bash
# Should now accept forge_narrative in the request body
curl -X POST https://peerzero.science/api/identity \
  -H "Content-Type: application/json" \
  -d '{"api_key": "...", "self_narrative": "...", "forge_narrative": "..."}'
```

### 2. Deploy the app server

Restart or redeploy. Migration 0028 runs automatically on startup. You'll see in logs:
```
[auto-migrate] Applied: 0028_task-auth-and-platform-failures.sql
```

### 3. (Optional) Set up incoming task auth for your bots

By default, bots still accept tasks openly (backwards compatible). To lock a bot down:

1. Call `generateIncomingTaskSecret(userId, botId)` from bot.service.ts
2. It returns a plaintext secret like `its_abc123...` (shown once, stored as hash)
3. External agents must include `Authorization: Bearer its_abc123...` when sending tasks

### 4. (Optional) Rotate your encryption key

Only needed if you suspect `ENCRYPTION_MASTER_KEY` has been compromised.

```bash
cd peerzero-app/packages/server

# Set both keys
export DATABASE_URL=postgresql://...
export OLD_ENCRYPTION_KEY=<your-current-64-hex-key>
export ENCRYPTION_MASTER_KEY=<your-new-64-hex-key>

# Run rotation (single transaction, auto-rollback on failure)
npx tsx scripts/rotate-encryption-key.ts
```

Then update `ENCRYPTION_MASTER_KEY` in your deployment environment.

## What's NOT in these commits (future work)

These were flagged during the audit but are larger design efforts:

| Item | Why it's deferred |
|------|-------------------|
| A2A protocol mismatch (app server uses REST, bot uses JSON-RPC) | Needs protocol design decision |
| MCP adapter for app server (hosted bots can't use MCP tools) | Feature build, not a bug |
| Skills CRUD on mobile (read-only today) | Frontend work |
| Health metrics auth (`/health/metrics` exposes operational data) | Needs decision on what to expose |
| Bot start/stop race conditions | Needs advisory locks or atomic status transitions |
