'use strict';

var evidenceCollector = require('./evidenceCollector');
var terminalState = require('./terminalState');
var protectedPathsModule = require('./protectedPaths');
var verifierModule = require('./repair/verifier');
var path = require('path');
var childProcess = require('child_process');

var redactSecrets = verifierModule.redactSecrets;
var redactEmails = verifierModule.redactEmails;

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
 * Schema version constants.
 */
var SCHEMA_VERSION_1_0 = '1.0';
var SCHEMA_VERSION_1_1 = '1.1';

/**
 * Repair outcome values (schema 1.1).
 */
var OUTCOME_FIXED = 'FIXED';
var OUTCOME_NOT_FIXED = 'NOT_FIXED';
var OUTCOME_BLOCKED = 'BLOCKED';
var OUTCOME_NOT_RUN = 'NOT_RUN';

/**
 * Budget defaults.
 */
var BUDGET_PER_SIGNATURE = 3;
var BUDGET_GLOBAL = 15;

/**
 * Git log from a reference commit to HEAD. Returns an array of short lines.
 * Failure to run git returns an empty array (never throws into the report).
 */
function getGitLog(fromRef, options) {
  if (!fromRef) return [];
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

  var repairHistory = [];
  var taskIds = Object.keys((index && index.tasks) || {});
  for (var i = 0; i < taskIds.length; i++) {
    var entries = index.tasks[taskIds[i]] || [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (e && e.kind === 'record' && e.path && e.sha256) {
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
 * True when the task id is the reserved seeding step ("seed"). Its evidence is
 * a kind "seed" entry (seed/seed-record.json), not a canonical record.json.
 */
function isSeedTaskId(taskId) {
  return taskId === 'seed';
}

/**
 * Read the seed evidence file (the kind "seed" entry's path) from the run
 * index. Returns the parsed JSON or null when missing/unreadable.
 */
function readSeedEvidence(options, index, taskId) {
  if (!index || !index.tasks || !index.tasks[taskId]) return null;
  var entries = index.tasks[taskId] || [];
  var seedPath = null;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].kind === 'seed' && entries[i].path) {
      seedPath = entries[i].path;
      break;
    }
  }
  if (!seedPath) return null;
  var root = resolveRoot(options);
  var absPath = path.join(root, index.runId, seedPath);
  try {
    return JSON.parse(require('fs').readFileSync(absPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Derive an outcome for seed evidence. A seed with ok:true is a passing seed
 * (RESULT_PASS); any other seed evidence is BLOCK (never a passing outcome),
 * with the seed reason surfaced as cause. A null / unreadable seed evidence
 * returns null so the task shows MISSING_EVIDENCE.
 */
function seedOutcome(seedEvidence) {
  if (!seedEvidence || typeof seedEvidence !== 'object') return null;
  if (seedEvidence.ok === true) {
    return {
      result: RESULT_PASS,
      classification: 'SEED_OK',
      cause: null
    };
  }
  return {
    result: RESULT_BLOCK,
    classification: seedEvidence.classification || 'SEED_FAILED',
    cause: seedEvidence.cause || seedEvidence.reason || seedEvidence.error || 'SEED_FAILED'
  };
}

/**
 * Collect secret values from options.secrets for use in redaction.
 */
function collectSecretsForRedaction(options) {
  var values = [];
  if (options && options.secrets && typeof options.secrets === 'object') {
    var keys = Object.keys(options.secrets);
    for (var i = 0; i < keys.length; i++) {
      var v = options.secrets[keys[i]];
      if (typeof v === 'string' && v.length > 0) values.push(v);
    }
  }
  return values;
}

/**
 * Redact secrets and emails from a string.
 */
function safeRedact(text, secretValues) {
  var result = redactSecrets(text, secretValues);
  return redactEmails(result);
}

/**
 * Redact secrets and emails from a value (object, array, or string).
 */
function redactValue(val, secretValues) {
  if (typeof val === 'string') {
    return safeRedact(val, secretValues);
  }
  if (Array.isArray(val)) {
    return val.map(function(item) { return redactValue(item, secretValues); });
  }
  if (val !== null && typeof val === 'object') {
    var out = {};
    var keys = Object.keys(val);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = redactValue(val[keys[i]], secretValues);
    }
    return out;
  }
  return val;
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
 * @param {Object} options - { root, baseDir, manifest, registry, repairMode,
 *   repairData, secrets } passed through to evidence collector functions;
 *   manifest/registry enrich the compliance metadata; repairMode (boolean)
 *   enables schema 1.1 repair reporting; repairData provides repair loop
 *   output; secrets is an object of secret values for redaction.
 * @returns {Object} report
 */
function generateReport(runId, options) {
  options = options || {};
  var repairMode = options.repairMode === true;
  var root = resolveRoot(options);
  var verify = verifyEvidence(runId, options);
  var loaded = loadIndex(root, runId);
  var index = loaded && loaded.index ? loaded.index : null;

  var schemaVersion = repairMode ? SCHEMA_VERSION_1_1 : SCHEMA_VERSION_1_0;

  var report = {
    schemaVersion: schemaVersion,
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

  report.compliance = buildComplianceMetadata(report, index, options);

  var taskIds = Object.keys(verify.tasks || {});
  var mismatchTasks = [];
  var allTasksOk = true;

  for (var i = 0; i < taskIds.length; i++) {
    var taskId = taskIds[i];
    if (taskId === RUN_LEVEL_END) {
      continue;
    }
    var vTask = verify.tasks[taskId];
    var record = vTask.record || {};
    var resultValue = record.result !== undefined ? record.result : null;
    var startHash = record.protectedStartHash !== undefined ? record.protectedStartHash : null;
    var endHash = record.protectedEndHash !== undefined ? record.protectedEndHash : null;

    if (isSeedTaskId(taskId)) {
      var seedValue = readSeedEvidence(options, index, taskId);
      var seedDecision = seedOutcome(seedValue);
      if (seedDecision && vTask.ok) {
        resultValue = seedDecision.result;
        record = Object.assign({}, record, { classification: seedDecision.classification, cause: seedDecision.cause });
      } else {
        resultValue = null;
      }
      var seedTaskOk = (seedValue && seedValue.ok === true) && vTask.ok && resultValue !== null;
      var seedOutcomeValue = resultValue !== null ? resultValue : MISSING_EVIDENCE;
      var seedEntry = {
        ok: seedTaskOk,
        outcome: seedOutcomeValue,
        result: resultValue,
        coverage: record.coverage || null,
        coverageAssertions: record.coverageAssertions || null,
        classification: record.classification || null,
        cause: record.cause || null,
        repairHistory: record.repairHistory || [],
        manualIntervention: record.manualIntervention || null,
        protectedStartHash: startHash,
        protectedEndHash: endHash,
        protectedHashesMatch: null,
        endHashMatchesPinned: null,
        files: vTask.files
      };
      if (seedValue && Array.isArray(seedValue.blocked) && seedValue.blocked.length > 0) {
        seedEntry.blockedEntries = seedValue.blocked;
      }
      report.tasks[taskId] = seedEntry;
      report.protectedPathHashes.tasks[taskId] = {
        start: startHash,
        end: endHash,
        match: null,
        endMatchesPinned: null
      };
      var seedForAllTasksOk = vTask.ok && resultValue !== null;
      if (!seedForAllTasksOk) {
        allTasksOk = false;
      }
      continue;
    }

    var taskOk = vTask.ok && resultValue !== null;
    var outcome;
    if (!taskOk) {
      outcome = MISSING_EVIDENCE;
    } else {
      outcome = resultValue;
    }

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

    if (!taskOk) {
      allTasksOk = false;
    }
  }

  report.protectedPathMismatch = mismatchTasks;
  report.ok = verify.ok && mismatchTasks.length === 0 && allTasksOk;

  // Schema 1.1: populate report.repair when repair mode is enabled.
  // When repair mode is off, report.repair is completely absent.
  if (repairMode) {
    var repairData = options.repairData || {};
    var secretValues = collectSecretsForRedaction(options);

    var attemptsData = repairData.attempts || [];

    // Collect anyFixed / anyNotFixed from task outcomes.
    var anyFixed = false;
    var anyNotFixed = false;
    var taskIdsAll = Object.keys(report.tasks || {});
    for (var ti = 0; ti < taskIdsAll.length; ti++) {
      var tent = report.tasks[taskIdsAll[ti]];
      if (tent.outcome === RESULT_PASS || tent.outcome === RESULT_READINESS_PASS) {
        anyFixed = true;
      } else if (tent.outcome === RESULT_BLOCK) {
        anyNotFixed = true;
      }
    }

    // Check for manual target edits — overrides to BLOCKED.
    var hasManualEdits = (repairData.manualTargetEdits > 0);
    var blockedByManual = false;
    if (hasManualEdits) {
      blockedByManual = true;
      // Inject MANUAL_TARGET_EDIT_DETECTED blocker.
      var manualBlocker = {
        code: 'MANUAL_TARGET_EDIT_DETECTED',
        message: 'Manual edits to target detected; pipeline outcome is BLOCKED.',
        evidence: redactValue({ manualTargetEdits: repairData.manualTargetEdits }, secretValues)
      };
      repairData = Object.assign({}, repairData, {
        blockers: (repairData.blockers || []).concat([manualBlocker])
      });
    }

    var blockersRaw = repairData.blockers || [];
    // Redact blocker evidence and message for JSON storage.
    var blockersForJson = blockersRaw.map(function(blk) {
      return {
        code: blk.code || 'UNKNOWN',
        message: safeRedact(String(blk.message || ''), secretValues),
        evidence: redactValue(blk.evidence || {}, secretValues)
      };
    });

    var blocked = blockersRaw.length > 0;
    var outcome;
    if (blocked) {
      outcome = OUTCOME_BLOCKED;
    } else if (anyFixed && !anyNotFixed) {
      outcome = OUTCOME_FIXED;
    } else if (anyNotFixed) {
      outcome = OUTCOME_NOT_FIXED;
    } else {
      outcome = OUTCOME_NOT_RUN;
    }

    // Compute budgets from attempts.
    var totalUsed = attemptsData.length;

    // Redact attempts' message and diffExcerpt for JSON.
    var attemptsForJson = attemptsData.map(function(a) {
      var redactedA = {
        n: a.n,
        signature: a.signature || '',
        domain: a.domain || '',
        repairKind: a.repairKind || '',
        status: a.status || '',
        checks: a.checks || '',
        branch: a.branch || '',
        headSha: a.headSha || '',
        buildRunUrl: safeRedact(String(a.buildRunUrl || ''), secretValues),
        imageDigest: a.imageDigest || '',
        deployed: a.deployed ? true : false,
        notDeployedReason: a.notDeployedReason || '',
        locatedFrom: Array.isArray(a.locatedFrom) ? a.locatedFrom.slice() : [],
        editedFiles: Array.isArray(a.editedFiles) ? a.editedFiles.slice() : [],
        retestVerdicts: Array.isArray(a.retestVerdicts) ? a.retestVerdicts.slice() : [],
        verifyStatus: a.verifyStatus || ''
      };
      if (a.message) {
        redactedA.message = safeRedact(String(a.message), secretValues);
      }
      return redactedA;
    });

    // Redact sectionB targetChanges diffExcerpt for JSON storage.
    var sectionB = repairData.sectionB || { targetChanges: [] };
    var targetChangesForJson = (sectionB.targetChanges || []).map(function(tc) {
      var redactedTc = {
        branch: tc.branch || '',
        commit: tc.commit || '',
        repairKind: tc.repairKind || '',
        filesChanged: Array.isArray(tc.filesChanged) ? tc.filesChanged.slice() : [],
        diffStat: tc.diffStat || '',
        deployed: tc.deployed === false ? false : true,
        notDeployedReason: tc.notDeployedReason || ''
      };
      if (tc.diffExcerpt) {
        var redacted = safeRedact(String(tc.diffExcerpt), secretValues);
        if (redacted.length > 4000) redacted = redacted.substring(0, 4000) + '\n... (truncated)';
        redactedTc.diffExcerpt = redacted;
      }
      return redactedTc;
    });

    report.repair = {
      schemaVersion: SCHEMA_VERSION_1_1,
      enabled: true,
      outcome: outcome,
      sectionA: { pipelineChanges: (repairData.sectionA && repairData.sectionA.pipelineChanges) || [] },
      sectionB: { targetChanges: targetChangesForJson },
      attempts: attemptsForJson,
      deploy: repairData.deploy || null,
      rollback: repairData.rollback !== undefined ? repairData.rollback : null,
      blockers: blockersForJson,
      budgets: {
        used: totalUsed,
        global: BUDGET_GLOBAL,
        perSignature: BUDGET_PER_SIGNATURE
      },
      manualTargetEdits: 0
    };
  }

  return report;
}

/**
 * Render a report object to Markdown for human-facing compliance-report.md files.
 * Emits task rows with outcome and protected-hash match info.
 * options.secrets is used for diffExcerpt redaction in the markdown output.
 */
function renderMarkdownReport(report, options) {
  options = options || {};
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

  // Schema 1.1 repair sections under report.repair.
  if (report.repair && report.repair.schemaVersion === SCHEMA_VERSION_1_1) {
    var repair = report.repair;
    lines.push('## A. Pipeline changes');
    lines.push('');
    var pipelineChanges = (repair.sectionA && repair.sectionA.pipelineChanges) || [];
    if (pipelineChanges.length === 0) {
      lines.push('_no pipeline changes_');
    } else {
      pipelineChanges.forEach(function(pc) {
        lines.push('- path: ' + (pc.path || 'n/a'));
        lines.push('  description: ' + (pc.description || 'n/a'));
        lines.push('  commit: ' + (pc.commit || 'n/a'));
      });
    }
    lines.push('');
    lines.push('## B. Target changes made by the Pipeline');
    lines.push('');
    var targetChanges = (repair.sectionB && repair.sectionB.targetChanges) || [];
    if (targetChanges.length === 0) {
      lines.push('_no target changes_');
    } else {
      targetChanges.forEach(function(tc) {
        lines.push('- branch: ' + (tc.branch || 'n/a'));
        lines.push('  commit: ' + (tc.commit || 'n/a'));
        lines.push('  repairKind: ' + (tc.repairKind || 'n/a'));
        lines.push('  filesChanged: ' + ((tc.filesChanged && tc.filesChanged.length > 0) ? tc.filesChanged.join(', ') : 'none'));
        lines.push('  diffStat: ' + (tc.diffStat || 'n/a'));
        if (tc.diffExcerpt) {
          lines.push('  diffExcerpt: |');
          var excerptLines = tc.diffExcerpt.split('\n');
          for (var el = 0; el < excerptLines.length; el++) {
            lines.push('    ' + excerptLines[el]);
          }
        }
      });
    }
    lines.push('');
    lines.push('## Attempts');
    lines.push('');
    var attempts = repair.attempts || [];
    if (attempts.length === 0) {
      lines.push('_no attempts_');
    } else {
      lines.push('| n | signature | domain | repairKind | status | checks | branch | headSha | deployed | verifyStatus |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|');
      attempts.forEach(function(a) {
        lines.push('| ' + (a.n || '') +
          ' | ' + (a.signature || '') +
          ' | ' + (a.domain || '') +
          ' | ' + (a.repairKind || '') +
          ' | ' + (a.status || '') +
          ' | ' + (a.checks || '') +
          ' | ' + (a.branch || '') +
          ' | ' + (a.headSha ? a.headSha.substring(0, 7) : '') +
          ' | ' + (a.deployed ? 'yes' : 'no') +
          ' | ' + (a.verifyStatus || '') + ' |');
      });
    }
    lines.push('');
    lines.push('## Blockers');
    lines.push('');
    var blockers = repair.blockers || [];
    if (blockers.length === 0) {
      lines.push('_no blockers_');
    } else {
      blockers.forEach(function(blk) {
        lines.push('- code: ' + (blk.code || 'n/a'));
        lines.push('  message: ' + (blk.message || 'n/a'));
        lines.push('  evidence: ' + JSON.stringify(blk.evidence || {}));
      });
    }
    lines.push('');
    lines.push('manualTargetEdits: ' + (repair.manualTargetEdits !== undefined ? repair.manualTargetEdits : 0));
    lines.push('');
  }

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
    if (entry.blockedEntries && entry.blockedEntries.length > 0) {
      lines.push('- blocked: ' + entry.blockedEntries.length + ' entity/entities');
      entry.blockedEntries.forEach(function(b) {
        var entity = b.entity || 'unknown';
        var error = b.error || 'n/a';
        lines.push('  - entity: ' + entity + '; error: ' + error);
      });
    }
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
  SCHEMA_VERSION_1_0: SCHEMA_VERSION_1_0,
  SCHEMA_VERSION_1_1: SCHEMA_VERSION_1_1,
  OUTCOME_FIXED: OUTCOME_FIXED,
  OUTCOME_NOT_FIXED: OUTCOME_NOT_FIXED,
  OUTCOME_BLOCKED: OUTCOME_BLOCKED,
  OUTCOME_NOT_RUN: OUTCOME_NOT_RUN,
  REQUIRED_RECORD_FIELDS: REQUIRED_RECORD_FIELDS,
  generateReport: generateReport,
  renderMarkdownReport: renderMarkdownReport
};
