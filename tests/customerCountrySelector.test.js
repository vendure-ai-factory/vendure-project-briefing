'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var executors = require('../src/executors/customerCountrySelector');
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

var COUNTRIES_QUERY_MARKER = 'GetAvailableCountries';
var ADMIN_LOGIN_MARKER = 'mutation Login';
var ADMIN_CHANNELS_MARKER = 'Channels';

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

/**
 * A tiny fake backend server with both a Shop API (/shop-api) and an Admin
 * API (/admin-api). The `scenario` selects the responses:
 *  - 'ok': the shop selector list is exactly the backend channels plus OTHER;
 *    the customer profile country is DE, wallet EUR, order follows EUR.
 *  - 'mismatch-selector': the shop selector list omits OTHER (or differs from
 *    the backend list) while the admin channels list is read, so the
 *    selector-vs-backend comparison mismatches -> APPLICATION_DEFECT.
 *  - 'no-admin-credentials': no admin creds are supplied; the backend
 *    comparison is reported unverified instead.
 *  - '500': every /shop-api call returns HTTP 500.
 */
function startServer(scenario) {
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
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

        // Admin API endpoint
        if (req.url === '/admin-api') {
          if (scenario === 'no-admin-credentials') {
            // No admin route served; the executor should not call it.
            send(404, {});
            return;
          }
          if (query.indexOf(ADMIN_LOGIN_MARKER) !== -1) {
            res.writeHead(200, { 'content-type': 'application/json', 'vendure-auth-token': 'admin-token-1' });
            res.end(JSON.stringify({ data: { login: { __typename: 'CurrentUser', id: '9', identifier: vars.username } } }));
            return;
          }
          if (query.indexOf(ADMIN_CHANNELS_MARKER) !== -1) {
            if (scenario === 'mismatch-selector') {
              // Backend channels include one country not in the selector.
              send(200, { data: { channels: { items: [{ id: 'c1', code: 'DE', token: 'de-token' }, { id: 'c2', code: 'AT', token: 'at-token' }, { id: 'c3', code: 'HU', token: 'hu-token' }, { id: 'c4', code: 'GB', token: 'gb-token' }, { id: 'c5', code: 'NL', token: 'nl-token' }] } } });
              return;
            }
            send(200, { data: { channels: { items: [{ id: 'c1', code: 'DE', token: 'de-token' }, { id: 'c2', code: 'AT', token: 'at-token' }, { id: 'c3', code: 'HU', token: 'hu-token' }, { id: 'c4', code: 'GB', token: 'gb-token' }] } } });
            return;
          }
          send(200, { data: {} });
          return;
        }

        // Shop API endpoint
        if (req.url !== '/shop-api') {
          send(404, {});
          return;
        }
        if (scenario === '500') {
          send(500, { errors: [{ message: 'boom' }] });
          return;
        }
        if (query.indexOf('mutation Login') !== -1) {
          send(200, { data: { login: { __typename: 'CurrentUser', id: '1', identifier: vars.username } } });
          return;
        }
        if (query.indexOf('GetAvailableCountries') !== -1) {
          // The profile/new-customer selector list. In the 'ok' case it exactly
          // matches the backend channels (DE, AT, HU, GB) plus OTHER; in the
          // 'mismatch-selector' case it omits OTHER.
          var countries = ['DE', 'AT', 'HU', 'GB'];
          if (scenario !== 'mismatch-selector') countries.push('OTHER');
          send(200, { data: { affiliateAvailableCountries: countries } });
          return;
        }
        if (query.indexOf('SetSessionCurrencyCode') !== -1) {
          send(200, { data: { setSessionCurrencyCode: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', totalWithTax: 2500, currencyCode: vars.currency } } });
          return;
        }
        if (query.indexOf('GetActiveCustomer') !== -1) {
          send(200, { data: { activeCustomer: { id: '1', firstName: 'Buyer', lastName: 'One', emailAddress: vars.username || 'buyer.one@example.com', customFields: { countryCode: 'DE', isDesigner: true, isKycVerified: false }, addresses: [{ country: { code: 'DE' } }] } } });
          return;
        }
        if (query.indexOf('GetActiveOrder') !== -1) {
          send(200, { data: { activeOrder: { id: '1', code: 'ED-RUN-0001', state: 'AddingItems', totalQuantity: 1, subTotal: 2500, subTotalWithTax: 2500, shipping: 0, shippingWithTax: 0, total: 2500, totalWithTax: 2500, currencyCode: 'EUR', lines: [] } } });
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

test('customerCountrySelector: success returns READINESS_PASS with verified selector matches and unverified payment', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-08', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass', VENDURE_ADMIN_API_URL: s.url + '/admin-api' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_08(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never a bare literal');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B1-08', 'actual mirrors the canonical expected result');
  assert.ok(outcome.evidence, 'evidence present');
  assert.ok(outcome.evidence.observed.selectorList.indexOf('DE') !== -1, 'selector contains DE');
  assert.ok(outcome.evidence.observed.selectorList.indexOf('OTHER') !== -1, 'selector contains the permitted other-country option');
  assert.ok(outcome.evidence.observed.backendComparison.state === 'compared', 'backend channels compared via admin API');
  assert.strictEqual(outcome.evidence.observed.backendCountryList.indexOf('DE') !== -1, true, 'backend list read');
  assert.strictEqual(outcome.evidence.observed.backendCountryList.indexOf('NL') === -1, true, 'backend list matches (no NL)');
  assert.strictEqual(outcome.evidence.checks.selectorMatchesBackend, true, 'selector matches backend + OTHER');
  assert.strictEqual(outcome.evidence.observed.customerCountry, 'DE');
  assert.strictEqual(outcome.evidence.checks.walletCurrencyMatches, true);
  assert.strictEqual(outcome.evidence.checks.orderCurrencyFollows, true);
  assert.ok(outcome.evidence.assertionReport.length === 3, 'one report entry per mandatory assertion');
  assert.ok(outcome.evidence.unverified.length >= 3, 'payment/receipt listed unverified');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe') !== -1, 'unverified lists mention the Stripe Runner');
  // Tokens and passwords are redacted from evidence.
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'customer password redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('admin-pass'), -1, 'admin password redacted');
});

test('customerCountrySelector: admin credential env NAME reported without value when backend not compared', async function() {
  var s = await startServer('no-admin-credentials');
  var ctx = baseContext('CAN-B1-08', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_08(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should still succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'still a readiness pass');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.backendComparison.state, 'unverified');
  assert.ok(outcome.evidence.observed.backendComparison.credentialNames.indexOf('SUPERADMIN_USERNAME') === -1 &&
    outcome.evidence.observed.backendComparison.credentialNames.length === 0, 'no admin env name recorded when none set');
  var serialized = JSON.stringify(outcome.evidence);
  assert.ok(serialized.indexOf('test-pass') === -1, 'customer password value never leaks');
  assert.ok(serialized.indexOf('admin-pass') === -1, 'admin password value never leaks');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('backend Channel list') !== -1, 'backend comparison reported unverified');
});

test('customerCountrySelector: selector list not matching backend is an APPLICATION_DEFECT', async function() {
  var s = await startServer('mismatch-selector');
  var ctx = baseContext('CAN-B1-08', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_08(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.selectorMatchesBackend, false, 'mismatch detected');
  assert.strictEqual(outcome.evidence.observed.backendCountryList.indexOf('NL') !== -1, true, 'backend has extra country');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-08');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('customerCountrySelector: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B1-08', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_08(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('failed') !== -1 || outcome.error.indexOf('500') !== -1, 'error mentions failure');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-08');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('customerCountrySelector: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-08', {
    getEnv: envWith({})
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerB1_08(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-08');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('customerCountrySelector: register() registers CAN-B1-08 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-08'), true);
  var ex = executorModule.getTaskExecutor('CAN-B1-08');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B1-08-A01']);
  executorModule.resetTaskExecutors();
});

test('customerCountrySelector: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b108-'));
  var runId = 'run-b108-' + Date.now().toString(36) + '-x7r';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-08', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  ctx.deps.config.shopApiUrl = s.url;
  var outcome = await executors.handlerB1_08(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-08');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'customer-country-selector-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('customerCountrySelector: GraphQL operations are copied from the migration-input source', function() {
  assert.ok(executors.AVAILABLE_COUNTRIES_QUERY.indexOf('affiliateAvailableCountries') !== -1, 'selector op from source (api.ts)');
  assert.ok(executors.ADMIN_LOGIN_MUTATION.indexOf('mutation Login') !== -1, 'admin login op from source');
  assert.ok(executors.ADMIN_CHANNELS_QUERY.indexOf('channels') !== -1, 'admin channels op from source');
  assert.ok(executors.ADMIN_CHANNELS_QUERY.indexOf('token') !== -1, 'channel token field present');
});

test('customerCountrySelector: buildAssertionReport lists A01/A03 verified and A02 Stripe-unverified', function() {
  var observed = {
    selectorList: ['DE', 'AT', 'HU', 'GB', 'OTHER'],
    otherCountryPermitted: true,
    backendComparison: { state: 'compared', channels: [{ code: 'DE', token: 'de-token' }] },
    backendCountryList: ['DE', 'AT', 'HU', 'GB'],
    customerCountry: 'DE',
    walletCurrency: 'EUR',
    withdrawalCurrency: 'EUR',
    productCountryCodes: ['DE'],
    orderCurrency: 'EUR'
  };
  var checks = {
    selectorListRead: true,
    otherCountryPermitted: true,
    selectorMatchesBackend: true,
    backendComparisonUnverified: false,
    customerCountryIsDe: true,
    walletCurrencyMatches: true,
    orderCurrencyFollows: true,
    withdrawalCurrencyMatches: true
  };
  var report = executors.buildAssertionReport(observed, checks);
  assert.strictEqual(report.length, 3);
  assert.strictEqual(report[0].id, 'CAN-B1-08-A01');
  assert.strictEqual(report[1].id, 'CAN-B1-08-A02');
  assert.strictEqual(report[2].id, 'CAN-B1-08-A03');
  assert.strictEqual(report[1].verified, false, 'A02 payment is unverified');
  assert.ok(report[1].unverifiedClaims.some(function(c) { return c.why.indexOf('Stripe') !== -1; }), 'A02 unverified claims mention Stripe');
});
