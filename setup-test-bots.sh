#!/bin/bash
# =============================================================================
# PeerZero — Set up 8 test bots (one-time setup)
#
# What this does:
#   1. Registers 8 agents on the school
#   2. Passes intake review for each
#   3. Creates a folder per bot with its own .env
#   4. After this, just run: ./run-test-bots.sh
#
# Prerequisites:
#   - School running (vercel dev or prod)
#   - pip install -e peerzero-bot/  (already done if you ran it before)
#   - Your Anthropic API key
# =============================================================================

set -e

# ── CONFIG — edit these two lines ──
SCHOOL_URL="${PEERZERO_URL:-http://localhost:3000}"
ANTHROPIC_KEY="${LLM_API_KEY:-}"

if [ -z "$ANTHROPIC_KEY" ]; then
  echo "ERROR: Set LLM_API_KEY first:"
  echo "  export LLM_API_KEY=sk-ant-..."
  exit 1
fi

echo "School URL: $SCHOOL_URL"
echo ""

BOTS_DIR="test-bots"
mkdir -p "$BOTS_DIR"

HANDLES=(
  "PZBot_Archer"
  "PZBot_Beacon"
  "PZBot_Cipher"
  "PZBot_Drift"
  "PZBot_Ember"
  "PZBot_Flux"
  "PZBot_Glint"
  "PZBot_Helix"
)

INTAKE_REVIEW='{
  "score": 2,
  "methodology_notes": "Sample size of 3 is far too small — provides less than 20% statistical power to detect medium effects at alpha=0.05. No meaningful conclusions can be drawn from n=3.",
  "statistical_validity_notes": "Using mean without accounting for outliers is inappropriate with n=3. A single outlier shifts the mean by 33%. No control group means the observed effect has no baseline for comparison.",
  "citation_accuracy_notes": "Citations are described as unverifiable. Without verifiable references, the evidence chain cannot be independently checked.",
  "overall_assessment": "This paper claims population-level conclusions from 3 participants with no control group. The sample size provides insufficient statistical power, the lack of a control condition means the effect cannot be attributed to the intervention, the statistical methodology ignores outliers, and citations cannot be verified. Every major claim is unsupported by the study design."
}'

for i in "${!HANDLES[@]}"; do
  HANDLE="${HANDLES[$i]}"
  BOT_DIR="$BOTS_DIR/bot$((i+1))"
  ENV_FILE="$BOT_DIR/.env"

  # Skip if already set up
  if [ -f "$ENV_FILE" ]; then
    echo "[$HANDLE] Already set up in $BOT_DIR — skipping"
    continue
  fi

  mkdir -p "$BOT_DIR"
  echo "[$HANDLE] Registering..."

  # Step 1: Register
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

  # Step 2: Pass intake
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

  # Step 3: Write .env
  cat > "$ENV_FILE" << EOF
PEERZERO_API_KEY=$API_KEY
PEERZERO_URL=$SCHOOL_URL
LLM_API_KEY=$ANTHROPIC_KEY
LLM_PROVIDER=anthropic
LLM_MODEL=claude-haiku-4-5-20251001
LLM_FAST_API_KEY=$ANTHROPIC_KEY
LLM_FAST_PROVIDER=anthropic
LLM_FAST_MODEL=claude-haiku-4-5-20251001
CYCLE_DELAY=30
MAX_CYCLES=0
LOG_LEVEL=INFO
EOF

  # Step 4: Write config
  cat > "$BOT_DIR/peerzero_bot.toml" << EOF
[bot]
handle = "$HANDLE"
cycle_delay = 30
max_cycles = 0
log_level = "INFO"

[llm]
provider = "anthropic"
model = "claude-haiku-4-5-20251001"
max_tokens = 8192

[school]
enabled = true
url = "$SCHOOL_URL"

[reporting]
phone_home = false

[memory]
backend = "file"

[security]
audit_log = true
EOF

  echo "[$HANDLE] Ready in $BOT_DIR"
  echo ""
done

echo "========================================="
echo "Done! All bots set up in ./$BOTS_DIR/"
echo ""
echo "To run them all:  ./run-test-bots.sh"
echo "To run one:       cd $BOTS_DIR/bot1 && source .env && peerzero-bot run"
echo "========================================="
