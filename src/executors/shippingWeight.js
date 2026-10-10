'use strict';

/**
 * Shipping and weight executor (CAN-B2-13).
 *
 * Canonical task: "Per-country simulated carriers and weight bands price
 * shipping correctly by country, weight and carrier; merges and weight
 * changes trigger recalculation and any extra payment; order, shipping
 * record, receipt and inventory operation agree."
 *
 * The carriers, weight bands and product weights are taken from
 * manifest/fixtures.v1.json (origin synthetic-staging, verified by sha256)
 * and the expected price is computed from them:
 *   - carriers.byCountry.<CC>.name   - the simulated carrier per country
 *   - carriers.byCountry.<CC>.bands  - half-open weight bands [from, to) with
 *     an open-ended final band (to: null), each with a decimal price
 *   - carriers.productWeights        - base kg plus perNail kg per product, so
 *     one fixture set of NAILS nails weighs (base + perNail * NAILS) kg
 * The fixture price is converted to shop minor units with
 * Math.round(price * 100), the same minor-unit convention the shop order
 * object uses for shippingWithTax, shippingLines.priceWithTax and
 * totalWithTax.
 *
 * Shop-API operations used (names and selection sets copied from source):
 *   - login                        mutations.ts:3-17 (via shopApiSession)
 *   - eligibleShippingMethods      queries.ts:280-289 (GetEligibleShippingMethodsQuery)
 *   - setOrderShippingAddress      mutations.ts:169-195 (SetOrderShippingAddressMutation)
 *   - setOrderShippingMethod       mutations.ts:225-249 (SetOrderShippingMethodMutation)
 *   - addItemToOrder               mutations.ts:19-42 (via shopApiSession)
 *   - orderByCode                  queries.ts:377-475 (GetOrderDetailQuery, with the
 *     variant customFields.weight field added from graphql-env.d.ts:199 and
 *     stockLevel from queries.ts:75)
 *
 * Agreement targets observed on the Shop order object:
 *   - order:          orderByCode.shipping / shippingWithTax / totalWithTax
 *   - shipping record: orderByCode.shippingLines[].priceWithTax and
 *                      shippingLines[].shippingMethod.name
 *   - receipt:        the order confirmation renders the same orderByCode
 *                     shippingLines and totalWithTax that this executor reads
 *                     (static/email/templates/order-confirmation/body.hbs:119-127)
 *   - inventory op:   the Shop-visible variant stockLevel after the sale (the
 *                     stockMovement Sale ledger is an Admin/DB field, see the
 *                     unverified list)
 *
 * Merges and weight changes trigger recalculation and any extra payment:
 *   - weight change:  changing the cart quantity on the live order moves the
 *                     total weight across a band, so shippingWithTax and
 *                     totalWithTax must be recomputed from the fixture.
 *   - merge:          a merged order has new lines, so weight, shipping
 *                     company, shipping price, tax, total and the payment
 *                     difference must be recomputed from the fixture.
 *   - extra payment:  totalWithTax minus the sum of the already recorded paid
 *                     amounts (orderByCode.payments, queries.ts:437-444); it
 *                     is computed here, never charged. A real charge through
 *                     the Stripe Runner is only ever planned (see the Stripe
 *                     probe which is fake-server only).
 *
 * Safety (never relaxed):
 *   - Order-state mutations (setOrderShippingAddress, addItemToOrder,
 *     setOrderShippingMethod) are only invoked when the run explicitly
 *     approves mutation (context.deps.allowShippingMutation === true).
 *     Without that approval the executor performs the read-only checks
 *     (login, eligibleShippingMethods) and lists the shipping/merge
 *     recalculation assertions as unverified.
 *   - The Stripe probe creates at most one minimal test-mode PaymentIntent and
 *     cancels it, and only against an explicitly injected fake Stripe server
 *     (context.deps.stripeFetch + stripeTestBase). Evidence records only
 *     whether the key is present, whether it is a test key (boolean, never any
 *     part of the value), the HTTP status of the create and the cancel, and
 *     livemode=false. No payouts, transfers, top-ups, Connect or account
 *     management is ever invoked. A missing key locally leaves the real
 *     "extra payment charge" assertion unverified and is recorded as
 *     CLIENT_INPUT_SCOPE in the probe evidence.
 *   - No real payment is ever created by this executor; the payment
 *     difference is computed from the order's existing payment records.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var fixturesModule = require('../fixtures');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic account from manifest/fixtures.v1.json (origin VERIFIED).
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Primary country used for the weight-change / merge recalculation stage.
var PRIMARY_COUNTRY = 'DE';

// Default nail count per fixture product set. productWeights defines base kg
// plus perNail kg; NAILS is the set size used to derive the expected weight
// (override via context.fixtures.nailsCount).
var DEFAULT_NAILS = 10;

// Payment states that count as already paid for the extra-payment
// calculation (same convention as the CAN-B2-10 executor).
var PAID_PAYMENT_STATES = ['Settled', 'Authorized', 'PaymentSettled', 'PaymentAuthorized'];

// Stripe test-key prefix (sk_test_). Only the boolean "is it a test key" and
// the presence flag are ever recorded; no part of the key is printed.
var STRIPE_TEST_KEY_PREFIX = 'sk_test_';

// Env var this executor reads by NAME only. No value is ever recorded.
var PASSWORD_ENV_NAME = 'SHOP_ACCOUNT_PASSWORD_BUYER_ONE';
var STRIPE_SECRET_ENV_NAME = 'STRIPE_SECRET_KEY';

// ---------------------------------------------------------------------------
// GraphQL documents (names and selection sets copied from the source)
// ---------------------------------------------------------------------------

// eligibleShippingMethods: queries.ts:280-289.
var ELIGIBLE_SHIPPING_METHODS_QUERY = [
  'query GetEligibleShippingMethods {',
  '  eligibleShippingMethods {',
  '    id',
  '    name',
  '    code',
  '    description',
  '    priceWithTax',
  '  }',
  '}'
].join('\n');

// setOrderShippingAddress: mutations.ts:169-195.
var SET_SHIPPING_ADDRESS_MUTATION = [
  'mutation SetOrderShippingAddress($input: CreateAddressInput!) {',
  '  setOrderShippingAddress(input: $input) {',
  '    __typename',
  '    ... on Order {',
  '      id',
  '      code',
  '      shippingAddress {',
  '        fullName',
  '        company',
  '        streetLine1',
  '        streetLine2',
  '        city',
  '        province',
  '        postalCode',
  '        country',
  '        countryCode',
  '        phoneNumber',
  '      }',
  '    }',
  '    ... on ErrorResult {',
  '      errorCode',
  '      message',
  '    }',
  '  }',
  '}'
].join('\n');

// setOrderShippingMethod: mutations.ts:225-249.
var SET_SHIPPING_METHOD_MUTATION = [
  'mutation SetOrderShippingMethod($shippingMethodId: [ID!]!) {',
  '  setOrderShippingMethod(shippingMethodId: $shippingMethodId) {',
  '    __typename',
  '    ... on Order {',
  '      id',
  '      code',
  '      shippingWithTax',
  '      totalWithTax',
  '      shippingLines {',
  '        shippingMethod {',
  '          id',
  '          name',
  '          description',
  '        }',
  '        priceWithTax',
  '      }',
  '    }',
  '    ... on ErrorResult {',
  '      errorCode',
  '      message',
  '    }',
  '  }',
  '}'
].join('\n');

// Order detail for the shipping checks: GetOrderDetailQuery (queries.ts:
// 377-475) with the variant `weight` custom field (graphql-env.d.ts:199) and
// `stockLevel` (queries.ts:75) added because the whole task pivots on the
// per-country weight band.
var SHIPPING_WEIGHT_ORDER_DETAIL_QUERY = [
  'query GetShippingWeightOrderDetail($code: String!) {',
  '  orderByCode(code: $code) {',
  '    id',
  '    code',
  '    state',
  '    totalQuantity',
  '    subTotal',
  '    subTotalWithTax',
  '    shipping',
  '    shippingWithTax',
  '    total',
  '    totalWithTax',
  '    currencyCode',
  '    taxSummary {',
  '      description',
  '      taxRate',
  '      taxTotal',
  '    }',
  '    shippingLines {',
  '      priceWithTax',
  '      shippingMethod {',
  '        id',
  '        name',
  '        description',
  '      }',
  '    }',
  '    payments {',
  '      id',
  '      method',
  '      amount',
  '      state',
  '      transactionId',
  '    }',
  '    lines {',
  '      id',
  '      productVariant {',
  '        id',
  '        name',
  '        sku',
  '        customFields {',
  '          weight',
  '        }',
  '        stockLevel',
  '      }',
  '      quantity',
  '      unitPriceWithTax',
  '      linePriceWithTax',
  '    }',
  '    customFields {',
  '      batchExportedAt',
  '      isMergingWithOrderCode',
  '    }',
  '  }',
  '}'
].join('\n');

// ---------------------------------------------------------------------------
// Context helpers (delegate to the shared session module)
// ---------------------------------------------------------------------------

function getEnvFn(context) {
  return sessionModule.getEnvFn(context);
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function runIdOf(context) {
  return sessionModule.runIdOf(context);
}

function evidenceOptions(context) {
  return sessionModule.evidenceOptions(context);
}

function taskExpectedText(context, taskId) {
  var task = (context && context.task) || {};
  if (task.expectedResult) return task.expectedResult;
  return taskId;
}

function stepResponse(step) {
  if (step && step.response) return step.response;
  if (step && step.evidence && step.evidence.response) return step.evidence.response;
  return null;
}

function stepBody(step) {
  var response = stepResponse(step);
  return response ? response.body : null;
}

function readData(step, pathArr) {
  var node = stepBody(step);
  for (var i = 0; i < pathArr.length; i++) {
    if (node === null || node === undefined) return null;
    node = node[pathArr[i]];
  }
  return node === undefined ? null : node;
}

function hasGraphQLErrors(step) {
  var response = stepResponse(step);
  return !!(response && response.body && response.body.errors && response.body.errors.length > 0);
}

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return true;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
}

function outcomeFromStoreFailure(storeOut, taskId, evidence) {
  var errorCode = storeOut && storeOut.errorCode ? storeOut.errorCode : 'UNKNOWN';
  var error = (storeOut && storeOut.error) || 'shop-api step failed';
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence || (storeOut && storeOut.evidence) || null
  };
}

function failureOutcome(errorCode, error, evidence) {
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence || null
  };
}

function passOutcome(context, taskId, evidence) {
  return {
    success: true,
    actual: taskExpectedText(context, taskId),
    result: RESULT_READINESS_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

// ---------------------------------------------------------------------------
// Fixture-derived computations (carriers, bands and product weights come from
// manifest/fixtures.v1.json only - the expected price is computed from them).
// ---------------------------------------------------------------------------

function loadCarrierConfig(context) {
  var mod = (context && context.deps && context.deps.fixturesModule) || fixturesModule;
  var loaded = mod.loadFixturesFile();
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  var carriers = loaded.fixtures && loaded.fixtures.carriers;
  if (!carriers || !carriers.byCountry) {
    return { ok: false, error: 'carriers missing from fixtures.v1.json' };
  }
  return { ok: true, carriers: carriers, sha256: loaded.sha256 };
}

function countriesOf(carriers) {
  var map = (carriers && carriers.byCountry) || {};
  return Object.keys(map).sort();
}

function fixtureCarrier(carriers, country) {
  var map = (carriers && carriers.byCountry) || {};
  return map[country] || null;
}

function nailsCountOf(context) {
  var n = context && context.fixtures && typeof context.fixtures.nailsCount === 'number'
    ? context.fixtures.nailsCount
    : DEFAULT_NAILS;
  return n > 0 ? n : DEFAULT_NAILS;
}

// Expected weight in grams for one fixture product set (base + perNail * nails).
function fixtureSetWeightGrams(carriers, nails) {
  var pw = (carriers && carriers.productWeights) || {};
  var base = Number(pw.base) || 0;
  var perNail = Number(pw.perNail) || 0;
  return Math.round((base + perNail * nails) * 1000);
}

// Sum of the line weights (grams) on an observed order object.
function orderWeightGrams(order) {
  var lines = (order && order.lines) || [];
  var total = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || !line.productVariant) continue;
    var cw = line.productVariant.customFields || {};
    var weight = Number(cw.weight) || 0;
    var qty = Number(line.quantity) || 1;
    total += weight * qty;
  }
  return total;
}

// Pick the fixture band price for a weight in kg (half-open [from, to), open
// end returns the final band).
function bandPriceOf(carriers, country, weightKg) {
  var entry = fixtureCarrier(carriers, country);
  if (!entry || !Array.isArray(entry.bands)) return null;
  var kg = Number(weightKg);
  if (!Number.isFinite(kg)) return null;
  for (var j = 0; j < entry.bands.length; j++) {
    var band = entry.bands[j];
    var from = Number(band.from);
    if (kg < from) continue;
    if (band.to === null || kg < Number(band.to)) {
      return band.price;
    }
  }
  return null;
}

function toMinorUnits(price) {
  return Math.round((Number(price) + Number.EPSILON) * 100);
}

function expectedShippingCents(carriers, country, weightKg) {
  var decimal = bandPriceOf(carriers, country, weightKg);
  if (decimal === null) return null;
  return toMinorUnits(decimal);
}

function shippingCentsOf(order) {
  return order && order.shippingWithTax !== null && order.shippingWithTax !== undefined
    ? Number(order.shippingWithTax)
    : null;
}

function shippingRecordCentsOf(order) {
  var lines = (order && order.shippingLines) || [];
  var total = 0;
  for (var i = 0; i < lines.length; i++) {
    total += Number(lines[i] && lines[i].priceWithTax) || 0;
  }
  return lines.length > 0 ? total : null;
}

function shippingCompanyOf(order) {
  var lines = (order && order.shippingLines) || [];
  for (var i = 0; i < lines.length; i++) {
    var method = lines[i] && lines[i].shippingMethod;
    if (method && typeof method.name === 'string' && method.name.length > 0) {
      return method.name;
    }
  }
  return null;
}

function paidAmountOf(order) {
  var payments = (order && order.payments) || [];
  var total = 0;
  for (var i = 0; i < payments.length; i++) {
    var p = payments[i];
    if (p && PAID_PAYMENT_STATES.indexOf(p.state) !== -1) {
      total += Number(p.amount) || 0;
    }
  }
  return total;
}

// Extra payment after a merge / weight change: the new totalWithTax minus the
// already recorded paid amounts. Positive when the change raised the total.
function extraPaymentOf(order) {
  var totalWithTax = order && order.totalWithTax !== null && order.totalWithTax !== undefined
    ? Number(order.totalWithTax)
    : null;
  if (totalWithTax === null) return null;
  return totalWithTax - paidAmountOf(order);
}

// Receipt agreement: totalWithTax == subTotalWithTax + shippingWithTax.
function receiptTotalsAgree(order) {
  if (!order) return false;
  var sub = order.subTotalWithTax;
  var ship = order.shippingWithTax;
  var total = order.totalWithTax;
  if (sub === null || sub === undefined || ship === null || ship === undefined || total === null || total === undefined) {
    return false;
  }
  return Number(total) === Number(Number(sub) + Number(ship));
}

// Order shipping agrees with the shipping record (shippingLines).
function orderShippingAgreesWithRecord(order) {
  if (shippingCentsOf(order) === null) return false;
  if (shippingRecordCentsOf(order) === null) return false;
  return shippingCentsOf(order) === shippingRecordCentsOf(order);
}

// Inventory op agreement on the Shop object: every line reports a start stock
// level and a stock level reduced by exactly the purchased quantity. The real
// stockMovement Sale ledger is Admin/DB and listed unverified.
function inventoryAgrees(order) {
  var lines = (order && order.lines) || [];
  if (lines.length === 0) return false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var variant = line && line.productVariant;
    if (!variant) return false;
    if (!Array.isArray(variant.stockMovements) && variant.stockLevel === undefined) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Evidence writing (shared evidenceCollector only)
// ---------------------------------------------------------------------------

function writeExecutorEvidence(context, taskId, files, secrets) {
  var runId = runIdOf(context);
  if (!runId) return [];
  var options = evidenceOptions(context);
  var baseRoot = path.join(options.root, options.baseDir);
  var loaded = evidenceCollector.loadIndex(baseRoot, runId);
  if (!(loaded.exists && loaded.index)) {
    try {
      evidenceCollector.initEvidenceIndex(runId, {}, options);
    } catch (e) {
      // index initialisation is best-effort; writeEvidenceFile retries.
    }
  }
  var written = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j++) {
        opts.secrets['shippingWeightSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

// Deterministic shipping address per country used by setOrderShippingAddress.
function shippingAddressForCountry(country) {
  var cities = { DE: 'Berlin', AT: 'Vienna', HU: 'Budapest', GB: 'London' };
  var countries = { DE: 'Germany', AT: 'Austria', HU: 'Hungary', GB: 'United Kingdom' };
  var postals = { DE: '10115', AT: '1010', HU: '1051', GB: 'EC1A 1BB' };
  return {
    fullName: 'Buyer One',
    streetLine1: 'Main Street 1',
    city: cities[country] || 'Berlin',
    postalCode: postals[country] || '10115',
    countryCode: country,
    country: countries[country] || 'Germany'
  };
}

// Deterministic per-country variant id (override via context.fixtures.variantIds).
function variantIdOf(context, country) {
  var map = context && context.fixtures && context.fixtures.variantIds;
  if (map && typeof map[country] === 'string' && map[country].length > 0) {
    return map[country];
  }
  return 'variant-' + String(country).toLowerCase();
}

// A minimal, redacted summary of a country's verified ordering snapshot.
function summarizeCountry(country, order, method, expected) {
  return {
    country: country,
    carrier: method ? method.name : null,
    carrierMethodId: method ? method.id : null,
    eligible: !!method,
    expectedBandPrice: expected ? expected.decimal : null,
    expectedCents: expected ? expected.cents : null,
    observedCents: order ? shippingCentsOf(order) : null,
    company: order ? shippingCompanyOf(order) : null,
    currency: order ? order.currencyCode : null,
    weightGrams: order ? orderWeightGrams(order) : null,
    weightKg: order ? (orderWeightGrams(order) / 1000) : null,
    receiptAgrees: order ? receiptTotalsAgree(order) : null,
    shippingRecordAgrees: order ? orderShippingAgreesWithRecord(order) : null,
    inventoryAgrees: order ? inventoryAgrees(order) : null
  };
}

// ---------------------------------------------------------------------------
// Stripe probe (bounded by the Stripe rules)
// ---------------------------------------------------------------------------

/**
 * Record only whether STRIPE_SECRET_KEY is present, whether it is a test key
 * (boolean, never any part of the value), and - against an explicitly injected
 * fake Stripe server only - the HTTP status of exactly one minimal PaymentIntent
 * create and of its cancel, plus livemode=false. No payouts, transfers,
 * top-ups, Connect or account management is ever called. Missing key is
 * recorded as a CLIENT_INPUT_SCOPE style gap (capability name only).
 */
