'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var childProcess = require('child_process');

var executors = require('../src/executors/platformPublication');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var REPO_ROOT = path.resolve(__dirname, '..');

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function taskFor(taskId, expectedResult) {
  return {
    canonicalId: taskId,
    summaryIds: ['B2-01'],
    requiredInputs: ['stagingUrl', 'testAccounts', 'productsImagesArchiveRoot'],
    expectedResult: expectedResult || ('expected result for ' + taskId)
  };
}

function realWorkspace(prefix) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ws-pp-'));
  return { workspaceId: 'ws-pp', workspacePath: dir, runId: 'run-pp', exists: true };
}

function baseDeps(execFile) {
  return {
    execFile: execFile || childProcess.execFile,
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    mkdirSync: function(p, o) { fs.mkdirSync(p, o || { recursive: true }); },
    readFileSync: function(p, e) { return fs.readFileSync(p, e || 'utf8'); },
    readdirSync: function(p, o) { return fs.readdirSync(p, o || { withFileTypes: true }); },
    existsSync: function(p) { return fs.existsSync(p); }
  };
}

function envWith(items) {
  return function() { return Object.assign({}, items); };
}

function baseContext(overrides) {
  overrides = overrides || {};
  var ws = overrides.workspace || realWorkspace();
  var base = {
    taskId: 'CAN-B2-01',
    task: taskFor('CAN-B2-01', 'expected result for CAN-B2-01'),
    workspace: ws,
    runEnvRecord: { runId: ws.runId, gitHead: 'cafef00d1234', revisionId: 'rev-t' },
    repoRoot: REPO_ROOT,
    deps: baseDeps(overrides.execFile),
    deps2: null
  };
  if (overrides.env) base.deps.getEnv = envWith(overrides.env);
  if (overrides.extraDeps) Object.assign(base.deps, overrides.extraDeps);
  if (overrides.fixtures) base.fixtures = overrides.fixtures;
  if (overrides.runId) base.runId = overrides.runId;
  return base;
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

const FULL_ADMIN_ENV = {
  SUPERADMIN_USERNAME: 'admin',
  SUPERADMIN_PASSWORD: 'pw',
  VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1'
};

test('platformPublication: register and manifest build', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.deepStrictEqual(reg.registered, ['CAN-B2-01']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-01'), true);
  assert.strictEqual(typeof executorModule.getTaskExecutor('CAN-B2-01').handler, 'function');
  executorModule.resetTaskExecutors();

  var m = executors.buildManifest({ repoRoot: REPO_ROOT });
  assert.ok(m.manifest.product.featuredAssetPath, 'overall image present');
  assert.ok(/(^|\/)0\.[^.]+$/.test(m.manifest.product.featuredAssetPath), 'overall is the master (basename 0)');
  assert.strictEqual(m.manifest.product.slug, executors.PRODUCT_SLUG);
  assert.strictEqual(m.manifest.sync.restartStorefront, false, 'sync.restartStorefront=false');
  assert.strictEqual(m.manifest.variants[0].sku, executors.DEFAULT_SKU);
  assert.strictEqual(m.manifest.variants[0].countryCode, 'DE');
  assert.strictEqual(executors.CURRENCY_BY_COUNTRY[m.manifest.variants[0].countryCode], 'EUR');
  var effectPaths = m.files.map(function(f) { return f.rel; }).filter(function(rel) { return rel !== m.manifest.product.featuredAssetPath; });
  assert.ok(effectPaths.length > 0, 'effect images exist');
  assert.ok(effectPaths.indexOf(m.manifest.product.featuredAssetPath) === -1, 'overall image is not among the effect images');
});

test('platformPublication: admin identity resolved from env, names only', function(t) {
  var id = executors.adminIdentity({ deps: { getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'x', VENDURE_ADMIN_API_URL: 'http://h' }) } });
  assert.strictEqual(id.ok, true);
  assert.deepStrictEqual(id.presentNames, ['SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD', 'VENDURE_ADMIN_API_URL']);
  assert.deepStrictEqual(id.absentNames, []);
});

