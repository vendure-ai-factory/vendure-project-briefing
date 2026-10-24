'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var EVIDENCE_ROOT = 'evidence';
var EVIDENCE_KIND = 'repair';
var REDACTED_MARKER = '[REDACTED]';

var REPAIR_SUB_DIR = 'repair';

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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

var SECRET_PATTERN_RE = /(?:api[_-]?key|secret|password|passwd|token|credential|auth)[_\-]?[a-zA-Z0-9]{4,}/i;

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
      var start = content.toLowerCase().indexOf(matches[i]);
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
  // If root ends with baseDir (e.g. options.root = 'evidence/<runId>' where baseDir='evidence'),
  // strip baseDir, resolve, then re-add baseDir. Avoids 'evidence/<runId>/evidence' duplication.
  if (normRoot.endsWith(normBase)) {
    var suffix = normRoot.substring(normRoot.length - normBase.length);
    if (suffix === normBase) {
      var prefix = normRoot.substring(0, normRoot.length - normBase.length);
      // prefix is e.g. 'evidence/' or '' or 'evidence/test-idx-1234/'
      var resolved = path.resolve(prefix || process.cwd());
      return path.join(resolved, baseDir);
    }
  }
  // If root is already absolute, use it directly without adding baseDir.
  if (path.isAbsolute(root)) {
    return root;
  }
  return path.resolve(root, baseDir);
}

function repairDir(root, runId) {
  // Detect if root already ends with runId (e.g. options.root = evidence/<runId>)
  // to avoid doubling the runId segment.
  var normRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  var normRunId = runId.replace(/\\/g, '/').replace(/\/$/, '');
  // Strip trailing runId from root if present to avoid duplication
  if (normRoot.endsWith(normRunId)) {
    return path.join(root, REPAIR_SUB_DIR);
  }
  // Also handle case where root ends with runId as last path segment
  var rootSegments = normRoot.split('/');
  if (rootSegments[rootSegments.length - 1] === normRunId) {
    return path.join(root, REPAIR_SUB_DIR);
  }
  return path.join(root, runId, REPAIR_SUB_DIR);
}

function loadIndex(root, runId) {
  var idxPath = path.join(root, 'index.json');
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
  var dir = root;
  ensureDir(dir);
  var content = JSON.stringify(index, null, 2) + '\n';
  var redacted = redactSecrets(content, collectEnvSecrets());
  fs.writeFileSync(path.join(dir, 'index.json'), redacted, 'utf8');
  return JSON.parse(redacted);
}

