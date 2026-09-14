import crypto from 'node:crypto';
import { Actor, log } from 'apify';

const REQUEST_KEY = 'GENERATION_REQUEST';
const ZIP_KEY = 'GENERATED_ACTOR_ZIP';
const META_KEY = 'GENERATED_ACTOR_META';
const STATUS_KEY = 'GENERATION_STATUS';
const PREVIOUS_ZIP_KEY = 'PREVIOUS_ACTOR_ZIP';
const ARCHIVE_STORE_NAME = process.env.ARCHIVE_STORE_NAME || 'generated-actors';
const MAX_PREVIOUS_ZIP_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10_000);

// This Actor runs in the operator's account. Its log is not streamed to the customer (Actor #1 calls it with
// log: null), but the wording stays neutral anyway: the run ID is the "request ID", and the generation step is
// simply "in progress" until GENERATED_ACTOR_ZIP appears in this run's key-value store.

await Actor.init();

// One dataset item per run (see .actor/dataset_schema.json): the request, who it came from, how the previous
// version was found, and the delivery's billing decision. Lets you review all requests in one table across runs.
const startedAt = new Date().toISOString();
let requestSummary = {};

try {
    const input = await Actor.getInput();

    if (!input || typeof input !== 'object') {
        throw new Error('Generator input is required.');
    }

    if (!input.actorName || !input.requirements) {
        throw new Error('Both "actorName" and "requirements" are required.');
    }

    const runId = process.env.ACTOR_RUN_ID || null;
    const storeId = process.env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID || null;
    requestSummary = {
        actorName: input.actorName,
        requirements: String(input.requirements).slice(0, 2000),
        language: input.language ?? null,
        customerUserId: input.customerContext?.customerUserId ?? null,
        customerRunId: input.customerContext?.customerActorRunId ?? null,
        submittedAt: input.customerContext?.submittedAt ?? null,
        customerPayPerEvent: input.customerContext?.billing?.isPayPerEvent ?? null,
        customerMaxTotalChargeUsd: input.customerContext?.billing?.maxTotalChargeUsd ?? null,
        problemReported: Boolean(input.problemReport && typeof input.problemReport === 'object'),
        failedRunId: input.problemReport?.failedRunId ?? null,
    };

    // Update of an existing Actor: stage the previous ZIP in this run before registering the request.
    // Actor #1 passes the previous delivery when it can read the customer's runs; otherwise this Actor looks it up
    // in the per-customer delivery index kept in the archive store.
    let previousZip = null;
    let previousLookupError = null;
    if (input.previousZipUrl || input.previousGeneratorRunId) {
        previousZip = await stagePreviousZip(input, 'input');
    } else {
        let indexed = null;
        try {
            indexed = await findIndexedDelivery(input);
        } catch (error) {
            // Typically "Insufficient permissions": this Actor runs with limited permissions and no TOKEN env var,
            // so it cannot read the named archive store. Continue as a new Actor but make the problem visible.
            previousLookupError = error.message;
            log.warning(`Could not check the delivery index for a previous version (${error.message}). Give this Actor full permissions or a TOKEN env var; continuing as a new Actor.`);
        }
        if (indexed) {
            previousZip = await stagePreviousZip({
                ...input,
                previousGeneratorRunId: indexed.generatorRunId,
                previousCustomerRunId: indexed.customerRunId ?? undefined,
                previousActorName: indexed.actorName ?? input.actorName,
            }, 'archive-index');
        }
    }
    if (previousZip) log.info('Previous version staged for the update.', previousZip);
    else if (!previousLookupError) log.info('No previous version found for this customer and Actor name; this is a new Actor.');

    const problemReport = input.problemReport && typeof input.problemReport === 'object' ? input.problemReport : null;
    if (problemReport) {
        // Log only metadata; the pasted log may contain the customer's secrets.
        log.info('Problem report attached to the request.', {
            errorLogChars: problemReport.errorLogChars ?? 0,
            hasFailedRunInput: Boolean(problemReport.failedRunInput),
            failedRunId: problemReport.failedRunId ?? null,
        });
        if (!previousZip) {
            log.warning('The problem report refers to an existing Actor, but no previous version was found for this customer and name; treating the request as a new Actor.');
        }
    }

    const generationRequest = {
        ...input,
        revision: Boolean(previousZip),
        previousZip,
        previousLookupError,
        generatorRunId: runId,
        generatorDefaultKeyValueStoreId: storeId,
        createdAt: new Date().toISOString(),
    };

    await Actor.setValue(REQUEST_KEY, generationRequest);
    await Actor.setValue(STATUS_KEY, {
        status: 'IN_PROGRESS',
        revision: Boolean(previousZip),
        generatorRunId: runId,
        zipKey: ZIP_KEY,
        updatedAt: new Date().toISOString(),
    });

    const kind = previousZip ? (problemReport ? 'fix for an existing Actor' : 'update of an existing Actor') : 'new Actor';
    await Actor.setStatusMessage(`Generating "${input.actorName}" (${kind}). Request ID: ${runId ?? 'unknown'}`);

    log.info(`Generation request registered (${kind}).`, {
        requestId: runId,
        actorName: input.actorName,
        revision: Boolean(previousZip),
    });
    log.info(`Request ID: ${runId}. Generation is in progress; this run finishes when the Actor package is ready.`);

    // Wait until the Actor package appears in this run's key-value store.
    while (true) {
        const zip = await Actor.getValue(ZIP_KEY);

        if (zip !== null) {
            const zipBytes = Buffer.isBuffer(zip)
                ? zip.length
                : Buffer.byteLength(String(zip));
            const zipUrl = storeId ? `https://api.apify.com/v2/key-value-stores/${storeId}/records/${ZIP_KEY}` : null;

            await Actor.setValue(STATUS_KEY, {
                status: 'COMPLETED',
                revision: Boolean(previousZip),
                generatorRunId: runId,
                zipKey: ZIP_KEY,
                zipBytes,
                updatedAt: new Date().toISOString(),
            });

            await Actor.setValue('OUTPUT', {
                status: 'SUCCEEDED',
                revision: Boolean(previousZip),
                previousGeneratorRunId: previousZip?.generatorRunId ?? null,
                previousCustomerRunId: previousZip?.customerRunId ?? null,
                previousLookup: previousZip?.lookup ?? null,
                generatorRunId: runId,
                zipKey: ZIP_KEY,
                zipUrl,
                zipBytes,
                finishedAt: new Date().toISOString(),
            });

            // Local Codex writes GENERATED_ACTOR_META alongside the ZIP: file list, hash and the billing decision.
            const meta = (await Actor.getValue(META_KEY)) ?? {};
            await pushResultItem({
                status: 'SUCCEEDED',
                requestType: previousZip ? (problemReport ? 'fix' : 'update') : 'new',
                revision: Boolean(previousZip),
                previousLookup: previousZip?.lookup ?? null,
                previousSource: previousZip?.source ?? null,
                previousIntegrity: previousZip?.integrity ?? null,
                previousGeneratorRunId: previousZip?.generatorRunId ?? null,
                previousCustomerRunId: previousZip?.customerRunId ?? null,
                previousLookupError,
                zipUrl,
                zipBytes,
                zipSha256: meta.sha256 ?? null,
                zipFiles: Array.isArray(meta.files) ? meta.files.length : null,
                generatedActorName: meta.actorName ?? null,
                generatedActorVersion: meta.actorVersion ?? null,
                tier: meta.tier ?? null,
                chargeEvent: meta.chargeEvent ?? null,
                billingLabel: meta.billing?.label ?? null,
                billingReasons: Array.isArray(meta.billing?.reasons) ? meta.billing.reasons.join('; ') : null,
                complexityScore: meta.billing?.complexity?.score ?? null,
                changedRatio: meta.billing?.change?.changedRatio ?? null,
                warrantyAnchorAt: meta.billing?.warrantyAnchorAt ?? null,
                uploadedAt: meta.uploadedAt ?? null,
                message: 'Actor package ready.',
            });

            await Actor.setStatusMessage(zipUrl ? `Actor package ready: ${zipUrl}` : 'Actor package ready.');
            log.info(`Actor package ready (${zipBytes} bytes).`);
            if (zipUrl) log.info(`Generated Actor ZIP: ${zipUrl}`);
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
} catch (error) {
    log.exception(error, 'Actor generation failed');
    await pushResultItem({ status: 'FAILED', message: String(error.message).slice(0, 500) });
    // Actor.fail() exits with a non-zero code so the run is marked FAILED. (Actor.exit() in a finally block would exit 0.)
    await Actor.fail(String(error.message).slice(0, 500));
}

await Actor.exit();

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Write the run's summary as one item in the default dataset. A dataset failure must never mask the real outcome. */
async function pushResultItem(fields) {
    const item = {
        status: fields.status,
        requestId: process.env.ACTOR_RUN_ID ?? null,
        ...requestSummary,
        requestType: fields.requestType ?? null,
        revision: fields.revision ?? null,
        previousLookup: fields.previousLookup ?? null,
        previousSource: fields.previousSource ?? null,
        previousIntegrity: fields.previousIntegrity ?? null,
        previousGeneratorRunId: fields.previousGeneratorRunId ?? null,
        previousCustomerRunId: fields.previousCustomerRunId ?? null,
        previousLookupError: fields.previousLookupError ?? null,
        generatedActorName: fields.generatedActorName ?? null,
        generatedActorVersion: fields.generatedActorVersion ?? null,
        zipUrl: fields.zipUrl ?? null,
        zipBytes: fields.zipBytes ?? null,
        zipSha256: fields.zipSha256 ?? null,
        zipFiles: fields.zipFiles ?? null,
        tier: fields.tier ?? null,
        chargeEvent: fields.chargeEvent ?? null,
        billingLabel: fields.billingLabel ?? null,
        billingReasons: fields.billingReasons ?? null,
        complexityScore: fields.complexityScore ?? null,
        changedRatio: fields.changedRatio ?? null,
        warrantyAnchorAt: fields.warrantyAnchorAt ?? null,
        uploadedAt: fields.uploadedAt ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: fields.message ?? null,
    };
    try {
        await Actor.pushData(item);
    } catch (pushError) {
        log.warning(`Could not write the result to the dataset: ${pushError.message}`);
    }
}

/**
 * API client for reading previous deliveries. Under Apify's default limited permissions the run token cannot
 * read the named archive store, so a TOKEN env var (your own token, marked secret) is used when present.
 */
function apiClient() {
    return Actor.newClient(process.env.TOKEN ? { token: process.env.TOKEN } : undefined);
}

/** Same Actor-name normalisation as Local Codex uses for the delivery index keys. */
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

/**
 * Look up the customer's latest delivery of an Actor with this name in the delivery index
 * (record index-<customerUserId>.json in the archive store, written by Local Codex on every upload).
 */
async function findIndexedDelivery(input) {
    const customerUserId = input.customerContext?.customerUserId;
    if (!customerUserId) {
        log.info('No customer user ID in the request; cannot look up previous versions.');
        return null;
    }
    const client = apiClient();
    const archive = await client.keyValueStores().getOrCreate(ARCHIVE_STORE_NAME);
    const index = (await client.keyValueStore(archive.id).getRecord(`index-${customerUserId}.json`))?.value;
    const entry = index?.deliveries?.[slug(input.actorName)];
    if (!entry?.generatorRunId) return null;
    log.info(`Delivery index: "${input.actorName}" was delivered to this customer by request ${entry.generatorRunId}; treating this request as an update.`);
    return entry;
}

function assertActorZip(buffer, label) {
    if (!buffer || buffer.length === 0) throw new Error(`${label} is empty.`);
    if (buffer.length > MAX_PREVIOUS_ZIP_BYTES) throw new Error(`${label} is ${buffer.length} bytes; the limit is ${MAX_PREVIOUS_ZIP_BYTES} bytes.`);
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) throw new Error(`${label} is not a ZIP file.`);
    if (!buffer.includes('.actor/actor.json')) throw new Error(`${label} does not contain .actor/actor.json.`);
}

/** Parse an Apify key-value store record URL into { storeId, key }, or return null. */
function parseRecordUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'api.apify.com') return null;
        const match = parsed.pathname.match(/^\/v2\/key-value-stores\/([^/]+)\/records\/(.+)$/);
        return match ? { storeId: match[1], key: decodeURIComponent(match[2]) } : null;
    } catch {
        return null;
    }
}

