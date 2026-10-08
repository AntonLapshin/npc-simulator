#!/usr/bin/env bash
#
# Unified launcher: Ollama + Laya + engine-backed graphic console + visuals-only UI.
#
# What this does:
#   1. Ensures the Ollama server is up (starts `ollama serve` detached if needed).
#   2. Ensures `laya-serve` is up on 0.0.0.0:8000 (starts it detached if installed).
#   3. Starts the sibling npc-simulator-ui static server (showcase + scene preview).
#   4. Runs the engine-backed graphic console in the foreground.
#
# Defaults (override without editing this file):
#   scenario : scenarios/office-anton.json
#   provider : ollama
#   model    : fluffy/l3-8b-stheno-v3.2
#   debug    : on (--debug is passed to the engine)
#   engine   : http://localhost:8123/ (graphic console, real engine)
#   ui       : http://localhost:8124/ (sibling visuals-only gallery/preview)
#
# Usage:
#   npm start                                                          # everything, defaults above
#   npm start -- --help                                                 # this help
#   npm start -- scenarios/office.json --provider ollama                # different scenario, default model
#   npm start -- --model huihui_ai/llama3.2-abliterate:3b               # same scenario, fast 3B model
#   npm start -- --provider joingonka --model zai-org/GLM-5.3-Flash     # hosted gateway instead
#   npm start -- --mock                                                 # offline deterministic engines
#   npm start -- --no-debug                                             # hide objective world + LLM traces
#   npm start -- --port 8123 --ui-port 8124                            # move either web server
#   npm start -- --no-laya --no-ollama --no-ui                          # skip sidecars (engine only)
#   npm start -- --engine-only                                          # same as above, shorthand
#   npm start -- --dry-run                                              # print what would run, start nothing
#   npm start -- -- <engine flags...>                                   # verbatim passthrough to start:graphic
#
# Env overrides:
#   ENGINE_PORT / UI_PORT   — same as --port / --ui-port
#   OLLAMA_HOST             — Ollama server address (default http://127.0.0.1:11434)
#   LAYA_SERVE_URL          — Laya health-check URL (default http://127.0.0.1:8000)
# (The engine itself additionally reads .env; explicit flags win.)
#
# Engine flags are forwarded to `npm run start:graphic`
# (scenario, --provider/--backend, --model, --base-url, --mock, --debug,
#  --no-autosave, --port). Run `npm run start:graphic -- --help` for details.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env so sidecars see the same config as the engine (existing vars win).
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

DEFAULT_SCENARIO="scenarios/office-anton.json"
DEFAULT_PROVIDER="ollama"
DEFAULT_MODEL="fluffy/l3-8b-stheno-v3.2"

SCENARIO="$DEFAULT_SCENARIO"
PROVIDER="$DEFAULT_PROVIDER"
MODEL="$DEFAULT_MODEL"
DEBUG=1
ENGINE_PORT="${ENGINE_PORT:-${PORT:-8123}}"
UI_PORT="${UI_PORT:-8124}"
RUN_OLLAMA=1
RUN_LAYA=1
RUN_UI=1
DRY_RUN=0

HAS_SCENARIO=0
HAS_PROVIDER=0
HAS_MODEL=0
HAS_DEBUG=0
ENGINE_ARGS=()
PASSTHROUGH=0

print_help() {
  sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  if [[ "$PASSTHROUGH" == "1" ]]; then
    ENGINE_ARGS+=("$1")
    shift
    continue
  fi
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --)
      PASSTHROUGH=1
      shift
      ;;
    --engine-only)
      RUN_OLLAMA=0
      RUN_LAYA=0
      RUN_UI=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-ollama)
      RUN_OLLAMA=0
      shift
      ;;
    --no-laya)
      RUN_LAYA=0
      shift
      ;;
    --no-ui)
      RUN_UI=0
      shift
      ;;
    --no-debug)
      DEBUG=0
      HAS_DEBUG=1
      shift
      ;;
    --debug)
      DEBUG=1
      HAS_DEBUG=1
      ENGINE_ARGS+=("$1")
      shift
      ;;
    --port|-p|--engine-port)
      ENGINE_PORT="${2:-}"
      if [[ -z "$ENGINE_PORT" ]]; then echo "error: $1 needs a value (e.g. $1 8123)" >&2; exit 2; fi
      shift 2
      ;;
    --port=*|--engine-port=*)
      ENGINE_PORT="${1#*=}"
      shift
      ;;
    --ui-port)
      UI_PORT="${2:-}"
      if [[ -z "$UI_PORT" ]]; then echo "error: --ui-port needs a value (e.g. --ui-port 8124)" >&2; exit 2; fi
      shift 2
      ;;
    --ui-port=*)
      UI_PORT="${1#*=}"
      shift
      ;;
    --provider|--backend)
      PROVIDER="${2:-}"
      if [[ -z "$PROVIDER" ]]; then echo "error: $1 needs a value: joingonka | laya-local | ollama" >&2; exit 2; fi
      HAS_PROVIDER=1
      ENGINE_ARGS+=("$1" "$PROVIDER")
      shift 2
      ;;
    --provider=*|--backend=*)
      PROVIDER="${1#*=}"
      HAS_PROVIDER=1
      ENGINE_ARGS+=("$1")
      shift
      ;;
    --model)
      MODEL="${2:-}"
      if [[ -z "$MODEL" ]]; then echo "error: --model needs a value (model id)" >&2; exit 2; fi
      HAS_MODEL=1
      ENGINE_ARGS+=("$1" "$MODEL")
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      HAS_MODEL=1
      ENGINE_ARGS+=("$1")
      shift
      ;;
    --base-url|--baseUrl|--mock|--no-autosave)
      ENGINE_ARGS+=("$1")
      shift
      ;;
    --base-url=*|--baseUrl=*)
      ENGINE_ARGS+=("$1")
      shift
      ;;
    --*)
      echo "error: unknown flag: $1 (try --help)" >&2
      exit 2
      ;;
    *)
      if [[ "$HAS_SCENARIO" == "0" ]]; then
        SCENARIO="$1"
        HAS_SCENARIO=1
      else
        ENGINE_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

