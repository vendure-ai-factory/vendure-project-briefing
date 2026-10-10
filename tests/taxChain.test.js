'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var path = require('path');
var os = require('os');
var fs = require('fs');

var executors = require('../src/executors/taxChain');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');
var sessionModule = require('../src/executors/shopApiSession');
var evidenceCollector = require('../src/evidenceCollector');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });
var BUYER_PW = 'test-pass-buyer';

var LOGIN_MARKER = 'login(';
var PRODUCTS_MARKER = 'BrowseCountryChannelProducts';
var ACTIVE_ORDER_MARKER = 'GetActiveOrder';
var ORDER_BY_CODE_MARKER = 'GetOrderDetail';

function fakeClock() {
  return function() { return new Date('2026-10-10T10:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var root = path.resolve(__dirname, '..');
  var wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'taxchain-ws-'));
  // The dry-run must never touch the protected migration-input tree, so the
  // test overrides vendureStoreDir with a temp dir.
  var storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxchain-store-'));
  var base = {
    taskId: taskId,
    task: {
      canonicalId: taskId,
      mandatoryAssertions: [
        { id: 'CAN-B2-14-A01', text: 'Per-country Tax Zone and rate mapping stays consistent through product display, checkout, payment, order, receipt and post-tax split; the actual rates used are recorded from the run configuration.' },
        { id: 'CAN-B2-14-A02', text: 'Test country Tax Zone/rate setup and a controlled rate update through display, checkout, payment, receipt, and post-tax split.' },
        { id: 'CAN-B2-14-A03', text: 'Exchange-rate and tax-rate updates, including the scheduled behavior claimed by the implementation, must be shown through the affected user-visible and financial paths.' },
        { id: 'CAN-B2-14-A04', text: 'Verify the configured scheduled behavior for exchange rates and tax rates; record the source, frozen values, timestamps and downstream consistency.' }
      ],
      expectedResult: 'Per-country Tax Zone and rate mapping (and dynamic update where enabled) stays consistent through product display, checkout, payment, order, receipt and post-tax split; the actual rates used are recorded from the run configuration.'
    },
    taskId: taskId,
    workspace: { workspaceId: 'ws-taxchain', workspacePath: wsPath },
    vendureStoreDir: storeDir,
    runEnvRecord: Object.assign({ runId: 'run-tax-' + Date.now().toString(36), gitHead: 'beef00d214', revisionId: 'rev-tax' }, overrides.runEnvRecord || {}),
    repoRoot: root,
    deps: {}
  };
  if (overrides.shopApiBase) base.shopApiBase = overrides.shopApiBase;
  if (overrides.fetch) base.deps.fetch = overrides.fetch;
  if (overrides.execFile) base.deps.execFile = overrides.execFile;
  else base.deps.execFile = taxRatesExecFile(storeDir);
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
    expected: outcome.actual || 'Per-country Tax Zone and rate mapping (and dynamic update where enabled) stays consistent through product display, checkout, payment, order, receipt and post-tax split; the actual rates used are recorded from the run configuration.',
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Fake shop-api server
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

        function send(status, obj) {
          res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'session=' + sessionKey });
          res.end(JSON.stringify(obj));
        }

        if (scenario === '500') { send(500, { errors: [{ message: 'boom' }] }); return; }

        if (query.indexOf(LOGIN_MARKER) !== -1) {
          var username = (body.variables && body.variables.username) ? body.variables.username : 'unknown';
          send(200, { data: { login: { __typename: 'CurrentUser', id: 'user-1', identifier: username } } });
          return;
        }

        if (query.indexOf(PRODUCTS_MARKER) !== -1) {
          send(200, {
            data: {
              products: {
                items: [
                  { id: 'p-1', name: 'Fixture Design', slug: 'fixture-design', variants: [{ id: 'v-1', sku: 'FIXTURE-1', name: 'Fixture Variant', price: 1200, priceWithTax: 1428, currencyCode: 'EUR' }] }
                ]
              }
            }
          });
          return;
        }

        if (query.indexOf(ACTIVE_ORDER_MARKER) !== -1) {
          if (scenario === 'checkout-wrong-rate') {
            send(200, { data: { activeOrder: { id: 'o-check', code: 'ED-CHK-001', state: 'ArrangingPayment', active: true, currencyCode: 'EUR', taxSummary: [{ description: 'VAT', taxRate: 2000, taxTotal: 228 }] } } });
            return;
          }
          if (scenario === 'checkout-wrong-currency') {
            send(200, { data: { activeOrder: { id: 'o-check', code: 'ED-CHK-001', state: 'ArrangingPayment', active: true, currencyCode: 'GBP', taxSummary: [{ description: 'VAT', taxRate: 1900, taxTotal: 228 }] } } });
            return;
          }
          if (scenario === 'checkout-no-tax') {
            send(200, { data: { activeOrder: { id: 'o-check', code: 'ED-CHK-001', state: 'ArrangingPayment', active: true, currencyCode: 'EUR', taxSummary: [] } } });
            return;
          }
          send(200, { data: { activeOrder: { id: 'o-check', code: 'ED-CHK-001', state: 'ArrangingPayment', active: true, currencyCode: 'EUR', totalWithTax: 1428, taxSummary: [{ description: 'VAT', taxRate: 1900, taxTotal: 228 }] } } });
          return;
        }

        if (query.indexOf(ORDER_BY_CODE_MARKER) !== -1) {
          if (scenario === 'receipt-wrong-rate') {
            send(200, { data: { orderByCode: { id: 'o1', code: executors.DEFAULT_RECEIPT_CODE, state: 'PaymentSettled', active: false, currencyCode: 'EUR', totalWithTax: 1428, taxSummary: [{ description: 'VAT', taxRate: 2400, taxTotal: 288 }], lines: [], payments: [{ id: 'py-1', method: 'stripe', amount: 1428, state: 'Settled', transactionId: 'pi_1' }] } } });
            return;
          }
          if (scenario === 'receipt-wrong-currency') {
            send(200, { data: { orderByCode: { id: 'o1', code: executors.DEFAULT_RECEIPT_CODE, state: 'PaymentSettled', active: false, currencyCode: 'HUF', totalWithTax: 1428, taxSummary: [{ description: 'VAT', taxRate: 1900, taxTotal: 228 }], lines: [], payments: [] } } });
            return;
          }
          if (scenario === 'receipt-no-tax') {
            send(200, { data: { orderByCode: { id: 'o1', code: executors.DEFAULT_RECEIPT_CODE, state: 'PaymentSettled', active: false, currencyCode: 'EUR', totalWithTax: 1428, taxSummary: [], lines: [], payments: [] } } });
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
                lines: [{ id: 'l1', productVariant: { id: 'v-1', name: 'Fixture Design', sku: 'FIXTURE-1' }, unitPriceWithTax: 1428, quantity: 1, linePriceWithTax: 1428 }],
                payments: [{ id: 'py-1', method: 'stripe', amount: 1428, state: 'Settled', transactionId: 'pi_1' }]
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

function buyerEnv(extra) {
  return envWith(Object.assign({
    SHOP_ACCOUNT_PASSWORD_BUYER_ONE: BUYER_PW
  }, extra || {}));
}

// Fake docker compose gateway probe: the postgres container is running.
function gatewayOkExecFileSync() {
  return function(command, cmdArgs) {
    if (command === 'docker' && cmdArgs[0] === 'compose') {
      return 'container-1\n';
    }
    return '';
  };
}

function gatewayDownExecFileSync() {
  return function() {
    throw new Error('docker: command not found');
  };
}

// Fake setup_tax_rates.mjs dry-run: writes result.json + summary.txt into
// <ctx.vendureStoreDir>/work/tmp/tax-rate-setup/<ts>/ and exits 0.
function taxRatesExecFile(storeDir) {
  return function(file, args, options, cb) {
    var artifactRoot = path.join(storeDir, 'work', 'tmp', 'tax-rate-setup');
    var ts = '2026-10-10T10-00-00-000Z';
    var dir = path.join(artifactRoot, ts);
    fs.mkdirSync(dir, { recursive: true });
    var plan = [
      { country: 'DE', zoneName: 'DE Zone', zoneId: 1, categoryId: 1, desiredRate: 19, currentRate: 19, currentRateName: 'DE Standard VAT', status: 'match' },
      { country: 'AT', zoneName: 'AT Zone', zoneId: 2, categoryId: 1, desiredRate: 20, currentRate: 20, currentRateName: 'AT Standard VAT', status: 'match' },
      { country: 'HU', zoneName: 'HU Zone', zoneId: 3, categoryId: 1, desiredRate: 27, currentRate: 27, currentRateName: 'HU Standard VAT', status: 'match' },
      { country: 'GB', zoneName: 'GB Zone', zoneId: 4, categoryId: 1, desiredRate: 20, currentRate: 20, currentRateName: 'GB Standard VAT', status: 'match' }
    ];
    var result = {
      mode: 'dry-run',
      timestamp: ts,
      category: { id: 1, name: 'Standard Tax', isDefault: true },
      plan: plan,
      current: { zones: [], categories: [], rates: [] }
    };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'summary.txt'), [
      'mode: dry-run',
      'tax category: Standard Tax (id=1, isDefault=true)',
      'zone count: 4',
      'tax rate count: 4',
      'targets:',
      '- DE / DE Zone: current=19% (DE Standard VAT) -> desired=19% [match]',
      '- AT / AT Zone: current=20% (AT Standard VAT) -> desired=20% [match]',
      '- HU / HU Zone: current=27% (HU Standard VAT) -> desired=27% [match]',
      '- GB / GB Zone: current=20% (GB Standard VAT) -> desired=20% [match]'
    ].join('\n') + '\n', 'utf8');
    cb(null, 'DRY RUN tax-rate setup\n', '');
  };
}

