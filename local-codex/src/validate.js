import fs from 'node:fs';
import path from 'node:path';
import {
    REQUIRED_FILES, commandExists, exists, isMain, log, parseArgs, readJson, resolveRunId, run, workPaths, writeJson,
} from './lib.js';

const USAGE = `Usage: node src/validate.js <generatorRunId> [--run] [--input <input.json>] [--timeout <seconds>] [--allow-untrusted-run]

Checks work/<runId>/actor/ for a valid Apify Actor layout. With --run it also installs
dependencies and executes the Actor locally (apify run when available, plain node otherwise),
first with the prefill input (or --input) and then, when the request carries a problem report,
with the customer's failing input from work/<runId>/reported-input.json, which must now succeed.

  --run                  Run local smoke tests after the structural checks.
  --input <file>         JSON input for the main smoke test (default: prefill/default values from the input schema).
  --timeout <secs>       Smoke test timeout in seconds (default 300).
  --allow-untrusted-run  Run the smoke tests even when the revision's previous ZIP was not verified
                         against the original delivery (review the code first).`;

const ACTOR_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const VERSION_RE = /^\d+\.\d+$/;
const EDITOR_REQUIRED = new Set(['string', 'array', 'object']);
const CLI_UPDATE_NAG = /Warning: You are using an old version[\s\S]*?update![^\n]*\n?/g;

export function deriveSmokeInput(schema) {
    const input = {};
    for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
        if (prop && prop.prefill !== undefined) input[key] = prop.prefill;
        else if (prop && prop.default !== undefined) input[key] = prop.default;
    }
    return input;
}

