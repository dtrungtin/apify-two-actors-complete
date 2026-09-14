import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { ApifyClient } from 'apify-client';
import { planCharge, precheckMessage, resolveTier } from './pricing.js';

const GENERATOR_ACTOR_ID = process.env.GENERATOR_ACTOR_ID || 'dtrungtin/generator-actor';
/** Memory for the generator run. It only waits and copies a small file; 128 MB (Apify's minimum) is enough. */
const GENERATOR_MEMORY_MBYTES = Number(process.env.GENERATOR_MEMORY_MBYTES || 128);
const PRIVATE_APIFY_TOKEN = process.env.TOKEN;
const ZIP_KEY = 'GENERATED_ACTOR_ZIP';
/** Named key-value store in the generator's account that receives the previous ZIP (same store Local Codex archives to). */
const INBOX_STORE_NAME = process.env.INBOX_STORE_NAME || 'generated-actors';
const MAX_PREVIOUS_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_RUNS_TO_SCAN = Number(process.env.MAX_RUNS_TO_SCAN || 50);

// Everything this Actor logs is visible to the customer. Keep messages about the customer's request and result;
// the generation itself is described only as "the generator".

await Actor.init();

// One dataset item is written per run (see .actor/dataset_schema.json) so the result is visible in the Dataset tab
// and can be exported or read by integrations. These fields are filled in as soon as they are known.
const startedAt = new Date().toISOString();
let requestedActorName = null;

