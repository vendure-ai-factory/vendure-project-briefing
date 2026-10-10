'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var security = require('../src/securityChecks');
var executorModule = require('../src/executor');
var terminalState = require('../src/terminalState');
var RESULT_PASS = terminalState.RESULT_PASS;

var CHECK_ID = security.CHECK_ID;

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

function secureHandler(req, res) {
  res.setHeader('strict-transport-security', 'max-age=31536000');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  if (req.url === '/admin-api') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'forbidden' }] }));
    return;
  }
  if (req.url === '/shop-api') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { __typename: 'Query' } }));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(301, { location: 'https://' + req.headers.host + req.url });
  res.end('');
}

function buildContext(port, overrides) {
  var ctx = {
    task: {
      canonicalId: CHECK_ID,
      summaryIds: [],
      expectedResult: 'security checks pass'
    },
    runId: 'run-sec-test',
    runEnvRecord: { runId: 'run-sec-test', gitHead: 'abcdef1234567890', revisionId: 'rev-sec' },
    shopApiBase: 'http://127.0.0.1:' + port,
    deps: {
      fetch: function (url, init) {
        return fetch(url, init);
      },
      clock: function () { return new Date('2026-10-07T09:00:00.000Z'); },
      getEnv: function () { return {}; },
      allowedHosts: ['127.0.0.1'],
      writeEvidenceFile: function () {},
      writeTaskRecord: function () {}
    }
  };
  if (overrides) {
    if (overrides.deps) {
      Object.assign(ctx.deps, overrides.deps);
    }
    Object.keys(overrides).forEach(function (k) {
      if (k !== 'deps') ctx[k] = overrides[k];
    });
  }
  return ctx;
}

function secureServer() {
  return startServer(secureHandler);
}

function adminOkServer() {
  return startServer(function (req, res) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.url === '/admin-api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { __typename: 'Query' } }));
      return;
    }
    if (req.url === '/shop-api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { __typename: 'Query' } }));
      return;
    }
    res.writeHead(301, { location: 'https://' + req.headers.host + req.url });
    res.end('');
  });
}

function adminDataServer() {
  return startServer(function (req, res) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.url === '/admin-api') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'forbidden' }] }));
      return;
    }
    if (req.url === '/shop-api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { orders: [{ id: 1 }] } }));
      return;
    }
    res.writeHead(301, { location: 'https://' + req.headers.host + req.url });
    res.end('');
  });
}

function noRedirectServer() {
  return startServer(function (req, res) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.url === '/admin-api') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'forbidden' }] }));
      return;
    }
    if (req.url === '/shop-api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { __typename: 'Query' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('no redirect');
  });
}

function secretServer() {
  return startServer(function (req, res) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.url === '/admin-api') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'forbidden' }] }));
      return;
    }
    if (req.url === '/shop-api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH' } }));
      return;
    }
    res.writeHead(301, { location: 'https://' + req.headers.host + req.url });
    res.end('');
  });
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

test('securityChecks: register() registers a non-CAN check id', function (t) {
  executorModule.resetTaskExecutors();
  var reg = security.register(executorModule);
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

test('securityChecks: standalone handler rejects non-allowlisted host before any request', async function (t) {
  var ctx = buildContext(0);
  ctx.shopApiBase = 'https://evil.example.com';
  var outcome = await security.handlerSecurityChecks(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'OTHER_HOST');
});

// ---------------------------------------------------------------------------
// Core read-only checks
// ---------------------------------------------------------------------------

test('securityChecks: passing server yields RESULT_PASS and all core checks true', async function (t) {
  var s = await secureServer();
  var ctx = buildContext(s.port);
  var outcome = await security.handlerSecurityChecks(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, true, JSON.stringify(outcome && outcome.error));
  assert.strictEqual(outcome.result, RESULT_PASS);
  assert.strictEqual(outcome.evidence.checks.unauthenticatedAdminRejected, true);
  assert.strictEqual(outcome.evidence.checks.shopApiNoAdminData, true);
  assert.strictEqual(outcome.evidence.checks.httpsRedirect, true);
  assert.strictEqual(outcome.evidence.secretsScan.clean, true);
  assert.ok(Array.isArray(outcome.evidence.headersReport.present), 'header report present list');
  assert.ok(Array.isArray(outcome.evidence.headersReport.missing), 'header report missing list');
  assert.ok(outcome.evidence.headersReport.present.indexOf('strict-transport-security') !== -1, 'HSTS reported');
});

test('securityChecks: allowing an unauthenticated Admin API request fails the check', async function (t) {
  var s = await adminOkServer();
  var ctx = buildContext(s.port);
  var outcome = await security.handlerSecurityChecks(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.evidence.checks.unauthenticatedAdminRejected, false);
});

test('securityChecks: Shop API returning admin-only data fails the check', async function (t) {
  var s = await adminDataServer();
  var ctx = buildContext(s.port);
  var outcome = await security.handlerSecurityChecks(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.evidence.checks.shopApiNoAdminData, false);
});

test('securityChecks: missing HTTPS redirect fails the check', async function (t) {
  var s = await noRedirectServer();
  var ctx = buildContext(s.port);
  var outcome = await security.handlerSecurityChecks(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.evidence.checks.httpsRedirect, false);
});

test('securityChecks: a secret in a response fails the secret scan', async function (t) {
  var s = await secretServer();
  var ctx = buildContext(s.port);
  var outcome = await security.handlerSecurityChecks(ctx);
  await closeServer(s.server);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.evidence.secretsScan.clean, false);
  assert.ok(outcome.evidence.secretsScan.findings.length > 0);
});

// ---------------------------------------------------------------------------
// Prohibited-action refusal (each is refused with a test)
// ---------------------------------------------------------------------------

test('securityChecks: fuzzing is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.options = { probe: 'fuzz' };
  var outcome = await security.handlerSecurityChecks(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'FUZZING');
});

test('securityChecks: brute force is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.options = { probe: 'brute-force' };
  var outcome = await security.handlerSecurityChecks(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'BRUTE_FORCE');
});

test('securityChecks: credential guessing is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.options = { probe: 'credential-guessing' };
  var outcome = await security.handlerSecurityChecks(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'BRUTE_FORCE');
});

test('securityChecks: any write request is refused', async function (t) {
  var ctx = buildContext(0);
  ctx.method = 'POST';
  ctx.graphqlBody = 'mutation { createProduct }';
  var outcome = await security.handlerSecurityChecks(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.refused, true);
  assert.strictEqual(outcome.cause, 'WRITE_REQUEST');
});

test('securityChecks: register() never creates a CAN-ID task', function (t) {
  executorModule.resetTaskExecutors();
  var reg = security.register(executorModule);
  var ids = executorModule.listTaskExecutors();
  ids.forEach(function (id) {
    assert.ok(String(id).indexOf('CAN-') !== 0, 'unexpected CAN-ID registration: ' + id);
  });
  executorModule.resetTaskExecutors();
  assert.ok(reg.success);
});
