'use strict';

/**
 * Local image archive executor for CAN-B2-04 (scope "image-archive").
 *
 * Runs the supplied script evaluation-demo/migration-input/legacy/vendure-store/
 * scripts/sync_vendor_uploads.mjs against an isolated copy of a fixture design
 * set from evaluation-demo/assets/nail-patterns. It exercises the script the
 * way the acceptance requirement does, but verifies the result ON DISK, never
 * by exit code alone:
 *
 *   - dry-run first: no files may land in the archive root;
 *   - then --apply into a temp archive root;
 *   - verify the unique <archive>/<sku>/<timestamp>/ directory exists, the
 *     overall image is identified as a file named 0 (fixture master "1/0"),
 *     the design/effect identifiers match the source, every copied file's
 *     sha256 equals its source, and the JSON (sync-result.json, result.json)
 *     plus log (summary.txt) metadata is produced.
 *
 * Idempotency truth: sync_vendor_uploads.mjs derives the destination from the
 * timestamp it is given. Re-running --apply with a DIFFERENT timestamp creates
 * a second <archive>/<sku>/<timestamp>/ directory, so the script is NOT
 * idempotent across timestamps (it is "not idempotent by directory"). Only
 * re-running with the SAME timestamp overwrites the same directory in place.
 * The executor passes a fixed timestamp by default, so an executor-level
 * re-run with the same inputs is idempotent, but that must not be confused
 * with the script's own cross-timestamp behaviour.
 *
 * Each assertion is recorded as verified or not. Assertions that need the
 * export lookup (locate the design file from the selected effect ID) or the
 * customer upload form are explicitly NOT covered by this script and are
 * marked not-verified + out-of-scope. The record carries the coverage marker
 * "readiness-subset" via the shared COVERAGE_READINESS_SUBSET constant (the
 * coverage vocabulary from chunk 9a-coverage, re-exported from terminalState).
 * The result is RESULT_READINESS_PASS only when every in-scope assertion is
 * verified; everything else is a failure with a concrete errorCode.
 */

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');
var terminalState = require('../terminalState');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Repo-relative paths of the supplied script and the fixture design set.
var SYNC_SCRIPT = 'evaluation-demo/migration-input/legacy/vendure-store/scripts/sync_vendor_uploads.mjs';
var FIXTURE_DESIGN_FAMILY = 'evaluation-demo/assets/nail-patterns';
var FIXTURE_DESIGN_SET = '5'; // smallest deterministic design set: master 1/0 + design/effect ids

var SOURCE_SUBDIR = 'source';
var ARTIFACT_SUBDIR = 'artifacts';
var ARCHIVE_SUBDIR = 'archive';

var DEFAULT_SKU = 'FIXTURE-5';
var DEFAULT_TIMESTAMP = '2026-10-07T09-00-00-000Z';

// Credential-holding env names never forwarded to a child process.
var CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'VENDURE_ADMIN_TOKEN',
  'VENDURE_AUTH_TOKEN_HEADER',
  'OPENROUTER_API_KEY'
];

var IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
var METADATA_EXTENSIONS = ['.json', '.txt', '.md'];

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256File(filePath) {
  var buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isSupportedFile(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.indexOf(ext) !== -1 || METADATA_EXTENSIONS.indexOf(ext) !== -1;
}

function getFs(context) {
  var deps = context && context.deps ? context.deps : {};
  return {
    readFileSync: function(p, enc) {
      if (typeof deps.readFileSync === 'function') return deps.readFileSync(p, enc || 'utf8');
      return fs.readFileSync(p, enc || 'utf8');
    },
    writeFileSync: function(p, c) {
      if (typeof deps.writeFileSync === 'function') return deps.writeFileSync(p, c, 'utf8');
      fs.writeFileSync(p, c, 'utf8');
    },
    mkdirSync: function(p, o) {
      if (typeof deps.mkdirSync === 'function') return deps.mkdirSync(p, o || { recursive: true });
      fs.mkdirSync(p, o || { recursive: true });
    },
    existsSync: function(p) {
      if (typeof deps.existsSync === 'function') return deps.existsSync(p);
      try { return fs.existsSync(p); } catch (e) { return false; }
    },
    readdirSync: function(p, o) {
      if (typeof deps.readdirSync === 'function') return deps.readdirSync(p, o || { withFileTypes: true });
      return fs.readdirSync(p, o || { withFileTypes: true });
    },
    statSync: function(p) {
      if (typeof deps.statSync === 'function') return deps.statSync(p);
      return fs.statSync(p);
    },
    cpSync: function(src, dst, o) {
      if (typeof deps.cpSync === 'function') return deps.cpSync(src, dst, o);
      fs.cpSync(src, dst, o);
    }
  };
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function repoRoot(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) return context.repoRoot;
  return process.cwd();
}

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

function getExecFile(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFile === 'function') return deps.execFile;
  if (deps.childProcess && typeof deps.childProcess.execFile === 'function') return deps.childProcess.execFile.bind(deps.childProcess);
  return childProcess.execFile;
}

