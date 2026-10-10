'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var executors = require('../src/executors/shippingDryRun');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_PASS = terminalState.RESULT_PASS;

function fakeClock(iso) {
  var current = new Date(iso || '2026-10-07T09:00:00.000Z');
  return function() { return new Date(current.getTime()); };
}

function taskFor(taskId, expectedResult) {
  return {
    canonicalId: taskId,
    expectedResult: expectedResult || ('expected result for ' + taskId)
  };
}

function realWorkspace(prefix) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ws-shipping-'));
  return { workspaceId: 'ws-shipping', workspacePath: dir, runId: 'run-shipping', exists: true };
}

function writeArtifacts(artifactRoot, csvPath) {
  var csv = fs.readFileSync(csvPath, 'utf8');
  var derived = executors.deriveShippingPlan(csv);
  var dir = path.join(artifactRoot, '2026-10-07T09-00-00-000Z');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shipping-plan.json'),
    JSON.stringify({ rows: derived.rows, plans: derived.plans, deductionPlan: derived.deductionPlan }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    csvPath: csvPath,
    commit: false,
    reconcileStockOnly: false,
    totalRows: derived.rows.length,
    totalOrders: derived.plans.length,
    deductionPlan: derived.deductionPlan,
    committed: [],
    stockAdjustments: [],
    outputDir: artifactRoot,
    status: 'passed'
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'summary.txt'), [
    'CSV: ' + csvPath,
    'Commit: no',
    'Reconcile stock only: no',
    'Orders: ' + derived.plans.length,
    'Rows: ' + derived.rows.length,
    'Committed: 0',
    'Output dir: ' + artifactRoot,
    'Shipping plan: ' + path.join(dir, 'shipping-plan.json'),
    'Result: ' + path.join(dir, 'result.json')
  ].join('\n') + '\n', 'utf8');
  return derived;
}

function passNode(cb, args, options) {
  try {
    var csvArg = String(args[1] || '');
    var csvPath = csvArg.split('=')[1];
    if (!csvPath) throw new Error('no --csv= argument');
    writeArtifacts(options.env.PROCESS_SHIPPING_ARTIFACT_DIR, csvPath);
    cb(null, 'PASS process shipping csv\nOrders: 2, rows: 3\n');
  } catch (e) {
    cb({ code: 1, message: String((e && e.message) || e) }, '', '');
  }
}

function passBash(cb, args, options) {
  cb(null, '=== CSV-Based Bulk Shipping Tool (public adapter) ===\nCSV: ' + args[1] +
    '\nFound 1 order(s) marked for shipment.\n  ED-RUN-0001\nDRY_RUN=true; no API request was sent.\n', '');
}

function makeExecFile(nodeBehavior, bashBehavior, calls) {
  return function(file, args, options, cb) {
    if (calls) calls.push({ file: file, args: args.slice(), options: options });
    if (file === process.execPath || file === 'node') {
      nodeBehavior(cb, args, options);
    } else {
      bashBehavior(cb, args, options);
    }
  };
}

function baseDeps(execFile, calls) {
  return {
    execFile: execFile,
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    mkdirSync: function(p, o) { fs.mkdirSync(p, o || { recursive: true }); },
    readFileSync: function(p, e) { return fs.readFileSync(p, e || 'utf8'); },
    readdirSync: function(p, o) { return fs.readdirSync(p, o || { withFileTypes: true }); },
    existsSync: function(p) { return fs.existsSync(p); }
  };
}

