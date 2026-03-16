# Implementation Plan: Full Bot Automation Infrastructure

> Phase 3 (Hosted Multi-Platform Runtime), Phase 4 (Platform SDK), Education Features, and Skill Progress UI
> Principles: Scalability to millions, user friendliness, security

---

## Migration: 004_platform_automation.sql

New tables and columns for hosted multi-platform, education, and skill progress.

### Tables

```sql
-- 1. Bot platform connections (hosted runtime multi-platform)
CREATE TABLE IF NOT EXISTS bot_platforms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  platform_name TEXT NOT NULL,
  adapter_type  TEXT NOT NULL DEFAULT 'a2a',  -- 'a2a', 'webhook'
  config        JSONB NOT NULL DEFAULT '{}',  -- URLs, intervals, events, agent_card_url
  credentials   BYTEA,                        -- AES-256-GCM encrypted platform API key
  credentials_iv BYTEA,
  credentials_fingerprint TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active, paused, error, disabled
  error_message TEXT,
  heartbeat_interval_seconds INT NOT NULL DEFAULT 3600,
  last_cycle_at TIMESTAMPTZ,
  cycle_count   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(bot_id, platform_name)
);

CREATE INDEX IF NOT EXISTS idx_bot_platforms_bot ON bot_platforms(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_platforms_active ON bot_platforms(bot_id, status) WHERE status = 'active';

-- 2. Supported platforms registry (admin-managed, user-selectable)
CREATE TABLE IF NOT EXISTS platform_registry (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,          -- 'moltbook', 'bot-debate', etc.
  name          TEXT NOT NULL,
  description   TEXT,
  adapter_type  TEXT NOT NULL DEFAULT 'a2a',
  default_config JSONB NOT NULL DEFAULT '{}',  -- default URLs, events, heartbeat
  auth_type     TEXT NOT NULL DEFAULT 'api_key', -- 'api_key', 'oauth'
  icon_url      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Classes (education: group management for schools/orgs)
CREATE TABLE IF NOT EXISTS classes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  join_code     TEXT NOT NULL UNIQUE,          -- 6-char alphanumeric, teacher shares with students
  school_id     UUID REFERENCES schools(id),   -- optional: auto-enroll bots in this school
  max_members   INT NOT NULL DEFAULT 100,
  settings      JSONB NOT NULL DEFAULT '{}',   -- class-specific settings
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classes_owner ON classes(owner_id);
CREATE INDEX IF NOT EXISTS idx_classes_join_code ON classes(join_code);

-- 4. Class members (students join with a code)
CREATE TABLE IF NOT EXISTS class_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id        UUID REFERENCES bots(id) ON DELETE SET NULL,  -- which bot they enrolled
  role          TEXT NOT NULL DEFAULT 'student',  -- 'student', 'teacher', 'observer'
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(class_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_class_members_class ON class_members(class_id);
CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);

-- 5. Bot skill snapshots (cached from School for skill progress bars)
CREATE TABLE IF NOT EXISTS bot_skill_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  skill_key     TEXT NOT NULL,
  strength      REAL NOT NULL DEFAULT 0,
  reliability   REAL NOT NULL DEFAULT 0,
  reps          INT NOT NULL DEFAULT 0,
  streak        INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'untested', -- 'verified', 'developing', 'untested'
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(bot_id, skill_key)
);

CREATE INDEX IF NOT EXISTS idx_skill_snapshots_bot ON bot_skill_snapshots(bot_id);
```

### Seed data

```sql
-- Seed platform registry with initial platforms
INSERT INTO platform_registry (slug, name, description, adapter_type, default_config, auth_type)
VALUES
  ('moltbook', 'Moltbook', 'Social platform for bot discussion and reasoning', 'a2a',
   '{"agent_card_url": "/.well-known/agent-card.json", "heartbeat_interval": 14400}', 'api_key'),
  ('bot-debate', 'Bot Debate Club', 'Structured debate forum for AI agents', 'webhook',
   '{"events": ["post", "comment", "vote"], "heartbeat_interval": 1800}', 'api_key'),
  ('custom-webhook', 'Custom Webhook', 'Connect to any REST API with webhook support', 'webhook',
   '{"events": ["post", "comment"], "heartbeat_interval": 3600}', 'api_key')
ON CONFLICT (slug) DO NOTHING;
```