/** Download a ZIP from a URL: Apify record URLs are read with this account's token, anything else over HTTP. */
async function downloadZip(client, url) {
    const record = parseRecordUrl(url);
    if (record) {
        const result = await client.keyValueStore(record.storeId).getRecord(record.key, { buffer: true });
        if (!result?.value?.length) throw new Error(`No record found at ${url}.`);
        return Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
    }
    if (!/^https?:\/\//i.test(url)) throw new Error(`previousZipUrl "${url}" is not an http(s) URL.`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Download of ${url} failed with HTTP ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Stage the previous Actor ZIP into this run's default key-value store as PREVIOUS_ACTOR_ZIP.
 * Source order: previousZipUrl (uploaded by the customer Actor), then the previous generator run's storage,
 * then the named archive. When the previous generator run is known, the ZIP is compared with the hash of the
 * original delivery so the operator knows whether the customer's copy is unmodified.
 */
async function stagePreviousZip(input, lookup) {
    const client = apiClient();
    const previousGeneratorRunId = input.previousGeneratorRunId ? String(input.previousGeneratorRunId) : null;
    let zip = null;
    let source = null;
    let previousRequest = null;
    let originalSha256 = null;

    if (input.previousZipUrl) {
        zip = await downloadZip(client, String(input.previousZipUrl));
        assertActorZip(zip, 'The ZIP at previousZipUrl');
        if (input.previousZipSha256 && sha256(zip) !== input.previousZipSha256) {
            throw new Error('The ZIP at previousZipUrl does not match previousZipSha256; the transfer is corrupted.');
        }
        source = 'previousZipUrl';
    }

    // Look up the original delivery: needed for the integrity check and as a fallback ZIP source.
    if (previousGeneratorRunId) {
        const previousRun = await client.run(previousGeneratorRunId).get();
        if (previousRun?.defaultKeyValueStoreId) {
            const store = client.keyValueStore(previousRun.defaultKeyValueStoreId);
            previousRequest = (await store.getRecord(REQUEST_KEY))?.value ?? null;
            originalSha256 = (await store.getRecord(META_KEY))?.value?.sha256 ?? null;
            if (!zip) {
                const record = await store.getRecord(ZIP_KEY, { buffer: true });
                if (record?.value?.length) {
                    zip = Buffer.isBuffer(record.value) ? record.value : Buffer.from(record.value);
                    source = 'generator-run';
                }
            }
        }
        if (!previousRequest || !originalSha256 || !zip) {
            const archive = await client.keyValueStores().getOrCreate(ARCHIVE_STORE_NAME);
            const archiveStore = client.keyValueStore(archive.id);
            const meta = (await archiveStore.getRecord(`${previousGeneratorRunId}.json`))?.value ?? null;
            previousRequest = previousRequest ?? meta?.request ?? null;
            originalSha256 = originalSha256 ?? meta?.sha256 ?? null;
            if (!zip) {
                const record = await archiveStore.getRecord(`${previousGeneratorRunId}.zip`, { buffer: true });
                if (record?.value?.length) {
                    zip = Buffer.isBuffer(record.value) ? record.value : Buffer.from(record.value);
                    source = 'archive';
                }
            }
        }
    }

    if (!zip) {
        throw new Error(
            `No previous Actor ZIP available: previousZipUrl ${input.previousZipUrl ? 'failed' : 'not given'} and request ${previousGeneratorRunId ?? 'unknown'} has no stored or archived ZIP.`,
        );
    }
    assertActorZip(zip, 'The previous Actor ZIP');

    const digest = sha256(zip);
    let integrity = 'unknown';
    if (originalSha256) integrity = originalSha256 === digest ? 'verified' : 'modified';
    if (integrity === 'modified') {
        log.warning('The previous ZIP differs from the original delivery; it will be reviewed before it is run.', { previousGeneratorRunId });
    } else if (integrity === 'unknown') {
        log.warning('The original delivery hash is unavailable, so the previous ZIP could not be verified.', { previousGeneratorRunId });
    }

    // The previous request should belong to the same customer run and, when recorded, the same user.
    const boundCustomerRunId = previousRequest?.customerContext?.customerActorRunId ?? null;
    if (input.previousCustomerRunId && boundCustomerRunId && boundCustomerRunId !== input.previousCustomerRunId) {
        throw new Error(
            `Request ${previousGeneratorRunId} was produced for customer run ${boundCustomerRunId}, not ${input.previousCustomerRunId}.`,
        );
    }
    const boundUserId = previousRequest?.customerContext?.customerUserId ?? null;
    const currentUserId = input.customerContext?.customerUserId ?? null;
    if (boundUserId && currentUserId && boundUserId !== currentUserId) {
        throw new Error(`Request ${previousGeneratorRunId} belongs to a different customer.`);
    }

    await Actor.setValue(PREVIOUS_ZIP_KEY, zip, { contentType: 'application/zip' });

    // Remove the inbox copy the customer Actor uploaded; it is now staged in this run.
    const inbox = input.previousZipUrl ? parseRecordUrl(String(input.previousZipUrl)) : null;
    if (inbox && inbox.key.startsWith('inbox-')) {
        try {
            await client.keyValueStore(inbox.storeId).deleteRecord(inbox.key);
        } catch (error) {
            log.warning(`Could not delete inbox record ${inbox.key}: ${error.message}`);
        }
    }

    return {
        key: PREVIOUS_ZIP_KEY,
        bytes: zip.length,
        sha256: digest,
        source,
        lookup,
        url: input.previousZipUrl ?? null,
        integrity,
        generatorRunId: previousGeneratorRunId,
        customerRunId: input.previousCustomerRunId ?? boundCustomerRunId ?? null,
        previousActorName: previousRequest?.actorName ?? input.previousActorName ?? null,
        previousRequirements: previousRequest?.requirements ?? null,
    };
}
