#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 [--logs-dir <path>] [--port <port>]"
  echo ""
  echo "  --logs-dir <path>   Directory for JSONL session files (default: ~/.claude/flow-logs)"
  echo "  --port <port>       Server port (default: 7842)"
  echo ""
  echo "Examples:"
  echo "  $0"
  echo "  $0 --logs-dir /tmp/my-logs"
  echo "  $0 --logs-dir /tmp/my-logs --port 8080"
  exit 1
}

LOGS_DIR="$HOME/.claude/flow-logs"
PORT="7842"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --logs-dir)
      [[ -z "${2:-}" ]] && usage
      LOGS_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || LOGS_DIR="$2"
      shift 2
      ;;
    --port)
      [[ -z "${2:-}" ]] && usage
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

VENV="$SCRIPT_DIR/.venv"
REQS="$SCRIPT_DIR/requirements.txt"
REQS_STAMP="$VENV/.installed_reqs_hash"

# Create venv if missing or broken
if [[ ! -x "$VENV/bin/python3" ]]; then
  echo "[setup] Creating virtualenv…"
  python3 -m venv "$VENV"
fi

# Install / sync deps when requirements.txt has changed (or never been installed)
CURRENT_HASH="$(md5 -q "$REQS" 2>/dev/null || md5sum "$REQS" | awk '{print $1}')"
if [[ ! -f "$REQS_STAMP" ]] || [[ "$(cat "$REQS_STAMP")" != "$CURRENT_HASH" ]]; then
  echo "[setup] Installing dependencies from requirements.txt…"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$REQS"
  echo "$CURRENT_HASH" > "$REQS_STAMP"
  echo "[setup] Done."
fi

mkdir -p "$LOGS_DIR"

export FLOW_LOG_DIR="$LOGS_DIR"
export FLOW_SERVER_PORT="$PORT"

exec "$VENV/bin/python3" "$SCRIPT_DIR/flow_server.py"
