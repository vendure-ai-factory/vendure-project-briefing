'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ARCHIVE_ROOT = '/opt/pipeline-archive';
const DEFAULT_MODE = 'preflight';
const DEFAULT_TASK = 'all';
const VALID_MODES = ['preflight', 'full'];
const INVALID_MODE_EXIT = 2;
const MANIFEST_PATH = 'manifest/acceptance-manifest.v0.4.json';
const PIPELINE_SCRIPT = 'bin/pipeline.js';
const REVIEW_SCRIPT = 'skills/pipeline-review/review.js';

const CLASS_DEPENDENCY = 'DEPENDENCY_ENVIRONMENT';
const CLASS_CLIENT_INPUT = 'CLIENT_INPUT_SCOPE';

// Admin API path read from the Vendure config snapshot. Do not guess:
// evaluation-demo/migration-input/legacy/vendure-store/src/vendure-config.ts:40
//   apiOptions: { adminApiPath: 'admin-api', shopApiPath: 'shop-api', ... }
// The supplied legacy scripts resolve the admin GraphQL endpoint against this
// same path, so an unset VENDURE_ADMIN_API_URL is derived as
// <PIPELINE_STAGING_URL>/admin-api.
const ADMIN_API_PATH = '/admin-api';

/**
 * Validate the staging mode against the allowed set. The pipeline may only
 * start when the operator explicitly sets PIPELINE_MODE=full; any other value
 * (including the default preflight) is preflight-only, and an unlisted value
 * fails safely without spawning. The error names the variable, never the value.
 */
function validateMode(mode) {
  if (VALID_MODES.indexOf(mode) !== -1) {
    return { ok: true, mode: mode, error: null };
  }
  return {
    ok: false,
    mode: mode,
    error: 'PIPELINE_MODE must be one of: preflight, full'
  };
}

function generateRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function nodeFs() {
  const fsMod = require('node:fs');
  return {
    mkdirSync: function() { return fsMod.mkdirSync.apply(fsMod, arguments); },
    writeFileSync: function() { return fsMod.writeFileSync.apply(fsMod, arguments); },
    existsSync: function() { return fsMod.existsSync.apply(fsMod, arguments); },
    readFileSync: function() { return fsMod.readFileSync.apply(fsMod, arguments); },
    readdirSync: function() { return fsMod.readdirSync.apply(fsMod, arguments); },
    rmSync: function() { return fsMod.rmSync.apply(fsMod, arguments); },
    statSync: function() { return fsMod.statSync.apply(fsMod, arguments); },
    copyFileSync: function() { return fsMod.copyFileSync.apply(fsMod, arguments); },
    statfsSync: typeof fsMod.statfsSync === 'function'
      ? function() { return fsMod.statfsSync.apply(fsMod, arguments); }
      : null
  };
}

/**
 * Normalise config. Reads env var values (never their secrets): names only
 * are ever logged or written. Dependencies (child_process, fs, fetch) can be
 * injected for testing; nothing here touches the network or the filesystem
 * except through the injected/normalised dependencies.
 */
function resolveConfig(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const childProcess = deps.childProcess || require('node:child_process');
  const fsMod = deps.fs || nodeFs();
  const fetchImpl = deps.fetch || globalThis.fetch;

  return {
    env: env,
    envNames: Object.keys(env),
    childProcess: childProcess,
    fs: fsMod,
    fetch: fetchImpl,
    cwd: deps.cwd || process.cwd(),
    nodeVersion: deps.nodeVersion || process.version,
    archiveRoot: env.PIPELINE_ARCHIVE_ROOT || DEFAULT_ARCHIVE_ROOT,
    mode: env.PIPELINE_MODE || DEFAULT_MODE,
    task: env.PIPELINE_TASK || DEFAULT_TASK,
    stagingUrl: env.PIPELINE_STAGING_URL || null,
    shopApiUrl: env.PIPELINE_SHOP_API_URL || null,
    runId: deps.runId || generateRunId()
  };
}

