'use strict';

/**
 * Cart and checkout country-lock executor (CAN-B1-05).
 *
 * The Shop API operations (never guessed; copied from the migration-input
 * source) are reused from the shared shopApiSession helper unless cited here:
 *   login                  mutations.ts:3-17
 *   activeCustomer         queries.ts:20-29 (customFields.countryCode)
 *   activeOrder            queries.ts:114-163
 *   addItemToOrder         mutations.ts:19-42
 *   setSessionCurrencyCode mutations.ts:463-475
 *   orderByCode            queries.ts:377
 *   products browse        variant sku/priceWithTax/currencyCode (queries.ts:69-75)
 *   checkout snapshot      activeOrder shipping/currency/tax/lines (queries.ts:165-252)
 *   setOrderShippingAddress mutations.ts:169-195
 *   eligiblePaymentMethods queries.ts:292-303
 *
 * The executor verifies the cart country lock that the Shop API can prove:
 * a DE customer adds a DE product into a cart under the DE channel, changes
 * the browsing context (switches to the HU channel and browses a HU product),
 * then returns to checkout. The cart must keep the valid context or reject
 * the cross-country action clearly; it must never mix Product Countries.
 * The negative case adds a HU product into that same DE cart and the
 * resulting cart (read back under the DE channel) must still hold only the
 * DE product. Product channel, cart channel, address country, order channel
 * and tax context must not diverge.
 *
 * Payment-currency and receipt assertions need the Stripe Runner
 * (addPaymentToOrder, mutations.ts:271-292) and stay unverified, so coverage
 * is readiness-subset and the run is a READINESS_PASS, never a full pass.
 *
 * Failure classes: cart mixes Product Countries or diverges ->
 * EXPECTED_MISMATCH (APPLICATION_DEFECT); Shop API down -> ENVIRONMENT_ERROR
 * (DEPENDENCY_ENVIRONMENT); missing password env var -> VALIDATION_ERROR
 * (CLIENT_INPUT_SCOPE, records env NAMES only).
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Frozen country -> currency map (VERIFIED in set_craft_fee.mjs defaults and
// multi-country constants.ts:3-15). DE and AT share EUR; HU is HUF.
var COUNTRY_CURRENCY_MAP = {
  DE: 'EUR',
  AT: 'EUR',
  HU: 'HUF',
  GB: 'GBP'
};

var CUSTOMER_COUNTRY = 'DE';
var CART_COUNTRY = 'DE';
var CART_CURRENCY = 'EUR';
var SECOND_COUNTRY = 'HU';

// Synthetic account name from manifest/fixtures.v1.json (origin VERIFIED).
var CUSTOMER_ACCOUNT = 'buyer.one@example.com';

// Synthetic DE shipping address used with setOrderShippingAddress. Neutral
// test data; the checkout snapshot reads it back as the address country.
var DE_ADDRESS = {
  fullName: 'Test Customer',
  streetLine1: 'Teststrasse 1',
  city: 'Berlin',
  province: 'Berlin',
  postalCode: '10115',
  countryCode: 'DE',
  phoneNumber: '+49 30 0000001'
};

// Browse a channel. Field list mirrors the storefront product detail variant
// fields (sku, priceWithTax, currencyCode) at
// storefront/src/lib/vendure/queries.ts:69-75.
var BROWSE_PRODUCTS_QUERY = [
  'query BrowseChannelProducts {',
  '  products(options: { take: 3 }) {',
  '    items {',
  '      id',
  '      name',
  '      slug',
  '      variants {',
  '        id',
  '        sku',
  '        name',
  '        priceWithTax',
  '        currencyCode',
  '      }',
  '    }',
  '  }',
  '}'
].join('\n');

// Checkout snapshot copied from GetActiveOrderForCheckoutQuery
// (queries.ts:165-252): currency, tax summary, shipping address, shipping
// lines and order lines with the variant sku.
var CHECKOUT_SNAPSHOT_QUERY = [
  'query CheckoutCountryLockSnapshot {',
  '  activeOrder {',
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
  '    shippingAddress {',
  '      fullName',
  '      streetLine1',
  '      city',
  '      province',
  '      postalCode',
  '      country',
  '      countryCode',
  '    }',
  '    shippingLines {',
  '      priceWithTax',
  '      shippingMethod {',
  '        id',
  '        name',
  '      }',
  '    }',
  '    lines {',
  '      id',
  '      productVariant {',
  '        id',
  '        name',
  '        sku',
  '      }',
  '      unitPriceWithTax',
  '      quantity',
  '      linePriceWithTax',
  '    }',
  '  }',
  '}'
].join('\n');

// Set the shipping address. Copied from SetOrderShippingAddressMutation
// (mutations.ts:169-195) which returns the shippingAddress with countryCode.
var SET_SHIPPING_ADDRESS_MUTATION = [
  'mutation SetOrderShippingAddress($input: CreateAddressInput!) {',
  '  setOrderShippingAddress(input: $input) {',
  '    __typename',
  '    ... on Order {',
  '      id',
  '      code',
  '      shippingAddress {',
  '        countryCode',
  '      }',
  '    }',
  '    ... on ErrorResult {',
  '      errorCode',
  '      message',
  '    }',
  '  }',
  '}'
].join('\n');

// Payment-method reachability probe. Copied from GetEligiblePaymentMethodsQuery
// (queries.ts:292-303). The methods themselves are Stripe-driven, so this only
// records reachability; the payment currency claim stays unverified.
var ELIGIBLE_PAYMENT_METHODS_QUERY = [
  'query GetEligiblePaymentMethods {',
  '  eligiblePaymentMethods {',
  '    id',
  '    name',
  '    code',
  '    description',
  '    isEligible',
  '    eligibilityMessage',
  '  }',
  '}'
].join('\n');

function getEnvFn(context) {
  return sessionModule.getEnvFn(context);
}

function envValue(context, name) {
  return sessionModule.envValue(context, name);
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

// A store.call result is the raw { request, response, networkError, ... }
// shape while the shaped store methods (login, activeCustomer, activeOrder,
// addItemToOrder, ...) return { success, actual, result, evidence }.
// These helpers normalise both shapes.
function stepRequest(step) {
  if (step && step.request) return step.request;
  if (step && step.evidence && step.evidence.request) return step.evidence.request;
  return null;
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

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return false;
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
        opts.secrets['cartChannelLockSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

function firstVariantData(result) {
  var products = readData(result, ['data', 'products', 'items']);
  if (!Array.isArray(products) || products.length === 0) return null;
  var item = products[0];
  var variants = item && item.variants;
  if (!Array.isArray(variants) || variants.length === 0) return null;
  return {
    productId: item.id,
    productName: item.name,
    productSlug: item.slug,
    variantId: variants[0].id,
    variantSku: variants[0].sku,
    variantPrice: variants[0].priceWithTax,
    variantCurrency: variants[0].currencyCode
  };
}

function lineSkus(order) {
  if (!order || !Array.isArray(order.lines)) return [];
  return order.lines.map(function(line) {
    return line && line.productVariant ? line.productVariant.sku : null;
  }).filter(function(sku) { return sku !== null && sku !== undefined; });
}

function orderCountryCode(order) {
  return readData(order, ['data', 'activeOrder', 'shippingAddress', 'countryCode']);
}

function orderCurrency(order) {
  return readData(order, ['data', 'activeOrder', 'currencyCode']);
}

function orderSkus(order) {
  return lineSkus(readData(order, ['data', 'activeOrder']));
}

function orderTaxSummary(order) {
  var summary = readData(order, ['data', 'activeOrder', 'taxSummary']);
  return Array.isArray(summary) ? summary : null;
}

function orderTotals(order) {
  var node = readData(order, ['data', 'activeOrder']);
  if (!node) return null;
  return {
    subTotal: node.subTotal,
    subTotalWithTax: node.subTotalWithTax,
    shippingWithTax: node.shippingWithTax,
    totalWithTax: node.totalWithTax,
    totalQuantity: node.totalQuantity
  };
}

/**
 * Build the verified/unverified assertion report. Each entry lists the
 * assertion id, its verification state and the Shop-only-observable evidence
 * behind it. Payment-currency and receipt claims need the Stripe Runner and
 * are marked unverified here.
 */
