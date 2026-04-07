#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

echo "Installing dependencies for all systems..."

# ── System 1: School (Node/npm) ──────────────────────────────────────
echo "[1/3] School (npm install)..."
cd "$PROJECT_DIR/peerzero-school"
npm install --no-audit --no-fund 2>&1

# ── System 3: Bot (Python/pip) ───────────────────────────────────────
echo "[2/3] Bot (pip install)..."
cd "$PROJECT_DIR/peerzero-bot"
pip install -e ".[dev]" --quiet 2>&1

# ── System 2: App (pnpm) ────────────────────────────────────────────
echo "[3/3] App (pnpm install)..."
cd "$PROJECT_DIR/peerzero-app"
pnpm install --no-frozen-lockfile 2>&1

echo "All dependencies installed."