function checkGitHead(cfg) {
  try {
    const out = cfg.childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: cfg.cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return {
      name: 'git-head',
      ok: true,
      value: (out || '').trim(),
      classification: null,
      detail: 'git HEAD resolved'
    };
  } catch (e) {
    return {
      name: 'git-head',
      ok: false,
      value: null,
      classification: CLASS_DEPENDENCY,
      detail: 'git rev-parse HEAD failed: ' + ((e && e.message) || String(e)).split('\n')[0]
    };
  }
}

function checkNodeVersion(cfg) {
  return {
    name: 'node-version',
    ok: true,
    value: cfg.nodeVersion,
    classification: null,
    detail: 'node ' + cfg.nodeVersion + ' available'
  };
}

function checkFreeDisk(cfg) {
  const statfsSync = cfg.fs.statfsSync;
  if (typeof statfsSync !== 'function') {
    return {
      name: 'free-disk',
      ok: false,
      value: null,
      classification: CLASS_DEPENDENCY,
      detail: 'statfs unavailable on this runtime'
    };
  }
  try {
    const s = statfsSync(cfg.archiveRoot);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    return {
      name: 'free-disk',
      ok: true,
      value: { freeBytes: freeBytes },
      classification: null,
      detail: 'free disk ' + freeBytes + ' bytes'
    };
  } catch (e) {
    return {
      name: 'free-disk',
      ok: false,
      value: null,
      classification: CLASS_DEPENDENCY,
      detail: 'cannot stat archive root: ' + ((e && e.message) || String(e)).split('\n')[0]
    };
  }
}

function checkArchiveWritable(cfg) {
  if (!cfg.fs.existsSync(cfg.archiveRoot)) {
    return {
      name: 'archive-writable',
      ok: false,
      value: null,
      classification: CLASS_DEPENDENCY,
      detail: 'archive root missing'
    };
  }
  const probe = path.join(cfg.archiveRoot, '.write-probe-' + cfg.runId);
  try {
    cfg.fs.writeFileSync(probe, 'probe\n', 'utf8');
    cfg.fs.rmSync(probe, { force: true });
    return {
      name: 'archive-writable',
      ok: true,
      value: null,
      classification: null,
      detail: 'archive root writable'
    };
  } catch (e) {
    return {
      name: 'archive-writable',
      ok: false,
      value: null,
      classification: CLASS_CLIENT_INPUT,
      detail: 'archive root not writable: ' + ((e && e.message) || String(e)).split('\n')[0]
    };
  }
}

async function checkHealth(cfg) {
  if (!cfg.stagingUrl) {
    return {
      name: 'health',
      ok: false,
      value: null,
      classification: CLASS_CLIENT_INPUT,
      detail: 'staging URL missing from environment'
    };
  }
  try {
    const resp = await cfg.fetch(cfg.stagingUrl + '/health');
    const status = resp && resp.status;
    let body = null;
    try { body = await resp.json(); } catch (e) {}
    const ok = status === 200 && body && body.status === 'ok';
    return {
      name: 'health',
      ok: ok,
      value: status === 200 ? { status: body && body.status } : null,
      classification: ok ? null : CLASS_DEPENDENCY,
      detail: 'GET /health status=' + status + (body ? ' body=' + JSON.stringify(body) : '')
    };
  } catch (e) {
    return {
      name: 'health',
      ok: false,
      value: null,
      classification: CLASS_DEPENDENCY,
      detail: 'GET /health failed'
    };
  }
}

