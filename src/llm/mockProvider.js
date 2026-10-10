'use strict';

var crypto = require('crypto');

/**
 * Mock LLM Provider for testing.
 *
 * Supports scripted responses and configurable behavior:
 * - Success with configurable token counts and cost
 * - HTTP 429 (rate limit)
 * - HTTP 5xx (server error)
 * - Timeout
 * - Model mismatch (response model differs from requested)
 *
 * @param {Object} config
 * @param {string} [config.defaultText='Mock response'] - Default response text
 * @param {number} [config.defaultPromptTokens=100] - Default prompt token count
 * @param {number} [config.defaultCompletionTokens=50] - Default completion token count
 * @param {number} [config.defaultCostUsd=0.001] - Default cost per call in USD
 * @param {string} [config.defaultModel='z-ai/glm-5.3-flash'] - Default model
 */
function createMockProvider(config) {
  config = config || {};
  var defaultText = config.defaultText !== undefined ? config.defaultText : 'Mock response';
  var defaultPromptTokens = config.defaultPromptTokens !== undefined ? config.defaultPromptTokens : 100;
  var defaultCompletionTokens = config.defaultCompletionTokens !== undefined ? config.defaultCompletionTokens : 50;
  var defaultCostUsd = config.defaultCostUsd !== undefined ? config.defaultCostUsd : 0.001;
  var defaultModel = config.defaultModel || 'z-ai/glm-5.3-flash';
  var customGenerate = config.generate || null;

  // Per-call overrides (set by test via setNextResponse)
  var nextResponse = null;

  // Track last request headers for test assertion
  var lastRequestHeaders = null;

  var provider = {
    /**
     * Configure the next response. After this call, the next complete()
     * will return the configured response exactly once, then reset.
     *
     * @param {Object} response
     * @param {string} [response.text] - Response text
     * @param {string} [response.model] - Model to return
     * @param {number} [response.promptTokens]
     * @param {number} [response.completionTokens]
     * @param {number} [response.costUsd]
     * @param {string|Object} [response.error] - Error type: 'TIMEOUT', '429', '5xx', 'MODEL_MISMATCH', or an Error object
     */
    setNextResponse: function(response) {
      nextResponse = response || null;
    },

    /**
     * Reset any pending next-response override.
     */
    reset: function() {
      nextResponse = null;
    },

    /**
     * Get the last recorded request headers (for test assertion).
     * Returns {xTitle, user} or null if no request was made.
     */
    getLastRequestHeaders: function() {
      return lastRequestHeaders;
    },

    complete: function(options) {
      options = options || {};
      var messages = options.messages || [];
      var taskId = options.taskId || 'unknown';
      var purpose = options.purpose || 'unknown';
      var runId = options.runId || 'unknown';

      // Record what headers would have been sent
      lastRequestHeaders = {
        xTitle: 'vendure-pipeline',
        user: 'vendure-pipeline:' + runId
      };

      var resolved = nextResponse;
      nextResponse = null; // consume one-shot

      // If no override set, use defaults
      var text = resolved && resolved.text !== undefined ? resolved.text : defaultText;
      var model = resolved && resolved.model !== undefined ? resolved.model : defaultModel;
      var promptTokens = resolved && resolved.promptTokens !== undefined ? resolved.promptTokens : defaultPromptTokens;
      var completionTokens = resolved && resolved.completionTokens !== undefined ? resolved.completionTokens : defaultCompletionTokens;
      var costUsd = resolved && resolved.costUsd !== undefined ? resolved.costUsd : defaultCostUsd;

      // Check for error simulation (setNextResponse takes precedence)
      if (resolved && resolved.error) {
        var errValue = resolved.error;
        if (errValue instanceof Error) {
          return Promise.reject(errValue);
        }
        var errType = typeof errValue === 'string' ? errValue : 'ERROR';
        if (errType === 'TIMEOUT') {
          return Promise.reject(new Error('Fetch timeout'));
        } else if (errType === '429') {
          var err429 = new Error('Rate limit exceeded');
          err429.status = 429;
          return Promise.reject(err429);
        } else if (errType === '5xx') {
          var err5xx = new Error('Internal server error');
          err5xx.status = 500;
          return Promise.reject(err5xx);
        } else if (errType === 'MODEL_MISMATCH') {
          return Promise.resolve({
            text: 'Response from wrong model',
            model: 'openai/gpt-4o', // wrong model
            usage: {
              promptTokens: promptTokens,
              completionTokens: completionTokens
            },
            costUsd: costUsd,
            requestId: 'mock-' + crypto.randomBytes(4).toString('hex'),
            generationId: resolved.generationId || null
          });
        }
      }

      // If custom generate function provided, call it instead of returning defaults
      if (customGenerate) {
        return Promise.resolve().then(function() {
          return customGenerate({
            messages: messages,
            taskId: taskId,
            purpose: purpose,
            runId: runId,
            text: defaultText,
            model: defaultModel,
            promptTokens: defaultPromptTokens,
            completionTokens: defaultCompletionTokens,
            costUsd: defaultCostUsd
          });
        });
      }

      return Promise.resolve({
        text: text,
        model: model,
        usage: {
          promptTokens: promptTokens,
          completionTokens: completionTokens
        },
        costUsd: costUsd,
        requestId: 'mock-' + crypto.randomBytes(4).toString('hex'),
        generationId: (resolved && resolved.generationId !== undefined) ? resolved.generationId : null
      });
    }
  };

  return provider;
}

module.exports = { createMockProvider: createMockProvider };