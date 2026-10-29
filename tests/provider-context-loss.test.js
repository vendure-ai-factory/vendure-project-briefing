'use strict';

/**
 * Tests for:
 *  1. EMPTY_PROPOSAL with a context-loss rationale is treated as
 *     PROVIDER_CONTEXT_LOSS: add the provider to env.provider.ignore, retry the
 *     same attempt on another provider WITHOUT consuming the per-signature
 *     attempt, cap at 3 provider switches per attempt.
 *  2. Rejected proposals are saved (redacted) as proposal-N-rejected.json with
 *     each edit's oldString and the first 60 lines of the target file.
 *  3. OLDSTRING_NOT_FOUND re-ask includes the exact current file text so the
 *     model can copy oldString verbatim.
 * All tests use injected fake model responses; no network.
 */

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

var proposeAndCheck = require('../src/repair/proposeAndCheck').proposeAndCheck;
var patchApplier = require('../src/repair/patchApplier');

function tempDir() {
  return path.join(os.tmpdir(), 'ctxloss-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
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

function baseFakeDeps(overrides) {
  var callCount = { model: 0, consume: 0, apply: 0, runChecks: 0, commit: 0 };
  var deps = {
    git: {
      createBranch: function() { return Promise.resolve({ ok: true }); },
      commitAll: function(dir, msg, opts) { callCount.commit++; return Promise.resolve({ ok: true, dir: dir }); },
      getHeadSha: function() { return Promise.resolve({ ok: true, sha: 'abc123def456789012345678901234567890abcd' }); },
      diffStat: function() { return Promise.resolve({ ok: true, stat: '1 file changed' }); },
      diffText: function() { return Promise.resolve({ ok: true, text: '--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-old\n+new' }); }
    },
    model: {
      callModel: function(opts) {
        callCount.model++;
        deps._prompts = deps._prompts || [];
        deps._prompts.push(opts.prompt);
        if (deps._modelResponses && deps._modelResponses.length > 0) {
          return Promise.resolve(deps._modelResponses.shift());
        }
        return Promise.resolve({ ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'fix', edits: [], newFiles: [] }), usage: { total_tokens: 10 }, provider: 'defaultProvider' });
      },
      parseEditSet: function(text) {
        try { return { ok: true, editSet: JSON.parse(text) }; }
        catch (e) { return { ok: false, error: e.message }; }
      },
      consume: function(budget, sig) {
        callCount.consume++;
        if ((budget.total || 0) >= budget.global) return { ok: false, reason: 'global exhausted' };
        budget.total = (budget.total || 0) + 1;
        return { ok: true };
      }
    },
    budget: { perSignature: 3, global: 15, total: 0, bySignature: {} },
    validator: {
      validate: function(editSet, opts) {
        callCount.validate = callCount.validate || 0;
        callCount.validate++;
        return { ok: true, errors: [], stats: { fileCount: 1 } };
      },
      findClosestMatch: function(lines, oldString) {
        return require('../src/repair/patchValidator').findClosestMatch(lines, oldString);
      }
    },
    applier: {
      apply: function(editSet, opts) {
        callCount.apply++;
        var cloneDir = opts.cloneDir;
        (editSet.edits || []).forEach(function(edit) {
          var f = path.join(cloneDir, edit.path);
          if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(edit.oldString, edit.newString), 'utf8');
        });
        return { ok: true, filesChanged: ['src/x.js'], diffStats: {} };
      },
      restoreClone: function() { }
    },
    verifier: {
      runChecks: function() {
        callCount.runChecks++;
        return Promise.resolve({ ok: true, results: [{ script: 'test', success: true, exitCode: 0, stdout: 'ok', stderr: '' }] });
      }
    },
    runCommand: function() { return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 }); },
    fetch: function() { return Promise.resolve({ ok: false, blocker: { code: 'IO_NOT_INJECTED' } }); },
    now: function() { return '2024-01-01T00:00:00.000Z'; },
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
    if (typeof overrides[k] === 'object' && overrides[k] !== null) {
      Object.keys(overrides[k]).forEach(function(j) { deps[k][j] = overrides[k][j]; });
    } else deps[k] = overrides[k];
  });
  return deps;
}

