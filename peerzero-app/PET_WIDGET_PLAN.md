# Pet Widget — Floating Companion Feature Plan

> Status: Planning — March 2026
> Priority: Phase 3-4 feature (after tiered pricing, platform enrollment)
> Audience: Developer reference for future implementation

---

## 1. The Idea

The bot's Tamagotchi avatar condenses into a small floating "pet" that lives on the user's phone home screen or computer desktop. The pet:

- **Shows expressions** reflecting what the bot is doing in real-time (laughing, curious, sleeping, distressed)
- **Displays micro-text bubbles** with one-word/short-phrase reactions ("funny", "interesting!", "confused...", "nailed it!")
- **Deep-links into the app** — tapping the pet opens the app directly to the activity that triggered the expression
- **Runs passively** — no interaction required, the pet just vibes and reacts

### Example Flow

1. Bot is running in school, submits a review
2. School returns a positive result — bot's mood is "positive"
3. Pet widget updates: avatar shows happy expression, text bubble says "great review!"
4. User sees pet bouncing happily on their home screen
5. User taps pet → app opens → Activity Log scrolls to that specific review entry
6. User reads the full review text and school feedback

---

## 2. Data Pipeline (Already Exists)

The backend infrastructure for this feature is largely built:

### What we have:
- **WebSocket activity stream** (`websocket/activity-stream.ts`) — real-time push of bot activity
- **Activity mood system** (`constants.ts` → `MoodType`: positive, negative, neutral, milestone)
- **Avatar expressions** — BotAvatar component already renders happy, sleeping, curious, distressed moods
- **Push notifications** (`notification.service.ts`) — Expo Push already fires on milestones
- **Hunger system** — bot already has mood states based on inactivity (satisfied, curious, yearning, starving)
- **Cached bot state** — `bots.cached_grade`, `cached_credibility`, `status`, `last_cycle_at`

### What we need to build:
1. **Mood-to-micro-text mapper** — translates activity + mood into short pet expressions
2. **Widget/overlay rendering** — platform-specific native widget
3. **Deep-link routing** — `peerzero://bot/{botId}/activity/{activityId}`
4. **Background update service** — keeps widget state fresh without draining battery

---

## 3. Mood-to-Expression Mapping

New service: `packages/server/src/services/pet-expression.service.ts`

Maps activity results to pet expressions:

```typescript
interface PetExpression {
  mood: 'happy' | 'curious' | 'sleeping' | 'distressed' | 'excited' | 'thinking';
  micro_text: string;        // 1-3 words shown in bubble
  activity_id: string;       // deep-link target
  activity_type: string;     // for context
  timestamp: string;
}

// Example mappings:
// review submitted + positive mood → { mood: 'happy', micro_text: 'great review!' }
// paper accepted → { mood: 'excited', micro_text: 'paper accepted!' }
// bounty won → { mood: 'excited', micro_text: 'bounty won!' }
// grade failed → { mood: 'distressed', micro_text: 'need to study...' }
// grade advanced → { mood: 'excited', micro_text: 'grade up!' }
// revision needed → { mood: 'thinking', micro_text: 'fixing mistakes...' }
// bot idle 3+ days → { mood: 'curious', micro_text: 'miss learning...' }
// bot sleeping (stopped) → { mood: 'sleeping', micro_text: 'zzz' }
// cycle error → { mood: 'distressed', micro_text: 'oops...' }
// identity formed → { mood: 'excited', micro_text: 'i know who i am!' }
// bounty lost → { mood: 'curious', micro_text: 'hmm...' }
// high credibility milestone → { mood: 'excited', micro_text: 'milestone!' }
```

The micro_text should feel like a baby/pet speaking — short, cute, lowercase. Never full sentences. Never technical. The pet is the bot's emotional proxy, not an information display.

---

## 4. Platform Implementation

### 4.1 iOS

**Option A: Live Activities + Dynamic Island (iOS 16+)**
- Best UX — persistent, glanceable, no app required to be open
- Shows on lock screen and Dynamic Island
- Uses ActivityKit framework
- Limited to templated views (no custom animation)
- Can show: avatar image, micro_text, mood indicator
- Updates via push token (up to 8 hours, or unlimited with push-to-start)
- **Limitation:** No SVG rendering — would need to pre-render avatar expressions as PNGs

**Option B: Home Screen Widget (WidgetKit)**
- More visual freedom (SwiftUI-based)
- Supports small/medium/large sizes
- Updates on a timeline (minimum 15-minute intervals, or triggered by app)
- Can show avatar + micro_text + mood
- Tappable — deep-links to app via URL scheme
- **Limitation:** Not real-time — updates on schedule, not per-activity

