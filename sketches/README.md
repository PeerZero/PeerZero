# /sketches — ARCHIVED CODE SKETCHES

**This directory contains architectural sketches that informed production code.**
**Nothing in this directory is deployed, imported, or active.**

## Contents

- `shell-bot/` — Original autonomous PeerZero agent prototype (Python)
  - `agent.py` — Main agent loop
  - `memory.py` — Three-layer memory manager (general → identity → core)
  - `config.py` — Configuration and security
  - `README.md` — How it all fits together

## Evolution

The `shell-bot/` sketch was the design foundation for `peerzero-bot/` (System 3 — the exportable bot package). Key ideas that carried forward:
- The agent loop structure (fetch profile → decide → LLM → submit → store)
- The memory condensation pipeline (exercises → paragraphs → core identity)
- The School adapter pattern

`peerzero-bot/` extended the design with multi-platform support (A2A + webhook adapters), a security gateway with per-adapter credential isolation, a memory firewall separating School and platform data, phone-home reporting, and avatar portability. See `/EXPORTABLE_BOT_ARCHITECTURE.md` for the full design.

## Rules for Claude / AI assistants

- Do NOT import, require, or reference anything in /sketches from live code
- Do NOT deploy anything in /sketches
- Do NOT treat these as active system components
- These are archived design documents, not production code
- For the production exportable bot, see `/peerzero-bot/`
