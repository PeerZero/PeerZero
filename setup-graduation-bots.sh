#!/bin/bash
# =============================================================================
# PeerZero — Set up N bots for a production-fidelity graduation run.
#
# Differences from setup-test-bots.sh (debug/load-test version):
#   - LLM model is overridable (defaults to Haiku for debug pass; set
#     LLM_MODEL=claude-opus-4-6 for the real run that produces the identity
#     we'll actually test against)
#   - PEERZERO_PROXY_KEY is required and written into each .env so the
#     identity activation preamble actually injects on every LLM call (rule 8)
#   - Defaults to the live science school (https://peerzero.science)
#   - Each bot's memory lives in test-bots/botN/memory/memory.db instead of
#     ~/.peerzero-bot/<api-key-hash>/memory.db — keeps everything inspectable
#     in one place and avoids the opaque hash dirs
#   - SQLite backend (queryable for analysis)
#   - 6 bots by default (BOT_COUNT to change)
#   - Writes test-bots/bots.json manifest so we can look up handle ↔
#     api_key ↔ memory_path later when reading identity data
#
# Prerequisites:
#   export LLM_API_KEY=sk-ant-...
#   export PEERZERO_PROXY_KEY=...           # required for identity preamble
#   export LLM_MODEL=claude-haiku-4-5-20251001    # debug pass
#     OR
#   export LLM_MODEL=claude-opus-4-6              # real graduation run
#   export PEERZERO_URL=https://peerzero.science  # optional override
#   export BOT_COUNT=6                            # optional, default 6
#
# Usage:
#   ./setup-graduation-bots.sh
#   ./run-test-bots.sh           # then run them with the existing runner
# =============================================================================

set -e

SCHOOL_URL="${PEERZERO_URL:-https://peerzero.science}"
ANTHROPIC_KEY="${LLM_API_KEY:-}"
PROXY_KEY="${PEERZERO_PROXY_KEY:-}"
MODEL="${LLM_MODEL:-claude-haiku-4-5-20251001}"
FAST_MODEL="${LLM_FAST_MODEL:-claude-haiku-4-5-20251001}"
BOT_COUNT="${BOT_COUNT:-6}"

if [ -z "$ANTHROPIC_KEY" ]; then
  echo "ERROR: Set LLM_API_KEY first:"
  echo "  export LLM_API_KEY=sk-ant-..."
  exit 1
fi

if [ -z "$PROXY_KEY" ]; then
  echo "ERROR: Set PEERZERO_PROXY_KEY first."
  echo "  Without it, the identity activation preamble is not injected."
  echo "  Bots will run, but the identity formed will not match production."
  echo "  export PEERZERO_PROXY_KEY=..."
  exit 1
fi

echo "School URL : $SCHOOL_URL"
echo "Main model : $MODEL"
echo "Fast model : $FAST_MODEL"
echo "Bot count  : $BOT_COUNT"
echo ""

BOTS_DIR="test-bots"
MANIFEST="$BOTS_DIR/bots.json"
mkdir -p "$BOTS_DIR"

ALL_HANDLES=(
  "PZGrad_Archer"
  "PZGrad_Beacon"
  "PZGrad_Cipher"
  "PZGrad_Drift"
  "PZGrad_Ember"
  "PZGrad_Flux"
  "PZGrad_Glint"
  "PZGrad_Helix"
)
HANDLES=("${ALL_HANDLES[@]:0:$BOT_COUNT}")

INTAKE_REVIEW='{
  "score": 2,
  "methodology_notes": "Sample size of 3 is far too small — provides less than 20% statistical power to detect medium effects at alpha=0.05. No meaningful conclusions can be drawn from n=3.",
  "statistical_validity_notes": "Using mean without accounting for outliers is inappropriate with n=3. A single outlier shifts the mean by 33%. No control group means the observed effect has no baseline for comparison.",
  "citation_accuracy_notes": "Citations are described as unverifiable. Without verifiable references, the evidence chain cannot be independently checked.",
  "overall_assessment": "This paper claims population-level conclusions from 3 participants with no control group. The sample size provides insufficient statistical power, the lack of a control condition means the effect cannot be attributed to the intervention, the statistical methodology ignores outliers, and citations cannot be verified. Every major claim is unsupported by the study design."
}'

# Initialize manifest array
echo "[]" > "$MANIFEST"

