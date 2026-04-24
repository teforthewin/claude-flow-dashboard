#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install Claude Code hooks into a project's .claude/settings.json
# Configures PreToolUse, PostToolUse, and UserPromptSubmit hooks
# to feed into the Flow Dashboard logger.
#
# Usage:
#   ./install-hooks.sh                     # install in current directory
#   ./install-hooks.sh /path/to/project    # install in specified project
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGGER="$ROOT_DIR/flow-dashboard/flow_logger.py"

if [[ ! -f "$LOGGER" ]]; then
  echo "ERROR: flow_logger.py not found at $LOGGER"
  exit 1
fi

TARGET_DIR="${1:-.}"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
SETTINGS_DIR="$TARGET_DIR/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

echo "Installing Flow Dashboard hooks"
echo "  Logger:  $LOGGER"
echo "  Target:  $SETTINGS_FILE"
echo ""

mkdir -p "$SETTINGS_DIR"

# Generate the hooks JSON
HOOKS_JSON=$(cat <<ENDJSON
{
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "python3 $LOGGER prompt || true"
        }
      ]
    }
  ],
  "PreToolUse": [
    {
      "matcher": ".*",
      "hooks": [
        {
          "type": "command",
          "command": "python3 $LOGGER pre"
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": ".*",
      "hooks": [
        {
          "type": "command",
          "command": "python3 $LOGGER post"
        }
      ]
    }
  ]
}
ENDJSON
)

if [[ -f "$SETTINGS_FILE" ]]; then
  # Merge hooks into existing settings.json using Python
  python3 -c "
import json, sys

with open('$SETTINGS_FILE') as f:
    settings = json.load(f)

hooks = json.loads('''$HOOKS_JSON''')
settings['hooks'] = hooks

with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('Updated existing $SETTINGS_FILE')
"
else
  # Create new settings.json
  python3 -c "
import json

settings = {'hooks': json.loads('''$HOOKS_JSON''')}

with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('Created $SETTINGS_FILE')
"
fi

echo ""
echo "Done. Hooks installed. Claude Code will now log to the Flow Dashboard."
echo "Start the dashboard with: $ROOT_DIR/scripts/start.sh"
