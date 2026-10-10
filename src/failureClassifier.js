'use strict';

var FAILURE_CATEGORIES = {
  PIPELINE_DEFECT: 'PIPELINE_DEFECT',
  APPLICATION_DEFECT: 'APPLICATION_DEFECT',
  CLIENT_INPUT_SCOPE: 'CLIENT_INPUT_SCOPE',
  DEPENDENCY_ENVIRONMENT: 'DEPENDENCY_ENVIRONMENT',
  SAFETY_AUTHORIZATION: 'SAFETY_AUTHORIZATION',
  OUT_OF_SCOPE_DECISION: 'OUT_OF_SCOPE_DECISION',
  BUDGET_PAUSED: 'BUDGET_PAUSED',
  UNKNOWN: 'UNKNOWN'
};

var RECOVERABLE = true;
var NOT_RECOVERABLE = false;

function isRecoverable(category) {
  switch (category) {
    case FAILURE_CATEGORIES.PIPELINE_DEFECT:
      return NOT_RECOVERABLE;
    case FAILURE_CATEGORIES.APPLICATION_DEFECT:
      return RECOVERABLE;
    case FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE:
      return NOT_RECOVERABLE;
    case FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT:
      return RECOVERABLE;
    case FAILURE_CATEGORIES.SAFETY_AUTHORIZATION:
      return NOT_RECOVERABLE;
    case FAILURE_CATEGORIES.OUT_OF_SCOPE_DECISION:
      return NOT_RECOVERABLE;
    case FAILURE_CATEGORIES.BUDGET_PAUSED:
      return NOT_RECOVERABLE;
    case FAILURE_CATEGORIES.UNKNOWN:
      return NOT_RECOVERABLE;
    default:
      return NOT_RECOVERABLE;
  }
}

function classifyErrorCode(errorCode) {
  switch (errorCode) {
    case 'UNKNOWN_TOOL':
    case 'EXECUTION_ERROR':
      return FAILURE_CATEGORIES.PIPELINE_DEFECT;
    case 'INVALID_ARGS':
    case 'VALIDATION_ERROR':
      return FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE;
    case 'ASSERTION_FAILED':
    case 'EXPECTED_MISMATCH':
      return FAILURE_CATEGORIES.APPLICATION_DEFECT;
    case 'OUT_OF_SCOPE':
      return FAILURE_CATEGORIES.OUT_OF_SCOPE_DECISION;
    case 'FILE_NOT_FOUND':
    case 'MISSING_DEPENDENCY':
    case 'ENVIRONMENT_ERROR':
    case 'RATE_LIMIT':
      return FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT;
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
    case 'PATH_TRAVERSAL':
    case 'FIXTURES_UNAVAILABLE':
      return FAILURE_CATEGORIES.SAFETY_AUTHORIZATION;
    case 'BUDGET_PAUSED':
    case 'UNKNOWN':
      return FAILURE_CATEGORIES.UNKNOWN;
    default:
      return null;
  }
}

function classifyByErrorMessage(errorMessage, errorCode) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return null;
  }

  var lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.indexOf('permission') !== -1 ||
      lowerMessage.indexOf('unauthorized') !== -1 ||
      lowerMessage.indexOf('forbidden') !== -1 ||
      lowerMessage.indexOf('access denied') !== -1) {
    return FAILURE_CATEGORIES.SAFETY_AUTHORIZATION;
  }

  if (lowerMessage.indexOf('invalid') !== -1 ||
      lowerMessage.indexOf('missing required') !== -1 ||
      lowerMessage.indexOf('must be') !== -1) {
    return FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE;
  }

  if (lowerMessage.indexOf('environment') !== -1 ||
      lowerMessage.indexOf('env ') !== -1 ||
      lowerMessage.indexOf('enoent') !== -1 ||
      lowerMessage.indexOf('rate limit') !== -1) {
    return FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT;
  }

  if (lowerMessage.indexOf('missing') !== -1) {
    return FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT;
  }

  if (lowerMessage.indexOf('file not found') !== -1 ||
      lowerMessage.indexOf('cannot find module') !== -1 ||
      lowerMessage.indexOf('module not found') !== -1) {
    return FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT;
  }

  if (lowerMessage.indexOf('syntax') !== -1 ||
      lowerMessage.indexOf('referenceerror') !== -1 ||
      lowerMessage.indexOf('typeerror') !== -1 ||
      lowerMessage.indexOf('unexpected') !== -1) {
    return FAILURE_CATEGORIES.PIPELINE_DEFECT;
  }

  if (errorCode === 'EXECUTION_ERROR') {
    return FAILURE_CATEGORIES.PIPELINE_DEFECT;
  }

  return null;
}

