'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var path = require('path');
var os = require('os');
var fs = require('fs');

var loadCheck = require('../src/loadCheck');
var executorModule = require('../src/executor');
var terminalState = require('../src/terminalState');
var RESULT_PASS = terminalState.RESULT_PASS;

var CHECK_ID = loadCheck.CHECK_ID;

function startServer(handler) {
  return new Promise(function (resolve, reject) {
    var server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise(function (resolve) {
    server.close(resolve);
  });
}

function okHandler(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/shop-api') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { __typename: 'Query' } }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
}

function slowHandler(latencyMs) {
  return function (req, res) {
    setTimeout(function () {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/shop-api') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { __typename: 'Query' } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }, latencyMs);
  };
}

function errorHandler(req, res) {
  if (req.url === '/health') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
    return;
  }
  if (req.url === '/shop-api') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"errors":[{"message":"boom"}]}');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
}

function buildContext(port, overrides) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-check-'));
  var ctx = {
    task: {
      canonicalId: CHECK_ID,
      summaryIds: [],
      expectedResult: 'load check passes'
    },
    runId: 'run-load-test',
    runEnvRecord: { runId: 'run-load-test', gitHead: 'abcdef1234567890', revisionId: 'rev-load' },
    shopApiBase: 'http://127.0.0.1:' + port,
    loadConfig: {
      phases: [
        { users: 2, durationMs: 120 },
        { users: 2, durationMs: 120 }
      ],
      intervalMs: 20,
      mode: 'baseline',
      baselinePath: path.join(tmpDir, 'load-baseline.json')
    },
    deps: {
      fetch: function (url, init) {
        return fetch(url, init);
      },
      clock: function () { return new Date('2026-10-07T09:00:00.000Z'); },
      getEnv: function () { return {}; },
      allowedHosts: ['127.0.0.1'],
      writeEvidenceFile: function () {},
      writeTaskRecord: function () {},
      fs: fs
    }
  };
  if (overrides) {
    if (overrides.loadConfig) {
      Object.keys(overrides.loadConfig).forEach(function (k) {
        ctx.loadConfig[k] = overrides.loadConfig[k];
      });
    }
    if (overrides.deps) {
      Object.assign(ctx.deps, overrides.deps);
    }
    Object.keys(overrides).forEach(function (k) {
      if (k !== 'loadConfig' && k !== 'deps') ctx[k] = overrides[k];
    });
  }
  return ctx;
}

function cleanContext(ctx) {
  try {
    fs.rmSync(path.dirname(ctx.loadConfig.baselinePath), { recursive: true, force: true });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

test('loadCheck: register() registers a non-CAN check id', function (t) {
  executorModule.resetTaskExecutors();
  var reg = loadCheck.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.ok(Array.isArray(reg.registered));
  assert.strictEqual(reg.registered[0], CHECK_ID);
  assert.ok(String(CHECK_ID).indexOf('CAN-') !== 0, 'must NOT be registered under a CAN-ID');
  assert.strictEqual(executorModule.hasTaskExecutor(CHECK_ID), true);
  var exec = executorModule.getTaskExecutor(CHECK_ID);
  assert.strictEqual(typeof exec.handler, 'function');
  assert.strictEqual(exec.coverage, 'readiness-subset');
  executorModule.resetTaskExecutors();
});

test('loadCheck: standalone handler rejects non-allowlisted host before any request', async function (t) {
  var s = await startServer(errorHandler);
  var ctx = buildContext(s.port, { shopApiBase: 'https://evil.example.com' });
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  cleanContext(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'OTHER_HOST');
});

// ---------------------------------------------------------------------------
// Metrics + default profile
// ---------------------------------------------------------------------------

test('loadCheck: the default profile is 5 users / 60s then 10 users / 60s', function (t) {
  assert.strictEqual(loadCheck.DEFAULT_PHASES.length, 2);
  assert.strictEqual(loadCheck.DEFAULT_PHASES[0].users, 5);
  assert.strictEqual(loadCheck.DEFAULT_PHASES[1].users, 10);
  assert.strictEqual(loadCheck.DEFAULT_PHASES[0].durationMs, 60000);
  assert.strictEqual(loadCheck.DEFAULT_PHASES[1].durationMs, 60000);
});

test('loadCheck: percentile helper returns p50/p95/p99', function (t) {
  var latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  var metrics = loadCheck.computeMetrics(latencies, 0);
  assert.strictEqual(metrics.requestCount, 10);
  assert.strictEqual(metrics.errorRate, 0);
  assert.ok(metrics.p50 > 0);
  assert.ok(metrics.p95 >= metrics.p50);
  assert.ok(metrics.p99 >= metrics.p95);
});

// ---------------------------------------------------------------------------
// Baseline mode
// ---------------------------------------------------------------------------

test('loadCheck: baseline mode writes a frozen baseline file and passes', async function (t) {
  var s = await startServer(okHandler);
  var ctx = buildContext(s.port, {
    loadConfig: { mode: 'baseline' }
  });
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, true, JSON.stringify(outcome && outcome.error));
  assert.strictEqual(outcome.result, RESULT_PASS);
  assert.strictEqual(outcome.evidence.mode, 'baseline');
  assert.ok(outcome.evidence.metrics.requestCount > 0);
  assert.ok(fs.existsSync(ctx.loadConfig.baselinePath), 'baseline file written');
  var baseline = JSON.parse(fs.readFileSync(ctx.loadConfig.baselinePath, 'utf8'));
  assert.strictEqual(baseline.frozen, true);
  assert.ok(typeof baseline.p95 === 'number');
  cleanContext(ctx);
});

test('loadCheck: formal mode reuses baseline and passes when within thresholds', async function (t) {
  var s = await startServer(okHandler);
  var ctx = buildContext(s.port, {
    loadConfig: { mode: 'baseline' }
  });
  await loadCheck.handlerLoadCheck(ctx); // write baseline
  ctx.loadConfig.mode = 'formal';
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  assert.ok(fs.existsSync(ctx.loadConfig.baselinePath), 'baseline reused');
  assert.strictEqual(outcome.success, true, JSON.stringify(outcome && outcome.error));
  assert.strictEqual(outcome.result, RESULT_PASS);
  assert.strictEqual(outcome.evidence.mode, 'formal');
  assert.ok(outcome.evidence.thresholds.allowedP95 !== null);
  assert.strictEqual(outcome.evidence.summary.breach, null);
  cleanContext(ctx);
});

test('loadCheck: formal mode refuses to start without a frozen baseline file', async function (t) {
  var s = await startServer(okHandler);
  var ctx = buildContext(s.port, {
    loadConfig: { mode: 'formal', baselinePath: path.join(os.tmpdir(), 'no-such-baseline-' + Date.now() + '.json') }
  });
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  cleanContext(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.errorCode, 'MISSING_BASELINE');
});

// ---------------------------------------------------------------------------
// Breach / safe stop
// ---------------------------------------------------------------------------

test('loadCheck: error rate breach stops the run and records a safe stop', async function (t) {
  var s = await startServer(errorHandler);
  var ctx = buildContext(s.port, {
    loadConfig: { mode: 'baseline' }
  });
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  cleanContext(ctx);
  assert.strictEqual(outcome.success, false);
  assert.ok(outcome.evidence.metrics.errorRate >= loadCheck.MAX_ERROR_RATE, 'error rate at/above threshold');
  assert.ok(outcome.evidence.safeStop || outcome.evidence.summary.safeStopped, 'safe stop recorded');
});

test('loadCheck: p95 breach in formal mode records a safe stop', async function (t) {
  // Write a baseline with a tiny p95 so the permitted p95 (2x) is very small.
  var s = await startServer(slowHandler(60));
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-check-p95-'));
  var baselinePath = path.join(tmpDir, 'load-baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify({ schemaVersion: '1.0', p95: 1, p50: 1, p99: 1, frozen: true, profile: [] }), 'utf8');
  var ctx = buildContext(s.port, {
    loadConfig: { mode: 'formal', baselinePath: baselinePath, intervalMs: 30 }
  });
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(outcome.success, false);
  assert.ok(outcome.evidence.summary.breach !== null, 'p95 breach reported');
  assert.ok(outcome.evidence.summary.safeStopped, 'safe stop recorded');
});

// ---------------------------------------------------------------------------
// Evidence via deps
// ---------------------------------------------------------------------------

test('loadCheck: writes evidence + task record via deps', async function (t) {
  var evidenceFiles = [];
  var records = [];
  var s = await startServer(okHandler);
  var ctx = buildContext(s.port, {
    deps: {
      writeEvidenceFile: function (runId, taskId, filename, content, opts) {
        evidenceFiles.push({ runId: runId, taskId: taskId, filename: filename, content: content, opts: opts });
      },
      writeTaskRecord: function (runId, taskId, record, opts) {
        records.push({ runId: runId, taskId: taskId, record: record, opts: opts });
      }
    }
  });
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  await closeServer(s.server);
  cleanContext(ctx);
  assert.strictEqual(outcome.success, true);
  assert.strictEqual(evidenceFiles.length, 1);
  assert.strictEqual(evidenceFiles[0].taskId, CHECK_ID);
  assert.strictEqual(evidenceFiles[0].filename, 'load-check.json');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].record.canonicalId, CHECK_ID);
  assert.strictEqual(records[0].record.coverage, 'readiness-subset');
});

// ---------------------------------------------------------------------------
// Prohibited-action refusal
// ---------------------------------------------------------------------------

test('loadCheck: fuzzing is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.options = { probe: 'fuzz' };
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'FUZZING');
});

test('loadCheck: brute force is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.options = { probe: 'brute-force' };
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'BRUTE_FORCE');
});

test('loadCheck: any write request is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.method = 'POST';
  ctx.graphqlBody = 'mutation { updateOrder }';
  var outcome = await loadCheck.handlerLoadCheck(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'WRITE_REQUEST');
});

test('loadCheck: register() never creates a CAN-ID task', function (t) {
  executorModule.resetTaskExecutors();
  var reg = loadCheck.register(executorModule);
  var ids = executorModule.listTaskExecutors();
  ids.forEach(function (id) {
    assert.ok(String(id).indexOf('CAN-') !== 0, 'unexpected CAN-ID registration: ' + id);
  });
  executorModule.resetTaskExecutors();
  assert.ok(reg.success);
});
