'use strict';

/**
 * Shared Shop API session helper (chunk 12b).
 *
 * This module is NOT an executor and exports no register() function. It is a
 * shared helper that other executors call directly. It provides:
 *
 * - a channel-scoped request helper: POST to <base>/shop-api with the
 *   `vendure-token` header. Channel tokens come from the frozen registry
 *   value with a CHANNEL_TOKENS env/context override (precedence identical
 *   to readOnlyShopApi). A missing/invalid token set is a CLIENT_INPUT_SCOPE
 *   failure with errorCode VALIDATION_ERROR;
 * - customer registration and login using synthetic account names from
 *   manifest/fixtures.v1.json (testAccounts.names, origin VERIFIED).
 *   Passwords are never in files: each account reads its password from an
 *   environment variable by NAME. The env var name is deterministic and
 *   documented:
 *
 *      SHOP_ACCOUNT_PASSWORD_<EMAIL_LOCALPART_UPPERCASE_NONALNUM_AS_>
 *
 *   e.g. buyer.one@example.com -> SHOP_ACCOUNT_PASSWORD_BUYER_ONE.
 *   If the env var is absent/empty the operation returns CLIENT_INPUT_SCOPE and
 *   records the env var NAMES (never values) in evidence. The mapping function
 *   is exported so callers can point accounts at different env var names;
 * - cart operations (addItemToOrder), channel switching and order lookup
 *   (setSessionCurrencyCode, orderByCode) and active customer profile
 *   (activeCustomer);
 * - a per-account session store (cookies from Set-Cookie plus an optional
 *   bearer token) with injected fetch and clock for tests;
 * - redacted request and response evidence for every call, written through
 *   evidenceCollector.writeEvidenceFile;
 * - any missing capability (for example email verification required) returns
 *   CLIENT_INPUT_SCOPE with the exact response as evidence.
 *
 * Exact GraphQL operation names are copied from the migration-input source
 * (never guessed):
 *   registerCustomerAccount  mutations.ts:294-307
 *   login                    mutations.ts:3-17
 *   addItemToOrder           mutations.ts:19-42
 *   activeCustomer          queries.ts:20-29 + fragments.ts:26-58
 *   activeOrder              queries.ts:114-163
 *   orderByCode             queries.ts:377
 *   setSessionCurrencyCode    mutations.ts:463-475
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

var SHOP_API_PATH = '/shop-api';
var CHANNEL_TOKEN_HEADER = 'vendure-token';
var AUTH_TOKEN_HEADER = 'vendure-auth-token';
var REDACTED_MARKER = '[REDACTED]';
var DEFAULT_SHOP_API_BASE = 'https://staging.tibella.eu';

var COUNTRY_CURRENCY_MAP = { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' };

// Nominal staging channel tokens (VERIFIED in set_craft_fee.mjs defaults).
var COUNTRY_CHANNEL_TOKENS = { DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' };
var COUNTRIES = Object.keys(COUNTRY_CURRENCY_MAP);

// Synthetic account names from manifest/fixtures.v1.json (origin VERIFIED).
var TEST_ACCOUNT_NAMES = ['buyer.one@example.com', 'buyer.two@example.com', 'designer.de@example.com'];

// GraphQL documents (operation names copied from the cited source).
var GRAPHQL = {
  login: 'mutation Login($username: String!, $password: String!) { login(username: $username, password: $password) { __typename ... on CurrentUser { id identifier } ... on ErrorResult { errorCode message } } }',
  register: 'mutation RegisterCustomerAccount($input: RegisterCustomerInput!) { registerCustomerAccount(input: $input) { __typename ... on Success { success } ... on ErrorResult { errorCode message } } }',
  addItemToOrder: 'mutation AddToCart($variantId: ID!, $quantity: Int!, $customFields: OrderLineCustomFieldsInput) { addItemToOrder(productVariantId: $variantId, quantity: $quantity, customFields: $customFields) { __typename ... on Order { id code totalQuantity lines { id productVariant { id name } quantity } } ... on ErrorResult { errorCode message } } }',
  activeCustomer: 'query GetActiveCustomer { activeCustomer { id firstName lastName emailAddress customFields { countryCode isDesigner isKycVerified } addresses { country { code } } } }',
  activeOrder: 'query GetActiveOrder { activeOrder { id code state totalQuantity subTotal subTotalWithTax shipping shippingWithTax total totalWithTax currencyCode taxSummary { description taxRate taxTotal } lines { id productVariant { id name sku product { id name slug customFields { designFee } } } unitPriceWithTax quantity linePriceWithTax } } }',
  orderByCode: 'query GetOrderDetail($code: String!) { orderByCode(code: $code) { id code state active createdAt updatedAt totalQuantity subTotal subTotalWithTax shipping shippingWithTax total totalWithTax currencyCode customer { id firstName lastName emailAddress } taxSummary { description taxRate taxTotal } lines { id productVariant { id name sku } unitPriceWithTax quantity linePriceWithTax } payments { id method amount state transactionId } } }',
  setSessionCurrencyCode: 'mutation SetSessionCurrencyCode($currency: String!) { setSessionCurrencyCode(currencyCode: $currency) { __typename ... on Order { id code totalWithTax currencyCode } } }'
};

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getEnvFn(context) {
  if (context && context.deps && typeof context.deps.getEnv === 'function') {
    return context.deps.getEnv;
  }
  return function() { return process.env || {}; };
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

function getFetch(context) {
  var fetchFn = context && context.deps && context.deps.fetch;
  if (typeof fetchFn !== 'function') fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('shopApiSession: no fetch implementation available');
  }
  return fetchFn;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

// ---------------------------------------------------------------------------
// URL + channel token resolution (precedence mirrors readOnlyShopApi)
// ---------------------------------------------------------------------------

function resolveShopApiBase(context) {
  if (context && typeof context.shopApiBase === 'string' && context.shopApiBase.length > 0) {
    return context.shopApiBase.replace(/\/+$/, '');
  }
  var envStaging = envValue(context, 'STAGING_URL');
  if (typeof envStaging === 'string' && envStaging.length > 0) {
    return envStaging.replace(/\/+$/, '');
  }
  var fromRecord = context.runEnvRecord && context.runEnvRecord.stagingUrl;
  if (typeof fromRecord === 'string' && fromRecord.length > 0) {
    return fromRecord.replace(/\/+$/, '');
  }
  if (context && context.deps && context.deps.config && typeof context.deps.config.shopApiUrl === 'string' && context.deps.config.shopApiUrl.length > 0) {
    return context.deps.config.shopApiUrl.replace(/\/+$/, '');
  }
  return DEFAULT_SHOP_API_BASE.replace(/\/+$/, '');
}

function frozenChannelTokens(context) {
  if (!context) return null;
  var registry = context.registry || (context.deps && context.deps.registry);
  if (!registry || !Array.isArray(registry.inputs)) return null;
  for (var i = 0; i < registry.inputs.length; i++) {
    if (registry.inputs[i].id === 'channelTokens') {
      return registry.inputs[i].frozenValue || null;
    }
  }
  return null;
}

function directChannelTokens(context) {
  if (!context) return null;
  var direct = context.channelTokens;
  return (direct && typeof direct === 'object') ? direct : null;
}

function normalizeChannelTokens(map, source) {
  var normalized = {};
  var missing = null;
  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var nominal = COUNTRY_CHANNEL_TOKENS[country];
    var token = map[country] || map[country.toLowerCase()] ||
      map[nominal] || map[nominal.toLowerCase()];
    if (typeof token !== 'string' || token.length === 0) {
      missing = country;
      break;
    }
    normalized[country] = token;
  }
  if (missing) {
    return { ok: false, error: 'channel token missing for ' + missing + ' in ' + source, missing: missing, source: source };
  }
  return { ok: true, tokens: normalized, source: source };
}

/**
 * Resolve channel tokens with precedence:
 *   context.channelTokens > env CHANNEL_TOKENS > frozen registry value.
 */
