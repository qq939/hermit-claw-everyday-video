// studio/providers/local-poster.js
// Offline poster generator. Pure Node, no network, no memory blowup.
// Produces an SVG (cheap, sharp, easy to embed in email).
//
// Used as a fallback whenever fal.ai is unreachable, and as the
// default for `!poster` when no API key is set.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..');
const ASSETS_DIR = path.join(PROJECT_DIR, 'studio-assets');

const PALETTES = [
    ['#0d1117', '#58a6ff', '#7ee787', '#bc8cff'],
    ['#161b22', '#1f6feb', '#3fb950', '#d29922'],
    ['#0a0a0f', '#ff6f61', '#ffd166', '#06d6a0'],
    ['#1a1a2e', '#e94560', '#0f3460', '#16213e'],
];

function _pickPalette(seed) {
    if (!seed) return PALETTES[0];
    const h = crypto.createHash('md5').update(seed).digest();
    return PALETTES[h[0] % PALETTES.length];
}

function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[c]));
}

function _wrapLines(text, maxChars = 22) {
    const words = String(text).split(/(\s+)/);
    const lines = [];
    let cur = '';
    for (const w of words) {
        if ((cur + w).length > maxChars && cur.trim()) {
            lines.push(cur.trim());
            cur = w.trim();
        } else {
            cur += w;
        }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.slice(0, 6);
}

function _buildSvg({ title, subtitle, palette, signature }) {
    const [bg, c1, c2, c3] = palette;
    const W = 1080, H = 1080;
    const lines = _wrapLines(title || 'untitled', 18);
    const subs = _wrapLines(subtitle || '', 30);
    const lineH = 86;
    const startY = H / 2 - ((lines.length - 1) * lineH) / 2;
    let tspans = '';
    lines.forEach((l, i) => {
        const y = startY + i * lineH;
        tspans += `<text x="${W / 2}" y="${y}" text-anchor="middle" fill="${c2}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="700" font-size="72">${_escape(l)}</text>`;
    });
    let subText = '';
    if (subs.length) {
        subText = `<text x="${W / 2}" y="${H - 140}" text-anchor="middle" fill="${c3}" font-family="ui-sans-serif, system-ui" font-size="28">${_escape(subs.join(' · '))}</text>`;
    }
    const sig = signature ? `<text x="40" y="40" fill="${c1}" font-family="ui-monospace, monospace" font-size="20">${_escape(signature)}</text>` : '';
    const grid = '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${c1}" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${grid}
  <circle cx="${W - 120}" cy="120" r="56" fill="${c1}" fill-opacity="0.35"/>
  <circle cx="${W - 220}" cy="200" r="20" fill="${c2}" fill-opacity="0.7"/>
  ${tspans}
  ${subText}
  ${sig}
</svg>`;
}

function _assetsDir() {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    return ASSETS_DIR;
}

function _name() {
    const t = new Date().toISOString().replace(/[:.]/g, '-');
    const r = Math.random().toString(36).slice(2, 8);
    return `poster-${t}-${r}.svg`;
}

async function probe() {
    return { enabled: true, mode: 'svg', paletteCount: PALETTES.length };
}

async function run(request) {
    const { title = 'untitled', subtitle = '', paletteSeed } = request || {};
    const palette = _pickPalette(paletteSeed || title);
    const svg = _buildSvg({
        title,
        subtitle,
        palette,
        signature: 'Hermit-Claw · studio',
    });
    const dest = path.join(_assetsDir(), _name());
    fs.writeFileSync(dest, svg, 'utf8');
    const bytes = Buffer.byteLength(svg, 'utf8');
    return {
        ok: true,
        kind: 'image',
        path: dest,
        bytes,
        mime: 'image/svg+xml',
        assetUrl: `/api/studio/asset/${path.basename(dest)}`,
        palette,
        title,
        subtitle,
    };
}

module.exports = {
    id: 'local-poster',
    kind: 'image',
    label: '本地 SVG 海报（零依赖）',
    probe,
    isEnabled: () => true,
    run,
};