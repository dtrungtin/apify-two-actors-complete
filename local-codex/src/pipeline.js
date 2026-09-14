import { exists, isMain, log, parseArgs, resolveRunId, workPaths } from './lib.js';
import { fetchRequest } from './fetch-request.js';
import { scaffold } from './scaffold.js';
import { generate } from './generate.js';
import { validate } from './validate.js';
import { reproduce } from './reproduce.js';
import { cloudTest } from './cloud-test.js';
import { packageZip } from './package-zip.js';
import { uploadZip } from './upload-zip.js';

const USAGE = `Usage: node src/pipeline.js <generatorRunId> [options]

Runs the whole Local Codex flow: fetch request -> scaffold -> generate -> validate -> zip -> upload.
Revision requests (Actor #2 staged PREVIOUS_ACTOR_ZIP) start from the previous Actor instead of the template.

  --run                 Include local smoke runs in the validation step (recommended). When the request carries a
                        problem report, the customer's failing input is run too and must succeed.
  --reproduce           Before generating, run the unpacked previous version with the customer's failing input
                        to confirm the reported failure (problem reports only).
  --allow-untrusted-run Smoke-run a revision even if its previous ZIP was not verified against the original delivery.
  --cloud-test          After validation, push the Actor to the private test Actor in your account and run it on the
                        Apify platform (uses --cloud-input, else the prefill input; --memory, default 256 MB).
  --cloud-input <file>  JSON input for the cloud test.
  --input <file>        JSON input for the smoke run (default: schema prefill/default values).
  --timeout <secs>      Smoke run timeout in seconds (default 300).
  --skip-generate       Skip the code generation step (use after generating manually).
  --skip-scaffold       Skip scaffolding (actor/ must already exist).
  --skip-validate       Skip validation (not recommended).
  --skip-upload         Stop after creating the ZIP.
  --force               Recreate actor/ and upload even if the run is not RUNNING.
  --wait <secs>         How long to wait for Actor #2 to finish after upload (default 90).
  --tier <tier>         Billing tier for this delivery: standard | advanced | revision | free
                        (default: revision for revisions, standard otherwise).
  --no-archive          Do not archive the ZIP in the named "generated-actors" store.
  --kvs <storeId>       Debug: use this key-value store instead of resolving the run.
  --from-file <path>    Debug: load the request from a local JSON file instead of Apify.
  --previous-zip <zip>  Debug: with --from-file, treat this local ZIP as the previous Actor (revision).
  --command <cmd>       Shell command used for generation (overrides GENERATE_CMD / codex).

Exit codes: 0 success, 1 failure, 2 generation must be done manually (then rerun with --skip-generate).`;

export async function pipeline(runId, flags) {
    const paths = workPaths(runId);
    const offline = Boolean(flags['from-file']);

    log.step(`1/6 Fetch request (${runId})`);
    const doc = await fetchRequest(runId, { kvsId: flags.kvs, fromFile: flags['from-file'], previousZipPath: flags['previous-zip'] });
    log.info(`Actor: ${doc.request.actorName}${doc.revision ? ' (revision of a previous Actor)' : ''}`);

    log.step('2/6 Scaffold');
    if (flags['skip-scaffold']) log.info('skipped (--skip-scaffold)');
    else scaffold(runId, { force: Boolean(flags.force) });

    if (flags.reproduce) {
        log.step('2b/6 Reproduce reported failure');
        if (!exists(paths.reportedInputFile)) {
            log.info('skipped (the request has no failing input to reproduce)');
        } else {
            const result = await reproduce(runId, {
                timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
                allowUntrustedRun: Boolean(flags['allow-untrusted-run']),
            });
            if (!result.skipped && !result.reproduced) {
                log.warn('The reported failure did not reproduce locally; continue, but read the reported log before changing code.');
            }
        }
    }

    log.step('3/6 Generate');
    if (flags['skip-generate']) {
        log.info('skipped (--skip-generate)');
    } else {
        const gen = await generate(runId, { command: flags.command });
        if (gen.mode === 'manual') return { exitCode: 2, stage: 'generate' };
        if (gen.code !== 0) {
            log.error(`Generator exited with code ${gen.code}. Inspect ${paths.actorDir} and rerun with --skip-generate once fixed.`);
            return { exitCode: 1, stage: 'generate' };
        }
    }

    log.step('4/6 Validate');
    if (flags['skip-validate']) {
        log.warn('skipped (--skip-validate)');
    } else {
        const report = await validate(runId, {
            smokeRun: Boolean(flags.run),
            inputFile: flags.input,
            timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
            allowUntrustedRun: Boolean(flags['allow-untrusted-run']),
        });
        if (!report.ok) {
            log.error(`Validation failed with ${report.errors.length} error(s). Fix ${paths.actorDir}, then rerun with --skip-generate.`);
            return { exitCode: 1, stage: 'validate', report };
        }
    }

    if (flags['cloud-test']) {
        log.step('4b/6 Cloud test on the Apify platform');
        const cloud = await cloudTest(runId, {
            inputFile: flags['cloud-input'],
            memoryMbytes: flags.memory ? Number(flags.memory) : undefined,
            timeoutSecs: flags.timeout ? Number(flags.timeout) : undefined,
            allowUntrustedRun: Boolean(flags['allow-untrusted-run']),
        });
        if (cloud.status !== 'SUCCEEDED') {
            log.error(`Cloud test ${cloud.status}. Inspect ${cloud.logFile}, fix ${paths.actorDir}, then rerun with --skip-generate.`);
            return { exitCode: 1, stage: 'cloud-test', cloud };
        }
    }

    log.step('5/6 Package ZIP');
    const zip = packageZip(runId);

    log.step('6/6 Upload');
    if (flags['skip-upload'] || (offline && !flags.kvs)) {
        log.info(offline && !flags.kvs ? 'skipped (offline mode, no --kvs given)' : 'skipped (--skip-upload)');
        log.info(`ZIP ready at ${zip.zipPath}`);
        return { exitCode: 0, stage: 'zip', zip };
    }
    const upload = await uploadZip(runId, {
        kvsId: flags.kvs,
        force: Boolean(flags.force),
        waitSecs: flags.wait !== undefined ? Number(flags.wait) : undefined,
        noArchive: Boolean(flags['no-archive']),
        tier: flags.tier,
    });
    return { exitCode: 0, stage: 'upload', zip, upload };
}

if (isMain(import.meta.url)) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        console.log(USAGE);
        process.exit(0);
    }
    try {
        const runId = resolveRunId(positional, USAGE);
        const result = await pipeline(runId, flags);
        console.log(`\nPipeline finished at stage "${result.stage}" with exit code ${result.exitCode}.`);
        process.exit(result.exitCode);
    } catch (error) {
        log.error(error.stack || error.message);
        process.exit(1);
    }
}
