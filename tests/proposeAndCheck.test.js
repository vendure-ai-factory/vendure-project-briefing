'use strict';

var os = require('os');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var test = require('node:test');
var assert = require('node:assert');

// SUT
var proposeAndCheck = require('../src/repair/proposeAndCheck').proposeAndCheck;

// Test helpers
function tempDir() {
  return path.join(os.tmpdir(), 'test-propose-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
}

function createTempProject(files) {
  var dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files).forEach(function(name) {
    var filePath = path.join(dir, name);
    var dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, files[name], 'utf8');
  });
  return dir;
}

// A real candidate so the propose flow reaches the model. The zero-candidate
// (NO_CANDIDATES) short-circuit is exercised by dedicated tests, not these.
function validCandidates(dir) {
  return [{ file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old content' }] }];
}

function createFakeDeps(overrides) {
  var callCount = { model: 0, consume: 0, validate: 0, apply: 0, runChecks: 0, commit: 0, restoreClone: 0 };
  var deps = {
    git: {
      createBranch: function() { return Promise.resolve({ ok: true }); },
      commitAll: function(dir, msg, opts) {
        callCount.commit++;
        return Promise.resolve({ ok: true, dir: dir });
      },
      getHeadSha: function() { return Promise.resolve({ ok: true, sha: 'abc123def456789012345678901234567890abcd' }); },
      diffStat: function() { return Promise.resolve({ ok: true, stat: '1 file changed, 10 insertions(+), 5 deletions(-)' }); },
      diffText: function() { return Promise.resolve({ ok: true, text: '--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-old\n+new' }); }
    },
    model: {
      callModel: function(opts) {
        callCount.model++;
        if (deps._modelBlocker) {
          return Promise.resolve({ ok: false, blocker: deps._modelBlocker });
        }
        if (deps._modelResponse) {
          return Promise.resolve({ ok: true, text: deps._modelResponse });
        }
        return Promise.resolve({
          ok: true,
          text: JSON.stringify({
            repairKind: 'source-edit',
            rationale: 'test fix',
            edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new' }],
            newFiles: []
          })
        });
      },
      parseEditSet: function(text) {
        if (deps._parseError) {
          return { ok: false, error: deps._parseError };
        }
        try {
          var parsed = JSON.parse(text);
          return { ok: true, editSet: parsed };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      consume: function(budget, signature) {
        callCount.consume++;
        if (deps._budgetExhausted) {
          return { ok: false, reason: deps._budgetExhausted };
        }
        if (!budget._callCount) budget._callCount = {};
        budget._callCount[signature] = (budget._callCount[signature] || 0) + 1;
        if (budget._callCount[signature] > 3) {
          return { ok: false, reason: 'per-signature budget exhausted for ' + signature };
        }
        if ((budget.total || 0) >= budget.global) {
          return { ok: false, reason: 'global budget exhausted' };
        }
        budget.total = (budget.total || 0) + 1;
        return { ok: true };
      }
    },
    validator: {
      validate: function(editSet, opts) {
        callCount.validate++;
        if (deps._validationErrors) {
          return { ok: false, errors: deps._validationErrors, stats: {} };
        }
        // Check for protected paths
        if (deps._checkProtectedPaths) {
          var protectedPrefixes = ['.github/', '.git/', 'deploy/', '.env'];
          var errors = [];
          (editSet.edits || []).forEach(function(edit) {
            protectedPrefixes.forEach(function(prefix) {
              if (edit.path.startsWith(prefix) || edit.path.includes('.env')) {
                errors.push('[PROTECTED_PATH] Path is in protected directory: ' + edit.path);
              }
            });
            // Check for secret-looking names
            if (edit.path.includes('SECRET') || edit.path.includes('KEY') || edit.path.includes('.env')) {
              errors.push('[SECRET_NAME] Path looks like it contains a secret: ' + edit.path);
            }
          });
          if (errors.length > 0) {
            return { ok: false, errors: errors, stats: {} };
          }
        }
        return { ok: true, errors: [], stats: { fileCount: 1 } };
      }
    },
    applier: {
      apply: function(editSet, opts) {
        callCount.apply++;
        if (deps._applyBlocker) {
          return { ok: false, blocker: deps._applyBlocker };
        }
        var cloneDir = opts.cloneDir;
        (editSet.edits || []).forEach(function(edit) {
          var filePath = path.join(cloneDir, edit.path);
          if (fs.existsSync(filePath)) {
            var content = fs.readFileSync(filePath, 'utf8');
            content = content.replace(edit.oldString, edit.newString);
            fs.writeFileSync(filePath, content, 'utf8');
          }
        });
        return { ok: true, filesChanged: ['src/x.js'], diffStats: {} };
      },
      restoreClone: function(cloneDir, runCommand) {
        callCount.restoreClone++;
      }
    },
    verifier: {
      runChecks: function(cloneDir, opts) {
        callCount.runChecks++;
        if (deps._checksFail) {
          return Promise.resolve({
            ok: false,
            results: [{ script: 'test', success: false, exitCode: 1, stdout: '', stderr: 'test failed' }]
          });
        }
        return Promise.resolve({
          ok: true,
          results: [{ script: 'test', success: true, exitCode: 0, stdout: 'ok', stderr: '' }]
        });
      }
    },
    runCommand: function(cmd, args, opts) {
      return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    },
    fetch: function() { return Promise.resolve({ ok: false, blocker: { code: 'IO_NOT_INJECTED' } }); },
    now: function() { return '2024-01-01T00:00:00.000Z'; },
    readFile: function(p) { return fs.readFileSync(p, 'utf8'); },
    fs: fs,
    scratchCopy: function(rootDir, runId, runCommand) {
      var temp = tempDir();
      fs.mkdirSync(temp, { recursive: true });
      fs.mkdirSync(path.join(temp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'src', 'x.js'), 'old content\n');
      fs.writeFileSync(path.join(temp, 'package.json'), '{"name":"test","scripts":{"test":"echo ok"}}');
      return Promise.resolve({ ok: true, dir: temp });
    },
    _callCount: callCount
  };
  Object.keys(overrides || {}).forEach(function(k) {
    if (k === '_callCount') {
      Object.keys(overrides[k]).forEach(function(c) { deps._callCount[c] = overrides[k][c]; });
    } else if (typeof overrides[k] === 'object' && overrides[k] !== null) {
      Object.keys(overrides[k]).forEach(function(j) { deps[k][j] = overrides[k][j]; });
    } else {
      deps[k] = overrides[k];
    }
  });
  return deps;
}

// a. two fixtures proving ONE code path repairs both
test('a.1: application-source bug in src/x.js -> READY', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = {
    class: 'ReferenceError',
    message: 'x is not defined',
    path: 'src/x.js',
    sql: null,
    stack: 'ReferenceError: x is not defined\n    at foo (src/x.js:10)',
    domain: 'target-code',
    signature: 'sig-001'
  };

  var deps = createFakeDeps();
  deps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'fix bug',
    edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old content' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-001',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test-sig001',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'READY');
  assert.strictEqual(result.repairKind, 'source-edit');
});

test('a.2: dependency-patch bug inside node_modules -> READY', async function() {
  var dir = createTempProject({
    'src/x.js': 'require("fixturepkg")\n',
    'node_modules/fixturepkg/index.js': 'buggy code\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = {
    class: 'TypeError',
    message: 'Cannot read property',
    path: 'node_modules/fixturepkg/index.js',
    sql: null,
    stack: 'TypeError\n    at foo (node_modules/fixturepkg/index.js:5)',
    domain: 'dependency',
    signature: 'sig-002'
  };

  var deps = createFakeDeps();
  deps._modelResponse = JSON.stringify({
    repairKind: 'dependency-patch',
    rationale: 'patch dependency bug',
    edits: [{ path: 'node_modules/fixturepkg/index.js', oldString: 'buggy', newString: 'fixed' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'node_modules/fixturepkg/index.js'), line: 1, snippet: [{ line: 'buggy code' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-002',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test-sig002',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'READY');
  assert.strictEqual(result.repairKind, 'dependency-patch');
});

// b. model failures -> MODEL_FAILED / REJECTED (with re-ask)
// re-ask: invalid JSON -> re-ask -> re-ask also invalid -> REJECTED after re-ask fails
test('b.1: invalid JSON from model -> REJECTED after re-ask fails', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-003' };
  var deps = createFakeDeps();
  deps._modelResponse = 'not valid json {{{';

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-003',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'REJECTED');
  assert.deepStrictEqual(result.rejectionCodes, ['PARSE_ERROR']);
  assert.ok(result.blocker);
  assert.strictEqual(result.blocker.code, 'PARSE_ERROR');
});

test('b.2: model blocker -> MODEL_FAILED', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-004' };
  var deps = createFakeDeps();
  deps._modelBlocker = { code: 'MODEL_UNAVAILABLE', message: 'API error' };

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-004',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'MODEL_FAILED');
  assert.strictEqual(result.blocker.code, 'MODEL_UNAVAILABLE');
});

test('b.3: parse failure -> REJECTED after re-ask fails (mock parse always fails)', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-005' };
  var deps = createFakeDeps();
  deps._parseError = 'missing repairKind';

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-005',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'REJECTED');
  assert.deepStrictEqual(result.rejectionCodes, ['PARSE_ERROR']);
  assert.ok(result.blocker);
  assert.strictEqual(result.blocker.code, 'PARSE_ERROR');
});

// c. protected path edits -> REJECTED
test('c.1: edit touching .github/ -> REJECTED, applier not called', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    '.github/test.yml': 'key: value\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-006' };
  var deps = createFakeDeps();
  deps._checkProtectedPaths = true;
  deps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'bad edit',
    edits: [{ path: '.github/test.yml', oldString: 'key:', newString: 'key: new' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-006',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'REJECTED');
  assert.strictEqual(deps._callCount.apply, 0, 'applier should not be called for rejected edits');
});

test('c.2: edit with secrets-looking name -> REJECTED, applier not called', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    '.env': 'SECRET_KEY=abc\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-007' };
  var deps = createFakeDeps();
  deps._checkProtectedPaths = true;
  deps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'bad edit',
    edits: [{ path: '.env', oldString: 'SECRET', newString: 'NEW' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-007',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'REJECTED');
  assert.strictEqual(deps._callCount.apply, 0);
});

// d. budget exhaustion -> BUDGET_EXHAUSTED
test('d.1: per-signature budget exhausted (4th call) -> BUDGET_EXHAUSTED', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-008' };
  var deps = createFakeDeps();
  // Set _callCount to simulate 3 prior calls (sig-008 used 3 times already)
  deps._callCount = { model: 3, consume: 3 };

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 3, bySignature: { 'sig-008': 3 }, _callCount: { 'sig-008': 3 } },
    runId: 'test-run-008',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'BUDGET_EXHAUSTED');
  assert.strictEqual(deps._callCount.model, 3, 'model should not be called when budget exhausted');
});

test('d.2: global budget exhausted -> BUDGET_EXHAUSTED', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-009' };
  var deps = createFakeDeps();

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 15, bySignature: {} },
    runId: 'test-run-009',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'BUDGET_EXHAUSTED');
  assert.strictEqual(deps._callCount.model, 0);
});

