'use strict';

var test = require('node:test');
var assert = require('node:assert');

var runEnvModule = require('../src/runEnv');

test('runEnv: collectRunEnvironment produces record with required fields', function(t, done) {
  var deps = {
    fs: require('fs'),
    path: require('path'),
    childProcess: require('child_process'),
    root: process.cwd()
  };
  var record = runEnvModule.collectRunEnvironment(deps);
  assert.ok(record.runId !== undefined, 'should have runId');
  assert.ok(record.revisionId !== undefined, 'should have revisionId');
  assert.ok(record.startedAt !== undefined, 'should have startedAt');
  assert.ok(record.nodeVersion !== undefined, 'should have nodeVersion');
  assert.ok(record.platform !== undefined, 'should have platform');
  assert.ok(record.taskId !== undefined, 'should have taskId');
  done();
});

test('runEnv: collectRunEnvironment records env vars checked', function(t, done) {
  var record = { envVarsChecked: [] };
  runEnvModule.addEnvVarChecked(record, 'TEST_VAR', true);
  runEnvModule.addEnvVarChecked(record, 'ANOTHER_VAR', false);
  assert.strictEqual(record.envVarsChecked.length, 2);
  assert.strictEqual(record.envVarsChecked[0].name, 'TEST_VAR');
  assert.strictEqual(record.envVarsChecked[0].present, true);
  assert.strictEqual(record.envVarsChecked[1].name, 'ANOTHER_VAR');
  assert.strictEqual(record.envVarsChecked[1].present, false);
  done();
});

test('runEnv: addEnvVarChecked does not add duplicates', function(t, done) {
  var record = { envVarsChecked: [{ name: 'VAR1', present: true }] };
  runEnvModule.addEnvVarChecked(record, 'VAR1', false);
  assert.strictEqual(record.envVarsChecked.length, 1);
  done();
});

test('runEnv: getGitHead returns {hash, error} object when in git repo', function(t, done) {
  var childProcess = require('child_process');
  var result = runEnvModule.getGitHead(process.cwd(), childProcess);
  if (result && result.hash) {
    assert.strictEqual(typeof result.hash, 'string');
    assert.strictEqual(result.hash.length, 40);
    assert.strictEqual(result.error, null);
  }
  done();
});

test('runEnv: getGitHead returns {hash: null, error} outside git repo', function(t, done) {
  var childProcess = {
    execFileSync: function() { throw new Error('not a git repo'); }
  };
  var result = runEnvModule.getGitHead('/tmp', childProcess);
  assert.strictEqual(result.hash, null);
  assert.ok(result.error);
  done();
});

test('runEnv: getTreeHash returns null for invalid path', function(t, done) {
  var childProcess = {
    execFileSync: function() { throw new Error('path not found'); }
  };
  var result = runEnvModule.getTreeHash('/nonexistent/path', 'evaluation-demo/migration-input', 'HEAD', childProcess);
  assert.strictEqual(result, null);
  done();
});

test('runEnv: treeHashComparison is set when both hashes available', function(t, done) {
  var deps = {
    fs: require('fs'),
    path: require('path'),
    childProcess: require('child_process'),
    root: process.cwd(),
    manifest: {
      source: { pinnedExecutionCommit: 'abc123', pinnedRepoCommit: 'abc123' },
      manifestVersion: '0.4',
      integrity: { expectedValuesHash: 'abc' }
    }
  };
  var record = runEnvModule.collectRunEnvironment(deps);
  if (record.migrationInputTreeHashAtHead && record.migrationInputTreeHashAtPinned) {
    assert.ok(record.treeHashComparison === 'MATCH' || record.treeHashComparison === 'DIFFER');
  }
  done();
});

test('runEnv: treeHashComparison is null when pinned commit not set', function(t, done) {
  var deps = {
    fs: require('fs'),
    path: require('path'),
    childProcess: require('child_process'),
    root: process.cwd(),
    manifest: {
      source: { pinnedExecutionCommit: null, pinnedRepoCommit: null },
      manifestVersion: '0.4',
      integrity: {}
    }
  };
  var record = runEnvModule.collectRunEnvironment(deps);
  assert.strictEqual(record.treeHashComparison, null);
  done();
});