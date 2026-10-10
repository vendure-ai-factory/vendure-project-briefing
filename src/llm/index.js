'use strict';

var configModule = require('../config');
var ledgerModule = require('./usageLedger');
var budgetModule = require('./budgetManager');
var circuitBreakerModule = require('../circuitBreaker');

var DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

/**
 * Create an LLM client with model lock, budget management, retries, and usage ledger.
 *
 * @param {Object} options
 * @param {Object} options.provider - Provider instance with complete({messages, taskId, purpose, model}) method
 * @param {Object} [options.logger] - Logger instance (optional)
 * @param {Function} [options.sleepFn] - Sleep function for retry delays (ms) (default: real setTimeout as Promise)
 * @param {Object} [options.budgetConfig] - Budget config override for testing: {totalUsd, warningThreshold}
 * @returns {Object} LLM client with complete() method and test hooks
 */
function createLLMClient(options) {
  options = options || {};
  var provider = options.provider;
  var logger = options.logger || null;
  var sleepFn = options.sleepFn || function defaultSleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  };

  var budget = budgetModule.createBudgetManager({ logger: logger });
  if (options.budgetConfig) {
    budget._injectConfig(options.budgetConfig);
  }

  var configuredModel = null;

  function getConfiguredModel() {
    if (configuredModel) return configuredModel;
    var cfg;
    try {
      cfg = configModule.getConfig();
    } catch (e) {
      cfg = {};
    }
    configuredModel = cfg.openrouterModel || DEFAULT_MODEL;
    return configuredModel;
  }

  /**
   * Retry with exponential backoff for dependency errors (429, 5xx, timeout).
   * Up to 3 retries with 2s, 4s, 8s delays.
   *
   * @param {Function} task - Async function to execute
   * @param {Object} [taskOptions]
   * @param {number} [taskOptions.maxRetries=3]
   * @param {number[]} [taskOptions.delays] - Delay sequence in ms
   * @param {string} [taskOptions.label] - Label for circuit hook reporting
   * @returns {Promise}
   */
  function retryWithBackoff(task, taskOptions) {
    taskOptions = taskOptions || {};
    var maxRetries = taskOptions.maxRetries !== undefined ? taskOptions.maxRetries : 3;
    var delays = taskOptions.delays || [2000, 4000, 8000];
    var label = taskOptions.label || 'llm';

    var attempt = 0;

    function attemptOnce() {
      return Promise.resolve().then(function() {
        return task();
      }).catch(function(err) {
        var isRetryable = false;
        if (err.status === 429) {
          isRetryable = true;
        } else if (err.status !== undefined && err.status >= 500) {
          isRetryable = true;
        } else if (err.message && (
          err.message.indexOf('timeout') !== -1 ||
          err.message.indexOf('Timeout') !== -1 ||
          err.message.indexOf('ECONNRESET') !== -1 ||
          err.message.indexOf('ENOTFOUND') !== -1 ||
          err.message.indexOf('fetch failed') !== -1
        )) {
          isRetryable = true;
        }

        if (isRetryable && attempt < maxRetries) {
          attempt++;
          var delay = delays[Math.min(attempt - 1, delays.length - 1)];
          if (logger && logger.debug) {
            logger.debug('LLM_RETRY', 'Retrying after ' + delay + 'ms (attempt ' + attempt + ' of ' + maxRetries + ')', {
              label: label,
              error: err.message,
              status: err.status,
              delayMs: delay
            });
          }
          return sleepFn(delay).then(attemptOnce);
        }
        throw err;
      });
    }

    return attemptOnce();
  }

  /**
   * Check if circuit is open for a given label.
   * Delegates to the global circuit breaker for the 'llm' dependency.
   */
  function isCircuitOpen(label) {
    var depLabel = label || 'openrouter';
    var breaker = circuitBreakerModule.getGlobalBreaker();
    return breaker.isCircuitOpen(depLabel);
  }

  /**
   * Check if budget is paused.
   */
  function isBudgetPaused() {
    return budget.isPaused();
  }

  /**
   * Main completion function with model lock, budget check, retries, and ledger.
   *
   * @param {Object} options
   * @param {Array<Object>} options.messages - Array of {role, content}
   * @param {string} options.taskId - Task ID for usage tracking
   * @param {string} options.purpose - Purpose (planning, repair, etc.)
   * @param {string} [options.model] - Model override (subject to model lock)
   * @param {string} [options.runId] - Run ID for ledger
   * @returns {Promise<Object>|Promise<Error>} LLMResult or BudgetPausedError/ModelMismatchError
   */
  function complete(options) {
    options = options || {};
    var messages = options.messages || [];
    var taskId = options.taskId || 'unknown';
    var purpose = options.purpose || 'unknown';
    var runId = options.runId || null;
    var model = options.model || getConfiguredModel();

    var allowedModel = getConfiguredModel();

    // MODEL LOCK STEP 1: reject wrong model on request side
    if (model !== allowedModel) {
      var lockErr = new Error('Model lock rejected: requested "' + model + '", only "' + allowedModel + '" is allowed');
      lockErr.name = 'ModelLockError';
      lockErr.requestedModel = model;
      lockErr.allowedModel = allowedModel;

      if (logger && logger.error) {
        logger.error('LLM_MODEL_LOCK', 'Request model rejected by lock', {
          requestedModel: model,
          allowedModel: allowedModel,
          taskId: taskId
        });
      }

      // Write failed call to ledger
      if (runId) {
        ledgerModule.writeLedgerEntry(runId, {
          timestamp: new Date().toISOString(),
          taskId: taskId,
          purpose: purpose,
          model: model,
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          requestId: null,
          cumulativeCostUsd: budget.getCumulativeCost(),
          error: 'MODEL_LOCK_REJECTED'
        });
      }

      return Promise.reject(lockErr);
    }

    // CIRCUIT BREAKER CHECK: refuse if circuit is open for openrouter
    var circuitStatus = isCircuitOpen('openrouter');
    if (circuitStatus.open) {
      if (logger && logger.warn) {
        logger.warn('LLM_CIRCUIT_OPEN', 'Circuit open for openrouter, refusing call', {
          taskId: taskId,
          openedAt: circuitStatus.openedAt,
          elapsedMs: circuitStatus.elapsedMs
        });
      }
      var circuitErr = new Error('Circuit open for dependency: openrouter');
      circuitErr.name = 'CircuitOpenError';
      circuitErr.safeStop = true;
      circuitErr.label = 'openrouter';
      return Promise.reject(circuitErr);
    }

    // BUDGET CHECK: refuse if paused
    var budgetCheck = budget.checkBudget();
    if (budgetCheck && budgetCheck.paused) {
      if (logger && logger.warn) {
        logger.warn('LLM_BUDGET_REFUSED', 'Budget paused, call refused', {
          cumulativeCostUsd: budgetCheck.cumulativeCostUsd,
          taskId: taskId
        });
      }
      if (runId) {
        ledgerModule.writeLedgerEntry(runId, {
          timestamp: new Date().toISOString(),
          taskId: taskId,
          purpose: purpose,
          model: model,
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          requestId: null,
          cumulativeCostUsd: budget.getCumulativeCost(),
          error: 'BUDGET_PAUSED'
        });
      }
      var bpe = new Error('LLM budget exhausted');
      bpe.name = 'BudgetPausedError';
      bpe.cumulativeCostUsd = budgetCheck.cumulativeCostUsd;
      return Promise.reject(bpe);
    }

    // Make the call with retry
    return retryWithBackoff(function() {
      return Promise.resolve(provider.complete({
        messages: messages,
        taskId: taskId,
        purpose: purpose,
        model: model,
        runId: runId
      }));
    }, { label: 'llm' }).then(function(response) {
      // MODEL LOCK STEP 2: reject wrong model on response side
      if (response.model !== allowedModel) {
        var mismatchErr = new Error('Model mismatch: requested "' + model + '", received "' + response.model + '"');
        mismatchErr.name = 'ModelMismatchError';
        mismatchErr.requestedModel = model;
        mismatchErr.receivedModel = response.model;

        if (logger && logger.error) {
          logger.error('LLM_MODEL_MISMATCH', 'Response model does not match lock', {
            requestedModel: model,
            receivedModel: response.model,
            taskId: taskId
          });
        }

        if (runId) {
          ledgerModule.writeLedgerEntry(runId, {
            timestamp: new Date().toISOString(),
            taskId: taskId,
            purpose: purpose,
            model: response.model,
            promptTokens: response.usage ? response.usage.promptTokens : null,
            completionTokens: response.usage ? response.usage.completionTokens : null,
            costUsd: response.costUsd || null,
            requestId: response.requestId || null,
            cumulativeCostUsd: budget.getCumulativeCost(),
            error: 'MODEL_MISMATCH_RESPONSE'
          });
        }

        throw mismatchErr;
      }

      // Record cost in budget
      if (response.costUsd) {
        budget.recordCost(response.costUsd, runId, taskId);
      }

      // Write to ledger
      if (runId) {
        ledgerModule.writeLedgerEntry(runId, {
          timestamp: new Date().toISOString(),
          taskId: taskId,
          purpose: purpose,
          model: response.model,
          promptTokens: response.usage ? response.usage.promptTokens : null,
          completionTokens: response.usage ? response.usage.completionTokens : null,
          costUsd: response.costUsd || null,
          requestId: response.requestId || null,
          generationId: response.generationId || null,
          cumulativeCostUsd: budget.getCumulativeCost()
        });
      }

      return {
        text: response.text,
        model: response.model,
        usage: response.usage,
        costUsd: response.costUsd,
        requestId: response.requestId
      };
    }).catch(function(err) {
      // Write failed call to ledger (non-retryable or exhausted retries)
      if (runId) {
        var isRetryableErr = err.status === 429 ||
          (err.status !== undefined && err.status >= 500) ||
          (err.message && (err.message.indexOf('timeout') !== -1 || err.message.indexOf('Timeout') !== -1));

        ledgerModule.writeLedgerEntry(runId, {
          timestamp: new Date().toISOString(),
          taskId: taskId,
          purpose: purpose,
          model: model,
          promptTokens: null,
          completionTokens: null,
          costUsd: null,
          requestId: null,
          cumulativeCostUsd: budget.getCumulativeCost(),
          error: isRetryableErr ? 'RETRY_EXHAUSTED:' + err.message : err.message
        });
      }
      throw err;
    });
  }

  return {
    complete: complete,
    getBudgetManager: function() { return budget; },
    getConfiguredModel: getConfiguredModel,
    isCircuitOpen: isCircuitOpen,
    isBudgetPaused: isBudgetPaused,
    retryWithBackoff: retryWithBackoff,
    _test: {
      budget: budget,
      getConfiguredModel: getConfiguredModel
    }
  };
}

module.exports = { createLLMClient: createLLMClient };