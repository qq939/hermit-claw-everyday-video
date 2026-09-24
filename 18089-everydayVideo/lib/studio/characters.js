// studio/characters.js
// Character pool + persistence. Each character = { id, name, style,
// promptSeed, palette, voice, assetPath, assetUrl, createdFrom,
// lastUsedAt, usageCount, createdAt }.
//
// ensure({ role, theme, ... }) returns existing character matching the
//   role if found and fresh, otherwise creates one with fal.ai or the
//   local-poster fallback.
//
// attach({ workId, role }) records a binding between a work and a
//   character. The actual asset reuse is up to composers.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readJSON, writeJSON, nowIso } = require('./core/json-store');
const { appendStudioLog } = require('./core/logger');
const providerRegistry = require('./core/provider-registry');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const CHARACTERS_FILE = path.join(CONFIG_DIR, 'studio-characters.json');
const MAX_POOL = 24;

function _load() {
    return readJSON(CHARACTERS_FILE, { characters: [] });
}

function _save(data) {
    writeJSON(CHARACTERS_FILE, data);
}

function _persistChar(c) {
    const data = _load();
    const i = data.characters.findIndex((x) => x.id === c.id);
    if (i >= 0) data.characters[i] = c;
    else data.characters.push(c);
    _save(data);
}

function _evictIfOver(data) {
    if (data.characters.length <= MAX_POOL) return;
    data.characters.sort((a, b) => (a.usageCount || 0) - (b.usageCount || 0));
    while (data.characters.length > MAX_POOL) {
        const removed = data.characters.shift();
        try { if (removed.assetPath && fs.existsSync(removed.assetPath)) fs.unlinkSync(removed.assetPath); } catch (_) {}
        appendStudioLog(`characters: evicted ${removed.id} (${removed.name})`, { always: true });
    }
    _save(data);
}

function list() {
    return _load().characters.sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
}

function get(id) {
    return _load().characters.find((c) => c.id === id) || null;
}

function _newId() {
    return `char-${crypto.randomBytes(6).toString('hex')}`;
}

function _nameFor(role, theme) {
    const base = (theme || role || 'character').toString().split(/\s+/).slice(0, 3).join(' ');
    return `${role || 'agent'}-${base}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
}

function _findFresh(role) {
    if (!role) return null;
    const data = _load();
    const now = Date.now();
    const ONE_DAY = 24 * 3600 * 1000;
    const candidates = data.characters.filter((c) => c.role === role);
    candidates.sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
    for (const c of candidates) {
        const lu = c.lastUsedAt ? new Date(c.lastUsedAt).getTime() : 0;
        if (now - lu < ONE_DAY) return c;
    }
    return null;
}

async function ensure({ role = 'agent', theme = '', style = 'editorial-portrait', palette, voice } = {}) {
    const fresh = _findFresh(role);
    if (fresh) {
        fresh.usageCount = (fresh.usageCount || 0) + 1;
        fresh.lastUsedAt = nowIso();
        _persistChar(fresh);
        return { ok: true, reused: true, character: fresh };
    }

    // Create new character. Try fal.ai first, fall back to local-poster.
    const name = _nameFor(role, theme);
    const char = {
        id: _newId(),
        role,
        name,
        theme,
        style,
        promptSeed: theme || role,
        palette: palette || ['#0d1117', '#58a6ff', '#7ee787', '#bc8cff'],
        voice: voice || 'calm-editorial',
        assetPath: null,
        assetUrl: null,
        provider: null,
        seed: null,
        createdFrom: 'studio.ensure',
        createdAt: nowIso(),
        lastUsedAt: nowIso(),
        usageCount: 1,
    };

    let generated = null;
    const fal = providerRegistry.get('fal');
    if (fal && fal.enabled) {
        const prompt = `${theme || role}, ${style}, editorial portrait, soft cinematic light, ${char.palette.join(' ')} color palette`;
        generated = await providerRegistry.runProvider('fal', { kind: 'image', prompt, image_size: 'portrait_4_3' });
        if (generated && generated.ok) {
            char.assetPath = generated.path;
            char.assetUrl = generated.assetUrl;
            char.provider = 'fal';
            char.seed = generated.seed || null;
        }
    }
    if (!generated || !generated.ok) {
        generated = await providerRegistry.runProvider('local-poster', {
            title: name,
            subtitle: theme || role,
            paletteSeed: char.promptSeed,
        });
        if (generated && generated.ok) {
            char.assetPath = generated.path;
            char.assetUrl = generated.assetUrl;
            char.provider = 'local-poster';
        }
    }
    if (!generated || !generated.ok) {
        appendStudioLog(`characters: ensure failed role=${role} err=${generated && generated.error}`, { always: true });
        return { ok: false, error: 'all providers failed', character: null };
    }

    _persistChar(char);
    const data = _load();
    _evictIfOver(data);
    appendStudioLog(`characters: created ${char.id} role=${role} provider=${char.provider}`, { always: true });
    return { ok: true, reused: false, character: char, generated };
}

function touch(id) {
    const c = get(id);
    if (!c) return null;
    c.lastUsedAt = nowIso();
    c.usageCount = (c.usageCount || 0) + 1;
    _persistChar(c);
    return c;
}

function attach({ workId, characterId }) {
    const data = readJSON(path.join(CONFIG_DIR, 'studio-ledger.json'), { works: [] });
    const w = data.works.find((x) => x.id === workId);
    if (!w) return { ok: false, error: 'work not found' };
    w.characterId = characterId;
    writeJSON(path.join(CONFIG_DIR, 'studio-ledger.json'), data);
    return { ok: true, work: w };
}

module.exports = { list, get, ensure, touch, attach, CHARACTERS_FILE };