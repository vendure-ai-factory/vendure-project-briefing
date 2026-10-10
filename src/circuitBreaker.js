'use strict';

/**
 * Circuit Breaker for external dependencies.
 *
 * Tracks failures per dependency over a sliding window of the last 5 calls.
 * Opens when 3+ of the last 5 calls failed. Open for 30s (injected clock),
 * then one half-open probe: success closes, failure reopens.
 *
 * An open circuit returns BLOCK with safeStop:true and never produces a passing outcome.
 */

var WINDOW_SIZE = 5;
var FAILURE_THRESHOLD = 3;
var OPEN_DURATION_MS = 30000;

function createCircuitBreaker(options) {
  options = options || {};
  var clockFn = options.clockFn || function() { return Date.now(); };

  // Per-dependency state
  var states = {};

  function getState(label) {
    if (!states[label]) {
      states[label] = {
        outcomes: [],           // rolling window of last WINDOW_SIZE outcomes
        totalCycles: 0,         // total retry cycles for this dependency
        state: 'CLOSED',        // CLOSED | OPEN | HALF_OPEN
        openedAt: null,         // timestamp when opened
        cycleFailures: 0        // failures in current cycle (reset on success)
      };
    }
    return states[label];
  }

  function recordOutcome(label, success) {
    var state = getState(label);
    var outcome = {
      success: success,
      at: clockFn()
    };
    state.outcomes.push(outcome);

    // Keep only last WINDOW_SIZE outcomes
    if (state.outcomes.length > WINDOW_SIZE) {
      state.outcomes.shift();
    }

    // Update state machine
    if (!success) {
      state.cycleFailures++;
      if (state.state === 'HALF_OPEN') {
        // Probe failed: reopen
        state.state = 'OPEN';
        state.openedAt = clockFn();
      } else if (state.state === 'CLOSED') {
        // Check if threshold crossed
        var recentFailures = countRecentFailures(state);
        if (recentFailures >= FAILURE_THRESHOLD) {
          state.state = 'OPEN';
          state.openedAt = clockFn();
        }
      }
    } else {
      // Success
      state.cycleFailures = 0;
      // Clear the outcomes array: success resets the failure window
      // so that old failures don't count toward future threshold checks
      state.outcomes = [];
      if (state.state === 'HALF_OPEN') {
        // Probe succeeded: close
        state.state = 'CLOSED';
        state.openedAt = null;
      }
    }

    return isCircuitOpen(label);
  }

  function countRecentFailures(state) {
    var count = 0;
    for (var i = 0; i < state.outcomes.length; i++) {
      if (!state.outcomes[i].success) count++;
    }
    return count;
  }

  function isCircuitOpen(label) {
    var state = getState(label);

    if (state.state === 'OPEN') {
      var now = clockFn();
      var elapsed = now - state.openedAt;
      if (elapsed >= OPEN_DURATION_MS) {
        // Transition to half-open: one probe allowed
        state.state = 'HALF_OPEN';
        return {
          open: false,
          label: label,
          state: 'HALF_OPEN',
          shouldProbe: true,
          safeStop: false
        };
      }
      return {
        open: true,
        label: label,
        state: 'OPEN',
        openedAt: state.openedAt,
        elapsedMs: now - state.openedAt,
        safeStop: true
      };
    }

    return {
      open: false,
      label: label,
      state: state.state,
      shouldProbe: false,
      safeStop: false
    };
  }

  function recordDependencyRetryCycle(label) {
    var state = getState(label);
    state.totalCycles++;
  }

  function getMaxCycles(label) {
    return 3;
  }

  function canRetryCycle(label) {
    var state = getState(label);
    return state.totalCycles < getMaxCycles(label);
  }

  function reset(label) {
    if (label) {
      states[label] = null;
    } else {
      states = {};
    }
  }

  function getStats(label) {
    var state = getState(label);
    return {
      label: label,
      state: state.state,
      outcomes: state.outcomes.slice(),
      totalCycles: state.totalCycles,
      maxCycles: getMaxCycles(label),
      recentFailures: countRecentFailures(state),
      cycleFailures: state.cycleFailures,
      openedAt: state.openedAt,
      safeStop: isCircuitOpen(label).safeStop
    };
  }

  return {
    recordOutcome: recordOutcome,
    isCircuitOpen: isCircuitOpen,
    recordDependencyRetryCycle: recordDependencyRetryCycle,
    canRetryCycle: canRetryCycle,
    getMaxCycles: getMaxCycles,
    reset: reset,
    getStats: getStats,
    WINDOW_SIZE: WINDOW_SIZE,
    FAILURE_THRESHOLD: FAILURE_THRESHOLD,
    OPEN_DURATION_MS: OPEN_DURATION_MS
  };
}

/**
 * Shared global circuit breaker instance.
 * Exported so llm/index.js can wire isCircuitOpen hook.
 */
var globalBreaker = null;

function getGlobalBreaker() {
  if (!globalBreaker) {
    globalBreaker = createCircuitBreaker({});
  }
  return globalBreaker;
}

function resetGlobalBreaker() {
  if (globalBreaker) {
    globalBreaker.reset();
    globalBreaker = null;
  }
}

module.exports = {
  createCircuitBreaker: createCircuitBreaker,
  getGlobalBreaker: getGlobalBreaker,
  resetGlobalBreaker: resetGlobalBreaker,
  WINDOW_SIZE: WINDOW_SIZE,
  FAILURE_THRESHOLD: FAILURE_THRESHOLD,
  OPEN_DURATION_MS: OPEN_DURATION_MS
};