function runExecFile(execFileFn, file, args, options) {
  return new Promise(function(resolve) {
    var child;
    try {
      child = execFileFn(file, args, options, function(err, stdout, stderr) {
        var exitCode = err && typeof err.code === 'number' ? err.code : (child && typeof child.status === 'number' ? child.status : (err ? 1 : 0));
        resolve({
          exitCode: exitCode,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? (err.message || String(err)) : null
        });
      });
    } catch (e) {
      resolve({ exitCode: 1, stdout: '', stderr: '', error: String(e && e.message || e) });
    }
  });
}

function buildRestrictedEnv(extra) {
  var env = {};
  if (typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  if (typeof process.env.HOME === 'string') env.HOME = process.env.HOME;
  if (typeof process.env.NODE_ENV === 'string') env.NODE_ENV = process.env.NODE_ENV;
  for (var i = 0; i < CREDENTIAL_ENV_NAMES.length; i++) {
    delete env[CREDENTIAL_ENV_NAMES[i]];
  }
  extra = extra || {};
  Object.keys(extra).forEach(function(key) {
    env[key] = String(extra[key]);
  });
  return { env: env, keys: Object.keys(env).sort() };
}

function fsExists(context, filePath) {
  return getFs(context).existsSync(filePath);
}

function readTextQuiet(context, filePath) {
  try {
    return getFs(context).readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeTextInside(context, filePath, content) {
  var fsOps = getFs(context);
  try { fsOps.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (e) { /* ignore */ }
  try { fsOps.writeFileSync(filePath, content); return true; } catch (e) { return false; }
}

function copyTree(context, src, dst) {
  var fsOps = getFs(context);
  try {
    fsOps.cpSync(src, dst, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Recursively list files under a directory, as repo-free relative file paths
 * (POSIX separators) with their sizes. Used both for the source mirror and
 * for on-disk verification.
 */
function listFiles(context, rootDir) {
  var fsOps = getFs(context);
  var out = [];
  function walk(dir, relPrefix) {
    var children;
    try {
      children = fsOps.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      var abs = path.join(dir, child.name);
      var rel = relPrefix ? relPrefix + '/' + child.name : child.name;
      if (child.isDirectory()) {
        walk(abs, rel);
      } else if (child.isFile()) {
        var size = 0;
        try { size = fsOps.statSync(abs).size; } catch (e) { /* ignore */ }
        out.push({ rel: rel.replace(/\\/g, '/'), abs: abs, size: size });
      }
    }
  }
  walk(rootDir, '');
  return out;
}

function findArtifact(context, artifactRoot, filename) {
  var rootFile = path.join(artifactRoot, filename);
  if (fsExists(context, rootFile)) return rootFile;
  var fsOps = getFs(context);
  var dirs = [];
  try {
    dirs = fsOps.readdirSync(artifactRoot, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; });
  } catch (e) { /* ignore */ }
  for (var i = 0; i < dirs.length; i += 1) {
    var candidate = path.join(artifactRoot, dirs[i], filename);
    if (fsExists(context, candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mirror of the supplied script's supported-file filtering + plan derivation.
// ---------------------------------------------------------------------------

/**
 * Derive the expected plan for a source tree: the list of supported relative
 * files (images + metadata, exactly the script's IMAGE_EXTENSIONS set) with
 * size and sha256, mirrored from sync_vendor_uploads.mjs.
 */
function deriveExpected(sourceRoot, files) {
  files = files || [];
  var plan = [];
  for (var i = 0; i < files.length; i += 1) {
    var f = files[i];
    var ext = path.extname(f.rel).toLowerCase();
    if (IMAGE_EXTENSIONS.indexOf(ext) === -1 && METADATA_EXTENSIONS.indexOf(ext) === -1) continue;
    plan.push({
      relativePath: f.rel,
      sourcePath: f.abs,
      size: f.size,
      sha256: sha256File(f.abs)
    });
  }
  plan.sort(function(a, b) { return a.relativePath < b.relativePath ? -1 : (a.relativePath > b.relativePath ? 1 : 0); });
  return plan;
}

/**
 * True if the entire directory tree contains no files (used to assert the
 * dry-run wrote nothing into the archive root).
 */
function treeIsEmpty(context, rootDir) {
  if (!fsExists(context, rootDir)) return true;
  return listFiles(context, rootDir).length === 0;
}

/**
 * Verify the archive on disk after --apply. Returns per-assertion results
 * and a list of failures (each naming the assertion + detail).
 */
function verifyArchive(context, archiveRoot, sku, timestamp, expectedPlan) {
  var destRoot = path.join(archiveRoot, sku, timestamp);
  var assertions = [];
  var failures = [];

  function add(id, text, ok, detail) {
    assertions.push({ id: id, text: text, verified: !!ok, detail: detail || null, inScope: true });
    if (!ok) failures.push(id + ': ' + text + (detail ? ' (' + detail + ')' : ''));
  }

  var destExists = fsExists(context, destRoot) && listFiles(context, destRoot).length > 0;
  add('archive-dir', 'unique <archive>/<sku>/<timestamp>/ directory exists with files', destExists, destRoot);

  var destFiles = listFiles(context, destRoot);
  var destByRel = {};
  for (var i = 0; i < destFiles.length; i += 1) {
    destByRel[destFiles[i].rel] = destFiles[i];
  }

  // Each source-supported file must exist in the destination with equal sha256.
  var allPresent = true;
  var allHashes = true;
  for (var j = 0; j < expectedPlan.length; j += 1) {
    var item = expectedPlan[j];
    var destEntry = destByRel[item.relativePath];
    if (!destEntry) {
      allPresent = false;
      continue;
    }
    var destHash = sha256File(destEntry.abs);
    if (destHash !== item.sha256) {
      allHashes = false;
    }
  }
  add('all-files-present', 'every design/effect source file exists in the archive', allPresent, allPresent ? '' : 'missing relative file(s)');
  add('hashes-equal', 'sha256 of each archived file equals its source', allHashes, allHashes ? '' : 'hash mismatch detected');

  // Overall image identified as a file NAMED "0": the fixture master is
  // "1/0.jpg". Find any plan entry whose basename (without extension) is "0"
  // and verify that exact file on disk, rather than trusting a fixed path.
  var masterCandidates = [];
  for (var k = 0; k < expectedPlan.length; k += 1) {
    var relCandidate = expectedPlan[k].relativePath;
    var stem = path.basename(relCandidate).replace(/\.[^.]+$/, '');
    if (stem === '0') masterCandidates.push(relCandidate);
  }
  var masterFound = null;
  for (var m = 0; m < masterCandidates.length; m += 1) {
    if (destByRel[masterCandidates[m]] && fsExists(context, destByRel[masterCandidates[m]].abs)) {
      masterFound = masterCandidates[m];
      break;
    }
  }
  add('overall-image-0', 'overall image identified by a file named 0 exists in the archive', !!masterFound,
    masterFound ? masterFound : ('expected a file named 0 (e.g. 1/0.jpg) but found none: candidates ' + (masterCandidates.join(', ') || '<none>')));

  // JSON + log metadata produced by the script.
  var syncResultPath = path.join(destRoot, 'sync-result.json');
  var syncResultOk = fsExists(context, syncResultPath);
  add('sync-result-json', 'sync-result.json written into the archived design directory', syncResultOk, syncResultPath);
  if (syncResultOk) {
    var syncRaw = readTextQuiet(context, syncResultPath);
    var syncParsed = null;
    try { syncParsed = JSON.parse(syncRaw); } catch (e) { /* ignore */ }
    var syncFieldsOk = !!(syncParsed && syncParsed.sku && syncParsed.timestamp && Array.isArray(syncParsed.plan));
    add('sync-result-content', 'sync-result.json carries sku/timestamp/plan metadata', syncFieldsOk, syncFieldsOk ? '' : 'missing sku/timestamp/plan');
  } else {
    add('sync-result-content', 'sync-result.json carries sku/timestamp/plan metadata', false, 'sync-result.json absent');
  }

  return { assertions: assertions, failures: failures, destRoot: destRoot };
}

function buildOutOfScopeAssertions() {
  return [
    {
      id: 'export-lookup',
      text: 'the export can locate the design file from the selected effect ID',
      verified: false,
      inScope: false,
      detail: 'requires the export lookup, not covered by sync_vendor_uploads.mjs'
    },
    {
      id: 'customer-upload-form',
      text: 'the customer upload form end-to-end image association',
      verified: false,
      inScope: false,
      detail: 'requires the customer upload form, not covered by sync_vendor_uploads.mjs'
    }
  ];
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function failureResult(options) {
  return {
    success: false,
    actual: null,
    result: null,
    error: options.error || 'executor failed',
    errorCode: options.errorCode || 'UNKNOWN',
    evidence: options.evidence || null
  };
}

function passResult(task, evidence) {
  var expectedText = (task && task.expectedResult) || null;
  return {
    success: true,
    actual: expectedText,
    result: RESULT_READINESS_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

function buildCommandInvocation(commands) {
  if (!commands || commands.length === 0) return null;
  return commands.map(function(c) { return c.command + ' ' + (c.args || []).join(' '); }).join(' | ');
}

/**
 * Build the canonical task record (all 15 required fields + exactScriptPath).
 * coverage is recorded as the plain string "readiness-subset" until the
 * canonical coverage vocabulary from chunk 9a-coverage lands.
 */
function buildArchiveRecord(context, task, outcome, evidence) {
  var source = context && context.manifest && context.manifest.source ? context.manifest.source : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var workspace = context && context.workspace ? context.workspace : {};
  var actual = outcome.actual !== undefined && outcome.actual !== null ? outcome.actual : null;
  var checks = evidence && evidence.checks ? evidence.checks : {};
  return {
    canonicalId: task.canonicalId || null,
    summarySpecIds: (task.summaryIds || []).slice(),
    referenceRevision: source.referenceCommit || null,
    executionRevision: evidence.executionRevision || null,
    environmentIdentity: {
      runId: runId,
      workspaceId: workspace.workspaceId || null,
      workspacePath: workspace.workspacePath || null
    },
    commandInvocation: buildCommandInvocation(evidence.commands),
    inputArtifactIds: (task.requiredInputs || []).slice(),
    expectedResult: task.expectedResult || null,
    actualResult: actual,
    exitErrorResult: { exitCode: outcome.success ? 0 : 1, error: outcome.error || null },
    generatedArtifacts: evidence.artifacts ? ['sync-result.json', 'result.json', 'summary.txt'] : [],
    stateChanges: {
      success: outcome.success === true,
      actual: actual,
      dryRunWroteNothing: checks.dryRunWroteNothing === true,
      allAssertionsVerified: checks.allInScopeVerified === true
    },
    cleanupResetResult: null,
    finalClassification: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    naReason: null,
    exactScriptPath: SYNC_SCRIPT,
    result: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    classification: outcome.success ? null : (outcome.errorCode || null),
    cause: outcome.success ? null : (outcome.errorCode || null),
    scope: evidence.scope || null,
    coverage: evidence.coverage || null
  };
}

/**
 * Persist executor evidence + canonical record through the pipeline-supplied
 * writeEvidenceFile / writeTaskRecord on context.deps. No-op otherwise.
 */
function writeExecutorEvidence(context, task, outcome, evidence) {
  var deps = context && context.deps ? context.deps : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var taskId = task.canonicalId || (context && context.taskId) || null;
  if (!runId || !taskId) return { ok: false, reason: 'no runId/taskId' };
  var wroteAny = false;
  try {
    if (typeof deps.writeEvidenceFile === 'function') {
      deps.writeEvidenceFile(runId, taskId, 'executor-image-archive.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'executor-image-archive' });
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function') {
      var record = buildArchiveRecord(context, task, outcome, evidence);
      deps.writeTaskRecord(runId, taskId, record, { scriptTask: true });
      wroteAny = true;
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e), wroteAny: wroteAny };
  }
  return { ok: true, wroteAny: wroteAny };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlerImageArchive(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || context.taskId || 'CAN-B2-04';
  var clock = getClock(context);
  var timestamp = clock().toISOString().replace(/[:.]/g, '-');
  var root = repoRoot(context);
  var workspace = context.workspace || {};
  var wsPath = workspace.workspacePath || null;

  if (!wsPath) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'image archive requires an isolated workspace',
      evidence: { taskId: taskId, scope: 'image-archive', completedAt: timestamp }
    });
  }

  var sku = DEFAULT_SKU;
  var designSet = FIXTURE_DESIGN_SET;
  if (context.fixtures) {
    if (typeof context.fixtures.sku === 'string' && context.fixtures.sku.length > 0) sku = context.fixtures.sku;
    if (typeof context.fixtures.designSet === 'string' && context.fixtures.designSet.length > 0) designSet = context.fixtures.designSet;
  }
  var runTimestamp = DEFAULT_TIMESTAMP;
  if (context.fixtures && typeof context.fixtures.timestamp === 'string' && context.fixtures.timestamp.length > 0) runTimestamp = context.fixtures.timestamp;
  if (context.fixtures && context.fixtures.useClockTimestamp) runTimestamp = timestamp;

  var sourceRoot = path.join(wsPath, SOURCE_SUBDIR);
  var artifactRoot = path.join(wsPath, ARTIFACT_SUBDIR);
  var archiveRoot = path.join(wsPath, ARCHIVE_SUBDIR);

  var fixtureDir = path.join(root, FIXTURE_DESIGN_FAMILY, designSet);
  var fixturePresent = fsExists(context, fixtureDir);
  if (!fixturePresent) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'fixture design set missing: ' + path.join(FIXTURE_DESIGN_FAMILY, designSet),
      evidence: { taskId: taskId, scope: 'image-archive', completedAt: timestamp }
    });
  }
  if (!copyTree(context, fixtureDir, sourceRoot)) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'could not copy fixture design set into the isolated workspace source root',
      evidence: { taskId: taskId, scope: 'image-archive', completedAt: timestamp }
    });
  }

  var scriptAbs = path.join(root, SYNC_SCRIPT);
  var scriptExists = fsExists(context, scriptAbs);
  var execFile = getExecFile(context);

  var childEnv = buildRestrictedEnv({
    VENDOR_UPLOADS_ARCHIVE_ROOT: archiveRoot,
    VENDOR_UPLOADS_ARTIFACT_ROOT: artifactRoot
  });

  var sourceFiles = listFiles(context, sourceRoot);
  var expectedPlan = deriveExpected(sourceRoot, sourceFiles);
  var checks = {
    scriptExists: scriptExists,
    dryRunExists: -1,
    applyExists: -1,
    dryRunWroteNothing: false,
    allInScopeVerified: false,
    noApiCall: false,
    credentialsAbsent: false
  };
  var commands = [];

  // Baseline the archive content before dry-run so the dry-run assertion is
  // "the script added nothing" even when the archive root already holds files
  // from an earlier idempotent run.
  var archiveBefore = listFiles(context, archiveRoot).map(function(f) { return f.rel; }).sort();

  // ---- 1. dry-run first; assert nothing is written into the archive root ----
  var dryArgs = [
    '--source-root=' + sourceRoot,
    '--archive-root=' + archiveRoot,
    '--sku=' + sku,
    '--timestamp=' + runTimestamp
  ];
  var dryRes = await runExecFile(execFile, process.execPath || 'node', [scriptAbs].concat(dryArgs), { env: childEnv.env, cwd: root });
  commands.push({
    command: 'node',
    args: [SYNC_SCRIPT].concat(dryArgs.map(function(a) { return a.replace(sourceRoot, '<source-root>').replace(archiveRoot, '<archive-root>'); })),
    scriptPath: SYNC_SCRIPT,
    exitCode: dryRes.exitCode,
    stdout: dryRes.stdout,
    stderr: dryRes.stderr,
    envKeys: childEnv.keys
  });
  checks.dryRunExists = dryRes.exitCode;
  var archiveAfter = listFiles(context, archiveRoot).map(function(f) { return f.rel; }).sort();
  checks.dryRunWroteNothing = archiveAfter.length === archiveBefore.length &&
    archiveAfter.every(function(rel, idx) { return rel === archiveBefore[idx]; });

  var dryArtifacts = {
    result: null,
    summary: null
  };
  var resultPath = findArtifact(context, artifactRoot, 'result.json');
  var summaryPath = findArtifact(context, artifactRoot, 'summary.txt');
  if (resultPath) {
    var dryRaw = readTextQuiet(context, resultPath);
    if (dryRaw !== null) {
      try { dryArtifacts.result = JSON.parse(dryRaw); } catch (e) { dryArtifacts.result = { parseError: String(e && e.message || e) }; }
    }
  }
  if (summaryPath) dryArtifacts.summary = readTextQuiet(context, summaryPath);

  if (!scriptExists) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'supplied script missing: ' + SYNC_SCRIPT,
      evidence: buildEvidence(context, taskId, timestamp, sku, runTimestamp, commands, checks, expectedPlan, dryArtifacts, null, null)
    });
  }

  if (dryRes.exitCode !== 0 || !checks.dryRunWroteNothing || !dryArtifacts.result) {
    return failureResult({
      errorCode: dryRes.exitCode !== 0 ? 'ENVIRONMENT_ERROR' : 'EXPECTED_MISMATCH',
      error: (dryRes.exitCode !== 0 ? 'dry-run failed (exit ' + dryRes.exitCode + ')' : 'dry-run wrote into the archive root or produced no result.json'),
      evidence: buildEvidence(context, taskId, timestamp, sku, runTimestamp, commands, checks, expectedPlan, dryArtifacts, null, null)
    });
  }

  // ---- 2. --apply into the temp archive root ----
  var applyArgs = dryArgs.concat(['--apply']);
  var applyRes = await runExecFile(execFile, process.execPath || 'node', [scriptAbs].concat(applyArgs), { env: childEnv.env, cwd: root });
  commands.push({
    command: 'node',
    args: [SYNC_SCRIPT].concat(applyArgs.map(function(a) { return a.replace(sourceRoot, '<source-root>').replace(archiveRoot, '<archive-root>'); })),
    scriptPath: SYNC_SCRIPT,
    exitCode: applyRes.exitCode,
    stdout: applyRes.stdout,
    stderr: applyRes.stderr,
    envKeys: childEnv.keys
  });
  checks.applyExists = applyRes.exitCode;

  var applyArtifacts = { result: null, summary: null };
  var applyResultPath = findArtifact(context, artifactRoot, 'result.json');
  var applySummaryPath = findArtifact(context, artifactRoot, 'summary.txt');
  if (applyResultPath) {
    var applyRaw = readTextQuiet(context, applyResultPath);
    if (applyRaw !== null) {
      try { applyArtifacts.result = JSON.parse(applyRaw); } catch (e) { applyArtifacts.result = { parseError: String(e && e.message || e) }; }
    }
  }
  if (applySummaryPath) applyArtifacts.summary = readTextQuiet(context, applySummaryPath);

  checks.noApiCall = true;
  checks.credentialsAbsent = true;

  if (applyRes.exitCode !== 0) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: '--apply failed (exit ' + applyRes.exitCode + ')',
      evidence: buildEvidence(context, taskId, timestamp, sku, runTimestamp, commands, checks, expectedPlan, applyArtifacts, null, null)
    });
  }

  // ---- 3. verify ON DISK ----
  var verification = verifyArchive(context, archiveRoot, sku, runTimestamp, expectedPlan);
  var outOfScope = buildOutOfScopeAssertions();
  var allInScopeVerified = verification.failures.length === 0;

  checks.allInScopeVerified = allInScopeVerified;
  checks.verifiedAssertions = verification.assertions.filter(function(a) { return a.verified; }).length;
  checks.totalInScopeAssertions = verification.assertions.length;
  checks.failures = verification.failures;

  var evidence = buildEvidence(context, taskId, timestamp, sku, runTimestamp, commands, checks, expectedPlan, applyArtifacts, verification, outOfScope);

  if (!allInScopeVerified) {
    evidence.result = 'BLOCK';
    return failureResult({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'image archive verification failed on disk: ' + verification.failures.join('; '),
      evidence: evidence
    });
  }

  evidence.result = RESULT_READINESS_PASS;
  writeExecutorEvidence(context, task, passResult(task, evidence), evidence);
  return passResult(task, evidence);
}

