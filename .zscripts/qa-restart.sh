#!/bin/bash
# QA-anchored restart script
# Ensures running process = disk code, no stale hot-reload state
#
# Usage: bash .zscripts/qa-restart.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "=========================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] QA Restart"
echo "=========================================="

# ====== 1. Show git state ======
echo ""
echo "=== Git state ==="
echo "branch: $(git branch --show-current)"
echo "HEAD: $(git rev-parse --short HEAD)"
echo ""
echo "--- git log (recent 5) ---"
git log --oneline -5
echo ""
echo "--- git status ---"
if [ -n "$(git status --short)" ]; then
  echo "⚠️  Working tree NOT clean:"
  git status --short
else
  echo "✅ Working tree clean"
fi

# ====== 2. Kill old services ======
echo ""
echo "=== Killing old services ==="
# Kill anything on port 3000 (Next.js)
PIDS_3000=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$PIDS_3000" ]; then
  echo "killing port 3000 pids: $PIDS_3000"
  echo "$PIDS_3000" | xargs kill -9 2>/dev/null || true
else
  echo "port 3000: nothing to kill"
fi

# Kill anything on port 3003 (voice-game)
PIDS_3003=$(lsof -ti:3003 2>/dev/null || true)
if [ -n "$PIDS_3003" ]; then
  echo "killing port 3003 pids: $PIDS_3003"
  echo "$PIDS_3003" | xargs kill -9 2>/dev/null || true
else
  echo "port 3003: nothing to kill"
fi

# Also kill any stale bun/next processes
pkill -9 -f "bun.*index.ts" 2>/dev/null || true
pkill -9 -f "next-server" 2>/dev/null || true
pkill -9 -f "next dev" 2>/dev/null || true

sleep 2

# Verify ports are free
echo ""
echo "=== Ports after kill ==="
PORT_3000=$(lsof -ti:3000 2>/dev/null || echo "")
PORT_3003=$(lsof -ti:3003 2>/dev/null || echo "")
if [ -z "$PORT_3000" ] && [ -z "$PORT_3003" ]; then
  echo "✅ ports 3000 + 3003 free"
else
  echo "⚠️  ports still occupied: 3000=$PORT_3000 3003=$PORT_3003"
fi

# ====== 3. Set commit hash env var ======
export COMMIT_HASH=$(git rev-parse --short HEAD)
export QA_ENV="sandbox-qa"
echo ""
echo "=== Env vars for QA ==="
echo "COMMIT_HASH=$COMMIT_HASH"
echo "QA_ENV=$QA_ENV"

# ====== 4. Restart via dev.sh ======
echo ""
echo "=== Starting services via dev.sh ==="
# dev.sh runs in foreground, so we need to background it
# Use setsid for clean process group
setsid bash "$SCRIPT_DIR/dev.sh" > /tmp/qa-restart.log 2>&1 < /dev/null &
DEV_PID=$!
echo "dev.sh started (PID: $DEV_PID)"

# Wait for services to come up
echo "waiting for services..."
sleep 12

# ====== 5. Verify ======
echo ""
echo "=== Verification ==="

# Check ports
PORT_3000=$(lsof -ti:3000 2>/dev/null || echo "")
PORT_3003=$(lsof -ti:3003 2>/dev/null || echo "")
echo "port 3000: ${PORT_3000:-NOT LISTENING}"
echo "port 3003: ${PORT_3003:-NOT LISTENING}"

# Check voice-game log for module errors
echo ""
echo "=== voice-game log (recent) ==="
tail -8 "$PROJECT_DIR/.zscripts/mini-service-voice-game.log" 2>/dev/null || echo "(no log yet)"

# Check for module errors
echo ""
echo "=== Module error check ==="
if grep -q "Cannot find module\|SyntaxError" "$PROJECT_DIR/.zscripts/mini-service-voice-game.log" 2>/dev/null; then
  echo "⚠️  MODULE ERROR detected in voice-game log:"
  grep "Cannot find module\|SyntaxError" "$PROJECT_DIR/.zscripts/mini-service-voice-game.log" | tail -3
else
  echo "✅ no module errors in voice-game log"
fi

# Check /health (via socket path — Caddy proxies /?XTransformPort=3003)
echo ""
echo "=== /health check ==="
# voice-game /health is at http://localhost:3003/health but socket.io uses path=/
# Try direct curl
HEALTH=$(curl -s --max-time 3 "http://localhost:3003/health" 2>/dev/null || echo "FAILED")
if [ "$HEALTH" = "FAILED" ] || [ -z "$HEALTH" ]; then
  echo "⚠️  /health not reachable (socket.io path=/ may intercept)"
  echo "    This is expected if socket.io uses path=/ on port 3003"
else
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
fi

echo ""
echo "=========================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] QA Restart complete"
echo "=========================================="
echo ""
echo "Pre-test report:"
echo "  branch:   $(git branch --show-current)"
echo "  HEAD:     $COMMIT_HASH"
echo "  env:      $QA_ENV"
echo "  port 3000: ${PORT_3000:-DOWN}"
echo "  port 3003: ${PORT_3003:-DOWN}"
echo "  clean:    $([ -z "$(git status --short)" ] && echo yes || echo NO)"
echo ""
