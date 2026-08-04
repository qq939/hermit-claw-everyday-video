// studio/providers/local-gif.js
// Generates a tiny animated SVG (essentially a GIF-equivalent that
// Slack, browsers, and most modern email clients render). We avoid
// pulling in gif-encoding deps — animated SVG keeps memory tiny and
// is acceptable for the Slack channel the global gif skill targets.
//
// For a real GIF file we'd shell out to ffmpeg if available; we try
// that as an optional fast-path. Otherwise we fall back to the SVG.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..');
const ASSETS_DIR = path.join(PROJECT_DIR, 'studio-assets');

function _ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function _rnd() { return Math.random().toString(36).slice(2, 8); }

function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[c]));
}

function _buildSvg({ title, subtitle, frames = 8, durationMs = 2400 }) {
    const W = 480, H = 480;
    const pal = ['#0d1117', '#58a6ff', '#7ee787', '#bc8cff', '#f0f6fc'];
    const step = durationMs / frames;
    let bubbles = '';
    for (let i = 0; i < frames; i++) {
        const t = (i / frames) * Math.PI * 2;
        const cx = W / 2 + Math.cos(t) * 110;
        const cy = H / 2 + Math.sin(t * 1.3) * 90;
        const r = 40 + (i % 3) * 8;
        const c = pal[(i + 1) % pal.length];
        bubbles += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${c}" fill-opacity="0.55">
      <animate attributeName="r" values="${r};${r + 12};${r}" dur="${durationMs}ms" begin="${(i * step / 4).toFixed(1)}ms" repeatCount="indefinite"/>
    </circle>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${pal[0]}"/>
  ${bubbles}
  <text x="${W / 2}" y="${H / 2 + 8}" text-anchor="middle" fill="${pal[4]}" font-family="ui-monospace, monospace" font-size="32" font-weight="700">${_escape(title || 'studio')}</text>
  ${subtitle ? `<text x="${W / 2}" y="${H - 32}" text-anchor="middle" fill="${pal[3]}" font-family="ui-sans-serif" font-size="16">${_escape(subtitle)}</text>` : ''}
</svg>`;
}

let _ffmpegChecked = false;
let _ffmpegOk = false;
function _hasFfmpeg() {
    if (_ffmpegChecked) return _ffmpegOk;
    _ffmpegChecked = true;
    try {
        require('child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 1500 });
        _ffmpegOk = true;
    } catch (_) { _ffmpegOk = false; }
    return _ffmpegOk;
}

async function probe() {
    return { enabled: true, mode: 'svg', ffmpeg: _hasFfmpeg() };
}

async function run(request) {
    const { title = 'studio', subtitle = '', frames = 8, durationMs = 2400 } = request || {};
    const svg = _buildSvg({ title, subtitle, frames, durationMs });
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    const baseName = `gif-${_ts()}-${_rnd()}`;
    const svgPath = path.join(ASSETS_DIR, `${baseName}.svg`);
    fs.writeFileSync(svgPath, svg, 'utf8');

    // Try ffmpeg → real GIF
    if (_hasFfmpeg()) {
        const gifPath = path.join(ASSETS_DIR, `${baseName}.gif`);
        try {
            await new Promise((resolve, reject) => {
                execFile('ffmpeg', [
                    '-y',
                    '-loop', '1',
                    '-i', svgPath,
                    '-vf', `fps=${frames},scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`,
                    '-t', String(Math.max(2, Math.round(durationMs / 1000))),
                    gifPath,
                ], { timeout: 8000 }, (err) => err ? reject(err) : resolve());
            });
            const st = fs.statSync(gifPath);
            return {
                ok: true,
                kind: 'gif',
                path: gifPath,
                bytes: st.size,
                mime: 'image/gif',
                assetUrl: `/api/studio/asset/${path.basename(gifPath)}`,
                ffmpeg: true,
            };
        } catch (e) {
            // fall through to SVG
        }
    }

    const st = fs.statSync(svgPath);
    return {
        ok: true,
        kind: 'gif',
        path: svgPath,
        bytes: st.size,
        mime: 'image/svg+xml',
        assetUrl: `/api/studio/asset/${path.basename(svgPath)}`,
        ffmpeg: false,
        note: 'animated SVG fallback (no ffmpeg)',
    };
}

module.exports = {
    id: 'local-gif',
    kind: 'gif',
    label: '本地 GIF / 动画 SVG',
    probe,
    isEnabled: () => true,
    run,
};