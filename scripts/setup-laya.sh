#!/usr/bin/env bash
#
# Install the Laya decision model locally (https://huggingface.co/convaiinnovations/laya).
#
# What this does:
#   1. Creates an isolated Python venv at .laya-venv (override with LAYA_VENV).
#   2. Installs the `laya[serve]` package (Python >= 3.10 required).
#   3. Downloads the English checkpoint (~808 MB) and runs one smoke prediction.
#
# Usage:
#   npm run setup:laya                 # English checkpoint only (default)
#   npm run setup:laya -- --all        # all checkpoints (english + multilingual + typed-decisions)
#   bash scripts/setup-laya.sh --venv-dir /path/to/venv --reinstall
#
# Next steps after this script succeeds:
#   npm run serve:laya      # start `laya-serve` on 0.0.0.0:8000 (POST /v1/systemone)
#   npm run diagnose:ai     # verify the whole AI setup
#
# Notes:
#   - `laya-serve` speaks the Jev-compatible typed-decisions API
#     (POST /v1/systemone), NOT the OpenAI Chat Completions API.
#   - If `laya.load()` hangs, it is usually transformers probing TensorFlow;
#     this script exports USE_TF=0 to avoid that deadlock.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${LAYA_VENV:-$ROOT/.laya-venv}"
PYTHON_BIN="${LAYA_PYTHON:-python3}"
PRELOAD_ALL=0
REINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) PRELOAD_ALL=1; shift ;;
    --reinstall) REINSTALL=1; shift ;;
    --venv-dir) VENV="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "error: unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "error: python not found: $PYTHON_BIN" >&2
  echo "hint: install Python 3.10+ (https://www.python.org/downloads/) and retry." >&2
  exit 1
fi

if ! "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "error: $PYTHON_BIN is older than Python 3.10 (laya requirement)." >&2
  exit 1
fi
echo "python: $("$PYTHON_BIN" --version 2>&1) @ $(command -v "$PYTHON_BIN")"

if [[ "$REINSTALL" == "1" && -d "$VENV" ]]; then
  echo "removing existing venv: $VENV"
  rm -rf "$VENV"
fi

if [[ ! -d "$VENV" ]]; then
  echo "creating venv: $VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi

PIP="$VENV/bin/pip"
PY="$VENV/bin/python"
"$PIP" install -q -U pip
echo "installing laya[serve] (this may take a few minutes)..."
"$PIP" install -q "laya[serve]"
echo "laya version: $("$PY" -c 'import laya; print(getattr(laya, "__version__", "unknown"))')"

echo "downloading checkpoint + running smoke prediction (USE_TF=0)..."
USE_TF=0 "$PY" - "$PRELOAD_ALL" <<'EOF'
import sys
from laya import Router

preload = sys.argv[1] == "1"
router = Router(preload=preload)
res = router.predict(
    "The office coffee machine is broken.",
    {"maintenance": {"type": "noul", "instructions": "Does this need maintenance?"}},
)
print("smoke answers:", res["answers"])
print("routing:", res.get("routing", {}).get("model"))
EOF

echo ""
echo "Laya is installed locally."
echo "  serve it:   npm run serve:laya    (or: $VENV/bin/laya-serve)"
echo "  verify it:  npm run diagnose:ai"
