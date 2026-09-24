// Claude Ask Server
// Implements the platform-mandated /ask/claude endpoint.
// Spec: route via run_claude.js (no direct claude CLI, no sh -c).

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const skillManager = require('./lib/skill-manager');
const commManager = require('./lib/comm-manager');
const studioMount = require('./lib/studio/mount');
const storyboardMount = require('./lib/storyboard/mount');
const h3Client = require('./lib/h3/client');

const PORT = 8082;
const PROJECT_DIR = __dirname;
const RUN_CLAUDE = path.join(PROJECT_DIR, 'run_claude.js');
const LOG_DIR = path.join(PROJECT_DIR, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'run.log');
const AGENT_LOG = path.join(LOG_DIR, 'agent_tui.log');
const SKILL_UI_HTML = path.join(PROJECT_DIR, 'lib', 'skill-ui.html');
const CONSOLE_HTML = path.join(PROJECT_DIR, 'lib', 'console.html');

const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes per platform rule
const SIGKILL_DELAY_MS = 5 * 1000;
const RESPONSE_WAIT_MS = 5 * 1000; // rule §9: log must appear within 5s

const SYSTEM_PROMPT =
    'You are a helpful assistant. Answer the question concisely. ' +
    'Do not use markdown or formatting.';

function appendRunLog(line) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(RUN_LOG, `[${new Date().toISOString()}] ${line}\n`);
    } catch (_) { /* logging must never break the request */ }
}