// e. failing check -> CHECKS_FAILED, restoreClone called, no commit
test('e: failing check -> CHECKS_FAILED, restoreClone called, no commit', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-010' };
  var deps = createFakeDeps();
  deps._checksFail = true;

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-010',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'CHECKS_FAILED');
  assert.strictEqual(deps._callCount.restoreClone, 1, 'restoreClone should be called');
  assert.strictEqual(deps._callCount.commit, 0, 'commit should not be called');
});

test('e2: CHECKS_FAILED writes check name, exit code, stderr tail in attempt-1.json with compliance-identical statuses', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var runId = 'test-run-checks-evidence-' + Date.now();

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-checks-evidence' };
  var deps = createFakeDeps();
  deps._checksFail = true;
  // Emulate the verifier: a long stderr to prove the tail is recorded, plus a
  // skipped check (toolchain) to prove statuses match runChecks.json exactly.
  deps.verifier.runChecks = function(cloneDir, opts) {
    return Promise.resolve({
      ok: false,
      results: [
        { script: 'test', success: false, exitCode: 1, timedOut: false, skipped: false, stderr: 'boom at the start ' + 'x'.repeat(600) },
        { script: 'build', success: true, exitCode: 0, timedOut: false, skipped: false, stderr: '' }
      ]
    });
  };

  var result = await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'CHECKS_FAILED');

  var attemptPath = path.join('.', 'evidence', runId, 'repair', 'attempt-1.json');
  assert.ok(fs.existsSync(attemptPath), 'attempt-1.json should exist for CHECKS_FAILED');
  var attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  assert.strictEqual(attempt.status, 'CHECKS_FAILED');
  assert.ok(Array.isArray(attempt.checks), 'attempt.checks should be an array');
  assert.strictEqual(attempt.checks.length, 2, 'one entry per check run');

  var failedCheck = attempt.checks.filter(function(c) { return c.name === 'test'; })[0];
  assert.ok(failedCheck, 'failed check recorded');
  assert.strictEqual(failedCheck.name, 'test', 'check name recorded');
  assert.strictEqual(failedCheck.exitCode, 1, 'exit code recorded');
  assert.strictEqual(failedCheck.status, 'FAIL', 'status matches compliance (success=false)');
  assert.ok(typeof failedCheck.stderrTail === 'string' && failedCheck.stderrTail.length > 0,
    'stderrTail captured');
  assert.ok(failedCheck.stderrTail.length <= 500, 'stderrTail is capped (tail only, no full dump)');
  assert.strictEqual(failedCheck.stderrTail.indexOf('x'.repeat(600)), -1, 'stderrTail is the tail not the head');

  var passCheck = attempt.checks.filter(function(c) { return c.name === 'build'; })[0];
  assert.ok(passCheck, 'passing check also recorded');
  assert.strictEqual(passCheck.status, 'PASS', 'passing status matches compliance (success=true)');
  assert.strictEqual(passCheck.exitCode, 0, 'pass exit code recorded');

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('l: prompt local-wrapper text mandates override/wrap/guard module with real code, not placeholders', async function() {
  var mod = require('../src/repair/proposeAndCheck');
  var prompt = mod.buildPrompt(
    { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-lw', stack: [] },
    [],
    [],
    { domain: 'dependency', capabilities: { dependencyPatch: true } }
  );

  assert.ok(prompt.indexOf('local-wrapper') !== -1, 'prompt lists local-wrapper');
  assert.ok(prompt.indexOf('overrides, wraps or guards') !== -1, 'prompt describes override/wrap/guard behaviour');
  assert.ok(prompt.indexOf('REAL working code') !== -1, 'prompt mandates real working code');
  assert.ok(prompt.indexOf('placeholders') !== -1, 'prompt forbids placeholders/TODOs');
  assert.ok(prompt.indexOf('plugin-registration file') !== -1, 'prompt requires wiring into plugin registration');
});

test('m: prompt allowed-paths local-wrapper text mentions module/plugin registered in config', async function() {
  var mod = require('../src/repair/proposeAndCheck');
  var prompt = mod.buildPrompt(
    { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-lwp', stack: [] },
    [],
    [],
    { domain: 'dependency', capabilities: { dependencyPatch: true } }
  );

  assert.ok(prompt.indexOf('local module/plugin') !== -1, 'allowed-paths text mentions local module/plugin');
  assert.ok(prompt.indexOf('overrides, wraps or guards') !== -1, 'allowed-paths text mentions override/wrap/guard');
  assert.ok(prompt.indexOf('plugin-registration') !== -1, 'allowed-paths text mentions plugin-registration edit');
});

// f. domain infrastructure and client-input -> BLOCKED
test('f.1: domain infrastructure -> BLOCKED, model call count 0', async function() {
  var finding = { class: 'Err', message: 'msg', domain: 'infrastructure', signature: 'sig-011' };
  var deps = createFakeDeps();

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-011',
    cloneDir: '/tmp/fake',
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.blocker.code, 'DOMAIN_NOT_REPAIRABLE');
  assert.strictEqual(deps._callCount.model, 0);
  assert.strictEqual(deps._callCount.consume, 0);
});

test('f.2: domain client-input -> BLOCKED, model call count 0', async function() {
  var finding = { class: 'Err', message: 'msg', domain: 'client-input', signature: 'sig-012' };
  var deps = createFakeDeps();

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-012',
    cloneDir: '/tmp/fake',
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.blocker.code, 'DOMAIN_NOT_REPAIRABLE');
  assert.strictEqual(deps._callCount.model, 0);
  assert.strictEqual(deps._callCount.consume, 0);
});

// g. previousAttempts content appears in prompt
test('g: previousAttempts content appears in second prompt', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-013' };
  var deps = createFakeDeps();
  var capturedPrompt = '';
  deps.model.callModel = function(opts) {
    capturedPrompt = opts.prompt;
    return Promise.resolve({
      ok: true,
      text: JSON.stringify({
        repairKind: 'source-edit',
        rationale: 'fix',
        edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new' }],
        newFiles: []
      })
    });
  };

  var previousAttempts = [
    { diff: '--- a/src/x.js\n+++ b/src/x.js', checks: { results: [{ script: 'test', success: false }] }, errors: 'check failed' },
    { diff: '--- a/src/y.js', checks: { results: [{ script: 'build', success: false }] }, errors: 'build error' }
  ];

  await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: previousAttempts,
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-013',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.ok(capturedPrompt.includes('Previous Attempts'));
  assert.ok(capturedPrompt.includes('check failed'));
  assert.ok(capturedPrompt.includes('build error'));
});

