'use strict';

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

var evidenceCollector = require('../src/evidenceCollector');
var reportModule = require('../src/reportGenerator');

// pipeline/*.mjs are ESM; load them lazily so the CJS test file can use them.
var repairModulePromise = import('../pipeline/run-repair.mjs');
var runStagingModulePromise = import('../pipeline/run-staging.mjs');

var EXIT_NO_REPAIR_PROMISE = repairModulePromise.then(function(m) { return m.EXIT_NO_REPAIR; });
var EXIT_NOT_FIXED_PROMISE = repairModulePromise.then(function(m) { return m.EXIT_NOT_FIXED; });
var EXIT_BLOCKED_PROMISE = repairModulePromise.then(function(m) { return m.EXIT_BLOCKED; });

function tempCwd() {
  var dir = path.join(os.tmpdir(), 'run-repair-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha64(char) {
  return char.repeat(64);
}

function makeRecord(taskId, overrides) {
  var base = {
    canonicalId: taskId,
    summarySpecIds: [],
    referenceRevision: 'rev',
    executionRevision: 'exec',
    environmentIdentity: { runId: 'run', environment: 'test', workspacePath: null },
    commandInvocation: { executed: true, note: '' },
    inputArtifactIds: [],
    expectedResult: {},
    actualResult: null,
    exitErrorResult: { exitCode: 1, error: null },
    generatedArtifacts: [],
    stateChanges: null,
    cleanupResetResult: 'not-applicable',
    finalClassification: 'BLOCK',
    naReason: null,
    result: 'BLOCK',
    classification: 'TARGET_APP_DEFECT',
    cause: 'invalid input syntax for type integer: "undefined"',
    repairHistory: [],
    manualIntervention: null
  };
  return Object.assign(base, overrides || {});
}

function evidenceOpts(cwd) {
  return { root: cwd, baseDir: 'evidence', reuseExisting: true };
}

function seedBlockEvidence(cwd, runId, taskIds) {
  for (var i = 0; i < taskIds.length; i++) {
    var tid = taskIds[i];
    evidenceCollector.writeTaskRecord(runId, tid, makeRecord(tid, {
      result: 'BLOCK', classification: 'TARGET_APP_DEFECT',
      cause: 'invalid input syntax for type integer: "undefined"'
    }), evidenceOpts(cwd));
    evidenceCollector.writeEvidenceFile(runId, tid, 'result.json', JSON.stringify({ ok: false }), evidenceOpts(cwd));
  }
}

function seedPassEvidence(cwd, runId, taskIds) {
  for (var i = 0; i < taskIds.length; i++) {
    var tid = taskIds[i];
    evidenceCollector.writeEvidenceFile(runId, tid, 'result.json', JSON.stringify({ ok: true }), evidenceOpts(cwd));
    evidenceCollector.writeTaskRecord(runId, tid, makeRecord(tid, { result: 'RESULT_PASS', classification: null, cause: null, finalClassification: 'PASS' }), evidenceOpts(cwd));
  }
}

function normalDefectTasks() {
  return [
    { taskId: 'CAN-B1-03', result: 'BLOCK', classification: 'TARGET_APP_DEFECT', cause: 'invalid input syntax for type integer: "undefined"' },
    { taskId: 'CAN-B1-04', result: 'BLOCK', classification: 'TARGET_APP_DEFECT', cause: 'invalid input syntax for type integer: "undefined"' },
    { taskId: 'CAN-B2-16', result: 'RESULT_PASS', classification: null, cause: null }
  ];
}

var DEPLOY_REF = 'ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + sha64('a');
var BASELINE_REF = 'ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + sha64('b');

var FINDING_SIG = 'deadbeef' + sha64('c').substring(8, 56) + sha64('d').substring(0, 0);

/**
 * Build the full fake adapter set. `ctrl` is a plain object the test mutates
 * to drive each scenario; `log` records every adapter call for assertions.
 */
function fakeAdapters(ctrl, log) {
  return {
    gitSetup: ctrl.gitSetup || null,
    logSource: {
      collect: async function(kind) {
        log.push('collect:' + kind);
        if (ctrl.logBlock) {
          return { ok: false, blocker: { command: 'sudo ... logs', exitCode: 1, stderrExcerpt: 'permission denied' } };
        }
        return { ok: true, lines: ['2026-10-19T00:00:00Z ERROR postgres: invalid input syntax'] };
      }
    },
    signatureExtractor: {
      extractFinding: function(input) {
        log.push('extractFinding');
        return {
          signature: FINDING_SIG,
          class: 'SQL_PARAM_TYPE',
          domain: 'target-code',
          sqlstate: '22P02',
          message: (input && input.apiErrors && input.apiErrors[0] && input.apiErrors[0].message) || 'invalid input syntax',
          path: null,
          sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: 'undefined' },
          confidence: 'API_ONLY',
          notes: [],
          stack: []
        };
      }
    },
    verifier: {
      reproduce: function(finding, task, opts) {
        log.push('reproduce');
        if (opts && opts.replayer) {
          var r = opts.replayer(finding);
          return { signatures: r.signatures };
        }
        return { signatures: finding ? [finding.signature] : [] };
      },
      verify: function(before, after) {
        log.push('verify:' + JSON.stringify(after));
        if (ctrl.verifyCalls != null) {
          var idx = ctrl.verifyCalls;
          ctrl.verifyCalls += 1;
          if (typeof ctrl.verifyVerdicts === 'function') return ctrl.verifyVerdicts(idx, before, after);
          return ctrl.verifyVerdicts[idx] || { status: 'not-fixed' };
        }
        if (Array.isArray(after) && after.length === 0) return { status: 'fixed' };
        if (ctrl.regressOnFirstVerify) return { status: 'regressed', newSignatures: ['new-sig-1'] };
        return { status: 'not-fixed' };
      }
    },
    gitClient: {
      cloneTarget: async function(opts) {
        log.push('cloneTarget:' + opts.branch);
        if (ctrl.cloneBlock) return { ok: false, blocker: { code: 'CLONE_FAILED', message: 'remote branch not found', evidence: { branch: opts.branch } } };
        return { ok: true, dir: opts.dir, branch: opts.branch };
      },
      cloneRepoForRepair: async function(opts) {
        log.push('cloneRepoForRepair:' + opts.branch);
        if (ctrl.cloneBlock) return { ok: false, blocker: { code: 'CLONE_FAILED', message: 'remote branch not found', evidence: { branch: opts.branch } } };
        return { ok: true, dir: opts.dir, branch: opts.branch };
      },
      getHeadSha: async function() {
        log.push('getHeadSha');
        if (ctrl.headShaBlock) return { ok: false, blocker: { code: 'HEAD_SHA_FAILED', message: 'failed' } };
        return { ok: true, sha: '0000aaaabbbbccccdddd' };
      },
      push: async function(dir, branch, token, opts) {
        log.push('push:' + branch + ':token=' + String(token));
        if (ctrl.pushBlock) return { ok: false, blocker: { code: 'PUSH_FAILED', message: 'push refused', evidence: { branch: branch } } };
        return { ok: true, branch: branch };
      }
    },
    locator: {
      locateCandidates: async function(opts) {
        log.push('locate');
        return { candidates: [{ source: 'target', file: 'src/x.ts', line: 12, snippet: [], score: 8, reasons: ['sql'] }], searched: ['src/x.ts'] };
      }
    },
    build: {
      buildAndPublish: async function(opts) {
        log.push('build');
        if (ctrl.dispatchBlock) {
          return { ok: false, blocker: { code: 'IMAGE_BUILD_DISPATCH_FAILED', message: 'dispatch failed with status 403', evidence: { status: 403 } } };
        }
        return { ok: true, deployRef: DEPLOY_REF, digest: 'sha256:' + sha64('a'), runUrl: 'https://github.com/x/actions/runs/1', runId: '1' };
      },
      baselineDigest: async function() {
        log.push('baselineDigest');
        if (ctrl.noBaseline) return { ok: false, blocker: { code: 'BASELINE_NOT_FOUND', message: 'no successful runs found', evidence: {} } };
        return { ok: true, deployRef: BASELINE_REF };
      }
    },
    deploy: {
      deploy: async function(ref, opts) {
        log.push('deploy:' + ref.substring(0, 12));
        if (ctrl.deployBlock) return { ok: false, blocker: { code: 'DEPLOY_REFUSED', message: 'deploy command returned non-zero', evidence: { exitCode: 1 } } };
        return { ok: true };
      }
    },
    proposeAndCheck: {
      proposeAndCheck: async function(opts) {
        log.push('propose:n=' + opts.previousAttempts.length);
        if (ctrl.propose) return ctrl.propose(opts);
        return { status: 'READY', repairKind: 'source-edit', rationale: 'fix', headSha: '0000aaaabbbbccccdddd', diffText: '--- a/x.ts\n+++ b/x.ts', diffStat: '1 file changed', checks: { results: [{ script: 'build', success: true }] } };
      }
    }
  };
}

