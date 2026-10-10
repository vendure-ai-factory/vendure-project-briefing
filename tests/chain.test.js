'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');

var cliModule = require('../src/cli');
var chainModule = require('../src/chain');
var integrityModule = require('../src/integrity');
var executorModule = require('../src/executor');
var terminalState = require('../src/terminalState');

var RESULT_PASS = terminalState.RESULT_PASS;
var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;

// Teardown: reset the module-level task-executor registry so tests never leak.
var afterEach = require('node:test').afterEach;
afterEach(function() {
  executorModule.resetTaskExecutors();
});

var MANIFEST_PATH = path.join(__dirname, '..', 'manifest', 'acceptance-manifest.v0.4.json');

function fakeOkFetch(url, opts) {
  return Promise.resolve({
    status: 200,
    text: function() { return Promise.resolve(JSON.stringify({ status: 'ok' })); }
  });
}

function makeSyntheticManifest(tasks, rows) {
  var manifest = {
    schemaVersion: '1.0',
    manifestVersion: '0.4',
    source: {},
    tasks: tasks,
    chains: { rows: rows || [], chainG: {} },
    integrity: {}
  };
  manifest.integrity.expectedValuesHash = integrityModule.computeExpectedValuesHash(manifest);
  return manifest;
}

function writeTmpManifest(manifest) {
  var tmpPath = path.join(os.tmpdir(), 'chain-manifest-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6) + '.json');
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  return tmpPath;
}

function makeTask(canonicalId, expectedResult) {
  return {
    canonicalId: canonicalId,
    batch: 'A',
    title: 'chain task ' + canonicalId,
    origin: 'client-batch',
    mappingType: 'direct',
    expectedResult: expectedResult,
    summaryIds: [],
    specIds: [],
    requiredInputs: [],
    status: 'READY',
    mandatoryAssertions: []
  };
}

function realWriteDeps(evidenceRoot, runId, extra) {
  var d = {
    console: { error: function() {}, log: function() {} },
    exit: function() {},
    getEnv: function() { return {}; },
    mkdirSync: function(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); },
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    config: { evidenceRoot: evidenceRoot },
    runId: runId,
    fetch: fakeOkFetch,
    sleep: function() { return Promise.resolve(); }
  };
  if (extra) Object.assign(d, extra);
  return d;
}

function evidenceRunDir(evidenceRoot, runId) {
  return path.join(evidenceRoot, 'evidence', runId);
}

function listEvidenceTaskDirs(evidenceRoot, runId) {
  var runDir = evidenceRunDir(evidenceRoot, runId);
  if (!fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir, { withFileTypes: true })
    .filter(function(e) { return e.isDirectory(); })
    .map(function(e) { return e.name; });
}

function startFakeServer(payload) {
  var server = http.createServer(function(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port });
    });
  });
}

// ---------------------------------------------------------------------------
// chain.js unit tests
// ---------------------------------------------------------------------------

test('chain: normalizeCode and isValidChainCode accept A|B|C|DF|BE|G case-insensitively', function(t) {
  ['A', 'B', 'C', 'DF', 'BE', 'G', 'a', 'df', 'be', 'g'].forEach(function(code) {
    assert.strictEqual(chainModule.isValidChainCode(code), true, code + ' valid');
  });
  ['X', 'AB', '', 'D', 'BEF'].forEach(function(code) {
    assert.strictEqual(chainModule.isValidChainCode(code), false, code + ' invalid');
  });
  assert.strictEqual(chainModule.normalizeCode('df'), 'DF');
  assert.strictEqual(chainModule.normalizeCode('BE'), 'BE');
});