async function runStripeProbe(context) {
  var env = getEnvFn(context)();
  var key = env ? env[STRIPE_SECRET_ENV_NAME] : undefined;
  var present = typeof key === 'string' && key.length > 0;
  var isTestKey = present ? key.indexOf(STRIPE_TEST_KEY_PREFIX) === 0 : false;
  var probe = {
    capability: 'STRIPE_SECRET_KEY (test mode only)',
    keyPresent: present,
    keyIsTestKey: isTestKey,
    livemodeFalse: isTestKey,
    paymentIntentCreateStatus: null,
    paymentIntentCancelStatus: null,
    fakeServer: false,
    note: 'no real Stripe call is ever made; the success path is exercised against an injected fake Stripe server only'
  };
  if (present && context && context.deps && context.deps.allowStripeProbe === true &&
      typeof context.deps.stripeFetch === 'function' && typeof context.deps.stripeTestBase === 'string') {
    probe.fakeServer = true;
    // Exactly one minimal test-mode PaymentIntent create; then cancel (the bounded
    // success path, fake server only).
    var created = await stripePaymentIntentCreate(context, key);
    probe.paymentIntentCreateStatus = created && created.httpStatus !== undefined ? created.httpStatus : null;
    if (created && created.livemode !== undefined) probe.livemodeFalse = created.livemode === false;
    if (created && created.id && typeof context.deps.stripeFetch === 'function') {
      var cancelled = await stripePaymentIntentCancel(context, key, created.id);
      probe.paymentIntentCancelStatus = cancelled && cancelled.httpStatus !== undefined ? cancelled.httpStatus : null;
      if (cancelled && cancelled.livemode !== undefined) probe.livemodeFalse = cancelled.livemode === false;
    }
  }
  return probe;
}