async function checkShopApi(cfg) {
  const url = cfg.shopApiUrl || (cfg.stagingUrl ? cfg.stagingUrl + '/shop-api' : null);
  if (!url) {
    return {
      name: 'shop-api',
      ok: false,
      value: null,
      classification: CLASS_CLIENT_INPUT,
      detail: 'shop api URL missing from environment'
    };
  }
  try {
    const resp = await cfg.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    const status = resp && resp.status;
    let body = null;
    try { body = await resp.json(); } catch (e) {}
    const typename = body && body.data && body.data.__typename;
    const ok = typename != null;
    return {
      name: 'shop-api',
      ok: ok,
      value: typename != null ? { typename: typename } : null,
      classification: ok ? null : CLASS_DEPENDENCY,
      detail: 'shop-api status=' + status + ' typename=' + (typename || 'absent')
    };
  } catch (e) {
    return {
      name: 'shop-api',
      ok: false,
      value: null,
      classification: CLASS_DEPENDENCY,
      detail: 'shop api request failed'
    };
  }
}

function envNamesOnly(cfg) {
  // Names of the environment variables this stage reads, never their values.
  return ['PIPELINE_ARCHIVE_ROOT', 'PIPELINE_MODE', 'PIPELINE_TASK',
    'PIPELINE_STAGING_URL', 'PIPELINE_SHOP_API_URL',
    'SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD', 'VENDURE_ADMIN_API_URL',
    'STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD'];
}

/**
 * Resolve the admin identity the child pipeline will use, without ever
 * materialising values. Returns only booleans (present or not) and the name
 * of the variable supplying each mapped target. An explicit SUPERADMIN_*
 * value always wins; otherwise the workflow fallback name is used;
 * VENDURE_ADMIN_API_URL falls back to staging URL + ADMIN_API_PATH.
 */
function adminEnvMapping(cfg) {
  const env = cfg.env || {};
  const present = function(v) { return v != null && String(v) !== ''; };
  const hasUser = present(env.SUPERADMIN_USERNAME);
  const hasEmail = present(env.STAGING_ADMIN_EMAIL);
  const hasPass = present(env.SUPERADMIN_PASSWORD);
  const hasStagingPass = present(env.STAGING_ADMIN_PASSWORD);
  const hasUrl = present(env.VENDURE_ADMIN_API_URL);
  return {
    username: {
      present: hasUser,
      providedBy: hasUser ? 'SUPERADMIN_USERNAME' : (hasEmail ? 'STAGING_ADMIN_EMAIL' : null)
    },
    password: {
      present: hasPass,
      providedBy: hasPass ? 'SUPERADMIN_PASSWORD' : (hasStagingPass ? 'STAGING_ADMIN_PASSWORD' : null)
    },
    adminApiUrl: {
      present: hasUrl,
      providedBy: hasUrl ? 'VENDURE_ADMIN_API_URL' : (cfg.stagingUrl ? 'derived-from-staging-url' : null)
    }
  };
}

function checkAdminEnvMapping(cfg) {
  const mapping = adminEnvMapping(cfg);
  const missing = [];
  if (mapping.username.providedBy === null) {
    missing.push('SUPERADMIN_USERNAME or STAGING_ADMIN_EMAIL');
  }
  if (mapping.password.providedBy === null) {
    missing.push('SUPERADMIN_PASSWORD or STAGING_ADMIN_PASSWORD');
  }
  if (mapping.adminApiUrl.providedBy === null) {
    missing.push('VENDURE_ADMIN_API_URL or PIPELINE_STAGING_URL');
  }
  const ok = missing.length === 0;
  return {
    name: 'admin-env-mapping',
    ok: ok,
    value: {
      usernamePresent: mapping.username.present,
      usernameProvidedBy: mapping.username.providedBy,
      passwordPresent: mapping.password.present,
      passwordProvidedBy: mapping.password.providedBy,
      adminApiUrlPresent: mapping.adminApiUrl.present,
      adminApiUrlProvidedBy: mapping.adminApiUrl.providedBy
    },
    classification: ok ? null : CLASS_CLIENT_INPUT,
    detail: ok
      ? 'admin env mapping resolvable'
      : 'admin env mapping incomplete; supply: ' + missing.join(', ')
  };
}

