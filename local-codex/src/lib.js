import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { ApifyClient } from 'apify-client';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_DIR = path.join(ROOT, 'template');
export const WORK_ROOT = process.env.LOCAL_CODEX_WORK_DIR
    ? path.resolve(process.env.LOCAL_CODEX_WORK_DIR)
    : path.join(ROOT, 'work');

/** KVS record keys shared with generator-actor/src/main.js. */
export const KEYS = {
    REQUEST: 'GENERATION_REQUEST',
    STATUS: 'GENERATION_STATUS',
    ZIP: 'GENERATED_ACTOR_ZIP',
    META: 'GENERATED_ACTOR_META',
    PREVIOUS_ZIP: 'PREVIOUS_ACTOR_ZIP',
};

/** Named key-value store in your account that keeps every delivered ZIP beyond run-storage retention. */
export const ARCHIVE_STORE_NAME = process.env.LOCAL_CODEX_ARCHIVE_STORE || 'generated-actors';

/** Private Actor in your account that generated code is pushed to for a real run on the Apify platform. */
export const TEST_ACTOR_ID = process.env.LOCAL_CODEX_TEST_ACTOR || 'dtrungtin/actor-generator-test-actor';

/** Files every generated Actor ZIP must contain, at the archive root. */
export const REQUIRED_FILES = [
    '.actor/actor.json',
    '.actor/input_schema.json',
    'src/main.js',
    'package.json',
    'Dockerfile',
    'README.md',
];

/** Directory/file names never included in the ZIP (matched at any depth). */
export const ZIP_EXCLUDES = new Set([
    'node_modules',
    'storage',
    'apify_storage',
    '.git',
    '.venv',
    '__pycache__',
    '.DS_Store',
    'npm-debug.log',
    '.env',
]);

const BOOLEAN_FLAGS = new Set([
    'run', 'force', 'help', 'json', 'no-archive', 'allow-untrusted-run', 'reproduce', 'cloud-test', 'reported', 'skip-push',
    'skip-generate', 'skip-upload', 'skip-validate', 'skip-scaffold', 'skip-zip',
]);

export const log = {
    step: (m) => console.log(`\n== ${m} ==`),
    info: (m) => console.log(`   ${m}`),
    ok: (m) => console.log(`   [OK] ${m}`),
    warn: (m) => console.warn(`   [WARN] ${m}`),
    error: (m) => console.error(`   [FAIL] ${m}`),
};

export function isMain(metaUrl) {
    if (!process.argv[1]) return false;
    const invoked = pathToFileURL(path.resolve(process.argv[1])).href;
    return process.platform === 'win32'
        ? invoked.toLowerCase() === metaUrl.toLowerCase()
        : invoked === metaUrl;
}

export function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--') {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (arg === '-h') {
            flags.help = true;
        } else if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            if (eq !== -1) {
                flags[arg.slice(2, eq)] = arg.slice(eq + 1);
            } else {
                const name = arg.slice(2);
                const next = argv[i + 1];
                if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('-')) {
                    flags[name] = true;
                } else {
                    flags[name] = next;
                    i += 1;
                }
            }
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

export function getToken() {
    const token = process.env.APIFY_TOKEN || process.env.TOKEN;
    if (!token) {
        throw new Error('Missing APIFY_TOKEN. Set it to the Apify token of the account that owns the Generator Actor (Actor #2).');
    }
    return token;
}

export function getClient() {
    return new ApifyClient({ token: getToken() });
}

export function resolveRunId(positional, usage) {
    const runId = positional[0] || process.env.GENERATOR_RUN_ID;
    if (!runId) {
        throw new Error(`Generator Run ID is required.\n${usage}`);
    }
    return runId;
}

export function workPaths(runId) {
    const safe = String(runId).replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(WORK_ROOT, safe);
    return {
        dir,
        requestFile: path.join(dir, 'request.json'),
        requirementsFile: path.join(dir, 'REQUIREMENTS.md'),
        promptFile: path.join(dir, 'PROMPT.md'),
        codexLastMessageFile: path.join(dir, 'codex-last-message.md'),
        validationFile: path.join(dir, 'validation.json'),
        smokeInputFile: path.join(dir, 'smoke-input.json'),
        zipMetaFile: path.join(dir, 'zip.json'),
        uploadFile: path.join(dir, 'upload.json'),
        previousZipFile: path.join(dir, 'previous-actor.zip'),
        reportedInputFile: path.join(dir, 'reported-input.json'),
        reportedLogFile: path.join(dir, 'reported-error.log'),
        reproductionFile: path.join(dir, 'reproduction.json'),
        cloudTestFile: path.join(dir, 'cloud-test.json'),
        cloudTestLogFile: path.join(dir, 'cloud-test.log'),
        cloudTestInputFile: path.join(dir, 'cloud-test-input.json'),
        actorDir: path.join(dir, 'actor'),
    };
}

export function exists(p) {
    return fs.existsSync(p);
}

export function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

export function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJson(p, value) {
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(p, text) {
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, text);
}

export function slugify(name) {
    let s = String(name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (s.length < 3) s = s ? `${s}-generated-actor` : 'generated-actor';
    return s.slice(0, 63).replace(/-+$/g, '');
}

export function truncate(text, max) {
    const s = String(text).replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

export function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Recursively list files under dir as { abs, rel } with POSIX rel paths, skipping excluded names. */
export function walkFiles(dir, excludes = ZIP_EXCLUDES) {
    const out = [];
    const visit = (abs, rel) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            if (excludes.has(entry.name)) continue;
            const childAbs = path.join(abs, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) visit(childAbs, childRel);
            else if (entry.isFile()) out.push({ abs: childAbs, rel: childRel });
        }
    };
    visit(dir, '');
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function commandExists(cmd) {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(probe, [cmd], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
}

function quoteArg(arg) {
    if (arg === '') return '""';
    if (process.platform === 'win32') {
        return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
    }
    return /[^A-Za-z0-9_\-./=:,@]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

function killTree(child) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
        child.kill('SIGKILL');
    }
}

/**
 * Run a command (program + argument list) through the system shell, so that npm/apify/codex
 * shims resolve on Windows. Returns { code, signal, stdout, stderr, timedOut, error }.
 */
export function run(cmd, args = [], opts = {}) {
    return runShell([quoteArg(cmd), ...args.map(quoteArg)].join(' '), opts);
}

/**
 * Run a raw shell command line exactly as the user wrote it (cmd.exe on Windows, /bin/sh elsewhere).
 * Returns { code, signal, stdout, stderr, timedOut, error }.
 */
export function runShell(commandLine, { cwd, env, timeoutMs = 0, input, inherit = true } = {}) {
    return new Promise((resolve) => {
        const child = spawn(commandLine, {
            cwd,
            env: { ...process.env, ...env },
            shell: true,
            windowsHide: true,
            stdio: [
                input !== undefined ? 'pipe' : 'ignore',
                inherit ? 'inherit' : 'pipe',
                inherit ? 'inherit' : 'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let timer;

        if (!inherit) {
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
        }
        if (timeoutMs > 0) {
            timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
        }
        if (input !== undefined) child.stdin.end(input);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: -1, signal: null, stdout, stderr, timedOut, error });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut });
        });
    });
}

export function kvsRecordUrl(storeId, key) {
    return `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`;
}

export function consoleRunUrl(actorId, runId) {
    return actorId
        ? `https://console.apify.com/actors/${actorId}/runs/${runId}`
        : `https://console.apify.com/view/runs/${runId}`;
}

export function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
