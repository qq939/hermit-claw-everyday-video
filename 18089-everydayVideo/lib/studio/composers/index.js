// studio/composers/index.js
// Dispatch a parsed instruction to the right composer.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readJSON, writeJSON, nowIso } = require('../core/json-store');
const { appendStudioLog } = require('../core/logger');
const providerRegistry = require('../core/provider-registry');
const characters = require('../characters');

const LEDGER_FILE = path.join(__dirname, '..', '..', 'config', 'studio-ledger.json');

function _newWorkId() { return `w-${crypto.randomBytes(6).toString('hex')}`; }

function _recordWork(entry) {
    const data = readJSON(LEDGER_FILE, { works: [] });
    data.works.push(entry);
    writeJSON(LEDGER_FILE, data);
    return entry;
}

function _summarizeTheme(args) {
    return (args || '').trim() || 'untitled';
}

async function _ensureCharacter({ role, theme }) {
    const r = await characters.ensure({ role, theme });
    return r && r.character ? r.character : null;
}

async function composePoster({ args, ctx = {} } = {}) {
    const theme = _summarizeTheme(args);
    const char = ctx.character || (await _ensureCharacter({ role: 'agent', theme }));
    const paletteSeed = char ? char.promptSeed : theme;
    // Try fal first, then local-poster.
    let generated;
    if (char && char.assetPath && fs.existsSync(char.assetPath)) {
        generated = { ok: true, kind: 'image', path: char.assetPath, assetUrl: char.assetUrl, provider: 'character-reuse' };
    } else {
        generated = await providerRegistry.runProvider('fal', {
            kind: 'image',
            prompt: `${theme}, poster art, bold typography, ${(char && char.palette) || ''}`,
            image_size: 'landscape_4_3',
        });
        if (!generated.ok) {
            generated = await providerRegistry.runProvider('local-poster', {
                title: theme,
                subtitle: char ? `${char.role} · ${char.name}` : 'Hermit-Claw',
                paletteSeed,
            });
        }
    }
    const work = {
        id: _newWorkId(),
        kind: 'poster',
        title: theme,
        theme,
        characterId: char ? char.id : null,
        provider: generated && generated.provider,
        assetPath: generated && generated.path,
        assetUrl: generated && generated.assetUrl,
        bytes: generated && generated.bytes,
        status: generated && generated.ok ? 'ok' : 'failed',
        error: generated && generated.ok ? null : (generated && generated.error),
        createdAt: nowIso(),
    };
    _recordWork(work);
    appendStudioLog(`compose: poster work=${work.id} status=${work.status}`, { always: true });
    return work;
}

async function composeReel({ args, ctx = {} } = {}) {
    const theme = _summarizeTheme(args);
    const char = ctx.character || (await _ensureCharacter({ role: 'agent', theme }));
    // A reel = storyboard text + optional cover image. We never try to
    // render video locally — too heavy for 228MB cgroup.
    const m = String(args || '').match(/(\d+)\s*s/);
    const durationSec = m ? Math.max(8, Math.min(180, parseInt(m[1]))) : 30;
    const storyboard = [
        { t: 0, sec: 0, shot: '定场镜头', desc: `${theme}，开场光斑，` },
        { t: 1, sec: Math.round(durationSec * 0.25), shot: '主体登场', desc: '主理人走入画面，配字幕' },
        { t: 2, sec: Math.round(durationSec * 0.55), shot: '节奏推进', desc: '画面切到工作台 / 调色板 / 笔记本' },
        { t: 3, sec: Math.round(durationSec * 0.8), shot: '结语', desc: '主题文字 + 角色签名' },
    ];
    let cover = null;
    const falAttempt = await providerRegistry.runProvider('fal', {
        kind: 'image',
        prompt: `${theme}, cinematic still, anamorphic, ${durationSec}s reel cover, ${char ? char.palette.join(' ') : ''}`,
        image_size: 'landscape_16_9',
    });
    if (falAttempt.ok) cover = { path: falAttempt.path, assetUrl: falAttempt.assetUrl, provider: 'fal' };
    const work = {
        id: _newWorkId(),
        kind: 'reel',
        title: `${theme} (${durationSec}s)`,
        theme,
        characterId: char ? char.id : null,
        durationSec,
        storyboard,
        cover,
        status: 'script-only',
        note: '不渲染视频；交付文案 + 分镜 + 封面',
        createdAt: nowIso(),
    };
    _recordWork(work);
    appendStudioLog(`compose: reel work=${work.id} duration=${durationSec}s`, { always: true });
    return work;
}

