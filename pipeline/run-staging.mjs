'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ARCHIVE_ROOT = '/opt/pipeline-archive';
const MODE_PREFLIGHT = 'preflight';
const MODE_FULL = 'full';
// The safe, non-mutating default: without an explicit mode flag the runner
// performs preflight checks only and never spawns a task. Full mode requires
// an explicit approved task selection.
const DEFAULT_MODE = MODE_PREFLIGHT;
const DEFAULT_TASK = 'all'; // retained for exports; never used as a default selection
const VALID_MODES = [MODE_PREFLIGHT, MODE_FULL];
const INVALID_MODE_EXIT = 2;
const PIPELINE_DEFECT_EXIT = 1;
const MANIFEST_PATH = 'manifest/acceptance-manifest.v0.4.json';
const PIPELINE_SCRIPT = 'bin/pipeline.js';
const REVIEW_SCRIPT = 'skills/pipeline-review/review.js';
const ADMIN_API_PATH = '/admin-api';
const SHOP_API_PATH = '/shop-api';

const CLASS_DEPENDENCY = 'DEPENDENCY_ENVIRONMENT';
const CLASS_CLIENT_INPUT = 'CLIENT_INPUT_SCOPE';
const CLASS_PIPELINE_DEFECT = 'PIPELINE_DEFECT';

// Canonical task IDs explicitly approved by the client for the authorized
// staging run. Source: docs/client/acceptance-manifest-v0.4-reconciled.md
// section F.1 "Readiness tasks" (the three readiness tasks: CAN-B1-03,
// CAN-B1-04, CAN-B2-16). The runner must never select any other task and
// never default to `all`; a run with an empty or unapproved selection is
// rejected before anything is spawned.
const AUTHORIZED_TASK_IDS = ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16'];

// CAN-B2-16 is the shipping dry-run readiness task; the manifest documents
// its exact invocation as `--task CAN-B2-16 --scope shipping-dryrun`.
const DRY_RUN_TASK = { taskId: 'CAN-B2-16', scope: 'shipping-dryrun' };

/**
 * Build the ordered execution stages from an approved task selection. Each
 * selected task becomes one stage; a blocked or failed stage never stops the
 * others. Chain runs are NOT part of the restricted staging run: executing
 * chains B/C/D+F would touch canonical task ids the client has not approved.
 */
function buildStagesForTaskIds(taskIds) {
  return (taskIds || []).map(function(id) {
    if (id === DRY_RUN_TASK.taskId) {
      return { name: 'task-' + id, flag: '--task', value: id, scope: DRY_RUN_TASK.scope, summaryFile: 'run-summary.json' };
    }
    return { name: 'task-' + id, flag: '--task', value: id, scope: null, summaryFile: 'run-summary.json' };
  });
}

/**
 * Validate the task selection for a full-mode run. The client authorizes
 * exactly the three canonical ids in AUTHORIZED_TASK_IDS, in order: any
 * missing, duplicate, additional or reordered selection is rejected before
 * anything spawns. Names only appear in the error, never secret values
 * (task ids are not secrets).
 */
function checkTaskSelection(cfg) {
  if (cfg.mode !== MODE_FULL) {
    return { ok: true, error: null };
  }
  const ids = cfg.taskIds || [];
  if (ids.length !== AUTHORIZED_TASK_IDS.length) {
    return {
      ok: false,
      error: 'expected exactly the ' + AUTHORIZED_TASK_IDS.length + ' approved task ids: ' +
        AUTHORIZED_TASK_IDS.join(', ') + ' (got ' + ids.length + ')'
    };
  }
  for (let i = 0; i < ids.length; i += 1) {
    if (ids[i] !== AUTHORIZED_TASK_IDS[i]) {
      return {
        ok: false,
        error: 'task ' + ids[i] + ' is not approved or out of order; expected exactly the approved set in order: ' +
          AUTHORIZED_TASK_IDS.join(', ')
      };
    }
  }
  return { ok: true, error: null };
}

function hasText(v) {
  return v != null && String(v) !== '';
}

/**
 * Parse run-staging CLI flags. Accepts --environment, --staging-url,
 * --archive-dir, --mode and --shop-api-url. Unknown flags and missing values
 * return { error }; values are never logged or written.
 */
