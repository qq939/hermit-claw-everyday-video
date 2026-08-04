// studio/core/provider-registry.js
// Registry of all studio providers. Each provider reports its
// enabled/disabled status without throwing — any failure → disabled.
//
// Adding a provider: drop a file in providers/ that exports
//   { id, kind, label, probe(), isEnabled(), run(request, ctx) }
// and call registerProvider() once at boot.

const fs = require('fs');
const path = require('path');

const PROVIDERS = [];

function registerProvider(p) {
    if (!p || !p.id) return;
    PROVIDERS.push({
        kind: 'unknown',
        enabled: false,
        label: p.id,
        ...p,
    });
}

async function refreshAll() {
    const out = [];
    for (const p of PROVIDERS) {
        try {
            const status = await p.probe();
            p.enabled = !!(status && status.enabled);
            p.detail = status || {};
        } catch (e) {
            p.enabled = false;
            p.detail = { error: e.message || String(e) };
        }
        out.push({
            id: p.id, kind: p.kind, label: p.label,
            enabled: p.enabled, detail: p.detail,
        });
    }
    return out;
}

function list() {
    return PROVIDERS.map((p) => ({
        id: p.id, kind: p.kind, label: p.label,
        enabled: p.enabled, detail: p.detail,
    }));
}

function get(id) {
    return PROVIDERS.find((p) => p.id === id) || null;
}

async function runProvider(id, request, ctx) {
    const p = get(id);
    if (!p) return { ok: false, error: `unknown provider: ${id}`, degraded: true };
    if (!p.enabled) return { ok: false, error: `provider ${id} disabled`, degraded: true, provider: id };
    try {
        const r = await p.run(request, ctx);
        return { ok: !!(r && r.ok), ...r, provider: id };
    } catch (e) {
        return { ok: false, error: e.message || String(e), degraded: true, provider: id };
    }
}

module.exports = { registerProvider, refreshAll, list, get, runProvider };