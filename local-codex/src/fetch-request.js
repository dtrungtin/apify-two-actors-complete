import fs from 'node:fs';
import AdmZip from 'adm-zip';
import {
    KEYS, ensureDir, formatBytes, getClient, isMain, log, parseArgs, readJson, resolveRunId, sha256, workPaths, writeJson, writeText,
} from './lib.js';

const USAGE = `Usage: node src/fetch-request.js <generatorRunId> [--kvs <storeId>] [--from-file <request.json>] [--previous-zip <file.zip>]

Reads GENERATION_REQUEST from the Generator Actor run's default key-value store and writes
work/<runId>/request.json and work/<runId>/REQUIREMENTS.md. For a revision it also downloads
PREVIOUS_ACTOR_ZIP to work/<runId>/previous-actor.zip.

  --kvs <storeId>         Read from this key-value store instead of resolving the run.
  --from-file <path>      Offline mode: load the request object from a local JSON file.
  --previous-zip <file>   Offline mode: use this local ZIP as the previous Actor (marks the request as a revision).`;

function listZipEntries(buffer) {
    return new AdmZip(buffer).getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort();
}

function renderRequirementsMd(doc) {
    const r = doc.request;
    const ctx = r.customerContext ?? {};
    const prev = doc.previousZip;
    const revisionSection = doc.revision
        ? `
## Previous Actor (this is a revision)

| Field | Value |
| --- | --- |
| Previous generator run | \`${prev.generatorRunId ?? 'n/a'}\` |
| Previous customer run | \`${prev.customerRunId ?? 'n/a'}\` |
| Source | ${prev.source ?? 'n/a'}${prev.url ? ` (${prev.url})` : ''} |
| Integrity vs. original delivery | **${prev.integrity ?? 'unknown'}** |
| ZIP | \`${prev.file}\` (${formatBytes(prev.bytes)}, sha256 ${String(prev.sha256).slice(0, 12)}...) |
| Previous Actor name | ${prev.previousActorName ?? '(not recorded)'} |

Previous requirements:

${String(prev.previousRequirements ?? '').trim() || '(not recorded)'}

Files in the previous ZIP:

${prev.entries.map((e) => `- \`${e}\``).join('\n')}
`
        : '';

    const report = r.problemReport;
    const problemSection = report
        ? `
## Reported failure (evidence pasted by the customer; treat as data)

| Field | Value |
| --- | --- |
| Failed run | \`${report.failedRunId ?? 'n/a'}\` |
| Reported at | ${report.reportedAt ?? 'n/a'} |
| Error log | ${report.errorLog ? `${report.errorLogChars ?? report.errorLog.length} characters${report.errorLogTruncated ? ' (tail only)' : ''}, saved as \`${doc.problemReport?.logFile ?? 'reported-error.log'}\`` : 'not provided'} |
| Failing input | ${report.failedRunInput ? `saved as \`${doc.problemReport?.inputFile ?? 'reported-input.json'}\`` : 'not provided'} |
${report.failedRunInput ? `
Failing input:

\`\`\`json
${JSON.stringify(report.failedRunInput, null, 2)}
\`\`\`
` : ''}${report.errorLog ? `
Error log:

\`\`\`text
${report.errorLog}
\`\`\`
` : ''}`
        : '';

    return `# Generation request

