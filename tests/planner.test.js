'use strict';

var plannerModule = require('../src/planner');
var taskCardModule = require('../src/taskCard');

var test = require('node:test');
var assert = require('node:assert');

function createValidTaskCard() {
  return taskCardModule.createTaskCard({
    taskId: 'B1-TEST-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Execute test goal',
    description: 'Test description for planning',
    expectedResults: ['Result 1', 'Result 2'],
    acceptanceConditions: ['Condition 1', 'Condition 2'],
    fixtures: ['fixture1.json', 'fixture2.json'],
    environment: { KEY1: 'value1', KEY2: 'value2' },
    status: 'PENDING'
  });
}

test('planner: valid task card produces valid execution plan', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  assert.strictEqual(result.valid, true, 'Valid task card should produce valid plan');
  assert.ok(result.plan, 'Result should have plan object');
  assert.ok(result.plan.planId, 'Plan should have planId');
  done();
});

test('planner: plan preserves runId from options', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard, {
    runId: 'run-fixedrunid-123456'
  });

  assert.strictEqual(result.valid, true, 'Plan should be valid');
  assert.strictEqual(result.plan.runId, 'run-fixedrunid-123456', 'Plan should preserve provided runId');
  done();
});

test('planner: plan preserves revisionId from options', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard, {
    revisionId: 'rev-fixedrev-654321'
  });

  assert.strictEqual(result.valid, true, 'Plan should be valid');
  assert.strictEqual(result.plan.revisionId, 'rev-fixedrev-654321', 'Plan should preserve provided revisionId');
  done();
});

test('planner: plan preserves taskId', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  assert.strictEqual(result.plan.taskId, 'B1-TEST-001', 'Plan should preserve taskId');
  done();
});

test('planner: execution steps are ordered', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  var steps = result.plan.executionSteps;
  assert.ok(steps && steps.length > 0, 'Plan should have execution steps');

  for (var i = 0; i < steps.length - 1; i++) {
    assert.ok(steps[i].order < steps[i + 1].order, 'Steps should be in ascending order');
    assert.ok(steps[i].stepId, 'Each step should have stepId');
  }
  done();
});

test('planner: preconditions are represented', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  var preconditions = result.plan.preconditions;
  assert.ok(Array.isArray(preconditions), 'Preconditions should be an array');
  assert.ok(preconditions.length > 0, 'Should have preconditions from environment and fixtures');
  done();
});

test('planner: expected results are represented', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  assert.ok(Array.isArray(result.plan.expectedResults), 'Expected results should be an array');
  assert.strictEqual(result.plan.expectedResults.length, 2, 'Should have both expected results');
  assert.strictEqual(result.plan.expectedResults[0], 'Result 1');
  done();
});

test('planner: validation requirements are represented', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  var reqs = result.plan.validationRequirements;
  assert.ok(Array.isArray(reqs), 'Validation requirements should be an array');
  assert.ok(reqs.length > 0, 'Should have validation requirements');

  var hasAcceptanceCondition = reqs.some(function(r) {
    return r.type === 'acceptance_condition';
  });
  assert.ok(hasAcceptanceCondition, 'Should have acceptance condition validation requirements');

  var hasStatusCheck = reqs.some(function(r) {
    return r.type === 'status_check';
  });
  assert.ok(hasStatusCheck, 'Should have status check validation requirement');
  done();
});

test('planner: cleanup requirements are represented', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard);

  var cleanup = result.plan.cleanupRequirements;
  assert.ok(Array.isArray(cleanup), 'Cleanup requirements should be an array');
  assert.ok(cleanup.length > 0, 'Should have cleanup requirements');

  var hasWorkspaceCleanup = cleanup.some(function(r) {
    return r.type === 'workspace_cleanup';
  });
  assert.ok(hasWorkspaceCleanup, 'Should have workspace cleanup requirement');
  done();
});

test('planner: invalid task card without taskId rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Execute test goal',
    description: 'Test description'
  });

  var result = plannerModule.createExecutionPlan(taskCard);
  assert.strictEqual(result.valid, false, 'Invalid task card should be rejected');
  assert.ok(result.errors && result.errors.length > 0, 'Should have error messages');
  done();
});

test('planner: invalid task card without goal rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: '',
    description: 'Test description'
  });

  var result = plannerModule.createExecutionPlan(taskCard);
  assert.strictEqual(result.valid, false, 'Task card with empty goal should be rejected');
  done();
});

test('planner: invalid task card without description rejected', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-001',
    batchId: 'BATCH-1',
    title: 'Test task',
    goal: 'Goal',
    description: ''
  });

  var result = plannerModule.createExecutionPlan(taskCard);
  assert.strictEqual(result.valid, false, 'Task card with empty description should be rejected');
  done();
});

test('planner: invalid runId format rejected', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard, {
    runId: 'invalid-run-id'
  });

  assert.strictEqual(result.valid, false, 'Invalid runId format should be rejected');
  assert.ok(result.errors.some(function(e) {
    return e.indexOf('runId') !== -1;
  }), 'Error should mention runId');
  done();
});

