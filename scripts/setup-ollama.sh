#!/usr/bin/env bash
#
# Install local Ollama + pull the recommended NPC Simulator models.
#
# Models:
#   1. qwen3:14b                        — Qwen3 14B (default primary, ~9.3 GB)
#   2. fluffy/l3-8b-stheno-v3.2         — L3 8B Stheno (legacy primary, ~4.9 GB, 8K ctx)
#   3. huihui_ai/llama3.2-abliterate:3b — Llama 3.2 3B abliterated (fast, ~2.2 GB, 128K ctx)
#
# Disk cost: pulling all three is ~16 GB in ~/.ollama/models. Use
#   --only qwen3  (or OLLAMA_MODELS="qwen3:14b") to pull just the default.
#
# What this does:
#   1. Installs the `ollama` binary if missing (https://ollama.com/install.sh).
#   2. Ensures the Ollama server is running (starts `ollama serve` detached if needed).
#   3. Pulls the models above (skips ones already present).
#   4. Builds tuned variants (npc-qwen3-14b, npc-stheno-8b) via Modelfile:
#      full GPU offload (num_gpu 999), right-sized context (num_ctx 4096 —
#      engine prompts measure ~2k real tokens), larger prefill batches,
#      30-minute keep-alive. Zero extra disk: variants share the base
#      weights.
#   5. Runs a smoke chat against the first available model via /api/chat.
#
# Usage:
#   npm run setup:ollama                       # install + pull all recommended models (default)
#   npm run setup:ollama -- --only qwen3       # only Qwen3 14B (default primary)
#   npm run setup:ollama -- --only stheno      # only L3-8B-Stheno
#   npm run setup:ollama -- --only llama3.2    # only Llama 3.2 3B abliterated
#   bash scripts/setup-ollama.sh --help
#
# Env overrides:
#   OLLAMA_HOST=http://127.0.0.1:11434   (default server address)
#   OLLAMA_MODELS="model-a model-b"      (override the model list)
#
# Next steps after this script succeeds:
#   LLM_BACKEND=ollama npm run start:text                      # default model (qwen3:14b)
#   LLM_BACKEND=ollama OLLAMA_MODEL=huihui_ai/llama3.2-abliterate:3b npm run start:text
#   npm run diagnose:ai                                        # verify the whole AI setup
#
set -euo pipefail

QWEN_MODEL="qwen3:14b"
STHENO_MODEL="fluffy/l3-8b-stheno-v3.2"
LLAMA_MODEL="huihui_ai/llama3.2-abliterate:3b"
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      ONLY="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "error: unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

MODELS=()
if [[ -n "${OLLAMA_MODELS:-}" ]]; then
  # shellcheck disable=SC2206
  MODELS=(${OLLAMA_MODELS})
elif [[ "$ONLY" == "qwen3" || "$ONLY" == "qwen" ]]; then
  MODELS=("$QWEN_MODEL")
elif [[ "$ONLY" == "stheno" ]]; then
  MODELS=("$STHENO_MODEL")
elif [[ "$ONLY" == "llama3.2" || "$ONLY" == "llama" || "$ONLY" == "llama3" ]]; then
  MODELS=("$LLAMA_MODEL")
elif [[ -n "$ONLY" ]]; then
  echo "error: --only must be 'qwen3', 'stheno' or 'llama3.2' (got '$ONLY')" >&2
  exit 2
else
  MODELS=("$QWEN_MODEL" "$STHENO_MODEL" "$LLAMA_MODEL")
fi

HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
HOST="${HOST%/}"

# 1. Install ollama if missing -------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama not found — installing via https://ollama.com/install.sh ..."
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required to install ollama." >&2
    exit 1
  fi
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "ollama: $(ollama --version 2>&1 | head -n1) @ $(command -v ollama)"
fi

# 2. Ensure the server is up ----------------------------------------------
server_up() {
  curl -fsS -m 5 -o /dev/null "$HOST/api/tags" 2>/dev/null
}

if server_up; then
  echo "ollama server already running at $HOST"
else
  echo "starting ollama server (ollama serve) in the background ..."
  if pgrep -x ollama >/dev/null 2>&1; then
    echo "note: an ollama process exists but $HOST/api/tags is unreachable;"
    echo "      check OLLAMA_HOST or port 11434 availability."
  else
    nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
    disown || true
  fi
  for _ in $(seq 1 30); do
    sleep 1
    if server_up; then break; fi
  done
  if ! server_up; then
    echo "error: ollama server did not come up at $HOST (see /tmp/ollama-serve.log)." >&2
    exit 1
  fi
  echo "ollama server is up at $HOST"
fi

# 3. Pull models -----------------------------------------------------------
for model in "${MODELS[@]}"; do
  if ollama list 2>/dev/null | grep -qiF "$model"; then
    echo "model already present: $model (skipping pull)"
  else
    echo "pulling model: $model ..."
    ollama pull "$model"
  fi