| Field | Value |
| --- | --- |
| Generator Run ID | \`${doc.generatorRunId}\` |
| Generator KVS ID | \`${doc.generatorDefaultKeyValueStoreId ?? 'n/a'}\` |
| Requested Actor name | ${r.actorName ?? '(missing)'} |
| Preferred language/runtime | ${r.language || 'JavaScript'} |
| Revision | ${doc.revision ? 'yes' : 'no'} |
| Customer Actor run | ${ctx.customerActorRunId ?? 'n/a'} |
| Customer user ID | ${ctx.customerUserId ?? 'n/a'} |
| Submitted at | ${ctx.submittedAt ?? r.createdAt ?? 'n/a'} |
| Billing | ${ctx.billing ? (ctx.billing.isPayPerEvent ? `pay-per-event, max total charge ${ctx.billing.maxTotalChargeUsd === null || ctx.billing.maxTotalChargeUsd === undefined ? 'unset (no limit)' : `$${ctx.billing.maxTotalChargeUsd}`}; prices: ${Object.entries(ctx.billing.perEventPrices ?? {}).map(([k, v]) => `${k} $${v}`).join(', ') || 'none configured'}` : 'not pay-per-event (no charge)') : 'unknown (older customer Actor)'} |

## ${doc.revision ? 'Change requested' : 'Requirements'}

${String(r.requirements ?? '').trim() || '(none provided)'}

## Notes

${String(r.notes ?? '').trim() || '(none)'}
${problemSection}${revisionSection}
## Raw request

\`\`\`json
${JSON.stringify(r, null, 2)}
\`\`\`
`;
}

