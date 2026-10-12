'use strict';

/**
 * Read-only Admin API channel inventory diagnostic for CAN-B1-03 / CAN-B1-04.
 *
 * When the Shop API probe returns `__default_channel__` or a `products` query
 * fails (the hypothesis being missing staging channels), this module gathers
 * hard evidence by querying the Admin API directly.
 *
 * The login mutation is the ONLY mutation this module uses; everything else is
 * a query. Both bearer-token (vendure-auth-token response header) and cookie
 * sessions are supported. The password and auth token are added to the secrets
 * redacted when evidence is written.
 *
 * Results are returned, never thrown. A missing credentials result has
 * `available: false` and `reason: 'ADMIN_CREDENTIALS_MISSING'`.
 */

var path = require('path');

// ---------------------------------------------------------------------------
// Env var NAMES (never values) that this module is sensitive to.
// ---------------------------------------------------------------------------

var ADMIN_CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'STAGING_ADMIN_EMAIL',
  'STAGING_ADMIN_PASSWORD'
];

// ---------------------------------------------------------------------------
// GraphQL documents (copied from migration-input scripts; not guessed)
// ---------------------------------------------------------------------------

// Introspection: check what fields the Channel type actually exposes before
// selecting them. The `enabled` field was previously selected on the Shop API
// and does not exist there.
var INTROSPECT_CHANNEL_TYPE = [
  'query IntrospectChannelType {',
  '  __type(name: "Channel") {',
  '    fields { name }',
  '  }',
  '}'
].join('\n');

// Admin login – copied from publish_product_v11.mjs:28-42.
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

// Channel list – the selection set is built dynamically after introspection.
var CHANNELS_QUERY_DOC = [
  'query Channels($options: ChannelListOptions) {',
  '  channels(options: $options) {',
  '    items {',
  '      CHANNEL_FIELDS',
  '    }',
  '    totalItems',
  '  }',
  '}'
].join('\n');

