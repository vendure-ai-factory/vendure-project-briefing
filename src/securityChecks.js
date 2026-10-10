'use strict';

/**
 * Read-only security module (chunk 10b). New file only: does not modify
 * src/cli.js, the manifest, or existing tests. Exports a register() function
 * that Window 1 wires into the executor registry later.
 *
 * Scope (read-only, host-allowlisted):
 *  - an unauthenticated Admin API request is rejected
 *  - the Shop API returns no admin-only data without authentication
 *  - HTTP redirects to HTTPS
 *  - report which standard security headers are present (report only)
 *  - scan every evidence file and response for secret values
 *
 * The hard allowlist is host staging.tibella.eu only. Any other host is
 * refused before a request is made. Prohibited actions (fuzzing, brute force
 * or credential guessing, any write request, any other host) are refused and
 * a test proves each is refused.
 *
 * This module is a read-only check, not a mapped acceptance task: coverage is
 * "readiness-subset" and it is NOT registered under a CAN-ID. Results use
 * RESULT_PASS only.
 */

var terminalState = require('./terminalState');
var RESULT_PASS = terminalState.RESULT_PASS;

var CHECK_ID = 'CHECK-SECURITY-SUITE';
var DEFAULT_SHOP_API_BASE = 'https://staging.tibella.eu';
var ALLOWLIST = ['staging.tibella.eu'];

var ADMIN_API_PATH = '/admin-api';
var SHOP_API_PATH = '/shop-api';
var REDACTED_MARKER = '[REDACTED]';

var STANDARD_SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy'
];

// Patterns of secrets to scan for in evidence files and responses. Kept in
// sync with scripts/scan-secrets.js plus response-oriented patterns.
var SECRET_PATTERNS = [
  { pattern: /sk-or-v1-[a-zA-Z0-9_-]{20,}/, name: 'OpenRouter key' },
  { pattern: /OPENROUTER_API_KEY=(?!your_|sk-test-|test|_|placeholder|empty)[^\s&]{8,}/, name: 'OPENROUTER_API_KEY with real value' },
  { pattern: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, name: 'inline credential assignment' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, name: 'bearer token' }
];

// Fields that would only make sense in an authenticated Admin API response;
// an unauthenticated Shop API / Admin API must never reveal them.
var ADMIN_ONLY_TOKENS = [
  'administrators',
  'roles',
  'administrator',
  'channels',
  'paymentmethods',
  'roles',
  'customer',
  'customers',
  'order',
  'orders',
  'password',
  'accessToken',
  'authToken',
  'apiKey',
  'secret'
];

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

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
  return function() { return process.env; };
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function isAllowlistedHost(host) {
  if (!host) return false;
  var normalized = String(host).toLowerCase().replace(/\.$/, '');
  for (var i = 0; i < ALLOWLIST.length; i++) {
    if (normalized === ALLOWLIST[i]) return true;
  }
  return false;
}

