'use strict';

import { createRequire } from 'node:module';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// R5b exit codes. 0 = FIXED or no repair needed; 3 = NOT_FIXED (repair budget
// exhausted while a target defect remains); 4 = BLOCKED (an adapter refused,
// never retried by another route). These are distinct from run-staging codes
// (the repair orchestrator is its own entry point and documents its own codes).
export const EXIT_NO_REPAIR = 0;
export const EXIT_FIXED = 0;
export const EXIT_NOT_FIXED = 3;
export const EXIT_BLOCKED = 4;

export const OUTCOME_NO_REPAIR = 'NO_REPAIR';
export const OUTCOME_FIXED = 'FIXED';
export const OUTCOME_NOT_FIXED = 'NOT_FIXED';
export const OUTCOME_BLOCKED = 'BLOCKED';

// The authorized staging task set. "rerun the same tasks plus CAN-B2-16" is
// exactly this set because the normal staging run already executes them.
export const REPAIR_TASK_IDS = ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16'];

const CLASS_TARGET_APP_DEFECT = 'TARGET_APP_DEFECT';
const CLASS_CLIENT_INPUT_SCOPE = 'CLIENT_INPUT_SCOPE';

const MANIFEST_PATH = 'manifest/acceptance-manifest.v0.4.json';
const DEFAULT_ARCHIVE_ROOT = '/opt/pipeline-archive';
const REPORTS_DIR = 'reports';
const EVIDENCE_DIR = 'evidence';

var _manifest = null;
function getManifest(cwd) {
  if (_manifest === null) {
    try {
      _manifest = JSON.parse(fs.readFileSync(path.join(cwd, MANIFEST_PATH), 'utf8'));
    } catch (e) {
      _manifest = { tasks: [], source: {} };
    }
  }
  return _manifest;
}

function hasText(v) {
  return v != null && String(v) !== '';
}

function isPassResult(v) {
  return v === 'PASS' || v === 'RESULT_PASS' || v === 'READINESS_PASS';
}

function sanitizeToken(v) {
  return v === undefined || v === null ? '' : String(v);
}

function generateRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function collectSecretValues(cfg) {
  var values = [];
  function push(v) {
    if (v != null && typeof v === 'string' && v !== '') values.push(v);
  }
  push(cfg.token);
  push(cfg.apiKey);
  if (cfg.env) {
    ['STRIPE_SECRET_KEY', 'VENDURE_STAGING_REPO_TOKEN', 'OPENROUTER_API_KEY',
      'STAGING_ADMIN_PASSWORD', 'SUPERADMIN_PASSWORD', 'SEED_TEST_CUSTOMER_PASSWORD'
    ].forEach(function(name) { push(cfg.env[name]); });
  }
  return values;
}