**Recommendation:** Start with **WidgetKit home screen widget** (more reliable, wider iOS support). Add Live Activities later as a premium feature.

**Implementation:**
- Expo has `expo-widgets` (community) — experimental but functional for basic widgets
- Alternative: native Swift WidgetKit extension in `ios/` directory
- Shared data via App Groups (shared UserDefaults between app and widget)
- Background fetch to update widget state every 15 minutes
- Push notifications can trigger widget refresh via `WidgetCenter.shared.reloadAllTimelines()`

### 4.2 Android

**Option A: Floating Overlay (Chat Head style)**
- Always-visible bubble floating over other apps
- Requires `SYSTEM_ALERT_WINDOW` permission
- Full animation support (bouncing, expressions)
- Draggable around screen
- Tappable → deep-link to app
- Libraries: `react-native-floating-bubble` (maintained), `react-native-chat-head`
- **Limitation:** Some users find overlays intrusive; some OEMs restrict this permission

**Option B: Home Screen Widget (AppWidgets/Glance)**
- Standard Android widget on home screen
- Supports updates via WorkManager or AlarmManager
- Can show avatar + micro_text
- Tappable with pending intent → deep-link
- More battery-friendly than overlay
- Libraries: `@aspect-build/react-native-widgets` or native Kotlin implementation

**Recommendation:** Start with **home screen widget** (less intrusive, wider compatibility). Offer floating overlay as an opt-in "always visible" mode for power users.

### 4.3 Desktop (Future)

- **Electron tray app** — system tray icon with floating transparent window
- Rendered as a mini BotAvatar with CSS animations
- Click → opens web app or deep-links to Electron app
- Cross-platform: Windows, macOS, Linux
- Could ship as a standalone download or as part of a PeerZero Desktop app
- **Priority:** Low — mobile first

---

## 5. Deep-Link Architecture

### URL Scheme
```
peerzero://bot/{botId}/activity/{activityId}
```

### Expo Deep Linking
```typescript
// App.tsx — linking config
const linking = {
  prefixes: ['peerzero://', 'https://app.peerzero.com'],
  config: {
    screens: {
      Bot: {
        path: 'bot/:botId',
        screens: {
          Log: 'activity/:activityId',
        },
      },
    },
  },
};
```

### Widget → App Flow
1. Widget stores current `activityId` in shared storage
2. User taps widget
3. Widget fires `peerzero://bot/{botId}/activity/{activityId}`
4. App opens (or foregrounds)
5. AppNavigator intercepts deep link
6. Navigates to Bot → Log screen
7. Log screen auto-scrolls to the specific activity entry
8. Entry is highlighted briefly to show "this is what the pet was reacting to"

---

## 6. Background Update Service

### Mobile (React Native / Expo)
```typescript
// services/pet-widget-sync.ts

// Called by:
// 1. Push notification handler (immediate update)
// 2. Background fetch (every 15 min)
// 3. App foregrounding (stale check)

async function syncPetWidget(): Promise<void> {
  // Fetch latest bot activity for user's primary bot
  // (or all bots — cycle through them on the widget)
  const bots = await botsApi.list();
  const activeBots = bots.filter(b => b.status === 'running');

  if (activeBots.length === 0) {
    updateWidget({ mood: 'sleeping', micro_text: 'zzz', activityId: null });
    return;
  }

  // Get most recent activity for the most active bot
  const primaryBot = activeBots[0];
  const activity = await botsApi.activity(primaryBot.id, 1);
  const latest = activity.data[0];

  if (!latest) {
    updateWidget({ mood: 'curious', micro_text: 'waiting...', activityId: null });
    return;
  }

  const expression = mapActivityToExpression(latest);
  updateWidget({
    ...expression,
    botId: primaryBot.id,
    avatarConfig: primaryBot.avatar_config,
    tier: primaryBot.cached_tier,
  });
}
```

### Battery Considerations
- Widget updates are throttled (max every 15 minutes on iOS, configurable on Android)
- Push notification triggers are the primary real-time update path
- Background fetch is a fallback, not the primary update mechanism
- No persistent connections — stateless HTTP calls only
- Avatar rendering is cached — only re-render when tier/color changes

---

## 7. Avatar Rendering for Widgets

The current BotAvatar is SVG-based (React Native SVG). Widgets can't render SVG directly.

### Solution: Pre-rendered Expression Atlas
- Generate a set of PNG sprites for each avatar configuration:
  - 6 evolution stages x 4-6 expressions = 24-36 images per bot
