'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var executors = require('../src/executors/newChannelPropagation');
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

var ADMIN_LOGIN_MARKER = 'mutation Login';
var ADMIN_CHANNELS_MARKER = 'query Channels';
var ONBOARD_MARKER = 'OnboardCountry';
var PROFILE_MARKER = 'GetAvailableCountries';
var SHIPPING_MARKER = 'GetAvailableCountries';
var ACTIVE_CUSTOMER_MARKER = 'GetActiveCustomer';

function fakeClock() {
  return function() { return new Date('2026-10-09T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

function backendChannels(scenario) {
  var base = [
    { id: 'c1', code: 'DE', token: 'de-token' },
    { id: 'c2', code: 'AT', token: 'at-token' },
    { id: 'c3', code: 'HU', token: 'hu-token' },
    { id: 'c4', code: 'GB', token: 'gb-token' }
  ];
  if (scenario === 'mismatch-profile') {
    // An extra enabled channel (NL) exists in the backend but the Shop
    // profile selector does not list it.
    base.push({ id: 'c5', code: 'NL', token: 'nl-token' });
  }
  return base;
}

function profileCountries(scenario) {
  if (scenario === 'mismatch-profile') return ['DE', 'AT', 'HU', 'GB'];
  return ['DE', 'AT', 'HU', 'GB'];
}

function shippingCountries(scenario) {
  return [
    { id: '1', code: 'DE', name: 'Germany' },
    { id: '2', code: 'AT', name: 'Austria' },
    { id: '3', code: 'HU', name: 'Hungary' },
    { id: '4', code: 'GB', name: 'United Kingdom' }
  ];
}

/**
 * A tiny fake backend server with both a Shop API (/shop-api) and an Admin
 * API (/admin-api). The `scenario` selects the responses:
 *  - 'ok': shop selectors list exactly the backend channels; admin creds work;
 *    channel creation is skipped (run mode default).
 *  - 'no-admin': the server serves no admin route (no admin creds supplied);
 *    the executor must block CLIENT_INPUT_SCOPE before any admin call.
 *  - 'mismatch-profile': the backend channel list has an extra country (NL)
 *    that the profile selector does not list -> APPLICATION_DEFECT.
 *  - '500': every /shop-api call returns HTTP 500 -> DEPENDENCY_ENVIRONMENT.
 *  - 'admin-500': /admin-api login returns HTTP 500 -> DEPENDENCY_ENVIRONMENT.
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

        function send(status, obj, extraHeaders) {
          var headers = Object.assign({ 'content-type': 'application/json' }, extraHeaders || {});
          res.writeHead(status, headers);
          res.end(JSON.stringify(obj));
        }

        // Admin API endpoint
        if (req.url === '/admin-api') {
          if (query.indexOf(ONBOARD_MARKER) !== -1) {
            send(200, { data: { onboardCountry: true } });
            return;
          }
          if (query.indexOf(ADMIN_LOGIN_MARKER) !== -1) {
            if (scenario === 'admin-500') {
              send(500, { errors: [{ message: 'admin boom' }] });
              return;
            }
            send(200, { data: { login: { __typename: 'CurrentUser', id: '9', identifier: vars.username } } }, { 'vendure-auth-token': 'admin-token-1' });
            return;
          }
          if (query.indexOf(ADMIN_CHANNELS_MARKER) !== -1) {
            send(200, { data: { channels: { items: backendChannels(scenario) } } });
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
        if (query.indexOf(PROFILE_MARKER) !== -1 && query.indexOf('availableCountries') === -1) {
          // The profile/Customer Country selector (affiliateAvailableCountries).
          send(200, { data: { affiliateAvailableCountries: profileCountries(scenario) } });
          return;
        }
        if (query.indexOf(SHIPPING_MARKER) !== -1) {
          // The shipping-address country selector (availableCountries).
          send(200, { data: { availableCountries: shippingCountries(scenario) } });
          return;
        }
        if (query.indexOf(ACTIVE_CUSTOMER_MARKER) !== -1) {
          send(200, { data: { activeCustomer: { id: '1', firstName: 'Buyer', lastName: 'One', emailAddress: vars.username || 'buyer.one@example.com', customFields: { countryCode: 'DE', isDesigner: false, isKycVerified: false }, addresses: [] } } });
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
  if (overrides.depsInject) base.deps = Object.assign(base.deps, overrides.depsInject);
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

test('newChannelPropagation: success returns READINESS_PASS with selectors verified and creation skipped', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass', VENDURE_ADMIN_API_URL: s.url + '/admin-api' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B1-02');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.creationSkipped, true, 'channel creation skipped in default mode');
  assert.strictEqual(outcome.evidence.observed.runMode, 'default');
  assert.strictEqual(outcome.evidence.observed.channelCreationAllowed, false);
  assert.strictEqual(outcome.evidence.observed.propagationVerified, true, 'profile+shipping selectors propagate enabled channels');
  assert.strictEqual(outcome.evidence.checks.profileSelectorMatches, true);
  assert.strictEqual(outcome.evidence.checks.shippingSelectorMatches, true);
  assert.strictEqual(outcome.evidence.observed.customerCountry, 'DE');
  assert.ok(outcome.evidence.assertionReport.length === 3, 'one report entry per assertion');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('creation skipped') !== -1, 'creation skip is listed unverified');
  assert.ok(joined.indexOf('design-publication page') !== -1, 'design-publication selector unverified');
  // Secrets: passwords and non-frozen tokens are redacted; the four frozen channel
  // tokens may remain (they are the four frozen channel tokens).
  var serialized = JSON.stringify(outcome.evidence);
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'customer password redacted');
  assert.strictEqual(serialized.indexOf('admin-pass'), -1, 'admin password redacted');
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'channel token redacted');
});

test('newChannelPropagation: missing admin identity blocks CLIENT_INPUT_SCOPE with preflight proof', async function() {
  var s = await startServer('no-admin');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.preflight, 'preflight proof present');
  assert.strictEqual(outcome.evidence.preflight.blocked, true);
  assert.strictEqual(outcome.evidence.preflight.failureClass, 'CLIENT_INPUT_SCOPE');
  var serialized = JSON.stringify(outcome.evidence);
  assert.strictEqual(serialized.indexOf('admin-pass'), -1, 'no admin password value leaked');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'no customer password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('newChannelPropagation: profile selector not matching backend channels is an APPLICATION_DEFECT', async function() {
  var s = await startServer('mismatch-profile');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass', VENDURE_ADMIN_API_URL: s.url + '/admin-api' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.observed.backendCountryList.indexOf('NL') !== -1, true, 'backend oracle has the extra channel');
  assert.strictEqual(outcome.evidence.checks.profileSelectorMatches, false, 'mismatch detected');
  assert.strictEqual(outcome.result, null);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('newChannelPropagation: shop-api down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('newChannelPropagation: admin-api down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('admin-500');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass', VENDURE_ADMIN_API_URL: s.url + '/admin-api' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.strictEqual(outcome.evidence.checks.adminChannelsRead, false);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-02');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('newChannelPropagation: missing account password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B1-02');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('newChannelPropagation: register() registers CAN-B1-02 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B1-02'), true);
  var ex = executorModule.getTaskExecutor('CAN-B1-02');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B1-02-A01', 'CAN-B1-02-A03']);
  executorModule.resetTaskExecutors();
});

test('newChannelPropagation: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b102-'));
  var runId = 'run-b102-' + Date.now().toString(36) + '-x7r';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B1-02', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', SUPERADMIN_USERNAME: 'admin', SUPERADMIN_PASSWORD: 'admin-pass', VENDURE_ADMIN_API_URL: s.url + '/admin-api' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.deps.config.shopApiUrl = s.url;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNewChannelPropagation(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B1-02');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'new-channel-propagation-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var requests = JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8'));
  var serialized = JSON.stringify(requests);
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('newChannelPropagation: GraphQL operations are copied from the migration-input source', function() {
  assert.ok(executors.PROFILE_COUNTRIES_QUERY.indexOf('affiliateAvailableCountries') !== -1, 'profile op from api.ts');
  assert.ok(executors.SHIPPING_COUNTRIES_QUERY.indexOf('availableCountries') !== -1, 'shipping op from queries.ts');
  assert.ok(executors.ADMIN_LOGIN_MUTATION.indexOf('mutation Login') !== -1, 'admin login from publish_product_v11.mjs');
  assert.ok(executors.ADMIN_CHANNELS_QUERY.indexOf('channels') !== -1, 'admin channels from publish_product_v11.mjs');
  assert.ok(executors.ONBOARD_COUNTRY_MUTATION.indexOf('onboardCountry') !== -1, 'creation op from api-extensions.ts');
});

test('newChannelPropagation: channel creation is gated to the isolated staging clone only', function() {
  function ctx(overrides) {
    return Object.assign({}, overrides || {});
  }
  assert.strictEqual(executors.channelCreationAllowed(ctx({ runMode: 'default' })), false, 'default mode never allows creation');
  assert.strictEqual(executors.channelCreationAllowed(ctx({})), false, 'no mode never allows creation');
  assert.strictEqual(executors.channelCreationAllowed(ctx({ runMode: 'isolated-staging-clone' })), true, 'explicit isolated staging clone allows creation');
  assert.strictEqual(executors.channelCreationAllowed(ctx({ runEnvRecord: { runMode: 'isolated-staging-clone' } })), true, 'runEnvRecord mode respected');
  assert.strictEqual(executors.resolveRunMode(ctx({ runMode: 'default' })), 'default');
  assert.strictEqual(executors.resolveRunMode(ctx({})), 'default', 'defaults to default run mode');
});

test('newChannelPropagation: regression coverage maps areas to installed executors', function() {
  var installed = ['CAN-B1-01', 'CAN-B1-05', 'CAN-B1-08', 'CAN-B2-09', 'CAN-B2-05', 'CAN-B2-16'];
  var context = { deps: { executorModule: { listTaskExecutors: function() { return installed.slice(); } } } };
  var areas = executors.regressionCoverage(context);
  assert.ok(areas.some(function(a) { return a.area === 'publication' && a.coveredByExecutor === false; }), 'publication has no executor');
  assert.ok(areas.some(function(a) { return a.area === 'price/currency' && a.coveredByExecutor === true; }), 'price/currency covered');
  assert.ok(areas.some(function(a) { return a.area === 'cart' && a.coveredByExecutor === true; }), 'cart covered');
  assert.ok(areas.some(function(a) { return a.area === 'payment' && a.coveredByExecutor === false; }), 'payment has no executor');
  assert.ok(areas.some(function(a) { return a.area === 'receipts' && a.coveredByExecutor === false; }), 'receipts has no executor');
  var coveredCount = areas.filter(function(a) { return a.coveredByExecutor; }).length;
  assert.strictEqual(coveredCount, 8, 'the eight executor-covered regression areas are each covered by CAN-B1-01/05/08/09/05/16');
});

test('newChannelPropagation: buildAssertionReport lists A01/A03 verified and A02 unverified regression', function() {
  var checks = {
    adminChannelsRead: true,
    profileSelectorMatches: true,
    shippingSelectorMatches: true,
    customerCountryIsDe: true,
    creationSkipped: true,
    propagationVerified: true,
    regressionCoveredCount: 7,
    regressionUncoveredCount: 8
  };
  var observed = {
    runMode: 'default',
    channelCreationAllowed: false,
    backendCountryList: ['DE', 'AT', 'HU', 'GB'],
    profileSelector: ['DE', 'AT', 'HU', 'GB'],
    shippingSelector: ['DE', 'AT', 'HU', 'GB'],
    customerCountry: 'DE',
    creationSkipped: true
  };
  var regression = [
    { area: 'publication', coveredByExecutor: false, note: 'none' },
    { area: 'price/currency', coveredByExecutor: true, note: 'ok' },
    { area: 'payment', coveredByExecutor: false, note: 'none' }
  ];
  var report = executors.buildAssertionReport(observed, checks, regression);
  assert.strictEqual(report.length, 3);
  assert.strictEqual(report[0].id, 'CAN-B1-02-A01');
  assert.strictEqual(report[1].id, 'CAN-B1-02-A02');
  assert.strictEqual(report[2].id, 'CAN-B1-02-A03');
  assert.strictEqual(report[0].verified, true, 'A01 readiness subset verified');
  assert.strictEqual(report[1].verified, false, 'A02 full regression unverified');
  assert.ok(report[1].unverifiedClaims.some(function(c) { return c.claim.indexOf('regression area') === 0; }), 'A02 unverified areas listed');
  assert.strictEqual(report[2].verified, true, 'A03 creation-safety verified');
});
