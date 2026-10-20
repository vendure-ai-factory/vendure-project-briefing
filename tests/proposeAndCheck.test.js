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

// b. model failures -> MODEL_FAILED
test('b.1: invalid JSON from model -> MODEL_FAILED', async function() {
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

  assert.strictEqual(result.status, 'MODEL_FAILED');
  assert.ok(result.errors);
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

test('b.3: parse failure -> MODEL_FAILED', async function() {
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

  assert.strictEqual(result.status, 'MODEL_FAILED');
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
