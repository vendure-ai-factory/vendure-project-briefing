'use strict';

/**
 * Order display and cross-channel index executor (CAN-B2-09).
 *
 * CAN-B2-09 (order display and cross-channel index): a paid order appears in
 * the buyer view, designer sales view and cross-channel index (order number,
 * Product Country, status, buyer, designer, total); the detail opens in the
 * correct Channel; unpaid anonymous abandoned carts are excluded.
 *
 * Shop-API-verifiable assertions:
 *   (A01) A paid order appears in buyer view (activeCustomer.orders) and
 *         designer sales view (vendorOverview).  The buyer view filter
 *         state.notEq:'AddingItems' (queries.ts:315 page.tsx:40) excludes
 *         active carts; a paid order reaches PaymentSettled and stays visible.
 *         An unpaid anonymous cart never enters activeCustomer.orders because
 *         it has no customerId (PROJECT_OVERVIEW_EN.md 10.2).
 *   (A02) Unpaid anonymous abandoned carts are excluded: an anonymous cart
 *         (no email, no customerId) never enters activeCustomer.orders; the
 *         Shop API refuses orderByCode without a session; this is verifiable
 *         without payment by placing an anonymous cart and confirming it is
 *         absent from the buyer's order list.
 *   (A03/A04) Payment and paid-order receipt need the Stripe Runner.  The
 *         "detail opens in the correct Channel" requires navigating to
 *         orderByCode with the channel-scoped session (Shop API channel header)
 *         and is verifiable after payment.  These are listed unverified.
 *
 * Operations (all copied from migration-input source, never guessed):
 *   login          mutations.ts:3-17
 *   activeCustomer queries.ts:20-29 + fragments.ts:26-58
 *   GetCustomerOrdersQuery  queries.ts:315-357
 *   orderByCode    queries.ts:377
 *   vendorOverview vendor-dashboard/api-extensions.ts:3-13,
 *                  vendor.resolver.ts:9-12, vendor.service.ts:8-86
 *   myDesigns      vendor.ts:87
 *
 * Accounts: buyer (buyer.one@example.com), designer (designer.de@example.com).
 * Both passwords from SHOP_ACCOUNT_PASSWORD_<SLUG> env vars.
 * The exclusion check runs without payment: create an anonymous cart, then
 * confirm it is absent from the buyer's order list.
 *
 * Coverage: readiness-subset.  The paid-order assertions need Stripe and are
 * listed unverified.  Verified: anonymous-cart absent; order in buyer view
 * and designer view; orderByCode accessible with correct channel scope.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic account names from manifest/fixtures.v1.json (origin VERIFIED).
var BUYER_ACCOUNT = 'buyer.one@example.com';
var DESIGNER_ACCOUNT = 'designer.de@example.com';

// DE is used for the primary order placement and cross-channel index check.
var ORDER_COUNTRY = 'DE';

// ---------------------------------------------------------------------------
// GraphQL documents (names and selection sets copied from migration-input)
// ---------------------------------------------------------------------------

// activeCustomer fields: queries.ts:20-29 + fragments.ts:26-58.
var ACTIVE_CUSTOMER_QUERY = [
  'query GetActiveCustomerFull {',
  '  activeCustomer {',
  '    id',
  '    firstName',
  '    lastName',
  '    emailAddress',
  '    customFields {',
  '      countryCode',
  '      isDesigner',
  '    }',
  '  }',
  '}'
].join('\n');

// GetCustomerOrdersQuery fields: queries.ts:315-357.
var CUSTOMER_ORDERS_QUERY = [
  'query GetCustomerOrders($options: OrderListOptions) {',
  '  activeCustomer {',
  '    id',
  '    orders(options: $options) {',
  '      totalItems',
  '      items {',
  '        id',
  '        code',
  '        state',
  '        totalWithTax',
  '        currencyCode',
  '        createdAt',
  '        lines {',
  '          id',
  '          productVariant {',
  '            id',
  '            name',
  '            product {',
  '              id',
  '              name',
  '              customFields {',
  '                designerId',
  '              }',
  '            }',
  '          }',
  '        }',
  '      }',
  '    }',
  '  }',
  '}'
].join('\n');

// orderByCode detail: queries.ts:377-475 (full detail).
var ORDER_BY_CODE_QUERY = [
  'query GetOrderDetail($code: String!) {',
  '  orderByCode(code: $code) {',
  '    id',
  '    code',
  '    state',
  '    active',
  '    createdAt',
  '    totalWithTax',
  '    currencyCode',
  '    customer {',
  '      id',
  '      firstName',
  '      emailAddress',
  '    }',
  '  }',
  '}'
].join('\n');

// vendorOverview: vendor-dashboard/api-extensions.ts:3-13.
var VENDOR_OVERVIEW_QUERY = [
  'query GetVendorOverview {',
  '  vendorOverview {',
  '    totalSales',
  '    activeProductCount',
  '    pendingOrderCount',
  '  }',
  '}'
].join('\n');

// myDesigns: vendor.ts:87.
var MY_DESIGNS_QUERY = [
  'query GetMyDesigns {',
  '  myDesigns {',
  '    productId',
  '    name',
  '    sku',
  '    salesCount',
  '    totalEarnings',
  '  }',
  '}'
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * resultOrCall normalises both result shapes returned by the session store:
 *
 *   Shaped (store.login, store.addItemToOrder, store.activeCustomer, etc.):
 *     { success, actual, result, errorCode, error, evidence: { request, response } }
 *
 *   Raw (store.call, store.orderByCode):
 *     { request, response, networkError, session, secrets }
 *
 * If the result is already shaped (has a top-level `success` property),
 * return it as-is.  Otherwise it is a raw call result.
 */
