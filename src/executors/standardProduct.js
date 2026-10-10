'use strict';

/**
 * Standard-product flow executor (CAN-B2-05).
 *
 * CAN-B2-05 (standard product flow): a standard product (e.g. jelly glue)
 * follows the single-price path with ordinary stock, order, receipt and
 * platform revenue, and creates no design-fee or designer-commission record.
 *
 * The executor verifies the invariants the Shop API can prove:
 *   - the ordinary-product query (product(slug)) resolves a standard product
 *     whose variant carries a single priceWithTax in the channel currency
 *     (single-price path, no design fee / craft fee split);
 *   - the variant has ordinary stock (a stockLevel that is not OUT_OF_STOCK
 *     and is a present, non-negative value);
 *   - addItemToOrder accepts the standard product into an ordinary order, and
 *     the active order carries the variant price without a design-fee line
 *     record (activeOrder line product customFields.designFee is null/0).
 *
 * The "receipt after payment", "platform revenue" and "no designer-commission
 * record" claims need the Stripe Runner (addPaymentToOrder, mutations.ts:271)
 * and DB/admin access respectively; they are listed as unverified. Coverage is
 * therefore readiness-subset and the run is a READINESS_PASS, never a full
 * pass.
 *
 * Shop API operations are copied from the migration-input storefront source
 * (never guessed):
 *   product(slug)      storefront/src/lib/vendure/queries.ts:53-112
 *                      (variants priceWithTax at 73, stockLevel at 75,
 *                       customFields designFee at 99)
 *   login              storefront/src/lib/vendure/mutations.ts:3-17
 *   addItemToOrder     storefront/src/lib/vendure/mutations.ts:19-42
 *   activeOrder        storefront/src/lib/vendure/queries.ts:114-163
 *   orderByCode        storefront/src/lib/vendure/queries.ts:377
 *   design-fee skip for standard products: docs/PROJECT_OVERVIEW_EN.md 4.3
 *   (AffiliateSubscriber skips products without a designer ID;
 *    affiliate.subscriber.ts:16-41 is the referral path, the no-commission
 *    skip for standard products is the documented rule at PROJECT_OVERVIEW).
 *
 * Failure classes: wrong data on the standard product or order ->
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

// Synthetic account name from manifest/fixtures.v1.json (origin VERIFIED).
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Country channel for the standard product. Jelly glue is a DE-standard
// product in the storefront seed scripts (seed_products_v3.ts:24-28 seeds
// ordinary products into the default DE channel).
var PRODUCT_COUNTRY = 'DE';
var PRODUCT_CURRENCY = 'EUR';

// Default standard product slug (jelly glue). Overridable through
// context.fixtures.productSlug or the CAN_B2_05_PRODUCT_SLUG env var.
var DEFAULT_PRODUCT_SLUG = 'jelly-glue';
var PRODUCT_SLUG_ENV = 'CAN_B2_05_PRODUCT_SLUG';

// Standard quantity used to place the ordinary order.
var ORDER_QUANTITY = 1;

// Shop API ordinary product query (single-price path). Field list mirrors the
// storefront GetProductDetailQuery at queries.ts:53-112.
var STANDARD_PRODUCT_QUERY = [
  'query GetStandardProduct($slug: String!) {',
  '  product(slug: $slug) {',
  '    id',
  '    name',
  '    slug',
  '    variants {',
  '      id',
  '      name',
  '      sku',
  '      priceWithTax',
  '      currencyCode',
  '      stockLevel',
  '    }',
  '    customFields {',
  '      designFee',
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

// A store.call result is the raw { request, response, networkError, ... }
// shape while the shaped store methods (login, addItemToOrder, activeOrder,
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
        opts.secrets['standardProductSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

/**
 * Build the verified/unverified assertion report. The Shop-API-verifiable
 * single-price path, ordinary stock and ordinary order are checked; the
 * receipt, platform-revenue and no-designer-commission claims need the Stripe
 * Runner and DB/admin and are marked unverified.
 */
function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B2-05-A01',
    verified: true,
    summary: 'A standard product follows the single-price path with ordinary stock, order, receipt and platform revenue, and creates no design-fee or designer-commission record.',
    verifiedClaims: [
      { claim: 'single-price path with no design fee (customFields.designFee null/0)', verified: checks.singlePricePath, observed: observed.designFee },
      { claim: 'ordinary stock (stockLevel not OUT_OF_STOCK and non-negative)', verified: checks.ordinaryStock, observed: observed.stockLevel },
      { claim: 'ordinary order accepts the standard product (addItemToOrder)', verified: checks.orderCreated, observed: observed.orderCode },
      { claim: 'order line carries no design-fee record (line product designFee null/0)', verified: checks.orderLineNoDesignFee, observed: observed.orderLineDesignFee }
    ],
    unverifiedClaims: [
      { claim: 'receipt after payment', why: 'paid-order and receipt need the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' },
      { claim: 'platform revenue', why: 'platform revenue recognition happens at payment settlement (Stripe Runner)' },
      { claim: 'no designer-commission record', why: 'commission ledger is DB-level, not readable through the Shop API (PROJECT_OVERVIEW_EN.md 4.3)' }
    ]
  };
  var a02 = {
    id: 'CAN-B2-05-A02',
    verified: false,
    summary: 'The ordinary-product publish-to-purchase-to-receipt/order-to-export/shipping path is separate from customer-design products and must not accidentally create design-fee or designer-commission records.',
    verifiedClaims: [
      { claim: 'purchased as an ordinary product with no design fee on the order', verified: checks.orderLineNoDesignFee, observed: observed.orderLineDesignFee }
    ],
    unverifiedClaims: [
      { claim: 'publish and export/shipping path stays separate', why: 'the publish/export path is exercised by scripts and DB/admin, not the Shop API' },
      { claim: 'no designer-commission record is created', why: 'commission ledger is DB-level, not readable through the Shop API' }
    ]
  };
  return [a01, a02];
}

