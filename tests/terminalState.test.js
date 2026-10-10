'use strict';

var terminalStateModule = require('../src/terminalState');
var test = require('node:test');
var assert = require('node:assert');

test('terminalState: TERMINAL_STATES has all 5 required states', function(t, done) {
  var TS = terminalStateModule.TERMINAL_STATES;
  assert.strictEqual(TS.PASS_CANDIDATE, 'PASS_CANDIDATE', 'PASS_CANDIDATE should exist');
  assert.strictEqual(TS.BLOCK, 'BLOCK', 'BLOCK should exist');
  assert.strictEqual(TS.AUTH_REQUIRED, 'AUTH_REQUIRED', 'AUTH_REQUIRED should exist');
  assert.strictEqual(TS.MISSING_EVIDENCE, 'MISSING_EVIDENCE', 'MISSING_EVIDENCE should exist');
  assert.strictEqual(TS.UNRESOLVED_ASSUMPTION, 'UNRESOLVED_ASSUMPTION', 'UNRESOLVED_ASSUMPTION should exist');
  done();
});

test('terminalState: FAILURE_CLASSES has all 6 required classes', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;
  assert.strictEqual(FC.PIPELINE_DEFECT, 'PIPELINE_DEFECT', 'PIPELINE_DEFECT should exist');
  assert.strictEqual(FC.APPLICATION_DEFECT, 'APPLICATION_DEFECT', 'APPLICATION_DEFECT should exist');
  assert.strictEqual(FC.CLIENT_INPUT_SCOPE, 'CLIENT_INPUT_SCOPE', 'CLIENT_INPUT_SCOPE should exist');
  assert.strictEqual(FC.DEPENDENCY_ENVIRONMENT, 'DEPENDENCY_ENVIRONMENT', 'DEPENDENCY_ENVIRONMENT should exist');
  assert.strictEqual(FC.SAFETY_AUTHORIZATION, 'SAFETY_AUTHORIZATION', 'SAFETY_AUTHORIZATION should exist');
  assert.strictEqual(FC.OUT_OF_SCOPE_DECISION, 'OUT_OF_SCOPE_DECISION', 'OUT_OF_SCOPE_DECISION should exist');
  done();
});

test('terminalState: isPendingState correctly identifies pending states', function(t, done) {
  var TS = terminalStateModule.TERMINAL_STATES;
  assert.strictEqual(terminalStateModule.isPendingState(TS.UNRESOLVED_ASSUMPTION), true, 'UNRESOLVED_ASSUMPTION is pending');
  assert.strictEqual(terminalStateModule.isPendingState(TS.MISSING_EVIDENCE), true, 'MISSING_EVIDENCE is pending');
  assert.strictEqual(terminalStateModule.isPendingState(TS.BLOCK), false, 'BLOCK is not pending');
  assert.strictEqual(terminalStateModule.isPendingState(TS.AUTH_REQUIRED), false, 'AUTH_REQUIRED is not pending');
  assert.strictEqual(terminalStateModule.isPendingState(TS.PASS_CANDIDATE), false, 'PASS_CANDIDATE is not pending');
  done();
});

test('terminalState: isBlockingState correctly identifies blocking states', function(t, done) {
  var TS = terminalStateModule.TERMINAL_STATES;
  assert.strictEqual(terminalStateModule.isBlockingState(TS.BLOCK), true, 'BLOCK is blocking');
  assert.strictEqual(terminalStateModule.isBlockingState(TS.AUTH_REQUIRED), true, 'AUTH_REQUIRED is blocking');
  assert.strictEqual(terminalStateModule.isBlockingState(TS.PASS_CANDIDATE), false, 'PASS_CANDIDATE is not blocking');
  assert.strictEqual(terminalStateModule.isBlockingState(TS.MISSING_EVIDENCE), false, 'MISSING_EVIDENCE is not blocking');
  assert.strictEqual(terminalStateModule.isBlockingState(TS.UNRESOLVED_ASSUMPTION), false, 'UNRESOLVED_ASSUMPTION is not blocking');
  done();
});

