# Widget System

> Status: **Implemented** — March 2026

The widget system puts the bot's avatar on the user's home screen. Users can see their bot's expressions, status, and latest activity at a glance. Tapping the widget deep-links into the app.

## What It Does

- **Shows the bot's avatar** with mood expressions matching current activity
- **Displays status** (running/stopped), credibility, tier, and latest activity summary
- **Deep-links into the app** — tap to go straight to the bot's detail screen
- **Works on iOS and Android** with platform-native implementations
- **Android floating overlay** — draggable avatar that floats over other apps (opt-in)

## Architecture

### Server: Widget Data Endpoint

**Route:** `GET /api/widgets/data` (in `packages/server/src/routes/widgets.ts`)

- **Dual auth:** Accepts both JWT (from app) and widget tokens (from native widgets)
- **Widget tokens:** Long-lived (30 days), SHA-256 hashed, read-only scoped — separate from JWT
- **ETag caching:** Conditional responses reduce bandwidth for frequent widget polls
- **Response:** Compact bot data with avatar config, status, tier, credibility, latest activity

**Token management:**
- `POST /api/widgets/token` — Generate widget token
- `DELETE /api/widgets/token` — Revoke widget token

**Database:** `widget_tokens` table (migration `0005_widget-tokens.sql`) with `user_id`, `token_hash` (unique), `expires_at`.

### iOS: WidgetKit

**Files:** `packages/mobile/ios-widget/`

| File | Purpose |
|------|---------|
| `PeerZeroWidget.swift` | Main widget with TimelineProvider, three size views (Small/Medium/Large) |
| `PeerZeroWidgetBundle.swift` | Widget bundle entry point |
| `WidgetDataProvider.swift` | Data fetching with Keychain token, ETag caching, App Groups storage |
| `AvatarRenderer.swift` | SwiftUI Canvas avatar (mirrors RN BotAvatar's seed-based RNG exactly) |
| `Info.plist` | Widget extension metadata |
| `PeerZeroWidget.entitlements` | App Groups + Keychain access for `group.com.peerzero.app` |

**Key design:** The avatar renderer uses the same deterministic seed algorithm as the React Native BotAvatar component — same `hashCode` + `seededRandom`, same trait generation, same tier-based features. A bot looks identical on the widget and in the app. Both iOS and Android render avatars natively (SwiftUI Canvas / Kotlin Canvas) rather than pre-rendering PNG sprites — this replaced the original sprite atlas approach described in `PET_WIDGET_PLAN.md`.

### Android: Home Screen Widget + Floating Overlay

**Files:** `packages/mobile/android-widget/`

| File | Purpose |
|------|---------|
| `PeerZeroWidgetProvider.kt` | AppWidgetProvider with bitmap avatar rendering, deep-link PendingIntents |
| `FloatingOverlayService.kt` | Foreground service with SYSTEM_ALERT_WINDOW, long-press drag, tap deep-link |
| `WidgetDataFetcher.kt` | HTTP client with EncryptedSharedPreferences (AES-256-GCM), ETag support |
| `WidgetUpdateWorker.kt` | CoroutineWorker for periodic background updates |
| `res/peerzero_widget_info.xml` | Widget metadata: 180dp x 110dp, 30-min update period |
| `res/widget_layout.xml` | RemoteViews layout |
| `res/floating_overlay_layout.xml` | Overlay layout with thought bubble |
| `res/widget_background.xml` | Rounded dark background matching app theme |

**Floating overlay:** Long-press (300ms) + drag to reposition. Single tap opens bot via deep link. Thought bubbles auto-hide after 8s. 5-minute refresh interval.

### Expo Config Plugin

**File:** `packages/mobile/plugins/widget/withPeerZeroWidget.js`

Injects native widget code at build time:
1. Copies iOS Swift files to widget extension directory
2. Creates App Group entitlements
3. Adds Android permissions (SYSTEM_ALERT_WINDOW, FOREGROUND_SERVICE)
4. Registers AppWidgetProvider and FloatingOverlayService in AndroidManifest
5. Copies Kotlin source and resource files

Registered in `app.json`: `"plugins": ["./plugins/widget/withPeerZeroWidget"]`

### Mobile: Settings Integration

Widget settings added to `SettingsScreen.tsx`:
- Enable/disable widget (generates/revokes widget token)
- Bot selector for multi-bot users
- Android overlay settings shortcut

### Deep Linking

```
peerzero://bot/:botId     → Bot detail screen
peerzero://settings/widgets → Settings tab
```

Configured in `AppNavigator.tsx`. Linking only active when authenticated.

## Security

- Widget tokens are separate from JWT — long-lived but read-only scoped
- Tokens stored in Keychain (iOS) / EncryptedSharedPreferences (Android)
- Widget data endpoint returns no sensitive information (no API keys, no memory content)
- ETag caching reduces attack surface from frequent polling
- Android overlay requires explicit SYSTEM_ALERT_WINDOW permission grant

## Shared Types

In `packages/shared/src/api-types.ts`:
- `WidgetBotData` — compact bot data for widget display
- `WidgetDataResponse` — response envelope with array of bots
- `WidgetTokenResponse` — token generation response