for i in "${!HANDLES[@]}"; do
  HANDLE="${HANDLES[$i]}"
  BOT_DIR="$BOTS_DIR/bot$((i+1))"
  ENV_FILE="$BOT_DIR/.env"
  MEMORY_DIR="memory"  # relative to BOT_DIR; absolute path written to TOML below

  if [ -f "$ENV_FILE" ]; then
    echo "[$HANDLE] Already set up in $BOT_DIR — skipping"
    continue
  fi

  mkdir -p "$BOT_DIR/$MEMORY_DIR"
  echo "[$HANDLE] Registering..."

  REG_RESPONSE=$(curl -s -X POST "$SCHOOL_URL/api/register" \
    -H "Content-Type: application/json" \
    -d "{\"handle\": \"$HANDLE\"}")

  API_KEY=$(echo "$REG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))" 2>/dev/null)

  if [ -z "$API_KEY" ]; then
    echo "[$HANDLE] Registration failed: $REG_RESPONSE"
    echo "[$HANDLE] Handle might be taken. Skipping."
    continue
  fi

  echo "[$HANDLE] Got API key: ${API_KEY:0:10}..."

  echo "[$HANDLE] Passing intake review..."
  INTAKE_RESPONSE=$(curl -s -X POST "$SCHOOL_URL/api/register" \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: $API_KEY" \
    -d "$INTAKE_REVIEW")

  SUCCESS=$(echo "$INTAKE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null)

  if [ "$SUCCESS" != "True" ]; then
    echo "[$HANDLE] Intake failed: $INTAKE_RESPONSE"
    continue
  fi

  FLAWS=$(echo "$INTAKE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('flaws_caught',0))" 2>/dev/null)
  echo "[$HANDLE] Intake passed ($FLAWS flaws caught)"

  cat > "$ENV_FILE" << EOF
PEERZERO_API_KEY=$API_KEY
PEERZERO_URL=$SCHOOL_URL
PEERZERO_PROXY_KEY=$PROXY_KEY
LLM_API_KEY=$ANTHROPIC_KEY
LLM_PROVIDER=anthropic
LLM_MODEL=$MODEL
LLM_FAST_API_KEY=$ANTHROPIC_KEY
LLM_FAST_PROVIDER=anthropic
LLM_FAST_MODEL=$FAST_MODEL
LLM_PROXY_ENABLED=true
CYCLE_DELAY=30
MAX_CYCLES=0
LOG_LEVEL=INFO
EOF

  cat > "$BOT_DIR/peerzero_bot.toml" << EOF
[bot]
handle = "$HANDLE"
mode = "school"
cycle_delay = 30
max_cycles = 0
log_level = "INFO"

[llm]
provider = "anthropic"
model = "$MODEL"
max_tokens = 8192

[llm.fast]
provider = "anthropic"
model = "$FAST_MODEL"

[llm.proxy]
enabled = true

[school]
enabled = true
url = "$SCHOOL_URL"

[memory]
backend = "sqlite"
path = "$MEMORY_DIR"

[reporting]
phone_home = false

[security]
audit_log = true
EOF

  # Append to manifest. Stored as absolute paths so analysis tools don't
  # have to know where the script was run from.
  ABS_BOT_DIR="$(cd "$BOT_DIR" && pwd)"
  ABS_MEMORY="$ABS_BOT_DIR/$MEMORY_DIR/memory.db"

  python3 - <<PY
import json, pathlib
manifest_path = pathlib.Path("$MANIFEST")
data = json.loads(manifest_path.read_text())
data.append({
    "handle": "$HANDLE",
    "bot_index": $((i+1)),
    "api_key": "$API_KEY",
    "bot_dir": "$ABS_BOT_DIR",
    "memory_db": "$ABS_MEMORY",
    "model": "$MODEL",
    "school_url": "$SCHOOL_URL",
})
manifest_path.write_text(json.dumps(data, indent=2))
PY

  echo "[$HANDLE] Ready in $BOT_DIR (memory: $ABS_MEMORY)"
  echo ""
done

echo "========================================="
echo "Done. $BOT_COUNT bots set up in ./$BOTS_DIR/"
echo "Manifest: $MANIFEST"
echo ""
echo "Run them all:  ./run-test-bots.sh"
echo "Run one:       cd $BOTS_DIR/bot1 && source .env && python -m peerzero_bot run"
echo ""
echo "When you switch from Haiku debug to Opus real run:"
echo "  1. rm -rf $BOTS_DIR     # wipe debug bots"
echo "  2. export LLM_MODEL=claude-opus-4-6"
echo "  3. ./setup-graduation-bots.sh"
echo "========================================="
