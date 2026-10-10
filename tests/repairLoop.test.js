'use strict';

var repairLoopModule = require('../src/repairLoop');
var executorModule = require('../src/executor');

var test = require('node:test');
var assert = require('node:assert');

function createMockLogger() {
  var logCalls = [];
  return {
    logCalls: logCalls,
    info: function(event, message, metadata) {
      logCalls.push({ level: 'info', event: event, message: message, metadata: metadata });
    },
    warn: function(event, message, metadata) {
      logCalls.push({ level: 'warn', event: event, message: message, metadata: metadata });
    },
    error: function(event, message, metadata) {
      logCalls.push({ level: 'error', event: event, message: message, metadata: metadata });
    },
    debug: function(event, message, metadata) {
      logCalls.push({ level: 'debug', event: event, message: message, metadata: metadata });
    }
  };
}

function createBasicPlan() {
  return {
    planId: 'plan-repair-test-001',
    taskId: 'TASK-REPAIR-001',
    executionSteps: [
      {
        stepId: 'step-1',
        action: 'TEST_TOOL',
        args: { value: 1 },
        order: 1,
        description: 'Test step'
      }
    ]
  };
}

test('repairLoop: first failure followed by successful repair', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Test tool for repair loop',
    schema: { required: ['value'], properties: { value: { type: 'number' } } },
    handler: function(args) {
      if (args.value === 1) {
        return { success: false, error: 'Initial failure', errorCode: 'EXECUTION_ERROR' };
      }
      return { success: true, result: args.value * 2 };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return {
        stepId: 'step-1',
        modifiedArgs: { value: 2 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-repair-001' }
  });

  assert.strictEqual(result.status, 'PASS_CANDIDATE', 'Should return PASS_CANDIDATE after successful repair');
  assert.strictEqual(result.success, true, 'success should be true');
  assert.strictEqual(repairCallCount, 1, 'Repair handler should be called once');
  assert.strictEqual(result.totalAttempts, 2, 'Should have 2 attempts (initial + 1 repair)');
  assert.strictEqual(result.allAttempts.length, 2, 'Should have 2 attempt records');
  assert.strictEqual(result.allAttempts[0].isRepairExecution, false, 'First attempt is initial execution');
  assert.strictEqual(result.allAttempts[1].isRepairExecution, true, 'Second attempt is repair execution');

  done();
});

test('repairLoop: two failed repairs followed by success', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Test tool for repair loop',
    schema: { required: ['value'], properties: { value: { type: 'number' } } },
    handler: function(args) {
      if (args.value === 1) {
        return { success: false, error: 'Attempt 1 failed', errorCode: 'EXECUTION_ERROR' };
      }
      if (args.value === 2) {
        return { success: false, error: 'Attempt 2 failed', errorCode: 'EXECUTION_ERROR' };
      }
      if (args.value === 3) {
        return { success: true, result: 6 };
      }
      return { success: false, error: 'Unexpected value', errorCode: 'EXECUTION_ERROR' };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return {
        stepId: 'step-1',
        modifiedArgs: { value: repairContext.attemptNumber + 1 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-repair-002' }
  });

  assert.strictEqual(result.status, 'PASS_CANDIDATE', 'Should return PASS_CANDIDATE after 3 total attempts');
  assert.strictEqual(result.success, true, 'success should be true');
  assert.strictEqual(repairCallCount, 2, 'Repair handler should be called twice');
  assert.strictEqual(result.totalAttempts, 3, 'Should have 3 attempts (initial + 2 repairs)');
  assert.strictEqual(result.allAttempts.length, 3, 'Should have 3 attempt records');

  done();
});

