'use strict';

var keyUsageProbeModule = require('./keyUsageProbe');
var ledgerModule = require('./usageLedger');

/**
 * Finalize key usage reconciliation for a run.
 *
 * Takes probe readings from before the first LLM call (probeBefore) and after the
 * last one (probeAfter), computes the ledger total, and writes key-usage-reconciliation.json.
 *
 * If no LLM call happened in the run (ledger empty), writes nothing and returns early.
 *
 * @param {Object} params
 * @param {Object} params.probeBefore - Result of probeKeyUsage() before first LLM call
 * @param {Object} params.probeAfter - Result of probeKeyUsage() after last LLM call (null if probe unavailable)
 * @param {Object} params.ledger - The usageLedger module or {readLedger(runId)} result
 * @param {string} params.runId - Run ID
 * @param {Object} [params.deps] - Test dependencies (fs, path, etc.)
 * @returns {Object|null} The reconciliation result, or null if no LLM calls happened
 */
function finalizeRunKeyUsage(params, deps) {
  params = params || {};
  deps = deps || {};

  var probeBefore = params.probeBefore;
  var probeAfter = params.probeAfter;
  var ledger = params.ledger || ledgerModule;
  var runId = params.runId;

  if (!runId) {
    throw new Error('runId is required');
  }

  var fs_ = deps.fs || require('fs');
  var path_ = deps.path || require('path');

  // Read all ledger entries for this run
  var entries = ledger.readLedger ? ledger.readLedger(runId) : [];
  var hasCalls = entries && entries.length > 0;

  if (!hasCalls) {
    // No LLM calls happened - write nothing, return null
    return null;
  }

  // Compute ledger total cost
  var ledgerTotal = 0;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].costUsd !== null && entries[i].costUsd !== undefined) {
      ledgerTotal += entries[i].costUsd;
    }
  }

  // Determine status based on probe availability
  var status;
  var deltaReported;
  var usageBefore;
  var usageAfter;
  var difference;
  var toleranceUsd;

  var DEFAULT_TOLERANCE_USD = 0.0001;

  // Detect BAD_PROBE_SHAPE error on probe objects
  function isProbeError(probe) {
    if (!probe) return true;
    if (probe.error && probe.error.code === 'BAD_PROBE_SHAPE') return true;
    return false;
  }

  if (!probeBefore || !probeAfter || isProbeError(probeBefore) || isProbeError(probeAfter)) {
    // BAD_PROBE_SHAPE or any probe error -> PROBE_UNAVAILABLE
    status = 'PROBE_UNAVAILABLE';
    usageBefore = probeBefore && probeBefore.usage !== undefined ? probeBefore.usage : null;
    usageAfter = probeAfter && probeAfter.usage !== undefined ? probeAfter.usage : null;
    deltaReported = null;
    difference = null;
    toleranceUsd = DEFAULT_TOLERANCE_USD;
  } else {
    usageBefore = probeBefore.usage;
    usageAfter = probeAfter.usage;
    deltaReported = Math.max(0, usageAfter - usageBefore);
    difference = deltaReported - ledgerTotal;

    // If delta is 0 but ledger shows activity beyond tolerance, that's a MISMATCH
    // (provider reported no usage change but ledger recorded costs)
    if (deltaReported === 0 && Math.abs(ledgerTotal) > DEFAULT_TOLERANCE_USD) {
      status = 'MISMATCH';
    } else if (Math.abs(difference) <= DEFAULT_TOLERANCE_USD) {
      status = 'MATCH';
    } else {
      status = 'MISMATCH';
    }
    toleranceUsd = DEFAULT_TOLERANCE_USD;
  }

  keyUsageProbeModule.writeKeyUsageReconciliation(runId, {
    usageBefore: usageBefore,
    usageAfter: usageAfter,
    deltaReported: deltaReported,
    ledgerTotal: Math.round(ledgerTotal * 1000000) / 1000000,
    difference: difference !== null ? Math.round(difference * 1000000) / 1000000 : null,
    toleranceUsd: toleranceUsd,
    status: status
  }, deps);

  return {
    status: status,
    usageBefore: usageBefore,
    usageAfter: usageAfter,
    deltaReported: deltaReported,
    ledgerTotal: ledgerTotal,
    difference: difference
  };
}

module.exports = { finalizeRunKeyUsage: finalizeRunKeyUsage };
