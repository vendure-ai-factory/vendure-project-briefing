'use strict';

var childProcess = require('child_process');
var path = require('path');
var loggerModule = require('../logger');

var DEFAULT_TIMEOUT_MS = 60000;

var ALLOWED_COMMANDS = {
  'node': true,
  'npm': true,
  'git': true
};

var allowedScriptPaths = {};

var workspaceRoot = null;

function setWorkspaceRoot(root) {
  workspaceRoot = root ? path.resolve(root) : null;
}

function registerAllowedScriptPath(scriptPath) {
  if (scriptPath && typeof scriptPath === 'string') {
    allowedScriptPaths[path.resolve(scriptPath)] = true;
  }
}

function getAllowedScriptPaths() {
  return Object.keys(allowedScriptPaths);
}

function isCommandAllowed(cmd) {
  if (ALLOWED_COMMANDS[cmd]) return true;
  var resolved = path.resolve(cmd);
  if (allowedScriptPaths[resolved]) return true;
  return false;
}

function isPathInsideWorkspace(targetPath) {
  if (!workspaceRoot) return false;
  var resolved = path.resolve(targetPath);
  if (resolved.startsWith(workspaceRoot + path.sep)) return true;
  if (resolved === workspaceRoot) return true;
  return false;
}

function rejectShellString(cmd, args) {
  var fullCmd = cmd + ' ' + (args || []).join(' ');
  if (/\&\&|\|\||\;|`|\$\(/.test(fullCmd)) {
    return true;
  }
  return false;
}

function runCommand(cmd, args, options) {
  options = options || {};
  var cwd = options.cwd || workspaceRoot || process.cwd();
  var timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  var logger = options.logger || null;

  if (rejectShellString(cmd, args)) {
    var reason = 'Shell operators detected in command; only plain execFile allowed';
    if (logger && logger.warn) {
      logger.warn('COMMAND_REJECTED', reason, { cmd: cmd, args: args });
    }
    return {
      success: false,
      error: reason,
      errorCode: 'SHELL_STRING_REJECTED',
      cmd: cmd,
      args: args
    };
  }

  if (!isCommandAllowed(cmd)) {
    var reason = 'Command not in allowlist: ' + cmd;
    if (logger && logger.warn) {
      logger.warn('COMMAND_REJECTED', reason, { cmd: cmd });
    }
    return {
      success: false,
      error: reason,
      errorCode: 'COMMAND_NOT_ALLOWED',
      cmd: cmd,
      args: args
    };
  }

  if (!isPathInsideWorkspace(cwd)) {
    var reason = 'Working directory is outside workspace boundary: ' + cwd;
    if (logger && logger.warn) {
      logger.warn('COMMAND_REJECTED', reason, { cmd: cmd, cwd: cwd });
    }
    return {
      success: false,
      error: reason,
      errorCode: 'CWD_OUTSIDE_WORKSPACE',
      cmd: cmd,
      args: args,
      cwd: cwd
    };
  }

  for (var i = 0; i < (args || []).length; i++) {
    var arg = args[i];
    if (typeof arg === 'string' && rejectShellString('', [arg])) {
      var reason = 'Shell operator detected in argument: ' + arg;
      if (logger && logger.warn) {
        logger.warn('COMMAND_REJECTED', reason, { cmd: cmd, args: args });
      }
      return {
        success: false,
        error: reason,
        errorCode: 'SHELL_STRING_REJECTED',
        cmd: cmd,
        args: args
      };
    }
  }

  var result = {
    success: false,
    cmd: cmd,
    args: args,
    cwd: cwd,
    timedOut: false
  };

  try {
    var stdout = '';
    var stderr = '';

    var proc = childProcess.spawn(cmd, args, {
      cwd: cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout
    });

    proc.stdout.on('data', function(chunk) {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', function(chunk) {
      stderr += chunk.toString();
    });

    var timedOut = false;
    var timeoutId = setTimeout(function() {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    var exitCode = null;
    var exitSignal = null;

    proc.on('close', function(code, signal) {
      clearTimeout(timeoutId);
      exitCode = code;
      exitSignal = signal;

      stdout = stdout.substring(0, 100000);
      stderr = stderr.substring(0, 100000);

      var redactedStdout = loggerModule.redactSensitiveObject({ output: stdout });
      var redactedStderr = loggerModule.redactSensitiveObject({ output: stderr });

      result.stdout = redactedStdout.output || '';
      result.stderr = redactedStderr.output || '';
      result.exitCode = exitCode;
      result.exitSignal = exitSignal;
      result.timedOut = timedOut;
      result.success = exitCode === 0 && !timedOut;
      result.error = !result.success ? ('exit code ' + exitCode) : null;

      if (logger && logger.debug) {
        logger.debug('COMMAND_COMPLETED', 'Command completed', {
          cmd: cmd,
          exitCode: exitCode,
          timedOut: timedOut
        });
      }
    });

    proc.on('error', function(err) {
      clearTimeout(timeoutId);

      var reason = 'Process error: ' + err.message;
      if (logger && logger.error) {
        logger.error('COMMAND_ERROR', reason, { cmd: cmd, error: err.message });
      }

      result.success = false;
      result.error = reason;
      result.errorCode = 'PROCESS_ERROR';
      result.stdout = '';
      result.stderr = '';
    });

  } catch (err) {
    result.success = false;
    result.error = 'Failed to spawn process: ' + err.message;
    result.errorCode = 'SPAWN_ERROR';
  }

  return result;
}

function runCommandSync(cmd, args, options) {
  options = options || {};
  var cwd = options.cwd || workspaceRoot || process.cwd();
  var timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  var logger = options.logger || null;

  if (rejectShellString(cmd, args)) {
    var reason = 'Shell operators detected in command; only plain execFile allowed';
    if (logger && logger.warn) {
      logger.warn('COMMAND_REJECTED', reason, { cmd: cmd, args: args });
    }
    return {
      success: false,
      error: reason,
      errorCode: 'SHELL_STRING_REJECTED',
      cmd: cmd,
      args: args
    };
  }

  if (!isCommandAllowed(cmd)) {
    var reason = 'Command not in allowlist: ' + cmd;
    if (logger && logger.warn) {
      logger.warn('COMMAND_REJECTED', reason, { cmd: cmd });
    }
    return {
      success: false,
      error: reason,
      errorCode: 'COMMAND_NOT_ALLOWED',
      cmd: cmd,
      args: args
    };
  }

  if (!isPathInsideWorkspace(cwd)) {
    var reason = 'Working directory is outside workspace boundary: ' + cwd;
    if (logger && logger.warn) {
      logger.warn('COMMAND_REJECTED', reason, { cmd: cmd, cwd: cwd });
    }
    return {
      success: false,
      error: reason,
      errorCode: 'CWD_OUTSIDE_WORKSPACE',
      cmd: cmd,
      args: args,
      cwd: cwd
    };
  }

  try {
    var stdout = childProcess.execFileSync(cmd, args, {
      cwd: cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout,
      maxBuffer: 10 * 1024 * 1024
    });

    var redacted = loggerModule.redactSensitiveObject({ output: stdout });
    return {
      success: true,
      stdout: redacted.output || '',
      stderr: '',
      exitCode: 0,
      cmd: cmd,
      args: args,
      cwd: cwd
    };
  } catch (err) {
    var redactedStderr = loggerModule.redactSensitiveObject({ output: err.stderr || '' });
    return {
      success: false,
      error: err.message,
      errorCode: 'EXEC_ERROR',
      stdout: '',
      stderr: redactedStderr.output || '',
      exitCode: err.status || 1,
      cmd: cmd,
      args: args,
      cwd: cwd
    };
  }
}

function clearAllowedScripts() {
  allowedScriptPaths = {};
}

module.exports = {
  setWorkspaceRoot: setWorkspaceRoot,
  registerAllowedScriptPath: registerAllowedScriptPath,
  getAllowedScriptPaths: getAllowedScriptPaths,
  isCommandAllowed: isCommandAllowed,
  isPathInsideWorkspace: isPathInsideWorkspace,
  rejectShellString: rejectShellString,
  runCommand: runCommand,
  runCommandSync: runCommandSync,
  ALLOWED_COMMANDS: ALLOWED_COMMANDS,
  clearAllowedScripts: clearAllowedScripts
};
