'use strict';

/**
 * LLM Provider Interface
 *
 * All LLM providers must implement the complete() method with this signature:
 *   complete({messages, taskId, purpose, model}) -> Promise<LLMResult>
 *
 * @module provider
 */

/**
 * @typedef {Object} LLMResult
 * @property {string} text - The generated text response
 * @property {string} model - The model ID that generated the response
 * @property {Object} usage - Token usage information
 * @property {number} usage.promptTokens - Number of prompt tokens used
 * @property {number} usage.completionTokens - Number of completion tokens used
 * @property {number} costUsd - Cost of the call in USD
 * @property {string} requestId - Unique identifier for this request
 */

/**
 * Budget-paused result. Returned when the budget hard limit has been reached.
 * @constructor
 * @param {string} [message]
 */
function BudgetPausedError(message) {
  Error.call(this, message || 'LLM budget exhausted');
  this.name = 'BudgetPausedError';
}
BudgetPausedError.prototype = Object.create(Error.prototype);
BudgetPausedError.prototype.constructor = BudgetPausedError;

/**
 * Model mismatch error. Returned when the response model doesn't match the configured model.
 * @constructor
 * @param {string} requested - The model that was requested
 * @param {string} received - The model that was returned
 */
function ModelMismatchError(requested, received) {
  Error.call(this, 'Model mismatch: requested ' + requested + ', received ' + received);
  this.name = 'ModelMismatchError';
  this.requestedModel = requested;
  this.receivedModel = received;
}
ModelMismatchError.prototype = Object.create(Error.prototype);
ModelMismatchError.prototype.constructor = ModelMismatchError;

module.exports = {
  BudgetPausedError: BudgetPausedError,
  ModelMismatchError: ModelMismatchError
};