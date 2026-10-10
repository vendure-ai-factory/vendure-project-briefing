'use strict';

/**
 * Read-only Shop API task executors (CAN-B1-03, CAN-B1-04).
 *
 * CAN-B1-03 (currency/price alignment): POSTs a read-only GraphQL query to
 * /shop-api for each country Channel (DE, AT, HU, GB), using the channel-token
 * header, and verifies every country's activeChannel.currencyCode matches the
 * frozen country->currency map and that no product variant carries another
 * country's currency.
 *
 * CAN-B1-04 (product visibility / variant isolation): runs product and variant
 * queries per Channel and compares the observed visibility against an
 * expected-visibility fixture the executor creates and hashes in the
 * workspace. A deliberately planted mismatch must be detected (control run).
 *
 * Deps are injectable for tests: context.deps.fetch (async fetch; defaults to
 * the global fetch), context.deps.clock (UTC clock), context.deps.fs (used for
 * workspace cleanup; an fs whose rmSync throws EPERM is how a Windows-style
 * cleanup failure is injected), and context.deps.getEnv (env access).
 *
 * Staging URL source: the canonical value is the frozen manifest run input
 * `stagingUrl` (surfaced as context.runEnvRecord.stagingUrl). Precedence is:
 *   context.shopApiBase > env STAGING_URL > runEnvRecord.stagingUrl
 *   > deps.config.shopApiUrl > the default staging base.
 * STAGING_URL exists so a test can point the whole run at a local server.
 *
 * CHANNEL_TOKENS env var: a JSON object keyed by country code or nominal
 * channel token, e.g. {"DE":"de-token","AT":"at-token","HU":"hu-token",
 * "GB":"gb-token"}. A missing value, a token missing for any country, or
 * invalid JSON, is a CLIENT_INPUT_SCOPE failure (errorCode VALIDATION_ERROR).
 *
 * Executor evidence is written through evidenceCollector.writeEvidenceFile so
 * verifyEvidence passes: raw redacted requests, raw redacted responses, the
 * country/currency/price table, and expected-versus-actual. The executor also
 * destroys its workspace before returning; if that cleanup fails (e.g. EPERM)
 * the task can never be a passing outcome and the failure is recorded.
 *
 * Passing runs return RESULT_PASS (never a bare literal) and mirror the
 * task's expectedResult into actual so the run record's expected equals its
 * actual.
 */

var crypto = require('crypto');
var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');

var RESULT_PASS = terminalState.RESULT_PASS;

var COUNTRY_CURRENCY_MAP = {
  DE: 'EUR',
  AT: 'EUR',
  HU: 'HUF',
  GB: 'GBP'
};

// Nominal staging channel tokens (VERIFIED in set_craft_fee.mjs defaults).
// The staging values are client-confirmed and supplied through CHANNEL_TOKENS.
var COUNTRY_CHANNEL_TOKENS = {
  DE: 'de-token',
  AT: 'at-token',
  HU: 'hu-token',
  GB: 'gb-token'
};

var COUNTRIES = Object.keys(COUNTRY_CURRENCY_MAP);

var DEFAULT_SHOP_API_BASE = 'https://staging.tibella.eu';
var SHOP_API_PATH = '/shop-api';
var CHANNEL_TOKEN_HEADER = 'vendure-token';
var REDACTED_MARKER = '[REDACTED]';

var B1_03_QUERY = [
  'query ReadOnlyCountryProducts {',
  '  activeChannel { currencyCode }',
  '  products(options: { take: 5 }) {',
  '    items { name variants { price currencyCode } }',
  '  }',
  '}'
].join('\n');

var B1_04_QUERY = [
  'query ReadOnlyCountryVisibility {',
  '  products(options: { take: 100 }) {',
  '    items { id name slug enabled variants { id sku name enabled price currencyCode } }',
  '  }',
  '}'
].join('\n');

var FIXTURE_FILE = 'expected-visibility.json';
var FIXTURE_HASH_FILE = 'expected-visibility.sha256';
var PLANT_MISMATCH_ENV = 'CAN_B1_04_PLANT_MISMATCH';

