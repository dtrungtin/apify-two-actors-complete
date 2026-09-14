// Self-test for the Local Codex tooling. It round-trips every Apify API path (fetch request,
// upload ZIP, archive, revision staging) against temporary key-value stores in YOUR account, so no
// running Generator Actor is needed. All temporary stores are deleted at the end.
// Flags: --run includes the local smoke run, --keep leaves work/<runId>/ folders in place.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { ApifyClient } from 'apify-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['.actor/actor.json', '.actor/input_schema.json', 'src/main.js', 'package.json', 'Dockerfile', 'README.md'];
const stamp = Date.now();
const RUN_1 = `SELFTEST-${stamp}-A`;
const RUN_2 = `SELFTEST-${stamp}-B`;
const ARCHIVE_NAME = `local-codex-selftest-archive-${stamp}`;
const withRun = process.argv.includes('--run');
const keep = process.argv.includes('--keep');

const token = process.env.APIFY_TOKEN || process.env.TOKEN;
if (!token) {
    console.error('Set APIFY_TOKEN first.');
    process.exit(1);
}
const client = new ApifyClient({ token });

function step(script, ...args) {
    console.log(`\n>>> node src/${script} ${args.join(' ')}`);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'src', script), ...args], {
        cwd: ROOT,
        env: { ...process.env, LOCAL_CODEX_ARCHIVE_STORE: ARCHIVE_NAME },
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (result.status !== 0) throw new Error(`${script} exited with code ${result.status}`);
}

function zipEntries(buffer) {
    return new AdmZip(buffer).getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort();
}

async function downloadZip(storeId) {
    const record = await client.keyValueStore(storeId).getRecord('GENERATED_ACTOR_ZIP', { buffer: true });
    if (!record || record.contentType !== 'application/zip') throw new Error(`unexpected record: ${record?.contentType}`);
    const entries = zipEntries(record.value);
    const missing = REQUIRED.filter((f) => !entries.includes(f));
    if (missing.length) throw new Error(`ZIP downloaded from Apify is missing ${missing.join(', ')}`);
    return { buffer: record.value, entries };
}

const baseRequest = {
    actorName: 'Self Test Title Scraper',
    requirements: 'Visit each start URL and save the page title to the dataset.\nStop after maxResults items.',
    language: 'JavaScript',
    notes: 'Created by local-codex selftest.',
    customerContext: { customerActorRunId: 'SELFTEST-CUSTOMER-RUN', customerUserId: 'SELFTEST-USER', submittedAt: new Date().toISOString() },
};