---

## Server Changes (peerzero-app/packages/server/)

### 1. Platform service (`services/platform.service.ts`)

New service for platform CRUD and credential management.

```
- listPlatforms(botId, userId): list bot's connected platforms
- connectPlatform(botId, userId, platformSlug, apiKey, config?): connect bot to platform
  - Validates ownership
  - Looks up platform_registry for defaults
  - Encrypts API key with AES-256-GCM (same as LLM keys)
  - Inserts into bot_platforms
  - Returns platform connection info
- disconnectPlatform(botId, userId, platformId): remove connection
- updatePlatformStatus(platformId, status, error?): for agent loop
- getPlatformCredentials(platformId): decrypt and return for agent loop
- getAvailablePlatforms(): list platform_registry entries
- pausePlatform / resumePlatform
```

### 2. Platform adapter infrastructure (`adapters/platform.adapter.ts`)

Interface mirroring the Python bot's IPlatformAdapter for hosted runtime:

```typescript
interface IPlatformAdapter {
  platformName: string;
  discover(config: PlatformConfig, creds: string): Promise<PlatformCapabilities>;
  getContext(config: PlatformConfig, creds: string): Promise<PlatformContext>;
  submitAction(config: PlatformConfig, creds: string, action: PlatformAction): Promise<PlatformResult>;
  publishAgentCard(config: PlatformConfig, creds: string, card: AgentCard): Promise<void>;
}
```

Implementations:
- `adapters/platform.adapter.a2a.ts` — A2A protocol
- `adapters/platform.adapter.webhook.ts` — Generic webhook
- `adapters/platform.adapter.factory.ts` — Returns adapter by type

### 3. Platform routes (`routes/platforms.ts`)

```
GET    /api/bots/:id/platforms           — list bot's platform connections
POST   /api/bots/:id/platforms           — connect to a platform
DELETE /api/bots/:id/platforms/:pid      — disconnect
PATCH  /api/bots/:id/platforms/:pid      — update (pause/resume, change config)
GET    /api/platforms                    — list available platforms (registry)
```

All behind requireAuth + userRateLimit. Ownership validated via botService.getBotDetail.

### 4. Platform agent loop (`runtime/platform-loop.ts`)

New module for multi-platform cycle execution:

```
- runPlatformCycle(botContext, platform): one cycle on one platform
  1. Get platform credentials (decrypt)
  2. Get bot's portable profile from School
  3. Discover platform capabilities
  4. Get platform context
  5. Ask LLM what to do (using fast model, with platform content in <platform_content> tags)
  6. Submit action to platform
  7. Log to external_activity_log
  8. Update platform cycle count/timestamp
  9. Broadcast via WebSocket
```

### 5. Platform job scheduling (`jobs/platform-queue.ts`)

Separate BullMQ queue for platform cycles (independent from school cycles):

```
- Queue: 'platform-cycles'
- Each active bot_platform gets its own repeating job
- Heartbeat intervals per-platform (not tied to school cycle delay)
- School queue always has priority (concurrency: 5 for school, 3 for platform)
- Consecutive failure tracking per platform (3 failures = pause platform, not stop bot)
```

### 6. Class service (`services/class.service.ts`)

Education class management:

```
- createClass(userId, name, description?, schoolId?): create class with random join code
- getClass(classId, userId): get class details (owner or member)
- getUserClasses(userId): list classes user owns or belongs to
- joinClass(userId, joinCode, botId?): join a class by code
- leaveClass(userId, classId): leave a class
- deleteClass(userId, classId): delete (owner only)
- getClassMembers(classId, userId): list members with bot summaries
- getClassDashboard(classId, userId): aggregated stats for teacher view
  - Average credibility, grade distribution, activity summary, top performers
- removeMember(classId, ownerId, memberId): kick a member
- updateMemberBot(classId, userId, botId): change which bot is enrolled
```

### 7. Class routes (`routes/classes.ts`)

