'use strict';

var executorModule = require('./executor');
var failureClassifier = require('./failureClassifier');
var terminalStateModule = require('./terminalState');

var DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
var DEFAULT_MAX_GLOBAL_REPAIR_ATTEMPTS = 15;
// NOTE: Only the decision module (chunk 9) may emit the final verdict.
// All other modules emit 'PASS_CANDIDATE' for successful candidates.
var STATUS_BLOCK = 'BLOCK';
var STATUS_PASS = 'PASS_CANDIDATE';

function generateFailureSignature(failureClassification, plan) {
  var evidence = null;

  if (failureClassification) {
    if (failureClassification.relevantEvidence) {
      evidence = failureClassification.relevantEvidence;
    } else if (failureClassification.allClassifications && failureClassification.allClassifications.length > 0) {
      evidence = failureClassification.allClassifications[0].relevantEvidence || null;
    }
  }

  if (!evidence) {
    return 'UNKNOWN_SIGNATURE';
  }

  var errorCode = evidence.errorCode || 'UNKNOWN_CODE';
  var toolName = evidence.action || evidence.toolName || 'UNKNOWN_TOOL';
  var stepId = evidence.stepId || 'UNKNOWN_STEP';

  return errorCode + '|' + toolName + '|' + stepId;
}

function createRepairContext(failureClassification, attemptNumber, maxAttempts) {
  var evidence = null;
  if (failureClassification) {
    if (failureClassification.allClassifications && failureClassification.allClassifications.length > 0) {
      evidence = failureClassification.allClassifications[0].relevantEvidence || null;
    } else if (failureClassification.firstUnrecoverableFailure) {
      evidence = failureClassification.firstUnrecoverableFailure.relevantEvidence || null;
    } else if (failureClassification.relevantEvidence) {
      evidence = failureClassification.relevantEvidence;
    }
  }

  return {
    failureClassification: failureClassification,
    attemptNumber: attemptNumber,
    maxAttempts: maxAttempts,
    failureSignature: generateFailureSignature(failureClassification, null),
    originalEvidence: evidence || {}
  };
}

