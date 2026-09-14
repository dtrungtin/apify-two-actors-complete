import fs from 'node:fs';
import path from 'node:path';
import {
    ARCHIVE_STORE_NAME, KEYS, consoleRunUrl, exists, formatBytes, getClient, isMain, kvsRecordUrl, log, parseArgs, readJson,
    resolveRunId, sha256, sleep, slugify, workPaths, writeJson,
} from './lib.js';
import { TIERS, TIER_EVENTS, assessComplexity, decideTier, measureChange, nextWarrantyAnchor } from './billing.js';

const USAGE = `Usage: node src/upload-zip.js <generatorRunId> [--zip <file.zip>] [--tier <tier>] [--kvs <storeId>] [--force] [--wait <seconds>] [--no-archive]

Uploads the ZIP to the Generator Actor run's default key-value store as GENERATED_ACTOR_ZIP
(content type application/zip), archives a copy in the named store "${ARCHIVE_STORE_NAME}" so
revisions keep working after run storage expires, then waits for Actor #2 to notice it and finish.

  --zip <file>     ZIP to upload (default: the ZIP recorded in work/<runId>/zip.json).
  --tier <tier>    Override the automatic billing tier (standard | advanced | revision | free). Normally not needed:
                   the tier is decided from the code's complexity, the size of the change against the previous
                   version, and the warranty window for problem reports (see src/billing.js).
  --kvs <storeId>  Upload to this store instead of resolving the run (debugging only).
  --force          Upload even if the run is no longer RUNNING.
  --wait <secs>    How long to wait for the run to finish after upload (default 90, 0 to skip).
  --no-archive     Skip the archive copy. LOCAL_CODEX_ARCHIVE_STORE overrides the store name.`;

const NO_PREVIOUS_DELIVERY = { deliveredAt: null, warrantyAnchorAt: null };

/**
 * Dates of the previous delivery, from the archive meta or the delivery index:
 *   deliveredAt      when the previous ZIP was uploaded;
 *   warrantyAnchorAt when this Actor was last delivered at a billable tier. Free deliveries carry the anchor of the
 *                    delivery before them, so the warranty always counts from the last billable one. Records written
 *                    before the anchor existed fall back to their delivery date.
 * Both are null when nothing is known.
 */
async function findPreviousDelivery(client, requestDoc) {
    const previousGeneratorRunId = requestDoc?.previousZip?.generatorRunId ?? null;
    const customerUserId = requestDoc?.request?.customerContext?.customerUserId ?? null;
    const actorName = requestDoc?.request?.actorName ?? null;
    if (!previousGeneratorRunId && !(customerUserId && actorName)) return NO_PREVIOUS_DELIVERY;
    try {
        const archive = await client.keyValueStores().getOrCreate(ARCHIVE_STORE_NAME);
        const store = client.keyValueStore(archive.id);
        if (previousGeneratorRunId) {
            const meta = (await store.getRecord(`${previousGeneratorRunId}.json`))?.value;
            const deliveredAt = meta?.uploadedAt ?? meta?.archivedAt ?? null;
            if (deliveredAt) return { deliveredAt, warrantyAnchorAt: meta.billing?.warrantyAnchorAt ?? deliveredAt };
        }
        if (customerUserId && actorName) {
            const index = (await store.getRecord(`index-${customerUserId}.json`))?.value;
            const entry = index?.deliveries?.[slugify(actorName)];
            if (entry?.deliveredAt) return { deliveredAt: entry.deliveredAt, warrantyAnchorAt: entry.warrantyAnchorAt ?? entry.deliveredAt };
        }
    } catch (error) {
        log.warn(`Could not read the previous delivery (${error.message}); no warranty applied.`);
    }
    return NO_PREVIOUS_DELIVERY;
}

