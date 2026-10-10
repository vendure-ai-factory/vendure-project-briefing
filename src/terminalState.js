'use strict';

/**
 * Terminal states and failure classification for the pipeline.
 *
 * Terminal states:
 *   PASS_CANDIDATE  - Run succeeded; waiting for final decision module verification.
 *                     Only the decision module (chunk 9) may produce the final passing outcome.
 *   BLOCK           - Unrecoverable failure; run is blocked.
 *   AUTH_REQUIRED   - Safety authorization required; run is blocked pending approval.
 *   MISSING_EVIDENCE - Required evidence not found; run cannot proceed.
 *   UNRESOLVED_ASSUMPTION - Assumption could not be validated; run cannot proceed.
 *
 * Failure classes (six classes):
 *   PIPELINE_DEFECT    - Bug in pipeline/tooling code.
 *   APPLICATION_DEFECT - Bug in application code being modified.
 *   CLIENT_INPUT_SCOPE - Client input is invalid or out of scope.
 *   DEPENDENCY_ENVIRONMENT - External dependency or environment is unavailable.
 *   SAFETY_AUTHORIZATION  - Safety or authorization check failed.
 *   OUT_OF_SCOPE_DECISION - Decision is outside pipeline's authority.
 *
 * Rules:
 *   CLIENT_INPUT_SCOPE and DEPENDENCY_ENVIRONMENT = pending (waiting time
 *     excluded from delay clock). These are not BLOCK but require external action.
 *   APPLICATION_DEFECT and PIPELINE_DEFECT with exhausted repairs = BLOCK.
 *   Circuit-open yields BLOCK with safeStop:true and never PASS_CANDIDATE.
 *   Each classification carries: reason, evidence, and the rule that triggered it.
 */

var RESULT_PASS = 'PASS';  // the only sanctioned definition
var RESULT_READINESS_PASS = 'READINESS_PASS';

// Coverage vocabulary shared across the CLI and the readiness executors:
// the record carries full, readiness-subset, partial or none. A readiness-subset
// pass is reported as READINESS_PASS, never as a full pass. A task with no
// executor records coverage "none", never "full".
var COVERAGE_FULL = 'full';
var COVERAGE_READINESS_SUBSET = 'readiness-subset';
var COVERAGE_PARTIAL = 'partial';
var COVERAGE_NONE = 'none';

var TERMINAL_STATES = {
  PASS_CANDIDATE: 'PASS_CANDIDATE',
  BLOCK: 'BLOCK',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  UNRESOLVED_ASSUMPTION: 'UNRESOLVED_ASSUMPTION'
};

var FAILURE_CLASSES = {
  PIPELINE_DEFECT: 'PIPELINE_DEFECT',
  APPLICATION_DEFECT: 'APPLICATION_DEFECT',
  CLIENT_INPUT_SCOPE: 'CLIENT_INPUT_SCOPE',
  DEPENDENCY_ENVIRONMENT: 'DEPENDENCY_ENVIRONMENT',
  SAFETY_AUTHORIZATION: 'SAFETY_AUTHORIZATION',
  OUT_OF_SCOPE_DECISION: 'OUT_OF_SCOPE_DECISION'
};

var RECOVERABLE_MAP = {};
RECOVERABLE_MAP[FAILURE_CLASSES.PIPELINE_DEFECT] = false;
RECOVERABLE_MAP[FAILURE_CLASSES.APPLICATION_DEFECT] = true;
RECOVERABLE_MAP[FAILURE_CLASSES.CLIENT_INPUT_SCOPE] = false;
RECOVERABLE_MAP[FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT] = true;
RECOVERABLE_MAP[FAILURE_CLASSES.SAFETY_AUTHORIZATION] = false;
RECOVERABLE_MAP[FAILURE_CLASSES.OUT_OF_SCOPE_DECISION] = false;

/**
 * Mapping from failure class to terminal state when repairs are exhausted.
 * CLIENT_INPUT_SCOPE and DEPENDENCY_ENVIRONMENT -> pending (not BLOCK).
 * APPLICATION_DEFECT and PIPELINE_DEFECT -> BLOCK.
 * SAFETY_AUTHORIZATION -> AUTH_REQUIRED.
 * OUT_OF_SCOPE_DECISION -> UNRESOLVED_ASSUMPTION.
 */
function failureClassToTerminalState(failureClass, repairsExhausted) {
  switch (failureClass) {
    case FAILURE_CLASSES.CLIENT_INPUT_SCOPE:
      return TERMINAL_STATES.UNRESOLVED_ASSUMPTION;
    case FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT:
      return TERMINAL_STATES.MISSING_EVIDENCE;
    case FAILURE_CLASSES.APPLICATION_DEFECT:
    case FAILURE_CLASSES.PIPELINE_DEFECT:
      return repairsExhausted ? TERMINAL_STATES.BLOCK : null;
    case FAILURE_CLASSES.SAFETY_AUTHORIZATION:
      return TERMINAL_STATES.AUTH_REQUIRED;
    case FAILURE_CLASSES.OUT_OF_SCOPE_DECISION:
      return TERMINAL_STATES.UNRESOLVED_ASSUMPTION;
    default:
      return null;
  }
}

