# Software Bill of Materials (SBOM)

Generated: 2026-04-04
Format: Human-readable dependency listing (CycloneDX/SPDX export recommended for formal compliance)

This document lists all direct dependencies across PeerZero's systems, as required by the EU Cyber Resilience Act (reporting: September 11, 2026).

---

## System 1: School Server (peerzero-school/)

Runtime: Node.js (Vercel Serverless Functions)

| Package | Version Constraint | Purpose |
|---|---|---|
| @supabase/supabase-js | ^2.39.0 | Database client (PostgreSQL via Supabase) |

No other runtime dependencies. All logic is vanilla Node.js using built-in modules (`crypto`, `http`).

---

## System 2: App Server (peerzero-app/packages/server/)

Runtime: Node.js + Express

### Production Dependencies

| Package | Version Constraint | Purpose |
|---|---|---|
| bcryptjs | ^2.4.3 | Password hashing |
| bullmq | ^5.20.0 | Job queue (bot training cycles) |
| cors | ^2.8.5 | Cross-origin resource sharing |
| dotenv | ^17.3.1 | Environment variable loading |
| express | ^4.21.2 | HTTP framework |
| express-async-errors | ^3.1.1 | Async error handling |
| express-rate-limit | ^7.4.0 | Rate limiting |
| helmet | ^8.0.0 | Security headers |
| ioredis | ^5.4.0 | Redis client (rate limiting, sessions) |
| jsonwebtoken | ^9.0.3 | JWT authentication |
| node-pg-migrate | ^7.0.0 | Database migrations |
| pg | ^8.13.0 | PostgreSQL client |
| pino | ^9.5.0 | Structured logging |
| pino-pretty | ^13.0.0 | Log formatting (dev) |
| resend | ^6.9.4 | Transactional email |
| stripe | ^17.0.0 | Payment processing |
| uuid | ^10.0.0 | UUID generation |
| ws | ^8.18.0 | WebSocket (real-time activity streaming) |

### Dev Dependencies

| Package | Version Constraint | Purpose |
|---|---|---|
| @types/bcryptjs | ^2.4.6 | TypeScript types |
| @types/cors | ^2.8.17 | TypeScript types |
| @types/express | 4.17.21 | TypeScript types |
| @types/jsonwebtoken | ^9.0.7 | TypeScript types |
| @types/node | ^25.5.0 | TypeScript types |
| @types/pg | ^8.11.0 | TypeScript types |
| @types/uuid | ^10.0.0 | TypeScript types |
| @types/ws | ^8.5.12 | TypeScript types |
| tsx | ^4.19.0 | TypeScript execution |
| typescript | ^5.6.0 | TypeScript compiler |
| vitest | ^2.1.0 | Test framework |

---

## System 2: Mobile App (peerzero-app/packages/mobile/)

Runtime: React Native (Expo)

| Package | Version Constraint | Purpose |
|---|---|---|
| expo | ~54.0.0 | React Native framework |
| expo-device | ~7.0.0 | Device info |
| expo-haptics | ^55.0.9 | Haptic feedback |
| expo-notifications | ~0.29.0 | Push notifications |
| expo-secure-store | ~14.0.0 | Secure credential storage |
| expo-status-bar | ~2.2.0 | Status bar control |
| expo-web-browser | ~14.0.0 | In-app browser |
| react | 19.1.5 | UI framework |
| react-dom | 19.1.5 | DOM rendering |
| react-native | 0.81.0 | Mobile framework |
| react-native-safe-area-context | ~5.4.0 | Safe area handling |
| react-native-screens | ~4.11.0 | Native navigation |
| react-native-svg | ~15.11.0 | SVG rendering (avatars) |
| react-native-web | ~0.20.0 | Web support |
| @react-navigation/native | ^7.0.0 | Navigation |
| @react-navigation/native-stack | ^7.0.0 | Stack navigation |
| @react-navigation/bottom-tabs | ^7.0.0 | Tab navigation |
| @react-navigation/stack | ^7.8.5 | Stack navigation |
| @react-native-community/slider | ^4.5.0 | Slider component |
| @expo/metro-runtime | ~4.0.1 | Metro bundler |

---

## System 3: Bot (peerzero-bot/)

Runtime: Python 3.10+

| Package | Version Constraint | Purpose |
|---|---|---|
| anthropic | >=0.40.0 | Anthropic Claude SDK |
| openai | >=1.0.0 | OpenAI SDK |
| httpx | >=0.25.0 | HTTP client (proxy, webhooks) |
| h11 | >=0.16.0 | HTTP/1.1 protocol (pinned for CVE-2025-43859) |
| tomli | >=2.0.0 | TOML parsing (Python <3.11 only) |

### Dev/Test Dependencies

| Package | Version Constraint | Purpose |
|---|---|---|
| pytest | >=8.0 | Test framework |
| pytest-asyncio | >=0.23 | Async test support |
| setuptools | >=68.0 | Package building |

---

## Proxy (peerzero-proxy/)

Runtime: Cloudflare Workers

| Package | Version Constraint | Purpose |
|---|---|---|
| wrangler | ^4.0.0 | Cloudflare Workers CLI |
| @cloudflare/workers-types | ^4.0.0 | TypeScript types |
| typescript | ^5.0.0 | TypeScript compiler |

No runtime dependencies. Uses Cloudflare Workers built-in APIs only.

---

## SDK — Node.js (peerzero-sdk/node/)

Runtime: Node.js

Zero external dependencies. Uses only built-in `crypto` module.

---

## SDK — Python (peerzero-sdk/python/)

Runtime: Python 3.8+

| Package | Version Constraint | Purpose |
|---|---|---|
| cryptography | >=41.0 | Ed25519 signature verification |
| httpx | >=0.25 | HTTP client for key fetching |

### Dev/Test Dependencies

| Package | Version Constraint | Purpose |
|---|---|---|
| pytest | >=8.0 | Test framework |
| setuptools | >=68.0 | Package building |

---

## Supply Chain Security Practices

- All CI installs use `--ignore-scripts` (mitigates npm supply chain attacks)
- `npm audit` and `pip-audit` run on every CI build (fail on high/critical)
- Semgrep static analysis runs OWASP Top 10 + security audit + secrets rulesets
- No post-install scripts in any package
- Lock files committed for reproducible builds