test('terminalState: failureClassToTerminalState maps correctly', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;
  var TS = terminalStateModule.TERMINAL_STATES;

  // CLIENT_INPUT_SCOPE -> UNRESOLVED_ASSUMPTION (pending)
  var r1 = terminalStateModule.failureClassToTerminalState(FC.CLIENT_INPUT_SCOPE, true);
  assert.strictEqual(r1, TS.UNRESOLVED_ASSUMPTION, 'CLIENT_INPUT_SCOPE -> UNRESOLVED_ASSUMPTION');

  // DEPENDENCY_ENVIRONMENT -> MISSING_EVIDENCE (pending)
  var r2 = terminalStateModule.failureClassToTerminalState(FC.DEPENDENCY_ENVIRONMENT, true);
  assert.strictEqual(r2, TS.MISSING_EVIDENCE, 'DEPENDENCY_ENVIRONMENT -> MISSING_EVIDENCE');

  // APPLICATION_DEFECT with repairs exhausted -> BLOCK
  var r3 = terminalStateModule.failureClassToTerminalState(FC.APPLICATION_DEFECT, true);
  assert.strictEqual(r3, TS.BLOCK, 'APPLICATION_DEFECT (exhausted) -> BLOCK');

  // APPLICATION_DEFECT without repairs exhausted -> null (not terminal yet)
  var r4 = terminalStateModule.failureClassToTerminalState(FC.APPLICATION_DEFECT, false);
  assert.strictEqual(r4, null, 'APPLICATION_DEFECT (not exhausted) -> null');

  // PIPELINE_DEFECT with repairs exhausted -> BLOCK
  var r5 = terminalStateModule.failureClassToTerminalState(FC.PIPELINE_DEFECT, true);
  assert.strictEqual(r5, TS.BLOCK, 'PIPELINE_DEFECT (exhausted) -> BLOCK');

  // SAFETY_AUTHORIZATION -> AUTH_REQUIRED
  var r6 = terminalStateModule.failureClassToTerminalState(FC.SAFETY_AUTHORIZATION, true);
  assert.strictEqual(r6, TS.AUTH_REQUIRED, 'SAFETY_AUTHORIZATION -> AUTH_REQUIRED');

  // OUT_OF_SCOPE_DECISION -> UNRESOLVED_ASSUMPTION
  var r7 = terminalStateModule.failureClassToTerminalState(FC.OUT_OF_SCOPE_DECISION, true);
  assert.strictEqual(r7, TS.UNRESOLVED_ASSUMPTION, 'OUT_OF_SCOPE_DECISION -> UNRESOLVED_ASSUMPTION');

  done();
});

