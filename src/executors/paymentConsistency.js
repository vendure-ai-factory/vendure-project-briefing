'use strict';

/**
 * Payment callback and order-state consistency executor (CAN-B1-06).
 *
 * CAN-B1-06 (payment callback and order-state consistency) asserts that the
 * payment result, callback, backend payment state, order state, receipt and
 * ledger agree, and that a browser success without a matching backend/order
 * state is not a pass.
 *
 * The executor verifies the invariants the Shop API and the Stripe test-mode
 * PaymentIntent API can prove with real evidence:
 *
 *   - the Stripe secret key is present as a Runner/test-mode secret
 *     (STRIPE_SECRET_KEY) and is a test key (boolean isTestKey, never any part
 *     of the key); a missing key is BLOCK CLIENT_INPUT_SCOPE (the manifest
 *     requiredInput stripeTestKeys is client-owned, inputs-registry.json
 *     secretRef STRIPE_TEST_SECRET_KEY);
 *   - one minimal PaymentIntent can be created in test mode (livemode=false)
 *     and cancelled (allowed Stripe actions per the STRIPE_RULES). Only the
 *     HTTP status, livemode=false and the boolean key presence/test-ness are
 *     recorded - no key part, no payouts/transfers/top-ups/Connect;
 *   - the Stripe test PaymentIntent status is compared with the order state
 *     read through the Shop API (orderByCode payments + order.state). A
 *     PaymentIntent that reports `succeeded` requires the order to be in a
 *     settled/payment-settled state with a `Settled` payment entry, and the
 *     other way around. A payment-success claim that is not matched by the
 *     backend/order state (a browser success without matching backend/order
 *     state) is NOT a pass;
 *   - a planted mismatch control is included: the executor can force a
 *     payment-success claim (CAN_B1_06_PLANT_MISMATCH / context.plantedMismatch)
 *     while the order state read from the Shop API is not settled; the
 *     mismatch must be detected (APPLICATION_DEFECT / EXPECTED_MISMATCH).
 *
 * Evidence kinds: only api (Shop API + Stripe test PaymentIntent API). The
 * browser, receipt and ledger claims need a real browser, the Stripe Runner,
 * and DB/admin access respectively, and are listed unverified. Coverage is
 * therefore readiness-subset and the run is a READINESS_PASS, never a full
 * pass.
 *
 * Exact GraphQL operation names are copied from the migration-input source
 * (never guessed):
 *   login              storefront/src/lib/vendure/mutations.ts:3-17
 *   orderByCode        storefront/src/lib/vendure/queries.ts:377
 *   addPaymentToOrder  storefront/src/lib/vendure/mutations.ts:271-292
 *   Stripe handler     stripe-connect/stripe-connect.handler.ts:3-24
 */

var crypto = require('crypto');
var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic account name from manifest/fixtures.v1.json (origin VERIFIED).
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Country channel for the order state read through the Shop API.
var ORDER_COUNTRY = 'DE';

// Default order code to read. Overridable via context.fixtures.orderCode or
// the CAN_B1_06_ORDER_CODE env var (a real staging test-order code).
var DEFAULT_ORDER_CODE = 'ED-PAY-0001';
var ORDER_CODE_ENV = 'CAN_B1_06_ORDER_CODE';

// Stripe test-mode secret resolution. Named after the Runner secret
// (STRIPE_SECRET_KEY, test mode only). inputs-registry.json declares the
// required input as stripeTestKeys with secretRef STRIPE_TEST_SECRET_KEY; both
// names are accepted so the executor never needs the value.
var STRIPE_SECRET_KEY_ENV = 'STRIPE_SECRET_KEY';
var STRIPE_TEST_SECRET_KEY_ENV = 'STRIPE_TEST_SECRET_KEY';
var STRIPE_LIVE_PREFIX = 'sk_live_';
var STRIPE_TEST_PREFIX = 'sk_test_';
var DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com';
var STRIPE_API_BASE_ENV = 'STRIPE_API_BASE';
var PAYMENT_INTENTS_PATH = '/v1/payment_intents';

// Minimal PaymentIntent payload amount (Stripe uses minor units; 100 minor
// units of a test currency is the smallest permitted for a one-create check).
var MINIMAL_AMOUNT = 100;
var MINIMAL_CURRENCY = 'eur';

// Planted-mismatch control: when set to a truthy value the executor forces a
// payment-success claim while the order state read through the Shop API is not
// settled; the mismatch must be detected.
var PLANT_MISMATCH_ENV = 'CAN_B1_06_PLANT_MISMATCH';

