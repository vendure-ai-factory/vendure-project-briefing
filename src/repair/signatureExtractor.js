'use strict';

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');

var REDACTED_MARKER = '[REDACTED]';

// Config issues: classified as 'config' when the error message or evidence
// clearly indicates a misconfigured environment, wrong secret, bad env var,
// or similar — NOT from stack traces or SQL codes alone. Config errors that
// produce a stack trace (e.g. missing env var in source code) fall through to
// the stack-based heuristics above.  'config' is therefore reserved for
// messages whose primary signal is a bad configuration value or missing
// env/secret; it is NOT derived from the presence of a stack frame alone.

var REPO_ROOT = path.resolve(__dirname, '..', '..');

var DB_SQLSTATES_HARD = {
  '42P01': 'database',
  '42703': 'database',
  '23505': 'database',
  '23503': 'database'
};

var DB_SQLSTATES_SOFT = {
  '22P02': 'target-code',
  '42883': 'target-code'
};

var INFRA_PATTERNS = [
  { pattern: /ECONNREFUSED/i, domain: 'infrastructure' },
  { pattern: /ETIMEDOUT/i, domain: 'infrastructure' },
  { pattern: /ENOTFOUND|DNS/i, domain: 'infrastructure' },
  { pattern: /401\s+Unauthorized/i, domain: 'infrastructure' },
  { pattern: /403\s+Forbidden/i, domain: 'infrastructure' },
  { pattern: /\b5\d{2}\b/, domain: 'infrastructure' }
];

var GRAPHQL_PIPELINE_PATTERNS = [
  { pattern: /is not defined on type/i, domain: 'pipeline' },
  { pattern: /did you mean/i, domain: 'pipeline' },
  { pattern: /unknown field/i, domain: 'pipeline' },
  { pattern: /unknown argument/i, domain: 'pipeline' },
  { pattern: /unknown variable/i, domain: 'pipeline' },
  { pattern: /cannot be null on variable/i, domain: 'pipeline' },
  { pattern: /expected non-nullable type/i, domain: 'pipeline' }
];

var CLIENT_INPUT_PATTERNS = [
  { pattern: /missing required (?:input |argument |parameter )?(?:value|field)/i, domain: 'client-input' },
  { pattern: /missing credentials/i, domain: 'client-input' },
  { pattern: /missing registry/i, domain: 'client-input' },
  { pattern: /missing artifact/i, domain: 'client-input' }
];

function redactEmails(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED_MARKER);
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

var REPO_ROOT = path.resolve(__dirname, '..', '..');

function isPipelineFrame(filePath) {
  if (!filePath) {
    return false;
  }
  if (filePath.indexOf('node_modules') !== -1) {
    return false;
  }
  var normalized = filePath.replace(/\\/g, '/');
  // Resolve the frame against THIS repo's root. A bare relative path is
  // ambiguous (it originates from the target workspace), so it is never
  // attributed to this repo.
  var abs;
  if (normalized.startsWith('~/')) {
    abs = path.resolve(REPO_ROOT, normalized.slice(2));
  } else if (path.isAbsolute(normalized)) {
    abs = path.resolve(normalized);
  } else {
    return false;
  }
  var rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
  if (rel === '..' || rel.startsWith('../')) {
    return false;
  }
  if (rel.startsWith('src/repair/') || rel.startsWith('src/staging/')) {
    return true;
  }
  if (rel.startsWith('pipeline/') || rel.startsWith('bin/')) {
    return true;
  }
  if (/^src\/[^/]+\.js$/.test(rel)) {
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  return false;
}

function parseStackFrames(msg) {
  if (!msg || typeof msg !== 'string') {
    return [];
  }
  var lines = msg.split('\n');
  var frames = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var atMatch = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::\d+)?\)?\s*$/);
    if (atMatch) {
      frames.push({
        fn: atMatch[1] || null,
        file: atMatch[2] || null,
        line: parseInt(atMatch[3], 10) || null
      });
    }
  }
  return frames;
}