if ! [[ "$ENGINE_PORT" =~ ^[0-9]+$ ]] || [[ "$ENGINE_PORT" -le 0 ]]; then
  echo "error: --port must be a positive integer (got '$ENGINE_PORT')" >&2
  exit 2
fi
if ! [[ "$UI_PORT" =~ ^[0-9]+$ ]] || [[ "$UI_PORT" -le 0 ]]; then
  echo "error: --ui-port must be a positive integer (got '$UI_PORT')" >&2
  exit 2
fi
if [[ "$ENGINE_PORT" == "$UI_PORT" ]] && [[ "$RUN_UI" == "1" ]]; then
  echo "error: engine port ($ENGINE_PORT) and UI port ($UI_PORT) clash — pass --ui-port <other>" >&2
  exit 2
fi

# Inject defaults for anything the user did not override.
FINAL_ARGS=("$SCENARIO")
if [[ "$HAS_PROVIDER" == "0" ]]; then FINAL_ARGS+=(--provider "$PROVIDER"); fi
if [[ "$HAS_MODEL" == "0" ]]; then FINAL_ARGS+=(--model "$MODEL"); fi
FINAL_ARGS+=("${ENGINE_ARGS[@]}")
if [[ "$DEBUG" == "1" && "$HAS_DEBUG" == "0" ]]; then FINAL_ARGS+=(--debug); fi
FINAL_ARGS+=(--port "$ENGINE_PORT")

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OLLAMA_HOST="${OLLAMA_HOST%/}"
LAYA_URL="${LAYA_SERVE_URL:-http://127.0.0.1:8000}"
LAYA_URL="${LAYA_URL%/}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "ollama : $([[ "$RUN_OLLAMA" == "1" ]] && echo "ensure @ $OLLAMA_HOST" || echo skipped)"
  echo "laya   : $([[ "$RUN_LAYA" == "1" ]] && echo "ensure @ $LAYA_URL" || echo skipped)"
  echo "ui     : $([[ "$RUN_UI" == "1" ]] && echo "serve ../npc-simulator-ui on :$UI_PORT" || echo skipped)"
  echo "engine : npm run start:graphic -- ${FINAL_ARGS[*]}"
  exit 0
fi

CHILD_PIDS=""
ENGINE_PID=""

# Kill what we started: sidecars we launched plus the foreground engine.
# Only pids in CHILD_PIDS/ENGINE_PID are touched — pre-existing ollama/laya
# servers and anything on a busy UI port are left alone.
shutdown() {
  trap - INT TERM EXIT
  if [[ -n "$ENGINE_PID" ]]; then kill "$ENGINE_PID" 2>/dev/null || true; fi
  if [[ -n "$CHILD_PIDS" ]]; then
    # shellcheck disable=SC2086
    kill $CHILD_PIDS 2>/dev/null || true
  fi
}
trap shutdown INT TERM EXIT

start_detached() {
  # start_detached <logfile> <cmd...>: launch a sidecar, remember it for cleanup.
  local logfile="$1"
  shift
  "$@" >>"$logfile" 2>&1 &
  CHILD_PIDS="$CHILD_PIDS $!"
  echo "  log: $logfile (pid $!)"
}

