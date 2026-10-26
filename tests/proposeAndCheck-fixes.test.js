'use strict';

/**
 * Tests for fixes 2, 3, and partial fix 1 (validateProposalPaths appSourceNewFile)
 * in proposeAndCheck.
 */

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

var proposeAndCheck = require('../src/repair/proposeAndCheck').proposeAndCheck;
var validateProposalPaths = require('../src/repair/proposeAndCheck').validateProposalPaths;
var proposalSummaryOf = require('../src/repair/proposeAndCheck').proposalSummaryOf;

function tempDir() {
  return path.join(os.tmpdir(), 'pnctest-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
}

function createTempProject(files) {
  var dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files).forEach(function(name) {
    var filePath = path.join(dir, name);
    var dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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
        if (deps._modelBlocker) return Promise.resolve({ ok: false, blocker: deps._modelBlocker });
        if (deps._modelResponse) return Promise.resolve({ ok: true, text: deps._modelResponse });
        return Promise.resolve({
          ok: true,
          text: JSON.stringify({ repairKind: 'source-edit', rationale: 'fix', edits: [], newFiles: [] }),
          usage: { total_tokens: 100 }
        });
      },
      parseEditSet: function(text) {
        try { return { ok: true, editSet: JSON.parse(text) }; }
        catch (e) { return { ok: false, error: e.message }; }
      },
      consume: function(budget, sig) {
        if (!budget._callCount) budget._callCount = {};
        budget._callCount[sig] = (budget._callCount[sig] || 0) + 1;
        if (budget._callCount[sig] > 3) return { ok: false, reason: 'budget exhausted' };
        if ((budget.total || 0) >= budget.global) return { ok: false, reason: 'global exhausted' };
        budget.total = (budget.total || 0) + 1;
        return { ok: true };
      }
    },
    budget: {
      consume: function(budget, sig) {
        if (!budget._callCount) budget._callCount = {};
        budget._callCount[sig] = (budget._callCount[sig] || 0) + 1;
        if (budget._callCount[sig] > 3) return { ok: false, reason: 'budget exhausted' };
        if ((budget.total || 0) >= budget.global) return { ok: false, reason: 'global exhausted' };
        budget.total = (budget.total || 0) + 1;
        return { ok: true };
      }
    },
    validator: {
      validate: function(editSet, opts) {
        callCount.validate++;
        return { ok: true, errors: [], stats: { fileCount: 1 } };
      }
    },
    applier: {
      apply: function(editSet, opts) {
        callCount.apply++;
        if (deps._applyBlocker) return { ok: false, blocker: deps._applyBlocker };
        var cloneDir = opts.cloneDir;
        (editSet.edits || []).forEach(function(edit) {
          var f = path.join(cloneDir, edit.path);
          if (fs.existsSync(f)) {
            fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(edit.oldString, edit.newString), 'utf8');
          }
        });
        return { ok: true, filesChanged: ['src/x.js'], diffStats: {} };
      },
      restoreClone: function(cloneDir, runCommand) { callCount.restoreClone++; }
    },
    verifier: {
      runChecks: function(cloneDir, opts) {
        callCount.runChecks++;
        if (deps._checksFail) return Promise.resolve({ ok: false, results: [{ script: 'test', success: false, exitCode: 1, stderr: 'fail' }] });
        return Promise.resolve({ ok: true, results: [{ script: 'test', success: true, exitCode: 0, stdout: 'ok', stderr: '' }] });
      }
    },
    runCommand: function(cmd, args, opts) { return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 }); },
    fetch: function() { return Promise.resolve({ ok: false, blocker: { code: 'IO_NOT_INJECTED' } }); },
    now: function() { return '2024-01-01T00:00:00.000Z'; },
    fs: fs,
    scratchCopy: function(rootDir, runId, runCommand) {
      var temp = tempDir();
      fs.mkdirSync(temp, { recursive: true });
      fs.mkdirSync(path.join(temp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'src', 'x.js'), 'old content\n');
      fs.writeFileSync(path.join(temp, 'src', 'reg.js'), '// registration\n');
      fs.writeFileSync(path.join(temp, 'package.json'), '{"name":"test","scripts":{"test":"echo ok"}}');
      return Promise.resolve({ ok: true, dir: temp });
    },
    _callCount: callCount
  };
  Object.keys(overrides || {}).forEach(function(k) {
    if (k === '_callCount') Object.keys(overrides[k]).forEach(function(c) { deps._callCount[c] = overrides[k][c]; });
    else if (typeof overrides[k] === 'object' && overrides[k] !== null) {
      Object.keys(overrides[k]).forEach(function(j) { deps[k][j] = overrides[k][j]; });
    } else deps[k] = overrides[k];
  });
  return deps;
}

