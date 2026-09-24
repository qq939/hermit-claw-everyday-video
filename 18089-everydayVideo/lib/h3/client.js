// H3 Video API Client
// Wraps the MiniMax H3 Open Platform /v1/videos endpoints so server.js
// can submit t2va / i2va / fl2va / ref2va jobs, poll their status, and
// download the generated MP4.
//
// Mirrors scripts/readme/reproducible-768p-*.sh but speaks HTTPS
// directly, so it works inside this container without a local GPU.
//
// Reference: https://github.com/MiniMax-AI/MiniMax-H3

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = process.env.H3_API_BASE
    || 'https://api.minimaxi.com'; // MiniMax Open Platform global endpoint

const DEFAULT_KEY = process.env.H3_API_KEY || '';

const ALLOWED_TASKS = new Set(['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']);
const ALLOWED_ASPECTS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

function requestJson(method, urlStr, body, apiKey, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'http:' ? http : https;
        const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (data) headers['Content-Length'] = data.length;
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const req = lib.request(
            {
                method,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + (u.search || ''),
                headers,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try { resolve(text ? JSON.parse(text) : {}); }
                        catch (_) { resolve({ raw: text }); }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${text}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs || 60000, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs || 60000}ms`));
        });
        if (data) req.write(data);
        req.end();
    });
}

function requestBinary(urlStr, outPath, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.get(
            {
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + (u.search || ''),
            },
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    res.resume();
                    return;
                }
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                const f = fs.createWriteStream(outPath);
                res.pipe(f);
                f.on('finish', () => f.close(() => resolve(outPath)));
                f.on('error', reject);
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs || 600000, () => {
            req.destroy(new Error(`Download timeout after ${timeoutMs || 600000}ms`));
        });
    });
}

function validateTask(task) {
    if (!ALLOWED_TASKS.has(task)) {
        throw new Error(`Invalid task "${task}". Must be one of: ${[...ALLOWED_TASKS].join(', ')}`);
    }
}

function validateTarget(target) {
    const t = target || {};
    if (t.short_edge !== undefined) {
        const se = Number(t.short_edge);
        if (!Number.isFinite(se) || se < 256 || se > 2048) {
            throw new Error('target.short_edge must be between 256 and 2048');
        }
    }
    if (t.aspect_ratio && !ALLOWED_ASPECTS.has(t.aspect_ratio)) {
        throw new Error(`Invalid aspect_ratio "${t.aspect_ratio}". Allowed: ${[...ALLOWED_ASPECTS].join(', ')}`);
    }
    if (t.duration_seconds !== undefined) {
        const d = Number(t.duration_seconds);
        if (!Number.isFinite(d) || d < 4 || d > 15) {
            throw new Error('target.duration_seconds must be between 4 and 15');
        }
    }
}

/**
 * Submit a video generation request.
 * @param {Object} opts
 * @param {string} opts.task  t2va | i2va | fl2va | l2va | ref2va
 * @param {string} opts.prompt
 * @param {Array}  [opts.conditions]
 * @param {Object} [opts.target]  { short_edge, aspect_ratio, duration_seconds }
 * @param {number} [opts.seed]
 * @returns {Promise<{id:string}>}
 */
async function createVideo(opts, apiKey) {
    if (!opts || typeof opts !== 'object') throw new Error('opts is required');
    validateTask(opts.task);
    if (!opts.prompt || typeof opts.prompt !== 'string') {
        throw new Error('prompt is required (string)');
    }
    validateTarget(opts.target);
    const payload = {
        task: opts.task,
        prompt: opts.prompt,
        conditions: opts.conditions || [],
        target: {
            short_edge: opts.target?.short_edge ?? 768,
            aspect_ratio: opts.target?.aspect_ratio ?? '16:9',
            duration_seconds: opts.target?.duration_seconds ?? 10,
        },
        seed: Number.isFinite(opts.seed) ? opts.seed : 0,
    };
    return requestJson('POST', `${DEFAULT_BASE}/v1/videos`, payload, apiKey || DEFAULT_KEY, 60000);
}

async function getVideo(id, apiKey) {
    if (!id) throw new Error('id is required');
    return requestJson('GET', `${DEFAULT_BASE}/v1/videos/${encodeURIComponent(id)}`, null, apiKey || DEFAULT_KEY, 30000);
}

async function downloadVideo(id, outPath, apiKey) {
    if (!id) throw new Error('id is required');
    if (!outPath) throw new Error('outPath is required');
    return requestBinary(`${DEFAULT_BASE}/v1/videos/${encodeURIComponent(id)}/content`, outPath, 600000);
}

module.exports = {
    createVideo,
    getVideo,
    downloadVideo,
    DEFAULT_BASE,
};
