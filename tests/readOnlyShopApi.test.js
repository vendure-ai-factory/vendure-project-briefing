'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var executors = require('../src/executors/readOnlyShopApi');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_PASS = terminalState.RESULT_PASS;

function fakeClock(iso) {
  var current = new Date(iso || '2026-10-07T09:00:00.000Z');
  return function() {
    return new Date(current.getTime());
  };
}

/**
 * Build a fake fetch acting as a tiny fake Shop API server keyed by the
 * vendure-token header. Each token maps to { status, body }.
 */
function fakeShopServer(tokenResponses) {
  return function fakeFetch(url, init) {
    var headers = init && init.headers ? init.headers : {};
    var body = init && init.body ? init.body : '';
    var token = headers['vendure-token'];
    var handler = tokenResponses[token];

    if (!handler || typeof handler !== 'object') {
      return Promise.resolve({
        status: 404,
        text: function() { return Promise.resolve('unknown channel token'); }
      });
    }
    var responseBody = typeof handler.body === 'string' ? handler.body : JSON.stringify(handler.body);
    return Promise.resolve({
      status: handler.status || 200,
      ok: handler.status ? handler.status >= 200 && handler.status < 300 : true,
      text: function() {
        return Promise.resolve(responseBody);
      }
    });
  };
}

var TOKENS = { de: 'de-token', at: 'at-token', hu: 'hu-token', gb: 'gb-token' };
var TOKENS_JSON = JSON.stringify(TOKENS);

function b1_03Item(name, price, currencyCode) {
  return {
    name: name,
    variants: [{ price: price, currencyCode: currencyCode }]
  };
}

function b1_03Body(currencyCode, items) {
  return {
    data: {
      activeChannel: { currencyCode: currencyCode },
      products: { items: items }
    }
  };
}

