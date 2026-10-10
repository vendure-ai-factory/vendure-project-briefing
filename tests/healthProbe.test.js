'use strict';

var test = require('node:test');
var assert = require('node:assert');

var healthProbeModule = require('../src/healthProbe');

test('healthProbe: isAllowlisted returns true for staging.tibella.eu', function(t, done) {
  assert.strictEqual(healthProbeModule.isAllowlisted('staging.tibella.eu'), true);
  done();
});

test('healthProbe: isAllowlisted returns false for other hosts', function(t, done) {
  assert.strictEqual(healthProbeModule.isAllowlisted('evil.com'), false);
  assert.strictEqual(healthProbeModule.isAllowlisted('staging.tibella.eu.evil.com'), false);
  done();
});

test('healthProbe: getAllowlistedHosts returns array', function(t, done) {
  var hosts = healthProbeModule.getAllowlistedHosts();
  assert.ok(Array.isArray(hosts));
  assert.strictEqual(hosts.indexOf('staging.tibella.eu'), 0);
  done();
});

test('healthProbe: probe rejects non-allowlisted host immediately', async function(t) {
  var result = await healthProbeModule.probe('https://evil.com/health', {
    fetch: function() { return Promise.reject(new Error('should not be called')); }
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.indexOf('not allowlisted') !== -1);
});

test('healthProbe: probe returns error for invalid URL', async function(t) {
  var result = await healthProbeModule.probe('not-a-valid-url', {
    fetch: function() { return Promise.reject(new Error('should not be called')); }
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.indexOf('Invalid URL') !== -1);
});

test('healthProbe: probe returns error for no URL', async function(t) {
  var result = await healthProbeModule.probe(null, {
    fetch: function() { return Promise.reject(new Error('should not be called')); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'No URL provided');
});

test('healthProbe: probe succeeds with 200 and status ok', async function(t) {
  var attempts = [];
  var result = await healthProbeModule.probe('https://staging.tibella.eu', {
    fetch: function(url) {
      attempts.push(url);
      return Promise.resolve({
        status: 200,
        text: function() { return Promise.resolve('{"status":"ok"}'); }
      });
    },
    sleep: function(ms) { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.url.indexOf('/health') !== -1);
});

test('healthProbe: probe retries 3 times on failure', async function(t) {
  var callCount = 0;
  var result = await healthProbeModule.probe('https://staging.tibella.eu', {
    fetch: function(url) {
      callCount++;
      return Promise.resolve({
        status: 500,
        text: function() { return Promise.resolve('{"error":"server error"}'); }
      });
    },
    sleep: function(ms) { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(callCount, 4, 'Should make 4 total attempts (3 retries)');
  assert.strictEqual(result.attempts.length, 4);
});

test('healthProbe: backoff delays are 2s, 4s, 8s', async function(t) {
  var delays = [];
  var result = await healthProbeModule.probe('https://staging.tibella.eu', {
    fetch: function(url) {
      return Promise.resolve({
        status: 500,
        text: function() { return Promise.resolve('{}'); }
      });
    },
    sleep: function(ms) {
      delays.push(ms);
      return Promise.resolve();
    }
  });
  assert.deepStrictEqual(delays, [2000, 4000, 8000]);
});

test('healthProbe: probe succeeds on second attempt', async function(t) {
  var callCount = 0;
  var result = await healthProbeModule.probe('https://staging.tibella.eu', {
    fetch: function(url) {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 500,
          text: function() { return Promise.resolve('{}'); }
        });
      }
      return Promise.resolve({
        status: 200,
        text: function() { return Promise.resolve('{"status":"ok"}'); }
      });
    },
    sleep: function(ms) { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(callCount, 2);
});

test('healthProbe: probe records timestamps for each attempt', async function(t) {
  var result = await healthProbeModule.probe('https://staging.tibella.eu', {
    fetch: function(url) {
      return Promise.resolve({
        status: 500,
        text: function() { return Promise.resolve('{}'); }
      });
    },
    sleep: function(ms) { return Promise.resolve(); }
  });
  assert.strictEqual(result.attempts.length, 4, 'Should have 4 attempts');
  result.attempts.forEach(function(attempt, i) {
    assert.ok(attempt.timestamp, 'Attempt ' + i + ' should have timestamp');
    assert.strictEqual(attempt.attempt, i + 1);
  });
});