// storyboard/pdf-template.js
// Pretty printable HTML template for the storyboard export.
//
// Why HTML first: the PDF writer is a tiny zero-deps stream builder that
// supports CJK via embedded NotoSansCJK. But laying out a multi-page
// document by hand is fiddly, and the moment we want real tables, grids,
// or rounded cards the operator overrides explode. So we generate a
// print-styled HTML page that mirrors the storyboard.html UI (library +
// shots) and hand the file to whoever wants to print it: browser → PDF
// via the OS print dialog, or the existing pdf.js as a fallback for
// headless use.
//
// Color palette intentionally matches storyboard.html so the on-screen
// and printed versions look like the same project.

const fs = require('fs');
const path = require('path');

// Same color tokens as lib/storyboard/storyboard.html, but tuned for
// print (light background, dark text). The dark "studio" theme looks
// great on a screen but burns toner and hides faint rules on paper.
const COLORS = {
    bg:        '#f6f8fa',
    bg2:       '#ffffff',
    bg3:       '#eef1f5',
    line:      '#d0d7de',
    line2:     '#afb8c1',
    fg:        '#1f2328',
    fg2:       '#424a53',
    fg3:       '#656d76',
    accent:    '#0969da',
    accent2:   '#1a7f37',
    err:       '#cf222e',
    warn:      '#9a6700',
    scene:     '#0969da',
    prop:      '#9a6700',
    character: '#8250df',
};

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _kindLabel(k) {
    return { character: '人物', scene: '场景', prop: '道具' }[k] || k || '-';
}

function _kindColor(k) {
    return COLORS[k] || COLORS.accent;
}

function _slotNames(shot) {
    // Returns the cast/scene/prop names of a shot by joining the
    // versions' backing items. Fallback to the raw id if we can't
    // resolve (shouldn't happen, but be defensive).
    const lookupName = (vid) => {
        const v = this.versionsById[vid];
        if (!v) return null;
        const it = this.itemsById[v.itemId];
        return it ? `${it.name} v${v.versionNo || 1}` : null;
    };
    const out = { cast: [], scene: [], prop: [] };
    for (const vid of shot.castVersionIds || []) {
        const n = lookupName(vid); if (n) out.cast.push(n);
    }
    for (const vid of shot.sceneVersionIds || []) {
        const n = lookupName(vid); if (n) out.scene.push(n);
    }
    for (const vid of shot.propVersionIds || []) {
        const n = lookupName(vid); if (n) out.prop.push(n);
    }
    return out;
}

// Best portrait source we have. Prefer front, fall back to side/back.
function _portraitSrc(version) {
    if (!version) return null;
    const s = version.sources || {};
    for (const k of ['front', 'side', 'back']) {
        if (s[k] && s[k].url) return s[k].url;
    }
    return null;
}

function _row3Cell(label, names) {
    if (!names.length) return `<div class="cell"><div class="cell-label">${label}</div><div class="cell-empty">—</div></div>`;
    return `<div class="cell"><div class="cell-label">${label}</div><div class="cell-chips">${
        names.map((n) => `<span class="chip">${_esc(n)}</span>`).join('')
    }</div></div>`;
}