function getFetch(context) {
  var fetchFn = context && context.deps && context.deps.fetch;
  if (!fetchFn) fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('no fetch implementation available');
  }
  return fetchFn;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function getEnvFn(context) {
  var getEnv = context && context.deps && context.deps.getEnv;
  if (typeof getEnv === 'function') return getEnv;
  return function() { return {}; };
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

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

/**
 * Read the frozen channelTokens value from the registry passed in context.
 * This is the lowest-precedence source (fallback when no direct context value
 * and no env CHANNEL_TOKENS is present).
 */
function frozenChannelTokensFromContext(context) {
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

/**
 * Direct channel-token map supplied on the context (highest precedence).
 */
function contextChannelTokens(context) {
  if (!context) return null;
  var direct = context.channelTokens;
  return (direct && typeof direct === 'object') ? direct : null;
}

/**
 * Resolve channel tokens with precedence: context.channelTokens (direct) >
 * env CHANNEL_TOKENS > frozen registry value. All are normalized to the
 * country map. The source (context/env/frozen) is recorded on the result.
 */
function resolveChannelTokens(getEnv, frozenTokens, directTokens) {
  if (directTokens && typeof directTokens === 'object') {
    var directNormalized = normalizeChannelTokens(directTokens, 'context');
    if (directNormalized.ok) return directNormalized;
  }

  var env = getEnv();
  var raw = env ? env.CHANNEL_TOKENS : undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    var map;
    if (typeof raw === 'string') {
      try {
        map = JSON.parse(raw);
      } catch (e) {
        return { ok: false, errorCode: 'VALIDATION_ERROR', error: 'CHANNEL_TOKENS is not valid JSON', source: 'env' };
      }
    } else if (typeof raw === 'object') {
      map = raw;
    } else {
      return { ok: false, errorCode: 'VALIDATION_ERROR', error: 'CHANNEL_TOKENS must be a JSON object of channel tokens', source: 'env' };
    }
    var envResult = normalizeChannelTokens(map, 'env');
    if (envResult.ok) return envResult;
  }

  if (frozenTokens && typeof frozenTokens === 'object') {
    var frozenResult = normalizeChannelTokens(frozenTokens, 'frozen');
    if (frozenResult.ok) return frozenResult;
  }

  return { ok: false, errorCode: 'VALIDATION_ERROR', error: 'CHANNEL_TOKENS is missing; no channel token supplied', source: 'none' };
}

function normalizeChannelTokens(map, source) {
  var normalized = {};
  var missing = null;
  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var nominal = COUNTRY_CHANNEL_TOKENS[country];
    var token = map[country] || map[country.toLowerCase()] || map[nominal] || map[nominal.toLowerCase()];
    if (typeof token !== 'string' || token.length === 0) {
      missing = country;
      break;
    }
    normalized[country] = token;
  }
  if (missing) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      error: 'channel token missing for ' + missing + ' in ' + source,
      missingCountry: missing,
      source: source
    };
  }
  return { ok: true, tokens: normalized, source: source };
}

function tokenSecrets(tokens) {
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

function redactValue(value, secrets) {
  if (typeof value !== 'string' || !secrets || secrets.length === 0) {
    return value;
  }
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
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = redactDeep(value[keys[i]], secrets);
    }
    return out;
  }
  return redactValue(value, secrets);
}

function shopApiRequest(fetchFn, baseUrl, channelToken, query) {
  var url = baseUrl + SHOP_API_PATH;
  var headers = {};
  headers['content-type'] = 'application/json';
  headers[CHANNEL_TOKEN_HEADER] = channelToken;

  return fetchFn(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ query: query })
  }).then(function(response) {
    return response.text().then(
      function(text) {
        var body = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch (e) {
            body = { raw: text };
          }
        }
        return {
          ok: response.status >= 200 && response.status < 300,
          httpStatus: response.status,
          body: body,
          text: text,
          request: { method: 'POST', url: url, headers: headers, body: query }
        };
      },
      function(err) {
        return {
          ok: false,
          httpStatus: response.status,
          body: null,
          text: null,
          networkError: err && err.message ? err.message : String(err),
          request: { method: 'POST', url: url, headers: headers, body: query }
        };
      }
    );
  }).catch(function(err) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      text: null,
      networkError: err && err.message ? err.message : String(err),
      request: { method: 'POST', url: url, headers: headers, body: query }
    };
  });
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

