#!/usr/bin/env bash
#
# Start the local Laya decision server (`laya-serve`).
#
# Serves the locally installed Laya checkpoints on 0.0.0.0:8000 with the
# Jev-compatible typed-decisions API: POST /v1/systemone
# (NOT the OpenAI Chat Completions API).
#
# Configuration via environment (or .env file, auto-loaded if present):
#   LAYA_DEVICE=cpu|cuda   (default: cpu)
#   LAYA_PRELOAD=0|1       (default: 1 — preload checkpoints, no first-call stall)
#   LAYA_API_KEY=...       (optional — when set, clients must send
#                           `Authorization: Bearer <key>`)
#
# Usage:
#   npm run serve:laya
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

VENV="${LAYA_VENV:-$ROOT/.laya-venv}"
SERVE_BIN="$VENV/bin/laya-serve"

if [[ ! -x "$SERVE_BIN" ]]; then
  echo "error: laya-serve not found at $SERVE_BIN" >&2
  echo "hint: install it first with: npm run setup:laya" >&2
  exit 1
fi

export LAYA_DEVICE="${LAYA_DEVICE:-cpu}"
export LAYA_PRELOAD="${LAYA_PRELOAD:-1}"

# Exp-7 item A1: some laya-serve builds ignore the LAYA_DEVICE env var
# (exp-7 P1: the server held 5.8 GB VRAM despite LAYA_DEVICE=cpu, starving
# qwen3:14b down to 18% GPU offload). When the binary advertises a
# --device flag, pass it explicitly; otherwise rely on the env var and tell
# the operator how to verify (nvidia-smi must NOT list the server's python
# process when LAYA_DEVICE=cpu).
SERVE_ARGS=()
if "$SERVE_BIN" --help 2>/dev/null | grep -q -- "--device"; then
  SERVE_ARGS+=(--device "$LAYA_DEVICE")
else
  echo "warning: laya-serve shows no --device flag - relying on LAYA_DEVICE=$LAYA_DEVICE env var." >&2
  echo "         verify after start: nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv" >&2
  echo "         must NOT list the laya-serve python process when LAYA_DEVICE=cpu." >&2
fi

echo "starting laya-serve (device=$LAYA_DEVICE preload=$LAYA_PRELOAD) on 0.0.0.0:8000 ..."
exec "$SERVE_BIN" "${SERVE_ARGS[@]}"