// Product count per channel – uses vendure-token header (token-auth session).
var CHANNEL_PRODUCT_COUNT_QUERY = [
  'query ChannelProducts($options: ProductListOptions) {',
  '  products(options: $options) {',
  '    totalItems',
  '  }',
  '}'
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnvFn(context) {
  var getEnv = context && context.deps && context.deps.getEnv;
  if (typeof getEnv === 'function') return getEnv;
  return function() { return {}; };
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

function getFetch(context) {
  var fetchFn = context && context.deps && context.deps.fetch;
  if (!fetchFn) fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') {
    return null;
  }
  return fetchFn;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

/**
 * Resolve the Admin API base URL:
 *   VENDURE_ADMIN_API_URL > (stagingUrl + '/admin-api')
 */
function resolveAdminApiBase(context) {
  var direct = envValue(context, 'VENDURE_ADMIN_API_URL');
  if (typeof direct === 'string' && direct.length > 0) {
    return direct.replace(/\/+$/, '');
  }
  // Fall back to the staging URL's admin-api path.
  var stagingBase = null;
  if (context && context.runEnvRecord && context.runEnvRecord.stagingUrl) {
    stagingBase = context.runEnvRecord.stagingUrl;
  } else if (context && context.stagingUrl) {
    stagingBase = context.stagingUrl;
  }
  if (typeof stagingBase === 'string' && stagingBase.length > 0) {
    return stagingBase.replace(/\/+$/, '') + '/admin-api';
  }
  // Last resort: assume standard staging base.
  return 'https://staging.tibella.eu/admin-api';
}

/**
 * Return the NAMES (never values) of present/absent admin credentials.
 */
function adminCredentialNames(context) {
  var env = getEnvFn(context)();
  var present = [];
  var absent = [];
  var username = (env.SUPERADMIN_USERNAME || '').trim() || (env.STAGING_ADMIN_EMAIL || '').trim();
  var password = (env.SUPERADMIN_PASSWORD || '').trim() || (env.STAGING_ADMIN_PASSWORD || '').trim();
  if (username) present.push('SUPERADMIN_USERNAME');
  else absent.push('SUPERADMIN_USERNAME');
  if (password) present.push('SUPERADMIN_PASSWORD');
  else absent.push('SUPERADMIN_PASSWORD');
  if (env.VENDURE_ADMIN_API_URL) present.push('VENDURE_ADMIN_API_URL');
  else absent.push('VENDURE_ADMIN_API_URL');
  return { present: present, absent: absent, credentialsPresent: !!(username && password) };
}

// ---------------------------------------------------------------------------
// Low-level Admin API request helper
// ---------------------------------------------------------------------------

/**
 * Execute an Admin API GraphQL request. Supports both bearer-token
 * (vendure-auth-token header / Authorization: Bearer) and cookie sessions.
 * Returns a normalised result object; never throws.
 *
 * @param {Function} fetchFn
 * @param {string} url
 * @param {string|object} body  - query string or {query, variables}
 * @param {string|null} token   - vendure-auth-token / Bearer value; null for login
 * @param {Array} extraSecrets  - additional strings to redact from evidence
 * @returns {Promise<object>}
 */
function adminGraphqlRequest(fetchFn, url, body, token, extraSecrets) {
  if (!fetchFn) {
    return Promise.resolve({
      request: null,
      response: null,
      networkError: 'no fetch implementation available',
      authToken: null,
      secrets: []
    });
  }

  var headers = { 'content-type': 'application/json' };
  var secrets = (extraSecrets && Array.isArray(extraSecrets)) ? extraSecrets.slice() : [];

  if (token) {
    headers['vendure-auth-token'] = token;
    headers['Authorization'] = 'Bearer ' + token;
    secrets.push(token);
  }

  var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

  var requestRecord = {
    method: 'POST',
    url: url,
    headers: headers,
    body: bodyStr
  };

  return fetchFn(url, {
    method: 'POST',
    headers: headers,
    body: bodyStr
  }).then(function(response) {
    // Extract vendure-auth-token from response headers (both header-value
    // accessor and plain-object forms are handled).
    var authToken = null;
    if (response.headers && typeof response.headers.get === 'function') {
      authToken = response.headers.get('vendure-auth-token');
    } else if (response.headers && typeof response.headers === 'object') {
      authToken = response.headers['vendure-auth-token'] || null;
    }

    return response.text().then(
      function(text) {
        var parsed = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
        }
        return {
          request: requestRecord,
          response: {
            httpStatus: response.status,
            ok: response.status >= 200 && response.status < 300,
            body: parsed,
            text: text
          },
          networkError: null,
          authToken: authToken || null,
          secrets: secrets
        };
      },
      function(err) {
        return {
          request: requestRecord,
          response: { httpStatus: response.status, ok: false, body: null, text: null },
          networkError: err && err.message ? err.message : String(err),
          authToken: null,
          secrets: secrets
        };
      }
    );
  }).catch(function(err) {
    return {
      request: requestRecord,
      response: { httpStatus: null, ok: false, body: null, text: null },
      networkError: err && err.message ? err.message : String(err),
      authToken: null,
      secrets: secrets
    };
  });
}

// ---------------------------------------------------------------------------
// Introspection helper
// ---------------------------------------------------------------------------

/**
 * Introspect the Channel type and return the set of field names it actually
 * exposes. If introspection fails, returns an empty set (no fields selected).
 */
async function introspectChannelType(fetchFn, adminUrl, token) {
  try {
    var result = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: INTROSPECT_CHANNEL_TYPE,
      variables: {}
    }, token);

    if (!result.response || !result.response.ok || !result.response.body) {
      return { fields: [], call: result };
    }

    var body = result.response.body;
    if (body.errors && body.errors.length > 0) {
      return { fields: [], call: result };
    }

    var type = body.data && body.data.__type;
    if (!type || !Array.isArray(type.fields)) {
      return { fields: [], call: result };
    }

    var fieldNames = type.fields.map(function(f) { return f.name; });
    return { fields: fieldNames, call: result };
  } catch (e) {
    return { fields: [], call: null };
  }
}

// ---------------------------------------------------------------------------
// Channel query builder
// ---------------------------------------------------------------------------

/**
 * Build the channels query GraphQL string, selecting only fields confirmed
 * to exist by introspection (id, code, token are always requested; the
 * currency field falls back to `currencyCode` if `defaultCurrencyCode` is
 * not available).
 */
