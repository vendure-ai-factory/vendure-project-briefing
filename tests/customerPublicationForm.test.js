'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');

var executors = require('../src/executors/customerPublicationForm');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var RESULT_PASS = terminalState.RESULT_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;
var REPO_ROOT = path.resolve(__dirname, '..');

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({}, items || {}); };
}

function baseContext(overrides) {
  overrides = overrides || {};
  var base = {
    taskId: 'CAN-B2-02',
    task: {
      canonicalId: 'CAN-B2-02',
      summaryIds: ['B2-02'],
      requiredInputs: ['stagingUrl', 'testAccounts', 'productsImagesArchiveRoot'],
      expectedResult: 'expected result for CAN-B2-02'
    },
    repoRoot: REPO_ROOT,
    runEnvRecord: { runId: 'run-b2-02', gitHead: 'cafef00d1234', revisionId: 'rev-t' },
    deps: {
      clock: overrides.clock || fakeClock()
    }
  };
  if (overrides.env) base.deps.getEnv = envWith(overrides.env);
  if (overrides.extraDeps) Object.assign(base.deps, overrides.extraDeps);
  if (overrides.runId) base.runId = overrides.runId;
  if (overrides.runEnvRecord) base.runEnvRecord = overrides.runEnvRecord;
  if (overrides.fixtures) base.fixtures = overrides.fixtures;
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

var FULL_ADMIN_ENV = {
  SUPERADMIN_USERNAME: 'designer-one@example.com',
  SUPERADMIN_PASSWORD: 'supprt-pw-placeholder',
  VENDURE_ADMIN_API_URL: 'http://127.0.0.1:54321'
};

test('customerPublicationForm: register registers CAN-B2-02', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.deepStrictEqual(reg.registered, ['CAN-B2-02']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-02'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-02');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-02-A01']);
  executorModule.resetTaskExecutors();
});

test('customerPublicationForm: buildForm picks overall image and differing-name pairs', function(t) {
  var form = executors.buildForm({ repoRoot: REPO_ROOT });
  assert.strictEqual(form.ok, true, form.error);
  assert.ok(/(^|\/)0\.[^.]+$/.test(form.overall.rel), 'overall image is the master (basename 0)');
  assert.ok(form.pairs.length > 0, 'at least one pair built');
  assert.ok(form.pairs.every(function(p) { return path.basename(p.designImage.rel) !== path.basename(p.effectImage.rel); }), 'pair filenames differ');
});

test('customerPublicationForm: normalization helpers are pure and deterministic', function(t) {
  assert.strictEqual(executors.normalizeUploadName('My Nail Design.jpg'), 'my-nail-design.jpg');
  assert.strictEqual(executors.normalizeUploadName(' My  Nail   Design .jpg '), 'my-nail-design-.jpg');
  assert.strictEqual(executors.normalizeUploadName('My/Nail\\Design.jpg'), 'my-nail-design.jpg');
  assert.strictEqual(executors.normalizeUploadName(' 2.JPG '), executors.normalizeUploadName('2.jpg'), 'case/whitespace collapse is deterministic');
  var form = executors.buildForm({ repoRoot: REPO_ROOT });
  var bytes = fs.readFileSync(form.overall.abs);
  var a = executors.contentAddressName('slug', form.overall.rel, bytes);
  var b = executors.contentAddressName('slug', form.overall.rel, bytes);
  assert.strictEqual(a, b, 'content address is stable');
  assert.ok(a.split('__').length === 3, 'content address has slug__name__fingerprint');
});

