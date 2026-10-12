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
var adminChannelInventory = require('./adminChannelInventory');

var RESULT_PASS = terminalState.RESULT_PASS;

// Set by runInventoryDiagnostic whenever the channel inventory diagnostic runs
// on a failure path, so the executor-error.json entry can include a short
// summary without touching every evidence write site. Never holds secrets.
var lastInventorySummary = null;

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
  '    items { id name slug variants { id sku name price currencyCode } }',
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

/**
 * Extract the activeChannel.code from a probe response body.
 * Returns null if unavailable.
 */
function extractActiveChannelCode(body) {
  if (!body) return null;
  if (body.errors && body.errors.length > 0) return null;
  var data = body.data || body;
  if (data && data.activeChannel && typeof data.activeChannel.code === 'string') {
    return data.activeChannel.code;
  }
  return null;
}

/**
 * Returns true when the Shop API probe returned __default_channel__,
 * which is the symptom of a staging DB that has only the default channel.
 * Also returns true if the products failure indicates a staging data problem
 * (the specific "invalid input syntax for type integer" error that appears
 * when channels/catalog are missing).
 */
function shouldRunInventoryCheck(probeResult, productsResult) {
  if (!probeResult || !probeResult.body) return false;
  var channelCode = extractActiveChannelCode(probeResult.body);
  if (channelCode === '__default_channel__') return true;
  if (productsResult && productsResult.body) {
    var body = productsResult.body;
    if (body && body.errors && Array.isArray(body.errors)) {
      for (var i = 0; i < body.errors.length; i++) {
        var msg = body.errors[i] && body.errors[i].message ? body.errors[i].message : '';
        if (msg.indexOf('invalid input syntax for type integer') !== -1 ||
            msg.indexOf('undefined') !== -1) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Run the Admin API channel inventory diagnostic and write its evidence.
 * Returns the inventory result object (never throws).
 *
 * On the failure path: updates result.errorCode to STAGING_DATA_MISSING and
 * augments the error message when channels are actually missing.
 *
 * @param {object} context
 * @param {string} taskId
 * @param {object} result  - the current failure result to be modified
 * @param {object} tokensResult - resolved channel tokens from resolveChannelTokens()
 * @param {string} shopApiBase - resolved Shop API base URL
 * @param {object} options - {probeResult, productsResult, secrets}
 * @returns {Promise<object>} updated failure result
 */
async function runInventoryDiagnostic(context, taskId, result, tokensResult, shopApiBase, options) {
  options = options || {};
  var probeResult = options.probeResult || null;
  var productsResult = options.productsResult || null;
  var existingSecrets = options.secrets || [];

  var stagingUrl = shopApiBase ? shopApiBase.replace(/\/shop-api\/?$/, '') : null;
  var inventoryResult = await adminChannelInventory.collectChannelInventory(context, {
    stagingUrl: stagingUrl,
    tokensResult: tokensResult,
    shopApiBase: shopApiBase
  });

  // Combine all secrets: existing channel tokens + password + auth token.
  var allSecrets = existingSecrets.slice();
  if (inventoryResult.secrets && Array.isArray(inventoryResult.secrets)) {
    for (var si = 0; si < inventoryResult.secrets.length; si++) {
      var s = inventoryResult.secrets[si];
      if (s && allSecrets.indexOf(s) === -1) allSecrets.push(s);
    }
  }

  // Write the admin-channel-inventory.json evidence (kind: diagnostic).
  var inventoryEvidence = {
    taskId: taskId,
    available: inventoryResult.available,
    reason: inventoryResult.reason,
    channels: inventoryResult.available ? inventoryResult.channels : null,
    expected: inventoryResult.available ? inventoryResult.expected : null,
    perCountry: inventoryResult.available ? inventoryResult.perCountry : null,
    missing: inventoryResult.missing || [],
    unexpectedDefaultOnly: inventoryResult.unexpectedDefaultOnly || false,
    perChannelProductCounts: inventoryResult.perChannelProductCounts || [],
    credentialNames: inventoryResult.credentialNames || null,
    introspectedFields: inventoryResult.introspectedFields || [],
    timestamp: inventoryResult.timestamp,
    callCount: inventoryResult.callCount || 0,
    adminApiBase: adminChannelInventory.resolveAdminApiBase(context)
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'admin-channel-inventory.json', data: inventoryEvidence, kind: 'diagnostic' }
  ], allSecrets);

  // If the inventory is unavailable or admin login failed, keep the existing
  // STAGING_SERVER_ERROR behaviour; just record the reason in evidence.
  if (!inventoryResult.available) {
    lastInventorySummary = { available: false, reason: inventoryResult.reason };
    result.evidence = result.evidence || {};
    result.evidence.adminInventory = {
      available: false,
      reason: inventoryResult.reason,
      error: inventoryResult.error || null
    };
    return result;
  }

  // Inventory is available: check for missing channels.
  var missing = inventoryResult.missing || [];
  lastInventorySummary = {
    available: true,
    missing: missing,
    unexpectedDefaultOnly: !!inventoryResult.unexpectedDefaultOnly
  };
  if (missing.length > 0 || inventoryResult.unexpectedDefaultOnly) {
    // Upgrade error code to STAGING_DATA_MISSING so it maps to DEPENDENCY_ENVIRONMENT.
    result.errorCode = 'STAGING_DATA_MISSING';
    result.error = 'staging has no channel for: ' + missing.join(', ') + ' (only __default_channel__ found)';
    result.evidence = result.evidence || {};
    result.evidence.adminInventory = {
      available: true,
      missing: missing,
      unexpectedDefaultOnly: inventoryResult.unexpectedDefaultOnly,
      perCountry: inventoryResult.perCountry
    };
  } else {
    // Channels exist but something else failed; record inventory for context.
    result.evidence = result.evidence || {};
    result.evidence.adminInventory = {
      available: true,
      missing: [],
      unexpectedDefaultOnly: false,
      perCountry: inventoryResult.perCountry
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------
/**
 * Inspect a Shop API response for GraphQL errors and classify them so an
 * invalid query (our own bug) is never mislabeled as client input or as a
 * plain environment error.
 *
 *   HTTP 400 + GRAPHQL_VALIDATION_FAILED / GRAPHQL_PARSE_FAILED -> QUERY_INVALID
 *   HTTP 200 + errors (INTERNAL_SERVER_ERROR or no code)          -> STAGING_SERVER_ERROR
 *   HTTP 200 + errors with any other code                         -> GRAPHQL_ERROR (fallback)
 *   Anything else (network failure, 5xx, timeout, non-GraphQL)    -> null (caller
 *     falls back to ENVIRONMENT_ERROR)
 *
 * Returns null when there is no GraphQL error to classify. The first error's
 * message, path and extensions.code are always kept (they are redacted later
 * via redactDeep when written to evidence).
 */
function gqlErrorInfo(result) {
  var body = result && result.body;
  if (!body || !Array.isArray(body.errors) || body.errors.length === 0) {
    return null;
  }
  var first = body.errors[0] || {};
  var extensions = (first.extensions && typeof first.extensions === 'object') ? first.extensions : {};
  var code = extensions.code || null;
  var status = result.httpStatus;
  var info = {
    message: (first.message || 'unknown').slice(0, 120),
    path: Array.isArray(first.path) && first.path.length > 0 ? first.path.join('.') : null,
    extensionsCode: code,
    httpStatus: status
  };
  if (status === 400 && (code === 'GRAPHQL_VALIDATION_FAILED' || code === 'GRAPHQL_PARSE_FAILED')) {
    return Object.assign(info, { errorCode: 'QUERY_INVALID' });
  }
  if (status === 200) {
    if (code === 'INTERNAL_SERVER_ERROR' || !code) {
      return Object.assign(info, { errorCode: 'STAGING_SERVER_ERROR' });
    }
    return Object.assign(info, { errorCode: 'GRAPHQL_ERROR' });
  }
  // Network failure / 5xx / timeout / non-GraphQL body: not a GraphQL-error
  // classification; the caller keeps the generic ENVIRONMENT_ERROR path.
  return null;
}

function gqlErrorMessage(gql) {
  return 'GraphQL error: ' + gql.message + (gql.path ? ' path:' + gql.path : '');
}

var ACTIVE_CHANNEL_PROBE_QUERY = [
  'query ActiveChannelProbe {',
  '  activeChannel { code currencyCode }',
  '}'
].join('\n');

// The frozen registry placeholders from manifest/inputs-registry.json channelTokens.
// Only booleans about equality are ever written to evidence, never token values.
var REGISTRY_PLACEHOLDER_TOKENS = Object.keys(COUNTRY_CHANNEL_TOKENS).map(function(k) { return COUNTRY_CHANNEL_TOKENS[k]; });

/**
 * Build the no-secret token diagnostics for the evidence on failure: per country,
 * the token source (env|frozen|direct), whether the token is a non-empty
 * string, its length, and whether it equals one of the registry placeholder
 * values (boolean only). Token VALUES are never written.
 */
function buildTokenDiagnostics(tokensResult) {
  var source = (tokensResult && tokensResult.source) ? tokensResult.source : null;
  var tokens = (tokensResult && tokensResult.tokens) || {};
  var perCountry = {};
  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var t = tokens[country];
    perCountry[country] = {
      source: source,
      isNonEmptyString: typeof t === 'string' && t.length > 0,
      length: typeof t === 'string' ? t.length : null,
      equalsRegistryPlaceholder: typeof t === 'string' && REGISTRY_PLACEHOLDER_TOKENS.indexOf(t) !== -1
    };
  }
  return { source: source, perCountry: perCountry };
}

/**
 * Build the executor-error.json evidence entry used on any B1-03/B1-04 failure:
 * the no-secret token diagnostics plus the per-country probe outcomes so a
 * "probe: ok, products: failed" split is visible in one run.
 */
function executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, inventorySummary) {
  var payload = {
    taskId: taskId,
    tokenDiagnostics: buildTokenDiagnostics(tokensResult),
    probes: probeChecks || {}
  };
  if (inventorySummary) payload.adminInventorySummary = inventorySummary;
  return { name: 'executor-error.json', data: payload, kind: 'executor-error' };
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
  // The Shop API does not expose an `enabled` field: disabled items are simply
  // not returned. Anything the API returns is visible and purchasable in the
  // channel, so presence == enabled: true.
  var products = items.map(function(item) {
    return {
      id: item.id,
      name: item.name,
      slug: item.slug,
      enabled: true,
      variants: (item.variants || []).map(function(v) {
        return {
          id: v.id,
          sku: v.sku,
          name: v.name,
          enabled: true,
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
  lastInventorySummary = null;
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
      tokenDiagnostics: buildTokenDiagnostics(tokensResult),
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
  var probeChecks = {};
  var inventoryRan = false;

  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var token = tokensResult.tokens[country];
    var expectedCurrency = COUNTRY_CURRENCY_MAP[country];

    // Fix 5: cheap activeChannel probe before the products query so a failed
    // products query can be attributed to the staging resolver (probe ok) vs
    // a bad channel token (probe itself fails) in a single run.
    var probeResult = await shopApiRequest(fetchFn, baseUrl, token, ACTIVE_CHANNEL_PROBE_QUERY);
    var probeGql = gqlErrorInfo(probeResult);
    var probeOk = probeResult.ok && !probeGql;
    probeChecks[country] = { probe: probeOk, products: 'not-run', httpStatus: probeResult.httpStatus };

    rawRequests.push({
      country: country,
      method: probeResult.request.method,
      url: probeResult.request.url,
      headers: probeResult.request.headers,
      body: probeResult.request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      country: country,
      probe: true,
      httpStatus: probeResult.httpStatus,
      body: probeResult.body !== null ? probeResult.body : (probeResult.text !== null ? { raw: probeResult.text } : (probeResult.networkError ? { networkError: probeResult.networkError } : null)),
      timestamp: timestamp
    });

    if (probeGql || !probeResult.ok) {
      var probeErr = probeGql ? gqlErrorMessage(probeGql)
        : ('shop-api probe for ' + country + ' failed with HTTP ' + (probeResult.httpStatus === null ? 'network error' : probeResult.httpStatus));
      var probeEvidence = {
        taskId: taskId,
        shopApiBase: baseUrl,
        error: probeErr,
        graphQLError: probeGql ? { code: probeGql.extensionsCode, path: probeGql.path, message: probeGql.message } : null,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        table: table,
        expected: { countryCurrencyMap: COUNTRY_CURRENCY_MAP },
        actual: { countryCurrencyMap: actualByCountry },
        completedAt: timestamp
      };
      if (!inventoryRan && shouldRunInventoryCheck(probeResult, null)) {
        inventoryRan = true;
        var probeFailResult = failureResult({
          errorCode: probeGql ? probeGql.errorCode : 'ENVIRONMENT_ERROR',
          error: probeErr,
          evidence: probeEvidence
        });
        probeFailResult = await runInventoryDiagnostic(context, taskId, probeFailResult, tokensResult, baseUrl, {
          probeResult: probeResult,
          productsResult: null,
          secrets: secrets
        });
        probeEvidence = probeFailResult.evidence;
      }
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'country-table.json', data: { table: table }, kind: 'table' },
        { name: 'expected-vs-actual.json', data: { expected: COUNTRY_CURRENCY_MAP, actual: actualByCountry, error: probeErr }, kind: 'assertion' },
        executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, lastInventorySummary)
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: probeGql ? probeGql.errorCode : 'ENVIRONMENT_ERROR',
        error: probeErr,
        evidence: probeEvidence
      }));
    }

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
      probe: false,
      httpStatus: result.httpStatus,
      body: result.body !== null ? result.body : (result.text !== null ? { raw: result.text } : (result.networkError ? { networkError: result.networkError } : null)),
      timestamp: timestamp
    });

    var resultGql = gqlErrorInfo(result);

    if (!result.ok) {
      // A 400 with a GraphQL validation/parse error is our own bug
      // (QUERY_INVALID); a runtime resolver error reported over HTTP 200 is a
      // staging server error. Real network failures / 5xx / timeouts stay
      // ENVIRONMENT_ERROR.
      var failureCode = resultGql ? resultGql.errorCode : 'ENVIRONMENT_ERROR';
      var envError = resultGql ? gqlErrorMessage(resultGql)
        : ('shop-api request for ' + country + ' failed with HTTP ' +
          (result.httpStatus === null ? 'network error' : result.httpStatus) +
          (result.networkError ? ' (' + result.networkError + ')' : ''));
      probeChecks[country].products = 'failed';
      var envEvidence = {
        taskId: taskId,
        shopApiBase: baseUrl,
        error: envError,
        graphQLError: resultGql ? { code: resultGql.extensionsCode, path: resultGql.path, message: resultGql.message } : null,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        table: table,
        expected: { countryCurrencyMap: COUNTRY_CURRENCY_MAP },
        actual: { countryCurrencyMap: actualByCountry },
        completedAt: timestamp
      };
      if (!inventoryRan && shouldRunInventoryCheck(probeResult, result)) {
        inventoryRan = true;
        var productsFailResult = failureResult({
          errorCode: failureCode,
          error: envError,
          evidence: envEvidence
        });
        productsFailResult = await runInventoryDiagnostic(context, taskId, productsFailResult, tokensResult, baseUrl, {
          probeResult: probeResult,
          productsResult: result,
          secrets: secrets
        });
        envEvidence = productsFailResult.evidence;
        failureCode = productsFailResult.errorCode;
        envError = productsFailResult.error;
      }
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'country-table.json', data: { table: table }, kind: 'table' },
        { name: 'expected-vs-actual.json', data: { expected: COUNTRY_CURRENCY_MAP, actual: actualByCountry, error: envError }, kind: 'assertion' },
        executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, lastInventorySummary)
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: failureCode,
        error: envError,
        evidence: envEvidence
      }));
    }

    if (resultGql) {
      var errMsg = gqlErrorMessage(resultGql);
      probeChecks[country].products = 'failed';
      var graphQLEvidence = {
        taskId: taskId,
        shopApiBase: baseUrl,
        error: errMsg,
        graphQLError: { code: resultGql.extensionsCode, path: resultGql.path, message: resultGql.message },
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        table: table,
        expected: { countryCurrencyMap: COUNTRY_CURRENCY_MAP },
        actual: { countryCurrencyMap: actualByCountry },
        completedAt: timestamp
      };
      if (!inventoryRan && shouldRunInventoryCheck(probeResult, result)) {
        inventoryRan = true;
        var gqlFailResult = failureResult({
          errorCode: resultGql.errorCode,
          error: errMsg,
          evidence: graphQLEvidence
        });
        gqlFailResult = await runInventoryDiagnostic(context, taskId, gqlFailResult, tokensResult, baseUrl, {
          probeResult: probeResult,
          productsResult: result,
          secrets: secrets
        });
        if (gqlFailResult) {
          graphQLEvidence = gqlFailResult.evidence;
        }
      }
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'country-table.json', data: { table: table }, kind: 'table' },
        { name: 'expected-vs-actual.json', data: { expected: COUNTRY_CURRENCY_MAP, actual: actualByCountry, error: (gqlFailResult && gqlFailResult.error) ? gqlFailResult.error : errMsg }, kind: 'assertion' },
        executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, lastInventorySummary)
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: (gqlFailResult && gqlFailResult.errorCode) ? gqlFailResult.errorCode : resultGql.errorCode,
        error: (gqlFailResult && gqlFailResult.error) ? gqlFailResult.error : errMsg,
        evidence: graphQLEvidence
      }));
    }

    probeChecks[country].products = 'ok';

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
  lastInventorySummary = null;
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
      tokenDiagnostics: buildTokenDiagnostics(tokensResult),
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
  var probeChecks = {};
  var inventoryRan = false;

  for (var i = 0; i < COUNTRIES.length; i++) {
    var country = COUNTRIES[i];
    var token = tokensResult.tokens[country];

    // Fix 5: cheap activeChannel probe before the per-country products query.
    var probeResult = await shopApiRequest(fetchFn, baseUrl, token, ACTIVE_CHANNEL_PROBE_QUERY);
    var probeGql = gqlErrorInfo(probeResult);
    var probeOk = probeResult.ok && !probeGql;
    probeChecks[country] = { probe: probeOk, products: 'not-run', httpStatus: probeResult.httpStatus };

    rawRequests.push({
      country: country,
      method: probeResult.request.method,
      url: probeResult.request.url,
      headers: probeResult.request.headers,
      body: probeResult.request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      country: country,
      probe: true,
      httpStatus: probeResult.httpStatus,
      body: probeResult.body !== null ? probeResult.body : (probeResult.text !== null ? { raw: probeResult.text } : (probeResult.networkError ? { networkError: probeResult.networkError } : null)),
      timestamp: timestamp
    });

    if (probeGql || !probeResult.ok) {
      var probeErr = probeGql ? gqlErrorMessage(probeGql)
        : ('shop-api probe for ' + country + ' failed with HTTP ' + (probeResult.httpStatus === null ? 'network error' : probeResult.httpStatus));
      var b04ProbeEvidence = {
        taskId: taskId,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        graphQLError: probeGql ? { code: probeGql.extensionsCode, path: probeGql.path, message: probeGql.message } : null,
        completedAt: timestamp
      };
      if (!inventoryRan && shouldRunInventoryCheck(probeResult, null)) {
        inventoryRan = true;
        var b04ProbeFailResult = failureResult({
          errorCode: probeGql ? probeGql.errorCode : 'ENVIRONMENT_ERROR',
          error: probeErr,
          evidence: b04ProbeEvidence
        });
        b04ProbeFailResult = await runInventoryDiagnostic(context, taskId, b04ProbeFailResult, tokensResult, baseUrl, {
          probeResult: probeResult,
          productsResult: null,
          secrets: secrets
        });
        b04ProbeEvidence = b04ProbeFailResult.evidence;
      }
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, lastInventorySummary)
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: probeGql ? probeGql.errorCode : 'ENVIRONMENT_ERROR',
        error: probeErr,
        evidence: b04ProbeEvidence
      }));
    }

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
      probe: false,
      httpStatus: result.httpStatus,
      body: result.body !== null ? result.body : (result.text !== null ? { raw: result.text } : (result.networkError ? { networkError: result.networkError } : null)),
      timestamp: timestamp
    });

    var resultGql = gqlErrorInfo(result);

    if (!result.ok) {
      var failureCode = resultGql ? resultGql.errorCode : 'ENVIRONMENT_ERROR';
      var envError = resultGql ? gqlErrorMessage(resultGql)
        : ('shop-api request for ' + country + ' failed with HTTP ' +
          (result.httpStatus === null ? 'network error' : result.httpStatus) +
          (result.networkError ? ' (' + result.networkError + ')' : ''));
      probeChecks[country].products = 'failed';
      var b04EnvEvidence = {
        taskId: taskId,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        graphQLError: resultGql ? { code: resultGql.extensionsCode, path: resultGql.path, message: resultGql.message } : null,
        completedAt: timestamp
      };
      if (!inventoryRan && shouldRunInventoryCheck(probeResult, result)) {
        inventoryRan = true;
        var b04ProductsFailResult = failureResult({
          errorCode: failureCode,
          error: envError,
          evidence: b04EnvEvidence
        });
        b04ProductsFailResult = await runInventoryDiagnostic(context, taskId, b04ProductsFailResult, tokensResult, baseUrl, {
          probeResult: probeResult,
          productsResult: result,
          secrets: secrets
        });
        b04EnvEvidence = b04ProductsFailResult.evidence;
        failureCode = b04ProductsFailResult.errorCode;
        envError = b04ProductsFailResult.error;
      }
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, lastInventorySummary)
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: failureCode,
        error: envError,
        evidence: b04EnvEvidence
      }));
    }

    if (resultGql) {
      // HTTP 200 with GraphQL errors: staging server runtime failure, never a pass.
      var gqlErrMsg = gqlErrorMessage(resultGql);
      probeChecks[country].products = 'failed';
      var b04GqlEvidence = {
        taskId: taskId,
        rawRequests: rawRequests,
        rawResponses: rawResponses,
        graphQLError: { code: resultGql.extensionsCode, path: resultGql.path, message: resultGql.message },
        completedAt: timestamp
      };
      if (!inventoryRan && shouldRunInventoryCheck(probeResult, result)) {
        inventoryRan = true;
        var b04GqlFailResult = failureResult({
          errorCode: resultGql.errorCode,
          error: gqlErrMsg,
          evidence: b04GqlEvidence
        });
        b04GqlFailResult = await runInventoryDiagnostic(context, taskId, b04GqlFailResult, tokensResult, baseUrl, {
          probeResult: probeResult,
          productsResult: result,
          secrets: secrets
        });
        if (b04GqlFailResult) b04GqlEvidence = b04GqlFailResult.evidence;
      }
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        executorErrorEntry(context, taskId, tokensResult, probeChecks, secrets, lastInventorySummary)
      ], secrets);
      return finalizeWithCleanup(context, task, failureResult({
        errorCode: (b04GqlFailResult && b04GqlFailResult.errorCode) ? b04GqlFailResult.errorCode : resultGql.errorCode,
        error: (b04GqlFailResult && b04GqlFailResult.error) ? b04GqlFailResult.error : gqlErrMsg,
        evidence: b04GqlEvidence
      }));
    }

    probeChecks[country].products = 'ok';
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
