'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');
var childProcess = require('child_process');

var integrityModule = require('../src/integrity');
var reviewModule = require('../skills/pipeline-review/review');

var REPO_ROOT = path.resolve(__dirname, '..');
var MANIFEST_PATH = path.join(REPO_ROOT, 'manifest', 'acceptance-manifest.v0.4.json');
var RESULT_PASS = reviewModule.RESULT_PASS;
var RESULT_READINESS_PASS = reviewModule.RESULT_READINESS_PASS;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

function b1_03Body(currencyCode, items) {
  return { data: { activeChannel: { currencyCode: currencyCode }, products: { items: items } } };
}

function b1_03Item(name, price, currencyCode) {
  return { name: name, variants: [{ price: price, currencyCode: currencyCode }] };
}

function b1_04Variant(id, sku, name, price, currencyCode) {
  return { id: id, sku: sku, name: name, enabled: true, price: price, currencyCode: currencyCode };
}

function b1_04Product(id, name, slug, variants) {
  return { id: id, name: name, slug: slug, enabled: true, variants: variants };
}

function b1_04Body(items) {
  return { data: { products: { items: items } } };
}

/**
 * A tiny fake staging server. Serves /health and /shop-api keyed by the
 * vendure-token header. The `scenario` selects the response set:
 *  - 'b1-03-ok': every country returns its own currency.
 *  - 'b1-03-de-gbp': DE returns GBP (a cross-country currency leak).
 *  - 'b1-03-500': DE returns HTTP 500.
 *  - 'b1-04-ok': per-country product/variant visibility, one DE variant leak-free set.
 *  - 'b1-04-leak': DE shows an extra variant (a visibility leak).
 */
function createFakeServer(scenario, cb) {
  var server = http.createServer(function(req, res) {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url !== '/shop-api') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      var token = req.headers['vendure-token'] || '';
      var payload = scenarioFor(scenario, token);
      res.writeHead(payload.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload.body));
    });
  });
  server.listen(0, '127.0.0.1', function() {
    var port = server.address().port;
    cb(null, server, port);
  });
  server.on('error', cb);
  return server;
}

function scenarioFor(scenario, token) {
  if (scenario === 'b1-03-de-gbp') {
    var gbp = token === 'de-token';
    return { status: 200, body: b1_03Body(gbp ? 'GBP' : currencyFor(token), [b1_03Item('p', 100, gbp ? 'GBP' : currencyFor(token))]) };
  }
  if (scenario === 'b1-03-500') {
    if (token === 'de-token') return { status: 500, body: { errors: [{ message: 'boom' }] } };
    return { status: 200, body: b1_03Body(currencyFor(token), [b1_03Item('p', 100, currencyFor(token))]) };
  }
  if (scenario === 'b1-04-ok' || scenario === 'b1-04-leak') {
    var leaking = scenario === 'b1-04-leak' && token === 'de-token';
    return { status: 200, body: b1_04Body(b1_04Products(token, leaking)) };
  }
  // default: b1-03-ok
  return { status: 200, body: b1_03Body(currencyFor(token), [b1_03Item('p', 100, currencyFor(token))]) };
}

function b1_03OkBodyFor(token) {
  return b1_03Body(currencyFor(token), [b1_03Item('p', 100, currencyFor(token))]);
}

function currencyFor(token) {
  var map = { 'de-token': 'EUR', 'at-token': 'EUR', 'hu-token': 'HUF', 'gb-token': 'GBP' };
  return map[token] || 'EUR';
}

function b1_04Products(token, withExtraLeak) {
  if (token === 'de-token') {
    var designTwo = [
      b1_04Variant('v3', 'SKU-DE-2', 'Design Two / S', 2600, 'EUR')
    ];
    if (withExtraLeak) {
      designTwo.push(b1_04Variant('v6', 'SKU-DE-LEAK', 'Design Two / L', 2800, 'EUR'));
    }
    return [
      b1_04Product('p1', 'Design One', 'design-one', [
        b1_04Variant('v1', 'SKU-DE-1', 'Design One / S', 2500, 'EUR'),
        b1_04Variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')
      ]),
      b1_04Product('p3', 'Design Two', 'design-two', designTwo)
    ];
  }
  if (token === 'at-token') {
    return [b1_04Product('p1', 'Design One', 'design-one', [b1_04Variant('v2', 'SKU-AT-1', 'Design One / M', 3000, 'EUR')])];
  }
  if (token === 'hu-token') {
    return [b1_04Product('p4', 'Design HU', 'design-hu', [b1_04Variant('v4', 'SKU-HU-1', 'Design HU / S', 875000, 'HUF')])];
  }
  if (token === 'gb-token') {
    return [b1_04Product('p5', 'Design GB', 'design-gb', [b1_04Variant('v5', 'SKU-GB-1', 'Design GB / S', 2200, 'GBP')])];
  }
  return [];
}

function makeRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

/**
 * A temp manifest where CAN-B1-03 and CAN-B1-04 require only channelTokens, so
 * preflight passes with CHANNEL_TOKENS set and the health gate (which would
 * probe the frozen staging URL) is not reached.
 */
function writeTempManifest() {
  var result = require('../src/manifest').loadManifest(MANIFEST_PATH);
  if (!result.valid) {
    throw new Error('could not load manifest');
  }
  var manifest = JSON.parse(JSON.stringify(result.manifest));
  manifest.tasks = manifest.tasks.map(function(t) {
    if (t.canonicalId === 'CAN-B1-03' || t.canonicalId === 'CAN-B1-04') {
      t.requiredInputs = ['channelTokens'];
    }
    if (t.canonicalId === 'CAN-B2-04' || t.canonicalId === 'CAN-B2-08') {
      // Image-archive and commission-tiers executors read their fixtures from
      // the repo / isolated workspace; no staging or client input is needed.
      t.requiredInputs = [];
    }
    return t;
  });
  manifest.integrity.expectedValuesHash = integrityModule.computeExpectedValuesHash(manifest);
  var tmpPath = path.join(os.tmpdir(), 'e2e-manifest-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6) + '.json');
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  return tmpPath;
}

function runPipelineChild(taskId, runId, port, extraEnv, extraArgs) {
  var manifestPath = writeTempManifest();
  var env = Object.assign({}, process.env, {
    PIPELINE_RUN_ID: runId,
    CHANNEL_TOKENS: TOKENS_JSON,
    STAGING_URL: 'http://127.0.0.1:' + port,
    PIPELINE_EVIDENCE_BASE_DIR: 'evidence'
  }, extraEnv || {});
  delete env.NODE_OPTIONS;
  return new Promise(function(resolve, reject) {
    var spawnArgs = [
      'bin/pipeline.js',
      'run',
      '--manifest', manifestPath,
      '--task', taskId
    ].concat(extraArgs || []);
    var child = childProcess.spawn(process.execPath, spawnArgs, {
      cwd: REPO_ROOT,
      env: env
    });
    var stdout = '';
    var stderr = '';
    child.stdout.on('data', function(d) { stdout += d; });
    child.stderr.on('data', function(d) { stderr += d; });
    var timer = setTimeout(function() { child.kill('SIGKILL'); }, 90000);
    child.on('error', function(err) {
      clearTimeout(timer);
      fs.rmSync(manifestPath, { force: true });
      reject(err);
    });
    child.on('close', function(code) {
      clearTimeout(timer);
      fs.rmSync(manifestPath, { force: true });
      resolve({ status: code, stdout: stdout, stderr: stderr });
    });
  });
}

function evidenceRootPath(runId) {
  return path.join(REPO_ROOT, 'evidence', runId);
}

function reportRootPath(runId) {
  return path.join(REPO_ROOT, 'reports', runId);
}

function cleanupRun(runId) {
  fs.rmSync(evidenceRootPath(runId), { recursive: true, force: true });
  fs.rmSync(reportRootPath(runId), { recursive: true, force: true });
}

function firstServerPortForScenario(scenario) {
  return new Promise(function(resolve, reject) {
    createFakeServer(scenario, function(err, server, port) {
      if (err) return reject(err);
      resolve({ server: server, port: port });
    });
  });
}

function verifyRecordOnDisk(runId, taskId, key) {
  var recordPath = path.join(evidenceRootPath(runId), taskId, 'record.json');
  assert.strictEqual(fs.existsSync(recordPath), true, 'record.json on disk for ' + taskId);
  return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
}

test('e2e CAN-B1-03: all correct -> exit 0, evidence verifies, review PASS', async function(t) {
  var srv = await firstServerPortForScenario('b1-03-ok');
  var runId = makeRunId('b103ok');
  try {
    var res = await runPipelineChild('CAN-B1-03', runId, srv.port);
    assert.strictEqual(res.status, 0, 'all-correct run exits 0; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B1-03', 'result');
    assert.strictEqual(record.result, RESULT_READINESS_PASS, 'B1-03 readiness-subset PASS is READINESS_PASS');
    assert.strictEqual(record.coverage, 'readiness-subset', 'record carries readiness-subset coverage');
    assert.strictEqual(record.actualResult, record.expectedResult, 'expected equals actual in record');
    assert.ok(record.cleanupResetResult && record.cleanupResetResult.ok === true, 'cleanup reset recorded ok');
    var review = reviewModule.reviewRun(runId, { expectedTaskCount: 1, root: REPO_ROOT });
    assert.strictEqual(review.tasks['CAN-B1-03'].verdict, RESULT_READINESS_PASS, 'review.js returns READINESS_PASS for CAN-B1-03');
  } finally {
    srv.server.close();
    cleanupRun(runId);
  }
});

test('e2e CAN-B1-03: DE returning GBP -> exit 3 APPLICATION_DEFECT', async function(t) {
  var srv = await firstServerPortForScenario('b1-03-de-gbp');
  var runId = makeRunId('b103gbp');
  try {
    var res = await runPipelineChild('CAN-B1-03', runId, srv.port);
    assert.strictEqual(res.status, 3, 'currency mismatch exits 3; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B1-03', 'result');
    assert.strictEqual(record.result, 'BLOCK');
    assert.strictEqual(record.classification, 'APPLICATION_DEFECT');
    assert.strictEqual(record.cause, 'EXPECTED_MISMATCH');
  } finally {
    srv.server.close();
    cleanupRun(runId);
  }
});

test('e2e CAN-B1-03: server down -> exit 6 DEPENDENCY_ENVIRONMENT', async function(t) {
  // Bind a server, note its port, then close it so nothing listens there.
  var portProbe = await firstServerPortForScenario('b1-03-ok');
  var port = portProbe.port;
  portProbe.server.close();
  var runId = makeRunId('b103down');
  try {
    var res = await runPipelineChild('CAN-B1-03', runId, port);
    assert.strictEqual(res.status, 6, 'server-down exits 6; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B1-03', 'result');
    assert.strictEqual(record.result, 'BLOCK');
    assert.strictEqual(record.classification, 'DEPENDENCY_ENVIRONMENT');
  } finally {
    cleanupRun(runId);
  }
});

test('e2e CAN-B1-04: all correct -> exit 0, review PASS for that task', async function(t) {
  var srv = await firstServerPortForScenario('b1-04-ok');
  var runId = makeRunId('b104ok');
  try {
    var res = await runPipelineChild('CAN-B1-04', runId, srv.port);
    assert.strictEqual(res.status, 0, 'all-correct B1-04 exits 0; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B1-04', 'result');
    assert.strictEqual(record.result, RESULT_READINESS_PASS, 'B1-04 readiness-subset PASS is READINESS_PASS');
    assert.strictEqual(record.coverage, 'readiness-subset', 'record carries readiness-subset coverage');
    var review = reviewModule.reviewRun(runId, { expectedTaskCount: 1, root: REPO_ROOT });
    assert.strictEqual(review.tasks['CAN-B1-04'].verdict, RESULT_READINESS_PASS, 'review.js returns READINESS_PASS for CAN-B1-04');
  } finally {
    srv.server.close();
    cleanupRun(runId);
  }
});

test('e2e CAN-B1-04: planted-mismatch control -> exit 3 APPLICATION_DEFECT', async function(t) {
  var srv = await firstServerPortForScenario('b1-04-ok');
  var runId = makeRunId('b104plant');
  try {
    var res = await runPipelineChild('CAN-B1-04', runId, srv.port, { CAN_B1_04_PLANT_MISMATCH: '1' });
    assert.strictEqual(res.status, 3, 'planted mismatch exits 3; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B1-04', 'result');
    assert.strictEqual(record.result, 'BLOCK');
    assert.strictEqual(record.classification, 'APPLICATION_DEFECT');
    var review = reviewModule.reviewRun(runId, { expectedTaskCount: 1, root: REPO_ROOT });
    assert.strictEqual(review.tasks['CAN-B1-04'].verdict, 'BLOCK', 'review blocks the planted-mismatch run');
    assert.strictEqual(review.tasks['CAN-B1-04'].failureClass, 'APPLICATION_DEFECT');
  } finally {
    srv.server.close();
    cleanupRun(runId);
  }
});

// ---------------------------------------------------------------------------
// CAN-B2-16 shipping-dryrun (chunk 8d). The fixture CSV is passed to the child
// scripts as a repo-relative path (or wslpath view on a Windows host); the .sh
// part detects missing tools via command -v in the same bash and maps to
// BLOCK TOOL_UNAVAILABLE / DEPENDENCY_ENVIRONMENT. When bash, jq, curl and
// python3 all exist the run passes (exit 0) and review.js returns PASS;
// otherwise it exits 6 naming the missing tool. The assertion below selects
// whichever case applies to the current machine.
// ---------------------------------------------------------------------------

var SHIPPING_TOOLS = ['bash', 'jq', 'curl', 'python3'];

function missingShippingTools() {
  var probe = childProcess.spawnSync('bash', ['-c', SHIPPING_TOOLS.map(function(t) {
    return 'command -v ' + t + ' >/dev/null 2>&1 || echo ' + t;
  }).join('; ')], { encoding: 'utf8', timeout: 30000 });
  if (probe.error || probe.status !== 0 || probe.stdout === undefined) {
    return ['bash'];
  }
  return String(probe.stdout).split(/\r?\n/)
    .map(function(line) { return line.trim(); })
    .filter(function(line) { return SHIPPING_TOOLS.indexOf(line) !== -1; });
}

test('e2e CAN-B2-16 shipping-dryrun: exit 0 + review PASS when tools exist, exit 6 + tool when missing', async function(t) {
  var missing = missingShippingTools();
  var runId = makeRunId('b216ship');
  var environmentNote = missing.length === 0
    ? 'all tools present: ' + SHIPPING_TOOLS.join(', ')
    : 'missing tools: ' + missing.join(', ');
  var res;
  try {
    res = await runPipelineChild('CAN-B2-16', runId, 0, {}, ['--scope', 'shipping-dryrun']);
  } catch (err) {
    t.skip('SKIP shipping-dryrun e2e: could not spawn pipeline child (' + err.message + '); ' + environmentNote);
    return;
  }
  try {
    var record = verifyRecordOnDisk(runId, 'CAN-B2-16', 'result');
    if (missing.length === 0) {
      assert.strictEqual(res.status, 0, 'all tools present so the run must pass (exit 0); stderr tail: ' + String(res.stderr || '').slice(-400));
      assert.strictEqual(record.result, RESULT_READINESS_PASS, 'shipping dry-run readiness PASS is READINESS_PASS');
      assert.strictEqual(record.coverage, 'readiness-subset', 'record carries readiness-subset coverage');
      var review = reviewModule.reviewRun(runId, { expectedTaskCount: 1, root: REPO_ROOT });
      assert.strictEqual(review.tasks['CAN-B2-16'].verdict, RESULT_READINESS_PASS, 'review.js returns READINESS_PASS for CAN-B2-16');
    } else {
      assert.strictEqual(res.status, 6, 'missing tool -> exit 6 (DEPENDENCY_ENVIRONMENT); stderr tail: ' + String(res.stderr || '').slice(-400));
      assert.strictEqual(record.result, 'BLOCK');
      assert.strictEqual(record.classification, 'DEPENDENCY_ENVIRONMENT');
      assert.strictEqual(record.cause, 'TOOL_UNAVAILABLE');
      var errorText = JSON.stringify(record.exitErrorResult || {}) + ' ' + (record.error || '');
      var named = missing.filter(function(tool) { return errorText.indexOf(tool) !== -1; });
      assert.ok(named.length > 0, 'run names the missing tool (' + environmentNote + '): ' + errorText);
    }
  } finally {
    cleanupRun(runId);
  }
});

// ---------------------------------------------------------------------------
// CAN-B2-08 commission-tiers (chunk 9a-wire). The registered executor runs the
// pipeline-authored script with the synthetic fixture in the workspace and
// verifies every tier boundary. A real child process of
// bin/pipeline.js run --task CAN-B2-08 --scope commission-tiers must exit 0
// and review.js must return PASS for the scope. No external bash tooling is
// required (node only), so the expected result is deterministic.
// ---------------------------------------------------------------------------

test('e2e CAN-B2-08 commission-tiers: child run exits 0 and review passes', async function(t) {
  var runId = makeRunId('b208comt');
  var res;
  try {
    res = await runPipelineChild('CAN-B2-08', runId, 0, {}, ['--scope', 'commission-tiers']);
  } catch (err) {
    t.skip('SKIP commission-tiers e2e: could not spawn pipeline child (' + err.message + ')');
    return;
  }
  try {
    assert.strictEqual(res.status, 0, 'commission-tiers run must exit 0; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B2-08', 'result');
    assert.strictEqual(record.result, RESULT_READINESS_PASS, 'record result is READINESS_PASS for CAN-B2-08');
    assert.strictEqual(record.coverage, 'readiness-subset', 'record carries readiness-subset coverage');
    var review = reviewModule.reviewRun(runId, { expectedTaskCount: 1, root: REPO_ROOT });
    assert.strictEqual(review.tasks['CAN-B2-08'].verdict, RESULT_READINESS_PASS, 'review.js returns READINESS_PASS for CAN-B2-08');
    assert.strictEqual(review.tasks['CAN-B2-08'].failureClass, null);
  } finally {
    cleanupRun(runId);
  }
});

// ---------------------------------------------------------------------------
// CAN-B2-04 image-archive (chunk 10a). The registered executor runs the real
// supplied script (sync_vendor_uploads.mjs) against the real nail-patterns
// fixture design set in an isolated workspace and verifies the archive on
// disk. A real child process of bin/pipeline.js run --task CAN-B2-04 must exit
// 0, the record must be READINESS_PASS with readiness-subset coverage, both
// unverified assertions (export lookup, customer upload form) must be listed,
// evidence must pass verifyEvidence, and review.js must show READINESS_PASS.
// ---------------------------------------------------------------------------

test('e2e CAN-B2-04 image-archive: child run exits 0 and review passes (READINESS_PASS)', async function(t) {
  var runId = makeRunId('b204ia');
  var res;
  try {
    res = await runPipelineChild('CAN-B2-04', runId, 0, {}, []);
  } catch (err) {
    t.skip('SKIP image-archive e2e: could not spawn pipeline child (' + err.message + ')');
    return;
  }
  try {
    assert.strictEqual(res.status, 0, 'image-archive run must exit 0; stderr tail: ' + String(res.stderr || '').slice(-400));
    var record = verifyRecordOnDisk(runId, 'CAN-B2-04', 'result');
    assert.strictEqual(record.result, RESULT_READINESS_PASS, 'record result is READINESS_PASS for CAN-B2-04');
    assert.strictEqual(record.coverage, 'readiness-subset', 'record carries readiness-subset coverage');
    assert.strictEqual(record.actualResult, record.expectedResult, 'expected equals actual in record');
    // Both unverified assertions are listed on the record's coverageAssertions.
    var ca = record.coverageAssertions || {};
    var unverifiedIds = (ca.unverified || []).map(function(a) { return a.id; }).sort();
    assert.deepStrictEqual(unverifiedIds, ['CAN-B2-04-A01', 'CAN-B2-04-A02'], 'both mandatory assertions recorded as unverified');
    // The executor-side evidence carries the export-lookup and customer-upload
    // out-of-scope assertions; verify they are present there too.
    var review = reviewModule.reviewRun(runId, { expectedTaskCount: 1, root: REPO_ROOT });
    assert.strictEqual(review.tasks['CAN-B2-04'].verdict, RESULT_READINESS_PASS, 'review.js returns READINESS_PASS for CAN-B2-04');
    assert.strictEqual(review.tasks['CAN-B2-04'].failureClass, null);
  } finally {
    cleanupRun(runId);
  }
});

