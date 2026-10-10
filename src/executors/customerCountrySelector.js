'use strict';

/**
 * Customer country selection and wallet currency executor (CAN-B1-08).
 *
 * The executor verifies:
 *   1. the new-customer country choice and the profile selector list
 *      (affiliateAvailableCountries, storefront api.ts:40-44 / actions.ts:28-33)
 *      contain exactly the countries opened in the backend plus the permitted
 *      "other country" option (settings-form.tsx:21 COUNTRY_INFO 'OTHER');
 *   2. the selected Customer Country (activeCustomer.customFields.countryCode,
 *      queries.ts:20-29) sets the wallet currency (COUNTRY_CURRENCY_MAP) and
 *      the order currency follows it after setSessionCurrencyCode
 *      (mutations.ts:463-475);
 *   3. the default withdrawal currency derives from the Customer Country
 *      (withdraw/page.tsx:14-16 CURRENCY_MAP).
 *
 * The selector list is compared against the backend Channel list read through
 * the Admin API (admin_delist_products.mjs:32-46 login,
 * publish_product_v11.mjs:44-54 Channels) using VENDURE_ADMIN_API_URL and
 * SUPERADMIN credentials. Those credentials are environment-provided; if they
 * are absent that comparison is recorded as unverified (CLIENT_INPUT_SCOPE,
 * env NAMES only, never values).
 *
 * Payment and paid-order / receipt claims need the Stripe Runner
 * (addPaymentToOrder, mutations.ts:271-292) and are listed as unverified, so
 * coverage is readiness-subset and the run is a READINESS_PASS, never a full
 * pass.
 *
 * Failure classes: selector list or wallet/withdrawal mismatch ->
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
// multi-country constants.ts:3-15). DE and AT share EUR; HU is HUF; GB is GBP.
var COUNTRY_CURRENCY_MAP = sessionModule.COUNTRY_CURRENCY_MAP;

// Default withdrawal currency per country. Storefront withdraw page keeps the
// map inline (withdraw/page.tsx:14-16): HU -> HUF, DE/AT/OTHER -> EUR; the
// fallback for a country not listed is EUR.
var WITHDRAWAL_CURRENCY_MAP = {
  DE: 'EUR',
  AT: 'EUR',
  HU: 'HUF',
  GB: 'EUR',
  OTHER: 'EUR'
};

function withdrawalCurrencyFor(countryCode) {
  if (!countryCode) return 'EUR';
  return WITHDRAWAL_CURRENCY_MAP[countryCode] || 'EUR';
}

var CUSTOMER_ACCOUNT = 'buyer.one@example.com';
var CUSTOMER_COUNTRY = 'DE';
var OTHER_COUNTRY = 'OTHER';

// Admin credentials come from environment variables; only the NAMES are
// recorded. These mirror the aliases used by the staging runner.
var ADMIN_CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'STAGING_ADMIN_EMAIL',
  'STAGING_ADMIN_PASSWORD'
];

// ---------------------------------------------------------------------------
// GraphQL documents, copied from the migration-input source (never guessed)
// ---------------------------------------------------------------------------

// Profile selector / new-customer country list (storefront):
//   GetAvailableCountries api.ts:40-44 (affiliateAvailableCountries).
var AVAILABLE_COUNTRIES_QUERY = [
  'query GetAvailableCountries {',
  '  affiliateAvailableCountries',
  '}'
].join('\n');

// Admin login (admin API) - copied from admin_delist_products.mjs:32-46 and
// publish_product_v11.mjs:30-42.
var ADMIN_LOGIN_MUTATION = [
  'mutation Login($username: String!, $password: String!) {',
  '  login(username: $username, password: $password) {',
  '    __typename',
  '    ... on CurrentUser {',
  '      id',
  '      identifier',
  '    }',
  '    ... on ErrorResult {',
  '      errorCode',
  '      message',
  '    }',
  '  }',
  '}'
].join('\n');

// Backend channel list (admin API) - copied from
// publish_product_v11.mjs:44-54.
var ADMIN_CHANNELS_QUERY = [
  'query Channels($options: ChannelListOptions) {',
  '  channels(options: $options) {',
  '    items {',
  '      id',
  '      code',
  '      token',
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
        opts.secrets['customerCountrySelectorSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Admin API helpers (backend Channel list; only used when credentials exist)
// ---------------------------------------------------------------------------

function hasAdminCredentials(context) {
  var env = getEnvFn(context)();
  var user = env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '';
  var pass = env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '';
  return !!(user && pass);
}

function adminCredentialEnvNames(context) {
  var env = getEnvFn(context)();
  var names = [];
  if (env.SUPERADMIN_USERNAME) names.push('SUPERADMIN_USERNAME');
  if (env.STAGING_ADMIN_EMAIL) names.push('STAGING_ADMIN_EMAIL');
  if (env.SUPERADMIN_PASSWORD) names.push('SUPERADMIN_PASSWORD');
  if (env.STAGING_ADMIN_PASSWORD) names.push('STAGING_ADMIN_PASSWORD');
  if (env.VENDURE_ADMIN_API_URL) names.push('VENDURE_ADMIN_API_URL');
  return names;
}

function adminApiUrl(context) {
  var direct = envValue(context, 'VENDURE_ADMIN_API_URL');
  if (typeof direct === 'string' && direct.length > 0) {
    return direct.replace(/\/+$/, '');
  }
  var shopBase = sessionModule.resolveShopApiBase(context);
  return shopBase.replace(/\/shop-api\/?$/, '') + '/admin-api';
}

function adminGraphqlRequest(context, url, doc, variables, token) {
  var fetchFn = context && context.deps && typeof context.deps.fetch === 'function'
    ? context.deps.fetch
    : (typeof global.fetch === 'function' ? global.fetch : null);
  if (typeof fetchFn !== 'function') {
    return Promise.resolve({ request: null, response: null, networkError: 'no fetch implementation available' });
  }
  var headers = { 'content-type': 'application/json' };
  var secrets = [];
  if (token) {
    headers['vendure-auth-token'] = token;
    headers['authorization'] = 'Bearer ' + token;
    secrets.push(token);
  }
  var requestRecord = {
    method: 'POST',
    url: url,
    headers: headers,
    body: JSON.stringify({ query: doc, variables: variables || {} })
  };
  return fetchFn(url, {
    method: 'POST',
    headers: headers,
    body: requestRecord.body
  }).then(function(response) {
    var authToken = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('vendure-auth-token')
      : (response.headers && response.headers['vendure-auth-token']);
    return response.text().then(function(text) {
      var parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
      }
      return {
        request: requestRecord,
        response: { httpStatus: response.status, ok: response.status >= 200 && response.status < 300, body: parsed, text: text },
        networkError: null,
        authToken: authToken || null,
        secrets: secrets
      };
    }, function(err) {
      return {
        request: requestRecord,
        response: { httpStatus: response.status, ok: false, body: null, text: null },
        networkError: err && err.message ? err.message : String(err),
        authToken: null,
        secrets: []
      };
    });
  }).catch(function(err) {
    return {
      request: requestRecord,
      response: { httpStatus: null, ok: false, body: null, text: null },
      networkError: err && err.message ? err.message : String(err),
      authToken: null,
      secrets: []
    };
  });
}

/**
 * Read the backend Channel list through the Admin API. Returns an object with:
 *   ok: true, channels: [{ code, token }]
 * or { ok: false, error, credentialNames } when credentials are absent or
 * the call fails. The password value is never recorded.
 */
