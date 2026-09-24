// studio/server.js
// Independent HTTP server for /api/studio/* and the /studio console page.
// Listens on STUDIO_PORT (default 8088) so we don't risk touching
// the existing 8082 server (which has the OOM-sensitive comm pipeline).
//
// Run with:  node lib/studio/server.js
// Or from server.js: const studioServer = require('./lib/studio/server');
// (we keep this file self-contained for simpler boot.)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const studio = require('./index');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const ASSETS_DIR = path.join(PROJECT_DIR, 'studio-assets');
const CONSOLE_HTML = path.join(__dirname, 'studio.html');
const STUDIO_PORT = parseInt(process.env.STUDIO_PORT || '8088', 10);
const HOST = '0.0.0.0';

function respondJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data) + '\n');
}

function parseJSONBody(req, cb) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        try { cb(JSON.parse(raw)); }
        catch (_) { cb(null); }
    });
}

function mimeFor(file) {
    const ext = path.extname(file).toLowerCase();
    return {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
        '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
    }[ext] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${STUDIO_PORT}`);
    res.setTimeout(30 * 1000);

    // Health
    if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // Console HTML
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/studio')) {
        try {
            const html = fs.readFileSync(CONSOLE_HTML, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Studio console missing: ' + e.message);
        }
        return;
    }

    // Asset streaming (no full read into memory)
    if (req.method === 'GET' && url.pathname.startsWith('/api/studio/asset/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/studio/asset/'.length));
        if (name.includes('/') || name.includes('..')) {
            res.writeHead(400); res.end('bad name'); return;
        }
        const fp = path.join(ASSETS_DIR, name);
        if (!fp.startsWith(ASSETS_DIR) || !fs.existsSync(fp)) {
            res.writeHead(404); res.end('not found: ' + fp + ' (assets=' + ASSETS_DIR + ')'); return;
        }
        const st = fs.statSync(fp);
        if (st.size > 25 * 1024 * 1024) {
            res.writeHead(413); res.end('too large'); return;
        }
        res.writeHead(200, { 'Content-Type': mimeFor(fp), 'Content-Length': st.size });
        fs.createReadStream(fp).pipe(res);
        return;
    }

    // GET /api/studio/status
    if (req.method === 'GET' && url.pathname === '/api/studio/status') {
        try {
            const s = await studio.status();
            respondJSON(res, 200, s);
        } catch (e) { respondJSON(res, 500, { error: e.message }); }
        return;
    }

    // POST /api/studio/discover  → refresh provider registry
    if (req.method === 'POST' && url.pathname === '/api/studio/discover') {
        try {
            const list = await studio.providers.refreshAll();
            respondJSON(res, 200, { providers: list });
        } catch (e) { respondJSON(res, 500, { error: e.message }); }
        return;
    }

    // POST /api/studio/run  { instruction: "!poster 主题", mail: true }
    if (req.method === 'POST' && url.pathname === '/api/studio/run') {
        parseJSONBody(req, async (body) => {
            const instruction = body && (body.instruction || body.text || body.args);
            if (!instruction) {
                respondJSON(res, 400, { error: 'instruction required (e.g. "!poster 主题")' });
                return;
            }
            try {
                const result = await studio.runInstruction({
                    verb: body.verb,
                    args: instruction,
                    mail: !!body.mail,
                });
                respondJSON(res, result.ok ? 200 : 502, result);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return;
    }

    // GET /api/studio/works
    if (req.method === 'GET' && url.pathname === '/api/studio/works') {
        const limit = parseInt(url.searchParams.get('limit') || '30', 10);
        respondJSON(res, 200, { works: studio.composers.listWorks({ limit }) });
        return;
    }

    // GET /api/studio/works/:id
    if (req.method === 'GET' && url.pathname.startsWith('/api/studio/works/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/studio/works/'.length));
        const w = studio.composers.getWork(id);
        if (!w) { respondJSON(res, 404, { error: 'not found' }); return; }
        respondJSON(res, 200, w);
        return;
    }

    // GET /api/studio/characters
    if (req.method === 'GET' && url.pathname === '/api/studio/characters') {
        respondJSON(res, 200, { characters: studio.characters.list() });
        return;
    }

    // POST /api/studio/characters/ensure { role, theme }
    if (req.method === 'POST' && url.pathname === '/api/studio/characters/ensure') {
        parseJSONBody(req, async (body) => {
            if (!body) { respondJSON(res, 400, { error: 'invalid body' }); return; }
            try {
                const r = await studio.characters.ensure({
                    role: body.role || 'agent',
                    theme: body.theme || '',
                    style: body.style,
                    palette: body.palette,
                });
                respondJSON(res, r.ok ? 200 : 502, r);
            } catch (e) { respondJSON(res, 500, { error: e.message }); }
        });
        return;
    }

    // GET /api/studio/persona-prompt
    if (req.method === 'GET' && url.pathname === '/api/studio/persona-prompt') {
        respondJSON(res, 200, { addon: studio.persona.getSystemPromptAddon(), directives: studio.persona.list({ limit: 20 }) });
        return;
    }

    // POST /api/studio/persona/learn { source, text, id }
    if (req.method === 'POST' && url.pathname === '/api/studio/persona/learn') {
        parseJSONBody(req, (body) => {
            if (!body || !body.text) { respondJSON(res, 400, { error: 'text required' }); return; }
            const r = studio.persona.learnFromMessage({
                source: body.source || 'manual',
                text: body.text,
                id: body.id,
            });
            respondJSON(res, 200, r);
        });
        return;
    }

    // POST /api/studio/persona/clear
    if (req.method === 'POST' && url.pathname === '/api/studio/persona/clear') {
        respondJSON(res, 200, studio.persona.clear());
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

process.on('uncaughtException', (err) => {
    try { fs.appendFileSync(path.join(PROJECT_DIR, 'logs', 'studio.log'), `[${new Date().toISOString()}] uncaughtException: ${err.message}\n`); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    try { fs.appendFileSync(path.join(PROJECT_DIR, 'logs', 'studio.log'), `[${new Date().toISOString()}] unhandledRejection: ${msg}\n`); } catch (_) {}
});

(async () => {
    await studio.init();
    server.listen(STUDIO_PORT, HOST, () => {
        try { fs.appendFileSync(path.join(PROJECT_DIR, 'logs', 'studio.log'), `[${new Date().toISOString()}] studio server listening on ${STUDIO_PORT}\n`); } catch (_) {}
        // eslint-disable-next-line no-console
        console.log(`[studio] http://${HOST}:${STUDIO_PORT}/studio`);
    });
})();