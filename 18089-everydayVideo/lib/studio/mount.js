// studio/mount.js
// Mountable route handlers for /api/studio/* and /studio. Returns true
// when it handled the request, false otherwise. Designed to plug into
// the existing 8082 server without spinning up a separate process.

const fs = require('fs');
const path = require('path');
const studio = require('./index');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const ASSETS_DIR = path.join(PROJECT_DIR, 'studio-assets');
const CONSOLE_HTML = path.join(__dirname, 'studio.html');

function respondJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data) + '\n');
}

function parseJSONBody(req, cb) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        try {
            cb(raw ? JSON.parse(raw) : null);
        } catch (_) {
            cb(null);
        }
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

async function handle(req, res, url) {
    // Studio console HTML
    if (req.method === 'GET' && url.pathname === '/studio') {
        try {
            const html = fs.readFileSync(CONSOLE_HTML, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Studio console missing: ' + e.message);
        }
        return true;
    }

    // Asset streaming
    if (req.method === 'GET' && url.pathname.startsWith('/api/studio/asset/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/studio/asset/'.length));
        if (name.includes('/') || name.includes('..')) {
            res.writeHead(400); res.end('bad name'); return true;
        }
        const fp = path.join(ASSETS_DIR, name);
        if (!fp.startsWith(ASSETS_DIR) || !fs.existsSync(fp)) {
            res.writeHead(404); res.end('not found'); return true;
        }
        const st = fs.statSync(fp);
        if (st.size > 25 * 1024 * 1024) {
            res.writeHead(413); res.end('too large'); return true;
        }
        res.writeHead(200, { 'Content-Type': mimeFor(fp), 'Content-Length': st.size });
        fs.createReadStream(fp).pipe(res);
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/studio/status') {
        try {
            const s = await studio.status();
            respondJSON(res, 200, s);
        } catch (e) { respondJSON(res, 500, { error: e.message }); }
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/studio/discover') {
        try {
            const list = await studio.providers.refreshAll();
            respondJSON(res, 200, { providers: list });
        } catch (e) { respondJSON(res, 500, { error: e.message }); }
        return true;
    }

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
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/studio/works') {
        const limit = parseInt(url.searchParams.get('limit') || '30', 10);
        respondJSON(res, 200, { works: studio.composers.listWorks({ limit }) });
        return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/studio/works/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/studio/works/'.length));
        const w = studio.composers.getWork(id);
        if (!w) { respondJSON(res, 404, { error: 'not found' }); return true; }
        respondJSON(res, 200, w);
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/studio/characters') {
        respondJSON(res, 200, { characters: studio.characters.list() });
        return true;
    }

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
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/studio/persona-prompt') {
        respondJSON(res, 200, { addon: studio.persona.getSystemPromptAddon(), directives: studio.persona.list({ limit: 20 }) });
        return true;
    }

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
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/studio/persona/clear') {
        respondJSON(res, 200, studio.persona.clear());
        return true;
    }

    return false;
}

module.exports = { handle, ASSETS_DIR, CONSOLE_HTML };