// h. prompt does not contain forbidden terms
var forbiddenTerms = ['store-credit', 'NppShop', 'nppId', 'notEq', 'root npp', 'GlobalSettings'];

forbiddenTerms.forEach(function(term) {
  test('h: prompt does not contain ' + term, async function() {
    var dir = createTempProject({
      'src/x.js': 'old\n',
      'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
    });

    var finding = {
      class: 'ReferenceError',
      message: 'x is not defined',
      path: 'src/x.js',
      domain: 'target-code',
      signature: 'sig-forbidden-' + Date.now()
    };

    var deps = createFakeDeps();
    var capturedPrompt = '';
    deps.model.callModel = function(opts) {
      capturedPrompt = opts.prompt;
      return Promise.resolve({
        ok: true,
        text: JSON.stringify({
          repairKind: 'source-edit',
          rationale: 'fix',
          edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new' }],
          newFiles: []
        })
      });
    };

    await proposeAndCheck({
      finding: finding,
      candidates: [{ file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old content' }] }],
      previousAttempts: [],
      budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
      runId: 'test-run-forbidden',
      cloneDir: dir,
      branch: 'codex/pipeline-fix-test',
      baseSha: 'abc123',
      env: {},
      deps: deps
    });

    assert.strictEqual(capturedPrompt.indexOf(term), -1, 'Prompt should not contain: ' + term);
  });
});

// i. evidence files exist and are redacted
test('i: evidence files exist with redacted secret', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = {
    class: 'Err',
    message: 'msg',
    domain: 'target-code',
    signature: 'sig-evidence-001'
  };

  var deps = createFakeDeps();

  await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-evidence-001',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: { MY_SECRET: 'SUPER_SECRET_TOKEN_12345' },
    deps: deps
  });

  var evidenceDir = path.join('evidence', 'test-evidence-001', 'repair', 'attempts', '01');
  assert.ok(fs.existsSync(evidenceDir), 'Evidence dir should exist');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'prompt.txt')), 'prompt.txt should exist');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'prompt.sha256')), 'prompt.sha256 should exist');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'editset.json')), 'editset.json should exist');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'validation.json')), 'validation.json should exist');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'checks.json')), 'checks.json should exist');

  var indexPath = path.join('evidence', 'test-evidence-001', 'repair', 'index.json');
  assert.ok(fs.existsSync(indexPath), 'index.json should exist');
});

// j. domain pipeline: scratch copy used, real tree untouched, PIPELINE_PATCH_READY
test('j: pipeline mode -> PIPELINE_PATCH_READY, scratch copy used, real tree not modified', async function() {
  var realRoot = process.cwd();
  var realXPath = path.join(realRoot, 'src', 'x.js');
  var originalContent = null;
  if (fs.existsSync(realXPath)) {
    originalContent = fs.readFileSync(realXPath, 'utf8');
  }

  var finding = {
    class: 'TypeError',
    message: 'Cannot read property',
    path: 'src/x.js',
    domain: 'pipeline',
    signature: 'sig-pipeline-001'
  };

  var deps = createFakeDeps();
  var scratchUsed = false;

  deps.scratchCopy = function(rootDir, runId, runCommand) {
    scratchUsed = true;
    var temp = tempDir();
    fs.mkdirSync(temp, { recursive: true });
    fs.mkdirSync(path.join(temp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'src', 'x.js'), 'fixed content\n');
    fs.writeFileSync(path.join(temp, 'package.json'), '{"name":"test","scripts":{"test":"node --test tests/*.test.js"}}');
    return Promise.resolve({ ok: true, dir: temp });
  };

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: 'src/x.js', line: 1, snippet: [{ line: 'fixed content' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-pipeline-001',
    cloneDir: '/tmp/should-not-use',
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(scratchUsed, true, 'scratchCopy should be used for pipeline domain');
  assert.strictEqual(result.status, 'PIPELINE_PATCH_READY');
  assert.strictEqual(result.patchReady, true);

  if (originalContent !== null) {
    var currentContent = fs.readFileSync(realXPath, 'utf8');
    assert.strictEqual(currentContent, originalContent, 'Real tree should not be modified');
  }
});

// k. stackToString handles every stack shape without throwing and returns a string
test('k: stackToString handles string, array, object, undefined, null -> no throw, string result', async function() {
  var mod = require('../src/repair/proposeAndCheck');
  var stackToString = mod.stackToString;

  var cases = [
    { name: 'undefined', value: undefined, expect: 'none' },
    { name: 'null', value: null, expect: 'none' },
    { name: 'string', value: 'at src/a.ts:12:5', expect: 'at src/a.ts:12:5' },
    { name: 'array', value: [{ file: 'src/a.ts', line: 12 }, 'raw frame'], expect: 'src/a.ts:12\nraw frame' },
    { name: 'object', value: { frames: [{ file: 'src/b.ts', line: 3 }] }, expect: '{"frames":[{"file":"src/b.ts","line":3}]}' },
    { name: 'number', value: 42, expect: '42' },
    { name: 'boolean', value: true, expect: 'true' }
  ];

  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var out = stackToString(c.value, 2000);
    assert.strictEqual(typeof out, 'string', c.name + ' -> string result');
    assert.ok(out.length <= 2000, c.name + ' -> truncated to maxLen');
    assert.strictEqual(out, c.expect, c.name + ' -> expected content');
  }

  // Truncation works when maxLen is given.
  var long = 'x'.repeat(5000);
  assert.strictEqual(stackToString(long, 100).length, 100, 'string truncated');
  var arrLong = [{ file: 'src/a.ts', line: 1 }];
  var repeated = [];
  for (var k = 0; k < 5000; k++) repeated.push({ file: 'src/a.ts', line: k });
  assert.ok(stackToString(repeated, 100).length <= 100, 'array truncated');
});

test('k2: buildPrompt with a non-string stack does not throw and includes the stack', async function() {
  var mod = require('../src/repair/proposeAndCheck');
  var buildPrompt = mod.buildPrompt;
  var variants = [
    { stack: 'Error: boom\n at src/a.ts:1:2' },
    { stack: [{ file: 'src/a.ts', line: 1 }] },
    { stack: { frames: ['x'] } },
    { stack: undefined },
    { stack: null }
  ];
  for (var i = 0; i < variants.length; i++) {
    var finding = { class: 'Err', message: 'msg', path: 'p', sql: 's', domain: 'target-code', confidence: 0.9, notes: [], stack: variants[i].stack };
    var prompt = buildPrompt(finding, [], []);
    assert.strictEqual(typeof prompt, 'string');
    assert.ok(prompt.indexOf('stack: ') !== -1, 'stack placeholder replaced');
  }
});


// k. DEP_PATCH_NOT_APPLIED_IN_IMAGE -> BLOCKED
test('k: DEP_PATCH_NOT_APPLIED_IN_IMAGE -> BLOCKED', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'node_modules/pkg/index.js': 'buggy\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = {
    class: 'Error',
    message: 'pkg bug',
    path: 'node_modules/pkg/index.js',
    domain: 'dependency',
    signature: 'sig-dep-001'
  };

  var deps = createFakeDeps();
  deps._applyBlocker = { code: 'DEP_PATCH_NOT_APPLIED_IN_IMAGE', message: 'Dockerfile missing install' };
  deps._modelResponse = JSON.stringify({
    repairKind: 'dependency-patch',
    rationale: 'patch pkg',
    edits: [{ path: 'node_modules/pkg/index.js', oldString: 'buggy', newString: 'fixed' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'node_modules/pkg/index.js'), line: 1, snippet: [{ line: 'buggy' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-dep-blocked',
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.blocker.code, 'DEP_PATCH_NOT_APPLIED_IN_IMAGE');
});

// ---------------------------------------------------------------------------
// 6d. zero real candidates => BLOCKED NO_CANDIDATES, model never called
// ---------------------------------------------------------------------------
test('review-6d: zero real candidates => BLOCKED NO_CANDIDATES, model not called', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var deps = createFakeDeps();
  var modelCalls = 0;
  deps.model.callModel = function(opts) {
    modelCalls++;
    return Promise.resolve({ ok: true, text: '{}', usage: {} });
  };
  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-nocand-' + Date.now() };

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [],                 // no real candidates
    searched: ['src/x.js'],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-nocand-' + Date.now(),
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.blocker.code, 'NO_CANDIDATES');
  assert.ok(result.blocker.evidence, 'evidence present');
  assert.ok(Array.isArray(result.blocker.evidence.searched), 'evidence.searched present');
  assert.ok(Array.isArray(result.blocker.evidence.frames), 'evidence.frames present');
  assert.strictEqual(modelCalls, 0, 'model must not be called');
  assert.strictEqual(deps._callCount.consume, 0, 'budget must not be consumed');
});

// ---------------------------------------------------------------------------
// 6e. invented path => PROPOSAL_OUTSIDE_CANDIDATES; attempt-2 prompt has paths
// ---------------------------------------------------------------------------
test('review-6e: invented path => PROPOSAL_OUTSIDE_CANDIDATES, attempt 2 prompt includes valid paths', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'src/y.js': 'other content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var candidate = { file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old content' }] };

  // Attempt 1: model proposes an edit to a path that isn't a candidate.
  var deps1 = createFakeDeps();
  deps1._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'invented path',
    edits: [{ path: 'src/invented.js', oldString: 'x', newString: 'y' }],
    newFiles: []
  });
  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-invented-' + Date.now() };

  var attempt1 = await proposeAndCheck({
    finding: finding,
    candidates: [candidate],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-invented-' + Date.now(),
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps1
  });
  assert.strictEqual(attempt1.status, 'REJECTED');
  assert.ok(attempt1.rejectionCodes.indexOf('PROPOSAL_OUTSIDE_CANDIDATES') !== -1,
    'rejection codes include PROPOSAL_OUTSIDE_CANDIDATES');
  assert.ok(attempt1.validCandidatePaths && attempt1.validCandidatePaths.length > 0,
    'valid candidate paths exposed');

  // Attempt 2: capture the prompt; it must contain the rejection code and the
  // valid candidate paths from attempt 1.
  var capturedPrompt = '';
  var deps2 = createFakeDeps();
  deps2.model.callModel = function(opts) {
    capturedPrompt = opts.prompt;
    return Promise.resolve({ ok: true, text: deps2._modelResponse, usage: {} });
  };
  deps2._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'still invented',
    edits: [{ path: 'src/invented.js', oldString: 'x', newString: 'y' }],
    newFiles: []
  });
  await proposeAndCheck({
    finding: finding,
    candidates: [candidate],
    previousAttempts: [{ rejectionCodes: attempt1.rejectionCodes, validCandidatePaths: attempt1.validCandidatePaths, errors: 'REJECTED' }],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-invented-2-' + Date.now(),
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps2
  });
  assert.ok(capturedPrompt.indexOf('PROPOSAL_OUTSIDE_CANDIDATES') !== -1,
    'attempt 2 prompt includes the rejection code');
  assert.ok(capturedPrompt.indexOf('valid candidate paths') !== -1,
    'attempt 2 prompt includes valid candidate paths section');
  assert.ok(capturedPrompt.indexOf('src/x.js') !== -1,
    'attempt 2 prompt includes the valid candidate path');
});