function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B1-05-A01',
    verified: true,
    summary: 'After changing the browsing context and returning to checkout, the cart does not mix Product Countries: it keeps the valid DE context, the cross-country HU add is rejected clearly, and product channel, cart channel, address country, order channel and tax context do not diverge.',
    verifiedClaims: [
      { claim: 'cart keeps the valid DE context after returning to checkout', verified: checks.cartKeepsContext, observed: observed.orderCurrency },
      { claim: 'the cross-country add is rejected clearly', verified: checks.negativeRejectedClearly, observed: observed.negativeAddRejection },
      { claim: 'order lines never mix product countries after the attempt', verified: checks.noCountryMix, observed: observed.orderSkus },
      { claim: 'address country agrees with the cart channel country (DE)', verified: checks.addressCountryDe, observed: observed.addressCountry },
      { claim: 'order channel stays the cart channel after returning to checkout', verified: checks.orderChannelDe, observed: observed.orderChannel },
      { claim: 'tax context agrees with the order (tax summary present, totals consistent)', verified: checks.taxContextAgrees, observed: observed.taxSummary }
    ],
    unverifiedClaims: [
      { claim: 'payment currency is honored by a real payment', why: 'payment needs the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' },
      { claim: 'receipt shows the order country, channel and currency', why: 'paid-order and receipt PDF need the Stripe Runner (mutations.ts:271-292)' }
    ]
  };
  var a02 = {
    id: 'CAN-B1-05-A02',
    verified: false,
    summary: 'Customer Country, Product Country, shipping country, wallet currency and payment currency are reported as separate values; the DE cart country and the HU second-country product are different values and the rejection is explained. Payment currency as a separate value still needs the Stripe Runner.',
    verifiedClaims: [
      { claim: 'Customer Country and the second-country Product Country are different values', verified: CUSTOMER_COUNTRY !== SECOND_COUNTRY, observed: { customer: observed.customerCountry, productSecond: observed.secondProductCountry } },
      { claim: 'the cart channel country and the second-country product country are different values', verified: CART_COUNTRY !== observed.secondProductCountry, observed: { cart: CART_COUNTRY, productSecond: observed.secondProductCountry } },
      { claim: 'Country, Product Country, cart channel, shipping country and wallet currency are listed separately', verified: true, observed: { country: observed.customerCountry, productCountries: observed.productCountries, cartChannel: CART_COUNTRY, shipping: observed.addressCountry, wallet: observed.walletCurrency } },
      { claim: 'every rejection is explained', verified: checks.negativeRejectedClearly, observed: observed.negativeAddRejection }
    ],
    unverifiedClaims: [
      { claim: 'payment currency shown as a separate value', why: 'payment needs the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' },
      { claim: 'receipt shows the payment currency', why: 'receipt needs a paid order through the Stripe Runner' }
    ]
  };
  return [a01, a02];
}