test('customerPublicationForm: missing admin identity -> BLOCK CLIENT_INPUT_SCOPE with preflight proof', async function() {
  var ctx = baseContext({ env: { VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1' } });
  ctx.deps.getEnv = envWith({ VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1' });
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.checks.absentNames.indexOf('SUPERADMIN_USERNAME') !== -1);
  assert.ok(outcome.evidence.checks.absentNames.indexOf('SUPERADMIN_PASSWORD') !== -1);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('customerPublicationForm: missing design set files -> ENVIRONMENT_ERROR DEPENDENCY_ENVIRONMENT', async function() {
  var ctx = baseContext({ env: FULL_ADMIN_ENV });
  // Point repoRoot at an empty temp dir so the fixture tree does not exist.
  ctx.repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-empty-'));
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-02');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('customerPublicationForm: form contract verified from local fixture evidence, READINESS_PASS', async function() {
  var evidenceFiles = [];
  var records = [];
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: 'run-b2-02-x',
    extraDeps: {
      writeEvidenceFile: function(runId, taskId, filename, content, opts) {
        evidenceFiles.push({ runId: runId, taskId: taskId, filename: filename, content: content, opts: opts });
      },
      writeTaskRecord: function(runId, taskId, record, opts) {
        records.push({ runId: runId, taskId: taskId, record: record, opts: opts });
      }
    }
  });
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  assert.strictEqual(outcome.success, true, outcome.error);
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'handler result is READINESS_PASS');

  var ev = outcome.evidence;
  assert.strictEqual(ev.coverage, 'readiness-subset');
  assert.strictEqual(ev.executionRevision, 'cafef00d1234');
  assert.strictEqual(ev.checks.acceptsDesignName, true);
  assert.strictEqual(ev.checks.acceptsOverallImage, true);
  assert.strictEqual(ev.checks.acceptsPairedUploads, true);
  assert.strictEqual(ev.checks.acceptsDesignFeeAndCountries, true);
  assert.strictEqual(ev.checks.pairingOneToOne, true);
  assert.strictEqual(ev.checks.namesNormalizedDeterministically, true);
  assert.strictEqual(ev.checks.overallImageIsMaster, true);
  assert.strictEqual(ev.checks.pairFilenamesDiffer, true);
  assert.strictEqual(ev.checks.allVerified, true);
  assert.strictEqual(ev.live.attempted, false, 'no live publish attempted without allowance');
  assert.ok(ev.unverified.length > 0, 'browser assertions listed as unverified');
  assert.ok(JSON.stringify(ev).indexOf(FULL_ADMIN_ENV.SUPERADMIN_PASSWORD) === -1, 'no secret value in evidence');
  assert.ok(ev.adminEnvNames.indexOf('SUPERADMIN_USERNAME') !== -1, 'records admin env NAME');
  assert.ok(ev.adminEnvNames.indexOf('SUPERADMIN_PASSWORD') !== -1);
  assert.strictEqual(evidenceFiles.length, 1, 'one evidence file written');
  assert.strictEqual(evidenceFiles[0].filename, 'executor-customer-form.json');
  assert.strictEqual(records.length, 1, 'one task record written');
  var rec = records[0].record;
  assert.strictEqual(rec.canonicalId, 'CAN-B2-02');
  assert.strictEqual(rec.scope, 'customer-publication-form');
  assert.strictEqual(rec.stateChanges.noPublish, true);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-02');
  assert.strictEqual(finalOutcome.result, RESULT_PASS, 'CLI finalizeTaskOutcome returns PASS for fully-matching run');
});

test('customerPublicationForm: live round trip -> publishAccepted and listing reflected', async function() {
  var server = http.createServer(function(req, res) {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      if (req.headers['content-type'] && req.headers['content-type'].indexOf('multipart/form-data') === 0) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { publishDesign: { success: true, productId: 'p1', sku: 'SKU-FIXTURE-1', message: 'published' } } }));
        return;
      }
      if (body.indexOf('MyDesigns') !== -1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { myDesigns: [{ productId: 'p1', name: executors.DEFAULT_DESIGN_NAME, sku: 'SKU-FIXTURE-1', designFee: 800, craftFee: 200, totalPrice: 1000, status: 'active', salesCount: 0, totalEarnings: 0, createdAt: '2026-10-07T09:00:00.000Z', featuredAssetUrl: 'http://x/0.jpg' }] } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  var port = await new Promise(function(resolve, reject) {
    server.listen(0, '127.0.0.1', function() { resolve(server.address().port); });
    server.on('error', reject);
  });
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: 'run-b2-02-live',
    extraDeps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      writeEvidenceFile: function() { return { ok: true }; },
      writeTaskRecord: function() { return { ok: true }; }
    }
  });
  ctx.shopApiBase = 'http://127.0.0.1:' + port;
  ctx.deps.getEnv = envWith(Object.assign({}, FULL_ADMIN_ENV, { CUSTOMER_PUBLISH_ALLOWED: '1' }));
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  await new Promise(function(resolve) { server.close(resolve); });
  assert.strictEqual(outcome.success, true, outcome.error);
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  var ev = outcome.evidence;
  assert.strictEqual(ev.live.attempted, true);
  assert.strictEqual(ev.live.allowed, true);
  assert.strictEqual(ev.live.publishAccepted, true);
  assert.strictEqual(ev.live.listingReflectsPublish, true);
  assert.strictEqual(ev.live.httpStatus, 200);
});