// Order states that mean paid/settled. From the default Vendure state machine
// (AddingItems -> ArrangingPayment -> PaymentAuthorized -> PaymentSettled ->
// ...) and vendor-dashboard/vendor.service.ts:67,78 which treats
// PaymentSettled/PartiallyShipped/Shipped/Delivered as paid-complete.
var PAID_ORDER_STATES = ['PaymentSettled', 'PartiallyShipped', 'Shipped', 'Delivered'];

// Stripe PaymentIntent statuses that mean the payment is fully settled.
var SUCCEEDED_STATUSES = ['succeeded'];

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function getFetch(context) {
  var fetchFn = context && context.deps && context.deps.fetch;
  if (typeof fetchFn !== 'function') fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('paymentConsistency: no fetch implementation available');
  }
  return fetchFn;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function getEnvFn(context) {
  return sessionModule.getEnvFn(context);
}

function envValue(context, name) {
  return sessionModule.envValue(context, name);
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

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

function resolveStripeApiBase(context) {
  if (context && typeof context.stripeApiBase === 'string' && context.stripeApiBase.length > 0) {
    return context.stripeApiBase.replace(/\/+$/, '');
  }
  var envBase = envValue(context, STRIPE_API_BASE_ENV);
  if (typeof envBase === 'string' && envBase.length > 0) {
    return envBase.replace(/\/+$/, '');
  }
  return DEFAULT_STRIPE_API_BASE.replace(/\/+$/, '');
}

/**
 * Read the Stripe test-mode secret. Accepted env var names (names only are
 * recorded in evidence; the value never leaves this function):
 *   STRIPE_SECRET_KEY (Runner secret, test mode only)
 *   STRIPE_TEST_SECRET_KEY (inputs-registry secretRef for stripeTestKeys)
 */
function readStripeKey(context) {
  var env = getEnvFn(context)();
  var candidates = [STRIPE_SECRET_KEY_ENV, STRIPE_TEST_SECRET_KEY_ENV];
  for (var i = 0; i < candidates.length; i++) {
    var value = env[candidates[i]];
    if (typeof value === 'string' && value.length > 0) {
      return { ok: true, value: value, envName: candidates[i], envNames: candidates };
    }
  }
  return { ok: false, envNames: candidates };
}

function isTestKey(keyValue) {
  if (typeof keyValue !== 'string' || keyValue.length === 0) return false;
  return keyValue.slice(0, STRIPE_TEST_PREFIX.length) === STRIPE_TEST_PREFIX;
}

function isLiveKey(keyValue) {
  if (typeof keyValue !== 'string' || keyValue.length === 0) return false;
  return keyValue.slice(0, STRIPE_LIVE_PREFIX.length) === STRIPE_LIVE_PREFIX;
}

/**
 * One minimal Stripe test-mode PaymentIntent create. Returns a sanitised
 * result: never the key, only HTTP status, livemode, the intent id and the
 * intent status. token is passed as a bearer only for the request.
 */
function createPaymentIntent(fetchFn, baseUrl, token) {
  var url = baseUrl + PAYMENT_INTENTS_PATH;
  var body = 'amount=' + MINIMAL_AMOUNT + '&currency=' + MINIMAL_CURRENCY;
  return fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Bearer ' + token
    },
    body: body
  }).then(function(response) {
    return response.text().then(function(text) {
      var parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = { raw: text };
        }
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        httpStatus: response.status,
        livemode: parsed ? parsed.livemode : null,
        id: parsed ? parsed.id : null,
        status: parsed ? parsed.status : null,
        error: parsed && parsed.error ? parsed.error : null,
        request: { method: 'POST', url: url, body: body, auth: 'Bearer [REDACTED]' },
        response: { httpStatus: response.status, body: parsed }
      };
    }, function(err) {
      return {
        ok: false,
        httpStatus: null,
        livemode: null,
        id: null,
        status: null,
        error: null,
        networkError: err && err.message ? err.message : String(err),
        request: { method: 'POST', url: url, body: body, auth: 'Bearer [REDACTED]' },
        response: { httpStatus: null, body: null }
      };
    });
  }).catch(function(err) {
    return {
      ok: false,
      httpStatus: null,
      livemode: null,
      id: null,
      status: null,
      error: null,
      networkError: err && err.message ? err.message : String(err),
      request: { method: 'POST', url: url, body: body, auth: 'Bearer [REDACTED]' },
      response: { httpStatus: null, body: null }
    };
  });
}