test('repairLoop: three exhausted repairs resulting in BLOCK', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Always fails',
    schema: { required: ['value'], properties: { value: { type: 'number' } } },
    handler: function(args) {
      return { success: false, error: 'Always fails', errorCode: 'EXECUTION_ERROR' };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return {
        stepId: 'step-1',
        modifiedArgs: { value: 999 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-repair-003' }
  });

  assert.strictEqual(result.status, 'BLOCK', 'Should return BLOCK after exhausting repairs');
  assert.strictEqual(result.success, false, 'success should be false');
  assert.strictEqual(repairCallCount, 3, 'Repair handler should be called 3 times');
  assert.strictEqual(result.totalAttempts, 4, 'Should have 4 attempts (initial + 3 repairs)');
  assert.strictEqual(result.allAttempts.length, 4, 'Should have 4 attempt records');

  assert.strictEqual(result.blockedReason !== undefined, true, 'Should have blockedReason');
  assert.strictEqual(result.blockedAt !== undefined, true, 'Should have blockedAt');
  assert.strictEqual(result.originalFailureEvidence !== undefined, true, 'Should have originalFailureEvidence');

  var blockLog = logger.logCalls.find(function(l) { return l.event === 'EXECUTION_BLOCKED'; });
  assert.ok(blockLog, 'Should have EXECUTION_BLOCKED log entry');

  done();
});

test('repairLoop: separate failure signatures have separate retry budgets', function(t, done) {
  executorModule.resetRegistry();

  var tool1Attempts = 0;
  var tool2Attempts = 0;

  executorModule.registerTool('TOOL_1', {
    description: 'First tool - always fails, same signature',
    schema: { required: [], properties: {} },
    handler: function(args) {
      tool1Attempts++;
      return { success: false, error: 'Tool 1 fails', errorCode: 'FILE_NOT_FOUND', toolName: 'TOOL_1', stepId: 'step-1' };
    }
  });

  executorModule.registerTool('TOOL_2', {
    description: 'Second tool - always fails, different signature',
    schema: { required: [], properties: {} },
    handler: function(args) {
      tool2Attempts++;
      return { success: false, error: 'Tool 2 fails', errorCode: 'MISSING_DEPENDENCY', toolName: 'TOOL_2', stepId: 'step-2' };
    }
  });

  var plan1 = {
    planId: 'plan-sig-a',
    taskId: 'TASK-SIG-A',
    executionSteps: [
      { stepId: 'step-1', action: 'TOOL_1', args: {}, order: 1 }
    ]
  };

  var plan2 = {
    planId: 'plan-sig-b',
    taskId: 'TASK-SIG-B',
    executionSteps: [
      { stepId: 'step-2', action: 'TOOL_2', args: {}, order: 1 }
    ]
  };

  var logger = createMockLogger();
  var repairCallCount1 = 0;
  var repairCallCount2 = 0;

  var result1 = repairLoopModule.executeWithRepair(plan1, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount1++;
      return {
        stepId: 'step-1',
        modifiedArgs: { attempt: repairCallCount1 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-sig-a' }
  });

  assert.strictEqual(result1.status, 'BLOCK', 'Plan 1 (sig A) should BLOCK after exhausting its budget');
  assert.strictEqual(repairCallCount1, 3, 'Signature A should consume exactly 3 repair attempts');
  assert.strictEqual(tool1Attempts, 4, 'Tool 1 should be called 4 times (1 initial + 3 repairs)');
  assert.strictEqual(result1.allAttempts.length, 4, 'Plan 1 should have 4 attempt records');

  var blockLogs1 = logger.logCalls.filter(function(l) { return l.event === 'REPAIR_EXHAUSTED'; });
  assert.ok(blockLogs1.length > 0, 'Plan 1 should log REPAIR_EXHAUSTED for sig A');

  var result2 = repairLoopModule.executeWithRepair(plan2, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount2++;
      return {
        stepId: 'step-2',
        modifiedArgs: { attempt: repairCallCount2 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-sig-b' }
  });

  assert.strictEqual(result2.status, 'BLOCK', 'Plan 2 (sig B) should BLOCK after exhausting its budget');
  assert.strictEqual(repairCallCount2, 3, 'Signature B should receive its own fresh 3 attempts, not 0');
  assert.strictEqual(tool2Attempts, 4, 'Tool 2 should be called 4 times (1 initial + 3 repairs)');
  assert.strictEqual(result2.allAttempts.length, 4, 'Plan 2 should have 4 attempt records');

  var sigALogs = logger.logCalls.filter(function(l) { return l.metadata && l.metadata.failureSignature && l.metadata.failureSignature.indexOf('FILE_NOT_FOUND') === 0; });
  var sigBLogs = logger.logCalls.filter(function(l) { return l.metadata && l.metadata.failureSignature && l.metadata.failureSignature.indexOf('MISSING_DEPENDENCY') === 0; });
  assert.strictEqual(sigALogs.length >= 3, true, 'Signature A (FILE_NOT_FOUND) should appear in at least 3 log entries');
  assert.strictEqual(sigBLogs.length >= 3, true, 'Signature B (MISSING_DEPENDENCY) should appear in at least 3 log entries');

  done();
});

test('repairLoop: original failure evidence is preserved', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('FAILING_TOOL', {
    description: 'Always fails with specific error',
    schema: { required: [], properties: {} },
    handler: function(args) {
      return {
        success: false,
        error: 'Original failure message',
        errorCode: 'FILE_NOT_FOUND',
        toolName: 'FAILING_TOOL',
        stepId: 'step-1'
      };
    }
  });

  var plan = createBasicPlan();
  plan.executionSteps[0].action = 'FAILING_TOOL';
  plan.executionSteps[0].stepId = 'step-1';

  var logger = createMockLogger();

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      assert.ok(repairContext.originalEvidence !== undefined, 'Original evidence should be available in repair context');
      assert.strictEqual(repairContext.originalEvidence.errorCode, 'FILE_NOT_FOUND', 'Error code should be preserved');
      assert.strictEqual(repairContext.originalEvidence.errorMessage, 'Original failure message', 'Error message should be preserved');

      return {
        skipRepairs: true,
        reason: 'Done'
      };
    },
    context: { runId: 'run-evidence-001' }
  });

  assert.ok(result.originalFailureEvidence !== undefined, 'Original failure evidence should be in result');
  assert.strictEqual(result.originalFailureEvidence.errorCode, 'FILE_NOT_FOUND', 'Error code should be preserved in result');
  assert.ok(result.failureClassification !== undefined, 'Failure classification should be preserved');

  done();
});

