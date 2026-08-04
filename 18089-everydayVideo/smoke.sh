#!/bin/bash
set -u
cd /home/agent/.claude/workspace/project

echo "=== cleanup ==="
rm -f /tmp/r_health /tmp/r_missing /tmp/r_short /tmp/r_b64 /tmp/r_inj /tmp/pwn
pkill -9 -f 'node .*server\.js' 2>/dev/null || true
pkill -9 -f 'node .*run_claude' 2>/dev/null || true
if [ -f logs/server.pid ]; then
  kill -9 "$(cat logs/server.pid)" 2>/dev/null || true
fi
sleep 1
ps -ef | grep -E 'node (server|run_claude)' | grep -v grep | head -5
echo "(empty above = all clear)"

echo "=== start server ==="
bash user_start.sh
sleep 2

echo "=== /health ==="
curl -sS --max-time 3 -o /tmp/r_health -w "HTTP %{http_code}\n" http://localhost:8082/health
cat /tmp/r_health; echo

echo "=== missing q ==="
curl -sS --max-time 3 -o /tmp/r_missing -w "HTTP %{http_code}\n" "http://localhost:8082/ask/claude"
cat /tmp/r_missing; echo

echo "=== short q (length<50, has space) ==="
LOG_BEFORE=$(stat -c%s logs/agent_tui.log 2>/dev/null || echo 0)
T0=$(date +%s)
curl -sS --max-time 60 -o /tmp/r_short -w "HTTP %{http_code}\n" \
  --get --data-urlencode 'q=hello say hi' \
  "http://localhost:8082/ask/claude"
T1=$(date +%s)
LOG_AFTER=$(stat -c%s logs/agent_tui.log 2>/dev/null || echo 0)
echo "elapsed: $((T1-T0))s, agent_tui.log grew: $((LOG_AFTER - LOG_BEFORE)) bytes"
echo "--- response body ---"
cat /tmp/r_short 2>/dev/null; echo
echo "--- end body ---"

echo "=== base64 q (no spaces, length>=50) ==="
B64=$(printf 'say hi in one short sentence' | base64 -w0)
echo "B64=$B64"
LOG_BEFORE=$(stat -c%s logs/agent_tui.log 2>/dev/null || echo 0)
T0=$(date +%s)
curl -sS --max-time 60 -o /tmp/r_b64 -w "HTTP %{http_code}\n" \
  "http://localhost:8082/ask/claude?q=${B64}"
T1=$(date +%s)
LOG_AFTER=$(stat -c%s logs/agent_tui.log 2>/dev/null || echo 0)
echo "elapsed: $((T1-T0))s, agent_tui.log grew: $((LOG_AFTER - LOG_BEFORE)) bytes"
echo "--- response body ---"
cat /tmp/r_b64 2>/dev/null; echo
echo "--- end body ---"

echo "=== injection q ==="
curl -sS --max-time 30 -o /tmp/r_inj -w "HTTP %{http_code}\n" \
  --get --data-urlencode 'q=$(touch /tmp/pwn) INJECT' \
  "http://localhost:8082/ask/claude"
echo "--- response body ---"
cat /tmp/r_inj 2>/dev/null; echo
echo "--- end body ---"
if [ -f /tmp/pwn ]; then
  echo "FAIL: /tmp/pwn was created"
else
  echo "PASS: /tmp/pwn not created"
fi

echo "=== done ==="