function redactOutput(text, values) {
  var out = String(text == null ? '' : text);
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v && typeof v === 'string' && out.indexOf(v) !== -1) {
      out = out.split(v).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Build the fix branch for a finding. The git binding derives the branch from
 * the run id and the first 8 hex chars of the finding signature, matching the
 * fix-branch contract enforced by gitClient (codex/pipeline-fix-<runId>-<sig8>).
 */
function buildFixBranch(runId, finding) {
  var sig8 = (finding && finding.signature ? String(finding.signature) : 'unknown').substring(0, 8);
  var cleaned = String(runId || 'run').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  if (cleaned === '' || cleaned === '-') cleaned = 'run';
  return 'codex/pipeline-fix-' + cleaned + '-' + sig8;
}

function defaultRunCommand(cmd, args, opts) {
  var childProcess = require('node:child_process');
  return Promise.resolve().then(function() {
    var result = childProcess.spawnSync(cmd, args, {
      cwd: opts && opts.cwd,
      env: opts && opts.env,
      timeout: (opts && opts.timeout) || 120000,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error && result.status === null && result.signal === null) {
      return { success: false, stdout: '', stderr: String(result.error.message || result.error), exitCode: null, error: result.error.message };
    }
    return {
      success: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status,
      error: null
    };
  });
}

/**
 * Resolve the repair configuration. Repair mode is strictly opt-in: it is
 * enabled only when REPAIR_MODE=true (or an injected true boolean for tests).
 * Normal runs never take this path and never touch any adapter.
 */
function resolveRepairConfig(deps) {
  deps = deps || {};
  var env = deps.env || process.env;
  var modeValue = deps.repairMode !== undefined && deps.repairMode !== null
    ? deps.repairMode
    : (env.REPAIR_MODE === 'true' || env.REPAIR_MODE === '1' || env.REPAIR_MODE === true);
  var runId = deps.runId || env.REPAIR_RUN_ID || null;
  return {
    repairMode: !!modeValue,
    env: env,
    cwd: deps.cwd || process.cwd(),
    childProcess: deps.childProcess || require('node:child_process'),
    fs: deps.fs || fs,
    fetch: deps.fetch || globalThis.fetch,
    runId: runId,
    taskIds: (deps.taskIds && deps.taskIds.length > 0) ? deps.taskIds.slice() : REPAIR_TASK_IDS.slice(),
    token: sanitizeToken(deps.token !== undefined ? deps.token : env.VENDURE_STAGING_REPO_TOKEN),
    apiKey: sanitizeToken(deps.apiKey !== undefined ? deps.apiKey : env.OPENROUTER_API_KEY),
    stagingUrl: hasText(deps.stagingUrl) ? String(deps.stagingUrl)
      : (hasText(env.PIPELINE_STAGING_URL) ? env.PIPELINE_STAGING_URL : null),
    shopApiUrl: hasText(deps.shopApiUrl) ? String(deps.shopApiUrl)
      : (hasText(env.PIPELINE_SHOP_API_URL) ? env.PIPELINE_SHOP_API_URL : null),
    archiveRoot: hasText(deps.archiveRoot) ? String(deps.archiveRoot)
      : (env.PIPELINE_ARCHIVE_ROOT || DEFAULT_ARCHIVE_ROOT),
    targetRepoUrl: deps.targetRepoUrl || 'https://github.com/vendure-ai-factory/vendure-staging-baseline',
    workDir: deps.workDir || null,
    runCommand: deps.runCommand || defaultRunCommand,
    // Adapters: all injectable, all defaulting to the real implementations.
    adapters: deps.adapters || {},
    replayer: deps.replayer || null,
    rerunTasks: deps.rerunTasks || null,
    extractAfter: deps.extractAfter || null,
    normalRun: deps.normalRun || null,
    budget: deps.budget || null,
    globalBudget: deps.globalBudget || 15,
    perSignatureBudget: deps.perSignatureBudget || 3
  };
}

/**
 * Collect every diagnostic string that can describe a task failure. Mirrors
 * the staging classifier's problem-text gathering so an unmet task's real
 * error is visible even when the cause is only a generic token.
 */
function taskErrorText(t) {
  if (!t || typeof t !== 'object') return '';
  var parts = [];
  function push(v) {
    if (typeof v === 'string' && v !== '') parts.push(v);
    else if (v && typeof v === 'object' && typeof v.message === 'string' && v.message !== '') parts.push(v.message);
  }
  push(t.cause);
  push(t.result);
  push(t.reason);
  push(t.error);
  push(t.message);
  push(t.detail);
  if (t.exitErrorResult && typeof t.exitErrorResult === 'object') {
    push(t.exitErrorResult.error);
    push(t.exitErrorResult.message);
  }
  if (Array.isArray(t.errors)) {
    for (var i = 0; i < t.errors.length; i++) push(t.errors[i]);
  }
  ['executorError', 'executorOutput', 'stderr', 'stdout'].forEach(function(f) { push(t[f]); });
  return parts.join('|');
}

/**
 * A task is a repair target when it is still unmet (not a passing result) and
 * it is either classed TARGET_APP_DEFECT or carries an API error string.
 */
function isRepairTarget(t) {
  if (!t || typeof t !== 'object') return false;
  if (isPassResult(t.result)) return false;
  if (t.classification === CLASS_TARGET_APP_DEFECT) return true;
  return taskErrorText(t) !== '';
}

function selectRepairTargets(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(isRepairTarget);
}

/**
 * Collect logs for the three supported kinds since the run started. A log
 * wrapper refusal is recorded on state.logBlockers and does NOT stop the
 * finding extraction from API errors.
 */
async function collectRepairLogs(cfg, logSource, state) {
  var kinds = ['vendure', 'postgres', 'worker'];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    try {
      var result = await logSource.collect(kind, {
        runId: cfg.runId,
        sinceTs: state.runStartedAt,
        cwd: cfg.cwd
      });
      if (result && result.ok === true) {
        // Log lines may be an array of strings, one big string, or absent. Coerce
        // any shape into an array of strings without throwing.
        state.logs[kind] = toArrayLines(result.lines);
      } else if (result && result.blocker) {
        state.logBlockers.push(normalizeBlocker('LOG_WRAPPER_REFUSED',
          'log source refused for ' + kind, result.blocker));
      } else {
        state.logBlockers.push(normalizeBlocker('LOG_WRAPPER_REFUSED',
          'log source returned no output for ' + kind, result || {}));
      }
    } catch (err) {
      state.logBlockers.push(normalizeBlocker('LOG_WRAPPER_REFUSED',
        'log source collection failed for ' + kind, { message: safeErr(err) }));
    }
  }
  return state.logBlockers;
}

/**
 * Parse a GraphQL query string and extract the operation name and root field names.
 * Returns { operationName, rootFields } where rootFields is an array of field names
 * at the top level of the query (e.g., ['activeChannel', 'products']).
 */
function parseGraphQlQuery(queryBody) {
  if (!queryBody || typeof queryBody !== 'string') {
    return { operationName: null, rootFields: [] };
  }
  var operationName = null;
  var rootFields = [];
  // Match: query OperationName { ... } or mutation OperationName(...) { ... }
  // Also handles anonymous queries: { rootField { ... } }
  var nameMatch = queryBody.match(/^\s*(?:query|mutation)\s+(\w+)/);
  if (nameMatch) {
    operationName = nameMatch[1];
  }
  // Find the first { that starts the selection set
  var bracePos = queryBody.indexOf('{');
  if (bracePos !== -1) {
    var selectionSet = queryBody.substring(bracePos + 1);
    // Find the matching closing brace by counting nesting level
    var depth = 1;
    var endPos = 0;
    for (var i = 0; i < selectionSet.length; i++) {
      if (selectionSet[i] === '{') depth++;
      else if (selectionSet[i] === '}') {
        depth--;
        if (depth === 0) { endPos = i; break; }
      }
    }
    var inner = selectionSet.substring(0, endPos);
    // Extract root field names: each field starts with an identifier followed by
    // either a space, (, or { (but not a nested { which would be a fragment)
    var fieldRegex = /(\w+)\s*(?:[({]|\.|\?|\:)/g;
    var fieldMatch;
    while ((fieldMatch = fieldRegex.exec(inner)) !== null) {
      var fname = fieldMatch[1];
      // Skip keywords that might appear as field names
      if (fname !== 'query' && fname !== 'mutation' && fname !== 'subscription' &&
          fname !== 'fragment' && fname !== 'on' && fname !== 'true' && fname !== 'false' && fname !== 'null' &&
          fname !== 'undefined' && !/^\d/.test(fname)) {
        if (rootFields.indexOf(fname) === -1) {
          rootFields.push(fname);
        }
      }
    }
  }
  return { operationName: operationName, rootFields: rootFields };
}

/**
 * Extract the GraphQL operation name and root fields from the task's own
 * request evidence (evidence/<runId>/<taskId>/shop-api-requests.json).
 * Returns { operationName, rootFields } where operationName may be null
 * (caller must NOT use taskId as fallback).
 */
function getGraphQlInfoFromEvidence(cfg, taskId) {
  if (!cfg || !cfg.cwd || !cfg.runId || !taskId) {
    return { operationName: null, rootFields: [] };
  }
  try {
    var evidencePath = path.join(cfg.cwd, 'evidence', cfg.runId, taskId, 'shop-api-requests.json');
    var content = cfg.fs.readFileSync(evidencePath, 'utf8');
    var data = JSON.parse(content);
    var rawRequests = data && Array.isArray(data.rawRequests) ? data.rawRequests : [];
    if (rawRequests.length === 0) {
      return { operationName: null, rootFields: [] };
    }
    // Use the last request (most recent) that has a query body
    var lastWithQuery = null;
    for (var i = rawRequests.length - 1; i >= 0; i--) {
      var req = rawRequests[i];
      if (req && req.body && typeof req.body === 'string' && req.body.trim().length > 0) {
        // Check if it's a JSON body with a query property
        try {
          var parsed = JSON.parse(req.body);
          if (parsed.query) {
            lastWithQuery = parsed;
            break;
          }
        } catch (e) {
          // Not JSON, treat the body itself as the query
          lastWithQuery = { query: req.body };
          break;
        }
      }
    }
    if (!lastWithQuery || !lastWithQuery.query) {
      return { operationName: null, rootFields: [] };
    }
    return parseGraphQlQuery(lastWithQuery.query);
  } catch (e) {
    return { operationName: null, rootFields: [] };
  }
}

/**
 * Find a window of log lines around an error. Groups postgres multi-line
 * entries (ERROR / CONTEXT / STATEMENT / DETAIL) into entries, finds the last
 * entry matching the error message, and returns a window around it.
 * Returns the concatenated log string capped at maxLength.
 */
/**
 * Strip common container/timestamp/PID prefixes from a log line so keywords
 * like ERROR/CONTEXT/STATEMENT become detectable regardless of the runner's
 * log format:
 *   - docker/compose "name-1  | "
 *   - ISO / "[2026-...]" timestamps
 *   - "LOG:" / PID tags
 *   - JSON log lines with msg/message fields
 * Returns the "payload" portion after any prefix.
 */
function stripLogPrefix(line) {
  if (!line || typeof line !== 'string') return '';
  var out = line;
  // JSON log line (e.g. {"time":...,"level":"error","msg":"ERROR: ..."})
  if (out.trim().charAt(0) === '{') {
    try {
      var parsed = JSON.parse(out);
      var msg = parsed && (parsed.msg !== undefined ? parsed.msg
        : (parsed.message !== undefined ? parsed.message : null));
      if (typeof msg === 'string') out = msg;
      else if (parsed && parsed.err) out = '';
    } catch (e) { /* not JSON */ }
  }
  // Docker/compose prefix: "name-1  | " or "name-1|"
  out = out.replace(/^[a-zA-Z0-9_.-]+(\s*)?\|\s*/, '');
  // Timestamps: ISO (2026-10-21T12:34:56.789Z), bracket [2026-...], and
  // the YYYY-MM-DD HH:MM:SS[.mmm] UTC-less forms. A year of 9999 is the
  // masked placeholder from maskLogPayload and must never be re-stripped.
  out = out.replace(/^(?!9999-)\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z| UTC| [A-Z]+)?\s+/, '');
  out = out.replace(/^\[(?!9999-)\d{4}-\d{2}-\d{2}[ T][^\]]*\]\s*/, '');
  out = out.replace(/^(?!9999(?=\s))[\d:.]+\s+/, ''); // bare HH:MM:SS.iii
  // PID tag: "2026-... [12345] " or "[12345] " or "PID 12345"
  out = out.replace(/\[(\d+)\]\s*/, '');
  out = out.replace(/^PID\s+\d+\s*/, '');
  // Level/log tag
  out = out.replace(/^(LOG|INFO|WARN|WARNING|NOTICE|ERROR|FATAL|DEBUG|PANIC):\s*/, function(chunk, kw) {
    // Preserve the keyword (lower risk of breaking CONTEXT/STATEMENT that is
    // not prefixed by "LOG:"). Keep it only if it is a real severity label.
    return kw + ': ';
  });
  return out;
}

/**
 * Mask a log payload into a shape that reveals format/structure without
 * exposing literal values. Each alphanumeric run is replaced by a token of the
 * same length class: all-digits -> 999... ("9"), all-alpha -> AAA... ("A"),
 * mixed -> X... ("X"); punctuation is kept; the keywords
 * ERROR/CONTEXT/STATEMENT/DETAIL/LOG/PANIC/HINT are preserved verbatim; an ISO
 * timestamp collapses to 9999-99-99T99:99:99.
 *
 * NOTE: This function is DEPRECATED. Use maskSecretsOnly instead for
 * targeted redaction that preserves operators, $N markers, and keywords.
 */
function maskLogPayload(line) {
  if (!line || typeof line !== 'string') return '';
  var s = line;
  var restores = [];
  // Protect timestamps behind a non-alphanumeric marker so the run-masker
  // below can never perturb the masked placeholder shape, then restore the
  // canonical masked form afterwards.
  s = s.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z| UTC)?/g, function() {
    restores.push('9999-99-99T99:99:99');
    return '\u0000';
  });
  s = s.replace(/^\[\d{4}-\d{2}-\d{2}[ T][^\]]*\]\s*/, function() {
    restores.push('[9999-99-99T99:99:99]');
    return '\u0000';
  });
  s = s.replace(/^[\d:.]+(?=\s)/, function() {
    restores.push('9999');
    return '\u0000';
  });
  // Mask alphanumeric runs, preserving punctuation and keywords.
  s = s.replace(/[A-Za-z0-9]+/g, function(m) {
    var up = m.toUpperCase();
    if (up === 'ERROR' || up === 'CONTEXT' || up === 'STATEMENT' || up === 'DETAIL' ||
        up === 'LOG' || up === 'PANIC' || up === 'HINT' || up === 'NOTICE' || up === 'FATAL') {
      return m;
    }
    var digitRun = /^[0-9]+$/.test(m);
    var alphaRun = /^[a-zA-Z]+$/.test(m);
    var ch = digitRun ? '9' : (alphaRun ? 'A' : 'X');
    return ch.repeat(m.length);
  });
  // Restore masked timestamp placeholders in order of appearance.
  var out = '';
  var ri = 0;
  for (var ci = 0; ci < s.length; ci++) {
    if (s.charCodeAt(ci) === 0) {
      out += (ri < restores.length) ? restores[ri++] : '';
    } else {
      out += s[ci];
    }
  }
  return out;
}

