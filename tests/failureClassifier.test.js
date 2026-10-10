'use strict';

var failureClassifier = require('../src/failureClassifier');

var test = require('node:test');
var assert = require('node:assert');

test('failureClassifier: classifyStepFailure returns null for successful step', function(t, done) {
  var result = failureClassifier.classifyStepFailure({ success: true });
  assert.strictEqual(result, null, 'Successful step should return null');
  done();
});

test('failureClassifier: classifyStepFailure returns null for null input', function(t, done) {
  var result = failureClassifier.classifyStepFailure(null);
  assert.strictEqual(result, null, 'Null input should return null');
  done();
});

test('failureClassifier: UNKNOWN_TOOL maps to PIPELINE_DEFECT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'UNKNOWN_TOOL',
    error: 'Unknown tool: DEFINITELY_NOT_A_REAL_TOOL',
    stepId: 'step-1',
    action: 'DEFINITELY_NOT_A_REAL_TOOL'
  });

  assert.strictEqual(result.failureCategory, 'PIPELINE_DEFECT', 'UNKNOWN_TOOL should be PIPELINE_DEFECT');
  assert.strictEqual(result.potentiallyRecoverable, false, 'PIPELINE_DEFECT should not be recoverable');
  assert.strictEqual(result.failedStep, 'step-1', 'failedStep should be preserved');
  assert.strictEqual(result.reason.indexOf('UNKNOWN_TOOL') !== -1 || result.reason.indexOf('Unknown tool') !== -1, true, 'reason should contain error');
  assert.strictEqual(result.relevantEvidence.errorCode, 'UNKNOWN_TOOL', 'errorCode should be in evidence');
  done();
});

test('failureClassifier: INVALID_ARGS maps to CLIENT_INPUT_SCOPE', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'INVALID_ARGS',
    error: 'Invalid arguments: Missing required argument: name',
    stepId: 'step-2',
    action: 'GREET'
  });

  assert.strictEqual(result.failureCategory, 'CLIENT_INPUT_SCOPE', 'INVALID_ARGS should be CLIENT_INPUT_SCOPE');
  assert.strictEqual(result.potentiallyRecoverable, false, 'CLIENT_INPUT_SCOPE should not be recoverable');
  assert.strictEqual(result.relevantEvidence.errorCode, 'INVALID_ARGS', 'errorCode should be preserved');
  done();
});

test('failureClassifier: FILE_NOT_FOUND maps to DEPENDENCY_ENVIRONMENT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'FILE_NOT_FOUND',
    error: 'File not found: fixtures/data.json',
    stepId: 'step-3',
    action: 'LOAD_FIXTURES'
  });

  assert.strictEqual(result.failureCategory, 'DEPENDENCY_ENVIRONMENT', 'FILE_NOT_FOUND should be DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(result.potentiallyRecoverable, true, 'DEPENDENCY_ENVIRONMENT should be recoverable');
  done();
});

test('failureClassifier: MISSING_DEPENDENCY maps to DEPENDENCY_ENVIRONMENT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'MISSING_DEPENDENCY',
    error: 'Cannot find module: @vendure/core',
    stepId: 'step-1',
    action: 'IMPORT_PLUGIN'
  });

  assert.strictEqual(result.failureCategory, 'DEPENDENCY_ENVIRONMENT', 'MISSING_DEPENDENCY should be DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(result.potentiallyRecoverable, true, 'DEPENDENCY_ENVIRONMENT should be recoverable');
  done();
});

test('failureClassifier: PATH_TRAVERSAL maps to SAFETY_AUTHORIZATION', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'PATH_TRAVERSAL',
    error: 'Path traversal attempt detected: ../../../etc/passwd',
    stepId: 'step-1',
    action: 'READ_FILE'
  });

  assert.strictEqual(result.failureCategory, 'SAFETY_AUTHORIZATION', 'PATH_TRAVERSAL should be SAFETY_AUTHORIZATION');
  assert.strictEqual(result.potentiallyRecoverable, false, 'SAFETY_AUTHORIZATION should not be recoverable');
  done();
});

