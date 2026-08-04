// Comm Manager
// Communication & collaboration hub: message board, mail-via-skill, work reports.
// Email is delegated to the email MCP service (Tools 知识库 at host.docker.internal:18081 →
// → email service on port 18001, preferred; localhost:18001 fallback). We do NOT ask the
// user to fill SMTP/IMAP — the skill handles it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const COMM_CONFIG = path.join(CONFIG_DIR, 'comm.json');
const MESSAGES_FILE = path.join(CONFIG_DIR, 'messages.json');
const REPORTS_FILE = path.join(CONFIG_DIR, 'reports.json');

// email MCP endpoints (preferred: host.docker.internal, fallback: localhost).
// Discovered via Tools 知识库 at http://host.docker.internal:18081/api/tools ("email" → port 18001).
const MAIL_API_PREFERRED = 'http://host.docker.internal:18001';
const MAIL_API_LOCAL = 'http://localhost:18001';

// ---------- helpers ----------

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) { /* corrupt, fall back */ }
    return fallback;
}

function writeJSON(file, data) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function nowISO() {
    return new Date().toISOString();
}

function uid() {
    return crypto.randomBytes(6).toString('hex');
}

// UUID used to identify an email round-trip. Master copies this back in replies
// so the agent can pair "I sent this" with "Master replied to this".
function newMailUUID() {
    return `HC-${crypto.randomBytes(8).toString('hex')}`;
}

// Insert / refresh the [HC-uuid] token in subject. Master references this when
// replying so we can recognize "this is a reply to MY outgoing email".
function tagSubject(subject, uuid) {
    const clean = (subject || '').replace(/\s*\[HC-[0-9a-f]{16}\]\s*/g, '').trim();
    return clean ? `${clean} [${uuid}]` : `[${uuid}]`;
}

// Extract a [HC-<hex>] token from a subject or body if present.
function extractMailUUID(text) {
    if (!text) return null;
    const m = String(text).match(/\[HC-([0-9a-f]{16})\]/);
    return m ? `HC-${m[1]}` : null;
}

// Append UUID + token to body so even subject-only clients can find it.
function tagBody(body, uuid) {
    const token = `\n\n[mail-uuid: ${uuid}]\n`;
    if (body && body.includes(`[mail-uuid: ${uuid}]`)) return body;
    return (body || '') + token;
}

// Lightweight runlog. Throttled: skips writes if last write was < 5s ago AND
// the line is a routine heartbeat. This keeps logs/ from blowing up under
// hourly ticks + retries (which was the OOM trigger).
let _lastRunLogAt = 0;
function appendRunLog(line, { always = false } = {}) {
    const now = Date.now();
    if (!always && now - _lastRunLogAt < 5000) return;
    _lastRunLogAt = now;
    try {
        const logDir = path.join(PROJECT_DIR, 'logs');
        ensureDir(logDir);
        fs.appendFileSync(path.join(logDir, 'run.log'), `[${nowISO()}] ${line}\n`);
    } catch (_) {}
}

// ---------- Mail client (email-sender skill) ----------

async function httpJSON(method, url, body, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const opts = { method, signal: ctrl.signal, headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        return { ok: false, status: 0, data: null, error: e.message };
    } finally {
        clearTimeout(t);
    }
}

// Try preferred, then local. Return first reachable endpoint or null.
async function pickMailEndpoint() {
    for (const url of [MAIL_API_PREFERRED, MAIL_API_LOCAL]) {
        const r = await httpJSON('GET', `${url}/`, null, 1500);
        if (r.ok) return url;
    }
    return null;
}

async function fetchInbox({ limit = 20, days = 1 } = {}) {
    const endpoint = await pickMailEndpoint();
    if (!endpoint) {
        return { ok: false, endpoint: null, emails: [], error: 'mail skill unreachable' };
    }
    const r = await httpJSON('GET', `${endpoint}/emails/?limit=${limit}&days=${days}`);
    if (!r.ok) return { ok: false, endpoint, emails: [], error: `HTTP ${r.status}` };
    return { ok: true, endpoint, emails: r.data || [] };
}

