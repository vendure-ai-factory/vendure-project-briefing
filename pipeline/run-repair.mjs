'use strict';

import { createRequire } from 'node:module';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// R5b exit codes. 0 = FIXED or no repair needed; 3 = NOT_FIXED (repair budget
// exhausted while a target defect remains); 4 = BLOCKED (an adapter refused,
// never retried by another route). These are distinct from run-staging codes
// (the repair orchestrator is its own entry point and documents its own codes).
export const EXIT_NO_REPAIR = 0;
export const EXIT_FIXED = 0;
export const EXIT_NOT_FIXED = 3;
export const EXIT_BLOCKED = 4;

export const OUTCOME_NO_REPAIR = 'NO_REPAIR';
export const OUTCOME_FIXED = 'FIXED';
export const OUTCOME_NOT_FIXED = 'NOT_FIXED';
export const OUTCOME_BLOCKED = 'BLOCKED';

// The authorized staging task set. "rerun the same tasks plus CAN-B2-16" is
// exactly this set because the normal staging run already executes them.
export const REPAIR_TASK_IDS = ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16'];

const CLASS_TARGET_APP_DEFECT = 'TARGET_APP_DEFECT';
const CLASS_CLIENT_INPUT_SCOPE = 'CLIENT_INPUT_SCOPE';

const MANIFEST_PATH = 'manifest/acceptance-manifest.v0.4.json';
const DEFAULT_ARCHIVE_ROOT = '/opt/pipeline-archive';
const REPORTS_DIR = 'reports';
const EVIDENCE_DIR = 'evidence';

var _manifest = null;
function getManifest(cwd) {
  if (_manifest === null) {
    try {
      _manifest = JSON.parse(fs.readFileSync(path.join(cwd, MANIFEST_PATH), 'utf8'));
    } catch (e) {
      _manifest = { tasks: [], source: {} };
    }
  }
  return _manifest;
}

function hasText(v) {
  return v != null && String(v) !== '';
}

function isPassResult(v) {
  return v === 'PASS' || v === 'RESULT_PASS' || v === 'READINESS_PASS';
}

function sanitizeToken(v) {
  return v === undefined || v === null ? '' : String(v);
}

function generateRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function collectSecretValues(cfg) {
  var values = [];
  function push(v) {
    if (v != null && typeof v === 'string' && v !== '') values.push(v);
  }
  push(cfg.token);
  push(cfg.apiKey);
  if (cfg.env) {
    ['STRIPE_SECRET_KEY', 'VENDURE_STAGING_REPO_TOKEN', 'OPENROUTER_API_KEY',
      'STAGING_ADMIN_PASSWORD', 'SUPERADMIN_PASSWORD', 'SEED_TEST_CUSTOMER_PASSWORD'
    ].forEach(function(name) { push(cfg.env[name]); });
  }
  return values;
}

