#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ARCHIVE_ROOT = process.env.VENDOR_UPLOADS_ARCHIVE_ROOT || '';
const DEFAULT_DELISTED_ROOT = process.env.VENDOR_UPLOADS_DELISTED_ROOT || '';
const DEFAULT_ARTIFACT_ROOT = process.env.ADMIN_DELIST_ARTIFACT_ROOT
  ? path.resolve(process.env.ADMIN_DELIST_ARTIFACT_ROOT)
  : path.join(REPO_ROOT, 'work/tmp/admin-delist-products');
const POSTGRES_SERVICE = 'postgres';
const POSTGRES_USER = 'vendure';
const POSTGRES_DB = 'vendure';
const AUTH_HEADER = process.env.VENDURE_AUTH_TOKEN_HEADER || 'vendure-auth-token';
const ADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';

const REINDEX_MUTATION = /* GraphQL */ `
  mutation Reindex {
    reindex {
      id
      state
      isSettled
    }
  }
`;

const LOGIN_MUTATION = /* GraphQL */ `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      __typename
      ... on CurrentUser {
        id
        identifier
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const skuList = parseSkuList(args.sku || process.env.ADMIN_DELIST_SKU || '');
  if (skuList.length === 0) {
    throw new Error('Missing required --sku (or ADMIN_DELIST_SKU).');
  }

  const timestamp = sanitizeTimestamp(args.timestamp || new Date().toISOString());
  const archiveRoot = resolveRequiredPath(args.archiveRoot || DEFAULT_ARCHIVE_ROOT, '--archive-root');
  const delistedRoot = path.resolve(args.delistedRoot || DEFAULT_DELISTED_ROOT || path.join(archiveRoot, '_delisted'));
  const artifactRoot = path.join(DEFAULT_ARTIFACT_ROOT, timestamp);
  await mkdir(artifactRoot, { recursive: true });

  const container = resolvePostgresContainer();
  const records = queryProductsBySku(container, skuList);
  const productIds = Array.from(new Set(records.map((row) => Number(row.productId)).filter((id) => Number.isFinite(id))));

  const archiveMoves = [];
  for (const sku of skuList) {
    const activePath = path.join(archiveRoot, sku);
    if (await pathExists(activePath)) {
      archiveMoves.push({
        sku,
        sourcePath: activePath,
        destinationPath: path.join(delistedRoot, timestamp, sku),
      });
    }
  }

  const payload = {
    mode: args.apply ? 'apply' : 'dry-run',
    skuList,
    timestamp,
    archiveRoot,
    delistedRoot,
    productIds,
    records,
    archiveMoves,
  };

  if (!args.apply) {
    const summary = renderSummary(payload);
    await writeFile(path.join(artifactRoot, 'summary.txt'), summary, 'utf8');
    await writeFile(path.join(artifactRoot, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(summary);
    console.log(`Artifacts written to ${artifactRoot}`);
    return;
  }

  if (records.length === 0) {
    throw new Error(`No product variants found for SKU(s): ${skuList.join(', ')}`);
  }

  executeDisableSql(container, skuList, productIds);

  for (const move of archiveMoves) {
    await mkdir(path.dirname(move.destinationPath), { recursive: true });
    await movePath(move.sourcePath, move.destinationPath);
  }

  if (args.reindex !== false) {
    const authToken = await login();
    await graphql(REINDEX_MUTATION, {}, authToken, resolveAdminApiUrl());
  }

  const summary = renderSummary(payload);
  const result = {
    ...payload,
    mode: 'apply',
    completedAt: new Date().toISOString(),
  };
  await writeFile(path.join(artifactRoot, 'summary.txt'), summary, 'utf8');
  await writeFile(path.join(artifactRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(summary);
  console.log(`Artifacts written to ${artifactRoot}`);
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    reindex: true,
    sku: '',
    timestamp: '',
    archiveRoot: '',
    delistedRoot: '',
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.apply = false;
      continue;
    }
    if (arg === '--no-reindex') {
      parsed.reindex = false;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key === 'sku') {
      parsed.sku = value;
    } else if (key === 'timestamp') {
      parsed.timestamp = value;
    } else if (key === 'archive-root') {
      parsed.archiveRoot = value;
    } else if (key === 'delisted-root') {
      parsed.delistedRoot = value;
    }
  }

  return parsed;
}

function parseSkuList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeTimestamp(value) {
  return String(value || '')
    .trim()
    .replace(/[:.]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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

function queryProductsBySku(container, skuList) {
  const sqlList = skuList.map((sku) => `'${escapeSqlLiteral(sku)}'`).join(', ');
  const sql = `
    select coalesce(json_agg(row_to_json(t))::text, '[]')
    from (
      select pv.id as "variantId", pv.sku, pv.enabled as "variantEnabled", pv."productId" as "productId", p.slug, p.enabled as "productEnabled"
      from product_variant pv
      join product p on p.id = pv."productId"
      where pv.sku in (${sqlList})
      order by pv.sku
    ) t
  `;
  const raw = execFileSync('docker', ['exec', '-i', container, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-Atc', sql], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return raw ? JSON.parse(raw) : [];
}

function executeDisableSql(container, skuList, productIds) {
  const sqlList = skuList.map((sku) => `'${escapeSqlLiteral(sku)}'`).join(', ');
  const productIdList = productIds.length > 0 ? productIds.join(', ') : 'null';
  const sql = [
    'begin;',
    `update product_variant set enabled = false where sku in (${sqlList});`,
    productIds.length > 0 ? `update product set enabled = false where id in (${productIdList});` : '-- no matching product ids',
    'commit;',
  ].join('\n');

  execFileSync('docker', ['exec', '-i', container, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB], {
    cwd: REPO_ROOT,
    input: `${sql}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

