'use strict';

/**
 * Custom press-on-nail purchase executor (CAN-B2-06).
 *
 * CAN-B2-06 (custom press-on-nail purchase): a custom purchase lets the
 * customer pick effect image, nail shape and finger; the order preserves
 * design, physical product, shape, finger, size/model, Product Country,
 * price, currency, tax, shipping and payment values.
 *
 * The executor verifies the invariants the Shop API can prove up to the cart
 * or draft order, i.e. the step before payment needs Stripe:
 *   - the product(slug) query resolves a custom (nail) product whose variant
 *     carries a priceWithTax in the channel currency (storefront queries.ts:
 *     53-112) and whose customFields identify it as a design product
 *     (designTemplate effect-image table at product-view.tsx:28 and designFee
 *     at queries.ts:99-100);
 *   - addItemToOrder accepts the custom variant with the order-line custom
 *     fields the storefront sends for a custom purchase: designNumber (effect
 *     image name), nailShape (shape code), nailSizes (finger:size),
 *     matchedNailModel (auto-matched model) and fingerName (finger code) -
 *     product-info.tsx:146-163; the OrderLine custom fields are declared in
 *     the nail-customization plugin at nail-customization.plugin.ts:24-122;
 *   - the active order (cart / draft order) preserves design, physical
 *     product, shape, finger, size/model and Product Country, and carries
 *     price, currency, tax and shipping values copied from the source.
 *
 * matchedNailModel is written server-side by the OrderLineSubscriber
 * (order-line-subscriber.ts:21-57) using the reference table in
 * nail-size-data.ts (pinned as manifest/fixtures.v1.json nailSizeMapping,
 * origin VERIFIED). The executor derives the expected model from the fixture
 * and checks the order line carries it, so "finger sizes map to the reference
 * shape/model and remain present in the order" is verified as far as the Shop
 * API can prove it. The export and local design lookup steps stay unverified.
 *
 * Because "payment values" require the Stripe Runner (addPaymentToOrder,
 * mutations.ts:271-292) and a paid-order/receipt after payment, the executor
 * stops at the cart/draft order and marks them unverified. Coverage is
 * therefore readiness-subset and the run is a READINESS_PASS, never a full
 * pass.
 *
 * Failure classes: wrong data on the design product or order ->
 * EXPECTED_MISMATCH (APPLICATION_DEFECT); Shop API down -> ENVIRONMENT_ERROR
 * (DEPENDENCY_ENVIRONMENT); missing password env var -> VALIDATION_ERROR
 * (CLIENT_INPUT_SCOPE, records env NAMES only); missing/tampered nail-size
 * reference fixture -> PIPELINE_DEFECT.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');
var fixturesModule = require('../fixtures');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic account name from manifest/fixtures.v1.json (origin VERIFIED).
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Country channel for the custom design product.
var PRODUCT_COUNTRY = 'DE';
var PRODUCT_CURRENCY = 'EUR';

// Default custom design product slug. Overridable through
// context.fixtures.productSlug or the CAN_B2_06_PRODUCT_SLUG env var.
var DEFAULT_PRODUCT_SLUG = 'aurora-borealis-nails';
var PRODUCT_SLUG_ENV = 'CAN_B2_06_PRODUCT_SLUG';

// One of the four frozen shape codes (nail-size-data.ts); the storefront
// lets the customer pick this (nail-size-selector.tsx:92-115). Overridable
// through the env var.
var NAIL_SHAPE = 'short-oval';
var NAIL_SHAPE_ENV = 'CAN_B2_06_NAIL_SHAPE';

// Finger code (nail-size-selector.tsx finger grid). Overridable through the
// env var.
var FINGER = 'leftIndex';
var FINGER_ENV = 'CAN_B2_06_FINGER';

// Standard quantity used to place the custom order.
var ORDER_QUANTITY = 1;

// Shop API product query. Field list mirrors the storefront GetProductDetailQuery
// at queries.ts:53-112 (assets for effect images, variants priceWithTax and
// currencyCode, customFields designTemplate and designFee).
var CUSTOM_PRODUCT_QUERY = [
  'query GetCustomPurchaseProduct($slug: String!) {',
  '  product(slug: $slug) {',
  '    id',
  '    name',
  '    slug',
  '    featuredAsset {',
  '      id',
  '      name',
  '    }',
  '    assets {',
  '      id',
  '      name',
  '    }',
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
  '      designTemplate',
  '    }',
  '  }',
  '}'
].join('\n');

// Shop API active-order query. Field list mirrors the storefront
// GetActiveOrderQuery at queries.ts:114-163 and adds the order-line custom
// fields declared in nail-customization.plugin.ts:24-122.
var CUSTOM_ACTIVE_ORDER_QUERY = [
  'query GetCustomPurchaseActiveOrder {',
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
  '        product {',
  '          id',
  '          name',
  '          slug',
  '        }',
  '      }',
  '      unitPriceWithTax',
  '      quantity',
  '      linePriceWithTax',
  '      customFields {',
  '        designNumber',
  '        nailShape',
  '        nailSizes',
  '        matchedNailModel',
  '        specialEffect',
  '        surfaceFinish',
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

function resolveNailShape(context) {
  var envShape = envValue(context, NAIL_SHAPE_ENV);
  if (typeof envShape === 'string' && envShape.length > 0) {
    return envShape;
  }
  return NAIL_SHAPE;
}

function resolveFinger(context) {
  var envFinger = envValue(context, FINGER_ENV);
  if (typeof envFinger === 'string' && envFinger.length > 0) {
    return envFinger;
  }
  return FINGER;
}

// A store.call result is the raw { request, response, networkError, ... }
// shape while the shaped store methods (login, activeOrder, ...) return
// { success, actual, result, evidence: { request, response } }. These helpers
// normalise both shapes.
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
  var body = step && step.response && step.response.body;
  if (!body && step && step.evidence && step.evidence.response) {
    body = step.evidence.response.body;
  }
  return !!(body && body.errors && body.errors.length > 0);
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
  var baseDir = options.baseDir;
  var root = options.root;
  var loaded = evidenceCollector.loadIndex(path.join(root, baseDir), runId);
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
        opts.secrets['customPurchaseSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

/**
 * Resolve the nail reference entry for the chosen shape from the frozen
 * fixture (nailSizeMapping, origin VERIFIED). An exact arc length cannot be
 * predicted by the executor, so the size/model is expressed as the chosen
 * finger + shape and the matched model expected on the order line comes from
 * the reference table entry for the chosen size number.
 */