function runPropose(opts) {
  var deps = opts.deps || baseFakeDeps();
  var runId = opts.runId || ('run-' + Date.now());
  return proposeAndCheck({
    finding: opts.finding || {
      class: 'TypeError', message: 'boom', domain: 'target-code',
      signature: opts.signature || ('sig-' + Date.now())
    },
    candidates: opts.candidates || [{ file: path.join(opts.cloneDir, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }] }],
    previousAttempts: [],
    budget: opts.budget || { perSignature: 3, global: 15, total: 0, bySignature: {} },
    runId: runId,
    cloneDir: opts.cloneDir,
    branch: 'codex/pipeline-fix-test',
    baseSha: 'abc123',
    env: opts.env || {},
    deps: deps
  });
}

// =============================================================================
// 1. PROVIDER_CONTEXT_LOSS: EMPTY_PROPOSAL with context-loss rationale
// =============================================================================

test('context-loss empty proposal switches provider, retries without double-consuming attempt, reaches READY', async function() {
  var dir = createTempProject({ 'src/x.js': 'old content\n' });
  var deps = baseFakeDeps();
  var responses = [
    { ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'No target file, bug description or prior edit context was included', edits: [], newFiles: [] }), usage: { total_tokens: 5 }, provider: 'badProvider' },
    { ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'fix the bug', edits: [{ path: 'src/x.js', oldString: 'old content', newString: 'new content' }], newFiles: [] }), usage: { total_tokens: 10 }, provider: 'goodProvider' }
  ];
  deps._modelResponses = responses.slice();
  var env = {};

  var result = await runPropose({ deps: deps, cloneDir: dir, env: env });

  assert.strictEqual(result.status, 'READY', 'context-loss switch must lead to READY: ' + result.status);
  assert.strictEqual(deps._callCount.model, 2, 'model must be called once for the context-loss hit and once for the retry');
  assert.strictEqual(deps._callCount.consume, 1, 'per-signature attempt must NOT be consumed again on provider switch');
  // The bad provider must be recorded in env.provider.ignore so later requests
  // avoid it for the rest of the run.
  assert.ok(env.provider && Array.isArray(env.provider.ignore), 'provider.ignore must be tracked in env');
  assert.ok(env.provider.ignore.indexOf('badProvider') !== -1, 'context-loss provider must be added to the ignore list');
});

test('context-loss empty proposal that persists is REJECTED with PROVIDER_CONTEXT_LOSS, capped at 3 switches', async function() {
  var dir = tempDir();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'old content\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"test","scripts":{"test":"echo ok"}}', 'utf8');
  var runId = 'run-ctx-persist-' + Date.now();

  var deps = baseFakeDeps();
  var responses = [];
  for (var i = 0; i < 4; i++) {
    responses.push({ ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'Context was not provided; no file or bug description was included', edits: [], newFiles: [] }), usage: { total_tokens: 5 }, provider: 'provider' + i });
  }
  deps._modelResponses = responses;

  var env = {};
  var result = await runPropose({ deps: deps, cloneDir: dir, env: env, runId: runId });

  assert.strictEqual(result.status, 'REJECTED', 'persistent context loss must be REJECTED');
  assert.strictEqual(result.rejectionCodes[0], 'PROVIDER_CONTEXT_LOSS', 'rejection code must be PROVIDER_CONTEXT_LOSS');
  assert.strictEqual(deps._callCount.model, 4, 'initial call + at most 3 provider switches');
  assert.ok(env.provider, 'env.provider must be initialized');
  assert.ok(Array.isArray(env.provider.ignore), 'provider.ignore must be an array');
  assert.strictEqual(env.provider.ignore.length, 3, 'three providers added to ignore list (capped at 3 switches)');

  // attempt-N.json records provider, switches and the reason.
  var attemptFile = path.join('evidence', runId, 'repair', 'attempt-1.json');
  assert.ok(fs.existsSync(attemptFile), 'attempt-1.json must exist');
  var attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
  assert.strictEqual(attempt.codes[0], 'PROVIDER_CONTEXT_LOSS');
  assert.strictEqual(attempt.providerSwitches, 3);
  assert.ok(attempt.contextLossProvider, 'attempt must record the context-loss provider');
  assert.ok(attempt.contextLossReason, 'attempt must record the context-loss reason');
  assert.match(String(attempt.contextLossReason), /not provided/);
});