function correctB1_03Server() {
  return fakeShopServer({
    'de-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('DE product', 2500, 'EUR')]) },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: b1_03Body('HUF', [b1_03Item('HU product', 875000, 'HUF')]) },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
}

function taskFor(taskId, expectedResult) {
  return {
    canonicalId: taskId,
    expectedResult: expectedResult || ('expected result for ' + taskId)
  };
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var base = {
    taskId: taskId,
    task: taskFor(taskId, 'expected result for ' + taskId),
    deps: {
      fetch: overrides.fetch,
      clock: overrides.clock || fakeClock(),
      getEnv: overrides.getEnv || function() { return { CHANNEL_TOKENS: TOKENS_JSON }; },
      mkdirSync: overrides.mkdirSync || function() {},
      writeFileSync: overrides.writeFileSync || function() {},
      readFileSync: overrides.readFileSync || function() { return null; },
      fs: overrides.fs || require('fs'),
      config: overrides.config || {}
    },
    shopApiBase: overrides.shopApiBase || 'https://staging.tibella.eu'
  };
  if (overrides.evidenceRoot) {
    base.deps.config.evidenceRoot = overrides.evidenceRoot;
  }
  if (overrides.runEnvRecord) base.runEnvRecord = overrides.runEnvRecord;
  if (overrides.workspace) base.workspace = overrides.workspace;
  if (overrides.plantedMismatch) {
    base.plantedMismatch = overrides.plantedMismatch;
  }
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

// ---------------------------------------------------------------------------
// CAN-B1-03
// ---------------------------------------------------------------------------

test('readOnlyShopApi B1-03: all correct returns PASS with expected == actual', async function(t) {
  var ctx = baseContext('CAN-B1-03', {
    fetch: correctB1_03Server(),
    clock: fakeClock()
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.errorCode, null);
  assert.strictEqual(outcome.result, RESULT_PASS, 'must use RESULT_PASS, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B1-03', 'actual mirrors the canonical expected result');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.expected.countryCurrencyMap.DE, 'EUR');
  assert.strictEqual(outcome.evidence.actual.countryCurrencyMap.HU, 'HUF');
  assert.strictEqual(outcome.evidence.table.length, 4, 'one table row per country');
  assert.strictEqual(outcome.evidence.checks.mismatchCount, 0, 'no mismatches');
  assert.strictEqual(outcome.evidence.rawRequests.length, 4, 'raw request per country');
  assert.strictEqual(outcome.evidence.rawResponses.length, 4, 'raw response per country');
  // channel tokens are redacted from evidence
  assert.strictEqual(outcome.evidence.rawRequests[0].headers['vendure-token'], '[REDACTED]', 'token redacted');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, RESULT_PASS);
});

test('readOnlyShopApi B1-03: DE returning GBP is an APPLICATION_DEFECT', async function(t) {
  var server = fakeShopServer({
    'de-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('DE product', 2200, 'GBP')]) },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: b1_03Body('HUF', [b1_03Item('HU product', 875000, 'HUF')]) },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('DE') !== -1, 'error names DE');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
});

test('readOnlyShopApi B1-03: HTTP 500 is a DEPENDENCY_ENVIRONMENT', async function(t) {
  var server = fakeShopServer({
    'de-token': { status: 500, body: { errors: [{ message: 'boom' }] } },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: b1_03Body('HUF', [b1_03Item('HU product', 875000, 'HUF')]) },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('500') !== -1, 'error mentions HTTP 500');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
});

test('readOnlyShopApi B1-03: missing channel token is a CLIENT_INPUT_SCOPE', async function(t) {
  var ctx = baseContext('CAN-B1-03', {
    fetch: correctB1_03Server(),
    getEnv: function() { return {}; }
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.error.indexOf('CHANNEL_TOKENS') !== -1, 'error mentions CHANNEL_TOKENS');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'CLIENT_INPUT_SCOPE');
});

// ---------------------------------------------------------------------------
// CAN-B1-04
// ---------------------------------------------------------------------------

function b1_04Body(products) {
  return { data: { products: { items: products } } };
}

function visibleProduct(id, name, slug, variants) {
  return {
    id: id,
    name: name,
    slug: slug,
    enabled: true,
    variants: variants
  };
}

function variant(id, sku, name, price, currencyCode) {
  return { id: id, sku: sku, name: name, enabled: true, price: price, currencyCode: currencyCode };
}

function correctB1_04Server() {
  return fakeShopServer({
    'de-token': { status: 200, body: b1_04Body([
      visibleProduct('p1', 'Design One', 'design-one', [variant('v1', 'SKU-DE-1', 'Design One / S', 2500, 'EUR'), variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]),
      visibleProduct('p3', 'Design Two', 'design-two', [variant('v3', 'SKU-DE-2', 'Design Two / S', 2600, 'EUR')])
    ]) },
    'at-token': { status: 200, body: b1_04Body([
      visibleProduct('p1', 'Design One', 'design-one', [variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')])
    ]) },
    'hu-token': { status: 200, body: b1_04Body([
      visibleProduct('p4', 'Design HU', 'design-hu', [variant('v4', 'SKU-HU-1', 'Design HU / S', 875000, 'HUF')])
    ]) },
    'gb-token': { status: 200, body: b1_04Body([
      visibleProduct('p5', 'Design GB', 'design-gb', [variant('v5', 'SKU-GB-1', 'Design GB / S', 2200, 'GBP')])
    ]) }
  });
}

function realWorkspace() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b1-04-'));
  var ws = { workspaceId: 'ws-test', workspacePath: dir, runId: 'run-test', exists: true };
  return {
    ws: ws,
    deps: {
      mkdirSync: function(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); },
      writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
      readFileSync: function(p, enc) { return fs.readFileSync(p, enc || 'utf8'); }
    }
  };
}

test('readOnlyShopApi B1-04: creates + hashes fixture, all correct -> PASS', async function(t) {
  var real = realWorkspace();
  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_PASS);
  // The fixture and its hash are recorded in the returned evidence; the
  // recorded sha256 must equal a fresh hash of the recorded fixture content.
  assert.strictEqual(outcome.evidence.fixture.action, 'CREATED');
  assert.ok(outcome.evidence.fixture.sha256, 'fixture sha256 recorded');
  var recomputedFromEvidence = crypto.createHash('sha256')
    .update(JSON.stringify(outcome.evidence.fixture.expected, null, 2) + '\n')
    .digest('hex');
  assert.strictEqual(outcome.evidence.fixture.sha256, recomputedFromEvidence, 'recorded hash matches recorded fixture content');
  assert.strictEqual(outcome.evidence.isolationReport.variantLeaks.length, 0, 'no leaks');
  // The executor destroyed its workspace before returning.
  assert.strictEqual(fs.existsSync(real.ws.workspacePath), false, 'workspace cleaned up by executor');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, RESULT_PASS);
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi B1-04: loaded fixture that differs is APPLICATION_DEFECT', async function(t) {
  var real = realWorkspace();
  // Write a fixture in advance that omits the DE-visible variant SKU-DE-1.
  var fixture = {
    DE: [ { id: 'p1', name: 'Design One', slug: 'design-one', enabled: true, variants: [] } ],
    AT: [],
    HU: [],
    GB: []
  };
  fs.writeFileSync(path.join(real.ws.workspacePath, 'expected-visibility.json'), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(real.ws.workspacePath, 'expected-visibility.sha256'),
    crypto.createHash('sha256').update(JSON.stringify(fixture, null, 2) + '\n').digest('hex') + '\n', 'utf8');

  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.evidence.isolationReport.variantLeaks.length >= 1, 'leak reported');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi B1-04: planted-mismatch control run is detected', async function(t) {
  var real = realWorkspace();
  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync,
    plantedMismatch: { plant: true, country: 'DE' }
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, false, 'planted mismatch must be detected');
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.evidence.control && outcome.evidence.control.detected === true, 'control run detected the planted mismatch');
  assert.ok(outcome.evidence.isolationReport.variantLeaks.length >= 1, 'leak found between planted fixture and live response');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi: register() registers CAN-B1-03 and CAN-B1-04', async function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-03'), true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-04'), true);
  assert.deepStrictEqual(executorModule.listTaskExecutors().sort(), ['CAN-B1-03', 'CAN-B1-04']);
  executorModule.resetTaskExecutors();
});