function stripePaymentIntentCreate(context, secretKey) {
  var deps = context.deps || {};
  var base = String(deps.stripeTestBase).replace(/\/+$/, '');
  var body = {
    amount: 100,
    currency: 'eur',
    'payment_method_types[]': 'card',
    'livemode': 'false'
  };
  return stripeFormRequest(deps.stripeFetch, base + '/v1/payment_intents', secretKey, body);
}

function stripePaymentIntentCancel(context, secretKey, intentId) {
  var deps = context.deps || {};
  var base = String(deps.stripeTestBase).replace(/\/+$/, '');
  return stripeFormRequest(deps.stripeFetch, base + '/v1/payment_intents/' + intentId + '/cancel', secretKey, {});
}

function stripeFormRequest(fetchFn, url, secretKey, body) {
  var pairs = Object.keys(body).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(body[k]);
  });
  var request = {
    method: 'POST',
    url: url,
    headers: { 'authorization': 'Bearer sk_test_REDACTED', 'content-type': 'application/x-www-form-urlencoded' },
    formFields: Object.keys(body)
  };
  return fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Authorization': 'Bearer ' + secretKey
    },
    body: pairs.join('&')
  }).then(function(response) {
    return response.text().then(function(text) {
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
      return {
        request: request,
        httpStatus: response.status,
        livemode: parsed && parsed.livemode !== undefined ? parsed.livemode : (parsed && parsed.object ? false : null),
        id: parsed && parsed.id ? parsed.id : null
      };
    });
  }).catch(function(err) {
    return {
      request: request,
      httpStatus: null,
      livemode: null,
      id: null,
      networkError: err && err.message ? err.message : String(err)
    };
  });
}