test('repairLoop: repair attempts are distinguishable in logs', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Test tool',
    schema: { required: ['value'], properties: { value: { type: 'number' } } },
    handler: function(args) {
      if (args.value === 1) {
        return { success: false, error: 'Initial failure', errorCode: 'EXECUTION_ERROR' };
      }
      return { success: true, result: args.value * 2 };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      return {
        stepId: 'step-1',
        modifiedArgs: { value: 2 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-logs-001' }
  });

  var initialExecutionLogs = logger.logCalls.filter(function(l) {
    return l.metadata && l.metadata.attemptNumber === 0 && l.metadata.isRepairExecution === false;
  });
  assert.ok(initialExecutionLogs.length > 0, 'Should have logs for initial execution (attemptNumber=0, isRepairExecution=false)');

  var repairExecutionLogs = logger.logCalls.filter(function(l) {
    return l.metadata && l.metadata.attemptNumber === 1 && l.metadata.isRepairExecution === true;
  });
  assert.ok(repairExecutionLogs.length > 0, 'Should have logs for repair execution (attemptNumber=1, isRepairExecution=true)');

  var repairStartLog = logger.logCalls.find(function(l) { return l.event === 'REPAIR_ATTEMPT_START'; });
  assert.ok(repairStartLog, 'Should have REPAIR_ATTEMPT_START log');
  assert.strictEqual(repairStartLog.metadata.attemptNumber, 1, 'Repair start log should have attemptNumber=1');

  var repairSuccessLog = logger.logCalls.find(function(l) { return l.event === 'REPAIR_SUCCESS'; });
  assert.ok(repairSuccessLog, 'Should have REPAIR_SUCCESS log');
  assert.strictEqual(repairSuccessLog.metadata.attemptNumber, 1, 'Repair success log should have attemptNumber=1');
  assert.strictEqual(repairSuccessLog.metadata.repairAction, 'MODIFY_ARGS', 'Repair success should have repairAction');

  done();
});