/**
 * Build the CHILD environment for the pipeline. Mapped values live only on
 * the child env object; the parent env is never mutated and the values are
 * never logged, printed or written to disk.
 */
function buildChildEnv(cfg) {
  const childEnv = Object.assign({}, cfg.env);
  childEnv.PIPELINE_RUN_ID = cfg.runId;
  const env = cfg.env || {};
  assignChildValue(childEnv, env, 'SUPERADMIN_USERNAME', 'STAGING_ADMIN_EMAIL', null);
  assignChildValue(childEnv, env, 'SUPERADMIN_PASSWORD', 'STAGING_ADMIN_PASSWORD', null);
  assignChildValue(childEnv, env, 'VENDURE_ADMIN_API_URL', null,
    cfg.stagingUrl ? cfg.stagingUrl + ADMIN_API_PATH : null);
  return childEnv;
}

function assignChildValue(childEnv, env, target, fallbackName, derived) {
  const explicit = env[target];
  if (explicit != null && String(explicit) !== '') {
    childEnv[target] = explicit;
    return;
  }
  if (fallbackName) {
    const fb = env[fallbackName];
    if (fb != null && String(fb) !== '') {
      childEnv[target] = fb;
      return;
    }
  }
  if (derived != null && String(derived) !== '') {
    childEnv[target] = derived;
  }
}

async function runPreflight(cfg) {
  const checks = [
    checkGitHead(cfg),
    checkNodeVersion(cfg),
    checkFreeDisk(cfg),
    checkArchiveWritable(cfg),
    checkAdminEnvMapping(cfg),
    await checkHealth(cfg),
    await checkShopApi(cfg)
  ];
  const ok = checks.every(function(c) { return c.ok === true; });
  const preflight = {
    runId: cfg.runId,
    ok: ok,
    checkedAt: new Date().toISOString(),
    envVarNames: envNamesOnly(cfg),
    checks: checks
  };
  writePreflightEvidence(cfg, preflight);
  return preflight;
}