const server = http.createServer((req, res) => {
    // Outer socket timeout (dual with inner timer below)
    res.setTimeout(TIMEOUT_MS, () => {
        appendRunLog(`res.setTimeout fired for ${req.method} ${req.url}`);
        if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        try { res.end('Request timeout'); } catch (_) {}
    });

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ---- Health check ----
    if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
        return;
    }

    // ---- /ask/claude ----
    if (
        (req.method === 'GET' || req.method === 'POST') &&
        url.pathname === '/ask/claude'
    ) {
        const q = url.searchParams.get('q');

        if (!q) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing q parameter');
            return;
        }

        // Encoding detection (rule §1)
        let question;
        try {
            if (q.includes(' ') || q.length < 50) {
                question = decodeURIComponent(q);
            } else {
                question = Buffer.from(q, 'base64').toString('utf8');
            }
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Invalid encoding');
            return;
        }

        const fullMessage = `${SYSTEM_PROMPT}\n\n${question}`;
        const msgB64 = Buffer.from(fullMessage).toString('base64');

        // Per-request marker. We don't write to agent_tui.log ourselves
        // (run_claude.js owns it), but we record the byte length so we can
        // read only the new portion produced after this call.
        const marker = crypto.randomBytes(8).toString('hex');
        let agentLogSizeBefore = 0;
        try {
            agentLogSizeBefore = fs.existsSync(AGENT_LOG)
                ? fs.statSync(AGENT_LOG).size
                : 0;
        } catch (_) { agentLogSizeBefore = 0; }

        // Spawn run_claude.js. NO shell, NO direct claude CLI.
        const child = spawn('node', [RUN_CLAUDE], {
            cwd: PROJECT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ANTHROPIC_DISABLE_PREFLIGHT: '1',
                CLAUDE_CAPTURE_STDIO: '1',
                CLAUDE_MSG: msgB64,
            },
        });

        let settled = false;
        const settle = (status, body) => {
            if (settled) return;
            settled = true;
            if (!res.headersSent) {
                res.writeHead(status, {
                    'Content-Type': 'text/plain; charset=utf-8',
                });
            }
            try { res.end(body); } catch (_) {}
        };

        // Declare timers BEFORE the close handler so the handler can clear them.
        let timer = null;
        let killTimer = null;

        // 20-minute hard timeout: SIGTERM, then SIGKILL 5s later.
        timer = setTimeout(() => {
            appendRunLog(`timeout after ${TIMEOUT_MS}ms, sending SIGTERM`);
            try { child.kill('SIGTERM'); } catch (_) {}
            setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (_) {}
            }, SIGKILL_DELAY_MS);
            settle(504, 'Request timeout (20 minutes)');
        }, TIMEOUT_MS);

        killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
        }, TIMEOUT_MS + SIGKILL_DELAY_MS + 1000);

        // Read the new portion of agent_tui.log once it appears.
        // We don't wait for child.on('close') because run_claude.js may stay
        // alive while the upstream `claude` CLI streams a response; rule §9
        // requires agent_tui.log to surface within 5s.
        function readNewLogPortion() {
            try {
                const stat = fs.statSync(AGENT_LOG);
                if (stat.size > agentLogSizeBefore) {
                    const fd = fs.openSync(AGENT_LOG, 'r');
                    const len = stat.size - agentLogSizeBefore;
                    const buf = Buffer.alloc(len);
                    fs.readSync(fd, buf, 0, len, agentLogSizeBefore);
                    fs.closeSync(fd);
                    return buf.toString('utf8').trim();
                }
            } catch (_) {}
            return '';
        }

        // Poll for new log content. Respond as soon as the prompt header
        // appears (within 5s of spawn). The child keeps running and may
        // append more; subsequent calls observe further log growth.
        const POLL_MS = 100;
        const pollStart = Date.now();
        const poll = setInterval(() => {
            if (settled) {
                clearInterval(poll);
                return;
            }
            const body = readNewLogPortion();
            const elapsed = Date.now() - pollStart;
            if (body.length > 0 && elapsed >= RESPONSE_WAIT_MS) {
                clearInterval(poll);
                settle(200, body);
                return;
            }
            // Safety: don't poll forever
            if (elapsed > TIMEOUT_MS) {
                clearInterval(poll);
                settle(504, 'Request timeout (20 minutes)');
            }
        }, POLL_MS);

        child.on('error', (err) => {
            appendRunLog(`spawn error: ${err.message}`);
            clearInterval(poll);
            settle(500, `Spawn error: ${err.message}`);
        });

        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            if (settled) return;

            // Child exited. Drain any remaining log content and respond.
            const body = readNewLogPortion();
            clearInterval(poll);
            if (code !== 0) {
                appendRunLog(`run_claude exited code=${code} marker=${marker}`);
                settle(500, body || `Exit code: ${code}`);
                return;
            }
            settle(200, body);
        });

        return;
    }

    // ---- Skill Configuration Routes ----
    // Interactive HTML config page
    if (req.method === 'GET' && url.pathname === '/skill/config') {
        try {
            const html = fs.readFileSync(SKILL_UI_HTML, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Skill UI not found');
        }
        return;
    }

    // API: list all skills
    if (req.method === 'GET' && url.pathname === '/skill/api/status') {
        const skills = skillManager.getAllSkillsStatus();
        respondJSON(res, 200, { skills });
        return;
    }

    // API: Clawra-specific status
    if (req.method === 'GET' && url.pathname === '/skill/api/clawra') {
        const status = skillManager.getClawraStatus();
        respondJSON(res, 200, status);
        return;
    }

    // API: configure a skill
    if (req.method === 'POST' && url.pathname === '/skill/api/configure') {
        const body = parseJSONBody(req, (body) => {
            if (!body || !body.name) {
                respondJSON(res, 400, { error: 'Missing skill name' });
                return;
            }
            try {
                const result = skillManager.configureSkill(body.name, body.config || {}, {
                    configSchema: body.configSchema,
                    enabled: body.enabled,
                });
                respondJSON(res, 200, result);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // API: inject skill into identity
    if (req.method === 'POST' && url.pathname === '/skill/api/inject') {
        const body = parseJSONBody(req, (body) => {
            if (!body || !body.name) {
                respondJSON(res, 400, { error: 'Missing skill name' });
                return;
            }
            try {
                const result = skillManager.injectSkillToIdentity(body.name, body.description || `${body.name} skill`);
                respondJSON(res, 200, result);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // API: install skill from git
    if (req.method === 'POST' && url.pathname === '/skill/api/install') {
        const body = parseJSONBody(req, (body) => {
            if (!body || !body.url) {
                respondJSON(res, 400, { error: 'Missing url' });
                return;
            }
            try {
                const result = skillManager.installSkillFromGit(body.url, { as: body.as });
                respondJSON(res, 200, result);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // API: remove skill
    if (req.method === 'POST' && url.pathname === '/skill/api/remove') {
        const body = parseJSONBody(req, (body) => {
            if (!body || !body.name) {
                respondJSON(res, 400, { error: 'Missing skill name' });
                return;
            }
            try {
                const result = skillManager.removeSkill(body.name);
                respondJSON(res, 200, result);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // ---- Console Routes ----
    // Home page → console (wrapped to inject the storyboard library tab)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) {
        try {
            const html = fs.readFileSync(CONSOLE_HTML, 'utf8');
            // Inject the storyboard tab embed just before </body> so
            // master can edit / manage the character / scene / prop library
            // and shot table directly inside the Agent 控制台.
            const embedTag = '<script src="/api/storyboard/console-tab.js"></script>';
            let wrapped = html;
            if (wrapped.includes('</body>')) {
                wrapped = wrapped.replace('</body>', embedTag + '\n</body>');
            } else {
                wrapped = wrapped + embedTag;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(wrapped);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Console UI not found');
        }
        return;
    }

    // API: overall console status
    if (req.method === 'GET' && url.pathname === '/api/comm/status') {
        const status = commManager.getConsoleStatus();
        respondJSON(res, 200, status);
        return;
    }

    // API: list all messages
    if (req.method === 'GET' && url.pathname === '/api/comm/messages') {
        const messages = commManager.getMessages();
        respondJSON(res, 200, { messages });
        return;
    }

    // API: get thread messages
    if (req.method === 'GET' && url.pathname === '/api/comm/thread') {
        const name = url.searchParams.get('name') || 'general';
        const messages = commManager.getThreadMessages(name);
        respondJSON(res, 200, { thread: name, messages });
        return;
    }

    // API: send a message
    if (req.method === 'POST' && url.pathname === '/api/comm/messages') {
        const body = parseJSONBody(req, (body) => {
            if (!body || !body.content) {
                respondJSON(res, 400, { error: 'Missing content' });
                return;
            }
            const msg = commManager.addMessage({
                role: body.role || 'user',
                content: body.content,
                thread: body.thread || 'general',
            });
            respondJSON(res, 200, msg);
        });
        return;
    }

    // API: save mail config (target / endpoint preference)
    if (req.method === 'POST' && url.pathname === '/api/comm/email-config') {
        const body = parseJSONBody(req, (body) => {
            if (!body) {
                respondJSON(res, 400, { error: 'Invalid body' });
                return;
            }
            try {
                // Accept new schema { target, mailEndpoint, fetchLimit, fetchDays, autoReply }
                // and legacy smtp/imap masterEmail fields are ignored (mail skill handles them).
                const mailCfg = {
                    target: body.target || body.masterEmail || '',
                    mailEndpoint: body.mailEndpoint || 'auto',
                    fetchLimit: typeof body.fetchLimit === 'number' ? body.fetchLimit : undefined,
                    fetchDays: typeof body.fetchDays === 'number' ? body.fetchDays : undefined,
                    autoReply: typeof body.autoReply === 'boolean' ? body.autoReply : undefined,
                };
                const cfg = commManager.saveMailSettings(mailCfg);
                respondJSON(res, 200, { saved: true, mail: cfg.mail, mailEndpoint: cfg.mailEndpoint });
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // API: probe mail skill endpoint (connectivity test)
    if (req.method === 'POST' && url.pathname === '/api/comm/mail-probe') {
        commManager.pickMailEndpoint()
            .then(endpoint => respondJSON(res, 200, { endpoint, reachable: !!endpoint }))
            .catch(err => respondJSON(res, 500, { error: err.message }));
        return;
    }

    // API: fetch inbox via mail skill
    if (req.method === 'POST' && url.pathname === '/api/comm/mail-fetch') {
        commManager.fetchInbox({ limit: 10, days: 7 })
            .then(result => respondJSON(res, result.ok ? 200 : 502, result))
            .catch(err => respondJSON(res, 500, { error: err.message }));
        return;
    }

    // API: send a test email via mail skill
    if (req.method === 'POST' && url.pathname === '/api/comm/mail-test') {
        const body = parseJSONBody(req, (body) => {
            const cfg = commManager.getCommConfig();
            const target = (body && body.to) || cfg.mail.target;
            const subject = (body && body.subject) || '[Hermit-Claw] Mail skill 测试';
            const text = (body && body.body) || '这是一封来自 Hermit-Claw 的测试邮件，由 email-sender skill 发出。';
            if (!target) { respondJSON(res, 400, { error: 'Missing mail.target' }); return; }
            commManager.sendMailViaSkill({ to: target, subject, body: text })
                .then(result => respondJSON(res, result.ok ? 200 : 502, result))
                .catch(err => respondJSON(res, 500, { error: err.message }));
        });
        return;
    }

    // API: save schedule
    if (req.method === 'POST' && url.pathname === '/api/comm/schedule') {
        const body = parseJSONBody(req, (body) => {
            if (!body) {
                respondJSON(res, 400, { error: 'Invalid body' });
                return;
            }
            try {
                const cfg = commManager.saveSchedule(body);
                respondJSON(res, 200, { saved: true, schedule: cfg.schedule });
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // API: save work instructions
    if (req.method === 'POST' && url.pathname === '/api/comm/instructions') {
        const body = parseJSONBody(req, (body) => {
            if (!body) {
                respondJSON(res, 400, { error: 'Invalid body' });
                return;
            }
            const cfg = commManager.saveWorkInstructions(body.text || '');
            respondJSON(res, 200, { saved: true, workInstructions: cfg.workInstructions });
        });
        return;
    }

    // API: OOM watch — read cgroup + RSS + heap. Lets master poll after OOM
    // events to confirm container is healthy before next start.
    if (req.method === 'GET' && url.pathname === '/api/comm/oom-watch') {
        let rssKB = 0, vszKB = 0;
        try {
            const status = fs.readFileSync('/proc/self/status', 'utf8');
            const m1 = status.match(/VmRSS:\s+(\d+)/);
            const m2 = status.match(/VmSize:\s+(\d+)/);
            if (m1) rssKB = parseInt(m1[1]);
            if (m2) vszKB = parseInt(m2[1]);
        } catch (_) {}
        let cgroupMax = null, cgroupCurrent = null, cgroupVersion = null;
        try {
            cgroupMax = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()) || null;
            cgroupCurrent = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()) || null;
            cgroupVersion = 'v2';
        } catch (_) {
            try {
                cgroupMax = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim()) || null;
                cgroupCurrent = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim()) || null;
                cgroupVersion = 'v1';
            } catch (_) {}
        }
        const headroomBytes = cgroupMax && cgroupCurrent ? (cgroupMax - cgroupCurrent) : null;
        const heap = process.memoryUsage();
        respondJSON(res, 200, {
            pid: process.pid,
            rssKB, vszKB,
            heap: {
                rssKB: Math.round(heap.rss / 1024),
                heapUsedKB: Math.round(heap.heapUsed / 1024),
                heapTotalKB: Math.round(heap.heapTotal / 1024),
                externalKB: Math.round(heap.external / 1024),
                arrayBuffersKB: Math.round(heap.arrayBuffers / 1024),
            },
            cgroup: cgroupMax ? {
                version: cgroupVersion,
                maxBytes: cgroupMax,
                maxMB: Math.round(cgroupMax / 1024 / 1024),
                currentBytes: cgroupCurrent,
                currentMB: Math.round((cgroupCurrent || 0) / 1024 / 1024),
                headroomBytes,
                headroomMB: headroomBytes !== null ? Math.round(headroomBytes / 1024 / 1024) : null,
                usedPct: cgroupMax && cgroupCurrent ? Math.round((cgroupCurrent / cgroupMax) * 100) : null,
            } : null,
            host: {
                memTotalKB: (() => { try { return parseInt(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemTotal:\s+(\d+)/)[1]); } catch (_) { return null; } })(),
                memAvailKB: (() => { try { return parseInt(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1]); } catch (_) { return null; } })(),
            },
            oomEventLog: (() => { try { return fs.readFileSync(path.join(LOG_DIR, '..', 'logs', 'oom-events.log'), 'utf8'); } catch (_) { return null; } })(),
        });
        return;
    }

    // API: run workflow now
    if (req.method === 'POST' && url.pathname === '/api/comm/run-now') {
        commManager.runWorkflow()
            .then(result => respondJSON(res, 200, result))
            .catch(err => respondJSON(res, 500, { error: err.message }));
        return;
    }

    // API: list reports
    if (req.method === 'GET' && url.pathname === '/api/comm/reports') {
        const reports = commManager.getReports();
        respondJSON(res, 200, { reports });
        return;
    }

    // ---- Studio routes (mounted from lib/studio/mount.js, same port 8082) ----
    if (url.pathname === '/studio' || url.pathname.startsWith('/api/studio/')) {
        Promise.resolve(studioMount.handle(req, res, url))
            .then((handled) => {
                if (!handled && !res.headersSent) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                }
            })
            .catch((e) => {
                appendRunLog(`studio mount error: ${e.message}`, { always: true });
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('studio error');
                }
            });
        return;
    }

    // ---- Storyboard routes (mounted from lib/storyboard/mount.js, same port 8082) ----
    if (url.pathname === '/studio/storyboard' || url.pathname.startsWith('/api/storyboard/')) {
        Promise.resolve(storyboardMount.handle(req, res, url))
            .then((handled) => {
                if (!handled && !res.headersSent) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                }
            })
            .catch((e) => {
                appendRunLog(`storyboard mount error: ${e.message}`, { always: true });
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('storyboard error');
                }
            });
        return;
    }

    // ---- H3 video generation routes ----
    // GET  /h3/health              — local H3 client status
    // POST /h3/videos              — create a t2va/i2va/fl2va/l2va/ref2va job
    // GET  /h3/videos/:id          — poll status
    // GET  /h3/videos/:id/download — download MP4
    if (req.method === 'GET' && url.pathname === '/h3/health') {
        respondJSON(res, 200, {
            ok: true,
            apiBase: h3Client.DEFAULT_BASE,
            apiKeySet: Boolean(process.env.H3_API_KEY),
            tasks: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'],
        });
        return;
    }
    if (req.method === 'POST' && url.pathname === '/h3/videos') {
        parseJSONBody(req, async (body) => {
            if (!body) {
                respondJSON(res, 400, { error: 'JSON body required' });
                return;
            }
            try {
                const result = await h3Client.createVideo(body, process.env.H3_API_KEY);
                respondJSON(res, 200, result);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/h3/videos/')) {
        const rest = url.pathname.slice('/h3/videos/'.length);
        const m = rest.match(/^([^/]+)(\/download)?$/);
        if (!m) {
            respondJSON(res, 400, { error: 'Invalid path' });
            return;
        }
        const id = decodeURIComponent(m[1]);
        const wantsDownload = Boolean(m[2]);
        (async () => {
            try {
                if (wantsDownload) {
                    const out = path.join(PROJECT_DIR, 'outputs', `${id}.mp4`);
                    await h3Client.downloadVideo(id, out, process.env.H3_API_KEY);
                    res.writeHead(200, { 'Content-Type': 'video/mp4' });
                    fs.createReadStream(out).pipe(res);
                } else {
                    const status = await h3Client.getVideo(id, process.env.H3_API_KEY);
                    respondJSON(res, 200, status);
                }
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        })();
        return;
    }

    // ---- 404 ----
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
});

// ---- JSON response helper ----
function respondJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data) + '\n');
}

// ---- POST body parser (JSON only) ----
function parseJSONBody(req, cb) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        try {
            cb(JSON.parse(raw));
        } catch (e) {
            cb(null);
        }
    });
}

server.listen(PORT, '0.0.0.0', () => {
    appendRunLog(`Claude Ask Server listening on port ${PORT}`);
});

// ---- Crash safety net ----
// Prevent a single unhandled error from killing the whole server (which was
// the OOM trigger when the hourly workflow hit a transient fetch failure).
process.on('uncaughtException', (err) => {
    appendRunLog(`uncaughtException: ${err.message}`, { always: true });
});
process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    appendRunLog(`unhandledRejection: ${msg}`, { always: true });
});

// ---- Hourly Workflow Scheduler ----
// Polls the comm config every 60 seconds. When `now - lastRun >= intervalHours`,
// it triggers runWorkflow(). Default intervalHours=1 (hourly tick).
function scheduleTick() {
    try {
        const cfg = commManager.getCommConfig();
        const sched = cfg.schedule;
        if (!sched || !sched.enabled) return;

        const now = Date.now();
        const lastRun = sched.lastRun ? new Date(sched.lastRun).getTime() : 0;
        const intervalMs = (sched.intervalHours || 1) * 3600 * 1000;

        if (now - lastRun >= intervalMs) {
            appendRunLog(`scheduler: triggering workflow (lastRun=${sched.lastRun})`, { always: true });
            commManager.runWorkflow()
                .then(result => {
                    appendRunLog(`scheduler: workflow done, report=${result.report.id}, actionable=${result.actionable}, replies=${result.repliesToAgent || 0}`, { always: true });
                })
                .catch(err => {
                    appendRunLog(`scheduler: workflow error: ${err.message}`, { always: true });
                });
        }
    } catch (e) {
        appendRunLog(`scheduler: tick error: ${e.message}`);
    }
}

// Run every 60 seconds
const SCHEDULER_INTERVAL_MS = 60 * 1000;
setInterval(scheduleTick, SCHEDULER_INTERVAL_MS);
appendRunLog('scheduler: hourly workflow scheduler started (intervalHours=1 default)');