function buildChannelsQuery(introspectedFields) {
  var fields = ['id', 'code', 'token'];

  // The default currency field: prefer defaultCurrencyCode, fall back to
  // currencyCode. Vendure 3.5.3 uses currencyCode; later versions may rename
  // it to defaultCurrencyCode.
  if (introspectedFields.indexOf('defaultCurrencyCode') !== -1) {
    fields.push('defaultCurrencyCode');
  } else if (introspectedFields.indexOf('currencyCode') !== -1) {
    fields.push('currencyCode');
  }

  // Always include at least id, code, token even if introspection was empty;
  // channels cannot exist without these three fields.
  var fieldsStr = fields.join('\n      ');
  return CHANNELS_QUERY_DOC.replace('CHANNEL_FIELDS', fieldsStr);
}

// ---------------------------------------------------------------------------
// Product count per channel
// ---------------------------------------------------------------------------

/**
 * For each discovered channel with a token, query products(options:{take:0})
 * using the vendure-token header and record totalItems. Failures here are
 * non-fatal (recorded, not thrown).
 *
 * @param {Function} fetchFn
 * @param {string} shopApiBase  - the /shop-api base URL (same host as admin-api)
 * @param {Array} channels      - array of {code, token}
 * @returns {Promise<Array>}  [{channelCode, totalItems, error}, ...]
 */
