'use strict';

/**
 * CAN-B2-03: multiple-country publication and virtual inventory readiness check.
 *
 * CAN-B2-03 asserts the product is published to several countries, each with
 * its own price, currency and (virtual) stock, and that a purchase in one
 * country decrements that country's stock without touching the others, and
 * becomes unavailable at zero.
 *
 * The executor verifies the invariants the Shop API can prove:
 *   - product(slug) resolves in the DE/AT/HU/GB channels with per-country
 *     variants carrying priceWithTax and currencyCode (storefront queries.ts:
 *     53-112) and stockLevel (queries.ts:69-75);
 *   - addItemToOrder in the purchase country decrements the matching virtual
 *     stock by the order quantity (mutations.ts:19-42);
 *   - activeOrder keeps the country currency (COUNTRY_CURRENCY_MAP[DE]=EUR)
 *     and the design identity (line product slug) (queries.ts:114-163).
 *
 * The DB-level identity persistence claim requires admin API + direct DB
 * access, and the payment/receipt claims require the Stripe Runner. Those are
 * listed as unverified, so coverage is readiness-subset and the outcome is a
 * READINESS_PASS, never a full pass.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;

// Country codes participating in multi-country publication. Must stay aligned
// with COUNTRY_CHANNEL_TOKENS in shopApiSession (DE/AT/HU/GB).
var COUNTRIES = ['DE', 'AT', 'HU', 'GB'];

// Nominal per-country currency (from the migration-input source).
var COUNTRY_CURRENCY_MAP = { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' };

var PURCHASE_COUNTRY = 'DE';
var ORDER_QUANTITY = 1;
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Shop API product query. Field list mirrors the storefront
// GetProductBySlugQuery at queries.ts:53-112.
var MULTI_COUNTRY_PRODUCT_QUERY = [
  'query GetMultiCountryProduct($slug: String!) {',
  '  product(slug: $slug) {',
  '    id',
  '    name',
  '    slug',
  '    variants {',
  '      id',
  '      sku',
  '      priceWithTax',
  '      currencyCode',
  '      stockLevel',
  '    }',
  '    customFields {',
  '      designFee',
  '      designTemplate',
  '    }',
  '  }',
  '}'
].join('\n');

// Default product slug (override via fixtures or CAN_B2_03_PRODUCT_SLUG env).
var DEFAULT_PRODUCT_SLUG = 'fixture-1-nail-design';
var PRODUCT_SLUG_ENV = 'CAN_B2_03_PRODUCT_SLUG';

function getEnv(context) {
  return sessionModule.getEnvFn(context)();
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function envValue(context, name) {
  return sessionModule.envValue(context, name);
}

// Admin identity preflight helpers (local, mirror the established pattern).
function hasAdminCredentials(context) {
  var env = getEnv(context);
  var user = env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '';
  var pass = env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '';
  return !!(user && pass);
}

function adminCredentialEnvNames(context) {
  var env = getEnv(context);
  var names = [];
  if (env.SUPERADMIN_USERNAME) names.push('SUPERADMIN_USERNAME');
  if (env.STAGING_ADMIN_EMAIL) names.push('STAGING_ADMIN_EMAIL');
  if (env.SUPERADMIN_PASSWORD) names.push('SUPERADMIN_PASSWORD');
  if (env.STAGING_ADMIN_PASSWORD) names.push('STAGING_ADMIN_PASSWORD');
  if (env.VENDURE_ADMIN_API_URL) names.push('VENDURE_ADMIN_API_URL');
  return names;
}

// Names of the credential pair that are absent (names only, never values).
function adminCredentialEnvAbsentNames(context) {
  var CANDIDATE = ['SUPERADMIN_USERNAME', 'STAGING_ADMIN_EMAIL', 'SUPERADMIN_PASSWORD', 'STAGING_ADMIN_PASSWORD'];
  var present = adminCredentialEnvNames(context);
  var missing = [];
  for (var i = 0; i < CANDIDATE.length; i++) {
    if (present.indexOf(CANDIDATE[i]) === -1) missing.push(CANDIDATE[i]);
  }
  return missing;
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
    terminalStateName: errorCode === 'ENVIRONMENT_ERROR' ? DEPENDENCY_ENVIRONMENT :
      (errorCode === 'EXPECTED_MISMATCH' ? APPLICATION_DEFECT : CLIENT_INPUT_SCOPE),
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

function taskExpectedText(context, taskId) {
  var task = (context && context.task) || {};
  if (task.expectedResult) return task.expectedResult;
  return taskId;
}

function runIdOf(context) {
  return sessionModule.runIdOf(context);
}

function evidenceOptions(context) {
  return sessionModule.evidenceOptions(context);
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
    } catch (e) {}
  }
  var written = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

// Shape helpers for the raw call results.
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

// Normalize a raw product call result into a per-country record.
function productRow(step) {
  var product = readData(step, ['data', 'product']);
  if (!product) return { found: false, currencyCode: null, price: null, stockLevel: null, variantId: null };
  var variant = product.variants && product.variants[0];
  if (!variant) return { found: false, currencyCode: null, price: null, stockLevel: null, variantId: null };
  var stock = null;
  if (typeof variant.stockLevel === 'number') stock = variant.stockLevel;
  else if (variant.stockLevel === 'OUT_OF_STOCK') stock = 0;
  else if (variant.stockLevel === 'IN_STOCK' || variant.stockLevel === 'LOW_STOCK') stock = 1;
  return {
    found: true,
    currencyCode: variant.currencyCode || null,
    price: typeof variant.priceWithTax === 'number' ? variant.priceWithTax : null,
    stockLevel: stock,
    variantId: variant.id || null
  };
}

function buildAssertionReport(observed, checks) {
  var checkList = [
    { id: 'chk-publication', label: 'Product published to several countries (>=2)', verified: !!checks.publicationToSeveralCountries, detail: checks.publicationToSeveralCountries ? '>=2 countries resolved' : 'fewer than 2 countries resolved' },
    { id: 'chk-currencies', label: 'Per-country currency matches COUNTRY_CURRENCY_MAP', verified: !!checks.perCountryCurrenciesMatch, detail: checks.perCountryCurrenciesMatch ? 'all match' : 'currency mismatch' },
    { id: 'chk-distinct-prices', label: 'Distinct prices across countries (>=2)', verified: !!checks.distinctPrices, detail: checks.distinctPrices ? '>=2 distinct' : 'all same price' },
    { id: 'chk-virtual-stock', label: 'Virtual stock present (>=0 or OUT_OF_STOCK)', verified: !!checks.virtualStockPresent, detail: checks.virtualStockPresent ? 'stock present' : 'no virtual stock' },
    { id: 'chk-decrement', label: 'Purchase decrements correct country stock by order quantity', verified: !!checks.purchaseDecrementsCorrectStock, detail: checks.purchaseDecrementsCorrectStock ? 'decrement by 1' : 'no decrement' },
    { id: 'chk-cross', label: 'No cross-country inventory use', verified: !!checks.noCrossCountryInventoryUse, detail: checks.noCrossCountryInventoryUse ? 'untouched' : 'cross-country use' },
    { id: 'chk-zero', label: 'Unavailable at zero (stock 0 / OUT_OF_STOCK)', verified: !!checks.unavailableAtZero, detail: checks.unavailableAtZero ? 'zero found' : 'not zero' },
    { id: 'chk-identity', label: 'Order keeps country currency and design identity', verified: !!checks.orderKeepsCountryAndDesignIdentity, detail: checks.orderKeepsCountryAndDesignIdentity ? 'identity ok' : 'identity mismatch' }
  ];
  var allVerified = checkList.every(function(ch) { return ch.verified; });
  return [{
    id: 'CAN-B2-03-A01',
    label: 'Multiple-country publication and virtual inventory',
    coverage: COVERAGE_READINESS_SUBSET,
    verified: allVerified,
    checks: checkList,
    unverified: [
      { id: 'CAN-B2-03-A01', label: 'DB-level country/design identity persistence', reason: 'Requires admin API + direct DB query; not observable via Shop API alone' },
      { id: 'CAN-B2-03-A01', label: 'Payment processing (Stripe)', reason: 'Stripe payment step not in readiness-subset scope; needs the Stripe Runner' },
      { id: 'CAN-B2-03-A01', label: 'Receipt / invoice generation', reason: 'Receipt step not in readiness-subset scope' }
    ]
  }];
}

function resolveProductSlug(context) {
  if (context && context.fixtures && typeof context.fixtures.productSlug === 'string' && context.fixtures.productSlug.length > 0) {
    return context.fixtures.productSlug;
  }
  var envSlug = envValue(context, PRODUCT_SLUG_ENV);
  if (typeof envSlug === 'string' && envSlug.length > 0) {
    return envSlug;
  }
  return DEFAULT_PRODUCT_SLUG;
}

async function handlerMultiCountryPublication(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-03');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);
  var steps = [];

  function recordStep(name, out, pathArr) {
    steps.push({
      step: name,
      success: !!(out && out.success) && !isNetworkDown(out),
      errorCode: (out && out.errorCode) || null,
      data: pathArr ? readData(out, pathArr) : null
    });
  }

  // 1. Admin identity preflight: block CLIENT_INPUT_SCOPE when absent.
  if (!hasAdminCredentials(context)) {
    var absentNames = adminCredentialEnvAbsentNames(context);
    var blockEvidence = {
      taskId: taskId,
      reason: 'admin identity absent for multi-country publication check',
      preflight: {
        presentNames: adminCredentialEnvNames(context),
        absentNames: absentNames,
        source: 'env'
      },
      report: buildAssertionReport({ taskId: taskId }, {
        publicationToSeveralCountries: false,
        perCountryCurrenciesMatch: false,
        distinctPrices: false,
        virtualStockPresent: false,
        purchaseDecrementsCorrectStock: false,
        noCrossCountryInventoryUse: false,
        unavailableAtZero: false,
        orderKeepsCountryAndDesignIdentity: false
      }),
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'assertion-report.json', data: blockEvidence.report },
      { name: 'executor-error.json', data: blockEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', blockEvidence.reason, blockEvidence);
  }

  // 2. Resolve channel tokens (all four required).
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
  var tokens = tokensResult.tokens;
  var secrets = [];
  for (var sc = 0; sc < COUNTRIES.length; sc++) {
    var t = tokens[COUNTRIES[sc]];
    if (t) secrets.push(t);
  }
  var publicationToSeveralCountries = COUNTRIES.filter(function(c) { return c in tokens; }).length >= 2;

  // 3. Login as buyer in the purchase country channel.
  var loginOut = await store.login(BUYER_ACCOUNT);
  if (!loginOut.success) {
    var loginFailEvidence = {
      taskId: taskId,
      step: 'login',
      passwordEnvNames: loginOut.evidence && loginOut.evidence.passwordEnvNames,
      errCode: loginOut.errorCode,
      error: loginOut.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(loginOut, taskId, loginFailEvidence);
  }

  // 4. Query the product in each country channel.
  var rawRequests = [];
  var rawResponses = [];
  var pricesByCountry = {};
  var stockByCountry = {};
  var currenciesByCountry = {};
  var variantIds = {};
  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var productOut = await store.call(BUYER_ACCOUNT, MULTI_COUNTRY_PRODUCT_QUERY, { slug: resolveProductSlug(context) }, country);
    rawRequests.push(sessionModule.redactDeep(productOut.request, secrets));
    rawResponses.push(sessionModule.redactDeep(productOut.response, secrets));
    if (isNetworkDown(productOut)) {
      var envEvidence = {
        taskId: taskId,
        step: 'multi-country-product',
        error: 'shop-api base down: ' + (productOut.networkError || 'HTTP down'),
        country: country,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'multi-country-publication-table.json', data: { pricesByCountry: pricesByCountry, stockByCountry: stockByCountry, currenciesByCountry: currenciesByCountry } },
        { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
      ], secrets);
      return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
    }
    var gqlErrors = readData(productOut, ['errors']);
    if (gqlErrors && gqlErrors.length > 0) {
      var gqlEvidence = {
        taskId: taskId,
        step: 'multi-country-product',
        country: country,
        error: 'shop-api product query returned GraphQL errors: ' + (gqlErrors[0].message || 'unknown'),
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'executor-error.json', data: gqlEvidence, kind: 'executor-error' }
      ], secrets);
      return failureOutcome('EXPECTED_MISMATCH', gqlEvidence.error, gqlEvidence);
    }
    var row = productRow(productOut);
    pricesByCountry[country] = { country: country, found: row.found, currencyCode: row.currencyCode, price: row.price };
    stockByCountry[country] = { country: country, found: row.found, currencyCode: row.currencyCode, stockLevel: row.stockLevel };
    currenciesByCountry[country] = row.currencyCode;
    variantIds[country] = row.variantId;
  }

  // 5. Assertion checks (pre-purchase state).
  var checks = {};
  checks.publicationToSeveralCountries = COUNTRIES.filter(function(c) { return tokens[c]; }).length >= 2;
  checks.perCountryCurrenciesMatch = COUNTRIES.every(function(c) {
    return !tokens[c] || currenciesByCountry[c] === COUNTRY_CURRENCY_MAP[c];
  });
  var numericPrices = [];
  COUNTRIES.forEach(function(c) {
    if (pricesByCountry[c].found && typeof pricesByCountry[c].price === 'number') numericPrices.push(pricesByCountry[c].price);
  });
  checks.distinctPrices = new Set(numericPrices).size >= 2;
  checks.virtualStockPresent = COUNTRIES.some(function(c) {
    return stockByCountry[c].found && stockByCountry[c].stockLevel >= 0;
  });

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: rawResponses }, kind: 'api-response' },
    { name: 'multi-country-publication-table.json', data: { pricesByCountry: pricesByCountry, stockByCountry: stockByCountry, currenciesByCountry: currenciesByCountry, perCountryCurrenciesMatch: checks.perCountryCurrenciesMatch, distinctPrices: checks.distinctPrices, virtualStockPresent: checks.virtualStockPresent } }
  ], secrets);

  if (!checks.publicationToSeveralCountries || !checks.perCountryCurrenciesMatch || !checks.distinctPrices || !checks.virtualStockPresent) {
    var tableFailEvidence = {
      taskId: taskId,
      reason: 'multi-country publication assertions failed (resolution/currency/distinct-price/virtual-stock)',
      checks: checks,
      pricesByCountry: pricesByCountry,
      stockByCountry: stockByCountry,
      currenciesByCountry: currenciesByCountry,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'expected-vs-actual.json', data: { expected: { publications: true, currencies: COUNTRY_CURRENCY_MAP, prices: '>=2 distinct', virtualStock: true }, actual: { publications: checks.publicationToSeveralCountries, currencies: checks.perCountryCurrenciesMatch, distinctPrices: checks.distinctPrices, virtualStock: checks.virtualStockPresent } } },
      { name: 'executor-error.json', data: tableFailEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', tableFailEvidence.reason, tableFailEvidence);
  }

  // 6. Place the order in the purchase country.
  var deVariantId = variantIds[PURCHASE_COUNTRY];
  var addOut = deVariantId
    ? await store.addItemToOrder(BUYER_ACCOUNT, deVariantId, ORDER_QUANTITY, PURCHASE_COUNTRY)
    : null;
  recordStep('add-to-order', addOut, ['data', 'addItemToOrder']);
  checks.orderCreated = !!(addOut && addOut.success);

  // 7. Re-read each country after purchase to observe the stock delta.
  var stockAfterPurchase = {};
  for (var k = 0; k < COUNTRIES.length; k++) {
    var c2 = COUNTRIES[k];
    var afterOut = await store.call(BUYER_ACCOUNT, MULTI_COUNTRY_PRODUCT_QUERY, { slug: resolveProductSlug(context) }, c2);
    rawRequests.push(sessionModule.redactDeep(afterOut.request, secrets));
    rawResponses.push(sessionModule.redactDeep(afterOut.response, secrets));
    var afterRow = productRow(afterOut);
    stockAfterPurchase[c2] = afterRow.found ? afterRow.stockLevel : null;
  }

  // 8. Stock-delta assertions.
  var before = stockByCountry[PURCHASE_COUNTRY].found ? stockByCountry[PURCHASE_COUNTRY].stockLevel : null;
  var after = stockAfterPurchase[PURCHASE_COUNTRY];
  checks.purchaseDecrementsCorrectStock = typeof before === 'number' && typeof after === 'number' && (before - after) === ORDER_QUANTITY;
  checks.noCrossCountryInventoryUse = COUNTRIES.filter(function(c) { return c !== PURCHASE_COUNTRY; }).every(function(c) {
    return stockAfterPurchase[c] === stockByCountry[c].stockLevel;
  });
  checks.unavailableAtZero = COUNTRIES.some(function(c) { return stockAfterPurchase[c] === 0; });

  var stockDelta = {};
  COUNTRIES.forEach(function(c) {
    var b = stockByCountry[c].found ? stockByCountry[c].stockLevel : null;
    var a = stockAfterPurchase[c];
    stockDelta[c] = (typeof b === 'number' && typeof a === 'number') ? (a - b) : null;
  });
  var zeroStockCountry = null;
  for (var zi = 0; zi < COUNTRIES.length; zi++) {
    if (stockAfterPurchase[COUNTRIES[zi]] === 0) { zeroStockCountry = COUNTRIES[zi]; break; }
  }

  // 9. Active order keeps country currency + design identity.
  var orderOut = await store.activeOrder(BUYER_ACCOUNT, PURCHASE_COUNTRY);
  recordStep('active-order', orderOut, ['data', 'activeOrder']);
  var orderCurrency = readData(orderOut, ['data', 'activeOrder', 'currencyCode']);
  var orderLineSlug = readData(orderOut, ['data', 'activeOrder', 'lines', 0, 'productVariant', 'product', 'slug']);
  checks.orderKeepsCountryAndDesignIdentity = !!addOut && addOut.success && orderCurrency === COUNTRY_CURRENCY_MAP[PURCHASE_COUNTRY] && orderLineSlug === resolveProductSlug(context);

  var observed = {
    taskId: taskId,
    productSlug: resolveProductSlug(context),
    buyerAccount: BUYER_ACCOUNT,
    purchaseCountry: PURCHASE_COUNTRY,
    orderQuantity: ORDER_QUANTITY,
    pricesByCountry: pricesByCountry,
    stockByCountry: stockByCountry,
    stockAfterPurchase: stockAfterPurchase,
    postPurchaseStock: stockAfterPurchase,
    stockDeltaByCountry: stockDelta,
    zeroStockCountry: zeroStockCountry,
    currenciesByCountry: currenciesByCountry,
    orderCurrency: orderCurrency,
    orderLineSlug: orderLineSlug
  };
  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Multiple-country publication and virtual inventory',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    productSlug: resolveProductSlug(context),
    buyerAccount: BUYER_ACCOUNT,
    purchaseCountry: PURCHASE_COUNTRY,
    expected: {
      publications: '>=2 countries',
      currencies: COUNTRY_CURRENCY_MAP,
      prices: '>=2 distinct prices',
      virtualStock: 'stockLevel >=0 or OUT_OF_STOCK',
      purchaseDecrement: 'decrements ' + PURCHASE_COUNTRY + ' stock by ' + ORDER_QUANTITY,
      noCrossCountryUse: 'other countries untouched',
      zeroStock: 'unavailable at zero',
      orderIdentity: 'order currency ' + COUNTRY_CURRENCY_MAP[PURCHASE_COUNTRY] + ' and line product slug',
      unverified: 'DB-level identity (admin/DB) + payment/receipt (Stripe Runner)'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    unverified: assertionReport.unverified,
    steps: steps,
    rawRequests: rawRequests,
    rawResponses: rawResponses,
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: rawResponses }, kind: 'api-response' },
    { name: 'multi-country-publication-table.json', data: { pricesByCountry: pricesByCountry, stockByCountry: stockByCountry, stockAfterPurchase: stockAfterPurchase, currenciesByCountry: currenciesByCountry, perCountryCurrenciesMatch: checks.perCountryCurrenciesMatch, distinctPrices: checks.distinctPrices, virtualStockPresent: checks.virtualStockPresent } },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'expected-vs-actual' },
    { name: 'assertion-report.json', data: assertionReport },
    { name: 'executor-summary.json', data: { taskId: taskId, title: evidence.title, shopApiBase: evidence.shopApiBase, productSlug: evidence.productSlug, buyerAccount: evidence.buyerAccount, purchaseCountry: evidence.purchaseCountry, checks: checks, unverified: assertionReport.unverified, steps: steps, completedAt: timestamp } }
  ], secrets);

  if (!checks.publicationToSeveralCountries || !checks.perCountryCurrenciesMatch || !checks.distinctPrices ||
      !checks.virtualStockPresent || !checks.purchaseDecrementsCorrectStock || !checks.noCrossCountryInventoryUse ||
      !checks.unavailableAtZero || !checks.orderKeepsCountryAndDesignIdentity) {
    var defectEvidence = {
      taskId: taskId,
      title: evidence.title,
      reason: 'multi-country publication / virtual inventory mismatch',
      checks: checks,
      observed: observed,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: defectEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', defectEvidence.reason + ': ' + JSON.stringify(checks), defectEvidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-03', {
    description: 'Multiple-country publication and virtual inventory (CAN-B2-03): product published to several countries with per-country price, currency and virtual stock; purchase decrements the correct country stock with no cross-country inventory use; order keeps country and design identity (readiness scope)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-03-A01'],
    handler: handlerMultiCountryPublication
  });
  return { success: true, registered: ['CAN-B2-03'] };
}

module.exports = {
  COUNTRIES: COUNTRIES,
  COUNTRY_CURRENCY_MAP: COUNTRY_CURRENCY_MAP,
  PURCHASE_COUNTRY: PURCHASE_COUNTRY,
  ORDER_QUANTITY: ORDER_QUANTITY,
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  DEFAULT_PRODUCT_SLUG: DEFAULT_PRODUCT_SLUG,
  PRODUCT_SLUG_ENV: PRODUCT_SLUG_ENV,
  MULTI_COUNTRY_PRODUCT_QUERY: MULTI_COUNTRY_PRODUCT_QUERY,
  resolveProductSlug: resolveProductSlug,
  hasAdminCredentials: hasAdminCredentials,
  adminCredentialEnvNames: adminCredentialEnvNames,
  handlerMultiCountryPublication: handlerMultiCountryPublication,
  buildAssertionReport: buildAssertionReport,
  productRow: productRow,
  register: register
};