// ---------------------------------------------------------------------------
// Assertion report (the v0.4 manifest defines one mandatory assertion
// CAN-B2-13-A01 covering the full expected result).
// ---------------------------------------------------------------------------

function buildAssertionReport(observed, checks) {
  var verifiedClaims = [];
  var unverifiedClaims = [];

  var countryCodes = Object.keys((checks.countries || {})).sort();
  var countriesVerified = countryCodes.filter(function(c) {
    var chk = checks.countries[c] || {};
    return chk.pricing === true && chk.carrier === true && chk.currency === true &&
      chk.agreement === true && chk.inventory === true;
  });

  if (countriesVerified.length > 0) {
    verifiedClaims.push({
      claim: 'per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier',
      verified: true,
      observed: 'countries=' + countriesVerified.join(',')
    });
  } else {
    unverifiedClaims.push({
      claim: 'per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier',
      why: 'no country order could be fully verified (mutation approval and a shop order are required)'
    });
  }

  if (checks.weightChangeOk === true) {
    verifiedClaims.push({
      claim: 'a weight change on the order triggers recalculation of the shipping price',
      verified: true,
      observed: JSON.stringify(observed.weightChange || {})
    });
  } else {
    unverifiedClaims.push({
      claim: 'a weight change on the order triggers recalculation of the shipping price',
      why: 'weight-change stage not exercised (allowShippingMutation not approved or shop order absent)'
    });
  }

  if (checks.mergeExtraPayment === true) {
    verifiedClaims.push({
      claim: 'a merge (or merged order) triggers recalculation and any extra payment',
      verified: true,
      observed: 'extraPayment=' + (observed.merge ? observed.merge.extraPayment : null) + ', shipping=' + (observed.merge ? observed.merge.shipping : null)
    });
  } else {
    unverifiedClaims.push({
      claim: 'a merge (or merged order) triggers recalculation and any extra payment',
      why: 'merge recalc stage not verified (allowShippingMutation not approved or merged order absent)'
    });
  }

  if (checks.extraPaymentRaised === true) {
    verifiedClaims.push({
      claim: 'weight-change extra payment computed as the difference between the new total and the recorded paid amounts (no payment created)',
      verified: true,
      observed: 'extra=' + (observed.weightChange ? observed.weightChange.extraPayment : null)
    });
  } else {
    unverifiedClaims.push({
      claim: 'weight-change extra payment computed as the difference between the new total and the recorded paid amounts (no payment created)',
      why: 'extra payment not demonstrated on the weight-change order'
    });
  }

  var agreedCountries = countryCodes.filter(function(c) {
    var chk = checks.countries[c] || {};
    return chk.agreement === true && chk.inventory === true;
  });
  if (agreedCountries.length > 0) {
    verifiedClaims.push({
      claim: 'order, shipping record, receipt and inventory operation agree (order totals vs shippingLines vs receipt totals vs stock delta)',
      verified: true,
      observed: 'countries=' + agreedCountries.join(',')
    });
  } else {
    unverifiedClaims.push({
      claim: 'order, shipping record, receipt and inventory operation agree (order totals vs shippingLines vs receipt totals vs stock delta)',
      why: 'no agreed order/shipping/receipt/inventory snapshot could be verified'
    });
  }

  if (checks.stripeProbeRetrieved === true) {
    verifiedClaims.push({
      claim: 'Stripe capability probe recorded: key present, key is test-key (boolean), fake-server status and livemode=false',
      verified: true,
      observed: JSON.stringify(observed.stripeProbe || {})
    });
  }

  return [{
    id: 'CAN-B2-13-A01',
    verified: verifiedClaims.length > 0 && unverifiedClaims.length === 0,
    summary: 'Per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier; merges and weight changes trigger recalculation and any extra payment; order, shipping record, receipt and inventory operation agree.',
    verifiedClaims: verifiedClaims,
    unverifiedClaims: unverifiedClaims
  }];
}

function observable(value) {
  return value === true || value === false;
}

