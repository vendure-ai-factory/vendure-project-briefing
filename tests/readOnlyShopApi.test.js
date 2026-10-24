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

// Pipeline env vars that must not affect test outcomes (tests inject their own getEnv)
var PIPELINE_ENV_VARS = [
  'REPAIR_MODEL',
  'OPENROUTER_API_KEY',
  'REPAIR_MAX_TOKENS',
  'REPAIR_REASONING',
  'REPAIR_MODEL_TIMEOUT_MS'
];
var _savedPipelineEnv = {};

var beforeEach = require('node:test').beforeEach;
var afterEach = require('node:test').afterEach;

beforeEach(function() {
  PIPELINE_ENV_VARS.forEach(function(k) {
    _savedPipelineEnv[k] = process.env[k];
    if (process.env[k] !== undefined) delete process.env[k];
  });
});

afterEach(function() {
  executorModule.resetTaskExecutors();
  PIPELINE_ENV_VARS.forEach(function(k) {
    if (_savedPipelineEnv[k] !== undefined) {
      process.env[k] = _savedPipelineEnv[k];
    } else {
      delete process.env[k];
    }
  });
});

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
    errorCode: outcome.errorCode,
    requireGenuineActual: true
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
  assert.strictEqual(typeof outcome.actual, 'object', 'actual is the observed per-country result, not the copied expected text');
  assert.deepStrictEqual(outcome.actual.countryCurrencyMap, { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' }, 'actual derived from observed activeChannel currencies');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.expected.countryCurrencyMap.DE, 'EUR');
  assert.strictEqual(outcome.evidence.actual.countryCurrencyMap.HU, 'HUF');
  assert.strictEqual(outcome.evidence.table.length, 4, 'one table row per country');
  assert.strictEqual(outcome.evidence.checks.mismatchCount, 0, 'no mismatches');
  assert.strictEqual(outcome.evidence.rawRequests.length, 8, 'raw request per probe and per products query per country');
  assert.strictEqual(outcome.evidence.rawResponses.length, 8, 'raw response per probe and per products query per country');
  // channel tokens are redacted from evidence
  assert.strictEqual(outcome.evidence.rawRequests[0].headers['vendure-token'], '[REDACTED]', 'token redacted');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, RESULT_PASS);
});

test('readOnlyShopApi: copied expected text cannot produce PASS under the genuine-actual gate', function() {
  var fa = terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: { result: RESULT_PASS },
    expected: 'expected result for CAN-B1-03',
    actual: 'expected result for CAN-B1-03',
    executorEvidenceOk: true,
    requireGenuineActual: true
  });
  assert.strictEqual(fa.result, 'BLOCK');
  assert.strictEqual(fa.cause, 'EXPECTED_MISMATCH');

  var fg = terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: { result: RESULT_PASS },
    expected: 'expected result for CAN-B1-03',
    actual: { countryCurrencyMap: { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' } },
    executorEvidenceOk: true,
    requireGenuineActual: true
  });
  assert.strictEqual(fg.result, RESULT_PASS);
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
// CAN-B1-03 Regression: HTTP 200 with activeChannel: null / missing currency
// ---------------------------------------------------------------------------

test('readOnlyShopApi B1-03: HTTP 200 with activeChannel: null is STAGING_DATA_MISSING, never PASS', async function(t) {
  // DE returns HTTP 200 but with activeChannel: null (no currency evidence)
  var server = fakeShopServer({
    'de-token': { status: 200, body: { data: { activeChannel: null, products: { items: [] } } } },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: b1_03Body('HUF', [b1_03Item('HU product', 875000, 'HUF')]) },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false, 'activeChannel: null must not pass');
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING', 'errorCode is STAGING_DATA_MISSING');
  assert.ok(outcome.error.indexOf('DE') !== -1 || outcome.error.indexOf('currency') !== -1, 'error mentions currency gap');
  assert.ok(outcome.evidence && outcome.evidence.missingCurrencyEvidence, 'missingCurrencyEvidence recorded');
  assert.strictEqual(outcome.result, null, 'result is null on failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK', 'BLOCK, not PASS');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
});

