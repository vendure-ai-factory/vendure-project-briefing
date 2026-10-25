'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var EVIDENCE_ROOT = 'evidence';
var LOG_KIND = 'log-source';
var REDACTED_MARKER = '[REDACTED]';

var KIND_ALLOWLIST = {
  'vendure': true,
  'worker': true,
  'postgres': true
};

var WRAPPER_SCRIPT = 'sudo';
var WRAPPER_ARGS_BASE = ['/usr/local/sbin/pipeline-staging-ops', 'logs'];
var DEFAULT_TIMEOUT_MS = 30000;
var MAX_OUTPUT_LINES = 10000;
var DEFAULT_TIME_WINDOW_MS = 900000;
var WIDE_TIME_WINDOW_MS = 3 * 60 * 60 * 1000;
var RUN_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function redactEmails(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED_MARKER);
}

function redactSecrets(text, secretValues) {
  if (!secretValues || !Array.isArray(secretValues) || secretValues.length === 0) {
    return text;
  }
  var result = text;
  for (var i = 0; i < secretValues.length; i++) {
    var val = secretValues[i];
    if (val && typeof val === 'string' && result.includes(val)) {
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

function collectOutputSecrets(content) {
  if (!content || typeof content !== 'string') return [];
  var found = [];
  var lower = content.toLowerCase();
  var matches = lower.match(/(?:api[_-]?key|secret|password|passwd|token|credential|auth)[_\-][a-zA-Z0-9_\-]{4,}/g);
  if (matches) {
    for (var i = 0; i < matches.length; i++) {
      var start = lower.indexOf(matches[i]);
      if (start !== -1) {
        found.push(content.substring(start, start + matches[i].length));
      }
    }
  }
  return found;
}

function resolveRoot(options) {
  options = options || {};
  var root = options.root || process.cwd();
  var baseDir = options.baseDir || EVIDENCE_ROOT;
  var normRoot = root.replace(/\\/g, '/');
  var normBase = baseDir.replace(/\\/g, '/');
  if (normRoot.endsWith(normBase)) {
    var prefix = normRoot.substring(0, normRoot.length - normBase.length);
    if (prefix.endsWith(normBase + '/')) {
      return path.resolve(prefix);
    }
    return path.resolve(prefix || process.cwd(), baseDir);
  }
  if (path.isAbsolute(root)) {
    return root;
  }
  return path.resolve(root, baseDir);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadIndex(root, runId) {
  var idxPath = path.join(root, runId, 'index.json');
  if (!fs.existsSync(idxPath)) {
    return { exists: false, index: null };
  }
  try {
    var content = fs.readFileSync(idxPath, 'utf8');
    return { exists: true, index: JSON.parse(content) };
  } catch (e) {
    return { exists: true, index: null, error: e.message };
  }
}

function saveIndex(root, runId, index) {
  var dir = path.join(root, runId);
  ensureDir(dir);
  var content = JSON.stringify(index, null, 2) + '\n';
  var redacted = redactSecrets(content, collectEnvSecrets());
  fs.writeFileSync(path.join(dir, 'index.json'), redacted, 'utf8');
  return JSON.parse(redacted);
}

function initLogIndex(runId, options) {
  var root = resolveRoot(options);
  var existing = loadIndex(root, runId);
  if (existing.exists && existing.index) {
    return { ok: true, index: existing.index, reused: true };
  }
  var index = {
    runId: runId,
    schemaVersion: '1.0',
    entries: []
  };
  return { ok: true, index: saveIndex(root, runId, index), reused: false };
}

function appendLogEntry(runId, entry, options) {
  var root = resolveRoot(options);
  var loaded = loadIndex(root, runId);
  if (!loaded.exists || !loaded.index) {
    initLogIndex(runId, options);
    loaded = loadIndex(root, runId);
  }
  if (!loaded.index.entries) {
    loaded.index.entries = [];
  }
  loaded.index.entries.push(entry);
  saveIndex(root, runId, loaded.index);
}

function writeLogEvidence(runId, content, options) {
  options = options || {};
  var root = resolveRoot(options);
  ensureDir(path.join(root, runId));

  var secretValues = collectEnvSecrets();
  var redacted = redactSecrets(content, secretValues);
  var redactedAndEmail = redactEmails(redacted);

  var fileHash = sha256Hex(redactedAndEmail);
  var timestamp = new Date().toISOString();

  var relPath = 'logs.json';
  var absPath = path.join(root, runId, relPath);
  fs.writeFileSync(absPath, redactedAndEmail, 'utf8');

  var entry = {
    path: relPath,
    sha256: fileHash,
    timestamp: timestamp,
    kind: LOG_KIND
  };
  appendLogEntry(runId, entry, options);
  return { ok: true, path: relPath, sha256: fileHash, timestamp: timestamp };
}

function parseTsFromLine(line) {
  var tsMatch = line.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(Z|z|[+\-]\d{2}:\d{2})?/);
  if (!tsMatch) {
    return null;
  }
  var iso = tsMatch[1].replace(' ', 'T');
  if (tsMatch[2]) {
    iso += tsMatch[2];
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // No explicit offset -> treat as UTC so it is comparable with sinceTs (a Z-time).
  var parts = iso.split(/[-T:]/);
  var d2 = new Date(Date.UTC(+parts[0], (+parts[1] - 1), +parts[2], +parts[3], +parts[4], +parts[5]));
  return isNaN(d2.getTime()) ? null : d2.getTime();
}

function linesHaveOffset(lines) {
  var re = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(Z|z|[+\-]\d{2}:\d{2})/;
  for (var i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      return true;
    }
  }
  return false;
}

function filterLinesByTime(lines, sinceTs) {
  if (!sinceTs || typeof sinceTs !== 'number' || sinceTs <= 0) {
    return { lines: lines, notes: [] };
  }
  var sinceMs = sinceTs;
  if (sinceMs < 1e12) {
    sinceMs = sinceMs * 1000;
  }
  // Lines without an explicit timezone offset are ambiguous: widen the
  // acceptance window to +-3h so local-time stamps are not dropped.
  var windowMs = linesHaveOffset(lines) ? DEFAULT_TIME_WINDOW_MS : WIDE_TIME_WINDOW_MS;
  var floor = sinceMs - windowMs;
  var ceil = sinceMs + windowMs;
  var filtered = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var ts = parseTsFromLine(line);
    if (ts === null) {
      filtered.push(line);
      continue;
    }
    if (ts >= floor && ts <= ceil) {
      filtered.push(line);
    }
  }
  if (filtered.length === 0) {
    // Filtering would drop everything: fall back to the bounded, redacted
    // lines unfiltered so the report can still see them.
    return { lines: lines, notes: ['sinceTs filter not applied'] };
  }
  return { lines: filtered, notes: [] };
}

/**
 * Production process adapter. Always uses child_process.execFile with
 * shell: false and the executable + argument array passed separately.
 * Resolves once the child has finished, errored, or timed out.
 * `cp` (defaults to the real child_process module) may be injected for tests.
 */
function runLogCommand(command, args, opts, cp) {
  cp = cp || childProcess;
  opts = opts || {};
  var timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  return new Promise(function(resolve) {
    var settled = false;
    function resolveOnce(value) {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }
    var backstop = setTimeout(function() {
      resolveOnce({ stdout: '', stderr: '', exitCode: null, timedOut: true, spawnError: null, elapsed: 'no execFile callback' });
    }, timeout + 5000);

    cp.execFile(command, args, {
      shell: false,
      timeout: timeout,
      encoding: 'utf8',
      maxBuffer: RUN_MAX_OUTPUT_BYTES
    }, function(err, stdout, stderr) {
      clearTimeout(backstop);
      var exitCode = 0;
      var spawnError = null;
      var timedOut = false;
      if (err) {
        if (typeof err.code === 'number') {
          exitCode = err.code;
        } else if (err.killed || err.signal) {
          timedOut = true;
          exitCode = null;
        } else {
          exitCode = null;
          spawnError = err.message || String(err);
        }
      }
      resolveOnce({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: exitCode,
        timedOut: timedOut,
        spawnError: spawnError
      });
    });
  });
}

async function collect(kind, options) {
  options = options || {};

  var runCommand = options.runCommand;
  var sinceTs = options.sinceTs;
  var runId = options.runId || ('run-' + Date.now());
  var maxLines = options.maxLines || MAX_OUTPUT_LINES;

  if (!kind || !KIND_ALLOWLIST[kind]) {
    var allowed = Object.keys(KIND_ALLOWLIST);
    return {
      ok: false,
      error: 'Invalid log kind: ' + kind + '. Allowed: ' + allowed.join(', ')
    };
  }

  var command = WRAPPER_SCRIPT;
  var args = WRAPPER_ARGS_BASE.concat([kind]);
  var cmdStr = command + ' ' + args.join(' ');

  var execOptions = {
    cwd: options.cwd || '/tmp',
    timeout: DEFAULT_TIMEOUT_MS
  };

  var execResult;
  if (typeof runCommand === 'function') {
    // Injected runner (tests). May return a plain object or a Promise.
    try {
      execResult = await runCommand(command, args, execOptions);
    } catch (err) {
      var blockerErr = {
        command: cmdStr,
        exitCode: null,
        stderrExcerpt: err.message ? redactSecrets(redactEmails(err.message), collectEnvSecrets()) : 'unknown error'
      };
      return { ok: false, blocker: blockerErr };
    }
  } else {
    // Production default: child_process.execFile with shell: false.
    execResult = await runLogCommand(command, args, execOptions, options.childProcess);
  }

  if (execResult && execResult.spawnError) {
    var blockerSpawn = {
      command: cmdStr,
      exitCode: null,
      stderrExcerpt: redactSecrets(redactEmails(execResult.spawnError), collectEnvSecrets()).substring(0, 500)
    };
    return { ok: false, blocker: blockerSpawn };
  }

  var rawStdout = execResult.stdout || '';
  var rawStderr = execResult.stderr || '';
  var exitCode = execResult.exitCode !== undefined ? execResult.exitCode : execResult.code;
  var timedOut = !!execResult.timedOut;

  if (exitCode === null && timedOut) {
    var blockerTimeout = {
      command: cmdStr,
      exitCode: null,
      stderrExcerpt: 'Command timed out after ' + DEFAULT_TIMEOUT_MS + 'ms'
    };
    return { ok: false, blocker: blockerTimeout };
  }

  if (exitCode !== 0 && !timedOut) {
    var blockerExit = {
      command: cmdStr,
      exitCode: exitCode,
      stderrExcerpt: redactSecrets(redactEmails(rawStderr), collectEnvSecrets()).substring(0, 500)
    };
    return { ok: false, blocker: blockerExit };
  }

  var output = rawStdout;
  var truncated = false;
  var allLines = output.split('\n');
  // Drop a trailing empty line (e.g. empty output or a lone newline) so an
  // empty log yields an empty lines array rather than [''].
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  if (allLines.length > maxLines) {
    // Keep the TAIL of the log, not the head: the SQL ERROR/CONTEXT/
    // STATEMENT/DETAIL triples that extractFinding needs appear at the end,
    // after a noise head of checkpoint LOG lines. Keeping the head silently
    // dropped the error and left finding.sql null in production.
    allLines = allLines.slice(allLines.length - maxLines);
    truncated = true;
  }

  var filterResult = filterLinesByTime(allLines, sinceTs);
  var filteredLines = filterResult.lines;
  var notes = filterResult.notes || [];
  var outputSecrets = collectOutputSecrets(output) || [];
  var allSecrets = collectEnvSecrets().concat(outputSecrets);

  var redactedLines = [];
  for (var i = 0; i < filteredLines.length; i++) {
    var line = filteredLines[i];
    var r = redactSecrets(redactEmails(line), allSecrets);
    redactedLines.push(r);
  }

  var logContent = JSON.stringify({
    runId: runId,
    kind: kind,
    lines: redactedLines,
    truncated: truncated,
    sinceTs: sinceTs || null,
    source: cmdStr,
    notes: notes
  }, null, 2) + '\n';

  var evResult = writeLogEvidence(runId, logContent, options);

  return {
    ok: true,
    lines: redactedLines,
    truncated: truncated,
    source: cmdStr,
    runId: runId,
    evidencePath: evResult.path,
    evidenceSha256: evResult.sha256,
    notes: notes
  };
}

module.exports = {
  collect: collect,
  runLogCommand: runLogCommand,
  sha256Hex: sha256Hex,
  redactEmails: redactEmails,
  redactSecrets: redactSecrets
};
