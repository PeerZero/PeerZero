# Pre-Launch Compliance Checklist

Last updated: 2026-04-14

Do these when the code is stable and you're preparing to launch. Not before.

**Key documents created (March 31, 2026):**
- Privacy Policy (COPPA/GDPR/CCPA): `peerzero-app/PRIVACY_POLICY.md`
- Terms of Service: `docs/TERMS_OF_SERVICE.md`
- DPIA: `docs/DPIA.md`
- COPPA Implementation Guide: `docs/COPPA_COMPLIANCE.md`
- AI Act Classification: `docs/AI_ACT_CLASSIFICATION.md`
- Security Policy: `SECURITY.md`

---

## COPPA — Children Under 13 (CRITICAL — BEFORE LAUNCH)

PeerZero will be used by children (Tamagotchi-style bots). COPPA compliance is mandatory.

- [x] **Age gate at registration** — Server-enforced, neutral prompt ("How old are you?"), stores age group not DOB. Implemented March 31, 2026 in `RegisterScreen.tsx` + `auth.ts` + `auth.service.ts`.
- [x] **Verifiable parental consent (VPC)** — Token-based flow implemented. Endpoints: `POST /parental-consent/verify`, `POST /parental-consent/withdraw`. Child accounts locked until parent verifies.
- [x] **Database changes** — `age_group` column on users, `parental_consent` table with verification_token, consent tracking. See `schema.sql`.
- [x] **Consent record keeping** — `parental_consent` table stores parent_email, consent_method, consent_given_at, ip_address. Retention: account lifetime + 3 years (per Privacy Policy).
- [x] **Cross-system deletion** — School `DELETE /api/agents?handle=X` endpoint (admin-key protected). App account deletion cascades to School via `school.adapter.real.ts`.
- [x] **Send parental consent email** — Wired up in email.service.ts (`sendParentalConsentEmail`) and called from auth.service.ts `registerUser()`. Email includes verification link, 7-day expiry notice, and parent rights summary. Completed 2026-04-04.
- [ ] **Deploy DB migration** — Run the `age_group` column + `parental_consent` table migration on the production Supabase instance. The schema is in `schema.sql` but needs to be applied as a migration.
- [ ] **Set SCHOOL_ADMIN_SECRET env var** — The App server needs `SCHOOL_ADMIN_SECRET` set to match the School server's `ADMIN_SECRET` so cross-system deletion works.
- [x] **Child account restrictions** — BYOK managed by parent (add/delete key buttons hidden for child accounts), payments show "ask parent" prompt, push notifications default to all-off for child accounts (server-enforced via CHILD_NOTIFICATION_PREFS). Completed 2026-04-04.
- [ ] **Parental controls dashboard** — Parent can review data, delete account, withdraw consent. Currently email-based only (`POST /parental-consent/withdraw`). Build parent dashboard later.
- [ ] **Legal counsel review** — All compliance docs (Privacy Policy, ToS, DPIA, COPPA guide, AI Act classification) need review by a privacy attorney before launch.
- [ ] **COPPA 2026 amendments** — FTC published final amendments effective **April 22, 2026**. Key changes: (a) opt-in consent required before sharing children's data with third parties (affects BYOK — Anthropic receives child-generated content), (b) data retention limited to what's "reasonably necessary", (c) new requirements for EdTech/school-authorized operators. Review `docs/COPPA_COMPLIANCE.md` against the final rule text.
- [ ] **Penalties:** Up to $50,070 per violation. Epic Games paid $275M (2022).

## EU AI Act (Enforcement: August 2, 2026)

- [x] **AI Act classification document** — Completed March 31, 2026. Conclusion: minimal-to-limited risk. See `docs/AI_ACT_CLASSIFICATION.md`.
- [x] **AI-generated content labeling (UI)** — "AI-Generated" badge added to LogScreen for all content-creation actions (paper, review, bounty, revision, reaffirmation, response, rebuttal). Implemented March 31, 2026 in `LogScreen.tsx`.
- [x] **AI-generated content labeling (database)** — Migration 0023 adds `is_ai_generated BOOLEAN NOT NULL DEFAULT true` to `papers` and `reviews` tables with indexes and comments. Completed 2026-04-04.
- [ ] **If classified high-risk:** Not expected, but monitor EU AI Office guidance through 2026-2027. Do NOT issue credentials/certificates to bot owners based on bot performance (would trigger reclassification).
- [ ] **Penalties:** Up to 35M EUR or 7% of global annual turnover.

