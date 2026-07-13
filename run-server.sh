#!/usr/bin/env bash
# run-server.sh — supervisor that keeps the backend alive.
#
# macOS blocks a LaunchAgent from reaching ~/Documents (privacy/TCC), so instead
# we run this from a normal session (which has Documents access) and let it
# restart the server if it ever exits. Combined with the on-disk quote cache
# (data/quotes-cache.json), a restart resumes warm rather than re-sweeping cold.
#
# Start detached:   nohup ./run-server.sh > data/server.log 2>&1 & disown
# Stop:             pkill -f run-server.sh ; lsof -ti :4178 | xargs kill

cd "$(dirname "$0")" || exit 1

while true; do
  echo "[supervisor] $(date '+%H:%M:%S') starting server"
  ./start.sh
  code=$?
  echo "[supervisor] $(date '+%H:%M:%S') server exited (code $code) — restarting in 3s"
  sleep 3
done
