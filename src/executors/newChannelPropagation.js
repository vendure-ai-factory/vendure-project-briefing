'use strict';

/**
 * New-country propagation and full regression executor (CAN-B1-02).
 *
 * Verifies that a newly created OR enabled country Channel appears in the four
 * selectors:
 *   1. Product Country/Channel (search page country filter, country-filter.tsx)
 *   2. Customer Country in the profile (settings-form.tsx, activeCustomer)
 *   3. shipping-address country (CountrySelect, checkout shipping step)
 *   4. target sales country on the design-publication page (publishDesign).
 *
 * Safety rules (never relaxed):
 *   - Never create a Channel in production. The channel-creation step
 *     (onboardCountry, api-extensions.ts:13 / onboarding.service.ts:40-80)
 *     is skipped unless the run mode is the isolated staging clone. This
 *     executor checks channelCreationAllowed(context) and, when skipped,
 *     records the creation as unverified (SAFETY_AUTHORIZATION skip).
 *   - No publish/delist ever runs here (SAFETY_AUTHORIZATION skip unless run
 *     mode explicitly allows; the isolation requirement for destructive
 *     operations is never assumed).
 *
 * The regression list (publication, visibility, price/currency, wallet/rates,
 * tax, shipping, inventory, warehouse, cart, checkout, payment, orders,
 * receipts, account views, cross-channel orders) is long; run only the checks
 * that already have executors and list the rest as unverified. This executor
 * maps each regression area to the currently registered executors and reports
 * the areas with no executor as unverified.
 *
 * Admin identity (SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD or the STAGING_
 * aliases) is required. When absent the executor returns BLOCK
 * CLIENT_INPUT_SCOPE with preflight proof (env NAMES only, never values).
 *
 * Failure classes: selector mismatch -> EXPECTED_MISMATCH (APPLICATION_DEFECT);
 * Shop/Admin API down -> ENVIRONMENT_ERROR (DEPENDENCY_ENVIRONMENT); missing
 * admin/account password env var -> VALIDATION_ERROR (CLIENT_INPUT_SCOPE);
 * channel creation outside the isolated staging clone is never performed.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic account names from manifest/fixtures.v1.json (origin VERIFIED).
var CUSTOMER_ACCOUNT = 'buyer.one@example.com';
var CUSTOMER_COUNTRY = 'DE';

// Nominal "other country" option permitted in the Customer Country selector
// (settings-form.tsx:21 COUNTRY_INFO 'OTHER').
var OTHER_COUNTRY = 'OTHER';

// Admin credential env var NAMES only (values are never recorded).
var ADMIN_CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'STAGING_ADMIN_EMAIL',
  'STAGING_ADMIN_PASSWORD'
];

// The run mode that allows channel creation: an explicit isolated staging
// clone. Anything else skips creation for safety.
var ISOLATED_STAGING_CLONE_MODE = 'isolated-staging-clone';

// ---------------------------------------------------------------------------
// GraphQL documents (names and selection sets copied from migration-input,
// never guessed)
// ---------------------------------------------------------------------------

// Customer Country in profile selector (settings-form.tsx:95-110 feeds from
// this): GetAvailableCountries api.ts:40-44.
var PROFILE_COUNTRIES_QUERY = [
  'query GetAvailableCountries {',
  '  affiliateAvailableCountries',
  '}'
].join('\n');

// shipping-address country selector (checkout CountrySelect):
// GetAvailableCountries queries.ts:305-313.
var SHIPPING_COUNTRIES_QUERY = [
  'query GetAvailableCountries {',
  '  availableCountries {',
  '    id',
  '    code',
  '    name',
  '  }',
  '}'
].join('\n');

// Admin login (admin API) - copied from publish_product_v11.mjs:28-42 and
// admin_delist_products.mjs:32-46.
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

// Backend channel list (admin API) - copied from publish_product_v11.mjs:44-54.
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

// Channel-creation mutation (admin API extension) - copied from
// universal-onboarding/api/api-extensions.ts:3-15. Only invoked in the
// isolated staging clone run mode.
var ONBOARD_COUNTRY_MUTATION = [
  'mutation OnboardCountry($input: OnboardCountryInput!) {',
  '  onboardCountry(input: $input)',
  '}'
].join('\n');

// The Product Country/Channel selector list is a static storefront constant
// (api.ts:46-54 AVAILABLE_COUNTRIES consumed by country-filter.tsx:50-69).
// Static storefront lists cannot reflect a new backend channel without a
// storefront build, so runtime propagation to selector 1 is reported
// unverified (see handler).

// ---------------------------------------------------------------------------
// Regression areas mapped to the executors that already exist for them.
// ---------------------------------------------------------------------------

var REGRESSION_AREAS = [
  { area: 'publication', executors: [], note: 'CAN-B2-01/B2-02 have no executor' },
  { area: 'visibility', executors: [], note: 'no visibility executor' },
  { area: 'price/currency', executors: ['CAN-B1-01', 'CAN-B2-05'], note: 'countryBoundary + standardProduct' },
  { area: 'wallet/rates', executors: ['CAN-B1-08'], note: 'customerCountrySelector' },
  { area: 'tax', executors: [], note: 'CAN-B2-14 has no executor' },
  { area: 'shipping', executors: ['CAN-B2-16'], note: 'shippingDryRun (script dry-run)' },
  { area: 'inventory', executors: [], note: 'CAN-B2-12 has no executor' },
  { area: 'warehouse', executors: [], note: 'CAN-B2-12 has no executor' },
  { area: 'cart', executors: ['CAN-B1-05'], note: 'cartChannelLock' },
  { area: 'checkout', executors: ['CAN-B1-05'], note: 'cartChannelLock' },
  { area: 'payment', executors: [], note: 'CAN-B1-06 has no executor' },
  { area: 'orders', executors: ['CAN-B2-09'], note: 'orderIndex' },
  { area: 'receipts', executors: [], note: 'receipt needs the Stripe Runner' },
  { area: 'account views', executors: ['CAN-B2-09'], note: 'orderIndex buyer view; CAN-B2-15 has no executor' },
  { area: 'cross-channel orders', executors: ['CAN-B2-09'], note: 'orderIndex cross-channel index still partly unverified' }
];

// ---------------------------------------------------------------------------
// Context helpers (delegate to the shared session module)
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
        opts.secrets['newChannelPropagationSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

function getEnvNamesOnly(context) {
  var env = getEnvFn(context)();
  var names = [];
  for (var i = 0; i < ADMIN_CREDENTIAL_ENV_NAMES.length; i++) {
    var name = ADMIN_CREDENTIAL_ENV_NAMES[i];
    var value = env[name];
    if (value !== undefined && value !== null && String(value).length > 0) {
      names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Admin API helpers (backend Channel oracle; creation gated by run mode)
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
 * Read the backend Channel list through the Admin API. Returns
 * { ok:true, channels:[{code,token}], ... } or { ok:false, error, ... }.
 * The password value is never recorded.
 */