// Send mail via the email MCP. Each outgoing message gets a [HC-<uuid>] token
// in the subject AND body so Master can quote it back to identify a reply.
// The UUID is also returned in the response so callers can persist it.
async function sendMailViaSkill({ to, subject, body, attachments = [], uuid }) {
    if (!to) return { ok: false, error: 'Missing to' };
    const endpoint = await pickMailEndpoint();
    if (!endpoint) {
        appendRunLog(`mail: skill unreachable, dropping send to=${to}`, { always: true });
        return { ok: false, error: 'mail skill unreachable' };
    }
    const mailUUID = uuid || newMailUUID();
    const taggedSubject = tagSubject(subject, mailUUID);
    const taggedBody = tagBody(body, mailUUID);
    const r = await httpJSON('POST', `${endpoint}/send-email/`, {
        to, subject: taggedSubject, body: taggedBody, attachments,
    });
    if (!r.ok) {
        appendRunLog(`mail: send failed to=${to} status=${r.status}`, { always: true });
        return { ok: false, status: r.status, error: r.error || 'send failed', uuid: mailUUID };
    }
    appendRunLog(`mail: sent uuid=${mailUUID} to=${to}`);
    return { ok: true, endpoint, status: r.status, data: r.data, uuid: mailUUID };
}

// ---------- Comm Config (mail target, schedule, instructions) ----------

function getCommConfig() {
    const defaults = {
        mail: {
            target: '',          // where to send reports (master email)
            autoReply: true,     // auto-reply to inbox messages
            fetchLimit: 20,
            fetchDays: 1,        // last day only — fast poll, hourly tick
        },
        mailEndpoint: 'auto',  // 'auto' | 'remote' | 'local'
        mailEndpointResolved: null, // last resolved endpoint
        schedule: {
            enabled: true,
            intervalHours: 1,    // hourly tick — Master can reply between cycles
            timeOfDay: null,     // unused when intervalHours is set
            lastRun: null,
            nextRun: null,
        },
        workInstructions: '',
        createdAt: null,
        updatedAt: null,
    };
    const raw = readJSON(COMM_CONFIG, defaults);
    // Backfill defaults for fields missing on legacy / partial files.
    if (!raw.mail || typeof raw.mail !== 'object') raw.mail = { ...defaults.mail };
    if (typeof raw.mailEndpoint !== 'string') raw.mailEndpoint = defaults.mailEndpoint;
    if (!raw.schedule || typeof raw.schedule !== 'object') raw.schedule = { ...defaults.schedule };
    // Drop legacy 'email' / 'secretsConfigured' keys if they sneak in.
    delete raw.email;
    delete raw.secretsConfigured;
    return raw;
}

function saveCommConfig(cfg) {
    cfg.updatedAt = nowISO();
    if (!cfg.createdAt) cfg.createdAt = nowISO();
    writeJSON(COMM_CONFIG, cfg);
    return cfg;
}

function saveMailSettings(mailCfg) {
    const cfg = getCommConfig();
    cfg.mail = { ...cfg.mail, ...mailCfg };
    if (mailCfg.mailEndpoint) cfg.mailEndpoint = mailCfg.mailEndpoint;
    return saveCommConfig(cfg);
}

function saveSchedule(schedule) {
    const cfg = getCommConfig();
    cfg.schedule = { ...cfg.schedule, ...schedule };
    cfg.schedule.nextRun = computeNextRun(cfg.schedule);
    return saveCommConfig(cfg);
}

function saveWorkInstructions(text) {
    const cfg = getCommConfig();
    cfg.workInstructions = text;
    return saveCommConfig(cfg);
}

function computeNextRun(schedule) {
    const base = schedule.lastRun ? new Date(schedule.lastRun) : new Date();
    const intervalMs = (schedule.intervalHours || 24) * 3600 * 1000;
    return new Date(base.getTime() + intervalMs).toISOString();
}

// ---------- Message Board ----------

function getMessages() {
    return readJSON(MESSAGES_FILE, { messages: [] }).messages || [];
}

function addMessage({ role, content, thread = 'general', meta = {} }) {
    const data = readJSON(MESSAGES_FILE, { messages: [] });
    const msg = {
        id: uid(),
        role, // 'user' | 'agent' | 'system'
        content,
        thread,
        meta,
        timestamp: nowISO(),
    };
    data.messages.push(msg);
    writeJSON(MESSAGES_FILE, data);
    return msg;
}

function getThreads() {
    const msgs = getMessages();
    const threads = {};
    for (const m of msgs) {
        if (!threads[m.thread]) threads[m.thread] = { thread: m.thread, count: 0, lastAt: null };
        threads[m.thread].count++;
        threads[m.thread].lastAt = m.timestamp;
    }
    return Object.values(threads).sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
}

function getThreadMessages(thread) {
    return getMessages().filter(m => m.thread === thread);
}

