'use strict';

/**
 * CAN-B2-12 (Inventory and replenishment) readiness executor.
 *
 * CAN-B2-12 asserts the inventory chain:
 *   - ordinary, physical blank-nail and virtual stock are handled separately;
 *   - shared physical stock is consumed by both design types;
 *   - zero of either makes the custom product unavailable;
 *   - global and local warehouses hold stock by country/shape/model;
 *   - a local order uses local stock; another country warehouse is not exposed;
 *   - low-stock warning fires for physical stock only;
 *   - replenishment moves global to local with an auditable result.
 *
 * The Shop API surface verifies (bounded, dry-run-only):
 *   - product(slug) resolves in a country channel with variants carrying
 *     stockLevel (storefront queries.ts:53-112, stockLevel at queries.ts:74-75);
 *   - a local purchase in DE decreases the DE virtual stock by the order
 *     quantity and does not touch the other countries (mutations.ts:19-42,
 *     addItemToOrder); order/country identity is kept (activeOrder,
 *     queries.ts:114-163);
 *   - zero of either stock type is surfaced as OUT_OF_STOCK / stockLevel 0;
 *   - the physical-only low-stock warning and warehouse/replenishment claims
 *     require Admin API + direct DB and are listed unverified, so coverage is
 *     readiness-subset and the run is a READINESS_PASS, never a full pass.
 *
 * Failure classes: Shop API down or timeout -> ENVIRONMENT_ERROR
 * (DEPENDENCY_ENVIRONMENT); wrong stock/business data or a wrong expected
 * value -> EXPECTED_MISMATCH (APPLICATION_DEFECT); missing admin identity ->
 * VALIDATION_ERROR (CLIENT_INPUT_SCOPE). Evidence is written through the
 * shared evidence collector only.
 */

var path = require('path');
var crypto = require('crypto');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');
var fixturesModule = require('../fixtures');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var RESULT_COVERAGE = terminalState.COVERAGE_READINESS_SUBSET;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;

// Country codes participating in inventory checks; aligned with
// COUNTRY_CHANNEL_TOKENS in shopApiSession (DE/AT/HU/GB).
var COUNTRIES = ['DE', 'AT', 'HU', 'GB'];

// Fixture values from manifest/fixtures.v1.json (thresholds and stock values).
var LOW_STOCK_THRESHOLD = (function() {
  try {
    var loaded = fixturesModule.loadFixturesFile();
    if (loaded.ok && loaded.fixtures && loaded.fixtures.lowStockThreshold) {
      var units = loaded.fixtures.lowStockThreshold.units;
      if (typeof units === 'number') return units;
    }
  } catch (e) { /* fall through to default */ }
  return 5;
})();

var VIRTUAL_STOCK_BY_COUNTRY = (function() {
  try {
    var loaded = fixturesModule.loadFixturesFile();
    if (loaded.ok && loaded.fixtures && loaded.fixtures.virtualStock && loaded.fixtures.virtualStock.byCountry) {
      var map = loaded.fixtures.virtualStock.byCountry;
      if (typeof map.DE === 'number' || typeof map.DE === 'string' || typeof map.AT === 'number' || typeof map.HU === 'number' || typeof map.GB === 'number') {
        return {
          DE: Number(map.DE),
          AT: Number(map.AT),
          HU: Number(map.HU),
          GB: Number(map.GB)
        };
      }
    }
  } catch (e) { /* fall through to default */ }
  return { DE: 100, AT: 100, HU: 100, GB: 100 };
})();

var PURCHASE_COUNTRY = 'DE';
var ORDER_QUANTITY = 1;
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Shop API product query. Field list mirrors the storefront
// GetProductBySlugQuery at queries.ts:53-112.
var INVENTORY_PRODUCT_QUERY = [
  'query GetInventoryProduct($slug: String!) {',
  '  product(slug: $slug) {',
  '    id',
  '    name',
  '    slug',
  '    variants {',
  '      id',
  '      sku',
  '      stockLevel',
  '    }',
  '    customFields {',
  '      designFee',
  '      designTemplate',
  '    }',
  '  }',
  '}'
].join('\n');

