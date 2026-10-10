'use strict';

var circuitBreakerModule = require('../src/circuitBreaker');
var test = require('node:test');
var assert = require('node:assert');

function createFakeClock(initialTime) {
  initialTime = initialTime || 1000;
  var currentTime = initialTime;
  return {
    now: function() { return currentTime; },
    advance: function(ms) { currentTime += ms; },
    getCurrent: function() { return currentTime; }
  };
}

test('circuitBreaker: 3 failures in 5 calls opens circuit', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // First 2 calls fail, circuit still closed
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  var status1 = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status1.open, false, 'Circuit should be closed after 2 failures');

  // 3rd failure crosses threshold
  breaker.recordOutcome('openrouter', false);
  var status2 = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status2.open, true, 'Circuit should open after 3rd failure');
  assert.strictEqual(status2.state, 'OPEN', 'State should be OPEN');
  assert.strictEqual(status2.safeStop, true, 'SafeStop should be true when open');
  assert.strictEqual(status2.label, 'openrouter', 'Label should be preserved');

  done();
});

test('circuitBreaker: calls blocked while circuit is open', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open the circuit
  breaker.recordOutcome('health-probe', false);
  breaker.recordOutcome('health-probe', false);
  breaker.recordOutcome('health-probe', false);

  var status = breaker.isCircuitOpen('health-probe');
  assert.strictEqual(status.open, true, 'Circuit should be open');
  assert.strictEqual(status.safeStop, true, 'Should have safeStop=true');

  done();
});

test('circuitBreaker: after 30s clock advances, circuit goes half-open', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open the circuit
  breaker.recordOutcome('stripe', false);
  breaker.recordOutcome('stripe', false);
  breaker.recordOutcome('stripe', false);

  var statusBefore = breaker.isCircuitOpen('stripe');
  assert.strictEqual(statusBefore.open, true, 'Should be open at t=0');
  assert.strictEqual(statusBefore.state, 'OPEN', 'Should be OPEN at t=0');

  // Advance clock past 30s
  clock.advance(30001);

  var statusAfter = breaker.isCircuitOpen('stripe');
  assert.strictEqual(statusAfter.open, false, 'Should not be open after 30s');
  assert.strictEqual(statusAfter.state, 'HALF_OPEN', 'Should be HALF_OPEN');
  assert.strictEqual(statusAfter.shouldProbe, true, 'shouldProbe should be true');
  assert.strictEqual(statusAfter.safeStop, false, 'safeStop should be false in half-open');

  done();
});

test('circuitBreaker: half-open probe success closes circuit', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open circuit
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  // Advance to half-open
  clock.advance(30001);
  breaker.isCircuitOpen('openrouter'); // trigger half-open transition

  // Probe succeeds
  breaker.recordOutcome('openrouter', true);

  var status = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status.open, false, 'Should not be open after probe success');
  assert.strictEqual(status.state, 'CLOSED', 'Should be CLOSED after probe success');
  assert.strictEqual(status.safeStop, false, 'safeStop should be false');

  done();
});

test('circuitBreaker: half-open probe failure reopens circuit', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open circuit
  breaker.recordOutcome('shop-api', false);
  breaker.recordOutcome('shop-api', false);
  breaker.recordOutcome('shop-api', false);

  // Advance to half-open
  clock.advance(30001);
  breaker.isCircuitOpen('shop-api'); // trigger half-open transition

  // Probe fails
  breaker.recordOutcome('shop-api', false);

  var status = breaker.isCircuitOpen('shop-api');
  assert.strictEqual(status.open, true, 'Should reopen after half-open failure');
  assert.strictEqual(status.state, 'OPEN', 'Should be OPEN again');
  assert.strictEqual(status.safeStop, true, 'safeStop should be true when open');

  done();
});

test('circuitBreaker: open circuit returns safeStop=true and never PASS_CANDIDATE', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open circuit
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  var status = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status.open, true, 'Circuit should be open');
  assert.strictEqual(status.safeStop, true, 'safeStop should be true');

  // Verify the circuit never returns PASS_CANDIDATE in its status
  // (An open circuit blocks, does not pass)
  var stats = breaker.getStats('openrouter');
  assert.strictEqual(stats.state, 'OPEN', 'State should be OPEN');
  assert.strictEqual(stats.safeStop, true, 'safeStop should be true in stats');

  done();
});

