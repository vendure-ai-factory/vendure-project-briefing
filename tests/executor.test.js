'use strict';

var executorModule = require('../src/executor');

var test = require('node:test');
var assert = require('node:assert');

test('executor: built-in ECHO and ADD tools work', function(t, done) {
  var echo = executorModule.executeTool('ECHO', { message: 'test message' });
  assert.strictEqual(echo.success, true, 'ECHO should succeed');
  assert.strictEqual(echo.echo, 'test message', 'ECHO should echo the message');

  var add = executorModule.executeTool('ADD', { a: 3, b: 4 });
  assert.strictEqual(add.success, true, 'ADD should succeed');
  assert.strictEqual(add.result, 7, 'ADD should return correct sum');
  done();
});

test('executor: reset registry before subsequent tests', function(t, done) {
  executorModule.resetRegistry();
  done();
});

test('executor: registered tool executes successfully', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('GREET', {
    description: 'Greet someone',
    schema: {
      required: ['name'],
      properties: { name: { type: 'string' } }
    },
    handler: function(args) {
      return { success: true, greeting: 'Hello, ' + args.name };
    }
  });

  var result = executorModule.executeTool('GREET', { name: 'World' });
  assert.strictEqual(result.success, true, 'Tool should execute successfully');
  assert.strictEqual(result.greeting, 'Hello, World', 'Tool should return correct result');
  done();
});

test('executor: unknown tool is rejected with UNKNOWN_TOOL', function(t, done) {
  executorModule.resetRegistry();
  var result = executorModule.executeTool('NONEXISTENT_TOOL', {});
  assert.strictEqual(result.success, false, 'Unknown tool should fail');
  assert.strictEqual(result.errorCode, 'UNKNOWN_TOOL', 'Error code should be UNKNOWN_TOOL');
  done();
});

test('executor: missing required arguments are rejected with INVALID_ARGS', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('GREET', {
    description: 'Greet someone',
    schema: {
      required: ['name'],
      properties: { name: { type: 'string' } }
    },
    handler: function(args) {
      return { success: true };
    }
  });

  var result = executorModule.executeTool('GREET', {});
  assert.strictEqual(result.success, false, 'Missing required args should fail');
  assert.strictEqual(result.errorCode, 'INVALID_ARGS', 'Error code should be INVALID_ARGS');
  assert.ok(result.validationErrors.some(function(e) { return e.indexOf('name') !== -1; }), 'Should mention missing name');
  done();
});

test('executor: wrong argument type is rejected', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('ADD', {
    description: 'Add two numbers',
    schema: {
      required: ['a', 'b'],
      properties: { a: { type: 'number' }, b: { type: 'number' } }
    },
    handler: function(args) { return { success: true, result: args.a + args.b }; }
  });

  var result = executorModule.executeTool('ADD', { a: 'not a number', b: 2 });
  assert.strictEqual(result.success, false, 'Wrong type should fail');
  assert.strictEqual(result.errorCode, 'INVALID_ARGS', 'Error code should be INVALID_ARGS');
  done();
});

test('executor: executePlan returns structured result with success, results, summary', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('ECHO', {
    description: 'Echo a message',
    schema: {
      required: ['message'],
      properties: { message: { type: 'string' } }
    },
    handler: function(args) { return { success: true, echo: args.message }; }
  });

  var plan = {
    planId: 'plan-struct-001',
    taskId: 'TASK-001',
    executionSteps: [
      { stepId: 'step-1', action: 'ECHO', args: { message: 'hello' }, order: 1, description: 'Echo hello' }
    ]
  };

  var result = executorModule.executePlan(plan);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'success'), true, 'Result must have success field');
  assert.strictEqual(Array.isArray(result.results), true, 'Result must have results array');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'summary'), true, 'Result must have summary field');
  assert.strictEqual(result.summary.totalSteps, 1, 'Summary must have totalSteps');
  assert.strictEqual(result.summary.completed, 1, 'Summary must have completed count');
  done();
});