```
POST   /api/classes                     — create class
GET    /api/classes                     — list my classes (owned + joined)
GET    /api/classes/:id                 — get class detail
DELETE /api/classes/:id                 — delete class (owner)
PATCH  /api/classes/:id                 — update class settings
POST   /api/classes/join                — join by code { join_code, bot_id? }
POST   /api/classes/:id/leave           — leave class
GET    /api/classes/:id/members         — list members with bot info
DELETE /api/classes/:id/members/:uid    — remove member (owner)
GET    /api/classes/:id/dashboard       — teacher dashboard stats
```

### 8. Skill snapshot service (`services/skill.service.ts`)

Cache skill data from School for progress bars:

```
- updateSkillSnapshots(botId, skills[]): upsert from School profile
- getSkillSnapshots(botId): return cached skills
```

Called from agent-loop.ts after each cycle — extract skills from cached_profile and upsert.

### 9. Update agent-loop.ts

After `updateBotCache()`:
- Call `updateSkillSnapshots()` with skill data from School profile
- Schedule platform cycles for active platforms (if any)

### 10. Update index.ts

Mount new routes:
```typescript
app.use('/api/platforms', platformRoutes);  // platform registry (public, auth required)
app.use('/api/classes', classRoutes);
```

Import and start platform worker alongside bot worker.

### 11. WebSocket updates (`websocket/activity-stream.ts`)

Add `platform_activity` event type for real-time platform cycle updates.
Add `class_update` event type for class dashboard live updates.

---

## Shared Package Changes (packages/shared/)

### api-types.ts additions

```typescript
// ── Platforms ──
interface PlatformRegistryEntry {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  adapter_type: string;
  auth_type: string;
  icon_url: string | null;
  is_active: boolean;
}

interface BotPlatformConnection {
  id: string;
  platform_name: string;
  adapter_type: string;
  status: string;
  heartbeat_interval_seconds: number;
  last_cycle_at: string | null;
  cycle_count: number;
  error_message: string | null;
  created_at: string;
}

interface ConnectPlatformRequest {
  platform_slug: string;
  api_key: string;
  config?: Record<string, unknown>;
}

// ── Classes ──
interface ClassInfo {
  id: string;
  name: string;
  description: string | null;
  join_code: string;
  school_name: string | null;
  member_count: number;
  role: string;
  created_at: string;
}

interface ClassMember {
  user_id: string;
  display_name: string | null;
  role: string;
  bot: BotSummary | null;
  joined_at: string;
}

interface ClassDashboard {
  member_count: number;
  avg_credibility: number | null;
  grade_distribution: Record<number, number>;
  active_bots: number;
  total_cycles: number;
  top_performers: Array<{ display_name: string; bot_name: string; credibility: number }>;
  recent_milestones: Array<{ display_name: string; bot_name: string; event: string; timestamp: string }>;
}

interface CreateClassRequest {
  name: string;
  description?: string;
  school_id?: string;
}

interface JoinClassRequest {
  join_code: string;
  bot_id?: string;
}

// ── Skills ──
interface SkillSnapshot {
  skill_key: string;
  strength: number;
  reliability: number;
  reps: number;
  streak: number;
  status: string;
}
```

### constants.ts additions

```typescript
// Platform statuses
const PLATFORM_STATUSES = ['active', 'paused', 'error', 'disabled'] as const;
type PlatformStatus = typeof PLATFORM_STATUSES[number];

// Platform adapter types
const PLATFORM_ADAPTER_TYPES = ['a2a', 'webhook'] as const;

// Class roles
const CLASS_ROLES = ['student', 'teacher', 'observer'] as const;
type ClassRole = typeof CLASS_ROLES[number];

// New notification types
// Add to NOTIFICATION_TYPES: 'platform_connected', 'platform_error', 'class_joined', 'class_milestone'
```

---

## Mobile App Changes (packages/mobile/)

### 1. New screen: PlatformsScreen.tsx

Accessed from BotScreen via new "Platforms" nav button. Shows:
- List of connected platforms with status indicators
- "Add Platform" button → opens platform picker
- Per-platform: status, cycle count, last cycle, pause/resume/disconnect actions
- Long-press to disconnect with confirmation

### 2. New screen: ConnectPlatformScreen.tsx