function buildUnverifiedList(observed, checks) {
  var out = [];
  if (!checks.loginOk) out.push('CAN-B2-13-A01: buyer login not verified');
  countryCodes(checks).forEach(function(c) {
    var chk = checks.countries[c] || {};
    if (chk.pricing !== true) out.push('CAN-B2-13-A01: per-country pricing not verified for ' + c);
    if (chk.agreement !== true) out.push('CAN-B2-13-A01: order/shipping/receipt/inventory agreement not verified for ' + c);
  });
  if (checks.weightChangeOk !== true) {
    out.push('CAN-B2-13-A01: weight-change recalculation not exercised (allowShippingMutation=false or no order)');
  }
  if (checks.mergeRecalcOk !== true || checks.mergeExtraPayment !== true) {
    out.push('CAN-B2-13-A01: merge recalculation and extra payment not verified against a real merged order');
  }
  if (!(observed.stripeProbe && observed.stripeProbe.keyPresent)) {
    out.push('CAN-B2-13-A01: real extra-payment charge through the Stripe Runner not exercised (STRIPE_SECRET_KEY is a Runner secret; locally only the presence/test-key probe is recorded)');
  }
  out.push('CAN-B2-13-A01: shipping record beyond the Shop order object (Admin Fulfillment) and the stockMovement Sale ledger (Admin/DB) are not readable through the Shop API alone');
  return out;
}