test('terminalState: classifyByErrorCode returns correct class with rule', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;

  // UNKNOWN_TOOL -> PIPELINE_DEFECT
  var r1 = terminalStateModule.classifyByErrorCode('UNKNOWN_TOOL');
  assert.strictEqual(r1.failureClass, FC.PIPELINE_DEFECT, 'UNKNOWN_TOOL -> PIPELINE_DEFECT');
  assert.strictEqual(r1.rule.indexOf('UNKNOWN_TOOL') !== -1, true, 'Rule should mention UNKNOWN_TOOL');
  assert.strictEqual(r1.recoverable, false, 'PIPELINE_DEFECT is not recoverable');

  // INVALID_ARGS -> CLIENT_INPUT_SCOPE
  var r2 = terminalStateModule.classifyByErrorCode('INVALID_ARGS');
  assert.strictEqual(r2.failureClass, FC.CLIENT_INPUT_SCOPE, 'INVALID_ARGS -> CLIENT_INPUT_SCOPE');
  assert.strictEqual(r2.rule.indexOf('INVALID_ARGS') !== -1, true, 'Rule should mention INVALID_ARGS');

  // FILE_NOT_FOUND -> DEPENDENCY_ENVIRONMENT
  var r3 = terminalStateModule.classifyByErrorCode('FILE_NOT_FOUND');
  assert.strictEqual(r3.failureClass, FC.DEPENDENCY_ENVIRONMENT, 'FILE_NOT_FOUND -> DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(r3.recoverable, true, 'DEPENDENCY_ENVIRONMENT is recoverable');

  // UNAUTHORIZED -> SAFETY_AUTHORIZATION
  var r4 = terminalStateModule.classifyByErrorCode('UNAUTHORIZED');
  assert.strictEqual(r4.failureClass, FC.SAFETY_AUTHORIZATION, 'UNAUTHORIZED -> SAFETY_AUTHORIZATION');

  // OUT_OF_SCOPE -> OUT_OF_SCOPE_DECISION
  var r5 = terminalStateModule.classifyByErrorCode('OUT_OF_SCOPE');
  assert.strictEqual(r5.failureClass, FC.OUT_OF_SCOPE_DECISION, 'OUT_OF_SCOPE -> OUT_OF_SCOPE_DECISION');

  // ASSERTION_FAILED -> APPLICATION_DEFECT
  var r6 = terminalStateModule.classifyByErrorCode('ASSERTION_FAILED');
  assert.strictEqual(r6.failureClass, FC.APPLICATION_DEFECT, 'ASSERTION_FAILED -> APPLICATION_DEFECT');

  // Unknown code -> null
  var r7 = terminalStateModule.classifyByErrorCode('SOME_RANDOM_CODE');
  assert.strictEqual(r7, null, 'Unknown code returns null');

  done();
});

test('terminalState: classifyByErrorMessage returns correct class with rule', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;

  // Syntax error -> PIPELINE_DEFECT
  var r1 = terminalStateModule.classifyByErrorMessage('SyntaxError: unexpected token', null);
  assert.strictEqual(r1.failureClass, FC.PIPELINE_DEFECT, 'syntax error -> PIPELINE_DEFECT');
  assert.strictEqual(r1.rule.indexOf('syntax') !== -1, true, 'Rule should mention syntax');

  // "invalid" in message -> CLIENT_INPUT_SCOPE
  var r2 = terminalStateModule.classifyByErrorMessage('Invalid argument: name is required', null);
  assert.strictEqual(r2.failureClass, FC.CLIENT_INPUT_SCOPE, 'invalid -> CLIENT_INPUT_SCOPE');

  // "environment" in message -> DEPENDENCY_ENVIRONMENT
  var r3 = terminalStateModule.classifyByErrorMessage('Environment variable not set: DATABASE_URL', null);
  assert.strictEqual(r3.failureClass, FC.DEPENDENCY_ENVIRONMENT, 'environment -> DEPENDENCY_ENVIRONMENT');

  // "permission" in message -> SAFETY_AUTHORIZATION
  var r4 = terminalStateModule.classifyByErrorMessage('Permission denied: cannot access /root', null);
  assert.strictEqual(r4.failureClass, FC.SAFETY_AUTHORIZATION, 'permission -> SAFETY_AUTHORIZATION');

  // EXECUTION_ERROR -> PIPELINE_DEFECT
  var r5 = terminalStateModule.classifyByErrorMessage('Something went wrong', 'EXECUTION_ERROR');
  assert.strictEqual(r5.failureClass, FC.PIPELINE_DEFECT, 'EXECUTION_ERROR -> PIPELINE_DEFECT');

  done();
});

test('terminalState: classifyStepFailure returns complete classification with rule', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;

  var result = terminalStateModule.classifyStepFailure({
    success: false,
    errorCode: 'FILE_NOT_FOUND',
    error: 'File not found: config.yaml',
    stepId: 'step-deploy',
    action: 'LOAD_CONFIG'
  });

  assert.strictEqual(result.failureClass, FC.DEPENDENCY_ENVIRONMENT, 'FILE_NOT_FOUND -> DEPENDENCY_ENVIRONMENT');
  assert.strictEqual(result.rule !== undefined, true, 'rule field should be present');
  assert.strictEqual(result.rule !== null, true, 'rule should not be null');
  assert.strictEqual(result.rule.indexOf('FILE_NOT_FOUND') !== -1, true, 'rule should mention FILE_NOT_FOUND');
  assert.strictEqual(result.reason.indexOf('config.yaml') !== -1, true, 'reason should contain error message');
  assert.strictEqual(result.evidence.stepId, 'step-deploy', 'evidence should have stepId');
  assert.strictEqual(result.evidence.action, 'LOAD_CONFIG', 'evidence should have action');
  assert.strictEqual(result.recoverable, true, 'DEPENDENCY_ENVIRONMENT is recoverable');

  done();
});