function proposeReady() {
  return { status: 'READY', repairKind: 'source-edit', rationale: 'fix', headSha: '0000aaaabbbbccccdddd', diffText: '--- a/x.ts\n+++ b/x.ts', diffStat: '1 file changed', checks: { results: [{ script: 'build', success: true }] } };
}

async function runOnce(deps) {
  var repairModule = await repairModulePromise;
  return repairModule.runRepair(deps);
}

// log is an array of pushed strings; each entry is a prefix label (e.g.
// 'cloneRepoForRepair:<branch>'). Use this helper instead of Array#indexOf, which
// compares whole elements only.
function hasLog(log, prefix) {
  return log.some(function(s) { return s.indexOf(prefix) === 0; });
}

// ---------------------------------------------------------------------------
// R5b orchestrator tests
// ---------------------------------------------------------------------------

test('run-repair: opt-in off -> NO_REPAIR exit 0, no adapter is touched', async function() {
  var m = await repairModulePromise;
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  var res = await runOnce({
    repairMode: false,
    runId: 'run-off',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    adapters: fakeAdapters(ctrl, log)
  });
  assert.strictEqual(res.outcome, m.OUTCOME_NO_REPAIR);
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(log.length, 0, 'no adapter may be called when repair is off');
  assert.strictEqual(fs.readdirSync(cwd).length, 0, 'nothing may be written when repair is off');
});