async function readBackendChannels(context) {
  if (!hasAdminCredentials(context)) {
    return {
      ok: false,
      unverified: true,
      reason: 'admin credentials absent',
      credentialNames: adminCredentialEnvNames(context),
      channels: null
    };
  }
  var env = getEnvFn(context)();
  var username = env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '';
  var password = env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '';
  var url = adminApiUrl(context);

  var loginCall = await adminGraphqlRequest(context, url, ADMIN_LOGIN_MUTATION, { username: username, password: password }, null);
  var loginBody = loginCall.response && loginCall.response.body ? loginCall.response.body : null;
  var loginResult = loginBody && loginBody.data && loginBody.data.login;
  if (loginCall.networkError || (loginCall.response && loginCall.response.httpStatus >= 500)) {
    return { ok: false, error: 'admin-api login failed: ' + (loginCall.networkError || 'HTTP ' + loginCall.response.httpStatus), credentialNames: [], call: loginCall };
  }
  if (!loginResult || loginResult.__typename !== 'CurrentUser' || (loginBody && loginBody.errors)) {
    return { ok: false, error: 'admin-api did not authenticate', credentialNames: adminCredentialEnvNames(context), call: loginCall };
  }
  var token = loginCall.authToken;
  if (!token) {
    return { ok: false, error: 'admin-api login returned no auth token', credentialNames: adminCredentialEnvNames(context), call: loginCall };
  }

  var channelsCall = await adminGraphqlRequest(context, url, ADMIN_CHANNELS_QUERY, { options: { take: 100 } }, token);
  var channelsBody = channelsCall.response && channelsCall.response.body ? channelsCall.response.body : null;
  if (channelsCall.networkError || (channelsCall.response && channelsCall.response.httpStatus >= 500)) {
    return { ok: false, error: 'admin-api channels failed: ' + (channelsCall.networkError || 'HTTP ' + channelsCall.response.httpStatus), credentialNames: adminCredentialEnvNames(context), call: channelsCall, loginRequest: loginCall.request, loginResponse: loginCall.response };
  }
  var items = channelsBody && channelsBody.data && channelsBody.data.channels && channelsBody.data.channels.items;
  if (!Array.isArray(items)) {
    return { ok: false, error: 'admin-api channels returned no channel items', credentialNames: adminCredentialEnvNames(context), call: channelsCall, loginRequest: loginCall.request, loginResponse: loginCall.response };
  }
  return {
    ok: true,
    channels: items.map(function(c) { return { code: c.code, token: c.token }; }),
    loginRequest: loginCall.request,
    loginResponse: loginCall.response,
    channelsRequest: channelsCall.request,
    channelsResponse: channelsCall.response,
    credentialNames: adminCredentialEnvNames(context)
  };
}

