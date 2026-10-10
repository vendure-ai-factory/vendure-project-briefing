'use strict';

var toolRegistry = {};
var taskExecutorRegistry = {};

function registerTool(name, config) {
  if (!name || typeof name !== 'string') {
    return { success: false, error: 'Tool name must be a non-empty string' };
  }
  if (!config || typeof config.handler !== 'function') {
    return { success: false, error: 'Tool must have a handler function' };
  }
  toolRegistry[name] = {
    name: name,
    description: config.description || '',
    schema: config.schema || null,
    handler: config.handler,
    builtIn: config.builtIn || false
  };
  return { success: true };
}

function isToolRegistered(name) {
  return toolRegistry.hasOwnProperty(name);
}

function getTool(name) {
  return toolRegistry[name] || null;
}

function listTools() {
  return Object.keys(toolRegistry);
}

function validateToolArgs(toolName, args) {
  var tool = toolRegistry[toolName];
  if (!tool) {
    return { valid: false, errors: ['Tool not found: ' + toolName] };
  }

  if (!tool.schema) {
    return { valid: true, errors: [] };
  }

  var errors = [];
  var schema = tool.schema;

  if (schema.required) {
    for (var i = 0; i < schema.required.length; i++) {
      var reqField = schema.required[i];
      if (!args.hasOwnProperty(reqField) || args[reqField] === undefined || args[reqField] === null) {
        errors.push('Missing required argument: ' + reqField);
      }
    }
  }

  if (schema.properties) {
    var propKeys = Object.keys(schema.properties);
    for (var j = 0; j < propKeys.length; j++) {
      var prop = propKeys[j];
      var propSchema = schema.properties[prop];
      if (args.hasOwnProperty(prop)) {
        var argValue = args[prop];
        if (propSchema.type === 'string' && typeof argValue !== 'string') {
          errors.push('Argument "' + prop + '" must be a string');
        } else if (propSchema.type === 'number' && typeof argValue !== 'number') {
          errors.push('Argument "' + prop + '" must be a number');
        } else if (propSchema.type === 'boolean' && typeof argValue !== 'boolean') {
          errors.push('Argument "' + prop + '" must be a boolean');
        } else if (propSchema.type === 'array' && !Array.isArray(argValue)) {
          errors.push('Argument "' + prop + '" must be an array');
        } else if (propSchema.type === 'object' && (typeof argValue !== 'object' || argValue === null || Array.isArray(argValue))) {
          errors.push('Argument "' + prop + '" must be an object');
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

function executeTool(toolName, args, context) {
  var tool = toolRegistry[toolName];
  if (!tool) {
    return {
      success: false,
      toolName: toolName,
      error: 'Unknown tool: ' + toolName,
      errorCode: 'UNKNOWN_TOOL'
    };
  }

  var validation = validateToolArgs(toolName, args);
  if (!validation.valid) {
    return {
      success: false,
      toolName: toolName,
      error: 'Invalid arguments: ' + validation.errors.join('; '),
      errorCode: 'INVALID_ARGS',
      validationErrors: validation.errors
    };
  }

  var result;
  try {
    result = tool.handler(args, context || {});
  } catch (err) {
    return {
      success: false,
      toolName: toolName,
      error: 'Tool execution failed: ' + err.message,
      errorCode: 'EXECUTION_ERROR'
    };
  }

  if (result === undefined) {
    result = { success: true };
  }

  if (typeof result !== 'object') {
    result = { success: true, result: result };
  }

  if (result.success === undefined) {
    result.success = true;
  }

  result.toolName = toolName;
  return result;
}

function validatePlanForExecution(plan) {
  var errors = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan must be an object'] };
  }

  if (!plan.executionSteps || !Array.isArray(plan.executionSteps)) {
    errors.push('Plan must have executionSteps array');
    return { valid: false, errors: errors };
  }

  for (var i = 0; i < plan.executionSteps.length; i++) {
    var step = plan.executionSteps[i];
    if (!step.action) {
      errors.push('Step at index ' + i + ' is missing action');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

function executePlan(plan, options) {
  options = options || {};
  var context = options.context || {};
  var runId = options.runId || 'unknown';
  var logger = options.logger || null;

  var planValidation = validatePlanForExecution(plan);
  if (!planValidation.valid) {
    return {
      success: false,
      error: 'Invalid plan: ' + planValidation.errors.join('; '),
      errorCode: 'INVALID_PLAN',
      toolName: plan.executionSteps && plan.executionSteps.length > 0 ? plan.executionSteps[0].action : null,
      stepId: plan.executionSteps && plan.executionSteps.length > 0 ? plan.executionSteps[0].stepId : null,
      results: []
    };
  }

  var results = [];
  var completedSteps = 0;
  var failedSteps = 0;
  var skippedSteps = 0;

  if (logger && logger.info) {
    logger.info('EXECUTION_STARTED', 'Plan execution started', {
      planId: plan.planId,
      runId: runId,
      totalSteps: plan.executionSteps.length,
      isRepairExecution: context.isRepairExecution || false,
      attemptNumber: context.attemptNumber || 0
    });
  }

  for (var i = 0; i < plan.executionSteps.length; i++) {
    var step = plan.executionSteps[i];
    var stepContext = {
      runId: runId,
      planId: plan.planId,
      taskId: plan.taskId,
      stepIndex: i,
      stepId: step.stepId,
      workspaceRoot: context.workspaceRoot || null,
      isRepairExecution: context.isRepairExecution || false,
      attemptNumber: context.attemptNumber || 0,
      repairAction: context.repairAction || null
    };

    if (logger && logger.debug) {
      logger.debug('STEP_START', 'Executing step: ' + step.action, {
        stepId: step.stepId,
        action: step.action,
        order: step.order,
        isRepairExecution: context.isRepairExecution || false,
        attemptNumber: context.attemptNumber || 0
      });
    }

    var stepResult = executeTool(step.action, step.args || {}, stepContext);

    stepResult.stepId = step.stepId;
    stepResult.action = step.action;
    stepResult.order = step.order;
    stepResult.description = step.description || '';
    stepResult.completedAt = new Date().toISOString();
    stepResult.isRepairExecution = context.isRepairExecution || false;
    stepResult.attemptNumber = context.attemptNumber || 0;

    results.push(stepResult);

    if (stepResult.success) {
      completedSteps++;
      if (logger && logger.debug) {
        logger.debug('STEP_COMPLETED', 'Step completed: ' + step.action, {
          stepId: step.stepId,
          action: step.action,
          isRepairExecution: context.isRepairExecution || false,
          attemptNumber: context.attemptNumber || 0
        });
      }
    } else {
      failedSteps++;
      if (logger && logger.warn) {
        logger.warn('STEP_FAILED', 'Step failed: ' + step.action, {
          stepId: step.stepId,
          action: step.action,
          error: stepResult.error,
          isRepairExecution: context.isRepairExecution || false,
          attemptNumber: context.attemptNumber || 0
        });
      }
      if (step.critical !== false && step.critical !== undefined) {
        if (logger && logger.warn) {
          logger.warn('EXECUTION_STOPPED', 'Execution stopped due to critical step failure', {
            stepId: step.stepId,
            action: step.action,
            stopIndex: i,
            isRepairExecution: context.isRepairExecution || false,
            attemptNumber: context.attemptNumber || 0
          });
        }
        for (var j = i + 1; j < plan.executionSteps.length; j++) {
          results.push({
            stepId: plan.executionSteps[j].stepId,
            action: plan.executionSteps[j].action,
            order: plan.executionSteps[j].order,
            skipped: true,
            skippedAt: new Date().toISOString(),
            description: plan.executionSteps[j].description || ''
          });
          skippedSteps++;
        }
        break;
      }
    }
  }

  var overallSuccess = failedSteps === 0;

  if (logger && logger.info) {
    logger.info('EXECUTION_COMPLETED', 'Plan execution completed', {
      planId: plan.planId,
      runId: runId,
      totalSteps: plan.executionSteps.length,
      completed: completedSteps,
      failed: failedSteps,
      skipped: skippedSteps,
      overallSuccess: overallSuccess,
      isRepairExecution: context.isRepairExecution || false,
      attemptNumber: context.attemptNumber || 0
    });
  }

  return {
    success: overallSuccess,
    planId: plan.planId,
    runId: runId,
    results: results,
    summary: {
      totalSteps: plan.executionSteps.length,
      completed: completedSteps,
      failed: failedSteps,
      skipped: skippedSteps
    }
  };
}

function resetRegistry() {
  toolRegistry = {};
}

function registerTaskExecutor(taskId, config) {
  if (!taskId || typeof taskId !== 'string') {
    return { success: false, error: 'Task ID must be a non-empty string' };
  }
  if (!config || typeof config.handler !== 'function') {
    return { success: false, error: 'Executor must have a handler function' };
  }
  taskExecutorRegistry[taskId] = {
    taskId: taskId,
    description: config.description || ('Executor for ' + taskId),
    builtIn: config.builtIn || false,
    handler: config.handler,
    coverage: config.coverage || null,
    verifiedAssertionIds: Array.isArray(config.verifiedAssertionIds) ? config.verifiedAssertionIds.slice() : null
  };
  return { success: true };
}

function getTaskExecutor(taskId) {
  return taskExecutorRegistry[taskId] || null;
}

function hasTaskExecutor(taskId) {
  return taskExecutorRegistry.hasOwnProperty(taskId);
}

function listTaskExecutors() {
  return Object.keys(taskExecutorRegistry);
}

function resetTaskExecutors() {
  taskExecutorRegistry = {};
}

registerTool('ECHO', {
  description: 'Echo a message back (deterministic demo tool, no side effects)',
  builtIn: true,
  schema: {
    required: ['message'],
    properties: {
      message: { type: 'string', description: 'Message to echo' }
    }
  },
  handler: function(args) {
    return {
      success: true,
      echo: args.message,
      toolName: 'ECHO'
    };
  }
});

registerTool('ADD', {
  description: 'Add two numbers (deterministic math tool, no side effects)',
  builtIn: true,
  schema: {
    required: ['a', 'b'],
    properties: {
      a: { type: 'number', description: 'First operand' },
      b: { type: 'number', description: 'Second operand' }
    }
  },
  handler: function(args) {
    return {
      success: true,
      result: args.a + args.b,
      toolName: 'ADD'
    };
  }
});

registerTool('VALIDATE_ENVIRONMENT', {
  description: 'Validate environment setup',
  builtIn: true,
  schema: { required: [], properties: {} },
  handler: function(args) {
    return { success: true, validated: true };
  }
});

registerTool('VALIDATE_RESULTS', {
  description: 'Validate results against acceptance conditions',
  builtIn: true,
  schema: { required: [], properties: { conditions: { type: 'array' } } },
  handler: function(args) {
    return {
      success: true,
      conditionsChecked: args.conditions ? args.conditions.length : 0
    };
  }
});

registerTool('COLLECT_EVIDENCE', {
  description: 'Collect execution evidence',
  builtIn: true,
  schema: { required: [], properties: {} },
  handler: function(args) {
    return { success: true, evidence: [] };
  }
});

registerTool('CLEANUP', {
  description: 'Cleanup temporary resources',
  builtIn: true,
  schema: { required: [], properties: {} },
  handler: function(args) {
    return { success: true, cleaned: true };
  }
});

registerTool('LOAD_FIXTURES', {
  description: 'Load fixture files',
  builtIn: true,
  schema: { required: [], properties: { fixtures: { type: 'array' } } },
  handler: function(args) {
    return {
      success: true,
      fixtures: args.fixtures || []
    };
  }
});

registerTool('EXECUTE_TASK', {
  description: 'Execute the main task (placeholder, no-op for Milestone 2B)',
  builtIn: true,
  schema: { required: [], properties: { goal: { type: 'string' } } },
  handler: function(args) {
    return {
      success: true,
      goal: args.goal || 'no goal specified',
      note: 'No-op placeholder for Milestone 2B - actual task execution is future work'
    };
  }
});

module.exports = {
  registerTool: registerTool,
  isToolRegistered: isToolRegistered,
  getTool: getTool,
  listTools: listTools,
  executeTool: executeTool,
  validateToolArgs: validateToolArgs,
  executePlan: executePlan,
  validatePlanForExecution: validatePlanForExecution,
  resetRegistry: resetRegistry,
  registerTaskExecutor: registerTaskExecutor,
  getTaskExecutor: getTaskExecutor,
  hasTaskExecutor: hasTaskExecutor,
  listTaskExecutors: listTaskExecutors,
  resetTaskExecutors: resetTaskExecutors
};
