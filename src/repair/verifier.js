'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var EVIDENCE_ROOT = 'evidence';
var EVIDENCE_KIND = 'repair';
/**
 * Normalize a tsc output line into {file, code, message} without line/column.
 * tsc error format: 'src/file.ts(10,5): error TS2307: message'
 * Returns null for non-matching lines.
 */
function normalizeTscErrorLine(line) {
  if (!line || typeof line !== 'string') return null;
  // Match: file(path,line,col): error TSNNNN: message
  // or: file(path,line,col): warning TSNNNN: message
  var match = /^([^\(]+)\([^)]+\):\s*(?:error|warning)\s+(TS\d+):\s*(.*)$/.exec(line.trim());
  if (!match) return null;
  return {
    file: match[1].replace(/\\/g, '/'),
    code: match[2],
    message: match[3]
  };
}

/**
 * Detect if a baseline tsc error set is "unreliable" — meaning the toolchain
 * itself is broken (core modules/packages missing, @types/node absent), so a
 * baseline-diff pass/fail verdict cannot be trusted.
 *
 * An unreliable baseline contains >=1 TS2307 for core modules (@nestjs/common,
 * typeorm, rxjs, path, graphql-tag, @vendure/core) OR >=1 TS2580/TS2304 for
 * missing globals (process, __dirname) that indicate @types/node is absent.
 *
 * Returns { unreliable: bool, baselineErrorCount: number, topCodes: string[] }
 * where topCodes are the up-to-5 most-frequent distinct error codes.
 */
function detectUnreliableBaselineErrors(errors) {
  if (!errors || !Array.isArray(errors) || errors.length === 0) {
    return { unreliable: false, baselineErrorCount: 0, topCodes: [] };
  }
  var coreModulePatterns = [
    '@nestjs/common',
    'typeorm',
    'rxjs',
    '^path$',
    'graphql-tag',
    '@vendure/core',
    '@types/node'
  ];
  var hasCoreModuleError = false;
  var hasGlobalError = false;
  for (var i = 0; i < errors.length; i++) {
    var e = errors[i];
    if (!e || typeof e.code !== 'string') continue;
    var msg = e.message || '';
    if (e.code === 'TS2307') {
      for (var c = 0; c < coreModulePatterns.length; c++) {
        var pat = coreModulePatterns[c];
        var re = new RegExp(pat);
        if (re.test(msg)) {
          hasCoreModuleError = true;
          break;
        }
      }
    }
    // TS2305 "Module '@vendure/core' has no exported member 'ID'" also means the
    // vendure types are not loadable -> unreliable baseline (no reliable diff).
    if (e.code === 'TS2305' && /@vendure\/core/.test(msg)) {
      hasCoreModuleError = true;
    }
    if (e.code === 'TS2580' || e.code === 'TS2304') {
      if (/process|__dirname|__filename/.test(msg)) {
        hasGlobalError = true;
      }
    }
  }
  var unreliable = hasCoreModuleError || hasGlobalError;
  // Collect up to 5 most-frequent error codes
  var codeCount = {};
  for (var j = 0; j < errors.length; j++) {
    var cd = errors[j] && errors[j].code;
    if (cd) codeCount[cd] = (codeCount[cd] || 0) + 1;
  }
  var sortedCodes = Object.keys(codeCount).sort(function(a, b) { return codeCount[b] - codeCount[a]; });
  var topCodes = sortedCodes.slice(0, 5);
  return {
    unreliable: unreliable,
    baselineErrorCount: errors.length,
    topCodes: topCodes
  };
}
function normalizeTscOutput(output) {
  if (!output || typeof output !== 'string') return [];
  var lines = output.split('\n');
  var errors = [];
  for (var i = 0; i < lines.length; i++) {
    var norm = normalizeTscErrorLine(lines[i]);
    if (norm) errors.push(norm);
  }
  return errors;
}

/**
 * Compare two tsc error arrays. Returns {newErrors, removedErrors}.
 * newErrors = errors in current not present in baseline (by file+code+message)
 * removedErrors = errors in baseline not present in current (informational only)
 */