function markMessagesProcessed(ids) {
    if (!ids || ids.length === 0) return;
    const data = readJSON(MESSAGES_FILE, { messages: [] });
    const idSet = new Set(ids);
    data.messages = data.messages.map(m => idSet.has(m.id) ? { ...m, processed: true } : m);
    writeJSON(MESSAGES_FILE, data);
}

// ---------- Work Reports ----------

function getReports() {
    return readJSON(REPORTS_FILE, { reports: [] }).reports || [];
}

function addReport({ title, content, type = 'daily', metadata = {} }) {
    const data = readJSON(REPORTS_FILE, { reports: [] });
    const report = {
        id: uid(),
        title,
        content,
        type,
        metadata,
        timestamp: nowISO(),
    };
    data.reports.push(report);
    writeJSON(REPORTS_FILE, data);
    return report;
}

function getReport(id) {
    return getReports().find(r => r.id === id) || null;
}

function deleteReport(id) {
    const data = readJSON(REPORTS_FILE, { reports: [] });
    data.reports = data.reports.filter(r => r.id !== id);
    writeJSON(REPORTS_FILE, data);
    return { deleted: true };
}

// ---------- Workflow Engine (hourly tick) ----------
//
// 1. Pull inbox via email MCP (last 1 day, light fetch).
// 2. Ingest new emails as message-board entries (thread=email-inbox).
//    Pair each entry with a [HC-uuid] token if Master is replying to a
//    previously-sent report.
// 3. Aggregate actionable items (board + email).
// 4. Produce report. Tag it with a fresh [HC-uuid] so Master can reply to it.
// 5. Send report via MCP if mail.target is set.
// 6. Mark processed, update lastRun / nextRun.
async function runWorkflow() {
    const cfg = getCommConfig();
    const startedAt = nowISO();
    const log = [];

    log.push(`[${startedAt}] Workflow tick`);
    log.push(`- Mail target: ${cfg.mail.target || '(not set)'}`);
    log.push(`- Work instructions: ${cfg.workInstructions ? cfg.workInstructions.slice(0, 80) + (cfg.workInstructions.length > 80 ? '...' : '') : '(none)'}`);

    // Step 1: pull inbox via MCP
    const inboxResult = await fetchInbox({ limit: cfg.mail.fetchLimit, days: cfg.mail.fetchDays });
    cfg.mailEndpointResolved = inboxResult.endpoint;
    saveCommConfig(cfg);

    let newEmails = [];
    let repliesToAgent = 0;
    if (inboxResult.ok) {
        log.push(`- Mail skill: ${inboxResult.endpoint} (inbox=${inboxResult.emails.length})`);
        const seen = new Set(getMessages().filter(m => m.meta && m.meta.emailId).map(m => m.meta.emailId));
        for (const e of inboxResult.emails) {
            if (seen.has(e.id)) continue;
            // Detect if this email is a reply to one of OUR outgoing messages.
            const replyUUID = extractMailUUID(e.subject) || extractMailUUID(e.body);
            if (replyUUID) repliesToAgent++;
            addMessage({
                role: 'user',
                thread: 'email-inbox',
                content: `From: ${e.sender}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body || ''}`,
                meta: {
                    emailId: e.id,
                    sender: e.sender,
                    subject: e.subject,
                    date: e.date,
                    replyToUUID: replyUUID || null,
                    isMasterReply: !!replyUUID,
                },
            });
            newEmails.push({ source: 'email', id: e.id, content: e.subject || e.body || '' });
        }
        log.push(`- New emails ingested: ${newEmails.length} (replies to agent: ${repliesToAgent})`);
    } else {
        log.push(`- Mail skill unreachable: ${inboxResult.error || 'unknown'}`);
    }

    // Step 2: gather pending board items
    const allMsgs = getMessages();
    const pending = allMsgs.filter(m => m.role === 'user' && !m.processed);
    log.push(`- Pending user messages (total incl. email): ${pending.length}`);

    // Step 3: actionable items
    const actionable = [
        ...pending.map(m => ({
            source: m.meta && m.meta.emailId ? 'email' : 'message-board',
            id: m.id,
            content: m.content,
            replyToUUID: m.meta && m.meta.replyToUUID,
            isMasterReply: !!(m.meta && m.meta.isMasterReply),
        })),
    ];
    log.push(`- Actionable items: ${actionable.length}`);

    // Step 4: build report. Subject uses today's date; body still lists items.
    const reportUUID = newMailUUID();
    const reportLines = [
        `# Work Report — ${startedAt.slice(0, 10)} ${startedAt.slice(11, 19)}`,
        ``,
        `**Started:** ${startedAt}`,
        `**Mail endpoint:** ${cfg.mailEndpointResolved || 'unreachable'}`,
        `**Report UUID:** ${reportUUID}`,
        `**Actionable items:** ${actionable.length}`,
        `**Master replies in this cycle:** ${repliesToAgent}`,
        ``,
        `## Work Log`,
        ...log.map(l => `- ${l}`),
        ``,
        actionable.length
            ? `## Actionable Items\n\n${actionable.map((a, i) => `${i + 1}. [${a.source}]${a.isMasterReply ? ` (reply-to ${a.replyToUUID})` : ''} ${a.content}`).join('\n')}`
            : `## No actionable items\n\nNothing to do this cycle. Waiting for new instructions.`,
        ``,
        `## Reply Token`,
        `要回复这条报告，请把 \`[HC-${reportUUID.slice(3)}]\` 放进邮件主题（subject）或正文首行。`,
    ];

    const reportContent = reportLines.join('\n');
    const report = addReport({
        title: `Work Report ${startedAt.slice(0, 10)} ${startedAt.slice(11, 19)}`,
        content: reportContent,
        type: 'hourly',
        metadata: {
            actionable: actionable.length,
            newEmails: newEmails.length,
            repliesToAgent,
            pending: pending.length,
            endpoint: cfg.mailEndpointResolved,
            reportUUID,
        },
    });
    log.push(`- Report created: ${report.id} (uuid=${reportUUID})`);

    // Step 5: mark processed
    markMessagesProcessed(pending.map(m => m.id));

    // Step 6: send via MCP (if target configured). sendMailViaSkill auto-tags
    // the outgoing subject with the reportUUID so Master can reply to it.
    let mailResult = { ok: false, skipped: true };
    if (cfg.mail.target) {
        mailResult = await sendMailViaSkill({
            to: cfg.mail.target,
            subject: `[Hermit-Claw] ${report.title}`,
            body: reportContent,
            uuid: reportUUID,
        });
        if (mailResult.ok) {
            addMessage({
                role: 'agent',
                thread: 'email-outbox',
                content: `To: ${cfg.mail.target}\nSubject: ${report.title}\nUUID: ${reportUUID}\n\n(已通过 mail-sender MCP 发送)`,
                meta: { reportId: report.id, endpoint: mailResult.endpoint, target: cfg.mail.target, uuid: reportUUID },
            });
        }
        log.push(`- Email sent: ${mailResult.ok ? 'YES' : 'FAILED'} ${mailResult.error || ''}`);
    } else {
        log.push(`- Email send skipped (no mail.target configured)`);
    }

    // Update schedule
    cfg.schedule.lastRun = nowISO();
    cfg.schedule.nextRun = computeNextRun(cfg.schedule);
    saveCommConfig(cfg);

    appendRunLog(`workflow: actionable=${actionable.length} replies=${repliesToAgent} mail=${mailResult.ok ? 'sent' : 'skipped'} uuid=${reportUUID}`);

    return { startedAt, report, log, actionable: actionable.length, mailResult, endpoint: cfg.mailEndpointResolved, reportUUID, repliesToAgent };
}