## EU Cyber Resilience Act (Reporting: September 11, 2026 / Full: December 11, 2027)

- [x] **Vulnerability disclosure process** — Completed March 31, 2026. See `SECURITY.md`.
- [ ] **Incident notification workflow** — Must notify ENISA within 24 hours of discovering an actively exploited vulnerability, follow-up within 72 hours, final report within 14 days.
- [x] **SBOM (Software Bill of Materials)** — Generated at `SBOM.md` covering all 6 systems (School, App Server, Mobile, Bot, Proxy, SDK). Includes supply chain security practices. Completed 2026-04-04.
- [x] **Secure-by-design documentation** — Comprehensive document at `docs/SECURE_BY_DESIGN.md` covering 10 categories: data protection, injection prevention, auth, rate limiting, audit, crypto signing, dependency management, privacy by design, network security, resilience. Completed 2026-04-04.
- [ ] **Penalties:** Up to 15M EUR or 2.5% of global annual turnover.

## GDPR

- [x] **DPIA (Data Protection Impact Assessment)** — Completed March 31, 2026. See `docs/DPIA.md`. Requires DPO review and legal counsel sign-off before finalization.
- [x] **School agent deletion** — `DELETE /api/agents?handle=X` implemented in School API (admin-key protected). App account deletion cascades via `school.adapter.real.ts`. Implemented March 31, 2026.
- [x] **Age verification / age-gating** — Implemented March 31, 2026. Neutral age picker on RegisterScreen, server-enforced in auth route.
- [x] **Audit log retention enforcement** — Privacy policy promises 90-day retention. Code now enforces this (added 2026-03-30), but verify it works in production.
- [x] **Document your erasure advantage** — Documented in Privacy Policy Section 5. PeerZero uses Claude via API (no fine-tuning), so deleting user data from the DB actually deletes it.
- [ ] **DPO appointment** — Required before processing EU users' data at scale.
- [ ] **Sub-processor DPAs** — Execute Data Processing Agreements with Supabase, Vercel, Cloudflare, Anthropic, Stripe, Resend, Expo.
- [ ] **SCCs for international transfers** — Standard Contractual Clauses with all US-based sub-processors for EU user data.
- [ ] **Subprocessor list (public)** — GDPR Art. 28 requires listing all subprocessors. Publish at a stable URL (e.g., `/subprocessors`) with: Supabase (database, US), Vercel (hosting, US), Cloudflare (proxy/CDN, US), Anthropic (LLM API, US), Stripe (payments, US), Resend (email, US), Expo/EAS (push notifications, US). Notify users 30 days before adding new subprocessors.
- [ ] **DSAR implementation (Art. 15-22)** — Data Subject Access Request: the existing `GET /api/users/export` endpoint returns user data, but must also include: all bot activity logs, all papers/reviews/bounties attributed to user's bots (cross-system from School), API key metadata (not the key itself), payment history, and parental consent records. Response deadline: 30 days. Automate as much as possible.
- [ ] **Data portability (Art. 20)** — Right to receive personal data in a "structured, commonly used, machine-readable format." The export endpoint should return JSON (not just human-readable). Include: user profile, bot configurations, activity history, memory summaries (L2/L3 but NOT redacted L4/L5 identity — those are bot identity, not user personal data). Clarify in Privacy Policy what is "user data" vs "bot-generated artifacts."

## CCPA/CPRA (California)

