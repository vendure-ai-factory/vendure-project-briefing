'use strict';

var evidenceCollector = require('./evidenceCollector');
var terminalState = require('./terminalState');
var protectedPathsModule = require('./protectedPaths');
var path = require('path');
var childProcess = require('child_process');

var verifyEvidence = evidenceCollector.verifyEvidence;
var loadIndex = evidenceCollector.loadIndex;
var resolveRoot = evidenceCollector.resolveRoot;
var MISSING_EVIDENCE = evidenceCollector.MISSING_EVIDENCE;
var REQUIRED_RECORD_FIELDS = evidenceCollector.REQUIRED_RECORD_FIELDS;
var RESULT_PASS = terminalState.RESULT_PASS;
var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;

/**
 * Result string constants used by the report.
 * Pass comes from terminalState (the single sanctioned definition); the
 * other constants are local to reporting.
 */
var RESULT_BLOCK = 'BLOCK';
var RESULT_NA = 'NA';
var RUN_LEVEL_END = 'run-level';

/**
 * Git log from a reference commit to HEAD. Returns an array of short lines.
 * Failure to run git returns an empty array (never throws into the report).
 */
function getGitLog(fromRef, options) {
  if (!fromRef) return [];
  // Git log always runs from the repository root (process.cwd()); options.root
  // here is the EVIDENCE root, not the repo, so never use it for this call.
  var repoRoot = process.cwd();
  try {
    var out = childProcess.execFileSync('git', ['log', '--oneline', fromRef + '..HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    });
    return out.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
  } catch (e) {
    return [];
  }
}

/**
 * Gather compliance metadata required by the client on 2 Oct 2026:
 * protected path list, reference hashes, execution HEAD, reference commit,
 * and repair commits (git log reference..HEAD plus repairHistory from records).
 */
function buildComplianceMetadata(report, index, options) {
  var source = (options && options.manifest && options.manifest.source) ? options.manifest.source : {};
  var registry = (options && options.registry) ? options.registry : null;
  var integrity = (options && options.manifest && options.manifest.integrity) ? options.manifest.integrity : {};

  var repairCommits = getGitLog(index ? index.referenceCommit : null, options || {});

  // Aggregate repairHistory across task records.
  var repairHistory = [];
  var taskIds = Object.keys((index && index.tasks) || {});
  for (var i = 0; i < taskIds.length; i++) {
    var entries = index.tasks[taskIds[i]] || [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (e && e.kind === 'record' && e.path && e.sha256) {
        // record.json is re-read when proving a row; here we only know the
        // record file exists. repairHistory is read directly from the record.
        var rec = readTaskRecordFor(options, index.runId, taskIds[i]);
        if (rec && Array.isArray(rec.repairHistory) && rec.repairHistory.length > 0) {
          repairHistory.push({ taskId: taskIds[i], attempts: rec.repairHistory.length });
        }
      }
    }
  }

  return {
    schemaVersion: '1.0',
    protectedPathList: protectedPathsModule.PROTECTED_ROOTS.slice(),
    referenceHashes: {
      documentSha256: source.documentSha256 || null,
      expectedValuesHash: integrity.expectedValuesHash || null,
      fixturesSha256: (registry && registry.frozenHash) || null
    },
    executionHead: index ? index.executionRevision : null,
    referenceCommit: index ? index.referenceCommit : null,
    repairCommits: repairCommits,
    repairHistory: repairHistory
  };
}

/**
 * Read a task's record.json from the evidence tree.
 */
function readTaskRecordFor(options, runId, taskId) {
  var root = resolveRoot(options);
  var recordPath = path.join(root, runId, taskId, 'record.json');
  try {
    return JSON.parse(require('fs').readFileSync(recordPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Build an acceptance report from evidence for a single run.
 *
 * Evidence is read strictly through evidenceCollector.verifyEvidence(runId)
 * and the exported REQUIRED_RECORD_FIELDS; hashing and per-task required
 * field checks are NOT re-implemented here. Per-task entries surface the
 * optional record fields: result, classification, cause, repairHistory,
 * manualIntervention, protectedStartHash, protectedEndHash.
 *
 * A task is MISSING_EVIDENCE (never a passing outcome) when its record has
 * no result field, or when evidence verification fails. Protected-path
 * hashes are reported per task (start/end from the record, pinned from
 * index.json) and any mismatch is flagged.
 *
 * @param {string} runId - run identifier
 * @param {Object} options - { root, baseDir, manifest, registry } passed
 *   through to evidence collector functions; manifest/registry enrich the
 *   compliance metadata.
 * @returns {Object} report
 */
function generateReport(runId, options) {
  options = options || {};
  var root = resolveRoot(options);
  var verify = verifyEvidence(runId, options);
  var loaded = loadIndex(root, runId);
  var index = loaded && loaded.index ? loaded.index : null;

  var report = {
    schemaVersion: '1.0',
    runId: runId,
    executionRevision: index ? index.executionRevision : null,
    referenceCommit: index ? index.referenceCommit : null,
    protectedPathHashes: {
      pinned: index ? index.protectedPathsHash : null,
      runLevelEnd: (index && index.meta && index.meta.protectedEndHash) ? index.meta.protectedEndHash : null,
      tasks: {}
    },
    verifyOk: verify.ok,
    tasks: {}
  };

  // Compliance metadata required by the client on 2 Oct 2026: protected path
  // list, reference hashes, execution HEAD, reference commit, repair commits.
  report.compliance = buildComplianceMetadata(report, index, options);

  var taskIds = Object.keys(verify.tasks || {});
  var mismatchTasks = [];
  var allTasksOk = true;

  for (var i = 0; i < taskIds.length; i++) {
    var taskId = taskIds[i];
    // The reserved "run-level" key holds run-level evidence files (e.g. the
    // protected-end hash) and is not a canonical task; never score it.
    if (taskId === RUN_LEVEL_END) {
      continue;
    }
    var vTask = verify.tasks[taskId];
    var record = vTask.record || {};
    var resultValue = record.result !== undefined ? record.result : null;
    var startHash = record.protectedStartHash !== undefined ? record.protectedStartHash : null;
    var endHash = record.protectedEndHash !== undefined ? record.protectedEndHash : null;

    // A task is MISSING_EVIDENCE (never a passing outcome) when its record has
    // no result field, or when evidence verification fails.
    var taskOk = vTask.ok && resultValue !== null;
    var outcome;
    if (!taskOk) {
      outcome = MISSING_EVIDENCE;
    } else {
      outcome = resultValue;
    }

    // A per-task protectedEndHash of "run-level" means the run-level end hash
    // is written after the loop (single-task runs carry the real hash). It is
    // never treated as a mismatch; only a genuine start/end differ flags.
    var deferredEnd = (endHash === RUN_LEVEL_END);
    var comparable = (startHash !== null || endHash !== null) && !deferredEnd;
    var hashesMatch = !comparable ? null : (startHash === endHash);
    var endMatchesPinned = (!deferredEnd && endHash !== null && index && index.protectedPathsHash !== null)
      ? (endHash === index.protectedPathsHash)
      : null;

    if ((comparable && !hashesMatch) || endMatchesPinned === false) {
      mismatchTasks.push(taskId);
    }

    report.tasks[taskId] = {
      ok: taskOk,
      outcome: outcome,
      result: resultValue,
      coverage: record.coverage || null,
      coverageAssertions: record.coverageAssertions || null,
      classification: record.classification || null,
      cause: record.cause || null,
      repairHistory: record.repairHistory || [],
      manualIntervention: record.manualIntervention || null,
      protectedStartHash: startHash,
      protectedEndHash: endHash,
      protectedHashesMatch: hashesMatch,
      endHashMatchesPinned: endMatchesPinned,
      files: vTask.files
    };
    report.protectedPathHashes.tasks[taskId] = {
      start: startHash,
      end: endHash,
      match: hashesMatch,
      endMatchesPinned: endMatchesPinned
    };

    // A task whose outcome is MISSING_EVIDENCE (no result field, bad hashes,
    // or failed verification) makes the run report not clean.
    if (!taskOk) {
      allTasksOk = false;
    }
  }

  report.protectedPathMismatch = mismatchTasks;
  report.ok = verify.ok && mismatchTasks.length === 0 && allTasksOk;
  return report;
}

/**
 * Render a report object to Markdown for human-facing compliance-report.md files.
 * Emits task rows with outcome and protected-hash match info.
 */
function renderMarkdownReport(report) {
  if (!report) return '# Report (empty)\n';
  var lines = [];
  lines.push('# Acceptance Report');
  lines.push('');
  lines.push('- runId: ' + (report.runId || ''));
  lines.push('- executionRevision: ' + (report.executionRevision || 'n/a'));
  lines.push('- referenceCommit: ' + (report.referenceCommit || 'n/a'));
  lines.push('- verifyOk: ' + (report.verifyOk ? 'true' : 'false'));
  lines.push('- reportOk: ' + (report.ok ? 'true' : 'false'));
  var protectedPinned = report.protectedPathHashes ? report.protectedPathHashes.pinned : null;
  lines.push('- protectedPinnedHash: ' + (protectedPinned || 'n/a'));
  var runLevelEnd = report.protectedPathHashes ? report.protectedPathHashes.runLevelEnd : null;
  lines.push('- runLevelProtectedEndHash: ' + (runLevelEnd || 'n/a'));
  if (report.protectedPathMismatch && report.protectedPathMismatch.length > 0) {
    lines.push('- protectedPathMismatch: ' + report.protectedPathMismatch.join(', '));
  }
  lines.push('');
  if (report.compliance) {
    var compliance = report.compliance;
    lines.push('## Compliance Metadata (client-required 2 Oct 2026)');
    lines.push('');
    lines.push('- executionHead: ' + (compliance.executionHead || 'n/a'));
    lines.push('- referenceCommit: ' + (compliance.referenceCommit || 'n/a'));
    lines.push('- protectedPathList:');
    (compliance.protectedPathList || []).forEach(function(p) {
      lines.push('  - ' + p);
    });
    var refHashes = compliance.referenceHashes || {};
    lines.push('- referenceHashes: documentSha256=' + (refHashes.documentSha256 || 'n/a') +
      ', expectedValuesHash=' + (refHashes.expectedValuesHash || 'n/a') +
      ', fixturesSha256=' + (refHashes.fixturesSha256 || 'n/a'));
    if (compliance.repairCommits && compliance.repairCommits.length > 0) {
      lines.push('- repairCommits (reference..HEAD):');
      compliance.repairCommits.forEach(function(c) {
        lines.push('  - ' + c);
      });
    } else {
      lines.push('- repairCommits: none');
    }
    if (compliance.repairHistory && compliance.repairHistory.length > 0) {
      lines.push('- repairHistory (from records):');
      compliance.repairHistory.forEach(function(rh) {
        lines.push('  - ' + rh.taskId + ': ' + rh.attempts + ' attempt(s)');
      });
    } else {
      lines.push('- repairHistory: none');
    }
    lines.push('');
  }
  lines.push('## Tasks');
  lines.push('');
  var taskIds = Object.keys(report.tasks || {});
  if (taskIds.length === 0) {
    lines.push('_no task evidence_');
    lines.push('');
  }
  taskIds.sort();
  for (var i = 0; i < taskIds.length; i++) {
    var taskId = taskIds[i];
    var entry = report.tasks[taskId];
    lines.push('### ' + taskId);
    lines.push('');
    lines.push('- outcome: ' + (entry.outcome || 'n/a'));
    lines.push('- result: ' + (entry.result || 'n/a'));
    lines.push('- classification: ' + (entry.classification || 'n/a'));
    lines.push('- cause: ' + (entry.cause || 'n/a'));
    lines.push('- protectedStartHash: ' + (entry.protectedStartHash || 'n/a'));
    lines.push('- protectedEndHash: ' + (entry.protectedEndHash || 'n/a'));
    lines.push('- protectedHashesMatch: ' + (entry.protectedHashesMatch === null ? 'n/a' : entry.protectedHashesMatch));
    lines.push('- endHashMatchesPinned: ' + (entry.endHashMatchesPinned === null ? 'n/a' : entry.endHashMatchesPinned));
    if (entry.repairHistory && entry.repairHistory.length > 0) {
      lines.push('- repairHistory: ' + entry.repairHistory.length + ' attempt(s)');
    }
    if (entry.manualIntervention) {
      lines.push('- manualIntervention: ' + JSON.stringify(entry.manualIntervention));
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('MISSING_EVIDENCE means evidence is unusable and the task never counts as a passing outcome.');
  lines.push('A per-task protectedEndHash of "run-level" defers to the run-level protected-end hash in index.json meta.');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  RESULT_PASS: RESULT_PASS,
  RESULT_READINESS_PASS: RESULT_READINESS_PASS,
  RESULT_BLOCK: RESULT_BLOCK,
  RESULT_NA: RESULT_NA,
  RUN_LEVEL_END: RUN_LEVEL_END,
  REQUIRED_RECORD_FIELDS: REQUIRED_RECORD_FIELDS,
  generateReport: generateReport,
  renderMarkdownReport: renderMarkdownReport
};