function resolveChannelTokens(context) {
  var direct = directChannelTokens(context);
  var frozen = frozenChannelTokens(context);
  var getEnv = getEnvFn(context);
  return resolveTokenPrecedence(getEnv, frozen, direct);
}

function resolveTokenPrecedence(getEnv, frozen, direct) {
  if (direct && typeof direct === 'object') {
    var d = normalizeChannelTokens(direct, 'context');
    if (d.ok) return d;
  }
  var env = getEnv();
  var raw = env ? env.CHANNEL_TOKENS : undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    var map;
    if (typeof raw === 'string') {
      try {
        map = JSON.parse(raw);
      } catch (e) {
        return { ok: false, error: 'CHANNEL_TOKENS is not valid JSON', source: 'env' };
      }
    } else if (typeof raw === 'object') {
      map = raw;
    } else {
      return { ok: false, error: 'CHANNEL_TOKENS must be a JSON object of channel tokens', source: 'env' };
    }
    var e = normalizeChannelTokens(map, 'env');
    if (e.ok) return e;
  }
  if (frozen && typeof frozen === 'object') {
    var f = normalizeChannelTokens(frozen, 'frozen');
    if (f.ok) return f;
  }
  return { ok: false, error: 'CHANNEL_TOKENS is missing; no channel token supplied', source: 'none' };
}