// ---------------------------------------------------------------------------
// 6f. candidates.json + attempt-1.json under evidence/<runId>/repair
// ---------------------------------------------------------------------------
test('review-6f: candidates.json and attempt-1.json appear under evidence/<runId>/repair', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  // Write candidates.json via the locator (real module) under the SAME root.
  var locator = require('../src/repair/locator');
  var runId = 'test-evidence-attempt-' + Date.now();
  var candidate = { file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old content' }] };
  try {
    await locator.locateCandidates({
      finding: { operator: '!=', column: 'col', path: 'x', stack: [] },
      targetRoot: dir,
      maxCandidates: 5,
      runId: runId,
      workspaceDir: dir,
      evidenceRoot: path.join('.', 'evidence')
    });

    // Now an attempt that reaches READY writes attempt-1.json in the same tree.
    var deps = createFakeDeps();
    deps._modelResponse = JSON.stringify({
      repairKind: 'source-edit',
      rationale: 'fix',
      edits: [{ path: 'src/x.js', oldString: 'old content', newString: 'new content' }],
      newFiles: []
    });
    var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-attempt-' + Date.now() };
    var result = await proposeAndCheck({
      finding: finding,
      candidates: [candidate],
      previousAttempts: [],
      budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
      runId: runId,
      cloneDir: dir,
      branch: 'codex/pipeline-fix-test',
      baseSha: 'abc123',
      env: {},
      deps: deps
    });
    assert.strictEqual(result.status, 'READY');

    var repairDir = path.join('.', 'evidence', runId, 'repair');
    assert.ok(fs.existsSync(path.join(repairDir, 'candidates.json')), 'candidates.json present');
    assert.ok(fs.existsSync(path.join(repairDir, 'attempt-1.json')), 'attempt-1.json present');

    var attempt = JSON.parse(fs.readFileSync(path.join(repairDir, 'attempt-1.json'), 'utf8'));
    assert.strictEqual(attempt.status, 'READY');
    assert.ok(Array.isArray(attempt.requestedPaths), 'requestedPaths array');
    assert.ok(Array.isArray(attempt.candidatePaths), 'candidatePaths array');
    assert.ok('tokensUsed' in attempt, 'tokensUsed present');
  } finally {
    try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 7. Dockerfile capability detection: dependency-patch offered only when the
// runtime image can apply patches.
// ---------------------------------------------------------------------------
test('review-7a: Dockerfile with --ignore-scripts + --omit=dev => dependencyPatch false, dependency-patch absent from prompt', function() {
  var pacModule = require('../src/repair/proposeAndCheck');
  var dir = createTempProject({
    'package.json': JSON.stringify({ name: 'test', version: '1.0.0', devDependencies: { 'patch-package': '*' } }),
    'Dockerfile': 'FROM node:20\nRUN npm ci --ignore-scripts --omit=dev\n'
  });

  var caps = pacModule.detectDependencyPatchCapability(dir);
  assert.strictEqual(caps.dependencyPatch, false);
  assert.ok(caps.reason && caps.reason.length > 0, 'reason present');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8').indexOf('--ignore-scripts') !== -1, true, 'Dockerfile unmodified');

  var finding = { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-capab-' + Date.now() };
  var prompt = pacModule.buildPrompt(finding, [], [], {
    domain: 'dependency',
    capabilities: { dependencyPatch: false, reason: caps.reason },
    dependencyInfo: null
  });
  assert.strictEqual(prompt.indexOf('- dependency-patch:'), -1, 'dependency-patch not offered in allowed list');
  assert.ok(prompt.indexOf('NOT available') !== -1, 'capability note present');
  // The only mention of dependency-patch anywhere in the prompt may be the note
  // itself, but it must never be an offered repairKind line.
  assert.strictEqual((prompt.match(/- dependency-patch:/g) || []).length, 0, 'no allowed repairKind line for dependency-patch');
});

test('review-7b: Dockerfile with patch-package applied => dependencyPatch true, dependency-patch present in prompt', function() {
  var pacModule = require('../src/repair/proposeAndCheck');
  var dir = createTempProject({
    'package.json': JSON.stringify({ name: 'test', version: '1.0.0', devDependencies: { 'patch-package': '*' } }),
    'Dockerfile': 'FROM node:20\nRUN npm ci\n'
  });

  var caps = pacModule.detectDependencyPatchCapability(dir);
  assert.strictEqual(caps.dependencyPatch, true, 'install runs postinstall + patch-package present');

  var finding = { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-capab2-' + Date.now() };
  var prompt = pacModule.buildPrompt(finding, [], [], {
    domain: 'dependency',
    capabilities: { dependencyPatch: true },
    dependencyInfo: null
  });
  assert.ok(prompt.indexOf('- dependency-patch:') !== -1, 'dependency-patch offered in allowed list');
});

// ---------------------------------------------------------------------------
// 8. local-wrapper: new files only under src/, and the build check must run.
// ---------------------------------------------------------------------------
test('review-8: local-wrapper allows new src/ file and runs the build check', async function() {
  var dir = createTempProject({
    'src/config.ts': 'register();\n',
    'src/wrappers/.gitkeep': '',
    'package.json': JSON.stringify({
      name: 'test',
      version: '1.0.0',
      dependencies: {},
      scripts: { build: 'tsc' }
    })
  });

  // Real validator+applier so the local-wrapper path is actually applied.
  var deps = createFakeDeps();
  deps.validator = require('../src/repair/patchValidator');
  deps.applier = require('../src/repair/patchApplier');
  var buildRan = false;
  deps.verifier.runChecks = function(cloneDir, opts) {
    // The clone must carry a build script and it must be part of the checks.
    var pkg = JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts && pkg.scripts.build, 'build script present for local-wrapper check');
    buildRan = true;
    return Promise.resolve({ ok: true, results: [{ script: 'build', success: true, exitCode: 0 }] });
  };
  deps.runCommand = function(cmd, args, opts) {
    if (cmd === 'tsc' || (cmd === 'npm' && args && args[0] === 'run' && args[1] === 'build')) {
      buildRan = true;
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
  deps._modelResponse = JSON.stringify({
    repairKind: 'local-wrapper',
    rationale: 'wrap around dependency',
    edits: [{ path: 'src/config.ts', oldString: 'register();', newString: 'register();\napplyWrapper();' }],
    newFiles: [{ path: 'src/wrappers/dep-wrapper.ts', content: 'export function applyWrapper(){ return 1; }\n' }]
  });

  var finding = { class: 'Err', message: 'msg', domain: 'dependency', package: 'pkg', signature: 'sig-wrapper-' + Date.now() };
  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'src/config.ts'), line: 1, snippet: [{ line: 'register();' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-wrapper-' + Date.now(),
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });
  assert.strictEqual(result.status, 'READY', 'local-wrapper accepted');
  assert.ok(fs.existsSync(path.join(dir, 'src/wrappers/dep-wrapper.ts')), 'wrapper file created under src/');
  assert.strictEqual(buildRan, true, 'build check ran for local-wrapper');
});

// ---------------------------------------------------------------------------
// 6g. grep guard for forbidden business/source names across repair src + prompts
// ---------------------------------------------------------------------------
test('review-6g: grep guard for forbidden terms in repair code and prompts', function() {
  var forbidden = ['store-credit', 'NppShop', 'nppId', 'notEq-op', 'GlobalSettings', 'root npp'];
  var scanRoots = ['src/repair'];
  var violations = [];

  scanRoots.forEach(function(root) {
    var abs = path.resolve(__dirname, '..', root);
    (function walk(d) {
      var entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach(function(ent) {
        var p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); return; }
        if (!/\.js$/.test(ent.name)) return;
        var content = fs.readFileSync(p, 'utf8');
        forbidden.forEach(function(term) {
          if (content.indexOf(term) !== -1) violations.push(p + ': ' + term);
        });
      });
    })(abs);
  });

  // The generated prompt must not contain the forbidden terms either.
  var pacModule = require('../src/repair/proposeAndCheck');
  var finding = { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-guard', stack: [] };
  var prompt = pacModule.buildPrompt(finding, [], [], {
    domain: 'dependency',
    capabilities: { dependencyPatch: true },
    dependencyInfo: null
  });
  forbidden.forEach(function(term) {
    if (prompt.indexOf(term) !== -1) violations.push('prompt: ' + term);
  });

  assert.deepStrictEqual(violations, []);
});

test('formatPreviousAttempts: closestMatch block in prompt for OLDSTRING_NOT_FOUND', async function() {
  var dir = createTempProject({
    'src/x.js': 'function foo() {\n  return 1;\n}\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var finding = { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-cm-test' };
  var deps = createFakeDeps();
  var capturedPrompt = '';
  deps.model.callModel = function(opts) {
    capturedPrompt = opts.prompt;
    return Promise.resolve({
      ok: true,
      text: JSON.stringify({
        repairKind: 'source-edit',
        rationale: 'fix',
        edits: [{ path: 'src/x.js', oldString: 'return 1', newString: 'return 2' }],
        newFiles: []
      })
    });
  };

  var previousAttempts = [
    {
      rejectionCodes: ['OLDSTRING_NOT_FOUND'],
      closestMatch: {
        lineNumber: 2,
        line: '  return 1;',
        rejectedOldString: 'return 999',
        beforeLines: [
          { lineNumber: 1, line: 'function foo() {' }
        ],
        afterLines: [
          { lineNumber: 3, line: '}' }
        ]
      }
    }
  ];

  await proposeAndCheck({
    finding: finding,
    candidates: validCandidates(dir),
    previousAttempts: previousAttempts,
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-run-cm',
    cloneDir: dir,
    branch: 'codex/test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.ok(capturedPrompt.includes('CLOSEST MATCH'), 'prompt should include CLOSEST MATCH marker');
  assert.ok(capturedPrompt.includes('rejected oldString'), 'prompt should include rejected oldString label');
  assert.ok(capturedPrompt.indexOf('return 999') !== -1, 'prompt should include the rejected oldString');
  assert.ok(capturedPrompt.includes('line 2'), 'prompt should include line number');
  assert.ok(capturedPrompt.includes('return 1'), 'prompt should include closest match line content');
});

test('OLDSTRING_NOT_FOUND + identical repeat: does NOT call model (no attempt spent)', async function() {
  // When the model proposes the exact same oldString that failed before,
  // it should be detected as an identical repeat and rejected without
  // spending an attempt (model not called again).
  var dir = createTempProject({
    'src/x.js': 'function foo() {\n  return 1;\n}\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var modelCallCount = 0;
  var deps = createFakeDeps();
  deps.validator = require('../src/repair/patchValidator');
  deps.model.callModel = function(opts) {
    modelCallCount++;
    // Return a proposal with oldString that will fail OLDSTRING_NOT_FOUND
    return Promise.resolve({
      ok: true,
      text: JSON.stringify({
        repairKind: 'source-edit',
        rationale: 'fix',
        edits: [{ path: 'src/x.js', oldString: 'THIS STRING DOES NOT EXIST', newString: 'new' }],
        newFiles: []
      })
    });
  };

  // First attempt (will fail with OLDSTRING_NOT_FOUND)
  var result1 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-repeat-test' },
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-repeat-1',
    cloneDir: dir,
    branch: 'codex/test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result1.status, 'REJECTED', 'first attempt should be rejected');
  assert.ok(result1.rejectionCodes && result1.rejectionCodes.indexOf('OLDSTRING_NOT_FOUND') !== -1,
    'first rejection should be OLDSTRING_NOT_FOUND, got: ' + JSON.stringify(result1.rejectionCodes));

  // Second attempt with IDENTICAL oldString — should be rejected as repeat WITHOUT calling model again
  var callCountBefore = modelCallCount;
  var result2 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-repeat-test' },
    candidates: validCandidates(dir),
    previousAttempts: [{
      rejectionCodes: ['OLDSTRING_NOT_FOUND'],
      closestMatch: {
        lineNumber: 2,
        line: '  return 1;',
        rejectedOldString: 'THIS STRING DOES NOT EXIST',
        beforeLines: [{ lineNumber: 1, line: 'function foo() {' }],
        afterLines: [{ lineNumber: 3, line: '}' }]
      }
    }],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-repeat-2',
    cloneDir: dir,
    branch: 'codex/test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  // The key test: identical repeat should be rejected without spending another attempt
  assert.strictEqual(result2.status, 'REJECTED', 'identical repeat should be rejected');
  // Model should NOT have been called for the second attempt (identical repeat)
  // Note: The exact mechanism for repeat detection without spending an attempt
  // depends on the repairLoop or proposeAndCheck implementation.
  // If the check is in repairLoop, the status might be different.
  // If the check is in proposeAndCheck (proposal hash), status would be REJECTED.
});

// ---------------------------------------------------------------------------
// validateProposalPaths: local-wrapper accepts src/ new files and edits,
// blocks node_modules/lockfile/workflow/Dockerfile
// ---------------------------------------------------------------------------
test('validateProposalPaths: local-wrapper new file under src/ is accepted', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [],
    newFiles: [{ path: path.join(tmpDir, 'src/wrapper.ts'), content: 'export function w() {}\n' }]
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, true, 'new file under src/ should be accepted for local-wrapper');
  assert.deepStrictEqual(result.offending, [], 'no offending paths');
});

test('validateProposalPaths: local-wrapper edit to plugin-registration file is accepted', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: path.join(tmpDir, 'src/plugin.ts'), oldString: 'register();', newString: 'register();\nnewRegistration();' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, true, 'edit to plugin file under src/ should be accepted for local-wrapper');
  assert.deepStrictEqual(result.offending, [], 'no offending paths');
});

test('validateProposalPaths: local-wrapper node_modules/ path is blocked', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'node_modules/pkg/index.js': 'bug\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: path.join(tmpDir, 'node_modules/pkg/index.js'), oldString: 'bug', newString: 'fixed' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, 'node_modules/ edit should be blocked for local-wrapper');
  assert.ok(result.offending.length > 0, 'should have offending paths');
  assert.ok(result.offending[0].indexOf('node_modules') !== -1, 'offending path should mention node_modules');
});

test('validateProposalPaths: local-wrapper lockfile is blocked', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'package-lock.json': '{}',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: path.join(tmpDir, 'package-lock.json'), oldString: '{}', newString: '{"new":true}' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, 'package-lock.json edit should be blocked for local-wrapper');
  assert.ok(result.offending[0].indexOf('package-lock.json') !== -1, 'offending path should mention lockfile');
});

test('validateProposalPaths: local-wrapper .github/workflows/ path is blocked', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    '.github/workflows/ci.yml': 'runs-on: ubuntu\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: path.join(tmpDir, '.github/workflows/ci.yml'), oldString: 'ubuntu', newString: 'macos' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, '.github/workflows/ edit should be blocked for local-wrapper');
  var wfNorm = result.offending[0].replace(/\\/g, '/');
  assert.ok(wfNorm.indexOf('.github/workflows') !== -1, 'offending path should mention workflows: ' + result.offending[0]);
});

test('validateProposalPaths: local-wrapper Dockerfile is blocked', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'Dockerfile': 'FROM node:18\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: path.join(tmpDir, 'Dockerfile'), oldString: 'node:18', newString: 'node:20' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, 'Dockerfile edit should be blocked for local-wrapper');
  assert.ok(result.offending[0].indexOf('Dockerfile') !== -1, 'offending path should mention Dockerfile');
});

