// Automatic billing-tier decision for a delivery. Everything here is derived from measurable facts about the
// delivered code and the request, so no human judgement is needed. The customer Actor charges the event that
// matches the tier recorded in GENERATED_ACTOR_META.

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { walkFiles } from './lib.js';

export const TIER_EVENTS = {
    standard: 'actor-generated-standard',
    advanced: 'actor-generated-advanced',
    revision: 'actor-revision',
    free: null,
};
export const TIERS = Object.keys(TIER_EVENTS);

/** Problem reports within this many days of the previous delivery are fixed for free. */
export const WARRANTY_DAYS = 7;
/** A revision that changes at least this share of functional lines is billed like a new Actor. */
export const MAJOR_CHANGE_RATIO = 0.4;
/** A revision that adds at least this many source files is billed like a new Actor. */
export const MAJOR_ADDED_SOURCE_FILES = 2;
/** Complexity score from which a new Actor is "advanced". */
export const ADVANCED_SCORE = 2;

const BROWSER_DEPS = ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core', 'puppeteer-extra', '@crawlee/playwright', '@crawlee/puppeteer', 'selenium-webdriver'];
const BROWSER_CODE = /\b(PlaywrightCrawler|PuppeteerCrawler|launchPlaywright|launchPuppeteer|chromium\.launch|firefox\.launch|webkit\.launch|puppeteer\.launch)\b/;
const INTEGRATION_DEPS = ['openai', '@anthropic-ai/sdk', 'googleapis', '@googleapis', '@aws-sdk', 'aws-sdk', '@google-cloud', 'stripe', 'twilio', 'nodemailer', '@slack/web-api', '@notionhq/client', 'airtable', 'pg', 'mysql2', 'mongodb', '@supabase/supabase-js'];
const SECRET_NAME = /(password|passwd|cookie|session|login|credential|api[_-]?key|secret|token|auth)/i;
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.py']);
const TEXT_EXT = new Set([...SOURCE_EXT, '.json', '.txt', '.yml', '.yaml', '.toml', '.sh']);
const NON_FUNCTIONAL = new Set(['README.md', 'CHANGELOG.md', 'package-lock.json', '.actor/actor.json', '.actorignore', '.gitignore']);
// Schemas that only describe the results (field types, table views, output links). Changing them is billable work,
// but their size says nothing about the code change, so they never count towards the changed-lines ratio: a long
// dataset schema must not turn a small update into a "major update".
const RESULT_SCHEMAS = new Set(['.actor/dataset_schema.json', '.actor/output_schema.json']);

function readJsonSafe(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function isSourceFile(rel) {
    return rel.startsWith('src/') && SOURCE_EXT.has(path.extname(rel));
}

/** Files whose content affects behaviour (code, schema, dependencies, Dockerfile), excluding docs and metadata. */
function isFunctionalFile(rel) {
    if (NON_FUNCTIONAL.has(rel)) return false;
    if (rel.startsWith('storage/') || rel.includes('node_modules/') || rel.endsWith('.zip')) return false;
    const base = path.basename(rel);
    return base === 'Dockerfile' || TEXT_EXT.has(path.extname(rel));
}

/** Canonical text for comparison: comments, blank lines and version bumps do not count as changes. */
function normalize(rel, text) {
    if (rel === 'package.json') {
        const pkg = readJsonText(text);
        if (pkg) {
            delete pkg.version;
            return JSON.stringify(pkg, null, 2);
        }
    }
    if (path.extname(rel) === '.json') {
        const parsed = readJsonText(text);
        if (parsed) return JSON.stringify(parsed, null, 2);
    }
    if (SOURCE_EXT.has(path.extname(rel))) {
        return text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('#') && !/^\*|^\/\*/.test(line))
            .join('\n');
    }
    return text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0).join('\n');
}

function readJsonText(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function countLines(text) {
    return text.length === 0 ? 0 : text.split('\n').length;
}

/** Lines that differ between two texts (multiset difference), as an estimate of changed lines. */
function changedLinesBetween(before, after) {
    const counts = new Map();
    for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of after.split('\n')) {
        const n = counts.get(line) ?? 0;
        if (n > 0) counts.set(line, n - 1);
        else added += 1;
    }
    let removed = 0;
    for (const n of counts.values()) removed += n;
    return Math.max(added, removed);
}

