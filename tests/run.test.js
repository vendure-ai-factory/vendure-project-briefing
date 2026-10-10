'use strict';

var runModule = require('../src/run');

var test = require('node:test');
var assert = require('node:assert');

test('run: run ID generated', function(t, done) {
  var runId = runModule.generateRunId();
  assert.ok(runId, 'Run ID should be generated');
  assert.ok(runId.startsWith('run-'), 'Run ID should start with "run-"');
  done();
});

test('run: revision ID generated', function(t, done) {
  var revisionId = runModule.generateRevisionId();
  assert.ok(revisionId, 'Revision ID should be generated');
  assert.ok(revisionId.startsWith('rev-'), 'Revision ID should start with "rev-"');
  done();
});

test('run: run contains required metadata', function(t, done) {
  var run = runModule.createRun({
    taskId: 'TASK-001'
  });

  assert.ok(run.runId, 'Run should have runId');
  assert.ok(run.revisionId, 'Run should have revisionId');
  assert.ok(run.startedAt, 'Run should have startedAt');
  assert.strictEqual(run.taskId, 'TASK-001', 'Run should have taskId');
  assert.strictEqual(run.status, 'STARTED', 'Initial status should be STARTED');
  assert.ok(run.workspaceId === null, 'Initial workspaceId should be null');
  done();
});

test('run: run and revision IDs are distinct', function(t, done) {
  var run = runModule.createRun({});

  assert.notStrictEqual(run.runId, run.revisionId, 'Run ID and Revision ID should be distinct');
  assert.notEqual(run.runId, run.revisionId, 'Run ID and Revision ID should not be equal');
  done();
});

test('run: updateRunStatus to COMPLETED sets endedAt', function(t, done) {
  var run = runModule.createRun({});
  var updated = runModule.updateRunStatus(run, 'COMPLETED');

  assert.strictEqual(updated.status, 'COMPLETED', 'Status should be COMPLETED');
  assert.ok(updated.endedAt, 'endedAt should be set');
  assert.ok(Date.parse(updated.endedAt) > 0, 'endedAt should be a valid date');
  done();
});

test('run: updateRunStatus to FAILED sets endedAt', function(t, done) {
  var run = runModule.createRun({});
  var updated = runModule.updateRunStatus(run, 'FAILED');

  assert.strictEqual(updated.status, 'FAILED', 'Status should be FAILED');
  assert.ok(updated.endedAt, 'endedAt should be set');
  done();
});

test('run: updateRunStatus to RUNNING does not set endedAt', function(t, done) {
  var run = runModule.createRun({});
  var updated = runModule.updateRunStatus(run, 'RUNNING');

  assert.strictEqual(updated.status, 'RUNNING', 'Status should be RUNNING');
  assert.strictEqual(updated.endedAt, null, 'endedAt should still be null');
  done();
});

test('run: setWorkspaceId attaches workspace ID', function(t, done) {
  var run = runModule.createRun({});
  var runWithWorkspace = runModule.setWorkspaceId(run, 'ws-123');

  assert.strictEqual(runWithWorkspace.workspaceId, 'ws-123', 'workspaceId should be set');
  assert.strictEqual(runWithWorkspace.runId, run.runId, 'runId should be preserved');
  assert.strictEqual(runWithWorkspace.revisionId, run.revisionId, 'revisionId should be preserved');
  done();
});

test('run: serialization roundtrip', function(t, done) {
  var original = runModule.createRun({
    taskId: 'TASK-001',
    metadata: { key: 'value' }
  });

  var serialized = runModule.serializeRun(original);
  var deserialized = runModule.deserializeRun(serialized);

  assert.deepStrictEqual(deserialized, original, 'Deserialized run should match original');
  done();
});

test('run: deserialize invalid JSON returns null', function(t, done) {
  var result = runModule.deserializeRun('not valid json');
  assert.strictEqual(result, null, 'Invalid JSON should return null');
  done();
});

test('run: isValidRunId validates correctly', function(t, done) {
  assert.strictEqual(runModule.isValidRunId('run-abc-123'), true, 'Valid run ID should pass');
  assert.strictEqual(runModule.isValidRunId('rev-abc-123'), false, 'rev- prefix should not validate as run');
  assert.strictEqual(runModule.isValidRunId('invalid'), false, 'Invalid format should fail');
  assert.strictEqual(runModule.isValidRunId(''), false, 'Empty string should fail');
  assert.strictEqual(runModule.isValidRunId(null), false, 'null should fail');
  assert.strictEqual(runModule.isValidRunId(123), false, 'Number should fail');
  done();
});

test('run: isValidRevisionId validates correctly', function(t, done) {
  assert.strictEqual(runModule.isValidRevisionId('rev-abc-123'), true, 'Valid revision ID should pass');
  assert.strictEqual(runModule.isValidRevisionId('run-abc-123'), false, 'run- prefix should not validate as revision');
  assert.strictEqual(runModule.isValidRevisionId('invalid'), false, 'Invalid format should fail');
  assert.strictEqual(runModule.isValidRevisionId(''), false, 'Empty string should fail');
  done();
});

test('run: multiple runs generate unique IDs', function(t, done) {
  var runs = [];
  for (var i = 0; i < 10; i++) {
    runs.push(runModule.createRun({}));
  }

  var runIds = runs.map(function(r) { return r.runId; });
  var uniqueRunIds = runIds.filter(function(id, index) {
    return runIds.indexOf(id) === index;
  });

  assert.strictEqual(uniqueRunIds.length, 10, 'All run IDs should be unique');
  done();
});