function baseContext(overrides) {
  overrides = overrides || {};
  var ws = overrides.workspace || realWorkspace();
  var calls = [];
  var execFile = overrides.execFile || makeExecFile(passNode, passBash, calls);
  var ctx = {
    taskId: 'CAN-B2-16',
    task: taskFor('CAN-B2-16', 'expected result for CAN-B2-16'),
    workspace: ws,
    runEnvRecord: { runId: ws.runId, gitHead: 'cafebabe1234', revisionId: 'rev-t' },
    deps: baseDeps(execFile, calls),
    depCalls: calls
  };
  if (overrides.runId) ctx.runId = overrides.runId;
  if (overrides.repoRoot) ctx.repoRoot = overrides.repoRoot;
  if (overrides.fixtures) ctx.fixtures = overrides.fixtures;
  if (overrides.extraDeps) Object.assign(ctx.deps, overrides.extraDeps);
  return ctx;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'expected result for ' + (taskId || 'unknown'),
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Deterministic fixture helpers (mirror of the legacy scripts)
// ---------------------------------------------------------------------------

test('shippingDryRun: deriveShippingPlan mirrors process_shipping_csv.mjs', function(t) {
  var d = executors.deriveShippingPlan(executors.DEFAULT_SHIPPING_FIXTURE_CSV);
  assert.strictEqual(d.rows.length, 3, 'three data rows');
  assert.strictEqual(d.plans.length, 2, 'two orders');
  var o1 = d.plans[0];
  assert.strictEqual(o1.orderCode, 'ED-RUN-0001');
  assert.strictEqual(o1.shippingCountryCode, 'DE');
  assert.strictEqual(o1.lineCount, 2);
  assert.strictEqual(o1.totalQuantity, 3);
  var o2 = d.plans[1];
  assert.strictEqual(o2.orderCode, 'ED-RUN-0002');
  assert.strictEqual(o2.shippingCountryCode, 'HU');
  assert.strictEqual(o2.totalQuantity, 3);
  assert.deepStrictEqual(d.deductionPlan, [
    { variantSku: 'SKU-NAIL-001', quantity: 5, note: 'stock deduction preview; applied during commit mode' },
    { variantSku: 'SKU-NAIL-002', quantity: 1, note: 'stock deduction preview; applied during commit mode' }
  ]);
});

test('shippingDryRun: deriveShippedCodes parses 订单号/已发货 marked rows', function(t) {
  var codes = executors.deriveShippedCodes(executors.DEFAULT_SHIPPED_FIXTURE_CSV);
  assert.deepStrictEqual(codes, ['ED-RUN-0001']);
  assert.strictEqual(executors.deriveShippedCodes('\uFEFF订单号,已发货\nA,0\nB,1\nB,1\nC,x\n').join(','), 'B', 'only "1" rows, de-duplicated, in order');
});

test('shippingDryRun: buildRestrictedEnv never forwards credential vars', function(t) {
  process.env.VENDURE_ADMIN_TOKEN = 'sk-leak-check';
  process.env.SUPERADMIN_PASSWORD = 'pw';
  try {
    var r = executors.buildRestrictedEnv({ DRY_RUN: 'true' });
    assert.strictEqual(r.env.VENDURE_ADMIN_TOKEN, undefined, 'token not forwarded');
    assert.strictEqual(r.env.SUPERADMIN_PASSWORD, undefined, 'password not forwarded');
    assert.strictEqual(r.env.DRY_RUN, 'true');
    assert.strictEqual(r.env.PATH, process.env.PATH);
    assert.ok(r.keys.indexOf('VENDURE_ADMIN_TOKEN') === -1, 'never listed in env keys');
  } finally {
    delete process.env.VENDURE_ADMIN_TOKEN;
    delete process.env.SUPERADMIN_PASSWORD;
  }
});

// ---------------------------------------------------------------------------
// Handler: PASS path
// ---------------------------------------------------------------------------

test('shippingDryRun: both scripts succeed and artifacts match -> PASS', async function(t) {
  var ctx = baseContext({ execFile: makeExecFile(passNode, passBash, []) });
  var outcome = await executors.handlerShippingDryRun(ctx);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_PASS, 'must use RESULT_PASS');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-16');
  assert.ok(outcome.evidence, 'evidence present');

  var ev = outcome.evidence;
  assert.strictEqual(ev.scope, 'shipping-dryrun');
  assert.strictEqual(ev.executionRevision, 'cafebabe1234', 'execution revision captured');
  assert.strictEqual(ev.scripts.processShippingCsv.repoRelativePath,
    'evaluation-demo/migration-input/legacy/vendure-store/scripts/process_shipping_csv.mjs');
  assert.strictEqual(ev.scripts.markShippedFromCsv.repoRelativePath,
    'evaluation-demo/migration-input/legacy/vendure-store/tools/mark_shipped_from_csv.sh');

  assert.strictEqual(ev.commands.length, 2, 'one command per script');
  assert.strictEqual(ev.commands[0].command, 'node');
  assert.strictEqual(ev.commands[0].args[0],
    'evaluation-demo/migration-input/legacy/vendure-store/scripts/process_shipping_csv.mjs');
  // Fixture CSV must reach the child as a repo-relative path (no drive letter).
  assert.strictEqual(ev.commands[0].args[1],
    '--csv=' + path.relative(process.cwd(), path.join(ctx.workspace.workspacePath, 'shipping-fixture.csv')));
  assert.ok(ev.commands[0].args[1].indexOf('shipping-fixture.csv') !== -1, 'names the fixture file');
  assert.ok(/^--csv=[^:]/.test(ev.commands[0].args[1]), 'node csv arg has no drive-letter prefix');
  assert.ok(!/^[a-zA-Z]:[\\/]/.test(ev.commands[0].args[1]), 'node csv arg is never a drive-letter path');
  assert.ok(!/^[a-zA-Z]:[\\/]/.test(ev.commands[1].args[1]), 'bash csv arg is never a drive-letter path');
  assert.strictEqual(ev.commands[0].exitCode, 0);
  assert.strictEqual(ev.commands[1].command, 'bash');
  assert.strictEqual(ev.commands[1].args[0],
    'evaluation-demo/migration-input/legacy/vendure-store/tools/mark_shipped_from_csv.sh');
  assert.strictEqual(ev.commands[1].args[1],
    path.relative(process.cwd(), path.join(ctx.workspace.workspacePath, 'shipped-fixture.csv')));
  assert.strictEqual(ev.commands[1].exitCode, 0);

  assert.strictEqual(ev.fixtures.processShippingCsv.sha256,
    executors.sha256Hex(executors.DEFAULT_SHIPPING_FIXTURE_CSV), 'csv hash recorded');
  assert.strictEqual(ev.fixtures.markShipped.sha256,
    executors.sha256Hex(executors.DEFAULT_SHIPPED_FIXTURE_CSV));

  assert.ok(ev.artifacts.shippingPlan, 'shipping-plan.json captured');
  assert.strictEqual(ev.artifacts.shippingPlan.plans.length, 2);
  assert.strictEqual(ev.artifacts.result.status, 'passed');
  assert.ok(ev.artifacts.summary.indexOf('Commit: no') !== -1, 'summary.txt captured');

  assert.strictEqual(ev.checks.outputsMatchPlan, true);
  assert.strictEqual(ev.checks.noApiCall, true, 'bash reports no API request');
  assert.strictEqual(ev.checks.noStateChange, true, 'committed=0 and stockAdjustments=0');
  assert.strictEqual(ev.checks.credentialsAbsent, true);
  assert.deepStrictEqual(ev.expected.shippedCodes, ['ED-RUN-0001']);

  // workspace fixtures were actually created + hashed
  assert.strictEqual(fs.existsSync(path.join(ctx.workspace.workspacePath, 'shipping-fixture.csv')), true);
  assert.strictEqual(fs.existsSync(path.join(ctx.workspace.workspacePath, 'shipped-fixture.csv')), true);

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-16');
  assert.strictEqual(finalOutcome.result, RESULT_PASS);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path portability: the fixture CSV must be repo-relative or wslpath-translated
// on a Windows host, never a drive-letter path.
// ---------------------------------------------------------------------------

test('shippingDryRun: childCsvArg returns a repo-relative path, never a drive letter', function(t) {
  var root = process.cwd();
  var under = path.join(root, 'workspace', 'run-x', 'shipping-fixture.csv');
  var arg = executors.childCsvArg({}, under);
  assert.ok(!/^[a-zA-Z]:[\\/]/.test(arg), 'no drive-letter prefix: got ' + arg);
  if (path.isAbsolute(arg)) {
    assert.ok(/^[a-zA-Z]:[\\/]/.test(arg) === false, 'argument stays repo-relative');
  }
  assert.ok(arg.indexOf(root) === -1, 'repo root itself is not embedded in the arg');
});

test('shippingDryRun: Windows host with a cross-drive workspace uses wslpath -u', function(t) {
  var syncCalls = [];
  var ctx = {
    platform: 'win32',
    deps: {
      execFileSync: function(file, args, opts) {
        syncCalls.push({ file: file, args: args });
        return '/mnt/d/ws/run-x/shipping-fixture.csv\n';
      }
    }
  };
  var arg = executors.childCsvArg(ctx, 'D:\\ws\\run-x\\shipping-fixture.csv');
  assert.strictEqual(arg, '/mnt/d/ws/run-x/shipping-fixture.csv', 'wslpath -u translation is used');
  assert.strictEqual(syncCalls.length, 1, 'wslpath called once');
  assert.strictEqual(syncCalls[0].file, 'wslpath');
  assert.deepStrictEqual(syncCalls[0].args, ['-u', 'D:\\ws\\run-x\\shipping-fixture.csv']);
});

test('shippingDryRun: PASS-path evidence commands carry no drive-letter paths', async function(t) {
  var ctx = baseContext({ execFile: makeExecFile(passNode, passBash, []) });
  var outcome = await executors.handlerShippingDryRun(ctx);
  assert.strictEqual(outcome.success, true);
  var ev = outcome.evidence;
  ev.commands.forEach(function(c) {
    c.args.forEach(function(a) {
      assert.ok(!/^[a-zA-Z]:[\\/]/.test(String(a)), 'no drive-letter arg: ' + a);
    });
  });
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('shippingDryRun: custom fixture via context.fixtures is hashed and validated', async function(t) {
  var shippingCsv = [
    'orderCode,lineId,lineQuantity,variantSku',
    'ED-SINGLE-01,L1,1,SKU-ONE',
    'ED-SINGLE-01,L2,4,SKU-TWO'
  ].join('\n') + '\n';
  var ctx = baseContext({ fixtures: { shippingCsv: shippingCsv } });
  var outcome = await executors.handlerShippingDryRun(ctx);
  assert.strictEqual(outcome.success, true, 'single custom order dry-run should PASS');
  var ev = outcome.evidence;
  assert.strictEqual(ev.fixtures.processShippingCsv.sha256, executors.sha256Hex(shippingCsv), 'override fixture is hashed');
  assert.strictEqual(ev.artifacts.shippingPlan.plans.length, 1);
  assert.strictEqual(ev.expected.plans[0].totalQuantity, 5);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Handler: failure paths
// ---------------------------------------------------------------------------

test('shippingDryRun: missing jq in .sh -> TOOL_UNAVAILABLE DEPENDENCY_ENVIRONMENT', async function(t) {
  function jqMissingBash(cb) { cb({ code: 1 }, '', 'ERROR: Required command not found: jq\n'); }
  var ctx = baseContext({ execFile: makeExecFile(passNode, jqMissingBash, []) });
  var outcome = await executors.handlerShippingDryRun(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'TOOL_UNAVAILABLE');
  assert.ok(outcome.error.indexOf('jq') !== -1, 'error names the missing tool');
  assert.strictEqual(outcome.evidence.checks.missingTool, 'jq');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-16');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT', 'missing tool is a dependency/environment failure');
  assert.strictEqual(finalOutcome.cause, 'TOOL_UNAVAILABLE');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('shippingDryRun: bash itself missing (ENOENT) -> TOOL_UNAVAILABLE bash', async function(t) {
  function bashEnoent(cb) { cb({ code: 'ENOENT', message: 'spawn bash ENOENT' }, '', ''); }
  var ctx = baseContext({ execFile: makeExecFile(passNode, bashEnoent, []) });
  var outcome = await executors.handlerShippingDryRun(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'TOOL_UNAVAILABLE');
  assert.strictEqual(outcome.evidence.checks.missingTool, 'bash');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-16');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(finalOutcome.cause, 'TOOL_UNAVAILABLE');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('shippingDryRun: node script fails -> ENVIRONMENT_ERROR DEPENDENCY_ENVIRONMENT', async function(t) {
  function failingNode(cb) { cb({ code: 1 }, '', 'failed to parse csv: boom'); }
  var ctx = baseContext({ execFile: makeExecFile(failingNode, passBash, []) });
  var outcome = await executors.handlerShippingDryRun(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-16');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('shippingDryRun: artifacts that differ from the fixture -> EXPECTED_MISMATCH APPLICATION_DEFECT', async function(t) {
  function tamperNode(cb, args, options) {
    try {
      var csvArg = String(args[1] || '');
      var csvPath = csvArg.split('=')[1];
      var d = executors.deriveShippingPlan(fs.readFileSync(csvPath, 'utf8'));
      d.plans[0].totalQuantity = 999; // planted mismatch vs fixture-derived plan
      var dir = path.join(options.env.PROCESS_SHIPPING_ARTIFACT_DIR, '2026-10-07T09-00-00-000Z');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'shipping-plan.json'), JSON.stringify({ rows: d.rows, plans: d.plans, deductionPlan: d.deductionPlan }, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ csvPath: csvPath, commit: false, reconcileStockOnly: false, totalRows: 3, totalOrders: 2, committed: [], stockAdjustments: [], status: 'passed' }, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'summary.txt'), 'CSV: ' + csvPath + '\nCommit: no\nReconcile stock only: no\nOrders: 2\nRows: 3\nCommitted: 0\n', 'utf8');
      cb(null, 'PASS process shipping csv\n');
    } catch (e) {
      cb({ code: 1, message: String((e && e.message) || e) }, '', '');
    }
  }
  var ctx = baseContext({ execFile: makeExecFile(tamperNode, passBash, []) });
  var outcome = await executors.handlerShippingDryRun(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.evidence.checks.outputsMatchPlan === false, 'mismatch recorded');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-16');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Handler: evidence persistence via writeEvidenceFile / writeTaskRecord
// ---------------------------------------------------------------------------

test('shippingDryRun: writes executor evidence + canonical record via writeEvidenceFile/writeTaskRecord', async function(t) {
  var evidenceFiles = [];
  var records = [];
  var ctx = baseContext({
    runId: 'run-x',
    extraDeps: {
      writeEvidenceFile: function(runId, taskId, filename, content, opts) {
        evidenceFiles.push({ runId: runId, taskId: taskId, filename: filename, content: content, opts: opts });
      },
      writeTaskRecord: function(runId, taskId, record, opts) {
        records.push({ runId: runId, taskId: taskId, record: record, opts: opts });
      }
    }
  });
  var outcome = await executors.handlerShippingDryRun(ctx);
  assert.strictEqual(outcome.success, true);

  assert.strictEqual(evidenceFiles.length, 1, 'one executor evidence file written');
  assert.strictEqual(evidenceFiles[0].runId, 'run-x');
  assert.strictEqual(evidenceFiles[0].taskId, 'CAN-B2-16');
  assert.strictEqual(evidenceFiles[0].filename, 'executor-shipping-dryrun.json');
  var parsed = JSON.parse(evidenceFiles[0].content);
  assert.ok(parsed.evidence && parsed.evidence.checks.outputsMatchPlan === true, 'evidence file carries the checks');

  assert.strictEqual(records.length, 1, 'one canonical record written');
  var rec = records[0].record;
  assert.strictEqual(rec.canonicalId, 'CAN-B2-16');
  assert.strictEqual(rec.executionRevision, 'cafebabe1234');
  assert.strictEqual(rec.exactScriptPath, executors.PROCESS_SHIPPING_SCRIPT, 'script task records exactScriptPath');
  assert.strictEqual(rec.finalClassification, RESULT_PASS);
  assert.strictEqual(rec.stateChanges.noApiCall, true);
  assert.strictEqual(rec.stateChanges.noCredentialsForwarded, true);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

test('shippingDryRun: register() registers CAN-B2-16', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.deepStrictEqual(reg.registered, ['CAN-B2-16']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-16'), true);
  assert.strictEqual(typeof executorModule.getTaskExecutor('CAN-B2-16').handler, 'function');
  executorModule.resetTaskExecutors();
});