test('terminalState: classifyStepFailure returns null for successful step', function(t, done) {
  var result = terminalStateModule.classifyStepFailure({ success: true });
  assert.strictEqual(result, null, 'Successful step returns null');
  done();
});

test('terminalState: buildSafeStop creates proper safe-stop record', function(t, done) {
  var TS = terminalStateModule.TERMINAL_STATES;
  var FC = terminalStateModule.FAILURE_CLASSES;

  var classification = terminalStateModule.buildClassification(
    FC.PIPELINE_DEFECT,
    'Pipeline error: tool not found',
    { errorCode: 'UNKNOWN_TOOL' },
    'errorCode:UNKNOWN_TOOL -> PIPELINE_DEFECT'
  );

  var safeStop = terminalStateModule.buildSafeStop(classification, { cleanupDone: true });

  assert.strictEqual(safeStop.safeStop, true, 'safeStop should be true');
  assert.strictEqual(safeStop.terminalState, TS.BLOCK, 'terminalState should be BLOCK');
  assert.strictEqual(safeStop.rule.indexOf('UNKNOWN_TOOL') !== -1, true, 'rule should be preserved');
  assert.strictEqual(safeStop.reason.indexOf('Pipeline error') !== -1, true, 'reason should be preserved');
  assert.strictEqual(safeStop.cleanupResult.cleanupDone, true, 'cleanupResult should be stored');
  assert.strictEqual(safeStop.timestamp !== undefined, true, 'timestamp should be set');

  done();
});

test('terminalState: buildSafeStop handles null classification', function(t, done) {
  var TS = terminalStateModule.TERMINAL_STATES;
  var safeStop = terminalStateModule.buildSafeStop(null, null);

  assert.strictEqual(safeStop.safeStop, true, 'safeStop should be true');
  assert.strictEqual(safeStop.terminalState, TS.BLOCK, 'terminalState should be BLOCK');
  assert.strictEqual(safeStop.rule, null, 'rule should be null');
  assert.strictEqual(safeStop.reason, 'Circuit open', 'reason should be default');
  done();
});

test('terminalState: each terminal state is reachable from a scripted scenario', function(t, done) {
  var TS = terminalStateModule.TERMINAL_STATES;
  var FC = terminalStateModule.FAILURE_CLASSES;

  // PASS_CANDIDATE: execution succeeded (no failure to classify)
  var execResult = { success: true };
  var classResult = terminalStateModule.classifyStepFailure(execResult);
  assert.strictEqual(classResult, null, 'No classification for success');

  // BLOCK: PIPELINE_DEFECT with repairs exhausted
  var blockResult = terminalStateModule.failureClassToTerminalState(FC.PIPELINE_DEFECT, true);
  assert.strictEqual(blockResult, TS.BLOCK, 'PIPELINE_DEFECT (exhausted) reaches BLOCK');

  // AUTH_REQUIRED: SAFETY_AUTHORIZATION
  var authResult = terminalStateModule.failureClassToTerminalState(FC.SAFETY_AUTHORIZATION, true);
  assert.strictEqual(authResult, TS.AUTH_REQUIRED, 'SAFETY_AUTHORIZATION reaches AUTH_REQUIRED');

  // MISSING_EVIDENCE: DEPENDENCY_ENVIRONMENT
  var missingResult = terminalStateModule.failureClassToTerminalState(FC.DEPENDENCY_ENVIRONMENT, true);
  assert.strictEqual(missingResult, TS.MISSING_EVIDENCE, 'DEPENDENCY_ENVIRONMENT reaches MISSING_EVIDENCE');

  // UNRESOLVED_ASSUMPTION: CLIENT_INPUT_SCOPE
  var unresolvedResult = terminalStateModule.failureClassToTerminalState(FC.CLIENT_INPUT_SCOPE, true);
  assert.strictEqual(unresolvedResult, TS.UNRESOLVED_ASSUMPTION, 'CLIENT_INPUT_SCOPE reaches UNRESOLVED_ASSUMPTION');

  done();
});