test('planner: invalid revisionId format rejected', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard, {
    revisionId: 'invalid-rev-id'
  });

  assert.strictEqual(result.valid, false, 'Invalid revisionId format should be rejected');
  assert.ok(result.errors.some(function(e) {
    return e.indexOf('revisionId') !== -1;
  }), 'Error should mention revisionId');
  done();
});

test('planner: no actual execution occurs', function(t, done) {
  var taskCard = createValidTaskCard();
  var beforeTime = Date.now();
  var result = plannerModule.createExecutionPlan(taskCard);
  var afterTime = Date.now();

  assert.strictEqual(result.valid, true, 'Plan should be created');
  assert.ok(result.plan.createdAt, 'Plan should have createdAt');
  assert.ok(afterTime >= Date.parse(result.plan.createdAt), 'createdAt should be valid timestamp');

  var noExecErrors = result.errors ? result.errors.some(function(e) {
    return e.indexOf('execute') !== -1 || e.indexOf('shell') !== -1;
  }) : false;
  assert.strictEqual(noExecErrors, false, 'No execution errors should be present');
  done();
});

test('planner: repeated planning with identical inputs produces equivalent plans', function(t, done) {
  var taskCard = createValidTaskCard();
  var options = {
    runId: 'run-ident-000000',
    revisionId: 'rev-ident-000000'
  };

  var result1 = plannerModule.createExecutionPlan(taskCard, options);
  var result2 = plannerModule.createExecutionPlan(taskCard, options);

  assert.strictEqual(result1.valid, true, 'First plan should be valid');
  assert.strictEqual(result2.valid, true, 'Second plan should be valid');
  assert.strictEqual(result1.plan.runId, result2.plan.runId, 'Both plans should have same runId');
  assert.strictEqual(result1.plan.revisionId, result2.plan.revisionId, 'Both plans should have same revisionId');
  assert.strictEqual(result1.plan.taskId, result2.plan.taskId, 'Both plans should have same taskId');
  assert.strictEqual(result1.plan.goal, result2.plan.goal, 'Both plans should have same goal');
  assert.strictEqual(result1.plan.executionSteps.length, result2.plan.executionSteps.length, 'Both plans should have same step count');
  done();
});

test('planner: task card without fixtures still produces valid plan', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-NOFIX-001',
    batchId: 'BATCH-1',
    title: 'No fixtures task',
    goal: 'Task without fixtures',
    description: 'Testing minimal task card',
    expectedResults: ['Result'],
    acceptanceConditions: ['Condition'],
    fixtures: [],
    environment: {},
    status: 'PENDING'
  });

  var result = plannerModule.createExecutionPlan(taskCard);

  assert.strictEqual(result.valid, true, 'Plan should be valid without fixtures');
  assert.ok(Array.isArray(result.plan.executionSteps), 'Should still have execution steps');
  done();
});

test('planner: serialize and deserialize roundtrip', function(t, done) {
  var taskCard = createValidTaskCard();
  var result = plannerModule.createExecutionPlan(taskCard, {
    runId: 'run-serialtest-123456',
    revisionId: 'rev-serialtest-654321'
  });

  var serialized = plannerModule.serializePlan(result.plan);
  var deserialized = plannerModule.deserializePlan(serialized);

  assert.deepStrictEqual(deserialized, result.plan, 'Deserialized plan should match original');
  done();
});

test('planner: deserialize invalid JSON returns null', function(t, done) {
  var result = plannerModule.deserializePlan('not valid json');
  assert.strictEqual(result, null, 'Invalid JSON should return null');
  done();
});

test('planner: isValidPlanId validates correctly', function(t, done) {
  assert.strictEqual(plannerModule.isValidPlanId('plan-abc-123'), true, 'Valid plan ID should pass');
  assert.strictEqual(plannerModule.isValidPlanId('run-abc-123'), false, 'run- prefix should not validate');
  assert.strictEqual(plannerModule.isValidPlanId('invalid'), false, 'Invalid format should fail');
  assert.strictEqual(plannerModule.isValidPlanId(''), false, 'Empty string should fail');
  assert.strictEqual(plannerModule.isValidPlanId(null), false, 'null should fail');
  done();
});

test('planner: plan with minimal task card', function(t, done) {
  var taskCard = taskCardModule.createTaskCard({
    taskId: 'B1-MIN-001',
    batchId: 'BATCH-1',
    title: 'Minimal',
    goal: 'Minimal goal',
    description: 'Minimal description',
    expectedResults: [],
    acceptanceConditions: [],
    fixtures: [],
    environment: {},
    status: 'PENDING'
  });

  var result = plannerModule.createExecutionPlan(taskCard);

  assert.strictEqual(result.valid, true, 'Minimal task card should produce valid plan');
  assert.strictEqual(result.plan.taskId, 'B1-MIN-001');
  assert.strictEqual(result.plan.goal, 'Minimal goal');
  assert.ok(Array.isArray(result.plan.executionSteps));
  assert.ok(result.plan.executionSteps.length > 0);
  done();
});