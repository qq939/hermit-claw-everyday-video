// storyboard/mount.js
// Mountable HTTP routes for the storyboard subsystem. Designed to
// plug into the existing 8082 server via the same promise wrapper
// pattern used by lib/studio/mount.js.
//
// Routes:
//   GET    /studio/storyboard                       -> storyboard HTML
//   GET    /api/storyboard/state                    -> everything in one shot
//   POST   /api/storyboard/items                    -> create item
//   PATCH  /api/storyboard/items/:id                -> update item
//   DELETE /api/storyboard/items/:id                -> delete item
//   POST   /api/storyboard/items/:id/versions       -> branch new version
//   POST   /api/storyboard/items/:id/set-current    -> pick a version
//                                                    -> later versions dropped
//   POST   /api/storyboard/upload                   -> multipart image upload
//                                                    (returns { path, url, kind:'upload' })
//   GET    /api/storyboard/obs/list                 -> list files in OBS bucket
//   POST   /api/storyboard/obs/fetch                -> import OBS file -> local
//   POST   /api/storyboard/auto-render              -> ask fal.ai for an image
//                                                    (uses FAL_KEY)
//   GET    /api/storyboard/asset/*                  -> stream an asset (uploads etc.)
//   POST   /api/storyboard/shots                    -> create shot
//   PATCH  /api/storyboard/shots/:id                -> edit shot
//   DELETE /api/storyboard/shots/:id                -> delete shot
//   POST   /api/storyboard/shots/reorder            -> reorder shots
//   POST   /api/storyboard/shots/:id/add            -> add version to shot
//   POST   /api/storyboard/shots/:id/remove         -> remove version from shot
//   GET    /api/storyboard/config                   -> get storyboard.json
//   POST   /api/storyboard/config                   -> update storyboard.json
//   POST   /api/storyboard/export-pdf               -> render PDF + upload to OBS
//   GET    /api/storyboard/exports/:key             -> download a past export

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib');
const { renderStoryboardPdf } = require('./pdf');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HTML_PATH = path.join(__dirname, 'storyboard.html');

function respondJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data) + '\n');
}

function parseJSONBody(req, cb) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 8 * 1024 * 1024) { req.destroy(); } });
    req.on('end', () => {
        try { cb(raw ? JSON.parse(raw) : null); }
        catch (_) { cb(null); }
    });
    req.on('error', () => cb(null));
}

// ----- tiny multipart parser (no deps) -----

