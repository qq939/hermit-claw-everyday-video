#!/bin/bash
set -u
cd "$(dirname "$0")"

LOG_FILE="logs/agent_tui.log"
RUN_LOG="logs/run.log"

LOG_BEFORE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
echo "[$(date +%T.%N)] agent_tui.log before: $LOG_BEFORE bytes"

echo "[$(date +%T.%N)] starting curl /ask/claude?q=hi"
curl -v --max-time 45 -o /tmp/r_ask -w "HTTP=%{http_code} time=%{time_total}s\n" \
  --get --data-urlencode 'q=hi' \
  "http://localhost:8082/ask/claude" 2>&1 | tail -30
echo "[$(date +%T.%N)] curl finished"

LOG_AFTER=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
echo "[$(date +%T.%N)] agent_tui.log after: $LOG_AFTER bytes (delta: $((LOG_AFTER - LOG_BEFORE)))"

echo "--- response body ---"
cat /tmp/r_ask
echo
echo "--- end body ---"

echo "--- run.log tail ---"
tail -8 "$RUN_LOG"