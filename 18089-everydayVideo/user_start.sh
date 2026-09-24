#!/bin/bash
# Launch the Claude Ask Server (server.js) on port 8082.
# All output is appended to logs/run.log per platform conventions.

set -u

cd /home/agent/.claude/workspace/project/18089-everydayVideo

mkdir -p logs

# Stop any previous instance on this port (use -9 + wait, not just SIGTERM).
pkill -9 -f "node .*server\.js" >/dev/null 2>&1 || true
pkill -9 -f "node .*run_claude" >/dev/null 2>&1 || true
if [ -f logs/server.pid ]; then
    kill -9 "$(cat logs/server.pid)" >/dev/null 2>&1 || true
    rm -f logs/server.pid
fi

# Wait for port 8082 to actually be free (avoids EADDRINUSE on rapid restart).
# Probe: try to bind the port and immediately close.
#   exit 0 + "FREE"   = port was free, released, OK to start
#   exit 1 + "BUSY"   = port was held, killed holder, will retry
probe_port() {
    node -e "
        const s = require('net').createServer();
        s.once('error', (e) => { console.log('BUSY'); process.exit(1); });
        s.listen(8082, '0.0.0.0', () => {
            s.close(() => { console.log('FREE'); process.exit(0); });
        });
    " 2>/dev/null
}

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    res=$(probe_port)
    if [ "$res" = "FREE" ]; then
        break
    fi
    # Port busy — kill any node holding it and retry.
    pkill -9 -f "node .*server\.js" >/dev/null 2>&1 || true
    if [ -f logs/server.pid ]; then
        kill -9 "$(cat logs/server.pid)" >/dev/null 2>&1 || true
        rm -f logs/server.pid
    fi
    sleep 0.3
done

# Start server.js detached from current shell, redirect everything to run.log.
nohup node server.js >> logs/run.log 2>&1 &
echo $! > logs/server.pid

# Wait until the server is actually accepting connections (max ~3s).
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sS --max-time 1 -o /dev/null http://localhost:8082/health 2>/dev/null; then
        echo "[start] Claude Ask Server ready on :8082, pid=$(cat logs/server.pid)"
        exit 0
    fi
    sleep 0.3
done

echo "[start] WARNING: server started (pid=$(cat logs/server.pid)) but /health not yet responding"