function classifyStepFailure(stepResult) {
  if (!stepResult || stepResult.success === true) {
    return null;
  }

  var errorCode = stepResult.errorCode || null;
  var errorMessage = stepResult.error || null;

  var category = classifyErrorCode(errorCode);

  if (!category) {
    category = classifyByErrorMessage(errorMessage, errorCode);
  }

  if (!category) {
    category = FAILURE_CATEGORIES.UNKNOWN;
  }

  var reason = errorMessage || 'Unknown error';
  if (errorCode && errorMessage && errorMessage.indexOf(errorCode) === -1) {
    reason = errorCode + ': ' + errorMessage;
  } else if (!errorMessage) {
    reason = errorCode || 'Unknown error';
  }

  var evidence = {
    errorCode: errorCode,
    errorMessage: errorMessage,
    stepId: stepResult.stepId || null,
    action: stepResult.action || null,
    toolName: stepResult.toolName || stepResult.action || null
  };

  return {
    failedStep: stepResult.stepId || null,
    failureCategory: category,
    reason: reason,
    relevantEvidence: evidence,
    potentiallyRecoverable: isRecoverable(category)
  };
}

function findFirstUnrecoverableFailure(results) {
  if (!Array.isArray(results)) {
    return null;
  }

  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    if (result.skipped) {
      continue;
    }
    if (result.success === false) {
      var classification = classifyStepFailure(result);
      if (classification && !classification.potentiallyRecoverable) {
        return classification;
      }
    }
  }

  return null;
}

function classifyExecutionFailure(executionResult) {
  if (!executionResult || executionResult.success === true) {
    return null;
  }

  var results = executionResult.results || [];

  var allClassifications = [];
  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    if (!result.skipped && result.success === false) {
      var classification = classifyStepFailure(result);
      if (classification) {
        allClassifications.push(classification);
      }
    }
  }

  var firstUnrecoverable = findFirstUnrecoverableFailure(results);

  return {
    overallSuccess: executionResult.success || false,
    planId: executionResult.planId || null,
    runId: executionResult.runId || null,
    totalSteps: executionResult.summary ? executionResult.summary.totalSteps : 0,
    failedSteps: executionResult.summary ? executionResult.summary.failed : 0,
    firstUnrecoverableFailure: firstUnrecoverable,
    allClassifications: allClassifications,
    summary: {
      pipelineDefectCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.PIPELINE_DEFECT;
      }).length,
      applicationDefectCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.APPLICATION_DEFECT;
      }).length,
      clientInputScopeCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE;
      }).length,
      dependencyEnvironmentCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT;
      }).length,
      safetyAuthorizationCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.SAFETY_AUTHORIZATION;
      }).length,
      outOfScopeDecisionCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.OUT_OF_SCOPE_DECISION;
      }).length,
      unknownCount: allClassifications.filter(function(c) {
        return c.failureCategory === FAILURE_CATEGORIES.UNKNOWN;
      }).length
    }
  };
}

function isKnownCategory(category) {
  return category === FAILURE_CATEGORIES.PIPELINE_DEFECT ||
         category === FAILURE_CATEGORIES.APPLICATION_DEFECT ||
         category === FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE ||
         category === FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT ||
         category === FAILURE_CATEGORIES.SAFETY_AUTHORIZATION ||
         category === FAILURE_CATEGORIES.OUT_OF_SCOPE_DECISION ||
         category === FAILURE_CATEGORIES.UNKNOWN;
}

module.exports = {
  FAILURE_CATEGORIES: FAILURE_CATEGORIES,
  classifyStepFailure: classifyStepFailure,
  classifyExecutionFailure: classifyExecutionFailure,
  findFirstUnrecoverableFailure: findFirstUnrecoverableFailure,
  isRecoverable: isRecoverable,
  isKnownCategory: isKnownCategory
};