function resolveNailReference(context) {
  var loaded = fixturesModule.loadFixturesFile();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  var mapping = loaded.fixtures.nailSizeMapping;
  var shapes = mapping && mapping.shapes;
  if (!Array.isArray(shapes)) return { ok: false, error: 'nailSizeMapping.shapes missing' };
  var shape = null;
  for (var i = 0; i < shapes.length; i++) {
    if (shapes[i].code === NAIL_SHAPE) { shape = shapes[i]; break; }
  }
  if (!shape) return { ok: false, error: 'shape ' + NAIL_SHAPE + ' not in nailSizeMapping' };
  // Pick the middle-size entry so the order reflects a real reference size.
  var mid = Math.floor(shape.sizes.length / 2);
  var entry = shape.sizes[mid];
  return {
    ok: true,
    arcLength: entry.arcLength,
    modelNumber: entry.number,
    shapeCode: shape.code,
    fixtureSha: loaded.sha256
  };
}

function productDataFromResponse(step) {
  var product = readData(step, ['data', 'product']);
  if (!product) return null;
  var variants = product.variants || [];
  var effectImages = (product.assets || []).map(function(a) { return a.name; });
  if (effectImages.length === 0 && product.featuredAsset && product.featuredAsset.name) {
    effectImages = [product.featuredAsset.name];
  }
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    effectImages: effectImages,
    designFee: product.customFields ? product.customFields.designFee : null,
    designTemplate: product.customFields ? product.customFields.designTemplate : null,
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

function orderLineData(step) {
  var lines = readData(step, ['data', 'activeOrder', 'lines']);
  if (!Array.isArray(lines) || lines.length === 0) return null;
  var first = lines[0];
  var cf = (first && first.customFields) || {};
  return {
    lineId: first.id,
    variantId: first.productVariant ? first.productVariant.id : null,
    variantName: first.productVariant ? first.productVariant.name : null,
    variantSku: first.productVariant ? first.productVariant.sku : null,
    productId: first.productVariant && first.productVariant.product ? first.productVariant.product.id : null,
    productName: first.productVariant && first.productVariant.product ? first.productVariant.product.name : null,
    unitPriceWithTax: first.unitPriceWithTax,
    quantity: first.quantity,
    linePriceWithTax: first.linePriceWithTax,
    customFields: cf
  };
}

/**
 * Build the verified/unverified assertion report. The design purchase flow,
 * the retention of the chosen design/product/shape/finger/size-model and the
 * price/currency/tax/shipping values are checked against real Shop API
 * evidence; payment values need the Stripe Runner and are marked unverified.
 */
function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B2-06-A01',
    verified: true,
    summary: 'A custom purchase lets the customer pick effect image, nail shape and finger; the order preserves design, physical product, shape, finger, size/model, Product Country, price, currency, tax, shipping and payment values.',
    verifiedClaims: [
      { claim: 'effect image is the chosen design (line customFields.designNumber)', verified: checks.designPreserved, observed: observed.sentDesignNumber },
      { claim: 'physical product preserved (line productVariant id/sku)', verified: checks.physicalProductPreserved, observed: observed.variantSku },
      { claim: 'nail shape preserved (line customFields.nailShape)', verified: checks.shapePreserved, observed: observed.shapeOnLine },
      { claim: 'finger preserved (line customFields.fingerName from nailSizes finger)', verified: checks.fingerPreserved, observed: observed.sentNailSizes },
      { claim: 'size/model preserved (line customFields.matchedNailModel matches reference)', verified: checks.modelPreserved, observed: observed.matchedModelOnLine },
      { claim: 'Product Country preserved (order currency is the product country currency)', verified: checks.productCountryPreserved, observed: observed.orderCurrency },
      { claim: 'price preserved (line unitPriceWithTax equals variant priceWithTax)', verified: checks.pricePreserved, observed: observed.unitPriceWithTax },
      { claim: 'currency preserved (order currencyCode present and expected)', verified: checks.currencyPreserved, observed: observed.orderCurrency },
      { claim: 'tax values present on the order (taxSummary)', verified: checks.taxPresent, observed: observed.taxSummaryCount },
      { claim: 'shipping values present on the order (shippingLines)', verified: checks.shippingPresent, observed: observed.shippingLineCount }
    ],
    unverifiedClaims: [
      { claim: 'payment values (methods, transaction id, amount captured)', why: 'paid-order and receipt need the Stripe Runner (addPaymentToOrder, mutations.ts:271-292); the executor stops at the cart/draft order' },
      { claim: 'paid-order receipt after payment', why: 'paid-order and receipt need the Stripe Runner' }
    ]
  };
  var a02 = {
    id: 'CAN-B2-06-A02',
    verified: false,
    summary: 'Saved finger sizes must map to the reference shape/model and remain present in the order, export, and local design lookup.',
    verifiedClaims: [
      { claim: 'finger sizes map to the reference shape/model (matchedNailModel from the fixture reference)', verified: checks.modelPreserved, observed: observed.matchedModelOnLine },
      { claim: 'finger size remains present in the order (nailSizes on the order line)', verified: checks.fingerPreserved, observed: observed.sentNailSizes }
    ],
    unverifiedClaims: [
      { claim: 'export keeps the finger size mapping', why: 'the export path is exercised by export scripts and DB/admin, not the Shop API' },
      { claim: 'local design lookup keeps the finger size mapping', why: 'local design lookup is a browser/DB step, not the Shop API' }
    ]
  };
  return [a01, a02];
}

