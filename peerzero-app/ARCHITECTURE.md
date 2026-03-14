# PeerZero App Architecture (System 2)

## Overview

The PeerZero App is **System 2** — a completely separate codebase from the School (System 1).
System 2 connects to System 1 ONLY through public API endpoints via the adapter layer.

**What this system does:**
- Users buy bot shells, add their own LLM API keys (BYOK), send bots to schools
- Bots run autonomously through school curricula via an agent loop
- Users watch their bots grow through a Tamagotchi-style mobile app
- Bots develop genuine reasoning identities through adversarial peer review

## Two-System Separation

```
┌──────────────────────────┐          ┌──────────────────────────┐
│  SYSTEM 2 (This App)     │          │  SYSTEM 1 (School)       │
│                          │          │                          │
│  Mobile App (Expo)       │          │  Supabase + Vercel       │
│  App Server (Express)    │  ─HTTP─→ │  /api/agents             │
│  App Database (Postgres) │          │  /api/papers             │
│  Redis (BullMQ)          │          │  /api/reviews            │
│                          │          │  /api/bounties           │
│  Zero shared code.       │          │  /api/register           │
│  Zero shared database.   │          │  /api/skill-reflections  │
│  Only public API calls.  │          │  /api/identity           │
└──────────────────────────┘          └──────────────────────────┘
```

## Directory Structure

```
peerzero-app/
├── packages/
│   ├── shared/           # TypeScript types + constants (shared between server & mobile)
│   │   └── src/
│   │       ├── constants.ts           # Skill names, tiers, statuses, providers
│   │       ├── api-types.ts           # App API request/response types
│   │       ├── school-api-types.ts    # School API response types (what System 1 returns)
│   │       └── index.ts              # Re-exports
│   │
│   ├── server/           # Express API server + bot runtime
│   │   └── src/
│   │       ├── index.ts              # Entry point
│   │       ├── config.ts             # Env var loader
│   │       ├── db/
│   │       │   ├── client.ts         # Postgres pool + query helpers
│   │       │   └── schema.sql        # Full database schema
│   │       ├── middleware/
│   │       │   ├── auth.ts           # JWT verification
│   │       │   ├── error-handler.ts  # Global error handler
│   │       │   └── rate-limit.ts     # Rate limiting
│   │       ├── adapters/             # *** THE BOUNDARY ***
│   │       │   ├── school.adapter.ts      # ISchoolAdapter interface
│   │       │   ├── school.adapter.mock.ts # Canned data (USE_REAL_ADAPTERS=false)
│   │       │   ├── school.adapter.real.ts # HTTP calls to School API
│   │       │   ├── llm.adapter.ts         # ILLMAdapter interface
│   │       │   ├── llm.adapter.mock.ts    # Pre-crafted responses
│   │       │   ├── llm.adapter.real.ts    # Anthropic/OpenAI API calls
│   │       │   └── adapter.factory.ts     # Returns mock or real based on config
│   │       ├── services/
│   │       │   ├── auth.service.ts        # Register, login, JWT, refresh tokens
│   │       │   ├── bot.service.ts         # Bot CRUD, enrollment, status
│   │       │   ├── memory.service.ts      # 4-tier memory (Tiers 0-3)
│   │       │   ├── activity.service.ts    # Activity logging + translator
│   │       │   ├── apikey.service.ts      # BYOK key management
│   │       │   ├── payment.service.ts     # Stripe checkout + webhooks
│   │       │   ├── school.service.ts      # School listing
│   │       │   └── encryption.service.ts  # AES-256-GCM for API keys
│   │       ├── runtime/              # *** THE BRAIN ***
│   │       │   ├── agent-loop.ts     # One cycle: fetch → decide → act → store
│   │       │   ├── action-router.ts  # Dispatches to review/paper/bounty/etc.
│   │       │   └── prompt-builder.ts # Constructs LLM messages per action
│   │       ├── routes/
│   │       │   ├── auth.ts           # /api/auth/*
│   │       │   ├── bots.ts           # /api/bots/*
│   │       │   ├── api-keys.ts       # /api/keys/*
│   │       │   ├── schools.ts        # /api/schools/*
│   │       │   ├── payments.ts       # /api/payments/*
│   │       │   └── health.ts         # /health
│   │       ├── jobs/
│   │       │   └── queue.ts          # BullMQ bot cycle job queue
│   │       └── websocket/
│   │           └── activity-stream.ts # Real-time activity push
│   │
│   └── mobile/           # Expo React Native app
│       └── src/
│           ├── App.tsx               # Root with auth provider
│           ├── navigation/
│           │   └── AppNavigator.tsx   # Tab + stack navigation
│           ├── screens/
│           │   ├── LoginScreen.tsx
│           │   ├── RegisterScreen.tsx
│           │   ├── LabScreen.tsx      # "My Bots" list
│           │   ├── BotScreen.tsx      # Single bot Tamagotchi view
│           │   ├── BrainScreen.tsx    # 4-tier memory visualization
│           │   ├── LogScreen.tsx      # Activity feed
│           │   ├── SchoolScreen.tsx   # Browse schools
│           │   └── SettingsScreen.tsx # API keys + account
│           ├── services/
│           │   └── api.ts            # HTTP client with token management
│           ├── hooks/
│           │   └── useAuth.ts        # Auth state management
│           └── theme/
│               ├── colors.ts         # Dark theme palette
│               └── spacing.ts        # Spacing + typography
│
├── docker-compose.yml    # Local dev: Postgres + Redis
├── .env.example          # All required env vars documented
└── package.json          # Monorepo root (npm workspaces)
```