async function composeCarousel({ args, ctx = {} } = {}) {
    const theme = _summarizeTheme(args);
    const char = ctx.character || (await _ensureCharacter({ role: 'agent', theme }));
    const slides = [0, 1, 2, 3, 4].map((i) => ({
        idx: i,
        title: i === 0 ? theme : `${theme} · ${i}`,
        body: `Slide ${i + 1} body for ${theme}`,
        palette: char ? char.palette : ['#0d1117', '#58a6ff'],
    }));
    const cover = await providerRegistry.runProvider('fal', {
        kind: 'image',
        prompt: `${theme}, carousel cover, vertical 4:5, editorial`,
        image_size: 'portrait_4_3',
    });
    const work = {
        id: _newWorkId(),
        kind: 'carousel',
        title: theme,
        theme,
        characterId: char ? char.id : null,
        slides,
        cover: cover.ok ? { path: cover.path, assetUrl: cover.assetUrl, provider: 'fal' } : null,
        coverStatus: cover.ok ? 'ok' : 'degraded',
        status: 'script-only',
        createdAt: nowIso(),
    };
    _recordWork(work);
    appendStudioLog(`compose: carousel work=${work.id} slides=${slides.length}`, { always: true });
    return work;
}

async function composeLongform({ args, ctx = {} } = {}) {
    const theme = _summarizeTheme(args);
    const char = ctx.character || (await _ensureCharacter({ role: 'agent', theme }));
    const generated = await providerRegistry.runProvider('local-longform', {
        title: theme,
        subtitle: char ? `${char.role} · ${char.name}` : 'Hermit-Claw',
        body: `_（等待 Agent 补全正文，或在控制台用 chatGPT 直接成稿后粘贴）_\n\n主题：${theme}`,
        palette: char ? char.palette : null,
    });
    const work = {
        id: _newWorkId(),
        kind: 'longform',
        title: theme,
        theme,
        characterId: char ? char.id : null,
        assetPath: generated && generated.path,
        assetUrl: generated && generated.assetUrl,
        bytes: generated && generated.bytes,
        status: generated && generated.ok ? 'ok' : 'failed',
        createdAt: nowIso(),
    };
    _recordWork(work);
    appendStudioLog(`compose: longform work=${work.id} status=${work.status}`, { always: true });
    return work;
}

async function composeGif({ args, ctx = {} } = {}) {
    const theme = _summarizeTheme(args);
    const char = ctx.character || (await _ensureCharacter({ role: 'agent', theme }));
    const generated = await providerRegistry.runProvider('local-gif', {
        title: theme,
        subtitle: char ? char.role : 'studio',
        frames: 8,
        durationMs: 2400,
    });
    const work = {
        id: _newWorkId(),
        kind: 'gif',
        title: theme,
        theme,
        characterId: char ? char.id : null,
        assetPath: generated && generated.path,
        assetUrl: generated && generated.assetUrl,
        bytes: generated && generated.bytes,
        mime: generated && generated.mime,
        provider: generated && generated.provider,
        status: generated && generated.ok ? 'ok' : 'failed',
        createdAt: nowIso(),
    };
    _recordWork(work);
    appendStudioLog(`compose: gif work=${work.id} status=${work.status}`, { always: true });
    return work;
}

async function composePortrait({ args, ctx = {} } = {}) {
    const theme = _summarizeTheme(args);
    const char = await characters.ensure({ role: ctx.role || 'agent', theme });
    const work = {
        id: _newWorkId(),
        kind: 'portrait',
        title: `${char && char.character ? char.character.name : 'character'} · ${theme}`,
        theme,
        characterId: char && char.character ? char.character.id : null,
        assetPath: char && char.character ? char.character.assetPath : null,
        assetUrl: char && char.character ? char.character.assetUrl : null,
        status: char && char.ok ? 'ok' : 'failed',
        error: char && char.ok ? null : (char && char.error),
        createdAt: nowIso(),
    };
    _recordWork(work);
    appendStudioLog(`compose: portrait work=${work.id}`, { always: true });
    return work;
}

const COMPOSERS = {
    '!poster': composePoster,
    '!reel': composeReel,
    '!carousel': composeCarousel,
    '!longform': composeLongform,
    '!gif': composeGif,
    '!portrait': composePortrait,
};

async function dispatch({ verb, args, ctx = {} } = {}) {
    const fn = COMPOSERS[verb];
    if (!fn) return { ok: false, error: `unknown verb: ${verb}` };
    try {
        const work = await fn({ args: args || '', ctx });
        return { ok: true, work };
    } catch (e) {
        appendStudioLog(`compose: ${verb} crashed: ${e.message}`, { always: true });
        return { ok: false, error: e.message };
    }
}

function listWorks({ limit = 30 } = {}) {
    const data = readJSON(LEDGER_FILE, { works: [] });
    return data.works.slice(-limit).reverse();
}

function getWork(id) {
    const data = readJSON(LEDGER_FILE, { works: [] });
    return data.works.find((w) => w.id === id) || null;
}

module.exports = { dispatch, listWorks, getWork, COMPOSERS };