function resolveBaseUrl(context) {
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

function hostnameOf(url) {
  try {
    var parsed = new URL(url);
    return parsed.hostname;
  } catch (e) {
    return null;
  }
}

function hostAllowed(context, host) {
  // Test seam: an isolated local test server can be allowlisted via
  // context.deps.allowedHosts. Production default is staging.tibella.eu only.
  var overrides = context && context.deps && context.deps.allowedHosts;
  if (Array.isArray(overrides) && overrides.length > 0) {
    var n = String(host || '').toLowerCase().replace(/\.$/, '');
    for (var i = 0; i < overrides.length; i++) {
      if (n === String(overrides[i]).toLowerCase().replace(/\.$/, '')) return true;
    }
    return false;
  }
  return isAllowlistedHost(host);
}

// ---------------------------------------------------------------------------
// Refusals (each prohibited action is refused; tests prove it)
// ---------------------------------------------------------------------------

function refusal(message, code, category) {
  return {
    success: false,
    actual: null,
    result: null,
    refused: true,
    errorCode: code,
    error: message,
    classification: 'SAFETY_AUTHORIZATION',
    cause: category,
    evidence: {
      refused: true,
      reason: message,
      category: category
    }
  };
}

function prohibitedCategory(context) {
  var options = (context && context.options) || {};
  var probe = options.probe || (context && context.probe);
  if (typeof probe === 'string') {
    var p = probe.toLowerCase();
    if (p.indexOf('fuzz') !== -1) return 'FUZZING';
    if (p.indexOf('brute') !== -1 || p.indexOf('guess') !== -1 || p.indexOf('credential') !== -1) return 'BRUTE_FORCE';
    if (p.indexOf('write') !== -1 || p.indexOf('mutat') !== -1) return 'WRITE_REQUEST';
  }
  var method = options.method || (context && context.method);
  if (typeof method === 'string' && /^(POST|PUT|PATCH|DELETE)$/i.test(method)) {
    var body = options.body || (context && context.graphqlBody) || '';
    if (typeof body === 'string' && /mutation/i.test(body)) return 'WRITE_REQUEST';
  }
  return null;
}

function refuseProhibited(context) {
  var category = prohibitedCategory(context);
  if (!category) return null;
  if (category === 'FUZZING') {
    return refusal('fuzzing is prohibited (read-only security module)', 'PROHIBITED_FUZZ', 'FUZZING');
  }
  if (category === 'BRUTE_FORCE') {
    return refusal('brute force or credential guessing is prohibited', 'PROHIBITED_BRUTE_FORCE', 'BRUTE_FORCE');
  }
  return refusal('write requests are prohibited (read-only security module)', 'PROHIBITED_WRITE', 'WRITE_REQUEST');
}

// ---------------------------------------------------------------------------
// Read-only requests
// ---------------------------------------------------------------------------

function requestText(fetchFn, url, method, bodyText, extraInit) {
  var headers = { 'content-type': 'application/json' };
  var init = { method: method, headers: headers };
  if (bodyText !== undefined && bodyText !== null) {
    init.body = bodyText;
  }
  if (extraInit && typeof extraInit === 'object') {
    Object.keys(extraInit).forEach(function (k) {
      init[k] = extraInit[k];
    });
  }
  var request = { method: method, url: url, headers: headers, body: bodyText || null };
  var startedAt = Date.now();
  return fetchFn(url, init)
    .then(function(response) {
      return response.text().then(
        function(text) {
          var body = null;
          if (text) {
            try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
          }
          return {
            ok: response.status >= 200 && response.status < 300,
            httpStatus: response.status,
            headers: collectHeaders(response),
            body: body,
            text: text,
            latencyMs: Date.now() - startedAt,
            request: request
          };
        },
        function() {
          return {
            ok: false,
            httpStatus: response.status,
            headers: collectHeaders(response),
            body: null,
            text: null,
            latencyMs: Date.now() - startedAt,
            networkError: 'response body read failed',
            request: request
          };
        }
      );
    })
    .catch(function(err) {
      return {
        ok: false,
        httpStatus: null,
        headers: null,
        body: null,
        text: null,
        latencyMs: Date.now() - startedAt,
        networkError: err && err.message ? err.message : String(err),
        request: request
      };
    });
}

function collectHeaders(response) {
  var out = {};
  if (response && typeof response.headers === 'object') {
    if (typeof response.headers.forEach === 'function') {
      response.headers.forEach(function(value, key) {
        out[String(key).toLowerCase()] = value;
      });
    } else {
      var keys = Object.keys(response.headers);
      for (var i = 0; i < keys.length; i++) {
        out[keys[i].toLowerCase()] = response.headers[keys[i]];
      }
    }
  }
  return out;
}

function adminUnauthenticatedProbe(fetchFn, baseUrl) {
  // Unauthenticated Admin API request: POST an introspection-ish read query
  // without any channel/authorization header. Must be rejected.
  return requestText(fetchFn, baseUrl + ADMIN_API_PATH, 'POST', JSON.stringify({ operationName: null, variables: {}, query: 'query { __typename }' }));
}

function shopApiProbe(fetchFn, baseUrl) {
  // Minimal unauthenticated Shop API request: { __typename } only. Must not
  // expose admin-only data.
  return requestText(fetchFn, baseUrl + SHOP_API_PATH, 'POST', JSON.stringify({ operationName: null, variables: {}, query: '{ __typename }' }));
}

function httpRedirectProbe(fetchFn, baseUrl) {
  // HTTP variants of the staging base must redirect to HTTPS. Probe the plain
  // http:// root and require a 3xx Location pointing at https://. The fetch
  // must not auto-follow the redirect, else the 3xx (and its Location header)
  // is lost; redirect:'manual' keeps the raw redirect response.
  var httpUrl = baseUrl.replace(/^https:\/\//i, 'http://');
  return requestText(fetchFn, httpUrl, 'GET', null, { redirect: 'manual' });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function isUnauthenticatedAdminRejected(result) {
  if (!result) return false;
  if (result.networkError) return false;
  // A rejected Admin API is 401/403 (or 400 with an auth error body).
  if (result.httpStatus === 401 || result.httpStatus === 403 || result.httpStatus === 4010) return true;
  if (result.httpStatus !== null && result.httpStatus >= 400 && result.httpStatus < 500) return true;
  if (result.text && /(not (authorized|authenticated)|unauthorized|forbidden|invalid.{0,20}(token|credentials))/i.test(result.text)) return true;
  return false;
}

function hasAdminOnlyData(result) {
  if (!result || typeof result.text !== 'string' || result.text.length === 0) return false;
  var lower = result.text.toLowerCase();
  for (var i = 0; i < ADMIN_ONLY_TOKENS.length; i++) {
    if (lower.indexOf(ADMIN_ONLY_TOKENS[i]) !== -1) return true;
  }
  return false;
}

function isHttpsRedirect(result) {
  if (!result || result.httpStatus === null) return false;
  if (result.httpStatus < 300 || result.httpStatus >= 400) return false;
  var location = (result.headers && (result.headers.location || result.headers.Location)) || '';
  return /^https:\/\//i.test(String(location));
}

function reportSecurityHeaders(results) {
  var seen = {};
  for (var i = 0; i < results.length; i++) {
    var headers = results[i] && results[i].headers;
    if (!headers) continue;
    var keys = Object.keys(headers);
    for (var k = 0; k < keys.length; k++) {
      seen[keys[k]] = headers[keys[k]];
    }
  }
  var present = [];
  var missing = [];
  for (var h = 0; h < STANDARD_SECURITY_HEADERS.length; h++) {
    var name = STANDARD_SECURITY_HEADERS[h];
    if (seen[name]) present.push(name);
    else missing.push(name);
  }
  return { present: present, missing: missing, all: STANDARD_SECURITY_HEADERS.slice() };
}

function scanForSecrets(results) {
  var findings = [];
  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    var candidates = [];
    if (result && typeof result.text === 'string' && result.text.length > 0) candidates.push(result.text);
    if (result && result.request && typeof result.request.body === 'string' && result.request.body.length > 0) candidates.push(result.request.body);
    if (result && result.request && typeof result.request.url === 'string') candidates.push(result.request.url);
    for (var c = 0; c < candidates.length; c++) {
      for (var p = 0; p < SECRET_PATTERNS.length; p++) {
        var matches = candidates[c].match(SECRET_PATTERNS[p].pattern);
        if (matches) {
          findings.push({
            pattern: SECRET_PATTERNS[p].name,
            sample: matches[0].substring(0, 20) + (matches[0].length > 20 ? '...' : '')
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function redactValue(value) {
  if (typeof value !== 'string') return value;
  var out = value;
  for (var i = 0; i < SECRET_PATTERNS.length; i++) {
    out = out.replace(SECRET_PATTERNS[i].pattern, REDACTED_MARKER);
  }
  return out;
}

function redactDeep(value) {
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) arr.push(redactDeep(value[i]));
    return arr;
  }
  if (value !== null && typeof value === 'object') {
    var out = {};
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) out[keys[k]] = redactDeep(value[keys[k]]);
    return out;
  }
  return redactValue(value);
}

// ---------------------------------------------------------------------------
// Evidence
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
 * Persist executor evidence and a canonical record through the pipeline
 * supplied deps (writeEvidenceFile/writeTaskRecord). No-op when the deps are
 * absent, mirroring the other executors so a standalone handler works.
 */
function writeExecutorEvidence(context, taskId, evidence, record) {
  var deps = context && context.deps ? context.deps : {};
  var runId = runIdOf(context);
  if (!runId || !taskId) return { ok: false, reason: 'no runId/taskId' };
  var wroteAny = false;
  try {
    if (typeof deps.writeEvidenceFile === 'function') {
      deps.writeEvidenceFile(runId, taskId, 'security-check.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'security-check' });
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function' && record) {
      deps.writeTaskRecord(runId, taskId, record, { scriptTask: false });
      wroteAny = true;
    }
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e), wroteAny: wroteAny };
  }
  return { ok: true, wroteAny: wroteAny };
}

function buildRecord(context, taskId, evidence, outcome) {
  var task = context && context.task ? context.task : {};
  return {
    canonicalId: taskId,
    summarySpecIds: Array.isArray(task.summaryIds) ? task.summaryIds.slice() : [],
    referenceRevision: (context && context.manifest && context.manifest.source && context.manifest.source.referenceCommit) || null,
    executionRevision: evidence.executionRevision || null,
    environmentIdentity: {
      runId: runIdOf(context),
      workspaceId: (context.workspace && context.workspace.workspaceId) || null,
      workspacePath: (context.workspace && context.workspace.workspacePath) || null
    },
    commandInvocation: null,
    inputArtifactIds: [],
    expectedResult: task.expectedResult || null,
    actualResult: outcome.actual || null,
    exitErrorResult: { exitCode: outcome.success ? 0 : 1, error: outcome.error || null },
    generatedArtifacts: ['security-check.json'],
    stateChanges: {
      success: outcome.success === true,
      readOnly: true,
      checks: evidence.checks || null
    },
    cleanupResetResult: null,
    finalClassification: outcome.success ? RESULT_PASS : 'BLOCK',
    naReason: null,
    result: outcome.success ? RESULT_PASS : 'BLOCK',
    classification: outcome.success ? null : (outcome.classification || null),
    cause: outcome.success ? null : (outcome.cause || null),
    coverage: evidence.coverage || null,
    scope: evidence.scope || null
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function execRevision(context) {
  var rec = context.runEnvRecord;
  var rev = rec && (rec.gitHead || rec.revisionId);
  return rev || null;
}

/**
 * Run the read-only security checks against the resolved staging base.
 * Returns { success, actual, result, errorCode, error, evidence }.
 */
async function handlerSecurityChecks(context) {
  context = context || {};
  var taskId = CHECK_ID;
  if (context.taskId) taskId = context.taskId;
  if (context.task && context.task.canonicalId) taskId = context.task.canonicalId;

  var baseUrl = resolveBaseUrl(context);
  var host = hostnameOf(baseUrl);
  var cc = getClock(context);
  var timestamp = cc().toISOString();

  // Host allowlist: any other host is refused before a request is made.
  if (!hostAllowed(context, host)) {
    var refusedHost = refusal('host not allowed: ' + host + ' (allowlist: staging.tibella.eu only)', 'HOST_NOT_ALLOWED', 'OTHER_HOST');
    refusedHost.taskId = taskId;
    refusedHost.checks = { hostAllowed: false };
    var evHost = {
      taskId: taskId,
      coverage: 'readiness-subset',
      executionRevision: execRevision(context),
      scope: 'security',
      checks: { hostAllowed: false },
      reason: 'host not allowed',
      timestamp: timestamp
    };
    writeExecutorEvidence(context, taskId, evHost, buildRecord(context, taskId, evHost, refusedHost));
    return refusedHost;
  }

  // Prohibited actions are refused before any request.
  var prohibited = refuseProhibited(context);
  if (prohibited) {
    prohibited.taskId = taskId;
    var evProhibited = {
      taskId: taskId,
      coverage: 'readiness-subset',
      executionRevision: execRevision(context),
      scope: 'security',
      checks: { prohibited: true, category: prohibited.cause },
      reason: prohibited.error,
      timestamp: timestamp
    };
    writeExecutorEvidence(context, taskId, evProhibited, buildRecord(context, taskId, evProhibited, prohibited));
    return prohibited;
  }

  var fetchFn = getFetch(context);

  var admin = await adminUnauthenticatedProbe(fetchFn, baseUrl);
  var shop = await shopApiProbe(fetchFn, baseUrl);
  var redirect = await httpRedirectProbe(fetchFn, baseUrl);

  var checks = {
    hostAllowed: true,
    unauthenticatedAdminRejected: isUnauthenticatedAdminRejected(admin),
    shopApiNoAdminData: !hasAdminOnlyData(shop),
    httpsRedirect: isHttpsRedirect(redirect)
  };

  var headersReport = reportSecurityHeaders([admin, shop, redirect]);
  var secretFindings = scanForSecrets([admin, shop, redirect]);

  var allPass = checks.unauthenticatedAdminRejected === true &&
    checks.shopApiNoAdminData === true &&
    checks.httpsRedirect === true;

  // Header report is report-only (never a fail); a leaked secret is a fail.
  allPass = allPass && secretFindings.length === 0;

  var evidence = {
    taskId: taskId,
    title: 'Read-only security checks against staging',
    shopApiBase: baseUrl,
    coverage: 'readiness-subset',
    executionRevision: execRevision(context),
    scope: 'security',
    checks: checks,
    headersReport: headersReport,
    secretsScan: { clean: secretFindings.length === 0, findings: secretFindings },
    requests: redactDeep([admin.request, shop.request, redirect.request]),
    responses: redactDeep([
      { httpStatus: admin.httpStatus, headers: admin.headers, body: admin.body },
      { httpStatus: shop.httpStatus, headers: shop.headers, body: shop.body },
      { httpStatus: redirect.httpStatus, headers: redirect.headers, location: (redirect.headers && (redirect.headers.location || redirect.headers.Location)) || null }
    ]),
    timing: [
      { probe: 'adminUnauthenticated', httpStatus: admin.httpStatus, latencyMs: admin.latencyMs },
      { probe: 'shopApiNoAuth', httpStatus: shop.httpStatus, latencyMs: shop.latencyMs },
      { probe: 'httpRedirect', httpStatus: redirect.httpStatus, latencyMs: redirect.latencyMs }
    ],
    summary: {
      allChecksPass: allPass,
      result: allPass ? RESULT_PASS : 'BLOCK'
    },
    timestamp: timestamp
  };

  if (!allPass) {
    var reasons = [];
    if (!checks.unauthenticatedAdminRejected) reasons.push('unauthenticated Admin API request was not rejected');
    if (!checks.shopApiNoAdminData) reasons.push('Shop API exposed admin-only data without auth');
    if (!checks.httpsRedirect) reasons.push('HTTP did not redirect to HTTPS');
    if (secretFindings.length > 0) reasons.push('secret values found: ' + secretFindings.map(function(f) { return f.pattern; }).join(', '));
    var failure = refusal(reasons.join('; '), 'SECURITY_CHECK_FAILED', 'SECURITY_CHECK');
    failure.taskId = taskId;
    failure.checks = checks;
    failure.evidence = evidence;
    evidence.result = 'BLOCK';
    writeExecutorEvidence(context, taskId, evidence, buildRecord(context, taskId, evidence, failure));
    return failure;
  }

  var pass = {
    success: true,
    actual: (context.task && context.task.expectedResult) || 'security checks pass',
    result: RESULT_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
  evidence.result = RESULT_PASS;
  writeExecutorEvidence(context, taskId, evidence, buildRecord(context, taskId, evidence, pass));
  return pass;
}

// ---------------------------------------------------------------------------
// Registration (wired by Window 1 later)
// ---------------------------------------------------------------------------

function register(executorModule) {
  var reg = executorModule && executorModule.registerTaskExecutor;
  if (typeof reg !== 'function') {
    return { success: false, error: 'missing registerTaskExecutor' };
  }
  reg(CHECK_ID, {
    description: 'Read-only security check suite against the staging host (unauthenticated Admin rejection, no admin-only data in Shop API, HTTPS redirect, security header report, secret scan)',
    builtIn: true,
    coverage: 'readiness-subset',
    verifiedAssertionIds: [],
    handler: handlerSecurityChecks,
    check: true
  });
  return { success: true, registered: [CHECK_ID] };
}

module.exports = {
  CHECK_ID: CHECK_ID,
  DEFAULT_SHOP_API_BASE: DEFAULT_SHOP_API_BASE,
  ALLOWLIST: ALLOWLIST.slice(),
  STANDARD_SECURITY_HEADERS: STANDARD_SECURITY_HEADERS.slice(),
  SECRET_PATTERNS: SECRET_PATTERNS.map(function(p) { return { pattern: p.pattern, name: p.name }; }),
  isAllowlistedHost: isAllowlistedHost,
  resolveBaseUrl: resolveBaseUrl,
  hostnameOf: hostnameOf,
  hostAllowed: hostAllowed,
  refuseProhibited: refuseProhibited,
  adminUnauthenticatedProbe: adminUnauthenticatedProbe,
  shopApiProbe: shopApiProbe,
  httpRedirectProbe: httpRedirectProbe,
  isUnauthenticatedAdminRejected: isUnauthenticatedAdminRejected,
  hasAdminOnlyData: hasAdminOnlyData,
  isHttpsRedirect: isHttpsRedirect,
  reportSecurityHeaders: reportSecurityHeaders,
  scanForSecrets: scanForSecrets,
  redactDeep: redactDeep,
  handlerSecurityChecks: handlerSecurityChecks,
  register: register
};
