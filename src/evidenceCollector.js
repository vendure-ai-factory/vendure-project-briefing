'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

/**
 * Evidence collector and index for canonical acceptance tasks.
 *
 * Layout:
 *   evidence/<runId>/index.json                 - per-run index (schema 1.0)
 *   evidence/<runId>/<CAN-ID>/<filename>        - one folder per canonical task
 *   evidence/<runId>/<CAN-ID>/record.json       - task record (all 15 fields)
 *
 * Every evidence file is written through writeEvidenceFile, which redacts
 * secret values, computes a sha256 of the final content, stamps a UTC
 * timestamp and appends {path, sha256, timestamp, kind} to the run index.
 */

var EV_SCHEMA_VERSION = '1.0';
var EV_DEFAULT_ROOT = 'evidence';
var KIND_ARTIFACT = 'artifact';
var KIND_RECORD = 'record';
var MISSING_EVIDENCE = 'MISSING_EVIDENCE';

/**
 * All 15 fields from manifest section 8 that every task record must carry.
 * For script tasks exactScriptPath is additionally required.
 */
var REQUIRED_TASK_FIELDS = [
  'canonicalId',
  'summarySpecIds',
  'referenceRevision',
  'executionRevision',
  'environmentIdentity',
  'commandInvocation',
  'inputArtifactIds',
  'expectedResult',
  'actualResult',
  'exitErrorResult',
  'generatedArtifacts',
  'stateChanges',
  'cleanupResetResult',
  'finalClassification',
  'naReason'
];

var REQUIRED_SCRIPT_FIELD = 'exactScriptPath';

var SENSITIVE_ENV_KEY_RE = /(api[_-]?key|secret|password|passwd|token|credential|auth)/i;
var REDACTED_MARKER = '[REDACTED]';

function resolveRoot(options) {
  options = options || {};
  return path.resolve(options.root || process.cwd(), options.baseDir || EV_DEFAULT_ROOT);
}

function runDir(root, runId) {
  return path.join(root, runId);
}

function indexFile(root, runId) {
  return path.join(runDir(root, runId), 'index.json');
}

/**
 * Collect the map of secret values to redact.
 * Emv var VALUES for sensitive-looking names are redacted; explicit secrets
 * supplied via options.secrets are always redacted. Env var NAMES are fine.
 */
function collectSecrets(options) {
  options = options || {};
  var secrets = {};
  var candidateMap = {};

  var envSource = options.env || process.env || {};
  var envKeys = Object.keys(envSource);
  for (var i = 0; i < envKeys.length; i++) {
    var key = envKeys[i];
    var value = envSource[key];
    if (typeof value === 'string' && value.length > 0 && SENSITIVE_ENV_KEY_RE.test(key)) {
      candidateMap['env:' + key] = value;
    }
  }

  var explicit = options.secrets || {};
  var explicitKeys = Object.keys(explicit);
  for (var j = 0; j < explicitKeys.length; j++) {
    var ek = explicitKeys[j];
    var ev = explicit[ek];
    if (typeof ev === 'string' && ev.length > 0) {
      candidateMap['explicit:' + ek] = ev;
    }
  }

  var names = Object.keys(candidateMap);
  // Longest values first so overlapping secrets redact fully.
  var sorted = names.slice().sort(function(a, b) {
    return candidateMap[b].length - candidateMap[a].length;
  });
  for (var k = 0; k < sorted.length; k++) {
    secrets[sorted[k]] = candidateMap[sorted[k]];
  }
  return {
    names: names,
    values: sorted.map(function(name) { return candidateMap[name]; })
  };
}

function redactContent(content, secretValues) {
  if (!secretValues || secretValues.length === 0) {
    return content;
  }
  var result = content;
  for (var i = 0; i < secretValues.length; i++) {
    var value = secretValues[i];
    if (!value || !result.includes(value)) {
      continue;
    }
    result = result.split(value).join(REDACTED_MARKER);
  }
  return result;
}

