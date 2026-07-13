#!/usr/bin/env bash
# Launch the portfolio-tracker backend (which also serves the frontend).
# Runs on a standalone nvm-managed Node — not tied to any editor's process
# lifecycle, so the background quote sweep survives regardless of what apps
# are open.
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE_BIN:-}"
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  NODE="$(nvm which default 2>/dev/null || true)"
fi
if [ -z "$NODE" ] && command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "No node binary found. Install nvm/node, or set NODE_BIN to your node path." >&2
  exit 1
fi

# Load server/.env into the environment if present (KEY=VALUE lines).
if [ -f server/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . server/.env
  set +a
fi

exec "$NODE" server/server.js