function _coverSection({ projectName, title, projectSlug, generatedAt, items, shots }) {
    const counts = items.reduce((acc, it) => { acc[it.kind] = (acc[it.kind] || 0) + 1; return acc; }, {});
    const roster = items
        .slice()
        .sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || (a.name || '').localeCompare(b.name || ''))
        .map((it) => {
            const c = _kindColor(it.kind);
            return `<li class="roster-item">
                <span class="roster-kind" style="background:${c}1a;color:${c};border-color:${c}40">${_esc(_kindLabel(it.kind))}</span>
                <span class="roster-name">${_esc(it.name)}</span>
                <span class="roster-ver">v${it.versionCount || 0}</span>
            </li>`;
        }).join('');

    return `
<section class="page cover">
    <div class="hero">
        <div class="hero-eyebrow">分镜本 · STORYBOARD</div>
        <h1 class="hero-title">${_esc(title || projectName || 'Storyboard')}</h1>
        <div class="hero-meta">
            <div class="meta-cell"><div class="meta-label">项目</div><div class="meta-value">${_esc(projectName || '-')}</div></div>
            <div class="meta-cell"><div class="meta-label">生成时间</div><div class="meta-value">${_esc(_fmtDate(generatedAt))}</div></div>
            <div class="meta-cell"><div class="meta-label">素材</div><div class="meta-value">${items.length}</div></div>
            <div class="meta-cell"><div class="meta-label">镜头</div><div class="meta-value">${shots.length}</div></div>
        </div>
    </div>

    <div class="cover-row">
        <div class="cover-card">
            <h2>素材库 · Roster</h2>
            <ul class="roster">${roster || '<li class="roster-empty">暂无素材</li>'}</ul>
        </div>
        <div class="cover-card">
            <h2>目录 · Contents</h2>
            <ol class="toc">
                <li><span class="toc-num">1</span><span class="toc-title">素材库 · Library</span><span class="toc-count">${items.length} 个</span></li>
                <li><span class="toc-num">2</span><span class="toc-title">镜头 · Shots</span><span class="toc-count">${shots.length} 条</span></li>
            </ol>
            <div class="kind-legend">
                <span class="legend"><i style="background:${COLORS.character}"></i>人物 ${counts.character || 0}</span>
                <span class="legend"><i style="background:${COLORS.scene}"></i>场景 ${counts.scene || 0}</span>
                <span class="legend"><i style="background:${COLORS.prop}"></i>道具 ${counts.prop || 0}</span>
            </div>
        </div>
    </div>
</section>
`;
}

function _librarySection({ items, versionsById, itemsById }) {
    if (!items.length) {
        return `<section class="page"><h2 class="section-title">素材库 · Library</h2><p class="empty">暂无素材。</p></section>`;
    }
    return `
<section class="page library-page">
    <h2 class="section-title">素材库 · Library</h2>
    <div class="lib-grid">
        ${items.map((it) => {
            const c = _kindColor(it.kind);
            const versions = (versionsById[it.id] || []).slice();
            const cur = it.currentVersionId ? versionsById[it.id].find((v) => v.id === it.currentVersionId) : versions[0];
            const portrait = _portraitSrc(cur);
            const allViews = cur ? (cur.sources || {}) : {};
            return `
            <article class="lib-card">
                <header class="lib-card-header">
                    <span class="lib-kind" style="background:${c}1a;color:${c};border-color:${c}40">${_esc(_kindLabel(it.kind))}</span>
                    <h3 class="lib-name">${_esc(it.name)}</h3>
                    <span class="lib-ver">current v${cur ? cur.versionNo : 0}</span>
                </header>
                <div class="lib-portrait">
                    ${portrait ? `<img src="${_esc(portrait)}" alt="${_esc(it.name)}" />` : `<div class="lib-portrait-placeholder">${_esc(_kindLabel(it.kind))}</div>`}
                </div>
                <div class="lib-views">
                    ${['front', 'side', 'back'].map((k) => {
                        const v = allViews[k];
                        const src = v && v.url ? v.url : null;
                        const label = { front: '正', side: '侧', back: '背' }[k];
                        return `<div class="view"><div class="view-label">${label}</div>${src ? `<img src="${_esc(src)}" alt="" />` : `<div class="view-empty">空</div>`}</div>`;
                    }).join('')}
                </div>
                <div class="lib-meta">
                    <span class="meta-pill">${_esc(it.theme || _kindLabel(it.kind))}</span>
                    <span class="meta-pill">${versions.length} 个版本</span>
                </div>
                ${cur && cur.prompt ? `<details class="lib-prompt"><summary>提示词 · Prompt</summary><pre>${_esc(cur.prompt)}</pre></details>` : ''}
                ${cur && cur.feedback ? `<details class="lib-prompt"><summary>反馈 · Feedback</summary><pre>${_esc(cur.feedback)}</pre></details>` : ''}
            </article>`;
        }).join('')}
    </div>
</section>`;
}