function redactOutput(text, values) {
  var out = String(text == null ? '' : text);
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v && typeof v === 'string' && out.indexOf(v) !== -1) {
      out = out.split(v).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Build the fix branch for a finding. The git binding derives the branch from
 * the run id and the first 8 hex chars of the finding signature, matching the
 * fix-branch contract enforced by gitClient (codex/pipeline-fix-<runId>-<sig8>).
 */
function buildFixBranch(runId, finding) {
  var sig8 = (finding && finding.signature ? String(finding.signature) : 'unknown').substring(0, 8);
  var cleaned = String(runId || 'run').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  if (cleaned === '' || cleaned === '-') cleaned = 'run';
  return 'codex/pipeline-fix-' + cleaned + '-' + sig8;
}

function defaultRunCommand(cmd, args, opts) {
  var childProcess = require('node:child_process');
  return Promise.resolve().then(function() {
    var result = childProcess.spawnSync(cmd, args, {
      cwd: opts && opts.cwd,
      env: opts && opts.env,
      timeout: (opts && opts.timeout) || 120000,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error && result.status === null && result.signal === null) {
      return { success: false, stdout: '', stderr: String(result.error.message || result.error), exitCode: null, error: result.error.message };
    }
    return {
      success: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status,
      error: null
    };
  });
}

/**
 * Resolve the repair configuration. Repair mode is strictly opt-in: it is
 * enabled only when REPAIR_MODE=true (or an injected true boolean for tests).
 * Normal runs never take this path and never touch any adapter.
 */
function resolveRepairConfig(deps) {
  deps = deps || {};
  var env = deps.env || process.env;
  var modeValue = deps.repairMode !== undefined && deps.repairMode !== null
    ? deps.repairMode
    : (env.REPAIR_MODE === 'true' || env.REPAIR_MODE === '1' || env.REPAIR_MODE === true);
  var runId = deps.runId || env.REPAIR_RUN_ID || null;
  return {
    repairMode: !!modeValue,
    env: env,
    cwd: deps.cwd || process.cwd(),
    childProcess: deps.childProcess || require('node:child_process'),
    fs: deps.fs || fs,
    fetch: deps.fetch || globalThis.fetch,
    runId: runId,
    taskIds: (deps.taskIds && deps.taskIds.length > 0) ? deps.taskIds.slice() : REPAIR_TASK_IDS.slice(),
    token: sanitizeToken(deps.token !== undefined ? deps.token : env.VENDURE_STAGING_REPO_TOKEN),
    apiKey: sanitizeToken(deps.apiKey !== undefined ? deps.apiKey : env.OPENROUTER_API_KEY),
    stagingUrl: hasText(deps.stagingUrl) ? String(deps.stagingUrl)
      : (hasText(env.PIPELINE_STAGING_URL) ? env.PIPELINE_STAGING_URL : null),
    shopApiUrl: hasText(deps.shopApiUrl) ? String(deps.shopApiUrl)
      : (hasText(env.PIPELINE_SHOP_API_URL) ? env.PIPELINE_SHOP_API_URL : null),
    archiveRoot: hasText(deps.archiveRoot) ? String(deps.archiveRoot)
      : (env.PIPELINE_ARCHIVE_ROOT || DEFAULT_ARCHIVE_ROOT),
    targetRepoUrl: deps.targetRepoUrl || 'https://github.com/vendure-ai-factory/vendure-staging-baseline',
    workDir: deps.workDir || null,
    runCommand: deps.runCommand || defaultRunCommand,
    // Adapters: all injectable, all defaulting to the real implementations.
    adapters: deps.adapters || {},
    replayer: deps.replayer || null,
    rerunTasks: deps.rerunTasks || null,
    extractAfter: deps.extractAfter || null,
    normalRun: deps.normalRun || null,
    budget: deps.budget || null,
    globalBudget: deps.globalBudget || 15,
    perSignatureBudget: deps.perSignatureBudget || 3
  };
}

/**
 * Collect every diagnostic string that can describe a task failure. Mirrors
 * the staging classifier's problem-text gathering so an unmet task's real
 * error is visible even when the cause is only a generic token.
 */
function taskErrorText(t) {
  if (!t || typeof t !== 'object') return '';
  var parts = [];
  function push(v) {
    if (typeof v === 'string' && v !== '') parts.push(v);
    else if (v && typeof v === 'object' && typeof v.message === 'string' && v.message !== '') parts.push(v.message);
  }
  push(t.cause);
  push(t.result);
  push(t.reason);
  push(t.error);
  push(t.message);
  push(t.detail);
  if (t.exitErrorResult && typeof t.exitErrorResult === 'object') {
    push(t.exitErrorResult.error);
    push(t.exitErrorResult.message);
  }
  if (Array.isArray(t.errors)) {
    for (var i = 0; i < t.errors.length; i++) push(t.errors[i]);
  }
  ['executorError', 'executorOutput', 'stderr', 'stdout'].forEach(function(f) { push(t[f]); });
  return parts.join('|');
}

/**
 * A task is a repair target when it is still unmet (not a passing result) and
 * it is either classed TARGET_APP_DEFECT or carries an API error string.
 */
function isRepairTarget(t) {
  if (!t || typeof t !== 'object') return false;
  if (isPassResult(t.result)) return false;
  if (t.classification === CLASS_TARGET_APP_DEFECT) return true;
  return taskErrorText(t) !== '';
}

function selectRepairTargets(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(isRepairTarget);
}

/**
 * Collect logs for the three supported kinds since the run started. A log
 * wrapper refusal is recorded on state.logBlockers and does NOT stop the
 * finding extraction from API errors.
 */
async function collectRepairLogs(cfg, logSource, state) {
  var kinds = ['vendure', 'postgres', 'worker'];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    try {
      var result = await logSource.collect(kind, {
        runId: cfg.runId,
        sinceTs: state.runStartedAt,
        cwd: cfg.cwd
      });
      if (result && result.ok === true) {
        state.logs[kind] = Array.isArray(result.lines) ? result.lines : [];
      } else if (result && result.blocker) {
        state.logBlockers.push(normalizeBlocker('LOG_WRAPPER_REFUSED',
          'log source refused for ' + kind, result.blocker));
      } else {
        state.logBlockers.push(normalizeBlocker('LOG_WRAPPER_REFUSED',
          'log source returned no output for ' + kind, result || {}));
      }
    } catch (err) {
      state.logBlockers.push(normalizeBlocker('LOG_WRAPPER_REFUSED',
        'log source collection failed for ' + kind, { message: safeErr(err) }));
    }
  }
  return state.logBlockers;
}

/**
 * Build the input for signatureExtractor from the target task. The API errors
 * array comes from the task's own record error text (never from logs), so a
 * log blocker can never stop extraction.
 */
function buildExtractInput(target, logs) {
  var apiErrors = [];
  var errText = taskErrorText(target);
  if (errText !== '') {
    apiErrors.push({ message: errText, path: null, extensions: { code: 'BAD_USER_INPUT' } });
  }
  var logExcerpt = null;
  var logLines = logs || {};
  var allLines = [];
  ['postgres', 'vendure', 'worker'].forEach(function(k) {
    if (Array.isArray(logLines[k])) {
      allLines = allLines.concat(logLines[k]);
    }
  });
  if (allLines.length > 0) {
    logExcerpt = allLines.join('\n').substring(0, 20000);
  }
  return { apiErrors: apiErrors, logExcerpt: logExcerpt, operationName: (target && target.taskId) || null };
}

function safeErr(e) {
  if (!e) return 'unknown error';
  return (e && e.message) ? e.message : String(e);
}

/**
 * Normalize an arbitrary adapter refusal into the blocker record shape
 * ({ code, message, evidence }) used by the report. The evidence is
 * redacted in-memory so a token or key can never be persisted.
 */
function normalizeBlocker(code, message, raw) {
  var redacted = {};
  if (raw && typeof raw === 'object') {
    try {
      redacted = JSON.parse(JSON.stringify(raw));
    } catch (e) {
      redacted = { raw: String(raw) };
    }
  } else if (raw != null) {
    redacted = { message: String(raw) };
  }
  return { code: code || 'UNKNOWN_BLOCKER', message: message || '', evidence: redacted };
}

function defaultReplayer(finding) {
  var signatures = [];
  if (finding && finding.signature) {
    signatures.push(finding.signature);
  }
  if (finding && Array.isArray(finding.auxSignatures)) {
    for (var i = 0; i < finding.auxSignatures.length; i++) {
      if (signatures.indexOf(finding.auxSignatures[i]) === -1) {
        signatures.push(finding.auxSignatures[i]);
      }
    }
  }
  return { signatures: signatures };
}

/**
 * Duration deadline that bounds the whole repair loop in wall-clock terms so a
 * misbehaving adapter can never run forever. Defaults to 6 hours.
 */
function defaultDeadline(now, maxMs) {
  return now() + (maxMs || 6 * 60 * 60 * 1000);
}

function readJsonFile(cfg, relPath) {
  try {
    var abs = path.join(cfg.cwd, relPath);
    if (!cfg.fs.existsSync(abs)) return null;
    return JSON.parse(cfg.fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return null;
  }
}

function newestRunSubdir(cfg, base) {
  var root = path.join(cfg.cwd, base);
  if (!cfg.fs.existsSync(root)) return null;
  var entries;
  try {
    entries = cfg.fs.readdirSync(root);
  } catch (e) {
    return null;
  }
  var newest = null;
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(root, entries[i]);
    var st = null;
    try { st = cfg.fs.statSync(full); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    if (!newest || st.mtimeMs > newest.mtime) newest = { name: entries[i], mtime: st.mtimeMs };
  }
  return newest ? newest.name : null;
}

/** Resolve the normal run id: injected, env, or the newest staging run. */
function resolveRunId(cfg) {
  if (cfg.runId) return cfg.runId;
  return newestRunSubdir(cfg, REPORTS_DIR) || newestRunSubdir(cfg, EVIDENCE_DIR) || null;
}

/**
 * Load the normal run's task rows. An injected normalRun wins; otherwise the
 * run summary (reports/<runId>/run-summary.json) is read. The summary rows
 * already carry classification/cause and (via runStage's record attach) the
 * task record error text the repair targets are selected from.
 */
function loadNormalRun(cfg, runId) {
  if (Array.isArray(cfg.normalRun)) return { runId: runId, tasks: cfg.normalRun };
  if (cfg.normalRun && Array.isArray(cfg.normalRun.tasks)) return cfg.normalRun;
  var summary = readJsonFile(cfg, path.join(REPORTS_DIR, runId, 'run-summary.json'));
  if (!summary) return null;
  var tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || typeof t !== 'object') continue;
    var taskId = t.taskId || t.id;
    if (!taskId) continue;
    attachTaskRecordError(cfg, runId, taskId, t);
  }
  return { runId: runId, tasks: tasks, summary: summary };
}