function executeWithRepair(plan, options) {
  options = options || {};
  var logger = options.logger || null;
  var maxRepairAttempts = options.maxRepairAttempts || DEFAULT_MAX_REPAIR_ATTEMPTS;
  var maxGlobalRepairAttempts = options.maxGlobalRepairAttempts || (DEFAULT_MAX_REPAIR_ATTEMPTS * 5);
  var repairHandler = options.repairHandler || null;
  var context = options.context || {};

  var repairBudgets = {};
  var allAttempts = [];
  var totalRepairAttempts = 0;

  var initialResult = executorModule.executePlan(plan, {
    runId: context.runId,
    logger: logger,
    isRepairExecution: false,
    attemptNumber: 0,
    context: context
  });

  initialResult.attemptNumber = 0;
  initialResult.isRepairExecution = false;
  initialResult.timestamp = new Date().toISOString();

  allAttempts.push({
    attemptNumber: 0,
    isRepairExecution: false,
    result: initialResult,
    repairAction: null,
    repairResult: null,
    failureClassification: null
  });

  if (initialResult.success) {
    if (logger && logger.info) {
      logger.info('EXECUTION_PASS', 'Initial execution succeeded', {
        planId: plan.planId,
        runId: context.runId,
        attemptNumber: 0
      });
    }
    return {
      status: STATUS_PASS,
      success: true,
      planId: plan.planId,
      runId: context.runId,
      totalAttempts: 1,
      allAttempts: allAttempts,
      safeStop: false,
      terminalState: terminalStateModule.TERMINAL_STATES.PASS_CANDIDATE
    };
  }

  var failureClassification = failureClassifier.classifyExecutionFailure(initialResult);
  if (!failureClassification) {
    failureClassification = {
      firstUnrecoverableFailure: null,
      overallSuccess: false,
      allClassifications: []
    };
  }

  if (logger && logger.warn) {
    logger.warn('EXECUTION_FAILED', 'Initial execution failed, checking recoverability', {
      planId: plan.planId,
      runId: context.runId,
      attemptNumber: 0,
      failureCount: initialResult.summary ? initialResult.summary.failed : 0
    });
  }

  var allClassifications = failureClassification.allClassifications || [];
  var hasUnrecoverableWithResults = allClassifications.some(function(c) { return c.potentiallyRecoverable === false; });
  var hasResults = initialResult.results && initialResult.results.some(function(r) { return !r.skipped && r.success === false; });

  var hasBlockImmediately = initialResult.results && initialResult.results.some(function(r) {
    return !r.skipped && r.success === false && r.errorCode === 'UNKNOWN_TOOL';
  });

  if ((hasUnrecoverableWithResults && !hasResults) || hasBlockImmediately) {
    if (logger && logger.warn) {
      logger.warn('EXECUTION_BLOCKED', 'Unrecoverable failure, not attempting repairs', {
        planId: plan.planId,
        runId: context.runId,
        hasBlockImmediately: hasBlockImmediately
      });
    }
    return buildBlockResult(plan, context, logger, allAttempts, failureClassification, 'Unrecoverable failure');
  }

  var currentPlan = plan;
  var currentContext = context;
  var currentFailureClassification = failureClassification;
  var attemptsExhausted = false;

  while (!attemptsExhausted) {
    var sig = generateFailureSignature(currentFailureClassification, currentPlan);
    if (!repairBudgets[sig]) {
      repairBudgets[sig] = 0;
    }

    var perSigAttempt = repairBudgets[sig];

    if (logger && logger.info) {
      logger.info('REPAIR_ATTEMPT_START', 'Starting repair attempt', {
        planId: plan.planId,
        runId: context.runId,
        attemptNumber: perSigAttempt + 1,
        failureSignature: sig,
        maxAttempts: maxRepairAttempts
      });
    }

    if (perSigAttempt >= maxRepairAttempts) {
      if (logger && logger.warn) {
        logger.warn('REPAIR_EXHAUSTED', 'Repair budget exhausted for signature: ' + sig, {
          planId: plan.planId,
          runId: context.runId,
          failureSignature: sig,
          maxAttempts: maxRepairAttempts
        });
      }
      attemptsExhausted = true;
      break;
    }

    if (totalRepairAttempts >= maxGlobalRepairAttempts) {
      if (logger && logger.warn) {
        logger.warn('REPAIR_GLOBAL_CAP_REACHED', 'Global repair-attempt cap reached, blocking execution', {
          planId: plan.planId,
          runId: context.runId,
          totalRepairAttempts: totalRepairAttempts,
          maxGlobalRepairAttempts: maxGlobalRepairAttempts,
          failureSignature: sig
        });
      }
      attemptsExhausted = true;
      break;
    }

    if (!repairHandler) {
      if (logger && logger.warn) {
        logger.warn('NO_REPAIR_HANDLER', 'No repair handler provided, exhausting repair budget', {
          planId: plan.planId,
          runId: context.runId,
          attemptNumber: perSigAttempt + 1,
          maxAttempts: maxRepairAttempts
        });
      }
      attemptsExhausted = true;
      break;
    }

    var repairContext = createRepairContext(currentFailureClassification, perSigAttempt + 1, maxRepairAttempts);
    repairContext.failureSignature = sig;
    var repairResult = repairHandler(currentPlan, repairContext);

    if (!repairResult) {
      if (logger && logger.warn) {
        logger.warn('REPAIR_HANDLER_RETURNED_NULL', 'Repair handler returned null, exhausting repair budget', {
          planId: plan.planId,
          runId: context.runId,
          attemptNumber: perSigAttempt + 1
        });
      }
      attemptsExhausted = true;
      break;
    }

    var repairAction = repairResult.repairAction || 'MODIFY_ARGS';
    var modifiedStepId = repairResult.stepId || null;
    var modifiedArgs = repairResult.modifiedArgs || null;

    if (repairResult.skipRepairs) {
      if (logger && logger.info) {
        logger.info('REPAIRS_SKIPPED', 'Repair handler indicated to skip repairs', {
          planId: plan.planId,
          runId: context.runId,
          attemptNumber: perSigAttempt + 1,
          reason: repairResult.reason || 'Handler decision'
        });
      }
      attemptsExhausted = true;
      break;
    }

    var repairExecutionContext = {
      runId: context.runId,
      isRepairExecution: true,
      attemptNumber: perSigAttempt + 1,
      repairAction: repairAction,
      repairAttempt: perSigAttempt + 1
    };

    var repairExecResult;
    if (modifiedStepId && modifiedArgs !== null) {
      var stepIndex = -1;
      for (var si = 0; si < currentPlan.executionSteps.length; si++) {
        if (currentPlan.executionSteps[si].stepId === modifiedStepId) {
          stepIndex = si;
          break;
        }
      }

      if (stepIndex >= 0) {
        var modifiedSteps = JSON.parse(JSON.stringify(currentPlan.executionSteps));
        modifiedSteps[stepIndex] = JSON.parse(JSON.stringify(modifiedSteps[stepIndex]));
        modifiedSteps[stepIndex].args = modifiedArgs;

        var modifiedPlan = JSON.parse(JSON.stringify(currentPlan));
        modifiedPlan.executionSteps = modifiedSteps;

        repairExecResult = executorModule.executePlan(modifiedPlan, {
          runId: context.runId,
          logger: logger,
          context: repairExecutionContext
        });
      } else {
        repairExecResult = {
          success: false,
          results: [],
          summary: { totalSteps: 0, completed: 0, failed: 0, skipped: 0 },
          error: 'Step not found: ' + modifiedStepId,
          errorCode: 'STEP_NOT_FOUND'
        };
      }
    } else if (repairResult.modifiedPlan) {
      repairExecResult = executorModule.executePlan(repairResult.modifiedPlan, {
        runId: context.runId,
        logger: logger,
        context: repairExecutionContext
      });
    } else {
      repairExecResult = executorModule.executePlan(currentPlan, {
        runId: context.runId,
        logger: logger,
        context: repairExecutionContext
      });
    }

    repairExecResult.attemptNumber = perSigAttempt + 1;
    repairExecResult.isRepairExecution = true;
    repairExecResult.timestamp = new Date().toISOString();

    var repairExecClassification = failureClassifier.classifyExecutionFailure(repairExecResult);
    if (!repairExecClassification) {
      repairExecClassification = {
        firstUnrecoverableFailure: null,
        overallSuccess: false,
        allClassifications: []
      };
    }

    allAttempts.push({
      attemptNumber: perSigAttempt + 1,
      isRepairExecution: true,
      result: repairExecResult,
      repairAction: repairAction,
      repairResult: repairResult,
      failureClassification: repairExecClassification,
      failureSignature: sig
    });

    if (repairExecResult.success) {
      if (logger && logger.info) {
        logger.info('REPAIR_SUCCESS', 'Repair attempt succeeded', {
          planId: plan.planId,
          runId: context.runId,
          attemptNumber: perSigAttempt + 1,
          repairAction: repairAction
        });
      }
      return {
        status: STATUS_PASS,
        success: true,
        planId: plan.planId,
        runId: context.runId,
        totalAttempts: allAttempts.length,
        allAttempts: allAttempts,
        safeStop: false,
        terminalState: terminalStateModule.TERMINAL_STATES.PASS_CANDIDATE
      };
    }

    if (logger && logger.warn) {
      logger.warn('REPAIR_FAILED', 'Repair attempt failed', {
        planId: plan.planId,
        runId: context.runId,
        attemptNumber: perSigAttempt + 1,
        repairAction: repairAction,
        failureCount: repairExecResult.summary ? repairExecResult.summary.failed : 0
      });
    }

    currentFailureClassification = repairExecClassification;
    currentContext = repairExecutionContext;

    repairBudgets[sig] = perSigAttempt + 1;
    totalRepairAttempts++;
  }

  if (attemptsExhausted) {
    if (logger && logger.error) {
      logger.error('REPAIR_EXHAUSTED', 'All repair attempts exhausted, blocking execution', {
        planId: plan.planId,
        runId: context.runId,
        totalAttempts: allAttempts.length,
        totalRepairAttempts: totalRepairAttempts,
        maxGlobalRepairAttempts: maxGlobalRepairAttempts
      });
    }
    var reason = 'Repair budget exhausted after ' + totalRepairAttempts + ' total repair attempts';
    return buildBlockResult(plan, context, logger, allAttempts, currentFailureClassification, reason);
  }

  if (logger && logger.error) {
    logger.error('REPAIR_UNKNOWN_STATE', 'Repair loop exited unexpectedly', {
      planId: plan.planId,
      runId: context.runId
    });
  }
  return buildBlockResult(plan, context, logger, allAttempts, currentFailureClassification, 'Unexpected repair loop termination');
}