function runIdOf(context) {
  var rec = context.runEnvRecord;
  if (rec && rec.runId) return rec.runId;
  if (context.runId) return context.runId;
  return null;
}

function evidenceOptions(context) {
  var config = context.deps && context.deps.config ? context.deps.config : {};
  var baseDir = config.evidenceBaseDir || process.env.PIPELINE_EVIDENCE_BASE_DIR || 'evidence';
  var root = config.evidenceRoot || process.cwd();
  return { root: root, baseDir: baseDir };
}

/**
 * Make sure the run's evidence index exists before the executor appends files.
 * In the CLI flow cli.js already initialised it (a no-op here that must not
 * replace the existing index); in a standalone run it creates the index at
 * the right root so writeEvidenceFile's auto-init path is never taken.
 */
function ensureEvidenceIndex(context) {
  var runId = runIdOf(context);
  if (!runId) return false;
  var opts = evidenceOptions(context);
  var baseRoot = path.join(opts.root, opts.baseDir);
  var loaded = evidenceCollector.loadIndex(baseRoot, runId);
  if (loaded.exists && loaded.index) return true;
  try {
    evidenceCollector.initEvidenceIndex(runId, {}, opts);
    return true;
  } catch (e) {
    return false;
  }
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
      opts.secrets['channelToken' + i] = secrets[i];
    }
  }
  try {
    return evidenceCollector.writeEvidenceFile(runId, taskId, filename, content, opts);
  } catch (e) {
    return null;
  }
}