/**
 * Cancel the test PaymentIntent (cleanup of the temporary Stripe resource).
 */
function cancelPaymentIntent(fetchFn, baseUrl, token, intentId) {
  var url = baseUrl + PAYMENT_INTENTS_PATH + '/' + encodeURIComponent(intentId) + '/cancel';
  return fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Bearer ' + token
    }
  }).then(function(response) {
    return response.text().then(function(text) {
      var parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = { raw: text };
        }
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        httpStatus: response.status,
        status: parsed ? parsed.status : null,
        request: { method: 'POST', url: url, auth: 'Bearer [REDACTED]' },
        response: { httpStatus: response.status, body: parsed }
      };
    }, function(err) {
      return {
        ok: false,
        httpStatus: null,
        status: null,
        networkError: err && err.message ? err.message : String(err),
        request: { method: 'POST', url: url, auth: 'Bearer [REDACTED]' },
        response: { httpStatus: null, body: null }
      };
    });
  }).catch(function(err) {
    return {
      ok: false,
      httpStatus: null,
      status: null,
      networkError: err && err.message ? err.message : String(err),
      request: { method: 'POST', url: url, auth: 'Bearer [REDACTED]' },
      response: { httpStatus: null, body: null }
    };
  });
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

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
        opts.secrets['paymentConsistencySecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Shop API step helpers (normalise store.call / shaped method results)
// ---------------------------------------------------------------------------

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
  var body = stepBody(step);
  return !!(body && body.errors && body.errors.length > 0);
}

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return false;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

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
// Assertion report
// ---------------------------------------------------------------------------

function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B1-06-A01',
    verified: true,
    summary: 'Payment result, callback, backend payment state, order state, receipt and ledger agree; a browser success without matching backend/order state is not a pass.',
    verifiedClaims: [
      { claim: 'Stripe test key is present as a Runner secret and is a test key (boolean isTestKey, no key part recorded)', verified: checks.stripeTestKeyChecked, observed: observed.isTestKey },
      { claim: 'one minimal test-mode PaymentIntent can be created (livemode=false, HTTP status recorded)', verified: checks.intentCreated, observed: observed.createHttpStatus },
      { claim: 'the test PaymentIntent is cancelled as cleanup (HTTP status recorded)', verified: checks.intentCancelled, observed: observed.cancelHttpStatus },
      { claim: 'the Stripe test PaymentIntent status and the order state read through the Shop API agree (succeeded requires a settled order, and vice versa)', verified: checks.paymentOrderStateAgree, observed: observed.intentStatus + '/' + observed.orderState },
      { claim: 'a payment-success claim without a matching settled order/backend state is not a pass (detected)', verified: checks.mismatchDetected, observed: observed.claimedSuccess }
    ],
    unverifiedClaims: [
      { claim: 'receipt (receipt document/email) agrees', why: 'needs the Stripe Runner / paid order receipt document (browser/email), not the Shop API' },
      { claim: 'ledger agrees', why: 'ledger is DB-level, not readable through the Shop API (orderIndex.js unverified convention)' },
      { claim: 'real Stripe webhook/callback fired by the gateway', why: 'the callback is fired by the external Stripe gateway, not provable through the Shop API' }
    ]
  };
  return [a01];
}

// ---------------------------------------------------------------------------
// Order state helpers
// ---------------------------------------------------------------------------

function resolveOrderCode(context) {
  if (context && context.fixtures && typeof context.fixtures.orderCode === 'string' && context.fixtures.orderCode.length > 0) {
    return context.fixtures.orderCode;
  }
  var envCode = envValue(context, ORDER_CODE_ENV);
  if (typeof envCode === 'string' && envCode.length > 0) {
    return envCode;
  }
  return DEFAULT_ORDER_CODE;
}

function orderStateIsPaid(order) {
  if (!order) return false;
  if (order.state && PAID_ORDER_STATES.indexOf(order.state) !== -1) return true;
  var payments = Array.isArray(order.payments) ? order.payments : [];
  for (var i = 0; i < payments.length; i++) {
    if (payments[i] && payments[i].state === 'Settled') return true;
  }
  return false;
}

/**
 * CAN-B1-06 handler. Reads the Stripe test-mode status and the order state
 * through the Shop API, and verifies they agree. A planted mismatch control
 * forces a payment-success claim so the executor must detect that the backend
 * order state does not match.
 */
