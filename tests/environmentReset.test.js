'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');

var executors = require('../src/executors/environmentReset');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var REPO_ROOT = path.resolve(__dirname, '..');

function fakeClock(iso) {
  var current = new Date(iso || '2026-10-08T09:00:00.000Z');
  return function() { return new Date(current.getTime()); };
}

function envWith(items) {
  return function() {
    return Object.assign({}, items || {});
  };
}

function taskFor(taskId, expectedResult) {
  return {
    canonicalId: taskId,
    summaryIds: ['B1-07'],
    summarySpecIds: ['B1-07'],
    requiredInputs: ['stagingUrl', 'testAccounts', 'isolatedCloneRestartRollback'],
    expectedResult: expectedResult || 'Clean initialization, migration, rollback and restart work on the isolated clone; environment identity and the reset/cleanup result are recorded.'
  };
}

// A fresh evidence root per test so nothing leaks into the repo evidence/ dir.
function evidenceRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ev-envreset-'));
}

function baseContext(overrides) {
  overrides = overrides || {};
  var root = overrides.evidenceRoot || evidenceRoot();
  var ctx = {
    taskId: 'CAN-B1-07',
    task: taskFor('CAN-B1-07'),
    repoRoot: REPO_ROOT,
    runEnvRecord: { runId: 'run-envreset' + Date.now().toString(36), gitHead: 'deadbeef1234', revisionId: 'rev-er' },
    deps: {
      clock: overrides.clock || fakeClock(),
      getEnv: overrides.getEnv || envWith({}),
      config: overrides.config || { evidenceRoot: root, evidenceBaseDir: 'evidence' }
    }
  };
  if (overrides.runWrapper !== undefined) ctx.deps.runWrapper = overrides.runWrapper;
  if (overrides.workspace) ctx.workspace = overrides.workspace;
  if (overrides.manifest) ctx.manifest = overrides.manifest;
  return ctx;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'expected result for ' + (taskId || 'unknown'),
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

function okLifecycleResponse(overrides) {
  overrides = overrides || {};
  return {
    ok: true,
    environmentIdentity: {
      cloneId: overrides.cloneId || 'isolated-clone-cb1-07',
      gitHead: overrides.gitHead || 'deadbeef1234',
      databaseIdentity: overrides.databaseIdentity || 'pg:isolated_clone_cb1_07',
      containerIdentity: overrides.containerIdentity || 'vendure-storefront-cb1-07',
      launchedAt: '2026-10-08T09:00:00.000Z'
    },
    phases: {
      init: overrides.init !== undefined ? overrides.init : { ok: true, note: 'clone initialised', schema: 'v1' },
      migrate: overrides.migrate !== undefined ? overrides.migrate : { ok: true, fromRevision: 'a6b8b829', toRevision: 'b1c2d3e4', migrationsRun: 3 },
      rollback: overrides.rollback !== undefined ? overrides.rollback : { ok: true, toRevision: 'a6b8b829' },
      restart: overrides.restart !== undefined ? overrides.restart : { ok: true, healthOk: true, httpStatus: 200 }
    },
    resetCleanupResult: overrides.resetCleanupResult !== undefined
      ? overrides.resetCleanupResult
      : { ok: true, result: 'clean clone reset and temporary data cleaned', cleaned: ['work/tmp'] }
  };
}

function wrapperReturning(response) {
  return function(request, context) {
    return Promise.resolve(response);
  };
}

test('environmentReset: registers the canonical task id CAN-B1-07', function(t, done) {
  executorModule.resetTaskExecutors();
  var outcome = executors.register(executorModule);
  assert.deepStrictEqual(outcome.registered, ['CAN-B1-07']);
  var exec = executorModule.getTaskExecutor('CAN-B1-07');
  assert.ok(exec, 'executor registered');
  assert.strictEqual(exec.handler, executors.handlerEnvironmentReset);
  assert.ok(exec.coverage, 'coverage declared');
  executorModule.resetTaskExecutors();
  done();
});

test('environmentReset: local absent wrapper -> BLOCK CLIENT_INPUT_SCOPE with evidence that the wrapper is absent', async function(t) {
  var ctx = baseContext({});
  var outcome = await executors.handlerEnvironmentReset(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var final = finalizeLikeCli(outcome, 'CAN-B1-07');
  assert.strictEqual(final.result, 'BLOCK');
  assert.strictEqual(final.classification, CLIENT_INPUT_SCOPE);

  var evidence = outcome.evidence;
  assert.ok(evidence, 'evidence present');
  assert.strictEqual(evidence.taskId, 'CAN-B1-07');
  assert.strictEqual(evidence.wrapperAbsent, true, 'evidence records the wrapper is absent');
  assert.deepStrictEqual(evidence.envVarNames, ['PIPELINE_ENV_RESET_WRAPPER'], 'env var NAMES only, never a value');
  assert.ok(JSON.stringify(evidence).indexOf('sk_test') === -1, 'no secret value anywhere');
  assert.strictEqual(evidence.safety.directRebootAttempted, false, 'no direct reboot attempted');
  assert.strictEqual(evidence.resetCleanupResult.ok, false, 'reset/cleanup not performed');
  assert.ok(evidence.environmentIdentity.gitHead, 'environment identity recorded');
  assert.strictEqual(evidence.assertions[0].id, 'CAN-B1-07-A01');
  assert.strictEqual(evidence.assertions[0].verified, false, 'assertion not verified when the wrapper is absent');
  assert.ok(evidence.assertions[0].unverifiedClaims.length > 0, 'the unchecked claim is listed as unverified');
  assert.strictEqual(JSON.stringify(evidence).indexOf('PIPELINE_ENV_RESET_WRAPPER') !== -1, true, 'env NAME recorded');
});

test('environmentReset: absent wrapper -> evidence files written under the run task dir', async function(t) {
  var ctx = baseContext({});
  await executors.handlerEnvironmentReset(ctx);
  var runId = ctx.runEnvRecord.runId;
  var taskDir = path.join((ctx.deps.config.evidenceRoot), ctx.deps.config.evidenceBaseDir, runId, 'CAN-B1-07');
  assert.ok(fs.existsSync(path.join(taskDir, 'wrapper-absent.json')), 'wrapper-absent.json written');
  assert.ok(fs.existsSync(path.join(taskDir, 'executor-error.json')), 'executor-error.json written');
  var wrapperAbsent = JSON.parse(fs.readFileSync(path.join(taskDir, 'wrapper-absent.json'), 'utf8'));
  assert.strictEqual(wrapperAbsent.wrapperAbsent, true, 'persisted evidence records wrapper absence');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: env var set but no adapter -> still blocks CLIENT_INPUT_SCOPE (never invokes a restart directly)', async function(t) {
  var ctx = baseContext({ getEnv: envWith({ PIPELINE_ENV_RESET_WRAPPER: '/opt/pipeline/reset-env-wrapper' }) });
  var outcome = await executors.handlerEnvironmentReset(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.strictEqual(outcome.evidence.wrapperEnvPresent, 'PIPELINE_ENV_RESET_WRAPPER', 'names the env var that was present');
  assert.strictEqual(outcome.evidence.safety.directRebootAttempted, false, 'no restart invoked');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: success via injected fake wrapper -> READINESS_PASS, all phases + identity + reset verified', async function(t) {
  var ctx = baseContext({ runWrapper: wrapperReturning(okLifecycleResponse()) });
  var outcome = await executors.handlerEnvironmentReset(ctx);

  assert.strictEqual(outcome.success, true);
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.actual, ctx.task.expectedResult, 'actual equals expected');
  assert.strictEqual(outcome.errorCode, null);

  var evidence = outcome.evidence;
  assert.strictEqual(evidence.wrapperSource, 'deps.runWrapper', 'records the wrapper source honestly');
  assert.strictEqual(evidence.checks.allPhasesOk, true);
  assert.strictEqual(evidence.checks.identityRecorded, true);
  assert.strictEqual(evidence.checks.resetRecorded, true);
  assert.strictEqual(evidence.checks.noDirectRestart, true);
  assert.strictEqual(evidence.observed.phases.migrate.ok, true);
  assert.strictEqual(evidence.assertions[0].verified, true, 'assertion verified from wrapper-reported evidence');
  assert.strictEqual(evidence.assertions[0].verifiedClaims.length, 6, 'four phases + identity + reset claims verified');
  assert.strictEqual(evidence.assertions[0].unverifiedClaims.length, 0);
  assert.strictEqual(JSON.stringify(evidence).indexOf('sk_test') === -1, true, 'no secrets leaked (wrapper env name only)');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: defective lifecycle phase -> BLOCK APPLICATION_DEFECT', async function(t) {
  var response = okLifecycleResponse({ migrate: { ok: false, error: 'migration failed on revision b1c2d3e4' } });
  var ctx = baseContext({ runWrapper: wrapperReturning(response) });
  var outcome = await executors.handlerEnvironmentReset(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var final = finalizeLikeCli(outcome, 'CAN-B1-07');
  assert.strictEqual(final.result, 'BLOCK');
  assert.strictEqual(final.classification, APPLICATION_DEFECT);
  assert.ok(outcome.error.indexOf('migrate') !== -1, 'names the defective phase');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: unverified identity -> BLOCK APPLICATION_DEFECT', async function(t) {
  var response = okLifecycleResponse({});
  response.environmentIdentity = { cloneId: 'isolated-clone' }; // no gitHead
  var ctx = baseContext({ runWrapper: wrapperReturning(response) });
  var outcome = await executors.handlerEnvironmentReset(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(/identity/.test(outcome.error), 'error names the missing identity');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: reset/cleanup result not recorded -> BLOCK APPLICATION_DEFECT', async function(t) {
  var response = okLifecycleResponse({ resetCleanupResult: { ok: false, reason: 'cleanup skipped' } });
  var ctx = baseContext({ runWrapper: wrapperReturning(response) });
  var outcome = await executors.handlerEnvironmentReset(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(/reset\/cleanup/.test(outcome.error), 'error names the missing reset/cleanup result');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: wrapper unavailable/thrown -> BLOCK DEPENDENCY_ENVIRONMENT', async function(t) {
  var failing = function(request, context) {
    return Promise.reject(new Error('lifecycle wrapper unreachable'));
  };
  var ctx = baseContext({ runWrapper: failing });
  var outcome = await executors.handlerEnvironmentReset(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var final = finalizeLikeCli(outcome, 'CAN-B1-07');
  assert.strictEqual(final.result, 'BLOCK');
  assert.strictEqual(final.classification, DEPENDENCY_ENVIRONMENT);
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: partial coverage -> READINESS_PASS with unverified claims listed', async function(t) {
  // The wrapper can only run init and restart; migrate and rollback are not
  // performed. The executor must list those claims as unverified and never
  // claim a full pass.
  var response = okLifecycleResponse({
    migrate: undefined,
    rollback: undefined
  });
  response.phases = { init: { ok: true }, restart: { ok: true, healthOk: true } };
  var ctx = baseContext({ runWrapper: wrapperReturning(response) });
  var outcome = await executors.handlerEnvironmentReset(ctx);

  assert.strictEqual(outcome.success, true, 'reported claims pass');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  var evidence = outcome.evidence;
  assert.strictEqual(evidence.assertions[0].verified, false, 'assertion is NOT fully verified in partial coverage');
  var unverifiedText = JSON.stringify(evidence.assertions[0].unverifiedClaims);
  assert.ok(unverifiedText.indexOf('migrate') !== -1, 'migrate listed unverified');
  assert.ok(unverifiedText.indexOf('rollback') !== -1, 'rollback listed unverified');
  assert.strictEqual(evidence.assertions[0].verifiedClaims.length, 4, 'init, restart, identity and reset still verified');
  fs.rmSync(ctx.deps.config.evidenceRoot, { recursive: true, force: true });
});

test('environmentReset: task record build carries all canonical fields and honest cleanupResetResult', function() {
  var task = taskFor('CAN-B1-07');
  var evidence = {
    executionRevision: 'rev-er',
    environmentIdentity: { runId: 'run-x', gitHead: 'deadbeef1234', cloneId: 'c1' },
    commandInvocation: 'approved lifecycle wrapper (source: deps.runWrapper; phases: init, migrate, rollback, restart)',
    checks: { wrapperReported: true, noDirectRestart: true, wrapperAbsent: false },
    resetCleanupResult: { ok: true, result: 'clean clone reset and temporary data cleaned' },
    wrapperAbsent: false
  };
  var record = executors.buildRecord({
    task: task,
    workspace: { workspaceId: 'ws', workspacePath: '/tmp/ws' },
    runEnvRecord: { runId: 'run-x', gitHead: 'deadbeef1234' },
    manifest: { source: { referenceCommit: 'ref1' } }
  }, task, { success: true, actual: task.expectedResult, error: null }, evidence);

  assert.strictEqual(record.canonicalId, 'CAN-B1-07');
  assert.strictEqual(record.environmentIdentity.gitHead, 'deadbeef1234');
  assert.strictEqual(record.cleanupResetResult.ok, true);
  assert.strictEqual(record.result, RESULT_READINESS_PASS);
  assert.strictEqual(record.coverage, 'readiness-subset');
  assert.ok(record.stateChanges.noDirectRestart === true, 'record states no direct restart happened');

  var blockEvidence = {
    executionRevision: 'rev-er',
    environmentIdentity: { runId: 'run-x', gitHead: 'deadbeef1234' },
    checks: { wrapperReported: false, noDirectRestart: true, wrapperAbsent: true },
    resetCleanupResult: { ok: false, skipped: true, reason: 'approved wrapper absent; clean init/migrate/rollback/restart and reset/cleanup not performed' },
    wrapperAbsent: true
  };
  var blockRecord = executors.buildRecord({
    task: task,
    workspace: {},
    runEnvRecord: { runId: 'run-x', gitHead: 'deadbeef1234' },
    manifest: {}
  }, task, { success: false, actual: null, error: 'approved lifecycle wrapper is absent', errorCode: 'VALIDATION_ERROR' }, blockEvidence);
  assert.strictEqual(blockRecord.result, 'BLOCK');
  assert.strictEqual(blockRecord.classification, 'CLIENT_INPUT_SCOPE');
  assert.strictEqual(blockRecord.cleanupResetResult.ok, false, 'blocked run records no reset performed');
});
