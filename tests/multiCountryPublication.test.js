'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/multiCountryPublication');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });
var COUNTRIES = ['DE', 'AT', 'HU', 'GB'];
var PURCHASE_COUNTRY = 'DE';
var ORDER_QUANTITY = 1;

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
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

var BASE_PRICES = { DE: 2500, AT: 2600, HU: 95000, GB: 2200 };
var BASE_CURRENCIES = { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' };
var BASE_STOCK = { DE: 10, AT: 8, HU: 5, GB: 12 };

function productBodyForCountry(country, stockOverride) {
  var stock = stockOverride !== undefined ? stockOverride : (BASE_STOCK[country] || 10);
  return {
    data: {
      product: {
        id: 'p-multi-' + country,
        name: 'Fixture 1 Nail Design',
        slug: 'fixture-1-nail-design',
        variants: [{
          id: 'v-multi-' + country,
          name: 'Standard',
          sku: 'NAIL-DESIGN-1-' + country,
          priceWithTax: BASE_PRICES[country] || 2500,
          currencyCode: BASE_CURRENCIES[country] || 'EUR',
          stockLevel: stock
        }]
      }
    }
  };
}

function activeOrderBody(overrides) {
  overrides = overrides || {};
  return {
    data: {
      activeOrder: {
        id: '1',
        code: 'ED-RUN-MC001',
        state: 'AddingItems',
        totalQuantity: 1,
        subTotal: 2500,
        subTotalWithTax: 2975,
        shipping: 0,
        shippingWithTax: 0,
        total: 2500,
        totalWithTax: 2975,
        currencyCode: overrides.currencyCode || BASE_CURRENCIES[PURCHASE_COUNTRY],
        taxSummary: [{ description: 'VAT', taxRate: 19, taxTotal: 475 }],
        shippingLines: [],
        lines: [{
          id: 'l1',
          productVariant: {
            id: 'v-multi-' + PURCHASE_COUNTRY,
            name: 'Standard',
            sku: 'NAIL-DESIGN-1-' + PURCHASE_COUNTRY,
            product: {
              id: 'p-multi-' + PURCHASE_COUNTRY,
              name: 'Fixture 1 Nail Design',
              slug: overrides.designSlug || 'fixture-1-nail-design'
            }
          },
          unitPriceWithTax: BASE_PRICES[PURCHASE_COUNTRY],
          quantity: 1,
          linePriceWithTax: BASE_PRICES[PURCHASE_COUNTRY],
          customFields: {}
        }]
      }
    }
  };
}

function createServerState(scenario) {
  return {
    stock: { DE: scenario === 'low-stock' ? 1 : (scenario === 'no-stock' ? 0 : 1),  // ok:1 so post-purchase hits 0, triggering unavailableAtZero
      AT: BASE_STOCK.AT,
      HU: BASE_STOCK.HU,
      GB: BASE_STOCK.GB
    },
    rejectPurchase: scenario === 'reject-order',
    wrongCurrencyCountry: scenario === 'wrong-currency' ? 'AT' : null,
    samePriceCountry: scenario === 'same-price' ? 'AT' : null
  };
}

function startServer(scenario) {
  return new Promise(function(resolve, reject) {
    var state = createServerState(scenario);
    var tokens = JSON.parse(TOKENS_JSON);
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

        if (query.indexOf('GetMultiCountryProduct') !== -1) {
          var token = req.headers['vendure-token'] || '';
          var country = 'DE';
          for (var ci = 0; ci < COUNTRIES.length; ci++) {
            if (tokens[COUNTRIES[ci]] === token) { country = COUNTRIES[ci]; break; }
          }
          if (state.wrongCurrencyCountry && country !== PURCHASE_COUNTRY) {
            send(200, { data: { product: { id: 'p-multi-' + country, name: 'Test', slug: 'fixture-1-nail-design', variants: [{ id: 'v-multi-' + country, name: 'Standard', sku: 'X', priceWithTax: 2500, currencyCode: 'WRONG', stockLevel: state.stock[country] || 10 }] } } });
            return;
          }
          if (state.samePriceCountry && country !== PURCHASE_COUNTRY) {
            send(200, { data: { product: { id: 'p-multi-' + country, name: 'Test', slug: 'fixture-1-nail-design', variants: [{ id: 'v-multi-' + country, name: 'Standard', sku: 'X', priceWithTax: BASE_PRICES.DE, currencyCode: BASE_CURRENCIES[country] || 'EUR', stockLevel: state.stock[country] || 10 }] } } });
            return;
          }
          send(200, productBodyForCountry(country, state.stock[country]));
          return;
        }

        if (query.indexOf('addItemToOrder') !== -1) {
          if (state.rejectPurchase || state.stock[PURCHASE_COUNTRY] <= 0) {
            send(200, { data: { addItemToOrder: { __typename: 'InsufficientStockError', message: 'no stock' } } });
            return;
          }
          state.stock[PURCHASE_COUNTRY] = Math.max(0, state.stock[PURCHASE_COUNTRY] - ORDER_QUANTITY);
          send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-MC001', totalQuantity: 1, lines: [] } } });
          return;
        }

        if (query.indexOf('activeOrder') !== -1) {
          if (scenario === 'bad-slug') {
            send(200, activeOrderBody({ designSlug: 'other-design' }));
            return;
          }
          if (scenario === 'bad-currency') {
            send(200, activeOrderBody({ currencyCode: 'USD' }));
            return;
          }
          send(200, activeOrderBody({}));
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

test('register and hasAdminCredentials', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.deepStrictEqual(reg.registered, ['CAN-B2-03']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-03'), true);
  var meta = executorModule.getTaskExecutor('CAN-B2-03');
  assert.strictEqual(meta.coverage, 'readiness-subset');
  assert.deepStrictEqual(meta.verifiedAssertionIds, ['CAN-B2-03-A01']);
  executorModule.resetTaskExecutors();

  var ctx = { deps: { getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw' }) } };
  assert.strictEqual(executors.hasAdminCredentials(ctx), true);
  assert.deepStrictEqual(executors.adminCredentialEnvNames(ctx), ['SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD']);

  var ctx2 = { deps: { getEnv: envWith({ STAGING_ADMIN_EMAIL: 'admin', STAGING_ADMIN_PASSWORD: 'pw' }) } };
  assert.strictEqual(executors.hasAdminCredentials(ctx2), true);

  var ctx3 = { deps: { getEnv: envWith({ VENDURE_ADMIN_API_URL: 'http://h' }) } };
  assert.strictEqual(executors.hasAdminCredentials(ctx3), false);
});

test('MISSING ADMIN IDENTITY -> BLOCK CLIENT_INPUT_SCOPE', async function() {
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1' }),
    runEnvRecord: { runId: 'run-mc-preflight' }
  });
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence && outcome.evidence.preflight, 'preflight present');
  assert.ok(Array.isArray(outcome.evidence.preflight.absentNames) && outcome.evidence.preflight.absentNames.length > 0, 'absent names: ' + JSON.stringify(outcome.evidence.preflight));
  assert.ok(outcome.evidence.preflight.absentNames.indexOf('SUPERADMIN_USERNAME') !== -1);
  assert.ok(outcome.evidence.preflight.absentNames.indexOf('SUPERADMIN_PASSWORD') !== -1);
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('admin') === -1 || JSON.stringify(outcome.evidence).indexOf('pw') === -1, true, 'no password leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('server down -> DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-down' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('missing account password -> CLIENT_INPUT_SCOPE', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw' }),
    runEnvRecord: { runId: 'run-mc-no-pw' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('SUCCESS -> READINESS_PASS all claims verified', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-ok', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, true, 'run succeeded: ' + (outcome.error || ''));
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never bare literal');
  assert.strictEqual(outcome.evidence.checks.publicationToSeveralCountries, true);
  assert.strictEqual(outcome.evidence.checks.perCountryCurrenciesMatch, true);
  assert.strictEqual(outcome.evidence.checks.distinctPrices, true);
  assert.strictEqual(outcome.evidence.checks.virtualStockPresent, true);
  assert.strictEqual(outcome.evidence.checks.purchaseDecrementsCorrectStock, true, 'stock decrement by 1: ' + JSON.stringify(outcome.evidence.observed.stockDeltaByCountry));
  assert.strictEqual(outcome.evidence.checks.noCrossCountryInventoryUse, true);
  assert.strictEqual(outcome.evidence.checks.unavailableAtZero, true);
  assert.strictEqual(outcome.evidence.checks.orderKeepsCountryAndDesignIdentity, true);
  assert.strictEqual(outcome.evidence.assertionReport.length, 1);
  assert.strictEqual(outcome.evidence.assertionReport[0].id, 'CAN-B2-03-A01');
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('test-pass'), -1, 'password redacted');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, terminalState.RESULT_PASS);
});

test('wrong currency -> APPLICATION_DEFECT', async function() {
  var s = await startServer('wrong-currency');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-bad-currency' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('same price across countries -> APPLICATION_DEFECT', async function() {
  var s = await startServer('same-price');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-same-price' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('order rejected -> APPLICATION_DEFECT', async function() {
  var s = await startServer('reject-order');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-reject' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('order bad slug -> APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-slug');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-bad-slug' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('order bad currency -> APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-currency');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-bad-currency' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-03');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('low-stock -> zero-stock unavailable verified', async function() {
  var s = await startServer('low-stock');
  var ctx = baseContext('CAN-B2-03', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-mc-zero-stock' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerMultiCountryPublication(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, true, outcome.error);
  assert.strictEqual(outcome.evidence.checks.unavailableAtZero, true);
  assert.strictEqual(outcome.evidence.observed.zeroStockCountry, PURCHASE_COUNTRY);
  assert.strictEqual(outcome.evidence.observed.postPurchaseStock[PURCHASE_COUNTRY], 0);
});