test('chain: resolveChain maps every code to the manifest chains table', function(t) {
  var manifest = require('../manifest/acceptance-manifest.v0.4.json');
  var expected = {
    A: ['CAN-B1-02'],
    B: ['CAN-B2-01', 'CAN-B2-06', 'CAN-B2-04', 'CAN-B2-12'],
    C: ['CAN-B2-02', 'CAN-B2-03', 'CAN-B2-04', 'CAN-B2-07', 'CAN-B2-08', 'CAN-B2-09'],
    DF: ['CAN-B2-10', 'CAN-B2-13', 'CAN-B2-14', 'CAN-B2-08'],
    BE: ['CAN-B2-04', 'CAN-B2-11', 'CAN-B2-12'],
    G: ['CAN-B2-09', 'CAN-B2-11', 'CAN-B2-15']
  };
  ['A', 'B', 'C', 'DF', 'BE', 'G'].forEach(function(code) {
    var r = chainModule.resolveChain(manifest, code);
    assert.strictEqual(r.error, undefined, code + ' has no error');
    assert.strictEqual(r.chainId, code, code + ' chainId');
    assert.deepStrictEqual(r.canonicalIds, expected[code], code + ' canonicalIds');
  });
});

test('chain: resolveChain rejects unknown and missing chains', function(t) {
  var manifest = require('../manifest/acceptance-manifest.v0.4.json');
  assert.ok(chainModule.resolveChain(manifest, 'Z').error);
  var bare = { chains: { rows: [], chainG: {} } };
  assert.ok(chainModule.resolveChain(bare, 'A').error, 'chain A not defined -> error');
  assert.ok(chainModule.resolveChain(bare, 'G').error, 'chain G not defined -> error');
});

test('chain: aggregateChain PASS only when every task has coverage full and result PASS', function(t) {
  var chain = { chainId: 'A' };
  var all = [
    { taskId: 'CAN-1', result: RESULT_PASS, classification: null, cause: null, coverage: 'full', exitCode: 0 },
    { taskId: 'CAN-2', result: RESULT_PASS, classification: null, cause: null, coverage: 'full', exitCode: 0 }
  ];
  var passed = chainModule.aggregateChain(chain, all);
  assert.strictEqual(passed.result, RESULT_PASS);
  assert.strictEqual(passed.coverage, 'full');

  var oneReadiness = [
    { taskId: 'CAN-1', result: RESULT_PASS, classification: null, cause: null, coverage: 'full', exitCode: 0 },
    { taskId: 'CAN-2', result: RESULT_READINESS_PASS, classification: null, cause: null, coverage: 'readiness-subset', exitCode: 0 }
  ];
  var notPass = chainModule.aggregateChain(chain, oneReadiness);
  assert.notStrictEqual(notPass.result, RESULT_PASS);
  assert.strictEqual(notPass.worstTaskId, 'CAN-2');
  assert.strictEqual(notPass.coverage, 'partial');

  var worstBlock = [
    { taskId: 'CAN-1', result: 'BLOCK', classification: 'PIPELINE_DEFECT', cause: 'NOT_IMPLEMENTED', coverage: 'full', exitCode: 3 },
    { taskId: 'CAN-2', result: 'BLOCK', classification: 'SAFETY_AUTHORIZATION', cause: 'FORBIDDEN', coverage: 'full', exitCode: 7 }
  ];
  var worst = chainModule.aggregateChain(chain, worstBlock);
  assert.strictEqual(worst.worstTaskId, 'CAN-2');
  assert.strictEqual(worst.classification, 'SAFETY_AUTHORIZATION');
  assert.ok(worst.reason.indexOf('CAN-2') !== -1);
});

// ---------------------------------------------------------------------------
// parseArgs / usage
// ---------------------------------------------------------------------------

test('cli: parseArgs accepts --chain and rejects --chain with --task', function(t) {
  var ok = cliModule.parseArgs(['run', '--manifest', MANIFEST_PATH, '--chain', 'BE']);
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(ok.chain, 'BE');
  assert.strictEqual(ok.task, null);

  var both = cliModule.parseArgs(['run', '--manifest', MANIFEST_PATH, '--chain', 'A', '--task', 'CAN-B1-02']);
  assert.ok(both.error && both.error.indexOf('both') !== -1);

  var invalid = cliModule.parseArgs(['run', '--manifest', MANIFEST_PATH, '--chain', 'X']);
  assert.ok(invalid.error && invalid.error.indexOf('Invalid --chain') !== -1);

  var missing = cliModule.parseArgs(['run', '--manifest', MANIFEST_PATH]);
  assert.ok(missing.error, 'missing --task and --chain -> error');
});

