'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var executors = require('../src/executors/orderMerge');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

// Query markers (substring search in the query body).
var LOGIN_MARKER = 'Login';
var HAS_MERGEABLE_MARKER = 'hasMergeableOrder';
var GET_MERGEABLE_MARKER = 'getMergeableOrders';
var MERGE_CART_MARKER = 'mergeCartWithUnexportedOrder';
var ORDER_DETAIL_MARKER = 'GetOrderMergeDetail';
var ADD_TO_ORDER_MARKER = 'addItemToOrder';

var DE_ORDER = {
  id: 'ord-101', code: 'ORD-DE-101', totalWithTax: 2800, currencyCode: 'EUR', state: 'PaymentSettled',
  orderPlacedAt: '2026-10-01T10:00:00.000Z',
  shippingAddress: { fullName: 'Buyer One', streetLine1: 'Main St 1', city: 'Berlin', postalCode: '10115', country: 'Germany', countryCode: 'DE' },
  shippingMethodId: 'ship-de-1', shippingMethodName: 'DHL'
};
var AT_ORDER = {
  id: 'ord-301', code: 'ORD-AT-301', totalWithTax: 2600, currencyCode: 'EUR', state: 'PaymentSettled',
  orderPlacedAt: '2026-10-02T10:00:00.000Z',
  shippingAddress: { fullName: 'Buyer One', streetLine1: 'Wien', city: 'Vienna', postalCode: '1010', country: 'Austria', countryCode: 'AT' },
  shippingMethodId: 'ship-at-1', shippingMethodName: 'Post AT'
};
var ADDING_ORDER = {
  id: 'ord-199', code: 'ORD-UNPAID-199', totalWithTax: 900, currencyCode: 'EUR', state: 'AddingItems',
  orderPlacedAt: '2026-10-03T10:00:00.000Z',
  shippingAddress: { fullName: 'Buyer One', streetLine1: 'Unpaid St', city: 'Berlin', postalCode: '10115', country: 'Germany', countryCode: 'DE' },
  shippingMethodId: null, shippingMethodName: null
};

function fakeExecFile(outputText) {
  return function(file, args, options, cb) {
    cb(null, outputText, '');
  };
}

var DRY_RUN_OUTPUT = [
  '=== CSV-Based Bulk Shipping Tool (public adapter) ===',
  'CSV: ' + require('path').join(os.tmpdir(), executors.SHIPPED_FIXTURE_FILE),
  'Found 1 order(s) marked for shipment.',
  '  ORD-DE-102',
  'DRY_RUN=true; no API request was sent.'
].join('\n') + '\n';