test('executor: executePlan executes steps in array order (not sorted by order field)', function(t, done) {
  executorModule.resetRegistry();
  var callOrder = [];

  executorModule.registerTool('STEP_C', {
    description: 'Step C',
    schema: { required: [], properties: {} },
    handler: function(args) { callOrder.push('C'); return { success: true }; }
  });
  executorModule.registerTool('STEP_A', {
    description: 'Step A',
    schema: { required: [], properties: {} },
    handler: function(args) { callOrder.push('A'); return { success: true }; }
  });
  executorModule.registerTool('STEP_B', {
    description: 'Step B',
    schema: { required: [], properties: {} },
    handler: function(args) { callOrder.push('B'); return { success: true }; }
  });

  var plan = {
    planId: 'plan-order-001',
    taskId: 'TASK-001',
    executionSteps: [
      { stepId: 's-c', action: 'STEP_C', args: {}, order: 3 },
      { stepId: 's-a', action: 'STEP_A', args: {}, order: 1 },
      { stepId: 's-b', action: 'STEP_B', args: {}, order: 2 }
    ]
  };

  executorModule.executePlan(plan);
  assert.deepStrictEqual(callOrder, ['C', 'A', 'B'], 'Steps should execute in array order, not sorted by order field');
  done();
});

test('executor: unknown action in a plan step returns failure', function(t, done) {
  executorModule.resetRegistry();
  var plan = {
    planId: 'plan-unknown-001',
    taskId: 'TASK-001',
    executionSteps: [
      { stepId: 'step-1', action: 'DEFINITELY_NOT_A_REAL_TOOL', args: {}, order: 1 }
    ]
  };

  var result = executorModule.executePlan(plan);
  assert.strictEqual(result.success, false, 'Plan with unknown action should fail');
  assert.strictEqual(result.results[0].success, false, 'Step result should show failure');
  assert.strictEqual(result.results[0].errorCode, 'UNKNOWN_TOOL', 'Step should have UNKNOWN_TOOL error');
  done();
});

test('executor: tool failure sets success false on step result', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('FAILING_TOOL', {
    description: 'Always fails',
    schema: { required: [], properties: {} },
    handler: function(args) { return { success: false, error: 'Deliberate failure' }; }
  });

  var plan = {
    planId: 'plan-fail-001',
    taskId: 'TASK-001',
    executionSteps: [
      { stepId: 'step-1', action: 'FAILING_TOOL', args: {}, order: 1 }
    ]
  };

  var result = executorModule.executePlan(plan);
  assert.strictEqual(result.results[0].success, false, 'Step result should be false');
  assert.strictEqual(result.results[0].error, 'Deliberate failure', 'Error should be propagated');
  done();
});

test('executor: executePlan overall success is false when any step fails', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('STEP_OK', {
    description: 'Succeeds',
    schema: { required: [], properties: {} },
    handler: function(args) { return { success: true }; }
  });
  executorModule.registerTool('STEP_BAD', {
    description: 'Fails',
    schema: { required: [], properties: {} },
    handler: function(args) { return { success: false }; }
  });

  var plan = {
    planId: 'plan-overall-001',
    taskId: 'TASK-001',
    executionSteps: [
      { stepId: 'step-1', action: 'STEP_OK', args: {}, order: 1 },
      { stepId: 'step-2', action: 'STEP_BAD', args: {}, order: 2 }
    ]
  };

  var result = executorModule.executePlan(plan);
  assert.strictEqual(result.success, false, 'Overall plan should be false when any step fails');
  assert.strictEqual(result.summary.failed, 1, 'Should record 1 failed step');
  done();
});

test('executor: resetRegistry clears all tools', function(t, done) {
  executorModule.resetRegistry();
  executorModule.registerTool('TEMP_TOOL', {
    description: 'Temporary',
    schema: { required: [], properties: {} },
    handler: function(args) { return { success: true }; }
  });
  assert.strictEqual(executorModule.listTools().indexOf('TEMP_TOOL') !== -1, true, 'Tool should be registered');

  executorModule.resetRegistry();
  assert.strictEqual(executorModule.listTools().length, 0, 'Registry should be empty after reset');
  done();
});

test('executor: registerTool rejects tools without handler', function(t, done) {
  executorModule.resetRegistry();
  var result = executorModule.registerTool('NO_HANDLER', {
    description: 'Missing handler',
    schema: null
  });
  assert.strictEqual(result.success, false, 'Should reject tool without handler');
  assert.ok(result.error.indexOf('handler') !== -1, 'Error should mention handler');
  done();
});