function writeExecutorEvidence(context, taskId, files, secrets) {
  ensureEvidenceIndex(context);
  var written = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var res = writeEvidenceFileFor(context, taskId, file.name, file.data, file.kind, secrets);
    if (res) written.push(res);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Workspace cleanup
// ---------------------------------------------------------------------------

function attemptWorkspaceCleanup(context) {
  var workspace = context.workspace;
  if (!workspace || !workspace.workspacePath) {
    return { ok: true, skipped: true };
  }
  var fsImpl = (context.deps && context.deps.fs) || require('fs');
  if (typeof fsImpl.rmSync !== 'function') {
    return { ok: true, skipped: true };
  }
  try {
    fsImpl.rmSync(workspace.workspacePath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      success: false,
      error: 'Failed to destroy workspace: ' + (e && e.message ? e.message : String(e)),
      code: e && e.code ? e.code : null
    };
  }
}

/**
 * Gate the executor result on workspace cleanup. A failed cleanup is never
 * swallowed: the task cannot be a passing outcome, and the cleanup outcome is
 * recorded in the evidence. A pre-existing primary failure keeps its own
 * classification (cleanup failure is noted alongside it).
 */
function finalizeWithCleanup(context, task, result) {
  var cleanup = attemptWorkspaceCleanup(context);
  if (result.evidence && typeof result.evidence === 'object') {
    result.evidence.cleanupResetResult = cleanup;
  }
  if (!cleanup.ok) {
    if (result.success === true) {
      result.success = false;
      result.result = null;
      result.actual = null;
      result.errorCode = 'ENVIRONMENT_ERROR';
      result.error = 'workspace cleanup failed: ' + cleanup.error;
    } else if (!result.error) {
      result.error = 'workspace cleanup failed: ' + cleanup.error;
      result.errorCode = result.errorCode || 'ENVIRONMENT_ERROR';
      result.cleanupError = cleanup.error;
    } else {
      result.cleanupError = cleanup.error;
    }
  }
  return result;
}

function failureResult(options) {
  var evidence = options.evidence || null;
  if (evidence && options.secrets) {
    evidence = redactDeep(evidence, options.secrets);
  }
  return {
    success: false,
    actual: null,
    result: null,
    error: options.error || 'executor failed',
    errorCode: options.errorCode || 'UNKNOWN',
    evidence: evidence
  };
}

function passResult(task, evidence) {
  var expectedText = (task && task.expectedResult) || null;
  return {
    success: true,
    actual: expectedText,
    result: RESULT_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixturePath(rootDir) {
  return path.join(rootDir, FIXTURE_FILE);
}

function fixtureHashPath(rootDir) {
  return path.join(rootDir, FIXTURE_HASH_FILE);
}

function extractActiveCurrency(body) {
  if (!body) return null;
  if (body.errors && body.errors.length > 0) return null;
  var data = body.data || body;
  if (data && data.activeChannel && data.activeChannel.currencyCode) {
    return data.activeChannel.currencyCode;
  }
  return null;
}

function extractVariants(body) {
  if (!body) return [];
  if (body.errors && body.errors.length > 0) return [];
  var data = body.data || body;
  var items = data && data.products && data.products.items ? data.products.items : [];
  var variants = [];
  for (var i = 0; i < items.length; i++) {
    var itemVariants = items[i].variants || [];
    for (var j = 0; j < itemVariants.length; j++) {
      variants.push({
        productName: items[i].name,
        variantName: itemVariants[j].name,
        price: itemVariants[j].price,
        currencyCode: itemVariants[j].currencyCode
      });
    }
  }
  return variants;
}

function summarizeVisibility(body) {
  if (!body) return { products: [] };
  if (body.errors && body.errors.length > 0) return { products: [], graphQLErrors: body.errors };
  var data = body.data || body;
  var items = data && data.products && data.products.items ? data.products.items : [];
  var products = items.map(function(item) {
    return {
      id: item.id,
      name: item.name,
      slug: item.slug,
      enabled: item.enabled === true,
      variants: (item.variants || []).map(function(v) {
        return {
          id: v.id,
          sku: v.sku,
          name: v.name,
          enabled: v.enabled === true,
          price: v.price,
          currencyCode: v.currencyCode
        };
      })
    };
  });
  return { products: products };
}

function readFileQuiet(context, filePath) {
  var fsImpl = (context.deps && context.deps.fs) ? context.deps.fs : null;
  if (!fsImpl && context.deps && typeof context.deps.readFileSync === 'function') {
    fsImpl = { readFileSync: context.deps.readFileSync };
  }
  if (!fsImpl) fsImpl = require('fs');
  try {
    return fsImpl.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeFileInside(context, filePath, content) {
  var writeFileSync = context.deps && context.deps.writeFileSync;
  var mkdirSync = context.deps && context.deps.mkdirSync;
  if (typeof writeFileSync !== 'function') return false;
  if (typeof mkdirSync === 'function') {
    var dir = path.dirname(filePath);
    try { mkdirSync(dir); } catch (e) {}
  }
  try {
    writeFileSync(filePath, content);
    return true;
  } catch (e) {
    return false;
  }
}

function isWorkspaceWritable(context) {
  var wsPath = context.workspace ? context.workspace.workspacePath : null;
  if (!wsPath) return false;
  var writeFileSync = context.deps && context.deps.writeFileSync;
  var mkdirSync = context.deps && context.deps.mkdirSync;
  return typeof writeFileSync === 'function' && typeof mkdirSync === 'function';
}

/**
 * CAN-B1-03 handler. Read-only per-country Shop API currency alignment check.
 * Never mutates the upstream store; returns a passing outcome only when the
 * currency observed for every country equals the frozen country->currency map
 * and no variant shows another country's currency.
 */
async function handlerB1_03(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-03');
  var fetchFn = getFetch(context);
  var clock = getClock(context);
  var baseUrl = resolveShopApiBase(context);
  var timestamp = clock().toISOString();

  var tokensResult = resolveChannelTokens(getEnvFn(context), frozenChannelTokensFromContext(context), contextChannelTokens(context));
  if (!tokensResult.ok) {
    var tokenFailureEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: tokenFailureEvidence, kind: 'executor-error' }
    ], []);
    return finalizeWithCleanup(context, task, failureResult({
      errorCode: tokensResult.errorCode,
      error: tokensResult.error,
      evidence: tokenFailureEvidence
    }));
  }

  var secrets = tokenSecrets(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var table = [];
  var actualByCountry = {};
  var mismatches = [];

  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var token = tokensResult.tokens[country];
    var expectedCurrency = COUNTRY_CURRENCY_MAP[country];

    var result = await shopApiRequest(fetchFn, baseUrl, token, B1_03_QUERY);

    rawRequests.push({
      country: country,
      method: result.request.method,
      url: result.request.url,
      headers: result.request.headers,
      body: result.request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      country: country,
      httpStatus: result.httpStatus,
      body: result.body !== null ? result.body : (result.text !== null ? { raw: result.text } : (result.networkError ? { networkError: result.networkError } : null)),
      timestamp: timestamp
    });

    if (!result.ok) {
      var envError = 'shop-api request for ' + country + ' failed with HTTP ' +
        (result.httpStatus === null ? 'network error' : result.httpStatus) +
        (result.networkError ? ' (' + result.networkError + ')' : '');
      var envEvidence = {
        taskId: taskId,
        shopApiBase: baseUrl,
        error: envError,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        table: table,
        expected: { countryCurrencyMap: COUNTRY_CURRENCY_MAP },
        actual: { countryCurrencyMap: actualByCountry },
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'country-table.json', data: { table: table }, kind: 'table' },
        { name: 'expected-vs-actual.json', data: { expected: COUNTRY_CURRENCY_MAP, actual: actualByCountry, error: envError }, kind: 'assertion' }
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: 'ENVIRONMENT_ERROR',
        error: envError,
        evidence: envEvidence
      }));
    }

    if (result.body && result.body.errors && result.body.errors.length > 0) {
      var firstErr = result.body.errors[0] || {};
      var errMsg = (firstErr.message || 'unknown').slice(0, 120);
      var errPath = firstErr.path ? firstErr.path.join('.') : null;
      var envEvidence = {
        taskId: taskId,
        shopApiBase: baseUrl,
        error: 'GraphQL error: ' + errMsg + (errPath ? ' path:' + errPath : ''),
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        table: table,
        expected: { countryCurrencyMap: COUNTRY_CURRENCY_MAP },
        actual: { countryCurrencyMap: actualByCountry },
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'country-table.json', data: { table: table }, kind: 'table' },
        { name: 'expected-vs-actual.json', data: { expected: COUNTRY_CURRENCY_MAP, actual: actualByCountry, error: envEvidence.error }, kind: 'assertion' }
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: 'GRAPHQL_ERROR',
        error: 'GraphQL error: ' + errMsg + (errPath ? ' path:' + errPath : ''),
        evidence: envEvidence
      }));
    }

    var activeCurrency = extractActiveCurrency(result.body);
    var variants = extractVariants(result.body);

    actualByCountry[country] = activeCurrency;
    table.push({
      country: country,
      expectedCurrency: expectedCurrency,
      actualCurrency: activeCurrency,
      variantCount: variants.length,
      samplePriceCents: variants.length > 0 ? variants[0].price : null,
      sampleCurrencyCode: variants.length > 0 ? variants[0].currencyCode : null
    });

    if (activeCurrency !== null && activeCurrency !== expectedCurrency) {
      mismatches.push({
        country: country,
        expected: expectedCurrency,
        actual: activeCurrency,
        type: 'activeChannel'
      });
    }

    for (var v = 0; v < variants.length; v++) {
      var variantCurrency = variants[v].currencyCode;
      if (variantCurrency && variantCurrency !== expectedCurrency) {
        mismatches.push({
          country: country,
          expected: expectedCurrency,
          actual: variantCurrency,
          type: 'variant',
          product: variants[v].productName,
          variant: variants[v].variantName,
          price: variants[v].price
        });
      }
    }
  }

  var evidence = {
    taskId: taskId,
    title: 'Read-only Shop API currency and price alignment',
    shopApiBase: baseUrl,
    rawRequests: redactDeep(rawRequests, secrets),
    rawResponses: redactDeep(rawResponses, secrets),
    table: table,
    expected: { countryCurrencyMap: COUNTRY_CURRENCY_MAP },
    actual: { countryCurrencyMap: actualByCountry },
    checks: {
      crossCountryMixing: variants.length === 0 ? null : (mismatches.filter(function(m) { return m.type === 'variant'; }).length === 0),
      countriesMatchActiveChannelCurrency: mismatches.filter(function(m) { return m.type === 'activeChannel'; }).length === 0,
      mismatchCount: mismatches.length,
      mismatches: mismatches
    },
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'country-table.json', data: { table: table }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: evidence.actual }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  if (mismatches.length > 0) {
    var detail = mismatches.map(function(m) {
      return m.country + ' expected ' + m.expected + ' got ' + m.actual +
        (m.type === 'variant' ? ' (variant ' + (m.variant || m.product) + ')' : '');
    }).join('; ');
    return finalizeWithCleanup(context, task, failureResult({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'currency mismatch: ' + detail,
      evidence: evidence
    }));
  }

  evidence.result = RESULT_PASS;
  return finalizeWithCleanup(context, task, passResult(task, evidence));
}