test('circuitBreaker: 2 successes then 3 failures does NOT open', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  breaker.recordOutcome('openrouter', true);
  breaker.recordOutcome('openrouter', true);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  var status = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status.open, false, 'Should not open with 2 successes + 2 failures');

  breaker.recordOutcome('openrouter', false); // 3rd failure
  var status2 = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status2.open, true, 'Should open after 3rd failure');

  done();
});

test('circuitBreaker: successes reset failure window', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // 2 failures
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  // Success resets
  breaker.recordOutcome('openrouter', true);

  // Now 2 more failures (but old ones pushed out)
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  var status = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status.open, false, 'Should not open: window has successes');

  done();
});

test('circuitBreaker: getStats returns correct state', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  breaker.recordOutcome('test-dep', false);
  breaker.recordOutcome('test-dep', false);

  var stats = breaker.getStats('test-dep');
  assert.strictEqual(stats.label, 'test-dep', 'Label should match');
  assert.strictEqual(stats.state, 'CLOSED', 'State should be CLOSED');
  assert.strictEqual(stats.recentFailures, 2, 'Should have 2 recent failures');
  assert.strictEqual(stats.outcomes.length, 2, 'Should have 2 outcomes');
  assert.strictEqual(stats.maxCycles, 3, 'Max cycles should be 3');
  assert.strictEqual(stats.safeStop, false, 'safeStop should be false when closed');

  done();
});

test('circuitBreaker: reset clears state', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  assert.strictEqual(breaker.isCircuitOpen('openrouter').open, true, 'Should be open');

  breaker.reset('openrouter');

  var stats = breaker.getStats('openrouter');
  assert.strictEqual(stats.state, 'CLOSED', 'Should be closed after reset');
  assert.strictEqual(stats.recentFailures, 0, 'Should have 0 failures after reset');

  done();
});

test('circuitBreaker: dependency retry cycle tracking', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  assert.strictEqual(breaker.canRetryCycle('openrouter'), true, 'Should allow first cycle');
  breaker.recordDependencyRetryCycle('openrouter');
  assert.strictEqual(breaker.canRetryCycle('openrouter'), true, 'Should allow second cycle');
  breaker.recordDependencyRetryCycle('openrouter');
  assert.strictEqual(breaker.canRetryCycle('openrouter'), true, 'Should allow third cycle');
  breaker.recordDependencyRetryCycle('openrouter');
  assert.strictEqual(breaker.canRetryCycle('openrouter'), false, 'Should not allow fourth cycle');

  var stats = breaker.getStats('openrouter');
  assert.strictEqual(stats.totalCycles, 3, 'Should have 3 cycles recorded');
  assert.strictEqual(stats.maxCycles, 3, 'Max cycles should be 3');

  done();
});

test('circuitBreaker: injected clock used for all timing', function(t, done) {
  var clock = createFakeClock(5000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open circuit at clock t=5000
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  var status1 = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status1.openedAt, 5000, 'openedAt should use clock time');
  assert.strictEqual(status1.elapsedMs, 0, 'elapsedMs should be 0 at open time');

  // Advance clock
  clock.advance(15000); // t=20000

  var status2 = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status2.elapsedMs, 15000, 'elapsedMs should be 15000');
  assert.strictEqual(status2.open, true, 'Still open at 15s elapsed');

  // Advance past 30s
  clock.advance(20000); // t=40000
  var status3 = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(status3.open, false, 'Should transition to half-open');
  assert.strictEqual(status3.state, 'HALF_OPEN', 'Should be half-open');

  done();
});

test('circuitBreaker: per-dependency state isolation', function(t, done) {
  var clock = createFakeClock(1000);
  var breaker = circuitBreakerModule.createCircuitBreaker({
    clockFn: clock.now.bind(clock)
  });

  // Open 'openrouter' circuit
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  // 'shop-api' should be unaffected
  var shopStatus = breaker.isCircuitOpen('shop-api');
  assert.strictEqual(shopStatus.open, false, 'shop-api should be unaffected');

  var openrouterStatus = breaker.isCircuitOpen('openrouter');
  assert.strictEqual(openrouterStatus.open, true, 'openrouter should be open');

  done();
});

test('circuitBreaker: constants are exposed', function(t, done) {
  assert.strictEqual(circuitBreakerModule.WINDOW_SIZE, 5, 'WINDOW_SIZE should be 5');
  assert.strictEqual(circuitBreakerModule.FAILURE_THRESHOLD, 3, 'FAILURE_THRESHOLD should be 3');
  assert.strictEqual(circuitBreakerModule.OPEN_DURATION_MS, 30000, 'OPEN_DURATION_MS should be 30000');
  done();
});