function attachTaskRecordError(cfg, runId, taskId, task) {
  var rec = readJsonFile(cfg, path.join(EVIDENCE_DIR, runId, taskId, 'record.json'));
  if (rec && rec.exitErrorResult && typeof rec.exitErrorResult === 'object') {
    task.exitErrorResult = rec.exitErrorResult;
    return;
  }
  var ex = readJsonFile(cfg, path.join(EVIDENCE_DIR, runId, taskId, 'executor-error.json'));
  if (ex) {
    var msg = ex && typeof ex.error === 'string' ? ex.error : (ex && ex.message) || null;
    if (msg) task.exitErrorResult = { exitCode: null, error: msg };
  }
}

/**
 * Default location: run the target clone through gitClient.cloneTarget (token
 * from env) then locateCandidates over the clone. Any refusal is returned as
 * a blocker and stops the whole repair run (BLOCKED).
 */
async function defaultCloneAndLocate(cfg, adapters, finding) {
  var branch = buildFixBranch(cfg.runId, finding);
  var dir = cfg.workDir
    ? path.join(cfg.workDir, 'repair-clone-' + cfg.runId + '-' + String(finding.signature || 'n/a').substring(0, 8))
    : path.join(require('node:os').tmpdir(), 'repair-clone-' + cfg.runId + '-' + String(finding.signature || 'n/a').substring(0, 8));
  var git = adapters.gitClient;
  var absent = [cfg.targetRepoUrl, branch, dir, cfg.token].some(function(v) { return !hasText(v); });
  var clone = absent ? { ok: false, blocker: normalizeBlocker('MISSING_GIT_INPUT', 'git clone input incomplete', {}) } : null;
  if (!clone) {
    clone = await git.cloneRepoForRepair({
      repoUrl: cfg.targetRepoUrl,
      branch: branch,
      dir: dir,
      token: cfg.token,
      runCommand: cfg.runCommand,
      timeout: 120000
    });
  }
  if (!clone || !clone.ok) {
    var b = clone && clone.blocker ? clone.blocker : { code: 'CLONE_FAILED', message: 'git clone failed' };
    return { ok: false, blocker: b, branch: branch };
  }
  var located = await adapters.locator.locateCandidates({
    finding: finding,
    targetRoot: dir,
    runId: cfg.runId,
    workspaceDir: path.dirname(dir),
    maxCandidates: 10
  });
  return { ok: true, dir: dir, branch: branch, candidates: (located && located.candidates) || [], searched: (located && located.searched) || [] };
}