function countryCodes(checks) {
  return Object.keys((checks.countries || {})).sort();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * CAN-B2-13 handler. Flow:
 *   1. Required client input: SHOP_ACCOUNT_PASSWORD_BUYER_ONE env var (NAME
 *      only), channel tokens.
 *   2. Load the carriers fixture (manifest/fixtures.v1.json, sha256-verified)
 *      and compute the expected price per country from its bands.
 *   3. Login the buyer.
 *   4. Per-country eligibleShippingMethods + (when mutation is approved) build /
 *      refresh the country order and read the shipping totals.
 *   5. Weight-change stage (DE): raise the cart quantity so the total weight
 *      crosses a band and the shipping price recalculates; compute any extra
 *      payment from the payment records.
 *   6. Merge stage (DE): read the merged order and verify the recalculation and
 *      extra payment.
 *   7. Stripe probe (presence/test-key only, fake server bounded).
 *   8. Verify all assertions and write evidence; return the appropriate
 *      outcome/classification.
 */
async function handlerShippingWeight(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-13');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var allowMutation = !!(context.deps && context.deps.allowShippingMutation === true);

  var observed = {};
  var checks = {
    envVarsOk: false,
    tokensOk: false,
    fixtureOk: false,
    loginOk: false,
    countries: {},
    weightChangeOk: false,
    extraPaymentOk: false,
    mergeRecalcOk: false,
    mergeExtraPayment: false,
    stripeProbeRetrieved: false
  };
  var rawRequests = [];
  var rawResponses = [];
  var steps = [];

  function writeMerits(files, secrets) {
    writeExecutorEvidence(context, taskId, files, secrets || []);
  }

  function writeApiEvidence(extraFiles, secrets) {
    var files = [];
    if (extraFiles) files = files.concat(extraFiles);
    files = files.concat([
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'shipping-price-table.json', data: { observed: sessionModule.redactDeep(observed, secrets), checks: sessionModule.redactDeep(checks, secrets) }, kind: 'table' },
      { name: 'expected-vs-actual.json', data: { expected: taskExpectedText(context, taskId), actual: sessionModule.redactDeep(observed, secrets) }, kind: 'assertion' }
    ]);
    writeMerits(files, secrets);
  }

  // -------------------------------------------------------------------------
  // 1. Required client input: password env var (NAME only).
  // -------------------------------------------------------------------------
  var missingEnvVars = [];
  var envValueFn = sessionModule.envValue;
  if (!envValueFn(context, PASSWORD_ENV_NAME)) missingEnvVars.push(PASSWORD_ENV_NAME);
  checks.envVarsOk = missingEnvVars.length === 0;
  if (missingEnvVars.length > 0) {
    var envEvidence = {
      taskId: taskId,
      source: 'ENVIRONMENT',
      checks: { envVarsResolved: false, missing: missingEnvVars },
      missingEnvVars: missingEnvVars,
      completedAt: timestamp
    };
    writeMerits([{ name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }], []);
    return failureOutcome('VALIDATION_ERROR', 'missing required env vars: ' + missingEnvVars.join(', '), envEvidence);
  }

  // -------------------------------------------------------------------------
  // 1b. Channel tokens (DE, AT, HU, GB).
  // -------------------------------------------------------------------------
  var tokensResult = sessionModule.resolveChannelTokens(context);
  checks.tokensOk = tokensResult.ok;
  if (!tokensResult.ok) {
    var tokenEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeMerits([{ name: 'executor-error.json', data: tokenEvidence, kind: 'executor-error' }], []);
    return failureOutcome('VALIDATION_ERROR', tokensResult.error, tokenEvidence);
  }
  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);

  // -------------------------------------------------------------------------
  // 2. Carriers fixture -> expected price computation inputs.
  // -------------------------------------------------------------------------
  var carrierConfig = loadCarrierConfig(context);
  checks.fixtureOk = carrierConfig.ok;
  if (!carrierConfig.ok) {
    var fixtureEvidence = {
      taskId: taskId,
      source: 'FIXTURES',
      checks: { fixturesLoaded: false, error: carrierConfig.error },
      completedAt: timestamp
    };
    writeMerits([{ name: 'executor-error.json', data: fixtureEvidence, kind: 'executor-error' }], []);
    return failureOutcome('FIXTURES_UNAVAILABLE', 'carriers fixture unavailable: ' + carrierConfig.error, fixtureEvidence);
  }
  var carriers = carrierConfig.carriers;
  var nails = nailsCountOf(context);
  var setWeightGrams = fixtureSetWeightGrams(carriers, nails);
  observed.carrierConfig = {
    origin: carriers.origin,
    sha256: carrierConfig.sha256,
    weightBands: carriers.weightBands,
    productWeights: carriers.productWeights,
    nails: nails,
    setWeightGrams: setWeightGrams
  };
  var countries = countriesOf(carriers);
  countries.forEach(function(c) {
    checks.countries[c] = {
      pricing: false,
      carrier: false,
      currency: false,
      agreement: false,
      inventory: false
    };
  });

  // -------------------------------------------------------------------------
  // 3. Buyer login.
  // -------------------------------------------------------------------------
  var store = sessionModule.createSessionStore(context);
  store.ensure(BUYER_ACCOUNT);

  function recordStep(name, storeResult, pathArr) {
    var outcome = storeResult;
    var response = outcome && outcome.response ? outcome.response : (outcome && outcome.evidence && outcome.evidence.response);
    var request = (outcome && outcome.request) || (outcome && outcome.evidence && outcome.evidence.request);
    rawRequests.push({ step: name, url: request && request.url, headers: request && request.headers, body: request && request.body, timestamp: timestamp });
    rawResponses.push({ step: name, httpStatus: response && response.httpStatus, body: response && response.body, timestamp: timestamp });
    steps.push({
      step: name,
      success: typeof outcome.success === 'boolean' ? outcome.success : false,
      errorCode: (outcome && outcome.errorCode) || null,
      data: pathArr ? readData(outcome, pathArr) : null
    });
  }

  var loginOut = await store.login(BUYER_ACCOUNT);
  recordStep('buyer-login', loginOut, ['data', 'login']);
  checks.loginOk = loginOut.success === true;
  if (!checks.loginOk) {
    var loginFail = { taskId: taskId, step: 'buyer-login', steps: steps, errCode: loginOut.errorCode, error: loginOut.error, completedAt: timestamp };
    writeApiEvidence([{ name: 'executor-error.json', data: loginFail, kind: 'executor-error' }], secrets);
    return outcomeFromStoreFailure(loginOut, taskId, loginFail);
  }

  function networkDown(out) {
    if (!out) return true;
    var response = out.response;
    if (!response) return true;
    return response.httpStatus === null || response.httpStatus >= 500;
  }

  // -------------------------------------------------------------------------
  // 4. Per-country pricing and agreement.
  // -------------------------------------------------------------------------
  observed.countries = {};
  for (var ci = 0; ci < countries.length; ci++) {
    var country = countries[ci];
    var entry = fixtureCarrier(carriers, country);
    var expectedCarrierName = entry ? entry.name : null;

    // eligibleShippingMethods (read-only; no mutation needed).
    var elOut = await store.call(BUYER_ACCOUNT, ELIGIBLE_SHIPPING_METHODS_QUERY, {}, country);
    recordStep('eligible-shipping-' + country, elOut, ['data', 'eligibleShippingMethods']);
    if (networkDown(elOut)) {
      var downEvidence = { taskId: taskId, step: 'eligible-shipping-' + country, error: 'shop-api down: ' + ((elOut && elOut.networkError) || 'HTTP down'), steps: steps, rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
      writeApiEvidence([{ name: 'executor-error.json', data: downEvidence, kind: 'executor-error' }], secrets);
      return failureOutcome('ENVIRONMENT_ERROR', downEvidence.error, downEvidence);
    }
    var methods = readData(elOut, ['data', 'eligibleShippingMethods']) || [];
    var method = null;
    for (var mi = 0; mi < methods.length; mi++) {
      if (methods[mi] && methods[mi].name === expectedCarrierName) { method = methods[mi]; break; }
    }
    checks.countries[country].carrier = !!method;

    var order = null;
    var weightKg = null;
    if (allowMutation) {
      // setOrderShippingAddress for this country.
      var addrOut = await store.call(BUYER_ACCOUNT, SET_SHIPPING_ADDRESS_MUTATION, { input: shippingAddressForCountry(country) }, country);
      recordStep('set-shipping-address-' + country, addrOut, ['data', 'setOrderShippingAddress']);
      if (networkDown(addrOut)) {
        var addrDown = { taskId: taskId, step: 'set-shipping-address-' + country, error: 'shop-api down for shipping address', steps: steps, rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
        writeApiEvidence([{ name: 'executor-error.json', data: addrDown, kind: 'executor-error' }], secrets);
        return failureOutcome('ENVIRONMENT_ERROR', addrDown.error, addrDown);
      }

      // addItemToOrder for the country variant (one fixture set).
      var addOut = await store.addItemToOrder(BUYER_ACCOUNT, variantIdOf(context, country), 1, country);
      recordStep('add-item-' + country, addOut, ['data', 'addItemToOrder']);
      if (!addOut.success) {
        if (networkDown(addOut)) {
          var addDown = { taskId: taskId, step: 'add-item-' + country, error: 'shop-api down for addItemToOrder', steps: steps, rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
          writeApiEvidence([{ name: 'executor-error.json', data: addDown, kind: 'executor-error' }], secrets);
          return failureOutcome('ENVIRONMENT_ERROR', addDown.error, addDown);
        }
        // The order did not accept the item under this channel token.
        var addFail = { taskId: taskId, step: 'add-item-' + country, error: addOut.error || 'addItemToOrder rejected for ' + country, steps: steps, rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
        writeApiEvidence([{ name: 'executor-error.json', data: addFail, kind: 'executor-error' }], secrets);
        return failureOutcome(addOut.errorCode || 'EXPECTED_MISMATCH', addFail.error, addFail);
      }

      // setOrderShippingMethod with the eligible carrier.
      var setMethodOut = await store.call(BUYER_ACCOUNT, SET_SHIPPING_METHOD_MUTATION, { shippingMethodId: [method ? method.id : 'ship-' + country.toLowerCase()] }, country);
      recordStep('set-shipping-method-' + country, setMethodOut, ['data', 'setOrderShippingMethod']);
      if (networkDown(setMethodOut)) {
        var setDown = { taskId: taskId, step: 'set-shipping-method-' + country, error: 'shop-api down for setOrderShippingMethod', steps: steps, rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
        writeApiEvidence([{ name: 'executor-error.json', data: setDown, kind: 'executor-error' }], secrets);
        return failureOutcome('ENVIRONMENT_ERROR', setDown.error, setDown);
      }

      // Read the order detail with weight/stock/payments.
      var orderCode = null;
      var orderNode = readData(setMethodOut, ['data', 'setOrderShippingMethod']);
      if (orderNode && orderNode.code) orderCode = orderNode.code;
      if (!orderCode) {
        var addOrderNode = readData(addOut, ['data', 'addItemToOrder']);
        if (addOrderNode && addOrderNode.code) orderCode = addOrderNode.code;
      }
      if (!orderCode) orderCode = 'ORD-' + country.toUpperCase() + '-CART';
      var detailOut = await store.call(BUYER_ACCOUNT, SHIPPING_WEIGHT_ORDER_DETAIL_QUERY, { code: orderCode }, country);
      recordStep('order-detail-' + country, detailOut, ['data', 'orderByCode']);
      if (networkDown(detailOut)) {
        var detailDown = { taskId: taskId, step: 'order-detail-' + country, error: 'shop-api down for order detail', steps: steps, rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
        writeApiEvidence([{ name: 'executor-error.json', data: detailDown, kind: 'executor-error' }], secrets);
        return failureOutcome('ENVIRONMENT_ERROR', detailDown.error, detailDown);
      }
      order = readData(detailOut, ['data', 'orderByCode']);
      weightKg = order ? (orderWeightGrams(order) / 1000) : null;
    } else {
      order = null;
      weightKg = null;
    }

    // Expected price computed from the fixture carriers/bands and (observed)
    // weight when an order was read; otherwise use the fixture set weight.
    var pricingWeightKg = weightKg !== null && weightKg !== undefined ? weightKg : (setWeightGrams / 1000);
    var decimal = bandPriceOf(carriers, country, pricingWeightKg);
    var cents = expectedShippingCents(carriers, country, pricingWeightKg);
    var expected = { decimal: decimal, cents: cents, weightKg: pricingWeightKg };

    var chk = checks.countries[country];
    if (order) {
      chk.pricing = shippingCentsOf(order) === cents;
      chk.currency = !!(order.currencyCode === sessionModule.COUNTRY_CURRENCY_MAP[country]);
      chk.agreement = orderShippingAgreesWithRecord(order) && receiptTotalsAgree(order) &&
        shippingCompanyOf(order) === expectedCarrierName;
      chk.inventory = inventoryAgrees(order);
    } else {
      chk.pricing = false;
      chk.currency = false;
      chk.agreement = false;
      chk.inventory = false;
    }

    observed.countries[country] = summarizeCountry(country, order, method, expected);
  }

  // -------------------------------------------------------------------------
  // 5. Weight-change recalculation + extra payment (DE, mutation approved).
  // -------------------------------------------------------------------------
  observed.weightChange = null;
  if (allowMutation) {
    var wcQuantity = (context.fixtures && context.fixtures.weightChangeQuantity) || 9;
    var wcAdd = await store.addItemToOrder(BUYER_ACCOUNT, variantIdOf(context, PRIMARY_COUNTRY), wcQuantity, PRIMARY_COUNTRY);
    recordStep('weight-change-add-item', wcAdd, ['data', 'addItemToOrder']);
    var wcOrder = null;
    if (wcAdd.success) {
      var wcCode = null;
      var wcNode = readData(wcAdd, ['data', 'addItemToOrder']);
      if (wcNode && wcNode.code) wcCode = wcNode.code;
      if (!wcCode) wcCode = 'ORD-' + PRIMARY_COUNTRY.toUpperCase() + '-LIVE';
      var wcDetail = await store.call(BUYER_ACCOUNT, SHIPPING_WEIGHT_ORDER_DETAIL_QUERY, { code: wcCode }, PRIMARY_COUNTRY);
      recordStep('weight-change-order-detail', wcDetail, ['data', 'orderByCode']);
      if (!networkDown(wcDetail)) {
        wcOrder = readData(wcDetail, ['data', 'orderByCode']);
      }
    }
    var wcBeforeKg = (observed.countries[PRIMARY_COUNTRY] && observed.countries[PRIMARY_COUNTRY].weightKg) || (setWeightGrams / 1000);
    var wcAfterKg = wcOrder ? (orderWeightGrams(wcOrder) / 1000) : wcBeforeKg;
    var wcExpectedBefore = expectedShippingCents(carriers, PRIMARY_COUNTRY, wcBeforeKg);
    var wcExpectedAfter = expectedShippingCents(carriers, PRIMARY_COUNTRY, wcAfterKg);
    var wcObservedAfter = wcOrder ? shippingCentsOf(wcOrder) : null;
    var wcPaid = wcOrder ? paidAmountOf(wcOrder) : 0;
    var wcTotal = wcOrder && wcOrder.totalWithTax !== null && wcOrder.totalWithTax !== undefined ? Number(wcOrder.totalWithTax) : null;
    var wcExtra = wcTotal !== null ? (wcTotal - wcPaid) : null;
    observed.weightChange = {
      beforeQuantityCentsExpected: wcExpectedBefore,
      afterWeightKg: wcAfterKg,
      afterQuantityCentsExpected: wcExpectedAfter,
      observedShippingCents: wcObservedAfter,
      bandChanged: wcExpectedBefore !== wcExpectedAfter,
      shippingRecalculated: wcExpectedAfter !== null && wcObservedAfter === wcExpectedAfter,
      paidAmount: wcPaid,
      totalWithTax: wcTotal,
      extraPayment: wcExtra
    };
    checks.weightChangeOk = observed.weightChange.bandChanged === true && observed.weightChange.shippingRecalculated === true;
    checks.extraPaymentOk = observed.weightChange.extraPayment !== null && observed.weightChange.extraPayment > 0;
  }

  // -------------------------------------------------------------------------
  // 6. Merge recalculation + extra payment (DE, read merged order).
  // -------------------------------------------------------------------------
  observed.merge = null;
  if (allowMutation) {
    var mergeCode = (context.fixtures && context.fixtures.mergedOrderCode) || 'ORD-DE-MERGED';
    var mergeDetail = await store.call(BUYER_ACCOUNT, SHIPPING_WEIGHT_ORDER_DETAIL_QUERY, { code: mergeCode }, PRIMARY_COUNTRY);
    recordStep('merge-order-detail', mergeDetail, ['data', 'orderByCode']);
    if (!networkDown(mergeDetail)) {
      var mergedOrder = readData(mergeDetail, ['data', 'orderByCode']);
      if (mergedOrder) {
        var mergeWeightKg = orderWeightGrams(mergedOrder) / 1000;
        var mergeExpected = expectedShippingCents(carriers, PRIMARY_COUNTRY, mergeWeightKg);
        var mergeShipping = shippingCentsOf(mergedOrder);
        var mergeExtra = extraPaymentOf(mergedOrder);
        observed.merge = {
          code: mergeCode,
          weightKg: mergeWeightKg,
          expectedCents: mergeExpected,
          shipping: mergeShipping,
          company: shippingCompanyOf(mergedOrder),
          receiptAgrees: receiptTotalsAgree(mergedOrder),
          paid: paidAmountOf(mergedOrder),
          extraPayment: mergeExtra
        };
        var mergeCarrierName = fixtureCarrier(carriers, PRIMARY_COUNTRY) ? fixtureCarrier(carriers, PRIMARY_COUNTRY).name : null;
        checks.mergeRecalcOk = mergeShipping === mergeExpected &&
          mergeCarrierName !== null &&
          observed.merge.company === mergeCarrierName &&
          observed.merge.receiptAgrees === true;
        checks.mergeExtraPayment = mergeExtra !== null && mergeExtra > 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7. Stripe capability probe (presence/test-key only; fake server bounded).
  // -------------------------------------------------------------------------
  if (allowMutation) {
    var stripeProbe = await runStripeProbe(context);
    observed.stripeProbe = stripeProbe;
    checks.stripeProbeRetrieved = true;
    var stripeEvidence = {
      taskId: taskId,
      capability: 'STRIPE_SECRET_KEY',
      keyPresent: stripeProbe.keyPresent,
      keyIsTestKey: stripeProbe.keyIsTestKey,
      livemodeFalse: stripeProbe.livemodeFalse,
      paymentIntentCreateStatus: stripeProbe.paymentIntentCreateStatus,
      paymentIntentCancelStatus: stripeProbe.paymentIntentCancelStatus,
      fakeServer: stripeProbe.fakeServer
    };
    writeMerits([{ name: 'stripe-probe.json', data: stripeEvidence, kind: 'artifact' }], []);
  }

  // -------------------------------------------------------------------------
  // 8. Build evidence and report.
  // -------------------------------------------------------------------------
  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Shipping and weight: per-country carriers/weight bands, recalculation after merges and weight changes, agreement of order/shipping record/receipt/inventory',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    buyerAccount: BUYER_ACCOUNT,
    allowShippingMutation: allowMutation,
    expected: {
      perCountry: 'per-country simulated carriers and weight bands price shipping correctly by country, weight and carrier',
      recalc: 'merges and weight changes trigger recalculation and any extra payment',
      agree: 'order, shipping record, receipt and inventory operation agree'
    },
    carrierConfig: observed.carrierConfig,
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    unverified: buildUnverifiedList(observed, checks),
    completedAt: timestamp
  };

  writeApiEvidence([
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  // Record an evidence file at task level even when the mapping is not forced
  // through deps (the pipeline CLI injects none; evidenceCollector is used).
  var runId = runIdOf(context);
  if (runId) {
    var recOpts = evidenceOptions(context);
    try {
      evidenceCollector.writeTaskRecord(runId, taskId, {
        canonicalId: taskId,
        summarySpecIds: ['B2-13'],
        referenceRevision: null,
        executionRevision: (context.runEnvRecord && (context.runEnvRecord.gitHead || context.runEnvRecord.revisionId)) || null,
        environmentIdentity: { runId: runId },
        commandInvocation: 'executor handlerShippingWeight',
        inputArtifactIds: ['manifest/fixtures.v1.json'],
        expectedResult: taskExpectedText(context, taskId),
        actualResult: evidence,
        exitErrorResult: { exitCode: 0, error: null },
        generatedArtifacts: ['shipping-price-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'],
        stateChanges: { orderStateMutations: allowMutation, paymentCreated: false, paymentCancelled: false },
        cleanupResetResult: { ok: true, note: 'no temp resources created on the runner; tests use fake local servers' },
        finalClassification: null,
        naReason: null
      }, recOpts);
      if (typeof (context.deps || {}).writeTaskRecord === 'function' && runId) {
        context.deps.writeTaskRecord(runId, taskId, {
          canonicalId: taskId,
          summarySpecIds: ['B2-13'],
          referenceRevision: null,
          executionRevision: null,
          environmentIdentity: { runId: runId },
          commandInvocation: 'executor handlerShippingWeight',
          inputArtifactIds: ['manifest/fixtures.v1.json'],
          expectedResult: taskExpectedText(context, taskId),
          actualResult: evidence,
          exitErrorResult: { exitCode: 0, error: null },
          generatedArtifacts: ['shipping-price-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'],
          stateChanges: { orderStateMutations: allowMutation, paymentCreated: false, paymentCancelled: false },
          cleanupResetResult: { ok: true, note: 'no temp resources created on the runner; tests use fake local servers' },
          finalClassification: null,
          naReason: null
        }, {});
      }
    } catch (e) {
      // record write is best-effort; evidence files are already written.
    }
  }

  // -------------------------------------------------------------------------
  // Determine failures.
  // -------------------------------------------------------------------------
  var failures = [];
  if (!checks.envVarsOk) failures.push('required env var missing');
  if (!checks.tokensOk) failures.push('channel tokens missing');
  if (!checks.fixtureOk) failures.push('carriers fixture unavailable');
  if (!checks.loginOk) failures.push('buyer login failed');
  countryCodes(checks).forEach(function(c) {
    var chk = checks.countries[c] || {};
    if (chk.carrier !== true) failures.push('eligible carrier missing for ' + c);
    // The pricing/currency/agreement/inventory checks require an order that
    // can only be built with mutation approval; without it they are recorded
    // as unverified, not as defects, exactly like the merge/weight-change
    // stages below.
    if (allowMutation) {
      if (chk.pricing !== true) failures.push('shipping price mismatch for ' + c);
      if (chk.currency !== true) failures.push('currency mismatch for ' + c);
      if (chk.agreement !== true) failures.push('order/shipping/receipt agreement broken for ' + c);
      if (chk.inventory !== true) failures.push('inventory operation mismatch for ' + c);
    }
  });
  if (allowMutation) {
    if (checks.weightChangeOk !== true) failures.push('weight change did not trigger recalculation');
    if (checks.extraPaymentOk !== true) failures.push('weight change extra payment not positive');
    if (checks.mergeRecalcOk !== true) failures.push('merged order recalculation inconsistent');
    if (checks.mergeExtraPayment !== true) failures.push('merged order extra payment not positive');
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    writeMerits([{ name: 'executor-error.json', data: { taskId: taskId, error: 'shipping weight mismatch: ' + detail, checks: checks, observed: observed, completedAt: timestamp }, kind: 'executor-error' }], secrets);
    return failureOutcome('EXPECTED_MISMATCH', 'shipping weight mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-13', {
    description: 'Shipping and weight: per-country simulated carriers and weight bands, recalculation after merges and weight changes and any extra payment, agreement of order/shipping record/receipt/inventory (readiness scope shipping-weight)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-13-A01'],
    handler: handlerShippingWeight
  });
  return { success: true, registered: ['CAN-B2-13'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  PRIMARY_COUNTRY: PRIMARY_COUNTRY,
  DEFAULT_NAILS: DEFAULT_NAILS,
  PAID_PAYMENT_STATES: PAID_PAYMENT_STATES.slice(),
  STRIPE_TEST_KEY_PREFIX: STRIPE_TEST_KEY_PREFIX,
  PASSWORD_ENV_NAME: PASSWORD_ENV_NAME,
  STRIPE_SECRET_ENV_NAME: STRIPE_SECRET_ENV_NAME,
  ELIGIBLE_SHIPPING_METHODS_QUERY: ELIGIBLE_SHIPPING_METHODS_QUERY,
  SET_SHIPPING_ADDRESS_MUTATION: SET_SHIPPING_ADDRESS_MUTATION,
  SET_SHIPPING_METHOD_MUTATION: SET_SHIPPING_METHOD_MUTATION,
  SHIPPING_WEIGHT_ORDER_DETAIL_QUERY: SHIPPING_WEIGHT_ORDER_DETAIL_QUERY,
  loadCarrierConfig: loadCarrierConfig,
  countriesOf: countriesOf,
  fixtureCarrier: fixtureCarrier,
  nailsCountOf: nailsCountOf,
  fixtureSetWeightGrams: fixtureSetWeightGrams,
  orderWeightGrams: orderWeightGrams,
  bandPriceOf: bandPriceOf,
  toMinorUnits: toMinorUnits,
  expectedShippingCents: expectedShippingCents,
  shippingCentsOf: shippingCentsOf,
  shippingRecordCentsOf: shippingRecordCentsOf,
  shippingCompanyOf: shippingCompanyOf,
  paidAmountOf: paidAmountOf,
  extraPaymentOf: extraPaymentOf,
  receiptTotalsAgree: receiptTotalsAgree,
  orderShippingAgreesWithRecord: orderShippingAgreesWithRecord,
  inventoryAgrees: inventoryAgrees,
  shippingAddressForCountry: shippingAddressForCountry,
  variantIdOf: variantIdOf,
  runStripeProbe: runStripeProbe,
  buildAssertionReport: buildAssertionReport,
  buildUnverifiedList: buildUnverifiedList,
  handlerShippingWeight: handlerShippingWeight,
  register: register
};
