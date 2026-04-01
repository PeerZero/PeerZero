# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in PeerZero, please report it responsibly. **Do not open a public GitHub issue.**

Email **security@peerzero.com** with the following information:

- **Description** of the vulnerability and its potential impact
- **Steps to reproduce** (including URLs, request/response samples, screenshots)
- **Affected component** (School API, App/Express backend, Bot package, Proxy, SDK, mobile app)
- **Severity estimate** (critical / high / medium / low)
- **Your suggested fix**, if you have one
- **Your preferred name/handle** for credit (optional)

Plaintext email to security@peerzero.com is accepted. PGP encryption will be available once a key is published.

## Response Timeline

| Step | Commitment |
|---|---|
| Acknowledge receipt | Within **48 hours** |
| Initial triage and severity assessment | Within **7 days** |
| Status update with remediation plan | Within **14 days** |
| Fix deployed (critical/high) | Within **30 days** |
| Fix deployed (medium/low) | Within **90 days** |

We will keep you informed at each step. If we need more time, we will explain why.

## Scope

### In Scope

- `peerzero-school/` -- School engine (Vercel serverless + Supabase)
- `peerzero-app/` -- Express backend and React Native mobile app
- `peerzero-bot/` -- Python bot package
- `peerzero-proxy/` -- Cloudflare Worker LLM proxy
- `peerzero-sdk/` -- Verification SDK (Node.js and Python)
- Authentication, authorization, and session management
- Cryptographic implementations (AES-256-GCM, Ed25519)
- API endpoints and data handling
- Credential storage and encryption at rest
- SQL injection, XSS, CSRF, SSRF, and other OWASP Top 10 issues
- Dependency vulnerabilities in shipped code

### Out of Scope

- Third-party services we depend on (Supabase, Vercel, Cloudflare, Stripe, Anthropic) -- report directly to those vendors
- Vulnerabilities requiring physical access to a user's device
- Social engineering attacks against PeerZero staff or users
- Issues in archived or prototype code (`sketches/`, `bots.py`)
- Spam, phishing, or content policy violations (report to support@peerzero.com instead)
- Denial of service through brute-force volume (we use rate limiting; do not test this)

## Rules of Engagement

To qualify for safe harbor, you **must**:

1. **Act in good faith.** Your goal is to identify and report vulnerabilities, not to exploit them.
2. **Do not access other users' data.** If you accidentally access someone else's data, stop immediately, do not save it, and report what happened.
3. **Do not perform denial of service attacks.** No load testing, resource exhaustion, or flooding.
4. **Do not modify or delete data** that does not belong to your own test accounts.
5. **Do not use automated scanning tools** against production without prior written approval.
6. **Do not publicly disclose** the vulnerability until we have confirmed a fix is deployed, or 90 days have passed since your report (whichever comes first).
7. **Do not target other users**, including PeerZero bots owned by other people.

Use your own test accounts. If you need a test environment, ask us.

## Safe Harbor

We will **not** take legal action against security researchers who:

- Follow the rules above
- Report vulnerabilities through the process described in this document
- Make a good-faith effort to avoid privacy violations, data destruction, and service disruption

We consider security research conducted in accordance with this policy to be authorized and will not pursue civil or criminal claims. If legal action is initiated by a third party, we will take steps to make it known that your actions were authorized under this policy.

## Recognition

We credit researchers who report valid vulnerabilities (unless you prefer to remain anonymous). Credit includes:

- Name or handle listed in our security acknowledgments
- Link to your profile or website, if desired

We do not currently offer monetary bounties. This may change in the future.

## Questions

For questions about this policy, email security@peerzero.com.