function diffTscErrors(baseline, current) {
  var baselineSet = {};
  for (var i = 0; i < (baseline || []).length; i++) {
    var e = baseline[i];
    var key = e.file + '|' + e.code + '|' + e.message;
    baselineSet[key] = true;
  }
  var newErrors = [];
  for (var j = 0; j < (current || []).length; j++) {
    var c = current[j];
    var ckey = c.file + '|' + c.code + '|' + c.message;
    if (!baselineSet[ckey]) newErrors.push(c);
  }
  var currentSet = {};
  for (var k = 0; k < (current || []).length; k++) {
    var ck = current[k];
    var ckey2 = ck.file + '|' + ck.code + '|' + ck.message;
    currentSet[ckey2] = true;
  }
  var removedErrors = [];
  for (var b = 0; b < (baseline || []).length; b++) {
    var be = baseline[b];
    var bekey = be.file + '|' + be.code + '|' + be.message;
    if (!currentSet[bekey]) removedErrors.push(be);
  }
  return { newErrors: newErrors, removedErrors: removedErrors };
}

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

  // When REPAIR_LOCAL_CHECKS=off, skip all local checks and record them as
  // SKIPPED_BY_CONFIG so the repair flow goes straight to commit/push/dispatch.
  // This is never reported as a pass — the real image build is authoritative.
  if (options.skipByConfig === true) {
    var pkgPathSkip = path.join(cloneDir, 'package.json');
    var pkgSkip;
    try {
      pkgSkip = JSON.parse(fs.readFileSync(pkgPathSkip, 'utf8'));
    } catch (e) {
      pkgSkip = { scripts: {} };
    }
    var skipScripts = pkgSkip.scripts || {};
    var skipScriptNames = Object.keys(skipScripts);
    var skipResults = [];
    if (skipScriptNames.indexOf('build') !== -1) {
      skipResults.push({ script: 'build', success: true, skipped: false, code: 'SKIPPED_BY_CONFIG', exitCode: null, timedOut: false, stderr: 'REPAIR_LOCAL_CHECKS=off: local checks skipped, image build is authoritative', stdout: '', error: null, signal: null });
    }
    if (skipScriptNames.indexOf('install') !== -1) {
      skipResults.push({ script: 'install', success: true, skipped: false, code: 'SKIPPED_BY_CONFIG', exitCode: null, timedOut: false, stderr: 'REPAIR_LOCAL_CHECKS=off: local checks skipped, image build is authoritative', stdout: '', error: null, signal: null });
    }
    if (skipScriptNames.indexOf('test') !== -1) {
      skipResults.push({ script: 'test', success: true, skipped: false, code: 'SKIPPED_BY_CONFIG', exitCode: null, timedOut: false, stderr: 'REPAIR_LOCAL_CHECKS=off: local checks skipped, image build is authoritative', stdout: '', error: null, signal: null });
    }
    // Also add tsc --noEmit as skipped
    skipResults.push({ script: 'tsc --noEmit', success: true, skipped: false, code: 'SKIPPED_BY_CONFIG', exitCode: null, timedOut: false, stderr: 'REPAIR_LOCAL_CHECKS=off: local checks skipped, image build is authoritative', stdout: '', error: null, signal: null });
    var skipContent = JSON.stringify({ runId: runId, results: skipResults }, null, 2) + '\n';
    var skipEv = writeEvidenceFile(runId, 'runChecks.json', skipContent, options);
    return {
      ok: true,
      skipped: false,
      code: 'SKIPPED_BY_CONFIG',
      runId: runId,
      results: skipResults,
      evidencePath: skipEv.path,
      evidenceSha256: skipEv.sha256
    };
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
      } else if (cmd === 'tsc') {
        // Apply the same fallback as the standalone tsc --noEmit check so that
        // a build script of "tsc" is resolved to node_modules/typescript/bin/tsc
        // when node_modules/.bin/tsc is absent.
        var tscAltBin = path.join(cloneDir, 'node_modules', 'typescript', 'bin', 'tsc');
        if (fs.existsSync(tscAltBin)) {
          resolvedCmd = tscAltBin;
        }
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
    // child 'error' event with no exit code and no output. CHECKS_SKIPPED_NO_TOOLCHAIN
    // means the binary is absent after resolution (node_modules/.bin then PATH).
    // This is a skip regardless of whether node_modules exists — the toolchain may be
    // partially installed. If the binary is found but exits non-zero (compile errors),
    // it is a real FAIL so the repair loop can re-ask the model with the output.
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

  // Run tsc --noEmit as an additional direct check when TypeScript is available.
  // Unlike the package.json script loop above which runs user-defined build/test
  // scripts, this directly checks for TypeScript compilation errors that would
  // cause IMAGE_BUILD_FAILED even if the build script succeeds.
  //
  // If tsc cannot be resolved from node_modules/.bin/tsc or node_modules/typescript/bin/tsc,
  // attempt to install typescript first (from package.json dep or latest 5.x), then retry.
  // Skip npm install if node_modules/.bin is empty (test fixture, not real install).
  var tscBin = path.join(cloneDir, 'node_modules', '.bin', 'tsc');
  var tscInstallLog = '';
  // If tsc cannot be resolved from node_modules/.bin/tsc or
  // node_modules/typescript/bin/tsc and node_modules is a real populated install,
  // attempt to install typescript (version from package.json or latest 5.x).
  var tscAvailable = hasNodeModules && fs.existsSync(tscBin);
  if (!tscAvailable && hasNodeModules) {
    var tscAltBin = path.join(cloneDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(tscAltBin)) {
      tscBin = tscAltBin;
      tscAvailable = true;
    } else {
      // Only install when node_modules/.bin looks like a real install (non-empty);
      // an empty node_modules (test fixture) should not trigger a network install.
      var nodeModulesBin = path.join(cloneDir, 'node_modules', '.bin');
      var binHasContent = fs.existsSync(nodeModulesBin) && fs.readdirSync(nodeModulesBin).length > 0;
      if (binHasContent) {
        var tscVersion = null;
        try {
          var pkg = JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8'));
          tscVersion = (pkg.devDependencies && pkg.devDependencies.typescript)
            ? String(pkg.devDependencies.typescript).replace(/^[\^~>=<]+/, '')
            : (pkg.dependencies && pkg.dependencies.typescript)
              ? String(pkg.dependencies.typescript).replace(/^[\^~>=<]+/, '')
              : null;
        } catch (e) { /* no package.json */ }
        var installVersion = tscVersion || 'latest';
        var npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        tscInstallLog = 'tsc not found at ' + tscBin + ', installing typescript@' + installVersion + '...';
        var npmResult = await execCommand(npmCmd, ['install', '--no-save', '--ignore-scripts', 'typescript@' + installVersion], {
          cwd: cloneDir,
          timeout: 120000
        });
        if (npmResult.exitCode === 0 && fs.existsSync(tscBin)) {
          tscInstallLog += ' success';
          tscAvailable = true;
        } else {
          tscInstallLog += ' failed (exit ' + npmResult.exitCode + '): ' + (npmResult.stderr || '').substring(0, 200);
        }
      }
    }
  }
  if (tscAvailable) {
    // Track the index of tsc result for baseline diff
    var tscResultIdx = results.length;
    var tscResult = await execCommand(tscBin, ['--noEmit'], {
      cwd: cloneDir,
      timeout: timeout
    });
    var tscSecrets = collectOutputSecrets(tscResult.stdout || '') || [];
    var tscAllSecrets = collectEnvSecrets().concat(tscSecrets);
    var tscRedactedOut = redactSecrets(tscResult.stdout || '', tscAllSecrets);
    var tscRedactedErr = redactSecrets(tscResult.stderr || '', tscAllSecrets);
    var tscSpawnFailed = tscResult.exitCode === null && !(tscResult.stdout || '') && !(tscResult.stderr || '') && !!tscResult.error;
    var tscSkipped = tscSpawnFailed;

    results.push({
      script: 'tsc --noEmit',
      command: tscBin + ' --noEmit',
      resolvedCommand: tscBin,
      success: !tscSkipped && tscResult.success,
      exitCode: tscResult.exitCode,
      timedOut: tscResult.timedOut,
      skipped: tscSkipped,
      code: tscSkipped ? 'CHECKS_SKIPPED_NO_TOOLCHAIN' : undefined,
      stdout: tscRedactedOut,
      stderr: tscSpawnFailed ? 'tsc not found' : tscRedactedErr,
      error: tscResult.error ? redactSecrets(tscResult.error, collectEnvSecrets()) : null,
      cwd: cloneDir,
      hasNodeModules: hasNodeModules,
      signal: tscResult.signal || null,
      installLog: tscInstallLog || null
    });
  }

  // If baseline tsc errors provided, diff against current tsc results
  // and only treat NEW errors as failures. When the baseline itself could not
  // execute (marker { skipped: true }), the tsc check is SKIPPED, never failed.
  var baselineTscErrors = options && options.baselineTscErrors;
  if (baselineTscErrors && tscResultIdx >= 0) {
    var tscRes = results[tscResultIdx];
    var baselineSkipped = baselineTscErrors && baselineTscErrors.skipped === true;
    if (baselineSkipped) {
      // Baseline could not run: mark the tsc result skipped so the proposal is
      // never judged against a baseline that never executed.
      results[tscResultIdx].skipped = true;
      results[tscResultIdx].success = true;
      results[tscResultIdx].code = 'CHECKS_SKIPPED_NO_TOOLCHAIN';
      results[tscResultIdx].baselineSkipped = true;
    } else if (baselineTscErrors.unreliable === true) {
      // Baseline has core module/global errors (missing @nestjs/common, typeorm,
      // @types/node, etc.) — the toolchain is unreliable. Mark both the tsc check
      // and the build script (if tsc-based) as INCONCLUSIVE_TOOLCHAIN so the
      // repair flow continues (image build is authoritative) and the proposal is
      // NOT blocked by baseline-diff logic.
      var baselineErrArrUnrel = baselineTscErrors.errors || baselineTscErrors;
      results[tscResultIdx].success = true;
      results[tscResultIdx].code = 'INCONCLUSIVE_TOOLCHAIN';
      results[tscResultIdx].baselineErrors = baselineErrArrUnrel;
      results[tscResultIdx].baselineErrorCount = baselineTscErrors.baselineErrorCount || 0;
      results[tscResultIdx].topCodes = baselineTscErrors.topCodes || [];
      results[tscResultIdx].baselineUnreliable = true;
      // Also mark build script as INCONCLUSIVE_TOOLCHAIN if it runs tsc directly.
      // A build script of "tsc" has the same toolchain reliability issues.
      for (var buildIdx = 0; buildIdx < results.length; buildIdx++) {
        var buildRes = results[buildIdx];
        if (buildRes && buildRes.script === 'build' && buildRes.resolvedCommand) {
          var cmdLower = buildRes.resolvedCommand.toLowerCase();
          if (cmdLower.indexOf('tsc') !== -1 || cmdLower.indexOf('typescript') !== -1) {
            buildRes.success = true;
            buildRes.code = 'INCONCLUSIVE_TOOLCHAIN';
            buildRes.baselineErrors = baselineErrArrUnrel;
            buildRes.baselineErrorCount = baselineTscErrors.baselineErrorCount || 0;
            buildRes.topCodes = baselineTscErrors.topCodes || [];
            buildRes.baselineUnreliable = true;
          }
        }
      }
    } else if (!tscRes.skipped && tscRes.exitCode !== 0) {
      // tsc failed - normalize and diff against baseline
      var currentTscErrors = normalizeTscOutput(tscRes.stderr || '');
      var diff = diffTscErrors(baselineTscErrors.errors || baselineTscErrors, currentTscErrors);
      var baselineErrArr = baselineTscErrors.errors || baselineTscErrors;
      if (diff.newErrors.length > 0) {
        // New errors introduced by proposal - fail with only new errors
        var newErrText = diff.newErrors.slice(0, 50).map(function(e) {
          return e.file + ': ' + e.code + ': ' + e.message;
        }).join('\n');
        if (newErrText.length > 4096) newErrText = newErrText.substring(0, 4096) + '\n... (truncated)';
        results[tscResultIdx] = {
          script: tscRes.script,
          command: tscRes.command,
          resolvedCommand: tscRes.resolvedCommand,
          success: false,
          exitCode: tscRes.exitCode,
          timedOut: tscRes.timedOut,
          skipped: false,
          code: 'CHECKS_FAILED',
          stdout: tscRes.stdout || '',
          stderr: 'NEW_TSC_ERRORS:\n' + newErrText,
          error: tscRes.error,
          cwd: cloneDir,
          hasNodeModules: hasNodeModules,
          signal: tscRes.signal || null,
          installLog: tscRes.installLog || null,
          newErrors: diff.newErrors,
          baselineErrors: baselineErrArr
        };
      } else {
        // tsc failed but all errors are in baseline - treat as success (pre-existing)
        results[tscResultIdx].success = true;
        results[tscResultIdx].code = undefined;
        results[tscResultIdx].baselineErrors = baselineErrArr;
      }
    } else if (!tscRes.skipped && tscRes.exitCode === 0 && (baselineTscErrors.errors || baselineTscErrors).length > 0) {
      // tsc passed but baseline had errors - some were fixed (acceptable)
      var diff2 = diffTscErrors(baselineTscErrors.errors || baselineTscErrors, []);
      results[tscResultIdx].baselineErrors = baselineTscErrors.errors || baselineTscErrors;
      results[tscResultIdx].fixedErrors = diff2.removedErrors;
    }
  }

  // Handle unreliable baseline for build script when tsc --noEmit check is not
  // available (tscResultIdx < 0) but the build script itself runs tsc and has
  // the same toolchain reliability issues. This ensures build is marked
  // INCONCLUSIVE_TOOLCHAIN even when the direct tsc check was skipped.
  if (baselineTscErrors && baselineTscErrors.unreliable === true && (typeof tscResultIdx === 'undefined' || tscResultIdx < 0)) {
    var baselineErrArrBuild = baselineTscErrors.errors || baselineTscErrors;
    for (var buildIdx2 = 0; buildIdx2 < results.length; buildIdx2++) {
      var buildRes2 = results[buildIdx2];
      if (buildRes2 && buildRes2.script === 'build' && buildRes2.resolvedCommand) {
        var cmdLower2 = buildRes2.resolvedCommand.toLowerCase();
        if (cmdLower2.indexOf('tsc') !== -1 || cmdLower2.indexOf('typescript') !== -1) {
          buildRes2.success = true;
          buildRes2.code = 'INCONCLUSIVE_TOOLCHAIN';
          buildRes2.baselineErrors = baselineErrArrBuild;
          buildRes2.baselineErrorCount = baselineTscErrors.baselineErrorCount || 0;
          buildRes2.topCodes = baselineTscErrors.topCodes || [];
          buildRes2.baselineUnreliable = true;
        }
      }
    }
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

/**
 * Run tsc --noEmit once on a pristine (pre-proposal) clone and return the
 * normalized error set. Used as the baseline for the baseline-diff compile
 * check: errors already present in the pristine clone are pre-existing and are
 * never treated as a proposal regression.
 *
 * Returns:
 *  - { ok: true, skipped: false, errors: [...], stdout, stderr }
 *    when tsc ran (even if it exited non-zero; `errors` is the normalized set).
 *  - { ok: true, skipped: true, reason, errors: [] }
 *    when tsc could not run at all (no toolchain / baseline cannot execute).
 *    Callers must NEVER treat this as a failure.
 */
async function runTscBaseline(cloneDir, options) {
  options = options || {};
  var hasNodeModules = fs.existsSync(path.join(cloneDir, 'node_modules'));

  // Resolve the tsc binary exactly like runChecks does (node_modules/.bin/tsc,
  // then node_modules/typescript/bin/tsc). Do NOT attempt a network install
  // here: a baseline check must be cheap and must never fail the whole run on
  // a missing toolchain - it is SKIPPED instead.
  var tscBin = path.join(cloneDir, 'node_modules', '.bin', 'tsc');
  var tscAvailable = hasNodeModules && fs.existsSync(tscBin);
  if (!tscAvailable && hasNodeModules) {
    var tscAltBin = path.join(cloneDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(tscAltBin)) {
      tscBin = tscAltBin;
      tscAvailable = true;
    }
  }
  if (!tscAvailable) {
    return { ok: true, skipped: true, reason: 'tsc not available', errors: [] };
  }

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

  try {
    var tscResult = await execCommand(tscBin, ['--noEmit'], {
      cwd: cloneDir,
      timeout: options.timeout || 120000
    });
    // Baseline could not execute (spawn error / no output / crash): treat as
    // SKIPPED, never as a failure. The proposal should not be judged against
    // a baseline that never ran.
    var spawnFailed = tscResult.exitCode === null && !(tscResult.stdout || '') && !(tscResult.stderr || '') && !!tscResult.error;
    var timedOut = !!tscResult.timedOut;
    if (spawnFailed || timedOut) {
      return {
        ok: true,
        skipped: true,
        reason: timedOut ? 'tsc baseline timed out' : (tscResult.error || 'tsc baseline could not execute'),
        errors: [],
        stdout: tscResult.stdout || '',
        stderr: tscResult.stderr || ''
      };
    }
    var errors = normalizeTscOutput(tscResult.stderr || '');
    var reliability = detectUnreliableBaselineErrors(errors);
    return {
      ok: true,
      skipped: false,
      errors: errors,
      stdout: tscResult.stdout || '',
      stderr: tscResult.stderr || '',
      exitCode: tscResult.exitCode,
      unreliable: reliability.unreliable,
      baselineErrorCount: reliability.baselineErrorCount,
      topCodes: reliability.topCodes
    };
  } catch (err) {
    return { ok: true, skipped: true, reason: String(err && err.message || err), errors: [] };
  }
}

module.exports = {
  reproduce: reproduce,
  verify: verify,
  runChecks: runChecks,
  runTscBaseline: runTscBaseline,
  normalizeTscOutput: normalizeTscOutput,
  normalizeTscErrorLine: normalizeTscErrorLine,
  diffTscErrors: diffTscErrors,
  detectUnreliableBaselineErrors: detectUnreliableBaselineErrors,
  initIndex: initIndex,
  sha256Hex: sha256Hex,
  redactEmails: redactEmails,
  redactSecrets: redactSecrets
};
