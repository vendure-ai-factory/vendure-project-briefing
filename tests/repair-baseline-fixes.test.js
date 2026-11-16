'use strict';

// Tests for the baseline-diff repair flow and REPAIR_LOCAL_CHECKS switch
var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

// SUT
var verifier = require('../src/repair/verifier');
var proposeAndCheck = require('../src/repair/proposeAndCheck');
var checkStatus = proposeAndCheck.checkStatus;

var TEST_EVIDENCE_ROOT = path.join(os.tmpdir(), 'repair-fix-test-' + Date.now());

function writePkg(tmpDir, scripts) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project', scripts: scripts }));
  fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
}

function addTscStub(tmpDir) {
  var tscDir = path.join(tmpDir, 'node_modules', 'typescript', 'bin');
  fs.mkdirSync(tscDir, { recursive: true });
  fs.writeFileSync(path.join(tscDir, 'tsc'), '// stub', 'utf8');
}

function makeFakeExecCommand(results) {
  var index = 0;
  return function(cmd, args, opts) {
    if (index < results.length) {
      return results[index++];
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
}

// --- REPAIR_LOCAL_CHECKS=off / SKIPPED_BY_CONFIG ---

test('runChecks: skipByConfig=true => SKIPPED_BY_CONFIG for all checks, ok=true, flow continues', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-skip-' + Date.now());
  writePkg(tmpDir, { build: 'tsc', install: 'npm install', test: 'jest' });
  addTscStub(tmpDir);

  var result = await verifier.runChecks(tmpDir, {
    execCommand: makeFakeExecCommand([]),
    skipByConfig: true,
    runId: 'skip-checks-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true, 'skipByConfig must not block flow (image build is authoritative)');
  assert.strictEqual(result.code, 'SKIPPED_BY_CONFIG');
  assert.strictEqual(result.results.length, 4, 'build, install, test, tsc --noEmit all present');

  var buildRes = result.results.find(function(r) { return r.script === 'build'; });
  assert.ok(buildRes, 'build result exists');
  assert.strictEqual(buildRes.code, 'SKIPPED_BY_CONFIG', 'build must be SKIPPED_BY_CONFIG');
  assert.strictEqual(buildRes.success, true, 'build success=true so flow continues');

  var tscRes = result.results.find(function(r) { return r.script === 'tsc --noEmit'; });
  assert.ok(tscRes, 'tsc --noEmit result exists');
  assert.strictEqual(tscRes.code, 'SKIPPED_BY_CONFIG', 'tsc must be SKIPPED_BY_CONFIG');
  assert.strictEqual(tscRes.success, true, 'tsc success=true so flow continues');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkStatus: SKIPPED_BY_CONFIG returns SKIPPED_BY_CONFIG (never PASS)', function() {
  assert.strictEqual(checkStatus({ code: 'SKIPPED_BY_CONFIG', success: true }), 'SKIPPED_BY_CONFIG');
  assert.strictEqual(checkStatus({ code: 'SKIPPED_BY_CONFIG', success: false }), 'SKIPPED_BY_CONFIG');
  // Other statuses unchanged
  assert.strictEqual(checkStatus({ skipped: true }), 'SKIPPED');
  assert.strictEqual(checkStatus({ success: true }), 'PASS');
  assert.strictEqual(checkStatus({ success: false }), 'FAIL');
  assert.strictEqual(checkStatus({ code: 'INCONCLUSIVE_TOOLCHAIN', success: true }), 'INCONCLUSIVE_TOOLCHAIN');
});

// --- Build script INCONCLUSIVE_TOOLCHAIN when baseline is unreliable ---

test('runChecks: unreliable baseline => INCONCLUSIVE_TOOLCHAIN for BOTH tsc --noEmit AND build script', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-build-' + Date.now());
  writePkg(tmpDir, { build: 'tsc', test: 'node -e "console.log(1)"' });
  addTscStub(tmpDir);

  // When build script is 'tsc' and baseline is unreliable, BOTH checks should be INCONCLUSIVE_TOOLCHAIN
  // Note: fake execCommand is called for [build, test, tsc_noEmit] = 3 calls, need 3 results
  var result = await verifier.runChecks(tmpDir, {
    execCommand: makeFakeExecCommand([
      { success: false, stdout: '', stderr: 'src/c.ts(1,1): error TS2580: Cannot find name \'process\'\n', exitCode: 1 },  // build
      { success: true, stdout: '1\n', stderr: '', exitCode: 0 },  // test (passes)
      { success: false, stdout: '', stderr: 'src/a.ts(1,1): error TS2580: Cannot find name \'process\'\n', exitCode: 1 }  // tsc --noEmit
    ]),
    baselineTscErrors: {
      unreliable: true,
      errors: [
        { file: 'src/c.ts', code: 'TS2580', message: "Cannot find name 'process'" }
      ],
      baselineErrorCount: 1,
      topCodes: ['TS2580']
    },
    runId: 'build-inconclusive-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true, 'unreliable baseline must not block flow');

  var buildRes = result.results.find(function(r) { return r.script === 'build'; });
  assert.ok(buildRes, 'build result exists');
  assert.strictEqual(buildRes.code, 'INCONCLUSIVE_TOOLCHAIN', 'build must be INCONCLUSIVE_TOOLCHAIN when baseline unreliable');
  assert.strictEqual(buildRes.success, true, 'build success=true so flow continues');
  assert.strictEqual(buildRes.baselineUnreliable, true);

  var tscRes = result.results.find(function(r) { return r.script === 'tsc --noEmit'; });
  assert.ok(tscRes, 'tsc --noEmit result exists');
  assert.strictEqual(tscRes.code, 'INCONCLUSIVE_TOOLCHAIN', 'tsc must be INCONCLUSIVE_TOOLCHAIN');
  assert.strictEqual(tscRes.success, true, 'tsc success=true so flow continues');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: unreliable baseline + tsc not available => build still marked INCONCLUSIVE_TOOLCHAIN', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-build-only-' + Date.now());
  writePkg(tmpDir, { build: 'tsc' });
  // NO tsc stub - tscResultIdx will be undefined

  var result = await verifier.runChecks(tmpDir, {
    execCommand: makeFakeExecCommand([
      { success: false, stdout: '', stderr: 'src/a.ts(1,1): error TS2304: Cannot find name \'__dirname\'\n', exitCode: 1 }
    ]),
    baselineTscErrors: {
      unreliable: true,
      errors: [
        { file: 'src/a.ts', code: 'TS2304', message: "Cannot find name '__dirname'" }
      ],
      baselineErrorCount: 1,
      topCodes: ['TS2304']
    },
    runId: 'build-only-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true, 'unreliable baseline must not block flow');

  var buildRes = result.results.find(function(r) { return r.script === 'build'; });
  assert.ok(buildRes, 'build result exists even when tsc --noEmit not available');
  assert.strictEqual(buildRes.code, 'INCONCLUSIVE_TOOLCHAIN', 'build must be INCONCLUSIVE_TOOLCHAIN');
  assert.strictEqual(buildRes.success, true, 'build success=true so flow continues');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Baseline computed once, unreliable flag preserved through proposeAndCheck ---

test('runChecks: baselineTscErrors passed as full object (not just errors array) preserves unreliable flag', async function() {
  var tmpDir = path.join(os.tmpdir(), 'baseline-full-obj-' + Date.now());
  writePkg(tmpDir, { test: 'node -e "console.log(1)"' });
  addTscStub(tmpDir);

  // Pass full baselineTsc object (with unreliable=true) as would happen after fix
  var fullBaselineTsc = {
    ok: true,
    skipped: false,
    errors: [{ file: 'src/c.ts', code: 'TS2307', message: "Cannot find module 'typeorm'" }],
    unreliable: true,
    baselineErrorCount: 1,
    topCodes: ['TS2307']
  };

  var result = await verifier.runChecks(tmpDir, {
    execCommand: makeFakeExecCommand([
      { success: true, stdout: '1\n', stderr: '', exitCode: 0 },
      { success: false, stdout: '', stderr: 'src/c.ts(1,1): error TS2307: Cannot find \'typeorm\'\n', exitCode: 1 }
    ]),
    baselineTscErrors: fullBaselineTsc,
    runId: 'full-obj-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true, 'INCONCLUSIVE_TOOLCHAIN must not block');
  var tscRes = result.results[1];
  assert.strictEqual(tscRes.code, 'INCONCLUSIVE_TOOLCHAIN');
  assert.strictEqual(tscRes.baselineErrorCount, 1, 'baselineErrorCount preserved');
  assert.deepStrictEqual(tscRes.topCodes, ['TS2307'], 'topCodes preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

console.log('Repair-fixes tests loaded');