/** Read a previous Actor ZIP into { rel -> text } for functional files, stripping a single wrapper folder. */
function readZipFunctionalFiles(zipPath) {
    const entries = new AdmZip(zipPath).getEntries().filter((e) => !e.isDirectory);
    let names = entries.map((e) => e.entryName.replace(/\\/g, '/'));
    let strip = '';
    if (!names.includes('.actor/actor.json')) {
        const roots = new Set(names.map((n) => n.split('/')[0]));
        if (roots.size === 1) strip = `${[...roots][0]}/`;
    }
    const files = new Map();
    entries.forEach((entry, i) => {
        const rel = strip && names[i].startsWith(strip) ? names[i].slice(strip.length) : names[i];
        if (isFunctionalFile(rel)) files.set(rel, normalize(rel, entry.getData().toString('utf8')));
    });
    return files;
}

/** Complexity of the delivered Actor, from objective signals in its code, dependencies and input schema. */
export function assessComplexity(actorDir) {
    const signals = [];
    let score = 0;

    const pkg = readJsonSafe(path.join(actorDir, 'package.json')) ?? {};
    const dependencies = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) });
    const sources = walkFiles(actorDir).filter((f) => isSourceFile(f.rel));
    const sourceText = sources.map((f) => fs.readFileSync(f.abs, 'utf8')).join('\n');
    const sourceLines = sources.reduce((sum, f) => sum + countLines(normalize(f.rel, fs.readFileSync(f.abs, 'utf8'))), 0);

    const browserDep = dependencies.find((d) => BROWSER_DEPS.some((b) => d === b || d.startsWith(`${b}/`)));
    if (browserDep || BROWSER_CODE.test(sourceText)) {
        score += 2;
        signals.push(`browser automation (${browserDep ?? 'browser crawler in source'})`);
    }

    const schema = readJsonSafe(path.join(actorDir, '.actor', 'input_schema.json')) ?? {};
    const props = Object.entries(schema.properties ?? {});
    const authProps = props.filter(([key, prop]) => prop?.isSecret === true || SECRET_NAME.test(key) || SECRET_NAME.test(String(prop?.title ?? '')));
    if (authProps.length > 0) {
        score += 1;
        signals.push(`authentication or secret inputs (${authProps.map(([key]) => key).join(', ')})`);
    }

    if (sourceLines >= 500) {
        score += 1;
        signals.push(`${sourceLines} functional source lines in ${sources.length} file(s)`);
    }

    if (props.length >= 8) {
        score += 1;
        signals.push(`${props.length} input fields`);
    }

    const integrations = dependencies.filter((d) => INTEGRATION_DEPS.some((i) => d === i || d.startsWith(`${i}/`)));
    if (integrations.length > 0) {
        score += 1;
        signals.push(`third-party service integrations (${integrations.join(', ')})`);
    }

    return {
        score,
        level: score >= ADVANCED_SCORE ? 'advanced' : 'standard',
        signals,
        sourceLines,
        sourceFiles: sources.length,
        inputFields: props.length,
        dependencies,
    };
}

/** Size of the functional change between the previous ZIP and the new Actor directory. */
export function measureChange(previousZipPath, actorDir) {
    const previous = readZipFunctionalFiles(previousZipPath);
    const next = new Map();
    for (const f of walkFiles(actorDir)) {
        if (isFunctionalFile(f.rel)) next.set(f.rel, normalize(f.rel, fs.readFileSync(f.abs, 'utf8')));
    }

    const addedFiles = [];
    const removedFiles = [];
    const modifiedFiles = [];
    const schemaFilesChanged = [];
    let changedLines = 0;
    let totalLines = 0;

    for (const [rel, text] of next) {
        const changed = !previous.has(rel) || previous.get(rel) !== text;
        if (!previous.has(rel)) addedFiles.push(rel);
        else if (changed) modifiedFiles.push(rel);

        if (RESULT_SCHEMAS.has(rel)) {
            if (changed) schemaFilesChanged.push(rel);
            continue;
        }
        totalLines += countLines(text);
        if (!previous.has(rel)) changedLines += countLines(text);
        else if (changed) changedLines += changedLinesBetween(previous.get(rel), text);
    }
    for (const [rel, text] of previous) {
        if (!next.has(rel)) {
            removedFiles.push(rel);
            if (RESULT_SCHEMAS.has(rel)) schemaFilesChanged.push(rel);
            else changedLines += countLines(text);
        }
    }

    const changedRatio = totalLines > 0 ? Math.min(1, changedLines / totalLines) : (changedLines > 0 ? 1 : 0);
    const addedSourceFiles = addedFiles.filter(isSourceFile).length;
    return {
        // A result-schema change alone is still a billable change (a revision), just never a major one.
        functionalChange: changedLines > 0 || schemaFilesChanged.length > 0,
        changedLines,
        totalLines,
        changedRatio: Number(changedRatio.toFixed(3)),
        addedFiles,
        removedFiles,
        modifiedFiles,
        schemaFilesChanged,
        major: changedRatio >= MAJOR_CHANGE_RATIO || addedSourceFiles >= MAJOR_ADDED_SOURCE_FILES,
    };
}