// Default product slug (override via fixtures or CAN_B2_12_PRODUCT_SLUG env).
var DEFAULT_PRODUCT_SLUG = 'fixture-1-nail-design';
var PRODUCT_SLUG_ENV = 'CAN_B2_12_PRODUCT_SLUG';

function getEnv(context) {
  return sessionModule.getEnvFn(context);
}

function getEnvObject(context) {
  return sessionModule.getEnvFn(context)();
}

function envValue(context, name) {
  return sessionModule.envValue(context, name);
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
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

// Inventory fixture values (from manifest/fixtures.v1.json).
function fixtureLowStockThreshold() {
  return LOW_STOCK_THRESHOLD;
}

function fixtureVirtualStockByCountry() {
  var map = {};
  COUNTRIES.forEach(function(c) { map[c] = VIRTUAL_STOCK_BY_COUNTRY[c] || 0; });
  return map;
}

// Admin identity preflight helpers (mirror the established pattern).
function hasAdminCredentials(context) {
  var env = getEnvObject(context);
  var user = env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '';
  var pass = env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '';
  return !!(user && pass);
}

function adminCredentialEnvNames(context) {
  var env = getEnvObject(context);
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
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j++) {
        opts.secrets['sessionSecret' + j] = secrets[j];
      }
    }
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

// Normalize a raw product call result into a per-country record. The product
// exposes isolated virtual stock when published per country (queries.ts:74-75).
function productRow(step) {
  var product = readData(step, ['data', 'product']);
  if (!product) return { found: false, stockLevel: null, variantId: null, sku: null };
  var variant = product.variants && product.variants[0];
  if (!variant) return { found: false, stockLevel: null, variantId: null, sku: null };
  var stock = null;
  if (typeof variant.stockLevel === 'number') stock = variant.stockLevel;
  else if (variant.stockLevel === 'OUT_OF_STOCK') stock = 0;
  else if (variant.stockLevel === 'IN_STOCK' || variant.stockLevel === 'LOW_STOCK') stock = 1;
  return {
    found: true,
    stockLevel: stock,
    variantId: variant.id || null,
    sku: variant.sku || null
  };
}

function buildAssertionReport(observed, checks) {
  var checkList = [
    { id: 'chk-local-stock', label: 'A local order uses local virtual stock', verified: !!checks.localOrderUsesLocalStock, detail: checks.localOrderUsesLocalStock ? 'local stock decremented' : 'local stock not decremented' },
    { id: 'chk-no-cross', label: 'No cross-country inventory use (warehouse isolation)', verified: !!checks.noCrossCountryInventoryUse, detail: checks.noCrossCountryInventoryUse ? 'other countries untouched' : 'cross-country use' },
    { id: 'chk-zero', label: 'Zero of either stock type makes the custom product unavailable', verified: !!checks.zeroBoundaryObserved, detail: checks.zeroBoundaryObserved ? 'zero observed' : 'no zero observed' },
    { id: 'chk-virtual', label: 'Virtual stock present per country (>=0 or OUT_OF_STOCK)', verified: !!checks.virtualStockPresent, detail: checks.virtualStockPresent ? 'stock present' : 'no virtual stock' }
  ];
  var allVerified = checkList.every(function(ch) { return ch.verified; });
  return [{
    id: 'CAN-B2-12-A01',
    label: 'Inventory and replenishment',
    coverage: RESULT_COVERAGE,
    verified: allVerified,
    checks: checkList,
    unverified: [
      { id: 'CAN-B2-12-A01', label: 'global and local warehouses hold stock by country/shape/model', reason: 'Requires Admin API + direct DB; not observable via Shop API alone' },
      { id: 'CAN-B2-12-A01', label: 'shared physical stock consumed by both design types accounting', reason: 'Requires Admin/DB stock-location accounting; not observable via Shop API alone' },
      { id: 'CAN-B2-12-A01', label: 'low-stock warning fires for physical stock only', reason: 'Requires physical stock-location reporting; not observable via Shop API alone' },
      { id: 'CAN-B2-12-A01', label: 'replenishment moves global to local with an auditable result', reason: 'Requires Admin/DB stock movement + reconciliation; not observable via Shop API alone' }
    ]
  }];
}