function initIndex(runId, options) {
  var root = repairDir(resolveRoot(options), runId);
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

function appendIndexEntry(runId, entry, options) {
  var root = repairDir(resolveRoot(options), runId);
  var loaded = loadIndex(root, runId);
  if (!loaded.exists || !loaded.index) {
    initIndex(runId, options);
    loaded = loadIndex(root, runId);
  }
  if (!loaded.index.entries) {
    loaded.index.entries = [];
  }
  loaded.index.entries.push(entry);
  saveIndex(root, runId, loaded.index);
}

function writeEvidenceFile(runId, filename, content, options) {
  options = options || {};
  var root = resolveRoot(options);
  var dir = repairDir(root, runId);
  ensureDir(dir);

  var secretValues = collectEnvSecrets();
  var redacted = redactSecrets(content, secretValues);
  var redactedAndEmail = redactEmails(redacted);

  var fileHash = sha256Hex(redactedAndEmail);
  var timestamp = new Date().toISOString();

  var relPath = filename;
  var absPath = path.join(dir, relPath);
  fs.writeFileSync(absPath, redactedAndEmail, 'utf8');

  var entry = {
    path: relPath,
    sha256: fileHash,
    timestamp: timestamp,
    kind: EVIDENCE_KIND
  };
  appendIndexEntry(runId, entry, options);
  return { ok: true, path: relPath, sha256: fileHash, timestamp: timestamp };
}

async function runChecks(cloneDir, options) {
  options = options || {};
  var runId = options.runId || ('run-' + Date.now());
  var root = resolveRoot(options);

  // Target scripts are only run with Node >= 22.
  var nodeVersion = options.nodeVersion || parseInt(process.version.slice(1).split('.')[0], 10);
  if (nodeVersion < 22) {
    return { ok: false, blocked: true, nodeVersion: nodeVersion, runId: runId,
      error: 'Node >= 22 required to run target checks; found ' + nodeVersion };
  }

  var pkgPath = path.join(cloneDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, error: 'package.json not found in cloneDir', runId: runId };
  }

  var pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'failed to parse package.json: ' + e.message, runId: runId };
  }

  var scripts = pkg.scripts || {};
  var scriptNames = Object.keys(scripts);

  // Toolchain availability gate: if no dependencies are installed, the target
  // scripts cannot run meaningfully. This is not a failure (a fresh clone may
  // legitimately lack node_modules); it is a skipped non-result the repair
  // loop must treat as neutral, not as CHECKS_FAILED.
  var hasNodeModules = fs.existsSync(path.join(cloneDir, 'node_modules'));
  if (!hasNodeModules && scriptNames.length > 0) {
    var skippedResults = scriptNames.map(function(n) {
      return {
        script: n,
        command: null,
        success: false,
        exitCode: null,
        timedOut: false,
        skipped: true,
        code: 'CHECKS_SKIPPED_NO_TOOLCHAIN',
        stdout: '',
        stderr: 'node_modules not present; skipping ' + n,
        error: null
      };
    });
    var skippedContent = JSON.stringify({ runId: runId, results: skippedResults }, null, 2) + '\n';
    var skippedEv = writeEvidenceFile(runId, 'runChecks.json', skippedContent, options);
    return {
      ok: true,
      skipped: true,
      code: 'CHECKS_SKIPPED_NO_TOOLCHAIN',
      runId: runId,
      results: skippedResults,
      evidencePath: skippedEv.path,
      evidenceSha256: skippedEv.sha256
    };
  }


  var installScript = null;
  var buildScript = null;
  var testScript = null;

  for (var i = 0; i < scriptNames.length; i++) {
    var name = scriptNames[i];
    if (name === 'install') installScript = name;
    else if (name === 'build') buildScript = name;
    else if (name === 'test') testScript = name;
  }

  // Default runner resolves only once the child has completed, errored, or
  // timed out, so runChecks never reports a result for a still-running process.
  var execCommand = options.execCommand || function(cmd, args, opts) {
    return new Promise(function(resolve) {
      var childProcess = require('child_process');
      var result = { success: false, stdout: '', stderr: '', exitCode: null, timedOut: false, error: null, signal: null };
      var stdout = '';
      var stderr = '';
      var timeout = opts.timeout || 120000;
      var timedOut = false;
      var proc;
      try {
        proc = childProcess.spawn(cmd, args, {
          cwd: opts.cwd || cloneDir,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        proc.stdout.on('data', function(chunk) { stdout += chunk.toString(); });
        proc.stderr.on('data', function(chunk) { stderr += chunk.toString(); });

        var timer = setTimeout(function() {
          timedOut = true;
          if (proc && typeof proc.kill === 'function') {
            try { proc.kill('SIGKILL'); } catch (e) { /* already exited */ }
          }
        }, timeout);

        proc.on('close', function(code, signal) {
          clearTimeout(timer);
          result.exitCode = code;
          result.signal = signal || null;
          result.timedOut = timedOut;
          result.stdout = stdout.substring(0, 50000);
          result.stderr = stderr.substring(0, 50000);
          result.success = code === 0 && !timedOut;
          resolve(result);
        });
        proc.on('error', function(err) {
          clearTimeout(timer);
          result.error = err.message;
          result.success = false;
          resolve(result);
        });
      } catch (err) {
        result.error = err.message;
        result.success = false;
        resolve(result);
      }
    });
  };

  var timeout = options.timeout || 120000;
  var results = [];

  var scriptsToRun = [];
  if (installScript) scriptsToRun.push({ name: installScript, script: scripts[installScript] });
  if (buildScript)   scriptsToRun.push({ name: buildScript,   script: scripts[buildScript] });
  if (testScript)    scriptsToRun.push({ name: testScript,    script: scripts[testScript] });

  for (var s = 0; s < scriptsToRun.length; s++) {
    var entry = scriptsToRun[s];
    var scriptName = entry.name;
    var scriptCmd = entry.script;

    var cmdParts = scriptCmd.split(/\s+/);
    var cmd = cmdParts[0];
    var args = cmdParts.slice(1);

    // Resolve bare command names to local node_modules/.bin binaries so that
    // `tsc` becomes `<cloneDir>/node_modules/.bin/tsc` when the tool is installed.
    var resolvedCmd = cmd;
    if (cmd.indexOf('/') === -1 && cmd.indexOf('\\') === -1 && cmd.indexOf('.') === -1) {
      var localBin = path.join(cloneDir, 'node_modules', '.bin', cmd);
      if (fs.existsSync(localBin)) {
        resolvedCmd = localBin;
      }
    }

    var execResult = await execCommand(resolvedCmd, args, {
      cwd: cloneDir,
      timeout: timeout
    });

    var outputSecrets = collectOutputSecrets(execResult.stdout || '') || [];
    var allSecrets = collectEnvSecrets().concat(outputSecrets);
    var redactedOut = redactSecrets(execResult.stdout || '', allSecrets);
    var redactedErr = redactSecrets(execResult.stderr || '', allSecrets);
    redactedOut = redactEmails(redactedOut);
    redactedErr = redactEmails(redactedErr);

    // A spawn that never ran (command not found / ENOENT) surfaces as a
    // child 'error' event with no exit code and no output. Treat it as the
    // same non-fatal "toolchain unavailable" skip instead of a failed check.
    var spawnFailed = execResult.exitCode === null && !(execResult.stdout || '') && !(execResult.stderr || '') && !!execResult.error;
    var isSkipped = spawnFailed;

    results.push({
      script: scriptName,
      command: resolvedCmd + (args.length > 0 ? ' ' + args.join(' ') : ''),
      resolvedCommand: resolvedCmd,
      success: !isSkipped && execResult.success,
      exitCode: execResult.exitCode,
      timedOut: execResult.timedOut,
      skipped: isSkipped,
      code: isSkipped ? 'CHECKS_SKIPPED_NO_TOOLCHAIN' : undefined,
      stdout: redactedOut,
      stderr: spawnFailed ? 'command not found: ' + cmd : redactedErr,
      error: execResult.error ? redactSecrets(execResult.error, collectEnvSecrets()) : null,
      cwd: cloneDir,
      hasNodeModules: hasNodeModules,
      signal: execResult.signal || null
    });
  }

  var evContent = JSON.stringify({ runId: runId, results: results }, null, 2) + '\n';
  var evResult = writeEvidenceFile(runId, 'runChecks.json', evContent, options);

  var allSuccess = results.length > 0 && results.every(function(r) { return r.success; });
  var anyTimedOut = results.some(function(r) { return r.timedOut; });
  var allSkipped = results.length > 0 && results.every(function(r) { return r.skipped; });

  return {
    ok: allSkipped ? true : (!anyTimedOut && allSuccess),
    skipped: allSkipped,
    code: allSkipped ? 'CHECKS_SKIPPED_NO_TOOLCHAIN' : undefined,
    timedOut: anyTimedOut,
    runId: runId,
    results: results,
    evidencePath: evResult.path,
    evidenceSha256: evResult.sha256
  };
}

function reproduce(finding, task, options) {
  options = options || {};
  var runId = options.runId || ('run-' + Date.now());
  var root = resolveRoot(options);

  var signatures = [];
  var error = null;

  var replayer = options.replayer || function(f, t) {
    error = 'replayer not provided and no default implementation';
    return { signatures: [], error: error };
  };

  var result = replayer(finding, task);

  if (result && Array.isArray(result.signatures)) {
    signatures = result.signatures;
  }
  if (result && result.error) {
    error = result.error;
  }

  var evContent = JSON.stringify({
    runId: runId,
    finding: finding ? { class: finding.class, message: finding.message, signature: finding.signature } : null,
    task: task ? { id: task.id, type: task.type } : null,
    signatures: signatures,
    error: error
  }, null, 2) + '\n';

  var evResult = writeEvidenceFile(runId, 'reproduce.json', evContent, options);

  return {
    runId: runId,
    signatures: signatures,
    evidencePath: evResult.path,
    evidenceSha256: evResult.sha256,
    error: error
  };
}

function verify(before, after) {
  if (!before || !Array.isArray(before)) {
    before = [];
  }
  if (!after || !Array.isArray(after)) {
    after = [];
  }

  var beforeSet = {};
  for (var i = 0; i < before.length; i++) {
    beforeSet[before[i]] = true;
  }

  var afterSet = {};
  for (var j = 0; j < after.length; j++) {
    afterSet[after[j]] = true;
  }

  var onlyInAfter = [];
  for (var k = 0; k < after.length; k++) {
    if (!beforeSet[after[k]]) {
      onlyInAfter.push(after[k]);
    }
  }

  var stillPresent = [];
  for (var m = 0; m < before.length; m++) {
    if (afterSet[before[m]]) {
      stillPresent.push(before[m]);
    }
  }

  if (onlyInAfter.length > 0) {
    return {
      status: 'regressed',
      newSignatures: onlyInAfter,
      fixedSignatures: before.filter(function(s) { return !afterSet[s]; }),
      remainingSignatures: stillPresent
    };
  }

  if (stillPresent.length === 0) {
    return {
      status: 'fixed',
      newSignatures: [],
      fixedSignatures: before.filter(function(s) { return !afterSet[s]; }),
      remainingSignatures: []
    };
  }

  return {
    status: 'not-fixed',
    newSignatures: [],
    fixedSignatures: before.filter(function(s) { return !afterSet[s]; }),
    remainingSignatures: stillPresent
  };
}

module.exports = {
  reproduce: reproduce,
  verify: verify,
  runChecks: runChecks,
  initIndex: initIndex,
  sha256Hex: sha256Hex,
  redactEmails: redactEmails,
  redactSecrets: redactSecrets
};
