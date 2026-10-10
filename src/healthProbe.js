'use strict';

var ALLOWLISTED_HOSTS = ['staging.tibella.eu'];

function probe(url, deps) {
  deps = deps || {};
  var fetchFn = deps.fetch || global.fetch;
  var sleepFn = deps.sleep || defaultSleep;
  var timeoutMs = deps.timeoutMs || 10000;

  if (!url) {
    return Promise.resolve({
      ok: false,
      error: 'No URL provided',
      attempts: []
    });
  }

  var parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return Promise.resolve({
      ok: false,
      error: 'Invalid URL: ' + e.message,
      attempts: []
    });
  }

  var hostname = parsedUrl.hostname;
  if (!isAllowlisted(hostname)) {
    return Promise.resolve({
      ok: false,
      error: 'Host not allowlisted: ' + hostname,
      allowlistedHosts: ALLOWLISTED_HOSTS,
      attempts: []
    });
  }

  var attempts = [];
  var retryDelays = [2000, 4000, 8000];
  var lastError = null;

  return new Promise(function(resolve) {
    function attempt(attemptNum) {
      var attemptRecord = {
        attempt: attemptNum,
        timestamp: new Date().toISOString(),
        statusCode: null,
        responseBody: null,
        error: null,
        latencyMs: null
      };

      var startTime = Date.now();
      var controller = new AbortController();
      var timeoutId = setTimeout(function() {
        controller.abort();
      }, timeoutMs);

      var probeUrl = url;
      if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
        probeUrl = url.replace(/\/?$/, '/health');
      } else if (!parsedUrl.pathname.endsWith('/health')) {
        probeUrl = url.replace(/\/health$/, '') + '/health';
      }

      return fetchFn(probeUrl, { signal: controller.signal })
        .finally(function() {
          clearTimeout(timeoutId);
        })
        .then(function(response) {
          attemptRecord.latencyMs = Date.now() - startTime;
          attemptRecord.statusCode = response.status;
          return response.text();
        })
        .then(function(body) {
          attemptRecord.responseBody = body;
          var data;
          try {
            data = JSON.parse(body);
          } catch (e) {
            data = { raw: body };
          }
          return { response: attemptRecord, data: data };
        })
        .catch(function(err) {
          attemptRecord.latencyMs = Date.now() - startTime;
          lastError = err;
          attemptRecord.error = err.message || String(err);
          return { response: attemptRecord, data: null };
        })
        .then(function(result) {
          attempts.push(result.response);

          if (result.data && result.data.status === 'ok' && result.response.statusCode === 200) {
            resolve({
              ok: true,
              url: probeUrl,
              attempts: attempts
            });
            return;
          }

          if (attemptNum < 4) {
            var delay = retryDelays[attemptNum - 1];
            sleepFn(delay).then(function() {
              attempt(attemptNum + 1);
            });
          } else {
            resolve({
              ok: false,
              url: probeUrl,
              error: 'Health check failed after 4 attempts',
              lastError: lastError ? lastError.message : null,
              attempts: attempts
            });
          }
        });
    }

    attempt(1);
  });
}

function isAllowlisted(hostname) {
  return ALLOWLISTED_HOSTS.indexOf(hostname) !== -1;
}

function defaultSleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function getAllowlistedHosts() {
  return ALLOWLISTED_HOSTS.slice();
}

module.exports = {
  probe: probe,
  isAllowlisted: isAllowlisted,
  getAllowlistedHosts: getAllowlistedHosts
};