test('terminalState: each failure class is produced by a scripted failure', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;

  var r1 = terminalStateModule.classifyStepFailure({
    success: false, errorCode: 'UNKNOWN_TOOL', error: 'Unknown', stepId: 's1', action: 'TOOL'
  });
  assert.strictEqual(r1.failureClass, FC.PIPELINE_DEFECT, 'UNKNOWN_TOOL -> PIPELINE_DEFECT');

  var r2 = terminalStateModule.classifyStepFailure({
    success: false, errorCode: 'ASSERTION_FAILED', error: 'Assert failed', stepId: 's2', action: 'ASSERT'
  });
  assert.strictEqual(r2.failureClass, FC.APPLICATION_DEFECT, 'ASSERTION_FAILED -> APPLICATION_DEFECT');

  var r3 = terminalStateModule.classifyStepFailure({
    success: false, errorCode: 'INVALID_ARGS', error: 'Invalid', stepId: 's3', action: 'VALIDATE'
  });
  assert.strictEqual(r3.failureClass, FC.CLIENT_INPUT_SCOPE, 'INVALID_ARGS -> CLIENT_INPUT_SCOPE');

  var r4 = terminalStateModule.classifyStepFailure({
    success: false, errorCode: 'FILE_NOT_FOUND', error: 'Not found', stepId: 's4', action: 'READ'
  });
  assert.strictEqual(r4.failureClass, FC.DEPENDENCY_ENVIRONMENT, 'FILE_NOT_FOUND -> DEPENDENCY_ENVIRONMENT');

  var r5 = terminalStateModule.classifyStepFailure({
    success: false, errorCode: 'FORBIDDEN', error: 'Forbidden', stepId: 's5', action: 'ACCESS'
  });
  assert.strictEqual(r5.failureClass, FC.SAFETY_AUTHORIZATION, 'FORBIDDEN -> SAFETY_AUTHORIZATION');

  var r6 = terminalStateModule.classifyStepFailure({
    success: false, errorCode: 'OUT_OF_SCOPE', error: 'Out of scope', stepId: 's6', action: 'DECIDE'
  });
  assert.strictEqual(r6.failureClass, FC.OUT_OF_SCOPE_DECISION, 'OUT_OF_SCOPE -> OUT_OF_SCOPE_DECISION');

  done();
});

test('terminalState: classification includes reason, evidence, and rule', function(t, done) {
  var result = terminalStateModule.classifyStepFailure({
    success: false,
    errorCode: 'RATE_LIMIT',
    error: 'Rate limit exceeded for API',
    stepId: 'api-call',
    action: 'CALL_API'
  });

  assert.strictEqual(result.reason !== undefined, true, 'reason field exists');
  assert.strictEqual(result.reason.indexOf('Rate limit') !== -1, true, 'reason contains error message');
  assert.strictEqual(result.evidence !== undefined, true, 'evidence field exists');
  assert.strictEqual(result.evidence.errorCode, 'RATE_LIMIT', 'evidence has errorCode');
  assert.strictEqual(result.evidence.stepId, 'api-call', 'evidence has stepId');
  assert.strictEqual(result.evidence.action, 'CALL_API', 'evidence has action');
  assert.strictEqual(result.rule !== undefined, true, 'rule field exists');
  assert.strictEqual(result.rule.indexOf('RATE_LIMIT') !== -1, true, 'rule mentions RATE_LIMIT');
  assert.strictEqual(result.rule.indexOf('DEPENDENCY_ENVIRONMENT') !== -1, true, 'rule maps to DEPENDENCY_ENVIRONMENT');

  done();
});

