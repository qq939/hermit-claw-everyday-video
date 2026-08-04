// studio/core/json-store.js
// Tiny JSON store for studio config/state files. Avoids pulling in
// a new dep. Reads with fallback, writes atomically via temp file.

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');

function readJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (_) { /* corrupt → fallback */ }
    return fallback;
}

function writeJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

function nowIso() { return new Date().toISOString(); }

module.exports = { readJSON, writeJSON, nowIso, CONFIG_DIR };