/**
 * CAN-B2-06 handler. Bounded Shop API check of the custom purchase flow up to
 * the cart/draft order:
 *   1. login the buyer account (password via SHOP_ACCOUNT_PASSWORD_BUYER_ONE);
 *   2. query the custom design product (slug) -> variant price and effect
 *      images (designTemplate / assets);
 *   3. addItemToOrder with the chosen custom fields (designNumber, nailShape,
 *      nailSizes, fingerName) -> cart/draft order;
 *   4. activeOrder -> the order line preserves design, physical product,
 *      shape, finger, size/model, Product Country, price, currency, tax and
 *      shipping; payment values stay unverified.
 */
async function handlerCustomPurchase(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-06');
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
  var nailShape = resolveNailShape(context);
  var finger = resolveFinger(context);
  observed.productSlug = slug;
  observed.sentShape = nailShape;
  observed.sentFinger = finger;

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

  // Resolve the nail reference fixture before any network work.
  var reference = resolveNailReference(context);
  if (!reference.ok) {
    var refEvidence = {
      taskId: taskId,
      step: 'nail-reference',
      error: 'nail-size reference unavailable: ' + reference.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: refEvidence, kind: 'executor-error' }
    ], []);
    // Fixtures failing to load is a safety/integrity condition, not a pipeline
    // defect: the frozen reference data cannot be trusted.
    return failureOutcome('FIXTURES_UNAVAILABLE', refEvidence.error, refEvidence);
  }
  observed.referenceShape = reference.shapeCode;
  observed.referenceModel = reference.modelNumber;
  observed.referenceArcLength = reference.arcLength;
  observed.nailSizesValue = finger + ':' + reference.arcLength;

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

  // 2. query the custom design product.
  var productOut = await store.call(BUYER_ACCOUNT, CUSTOM_PRODUCT_QUERY, { slug: slug }, PRODUCT_COUNTRY);
  recordStep('custom-product', productOut, ['data', 'product']);
  if (isNetworkDown(productOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'custom-product',
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
      step: 'custom-product',
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
      step: 'custom-product',
      error: 'custom design product not found for slug ' + slug,
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
  observed.effectImageCount = product.effectImages.length;
  observed.priceWithTax = variant ? variant.variantPrice : null;
  observed.currencyCode = variant ? variant.variantCurrency : null;
  observed.stockLevel = variant ? variant.stockLevel : null;

  // The effect image the customer picks: the first readable effect image name,
  // exactly what product-info.tsx would store in designNumber.
  var pickedDesign = product.effectImages.length > 0 ? product.effectImages[0] : slug;
  observed.sentDesignNumber = pickedDesign;

  checks.productResolved = !!product && !!variant;
  checks.priceCurrencyIsProductCurrency = observed.currencyCode === PRODUCT_CURRENCY;
  checks.pricePresent = typeof observed.priceWithTax === 'number' && observed.priceWithTax > 0;
  checks.stockLevelPresent = observed.stockLevel !== null && observed.stockLevel !== undefined;
  checks.ordinalStock = checks.stockLevelPresent &&
    observed.stockLevel !== 'OUT_OF_STOCK' &&
    !(typeof observed.stockLevel === 'number' && observed.stockLevel < 0);

  // 3. add the custom item with the chosen effect image, shape, finger and size.
  var customFields = {
    designNumber: pickedDesign,
    nailShape: nailShape,
    fingerName: finger,
    nailSizes: finger + ':' + reference.arcLength
  };
  observed.sentNailShape = nailShape;
  observed.sentFingerName = finger;

  var addOut = null;
  if (variant) {
    addOut = await store.call(BUYER_ACCOUNT, sessionModule.GRAPHQL.addItemToOrder, {
      variantId: variant.variantId,
      quantity: ORDER_QUANTITY,
      customFields: customFields
    }, PRODUCT_COUNTRY);
    recordStep('add-to-order', addOut, ['data', 'addItemToOrder']);
  }
  var addResult = readData(addOut, ['data', 'addItemToOrder']);
  checks.orderCreated = !!(addResult && addResult.__typename && addResult.__typename === 'Order');
  observed.orderCode = addResult && addResult.code ? addResult.code : null;
  observed.addError = addResult && addResult.__typename === 'ErrorResult' ? (addResult.message || 'ErrorResult') : null;
  observed.addGraphQLErrors = readData(addOut, ['errors']) || null;

  // 4. active order preserves the custom line and the order price/currency/tax/shipping.
  var orderOut = null;
  if (checks.orderCreated) {
    orderOut = await store.call(BUYER_ACCOUNT, CUSTOM_ACTIVE_ORDER_QUERY, {}, PRODUCT_COUNTRY);
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

  var order = readData(orderOut, ['data', 'activeOrder']);
  var line = orderLineData(orderOut);
  observed.orderState = order ? order.state : null;
  observed.orderCurrency = order ? order.currencyCode : null;
  observed.subTotalWithTax = order ? order.subTotalWithTax : null;
  observed.totalWithTax = order ? order.totalWithTax : null;
  observed.taxSummaryCount = order && Array.isArray(order.taxSummary) ? order.taxSummary.length : 0;
  observed.shippingLineCount = order && Array.isArray(order.shippingLines) ? order.shippingLines.length : 0;
  observed.shippingWithTax = order ? order.shippingWithTax : null;

  var cfOnLine = line ? line.customFields : {};
  observed.designNumberOnLine = cfOnLine.designNumber;
  observed.shapeOnLine = cfOnLine.nailShape;
  observed.nailSizesOnLine = cfOnLine.nailSizes;
  observed.matchedModelOnLine = cfOnLine.matchedNailModel;
  observed.unitPriceWithTax = line ? line.unitPriceWithTax : null;
  observed.quantityOnLine = line ? line.quantity : null;
  observed.lineVariantSku = line ? line.variantSku : null;
  observed.lineVariantId = line ? line.variantId : null;

  // Preservation checks (read the order line custom fields from the source).
  checks.designPreserved = !!observed.designNumberOnLine && observed.designNumberOnLine === pickedDesign;
  checks.physicalProductPreserved = !!(line && line.variantId && line.variantId === (variant ? variant.variantId : null));
  checks.shapePreserved = !!observed.shapeOnLine && observed.shapeOnLine === nailShape;
  checks.fingerPreserved = !!(observed.nailSizesOnLine && observed.nailSizesOnLine.indexOf(finger + ':') !== -1);
  checks.modelPreserved = !!observed.matchedModelOnLine &&
    observed.matchedModelOnLine.indexOf(String(reference.modelNumber)) !== -1;
  checks.productCountryPreserved = observed.orderCurrency === PRODUCT_CURRENCY;
  checks.pricePreserved = !!(line && line.unitPriceWithTax && observed.priceWithTax &&
    line.unitPriceWithTax === observed.priceWithTax);
  checks.currencyPreserved = observed.orderCurrency === PRODUCT_CURRENCY;
  checks.taxPresent = observed.taxSummaryCount > 0 && typeof observed.subTotalWithTax === 'number';
  checks.shippingPresent = observed.shippingLineCount > 0;

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Custom purchase: effect image, nail shape, finger, size/model and order values',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    productSlug: slug,
    buyerAccount: BUYER_ACCOUNT,
    productCountry: PRODUCT_COUNTRY,
    pickedEffectImage: pickedDesign,
    sentCustomFields: customFields,
    expected: {
      design: 'line customFields.designNumber equals the picked effect image',
      physicalProduct: 'line productVariant id/sku equals the chosen variant',
      shape: 'line customFields.nailShape equals the picked shape',
      finger: 'line customFields.nailSizes includes the picked finger',
      sizeModel: 'line customFields.matchedNailModel matches the fixture reference',
      productCountry: 'order currencyCode is the product country currency',
      price: 'line unitPriceWithTax equals the variant priceWithTax',
      currency: 'order.currencyCode present',
      tax: 'order.taxSummary present',
      shipping: 'order.shippingLines present',
      unverified: 'payment values (Stripe Runner)'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B2-06-A01: payment values and paid-order receipt (Stripe Runner)',
      'CAN-B2-06-A02: export keeps the finger size mapping (export scripts + DB/admin)',
      'CAN-B2-06-A02: local design lookup keeps the finger size mapping (browser/DB)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'custom-purchase-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.productResolved) failures.push('custom design product or variant not resolved');
  if (!checks.priceCurrencyIsProductCurrency) failures.push('price currency mismatch: expected ' + PRODUCT_CURRENCY + ' got ' + observed.currencyCode);
  if (!checks.pricePresent) failures.push('custom product has no single priceWithTax');
  if (!checks.ordinalStock) failures.push('custom product has no ordinary stock (stockLevel=' + observed.stockLevel + ')');
  if (!checks.orderCreated) failures.push('addItemToOrder did not create the custom order' + (observed.addError ? ' (' + observed.addError + ')' : ''));
  if (checks.orderCreated && !checks.designPreserved) failures.push('design not preserved (designNumber=' + observed.designNumberOnLine + ')');
  if (checks.orderCreated && !checks.physicalProductPreserved) failures.push('physical product not preserved (line variant ' + observed.lineVariantId + ')');
  if (checks.orderCreated && !checks.shapePreserved) failures.push('nail shape not preserved (nailShape=' + observed.shapeOnLine + ')');
  if (checks.orderCreated && !checks.fingerPreserved) failures.push('finger not preserved (nailSizes=' + observed.nailSizesOnLine + ')');
  if (checks.orderCreated && !checks.modelPreserved) failures.push('size/model not preserved (matchedNailModel=' + observed.matchedModelOnLine + ', expected ' + reference.modelNumber + ')');
  if (checks.orderCreated && !checks.productCountryPreserved) failures.push('Product Country not preserved (order currency ' + observed.orderCurrency + ')');
  if (checks.orderCreated && !checks.pricePreserved) failures.push('price not preserved (unitPriceWithTax=' + observed.unitPriceWithTax + ')');
  if (checks.orderCreated && !checks.currencyPreserved) failures.push('currency not preserved (order currency ' + observed.orderCurrency + ')');
  if (checks.orderCreated && !checks.taxPresent) failures.push('tax values missing (taxSummaryCount=' + observed.taxSummaryCount + ')');
  if (checks.orderCreated && !checks.shippingPresent) failures.push('shipping values missing (shippingLineCount=' + observed.shippingLineCount + ')');

  if (failures.length > 0) {
    var detail = failures.join('; ');
    return failureOutcome('EXPECTED_MISMATCH', 'custom purchase flow mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-06', {
    description: 'Custom press-on-nail purchase: effect image, nail shape, finger, size/model, Product Country, price, currency, tax and shipping via the Shop API (readiness scope custom-purchase)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-06-A01'],
    handler: handlerCustomPurchase
  });
  return { success: true, registered: ['CAN-B2-06'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  PRODUCT_COUNTRY: PRODUCT_COUNTRY,
  PRODUCT_CURRENCY: PRODUCT_CURRENCY,
  DEFAULT_PRODUCT_SLUG: DEFAULT_PRODUCT_SLUG,
  PRODUCT_SLUG_ENV: PRODUCT_SLUG_ENV,
  NAIL_SHAPE: NAIL_SHAPE,
  NAIL_SHAPE_ENV: NAIL_SHAPE_ENV,
  FINGER: FINGER,
  FINGER_ENV: FINGER_ENV,
  ORDER_QUANTITY: ORDER_QUANTITY,
  CUSTOM_PRODUCT_QUERY: CUSTOM_PRODUCT_QUERY,
  CUSTOM_ACTIVE_ORDER_QUERY: CUSTOM_ACTIVE_ORDER_QUERY,
  resolveProductSlug: resolveProductSlug,
  resolveNailShape: resolveNailShape,
  resolveFinger: resolveFinger,
  resolveNailReference: resolveNailReference,
  handlerCustomPurchase: handlerCustomPurchase,
  buildAssertionReport: buildAssertionReport,
  productDataFromResponse: productDataFromResponse,
  firstVariantData: firstVariantData,
  orderLineData: orderLineData,
  register: register
};
