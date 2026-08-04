// Skill Manager
// Core module for skill lifecycle: discover, configure, install, inject, remove.
// Skills are directories under PROJECT_DIR/skills/ or external npm packages.
// Config is stored as JSON in PROJECT_DIR/config/skills/.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(PROJECT_DIR, 'skills');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const SKILL_CONFIG = path.join(CONFIG_DIR, 'skills.json');
const WORKSPACE_DIR = '/home/agent/.claude/workspace/project';

// ---------- helpers ----------

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { /* corrupt file, start fresh */ }
    return null;
}

function writeJSON(file, data) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function now() {
    return new Date().toISOString();
}

// ---------- config ----------

function loadConfig() {
    const cfg = readJSON(SKILL_CONFIG);
    return cfg || { skills: {}, updatedAt: null };
}

function saveConfig(cfg) {
    cfg.updatedAt = now();
    writeJSON(SKILL_CONFIG, cfg);
}

// ---------- skill scanner ----------

function detectInstalledSkills() {
    const result = [];
    // 1. Check skills/ directory
    ensureDir(SKILLS_DIR);
    try {
        const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
        for (const d of dirs) {
            if (d.isDirectory()) {
                const skillDir = path.join(SKILLS_DIR, d.name);
                const skillMeta = readJSON(path.join(skillDir, 'skill.json'));
                result.push({
                    name: d.name,
                    path: skillDir,
                    type: 'local',
                    meta: skillMeta || {},
                    hasSKILL: fs.existsSync(path.join(skillDir, 'SKILL.md')),
                    hasScripts: fs.existsSync(path.join(skillDir, 'scripts')),
                });
            }
        }
    } catch (e) { /* no skills dir yet */ }

    // 2. Check Claude skills (~/.claude/skills/)
    try {
        const home = process.env.HOME || '/home/agent';
        const claudeSkillsDir = path.join(home, '.claude', 'skills');
        if (fs.existsSync(claudeSkillsDir)) {
            const dirs = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
            for (const d of dirs) {
                if (d.isDirectory()) {
                    const skillDir = path.join(claudeSkillsDir, d.name);
                    const skillMeta = readJSON(path.join(skillDir, 'skill.json'));
                    result.push({
                        name: d.name,
                        path: skillDir,
                        type: 'claude',
                        meta: skillMeta || {},
                        hasSKILL: fs.existsSync(path.join(skillDir, 'SKILL.md')),
                        hasScripts: fs.existsSync(path.join(skillDir, 'scripts')),
                    });
                }
            }
        }
    } catch (e) { /* no claude skills dir */ }

    return result;
}

function getSkillDetail(name) {
    const cfg = loadConfig();
    const installed = detectInstalledSkills();
    const match = installed.find(s => s.name === name);
    const skillCfg = cfg.skills[name] || {};
    return {
        name,
        installed: !!match,
        detail: match || null,
        enabled: skillCfg.enabled !== false,
        config: skillCfg.config || {},
        configSchema: skillCfg.configSchema || null,
        updatedAt: skillCfg.updatedAt || null,
    };
}

function getAllSkillsStatus() {
    const cfg = loadConfig();
    const installed = detectInstalledSkills();
    const names = new Set([...installed.map(s => s.name), ...Object.keys(cfg.skills)]);

    const result = [];
    for (const name of names) {
        const match = installed.find(s => s.name === name);
        const skillCfg = cfg.skills[name] || {};
        result.push({
            name,
            installed: !!match,
            detail: match || null,
            enabled: skillCfg.enabled !== false,
            configKeys: Object.keys(skillCfg.config || {}),
            configSchema: skillCfg.configSchema || null,
            updatedAt: skillCfg.updatedAt || null,
        });
    }
    return result;
}

// ---------- configure ----------

function configureSkill(name, configValues, opts = {}) {
    const cfg = loadConfig();
    if (!cfg.skills[name]) cfg.skills[name] = { enabled: true, config: {}, configSchema: null };

    const entry = cfg.skills[name];

    // Merge in new config values
    for (const [key, value] of Object.entries(configValues)) {
        if (value !== null && value !== undefined && value !== '') {
            entry.config[key] = value;
        } else {
            delete entry.config[key];
        }
    }

    if (opts.configSchema) entry.configSchema = opts.configSchema;
    if (opts.enabled !== undefined) entry.enabled = opts.enabled;
    entry.updatedAt = now();

    saveConfig(cfg);

    // Optionally write a .env file for the skill
    if (opts.writeEnv !== false && Object.keys(entry.config).length > 0) {
        writeSkillEnv(name, entry.config);
    }

    return entry;
}

