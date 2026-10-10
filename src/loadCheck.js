'use strict';

/**
 * Read-only load module (chunk 10b). New file only: does not modify
 * src/cli.js, the manifest, or existing tests. Exports a register() function
 * that Window 1 wires into the executor registry later.
 *
 * Scope (read-only, host-allowlisted):
 *  - GET /health
 *  - POST /shop-api with "{ __typename }"
 *  - 5 virtual users for 60 s, then 10 virtual users for 60 s
 *  - metrics: request count, error rate, p50/p95/p99, health status after
 *  - thresholds: error rate below 1%, p95 at most 2x the baseline, health HTTP
 *    200 afterwards; a breach stops the run and records a safe stop
 *  - the baseline is written by the first run; a formal run refuses to start
 *    without a frozen baseline file
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
var path = require('path');
var RESULT_PASS = terminalState.RESULT_PASS;

var CHECK_ID = 'CHECK-LOAD-SUITE';
var DEFAULT_SHOP_API_BASE = 'https://staging.tibella.eu';
var SHOP_API_PATH = '/shop-api';
var HEALTH_PATH = '/health';
var REDACTED_MARKER = '[REDACTED]';

var DEFAULT_PHASES = [
  { users: 5, durationMs: 60000 },
  { users: 10, durationMs: 60000 }
];
var DEFAULT_INTERVAL_MS = 500;
var MAX_ERROR_RATE = 0.01; // below 1%
var P95_MULTIPLIER = 2; // p95 at most 2x the baseline
var DEFAULT_BASELINE_FILE = 'workspace/load-baseline.json';

var SECRET_PATTERNS = [
  { pattern: /sk-or-v1-[a-zA-Z0-9_-]{20,}/, name: 'OpenRouter key' },
  { pattern: /OPENROUTER_API_KEY=(?!your_|sk-test-|test|_|placeholder|empty)[^\s&]{8,}/, name: 'OPENROUTER_API_KEY with real value' },
  { pattern: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, name: 'inline credential assignment' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, name: 'bearer token' }
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

function getNow(context) {
  var now = context && context.deps && context.deps.now;
  if (typeof now === 'function') return now;
  return function() { return Date.now(); };
}

function getSleep(context) {
  var sleep = context && context.deps && context.deps.sleep;
  if (typeof sleep === 'function') return sleep;
  return function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
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

function getFs(context) {
  var deps = context && context.deps ? context.deps : {};
  var fs = deps.fs || require('fs');
  return {
    readFileSync: function(p, enc) { return fs.readFileSync(p, enc || 'utf8'); },
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    existsSync: function(p) { return fs.existsSync(p); }
  };
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function isAllowlistedHost(host) {
  if (!host) return false;
  var normalized = String(host).toLowerCase().replace(/\.$/, '');
  return normalized === 'staging.tibella.eu';
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
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

function hostAllowed(context, host) {
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
// Refusals
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
  if (typeof method === 'string' && /^(POST|PUT|PATCH|DELETE)$/i.test(method) && context && context.graphqlBody && /mutation/i.test(String(context.graphqlBody))) {
    return 'WRITE_REQUEST';
  }
  return null;
}

function refuseProhibited(context) {
  var category = prohibitedCategory(context);
  if (!category) return null;
  if (category === 'FUZZING') {
    return refusal('fuzzing is prohibited (read-only load module)', 'PROHIBITED_FUZZ', 'FUZZING');
  }
  if (category === 'BRUTE_FORCE') {
    return refusal('brute force or credential guessing is prohibited', 'PROHIBITED_BRUTE_FORCE', 'BRUTE_FORCE');
  }
  return refusal('write requests are prohibited (read-only load module)', 'PROHIBITED_WRITE', 'WRITE_REQUEST');
}

// ---------------------------------------------------------------------------
// Read-only requests (only GET /health and POST /shop-api {__typename})
// ---------------------------------------------------------------------------

function loadRequest(fetchFn, baseUrl, kind, now) {
  var method = kind === 'health' ? 'GET' : 'POST';
  var url = baseUrl + (kind === 'health' ? HEALTH_PATH : SHOP_API_PATH);
  var headers = { 'content-type': 'application/json' };
  var init = { method: method, headers: headers };
  if (kind === 'shopApi') {
    init.body = JSON.stringify({ operationName: null, variables: {}, query: '{ __typename }' });
  }
  var startedAt = now();
  return fetchFn(url, init)
    .then(function(response) {
      return response.text().then(
        function(text) {
          var latencyMs = now() - startedAt;
          return {
            ok: response.status >= 200 && response.status < 300,
            httpStatus: response.status,
            latencyMs: latencyMs,
            body: text,
            kind: kind,
            request: { method: method, url: url, kind: kind }
          };
        },
        function() {
          return {
            ok: false,
            httpStatus: response.status,
            latencyMs: now() - startedAt,
            body: null,
            kind: kind,
            networkError: 'response body read failed',
            request: { method: method, url: url, kind: kind }
          };
        }
      );
    })
    .catch(function(err) {
      return {
        ok: false,
        httpStatus: null,
        latencyMs: now() - startedAt,
        body: null,
        kind: kind,
        networkError: err && err.message ? err.message : String(err),
        request: { method: method, url: url, kind: kind }
      };
    });
}

function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  var idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function computeMetrics(latencies, errorCount) {
  var requestCount = latencies.length;
  var errorRate = requestCount > 0 ? errorCount / requestCount : 0;
  var sorted = latencies.slice().sort(function(a, b) { return a - b; });
  return {
    requestCount: requestCount,
    errorCount: errorCount,
    errorRate: errorRate,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99)
  };
}

// ---------------------------------------------------------------------------
// Load runner
// ---------------------------------------------------------------------------

/**
 * Run the configured phases with virtual users. Each virtual user issues one
 * request (GET /health or POST /shop-api) per intervalMs for the phase
 * duration, paced by the injectable sleep so tests can run instantly. A
 * shared stopped flag lets a breach halt remaining users.
 */
