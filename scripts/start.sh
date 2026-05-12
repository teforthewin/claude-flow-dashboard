#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Claude Code Flow Dashboard — Start script (Linux / macOS)
# Creates venv, installs deps, starts the FastAPI server.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASH_DIR="$ROOT_DIR/flow-dashboard"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --port <port>       Server port            (default: 7842)
  --logs-dir <path>   JSONL logs directory   (default: ~/.claude/flow-logs)
  -h, --help          Show this help

Examples:
  $(basename "$0")
  $(basename "$0") --port 9000
  $(basename "$0") --logs-dir /tmp/flow-logs --port 8080
EOF
  exit 0
}

PORT="${FLOW_SERVER_PORT:-7842}"
LOGS_DIR="${FLOW_LOG_DIR:-$HOME/.claude/flow-logs}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)     PORT="${2:?--port requires a value}"; shift 2 ;;
    --logs-dir) LOGS_DIR="${2:?--logs-dir requires a value}"; shift 2 ;;
    -h|--help)  usage ;;
    *)          echo "Unknown option: $1"; usage ;;
  esac
done

# ── Python check ─────────────────────────────────────────────────────────────
PYTHON=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    ver=$("$cmd" -c "import sys; print(sys.version_info >= (3,11))" 2>/dev/null || echo "False")
    if [[ "$ver" == "True" ]]; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "ERROR: Python 3.11+ is required but not found."
  echo "Install it from https://www.python.org/downloads/ or via your package manager."
  exit 1
fi

echo "[info] Using $($PYTHON --version) at $(command -v "$PYTHON")"

# ── Virtualenv ───────────────────────────────────────────────────────────────
VENV="$DASH_DIR/.venv"
REQS="$DASH_DIR/requirements.txt"
STAMP="$VENV/.reqs_hash"

if [[ ! -x "$VENV/bin/python3" ]] && [[ ! -x "$VENV/bin/python" ]]; then
  echo "[setup] Creating virtualenv in $VENV ..."
  "$PYTHON" -m venv "$VENV"
fi

VENV_PY="$VENV/bin/python3"
[[ -x "$VENV_PY" ]] || VENV_PY="$VENV/bin/python"

# Install / refresh deps when requirements.txt changes
HASH="$(md5sum "$REQS" 2>/dev/null | awk '{print $1}' || md5 -q "$REQS" 2>/dev/null || echo "none")"
if [[ ! -f "$STAMP" ]] || [[ "$(cat "$STAMP")" != "$HASH" ]]; then
  echo "[setup] Installing dependencies ..."
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$REQS"
  echo "$HASH" > "$STAMP"
fi

# ── Start ────────────────────────────────────────────────────────────────────
mkdir -p "$LOGS_DIR"

export FLOW_LOG_DIR="$LOGS_DIR"
export FLOW_SERVER_PORT="$PORT"

echo ""
echo "  Flow Dashboard starting on http://localhost:$PORT"
echo "  Logs directory: $LOGS_DIR"
echo ""

exec "$VENV_PY" "$DASH_DIR/flow_server.py"