// =============================================================================
// FIX 2: sync/async runCommand (promiseRunCommand wrapper)
// =============================================================================

test('promiseRunCommand: sync plain object and Promise both work for git calls (unit)', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test"}'
  });

  var finding = {
    class: 'TypeError', message: 'boom', domain: 'target-code',
    signature: 'sig-sync-async-' + Date.now()
  };

  var syncDeps = createFakeDeps();
  syncDeps.runCommand = function(cmd, args, opts) {
    // Return a plain object (sync), not a Promise
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
  syncDeps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'fix the bug',
    edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new content' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-sync-async-' + Date.now(),
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: syncDeps
  });

  assert.strictEqual(result.status, 'READY', 'sync runCommand result must yield READY: ' + result.status);
});

test('promiseRunCommand: Promise-returning runCommand also works for git calls (unit)', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'package.json': '{"name":"test"}'
  });

  var finding = {
    class: 'TypeError', message: 'boom', domain: 'target-code',
    signature: 'sig-async-' + Date.now()
  };

  var asyncDeps = createFakeDeps();
  asyncDeps.runCommand = function(cmd, args, opts) {
    // Return a Promise (async)
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  asyncDeps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'fix the bug',
    edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new content' }],
    newFiles: []
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: 'test-async-' + Date.now(),
    cloneDir: dir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: {},
    deps: asyncDeps
  });

  assert.strictEqual(result.status, 'READY', 'async runCommand must yield READY: ' + result.status);
});