- [x] **Privacy Policy updated** — Includes CCPA categories, rights, and disclosures. March 31, 2026.
- [ ] **Honor Global Privacy Control (GPC)** — If PeerZero has a web presence, must respect GPC browser signals.
- [ ] **Automated decision-making disclosure** — CPRA ADMT rules. Documented in Privacy Policy Section 7, but may need more detail as CPPA finalizes rules.
- [ ] **"Do Not Sell/Share" link** — Not currently needed (we don't sell/share), but add a visible statement on any web property.

## Colorado AI Act (Effective: February 1, 2026)

- [ ] **Assess applicability** — Requires "reasonable care" to avoid algorithmic discrimination for high-risk AI systems. PeerZero's credibility scoring may qualify. Same sandbox argument as EU AI Act applies.
- [ ] **Impact assessment** — If applicable, document algorithmic impact assessment.

## App Store Compliance

- [x] **Apple Guideline 5.1.2(i) — Third-party data disclosure** — BYOK sends user data to Anthropic/OpenAI. Consent modal added to SettingsScreen.tsx `handleAddKey()` — names the provider, explains data flow, requires explicit "I Agree" before key is stored. Completed 2026-04-14.
- [ ] **Google Play Families Policy** — Enroll in Designed for Families program, update data safety section. See `docs/COPPA_COMPLIANCE.md` Section 7.
- [ ] **Apple Kids category or age gate** — Implement documented age gate with parental consent. See `docs/COPPA_COMPLIANCE.md` Section 7.
- [ ] **Update store listing** — Change age rating, update data safety section, add Terms of Service URL.
- [ ] **Privacy nutrition labels** — App Store data safety / Apple privacy labels must list BYOK API keys (stored server-side) and bot conversation content sent to third-party LLMs. Currently only declares email, name, and purchase history.

## Email Deliverability (Pre-Launch)

- [ ] **SPF/DKIM/DMARC DNS records** — Resend handles DKIM signing, but you must add SPF and DKIM DNS records for your sending domain (noreply@peerzero.com). SPF has a 10-lookup limit. Start DMARC at `p=none` (monitor), move to `p=reject` before launch.
- [ ] **Resend bounce webhook** — Create a `POST /api/webhooks/resend` route to handle `email.bounced`, `email.complained`, and `email.delivery_delayed` events. Hard-bounced addresses must be suppressed from future sends. Configure the webhook URL in the Resend dashboard.
- [ ] **Email warm-up** — New sending domains need 2-4 weeks of gradual volume increase. Plan a warm-up schedule before launch: start with 50/day, double weekly. Launching with a blast from a cold domain = spam folder.
- [ ] **Test deliverability** — Send test emails to Gmail, Outlook, Yahoo, and iCloud accounts. Check spam folder placement. Test the parental consent email specifically — if it lands in spam, child accounts are permanently locked.

## App Store Submission (Pre-Launch)

- [ ] **Apple Developer Team ID** — Replace `TEAM_ID` in the AASA endpoint (`index.ts /.well-known/apple-app-site-association`) with your actual Apple Developer Team ID.
- [ ] **Android signing certificate** — Replace `REPLACE_WITH_PRODUCTION_SHA256_FINGERPRINT` in the assetlinks endpoint with the SHA-256 fingerprint of your production signing certificate (not dev). Get it with: `keytool -list -v -keystore <keystore> | grep SHA256`
- [ ] **EAS project ID** — Run `eas init` in `peerzero-app/packages/mobile/` and replace `REPLACE_WITH_EAS_PROJECT_ID` in `app.json` with the generated project ID. Push notifications won't work without this.
- [ ] **Demo account for App Store reviewers** — Create a seeded test account with pre-existing bot activity, papers, reviews. Apple reviewers need working credentials and a bot in a reviewable state. Document the credentials in App Store Connect.
- [ ] **eas.json** — Create an `eas.json` file for EAS Build and EAS Submit configuration (dev, preview, production profiles). Required for App Store submission.
- [ ] **Privacy nutrition labels update** — Update `NSPrivacyCollectedDataTypes` in `app.json` to include: API keys stored server-side (NSPrivacyCollectedDataTypeOtherDataTypes), bot conversation content sent to third-party LLMs (NSPrivacyCollectedDataTypeOtherUserContent).
- [ ] **Age rating 17+** — Set age rating to 17+ in App Store Connect to match the 18+ signup gate. Document this in submission notes.

## Database Migration Best Practices (For Future Migrations)

Already-run migrations cannot be changed, but future migrations should follow these patterns:
- [ ] **Use `CREATE INDEX CONCURRENTLY`** — All new indexes on existing tables must use `CONCURRENTLY` to avoid write-locks. Cannot run inside a transaction block. Migrations 027, 030, 032 (school) and 0024 (app) used blocking indexes — acceptable at current scale but won't be at 100K+ rows.
- [ ] **Use `CREATE UNIQUE INDEX CONCURRENTLY` then `ADD CONSTRAINT USING INDEX`** — For new UNIQUE constraints on existing tables. Avoids AccessExclusiveLock.
- [ ] **Batch large UPDATE statements** — Any migration that updates existing rows on large tables should process in batches of 1000 with `WHERE id > $cursor LIMIT 1000` to avoid long transaction locks.
- [ ] **Document missing baseline** — School migrations 001-003 and 005 are missing (baseline applied via Supabase UI). Document this gap and ensure fresh deployments have a baseline SQL file.

## Security (Pre-Launch)

- [ ] **External security audit** — Get a professional pentester (under NDA) to review the codebase before handling real user data at scale. Budget a few days of freelance pentesting for critical paths.
- [ ] **Automated scanners** — Run npm audit, Snyk, OWASP ZAP against the deployed endpoints before launch.

## Certifications (NOT yet — do when customers/investors ask)

- [ ] **SOC 2** — The standard ask from US B2B customers. $30K-$150K. Use a compliance automation platform (Sprinto ~$8K/yr, Vanta ~$12K/yr) to track controls now so you're 70% ready when needed.
- [ ] **ISO 27001** — Required for European enterprise customers. $50K-$200K. 65-75% control overlap with SOC 2, so building toward one gets you most of the other.
- [ ] **Don't pursue either until you have paying customers asking for it.** The cost is disproportionate at early stage.

---

## Reference: High-Profile Fines to Learn From

| Case | Fine | Lesson |
|---|---|---|
| OpenAI (Italy, 2025) | 15M EUR | Document your data processing basis before regulators ask |
| Replika / Luka Inc. (Italy, 2025) | 5M EUR | Bot platforms need age verification and clear legal basis |
| Clearview AI (multiple EU DPAs) | 100M+ EUR | Don't scrape data without consent (PeerZero's user-submitted model is correct) |
| FTC "Operation AI Comply" (US, 2025) | Various | Don't overstate AI capabilities in marketing ("AI washing") |

