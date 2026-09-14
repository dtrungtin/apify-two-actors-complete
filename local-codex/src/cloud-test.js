import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    TEST_ACTOR_ID, ensureDir, exists, formatBytes, getClient, isMain, log, parseArgs, readJson, resolveRunId, run, walkFiles, workPaths,
    writeJson, writeText,
} from './lib.js';
import { deriveSmokeInput, isUntrustedRevision } from './validate.js';

const USAGE = `Usage: node src/cloud-test.js <generatorRunId> [--input <file> | --reported] [--memory <MB>] [--timeout <secs>] [--test-actor <id>] [--skip-push]

Pushes work/<runId>/actor/ into the private test Actor in your account (${TEST_ACTOR_ID}), runs it on the
Apify platform and saves the outcome to work/<runId>/cloud-test.json and cloud-test.log. Use it for checks
that only work on the platform, such as Apify Proxy.

  --input <file>      JSON input for the run (default: prefill/default values from the input schema).
  --reported          Use the customer's failing input from the problem report (reported-input.json).
  --memory <MB>       Run memory in MB (default 256).
  --timeout <secs>    Run timeout in seconds (default 600); the build wait uses the same limit.
  --test-actor <id>   Test Actor to push to (default ${TEST_ACTOR_ID}, env LOCAL_CODEX_TEST_ACTOR).
  --skip-push         Run the test Actor's current build without pushing first.
  --allow-untrusted-run  Push and run even when the revision's previous ZIP was not verified.`;

/**
 * Copy the Actor source (without node_modules/, storage/ and ZIPs) into a temporary folder outside the repo.
 * `apify push` honours .gitignore files of parent folders, and this repo ignores local-codex/work/, which would
 * otherwise exclude every source file and build an empty Actor.
 */
function stageCleanCopy(actorDir) {
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-codex-cloud-'));
    const files = walkFiles(actorDir).filter((f) => !f.rel.endsWith('.zip'));
    for (const file of files) {
        const target = path.join(stageDir, ...file.rel.split('/'));
        ensureDir(path.dirname(target));
        fs.copyFileSync(file.abs, target);
    }
    return { stageDir, files: files.map((f) => f.rel) };
}