function _shotsSection({ shots, versionsById, itemsById }) {
    if (!shots.length) {
        return `<section class="page"><h2 class="section-title">镜头 · Shots</h2><p class="empty">暂无镜头。</p></section>`;
    }
    const lookup = (vid) => {
        const v = versionsById[vid];
        if (!v) return null;
        const it = itemsById[v.itemId];
        return it ? `${it.name} v${v.versionNo || 1}` : null;
    };
    return `
<section class="page shots-page">
    <h2 class="section-title">镜头 · Shots</h2>
    <table class="shots-table">
        <colgroup>
            <col style="width:42px" />
            <col style="width:120px" />
            <col style="width:160px" />
            <col style="width:120px" />
            <col style="width:120px" />
            <col />
        </colgroup>
        <thead>
            <tr>
                <th>#</th>
                <th>时间</th>
                <th>人物</th>
                <th>场景</th>
                <th>道具</th>
                <th>描述 · 备注</th>
            </tr>
        </thead>
        <tbody>
            ${shots.map((s) => {
                const cast = (s.castVersionIds || []).map(lookup).filter(Boolean);
                const scene = (s.sceneVersionIds || []).map(lookup).filter(Boolean);
                const prop = (s.propVersionIds || []).map(lookup).filter(Boolean);
                return `
            <tr>
                <td class="idx">${s.index || ''}</td>
                <td class="times">${_esc(s.tIn || '')} → ${_esc(s.tOut || '')}</td>
                <td>${cast.length ? cast.map((n) => `<span class="chip character">${_esc(n)}</span>`).join('') : '<span class="cell-empty">—</span>'}</td>
                <td>${scene.length ? scene.map((n) => `<span class="chip scene">${_esc(n)}</span>`).join('') : '<span class="cell-empty">—</span>'}</td>
                <td>${prop.length ? prop.map((n) => `<span class="chip prop">${_esc(n)}</span>`).join('') : '<span class="cell-empty">—</span>'}</td>
                <td class="desc">
                    ${s.description ? `<div class="desc-line">${_esc(s.description)}</div>` : ''}
                    ${s.notes ? `<div class="notes-line">${_esc(s.notes)}</div>` : ''}
                </td>
            </tr>`;
            }).join('')}
        </tbody>
    </table>
</section>`;
}

