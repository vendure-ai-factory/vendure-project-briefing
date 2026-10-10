'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/standardProduct');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

var PRODUCT_QUERY_MARKER = 'GetStandardProduct';

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

function standardProductBody(designFee, stockLevel, price, currency) {
  return {
    data: {
      product: {
        id: 'p1',
        name: 'Jelly Glue',
        slug: 'jelly-glue',
        variants: [{
          id: 'v1',
          name: 'Jelly Glue',
          sku: 'JELLY-001',
          priceWithTax: price === undefined ? 1200 : price,
          currencyCode: currency || 'EUR',
          stockLevel: stockLevel
        }],
        customFields: { designFee: designFee === undefined ? null : designFee }
      }
    }
  };
}

function activeOrderBody(designFee) {
  return {
    data: {
      activeOrder: {
        id: '1',
        code: 'ED-RUN-0001',
        state: 'AddingItems',
        totalQuantity: 1,
        currencyCode: 'EUR',
        lines: [{
          id: 'l1',
          productVariant: {
            id: 'v1',
            name: 'Jelly Glue',
            sku: 'JELLY-001',
            product: {
              id: 'p1',
              name: 'Jelly Glue',
              slug: 'jelly-glue',
              customFields: { designFee: designFee === undefined ? null : designFee }
            }
          },
          unitPriceWithTax: 1200,
          quantity: 1,
          linePriceWithTax: 1200
        }]
      }
    }
  };
}

/**
 * A tiny fake Shop API server. The `scenario` selects the responses:
 *  - 'ok': standard product with no design fee, ordinary stock (IN_STOCK),
 *    single EUR price; addItemToOrder and activeOrder succeed with no design
 *    fee on the order line.
 *  - 'design-fee': the standard product carries customFields.designFee (a
 *    planted defect; a standard product must follow the single-price path).
 *  - 'out-of-stock': the standard product variant is OUT_OF_STOCK.
 *  - 'wrong-currency': the standard product variant is priced in GBP.
 *  - '500': every /shop-api call returns HTTP 500.
 */
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
        var vars = body.variables || {};

        function send(status, obj) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        }

        if (scenario === '500') {
          send(500, { errors: [{ message: 'boom' }] });
          return;
        }
        if (query.indexOf('mutation Login') !== -1) {
          send(200, { data: { login: { __typename: 'CurrentUser', id: '1', identifier: vars.username } } });
          return;
        }
        if (query.indexOf(PRODUCT_QUERY_MARKER) !== -1) {
          if (scenario === 'design-fee') {
            send(200, standardProductBody(1000, 'IN_STOCK', 1200, 'EUR'));
          } else if (scenario === 'out-of-stock') {
            send(200, standardProductBody(null, 'OUT_OF_STOCK', 1200, 'EUR'));
          } else if (scenario === 'wrong-currency') {
            send(200, standardProductBody(null, 'IN_STOCK', 1200, 'GBP'));
          } else if (scenario === 'not-found') {
            send(200, { data: { product: null } });
          } else {
            send(200, standardProductBody(null, 'IN_STOCK', 1200, 'EUR'));
          }
          return;
        }
        if (query.indexOf('addItemToOrder') !== -1) {
          send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', totalQuantity: 1, lines: [] } } });
          return;
        }
        if (query.indexOf('GetActiveOrder') !== -1) {
          if (scenario === 'order-line-design-fee') {
            send(200, activeOrderBody(1000));
          } else {
            send(200, activeOrderBody(null));
          }
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
    shopApiBase: overrides.shopApiBase || 'https://staging.tibella.eu',
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

test('standardProduct: success returns READINESS_PASS with verified single-price path and unverified Stripe/db claims', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-b2-05-success', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-05', 'actual mirrors the canonical expected result');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.productSlug, 'jelly-glue');
  assert.strictEqual(outcome.evidence.observed.productName, 'Jelly Glue');
  assert.strictEqual(outcome.evidence.checks.singlePricePath, true);
  assert.strictEqual(outcome.evidence.checks.priceCurrencyIsProductCurrency, true);
  assert.strictEqual(outcome.evidence.checks.ordinaryStock, true);
  assert.strictEqual(outcome.evidence.checks.orderCreated, true);
  assert.strictEqual(outcome.evidence.checks.orderLineNoDesignFee, true);
  assert.ok(outcome.evidence.assertionReport.length === 2, 'one report entry per mandatory assertion');
  assert.ok(outcome.evidence.unverified.length >= 5, 'Stripe/db claims listed unverified');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe') !== -1, 'unverified lists mention the Stripe Runner');
  assert.ok(joined.indexOf('commission') !== -1, 'unverified lists mention the designer-commission record');
  // Tokens are redacted from evidence.
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
});

test('standardProduct: product with a design fee is an APPLICATION_DEFECT', async function() {
  var s = await startServer('design-fee');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('design fee') !== -1, 'error names the design fee');
  assert.strictEqual(outcome.evidence.observed.designFee, 1000, 'observed the planted design fee');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('standardProduct: out-of-stock standard product is an APPLICATION_DEFECT', async function() {
  var s = await startServer('out-of-stock');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('stock') !== -1, 'error names the stock failure');
  assert.strictEqual(outcome.evidence.observed.stockLevel, 'OUT_OF_STOCK');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('standardProduct: wrong price currency is an APPLICATION_DEFECT', async function() {
  var s = await startServer('wrong-currency');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.observed.currencyCode, 'GBP', 'observed the wrong currency');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('standardProduct: missing product is an APPLICATION_DEFECT', async function() {
  var s = await startServer('not-found');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('not found') !== -1, 'error names the missing product');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('standardProduct: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('500') !== -1 || outcome.error.indexOf('failed') !== -1, 'error mentions failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('standardProduct: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({})
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  // No value may leak: the secret scan would also catch a literal value.
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('standardProduct: register() registers CAN-B2-05 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-05'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-05');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-05-A01']);
  executorModule.resetTaskExecutors();
});

test('standardProduct: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b2-05-'));
  var runId = 'run-b2-05-' + Date.now().toString(36) + '-x1y';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerStandardProduct(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-05');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'standard-product-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
