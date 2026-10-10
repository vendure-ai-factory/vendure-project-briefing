#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ARCHIVE_ROOT = process.env.VENDOR_UPLOADS_ARCHIVE_ROOT || '';
const DEFAULT_ARTIFACT_ROOT = process.env.VENDOR_UPLOADS_ARTIFACT_ROOT
  ? path.resolve(process.env.VENDOR_UPLOADS_ARTIFACT_ROOT)
  : path.join(REPO_ROOT, 'work/tmp/vendor-upload-sync');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const METADATA_EXTENSIONS = new Set(['.json', '.txt', '.md']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = resolveRequiredPath(args.sourceRoot || process.env.VENDOR_UPLOADS_SOURCE_ROOT, '--source-root');
  const sku = sanitizeSku(args.sku || process.env.VENDOR_UPLOADS_SKU || '');
  if (!sku) {
    throw new Error('Missing required --sku (or VENDOR_UPLOADS_SKU).');
  }

  const timestamp = sanitizeTimestamp(args.timestamp || new Date().toISOString());
  const archiveRoot = resolveRequiredPath(args.archiveRoot || DEFAULT_ARCHIVE_ROOT, '--archive-root');
  const destinationRoot = path.join(archiveRoot, sku, timestamp);
  const artifactRoot = path.join(DEFAULT_ARTIFACT_ROOT, timestamp);
  await mkdir(artifactRoot, { recursive: true });

  const fileEntries = await collectFiles(sourceRoot);
  const relevantEntries = fileEntries.filter((entry) => isSupportedFile(entry.absolutePath));
  const plan = relevantEntries.map((entry) => {
    const relativePath = path.relative(sourceRoot, entry.absolutePath);
    return {
      sourcePath: entry.absolutePath,
      relativePath,
      destinationPath: path.join(destinationRoot, relativePath),
      size: entry.size,
      sha256: entry.sha256,
    };
  });

  const payload = {
    mode: args.apply ? 'apply' : 'dry-run',
    sku,
    timestamp,
    sourceRoot,
    archiveRoot,
    destinationRoot,
    totalScanned: fileEntries.length,
    totalSelected: plan.length,
    plan,
  };

  if (!args.apply) {
    const summary = renderSummary(payload);
    await writeFile(path.join(artifactRoot, 'summary.txt'), summary, 'utf8');
    await writeFile(path.join(artifactRoot, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(summary);
    console.log(`Artifacts written to ${artifactRoot}`);
    return;
  }

  await mkdir(destinationRoot, { recursive: true });
  for (const item of plan) {
    await mkdir(path.dirname(item.destinationPath), { recursive: true });
    await cp(item.sourcePath, item.destinationPath, { force: true });
  }

  const summary = renderSummary(payload);
  const manifest = {
    ...payload,
    completedAt: new Date().toISOString(),
  };
  await writeFile(path.join(destinationRoot, 'sync-result.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(artifactRoot, 'summary.txt'), summary, 'utf8');
  await writeFile(path.join(artifactRoot, 'result.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(summary);
  console.log(`Archived to ${destinationRoot}`);
  console.log(`Artifacts written to ${artifactRoot}`);
}

async function collectFiles(rootDir) {
  const entries = [];
  async function walk(currentDir) {
    const children = await readdir(currentDir, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.join(currentDir, child.name);
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!child.isFile()) {
        continue;
      }
      const fileStat = await stat(absolutePath);
      entries.push({
        absolutePath,
        size: fileStat.size,
        sha256: await hashFile(absolutePath),
      });
    }
  }

  await walk(rootDir);
  return entries;
}

async function hashFile(filePath) {
  const buffer = await readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || METADATA_EXTENSIONS.has(ext);
}

function renderSummary(payload) {
  const lines = [
    `mode: ${payload.mode}`,
    `sku: ${payload.sku}`,
    `timestamp: ${payload.timestamp}`,
    `sourceRoot: ${payload.sourceRoot}`,
    `archiveRoot: ${payload.archiveRoot}`,
    `destinationRoot: ${payload.destinationRoot}`,
    `scanned: ${payload.totalScanned}`,
    `selected: ${payload.totalSelected}`,
  ];

  for (const item of payload.plan.slice(0, 10)) {
    lines.push(`- ${item.relativePath} -> ${path.relative(payload.archiveRoot, item.destinationPath)}`);
  }
  if (payload.plan.length > 10) {
    lines.push(`- ... ${payload.plan.length - 10} more files`);
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    sourceRoot: '',
    archiveRoot: '',
    sku: '',
    timestamp: '',
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
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key === 'source-root') {
      parsed.sourceRoot = value;
    } else if (key === 'archive-root') {
      parsed.archiveRoot = value;
    } else if (key === 'sku') {
      parsed.sku = value;
    } else if (key === 'timestamp') {
      parsed.timestamp = value;
    }
  }

  return parsed;
}

function resolveRequiredPath(candidate, flagName) {
  if (!candidate) {
    throw new Error(`Missing required ${flagName}.`);
  }
  return path.resolve(candidate);
}

function sanitizeSku(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeTimestamp(value) {
  return String(value || '')
    .trim()
    .replace(/[:.]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

main().catch((error) => {
  console.error(`❌ sync-vendor-uploads failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
