'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var executors = require('../src/executors/shippingWeight');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

// Query markers (substring search in the query body).
var LOGIN_MARKER = 'Login';
var ELIGIBLE_MARKER = 'eligibleShippingMethods';
var SET_ADDR_MARKER = 'SetOrderShippingAddress';
var ADD_TO_ORDER_MARKER = 'addItemToOrder';
var SET_METHOD_MARKER = 'SetOrderShippingMethod';
var ORDER_DETAIL_MARKER = 'GetShippingWeightOrderDetail';

var fixtures = require('../manifest/fixtures.v1.json');
var carriers = fixtures.carriers;
var taxRates = fixtures.taxRates.rates || {};
var CURRENCY = { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' };

function countryForToken(token) {
  var map = { 'de-token': 'DE', 'at-token': 'AT', 'hu-token': 'HU', 'gb-token': 'GB' };
  return map[token] || 'DE';
}

function bandCents(country, weightKg) {
  var entry = carriers.byCountry[country];
  var kg = Number(weightKg);
  for (var i = 0; i < entry.bands.length; i++) {
    var band = entry.bands[i];
    var from = Number(band.from);
    if (kg < from) continue;
    if (band.to === null || kg < Number(band.to)) {
      return Math.round((Number(band.price) + Number.EPSILON) * 100);
    }
  }
  return null;
}

// The fake server renders an order whose lines carry the fixture set weight
// (350g = base 250g + 10 nails * 10g) and a shipping total computed from the
// same fixture bands, so a correct run observes exactly the fixture expectation.
function renderOrder(country, items, paid, opts) {
  opts = opts || {};
  var lines = [];
  var totalQty = 0;
  var totalGrams = 0;
  var subTotalWithTax = 0;
  var keys = Object.keys(items);
  for (var i = 0; i < keys.length; i++) {
    var vid = keys[i];
    var qty = Number(items[vid]) || 0;
    if (qty <= 0) continue;
    var weight = 350;
    totalQty += qty;
    totalGrams += weight * qty;
    subTotalWithTax += 2500 * qty;
    lines.push({
      id: 'l-' + vid,
      productVariant: {
        id: vid,
        name: 'Nail Set ' + country,
        sku: 'SKU-' + country + '-001',
        customFields: { weight: weight },
        stockLevel: 100 - totalQty,
        stockMovements: [{ type: 'Sale', quantity: -qty }]
      },
      quantity: qty,
      unitPriceWithTax: 2500,
      linePriceWithTax: 2500 * qty
    });
  }
  var weightKg = totalGrams / 1000;
  var shippingCents = bandCents(country, weightKg);
  var methodName = carriers.byCountry[country].name;
  var totalWithTax = subTotalWithTax + shippingCents;
  var taxRate = taxRates[country] || 19;
  var taxTotal = Math.round((subTotalWithTax + shippingCents) * taxRate / (100 + taxRate));
  var isMerged = !!opts.merged;
  var order = {
    id: 'ord-' + country.toLowerCase(),
    code: opts.code || ('ORD-' + country.toUpperCase() + '-CART'),
    state: 'ArrangingPayment',
    totalQuantity: totalQty,
    subTotal: subTotalWithTax,
    subTotalWithTax: subTotalWithTax,
    shipping: shippingCents,
    shippingWithTax: shippingCents,
    total: totalWithTax,
    totalWithTax: totalWithTax,
    currencyCode: CURRENCY[country],
    taxSummary: [{ description: 'Standard Tax', taxRate: taxRate, taxTotal: taxTotal }],
    shippingLines: [{
      priceWithTax: shippingCents,
      shippingMethod: { id: 'ship-' + country.toLowerCase(), name: methodName, description: methodName }
    }],
    payments: (paid === null || paid === undefined) ? [] : [{ id: 'pay-' + country.toLowerCase(), method: 'stripe', amount: paid, state: 'Settled', transactionId: 'pi_fake_' + country.toLowerCase() }],
    lines: lines,
    customFields: { batchExportedAt: isMerged ? '2026-10-01T00:00:00.000Z' : null, isMergingWithOrderCode: isMerged ? 'ORD-DE-BASE' : null }
  };
  if (opts.messShipping) {
    order.shippingWithTax += opts.messShipping;
    order.totalWithTax += opts.messShipping;
    order.shippingLines[0].priceWithTax += opts.messShipping;
  }
  if (opts.messCurrency) {
    order.currencyCode = opts.messCurrency;
  }
  return order;
}

function renderMergedOrder(country, opts) {
  // A merged order with 20 sets of 10 nails: 7000g -> the open-ended band (6.99).
  var paid = 12500; // partial payment, so the merged order needs extra payment.
  return renderOrder(country, { 'variant-de': 20 }, paid, { code: 'ORD-DE-MERGED', merged: true, messShipping: opts && opts.messShipping, messCurrency: opts && opts.messCurrency });
}

var ORDER_DETAIL_MARKERS = [ORDER_DETAIL_MARKER];

/**
 * Fake staging Shop API. Stateful per vendure-token channel: each country has
 * its own cart so all four per-country pricing stages can run in one pass.
 * The `scenario` selects business-data problems:
 *  - 'ok'            consistent fixture expectations everywhere
 *  - 'wrong-price'   DE carrier + order shipping inflated by 100 minor units
 *  - 'wrong-currency' DE order shipped in GBP instead of EUR
 *  - '500'           every request returns HTTP 500 (service down)
 */
function startServer(scenario) {
  return new Promise(function(resolve, reject) {
    var carts = {}; // token -> { items: {variantId: qty}, paid: null }
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
        var token = req.headers['vendure-token'] || 'de-token';
        var cc = countryForToken(token);
        if (!carts[token]) carts[token] = { items: {}, paid: null };
        var cart = carts[token];

        function send(obj, status, extraHeaders) {
          var hdrs = { 'content-type': 'application/json' };
          if (extraHeaders) Object.keys(extraHeaders).forEach(function(k) { hdrs[k] = extraHeaders[k]; });
          res.writeHead(status || 200, hdrs);
          res.end(JSON.stringify(obj));
        }
        function setCookie() {
          return { 'set-cookie': 'shopsession=' + cc + '_' + token };
        }

        if (scenario === '500') {
          send({ errors: [{ message: 'boom' }] }, 500);
          return;
        }

        if (query.indexOf(LOGIN_MARKER) !== -1) {
          send({ data: { login: { __typename: 'CurrentUser', id: 'user-1', identifier: variables.username } } }, 200, setCookie());
          return;
        }

        if (query.indexOf(ELIGIBLE_MARKER) !== -1) {
          var expectedName = carriers.byCountry[cc].name;
          var price = bandCents(cc, cartWeightKg(cart));
          if (scenario === 'wrong-price' && cc === 'DE') price += 100;
          var methods = [
            { id: 'ship-' + cc.toLowerCase(), name: expectedName, code: 'carrier-' + cc.toLowerCase(), description: expectedName, priceWithTax: price }
          ];
          send({ data: { eligibleShippingMethods: methods } }, 200, setCookie());
          return;
        }

        if (query.indexOf(SET_ADDR_MARKER) !== -1) {
          send({ data: { setOrderShippingAddress: { __typename: 'Order', id: 'ord-' + cc.toLowerCase(), code: 'ORD-' + cc.toUpperCase() + '-CART', shippingAddress: { countryCode: cc } } } }, 200, setCookie());
          return;
        }

        if (query.indexOf(ADD_TO_ORDER_MARKER) !== -1) {
          // Replacement semantics: the quantity of the given variant is set
          // (this is what lets the weight-change stage push the band).
          var vid = variables.variantId || 'variant-de';
          cart.items[vid] = Number(variables.quantity) || 1;
          // Seed DE with a settled payment equal to the original (pre-change)
          // total the first time it grows, so the weight-change extra payment
          // is a real positive difference.
          var orderNow = renderOrder(cc, cart.items, cart.paid, scenario === 'wrong-currency' && cc === 'DE' ? { messCurrency: 'GBP' } : null);
          send({ data: { addItemToOrder: { __typename: 'Order', id: orderNow.id, code: orderNow.code, totalQuantity: orderNow.totalQuantity, currencyCode: orderNow.currencyCode, lines: orderNow.lines.map(function(l) { return { id: l.id, productVariant: { id: l.productVariant.id, name: l.productVariant.name }, quantity: l.quantity }; }) } } }, 200, setCookie());
          return;
        }

        if (query.indexOf(SET_METHOD_MARKER) !== -1) {
          var firstShipId = (variables.shippingMethodId && variables.shippingMethodId[0]) || 'ship-' + cc.toLowerCase();
          // Seed the settled payment at the pre-change total for DE.
          if (cc === 'DE' && cart.paid === null) {
            cart.paid = renderOrder(cc, cart.items, null, null).totalWithTax;
          }
          var orderAfterMethod = renderOrder(cc, cart.items, cart.paid, (scenario === 'wrong-price' && cc === 'DE') ? { messShipping: 100 } : ((scenario === 'wrong-currency' && cc === 'DE') ? { messCurrency: 'GBP' } : null));
          send({ data: { setOrderShippingMethod: { __typename: 'Order', id: orderAfterMethod.id, code: orderAfterMethod.code, shippingWithTax: orderAfterMethod.shippingWithTax, totalWithTax: orderAfterMethod.totalWithTax, shippingLines: orderAfterMethod.shippingLines } } }, 200, setCookie());
          return;
        }

        if (query.indexOf(ORDER_DETAIL_MARKER) !== -1) {
          var code = variables.code || ('ORD-' + cc.toUpperCase() + '-CART');
          var detail;
          if (code === 'ORD-DE-MERGED') {
            detail = renderMergedOrder('DE', (scenario === 'wrong-price') ? { messShipping: 100 } : null);
          } else {
            var messFor = (scenario === 'wrong-price' && cc === 'DE') ? { messShipping: 100 } : ((scenario === 'wrong-currency' && cc === 'DE') ? { messCurrency: 'GBP' } : null);
            detail = renderOrder(cc, cart.items, cc === 'DE' ? cart.paid : null, messFor);
          }
          send({ data: { orderByCode: detail } }, 200, setCookie());
          return;
        }

        send({ data: {} }, 200, setCookie());
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function cartWeightKg(cart) {
  var totalGrams = 0;
  Object.keys(cart.items).forEach(function(vid) {
    totalGrams += 350 * (Number(cart.items[vid]) || 0);
  });
  return totalGrams / 1000;
}

function closeServer(server) {
  return new Promise(function(resolve) { server.close(resolve); });
}

function fakeClock() {
  return function() { return new Date('2026-10-09T10:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var base = {
    taskId: taskId,
    task: {
      canonicalId: taskId,
      mandatoryAssertions: [
        { id: 'CAN-B2-13-A01', text: 'Per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier; merges and weight changes trigger recalculation and any extra payment; order, shipping record, receipt and inventory operation agree.' }
      ],
      expectedResult: 'Per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier; merges and weight changes trigger recalculation and any extra payment; order, shipping record, receipt and inventory operation agree.'
    },
    shopApiBase: 'https://staging.tibella.eu',
    deps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      clock: overrides.clock || fakeClock(),
      getEnv: overrides.getEnv || envWith({}),
      config: overrides.config || {},
      allowShippingMutation: overrides.allowShippingMutation === true,
      allowStripeProbe: overrides.allowStripeProbe === true
    }
  };
  if (overrides.fixtures) base.fixtures = overrides.fixtures;
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
    expected: 'Per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier; merges and weight changes trigger recalculation and any extra payment; order, shipping record, receipt and inventory operation agree.',
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('shippingWeight: success returns READINESS_PASS with all assertions verified', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass-buyer' }),
    allowShippingMutation: true,
    runEnvRecord: { runId: 'run-b2-13-ok', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never bare literal');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.allowShippingMutation, true, 'mutation approved');
  assert.strictEqual(outcome.evidence.checks.fixtureOk, true, 'carriers fixture loaded');
  assert.strictEqual(outcome.evidence.observed.carrierConfig.weightBands.join(','), '0,3,7', 'fixture weight bands');
  assert.strictEqual(outcome.evidence.checks.mergeRecalcOk, true, 'merged order recalculation consistent');
  assert.strictEqual(outcome.evidence.checks.mergeExtraPayment, true, 'merged order extra payment positive');
  assert.strictEqual(outcome.evidence.checks.weightChangeOk, true, 'weight change triggers recalculation');
  assert.strictEqual(outcome.evidence.checks.extraPaymentOk, true, 'weight change extra payment positive');
  // Every country was fully verified (pricing + carrier + currency + agreement + inventory).
  ['DE', 'AT', 'HU', 'GB'].forEach(function(c) {
    var chk = outcome.evidence.checks.countries[c];
    assert.strictEqual(chk.carrier, true, c + ' carrier present');
    assert.strictEqual(chk.pricing, true, c + ' price matches fixture band');
    assert.strictEqual(chk.currency, true, c + ' currency matches');
    assert.strictEqual(chk.agreement, true, c + ' order/shipping/receipt agree');
    assert.strictEqual(chk.inventory, true, c + ' inventory op agrees');
  });
  // Expected per-country prices from the fixture itself.
  assert.strictEqual(outcome.evidence.observed.countries.DE.expectedCents, 349, 'DE band 0-3 => 349');
  assert.strictEqual(outcome.evidence.observed.countries.AT.expectedCents, 349, 'AT band 0-3 => 349');
  assert.strictEqual(outcome.evidence.observed.countries.HU.expectedCents, 349, 'HU band 0-3 => 349');
  assert.strictEqual(outcome.evidence.observed.countries.GB.expectedCents, 349, 'GB band 0-3 => 349');
  assert.strictEqual(outcome.evidence.observed.weightChange.bandChanged, true, 'weight crossed a band');
  assert.strictEqual(outcome.evidence.observed.weightChange.observedShippingCents, 499, 'recalculated to 4.99');
  assert.ok(outcome.evidence.observed.weightChange.extraPayment > 0, 'weight change created an extra payment obligation');
  assert.strictEqual(outcome.evidence.assertionReport.length, 1, 'one assertion (A01)');
  assert.strictEqual(outcome.evidence.assertionReport[0].id, 'CAN-B2-13-A01', 'A01');
  var json = JSON.stringify(outcome.evidence.observed || {});
  assert.strictEqual(json.indexOf('de-token') === -1, true, 'channel token redacted');
  assert.strictEqual(json.indexOf('test-pass-buyer') === -1, true, 'password redacted');
});

test('shippingWeight: a wrong shipping price is an APPLICATION_DEFECT', async function() {
  var s = await startServer('wrong-price');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowShippingMutation: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('price') !== -1, 'error names the price mismatch');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-13');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('shippingWeight: a wrong currency is an APPLICATION_DEFECT', async function() {
  var s = await startServer('wrong-currency');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowShippingMutation: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('currency') !== -1, 'error names the currency mismatch');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-13');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('shippingWeight: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass-buyer' })
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-13');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('shippingWeight: missing buyer password is a CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({}),
    allowShippingMutation: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var evidenceJson = JSON.stringify(outcome.evidence || {});
  assert.ok(evidenceJson.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the missing env var');
  assert.strictEqual(evidenceJson.indexOf('test-pass-buyer'), -1, 'password value not leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-13');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('shippingWeight: without mutation approval the recalculation assertions are unverified (readiness-subset)', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    allowShippingMutation: false
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'read-only readiness run succeeds');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.evidence.checks.weightChangeOk, false, 'weight change not exercised');
  assert.strictEqual(outcome.evidence.checks.mergeRecalcOk, false, 'merge recalc not exercised');
  assert.strictEqual(outcome.evidence.checks.mergeExtraPayment, false, 'merge extra payment not exercised');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('allowShippingMutation=false') !== -1, 'unverified reason names approval');
});

test('shippingWeight: helper computations match the fixture expectations', function() {
  var c = require('../manifest/fixtures.v1.json').carriers;
  assert.strictEqual(executors.fixtureSetWeightGrams(c, 10), 350, '10-nail set weight 350g');
  assert.strictEqual(executors.bandPriceOf(c, 'DE', 0.5), 3.49, 'band 0-3 price');
  assert.strictEqual(executors.bandPriceOf(c, 'DE', 3.0), 4.99, 'band boundary 3kg -> 4.99');
  assert.strictEqual(executors.bandPriceOf(c, 'DE', 7.0), 6.99, 'open-ended band 7kg+ -> 6.99');
  assert.strictEqual(executors.expectedShippingCents(c, 'HU', 3.5), 499, '3.5kg -> 499');
  var order = renderOrder('DE', { 'variant-de': 3 }, null, null);
  assert.strictEqual(executors.orderWeightGrams(order), 1050, '3 sets * 350g');
  assert.strictEqual(executors.receiptTotalsAgree(order), true, 'total = subTotal + shipping');
  assert.strictEqual(executors.orderShippingAgreesWithRecord(order), true, 'order shipping == shippingLines');
  assert.strictEqual(executors.inventoryAgrees(order), true, 'stock movements match quantity');
  assert.strictEqual(executors.shippingCompanyOf(order), 'carrier-de', 'carrier name');
});

test('shippingWeight: register() registers CAN-B2-13 with readiness-subset coverage', function() {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-13'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-13');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-13-A01']);
  assert.strictEqual(typeof ex.handler, 'function');
  executorModule.resetTaskExecutors();
});

test('shippingWeight: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-b2-13-'));
  var runId = 'run-b2-13-' + Date.now().toString(36) + '-x9z';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass-buyer' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url },
    allowShippingMutation: true
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-13');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'shipping-price-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json', 'stripe-probe.json', 'record.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var serialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(serialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(serialized.indexOf('test-pass-buyer'), -1, 'password redacted');
  var verify = evidenceVerify(runId, evidenceRoot);
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

function evidenceVerify(runId, evidenceRoot) {
  var evidenceCollector = require('../src/evidenceCollector');
  return evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
}

// ---------------------------------------------------------------------------
// Stripe probe (bounded: exactly one minimal test-mode PaymentIntent create +
// cancel against an injected fake Stripe server; evidence records only the
// presence/test-key booleans, the HTTP statuses and livemode=false).
// ---------------------------------------------------------------------------

function startStripeFakeServer() {
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        var status = auth.indexOf('sk_test_') === 0 ? (req.url.indexOf('/cancel') !== -1 ? 200 : 200) : 401;
        var obj = { id: 'pi_fake_' + (req.url.indexOf('/cancel') !== -1 ? 'cancelled' : 'created'), object: 'payment_intent', livemode: false, amount: 100, currency: 'eur' };
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

test('shippingWeight: Stripe probe success path against fake Stripe server records status/livemode only', async function() {
  var shop = await startServer('ok');
  var stripe = await startStripeFakeServer();
  var ctx = baseContext('CAN-B2-13', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass', STRIPE_SECRET_KEY: 'sk_test_fake_1234567890abcdef' }),
    allowShippingMutation: true,
    allowStripeProbe: true,
    runEnvRecord: { runId: 'run-b2-13-stripe', stagingUrl: shop.url }
  });
  ctx.deps.stripeTestBase = stripe.url;
  ctx.deps.stripeFetch = global.fetch;
  ctx.shopApiBase = shop.url;
  var outcome = await executors.handlerShippingWeight(ctx);
  await closeServer(shop.server);
  await closeServer(stripe.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var probe = outcome.evidence.observed.stripeProbe;
  assert.ok(probe, 'stripe probe present');
  assert.strictEqual(probe.keyPresent, true, 'key present');
  assert.strictEqual(probe.keyIsTestKey, true, 'key is a test key (boolean only)');
  assert.strictEqual(probe.livemodeFalse, true, 'livemode=false recorded');
  // Exactly one create and one cancel, with HTTP statuses from the fake server. No part of the key value is recorded.
  var stripeEvidence = JSON.stringify(outcome.evidence.observed.stripeProbe || {});
  assert.strictEqual(stripeEvidence.indexOf('sk_test_'), -1, 'no part of the key value in probe evidence');
  assert.strictEqual(stripeEvidence.indexOf('1234567890abcdef'), -1, 'no key material in probe evidence');
  assert.strictEqual(probe.fakeServer, true, 'fake server used');
  assert.ok(probe.paymentIntentCreateStatus !== null, 'create status recorded');
  assert.ok(probe.paymentIntentCancelStatus !== null, 'cancel status recorded');
});

test('shippingWeight: probe without a key records the capability gap, never a value', async function() {
  var probe = await executors.runStripeProbe({
    deps: { getEnv: envWith({}) }
  });
  assert.strictEqual(probe.keyPresent, false);
  assert.strictEqual(probe.keyIsTestKey, false);
  assert.strictEqual(probe.paymentIntentCreateStatus, null);
  assert.strictEqual(probe.paymentIntentCancelStatus, null);
  var json = JSON.stringify(probe);
  assert.strictEqual(json.indexOf('sk_'), -1, 'no part of any key value recorded');
});