/**
 * Is this a "pending" terminal state? Pending states wait for external action
 * and their time is excluded from the delay clock.
 */
function isPendingState(terminalState) {
  return terminalState === TERMINAL_STATES.UNRESOLVED_ASSUMPTION ||
         terminalState === TERMINAL_STATES.MISSING_EVIDENCE;
}

/**
 * Is this a blocking terminal state?
 */
function isBlockingState(terminalState) {
  return terminalState === TERMINAL_STATES.BLOCK ||
         terminalState === TERMINAL_STATES.AUTH_REQUIRED;
}

/**
 * Build a classification result with reason, evidence, and rule.
 *
 * @param {string} failureClass - One of FAILURE_CLASSES values
 * @param {string} reason - Human-readable reason
 * @param {Object} evidence - Evidence object (errorCode, errorMessage, stepId, etc.)
 * @param {string} rule - The rule/pattern that triggered this classification
 * @returns {Object} Classification with all required fields
 */
function buildClassification(failureClass, reason, evidence, rule) {
  return {
    failureClass: failureClass,
    reason: reason || 'Unknown',
    evidence: evidence || {},
    rule: rule || null,
    recoverable: RECOVERABLE_MAP[failureClass] || false
  };
}

/**
 * Map an error code to a failure class with the rule that triggered it.
 */
function classifyByErrorCode(errorCode, errorMessage) {
  switch (errorCode) {
    case 'UNKNOWN_TOOL':
    case 'EXECUTION_ERROR':
      return buildClassification(
        FAILURE_CLASSES.PIPELINE_DEFECT,
        errorMessage || 'Pipeline tooling error: ' + errorCode,
        { errorCode: errorCode },
        'errorCode:UNKNOWN_TOOL|EXECUTION_ERROR -> PIPELINE_DEFECT'
      );
    case 'INVALID_ARGS':
    case 'VALIDATION_ERROR':
      return buildClassification(
        FAILURE_CLASSES.CLIENT_INPUT_SCOPE,
        errorMessage || 'Client input error: ' + errorCode,
        { errorCode: errorCode },
        'errorCode:INVALID_ARGS|VALIDATION_ERROR -> CLIENT_INPUT_SCOPE'
      );
    case 'ASSERTION_FAILED':
    case 'EXPECTED_MISMATCH':
      return buildClassification(
        FAILURE_CLASSES.APPLICATION_DEFECT,
        errorMessage || 'Application error: ' + errorCode,
        { errorCode: errorCode },
        'errorCode:ASSERTION_FAILED|EXPECTED_MISMATCH -> APPLICATION_DEFECT'
      );
    case 'OUT_OF_SCOPE':
      return buildClassification(
        FAILURE_CLASSES.OUT_OF_SCOPE_DECISION,
        errorMessage || 'Out of scope decision',
        { errorCode: errorCode },
        'errorCode:OUT_OF_SCOPE -> OUT_OF_SCOPE_DECISION'
      );
    case 'FILE_NOT_FOUND':
    case 'MISSING_DEPENDENCY':
    case 'ENVIRONMENT_ERROR':
    case 'RATE_LIMIT':
      return buildClassification(
        FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT,
        errorMessage || 'Dependency/environment error: ' + errorCode,
        { errorCode: errorCode },
        'errorCode:FILE_NOT_FOUND|MISSING_DEPENDENCY|ENVIRONMENT_ERROR|RATE_LIMIT -> DEPENDENCY_ENVIRONMENT'
      );
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
    case 'PATH_TRAVERSAL':
    case 'FIXTURES_UNAVAILABLE':
      return buildClassification(
        FAILURE_CLASSES.SAFETY_AUTHORIZATION,
        errorMessage || 'Safety/authorization error: ' + errorCode,
        { errorCode: errorCode },
        'errorCode:UNAUTHORIZED|FORBIDDEN|PATH_TRAVERSAL|FIXTURES_UNAVAILABLE -> SAFETY_AUTHORIZATION'
      );
    case 'BUDGET_PAUSED':
    case 'UNKNOWN':
      return buildClassification(
        FAILURE_CLASSES.PIPELINE_DEFECT,
        errorMessage || 'Unknown error: ' + errorCode,
        { errorCode: errorCode },
        'errorCode:BUDGET_PAUSED|UNKNOWN -> PIPELINE_DEFECT (default)'
      );
    default:
      return null;
  }
}