test('promiseRunCommand: integration with real git repo (real runCommand)', async function() {
  // Create a real git repo with tracked files
  var repoDir = tempDir();
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'x.js'), 'original line\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'src', 'reg.js'), '// registration\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"test"}', 'utf8');

  // Initialize git repo and make initial commit
  var initResult = require('child_process').spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' });
  assert.strictEqual(initResult.status, 0, 'git init must succeed');

  var configResult = require('child_process').spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, encoding: 'utf8' });
  require('child_process').spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, encoding: 'utf8' });

  var addResult = require('child_process').spawnSync('git', ['add', '.'], { cwd: repoDir, encoding: 'utf8' });
  assert.strictEqual(addResult.status, 0, 'git add must succeed');

  var commitResult = require('child_process').spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, encoding: 'utf8' });
  assert.strictEqual(commitResult.status, 0, 'initial commit must succeed: ' + commitResult.stderr);

  var headResult = require('child_process').spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
  var baseSha = headResult.stdout.trim();
  assert.ok(baseSha.length > 0, 'baseSha must be non-empty');

  var runId = 'test-real-git-' + Date.now();

  var finding = {
    class: 'TypeError', message: 'boom', domain: 'target-code',
    signature: 'sig-real-git-' + Date.now()
  };

  // Use default deps with the default runCommand (defaultRunCommand from run-repair.mjs)
  // This uses child_process.spawnSync which is the real git runner
  var deps = createFakeDeps();
  // Override scratchCopy to just return the real repo dir (not a copy)
  deps.scratchCopy = function(rootDir, runId, runCommand) {
    return Promise.resolve({ ok: true, dir: repoDir });
  };
  // Override runCommand to use real spawnSync
  var childProcess = require('node:child_process');
  deps.runCommand = function(cmd, args, opts) {
    return Promise.resolve().then(function() {
      var result = childProcess.spawnSync(cmd, args, {
        cwd: opts && opts.cwd,
        env: opts && opts.env,
        encoding: 'utf8',
        timeout: 30000
      });
      return {
        success: result.status === 0,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status,
        error: result.error ? result.error.message : null
      };
    });
  };
  // For integration test: use the real git object (gitClient) but ensure we get
  // real git diff output. Override git.diffText to pass through to real gitClient
  // with the injected runCommand, not gitClient's internal closure runCommand.
  var realGitClient = require('../src/repair/gitClient');
  deps.git = {
    createBranch: function(dir, branch, opts) {
      return realGitClient.createBranch(dir, branch, { runCommand: deps.runCommand });
    },
    commitAll: function(dir, msg, opts) {
      return realGitClient.commitAll(dir, msg, { runCommand: deps.runCommand });
    },
    getHeadSha: function(dir, opts) {
      return realGitClient.getHeadSha(dir, { runCommand: deps.runCommand });
    },
    diffStat: function(dir, baseSha, opts) {
      return realGitClient.diffStat(dir, baseSha, opts || {}, { runCommand: deps.runCommand });
    },
    diffText: function(dir, baseSha, maxBytes, opts) {
      return realGitClient.diffText(dir, baseSha, maxBytes, { runCommand: deps.runCommand });
    }
  };
  deps._modelResponse = JSON.stringify({
    repairKind: 'local-wrapper',
    rationale: 'wrap the bug with real working code',
    edits: [{ path: 'src/reg.js', oldString: '// registration', newString: '// registered' }],
    newFiles: [{ path: 'src/wrapper.js', content: '// wrapper module\nmodule.exports = function() { return true; };\n' }]
  });

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(repoDir, 'src', 'x.js'), line: 1, snippet: [{ line: 'original line' }] }],
    previousAttempts: [],
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: repoDir,
    branch: 'codex/pipeline-fix-test',
    baseSha: baseSha,
    env: {},
    deps: deps
  });

  assert.strictEqual(result.status, 'READY', 'real git runCommand must yield READY, got: ' + result.status);
  assert.ok(result.headSha && result.headSha.length > 0, 'headSha must be non-empty: ' + (result.headSha || 'null'));
  assert.ok(result.diffStat && result.diffStat.length > 0, 'diffStat must be non-empty: ' + (result.diffStat || 'null'));
  // diffText shows tracked-file changes (src/reg.js edited to // registered); new
  // untracked src/wrapper.js is not in git diff SHA output
  assert.ok(result.diffText && result.diffText.indexOf('src/reg.js') !== -1, 'diffText must contain edited file src/reg.js: ' + (result.diffText || '').substring(0, 200));
  assert.ok(result.diffText && result.diffText.indexOf('// registered') !== -1, 'diffText must contain the edit content // registered');

  // Cleanup
  try { fs.rmSync(repoDir, { recursive: true }); } catch (e) {}
});

// =============================================================================
// FIX 3: Evidence before commit (writeBeforeCommitEvidence, proposalSummaryOf)
// =============================================================================

test('proposalSummaryOf: extracts repairKind, editPaths, newFilePaths from editSet', function() {
  var editSet = {
    repairKind: 'local-wrapper',
    edits: [
      { path: 'src/reg.js', oldString: 'old', newString: 'new' },
      { path: 'src/app.js', oldString: 'a', newString: 'b' }
    ],
    newFiles: [
      { path: 'src/wrapper.js', content: '// wrapper' }
    ]
  };
  var summary = proposalSummaryOf(editSet, null);
  assert.strictEqual(summary.repairKind, 'local-wrapper');
  assert.deepStrictEqual(summary.editPaths, ['src/reg.js', 'src/app.js']);
  assert.deepStrictEqual(summary.newFilePaths, ['src/wrapper.js']);
});