// ---------------------------------------------------------------------------
// Integration: run --chain through the existing run flow with fake executors
// ---------------------------------------------------------------------------

test('chain runner: all tasks pass -> chain PASS, one evidence folder per task, chain-B.json summary', async function(t) {
  var server = await startFakeServer({ value: 'expected-1' });
  try {
    executorModule.registerTaskExecutor('CAN-CH-P1', {
      description: 'fake executor reading a local http server',
      handler: async function(ctx) {
        var res = await fetch('http://127.0.0.1:' + server.port + '/data');
        var body = await res.text();
        return { success: true, actual: 'expected-1', evidence: { httpStatus: res.status, body: body } };
      }
    });
    executorModule.registerTaskExecutor('CAN-CH-P2', {
      description: 'fake passing executor',
      handler: function() { return { success: true, actual: 'expected-2', evidence: { ok: true } }; }
    });

    var manifest = makeSyntheticManifest(
      [makeTask('CAN-CH-P1', 'expected-1'), makeTask('CAN-CH-P2', 'expected-2')],
      [{ summaryChain: 1, specChainsRaw: 'B', specChains: ['B'], mappingTypeSource: 'direct', canonicalIds: ['CAN-CH-P1', 'CAN-CH-P2'], tasksRaw: 'CAN-CH-P1, CAN-CH-P2', includesAllRegressionTargets: false }]
    );
    var tmpPath = writeTmpManifest(manifest);
    var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-ev-pass-'));
    var runId = 'chain-pass-' + Date.now();
    var written = [];

    var result = await cliModule.runAsync(['node', 'bin/pipeline.js', 'run', '--manifest', tmpPath, '--chain', 'B'], realWriteDeps(evidenceRoot, runId, {
      writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); written.push(p); }
    }));

    assert.strictEqual(result.exitCode, 0, 'all pass -> exit 0');
    assert.strictEqual(result.result.result, RESULT_PASS);
    assert.strictEqual(result.result.coverage, 'full');
    assert.strictEqual(result.tasks.length, 2);

    // One evidence folder per task in the evidence tree.
    var dirs = listEvidenceTaskDirs(evidenceRoot, runId);
    assert.strictEqual(dirs.indexOf('CAN-CH-P1') !== -1, true, 'CAN-CH-P1 evidence folder');
    assert.strictEqual(dirs.indexOf('CAN-CH-P2') !== -1, true, 'CAN-CH-P2 evidence folder');
    assert.strictEqual(fs.existsSync(path.join(evidenceRunDir(evidenceRoot, runId), 'CAN-CH-P1', 'record.json')), true);
    assert.strictEqual(fs.existsSync(path.join(evidenceRunDir(evidenceRoot, runId), 'CAN-CH-P2', 'record.json')), true);

    // Chain summary at reports/<runId>/chain-B.json
    var chainFile = path.join(result.outDir, 'chain-B.json');
    assert.strictEqual(fs.existsSync(chainFile), true, 'chain-B.json written');
    var summary = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
    assert.strictEqual(summary.chainId, 'B');
    assert.strictEqual(summary.result, RESULT_PASS);
    assert.strictEqual(summary.coverage, 'full');
    assert.strictEqual(summary.totalTasks, 2);
    assert.strictEqual(summary.executedTasks, 2);
    assert.strictEqual(summary.stopped, false);
    assert.strictEqual(summary.tasks.length, 2);
    assert.ok(written.some(function(p) { return p.indexOf('chain-B.json') !== -1; }), 'chain summary written via reports outDir');

    fs.unlinkSync(tmpPath);
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  } finally {
    await new Promise(function(resolve) { server.server.close(resolve); });
  }
});