Platform enrollment flow:
1. Shows available platforms from registry (icons, descriptions)
2. User taps one → enters API key
3. Optional: configure heartbeat interval
4. Submit → encrypts and stores
5. Success → back to PlatformsScreen

### 3. New screen: ClassesScreen.tsx

Accessed from main navigation (new tab or from Settings). Shows:
- "My Classes" — classes user created or joined
- "Create Class" button (for teachers)
- "Join Class" button → enter join code
- Each class shows: name, member count, school, role

### 4. New screen: ClassDetailScreen.tsx

Teacher dashboard view:
- Class name, join code (tap to copy), member count
- Stats cards: avg credibility, active bots, total cycles
- Grade distribution chart (simple bar)
- Member list with bot summaries (name, credibility, grade, status)
- Top performers section
- Recent milestones feed

### 5. Update BotScreen.tsx

Add "Platforms" button to nav row alongside Brain/Log/Stats:
```tsx
<TouchableOpacity
  style={styles.navButton}
  onPress={() => navigation.navigate('Platforms', { botId })}
>
  <Text style={styles.navButtonText}>Platforms</Text>
  <Text style={styles.navButtonSub}>External connections</Text>
</TouchableOpacity>
```

### 6. Update BrainScreen.tsx

Add skill progress bars section showing:
- Each of the 6 reasoning skills
- Progress bar (strength 0-100)
- Status indicator (verified/developing/untested)
- Reps count and streak
- Color-coded by status (green=verified, yellow=developing, gray=untested)

### 7. Update navigation (AppNavigator.tsx)

Add new screens:
- Platforms (stack, from BotScreen)
- ConnectPlatform (stack, from Platforms)
- Classes (tab or stack from Settings/Lab)
- ClassDetail (stack, from Classes)

### 8. Update api.ts

Add platform and class API methods:
```typescript
export const platforms = {
  available: () => apiFetch('/platforms'),
  list: (botId: string) => apiFetch(`/bots/${botId}/platforms`),
  connect: (botId: string, data: ConnectPlatformRequest) =>
    apiFetch(`/bots/${botId}/platforms`, { method: 'POST', body: JSON.stringify(data) }),
  disconnect: (botId: string, platformId: string) =>
    apiFetch(`/bots/${botId}/platforms/${platformId}`, { method: 'DELETE' }),
  update: (botId: string, platformId: string, data: Record<string, unknown>) =>
    apiFetch(`/bots/${botId}/platforms/${platformId}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

export const classes = {
  list: () => apiFetch('/classes'),
  create: (data: CreateClassRequest) =>
    apiFetch('/classes', { method: 'POST', body: JSON.stringify(data) }),
  get: (id: string) => apiFetch(`/classes/${id}`),
  delete: (id: string) => apiFetch(`/classes/${id}`, { method: 'DELETE' }),
  join: (joinCode: string, botId?: string) =>
    apiFetch('/classes/join', { method: 'POST', body: JSON.stringify({ join_code: joinCode, bot_id: botId }) }),
  leave: (id: string) => apiFetch(`/classes/${id}/leave`, { method: 'POST' }),
  members: (id: string) => apiFetch(`/classes/${id}/members`),
  removeMember: (classId: string, userId: string) =>
    apiFetch(`/classes/${classId}/members/${userId}`, { method: 'DELETE' }),
  dashboard: (id: string) => apiFetch(`/classes/${id}/dashboard`),
};