function buildBlockResult(plan, context, logger, allAttempts, failureClassification, reason) {
  var originalFailure = null;
  if (allAttempts.length > 0 && allAttempts[0].result) {
    var initialResults = allAttempts[0].result.results || [];
    for (var i = 0; i < initialResults.length; i++) {
      if (!initialResults[i].skipped && initialResults[i].success === false) {
        originalFailure = failureClassifier.classifyStepFailure(initialResults[i]);
        break;
      }
    }
  }

  var blockedAt = new Date().toISOString();

  if (logger && logger.error) {
    logger.error('EXECUTION_BLOCKED', 'Execution blocked after repair exhaustion', {
      planId: plan.planId,
      runId: context.runId,
      totalAttempts: allAttempts.length,
      reason: reason,
      originalFailureEvidence: originalFailure ? originalFailure.relevantEvidence : null,
      blockedAt: blockedAt
    });
  }

  // Determine terminal state from failure classification
  var terminalState = terminalStateModule.TERMINAL_STATES.BLOCK;
  if (originalFailure && originalFailure.failureCategory) {
    var mapped = terminalStateModule.failureClassToTerminalState(
      originalFailure.failureCategory,
      true // repairs exhausted
    );
    if (mapped) {
      terminalState = mapped;
    }
  }

  return {
    status: STATUS_BLOCK,
    success: false,
    planId: plan.planId,
    runId: context.runId,
    totalAttempts: allAttempts.length,
    allAttempts: allAttempts,
    blockedReason: reason,
    blockedAt: blockedAt,
    originalFailureEvidence: originalFailure ? originalFailure.relevantEvidence : null,
    failureClassification: failureClassification,
    safeStop: true,
    terminalState: terminalState,
    rule: originalFailure && originalFailure.rule ? originalFailure.rule : null
  };
}