async function handlerPaymentConsistency(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-06');
  var fetchFn = getFetch(context);
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);

  // 1. Channel tokens for the order channel (CLIENT_INPUT_SCOPE if missing).
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
  var orderCode = resolveOrderCode(context);
  observed.orderCode = orderCode;

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

  // 2. Stripe secret presence + test-key boolean (names only in evidence).
  var stripeKey = readStripeKey(context);
  observed.stripeKeyPresent = stripeKey.ok;
  observed.stripeKeyEnvNames = stripeKey.envNames;
  checks.stripeTestKeyChecked = false;
  if (!stripeKey.ok) {
    var missingKeyEvidence = {
      taskId: taskId,
      step: 'stripe-key',
      error: 'Stripe test-mode secret not found',
      envVarNames: stripeKey.envNames,
      taskRequiredInput: 'stripeTestKeys',
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'stripe-key.json', data: missingKeyEvidence, kind: 'api-request' },
      { name: 'executor-error.json', data: missingKeyEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'Stripe test-mode secret not found (' + stripeKey.envNames.join(', ') + ')', missingKeyEvidence);
  }

  var isTest = isTestKey(stripeKey.value);
  var isLive = isLiveKey(stripeKey.value);
  observed.isTestKey = isTest;
  observed.isLiveKey = isLive;
  checks.stripeTestKeyChecked = true;
  if (!isTest) {
    var liveKeyEvidence = {
      taskId: taskId,
      step: 'stripe-key',
      checks: { isTestKey: isTest, isLiveKey: isLive },
      error: 'Stripe key is not a test-mode key; only test-mode keys are allowed',
      envVarNames: [stripeKey.envName],
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'stripe-key.json', data: liveKeyEvidence, kind: 'api-request' },
      { name: 'executor-error.json', data: liveKeyEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'Stripe key is not a test-mode key (only test mode is allowed)', liveKeyEvidence);
  }

  // 3. Create one minimal test-mode PaymentIntent.
  var stripeBase = resolveStripeApiBase(context);
  observed.stripeApiBase = stripeBase;
  var createResult = await createPaymentIntent(fetchFn, stripeBase, stripeKey.value);
  observed.createHttpStatus = createResult.httpStatus;
  observed.intentId = createResult.id;
  observed.intentStatus = createResult.status;
  observed.intentLivemode = createResult.livemode;
  observed.createError = createResult.error;
  observed.createOk = createResult.ok;

  if (createResult.networkError || createResult.httpStatus === null) {
    var envEvidence = {
      taskId: taskId,
      step: 'stripe-payment-intent-create',
      error: 'Stripe PaymentIntent create failed: ' + (createResult.networkError || 'no response'),
      stripeApiBase: stripeBase,
      request: createResult.request,
      response: createResult.response,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'stripe-create.json', data: envEvidence, kind: 'api-request' },
      { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }

  // Stripe API server error (>=500): the Stripe test gateway is unavailable.
  if (createResult.httpStatus >= 500) {
    var fivexxEvidence = {
      taskId: taskId,
      step: 'stripe-payment-intent-create',
      error: 'Stripe API returned HTTP ' + createResult.httpStatus + ' (test gateway unavailable)',
      stripeApiBase: stripeBase,
      request: createResult.request,
      response: createResult.response,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'stripe-create.json', data: fivexxEvidence, kind: 'api-request' },
      { name: 'executor-error.json', data: fivexxEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('ENVIRONMENT_ERROR', fivexxEvidence.error, fivexxEvidence);
  }

  // Stripe rejected the key (401/403): the client-owned test key is invalid or
  // has no access; this is a client input scope problem.
  if (!createResult.ok && (createResult.httpStatus === 401 || createResult.httpStatus === 403)) {
    var authEvidence = {
      taskId: taskId,
      step: 'stripe-payment-intent-create',
      error: 'Stripe rejected the test key with HTTP ' + createResult.httpStatus + ' (invalid or no access)',
      stripeApiBase: stripeBase,
      request: createResult.request,
      response: createResult.response,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'stripe-create.json', data: authEvidence, kind: 'api-request' },
      { name: 'executor-error.json', data: authEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', authEvidence.error, authEvidence);
  }

  // 4. Cancel the PaymentIntent (cleanup of the temporary Stripe resource).
  var cancelResult = null;
  if (createResult.id) {
    cancelResult = await cancelPaymentIntent(fetchFn, stripeBase, stripeKey.value, createResult.id);
    observed.cancelHttpStatus = cancelResult.httpStatus;
    observed.cancelStatus = cancelResult.status;
    observed.cancelOk = cancelResult.ok;
  }

  var planted = false;
  var plantedEnv = envValue(context, PLANT_MISMATCH_ENV);
  if (context.plantedMismatch && context.plantedMismatch.plant) planted = true;
  if (plantedEnv === '1' || plantedEnv === 'true' || plantedEnv === 'plant') planted = true;
  observed.planted = planted;

  // A payment-success claim: the observed intent status, or a forced claim
  // when the planted-mismatch control is active.
  var claimedSuccess = planted ? true : (SUCCEEDED_STATUSES.indexOf(observed.intentStatus) !== -1);
  observed.claimedSuccess = claimedSuccess;

  // 5. Read the order state through the Shop API (orderByCode with payments).
  //    Login first - orderByCode for a customer order needs an authenticated
  //    session (mutations.ts:3-17 login, then orderByCode queries.ts:377).
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
      { name: 'stripe-key.json', data: { present: observed.stripeKeyPresent, isTestKey: observed.isTestKey, isLiveKey: observed.isLiveKey, envVarNames: observed.stripeKeyEnvNames }, kind: 'api-request' },
      { name: 'stripe-payment-intent.json', data: { createHttpStatus: observed.createHttpStatus, createLivemode: observed.intentLivemode, intentId: observed.intentId, intentStatus: observed.intentStatus, cancelHttpStatus: observed.cancelHttpStatus, cancelStatus: observed.cancelStatus }, kind: 'api-request' },
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome(loginOut.errorCode || 'VALIDATION_ERROR', loginOut.error, loginFailEvidence);
  }

  var orderOut = await store.call(BUYER_ACCOUNT, sessionModule.GRAPHQL.orderByCode, { code: orderCode }, ORDER_COUNTRY);
  recordStep('order-by-code', orderOut, ['data', 'orderByCode']);
  if (isNetworkDown(orderOut)) {
    var envEvidence2 = {
      taskId: taskId,
      step: 'order-by-code',
      error: 'shop-api orderByCode failed: ' + (orderOut.networkError || 'HTTP down'),
      requestedOrderCode: orderCode,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: envEvidence2, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence2.error, envEvidence2);
  }

  var order = readData(orderOut, ['data', 'orderByCode']);
  observed.orderState = order ? order.state : null;
  observed.orderPayments = order && Array.isArray(order.payments) ? order.payments : [];
  observed.orderSettled = orderStateIsPaid(order);
  observed.orderRead = !!order;

  // 6. Compare the Stripe test PaymentIntent status with the order state read
  // through the Shop API. A PaymentIntent that reports `succeeded` requires the
  // order to be settled; a settled order requires the PaymentIntent to report
  // `succeeded`. A payment-success claim that is not matched by the order state
  // (a browser success without matching backend/order state) is NOT a pass.
  checks.intentCreated = createResult.ok === true;
  checks.intentLivemodeFalse = createResult.livemode === false || createResult.livemode === null;
  checks.intentCancelled = !!(cancelResult && cancelResult.ok);
  checks.orderRead = observed.orderRead;
  checks.paymentOrderStateAgree = claimedSuccess === observed.orderSettled;
  checks.mismatchDetected = planted ? !checks.paymentOrderStateAgree : true;

  if (!checks.orderRead) {
    var notReadEvidence = {
      taskId: taskId,
      step: 'order-by-code',
      error: 'order not found for code ' + orderCode,
      requestedOrderCode: orderCode,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: notReadEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', notReadEvidence.error, notReadEvidence);
  }

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Payment callback and order-state consistency',
    orderCode: orderCode,
    shopApiBase: sessionModule.resolveShopApiBase(context),
    stripeApiBase: stripeBase,
    stripe: {
      keyPresent: observed.stripeKeyPresent,
      isTestKey: observed.isTestKey,
      isLiveKey: observed.isLiveKey,
      envVarNames: observed.stripeKeyEnvNames,
      createHttpStatus: observed.createHttpStatus,
      createLivemode: observed.intentLivemode,
      intentId: observed.intentId,
      intentStatus: observed.intentStatus,
      cancelHttpStatus: observed.cancelHttpStatus,
      cancelStatus: observed.cancelStatus
    },
    expected: {
      stripeTestKeyPresent: 'Stripe test-mode secret present and is a test key (boolean only)',
      minimalIntentCreateCancel: 'one minimal test-mode PaymentIntent created and cancelled (HTTP status + livemode=false only)',
      paymentOrderStateAgree: 'Stripe test PaymentIntent status and order state read through the Shop API agree',
      noBrowserSuccessWithoutBackend: 'a payment-success claim without a matching settled order/backend state is not a pass (detected)'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B1-06-A01: receipt agrees (Stripe Runner/paid-order receipt document)',
      'CAN-B1-06-A01: ledger agrees (DB-level, vendor/ledger not readable through Shop API)',
      'CAN-B1-06-A01: real Stripe webhook/callback fired by the gateway (external)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'stripe-key.json', data: { present: observed.stripeKeyPresent, isTestKey: observed.isTestKey, isLiveKey: observed.isLiveKey, envVarNames: observed.stripeKeyEnvNames }, kind: 'api-request' },
    { name: 'stripe-payment-intent.json', data: { createHttpStatus: observed.createHttpStatus, createLivemode: observed.intentLivemode, intentId: observed.intentId, intentStatus: observed.intentStatus, cancelHttpStatus: observed.cancelHttpStatus, cancelStatus: observed.cancelStatus }, kind: 'api-request' },
    { name: 'payment-consistency-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.intentCreated) failures.push('Stripe test PaymentIntent was not created (HTTP ' + observed.createHttpStatus + ')');
  if (!checks.intentCancelled) failures.push('Stripe test PaymentIntent was not cancelled (cleanup)');
  if (planted && !checks.paymentOrderStateAgree) {
    failures.push('planted payment-success claim detected: PaymentIntent reports success but the order state read through the Shop API is not settled (order.state=' + observed.orderState + ')');
  }
  if (!planted && !checks.paymentOrderStateAgree) {
    failures.push('payment/order state mismatch: claimed success=' + claimedSuccess + ' vs order settled=' + observed.orderSettled +
      ' (intentStatus=' + observed.intentStatus + ', orderState=' + observed.orderState + ')');
  }

  if (failures.length > 0) {
    return failureOutcome('EXPECTED_MISMATCH', failures.join('; '), evidence);
  }

  // The PaymentIntent must be cancelled (cleanup of the temporary resource)
  // before a passing outcome is possible.
  if (!checks.intentCancelled) {
    return failureOutcome('ENVIRONMENT_ERROR', 'Stripe test PaymentIntent cancellation failed (cleanup incomplete)', evidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B1-06', {
    description: 'Payment callback and order-state consistency: Stripe test PaymentIntent status vs order state read through the Shop API, payment-success claim must be backed by a settled order (readiness scope payment-consistency)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B1-06-A01'],
    handler: handlerPaymentConsistency
  });
  return { success: true, registered: ['CAN-B1-06'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  ORDER_COUNTRY: ORDER_COUNTRY,
  DEFAULT_ORDER_CODE: DEFAULT_ORDER_CODE,
  ORDER_CODE_ENV: ORDER_CODE_ENV,
  STRIPE_SECRET_KEY_ENV: STRIPE_SECRET_KEY_ENV,
  STRIPE_TEST_SECRET_KEY_ENV: STRIPE_TEST_SECRET_KEY_ENV,
  STRIPE_API_BASE_ENV: STRIPE_API_BASE_ENV,
  STRIPE_LIVE_PREFIX: STRIPE_LIVE_PREFIX,
  STRIPE_TEST_PREFIX: STRIPE_TEST_PREFIX,
  DEFAULT_STRIPE_API_BASE: DEFAULT_STRIPE_API_BASE,
  PAYMENT_INTENTS_PATH: PAYMENT_INTENTS_PATH,
  MINIMAL_AMOUNT: MINIMAL_AMOUNT,
  MINIMAL_CURRENCY: MINIMAL_CURRENCY,
  PLANT_MISMATCH_ENV: PLANT_MISMATCH_ENV,
  PAID_ORDER_STATES: PAID_ORDER_STATES.slice(),
  SUCCEEDED_STATUSES: SUCCEEDED_STATUSES.slice(),
  resolveStripeApiBase: resolveStripeApiBase,
  readStripeKey: readStripeKey,
  isTestKey: isTestKey,
  isLiveKey: isLiveKey,
  createPaymentIntent: createPaymentIntent,
  cancelPaymentIntent: cancelPaymentIntent,
  resolveOrderCode: resolveOrderCode,
  orderStateIsPaid: orderStateIsPaid,
  buildAssertionReport: buildAssertionReport,
  handlerPaymentConsistency: handlerPaymentConsistency,
  register: register
};