function countDatasetItems(actorDir) {
    const dir = path.join(actorDir, 'storage', 'datasets', 'default');
    if (!exists(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

/** Whether a revision's previous ZIP is safe to execute locally without an explicit override. */
export function isUntrustedRevision(doc) {
    return Boolean(doc?.revision) && (doc?.previousZip?.integrity ?? null) !== 'verified';
}

/** npm install in the Actor directory. Returns the exit code. */
export async function installDependencies(actorDir, timeoutMs = 300_000) {
    log.step('Smoke test: npm install');
    const result = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: actorDir, timeoutMs });
    return result.code ?? -1;
}

/**
 * Execute the Actor locally once with the given input. Uses `apify run` when the CLI is available,
 * otherwise plain node with a local storage directory. Returns exit code, duration and dataset item count.
 */
export async function runActorLocally(actorDir, input, { inputFile, timeoutMs = 300_000, label = 'Smoke test' } = {}) {
    const hasApifyCli = commandExists('apify');
    log.step(`${label}: run Actor locally (timeout ${Math.round(timeoutMs / 1000)}s)`);
    log.info(`Input: ${JSON.stringify(input)}`);

    const started = Date.now();
    let result;
    if (hasApifyCli) {
        writeJson(inputFile, input);
        result = await run('apify', ['run', '--purge', '--input-file', inputFile], { cwd: actorDir, timeoutMs });
    } else {
        const storageDir = path.join(actorDir, 'storage');
        const kvsDir = path.join(storageDir, 'key_value_stores', 'default');
        fs.rmSync(storageDir, { recursive: true, force: true });
        fs.mkdirSync(kvsDir, { recursive: true });
        writeJson(path.join(kvsDir, 'INPUT.json'), input);
        result = await run(process.execPath, ['src/main.js'], {
            cwd: actorDir,
            timeoutMs,
            env: { APIFY_LOCAL_STORAGE_DIR: storageDir, CRAWLEE_STORAGE_DIR: storageDir },
        });
    }
    return {
        runner: hasApifyCli ? 'apify run' : 'node',
        exitCode: result.code,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
        datasetItems: countDatasetItems(actorDir),
        input,
    };
}

export async function validate(runId, { smokeRun = false, inputFile, timeoutMs = 300_000, allowUntrustedRun = false } = {}) {
    const paths = workPaths(runId);
    const { actorDir } = paths;
    const errors = [];
    const warnings = [];
    const checks = [];
    const error = (m) => { errors.push(m); log.error(m); };
    const warn = (m) => { warnings.push(m); log.warn(m); };
    const pass = (m) => { checks.push(m); log.ok(m); };

    if (!exists(actorDir)) throw new Error(`${actorDir} not found. Run scaffold.js (and generate.js) first.`);

    // A revision starts from a ZIP that came through the customer's storage. Only run it locally when Actor #2
    // confirmed it matches the original delivery, or when the operator explicitly allows it after a review.
    const doc = exists(paths.requestFile) ? readJson(paths.requestFile) : null;
    const previousIntegrity = doc?.previousZip?.integrity ?? null;
    const untrusted = isUntrustedRevision(doc);

    // 1. Required files
    for (const rel of REQUIRED_FILES) {
        const abs = path.join(actorDir, ...rel.split('/'));
        if (exists(abs) && fs.statSync(abs).isFile()) pass(`${rel} exists`);
        else error(`${rel} is missing`);
    }

    // 2. actor.json
    try {
        const actorJson = readJson(path.join(actorDir, '.actor', 'actor.json'));
        const before = errors.length;
        if (actorJson.actorSpecification !== 1) error('actor.json: "actorSpecification" must be 1');
        if (!ACTOR_NAME_RE.test(String(actorJson.name ?? ''))) {
            error(`actor.json: "name" must be 3-63 lowercase letters, digits or dashes (got ${JSON.stringify(actorJson.name)})`);
        }
        if (!VERSION_RE.test(String(actorJson.version ?? ''))) {
            error(`actor.json: "version" must look like "1.0" (got ${JSON.stringify(actorJson.version)})`);
        }
        if (typeof actorJson.input === 'string') {
            if (!exists(path.resolve(actorDir, '.actor', actorJson.input))) {
                error(`actor.json: "input" points to a missing file (${actorJson.input})`);
            }
        } else if (actorJson.input === undefined) {
            warn('actor.json: no "input" key; the platform falls back to .actor/input_schema.json');
        }
        if ('build' in actorJson) warn('actor.json: "build" is not a recognised key and will be ignored');
        if (errors.length === before) pass('actor.json is valid');
    } catch (e) {
        error(`actor.json could not be parsed: ${e.message}`);
    }

    // 3. input_schema.json
    let schema = null;
    try {
        schema = readJson(path.join(actorDir, '.actor', 'input_schema.json'));
        const before = errors.length;
        if (schema.type !== 'object') error('input_schema.json: "type" must be "object"');
        if (schema.schemaVersion !== 1) error('input_schema.json: "schemaVersion" must be 1');
        if (!schema.properties || typeof schema.properties !== 'object') {
            error('input_schema.json: "properties" must be an object');
        } else {
            for (const [key, prop] of Object.entries(schema.properties)) {
                if (!prop || typeof prop !== 'object') {
                    error(`input_schema.json: property "${key}" must be an object`);
                    continue;
                }
                if (!prop.title) error(`input_schema.json: property "${key}" is missing "title"`);
                if (!prop.type) error(`input_schema.json: property "${key}" is missing "type"`);
                if (!prop.description) error(`input_schema.json: property "${key}" is missing "description"`);
                if (EDITOR_REQUIRED.has(prop.type) && !prop.editor) {
                    error(`input_schema.json: property "${key}" (${prop.type}) is missing "editor"`);
                }
            }
            for (const req of schema.required ?? []) {
                if (!(req in schema.properties)) {
                    error(`input_schema.json: required field "${req}" is not defined in properties`);
                } else if (schema.properties[req].prefill === undefined && schema.properties[req].default === undefined) {
                    warn(`input_schema.json: required field "${req}" has no prefill/default, so "apify run" needs manual input`);
                }
            }
        }
        if (errors.length === before) pass('input_schema.json is structurally valid');
    } catch (e) {
        error(`input_schema.json could not be parsed: ${e.message}`);
    }

    // 4. package.json
    try {
        const pkg = readJson(path.join(actorDir, 'package.json'));
        const before = errors.length;
        if (!pkg.scripts?.start) error('package.json: "scripts.start" is required (the Dockerfile runs "npm start")');
        if (!pkg.dependencies?.apify) error('package.json: "apify" must be a dependency');
        if (pkg.type !== 'module') warn('package.json: "type" is not "module"; make sure src/main.js uses matching import/require syntax');
        if (errors.length === before) pass('package.json is valid');
    } catch (e) {
        error(`package.json could not be parsed: ${e.message}`);
    }

    // 5. Dockerfile & README
    const dockerfilePath = path.join(actorDir, 'Dockerfile');
    if (exists(dockerfilePath)) {
        if (/^FROM\s+apify\//m.test(fs.readFileSync(dockerfilePath, 'utf8'))) pass('Dockerfile uses an apify/ base image');
        else warn('Dockerfile does not start from an apify/ base image');
    }
    const readmePath = path.join(actorDir, 'README.md');
    if (exists(readmePath) && fs.readFileSync(readmePath, 'utf8').trim().length < 100) warn('README.md is very short');

    // 6. Syntax check and known anti-patterns
    const mainPath = path.join(actorDir, 'src', 'main.js');
    if (exists(mainPath)) {
        const syntax = await run(process.execPath, ['--check', mainPath], { inherit: false });
        if (syntax.code === 0) pass('src/main.js passes node --check');
        else error(`src/main.js has a syntax error:\n${syntax.stderr.trim()}`);

        const source = fs.readFileSync(mainPath, 'utf8');
        if (/finally\s*\{[^}]*Actor\.exit\(/s.test(source)) {
            error('src/main.js calls Actor.exit() in a finally block: after a throw this exits with code 0 and the run is marked SUCCEEDED. Call Actor.fail() in the catch block instead.');
        } else if (/Actor\.(fail|exit)\(/.test(source)) {
            pass('src/main.js reports failures through Actor.fail()/Actor.exit()');
        }
    }

    // 7. Official schema validation via the Apify CLI
    const hasApifyCli = commandExists('apify');
    if (hasApifyCli && schema) {
        const result = await run('apify', ['validate-schema', path.join('.actor', 'input_schema.json')], { cwd: actorDir, inherit: false });
        const output = `${result.stdout}\n${result.stderr}`.replace(CLI_UPDATE_NAG, '').trim();
        if (result.code === 0) pass('apify validate-schema accepted the input schema');
        else error(`apify validate-schema failed:\n${output}`);
    } else if (!hasApifyCli) {
        warn('apify CLI not found; skipped "apify validate-schema" (npm i -g apify-cli)');
    }

    // 8. Stray directories (excluded from the ZIP, but worth knowing)
    for (const stray of ['node_modules', 'storage', 'apify_storage']) {
        if (exists(path.join(actorDir, stray))) log.info(`${stray}/ present in actor dir (excluded from the ZIP)`);
    }

    // 9. Smoke runs: prefill (or --input), then the customer's reported failing input when there is one.
    let smoke = null;
    let smokeReported = null;
    const hasReportedInput = exists(paths.reportedInputFile);
    if (smokeRun && errors.length === 0 && untrusted && !allowUntrustedRun) {
        warn(`Smoke run skipped: this revision starts from a previous ZIP whose integrity is "${previousIntegrity ?? 'unknown'}", not verified against the original delivery. Review ${actorDir}, then rerun with --allow-untrusted-run.`);
        smoke = { skipped: 'untrusted-previous-zip', integrity: previousIntegrity };
    } else if (smokeRun && errors.length === 0) {
        const installCode = await installDependencies(actorDir, timeoutMs);
        if (installCode !== 0) {
            error(`npm install failed with exit code ${installCode}`);
        } else {
            const input = inputFile ? readJson(inputFile) : deriveSmokeInput(schema);
            smoke = await runActorLocally(actorDir, input, { inputFile: paths.smokeInputFile, timeoutMs });
            if (smoke.timedOut) error(`Smoke test timed out after ${Math.round(timeoutMs / 1000)}s`);
            else if (smoke.exitCode !== 0) error(`Smoke test exited with code ${smoke.exitCode}`);
            else pass(`Smoke test passed in ${(smoke.durationMs / 1000).toFixed(1)}s with ${smoke.datasetItems} dataset item(s)`);
            if (smoke.exitCode === 0 && smoke.datasetItems === 0) warn('Smoke test produced no dataset items; check that the prefill input exercises the Actor');

            if (hasReportedInput) {
                const reportedInput = readJson(paths.reportedInputFile);
                smokeReported = await runActorLocally(actorDir, reportedInput, {
                    inputFile: path.join(paths.dir, 'smoke-reported-input.json'),
                    timeoutMs,
                    label: 'Reported failure check',
                });
                if (smokeReported.timedOut) error(`Reported failing input still times out after ${Math.round(timeoutMs / 1000)}s`);
                else if (smokeReported.exitCode !== 0) error(`Reported failing input still fails (exit code ${smokeReported.exitCode}); the fix is not complete`);
                else pass(`Reported failing input now succeeds (${smokeReported.datasetItems} dataset item(s) in ${(smokeReported.durationMs / 1000).toFixed(1)}s)`);
            }
        }
    } else if (smokeRun) {
        warn('Skipped smoke test because structural checks failed');
    }

    const report = {
        runId,
        actorDir,
        ok: errors.length === 0,
        revision: Boolean(doc?.revision),
        previousIntegrity,
        problemReported: Boolean(doc?.problemReport),
        errors,
        warnings,
        checks,
        smoke,
        smokeReported,
        validatedAt: new Date().toISOString(),
    };
    writeJson(paths.validationFile, report);
    return report;
}

if (isMain(import.meta.url)) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        console.log(USAGE);
        process.exit(0);
    }
    try {
        const runId = resolveRunId(positional, USAGE);
        log.step(`Validate Actor for run ${runId}`);
        const report = await validate(runId, {
            smokeRun: Boolean(flags.run),
            inputFile: flags.input,
            timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
            allowUntrustedRun: Boolean(flags['allow-untrusted-run']),
        });
        console.log(`\n${report.ok ? 'VALID' : 'INVALID'}: ${report.errors.length} error(s), ${report.warnings.length} warning(s). Report: ${workPaths(runId).validationFile}`);
        process.exit(report.ok ? 0 : 1);
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