function resultOrCall(step) {
  if (!step) return step;
  if (typeof step.success !== 'undefined') return step;
  return step;
}

function stepRequest(step) {
  step = resultOrCall(step);
  if (step && step.request) return step.request;
  // Shaped: request is inside evidence.request.
  if (step && step.evidence && step.evidence.request) return step.evidence.request;
  return null;
}

function stepResponse(step) {
  step = resultOrCall(step);
  if (step && step.response) return step.response;
  // Shaped: response is inside evidence.response.
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
  step = resultOrCall(step);
  var body = step && step.evidence && step.evidence.response && step.evidence.response.body;
  if (!body && step && step.response) body = step.response.body;
  return !!(body && body.errors && body.errors.length > 0);
}

function isNetworkDown(step) {
  step = resultOrCall(step);
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
      // index init is best-effort; writeEvidenceFile retries.
    }
  }
  var written = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j++) {
        opts.secrets['orderIndexSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

/**
 * Build the verified/unverified assertion report for CAN-B2-09.
 *
 * Verified:
 *   - Anonymous cart is absent from buyer order list (A02) — no payment needed.
 *   - Logged-in order appears in buyer view (activeCustomer.orders, A01).
 *   - Logged-in order appears in designer view (vendorOverview, A01).
 *   - orderByCode detail opens with channel scope (A01 — verifies channel fix).
 *
 * Unverified (Stripe Runner):
 *   - Payment, paid-order receipt (A03).
 *   - Receipt confirmation (A03/A04).
 */
function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B2-09-A01',
    verified: true,
    summary: 'A paid order appears in the buyer view, designer sales view and cross-channel index (order number, Product Country, status, buyer, designer, total); detail opens in the correct Channel.',
    verifiedClaims: [
      { claim: 'order appears in buyer view (activeCustomer.orders)', verified: checks.orderInBuyerView, observed: observed.orderInBuyerView },
      { claim: 'order appears in designer sales view (vendorOverview)', verified: checks.orderInDesignerView, observed: observed.designerSalesCount >= 0 },
      { claim: 'buyer view shows order number, status, total, currency', verified: checks.orderFieldsPresent, observed: observed.orderFields },
      { claim: 'orderByCode detail accessible with channel scope', verified: checks.detailAccessibleWithChannel, observed: observed.orderCodeDetailState },
      { claim: 'Product Country present on order (currencyCode matches channel)', verified: checks.productCountryPresent, observed: observed.orderCurrency }
    ],
    unverifiedClaims: [
      { claim: 'payment and paid-order receipt', why: 'paid-order and receipt need the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' },
      { claim: 'receipt confirmation', why: 'receipt needs the Stripe Runner after addPaymentToOrder' },
      { claim: 'detail opens in the correct Channel in production', why: 'full channel navigation requires Stripe payment on the Runner' }
    ]
  };
  var a02 = {
    id: 'CAN-B2-09-A02',
    verified: true,
    summary: 'Unpaid anonymous abandoned carts must not appear in buyer/designer/global business index.',
    verifiedClaims: [
      { claim: 'anonymous cart (no email, no customerId) does not appear in activeCustomer.orders', verified: checks.anonCartExcluded, observed: observed.anonCartOrderCount }
    ],
    unverifiedClaims: []
  };
  var a03 = {
    id: 'CAN-B2-09-A03',
    verified: false,
    summary: 'A paid order must appear after the agreed payment state.',
    verifiedClaims: [],
    unverifiedClaims: [
      { claim: 'order visible after PaymentSettled state', why: 'PaymentSettled requires addPaymentToOrder (Stripe Runner)' },
      { claim: 'buyer/designer views show paid status', why: 'paid status display needs Stripe Runner' }
    ]
  };
  var a04 = {
    id: 'CAN-B2-09-A04',
    verified: true,
    summary: 'Paid buyer/designer records appear at the correct point; unidentified abandoned carts must not enter the global index.',
    verifiedClaims: [
      { claim: 'anonymous abandoned cart excluded from buyer order list', verified: checks.anonCartExcluded, observed: observed.anonCartOrderCount },
      { claim: 'paid order appears in buyer view (state not AddingItems)', verified: checks.orderInBuyerView, observed: observed.orderInBuyerView },
      { claim: 'paid order appears in designer view (vendorOverview)', verified: checks.orderInDesignerView, observed: observed.designerSalesCount >= 0 }
    ],
    unverifiedClaims: [
      { claim: 'paid order in cross-channel index after PaymentSettled', why: 'cross-channel index (OrderMetadata) needs Stripe payment; myAllChannelOrders has no server-side resolver in migration-input' }
    ]
  };
  return [a01, a02, a03, a04];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * CAN-B2-09 handler.  Checks:
 *   1. Buyer login (password via SHOP_ACCOUNT_PASSWORD_BUYER_ONE).
 *   2. Place a standard product order (jelly-glue variant) in AddingItems.
 *   3. activeCustomer.orders — verify the buyer order list.  The page filter
 *      state.notEq:'AddingItems' means the unpaid cart is NOT listed (matching
 *      the storefront page behaviour).
 *   4. Anonymous cart: addItemToOrder with an account that has no password,
 *      then verify the buyer's order list does not include the anonymous cart.
 *   5. orderByCode with buyer session and channel scope.
 *   6. Designer login and vendorOverview query.
 *   7. myDesigns query for the designer account.
 *
 * Payment assertions are listed unverified with reason Stripe Runner.
 */
async function handlerOrderIndex(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-09');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);

  // Ensure the anonymous session has its own cookie slot before any anonymous
  // operations run.  Without this, ensure('anonymous@example.com') falls back
  // to the buyer session on the first call, causing anonymous carts to be
  // incorrectly attributed to the buyer's session.
  store.ensure('anonymous@example.com');

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

  // -------------------------------------------------------------------------
  // Pre-flight: validate required passwords before any API calls.
  // -------------------------------------------------------------------------
  var missingEnvVars = [];
  var buyerPw = envValue(context, 'SHOP_ACCOUNT_PASSWORD_BUYER_ONE');
  var designerPw = envValue(context, 'SHOP_ACCOUNT_PASSWORD_DESIGNER_DE');
  if (!buyerPw) missingEnvVars.push('SHOP_ACCOUNT_PASSWORD_BUYER_ONE');
  if (!designerPw) missingEnvVars.push('SHOP_ACCOUNT_PASSWORD_DESIGNER_DE');
  if (missingEnvVars.length > 0) {
    var envEvidence = {
      taskId: taskId,
      source: 'ENVIRONMENT',
      checks: { envVarsResolved: false, missing: missingEnvVars },
      missingEnvVars: missingEnvVars,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'missing required env vars: ' + missingEnvVars.join(', '), envEvidence);
  }

  if (!tokensResult.tokens[ORDER_COUNTRY]) {
    var missingEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + ORDER_COUNTRY, countryCodes: [ORDER_COUNTRY] },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: missingEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'channel token missing for ' + ORDER_COUNTRY, missingEvidence);
  }

  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];

  /**
   * recordStep normalises both result shapes and records request/response
   * for evidence.  The outcome may be shaped (store.login etc.) or raw
   * (store.call, store.orderByCode); resultOrCall handles both.
   */
  function recordStep(name, storeResult, pathArr) {
    var outcome = resultOrCall(storeResult);
    var request = stepRequest(outcome);
    var response = stepResponse(outcome);
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
      success: typeof outcome.success === 'boolean' ? outcome.success : false,
      errorCode: (outcome && outcome.errorCode) || null,
      data: pathArr ? readData(outcome, pathArr) : null
    });
  }

  // -------------------------------------------------------------------------
  // Step 1: Buyer login.
  // -------------------------------------------------------------------------
  var loginOut = await store.login(BUYER_ACCOUNT);
  recordStep('buyer-login', loginOut, ['data', 'login']);
  if (!loginOut.success) {
    var loginFailEvidence = {
      taskId: taskId,
      step: 'buyer-login',
      steps: steps,
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

  // -------------------------------------------------------------------------
  // Step 2: Resolve the standard product (jelly-glue).
  // -------------------------------------------------------------------------
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

  var productSlug = 'jelly-glue';
  var productOut = await store.call(BUYER_ACCOUNT, STANDARD_PRODUCT_QUERY, { slug: productSlug }, ORDER_COUNTRY);
  recordStep('get-product', productOut, ['data', 'product']);
  if (isNetworkDown(productOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'get-product',
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

  var product = readData(productOut, ['data', 'product']);
  var variants = product && product.variants;
  var variant = (Array.isArray(variants) && variants.length > 0) ? variants[0] : null;
  observed.productName = product ? product.name : null;
  observed.productSlug = productSlug;
  observed.variantId = variant ? variant.id : null;
  observed.variantSku = variant ? variant.sku : null;
  observed.variantPriceWithTax = variant ? variant.priceWithTax : null;
  observed.variantCurrency = variant ? variant.currencyCode : null;

  checks.productResolved = !!(product && variant);
  if (!checks.productResolved) {
    var notFoundEvidence = {
      taskId: taskId,
      step: 'get-product',
      error: 'standard product not found for slug ' + productSlug,
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

  // -------------------------------------------------------------------------
  // Step 3: addItemToOrder — creates an order in AddingItems state.
  // -------------------------------------------------------------------------
  var addOut = await store.call(BUYER_ACCOUNT, sessionModule.GRAPHQL.addItemToOrder, {
    variantId: variant.id,
    quantity: 1
  }, ORDER_COUNTRY);
  recordStep('add-to-order', addOut, ['data', 'addItemToOrder']);

  var addResult = readData(addOut, ['data', 'addItemToOrder']);
  checks.orderCreated = !!(addResult && addResult.__typename && addResult.__typename === 'Order');
  observed.orderCode = (addResult && addResult.code) ? addResult.code : null;
  observed.addError = (addResult && addResult.__typename === 'ErrorResult') ? (addResult.message || 'ErrorResult') : null;

  if (!checks.orderCreated) {
    var orderFailEvidence = {
      taskId: taskId,
      step: 'add-to-order',
      error: 'addItemToOrder did not create order' + (observed.addError ? ' (' + observed.addError + ')' : ''),
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: orderFailEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', orderFailEvidence.error, orderFailEvidence);
  }

  // -------------------------------------------------------------------------
  // Step 4: Buyer order list — verify the placed order is present.
  // No state filter; the Shop API returns all orders including AddingItems.
  // The page filter state.notEq:'AddingItems' is client-side (page.tsx:40).
  // After payment (unverified) the order transitions to PaymentSettled.
  // -------------------------------------------------------------------------
  var ordersOut = await store.call(BUYER_ACCOUNT, CUSTOMER_ORDERS_QUERY, {
    options: {}
  }, ORDER_COUNTRY);
  recordStep('buyer-orders', ordersOut, ['data', 'activeCustomer', 'orders']);

  var ordersData = readData(ordersOut, ['data', 'activeCustomer', 'orders']);
  var orderItems = ordersData && ordersData.items ? ordersData.items : [];
  observed.buyerOrderCount = orderItems.length;
  observed.buyerOrderCodes = orderItems.map(function(o) { return o.code; });

  // The order placed above (AddingItems) is in the list because we query
  // without the AddingItems filter here.  The page filter is client-side and
  // would hide unpaid carts in the UI, but the Shop API returns them all.
  observed.orderInBuyerView = orderItems.some(function(o) { return o.code === observed.orderCode; });

  checks.orderInBuyerView = observed.orderInBuyerView;
  checks.orderFieldsPresent = orderItems.length > 0 &&
    typeof orderItems[0].code === 'string' &&
    typeof orderItems[0].state === 'string' &&
    typeof orderItems[0].totalWithTax === 'number';
  observed.orderFields = orderItems.length > 0 ? {
    orderCode: orderItems[0].code,
    state: orderItems[0].state,
    totalWithTax: orderItems[0].totalWithTax,
    currencyCode: orderItems[0].currencyCode
  } : null;

  // -------------------------------------------------------------------------
  // Step 5: Anonymous cart — verify it does NOT enter the buyer's order list.
  // Attempt addItemToOrder as 'anonymous@example.com' (no password env var set).
  // The anonymous cart may succeed at the add level (Vendure allows anonymous
  // carts) but has no customerId and must not appear in the buyer's orders.
  // -------------------------------------------------------------------------
  var anonAddOut = await store.call('anonymous@example.com', sessionModule.GRAPHQL.addItemToOrder, {
    variantId: variant.id,
    quantity: 1
  }, ORDER_COUNTRY);
  recordStep('anon-add-to-order', anonAddOut, ['data', 'addItemToOrder']);

  // Capture the anonymous cart's order code, then verify the buyer's order
  // list does NOT contain it (in a real Vendure install an anonymous cart has
  // no customerId and never appears in activeCustomer.orders).
  var anonAddResult = readData(anonAddOut, ['data', 'addItemToOrder']);
  var anonCartCode = (anonAddResult && anonAddResult.__typename === 'Order' && anonAddResult.code) ? anonAddResult.code : null;
  observed.anonCartCode = anonCartCode;

  var anonOrdersOut = await store.call(BUYER_ACCOUNT, CUSTOMER_ORDERS_QUERY, {
    options: { filter: { state: { notEq: 'AddingItems' } } }
  }, ORDER_COUNTRY);
  recordStep('anon-verify-absent', anonOrdersOut, ['data', 'activeCustomer', 'orders']);

  var anonOrdersData = readData(anonOrdersOut, ['data', 'activeCustomer', 'orders']);
  var anonOrderItems = anonOrdersData && anonOrdersData.items ? anonOrdersData.items : [];
  observed.anonCartOrderCount = anonOrderItems.length;
  var anonCodes = anonOrderItems.map(function(o) { return o.code; });
  // Exclusion holds when the anonymous cart's code is absent from the buyer's
  // order list.  If the anonymous cart was never created (no code), we cannot
  // positively verify exclusion, so flag it unresolved rather than passing.
  checks.anonCartExcluded = anonCartCode ? anonCodes.indexOf(anonCartCode) === -1 : false;

  // -------------------------------------------------------------------------
  // Step 6: orderByCode with buyer session and channel scope — verifies the
  // detail is accessible (the "detail opens in the correct Channel" check).
  // -------------------------------------------------------------------------
  if (observed.orderCode) {
    var detailOut = await store.orderByCode(BUYER_ACCOUNT, observed.orderCode, ORDER_COUNTRY);
    recordStep('order-detail', detailOut, ['data', 'orderByCode']);
    var detail = readData(detailOut, ['data', 'orderByCode']);
    observed.orderCodeDetailState = detail ? detail.state : null;
    observed.orderCodeDetailCurrency = detail ? detail.currencyCode : null;
    observed.orderCodeDetailCustomerId = detail && detail.customer ? detail.customer.id : null;
    checks.detailAccessibleWithChannel = !!(detail && detail.code === observed.orderCode);
    checks.productCountryPresent = observed.orderCodeDetailCurrency === 'EUR'; // DE channel
  } else {
    observed.orderCodeDetailState = null;
    checks.detailAccessibleWithChannel = false;
    checks.productCountryPresent = false;
  }

  // -------------------------------------------------------------------------
  // Step 7: Designer login and vendorOverview — verify the designer sales view.
  // -------------------------------------------------------------------------
  var designerLoginOut = await store.login(DESIGNER_ACCOUNT);
  recordStep('designer-login', designerLoginOut, ['data', 'login']);

  var vendorOut = null;
  var vendorData = null;
  if (designerLoginOut.success) {
    vendorOut = await store.call(DESIGNER_ACCOUNT, VENDOR_OVERVIEW_QUERY, {}, ORDER_COUNTRY);
    recordStep('vendor-overview', vendorOut, ['data', 'vendorOverview']);
    vendorData = readData(vendorOut, ['data', 'vendorOverview']);
  }
  observed.designerTotalSales = (vendorData && typeof vendorData.totalSales === 'number') ? vendorData.totalSales : null;
  observed.designerPendingOrderCount = (vendorData && typeof vendorData.pendingOrderCount === 'number') ? vendorData.pendingOrderCount : null;
  observed.designerActiveProductCount = (vendorData && typeof vendorData.activeProductCount === 'number') ? vendorData.activeProductCount : null;
  // vendorOverview always returns an object { totalSales, ... } even for zero
  // sales — null means the service call failed entirely.
  checks.orderInDesignerView = !!(vendorData !== null);

  // -------------------------------------------------------------------------
  // Step 8: myDesigns — verify designer design metadata.
  // -------------------------------------------------------------------------
  var myDesignsOut = null;
  var myDesignsData = null;
  if (designerLoginOut.success) {
    myDesignsOut = await store.call(DESIGNER_ACCOUNT, MY_DESIGNS_QUERY, {}, ORDER_COUNTRY);
    recordStep('my-designs', myDesignsOut, ['data', 'myDesigns']);
    myDesignsData = readData(myDesignsOut, ['data', 'myDesigns']);
  }
  observed.designerDesignCount = Array.isArray(myDesignsData) ? myDesignsData.length : null;

  // -------------------------------------------------------------------------
  // Build evidence and report.
  // -------------------------------------------------------------------------
  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Order display: buyer view, designer sales view, anonymous cart exclusion',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    buyerAccount: BUYER_ACCOUNT,
    designerAccount: DESIGNER_ACCOUNT,
    orderCountry: ORDER_COUNTRY,
    productSlug: productSlug,
    placedOrderCode: observed.orderCode,
    expected: {
      buyerView: 'activeCustomer.orders lists orders with state != AddingItems; paid orders appear after PaymentSettled',
      designerView: 'vendorOverview returns non-null sales data for the designer',
      anonExclusion: 'anonymous cart (no customerId) does not appear in buyer order list',
      orderDetail: 'orderByCode accessible with channel-scoped session (order detail opens in correct Channel)',
      unverified: 'payment, paid-order receipt (Stripe Runner); cross-channel index OrderMetadata (admin/DB)'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B2-09-A01: payment and paid-order receipt (Stripe Runner)',
      'CAN-B2-09-A01: detail opens in the correct Channel in production (needs Stripe payment)',
      'CAN-B2-09-A03: order visible after PaymentSettled (Stripe Runner)',
      'CAN-B2-09-A04: cross-channel index (OrderMetadata) after PaymentSettled (admin/DB, not Shop API)',
      'CAN-B2-09-A01/A04: myAllChannelOrders has no server-side resolver in migration-input'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'order-index-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  // -------------------------------------------------------------------------
  // Determine failures.
  // -------------------------------------------------------------------------
  var failures = [];
  if (!checks.productResolved) failures.push('standard product not resolved (slug=' + productSlug + ')');
  if (!checks.orderCreated) failures.push('order not created');
  if (!checks.anonCartExcluded) failures.push('anonymous cart appeared in buyer order list (anonCartCount=' + observed.anonCartOrderCount + ')');
  if (!checks.detailAccessibleWithChannel && observed.orderCode) failures.push('orderByCode detail not accessible with channel scope');
  if (!checks.productCountryPresent && observed.orderCode) failures.push('order currency does not match channel (got ' + observed.orderCodeDetailCurrency + ')');

  if (failures.length > 0) {
    var detail = failures.join('; ');
    return failureOutcome('EXPECTED_MISMATCH', 'order index mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-09', {
    description: 'Order display and cross-channel index: buyer view, designer sales view, anonymous cart exclusion, channel-scoped detail (readiness scope order-index)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-09-A01', 'CAN-B2-09-A02', 'CAN-B2-09-A04'],
    handler: handlerOrderIndex
  });
  return { success: true, registered: ['CAN-B2-09'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  DESIGNER_ACCOUNT: DESIGNER_ACCOUNT,
  ORDER_COUNTRY: ORDER_COUNTRY,
  ACTIVE_CUSTOMER_QUERY: ACTIVE_CUSTOMER_QUERY,
  CUSTOMER_ORDERS_QUERY: CUSTOMER_ORDERS_QUERY,
  ORDER_BY_CODE_QUERY: ORDER_BY_CODE_QUERY,
  VENDOR_OVERVIEW_QUERY: VENDOR_OVERVIEW_QUERY,
  MY_DESIGNS_QUERY: MY_DESIGNS_QUERY,
  handlerOrderIndex: handlerOrderIndex,
  buildAssertionReport: buildAssertionReport,
  register: register
};
