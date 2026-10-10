'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/customPurchase');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

var PRODUCT_QUERY_MARKER = 'GetCustomPurchaseProduct';
var ACTIVE_ORDER_QUERY_MARKER = 'GetCustomPurchaseActiveOrder';

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

// The frozen reference table picks the middle short-oval size as the expected
// matched model. We ask the executor itself so a fixture change cannot break
// the symmetric responses below.
var reference = (function() {
  var r = executors.resolveNailReference({});
  if (!r.ok) throw new Error('resolveNailReference failed: ' + r.error);
  return r;
})();

var NAIL_SIZES = 'leftIndex:' + reference.arcLength;
var EXPECTED_MODEL = String(reference.modelNumber);

function customProductBody() {
  return {
    data: {
      product: {
        id: 'p1',
        name: 'Aurora Borealis Nails',
        slug: 'aurora-borealis-nails',
        featuredAsset: { id: 'a1', name: 'design-1.png' },
        assets: [
          { id: 'a1', name: 'design-1.png' },
          { id: 'a2', name: 'design-2.png' }
        ],
        variants: [{
          id: 'v1',
          name: 'Aurora Borealis Nails Standard',
          sku: 'AUR-001',
          priceWithTax: 2500,
          currencyCode: 'EUR',
          stockLevel: 'IN_STOCK'
        }],
        customFields: { designFee: 800, designTemplate: '{"indexTable":[]}' }
      }
    }
  };
}

function activeOrderBody(overrides) {
  overrides = overrides || {};
  var cf = {
    designNumber: 'design-1.png',
    nailShape: 'short-oval',
    nailSizes: NAIL_SIZES,
    matchedNailModel: EXPECTED_MODEL,
    specialEffect: 'none',
    surfaceFinish: 'glossy'
  };
  return {
    data: {
      activeOrder: {
        id: '1',
        code: 'ED-RUN-0002',
        state: 'AddingItems',
        totalQuantity: 1,
        subTotal: 2500,
        subTotalWithTax: 2975,
        shipping: 0,
        shippingWithTax: 0,
        total: 2500,
        totalWithTax: 2975,
        currencyCode: 'EUR',
        taxSummary: overrides.noTax ? [] : [{ description: 'VAT', taxRate: 19, taxTotal: 475 }],
        shippingLines: overrides.noShipping ? [] : [{ priceWithTax: 0, shippingMethod: { id: 's1', name: 'Standard' } }],
        lines: [{
          id: 'l1',
          productVariant: {
            id: 'v1',
            name: 'Aurora Borealis Nails Standard',
            sku: 'AUR-001',
            product: { id: 'p1', name: 'Aurora Borealis Nails', slug: 'aurora-borealis-nails' }
          },
          unitPriceWithTax: 2500,
          quantity: 1,
          linePriceWithTax: 2500,
          customFields: Object.assign({}, cf, overrides.customFields || {})
        }]
      }
    }
  };
}

function startServer(scenario) {
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
      if (req.url !== '/shop-api') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var body = raw ? JSON.parse(raw) : {};
        var query = body.query || '';

        function send(status, obj) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        }

        if (scenario === '500') {
          send(500, { errors: [{ message: 'boom' }] });
          return;
        }
        if (query.indexOf('mutation Login') !== -1) {
          send(200, { data: { login: { __typename: 'CurrentUser', id: '1', identifier: body.variables.username } } });
          return;
        }
        if (query.indexOf(PRODUCT_QUERY_MARKER) !== -1) {
          if (scenario === 'not-found') send(200, { data: { product: null } });
          else send(200, customProductBody());
          return;
        }
        if (query.indexOf('addItemToOrder') !== -1) {
          if (scenario === 'reject-order') send(200, { data: { addItemToOrder: { __typename: 'InsufficientStockError', message: 'no stock' } } });
          else send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-0002', totalQuantity: 1, lines: [] } } });
          return;
        }
        if (query.indexOf(ACTIVE_ORDER_QUERY_MARKER) !== -1) {
          if (scenario === 'bad-design') send(200, activeOrderBody({ customFields: { designNumber: 'other.png' } }));
          else if (scenario === 'bad-shape') send(200, activeOrderBody({ customFields: { nailShape: 'short-coffin' } }));
          else if (scenario === 'bad-finger') send(200, activeOrderBody({ customFields: { nailSizes: 'rightThumb:15' } }));
          else if (scenario === 'bad-model') send(200, activeOrderBody({ customFields: { matchedNailModel: '99' } }));
          else if (scenario === 'no-tax') send(200, activeOrderBody({ noTax: true }));
          else send(200, activeOrderBody());
          return;
        }
        send(200, { data: {} });
      });
    });
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port });
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise(function(resolve) { server.close(resolve); });
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var base = {
    taskId: taskId,
    task: { canonicalId: taskId, mandatoryAssertions: [], expectedResult: 'expected result for ' + taskId },
    shopApiBase: 'https://staging.tibella.eu',
    deps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      clock: overrides.clock || fakeClock(),
      getEnv: overrides.getEnv || envWith({}),
      config: overrides.config || {}
    }
  };
  if (overrides.runEnvRecord) base.runEnvRecord = overrides.runEnvRecord;
  if (overrides.registry) base.registry = overrides.registry;
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

