'use strict';

var crypto = require('crypto');

/**
 * Build request headers and body for OpenRouter chat completions without sending.
 * Authorization header is NOT included in returned headers - caller must add it.
 *
 * @param {Object} params
 * @param {string} [params.runId]
 * @param {string} [params.model]
 * @param {Array} [params.messages]
 * @returns {{headers: Object, body: Object}}
 */
function buildRequest(params) {
  params = params || {};
  var runId = params.runId || 'unknown';
  var model = params.model || 'z-ai/glm-5.3-flash';
  var messages = params.messages || [];

  return {
    headers: {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com',
      'X-Title': 'vendure-pipeline'
    },
    body: {
      model: model,
      messages: messages,
      user: 'vendure-pipeline:' + runId
    }
  };
}

/**
 * Real OpenRouter HTTP Provider.
 * Reads OPENROUTER_API_KEY from environment - NEVER called in tests.
 *
 * @param {Object} options
 * @param {string} [options.baseUrl='https://openrouter.ai/api/v1'] - OpenRouter API base URL
 */
function createOpenRouterProvider(options) {
  options = options || {};
  var baseUrl = options.baseUrl || 'https://openrouter.ai/api/v1';

  return {
    complete: function(options) {
      options = options || {};
      var messages = options.messages || [];
      var taskId = options.taskId || 'unknown';
      var purpose = options.purpose || 'unknown';

      var apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return Promise.reject(new Error('OPENROUTER_API_KEY is not set'));
      }

      var model = options.model || process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash';

      var requestId = 'req-' + crypto.randomBytes(8).toString('hex');

      var built = buildRequest({
        runId: options.runId || 'unknown',
        model: model,
        messages: messages
      });

      return fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'HTTP-Referer': 'https://github.com',
          'X-Title': 'vendure-pipeline'
        },
        body: JSON.stringify(built.body)
      }).then(function(response) {
        if (!response.ok) {
          var err = new Error('OpenRouter HTTP error: ' + response.status);
          err.status = response.status;
          err.requestId = requestId;
          return Promise.reject(err);
        }
        return response.json();
      }).then(function(data) {
        var choice = data.choices && data.choices[0];
        var usage = data.usage || {};
        var costUsd = calculateCost(model, usage.prompt_tokens || 0, usage.completion_tokens || 0);

        return {
          text: choice && choice.message && choice.message.content ? choice.message.content : '',
          model: data.model || model,
          usage: {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0
          },
          costUsd: costUsd,
          requestId: requestId,
          generationId: data.id || null
        };
      });
    }
  };
}

function calculateCost(model, promptTokens, completionTokens) {
  // OpenRouter pricing approximations (per 1M tokens)
  // glm-5.3-flash: ~$0.01/#prompt, $0.03/1M completion (approximate)
  var promptCostPerM = 0.01;
  var completionCostPerM = 0.03;

  var cost = (promptTokens / 1000000) * promptCostPerM +
             (completionTokens / 1000000) * completionCostPerM;
  return Math.round(cost * 1000000) / 1000000; // round to 6 decimal places
}

module.exports = { createOpenRouterProvider: createOpenRouterProvider, buildRequest: buildRequest };