test('chain runner: a blocking task (DEPENDENCY_ENVIRONMENT) does not stop the chain; later task still runs', async function(t) {
  executorModule.registerTaskExecutor('CAN-CH-O1', {
    description: 'fake passing executor',
    handler: function() { return { success: true, actual: 'expected-1', evidence: { ok: true } }; }
  });
  executorModule.registerTaskExecutor('CAN-CH-O2', {
    description: 'fake blocking executor (env down)',
    handler: function() { return { success: false, errorCode: 'ENVIRONMENT_ERROR', error: 'fake dependency down' }; }
  });
  executorModule.registerTaskExecutor('CAN-CH-O3', {
    description: 'fake passing executor',
    handler: function() { return { success: true, actual: 'expected-3', evidence: { ok: true } }; }
  });

  var manifest = makeSyntheticManifest(
    [makeTask('CAN-CH-O1', 'expected-1'), makeTask('CAN-CH-O2', 'expected-2'), makeTask('CAN-CH-O3', 'expected-3')],
    [{ summaryChain: 1, specChainsRaw: 'C', specChains: ['C'], mappingTypeSource: 'direct', canonicalIds: ['CAN-CH-O1', 'CAN-CH-O2', 'CAN-CH-O3'], tasksRaw: 'O1,O2,O3', includesAllRegressionTargets: false }]
  );
  var tmpPath = writeTmpManifest(manifest);
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-ev-block-'));
  var runId = 'chain-block-' + Date.now();

  var result = await cliModule.runAsync(['node', 'bin/pipeline.js', 'run', '--manifest', tmpPath, '--chain', 'C'], realWriteDeps(evidenceRoot, runId));

  // Chain must continue past the DEPENDENCY_ENVIRONMENT block: all 3 executed.
  assert.strictEqual(result.tasks.length, 3, 'all tasks executed past a dependency block');
  assert.strictEqual(result.result.worstTaskId, 'CAN-CH-O2');
  assert.strictEqual(result.result.classification, 'DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(result.exitCode, 6, 'worst classification exits 6');
  var dirs = listEvidenceTaskDirs(evidenceRoot, runId);
  assert.strictEqual(dirs.indexOf('CAN-CH-O3') !== -1, true, 'later task still ran and wrote evidence');

  var summary = JSON.parse(fs.readFileSync(path.join(result.outDir, 'chain-C.json'), 'utf8'));
  assert.strictEqual(summary.stopped, false);
  assert.strictEqual(summary.executedTasks, 3);
  assert.strictEqual(summary.result, 'BLOCK');
  assert.strictEqual(summary.classification, 'DEPENDENCY_ENVIRONMENT');

  fs.unlinkSync(tmpPath);
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('chain runner: a not-implemented task (no executor) continues past PIPELINE_DEFECT', async function(t) {
  executorModule.registerTaskExecutor('CAN-CH-N1', {
    description: 'fake passing executor',
    handler: function() { return { success: true, actual: 'expected-1', evidence: { ok: true } }; }
  });
  // CAN-CH-N2 intentionally has NO executor -> NOT_IMPLEMENTED.
  executorModule.registerTaskExecutor('CAN-CH-N3', {
    description: 'fake passing executor',
    handler: function() { return { success: true, actual: 'expected-3', evidence: { ok: true } }; }
  });

  var manifest = makeSyntheticManifest(
    [makeTask('CAN-CH-N1', 'expected-1'), makeTask('CAN-CH-N2', 'expected-2'), makeTask('CAN-CH-N3', 'expected-3')],
    [{ summaryChain: 1, specChainsRaw: 'DF', specChains: ['D', 'F'], mappingTypeSource: 'merge', canonicalIds: ['CAN-CH-N1', 'CAN-CH-N2', 'CAN-CH-N3'], tasksRaw: 'N1,N2,N3', includesAllRegressionTargets: false }]
  );
  var tmpPath = writeTmpManifest(manifest);
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-ev-ni-'));
  var runId = 'chain-ni-' + Date.now();

  var result = await cliModule.runAsync(['node', 'bin/pipeline.js', 'run', '--manifest', tmpPath, '--chain', 'DF'], realWriteDeps(evidenceRoot, runId));

  assert.strictEqual(result.tasks.length, 3, 'chain continues past NOT_IMPLEMENTED');
  var ni = null;
  for (var i = 0; i < result.tasks.length; i++) {
    if (result.tasks[i].taskId === 'CAN-CH-N2') {
      ni = result.tasks[i];
      break;
    }
  }
  assert.ok(ni, 'NOT_IMPLEMENTED task recorded');
  assert.strictEqual(ni.result, 'BLOCK');
  assert.strictEqual(ni.classification, 'PIPELINE_DEFECT');
  assert.strictEqual(ni.cause, 'NOT_IMPLEMENTED');
  var summary = JSON.parse(fs.readFileSync(path.join(result.outDir, 'chain-DF.json'), 'utf8'));
  assert.strictEqual(summary.stopped, false);
  assert.strictEqual(summary.executedTasks, 3);
  assert.strictEqual(summary.result, 'BLOCK');
  assert.strictEqual(summary.classification, 'PIPELINE_DEFECT');
  assert.strictEqual(result.exitCode, 3);

  fs.unlinkSync(tmpPath);
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('chain runner: SAFETY_AUTHORIZATION stops the chain and later tasks are skipped', async function(t) {
  executorModule.registerTaskExecutor('CAN-CH-S1', {
    description: 'fake passing executor',
    handler: function() { return { success: true, actual: 'expected-1', evidence: { ok: true } }; }
  });
  executorModule.registerTaskExecutor('CAN-CH-S2', {
    description: 'fake forbidden executor',
    handler: function() { return { success: false, errorCode: 'FORBIDDEN', error: 'operation not authorized' }; }
  });
  executorModule.registerTaskExecutor('CAN-CH-S3', {
    description: 'fake passing executor that must never run',
    handler: function() {
      throw new Error('CAN-CH-S3 must not run after a safety stop');
    }
  });

  var manifest = makeSyntheticManifest(
    [makeTask('CAN-CH-S1', 'expected-1'), makeTask('CAN-CH-S2', 'expected-2'), makeTask('CAN-CH-S3', 'expected-3')],
    [{ summaryChain: 1, specChainsRaw: 'G', specChains: ['G'], mappingTypeSource: 'added Chain G', canonicalIds: ['CAN-CH-S1', 'CAN-CH-S2', 'CAN-CH-S3'], tasksRaw: 'S1,S2,S3', includesAllRegressionTargets: false }]
  );
  var tmpPath = writeTmpManifest(manifest);
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-ev-safety-'));
  var runId = 'chain-safety-' + Date.now();

  var result = await cliModule.runAsync(['node', 'bin/pipeline.js', 'run', '--manifest', tmpPath, '--chain', 'G'], realWriteDeps(evidenceRoot, runId));

  assert.strictEqual(result.tasks.length, 2, 'stopped after the SAFETY_AUTHORIZATION task');
  assert.strictEqual(result.result.worstTaskId, 'CAN-CH-S2');
  assert.strictEqual(result.result.classification, 'SAFETY_AUTHORIZATION');
  assert.strictEqual(result.exitCode, 7);

  var summary = JSON.parse(fs.readFileSync(path.join(result.outDir, 'chain-G.json'), 'utf8'));
  assert.strictEqual(summary.stopped, true);
  assert.strictEqual(summary.executedTasks, 2);
  assert.deepStrictEqual(summary.skippedTaskIds, ['CAN-CH-S3']);
  assert.strictEqual(summary.result, 'BLOCK');
  assert.strictEqual(summary.classification, 'SAFETY_AUTHORIZATION');
  assert.ok(summary.stopReason.indexOf('SAFETY_AUTHORIZATION') !== -1);

  // Later task never wrote an evidence folder.
  var dirs = listEvidenceTaskDirs(evidenceRoot, runId);
  assert.strictEqual(dirs.indexOf('CAN-CH-S3') === -1, true, 'skipped task has no evidence folder');

  fs.unlinkSync(tmpPath);
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