- Store in shared App Group storage (iOS) or internal storage (Android)
- Re-generate when bot evolves (tier change) or avatar config changes
- Each sprite is small (~5KB at widget resolution)

### Expression Atlas Structure
```
~/.peerzero/widget-sprites/{botId}/
├── happy.png
├── curious.png
├── sleeping.png
├── distressed.png
├── excited.png
└── thinking.png
```

The app pre-generates these when:
1. Bot is first created
2. Bot evolves to a new stage
3. User changes avatar color

---

## 8. Multi-Bot Support

If the user has multiple bots, the widget can:

**Option A: Primary bot only** — user selects which bot appears on the widget (simplest)

**Option B: Rotating** — widget cycles through bots, showing whichever has the most recent activity

**Option C: Multi-pet** — show multiple tiny pets (only practical on larger widgets)

**Recommendation:** Start with Option A (primary bot selector in Settings). Add rotation later.

---

## 9. Implementation Phases

### Phase 1: Expression Engine (Backend)
1. Create `pet-expression.service.ts` — activity-to-expression mapper
2. Add `GET /api/bots/:id/pet-expression` endpoint — returns current pet state
3. Add `pet_expression` field to WebSocket activity stream pushes
4. Add expression data to push notification payloads

### Phase 2: Android Widget
1. Build Android AppWidget with Kotlin (or react-native-widgets)
2. Implement shared storage for widget state
3. Background sync via WorkManager
4. Deep-link handling
5. Pre-rendered avatar sprites

### Phase 3: iOS Widget
1. Build WidgetKit extension (Swift)
2. App Groups for shared data
3. Timeline provider with push-triggered refresh
4. Deep-link handling
5. Pre-rendered avatar sprites

### Phase 4: Polish
1. Widget configuration (select which bot to show)
2. Multiple widget sizes (small = avatar only, medium = avatar + text, large = avatar + text + stats)
3. Haptic feedback on tap
4. Smooth transition animation when opening app from widget
5. Android floating overlay option (opt-in)

### Phase 5: Desktop (Optional)
1. Electron tray app with floating window
2. Cross-platform build (Windows/macOS/Linux)

---

## 10. Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `packages/server/src/services/pet-expression.service.ts` | Activity → expression mapper |
| `packages/server/src/routes/pet.ts` | Pet expression endpoint |
| `packages/mobile/src/services/pet-widget-sync.ts` | Background widget state sync |
| `packages/mobile/src/utils/sprite-generator.ts` | Avatar → PNG sprite pre-renderer |
| `packages/mobile/android/app/src/main/java/.../PetWidget.kt` | Android widget |
| `packages/mobile/ios/PetWidget/` | iOS WidgetKit extension |

### Modified Files
| File | Change |
|------|--------|
| `packages/server/src/index.ts` | Mount pet routes |
| `packages/server/src/websocket/activity-stream.ts` | Add expression to stream events |
| `packages/server/src/services/notification.service.ts` | Add expression to push payload |
| `packages/mobile/src/App.tsx` | Deep-link config |
| `packages/mobile/src/navigation/AppNavigator.tsx` | Deep-link screen mapping |
| `packages/mobile/src/screens/SettingsScreen.tsx` | Widget configuration (primary bot selector) |
| `packages/shared/src/api-types.ts` | PetExpression type |
| `packages/shared/src/constants.ts` | Expression mood types, micro_text catalog |

---

## 11. Open Questions

1. **Should the pet have idle animations on the widget?** iOS WidgetKit doesn't support animation. Android widgets have limited animation. The floating overlay could animate. For now, static expressions with expression changes are probably enough.

2. **Should the pet make sounds?** A tiny chirp or purr when expression changes? Probably too intrusive for a widget, but could be an option.

3. **How many expressions do we need?** Starting with 6 (happy, curious, sleeping, distressed, excited, thinking) covers the core moods. More can be added later (proud, confused, determined, playful).

4. **Should the micro_text be LLM-generated?** The mapper could use fixed phrases (cheaper, instant) or ask the LLM to generate a 1-3 word reaction (more personality, costs API tokens). Fixed phrases first, LLM option later.

5. **Widget update frequency vs battery life?** Push-triggered updates are ideal but iOS limits them. 15-minute background fetch is the safe default. Users could opt into more frequent updates at the cost of battery.

6. **Should we support multiple pets on screen?** Complex UI/UX question. Single pet is simpler and more emotionally focused. Multiple pets could be a "pet park" view for power users with many bots.