function sha256Hex(content, options) {
  var cryptoImpl = options && options.crypto ? options.crypto : crypto;
  return cryptoImpl.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Create evidence/<runId>/index.json with the schema 1.0 shape.
 * meta: { executionRevision, referenceCommit, protectedPathsHash }
 * If the index already exists it is replaced (fresh run index).
 */
function initEvidenceIndex(runId, meta, options) {
  if (!runId) {
    throw new Error('initEvidenceIndex: runId is required');
  }
  if (!meta) {
    meta = {};
  }
  var root = resolveRoot(options);
  var dir = runDir(root, runId);
  ensureDir(dir);

  var index = {
    schemaVersion: EV_SCHEMA_VERSION,
    runId: runId,
    executionRevision: meta.executionRevision || null,
    referenceCommit: meta.referenceCommit || null,
    protectedPathsHash: meta.protectedPathsHash || null,
    meta: (meta.meta && typeof meta.meta === 'object') ? meta.meta : {},
    tasks: {}
  };
  var serialized = JSON.stringify(index, null, 2) + '\n';
  var finalContent = redactContent(serialized, collectSecrets(options).values);
  fs.writeFileSync(indexFile(root, runId), finalContent, 'utf8');
  return { ok: true, index: JSON.parse(finalContent) };
}

function loadIndex(root, runId) {
  var indexPath = indexFile(root, runId);
  if (!fs.existsSync(indexPath)) {
    return { exists: false, index: null };
  }
  var content;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch (e) {
    return { exists: true, index: null, error: e.message };
  }
  var parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { exists: true, index: null, error: e.message };
  }
  return { exists: true, index: parsed };
}

/**
 * Patch the run-level "meta" object in index.json (e.g. the run-level
 * protected-end hash). The index itself is the ledger and is not hashed, so
 * patching meta is safe for existing file entries.
 */
function updateRunMeta(runId, patch, options) {
  if (!runId) throw new Error('updateRunMeta: runId is required');
  options = options || {};
  var root = resolveRoot(options);
  var loaded = loadIndex(root, runId);
  if (!loaded.exists || !loaded.index) {
    initEvidenceIndex(runId, {}, { root: root });
    loaded = loadIndex(root, runId);
  }
  var index = loaded.index;
  if (!index.meta || typeof index.meta !== 'object') {
    index.meta = {};
  }
  var keys = Object.keys(patch || {});
  for (var i = 0; i < keys.length; i++) {
    index.meta[keys[i]] = patch[keys[i]];
  }
  var serialized = JSON.stringify(index, null, 2) + '\n';
  var finalContent = redactContent(serialized, collectSecrets({ env: process.env }).values);
  fs.writeFileSync(indexFile(root, runId), finalContent, 'utf8');
  return { ok: true, meta: index.meta };
}

/**
 * Append a fresh file entry to the given task list and persist the index.
 * Internal: called by writeEvidenceFile / writeTaskRecord.
 */
function updateEvidenceIndex(root, runId, taskId, entry) {
  var loaded = loadIndex(root, runId);
  if (!loaded.exists || !loaded.index) {
    // Auto-initialise a minimal run index so evidence can be recorded without
    // an explicit init call.
    initEvidenceIndex(runId, {}, { root: root });
    loaded = loadIndex(root, runId);
  }
  if (!loaded.index.tasks) {
    loaded.index.tasks = {};
  }
  if (!loaded.index.tasks[taskId]) {
    loaded.index.tasks[taskId] = [];
  }
  loaded.index.tasks[taskId].push(entry);
  var serialized = JSON.stringify(loaded.index, null, 2) + '\n';
  var finalContent = redactContent(serialized, collectSecrets({ env: process.env }).values);
  fs.writeFileSync(indexFile(root, runId), finalContent, 'utf8');
}

/**
 * Write one evidence file for a canonical task.
 * Records {path, sha256, timestamp, kind} in the run index.
 *
 * @param {string} runId - run identifier
 * @param {string} taskId - canonical id (CAN-ID)
 * @param {string} filename - name of the evidence file (may include subpath)
 * @param {string} content - raw content (may include secrets; gets redacted)
 * @param {Object} options - { kind, secrets, root, baseDir, env, crypto }
 */