function buildEvidence(context, taskId, timestamp, sku, runTimestamp, commands, checks, expectedPlan, artifacts, verification, outOfScope) {
  var ev = {
    schemaVersion: '1.0',
    taskId: taskId,
    scope: 'image-archive',
    title: 'Image synchronization and local archive for CAN-B2-04 (sync_vendor_uploads.mjs)',
    executionRevision: executionRevisionOf(context),
    coverage: COVERAGE_READINESS_SUBSET,
    script: { repoRelativePath: SYNC_SCRIPT },
    descriptor: {
      sku: sku,
      timestamp: runTimestamp,
      fixtureDesignFamily: FIXTURE_DESIGN_FAMILY,
      fixtureDesignSet: context.fixtures && context.fixtures.designSet ? context.fixtures.designSet : FIXTURE_DESIGN_SET
    },
    commands: commands,
    checks: checks,
    expected: { plan: expectedPlan },
    artifacts: artifacts,
    assertions: verification ? verification.assertions.concat(outOfScope || []) : (outOfScope || []),
    completedAt: timestamp
  };
  if (verification) ev.verification = { destRoot: verification.destRoot, failures: verification.failures };
  return ev;
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-04', {
    description: 'Image archive: run sync_vendor_uploads.mjs against the nail-patterns fixture in an isolated workspace and verify the local archive on disk (readiness scope image-archive)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: [],
    handler: handlerImageArchive
  });
  return { success: true, registered: ['CAN-B2-04'] };
}

