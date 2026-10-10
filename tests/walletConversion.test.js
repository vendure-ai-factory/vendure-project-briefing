'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/walletConversion');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var SENDER = 'buyer.one@example.com';
var RECEIVER = 'buyer.two@example.com';
var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

function fakeClock() {
  return function() { return new Date('2026-10-09T09:00:00.000Z'); };
}

function envWith(items) {
  return function() {
    return Object.assign({
      CHANNEL_TOKENS: TOKENS_JSON,
      SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass-one',
      SHOP_ACCOUNT_PASSWORD_BUYER_TWO: 'test-pass-two'
    }, items || {});
  };
}

/**
 * A tiny fake Shop API server. The `scenario` selects the responses:
 *  - 'ok': the DE sender (EUR wallet) and the HU receiver (HUF wallet) have
 *    correct profiles; transferBalance succeeds for a normal cross-currency
 *    transfer, rejects the self-referral, rejects the overdraft rollback, and
 *    requestPayout succeeds.
 *  - 'wrong-currency': the HU receiver profile reports a DE (EUR) wallet, so
 *    the executor must detect that the wallet/payment currencies no longer
 *    differ (a planted application defect).
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
        if (query.indexOf('Login') !== -1) {
          send(200, { data: { login: { __typename: 'CurrentUser', id: '1', identifier: vars.username } } });
          return;
        }
        if (query.indexOf('GetWalletProfile') !== -1) {
          var token = req.headers['vendure-token'] || '';
          var isSender = token === 'de-token';
          var profile = {
            id: isSender ? '1' : '2',
            firstName: isSender ? 'Buyer' : 'Receiver',
            lastName: 'Account',
            emailAddress: isSender ? SENDER : RECEIVER,
            customFields: {
              countryCode: isSender ? 'DE' : (scenario === 'wrong-currency' ? 'DE' : 'HU'),
              balanceWithdrawable: isSender ? 10000 : 5000,
              balanceBonus: 100,
              balanceNonWithdrawable: 0
            },
            payouts: []
          };
          send(200, { data: { activeCustomer: profile } });
          return;
        }
        if (query.indexOf('TransferBalance') !== -1) {
          if (vars.receiverEmail === SENDER) {
            send(200, { data: { transferBalance: { success: false, message: 'Cannot transfer to yourself', newBalance: null } } });
            return;
          }
          if (vars.amount > 10000) {
            send(200, { data: { transferBalance: { success: false, message: 'Insufficient withdrawable balance', newBalance: null } } });
            return;
          }
          send(200, { data: { transferBalance: { success: true, message: 'ok', newBalance: 9000 } } });
          return;
        }
        if (query.indexOf('RequestPayout') !== -1) {
          send(200, { data: { requestPayout: { success: true, message: 'ok', transactionId: 'txn_1' } } });
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

test('walletConversion: success returns READINESS_PASS with transfer, self-referral rejection, rollback and withdrawal verified', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-07', {
    getEnv: envWith({}),
    runEnvRecord: { runId: 'run-b2-07-success', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerWalletConversion(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-07');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.senderCurrency, 'EUR');
  assert.strictEqual(outcome.evidence.observed.receiverCurrency, 'HUF');
  assert.strictEqual(outcome.evidence.checks.currencyDiffers, true);
  assert.strictEqual(outcome.evidence.checks.transferSucceeded, true);
  assert.strictEqual(outcome.evidence.checks.selfReferralRejected, true);
  assert.strictEqual(outcome.evidence.checks.rollbackAttempted, true);
  assert.strictEqual(outcome.evidence.checks.withdrawalAttempted, true);
  assert.strictEqual(outcome.evidence.checks.rateResolved, true);
  // Frozen EUR->HUF cross rate is 395 (fixtures.v1.json rates EUR=1, HUF=395).
  assert.strictEqual(outcome.evidence.expected.frozenRate, 395);
  assert.strictEqual(outcome.evidence.expected.expectedConvertedAmount, 395000);
  assert.strictEqual(outcome.evidence.observed.convertedAmount, 395000, 'converted amount recorded');
  assert.deepStrictEqual(outcome.evidence.expected.debitOrder, ['AUA', 'SNA', 'MCA']);
  assert.ok(outcome.evidence.assertionReport.length === 4, 'one report entry per mandatory assertion');
  // Stripe/DB-only claims are explicitly listed as unverified.
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe Runner') !== -1, 'final payment state listed unverified');
  assert.ok(joined.indexOf('ledger record') !== -1, 'ledger record listed unverified');
  assert.ok(joined.indexOf('spendBalance') !== -1, 'wallet payment listed unverified');
  // Tokens and passwords are redacted from evidence.
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'password redacted');
});

test('walletConversion: matching wallet currencies (receiver reports EUR) is an APPLICATION_DEFECT', async function() {
  var s = await startServer('wrong-currency');
  var ctx = baseContext('CAN-B2-07', {
    getEnv: envWith({}),
    runEnvRecord: { runId: 'run-b2-07-wrong-currency' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerWalletConversion(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.observed.receiverCurrency, 'EUR', 'observed the wrong wallet currency');
  assert.ok(outcome.error.indexOf('currency are not different') !== -1, 'error names the currency difference');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-07');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('walletConversion: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-07', {
    getEnv: envWith({}),
    runEnvRecord: { runId: 'run-b2-07-500' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerWalletConversion(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('500') !== -1 || outcome.error.indexOf('failed') !== -1, 'error mentions failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-07');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('walletConversion: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-07', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: null, SHOP_ACCOUNT_PASSWORD_BUYER_TWO: null }),
    runEnvRecord: { runId: 'run-b2-07-nopass' }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerWalletConversion(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  // No value may leak: the secret scan would also catch a literal value.
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-07');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('walletConversion: register() registers CAN-B2-07 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-07'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-07');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-07-A01']);
  executorModule.resetTaskExecutors();
});

test('walletConversion: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b2-07-'));
  var runId = 'run-b2-07-' + Date.now().toString(36) + '-x1y';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-07', {
    getEnv: envWith({}),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerWalletConversion(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-07');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'wallet-conversion-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'executor-summary.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