test('repairLoop: no retry beyond configured maximum', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Always fails',
    schema: { required: [], properties: {} },
    handler: function(args) {
      return { success: false, error: 'Always fails', errorCode: 'EXECUTION_ERROR' };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 2,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return {
        stepId: 'step-1',
        modifiedArgs: { value: 2 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-max-001' }
  });

  assert.strictEqual(result.status, 'BLOCK', 'Should return BLOCK');
  assert.strictEqual(repairCallCount, 2, 'Repair handler should only be called maxRepairAttempts (2) times');
  assert.strictEqual(result.totalAttempts, 3, 'Should have 3 attempts (initial + 2 repairs)');
  assert.strictEqual(result.allAttempts.length, 3, 'Should have 3 attempt records');

  var exhaustedLogs = logger.logCalls.filter(function(l) { return l.event === 'REPAIR_EXHAUSTED'; });
  assert.ok(exhaustedLogs.length > 0, 'Should log REPAIR_EXHAUSTED');

  done();
});

test('repairLoop: initial execution success returns PASS without repair', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Always succeeds',
    schema: { required: [], properties: {} },
    handler: function(args) {
      return { success: true, result: 'ok' };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return { modifiedArgs: { value: 999 } };
    },
    context: { runId: 'run-success-001' }
  });

  assert.strictEqual(result.status, 'PASS_CANDIDATE', 'Should return PASS_CANDIDATE');
  assert.strictEqual(result.success, true, 'success should be true');
  assert.strictEqual(repairCallCount, 0, 'Repair handler should not be called');
  assert.strictEqual(result.totalAttempts, 1, 'Should have only 1 attempt');
  assert.strictEqual(result.allAttempts.length, 1, 'Should have 1 attempt record');
  assert.strictEqual(result.allAttempts[0].isRepairExecution, false, 'Only attempt should be initial execution');

  done();
});

test('repairLoop: unrecoverable failure returns BLOCK immediately', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('UNKNOWN_TOOL_123', {
    description: 'Will never be registered',
    schema: { required: [], properties: {} },
    handler: function(args) {
      return { success: false, error: 'Unknown tool', errorCode: 'UNKNOWN_TOOL' };
    }
  });

  var plan = createBasicPlan();
  plan.executionSteps[0].action = 'NONEXISTENT_TOOL';

  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return { modifiedArgs: {} };
    },
    context: { runId: 'run-unrecoverable-001' }
  });

  assert.strictEqual(result.status, 'BLOCK', 'Should return BLOCK for unrecoverable failure');
  assert.strictEqual(result.success, false, 'success should be false');
  assert.strictEqual(repairCallCount, 0, 'Repair handler should not be called for unrecoverable failures');

  done();
});

test('repairLoop: generateFailureSignature creates deterministic signature', function(t, done) {
  var failureClassification = {
    relevantEvidence: {
      errorCode: 'FILE_NOT_FOUND',
      action: 'LOAD_FILE',
      stepId: 'step-5'
    }
  };

  var sig1 = repairLoopModule.generateFailureSignature(failureClassification, null);
  var sig2 = repairLoopModule.generateFailureSignature(failureClassification, null);

  assert.strictEqual(sig1, sig2, 'Signature should be deterministic');
  assert.strictEqual(sig1, 'FILE_NOT_FOUND|LOAD_FILE|step-5', 'Signature should have correct format');

  var nullResult = repairLoopModule.generateFailureSignature(null, null);
  assert.strictEqual(nullResult, 'UNKNOWN_SIGNATURE', 'Null input should return UNKNOWN_SIGNATURE');

  done();
});