function parseMultipart(req, boundary, cb) {
    const bufs = [];
    let total = 0;
    const LIMIT = 20 * 1024 * 1024; // 20MB per upload — same cap as studio
    req.on('data', (chunk) => {
        bufs.push(chunk);
        total += chunk.length;
        if (total > LIMIT) { req.destroy(); }
    });
    req.on('end', () => {
        try {
            const body = Buffer.concat(bufs);
            const sep = Buffer.from(`--${boundary}\r\n`, 'utf8');
            const parts = [];
            let start = 0;
            while (true) {
                const idx = body.indexOf(sep, start);
                if (idx < 0) break;
                const partStart = idx + sep.length;
                const nextSep = body.indexOf(sep, partStart);
                const partEnd = nextSep < 0 ? body.length : nextSep;
                parts.push(body.slice(partStart, partEnd));
                if (nextSep < 0) break;
                start = nextSep;
            }
            const fields = {};
            const files = {};
            for (const p of parts) {
                const headerEnd = p.indexOf('\r\n\r\n');
                if (headerEnd < 0) continue;
                const headerBuf = p.slice(0, headerEnd).toString('utf8');
                const data = p.slice(headerEnd + 4, p.length - 2); // strip trailing \r\n
                const dispMatch = headerBuf.match(/Content-Disposition:.*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
                if (!dispMatch) continue;
                const name = dispMatch[1];
                const filename = dispMatch[2];
                if (filename) {
                    const ctMatch = headerBuf.match(/Content-Type:\s*([^\r\n]+)/i);
                    files[name] = { filename, contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data };
                } else {
                    fields[name] = data.toString('utf8');
                }
            }
            cb(null, { fields, files });
        } catch (e) {
            cb(e);
        }
    });
    req.on('error', (e) => cb(e));
}

// ----- OBS client -----
//
// Targets the obs.dimond.top / obs2.dimond.top FastAPI service (per
// master's instruction). Protocol (from /openapi.json):
//   POST   /                       multipart form, field "file", filename in form
//   GET    /{filename}             download (public)
//   DELETE /{filename}             delete
//   PUT    /{filename}             alt upload (raw body)
// No list endpoint — picker falls back to "paste a filename / URL".

function _obsBase() {
    const cfg = lib.getConfig();
    return (cfg.obsEndpoint || '').replace(/\/$/, '');
}

function _obsAuthHeader() {
    const cfg = lib.getConfig();
    return cfg.obsApiKey ? { Authorization: `Bearer ${cfg.obsApiKey}` } : {};
}

async function obsList(prefix) {
    // The dimond OBS has no list endpoint. We try a small set of common
    // paths anyway so a custom-mirror install (e.g. an S3-compatible
    // gateway) can still work; if none work, surface a helpful error.
    const cfg = lib.getConfig();
    if (!cfg.obsEndpoint) return { ok: false, error: 'obsEndpoint not configured' };
    const base = _obsBase();
    const bucket = cfg.obsBucket || 'hermit-claw';
    const candidates = [
        `${base}/api/list?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix || '')}`,
        `${base}/list?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix || '')}`,
        `${base}/v1/objects?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix || '')}`,
        `${base}/${encodeURIComponent(bucket)}?list-type=2&prefix=${encodeURIComponent(prefix || '')}`,
    ];
    for (const url of candidates) {
        try {
            const r = await fetch(url, { method: 'GET', headers: _obsAuthHeader(), signal: AbortSignal.timeout(5000) });
            if (!r.ok) continue;
            const j = await r.json().catch(() => null);
            if (!j) continue;
            const items = j.items || j.files || j.objects || (Array.isArray(j.Contents)
                ? j.Contents.map((c) => ({ key: c.Key, size: c.Size, url: `${base}/${bucket}/${c.Key}`, mtime: c.LastModified }))
                : (Array.isArray(j) ? j : []));
            if (items.length) return { ok: true, items, note: 'mirror with list endpoint' };
        } catch (_) {}
    }
    return {
        ok: false,
        error: '此 OBS 服务没有 list 端点（obs.dimond.top 仅支持上传 / 下载）。请用「粘贴文件名 / URL」方式选图。',
        noList: true,
    };
}

async function obsUpload(localPath, obsKey, projectSlug) {
    const cfg = lib.getConfig();
    if (!cfg.obsEndpoint) return { ok: false, error: 'obsEndpoint not configured', obsKey: null };
    const base = _obsBase();
    const bucket = cfg.obsBucket || 'hermit-claw';
    let buf;
    try { buf = fs.readFileSync(localPath); }
    catch (e) { return { ok: false, error: `local read failed: ${e.message}`, obsKey }; }
    // The dimond OBS server reads the filename from the multipart form
    // and stores it at /{filename}. Its root namespace is flat, so we
    // encode "<bucket>/<projectSlug>/<key>" as
    // "<bucket>_<projectSlug>_<...with / replaced by _>" so multiple
    // buckets / projects / sub-keys don't collide on the same root.
    const segments = [bucket, projectSlug || 'unscoped', obsKey].map((s) => String(s).replace(/[\/\\:?*"<>|]/g, '_').replace(/\s+/g, '_'));
    const flatName = segments.join('_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    const boundary = '----sb' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${flatName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);
    try {
        const r = await fetch(`${base}/`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': String(body.length),
                ..._obsAuthHeader(),
            },
            body,
            signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) {
            return { ok: false, error: `obs upload ${r.status}: ${await r.text().catch(() => '')}`, obsKey };
        }
        const url = `${base}/${flatName}`;
        return { ok: true, obsKey, bytes: buf.length, url, fullName: flatName };
    } catch (e) {
        return { ok: false, error: `obs unreachable: ${e.message}`, obsKey };
    }
}

async function obsFetch(obsKey, saveTo) {
    const cfg = lib.getConfig();
    if (!cfg.obsEndpoint) return { ok: false, error: 'obsEndpoint not configured' };
    const base = _obsBase();
    // obsKey can be a full URL, a relative key, or already-flat. Normalize.
    let url;
    if (/^https?:\/\//i.test(obsKey)) {
        url = obsKey;
    } else {
        // Backward-compat: old-style <bucket>_<...> flat names still
        // work as a direct GET. New-style <bucket>_<proj>_<key> too.
        const bucket = cfg.obsBucket || 'hermit-claw';
        const flatName = `${bucket}_${obsKey.replace(/[\/\\:?*"<>|]/g, '_').replace(/\s+/g, '_')}`.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        url = `${base}/${flatName}`;
    }
    try {
        const r = await fetch(url, { headers: _obsAuthHeader(), signal: AbortSignal.timeout(15000) });
        if (!r.ok) return { ok: false, error: `obs fetch ${r.status}` };
        const buf = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(saveTo, buf);
        return { ok: true, path: saveTo, bytes: buf.length };
    } catch (e) {
        return { ok: false, error: `obs unreachable: ${e.message}` };
    }
}

// ----- fal.ai image generator (optional, used by auto-render) -----

async function falRenderImage(prompt, size = 'square_hd') {
    // Loads FAL_KEY from skills/clawra-selfie/.env at call time.
    const envPath = path.join(PROJECT_DIR, 'skills', 'clawra-selfie', '.env');
    let key = '';
    try {
        const txt = fs.readFileSync(envPath, 'utf8');
        const m = txt.match(/^FAL_KEY\s*=\s*(.+)\s*$/m);
        if (m) key = m[1].trim();
    } catch (_) {}
    if (!key) return { ok: false, error: 'FAL_KEY missing' };
    try {
        const submit = await fetch('https://queue.fal.run/fal-ai/flux/dev', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
            body: JSON.stringify({ prompt, image_size: size, num_images: 1 }),
        });
        if (!submit.ok) return { ok: false, error: `fal submit ${submit.status}` };
        const sj = await submit.json();
        const requestId = sj.request_id || sj.id;
        if (!requestId) return { ok: false, error: 'fal no request_id' };
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const poll = await fetch(`https://queue.fal.run/fal-ai/flux/dev/requests/${requestId}/status`, {
                headers: { Authorization: `Key ${key}` },
            });
            if (!poll.ok) continue;
            const pj = await poll.json();
            if (pj.status === 'COMPLETED') {
                const result = await fetch(`https://queue.fal.run/fal-ai/flux/dev/requests/${requestId}`, {
                    headers: { Authorization: `Key ${key}` },
                });
                const rj = await result.json();
                const url = (rj.images && rj.images[0] && rj.images[0].url) || (rj.image && rj.image.url);
                if (!url) return { ok: false, error: 'fal no image' };
                return { ok: true, url, prompt, size };
            }
            if (pj.status === 'FAILED') return { ok: false, error: 'fal failed' };
        }
        return { ok: false, error: 'fal timeout' };
    } catch (e) {
        return { ok: false, error: `fal unreachable: ${e.message}` };
    }
}

// ----- routing -----

function _idFromPath(url, prefix) {
    return decodeURIComponent(url.pathname.slice(prefix.length));
}

async function handle(req, res, url) {
    // ---- HTML ----
    if (req.method === 'GET' && url.pathname === '/studio/storyboard') {
        try {
            const html = fs.readFileSync(HTML_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('storyboard html missing: ' + e.message);
        }
        return true;
    }

    // ---- embed script (loaded by /console via server.js wrap) ----
    if (req.method === 'GET' && url.pathname === '/api/storyboard/console-tab.js') {
        try {
            const js = fs.readFileSync(path.join(__dirname, 'console-tab.js'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(js);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('embed script missing: ' + e.message);
        }
        return true;
    }

    // ---- asset streaming (uploads etc.) ----
    if (req.method === 'GET' && url.pathname.startsWith('/api/storyboard/asset/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/storyboard/asset/'.length));
        if (name.includes('..') || name.startsWith('/')) {
            res.writeHead(400); res.end('bad name'); return true;
        }
        const fp = path.join(lib.ASSETS_DIR, name);
        if (!fp.startsWith(lib.ASSETS_DIR) || !fs.existsSync(fp)) {
            res.writeHead(404); res.end('not found'); return true;
        }
        const st = fs.statSync(fp);
        if (st.size > 25 * 1024 * 1024) {
            res.writeHead(413); res.end('too large'); return true;
        }
        const ext = path.extname(fp).toLowerCase();
        const ct = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.gif':'image/gif','.webp':'image/webp','.json':'application/json' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': st.size });
        fs.createReadStream(fp).pipe(res);
        return true;
    }

    // ---- state ----
    if (req.method === 'GET' && url.pathname === '/api/storyboard/state') {
        // Auto-backfill a default project from legacy data on first load.
        lib.ensureDefaultProject();
        const projects = lib.listProjects();
        let projectId = url.searchParams.get('projectId');
        if (!projectId && projects.length) projectId = projects[0].id;
        const items = projectId ? lib.listItems({ projectId }) : lib.listItems();
        const versions = projectId ? lib.listVersions({ projectId }) : lib.listVersions();
        const shots = projectId ? lib.listShots({ projectId }) : lib.listShots();
        const cfg = lib.getConfig();
        const currentProject = projectId ? lib.getProject(projectId) : null;
        respondJSON(res, 200, {
            items, versions, shots, config: cfg, kinds: lib.KINDS,
            projects, currentProjectId: currentProject ? currentProject.id : null,
        });
        return true;
    }

    // ---- projects ----
    if (req.method === 'GET' && url.pathname === '/api/storyboard/projects') {
        respondJSON(res, 200, { projects: lib.listProjects() });
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/storyboard/projects') {
        parseJSONBody(req, (body) => {
            if (!body || !body.name) { respondJSON(res, 400, { error: 'name required' }); return; }
            const p = lib.createProject({ name: body.name, slug: body.slug });
            respondJSON(res, 200, { ok: true, project: p });
        });
        return true;
    }
    const projMatch = url.pathname.match(/^\/api\/storyboard\/projects\/([^\/]+)$/);
    if (projMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(projMatch[1]);
        if (req.method === 'DELETE') {
            lib.deleteProject(id);
            respondJSON(res, 200, { ok: true });
            return true;
        }
        parseJSONBody(req, (body) => {
            if (!body) { respondJSON(res, 400, { error: 'invalid body' }); return; }
            const p = lib.updateProject(id, body);
            respondJSON(res, p ? 200 : 404, p ? { ok: true, project: p } : { error: 'not found' });
        });
        return true;
    }

    // ---- items ----
    if (req.method === 'POST' && url.pathname === '/api/storyboard/items') {
        parseJSONBody(req, (body) => {
            if (!body || !body.name) { respondJSON(res, 400, { error: 'name required' }); return; }
            const item = lib.createItem({ name: body.name, kind: body.kind, theme: body.theme, tags: body.tags, projectId: body.projectId });
            respondJSON(res, 200, { ok: true, item });
        });
        return true;
    }

    const itemMatch = url.pathname.match(/^\/api\/storyboard\/items\/([^\/]+)$/);
    if (itemMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(itemMatch[1]);
        if (req.method === 'DELETE') {
            lib.deleteItem(id);
            respondJSON(res, 200, { ok: true });
            return true;
        }
        parseJSONBody(req, (body) => {
            if (!body) { respondJSON(res, 400, { error: 'invalid body' }); return; }
            const it = lib.updateItem(id, body);
            respondJSON(res, it ? 200 : 404, it ? { ok: true, item: it } : { error: 'not found' });
        });
        return true;
    }

    // ---- versions ----
    const verCreateMatch = url.pathname.match(/^\/api\/storyboard\/items\/([^\/]+)\/versions$/);
    if (verCreateMatch && req.method === 'POST') {
        const itemId = decodeURIComponent(verCreateMatch[1]);
        parseJSONBody(req, async (body) => {
            if (!body) { respondJSON(res, 400, { error: 'invalid body' }); return; }
            try {
                const r = lib.createVersion({
                    itemId,
                    parentVersionId: body.parentVersionId || null,
                    feedback: body.feedback || '',
                    sources: body.sources || {},
                    prompt: body.prompt || '',
                    createdBy: body.createdBy || 'master',
                });
                respondJSON(res, r.ok ? 200 : 400, r);
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return true;
    }

    const setCurMatch = url.pathname.match(/^\/api\/storyboard\/items\/([^\/]+)\/set-current$/);
    if (setCurMatch && req.method === 'POST') {
        const itemId = decodeURIComponent(setCurMatch[1]);
        parseJSONBody(req, (body) => {
            if (!body || !body.versionId) { respondJSON(res, 400, { error: 'versionId required' }); return; }
            const r = lib.setCurrentVersion(itemId, body.versionId);
            respondJSON(res, r.ok ? 200 : 400, r);
        });
        return true;
    }

    const itemVerListMatch = url.pathname.match(/^\/api\/storyboard\/items\/([^\/]+)\/versions$/);
    if (itemVerListMatch && req.method === 'GET') {
        const itemId = decodeURIComponent(itemVerListMatch[1]);
        respondJSON(res, 200, { versions: lib.versionsOf(itemId) });
        return true;
    }

    // ---- upload (multipart) ----
    if (req.method === 'POST' && url.pathname === '/api/storyboard/upload') {
        const ct = req.headers['content-type'] || '';
        const m = ct.match(/boundary=([^;]+)/i);
        if (!m) { respondJSON(res, 400, { error: 'multipart required' }); return true; }
        parseMultipart(req, m[1], async (err, parsed) => {
            if (err) { respondJSON(res, 400, { error: err.message }); return; }
            const file = parsed.files.file || parsed.files.image;
            if (!file) { respondJSON(res, 400, { error: 'no file field' }); return; }
            const ext = (path.extname(file.filename) || '.png').toLowerCase();
            if (!['.png','.jpg','.jpeg','.webp','.gif','.svg'].includes(ext)) {
                respondJSON(res, 400, { error: 'unsupported type ' + ext }); return;
            }
            const name = `${crypto.randomBytes(8).toString('hex')}${ext}`;
            const fp = path.join(lib.UPLOAD_DIR, name);
            fs.writeFileSync(fp, file.data);
            const stat = fs.statSync(fp);
            respondJSON(res, 200, {
                ok: true,
                kind: 'upload',
                path: fp,
                url: `/api/storyboard/asset/uploads/${name}`,
                bytes: stat.size,
                contentType: file.contentType,
            });
        });
        return true;
    }

    // ---- OBS list / fetch ----
    if (req.method === 'GET' && url.pathname === '/api/storyboard/obs/list') {
        const prefix = url.searchParams.get('prefix') || '';
        const r = await obsList(prefix);
        respondJSON(res, r.ok ? 200 : 502, r);
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/storyboard/obs/fetch') {
        parseJSONBody(req, async (body) => {
            if (!body || !body.obsKey) { respondJSON(res, 400, { error: 'obsKey required' }); return; }
            const ext = path.extname(body.obsKey) || '.png';
            const name = `${crypto.randomBytes(8).toString('hex')}${ext}`;
            const fp = path.join(lib.UPLOAD_DIR, name);
            const r = await obsFetch(body.obsKey, fp);
            if (r.ok) {
                respondJSON(res, 200, { ok: true, kind: 'obs', path: fp, url: `/api/storyboard/asset/uploads/${name}`, obsKey: body.obsKey, bytes: r.bytes });
            } else {
                respondJSON(res, 502, r);
            }
        });
        return true;
    }

    // ---- fal auto-render ----
    if (req.method === 'POST' && url.pathname === '/api/storyboard/auto-render') {
        parseJSONBody(req, async (body) => {
            if (!body || !body.prompt) { respondJSON(res, 400, { error: 'prompt required' }); return; }
            const r = await falRenderImage(body.prompt, body.size || 'square_hd');
            if (!r.ok) { respondJSON(res, 502, r); return; }
            try {
                // Download from fal CDN into our uploads dir so we have a local file too.
                const resp = await fetch(r.url);
                const buf = Buffer.from(await resp.arrayBuffer());
                const name = `${crypto.randomBytes(8).toString('hex')}.png`;
                const fp = path.join(lib.UPLOAD_DIR, name);
                fs.writeFileSync(fp, buf);
                respondJSON(res, 200, {
                    ok: true,
                    kind: 'auto',
                    path: fp,
                    url: `/api/storyboard/asset/uploads/${name}`,
                    sourceUrl: r.url,
                    bytes: buf.length,
                });
            } catch (e) {
                respondJSON(res, 200, { ok: true, kind: 'auto', sourceUrl: r.url, note: 'kept remote url; local download failed: ' + e.message });
            }
        });
        return true;
    }

    // ---- shots ----
    if (req.method === 'POST' && url.pathname === '/api/storyboard/shots') {
        parseJSONBody(req, (body) => {
            const shot = lib.createShot(body || {});
            respondJSON(res, 200, { ok: true, shot });
        });
        return true;
    }
    const shotMatch = url.pathname.match(/^\/api\/storyboard\/shots\/([^\/]+)$/);
    if (shotMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(shotMatch[1]);
        if (req.method === 'DELETE') {
            lib.deleteShot(id);
            respondJSON(res, 200, { ok: true });
            return true;
        }
        parseJSONBody(req, (body) => {
            if (!body) { respondJSON(res, 400, { error: 'invalid body' }); return; }
            const s = lib.updateShot(id, body);
            respondJSON(res, s ? 200 : 404, s ? { ok: true, shot: s } : { error: 'not found' });
        });
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/storyboard/shots/reorder') {
        parseJSONBody(req, (body) => {
            if (!body || !Array.isArray(body.orderedIds)) { respondJSON(res, 400, { error: 'orderedIds required' }); return; }
            respondJSON(res, 200, { ok: true, shots: lib.reorderShots(body.orderedIds) });
        });
        return true;
    }
    const shotAddMatch = url.pathname.match(/^\/api\/storyboard\/shots\/([^\/]+)\/add$/);
    if (shotAddMatch && req.method === 'POST') {
        const id = decodeURIComponent(shotAddMatch[1]);
        parseJSONBody(req, (body) => {
            if (!body || !body.versionId) { respondJSON(res, 400, { error: 'versionId required' }); return; }
            const s = lib.addVersionToShot(id, body.versionId, body.slot || 'cast');
            respondJSON(res, s ? 200 : 404, s ? { ok: true, shot: s } : { error: 'not found' });
        });
        return true;
    }
    const shotRmMatch = url.pathname.match(/^\/api\/storyboard\/shots\/([^\/]+)\/remove$/);
    if (shotRmMatch && req.method === 'POST') {
        const id = decodeURIComponent(shotRmMatch[1]);
        parseJSONBody(req, (body) => {
            if (!body || !body.versionId) { respondJSON(res, 400, { error: 'versionId required' }); return; }
            const s = lib.removeVersionFromShot(id, body.versionId, body.slot || 'cast');
            respondJSON(res, s ? 200 : 404, s ? { ok: true, shot: s } : { error: 'not found' });
        });
        return true;
    }

    // ---- config ----
    if (req.method === 'GET' && url.pathname === '/api/storyboard/config') {
        respondJSON(res, 200, lib.getConfig());
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/storyboard/config') {
        parseJSONBody(req, (body) => {
            if (!body) { respondJSON(res, 400, { error: 'invalid body' }); return; }
            respondJSON(res, 200, { ok: true, config: lib.setConfig(body) });
        });
        return true;
    }

    // ---- export pdf ----
    if (req.method === 'POST' && url.pathname === '/api/storyboard/export-pdf') {
        parseJSONBody(req, async (body) => {
            try {
                const projectId = (body && body.projectId) || lib.getDefaultProjectId();
                const project = projectId ? lib.getProject(projectId) : null;
                const items = lib.listItems({ projectId });
                const versions = lib.listVersions({ projectId });
                const shots = lib.listShots({ projectId });
                const versionsById = {};
                for (const v of versions) versionsById[v.id] = { ...v, item: items.find((x) => x.id === v.itemId) };
                const cfg = lib.getConfig();
                const title = (body && body.title)
                    || `${project ? project.name : (cfg.pdfFooter || 'Storyboard')} · ${lib.nowIso().slice(0, 10)}`;
                const buf = renderStoryboardPdf({
                    title,
                    project: project ? project.name : (body && body.project),
                    characters: items,                 // name kept for PDF readability
                    shots,
                    versionsByCharacter: versionsById,
                    exports: cfg.exports || [],
                });
                const fname = `storyboard-${Date.now()}.pdf`;
                const localPath = path.join(lib.EXPORT_DIR, fname);
                fs.writeFileSync(localPath, buf);
                // Upload to OBS if configured, else mark pending.
                const obsKey = `exports/${fname}`;
                const projectSlug = project ? project.slug : 'unscoped';
                let up;
                if (cfg.obsEndpoint) {
                    up = await obsUpload(localPath, obsKey, projectSlug);
                } else {
                    up = { ok: false, error: 'obsEndpoint not configured', obsKey: null };
                }
                const entry = {
                    at: lib.nowIso(),
                    localPath,
                    bytes: buf.length,
                    obsKey: up && up.ok ? obsKey : null,
                    obsFullName: up && up.ok ? up.fullName : null,
                    projectId: project ? project.id : null,
                    projectSlug: project ? project.slug : null,
                    status: up && up.ok ? 'uploaded' : 'local-only',
                    error: up && up.ok ? null : (up && up.error),
                };
                lib.recordExport(entry);
                respondJSON(res, 200, { ok: true, file: entry });
            } catch (e) {
                respondJSON(res, 500, { error: e.message });
            }
        });
        return true;
    }

    // ---- download past export ----
    const exportDlMatch = url.pathname.match(/^\/api\/storyboard\/exports\/(.+)$/);
    if (exportDlMatch && req.method === 'GET') {
        const fname = decodeURIComponent(exportDlMatch[1]);
        if (fname.includes('/') || fname.includes('..')) {
            res.writeHead(400); res.end('bad name'); return true;
        }
        const fp = path.join(lib.EXPORT_DIR, fname);
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return true; }
        const st = fs.statSync(fp);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${fname}"` });
        fs.createReadStream(fp).pipe(res);
        return true;
    }

    return false;
}

module.exports = { handle };