// Registry with the frozen taxConfig input.
function taxRegistry() {
  return {
    inputs: [
      { id: 'taxConfig', status: 'CONTRACTOR_FREEZE', frozenValue: { DE: 19, AT: 20, HU: 27, GB: 20 } }
    ]
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('taxChain: register() registers CAN-B2-14 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-14'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-14');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-14-A01', 'CAN-B2-14-A02', 'CAN-B2-14-A03', 'CAN-B2-14-A04']);
  executorModule.resetTaskExecutors();
});

test('taxChain: success returns READINESS_PASS and verifies the full tax chain', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    registry: taxRegistry(),
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, true, outcome.error || 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass, never bare PASS literal');
  var c = outcome.evidence.checks;
  assert.strictEqual(c.frozenRatesOk, true, 'frozen rates match the run config');
  assert.strictEqual(c.registryTaxConfigOk, true, 'registry taxConfig matches');
  assert.strictEqual(c.productDisplayTax, true, 'product display tax consistent');
  assert.strictEqual(c.checkoutTax, true, 'checkout tax consistent with DE=19');
  assert.strictEqual(c.receiptTax, true, 'receipt tax consistent with DE=19');
  assert.strictEqual(c.taxRatesDryRun, true, 'setup_tax_rates.mjs dry-run through the gateway');
  assert.strictEqual(c.dryRunPlanMatches, true, 'dry-run plan matches run-config rates');
  assert.strictEqual(c.applyNeverPassed, true, '--apply never passed from this tree');
  assert.strictEqual(c.dynamicUpdateDryRun, true, 'dynamic update dry-run matches');
  assert.strictEqual(c.supportedCountryList, true, 'supported country list recorded');
  var evJson = JSON.stringify(outcome.evidence);
  assert.strictEqual(evJson.indexOf(BUYER_PW), -1, 'buyer password not leaked');
});