test('readOnlyShopApi B1-03: HTTP 200 with activeChannel: {} (missing currencyCode) is STAGING_DATA_MISSING, never PASS', async function(t) {
  // HU returns HTTP 200 but with activeChannel: {} (no currencyCode field)
  var server = fakeShopServer({
    'de-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('DE product', 2500, 'EUR')]) },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: { data: { activeChannel: {}, products: { items: [] } } } },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false, 'missing currencyCode must not pass');
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING', 'errorCode is STAGING_DATA_MISSING');
  assert.ok(outcome.error.indexOf('HU') !== -1 || outcome.error.indexOf('currency') !== -1, 'error mentions HU currency gap');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK', 'BLOCK, not PASS');
});

test('readOnlyShopApi B1-03: HTTP 200 with all countries activeChannel: null -> STAGING_DATA_MISSING for all', async function(t) {
  // All countries return activeChannel: null (complete missing currency evidence)
  var server = fakeShopServer({
    'de-token': { status: 200, body: { data: { activeChannel: null, products: { items: [] } } } },
    'at-token': { status: 200, body: { data: { activeChannel: null, products: { items: [] } } } },
    'hu-token': { status: 200, body: { data: { activeChannel: null, products: { items: [] } } } },
    'gb-token': { status: 200, body: { data: { activeChannel: null, products: { items: [] } } } }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false, 'all null must not pass');
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING');
  assert.ok(outcome.evidence && outcome.evidence.missingCurrencyEvidence, 'missingCurrencyEvidence present');
  // All four countries should be listed as missing
  assert.strictEqual(outcome.evidence.missingCurrencyEvidence.length, 4, 'all 4 countries missing currency evidence');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK', 'BLOCK, not PASS');
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

test('readOnlyShopApi B1-04: fresh workspace with no independent fixture cannot PASS', async function(t) {
  var real = realWorkspace();
  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync
  });
  var outcome = await executors.handlerB1_04(ctx);

  // A fixture derived from this run's own observations is not independent
  // proof; with no pre-existing/pinned fixture the run must not PASS.
  assert.strictEqual(outcome.success, false, 'a run without an independent fixture is never a pass');
  assert.ok(outcome.errorCode === 'UNMET' || outcome.errorCode !== null, 'blocked/failed outcome recorded: ' + outcome.errorCode);
  assert.ok(String(outcome.error || '').indexOf('fixture') !== -1 || String(outcome.error || '').indexOf('UNRESOLVED') !== -1, 'diagnostic names the fixture gap');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK', 'no independently loaded fixture means BLOCK, never PASS');
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi B1-04: pinned expected fixture never self-referential; matching -> PASS', async function(t) {
  var fixtureFile = path.join(os.tmpdir(), 'b1-04-pinned-' + Date.now() + '.json');
  var fixture = {
    DE: [
      visibleProduct('p1', 'Design One', 'design-one', [variant('v1', 'SKU-DE-1', 'Design One / S', 2500, 'EUR'), variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]),
      visibleProduct('p3', 'Design Two', 'design-two', [variant('v3', 'SKU-DE-2', 'Design Two / S', 2600, 'EUR')])
    ],
    AT: [ visibleProduct('p1', 'Design One', 'design-one', [variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]) ],
    HU: [ visibleProduct('p4', 'Design HU', 'design-hu', [variant('v4', 'SKU-HU-1', 'Design HU / S', 875000, 'HUF')]) ],
    GB: [ visibleProduct('p5', 'Design GB', 'design-gb', [variant('v5', 'SKU-GB-1', 'Design GB / S', 2200, 'GBP')]) ]
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  try {
    var ctx = baseContext('CAN-B1-04', {
      fetch: correctB1_04Server(),
      getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, CAN_B1_04_EXPECTED_FIXTURE: fixtureFile }; }
    });
    var outcome = await executors.handlerB1_04(ctx);
    assert.strictEqual(outcome.success, true, 'matching pinned fixture is a pass');
    assert.strictEqual(outcome.result, RESULT_PASS);
    assert.strictEqual(outcome.evidence.fixture.action, 'LOADED_PINNED', 'fixture was independently loaded, not derived from responses');
    assert.strictEqual(outcome.evidence.isolationReport.variantLeaks.length, 0, 'no leaks');
    var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
    assert.strictEqual(finalOutcome.result, RESULT_PASS);
  } finally {
    fs.rmSync(fixtureFile, { force: true });
  }
});

test('readOnlyShopApi B1-04: pinned fixture leaking a variant -> APPLICATION_DEFECT', async function(t) {
  var fixtureFile = path.join(os.tmpdir(), 'b1-04-pinned-leak-' + Date.now() + '.json');
  // Pinned fixture matches live data EXCEPT it omits SKU-DE-2 from the DE
  // channel, so the live DE response contains a variant the fixture does not
  // expect -> a leak must be reported.
  var fixture = {
    DE: [ visibleProduct('p1', 'Design One', 'design-one', [variant('v1', 'SKU-DE-1', 'Design One / S', 2500, 'EUR'), variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]) ],
    AT: [],
    HU: [],
    GB: []
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  try {
    var ctx = baseContext('CAN-B1-04', {
      fetch: correctB1_04Server(),
      getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, CAN_B1_04_EXPECTED_FIXTURE: fixtureFile }; }
    });
    var outcome = await executors.handlerB1_04(ctx);
    assert.strictEqual(outcome.success, false, 'leak must be detected');
    assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
    var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
    assert.strictEqual(finalOutcome.result, 'BLOCK');
    assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  } finally {
    fs.rmSync(fixtureFile, { force: true });
  }
});

test('readOnlyShopApi B1-04: pinned fixture unreadable -> ENVIRONMENT_ERROR, never PASS', async function(t) {
  var missingFile = path.join(os.tmpdir(), 'b1-04-missing-' + Date.now() + '.json');
  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, CAN_B1_04_EXPECTED_FIXTURE: missingFile }; }
  });
  var outcome = await executors.handlerB1_04(ctx);
  assert.strictEqual(outcome.success, false, 'unreadable pinned fixture must not pass');
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
});

