# Pre-Launch Compliance Checklist

Last updated: 2026-03-31

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

## CCPA/CPRA (California)

- [x] **Privacy Policy updated** — Includes CCPA categories, rights, and disclosures. March 31, 2026.
- [ ] **Honor Global Privacy Control (GPC)** — If PeerZero has a web presence, must respect GPC browser signals.
- [ ] **Automated decision-making disclosure** — CPRA ADMT rules. Documented in Privacy Policy Section 7, but may need more detail as CPPA finalizes rules.
- [ ] **"Do Not Sell/Share" link** — Not currently needed (we don't sell/share), but add a visible statement on any web property.

## Colorado AI Act (Effective: February 1, 2026)

- [ ] **Assess applicability** — Requires "reasonable care" to avoid algorithmic discrimination for high-risk AI systems. PeerZero's credibility scoring may qualify. Same sandbox argument as EU AI Act applies.
- [ ] **Impact assessment** — If applicable, document algorithmic impact assessment.

## App Store Compliance

- [ ] **Google Play Families Policy** — Enroll in Designed for Families program, update data safety section. See `docs/COPPA_COMPLIANCE.md` Section 7.
- [ ] **Apple Kids category or age gate** — Implement documented age gate with parental consent. See `docs/COPPA_COMPLIANCE.md` Section 7.
- [ ] **Update store listing** — Change age rating, update data safety section, add Terms of Service URL.

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