/**
 * Targeted redaction of secrets only: API tokens, emails, passwords, long
 * hex/base64, and testing secrets (canary values). Also masks ISO timestamps
 * to preserve evidence anonymity (9999-99-99T99:99:99 format). Preserves
 * keywords (ERROR/CONTEXT/STATEMENT/DETAIL/HINT/LOG/PANIC/FATAL/NOTICE),
 * operators (!=, LIKE, etc.), $N parameter markers, table/column names.
 */
function maskSecretsOnly(line) {
  if (!line || typeof line !== 'string') return '';
  var s = line;

  // Mask ISO timestamps to canonical placeholder (for evidence anonymity)
  // Note: timestamps may already be stripped by stripLogPrefix, but we try both formats
  s = s.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d+/g, '9999-99-99T99:99:99');
  s = s.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g, '9999-99-99T99:99:99');
  // Mask bracketed timestamps
  s = s.replace(/^\[\d{4}-\d{2}-\d{2}[ T][^\]]*\]/, '[9999-99-99T99:99:99]');

  // Redact long hex strings (24+ hex chars = likely tokens)
  s = s.replace(/([0-9a-fA-F]{24,})/gi, function(m) {
    return 'TOKEN_' + 'X'.repeat(Math.min(m.length, 8));
  });

  // Redact base64-like strings (24+ chars with base64 chars)
  s = s.replace(/([A-Za-z0-9+/]{32,}={0,2})/g, function(m) {
    if (m.length >= 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(m)) {
      return 'B64_' + 'X'.repeat(8);
    }
    return m;
  });

  // Redact API tokens: sk-, ghp_, gho_, github_pat_, Bearer xxx, api_key=, secret=
  s = s.replace(/(sk-)[A-Za-z0-9_\\-]{20,}/g, '$1XXXX');
  s = s.replace(/(ghp_)[A-Za-z0-9\\-]{20,}/g, '$1XXXX');
  s = s.replace(/(gho_)[A-Za-z0-9\\-]{20,}/g, '$1XXXX');
  s = s.replace(/(github_pat_)[A-Za-z0-9_\\-]{20,}/g, '$1XXXX');
  s = s.replace(/(Bearer )[A-Za-z0-9_\\-]{20,}/gi, '$1XXXX');
  s = s.replace(/(api[_-]?key["\s:=]+)[A-Za-z0-9_\\-]{10,}/gi, '$1XXXX');
  s = s.replace(/(secret[_-]?key["\s:=]+)[A-Za-z0-9_\\-]{10,}/gi, '$1XXXX');
  s = s.replace(/(password["\s:=]+)[^\s,;]+/gi, '$1XXXX');
  s = s.replace(/(token["\s:=]+)[^\s,;]+/gi, '$1XXXX');

  // Redact email addresses
  s = s.replace(/[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\.[A-Za-z]{2,}/g, 'EMAIL_REDACTED');

  // Redact UUIDs (standard format)
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID_REDACTED');

  // Redact strings that look like database connection URLs with credentials
  s = s.replace(/(postgresql:\/\/)[^@]+@/gi, '$1USER:PASSWORD@');

  // Redact testing secrets: mixed-case alphanum with numbers, 12+ chars
  // This catches CANARY-type test values that should not appear in evidence
  // e.g. "SUP3rS3cr3tT0k3nXYZ789" -> "TEST_SECRET"
  s = s.replace(/"([A-Za-z0-9]{12,})"/g, function(m, val) {
    if (val.length >= 12 && /^[A-Za-z0-9]+$/.test(val) && /[0-9]/.test(val)) {
      return '"TEST_SECRET"';
    }
    return m;
  });
  s = s.replace(/'([A-Za-z0-9]{12,})'/g, function(m, val) {
    if (val.length >= 12 && /^[A-Za-z0-9]+$/.test(val) && /[0-9]/.test(val)) {
      return "'TEST_SECRET'";
    }
    return m;
  });

  return s;
}

/**
 * Extract ERROR context lines: up to 3 lines following an ERROR line that
 * contain '!=' or '$N' (parameter marker). Returns array of context lines,
 * each capped at 300 chars with secrets redacted.
 */
function extractErrorContextLines(allLines, maxContext) {
  maxContext = maxContext || 3;
  var contextLines = [];
  for (var i = 0; i < allLines.length; i++) {
    var line = String(allLines[i] || '');
    var stripped = stripLogPrefix(line);
    // Found an ERROR line - collect following lines with != or $N
    if (/^ERROR\b/.test(stripped)) {
      for (var j = i + 1; j < allLines.length && contextLines.length < maxContext; j++) {
        var nextLine = String(allLines[j] || '');
        var nextStripped = stripLogPrefix(nextLine);
        // Stop if we hit another ERROR or severity marker
        if (/^(ERROR|PANIC|FATAL|LOG|NOTICE|STATEMENT|CONTEXT|DETAIL|HINT|WARN)\b/.test(nextStripped)) {
          break;
        }
        // Include if contains != or $N parameter marker
        if (nextStripped.indexOf('!=') !== -1 || /\$[0-9]+/.test(nextStripped)) {
          var masked = maskSecretsOnly(stripLogPrefix(nextLine));
          if (masked.length > 300) masked = masked.substring(0, 300) + '...';
          contextLines.push(masked);
        }
      }
    }
  }
  return contextLines;
}

/**
 * Produce the per-kind masked log-shape diagnostics object. For each kind:
 * lineCount, the first 3 lines, and parameterLines (up to 5 lines matching the
 * findingMessage, or `undefined` when no match), each capped at 300 chars with
 * secrets redacted. Also includes errorContextLines: up to 3 lines following
 * each ERROR line that contain '!=' or '$N' parameter markers.
 */
function buildLogShape(logs, findingMessage) {
  var kinds = ['postgres', 'vendure', 'worker'];
  var shape = { kinds: {}, generatedAt: new Date().toISOString(), masked: true };
  for (var ki = 0; ki < kinds.length; ki++) {
    var kind = kinds[ki];
    var lines = (logs && Array.isArray(logs[kind])) ? logs[kind].map(String) : [];
    var first3 = lines.slice(0, 3).map(function(l) { return stripLogPrefix(maskSecretsOnly(l)); });
    var info = {
      lineCount: lines.length,
      first3Lines: first3,
      parameterLines: undefined,
      errorContextLines: undefined
    };
    // Up to 5 lines matching the finding message (or ERROR keyword), capped
    // at 300 chars each, secrets redacted using targeted maskSecretsOnly.
    var matched = [];
    for (var i = 0; i < lines.length && matched.length < 5; i++) {
      var raw = String(lines[i] || '');
      var payload = stripLogPrefix(raw);
      var isMatch = payload.indexOf('ERROR') !== -1 ||
        (findingMessage && payload.indexOf(findingMessage) !== -1);
      if (isMatch) {
        var masked = stripLogPrefix(maskSecretsOnly(raw));
        if (masked.length > 300) masked = masked.substring(0, 300) + '...';
        matched.push(masked);
      }
    }
    if (matched.length > 0) {
      info.parameterLines = matched;
    }
    // Extract ERROR context lines: up to 3 lines following each ERROR that
    // contain '!=' or '$N' parameter markers (used by parseLogExcerpt)
    var errorContext = extractErrorContextLines(lines, 3);
    if (errorContext.length > 0) {
      info.errorContextLines = errorContext;
    }
    shape.kinds[kind] = info;
  }
  return shape;
}

/**
 * Find a window of log lines around an error. Groups multi-line postgres
 * entries (ERROR / CONTEXT / STATEMENT / DETAIL), tolerating docker/compose,
 * ISO/bracket timestamps, "LOG:" tags and PID prefixes, and finds the entry
 * matching the finding's message (not assuming the first entry). Returns the
 * concatenated log string capped at maxLength.
 */
function buildLogExcerptWithWindow(allLines, findingMessage, maxLength) {
  maxLength = maxLength || 20000;
  if (!allLines || allLines.length === 0) {
    return null;
  }
  // Group lines into entries. A new postgres entry starts when a stripped line
  // begins with ERROR/CONTEXT/STATEMENT/DETAIL/LOG/other severity, or carries a
  // leading timestamp after prefix stripping.
  var entries = [];
  var currentEntry = [];
  for (var i = 0; i < allLines.length; i++) {
    var line = allLines[i];
    if (!line || typeof line !== 'string') {
      if (currentEntry.length > 0) { entries.push(currentEntry.join('\n')); currentEntry = []; }
      continue;
    }
    var stripped = stripLogPrefix(line);
    var leadingTimestamp = /^\d{4}-\d{2}-\d{2}|^\[\d{4}-\d{2}-\d{2}/.test(stripped);
    var severityStart = /^(ERROR|PANIC|FATAL|LOG|NOTICE|STATEMENT|CONTEXT|DETAIL|HINT)\b/.test(stripped) ||
      /^[A-Z]{3,}:/.test(stripped);
    if ((leadingTimestamp || severityStart) && currentEntry.length > 0) {
      entries.push(currentEntry.join('\n'));
      currentEntry = [line];
    } else {
      currentEntry.push(line);
    }
  }
  if (currentEntry.length > 0) {
    entries.push(currentEntry.join('\n'));
  }
  if (entries.length === 0) {
    return null;
  }
  var targetPattern = findingMessage || '';
  var bestIndex = -1;
  var bestScore = 0;
  for (var j = entries.length - 1; j >= 0; j--) {
    var entry = entries[j];
    if (!entry) continue;
    var eStripped = stripLogPrefix(entry);
    var score = 0;
    if (/^ERROR/.test(eStripped)) score += 10;
    if (targetPattern && eStripped.indexOf(targetPattern) !== -1) score += 6;
    if (/invalid input syntax/.test(eStripped)) score += 4;
    if (/22P02|42883|42P01/.test(eStripped)) score += 3;
    if (/unnamed portal parameter/.test(eStripped)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = j;
    }
  }
  // Fall back to newest entry if no positive match scored.
  if (bestIndex === -1) bestIndex = entries.length - 1;

  var windowRadius = 20;
  var startIdx = Math.max(0, bestIndex - windowRadius);
  var endIdx = Math.min(entries.length - 1, bestIndex + windowRadius);
  var windowEntries = [];
  for (var k = startIdx; k <= endIdx; k++) {
    windowEntries.push(entries[k]);
  }
  var excerpt = windowEntries.join('\n');
  if (excerpt.length > maxLength) {
    excerpt = excerpt.substring(0, maxLength);
  }
  return excerpt;
}

/**
 * Build the input for signatureExtractor from the target task. The API errors
 * array comes from the task's own record error text (never from logs), so a
 * log blocker can never stop extraction.
 *
 * operationName is the GraphQL operation name when it can be parsed from the
 * task's own request evidence. The taskId is NEVER used as operationName -
 * task ids are pipeline-internal and must not leak into search patterns.
 */
function buildExtractInput(cfg, target, logs) {
  var apiErrors = [];
  var errText = taskErrorText(target);
  if (errText !== '') {
    apiErrors.push({ message: errText, path: null, extensions: { code: 'BAD_USER_INPUT' } });
  }
  var logExcerpt = null;
  var logLines = logs || {};
  var allLines = [];
  ['postgres', 'vendure', 'worker'].forEach(function(k) {
    if (Array.isArray(logLines[k])) {
      allLines = allLines.concat(logLines[k]);
    }
  });
  // Extract GraphQL operation name from task's own request evidence.
  // This is the authoritative source - never use taskId as operationName.
  var operationName = null;
  var rootFields = [];
  if (target && target.taskId && cfg) {
    var gqlInfo = getGraphQlInfoFromEvidence(cfg, target.taskId);
    if (gqlInfo.operationName) {
      operationName = gqlInfo.operationName;
    }
    rootFields = gqlInfo.rootFields || [];
  }
  // Fall back to exitErrorResult.apiErrors if present
  if (!operationName) {
    if (target && typeof target.operationName === 'string' && target.operationName !== '') {
      operationName = target.operationName;
    } else if (target && target.exitErrorResult && target.exitErrorResult.apiErrors != null) {
      try {
        var first = Array.isArray(target.exitErrorResult.apiErrors) ? target.exitErrorResult.apiErrors[0] : null;
        if (first && typeof first.operationName === 'string' && first.operationName !== '') {
          operationName = first.operationName;
        }
      } catch (e) { /* ignore */ }
    }
  }
  // Build log excerpt with error windowing instead of first 20000 chars
  if (allLines.length > 0) {
    logExcerpt = buildLogExcerptWithWindow(allLines, errText, 20000);
  }
  return {
    apiErrors: apiErrors,
    logLines: allLines,
    logExcerpt: logExcerpt,
    operationName: operationName,
    rootFields: rootFields,
    // Note: taskId is deliberately NOT included here - callers must NOT use it as operationName
    taskId: target && target.taskId ? target.taskId : null
  };
}

function safeErr(e) {
  if (!e) return 'unknown error';
  return (e && e.message) ? e.message : String(e);
}

/**
 * Coerce a log source's lines value (array of strings, one big string, or
 * abstract/missing) into an array of strings. Never throws.
 */
function toArrayLines(lines) {
  if (lines == null) return [];
  if (Array.isArray(lines)) return lines.map(function(l) { return l == null ? '' : String(l); });
  if (typeof lines === 'string') {
    return lines.split('\n').filter(function(l) { return l !== ''; });
  }
  return [String(lines)];
}

/**
 * Write finding evidence to evidence/<runId>/repair/finding.json BEFORE any
 * blocker return. Records counts and byte sizes of logs per kind (no content).
 * Safe to call multiple times; only writes when finding is present.
 */
function writeFindingEvidence(cfg, state) {
  if (!cfg || !cfg.runId || !state || !state.finding) return;
  var f = state.finding;
  var logsInfo = {};
  var kinds = ['postgres', 'vendure', 'worker'];
  for (var k = 0; k < kinds.length; k++) {
    var kind = kinds[k];
    var lines = state.logs && Array.isArray(state.logs[kind]) ? state.logs[kind] : [];
    var totalBytes = 0;
    for (var i = 0; i < lines.length; i++) totalBytes += lines[i] ? lines[i].length : 0;
    logsInfo[kind] = { count: lines.length, bytes: totalBytes };
  }
  var sql = (f && f.sql && typeof f.sql === 'object') ? f.sql : null;
  var findingJson = {
    class: f.class || null,
    domain: f.domain || null,
    message: f.message || null,
    path: f.path || null,
    operation_name: f.operationName || null,
    sqlstate: f.sqlstate || null,
    signature: f.signature || null,
    confidence: f.confidence || null,
    sql: sql ? {
      operator: sql.operator || null,
      column: sql.column || null,
      paramIndex: sql.paramIndex || null,
      paramValue: sql.paramValue || null,
      statement: sql.statement || null
    } : null,
    logs_collected_per_kind: logsInfo
  };
  try {
    var evidenceDir = path.join(cfg.cwd, EVIDENCE_DIR, cfg.runId, 'repair');
    cfg.fs.mkdirSync(evidenceDir, { recursive: true });
    cfg.fs.writeFileSync(
      path.join(evidenceDir, 'finding.json'),
      JSON.stringify(findingJson, null, 2) + '\n',
      'utf8'
    );
    // Masked per-kind log-shape diagnostics. Never carries literal log values.
    try {
      cfg.fs.writeFileSync(
        path.join(evidenceDir, 'log-shape.json'),
        JSON.stringify(buildLogShape(state.logs, f.message), null, 2) + '\n',
        'utf8'
      );
    } catch (e2) {
      // best-effort: never throw from the shape writer
    }
  } catch (e) {
    // best-effort: never throw from evidence writing
  }
}

/**
 * Write attempt-level exception to evidence/<runId>/repair/attempt-error.json.
 * Called from the REPAIR_ATTEMPT_ERROR catch handler before the blocker is recorded.
 * Writes: {errorName, message, stack (stackToString, truncated), phase}.
 * Message and stack are redacted for env secrets and email addresses.
 */
function writeAttemptError(cfg, err, phase) {
  if (!cfg || !cfg.runId) return;
  try {
    var evidenceDir = path.join(cfg.cwd, EVIDENCE_DIR, cfg.runId, 'repair');
    cfg.fs.mkdirSync(evidenceDir, { recursive: true });
    var stackLib = require('../src/repair/coerce.js');
    var redactMod = require('../src/repair/verifier.js');
    var secretValues = collectSecretValues(cfg);
    function redactAll(text) {
      var out = redactMod.redactSecrets(text, secretValues);
      out = redactMod.redactEmails(out);
      return out;
    }
    var errObj = {
      errorName: err && err.name ? err.name : 'Error',
      message: redactAll(err && err.message ? err.message : String(err || 'unknown')),
      stack: redactAll(stackLib.stackToString(err && err.stack, 2000)),
      phase: phase || 'unknown'
    };
    cfg.fs.writeFileSync(
      path.join(evidenceDir, 'attempt-error.json'),
      JSON.stringify(errObj, null, 2) + '\n',
      'utf8'
    );
  } catch (e) {
    // best-effort: never throw from evidence writing
  }
}

/**
 * Normalize an arbitrary adapter refusal into the blocker record shape
 * ({ code, message, evidence }) used by the report. The evidence is
 * redacted in-memory so a token or key can never be persisted.
 */
function normalizeBlocker(code, message, raw) {
  var redacted = {};
  if (raw && typeof raw === 'object') {
    try {
      redacted = JSON.parse(JSON.stringify(raw));
    } catch (e) {
      redacted = { raw: String(raw) };
    }
  } else if (raw != null) {
    redacted = { message: String(raw) };
  }
  return { code: code || 'UNKNOWN_BLOCKER', message: message || '', evidence: redacted };
}

function defaultReplayer(finding) {
  var signatures = [];
  if (finding && finding.signature) {
    signatures.push(finding.signature);
  }
  if (finding && Array.isArray(finding.auxSignatures)) {
    for (var i = 0; i < finding.auxSignatures.length; i++) {
      if (signatures.indexOf(finding.auxSignatures[i]) === -1) {
        signatures.push(finding.auxSignatures[i]);
      }
    }
  }
  return { signatures: signatures };
}

/**
 * Duration deadline that bounds the whole repair loop in wall-clock terms so a
 * misbehaving adapter can never run forever. Defaults to 6 hours.
 */
function defaultDeadline(now, maxMs) {
  return now() + (maxMs || 6 * 60 * 60 * 1000);
}

function readJsonFile(cfg, relPath) {
  try {
    var abs = path.join(cfg.cwd, relPath);
    if (!cfg.fs.existsSync(abs)) return null;
    return JSON.parse(cfg.fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return null;
  }
}

function newestRunSubdir(cfg, base) {
  var root = path.join(cfg.cwd, base);
  if (!cfg.fs.existsSync(root)) return null;
  var entries;
  try {
    entries = cfg.fs.readdirSync(root);
  } catch (e) {
    return null;
  }
  var newest = null;
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(root, entries[i]);
    var st = null;
    try { st = cfg.fs.statSync(full); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    if (!newest || st.mtimeMs > newest.mtime) newest = { name: entries[i], mtime: st.mtimeMs };
  }
  return newest ? newest.name : null;
}

/** Resolve the normal run id: injected, env, or the newest staging run. */
function resolveRunId(cfg) {
  if (cfg.runId) return cfg.runId;
  return newestRunSubdir(cfg, REPORTS_DIR) || newestRunSubdir(cfg, EVIDENCE_DIR) || null;
}

/**
 * Load the normal run's task rows. An injected normalRun wins; otherwise the
 * run summary (reports/<runId>/run-summary.json) is read. The summary rows
 * already carry classification/cause and (via runStage's record attach) the
 * task record error text the repair targets are selected from.
 */
function loadNormalRun(cfg, runId) {
  if (Array.isArray(cfg.normalRun)) return { runId: runId, tasks: cfg.normalRun };
  if (cfg.normalRun && Array.isArray(cfg.normalRun.tasks)) return cfg.normalRun;
  var summary = readJsonFile(cfg, path.join(REPORTS_DIR, runId, 'run-summary.json'));
  if (!summary) return null;
  var tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || typeof t !== 'object') continue;
    var taskId = t.taskId || t.id;
    if (!taskId) continue;
    attachTaskRecordError(cfg, runId, taskId, t);
  }
  return { runId: runId, tasks: tasks, summary: summary };
}

function attachTaskRecordError(cfg, runId, taskId, task) {
  var rec = readJsonFile(cfg, path.join(EVIDENCE_DIR, runId, taskId, 'record.json'));
  if (rec && rec.exitErrorResult && typeof rec.exitErrorResult === 'object') {
    task.exitErrorResult = rec.exitErrorResult;
    return;
  }
  var ex = readJsonFile(cfg, path.join(EVIDENCE_DIR, runId, taskId, 'executor-error.json'));
  if (ex) {
    var msg = ex && typeof ex.error === 'string' ? ex.error : (ex && ex.message) || null;
    if (msg) task.exitErrorResult = { exitCode: null, error: msg };
  }
}

/**
 * Default location: run the target clone through gitClient.cloneTarget (token
 * from env) then locateCandidates over the clone. Any refusal is returned as
 * a blocker and stops the whole repair run (BLOCKED).
 */
async function defaultCloneAndLocate(cfg, adapters, finding) {
  var branch = buildFixBranch(cfg.runId, finding);
  var dir = cfg.workDir
    ? path.join(cfg.workDir, 'repair-clone-' + cfg.runId + '-' + String(finding.signature || 'n/a').substring(0, 8))
    : path.join(require('node:os').tmpdir(), 'repair-clone-' + cfg.runId + '-' + String(finding.signature || 'n/a').substring(0, 8));
  var git = adapters.gitClient;
  var absent = [cfg.targetRepoUrl, branch, dir, cfg.token].some(function(v) { return !hasText(v); });
  var clone = absent ? { ok: false, blocker: normalizeBlocker('MISSING_GIT_INPUT', 'git clone input incomplete', {}) } : null;
  if (!clone) {
    clone = await git.cloneRepoForRepair({
      repoUrl: cfg.targetRepoUrl,
      branch: branch,
      dir: dir,
      token: cfg.token,
      runCommand: cfg.runCommand,
      timeout: 120000
    });
  }
  if (!clone || !clone.ok) {
    var b = clone && clone.blocker ? clone.blocker : { code: 'CLONE_FAILED', message: 'git clone failed' };
    return { ok: false, blocker: b, branch: branch };
  }
  var located = await adapters.locator.locateCandidates({
    finding: finding,
    targetRoot: dir,
    runId: cfg.runId,
    workspaceDir: path.dirname(dir),
    evidenceRoot: path.join(cfg.cwd, EVIDENCE_DIR),
    maxCandidates: 10
  });
  return { ok: true, dir: dir, branch: branch, candidates: (located && located.candidates) || [], searched: (located && located.searched) || [] };
}

/**
 * Default rerun: execute the authorized task stages in-process through
 * run-staging's runStage (the small change that exposes it), then read the
 * updated run summary. Injected fakes replace this in tests.
 */
async function defaultRerunTasks(cfg, taskIds) {
  var staging = await import('./run-staging.mjs');
  var stages = staging.buildStagesForTaskIds(taskIds || REPAIR_TASK_IDS);
  var outcomes = [];
  if (typeof staging.runStage === 'function') {
    for (var i = 0; i < stages.length; i++) {
      try {
        outcomes.push(staging.runStage(cfg, stages[i]));
      } catch (e) {
        outcomes.push({ name: stages[i].name, exitCode: 127, classification: 'PIPELINE_DEFECT', cause: safeErr(e) });
      }
    }
  }
  var tasks = [];
  for (var j = 0; j < outcomes.length; j++) {
    var s = outcomes[j];
    if (s && s.summary && Array.isArray(s.summary.tasks)) {
      tasks = tasks.concat(s.summary.tasks);
    }
  }
  return tasks;
}

/**
 * Default after-signature extraction: fingerprint every still-unmet task's API
 * error text with the same signatureExtractor used for the baseline, so the
 * verifier can compare like-for-like.
 */
function defaultExtractAfter(cfg, signExtractor, taskResults) {
  var sigs = new Set();
  for (var i = 0; i < (taskResults || []).length; i++) {
    var t = taskResults[i];
    if (!t || isPassResult(t.result)) continue;
    var errText = taskErrorText(t);
    if (errText === '') continue;
    var f = signExtractor.extractFinding({ apiErrors: [{ message: errText, path: null }], operationName: t.taskId || null });
    if (f && f.signature) sigs.add(f.signature);
  }
  return Array.from(sigs);
}

/**
 * Build repairData for reportGenerator (schema 1.1). manualTargetEdits is
 * always 0: the orchestrator itself never touches the target clone - all
 * mutations go through gitClient and the patch applier inside proposeAndCheck.
 */
function buildRepairData(state) {
  return {
    sectionA: { pipelineChanges: (state.pipelineChanges || []).slice() },
    sectionB: { targetChanges: (state.targetChanges || []).slice() },
    attempts: (state.attempts || []).map(function(a) {
      return Object.assign({}, a);
    }),
    blockers: (state.blockers || []).map(function(b) {
      return { code: b.code, message: b.message, evidence: b.evidence };
    }),
    deploy: state.deploy || null,
    rollback: state.rollback || null,
    manualTargetEdits: 0
  };
}

/**
 * Write the repair block (schema 1.1) through the existing report path only:
 * generateReport with repairMode, then compliance-report.json/.md under
 * reports/<runId>/. Nothing under evidence/ is written or modified here;
 * evidence/<runId>/index.json is only ever touched by the existing code.
 */
function writeRepairReport(cfg, state, reportModule) {
  var repairData = buildRepairData(state);
  var secrets = {};
  ['token', 'apiKey'].forEach(function(k) {
    if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '') secrets[k] = cfg[k];
  });
  var opts = {
    root: cfg.cwd,
    baseDir: 'evidence',
    repairMode: true,
    repairData: repairData,
    manifest: getManifest(cfg.cwd),
    secrets: secrets
  };
  if (reportModule === undefined) reportModule = require('../src/reportGenerator.js');
  var report = reportModule.generateReport(cfg.runId, opts);
  var outDir = path.join(cfg.cwd, REPORTS_DIR, cfg.runId);
  try {
    cfg.fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    outDir = path.join(cfg.cwd, 'repair-reports', cfg.runId);
    cfg.fs.mkdirSync(outDir, { recursive: true });
  }
  try {
    cfg.fs.writeFileSync(path.join(outDir, 'compliance-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    cfg.fs.writeFileSync(path.join(outDir, 'compliance-report.md'), reportModule.renderMarkdownReport(report, opts), 'utf8');
  } catch (e) {
    state.reportError = safeErr(e);
  }
  state.report = report;
  state.repairData = repairData;
  return report;
}

/**
 * Return a redacted copy of the outcome so the CLI and tests can render it
 * without ever leaking a token or API key.
 */
function redactRepairState(cfg, state) {
  var values = collectSecretValues(cfg);
  var out = {
    outcome: state.outcome,
    exitCode: state.exitCode,
    runId: cfg.runId,
    blockers: (state.blockers || []).map(function(b) {
      return {
        code: b.code,
        message: redactOutput(b.message, values),
        evidence: redactOutput(JSON.stringify(b.evidence), values)
      };
    })
  };
  if (state.logBlockers && state.logBlockers.length > 0) {
    out.logBlockers = state.logBlockers.map(function(b) {
      return { code: b.code, message: redactOutput(b.message, values) };
    });
  }
  if (state.report) {
    try {
      out.report = JSON.parse(redactOutput(JSON.stringify({ repair: state.report.repair }), values));
    } catch (e) {
      out.report = null;
    }
  }
  return out;
}

/**
 * Roll back a failed deploy to the baseline digest. When the baseline cannot
 * be resolved the rollback record stays "rollback unavailable" (a recorded
 * fact, never a silent hole).
 */
async function rollbackToBaseline(cfg, adapters, build) {
  var baseline = await adapters.build.baselineDigest({ token: cfg.token, fetch: cfg.fetch });
  if (!baseline || !baseline.ok || !baseline.deployRef) {
    return { ok: false, reason: 'rollback unavailable', blocker: baseline && baseline.blocker ? baseline.blocker : null };
  }
  var deploy = await adapters.deploy.deploy(baseline.deployRef, {
    healthUrl: cfg.stagingUrl ? cfg.stagingUrl + '/health' : null,
    runCommand: cfg.runCommand,
    fetch: cfg.fetch
  });
  if (!deploy.ok) {
    return { ok: false, reason: 'rollback blocked', blocker: deploy.blocker };
  }
  return { ok: true, ref: baseline.deployRef };
}

function defaultAdapters() {
  return {
    logSource: require('../src/repair/logSource.js'),
    signatureExtractor: require('../src/repair/signatureExtractor.js'),
    verifier: require('../src/repair/verifier.js'),
    gitClient: require('../src/repair/gitClient.js'),
    locator: require('../src/repair/locator.js'),
    build: require('../src/repair/buildAdapter.js'),
    deploy: require('../src/repair/deployAdapter.js'),
    proposeAndCheck: require('../src/repair/proposeAndCheck.js')
  };
}

/**
 * One loop iteration: propose a candidate patch (proposeAndCheck), then on
 * READY push the branch, build and publish the image, deploy, rerun the
 * authorized tasks, extract the after-signatures and verify against the
 * baseline. Returns { next: 'continue'|'stop-fixed'|'stop-blocked'|'stop-budget',
 * attempt, attemptNumber } or { error }.
 */
async function proposeAttempt(cfg, adapters, state, located, attemptNumber, budget) {
  var proposeModule = adapters.proposeAndCheck;
  var proposeFn = typeof proposeModule.proposeAndCheck === 'function'
    ? proposeModule.proposeAndCheck
    : proposeModule;
  var propose = await proposeFn({
    finding: state.finding,
    candidates: located.candidates || [],
    searched: located.searched || [],
    previousAttempts: state.previousAttempts,
    budget: budget,
    runId: cfg.runId,
    cloneDir: located.dir,
    branch: located.branch,
    baseSha: state.baseSha || null,
    attemptNumber: attemptNumber,
    env: cfg.env,
    deps: {
      git: adapters.gitClient,
      verifier: adapters.verifier,
      fetch: cfg.fetch
    }
  });

  if (!propose || typeof propose !== 'object') {
    writeFindingEvidence(cfg, state);
    return { next: 'stop-blocked', blocker: normalizeBlocker('PROPOSE_FAILED', 'proposeAndCheck returned no result', {}) };
  }

  if (propose.status === 'BUDGET_EXHAUSTED') {
    return { next: 'stop-budget', blocker: propose.blocker || null };
  }
  if (propose.status === 'BLOCKED') {
    writeFindingEvidence(cfg, state);
    return { next: 'stop-blocked', blocker: propose.blocker || normalizeBlocker('BLOCKED', 'proposeAndCheck blocked', {}) };
  }
  if (propose.status === 'MODEL_FAILED') {
    // Model unavailable (or an unusable model response) is a terminal blocker,
    // never retried by another route.
    writeFindingEvidence(cfg, state);
    return { next: 'stop-blocked', blocker: propose.blocker || normalizeBlocker('MODEL_UNAVAILABLE', 'model call failed', {}) };
  }
  if (propose.status !== 'READY') {
    // REJECTED / APPLY_FAILED / CHECKS_FAILED: retryable, but each consumes
    // budget and is recorded so the next proposal sees it.
    return {
      next: 'continue',
      retryableStatus: propose.status,
      attempt: {
        n: attemptNumber,
        signature: state.finding.signature || '',
        domain: state.finding.domain || '',
        repairKind: (propose.repairKind || 'proposal-rejected'),
        status: propose.status,
        checks: summarizeChecks(propose.checks),
        message: propose.blocker ? propose.blocker.message : (propose.status + ': proposal not ready'),
        verifyStatus: null
      },
      previousEvidence: {
        diff: propose.diffText || null,
        checks: propose.checks || null,
        errors: [propose.status],
        rejectionCodes: propose.rejectionCodes || null,
        validCandidatePaths: propose.validCandidatePaths || null,
        requestedPaths: propose.requestedPaths || null
      }
    };
  }

  // READY -> push, build, deploy, rerun, verify.
  var pushResult = await adapters.gitClient.push(located.dir, located.branch, cfg.token, {
    runCommand: cfg.runCommand,
    timeout: 120000
  });
  if (!pushResult || !pushResult.ok) {
    writeFindingEvidence(cfg, state);
    return { next: 'stop-blocked', blocker: pushResult && pushResult.blocker ? pushResult.blocker : normalizeBlocker('PUSH_FAILED', 'git push failed', {}) };
  }

  var buildResult = await adapters.build.buildAndPublish({
    branch: located.branch,
    fixSha: propose.headSha,
    token: cfg.token,
    fetch: cfg.fetch,
    now: Date.now
  });
  if (!buildResult || !buildResult.ok) {
    writeFindingEvidence(cfg, state);
    return { next: 'stop-blocked', blocker: buildResult && buildResult.blocker ? buildResult.blocker : normalizeBlocker('IMAGE_BUILD_DISPATCH_FAILED', 'image build/publish failed', {}) };
  }

  var deployResult = await adapters.deploy.deploy(buildResult.deployRef, {
    healthUrl: cfg.stagingUrl ? cfg.stagingUrl + '/health' : null,
    runCommand: cfg.runCommand,
    fetch: cfg.fetch
  });
  if (!deployResult || !deployResult.ok) {
    writeFindingEvidence(cfg, state);
    return { next: 'stop-blocked', blocker: deployResult && deployResult.blocker ? deployResult.blocker : normalizeBlocker('DEPLOY_REFUSED', 'deploy refused', {}) };
  }

  // Retest: rerun the same tasks (plus CAN-B2-16) and verify signatures.
  var rerunTasks = cfg.rerunTasks
    ? await cfg.rerunTasks(cfg.taskIds)
    : await defaultRerunTasks(cfg, cfg.taskIds);
  var afterSigs = cfg.extractAfter
    ? cfg.extractAfter(rerunTasks)
    : defaultExtractAfter(cfg, adapters.signatureExtractor, rerunTasks);
  var verdict = adapters.verifier.verify(state.baselineSignatures, afterSigs);

  var attempt = {
    n: attemptNumber,
    signature: state.finding.signature || '',
    domain: state.finding.domain || '',
    repairKind: propose.repairKind || '',
    status: 'deployed',
    checks: summarizeChecks(propose.checks),
    branch: located.branch,
    headSha: propose.headSha || '',
    buildRunUrl: buildResult.runUrl || '',
    imageDigest: buildResult.digest || buildResult.deployRef || '',
    deployed: true,
    retestVerdicts: rerunTasks.map(function(t) { return (t && t.result) || ''; }),
    verifyStatus: verdict.status,
    message: 'deploy retest: ' + verdict.status
  };

  if (verdict.status === 'fixed') {
    return { next: 'stop-fixed', attempt: attempt, deployRef: buildResult.deployRef };
  }

  // not-fixed or regressed: roll back to baseline, record, next attempt.
  state.deploy = { ref: buildResult.deployRef, digest: buildResult.digest || null, runUrl: buildResult.runUrl || null };
  var rollback = await rollbackToBaseline(cfg, adapters, buildResult);
  state.rollback = { ok: rollback.ok, reason: rollback.reason, ref: rollback.ref || null };
  if (!rollback.ok) {
    state.rollback.recorded = 'rollback unavailable';
  }
  return {
    next: 'continue',
    attempt: attempt,
    rollback: state.rollback,
    previousEvidence: {
      diff: propose.diffText || null,
      checks: propose.checks || null,
      errors: ['deploy retest: ' + verdict.status + (rollback.ok ? '' : '; rollback unavailable')],
      verifyStatus: verdict.status
    }
  };
}

function summarizeChecks(checks) {
  if (!checks || !Array.isArray(checks.results)) return '';
  var failed = checks.results.filter(function(r) { return !r.success; });
  return failed.length === 0 ? 'pass' : 'fail:' + failed.map(function(f) { return f.script; }).join(',');
}

/**
 * R5b orchestrator entry. Opt-in via REPAIR_MODE=true; normal runs (repair
 * off) short-circuit to NO_REPAIR without touching any adapter or file.
 *
 * Flow: resolve the normal run, collect logs (recording any wrapper refusal),
 * extract the finding and baseline signatures, clone + locate, then loop
 * while budgets allow: proposeAndCheck -> push -> buildAndPublish -> deploy ->
 * rerun -> verify. Fixed stops with FIXED; not-fixed/regressed rolls back to
 * baseline and tries again; any BLOCKED status stops the loop and records the
 * exact blocker with outcome BLOCKED (task stays unmet, no alternative route).
 */
async function runRepair(deps) {
  deps = deps || {};
  var cfg = resolveRepairConfig(deps);

  if (!cfg.repairMode) {
    return {
      outcome: OUTCOME_NO_REPAIR,
      exitCode: EXIT_NO_REPAIR,
      runId: cfg.runId || null,
      blockers: []
    };
  }

  cfg.runId = resolveRunId(cfg);
  var normal = loadNormalRun(cfg, cfg.runId);
  if (!normal) {
    return { outcome: OUTCOME_NO_REPAIR, exitCode: EXIT_NO_REPAIR, runId: cfg.runId || null, blockers: [] };
  }
  var targets = selectRepairTargets(normal.tasks);
  if (targets.length === 0) {
    return { outcome: OUTCOME_NO_REPAIR, exitCode: EXIT_NO_REPAIR, runId: cfg.runId || null, blockers: [] };
  }

  // Pre-check: if any target is blocked with CLIENT_INPUT_SCOPE (seed failed /
  // missing client secret) repair cannot proceed. Do not clone or call the model.
  var clientInputTasks = normal.tasks.filter(function(t) {
    return t && t.classification === CLASS_CLIENT_INPUT_SCOPE;
  });
  if (clientInputTasks.length > 0) {
    var firstBlocked = clientInputTasks[0];
    var evidence = {
      classification: CLASS_CLIENT_INPUT_SCOPE,
      cause: firstBlocked.cause || ('task ' + firstBlocked.taskId + ' blocked: CLIENT_INPUT_SCOPE'),
      variableNames: (firstBlocked.variableNames && Array.isArray(firstBlocked.variableNames))
        ? firstBlocked.variableNames.slice()
        : []
    };
    return {
      outcome: OUTCOME_BLOCKED,
      exitCode: EXIT_BLOCKED,
      runId: cfg.runId || null,
      blockers: [{ code: 'REPAIR_PRECONDITION_NOT_MET', message: 'task blocked with CLIENT_INPUT_SCOPE: repair precondition not met', evidence: evidence }]
    };
  }

  var adapters = Object.assign({}, defaultAdapters(), cfg.adapters || {});
  var budget = cfg.budget || { perSignature: cfg.perSignatureBudget, global: cfg.globalBudget, bySignature: {}, total: 0, model: { maxTokensTotal: 400000, used: 0 } };

  var state = {
    outcome: null,
    exitCode: null,
    logs: {},
    logBlockers: [],
    blockers: [],
    attempts: [],
    previousAttempts: [],
    pipelineChanges: [],
    targetChanges: [],
    finding: null,
    baselineSignatures: [],
    branch: null,
    cloneDir: null,
    deploy: null,
    rollback: null,
    reportError: null,
    runStartedAt: Date.now(),
    deadline: defaultDeadline(Date.now),
    baseSha: null
  };

  // 1. Collect logs. A wrapper refusal is recorded and does not stop the
  //    finding extraction below.
  await collectRepairLogs(cfg, adapters.logSource, state);

  // 2. Extract finding from the first target's API error and reproduce the
  //    baseline signatures. This runs even when a log blocker was recorded.
  var extractInput = buildExtractInput(cfg, targets[0], state.logs);
  state.finding = adapters.signatureExtractor.extractFinding(extractInput);
  var replayer = cfg.replayer || function(f) { return defaultReplayer(f); };
  var repro = adapters.verifier.reproduce(state.finding, targets[0], {
    runId: cfg.runId,
    root: cfg.cwd,
    baseDir: 'evidence',
    replayer: replayer
  });
  state.baselineSignatures = Array.isArray(repro.signatures) ? repro.signatures : [];

  // Write finding evidence early, before any attempt mutations.
  writeFindingEvidence(cfg, state);

  // A log wrapper refusal is a BLOCKED status: stop after extraction.
  if (state.logBlockers.length > 0) {
    state.blockers = state.logBlockers.slice();
    writeFindingEvidence(cfg, state);
    state.outcome = OUTCOME_BLOCKED;
    state.exitCode = EXIT_BLOCKED;
    writeRepairReport(cfg, state);
    return redactRepairState(cfg, state);
  }

  // 3. Clone the target and locate candidates.
  var gitSetup = adapters.gitSetup || defaultCloneAndLocate;
  var located = await gitSetup(cfg, adapters, state.finding);
  if (!located || !located.ok) {
    var gblk = located && located.blocker ? located.blocker : normalizeBlocker('GIT_BLOCKED', 'git setup failed', {});
    state.blockers.push(gblk);
    writeFindingEvidence(cfg, state);
    state.outcome = OUTCOME_BLOCKED;
    state.exitCode = EXIT_BLOCKED;
    writeRepairReport(cfg, state);
    return redactRepairState(cfg, state);
  }
  state.branch = located.branch;
  state.cloneDir = located.dir;
  var head = await adapters.gitClient.getHeadSha(located.dir, { runCommand: cfg.runCommand });
  state.baseSha = head && head.ok ? head.sha : null;

  // 4. Repair loop while budgets allow. The orchestrator enforces the
  //    per-signature and global caps itself (model.consume applies a second,
  //    shared gate inside the real proposeAndCheck); either cap ends the loop
  //    with the attempts recorded and the task still unmet.
  var attemptNumber = 0;
  while (Date.now() < state.deadline &&
         attemptNumber < budget.global &&
         attemptNumber < budget.perSignature) {
    attemptNumber += 1;
    var result;
    try {
      result = await proposeAttempt(cfg, adapters, state, located, attemptNumber, budget);
    } catch (err) {
      writeAttemptError(cfg, err, 'propose-attempt');
      state.blockers.push(normalizeBlocker('REPAIR_ATTEMPT_ERROR', safeErr(err), {}));
      break;
    }

    if (result.next === 'stop-fixed') {
      state.attempts.push(result.attempt);
      state.outcome = OUTCOME_FIXED;
      state.exitCode = EXIT_FIXED;
      break;
    }
    if (result.next === 'stop-blocked') {
      if (result.blocker) state.blockers.push(result.blocker);
      state.outcome = OUTCOME_BLOCKED;
      state.exitCode = EXIT_BLOCKED;
      break;
    }
    if (result.next === 'stop-budget') {
      state.outcome = OUTCOME_NOT_FIXED;
      state.exitCode = EXIT_NOT_FIXED;
      break;
    }
    // continue: record the retryable/regressed attempt and carry it forward.
    if (result.attempt) {
      state.attempts.push(result.attempt);
    }
    if (result.previousEvidence) {
      state.previousAttempts.push(Object.assign({ n: attemptNumber }, result.previousEvidence));
    }
  }

  if (state.outcome == null) {
    state.outcome = OUTCOME_NOT_FIXED;
    state.exitCode = EXIT_NOT_FIXED;
  }

  writeRepairReport(cfg, state);
  return redactRepairState(cfg, state);
}

async function main() {
  var result;
  try {
    result = await runRepair({});
  } catch (e) {
    console.error('run-repair failed: ' + ((e && e.message) || String(e)));
    process.exitCode = EXIT_BLOCKED;
    return;
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  runRepair,
  main,
  resolveRepairConfig,
  buildFixBranch,
  isRepairTarget,
  selectRepairTargets,
  taskErrorText,
  normalizeBlocker,
  defaultReplayer,
  defaultExtractAfter,
  defaultRerunTasks,
  defaultCloneAndLocate,
  buildRepairData,
  writeRepairReport,
  redactRepairState,
  loadNormalRun,
  resolveRunId,
  writeFindingEvidence,
  writeAttemptError,
  buildExtractInput,
  parseGraphQlQuery,
  getGraphQlInfoFromEvidence,
  buildLogExcerptWithWindow,
  buildLogShape,
  maskSecretsOnly,
  extractErrorContextLines
};






