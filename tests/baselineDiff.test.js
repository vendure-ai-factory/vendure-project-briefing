'use strict';

/**
 * Regression tests for the baseline-diff compile check and the re-ask crash
 * guards in proposeAndCheck:
 *  (a) baseline tsc errors present and unchanged -> check passes (pre-existing
 *      errors never mark a proposal as CHECKS_FAILED);
 *  (b) a NEW error introduced by the proposal -> check fails with only the new
 *      error (baseline errors are excluded from the failure output);
 *  (c) check-result objects without stderr/stdout in the re-ask path -> no
 *      exception (missing stdout/stderr treated as empty strings);
 *  (d) baseline run cannot execute -> the check is SKIPPED, never failed.
 */

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');
var os = require('node:os');
var crypto = require('node:crypto');

var verifier = require('../src/repair/verifier');
var proposeAndCheck = require('../src/repair/proposeAndCheck');

var TEST_EVIDENCE_ROOT = path.join(os.tmpdir(), 'baseline-diff-test-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));

// --- Helpers ---------------------------------------------------------------

function writePkgScripts(tmpDir, scripts) {
  require('fs').mkdirSync(path.join(tmpDir, 'node_modules', '.bin'), { recursive: true });
  require('fs').writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', scripts: scripts || {} }));
  // Provide a toolchain so runChecks executes scripts instead of skipping.
  require('fs').mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
  // Placeholder tsc binary so runChecks pushes a tsc result (exec is faked).
  require('fs').writeFileSync(path.join(tmpDir, 'node_modules', '.bin', 'tsc'), '#!/usr/bin/env node\n', 'utf8');
}

function makeFakeExecCommand(results) {
  var index = 0;
  return function(cmd, args, opts) {
    if (index < results.length) {
      return Promise.resolve(results[index++]);
    }
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
}

var TSC_ERR_LINE = function(file, code, msg) {
  return file + '(1,1): error ' + code + ': ' + msg;
};

// --- (a) baseline errors present and unchanged -> check passes -------------

test('baseline-diff: pre-existing tsc errors unchanged => check passes', async function() {
  var tmpDir = path.join(os.tmpdir(), 'baseline-a-' + Date.now());
  writePkgScripts(tmpDir, {});

  var baselineErrors = [
    { file: 'src/a.ts', code: 'TS2580', message: "Cannot find name 'process'" },
    { file: 'src/b.ts', code: 'TS2307', message: "Cannot find module 'typeorm'" }
  ];
  var stderr = [
    TSC_ERR_LINE('src/a.ts', 'TS2580', "Cannot find name 'process'"),
    TSC_ERR_LINE('src/b.ts', 'TS2307', "Cannot find module 'typeorm'"),
    ''
  ].join('\n');

  var result = await verifier.runChecks(tmpDir, {
    execCommand: makeFakeExecCommand([
      { success: false, stdout: '', stderr: stderr, exitCode: 1 }
    ]),
    baselineTscErrors: baselineErrors,
    runId: 'baseline-a-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  // tsc failed with only pre-existing errors -> check passes (ok true)
  assert.strictEqual(result.results[0].success, true, 'pre-existing tsc errors must not fail the check');
  assert.strictEqual(result.ok, true, 'runChecks should be ok when only baseline errors present');

  require('fs').rmSync(tmpDir, { recursive: true, force: true });
});

// --- (b) new error from proposal -> fail with only new error ----------------

test('baseline-diff: new error from proposal => fail with only the new error', async function() {
  var tmpDir = path.join(os.tmpdir(), 'baseline-b-' + Date.now());
  writePkgScripts(tmpDir, {});

  var baselineErrors = [
    { file: 'src/a.ts', code: 'TS2580', message: "Cannot find name 'process'" }
  ];
  var stderr = [
    TSC_ERR_LINE('src/a.ts', 'TS2580', "Cannot find name 'process'"),
    TSC_ERR_LINE('src/c.ts', 'TS2353', "Object literal may only specify known properties"),
    ''
  ].join('\n');

  var result = await verifier.runChecks(tmpDir, {
    execCommand: makeFakeExecCommand([
      { success: false, stdout: '', stderr: stderr, exitCode: 1 }
    ]),
    baselineTscErrors: baselineErrors,
    runId: 'baseline-b-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false, 'a new tsc error should fail the check');
  var tscRes = result.results[0];
  assert.strictEqual(tscRes.newErrors.length, 1, 'only the NEW error should be reported');
  assert.strictEqual(tscRes.newErrors[0].code, 'TS2353', 'the new error TS2353 should be reported');
  // The failure output must not contain the baseline TS2580 error.
  assert.strictEqual(tscRes.stderr.indexOf('TS2580'), -1, 'baseline error must be excluded from failure output');
  assert.ok(tscRes.stderr.indexOf('TS2353') !== -1, 'new error must be in failure output');

  require('fs').rmSync(tmpDir, { recursive: true, force: true });
});

// --- (d) baseline cannot execute -> check skipped ---------------------------

test('baseline-diff: baseline run cannot execute => check skipped, never failed', async function() {
  // runTscBaseline with an execCommand that always errors (spawn failure).
  var tmpDir = path.join(os.tmpdir(), 'baseline-d-' + Date.now());
  require('fs').mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });

  var baseline = await verifier.runTscBaseline(tmpDir, {
    execCommand: function(cmd, args, opts) {
      return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: null, error: 'spawn ENOENT', timedOut: false, signal: null });
    },
    timeout: 1000
  });

  assert.strictEqual(baseline.skipped, true, 'unexecutable baseline should be skipped');
  assert.deepStrictEqual(baseline.errors, [], 'skipped baseline has empty errors');
});

// --- (c) check-result objects without stderr/stdout in re-ask path ----------

test('baseline-diff: formatPreviousAttempts tolerates results missing stderr/stdout', function() {
  // Build an attempt whose checks.results entries have no stdout/stderr at all
  // and run it through the proposeAndCheck prompt formatter - it must not
  // throw and must produce usable text.
  var previousAttempts = [
    {
      n: 1,
      signature: 'sig-1',
      domain: 'target-code',
      rejectionCodes: ['CHECKS_FAILED'],
      checks: {
        results: [
          { script: 'build', success: false },
          { script: 'tsc --noEmit', success: false, exitCode: 1 }
        ]
      },
      errors: ['checks failed']
    }
  ];

  var output = null;
  var threw = false;
  try {
    output = proposeAndCheck.formatPreviousAttempts(previousAttempts);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'formatPreviousAttempts must not throw on missing stdout/stderr');
  assert.ok(typeof output === 'string' && output.length > 0, 'formatter should still produce text');

  // Even an entirely empty/malformed attempt array must not throw.
  var output2 = null;
  try {
    output2 = proposeAndCheck.formatPreviousAttempts([null, {}, { checks: { results: [null, undefined] } }]);
  } catch (e) {
    assert.fail('formatPreviousAttempts must tolerate null attempts: ' + e.message);
  }
  assert.ok(typeof output2 === 'string', 'formatter output should be a string');
});