export async function cloudTest(runId, {
    inputFile, useReported = false, memoryMbytes = 256, timeoutSecs = 600, testActorId = TEST_ACTOR_ID, skipPush = false, allowUntrustedRun = false,
} = {}) {
    const paths = workPaths(runId);
    if (!exists(paths.actorDir)) throw new Error(`${paths.actorDir} not found. Run scaffold.js first.`);
    const doc = exists(paths.requestFile) ? readJson(paths.requestFile) : null;
    if (isUntrustedRevision(doc) && !allowUntrustedRun) {
        throw new Error(`Refusing to run unverified code on the platform: the previous ZIP's integrity is "${doc?.previousZip?.integrity ?? 'unknown'}". Review the code, then pass --allow-untrusted-run.`);
    }

    let input;
    if (useReported) {
        if (!exists(paths.reportedInputFile)) throw new Error(`--reported given but ${paths.reportedInputFile} does not exist.`);
        input = readJson(paths.reportedInputFile);
    } else if (inputFile) {
        input = readJson(inputFile);
    } else {
        input = deriveSmokeInput(readJson(path.join(paths.actorDir, '.actor', 'input_schema.json')));
    }
    writeJson(paths.cloudTestInputFile, input);

    const client = getClient();
    const actorJson = readJson(path.join(paths.actorDir, '.actor', 'actor.json'));

    let build = null;
    if (!skipPush) {
        log.step(`Cloud test: push ${actorJson.name} ${actorJson.version} to ${testActorId}`);
        const { stageDir, files } = stageCleanCopy(paths.actorDir);
        log.info(`Staged ${files.length} source files in ${stageDir}`);
        let push;
        try {
            push = await run('apify', [
                'push', testActorId, '--dir', stageDir, '--force', '--wait-for-finish', String(timeoutSecs),
            ], { inherit: false, timeoutMs: (timeoutSecs + 60) * 1000 });
        } finally {
            fs.rmSync(stageDir, { recursive: true, force: true });
        }
        const output = `${push.stdout}\n${push.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
        const buildNumber = output.match(/Build number:\s*(\S+)/)?.[1] ?? null;
        const buildId = output.match(/Build ID:\s*(\S+)/)?.[1] ?? null;
        if (push.code !== 0 || !/Build:\s*SUCCEEDED/.test(output)) {
            const reason = output.split('\n').filter((l) => /error|ERROR|Reason|failed|FAILED/i.test(l)).slice(-6).join('\n');
            throw new Error(`Push/build to ${testActorId} failed (exit ${push.code}).\n${reason || output.slice(-1500)}`);
        }

        // Make sure the platform really received the source (an empty version builds the base image's placeholder).
        const version = await client.actor(testActorId).version(actorJson.version).get();
        const uploaded = (version?.sourceFiles ?? []).map((f) => f.name);
        const missing = ['src/main.js', 'package.json', 'Dockerfile'].filter((f) => !uploaded.includes(f));
        if (version?.sourceType === 'SOURCE_FILES' && missing.length) {
            throw new Error(`Push to ${testActorId} uploaded ${uploaded.length} file(s) but not ${missing.join(', ')}; the build would run the placeholder main.js.`);
        }
        build = { buildId, buildNumber, uploadedFiles: uploaded.length || null, sourceType: version?.sourceType ?? null };
        log.ok(`Built ${testActorId} (build ${buildNumber ?? '?'}) from ${actorJson.name} ${actorJson.version}${uploaded.length ? `, ${uploaded.length} source files` : ''}`);
    }

    log.step(`Cloud test: run ${testActorId} (${memoryMbytes} MB, timeout ${timeoutSecs}s)`);
    log.info(`Input: ${JSON.stringify(input)}`);
    const started = Date.now();
    const testRun = await client.actor(testActorId).call(input, {
        memory: memoryMbytes,
        timeout: timeoutSecs,
        waitSecs: timeoutSecs + 60,
        log: null,
    });
    const durationMs = Date.now() - started;

    // The dataset's item count is eventually consistent right after a run ends; read it via the items endpoint with a short retry.
    let datasetItems = null;
    if (testRun.defaultDatasetId) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const page = await client.dataset(testRun.defaultDatasetId).listItems({ limit: 1 });
            datasetItems = page.total;
            if (datasetItems > 0 || attempt === 3) break;
            await new Promise((resolve) => { setTimeout(resolve, 2000); });
        }
    }
    const logText = String((await client.log(testRun.id).get()) ?? '');
    writeText(paths.cloudTestLogFile, logText);

    const result = {
        runId,
        testActorId,
        build,
        testRunId: testRun.id,
        status: testRun.status,
        statusMessage: testRun.statusMessage ?? null,
        exitCode: testRun.exitCode ?? null,
        durationMs,
        runTimeSecs: testRun.stats?.runTimeSecs ?? null,
        computeUnits: testRun.stats?.computeUnits ?? null,
        datasetItems,
        input,
        runUrl: `https://console.apify.com/actors/${testRun.actId}/runs/${testRun.id}`,
        logFile: paths.cloudTestLogFile,
        testedAt: new Date().toISOString(),
    };
    writeJson(paths.cloudTestFile, result);

    const tail = logText.trim().split('\n').slice(-12).join('\n');
    if (testRun.status === 'SUCCEEDED') {
        log.ok(`Cloud run ${testRun.id} SUCCEEDED in ${(durationMs / 1000).toFixed(1)}s with ${result.datasetItems ?? '?'} dataset item(s)`);
    } else {
        log.error(`Cloud run ${testRun.id} ${testRun.status}${testRun.statusMessage ? `: ${testRun.statusMessage}` : ''}`);
    }
    log.info(`Status message: ${testRun.statusMessage ?? '(none)'}`);
    log.info(`Run: ${result.runUrl}`);
    log.info(`Log saved to ${paths.cloudTestLogFile} (${formatBytes(Buffer.byteLength(logText))}); last lines:\n${tail}`);
    return result;
}

if (isMain(import.meta.url)) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        console.log(USAGE);
        process.exit(0);
    }
    try {
        const runId = resolveRunId(positional, USAGE);
        log.step(`Cloud test for run ${runId}`);
        const result = await cloudTest(runId, {
            inputFile: flags.input,
            useReported: Boolean(flags.reported),
            memoryMbytes: flags.memory ? Number(flags.memory) : undefined,
            timeoutSecs: flags.timeout ? Number(flags.timeout) : undefined,
            testActorId: flags['test-actor'],
            skipPush: Boolean(flags['skip-push']),
            allowUntrustedRun: Boolean(flags['allow-untrusted-run']),
        });
        process.exit(result.status === 'SUCCEEDED' ? 0 : 1);
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