function getDefaultMaxRepairAttempts() {
  return DEFAULT_MAX_REPAIR_ATTEMPTS;
}

function setDefaultMaxRepairAttempts(max) {
  if (typeof max === 'number' && max >= 0) {
    DEFAULT_MAX_REPAIR_ATTEMPTS = max;
  }
}

function resetDefaultMaxRepairAttempts() {
  DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
}

module.exports = {
  executeWithRepair: executeWithRepair,
  generateFailureSignature: generateFailureSignature,
  createRepairContext: createRepairContext,
  getDefaultMaxRepairAttempts: getDefaultMaxRepairAttempts,
  setDefaultMaxRepairAttempts: setDefaultMaxRepairAttempts,
  resetDefaultMaxRepairAttempts: resetDefaultMaxRepairAttempts,
  STATUS_BLOCK: STATUS_BLOCK,
  STATUS_PASS: STATUS_PASS,
  DEFAULT_MAX_REPAIR_ATTEMPTS: DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_MAX_GLOBAL_REPAIR_ATTEMPTS: DEFAULT_MAX_GLOBAL_REPAIR_ATTEMPTS,
  TERMINAL_STATES: terminalStateModule.TERMINAL_STATES,
  FAILURE_CLASSES: terminalStateModule.FAILURE_CLASSES
};
