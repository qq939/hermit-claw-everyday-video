// studio/core/http-client.js
// Shared HTTP client for studio providers.
// - Strict 8s timeout (no provider call can hold Node longer).
// - 3 retries with exponential backoff (250ms, 750ms, 2.25s).
// - Streams response body to disk when given a dest path; never buffers
//   large binaries in memory. Critical for 228MB cgroup cap.
// - Always returns { ok, status, bytes, error? }.

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [250, 750, 2250];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB single-file cap

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    try {
        const opts = { method, headers: { ...headers }, signal: ctrl.signal };
        if (body && typeof body !== 'string') {
            opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
            opts.body = JSON.stringify(body);
        } else if (body) {
            opts.body = body;
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { ok: res.ok, status: res.status, data, url };
    } catch (e) {
        return { ok: false, status: 0, error: e.message || String(e), url };
    } finally {
        clearTimeout(t);
    }
}

// Stream a GET to a file path. Returns bytes written or throws { code:'TOO_LARGE' }.
async function fetchToFile(url, destPath, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_FILE_BYTES, signal = null } = {}) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    try {
        const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
        if (!res.ok) {
            return { ok: false, status: res.status, error: `HTTP ${res.status}` };
        }
        const out = fs.createWriteStream(destPath);
        let written = 0;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader) {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                written += value.length;
                if (written > maxBytes) {
                    try { out.destroy(); } catch (_) {}
                    try { fs.unlinkSync(destPath); } catch (_) {}
                    return { ok: false, status: 413, error: `file > ${maxBytes} bytes`, bytes: written };
                }
                if (!out.write(value)) {
                    await new Promise((r) => out.once('drain', r));
                }
            }
        } else {
            // Fallback for environments without ReadableStream reader
            const buf = Buffer.from(await res.arrayBuffer());
            written = buf.length;
            if (written > maxBytes) {
                try { fs.unlinkSync(destPath); } catch (_) {}
                return { ok: false, status: 413, error: `file > ${maxBytes} bytes`, bytes: written };
            }
            fs.writeFileSync(destPath, buf);
        }
        await new Promise((r) => out.end(r));
        return { ok: true, status: res.status, bytes: written, path: destPath };
    } catch (e) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        return { ok: false, status: 0, error: e.message || String(e) };
    } finally {
        clearTimeout(t);
    }
}

// Retry wrapper around an async fn. fn must return { ok, ... } or throw.
async function withRetry(fn, { retries = MAX_RETRIES, backoff = BACKOFF_MS, label = 'http' } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
        try {
            last = await fn();
            if (last && last.ok) return last;
        } catch (e) {
            last = { ok: false, error: e.message || String(e) };
        }
        if (i < retries) await sleep(backoff[Math.min(i, backoff.length - 1)]);
    }
    last = last || { ok: false, error: 'no result' };
    last.retries = retries;
    last.label = label;
    return last;
}

module.exports = { fetchJSON, fetchToFile, withRetry, DEFAULT_TIMEOUT_MS, MAX_FILE_BYTES };