test('executor: resetRegistry removes built-in tools', function(t, done) {
  executorModule.resetRegistry();
  var echoResult = executorModule.executeTool('ECHO', { message: 'test' });
  assert.strictEqual(echoResult.success, false, 'ECHO should be gone after resetRegistry');
  assert.strictEqual(echoResult.errorCode, 'UNKNOWN_TOOL', 'ECHO should return UNKNOWN_TOOL after reset');
  done();
});

test('executor: validatePlanForExecution rejects invalid plan', function(t, done) {
  executorModule.resetRegistry();
  // Re-register a tool to test with (built-ins were cleared by reset)
  executorModule.registerTool('ECHO', {
    description: 'Echo a message',
    schema: {
      required: ['message'],
      properties: { message: { type: 'string' } }
    },
    handler: function(args) { return { success: true, echo: args.message }; }
  });

  var r1 = executorModule.validatePlanForExecution(null);
  assert.strictEqual(r1.valid, false, 'Should reject null plan');

  var r2 = executorModule.validatePlanForExecution({});
  assert.strictEqual(r2.valid, false, 'Should reject plan without executionSteps');

  var r3 = executorModule.validatePlanForExecution({ executionSteps: 'not array' });
  assert.strictEqual(r3.valid, false, 'Should reject non-array executionSteps');

  var r4 = executorModule.validatePlanForExecution({ executionSteps: [{}] });
  assert.strictEqual(r4.valid, false, 'Should reject step without action');
  assert.ok(r4.errors[0].indexOf('action') !== -1, 'Error should mention missing action');

  var validPlan = {
    executionSteps: [
      { stepId: 's1', action: 'ECHO', args: { message: 'hi' }, order: 1 }
    ]
  };
  var r5 = executorModule.validatePlanForExecution(validPlan);
  assert.strictEqual(r5.valid, true, 'Should accept valid plan');
  done();
});

test('executor: executePlan logs structured events via provided logger', function(t, done) {
  executorModule.resetRegistry();

  var logCalls = [];

  var mockLogger = {
    info: function(event, message, metadata) {
      logCalls.push({ level: 'info', event: event, message: message, metadata: metadata });
    },
    debug: function(event, message, metadata) {
      logCalls.push({ level: 'debug', event: event, message: message, metadata: metadata });
    },
    warn: function(event, message, metadata) {
      logCalls.push({ level: 'warn', event: event, message: message, metadata: metadata });
    }
  };

  executorModule.registerTool('GREET', {
    description: 'Greet someone',
    schema: {
      required: ['name'],
      properties: { name: { type: 'string' } }
    },
    handler: function(args) {
      return { success: true, greeting: 'Hello, ' + args.name };
    }
  });

  var plan = {
    planId: 'plan-log-001',
    taskId: 'TASK-LOG-001',
    executionSteps: [
      { stepId: 'step-greet-1', action: 'GREET', args: { name: 'Logger' }, order: 1, description: 'Greet the logger' }
    ]
  };

  var result = executorModule.executePlan(plan, {
    runId: 'run-log-test-001',
    logger: mockLogger
  });

  assert.strictEqual(result.success, true, 'Plan should execute successfully');

  var infoEvents = logCalls.filter(function(c) { return c.level === 'info'; });
  var debugEvents = logCalls.filter(function(c) { return c.level === 'debug'; });

  var eventNames = logCalls.map(function(c) { return c.event; });

  assert.ok(eventNames.indexOf('EXECUTION_STARTED') !== -1, 'EXECUTION_STARTED should be logged');
  assert.ok(eventNames.indexOf('STEP_START') !== -1, 'STEP_START should be logged');
  assert.ok(eventNames.indexOf('STEP_COMPLETED') !== -1, 'STEP_COMPLETED should be logged');
  assert.ok(eventNames.indexOf('EXECUTION_COMPLETED') !== 'EXECUTION_COMPLETED', 'EXECUTION_COMPLETED should be logged');

  var started = logCalls.find(function(c) { return c.event === 'EXECUTION_STARTED'; });
  assert.ok(started, 'EXECUTION_STARTED entry should exist');
  assert.strictEqual(started.metadata.planId, 'plan-log-001', 'EXECUTION_STARTED should have planId');
  assert.strictEqual(started.metadata.runId, 'run-log-test-001', 'EXECUTION_STARTED should have runId');
  assert.strictEqual(started.metadata.totalSteps, 1, 'EXECUTION_STARTED should have totalSteps');

  var stepStart = logCalls.find(function(c) { return c.event === 'STEP_START'; });
  assert.ok(stepStart, 'STEP_START entry should exist');
  assert.strictEqual(stepStart.metadata.stepId, 'step-greet-1', 'STEP_START should have stepId');
  assert.strictEqual(stepStart.metadata.action, 'GREET', 'STEP_START should have action');

  var stepCompleted = logCalls.find(function(c) { return c.event === 'STEP_COMPLETED'; });
  assert.ok(stepCompleted, 'STEP_COMPLETED entry should exist');
  assert.strictEqual(stepCompleted.metadata.stepId, 'step-greet-1', 'STEP_COMPLETED should have stepId');
  assert.strictEqual(stepCompleted.metadata.action, 'GREET', 'STEP_COMPLETED should have action');

  var completed = logCalls.find(function(c) { return c.event === 'EXECUTION_COMPLETED'; });
  assert.ok(completed, 'EXECUTION_COMPLETED entry should exist');
  assert.strictEqual(completed.metadata.planId, 'plan-log-001', 'EXECUTION_COMPLETED should have planId');
  assert.strictEqual(completed.metadata.overallSuccess, true, 'EXECUTION_COMPLETED should have overallSuccess=true');
  assert.strictEqual(completed.metadata.completed, 1, 'EXECUTION_COMPLETED should have completed=1');
  assert.strictEqual(completed.metadata.failed, 0, 'EXECUTION_COMPLETED should have failed=0');

  done();
});

