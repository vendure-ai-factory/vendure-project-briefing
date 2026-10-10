'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/paymentConsistency');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

function fakeClock() {
  return function() { return new Date('2026-10-08T09:00:00.000Z'); };
}

function envWith(items) {
  return function() {
    return Object.assign({
      CHANNEL_TOKENS: TOKENS_JSON,
      SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass'
    }, items || {});
  };
}

function startServers(scenario, cb) {
  // Stripe fake server on one port, Shop API fake on another.
  var stripeServer = http.createServer(function(req, res) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      var raw = Buffer.concat(chunks).toString('utf8');
      var url = req.url || '';
      function send(status, obj) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      }
      if (scenario === 'stripe-500' && url.indexOf('/v1/payment_intents') !== -1) {
        send(505, { error: { message: 'stripe down' } });
        return;
      }
      if (url === '/v1/payment_intents') {
        if (scenario === 'stripe-401') {
          send(401, { error: { type: 'invalid_request_error', message: 'invalid key' } });
          return;
        }
        var body = {
          id: 'pi_test_123',
          status: 'requires_payment_method',
          livemode: false,
          amount: 100,
          currency: 'eur'
        };
        if (scenario === 'stripe-succeeded' || scenario === 'stripe-succeeded+shop-settled') body.status = 'succeeded';
        send(200, body);
        return;
      }
      if (url === '/v1/payment_intents/pi_test_123/cancel') {
        send(200, { id: 'pi_test_123', status: 'canceled', livemode: false });
        return;
      }
      send(404, { error: { message: 'not found' } });
    });
  });

  var shopServer = http.createServer(function(req, res) {
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
      if (scenario === 'shop-500') {
        send(500, { errors: [{ message: 'boom' }] });
        return;
      }
      if (query.indexOf('mutation Login') !== -1) {
        send(200, { data: { login: { __typename: 'CurrentUser', id: '1', identifier: body.variables.username } } });
        return;
      }
      if (query.indexOf('orderByCode') !== -1) {
        if (scenario === 'order-not-found') {
          send(200, { data: { orderByCode: null } });
          return;
        }
        if (scenario === 'order-settled' || scenario === 'planted-settled' || scenario === 'stripe-succeeded+shop-settled') {
          send(200, { data: { orderByCode: {
            id: '1',
            code: 'ED-PAY-0001',
            state: 'PaymentSettled',
            totalWithTax: 2975,
            currencyCode: 'EUR',
            payments: [{ id: 'pay1', method: 'stripe-payment-intent', amount: 2975, state: 'Settled', transactionId: 'pi_test_123' }]
          } } });
          return;
        }
        send(200, { data: { orderByCode: {
          id: '1',
          code: 'ED-PAY-0001',
          state: 'ArrangingPayment',
          totalWithTax: 2975,
          currencyCode: 'EUR',
          payments: []
        } } });
        return;
      }
      send(200, { data: {} });
    });
  });

  var stripePort, shopPort;
  function listenStripe() {
    stripeServer.listen(0, '127.0.0.1', function() {
      stripePort = stripeServer.address().port;
      shopServer.listen(0, '127.0.0.1', function() {
        shopPort = shopServer.address().port;
        cb(null, {
          stripeUrl: 'http://127.0.0.1:' + stripePort,
          shopUrl: 'http://127.0.0.1:' + shopPort,
          stripeServer: stripeServer,
          shopServer: shopServer
        });
      });
    });
  }
  stripeServer.on('error', function(err) { cb(err); });
  shopServer.on('error', function(err) { cb(err); });
  listenStripe();
}

function closeServers(s) {
  return new Promise(function(resolve) {
    var pending = 2;
    function done() { if (--pending <= 0) resolve(); }
    s.stripeServer.close(done);
    s.shopServer.close(done);
  });
}

