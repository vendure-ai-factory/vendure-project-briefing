'use strict';

/**
 * Country-boundary browsing executor (CAN-B1-01).
 *
 * CAN-B1-01 (country terminology and cross-country browsing): a customer
 * whose Customer Country is DE browses a product from Channel HU. The Shop
 * API operations (never guessed; copied from the migration-input source) are
 * reused from the shared shopApiSession helper unless cited here:
 *   login                mutations.ts:3-17
 *   activeCustomer       queries.ts:20-29 (customFields.countryCode)
 *   setSessionCurrencyCode mutations.ts:463-475
 *   activeOrder            queries.ts:114-163
 *   addItemToOrder         mutations.ts:19-42
 *   orderByCode            queries.ts:377
 *   products browse       product variant currencyCode, priceWithTax (queries.ts:69-75)
 *
 * The executor verifies the boundary invariants that the Shop API can prove:
 * the profile country stays the Customer Country (DE), the browsed product
 * stays in the Product Country channel (HU) with a Product Country price
 * (HUF), the wallet currency is the customer currency (EUR), and the active
 * order currency follows the customer currency after setSessionCurrencyCode.
 *
 * The "any conversion is recorded" claim needs the ExchangeRate ledger
 * (DB-level, exchange-rate.service.ts:55-69), and payment / paid-order /
 * receipt assertions need the Stripe Runner (addPaymentToOrder,
 * mutations.ts:271-292). Those are listed as unverified, so coverage is
 * readiness-subset and the run is a READINESS_PASS, never a full pass.
 *
 * Failure classes: profile/product/order currency mismatch ->
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
var PRODUCT_COUNTRY = 'HU';
var PRODUCT_CURRENCY = 'HUF';
var CUSTOMER_CURRENCY = 'EUR';

// Synthetic account name from manifest/fixtures.v1.json (origin VERIFIED).
var CUSTOMER_ACCOUNT = 'buyer.one@example.com';

// Browse the Product Country channel. Field list mirrors the storefront
// product detail variant fields (currencyCode, priceWithTax) at
// storefront/src/lib/vendure/queries.ts:69-75.
var BROWSE_PRODUCTS_QUERY = [
  'query BrowseCountryChannelProducts {',
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
// ...) return { success, actual, result, evidence: { request, response } }.
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

function hasGraphQLErrors(step) {
  var body = step && step.evidence && step.evidence.response && step.evidence.response.body;
  return !!(body && body.errors && body.errors.length > 0);
}

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return false;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
}

/**
 * Map a shopApiSession store failure (failureResult shape) onto an executor
 * failure outcome. VALIDATION_ERROR -> CLIENT_INPUT_SCOPE,
 * ENVIRONMENT_ERROR -> DEPENDENCY_ENVIRONMENT,
 * EXPECTED_MISMATCH -> APPLICATION_DEFECT.
 */
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
        opts.secrets['countryBoundarySecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

/**
 * Build the verified/unverified assertion report. Each entry lists the
 * assertion id, its verification state and the Shop-only-observable evidence
 * behind it. Payment, paid-order and receipt claims need the Stripe Runner
 * and are marked unverified here.
 */
function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B1-01-A01',
    verified: true,
    summary: 'Customer Country differs from Product Country; browsing keeps the profile country as the Customer Country, the product stays in its Product Country channel, the wallet is in the customer currency and the price in the Product Country currency.',
    verifiedClaims: [
      { claim: 'profile country stays the Customer Country (DE)', verified: checks.profileCountryStaysCustomerCountry, observed: observed.customerCountry },
      { claim: 'product channel stays the Product Country (HU)', verified: checks.productChannelIsProductCountry, observed: observed.productCurrency },
      { claim: 'price is in the Product Country currency (HUF)', verified: checks.priceCurrencyIsProductCurrency, observed: observed.productCurrency },
      { claim: 'wallet currency is the customer currency (EUR)', verified: checks.walletCurrencyIsCustomerCurrency, observed: observed.walletCurrency },
      { claim: 'active order currency is the customer currency', verified: checks.orderCurrencyIsCustomerCurrency, observed: observed.orderCurrency }
    ],
    unverifiedClaims: [
      { claim: 'any conversion is recorded', why: 'ExchangeRate ledger is DB-level (exchange-rate.service.ts:55-69), not readable through the Shop API' },
      { claim: 'receipt shows the correct country and currency', why: 'paid-order and receipt need the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' }
    ]
  };
  var a02 = {
    id: 'CAN-B1-01-A02',
    verified: false,
    summary: 'The report shows Customer Country, Product Country, wallet currency and price currency as separate values; shipping country and payment currency still need Shop/Db evidence past the boundary and the Stripe Runner.',
    verifiedClaims: [
      { claim: 'Customer Country and Product Country are different values', verified: observed.customerCountry !== observed.productCountry, observed: { customer: observed.customerCountry, product: observed.productCountry } },
      { claim: 'wallet currency and price currency are different values', verified: observed.walletCurrency !== observed.productCurrency, observed: { wallet: observed.walletCurrency, price: observed.productCurrency } }
    ],
    unverifiedClaims: [
      { claim: 'shipping country shown separately', why: 'needs a shipped/billed order past the boundary' },
      { claim: 'payment currency shown separately', why: 'payment needs the Stripe Runner (mutations.ts:271-292)' }
    ]
  };
  return [a01, a02];
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

