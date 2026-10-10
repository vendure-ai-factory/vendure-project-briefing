'use strict';

var fs = require('fs');
var path = require('path');

/**
 * DOC_URL: https://openrouter.ai/docs/api-reference/key-endpoint
 * Verified path: GET https://openrouter.ai/api/v1/key
 */

/**
 * Key usage probe for OpenRouter.
 *
 * @param {Object} options
 * @param {string} [options.providerType='mock'] - 'mock' or 'real'
 * @param {Function} [options.getEnv] - Function returning env vars (default: process.env)
 * @param {Function} [options.fetchFn] - Fetch function (default: real fetch, unused in mock mode)
 * @param {string} [options.baseUrl] - OpenRouter base URL for real provider
 */
function createKeyUsageProbe(options) {
  options = options || {};
  var providerType = options.providerType || 'mock';
  var getEnv = options.getEnv || function() { return process.env; };
  var fetchFn = options.fetchFn;
  var baseUrl = options.baseUrl || 'https://openrouter.ai/api/v1';

  /**
   * Probe key usage from OpenRouter key-info endpoint.
   * Returns {usage, limit} or throws on error.
   *
   * @param {Object} [overrideOptions]
   * @param {string} [overrideOptions.apiKey] - Override API key (for testing only, never logged)
   * @returns {Promise<{usage: number, limit: number}>}
   */
  function probeKeyUsage(overrideOptions) {
    overrideOptions = overrideOptions || {};

    if (providerType === 'mock') {
      return Promise.resolve({
        usage: 0.0123,
        limit: 5.00,
        status: 'active'
      });
    }

    // Real provider
    var apiKey = overrideOptions.apiKey || getEnv()['OPENROUTER_API_KEY'];
    if (!apiKey) {
      var err = new Error('OPENROUTER_API_KEY is not set');
      err.code = 'MISSING_KEY';
      return Promise.reject(err);
    }

    // Never log the key itself or any label containing key fragments
    // Just use the fetch function if provided
    var fetch = fetchFn || global.fetch;
    if (!fetch) {
      var noFetchErr = new Error('fetch not available');
      noFetchErr.code = 'NO_FETCH';
      return Promise.reject(noFetchErr);
    }

    return fetch(baseUrl + '/key', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey
      }
    }).then(function(response) {
      if (!response.ok) {
        var httpErr = new Error('Key info endpoint error: ' + response.status);
        httpErr.status = response.status;
        httpErr.code = 'HTTP_ERROR';
        return Promise.reject(httpErr);
      }
      return response.json();
    }).then(function(data) {
      // OpenRouter key-info response shape:
      // { data: { usage: number, limit: number } } or { usage: number, limit: number }
      // Accept usage and limit from a "data" wrapper if present.
      var usage;
      var limit;

      if (data.data !== undefined && typeof data.data === 'object') {
        // Wrapped form: { data: { usage, limit } }
        usage = data.data.usage;
        limit = data.data.limit;
      } else {
        // Direct form: { usage, limit }
        usage = data.usage;
        limit = data.limit;
      }

      // Reject if usage is missing or not a finite number
      if (usage === undefined || usage === null || !isFinite(usage)) {
        var shapeErr = new Error('usage is missing or not a finite number');
        shapeErr.code = 'BAD_PROBE_SHAPE';
        return Promise.reject(shapeErr);
      }

      // Reject if limit is missing or not a finite number
      if (limit === undefined || limit === null || !isFinite(limit)) {
        var limitErr = new Error('limit is missing or not a finite number');
        limitErr.code = 'BAD_PROBE_SHAPE';
        return Promise.reject(limitErr);
      }

      // Extract optional extended fields from data wrapper
      var limitRemaining;
      var expiresAt;
      if (data.data !== undefined && typeof data.data === 'object') {
        limitRemaining = data.data.limit_remaining;
        expiresAt = data.data.expires_at;
      }

      return {
        usage: usage,
        limit: limit,
        limitRemaining: limitRemaining,
        expiresAt: expiresAt
      };
    }).catch(function(err) {
      // Re-throw with code for classification
      err.code = err.code || 'PROBE_FAILED';
      return Promise.reject(err);
    });
  }

  return {
    probeKeyUsage: probeKeyUsage
  };
}

/**
 * Write key usage reconciliation file for a run.
 *
 * @param {string} runId - Run ID
 * @param {Object} data - Reconciliation data
 * @param {number} data.usageBefore - Usage before the run
 * @param {number} data.usageAfter - Usage after the run
 * @param {number} data.deltaReported - Delta reported by provider
 * @param {number} data.ledgerTotal - Total cost from ledger
 * @param {number} data.difference - Difference (deltaReported - ledgerTotal)
 * @param {number} [data.toleranceUsd=0.0001] - Tolerance threshold
 * @param {string} data.status - 'MATCH' | 'MISMATCH' | 'PROBE_UNAVAILABLE'
 * @param {Object} [deps] - Test dependencies
 */
function writeKeyUsageReconciliation(runId, data, deps) {
  deps = deps || {};
  var fs_ = deps.fs || fs;
  var path_ = deps.path || path;

  if (!runId) {
    throw new Error('runId is required');
  }

  var runsDir = path_.resolve(process.cwd(), 'runs');
  var runDir = path_.join(runsDir, runId);
  var reconciliationPath = path_.join(runDir, 'key-usage-reconciliation.json');

  var toleranceUsd = data.toleranceUsd !== undefined ? data.toleranceUsd : 0.0001;

  var reconciliation = {
    usageBefore: data.usageBefore,
    usageAfter: data.usageAfter,
    deltaReported: data.deltaReported,
    ledgerTotal: data.ledgerTotal,
    difference: data.difference,
    toleranceUsd: toleranceUsd,
    status: data.status
  };

  // Ensure directory exists
  try {
    if (!fs_.existsSync(runDir)) {
      fs_.mkdirSync(runDir, { recursive: true });
    }
  } catch (e) {
    // Non-fatal
    return;
  }

  try {
    fs_.writeFileSync(reconciliationPath, JSON.stringify(reconciliation, null, 2), 'utf8');
  } catch (e) {
    // Non-fatal
  }
}

/**
 * Read key usage reconciliation file for a run.
 */
function readKeyUsageReconciliation(runId, deps) {
  deps = deps || {};
  var fs_ = deps.fs || fs;
  var path_ = deps.path || path;

  if (!runId) return null;

  var reconciliationPath = path_.join(path_.resolve(process.cwd(), 'runs'), runId, 'key-usage-reconciliation.json');
  if (!fs_.existsSync(reconciliationPath)) return null;

  try {
    var content = fs_.readFileSync(reconciliationPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

module.exports = {
  createKeyUsageProbe: createKeyUsageProbe,
  writeKeyUsageReconciliation: writeKeyUsageReconciliation,
  readKeyUsageReconciliation: readKeyUsageReconciliation
};
