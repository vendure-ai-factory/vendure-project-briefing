'use strict';

var crypto = require('crypto');

var REDACTED_MARKER = '[REDACTED]';

function redactEmails(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED_MARKER);
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
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
      var path = null;
      if (err.path && Array.isArray(err.path)) {
        path = err.path;
      } else if (err.path && typeof err.path === 'string') {
        path = [err.path];
      }
      return { paramValue: paramValue, path: path, message: msg };
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

function normalizeForSignature(classifier, message, path, sql) {
  var parts = [
    classifier || '',
    (message || '').replace(/".*?"/, '"<val>"'),
    path ? path.join('.') : ''
  ];
  if (sql && sql.column) {
    parts.push(sql.column);
    parts.push(sql.operator || '');
  }
  return parts.join('|');
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
      notes: ['Invalid input: expected object with apiErrors, logExcerpt, operationName, and/or query fields']
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

  var apiResult = parseApiErrorsIntegerMismatch(apiErrors);

  if (!apiResult) {
    return {
      signature: sha256Hex('UNKNOWN|no integer type mismatch found'),
      class: 'UNKNOWN',
      message: null,
      path: null,
      sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: null },
      confidence: 'API_ONLY',
      notes: notes.length > 0 ? notes : ['No recognizable integer type mismatch error found in apiErrors']
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
    notes: notes
  };
}

module.exports = { extractFinding: extractFinding };