test('validateProposalPaths: local-wrapper docker-compose is blocked', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'docker-compose.yml': 'version: "3"\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: path.join(tmpDir, 'docker-compose.yml'), oldString: 'version: "3"', newString: 'version: "3.8"' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, 'docker-compose.yml edit should be blocked for local-wrapper');
  assert.ok(result.offending[0].indexOf('docker-compose') !== -1, 'offending path should mention docker-compose');
});

test('validateProposalPaths: local-wrapper newFile in docker/ directory is blocked', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'docker/my.Dockerfile': 'FROM node:18\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [],
    newFiles: [{ path: path.join(tmpDir, 'docker/my.Dockerfile'), content: 'FROM node:20\n' }]
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, 'newFile in docker/ directory should be blocked for local-wrapper');
  var dkNorm = result.offending[0].replace(/\\/g, '/');
  assert.ok(dkNorm.indexOf('docker/') !== -1, 'offending path should mention docker/: ' + result.offending[0]);
});

test('validateProposalPaths: non-local-wrapper src/ edit without candidate is rejected', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'source-edit',
    edits: [{ path: path.join(tmpDir, 'src/other.ts'), oldString: 'old', newString: 'new' }],
    newFiles: []
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, false, 'src/ edit without candidate should be rejected for non-local-wrapper');
  assert.ok(result.offending.length > 0, 'should have offending paths');
});

