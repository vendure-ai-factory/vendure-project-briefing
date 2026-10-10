'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');

var test = require('node:test');
var assert = require('node:assert');

var commandRunner = require('../src/tools/commandRunner');
var patchModule = require('../src/tools/patch');
var checkpointModule = require('../src/tools/checkpoint');

var TEST_REPO_ROOT = path.join(os.tmpdir(), 'controlled-tools-test-' + Date.now());
var testFilePath = path.join(TEST_REPO_ROOT, 'test.txt');
var testScriptPath = path.join(TEST_REPO_ROOT, 'test-script.js');

function setupTempRepo() {
  try { fs.rmSync(TEST_REPO_ROOT, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(TEST_REPO_ROOT, { recursive: true });
  childProcess.execFileSync('git', ['init'], { cwd: TEST_REPO_ROOT, stdio: 'pipe' });
  childProcess.execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: TEST_REPO_ROOT, stdio: 'pipe' });
  childProcess.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: TEST_REPO_ROOT, stdio: 'pipe' });
}

function writeFile(relPath, content) {
  var fullPath = path.join(TEST_REPO_ROOT, relPath);
  var dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function readFile(relPath) {
  return fs.readFileSync(path.join(TEST_REPO_ROOT, relPath), 'utf8');
}

setupTempRepo();
writeFile('README.md', '# Test\nInitial content.\n');
childProcess.execFileSync('git', ['add', '.'], { cwd: TEST_REPO_ROOT, stdio: 'pipe' });
childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: TEST_REPO_ROOT, stdio: 'pipe' });

test('commandRunner: setWorkspaceRoot works', function(t, done) {
  commandRunner.setWorkspaceRoot(TEST_REPO_ROOT);
  done();
});

test('commandRunner: allowed command node runs', function(t, done) {
  var result = commandRunner.runCommandSync('node', ['--version']);
  assert.strictEqual(result.success, true, 'node --version should succeed');
  assert.ok(result.stdout, 'Should have stdout');
  done();
});

test('commandRunner: disallowed command rejected', function(t, done) {
  var result = commandRunner.runCommandSync('curl', ['--version']);
  assert.strictEqual(result.success, false, 'curl should be rejected');
  assert.strictEqual(result.errorCode, 'COMMAND_NOT_ALLOWED', 'Error code should be COMMAND_NOT_ALLOWED');
  done();
});

test('commandRunner: git allowed', function(t, done) {
  var result = commandRunner.runCommandSync('git', ['--version']);
  assert.strictEqual(result.success, true, 'git --version should succeed (allowlisted)');
  done();
});

test('commandRunner: cwd outside workspace is rejected', function(t, done) {
  commandRunner.setWorkspaceRoot(TEST_REPO_ROOT);
  var result = commandRunner.runCommandSync('git', ['--version'], { cwd: os.tmpdir() });
  assert.strictEqual(result.success, false, 'Command outside workspace should be rejected');
  assert.strictEqual(result.errorCode, 'CWD_OUTSIDE_WORKSPACE');
  done();
});

test('commandRunner: shell string with && is rejected', function(t, done) {
  commandRunner.setWorkspaceRoot(TEST_REPO_ROOT);
  var result = commandRunner.runCommandSync('node', ['-e', 'console.log("a") && console.log("b")']);
  assert.strictEqual(result.success, false, 'Shell string should be rejected');
  assert.strictEqual(result.errorCode, 'SHELL_STRING_REJECTED');
  done();
});

test('commandRunner: shell string with semicolon is rejected', function(t, done) {
  commandRunner.setWorkspaceRoot(TEST_REPO_ROOT);
  var result = commandRunner.runCommandSync('node', ['-e', 'console.log("a"); console.log("b")']);
  assert.strictEqual(result.success, false, 'Semicolon in arg should be rejected');
  assert.strictEqual(result.errorCode, 'SHELL_STRING_REJECTED');
  done();
});

test('commandRunner: rejectShellString detects &&', function(t, done) {
  var result = commandRunner.rejectShellString('git', ['commit', '-m', 'a && b']);
  assert.strictEqual(result, true, '&& in arg should be detected');
  done();
});

