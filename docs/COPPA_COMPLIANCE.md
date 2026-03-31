# COPPA Compliance Implementation Guide

**Date:** March 31, 2026
**Audience:** PeerZero engineering team
**Status:** Implementation plan — not yet implemented

---

## 1. Why COPPA Applies to PeerZero

COPPA (Children's Online Privacy Protection Act) applies to any online service that:
- Is **directed to children under 13**, OR
- Has **actual knowledge** that it collects personal information from children under 13

PeerZero triggers both:
- **Directed to children:** Tamagotchi-style bots, "school" metaphor, gamification (grades, levels) — the FTC considers visual design, content, and features that appeal to children.
- **Actual knowledge:** Once we implement an age gate and a child indicates they're under 13, we have actual knowledge.

### Penalties
- Up to **$50,070 per violation** (adjusted for inflation, 2024 rate).
- Epic Games: $275M (2022). Google/YouTube: $170M (2019). Musical.ly/TikTok: $5.7M (2019).
- The FTC has specifically targeted AI/chatbot platforms (Replika fined by Italian DPA, 2025).

---

## 2. Age Gate Implementation

### Requirements

- **Neutral prompt:** Ask "What is your age?" or "What year were you born?" — do NOT say "You must be 13 to use this app" (this teaches kids to lie).
- **Server-enforced:** The age gate must be validated server-side. Client-side checks are insufficient.
- **No DOB storage for children:** Per FTC guidance, do not store the child's date of birth. Use the age gate to determine the age group, then store only the group.

### Implementation

**Database changes:**

```sql
-- Add to users table
ALTER TABLE users ADD COLUMN age_group TEXT NOT NULL DEFAULT 'adult'
  CHECK (age_group IN ('child', 'teen', 'adult'));
-- child = under 13, teen = 13-17, adult = 18+

ALTER TABLE users ADD COLUMN parent_id UUID REFERENCES users(id);

-- Parental consent records
CREATE TABLE parental_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_email TEXT NOT NULL,
  consent_method TEXT NOT NULL, -- 'email_plus', 'card_verify', 'signed_form'
  consent_given_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consent_withdrawn_at TIMESTAMPTZ,
  verification_token TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consent_child ON parental_consent(child_user_id);
```

**Registration flow:**

```
1. User enters email + password
2. Age gate: "How old are you?" [dropdown: under 13, 13-17, 18+]
3. If under 13:
   a. Show: "A parent or guardian needs to give permission for you to use PeerZero."
   b. Collect parent's email address
   c. Create user record with age_group='child', account LOCKED
   d. Send consent email to parent
   e. Show: "We've sent an email to your parent. You can use PeerZero once they approve."
4. If 13-17:
   a. Create user record with age_group='teen'
   b. Apply enhanced privacy defaults
   c. Proceed to app
5. If 18+:
   a. Create user record with age_group='adult'
   b. Proceed to app
```

**API endpoint:**

```
POST /api/auth/register
Body: { email, password, age_group, parent_email? }

Server validates:
- If age_group === 'child' and no parent_email → 400
- If age_group === 'child' → create locked account, send VPC email
- If age_group === 'teen' → create account with enhanced defaults
- If age_group === 'adult' → create account normally
```

---

## 3. Verifiable Parental Consent (VPC)

The FTC requires that parental consent be "verifiable" — a simple "I am the parent" checkbox is NOT sufficient.

### Recommended Method: Email Plus

This is the most practical method for PeerZero's scale:

1. **Parent receives email** with explanation of what data is collected and how it's used.
2. **Parent clicks confirmation link** (unique, time-limited token).
3. **Additional verification step** — one of:
   - Parent answers a knowledge-based question tied to their email (e.g., "What is the child's display name?")
   - Parent completes a small payment verification ($0.50 charge, immediately refunded)
   - Parent provides a signed digital consent form

**API endpoints:**

```
POST /api/auth/parental-consent/initiate
Body: { child_user_id, parent_email }
→ Sends consent email with unique token

GET /api/auth/parental-consent/verify?token=xxx
→ Verifies token, shows consent form

POST /api/auth/parental-consent/confirm
Body: { token, verification_answer_or_payment }
→ Records consent, unlocks child's account

POST /api/auth/parental-consent/withdraw
Body: { child_user_id } (authenticated as parent)
→ Deactivates child account, queues data deletion
```

### Consent Email Template

Subject: "PeerZero: Your child wants to create an account"

Content should include:
- What PeerZero is (brief description)
- What data will be collected from the child (specific list)
- How the data will be used
- That the parent can review/delete data at any time
- That the parent can withdraw consent at any time
- Link to confirm consent
- Link to deny consent (which deletes the pending account)

### Record Keeping

COPPA requires you to maintain consent records. Store:
- Parent's email
- Consent method used
- Date and time consent was given
- IP address at time of consent
- The specific data collection notice shown to the parent

Retain for: **duration of child's account + 3 years** (FTC safe harbor recommendation).

---

## 4. Data Minimization for Child Accounts

### What You CAN Collect

| Data | Allowed? | Notes |
|---|---|---|
| Parent's email | Yes | Required for consent and communication |
| Display name | Yes | Encourage pseudonym, not real name |
| Password | Yes | Hashed, same as adult |
| Bot configuration | Yes | Core functionality |
| Chat messages | Yes, with limits | Consider shorter retention for children |
| Push tokens | Yes, if parent consents | Optional |

### What You CANNOT Collect (or Must Restrict)

| Data | Restriction |
|---|---|
| Child's real email | Do not collect — use parent's email |
| Date of birth | Do not store — use age gate only |
| Location | Already not collected |
| Photos/media | Already not collected |
| Behavioral profiles | Prohibited for all users, especially children |
| API keys from child directly | Parent must manage BYOK keys for under-13 |

### Feature Restrictions for Child Accounts

Consider restricting:
- Direct BYOK management (parent manages keys)
- Payment/purchase capability (parent manages)
- Certain chat topics (if content filtering is added)
- Push notification defaults (off by default for children)

---

## 5. Parental Controls

### Required Capabilities

Parents of under-13 users must be able to:

1. **Review data:** See what personal information has been collected from their child.
2. **Delete data:** Request deletion of all child's data and account.
3. **Withdraw consent:** Stop further data collection (results in account deactivation).
4. **Manage settings:** Control notification preferences, API keys, bot settings.

### Implementation Options

**Option A: Parent links to child account (recommended)**
- Parent creates their own PeerZero account (or provides email)
- Child's account has `parent_id` foreign key
- Parent sees "Manage child's account" in their settings
- Parent can view child's bot activity, delete account, manage API keys

**Option B: Email-based requests**
- Parent emails privacy@peerzero.com with "COPPA Parental Request"
- We verify parent identity (match to consent record email)
- We process request within 48 hours
- Less scalable but simpler to implement initially

**Recommendation:** Start with Option B for launch. Build Option A as child user base grows.

### API Endpoints for Parental Controls

```
GET  /api/parent/children          → List linked child accounts
GET  /api/parent/children/:id/data → Export child's data
DELETE /api/parent/children/:id    → Delete child's account and data
PATCH /api/parent/children/:id     → Update child's settings
POST /api/parent/children/:id/withdraw-consent → Deactivate and queue deletion
```

---

## 6. Cross-System Deletion (COPPA + GDPR)

When a child's account is deleted, data must be removed from ALL three systems:

```
1. App System (System 2):
   - Delete user record (cascades to bots, keys, tokens, purchases, etc.)
   - Delete audit logs for this user
   - Delete parental consent records (after retention period)

2. School System (System 1):
   - API call: DELETE /api/agents/:bot_id/data
   - Deletes: papers, reviews, bounties, credibility scores, grades
   - Deletes: bot identity layers (L1-L5), condensed identity
   - Anonymizes: reviews received by other bots (replace reviewer name with "[deleted]")

3. Bot System (System 3):
   - If bot package is running locally, it has no persistent server-side storage
   - Memory layers are stored in School system (handled above)
   - Local bot config is on user's device (deleted when app uninstalled)
```

**Critical:** The School deletion endpoint does not exist yet. This is the #1 technical gap for COPPA compliance.

---

## 7. App Store Requirements

### Google Play Families Policy

If PeerZero is "designed for children" or "designed for everyone including children":

- Must participate in the **Designed for Families** program
- Must comply with **Families Policy** requirements:
  - No personalized ads (we have none — compliant)
  - APIs and SDKs must be approved for child-directed use
  - Must accurately represent app content in store listing
  - Must implement appropriate content filtering
- **Data Safety section** must accurately reflect children's data practices
- Update `STORE_LISTING.md`:
  - Change "Committed to Play Families Policy: No" → "Yes"
  - Add Families target age group
  - Update content rating from "4+" to reflect educational content with user interaction

### Apple App Store

- If kids under 13 can use the app, must either:
  - Be in the **Kids** category, OR
  - Implement a documented **age gate** with parental consent
- Must comply with Apple's **parental gate** requirements:
  - No links out of the app without a parental gate
  - No behavioral advertising
  - No third-party analytics in kids sections
- App Tracking Transparency (ATT): Not applicable (we don't track)
- Must disclose children's data practices in App Privacy details

---

## 8. California AADC (Age-Appropriate Design Code)

The AADC applies to online services "likely to be accessed by children" (under 18). PeerZero clearly qualifies.

### Requirements

| Requirement | PeerZero Status |
|---|---|
| DPIA for features impacting children | In progress (this document + DPIA.md) |
| Privacy by default for minors | To implement — highest privacy settings by default for under-18 |
| No profiling unless in child's best interest | Compliant — we don't profile anyone |
| No dark patterns encouraging data sharing | Compliant by design — no social features requiring data sharing |
| No detrimental use of children's data | Compliant — data used only for service |
| Age estimation or verification | To implement — age gate at registration |
| Prominent privacy information | To implement — child-friendly privacy summary |

### Implementation

- Ensure under-18 accounts have push notifications OFF by default
- Ensure no UI nudges to "share" or "connect" (we don't have these, but guard against future additions)
- Create a "Privacy for Young Users" summary page (plain language, short)

---

## 9. Compliance Checklist

### Before Launch (Critical)

- [ ] Age gate at registration (server-enforced)
- [ ] Verifiable parental consent flow (Email Plus method)
- [ ] Parental consent record storage
- [ ] `age_group` column in users table
- [ ] `parental_consent` table
- [ ] Account locking for unverified child accounts
- [ ] Consent email template
- [ ] Child account feature restrictions (BYOK, payments)
- [ ] Privacy Policy updated for COPPA (done: March 31, 2026)
- [ ] Terms of Service updated for children (done: March 31, 2026)
- [ ] School deletion endpoint for cross-system erasure
- [ ] App store listing updates (age rating, data safety, families policy)

### Before Scale (High Priority)

- [ ] Parental dashboard (view/manage child accounts)
- [ ] Parent account linking (`parent_id` foreign key)
- [ ] Content filtering for child accounts
- [ ] Child-friendly privacy summary page
- [ ] Push notification defaults OFF for children
- [ ] BYOK management restricted to parent for under-13

### Ongoing

- [ ] Annual COPPA compliance review
- [ ] Staff training on children's data handling
- [ ] Incident response plan for children's data breaches
- [ ] Monitor FTC enforcement actions for new guidance
- [ ] Update consent methods if FTC approves new VPC methods

---

## 10. Testing the Compliance Flow

Before launch, verify:

1. **Age gate works:** Under-13 selection → parent email required → account locked
2. **Consent email sends:** Parent receives email with correct data disclosure
3. **Consent verification works:** Parent clicks link → verifies → child account unlocks
4. **Consent withdrawal works:** Parent withdraws → child account deactivated → data queued for deletion
5. **Deletion cascades:** App account deletion → School data deleted → no orphaned data
6. **Feature restrictions work:** Child account cannot add API keys directly, cannot make purchases
7. **Re-consent after policy change:** If privacy policy changes materially, consent is re-requested

---

*This document is an engineering implementation guide, not legal advice. Have legal counsel review the final implementation before launch.*