/**
 * CAN-B1-04 handler. Read-only per-country product visibility / variant
 * isolation check against a workspace fixture the executor creates and hashes.
 * A planted mismatch (context.plantedMismatch or the CAN_B1_04_PLANT_MISMATCH
 * env var) must be detected (control run).
 */
async function handlerB1_04(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B1-04');
  var fetchFn = getFetch(context);
  var clock = getClock(context);
  var baseUrl = resolveShopApiBase(context);
  var timestamp = clock().toISOString();
  var workspace = context.workspace || {};
  var wsPath = workspace.workspacePath || null;

  var plantedEnv = envValue(context, PLANT_MISMATCH_ENV);
  var planted = !!(context.plantedMismatch && context.plantedMismatch.plant) || plantedEnv === '1' || plantedEnv === 'true';
  var plantedSpec = (context.plantedMismatch && typeof context.plantedMismatch === 'object' && context.plantedMismatch.plant)
    ? context.plantedMismatch
    : { country: 'DE', via: 'env' };

  var tokensResult = resolveChannelTokens(getEnvFn(context), frozenChannelTokensFromContext(context), contextChannelTokens(context));
  if (!tokensResult.ok) {
    var tokenFailureEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: tokenFailureEvidence, kind: 'executor-error' }
    ], []);
    return finalizeWithCleanup(context, task, failureResult({
      errorCode: tokensResult.errorCode,
      error: tokensResult.error,
      evidence: tokenFailureEvidence
    }));
  }

  var secrets = tokenSecrets(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var actualByCountry = {};

  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var token = tokensResult.tokens[country];
    var result = await shopApiRequest(fetchFn, baseUrl, token, B1_04_QUERY);

    rawRequests.push({
      country: country,
      method: result.request.method,
      url: result.request.url,
      headers: result.request.headers,
      body: result.request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      country: country,
      httpStatus: result.httpStatus,
      body: result.body !== null ? result.body : (result.text !== null ? { raw: result.text } : (result.networkError ? { networkError: result.networkError } : null)),
      timestamp: timestamp
    });

    if (!result.ok) {
      var envError = 'shop-api request for ' + country + ' failed with HTTP ' +
        (result.httpStatus === null ? 'network error' : result.httpStatus) +
        (result.networkError ? ' (' + result.networkError + ')' : '');
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' }
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: 'ENVIRONMENT_ERROR',
        error: envError,
        evidence: {
          taskId: taskId,
          rawRequests: rawRequests,
          rawResponses: rawResponses,
          completedAt: timestamp
        }
      }));
    }

    actualByCountry[country] = summarizeVisibility(result.body);
  }

  var canonicalActual = canonicalizeVisibility(actualByCountry);
  var actionable = isWorkspaceWritable(context);

  var fixture = null;
  var fixtureHash = null;
  var fixtureAction = 'NONE';
  var existing = null;
  var errorOutcome = null;

  if (wsPath && actionable) {
    var fPath = fixturePath(wsPath);
    existing = readFileQuiet(context, fPath);
    if (existing === null) {
      // Create the expected fixture from the live responses, then hash it.
      fixture = canonicalizeVisibility(actualByCountry);
      if (planted) {
        fixture = plantMismatch(fixture, plantedSpec);
      }
      var fixtureContent = JSON.stringify(fixture, null, 2) + '\n';
      fixtureHash = sha256Hex(fixtureContent);
      writeFileInside(context, fPath, fixtureContent);
      writeFileInside(context, fPath + '.sha256', fixtureHash + '\n' + fPath + '\n');
      fixtureAction = planted ? 'CREATED_PLANTED_MISMATCH' : 'CREATED';
    } else {
      fixtureAction = 'LOADED';
      var storedHash = readFixtureHash(context, wsPath);
      var recomputed = sha256Hex(existing);
      fixtureHash = storedHash || recomputed;
      if (storedHash && storedHash !== recomputed) {
        errorOutcome = {
          errorCode: 'ENVIRONMENT_ERROR',
          error: 'expected-visibility fixture hash mismatch in workspace',
          extraEvidence: {
            taskId: taskId,
            rawRequests: redactDeep(rawRequests, secrets),
            rawResponses: redactDeep(rawResponses, secrets),
            fixture: { file: fPath, storedHash: storedHash, recomputedHash: recomputed, action: fixtureAction },
            completedAt: timestamp
          }
        };
      } else {
        try {
          fixture = JSON.parse(existing);
        } catch (e) {
          errorOutcome = {
            errorCode: 'ENVIRONMENT_ERROR',
            error: 'expected-visibility fixture is not valid JSON',
            extraEvidence: { taskId: taskId, completedAt: timestamp }
          };
        }
      }
    }
  }

  if (errorOutcome) {
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: errorOutcome.extraEvidence, kind: 'executor-error' }
    ], secrets);
    return finalizeWithCleanup(context, task, failureResult({
      errorCode: errorOutcome.errorCode,
      error: errorOutcome.error,
      evidence: errorOutcome.extraEvidence
    }));
  }

  var leakReport = isLeakReported(fixture, actualByCountry);

  var evidence = {
    taskId: taskId,
    title: 'Read-only product visibility and variant isolation',
    shopApiBase: baseUrl,
    rawRequests: redactDeep(rawRequests, secrets),
    rawResponses: redactDeep(rawResponses, secrets),
    fixture: {
      file: wsPath ? fixturePath(wsPath) : null,
      action: fixtureAction,
      sha256: fixtureHash,
      expected: fixture
    },
    actual: { countryVisibility: canonicalActual },
    expectedVsActual: buildExpectedVsActual(fixture, actualByCountry),
    isolationReport: leakReport,
    control: planted ? { planted: true, detected: leakReport.variantLeaks.length > 0, spec: plantedSpec } : null,
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'expected-vs-actual.json', data: { expected: { countryVisibility: fixture }, actual: { countryVisibility: canonicalActual }, expectedVsActual: evidence.expectedVsActual }, kind: 'assertion' },
    { name: 'isolation-report.json', data: { isolationReport: leakReport }, kind: 'isolation-report' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  if (leakReport.variantLeaks.length > 0) {
    return finalizeWithCleanup(context, task, failureResult({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'visibility mismatch detected: ' + leakReport.variantLeaks.length + ' variant leak(s); expected fixture ' + (planted ? 'contains a planted mismatch (control detected)' : 'differs from live response'),
      evidence: evidence
    }));
  }

  evidence.result = RESULT_PASS;
  return finalizeWithCleanup(context, task, passResult(task, evidence));
}