async function movePath(sourcePath, destinationPath) {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EXDEV') {
      await cp(sourcePath, destinationPath, { recursive: true, force: true });
      await rm(sourcePath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function renderSummary(payload) {
  const lines = [
    `mode: ${payload.mode}`,
    `sku: ${payload.skuList.join(', ')}`,
    `timestamp: ${payload.timestamp}`,
    `productIds: ${payload.productIds.length > 0 ? payload.productIds.join(', ') : '<none>'}`,
    `records: ${payload.records.length}`,
    `archiveMoves: ${payload.archiveMoves.length}`,
  ];

  for (const record of payload.records.slice(0, 10)) {
    lines.push(
      `- ${record.sku}: productId=${record.productId}, productEnabled=${Boolean(record.productEnabled)}, variantEnabled=${Boolean(record.variantEnabled)}`,
    );
  }

  if (payload.archiveMoves.length > 0) {
    lines.push('archive moves:');
    for (const move of payload.archiveMoves.slice(0, 10)) {
      lines.push(`- ${move.sourcePath} -> ${move.destinationPath}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function graphql(query, variables, token, url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(', '));
  }

  return {
    ...payload.data,
    __token: response.headers.get(AUTH_HEADER),
  };
}

async function login() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    throw new Error('SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD are required.');
  }
  const result = await graphql(
    LOGIN_MUTATION,
    {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    },
    undefined,
    resolveAdminApiUrl(),
  );

  const loginResult = result.login;
  if (!loginResult || loginResult.__typename !== 'CurrentUser') {
    const message = loginResult?.__typename === 'ErrorResult'
      ? `${loginResult.errorCode}: ${loginResult.message}`
      : 'Unexpected login response';
    throw new Error(`Admin login failed: ${message}`);
  }

  if (!result.__token) {
    throw new Error(`Admin login did not return the ${AUTH_HEADER} auth token header.`);
  }

  return result.__token;
}

function resolveAdminApiUrl() {
  if (process.env.VENDURE_ADMIN_API_URL) {
    return process.env.VENDURE_ADMIN_API_URL;
  }

  const shopApiUrl = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL;
  if (shopApiUrl) {
    return shopApiUrl.replace(/\/shop-api\/?$/, '/admin-api');
  }

  const vendureHost = process.env.VENDURE_HOST;
  if (vendureHost) {
    return `${vendureHost.replace(/\/$/, '')}/admin-api`;
  }

  throw new Error('VENDURE_ADMIN_API_URL must be set explicitly.');
}

function resolveRequiredPath(candidate, flagName) {
  if (!candidate) {
    throw new Error(`Missing required ${flagName} (or its environment variable).`);
  }
  return path.resolve(candidate);
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

main().catch((error) => {
  console.error(`❌ admin-delist-products failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
