'use strict';

var taskCardModule = require('../src/taskCard');

var test = require('node:test');
var assert = require('node:assert');

test('taskCard: valid task card accepted', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Test goal',
    description: 'Test description',
    expectedResults: ['Result 1'],
    acceptanceConditions: ['Condition 1'],
    fixtures: [],
    environment: {},
    status: 'PENDING'
  });

  var validation = taskCardModule.validateTaskCard(taskCard);
  assert.strictEqual(validation.valid, true, 'Valid task card should be accepted');
  assert.strictEqual(validation.errors.length, 0, 'No errors should be reported');
  done();
});

test('taskCard: missing task ID rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Test goal',
    description: 'Test description'
  });

  var validation = taskCardModule.validateTaskCard(taskCard);
  assert.strictEqual(validation.valid, false, 'Missing taskId should be rejected');
  assert.strictEqual(validation.errors.some(function(e) {
    return e.includes('taskId') || e.includes('task ID');
  }), true, 'Error should mention taskId');
  done();
});

test('taskCard: missing batch ID rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    title: 'Test task',
    goal: 'Test goal',
    description: 'Test description'
  });

  var validation = taskCardModule.validateTaskCard(taskCard);
  assert.strictEqual(validation.valid, false, 'Missing batchId should be rejected');
  assert.strictEqual(validation.errors.some(function(e) {
    return e.includes('batchId') || e.includes('batch ID');
  }), true, 'Error should mention batchId');
  done();
});

test('taskCard: missing goal rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    description: 'Test description'
  });

  var validation = taskCardModule.validateTaskCard(taskCard);
  assert.strictEqual(validation.valid, false, 'Missing goal should be rejected');
  assert.strictEqual(validation.errors.some(function(e) {
    return e.includes('goal');
  }), true, 'Error should mention goal');
  done();
});

test('taskCard: malformed acceptance conditions rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Test goal',
    description: 'Test description',
    acceptanceConditions: ['Valid string', 123, 'Another string']
  });

  var validation = taskCardModule.validateTaskCard(taskCard);
  assert.strictEqual(validation.valid, false, 'Malformed acceptance conditions should be rejected');
  assert.strictEqual(validation.errors.some(function(e) {
    return e.includes('acceptanceConditions');
  }), true, 'Error should mention acceptanceConditions');
  done();
});

test('taskCard: valid statuses accepted', function(t, done) {
  var validStatuses = ['PENDING', 'RUNNING', 'PASS_CANDIDATE', 'FAIL', 'SKIP'];

  validStatuses.forEach(function(status) {
    var taskCard = taskCardModule.createTaskCard({
      taskId: 'B1-001',
      batchId: 'BATCH-1',
      title: 'Test task',
      goal: 'Test goal',
      description: 'Test description',
      status: status
    });

    var validation = taskCardModule.validateTaskCard(taskCard);
    assert.strictEqual(validation.valid, true, 'Status ' + status + ' should be accepted');
  });
  done();
});

test('taskCard: invalid status rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Test goal',
    description: 'Test description',
    status: 'INVALID_STATUS'
  });

  var validation = taskCardModule.validateTaskCard(taskCard);
  assert.strictEqual(validation.valid, false, 'Invalid status should be rejected');
  done();
});

test('taskCard: serialization roundtrip', function(t, done) {
  var original = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Test goal',
    description: 'Test description',
    expectedResults: ['Result 1'],
    acceptanceConditions: ['Condition 1'],
    fixtures: [],
    environment: { key: 'value' },
    status: 'PENDING'
  });

  var serialized = taskCardModule.serializeTaskCard(original);
  var deserialized = taskCardModule.deserializeTaskCard(serialized);

  assert.deepStrictEqual(deserialized, original, 'Deserialized task card should match original');
  done();
});

test('taskCard: deserialize invalid JSON returns null', function(t, done) {
  var result = taskCardModule.deserializeTaskCard('not valid json');
  assert.strictEqual(result, null, 'Invalid JSON should return null');
  done();
});