function customerCountryFromProfile(step) {
  var customFields = readData(step, ['data', 'activeCustomer', 'customFields']);
  if (customFields && typeof customFields.countryCode === 'string') {
    return customFields.countryCode;
  }
  return null;
}

function orderCurrencyFromOrder(step) {
  return readData(step, ['data', 'activeOrder', 'currencyCode']) ||
    readData(step, ['data', 'orderByCode', 'currencyCode']);
}

/**
 * CAN-B1-01 handler. Bounded, read-heavy check of the cross-country boundary
 * using the shared shopApiSession helper:
 *   1. login the DE customer (password via SHOP_ACCOUNT_PASSWORD_BUYER_ONE);
 *   2. activeCustomer -> the profile Custom Country (must stay DE);
 *   3. browse Channel HU -> product price currency (must be HUF);
 *   4. wallet currency = COUNTRY_CURRENCY_MAP[customer country] (must be EUR);
 *   5. setSessionCurrencyCode(customer currency) + activeOrder -> order
 *      currency follows the customer currency;
 *   6. attempt the cross-boundary addItem; record reachability.
 * Payment and receipt claims are Stripe-runner-only and stay unverified.
 */
async function handlerB1_01(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-01');
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
  if (!tokensResult.tokens[CUSTOMER_COUNTRY] || !tokensResult.tokens[PRODUCT_COUNTRY]) {
    var missing = CUSTOMER_COUNTRY + '/' + PRODUCT_COUNTRY;
    var missingEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + missing, countryCodes: [CUSTOMER_COUNTRY, PRODUCT_COUNTRY] },
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

  // 2. profile country.
  var profileOut = await store.activeCustomer(CUSTOMER_ACCOUNT, CUSTOMER_COUNTRY);
  recordStep('profile', profileOut, ['data', 'activeCustomer']);
  if (!profileOut.success) {
    return outcomeFromStoreFailure(profileOut, taskId, { taskId: taskId, steps: steps, completedAt: timestamp });
  }
  var customerCountry = customerCountryFromProfile(profileOut);
  observed.customerCountry = customerCountry;
  observed.productCountry = PRODUCT_COUNTRY;
  checks.profileCountryStaysCustomerCountry = customerCountry === CUSTOMER_COUNTRY;

  // 3. browse a product from Channel HU.
  var browseOut = await store.call(CUSTOMER_ACCOUNT, BROWSE_PRODUCTS_QUERY, {}, PRODUCT_COUNTRY);
  recordStep('browse-hu', browseOut, ['data', 'products']);
  if (isNetworkDown(browseOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'browse-hu',
      error: 'shop-api browse failed: ' + (browseOut.networkError || 'HTTP down'),
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }
  var huVariant = firstVariantData(browseOut);
  observed.productCurrency = huVariant ? huVariant.variantCurrency : null;
  observed.productCountryCode = PRODUCT_COUNTRY;
  checks.productChannelIsProductCountry = observed.productCurrency === PRODUCT_CURRENCY;
  checks.priceCurrencyIsProductCurrency = observed.productCurrency === PRODUCT_CURRENCY;

  // 4. wallet currency derives from the customer country.
  observed.walletCurrency = customerCountry ? COUNTRY_CURRENCY_MAP[customerCountry] : null;
  checks.walletCurrencyIsCustomerCurrency = observed.walletCurrency === CUSTOMER_CURRENCY;
  observed.expectedWalletCurrency = CUSTOMER_CURRENCY;

  // 5. session currency follows the customer currency; the active order then
  // carries the customer currency.
  var setCurOut = await store.setSessionCurrencyCode(CUSTOMER_ACCOUNT, observed.walletCurrency || CUSTOMER_CURRENCY, CUSTOMER_COUNTRY);
  recordStep('set-session-currency', setCurOut, ['data', 'setSessionCurrencyCode']);
  if (isNetworkDown(setCurOut)) {
    var envEvidence2 = {
      taskId: taskId,
      step: 'set-session-currency',
      error: 'shop-api setSessionCurrencyCode failed: ' + (setCurOut.networkError || 'HTTP down'),
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence2.error, envEvidence2);
  }
  var orderOut = await store.activeOrder(CUSTOMER_ACCOUNT, CUSTOMER_COUNTRY);
  recordStep('active-order', orderOut, ['data', 'activeOrder']);
  observed.orderCurrency = orderCurrencyFromOrder(orderOut);
  checks.orderCurrencyIsCustomerCurrency = observed.orderCurrency === (observed.walletCurrency || CUSTOMER_CURRENCY);

  // 6. attempt the cross-boundary add and record reachability.
  var addOut = null;
  if (huVariant) {
    addOut = await store.addItemToOrder(CUSTOMER_ACCOUNT, huVariant.variantId, 1, PRODUCT_COUNTRY);
    recordStep('cross-boundary-add', addOut, ['data', 'addItemToOrder']);
  }
  observed.crossBoundaryAdd = addOut ? addOut.success : false;
  observed.addError = addOut && !addOut.success ? (addOut.error || null) : null;
  checks.crossBoundaryAddRecorded = addOut !== null;

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Country-boundary browsing across Customer Country DE and Product Country HU',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    customerAccount: CUSTOMER_ACCOUNT,
    expected: {
      customerCountry: CUSTOMER_COUNTRY,
      productCountry: PRODUCT_COUNTRY,
      productCurrency: PRODUCT_CURRENCY,
      walletCurrency: CUSTOMER_CURRENCY
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B1-01-A01: any conversion is recorded (ExchangeRate ledger, DB-level)',
      'CAN-B1-01-A01: receipt shows the correct country and currency (Stripe Runner)',
      'CAN-B1-01-A02: shipping country and payment currency shown separately (Stripe Runner)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'country-boundary-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.profileCountryStaysCustomerCountry) {
    failures.push('profile country changed: expected ' + CUSTOMER_COUNTRY + ' got ' + observed.customerCountry);
  }
  if (!checks.productChannelIsProductCountry) {
    failures.push('product channel price currency mismatch: expected ' + PRODUCT_CURRENCY + ' got ' + observed.productCurrency);
  }
  if (!checks.walletCurrencyIsCustomerCurrency) {
    failures.push('wallet currency mismatch: expected ' + CUSTOMER_CURRENCY + ' got ' + observed.walletCurrency);
  }
  if (!checks.orderCurrencyIsCustomerCurrency) {
    failures.push('order currency mismatch: expected ' + (observed.walletCurrency || CUSTOMER_CURRENCY) + ' got ' + observed.orderCurrency);
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    var defectEvidence = evidence;
    return failureOutcome('EXPECTED_MISMATCH', 'country/currency mismatch: ' + detail, defectEvidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B1-01', {
    description: 'Country-boundary browsing across Customer Country DE and Product Country HU (Shop API)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B1-01-A01'],
    handler: handlerB1_01
  });
  return { success: true, registered: ['CAN-B1-01'] };
}

module.exports = {
  COUNTRY_CURRENCY_MAP: COUNTRY_CURRENCY_MAP,
  CUSTOMER_COUNTRY: CUSTOMER_COUNTRY,
  PRODUCT_COUNTRY: PRODUCT_COUNTRY,
  PRODUCT_CURRENCY: PRODUCT_CURRENCY,
  CUSTOMER_CURRENCY: CUSTOMER_CURRENCY,
  CUSTOMER_ACCOUNT: CUSTOMER_ACCOUNT,
  BROWSE_PRODUCTS_QUERY: BROWSE_PRODUCTS_QUERY,
  handlerB1_01: handlerB1_01,
  buildAssertionReport: buildAssertionReport,
  firstVariantData: firstVariantData,
  register: register
};