/**
 * Classify by error message pattern.
 */
function classifyByErrorMessage(errorMessage, errorCode) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return null;
  }

  var lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.indexOf('permission') !== -1 ||
      lowerMessage.indexOf('unauthorized') !== -1 ||
      lowerMessage.indexOf('forbidden') !== -1 ||
      lowerMessage.indexOf('access denied') !== -1) {
    return buildClassification(
      FAILURE_CLASSES.SAFETY_AUTHORIZATION,
      errorMessage,
      { errorCode: errorCode || null, errorMessage: errorMessage },
      'message:permission|unauthorized|forbidden|access denied -> SAFETY_AUTHORIZATION'
    );
  }

  if (lowerMessage.indexOf('invalid') !== -1 ||
      lowerMessage.indexOf('missing required') !== -1 ||
      lowerMessage.indexOf('must be') !== -1) {
    return buildClassification(
      FAILURE_CLASSES.CLIENT_INPUT_SCOPE,
      errorMessage,
      { errorCode: errorCode || null, errorMessage: errorMessage },
      'message:invalid|missing required|must be -> CLIENT_INPUT_SCOPE'
    );
  }

  if (lowerMessage.indexOf('environment') !== -1 ||
      lowerMessage.indexOf('env ') !== -1 ||
      lowerMessage.indexOf('enoent') !== -1 ||
      lowerMessage.indexOf('rate limit') !== -1) {
    return buildClassification(
      FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT,
      errorMessage,
      { errorCode: errorCode || null, errorMessage: errorMessage },
      'message:environment|env |enoent|rate limit -> DEPENDENCY_ENVIRONMENT'
    );
  }

  if (lowerMessage.indexOf('missing') !== -1) {
    return buildClassification(
      FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT,
      errorMessage,
      { errorCode: errorCode || null, errorMessage: errorMessage },
      'message:missing -> DEPENDENCY_ENVIRONMENT'
    );
  }

  if (lowerMessage.indexOf('file not found') !== -1 ||
      lowerMessage.indexOf('cannot find module') !== -1 ||
      lowerMessage.indexOf('module not found') !== -1) {
    return buildClassification(
      FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT,
      errorMessage,
      { errorCode: errorCode || null, errorMessage: errorMessage },
      'message:file not found|cannot find module|module not found -> DEPENDENCY_ENVIRONMENT'
    );
  }

  if (lowerMessage.indexOf('syntax') !== -1 ||
      lowerMessage.indexOf('referenceerror') !== -1 ||
      lowerMessage.indexOf('typeerror') !== -1 ||
      lowerMessage.indexOf('unexpected') !== -1) {
    return buildClassification(
      FAILURE_CLASSES.PIPELINE_DEFECT,
      errorMessage,
      { errorCode: errorCode || null, errorMessage: errorMessage },
      'message:syntax|referenceerror|typeerror|unexpected -> PIPELINE_DEFECT'
    );
  }

  if (errorCode === 'EXECUTION_ERROR') {
    return buildClassification(
      FAILURE_CLASSES.PIPELINE_DEFECT,
      errorMessage,
      { errorCode: errorCode, errorMessage: errorMessage },
      'errorCode:EXECUTION_ERROR -> PIPELINE_DEFECT'
    );
  }

  return null;
}

/**
 * Classify a step failure result.
 */
function classifyStepFailure(stepResult) {
  if (!stepResult || stepResult.success === true) {
    return null;
  }

  var errorCode = stepResult.errorCode || null;
  var errorMessage = stepResult.error || null;

  var classification = classifyByErrorCode(errorCode, errorMessage);

  if (!classification) {
    classification = classifyByErrorMessage(errorMessage, errorCode);
  }

  if (!classification) {
    classification = buildClassification(
      FAILURE_CLASSES.PIPELINE_DEFECT,
      errorMessage || 'Unknown error',
      { errorCode: errorCode, errorMessage: errorMessage },
      'default -> PIPELINE_DEFECT'
    );
  }

  // Add step context to evidence
  if (stepResult.stepId) {
    classification.evidence.stepId = stepResult.stepId;
  }
  if (stepResult.action || stepResult.toolName) {
    classification.evidence.action = stepResult.action || stepResult.toolName;
  }

  return classification;
}

/**
 * Build a safe-stop result.
 */
function buildSafeStop(classification, cleanupResult) {
  return {
    safeStop: true,
    terminalState: TERMINAL_STATES.BLOCK,
    rule: classification ? classification.rule : null,
    reason: classification ? classification.reason : 'Circuit open',
    cleanupResult: cleanupResult || null,
    timestamp: new Date().toISOString()
  };
}