function productDataFromResponse(step) {
  var product = readData(step, ['data', 'product']);
  if (!product) return null;
  var variants = product.variants || [];
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    designFee: product.customFields ? product.customFields.designFee : null,
    variants: variants
  };
}

function firstVariantData(product) {
  if (!product || !Array.isArray(product.variants) || product.variants.length === 0) return null;
  var v = product.variants[0];
  return {
    variantId: v.id,
    variantSku: v.sku,
    variantPrice: v.priceWithTax,
    variantCurrency: v.currencyCode,
    stockLevel: v.stockLevel
  };
}

function orderLineDesignFeeFromOrder(step) {
  var lines = readData(step, ['data', 'activeOrder', 'lines']) || readData(step, ['data', 'orderByCode', 'lines']);
  if (!Array.isArray(lines) || lines.length === 0) return null;
  var first = lines[0];
  if (first && first.productVariant && first.productVariant.product &&
      first.productVariant.product.customFields) {
    return first.productVariant.product.customFields.designFee;
  }
  return null;
}

/**
 * CAN-B2-05 handler. Bounded, ready-to-order Shop API check of the standard
 * product flow:
 *   1. login the buyer account (password via SHOP_ACCOUNT_PASSWORD_BUYER_ONE);
 *   2. query the standard product (jelly glue) via the ordinary-product query
 *      product(slug) -> single-price path (designFee null/0) and ordinary
 *      stock (stockLevel != OUT_OF_STOCK);
 *   3. addItemToOrder the standard variant -> ordinary order;
 *   4. activeOrder -> the order line carries the variant price and no
 *      design-fee record.
 * Receipt, platform revenue and no-designer-commission stay unverified.
 */
