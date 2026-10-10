'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var executors = require('../src/executors/cartChannelLock');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');
var evidenceCollector = require('../src/evidenceCollector');
var sessionModule = require('../src/executors/shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

// The frozen nominal channel tokens are the lowercase country code + "-token".
var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

var DE_VARIANT = { id: 'v-de', sku: 'DE-1', name: 'DE Product / S', priceWithTax: 2500, currencyCode: 'EUR' };
var HU_VARIANT = { id: 'v-hu', sku: 'HU-1', name: 'HU Product / S', priceWithTax: 987500, currencyCode: 'HUF' };

var BROWSE_QUERY_MARKER = 'BrowseChannelProducts';
var CHECKOUT_MARKER = 'CheckoutCountryLockSnapshot';
var GET_ACTIVE_ORDER_MARKER = 'GetActiveOrder';
var ELIGIBLE_PAYMENT_MARKER = 'GetEligiblePaymentMethods';

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

function headerToken(req) {
  var raw = req.headers['vendure-token'];
  if (raw === 'de-token') return 'DE';
  if (raw === 'hu-token') return 'HU';
  return null;
}

function activeOrderPayload(scenario) {
  var lines = [{
    id: 'l-de',
    productVariant: { id: DE_VARIANT.id, name: DE_VARIANT.name, sku: DE_VARIANT.sku },
    unitPriceWithTax: 2500,
    quantity: 1,
    linePriceWithTax: 2500
  }];
  if (scenario === 'mix') {
    lines.push({
      id: 'l-hu',
      productVariant: { id: HU_VARIANT.id, name: HU_VARIANT.name, sku: HU_VARIANT.sku },
      unitPriceWithTax: 987500,
      quantity: 1,
      linePriceWithTax: 987500
    });
  }
  return {
    id: '1',
    code: 'ED-RUN-0001',
    state: 'AddingItems',
    totalQuantity: lines.length,
    subTotal: 2500,
    subTotalWithTax: 2500,
    shipping: 0,
    shippingWithTax: 0,
    total: 2500,
    totalWithTax: 2500,
    currencyCode: 'EUR',
    taxSummary: [{ description: 'MwSt', taxRate: 19, taxTotal: 399 }],
    shippingAddress: { fullName: 'Test Customer', streetLine1: 'Teststrasse 1', city: 'Berlin', province: 'Berlin', postalCode: '10115', country: 'Germany', countryCode: 'DE' },
    shippingLines: [],
    lines: lines
  };
}

/**
 * A tiny fake Shop API server. The `scenario` selects the responses:
 *  - 'ok': the DE customer has a cart holding only the DE product; the
 *    cross-country HU add is rejected with a clear GraphQL error, so the
 *    cart keeps the valid DE context and never mixes Product Countries.
 *  - 'mix': the cross-country HU add is ACCEPTED and the cart then holds both
 *    the DE and HU products (a planted cross-country defect to detect).
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
        var token = headerToken(req);

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
        if (query.indexOf(BROWSE_QUERY_MARKER) !== -1) {
          var item = token === 'HU'
            ? { id: 'p-hu', name: 'HU Design', slug: 'hu-design', variants: [HU_VARIANT] }
            : { id: 'p-de', name: 'DE Design', slug: 'de-design', variants: [DE_VARIANT] };
          send(200, { data: { products: { items: [item] } } });
          return;
        }
        if (query.indexOf('AddToCart') !== -1) {
          if (token === 'HU' && scenario !== 'mix') {
            // The country guard rejects a line whose product country does not
            // match the customer country (country-guard.subscriber.ts:113-116).
            send(200, { errors: [{ message: 'Product Country (HU) does not match User Country (DE).' }] });
            return;
          }
          send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', totalQuantity: 1, lines: [] } } });
          return;
        }
        if (query.indexOf('SetOrderShippingAddress') !== -1) {
          send(200, { data: { setOrderShippingAddress: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', shippingAddress: { countryCode: 'DE' } } } });
          return;
        }
        if (query.indexOf(ELIGIBLE_PAYMENT_MARKER) !== -1) {
          send(200, { data: { eligiblePaymentMethods: [{ id: 'pm1', name: 'Stripe', code: 'stripe-connect', description: '', isEligible: true, eligibilityMessage: null }] } });
          return;
        }
        if (query.indexOf(CHECKOUT_MARKER) !== -1 || query.indexOf(GET_ACTIVE_ORDER_MARKER) !== -1) {
          send(200, { data: { activeOrder: activeOrderPayload(scenario) } });
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

test('cartChannelLock: success returns READINESS_PASS with verified checks and unverified payment/receipt', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-b105-success', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_05(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B1-05', 'actual mirrors the canonical expected result');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.customerCountry, 'DE');
  assert.strictEqual(outcome.evidence.checks.cartKeepsContext, true);
  assert.strictEqual(outcome.evidence.checks.addressCountryDe, true);
  assert.strictEqual(outcome.evidence.checks.orderChannelDe, true);
  assert.strictEqual(outcome.evidence.checks.negativeRejectedClearly, true, 'cross-country add rejected clearly');
  assert.strictEqual(outcome.evidence.checks.noCountryMix, true, 'no product country mix');
  assert.strictEqual(outcome.evidence.checks.taxContextAgrees, true);
  assert.ok(outcome.evidence.observed.negativeAddRejection, 'rejection detail captured');
  assert.ok(outcome.evidence.observed.negativeAddRejection.message.indexOf('does not match') !== -1, 'clear rejection message');
  assert.ok(outcome.evidence.assertionReport.length === 2, 'one report entry per mandatory assertion');
  assert.ok(outcome.evidence.unverified.length >= 4, 'payment/receipt listed unverified');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe') !== -1, 'unverified lists mention the Stripe Runner');
  assert.ok(joined.indexOf('receipt') !== -1, 'unverified lists mention the receipt');
  // Tokens are redacted from evidence.
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
  // The HUF product was never entered into the EUR cart: no mix.
  assert.strictEqual(outcome.evidence.observed.orderSkus.indexOf('HU-1'), -1, 'HU sku absent from final cart');
  assert.strictEqual(outcome.evidence.observed.orderSkus.indexOf('DE-1'), 0, 'DE sku present in final cart');
});

test('cartChannelLock: accepted cross-country add is an APPLICATION_DEFECT (cart mixes Product Countries)', async function() {
  var s = await startServer('mix');
  var ctx = baseContext('CAN-B1-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_05(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('mix') !== -1, 'error names the mix');
  assert.strictEqual(outcome.evidence.observed.negativeAddRejection, null, 'no clear rejection was returned');
  assert.strictEqual(outcome.evidence.observed.negativeAddAccepted, true, 'cross-country add was accepted');
  assert.strictEqual(outcome.evidence.observed.orderSkus.indexOf('HU-1') !== -1, true, 'HU sku entered the cart');
  assert.strictEqual(outcome.evidence.checks.noCountryMix, false, 'mix detected');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('cartChannelLock: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B1-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_05(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('failed') !== -1 || outcome.error.indexOf('500') !== -1, 'error mentions failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('cartChannelLock: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-05', {
    getEnv: envWith({})
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_05(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-05');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('cartChannelLock: register() registers internally with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-05'), true);
  var ex = executorModule.getTaskExecutor('CAN-B1-05');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B1-05-A01']);
  executorModule.resetTaskExecutors();
});

test('cartChannelLock: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b105-'));
  var runId = 'run-b105-' + Date.now().toString(36) + '-x7q';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-05', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_05(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-05');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'cart-channel-lock-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('cartChannelLock: check snapshot query marker matches the source query', function() {
  assert.ok(executors.CHECKOUT_SNAPSHOT_QUERY.indexOf('CheckoutCountryLockSnapshot') !== -1, 'operation name from the source');
  assert.ok(executors.CHECKOUT_SNAPSHOT_QUERY.indexOf('activeOrder') !== -1, 'activeOrder operation');
  assert.ok(executors.CHECKOUT_SNAPSHOT_QUERY.indexOf('taxSummary') !== -1, 'tax context present');
  assert.ok(executors.CHECKOUT_SNAPSHOT_QUERY.indexOf('shippingAddress') !== -1, 'address country present');
  assert.ok(executors.SET_SHIPPING_ADDRESS_MUTATION.indexOf('setOrderShippingAddress') !== -1, 'operation name from the source');
  assert.ok(sessionModule.GRAPHQL.addItemToOrder.indexOf('mutation AddToCart') !== -1, 'copies the source add op');
});

test('cartChannelLock: buildAssertionReport lists A01 verified and A02 partial, payment/receipt unverified', function() {
  var observed = {
    customerCountry: 'DE',
    addressCountry: 'DE',
    walletCurrency: 'EUR',
    orderCurrency: 'EUR',
    orderCurrencyAfter: 'EUR',
    orderChannel: 'DE',
    taxSummary: [{ description: 'MwSt', taxRate: 19, taxTotal: 399 }],
    productCountries: ['DE'],
    secondProductCountry: 'HU',
    orderSkus: ['DE-1'],
    negativeAddRejection: { kind: 'graphql-error', errorCode: null, message: 'Product Country (HU) does not match User Country (DE).' }
  };
  var checks = {
    cartKeepsContext: true,
    addressCountryDe: true,
    orderChannelDe: true,
    negativeRejectedClearly: true,
    noCountryMix: true,
    taxContextAgrees: true,
    cartKeepsContextAfter: true
  };
  var report = executors.buildAssertionReport(observed, checks);
  assert.strictEqual(report.length, 2);
  assert.strictEqual(report[0].id, 'CAN-B1-05-A01');
  assert.strictEqual(report[0].verified, true);
  assert.ok(report[0].unverifiedClaims.length >= 2, 'A01 has Stripe-scoped unverified claims');
  assert.ok(report[0].unverifiedClaims[0].why.indexOf('Stripe') !== -1);
  assert.strictEqual(report[1].id, 'CAN-B1-05-A02');
  assert.ok(report[1].unverifiedClaims.some(function(c) { return c.why.indexOf('Stripe') !== -1; }), 'A02 payment currency is unverified');
});
