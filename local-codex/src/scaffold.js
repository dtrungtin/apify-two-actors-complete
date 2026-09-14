import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
    REQUIRED_FILES, TEMPLATE_DIR, ZIP_EXCLUDES, ensureDir, exists, isMain, log, parseArgs, readJson, resolveRunId, slugify, truncate,
    walkFiles, workPaths, writeText,
} from './lib.js';

const USAGE = `Usage: node src/scaffold.js <generatorRunId> [--force]

Creates work/<runId>/actor/. For a new Actor it copies local-codex/template/ and fills in the
placeholders from request.json. For a revision it unpacks work/<runId>/previous-actor.zip and adds
any required file that the previous ZIP lacks from the template.
Run fetch-request.js first. An existing actor/ directory is kept unless --force is given.`;

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

export function buildTemplateVars(doc) {
    const { request } = doc;
    const title = String(request.actorName).trim();
    const requirements = String(request.requirements).trim();
    const firstLine = requirements.split(/\r?\n/).find((l) => l.trim()) ?? title;
    return {
        ACTOR_NAME: slugify(title),
        ACTOR_TITLE: title,
        ACTOR_DESCRIPTION: truncate(firstLine, 200),
        REQUIREMENTS: requirements,
        REQUIREMENTS_COMMENT: requirements.split(/\r?\n/).map((l) => `// ${l}`).join('\n'),
        GENERATOR_RUN_ID: String(doc.generatorRunId),
        GENERATED_AT: new Date().toISOString(),
        LANGUAGE: String(request.language || 'JavaScript'),
    };
}

function renderTemplate(text, vars, { json }) {
    return text.replace(PLACEHOLDER, (match, name) => {
        if (!(name in vars)) throw new Error(`Unknown template placeholder ${match}`);
        const value = String(vars[name]);
        return json ? JSON.stringify(value).slice(1, -1) : value;
    });
}

/** Split a ZIP entry name into safe path segments, or return null if it must be skipped. */
function safeSegments(entryName) {
    const normalized = String(entryName).replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
    const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
    if (segments.length === 0) return null;
    if (segments.some((s) => s === '..')) return null;
    if (segments.some((s) => ZIP_EXCLUDES.has(s))) return null;
    return segments;
}

/** Unpack a previous Actor ZIP into actorDir, guarding against path traversal and stripping a single wrapper folder. */
export function unpackPreviousZip(zipPath, actorDir) {
    const zip = new AdmZip(zipPath);
    let entries = zip.getEntries()
        .filter((e) => !e.isDirectory)
        .map((entry) => ({ entry, segments: safeSegments(entry.entryName) }))
        .filter((x) => x.segments);

    let strippedRoot = null;
    const atRoot = entries.some((x) => x.segments.join('/') === '.actor/actor.json');
    if (!atRoot) {
        const roots = new Set(entries.map((x) => x.segments[0]));
        if (roots.size === 1) {
            strippedRoot = [...roots][0];
            entries = entries
                .map((x) => ({ ...x, segments: x.segments.slice(1) }))
                .filter((x) => x.segments.length > 0);
        }
    }

    const files = [];
    for (const { entry, segments } of entries) {
        const target = path.join(actorDir, ...segments);
        const relative = path.relative(actorDir, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, entry.getData());
        files.push(segments.join('/'));
    }
    return { files: files.sort(), strippedRoot };
}

export function scaffold(runId, { force = false } = {}) {
    const paths = workPaths(runId);
    if (!exists(paths.requestFile)) {
        throw new Error(`${paths.requestFile} not found. Run fetch-request.js first.`);
    }
    const doc = readJson(paths.requestFile);
    const vars = buildTemplateVars(doc);

    if (exists(paths.actorDir)) {
        if (!force) {
            log.info(`${paths.actorDir} already exists. Keeping it (use --force to recreate).`);
            return { actorDir: paths.actorDir, skipped: true, vars, files: [], revision: Boolean(doc.revision) };
        }
        fs.rmSync(paths.actorDir, { recursive: true, force: true });
        log.warn(`Removed existing ${paths.actorDir}`);
    }

    // Revision: start from the customer's previous Actor instead of the template.
    if (doc.revision) {
        const zipPath = doc.previousZip?.file ?? paths.previousZipFile;
        if (!exists(zipPath)) {
            throw new Error(`Revision request but ${zipPath} is missing. Run fetch-request.js again.`);
        }
        const { files, strippedRoot } = unpackPreviousZip(zipPath, paths.actorDir);
        if (files.length === 0) throw new Error(`The previous ZIP ${zipPath} contained no usable files.`);
        if (strippedRoot) log.info(`Stripped wrapper folder "${strippedRoot}/" from the previous ZIP`);

        const filledFromTemplate = [];
        for (const file of walkFiles(TEMPLATE_DIR, new Set())) {
            if (!REQUIRED_FILES.includes(file.rel)) continue;
            const target = path.join(paths.actorDir, ...file.rel.split('/'));
            if (exists(target)) continue;
            const rendered = renderTemplate(fs.readFileSync(file.abs, 'utf8'), vars, { json: file.rel.endsWith('.json') });
            writeText(target, rendered);
            filledFromTemplate.push(file.rel);
        }

        log.ok(`Unpacked ${files.length} files from the previous Actor into ${paths.actorDir}`);
        for (const f of files) log.info(`  ${f}`);
        if (filledFromTemplate.length) {
            log.warn(`Added required files missing from the previous ZIP using the template: ${filledFromTemplate.join(', ')}`);
        }
        return { actorDir: paths.actorDir, skipped: false, vars, files, filledFromTemplate, revision: true };
    }

    const files = [];
    for (const file of walkFiles(TEMPLATE_DIR, new Set())) {
        const source = fs.readFileSync(file.abs, 'utf8');
        const rendered = renderTemplate(source, vars, { json: file.rel.endsWith('.json') });
        const target = path.join(paths.actorDir, ...file.rel.split('/'));
        writeText(target, rendered);
        files.push(file.rel);
    }

    log.ok(`Scaffolded ${files.length} files into ${paths.actorDir}`);
    for (const f of files) log.info(`  ${f}`);
    return { actorDir: paths.actorDir, skipped: false, vars, files, revision: false };
}

if (isMain(import.meta.url)) {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        console.log(USAGE);
        process.exit(0);
    }
    try {
        const runId = resolveRunId(positional, USAGE);
        log.step(`Scaffold Actor for run ${runId}`);
        const result = scaffold(runId, { force: Boolean(flags.force) });
        log.info(`${result.revision ? 'Revision of' : 'New Actor'} ${result.vars.ACTOR_TITLE}`);
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    }
}