test('failureClassifier: UNAUTHORIZED maps to SAFETY_AUTHORIZATION', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'UNAUTHORIZED',
    error: 'Unauthorized access attempt to admin API',
    stepId: 'step-5',
    action: 'ADMIN_API_CALL'
  });

  assert.strictEqual(result.failureCategory, 'SAFETY_AUTHORIZATION', 'UNAUTHORIZED should be SAFETY_AUTHORIZATION');
  assert.strictEqual(result.potentiallyRecoverable, false, 'SAFETY_AUTHORIZATION should not be recoverable');
  done();
});

test('failureClassifier: EXECUTION_ERROR maps to PIPELINE_DEFECT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'EXECUTION_ERROR',
    error: 'Tool execution failed: Cannot read property "foo" of undefined',
    stepId: 'step-2',
    action: 'PROCESS_DATA'
  });

  assert.strictEqual(result.failureCategory, 'PIPELINE_DEFECT', 'EXECUTION_ERROR should be PIPELINE_DEFECT');
  assert.strictEqual(result.potentiallyRecoverable, false, 'PIPELINE_DEFECT should not be recoverable');
  done();
});

test('failureClassifier: error message with "permission" is SAFETY_AUTHORIZATION', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Permission denied: cannot write to /root/secrets.txt',
    stepId: 'step-1',
    action: 'WRITE_FILE'
  });

  assert.strictEqual(result.failureCategory, 'SAFETY_AUTHORIZATION', 'Permission error should be SAFETY_AUTHORIZATION');
  done();
});

test('failureClassifier: error message with "access denied" is SAFETY_AUTHORIZATION', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Access denied to resource: admin-panel',
    stepId: 'step-3',
    action: 'ACCESS_RESOURCE'
  });

  assert.strictEqual(result.failureCategory, 'SAFETY_AUTHORIZATION', 'Access denied should be SAFETY_AUTHORIZATION');
  done();
});

test('failureClassifier: error message with "enoent" is DEPENDENCY_ENVIRONMENT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Error: ENOENT: no such file or directory, open "missing.txt"',
    stepId: 'step-1',
    action: 'READ_FILE'
  });

  assert.strictEqual(result.failureCategory, 'DEPENDENCY_ENVIRONMENT', 'enoent should be DEPENDENCY_ENVIRONMENT');
  done();
});

test('failureClassifier: error message with "cannot find module" is DEPENDENCY_ENVIRONMENT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Cannot find module "./missing-dependency"',
    stepId: 'step-1',
    action: 'IMPORT'
  });

  assert.strictEqual(result.failureCategory, 'DEPENDENCY_ENVIRONMENT', 'cannot find module should be DEPENDENCY_ENVIRONMENT');
  done();
});

test('failureClassifier: error message with "missing required" is CLIENT_INPUT_SCOPE', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Missing required argument: api_key',
    stepId: 'step-2',
    action: 'CONFIGURE'
  });

  assert.strictEqual(result.failureCategory, 'CLIENT_INPUT_SCOPE', 'Missing required should be CLIENT_INPUT_SCOPE');
  done();
});

test('failureClassifier: error message with "must be" is CLIENT_INPUT_SCOPE', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Argument "timeout" must be a number',
    stepId: 'step-1',
    action: 'SET_TIMEOUT'
  });

  assert.strictEqual(result.failureCategory, 'CLIENT_INPUT_SCOPE', 'Type mismatch should be CLIENT_INPUT_SCOPE');
  done();
});

test('failureClassifier: error message with "syntaxerror" is PIPELINE_DEFECT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'SyntaxError: Unexpected token',
    stepId: 'step-1',
    action: 'PARSE_JSON'
  });

  assert.strictEqual(result.failureCategory, 'PIPELINE_DEFECT', 'SyntaxError should be PIPELINE_DEFECT');
  done();
});

