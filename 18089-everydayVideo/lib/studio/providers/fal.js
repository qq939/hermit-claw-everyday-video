// studio/providers/fal.js
// fal.ai image & video provider.
// Reads FAL_KEY from skills/clawra-selfie/.env at probe() time.
// Default endpoint: fal-ai/flux/dev (text -> image).
// Optional video endpoint: fal-ai/luma-dream-machine (text -> video).
//
// API is the fal.ai queue API:
//   POST https://queue.fal.run/<endpoint>           submit
//   GET  https://queue.fal.run/<endpoint>/requests/<id>/status
//   GET  https://queue.fal.run/<endpoint>/requests/<id>            result (after completion)
//
// We never load response binaries into memory — fetchToFile streams.

const fs = require('fs');
const path = require('path');
const { fetchJSON, fetchToFile, withRetry } = require('../core/http-client');
const { appendStudioLog } = require('../core/logger');

const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..');
const ENV_FILE = path.join(PROJECT_DIR, 'skills', 'clawra-selfie', '.env');
const ASSETS_DIR = path.join(PROJECT_DIR, 'studio-assets');

const DEFAULT_IMAGE_MODEL = 'fal-ai/flux/dev';
const DEFAULT_VIDEO_MODEL = 'fal-ai/luma-dream-machine';
const FAL_QUEUE_BASE = 'https://queue.fal.run';

let _key = null;
let _lastReadAt = 0;

function _readKey() {
    // Re-read every probe() call so the operator can rotate keys without
    // restarting the server. Never echo the key back to API responses.
    try {
        if (!fs.existsSync(ENV_FILE)) return null;
        const txt = fs.readFileSync(ENV_FILE, 'utf8');
        for (const line of txt.split(/\r?\n/)) {
            const m = line.match(/^\s*FAL_KEY\s*=\s*(.+)\s*$/);
            if (m) return m[1].trim();
        }
    } catch (_) {}
    return null;
}

function _keyMasked(k) {
    if (!k) return null;
    if (k.length <= 8) return '****';
    return `${k.slice(0, 4)}…${k.slice(-4)} (len=${k.length})`;
}

async function probe() {
    _key = _readKey();
    _lastReadAt = Date.now();
    if (!_key) {
        return { enabled: false, reason: 'FAL_KEY missing', envFile: ENV_FILE };
    }
    // fal.ai is just an HTTP host. We don't want to burn credits on every
    // probe, so we treat "key present and parseable" as enabled.
    return {
        enabled: true,
        keyFingerprint: _keyMasked(_key),
        imageModel: DEFAULT_IMAGE_MODEL,
        videoModel: DEFAULT_VIDEO_MODEL,
        queueBase: FAL_QUEUE_BASE,
    };
}

function _assetsDir() {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    return ASSETS_DIR;
}