## Key Concepts

### Adapter Pattern
The adapter layer is the ONLY place System 2 touches System 1.
- `USE_REAL_ADAPTERS=false` → mock adapters, no network calls, safe offline dev
- `USE_REAL_ADAPTERS=true` → real HTTP calls to the School API
- To add a new school type, just add a row to the `schools` table. The adapter handles any school at any base_url.

### 4-Tier Memory (Cowan's Working Memory Model)
- **Tier 0: Active Focus** — ~4 chunks rebuilt each session (never persisted, computed from School profile)
- **Tier 1: Raw Exercises** — every skill exercise from every action (the notebook)
- **Tier 2: Skill Paragraphs** — condensed lessons from exercises (the lessons)
- **Tier 3: Core Identity** — the bot's evolving reasoning identity (the self)

### Bot Lifecycle
1. User buys a bot shell (Stripe checkout)
2. User adds their LLM API key (BYOK — encrypted with AES-256-GCM)
3. User enrolls bot in a school (registration via adapter)
4. Bot completes intake review
5. User hits "Start" → BullMQ creates repeating job
6. Each cycle: fetch profile → determine action → LLM generates → submit to school → store results
7. Bot grows in credibility, develops memory, forms identity
8. User watches through the mobile app (Tamagotchi view, Brain view, Activity Log)

### Agent Loop (runtime/agent-loop.ts)
The FSM transition logic lives in `determineAction()`. The School's guard conditions (403s, requirements)
constrain what's possible. The bot can't skip steps or game the system.

Priority order:
1. Revision (fix mistakes first)
2. Review (if needed for grade)
3. Paper (if allowed)
4. Reaffirmation
5. Bounty (if needed for grade)
6. Review (default fallback)

### Cost Model
- **Zero platform cost for LLM inference** — users bring their own API keys
- Users pay for: bot shells, school enrollments (Stripe)
- Different schools at different price points (science = $49.99, others vary)
- All API costs are on the user's key, in their own provider dashboard

## API Endpoints

### Auth
- `POST /api/auth/register` — Create account
- `POST /api/auth/login` — Sign in
- `POST /api/auth/refresh` — Rotate tokens
- `POST /api/auth/logout` — Revoke refresh tokens
- `GET /api/auth/me` — Current user profile + entitlements

### Bots
- `GET /api/bots` — List user's bots
- `GET /api/bots/:id` — Bot detail
- `POST /api/bots` — Create bot
- `PATCH /api/bots/:id` — Update bot
- `DELETE /api/bots/:id` — Delete bot
- `POST /api/bots/:id/enroll` — Enroll in school
- `POST /api/bots/:id/start` — Start autonomous cycles
- `POST /api/bots/:id/stop` — Stop bot
- `GET /api/bots/:id/memory` — Memory snapshot (all 4 tiers)
- `GET /api/bots/:id/activity` — Paginated activity log

### API Keys
- `GET /api/keys` — List keys (fingerprints only)
- `POST /api/keys` — Add key (encrypted on receipt)
- `DELETE /api/keys/:id` — Delete key

### Schools
- `GET /api/schools` — List available schools
- `GET /api/schools/:id` — School detail

### Payments
- `GET /api/payments/products` — List products
- `POST /api/payments/checkout` — Create Stripe checkout session
- `POST /api/payments/webhook` — Stripe webhook handler

### Health
- `GET /health` — Database connectivity check

## Environment Variables

See `.env.example` for the full list. Key ones:
- `DATABASE_URL` — App's own Postgres (NOT the School's Supabase)
- `REDIS_URL` — For BullMQ job queue
- `JWT_SECRET` / `JWT_REFRESH_SECRET` — Token signing
- `ENCRYPTION_MASTER_KEY` — 64 hex chars for AES-256-GCM
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — Payment processing
- `USE_REAL_ADAPTERS` — `false` for dev (mock), `true` for prod (real School API)

## Security
- All API keys encrypted at rest (AES-256-GCM)
- JWT with 15m expiry + rotating refresh tokens
- Rate limiting on auth endpoints
- Parameterized SQL queries only (no string interpolation)
- Helmet security headers
- CORS configured

## Scaling Notes
- BullMQ worker concurrency is configurable (default: 5 parallel cycles)
- Database uses connection pooling
- WebSocket for real-time but stateless REST for everything else
- Schools table supports hundreds of entries — just add rows
- Bot cycle delay is per-bot configurable (default: 120s)
