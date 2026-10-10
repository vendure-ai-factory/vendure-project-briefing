'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/inventoryReplenishment');
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

// Stock levels: DE starts at 1 so a purchase of 1 drives it to 0, proving the
// zero boundary; other countries stay set so cross-country leakage is visible.
var BASE_STOCK = { DE: 1, AT: 8, HU: 5, GB: 12 };

function productBodyForCountry(country, stockOverride) {
  var stock = stockOverride !== undefined ? stockOverride : (BASE_STOCK[country] || 10);
  return {
    data: {
      product: {
        id: 'p-inv-' + country,
        name: 'Fixture 1 Nail Design',
        slug: executors.DEFAULT_PRODUCT_SLUG,
        variants: [{
          id: 'v-inv-' + country,
          sku: 'NAIL-DESIGN-1-' + country,
          stockLevel: stock
        }],
        customFields: { designFee: null, designTemplate: null }
      }
    }
  };
}

function createServerState(scenario) {
  return {
    stock: {
      DE: scenario === 'no-zero' ? 5 : (scenario === 'no-virtual' ? null : 1),
      AT: scenario === 'no-virtual' ? null : BASE_STOCK.AT,
      HU: scenario === 'no-virtual' ? null : BASE_STOCK.HU,
      GB: scenario === 'no-virtual' ? null : BASE_STOCK.GB
    },
    noDecrement: scenario === 'no-decrement',
    crossCountry: scenario === 'cross-country'
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

        if (query.indexOf('GetInventoryProduct') !== -1) {
          var token = req.headers['vendure-token'] || '';
          var country = 'DE';
          for (var ci = 0; ci < COUNTRIES.length; ci++) {
            if (tokens[COUNTRIES[ci]] === token) { country = COUNTRIES[ci]; break; }
          }
          send(200, productBodyForCountry(country, state.stock[country]));
          return;
        }

        if (query.indexOf('addItemToOrder') !== -1) {
          if (state.noDecrement) {
            send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-INV001', totalQuantity: 1, lines: [] } } });
            return;
          }
          if (state.stock[PURCHASE_COUNTRY] <= 0) {
            send(200, { data: { addItemToOrder: { __typename: 'InsufficientStockError', message: 'no stock' } } });
            return;
          }
          state.stock[PURCHASE_COUNTRY] = Math.max(0, state.stock[PURCHASE_COUNTRY] - ORDER_QUANTITY);
          if (state.crossCountry) {
            // Simulate warehouse leakage: a second country also decrements.
            var leakTarget = 'AT';
            state.stock[leakTarget] = Math.max(0, (state.stock[leakTarget] || BASE_STOCK[leakTarget]) - ORDER_QUANTITY);
          }
          send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-INV001', totalQuantity: 1, lines: [] } } });
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
  assert.deepStrictEqual(reg.registered, ['CAN-B2-12']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-12'), true);
  var meta = executorModule.getTaskExecutor('CAN-B2-12');
  assert.strictEqual(meta.coverage, 'readiness-subset');
  assert.deepStrictEqual(meta.verifiedAssertionIds, ['CAN-B2-12-A01']);
  executorModule.resetTaskExecutors();

  var ctx = { deps: { getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw' }) } };
  assert.strictEqual(executors.hasAdminCredentials(ctx), true);
  assert.deepStrictEqual(executors.adminCredentialEnvNames(ctx), ['SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD']);

  var ctx2 = { deps: { getEnv: envWith({ STAGING_ADMIN_EMAIL: 'admin', STAGING_ADMIN_PASSWORD: 'pw' }) } };
  assert.strictEqual(executors.hasAdminCredentials(ctx2), true);

  var ctx3 = { deps: { getEnv: envWith({ VENDURE_ADMIN_API_URL: 'http://h' }) } };
  assert.strictEqual(executors.hasAdminCredentials(ctx3), false);
});

test('fixture thresholds and stock defaults are numeric', function() {
  assert.strictEqual(typeof executors.fixtureLowStockThreshold(), 'number');
  assert.ok(executors.fixtureLowStockThreshold() >= 1);
  var vs = executors.fixtureVirtualStockByCountry();
  COUNTRIES.forEach(function(c) {
    assert.strictEqual(typeof vs[c], 'number');
  });
});

test('MISSING ADMIN IDENTITY -> BLOCK CLIENT_INPUT_SCOPE', async function() {
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1' }),
    runEnvRecord: { runId: 'run-inv-preflight' }
  });
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence && outcome.evidence.preflight, 'preflight present');
  assert.ok(Array.isArray(outcome.evidence.preflight.absentNames) && outcome.evidence.preflight.absentNames.length > 0, 'absent names present');
  assert.ok(outcome.evidence.preflight.absentNames.indexOf('SUPERADMIN_USERNAME') !== -1);
  assert.ok(outcome.evidence.preflight.absentNames.indexOf('SUPERADMIN_PASSWORD') !== -1);
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('admin') === -1 || JSON.stringify(outcome.evidence).indexOf('pw') === -1, true, 'no password leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('server down -> DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-inv-down' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('missing account password -> CLIENT_INPUT_SCOPE', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw' }),
    runEnvRecord: { runId: 'run-inv-no-pw' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('SUCCESS -> READINESS_PASS all shop-api claims verified', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-inv-ok', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, true, 'run succeeded: ' + (outcome.error || ''));
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never bare literal');
  assert.strictEqual(outcome.evidence.checks.localOrderUsesLocalStock, true, 'local stock decrement: ' + JSON.stringify(outcome.evidence.observed.stockDeltaByCountry));
  assert.strictEqual(outcome.evidence.checks.noCrossCountryInventoryUse, true);
  assert.strictEqual(outcome.evidence.checks.zeroBoundaryObserved, true);
  assert.strictEqual(outcome.evidence.checks.virtualStockPresent, true);
  assert.strictEqual(outcome.evidence.assertionReport.length, 1);
  assert.strictEqual(outcome.evidence.assertionReport[0].id, 'CAN-B2-12-A01');
  assert.strictEqual(outcome.evidence.observed.zeroStockCountry, PURCHASE_COUNTRY);
  assert.strictEqual(outcome.evidence.observed.stockAfterPurchase[PURCHASE_COUNTRY], 0);
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('test-pass'), -1, 'password redacted');
  assert.strictEqual(typeof outcome.evidence.observed.fixtureThresholds.lowStockThreshold, 'number');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, terminalState.RESULT_PASS);
});

test('stock not decremented -> APPLICATION_DEFECT', async function() {
  var s = await startServer('no-decrement');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-inv-no-decrement' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.localOrderUsesLocalStock, false);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('cross-country warehouse leakage -> APPLICATION_DEFECT', async function() {
  var s = await startServer('cross-country');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-inv-cross' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.noCrossCountryInventoryUse, false);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('no zero boundary observed -> APPLICATION_DEFECT', async function() {
  var s = await startServer('no-zero');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-inv-no-zero' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.zeroBoundaryObserved, false);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('no virtual stock present -> APPLICATION_DEFECT', async function() {
  var s = await startServer('no-virtual');
  var ctx = baseContext('CAN-B2-12', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'pw', SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-inv-no-virtual' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerInventoryReplenishment(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.virtualStockPresent, false);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-12');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});