test('platformPublication: MISSING ADMIN IDENTITY -> BLOCK CLIENT_INPUT_SCOPE with preflight proof', async function() {
  var ctx = baseContext({ env: { VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1' } });
  delete ctx.deps.getEnv;
  ctx.deps.getEnv = envWith({ VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1' });
  var outcome = await executors.handlerPlatformPublication(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.checks.absentNames.indexOf('SUPERADMIN_USERNAME') !== -1, 'preflight names the absent env var');
  assert.ok(outcome.evidence.checks.absentNames.indexOf('SUPERADMIN_PASSWORD') !== -1);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-01');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'CLIENT_INPUT_SCOPE');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('platformPublication: script missing -> ENVIRONMENT_ERROR DEPENDENCY_ENVIRONMENT', async function() {
  var ctx = baseContext({ env: FULL_ADMIN_ENV, extraDeps: {
    existsSync: function(p) { return String(p).indexOf(executors.NODE_SCRIPT) === -1; }
  } });
  var outcome = await executors.handlerPlatformPublication(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-01');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('platformPublication: script fails -> ENVIRONMENT_ERROR DEPENDENCY_ENVIRONMENT', async function() {
  var ctx = baseContext({ env: FULL_ADMIN_ENV, extraDeps: {
    execFile: function(file, args, options, cb) { cb({ code: 1, message: 'script boom' }, '', 'boom'); }
  } });
  // note: script exists via real fs, so bash path is used
  var outcome = await executors.handlerPlatformPublication(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-01');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('platformPublication: non-dry-run result -> EXPECTED_MISMATCH APPLICATION_DEFECT', async function() {
  var ctx = baseContext({ env: FULL_ADMIN_ENV, extraDeps: {
    execFile: function(file, args, options, cb) {
      var artifact = options.env.PUBLISH_PRODUCT_ARTIFACT_DIR;
      fs.mkdirSync(artifact, { recursive: true });
      fs.writeFileSync(path.join(artifact, executors.RESULT_FILE), JSON.stringify({ manifestPath: 'x', dryRun: false, targetChannels: [], status: 'passed' }, null, 2), 'utf8');
      cb(null, 'PASS', '');
    }
  } });
  var outcome = await executors.handlerPlatformPublication(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-01');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('platformPublication: PASS path with fake server write result.json', async function() {
  var evidenceFiles = [];
  var records = [];
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: 'run-x',
    extraDeps: {
      execFile: function(file, args, options, cb) {
        var artifact = options.env.PUBLISH_PRODUCT_ARTIFACT_DIR;
        fs.mkdirSync(artifact, { recursive: true });
        fs.writeFileSync(path.join(artifact, executors.RESULT_FILE), JSON.stringify({ manifestPath: options.env.PUBLISH_PRODUCT_MANIFEST, dryRun: true, targetChannels: [{ id: 'ch1', code: 'default', token: 'de-token', priceFactor: 1 }], status: 'dry-run' }, null, 2), 'utf8');
        cb(null, 'DRY RUN publish product fixture-1-nail-design\n', '');
      },
      writeEvidenceFile: function(runId, taskId, filename, content, opts) {
        evidenceFiles.push({ runId: runId, taskId: taskId, filename: filename, content: content, opts: opts });
      },
      writeTaskRecord: function(runId, taskId, record, opts) {
        records.push({ runId: runId, taskId: taskId, record: record, opts: opts });
      }
    }
  });
  var outcome = await executors.handlerPlatformPublication(ctx);
  assert.strictEqual(outcome.success, true, outcome.error);
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-01');

  var ev = outcome.evidence;
  assert.strictEqual(ev.coverage, 'readiness-subset');
  assert.strictEqual(ev.executionRevision, 'cafef00d1234');
  assert.strictEqual(ev.checks.resultStatusDryRun, true);
  assert.strictEqual(ev.checks.noPublish, true);
  assert.strictEqual(ev.checks.syncRestartStorefrontFalse, true);
  assert.strictEqual(ev.checks.overallNotAmongEffectImages, true);
  assert.ok(ev.adminEnvNames.indexOf('SUPERADMIN_USERNAME') !== -1, 'records admin env NAME');
  assert.ok(ev.adminEnvNames.indexOf('SUPERADMIN_PASSWORD') !== -1);
  assert.ok(String(ev.manifest).indexOf('pw') === -1, 'secret value not present in evidence manifest');
  assert.ok(String(ev.manifestSha256).length === 64, 'manifest sha recorded');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-01');
  assert.strictEqual(finalOutcome.result, terminalState.RESULT_PASS);

  assert.strictEqual(evidenceFiles.length, 1, 'evidence file written');
  assert.strictEqual(evidenceFiles[0].filename, 'executor-platform-publication.json');
  assert.strictEqual(records.length, 1, 'task record written');
  var rec = records[0].record;
  assert.strictEqual(rec.canonicalId, 'CAN-B2-01');
  assert.strictEqual(rec.exactScriptPath, executors.RUN_SCRIPT);
  assert.strictEqual(rec.scope, 'platform-publication');
  assert.strictEqual(rec.stateChanges.noPublish, true);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});