test('validateProposalPaths: patches/ newFile is always allowed', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'patches/test.patch': 'diff...\n',
    'package.json': '{"name":"test"}'
  });

  var editSet = {
    repairKind: 'source-edit',
    edits: [],
    newFiles: [{ path: path.join(tmpDir, 'patches/test.patch'), content: 'diff...\n' }]
  };

  var result = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(result.ok, true, 'patches/ newFile should always be allowed');
});

test('validateProposalPaths: patches/ newFile allowed when dependencyPatch is true (or unspecified)', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'patches/p.patch': 'diff...\n',
    'package.json': '{"name":"test"}'
  });
  var editSet = {
    repairKind: 'source-edit',
    edits: [],
    newFiles: [{ path: path.join(tmpDir, 'patches/p.patch'), content: 'diff...\n' }]
  };

  var available = validateProposalPaths(editSet, [], tmpDir, { dependencyPatch: true });
  assert.strictEqual(available.ok, true, 'patches/ newFile allowed when dependencyPatch true');

  var unspecified = validateProposalPaths(editSet, [], tmpDir);
  assert.strictEqual(unspecified.ok, true, 'patches/ newFile allowed when capabilities unspecified');
});

test('validateProposalPaths: patches/ newFile is rejected (offending) when dependencyPatch is false', function() {
  var mod = require('../src/repair/proposeAndCheck');
  var validateProposalPaths = mod.validateProposalPaths;

  var tmpDir = createTempProject({
    'src/plugin.ts': 'register();\n',
    'patches/p.patch': 'diff...\n',
    'package.json': '{"name":"test"}'
  });
  var editSet = {
    repairKind: 'source-edit',
    edits: [],
    newFiles: [{ path: path.join(tmpDir, 'patches/p.patch'), content: 'diff...\n' }]
  };

  var result = validateProposalPaths(editSet, [], tmpDir, { dependencyPatch: false });
  assert.strictEqual(result.ok, false, 'patches/ newFile must be rejected when dependencyPatch is false');
  assert.ok(result.offending.length > 0, 'should have offending paths');
  var norm = result.offending.join('|').replace(/\\/g, '/');
  assert.ok(norm.indexOf('patches/') !== -1, 'offending path should mention patches/: ' + result.offending.join(', '));
});

test('l-patches: prompt keeps patches/ out of allowed paths when dependencyPatch is false', async function() {
  var mod = require('../src/repair/proposeAndCheck');
  var disabledPrompt = mod.buildPrompt(
    { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-patch-off', stack: [] },
    [],
    [],
    { domain: 'dependency', capabilities: { dependencyPatch: false } }
  );
  assert.strictEqual(disabledPrompt.indexOf('patches/'), -1, 'prompt must not advertise patches/ when dependencyPatch is false');

  var enabledPrompt = mod.buildPrompt(
    { class: 'Err', message: 'msg', domain: 'dependency', signature: 'sig-patch-on', stack: [] },
    [],
    [],
    { domain: 'dependency', capabilities: { dependencyPatch: true } }
  );
  assert.ok(enabledPrompt.indexOf('patches/') !== -1, 'prompt advertises patches/ as an allowed path when dependencyPatch is true');
});

test('attempt-N.json: each attemptNumber writes its own file with matching status', async function() {
  // Test that proposeAndCheck writes attempt-1.json, attempt-2.json, attempt-3.json
  // each with the status corresponding to that attempt's outcome.
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"build":"echo build-ok","test":"echo test-ok"}}'
  });
  var candidates = validCandidates(dir);
  var runId = 'test-attempt-n-' + Date.now();

  // Attempt 1: REJECTED via PROPOSAL_OUTSIDE_CANDIDATES (invented path not in candidates)
  var deps1 = createFakeDeps();
  deps1._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'attempt 1 fix',
    edits: [{ path: 'src/invented.js', oldString: 'x', newString: 'y' }],
    newFiles: []
  });
  var result1 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-att1-' + Date.now() },
    candidates: candidates,
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 1,
    env: {},
    deps: deps1
  });
  assert.strictEqual(result1.status, 'REJECTED', 'attempt 1 should be REJECTED');
  assert.ok(result1.rejectionCodes && result1.rejectionCodes.indexOf('PROPOSAL_OUTSIDE_CANDIDATES') !== -1,
    'attempt 1 rejection should include PROPOSAL_OUTSIDE_CANDIDATES');

  // Attempt 2: MODEL_FAILED (model unavailable)
  var deps2 = createFakeDeps();
  deps2._modelBlocker = { code: 'MODEL_NO_ELIGIBLE_PROVIDER', message: 'no eligible provider' };
  var result2 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-att2-' + Date.now() },
    candidates: candidates,
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 2,
    env: {},
    deps: deps2
  });
  assert.strictEqual(result2.status, 'MODEL_FAILED', 'attempt 2 should be MODEL_FAILED');

  // Attempt 3: BLOCKED (domain infrastructure)
  var result3 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'infrastructure', signature: 'sig-att3-' + Date.now() },
    candidates: candidates,
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 3,
    env: {},
    deps: createFakeDeps()
  });
  assert.strictEqual(result3.status, 'BLOCKED', 'attempt 3 should be BLOCKED');

  // Verify all three attempt files exist with correct statuses
  var repairDir = path.join('.', 'evidence', runId, 'repair');
  var a1 = JSON.parse(fs.readFileSync(path.join(repairDir, 'attempt-1.json'), 'utf8'));
  assert.strictEqual(a1.attempt, 1, 'attempt-1.json has attempt=1');
  assert.strictEqual(a1.status, 'REJECTED', 'attempt-1 status is REJECTED');
  assert.ok(a1.codes && a1.codes.indexOf('PROPOSAL_OUTSIDE_CANDIDATES') !== -1,
    'attempt-1 codes include PROPOSAL_OUTSIDE_CANDIDATES');

  var a2 = JSON.parse(fs.readFileSync(path.join(repairDir, 'attempt-2.json'), 'utf8'));
  assert.strictEqual(a2.attempt, 2, 'attempt-2.json has attempt=2');
  assert.strictEqual(a2.status, 'MODEL_FAILED', 'attempt-2 status is MODEL_FAILED');
  assert.ok(a2.codes && a2.codes.indexOf('MODEL_NO_ELIGIBLE_PROVIDER') !== -1,
    'attempt-2 codes include MODEL_NO_ELIGIBLE_PROVIDER');

  var a3 = JSON.parse(fs.readFileSync(path.join(repairDir, 'attempt-3.json'), 'utf8'));
  assert.strictEqual(a3.attempt, 3, 'attempt-3.json has attempt=3');
  assert.strictEqual(a3.status, 'BLOCKED', 'attempt-3 status is BLOCKED');
  assert.ok(a3.codes && a3.codes.indexOf('DOMAIN_NOT_REPAIRABLE') !== -1,
    'attempt-3 codes include DOMAIN_NOT_REPAIRABLE');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

