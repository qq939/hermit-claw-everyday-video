// studio/persona.js
// Owns the master-derived system-prompt addon.
//   - extractDirectives(text) → string[]  (rule-based; cheap)
//   - learnFromMessage({ source, text })  (writes a row to persona-directives.json)
//   - getSystemPromptAddon() → string     (built from learned + default)

const path = require('path');
const { readJSON, writeJSON, nowIso } = require('./core/json-store');
const { extractDirectives } = require('./core/instruction-parse');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const PERSONA_FILE = path.join(CONFIG_DIR, 'persona-directives.json');

const DEFAULT_ADDON = `你是 Hermit-Claw 的新媒体艺术家 Agent。
1. 邮件是你与主人通讯的主要通道；每封发出的邮件都带 [HC-<uuid>] 令牌，便于主人回复配对。
2. 定时轮询收件箱（默认每小时一次）；主人回复的指令尽量在下一份工作报告中体现。
3. 你有 fal.ai 文生图/视频能力。角色一致性能提升交付件辨识度，请按需复用或新建角色。
4. 容器内存硬上限 228MB，绝不在 Node 进程里加载大文件；所有产物直接落盘 + 通过邮件附件/链接交付。
5. 主人最近强调：可以把主人指令中的有效内容，持续沉淀到系统提示词里。`;

function _load() {
    return readJSON(PERSONA_FILE, { directives: [], updatedAt: null });
}

function _save(data) {
    writeJSON(PERSONA_FILE, data);
}

function list({ limit = 50 } = {}) {
    const data = _load();
    return data.directives.slice(-limit).reverse();
}

function learnFromMessage({ source = 'unknown', text = '', id = null } = {}) {
    const found = extractDirectives(text);
    if (!found.length) return { learned: 0 };
    const data = _load();
    let added = 0;
    for (const sentence of found) {
        const dup = data.directives.some((d) => d.text === sentence && d.source === source);
        if (dup) continue;
        data.directives.push({
            id: id || `dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            source,
            text: sentence,
            learnedAt: nowIso(),
        });
        added++;
    }
    data.updatedAt = nowIso();
    _save(data);
    return { learned: added, total: data.directives.length };
}

function clear() {
    _save({ directives: [], updatedAt: nowIso() });
    return { ok: true };
}

function getSystemPromptAddon({ maxDirectives = 12 } = {}) {
    const data = _load();
    const recent = data.directives.slice(-maxDirectives);
    const lines = [DEFAULT_ADDON.trim()];
    if (recent.length) {
        lines.push('', '主人已沉淀的指令：');
        for (const d of recent) {
            lines.push(`- ${d.text}`);
        }
    }
    return lines.join('\n');
}

module.exports = { list, learnFromMessage, clear, getSystemPromptAddon, PERSONA_FILE };