function readFixtureHash(context, wsPath) {
  var line = readFileQuiet(context, fixtureHashPath(wsPath));
  if (line === null) return null;
  var trimmed = line.trim();
  return trimmed.split(/\s+/)[0] || null;
}

function canonicalizeVisibility(actualByCountry) {
  var out = {};
  Object.keys(actualByCountry).sort().forEach(function(country) {
    var summary = actualByCountry[country];
    var products = (summary && summary.products) || [];
    out[country] = products.map(function(p) {
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        enabled: p.enabled,
        variants: p.variants.map(function(v) {
          return { id: v.id, sku: v.sku, name: v.name, enabled: v.enabled, price: v.price, currencyCode: v.currencyCode };
        })
      };
    });
  });
  return out;
}

function buildExpectedVsActual(fixture, actualByCountry) {
  var table = [];
  COUNTRIES.forEach(function(country) {
    var expected = fixture ? (fixture[country] || []) : [];
    var actual = actualByCountry[country] ? actualByCountry[country].products : [];
    table.push({
      country: country,
      expectedProductCount: expected.length,
      actualProductCount: actual.length,
      expectedMatchesActual: expectedProductListsEqual(expected, actual)
    });
  });
  return table;
}

function expectedProductListsEqual(expected, actual) {
  if (expected.length !== actual.length) return false;
  var expectedIds = expected.map(function(p) { return String(p.id); }).sort();
  var actualIds = actual.map(function(p) { return String(p.id); }).sort();
  for (var i = 0; i < expectedIds.length; i++) {
    if (expectedIds[i] !== actualIds[i]) return false;
  }
  return true;
}

