import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
    REQUIRED_FILES, exists, formatBytes, isMain, log, parseArgs, readJson, resolveRunId, sha256, walkFiles, workPaths, writeJson,
} from './lib.js';

const USAGE = `Usage: node src/package-zip.js <generatorRunId> [--out <file.zip>]

Zips work/<runId>/actor/ into work/<runId>/<actorName>.zip with all files at the archive root
(the layout Apify expects). node_modules/, storage/ and similar folders are excluded.`;

const LARGE_ZIP_BYTES = 5 * 1024 * 1024;

export function packageZip(runId, { out } = {}) {
    const paths = workPaths(runId);
    const { actorDir } = paths;
    if (!exists(actorDir)) throw new Error(`${actorDir} not found. Run scaffold.js first.`);

    const actorJson = readJson(path.join(actorDir, '.actor', 'actor.json'));
    const zipPath = out ? path.resolve(out) : path.join(paths.dir, `${actorJson.name}.zip`);

    const files = walkFiles(actorDir).filter((f) => !f.rel.endsWith('.zip'));
    const present = new Set(files.map((f) => f.rel));
    const missing = REQUIRED_FILES.filter((f) => !present.has(f));
    if (missing.length) throw new Error(`Cannot package: missing required files ${missing.join(', ')}`);

    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.rel, fs.readFileSync(file.abs));
    zip.writeZip(zipPath);

    // Re-open the archive from disk and verify it independently of the in-memory object.
    const entries = new AdmZip(zipPath).getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName);
    for (const required of REQUIRED_FILES) {
        if (!entries.includes(required)) throw new Error(`ZIP verification failed: ${required} is not at the archive root`);
    }

    const buffer = fs.readFileSync(zipPath);
    const result = {
        zipPath,
        actorName: actorJson.name,
        actorVersion: actorJson.version ?? null,
        bytes: buffer.length,
        sha256: sha256(buffer),
        entries,
        createdAt: new Date().toISOString(),
    };
    writeJson(paths.zipMetaFile, result);

    log.ok(`Created ${zipPath} (${formatBytes(buffer.length)}, ${entries.length} files)`);
    for (const e of entries) log.info(`  ${e}`);
    if (buffer.length > LARGE_ZIP_BYTES) log.warn('ZIP is unusually large for source code; check for stray build artefacts');
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
        log.step(`Package Actor ZIP for run ${runId}`);
        const result = packageZip(runId, { out: flags.out });
        log.info(`sha256 ${result.sha256}`);
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