test('failureClassifier: error message with "referenceerror" is PIPELINE_DEFECT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'ReferenceError: undefined is not a function',
    stepId: 'step-2',
    action: 'CALLBACK'
  });

  assert.strictEqual(result.failureCategory, 'PIPELINE_DEFECT', 'ReferenceError should be PIPELINE_DEFECT');
  done();
});

test('failureClassifier: UNKNOWN error code maps to UNKNOWN', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'UNKNOWN',
    error: 'Something went wrong but we dont know what',
    stepId: 'step-1',
    action: 'DO_SOMETHING'
  });

  assert.strictEqual(result.failureCategory, 'UNKNOWN', 'UNKNOWN error code should be UNKNOWN');
  assert.strictEqual(result.potentiallyRecoverable, false, 'UNKNOWN should not be recoverable');
  done();
});

test('failureClassifier: ASSERTION_FAILED maps to APPLICATION_DEFECT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'ASSERTION_FAILED',
    error: 'Assertion failed: expected price 1999 but got 1899',
    stepId: 'step-1',
    action: 'VERIFY_PRICE'
  });

  assert.strictEqual(result.failureCategory, 'APPLICATION_DEFECT', 'ASSERTION_FAILED should be APPLICATION_DEFECT');
  assert.strictEqual(result.potentiallyRecoverable, true, 'APPLICATION_DEFECT should be recoverable');
  done();
});

test('failureClassifier: EXPECTED_MISMATCH maps to APPLICATION_DEFECT', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'EXPECTED_MISMATCH',
    error: 'Expected: {"country":"DE","price":1999}, Actual: {"country":"DE","price":1899}',
    stepId: 'step-2',
    action: 'VALIDATE_RESULT'
  });

  assert.strictEqual(result.failureCategory, 'APPLICATION_DEFECT', 'EXPECTED_MISMATCH should be APPLICATION_DEFECT');
  assert.strictEqual(result.potentiallyRecoverable, true, 'APPLICATION_DEFECT should be recoverable');
  done();
});

test('failureClassifier: APPLICATION_DEFECT is repairable', function(t, done) {
  assert.strictEqual(failureClassifier.isRecoverable('APPLICATION_DEFECT'), true, 'APPLICATION_DEFECT is recoverable');
  done();
});

test('failureClassifier: OUT_OF_SCOPE maps to OUT_OF_SCOPE_DECISION', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'OUT_OF_SCOPE',
    error: 'Task requires a new business decision: which tax zone for XX country',
    stepId: 'step-1',
    action: 'CONFIGURE_TAX'
  });

  assert.strictEqual(result.failureCategory, 'OUT_OF_SCOPE_DECISION', 'OUT_OF_SCOPE should be OUT_OF_SCOPE_DECISION');
  assert.strictEqual(result.potentiallyRecoverable, false, 'OUT_OF_SCOPE_DECISION should not be recoverable');
  done();
});

test('failureClassifier: OUT_OF_SCOPE_DECISION is not recoverable', function(t, done) {
  assert.strictEqual(failureClassifier.isRecoverable('OUT_OF_SCOPE_DECISION'), false, 'OUT_OF_SCOPE_DECISION is not recoverable');
  done();
});

test('failureClassifier: UNKNOWN is not recoverable', function(t, done) {
  assert.strictEqual(failureClassifier.isRecoverable('UNKNOWN'), false, 'UNKNOWN is not recoverable');
  done();
});

test('failureClassifier: PIPELINE_DEFECT signal beats APPLICATION_DEFECT', function(t, done) {
  var results = [
    { stepId: 's1', success: false, errorCode: 'ASSERTION_FAILED', error: 'expected X', skipped: false },
    { stepId: 's2', success: false, errorCode: 'UNKNOWN_TOOL', error: 'unknown tool', skipped: false }
  ];

  var result = failureClassifier.findFirstUnrecoverableFailure(results);

  assert.strictEqual(result !== null, true, 'Should find a failure');
  assert.strictEqual(result.failedStep, 's2', 'Should return PIPELINE_DEFECT (s2) which takes priority');
  assert.strictEqual(result.failureCategory, 'PIPELINE_DEFECT', 'PIPELINE_DEFECT should win over APPLICATION_DEFECT');
  done();
});

