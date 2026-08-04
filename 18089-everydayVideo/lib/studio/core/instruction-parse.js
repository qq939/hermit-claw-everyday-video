// studio/core/instruction-parse.js
// Parses master instructions from email subject + body, also extracts
// directive sentences ("你以后是 X", "记住 Y", "必须 Z") for persona.

const DIRECTIVE_TRIGGERS = [
    /^你以后/,
    /^以后你是/,
    /^记住/,
    /^必须/,
    /^以后不要/,
    /^从今以后/,
    /^你不能/,
    /^你应该/,
    /^把.+放到/,
    /^把.+放进/,
    /^把.+写到/,
    /^把.+写到系统提示词/,
];

const KNOWN_VERBS = [
    '!poster', '!reel', '!song', '!carousel',
    '!longform', '!gif', '!portrait', '!cast',
    '!persona', '!list', '!status',
];

// Pull first recognized instruction from text. Returns
// { verb, args, original } or null.
function parseInstruction(text) {
    if (!text) return null;
    const lines = String(text).split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const head = line.split(/\s+/)[0].toLowerCase();
        if (KNOWN_VERBS.includes(head)) {
            const args = line.slice(head.length).trim();
            return { verb: head, args, original: line };
        }
    }
    // Also support `指令: !poster 主题` patterns.
    const m = String(text).match(/(?:^|\s)(!poster|!reel|!song|!carousel|!longform|!gif|!portrait|!cast|!persona|!list|!status)\b([^\n]*)/i);
    if (m) return { verb: m[1].toLowerCase(), args: (m[2] || '').trim(), original: m[0].trim() };
    return null;
}

// Find sentences that look like "directives" to master.
// Returns array of strings.
function extractDirectives(text) {
    if (!text) return [];
    const out = [];
    const sentences = String(text).split(/(?<=[。.!?！？\n])/g);
    for (const s of sentences) {
        const t = s.trim();
        if (!t) continue;
        for (const rx of DIRECTIVE_TRIGGERS) {
            if (rx.test(t)) { out.push(t); break; }
        }
    }
    return out;
}

module.exports = { parseInstruction, extractDirectives, KNOWN_VERBS };