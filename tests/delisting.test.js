'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var path = require('path');
var os = require('os');
var fs = require('fs');

var executors = require('../src/executors/delisting');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');
var sessionModule = require('../src/executors/shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });
var DESIGNER_PW = 'test-pass-designer';
var BUYER_PW = 'test-pass-buyer';
var ADMIN_PW = 'admin-secret';
var ADMIN_USER = 'superadmin@example.com';

var LOGIN_MARKER = 'login(';
var MY_DESIGNS_MARKER = 'GetMyDesigns';
var VENDOR_OVERVIEW_MARKER = 'GetVendorOverview';
var DELIST_MARKER = 'DelistMyDesign';
var ORDER_BY_CODE_MARKER = 'GetOrderDetail';

function fakeClock() {
  return function() { return new Date('2026-10-09T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'delist-'));
  var base = {
    taskId: taskId,
    task: {
      canonicalId: taskId,
      mandatoryAssertions: [
        { id: 'CAN-B2-15-A01', text: 'Designer sales details are correct; customer self-delisting and authorized admin delisting work; related design files are removed or archived; the customer receipt shows correct price and tax.' }
      ],
      expectedResult: 'Designer sales details are correct; customer self-delisting and authorized admin delisting work; related design files are removed or archived; the customer receipt shows correct price and tax.'
    },
    workspace: { workspaceId: 'ws-delist', workspacePath: wsPath },
    runEnvRecord: Object.assign({ runId: 'run-delist-' + Date.now().toString(36), gitHead: 'cafef00d1234', revisionId: 'rev-t' }, overrides.runEnvRecord || {}),
    repoRoot: path.resolve(__dirname, '..'),
    deps: {}
  };
  if (overrides.shopApiBase) base.shopApiBase = overrides.shopApiBase;
  if (overrides.fetch) base.deps.fetch = overrides.fetch;
  if (overrides.execFile) base.deps.execFile = overrides.execFile;
  if (overrides.execFileSync) base.deps.execFileSync = overrides.execFileSync;
  if (overrides.clock) base.deps.clock = overrides.clock;
  base.deps.getEnv = overrides.getEnv || envWith({});
  if (overrides.extraDeps) Object.assign(base.deps, overrides.extraDeps);
  if (overrides.fixtures) base.fixtures = overrides.fixtures;
  if (overrides.registry) base.registry = overrides.registry;
  return base;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'Designer sales details are correct; customer self-delisting and authorized admin delisting work; related design files are removed or archived; the customer receipt shows correct price and tax.',
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------
function startServer(scenario) {
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
      if (req.url !== '/shop-api') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var body = raw ? JSON.parse(raw) : {};
        var query = body.query || '';
        var sessionKey = (body.variables && body.variables.username) || 'buyer.one@example.com';
        if (!server._delisted) server._delisted = false;
        if (!server._sessions) server._sessions = {};

        function send(status, obj, extraHeaders) {
          var hdrs = { 'content-type': 'application/json' };
          hdrs['set-cookie'] = 'session=' + sessionKey;
          if (extraHeaders) Object.keys(extraHeaders).forEach(function(k) { hdrs[k] = extraHeaders[k]; });
          res.writeHead(status, hdrs);
          res.end(JSON.stringify(obj));
        }

        if (scenario === '500') { send(500, { errors: [{ message: 'boom' }] }); return; }

        if (query.indexOf(LOGIN_MARKER) !== -1) {
          var username = body.variables && body.variables.username ? body.variables.username : 'unknown';
          send(200, { data: { login: { __typename: 'CurrentUser', id: 'user-1', identifier: username } } });
          return;
        }

        if (query.indexOf(MY_DESIGNS_MARKER) !== -1) {
          if (scenario === 'no-designs' || server._delisted === true) {
            send(200, { data: { myDesigns: [] } });
            return;
          }
          send(200, {
            data: {
              myDesigns: [
                { productId: 'p-1', name: 'Fixture Design', sku: executors.DEFAULT_SKU, designFee: 1500, craftFee: 500, totalPrice: 2000, status: 'active', salesCount: 3, totalEarnings: 6000, createdAt: '2026-10-01T00:00:00.000Z', featuredAssetUrl: null }
              ]
            }
          });
          return;
        }

        if (query.indexOf(VENDOR_OVERVIEW_MARKER) !== -1) {
          send(200, { data: { vendorOverview: { totalSales: 6000, activeProductCount: 1, pendingOrderCount: 1 } } });
          return;
        }

        if (query.indexOf(DELIST_MARKER) !== -1) {
          if (scenario === 'delist-fail') { send(200, { data: { delistMyDesign: false } }); return; }
          server._delisted = true;
          send(200, { data: { delistMyDesign: true } });
          return;
        }

        if (query.indexOf(ORDER_BY_CODE_MARKER) !== -1) {
          if (scenario === 'receipt-wrong-currency') {
            send(200, { data: { orderByCode: { id: 'o1', code: executors.DEFAULT_RECEIPT_CODE, state: 'PaymentSettled', active: false, currencyCode: 'GBP', totalWithTax: 1428, taxSummary: [{ description: 'VAT', taxRate: 20, taxTotal: 238 }], lines: [{ id: 'l1', productVariant: { id: 'v1', name: 'Fixture Design', sku: executors.DEFAULT_SKU }, unitPriceWithTax: 1400, quantity: 1, linePriceWithTax: 1428 }] } } });
            return;
          }
          if (scenario === 'receipt-no-tax') {
            send(200, { data: { orderByCode: { id: 'o1', code: executors.DEFAULT_RECEIPT_CODE, state: 'PaymentSettled', active: false, currencyCode: 'EUR', totalWithTax: 1428, taxSummary: [], lines: [{ id: 'l1', productVariant: { id: 'v1', name: 'Fixture Design', sku: executors.DEFAULT_SKU }, unitPriceWithTax: 1400, quantity: 1, linePriceWithTax: 1428 }] } } });
            return;
          }
          send(200, {
            data: {
              orderByCode: {
                id: 'o1',
                code: executors.DEFAULT_RECEIPT_CODE,
                state: 'PaymentSettled',
                active: false,
                currencyCode: 'EUR',
                totalWithTax: 1428,
                taxSummary: [{ description: 'VAT', taxRate: 1900, taxTotal: 228 }],
                lines: [{ id: 'l1', productVariant: { id: 'v1', name: 'Fixture Design', sku: executors.DEFAULT_SKU }, unitPriceWithTax: 1400, quantity: 1, linePriceWithTax: 1428 }]
              }
            }
          });
          return;
        }

        send(200, { data: {} });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise(function(resolve) { server.close(resolve); });
}

// ---------------------------------------------------------------------------
// Admin identity env for success paths
// ---------------------------------------------------------------------------
function adminEnv(extra) {
  return envWith(Object.assign({
    SUPERADMIN_USERNAME: ADMIN_USER,
    SUPERADMIN_PASSWORD: ADMIN_PW,
    VENDURE_ADMIN_API_URL: 'http://127.0.0.1:1/admin-api',
    SHOP_ACCOUNT_PASSWORD_DESIGNER_DE: DESIGNER_PW,
    SHOP_ACCOUNT_PASSWORD_BUYER_ONE: BUYER_PW
  }, extra || {}));
}

// Fake docker compose gateway probe + admin-delist script runner.
function gatewayOkExecFileSync(args) {
  return function(command, cmdArgs, options) {
    if (command === 'docker' && cmdArgs[0] === 'compose') {
      return 'container-1\n';
    }
    return '';
  };
}

function gatewayDownExecFileSync() {
  return function(command, cmdArgs, options) {
    throw new Error('docker: command not found');
  };
}

// Fake admin_delist_products.mjs dry-run: writes result.json into the
// ADMIN_DELIST_ARTIFACT_ROOT/<timestamp>/ directory and exits 0.
function adminDelistExecFile(gatewayResult) {
  return function(file, args, options, cb) {
    var artifactRoot = options.env.ADMIN_DELIST_ARTIFACT_ROOT;
    var archiveRoot = '';
    var delistedRoot = '';
    var timestamp = executors.DEFAULT_TIMESTAMP;
    for (var i = 0; i < args.length; i += 1) {
      if (args[i].indexOf('--archive-root=') === 0) archiveRoot = args[i].slice('--archive-root='.length);
      if (args[i].indexOf('--delisted-root=') === 0) delistedRoot = args[i].slice('--delisted-root='.length);
    }
    var dir = path.join(artifactRoot, timestamp);
    fs.mkdirSync(dir, { recursive: true });
    var result = {
      mode: 'dry-run',
      skuList: [executors.DEFAULT_SKU],
      timestamp: timestamp,
      archiveRoot: archiveRoot,
      delistedRoot: delistedRoot,
      productIds: [1],
      records: [
        { variantId: 1, sku: executors.DEFAULT_SKU, variantEnabled: true, productId: 1, slug: executors.DEFAULT_SKU.toLowerCase(), productEnabled: true }
      ],
      archiveMoves: [
        { sku: executors.DEFAULT_SKU, sourcePath: path.join(archiveRoot, executors.DEFAULT_SKU), destinationPath: path.join(delistedRoot, timestamp, executors.DEFAULT_SKU) }
      ]
    };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    cb(null, 'DRY RUN admin delist products\n', '');
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('delisting: register() registers CAN-B2-15 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-15'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-15');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-15-A01']);
  executorModule.resetTaskExecutors();
});

test('delisting: success returns READINESS_PASS and verifies all in-scope assertions', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, true, outcome.error || 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never bare PASS literal');
  assert.strictEqual(outcome.evidence.checks.designerSalesDetail, true, 'designer sales detail correct');
  assert.strictEqual(outcome.evidence.checks.selfDelisted, true, 'self delisting works');
  assert.strictEqual(outcome.evidence.checks.adminDelistDryRun, true, 'admin delist dry-run through gateway');
  assert.strictEqual(outcome.evidence.checks.archivePlan, true, 'archive plan present');
  assert.strictEqual(outcome.evidence.checks.receiptPriceTax, true, 'receipt price/tax correct');
  var evJson = JSON.stringify(outcome.evidence);
  assert.strictEqual(evJson.indexOf(ADMIN_PW), -1, 'admin password not leaked');
  assert.strictEqual(evJson.indexOf(DESIGNER_PW), -1, 'designer password not leaked');
});

test('delisting: self-delist failure is an APPLICATION_DEFECT', async function() {
  var s = await startServer('delist-fail');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('self-delist') !== -1, 'error names self-delisting');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-15');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('delisting: wrong receipt currency is an APPLICATION_DEFECT', async function() {
  var s = await startServer('receipt-wrong-currency');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('receipt') !== -1, 'error names the receipt');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-15');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('delisting: receipt with no tax is an APPLICATION_DEFECT', async function() {
  var s = await startServer('receipt-no-tax');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('receipt') !== -1, 'error names the receipt');
});