test('proposalSummaryOf: falls back to requestedPaths when editSet has no paths', function() {
  var editSet = { repairKind: 'source-edit' };
  var requestedPaths = ['src/x.js', 'src/y.js'];
  var summary = proposalSummaryOf(editSet, requestedPaths);
  assert.strictEqual(summary.repairKind, 'source-edit');
  assert.deepStrictEqual(summary.editPaths, ['src/x.js', 'src/y.js']);
  assert.deepStrictEqual(summary.newFilePaths, []);
});

test('proposalSummaryOf: handles null/undefined editSet gracefully', function() {
  var summary1 = proposalSummaryOf(null, ['src/x.js']);
  assert.strictEqual(summary1.repairKind, null);
  assert.deepStrictEqual(summary1.editPaths, ['src/x.js']);

  var summary2 = proposalSummaryOf({ edits: null, newFiles: null }, ['src/y.js']);
  assert.deepStrictEqual(summary2.editPaths, ['src/y.js']);
});

// =============================================================================
// Evidence: attempt-N.json exists BEFORE commit with full fields
// =============================================================================

test('evidence: attempt-1.json written BEFORE commit with status, codes, paths, model, provider, proposalSummary, stage', async function() {
  var dir = createTempProject({
    'src/x.js': 'old\n',
    'src/reg.js': '// reg\n',
    'package.json': '{"name":"test","scripts":{"test":"echo ok"}}'
  });

  var runId = 'test-evid-before-' + Date.now();
  // Pre-create the evidence directory so writeAttemptSummary (best-effort) succeeds
  fs.mkdirSync(path.join('evidence', runId, 'repair'), { recursive: true });

  var finding = {
    class: 'TypeError', message: 'boom', domain: 'target-code',
    signature: 'sig-evid-' + Date.now()
  };

  var deps = createFakeDeps();
  deps._modelResponse = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'fix',
    edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new' }],
    newFiles: [{ path: 'src/newfile.js', content: '// new\n' }]
  });
  deps.now = function() { return '2024-06-01T12:00:00.000Z'; };

  var result = await proposeAndCheck({
    finding: finding,
    candidates: [{ file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old' }] }],
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

  // Check evidence/attempt-N.json
  var attemptPath = path.join('evidence', runId, 'repair', 'attempt-1.json');
  assert.ok(fs.existsSync(attemptPath), 'attempt-1.json must exist at: ' + attemptPath);

  var attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  assert.strictEqual(attempt.attempt, 1, 'attempt number must be 1');
  assert.strictEqual(attempt.status, 'READY', 'status must be READY');
  assert.deepStrictEqual(attempt.codes, [], 'codes must be empty');
  assert.ok(Array.isArray(attempt.requestedPaths) && attempt.requestedPaths.length > 0, 'requestedPaths must be non-empty array');
  assert.strictEqual(typeof attempt.model === 'string' || attempt.model === null, true, 'model field must be string or null');
  assert.strictEqual(typeof attempt.provider === 'string' || attempt.provider === null, true, 'provider field must be string or null');
  assert.ok(attempt.proposalSummary && typeof attempt.proposalSummary === 'object', 'proposalSummary must be present');
  assert.strictEqual(attempt.proposalSummary.repairKind, 'source-edit');
  assert.deepStrictEqual(attempt.proposalSummary.editPaths, ['src/x.js']);
  assert.deepStrictEqual(attempt.proposalSummary.newFilePaths, ['src/newfile.js']);
  assert.strictEqual(attempt.stage, 'ready', 'stage must be "ready" for successful completion');
  assert.strictEqual(typeof attempt.timestamp === 'string' && attempt.timestamp.length > 0, true, 'timestamp must be non-empty string');
});

// =============================================================================
// Evidence: crash in each stage records stage name and crash field
// =============================================================================

function makeCrashTest(stageName, crashInjection) {
  return async function() {
    var dir = createTempProject({
      'src/x.js': 'old\n',
      'src/reg.js': '// reg\n',
      'package.json': '{"name":"test"}'
    });

    var runId = 'test-crash-' + stageName + '-' + Date.now();
    // Pre-create the evidence directory so writeAttemptSummary (best-effort) succeeds
    fs.mkdirSync(path.join('evidence', runId, 'repair'), { recursive: true });

    var finding = {
      class: 'TypeError', message: 'boom', domain: 'target-code',
      signature: 'sig-crash-' + stageName + '-' + Date.now()
    };

    var deps = createFakeDeps();
    deps._modelResponse = JSON.stringify({
      repairKind: 'source-edit',
      rationale: 'fix',
      edits: [{ path: 'src/x.js', oldString: 'old', newString: 'new' }],
      newFiles: [{ path: 'src/newfile.js', content: '// new\n' }]
    });
    crashInjection(deps);

    var caughtError = null;
    try {
      await proposeAndCheck({
        finding: finding,
        candidates: [{ file: path.join(dir, 'src/x.js'), line: 1, snippet: [{ line: 'old' }] }],
        previousAttempts: [],
        budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
        runId: runId,
        cloneDir: dir,
        branch: 'codex/pipeline-fix-test',
        baseSha: 'abc123',
        env: {},
        deps: deps
      });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(caughtError !== null, stageName + ' crash must throw');

    var attemptPath = path.join('evidence', runId, 'repair', 'attempt-1.json');
    assert.ok(fs.existsSync(attemptPath), stageName + ': attempt-1.json must exist (not only attempt-error.json)');

    var attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
    assert.strictEqual(attempt.status, 'CRASH', stageName + ': status must be CRASH');
    assert.ok(Array.isArray(attempt.codes) && attempt.codes.indexOf('CRASH') !== -1, stageName + ': codes must include CRASH');
    assert.strictEqual(attempt.stage, stageName === 'commit' ? 'before-commit' : stageName, stageName + ': stage must be "' + stageName + '" or "before-commit" for commit crash');
    assert.ok(attempt.crash && typeof attempt.crash === 'object', stageName + ': crash field must be object');
    assert.strictEqual(attempt.crash.stage, stageName === 'commit' ? 'commit' : stageName, stageName + ': crash.stage must be "' + stageName + '"');
    assert.ok(typeof attempt.crash.message === 'string' && attempt.crash.message.length > 0, stageName + ': crash.message must be non-empty string');
    assert.ok(attempt.proposalSummary && attempt.proposalSummary.repairKind === 'source-edit', stageName + ': proposalSummary must be present');
  };
}

test('crash in apply stage: attempt-1.json has CRASH, stage=apply, crash.field', makeCrashTest('apply', function(deps) {
  deps.applier.apply = function(editSet, opts) {
    throw new Error('simulated apply crash');
  };
}));

test('crash in checks stage: attempt-1.json has CRASH, stage=checks, crash.field', makeCrashTest('checks', function(deps) {
  deps.verifier.runChecks = function(cloneDir, opts) {
    return Promise.reject(new Error('simulated checks crash'));
  };
}));

test('crash in commit stage: attempt-1.json has CRASH, stage=commit, crash.field', makeCrashTest('commit', function(deps) {
  deps.git.commitAll = function(dir, msg, opts) {
    return Promise.reject(new Error('simulated commit crash'));
  };
}));

test('crash in get-head-sha stage: attempt-1.json has CRASH, stage=get-head-sha, crash.field', makeCrashTest('get-head-sha', function(deps) {
  deps.git.getHeadSha = function(dir, opts) {
    return Promise.reject(new Error('simulated getHeadSha crash'));
  };
}));

test('crash in diff-stat stage: attempt-1.json has CRASH, stage=diff-stat, crash.field', makeCrashTest('diff-stat', function(deps) {
  deps.git.diffStat = function(dir, baseSha, opts) {
    return Promise.reject(new Error('simulated diffStat crash'));
  };
}));

test('crash in diff-text stage: attempt-1.json has CRASH, stage=diff-text, crash.field', makeCrashTest('diff-text', function(deps) {
  deps.git.diffText = function(dir, baseSha, limit, opts) {
    return Promise.reject(new Error('simulated diffText crash'));
  };
}));

// =============================================================================
// FIX 1 (partial): validateProposalPaths - src/patches/ newFile accepted
// =============================================================================

test('validateProposalPaths: src/patches/x.ts newFile accepted for source-edit (appSourceNewFile)', function() {
  var tmpDir = createTempProject({});
  fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');

  var editSet = {
    repairKind: 'source-edit',
    edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
    newFiles: [{ path: 'src/patches/x.ts', content: '// patch\n' }]
  };

  var candidates = [{ file: path.join(tmpDir, 'src', 'x.js'), line: 1, snippet: [{ line: 'x' }] }];
  var result = validateProposalPaths(editSet, candidates, tmpDir, { dependencyPatch: false });

  assert.strictEqual(result.ok, true, 'src/patches/x.ts must be accepted for source-edit: ' + (result.offending || []).join('; '));
});

test('validateProposalPaths: src/patches/x.ts newFile accepted for local-wrapper (appSourceNewFile)', function() {
  var tmpDir = createTempProject({});
  fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'reg.js'), '// reg\n', 'utf8');

  var editSet = {
    repairKind: 'local-wrapper',
    edits: [{ path: 'src/reg.js', oldString: '// reg', newString: '// registered' }],
    newFiles: [{ path: 'src/patches/wrapper.ts', content: '// wrapper\n' }]
  };

  var candidates = [{ file: path.join(tmpDir, 'src', 'reg.js'), line: 1, snippet: [{ line: '// reg' }] }];
  var result = validateProposalPaths(editSet, candidates, tmpDir, { dependencyPatch: false });

  assert.strictEqual(result.ok, true, 'src/patches/wrapper.ts must be accepted for local-wrapper: ' + (result.offending || []).join('; '));
});

test('validateProposalPaths: src/foo/patches/x.ts newFile accepted (not top-level patches/)', function() {
  var tmpDir = createTempProject({});
  fs.mkdirSync(path.join(tmpDir, 'src', 'foo', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');

  var editSet = {
    repairKind: 'source-edit',
    edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
    newFiles: [{ path: 'src/foo/patches/x.ts', content: '// nested patch\n' }]
  };

  var candidates = [{ file: path.join(tmpDir, 'src', 'x.js'), line: 1, snippet: [{ line: 'x' }] }];
  var result = validateProposalPaths(editSet, candidates, tmpDir, { dependencyPatch: false });

  assert.strictEqual(result.ok, true, 'src/foo/patches/x.ts must be accepted: ' + (result.offending || []).join('; '));
});

test('validateProposalPaths: top-level patches/x.patch newFile rejected when dependencyPatch=false', function() {
  var tmpDir = createTempProject({});
  fs.mkdirSync(path.join(tmpDir, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');

  var editSet = {
    repairKind: 'source-edit',
    edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
    newFiles: [{ path: 'patches/foo.patch', content: 'diff --git a/x b/x\n' }]
  };

  var candidates = [{ file: path.join(tmpDir, 'src', 'x.js'), line: 1, snippet: [{ line: 'x' }] }];
  var result = validateProposalPaths(editSet, candidates, tmpDir, { dependencyPatch: false });

  assert.strictEqual(result.ok, false, 'patches/foo.patch must be rejected when dependencyPatch=false');
  assert.ok(result.offending && result.offending.indexOf('patches/foo.patch') !== -1, 'patches/foo.patch must be in offending list');
});