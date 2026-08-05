// storyboard/lib.js
// Typed library model for the storyboard subsystem.
//
// Master clarified: characters include 人 / 动物 / 卡通 / 物品 —
// anything visual that the camera can focus on. So instead of a single
// "character" table we keep ONE typed library:
//
//   { items: [{ id, kind: 'character'|'scene'|'prop', name, theme, tags }] }
//
// Each item has its own version history, with branches and a current
// pointer. Cast / scene / prop slots in shots pin a specific versionId.
//
// All state lives in JSON files under config/. No DB, no dependency on
// the existing studio subsystem.

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const ASSETS_DIR = path.join(PROJECT_DIR, 'studio-assets', 'storyboard');
const UPLOAD_DIR = path.join(ASSETS_DIR, 'uploads');
const EXPORT_DIR = path.join(ASSETS_DIR, 'exports');

const FILES = {
    cfg: path.join(CONFIG_DIR, 'storyboard.json'),
    items: path.join(CONFIG_DIR, 'storyboard-library.json'),
    versions: path.join(CONFIG_DIR, 'storyboard-library-versions.json'),
    shots: path.join(CONFIG_DIR, 'storyboard-shots.json'),
};

const KINDS = ['character', 'scene', 'prop'];

function _ensureDirs() {
    [CONFIG_DIR, ASSETS_DIR, UPLOAD_DIR, EXPORT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function readJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { /* corrupt */ }
    return fallback;
}

function writeJSON(file, data) {
    _ensureDirs();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

function nowIso() { return new Date().toISOString(); }

function _newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// ----- library items -----

function listItems({ kind } = {}) {
    const all = readJSON(FILES.items, { items: [] }).items;
    return kind ? all.filter((x) => x.kind === kind) : all;
}

function getItem(id) {
    return listItems().find((x) => x.id === id) || null;
}

function createItem({ name, kind = 'character', theme = '', tags = [] }) {
    if (!KINDS.includes(kind)) kind = 'character';
    const all = listItems();
    const id = _newId(`sb-${kind}`);
    const item = {
        id,
        kind,
        name: (name || kind).toString().slice(0, 64),
        theme: (theme || '').slice(0, 200),
        tags: Array.isArray(tags) ? tags.slice(0, 12).map(String) : [],
        createdAt: nowIso(),
        currentVersionId: null,
        versionCount: 0,
    };
    all.push(item);
    writeJSON(FILES.items, { items: all });
    return item;
}

function updateItem(id, patch) {
    const all = listItems();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch };
    writeJSON(FILES.items, { items: all });
    return all[i];
}

function deleteItem(id) {
    const all = listItems().filter((x) => x.id !== id);
    writeJSON(FILES.items, { items: all });
    const v = listVersions().filter((x) => x.itemId !== id);
    writeJSON(FILES.versions, { versions: v });
}

// ----- versions -----

function listVersions() {
    return readJSON(FILES.versions, { versions: [] }).versions;
}

function getVersion(id) {
    return listVersions().find((v) => v.id === id) || null;
}

function versionsOf(itemId) {
    return listVersions()
        .filter((v) => v.itemId === itemId)
        .sort((a, b) => (a.versionNo || 0) - (b.versionNo || 0));
}

function nextVersionNo(itemId) {
    const vs = versionsOf(itemId);
    return vs.length ? Math.max(...vs.map((v) => v.versionNo || 0)) + 1 : 1;
}

// sources: { front, side, back } each = { kind: 'upload'|'obs'|'auto', path?, obsKey?, url? }
function createVersion({ itemId, parentVersionId = null, feedback = '', sources = {}, prompt = '', createdBy = 'agent' }) {
    const item = getItem(itemId);
    if (!item) return { ok: false, error: 'item not found' };
    const versionNo = nextVersionNo(itemId);
    const id = _newId(`sb-ver-${item.kind}`);
    const ver = {
        id,
        itemId,
        kind: item.kind,
        parentVersionId,
        versionNo,
        prompt: (prompt || '').slice(0, 2000),
        feedback: (feedback || '').slice(0, 4000),
        sources: {
            front: sources.front || null,
            side: sources.side || null,
            back: sources.back || null,
        },
        createdAt: nowIso(),
        createdBy,
    };
    const all = listVersions();
    all.push(ver);
    writeJSON(FILES.versions, { versions: all });
    _dropAfterAndPromote(item, ver);
    return { ok: true, version: ver, item: getItem(itemId) };
}

function _dropAfterAndPromote(item, ver) {
    const all = listVersions();
    const keep = all.filter((v) => {
        if (v.itemId !== item.id) return true;
        return (v.versionNo || 0) <= (ver.versionNo || 0);
    });
    if (keep.length !== all.length) writeJSON(FILES.versions, { versions: keep });
    updateItem(item.id, { currentVersionId: ver.id, versionCount: versionsOf(item.id).length });
}

function setCurrentVersion(itemId, versionId) {
    const item = getItem(itemId);
    if (!item) return { ok: false, error: 'item not found' };
    const v = getVersion(versionId);
    if (!v || v.itemId !== itemId) return { ok: false, error: 'version not found' };
    _dropAfterAndPromote(item, v);
    return { ok: true, item: getItem(itemId) };
}

// ----- shots -----

function _readShots() {
    return readJSON(FILES.shots, { shots: [] }).shots;
}

function listShots() {
    return _readShots().sort((a, b) => (a.index || 0) - (b.index || 0));
}

function getShot(id) {
    return _readShots().find((s) => s.id === id) || null;
}

function createShot({ tIn = '00:00', tOut = '00:05', description = '', notes = '' } = {}) {
    const all = _readShots();
    const id = _newId('sb-shot');
    const shot = {
        id,
        index: all.length ? Math.max(...all.map((s) => s.index || 0)) + 1 : 1,
        tIn,
        tOut,
        castVersionIds: [],
        sceneVersionIds: [],
        propVersionIds: [],
        description,
        notes,
        versionNo: 1,
        parentShotId: null,
        updatedAt: nowIso(),
    };
    all.push(shot);
    writeJSON(FILES.shots, { shots: all });
    return shot;
}

function updateShot(id, patch) {
    const all = _readShots();
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const cur = all[i];
    const next = { ...cur, ...patch, versionNo: (cur.versionNo || 1) + 1, updatedAt: nowIso() };
    next.parentShotId = cur.parentShotId || cur.id;
    all[i] = next;
    writeJSON(FILES.shots, { shots: all });
    return next;
}

function deleteShot(id) {
    const all = _readShots().filter((s) => s.id !== id);
    writeJSON(FILES.shots, { shots: all });
}

function reorderShots(orderedIds) {
    const all = _readShots();
    const map = new Map(all.map((s) => [s.id, s]));
    const out = [];
    orderedIds.forEach((id, idx) => {
        const s = map.get(id);
        if (s) { s.index = idx + 1; s.updatedAt = nowIso(); out.push(s); map.delete(id); }
    });
    for (const rest of map.values()) out.push(rest);
    writeJSON(FILES.shots, { shots: all.map((s) => {
        const o = out.find((x) => x.id === s.id);
        return o || s;
    }) });
    return out;
}

function addVersionToShot(shotId, versionId, slot = 'cast') {
    const s = getShot(shotId);
    if (!s) return null;
    const key = slot === 'scene' ? 'sceneVersionIds' : (slot === 'prop' ? 'propVersionIds' : 'castVersionIds');
    const ids = Array.from(new Set([...(s[key] || []), versionId]));
    return updateShot(shotId, { [key]: ids });
}

function removeVersionFromShot(shotId, versionId, slot = 'cast') {
    const s = getShot(shotId);
    if (!s) return null;
    const key = slot === 'scene' ? 'sceneVersionIds' : (slot === 'prop' ? 'propVersionIds' : 'castVersionIds');
    const ids = (s[key] || []).filter((x) => x !== versionId);
    return updateShot(shotId, { [key]: ids });
}

// ----- config -----

function getConfig() {
    return readJSON(FILES.cfg, {
        obsEndpoint: '',
        obsBucket: 'hermit-claw',
        obsApiKey: '',
        pdfFooter: 'Hermit-Claw · storyboard',
        exports: [],
        updatedAt: nowIso(),
    });
}

function setConfig(patch) {
    const cur = getConfig();
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    writeJSON(FILES.cfg, next);
    return next;
}

function recordExport(entry) {
    const cur = getConfig();
    const list = Array.isArray(cur.exports) ? cur.exports : [];
    list.unshift(entry);
    cur.exports = list.slice(0, 50);
    writeJSON(FILES.cfg, cur);
    return cur;
}

module.exports = {
    FILES, ASSETS_DIR, UPLOAD_DIR, EXPORT_DIR, KINDS,
    listItems, getItem, createItem, updateItem, deleteItem,
    listVersions, getVersion, versionsOf, createVersion, setCurrentVersion,
    listShots, getShot, createShot, updateShot, deleteShot, reorderShots,
    addVersionToShot, removeVersionFromShot,
    getConfig, setConfig, recordExport,
    nowIso,
};