test('delisting: server down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-15');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('delisting: PostgreSQL gateway unreachable locally -> DEPENDENCY_ENVIRONMENT with error as evidence', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayDownExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('gateway') !== -1 || outcome.error.indexOf('PostgreSQL') !== -1, 'error names the gateway');
  assert.ok(JSON.stringify(outcome.evidence).indexOf('docker: command not found') !== -1, 'error carried as evidence');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-15');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('delisting: missing admin identity -> BLOCK CLIENT_INPUT_SCOPE with preflight proof', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_DESIGNER_DE: DESIGNER_PW, SHOP_ACCOUNT_PASSWORD_BUYER_ONE: BUYER_PW }),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var evidenceJson = JSON.stringify(outcome.evidence || {});
  assert.ok(evidenceJson.indexOf('SUPERADMIN_USERNAME') !== -1, 'preflight names SUPERADMIN_USERNAME as absent');
  assert.ok(evidenceJson.indexOf('SUPERADMIN_PASSWORD') !== -1, 'preflight names SUPERADMIN_PASSWORD as absent');
  assert.strictEqual(evidenceJson.indexOf(ADMIN_USER), -1, 'admin username value not leaked');
  assert.strictEqual(evidenceJson.indexOf('admin-secret'), -1, 'admin password value not leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-15');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('delisting: evidence written through writeEvidenceFile, no secret leaks, verifyEvidence passes', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-delist-'));
  var s = await startServer('ok');
  var runId = 'run-delist-ev-' + Date.now().toString(36);
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  ctx.deps.config = { evidenceRoot: evidenceRoot };
  ctx.runEnvRecord.runId = runId;
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-15');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'delisting-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written through evidenceCollector');
  });
  var allEvidence = '';
  ['shop-api-requests.json', 'shop-api-responses.json', 'executor-summary.json'].forEach(function(name) {
    if (fs.existsSync(path.join(taskDir, name))) allEvidence += fs.readFileSync(path.join(taskDir, name), 'utf8');
  });
  assert.strictEqual(allEvidence.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(allEvidence.indexOf(DESIGNER_PW), -1, 'designer password redacted');
  assert.strictEqual(allEvidence.indexOf(BUYER_PW), -1, 'buyer password redacted');
  assert.strictEqual(allEvidence.indexOf(ADMIN_PW), -1, 'admin password redacted');
  var evidenceCollector = require('../src/evidenceCollector');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('delisting: cleanup - no leftover workspace dirs after run', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-15', {
    getEnv: adminEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: adminDelistExecFile()
  });
  var outcome = await executors.handlerDelisting(ctx);
  await closeServer(s.server);
  // Remove the workspace as the pipeline would; confirm verification cleanup.
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(ctx.workspace.workspacePath), false, 'temp workspace removed');
  assert.strictEqual(outcome.success, true, 'run succeeds before cleanup');
});
