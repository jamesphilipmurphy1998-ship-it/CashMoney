#!/usr/bin/env bash
# Launch the portfolio-tracker backend (which also serves the frontend).
# Uses Cursor's bundled Node so no separate Node install is required.
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE_BIN:-/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node}"
if [ ! -x "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then NODE="node"; else
    echo "No node binary found. Set NODE_BIN to your node path." >&2; exit 1
  fi
fi

# Load server/.env into the environment if present (KEY=VALUE lines).
if [ -f server/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . server/.env
  set +a
fi

export ELECTRON_RUN_AS_NODE=1
exec "$NODE" server/server.js