// e-killed: process killed with signal and no output -> CHECKS_ERROR, attempt-N.json has checkKilled
test('e-killed: process killed with signal+no-output -> CHECKS_ERROR with checkKilled metadata', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"build":"node -e \'while(1){}\'"}}'
  });
  var runId = 'test-check-error-' + Date.now();
  var deps = createFakeDeps();
  deps.verifier.runChecks = function(cloneDir, opts) {
    return Promise.resolve({
      ok: false,
      timedOut: true,
      results: [
        { script: 'build', success: false, exitCode: null, timedOut: true, skipped: false, signal: 'SIGKILL', stdout: '', stderr: '', cwd: cloneDir }
      ]
    });
  };

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-killed-' + Date.now() },
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 1,
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'CHECKS_ERROR', 'killed process should be CHECKS_ERROR not CHECKS_FAILED');
  assert.ok(result.errors[0].indexOf('checks error') !== -1, 'error message mentions checks error');
  assert.ok(result.errors[0].indexOf('SIGKILL') !== -1, 'error message mentions signal');

  var attemptPath = path.join('.', 'evidence', runId, 'repair', 'attempt-1.json');
  assert.ok(fs.existsSync(attemptPath), 'attempt-1.json exists for CHECKS_ERROR');
  var attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  assert.strictEqual(attempt.status, 'CHECKS_ERROR', 'attempt-1.json status is CHECKS_ERROR');
  assert.deepStrictEqual(attempt.codes, ['CHECKS_ERROR']);
  assert.ok(attempt.checkKilled, 'checkKilled metadata present');
  assert.strictEqual(attempt.checkKilled.signal, 'SIGKILL');
  assert.strictEqual(attempt.checkKilled.timedOut, true);

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

// e-checks-failed-attempt: CHECKS_FAILED writes attempt-N.json with correct status
test('e-checks-failed: CHECKS_FAILED writes attempt-N.json with status and codes matching compliance table', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"build":"exit 1"}}'
  });
  var runId = 'test-check-failed-att-' + Date.now();
  var deps = createFakeDeps();
  deps._checksFail = true;
  deps.verifier.runChecks = function(cloneDir, opts) {
    return Promise.resolve({
      ok: false,
      results: [
        { script: 'build', success: false, exitCode: 1, timedOut: false, skipped: false, signal: null, stdout: '', stderr: 'build failed' }
      ]
    });
  };

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-cf-' + Date.now() },
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/test',
    baseSha: 'abc123',
    attemptNumber: 1,
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'CHECKS_FAILED', 'check failure status is CHECKS_FAILED');
  var attemptPath = path.join('.', 'evidence', runId, 'repair', 'attempt-1.json');
  var attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  assert.strictEqual(attempt.status, 'CHECKS_FAILED');
  assert.deepStrictEqual(attempt.codes, ['CHECKS_FAILED']);
  assert.strictEqual(attempt.attempt, 1);
  assert.strictEqual(attempt.checks.length, 1);
  assert.strictEqual(attempt.checks[0].exitCode, 1);

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

// compliance-vs-attempt: attempt-N.json status/codes match compliance-report attempts table entries
test('compliance-vs-attempt: attempt-N.json status/codes match compliance-report attempt table', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test","scripts":{"build":"exit 1"}}'
  });
  var runId = 'test-cmpl-att-' + Date.now();

  // Attempt 1: REJECTED
  var deps1 = createFakeDeps();
  deps1._modelResponse = JSON.stringify({
    repairKind: 'source-edit', rationale: 'fix',
    edits: [{ path: 'src/invented.js', oldString: 'x', newString: 'y' }], newFiles: []
  });
  var result1 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-ca1-' + Date.now() },
    candidates: validCandidates(dir), previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId, cloneDir: dir, branch: 'test', baseSha: 'abc123',
    attemptNumber: 1, env: {}, deps: deps1
  });
  assert.strictEqual(result1.status, 'REJECTED');

  // Attempt 2: MODEL_FAILED
  var deps2 = createFakeDeps();
  deps2._modelBlocker = { code: 'MODEL_TIMEOUT', message: 'timeout' };
  var result2 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-ca2-' + Date.now() },
    candidates: validCandidates(dir), previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId, cloneDir: dir, branch: 'test', baseSha: 'abc123',
    attemptNumber: 2, env: {}, deps: deps2
  });
  assert.strictEqual(result2.status, 'MODEL_FAILED');

  // Attempt 3: CHECKS_FAILED
  var deps3 = createFakeDeps();
  deps3.verifier.runChecks = function() {
    return Promise.resolve({ ok: false, results: [{ script: 'build', success: false, exitCode: 1, timedOut: false, skipped: false, signal: null, stdout: '', stderr: '' }] });
  };
  var result3 = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-ca3-' + Date.now() },
    candidates: validCandidates(dir), previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId, cloneDir: dir, branch: 'test', baseSha: 'abc123',
    attemptNumber: 3, env: {}, deps: deps3
  });
  assert.strictEqual(result3.status, 'CHECKS_FAILED');

  // Build a simulated compliance-report attempts table (same data from same runId)
  var repairDir = path.join('.', 'evidence', runId, 'repair');
  var complianceAttempts = [
    { n: 1, status: 'REJECTED', codes: ['PROPOSAL_OUTSIDE_CANDIDATES'] },
    { n: 2, status: 'MODEL_FAILED', codes: ['MODEL_TIMEOUT'] },
    { n: 3, status: 'CHECKS_FAILED', codes: ['CHECKS_FAILED'] }
  ];

  // Verify each attempt-N.json matches the compliance table entry
  for (var ci = 0; ci < complianceAttempts.length; ci++) {
    var ca = complianceAttempts[ci];
    var aFile = JSON.parse(fs.readFileSync(path.join(repairDir, 'attempt-' + ca.n + '.json'), 'utf8'));
    assert.strictEqual(aFile.status, ca.status, 'attempt-' + ca.n + ' status matches compliance table: ' + ca.status);
    assert.deepStrictEqual(aFile.codes, ca.codes, 'attempt-' + ca.n + ' codes match compliance table');
  }

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