test('customPurchase: success returns READINESS_PASS with preserved custom fields and unverified payment', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-b2-06-success', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-06', 'actual mirrors the canonical expected result');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.productName, 'Aurora Borealis Nails');
  assert.strictEqual(outcome.evidence.pickedEffectImage, 'design-1.png', 'picked the first effect image');
  assert.strictEqual(outcome.evidence.checks.designPreserved, true);
  assert.strictEqual(outcome.evidence.checks.physicalProductPreserved, true);
  assert.strictEqual(outcome.evidence.checks.shapePreserved, true);
  assert.strictEqual(outcome.evidence.checks.fingerPreserved, true);
  assert.strictEqual(outcome.evidence.checks.modelPreserved, true);
  assert.strictEqual(outcome.evidence.checks.productCountryPreserved, true);
  assert.strictEqual(outcome.evidence.checks.pricePreserved, true);
  assert.strictEqual(outcome.evidence.checks.currencyPreserved, true);
  assert.strictEqual(outcome.evidence.checks.taxPresent, true);
  assert.strictEqual(outcome.evidence.checks.shippingPresent, true);
  assert.ok(outcome.evidence.assertionReport.length === 2, 'one report entry per mandatory assertion');
  assert.ok(outcome.evidence.unverified.length >= 3, 'Stripe/db claims listed unverified');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe') !== -1, 'unverified lists mention the Stripe Runner');
  assert.ok(joined.indexOf('payment') !== -1, 'unverified lists mention payment values');
  // Tokens are redacted from evidence.
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
});

test('customPurchase: design not preserved is an APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-design');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('design') !== -1, 'error names the design');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: shape not preserved is an APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-shape');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('shape') !== -1, 'error names the nail shape');
  assert.strictEqual(outcome.evidence.observed.shapeOnLine, 'short-coffin');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: finger not preserved is an APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-finger');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('finger') !== -1, 'error names the finger');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: size/model not preserved is an APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-model');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('size/model') !== -1, 'error names the size/model');
  assert.strictEqual(outcome.evidence.observed.matchedModelOnLine, '99');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: tax values missing is an APPLICATION_DEFECT', async function() {
  var s = await startServer('no-tax');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('tax') !== -1, 'error names the tax values');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: order rejected on add is an APPLICATION_DEFECT', async function() {
  var s = await startServer('reject-order');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('addItemToOrder') !== -1, 'error names the add step');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: missing product is an APPLICATION_DEFECT', async function() {
  var s = await startServer('not-found');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('not found') !== -1, 'error names the missing product');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customPurchase: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('500') !== -1 || outcome.error.indexOf('failed') !== -1, 'error mentions failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('customPurchase: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({})
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('customPurchase: register() registers CAN-B2-06 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-06'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-06');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-06-A01']);
  executorModule.resetTaskExecutors();
});

test('customPurchase: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b2-06-'));
  var runId = 'run-b2-06-' + Date.now().toString(36) + '-x1y';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-06', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerCustomPurchase(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-06');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'custom-purchase-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