function writeEvidenceFile(runId, taskId, filename, content, options) {
  if (!runId) throw new Error('writeEvidenceFile: runId is required');
  if (!taskId) throw new Error('writeEvidenceFile: taskId is required');
  if (!filename) throw new Error('writeEvidenceFile: filename is required');
  if (typeof content !== 'string') {
    content = JSON.stringify(content, null, 2);
  }
  options = options || {};
  var root = resolveRoot(options);
  var dir = runDir(root, runId);
  var taskDir = path.join(dir, taskId);
  ensureDir(taskDir);

  var secrets = collectSecrets(options);
  var finalContent = redactContent(content, secrets.values);
  var fileHash = sha256Hex(finalContent, options);
  var timestamp = new Date().toISOString();
  var kind = options.kind || KIND_ARTIFACT;

  var relPath = path.join(taskId, filename).replace(/\\/g, '/');
  var absPath = path.join(dir, relPath);
  var fileDir = path.dirname(absPath);
  ensureDir(fileDir);
  fs.writeFileSync(absPath, finalContent, 'utf8');

  var entry = {
    path: relPath,
    sha256: fileHash,
    timestamp: timestamp,
    kind: kind
  };
  updateEvidenceIndex(root, runId, taskId, entry);
  return { ok: true, path: relPath, sha256: fileHash, timestamp: timestamp, index: entry };
}

function validateTaskRecord(record, isScriptTask) {
  var missing = [];
  for (var i = 0; i < REQUIRED_TASK_FIELDS.length; i++) {
    var field = REQUIRED_TASK_FIELDS[i];
    if (record[field] === undefined) {
      missing.push(field);
    }
  }
  if (isScriptTask && record[REQUIRED_SCRIPT_FIELD] === undefined) {
    missing.push(REQUIRED_SCRIPT_FIELD);
  }
  return missing;
}

/**
 * Write evidence/<runId>/<CAN-ID>/record.json with ALL 15 fields from
 * manifest section 8. For script tasks exactScriptPath is also required.
 * Missing required fields throw with the field name and never write a
 * partial record.
 */
function writeTaskRecord(runId, taskId, record, options) {
  if (!runId) throw new Error('writeTaskRecord: runId is required');
  if (!taskId) throw new Error('writeTaskRecord: taskId is required');
  if (!record || typeof record !== 'object') {
    throw new Error('writeTaskRecord: record must be an object');
  }
  options = options || {};
  var missing = validateTaskRecord(record, !!options.scriptTask);
  if (missing.length > 0) {
    throw new Error('writeTaskRecord: missing required field(s): ' + missing.join(', '));
  }
  // Coverage extras are merged into the record when supplied by the caller.
  if (options.coverage !== undefined) record.coverage = options.coverage;
  if (options.coverageAssertions !== undefined) record.coverageAssertions = options.coverageAssertions;
  // Never write partial record: record encodes field presence before write.
  var fileContent = JSON.stringify(record, null, 2) + '\n';
  var result = writeEvidenceFile(runId, taskId, 'record.json', fileContent, {
    kind: KIND_RECORD,
    root: options.root,
    baseDir: options.baseDir,
    env: options.env,
    secrets: options.secrets,
    crypto: options.crypto
  });
  return result;
}

function fileEntryStatus(root, runId, entry) {
  var absPath = path.join(runDir(root, runId), entry.path);
  if (!fs.existsSync(absPath)) {
    return { match: false, actual: null, result: MISSING_EVIDENCE, reason: 'file-missing' };
  }
  var actual;
  try {
    actual = sha256Hex(fs.readFileSync(absPath, 'utf8'), {});
  } catch (e) {
    return { match: false, actual: null, result: MISSING_EVIDENCE, reason: 'unreadable:' + e.message };
  }
  if (actual !== entry.sha256) {
    return { match: false, actual: actual, result: MISSING_EVIDENCE, reason: 'hash-mismatch' };
  }
  return { match: true, actual: actual };
}

function hasRequiredRecordFields(root, runId, taskId) {
  var recordPath = path.join(runDir(root, runId), taskId, 'record.json');
  if (!fs.existsSync(recordPath)) {
    return { ok: true, missingFields: [] };
  }
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (e) {
    return { ok: false, missingFields: ['record.json-unparseable'] };
  }
  var isScriptTask = parsed.exactScriptPath !== undefined;
  var missing = validateTaskRecord(parsed, isScriptTask);
  // cleanupResetResult must be present and non-null or the run cannot pass.
  var cleanup = parsed.cleanupResetResult;
  if (cleanup === undefined || cleanup === null) {
    if (missing.indexOf('cleanupResetResult') === -1) {
      missing.push('cleanupResetResult(null)');
    }
  }
  return { ok: missing.length === 0, missingFields: missing };
}