async function collectProductCounts(fetchFn, shopApiBase, channels) {
  if (!fetchFn || !channels || channels.length === 0) {
    return [];
  }

  var results = [];
  var base = shopApiBase.replace(/\/+$/, '');

  for (var i = 0; i < channels.length; i++) {
    var channel = channels[i];
    var token = channel.token;

    if (!token || typeof token !== 'string' || token.length === 0) {
      results.push({ channelCode: channel.code, totalItems: null, error: 'no token' });
      continue;
    }

    var url = base + '/shop-api';
    var bodyStr = JSON.stringify({
      query: CHANNEL_PRODUCT_COUNT_QUERY,
      variables: { options: { take: 0 } }
    });

    var secrets = [token];
    var requestRecord = {
      method: 'POST',
      url: url,
      headers: { 'content-type': 'application/json', 'vendure-token': token },
      body: bodyStr
    };

    try {
      var resp = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'vendure-token': token },
        body: bodyStr
      });

      var text = await resp.text();
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }

      var httpStatus = (resp && typeof resp.status === 'number') ? resp.status : null;
      var respOk = httpStatus !== null ? (httpStatus >= 200 && httpStatus < 300) : !!resp.ok;

      if (!respOk || (parsed && parsed.errors && parsed.errors.length > 0)) {
        results.push({
          channelCode: channel.code,
          totalItems: null,
          error: 'shop-api error: HTTP ' + (httpStatus === null ? 'unknown' : httpStatus),
          call: { request: requestRecord, response: { httpStatus: httpStatus, ok: respOk, body: parsed } },
          secrets: secrets
        });
      } else {
        var totalItems = (parsed && parsed.data && parsed.data.products && parsed.data.products.totalItems != null)
          ? parsed.data.products.totalItems
          : null;
        results.push({
          channelCode: channel.code,
          totalItems: totalItems,
          error: null,
          call: { request: requestRecord, response: { httpStatus: resp.status, ok: resp.ok, body: parsed } },
          secrets: secrets
        });
      }
    } catch (err) {
      results.push({
        channelCode: channel.code,
        totalItems: null,
        error: 'network: ' + (err && err.message ? err.message : String(err)),
        secrets: secrets
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Expected channels (DE, AT, HU, GB) from the same token-resolution logic
// used by the Shop API executors. We accept the tokens map directly since it
// is already resolved by the caller.
// ---------------------------------------------------------------------------

var EXPECTED_COUNTRIES = ['DE', 'AT', 'HU', 'GB'];

var COUNTRY_CURRENCY_MAP = {
  DE: 'EUR',
  AT: 'EUR',
  HU: 'HUF',
  GB: 'GBP'
};

// The nominal (VERIFIED) staging channel tokens.
var COUNTRY_CHANNEL_TOKENS = {
  DE: 'de-token',
  AT: 'at-token',
  HU: 'hu-token',
  GB: 'gb-token'
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Collect channel inventory from the Admin API.
 *
 * Options:
 *   stagingUrl  {string}  - staging base URL (used if VENDURE_ADMIN_API_URL is not set)
 *   tokensResult {object}  - resolved channel tokens from resolveChannelTokens()
 *   shopApiBase  {string}  - the resolved Shop API base (for product-count probes)
 *
 * Returns { available, reason, channels, expected, missing, unexpectedDefaultOnly,
 *           perChannelProductCounts, authToken, credentialNames, callCount }.
 * Never throws.
 */
async function collectChannelInventory(context, options) {
  options = options || {};
  var fetchFn = getFetch(context);
  var clock = getClock(context);
  var timestamp = clock().toISOString();

  // ------------------------------------------------------------------
  // Credential check
  // ------------------------------------------------------------------
  var credInfo = adminCredentialNames(context);
  if (!credInfo.credentialsPresent) {
    return {
      available: false,
      reason: 'ADMIN_CREDENTIALS_MISSING',
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: 0
    };
  }

  var env = getEnvFn(context)();
  var username = (env.SUPERADMIN_USERNAME || '').trim() || (env.STAGING_ADMIN_EMAIL || '').trim();
  var password = (env.SUPERADMIN_PASSWORD || '').trim() || (env.STAGING_ADMIN_PASSWORD || '').trim();

  // The password is a secret; the username is not (it is an email address from
  // the env and we track only its NAME in credentialNames).
  var allSecrets = [password];

  var adminUrl = resolveAdminApiBase(context);
  var stagingUrl = options.stagingUrl || null;
  var tokensResult = options.tokensResult || null;
  var shopApiBase = options.shopApiBase || null;

  // ------------------------------------------------------------------
  // Login
  // ------------------------------------------------------------------
  var loginResult;
  try {
    loginResult = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: ADMIN_LOGIN_MUTATION,
      variables: { username: username, password: password }
    }, null, allSecrets);
  } catch (e) {
    return {
      available: false,
      reason: 'ADMIN_LOGIN_FAILED',
      error: 'login threw: ' + (e && e.message ? e.message : String(e)),
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: 1
    };
  }

  var callCount = 1;

  if (!loginResult.response || loginResult.response.httpStatus === null) {
    return {
      available: false,
      reason: 'ADMIN_LOGIN_FAILED',
      error: 'network error during login: ' + (loginResult.networkError || 'unknown'),
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  if (loginResult.response.httpStatus >= 500) {
    return {
      available: false,
      reason: 'ADMIN_LOGIN_FAILED',
      error: 'admin API returned HTTP ' + loginResult.response.httpStatus + ' during login',
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  var loginBody = loginResult.response.body;
  var loginData = loginBody && loginBody.data && loginBody.data.login;
  if (!loginData || loginData.__typename !== 'CurrentUser') {
    var errMsg = 'authentication failed';
    if (loginData && loginData.__typename === 'ErrorResult') {
      errMsg = 'authentication failed: ' + (loginData.message || loginData.errorCode || 'InvalidCredentialsError');
    }
    return {
      available: false,
      reason: 'ADMIN_LOGIN_FAILED',
      error: errMsg,
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  // Extract auth token from the login response header.
  var authToken = loginResult.authToken || null;
  if (authToken) {
    allSecrets.push(authToken);
  }

  // ------------------------------------------------------------------
  // Introspection: check which Channel fields actually exist
  // ------------------------------------------------------------------
  callCount++;
  var introspectResult = await introspectChannelType(fetchFn, adminUrl, authToken);
  var introspectedFields = introspectResult.fields || [];

  // ------------------------------------------------------------------
  // Query channels
  // ------------------------------------------------------------------
  callCount++;
  var channelsQuery = buildChannelsQuery(introspectedFields);
  var channelsResult;
  try {
    channelsResult = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: channelsQuery,
      variables: { options: { take: 100 } }
    }, authToken);
  } catch (e) {
    return {
      available: false,
      reason: 'ADMIN_CHANNELS_QUERY_FAILED',
      error: 'channels query threw: ' + (e && e.message ? e.message : String(e)),
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  if (!channelsResult.response || !channelsResult.response.ok) {
    return {
      available: false,
      reason: 'ADMIN_CHANNELS_QUERY_FAILED',
      error: 'channels query failed: HTTP ' + (channelsResult.response ? channelsResult.response.httpStatus : 'network error'),
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  var channelsBody = channelsResult.response.body;
  if (channelsBody && channelsBody.errors && channelsBody.errors.length > 0) {
    return {
      available: false,
      reason: 'ADMIN_CHANNELS_QUERY_FAILED',
      error: 'channels query GraphQL errors: ' + channelsBody.errors.map(function(e) { return e.message; }).join('; '),
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  var channelsData = channelsBody && channelsBody.data && channelsBody.data.channels;
  if (!channelsData || !Array.isArray(channelsData.items)) {
    return {
      available: false,
      reason: 'ADMIN_CHANNELS_QUERY_FAILED',
      error: 'channels query returned unexpected shape',
      credentialNames: credInfo,
      timestamp: timestamp,
      callCount: callCount
    };
  }

  var channels = channelsData.items.map(function(ch) {
    // Determine the currency field that was actually selected.
    var currencyField = introspectedFields.indexOf('defaultCurrencyCode') !== -1 ? 'defaultCurrencyCode' : 'currencyCode';
    return {
      id: ch.id || null,
      code: ch.code || null,
      token: ch.token || null,
      currency: ch[currencyField] || ch.currencyCode || null,
      currencySource: currencyField
    };
  });

  // ------------------------------------------------------------------
  // Compare against expected
  // ------------------------------------------------------------------
  var expectedCountries = EXPECTED_COUNTRIES;
  var countryCurrencyMap = COUNTRY_CURRENCY_MAP;

  // Build a lookup of channel by token (case-insensitive match against nominal).
  var channelByToken = {};
  for (var ci = 0; ci < channels.length; ci++) {
    var chToken = channels[ci].token;
    if (chToken) channelByToken[chToken.toLowerCase()] = channels[ci];
    channelByToken[chToken] = channels[ci];
  }

  var perCountry = {};
  var missing = [];

  for (var ei = 0; ei < expectedCountries.length; ei++) {
    var country = expectedCountries[ei];
    var nominalToken = COUNTRY_CHANNEL_TOKENS[country];
    var expectedCurrency = countryCurrencyMap[country];

    var foundChannel = channelByToken[nominalToken] || null;
    var exists = foundChannel !== null;
    var currencyMatches = exists && foundChannel.currency === expectedCurrency;

    perCountry[country] = {
      expectedToken: nominalToken,
      expectedCurrency: expectedCurrency,
      exists: exists,
      channelCode: foundChannel ? foundChannel.code : null,
      channelToken: foundChannel ? foundChannel.token : null,
      currency: foundChannel ? foundChannel.currency : null,
      currencyMatches: currencyMatches
    };

    if (!exists) {
      missing.push(country);
    }
  }

  var unexpectedDefaultOnly = false;
  if (channels.length === 1 && channels[0].code === '__default_channel__') {
    unexpectedDefaultOnly = true;
  } else if (channels.length === 0) {
    unexpectedDefaultOnly = true;
  }

  // ------------------------------------------------------------------
  // Optional: per-channel product counts (non-fatal)
  // ------------------------------------------------------------------
  var perChannelProductCounts = [];
  if (shopApiBase && channels.length > 0) {
    callCount++;
    try {
      perChannelProductCounts = await collectProductCounts(fetchFn, shopApiBase, channels);
    } catch (e) {
      // Non-fatal; record the failure but continue.
      perChannelProductCounts = [];
    }
  }

  // ------------------------------------------------------------------
  // Assemble result
  // ------------------------------------------------------------------
  return {
    available: true,
    reason: null,
    channels: channels,
    expected: {
      countries: expectedCountries,
      tokens: COUNTRY_CHANNEL_TOKENS,
      currencies: countryCurrencyMap
    },
    perCountry: perCountry,
    missing: missing,
    unexpectedDefaultOnly: unexpectedDefaultOnly,
    perChannelProductCounts: perChannelProductCounts,
    authToken: authToken ? '[REDACTED]' : null,
    credentialNames: credInfo,
    introspectedFields: introspectedFields,
    timestamp: timestamp,
    callCount: callCount,
    secrets: allSecrets  // password + authToken; used for redaction in caller
  };
}

module.exports = {
  collectChannelInventory: collectChannelInventory,
  ADMIN_CREDENTIAL_ENV_NAMES: ADMIN_CREDENTIAL_ENV_NAMES,
  resolveAdminApiBase: resolveAdminApiBase,
  adminCredentialNames: adminCredentialNames,
  buildChannelsQuery: buildChannelsQuery
};