test('run-repair: no repair targets -> NO_REPAIR exit 0', async function() {
  var cwd = tempCwd();
  var log = [];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-passa',
    cwd: cwd,
    normalRun: [
      { taskId: 'CAN-B1-03', result: 'RESULT_PASS', classification: null },
      { taskId: 'CAN-B1-04', result: 'RESULT_PASS', classification: null },
      { taskId: 'CAN-B2-16', result: 'RESULT_PASS', classification: null }
    ],
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'NO_REPAIR');
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(log.length, 0);
});

test('run-repair: FIXED on attempt 1', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [{ status: 'fixed' }];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-fix1',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-secret-1', OPENROUTER_API_KEY: 'key-secret-1' },
    fetch: validFetch(),
    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'RESULT_PASS' }, { taskId: 'CAN-B1-04', result: 'RESULT_PASS' }, { taskId: 'CAN-B2-16', result: 'RESULT_PASS' }]; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(res.outcome, 'FIXED');
  assert.strictEqual(res.exitCode, 0);
  assert.ok(hasLog(log,'collect:vendure') && hasLog(log,'collect:postgres') && hasLog(log,'collect:worker'), 'all three log kinds collected');
  assert.ok(hasLog(log,'extractFinding'), 'finding extracted');  assert.ok(hasLog(log,'cloneRepoForRepair:'), 'cloned via cloneRepoForRepair');
  assert.ok(hasLog(log,'push:'), 'pushed');
  assert.ok(hasLog(log,'build'), 'built');
  assert.ok(hasLog(log,'deploy:'), 'deployed');
  var reportFile = path.join(cwd, 'reports', 'run-fix1', 'compliance-report.json');
  assert.strictEqual(fs.existsSync(reportFile), true, 'compliance-report.json written');
  var rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.ok(rep.repair, 'repair block present');
  assert.strictEqual(rep.repair.schemaVersion, '1.1', 'schema 1.1');
  assert.strictEqual(rep.repair.manualTargetEdits, 0, 'manualTargetEdits always 0');
  assert.strictEqual(rep.repair.attempts.length, 1, 'one attempt recorded');
  assert.strictEqual(rep.repair.attempts[0].verifyStatus, 'fixed');
  assert.strictEqual(fs.existsSync(path.join(cwd, 'reports', 'run-fix1', 'compliance-report.md')), true, 'markdown written');
});

test('run-repair: FIXED on attempt 2 after a failed first deploy retest with rollback', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [
    { status: 'not-fixed', remainingSignatures: [FINDING_SIG] },
    { status: 'fixed' }
  ];
  var rollbackDeploys = [];
  var deployCount = 0;
  var adapters = fakeAdapters(ctrl, log);
  adapters.deploy.deploy = async function(ref) {
    log.push('deploy:' + ref.substring(0, 12));
    deployCount += 1;
    if (deployCount === 2) rollbackDeploys.push(ref);
    return { ok: true };
  };
  ctrl.deployBlock = null;
  var res = await runOnce({
    repairMode: true,
    runId: 'run-fix2',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-secret-2', OPENROUTER_API_KEY: 'key-secret-2' },
    fetch: validFetch(),
    adapters: adapters,
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'BLOCK' }]; },
    extractAfter: function() { 
      // attempt 1 keeps the signature, attempt 2 drops it
      if (ctrl.verifyCalls === 1) return [FINDING_SIG];
      return [];
    }
  });
  assert.strictEqual(res.outcome, 'FIXED');
  assert.strictEqual(res.exitCode, 0);
  var rep = JSON.parse(fs.readFileSync(path.join(cwd, 'reports', 'run-fix2', 'compliance-report.json'), 'utf8'));
  assert.strictEqual(rep.repair.attempts.length, 2, 'two attempts recorded');
  assert.strictEqual(rep.repair.attempts[0].verifyStatus, 'not-fixed');
  assert.strictEqual(rep.repair.attempts[1].verifyStatus, 'fixed');
  assert.ok(rep.repair.rollback && rep.repair.rollback.ok === true, 'rollback to baseline recorded');
  assert.strictEqual(rollbackDeploys.length, 1, 'baseline deployed for rollback');
  assert.strictEqual(rollbackDeploys[0], BASELINE_REF);
});

test('run-repair: budget exhausted -> NOT_FIXED exit 3', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [{ status: 'not-fixed' }];
  var attempts = 0;
  ctrl.propose = function(opts) {
    attempts += 1;
    if (attempts >= 3) return { status: 'BUDGET_EXHAUSTED', blocker: { code: 'BUDGET_EXHAUSTED', message: 'global budget exhausted' } };
    return proposeReady();
  };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-budget',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),

    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'BLOCK' }]; },
    extractAfter: function() { return [FINDING_SIG]; }
  });
  assert.strictEqual(res.outcome, 'NOT_FIXED');
  assert.strictEqual(res.exitCode, 3);
  assert.ok(res.blockers.length === 0, 'budget exhaustion is NOT_FIXED, not a blocker');
});

