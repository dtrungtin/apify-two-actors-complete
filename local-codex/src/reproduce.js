import path from 'node:path';
import {
    exists, isMain, log, parseArgs, readJson, resolveRunId, workPaths, writeJson,
} from './lib.js';
import { installDependencies, isUntrustedRevision, runActorLocally } from './validate.js';

const USAGE = `Usage: node src/reproduce.js <generatorRunId> [--timeout <seconds>] [--allow-untrusted-run]

Runs the Actor in work/<runId>/actor/ with the customer's failing input from the problem report
(work/<runId>/reported-input.json) and reports whether the failure reproduces. Run it on the unpacked
previous version, before changing code.

  --timeout <secs>       Run timeout in seconds (default 300).
  --allow-untrusted-run  Execute even when the revision's previous ZIP was not verified against the original delivery.`;

export async function reproduce(runId, { timeoutMs = 300_000, allowUntrustedRun = false } = {}) {
    const paths = workPaths(runId);
    if (!exists(paths.actorDir)) throw new Error(`${paths.actorDir} not found. Run scaffold.js first.`);
    const doc = exists(paths.requestFile) ? readJson(paths.requestFile) : null;

    if (!exists(paths.reportedInputFile)) {
        log.info('No reported failing input in this request; nothing to reproduce.');
        return { skipped: 'no-reported-input' };
    }
    if (isUntrustedRevision(doc) && !allowUntrustedRun) {
        log.warn(`Reproduction skipped: the previous ZIP's integrity is "${doc?.previousZip?.integrity ?? 'unknown'}". Review ${paths.actorDir}, then rerun with --allow-untrusted-run.`);
        return { skipped: 'untrusted-previous-zip' };
    }

    const installCode = await installDependencies(paths.actorDir, timeoutMs);
    if (installCode !== 0) throw new Error(`npm install failed with exit code ${installCode}`);

    const input = readJson(paths.reportedInputFile);
    const result = await runActorLocally(paths.actorDir, input, {
        inputFile: path.join(paths.dir, 'smoke-reported-input.json'),
        timeoutMs,
        label: 'Reproduce reported failure',
    });
    const reproduced = result.timedOut || result.exitCode !== 0;

    const record = {
        runId,
        reproduced,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        datasetItems: result.datasetItems,
        failedRunId: doc?.problemReport?.failedRunId ?? null,
        reportedLogFile: doc?.problemReport?.logFile ?? null,
        checkedAt: new Date().toISOString(),
    };
    writeJson(paths.reproductionFile, record);

    if (reproduced) {
        log.ok(`Failure reproduced with the customer's input (${result.timedOut ? 'timed out' : `exit code ${result.exitCode}`}). Compare with ${doc?.problemReport?.logFile ?? 'the reported log'}.`);
    } else {
        log.warn(`Could not reproduce: the current code succeeded with the customer's input (${result.datasetItems} dataset item(s)). The failure may depend on their environment, data at the time, or proxy access; read the reported log carefully.`);
    }
    return record;
}

if (isMain(import.meta.url)) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        console.log(USAGE);
        process.exit(0);
    }
    try {
        const runId = resolveRunId(positional, USAGE);
        log.step(`Reproduce reported failure for run ${runId}`);
        const result = await reproduce(runId, {
            timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
            allowUntrustedRun: Boolean(flags['allow-untrusted-run']),
        });
        if (result.skipped) process.exit(0);
        process.exit(result.reproduced ? 0 : 2);
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