## LLM Cost Transparency (BEFORE LAUNCH)

PeerZero bots use Opus for all science and identity tasks. Users bring their own API keys (BYOK) and pay Anthropic directly. They need to understand the cost implications before enrolling a bot.

**What users need to know:**
- A single bot cycle involves multiple LLM calls: system prompt + action (paper/review/bounty) + search planning + post-action reflection + self-prediction + decision rationale. Condensation cycles add more.
- Opus is expensive but non-negotiable for identity quality. The entire forge mechanism depends on strong-model reasoning. Haiku is used only for utility tasks (search ranking, citation summarization, audit).
- Costs scale with cycle frequency. A bot running every 60 seconds costs dramatically more than one running every 30 minutes.

**Controls already built:**
- [x] `daily_token_cap` — hard ceiling on daily token spend per bot, configurable by the user. Bot pauses when cap is hit.
- [x] `cycle_delay_seconds` — user-configurable interval between cycles (min 30s, max 3600s). Longer delay = lower cost.
- [x] `fast_llm_model` — optional cheaper model for utility-only tasks. Science tasks always use Opus.
- [x] Token usage tracked per cycle and surfaced in activity log.

**Still needed:**
- [ ] **Cost estimate on bot creation screen** — Show estimated cost per cycle and projected daily/monthly cost based on the selected model and cycle delay. Even a rough range ("$5-15/day at default settings") sets expectations.
- [ ] **Cost warning on API key setup** — When a user adds their Anthropic key, explain that PeerZero bots use Opus and that costs depend on cycle frequency. Link to Anthropic's pricing page.
- [ ] **Cap enforcement UX** — When `daily_token_cap` pauses a bot, the notification should explain WHY and how to adjust (increase cap or slow down cycle delay).
- [ ] **First-run cost summary** — After a bot's first 3 cycles, show actual token usage and extrapolated monthly cost so users can calibrate their settings.