// ---------- Overall status for the console ----------

function getConsoleStatus() {
    const cfg = getCommConfig();
    const reports = getReports();
    const messages = getMessages();
    const threads = getThreads();

    return {
        server: { port: 8082, health: 'ok' },
        mail: cfg.mail,
        mailEndpoint: cfg.mailEndpoint,
        mailEndpointResolved: cfg.mailEndpointResolved,
        mailSkill: {
            preferred: MAIL_API_PREFERRED,
            local: MAIL_API_LOCAL,
        },
        schedule: cfg.schedule,
        workInstructions: cfg.workInstructions,
        messages: {
            total: messages.length,
            unprocessed: messages.filter(m => m.role === 'user' && !m.processed).length,
            threads,
        },
        reports: {
            total: reports.length,
            latest: reports[reports.length - 1] || null,
        },
        nextRun: cfg.schedule.nextRun,
        lastRun: cfg.schedule.lastRun,
        serverTime: nowISO(),
    };
}

module.exports = {
    getCommConfig,
    saveCommConfig,
    saveMailSettings,
    saveSchedule,
    saveWorkInstructions,
    getMessages,
    addMessage,
    getThreads,
    getThreadMessages,
    markMessagesProcessed,
    getReports,
    addReport,
    getReport,
    deleteReport,
    runWorkflow,
    getConsoleStatus,
    fetchInbox,
    sendMailViaSkill,
    pickMailEndpoint,
    computeNextRun,
};