test('run-repair: budget cap ends loop with NOT_FIXED when every attempt is refuted', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [
    { status: 'not-fixed' },
    { status: 'not-fixed' },
    { status: 'not-fixed' }
  ];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-cap',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),

    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'BLOCK' }]; },
    extractAfter: function() { return [FINDING_SIG]; }
  });
  assert.strictEqual(res.outcome, 'NOT_FIXED');
  assert.strictEqual(res.exitCode, 3);
  var rep = JSON.parse(fs.readFileSync(path.join(cwd, 'reports', 'run-cap', 'compliance-report.json'), 'utf8'));
  assert.ok(rep.repair.attempts.length <= 3, 'attempts bounded by per-signature budget');
});

test('run-repair: BLOCKED when log wrapper refuses (finding still extracted)', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { logBlock: true };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-logblock',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-logblock', OPENROUTER_API_KEY: 'key-logblock' },
    fetch: validFetch(),
    adapters: fakeAdapters(ctrl, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(hasLog(log,'extractFinding'), 'finding extraction proceeds past the log blocker');
  assert.ok(!hasLog(log,'cloneRepoForRepair'), 'no git op after a log block');
  assert.ok(res.blockers.some(function(b) { return b.code === 'LOG_WRAPPER_REFUSED'; }), 'exact blocker recorded');
});

test('run-repair: CLIENT_INPUT_SCOPE blocked seed -> REPAIR_PRECONDITION_NOT_MET, no gitClient call', async function() {
  var cwd = tempCwd();
  var log = [];
  // Task blocked with CLIENT_INPUT_SCOPE (seed failed / missing secret)
  var clientInputRun = [
    { taskId: 'CAN-B1-03', result: 'BLOCK', classification: 'CLIENT_INPUT_SCOPE', cause: 'seed failed: ADMIN_CREDENTIALS_MISSING; missing STAGING_ADMIN_PASSWORD, SUPERADMIN_PASSWORD', variableNames: ['STAGING_ADMIN_PASSWORD', 'SUPERADMIN_PASSWORD'] },
    { taskId: 'CAN-B1-04', result: 'BLOCK', classification: 'CLIENT_INPUT_SCOPE', cause: 'seed failed: SEED_CONFIG_BLOCKED; missing client-supplied secret SEED_TEST_CUSTOMER_PASSWORD', variableNames: ['SEED_TEST_CUSTOMER_PASSWORD'] },
    { taskId: 'CAN-B2-16', result: 'RESULT_PASS', classification: null, cause: null }
  ];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-clientblock',
    cwd: cwd,
    normalRun: clientInputRun,
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blocker = res.blockers && res.blockers.find(function(b) { return b.code === 'REPAIR_PRECONDITION_NOT_MET'; });
  assert.ok(blocker, 'REPAIR_PRECONDITION_NOT_MET blocker present');
  var ev = blocker && blocker.evidence;
  assert.strictEqual(ev && ev.classification, 'CLIENT_INPUT_SCOPE');
  assert.ok(ev && ev.variableNames && Array.isArray(ev.variableNames),
    'evidence.variableNames is an array (names only, never values)');
  assert.ok(ev && ev.variableNames.indexOf('STAGING_ADMIN_PASSWORD') !== -1 ||
             ev && ev.variableNames.indexOf('SEED_TEST_CUSTOMER_PASSWORD') !== -1,
    'variableNames includes the missing secret names');
  // No git operation must have been attempted
  assert.ok(!hasLog(log, 'cloneTarget') && !hasLog(log, 'cloneRepoForRepair'), 'no gitClient call');
  assert.ok(!hasLog(log, 'collect:vendure'), 'no log collection (prerequisite fails before that step)');
});

test('run-repair: BLOCKED when git clone refuses', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { cloneBlock: true };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-gitblock',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),

    adapters: fakeAdapters(ctrl, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(res.blockers.some(function(b) { return b.code === 'CLONE_FAILED'; }), 'exact git blocker');
});

test('run-repair: BLOCKED when the model is unavailable', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.propose = function() {
    return { status: 'MODEL_FAILED', blocker: { code: 'MODEL_UNAVAILABLE', message: 'OpenRouter API 401', evidence: { status: 401 } } };
  };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-modelblock',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),

    adapters: fakeAdapters(ctrl, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(res.blockers.some(function(b) { return b.code === 'MODEL_UNAVAILABLE'; }), 'exact model blocker');
});

test('run-repair: BLOCKED when image dispatch is refused (403)', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { dispatchBlock: true };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-dispatchblock',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),

    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return []; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(res.blockers.some(function(b) { return b.code === 'IMAGE_BUILD_DISPATCH_FAILED'; }), 'exact dispatch blocker');
});

