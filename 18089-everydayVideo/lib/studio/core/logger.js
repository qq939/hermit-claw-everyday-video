// studio/core/logger.js
// Throttled studio log writer. Same pattern as comm-manager.appendRunLog
// but writes to logs/studio.log so we don't pollute run.log.

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..');
const LOG_DIR = path.join(PROJECT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'studio.log');

let _lastAt = 0;
let _pendingLine = null;
let _flushTimer = null;

function _nowIso() { return new Date().toISOString(); }

function _flushSoon() {
    if (_flushTimer) return;
    const wait = Math.max(50, 5000 - (Date.now() - _lastAt));
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        if (_pendingLine !== null) {
            try {
                fs.mkdirSync(LOG_DIR, { recursive: true });
                fs.appendFileSync(LOG_FILE, _pendingLine);
            } catch (_) {}
            _pendingLine = null;
        }
        _lastAt = Date.now();
    }, wait);
}

function appendStudioLog(line, { always = false } = {}) {
    const stamp = _nowIso();
    const entry = `[${stamp}] ${line}\n`;
    if (always) {
        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(LOG_FILE, entry);
        } catch (_) {}
        _lastAt = Date.now();
        _pendingLine = null;
        if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
        return;
    }
    // Coalesce: only the most recent routine line within 5s is kept.
    _pendingLine = entry;
    _flushSoon();
}

module.exports = { appendStudioLog };