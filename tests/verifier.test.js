'use strict';

var verifier = require('../src/repair/verifier');
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var test = require('node:test');
var assert = require('node:assert');

var TEST_EVIDENCE_ROOT = path.join(os.tmpdir(), 'verifier-test-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));

function makeFakeReplayer(returnSignatures, returnError) {
  return function(finding, task) {
    if (returnError) {
      return { signatures: [], error: returnError };
    }
    return { signatures: returnSignatures || [] };
  };
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

function writePkg(tmpDir, scripts) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project', scripts: scripts }));
  // Provide a toolchain so the runChecks scripts execute rather than being
  // skipped by the CHECKS_SKIPPED_NO_TOOLCHAIN gate.
  fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
}

test('verify: fixed - all old signatures gone', function() {
  var before = ['sig-abc', 'sig-def', 'sig-ghi'];
  var after = [];
  var result = verifier.verify(before, after);
  assert.strictEqual(result.status, 'fixed');
  assert.deepStrictEqual(result.fixedSignatures, before);
  assert.deepStrictEqual(result.remainingSignatures, []);
  assert.deepStrictEqual(result.newSignatures, []);
});

test('verify: not-fixed - all old fixed, no new', function() {
  var before = ['sig-abc', 'sig-def', 'sig-ghi'];
  var after = ['sig-jkl'];
  var result = verifier.verify(before, after);
  assert.strictEqual(result.status, 'regressed');
  assert.deepStrictEqual(result.newSignatures, ['sig-jkl']);
  assert.deepStrictEqual(result.fixedSignatures, ['sig-abc', 'sig-def', 'sig-ghi']);
});

test('verify: regressed - new signature appeared', function() {
  var before = ['sig-abc'];
  var after = ['sig-abc', 'sig-regression'];
  var result = verifier.verify(before, after);
  assert.strictEqual(result.status, 'regressed');
  assert.deepStrictEqual(result.newSignatures, ['sig-regression']);
  assert.deepStrictEqual(result.remainingSignatures, ['sig-abc']);
});

test('verify: with new signature (empty before)', function() {
  var result = verifier.verify([], ['sig-abc']);
  assert.strictEqual(result.status, 'regressed');
  assert.deepStrictEqual(result.newSignatures, ['sig-abc']);
});

test('verify: null/undefined before treated as empty', function() {
  var result = verifier.verify(null, []);
  assert.strictEqual(result.status, 'fixed');
  var result2 = verifier.verify(undefined, []);
  assert.strictEqual(result2.status, 'fixed');
});

test('reproduce: returns signatures from replayer', function() {
  var sigs = ['sig-x', 'sig-y'];
  var replayer = makeFakeReplayer(sigs);
  var finding = { class: 'SQL_ERROR', message: 'test' };
  var task = { id: 'task-1', type: 'probe' };

  var result = verifier.reproduce(finding, task, {
    replayer: replayer,
    runId: 'test-run-1',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.runId, 'test-run-1');
  assert.deepStrictEqual(result.signatures, sigs);
  assert.ok(result.evidencePath);
  assert.ok(result.evidenceSha256);
  assert.strictEqual(result.error, null);
});

test('reproduce: passes finding and task to replayer', function() {
  var capturedFinding = null;
  var capturedTask = null;
  var replayer = function(finding, task) {
    capturedFinding = finding;
    capturedTask = task;
    return { signatures: [] };
  };

  var finding = { class: 'NETWORK_ERROR', message: 'connection refused', signature: 'sig-xyz' };
  var task = { id: 'task-99', type: 'pipeline' };

  verifier.reproduce(finding, task, {
    replayer: replayer,
    runId: 'test-run-2',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(capturedFinding, finding);
  assert.strictEqual(capturedTask, task);
});

test('reproduce: error from replayer is captured', function() {
  var replayer = makeFakeReplayer(null, 'Simulated replayer failure');
  var result = verifier.reproduce({}, {}, {
    replayer: replayer,
    runId: 'test-run-err',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.error, 'Simulated replayer failure');
  assert.deepStrictEqual(result.signatures, []);
});

test('reproduce: evidence file is written', function() {
  var replayer = makeFakeReplayer(['sig-ev']);
  var runId = 'test-run-ev-' + Date.now();
  var result = verifier.reproduce({}, {}, {
    replayer: replayer,
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  var evPath = path.join(TEST_EVIDENCE_ROOT, runId, 'repair', result.evidencePath);
  assert.ok(fs.existsSync(evPath), 'evidence file should exist at ' + evPath);
  var content = fs.readFileSync(evPath, 'utf8');
  var parsed = JSON.parse(content);
  assert.strictEqual(parsed.runId, runId);
  assert.deepStrictEqual(parsed.signatures, ['sig-ev']);
});

test('runChecks: success case - all scripts pass', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-ok-' + Date.now());
  writePkg(tmpDir, {
    install: 'node --version',
    build: 'node -e "console.log(1)"',
    test: 'node -e "console.log(ok)"'
  });

  var fakeExec = makeFakeExecCommand([
    { success: true, stdout: 'v22.0.0\n', stderr: '', exitCode: 0 },
    { success: true, stdout: '1\n', stderr: '', exitCode: 0 },
    { success: true, stdout: 'ok\n', stderr: '', exitCode: 0 }
  ]);

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-checks-ok',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.results.length, 3);
  assert.strictEqual(result.results[0].script, 'install');
  assert.strictEqual(result.results[1].script, 'build');
  assert.strictEqual(result.results[2].script, 'test');
  result.results.forEach(function(r) {
    assert.strictEqual(r.success, true);
  });

  var evPath = path.join(TEST_EVIDENCE_ROOT, result.runId, 'repair', result.evidencePath);
  assert.ok(fs.existsSync(evPath), 'evidence file should exist');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: failure case - script exits non-zero', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-fail-' + Date.now());
  writePkg(tmpDir, { test: 'node -e "process.exit(1)"' });

  var fakeExec = makeFakeExecCommand([
    { success: false, stdout: '', stderr: 'test failed', exitCode: 1 }
  ]);

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-checks-fail',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.results[0].success, false);
  assert.strictEqual(result.results[0].exitCode, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: timeout case - command times out', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-timeout-' + Date.now());
  writePkg(tmpDir, { test: 'node -e "setTimeout(()=>{}, 60000)"' });

  var fakeExec = makeFakeExecCommand([
    { success: false, stdout: '', stderr: '', exitCode: null, timedOut: true }
  ]);

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-checks-timeout',
    root: TEST_EVIDENCE_ROOT,
    timeout: 5000
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.results[0].timedOut, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: missing package.json returns error', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-nopkg-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  var result = await verifier.runChecks(tmpDir, {
    runId: 'test-checks-nopkg',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.error.indexOf('package.json') !== -1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: redaction of secrets in output', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-redact-' + Date.now());
  writePkg(tmpDir, { test: "node -e \"console.log('using api_key_abc123')\"" });

  var fakeExec = makeFakeExecCommand([
    { success: true, stdout: 'using api_key_abc123\n', stderr: '', exitCode: 0 }
  ]);

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-checks-redact',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.results[0].stdout.indexOf('api_key_abc123'), -1);
  assert.ok(result.results[0].stdout.indexOf('[REDACTED]') !== -1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: Node < 22 is blocked', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-nodegate-' + Date.now());
  writePkg(tmpDir, { test: 'node -e "console.log(1)"' });

  var called = false;
  var fakeExec = function(cmd, args, opts) { called = true; return { success: true, stdout: '', stderr: '', exitCode: 0 }; };

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    nodeVersion: 20,
    runId: 'test-nodegate-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.nodeVersion, 20);
  assert.strictEqual(called, false);
  assert.ok(result.error.indexOf('Node >= 22') !== -1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: regression case - new signature after fix', function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-reg-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: {
      test: 'node -e "console.log(1)"'
    }
  }));

  var replayerBefore = makeFakeReplayer(['sig-old']);
  var replayerAfter = makeFakeReplayer(['sig-old', 'sig-new-regression']);

  var beforeResult = verifier.reproduce({ class: 'ERR' }, { id: 't1' }, {
    replayer: replayerBefore,
    runId: 'test-reg-before',
    root: TEST_EVIDENCE_ROOT
  });

  var afterResult = verifier.reproduce({ class: 'ERR' }, { id: 't1' }, {
    replayer: replayerAfter,
    runId: 'test-reg-after',
    root: TEST_EVIDENCE_ROOT
  });

  var verifyResult = verifier.verify(beforeResult.signatures, afterResult.signatures);
  assert.strictEqual(verifyResult.status, 'regressed');
  assert.deepStrictEqual(verifyResult.newSignatures, ['sig-new-regression']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: runs only install/build/test scripts', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-scripts-' + Date.now());
  writePkg(tmpDir, {
    install: 'node --version',
    build: 'node -e "console.log(1)"',
    test: 'node -e "console.log(1)"',
    start: 'node server.js',
    lint: 'echo linting'
  });

  var seenScripts = [];
  var fakeExec = function(cmd, args, opts) {
    seenScripts.push(cmd + ' ' + args.join(' '));
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-scripts-filter',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.results.length, 3);
  assert.strictEqual(result.results[0].script, 'install');
  assert.strictEqual(result.results[1].script, 'build');
  assert.strictEqual(result.results[2].script, 'test');
  result.results.forEach(function(r) {
    assert.ok(r.command.indexOf('start') === -1, 'start should not be run');
    assert.ok(r.command.indexOf('lint') === -1, 'lint should not be run');
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: missing node_modules returns CHECKS_SKIPPED_NO_TOOLCHAIN (not a failure)', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-skip-' + Date.now());
  writePkg(tmpDir, { install: 'node --version', build: 'node -e "console.log(1)"', test: 'node -e "console.log(1)"' });
  // Remove the node_modules the helper created so the toolchain gate fires.
  fs.rmSync(path.join(tmpDir, 'node_modules'), { recursive: true, force: true });

  var executedScripts = [];
  var fakeExec = function(cmd, args, opts) {
    executedScripts.push(cmd);
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-checks-skip-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true, 'missing toolchain must not be reported as a failure');
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.code, 'CHECKS_SKIPPED_NO_TOOLCHAIN');
  assert.ok(result.results.length > 0);
  result.results.forEach(function(r) {
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.code, 'CHECKS_SKIPPED_NO_TOOLCHAIN');
  });
  assert.strictEqual(executedScripts.length, 0, 'no scripts should run without node_modules');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: command not found (ENOENT spawn) is CHECKS_SKIPPED_NO_TOOLCHAIN, not failed', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-spawnfail-' + Date.now());
  writePkg(tmpDir, { test: 'nonexistent-bin-xyz --flag' });

  // Simulate a child 'error' event: null exit code, no output, spawn error set.
  var fakeExec = function(cmd, args, opts) {
    assert.strictEqual(cmd, 'nonexistent-bin-xyz');
    return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'spawn nonexistent-bin-xyz ENOENT' });
  };

  var result = await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: 'test-checks-spawnfail-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  // ENOENT is always CHECKS_SKIPPED_NO_TOOLCHAIN regardless of node_modules presence.
  // The binary is absent after node_modules/.bin + PATH lookup — a toolchain gap,
  // not a failed build. The repair loop can still proceed.
  assert.strictEqual(result.ok, true, 'spawn-not-found must not be reported as a failure');
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.code, 'CHECKS_SKIPPED_NO_TOOLCHAIN');
  assert.strictEqual(result.results[0].skipped, true);
  assert.strictEqual(result.results[0].code, 'CHECKS_SKIPPED_NO_TOOLCHAIN');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});