test('readOnlyShopApi B1-03: evidence written through writeEvidenceFile and verifyEvidence passes', async function(t) {
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b1-03-'));
  var runId = 'run-eu-' + Date.now().toString(36) + '-a1b';
  var ctx = baseContext('CAN-B1-03', {
    fetch: correctB1_03Server(),
    evidenceRoot: evidenceRoot,
    runEnvRecord: { runId: runId, stagingUrl: 'https://staging.tibella.eu' }
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-03');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'country-table.json', 'expected-vs-actual.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted in raw request evidence');
  assert.strictEqual(serialized.indexOf('at-token'), -1, 'channel token redacted in raw request evidence');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, RESULT_PASS);
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('readOnlyShopApi B1-04: evidence written through writeEvidenceFile and verifyEvidence passes', async function(t) {
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b1-04-'));
  var runId = 'run-eu-' + Date.now().toString(36) + '-c2d';
  var real = realWorkspace();
  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync,
    evidenceRoot: evidenceRoot,
    runEnvRecord: { runId: runId, stagingUrl: 'https://staging.tibella.eu' }
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-04');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'expected-vs-actual.json', 'isolation-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('readOnlyShopApi B1-03: EPERM workspace cleanup fails the run (never PASS)', async function(t) {
  var wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-eperm-'));
  var throwingFs = Object.assign({}, require('fs'), {
    rmSync: function() {
      var e = new Error('EPERM: operation not permitted, rmdir');
      e.code = 'EPERM';
      throw e;
    }
  });
  var ctx = baseContext('CAN-B1-03', {
    fetch: correctB1_03Server(),
    fs: throwingFs,
    workspace: { workspaceId: 'ws-eperm', workspacePath: wsDir, runId: 'run-eperm', exists: true }
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false, 'cleanup failure fails the task');
  assert.strictEqual(outcome.result, null, 'never a passing result');
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.evidence.cleanupResetResult && outcome.evidence.cleanupResetResult.ok === false,
    'cleanupResetResult recorded as failed in evidence');
  assert.strictEqual(outcome.evidence.cleanupResetResult.code, 'EPERM');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.notStrictEqual(finalOutcome.result, RESULT_PASS, 'cleanup failure must not be PASS');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(wsDir, { recursive: true, force: true });
});

test('readOnlyShopApi: staging URL resolves from frozen run input with env override', function(t) {
  var frozen = { runEnvRecord: { stagingUrl: 'https://frozen.example' }, deps: { getEnv: function() { return {}; }, config: {} } };
  assert.strictEqual(executors.resolveShopApiBase(frozen), 'https://frozen.example');
  var envOverride = { runEnvRecord: { stagingUrl: 'https://frozen.example' }, deps: { getEnv: function() { return { STAGING_URL: 'http://127.0.0.1:9999' }; }, config: {} } };
  assert.strictEqual(executors.resolveShopApiBase(envOverride), 'http://127.0.0.1:9999');
  var contextOverride = { runEnvRecord: { stagingUrl: 'https://frozen.example' }, deps: { config: {} }, shopApiBase: 'http://localhost:1/' };
  assert.strictEqual(executors.resolveShopApiBase(contextOverride), 'http://localhost:1');
});


test('readOnlyShopApi: channel tokens resolve from frozen registry value without env', function(t, done) {
  var registry = { inputs: [ { id: 'channelTokens', frozenValue: { DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' } } ] };
  var result = executors.resolveChannelTokens(function() { return {}; }, executors.frozenChannelTokensFromContext({ registry: registry }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'frozen');
  assert.strictEqual(result.tokens.DE, 'de-token');
  assert.strictEqual(result.tokens.AT, 'at-token');
  assert.strictEqual(result.tokens.HU, 'hu-token');
  assert.strictEqual(result.tokens.GB, 'gb-token');
  done();
});

test('readOnlyShopApi: env CHANNEL_TOKENS overrides the frozen registry value', function(t, done) {
  var registry = { inputs: [ { id: 'channelTokens', frozenValue: { DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' } } ] };
  var envJson = JSON.stringify({ DE: 'env-de', AT: 'env-at', HU: 'env-hu', GB: 'env-gb' });
  var result = executors.resolveChannelTokens(function() { return { CHANNEL_TOKENS: envJson }; }, executors.frozenChannelTokensFromContext({ registry: registry }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'env');
  assert.strictEqual(result.tokens.DE, 'env-de');
  assert.strictEqual(result.tokens.AT, 'env-at');
  assert.strictEqual(result.tokens.HU, 'env-hu');
  assert.strictEqual(result.tokens.GB, 'env-gb');
  done();
});

test('readOnlyShopApi: direct context.channelTokens has highest precedence', function(t, done) {
  var registry = { inputs: [ { id: 'channelTokens', frozenValue: { DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' } } ] };
  var context = {
    channelTokens: { DE: 'ctx-de', AT: 'ctx-at', HU: 'ctx-hu', GB: 'ctx-gb' },
    registry: registry
  };
  var result = executors.resolveChannelTokens(
    function() { return { CHANNEL_TOKENS: JSON.stringify({ DE: 'env-de', AT: 'env-at', HU: 'env-hu', GB: 'env-gb' }) }; },
    executors.frozenChannelTokensFromContext(context),
    executors.contextChannelTokens(context)
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'context', 'context value wins over env and frozen');
  assert.strictEqual(result.tokens.DE, 'ctx-de');
  done();
});