const stores = [];
let ok = false;
try {
    // Scenario 1: a fresh generation request.
    const store1 = await client.keyValueStores().getOrCreate(`local-codex-selftest-${stamp}-a`);
    stores.push(store1);
    console.log(`Scenario 1 (new Actor): temporary store ${store1.id}`);
    await client.keyValueStore(store1.id).setRecord({ key: 'GENERATION_REQUEST', value: baseRequest });

    step('fetch-request.js', RUN_1, '--kvs', store1.id);
    step('scaffold.js', RUN_1);
    step('validate.js', RUN_1, ...(withRun ? ['--run'] : []));
    step('package-zip.js', RUN_1);
    step('upload-zip.js', RUN_1, '--kvs', store1.id);

    console.log('\n>>> verify scenario 1 by downloading GENERATED_ACTOR_ZIP');
    const first = await downloadZip(store1.id);
    console.log(`   [OK] ${first.buffer.length} bytes, ${first.entries.length} files, all required files at the archive root`);

    // Scenario 2: a revision that starts from the ZIP produced in scenario 1 (as Actor #2 stages it).
    const store2 = await client.keyValueStores().getOrCreate(`local-codex-selftest-${stamp}-b`);
    stores.push(store2);
    console.log(`\nScenario 2 (revision): temporary store ${store2.id}`);
    await client.keyValueStore(store2.id).setRecord({ key: 'PREVIOUS_ACTOR_ZIP', value: first.buffer, contentType: 'application/zip' });
    await client.keyValueStore(store2.id).setRecord({
        key: 'GENERATION_REQUEST',
        value: {
            ...baseRequest,
            requirements: 'Add an optional "minTitleLength" input and skip pages whose title is shorter.',
            problemReport: {
                errorLog: 'ERROR Actor failed\n  TypeError: title is undefined',
                errorLogTruncated: false,
                errorLogChars: 48,
                failedRunInput: { startUrls: [{ url: 'https://example.com' }], maxResults: 1 },
                failedRunId: 'SELFTEST-FAILED-RUN',
                reportedAt: new Date().toISOString(),
            },
            previousGeneratorRunId: RUN_1,
            previousCustomerRunId: 'SELFTEST-CUSTOMER-RUN',
            revision: true,
            previousZip: {
                key: 'PREVIOUS_ACTOR_ZIP',
                bytes: first.buffer.length,
                source: 'previousZipUrl',
                url: `https://api.apify.com/v2/key-value-stores/${store2.id}/records/inbox-selftest.zip`,
                integrity: 'verified',
                generatorRunId: RUN_1,
                customerRunId: 'SELFTEST-CUSTOMER-RUN',
                previousActorName: baseRequest.actorName,
                previousRequirements: baseRequest.requirements,
            },
        },
    });

    step('fetch-request.js', RUN_2, '--kvs', store2.id);
    step('scaffold.js', RUN_2);
    step('generate.js', RUN_2, '--command', `node -e "console.log('revision prompt ok:', require('fs').readFileSync(process.env.PROMPT_FILE, 'utf8').includes('REVISING'))"`);
    step('validate.js', RUN_2, ...(withRun ? ['--run'] : []));
    step('package-zip.js', RUN_2);
    step('upload-zip.js', RUN_2, '--kvs', store2.id);

    console.log('\n>>> verify scenario 2: the revision ZIP must contain the previous files and keep the Actor name');
    const second = await downloadZip(store2.id);
    const previousFiles = first.entries.filter((e) => e !== 'package-lock.json');
    const missing = previousFiles.filter((e) => !second.entries.includes(e));
    if (missing.length) throw new Error(`revision ZIP lost files from the previous Actor: ${missing.join(', ')}`);
    const nameBefore = JSON.parse(new AdmZip(first.buffer).readAsText('.actor/actor.json')).name;
    const nameAfter = JSON.parse(new AdmZip(second.buffer).readAsText('.actor/actor.json')).name;
    if (nameBefore !== nameAfter) throw new Error(`actor.json name changed from ${nameBefore} to ${nameAfter}`);
    const requestDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', RUN_2, 'request.json'), 'utf8'));
    if (!requestDoc.revision || !fs.existsSync(requestDoc.previousZip.file)) throw new Error('request.json does not record the revision / previous ZIP');
    if (!requestDoc.problemReport?.logFile || !fs.existsSync(requestDoc.problemReport.logFile)) throw new Error('reported-error.log was not written');
    if (!requestDoc.problemReport?.inputFile || !fs.existsSync(requestDoc.problemReport.inputFile)) throw new Error('reported-input.json was not written');
    const prompt = fs.readFileSync(path.join(ROOT, 'work', RUN_2, 'PROMPT.md'), 'utf8');
    if (!prompt.includes('BEGIN CUSTOMER LOG') || !prompt.includes('END CUSTOMER LOG')) throw new Error('PROMPT.md lacks the quoted customer log markers');
    console.log('   [OK] problem report files written and quoted in the prompt');
    console.log(`   [OK] ${second.entries.length} files, name "${nameAfter}" preserved, previous ZIP recorded at ${path.basename(requestDoc.previousZip.file)}`);

    console.log('\n>>> verify archive store');
    const archive = await client.keyValueStores().getOrCreate(ARCHIVE_NAME);
    stores.push(archive);
    const archiveKeys = (await client.keyValueStore(archive.id).listKeys()).items.map((k) => k.key).sort();
    const expected = [`${RUN_1}.json`, `${RUN_1}.zip`, `${RUN_2}.json`, `${RUN_2}.zip`];
    const missingArchive = expected.filter((k) => !archiveKeys.includes(k));
    if (missingArchive.length) throw new Error(`archive is missing ${missingArchive.join(', ')}`);
    const archivedMeta = await client.keyValueStore(archive.id).getRecord(`${RUN_2}.json`);
    if (archivedMeta?.value?.previousGeneratorRunId !== RUN_1) throw new Error('archived meta does not record previousGeneratorRunId');
    console.log(`   [OK] archive "${ARCHIVE_NAME}" holds ${archiveKeys.join(', ')}`);
    ok = true;
} finally {
    // The archive store is created by upload-zip.js; make sure it is removed even when a step failed early.
    if (!stores.some((s) => s.name === ARCHIVE_NAME)) {
        const archive = await client.keyValueStores().getOrCreate(ARCHIVE_NAME);
        stores.push(archive);
    }
    for (const store of stores) {
        await client.keyValueStore(store.id).delete();
        console.log(`Deleted temporary store ${store.id} (${store.name})`);
    }
    if (!keep) {
        for (const runId of [RUN_1, RUN_2]) fs.rmSync(path.join(ROOT, 'work', runId), { recursive: true, force: true });
    }
}
console.log(ok ? '\nSELFTEST PASSED' : '\nSELFTEST FAILED');
process.exit(ok ? 0 : 1);
