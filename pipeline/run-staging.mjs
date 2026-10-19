'use strict';

import { createRequire } from 'node:module';
import path from 'path';
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
const CLASS_TARGET_APP_DEFECT = 'TARGET_APP_DEFECT';

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

// evidenceCollector is CommonJS; require it once for REQUIRED_TASK_FIELDS.
const evidenceCollector = require('../src/evidenceCollector.js');
const REQUIRED_TASK_FIELDS = evidenceCollector.REQUIRED_TASK_FIELDS;

// Manifest loaded once per process lifetime. source.referenceCommit is the
// pipeline's pinned reference commit (the "reference revision").
let _manifest = null;
function getManifest() {
  if (_manifest === null) {
    try {
      _manifest = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', MANIFEST_PATH), 'utf8'));
    } catch (e) {
      _manifest = { tasks: {}, source: {} };
    }
  }
  return _manifest;
}

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
  var out = { mode: null, environment: null, stagingUrl: null, shopApiUrl: null, archiveDir: null, taskIds: [], seedTestData: false, seedDryRun: false };
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
    if (a === '--seed-test-data') {
      out.seedTestData = true;
      i++;
      continue;
    }
    if (a === '--seed-dry-run') {
      out.seedDryRun = true;
      i++;
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
    seedTestData: !!parsed.seedTestData,
    seedDryRun: !!parsed.seedDryRun,
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
  // Attach the task record error text (record.json exitErrorResult.error and
  // executor-error.json) to each summary task so classifyStage can look at the
  // real error even when the task cause is only a token like STAGING_SERVER_ERROR.
  attachTaskRecordErrors(cfg, outcome);
  if (result.status === null) {
    outcome.classification = CLASS_PIPELINE_DEFECT;
    outcome.cause = 'SPAWN_FAILED';
  } else {
    classifyStage(outcome);
    // Persist any task-level reclassification back into the record so the
    // compliance-report.json/.md task rows carry the same classification/cause.
    persistStageClassification(cfg, outcome);
  }
  return outcome;
}

/**
 * Read the evidence record.json exitErrorResult + executor-error.json error text
 * for each task in the stage summary and attach it to the task so classifyStage
 * sees the real error text, not just the (possibly generic) cause.
 */
function attachTaskRecordErrors(cfg, outcome) {
  var summary = outcome && outcome.summary;
  if (!summary || !Array.isArray(summary.tasks)) return;
  for (var i = 0; i < summary.tasks.length; i++) {
    var t = summary.tasks[i];
    if (!t) continue;
    var taskId = t.taskId || t.id;
    if (!taskId) continue;
    if (t.exitErrorResult && typeof t.exitErrorResult === 'object') continue;
    var rec = readTaskRecord(cfg, taskId);
    if (rec && rec.exitErrorResult && typeof rec.exitErrorResult === 'object') {
      t.exitErrorResult = rec.exitErrorResult;
    } else {
      var exErr = readExecutorError(cfg, taskId);
      if (exErr !== null) {
        t.executorError = exErr;
        t.exitErrorResult = { exitCode: null, error: exErr };
      }
    }
  }
}