test('terminalState: buildClassification creates complete record', function(t, done) {
  var FC = terminalStateModule.FAILURE_CLASSES;
  var result = terminalStateModule.buildClassification(
    FC.APPLICATION_DEFECT,
    'Test assertion failed',
    { errorCode: 'ASSERTION_FAILED', file: 'app.js' },
    'test-rule-001'
  );

  assert.strictEqual(result.failureClass, FC.APPLICATION_DEFECT, 'failureClass matches');
  assert.strictEqual(result.reason, 'Test assertion failed', 'reason matches');
  assert.strictEqual(result.evidence.errorCode, 'ASSERTION_FAILED', 'evidence preserved');
  assert.strictEqual(result.rule, 'test-rule-001', 'rule matches');
  assert.strictEqual(result.recoverable, true, 'APPLICATION_DEFECT is recoverable');

  done();
});

// ---------------------------------------------------------------------------
// finalizeTaskOutcome
// ---------------------------------------------------------------------------

test('terminalState: finalizeTaskOutcome returns N/A when not applicable', function(t, done) {
  var o = terminalStateModule.finalizeTaskOutcome({ applicable: false, reason: 'out of scope' });
  assert.strictEqual(o.result, 'N/A');
  assert.strictEqual(o.reason, 'out of scope');
  done();
});

test('terminalState: finalizeTaskOutcome honors a pre-classified failure', function(t, done) {
  var o = terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    classification: 'CLIENT_INPUT_SCOPE',
    cause: 'MISSING_INPUT',
    reason: 'preflight blocked: testAccounts'
  });
  assert.strictEqual(o.result, 'BLOCK');
  assert.strictEqual(o.classification, 'CLIENT_INPUT_SCOPE');
  assert.strictEqual(o.cause, 'MISSING_INPUT');
  done();
});

test('terminalState: finalizeTaskOutcome returns BLOCK NOT_IMPLEMENTED when no executor', function(t, done) {
  var o = terminalStateModule.finalizeTaskOutcome({ applicable: true, executorFound: false });
  assert.strictEqual(o.result, 'BLOCK');
  assert.strictEqual(o.classification, terminalStateModule.FAILURE_CLASSES.PIPELINE_DEFECT);
  assert.strictEqual(o.cause, 'NOT_IMPLEMENTED');
  done();
});

test('terminalState: finalizeTaskOutcome returns passing outcome only on matching evidence', function(t, done) {
  var o = terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: { ok: true },
    expected: 'expected-result',
    actual: 'expected-result',
    executorEvidenceOk: true
  });
  assert.strictEqual(o.result, terminalStateModule.RESULT_PASS);
  assert.strictEqual(o.classification, null);
  done();
});

test('terminalState: finalizeTaskOutcome blocks on expected/actual mismatch', function(t, done) {
  var o = terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: { ok: true },
    expected: 'expected-result',
    actual: 'different-result',
    executorEvidenceOk: true
  });
  assert.strictEqual(o.result, 'BLOCK');
  assert.strictEqual(o.classification, terminalStateModule.FAILURE_CLASSES.APPLICATION_DEFECT);
  assert.strictEqual(o.cause, 'EXPECTED_MISMATCH');
  done();
});

test('terminalState: finalizeTaskOutcome blocks when executorEvidenceOk is false', function(t, done) {
  var o = terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: null,
    expected: 'expected-result',
    actual: null,
    executorEvidenceOk: false
  });
  assert.strictEqual(o.result, 'BLOCK');
  assert.ok(o.classification, 'should have a classification');
  done();
});

test('terminalState: RESULT_PASS is the single sanctioned PASS literal', function(t, done) {
  assert.strictEqual(terminalStateModule.RESULT_PASS, 'PASS');
  assert.strictEqual(terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: { ok: true },
    expected: 'a',
    actual: 'a',
    executorEvidenceOk: true
  }).result, 'PASS');
  done();
});