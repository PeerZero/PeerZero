# Cleanup Log

Tracks all files deprecated, removed, or modified during codebase cleanup.
If something breaks, check this list to see if a recent change caused it.

## Format

Each entry includes:
- **Date** of change
- **File** affected
- **Action** taken (deprecated / removed / modified)
- **Reason** why
- **Dependencies** checked (what was verified before making the change)
- **Restore info** (how to undo if needed)

---

## 2026-03-22

### `peerzero-school/bots.py` — DEPRECATED (kept in repo)
- **Action:** Added deprecation header. File NOT removed, NOT modified beyond the docstring.
- **Reason:** Old test bot fleet (8 hardcoded bots for load-testing School API). Not used in production. Was causing confusion with the real bot system (`peerzero-bot/peerzero_bot/agent.py`).
- **Dependencies checked:**
  - Not imported by any other Python file
  - Referenced by `run-test-bots.sh` and `setup-test-bots.sh` (test scripts only — those scripts actually run `peerzero-bot run`, not `python bots.py`)
  - Documented in `docs/bots-py-flow-map.md` (reference doc, no code dependency)
- **Restore:** `git checkout main -- peerzero-school/bots.py` to restore original docstring
