'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');

var LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

var currentRunId = null;
var currentRevisionId = null;
var currentLogLevel = 'info';
var logFilePath = null;

var SENSITIVE_KEYS = [
  'OPENROUTER_API_KEY',
  'api_key',
  'API_KEY',
  'secret',
  'password',
  'token'
];

// Exact-match allowlist for non-secret config keys.
// channelTokens / CHANNEL_TOKENS: the key is allowlisted so the key name is
// never redacted. Additionally, the four frozen channel token VALUES are
// allowlisted here — they are public channel identifiers confirmed non-secret
// by the client on 2 Oct 2026.  Key-name redaction still applies to actual
// secrets (password, api_key, token as substring, etc.).
var CHANNEL_KEY_ALLOWLIST = {
  'channelTokens': true,
  'CHANNEL_TOKENS': true
};

// Exact-match allowlist for the four frozen channel token values.
// These values are public channel identifiers, not secrets.
var CHANNEL_TOKEN_VALUE_ALLOWLIST = {
  'de-token': true,
  'at-token': true,
  'hu-token': true,
  'gb-token': true
};

function redactSensitiveValue(key, value) {
  if (!value || typeof value !== 'string') {
    return value;
  }
  // Exact-key allowlist: bypass key-name redaction for known non-secret keys
  if (CHANNEL_KEY_ALLOWLIST[key]) {
    return value;
  }
  // Exact-value allowlist: the four frozen channel token values are
  // public non-secret identifiers confirmed by the client on 2 Oct 2026.
  if (CHANNEL_TOKEN_VALUE_ALLOWLIST[value]) {
    return value;
  }
  for (var i = 0; i < SENSITIVE_KEYS.length; i++) {
    if (key.toLowerCase().includes(SENSITIVE_KEYS[i].toLowerCase())) {
      if (value.length > 8) {
        return value.substring(0, 4) + '****';
      }
      return '****';
    }
  }
  return value;
}

function redactSensitiveObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(function(item) { return redactSensitiveObject(item); });
  }
  var result = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = obj[key];
    if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveObject(value);
    } else {
      result[key] = redactSensitiveValue(key, value);
    }
  }
  return result;
}

function createLogEntry(level, event, message, extra) {
  var entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    runId: currentRunId || null,
    revisionId: currentRevisionId || null,
    event: event,
    message: message
  };

  if (extra) {
    var redactedExtra = redactSensitiveObject(extra);
    var extraKeys = Object.keys(redactedExtra);
    for (var i = 0; i < extraKeys.length; i++) {
      entry[extraKeys[i]] = redactedExtra[extraKeys[i]];
    }
  }

  return entry;
}

function writeLog(entry) {
  var jsonLine = JSON.stringify(entry) + '\n';

  if (logFilePath) {
    fs.appendFileSync(logFilePath, jsonLine, 'utf8');
  }

  var minLevel = LOG_LEVELS[currentLogLevel] || LOG_LEVELS.info;
  var entryLevel = LOG_LEVELS[entry.level.toLowerCase()] || LOG_LEVELS.info;
  if (entryLevel >= minLevel) {
    console.log(jsonLine.trim());
  }
}

function setLogContext(runId, revisionId) {
  currentRunId = runId;
  currentRevisionId = revisionId;
}

function setLogLevel(level) {
  if (LOG_LEVELS[level] !== undefined) {
    currentLogLevel = level;
  }
}

function setLogFile(filePath) {
  logFilePath = filePath;
}

function getLogFilePath() {
  return logFilePath;
}

function info(event, message, extra) {
  writeLog(createLogEntry('info', event, message, extra));
}

function warn(event, message, extra) {
  writeLog(createLogEntry('warn', event, message, extra));
}

function error(event, message, extra) {
  writeLog(createLogEntry('error', event, message, extra));
}

function debug(event, message, extra) {
  writeLog(createLogEntry('debug', event, message, extra));
}

function createLogger(moduleName) {
  return {
    info: function(event, message, extra) {
      info(moduleName + ':' + event, message, extra);
    },
    warn: function(event, message, extra) {
      warn(moduleName + ':' + event, message, extra);
    },
    error: function(event, message, extra) {
      error(moduleName + ':' + event, message, extra);
    },
    debug: function(event, message, extra) {
      debug(moduleName + ':' + event, message, extra);
    }
  };
}

function resetLogger() {
  currentRunId = null;
  currentRevisionId = null;
  logFilePath = null;
  currentLogLevel = 'info';
}

module.exports = {
  setLogContext: setLogContext,
  setLogLevel: setLogLevel,
  setLogFile: setLogFile,
  getLogFilePath: getLogFilePath,
  info: info,
  warn: warn,
  error: error,
  debug: debug,
  createLogger: createLogger,
  resetLogger: resetLogger,
  redactSensitiveValue: redactSensitiveValue,
  redactSensitiveObject: redactSensitiveObject
};