test('repairLoop: createRepairContext preserves evidence and tracks attempt', function(t, done) {
  var failureClassification = {
    relevantEvidence: {
      errorCode: 'EXECUTION_ERROR',
      errorMessage: 'Something went wrong',
      action: 'TEST_TOOL',
      stepId: 'step-1'
    }
  };

  var context = repairLoopModule.createRepairContext(failureClassification, 2, 3);

  assert.strictEqual(context.attemptNumber, 2, 'Attempt number should be set');
  assert.strictEqual(context.maxAttempts, 3, 'Max attempts should be set');
  assert.strictEqual(context.failureSignature, 'EXECUTION_ERROR|TEST_TOOL|step-1', 'Signature should be generated');
  assert.deepStrictEqual(context.originalEvidence, failureClassification.relevantEvidence, 'Original evidence should be deep cloned');
  assert.strictEqual(context.originalEvidence, failureClassification.relevantEvidence, 'Original evidence should be same reference (not deep cloned)');

  done();
});

test('repairLoop: resetDefaultMaxRepairAttempts restores default value', function(t, done) {
  repairLoopModule.setDefaultMaxRepairAttempts(5);
  assert.strictEqual(repairLoopModule.getDefaultMaxRepairAttempts(), 5, 'Should be 5 after set');

  repairLoopModule.resetDefaultMaxRepairAttempts();
  assert.strictEqual(repairLoopModule.getDefaultMaxRepairAttempts(), 3, 'Should be back to 3');

  done();
});

test('repairLoop: result.allAttempts tracks each attempt with repair metadata', function(t, done) {
  executorModule.resetRegistry();

  executorModule.registerTool('TEST_TOOL', {
    description: 'Test tool',
    schema: { required: ['value'], properties: { value: { type: 'number' } } },
    handler: function(args) {
      if (args.value === 1) {
        return { success: false, error: 'Fail 1', errorCode: 'EXECUTION_ERROR' };
      }
      if (args.value === 2) {
        return { success: false, error: 'Fail 2', errorCode: 'EXECUTION_ERROR' };
      }
      return { success: true, result: args.value * 10 };
    }
  });

  var plan = createBasicPlan();
  var logger = createMockLogger();

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    repairHandler: function(plan, repairContext) {
      return {
        stepId: 'step-1',
        modifiedArgs: { value: repairContext.attemptNumber + 1 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-attempts-001' }
  });

  assert.strictEqual(result.allAttempts.length, 3, 'Should have 3 attempts');
  assert.strictEqual(result.allAttempts[0].attemptNumber, 0, 'First attempt should be 0');
  assert.strictEqual(result.allAttempts[0].isRepairExecution, false, 'First should not be repair');
  assert.strictEqual(result.allAttempts[0].repairAction, null, 'First should have no repair action');

  assert.strictEqual(result.allAttempts[1].attemptNumber, 1, 'Second attempt should be 1');
  assert.strictEqual(result.allAttempts[1].isRepairExecution, true, 'Second should be repair');
  assert.strictEqual(result.allAttempts[1].repairAction, 'MODIFY_ARGS', 'Second should have repair action');
  assert.ok(result.allAttempts[1].repairResult !== null, 'Second should have repairResult');

  assert.strictEqual(result.allAttempts[2].attemptNumber, 2, 'Third attempt should be 2');
  assert.strictEqual(result.allAttempts[2].isRepairExecution, true, 'Third should be repair');
  assert.strictEqual(result.allAttempts[2].repairAction, 'MODIFY_ARGS', 'Third should have repair action');

  done();
});

test('repairLoop: global circuit breaker terminates loop when every repair produces a new signature', function(t, done) {
  executorModule.resetRegistry();

  var sigCounter = 0;

  executorModule.registerTool('CHAOS_TOOL', {
    description: 'Always fails, each call produces a unique signature',
    schema: { required: [], properties: {} },
    handler: function(args) {
      var currentSig = sigCounter++;
      return {
        success: false,
        error: 'Chaos failure ' + currentSig,
        errorCode: 'CHAOS_' + currentSig,
        toolName: 'CHAOS_TOOL',
        stepId: 'step-1'
      };
    }
  });

  var plan = createBasicPlan();
  plan.executionSteps[0].action = 'CHAOS_TOOL';

  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    maxGlobalRepairAttempts: 5,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return {
        stepId: 'step-1',
        modifiedArgs: { value: 1 },
        repairAction: 'MODIFY_ARGS'
      };
    },
    context: { runId: 'run-chaos-001' }
  });

  assert.strictEqual(result.status, 'BLOCK', 'Should BLOCK when global cap is reached');
  assert.strictEqual(repairCallCount, 5, 'Should make exactly maxGlobalRepairAttempts (5) repair calls');

  var sig0Logs = logger.logCalls.filter(function(l) {
    return l.metadata && l.metadata.failureSignature && l.metadata.failureSignature.indexOf('CHAOS_0') === 0;
  });
  var sig4Logs = logger.logCalls.filter(function(l) {
    return l.metadata && l.metadata.failureSignature && l.metadata.failureSignature.indexOf('CHAOS_4') === 0;
  });
  assert.ok(sig0Logs.length > 0, 'Signature CHAOS_0 should appear in logs');
  assert.ok(sig4Logs.length > 0, 'Signature CHAOS_4 (last one) should appear in logs');
  assert.strictEqual(sigCounter, 6, 'Tool should be called 6 times (1 initial + 5 repairs)');

  var capLog = logger.logCalls.find(function(l) { return l.event === 'REPAIR_GLOBAL_CAP_REACHED'; });
  assert.ok(capLog, 'Should log REPAIR_GLOBAL_CAP_REACHED when global cap is hit');
  assert.strictEqual(capLog.metadata.totalRepairAttempts, 5, 'Global cap log should show totalRepairAttempts=5');
  assert.strictEqual(capLog.metadata.maxGlobalRepairAttempts, 5, 'Global cap log should show maxGlobalRepairAttempts=5');

  done();
});