test('EMPTY_PROPOSAL without context-loss rationale is NOT retried and rejected as EMPTY_PROPOSAL', async function() {
  var dir = createTempProject({ 'src/x.js': 'old content\n' });
  var deps = baseFakeDeps();
  var responses = [
    { ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'the fix is already applied elsewhere', edits: [], newFiles: [] }), usage: { total_tokens: 5 }, provider: 'soloProvider' }
  ];
  deps._modelResponses = responses;

  var env = {};
  var result = await runPropose({ deps: deps, cloneDir: dir, env: env });

  assert.strictEqual(result.status, 'REJECTED');
  assert.strictEqual(result.rejectionCodes[0], 'EMPTY_PROPOSAL', 'non-context-loss empty must stay EMPTY_PROPOSAL');
  assert.strictEqual(deps._callCount.model, 1, 'no provider switch for a non-context-loss empty');
  assert.strictEqual(deps._callCount.consume, 1, 'exactly one consume for a plain empty rejection');
});

// =============================================================================
// 2. Rejected proposals saved (redacted) with oldString + first 60 lines
// =============================================================================

test('validation-rejected proposal is saved as proposal-N-rejected.json with oldString and first 60 lines of the file', async function() {
  var dir = createTempProject({ 'src/x.js': 'line1\nline2\nline3\n' });
  var runId = 'run-rejected-' + Date.now();
  var deps = baseFakeDeps();
  deps.validator.validate = function(editSet, opts) {
    deps._callCount.validate = (deps._callCount.validate || 0) + 1;
    // Always reject with OLDSTRING_NOT_FOUND so the proposal is recorded.
    return { ok: false, errors: ['[OLDSTRING_NOT_FOUND] oldString not found in file: ' + path.join(opts.cloneDir, 'src', 'x.js')], stats: { fileCount: 1 } };
  };
  deps._modelResponses = [
    { ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'fix', edits: [{ path: 'src/x.js', oldString: 'WRONG_OLDS', newString: 'new' }], newFiles: [] }), usage: { total_tokens: 10 }, provider: 'pX' }
  ];
  var env = {};
  var result = await runPropose({ deps: deps, cloneDir: dir, env: env, runId: runId });

  assert.strictEqual(result.status, 'REJECTED', 'validation failure must reject');
  var rejectedFile = path.join('evidence', runId, 'repair', 'proposal-1-rejected.json');
  assert.ok(fs.existsSync(rejectedFile), 'proposal-1-rejected.json must be written: ' + rejectedFile);

  var rejected = JSON.parse(fs.readFileSync(rejectedFile, 'utf8'));
  assert.strictEqual(rejected.attempt, 1);
  assert.ok(rejected.editSet, 'rejected proposal must include the redacted editSet');
  assert.strictEqual(rejected.editSet.edits[0].oldString, 'WRONG_OLDS');
  assert.ok(Array.isArray(rejected.targetFilePreviews), 'targetFilePreviews must be an array');
  assert.strictEqual(rejected.targetFilePreviews.length, 1);
  assert.strictEqual(rejected.targetFilePreviews[0].path, 'src/x.js');
  assert.strictEqual(rejected.targetFilePreviews[0].oldString, 'WRONG_OLDS');
  assert.strictEqual(rejected.targetFilePreviews[0].preview, 'line1\nline2\nline3\n');
});

// =============================================================================
// 3. OLDSTRING_NOT_FOUND re-ask with exact file text -> copied verbatim
// =============================================================================

test('OLDSTRING_NOT_FOUND: re-ask with exact file text yields a corrected edit and READY', async function() {
  var dir = createTempProject({ 'src/x.js': 'old content\n' });
  var runId = 'run-osnf-' + Date.now();
  var deps = baseFakeDeps();

  var validationCallYieldsNotFound = true;
  deps.validator.validate = function(editSet, opts) {
    deps._callCount.validate = (deps._callCount.validate || 0) + 1;
    if (editSet.edits && editSet.edits[0] && editSet.edits[0].oldString === 'old content') {
      validationCallYieldsNotFound = false;
      return { ok: true, errors: [], stats: { fileCount: 1 } };
    }
    return { ok: false, errors: ['[OLDSTRING_NOT_FOUND] oldString not found in file: ' + path.join(opts.cloneDir, 'src', 'x.js')], stats: { fileCount: 1 } };
  };

  var responses = [
    { ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'try', edits: [{ path: 'src/x.js', oldString: 'WRONG', newString: 'new content' }], newFiles: [] }), usage: { total_tokens: 8 }, provider: 'pA' },
    { ok: true, text: JSON.stringify({ repairKind: 'source-edit', rationale: 'copy verbatim', edits: [{ path: 'src/x.js', oldString: 'old content', newString: 'new content' }], newFiles: [] }), usage: { total_tokens: 5 }, provider: 'pA' }
  ];
  deps._modelResponses = responses;
  deps._prompts = [];

  var result = await runPropose({ deps: deps, cloneDir: dir, env: {}, runId: runId });

  assert.strictEqual(result.status, 'READY', 'OLDSTRING_NOT_FOUND re-ask must reach READY: ' + result.status);
  assert.strictEqual(deps._callCount.model, 2, 're-ask is one extra model call');
  // The re-ask prompt must carry the exact file content.
  assert.ok(deps._prompts.length >= 2, 'must capture both prompts');
  var reAskPrompt = deps._prompts[1];
  assert.ok(reAskPrompt.indexOf('old content') !== -1, 're-ask prompt must contain the exact file text');
  assert.ok(reAskPrompt.indexOf('copy each oldString VERBATIM') !== -1, 're-ask prompt must say to copy verbatim');
  // ensure validation fallback function unset flag is not meaningful
  assert.strictEqual(validationCallYieldsNotFound, false, 'validator must accept the corrected oldString on re-ask');
});