function fakeClock() {
  return function() { return new Date('2026-10-09T10:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
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
        var variables = body.variables || {};
        var token = req.headers['vendure-token'] || '';
        var reqCookie = null;
        var cookieHeader = req.headers['cookie'] || '';
        var cookieMatch = cookieHeader.match(/session=([^;]+)/);
        if (cookieMatch) reqCookie = cookieMatch[1];
        var sessionKey = reqCookie || (variables.username || null);

        function send(status, obj, extraHeaders) {
          var hdrs = { 'content-type': 'application/json' };
          if (reqCookie) hdrs['set-cookie'] = 'session=' + reqCookie;
          else if (sessionKey) hdrs['set-cookie'] = 'session=' + sessionKey;
          if (extraHeaders) Object.keys(extraHeaders).forEach(function(k) { hdrs[k] = extraHeaders[k]; });
          res.writeHead(status, hdrs);
          res.end(JSON.stringify(obj));
        }

        if (scenario === '500') {
          send(500, { errors: [{ message: 'boom' }] });
          return;
        }

        if (query.indexOf(LOGIN_MARKER) !== -1) {
          send(200, { data: { login: { __typename: 'CurrentUser', id: 'user-1', identifier: variables.username } } });
          return;
        }

        if (query.indexOf(HAS_MERGEABLE_MARKER) !== -1) {
          var hasMergeable = scenario !== 'no-mergeable';
          send(200, { data: { hasMergeableOrder: hasMergeable } });
          return;
        }

        if (query.indexOf(GET_MERGEABLE_MARKER) !== -1) {
          var deList = [DE_ORDER];
          if (scenario === 'cross-country-leak') deList = [DE_ORDER, AT_ORDER];
          if (scenario === 'unpaid-mergeable') deList = [DE_ORDER, ADDING_ORDER];
          if (scenario === 'exported-leak') deList = [DE_ORDER];
          if (scenario === 'no-mergeable') deList = [];
          var list = token.indexOf('at-token') !== -1 ? [AT_ORDER] : deList;
          send(200, { data: { getMergeableOrders: list } });
          return;
        }

        if (query.indexOf(ADD_TO_ORDER_MARKER) !== -1) {
          send(200, { data: { addItemToOrder: { __typename: 'Order', id: 'cart-1', code: 'CART-1', totalQuantity: 1, lines: [] } } });
          return;
        }

        if (query.indexOf(MERGE_CART_MARKER) !== -1) {
          var targetId = variables.targetOrderId;
          if (targetId === 'ord-301') {
            send(200, { data: { mergeCartWithUnexportedOrder: { success: false, message: 'Orders belong to different product countries', orderCode: null } } });
            return;
          }
          if (scenario === 'merge-accepted') {
            send(200, { data: { mergeCartWithUnexportedOrder: { success: true, message: 'merged', orderCode: 'ORD-DE-101' } } });
            return;
          }
          send(200, { data: { mergeCartWithUnexportedOrder: { success: true, message: 'merged', orderCode: 'ORD-DE-101' } } });
          return;
        }

        if (query.indexOf(ORDER_DETAIL_MARKER) !== -1) {
          var code = variables.code || 'ORD-DE-101';
          if (scenario === 'recalc-wrong') {
            send(200, {
              data: { orderByCode: mergedOrder(9000, 4999, 700) }
            });
            return;
          }
          send(200, { data: { orderByCode: mergedOrder() } });
          return;
        }

        send(200, { data: {} });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

// A merged order whose totals are self-consistent (totalWithTax ==
// subTotalWithTax + shippingWithTax) so recalcOk can pass.
function mergedOrder(totalWithTax, subTotalWithTax, shippingWithTax) {
  totalWithTax = totalWithTax !== undefined ? totalWithTax : 5600;
  subTotalWithTax = subTotalWithTax !== undefined ? subTotalWithTax : 4900;
  shippingWithTax = shippingWithTax !== undefined ? shippingWithTax : 700;
  return {
    id: 'ord-101', code: 'ORD-DE-101', state: 'ArrangingPayment', totalQuantity: 3,
    subTotal: 4200, subTotalWithTax: subTotalWithTax,
    shipping: 588, shippingWithTax: shippingWithTax,
    total: totalWithTax, totalWithTax: totalWithTax, currencyCode: 'EUR',
    taxSummary: [{ description: 'VAT DE 19%', taxRate: 19, taxTotal: 1000 }],
    shippingLines: [{ priceWithTax: 700, shippingMethod: { id: 'ship-de-1', name: 'DHL', description: 'German Post' } }],
    payments: [{ id: 'pay-1', method: 'stripe', amount: 2800, state: 'Settled' }],
    lines: [
      { id: 'l1', productVariant: { id: 'v1', name: 'Nail Set A', sku: 'SKU-NAIL-001', customFields: { weight: 250 } }, quantity: 1, unitPriceWithTax: 1400, linePriceWithTax: 1400 },
      { id: 'l2', productVariant: { id: 'v2', name: 'Nail Set B', sku: 'SKU-NAIL-002', customFields: { weight: 150 } }, quantity: 2, unitPriceWithTax: 1400, linePriceWithTax: 2800 }
    ],
    customFields: { batchExportedAt: null, isMergingWithOrderCode: null }
  };
}

function closeServer(server) {
  return new Promise(function(resolve) { server.close(resolve); });
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var base = {
    taskId: taskId,
    task: {
      canonicalId: taskId,
      mandatoryAssertions: [
        { id: 'CAN-B2-10-A01', text: 'Only paid, not-yet-exported, same-country orders merge; different-country merge is rejected; a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference; an exported order is no longer mergeable.' }
      ],
      expectedResult: 'Only paid, not-yet-exported, same-country orders merge; different-country merge is rejected; a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference; an exported order is no longer mergeable.'
    },
    shopApiBase: 'https://staging.tibella.eu',
    deps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      clock: overrides.clock || fakeClock(),
      getEnv: overrides.getEnv || envWith({}),
      config: overrides.config || {},
      allowOrderMerge: overrides.allowOrderMerge === true,
      runShippedDryRun: overrides.runShippedDryRun === true,
      shippedFixtureCodes: overrides.shippedFixtureCodes || []
    }
  };
  if (overrides.workspace) base.workspace = overrides.workspace;
  if (overrides.runEnvRecord) base.runEnvRecord = overrides.runEnvRecord;
  if (overrides.registry) base.registry = overrides.registry;
  return base;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'Only paid, not-yet-exported, same-country orders merge; different-country merge is rejected; a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference; an exported order is no longer mergeable.',
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('orderMerge: success returns READINESS_PASS with all merge assertions verified', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass-buyer' }),
    allowOrderMerge: true,
    runShippedDryRun: true,
    shippedFixtureCodes: ['ORD-DE-102'],
    runEnvRecord: { runId: 'run-b2-10-ok', stagingUrl: s.url }
  });
  ctx.deps.execFile = fakeExecFile(DRY_RUN_OUTPUT);
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never bare literal');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.primaryCountry, 'DE', 'primary merge country');
  assert.strictEqual(outcome.evidence.checks.paidOnly, true, 'only paid orders');
  assert.strictEqual(outcome.evidence.checks.sameCountryOnly, true, 'only same-country orders');
  assert.strictEqual(outcome.evidence.checks.exportedExcluded, true, 'exported order excluded');
  assert.strictEqual(outcome.evidence.checks.crossCountryRejected, true, 'different-country merge rejected');
  assert.strictEqual(outcome.evidence.checks.mergeSucceeded, true, 'permitted merge succeeded');
  assert.strictEqual(outcome.evidence.checks.recalcOk, true, 'recalculation verified');
  assert.strictEqual(outcome.evidence.checks.recalcWeight, true, 'weight recalculated');
  assert.strictEqual(outcome.evidence.checks.recalcShippingCompany, true, 'shipping company recalculated');
  assert.strictEqual(outcome.evidence.checks.recalcShipping, true, 'shipping price recalculated');
  assert.strictEqual(outcome.evidence.checks.recalcTax, true, 'tax recalculated');
  assert.strictEqual(outcome.evidence.checks.recalcTotal, true, 'total recalculated');
  assert.strictEqual(outcome.evidence.checks.recalcPaymentDifference, true, 'payment difference recalculated');
  assert.strictEqual(outcome.evidence.checks.dryRunNoApiCall, true, 'dry-run made no API request');
  assert.strictEqual(outcome.evidence.observed.shippedDryRun.skipped, false, 'dry-run was exercised');
  assert.strictEqual(outcome.evidence.observed.recalc.weight, 550, 'weight = 250*1 + 150*2');
  assert.strictEqual(outcome.evidence.observed.recalc.shippingCompany, 'DHL', 'shipping company from shippingLines');
  assert.strictEqual(outcome.evidence.observed.recalc.paymentDifference, 2800, '5600 - 2800 paid');
  assert.ok(outcome.evidence.assertionReport.length === 1, 'one assertion (A01)');
  assert.strictEqual(outcome.evidence.assertionReport[0].id, 'CAN-B2-10-A01', 'A01');
  var json = JSON.stringify(outcome.evidence.rawRequests || {});
  assert.strictEqual(json.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(json.indexOf('test-pass-buyer'), -1, 'password redacted');
});

test('orderMerge: cross-country leak in the mergeable list is an APPLICATION_DEFECT', async function() {
  var s = await startServer('cross-country-leak');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowOrderMerge: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('different-country') !== -1, 'error names the cross-country leak');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-10');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('orderMerge: an unpaid order in the mergeable list is an APPLICATION_DEFECT', async function() {
  var s = await startServer('unpaid-mergeable');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowOrderMerge: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('unpaid') !== -1, 'error names the unpaid order');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-10');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('orderMerge: exported order still mergeable is an APPLICATION_DEFECT', async function() {
  var s = await startServer('exported-leak');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowOrderMerge: true,
    runShippedDryRun: true,
    shippedFixtureCodes: ['ORD-DE-101']
  });
  ctx.deps.execFile = fakeExecFile(DRY_RUN_OUTPUT.replace('ORD-DE-102', 'ORD-DE-101'));
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('exported') !== -1 || outcome.error.indexOf('shipped') !== -1, 'error names the exported leak');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-10');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('orderMerge: inconsistent recalculated totals are an APPLICATION_DEFECT', async function() {
  var s = await startServer('recalc-wrong');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowOrderMerge: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('recalc') !== -1 || outcome.error.indexOf('merge') !== -1, 'error names the recalculation mismatch');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-10');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('orderMerge: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-10');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('orderMerge: missing buyer password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({}),
    allowOrderMerge: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var evidenceJson = JSON.stringify(outcome.evidence || {});
  assert.ok(evidenceJson.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the missing env var');
  assert.strictEqual(evidenceJson.indexOf('test-pass-buyer'), -1, 'password value not leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-10');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('orderMerge: without mutation approval the merge assertions are unverified (readiness-subset)', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowOrderMerge: false
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'read-only readiness run succeeds');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.evidence.checks.mergeAllowed, false, 'mutation not approved');
  assert.strictEqual(outcome.evidence.checks.mergeSucceeded, false, 'no merge attempted');
  assert.strictEqual(outcome.evidence.checks.recalcOk, false, 'recalculation not exercised');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('not approved') !== -1, 'unverified reason names approval');
});

test('orderMerge: no mergeable order is partial coverage (readiness-subset, no defect)', async function() {
  var s = await startServer('no-mergeable');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowOrderMerge: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'no mergeable order is not a defect on its own');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.evidence.observed.mergeableList.length, 0, 'no orders returned');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('no mergeable order') !== -1, 'unverified reason names missing order');
});

test('orderMerge: register() registers CAN-B2-10 with readiness-subset coverage', function() {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-10'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-10');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-10-A01']);
  executorModule.resetTaskExecutors();
});

test('orderMerge: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b2-10-'));
  var runId = 'run-b2-10-' + Date.now().toString(36) + '-x1y';
  var workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b2-10-'));
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-10', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url },
    allowOrderMerge: true,
    runShippedDryRun: true,
    shippedFixtureCodes: ['ORD-DE-102'],
    workspace: { workspaceId: 'ws-b2-10', workspacePath: workspacePath, runId: runId, exists: true }
  });
  ctx.deps.execFile = fakeExecFile(DRY_RUN_OUTPUT);
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerOrderMerge(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-10');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'merge-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector_verify(runId, evidenceRoot);
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

function evidenceCollector_verify(runId, evidenceRoot) {
  var evidenceCollector = require('../src/evidenceCollector');
  return evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
}
