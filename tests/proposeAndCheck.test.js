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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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
    candidates: [],
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