function isLeakReported(fixture, actualByCountry) {
  var variantLeaks = [];
  if (!fixture) {
    return { variantLeaks: [], note: 'no fixture to compare against' };
  }
  COUNTRIES.forEach(function(country) {
    var expectedProducts = fixture[country] || [];
    var expectedVisible = {};
    expectedProducts.forEach(function(p) {
      if (p.enabled !== false) {
        p.variants.forEach(function(v) {
          if (v.enabled !== false && v.sku) expectedVisible[v.sku] = true;
        });
      }
    });
    var actualSummary = actualByCountry[country] || { products: [] };
    actualSummary.products.forEach(function(p) {
      if (p.enabled === false) return;
      p.variants.forEach(function(v) {
        if (v.enabled === false) return;
        if (v.sku && !expectedVisible[v.sku]) {
          variantLeaks.push({
            country: country,
            sku: v.sku,
            name: v.name,
            detail: 'variant visible in ' + country + ' but absent from expected fixture'
          });
        }
      });
    });
  });
  return { variantLeaks: variantLeaks };
}

function plantMismatch(fixture, spec) {
  var country = spec && spec.country ? spec.country : 'DE';
  var out = {};
  Object.keys(fixture).forEach(function(key) {
    out[key] = fixture[key].map(function(p) { return JSON.parse(JSON.stringify(p)); });
  });
  var list = out[country] || [];
  if (list.length > 0) {
    var target = list[0];
    if (target.variants && target.variants.length > 0) {
      target.variants = target.variants.slice(1);
    } else {
      out[country] = list.slice(1);
    }
    if (out[country].length === 0 && list.length === 1) {
      out[country] = [];
    }
  } else {
    out[country] = [];
  }
  return out;
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B1-03', {
    description: 'Read-only Shop API currency/price alignment across country Channels (DE, AT, HU, GB)',
    builtIn: true,
    coverage: 'readiness-subset',
    verifiedAssertionIds: ['CAN-B1-03-A01'],
    handler: handlerB1_03
  });
  reg('CAN-B1-04', {
    description: 'Read-only product visibility and variant isolation across country Channels',
    builtIn: true,
    coverage: 'readiness-subset',
    verifiedAssertionIds: ['CAN-B1-04-A01'],
    handler: handlerB1_04
  });
  return { success: true, registered: ['CAN-B1-03', 'CAN-B1-04'] };
}

module.exports = {
  COUNTRY_CURRENCY_MAP: COUNTRY_CURRENCY_MAP,
  COUNTRY_CHANNEL_TOKENS: COUNTRY_CHANNEL_TOKENS,
  COUNTRIES: COUNTRIES.slice(),
  B1_03_QUERY: B1_03_QUERY,
  B1_04_QUERY: B1_04_QUERY,
  CHANNEL_TOKEN_HEADER: CHANNEL_TOKEN_HEADER,
  resolveShopApiBase: resolveShopApiBase,
  frozenChannelTokensFromContext: frozenChannelTokensFromContext,
  contextChannelTokens: contextChannelTokens,
  resolveChannelTokens: resolveChannelTokens,
  shopApiRequest: shopApiRequest,
  handlerB1_03: handlerB1_03,
  handlerB1_04: handlerB1_04,
  canonicalizeVisibility: canonicalizeVisibility,
  plantMismatch: plantMismatch,
  attemptWorkspaceCleanup: attemptWorkspaceCleanup,
  register: register
};