test('commandRunner: rejectShellString detects semicolon', function(t, done) {
  var result = commandRunner.rejectShellString('node', ['-e', 'x; y']);
  assert.strictEqual(result, true, '; in arg should be detected');
  done();
});

test('commandRunner: registered script path is allowed', function(t, done) {
  writeFile('my-script.sh', '#!/bin/bash\necho hello');
  commandRunner.registerAllowedScriptPath(path.join(TEST_REPO_ROOT, 'my-script.sh'));
  var allowed = commandRunner.getAllowedScriptPaths();
  assert.ok(allowed.some(function(p) { return p.endsWith('my-script.sh'); }), 'Script should be registered');
  done();
});

test('patch: setWorkspaceRoot works', function(t, done) {
  patchModule.setWorkspaceRoot(TEST_REPO_ROOT);
  done();
});

test('patch: write to new file inside workspace succeeds', function(t, done) {
  var result = patchModule.applyPatch(path.join(TEST_REPO_ROOT, 'new-file.txt'), 'new content');
  assert.strictEqual(result.success, true, 'Patch to new file should succeed');
  assert.ok(result.diff, 'Should return diff');
  done();
});

test('patch: replaceInFile replaces exact text', function(t, done) {
  writeFile('target.txt', 'line one\nline two\nline three');
  var result = patchModule.replaceInFile(
    path.join(TEST_REPO_ROOT, 'target.txt'),
    'line two',
    'line two MODIFIED'
  );
  assert.strictEqual(result.success, true, 'Replace should succeed');
  assert.ok(result.diff, 'Should return diff');
  var content = readFile('target.txt');
  assert.ok(content.indexOf('line two MODIFIED') !== -1, 'Content should be modified');
  done();
});

test('patch: protected path AGENTS.md is rejected', function(t, done) {
  var check = patchModule.isPathProtected('AGENTS.md');
  assert.strictEqual(check.protected, true, 'AGENTS.md should be protected');
  done();
});

test('patch: protected path .env is rejected', function(t, done) {
  var check = patchModule.isPathProtected('.env');
  assert.strictEqual(check.protected, true, '.env should be protected');
  done();
});

test('patch: protected path acceptance-manifest is rejected', function(t, done) {
  var check = patchModule.isPathProtected('acceptance-manifest.json');
  assert.strictEqual(check.protected, true, 'acceptance-manifest.json should be protected');
  done();
});

test('patch: protected path manifest/ is rejected', function(t, done) {
  var check = patchModule.isPathProtected('manifest/tasks.json');
  assert.strictEqual(check.protected, true, 'manifest/ path should be protected');
  done();
});

test('patch: protected path evaluation-demo/migration-input/ is rejected', function(t, done) {
  var check = patchModule.isPathProtected('evaluation-demo/migration-input/legacy/vendure-store');
  assert.strictEqual(check.protected, true, 'migration-input path should be protected');
  done();
});

test('patch: patch to protected path returns error and file unchanged', function(t, done) {
  writeFile('acceptance-manifest.json', '{"version":"1.0"}');
  var result = patchModule.applyPatch(path.join(TEST_REPO_ROOT, 'acceptance-manifest.json'), '{"version":"2.0"}');
  assert.strictEqual(result.success, false, 'Protected path should be rejected');
  assert.strictEqual(result.errorCode, 'PROTECTED_PATH_REJECTED');
  var content = readFile('acceptance-manifest.json');
  assert.strictEqual(content, '{"version":"1.0"}', 'File should be unchanged');
  done();
});

test('patch: path outside workspace is rejected', function(t, done) {
  patchModule.setWorkspaceRoot(TEST_REPO_ROOT);
  var result = patchModule.applyPatch(path.join(os.tmpdir(), 'outside.txt'), 'content');
  assert.strictEqual(result.success, false, 'Outside workspace should be rejected');
  assert.strictEqual(result.errorCode, 'PATH_OUTSIDE_WORKSPACE');
  done();
});

test('checkpoint: setRepoRoot works', function(t, done) {
  checkpointModule.setRepoRoot(TEST_REPO_ROOT);
  done();
});