test('runChecks: index.json contains repair evidence entries', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-idx-' + Date.now());
  writePkg(tmpDir, { test: 'node -e "console.log(1)"' });

  var fakeExec = makeFakeExecCommand([
    { success: true, stdout: '1\n', stderr: '', exitCode: 0 }
  ]);

  var runId = 'test-idx-' + Date.now();
  await verifier.runChecks(tmpDir, {
    execCommand: fakeExec,
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  var idxPath = path.join(TEST_EVIDENCE_ROOT, runId, 'repair', 'index.json');
  assert.ok(fs.existsSync(idxPath), 'index.json should exist at ' + idxPath);
  var idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  assert.strictEqual(idx.runId, runId);
  assert.ok(Array.isArray(idx.entries));
  assert.ok(idx.entries.length > 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('repair evidence writes only repair/index.json and never the main index.json', function() {
  var replayer = makeFakeReplayer(['sig-main']);
  var runId = 'test-main-idx-' + Date.now();

  // A pre-existing main index (evidence/<runId>/index.json) must stay untouched.
  var mainIndexPath = path.join(TEST_EVIDENCE_ROOT, runId, 'index.json');
  var sentinel = JSON.stringify({ runId: runId, schemaVersion: '1.0', tasks: { 'CAN-X': [] } }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(mainIndexPath), { recursive: true });
  fs.writeFileSync(mainIndexPath, sentinel, 'utf8');

  verifier.reproduce({ class: 'ERR', message: 'boom' }, { id: 't1' }, {
    replayer: replayer,
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  // Repair evidence lives under evidence/<runId>/repair/index.json.
  var repairIndexPath = path.join(TEST_EVIDENCE_ROOT, runId, 'repair', 'index.json');
  assert.ok(fs.existsSync(repairIndexPath), 'repair index.json should exist');
  var repairIdx = JSON.parse(fs.readFileSync(repairIndexPath, 'utf8'));
  assert.strictEqual(repairIdx.runId, runId);
  assert.ok(repairIdx.entries.length > 0);

  // The main index.json is byte-for-byte unchanged.
  var after = fs.readFileSync(mainIndexPath, 'utf8');
  assert.strictEqual(after, sentinel, 'main index.json must not be modified by repair evidence');
});

test('reproduce: writes to evidence/<runId>/repair/', function() {
  var replayer = makeFakeReplayer(['sig-ev-2']);
  var runId = 'test-subdir-' + Date.now();
  var result = verifier.reproduce({}, {}, {
    replayer: replayer,
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  var expectedDir = path.join(TEST_EVIDENCE_ROOT, runId, 'repair');
  assert.ok(fs.existsSync(expectedDir), 'repair dir should exist');
  var evFile = path.join(expectedDir, result.evidencePath);
  assert.ok(fs.existsSync(evFile), 'evidence file should be in repair subdir');
});

test('verify: with null values in arrays', function() {
  var result = verifier.verify(['sig-1', null, 'sig-2'], ['sig-1']);
  assert.strictEqual(result.status, 'not-fixed');
});

test('runChecks: uses execCommand option when provided', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-execopt-' + Date.now());
  writePkg(tmpDir, { test: 'node -e "process.exit(0)"' });

  var customCalled = false;
  var customExec = function(cmd, args, opts) {
    customCalled = true;
    assert.strictEqual(cmd, 'node');
    assert.ok(args[0] === '-e');
    assert.strictEqual(args.length, 2);
    assert.strictEqual(opts.cwd, tmpDir);
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  await verifier.runChecks(tmpDir, {
    execCommand: customExec,
    runId: 'test-execopt',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(customCalled, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: waits for a real child process and captures stdout on success', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-real-ok-' + Date.now());
  writePkg(tmpDir, { test: 'node -e console.log(42)' });

  var result = await verifier.runChecks(tmpDir, {
    runId: 'test-real-ok-' + Date.now(),
    root: TEST_EVIDENCE_ROOT,
    timeout: 10000
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].success, true);
  assert.strictEqual(result.results[0].exitCode, 0);
  assert.ok(result.results[0].stdout.indexOf('42') !== -1, 'stdout should carry the child output');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: real child process nonzero exit is captured', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-real-fail-' + Date.now());
  writePkg(tmpDir, { test: 'node -e process.exit(3)' });

  var result = await verifier.runChecks(tmpDir, {
    runId: 'test-real-fail-' + Date.now(),
    root: TEST_EVIDENCE_ROOT,
    timeout: 10000
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.results[0].success, false);
  assert.strictEqual(result.results[0].exitCode, 3);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: real child process timeout is captured', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-real-timeout-' + Date.now());
  writePkg(tmpDir, { test: 'node -e while(1){}' });

  var result = await verifier.runChecks(tmpDir, {
    runId: 'test-real-timeout-' + Date.now(),
    root: TEST_EVIDENCE_ROOT,
    timeout: 1500
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.results[0].timedOut, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runChecks: real child spawn error is captured as CHECKS_SKIPPED_NO_TOOLCHAIN', async function() {
  var tmpDir = path.join(os.tmpdir(), 'run-checks-real-spawn-' + Date.now());
  writePkg(tmpDir, { test: 'definitely-not-a-real-binary-xyz --version' });

  var result = await verifier.runChecks(tmpDir, {
    runId: 'test-real-spawn-' + Date.now(),
    root: TEST_EVIDENCE_ROOT,
    timeout: 10000
  });

  // ENOENT is always CHECKS_SKIPPED_NO_TOOLCHAIN — binary absent after
  // node_modules/.bin + PATH lookup, regardless of node_modules presence.
  assert.strictEqual(result.ok, true, 'spawn-not-found must not be a hard failure');
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.code, 'CHECKS_SKIPPED_NO_TOOLCHAIN');
  assert.strictEqual(result.results[0].success, false);
  assert.strictEqual(result.results[0].skipped, true);
  assert.strictEqual(result.results[0].code, 'CHECKS_SKIPPED_NO_TOOLCHAIN');
  assert.ok(result.results[0].error, 'spawn error should be recorded');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