function readTaskRecord(root, runId, taskId) {
  var recordPath = path.join(runDir(root, runId), taskId, 'record.json');
  if (!fs.existsSync(recordPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Re-hash every file listed in index.json and verify required record fields.
 * Returns MISSING_EVIDENCE result for any missing, hash-mismatched, or
 * required-field-missing file.
 */
function verifyEvidence(runId, options) {
  var root = resolveRoot(options);
  var loaded = loadIndex(root, runId);
  if (!loaded.exists) {
    return { ok: false, error: 'index.json not found', tasks: {} };
  }
  if (!loaded.index) {
    return { ok: false, error: 'index.json invalid', tasks: {} };
  }
  var tasks = loaded.index.tasks || {};
  var taskIds = Object.keys(tasks);
  var allOk = true;
  var result = { ok: true, tasks: {} };

  for (var t = 0; t < taskIds.length; t++) {
    var taskId = taskIds[t];
    var entries = tasks[taskId] || [];
    var files = [];
    var taskOk = true;

    for (var f = 0; f < entries.length; f++) {
      var entry = entries[f];
      var status = fileEntryStatus(root, runId, entry);
      var fileResult = {
        path: entry.path,
        expected: entry.sha256,
        actual: status.actual,
        match: status.match
      };
      if (status.result === MISSING_EVIDENCE) {
        fileResult.result = status.result;
        taskOk = false;
      }
      files.push(fileResult);
    }

    var recordCheck = hasRequiredRecordFields(root, runId, taskId);
    if (!recordCheck.ok) {
      taskOk = false;
      files.push({
        path: taskId + '/record.json',
        expected: null,
        actual: null,
        match: false,
        result: MISSING_EVIDENCE,
        reason: 'required-field-missing:' + recordCheck.missingFields.join(',')
      });
    }

    if (!taskOk) {
      allOk = false;
    }
    result.tasks[taskId] = {
      ok: taskOk,
      files: files,
      record: readTaskRecord(root, runId, taskId)
    };
  }

  result.ok = allOk;
  return result;
}

/**
 * Remove the evidence/<runId>/ folder. Records the outcome (ok/error) and
 * never throws. The record is appended to evidence/cleanup-log.json so the
 * reset outcome is still on disk after the run folder is gone.
 */
function cleanupEvidence(runId, options) {
  var root = resolveRoot(options);
  var targetDir = runDir(root, runId);
  var record = { runId: runId, ok: false, error: null, timestamp: new Date().toISOString() };
  try {
    if (!fs.existsSync(targetDir)) {
      record.error = 'run evidence directory not found';
    } else {
      fs.rmSync(targetDir, { recursive: true, force: true });
      record.ok = true;
    }
  } catch (e) {
    record.error = e.message || String(e);
  }
  try {
    var logPath = path.join(root, 'cleanup-log.json');
    var entries = [];
    if (fs.existsSync(logPath)) {
      var existing = fs.readFileSync(logPath, 'utf8');
      try {
        entries = JSON.parse(existing);
      } catch (e2) {}
      if (!Array.isArray(entries)) entries = [];
    }
    entries.push(record);
    fs.writeFileSync(logPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  } catch (e3) {
    // Logging the record must never throw.
  }
  return record;
}

module.exports = {
  EV_SCHEMA_VERSION: EV_SCHEMA_VERSION,
  EV_DEFAULT_ROOT: EV_DEFAULT_ROOT,
  KIND_ARTIFACT: KIND_ARTIFACT,
  KIND_RECORD: KIND_RECORD,
  MISSING_EVIDENCE: MISSING_EVIDENCE,
  REQUIRED_TASK_FIELDS: REQUIRED_TASK_FIELDS,
  REQUIRED_RECORD_FIELDS: REQUIRED_TASK_FIELDS,
  REQUIRED_SCRIPT_FIELD: REQUIRED_SCRIPT_FIELD,
  initEvidenceIndex: initEvidenceIndex,
  writeEvidenceFile: writeEvidenceFile,
  writeTaskRecord: writeTaskRecord,
  updateEvidenceIndex: updateEvidenceIndex,
  verifyEvidence: verifyEvidence,
  cleanupEvidence: cleanupEvidence,
  redactContent: redactContent,
  collectSecrets: collectSecrets,
  resolveRoot: resolveRoot,
  loadIndex: loadIndex,
  updateRunMeta: updateRunMeta
};
