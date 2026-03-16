# Completed Work & Implementation Status

Tracks what's been built and what remains.

---

## Widget System (March 2026) — COMPLETE

Full home screen widget system for iOS and Android. See [widget-system.md](widget-system.md) for details.

**Built:**
- Server widget data endpoint with dual auth (JWT + widget token), ETag caching
- Widget token system (SHA-256 hashed, 30-day expiry, read-only scoped)
- iOS WidgetKit extension (Small/Medium/Large sizes, SwiftUI Canvas avatar)
- Android home screen widget (AppWidgetProvider, WorkManager updates)
- Android floating overlay (foreground service, draggable, thought bubbles)
- Expo config plugin for native code injection at build time
- Deep linking (`peerzero://bot/:botId`, `peerzero://settings/widgets`)
- Settings UI for widget management
- Database migration for `widget_tokens` table

---

## Real-Time Bot Watcher + Multi-Model Support (March 2026) — COMPLETE

Enhanced real-time monitoring and cost optimization.

**Built:**
- External activity WebSocket streaming (`external_activity` event)
- External activity soft-delete (individual + clear all)
- Multi-model routing: science model for papers/reviews/bounties, fast model for condensation/identity
- Fast model selector in CreateBotScreen
- `fast_llm_model` column on bots table
- Database migration for external activity soft-delete + multi-model

---

## Exportable Bot (System 3) — Phases 1-2 COMPLETE

See [system3-exportable-bot.md](system3-exportable-bot.md) for architecture.

**Built:**
- `peerzero-bot` Python package with CLI
- Platform adapter interface (A2A, webhook, School adapters)
- Ed25519 profile signing (School signs, bot verifies)
- Public key at `.well-known/peerzero-public-key.pem`
- A2A Agent Card conversion
- Phone-home activity reporting (bot sender + app receiver)
- Memory firewall (School memory separate from platform memory)
- Multi-model support (strong model for science, fast for utility)
- External activity log with real-time WebSocket streaming
- Soft-delete for external activity entries

**Remaining (Phase 3-4):**
- Hosted runtime multi-platform scheduling
- Mobile app platform enrollment UI
- Platform developer SDK
- Community adapter repository

---

## Core App Features — COMPLETE

- Bot CRUD with procedural avatar generation (6-tier evolution, 256 unique creatures)
- School enrollment via adapter pattern
- 4-tier memory system (Cowan's working memory model)
- BullMQ agent loop with FSM action routing
- Activity logging with human-readable translation and category filtering
- Soft-delete for activity entries
- Bot stats aggregation from activity_log
- Push notifications (Expo Push) for milestones
- Stripe payment integration with tiered grade pricing
- JWT auth with rotating refresh tokens
- AES-256-GCM API key encryption (BYOK)
- Per-user Redis rate limiting
- Append-only audit logging
- Structured logging (pino)

---

## What Still Needs Work

- **Brain screen skill progress bars** (Goal 3 gap — BrainScreen shows memory tiers but not per-skill progress)
- **Real adapter testing** — when School is ready to connect end-to-end
- **Hosted runtime multi-platform** — Phase 3 of exportable bot architecture
- **Performance testing** under concurrent bot load
- **Payment flow on mobile** — Stripe checkout WebView or deep link integration
- **Desktop widget** — Electron tray app (low priority, mobile first)
- **Live Activities / Dynamic Island** on iOS (premium feature, post-launch)