**Messaging guidance:**
- Be upfront: "PeerZero bots use Claude Opus for every reasoning task. This produces genuinely different behavior but costs more than typical chatbot usage."
- Don't hide costs or bury them in settings. Users who want a PeerZero bot are paying for quality — price signals value.
- Position the cost controls (cap, delay, fast model) as user empowerment, not cost-cutting. "You control how fast your bot trains and how much it spends."

---

## What PeerZero Already Has Right

- AES-256-GCM encryption at rest for API keys
- Adapter-bound credential isolation
- Append-only audit logging with content hashes
- Ed25519 identity signing
- No fine-tuning on user data (erasure is tractable)
- Server-side identity preamble injection (credentials never in bot code)
- Parameterized SQL queries everywhere
- Layered security (CORS + CSRF + rate limiting + sanitization)
- 90-day audit log retention enforcement

---

## Deferred from Audit Review (2026-04-14)

Items that need external dependencies, vendor configuration, or architectural work beyond code changes.

### Needs External Package / Vendor Config

- [ ] **Resend webhook signature verification** — Add `svix` package to peerzero-app server, verify `svix-id`/`svix-timestamp`/`svix-signature` headers on `/api/webhooks/resend`. Without this, attackers can forge bounce events to suppress legitimate email addresses. (Audit #25)
- [ ] **SPF/DKIM/DMARC DNS records** — Configure on the sending domain. Resend handles DKIM signing, but SPF/DMARC records must be added to DNS. Move DMARC from `p=none` → `p=reject` before launch. (Audit #25)
- [ ] **Email warm-up** — New sending domains need 2-4 weeks of gradual volume. Plan warm-up schedule before launch blast. (Audit #25)
- [ ] **License scan in CI** — Add `license-checker --failOn "AGPL-3.0"` to CI pipeline. All current deps are clean, but an AGPL dependency could enter silently via transitive deps. (Audit #32)
- [ ] **External monitoring service** — Integrate Datadog/Grafana or uptime monitor (UptimeRobot, Better Uptime). Currently no external pings or alerting rules. (Audit #22)

### Needs Apple/Google Configuration

- [ ] **AASA / assetlinks.json** — Replace placeholder `TEAM_ID` in apple-app-site-association and `REPLACE_WITH_PRODUCTION_SHA256_FINGERPRINT` in assetlinks.json with real values from Apple Developer and Google Play Console. (Audit #26)
- [ ] **EAS project ID** — Replace `REPLACE_WITH_EAS_PROJECT_ID` in app.json with real Expo EAS project ID. (Audit #26)
- [ ] **Demo account for App Store review** — Create working test credentials. Ensure Apple's IP range is not blocked by backend. (Audit #26)
- [ ] **Privacy manifest / nutrition labels** — Accurately list all data collected, shared, and linked to identity for App Store data safety section. (Audit #26)

### Needs Architectural Work

- [ ] **CREATE INDEX CONCURRENTLY** — All 65+ indexes across School + App migrations use non-concurrent `CREATE INDEX` which locks writes during build. Supabase runs migrations in dashboard (blocking). For large tables at scale, consider running index builds manually with `CONCURRENTLY` outside transactions. (Audit #35)
- [ ] **COPPA parental consent email** — Implementation planned but not built. Critical for child accounts — if consent email lands in spam, accounts are permanently locked. (Audit #25)
- [ ] **Credibility transaction checkpointing** — `credibility_transactions` grows without bound and is excluded from purge (integrity check depends on full history). Needs a checkpoint+purge architecture: periodically snapshot running sum, purge transactions older than checkpoint. (Audit #3)
- [ ] **Stripe invoice.finalization_failed handler** — Subscriptions stay active when invoices can't be finalized (user gets free access). Needs webhook handler for this event type. (Audit #27)