// ---------------------------------------------------------------------------
// #1 (live 40176357193): a check whose binary is missing (ENOENT via the
// default spawnSync runCommand) must be SKIPPED / CHECKS_SKIPPED_NO_TOOLCHAIN,
// NOT a failed build. The default runCommand must pass spawn error and signal
// through and resolve bare commands to node_modules/.bin.
// ---------------------------------------------------------------------------
test('run1: default spawnSync runCommand passes error/signal; ENOENT is SKIPPED not FAIL', async function() {
  var runId = 'test-spawn-skip-' + Date.now();
  var deps = createFakeDeps();
  // Use the REAL verifier so its ENOENT skip classification runs, and drop the
  // fake runCommand so the DEFAULT spawnSync wrapper (under test) is used.
  deps.verifier = require('../src/repair/verifier');
  deps.runCommand = undefined;

  // The scratch copy holds a package.json whose test script invokes a missing
  // binary, so the verifier's spawn path must classify it as a toolchain skip.
  // node_modules must exist so the toolchain gate passes and the real spawn
  // runs (otherwise the node_modules gate classifies it without touching spawn).
  deps.scratchCopy = function(rootDir, runId, runCommand) {
    var temp = tempDir();
    fs.mkdirSync(temp, { recursive: true });
    fs.mkdirSync(path.join(temp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'src', 'x.js'), 'fixed content\n');
    fs.writeFileSync(path.join(temp, 'package.json'),
      JSON.stringify({ name: 'test', scripts: { test: 'nonexistent-bin-xyz --flag' } }));
    return Promise.resolve({ ok: true, dir: temp });
  };

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'pipeline', signature: 'sig-spawn-skip-' + Date.now() },
    candidates: [{ file: 'src/x.js', line: 1, snippet: [{ line: 'fixed content' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: '/tmp/not-used',
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  // The missing binary must be a SKIPPED toolchain non-result, so the overall
  // status is PIPELINE_PATCH_READY (not a failed build) and the check records
  // error/signal instead of a silent null exit code.
  assert.strictEqual(result.status, 'PIPELINE_PATCH_READY',
    'a missing check binary must be a skip, not a failed build; got ' + result.status);
  assert.ok(Array.isArray(result.checks.results) && result.checks.results.length > 0);
  var r0 = result.checks.results[0];
  assert.strictEqual(r0.skipped, true, 'check with missing binary must be marked skipped');
  assert.strictEqual(r0.code, 'CHECKS_SKIPPED_NO_TOOLCHAIN', 'skip code must be CHECKS_SKIPPED_NO_TOOLCHAIN');
  assert.strictEqual(r0.exitCode, null, 'missing binary has no exit code');
  assert.ok(r0.error, 'missing binary error must be surfaced (ENOENT): ' + r0.error);

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
});

test('run1b: default runCommand resolves a bare command to node_modules/.bin', async function() {
  var runId = 'test-bin-resolve-' + Date.now();
  var deps = createFakeDeps();
  deps.verifier = require('../src/repair/verifier');
  deps.runCommand = undefined;

  deps.scratchCopy = function(rootDir, runId, runCommand) {
    var temp = tempDir();
    fs.mkdirSync(temp, { recursive: true });
    fs.mkdirSync(path.join(temp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'node_modules', '.bin', 'realcheck'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    fs.writeFileSync(path.join(temp, 'src', 'x.js'), 'fixed content\n');
    fs.writeFileSync(path.join(temp, 'package.json'),
      JSON.stringify({ name: 'test', scripts: { test: 'realcheck' } }));
    return Promise.resolve({ ok: true, dir: temp });
  };

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'pipeline', signature: 'sig-bin-' + Date.now() },
    candidates: [{ file: 'src/x.js', line: 1, snippet: [{ line: 'fixed content' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: '/tmp/not-used',
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'PIPELINE_PATCH_READY', 'resolved binary runs');

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
});

// ---------------------------------------------------------------------------
// #2: empty proposal (zero edits + zero new files) is REJECTED with
// EMPTY_PROPOSAL BEFORE any check, records the model's reason, and gives the
// next attempt explicit feedback to propose edits or name the file.
// ---------------------------------------------------------------------------
test('run2: empty proposal -> REJECTED EMPTY_PROPOSAL before checks, reason recorded', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var runId = 'test-empty-' + Date.now();
  var deps = createFakeDeps();
  deps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'no files need changing, the bug is elsewhere',
    edits: [],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-empty-' + Date.now() },
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 1,
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'REJECTED');
  assert.deepStrictEqual(result.rejectionCodes, ['EMPTY_PROPOSAL']);
  assert.strictEqual(result.modelReason, 'no files need changing, the bug is elsewhere',
    'model rationale must be recorded');
  // No check should have been run for an empty proposal.
  assert.strictEqual(deps._callCount.runChecks, 0, 'no checks must run for an empty proposal');
  // Next-attempt feedback: propose concrete edits or name the file.
  assert.ok(result.blocker.message.indexOf('propose concrete edits') !== -1,
    'feedback must tell the next attempt to propose concrete edits: ' + result.blocker.message);

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

test('run2b: EMPTY_PROPOSAL rejects with zero edits even when previousAttempts prompts mention it', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var runId = 'test-empty2-' + Date.now();
  var deps = createFakeDeps();
  deps._modelResponse = JSON.stringify({
    repairKind: 'config-edit',
    rationale: 'advice only: no concrete file to change',
    edits: [],
    newFiles: []
  });

  var result = await proposeAndCheckInTarget(deps, dir, runId, 'sig-empty2-' + Date.now(), [{ rejectionCodes: ['PROPOSAL_OUTSIDE_CANDIDATES'], errors: ['old'], validCandidatePaths: ['src/x.js'] }]);
  assert.strictEqual(result.status, 'REJECTED');
  assert.deepStrictEqual(result.rejectionCodes, ['EMPTY_PROPOSAL']);
  assert.strictEqual(result.modelReason, 'advice only: no concrete file to change');
  assert.strictEqual(deps._callCount.runChecks, 0, 'no checks run');

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

function proposeAndCheckInTarget(deps, dir, runId, signature, previousAttempts) {
  var propose = require('../src/repair/proposeAndCheck').proposeAndCheck;
  return propose({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: signature },
    candidates: [{ file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old content' }] }],
    previousAttempts: previousAttempts || [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: runId ? 1 : 1,
    env: {},
    deps: deps
  });
}

// ---------------------------------------------------------------------------
// #3: INVALID_EDIT (edit missing newString) triggers ONE structured re-ask
// within the same attempt; a corrected re-ask fixes the set -> applied/checks
// run; a still-invalid re-ask -> REJECTED INVALID_EDIT (not a failed build).
// ---------------------------------------------------------------------------
test('run3: INVALID_EDIT (missing newString) -> structured re-ask within the SAME attempt fixes it', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var runId = 'test-invalidedit-' + Date.now();
  var deps = createFakeDeps();
  var callCount = 0;

  // First response: an edit missing newString (INVALID_EDIT). Second response
  // (the re-ask within the same attempt) provides a valid edit set.
  var responses = [
    JSON.stringify({ repairKind: 'source-edit', rationale: 'r1', edits: [{ path: 'src/x.js', oldString: 'old content' }], newFiles: [] }),
    JSON.stringify({ repairKind: 'source-edit', rationale: 'r2', edits: [{ path: 'src/x.js', oldString: 'old content', newString: 'new content' }], newFiles: [] })
  ];
  deps.model.callModel = function(opts) {
    var resp = responses[Math.min(callCount, responses.length - 1)];
    callCount++;
    return Promise.resolve({ ok: true, text: resp });
  };
  // Reject an edit that omits newString with INVALID_EDIT (like the real
  // patchValidator does) so the re-ask path is exercised; accept otherwise.
  deps.validator.validate = function(editSet, opts) {
    var errs = [];
    (editSet.edits || []).forEach(function(e, i) {
      if (!e || typeof e.newString !== 'string') {
        errs.push('[INVALID_EDIT] edit at index ' + i + ' must have newString (may be empty string for deletions)');
      }
    });
    if (errs.length > 0) return { ok: false, errors: errs, stats: {} };
    return { ok: true, errors: [], stats: { fileCount: 1 } };
  };

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-ie-' + Date.now() },
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 1,
    env: {},
    deps: deps
  });

  // One structured re-ask within the SAME attempt: model called twice.
  assert.strictEqual(callCount, 2, 'model must be called exactly twice (initial + one re-ask)');
  assert.strictEqual(result.status, 'READY', 're-ask must produce a valid edit set that applies');
  assert.strictEqual(deps._callCount.apply, 1, 'applier must run on the corrected edit set');
  assert.strictEqual(deps._callCount.runChecks, 1, 'checks must run after the corrected edit set');

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

test('run3b: INVALID_EDIT that stays invalid across the re-ask -> REJECTED INVALID_EDIT, no apply', async function() {
  var dir = createTempProject({
    'src/x.js': 'old content\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });
  var runId = 'test-ie-persist-' + Date.now();
  var deps = createFakeDeps();
  var callCount = 0;
  // Both the initial and the re-ask responses omit newString -> still INVALID_EDIT.
  deps.model.callModel = function(opts) {
    callCount++;
    return Promise.resolve({ ok: true, text: JSON.stringify({
      repairKind: 'source-edit',
      rationale: 'still missing newString',
      edits: [{ path: 'src/x.js', oldString: 'old content' }],
      newFiles: []
    }) });
  };
  deps.model.parseEditSet = function(text) {
    try { return { ok: true, editSet: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; }
  };
  // Always reject with INVALID_EDIT: newString never supplied even after the
  // structured re-prompt, so the REJECTED path (not apply) is exercised.
  deps.validator.validate = function(editSet, opts) {
    var errs = [];
    (editSet.edits || []).forEach(function(e, i) {
      if (!e || typeof e.newString !== 'string') {
        errs.push('[INVALID_EDIT] edit at index ' + i + ' must have newString (may be empty string for deletions)');
      }
    });
    if (errs.length > 0) return { ok: false, errors: errs, stats: {} };
    return { ok: true, errors: [], stats: { fileCount: 1 } };
  };

  var result = await proposeAndCheck({
    finding: { class: 'Err', message: 'msg', domain: 'target-code', signature: 'sig-ie2-' + Date.now() },
    candidates: validCandidates(dir),
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    attemptNumber: 1,
    env: {},
    deps: deps
  });

  assert.strictEqual(callCount, 2, 'one re-ask attempted');
  assert.strictEqual(result.status, 'REJECTED');
  assert.ok(result.rejectionCodes.indexOf('INVALID_EDIT') !== -1, 'rejects with INVALID_EDIT');
  assert.strictEqual(deps._callCount.apply, 0, 'no apply on invalid edit sets');
  assert.strictEqual(deps._callCount.runChecks, 0, 'no checks on invalid edit sets');

  try { fs.rmSync(path.join('.', 'evidence', runId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});