test('run-repair: BLOCKED when deploy is refused', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { deployBlock: true };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-deployblock',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),

    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return []; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(res.blockers.some(function(b) { return b.code === 'DEPLOY_REFUSED'; }), 'exact deploy blocker');
});

test('run-repair: normal run is never mutated', async function() {
  var cwd = tempCwd();
  var log = [];
  var normalRun = normalDefectTasks();
  var snapshot = JSON.stringify(normalRun);
  await runOnce({
    repairMode: true,
    runId: 'run-nomut',
    cwd: cwd,
    normalRun: normalRun,
    adapters: fakeAdapters({}, log),
    rerunTasks: async function() { return []; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(JSON.stringify(normalRun), snapshot, 'normal run rows unchanged');
});

test('run-repair: token and API key never appear in output or report', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [{ status: 'fixed' }];
  var tok = 'tok-super-secret-777';
  var key = 'key-super-secret-888';
  var res = await runOnce({
    repairMode: true,
    runId: 'run-secret',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: tok, OPENROUTER_API_KEY: key },
    fetch: validFetch(),
    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return []; },
    extractAfter: function() { return []; }
  });
  var serialized = JSON.stringify(res);
  assert.strictEqual(serialized.indexOf(tok), -1, 'token absent from returned state');
  assert.strictEqual(serialized.indexOf(key), -1, 'key absent from returned state');
  var reportContent = fs.readFileSync(path.join(cwd, 'reports', 'run-secret', 'compliance-report.json'), 'utf8');
  assert.strictEqual(reportContent.indexOf(tok), -1, 'token absent from report json');
  assert.strictEqual(reportContent.indexOf(key), -1, 'key absent from report json');
  var md = fs.readFileSync(path.join(cwd, 'reports', 'run-secret', 'compliance-report.md'), 'utf8');
  assert.strictEqual(md.indexOf(tok), -1, 'token absent from report md');
  assert.strictEqual(md.indexOf(key), -1, 'key absent from report md');
});

test('run-repair: no code path writes to the target clone outside gitClient+applier', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [{ status: 'fixed' }];
  var cloneDir = path.join(cwd, 'clone');
  fs.mkdirSync(path.join(cloneDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'src', 'x.ts'), 'before', 'utf8');
  var adapters = fakeAdapters(ctrl, log);
  adapters.gitSetup = async function(cfg, ad, finding) {
    return { ok: true, dir: cloneDir, branch: 'codex/pipeline-fix-run-clone-deadbeef', candidates: [], searched: [] };
  };
  adapters.gitClient.getHeadSha = async function() { log.push('getHeadSha'); return { ok: true, sha: '0000aaaa' }; };
  var snapshot = {};
  snapshot['src/x.ts'] = fs.readFileSync(path.join(cloneDir, 'src', 'x.ts'), 'utf8');
  await runOnce({
    repairMode: true,
    runId: 'run-clone',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-clone', OPENROUTER_API_KEY: 'key-clone' },
    fetch: validFetch(),
    adapters: adapters,
    rerunTasks: async function() { return []; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(fs.readFileSync(path.join(cloneDir, 'src', 'x.ts'), 'utf8'), snapshot['src/x.ts'], 'target clone untouched by the orchestrator');
  var rep = JSON.parse(fs.readFileSync(path.join(cwd, 'reports', 'run-clone', 'compliance-report.json'), 'utf8'));
  assert.strictEqual(rep.repair.manualTargetEdits, 0);
});

test('run-repair: exit codes are distinct and documented importable constants', async function() {
  var m = await repairModulePromise;
  assert.strictEqual(m.EXIT_NO_REPAIR, 0);
  assert.strictEqual(m.EXIT_FIXED, 0);
  assert.strictEqual(m.EXIT_NOT_FIXED, 3);
  assert.strictEqual(m.EXIT_BLOCKED, 4);
});

test('run-repair: run-staging.mjs exposes runStage for the rerun path', async function() {
  var s = await runStagingModulePromise;
  assert.strictEqual(typeof s.runStage, 'function', 'runStage is exported');
  assert.strictEqual(typeof s.buildStagesForTaskIds, 'function');
  var stages = s.buildStagesForTaskIds(['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16']);
  assert.strictEqual(stages.length, 3);
});

test('run-repair: an attempt that throws still writes finding.json and attempt-error.json', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.propose = async function() {
    throw new Error('finding.stack.substring is not a function');
  };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-throw',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-test', OPENROUTER_API_KEY: 'key-test' },
    fetch: validFetch(),
    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return []; },
    extractAfter: function() { return []; }
  });
  assert.ok(res.blockers.some(function(b) { return b.code === 'REPAIR_ATTEMPT_ERROR'; }), 'REPAIR_ATTEMPT_ERROR blocker recorded');

  var evidenceDir = path.join(cwd, 'evidence', 'run-throw', 'repair');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'finding.json')), 'finding.json written in evidence/<runId>/repair/');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'attempt-error.json')), 'attempt-error.json written in evidence/<runId>/repair/');

  var attemptErr = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'attempt-error.json'), 'utf8'));
  assert.strictEqual(attemptErr.errorName, 'Error');
  assert.strictEqual(attemptErr.message, 'finding.stack.substring is not a function');
  assert.strictEqual(typeof attemptErr.stack, 'string');
  assert.strictEqual(attemptErr.phase, 'propose-attempt');

  var findingJson = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'finding.json'), 'utf8'));
  assert.strictEqual(findingJson.signature, FINDING_SIG, 'finding.json carries signature');
  assert.strictEqual(findingJson.class, 'SQL_PARAM_TYPE');
});