function _uniqueName(prefix, ext) {
    const t = new Date().toISOString().replace(/[:.]/g, '-');
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${t}-${rnd}.${ext}`;
}

// Submit a job to fal.ai queue. Returns { ok, requestId, statusUrl, resultUrl, error? }.
async function _submit(model, payload) {
    const url = `${FAL_QUEUE_BASE}/${model}`;
    return withRetry(async () => {
        const r = await fetchJSON(url, {
            method: 'POST',
            headers: { Authorization: `Key ${_key}` },
            body: payload,
            timeoutMs: 6000,
        });
        if (!r.ok) return { ok: false, error: `submit HTTP ${r.status}`, status: r.status, data: r.data };
        const id = r.data && (r.data.request_id || r.data.id);
        if (!id) return { ok: false, error: 'no request_id in response', data: r.data };
        return {
            ok: true,
            requestId: id,
            statusUrl: `${FAL_QUEUE_BASE}/${model}/requests/${id}/status`,
            resultUrl: `${FAL_QUEUE_BASE}/${model}/requests/${id}`,
        };
    }, { retries: 1, label: `fal.submit(${model})` });
}

async function _poll(model, requestId, { intervalMs = 1500, maxWaitMs = 90000 } = {}) {
    const statusUrl = `${FAL_QUEUE_BASE}/${model}/requests/${requestId}/status`;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const r = await fetchJSON(statusUrl, {
            headers: { Authorization: `Key ${_key}` },
            timeoutMs: 5000,
        });
        if (r.ok && r.data) {
            const s = (r.data.status || '').toLowerCase();
            if (s === 'completed' || r.data.completed === true) {
                return { ok: true, status: r.data };
            }
            if (s === 'failed' || r.data.error) {
                return { ok: false, error: 'fal job failed', status: r.data };
            }
        }
        await new Promise((res) => setTimeout(res, intervalMs));
    }
    return { ok: false, error: 'fal job timed out' };
}

async function _fetchResultImage(model, requestId, destPath) {
    const resultUrl = `${FAL_QUEUE_BASE}/${model}/requests/${requestId}`;
    const r = await fetchJSON(resultUrl, {
        headers: { Authorization: `Key ${_key}` },
        timeoutMs: 5000,
    });
    if (!r.ok) return { ok: false, error: `result HTTP ${r.status}`, status: r.status };
    const data = r.data || {};
    // fal-ai/flux/dev returns { images: [{ url, content_type, width, height }], seed }
    let url;
    if (Array.isArray(data.images) && data.images[0] && data.images[0].url) url = data.images[0].url;
    else if (data.image && data.image.url) url = data.image.url;
    else if (data.url) url = data.url;
    if (!url) return { ok: false, error: 'no image url in result', data };
    const dl = await fetchToFile(url, destPath, { timeoutMs: 15000 });
    if (!dl.ok) return { ok: false, error: `download ${dl.error}`, status: dl.status };
    return {
        ok: true,
        path: destPath,
        bytes: dl.bytes,
        width: (data.images && data.images[0] && data.images[0].width) || null,
        height: (data.images && data.images[0] && data.images[0].height) || null,
        seed: data.seed || null,
    };
}

async function run(request, ctx) {
    if (!_key) _key = _readKey();
    if (!_key) return { ok: false, error: 'FAL_KEY missing', degraded: true };
    const { kind = 'image', prompt, image_size = 'landscape_16_9', num_inference_steps = 28, guidance_scale = 3.5, num_images = 1 } = request || {};
    if (!prompt) return { ok: false, error: 'prompt required', degraded: true };

    const model = kind === 'video' ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL;

    const submit = await _submit(model, {
        prompt,
        image_size,
        num_inference_steps,
        guidance_scale,
        num_images,
        enable_safety_checker: true,
    });
    if (!submit.ok) {
        appendStudioLog(`fal: submit failed model=${model} err=${submit.error}`, { always: true });
        return { ok: false, error: submit.error, degraded: true, model };
    }
    appendStudioLog(`fal: submitted model=${model} requestId=${submit.requestId}`, { always: true });

    const polled = await _poll(model, submit.requestId);
    if (!polled.ok) {
        appendStudioLog(`fal: poll failed requestId=${submit.requestId} err=${polled.error}`, { always: true });
        return { ok: false, error: polled.error, requestId: submit.requestId, model };
    }

    if (kind === 'image') {
        const ext = 'png';
        const dest = path.join(_assetsDir(), _uniqueName('fal-img', ext));
        const got = await _fetchResultImage(model, submit.requestId, dest);
        if (!got.ok) {
            appendStudioLog(`fal: fetch image failed err=${got.error}`, { always: true });
            return { ok: false, error: got.error, requestId: submit.requestId, model };
        }
        appendStudioLog(`fal: image ok ${got.path} bytes=${got.bytes}`, { always: true });
        return {
            ok: true,
            kind: 'image',
            path: got.path,
            bytes: got.bytes,
            width: got.width,
            height: got.height,
            seed: got.seed,
            model,
            requestId: submit.requestId,
            assetUrl: `/api/studio/asset/${path.basename(got.path)}`,
            prompt,
        };
    }
    // video: just return the remote URL — caller decides whether to
    // download (we keep it off-disk by default to respect cgroup cap).
    return {
        ok: true,
        kind: 'video',
        model,
        requestId: submit.requestId,
        status: polled.status,
        note: 'video result lives on fal CDN; attach remote URL when possible',
    };
}

module.exports = {
    id: 'fal',
    kind: 'image+video',
    label: 'fal.ai (clawra-selfie key)',
    probe,
    isEnabled: () => !!_key,
    run,
};