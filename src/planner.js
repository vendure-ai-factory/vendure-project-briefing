'use strict';

var crypto = require('crypto');
var taskCardModule = require('./taskCard');
var runModule = require('./run');

function generatePlanId() {
  var timestamp = Date.now().toString(36).toLowerCase();
  var randomPart = crypto.randomBytes(3).toString('hex');
  return 'plan-' + timestamp + '-' + randomPart;
}

function validatePlannerInput(taskCard, options) {
  var errors = [];

  if (!taskCard || typeof taskCard !== 'object') {
    return { valid: false, errors: ['Task card must be an object'] };
  }

  var taskValidation = taskCardModule.validateTaskCard(taskCard);
  if (!taskValidation.valid) {
    errors = errors.concat(taskValidation.errors);
  }

  if (!taskCard.goal || typeof taskCard.goal !== 'string') {
    errors.push('Task card must have a goal string');
  }

  if (!taskCard.description || typeof taskCard.description !== 'string') {
    errors.push('Task card must have a description string');
  }

  if (options) {
    if (options.runId !== undefined && options.runId !== null) {
      if (typeof options.runId !== 'string' || !runModule.isValidRunId(options.runId)) {
        errors.push('Invalid runId format');
      }
    }
    if (options.revisionId !== undefined && options.revisionId !== null) {
      if (typeof options.revisionId !== 'string' || !runModule.isValidRevisionId(options.revisionId)) {
        errors.push('Invalid revisionId format');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

function derivePreconditions(taskCard) {
  var preconditions = [];

  if (taskCard.environment && typeof taskCard.environment === 'object') {
    var keys = Object.keys(taskCard.environment);
    for (var i = 0; i < keys.length; i++) {
      preconditions.push({
        type: 'environment',
        key: keys[i],
        value: taskCard.environment[keys[i]],
        description: 'Environment variable "' + keys[i] + '" must be set to: ' + String(taskCard.environment[keys[i]])
      });
    }
  }

  if (taskCard.fixtures && Array.isArray(taskCard.fixtures) && taskCard.fixtures.length > 0) {
    preconditions.push({
      type: 'fixtures',
      items: taskCard.fixtures,
      description: 'Required fixture files must be available: ' + taskCard.fixtures.join(', ')
    });
  }

  return preconditions;
}

function deriveExecutionSteps(taskCard) {
  var steps = [];

  steps.push({
    stepId: 1,
    action: 'VALIDATE_ENVIRONMENT',
    description: 'Validate environment and workspace setup',
    order: 1
  });

  if (taskCard.fixtures && Array.isArray(taskCard.fixtures) && taskCard.fixtures.length > 0) {
    steps.push({
      stepId: 2,
      action: 'LOAD_FIXTURES',
      description: 'Load required fixture files',
      order: 2,
      fixtures: taskCard.fixtures
    });
    steps.push({
      stepId: 3,
      action: 'EXECUTE_TASK',
      description: 'Execute: ' + taskCard.goal,
      order: 3,
      goal: taskCard.goal
    });
  } else {
    steps.push({
      stepId: 2,
      action: 'EXECUTE_TASK',
      description: 'Execute: ' + taskCard.goal,
      order: 2,
      goal: taskCard.goal
    });
  }

  if (taskCard.acceptanceConditions && Array.isArray(taskCard.acceptanceConditions) && taskCard.acceptanceConditions.length > 0) {
    steps.push({
      stepId: steps[steps.length - 1].stepId + 1,
      action: 'VALIDATE_RESULTS',
      description: 'Validate results against acceptance conditions',
      order: steps[steps.length - 1].order + 1,
      conditions: taskCard.acceptanceConditions
    });
  }

  steps.push({
    stepId: steps[steps.length - 1].stepId + 1,
    action: 'COLLECT_EVIDENCE',
    description: 'Collect execution evidence',
    order: steps[steps.length - 1].order + 1
  });

  steps.push({
    stepId: steps[steps.length - 1].stepId + 1,
    action: 'CLEANUP',
    description: 'Cleanup workspace and temporary files',
    order: steps[steps.length - 1].order + 1
  });

  return steps;
}

function deriveValidationRequirements(taskCard) {
  var requirements = [];

  if (taskCard.acceptanceConditions && Array.isArray(taskCard.acceptanceConditions)) {
    for (var i = 0; i < taskCard.acceptanceConditions.length; i++) {
      requirements.push({
        type: 'acceptance_condition',
        condition: taskCard.acceptanceConditions[i],
        validatedBy: 'VALIDATE_RESULTS'
      });
    }
  }

  if (taskCard.expectedResults && Array.isArray(taskCard.expectedResults)) {
    for (var j = 0; j < taskCard.expectedResults.length; j++) {
      requirements.push({
        type: 'expected_result',
        result: taskCard.expectedResults[j],
        validatedBy: 'VALIDATE_RESULTS'
      });
    }
  }

  requirements.push({
    type: 'status_check',
    status: 'PASS_CANDIDATE',
    validatedBy: 'VALIDATE_RESULTS'
  });

  return requirements;
}

function deriveCleanupRequirements(taskCard) {
  var requirements = [];

  requirements.push({
    type: 'workspace_cleanup',
    description: 'Remove temporary workspace directory',
    always: true
  });

  if (taskCard.fixtures && Array.isArray(taskCard.fixtures) && taskCard.fixtures.length > 0) {
    requirements.push({
      type: 'fixture_cleanup',
      description: 'Release any loaded fixtures from memory',
      items: taskCard.fixtures
    });
  }

  requirements.push({
    type: 'log_archive',
    description: 'Archive structured logs to evidence location'
  });

  return requirements;
}

function createExecutionPlan(taskCard, options) {
  options = options || {};

  var validation = validatePlannerInput(taskCard, options);
  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors
    };
  }

  var runId = options.runId || runModule.generateRunId();
  var revisionId = options.revisionId || runModule.generateRevisionId();
  var planId = generatePlanId();

  var plan = {
    planId: planId,
    runId: runId,
    revisionId: revisionId,
    taskId: taskCard.taskId,
    batchId: taskCard.batchId,
    title: taskCard.title,
    goal: taskCard.goal,
    description: taskCard.description,
    preconditions: derivePreconditions(taskCard),
    executionSteps: deriveExecutionSteps(taskCard),
    expectedResults: taskCard.expectedResults || [],
    validationRequirements: deriveValidationRequirements(taskCard),
    cleanupRequirements: deriveCleanupRequirements(taskCard),
    createdAt: new Date().toISOString(),
    plannerVersion: '1.0.0-milestone2a',
    status: 'PLANNED'
  };

  return {
    valid: true,
    plan: plan
  };
}

function serializePlan(plan) {
  return JSON.stringify(plan, null, 2);
}

function deserializePlan(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return null;
  }
}

function isValidPlanId(planId) {
  if (typeof planId !== 'string') {
    return false;
  }
  return /^plan-[a-z0-9]+-[a-z0-9]+$/.test(planId);
}

function validatePlan(plan) {
  var errors = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan must be an object'] };
  }

  if (!isValidPlanId(plan.planId)) {
    errors.push('Invalid or missing planId');
  }

  if (!runModule.isValidRunId(plan.runId)) {
    errors.push('Invalid or missing runId');
  }

  if (!runModule.isValidRevisionId(plan.revisionId)) {
    errors.push('Invalid or missing revisionId');
  }

  if (!plan.executionSteps || !Array.isArray(plan.executionSteps)) {
    errors.push('Execution steps must be an array');
  } else {
    for (var i = 0; i < plan.executionSteps.length; i++) {
      var step = plan.executionSteps[i];
      if (typeof step.order !== 'number') {
        errors.push('Each execution step must have a numeric order');
        break;
      }
    }
    for (var j = 0; j < plan.executionSteps.length - 1; j++) {
      if (plan.executionSteps[j].order >= plan.executionSteps[j + 1].order) {
        errors.push('Execution steps must be in ascending order');
        break;
      }
    }
  }

  if (!plan.preconditions || !Array.isArray(plan.preconditions)) {
    errors.push('Preconditions must be an array');
  }

  if (!plan.validationRequirements || !Array.isArray(plan.validationRequirements)) {
    errors.push('Validation requirements must be an array');
  }

  if (!plan.cleanupRequirements || !Array.isArray(plan.cleanupRequirements)) {
    errors.push('Cleanup requirements must be an array');
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

module.exports = {
  createExecutionPlan: createExecutionPlan,
  validatePlannerInput: validatePlannerInput,
  validatePlan: validatePlan,
  serializePlan: serializePlan,
  deserializePlan: deserializePlan,
  isValidPlanId: isValidPlanId,
  generatePlanId: generatePlanId
};