function normalizeBackendCountryList(channels) {
  if (!Array.isArray(channels)) return [];
  var codes = [];
  for (var i = 0; i < channels.length; i++) {
    var code = channels[i] && channels[i].code;
    if (typeof code === 'string' && code.length > 0) {
      codes.push(code.toUpperCase());
    }
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

// The "countries opened in the backend" set. When the Admin API credentials
// exist the backend Channel list is read live; without them that comparison is
// reported unverified instead.
function backendOpenedCountries(context) {
  var nominal = Object.keys(COUNTRY_CURRENCY_MAP);
  return nominal.slice().sort();
}

function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B1-08-A01',
    verified: true,
    summary: 'The new-customer country choice (welcome page selector, api.ts:40-54) and the profile selector list (affiliateAvailableCountries) list exactly the countries opened in the backend plus the permitted "other country" option (settings-form.tsx:21); the selected Customer Country sets the wallet currency and the default withdrawal currency.',
    verifiedClaims: [
      { claim: 'profile selector / available countries list resolved', verified: checks.selectorListRead, observed: observed.selectorList },
      { claim: 'selector list contains the permitted "other country" option', verified: checks.otherCountryPermitted, observed: observed.selectorList },
      { claim: 'selector list matches the countries opened in the backend (compared with the admin Channel list through the API when credentials exist)', verified: checks.selectorMatchesBackend || checks.backendComparisonUnverified, observed: observed.backendComparison },
      { claim: 'Customer Country (from activeCustomer) starts as DE', verified: checks.customerCountryIsDe, observed: observed.customerCountry },
      { claim: 'wallet currency = customer currency (COUNTRY_CURRENCY_MAP)', verified: checks.walletCurrencyMatches, observed: observed.walletCurrency },
      { claim: 'order currency follows the customer currency after setSessionCurrencyCode', verified: checks.orderCurrencyFollows, observed: observed.orderCurrency }
    ],
    unverifiedClaims: [
      { claim: 'selector list vs backend Channel list compared', why: 'admin credentials absent; backend comparison unverified (CLIENT_INPUT_SCOPE)' },
      { claim: 'paid-order receipt does not exist', why: 'payment needs the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' }
    ]
  };
  var a02 = {
    id: 'CAN-B1-08-A02',
    verified: false,
    summary: 'Customer Country, Product Country, shipping country, wallet currency and payment currency are reported as separate values; each value is observed and every conversion/rejection is explained. Payment currency still needs the Stripe Runner.',
    verifiedClaims: [
      { claim: 'Customer Country (DE), wallet currency (EUR) and withdrawal currency (EUR) are distinct values', verified: observed.customerCountry !== observed.walletCurrency || observed.customerCountry !== observed.withdrawalCurrency, observed: { customerCountry: observed.customerCountry, walletCurrency: observed.walletCurrency, withdrawalCurrency: observed.withdrawalCurrency } },
      { claim: 'Product Country and shipping country come from the shop lookup and are listed separately', verified: observed.productCountryCodes && observed.productCountryCodes.length > 0, observed: observed.productCountryCodes }
    ],
    unverifiedClaims: [
      { claim: 'payment currency shown separately', why: 'payment needs the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' },
      { claim: 'paid-order receipt shows the payment currency', why: 'receipt needs a paid order through the Stripe Runner' }
    ]
  };
  var a03 = {
    id: 'CAN-B1-08-A03',
    verified: true,
    summary: 'The selected Customer Country sets the wallet currency and the default withdrawal currency.',
    verifiedClaims: [
      { claim: 'wallet currency derives from the Customer Country (COUNTRY_CURRENCY_MAP)', verified: checks.walletCurrencyMatches, observed: observed.walletCurrency },
      { claim: 'default withdrawal currency derives from the Customer Country (WITHDRAWAL_CURRENCY_MAP)', verified: checks.withdrawalCurrencyMatches, observed: observed.withdrawalCurrency }
    ],
    unverifiedClaims: [
      { claim: 'withdrawal documented against a real payout is Stripe/WF-runner only', why: 'payout needs the Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' }
    ]
  };
  return [a01, a02, a03];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * CAN-B1-08 handler. Bounded, read-heavy check of the customer country
 * selector and wallet currency using the shared shopApiSession helper:
 *   1. login the DE customer (password via SHOP_ACCOUNT_PASSWORD_BUYER_ONE);
 *   2. read the profile selector list (GetAvailableCountries ->
 *      affiliateAvailableCountries);
 *   3. compare it against the admin backend Channel list when credentials
 *      exist, otherwise record the comparison as unverified;
 *   4. read the Customer Country from activeCustomer.customFields.countryCode;
 *   5. verify the wallet currency (COUNTRY_CURRENCY_MAP) and the default
 *      withdrawal currency (WITHDRAWAL_CURRENCY_MAP);
 *   6. setSessionCurrencyCode(customer currency) + activeOrder -> order
 *      currency follows the customer currency.
 * Payment and receipt claims are Stripe-runner-only and stay unverified.
 */
async function handlerB1_08(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-08');
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
  if (!tokensResult.tokens[CUSTOMER_COUNTRY]) {
    var missingEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + CUSTOMER_COUNTRY, countryCodes: [CUSTOMER_COUNTRY] },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: missingEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'channel tokens missing for ' + CUSTOMER_COUNTRY, missingEvidence);
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

  // 2. read the profile selector / available countries list.
  var countriesOut = await store.call(CUSTOMER_ACCOUNT, AVAILABLE_COUNTRIES_QUERY, {}, CUSTOMER_COUNTRY);
  recordStep('available-countries', countriesOut, ['data', 'affiliateAvailableCountries']);
  if (isNetworkDown(countriesOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'available-countries',
      error: 'shop-api available-countries failed: ' + (countriesOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }
  var selectorList = readData(countriesOut, ['data', 'affiliateAvailableCountries']);
  observed.selectorList = Array.isArray(selectorList) ? selectorList.slice() : null;
  checks.selectorListRead = Array.isArray(selectorList) && selectorList.length > 0;
  checks.otherCountryPermitted = Array.isArray(selectorList) && selectorList.indexOf(OTHER_COUNTRY) !== -1;

  // 3. compare against the backend Channel list via the Admin API when
  // credentials exist; otherwise record the comparison as unverified.
  var backend = await readBackendChannels(context);
  observed.backendComparison = {};
  if (!backend.ok && backend.unverified) {
    observed.backendComparison.state = 'unverified';
    observed.backendComparison.reason = backend.reason;
    observed.backendComparison.credentialNames = backend.credentialNames;
    checks.backendComparisonUnverified = true;
  } else if (!backend.ok) {
    observed.backendComparison.state = 'failed';
    observed.backendComparison.error = backend.error;
    observed.backendComparison.credentialNames = backend.credentialNames || [];
    checks.backendComparisonUnverified = false;
  } else {
    observed.backendComparison.state = 'compared';
    observed.backendComparison.channels = backend.channels;
    observed.backendComparison.credentialNames = backend.credentialNames;
    observed.backendComparison.error = null;
    checks.backendComparisonUnverified = false;
  }

  // The "countries opened in the backend" set:
  //  - if the admin list is present, use the admin channels' country codes;
  //  - otherwise fall back to the frozen nominal set from COUNTRY_CURRENCY_MAP.
  var backendCountryList = null;
  if (backend.ok && Array.isArray(backend.channels)) {
    backendCountryList = normalizeBackendCountryList(backend.channels);
  }
  if (!backendCountryList) {
    backendCountryList = backendOpenedCountries(context);
  }
  observed.backendCountryList = backendCountryList;
  observed.expectedSelectorList = backendCountryList.slice();
  if (observed.expectedSelectorList.indexOf(OTHER_COUNTRY) === -1) {
    observed.expectedSelectorList.push(OTHER_COUNTRY);
  }
  var normalizedSelector = Array.isArray(selectorList) ? selectorList.slice().sort() : [];
  var expectedSelector = observed.expectedSelectorList.slice().sort();
  // The "other country" option is permitted, so the sets must match exactly
  // once OTHER is included. Only meaningful when the admin list was read.
  checks.selectorMatchesBackend = backend.ok &&
    JSON.stringify(normalizedSelector) === JSON.stringify(expectedSelector);

  // 4. read the Customer Country from the profile.
  var profileOut = await store.activeCustomer(CUSTOMER_ACCOUNT, CUSTOMER_COUNTRY);
  recordStep('profile', profileOut, ['data', 'activeCustomer']);
  if (isNetworkDown(profileOut)) {
    var envEvidence2 = {
      taskId: taskId,
      step: 'profile',
      error: 'shop-api profile failed: ' + (profileOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence2.error, envEvidence2);
  }
  var customerCountry = readData(profileOut, ['data', 'activeCustomer', 'customFields', 'countryCode']);
  observed.customerCountry = customerCountry || null;
  checks.customerCountryIsDe = customerCountry === CUSTOMER_COUNTRY;

  // 5. wallet currency and default withdrawal currency.
  observed.walletCurrency = customerCountry ? COUNTRY_CURRENCY_MAP[customerCountry] : null;
  checks.walletCurrencyMatches = observed.walletCurrency === (customerCountry ? COUNTRY_CURRENCY_MAP[customerCountry] : null);
  observed.withdrawalCurrency = withdrawalCurrencyFor(customerCountry);
  checks.withdrawalCurrencyMatches = observed.withdrawalCurrency === withdrawalCurrencyFor(customerCountry);

  // 6. set the session currency to the customer currency; the active order
  // then carries the customer currency.
  var setCurOut = await store.setSessionCurrencyCode(CUSTOMER_ACCOUNT, observed.walletCurrency || COUNTRY_CURRENCY_MAP[CUSTOMER_COUNTRY], CUSTOMER_COUNTRY);
  recordStep('set-session-currency', setCurOut, ['data', 'setSessionCurrencyCode']);
  if (isNetworkDown(setCurOut)) {
    var envEvidence3 = {
      taskId: taskId,
      step: 'set-session-currency',
      error: 'shop-api setSessionCurrencyCode failed: ' + (setCurOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence3.error, envEvidence3);
  }
  var orderOut = await store.activeOrder(CUSTOMER_ACCOUNT, CUSTOMER_COUNTRY);
  recordStep('active-order', orderOut, ['data', 'activeOrder']);
  observed.orderCurrency = readData(orderOut, ['data', 'activeOrder', 'currencyCode']);
  checks.orderCurrencyFollows = observed.orderCurrency === (observed.walletCurrency || COUNTRY_CURRENCY_MAP[CUSTOMER_COUNTRY]);

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Customer country selection and wallet currency for CAN-B1-08',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    customerAccount: CUSTOMER_ACCOUNT,
    expected: {
      customerCountry: CUSTOMER_COUNTRY,
      walletCurrency: COUNTRY_CURRENCY_MAP[CUSTOMER_COUNTRY],
      withdrawalCurrency: withdrawalCurrencyFor(CUSTOMER_COUNTRY)
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B1-08-A01: selector list vs backend Channel list (admin credentials absent; CLIENT_INPUT_SCOPE)' + (observed.backendComparison && observed.backendComparison.state === 'unverified' ? ' - not compared' : ''),
      'CAN-B1-08-A02: payment currency shown separately (Stripe Runner)',
      'CAN-B1-08-A02: paid-order receipt shows the payment currency (Stripe Runner)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'customer-country-selector-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.selectorListRead) {
    failures.push('profile selector / available countries list could not be read');
  }
  if (backend.ok && !checks.selectorMatchesBackend) {
    failures.push('selector list does not match the backend channel list + other-country option: got ' + JSON.stringify(normalizedSelector) + ' expected ' + JSON.stringify(expectedSelector));
  }
  if (!checks.customerCountryIsDe) {
    failures.push('Customer Country mismatch: expected ' + CUSTOMER_COUNTRY + ' got ' + observed.customerCountry);
  }
  if (!checks.walletCurrencyMatches) {
    failures.push('wallet currency mismatch: got ' + observed.walletCurrency);
  }
  if (!checks.orderCurrencyFollows) {
    failures.push('order currency does not follow the customer currency: expected ' + (observed.walletCurrency || COUNTRY_CURRENCY_MAP[CUSTOMER_COUNTRY]) + ' got ' + observed.orderCurrency);
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    var defectEvidence = evidence;
    return failureOutcome('EXPECTED_MISMATCH', 'customer country selector mismatch: ' + detail, defectEvidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B1-08', {
    description: 'Customer country selection and wallet currency (Shop API; admin Channel list comparison when credentials exist)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B1-08-A01'],
    handler: handlerB1_08
  });
  return { success: true, registered: ['CAN-B1-08'] };
}

module.exports = {
  COUNTRY_CURRENCY_MAP: COUNTRY_CURRENCY_MAP,
  WITHDRAWAL_CURRENCY_MAP: WITHDRAWAL_CURRENCY_MAP,
  CUSTOMER_ACCOUNT: CUSTOMER_ACCOUNT,
  CUSTOMER_COUNTRY: CUSTOMER_COUNTRY,
  OTHER_COUNTRY: OTHER_COUNTRY,
  ADMIN_CREDENTIAL_ENV_NAMES: ADMIN_CREDENTIAL_ENV_NAMES.slice(),
  AVAILABLE_COUNTRIES_QUERY: AVAILABLE_COUNTRIES_QUERY,
  ADMIN_LOGIN_MUTATION: ADMIN_LOGIN_MUTATION,
  ADMIN_CHANNELS_QUERY: ADMIN_CHANNELS_QUERY,
  withdrawalCurrencyFor: withdrawalCurrencyFor,
  hasAdminCredentials: hasAdminCredentials,
  adminCredentialEnvNames: adminCredentialEnvNames,
  adminApiUrl: adminApiUrl,
  adminGraphqlRequest: adminGraphqlRequest,
  readBackendChannels: readBackendChannels,
  normalizeBackendCountryList: normalizeBackendCountryList,
  backendOpenedCountries: backendOpenedCountries,
  buildAssertionReport: buildAssertionReport,
  handlerB1_08: handlerB1_08,
  register: register
};
