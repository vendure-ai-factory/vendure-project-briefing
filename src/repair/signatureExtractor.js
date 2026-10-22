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
  { pattern: /gateway.*timeout|504\s+Gateway\s+Timeout/i, domain: 'infrastructure' },
  { pattern: /502\s+Bad\s+Gateway|503\s+Service\s+Unavailable/i, domain: 'infrastructure' }
];

var APP_LAYER_SQL_PATTERNS = [
  { pattern: /invalid input syntax for type (integer|decimal|numeric|real|double precision|smallint|bigint|boolean|date|time|timestamp)/i, domain: 'target-code' },
  { pattern: /operator does not exist/i, domain: 'target-code' },
  { pattern: /column ["'`\w.]+ does not exist/i, domain: 'database' },
  { pattern: /relation ["'`\w.]+ does not exist/i, domain: 'database' },
  { pattern: /permission denied for/i, domain: 'database' },
  { pattern: /duplicate key value violates unique constraint/i, domain: 'database' }
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

/**
 * Parse a single collected log line into a stack frame {file, line}.
 * Handles the two required shapes:
 *   - "at ... (<file>:<line>:<col>)" or "at <file>:<line>:<col>"
 *   - a bare "<file>:<line>:<col>" where <file> has a known source extension
 * Returns null when the line holds no frame.
 */
function parseLogLineFrame(line) {
  if (!line || typeof line !== 'string') return null;
  var m = line.match(/\bat\s+.*?\(?(\S+):(\d+):(\d+)\)?/);
  if (m) {
    return { file: m[1], line: parseInt(m[2], 10) };
  }
  m = line.match(/(^|[^\w).])([^\s()]+\.(?:js|mjs|ts|cjs)):(\d+)(?::\d+)?/);
  if (m) {
    return { file: m[2], line: parseInt(m[3], 10) };
  }
  return null;
}

var LOG_FRAME_WINDOW = 30;

/**
 * Parse stack frames from the collected log lines and keep only the ones
 * within a window around the error occurrence. `logLines` is accepted as an
 * array of strings (merged cross-kind by the caller) or as an object whose
 * values are arrays of strings. `errorText` (the task's own error text) anchors
 * the occurrence; falls back to the first error-level line when absent.
 */
function parseStackFramesFromLogs(logLines, errorText) {
  var all = [];
  if (Array.isArray(logLines)) {
    all = logLines.filter(function(l) { return typeof l === 'string' && l !== ''; });
  } else if (logLines && typeof logLines === 'object') {
    var kinds = Object.keys(logLines);
    for (var k = 0; k < kinds.length; k++) {
      var arr = logLines[kinds[k]];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        var l = arr[j];
        if (typeof l === 'string' && l !== '') all.push(l);
      }
    }
  }
  if (all.length === 0) return [];

  var anchor = -1;
  if (errorText && typeof errorText === 'string' && errorText !== '') {
    for (var a = 0; a < all.length; a++) {
      if (all[a].indexOf(errorText) !== -1) { anchor = a; break; }
    }
  }
  if (anchor === -1) {
    for (var b = 0; b < all.length; b++) {
      if (/(error|exception|failed|uncaught|fatal|thrown)/i.test(all[b])) { anchor = b; break; }
    }
  }

  var frames = [];
  for (var i = 0; i < all.length; i++) {
    var f = parseLogLineFrame(all[i]);
    if (!f) continue;
    if (anchor !== -1 && Math.abs(i - anchor) > LOG_FRAME_WINDOW) continue;
    frames.push({ fn: null, file: f.file, line: f.line });
  }
  return frames;
}

/**
 * Extract the package name from a node_modules path. Supports both unscoped
 * (node_modules/pkg/...) and scoped (node_modules/@scope/pkg/...) names.
 */
function packageFromNodeModulesPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  var m = filePath.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (!m) return null;
  var pkg = m[1].replace(/\\/g, '/');
  var segments = pkg.split('/');
  if (segments.length === 2) {
    return '@' + segments[0].replace(/^@/, '') + '/' + segments[1]; // scoped
  }
  return segments[0]; // unscoped
}

/**
 * Derive { domain, package } from a set of frames. Any node_modules frame wins
 * with domain 'dependency' plus its package name; otherwise target-source
 * frames map to 'target-code'. Returns null when no frame is usable (caller
 * must not override the domain then).
 */
function domainFromFrames(frames) {
  var usable = [];
  for (var i = 0; i < (frames || []).length; i++) {
    var f = frames[i];
    if (!f || !f.file) continue;
    var norm = String(f.file).replace(/\\/g, '/');
    if (norm.indexOf('node_modules/') !== -1) {
      return { domain: 'dependency', package: packageFromNodeModulesPath(norm) };
    }
    if (!isPipelineFrame(norm)) usable.push(norm);
  }
  if (usable.length > 0) {
    return { domain: 'target-code', package: null };
  }
  return null;
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

  for (var al = 0; al < APP_LAYER_SQL_PATTERNS.length; al++) {
    if (APP_LAYER_SQL_PATTERNS[al].pattern.test(allText)) {
      return APP_LAYER_SQL_PATTERNS[al].domain;
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

/**
 * Strip a leading docker-compose container prefix (e.g. 'vendure-db-1  | ')
 * from each line so the Postgres CONTEXT/STATEMENT regexes see the raw log
 * line. No-op for lines without the prefix.
 */
function stripContainerPrefix(line) {
  if (!line || typeof line !== 'string') {
    return line;
  }
  // Match a container name followed by one or more spaces, '|', and space(s).
  var m = line.match(/^\S+\s*\|\s?(.*)$/);
  return m ? m[1] : line;
}

function stripContainerPrefixAll(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  return text.split('\n').map(stripContainerPrefix).join('\n');
}

function parseLogExcerpt(logExcerpt) {
  if (!logExcerpt || typeof logExcerpt !== 'string') {
    return null;
  }
  // Docker-compose prefixes the log lines with '<container> | '. Strip that
  // prefix from every line so the timestamp/severity-anchored regexes below
  // see a plain Postgres log entry, otherwise the STATEMENT capture swallows
  // the following prefixed lines (they no longer start with YYYY-MM-DD).
  logExcerpt = stripContainerPrefixAll(logExcerpt);
  // Find all CONTEXT with unnamed portal parameter $N (optional = 'value').
  // Postgres emits both "unnamed portal parameter $N" and
  // "unnamed portal parameter $N = 'value'". Prefer the LAST context in the
  // excerpt, which (after error-window selection) is the error's own entry.
  var contextRegex = /CONTEXT:\s*unnamed portal parameter \$(\d+)(?:\s*=\s*'([^']*)')?/g;
  var contextMatches = [];
  var cm;
  while ((cm = contextRegex.exec(logExcerpt)) !== null) {
    contextMatches.push({ after: contextRegex.lastIndex, paramIndex: parseInt(cm[1], 10), paramValue: cm[2] || null });
  }
  if (contextMatches.length === 0) {
    return null;
  }
  var lastCtx = contextMatches[contextMatches.length - 1];
  var paramIndex = lastCtx.paramIndex;
  // Find the STATEMENT after that CONTEXT: capture until the next timestamp
  // line (YYYY-MM-DD), a blank line, or end, without swallowing later entries.
  var rest = logExcerpt.substring(lastCtx.after);
  var statementMatch = rest.match(/STATEMENT:\s*([\s\S]*?)(?=^\d{4}-\d{2}-\d{2}\b|\n\s*\n|$)/m);
  if (!statementMatch) {
    return null;
  }
  var statement = statementMatch[1].trim();
  // Extract the condition that references the specific parameter $N:
  // "<table>"."<col>" != $N style, handling quoted and plain identifiers.
  var condRegex = new RegExp('("(?:[^"]|"")+"(?:\\.\\"[^"]+\\")*|"[^"]+"|[\\w.]+)\\s*(!==|!=|>=|<=|LIKE|ILIKE|NOT LIKE|NOT ILIKE|=)\\s*\\$' + paramIndex + '(?!\\d)', 'g');
  var condMatch;
  while ((condMatch = condRegex.exec(statement)) !== null) {
    var colRaw = condMatch[1].replace(/"/g, '');
    var colParts = colRaw.split('.');
    var column = colParts.length > 1 ? colParts[colParts.length - 1] : colRaw;
    var operator = condMatch[2].trim();
    var truncStmt = statement.length > 300 ? statement.substring(0, 300) + '...' : statement;
    truncStmt = truncStmt.replace(/'[^']*'/g, '<val>').replace(/(?<!\$)\b\d+\b/g, '<val>');
    return { statement: truncStmt, column: column, operator: operator, paramIndex: paramIndex };
  }
  return null;
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
      operationName: null,
      rootFields: [],
      sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: null },
      confidence: 'API_ONLY',
      notes: ['Invalid input: expected object with apiErrors, logExcerpt, operationName, and/or query fields'],
      domain: 'unknown',
      sqlstate: null,
      package: null,
      stack: []
    };
  }

  var apiErrors = Array.isArray(input.apiErrors) ? input.apiErrors : [];
  var logExcerpt = input.logExcerpt != null && typeof input.logExcerpt === 'string' ? input.logExcerpt : null;
  var rawLogLines = input.logLines != null && typeof input.logLines === 'object' ? input.logLines : [];
  var operationName = input.operationName && typeof input.operationName === 'string' ? input.operationName : null;
  var rootFields = Array.isArray(input.rootFields) ? input.rootFields.map(function(x) { return String(x); }) : [];

  var notes = [];

  if (logExcerpt) {
    var redactedExcerpt = redactEmails(logExcerpt);
    if (redactedExcerpt !== logExcerpt) {
      notes.push('Email addresses redacted from logExcerpt');
    }
    logExcerpt = redactedExcerpt;
  }

  // Baseline classification from structured signals (apiErrors + sqlstate).
  var sqlstate = extractSqlstate(apiErrors, logExcerpt);
  var domain = decideDomain(sqlstate, apiErrors, logExcerpt);
  var stack = buildStackFromErrors(apiErrors);
  var packageName = null;

  // Log-derived stack frames override the classification only when frames are
  // actually present. A node_modules frame sets domain 'dependency' plus the
  // package (scoped names supported); a target-source frame sets 'target-code'.
  var errText = '';
  if (apiErrors[0] && typeof apiErrors[0].message === 'string') errText = apiErrors[0].message;
  var logFrames = parseStackFramesFromLogs(rawLogLines, errText);
  if (logFrames.length > 0) {
    var merged = stack.slice();
    for (var lf = 0; lf < logFrames.length; lf++) {
      var dup = merged.some(function(ex) { return ex && ex.file === logFrames[lf].file && ex.line === logFrames[lf].line; });
      if (!dup) merged.push(logFrames[lf]);
    }
    stack = merged;
    var frameDomain = domainFromFrames(logFrames);
    if (frameDomain && frameDomain.domain) {
      domain = frameDomain.domain;
      packageName = frameDomain.package || null;
    }
  }

  var apiResult = parseApiErrorsIntegerMismatch(apiErrors);

  if (!apiResult) {
    return {
      signature: sha256Hex('UNKNOWN|no integer type mismatch found'),
      class: 'UNKNOWN',
      message: null,
      path: null,
      operationName: operationName,
      rootFields: rootFields,
      sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: null },
      confidence: 'API_ONLY',
      notes: notes.length > 0 ? notes : ['No recognizable integer type mismatch error found in apiErrors'],
      domain: domain,
      sqlstate: sqlstate,
      package: packageName,
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
    operationName: operationName,
    rootFields: rootFields,
    sql: sql,
    confidence: confidence,
    notes: notes,
    domain: domain,
    sqlstate: sqlstate,
    package: packageName,
    stack: stack
  };
}

module.exports = {
  extractFinding: extractFinding,
  parseLogExcerpt: parseLogExcerpt,
  parseStackFramesFromLogs: parseStackFramesFromLogs,
  packageFromNodeModulesPath: packageFromNodeModulesPath,
  domainFromFrames: domainFromFrames,
  DOMAIN_DECISION_TABLE: {
    rules: [
      { order: 1,  name: 'sqlstate-hard',   condition: 'sqlstate in DB_SQLSTATES_HARD',       domain: 'DB_SQLSTATES_HARD[sqlstate]', blocked: true },
      { order: 2,  name: 'sqlstate-soft',   condition: 'sqlstate in DB_SQLSTATES_SOFT',         domain: 'target-code (or dependency/pipeline from stack)', blocked: false },
      { order: 3,  name: 'graphql-pipeline',condition: 'GraphQL schema/query error patterns',  domain: 'pipeline',                          blocked: false },
      { order: 4,  name: 'client-input',    condition: 'missing required/input/credential',   domain: 'client-input',                       blocked: true  },
      { order: 5,  name: 'app-layer-sql',   condition: 'SQL param type/syntax/constraint in GraphQL error', domain: 'target-code or database', blocked: false },
      { order: 6,  name: 'infrastructure',  condition: 'ECONNREFUSED/ETIMEDOUT/ENOTFOUND/401/403/504/502/503 Gateway', domain: 'infrastructure', blocked: true },
      { order: 7,  name: 'stack-node_modules',condition: 'stack frame in node_modules/',       domain: 'dependency',                         blocked: false },
      { order: 8,  name: 'stack-pipeline', condition: 'stack frame in src/repair/ or src/staging/', domain: 'pipeline',                     blocked: false },
      { order: 9,  name: 'stack-src-file', condition: 'stack frame in src/*.js (target repo)', domain: 'target-code',                        blocked: false },
      { order: 10, name: 'fallback',       condition: 'no match',                             domain: 'unknown',                            blocked: false }
    ],
    fallback: {
      domain: 'unknown',
      blocked: false,
      note: 'unknown must NOT be blocked without a model call; repair loop proceeds to log collection'
    },
    infra_scope: 'infrastructure is assigned ONLY for: ECONNREFUSED, ETIMEDOUT, ENOTFOUND/DNS, TLS handshake, HTTP 502/503/504 from gateway, container/OOM kill, disk full. SQL/Postgres type/syntax/constraint errors in GraphQL are application-layer (target-code when no migration/schema evidence, database when schema/constraint evidence exists).'
  }
};