test('customerPublicationForm: publish not permitted -> live assertions unverified, still readiness pass', async function() {
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: 'run-b2-02-nolive',
    extraDeps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      writeEvidenceFile: function() { return { ok: true }; },
      writeTaskRecord: function() { return { ok: true }; }
    }
  });
  ctx.shopApiBase = 'http://127.0.0.1:9999';
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  assert.strictEqual(outcome.success, true, outcome.error);
  assert.strictEqual(outcome.evidence.live.attempted, false, 'no publish without explicit allowance');
  assert.ok(outcome.evidence.unverified.length > 0, 'live assertions listed as unverified');
});

test('customerPublicationForm: Shop API rejects publish -> EXPECTED_MISMATCH APPLICATION_DEFECT', async function() {
  var server = http.createServer(function(req, res) {
    req.on('data', function() {});
    req.on('end', function() {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { publishDesign: { success: false, message: 'rejected' } } }));
    });
  });
  var port = await new Promise(function(resolve, reject) {
    server.listen(0, '127.0.0.1', function() { resolve(server.address().port); });
    server.on('error', reject);
  });
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: 'run-b2-02-reject',
    extraDeps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      writeEvidenceFile: function() { return { ok: true }; },
      writeTaskRecord: function() { return { ok: true }; }
    }
  });
  ctx.shopApiBase = 'http://127.0.0.1:' + port;
  ctx.deps.getEnv = envWith(Object.assign({}, FULL_ADMIN_ENV, { CUSTOMER_PUBLISH_ALLOWED: '1' }));
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  await new Promise(function(resolve) { server.close(resolve); });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customerPublicationForm: Shop API HTTP 500 -> ENVIRONMENT_ERROR DEPENDENCY_ENVIRONMENT', async function() {
  var server = http.createServer(function(req, res) {
    req.on('data', function() {});
    req.on('end', function() {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'boom' }] }));
    });
  });
  var port = await new Promise(function(resolve, reject) {
    server.listen(0, '127.0.0.1', function() { resolve(server.address().port); });
    server.on('error', reject);
  });
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: 'run-b2-02-down',
    extraDeps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      writeEvidenceFile: function() { return { ok: true }; },
      writeTaskRecord: function() { return { ok: true }; }
    }
  });
  ctx.shopApiBase = 'http://127.0.0.1:' + port;
  ctx.deps.getEnv = envWith(Object.assign({}, FULL_ADMIN_ENV, { CUSTOMER_PUBLISH_ALLOWED: '1' }));
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  await new Promise(function(resolve) { server.close(resolve); });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
  assert.ok(JSON.stringify(outcome.evidence).indexOf(FULL_ADMIN_ENV.SUPERADMIN_PASSWORD) === -1, 'no secret leak');
});