// ---------------------------------------------------------------------------
// Task executor registry (keyed by task ID)
// ---------------------------------------------------------------------------

test('executor: registerTaskExecutor stores a handler by task ID', function(t, done) {
  executorModule.resetTaskExecutors();
  var called = false;
  var reg = executorModule.registerTaskExecutor('CAN-TST-01', {
    description: 'test executor',
    handler: function() { called = true; return { success: true, actual: 'x' }; }
  });
  assert.strictEqual(reg.success, true);
  var ex = executorModule.getTaskExecutor('CAN-TST-01');
  assert.ok(ex, 'executor should be retrievable');
  assert.strictEqual(ex.handler().actual, 'x');
  assert.strictEqual(called, true);
  executorModule.resetTaskExecutors();
  done();
});

test('executor: hasTaskExecutor reflects registration', function(t, done) {
  executorModule.resetTaskExecutors();
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-TST-01'), false);
  executorModule.registerTaskExecutor('CAN-TST-01', { handler: function() { return { success: true }; } });
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-TST-01'), true);
  executorModule.resetTaskExecutors();
  done();
});

test('executor: registerTaskExecutor rejects missing id or non-function handler', function(t, done) {
  executorModule.resetTaskExecutors();
  var noId = executorModule.registerTaskExecutor(null, { handler: function() {} });
  assert.strictEqual(noId.success, false);
  var noHandler = executorModule.registerTaskExecutor('CAN-TST-02', {});
  assert.strictEqual(noHandler.success, false);
  executorModule.resetTaskExecutors();
  done();
});

test('executor: listTaskExecutors and resetTaskExecutors', function(t, done) {
  executorModule.resetTaskExecutors();
  assert.strictEqual(executorModule.listTaskExecutors().length, 0);
  executorModule.registerTaskExecutor('CAN-TST-01', { handler: function() { return { success: true }; } });
  executorModule.registerTaskExecutor('CAN-TST-02', { handler: function() { return { success: true }; } });
  assert.deepStrictEqual(executorModule.listTaskExecutors().sort(), ['CAN-TST-01', 'CAN-TST-02']);
  executorModule.resetTaskExecutors();
  assert.strictEqual(executorModule.listTaskExecutors().length, 0);
  assert.strictEqual(executorModule.getTaskExecutor('CAN-TST-01'), null);
  done();
});