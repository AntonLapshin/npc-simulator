#!/usr/bin/env bash
# Start `ollama serve` with the OLLAMA_* environment from `.env`.
#
# Why this exists: OLLAMA_KEEP_ALIVE / OLLAMA_NUM_PARALLEL /
# OLLAMA_FLASH_ATTENTION are read by the ollama daemon, not by the
# simulator — putting them in `.env` does nothing unless they are exported
# into the server's environment. This script loads exactly the OLLAMA_*
# lines from `.env` (repo root) and execs `ollama serve` with them set.
# Start the server any other way and those settings are silently ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "warning: $ENV_FILE not found — starting with ollama defaults" >&2
  echo "hint: cp .env.example .env" >&2
else
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Trim leading whitespace; skip blanks and comments.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    if [[ "$trimmed" =~ ^(OLLAMA_[A-Z_]+)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      # Strip optional surrounding single/double quotes.
      val="${val%\"}"; val="${val#\"}"
      val="${val%\'}"; val="${val#\'}"
      export "$key=$val"
      echo "export $key=$val"
    fi
  done < "$ENV_FILE"
fi

exec ollama serve "$@"