/** Work out the billing tier for this delivery, automatically unless --tier overrides it. */
async function resolveBilling(client, paths, requestDoc, override) {
    const actorDir = paths.actorDir;
    const complexity = exists(actorDir) ? assessComplexity(actorDir) : { score: 0, level: 'standard', signals: [], sourceLines: 0, sourceFiles: 0, inputFields: 0, dependencies: [] };
    const isRevision = Boolean(requestDoc?.revision);
    let change = null;
    if (isRevision && exists(paths.previousZipFile) && exists(actorDir)) {
        try {
            change = measureChange(paths.previousZipFile, actorDir);
        } catch (error) {
            log.warn(`Could not compare with the previous version (${error.message}).`);
        }
    }
    const previous = isRevision ? await findPreviousDelivery(client, requestDoc) : NO_PREVIOUS_DELIVERY;
    const automatic = decideTier({
        isRevision,
        hasProblemReport: Boolean(requestDoc?.problemReport),
        warrantyAnchorAt: previous.warrantyAnchorAt,
        complexity,
        change,
    });
    const decision = override
        ? {
            ...automatic,
            tier: override,
            event: TIER_EVENTS[override],
            label: `${override} (operator override)`,
            reasons: [`operator override --tier ${override}`, `automatic decision would have been ${automatic.tier}: ${automatic.reasons.join('; ')}`],
            overridden: true,
        }
        : { ...automatic, overridden: false };
    return {
        ...decision,
        previousDeliveredAt: previous.deliveredAt,
        previousWarrantyAnchorAt: previous.warrantyAnchorAt,
        // The anchor this delivery hands on: a billable tier opens a new warranty window, a free one keeps the old anchor.
        warrantyAnchorAt: nextWarrantyAnchor(decision, previous.warrantyAnchorAt),
        complexity,
        change,
    };
}

function resolveZipPath(paths, explicit) {
    if (explicit) return path.resolve(explicit);
    if (exists(paths.zipMetaFile)) {
        const { zipPath } = readJson(paths.zipMetaFile);
        if (exists(zipPath)) return zipPath;
    }
    const candidates = exists(paths.dir) ? fs.readdirSync(paths.dir).filter((f) => f.endsWith('.zip') && f !== 'previous-actor.zip') : [];
    if (candidates.length === 1) return path.join(paths.dir, candidates[0]);
    throw new Error(candidates.length === 0
        ? `No ZIP found in ${paths.dir}. Run package-zip.js first or pass --zip.`
        : `Several ZIPs found in ${paths.dir}; pass --zip to choose one.`);
}