// =============================================================================
// 4. Applier whitespace normalisation (indentation / trailing spaces / line endings)
// =============================================================================

test('applier: unique match after normalising indentation/trailing spaces/line endings is applied', function() {
  var dir = createTempProject({});
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), '  const a = 1;  \r\n\tconst b = 2;\n', 'utf8');

  // oldString has no leading indentation and no trailing spaces, CRLF in file.
  var r = patchApplier.applySourceEdit({
    repairKind: 'source-edit',
    edits: [{ path: 'src/x.js', oldString: 'const a = 1;', newString: 'const a = 42;' }],
    newFiles: []
  }, dir);

  assert.strictEqual(r.ok, true, 'unique normalised match must apply: ' + (r.blocker && r.blocker.message));
  var updated = fs.readFileSync(path.join(dir, 'src', 'x.js'), 'utf8');
  assert.ok(updated.indexOf('const a = 42;') !== -1, 'edit must be applied after normalising whitespace');
});

test('applier: non-unique normalised match is rejected', function() {
  var dir = createTempProject({});
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // two lines that only differ by indentation -> normalised match is ambiguous
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'const a = 1;\n  const a = 1;\n', 'utf8');

  var r = patchApplier.applySourceEdit({
    repairKind: 'source-edit',
    edits: [{ path: 'src/x.js', oldString: 'const a = 1;', newString: 'const a = 99;' }],
    newFiles: []
  }, dir);

  assert.strictEqual(r.ok, false, 'ambiguous normalised match must be rejected');
  assert.ok(r.blocker && r.blocker.message.indexOf('ambiguous') !== -1, 'reject message must mention ambiguity: ' + (r.blocker && r.blocker.message));
});

test('applier: no match at all (exact or normalised) is not found', function() {
  var dir = createTempProject({});
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'const a = 1;\n', 'utf8');

  var r = patchApplier.applySourceEdit({
    repairKind: 'source-edit',
    edits: [{ path: 'src/x.js', oldString: 'totally different', newString: 'nope' }],
    newFiles: []
  }, dir);

  assert.strictEqual(r.ok, false);
  assert.ok(r.blocker && r.blocker.message.indexOf('not found') !== -1, 'must report not found');
});

// =============================================================================
// 5. modelClient provider.order (REPAIR_PROVIDER_ORDER) and provider.ignore
// =============================================================================

test('modelClient: REPAIR_PROVIDER_ORDER maps to provider.order and provider.ignore is sent in the body', function() {
  var modelClient = require('../src/repair/modelClient');
  var capturedBody = null;
  return modelClient.callModel({
    prompt: 'hello',
    env: {
      OPENROUTER_API_KEY: 'tok',
      REPAIR_PROVIDER_ORDER: 'provider-b, provider-a',
      provider: { ignore: ['badProvider'] }
    },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedBody = opts.body;
      return Promise.resolve({ status: 200, ok: true, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, true);
    var body = JSON.parse(capturedBody);
    assert.strictEqual(body.provider.data_collection, 'deny', 'data_collection deny must be kept');
    assert.strictEqual(body.provider.require_parameters, true, 'require_parameters must be kept');
    assert.deepStrictEqual(body.provider.order, ['provider-b', 'provider-a']);
    assert.deepStrictEqual(body.provider.ignore, ['badProvider']);
  });
});