async function readBackendChannels(context) {
  if (!hasAdminCredentials(context)) {
    return {
      ok: false,
      error: 'admin credentials absent',
      credentialNames: adminCredentialEnvNames(context)
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
    return { ok: false, error: 'admin-api login failed: ' + (loginCall.networkError || 'HTTP ' + loginCall.response.httpStatus), credentialNames: adminCredentialEnvNames(context), call: loginCall };
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
      var upper = code.toUpperCase();
      if (codes.indexOf(upper) === -1) codes.push(upper);
    }
  }
  return codes;
}

/**
 * Run-mode gate for channel creation. Returns true only for an explicit
 * isolated staging clone. Anything else is `false` so the executor never
 * creates a Channel outside the governed environment.
 */
function channelCreationAllowed(context) {
  if (context && context.runMode === ISOLATED_STAGING_CLONE_MODE) return true;
  if (context && context.runEnvRecord && context.runEnvRecord.runMode === ISOLATED_STAGING_CLONE_MODE) return true;
  if (context && context.deps && context.deps.runMode === ISOLATED_STAGING_CLONE_MODE) return true;
  var value = envValue(context, 'PIPELINE_RUN_MODE');
  return value === ISOLATED_STAGING_CLONE_MODE;
}

function resolveRunMode(context) {
  if (context && context.runMode) return context.runMode;
  if (context && context.runEnvRecord && context.runEnvRecord.runMode) return context.runEnvRecord.runMode;
  if (context && context.deps && context.deps.runMode) return context.deps.runMode;
  var value = envValue(context, 'PIPELINE_RUN_MODE');
  return value || 'default';
}