test('taxChain: checkout rate mismatch is an APPLICATION_DEFECT', async function() {
  var s = await startServer('checkout-wrong-rate');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('checkout') !== -1, 'error names the checkout');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-14');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('taxChain: receipt rate mismatch is an APPLICATION_DEFECT', async function() {
  var s = await startServer('receipt-wrong-rate');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('receipt') !== -1, 'error names the receipt');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-14');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('taxChain: shop API down is a DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-14');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('taxChain: PostgreSQL gateway unreachable locally -> DEPENDENCY_ENVIRONMENT with error as evidence', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayDownExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('gateway') !== -1 || outcome.error.indexOf('PostgreSQL') !== -1, 'error names the gateway');
  assert.ok(!!outcome.evidence, 'evidence present');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-14');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('taxChain: missing buyer account password -> BLOCK CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: envWith({}),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var evJson = JSON.stringify(outcome.evidence || {});
  assert.ok(evJson.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'records the env NAMES');
  assert.strictEqual(evJson.indexOf(BUYER_PW), -1, 'password value not leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-14');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('taxChain: missing channel tokens -> BLOCK CLIENT_INPUT_SCOPE', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: function() { return { SHOP_ACCOUNT_PASSWORD_BUYER_ONE: BUYER_PW }; },
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-14');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('taxChain: evidence written through writeEvidenceFile, no secret leaks, verifyEvidence passes, unverified assertions listed', async function() {
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-tax-'));
  var s = await startServer('ok');
  var runId = 'run-tax-ev-' + Date.now().toString(36);
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    registry: taxRegistry(),
    clock: fakeClock()
  });
  ctx.deps.config = { evidenceRoot: evidenceRoot };
  ctx.runEnvRecord.runId = runId;

  // Point the fake script's artifact root at the temp store dir used by the
  // executor (vendureStoreDir) so nothing touches the protected tree.
  // The executor writes artifacts under <vendureStoreDir>/work/tmp/tax-rate-setup.
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, true, outcome.error || 'success expected');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot, baseDir: 'evidence' });
  assert.strictEqual(verify.ok, true, verify.error || 'evidence should verify');

  var indexRoot = path.join(evidenceRoot, 'evidence');
  var files = evidenceCollector.listRunFiles ? null : null;
  // Read the executor-summary evidence file content.
  var sumPath = path.join(indexRoot, runId, 'CAN-B2-14', 'executor-summary.json');
  var sumContent = fs.readFileSync(sumPath, 'utf8');
  var sum = JSON.parse(sumContent);
  assert.strictEqual(sum.taskId, 'CAN-B2-14');
  assert.ok(Array.isArray(sum.assertionReport) && sum.assertionReport.length === 4, 'assertion report lists all four assertions');
  var unverified = sum.unverified || [];
  assert.ok(unverified.length > 0, 'unverified assertions explicitly listed');
  assert.ok(unverified.some(function(u) { return u.indexOf('payment') !== -1; }), 'payment path listed as unverified');
  assert.ok(unverified.some(function(u) { return u.indexOf('post-tax split') !== -1; }), 'post-tax split listed as unverified');
  // No secret leakage in evidence files.
  assert.strictEqual(JSON.stringify(sum).indexOf(BUYER_PW), -1, 'password not in evidence summary');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('taxChain: --apply is never passed to setup_tax_rates.mjs from this tree', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-14', {
    getEnv: buyerEnv(),
    shopApiBase: s.url,
    execFileSync: gatewayOkExecFileSync(),
    execFile: null,
    
    clock: fakeClock()
  });
  // Capture the command args the executor passes to the child.
  var seenArgs = null;
  var baseExec = ctx.deps.execFile;
  ctx.deps.execFile = function(file, args, options, cb) {
    seenArgs = args;
    return baseExec(file, args, options, cb);
  };
  var outcome = await executors.handlerTaxChain(ctx);
  await closeServer(s.server);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
  fs.rmSync(ctx.vendureStoreDir, { recursive: true, force: true });

  assert.strictEqual(outcome.success, true, outcome.error || 'success expected');
  assert.ok(seenArgs !== null, 'child invocation captured');
  assert.strictEqual(seenArgs.indexOf('--apply'), -1, '--apply never passed');
});