function parseArgs(argv) {
  argv = argv || [];
  var out = { mode: null, environment: null, stagingUrl: null, shopApiUrl: null, archiveDir: null, taskIds: [] };
  var i = 0;
  while (i < argv.length) {
    var a = argv[i];
    if (a === '--mode' || a === '--environment' || a === '--staging-url' ||
        a === '--archive-dir' || a === '--shop-api-url' || a === '--task') {
      if (i + 1 >= argv.length) {
        return { error: 'Missing value for ' + a };
      }
      var val = argv[i + 1];
      i += 2;
      if (a === '--mode') out.mode = val;
      else if (a === '--environment') out.environment = val;
      else if (a === '--staging-url') out.stagingUrl = val;
      else if (a === '--archive-dir') out.archiveDir = val;
      else if (a === '--shop-api-url') out.shopApiUrl = val;
      else if (a === '--task') out.taskIds.push(val);
      continue;
    }
    if (String(a).charAt(0) === '-') {
      return { error: 'Unknown flag: ' + a };
    }
    i++;
  }
  return out;
}

/**
 * Validate the staging mode against the allowed set. The full sequence is
 * the default when no mode flag is given; the error names the variable,
 * never the value.
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
 * Normalise config. Reads CLI flags (deps.args) plus env var values (never
 * their secrets): names only are ever logged or written. The workflow env
 * (STRIPE_SECRET_KEY, OPENROUTER_API_KEY, STAGING_ADMIN_EMAIL,
 * STAGING_ADMIN_PASSWORD) is passed through untouched to dependents; no
 * value is ever printed or persisted by this module.
 */