/**
 * Invoke onboardCountry (admin API extension) inside the isolated staging
 * clone. This is the only place a Channel may be created. Returns the call
 * result plus the redacted request/response for evidence.
 */
async function runOnboardCountry(context, url, token, input) {
  var call = await adminGraphqlRequest(context, url, ONBOARD_COUNTRY_MUTATION, { input: input }, token);
  return call;
}

// ---------------------------------------------------------------------------
// Regression coverage mapping
// ---------------------------------------------------------------------------

/**
 * Return the set of executor task ids installed in this pipeline run. Prefers
 * an injected registry (context.deps.executorModule) so tests can control it;
 * treated as unavailable when nothing is injectable.
 */
function installedExecutorIds(context) {
  var reg = context && context.deps && context.deps.executorModule;
  if (reg && typeof reg.listTaskExecutors === 'function') {
    try { return reg.listTaskExecutors(); } catch (e) { return []; }
  }
  return null;
}

/**
 * Map every regression area to whether an executor for it is installed.
 * Adds the task ids found live when the registry is available; otherwise the
 * static known mapping is used with a note that registry lookup was skipped.
 */
function regressionCoverage(context) {
  var live = installedExecutorIds(context);
  var areas = [];
  for (var i = 0; i < REGRESSION_AREAS.length; i++) {
    var item = REGRESSION_AREAS[i];
    var executors = item.executors.slice();
    var present = [];
    var absent = [];
    var liveLookup = live !== null;
    for (var j = 0; j < executors.length; j++) {
      var id = executors[j];
      if (id) {
        if (liveLookup) {
          if (live.indexOf(id) !== -1) present.push(id);
          else absent.push(id);
        } else {
          // No live registry: the static mapping says the executor is expected.
          present.push(id);
        }
      }
    }
    areas.push({
      area: item.area,
      expectedExecutors: executors,
      present: present,
      absent: absent.length > 0 ? absent : [],
      note: item.note,
      coveredByExecutor: present.length > 0,
      registryLookup: liveLookup ? 'live' : 'static'
    });
  }
  return areas;
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

function buildAssertionReport(observed, checks, regressionAreas) {
  var regression = Array.isArray(regressionAreas) ? regressionAreas : regressionCoverage(null);
  var regressionVerified = regression.filter(function(r) { return r.coveredByExecutor; });
  var regressionUnverified = regression.filter(function(r) { return !r.coveredByExecutor; });

  var a01 = {
    id: 'CAN-B1-02-A01',
    verified: checks.propagationVerified,
    summary: 'An enabled country Channel (oracle from the Admin API channel list) appears in the Shop-exposed selectors: Customer Country in the profile (affiliateAvailableCountries, api.ts:40-44) and shipping-address country (availableCountries, queries.ts:305-313). The Product Country/Channel selector is a static storefront constant (api.ts:46-54, country-filter.tsx:50-69) and cannot reflect a new backend channel without a storefront build; the design-publication target sales country has no UI and no server-side publishDesign in the snapshot. Channel creation via onboardCountry (api-extensions.ts:13) is skipped unless the run mode is the isolated staging clone.',
    verifiedClaims: [
      { claim: 'enabled backend channel list read through the Admin API', verified: checks.adminChannelsRead, observed: observed.backendCountryList },
      { claim: 'Customer Country in the profile selector (affiliateAvailableCountries) lists the enabled channels', verified: checks.profileSelectorMatches, observed: observed.profileSelector },
      { claim: 'shipping-address country selector (availableCountries) lists the enabled channels', verified: checks.shippingSelectorMatches, observed: observed.shippingSelector },
      { claim: 'Customer Country read from activeCustomer.customFields.countryCode', verified: checks.customerCountryIsDe, observed: observed.customerCountry }
    ],
    unverifiedClaims: [
      { claim: 'a newly created Channel appears in the selectors', why: 'channel creation skipped (run mode ' + observed.runMode + '; onboardCountry requires the isolated staging clone)' },
      { claim: 'Product Country/Channel selector reflects backend channels', why: 'static storefront AVAILABLE_COUNTRIES (api.ts:46-54) needs a storefront build' },
      { claim: 'target sales country on the design-publication page', why: 'no such page and no server-side publishDesign in migration-input' }
    ]
  };
  var a02 = {
    id: 'CAN-B1-02-A02',
    verified: false,
    summary: 'The four lists changed (the regression list) and publication, visibility, price/currency, wallet/rates, tax, shipping, inventory, warehouse, cart, checkout, payment, order, receipt, account, and cross-channel behavior must be retested. Only the checks that already have executors are runnable here; the rest are listed unverified.',
    verifiedClaims: [
      { claim: 'regression areas with an existing executor are identified', verified: regressionVerified.length > 0, observed: regressionVerified.map(function(r) { return r.area; }) }
    ],
    unverifiedClaims: regressionUnverified.length > 0
      ? regressionUnverified.map(function(r) {
          return { claim: 'regression area: ' + r.area, why: 'no installed executor (' + r.note + ')' };
        })
      : []
  };
  var a03 = {
    id: 'CAN-B1-02-A03',
    verified: checks.creationSkipped,
    summary: 'Channel creation safety: onboardCountry is only permitted in the isolated staging clone; in every other run mode the creation step is skipped and recorded, and no Channel is created in production.',
    verifiedClaims: [
      { claim: 'channel-creation step did not run outside the isolated staging clone', verified: checks.creationSkipped, observed: { runMode: observed.runMode, channelCreationAllowed: observed.channelCreationAllowed } }
    ],
    unverifiedClaims: [
      { claim: 'a real new Channel was created and propagated', why: observed.creationSkipped ? 'creation skipped (not the isolated staging clone)' : 'creation not performed in this run' }
    ]
  };
  return [a01, a02, a03];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * CAN-B1-02 handler. Read-heavy check of new-country propagation using the
 * shared session store and the Admin Channel oracle:
 *   1. Validate admin identity; if absent, BLOCK CLIENT_INPUT_SCOPE with
 *      preflight proof (env NAMES only).
 *   2. Resolve channel tokens.
 *   3. Login the DE customer.
 *   4. Read the backend Channel list through the Admin API (oracle of enabled
 *      channels). A failure is DEPENDENCY_ENVIRONMENT unless credentials
 *      absent (handled in step 1).
 *   5. Read the two Shop selectors: profile (affiliateAvailableCountries) and
 *      shipping-address (availableCountries), and Customer Country.
 *   6. Channel creation: skipped unless isolated staging clone AND an input
 *      country is provided; otherwise recorded as skipped/unverified. No
 *      publish/delist is ever performed here.
 *   7. Map the regression list to installed executors and report unverified
 *      areas.
 */
async function handlerNewChannelPropagation(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-02');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);
  var runMode = resolveRunMode(context);
  var creationAllowed = channelCreationAllowed(context);

  // 1. Admin identity is required for the oracle channel list. When absent,
  // the run is blocked CLIENT_INPUT_SCOPE with preflight proof (env NAMES
  // only, values never recorded).
  if (!hasAdminCredentials(context)) {
    var preflight = {
      blocked: true,
      failureClass: 'CLIENT_INPUT_SCOPE',
      reason: 'admin identity absent (SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD or STAGING_ADMIN_EMAIL/STAGING_ADMIN_PASSWORD env vars)',
      envNamesChecked: getEnvNamesOnly(context),
      credentialNamesPresent: adminCredentialEnvNames(context),
      note: 'preflight proof: required admin identity env vars checked by name only',
      completedAt: timestamp
    };
    var blockEvidence = {
      taskId: taskId,
      source: 'ADMIN_IDENTITY',
      preflight: preflight,
      runMode: runMode,
      channelCreationAllowed: creationAllowed,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: blockEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'admin identity absent; blocked CLIENT_INPUT_SCOPE', blockEvidence);
  }

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

  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];

  observed.runMode = runMode;
  observed.channelCreationAllowed = creationAllowed;

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

  // 3. login as the DE customer.
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
    writeApiEvidence();
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(loginOut, taskId, loginFailEvidence);
  }

  // 4. read the backend Channel list (oracle of enabled channels).
  var backend = await readBackendChannels(context);
  observed.backendComparison = {};
  if (!backend.ok) {
    observed.backendComparison.state = 'failed';
    observed.backendComparison.error = backend.error;
    observed.backendComparison.credentialNames = backend.credentialNames || [];
    checks.adminChannelsRead = false;
  } else {
    observed.backendComparison.state = 'compared';
    observed.backendComparison.channels = backend.channels;
    observed.backendComparison.credentialNames = backend.credentialNames;
    checks.adminChannelsRead = true;
  }
  var backendCountryList = normalizeBackendCountryList(observed.backendComparison.channels || []);
  observed.backendCountryList = backendCountryList.length > 0 ? backendCountryList : null;

  if (!checks.adminChannelsRead) {
    var oracleFail = {
      taskId: taskId,
      source: 'ADMIN_ORACLE',
      error: observed.backendComparison.error,
      credentialNames: observed.backendComparison.credentialNames || [],
      runMode: runMode,
      checks: Object.assign({}, checks, { adminChannelsRead: false }),
      completedAt: timestamp
    };
    writeApiEvidence();
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: oracleFail, kind: 'executor-error' }
    ], secrets);
    var isEnv = observed.backendComparison.error && observed.backendComparison.error.indexOf('admin-api login failed') !== -1;
    if (isEnv) {
      return failureOutcome('ENVIRONMENT_ERROR', 'admin-api oracle unavailable: ' + observed.backendComparison.error, oracleFail);
    }
    return failureOutcome('VALIDATION_ERROR', 'admin-api oracle unavailable: ' + observed.backendComparison.error, oracleFail);
  }

  // 5. read the two Shop selectors plus the Customer Country.
  var profileOut = await store.call(CUSTOMER_ACCOUNT, PROFILE_COUNTRIES_QUERY, {}, CUSTOMER_COUNTRY);
  recordStep('profile-countries', profileOut, ['data', 'affiliateAvailableCountries']);
  if (isNetworkDown(profileOut)) {
    var envEvidence = {
      taskId: taskId, step: 'profile-countries',
      error: 'shop-api affiliateAvailableCountries failed: ' + (profileOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }
  var profileSelector = readData(profileOut, ['data', 'affiliateAvailableCountries']);
  observed.profileSelector = Array.isArray(profileSelector) ? profileSelector.slice() : null;
  checks.profileSelectorRead = Array.isArray(profileSelector) && profileSelector.length > 0;
  checks.profileSelectorMatches = Array.isArray(observed.backendCountryList) &&
    observed.backendCountryList.every(function(code) { return profileSelector.indexOf(code) !== -1 || profileSelector.indexOf(code.toLowerCase()) !== -1; });

  var shippingOut = await store.call(CUSTOMER_ACCOUNT, SHIPPING_COUNTRIES_QUERY, {}, CUSTOMER_COUNTRY);
  recordStep('shipping-countries', shippingOut, ['data', 'availableCountries']);
  if (isNetworkDown(shippingOut)) {
    var envEvidence2 = {
      taskId: taskId, step: 'shipping-countries',
      error: 'shop-api availableCountries failed: ' + (shippingOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence2.error, envEvidence2);
  }
  var shippingCountries = readData(shippingOut, ['data', 'availableCountries']);
  var shippingCodes = Array.isArray(shippingCountries)
    ? shippingCountries.map(function(c) { return c && c.code; }).filter(function(c) { return typeof c === 'string'; })
    : null;
  observed.shippingSelector = shippingCodes ? shippingCodes.slice() : null;
  checks.shippingSelectorRead = shippingCodes !== null && shippingCodes.length > 0;
  checks.shippingSelectorMatches = Array.isArray(observed.backendCountryList) &&
    observed.backendCountryList.every(function(code) { return shippingCodes.indexOf(code) !== -1 || shippingCodes.indexOf(code.toLowerCase()) !== -1; });

  var profileOut2 = await store.activeCustomer(CUSTOMER_ACCOUNT, CUSTOMER_COUNTRY);
  recordStep('profile', profileOut2, ['data', 'activeCustomer']);
  if (isNetworkDown(profileOut2)) {
    var envEvidence3 = {
      taskId: taskId, step: 'profile',
      error: 'shop-api profile failed: ' + (profileOut2.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence3.error, envEvidence3);
  }
  var customerCountry = readData(profileOut2, ['data', 'activeCustomer', 'customFields', 'countryCode']);
  observed.customerCountry = customerCountry || null;
  checks.customerCountryIsDe = customerCountry === CUSTOMER_COUNTRY;

  // 6. channel creation: only in the isolated staging clone and only when a
  // new-country input is supplied; otherwise record the skip. No publish or
  // delist is ever performed here.
  var newChannelInput = (context && context.newChannelInput) || (context && context.deps && context.deps.newChannelInput) || null;
  observed.creationSkipped = true;
  observed.creationReason = null;
  if (creationAllowed) {
    if (newChannelInput && typeof newChannelInput.countryCode === 'string') {
      var url = adminApiUrl(context);
      var env2 = getEnvFn(context)();
      var u2 = env2.SUPERADMIN_USERNAME || env2.STAGING_ADMIN_EMAIL || '';
      var p2 = env2.SUPERADMIN_PASSWORD || env2.STAGING_ADMIN_PASSWORD || '';
      var adminLogin = await adminGraphqlRequest(context, url, ADMIN_LOGIN_MUTATION, { username: u2, password: p2 }, null);
      var adminToken = adminLogin.authToken;
      if (adminToken) {
        var rebootCall = await runOnboardCountry(context, url, adminToken, newChannelInput);
        observed.creationSkipped = false;
        observed.creationCall = {
          httpStatus: rebootCall.response ? rebootCall.response.httpStatus : null,
          body: rebootCall.response ? rebootCall.response.body : null
        };
        observed.creationReason = rebootCall.networkError || (rebootCall.response && rebootCall.response.httpStatus >= 500 ? 'HTTP ' + rebootCall.response.httpStatus : null);
      } else {
        observed.creationReason = 'admin token unavailable for onboardCountry';
      }
    } else {
      observed.creationReason = 'no new-country input supplied for onboardCountry';
    }
  } else {
    observed.creationReason = 'run mode ' + runMode + ' is not ' + ISOLATED_STAGING_CLONE_MODE + '; channel creation skipped (SAFETY)';
  }
  checks.creationSkipped = observed.creationSkipped === true;

  // 7. regression coverage mapping.
  var regressionAreas = regressionCoverage(context);
  observed.regression = regressionAreas;
  checks.regressionCoveredCount = regressionAreas.filter(function(r) { return r.coveredByExecutor; }).length;
  checks.regressionUncoveredCount = regressionAreas.filter(function(r) { return !r.coveredByExecutor; }).length;
  observed.propagationVerified = checks.profileSelectorMatches && checks.shippingSelectorMatches && checks.customerCountryIsDe;

  var assertionReport = buildAssertionReport(observed, checks, regressionAreas);
  var evidence = {
    taskId: taskId,
    title: 'New-country propagation and full regression for CAN-B1-02',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    adminApiUrl: adminApiUrl(context),
    runMode: runMode,
    channelCreationAllowed: creationAllowed,
    customerAccount: CUSTOMER_ACCOUNT,
    customerCountry: CUSTOMER_COUNTRY,
    expected: {
      enabledChannels: 'the enabled Channel set read from the Admin API appears in the Customer Country profile selector (affiliateAvailableCountries) and the shipping-address country selector (availableCountries); creation only via onboardCountry in the isolated staging clone',
      regression: 'only the checks that already have executors are runnable; the rest are unverified'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B1-02-A01: newly created Channel propagation (creation skipped, run mode ' + runMode + ')',
      'CAN-B1-02-A01: Product Country/Channel selector (static storefront AVAILABLE_COUNTRIES, api.ts:46-54)',
      'CAN-B1-02-A01: target sales country on the design-publication page (no page / no server publishDesign in migration-input)',
      'CAN-B1-02-A02: regression areas with no executor: ' + regressionAreas.filter(function(r) { return !r.coveredByExecutor; }).map(function(r) { return r.area; }).join(', ')
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'new-channel-propagation-table.json', data: { expected: evidence.expected, observed: observed, checks: checks, regression: regressionAreas }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.adminChannelsRead) {
    failures.push('enabled backend channel list could not be read (' + observed.backendComparison.error + ')');
  }
  if (!checks.profileSelectorRead) {
    failures.push('Customer Country profile selector could not be read');
  } else if (Array.isArray(observed.backendCountryList) && !checks.profileSelectorMatches) {
    failures.push('profile selector does not list every enabled channel: expected ' + JSON.stringify(observed.backendCountryList) + ' got ' + JSON.stringify(observed.profileSelector));
  }
  if (!checks.shippingSelectorRead) {
    failures.push('shipping-address country selector could not be read');
  } else if (Array.isArray(observed.backendCountryList) && !checks.shippingSelectorMatches) {
    failures.push('shipping-address selector does not list every enabled channel: expected ' + JSON.stringify(observed.backendCountryList) + ' got ' + JSON.stringify(observed.shippingSelector));
  }
  if (!checks.customerCountryIsDe) {
    failures.push('Customer Country mismatch: expected ' + CUSTOMER_COUNTRY + ' got ' + observed.customerCountry);
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    return failureOutcome('EXPECTED_MISMATCH', 'new-country propagation mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B1-02', {
    description: 'New-country propagation: enabled country Channel appears in the Shop-exposed selectors (Customer Country in profile, shipping-address country) plus regression executor mapping; channel creation skipped unless isolated staging clone (readiness scope new-channel)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B1-02-A01', 'CAN-B1-02-A03'],
    handler: handlerNewChannelPropagation
  });
  return { success: true, registered: ['CAN-B1-02'] };
}

module.exports = {
  ISOLATED_STAGING_CLONE_MODE: ISOLATED_STAGING_CLONE_MODE,
  CUSTOMER_ACCOUNT: CUSTOMER_ACCOUNT,
  CUSTOMER_COUNTRY: CUSTOMER_COUNTRY,
  OTHER_COUNTRY: OTHER_COUNTRY,
  ADMIN_CREDENTIAL_ENV_NAMES: ADMIN_CREDENTIAL_ENV_NAMES.slice(),
  PROFILE_COUNTRIES_QUERY: PROFILE_COUNTRIES_QUERY,
  SHIPPING_COUNTRIES_QUERY: SHIPPING_COUNTRIES_QUERY,
  ADMIN_LOGIN_MUTATION: ADMIN_LOGIN_MUTATION,
  ADMIN_CHANNELS_QUERY: ADMIN_CHANNELS_QUERY,
  ONBOARD_COUNTRY_MUTATION: ONBOARD_COUNTRY_MUTATION,
  REGRESSION_AREAS: REGRESSION_AREAS,
  hasAdminCredentials: hasAdminCredentials,
  adminCredentialEnvNames: adminCredentialEnvNames,
  adminApiUrl: adminApiUrl,
  adminGraphqlRequest: adminGraphqlRequest,
  readBackendChannels: readBackendChannels,
  normalizeBackendCountryList: normalizeBackendCountryList,
  channelCreationAllowed: channelCreationAllowed,
  resolveRunMode: resolveRunMode,
  runOnboardCountry: runOnboardCountry,
  installedExecutorIds: installedExecutorIds,
  regressionCoverage: regressionCoverage,
  buildAssertionReport: buildAssertionReport,
  handlerNewChannelPropagation: handlerNewChannelPropagation,
  register: register
};
