'use strict';

var childProcess = require('child_process');

var DEPLOY_REF_RE = /^ghcr\.io\/vendure-ai-factory\/nail-patterns-vendure@sha256:[a-f0-9]{64}$/;

var REDACTED_MARKER = '[REDACTED]';

var DEFAULT_TIMEOUT_MS = 600000;
var DEFAULT_HEALTH_MS = 300000;
var HEALTH_POLL_MS = 5000;

function redactSecrets(text, secretValues) {
  if (!secretValues || !Array.isArray(secretValues) || secretValues.length === 0) {
    return text;
  }
  var result = text;
  for (var i = 0; i < secretValues.length; i++) {
    var val = secretValues[i];
    if (val && typeof val === 'string' && result.indexOf(val) !== -1) {
      result = result.split(val).join(REDACTED_MARKER);
    }
  }
  return result;
}

function collectEnvSecrets() {
  var env = process.env || {};
  var keys = Object.keys(env);
  var values = [];
  var secretRe = /(api[_-]?key|secret|password|token|credential|auth)/i;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (secretRe.test(k) && typeof env[k] === 'string' && env[k].length > 0) {
      values.push(env[k]);
    }
  }
  return values;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function defaultRunCommand(cmd, args, opts) {
  return new Promise(function(resolve) {
    var timeout = opts && opts.timeout ? opts.timeout : 300000;
    var settled = false;
    var backstop = setTimeout(function() {
      if (!settled) {
        settled = true;
        resolve({ exitCode: null, stdout: '', stderr: 'timeout', timedOut: true });
      }
    }, timeout + 5000);

    childProcess.execFile(cmd, args, { shell: false, timeout: timeout }, function(err, stdout, stderr) {
      clearTimeout(backstop);
      if (settled) return;
      settled = true;
      if (err) {
        resolve({
          exitCode: err.code != null ? err.code : 1,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err.message,
          timedOut: false
        });
      } else {
        resolve({ exitCode: 0, stdout: stdout || '', stderr: stderr || '', timedOut: false });
      }
    });
  });
}

async function deploy(deployRef, options) {
  options = options || {};
  var runCommand = options.runCommand || defaultRunCommand;
  var healthUrl = options.healthUrl;
  var fetch = options.fetch || global.fetch;
  var sleepFn = options.sleep || sleep;
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  var healthMs = options.healthMs || DEFAULT_HEALTH_MS;

  if (!DEPLOY_REF_RE.test(deployRef)) {
    return {
      ok: false,
      blocker: {
        code: 'DEPLOY_REF_INVALID',
        message: 'deployRef validation failed',
        evidence: { deployRef: '<redacted>' }
      }
    };
  }

  var args = ['/usr/local/sbin/pipeline-staging-ops', 'deploy', deployRef];
  var execResult;
  try {
    execResult = await runCommand('sudo', args, { timeout: timeoutMs });
  } catch (err) {
    var secrets = collectEnvSecrets();
    return {
      ok: false,
      blocker: {
        code: 'DEPLOY_REFUSED',
        message: 'deploy command failed',
        evidence: {
          exitCode: null,
          stderrExcerpt: redactSecrets(err.message || String(err), secrets).substring(0, 500)
        }
      }
    };
  }

  if (execResult.timedOut) {
    return {
      ok: false,
      blocker: {
        code: 'DEPLOY_TIMEOUT',
        message: 'deploy command timed out',
        evidence: { timeoutMs: timeoutMs }
      }
    };
  }

  if (execResult.exitCode !== 0) {
    var secrets2 = collectEnvSecrets();
    var stderrText = execResult.stderr || '';
    return {
      ok: false,
      blocker: {
        code: 'DEPLOY_REFUSED',
        message: 'deploy command returned non-zero',
        evidence: {
          exitCode: execResult.exitCode,
          stderrExcerpt: redactSecrets(stderrText, secrets2).substring(0, 500)
        }
      }
    };
  }

  if (!healthUrl) {
    return { ok: true };
  }

  var healthStart = Date.now();
  while (true) {
    var elapsed = Date.now() - healthStart;
    if (elapsed > healthMs) {
      return {
        ok: false,
        blocker: {
          code: 'HEALTH_TIMEOUT',
          message: 'health check timed out',
          evidence: { healthUrl: healthUrl, elapsed: elapsed, maxMs: healthMs }
        }
      };
    }

    var healthResponse;
    try {
      healthResponse = await fetch(healthUrl, { method: 'GET' });
    } catch (err) {
      await sleepFn(HEALTH_POLL_MS);
      continue;
    }

    if (healthResponse.status === 200) {
      return { ok: true };
    }

    await sleepFn(HEALTH_POLL_MS);
  }
}

module.exports = {
  deploy: deploy,
  DEPLOY_REF_RE: DEPLOY_REF_RE
};