test('repairLoop: global circuit breaker does not trigger before per-signature budget is exhausted', function(t, done) {
  executorModule.resetRegistry();

  var attempts = 0;

  executorModule.registerTool('STABLE_TOOL', {
    description: 'Always fails with same signature',
    schema: { required: [], properties: {} },
    handler: function(args) {
      attempts++;
      return { success: false, error: 'Stable fails', errorCode: 'STABLE_ERROR', toolName: 'STABLE_TOOL', stepId: 'step-1' };
    }
  });

  var plan = createBasicPlan();
  plan.executionSteps[0].action = 'STABLE_TOOL';

  var logger = createMockLogger();
  var repairCallCount = 0;

  var result = repairLoopModule.executeWithRepair(plan, {
    logger: logger,
    maxRepairAttempts: 3,
    maxGlobalRepairAttempts: 5,
    repairHandler: function(plan, repairContext) {
      repairCallCount++;
      return { stepId: 'step-1', modifiedArgs: { value: 1 }, repairAction: 'MODIFY_ARGS' };
    },
    context: { runId: 'run-stable-001' }
  });

  assert.strictEqual(result.status, 'BLOCK', 'Should BLOCK after per-signature budget exhausted');
  assert.strictEqual(repairCallCount, 3, 'Should stop at per-signature limit (3), not global cap (5)');
  assert.strictEqual(attempts, 4, 'Tool called 4 times: 1 initial + 3 repairs');

  var globalCapLog = logger.logCalls.find(function(l) { return l.event === 'REPAIR_GLOBAL_CAP_REACHED'; });
  assert.ok(!globalCapLog, 'Should NOT trigger global cap when per-signature budget is the limiting factor');

  var exhaustedLog = logger.logCalls.find(function(l) { return l.event === 'REPAIR_EXHAUSTED'; });
  assert.ok(exhaustedLog, 'Should log REPAIR_EXHAUSTED for the stable signature');

  done();
});