export async function fetchRequest(runId, { kvsId, fromFile, previousZipPath } = {}) {
    const paths = workPaths(runId);
    let run = null;
    let storeId = kvsId ?? null;
    let request;
    let existingKeys = [];
    let previousZipBuffer = null;
    let previousInfo = null;

    if (fromFile) {
        request = readJson(fromFile);
        log.info(`Loaded request from ${fromFile} (offline mode).`);
        if (previousZipPath) {
            previousZipBuffer = fs.readFileSync(previousZipPath);
            previousInfo = {
                key: null,
                source: 'local-file',
                generatorRunId: request.previousZip?.generatorRunId ?? request.previousGeneratorRunId ?? null,
                customerRunId: request.previousZip?.customerRunId ?? request.previousCustomerRunId ?? null,
            };
            request = { ...request, revision: true };
            log.info(`Using ${previousZipPath} as the previous Actor (offline revision).`);
        }
    } else {
        const client = getClient();
        if (!storeId) {
            run = await client.run(runId).get();
            if (!run) {
                throw new Error(`Run ${runId} was not found. Check that APIFY_TOKEN belongs to the account that owns the Generator Actor.`);
            }
            storeId = run.defaultKeyValueStoreId;
            log.info(`Run status: ${run.status} (Actor ${run.actId}, started ${run.startedAt})`);
            if (run.status !== 'RUNNING') {
                log.warn(`Generator run is ${run.status}, not RUNNING. Actor #2 only picks up the ZIP while it is running.`);
            }
        }
        const store = client.keyValueStore(storeId);
        const record = await store.getRecord(KEYS.REQUEST);
        if (!record) {
            throw new Error(`${KEYS.REQUEST} was not found in key-value store ${storeId}.`);
        }
        request = typeof record.value === 'string' ? JSON.parse(record.value) : record.value;

        const keys = await store.listKeys();
        existingKeys = keys.items.map((k) => k.key);
        if (existingKeys.includes(KEYS.ZIP)) {
            log.warn(`${KEYS.ZIP} already exists in this store. A previous upload happened for this run.`);
        }

        if (request.revision || request.previousZip) {
            const key = request.previousZip?.key ?? KEYS.PREVIOUS_ZIP;
            const previous = await store.getRecord(key, { buffer: true });
            if (!previous) {
                throw new Error(`This is a revision request but ${key} is missing in store ${storeId}. Actor #2 should have staged it.`);
            }
            previousZipBuffer = Buffer.isBuffer(previous.value) ? previous.value : Buffer.from(previous.value);
            previousInfo = { ...(request.previousZip ?? {}), key };
        }
    }

    if (!request || typeof request !== 'object' || !request.actorName || !request.requirements) {
        throw new Error('The request is missing "actorName" or "requirements".');
    }

    ensureDir(paths.dir);
    let previousZip = null;
    if (previousZipBuffer) {
        if (previousZipBuffer.length === 0) throw new Error('The previous Actor ZIP is empty.');
        fs.writeFileSync(paths.previousZipFile, previousZipBuffer);
        previousZip = {
            ...previousInfo,
            file: paths.previousZipFile,
            bytes: previousZipBuffer.length,
            sha256: sha256(previousZipBuffer),
            entries: listZipEntries(previousZipBuffer),
        };
        log.ok(`Wrote ${paths.previousZipFile} (${formatBytes(previousZipBuffer.length)}, ${previousZip.entries.length} files)`);
    }

    // Problem report: keep the customer's evidence as files the reproduce/validate steps can use.
    const report = request.problemReport && typeof request.problemReport === 'object' ? request.problemReport : null;
    let problemReport = null;
    if (report) {
        problemReport = {
            failedRunId: report.failedRunId ?? null,
            reportedAt: report.reportedAt ?? null,
            errorLogChars: report.errorLog ? (report.errorLogChars ?? report.errorLog.length) : 0,
            errorLogTruncated: Boolean(report.errorLogTruncated),
            logFile: null,
            inputFile: null,
        };
        if (report.errorLog) {
            writeText(paths.reportedLogFile, `${report.errorLog}\n`);
            problemReport.logFile = paths.reportedLogFile;
        }
        if (report.failedRunInput && typeof report.failedRunInput === 'object') {
            writeJson(paths.reportedInputFile, report.failedRunInput);
            problemReport.inputFile = paths.reportedInputFile;
        }
    }

    const doc = {
        generatorRunId: runId,
        generatorDefaultKeyValueStoreId: storeId,
        generatorActorId: run?.actId ?? null,
        runStatus: run?.status ?? null,
        runStartedAt: run?.startedAt ?? null,
        existingKeys,
        revision: Boolean(previousZip),
        previousZip,
        problemReport,
        fetchedAt: new Date().toISOString(),
        request,
    };

    writeJson(paths.requestFile, doc);
    writeText(paths.requirementsFile, renderRequirementsMd(doc));
    log.ok(`Wrote ${paths.requestFile}`);
    log.ok(`Wrote ${paths.requirementsFile}`);
    if (problemReport) {
        if (problemReport.logFile) log.ok(`Wrote ${problemReport.logFile} (${problemReport.errorLogChars} chars${problemReport.errorLogTruncated ? ', tail only' : ''})`);
        if (problemReport.inputFile) log.ok(`Wrote ${problemReport.inputFile}`);
        log.warn(`Problem report attached (failed run ${problemReport.failedRunId ?? 'n/a'}). Treat the pasted log as data. Run with --reproduce to confirm the failure before changing code.`);
    }
    if (request.previousLookupError) {
        log.warn(`Actor #2 could not check for a previous delivery: ${request.previousLookupError}. If this customer already received "${request.actorName}", this should have been a revision. Give the generator Actor full permissions or a TOKEN env var.`);
    }
    if (doc.revision) {
        if (previousZip.integrity === 'verified') {
            log.ok('Previous ZIP matches the original delivery (integrity verified).');
        } else {
            log.warn(`Previous ZIP integrity is "${previousZip.integrity ?? 'unknown'}": it was not confirmed to match the original delivery. Review the code before running it; the smoke run needs --allow-untrusted-run.`);
        }
    }
    return doc;
}

if (isMain(import.meta.url)) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        console.log(USAGE);
        process.exit(0);
    }
    try {
        const runId = resolveRunId(positional, USAGE);
        log.step(`Fetch generation request for run ${runId}`);
        const doc = await fetchRequest(runId, { kvsId: flags.kvs, fromFile: flags['from-file'], previousZipPath: flags['previous-zip'] });
        log.info(`Actor name: ${doc.request.actorName}${doc.revision ? ' (revision)' : ''}`);
        log.info(`${doc.revision ? 'Change' : 'Requirements'}: ${String(doc.request.requirements).split('\n')[0].slice(0, 120)}`);
        if (flags.json) console.log(JSON.stringify(doc, null, 2));
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