async function runLoad(fetchFn, baseUrl, phases, intervalMs, now, sleep, state) {
  var results = [];
  for (var ph = 0; ph < phases.length; ph++) {
    var phase = phases[ph];
    var users = phase.users || 1;
    var durationMs = phase.durationMs || 60000;
    var iterations = Math.max(1, Math.round(durationMs / intervalMs));
    var workers = [];
    for (var u = 0; u < users; u++) {
      workers.push(runVirtualUser(fetchFn, baseUrl, iterations, intervalMs, now, sleep, state, results));
    }
    await Promise.all(workers);
    if (state.stopped) break;
  }
  return results;
}

async function runVirtualUser(fetchFn, baseUrl, iterations, intervalMs, now, sleep, state, results) {
  for (var i = 0; i < iterations; i++) {
    if (state.stopped) break;
    var kind = i % 2 === 0 ? 'health' : 'shopApi';
    var result = await loadRequest(fetchFn, baseUrl, kind, now);
    results.push(result);
    // Mid-run error-rate and health breach check so the run can stop early.
    if (state.errorProbe && state.errorProbe(results)) {
      state.stopped = true;
      state.breach = 'error rate exceeded threshold';
      break;
    }
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Baseline file
// ---------------------------------------------------------------------------

function baselinePathOf(context) {
  var configured = context && context.loadConfig && context.loadConfig.baselinePath;
  if (configured) return configured;
  var envPath = envValue(context, 'LOAD_BASELINE_PATH');
  if (envPath) return envPath;
  return path.join(process.cwd(), DEFAULT_BASELINE_FILE);
}

function readBaseline(context, fsImpl, baselinePath) {
  try {
    if (!fsImpl.existsSync(baselinePath)) return null;
    var raw = fsImpl.readFileSync(baselinePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeBaseline(context, fsImpl, baselinePath, baseline) {
  fsImpl.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  return baselinePath;
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

function taskIdOf(context) {
  if (context.task && context.task.canonicalId) return context.task.canonicalId;
  if (context.taskId) return context.taskId;
  return CHECK_ID;
}

function execRevision(context) {
  var rec = context.runEnvRecord;
  return rec && (rec.gitHead || rec.revisionId) ? (rec.gitHead || rec.revisionId) : null;
}

function writeExecutorEvidence(context, taskId, evidence, record) {
  var deps = context && context.deps ? context.deps : {};
  var runId = runIdOf(context);
  if (!runId || !taskId) return { ok: false, reason: 'no runId/taskId' };
  var wroteAny = false;
  try {
    if (typeof deps.writeEvidenceFile === 'function') {
      deps.writeEvidenceFile(runId, taskId, 'load-check.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'load-check' });
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
    executionRevision: execRevision(context),
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
    generatedArtifacts: ['load-check.json'],
    stateChanges: {
      success: outcome.success === true,
      readOnly: true,
      breach: evidence && evidence.safeStop ? evidence.summary.breach : null
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

/**
 * Run the read-only load check. Mode 'baseline' writes a frozen baseline file;
 * mode 'formal' refuses to start without one and compares p95/error/health
 * against it. Returns { success, actual, result, errorCode, error, evidence }.
 */
async function handlerLoadCheck(context) {
  context = context || {};
  var taskId = taskIdOf(context);
  var baseUrl = resolveBaseUrl(context);
  var host = hostnameOf(baseUrl);
  var now = getNow(context);
  var sleep = getSleep(context);
  var fsImpl = getFs(context);
  var baseLinePath = baselinePathOf(context);

  // Host allowlist: refused before a request is made.
  if (!hostAllowed(context, host)) {
    var refusedHost = refusal('host not allowed: ' + host + ' (allowlist: staging.tibella.eu only)', 'HOST_NOT_ALLOWED', 'OTHER_HOST');
    refusedHost.taskId = taskId;
    var evHost = {
      taskId: taskId,
      coverage: 'readiness-subset',
      executionRevision: execRevision(context),
      scope: 'load',
      checks: { hostAllowed: false },
      reason: 'host not allowed',
      timestamp: new Date(now()).toISOString()
    };
    writeExecutorEvidence(context, taskId, evHost, buildRecord(context, taskId, evHost, refusedHost));
    return refusedHost;
  }

  // Prohibited actions refused before a request.
  var prohibited = refuseProhibited(context);
  if (prohibited) {
    prohibited.taskId = taskId;
    var evProhibited = {
      taskId: taskId,
      coverage: 'readiness-subset',
      executionRevision: execRevision(context),
      scope: 'load',
      checks: { prohibited: true, category: prohibited.cause },
      reason: prohibited.error,
      timestamp: new Date(now()).toISOString()
    };
    writeExecutorEvidence(context, taskId, evProhibited, buildRecord(context, taskId, evProhibited, prohibited));
    return prohibited;
  }

  var loadConfig = context.loadConfig || (context.deps && context.deps.config && context.deps.config.loadConfig) || {};
  var phases = Array.isArray(loadConfig.phases) && loadConfig.phases.length > 0 ? loadConfig.phases : DEFAULT_PHASES;
  var intervalMs = typeof loadConfig.intervalMs === 'number' ? loadConfig.intervalMs : DEFAULT_INTERVAL_MS;
  var mode = loadConfig.mode || envValue(context, 'LOAD_MODE') || 'baseline';

  var fetchFn = getFetch(context);

  // Formal run refuses to start without a frozen baseline file.
  var baseline = null;
  if (mode === 'formal') {
    baseline = readBaseline(context, fsImpl, baseLinePath);
    if (!baseline) {
      var noBaseline = refusal('formal load run requires a frozen baseline file (first run writes ' + baseLinePath + ')',
        'MISSING_BASELINE', 'MISSING_BASELINE');
      noBaseline.taskId = taskId;
      var evNoBaseline = {
        taskId: taskId,
        coverage: 'readiness-subset',
        executionRevision: execRevision(context),
        scope: 'load',
        checks: { baselinePresent: false },
        reason: noBaseline.error,
        timestamp: new Date(now()).toISOString()
      };
      writeExecutorEvidence(context, taskId, evNoBaseline, buildRecord(context, taskId, evNoBaseline, noBaseline));
      return noBaseline;
    }
  }

  var state = {
    stopped: false,
    breach: null,
    errorProbe: function(results) {
      // Stop the run when the error rate crosses the 1% threshold mid-run.
      var count = results.length;
      if (count === 0) return false;
      var errors = 0;
      for (var i = 0; i < results.length; i++) {
        if (results[i].ok !== true) errors++;
      }
      return (errors / count) >= MAX_ERROR_RATE;
    }
  };

  var startTime = now();
  var results = await runLoad(fetchFn, baseUrl, phases, intervalMs, now, sleep, state);
  var elapsedMs = now() - startTime;

  // Health status afterwards: one final GET /health.
  var healthAfter = await loadRequest(fetchFn, baseUrl, 'health', now);

  var errors = 0;
  var latencies = [];
  var requestLog = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    latencies.push(typeof r.latencyMs === 'number' ? r.latencyMs : 0);
    if (r.ok !== true) errors++;
    requestLog.push({ kind: r.kind, httpStatus: r.httpStatus, latencyMs: r.latencyMs, networkError: r.networkError || null, request: r.request });
  }

  var metrics = computeMetrics(latencies, errors);
  var healthOk = healthAfter.httpStatus === 200;

  var thresholds = {
    maxErrorRate: MAX_ERROR_RATE,
    p95Multiplier: P95_MULTIPLIER,
    healthHttpStatus: 200,
    nominalErrorRate: MAX_ERROR_RATE,
    baselineP95: baseline ? baseline.p95 : null,
    allowedP95: baseline && typeof baseline.p95 === 'number' ? P95_MULTIPLIER * baseline.p95 : null
  };

  // Breach evaluation: error-rate and health-after apply in every mode; p95 is
  // compared against the frozen baseline only in formal mode.
  var breach = null;
  if (metrics.errorRate >= MAX_ERROR_RATE) {
    breach = 'error rate ' + metrics.errorRate.toFixed(4) + ' >= ' + MAX_ERROR_RATE;
  } else if (!healthOk) {
    breach = 'health after run returned HTTP ' + healthAfter.httpStatus + ' (expected 200)';
  } else if (mode === 'formal') {
    if (thresholds.allowedP95 !== null && typeof metrics.p95 === 'number' && metrics.p95 > thresholds.allowedP95) {
      breach = 'p95 ' + metrics.p95.toFixed(2) + 'ms > ' + thresholds.allowedP95.toFixed(2) + 'ms baseline';
    }
  }

  var evidence = {
    taskId: taskId,
    title: 'Read-only load check against staging',
    shopApiBase: baseUrl,
    coverage: 'readiness-subset',
    executionRevision: execRevision(context),
    scope: 'load',
    mode: mode,
    profile: phases.map(function(p) { return { users: p.users, durationMs: p.durationMs }; }),
    metrics: metrics,
    healthAfter: healthAfter.httpStatus,
    thresholds: thresholds,
    timing: {
      elapsedMs: elapsedMs,
      intervalMs: intervalMs,
      requests: requestLog
    },
    safeStop: state.breach ? {
      safeStop: true,
      reason: state.breach
    } : null,
    baseline: baseline ? {
      path: baseLinePath,
      p95: baseline.p95,
      frozen: true
    } : null,
    summary: {
      result: null,
      breach: breach,
      safeStopped: !!(state.breach || breach)
    },
    timestamp: new Date(now()).toISOString()
  };

  if (mode === 'baseline') {
    // First run writes the frozen baseline file (thresholds for later runs).
    var frozenBaseline = {
      schemaVersion: '1.0',
      p95: metrics.p95,
      p50: metrics.p50,
      p99: metrics.p99,
      errorRate: metrics.errorRate,
      requestCount: metrics.requestCount,
      healthAfter: healthAfter.httpStatus,
      created: new Date(now()).toISOString(),
      frozen: true,
      profile: phases
    };
    try {
      writeBaseline(context, fsImpl, baseLinePath, frozenBaseline);
    } catch (e) {
      var writeFail = refusal('could not write baseline file: ' + (e && e.message ? e.message : String(e)), 'BASELINE_WRITE_FAILED', 'ENVIRONMENT');
      writeFail.taskId = taskId;
      writeExecutorEvidence(context, taskId, evidence, buildRecord(context, taskId, evidence, writeFail));
      return writeFail;
    }
    baseline = frozenBaseline;
    evidence.baseline = { path: baseLinePath, p95: baseline.p95, frozen: true };
  }

  var pass = breach === null;
  evidence.summary.result = pass ? RESULT_PASS : 'BLOCK';
  evidence.summary.breach = breach;
  evidence.summary.safeStopped = !!(state.breach || breach);

  var outcome;
  if (pass) {
    outcome = {
      success: true,
      actual: (context.task && context.task.expectedResult) || 'load check passes',
      result: RESULT_PASS,
      errorCode: null,
      error: null,
      evidence: evidence
    };
  } else {
    outcome = refusal('load check breach: ' + breach, 'LOAD_THRESHOLD_BREACH', 'LOAD_BREACH');
    outcome.taskId = taskId;
    outcome.checks = { breach: breach };
    outcome.evidence = evidence;
  }

  writeExecutorEvidence(context, taskId, evidence, buildRecord(context, taskId, evidence, outcome));
  return outcome;
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
    description: 'Read-only load check suite against the staging host (5 then 10 virtual users, error rate, p50/p95/p99, health after, baseline file)',
    builtIn: true,
    coverage: 'readiness-subset',
    verifiedAssertionIds: [],
    handler: handlerLoadCheck,
    check: true
  });
  return { success: true, registered: [CHECK_ID] };
}

module.exports = {
  CHECK_ID: CHECK_ID,
  DEFAULT_SHOP_API_BASE: DEFAULT_SHOP_API_BASE,
  DEFAULT_PHASES: DEFAULT_PHASES.map(function(p) { return { users: p.users, durationMs: p.durationMs }; }),
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  MAX_ERROR_RATE: MAX_ERROR_RATE,
  P95_MULTIPLIER: P95_MULTIPLIER,
  DEFAULT_BASELINE_FILE: DEFAULT_BASELINE_FILE,
  isAllowlistedHost: isAllowlistedHost,
  resolveBaseUrl: resolveBaseUrl,
  hostnameOf: hostnameOf,
  hostAllowed: hostAllowed,
  refuseProhibited: refuseProhibited,
  loadRequest: loadRequest,
  percentile: percentile,
  computeMetrics: computeMetrics,
  runLoad: runLoad,
  baselinePathOf: baselinePathOf,
  readBaseline: readBaseline,
  writeBaseline: writeBaseline,
  handlerLoadCheck: handlerLoadCheck,
  register: register
};
