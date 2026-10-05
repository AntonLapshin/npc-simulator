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

echo "starting laya-serve (device=$LAYA_DEVICE preload=$LAYA_PRELOAD) on 0.0.0.0:8000 ..."
exec "$SERVE_BIN"