done

echo ""
echo "installed models:"
ollama list

# 3b. Tuned variants ----------------------------------------------------------
# Exp-6 S1 optimization (RTX 5070 Ti 16 GB, 32 GB RAM): the stock qwen3:14b
# served at ~50% VRAM offload with the rest on CPU. These Modelfile
# variants pin full GPU offload and a right-sized context. Measured engine
# prompts are ~2k real tokens (ollama tokenizer), so num_ctx 4096 leaves
# comfortable headroom; larger would only burn VRAM on KV cache.
# Idempotent: `ollama create` rebuilds the same-named variant in place.
declare -A TUNED_VARIANTS=(
  ["$QWEN_MODEL"]="npc-qwen3-14b"
  ["$STHENO_MODEL"]="npc-stheno-8b"
)
for base in "${!TUNED_VARIANTS[@]}"; do
  variant="${TUNED_VARIANTS[$base]}"
  if ! ollama list 2>/dev/null | grep -qiF "$base"; then
    echo "skipping tuned variant $variant (base $base not pulled)"
    continue
  fi
  echo "building tuned variant: $variant (from $base) ..."
  tmpfile="$(mktemp)"
  cat > "$tmpfile" <<EOF
FROM $base
# Full GPU offload — every layer in VRAM when it fits (16 GB holds the
# 9.3 GB Q4_K_M weights + KV cache comfortably). Check with: ollama ps
PARAMETER num_gpu 999
# Right-sized context: engine prompts measure ~2k real tokens.
PARAMETER num_ctx 4096
# Larger prefill batches speed up the ~2k-token prompt ingest on GPU.
PARAMETER num_batch 1024
EOF
  ollama create "$variant" -f "$tmpfile"
  rm -f "$tmpfile"
done
# Keep weights resident between turns (a turn fires several LLM calls):
# keep_alive is NOT a Modelfile parameter — set OLLAMA_KEEP_ALIVE in .env
# and start the server with `npm run ollama:serve` (scripts/start-ollama.sh).
echo "tip: start the server with 'npm run ollama:serve' to apply the OLLAMA_* settings from .env"

# 4. Smoke test --------------------------------------------------------------
SMOKE_MODEL="${MODELS[0]}"
echo ""
echo "smoke test: chat with $SMOKE_MODEL ..."
if command -v python3 >/dev/null 2>&1; then
  HOST="$HOST" MODEL="$SMOKE_MODEL" python3 - <<'EOF'
import json, os, sys, urllib.request
host = os.environ["HOST"].rstrip("/")
model = os.environ["MODEL"]
body = json.dumps({
    "model": model,
    "messages": [{"role": "user", "content": "Reply with exactly: ollama-ok"}],
    "stream": False,
}).encode()
req = urllib.request.Request(f"{host}/api/chat", data=body,
                             headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=300) as res:
        data = json.load(res)
    text = (data.get("message") or {}).get("content", "")
    print("smoke reply:", text.strip()[:200])
except Exception as e:  # noqa: BLE001
    print(f"warning: smoke chat failed: {e}", file=sys.stderr)
EOF
else
  curl -fsS -m 300 "$HOST/api/chat" \
    -H 'Content-Type: application/json' \
    -d "{\"model\": \"$SMOKE_MODEL\", \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly: ollama-ok\"}], \"stream\": false}" \
    | head -c 500
  echo ""
fi

echo ""
echo "Ollama is ready."
echo "  list models:  ollama list"
echo "  try a chat:   ollama run $STHENO_MODEL"
echo "  play (8B):    LLM_BACKEND=ollama OLLAMA_MODEL=$STHENO_MODEL npm run start:text"
echo "  play (3B):    LLM_BACKEND=ollama OLLAMA_MODEL=$LLAMA_MODEL npm run start:text"
echo "  verify:       npm run diagnose:ai"
echo ""
echo "Throughput tuning (RTX 5070 Ti / 16 GB VRAM):"
echo "  tuned 14B:    OLLAMA_MODEL=npc-qwen3-14b   (full GPU offload, ctx 4096)"
echo "  tuned 8B:     OLLAMA_MODEL=npc-stheno-8b"
echo "  no thinking:  LLM_THINK=0                  (drops ~700 thinking tokens/call;"
echo "                                                the single biggest latency win)"
echo "  one model:    OLLAMA_NUM_PARALLEL=1        (avoid VRAM contention)"
echo "  check load:   ollama ps                    (PROCESSOR should read 100% GPU)"
echo "  flash attn:   OLLAMA_FLASH_ATTENTION=1     (before ollama serve)"
echo "  measure:      npm run diagnose:ai:live     (records per-model latency, derives timeouts)"