function resolveConfig(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const childProcess = deps.childProcess || require('node:child_process');
  const fsMod = deps.fs || nodeFs();
  const fetchImpl = deps.fetch || globalThis.fetch;
  const parsed = deps.args !== undefined && deps.args !== null ? deps.args : parseArgs([]);

  const stagingUrl = hasText(parsed.stagingUrl)
    ? String(parsed.stagingUrl)
    : (hasText(env.PIPELINE_STAGING_URL) ? env.PIPELINE_STAGING_URL : null);
  const shopApiUrl = hasText(parsed.shopApiUrl)
    ? String(parsed.shopApiUrl)
    : (hasText(env.PIPELINE_SHOP_API_URL)
      ? env.PIPELINE_SHOP_API_URL
      : (stagingUrl ? stagingUrl + SHOP_API_PATH : null));
  const archiveRoot = hasText(parsed.archiveDir)
    ? String(parsed.archiveDir)
    : (env.PIPELINE_ARCHIVE_ROOT || DEFAULT_ARCHIVE_ROOT);
  const mode = hasText(parsed.mode)
    ? String(parsed.mode)
    : (env.PIPELINE_MODE || DEFAULT_MODE);

  return {
    env: env,
    envNames: Object.keys(env),
    childProcess: childProcess,
    fs: fsMod,
    fetch: fetchImpl,
    cwd: deps.cwd || process.cwd(),
    nodeVersion: deps.nodeVersion || process.version,
    archiveRoot: archiveRoot,
    mode: mode,
    task: env.PIPELINE_TASK || DEFAULT_TASK,
    taskIds: Array.isArray(parsed.taskIds) ? parsed.taskIds.slice() : [],
    stagingUrl: stagingUrl,
    shopApiUrl: shopApiUrl,
    environment: hasText(parsed.environment) ? parsed.environment : (env.PIPELINE_ENVIRONMENT || null),
    runId: deps.runId || generateRunId(),
    parseError: parsed.error || null
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
  const url = cfg.shopApiUrl || (cfg.stagingUrl ? cfg.stagingUrl + SHOP_API_PATH : null);
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
  // Names of environment variables this stage reads, never their values.
  return ['PIPELINE_ARCHIVE_ROOT', 'PIPELINE_MODE', 'PIPELINE_TASK',
    'PIPELINE_STAGING_URL', 'PIPELINE_SHOP_API_URL',
    'SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD', 'VENDURE_ADMIN_API_URL',
    'STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD',
    'STRIPE_SECRET_KEY', 'OPENROUTER_API_KEY'];
}

/**
 * Resolve the admin identity the child pipeline will use, without ever
 * materialising values. Returns only booleans (present or not) and the name
 * of the variable supplying each mapped target.
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
  const ok = checks.every(function(c) { return c.ok !== false && c.ok === true; });
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

/**
 * Run one ordered stage (task all, or a chain) as a child pipeline process.
 * A failure or block in any stage never stops the others: runStaging always
 * iterates over every stage. Summarizes the stage outcome.
 */
function runStage(cfg, stage) {
  let logDir = null;
  try {
    logDir = path.join(cfg.archiveRoot, cfg.runId, 'logs');
    cfg.fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    // continue without a log dir; a logging failure must not stop the run
  }
  const logFile = logDir ? path.join(logDir, stage.name + '.log') : null;
  const args = [PIPELINE_SCRIPT, 'run', '--manifest', MANIFEST_PATH];
  if (stage.flag === '--task') {
    args.push('--task', stage.value);
    if (stage.scope) {
      args.push('--scope', stage.scope);
    }
  } else {
    args.push('--chain', stage.value);
  }
  const childEnv = buildChildEnv(cfg);
  const result = cfg.childProcess.spawnSync(process.execPath, args, {
    cwd: cfg.cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const output = (result.stdout || '') + (result.stderr || '');
  if (logFile) {
    try {
      cfg.fs.writeFileSync(logFile, output, 'utf8');
    } catch (e) {}
  }
  const outcome = {
    name: stage.name,
    command: args.join(' '),
    args: args,
    exitCode: result.status === null ? 127 : result.status,
    classification: null,
    cause: null,
    summary: readStageSummary(cfg, stage.summaryFile)
  };
  if (result.status === null) {
    outcome.classification = CLASS_PIPELINE_DEFECT;
    outcome.cause = 'SPAWN_FAILED';
  } else {
    classifyStage(outcome);
  }
  return outcome;
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

function readStageSummary(cfg, fileName) {
  const file = path.join(cfg.cwd, 'reports', cfg.runId, fileName);
  if (!cfg.fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(cfg.fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Determine whether a stage summary contains a PIPELINE_DEFECT result.
 * Chain summaries carry a top-level classification (the worst task in the
 * chain); task/run summaries carry per-task classifications.
 */
function hasPipelineDefect(summary) {
  if (!summary) return false;
  if (summary.classification === CLASS_PIPELINE_DEFECT) return true;
  const tasks = summary.tasks;
  if (Array.isArray(tasks)) {
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].classification === CLASS_PIPELINE_DEFECT) return true;
    }
  }
  return false;
}

function isPassResult(v) {
  return v === 'PASS' || v === 'RESULT_PASS';
}

function firstTaskProblem(summary) {
  const tasks = summary && summary.tasks;
  if (!Array.isArray(tasks)) return null;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t) continue;
    const blockedOrFailed = !isPassResult(t.result) ||
      (t.classification != null && t.classification !== '');
    if (blockedOrFailed) return t;
  }
  return null;
}

function classifyStage(outcome) {
  const summary = outcome.summary;
  if (summary === null) {
    if (outcome.exitCode !== 0) {
      outcome.classification = CLASS_PIPELINE_DEFECT;
      outcome.cause = 'SUMMARY_MISSING';
    }
    return;
  }
  if (hasPipelineDefect(summary)) {
    outcome.classification = CLASS_PIPELINE_DEFECT;
    outcome.cause = summary.cause || 'PIPELINE_DEFECT';
    return;
  }
  const problem = firstTaskProblem(summary);
  if (problem) {
    // Propagate task-level BLOCK / classifications (CLIENT_INPUT_SCOPE,
    // DEPENDENCY_ENVIRONMENT, ...) up to the stage so a blocked or failed
    // task never yields an overall successful exit code, even at exit 0.
    outcome.classification = problem.classification != null && problem.classification !== ''
      ? problem.classification
      : CLASS_PIPELINE_DEFECT;
    outcome.cause = problem.cause || problem.result || 'task failed';
    return;
  }
  outcome.cause = summary.cause || null;
}

/**
 * A stage counts as blocked or failed when its child pipeline exited
 * non-zero (task failed, spawn failed) or a classification was recorded
 * (e.g. CLIENT_INPUT_SCOPE / DEPENDENCY_ENVIRONMENT block). Any such stage
 * makes the whole run exit non-zero.
 */
function stageBlockedOrFailed(stage) {
  if (stage.exitCode !== 0) {
    return true;
  }
  return stage.classification != null && stage.classification !== '';
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
 * Determine the runId actually used. The injected id is authoritative; the
 * pipeline's own run-summary under reports/<runId> confirms it.
 */
function resolvePipelineRunId(cfg) {
  const summary = readRunSummary(cfg, cfg.runId);
  if (summary && summary.runId) {
    return {
      runId: summary.runId,
      source: summary.runId === cfg.runId ? 'injected' : 'run-summary'
    };
  }
  if (cfg.fs.existsSync(path.join(cfg.cwd, 'reports', cfg.runId)) ||
      cfg.fs.existsSync(path.join(cfg.cwd, 'evidence', cfg.runId))) {
    return { runId: cfg.runId, source: 'injected' };
  }
  const newest = newestEvidenceFolder(cfg);
  if (newest) {
    return { runId: newest, source: 'newest-folder' };
  }
  return { runId: cfg.runId, source: 'injected-unconfirmed' };
}

function writeAggregatedSummary(cfg, preflight, stages) {
  const outDir = path.join(cfg.cwd, 'reports', cfg.runId);
  const stageRows = [];
  const allTasks = [];
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    stageRows.push({
      name: stage.name,
      command: stage.command,
      exitCode: stage.exitCode,
      classification: stage.classification,
      cause: stage.cause
    });
    const summary = stage.summary;
    if (summary && Array.isArray(summary.tasks)) {
      for (let j = 0; j < summary.tasks.length; j += 1) {
        const t = summary.tasks[j];
        allTasks.push({
          stage: stage.name,
          taskId: t.taskId,
          result: t.result,
          classification: t.classification,
          cause: t.cause
        });
      }
    }
  }
  const anyDefect = stages.some(function(s) { return s.classification === CLASS_PIPELINE_DEFECT; });
  const summary = {
    schemaVersion: '1.0',
    runId: cfg.runId,
    mode: cfg.mode,
    startedAt: preflight.checkedAt,
    completedAt: new Date().toISOString(),
    preflightOk: preflight.ok === true,
    anyPipelineDefect: anyDefect,
    stages: stageRows,
    tasks: allTasks
  };
  const file = path.join(outDir, 'run-summary.json');
  try {
    cfg.fs.mkdirSync(outDir, { recursive: true });
    cfg.fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  } catch (e) {}
  return summary;
}

function archiveRun(cfg, runId, runIdSource, preflight, stages) {
  const archiveRun = `${cfg.archiveRoot}/${runId}`;
  let archiveOk = true;
  try {
    cfg.fs.mkdirSync(archiveRun, { recursive: true });
  } catch (e) {
    archiveOk = false;
  }

  const evidenceCopied = copyDir(cfg, path.join(cfg.cwd, 'evidence', runId), path.join(archiveRun, 'evidence'));
  copyDir(cfg, path.join(cfg.cwd, 'reports', runId), path.join(archiveRun, 'reports'));
  if (archiveOk && stages.length > 0 && !evidenceCopied) {
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

  const anyDefect = stages.some(function(s) { return s.classification === CLASS_PIPELINE_DEFECT; });
  const summary = {
    runId: runId,
    runIdSource: runIdSource,
    mode: cfg.mode,
    task: cfg.task,
    environment: cfg.environment,
    archivePath: archiveRun,
    envVarNames: envNamesOnly(cfg),
    preflightOk: preflight.ok,
    anyPipelineDefect: anyDefect,
    stages: stages.map(function(s) {
      return { name: s.name, exitCode: s.exitCode, classification: s.classification, cause: s.cause };
    }),
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
 * Entry point. With no mode flag (default) runs preflight checks only and
 * never spawns. With full mode, stages run only when the runner's own
 * preflight passes (zero tasks on preflight failure); all approved stages
 * run after an individual failure so evidence is collected. A blocked or
 * failed stage makes the run exit non-zero. State is archived under
 * archive-dir/<runId>/.
 */
async function runStaging(deps) {
  deps = deps || {};
  const cfg = resolveConfig(deps);
  if (cfg.parseError) {
    return {
      runId: cfg.runId,
      runIdSource: 'none',
      mode: cfg.mode,
      task: cfg.task,
      preflightOk: false,
      stages: [],
      anyPipelineDefect: false,
      pipelineExit: null,
      exitCode: INVALID_MODE_EXIT,
      archiveOk: false,
      archivePath: path.join(cfg.archiveRoot, cfg.runId),
      error: cfg.parseError
    };
  }
  const modeCheck = validateMode(cfg.mode);
  if (!modeCheck.ok) {
    return {
      runId: cfg.runId,
      runIdSource: 'none',
      mode: cfg.mode,
      task: cfg.task,
      preflightOk: false,
      stages: [],
      anyPipelineDefect: false,
      pipelineExit: null,
      exitCode: INVALID_MODE_EXIT,
      archiveOk: false,
      archivePath: path.join(cfg.archiveRoot, cfg.runId),
      invalidMode: true,
      error: modeCheck.error
    };
  }

  // Task-selection validation: full mode requires a non-empty selection of
  // only client-approved canonical ids. An empty selection or any unapproved
  // id is rejected BEFORE preflight evidence is written or anything spawns.
  const taskCheck = checkTaskSelection(cfg);
  if (!taskCheck.ok) {
    return {
      runId: cfg.runId,
      runIdSource: 'none',
      mode: cfg.mode,
      preflightOk: false,
      stages: [],
      anyPipelineDefect: false,
      pipelineExit: null,
      exitCode: INVALID_MODE_EXIT,
      archiveOk: false,
      archivePath: path.join(cfg.archiveRoot, cfg.runId),
      taskSelectionError: true,
      error: taskCheck.error
    };
  }

  const preflight = await runPreflight(cfg);
  const preflightOk = preflight.ok === true;

  let stages = [];
  if (cfg.mode === MODE_FULL && preflightOk) {
    const planned = buildStagesForTaskIds(cfg.taskIds);
    for (let i = 0; i < planned.length; i += 1) {
      stages.push(runStage(cfg, planned[i]));
    }
  }

  writeAggregatedSummary(cfg, preflight, stages);

  const resolved = resolvePipelineRunId(cfg);
  const archived = archiveRun(cfg, resolved.runId, resolved.source, preflight, stages);

  let exitCode;
  if (cfg.mode === MODE_FULL) {
    const anyBlockedOrFailed = !preflightOk || stages.some(stageBlockedOrFailed);
    exitCode = anyBlockedOrFailed ? PIPELINE_DEFECT_EXIT : 0;
    if (exitCode === 0 && !archived.ok) {
      exitCode = PIPELINE_DEFECT_EXIT;
    }
  } else {
    exitCode = preflightOk ? 0 : 1;
  }

  return {
    runId: resolved.runId,
    runIdSource: resolved.source,
    mode: cfg.mode,
    task: cfg.task,
    preflightOk: preflightOk,
    pipelineExit: stages.length > 0 ? stages[stages.length - 1].exitCode : (preflightOk ? 0 : 1),
    anyPipelineDefect: stages.some(function(s) { return s.classification === CLASS_PIPELINE_DEFECT; }),
    stages: stages,
    exitCode: exitCode,
    archiveOk: archived.ok,
    archivePath: path.join(cfg.archiveRoot, resolved.runId)
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = await runStaging({ args: parsed });
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
  parseArgs,
  envNamesOnly,
  generateRunId,
  runPreflight,
  resolvePipelineRunId,
  buildChildEnv,
  adminEnvMapping,
  checkAdminEnvMapping,
  buildStagesForTaskIds,
  checkTaskSelection,
  AUTHORIZED_TASK_IDS,
  DRY_RUN_TASK,
  DEFAULT_ARCHIVE_ROOT,
  DEFAULT_MODE,
  DEFAULT_TASK,
  VALID_MODES,
  INVALID_MODE_EXIT,
  PIPELINE_DEFECT_EXIT,
  validateMode
};