function preflightDir(cfg) {
  // Preflight evidence lives under the archive run folder so it never
  // collides with evidence/<runId>/index.json (written by the pipeline's
  // initEvidenceIndex for the same runId). Falls back to a local folder only
  // when the archive root is missing/unusable.
  const primary = path.join(cfg.archiveRoot, cfg.runId, 'preflight');
  try {
    cfg.fs.mkdirSync(primary, { recursive: true });
    return primary;
  } catch (e) {
    const fallback = path.join(cfg.cwd, 'preflight-evidence', cfg.runId);
    cfg.fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function writePreflightEvidence(cfg, preflight) {
  const dir = preflightDir(cfg);
  for (let i = 0; i < preflight.checks.length; i += 1) {
    const c = preflight.checks[i];
    cfg.fs.writeFileSync(path.join(dir, 'check-' + c.name + '.json'),
      JSON.stringify(c, null, 2) + '\n', 'utf8');
  }
  cfg.fs.writeFileSync(path.join(dir, 'preflight.json'),
    JSON.stringify(preflight, null, 2) + '\n', 'utf8');
}

function runFullStage(cfg) {
  const logDir = path.join(cfg.archiveRoot, cfg.runId, 'logs');
  cfg.fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'pipeline.log');
  const args = [PIPELINE_SCRIPT, 'run', '--manifest', MANIFEST_PATH, '--task', cfg.task];
  // Inject the run id and mapped admin identity into the child environment.
  // cli.js accepts deps.runId; bin/pipeline.js forwards PIPELINE_RUN_ID into
  // deps.runId. Passing it as a CLI flag is not possible because cli.js
  // parseArgs rejects unknown flags. buildChildEnv performs the admin env
  // mapping (explicit SUPERADMIN_* wins) on the child env object only.
  const childEnv = buildChildEnv(cfg);
  const result = cfg.childProcess.spawnSync(process.execPath, args, {
    cwd: cfg.cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const output = (result.stdout || '') + (result.stderr || '');
  cfg.fs.writeFileSync(logFile, output, 'utf8');
  if (result.status === null) {
    return 127;
  }
  return result.status;
}

function copyDir(cfg, src, dest) {
  const fsMod = cfg.fs;
  if (!fsMod.existsSync(src)) {
    return false;
  }
  try {
    fsMod.mkdirSync(dest, { recursive: true });
    const entries = fsMod.readdirSync(src);
    for (let i = 0; i < entries.length; i += 1) {
      const s = path.join(src, entries[i]);
      const d = path.join(dest, entries[i]);
      if (fsMod.statSync(s).isDirectory()) {
        copyDir(cfg, s, d);
      } else {
        fsMod.copyFileSync(s, d);
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

function readRunSummary(cfg, runId) {
  const file = path.join(cfg.cwd, 'reports', runId, 'run-summary.json');
  if (!cfg.fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(cfg.fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function newestEvidenceFolder(cfg) {
  const root = path.join(cfg.cwd, 'evidence');
  if (!cfg.fs.existsSync(root)) {
    return null;
  }
  let entries;
  try {
    entries = cfg.fs.readdirSync(root);
  } catch (e) {
    return null;
  }
  let newest = null;
  for (let i = 0; i < entries.length; i += 1) {
    const full = path.join(root, entries[i]);
    let stat;
    try {
      stat = cfg.fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { name: entries[i], mtimeMs: stat.mtimeMs };
    }
  }
  return newest ? newest.name : null;
}

/**
 * Determine the runId the pipeline actually wrote evidence under.
 * The runId is passed in up front; this only confirms it. The authoritative
 * source is the pipeline's run-summary.json. This avoids guessing: the newest
 * evidence folder is used only as a documented last resort.
 */
function resolvePipelineRunId(cfg) {
  // 1. Authoritative: the pipeline's own run-summary.json for the injected id.
  const summary = readRunSummary(cfg, cfg.runId);
  if (summary && summary.runId) {
    return {
      runId: summary.runId,
      source: summary.runId === cfg.runId ? 'injected' : 'run-summary'
    };
  }
  // 2. The injected id was honored (no summary written, but folders exist).
  if (cfg.fs.existsSync(path.join(cfg.cwd, 'reports', cfg.runId)) ||
      cfg.fs.existsSync(path.join(cfg.cwd, 'evidence', cfg.runId))) {
    return { runId: cfg.runId, source: 'injected' };
  }
  // 3. Last resort: the newest evidence folder (documented as such).
  const newest = newestEvidenceFolder(cfg);
  if (newest) {
    return { runId: newest, source: 'newest-folder' };
  }
  return { runId: cfg.runId, source: 'injected-unconfirmed' };
}

function archiveAndReview(cfg, runId, runIdSource, preflight, pipelineExit, expectsPipelineEvidence) {
  const archiveRun = path.join(cfg.archiveRoot, runId);
  let archiveOk = true;
  try {
    cfg.fs.mkdirSync(archiveRun, { recursive: true });
  } catch (e) {
    archiveOk = false;
  }

  const evidenceCopied = copyDir(cfg, path.join(cfg.cwd, 'evidence', runId), path.join(archiveRun, 'evidence'));
  // reports/ only exists after a pipeline run; absent reports are normal in
  // preflight-only mode.
  copyDir(cfg, path.join(cfg.cwd, 'reports', runId), path.join(archiveRun, 'reports'));
  // Evidence is only expected once the pipeline has run (full mode). In
  // preflight-only mode there is no pipeline evidence yet, so a missing
  // evidence folder is not an archive failure.
  if (archiveOk && expectsPipelineEvidence && !evidenceCopied) {
    archiveOk = false;
  }

  let reviewText = '';
  try {
    reviewText = cfg.childProcess.execFileSync(
      process.execPath,
      [REVIEW_SCRIPT, runId],
      { cwd: cfg.cwd, encoding: 'utf8' }
    );
  } catch (e) {
    reviewText = ((e && e.stderr) || (e && e.message) || String(e)) + '\n';
  }
  try {
    cfg.fs.writeFileSync(path.join(archiveRun, 'review.txt'), reviewText, 'utf8');
  } catch (e) {
    archiveOk = false;
  }

  const summary = {
    runId: runId,
    runIdSource: runIdSource,
    mode: cfg.mode,
    task: cfg.task,
    archivePath: archiveRun,
    envVarNames: envNamesOnly(cfg),
    preflightOk: preflight.ok,
    pipelineExit: pipelineExit,
    archiveOk: archiveOk
  };
  try {
    cfg.fs.writeFileSync(path.join(archiveRun, 'run.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  } catch (e) {
    archiveOk = false;
  }
  return { ok: archiveOk, summary: summary, reviewText: reviewText };
}

/**
 * Entry point. Defaults to preflight-only (PIPELINE_MODE=preflight or unset);
 * runs the full pipeline only when PIPELINE_MODE=full, archives
 * evidence/reports, runs the review, and returns the exit code of the
 * pipeline (never converting a non-zero exit to 0). Any other PIPELINE_MODE
 * value fails safely without spawning.
 */
async function runStaging(deps) {
  deps = deps || {};
  const cfg = resolveConfig(deps);
  const modeCheck = validateMode(cfg.mode);
  if (!modeCheck.ok) {
    // Invalid mode fails safely: nothing is spawned, no preflight evidence
    // is written, and the archive is left untouched.
    return {
      runId: cfg.runId,
      runIdSource: 'none',
      mode: cfg.mode,
      task: cfg.task,
      preflightOk: false,
      pipelineExit: null,
      exitCode: INVALID_MODE_EXIT,
      archiveOk: false,
      archivePath: path.join(cfg.archiveRoot, cfg.runId),
      invalidMode: true,
      error: modeCheck.error
    };
  }
  const preflight = await runPreflight(cfg);
  const preflightOk = preflight.ok === true;

  let pipelineExit = null;
  if (cfg.mode === 'full') {
    if (preflightOk) {
      pipelineExit = runFullStage(cfg);
    } else {
      pipelineExit = 4;
    }
  }

  const resolved = resolvePipelineRunId(cfg);
  const archived = archiveAndReview(cfg, resolved.runId, resolved.source, preflight, pipelineExit, cfg.mode === 'full');

  let exitCode;
  if (cfg.mode === 'full') {
    exitCode = pipelineExit === null ? 0 : pipelineExit;
  } else {
    exitCode = preflightOk ? 0 : 1;
  }
  if (exitCode === 0 && !archived.ok) {
    exitCode = 5;
  }

  return {
    runId: resolved.runId,
    runIdSource: resolved.source,
    mode: cfg.mode,
    task: cfg.task,
    preflightOk: preflightOk,
    pipelineExit: pipelineExit,
    exitCode: exitCode,
    archiveOk: archived.ok,
    archivePath: path.join(cfg.archiveRoot, resolved.runId)
  };
}

async function main() {
  let result;
  try {
    result = await runStaging(undefined);
  } catch (e) {
    console.error('run-staging failed: ' + ((e && e.message) || String(e)));
    process.exitCode = 3;
    return;
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  runStaging,
  resolveConfig,
  envNamesOnly,
  generateRunId,
  runPreflight,
  resolvePipelineRunId,
  buildChildEnv,
  adminEnvMapping,
  checkAdminEnvMapping,
  DEFAULT_ARCHIVE_ROOT,
  DEFAULT_MODE,
  DEFAULT_TASK,
  VALID_MODES,
  INVALID_MODE_EXIT,
  validateMode
};