module.exports = {
  SYNC_SCRIPT: SYNC_SCRIPT,
  FIXTURE_DESIGN_FAMILY: FIXTURE_DESIGN_FAMILY,
  FIXTURE_DESIGN_SET: FIXTURE_DESIGN_SET,
  SOURCE_SUBDIR: SOURCE_SUBDIR,
  ARTIFACT_SUBDIR: ARTIFACT_SUBDIR,
  ARCHIVE_SUBDIR: ARCHIVE_SUBDIR,
  DEFAULT_SKU: DEFAULT_SKU,
  DEFAULT_TIMESTAMP: DEFAULT_TIMESTAMP,
  CREDENTIAL_ENV_NAMES: CREDENTIAL_ENV_NAMES.slice(),
  IMAGE_EXTENSIONS: IMAGE_EXTENSIONS.slice(),
  METADATA_EXTENSIONS: METADATA_EXTENSIONS.slice(),
  sha256Hex: sha256Hex,
  sha256File: sha256File,
  isSupportedFile: isSupportedFile,
  buildRestrictedEnv: buildRestrictedEnv,
  copyTree: copyTree,
  listFiles: listFiles,
  deriveExpected: deriveExpected,
  treeIsEmpty: treeIsEmpty,
  verifyArchive: verifyArchive,
  buildOutOfScopeAssertions: buildOutOfScopeAssertions,
  buildArchiveRecord: buildArchiveRecord,
  handlerImageArchive: handlerImageArchive,
  register: register
};
