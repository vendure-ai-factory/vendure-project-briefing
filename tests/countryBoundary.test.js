'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/countryBoundary');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

var BROWSE_QUERY_MARKER = 'BrowseCountryChannelProducts';

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

/**
 * A tiny fake Shop API server. The `scenario` selects the responses:
 *  - 'ok': the DE customer profile, HU products priced in HUF, and an order
 *    in the customer currency all come back correctly.
 *  - 'wrong-currency': the HU channel product is priced in EUR (a planted
 *    cross-country defect the executor must detect).
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
        if (query.indexOf('GetActiveCustomer') !== -1) {
          send(200, { data: { activeCustomer: { id: '1', firstName: 'Buyer', lastName: 'One', emailAddress: vars.username || 'buyer.one@example.com', customFields: { countryCode: 'DE' }, addresses: [] } } });
          return;
        }
        if (query.indexOf(BROWSE_QUERY_MARKER) !== -1) {
          if (scenario === 'wrong-currency') {
            send(200, { data: { products: { items: [{ id: 'p1', name: 'HU Design', slug: 'hu-design', variants: [{ id: 'v1', sku: 'HU-1', name: 'HU Design / S', priceWithTax: 987500, currencyCode: 'EUR' }] }] } } });
          } else {
            send(200, { data: { products: { items: [{ id: 'p1', name: 'HU Design', slug: 'hu-design', variants: [{ id: 'v1', sku: 'HU-1', name: 'HU Design / S', priceWithTax: 987500, currencyCode: 'HUF' }] }] } } });
          }
          return;
        }
        if (query.indexOf('SetSessionCurrencyCode') !== -1) {
          send(200, { data: { setSessionCurrencyCode: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', totalWithTax: 987500, currencyCode: vars.currency } } });
          return;
        }
        if (query.indexOf('GetActiveOrder') !== -1) {
          send(200, { data: { activeOrder: {
            id: '1',
            code: 'ED-RUN-0001',
            state: 'AddingItems',
            totalQuantity: 1,
            currencyCode: 'EUR',
            lines: [{ id: 'l1', productVariant: { id: 'v1', name: 'HU Design / S', sku: 'HU-1' }, unitPriceWithTax: 987500, quantity: 1, linePriceWithTax: 987500 }]
          } } });
          return;
        }
        if (query.indexOf('addItemToOrder') !== -1) {
          send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', totalQuantity: 1, lines: [] } } });
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

test('countryBoundary: success returns READINESS_PASS with verified checks and unverified payment/receipt', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-01', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-b1-01-success', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_01(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B1-01', 'actual mirrors the canonical expected result');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.customerCountry, 'DE');
  assert.strictEqual(outcome.evidence.checks.profileCountryStaysCustomerCountry, true);
  assert.strictEqual(outcome.evidence.checks.productChannelIsProductCountry, true);
  assert.strictEqual(outcome.evidence.checks.priceCurrencyIsProductCurrency, true);
  assert.strictEqual(outcome.evidence.checks.walletCurrencyIsCustomerCurrency, true);
  assert.strictEqual(outcome.evidence.checks.orderCurrencyIsCustomerCurrency, true);
  assert.ok(outcome.evidence.assertionReport.length === 2, 'one report entry per mandatory assertion');
  assert.ok(outcome.evidence.unverified.length >= 3, 'payment/receipt/conversion listed unverified');
  // Stripe-scoped claims are explicitly listed as unverified.
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe') !== -1, 'unverified lists mention the Stripe Runner');
  assert.ok(joined.indexOf('conversion') !== -1, 'unverified lists mention conversion recording');
  // Tokens are redacted from evidence.
  assert.strictEqual(JSON.stringify(outcome.evidence || outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
});

test('countryBoundary: wrong product currency is an APPLICATION_DEFECT', async function() {
  var s = await startServer('wrong-currency');
  var ctx = baseContext('CAN-B1', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_01(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('HUF') !== -1, 'error names expected HUF');
  assert.strictEqual(outcome.evidence.observed.productCurrency, 'EUR', 'observed the wrong currency');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-01');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('countryBoundary: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B1-01', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_01(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('500') !== -1 || outcome.error.indexOf('failed') !== -1, 'error mentions failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-01');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('countryBoundary: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-01', {
    getEnv: envWith({})
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_01(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  // No value may leak: the secret scan would also catch a literal value.
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-01');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('countryBoundary: register() registers CAN-B1-01 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-01'), true);
  var ex = executorModule.getTaskExecutor('CAN-B1-01');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B1-01-A01']);
  executorModule.resetTaskExecutors();
});

test('countryBoundary: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b1-01-'));
  var runId = 'run-b1-01-' + Date.now().toString(36) + '-x1y';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-01', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_01(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-01');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'country-boundary-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
