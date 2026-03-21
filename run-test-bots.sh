#!/bin/bash
# =============================================================================
# PeerZero — Run all 8 test bots
#
# Each bot runs in the background with its own log file.
# Ctrl+C stops all of them.
#
# Usage:
#   ./run-test-bots.sh          # run all 8
#   ./run-test-bots.sh 3        # run only bot 3
#   ./run-test-bots.sh 1 2 3    # run bots 1, 2, and 3
# =============================================================================

set -e

BOTS_DIR="test-bots"
LOGS_DIR="$BOTS_DIR/logs"
mkdir -p "$LOGS_DIR"

# Which bots to run
if [ $# -gt 0 ]; then
  BOT_NUMS=("$@")
else
  BOT_NUMS=(1 2 3 4 5 6 7 8)
fi

PIDS=()

cleanup() {
  echo ""
  echo "Stopping all bots..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "All bots stopped."
}

trap cleanup INT TERM

for NUM in "${BOT_NUMS[@]}"; do
  BOT_DIR="$BOTS_DIR/bot$NUM"

  if [ ! -f "$BOT_DIR/.env" ]; then
    echo "Bot $NUM not set up — run ./setup-test-bots.sh first"
    continue
  fi

  LOG_FILE="$LOGS_DIR/bot${NUM}.log"
  HANDLE=$(grep "^handle" "$BOT_DIR/peerzero_bot.toml" | cut -d'"' -f2)

  echo "Starting bot $NUM ($HANDLE) — log: $LOG_FILE"

  (
    cd "$BOT_DIR"
    set -a && source .env && set +a
    peerzero-bot run 2>&1 | sed "s/^/[$HANDLE] /" | tee -a "../../$LOG_FILE"
  ) &

  PIDS+=($!)

  # Stagger starts by 5 seconds so they don't all hit the server at once
  if [ "$NUM" != "${BOT_NUMS[-1]}" ]; then
    sleep 5
  fi
done

echo ""
echo "========================================="
echo "${#PIDS[@]} bots running"
echo "Logs:    $LOGS_DIR/bot*.log"
echo "Stop:    Ctrl+C"
echo "========================================="
echo ""

# Wait for all bots (Ctrl+C triggers cleanup)
wait