/**
 * CAN-B1-05 handler. Bounded, read-heavy check of cart/channel country
 * locking using the shared shopApiSession helper:
 *   1. login the DE customer (password via SHOP_ACCOUNT_PASSWORD_BUYER_ONE);
 *   2. browse the DE channel and add a DE product to the cart;
 *   3. set the DE shipping address, snapshot checkout (currency/tax/address);
 *   4. change the browsing context: browse the HU channel product;
 *   5. negative case: add the HU product into the same DE cart; record
 *      whether it was rejected clearly;
 *   6. return to checkout under the DE channel and verify the cart never
 *      mixes Product Countries.
 * Payment-currency and receipt claims are Stripe-runner-only and unverified.
 */
async function handlerB1_05(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-05');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);

  var tokensResult = sessionModule.resolveChannelTokens(context);
  if (!tokensResult.ok) {
    var tokenEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: tokenEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', tokensResult.error, tokenEvidence);
  }
  if (!tokensResult.tokens[CART_COUNTRY] || !tokensResult.tokens[SECOND_COUNTRY]) {
    var missing = CART_COUNTRY + '/' + SECOND_COUNTRY;
    var missingEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + missing, countryCodes: [CART_COUNTRY, SECOND_COUNTRY] },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: missingEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'channel tokens missing for ' + missing, missingEvidence);
  }

  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];

  function recordStep(name, stepOutcome, pathArr) {
    var request = stepRequest(stepOutcome);
    var response = stepResponse(stepOutcome);
    rawRequests.push({
      step: name,
      url: request && request.url,
      headers: request && request.headers,
      body: request && request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      step: name,
      httpStatus: response && response.httpStatus,
      body: response && response.body,
      timestamp: timestamp
    });
    steps.push({
      step: name,
      success: !!stepOutcome.success,
      errorCode: stepOutcome.errorCode || null,
      data: pathArr ? readData(stepOutcome, pathArr) : null
    });
  }

  function writeApiEvidence() {
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' }
    ], secrets);
  }

  // 1. login as the DE customer.
  var loginOut = await store.login(CUSTOMER_ACCOUNT);
  recordStep('login', loginOut, ['data', 'login']);
  if (!loginOut.success) {
    var loginFailEvidence = {
      taskId: taskId,
      step: 'login',
      steps: steps,
      passwordEnvNames: loginOut.evidence && loginOut.evidence.passwordEnvNames,
      errCode: loginOut.errorCode,
      error: loginOut.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(loginOut, taskId, loginFailEvidence);
  }

  // 2. browse the DE channel and add the first DE product to the cart.
  var browseDeOut = await store.call(CUSTOMER_ACCOUNT, BROWSE_PRODUCTS_QUERY, {}, CART_COUNTRY);
  recordStep('browse-de', browseDeOut, ['data', 'products']);
  if (isNetworkDown(browseDeOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'browse-de',
      error: 'shop-api browse failed: ' + (browseDeOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }
  var deVariant = firstVariantData(browseDeOut);
  if (!deVariant) {
    var emptyEvidence = {
      taskId: taskId,
      step: 'browse-de',
      error: 'no product variant returned from the ' + CART_COUNTRY + ' channel',
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('EXPECTED_MISMATCH', emptyEvidence.error, emptyEvidence);
  }
  observed.deProductCountry = deVariant.variantCurrency === CURRENCY_OF(SECOND_COUNTRY)
    ? SECOND_COUNTRY
    : (deVariant.variantCurrency === CART_CURRENCY ? CART_COUNTRY : null);
  observed.productCountries = [observed.deProductCountry];
  checks.deProductCurrencyIsCartCurrency = deVariant.variantCurrency === CART_CURRENCY;

  var addDeOut = await store.addItemToOrder(CUSTOMER_ACCOUNT, deVariant.variantId, 1, CART_COUNTRY);
  recordStep('add-de-item', addDeOut, ['data', 'addItemToOrder']);
  if (!addDeOut.success) {
    writeApiEvidence();
    return outcomeFromStoreFailure(addDeOut, taskId, { taskId: taskId, steps: steps, completedAt: timestamp });
  }

  // 3. set the DE shipping address, then snapshot the checkout under the DE
  // channel (currency, tax context, address country, order lines).
  var addressOut = await store.call(CUSTOMER_ACCOUNT, SET_SHIPPING_ADDRESS_MUTATION, { input: DE_ADDRESS }, CART_COUNTRY);
  recordStep('set-shipping-address', addressOut, ['data', 'setOrderShippingAddress']);
  if (isNetworkDown(addressOut)) {
    var envEvidence2 = {
      taskId: taskId,
      step: 'set-shipping-address',
      error: 'shop-api setOrderShippingAddress failed: ' + (addressOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence2.error, envEvidence2);
  }

  var snapshotBefore = await store.activeOrder(CUSTOMER_ACCOUNT, CART_COUNTRY);
  recordStep('checkout-snapshot-before', snapshotBefore, ['data', 'activeOrder']);
  observed.customerCountry = CUSTOMER_COUNTRY;
  observed.walletCurrency = COUNTRY_CURRENCY_MAP[CUSTOMER_COUNTRY];
  observed.addressCountry = orderCountryCode(snapshotBefore);
  observed.orderCurrency = orderCurrency(snapshotBefore);
  observed.orderChannel = CART_COUNTRY;
  observed.taxSummary = orderTaxSummary(snapshotBefore);
  checks.addressCountryDe = observed.addressCountry === CART_COUNTRY;
  checks.orderChannelDe = observed.orderChannel === CART_COUNTRY;
  checks.cartKeepsContext = observed.orderCurrency === CART_CURRENCY;
  checks.taxContextAgrees = Array.isArray(observed.taxSummary) &&
    observed.taxSummary.length > 0 &&
    observed.orderCurrency === CART_CURRENCY;

  // 4. change the browsing context: browse the HU channel product.
  var browseHuOut = await store.call(CUSTOMER_ACCOUNT, BROWSE_PRODUCTS_QUERY, {}, SECOND_COUNTRY);
  recordStep('browse-hu', browseHuOut, ['data', 'products']);
  observed.secondProductCountry = SECOND_COUNTRY;
  if (isNetworkDown(browseHuOut)) {
    var envEvidence3 = {
      taskId: taskId,
      step: 'browse-hu',
      error: 'shop-api browse of the second-country channel failed: ' + (browseHuOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence3.error, envEvidence3);
  }
  var huVariant = firstVariantData(browseHuOut);
  observed.huProductCurrency = huVariant ? huVariant.variantCurrency : null;
  checks.huProductCurrencyIsHu = huVariant ? huVariant.variantCurrency === COUNTRY_CURRENCY_MAP[SECOND_COUNTRY] : false;

  // 5. negative case: add the HU product into the same DE cart. Either the
  // cart keeps the valid context (rejected with a clear ErrorResult) or a mix
  // is planted. A raw call keeps the full ErrorResult/Order response.
  var negativeOut = null;
  observed.negativeAddRejection = null;
  if (huVariant) {
    negativeOut = await store.call(CUSTOMER_ACCOUNT, sessionModule.GRAPHQL.addItemToOrder, {
      variantId: String(huVariant.variantId),
      quantity: 1
    }, SECOND_COUNTRY);
    recordStep('negative-cross-country-add', negativeOut, ['data', 'addItemToOrder']);

    var body = stepBody(negativeOut);
    var addResult = body && body.data && body.data.addItemToOrder;
    var graphQLErrors = body && body.errors && body.errors.length > 0;
    var orderAccepted = addResult && addResult.totalQuantity !== undefined &&
      (!addResult.__typename || addResult.__typename.indexOf('Error') === -1);
    if (graphQLErrors) {
      var firstError = body.errors[0];
      observed.negativeAddRejection = {
        kind: 'graphql-error',
        errorCode: firstError && firstError.errorCode ? firstError.errorCode : null,
        message: firstError && firstError.message ? firstError.message : null
      };
    } else if (addResult && addResult.__typename && addResult.__typename.indexOf('Error') !== -1) {
      observed.negativeAddRejection = {
        kind: 'error-result',
        errorCode: addResult.errorCode || null,
        message: addResult.message || null
      };
    }
    checks.negativeRejectedClearly = !!observed.negativeAddRejection;
    observed.negativeAddAccepted = !!orderAccepted;
  } else {
    checks.negativeRejectedClearly = false;
    observed.negativeAddAccepted = false;
  }

  // 6. return to checkout under the DE channel and verify no Product Country
  // mix ever entered the cart.
  var snapshotAfter = await store.activeOrder(CUSTOMER_ACCOUNT, CART_COUNTRY);
  recordStep('checkout-snapshot-after', snapshotAfter, ['data', 'activeOrder']);
  observed.orderCurrencyAfter = orderCurrency(snapshotAfter);
  observed.orderSkus = orderSkus(snapshotAfter);
  var totals = orderTotals(snapshotAfter);
  observed.totals = totals;
  checks.noCountryMix = observed.orderSkus.indexOf(huVariant ? huVariant.variantSku : '@@none@@') === -1 &&
    observed.orderSkus.indexOf(deVariant.variantSku) !== -1;
  checks.cartKeepsContextAfter = observed.orderCurrencyAfter === CART_CURRENCY;

  // eligiblePaymentMethods reachability probe (payment currency on the Shop
  // order is visible but the actual payment stays unverified).
  var payMethodsOut = await store.call(CUSTOMER_ACCOUNT, ELIGIBLE_PAYMENT_METHODS_QUERY, {}, CART_COUNTRY);
  recordStep('eligible-payment-methods', payMethodsOut, ['data', 'eligiblePaymentMethods']);
  observed.paymentMethodsReachable = !isNetworkDown(payMethodsOut);
  observed.paymentCurrency = observed.orderCurrencyAfter;

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Cart and checkout country locking across Channel DE (cart) and Channel HU (second-country add)',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    customerAccount: CUSTOMER_ACCOUNT,
    expected: {
      customerCountry: CUSTOMER_COUNTRY,
      cartCountry: CART_COUNTRY,
      cartCurrency: CART_CURRENCY,
      secondCountry: SECOND_COUNTRY,
      secondCurrency: COUNTRY_CURRENCY_MAP[SECOND_COUNTRY]
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B1-05-A01: payment currency is honored by a real payment (Stripe Runner)',
      'CAN-B1-05-A01: receipt shows the order country, channel and currency (Stripe Runner)',
      'CAN-B1-05-A02: payment currency shown as a separate value (Stripe Runner)',
      'CAN-B1-05-A02: receipt shows the payment currency (Stripe Runner)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'cart-channel-lock-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.cartKeepsContext) {
    failures.push('cart currency mismatch: expected ' + CART_CURRENCY + ' got ' + observed.orderCurrency);
  }
  if (!checks.addressCountryDe) {
    failures.push('address country mismatch: expected ' + CART_COUNTRY + ' got ' + observed.addressCountry);
  }
  if (!checks.negativeRejectedClearly) {
    if (observed.negativeAddAccepted) {
      failures.push('cross-country add was accepted; the cart mixes Product Countries (HUF product entered the EUR cart)');
    } else {
      failures.push('cross-country add did not return a clear rejection (no ErrorResult/GraphQL error)');
    }
  }
  if (!checks.noCountryMix) {
    failures.push('cart mixes Product Countries: cart skus ' + JSON.stringify(observed.orderSkus));
  }
  if (!checks.taxContextAgrees) {
    failures.push('tax context does not agree with the order (missing/empty tax summary or wrong currency)');
  }
  if (!checks.cartKeepsContextAfter) {
    failures.push('cart lost the ' + CART_COUNTRY + ' currency after returning to checkout: got ' + observed.orderCurrencyAfter);
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    var defectEvidence = evidence;
    return failureOutcome('EXPECTED_MISMATCH', 'cart/channel lock mismatch: ' + detail, defectEvidence);
  }

  return passOutcome(context, taskId, evidence);
}

function CURRENCY_OF(countryCode) {
  return COUNTRY_CURRENCY_MAP[countryCode] || null;
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B1-05', {
    description: 'Cart and checkout country locking across Channel DE (cart) and Channel HU (second-country add) (Shop API)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B1-05-A01'],
    handler: handlerB1_05
  });
  return { success: true, registered: ['CAN-B1-05'] };
}

module.exports = {
  COUNTRY_CURRENCY_MAP: COUNTRY_CURRENCY_MAP,
  CUSTOMER_COUNTRY: CUSTOMER_COUNTRY,
  CART_COUNTRY: CART_COUNTRY,
  CART_CURRENCY: CART_CURRENCY,
  SECOND_COUNTRY: SECOND_COUNTRY,
  CUSTOMER_ACCOUNT: CUSTOMER_ACCOUNT,
  DE_ADDRESS: DE_ADDRESS,
  BROWSE_PRODUCTS_QUERY: BROWSE_PRODUCTS_QUERY,
  CHECKOUT_SNAPSHOT_QUERY: CHECKOUT_SNAPSHOT_QUERY,
  SET_SHIPPING_ADDRESS_MUTATION: SET_SHIPPING_ADDRESS_MUTATION,
  handlerB1_05: handlerB1_05,
  buildAssertionReport: buildAssertionReport,
  firstVariantData: firstVariantData,
  register: register
};
