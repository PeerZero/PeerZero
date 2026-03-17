#!/usr/bin/env bash
# =============================================================================
# Load Test Runner — spins up infrastructure and runs the full load test suite.
#
# Usage:
#   ./run-load-tests.sh              # run all load tests
#   ./run-load-tests.sh --with-mock  # also start mock LLM server
#   ./run-load-tests.sh --keep       # don't tear down containers after
#
# Prerequisites:
#   - docker & docker compose
#   - pnpm (node dependencies installed)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Flags ────────────────────────────────────────────────────────────────────

WITH_MOCK=false
KEEP_INFRA=false

for arg in "$@"; do
  case "$arg" in
    --with-mock) WITH_MOCK=true ;;
    --keep)      KEEP_INFRA=true ;;
    --help|-h)
      echo "Usage: $0 [--with-mock] [--keep]"
      echo ""
      echo "  --with-mock  Start a mock LLM server on :9100 for integration tests"
      echo "  --keep       Don't tear down Docker containers after tests"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Cleanup trap ─────────────────────────────────────────────────────────────

MOCK_PID=""

cleanup() {
  echo ""
  echo "Cleaning up..."

  # Stop mock LLM server
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "  Stopping mock LLM server (PID $MOCK_PID)"
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi

  # Tear down Docker unless --keep
  if [ "$KEEP_INFRA" = false ]; then
    echo "  Stopping Docker containers..."
    docker compose down -v --remove-orphans 2>/dev/null || true
  else
    echo "  Keeping Docker containers running (--keep)"
  fi
}

trap cleanup EXIT

# ── Step 1: Start infrastructure ─────────────────────────────────────────────

echo "============================================"
echo "  PeerZero Load Test Runner"
echo "============================================"
echo ""

echo "[1/4] Starting Docker containers (postgres + redis)..."
docker compose up -d --wait

# Wait for postgres to accept connections
echo "  Waiting for postgres..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U peerzero -d peerzero_app >/dev/null 2>&1; then
    echo "  Postgres ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ERROR: Postgres did not become ready in 30s"
    exit 1
  fi
  sleep 1
done

# Wait for redis
echo "  Waiting for redis..."
for i in $(seq 1 15); do
  if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "  Redis ready."
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "  ERROR: Redis did not become ready in 15s"
    exit 1
  fi
  sleep 1
done

# ── Step 2: Run database migrations ─────────────────────────────────────────

echo ""
echo "[2/4] Running database migrations..."
export DATABASE_URL="postgresql://peerzero:password@localhost:5432/peerzero_app"

cd packages/server
npx node-pg-migrate \
  --database-url-var DATABASE_URL \
  --migrations-dir src/db/migrations \
  --migration-file-language sql \
  up 2>&1 | tail -5
cd "$SCRIPT_DIR"

echo "  Migrations applied."

# ── Step 3: Start mock LLM server (optional) ────────────────────────────────

if [ "$WITH_MOCK" = true ]; then
  echo ""
  echo "[3/4] Starting mock LLM server on :9100..."
  npx tsx packages/server/src/__tests__/load/mock-llm-server.ts &
  MOCK_PID=$!

  # Wait for it to be ready
  for i in $(seq 1 10); do
    if curl -sf http://localhost:9100/health >/dev/null 2>&1; then
      echo "  Mock LLM server ready (PID $MOCK_PID)."
      break
    fi
    if [ "$i" -eq 10 ]; then
      echo "  WARNING: Mock LLM server may not be ready"
    fi
    sleep 0.5
  done

  export MOCK_LLM_URL="http://localhost:9100"
else
  echo ""
  echo "[3/4] Skipping mock LLM server (use --with-mock to enable)"
fi

# ── Step 4: Run load tests ───────────────────────────────────────────────────

echo ""
echo "[4/4] Running load test suite..."
echo ""

# Set env vars that load tests might need
export REDIS_URL="redis://localhost:6379"
export JWT_SECRET="test-jwt-secret-for-load-tests"
export JWT_REFRESH_SECRET="test-jwt-refresh-secret-for-load-tests"
export ENCRYPTION_MASTER_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export STRIPE_SECRET_KEY="sk_test_fake"
export STRIPE_WEBHOOK_SECRET="whsec_test_fake"

cd packages/server

# Run just the load tests (match files in __tests__/load/)
npx vitest run src/__tests__/load/ --reporter=verbose 2>&1
RESULT=$?

cd "$SCRIPT_DIR"

echo ""
echo "============================================"
if [ $RESULT -eq 0 ]; then
  echo "  All load tests passed."
else
  echo "  Some load tests failed (exit code: $RESULT)"
fi
echo "============================================"

# Print mock LLM metrics if it was running
if [ "$WITH_MOCK" = true ] && [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
  echo ""
  echo "Mock LLM Server Metrics:"
  curl -sf http://localhost:9100/metrics 2>/dev/null | python3 -m json.tool 2>/dev/null || \
    curl -sf http://localhost:9100/metrics 2>/dev/null || \
    echo "  (could not fetch metrics)"
fi

exit $RESULT
