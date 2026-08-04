// studio/publishing/mailbox.js
// Wrap a work entry into a master-bound email (subject tagged with
// [HC-<uuid>] so master can reply). Returns the comm-manager
// result if mail was sent.

const crypto = require('crypto');
const { sendMailViaSkill } = require('../../comm-manager');
const characters = require('../characters');

async function deliverToMaster({ work, target, subjectPrefix = '[studio]' } = {}) {
    if (!work) return { ok: false, error: 'no work' };
    if (!target) return { ok: false, error: 'no target', work };
    const uuid = `HC-${crypto.randomBytes(8).toString('hex')}`;
    const char = work.characterId ? characters.get(work.characterId) : null;
    const lines = [
        `# ${work.title || work.theme || 'studio work'}`,
        '',
        `- kind: ${work.kind}`,
        `- work id: ${work.id}`,
        `- status: ${work.status || 'ok'}`,
        `- created: ${work.createdAt}`,
        char ? `- character: ${char.name} (${char.role})` : '',
        work.assetUrl ? `- asset: ${work.assetUrl}` : '',
        work.cover && work.cover.assetUrl ? `- cover: ${work.cover.assetUrl}` : '',
        work.storyboard ? `- storyboard: ${work.storyboard.length} shots, ${work.durationSec}s` : '',
        '',
        'Reply with the token below to comment on this work.',
        '',
        `[mail-uuid: ${uuid}]`,
    ].filter((l) => l !== null && l !== '');
    const result = await sendMailViaSkill({
        to: target,
        subject: `${subjectPrefix} ${work.title || work.theme || work.kind}`,
        body: lines.join('\n'),
        uuid,
    });
    return { ok: !!(result && result.ok), mail: result, uuid, work };
}

module.exports = { deliverToMaster };