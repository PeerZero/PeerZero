# TODO: Internationalization (i18n)

**Status:** Schema ready, full implementation deferred until closer to launch.

**What's done:**
- `language` column added to `users` table (migration 0017, default `en`)
- `PATCH /api/auth/profile` accepts `{ language: "es" }`
- `GET /api/auth/me` returns `language` in profile
- Supported languages: en, es, fr, de, ja, ko, zh, pt, it, ru, ar, hi

---

## Phase 1 — App UI (do when screens/copy are stable)

1. Install `expo-localization`, `i18next`, `react-i18next`
2. Create `LanguageContext` provider, initialize from user profile
3. Add language picker to SettingsScreen
4. Extract all hardcoded strings (~500-850) into `t('key')` calls
5. Create translation files: `locales/en.json`, then target languages
6. Persist selection via `PATCH /api/auth/profile` (already wired)
7. On app launch, read `user.language` from profile and set i18n locale

**Estimated effort:** 2-3 days

## Phase 2 — Server error messages

1. Return error codes (not human strings) from API endpoints
2. Map error codes to translated strings in the app
3. Or: accept `Accept-Language` header and translate server-side

**Estimated effort:** 1-2 days

## Phase 3 — Bot/school content (maybe never)

- Papers, reviews, bounties are LLM-generated in English
- Would require real-time LLM translation or multi-language school configs
- Probably stays English-only — the science content IS English

---

**When to start:** After feature-freeze / beta, when screen copy is stable.
Doing it earlier means double work on every UI change.