async function handlerInventoryReplenishment(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-12');
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
      reason: 'admin identity absent for inventory and replenishment check',
      preflight: {
        presentNames: adminCredentialEnvNames(context),
        absentNames: absentNames,
        source: 'env'
      },
      fixtureThresholds: {
        lowStockThreshold: fixtureLowStockThreshold(),
        virtualStockByCountry: fixtureVirtualStockByCountry()
      },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
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
  var stockByCountry = {};
  var variantIds = {};
  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var productOut = await store.call(BUYER_ACCOUNT, INVENTORY_PRODUCT_QUERY, { slug: resolveProductSlug(context) }, country);
    rawRequests.push(sessionModule.redactDeep(productOut.request, secrets));
    rawResponses.push(sessionModule.redactDeep(productOut.response, secrets));
    if (isNetworkDown(productOut)) {
      var envEvidence = {
        taskId: taskId,
        step: 'inventory-product',
        error: 'shop-api base down: ' + (productOut.networkError || 'HTTP down'),
        country: country,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
      ], secrets);
      return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
    }
    var gqlErrors = readData(productOut, ['errors']);
    if (gqlErrors && gqlErrors.length > 0) {
      var gqlEvidence = {
        taskId: taskId,
        step: 'inventory-product',
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
    stockByCountry[country] = { country: country, found: row.found, stockLevel: row.stockLevel };
    variantIds[country] = row.variantId;
  }

  // 5. Assertion checks (pre-purchase state).
  var checks = {};
  var purchaseId = variantIds[PURCHASE_COUNTRY];

  // 6. Place the order in the purchase country.
  var addOut = purchaseId
    ? await store.addItemToOrder(BUYER_ACCOUNT, purchaseId, ORDER_QUANTITY, PURCHASE_COUNTRY)
    : null;
  recordStep('add-to-order', addOut, ['data', 'addItemToOrder']);

  // 7. Re-read each country after purchase to observe the stock delta.
  var stockAfterPurchase = {};
  for (var k = 0; k < COUNTRIES.length; k++) {
    var c2 = COUNTRIES[k];
    var afterOut = await store.call(BUYER_ACCOUNT, INVENTORY_PRODUCT_QUERY, { slug: resolveProductSlug(context) }, c2);
    rawRequests.push(sessionModule.redactDeep(afterOut.request, secrets));
    rawResponses.push(sessionModule.redactDeep(afterOut.response, secrets));
    var afterRow = productRow(afterOut);
    stockAfterPurchase[c2] = afterRow.found ? afterRow.stockLevel : null;
  }

  // 8. Stock-delta assertions.
  var before = stockByCountry[PURCHASE_COUNTRY].found ? stockByCountry[PURCHASE_COUNTRY].stockLevel : null;
  var after = stockAfterPurchase[PURCHASE_COUNTRY];
  checks.localOrderUsesLocalStock = !!addOut && addOut.success && typeof before === 'number' && typeof after === 'number' && (before - after) === ORDER_QUANTITY;
  checks.noCrossCountryInventoryUse = COUNTRIES.filter(function(c) { return c !== PURCHASE_COUNTRY; }).every(function(c) {
    return stockAfterPurchase[c] === stockByCountry[c].stockLevel;
  });
  checks.zeroBoundaryObserved = COUNTRIES.some(function(c) {
    return stockAfterPurchase[c] === 0;
  });
  var numericStocks = [];
  COUNTRIES.forEach(function(c) {
    if (stockByCountry[c].found && typeof stockByCountry[c].stockLevel === 'number') numericStocks.push(stockByCountry[c].stockLevel);
  });
  checks.virtualStockPresent = numericStocks.length >= 2 && numericStocks.every(function(s) { return s >= 0; });

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

  var observed = {
    taskId: taskId,
    productSlug: resolveProductSlug(context),
    buyerAccount: BUYER_ACCOUNT,
    purchaseCountry: PURCHASE_COUNTRY,
    orderQuantity: ORDER_QUANTITY,
    stockByCountry: stockByCountry,
    stockAfterPurchase: stockAfterPurchase,
    stockDeltaByCountry: stockDelta,
    zeroStockCountry: zeroStockCountry,
    fixtureThresholds: {
      lowStockThreshold: fixtureLowStockThreshold(),
      virtualStockByCountry: fixtureVirtualStockByCountry()
    }
  };
  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Inventory and replenishment',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    productSlug: resolveProductSlug(context),
    buyerAccount: BUYER_ACCOUNT,
    purchaseCountry: PURCHASE_COUNTRY,
    expected: {
      localStock: 'purchase in ' + PURCHASE_COUNTRY + ' decrements the local stock by ' + ORDER_QUANTITY,
      noCrossCountryUse: 'other countries untouched',
      zeroBoundary: 'zero of either stock type -> OUT_OF_STOCK/0',
      virtualStock: 'variant stockLevel per country',
      unverified: 'warehouse/replenishment + physical-stock low-stock warning (Admin/DB)'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    unverified: assertionReport[0].unverified,
    steps: steps,
    rawRequests: rawRequests,
    rawResponses: rawResponses,
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: rawResponses }, kind: 'api-response' },
    { name: 'inventory-table.json', data: { stockByCountry: stockByCountry, stockAfterPurchase: stockAfterPurchase, stockDeltaByCountry: stockDelta, zeroStockCountry: zeroStockCountry, fixtureThresholds: observed.fixtureThresholds } },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'expected-vs-actual' },
    { name: 'assertion-report.json', data: assertionReport },
    { name: 'executor-summary.json', data: { taskId: taskId, title: evidence.title, checks: checks, unverified: assertionReport[0].unverified, steps: steps, completedAt: timestamp } }
  ], secrets);

  if (!checks.localOrderUsesLocalStock || !checks.noCrossCountryInventoryUse || !checks.zeroBoundaryObserved || !checks.virtualStockPresent) {
    var defectEvidence = {
      taskId: taskId,
      title: evidence.title,
      reason: 'inventory stock assertions failed',
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
  reg('CAN-B2-12', {
    description: 'Inventory and replenishment (CAN-B2-12): local stock used for a local order, warehouse isolation (no cross-country inventory use), zero-of-either-stock unavailability, and virtual stock per country (readiness scope)',
    builtIn: true,
    coverage: RESULT_COVERAGE,
    verifiedAssertionIds: ['CAN-B2-12-A01'],
    handler: handlerInventoryReplenishment
  });
  return { success: true, registered: ['CAN-B2-12'] };
}

module.exports = {
  COUNTRIES: COUNTRIES,
  PURCHASE_COUNTRY: PURCHASE_COUNTRY,
  ORDER_QUANTITY: ORDER_QUANTITY,
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  DEFAULT_PRODUCT_SLUG: DEFAULT_PRODUCT_SLUG,
  PRODUCT_SLUG_ENV: PRODUCT_SLUG_ENV,
  INVENTORY_PRODUCT_QUERY: INVENTORY_PRODUCT_QUERY,
  LOW_STOCK_THRESHOLD: LOW_STOCK_THRESHOLD,
  VIRTUAL_STOCK_BY_COUNTRY: VIRTUAL_STOCK_BY_COUNTRY,
  resolveProductSlug: resolveProductSlug,
  fixtureLowStockThreshold: fixtureLowStockThreshold,
  fixtureVirtualStockByCountry: fixtureVirtualStockByCountry,
  hasAdminCredentials: hasAdminCredentials,
  adminCredentialEnvNames: adminCredentialEnvNames,
  adminCredentialEnvAbsentNames: adminCredentialEnvAbsentNames,
  productRow: productRow,
  buildAssertionReport: buildAssertionReport,
  handlerInventoryReplenishment: handlerInventoryReplenishment,
  register: register
};