function readTaskRecord(cfg, taskId) {
  var file = path.join(cfg.cwd, 'evidence', cfg.runId, taskId, 'record.json');
  if (!cfg.fs.existsSync(file)) return null;
  try {
    return JSON.parse(cfg.fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readExecutorError(cfg, taskId) {
  var file = path.join(cfg.cwd, 'evidence', cfg.runId, taskId, 'executor-error.json');
  if (!cfg.fs.existsSync(file)) return null;
  try {
    var data = JSON.parse(cfg.fs.readFileSync(file, 'utf8'));
    if (data && typeof data.error === 'string' && data.error !== '') return data.error;
    if (data && typeof data.message === 'string' && data.message !== '') return data.message;
    var probes = data && data.probes;
    if (probes && typeof probes === 'object') {
      var keys = Object.keys(probes);
      for (var i = 0; i < keys.length; i++) {
        var p = probes[keys[i]];
        if (p && typeof p.error === 'string' && p.error !== '') return p.error;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * After classification, write any task-level TARGET_APP_DEFECT reclassification
 * back into the task's record.json (classification/cause/finalClassification) so
 * the compliance report rows show the same defect as run-summary.json.
 */
function persistStageClassification(cfg, outcome) {
  var summary = outcome && outcome.summary;
  if (!summary || !Array.isArray(summary.tasks)) return;
  for (var i = 0; i < summary.tasks.length; i++) {
    var t = summary.tasks[i];
    if (!t) continue;
    if (t.classification !== CLASS_TARGET_APP_DEFECT) continue;
    if (t.result === 'PASS' || t.result === 'RESULT_PASS' || t.result === 'READINESS_PASS') continue;
    var taskId = t.taskId || t.id;
    if (!taskId) continue;
    var file = path.join(cfg.cwd, 'evidence', cfg.runId, taskId, 'record.json');
    if (!cfg.fs.existsSync(file)) continue;
    try {
      var record = JSON.parse(cfg.fs.readFileSync(file, 'utf8'));
      if (record.classification === CLASS_TARGET_APP_DEFECT && record.cause === t.cause) continue;
      record.classification = CLASS_TARGET_APP_DEFECT;
      record.cause = t.cause;
      record.finalClassification = 'BLOCK';
      rewriteEvidenceEntry(cfg, taskId, 'record.json', record);
    } catch (e) {}
  }
}

/**
 * Rewrite an evidence file and update its index entry sha in place.
 * writeEvidenceFile APPENDS a duplicate index entry, leaving the old hash
 * stale and failing verifyEvidence; this replaces and re-hashes the entry.
 */
function rewriteEvidenceEntry(cfg, taskId, filename, record) {
  var crypto = require('node:crypto');
  var content = JSON.stringify(record, null, 2);
  var sha = crypto.createHash('sha256').update(content + '\n', 'utf8').digest('hex');
  var absPath = path.join(cfg.cwd, 'evidence', cfg.runId, taskId, filename);
  cfg.fs.writeFileSync(absPath, content + '\n', 'utf8');
  var indexPath = path.join(cfg.cwd, 'evidence', cfg.runId, 'index.json');
  if (!cfg.fs.existsSync(indexPath)) return;
  try {
    var index = JSON.parse(cfg.fs.readFileSync(indexPath, 'utf8'));
    var relPath = (taskId + '/' + filename).replace(/\\/g, '/');
    var entries = index.tasks && index.tasks[taskId];
    if (Array.isArray(entries)) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i] && entries[i].path === relPath) {
          if (entries[i].sha256 === sha) { return; }
          entries[i].sha256 = sha;
          entries[i].timestamp = new Date().toISOString();
        }
      }
    }
    cfg.fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  } catch (e) {}
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
  return v === 'PASS' || v === 'RESULT_PASS' || v === 'READINESS_PASS';
}

/**
 * Gather every diagnostic string from a task problem so the classifier can
 * inspect the cause, the result, and the task record error text
 * (record.json exitErrorResult.error / executor-error.json) together.
 */
function taskProblemText(t) {
  var parts = [];
  function push(v) {
    if (typeof v === 'string' && v !== '') parts.push(v);
    else if (v && typeof v === 'object' && typeof v.message === 'string' && v.message !== '') parts.push(v.message);
  }
  if (!t || typeof t !== 'object') return parts.join('|');
  push(t.cause);
  push(t.result);
  push(t.reason);
  push(t.error);
  push(t.message);
  push(t.detail);
  // record.json exitErrorResult.error / executor-error.json error text attached
  // by runStage from the evidence record.
  if (t.exitErrorResult && typeof t.exitErrorResult === 'object') {
    push(t.exitErrorResult.error);
    push(t.exitErrorResult.message);
  }
  if (Array.isArray(t.errors)) {
    for (var i = 0; i < t.errors.length; i++) push(t.errors[i]);
  }
  ['executorError', 'executorOutput', 'stderr', 'stdout'].forEach(function(field) {
    push(t[field]);
  });
  return parts.join('|');
}

/**
 * Gather diagnostic strings at stage level (used when no specific problem task
 * exists, e.g. a chain summary carrying only a classification/cause).
 */
function outcomeErrorText(outcome) {
  var parts = [];
  function push(v) {
    if (typeof v === 'string' && v !== '') parts.push(v);
  }
  if (!outcome || typeof outcome !== 'object') return parts.join('|');
  push(outcome.cause);
  push(outcome.classification);
  push(outcome.error);
  push(outcome.message);
  if (outcome.exitErrorResult && typeof outcome.exitErrorResult === 'object') {
    push(outcome.exitErrorResult.error);
    push(outcome.exitErrorResult.message);
  }
  return parts.join('|');
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
    // The staging Shop API products-list integer error is an in-scope
    // target-application defect (client-ruled).  Detect it at the task level
    // even when the task summary carries DEPENDENCY_ENVIRONMENT or another
    // non-target classification, so CAN-B1-03/CAN-B1-04 blocked/classified
    // tasks correctly reflect the TARGET_APP_DEFECT cause.  The task cause may
    // only be a generic token (e.g. STAGING_SERVER_ERROR); the integer error
    // text is then only in the task record (record.json exitErrorResult.error /
    // executor-error.json), which runStage attached as exitErrorResult, so the
    // classifier inspects that text too, not just the cause.
    var problemText = taskProblemText(problem);
    if (looksLikeServerProductsListError(outcome.cause || '') ||
        looksLikeServerProductsListError(outcome.classification || '') ||
        looksLikeServerProductsListError(problemText)) {
      outcome.classification = CLASS_TARGET_APP_DEFECT;
      outcome.cause = "repair required: Shop API products list fails server-side (Postgres: product.id != $3 with $3='undefined')";
      // Write the corrected classification/cause back onto the task row so the
      // aggregated run-summary.json tasks[] and the record echo the same defect.
      problem.classification = outcome.classification;
      problem.cause = outcome.cause;
    }
    return;
  }
  // Chain-level cause (no specific problem task) may still carry the integer
  // error and must be reclassified the same way.
  if (looksLikeServerProductsListError(outcome.cause || '') ||
      looksLikeServerProductsListError(outcome.classification || '') ||
      looksLikeServerProductsListError(outcomeErrorText(outcome))) {
    outcome.classification = CLASS_TARGET_APP_DEFECT;
    outcome.cause = "repair required: Shop API products list fails server-side (Postgres: product.id != $3 with $3='undefined')";
    return;
  }
  outcome.cause = summary.cause || null;
}

/**
 * Gather every diagnostic string from a seed result so the classifier can
 * inspect all of them together. Values are read in-memory only; never written
 * or returned as secrets.
 */
function collectSeedFailureText(seed) {
  var out = [];
  function push(v) {
    if (typeof v === 'string' && v !== '') out.push(v);
    else if (v !== undefined && v !== null && typeof v === 'object' && typeof v.message === 'string' && v.message !== '') out.push(v.message);
  }
  if (!seed || typeof seed !== 'object') return out;
  push(seed.reason);
  push(seed.error);
  if (Array.isArray(seed.errors)) {
    for (var i = 0; i < seed.errors.length; i++) push(seed.errors[i]);
  }
  ['failed', 'blocked', 'conflicts'].forEach(function(arrName) {
    var arr = seed[arrName];
    if (!Array.isArray(arr)) return;
    for (var j = 0; j < arr.length; j++) {
      var entry = arr[j];
      if (!entry) continue;
      push(entry.error);
      push(entry.reason);
      push(entry.detail);
      push(entry.message);
    }
  });
  return out;
}

/**
 * Classify a failed seed by its cause so a missing Pipeline-owned input never
 * masquerades as an environment failure. Categories:
 *   - CLIENT_INPUT_SCOPE: missing or rejected client-supplied secrets/config
 *     (SEED_TEST_CUSTOMER_PASSWORD, CHANNEL_TOKENS, admin credentials,
 *     non-allowed staging host). Only variable NAMES are ever produced.
 *   - DEPENDENCY_ENVIRONMENT: network / HTTP 5xx / health failures.
 *   - PIPELINE_DEFECT: GraphQL validation/schema errors, wrong-type errors,
 *     missing Pipeline-owned inputs (enum/variable errors, "Language ... not
 *     available" caused by the seed spec), or any unclassifiable failure
 *     (default: per client rules seed mutation failures are Pipeline defects,
 *     never environment failures).
 * Returns null when the seed passed.
 */
function classifySeedFailure(seed) {
  if (!seed || seed.ok === true) return null;
  var text = collectSeedFailureText(seed);
  var joined = text.join(' | ');
  var reason = seed.reason || null;

  // Pipeline code could not even load the seeder module.
  if (reason === 'SEED_MODULE_UNAVAILABLE') {
    return { classification: CLASS_PIPELINE_DEFECT, cause: 'seed failed: SEED_MODULE_UNAVAILABLE' };
  }

  // Missing / rejected client-supplied secrets or client-pointed config.
  if (reason === 'ADMIN_CREDENTIALS_MISSING') {
    var absent = (seed.credentialNames && Array.isArray(seed.credentialNames.absent))
      ? seed.credentialNames.absent.slice() : [];
    return {
      classification: CLASS_CLIENT_INPUT,
      cause: 'seed failed: ADMIN_CREDENTIALS_MISSING' + (absent.length > 0 ? '; missing ' + absent.join(', ') : ''),
      variableNames: absent
    };
  }
  if (reason === 'SEED_CONFIG_BLOCKED') {
    var names = clientSecretNamesInText(joined);
    if (names.length > 0) {
      return {
        classification: CLASS_CLIENT_INPUT,
        cause: 'seed failed: SEED_CONFIG_BLOCKED; missing client-supplied secret ' + names.join(', '),
        variableNames: names
      };
    }
  }
  if (reason === 'SEED_HOST_NOT_ALLOWED') {
    return { classification: CLASS_CLIENT_INPUT, cause: 'seed failed: SEED_HOST_NOT_ALLOWED; host scope is client-supplied' };
  }

  // Network / 5xx / health failures are environment problems.
  if (isNetworkFailureText(joined)) {
    return {
      classification: CLASS_DEPENDENCY,
      cause: 'seed failed: ' + (reason || 'SEED_FAILED') + ' (network/server failure)'
    };
  }

  // The staging Shop API products-list integer error is an in-scope
  // target-application defect (client-ruled), NEVER an environment/pending
  // failure -- but only when it is the SOLE seed failure.  Any other seed
  // failure (including together with the integer error) is a Pipeline defect.
  if (looksLikeServerProductsListError(joined) && !hasOtherSeedFailure(seed)) {
    return {
      classification: CLASS_TARGET_APP_DEFECT,
      result: 'BLOCK',
      cause: "repair required: Shop API products list fails server-side (Postgres: product.id != $3 with $3='undefined')"
    };
  }

  // GraphQL validation / schema / wrong-type / seed-spec input defects.
  if (isSchemaOrGraphqlText(joined)) {
    return {
      classification: CLASS_PIPELINE_DEFECT,
      cause: 'seed failed: ' + (reason || 'SEED_FAILED') + ' (seed spec / schema error)'
    };
  }

  // Default under the client's rules: a seed mutation failure is a Pipeline
  // defect, never an environment failure.
  return {
    classification: CLASS_PIPELINE_DEFECT,
    cause: 'seed failed: ' + (reason || 'SEED_FAILED')
  };
}

var SEED_CLIENT_SECRET_NAME_PATTERNS = [
  /SEED_TEST_CUSTOMER_PASSWORD/,
  /CHANNEL_TOKENS/,
  /SUPERADMIN_USERNAME|SUPERADMIN_PASSWORD|STAGING_ADMIN_EMAIL|STAGING_ADMIN_PASSWORD|VENDURE_ADMIN_API_URL/
];

function clientSecretNamesInText(text) {
  var found = [];
  for (var i = 0; i < SEED_CLIENT_SECRET_NAME_PATTERNS.length; i++) {
    var m = String(text).match(SEED_CLIENT_SECRET_NAME_PATTERNS[i]);
    if (m && found.indexOf(m[0]) === -1) found.push(m[0]);
  }
  return found;
}

var SEED_NETWORK_FAILURE_PATTERNS = [
  /network error/i,
  /fetch failed/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i,
  /socket hang up/i,
  /temporary failure in name resolution/i,
  /([Hh][Tt][Tt][Pp]|[Ss]tatus|statusCode)[^0-9]{0,12}5\d\d/,
  /(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /connection (?:refused|reset|timed out)/i
];

function isNetworkFailureText(text) {
  var s = String(text);
  for (var i = 0; i < SEED_NETWORK_FAILURE_PATTERNS.length; i++) {
    if (SEED_NETWORK_FAILURE_PATTERNS[i].test(s)) return true;
  }
  return false;
}

var SEED_SCHEMA_GQL_PATTERNS = [
  /Expected value of type/i,
  /Cannot query field/i,
  /Unknown (?:argument|field|type|directive)/i,
  /does not exist on type/i,
  /Variable .+? got invalid value/i,
  /got invalid value/i,
  /must be one of/i,
  /GraphQL validation/i,
  /\benum\b/i,
  /not available in the schema/i,
  /cannot enable language/i,
  /language.{0,60}not available/i,
  /not available.{0,60}language/i,
  /wrong type/i,
  /expected type/i
];

function isSchemaOrGraphqlText(text) {
  var s = String(text);
  for (var i = 0; i < SEED_SCHEMA_GQL_PATTERNS.length; i++) {
    if (SEED_SCHEMA_GQL_PATTERNS[i].test(s)) return true;
  }
  return false;
}

var SEED_SERVER_PRODUCTS_LIST_PATTERN = /invalid input syntax for type integer/i;

function looksLikeServerProductsListError(text) {
  return SEED_SERVER_PRODUCTS_LIST_PATTERN.test(String(text));
}

/**
 * True when the seed has any failure message that is NOT the server
 * products-list integer error (so that error is not the sole cause).
 * Inspects the raw seed fields directly because some paths reduce the seed
 * to counts (failed/blocked/conflicts are numbers) while others keep arrays.
 */
function hasOtherSeedFailure(seed) {
  function other(v) {
    if (typeof v === 'string' && v !== '' && !looksLikeServerProductsListError(v)) return true;
    return false;
  }
  function scan(entry) {
    if (!entry) return false;
    if (other(entry.error) || other(entry.message) || other(entry.reason) || other(entry.detail)) return true;
    return false;
  }
  if (other(seed.error) || other(seed.reason)) return true;
  var errs = seed.errors;
  if (Array.isArray(errs)) {
    for (var i = 0; i < errs.length; i++) {
      if (typeof errs[i] === 'string' && errs[i] !== '' && !looksLikeServerProductsListError(errs[i])) return true;
    }
  } else if (typeof errs === 'string' && errs !== '' && !looksLikeServerProductsListError(errs)) {
    return true;
  }
  return ['failed', 'blocked', 'conflicts'].some(function(arrName) {
    var arr = seed[arrName];
    if (Array.isArray(arr)) {
      for (var j = 0; j < arr.length; j++) {
        if (scan(arr[j])) return true;
      }
      return false;
    }
    // arr is a count (number).  A non-zero count means mutations/entities failed
    // that recordMutation'd without a string in errors[].  Treat as another failure;
    // if errors[] is non-empty hasOtherSeedFailure already gave the right answer.
    if (typeof arr === 'number' && arr > 0) {
      return !(Array.isArray(errs) && errs.length > 0);
    }
    // Not an array, not a number (null, undefined, etc.) — nothing to scan.
    return false;
  });
}

/**
 * Attach the seed classification (and nothing secret) to the reduced seed
 * record so run-summary.json / run.json and the blocked dependents can carry
 * the same cause. Idempotent.
 */
function applySeedClassification(seed) {
  if (!seed) return seed;
  if (seed.ok === true) {
    seed.classification = null;
    seed.cause = null;
    return seed;
  }
  var cc = classifySeedFailure(seed) || { classification: CLASS_PIPELINE_DEFECT, cause: 'seed failed' };
  seed.classification = cc.classification;
  seed.cause = cc.cause;
  if (cc.variableNames) seed.variableNames = cc.variableNames;
  return seed;
}

/**
 * Write a stub record.json for a blocked task and patch index.json so the
 * compliance report shows result:BLOCK with the correct classification and
 * cause, instead of MISSING_EVIDENCE. The record carries all 16 required
 * fields from REQUIRED_TASK_FIELDS so verifyEvidence does not fail and the
 * blocked task's legitimate BLOCK outcome does not become EVIDENCE_INVALID
 * for a different task.
 */
function writeBlockedTaskEvidence(cfg, blocked, executionRevision) {
  var taskInfo = blocked && blocked.summary && blocked.summary.tasks && blocked.summary.tasks[0];
  if (!taskInfo || !taskInfo.taskId) return;
  var taskId = taskInfo.taskId;
  var root = path.join(cfg.cwd, 'evidence', cfg.runId);
  var taskDir = path.join(root, taskId);

  // Look up task from the manifest to get canonicalId, summarySpecIds,
  // expectedResult, requiredInputs for the canonical record.
  var manifest = getManifest();
  var manifestTask = null;
  if (manifest && Array.isArray(manifest.tasks)) {
    manifestTask = manifest.tasks.find(function(t) { return t.canonicalId === taskId; });
  }

  var referenceRevision = (manifest && manifest.source && manifest.source.referenceCommit) || null;
  var envId = {
    runId: cfg.runId,
    environment: cfg.environment || null,
    workspacePath: null
  };

  var record = {
    // Canonical identity (16 required fields, verified by hasRequiredRecordFields).
    canonicalId: taskId,
    summarySpecIds: manifestTask ? (manifestTask.summaryIds || []) : [],
    referenceRevision: referenceRevision,
    executionRevision: executionRevision || null,
    environmentIdentity: envId,
    commandInvocation: { executed: false, note: 'not executed: ' + (taskInfo.cause || blocked.cause || 'seed failed') },
    inputArtifactIds: manifestTask ? (manifestTask.requiredInputs || []) : [],
    expectedResult: manifestTask ? manifestTask.expectedResult : null,
    actualResult: null,
    exitErrorResult: { exitCode: blocked.exitCode != null ? blocked.exitCode : 1, error: blocked.cause || null },
    generatedArtifacts: [],
    stateChanges: null,
    cleanupResetResult: 'not-applicable',
    finalClassification: 'BLOCK',
    naReason: null,
    // Report extras.
    result: taskInfo.result || 'BLOCK',
    classification: taskInfo.classification || blocked.classification || null,
    cause: taskInfo.cause || blocked.cause || null,
    repairHistory: [],
    manualIntervention: null,
    protectedStartHash: null,
    protectedEndHash: null
  };

  try {
    cfg.fs.mkdirSync(taskDir, { recursive: true });
    cfg.fs.writeFileSync(path.join(taskDir, 'record.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (e) {
    return;
  }
  // Patch index.json to register the blocked task so generateReport finds it.
  var indexPath = path.join(root, 'index.json');
  var idx;
  try {
    idx = JSON.parse(cfg.fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return;
  }
  if (!idx.tasks) idx.tasks = {};
  if (!idx.tasks[taskId]) idx.tasks[taskId] = [];
  // Avoid duplicates.
  var exists = idx.tasks[taskId].some(function(e) { return e && e.path === taskId + '/record.json'; });
  if (!exists) {
    var crypto = require('node:crypto');
    var content = JSON.stringify(record, null, 2) + '\n';
    var hash = crypto.createHash('sha256').update(content).digest('hex');
    idx.tasks[taskId].push({ path: taskId + '/record.json', sha256: hash, kind: 'record', timestamp: new Date().toISOString() });
    try {
      cfg.fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
    } catch (e2) {}
  }
}

/**
 * A dependent readiness task (CAN-B1-03 / CAN-B1-04) that must not run after
 * a failed seed. It is surfaced as a BLOCK stage carrying the seed
 * classification and the note "not executed: seed failed" so the run still
 * records the task as blocked and forces a non-zero exit, never a PASS.
 */
function buildBlockedStageForSeed(stage, seed) {
  const blocked = {
    name: stage.name,
    flag: stage.flag,
    command: null,
    args: [],
    exitCode: PIPELINE_DEFECT_EXIT,
    classification: (seed && seed.classification) || CLASS_PIPELINE_DEFECT,
    cause: 'not executed: seed failed',
    seedReason: (seed && seed.reason) || null,
    summary: {
      schemaVersion: '1.0',
      runId: null,
      counts: {},
      tasks: [{
        taskId: stage.value,
        stage: stage.name,
        result: 'BLOCK',
        classification: (seed && seed.classification) || CLASS_PIPELINE_DEFECT,
        cause: 'not executed: seed failed'
      }]
    }
  };
  return blocked;
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

function writeAggregatedSummary(cfg, preflight, stages, seed) {
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
  // Collect any actual integer-error note from the seed evidence.  Unique strings only.
  var seedNotes = [];
  var REPAIR_NOTE = "repair required: Shop API products list fails server-side (Postgres: product.id != $3 with $3='undefined'); in-scope target-application defect (TARGET_APP_DEFECT).";
  var noteSeen = {};
  function note(pushCandidate) {
    if (typeof pushCandidate !== 'string' || pushCandidate === '') return;
    if (noteSeen[pushCandidate]) return;
    noteSeen[pushCandidate] = true;
    seedNotes.push(pushCandidate);
  }
  if (seed && seed.errors && Array.isArray(seed.errors)) {
    seed.errors.forEach(function(e) {
      if (typeof e === 'string' && e.indexOf('invalid input syntax for type integer') !== -1) {
        note(REPAIR_NOTE);
      }
    });
  }
  // Also check the readback errors (which carry the staging-specific integer error).
  if (seed && seed.blocked) {
    seed.blocked.forEach(function(b) {
      if (b.error && b.error.indexOf && b.error.indexOf('invalid input syntax for type integer') !== -1) {
        note(REPAIR_NOTE);
      }
    });
  }
  // Keep all seed fields intact except override failed/blocked to counts for the
  // public record.  hasOtherSeedFailure (called before this function) reads
  // seed.failed and seed.blocked directly as arrays; those are unchanged here.
  var seedForSummary = seed
    ? { ...seed,
        failed: Array.isArray(seed.failed) ? seed.failed.length
          : (typeof seed.failed === 'number' ? seed.failed : 0),
        blocked: Array.isArray(seed.blocked) ? seed.blocked.length
          : (typeof seed.blocked === 'number' ? seed.blocked : 0),
        blockedEntries: seed.blocked || [] }
    : undefined;
  const summary = {
    schemaVersion: '1.0',
    runId: cfg.runId,
    mode: cfg.mode,
    startedAt: preflight.checkedAt,
    completedAt: new Date().toISOString(),
    preflightOk: preflight.ok === true,
    anyPipelineDefect: anyDefect,
    seed: seedForSummary,
    stages: stageRows,
    tasks: allTasks,
    notes: seedNotes
  };
  const file = path.join(outDir, 'run-summary.json');
  try {
    cfg.fs.mkdirSync(outDir, { recursive: true });
    cfg.fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  } catch (e) {}
  return summary;
}

function archiveRun(cfg, runId, runIdSource, preflight, stages, seed) {
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
    seed: seed || undefined,
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
 * Run the staging seeder in this process (not as a child task). Builds the
 * same admin env mapping the child tasks receive (never printing values),
 * calls seedStaging(context, options) once, and reduces the outcome to the
 * summary counts recorded in run-summary.json / run.json. A seeder failure
 * must never abort the run.
 */
function runSeedStep(cfg, seedModule) {
  var childEnv = buildChildEnv(cfg);
  var context = {
    env: childEnv,
    runId: cfg.runId,
    stagingUrl: cfg.stagingUrl,
    shopApiUrl: cfg.shopApiUrl,
    cwd: cfg.cwd,
    deps: {
      fetch: cfg.fetch,
      clock: function() { return new Date(); },
      getEnv: function() { return childEnv; },
      evidenceOptions: function() {
        return { root: cfg.cwd, baseDir: 'evidence', reuseExisting: true };
      }
    }
  };
  return seedModule.seedStaging(context, { dryRun: !!cfg.seedDryRun }).then(function(result) {
    var seed = applySeedClassification({
      ran: true,
      dryRun: !!cfg.seedDryRun,
      ok: !!(result && result.ok),
      reason: (result && result.reason) || null,
      error: (result && typeof result.error === 'string') ? result.error : null,
      created: (result && Array.isArray(result.created)) ? result.created.length : 0,
      existing: (result && Array.isArray(result.existing)) ? result.existing.length : 0,
      conflicts: (result && Array.isArray(result.conflicts)) ? result.conflicts.length : 0,
      errors: (result && Array.isArray(result.errors)) ? result.errors : [],
      failed: (result && Array.isArray(result.failed)) ? result.failed : [],
    });
    // Persist the derived classification/cause onto the seed evidence so the
    // compliance report's seed row shows the same classification as the
    // run-summary notes (SEED_FAILED only for real pipeline seed failures).
    writeSeedClassificationEvidence(cfg, seed);
    return seed;
  }, function(err) {
    var seed = applySeedClassification({
      ran: true,
      dryRun: !!cfg.seedDryRun,
      ok: false,
      reason: 'SEED_THREW',
      error: (err && err.message) || String(err),
      created: 0,
      existing: 0,
      conflicts: 0,
      failed: [],
      errors: [(err && err.message) || String(err)]
    });
    writeSeedClassificationEvidence(cfg, seed);
    return seed;
  });
}

/**
 * Merge the pipeline-derived seed classification/cause back into the evidence
 * seed record (evidence/<runId>/seed/seed-record.json) so generateReport's
 * seed row uses the same classification as run-summary.json.  Never removes
 * existing fields; only adds classification/cause.
 */
function writeSeedClassificationEvidence(cfg, seed) {
  if (!seed || !cfg || !cfg.cwd || !cfg.runId) return;
  var file = path.join(cfg.cwd, 'evidence', cfg.runId, 'seed', 'seed-record.json');
  if (!cfg.fs.existsSync(file)) return;
  try {
    var record = JSON.parse(cfg.fs.readFileSync(file, 'utf8'));
    record.classification = seed.classification != null ? seed.classification : record.classification;
    record.cause = seed.cause != null ? seed.cause : record.cause;
    rewriteEvidenceEntry(cfg, 'seed', 'seed-record.json', record);
  } catch (e) {}
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

  // Optional staging seed: run once after preflight passes and BEFORE the
  // task stages. Its failure never aborts the run; the tasks then block with
  // their own evidence. The seed is not a task and does not change the
  // task-selection checks or stage order.
  let seed = null;
  if (cfg.mode === MODE_FULL && preflightOk && cfg.seedTestData) {
    let seedModule = null;
    try {
      seedModule = require('../src/staging/seedStaging.js');
    } catch (e) {
      seed = applySeedClassification({ ran: true, ok: false, reason: 'SEED_MODULE_UNAVAILABLE', error: (e && e.message) || String(e), created: 0, existing: 0, conflicts: 0, failed: 0, errors: [(e && e.message) || String(e)] });
    }
    if (seedModule) {
      seed = await runSeedStep(cfg, seedModule);
    }
  }


  let stages = [];
  let executionRevision;
  if (cfg.mode === MODE_FULL && preflightOk) {
    // Initialize the evidence directory and index.json before any task stage
    // runs or gets blocked. The blocked-task evidence writer reads this index;
    // a missing index causes it to silently skip and the blocked task would show
    // MISSING_EVIDENCE in the report.
    try {
      evidenceCollector.initEvidenceIndex(cfg.runId, {}, { root: cfg.cwd, baseDir: 'evidence', reuseExisting: true });
    } catch (e) {}
    const planned = buildStagesForTaskIds(cfg.taskIds);
    // only the dry-run task may still run; the two dependent readiness tasks are
    // surfaced as BLOCK stages. CAN-B2-16 (dry run, no staging dependency) may
    // still run even when the seed failed. A partial seed that only failed on
    // customer creation (e.g. no SEED_TEST_CUSTOMER_PASSWORD) ran successfully and
    // created channels, products, etc. - the dependent tasks can still run if their
    // required fixtures are present.
    var seedFailed = !!(seed && !seed.ok) && cfg.seedTestData;
    // seedHasOnlyCustomerBlock: true when the seed ran (seed.ok=false) but the
    // ONLY blocked entity is customer (e.g. no explicit SEED_TEST_CUSTOMER_PASSWORD,
    // HMAC derivation worked, but customer creation failed for other reasons). In this
    // case the catalog steps ran successfully and dependent tasks can still run.
    // When seed.blocked is empty (login failure, network error, etc.) or has a
    // non-customer entity blocked, tasks must not run.
    var seedHasOnlyCustomerBlock = seedFailed && seed && seed.blocked &&
      seed.blocked.length > 0 &&
      seed.blocked.every(function(b) { return b.entity === 'customer'; });
    // seedHasOnlyAppDefect: the ONLY seed failure is the client-ruled
    // target-application Shop API products-list integer error.  The catalog
    // was seeded (products/variants created); the failure is the readback of
    // that catalog, so the dependent readiness tasks CAN-B1-03/CAN-B1-04 can
    // still run -- each records the integer error from its own request and is
    // classified on its own evidence, and the dry-run task runs as usual.
    var seedHasOnlyAppDefect = seedFailed && seed && seed.classification === CLASS_TARGET_APP_DEFECT;
    // seedCanProvideFixtures: true when seed hasn't failed, OR when it only
    // failed on customer (catalog steps ran and created fixtures), OR when the
    // only failure is the target-app products-list defect (catalog created).
    var seedCanProvideFixtures = !seedFailed || seedHasOnlyCustomerBlock || seedHasOnlyAppDefect;
    for (let i = 0; i < planned.length; i += 1) {
      const p = planned[i];
      // Tasks run when the seed provided fixtures (successful or customer-only block).
      // CAN-B2-16 (dry run) always runs when preflight passes. Other tasks only
      // run when seedCanProvideFixtures is true.
      if (seedCanProvideFixtures || p.value === DRY_RUN_TASK.taskId) {
        stages.push(runStage(cfg, p));
      } else {
        var blocked = buildBlockedStageForSeed(p, seed);
        stages.push(blocked);
        // Cache git head once before the blocked-task evidence loop.
        if (executionRevision === undefined) {
          var gh = checkGitHead(cfg);
          executionRevision = gh.ok ? gh.value : null;
        }
        writeBlockedTaskEvidence(cfg, blocked, executionRevision);
      }
    }
  }

  writeAggregatedSummary(cfg, preflight, stages, seed);

  const resolved = resolvePipelineRunId(cfg);
  const archived = archiveRun(cfg, resolved.runId, resolved.source, preflight, stages, seed);

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
  runStage,
  AUTHORIZED_TASK_IDS,
  DRY_RUN_TASK,
  DEFAULT_ARCHIVE_ROOT,
  DEFAULT_MODE,
  DEFAULT_TASK,
  VALID_MODES,
  INVALID_MODE_EXIT,
  PIPELINE_DEFECT_EXIT,
  validateMode,
  classifySeedFailure,
  applySeedClassification,
  runSeedStep,
  buildBlockedStageForSeed,
  classifyStage,
  CLASS_DEPENDENCY,
  CLASS_CLIENT_INPUT,
  CLASS_PIPELINE_DEFECT
};