/**
 * Date the warranty of the next delivery counts from. A billable delivery (any tier with an event) opens a new
 * warranty window; a free delivery (warranty fix, no functional change, --tier free) keeps the previous anchor, so
 * a chain of free fixes cannot extend the warranty forever.
 * @param {{ event: string|null }} decision  The tier decision for the delivery being uploaded.
 * @param {string|null} previousAnchorAt     Anchor of the delivery being revised, when known.
 * @param {Date} [now]
 */
export function nextWarrantyAnchor(decision, previousAnchorAt, now = new Date()) {
    return decision.event ? now.toISOString() : (previousAnchorAt ?? null);
}

/**
 * Decide the billing tier for a delivery.
 * @param {object} p
 * @param {boolean} p.isRevision         The request revises an Actor the customer already received.
 * @param {boolean} p.hasProblemReport   The customer attached a failure report.
 * @param {string|null} p.warrantyAnchorAt  ISO date of the last billable delivery of this Actor, when known.
 *                                          Problem reports within WARRANTY_DAYS of it are fixed for free.
 * @param {ReturnType<typeof assessComplexity>} p.complexity
 * @param {ReturnType<typeof measureChange>|null} p.change  Null when no previous ZIP is available.
 * @param {Date} [p.now]
 */
export function decideTier({ isRevision, hasProblemReport, warrantyAnchorAt, complexity, change, now = new Date() }) {
    const complexityNote = `complexity score ${complexity.score}${complexity.signals.length ? ` (${complexity.signals.join('; ')})` : ''}`;
    const byComplexity = (labelPrefix, reasons) => ({
        tier: complexity.level,
        event: TIER_EVENTS[complexity.level],
        label: complexity.level === 'advanced' ? `${labelPrefix} (advanced)` : labelPrefix,
        reasons: [...reasons, complexityNote],
    });

    if (!isRevision) return byComplexity('new Actor', []);

    if (change && !change.functionalChange) {
        return { tier: 'free', event: null, label: 'no functional change', reasons: ['re-delivery without changes to code, schema or dependencies'] };
    }

    const reasons = [];
    if (hasProblemReport) {
        if (warrantyAnchorAt) {
            const days = (now.getTime() - new Date(warrantyAnchorAt).getTime()) / 86_400_000;
            if (days <= WARRANTY_DAYS) {
                return {
                    tier: 'free',
                    event: null,
                    label: 'fix under warranty',
                    reasons: [`problem report ${days.toFixed(1)} day(s) after the last billable delivery (warranty ${WARRANTY_DAYS} days)`],
                };
            }
            reasons.push(`problem report ${Math.floor(days)} days after the last billable delivery, outside the ${WARRANTY_DAYS}-day warranty`);
        } else {
            reasons.push('problem report, but the date of the last billable delivery is unknown, so no warranty applies');
        }
    }

    if (change?.major) {
        return byComplexity('major update', [
            ...reasons,
            `major rework: ${Math.round(change.changedRatio * 100)}% of functional lines changed, ${change.addedFiles.length} file(s) added`,
        ]);
    }

    if (!change) reasons.push('update of an existing Actor (previous code not available for comparison)');
    else if (change.changedLines === 0) reasons.push('update: only result schemas changed');
    else reasons.push(`update: ${Math.round(change.changedRatio * 100)}% of functional lines changed (${change.changedLines} of ${change.totalLines})`);
    if (change?.schemaFilesChanged?.length) {
        reasons.push(`result schemas changed, not counted in the ratio: ${change.schemaFilesChanged.join(', ')}`);
    }
    return { tier: 'revision', event: TIER_EVENTS.revision, label: 'update of an existing Actor', reasons };
}