test('run-repair: evidence/<runId>/repair/finding.json written BEFORE blocker return', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.propose = function() {
    return { status: 'MODEL_FAILED', blocker: { code: 'MODEL_UNAVAILABLE', message: 'OpenRouter API 401', evidence: { status: 401 } } };
  };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-evidblock',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-evid', OPENROUTER_API_KEY: 'key-evid' },
    fetch: validFetch(),
    adapters: fakeAdapters(ctrl, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);

  // The evidence file must exist even though the repair was BLOCKED
  var evidPath = path.join(cwd, 'evidence', 'run-evidblock', 'repair', 'finding.json');
  assert.strictEqual(fs.existsSync(evidPath), true, 'evidence/<runId>/repair/finding.json must exist for blocked repair');

  var evid = JSON.parse(fs.readFileSync(evidPath, 'utf8'));
  assert.strictEqual(evid.class, 'SQL_PARAM_TYPE', 'class should match finding');
  assert.strictEqual(evid.domain, 'target-code', 'domain should match finding (not infrastructure)');
  assert.strictEqual(evid.signature, FINDING_SIG, 'signature should match finding');
  assert.strictEqual(evid.confidence, 'API_ONLY', 'confidence should match finding');

  // logs_collected_per_kind must be present with counts and byte sizes
  assert.ok(evid.logs_collected_per_kind, 'logs_collected_per_kind must be present');
  var kinds = ['postgres', 'vendure', 'worker'];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    assert.ok(evid.logs_collected_per_kind[kind], 'logs entry for ' + kind + ' must exist');
    assert.strictEqual(typeof evid.logs_collected_per_kind[kind].count, 'number', 'count for ' + kind);
    assert.strictEqual(typeof evid.logs_collected_per_kind[kind].bytes, 'number', 'bytes for ' + kind);
    // Verify it's counts/sizes only - no actual log content
    assert.ok(!evid.logs_collected_per_kind[kind].lines, 'no lines field (counts only)');
    assert.ok(!evid.logs_collected_per_kind[kind].content, 'no content field (counts only)');
  }
});

// ---------------------------------------------------------------------------
// Credential preflight: VENDURE_STAGING_REPO_TOKEN is validated before any
// clone/push/dispatch. Bad tokens are CLIENT_INPUT_SCOPE blockers and the
// clone adapter is never reached.
// ---------------------------------------------------------------------------

function apiResponse(status) {
  return Promise.resolve({ status: status, ok: status >= 200 && status < 300 });
}

// Mock GitHub API fetch that reports a usable token, so tests that exercise
// the flow past the credential preflight do not hit the real GitHub API.
function validFetch() {
  return function() { return Promise.resolve({ status: 200, ok: true }); };
}

test('run-repair: empty VENDURE_STAGING_REPO_TOKEN -> REPO_TOKEN_MISSING, clone never called', async function() {
  var cwd = tempCwd();
  var log = [];
  var called = { fetch: false };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-tok-missing',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { OPENROUTER_API_KEY: 'key-1' }, // no VENDURE_STAGING_REPO_TOKEN
    fetch: function() { called.fetch = true; return apiResponse(200); },
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blocker = res.blockers && res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_MISSING'; });
  assert.ok(blocker, 'REPO_TOKEN_MISSING blocker present');
  assert.strictEqual(blocker.evidence && blocker.evidence.classification, 'CLIENT_INPUT_SCOPE', 'client-input classification in evidence');
  assert.strictEqual(called.fetch, false, 'no API call when token is empty');
  assert.ok(!hasLog(log, 'cloneTarget') && !hasLog(log, 'cloneRepoForRepair'), 'clone adapter never called');
  assert.ok(!hasLog(log, 'collect:vendure'), 'no log collection after credential block');
});

test('run-repair: API 401 -> REPO_TOKEN_INVALID_OR_EXPIRED, clone never called', async function() {
  var cwd = tempCwd();
  var log = [];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-401bad',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-401', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() { return apiResponse(401); },
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blocker = res.blockers && res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_INVALID_OR_EXPIRED'; });
  assert.ok(blocker, 'REPO_TOKEN_INVALID_OR_EXPIRED blocker present');
  assert.ok(blocker.message.indexOf('401') !== -1, 'message names 401 status');
  assert.strictEqual(blocker.evidence && blocker.evidence.classification, 'CLIENT_INPUT_SCOPE', 'client-input classification in evidence');
  assert.ok(!hasLog(log, 'cloneTarget') && !hasLog(log, 'cloneRepoForRepair'), 'clone adapter never called');
  var serialized = JSON.stringify(res);
  assert.strictEqual(serialized.indexOf('tok-401'), -1, 'token value never appears in output');
  var repFile = path.join(cwd, 'reports', 'run-401bad', 'compliance-report.json');
  assert.strictEqual(fs.existsSync(repFile), true, 'compliance-report.json written for token blocker');
  var rep = JSON.parse(fs.readFileSync(repFile, 'utf8'));
  var rb = rep && rep.repair && rep.repair.blockers;
  assert.ok(rb && rb.some(function(b) { return b.code === 'REPO_TOKEN_INVALID_OR_EXPIRED'; }), 'blocker recorded in repair.blockers');
  assert.strictEqual(fs.readFileSync(repFile, 'utf8').indexOf('tok-401'), -1, 'token value never appears in report');
});