test('failureClassifier: UNKNOWN error message defaults to UNKNOWN category', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'SOME_UNKNOWN_ERROR',
    error: 'Something went wrong but we dont know what',
    stepId: 'step-1',
    action: 'DO_SOMETHING'
  });

  assert.strictEqual(result.failureCategory, 'UNKNOWN', 'Unknown error code with no pattern match should be UNKNOWN');
  assert.strictEqual(result.potentiallyRecoverable, false, 'UNKNOWN should not be recoverable');
  done();
});

test('failureClassifier: UNKNOWN never counts as PASS', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'UNKNOWN',
    error: 'Completely unexpected error',
    stepId: 'step-1',
    action: 'UNKNOWN_ACTION'
  });

  assert.strictEqual(result !== null, true, 'Classification should exist');
  assert.strictEqual(result.failureCategory, 'UNKNOWN', 'Should be UNKNOWN category');
  assert.strictEqual(result.potentiallyRecoverable, false, 'UNKNOWN is not recoverable, so it can never be PASS');
  done();
});

test('failureClassifier: error message with "rate limit" is DEPENDENCY_ENVIRONMENT (RATE_LIMIT sub-reason)', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Rate limit exceeded: 429 Too Many Requests',
    stepId: 'step-1',
    action: 'API_CALL'
  });

  assert.strictEqual(result.failureCategory, 'DEPENDENCY_ENVIRONMENT', 'Rate limit should be DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(result.potentiallyRecoverable, true, 'DEPENDENCY_ENVIRONMENT (RATE_LIMIT) should be recoverable');
  done();
});
test('failureClassifier: findFirstUnrecoverableFailure returns first non-recoverable', function(t, done) {
  var results = [
    { stepId: 's1', success: false, errorCode: 'FILE_NOT_FOUND', error: 'file not found', skipped: false },
    { stepId: 's2', success: false, errorCode: 'UNKNOWN_TOOL', error: 'unknown tool', skipped: false }
  ];

  var result = failureClassifier.findFirstUnrecoverableFailure(results);

  assert.strictEqual(result !== null, true, 'Should find a failure');
  assert.strictEqual(result.failedStep, 's2', 'Should return first unrecoverable (UNKNOWN_TOOL)');
  assert.strictEqual(result.failureCategory, 'PIPELINE_DEFECT', 'Should be PIPELINE_DEFECT');
  done();
});

test('failureClassifier: findFirstUnrecoverableFailure skips successful steps', function(t, done) {
  var results = [
    { stepId: 's1', success: true, skipped: false },
    { stepId: 's2', success: false, errorCode: 'UNKNOWN_TOOL', error: 'unknown tool', skipped: false }
  ];

  var result = failureClassifier.findFirstUnrecoverableFailure(results);

  assert.strictEqual(result !== null, true, 'Should find a failure');
  assert.strictEqual(result.failedStep, 's2', 'Should skip successful and find s2');
  done();
});

test('failureClassifier: findFirstUnrecoverableFailure skips skipped steps', function(t, done) {
  var results = [
    { stepId: 's1', success: false, errorCode: 'UNKNOWN_TOOL', error: 'unknown', skipped: true },
    { stepId: 's2', success: false, errorCode: 'UNKNOWN_TOOL', error: 'unknown tool', skipped: false }
  ];

  var result = failureClassifier.findFirstUnrecoverableFailure(results);

  assert.strictEqual(result !== null, true, 'Should find a failure');
  assert.strictEqual(result.failedStep, 's2', 'Should skip skipped steps and find s2');
  done();
});