export async function uploadZip(runId, { zipPath: explicitZip, kvsId, force = false, waitSecs = 90, noArchive = false, tier } = {}) {
    const paths = workPaths(runId);
    const zipPath = resolveZipPath(paths, explicitZip);
    const buffer = fs.readFileSync(zipPath);
    if (buffer.length === 0) throw new Error(`${zipPath} is empty`);
    if (tier !== undefined && !TIERS.includes(tier)) {
        throw new Error(`--tier must be one of ${TIERS.join(', ')} (got "${tier}")`);
    }

    const client = getClient();
    let run = null;
    let storeId = kvsId ?? null;
    if (!storeId) {
        run = await client.run(runId).get();
        if (!run) throw new Error(`Run ${runId} was not found. Check that APIFY_TOKEN belongs to the account that owns the Generator Actor.`);
        storeId = run.defaultKeyValueStoreId;
        log.info(`Run status: ${run.status}`);
        if (run.status !== 'RUNNING' && !force) {
            throw new Error(`Generator run is ${run.status}. Actor #2 only picks up the ZIP while RUNNING; pass --force to upload anyway.`);
        }
    }

    const store = client.keyValueStore(storeId);
    const digest = sha256(buffer);
    const zipMeta = exists(paths.zipMetaFile) ? readJson(paths.zipMetaFile) : {};
    const requestDoc = exists(paths.requestFile) ? readJson(paths.requestFile) : null;
    const isRevision = Boolean(requestDoc?.revision);
    const decision = await resolveBilling(client, paths, requestDoc, tier);
    const billingTier = decision.tier;
    const customerBilling = requestDoc?.request?.customerContext?.billing ?? null;
    if (customerBilling?.isPayPerEvent && decision.event) {
        const price = customerBilling.perEventPrices?.[decision.event];
        const cap = customerBilling.maxTotalChargeUsd;
        if (price !== undefined && cap !== null && cap !== undefined && price > cap) {
            log.warn(`Tier "${billingTier}" costs $${price} but the customer's maximum total charge is $${cap}; the customer Actor will fall back to a cheaper event or charge nothing.`);
        }
    }
    const meta = {
        zipFileName: path.basename(zipPath),
        zipBytes: buffer.length,
        sha256: digest,
        files: zipMeta.entries ?? null,
        actorName: zipMeta.actorName ?? null,
        actorVersion: zipMeta.actorVersion ?? null,
        revision: isRevision,
        previousGeneratorRunId: requestDoc?.previousZip?.generatorRunId ?? null,
        tier: billingTier,
        chargeEvent: decision.event,
        billing: {
            tier: billingTier,
            event: decision.event,
            label: decision.label,
            reasons: decision.reasons,
            overridden: decision.overridden,
            complexity: decision.complexity ? { score: decision.complexity.score, level: decision.complexity.level, signals: decision.complexity.signals, sourceLines: decision.complexity.sourceLines, inputFields: decision.complexity.inputFields } : null,
            change: decision.change ? { functionalChange: decision.change.functionalChange, changedRatio: decision.change.changedRatio, changedLines: decision.change.changedLines, totalLines: decision.change.totalLines, addedFiles: decision.change.addedFiles, removedFiles: decision.change.removedFiles, modifiedFiles: decision.change.modifiedFiles, major: decision.change.major } : null,
            previousDeliveredAt: decision.previousDeliveredAt ?? null,
            previousWarrantyAnchorAt: decision.previousWarrantyAnchorAt ?? null,
            warrantyAnchorAt: decision.warrantyAnchorAt ?? null,
            decidedAt: new Date().toISOString(),
        },
        uploadedAt: new Date().toISOString(),
        uploadedBy: 'local-codex',
    };
    log.info(`Billing decision: ${billingTier}${decision.event ? ` (event ${decision.event})` : ' (no charge)'} - ${decision.label}`);
    for (const reason of decision.reasons) log.info(`  - ${reason}`);
    if (decision.warrantyAnchorAt) {
        log.info(`Warranty for problem reports counts from ${decision.warrantyAnchorAt}${decision.event ? ' (this delivery)' : ' (last billable delivery, unchanged)'}`);
    } else if (isRevision) {
        log.info('Warranty anchor unknown: a later problem report on this Actor will not be treated as a free fix.');
    }

    log.info(`Uploading ${path.basename(zipPath)} (${formatBytes(buffer.length)}) to store ${storeId} as ${KEYS.ZIP}`);
    await store.setRecord({ key: KEYS.ZIP, value: buffer, contentType: 'application/zip' });
    await store.setRecord({ key: KEYS.META, value: meta });

    // Verify by reading the record back: the store's listed size reflects compressed storage, so compare content hashes.
    const check = await store.getRecord(KEYS.ZIP, { buffer: true });
    if (!check || !Buffer.isBuffer(check.value)) {
        throw new Error(`Upload verification failed: could not read ${KEYS.ZIP} back from store ${storeId}`);
    }
    const remoteDigest = sha256(check.value);
    if (remoteDigest !== digest) {
        throw new Error(`Upload verification failed: sha256 mismatch (local ${digest.slice(0, 12)}, remote ${remoteDigest.slice(0, 12)})`);
    }
    log.ok(`Stored and verified ${KEYS.ZIP} (${formatBytes(check.value.length)}, ${check.contentType}, sha256 ${digest.slice(0, 12)}...)`);

    // Archive a copy under the generator run ID so Actor #2 can stage it for future revisions.
    let archive = null;
    if (!noArchive) {
        const archiveStore = await client.keyValueStores().getOrCreate(ARCHIVE_STORE_NAME);
        const archiveClient = client.keyValueStore(archiveStore.id);
        await archiveClient.setRecord({ key: `${runId}.zip`, value: buffer, contentType: 'application/zip' });
        await archiveClient.setRecord({
            key: `${runId}.json`,
            value: { generatorRunId: runId, generatorStoreId: storeId, ...meta, request: requestDoc?.request ?? null, archivedAt: new Date().toISOString() },
        });
        archive = { storeId: archiveStore.id, storeName: ARCHIVE_STORE_NAME, zipKey: `${runId}.zip`, metaKey: `${runId}.json` };
        log.ok(`Archived to key-value store "${ARCHIVE_STORE_NAME}" (${archiveStore.id}) as ${runId}.zip`);

        // Per-customer delivery index: lets Actor #2 recognise a revision (same customer, same Actor name) on its own.
        const customerUserId = requestDoc?.request?.customerContext?.customerUserId ?? null;
        const actorName = requestDoc?.request?.actorName ?? null;
        if (customerUserId && actorName) {
            const indexKey = `index-${customerUserId}.json`;
            const index = (await archiveClient.getRecord(indexKey))?.value ?? { customerUserId, deliveries: {} };
            index.deliveries = index.deliveries ?? {};
            index.deliveries[slugify(actorName)] = {
                generatorRunId: runId,
                customerRunId: requestDoc.request.customerContext?.customerActorRunId ?? null,
                actorName,
                sha256: digest,
                zipBytes: buffer.length,
                revision: meta.revision,
                previousGeneratorRunId: meta.previousGeneratorRunId,
                deliveredAt: new Date().toISOString(),
                tier: billingTier,
                warrantyAnchorAt: decision.warrantyAnchorAt ?? null,
            };
            index.updatedAt = new Date().toISOString();
            await archiveClient.setRecord({ key: indexKey, value: index });
            archive.indexKey = indexKey;
            log.ok(`Delivery index ${indexKey} now maps "${actorName}" to generator run ${runId}`);
        }
    }

    let finalStatus = run?.status ?? null;
    if (run && waitSecs > 0) {
        log.info(`Waiting up to ${waitSecs}s for Actor #2 to detect the ZIP and finish...`);
        const deadline = Date.now() + waitSecs * 1000;
        while (Date.now() < deadline) {
            await sleep(5000);
            const current = await client.run(runId).get();
            finalStatus = current?.status ?? finalStatus;
            if (finalStatus !== 'RUNNING') break;
        }
        if (finalStatus === 'SUCCEEDED') log.ok(`Generator run ${runId} SUCCEEDED. Actor #1 will now copy the ZIP to the customer.`);
        else if (finalStatus === 'RUNNING') log.warn('Generator run is still RUNNING; it polls every 10s, check again shortly.');
        else log.warn(`Generator run finished with status ${finalStatus}.`);
    }

    const result = {
        runId,
        storeId,
        key: KEYS.ZIP,
        zipPath,
        bytes: buffer.length,
        sha256: digest,
        revision: meta.revision,
        recordUrl: kvsRecordUrl(storeId, KEYS.ZIP),
        runUrl: run ? consoleRunUrl(run.actId, runId) : null,
        archive,
        finalRunStatus: finalStatus,
        uploadedAt: new Date().toISOString(),
    };
    writeJson(paths.uploadFile, result);
    log.info(`ZIP record: ${result.recordUrl}`);
    if (result.runUrl) log.info(`Run: ${result.runUrl}`);
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
        log.step(`Upload Actor ZIP for run ${runId}`);
        await uploadZip(runId, {
            zipPath: flags.zip,
            kvsId: flags.kvs,
            force: Boolean(flags.force),
            waitSecs: flags.wait !== undefined ? Number(flags.wait) : undefined,
            noArchive: Boolean(flags['no-archive']),
            tier: flags.tier,
        });
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