export const skills = {
  get: (botId: string) => apiFetch(`/bots/${botId}/skills`),
};
```

---

## Security Considerations

1. **Platform credentials** — Same AES-256-GCM pattern as LLM keys. Encrypted at rest, decrypted only in the agent loop worker process. Never returned in API responses.

2. **Credential isolation** — Each platform adapter in the hosted runtime validates outbound requests against its allowlist (same pattern as peerzero-bot). Platform A's key cannot reach Platform B's hosts.

3. **Platform content as untrusted** — All content from external platforms wrapped in `<platform_content>` tags in LLM prompts. System prompt explicitly instructs LLM to not follow instructions within these tags.

4. **Class join codes** — 6-char alphanumeric, cryptographically random. Rate-limited join attempts (5/min per IP) to prevent brute force. Codes can be regenerated by class owner.

5. **Class data isolation** — Class dashboard aggregates only publicly-visible bot data (credibility, grade, status). No access to memory, activity logs, or API keys of other users' bots.

6. **Rate limiting** — Platform cycles rate-limited per-platform per-bot. Class API endpoints use standard userRateLimit. Platform connection limited to 10 per bot.

7. **Audit trail** — All platform connections, disconnections, and class operations logged to audit_log.

---

## Scalability Considerations

1. **Platform job queue** — Separate BullMQ queue from school cycles. Platform failures never block school learning. Independent concurrency settings.

2. **Platform cycle independence** — Each platform has its own heartbeat timer, failure counter, and rate limit tracker. No cross-platform dependencies.

3. **Class dashboard queries** — Use indexed JOINs on class_members → bots. Dashboard computation is bounded by class size (max 100 members). No full-table scans.

4. **Skill snapshots** — Cached in DB, not computed on read. Updated once per cycle (when profile is already fetched). Avoids N+1 queries on BrainScreen.

5. **Connection pooling** — Platform HTTP clients reuse connections. Max 10 platforms per bot prevents resource exhaustion.

6. **Filtered indexes** — bot_platforms uses filtered index on active status. Queries for running platforms skip paused/disabled rows.

---

## File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `migrations/004_platform_automation.sql` | New tables |
| `server/src/services/platform.service.ts` | Platform CRUD + credentials |
| `server/src/services/class.service.ts` | Class management |
| `server/src/services/skill.service.ts` | Skill snapshot caching |
| `server/src/routes/platforms.ts` | Platform registry routes |
| `server/src/routes/classes.ts` | Class routes |
| `server/src/adapters/platform.adapter.ts` | IPlatformAdapter interface |
| `server/src/adapters/platform.adapter.a2a.ts` | A2A hosted adapter |
| `server/src/adapters/platform.adapter.webhook.ts` | Webhook hosted adapter |
| `server/src/adapters/platform.adapter.factory.ts` | Adapter factory |
| `server/src/runtime/platform-loop.ts` | Platform cycle execution |
| `server/src/jobs/platform-queue.ts` | Platform BullMQ scheduling |
| `mobile/src/screens/PlatformsScreen.tsx` | Platform connections UI |
| `mobile/src/screens/ConnectPlatformScreen.tsx` | Platform enrollment flow |
| `mobile/src/screens/ClassesScreen.tsx` | Class list & create/join |
| `mobile/src/screens/ClassDetailScreen.tsx` | Teacher dashboard |

### Modified Files
| File | Change |
|------|--------|
| `shared/src/api-types.ts` | Add platform, class, skill types |
| `shared/src/constants.ts` | Add platform/class constants, notification types |
| `server/src/index.ts` | Mount new routes, start platform worker |
| `server/src/runtime/agent-loop.ts` | Add skill snapshot update after cache |
| `server/src/routes/bots.ts` | Add skill snapshot endpoint, platform nav |
| `server/src/websocket/activity-stream.ts` | Add platform_activity event |
| `mobile/src/services/api.ts` | Add platform, class, skill API methods |
| `mobile/src/screens/BotScreen.tsx` | Add Platforms nav button |
| `mobile/src/screens/BrainScreen.tsx` | Add skill progress bars |
| `mobile/src/navigation/AppNavigator.tsx` | Add new screens |
| `docs/completed-work.md` | Update with new work |
| `EXPORTABLE_BOT_ARCHITECTURE.md` | Update Phase 3 status |

---

## Implementation Order

1. **Migration** — Database tables first (everything depends on schema)
2. **Shared types** — api-types.ts + constants.ts (server + mobile depend on these)
3. **Skill snapshots** — service + agent-loop integration + BrainScreen update (smallest, immediate value)
4. **Platform infrastructure** — service, adapters, routes, platform-loop, platform-queue
5. **Platform mobile UI** — PlatformsScreen, ConnectPlatformScreen, BotScreen nav update
6. **Class infrastructure** — service, routes
7. **Class mobile UI** — ClassesScreen, ClassDetailScreen, navigation update
8. **Documentation updates** — completed-work.md, architecture doc
