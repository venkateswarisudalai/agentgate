#!/usr/bin/env bash
# Install the agentgate DevOps Agent persona into Claude Code.
#
# What this does:
#   1. Confirms agentgate is built
#   2. Picks a settings.json target (~/.claude/settings.json by default)
#   3. Backs up the existing file
#   4. Generates a settings.json with the PreToolUse hook + filesystem MCP
#      already wired through agentgate, with absolute paths filled in
#   5. Tells you what to do next
#
# Safety:
#   - This script does NOT modify settings.json without confirmation.
#   - If you decline, the generated config is printed to stdout and you
#     can paste/merge it manually.

set -euo pipefail

# Resolve the agentgate repo root (this script lives in examples/devops-agent/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/claude-settings.json"
HOOK_DIST="$REPO_ROOT/packages/claude-code-hook/dist/index.js"
GATE_DIST="$REPO_ROOT/packages/mcp-gate/dist/index.js"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red() { printf "\033[31m%s\033[0m\n" "$*"; }
gray() { printf "\033[90m%s\033[0m\n" "$*"; }

bold "agentgate DevOps Agent installer"
gray  "repo root: $REPO_ROOT"
echo

# 1. Verify built artifacts exist.
if [[ ! -f "$HOOK_DIST" ]] || [[ ! -f "$GATE_DIST" ]]; then
  red "agentgate isn't built yet."
  echo "Run from the repo root:"
  echo "  npm install && npm run build"
  exit 1
fi
green "✓ agentgate is built"

# 2. Pick target settings.json.
TARGET="${AGENTGATE_SETTINGS:-$HOME/.claude/settings.json}"
echo
echo "Target settings.json: $TARGET"

# 3. Generate the populated config.
USER_HOME_ESCAPED=$(printf '%s' "$HOME" | sed 's:/:\\/:g')
REPO_ROOT_ESCAPED=$(printf '%s' "$REPO_ROOT" | sed 's:/:\\/:g')

GENERATED=$(sed \
  -e "s/AGENTGATE_HOME/$REPO_ROOT_ESCAPED/g" \
  -e "s/AGENTGATE_USER_HOME/$USER_HOME_ESCAPED/g" \
  "$TEMPLATE")

# 4. Decide what to do.
if [[ -f "$TARGET" ]]; then
  echo
  bold "An existing $TARGET was found."
  gray "(this script will NOT overwrite it without confirmation)"
  echo
  echo "Generated config (paste this in, merging with what you already have):"
  echo "----------------------------------------------------------------"
  printf '%s\n' "$GENERATED"
  echo "----------------------------------------------------------------"
  echo
  echo "Next:"
  echo "  1. Back up your existing settings: cp '$TARGET' '$TARGET.bak.$(date +%s)'"
  echo "  2. Merge the 'hooks' and 'mcpServers' sections above into '$TARGET'"
  echo "  3. Start the control plane:  node '$REPO_ROOT/packages/control-plane/dist/index.js'"
  echo "  4. Restart Claude Code to pick up the hook"
  echo "  5. Optional: in another terminal, run:  node '$REPO_ROOT/packages/cli/dist/index.js' watch"
  exit 0
fi

# Brand new install — write the file.
mkdir -p "$(dirname "$TARGET")"
printf '%s\n' "$GENERATED" > "$TARGET"
green "✓ wrote $TARGET"
echo
echo "Next:"
echo "  1. Start the control plane:"
echo "       node '$REPO_ROOT/packages/control-plane/dist/index.js'"
echo "  2. (Optional) Watch approvals from the terminal:"
echo "       node '$REPO_ROOT/packages/cli/dist/index.js' watch"
echo "  3. (Optional) Open the dashboard: http://localhost:4000"
echo "  4. Start a fresh Claude Code session — the DevOps hook is now active."
echo
gray "Tip: paste the contents of system-prompt.md as your first message in new"
gray "Claude Code sessions to give the agent the SRE persona, until Claude Code"
gray "exposes a stable system-prompt setting."