function baseContext(taskId, overrides, srv) {
  overrides = overrides || {};
  var base = {
    taskId: taskId,
    task: { canonicalId: taskId, mandatoryAssertions: [], expectedResult: 'expected result for ' + taskId },
    shopApiBase: srv.shopUrl,
    stripeApiBase: srv.stripeUrl,
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
  if (overrides.plantedMismatch) base.plantedMismatch = overrides.plantedMismatch;
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

test('paymentConsistency: success returns READINESS_PASS with intent/order agreement and unverified receipt/ledger/callback', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('ok', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-success', stagingUrl: s.shopUrl };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.actual, 'expected result for CAN-B1-06');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.stripe.isTestKey, true);
  assert.strictEqual(outcome.evidence.stripe.createHttpStatus, 200);
  assert.strictEqual(outcome.evidence.stripe.createLivemode, false);
  assert.strictEqual(outcome.evidence.stripe.intentStatus, 'requires_payment_method');
  assert.strictEqual(outcome.evidence.stripe.cancelStatus, 'canceled');
  assert.strictEqual(outcome.evidence.observed.orderState, 'ArrangingPayment');
  assert.strictEqual(outcome.evidence.checks.paymentOrderStateAgree, true);
  assert.strictEqual(outcome.evidence.checks.intentCreated, true);
  assert.strictEqual(outcome.evidence.checks.intentCancelled, true);
  assert.ok(outcome.evidence.rawRequests, 'raw requests recorded');
  // No secret value is leaked (tokens / password / stripe key).
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('sk_test_tok'), -1, 'stripe key not in evidence');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'password redacted');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('receipt') !== -1, 'receipt listed unverified');
  assert.ok(joined.indexOf('ledger') !== -1, 'ledger listed unverified');
  assert.ok(joined.indexOf('webhook') !== -1 || joined.indexOf('callback') !== -1, 'callback listed unverified');
});

test('paymentConsistency: settled order with succeeded intent agrees', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('stripe-succeeded+shop-settled', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-settled' };
  ctx.task = { canonicalId: 'CAN-B1-06', expectedResult: 'expected result for CAN-B1-06' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, true);
  assert.strictEqual(outcome.evidence.observed.orderState, 'PaymentSettled');
  assert.strictEqual(outcome.evidence.observed.orderSettled, true);
  assert.strictEqual(outcome.evidence.checks.paymentOrderStateAgree, true);
});

test('paymentConsistency: planted success claim without settled order is detected (not a pass)', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('ok', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok', CAN_B1_06_PLANT_MISMATCH: '1' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-planted' };
  ctx.task = { canonicalId: 'CAN-B1-06', expectedResult: 'expected result for CAN-B1-06' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false, 'planted success claim must not pass');
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.mismatchDetected, true, 'planted mismatch is detected');
  assert.strictEqual(outcome.evidence.observed.planted, true, 'planted control active in evidence');
  assert.ok(outcome.error.indexOf('planted') !== -1, 'error names the planted control');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('paymentConsistency: payment/order state mismatch (settled order, not-succeeded intent) is detected', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('order-settled', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  // The intent is not succeeded (requires_payment_method) but the order claims
  // PaymentSettled: a browser/order success without the backend agreeing.
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-mismatch' };
  ctx.task = { canonicalId: 'CAN-B1-06', expectedResult: 'expected result for CAN-B1-06' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('mismatch') !== -1);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('paymentConsistency: Stripe down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('stripe-500', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-stripe-500' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('paymentConsistency: Shop API down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('shop-500', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-shop-500' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('paymentConsistency: missing Stripe key is CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('ok', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', { getEnv: envWith({}) }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-nokey' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.envVarNames.indexOf('STRIPE_SECRET_KEY') !== -1, 'names the stripe env var');
  assert.strictEqual(outcome.evidence.envVarNames.indexOf('STRIPE_TEST_SECRET_KEY') !== -1, true, 'names the registry alias');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('paymentConsistency: a live (non-test) key is CLIENT_INPUT_SCOPE', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('ok', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_live_ffffffffffffffff' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-live' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.error.indexOf('test-mode') !== -1);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('paymentConsistency: order not found is an APPLICATION_DEFECT', async function() {
  var s = await new Promise(function(resolve, reject) {
    startServers('order-not-found', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' })
  }, s);
  ctx.runEnvRecord = { runId: 'run-b1-06-noorder' };
  ctx.task = { canonicalId: 'CAN-B1-06', expectedResult: 'expected result for CAN-B1-06' };
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-06');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('paymentConsistency: register() registers CAN-B1-06 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-06'), true);
  var ex = executorModule.getTaskExecutor('CAN-B1-06');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B1-06-A01']);
  executorModule.resetTaskExecutors();
});

test('paymentConsistency: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b1-06-'));
  var runId = 'run-b1-06-' + Date.now().toString(36) + '-x1y';
  var s = await new Promise(function(resolve, reject) {
    startServers('ok', function(err, srv) { if (err) return reject(err); resolve(srv); });
  });
  var ctx = baseContext('CAN-B1-06', {
    getEnv: envWith({ STRIPE_SECRET_KEY: 'sk_test_tok' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.shopUrl }
  }, s);
  ctx.deps.config.evidenceRoot = evidenceRoot;
  var outcome = await executors.handlerPaymentConsistency(ctx);
  await closeServers(s);

  assert.strictEqual(outcome.success, true);
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-06');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'stripe-key.json', 'stripe-payment-intent.json', 'payment-consistency-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'executor-summary.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('sk_test_tok'), -1, 'stripe key redacted in evidence');
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
