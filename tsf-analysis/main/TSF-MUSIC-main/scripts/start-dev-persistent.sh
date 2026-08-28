#!/bin/bash
# Persistent dev server launcher — survives the calling bash session.
cd /home/z/my-project

# Kill any existing instances
pkill -f "next-server" 2>/dev/null || true
pkill -f "bun run dev" 2>/dev/null || true
sleep 1

# Start fresh — double-fork + setsid for true detachment
(
  exec setsid bun run dev > dev.log 2>&1 < /dev/null &
  PID=$!
  echo $PID > .zscripts/dev.pid
)

# Give it time to come up
for i in {1..20}; do
  if curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
    echo "DEV_SERVER_READY after ${i}s"
    break
  fi
  sleep 1
done

ps -ef | grep -E "next-server|bun run dev" | grep -v grep | head -3
echo "--- health ---"
curl -s -o /dev/null -w "Status: %{http_code}\n" http://127.0.0.1:3000/ 2>&1
tail -10 dev.log