function decideDomain(sqlstate, apiErrors, logExcerpt) {
  var allText = '';
  if (Array.isArray(apiErrors)) {
    for (var i = 0; i < apiErrors.length; i++) {
      if (apiErrors[i] && typeof apiErrors[i] === 'object') {
        allText += ' ' + JSON.stringify(apiErrors[i]);
      }
    }
  }
  if (logExcerpt && typeof logExcerpt === 'string') {
    allText += ' ' + logExcerpt;
  }
  allText = allText.toLowerCase();

  if (sqlstate) {
    if (DB_SQLSTATES_HARD[sqlstate]) {
      return DB_SQLSTATES_HARD[sqlstate];
    }
    if (DB_SQLSTATES_SOFT[sqlstate]) {
      var frames = buildStackFromErrors(apiErrors);
      if (frames.length > 0) {
        for (var fi = 0; fi < frames.length; fi++) {
          var f = frames[fi];
          if (f.file) {
            if (f.file.includes('node_modules/')) {
              return 'dependency';
            }
            if (isPipelineFrame(f.file)) {
              return 'pipeline';
            }
          }
        }
        return 'target-code';
      }
      return 'target-code';
    }
  }

  for (var gp = 0; gp < GRAPHQL_PIPELINE_PATTERNS.length; gp++) {
    if (GRAPHQL_PIPELINE_PATTERNS[gp].pattern.test(allText)) {
      return GRAPHQL_PIPELINE_PATTERNS[gp].domain;
    }
  }

  for (var ci = 0; ci < CLIENT_INPUT_PATTERNS.length; ci++) {
    if (CLIENT_INPUT_PATTERNS[ci].pattern.test(allText)) {
      return CLIENT_INPUT_PATTERNS[ci].domain;
    }
  }

  for (var j = 0; j < INFRA_PATTERNS.length; j++) {
    if (INFRA_PATTERNS[j].pattern.test(allText)) {
      return INFRA_PATTERNS[j].domain;
    }
  }

  var frames2 = buildStackFromErrors(apiErrors);

  for (var m = 0; m < frames2.length; m++) {
    var f2 = frames2[m];
    if (f2.file) {
      if (f2.file.includes('node_modules/')) {
        return 'dependency';
      }
      if (isPipelineFrame(f2.file)) {
        return 'pipeline';
      }
    }
  }

  for (var n = 0; n < frames2.length; n++) {
    var fr = frames2[n];
    if (fr.file && !fr.file.includes('node_modules/') && !isPipelineFrame(fr.file)) {
      return 'target-code';
    }
  }

  return 'unknown';
}

function extractSqlstate(errors, logExcerpt) {
  if (Array.isArray(errors)) {
    for (var i = 0; i < errors.length; i++) {
      var err = errors[i];
      if (err && err.extensions && err.extensions.code) {
        var code = String(err.extensions.code).toUpperCase();
        if (/^[0-9A-Z]{5}$/.test(code)) {
          return code;
        }
      }
    }
  }
  if (logExcerpt && typeof logExcerpt === 'string') {
    var m = logExcerpt.match(/\b(22P02|42883|42703|42P01|23505|23503)\b/);
    if (m) {
      return m[1].toUpperCase();
    }
  }
  return null;
}

function parseApiErrorsIntegerMismatch(errors) {
  if (!Array.isArray(errors)) {
    return null;
  }
  var INTEGER_TYPE_PATTERN = /invalid input syntax for type integer: "(.*)"/;
  for (var i = 0; i < errors.length; i++) {
    var err = errors[i];
    if (!err || typeof err !== 'object') {
      continue;
    }
    var msg = err.message;
    if (typeof msg !== 'string') {
      continue;
    }
    var match = msg.match(INTEGER_TYPE_PATTERN);
    if (match) {
      var paramValue = match[1];
      var pathVal = null;
      if (err.path && Array.isArray(err.path)) {
        pathVal = err.path;
      } else if (err.path && typeof err.path === 'string') {
        pathVal = [err.path];
      }
      return { paramValue: paramValue, path: pathVal, message: msg };
    }
  }
  return null;
}