test('run-repair: API 403 -> REPO_TOKEN_INSUFFICIENT_SCOPE, clone never called', async function() {
  var cwd = tempCwd();
  var log = [];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-tok-403',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-403', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() { return apiResponse(403); },
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blocker = res.blockers && res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_INSUFFICIENT_SCOPE'; });
  assert.ok(blocker, 'REPO_TOKEN_INSUFFICIENT_SCOPE blocker present');
  assert.ok(blocker.message.indexOf('403') !== -1, 'message names 403 status');
  assert.strictEqual(blocker.evidence && blocker.evidence.classification, 'CLIENT_INPUT_SCOPE', 'client-input classification in evidence');
  assert.ok(!hasLog(log, 'cloneTarget') && !hasLog(log, 'cloneRepoForRepair'), 'clone adapter never called');
});

test('run-repair: API 404 -> REPO_TOKEN_INSUFFICIENT_SCOPE, clone never called', async function() {
  var cwd = tempCwd();
  var log = [];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-tok-404',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-404', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() { return apiResponse(404); },
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blocker = res.blockers && res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_INSUFFICIENT_SCOPE'; });
  assert.ok(blocker, 'REPO_TOKEN_INSUFFICIENT_SCOPE blocker present');
  assert.ok(blocker.message.indexOf('404') !== -1, 'message names 404 status');
  assert.strictEqual(blocker.evidence && blocker.evidence.classification, 'CLIENT_INPUT_SCOPE', 'client-input classification in evidence');
  assert.ok(!hasLog(log, 'cloneTarget') && !hasLog(log, 'cloneRepoForRepair'), 'clone adapter never called');
});

test('run-repair: API unreachable after retries -> DEPENDENCY_ENVIRONMENT blocker, clone never called', async function() {
  var cwd = tempCwd();
  var log = [];
  var calls = 0;
  var res = await runOnce({
    repairMode: true,
    runId: 'run-tok-net',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-net', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() {
      calls += 1;
      return Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
    },
    adapters: fakeAdapters({}, log)
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(calls >= 3, 'fetch retried at least 3 times (got ' + calls + ')');
  var blocker = res.blockers && res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_NETWORK_FAILURE'; });
  assert.ok(blocker, 'REPO_TOKEN_NETWORK_FAILURE blocker present');
  assert.strictEqual(blocker.evidence && blocker.evidence.classification, 'DEPENDENCY_ENVIRONMENT', 'dependency classification in evidence');
  assert.ok(!hasLog(log, 'cloneTarget') && !hasLog(log, 'cloneRepoForRepair'), 'clone adapter never called');
});

test('run-repair: valid token (API 200) proceeds to clone', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [{ status: 'fixed' }];
  var res = await runOnce({
    repairMode: true,
    runId: 'run-tok-ok',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-200', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() { return apiResponse(200); },
    adapters: fakeAdapters(ctrl, log),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'RESULT_PASS' }, { taskId: 'CAN-B1-04', result: 'RESULT_PASS' }, { taskId: 'CAN-B2-16', result: 'RESULT_PASS' }]; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(res.outcome, 'FIXED');
  assert.strictEqual(res.exitCode, 0);
  assert.ok(hasLog(log, 'cloneRepoForRepair:'), 'clone reached with a valid token');
});

test('run-repair: git clone "Authentication failed" -> REPO_TOKEN_INVALID_OR_EXPIRED, no push', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { cloneBlock: true };
  var adapters = fakeAdapters(ctrl, log);
  adapters.gitClient.cloneRepoForRepair = async function(opts) {
    log.push('cloneRepoForRepair:' + opts.branch);
    return { ok: false, blocker: { code: 'REPO_TOKEN_INVALID_OR_EXPIRED', message: 'Git auth failed: authentication rejected (token is invalid or expired)', evidence: { classification: 'CLIENT_INPUT_SCOPE', stderr: 'fatal: Authentication failed for https://github.com/vendure-ai-factory/vendure-staging-baseline' } } };
  };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-git-auth',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-auth', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() { return apiResponse(200); },
    adapters: adapters
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blockerA = res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_INVALID_OR_EXPIRED'; });
  assert.ok(blockerA, 'git auth failure classified as REPO_TOKEN_INVALID_OR_EXPIRED');
  assert.ok(String(blockerA.evidence).indexOf('CLIENT_INPUT_SCOPE') !== -1, 'classification preserved');
  assert.ok(!hasLog(log, 'push:'), 'no push after git auth failure');
});