function writeSkillEnv(name, config) {
    const envFile = path.join(SKILLS_DIR, name, '.env');
    const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`);
    if (lines.length > 0) {
        ensureDir(path.dirname(envFile));
        fs.writeFileSync(envFile, lines.join('\n') + '\n', 'utf8');
    }
}

// ---------- install from npm / git ----------

function installSkillFromNpm(packageName, opts = {}) {
    const targetName = opts.as || packageName.replace(/^@/, '').replace(/[\/@]/g, '-');
    const targetDir = path.join(SKILLS_DIR, targetName);

    ensureDir(targetDir);

    // Run npm pack in a temp dir to get the package contents
    const tmpDir = fs.mkdtempSync('/tmp/skill-');
    try {
        execSync(`npx --yes ${packageName}`, {
            cwd: tmpDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 120000,
            env: { ...process.env, npm_config_yes: 'true' },
        });
    } catch (e) {
        // npx command might not produce expected output; fallback to git clone
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`npm install failed for ${packageName}: ${e.message}`);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { name: targetName, path: targetDir };
}

function installSkillFromGit(repoUrl, opts = {}) {
    const name = opts.as || repoUrl.split('/').pop().replace(/\.git$/, '');
    const targetDir = path.join(SKILLS_DIR, name);

    ensureDir(targetDir);

    try {
        execSync(`git clone --depth 1 ${repoUrl} "${targetDir}"`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 120000,
        });
    } catch (e) {
        throw new Error(`git clone failed for ${repoUrl}: ${e.message}`);
    }

    // Read skill.json if present
    const meta = readJSON(path.join(targetDir, 'skill.json'));
    const envExample = readJSON(path.join(targetDir, 'env.example.json'));

    // Auto-register in config
    const cfg = loadConfig();
    if (!cfg.skills[name]) {
        cfg.skills[name] = { enabled: true, config: {}, configSchema: null };
    }
    if (meta) cfg.skills[name].meta = meta;
    if (envExample) cfg.skills[name].configSchema = envExample;
    saveConfig(cfg);

    return { name, path: targetDir, meta, configSchema: envExample };
}

// ---------- inject into identity files ----------

function injectSkillToIdentity(name, skillDescription) {
    const identityFile = path.join(WORKSPACE_DIR, 'IDENTITY.md');
    if (!fs.existsSync(identityFile)) {
        fs.writeFileSync(identityFile, `# Agent Identity\n\n`, 'utf8');
    }

    let content = fs.readFileSync(identityFile, 'utf8');
    const marker = `<!-- skill:${name} -->`;
    const block = `${marker}\n### Skill: ${name}\n\n${skillDescription}\n${marker}`;

    if (content.includes(marker)) {
        // Replace existing block
        const re = new RegExp(`${marker}[\\s\\S]*?${marker}`, 'g');
        content = content.replace(re, block);
    } else {
        content += `\n${block}\n`;
    }

    fs.writeFileSync(identityFile, content, 'utf8');

    // Also try SOUL.md
    const soulFile = path.join(WORKSPACE_DIR, 'SOUL.md');
    if (fs.existsSync(soulFile)) {
        let soul = fs.readFileSync(soulFile, 'utf8');
        if (!soul.includes(marker)) {
            soul += `\n${block}\n`;
            fs.writeFileSync(soulFile, soul, 'utf8');
        }
    }

    return { identityFile, injected: true };
}

function removeSkillFromIdentity(name) {
    const identityFile = path.join(WORKSPACE_DIR, 'IDENTITY.md');
    if (!fs.existsSync(identityFile)) return { removed: false };

    let content = fs.readFileSync(identityFile, 'utf8');
    const marker = `<!-- skill:${name} -->`;
    const re = new RegExp(`${marker}[\\s\\S]*?${marker}\\n*`, 'g');
    content = content.replace(re, '');
    fs.writeFileSync(identityFile, content, 'utf8');

    const soulFile = path.join(WORKSPACE_DIR, 'SOUL.md');
    if (fs.existsSync(soulFile)) {
        let soul = fs.readFileSync(soulFile, 'utf8');
        soul = soul.replace(re, '');
        fs.writeFileSync(soulFile, soul, 'utf8');
    }

    return { removed: true };
}

// ---------- enable / disable ----------

function setSkillEnabled(name, enabled) {
    const cfg = loadConfig();
    if (!cfg.skills[name]) cfg.skills[name] = { enabled: true, config: {} };
    cfg.skills[name].enabled = enabled;
    cfg.skills[name].updatedAt = now();
    saveConfig(cfg);
    return cfg.skills[name];
}

// ---------- remove skill ----------

function removeSkill(name) {
    const cfg = loadConfig();
    delete cfg.skills[name];
    saveConfig(cfg);

    // Remove from identity
    removeSkillFromIdentity(name);

    // Remove skill dir
    const skillDir = path.join(SKILLS_DIR, name);
    if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
    }

    return { removed: true };
}

// ---------- Clawra-specific adapter ----------

const CLAWRA_DEFAULT_SCHEMA = {
    FAL_KEY: { type: 'password', label: 'fal.ai API Key', required: true, placeholder: 'Enter your fal.ai key...' },
    CLAWRA_REF_IMAGE: { type: 'text', label: 'Reference Image URL', required: false, placeholder: 'https://.../reference.png' },
    ENABLED_CHANNELS: { type: 'text', label: 'Enabled Channels (comma-sep)', required: false, placeholder: 'discord,telegram' },
};

function getClawraStatus() {
    const detail = getSkillDetail('clawra-selfie');
    return {
        ...detail,
        defaultSchema: CLAWRA_DEFAULT_SCHEMA,
        installGuide: [
            '1. Get a fal.ai API key from https://fal.ai/dashboard/keys',
            '2. Fill in the FAL_KEY below',
            '3. (Optional) Set a reference image URL for consistent selfies',
            '4. Click "Install & Configure" to apply',
        ],
        repoUrl: 'https://github.com/SumeLabs/clawra',
    };
}

// ---------- export ----------

module.exports = {
    loadConfig,
    saveConfig,
    detectInstalledSkills,
    getSkillDetail,
    getAllSkillsStatus,
    configureSkill,
    installSkillFromGit,
    installSkillFromNpm,
    injectSkillToIdentity,
    removeSkillFromIdentity,
    setSkillEnabled,
    removeSkill,
    getClawraStatus,
    CLAWRA_DEFAULT_SCHEMA,
};
