'use strict';

var configModule = require('../config');

/**
 * Budget Manager for LLM costs.
 *
 * Configurable via environment variables:
 *   LLM_BUDGET_TOTAL_USD - Total budget in USD (default: 20.00)
 *   LLM_BUDGET_WARNING_THRESHOLD - Warning threshold as fraction (default: 0.80)
 *
 * Hard pause at 100% of budget.
 */

function createBudgetManager(options) {
  options = options || {};
  var getConfig = options.getConfig ||
    function() { return configModule.getConfig(); };
  var logger = options.logger || null;

  var cumulativeCost = 0;
  var warningEmitted = false;
  var paused = false;

  // Allow test injection
  var _config = null;
  function getBudgetConfig() {
    if (_config) return _config;
    var cfg = getConfig();
    _config = {
      totalUsd: parseFloat(process.env.LLM_BUDGET_TOTAL_USD) || 20.00,
      warningThreshold: parseFloat(process.env.LLM_BUDGET_WARNING_THRESHOLD) || 0.80
    };
    return _config;
  }

  return {
    /**
     * Check if the budget allows another call.
     * Returns null if OK, or a BudgetPausedError if paused.
     */
    checkBudget: function() {
      if (paused) {
        return { paused: true, cumulativeCostUsd: cumulativeCost };
      }
      var cfg = getBudgetConfig();
      var hardLimit = cfg.totalUsd;
      if (cumulativeCost >= hardLimit) {
        paused = true;
        return { paused: true, cumulativeCostUsd: cumulativeCost };
      }
      return null;
    },

    /**
     * Record a successful call's cost. Updates cumulative and checks warning.
     * @param {number} costUsd
     * @param {string} runId
     * @param {string} taskId
     */
    recordCost: function(costUsd, runId, taskId) {
      cumulativeCost += costUsd;
      var cfg = getBudgetConfig();

      // Check warning threshold (emit once)
      if (!warningEmitted && cumulativeCost >= cfg.totalUsd * cfg.warningThreshold) {
        warningEmitted = true;
        if (logger && logger.warn) {
          logger.warn('LLM_BUDGET_WARNING', 'LLM budget warning threshold reached', {
            cumulativeCostUsd: cumulativeCost,
            threshold: cfg.warningThreshold,
            totalUsd: cfg.totalUsd,
            runId: runId,
            taskId: taskId
          });
        }
      }

      // Check hard pause
      if (cumulativeCost >= cfg.totalUsd) {
        paused = true;
        if (logger && logger.warn) {
          logger.warn('LLM_BUDGET_PAUSED', 'LLM budget hard limit reached, calls refused', {
            cumulativeCostUsd: cumulativeCost,
            totalUsd: cfg.totalUsd,
            runId: runId,
            taskId: taskId
          });
        }
      }
    },

    /**
     * Get current cumulative cost.
     */
    getCumulativeCost: function() {
      return cumulativeCost;
    },

    /**
     * Get budget configuration.
     */
    getConfig: function() {
      return getBudgetConfig();
    },

    /**
     * Is the budget paused?
     */
    isPaused: function() {
      return paused;
    },

    /**
     * Reset state (for testing).
     */
    _reset: function() {
      cumulativeCost = 0;
      warningEmitted = false;
      paused = false;
      _config = null;
    },

    /**
     * Inject config (for testing).
     */
    _injectConfig: function(cfg) {
      _config = cfg;
    }
  };
}

module.exports = { createBudgetManager: createBudgetManager };