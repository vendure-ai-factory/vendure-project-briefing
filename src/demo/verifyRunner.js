'use strict';

var childProcess = require('child_process');
var path = require('path');
var loggerModule = require('../logger');

var DEFAULT_TIMEOUT_MS = 120000;
var ALLOWED_ENV_VARS = ['PATH', 'HOME', 'NODE_ENV'];

function checkPermissionModelAvailable() {
  try {
    var result = childProcess.spawnSync('node', ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    return result.status === 0 || result.status === null;
  } catch (err) {
    return false;
  }
}

var permissionModelAvailable = false; // verify.mjs needs spawnSync (child-process); --permission blocks that

function buildRestrictedEnv() {
  var env = {};
  for (var i = 0; i < ALLOWED_ENV_VARS.length; i++) {
    var key = ALLOWED_ENV_VARS[i];
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function runVerify(workspaceRoot, options) {
  options = options || {};
  var timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  var logger = options.logger || null;
  var commandOverride = options.commandOverride || null;

  var verifyScript = path.join(workspaceRoot, 'evaluation-demo', 'scripts', 'verify.mjs');

  var restrictedEnv = buildRestrictedEnv();

  var nodeArgs = [];
  if (permissionModelAvailable && !commandOverride) {
    nodeArgs.push('--permission', '--allow-fs-read=*', '--allow-fs-write=*');
  }

  var useShell = !!commandOverride;
  if (commandOverride) {
    nodeArgs.push.apply(nodeArgs, commandOverride);
  } else {
    nodeArgs.push(verifyScript, '--acceptance');
  }

  var cmd = useShell ? nodeArgs[0] : process.execPath;
  var args = useShell ? nodeArgs.slice(1) : nodeArgs;

  var startTime = Date.now();

  var result = {
    command: cmd + ' ' + args.join(' '),
    cwd: workspaceRoot,
    timeout: timeout,
    permissionModelUsed: permissionModelAvailable,
    permissionModelUnavailable: !permissionModelAvailable,
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    duration: null,
    outcome: null
  };

  try {
    var proc = childProcess.spawn(cmd, args, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout,
      env: restrictedEnv,
      shell: useShell
    });

    var stdout = '';
    var stderr = '';

    proc.stdout.on('data', function(chunk) {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', function(chunk) {
      stderr += chunk.toString();
    });

    var exitCode = null;
    var timedOut = false;
    var timeoutId = setTimeout(function() {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.on('close', function(code, signal) {
      clearTimeout(timeoutId);
      exitCode = code;

      var duration = Date.now() - startTime;
      var truncatedStdout = stdout.substring(0, 500000);
      var truncatedStderr = stderr.substring(0, 500000);

      var redactedStdout = loggerModule.redactSensitiveObject({ output: truncatedStdout });
      var redactedStderr = loggerModule.redactSensitiveObject({ output: truncatedStderr });

      result.exitCode = exitCode;
      result.stdout = redactedStdout.output || '';
      result.stderr = redactedStderr.output || '';
      result.timedOut = timedOut;
      result.duration = duration;

      if (timedOut) {
        result.outcome = 'INFRASTRUCTURE_FAULT';
      } else if (exitCode === 0) {
        result.outcome = 'passed';
      } else if (exitCode === 1) {
        result.outcome = 'acceptance_failed';
      } else {
        result.outcome = 'INFRASTRUCTURE_FAULT';
      }

      if (logger && logger.debug) {
        logger.debug('VERIFY_COMPLETED', 'Verify run completed', {
          exitCode: exitCode,
          outcome: result.outcome,
          timedOut: timedOut,
          duration: duration
        });
      }
    });

    proc.on('error', function(err) {
      clearTimeout(timeoutId);
      var duration = Date.now() - startTime;
      result.exitCode = -1;
      result.stderr = err.message;
      result.timedOut = false;
      result.duration = duration;
      result.outcome = 'INFRASTRUCTURE_FAULT';

      if (logger && logger.error) {
        logger.error('VERIFY_ERROR', 'Verify run failed: ' + err.message, { error: err.message });
      }
    });

  } catch (err) {
    var duration = Date.now() - startTime;
    result.exitCode = -1;
    result.stderr = err.message;
    result.timedOut = false;
    result.duration = duration;
    result.outcome = 'INFRASTRUCTURE_FAULT';
  }

  return result;
}

function isPermissionModelAvailable() {
  return permissionModelAvailable;
}

module.exports = {
  runVerify: runVerify,
  isPermissionModelAvailable: isPermissionModelAvailable,
  buildRestrictedEnv: buildRestrictedEnv,
  ALLOWED_ENV_VARS: ALLOWED_ENV_VARS,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
};