test('failureClassifier: findFirstUnrecoverableFailure returns null when only recoverable failures', function(t, done) {
  var results = [
    { stepId: 's1', success: false, errorCode: 'FILE_NOT_FOUND', error: 'file not found', skipped: false },
    { stepId: 's2', success: false, errorCode: 'MISSING_DEPENDENCY', error: 'missing module', skipped: false }
  ];

  var result = failureClassifier.findFirstUnrecoverableFailure(results);

  assert.strictEqual(result, null, 'Should return null when all failures are recoverable');
  done();
});

test('failureClassifier: findFirstUnrecoverableFailure returns null for empty array', function(t, done) {
  var result = failureClassifier.findFirstUnrecoverableFailure([]);
  assert.strictEqual(result, null, 'Empty array should return null');
  done();
});

test('failureClassifier: findFirstUnrecoverableFailure returns null for null input', function(t, done) {
  var result = failureClassifier.findFirstUnrecoverableFailure(null);
  assert.strictEqual(result, null, 'Null input should return null');
  done();
});

test('failureClassifier: findFirstUnrecoverableFailure returns null when all steps succeed', function(t, done) {
  var results = [
    { stepId: 's1', success: true, skipped: false },
    { stepId: 's2', success: true, skipped: false }
  ];

  var result = failureClassifier.findFirstUnrecoverableFailure(results);

  assert.strictEqual(result, null, 'No failures should return null');
  done();
});

test('failureClassifier: classifyExecutionFailure returns null for successful execution', function(t, done) {
  var executionResult = {
    success: true,
    planId: 'plan-1',
    runId: 'run-1',
    summary: { totalSteps: 3, completed: 3, failed: 0, skipped: 0 }
  };

  var result = failureClassifier.classifyExecutionFailure(executionResult);

  assert.strictEqual(result, null, 'Successful execution should return null');
  done();
});

test('failureClassifier: classifyExecutionFailure returns full classification for failed execution', function(t, done) {
  var executionResult = {
    success: false,
    planId: 'plan-123',
    runId: 'run-456',
    results: [
      { stepId: 's1', success: true, action: 'VALIDATE_ENVIRONMENT', skipped: false },
      { stepId: 's2', success: false, errorCode: 'UNKNOWN_TOOL', error: 'Unknown tool', action: 'DO_SOMETHING', skipped: false }
    ],
    summary: { totalSteps: 3, completed: 1, failed: 1, skipped: 1 }
  };

  var result = failureClassifier.classifyExecutionFailure(executionResult);

  assert.strictEqual(result.overallSuccess, false, 'overallSuccess should be false');
  assert.strictEqual(result.planId, 'plan-123', 'planId should be preserved');
  assert.strictEqual(result.runId, 'run-456', 'runId should be preserved');
  assert.strictEqual(result.totalSteps, 3, 'totalSteps should be preserved');
  assert.strictEqual(result.failedSteps, 1, 'failedSteps should be preserved');
  assert.strictEqual(result.firstUnrecoverableFailure !== null, true, 'firstUnrecoverableFailure should exist');
  assert.strictEqual(result.allClassifications.length, 1, 'Should have one classification');
  assert.strictEqual(result.summary.pipelineDefectCount, 1, 'Should have one pipeline defect');
  done();
});

