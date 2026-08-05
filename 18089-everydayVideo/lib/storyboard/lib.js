// storyboard/lib.js
// Typed library model for the storyboard subsystem.
//
// Master clarified:
//   1) characters include 人 / 动物 / 卡通 / 物品 — anything visual
//      that the camera can focus on. So instead of a single "character"
//      table we keep ONE typed library:
//        { items: [{ id, kind: 'character'|'scene'|'prop', name, theme, tags }] }
//      Each item has its own version history, with branches and a
//      current pointer. Cast / scene / prop slots in shots pin a
//      specific versionId.
//   2) the library hosts multiple projects. Every entity (item,
//      version, shot) hangs off a projectId. Lulu was just one
//      project. OBS upload keys use <bucket>_<projectSlug>_<filename>
//      so projects don't collide.
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
    projects: path.join(CONFIG_DIR, 'storyboard-projects.json'),
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

// Slugify a project name into a safe OBS key segment. Keeps CJK
// characters (preserved by OBS as long as no /) but normalizes
// whitespace and strips separators the dimond namespace dislikes.
function _slug(s) {
    return String(s || '')
        .replace(/[\s/\\:?*"<>|]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'project';
}

// ----- projects -----

function listProjects() {
    return readJSON(FILES.projects, { projects: [] }).projects;
}

function getProject(id) {
    return listProjects().find((p) => p.id === id) || null;
}

function getDefaultProjectId() {
    const ps = listProjects();
    if (!ps.length) return null;
    return ps[0].id;
}

function ensureDefaultProject() {
    // Backfill a default project if none exists AND there is legacy data.
    // If everything is already project-scoped, this is a no-op.
    let ps = listProjects();
    const items = readJSON(FILES.items, { items: [] }).items;
    const orphan = items.some((x) => !x.projectId);
    if (!ps.length && orphan) {
        const proj = createProject({ name: '噜噜的天空', slug: 'lulu_sky' });
        const allItems = items.map((x) => ({ ...x, projectId: x.projectId || proj.id }));
        writeJSON(FILES.items, { items: allItems });
        const allVers = listVersions().map((v) => {
            const owner = allItems.find((x) => x.id === v.itemId);
            return owner && owner.projectId ? { ...v, projectId: owner.projectId } : v;
        });
        writeJSON(FILES.versions, { versions: allVers });
        const allShots = listShotsRaw().map((s) => ({ ...s, projectId: proj.id }));
        writeJSON(FILES.shots, { shots: allShots });
        ps = [proj];
    }
    if (!ps.length) {
        const proj = createProject({ name: '默认项目', slug: 'default' });
        ps = [proj];
    }
    return ps;
}

function createProject({ name, slug }) {
    const all = listProjects();
    const id = _newId('sb-proj');
    const proj = {
        id,
        name: (name || '新项目').toString().slice(0, 64),
        slug: _slug(slug || name || id),
        createdAt: nowIso(),
    };
    all.push(proj);
    writeJSON(FILES.projects, { projects: all });
    return proj;
}

function updateProject(id, patch) {
    const all = listProjects();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return null;
    if (patch.slug) patch.slug = _slug(patch.slug);
    if (patch.name) patch.name = String(patch.name).slice(0, 64);
    all[i] = { ...all[i], ...patch };
    writeJSON(FILES.projects, { projects: all });
    return all[i];
}

function deleteProject(id) {
    // Cascade: remove items, versions, shots that hang off this project.
    const items = listItemsRaw().filter((x) => x.projectId !== id);
    writeJSON(FILES.items, { items });
    const itemIds = new Set(items.map((x) => x.id));
    const versions = listVersionsRaw().filter((v) => itemIds.has(v.itemId));
    writeJSON(FILES.versions, { versions });
    const shots = listShotsRaw().filter((s) => s.projectId !== id);
    writeJSON(FILES.shots, { shots });
    const projects = listProjects().filter((x) => x.id !== id);
    writeJSON(FILES.projects, { projects });
}

// ----- library items -----

function listItemsRaw() {
    return readJSON(FILES.items, { items: [] }).items;
}

function listItems({ kind, projectId } = {}) {
    const all = listItemsRaw();
    return all
        .filter((x) => projectId ? x.projectId === projectId : true)
        .filter((x) => kind ? x.kind === kind : true);
}

function getItem(id) {
    return listItemsRaw().find((x) => x.id === id) || null;
}

function createItem({ name, kind = 'character', theme = '', tags = [], projectId }) {
    if (!KINDS.includes(kind)) kind = 'character';
    if (!projectId) {
        ensureDefaultProject();
        projectId = getDefaultProjectId();
    }
    if (!getProject(projectId)) return null;
    const all = listItemsRaw();
    const id = _newId(`sb-${kind}`);
    const item = {
        id,
        projectId,
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
    const all = listItemsRaw();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return null;
    if (patch.projectId && !getProject(patch.projectId)) {
        delete patch.projectId;
    }
    all[i] = { ...all[i], ...patch };
    writeJSON(FILES.items, { items: all });
    return all[i];
}

function deleteItem(id) {
    const all = listItemsRaw().filter((x) => x.id !== id);
    writeJSON(FILES.items, { items: all });
    const v = listVersionsRaw().filter((x) => x.itemId !== id);
    writeJSON(FILES.versions, { versions: v });
}

// ----- versions -----

function listVersionsRaw() {
    return readJSON(FILES.versions, { versions: [] }).versions;
}

function listVersions({ projectId } = {}) {
    const all = listVersionsRaw();
    if (!projectId) return all;
    const items = listItemsRaw();
    const pids = new Set(items.filter((x) => x.projectId === projectId).map((x) => x.id));
    return all.filter((v) => pids.has(v.itemId));
}

function getVersion(id) {
    return listVersionsRaw().find((v) => v.id === id) || null;
}

function versionsOf(itemId) {
    return listVersionsRaw()
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
        projectId: item.projectId,
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
    const all = listVersionsRaw();
    all.push(ver);
    writeJSON(FILES.versions, { versions: all });
    _dropAfterAndPromote(item, ver);
    return { ok: true, version: ver, item: getItem(itemId) };
}

function _dropAfterAndPromote(item, ver) {
    const all = listVersionsRaw();
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

function listShotsRaw() {
    return readJSON(FILES.shots, { shots: [] }).shots;
}

function _readShots() {
    return listShotsRaw();
}

function listShots({ projectId } = {}) {
    const all = listShotsRaw();
    return all
        .filter((s) => projectId ? s.projectId === projectId : true)
        .sort((a, b) => (a.index || 0) - (b.index || 0));
}

function getShot(id) {
    return listShotsRaw().find((s) => s.id === id) || null;
}

function createShot({ tIn = '00:00', tOut = '00:05', description = '', notes = '', projectId } = {}) {
    if (!projectId) {
        ensureDefaultProject();
        projectId = getDefaultProjectId();
    }
    if (!getProject(projectId)) return null;
    const all = listShotsRaw();
    // Index within project only.
    const peers = all.filter((s) => s.projectId === projectId);
    const id = _newId('sb-shot');
    const shot = {
        id,
        projectId,
        index: peers.length ? Math.max(...peers.map((s) => s.index || 0)) + 1 : 1,
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
    const all = listShotsRaw();
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) return null;
    if (patch.projectId && !getProject(patch.projectId)) {
        delete patch.projectId;
    }
    const cur = all[i];
    const next = { ...cur, ...patch, versionNo: (cur.versionNo || 1) + 1, updatedAt: nowIso() };
    next.parentShotId = cur.parentShotId || cur.id;
    all[i] = next;
    writeJSON(FILES.shots, { shots: all });
    return next;
}

function deleteShot(id) {
    const all = listShotsRaw().filter((s) => s.id !== id);
    writeJSON(FILES.shots, { shots: all });
}

function reorderShots(orderedIds) {
    const all = listShotsRaw();
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
        obsEndpoint: 'http://obs.dimond.top',
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
    listProjects, getProject, getDefaultProjectId, ensureDefaultProject,
    createProject, updateProject, deleteProject,
    listItems, listItemsRaw, getItem, createItem, updateItem, deleteItem,
    listVersions, listVersionsRaw, getVersion, versionsOf, createVersion, setCurrentVersion,
    listShots, listShotsRaw, getShot, createShot, updateShot, deleteShot, reorderShots,
    addVersionToShot, removeVersionFromShot,
    getConfig, setConfig, recordExport,
    nowIso,
};