function _css() {
    return `
:root {
    --bg: ${COLORS.bg}; --bg2: ${COLORS.bg2}; --bg3: ${COLORS.bg3};
    --line: ${COLORS.line}; --line2: ${COLORS.line2};
    --fg: ${COLORS.fg}; --fg2: ${COLORS.fg2}; --fg3: ${COLORS.fg3};
    --accent: ${COLORS.accent}; --accent2: ${COLORS.accent2};
    --err: ${COLORS.err}; --warn: ${COLORS.warn};
    --scene: ${COLORS.scene}; --prop: ${COLORS.prop}; --character: ${COLORS.character};
    --r: 6px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    padding: 24px;
}
h1, h2, h3 { margin: 0; }
.page {
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 32px 36px;
    margin: 0 auto 18px auto;
    max-width: 1240px;
    box-shadow: 0 1px 0 rgba(0,0,0,0.02);
}
.section-title {
    font-size: 11px;
    color: var(--fg3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
}

/* === Cover === */
.cover .hero {
    background: linear-gradient(135deg, #f0f6ff 0%, #f6f8fa 100%);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 30px 28px 24px;
    margin-bottom: 18px;
    position: relative;
}
.cover .hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    border-radius: 12px 12px 0 0;
}
.hero-eyebrow {
    font-size: 11px;
    color: var(--accent);
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    margin-bottom: 8px;
}
.hero-title {
    font-size: 28px;
    font-weight: 700;
    color: var(--fg);
    margin-bottom: 18px;
    line-height: 1.2;
}
.hero-meta {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    border-top: 1px solid var(--line);
    padding-top: 14px;
}
.meta-cell {
    padding: 0 14px;
    border-right: 1px solid var(--line);
}
.meta-cell:last-child { border-right: none; }
.meta-label {
    font-size: 10px;
    color: var(--fg3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
}
.meta-value {
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
}

.cover-row {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 16px;
}
.cover-card {
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 18px 20px;
}
.cover-card h2 {
    font-size: 11px;
    color: var(--fg3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 12px;
    font-weight: 700;
}

.roster {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px 16px;
}
.roster-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
}
.roster-kind {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 99px;
    border: 1px solid;
    font-weight: 600;
    min-width: 32px;
    text-align: center;
}
.roster-name { flex: 1; font-weight: 500; color: var(--fg); }
.roster-ver { color: var(--accent2); font-size: 11px; font-weight: 600; }
.roster-empty { color: var(--fg3); font-size: 12px; padding: 8px 0; }

.toc {
    list-style: none;
    padding: 0;
    margin: 0 0 12px 0;
}
.toc li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px dashed var(--line);
    font-size: 13px;
}
.toc li:last-child { border-bottom: none; }
.toc-num {
    width: 22px;
    height: 22px;
    background: var(--accent);
    color: white;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.toc-title { flex: 1; color: var(--fg); }
.toc-count { color: var(--fg3); font-size: 11px; }
.kind-legend {
    display: flex;
    gap: 14px;
    font-size: 12px;
    color: var(--fg2);
    padding-top: 8px;
    border-top: 1px solid var(--line);
}
.legend { display: flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 99px; display: inline-block; }

/* === Library === */
.lib-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
}
.lib-card {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px;
    background: var(--bg2);
    page-break-inside: avoid;
}
.lib-card-header {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
}
.lib-kind {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 99px;
    font-weight: 600;
    border: 1px solid;
}
.lib-name {
    flex: 1;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.lib-ver {
    font-size: 11px;
    color: var(--accent2);
    font-weight: 700;
    background: var(--accent2)1a;
    padding: 1px 6px;
    border-radius: 99px;
}
.lib-portrait {
    width: 100%;
    aspect-ratio: 16/10;
    background: var(--bg3);
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 8px;
}
.lib-portrait img { width: 100%; height: 100%; object-fit: cover; }
.lib-portrait-placeholder {
    color: var(--fg3);
    font-size: 22px;
    font-weight: 600;
}
.lib-views {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 8px;
}
.view {
    background: var(--bg3);
    border-radius: 4px;
    aspect-ratio: 1/1;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
}
.view img { width: 100%; height: 100%; object-fit: cover; }
.view-label {
    position: absolute;
    top: 3px;
    left: 3px;
    background: rgba(31,35,40,0.85);
    color: white;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 99px;
    font-weight: 600;
}
.view-empty { color: var(--fg3); font-size: 10px; }
.lib-meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 4px;
}
.meta-pill {
    background: var(--bg3);
    color: var(--fg2);
    padding: 2px 8px;
    border-radius: 99px;
    font-size: 11px;
}
.lib-prompt {
    margin-top: 6px;
    font-size: 11px;
    color: var(--fg2);
}
.lib-prompt summary {
    cursor: pointer;
    color: var(--accent);
    font-weight: 600;
    padding: 2px 0;
}
.lib-prompt pre {
    background: var(--bg3);
    border-radius: 4px;
    padding: 6px 8px;
    margin: 4px 0 0 0;
    font-family: ui-monospace, "JetBrains Mono", "Consolas", monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
}

/* === Shots === */
.shots-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
}
.shots-table th, .shots-table td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    vertical-align: top;
    font-size: 12px;
}
.shots-table th {
    background: var(--bg3);
    color: var(--fg3);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
}
.shots-table tr:last-child td { border-bottom: none; }
.shots-table .idx {
    color: var(--fg3);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
}
.shots-table .times {
    font-variant-numeric: tabular-nums;
    color: var(--fg2);
    font-weight: 600;
}
.shots-table .desc .desc-line {
    color: var(--fg);
    margin-bottom: 3px;
    line-height: 1.5;
}
.shots-table .desc .notes-line {
    color: var(--fg3);
    font-size: 11px;
    font-style: italic;
}
.cell-empty { color: var(--fg3); }
.chip {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 99px;
    background: var(--bg3);
    color: var(--fg2);
    font-size: 11px;
    margin: 1px 3px 1px 0;
    border: 1px solid var(--line);
}
.chip.character { background: #f5f0ff; color: var(--character); border-color: #d0baff; }
.chip.scene { background: #ddf4ff; color: var(--scene); border-color: #b6e3ff; }
.chip.prop { background: #fff8c5; color: var(--prop); border-color: #eac54f; }
.empty {
    color: var(--fg3);
    text-align: center;
    padding: 30px;
    font-size: 13px;
}

/* === Print === */
@media print {
    body { background: white; padding: 0; }
    .page {
        max-width: none;
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
        padding: 18mm 16mm;
        page-break-after: always;
        break-after: page;
    }
    .page:last-child { page-break-after: auto; }
    .lib-card { break-inside: avoid; }
    .cover-row { break-inside: avoid; }
    .meta-pill, .chip { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .lib-kind, .toc-num { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .hero::before { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}

// Build the printable HTML. `data` shape:
//   {
//     title, projectName, projectSlug, generatedAt,
//     items: [{id, kind, name, theme, versionCount, currentVersionId}],
//     versions: [{id, itemId, versionNo, prompt, feedback, sources}],
//     shots: [{id, index, tIn, tOut, description, notes, castVersionIds, sceneVersionIds, propVersionIds}]
//   }
function renderStoryboardHtml(data) {
    const items = data.items || [];
    const versions = data.versions || [];
    const shots = data.shots || [];

    // Build lookup tables so we can flatten the data model.
    const itemsById = Object.fromEntries(items.map((it) => [it.id, it]));
    const versionsById = {};
    for (const v of versions) {
        if (!versionsById[v.itemId]) versionsById[v.itemId] = [];
        versionsById[v.itemId].push(v);
    }
    for (const k of Object.keys(versionsById)) {
        versionsById[k].sort((a, b) => (a.versionNo || 0) - (b.versionNo || 0));
    }

    const body = [
        _coverSection({
            projectName: data.projectName || data.project,
            title: data.title,
            projectSlug: data.projectSlug,
            generatedAt: data.generatedAt || new Date().toISOString(),
            items,
            shots,
        }),
        _librarySection({ items, versionsById, itemsById }),
        _shotsSection({ shots, versionsById, itemsById }),
    ].join('\n');

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${_esc(data.title || data.projectName || 'Storyboard')}</title>
<style>${_css()}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// Write the HTML to disk. Returns absolute path.
function writeStoryboardHtml(data, outDir) {
    const html = renderStoryboardHtml(data);
    fs.mkdirSync(outDir, { recursive: true });
    const slug = (data.projectSlug || data.projectName || 'storyboard').toString()
        .replace(/[\s/\\:?*"<>|]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'storyboard';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fname = `${slug}-${stamp}.html`;
    const fp = path.join(outDir, fname);
    fs.writeFileSync(fp, html, 'utf8');
    return { html, path: fp, filename: fname };
}

module.exports = { renderStoryboardHtml, writeStoryboardHtml };