# 1. Ollama -----------------------------------------------------------------
if [[ "$RUN_OLLAMA" == "1" ]]; then
  echo "[start] ollama @ $OLLAMA_HOST"
  if curl -fsS -m 5 -o /dev/null "$OLLAMA_HOST/api/tags" 2>/dev/null; then
    echo "  already running"
  elif ! command -v ollama >/dev/null 2>&1; then
    echo "  warning: ollama binary not found — skipping (install: npm run setup:ollama)" >&2
  else
    echo "  starting 'ollama serve' in the background ..."
    start_detached "/tmp/ollama-serve.log" ollama serve
    for _ in $(seq 1 30); do
      sleep 1
      if curl -fsS -m 5 -o /dev/null "$OLLAMA_HOST/api/tags" 2>/dev/null; then break; fi
    done
    if curl -fsS -m 5 -o /dev/null "$OLLAMA_HOST/api/tags" 2>/dev/null; then
      echo "  ollama is up"
    else
      echo "  warning: ollama did not come up at $OLLAMA_HOST (see /tmp/ollama-serve.log)" >&2
    fi
  fi
  if command -v ollama >/dev/null 2>&1 && [[ "$HAS_PROVIDER" == "0" || "$PROVIDER" == "ollama" ]]; then
    if ! ollama list 2>/dev/null | grep -qiF "$MODEL"; then
      echo "  warning: model '$MODEL' not in 'ollama list' — pull it: ollama pull $MODEL" >&2
    fi
  fi
fi

# 2. Laya -------------------------------------------------------------------
if [[ "$RUN_LAYA" == "1" ]]; then
  echo "[start] laya-serve @ $LAYA_URL"
  if curl -s -o /dev/null -m 3 "$LAYA_URL/" 2>/dev/null; then
    echo "  already running"
  else
    SERVE_BIN="${LAYA_VENV:-$ROOT/.laya-venv}/bin/laya-serve"
    if [[ ! -x "$SERVE_BIN" ]]; then
      echo "  warning: laya-serve not found at $SERVE_BIN — skipping (install: npm run setup:laya)" >&2
    else
      echo "  starting laya-serve in the background (device=${LAYA_DEVICE:-cpu} preload=${LAYA_PRELOAD:-1}) ..."
      export LAYA_DEVICE="${LAYA_DEVICE:-cpu}"
      export LAYA_PRELOAD="${LAYA_PRELOAD:-1}"
      # Exp-7 item A1: pass --device explicitly when the binary supports it
      # (some builds ignore the LAYA_DEVICE env var and sit on the GPU).
      LAYA_ARGS=()
      if "$SERVE_BIN" --help 2>/dev/null | grep -q -- "--device"; then
        LAYA_ARGS+=(--device "${LAYA_DEVICE:-cpu}")
      fi
      start_detached "$ROOT/logs/laya-serve.log" "$SERVE_BIN" "${LAYA_ARGS[@]}"
      for _ in $(seq 1 30); do
        sleep 1
        if curl -s -o /dev/null -m 3 "$LAYA_URL/" 2>/dev/null; then break; fi
      done
      if curl -s -o /dev/null -m 3 "$LAYA_URL/" 2>/dev/null; then
        echo "  laya-serve is up"
      else
        echo "  warning: laya-serve did not come up at $LAYA_URL (see logs/laya-serve.log)" >&2
      fi
    fi
  fi
fi

# 3. Visuals-only UI (sibling checkout) --------------------------------------
UI_ROOT="$(resolve_path() { cd "$1" 2>/dev/null && pwd; }; resolve_path "$ROOT/../npc-simulator-ui")"
if [[ "$RUN_UI" == "1" ]]; then
  echo "[start] npc-simulator-ui @ http://localhost:$UI_PORT/"
  if [[ -z "$UI_ROOT" || ! -f "$UI_ROOT/tools/serve.mjs" ]]; then
    echo "  warning: sibling ../npc-simulator-ui not found — skipping visuals-only server" >&2
    echo "  hint: the engine console still serves its scene layer via src/ui/graphic/ui-lib" >&2
  elif curl -s -o /dev/null -m 2 "http://127.0.0.1:$UI_PORT/" 2>/dev/null; then
    echo "  already running (port $UI_PORT busy — leaving it alone)"
  else
    echo "  serving $UI_ROOT on :$UI_PORT ..."
    # exec: the backgrounded subshell *becomes* node, so $! is the real pid
    # and the EXIT/INT/TERM trap actually takes the UI server down with us.
    (cd "$UI_ROOT" && exec node tools/serve.mjs "$UI_PORT" >>"/tmp/npc-ui-$UI_PORT.log" 2>&1) &
    UI_PID="$!"
    CHILD_PIDS="$CHILD_PIDS $UI_PID"
    echo "  log: /tmp/npc-ui-$UI_PORT.log (pid $UI_PID)"
  fi
fi

# 4. Engine-backed graphic console (foreground) -------------------------------
echo "[start] engine console: npm run start:graphic -- ${FINAL_ARGS[*]}"
echo "  → console : http://localhost:$ENGINE_PORT/"
if [[ "$RUN_UI" == "1" ]]; then
  echo "  → gallery : http://localhost:$UI_PORT/showcase.html"
  echo "  → preview : http://localhost:$UI_PORT/scene.html"
fi
echo "  stop everything with Ctrl-C"
echo ""
# Foreground child (not exec) so the shutdown trap above stays alive and
# takes the sidecars down with the engine on Ctrl-C / kill / engine exit.
npm run start:graphic -- "${FINAL_ARGS[@]}" &
ENGINE_PID="$!"
wait "$ENGINE_PID"
