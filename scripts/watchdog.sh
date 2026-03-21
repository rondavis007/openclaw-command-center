#!/bin/bash
# Created/maintained by Clawbaby.
# Purpose: Watchdog for Command Center — auto-restarts if the health endpoint goes down.
# Added: 2026-03-21.

CC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HEALTH_URL="http://127.0.0.1:3333/api/health"
LOG="/tmp/command-center.log"
PIDFILE="/tmp/command-center.pid"

start_server() {
  cd "$CC_DIR" || exit 1
  HOST=0.0.0.0 nohup node lib/server.js >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "[watchdog] Started Command Center (pid $!)"
}

is_healthy() {
  curl -fsS --max-time 5 "$HEALTH_URL" > /dev/null 2>&1
}

# If not healthy, kill any stale process and restart
if ! is_healthy; then
  echo "[watchdog] $(date): Command Center not responding — restarting"
  # Kill any stale instances
  if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    kill "$OLD_PID" 2>/dev/null
  fi
  pkill -f "skills/command-center/lib/server.js" 2>/dev/null
  sleep 2
  start_server
  sleep 5
  if is_healthy; then
    echo "[watchdog] $(date): Restart successful"
  else
    echo "[watchdog] $(date): Restart failed — check $LOG"
    exit 1
  fi
fi
