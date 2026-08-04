#!/bin/bash
# Top-level user_start.sh for the Hermit-Claw agent container.
# Boots the web app (Claude Ask Server) on port 8082.
# The web app code lives in ./18089-everydayVideo/ ; server.js listens on :8082.
# Per platform conventions, startup output is appended to logs/start.log.

set -u

PROJECT_DIR="/home/agent/.claude/workspace/project"
APP_DIR="$PROJECT_DIR/18089-everydayVideo"
LOG_DIR="$PROJECT_DIR/logs"
START_LOG="$LOG_DIR/start.log"
RUN_LOG="$LOG_DIR/run.log"
SERVER_PID="$LOG_DIR/server.pid"

mkdir -p "$LOG_DIR"

cd "$PROJECT_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

{
    echo "================================================================"
    echo "[$(ts)] user_start.sh invoked"
    echo "[$(ts)] PROJECT_DIR=$PROJECT_DIR"
    echo "[$(ts)] APP_DIR=$APP_DIR"
    echo "[$(ts)] node: $(node -v 2>/dev/null || echo 'not found')"
} >> "$START_LOG"

# --- Sanity checks -----------------------------------------------------------
if [ ! -d "$APP_DIR" ]; then
    echo "[$(ts)] FATAL: app directory not found: $APP_DIR" >> "$START_LOG"
    exit 1
fi

if [ ! -f "$APP_DIR/server.js" ]; then
    echo "[$(ts)] FATAL: server.js not found in $APP_DIR" >> "$START_LOG"
    exit 1
fi

# --- Kill any previous instance ---------------------------------------------
pkill -9 -f "node .*server\.js" >/dev/null 2>&1 || true
pkill -9 -f "node .*run_claude" >/dev/null 2>&1 || true
if [ -f "$SERVER_PID" ]; then
    kill -9 "$(cat "$SERVER_PID")" >/dev/null 2>&1 || true
    rm -f "$SERVER_PID"
fi

# --- Wait until port 8082 is free -------------------------------------------
probe_port() {
    node -e "
        const s = require('net').createServer();
        s.once('error', () => { console.log('BUSY'); process.exit(1); });
        s.listen(8082, '0.0.0.0', () => {
            s.close(() => { console.log('FREE'); process.exit(0); });
        });
    " 2>/dev/null
}

for i in $(seq 1 20); do
    res=$(probe_port)
    if [ "$res" = "FREE" ]; then
        break
    fi
    pkill -9 -f "node .*server\.js" >/dev/null 2>&1 || true
    if [ -f "$SERVER_PID" ]; then
        kill -9 "$(cat "$SERVER_PID")" >/dev/null 2>&1 || true
        rm -f "$SERVER_PID"
    fi
    sleep 0.3
done

# --- Launch server.js --------------------------------------------------------
cd "$APP_DIR"
nohup node server.js >> "$RUN_LOG" 2>&1 &
SERVER_PID_VAL=$!
echo "$SERVER_PID_VAL" > "$SERVER_PID"
echo "[$(ts)] launched server.js pid=$SERVER_PID_VAL from $APP_DIR" >> "$START_LOG"
cd "$PROJECT_DIR"

# --- Wait for /health to respond (max ~3s) ----------------------------------
ready=0
for i in $(seq 1 10); do
    if curl -sS --max-time 1 -o /dev/null http://localhost:8082/health 2>/dev/null; then
        ready=1
        break
    fi
    sleep 0.3
done

if [ "$ready" = "1" ]; then
    echo "[$(ts)] Claude Ask Server ready on :8082 (pid=$SERVER_PID_VAL)" >> "$START_LOG"
else
    echo "[$(ts)] WARNING: server started (pid=$SERVER_PID_VAL) but /health not yet responding" >> "$START_LOG"
fi

echo "[$(ts)] user_start.sh finished" >> "$START_LOG"
exit 0