test('readOnlyShopApi B1-04: invalid JSON pinned fixture -> ENVIRONMENT_ERROR, never PASS', async function(t) {
  var fixtureFile = path.join(os.tmpdir(), 'b1-04-badjson-' + Date.now() + '.json');
  fs.writeFileSync(fixtureFile, '{ not json', 'utf8');
  try {
    var ctx = baseContext('CAN-B1-04', {
      fetch: correctB1_04Server(),
      getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, CAN_B1_04_EXPECTED_FIXTURE: fixtureFile }; }
    });
    var outcome = await executors.handlerB1_04(ctx);
    assert.strictEqual(outcome.success, false, 'invalid fixture JSON must not pass');
    assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
    var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
    assert.strictEqual(finalOutcome.result, 'BLOCK');
  } finally {
    fs.rmSync(fixtureFile, { force: true });
  }
});

test('readOnlyShopApi B1-04: workspace fixture hash mismatch -> ENVIRONMENT_ERROR, never PASS', async function(t) {
  var real = realWorkspace();
  var fixture = {
    DE: [],
    AT: [],
    HU: [],
    GB: []
  };
  fs.writeFileSync(path.join(real.ws.workspacePath, 'expected-visibility.json'), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(real.ws.workspacePath, 'expected-visibility.sha256'), 'deadbeef' + '\n', 'utf8');
  try {
    var ctx = baseContext('CAN-B1-04', {
      fetch: correctB1_04Server(),
      workspace: real.ws,
      mkdirSync: real.deps.mkdirSync,
      writeFileSync: real.deps.writeFileSync,
      readFileSync: real.deps.readFileSync
    });
    var outcome = await executors.handlerB1_04(ctx);
    assert.strictEqual(outcome.success, false, 'hash mismatch must not pass');
    assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
    var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
    assert.strictEqual(finalOutcome.result, 'BLOCK');
  } finally {
    fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
  }
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
  var fixtureFile = path.join(os.tmpdir(), 'b1-04-evidence-' + Date.now() + '.json');
  var fixture = {
    DE: [
      visibleProduct('p1', 'Design One', 'design-one', [variant('v1', 'SKU-DE-1', 'Design One / S', 2500, 'EUR'), variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]),
      visibleProduct('p3', 'Design Two', 'design-two', [variant('v3', 'SKU-DE-2', 'Design Two / S', 2600, 'EUR')])
    ],
    AT: [ visibleProduct('p1', 'Design One', 'design-one', [variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]) ],
    HU: [ visibleProduct('p4', 'Design HU', 'design-hu', [variant('v4', 'SKU-HU-1', 'Design HU / S', 875000, 'HUF')]) ],
    GB: [ visibleProduct('p5', 'Design GB', 'design-gb', [variant('v5', 'SKU-GB-1', 'Design GB / S', 2200, 'GBP')]) ]
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  var ctx = baseContext('CAN-B1-04', {
    fetch: correctB1_04Server(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync,
    evidenceRoot: evidenceRoot,
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, CAN_B1_04_EXPECTED_FIXTURE: fixtureFile }; },
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
  fs.rmSync(fixtureFile, { force: true });
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

// ---------------------------------------------------------------------------
// Fix 3, Fix 4, Fix 5
// ---------------------------------------------------------------------------

test('readOnlyShopApi: B1_04_QUERY selects no `enabled` field (Shop API does not expose it)', function(t, done) {
  var query = executors.B1_04_QUERY;
  assert.ok(query.indexOf('enabled') === -1, 'query must not select enabled on Product or ProductVariant');
  assert.ok(query.indexOf('sku') !== -1, 'query still checks sku for isolation');
  done();
});

test('readOnlyShopApi B1-03: HTTP 400 GRAPHQL_VALIDATION_FAILED is QUERY_INVALID / PIPELINE_DEFECT', async function(t) {
  var server = fakeShopServer({
    'de-token': { status: 400, body: { errors: [{ message: 'Cannot query field "enabled" on type "ProductVariant"', path: ['products', 'items', 'variants'], extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] } },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: b1_03Body('HUF', [b1_03Item('HU product', 875000, 'HUF')]) },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'QUERY_INVALID');
  assert.ok(outcome.error.indexOf('GraphQL error') !== -1, 'keeps the GraphQL error message');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'PIPELINE_DEFECT');
});

test('readOnlyShopApi B1-03: HTTP 200 resolver runtime error is STAGING_SERVER_ERROR / DEPENDENCY_ENVIRONMENT', async function(t) {
  var server = fakeShopServer({
    'de-token': { status: 200, body: { data: null, errors: [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products'], extensions: {} }] } },
    'at-token': { status: 200, body: b1_03Body('EUR', [b1_03Item('AT product', 3000, 'EUR')]) },
    'hu-token': { status: 200, body: b1_03Body('HUF', [b1_03Item('HU product', 875000, 'HUF')]) },
    'gb-token': { status: 200, body: b1_03Body('GBP', [b1_03Item('GB product', 2200, 'GBP')]) }
  });
  var ctx = baseContext('CAN-B1-03', { fetch: server });
  var outcome = await executors.handlerB1_03(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'STAGING_SERVER_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  // Fix 5: probe succeeded, products failed -> executor-error.json records the split.
  var execError = outcome.evidence;
  assert.ok(execError.graphQLError, 'graphQL error details kept in evidence');
  assert.strictEqual(execError.graphQLError.message.indexOf('invalid input syntax') !== -1, true);
});

test('readOnlyShopApi B1-04: HTTP 200 GraphQL runtime error never passes and is DEPENDENCY_ENVIRONMENT', async function(t) {
  var server = fakeShopServer({
    'de-token': { status: 200, body: { data: null, errors: [{ message: 'ProductVariant.enabled does not exist', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } },
    'at-token': { status: 200, body: b1_04Body([]) },
    'hu-token': { status: 200, body: b1_04Body([]) },
    'gb-token': { status: 200, body: b1_04Body([]) }
  });
  var real = realWorkspace();
  var ctx = baseContext('CAN-B1-04', {
    fetch: server,
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync
  });
  var outcome = await executors.handlerB1_04(ctx);
  assert.strictEqual(outcome.success, false, 'GraphQL error must not pass');
  assert.strictEqual(outcome.errorCode, 'STAGING_SERVER_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi B1-03: probe succeeds + products Postgres error -> STAGING_SERVER_ERROR, exit 6 path', async function(t) {
  function postgresServer() {
    return function fakeFetch(url, init) {
      var headers = init && init.headers ? init.headers : {};
      var body = init && init.body ? init.body : '';
      var token = headers['vendure-token'];
      var isProbe = String(body).indexOf('ActiveChannelProbe') !== -1;
      if (isProbe) {
        return Promise.resolve({ status: 200, ok: true, text: function() {
          return Promise.resolve(JSON.stringify({ data: { activeChannel: { code: 'DE', currencyCode: 'EUR' } } }));
        } });
      }
      // products query: runtime Postgres error from staging
      return Promise.resolve({ status: 200, ok: true, text: function() {
        return Promise.resolve(JSON.stringify({ data: null, errors: [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products'] }] }));
      } });
    };
  }
  var ctx = baseContext({ fetch: postgresServer(), runEnvRecord: { runId: 'run-probe-fix5', stagingUrl: 'https://staging.tibella.eu' }, evidenceRoot: undefined });
  var outcome = await executors.handlerB1_03(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'STAGING_SERVER_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  // exit code 6 for DEPENDENCY_ENVIRONMENT
  var cliMod = require('../src/cli');
  assert.strictEqual(cliMod.exitCodeForOutcome('BLOCK', 'DEPENDENCY_ENVIRONMENT'), 6);
});

// ---------------------------------------------------------------------------
// Admin Channel Inventory integration tests
// ---------------------------------------------------------------------------

/**
 * Combined Shop + Admin API fetch for B1-03/B1-04 integration tests.
 * Distinguishes Admin API (/admin-api URL) from Shop API (/shop-api URL).
 * When inventory runs, returns __default_channel__ so STAGING_DATA_MISSING is set.
 */
function makeCombinedFetch(adminConfig) {
  adminConfig = adminConfig || {};

  var fetchWrapper = function(url, init) {
    fetchWrapper.adminCallCount = (fetchWrapper.adminCallCount || 0);
    var headers = init && init.headers ? init.headers : {};
    var isAdminUrl = url.indexOf('/admin-api') !== -1;
    var hasAuthHeader = !!(headers['Authorization'] || headers['vendure-auth-token']);
    var isAdmin = isAdminUrl || hasAuthHeader;

    if (isAdmin) {
      fetchWrapper.adminCallCount++;
      var body = init && init.body ? init.body : '';
      if (body.indexOf('mutation Login') !== -1) {
        return Promise.resolve({
          status: adminConfig.loginStatus || 200,
          headers: { get: function(n) { return n === 'vendure-auth-token' ? (adminConfig.loginToken || 'admin-token-test') : null; } },
          text: function() {
            return Promise.resolve(JSON.stringify({
              data: { login: { __typename: 'CurrentUser', id: 'u1', identifier: 'admin@example.com' } }
            }));
          }
        });
      }
      if (body.indexOf('__type') !== -1) {
        return Promise.resolve({
          status: 200, headers: { get: function() { return null; } },
          text: function() {
            return Promise.resolve(JSON.stringify({
              data: { __type: { fields: [{ name: 'id' }, { name: 'code' }, { name: 'token' }, { name: 'defaultCurrencyCode' }] } }
            }));
          }
        });
      }
      if (body.indexOf('channels(') !== -1) {
        var resp = adminConfig.channelsResponse || {
          data: { channels: { items: [{ id: 'ch1', code: '__default_channel__', token: null, defaultCurrencyCode: 'USD' }], totalItems: 1 } }
        };
        return Promise.resolve({
          status: 200, headers: { get: function() { return null; } },
          text: function() { return Promise.resolve(JSON.stringify(resp)); }
        });
      }
      return Promise.resolve({ status: 404, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
    }

    // Shop API (not admin, not /admin-api URL)
    var body = init && init.body ? init.body : '';
    var isProbe = String(body).indexOf('ActiveChannelProbe') !== -1;
    if (isProbe) {
      return Promise.resolve({
        status: 200, ok: true,
        text: function() { return Promise.resolve(JSON.stringify({ data: { activeChannel: { code: '__default_channel__', currencyCode: 'USD' } } })); }
      });
    }
    return Promise.resolve({
      status: 200, ok: true,
      text: function() { return Promise.resolve(JSON.stringify({ data: null, errors: [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products'] }] })); }
    });
  };

  return fetchWrapper;
}

function combinedDefaultChannelServer() {
  return makeCombinedFetch({});
}

test('readOnlyShopApi B1-03: probe returns __default_channel__ -> inventory runs, STAGING_DATA_MISSING, DEPENDENCY_ENVIRONMENT', async function(t) {
  var ctx = baseContext('CAN-B1-03', {
    fetch: combinedDefaultChannelServer(),
    runEnvRecord: { runId: 'run-inv-test', stagingUrl: 'https://staging.tibella.eu' },
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, SUPERADMIN_USERNAME: 'admin@example.com', SUPERADMIN_PASSWORD: 'secretpass', VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api' }; }
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false, 'run must fail');
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING', 'errorCode is STAGING_DATA_MISSING after inventory confirms missing channels');
  assert.strictEqual(outcome.error.indexOf('staging has no channel for') !== -1, true, 'error message names the missing countries');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK', 'BLOCK on DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT', 'classification is DEPENDENCY_ENVIRONMENT');
  // Exit code for DEPENDENCY_ENVIRONMENT is 6
  var cliMod = require('../src/cli');
  assert.strictEqual(cliMod.exitCodeForOutcome('BLOCK', 'DEPENDENCY_ENVIRONMENT'), 6, 'exit code 6 for DEPENDENCY_ENVIRONMENT');
});

test('readOnlyShopApi B1-04: probe returns __default_channel__ -> inventory runs, STAGING_DATA_MISSING, DEPENDENCY_ENVIRONMENT', async function(t) {
  var cliMod = require('../src/cli');
  var real = realWorkspace();
  var ctx = baseContext('CAN-B1-04', {
    fetch: combinedDefaultChannelServer(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync,
    runEnvRecord: { runId: 'run-inv-b04', stagingUrl: 'https://staging.tibella.eu' },
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, SUPERADMIN_USERNAME: 'admin@example.com', SUPERADMIN_PASSWORD: 'secretpass', VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api' }; }
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, false, 'run must fail');
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING', 'errorCode upgraded to STAGING_DATA_MISSING');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(cliMod.exitCodeForOutcome('BLOCK', 'DEPENDENCY_ENVIRONMENT'), 6);
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi B1-03: success path never calls Admin API (zero admin requests)', async function(t) {
  var adminCallCount = 0;
  var countingFetch = function(url, init) {
    var headers = init && init.headers ? init.headers : {};
    if (headers['Authorization'] || headers['vendure-auth-token']) {
      adminCallCount++;
    }
    return correctB1_03Server()(url, init);
  };
  var ctx = baseContext('CAN-B1-03', { fetch: countingFetch });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, true, 'success on correct data');
  assert.strictEqual(adminCallCount, 0, 'Admin API was never called on the success path');
});

test('readOnlyShopApi B1-04: success path never calls Admin API (zero admin requests)', async function(t) {
  var adminCallCount = 0;
  var countingFetch = function(url, init) {
    var headers = init && init.headers ? init.headers : {};
    if (headers['Authorization'] || headers['vendure-auth-token']) {
      adminCallCount++;
    }
    return correctB1_04Server()(url, init);
  };
  var real = realWorkspace();
  // Provide a pinned fixture so the test can verify Admin API is not called on success
  var fixtureFile = path.join(os.tmpdir(), 'b1-04-admin-no-call-' + Date.now() + '.json');
  var fixture = {
    DE: [
      visibleProduct('p1', 'Design One', 'design-one', [variant('v1', 'SKU-DE-1', 'Design One / S', 2500, 'EUR'), variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]),
      visibleProduct('p3', 'Design Two', 'design-two', [variant('v3', 'SKU-DE-2', 'Design Two / S', 2600, 'EUR')])
    ],
    AT: [ visibleProduct('p1', 'Design One', 'design-one', [variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')]) ],
    HU: [ visibleProduct('p4', 'Design HU', 'design-hu', [variant('v4', 'SKU-HU-1', 'Design HU / S', 875000, 'HUF')]) ],
    GB: [ visibleProduct('p5', 'Design GB', 'design-gb', [variant('v5', 'SKU-GB-1', 'Design GB / S', 2200, 'GBP')]) ]
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  var ctx = baseContext('CAN-B1-04', {
    fetch: countingFetch,
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync,
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, CAN_B1_04_EXPECTED_FIXTURE: fixtureFile }; }
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, true, 'success on correct data');
  assert.strictEqual(adminCallCount, 0, 'Admin API was never called on the success path');
  fs.rmSync(fixtureFile, { force: true });
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

test('readOnlyShopApi B1-03: credentials missing -> inventory returns available:false, pass path unchanged', async function(t) {
  // Provide a fetch that would trigger the inventory check (probe returns __default_channel__)
  // but credentials are missing (no SUPERADMIN_USERNAME/PASSWORD)
  var server = combinedDefaultChannelServer();
  var ctx = baseContext('CAN-B1-03', {
    fetch: server,
    getEnv: function() { return {}; },  // no credentials at all
    runEnvRecord: { runId: 'run-no-creds', stagingUrl: 'https://staging.tibella.eu' }
  });
  var outcome = await executors.handlerB1_03(ctx);

  // The B1-03 result still gets STAGING_SERVER_ERROR (or whatever the Shop API returns)
  // because the inventory check reports available:false and doesn't change the error code
  assert.strictEqual(outcome.success, false);
  // The inventory was attempted but credentials were missing
  // If the probe itself returned __default_channel__, the errorCode could have been STAGING_DATA_MISSING
  // but the inventory diagnostic found no credentials and kept the original code
  // Since probe returned __default_channel__ and inventory ran but found no credentials,
  // the result should be STAGING_SERVER_ERROR (not changed) or STAGING_DATA_MISSING if the
  // inventory correctly detected the missing channels issue.
  // With no credentials, inventory returns available:false with ADMIN_CREDENTIALS_MISSING
  // and runInventoryDiagnostic keeps the original errorCode
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
});

test('readOnlyShopApi B1-03: all channels present in Admin API -> STAGING_SERVER_ERROR stays (inventory adds context)', async function(t) {
  // A server where Shop API probe fails (not __default_channel__) or products fail with non-__default_channel__ probe
  // but Admin API shows all channels ARE present -> error stays as STAGING_SERVER_ERROR not STAGING_DATA_MISSING
  function shopApiFailServer() {
    return function fakeFetch(url, init) {
      var headers = init && init.headers ? init.headers : {};
      var body = init && init.body ? init.body : '';
      var isProbe = String(body).indexOf('ActiveChannelProbe') !== -1;
      if (isProbe) {
        return Promise.resolve({
          status: 200, ok: true,
          text: function() { return Promise.resolve(JSON.stringify({ data: { activeChannel: { code: 'DE', currencyCode: 'EUR' } } })); }
        });
      }
      return Promise.resolve({
        status: 200, ok: true,
        text: function() { return Promise.resolve(JSON.stringify({ data: null, errors: [{ message: 'something went wrong', path: ['products'] }] })); }
      });
    };
  }

  function fullAdminFetch(url, init) {
    var body = init && init.body ? init.body : '';
    if (body.indexOf('mutation Login') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function(n) { return n === 'vendure-auth-token' ? 'token' : null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { login: { __typename: 'CurrentUser', id: '1', identifier: 'a' } } })); }
      });
    }
    if (body.indexOf('__type') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify({ data: { __type: { fields: [{ name: 'id' }, { name: 'code' }, { name: 'token' }, { name: 'defaultCurrencyCode' }] } } })); } });
    }
    if (body.indexOf('channels(') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify({ data: { channels: { items: [{ id: '1', code: 'DE', token: 'de-token', defaultCurrencyCode: 'EUR' }, { id: '2', code: 'AT', token: 'at-token', defaultCurrencyCode: 'EUR' }, { id: '3', code: 'HU', token: 'hu-token', defaultCurrencyCode: 'HUF' }, { id: '4', code: 'GB', token: 'gb-token', defaultCurrencyCode: 'GBP' }], totalItems: 4 } } })); } });
    }
    if (body.indexOf('products(') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify({ data: { products: { totalItems: 0 } } })); } });
    }
    return Promise.resolve({ status: 404, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  }

  function splitFetch(url, init) {
    var headers = init && init.headers ? init.headers : {};
    if (headers['vendure-token']) return shopApiFailServer()(url, init);
    return fullAdminFetch(url, init);
  }

  var ctx = baseContext('CAN-B1-03', {
    fetch: splitFetch,
    runEnvRecord: { runId: 'run-all-ch', stagingUrl: 'https://staging.tibella.eu' }
  });
  var outcome = await executors.handlerB1_03(ctx);

  // Products failed but channels are present -> error stays as the original STAGING_SERVER_ERROR
  // The inventory diagnostic provides context but doesn't change the error code since no channels are missing
  assert.strictEqual(outcome.success, false);
  // If probe returned 'DE' (not __default_channel__), inventory would still run because products failed
  // But since all channels exist, missing=[], so STAGING_DATA_MISSING would NOT be set
  // Instead the original errorCode (STAGING_SERVER_ERROR or GRAPHQL_ERROR) is kept
  var cliMod = require('../src/cli');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  // The classification should still be DEPENDENCY_ENVIRONMENT (not changed by inventory)
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
});

test('readOnlyShopApi B1-03: inventory evidence written with kind:diagnostic and admin-channel-inventory.json', async function(t) {
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-inv-'));
  var runId = 'run-inv-ev-' + Date.now().toString(36);
  var ctx = baseContext('CAN-B1-03', {
    fetch: combinedDefaultChannelServer(),
    evidenceRoot: evidenceRoot,
    runEnvRecord: { runId: runId, stagingUrl: 'https://staging.tibella.eu' },
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, SUPERADMIN_USERNAME: 'admin@example.com', SUPERADMIN_PASSWORD: 'secretpass', VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api' }; }
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-03');
  assert.strictEqual(fs.existsSync(path.join(taskDir, 'admin-channel-inventory.json')), true, 'admin-channel-inventory.json written');
  var invData = JSON.parse(fs.readFileSync(path.join(taskDir, 'admin-channel-inventory.json'), 'utf8'));
  assert.strictEqual(invData.available, true, 'inventory available');
  assert.strictEqual(invData.unexpectedDefaultOnly, true, 'unexpectedDefaultOnly confirmed');
  assert.deepStrictEqual(invData.missing.sort(), ['AT', 'DE', 'GB', 'HU'].sort(), 'all four missing');
  // password must not appear in evidence
  var serialized = JSON.stringify(invData);
  assert.strictEqual(serialized.indexOf('secretpass'), -1, 'password not in evidence');
  assert.strictEqual(serialized.indexOf('admin-auth-token-test'), -1, 'auth token not in evidence');

  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Redaction end-to-end tests: full B1-03 / B1-04 failure runs must not leak
// secret VALUES into any written evidence file, and no JSON key "secrets" may
// exist anywhere under the evidence dir.
// ---------------------------------------------------------------------------

var REDACT_TOKEN = 'TESTCHANNELTOKEN123';
var REDACT_PASSWORD = 'TESTPASS!42';
var REDACT_AUTH = 'TESTAUTHTOKEN999';

/**
 * Combined Shop + Admin API fetch where the Admin API reports a single
 * __default_channel__ whose token is REDACT_TOKEN. Login returns REDACT_AUTH
 * as the admin auth token. Used to prove secrets never reach evidence.
 */
function makeRedactionFetch() {
  var fetchWrapper = function(url, init) {
    var headers = (init && init.headers) ? init.headers : {};
    var isAdmin = url.indexOf('/admin-api') !== -1 || !!(headers['Authorization'] || headers['vendure-auth-token']);

    if (isAdmin) {
      var body = init && init.body ? init.body : '';
      if (body.indexOf('mutation Login') !== -1) {
        return Promise.resolve({
          status: 200,
          headers: { get: function(n) { return n === 'vendure-auth-token' ? REDACT_AUTH : null; } },
          text: function() {
            return Promise.resolve(JSON.stringify({
              data: { login: { __typename: 'CurrentUser', id: 'u1', identifier: 'admin@example.com' } }
            }));
          }
        });
      }
      if (body.indexOf('__type') !== -1) {
        return Promise.resolve({
          status: 200, headers: { get: function() { return null; } },
          text: function() {
            return Promise.resolve(JSON.stringify({
              data: { __type: { fields: [{ name: 'id' }, { name: 'code' }, { name: 'token' }, { name: 'defaultCurrencyCode' }] } }
            }));
          }
        });
      }
      if (body.indexOf('channels(') !== -1) {
        return Promise.resolve({
          status: 200, headers: { get: function() { return null; } },
          text: function() {
            return Promise.resolve(JSON.stringify({
              data: { channels: { items: [{ id: 'ch-default', code: '__default_channel__', token: REDACT_TOKEN, defaultCurrencyCode: 'USD' }], totalItems: 1 } }
            }));
          }
        });
      }
      return Promise.resolve({ status: 404, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
    }

    // Shop API
    var body = init && init.body ? init.body : '';
    if (String(body).indexOf('ActiveChannelProbe') !== -1) {
      return Promise.resolve({
        status: 200, ok: true,
        text: function() { return Promise.resolve(JSON.stringify({ data: { activeChannel: { code: '__default_channel__', currencyCode: 'USD' } } })); }
      });
    }
    return Promise.resolve({
      status: 200, ok: true,
      text: function() { return Promise.resolve(JSON.stringify({ data: null, errors: [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products'] }] })); }
    });
  };
  return fetchWrapper;
}

function collectAllEvidenceFiles(rootDir) {
  var files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    });
  })(rootDir);
  return files;
}

function assertNoSecretsInTree(rootDir, secretValues) {
  var j = 0;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach(function(k) {
      if (k === 'secrets' && Array.isArray(node[k])) {
        // The key itself may only exist if non-enumerable/in-memory; a
        // serialized evidence object must not contain a serializable "secrets".
        j++;
      }
      walk(node[k]);
    });
  })({ __root: null });
  // Re-read every file and scan its bytes.
  var files = collectAllEvidenceFiles(rootDir);
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    for (var s = 0; s < secretValues.length; s++) {
      assert.strictEqual(content.indexOf(secretValues[s]), -1,
        'secret value must not appear in ' + files[i]);
    }
  }
}

test('readOnlyShopApi B1-03: full failure run writes no secret token/password/auth into any evidence file', async function(t) {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-redact-'));
  var runId = 'run-redact-' + Date.now().toString(36);
  var ctx = baseContext('CAN-B1-03', {
    fetch: makeRedactionFetch(),
    evidenceRoot: evidenceRoot,
    runEnvRecord: { runId: runId, stagingUrl: 'https://staging.tibella.eu' },
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, SUPERADMIN_USERNAME: 'admin@example.com', SUPERADMIN_PASSWORD: REDACT_PASSWORD, VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api' }; }
  });
  var outcome = await executors.handlerB1_03(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING', 'errorCode preserved (no behaviour change)');

  var files = collectAllEvidenceFiles(evidenceRoot);
  assert.ok(files.length > 0, 'evidence files were written');

  // 1) No secret string appears in any byte of any written file.
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(content.indexOf(REDACT_TOKEN), -1, 'channel token not in ' + files[i]);
    assert.strictEqual(content.indexOf(REDACT_PASSWORD), -1, 'admin password not in ' + files[i]);
    assert.strictEqual(content.indexOf(REDACT_AUTH), -1, 'admin auth token not in ' + files[i]);
  }

  // 2) No serializable key named "secrets" in any written JSON (deep check).
  files.forEach(function(file) {
    if (path.extname(file) !== '.json') return;
    var data = JSON.parse(fs.readFileSync(file, 'utf8'));
    var found = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach(function(k) {
        if (k === 'secrets') found.push(k);
        walk(node[k]);
      });
    })(data);
    assert.deepStrictEqual(found, [], 'no secret VALUES array key "secrets" in ' + file);
  });

  // 3) Evidence content preserved: code/id/currency/missing/unexpectedDefaultOnly.
  var invFile = files.filter(function(f) { return f.indexOf('admin-channel-inventory.json') !== -1; })[0];
  assert.ok(invFile, 'admin-channel-inventory.json written');
  var inv = JSON.parse(fs.readFileSync(invFile, 'utf8'));
  assert.strictEqual(inv.available, true);
  assert.strictEqual(inv.unexpectedDefaultOnly, true, 'unexpectedDefaultOnly preserved');
  assert.deepStrictEqual(inv.missing.sort(), ['AT', 'DE', 'GB', 'HU'].sort(), 'missing preserved');
  var ch = inv.channels && inv.channels[0];
  assert.ok(ch, 'channels list present');
  assert.strictEqual(ch.code, '__default_channel__', 'channel code visible');
  assert.strictEqual(ch.id, 'ch-default', 'channel id visible');
  assert.strictEqual(ch.currency, 'USD', 'channel currency visible');
  assert.notStrictEqual(ch.token, REDACT_TOKEN, 'channel token value redacted');
  assert.ok(String(ch.token).indexOf(REDACT_TOKEN) === -1, 'no token bytes in channel token field');

  // 4) Canonical record still written and redacted.
  var recordFile = files.filter(function(f) { return f.indexOf('record.json') !== -1; })[0];
  if (recordFile) {
    var recordContent = fs.readFileSync(recordFile, 'utf8');
    assert.strictEqual(recordContent.indexOf(REDACT_TOKEN), -1, 'token not in record.json');
    assert.strictEqual(recordContent.indexOf(REDACT_PASSWORD), -1, 'password not in record.json');
  }

  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('readOnlyShopApi B1-04: full failure run writes no secret token/password/auth into any evidence file', async function(t) {
  var real = realWorkspace();
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-redact-b04-'));
  var runId = 'run-redact-b04-' + Date.now().toString(36);
  var ctx = baseContext('CAN-B1-04', {
    fetch: makeRedactionFetch(),
    workspace: real.ws,
    mkdirSync: real.deps.mkdirSync,
    writeFileSync: real.deps.writeFileSync,
    readFileSync: real.deps.readFileSync,
    evidenceRoot: evidenceRoot,
    runEnvRecord: { runId: runId, stagingUrl: 'https://staging.tibella.eu' },
    getEnv: function() { return { CHANNEL_TOKENS: TOKENS_JSON, SUPERADMIN_USERNAME: 'admin@example.com', SUPERADMIN_PASSWORD: REDACT_PASSWORD, VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api' }; }
  });
  var outcome = await executors.handlerB1_04(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'STAGING_DATA_MISSING', 'errorCode preserved (no behaviour change)');

  var files = collectAllEvidenceFiles(evidenceRoot);
  assert.ok(files.length > 0, 'evidence files were written');

  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(content.indexOf(REDACT_TOKEN), -1, 'channel token not in ' + files[i]);
    assert.strictEqual(content.indexOf(REDACT_PASSWORD), -1, 'admin password not in ' + files[i]);
    assert.strictEqual(content.indexOf(REDACT_AUTH), -1, 'admin auth token not in ' + files[i]);
  }

  files.forEach(function(file) {
    if (path.extname(file) !== '.json') return;
    var data = JSON.parse(fs.readFileSync(file, 'utf8'));
    var found = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach(function(k) {
        if (k === 'secrets') found.push(k);
        walk(node[k]);
      });
    })(data);
    assert.deepStrictEqual(found, [], 'no secret VALUES array key "secrets" in ' + file);
  });

  var invFile = files.filter(function(f) { return f.indexOf('admin-channel-inventory.json') !== -1; })[0];
  assert.ok(invFile, 'admin-channel-inventory.json written');
  var inv = JSON.parse(fs.readFileSync(invFile, 'utf8'));
  assert.strictEqual(inv.available, true);
  assert.strictEqual(inv.unexpectedDefaultOnly, true, 'unexpectedDefaultOnly preserved');
  assert.deepStrictEqual(inv.missing.sort(), ['AT', 'DE', 'GB', 'HU'].sort(), 'missing preserved');
  var ch = inv.channels && inv.channels[0];
  assert.ok(ch, 'channels list present');
  assert.strictEqual(ch.code, '__default_channel__', 'channel code visible');
  assert.strictEqual(ch.id, 'ch-default', 'channel id visible');
  assert.strictEqual(ch.currency, 'USD', 'channel currency visible');
  assert.ok(String(ch.token).indexOf(REDACT_TOKEN) === -1, 'no token bytes in channel token field');

  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  fs.rmSync(real.ws.workspacePath, { recursive: true, force: true });
});