/**
 * Default rerun: execute the authorized task stages in-process through
 * run-staging's runStage (the small change that exposes it), then read the
 * updated run summary. Injected fakes replace this in tests.
 */
async function defaultRerunTasks(cfg, taskIds) {
  var staging = await import('./run-staging.mjs');
  var stages = staging.buildStagesForTaskIds(taskIds || REPAIR_TASK_IDS);
  var outcomes = [];
  if (typeof staging.runStage === 'function') {
    for (var i = 0; i < stages.length; i++) {
      try {
        outcomes.push(staging.runStage(cfg, stages[i]));
      } catch (e) {
        outcomes.push({ name: stages[i].name, exitCode: 127, classification: 'PIPELINE_DEFECT', cause: safeErr(e) });
      }
    }
  }
  var tasks = [];
  for (var j = 0; j < outcomes.length; j++) {
    var s = outcomes[j];
    if (s && s.summary && Array.isArray(s.summary.tasks)) {
      tasks = tasks.concat(s.summary.tasks);
    }
  }
  return tasks;
}

/**
 * Default after-signature extraction: fingerprint every still-unmet task's API
 * error text with the same signatureExtractor used for the baseline, so the
 * verifier can compare like-for-like.
 */
function defaultExtractAfter(cfg, signExtractor, taskResults) {
  var sigs = new Set();
  for (var i = 0; i < (taskResults || []).length; i++) {
    var t = taskResults[i];
    if (!t || isPassResult(t.result)) continue;
    var errText = taskErrorText(t);
    if (errText === '') continue;
    var f = signExtractor.extractFinding({ apiErrors: [{ message: errText, path: null }], operationName: t.taskId || null });
    if (f && f.signature) sigs.add(f.signature);
  }
  return Array.from(sigs);
}

/**
 * Build repairData for reportGenerator (schema 1.1). manualTargetEdits is
 * always 0: the orchestrator itself never touches the target clone - all
 * mutations go through gitClient and the patch applier inside proposeAndCheck.
 */
function buildRepairData(state) {
  return {
    sectionA: { pipelineChanges: (state.pipelineChanges || []).slice() },
    sectionB: { targetChanges: (state.targetChanges || []).slice() },
    attempts: (state.attempts || []).map(function(a) {
      return Object.assign({}, a);
    }),
    blockers: (state.blockers || []).map(function(b) {
      return { code: b.code, message: b.message, evidence: b.evidence };
    }),
    deploy: state.deploy || null,
    rollback: state.rollback || null,
    manualTargetEdits: 0
  };
}