test('checkpoint: createCheckpoint returns commit hash and revision id', function(t, done) {
  writeFile('checkpoint-test.txt', 'changes will be committed');
  var result = checkpointModule.createCheckpoint('test label');
  assert.strictEqual(result.success, true, 'Checkpoint should succeed');
  assert.ok(result.commitHash, 'Should have commitHash');
  assert.ok(result.revisionId, 'Should have revisionId');
  assert.ok(result.revisionId.startsWith('rev-'), 'RevisionId should start with rev-');
  done();
});

test('checkpoint: diffSince shows changes after checkpoint', function(t, done) {
  writeFile('diff-test.txt', 'diff baseline content');
  var cp = checkpointModule.createCheckpoint('before diff test');
  assert.strictEqual(cp.success, true, 'Checkpoint should succeed');

  writeFile('diff-test.txt', 'this is the new content that is different');
  var commitResult = childProcess.execFileSync('git', ['commit', '-a', '-m', 'change after checkpoint'], { cwd: TEST_REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });

  var diff = checkpointModule.diffSince(cp.commitHash);
  assert.strictEqual(diff.success, true, 'diffSince should succeed');
  assert.strictEqual(diff.hasChanges, true, 'Should detect changes');
  assert.ok(diff.diff.length > 0, 'Diff should have content');
  done();
});

test('checkpoint: diffSince on clean tree returns empty diff', function(t, done) {
  writeFile('clean-test.txt', 'clean content');
  var cp = checkpointModule.createCheckpoint('before clean');
  assert.strictEqual(cp.success, true, 'Checkpoint should succeed');

  var diff = checkpointModule.diffSince(cp.commitHash);
  assert.strictEqual(diff.success, true, 'diffSince should succeed');
  assert.strictEqual(diff.hasChanges, false, 'Should have no changes');
  done();
});

test('checkpoint: resetTo restores file content', function(t, done) {
  writeFile('reset-test.txt', 'original reset content');
  var cp = checkpointModule.createCheckpoint('before reset modification');
  assert.strictEqual(cp.success, true, 'Checkpoint should succeed');

  writeFile('reset-test.txt', 'MODIFIED reset content');
  var contentBefore = readFile('reset-test.txt');
  assert.ok(contentBefore.indexOf('MODIFIED') !== -1, 'Content should be modified before reset');

  var reset = checkpointModule.resetTo(cp.commitHash);
  assert.strictEqual(reset.success, true, 'Reset should succeed');
  assert.strictEqual(reset.resetTo, cp.commitHash, 'Should return hash that was reset to');

  var contentAfter = readFile('reset-test.txt');
  assert.strictEqual(contentAfter, 'original reset content', 'Content should be restored after reset');
  done();
});

test('checkpoint: after reset, diffSince returns empty', function(t, done) {
  writeFile('empty-diff-test.txt', 'baseline');
  var cp = checkpointModule.createCheckpoint('baseline');
  assert.strictEqual(cp.success, true, 'Checkpoint should succeed');

  writeFile('empty-diff-test.txt', 'modified');
  var reset = checkpointModule.resetTo(cp.commitHash);
  assert.strictEqual(reset.success, true, 'Reset should succeed');

  var diff = checkpointModule.diffSince(cp.commitHash);
  assert.strictEqual(diff.success, true, 'diffSince should succeed');
  assert.strictEqual(diff.hasChanges, false, 'Should have no changes after reset');
  done();
});

test('fetch is never invoked (no network calls in tests)', function(t, done) {
  var fetchUsed = false;
  var originalFetch = globalThis.fetch;
  try {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      set: function(v) { fetchUsed = true; },
      get: function() { fetchUsed = true; return function() {}; }
    });
    commandRunner.runCommandSync('git', ['--version']);
    assert.strictEqual(fetchUsed, false, 'fetch should not be invoked by commandRunner');
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: originalFetch
    });
  }
  done();
});

test.after(function() {
  try { fs.rmSync(TEST_REPO_ROOT, { recursive: true, force: true }); } catch (e) {}
});