function parseLogExcerpt(logExcerpt) {
  if (!logExcerpt || typeof logExcerpt !== 'string') {
    return null;
  }
  var contextMatch = logExcerpt.match(/CONTEXT:\s*.*?unnamed portal parameter \$(\d+)/s);
  if (!contextMatch) {
    return null;
  }
  var paramIndex = parseInt(contextMatch[1], 10);
  var statementMatch = logExcerpt.match(/STATEMENT:\s*(.*)\s*$/s);
  if (!statementMatch) {
    return null;
  }
  var statement = statementMatch[1].trim();
  var conditionRegex = /((?:"[^"]*"|[\w.]+))\s*(!==|!=|<=|>=|!=|\b=\b|LIKE|ILIKE|NOT LIKE|NOT ILIKE)\s*\$\d+/g;
  var conditionMatch;
  while ((conditionMatch = conditionRegex.exec(statement)) !== null) {
    var fullMatch = conditionMatch[0];
    var dollarPos = fullMatch.indexOf('$');
    var extractedParamIndex = parseInt(fullMatch.substring(dollarPos + 1), 10);
    if (extractedParamIndex === paramIndex) {
      var columnRaw = conditionMatch[1].replace(/"/g, '');
      var columnParts = columnRaw.split('.');
      var column = columnParts.length > 1 ? columnParts[columnParts.length - 1] : columnRaw;
      var operator = conditionMatch[2];
      return { statement: statement, column: column, operator: operator, paramIndex: paramIndex };
    }
  }
  return { statement: statement, column: null, operator: null, paramIndex: paramIndex };
}

function normalizeForSignature(classifier, message, pathVal, sql) {
  var parts = [
    classifier || '',
    (message || '').replace(/".*?"/, '"<val>"'),
    pathVal ? pathVal.join('.') : ''
  ];
  if (sql && sql.column) {
    parts.push(sql.column);
    parts.push(sql.operator || '');
  }
  return parts.join('|');
}

function buildStackFromErrors(errors) {
  var frames = [];
  if (!Array.isArray(errors)) {
    return frames;
  }
  for (var i = 0; i < errors.length; i++) {
    var err = errors[i];
    if (!err || typeof err !== 'object') {
      continue;
    }
    if (err.extensions && err.extensions.exception && err.extensions.exception.stacktrace) {
      var st = err.extensions.exception.stacktrace;
      var stText = Array.isArray(st) ? st.join('\n') : String(st);
      var parsed = parseStackFrames(stText);
      for (var j = 0; j < parsed.length; j++) {
        frames.push(parsed[j]);
      }
    } else if (err.message && typeof err.message === 'string') {
      var fromMsg = parseStackFrames(err.message);
      for (var k = 0; k < fromMsg.length; k++) {
        frames.push(fromMsg[k]);
      }
    }
  }
  return frames;
}

function extractFinding(input) {
  if (!input || typeof input !== 'object') {
    return {
      signature: sha256Hex('UNKNOWN|unknown input'),
      class: 'UNKNOWN',
      message: null,
      path: null,
      sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: null },
      confidence: 'API_ONLY',
      notes: ['Invalid input: expected object with apiErrors, logExcerpt, operationName, and/or query fields'],
      domain: 'unknown',
      sqlstate: null,
      stack: []
    };
  }

  var apiErrors = Array.isArray(input.apiErrors) ? input.apiErrors : [];
  var logExcerpt = input.logExcerpt != null && typeof input.logExcerpt === 'string' ? input.logExcerpt : null;

  var notes = [];

  if (logExcerpt) {
    var redactedExcerpt = redactEmails(logExcerpt);
    if (redactedExcerpt !== logExcerpt) {
      notes.push('Email addresses redacted from logExcerpt');
    }
    logExcerpt = redactedExcerpt;
  }

  var sqlstate = extractSqlstate(apiErrors, logExcerpt);
  var domain = decideDomain(sqlstate, apiErrors, logExcerpt);
  var stack = buildStackFromErrors(apiErrors);

  var apiResult = parseApiErrorsIntegerMismatch(apiErrors);

  if (!apiResult) {
    return {
      signature: sha256Hex('UNKNOWN|no integer type mismatch found'),
      class: 'UNKNOWN',
      message: null,
      path: null,
      sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: null },
      confidence: 'API_ONLY',
      notes: notes.length > 0 ? notes : ['No recognizable integer type mismatch error found in apiErrors'],
      domain: domain,
      sqlstate: sqlstate,
      stack: stack
    };
  }

  var sqlInfo = null;
  var confidence = 'API_ONLY';
  if (logExcerpt) {
    sqlInfo = parseLogExcerpt(logExcerpt);
    if (sqlInfo) {
      confidence = 'WITH_SQL';
    } else {
      notes.push('logExcerpt present but could not parse SQL context');
    }
  }

  var sql = {
    statement: sqlInfo ? sqlInfo.statement : null,
    operator: sqlInfo ? sqlInfo.operator : null,
    column: sqlInfo ? sqlInfo.column : null,
    paramIndex: sqlInfo ? sqlInfo.paramIndex : null,
    paramValue: apiResult.paramValue
  };

  var normalized = normalizeForSignature('SQL_PARAM_TYPE', apiResult.message, apiResult.path, sql);
  var signature = sha256Hex(normalized);

  return {
    signature: signature,
    class: 'SQL_PARAM_TYPE',
    message: apiResult.message,
    path: apiResult.path,
    sql: sql,
    confidence: confidence,
    notes: notes,
    domain: domain,
    sqlstate: sqlstate,
    stack: stack
  };
}

module.exports = { extractFinding: extractFinding };