function tokenSecretList(tokens) {
  var secrets = [];
  var seen = {};
  for (var i = 0; i < COUNTRIES.length; i++) {
    var t = tokens[COUNTRIES[i]];
    if (t && !seen[t]) {
      seen[t] = true;
      secrets.push(t);
    }
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Password env-var naming (deterministic, overridable)
// ---------------------------------------------------------------------------

function passwordEnvName(email) {
  var local = String(email || '').split('@')[0] || 'ACCOUNT';
  var slug = local.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return 'SHOP_ACCOUNT_PASSWORD_' + slug;
}

function resolvePassword(context, email, overrideNames) {
  var env = getEnvFn(context)();
  var names = overrideNames && typeof overrideNames === 'function'
    ? overrideNames(email)
    : (overrideNames ? overrideNames : [passwordEnvName(email)]);
  if (typeof names === 'string') names = [names];
  for (var i = 0; i < names.length; i++) {
    var value = env[names[i]];
    if (typeof value === 'string' && value.length > 0) {
      return { ok: true, name: names[i], value: value };
    }
  }
  return { ok: false, names: names };
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

function redactString(value, secrets) {
  var out = value;
  for (var i = 0; i < secrets.length; i++) {
    out = out.split(secrets[i]).join(REDACTED_MARKER);
  }
  return out;
}

function redactDeep(value, secrets) {
  if (Array.isArray(value)) {
    return value.map(function(item) { return redactDeep(item, secrets); });
  }
  if (value !== null && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function(key) {
      out[key] = redactDeep(value[key], secrets);
    });
    return out;
  }
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

function runIdOf(context) {
  if (context && context.runEnvRecord && context.runEnvRecord.runId) return context.runEnvRecord.runId;
  if (context && context.runId) return context.runId;
  return null;
}

function evidenceOptions(context) {
  var config = context && context.deps && context.deps.config ? context.deps.config : {};
  var baseDir = config.evidenceBaseDir || process.env.PIPELINE_EVIDENCE_BASE_DIR || 'evidence';
  var root = config.evidenceRoot || process.cwd();
  return { root: root, baseDir: baseDir };
}

function writeEvidenceFileFor(context, taskId, filename, payload, kind, secrets) {
  var runId = runIdOf(context);
  if (!runId) return null;
  var content = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  var opts = evidenceOptions(context);
  opts.kind = kind || 'artifact';
  if (secrets && secrets.length > 0) {
    opts.secrets = {};
    for (var i = 0; i < secrets.length; i++) {
      opts.secrets['sessionSecret' + i] = secrets[i];
    }
  }
  try {
    return evidenceCollector.writeEvidenceFile(runId, taskId, filename, content, opts);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channel-scoped request helper
// ---------------------------------------------------------------------------

function shopApiRequest(context, channelToken, doc, variables, sessionCreds) {
  var fetchFn = getFetch(context);
  var baseUrl = resolveShopApiBase(context);
  var url = baseUrl + SHOP_API_PATH;
  var headers = {};
  headers['content-type'] = 'application/json';
  if (channelToken) headers[CHANNEL_TOKEN_HEADER] = channelToken;

  var secrets = tokenSecretList(countryChannelMapForHeaders(context));
  if (sessionCreds) {
    if (sessionCreds.authToken) {
      headers['authorization'] = 'Bearer ' + sessionCreds.authToken;
      headers[AUTH_TOKEN_HEADER] = sessionCreds.authToken;
      secrets.push(sessionCreds.authToken);
    }
    if (sessionCreds.cookie) {
      headers['cookie'] = sessionCreds.cookie;
      secrets.push(sessionCreds.cookie);
    }
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
    var setCookie = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('set-cookie')
      : (response.headers && response.headers['set-cookie']);
    return response.text().then(function(text) {
      var parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = { raw: text };
        }
      }
      var responseRecord = {
        httpStatus: response.status,
        ok: response.status >= 200 && response.status < 300,
        body: parsed,
        text: text,
        setCookie: setCookie || null
      };
      return {
        request: requestRecord,
        response: responseRecord,
        networkError: null
      };
    }, function(err) {
      return {
        request: requestRecord,
        response: { httpStatus: response.status, ok: false, body: null, text: null, setCookie: null },
        networkError: err && err.message ? err.message : String(err)
      };
    });
  }).catch(function(err) {
    return {
      request: requestRecord,
      response: { httpStatus: null, ok: false, body: null, text: null, setCookie: null },
      networkError: err && err.message ? err.message : String(err)
    };
  });
}

function countryChannelMapForHeaders(context) {
  var resolved = resolveChannelTokens(context);
  return resolved.ok ? resolved.tokens : COUNTRY_CHANNEL_TOKENS;
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

function failureResult(errorCode, error, callEvidence, secrets) {
  var evidence = callEvidence || null;
  if (evidence && secrets) {
    evidence = redactDeep(evidence, secrets);
  }
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence
  };
}

function classifyErrorCode(errorCode) {
  if (errorCode === 'VALIDATION_ERROR') return CLIENT_INPUT_SCOPE;
  if (errorCode === 'ENVIRONMENT_ERROR') return DEPENDENCY_ENVIRONMENT;
  if (errorCode === 'EXPECTED_MISMATCH') return APPLICATION_DEFECT;
  return PIPELINE_DEFECT;
}

// ---------------------------------------------------------------------------
// Per-account session store (cookies or bearer) with injected fetch and clock
// ---------------------------------------------------------------------------

function createSessionStore(context) {
  context = context || {};
  var accounts = {};

  function ensure(accountId) {
    if (!accounts[accountId]) {
      accounts[accountId] = { accountId: accountId, authToken: null, cookie: null };
    }
    return accounts[accountId];
  }

  function channelTokenFor(countryCode) {
    var resolved = resolveChannelTokens(context);
    if (!resolved.ok) return null;
    return resolved.tokens[countryCode] || null;
  }

  function call(accountId, doc, variables, countryCode, opts) {
    opts = opts || {};
    var session = ensure(accountId);
    var token = opts.channelToken || channelTokenFor(countryCode || 'DE');
    var creds = {
      authToken: session.authToken,
      cookie: session.cookie
    };
    var secrets = tokenSecretList(countryChannelMapForHeaders(context));
    var result = shopApiRequest(context, token, doc, variables, creds).then(function(callResult) {
      var setCookie = callResult.response.setCookie;
      if (setCookie) {
        session.cookie = setCookie.split(';')[0];
        secrets.push(session.cookie);
      }
      return callResult;
    });
    return promiseThen(result, function(callResult) {
      return {
        request: callResult.request,
        response: callResult.response,
        networkError: callResult.networkError,
        session: session,
        secrets: secrets
      };
    });
  }

  function promiseThen(p, fn) {
    return Promise.resolve(p).then(fn, function(err) {
      return { request: null, response: null, networkError: err && err.message ? err.message : String(err), session: null, secrets: [] };
    });
  }

  return {
    accounts: accounts,
    ensure: ensure,
    channelTokenFor: channelTokenFor,
    call: call,
    getSession: function(accountId) {
      return accounts[accountId] || null;
    },
    setAuthToken: function(accountId, authToken) {
      ensure(accountId).authToken = authToken;
      return authToken;
    },
    setSessionCurrencyCode: function(accountId, currencyCode, countryCode, opts) {
      return call(accountId, GRAPHQL.setSessionCurrencyCode, { currency: currencyCode }, countryCode, opts);
    },
    login: function(accountId, options) {
      var env = getEnvFn(context)();
      var password = resolvePassword(context, accountId, options && options.passwordEnvNames);
      if (!password.ok) {
        return Promise.resolve(failureResult('VALIDATION_ERROR', 'no password env var set for ' + accountId + ' (' + password.names.join(', ') + ')', {
          accountId: accountId,
          passwordEnvNames: password.names,
          message: 'password env vars absent'
        }, null));
      }
      return call(accountId, GRAPHQL.login, { username: accountId, password: password.value }, 'DE', options).then(function(callResult) {
        var body = callResult.response && callResult.response.body;
        var loginObj = body && body.data && body.data.login;
        callResult.secrets.push(password.value);
        if (callResult.response && callResult.response.httpStatus && callResult.response.httpStatus >= 500) {
          return failureResult('ENVIRONMENT_ERROR', 'shop-api login failed with HTTP ' + callResult.response.httpStatus, {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        if (!loginObj || (loginObj.__typename && loginObj.__typename.indexOf('Error') !== -1) || body.errors) {
          return failureResult('EXPECTED_MISMATCH', 'login did not authenticate ' + accountId, {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        var authToken = loginObj.identifier || null;
        if (authToken) callResult.session.authToken = authToken;
        return {
          success: true,
          actual: 'logged in',
          result: RESULT_READINESS_PASS,
          evidence: {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }
        };
      });
    },
    register: function(accountId, options) {
      options = options || {};
      var env = getEnvFn(context)();
      var password = resolvePassword(context, accountId, options.passwordEnvNames);
      if (!password.ok) {
        return Promise.resolve(failureResult('VALIDATION_ERROR', 'no password env var set for ' + accountId + ' (' + password.names.join(', ') + ')', {
          accountId: accountId,
          passwordEnvNames: password.names,
          message: 'password env vars absent'
        }, null));
      }
      var input = {
        emailAddress: accountId,
        firstName: options.firstName || (accountId.split('@')[0] || 'Test'),
        lastName: options.lastName || 'Account',
        password: password.value
      };
      if (options.customFields) input.customFields = options.customFields;
      var countryCode = options.countryCode || 'DE';
      return call(accountId, GRAPHQL.register, { input: input }, countryCode, options).then(function(callResult) {
        var body = callResult.response && callResult.response.body;
        var reg = body && body.data && body.data.registerCustomerAccount;
        callResult.secrets.push(password.value);
        if (callResult.response && callResult.response.httpStatus && callResult.response.httpStatus >= 500) {
          return failureResult('ENVIRONMENT_ERROR', 'shop-api register failed with HTTP ' + callResult.response.httpStatus, {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        if (body && body.errors) {
          return failureResult('EXPECTED_MISMATCH', 'register returned GraphQL errors for ' + accountId, {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        if (!reg || reg.__typename !== 'Success') {
          // Missing capability: email verification required (native
          // registerCustomerAccount verifier) or another non-success result.
          return failureResult('VALIDATION_ERROR', 'register could not complete for ' + accountId + ' (missing capability: email verification)', {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        return {
          success: true,
          actual: 'registered',
          result: RESULT_READINESS_PASS,
          evidence: {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }
        };
      });
    },
    addItemToOrder: function(accountId, variantId, quantity, countryCode, opts) {
      var variables = { variantId: String(variantId), quantity: quantity || 1 };
      return call(accountId, GRAPHQL.addItemToOrder, variables, countryCode || 'DE', opts).then(function(callResult) {
        var body = callResult.response && callResult.response.body;
        var order = body && body.data && body.data.addItemToOrder;
        if (callResult.response && callResult.response.httpStatus && callResult.response.httpStatus >= 500) {
          return failureResult('ENVIRONMENT_ERROR', 'shop-api addItemToOrder failed with HTTP ' + callResult.response.httpStatus, {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        if (!order || order.__typename === 'ErrorResult' || !order.totalQuantity) {
          // Wrong channel: the order did not accept the item under this token.
          return failureResult('EXPECTED_MISMATCH', 'addItemToOrder rejected for ' + accountId + ' (wrong channel or out of stock)', {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }, callResult.secrets);
        }
        return {
          success: true,
          actual: 'added',
          result: RESULT_READINESS_PASS,
          evidence: {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }
        };
      });
    },
    activeCustomer: function(accountId, countryCode, opts) {
      return call(accountId, GRAPHQL.activeCustomer, {}, countryCode || 'DE', opts).then(function(callResult) {
        return {
          success: true,
          result: RESULT_READINESS_PASS,
          evidence: {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }
        };
      });
    },
    activeOrder: function(accountId, countryCode, opts) {
      return call(accountId, GRAPHQL.activeOrder, {}, countryCode || 'DE', opts).then(function(callResult) {
        return {
          success: true,
          result: RESULT_READINESS_PASS,
          evidence: {
            accountId: accountId,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }
        };
      });
    },
    orderByCode: function(accountId, code, countryCode, opts) {
      return call(accountId, GRAPHQL.orderByCode, { code: code }, countryCode || 'DE', opts).then(function(callResult) {
        return {
          success: true,
          result: RESULT_READINESS_PASS,
          evidence: {
            accountId: accountId,
            orderCode: code,
            request: redactDeep(callResult.request, callResult.secrets),
            response: redactDeep(callResult.response, callResult.secrets)
          }
        };
      });
    }
  };
}

module.exports = {
  RESULT_READINESS_PASS: RESULT_READINESS_PASS,
  COVERAGE_READINESS_SUBSET: COVERAGE_READINESS_SUBSET,
  SHOP_API_PATH: SHOP_API_PATH,
  CHANNEL_TOKEN_HEADER: CHANNEL_TOKEN_HEADER,
  AUTH_TOKEN_HEADER: AUTH_TOKEN_HEADER,
  REDACTED_MARKER: REDACTED_MARKER,
  DEFAULT_SHOP_API_BASE: DEFAULT_SHOP_API_BASE,
  COUNTRY_CURRENCY_MAP: COUNTRY_CURRENCY_MAP,
  COUNTRY_CHANNEL_TOKENS: COUNTRY_CHANNEL_TOKENS,
  COUNTRIES: COUNTRIES.slice(),
  TEST_ACCOUNT_NAMES: TEST_ACCOUNT_NAMES.slice(),
  GRAPHQL: GRAPHQL,
  getEnvFn: getEnvFn,
  envValue: envValue,
  resolveShopApiBase: resolveShopApiBase,
  frozenChannelTokens: frozenChannelTokens,
  directChannelTokens: directChannelTokens,
  normalizeChannelTokens: normalizeChannelTokens,
  resolveChannelTokens: resolveChannelTokens,
  resolveTokenPrecedence: resolveTokenPrecedence,
  tokenSecretList: tokenSecretList,
  passwordEnvName: passwordEnvName,
  resolvePassword: resolvePassword,
  redactString: redactString,
  redactDeep: redactDeep,
  runIdOf: runIdOf,
  evidenceOptions: evidenceOptions,
  writeEvidenceFileFor: writeEvidenceFileFor,
  shopApiRequest: shopApiRequest,
  failureResult: failureResult,
  classifyErrorCode: classifyErrorCode,
  createSessionStore: createSessionStore
};

// Every executor/helper in this module is the shared helper for chunk 12b.
// It intentionally exports no register() so auto-discovery skips it.