try {
    const input = await Actor.getInput();

    if (!input || typeof input !== 'object') {
        throw new Error('Actor input is required.');
    }

    if (!input.actorName || !input.requirements) {
        throw new Error('Both "actorName" and "requirements" are required.');
    }
    requestedActorName = String(input.actorName);

    if (!PRIVATE_APIFY_TOKEN) {
        throw new Error('This Actor is not configured correctly (missing generator credentials). Please contact the Actor owner.');
    }

    // Client acting against the account that owns the generator Actor (Actor #2).
    const client = new ApifyClient({ token: PRIVATE_APIFY_TOKEN });
    // Client acting as the customer (this run's own token): used to look at the customer's earlier runs.
    const ownClient = Actor.newClient();

    log.info(`Preparing the request for "${input.actorName}".`);

    // Pay-per-event billing: make sure the run can pay for a standard generation before anyone starts working.
    const chargingManager = Actor.getChargingManager();
    const pricing = chargingManager.getPricingInfo();
    const billing = {
        isPayPerEvent: Boolean(pricing.isPayPerEvent),
        maxTotalChargeUsd: Number.isFinite(pricing.maxTotalChargeUsd) ? pricing.maxTotalChargeUsd : null,
        perEventPrices: pricing.perEventPrices ?? {},
    };
    const chargeableCount = (eventName) => chargingManager.calculateMaxEventChargeCountWithinLimit(eventName);
    const stop = precheckMessage({ ...billing, maxTotalChargeUsd: pricing.maxTotalChargeUsd, chargeableCount });
    if (stop) {
        log.warning(stop);
        await pushResultItem({
            status: 'NOT_STARTED',
            actorName: input.actorName,
            message: stop,
            maxTotalChargeUsd: billing.maxTotalChargeUsd,
        });
        await Actor.setStatusMessage(stop.split('. ')[0]);
        await Actor.exit({ exitCode: 0, statusMessage: stop.split('. ')[0] });
    }
    if (billing.isPayPerEvent) {
        log.info('This Actor is billed per delivered Actor; you are charged only when your Actor package is ready.');
    }

    // Optional problem report about an Actor the customer already received. Never echo its content into this log.
    const problemReport = buildProblemReport(input);
    if (problemReport) {
        const parts = [];
        if (problemReport.errorLog) parts.push(`${problemReport.errorLogChars} characters of log${problemReport.errorLogTruncated ? ' (tail kept)' : ''}`);
        if (problemReport.failedRunInput) parts.push('the failed run\'s input');
        if (problemReport.failedRunId) parts.push(`run ${problemReport.failedRunId}`);
        log.info(`Problem report attached: ${parts.join(', ')}. The fix will be delivered as a new version of "${input.actorName}".`);
    }

    // Automatic revision detection: the customer's latest successful run of this Actor with the same Actor name.
    // Under Apify's default "limited permissions" the run token cannot list the customer's runs; in that case
    // the generator looks the previous delivery up in its own records (by customer user ID and Actor name).
    let previous = null;
    try {
        previous = await findPreviousDelivery(ownClient, input.actorName);
    } catch (error) {
        log.debug(`Earlier runs are not readable from this run (${error.message}); the generator decides whether this is an update.`);
    }

    let previousZipUrl = null;
    if (previous?.zip) {
        // Hand the previous ZIP to the generator as a URL in the generator's own account, so it is readable there.
        const inboxKey = `inbox-${process.env.ACTOR_RUN_ID || Date.now()}.zip`;
        const inbox = await client.keyValueStores().getOrCreate(INBOX_STORE_NAME);
        await client.keyValueStore(inbox.id).setRecord({ key: inboxKey, value: previous.zip, contentType: 'application/zip' });
        previousZipUrl = `https://api.apify.com/v2/key-value-stores/${inbox.id}/records/${inboxKey}`;
        log.info(`This request updates your existing Actor "${previous.actorName}" from run ${previous.customerRunId}.`);
    } else if (previous) {
        log.info(`This request updates your existing Actor "${previous.actorName}" from run ${previous.customerRunId}.`);
    } else {
        log.info('If an Actor with this name was generated for you before, it will be updated instead of rebuilt from scratch.');
    }

    const generatorInput = {
        actorName: input.actorName,
        requirements: input.requirements,
        language: input.language || 'JavaScript',
        notes: input.notes || '',
        previousZipUrl: previousZipUrl ?? undefined,
        previousZipSha256: previous?.sha256 ?? undefined,
        previousCustomerRunId: previous?.customerRunId,
        previousGeneratorRunId: previous?.generatorRunId,
        previousActorName: previous?.actorName,
        problemReport: problemReport ?? undefined,
        customerContext: {
            customerActorRunId: process.env.ACTOR_RUN_ID || null,
            customerUserId: process.env.APIFY_USER_ID || null,
            submittedAt: new Date().toISOString(),
            // Lets the operator see what this run can pay for before choosing the delivery tier.
            billing,
        },
    };

    log.info('Request submitted. Your Actor is being generated; this run finishes automatically once it is ready, which can take a while.');
    await Actor.setStatusMessage(`Generating "${input.actorName}". This can take a while; the run finishes when your Actor is ready.`);

    const generatorRun = await client.actor(GENERATOR_ACTOR_ID).call(generatorInput, {
        // The generator run has no timeout of its own (timeout: 0) and this call waits until it finishes.
        // log: null keeps the generator's own log out of this (customer-visible) run log.
        timeout: 0,
        memory: GENERATOR_MEMORY_MBYTES,
        log: null,
    });

    if (generatorRun.status !== 'SUCCEEDED') {
        throw new Error(
            `Actor generation did not complete (request ${generatorRun.id}, status ${generatorRun.status}). Please try again or contact the Actor owner.`,
        );
    }

    if (!generatorRun.defaultKeyValueStoreId) {
        throw new Error(`Actor generation finished but its result is unavailable (request ${generatorRun.id}). Please contact the Actor owner.`);
    }

    const generatorStore = client.keyValueStore(generatorRun.defaultKeyValueStoreId);
    const zipRecord = await generatorStore.getRecord(ZIP_KEY, { buffer: true });

    if (!zipRecord) {
        throw new Error(`Actor generation finished but the Actor package is missing (request ${generatorRun.id}). Please contact the Actor owner.`);
    }

    const zipBuffer = Buffer.isBuffer(zipRecord.value)
        ? zipRecord.value
        : Buffer.from(zipRecord.value);

    if (zipBuffer.length === 0) {
        throw new Error(`Actor generation finished but the Actor package is empty (request ${generatorRun.id}). Please contact the Actor owner.`);
    }

    // Actor.setValue uses this run's own default storage, i.e. the customer's run KVS.
    await Actor.setValue(ZIP_KEY, zipBuffer, {
        contentType: zipRecord.contentType || 'application/zip',
    });

    // The generator knows whether it treated the request as an update (it may have found the previous delivery itself).
    const generatorOutput = (await generatorStore.getRecord('OUTPUT'))?.value ?? {};

    const ownStoreId = Actor.getEnv().defaultKeyValueStoreId ?? process.env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID ?? null;
    const zipUrl = ownStoreId ? recordUrl(ownStoreId, ZIP_KEY) : null;
    const revision = Boolean(generatorOutput.revision ?? previous);

    // Charge for the delivery right after it is stored. The operator chose the tier when uploading the ZIP.
    const deliveryMeta = (await generatorStore.getRecord('GENERATED_ACTOR_META'))?.value ?? {};
    const tier = resolveTier(deliveryMeta.tier, revision);
    const billingLabel = typeof deliveryMeta.billing?.label === 'string' ? deliveryMeta.billing.label : null;
    const charge = await chargeForDelivery({ billing, tier, chargeableCount, label: billingLabel });

    const output = {
        status: 'SUCCEEDED',
        actorName: input.actorName,
        revision,
        tier,
        charge,
        problemReported: Boolean(problemReport),
        previousCustomerRunId: generatorOutput.previousCustomerRunId ?? previous?.customerRunId ?? null,
        previousGeneratorRunId: generatorOutput.previousGeneratorRunId ?? previous?.generatorRunId ?? null,
        previousZipUrl,
        generatorRunId: generatorRun.id,
        generatorDefaultKeyValueStoreId: generatorRun.defaultKeyValueStoreId,
        zipKey: ZIP_KEY,
        zipUrl,
        zipBytes: zipBuffer.length,
        finishedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', output);
    await pushResultItem({
        status: 'SUCCEEDED',
        actorName: input.actorName,
        requestType: revision ? (problemReport ? 'fix' : 'update') : 'new',
        revision,
        problemReported: Boolean(problemReport),
        zipUrl,
        zipBytes: zipBuffer.length,
        zipSha256: sha256(zipBuffer),
        zipFiles: Array.isArray(deliveryMeta.files) ? deliveryMeta.files.length : null,
        generatedActorVersion: deliveryMeta.actorVersion ?? null,
        tier,
        chargeLabel: charge.label,
        charged: charge.charged,
        chargedUsd: charge.amountUsd ?? 0,
        chargeEvent: charge.eventName,
        requestId: generatorRun.id,
        previousRunId: output.previousCustomerRunId,
        message: `Your Actor "${input.actorName}" is ready${revision ? ' (updated version)' : ''}.`,
    });
    log.info(`Your Actor "${input.actorName}" is ready${revision ? ' (updated version)' : ''}. Package size: ${zipBuffer.length} bytes.`);
    if (zipUrl) {
        log.info(`Generated Actor ZIP: ${zipUrl}`);
        log.info('Download it from the URL above or from this run\'s Storage tab in Apify Console. Unzip it and run "apify push" inside the folder to deploy it to your account.');
        await Actor.setStatusMessage(`Done. Generated Actor ZIP: ${zipUrl}`);
    } else {
        log.info(`The Actor ZIP is stored as ${ZIP_KEY} in this run's default key-value store.`);
        await Actor.setStatusMessage(`Done. Generated Actor ZIP stored as ${ZIP_KEY}.`);
    }
} catch (error) {
    log.exception(error, 'Actor generation failed');
    await pushResultItem({
        status: 'FAILED',
        actorName: requestedActorName,
        message: String(error.message).slice(0, 500),
    });
    // Actor.fail() exits with a non-zero code so the run is marked FAILED. (Actor.exit() in a finally block would exit 0.)
    await Actor.fail(String(error.message).slice(0, 500));
}

await Actor.exit();

function recordUrl(storeId, key) {
    return `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`;
}

/**
 * Write the run's result as one item in the default dataset. Everything here is visible to the customer, so it
 * only describes their request and its outcome. A dataset failure must never mask the real result, hence the catch.
 */
async function pushResultItem(fields) {
    const item = {
        status: fields.status,
        actorName: fields.actorName ?? null,
        requestType: fields.requestType ?? null,
        revision: fields.revision ?? null,
        problemReported: fields.problemReported ?? null,
        zipUrl: fields.zipUrl ?? null,
        zipBytes: fields.zipBytes ?? null,
        zipSha256: fields.zipSha256 ?? null,
        zipFiles: fields.zipFiles ?? null,
        generatedActorVersion: fields.generatedActorVersion ?? null,
        tier: fields.tier ?? null,
        chargeLabel: fields.chargeLabel ?? null,
        charged: fields.charged ?? null,
        chargedUsd: fields.chargedUsd ?? null,
        chargeEvent: fields.chargeEvent ?? null,
        maxTotalChargeUsd: fields.maxTotalChargeUsd ?? null,
        requestId: fields.requestId ?? null,
        previousRunId: fields.previousRunId ?? null,
        runId: process.env.ACTOR_RUN_ID ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: fields.message ?? null,
    };
    try {
        await Actor.pushData(item);
    } catch (error) {
        log.warning(`Could not write the result to the dataset: ${error.message}`);
    }
}

/** Charge the pay-per-event price for this delivery, if the Actor is monetised. Returns what happened, for OUTPUT. */
async function chargeForDelivery({ billing, tier, chargeableCount, label }) {
    const what = label ? ` (${label})` : '';
    const plan = planCharge({ ...billing, tier, chargeableCount });
    if (!plan.eventName) {
        if (plan.reason === 'free' && billing.isPayPerEvent) {
            log.info(`No charge for this delivery${what}.`);
        } else if (plan.reason === 'event-not-configured') {
            log.warning('Pricing is not fully configured for this Actor; this delivery is not charged.');
        } else if (plan.reason === 'limit-reached') {
            log.warning('This delivery could not be charged because the run\'s maximum total charge was reached.');
        }
        return { charged: false, tier, label: label ?? null, eventName: null, amountUsd: 0, reason: plan.reason };
    }

    const result = await Actor.charge({ eventName: plan.eventName });
    const charged = result.chargedCount > 0;
    const amountUsd = charged ? (billing.perEventPrices[plan.eventName] ?? null) : 0;
    if (charged) {
        log.info(`Charged $${Number(amountUsd).toFixed(2)} for this delivery${what}${plan.fallback ? ', at the standard rate since the run\'s limit did not cover the advanced rate' : ''}.`);
    } else {
        log.warning('This delivery could not be charged because the run\'s maximum total charge was reached.');
    }
    return {
        charged,
        tier,
        label: label ?? null,
        eventName: plan.eventName,
        amountUsd,
        fallbackToStandard: Boolean(plan.fallback),
        reason: charged ? null : 'limit-reached',
    };
}

const MAX_ERROR_LOG_CHARS = 200_000;

/** Collect the optional problem-report fields into one object, or null when none is filled in. */
function buildProblemReport(input) {
    const errorLog = typeof input.errorLog === 'string' ? input.errorLog.trim() : '';
    const failedRunInput = input.failedRunInput && typeof input.failedRunInput === 'object' && !Array.isArray(input.failedRunInput)
        && Object.keys(input.failedRunInput).length > 0
        ? input.failedRunInput
        : null;
    const failedRunRef = typeof input.failedRunId === 'string' ? input.failedRunId.trim() : '';
    const failedRunId = failedRunRef ? (failedRunRef.match(/\/runs\/([A-Za-z0-9]{10,32})/)?.[1] ?? failedRunRef) : null;

    if (!errorLog && !failedRunInput && !failedRunId) return null;

    // Errors sit at the end of a log, so keep the tail when the paste is very long.
    const errorLogTruncated = errorLog.length > MAX_ERROR_LOG_CHARS;
    return {
        errorLog: errorLog ? (errorLogTruncated ? errorLog.slice(-MAX_ERROR_LOG_CHARS) : errorLog) : null,
        errorLogTruncated,
        errorLogChars: Math.min(errorLog.length, MAX_ERROR_LOG_CHARS),
        failedRunInput,
        failedRunId,
        reportedAt: new Date().toISOString(),
    };
}

/** Normalise an Actor name so "My Scraper" and "my-scraper" count as the same Actor (same rule as Local Codex). */
function slug(name) {
    let s = String(name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (s.length < 3) s = s ? `${s}-generated-actor` : 'generated-actor';
    return s.slice(0, 63).replace(/-+$/g, '');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isValidActorZip(buffer) {
    return buffer.length > 0
        && buffer.length <= MAX_PREVIOUS_ZIP_BYTES
        && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
        && buffer.includes('.actor/actor.json');
}

/**
 * Find the customer's most recent successful run of this Actor that delivered an Actor with the same name.
 * Returns null when there is none. The ZIP is null when that run's storage has already expired.
 * Requires the Actor to run with full permissions; with limited permissions the API call throws.
 */
async function findPreviousDelivery(ownClient, actorName) {
    const actorId = process.env.ACTOR_ID;
    const currentRunId = process.env.ACTOR_RUN_ID;
    if (!actorId) return null;

    const wanted = slug(actorName);
    const { items } = await ownClient.actor(actorId).runs().list({ limit: MAX_RUNS_TO_SCAN, desc: true, status: 'SUCCEEDED' });

    for (const run of items) {
        if (run.id === currentRunId || !run.defaultKeyValueStoreId) continue;
        const store = ownClient.keyValueStore(run.defaultKeyValueStoreId);

        const output = (await store.getRecord('OUTPUT'))?.value;
        if (!output || output.status !== 'SUCCEEDED' || !output.generatorRunId) continue;

        const runInput = (await store.getRecord('INPUT'))?.value;
        const name = runInput?.actorName ?? output.actorName;
        if (!name || slug(name) !== wanted) continue;

        let zip = null;
        const record = await store.getRecord(output.zipKey || ZIP_KEY, { buffer: true });
        if (record?.value?.length) {
            const buffer = Buffer.isBuffer(record.value) ? record.value : Buffer.from(record.value);
            if (isValidActorZip(buffer)) zip = buffer;
            else log.debug(`${ZIP_KEY} in run ${run.id} is not a valid Actor ZIP; the generator will use its own copy instead.`);
        }

        return {
            customerRunId: run.id,
            generatorRunId: output.generatorRunId,
            actorName: name,
            zip,
            sha256: zip ? sha256(zip) : null,
        };
    }

    return null;
}