test('failureClassifier: classifyExecutionFailure counts failures by category', function(t, done) {
  var executionResult = {
    success: false,
    results: [
      { stepId: 's1', success: false, errorCode: 'UNKNOWN_TOOL', error: 'unknown', action: 'A', skipped: false },
      { stepId: 's2', success: false, errorCode: 'INVALID_ARGS', error: 'invalid', action: 'B', skipped: false },
      { stepId: 's3', success: false, errorCode: 'FILE_NOT_FOUND', error: 'not found', action: 'C', skipped: false },
      { stepId: 's4', success: false, errorCode: 'UNAUTHORIZED', error: 'unauthorized', action: 'D', skipped: false },
      { stepId: 's5', success: false, errorCode: 'ASSERTION_FAILED', error: 'assertion failed', action: 'E', skipped: false },
      { stepId: 's6', success: false, errorCode: 'OUT_OF_SCOPE', error: 'out of scope', action: 'F', skipped: false },
      { stepId: 's7', success: false, errorCode: 'UNKNOWN', error: 'unknown error', action: 'G', skipped: false }
    ],
    summary: { totalSteps: 7, completed: 0, failed: 7, skipped: 0 }
  };

  var result = failureClassifier.classifyExecutionFailure(executionResult);

  assert.strictEqual(result.summary.pipelineDefectCount, 1, 'Should have 1 PIPELINE_DEFECT');
  assert.strictEqual(result.summary.clientInputScopeCount, 1, 'Should have 1 CLIENT_INPUT_SCOPE');
  assert.strictEqual(result.summary.dependencyEnvironmentCount, 1, 'Should have 1 DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(result.summary.safetyAuthorizationCount, 1, 'Should have 1 SAFETY_AUTHORIZATION');
  assert.strictEqual(result.summary.applicationDefectCount, 1, 'Should have 1 APPLICATION_DEFECT');
  assert.strictEqual(result.summary.outOfScopeDecisionCount, 1, 'Should have 1 OUT_OF_SCOPE_DECISION');
  assert.strictEqual(result.summary.unknownCount, 1, 'Should have 1 UNKNOWN');
  done();
});

test('failureClassifier: isRecoverable returns correct values', function(t, done) {
  assert.strictEqual(failureClassifier.isRecoverable('PIPELINE_DEFECT'), false, 'PIPELINE_DEFECT is not recoverable');
  assert.strictEqual(failureClassifier.isRecoverable('APPLICATION_DEFECT'), true, 'APPLICATION_DEFECT is recoverable');
  assert.strictEqual(failureClassifier.isRecoverable('CLIENT_INPUT_SCOPE'), false, 'CLIENT_INPUT_SCOPE is not recoverable');
  assert.strictEqual(failureClassifier.isRecoverable('DEPENDENCY_ENVIRONMENT'), true, 'DEPENDENCY_ENVIRONMENT is recoverable');
  assert.strictEqual(failureClassifier.isRecoverable('SAFETY_AUTHORIZATION'), false, 'SAFETY_AUTHORIZATION is not recoverable');
  assert.strictEqual(failureClassifier.isRecoverable('OUT_OF_SCOPE_DECISION'), false, 'OUT_OF_SCOPE_DECISION is not recoverable');
  assert.strictEqual(failureClassifier.isRecoverable('UNKNOWN'), false, 'UNKNOWN is not recoverable');
  done();
});

test('failureClassifier: isKnownCategory validates correctly', function(t, done) {
  assert.strictEqual(failureClassifier.isKnownCategory('PIPELINE_DEFECT'), true, 'PIPELINE_DEFECT is known');
  assert.strictEqual(failureClassifier.isKnownCategory('APPLICATION_DEFECT'), true, 'APPLICATION_DEFECT is known');
  assert.strictEqual(failureClassifier.isKnownCategory('CLIENT_INPUT_SCOPE'), true, 'CLIENT_INPUT_SCOPE is known');
  assert.strictEqual(failureClassifier.isKnownCategory('DEPENDENCY_ENVIRONMENT'), true, 'DEPENDENCY_ENVIRONMENT is known');
  assert.strictEqual(failureClassifier.isKnownCategory('SAFETY_AUTHORIZATION'), true, 'SAFETY_AUTHORIZATION is known');
  assert.strictEqual(failureClassifier.isKnownCategory('OUT_OF_SCOPE_DECISION'), true, 'OUT_OF_SCOPE_DECISION is known');
  assert.strictEqual(failureClassifier.isKnownCategory('UNKNOWN'), true, 'UNKNOWN is known');
  assert.strictEqual(failureClassifier.isKnownCategory('UNKNOWN_CATEGORY'), false, 'Unknown category is not known');
  assert.strictEqual(failureClassifier.isKnownCategory(null), false, 'null is not known');
  assert.strictEqual(failureClassifier.isKnownCategory(undefined), false, 'undefined is not known');
  done();
});

test('failureClassifier: FAILURE_CATEGORIES exposes all categories', function(t, done) {
  var cats = failureClassifier.FAILURE_CATEGORIES;
  assert.strictEqual(cats.PIPELINE_DEFECT, 'PIPELINE_DEFECT', 'PIPELINE_DEFECT should be exposed');
  assert.strictEqual(cats.APPLICATION_DEFECT, 'APPLICATION_DEFECT', 'APPLICATION_DEFECT should be exposed');
  assert.strictEqual(cats.CLIENT_INPUT_SCOPE, 'CLIENT_INPUT_SCOPE', 'CLIENT_INPUT_SCOPE should be exposed');
  assert.strictEqual(cats.DEPENDENCY_ENVIRONMENT, 'DEPENDENCY_ENVIRONMENT', 'DEPENDENCY_ENVIRONMENT should be exposed');
  assert.strictEqual(cats.SAFETY_AUTHORIZATION, 'SAFETY_AUTHORIZATION', 'SAFETY_AUTHORIZATION should be exposed');
  assert.strictEqual(cats.OUT_OF_SCOPE_DECISION, 'OUT_OF_SCOPE_DECISION', 'OUT_OF_SCOPE_DECISION should be exposed');
  assert.strictEqual(cats.UNKNOWN, 'UNKNOWN', 'UNKNOWN should be exposed');
  done();
});

test('failureClassifier: preserves failed step, category, reason, and evidence', function(t, done) {
  var stepResult = {
    success: false,
    errorCode: 'VALIDATION_ERROR',
    error: 'Missing required field: configuration',
    stepId: 'step-config-001',
    action: 'VALIDATE_CONFIG',
    toolName: 'VALIDATE_CONFIG',
    timestamp: '2024-01-01T00:00:00.000Z'
  };

  var result = failureClassifier.classifyStepFailure(stepResult);

  assert.strictEqual(result.failedStep, 'step-config-001', 'failedStep should be preserved');
  assert.strictEqual(result.failureCategory, 'CLIENT_INPUT_SCOPE', 'failureCategory should be set');
  assert.strictEqual(result.reason, 'VALIDATION_ERROR: Missing required field: configuration', 'reason should be constructed');
  assert.strictEqual(result.relevantEvidence.stepId, 'step-config-001', 'stepId should be in evidence');
  assert.strictEqual(result.relevantEvidence.action, 'VALIDATE_CONFIG', 'action should be in evidence');
  assert.strictEqual(result.relevantEvidence.errorCode, 'VALIDATION_ERROR', 'errorCode should be in evidence');
  assert.strictEqual(result.relevantEvidence.errorMessage, 'Missing required field: configuration', 'errorMessage should be in evidence');
  done();
});

test('failureClassifier: reason is just errorCode when no errorMessage', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    errorCode: 'UNKNOWN_TOOL',
    stepId: 's1'
  });

  assert.strictEqual(result.reason, 'UNKNOWN_TOOL', 'reason should be just errorCode when no errorMessage');
  done();
});

test('failureClassifier: reason is errorMessage when no errorCode', function(t, done) {
  var result = failureClassifier.classifyStepFailure({
    success: false,
    error: 'Something broke in the pipeline',
    stepId: 's1'
  });

  assert.strictEqual(result.reason, 'Something broke in the pipeline', 'reason should be errorMessage when no errorCode');
  done();
});

test('failureClassifier: failure is never converted to PASS through classification', function(t, done) {
  var stepResult = {
    success: false,
    errorCode: 'UNKNOWN_TOOL',
    error: 'Tool not registered',
    stepId: 's1',
    action: 'MISSING_TOOL'
  };

  var classification = failureClassifier.classifyStepFailure(stepResult);

  assert.strictEqual(classification !== null, true, 'Classification should exist for failed step');
  assert.strictEqual(classification.potentiallyRecoverable === false, true, 'Classification should not make failure recoverable');
  assert.strictEqual(stepResult.success, false, 'Original step result should remain failed');
  done();
});