async function handlerStandardProduct(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-05');
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
  if (!tokensResult.tokens[PRODUCT_COUNTRY]) {
    var missingEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + PRODUCT_COUNTRY, countryCodes: [PRODUCT_COUNTRY] },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: missingEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'channel token missing for ' + PRODUCT_COUNTRY, missingEvidence);
  }

  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];
  var slug = resolveProductSlug(context);
  observed.productSlug = slug;

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

  // 1. login as the buyer.
  var loginOut = await store.login(BUYER_ACCOUNT);
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

  // 2. query the standard product (ordinary-product query, single-price path).
  var productOut = await store.call(BUYER_ACCOUNT, STANDARD_PRODUCT_QUERY, { slug: slug }, PRODUCT_COUNTRY);
  recordStep('ordinary-product', productOut, ['data', 'product']);
  if (isNetworkDown(productOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'ordinary-product',
      error: 'shop-api product query failed: ' + (productOut.networkError || 'HTTP down'),
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }
  if (hasGraphQLErrors(productOut)) {
    var gqlErrors = readData(productOut, ['errors']) || [];
    var gqlEvidence = {
      taskId: taskId,
      step: 'ordinary-product',
      error: 'shop-api product query returned GraphQL errors',
      graphQLErrors: gqlErrors,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: gqlEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', gqlEvidence.error, gqlEvidence);
  }

  var product = productDataFromResponse(productOut);
  if (!product) {
    var notFoundEvidence = {
      taskId: taskId,
      step: 'ordinary-product',
      error: 'standard product not found for slug ' + slug,
      requestedSlug: slug,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: notFoundEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', notFoundEvidence.error, notFoundEvidence);
  }

  var variant = firstVariantData(product);
  observed.productId = product.id;
  observed.productName = product.name;
  observed.designFee = product.designFee;
  observed.priceWithTax = variant ? variant.variantPrice : null;
  observed.currencyCode = variant ? variant.variantCurrency : null;
  observed.stockLevel = variant ? variant.stockLevel : null;

  // single-price path: a standard product has no design fee (designFee null/0)
  // and a single priceWithTax in the channel currency.
  checks.singlePricePath = product.designFee === null || product.designFee === 0 ||
    product.designFee === undefined;
  checks.priceCurrencyIsProductCurrency = observed.currencyCode === PRODUCT_CURRENCY;
  checks.pricePresent = typeof observed.priceWithTax === 'number' && observed.priceWithTax > 0;

  // ordinary stock: stockLevel present and not OUT_OF_STOCK (numeric >= 0 or
  // the shop enum string IN_STOCK / LOW_STOCK).
  checks.stockLevelPresent = observed.stockLevel !== null && observed.stockLevel !== undefined;
  checks.ordinaryStock = checks.stockLevelPresent &&
    observed.stockLevel !== 'OUT_OF_STOCK' &&
    !(typeof observed.stockLevel === 'number' && observed.stockLevel < 0);

  // 3. place the ordinary order.
  var addOut = null;
  if (variant) {
    addOut = await store.addItemToOrder(BUYER_ACCOUNT, variant.variantId, ORDER_QUANTITY, PRODUCT_COUNTRY);
    recordStep('add-to-order', addOut, ['data', 'addItemToOrder']);
  }
  checks.orderCreated = !!(addOut && addOut.success);
  observed.orderCode = readData(addOut, ['data', 'addItemToOrder', 'code']) || null;
  observed.addError = addOut && !addOut.success ? (addOut.error || null) : null;

  // 4. active order carries the ordinary line with no design-fee record.
  var orderOut = null;
  if (checks.orderCreated) {
    orderOut = await store.activeOrder(BUYER_ACCOUNT, PRODUCT_COUNTRY);
    recordStep('active-order', orderOut, ['data', 'activeOrder']);
    if (isNetworkDown(orderOut)) {
      var envEvidence3 = {
        taskId: taskId,
        step: 'active-order',
        error: 'shop-api activeOrder failed: ' + (orderOut.networkError || 'HTTP down'),
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'executor-error.json', data: envEvidence3, kind: 'executor-error' }
      ], secrets);
      return failureOutcome('ENVIRONMENT_ERROR', envEvidence3.error, envEvidence3);
    }
  }
  observed.orderLineDesignFee = orderLineDesignFeeFromOrder(orderOut);
  checks.orderLineNoDesignFee = observed.orderLineDesignFee === null ||
    observed.orderLineDesignFee === 0 || observed.orderLineDesignFee === undefined;

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Standard product flow: single-price path, ordinary stock and ordinary order',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    productSlug: slug,
    buyerAccount: BUYER_ACCOUNT,
    productCountry: PRODUCT_COUNTRY,
    expected: {
      productSlug: slug,
      singlePricePath: 'customFields.designFee null/0',
      priceCurrency: PRODUCT_CURRENCY,
      stock: 'ordinary (not OUT_OF_STOCK)',
      order: 'addItemToOrder accepts the standard variant',
      noDesignFeeOnOrder: 'order line product customFields.designFee null/0',
      unverified: 'receipt + platform revenue (Stripe), no designer-commission record (DB/admin)'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B2-05-A01: receipt after payment (Stripe Runner)',
      'CAN-B2-05-A01: platform revenue (Stripe Runner settlement)',
      'CAN-B2-05-A01: no designer-commission record (DB/admin)',
      'CAN-B2-05-A02: publish/export/shipping path separation (scripts + DB/admin)',
      'CAN-B2-05-A02: no designer-commission record (DB/admin)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'standard-product-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.singlePricePath) {
    failures.push('standard product carries a design fee (customFields.designFee=' + observed.designFee + '); this is not the single-price path');
  }
  if (!checks.priceCurrencyIsProductCurrency) {
    failures.push('price currency mismatch: expected ' + PRODUCT_CURRENCY + ' got ' + observed.currencyCode);
  }
  if (!checks.pricePresent) {
    failures.push('standard product has no single priceWithTax');
  }
  if (!checks.ordinaryStock) {
    failures.push('standard product has no ordinary stock (stockLevel=' + observed.stockLevel + ')');
  }
  if (!checks.orderCreated) {
    failures.push('addItemToOrder did not create an ordinary order' + (observed.addError ? ' (' + observed.addError + ')' : ''));
  }
  if (checks.orderCreated && !checks.orderLineNoDesignFee) {
    failures.push('order line carries a design-fee record (designFee=' + observed.orderLineDesignFee + ')');
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    var defectEvidence = evidence;
    return failureOutcome('EXPECTED_MISMATCH', 'standard product flow mismatch: ' + detail, defectEvidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-05', {
    description: 'Standard product flow: single-price path, ordinary stock and ordinary order via the Shop API (readiness scope standard-product)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-05-A01'],
    handler: handlerStandardProduct
  });
  return { success: true, registered: ['CAN-B2-05'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  PRODUCT_COUNTRY: PRODUCT_COUNTRY,
  PRODUCT_CURRENCY: PRODUCT_CURRENCY,
  DEFAULT_PRODUCT_SLUG: DEFAULT_PRODUCT_SLUG,
  PRODUCT_SLUG_ENV: PRODUCT_SLUG_ENV,
  ORDER_QUANTITY: ORDER_QUANTITY,
  STANDARD_PRODUCT_QUERY: STANDARD_PRODUCT_QUERY,
  resolveProductSlug: resolveProductSlug,
  handlerStandardProduct: handlerStandardProduct,
  buildAssertionReport: buildAssertionReport,
  productDataFromResponse: productDataFromResponse,
  firstVariantData: firstVariantData,
  orderLineDesignFeeFromOrder: orderLineDesignFeeFromOrder,
  register: register
};