test('run-repair: git clone "could not read Username" -> REPO_TOKEN_MISSING, no push', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { cloneBlock: true };
  var adapters = fakeAdapters(ctrl, log);
  adapters.gitClient.cloneRepoForRepair = async function(opts) {
    log.push('cloneRepoForRepair:' + opts.branch);
    return { ok: false, blocker: { code: 'REPO_TOKEN_MISSING', message: 'Git auth failed: could not read username for remote (token missing or URL malformed)', evidence: { classification: 'CLIENT_INPUT_SCOPE', stderr: "fatal: could not read Username for 'https://github.com': No such device or address" } } };
  };
  var res = await runOnce({
    repairMode: true,
    runId: 'run-git-username',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-user', OPENROUTER_API_KEY: 'key-1' },
    fetch: function() { return apiResponse(200); },
    adapters: adapters
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  var blockerU = res.blockers.find(function(b) { return b.code === 'REPO_TOKEN_MISSING'; });
  assert.ok(blockerU, 'git username failure classified as REPO_TOKEN_MISSING');
  assert.ok(String(blockerU.evidence).indexOf('CLIENT_INPUT_SCOPE') !== -1, 'classification preserved');
  assert.ok(!hasLog(log, 'push:'), 'no push after git username failure');
});



// ---------------------------------------------------------------------------
// LOCATOR_BUDGET_EXCEEDED with candidates: ok:true + truncated, no blocker.
// The locator correctly returns ok:true with truncated:true and warnings when
// candidates were found before the budget hit. The orchestrator must not
// convert a truncated-but-populated result into a blocker — it must continue
// to the proposal loop and record the warning in the repair block.
// ---------------------------------------------------------------------------
test('run-repair: locator budget exceeded with candidates -> ok:true, proposal loop runs, no blocker', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = {};
  ctrl.verifyCalls = 0;
  ctrl.verifyVerdicts = [{ status: 'not-fixed' }];
  var adapters = fakeAdapters(ctrl, log);
  // Override locator to return the exact shape the real locator produces when
  // budget is hit AFTER candidates were found: ok + truncated + warnings +
  // candidates + budgetExceeded flag.
  adapters.locator = {
    locateCandidates: async function(opts) {
      log.push('locate');
      return {
        ok: true,
        truncated: true,
        warnings: [{
          code: 'LOCATOR_BUDGET_REACHED',
          counts: { hitCount: 0, patterns: 11, scannedFiles: 313 }
        }],
        candidates: [
          { source: 'target', file: 'src/orders/service.ts', line: 42, snippet: 'if (order.id != id)', score: 8, reasons: ['!=', 'id'] },
          { source: 'stack', package: null, file: 'src/orders/resolver.ts', line: 88, snippet: 'order.id Not(id)', score: 7, reasons: ['finding.stack frame'] }
        ],
        searched: ['src/orders/service.ts', 'src/orders/resolver.ts'],
        budgetExceeded: true,
        budget: { hitCount: 0, patterns: 11, scannedFiles: 313 }
      };
    }
  };

  var res = await runOnce({
    repairMode: true,
    runId: 'run-trunc-warn',
    cwd: cwd,
    normalRun: normalDefectTasks(),
    env: { VENDURE_STAGING_REPO_TOKEN: 'tok-secret-trunc', OPENROUTER_API_KEY: 'key-secret-trunc' },
    fetch: validFetch(),
    adapters: adapters,
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'BLOCK' }]; },
    extractAfter: function() { return [FINDING_SIG]; },
    perSignatureBudget: 1
  });

  // The fix: budget exceeded with candidates must NOT produce a blocker.
  // Before the fix, this test FAILS because run-repair.mjs line 1079 creates
  // a BLOCKED result whenever budgetExceeded is true, ignoring candidates.
  assert.strictEqual(res.outcome, 'NOT_FIXED', 'outcome must be NOT_FIXED (not BLOCKED)');
  assert.strictEqual(res.exitCode, 3, 'exit code must be 3 NOT_FIXED (not 4 BLOCKED)');
  assert.ok(!res.blockers || res.blockers.length === 0, 'no blockers when candidates exist despite budget warning');

  // The proposal loop must have run (locate was called, then propose).
  assert.ok(hasLog(log, 'locate'), 'locateCandidates was called');
  assert.ok(hasLog(log, 'propose:'), 'proposeAndCheck was called (proposal loop ran)');

  // The compliance report must record the attempt.
  var repFile = path.join(cwd, 'reports', 'run-trunc-warn', 'compliance-report.json');
  assert.strictEqual(fs.existsSync(repFile), true, 'compliance-report.json written');
  var rep = JSON.parse(fs.readFileSync(repFile, 'utf8'));
  assert.strictEqual(rep.repair.attempts.length, 1, 'one attempt recorded in repair block');
  assert.strictEqual(rep.repair.attempts[0].verifyStatus, 'not-fixed', 'attempt verifyStatus is not-fixed');

});
