// studio/index.js
// Public entry point for the studio subsystem.

const providerRegistry = require('./core/provider-registry');
const composers = require('./composers');
const characters = require('./characters');
const persona = require('./persona');
const mailbox = require('./publishing/mailbox');
const { parseInstruction } = require('./core/instruction-parse');
const { appendStudioLog } = require('./core/logger');
const { getCommConfig } = require('../comm-manager');

// Register providers (order matters only for status display).
require('./providers/local-poster');
require('./providers/local-longform');
require('./providers/local-gif');
require('./providers/fal');

providerRegistry.registerProvider(require('./providers/local-poster'));
providerRegistry.registerProvider(require('./providers/local-longform'));
providerRegistry.registerProvider(require('./providers/local-gif'));
providerRegistry.registerProvider(require('./providers/fal'));

async function init() {
    await providerRegistry.refreshAll();
    appendStudioLog('studio: init done', { always: true });
}

async function status() {
    return {
        providers: providerRegistry.list(),
        characters: characters.list().slice(0, 10),
        persona: { total: persona.list({ limit: 1 }).length },
    };
}

async function runInstruction({ verb, args, mail = false } = {}) {
    let parsedVerb = verb;
    let parsedArgs = args;
    if (!parsedVerb) {
        const p = parseInstruction(args || '');
        if (!p) return { ok: false, error: 'no instruction (try !poster 主题)' };
        parsedVerb = p.verb;
        parsedArgs = p.args;
    }
    const result = await composers.dispatch({ verb: parsedVerb, args: parsedArgs });
    let mailResult = null;
    if (mail && result.ok && result.work) {
        const cfg = getCommConfig();
        const target = cfg && cfg.mail && cfg.mail.target;
        mailResult = await mailbox.deliverToMaster({ work: result.work, target });
    }
    return { ...result, mail: mailResult };
}

module.exports = {
    init,
    status,
    runInstruction,
    providers: providerRegistry,
    composers,
    characters,
    persona,
    mailbox,
};