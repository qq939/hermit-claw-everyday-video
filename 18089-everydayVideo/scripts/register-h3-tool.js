#!/usr/bin/env node
// Register the H3 video generation tool with the Tools Hub on :18081
// Idempotent: PUT replaces if the same id already exists.

const http = require('http');

const TOOL = {
    id: 'minimax-h3-video',
    name: 'MiniMax H3 Video Generation',
    port: 8082,
    version: '1.0.0',
    description: 'H3 video generation client. Submit t2va / i2va / fl2va / l2va / ref2va jobs to the MiniMax Open Platform, poll status, and download the resulting 4-15s 768p/2K MP4. Backed by lib/h3/client.js inside this container.',
    endpoint: 'http://localhost:8082',
    routes: [
        { method: 'GET',  path: '/h3/health',                       summary: 'Local H3 client status (apiBase, apiKeySet, supported tasks).' },
        { method: 'POST', path: '/h3/videos',                       summary: 'Create a video job. Body: { task, prompt, conditions?, target?: { short_edge, aspect_ratio, duration_seconds }, seed? }.' },
        { method: 'GET',  path: '/h3/videos/:id',                   summary: 'Poll job status.' },
        { method: 'GET',  path: '/h3/videos/:id/download',          summary: 'Download generated MP4.' },
    ],
    auth: 'bearer',
    env: { H3_API_KEY: 'MiniMax Open Platform API key' },
    tasks: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'],
    skills: [
        'h3-prompt-writing',
        '3d-animation-short-generator',
        'brand-promo-video-generator',
        'co-op-game-intro-generator',
        'handdrawn-live-video-generator',
        'minimalist-product-ad-generator',
        'music-video-subtitle-generator',
        'paper-collage-explainer-generator',
        'papercraft-stop-motion-explainer',
    ],
    source: 'https://github.com/MiniMax-AI/MiniMax-H3',
    registeredBy: '18089-everydayVideo',
};

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request(
            { hostname: 'host.docker.internal', port: 18081, path, method,
              headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': data.length } : {}),
              } },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({ status: res.statusCode, body: text });
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const base = '/api/tools';
    // Try PUT to create-or-replace.
    let r = await request('PUT', `${base}/${TOOL.id}`, TOOL);
    if (r.status >= 200 && r.status < 300) {
        console.log(`ok: PUT ${base}/${TOOL.id} -> ${r.status}`);
        console.log(r.body);
        return;
    }
    // Fallback: POST.
    r = await request('POST', base, TOOL);
    console.log(`fallback: POST ${base} -> ${r.status}`);
    console.log(r.body);
})();