/**
 * Finalize a task into a pass, block or N-A outcome with class and reason.
 *
 * A passing outcome is returned only when expected equals actual from real executor
 * evidence, never from a default. Every non-passing outcome carries a failure
 * class and reason.
 *
 * options:
 *   applicable          - false yields N/A
 *   classification      - pre-classified BLOCK (e.g. PIPELINE_DEFECT for a
 *                         missing executor, CLIENT_INPUT_SCOPE for a failed
 *                         preflight); returned as BLOCK preserving the class
 *   cause, reason, rule - carried on the pre-classified BLOCK
 *   executorFound       - false yields BLOCK / PIPELINE_DEFECT / NOT_IMPLEMENTED
 *   execution           - {success, expected, actual, evidence, error, errorCode}
 *   executorEvidenceOk  - top-level alias for execution.success
 *   expected, actual    - top-level aliases for the evidence comparison
 *
 * @param {Object} options
 * @returns {Object} {result, classification, cause, reason, rule, evidence}
 */
function finalizeTaskOutcome(options) {
  options = options || {};

  if (options.applicable === false) {
    return {
      result: 'N/A',
      classification: null,
      cause: null,
      reason: options.reason || 'Task is not applicable'
    };
  }

  if (options.classification) {
    return {
      result: 'BLOCK',
      classification: options.classification,
      cause: options.cause || null,
      reason: options.reason || 'task blocked',
      rule: options.rule || null
    };
  }

  if (options.failure && options.failure.classification) {
    return {
      result: 'BLOCK',
      classification: options.failure.classification,
      cause: options.failure.cause || null,
      reason: options.failure.reason || 'task blocked',
      rule: options.failure.rule || null
    };
  }

  if (options.executorFound === false) {
    return {
      result: 'BLOCK',
      classification: FAILURE_CLASSES.PIPELINE_DEFECT,
      cause: 'NOT_IMPLEMENTED',
      reason: 'no executor implemented'
    };
  }

  var execution;
  if (options.execution) {
    execution = options.execution;
  } else {
    execution = {
      success: options.executorEvidenceOk === true,
      expected: options.expected,
      actual: options.actual,
      evidence: options.evidence || null,
      error: options.error,
      errorCode: options.errorCode
    };
  }

  if (!execution || execution.success !== true) {
    var errorCode = execution && execution.errorCode;
    var errorMessage = execution && execution.error;
    var classification = classifyByErrorCode(errorCode, errorMessage);
    if (!classification) {
      classification = classifyByErrorMessage(errorMessage, errorCode);
    }
    if (!classification) {
      classification = buildClassification(
        FAILURE_CLASSES.PIPELINE_DEFECT,
        errorMessage || 'Execution did not succeed',
        { errorCode: errorCode },
        'execution failure default -> PIPELINE_DEFECT'
      );
    }
    return {
      result: 'BLOCK',
      classification: classification.failureClass,
      cause: errorCode || null,
      reason: classification.reason,
      rule: classification.rule
    };
  }

  var expected = execution.expected;
  var actual = execution.actual;
  var evidence = execution.evidence || null;
  var evidenceOk = evidence !== null && typeof evidence === 'object' && Object.keys(evidence).length > 0;

  if (evidenceOk && valuesEqual(expected, actual)) {
    return {
      result: RESULT_PASS,
      classification: null,
      cause: null,
      reason: null,
      evidence: evidence
    };
  }

  return {
    result: 'BLOCK',
    classification: FAILURE_CLASSES.APPLICATION_DEFECT,
    cause: 'EXPECTED_MISMATCH',
    reason: 'expected did not equal actual from executor evidence'
  };
}

function valuesEqual(a, b) {
  var sa = stringifyValue(a);
  var sb = stringifyValue(b);
  return sa === sb;
}

function stringifyValue(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

module.exports = {
  TERMINAL_STATES: TERMINAL_STATES,
  FAILURE_CLASSES: FAILURE_CLASSES,
  failureClassToTerminalState: failureClassToTerminalState,
  isPendingState: isPendingState,
  isBlockingState: isBlockingState,
  buildClassification: buildClassification,
  classifyByErrorCode: classifyByErrorCode,
  classifyByErrorMessage: classifyByErrorMessage,
  classifyStepFailure: classifyStepFailure,
  buildSafeStop: buildSafeStop,
  finalizeTaskOutcome: finalizeTaskOutcome,
  RESULT_PASS: RESULT_PASS,
  RESULT_READINESS_PASS: RESULT_READINESS_PASS,
  COVERAGE_FULL: COVERAGE_FULL,
  COVERAGE_READINESS_SUBSET: COVERAGE_READINESS_SUBSET,
  COVERAGE_PARTIAL: COVERAGE_PARTIAL,
  COVERAGE_NONE: COVERAGE_NONE
};