test('customerPublicationForm: multipart body contains the exact form fields the form sends', function(t) {
  var form = executors.buildForm({ repoRoot: REPO_ROOT });
  var submission = executors.buildMultipartRequest({ repoRoot: REPO_ROOT }, form);
  var bodyText = submission.body.toString('utf8');
  assert.ok(bodyText.indexOf('mutation PublishDesign') !== -1, 'PublishDesign mutation present');
  assert.ok(bodyText.indexOf('variables.mainEffectImage') !== -1, 'overall image mapped');
  assert.ok(bodyText.indexOf('variables.designPairs.0.designImage') !== -1, 'pair 0 designImage mapped');
  assert.ok(bodyText.indexOf('variables.designPairs.0.effectImage') !== -1, 'pair 0 effectImage mapped');
  assert.ok(bodyText.indexOf('designFee') !== -1, 'design fee in variables');
  assert.ok(bodyText.indexOf('channelToken') !== -1, 'target countries in variables');
  assert.ok(bodyText.indexOf(executors.DEFAULT_DESIGN_NAME) !== -1, 'design name present');
  // Parse the operations field from the multipart body.
  var BOUNDARY = '----customerPublicationFormBoundary';
  var escapedB = BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp('name="operations"[\\r\\n]+[\\r\\n]+([\\s\\S]*?)[\\r\\n]+--' + escapedB);
  var match = re.exec(bodyText);
  assert.ok(match !== null && match[1] !== undefined, 'operations part captured from multipart body');
  var ops = JSON.parse(match[1]);
  assert.strictEqual(ops.variables.name, executors.DEFAULT_DESIGN_NAME);
  assert.ok(ops.query.indexOf('publishDesign') !== -1);
  assert.ok(Array.isArray(ops.variables.priceSettings) && ops.variables.priceSettings.length === form.priceSettings.length, 'priceSettings per target country');
  assert.ok(Array.isArray(ops.variables.designPairs) && ops.variables.designPairs.length === form.pairs.length, 'designPairs count matches');
});

test('customerPublicationForm: evidence via writeEvidenceFile contains verified and unverified assertions', async function() {
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b2-02-'));
  var runId = 'run-b2-02-' + Date.now().toString(36) + '-x9z';
  // Pre-create the evidence directory and run index (CLI initializes the index
  // before executors append files; writeEvidenceFile's auto-init double-joins
  // the baseDir, so the index must already exist at evidenceRoot/evidence/<runId>/.
  fs.mkdirSync(path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-02'), { recursive: true });
  evidenceCollector.initEvidenceIndex(runId, { executionRevision: 'rev-t' }, { root: evidenceRoot, baseDir: 'evidence' });
  var ctx = baseContext({
    env: FULL_ADMIN_ENV,
    runId: runId,
    runEnvRecord: { runId: runId, gitHead: 'cafef00d1234', revisionId: 'rev-t' }
  });
  ctx.deps.config = { evidenceRoot: evidenceRoot };
  ctx.deps.writeEvidenceFile = function(r, t, fn, content, opts) {
    var evidenceCollectorModule = require('../src/evidenceCollector');
    opts = Object.assign({}, opts || {}, { root: evidenceRoot });
    return evidenceCollectorModule.writeEvidenceFile(r, t, fn, content, opts);
  };
  ctx.deps.writeTaskRecord = function(r, t, record, opts) {
    var recordCollectorModule = require('../src/evidenceCollector');
    opts = Object.assign({}, opts || {}, { root: evidenceRoot });
    return recordCollectorModule.writeTaskRecord(r, t, record, opts);
  };
  var outcome = await executors.handlerCustomerPublicationForm(ctx);
  assert.strictEqual(outcome.success, true, outcome.error);
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-02');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  var evFile = path.join(taskDir, 'executor-customer-form.json');
  assert.strictEqual(fs.existsSync(evFile), true, 'evidence file written');
  var serialized = fs.readFileSync(evFile, 'utf8');
  assert.strictEqual(serialized.indexOf(FULL_ADMIN_ENV.SUPERADMIN_PASSWORD), -1, 'secret value redacted from evidence');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
