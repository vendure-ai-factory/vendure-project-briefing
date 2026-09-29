#!/usr/bin/env node
// Public-safe version: use only against an explicitly authorized staging environment.
// Database connection values are supplied through environment variables; no credentials or private paths are embedded.

import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'work/tmp/tax-rate-setup');
const POSTGRES_SERVICE = process.env.POSTGRES_SERVICE || 'postgres';
const POSTGRES_USER = process.env.POSTGRES_USER || 'vendure';
const POSTGRES_DB = process.env.POSTGRES_DB || 'vendure';
const CATEGORY_NAME = process.env.TAX_CATEGORY_NAME || 'Standard Tax';

const COUNTRY_TARGETS = [
    {country: 'DE', zoneName: 'DE Zone', rate: 19},
    {country: 'AT', zoneName: 'AT Zone', rate: 20},
    {country: 'HU', zoneName: 'HU Zone', rate: 27},
    {country: 'GB', zoneName: 'GB Zone', rate: 20},
];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const selectedTargets = filterTargets(args.country);

    if (selectedTargets.length === 0) {
        throw new Error('No countries selected. Use --country=DE,AT,HU,GB or omit --country.');
    }

    const container = resolvePostgresContainer();
    const state = loadCurrentState(container);
    const category = state.categories.find((item) => item.name === CATEGORY_NAME);

    if (!category) {
        throw new Error(`Missing tax category ${CATEGORY_NAME}.`);
    }

    const plan = buildPlan(selectedTargets, state, category);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(OUTPUT_ROOT, timestamp);
    await mkdir(runDir, {recursive: true});

    if (!args.apply) {
        const summary = renderSummary({
            mode: 'dry-run',
            category,
            plan,
            current: state,
        });
        await writeFile(path.join(runDir, 'summary.txt'), summary, 'utf8');
        await writeFile(path.join(runDir, 'result.json'), `${JSON.stringify({mode: 'dry-run', category, plan, current: state}, null, 2)}\n`, 'utf8');
        console.log(summary);
        console.log(`Artifacts written to ${runDir}`);
        return;
    }

    applyPlan(container, plan, category);
    const verifiedState = loadCurrentState(container);
    const verifiedPlan = buildPlan(selectedTargets, verifiedState, category);
    const summary = renderSummary({
        mode: 'apply',
        category,
        plan: verifiedPlan,
        current: verifiedState,
    });

    await writeFile(path.join(runDir, 'summary.txt'), summary, 'utf8');
    await writeFile(path.join(runDir, 'result.json'), `${JSON.stringify({mode: 'apply', category, plan: verifiedPlan, current: verifiedState}, null, 2)}\n`, 'utf8');
    console.log(summary);
    console.log(`Artifacts written to ${runDir}`);
}

function parseArgs(argv) {
    const parsed = {apply: false, country: ''};
    for (const arg of argv) {
        if (arg === '--apply') {
            parsed.apply = true;
            continue;
        }
        if (arg === '--dry-run') {
            parsed.apply = false;
            continue;
        }
        const match = arg.match(/^--([^=]+)=(.*)$/);
        if (!match) {
            continue;
        }
        const [, key, value] = match;
        if (key === 'country') {
            parsed.country = value;
        }
    }
    return parsed;
}

function filterTargets(countryFilter) {
    const filterSet = new Set(
        String(countryFilter || '')
            .split(',')
            .map((item) => item.trim().toUpperCase())
            .filter(Boolean),
    );
    return COUNTRY_TARGETS.filter((target) => filterSet.size === 0 || filterSet.has(target.country));
}

function resolvePostgresContainer() {
    const container = execFileSync('docker', ['compose', 'ps', '-q', POSTGRES_SERVICE], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    }).trim();

    if (!container) {
        throw new Error(`Unable to resolve docker compose service ${POSTGRES_SERVICE}.`);
    }

    return container;
}

function loadCurrentState(container) {
    const zones = queryJson(container, `
        select id, name
        from zone
        order by id
    `);
    const categories = queryJson(container, `
        select id, name, "isDefault" as "isDefault"
        from tax_category
        order by id
    `);
    const rates = queryJson(container, `
        select id, name, value, "categoryId" as "categoryId", "zoneId" as "zoneId", enabled
        from tax_rate
        order by id
    `);

    return {zones, categories, rates};
}

function buildPlan(targets, state, category) {
    return targets.map((target) => {
        const zone = state.zones.find((item) => item.name === target.zoneName);
        if (!zone) {
            throw new Error(`Missing zone ${target.zoneName} for ${target.country}.`);
        }

        const current = state.rates.find((rate) => Number(rate.zoneId) === Number(zone.id) && Number(rate.categoryId) === Number(category.id));
        return {
            country: target.country,
            zoneName: target.zoneName,
            zoneId: Number(zone.id),
            categoryId: Number(category.id),
            desiredRate: target.rate,
            currentRate: current ? Number(current.value) : null,
            currentRateName: current?.name || null,
            status: current ? (Number(current.value) === Number(target.rate) ? 'match' : 'replace') : 'create',
        };
    });
}

function applyPlan(container, plan, category) {
    const sql = [
        'begin;',
        ...plan.map((item) => {
            const rateName = escapeSqlLiteral(`${item.country} Standard VAT`);
            return `
                delete from tax_rate
                where "categoryId" = ${Number(category.id)}
                  and "zoneId" = ${Number(item.zoneId)};
                insert into tax_rate ("createdAt", "updatedAt", "name", "enabled", value, "categoryId", "zoneId")
                values (now(), now(), '${rateName}', true, ${Number(item.desiredRate)}, ${Number(category.id)}, ${Number(item.zoneId)});
            `;
        }),
        'commit;',
    ].join('\n');

    execFileSync('docker', ['exec', '-i', container, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB], {
        cwd: REPO_ROOT,
        input: `${sql}\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
    });
}

function queryJson(container, sql) {
    const wrappedSql = `
        select coalesce(json_agg(row_to_json(t))::text, '[]')
        from (
            ${sql.trim().replace(/;$/, '')}
        ) t
    `;
    const raw = execFileSync('docker', ['exec', '-i', container, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-Atc', wrappedSql], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    }).trim();
    return raw ? JSON.parse(raw) : [];
}

function renderSummary({mode, category, plan, current}) {
    const lines = [
        `mode: ${mode}`,
        `tax category: ${category.name} (id=${category.id}, isDefault=${Boolean(category.isDefault)})`,
        `zone count: ${current.zones.length}`,
        `tax rate count: ${current.rates.length}`,
        'targets:',
    ];

    for (const item of plan) {
        lines.push(
            `- ${item.country} / ${item.zoneName}: current=${item.currentRate === null ? '<missing>' : `${item.currentRate}% (${item.currentRateName || 'unnamed'})`} -> desired=${item.desiredRate}% [${item.status}]`,
        );
    }

    return `${lines.join('\n')}\n`;
}

function escapeSqlLiteral(value) {
    return String(value).replace(/'/g, "''");
}

main().catch((error) => {
    console.error(`❌ setup:tax-rates failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