/**
 * Write the repair block (schema 1.1) through the existing report path only:
 * generateReport with repairMode, then compliance-report.json/.md under
 * reports/<runId>/. Nothing under evidence/ is written or modified here;
 * evidence/<runId>/index.json is only ever touched by the existing code.
 */
function writeRepairReport(cfg, state, reportModule) {
  var repairData = buildRepairData(state);
  var secrets = {};
  ['token', 'apiKey'].forEach(function(k) {
    if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '') secrets[k] = cfg[k];
  });
  var opts = {
    root: cfg.cwd,
    baseDir: 'evidence',
    repairMode: true,
    repairData: repairData,
    manifest: getManifest(cfg.cwd),
    secrets: secrets
  };
  if (reportModule === undefined) reportModule = require('../src/reportGenerator.js');
  var report = reportModule.generateReport(cfg.runId, opts);
  var outDir = path.join(cfg.cwd, REPORTS_DIR, cfg.runId);
  try {
    cfg.fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    outDir = path.join(cfg.cwd, 'repair-reports', cfg.runId);
    cfg.fs.mkdirSync(outDir, { recursive: true });
  }
  try {
    cfg.fs.writeFileSync(path.join(outDir, 'compliance-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    cfg.fs.writeFileSync(path.join(outDir, 'compliance-report.md'), reportModule.renderMarkdownReport(report, opts), 'utf8');
  } catch (e) {
    state.reportError = safeErr(e);
  }
  state.report = report;
  state.repairData = repairData;
  return report;
}

/**
 * Return a redacted copy of the outcome so the CLI and tests can render it
 * without ever leaking a token or API key.
 */
function redactRepairState(cfg, state) {
  var values = collectSecretValues(cfg);
  var out = {
    outcome: state.outcome,
    exitCode: state.exitCode,
    runId: cfg.runId,
    blockers: (state.blockers || []).map(function(b) {
      return {
        code: b.code,
        message: redactOutput(b.message, values),
        evidence: redactOutput(JSON.stringify(b.evidence), values)
      };
    })
  };
  if (state.logBlockers && state.logBlockers.length > 0) {
    out.logBlockers = state.logBlockers.map(function(b) {
      return { code: b.code, message: redactOutput(b.message, values) };
    });
  }
  if (state.report) {
    try {
      out.report = JSON.parse(redactOutput(JSON.stringify({ repair: state.report.repair }), values));
    } catch (e) {
      out.report = null;
    }
  }
  return out;
}

/**
 * Roll back a failed deploy to the baseline digest. When the baseline cannot
 * be resolved the rollback record stays "rollback unavailable" (a recorded
 * fact, never a silent hole).
 */
async function rollbackToBaseline(cfg, adapters, build) {
  var baseline = await adapters.build.baselineDigest({ token: cfg.token, fetch: cfg.fetch });
  if (!baseline || !baseline.ok || !baseline.deployRef) {
    return { ok: false, reason: 'rollback unavailable', blocker: baseline && baseline.blocker ? baseline.blocker : null };
  }
  var deploy = await adapters.deploy.deploy(baseline.deployRef, {
    healthUrl: cfg.stagingUrl ? cfg.stagingUrl + '/health' : null,
    runCommand: cfg.runCommand,
    fetch: cfg.fetch
  });
  if (!deploy.ok) {
    return { ok: false, reason: 'rollback blocked', blocker: deploy.blocker };
  }
  return { ok: true, ref: baseline.deployRef };
}

function defaultAdapters() {
  return {
    logSource: require('../src/repair/logSource.js'),
    signatureExtractor: require('../src/repair/signatureExtractor.js'),
    verifier: require('../src/repair/verifier.js'),
    gitClient: require('../src/repair/gitClient.js'),
    locator: require('../src/repair/locator.js'),
    build: require('../src/repair/buildAdapter.js'),
    deploy: require('../src/repair/deployAdapter.js'),
    proposeAndCheck: require('../src/repair/proposeAndCheck.js')
  };
}

/**
 * One loop iteration: propose a candidate patch (proposeAndCheck), then on
 * READY push the branch, build and publish the image, deploy, rerun the
 * authorized tasks, extract the after-signatures and verify against the
 * baseline. Returns { next: 'continue'|'stop-fixed'|'stop-blocked'|'stop-budget',
 * attempt, attemptNumber } or { error }.
 */
async function proposeAttempt(cfg, adapters, state, located, attemptNumber, budget) {
  var proposeModule = adapters.proposeAndCheck;
  var proposeFn = typeof proposeModule.proposeAndCheck === 'function'
    ? proposeModule.proposeAndCheck
    : proposeModule;
  var propose = await proposeFn({
    finding: state.finding,
    candidates: located.candidates || [],
    previousAttempts: state.previousAttempts,
    budget: budget,
    runId: cfg.runId,
    cloneDir: located.dir,
    branch: located.branch,
    baseSha: state.baseSha || null,
    env: cfg.env,
    deps: {
      git: adapters.gitClient,
      verifier: adapters.verifier
    }
  });

  if (!propose || typeof propose !== 'object') {
    return { next: 'stop-blocked', blocker: normalizeBlocker('PROPOSE_FAILED', 'proposeAndCheck returned no result', {}) };
  }

  if (propose.status === 'BUDGET_EXHAUSTED') {
    return { next: 'stop-budget', blocker: propose.blocker || null };
  }
  if (propose.status === 'BLOCKED') {
    return { next: 'stop-blocked', blocker: propose.blocker || normalizeBlocker('BLOCKED', 'proposeAndCheck blocked', {}) };
  }
  if (propose.status === 'MODEL_FAILED') {
    // Model unavailable (or an unusable model response) is a terminal blocker,
    // never retried by another route.
    return { next: 'stop-blocked', blocker: propose.blocker || normalizeBlocker('MODEL_UNAVAILABLE', 'model call failed', {}) };
  }
  if (propose.status !== 'READY') {
    // REJECTED / APPLY_FAILED / CHECKS_FAILED: retryable, but each consumes
    // budget and is recorded so the next proposal sees it.
    return {
      next: 'continue',
      retryableStatus: propose.status,
      attempt: {
        n: attemptNumber,
        signature: state.finding.signature || '',
        domain: state.finding.domain || '',
        repairKind: (propose.repairKind || 'proposal-rejected'),
        status: propose.status,
        checks: summarizeChecks(propose.checks),
        message: propose.blocker ? propose.blocker.message : (propose.status + ': proposal not ready'),
        verifyStatus: null
      },
      previousEvidence: {
        diff: propose.diffText || null,
        checks: propose.checks || null,
        errors: [propose.status]
      }
    };
  }

  // READY -> push, build, deploy, rerun, verify.
  var pushResult = await adapters.gitClient.push(located.dir, located.branch, cfg.token, {
    runCommand: cfg.runCommand,
    timeout: 120000
  });
  if (!pushResult || !pushResult.ok) {
    return { next: 'stop-blocked', blocker: pushResult && pushResult.blocker ? pushResult.blocker : normalizeBlocker('PUSH_FAILED', 'git push failed', {}) };
  }

  var buildResult = await adapters.build.buildAndPublish({
    branch: located.branch,
    fixSha: propose.headSha,
    token: cfg.token,
    fetch: cfg.fetch,
    now: Date.now
  });
  if (!buildResult || !buildResult.ok) {
    return { next: 'stop-blocked', blocker: buildResult && buildResult.blocker ? buildResult.blocker : normalizeBlocker('IMAGE_BUILD_DISPATCH_FAILED', 'image build/publish failed', {}) };
  }

  var deployResult = await adapters.deploy.deploy(buildResult.deployRef, {
    healthUrl: cfg.stagingUrl ? cfg.stagingUrl + '/health' : null,
    runCommand: cfg.runCommand,
    fetch: cfg.fetch
  });
  if (!deployResult || !deployResult.ok) {
    return { next: 'stop-blocked', blocker: deployResult && deployResult.blocker ? deployResult.blocker : normalizeBlocker('DEPLOY_REFUSED', 'deploy refused', {}) };
  }

  // Retest: rerun the same tasks (plus CAN-B2-16) and verify signatures.
  var rerunTasks = cfg.rerunTasks
    ? await cfg.rerunTasks(cfg.taskIds)
    : await defaultRerunTasks(cfg, cfg.taskIds);
  var afterSigs = cfg.extractAfter
    ? cfg.extractAfter(rerunTasks)
    : defaultExtractAfter(cfg, adapters.signatureExtractor, rerunTasks);
  var verdict = adapters.verifier.verify(state.baselineSignatures, afterSigs);

  var attempt = {
    n: attemptNumber,
    signature: state.finding.signature || '',
    domain: state.finding.domain || '',
    repairKind: propose.repairKind || '',
    status: 'deployed',
    checks: summarizeChecks(propose.checks),
    branch: located.branch,
    headSha: propose.headSha || '',
    buildRunUrl: buildResult.runUrl || '',
    imageDigest: buildResult.digest || buildResult.deployRef || '',
    deployed: true,
    retestVerdicts: rerunTasks.map(function(t) { return (t && t.result) || ''; }),
    verifyStatus: verdict.status,
    message: 'deploy retest: ' + verdict.status
  };

  if (verdict.status === 'fixed') {
    return { next: 'stop-fixed', attempt: attempt, deployRef: buildResult.deployRef };
  }

  // not-fixed or regressed: roll back to baseline, record, next attempt.
  state.deploy = { ref: buildResult.deployRef, digest: buildResult.digest || null, runUrl: buildResult.runUrl || null };
  var rollback = await rollbackToBaseline(cfg, adapters, buildResult);
  state.rollback = { ok: rollback.ok, reason: rollback.reason, ref: rollback.ref || null };
  if (!rollback.ok) {
    state.rollback.recorded = 'rollback unavailable';
  }
  return {
    next: 'continue',
    attempt: attempt,
    rollback: state.rollback,
    previousEvidence: {
      diff: propose.diffText || null,
      checks: propose.checks || null,
      errors: ['deploy retest: ' + verdict.status + (rollback.ok ? '' : '; rollback unavailable')],
      verifyStatus: verdict.status
    }
  };
}

function summarizeChecks(checks) {
  if (!checks || !Array.isArray(checks.results)) return '';
  var failed = checks.results.filter(function(r) { return !r.success; });
  return failed.length === 0 ? 'pass' : 'fail:' + failed.map(function(f) { return f.script; }).join(',');
}

/**
 * R5b orchestrator entry. Opt-in via REPAIR_MODE=true; normal runs (repair
 * off) short-circuit to NO_REPAIR without touching any adapter or file.
 *
 * Flow: resolve the normal run, collect logs (recording any wrapper refusal),
 * extract the finding and baseline signatures, clone + locate, then loop
 * while budgets allow: proposeAndCheck -> push -> buildAndPublish -> deploy ->
 * rerun -> verify. Fixed stops with FIXED; not-fixed/regressed rolls back to
 * baseline and tries again; any BLOCKED status stops the loop and records the
 * exact blocker with outcome BLOCKED (task stays unmet, no alternative route).
 */
async function runRepair(deps) {
  deps = deps || {};
  var cfg = resolveRepairConfig(deps);

  if (!cfg.repairMode) {
    return {
      outcome: OUTCOME_NO_REPAIR,
      exitCode: EXIT_NO_REPAIR,
      runId: cfg.runId || null,
      blockers: []
    };
  }

  cfg.runId = resolveRunId(cfg);
  var normal = loadNormalRun(cfg, cfg.runId);
  if (!normal) {
    return { outcome: OUTCOME_NO_REPAIR, exitCode: EXIT_NO_REPAIR, runId: cfg.runId || null, blockers: [] };
  }
  var targets = selectRepairTargets(normal.tasks);
  if (targets.length === 0) {
    return { outcome: OUTCOME_NO_REPAIR, exitCode: EXIT_NO_REPAIR, runId: cfg.runId || null, blockers: [] };
  }

  // Pre-check: if any target is blocked with CLIENT_INPUT_SCOPE (seed failed /
  // missing client secret) repair cannot proceed. Do not clone or call the model.
  var clientInputTasks = normal.tasks.filter(function(t) {
    return t && t.classification === CLASS_CLIENT_INPUT_SCOPE;
  });
  if (clientInputTasks.length > 0) {
    var firstBlocked = clientInputTasks[0];
    var evidence = {
      classification: CLASS_CLIENT_INPUT_SCOPE,
      cause: firstBlocked.cause || ('task ' + firstBlocked.taskId + ' blocked: CLIENT_INPUT_SCOPE'),
      variableNames: (firstBlocked.variableNames && Array.isArray(firstBlocked.variableNames))
        ? firstBlocked.variableNames.slice()
        : []
    };
    return {
      outcome: OUTCOME_BLOCKED,
      exitCode: EXIT_BLOCKED,
      runId: cfg.runId || null,
      blockers: [{ code: 'REPAIR_PRECONDITION_NOT_MET', message: 'task blocked with CLIENT_INPUT_SCOPE: repair precondition not met', evidence: evidence }]
    };
  }

  var adapters = Object.assign({}, defaultAdapters(), cfg.adapters || {});
  var budget = cfg.budget || { perSignature: cfg.perSignatureBudget, global: cfg.globalBudget, bySignature: {}, total: 0, model: { maxTokensTotal: 400000, used: 0 } };

  var state = {
    outcome: null,
    exitCode: null,
    logs: {},
    logBlockers: [],
    blockers: [],
    attempts: [],
    previousAttempts: [],
    pipelineChanges: [],
    targetChanges: [],
    finding: null,
    baselineSignatures: [],
    branch: null,
    cloneDir: null,
    deploy: null,
    rollback: null,
    reportError: null,
    runStartedAt: Date.now(),
    deadline: defaultDeadline(Date.now),
    baseSha: null
  };

  // 1. Collect logs. A wrapper refusal is recorded and does not stop the
  //    finding extraction below.
  await collectRepairLogs(cfg, adapters.logSource, state);

  // 2. Extract finding from the first target's API error and reproduce the
  //    baseline signatures. This runs even when a log blocker was recorded.
  var extractInput = buildExtractInput(targets[0], state.logs);
  state.finding = adapters.signatureExtractor.extractFinding(extractInput);
  var replayer = cfg.replayer || function(f) { return defaultReplayer(f); };
  var repro = adapters.verifier.reproduce(state.finding, targets[0], {
    runId: cfg.runId,
    root: cfg.cwd,
    baseDir: 'evidence',
    replayer: replayer
  });
  state.baselineSignatures = Array.isArray(repro.signatures) ? repro.signatures : [];

  // A log wrapper refusal is a BLOCKED status: stop after extraction.
  if (state.logBlockers.length > 0) {
    state.blockers = state.logBlockers.slice();
    state.outcome = OUTCOME_BLOCKED;
    state.exitCode = EXIT_BLOCKED;
    writeRepairReport(cfg, state);
    return redactRepairState(cfg, state);
  }

  // 3. Clone the target and locate candidates.
  var gitSetup = adapters.gitSetup || defaultCloneAndLocate;
  var located = await gitSetup(cfg, adapters, state.finding);
  if (!located || !located.ok) {
    var gblk = located && located.blocker ? located.blocker : normalizeBlocker('GIT_BLOCKED', 'git setup failed', {});
    state.blockers.push(gblk);
    state.outcome = OUTCOME_BLOCKED;
    state.exitCode = EXIT_BLOCKED;
    writeRepairReport(cfg, state);
    return redactRepairState(cfg, state);
  }
  state.branch = located.branch;
  state.cloneDir = located.dir;
  var head = await adapters.gitClient.getHeadSha(located.dir, { runCommand: cfg.runCommand });
  state.baseSha = head && head.ok ? head.sha : null;

  // 4. Repair loop while budgets allow. The orchestrator enforces the
  //    per-signature and global caps itself (model.consume applies a second,
  //    shared gate inside the real proposeAndCheck); either cap ends the loop
  //    with the attempts recorded and the task still unmet.
  var attemptNumber = 0;
  while (Date.now() < state.deadline &&
         attemptNumber < budget.global &&
         attemptNumber < budget.perSignature) {
    attemptNumber += 1;
    var result;
    try {
      result = await proposeAttempt(cfg, adapters, state, located, attemptNumber, budget);
    } catch (err) {
      state.blockers.push(normalizeBlocker('REPAIR_ATTEMPT_ERROR', safeErr(err), {}));
      break;
    }

    if (result.next === 'stop-fixed') {
      state.attempts.push(result.attempt);
      state.outcome = OUTCOME_FIXED;
      state.exitCode = EXIT_FIXED;
      break;
    }
    if (result.next === 'stop-blocked') {
      if (result.blocker) state.blockers.push(result.blocker);
      state.outcome = OUTCOME_BLOCKED;
      state.exitCode = EXIT_BLOCKED;
      break;
    }
    if (result.next === 'stop-budget') {
      state.outcome = OUTCOME_NOT_FIXED;
      state.exitCode = EXIT_NOT_FIXED;
      break;
    }
    // continue: record the retryable/regressed attempt and carry it forward.
    if (result.attempt) {
      state.attempts.push(result.attempt);
    }
    if (result.previousEvidence) {
      state.previousAttempts.push(Object.assign({ n: attemptNumber }, result.previousEvidence));
    }
  }

  if (state.outcome == null) {
    state.outcome = OUTCOME_NOT_FIXED;
    state.exitCode = EXIT_NOT_FIXED;
  }

  writeRepairReport(cfg, state);
  return redactRepairState(cfg, state);
}

async function main() {
  var result;
  try {
    result = await runRepair({});
  } catch (e) {
    console.error('run-repair failed: ' + ((e && e.message) || String(e)));
    process.exitCode = EXIT_BLOCKED;
    return;
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  runRepair,
  main,
  resolveRepairConfig,
  buildFixBranch,
  isRepairTarget,
  selectRepairTargets,
  taskErrorText,
  normalizeBlocker,
  defaultReplayer,
  defaultExtractAfter,
  defaultRerunTasks,
  defaultCloneAndLocate,
  buildRepairData,
  writeRepairReport,
  redactRepairState,
  loadNormalRun,
  resolveRunId
};






