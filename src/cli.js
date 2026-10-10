'use strict';

var path = require('path');
var fs = require('fs');

var manifestModule = require('./manifest');
var integrityModule = require('./integrity');
var preflightModule = require('./preflight');
var healthProbeModule = require('./healthProbe');
var workspaceModule = require('./workspace');
var runEnvModule = require('./runEnv');
var loggerModule = require('./logger');
var compilerModule = require('./compiler/cardBuilder');
var demoRepairModule = require('./cli/demoRepair');
var plannerModule = require('./planner');
var executorModule = require('./executor');
var terminalStateModule = require('./terminalState');
var RESULT_PASS = terminalStateModule.RESULT_PASS;
var RESULT_READINESS_PASS = terminalStateModule.RESULT_READINESS_PASS;

var COVERAGE_FULL = 'full';
var COVERAGE_READINESS_SUBSET = 'readiness-subset';
var COVERAGE_PARTIAL = 'partial';
var COVERAGE_NONE = terminalStateModule.COVERAGE_NONE;

var protectedPathsModule = require('./protectedPaths');
var evidenceCollector = require('./evidenceCollector');
var reportModule = require('./reportGenerator');

// Executors are discovered automatically (chunk 12a): src/executors/index.js
// scans its own directory, registers every module that exports a register()
// function, and rejects duplicate task ids. New executors need no edits here.
require('./executors').register(executorModule);

var VALID_SCOPES = {
  'shipping-dryrun': ['CAN-B2-16'],
  'commission-tiers': ['CAN-B2-08'],
  'readiness': ['CAN-B1-03', 'CAN-B1-04']
};

var ALLOWLISTED_HEALTH_HOSTS = ['staging.tibella.eu'];

var FAILURE_CATEGORIES = {
  PIPELINE_DEFECT: 'PIPELINE_DEFECT',
  CLIENT_INPUT_SCOPE: 'CLIENT_INPUT_SCOPE',
  DEPENDENCY_ENVIRONMENT: 'DEPENDENCY_ENVIRONMENT',
  SAFETY_AUTHORIZATION: 'SAFETY_AUTHORIZATION',
  UNRESOLVED_ASSUMPTION: 'UNRESOLVED_ASSUMPTION'
};

var PROTECTED_HASHES_PATH = path.join('manifest', 'protected-hashes.json');

function exitCodeForOutcome(result, classification) {
  if (result === RESULT_PASS || result === RESULT_READINESS_PASS || result === 'N/A' || result === 'NA') return 0;
  if (classification === FAILURE_CATEGORIES.PIPELINE_DEFECT) return 3;
  if (classification === FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE) return 4;
  if (classification === FAILURE_CATEGORIES.UNRESOLVED_ASSUMPTION) return 5;
  if (classification === FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT) return 6;
  if (classification === FAILURE_CATEGORIES.SAFETY_AUTHORIZATION) return 7;
  return 3;
}

function finalizeNoExecutor(taskId) {
  return terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    classification: FAILURE_CATEGORIES.PIPELINE_DEFECT,
    cause: 'NOT_IMPLEMENTED',
    reason: 'no executor implemented for ' + taskId
  });
}

function finalizePreflightBlock(pfResult) {
  var missingIds = [];
  var miss = pfResult.missing || [];
  for (var i = 0; i < miss.length; i++) {
    missingIds.push(miss[i].inputId);
  }
  return terminalStateModule.finalizeTaskOutcome({
    applicable: true,
    classification: FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE,
    cause: 'MISSING_INPUT',
    reason: 'preflight blocked: ' + missingIds.join(', ')
  });
}

function checkProtectedStart(shared, runEnvRecord) {
  var pinnedPath = (shared.deps && shared.deps.pinnedProtectedHashesPath) || path.resolve(process.cwd(), PROTECTED_HASHES_PATH);
  if (!shared.protectedStartInfo) {
    shared.protectedStartInfo = protectedPathsModule.computeProtectedHashes({ root: process.cwd() });
  }
  var info = shared.protectedStartInfo;
  if (!info.ok) {
    return {
      ok: false,
      outcome: {
        result: 'BLOCK',
        classification: FAILURE_CATEGORIES.SAFETY_AUTHORIZATION,
        cause: 'PROTECTED_HASH_COMPUTE',
        reason: info.error || 'protected hash computation failed'
      }
    };
  }
  shared.protectedStart = info.entries;
  runEnvRecord.protectedStartHashes = { combinedHash: info.combinedHash, files: info.entries.length };

  var pinned = protectedPathsModule.loadPinnedHashes(pinnedPath);
  if (!pinned.exists) {
    runEnvRecord.protectedHashesUnresolved = 'UNRESOLVED_ASSUMPTION: ' + PROTECTED_HASHES_PATH + ' is missing; protected-path pin not verifiable';
    return { ok: true, note: 'UNRESOLVED_ASSUMPTION_PIN_MISSING' };
  }
  if (!pinned.valid) {
    runEnvRecord.protectedHashesUnresolved = 'UNRESOLVED_ASSUMPTION: ' + PROTECTED_HASHES_PATH + ' invalid (' + pinned.error + '); protected-path pin not verifiable';
    return { ok: true, note: 'UNRESOLVED_ASSUMPTION_PIN_INVALID' };
  }
  var verify = protectedPathsModule.verifyAgainstPinned(shared.protectedStart, pinned.pinned);
  if (verify.changed.length > 0) {
    return {
      ok: false,
      outcome: {
        result: 'BLOCK',
        classification: FAILURE_CATEGORIES.SAFETY_AUTHORIZATION,
        cause: 'PINNED_HASH_DIFF',
        reason: 'protected path differs from pinned hash: ' + verify.changed.slice(0, 10).join(', ')
      }
    };
  }
  runEnvRecord.protectedHashesComparison = 'MATCH';
  return { ok: true, note: 'MATCH' };
}

function destroyWorkspaceRecord(workspace) {
  if (!workspace) return { ok: true, success: true, error: null };
  var result = workspaceModule.destroyWorkspace(workspace.workspaceId);
  return {
    ok: !!result.success,
    success: !!result.success,
    error: result.success ? null : (result.error || null)
  };
}

function finalizeGateExit(runEnvRecord, workspace, shared, exitCode, outcome, task, extraEvidence) {
  var cleanupResult = destroyWorkspaceRecord(workspace);
  runEnvRecord.result = outcome.result;
  runEnvRecord.classification = outcome.classification;
  runEnvRecord.exitCode = exitCode;
  writeRunEnvironment(shared.writeFileSync, shared.outDir, runEnvRecord, cleanupResult, shared.console);

  // Even a gated exit writes its task evidence and a report when the run-level
  // evidence index was initialized (single-task runs and --task all loops).
  var ev = (!task || !shared.evidenceInitialized) ? null
    : finalizeTaskEvidence(shared, task, outcome, runEnvRecord, cleanupResult, extraEvidence);
  writeRunReport(shared);

  var finalOutcome = ev ? ev.outcome : outcome;
  var evidenceInvalid = !!(ev && !ev.finalVerifyOk);
  return {
    exitCode: evidenceInvalid ? 3 : exitCode,
    result: finalOutcome,
    outDir: shared.outDir,
    cleanupResult: cleanupResult,
    evidenceInvalid: evidenceInvalid,
    record: ev ? ev.record : null
  };
}

/**
 * Initialize the run-level evidence index exactly once per run. Called before
 * any per-task evidence is written (start of a single task, and before the
 * --task all loop). Replacing the index mid-loop would discard prior tasks, so
 * the shared.evidenceInitialized guard keeps it a one-shot operation.
 */
function initRunEvidence(shared, runEnvRecord) {
  if (shared.evidenceInitialized) return { ok: true, already: true };
  shared.evidenceInitialized = true;
  // The index pins the protected-path start hash from its first write, so the
  // hash must be computed before the index is ever created. Single-task runs
  // initialize the index before the gated hash check below, so this computes
  // it eagerly and hands the same value to checkProtectedStart's cache.
  if (!shared.protectedStartInfo) {
    shared.protectedStartInfo = protectedPathsModule.computeProtectedHashes({ root: process.cwd() });
  }
  var startInfo = shared.protectedStartInfo;
  var source = (shared.manifest && shared.manifest.source) ? shared.manifest.source : {};
  var meta = {
    executionRevision: runEnvRecord ? (runEnvRecord.gitHead || runEnvRecord.revisionId || null) : null,
    referenceCommit: source.referenceCommit || null,
    protectedPathsHash: startInfo ? startInfo.combinedHash : null
  };
  evidenceCollector.initEvidenceIndex(shared.runId, meta, shared.evOpts());
  return { ok: true, already: false };
}

/**
 * Expand a logical env var name to [name, ...aliases] using the registry
 * entry's envVarAliases map. Aliases never replace the primary; they are
 * additional names that may satisfy the same input.
 */
function expandEnvVarCandidates(entry, envVarName) {
  var aliases = (entry.envVarAliases && Array.isArray(entry.envVarAliases[envVarName]))
    ? entry.envVarAliases[envVarName] : [];
  return [envVarName].concat(aliases);
}

/**
 * Per-required-input source map for the environment evidence file. Lists only
 * the SOURCE that satisfied the input (frozen value, env var NAME, or missing),
 * never values.
 */
function buildEnvironmentEvidenceSource(task, requiredInputs, registry, getEnv) {
  var req = (requiredInputs && requiredInputs.length !== undefined) ? requiredInputs : (task ? (task.requiredInputs || []) : []);
  var registryMap = {};
  if (registry && Array.isArray(registry.inputs)) {
    for (var i = 0; i < registry.inputs.length; i++) {
      registryMap[registry.inputs[i].id] = registry.inputs[i];
    }
  }
  return req.map(function(inputId) {
    var entry = registryMap[inputId];
    if (!entry) {
      return { inputId: inputId, status: null, source: 'missing' };
    }
    // Env vars override frozen values (e.g. CHANNEL_TOKENS over the frozen
    // registry channel tokens). Check env first so the evidence names the
    // actual source used. Aliases (entry.envVarAliases) are checked too: a
    // required name is satisfied by the name itself or any registered alias,
    // and the satisfying name (primary or alias) is what the evidence records.
    var names = [];
    if (entry.secretRef && typeof entry.secretRef === 'string') names = names.concat(expandEnvVarCandidates(entry, entry.secretRef));
    if (Array.isArray(entry.envVars)) {
      entry.envVars.forEach(function(n) { names = names.concat(expandEnvVarCandidates(entry, n)); });
    }
    for (var j = 0; j < names.length; j++) {
      var val = getEnv()[names[j]];
      if (val !== undefined && val !== null && val !== '') {
        return { inputId: inputId, status: entry.status, source: 'env', envVarName: names[j], envVars: names };
      }
    }
    if (entry.frozenValue !== undefined && entry.frozenValue !== null) {
      return { inputId: inputId, status: entry.status, source: 'frozen' };
    }
    if (entry.fixturePath && inputId !== 'channelTokens') {
      return { inputId: inputId, status: entry.status, source: 'fixtures', fixturePath: entry.fixturePath };
    }
    return { inputId: inputId, status: entry.status, source: 'missing', envVars: names };
  });
}

function writeEnvironmentEvidence(task, requiredInputs, shared, runEnvRecord) {
  var sources = buildEnvironmentEvidenceSource(task, requiredInputs, shared.registry, shared.getEnv);
  evidenceCollector.writeEvidenceFile(
    shared.runId,
    task.canonicalId,
    'environment.json',
    JSON.stringify({ schemaVersion: '1.0', taskId: task.canonicalId, inputs: sources }, null, 2),
    Object.assign({ kind: 'environment' }, shared.evOpts())
  );
}

/**
 * Build the canonical task record: the 15 required fields from manifest
 * section 8 plus the report extras (result, classification, cause,
 * repairHistory, manualIntervention, protectedStartHash, protectedEndHash).
 */
function buildCanonicalRecord(task, outcome, execData, plan, runEnvRecord, cleanupResult, shared, protectedEnd) {
  var manifest = shared.manifest;
  var source = manifest && manifest.source ? manifest.source : {};
  var envId = {
    runId: shared.runId,
    workspaceId: shared.workspace ? shared.workspace.workspaceId : null,
    workspacePath: shared.workspace ? shared.workspace.workspacePath : null
  };
  var protectedEndHash;
  if (protectedEnd === 'run-level' || protectedEnd === null || protectedEnd === undefined) {
    protectedEndHash = protectedEnd === 'run-level' ? 'run-level' : null;
  } else if (typeof protectedEnd === 'object') {
    protectedEndHash = protectedEnd.combinedHash || null;
  } else {
    protectedEndHash = protectedEnd;
  }
  return {
    canonicalId: task.canonicalId,
    summarySpecIds: task.summaryIds || [],
    referenceRevision: source.referenceCommit || null,
    executionRevision: runEnvRecord.gitHead || runEnvRecord.revisionId || null,
    environmentIdentity: envId,
    commandInvocation: runEnvRecord.command || null,
    inputArtifactIds: task.requiredInputs || [],
    expectedResult: task.expectedResult,
    actualResult: execData ? execData.actual : null,
    exitErrorResult: { exitCode: runEnvRecord.exitCode, error: execData ? execData.error : null },
    generatedArtifacts: plan ? plan.executionSteps : [],
    stateChanges: execData ? { success: execData.success, actual: execData.actual } : null,
    cleanupResetResult: cleanupResult,
    finalClassification: outcome.result === RESULT_PASS ? terminalStateModule.TERMINAL_STATES.PASS_CANDIDATE : outcome.result,
    naReason: (outcome.result === 'N/A' || outcome.result === 'NA') ? (outcome.reason || null) : null,
    result: outcome.result,
    classification: outcome.classification || null,
    cause: outcome.cause || null,
    repairHistory: [],
    manualIntervention: null,
    protectedStartHash: (runEnvRecord.protectedStartHashes && runEnvRecord.protectedStartHashes.combinedHash) || null,
    protectedEndHash: protectedEndHash
  };
}

/**
 * Build the verified/unverified assertion map for a record. This is the one
 * place all executors inherit the honesty rule from: verified assertions are
 * populated only for a passing (RESULT_PASS / READINESS_PASS) outcome. On any BLOCK
 * the verified list is empty and every mandatory assertion moves to
 * unverified, so a failed run never claims assertions were proven.
 */
function buildCoverageAssertions(task, finalOutcome, execForCoverage) {
  var isPassing = !!(finalOutcome && (finalOutcome.result === RESULT_PASS || finalOutcome.result === RESULT_READINESS_PASS));
  var verifiedIds = isPassing && execForCoverage ? (execForCoverage.verifiedAssertionIds || []) : [];
  var mandatoryAssertions = (task && task.mandatoryAssertions) || [];
  return {
    verified: mandatoryAssertions.filter(function(a) { return verifiedIds.indexOf(a.id) !== -1; })
      .map(function(a) { return { id: a.id, text: a.text }; }),
    unverified: mandatoryAssertions.filter(function(a) { return verifiedIds.indexOf(a.id) === -1; })
      .map(function(a) { return { id: a.id, text: a.text }; })
  };
}

/**
 * Finalize a task's evidence. Ordering is intentionally strict so the record
 * can never be amended in place:
 *   1. write supporting files (preflight, health, environment) first
 *   2. verify those files BEFORE writing the record; if not ok the record is
 *      written once with BLOCK / PIPELINE_DEFECT / EVIDENCE_INVALID
 *   3. write the record
 *   4. verify again; if it fails now nothing is rewritten, the task reports
 *      finalVerifyOk:false and the run becomes EVIDENCE_INVALID (exit 3).
 */
function finalizeTaskEvidence(shared, task, outcome, runEnvRecord, cleanupResult, extra) {
  var evOpts = shared.evOpts();
  var extras = extra || {};

  if (extras.preflightEvidence) {
    evidenceCollector.writeEvidenceFile(
      shared.runId, task.canonicalId, 'preflight.json',
      JSON.stringify(extras.preflightEvidence, null, 2),
      Object.assign({ kind: 'preflight' }, evOpts)
    );
  }
  if (extras.healthEvidence) {
    evidenceCollector.writeEvidenceFile(
      shared.runId, task.canonicalId, 'health.json',
      JSON.stringify(extras.healthEvidence, null, 2),
      Object.assign({ kind: 'health' }, evOpts)
    );
  }

  var preVerify = evidenceCollector.verifyEvidence(shared.runId, evOpts);
  var finalOutcome = outcome;
  if (!preVerify.ok) {
    finalOutcome = {
      result: 'BLOCK',
      classification: FAILURE_CATEGORIES.PIPELINE_DEFECT,
      cause: 'EVIDENCE_INVALID',
      reason: 'evidence failed verification before record write'
    };
  }

  // Coverage honesty: every task record carries a coverage of full,
  // readiness-subset or partial, plus the verified/unverified assertions. A
  // readiness-subset pass is reported as READINESS_PASS, never as a full pass.
  var execForCoverage = executorModule.getTaskExecutor(task.canonicalId);
  var coverage = (execForCoverage && execForCoverage.coverage) || COVERAGE_FULL;
  var verifiedIds = (execForCoverage && execForCoverage.verifiedAssertionIds) || [];
  var mandatoryAssertions = task.mandatoryAssertions || [];
  var coverageAssertions = {
    verified: mandatoryAssertions.filter(function(a) { return verifiedIds.indexOf(a.id) !== -1; })
      .map(function(a) { return { id: a.id, text: a.text }; }),
    unverified: mandatoryAssertions.filter(function(a) { return verifiedIds.indexOf(a.id) === -1; })
      .map(function(a) { return { id: a.id, text: a.text }; })
  };
  if (finalOutcome && finalOutcome.result === RESULT_PASS && coverage === COVERAGE_READINESS_SUBSET) {
    finalOutcome = Object.assign({}, finalOutcome, { result: RESULT_READINESS_PASS, coverage: coverage });
    runEnvRecord.result = RESULT_READINESS_PASS;
  }

  var protectedEnd = extras.protectedEnd !== undefined ? extras.protectedEnd : (shared.multi ? 'run-level' : null);
  var record = buildCanonicalRecord(task, finalOutcome, extras.execData, extras.plan, runEnvRecord, cleanupResult, shared, protectedEnd);
  record.coverage = coverage;
  record.coverageAssertions = coverageAssertions;
  evidenceCollector.writeTaskRecord(shared.runId, task.canonicalId, record, Object.assign({ scriptTask: false }, evOpts, { coverage: coverage, coverageAssertions: coverageAssertions }));

  var postVerify = evidenceCollector.verifyEvidence(shared.runId, evOpts);
  return {
    finalVerifyOk: postVerify.ok,
    preVerifyOk: preVerify.ok,
    postVerifyOk: postVerify.ok,
    outcome: finalOutcome,
    record: record,
    evidenceInvalid: !postVerify.ok
  };
}

/**
 * After --task all, the run-level protected-end hash is written as a run-level
 * evidence file (kind "protected-end") and stored in index.json meta. Per-task
 * records carry the literal "run-level" so they stay hash-stable.
 */
function writeProtectedEndRunLevel(shared, endPh) {
  var evOpts = shared.evOpts();
  var content = JSON.stringify({
    schemaVersion: '1.0',
    kind: 'protected-end',
    runId: shared.runId,
    combinedHash: endPh ? endPh.combinedHash : null,
    files: endPh ? endPh.files : 0,
    changed: endPh ? (endPh.changed || []) : [],
    writtenAt: new Date().toISOString()
  }, null, 2);
  evidenceCollector.writeEvidenceFile(shared.runId, reportModule.RUN_LEVEL_END, 'protected-end.json', content, Object.assign({ kind: 'protected-end' }, evOpts));
  evidenceCollector.updateRunMeta(shared.runId, { protectedEndHash: endPh ? endPh.combinedHash : null }, evOpts);
  return { ok: true, combinedHash: endPh ? endPh.combinedHash : null };
}

/**
 * Build the run summary shape (runId, counts, protectedHashes, tasks) shared by
 * single-task runs and --task all. EVIDENCE_INVALID forces exit 3 and is put in
 * the summary.
 */
function buildRunSummary(shared, runEnvRecord, outcomes, startedAt, protectedEndHash, evidenceInvalid) {
  var counts = {};
  counts[RESULT_PASS] = 0;
  counts[RESULT_READINESS_PASS] = 0;
  counts.BLOCK = {};
  counts.NA = 0;
  var maxExit = 0;
  for (var k = 0; k < outcomes.length; k++) {
    var o = outcomes[k];
    if (o.result === RESULT_PASS) {
      counts[RESULT_PASS]++;
    } else if (o.result === RESULT_READINESS_PASS) {
      counts[RESULT_READINESS_PASS]++;
    } else if (o.result === 'N/A' || o.result === 'NA') {
      counts.NA++;
    } else {
      var cls = o.classification || 'OTHER';
      if (!counts.BLOCK[cls]) counts.BLOCK[cls] = 0;
      counts.BLOCK[cls]++;
    }
    if (o.exitCode > maxExit) maxExit = o.exitCode;
  }
  if (counts[RESULT_PASS] === outcomes.length) maxExit = 0;
  if (evidenceInvalid) maxExit = 3;

  var summary = {
    runId: shared.runId,
    executionRevision: runEnvRecord.gitHead,
    startedAt: startedAt,
    completedAt: new Date().toISOString(),
    counts: counts,
    protectedHashes: {
      startCombinedHash: shared.protectedStartInfo ? shared.protectedStartInfo.combinedHash : null,
      endCombinedHash: protectedEndHash || (shared.protectedStartInfo ? shared.protectedStartInfo.combinedHash : null)
    },
    tasks: outcomes.map(function(o) {
      return { taskId: o.taskId, result: o.result, classification: o.classification, cause: o.cause };
    })
  };
  if (evidenceInvalid) {
    summary.evidenceInvalid = 'EVIDENCE_INVALID';
  }
  return { summary: summary, maxExit: maxExit };
}

/**
 * Generate the acceptance report for the run and write
 * compliance-report.json + compliance-report.md to the run outDir. No-op if
 * the run-level evidence index was never created.
 */
function writeRunReport(shared) {
  if (!shared.evidenceInitialized) return null;
  var reportOpts = shared.evOpts();
  reportOpts.manifest = shared.manifest;
  reportOpts.registry = shared.registry;
  var report = reportModule.generateReport(shared.runId, reportOpts);
  writeJsonFile(shared.writeFileSync, path.join(shared.outDir, 'compliance-report.json'), report, shared.console);
  try {
    shared.writeFileSync(path.join(shared.outDir, 'compliance-report.md'), reportModule.renderMarkdownReport(report));
  } catch (e) {
    shared.console.error('Failed to write compliance-report.md: ' + e.message);
  }
  return report;
}


function writeJsonFile(writeFileSync, filePath, obj, consoleObj) {
  var serialized = loggerModule.redactSensitiveObject(obj);
  var json = JSON.stringify(serialized, null, 2);
  try {
    writeFileSync(filePath, json);
    consoleObj.log('Wrote evidence: ' + filePath);
  } catch (e) {
    consoleObj.error('Failed to write ' + filePath + ': ' + e.message);
  }
}

function transformHealthResult(healthResult) {
  if (!healthResult) return null;
  var attempts = [];
  var ha = healthResult.attempts || [];
  for (var i = 0; i < ha.length; i++) {
    var a = ha[i];
    attempts.push({
      attempt: a.attempt,
      timestamp: a.timestamp,
      httpStatus: a.statusCode,
      latencyMs: a.latencyMs,
      ok: a.statusCode === 200,
      error: a.error || null
    });
  }
  var finalHttpStatus = null;
  if (attempts.length > 0) {
    finalHttpStatus = attempts[attempts.length - 1].httpStatus;
  }
  return {
    attempts: attempts,
    ok: healthResult.ok === true,
    finalHttpStatus: finalHttpStatus
  };
}

function run(argv, deps) {
  return runAsync(argv, deps);
}

function writeRunEnvironment(writeFileSync, outDir, record, cleanupResult, consoleObj) {
  var filePath = path.join(outDir, 'run-environment.json');
  var rec = {};
  var keys = Object.keys(record);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === 'workspaceCleanup') continue;
    rec[keys[i]] = record[keys[i]];
  }
  rec.workspaceCleanup = cleanupResult;
  var serialized = loggerModule.redactSensitiveObject(rec);
  var json = JSON.stringify(serialized, null, 2);
  try {
    writeFileSync(filePath, json);
    consoleObj.log('Run environment written to: ' + filePath);
  } catch (e) {
    consoleObj.error('Failed to write run environment: ' + e.message);
  }
}

function parseArgs(args) {
  var command = null;
  var manifest = null;
  var task = null;
  var scope = null;
  var out = null;
  var goal = null;
  var provider = 'mock';
  var scenario = null;
  var iAcceptNoSandbox = false;
  var i = 0;

  while (i < args.length) {
    var arg = args[i];
    if (arg === 'run') { command = 'run'; i++; continue; }
    if (arg === 'compile') { command = 'compile'; i++; continue; }
    if (arg === 'demo-repair') { command = 'demo-repair'; i++; continue; }
    if (arg === '--manifest') { i++; if (i >= args.length) return { error: 'Missing value for --manifest' }; manifest = args[i++]; continue; }
    if (arg === '--task') { i++; if (i >= args.length) return { error: 'Missing value for --task' }; task = args[i++]; continue; }
    if (arg === '--scope') { i++; if (i >= args.length) return { error: 'Missing value for --scope' }; scope = args[i++]; continue; }
    if (arg === '--out') { i++; if (i >= args.length) return { error: 'Missing value for --out' }; out = args[i++]; continue; }
    if (arg === '--goal') { i++; if (i >= args.length) return { error: 'Missing value for --goal' }; goal = args[i++]; continue; }
    if (arg === '--provider') { i++; if (i >= args.length) return { error: 'Missing value for --provider' }; provider = args[i++]; continue; }
    if (arg === '--scenario') { i++; if (i >= args.length) return { error: 'Missing value for --scenario' }; scenario = args[i++]; continue; }
    if (arg === '--i-accept-no-sandbox') { iAcceptNoSandbox = true; i++; continue; }
    if (arg.startsWith('--')) { return { error: 'Unknown flag: ' + arg }; }
    i++;
  }

  if (command === 'run') {
    if (!manifest) return { error: 'Missing --manifest' };
    if (!task) return { error: 'Missing --task' };
    return { command: 'run', manifest: manifest, task: task, scope: scope, out: out };
  }
  if (command === 'compile') {
    if (goal !== null && task !== null) return { error: 'Cannot specify both --goal and --task' };
    if (goal === null && task === null) return { error: 'Must specify either --goal or --task' };
    if (!manifest && task !== null) return { error: 'Missing --manifest' };
    return { command: 'compile', goal: goal, task: task, manifest: manifest };
  }
  if (command === 'demo-repair') {
    return { command: 'demo-repair', provider: provider, scenario: scenario, iAcceptNoSandbox: iAcceptNoSandbox };
  }
  return { error: 'Missing command (run, compile, or demo-repair)' };
}

function printUsage(error, consoleObj) {
  if (error) consoleObj.error('Error: ' + error);
  consoleObj.error('Usage: node bin/pipeline.js run --manifest <path> --task <CAN-ID> [--scope <name>] [--out <dir>]');
  consoleObj.error('       node bin/pipeline.js compile --goal "<text>"');
  consoleObj.error('       node bin/pipeline.js compile --task <CAN-ID> --manifest <path>');
}

function isScopeValid(scope, taskId) {
  var valid = VALID_SCOPES[scope];
  if (!valid) return false;
  return valid.indexOf(taskId) !== -1;
}

function isHostAllowlisted(hostname) {
  return ALLOWLISTED_HEALTH_HOSTS.indexOf(hostname) !== -1;
}

function makeResult(result, classification, reason) {
  return {
    result: result,
    classification: classification,
    reason: reason,
    taskId: null,
    scope: null,
    preflight: null,
    treeHashComparison: null
  };
}

function defaultSleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function defaultMkdirSync(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function defaultWriteFileSync(p, c) {
  fs.writeFileSync(p, c, 'utf8');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runAsync(argv, deps) {
  deps = deps || {};
  var consoleObj = deps.console || console;
  var mkdirSync = deps.mkdirSync || defaultMkdirSync;
  var writeFileSync = deps.writeFileSync || defaultWriteFileSync;

  var parsed = parseArgs(argv || process.argv.slice(2));
  if (parsed.error) {
    printUsage(parsed.error, consoleObj);
    return Promise.resolve({ exitCode: 2, result: null });
  }

  if (parsed.command === 'compile') {
    return handleCompile(parsed, deps, consoleObj, mkdirSync, writeFileSync);
  }

  if (parsed.command === 'demo-repair') {
    deps.parseArgs = parseArgs;
    return demoRepairModule.handleDemoRepair(parsed, deps);
  }

  if (parsed.command === 'run') {
    var manifestPath = parsed.manifest;
    var manifestResult = manifestModule.loadManifest(manifestPath);
    if (!manifestResult.valid) {
      consoleObj.error('Error loading manifest: ' + manifestResult.errors.join('; '));
      return Promise.resolve({ exitCode: 2, result: null });
    }
    var manifest = manifestResult.manifest;

    var integrityResult = integrityModule.verifyIntegrity(manifest);
    if (!integrityResult.ok) {
      var blockResult = makeResult('BLOCK', FAILURE_CATEGORIES.PIPELINE_DEFECT, 'expected-values hash mismatch');
      blockResult.integrity = { expected: integrityResult.expected, actual: integrityResult.actual };
      return Promise.resolve({ exitCode: 3, result: blockResult });
    }

    var registryResult = manifestModule.loadRegistry();
    if (!registryResult.valid) {
      consoleObj.error('Error loading registry: ' + registryResult.errors.join('; '));
      return Promise.resolve({ exitCode: 2, result: null });
    }
    var registry = registryResult.registry;

    var config = deps.config || {};
    var wsRoot = config.pipelineWorkspaceRoot || path.join(process.cwd(), 'workspace');
    var evidenceRoot = config.evidenceRoot || process.cwd();
    var evidenceBaseDir = config.evidenceBaseDir || process.env.PIPELINE_EVIDENCE_BASE_DIR || 'evidence';
    var runId = deps.runId || ('run-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 5));
    var outDir = parsed.out || path.join(process.cwd(), 'reports', runId);
    try { mkdirSync(outDir); } catch (e) {}

    var shared = {
      manifest: manifest,
      registry: registry,
      config: config,
      wsRoot: wsRoot,
      runId: runId,
      outDir: outDir,
      getEnv: deps.getEnv || function() { return process.env; },
      deps: deps,
      console: consoleObj,
      mkdirSync: mkdirSync,
      writeFileSync: writeFileSync,
      childProcess: deps.childProcess || require('child_process'),
      protectedStart: null,
      protectedStartInfo: null,
      evidenceRoot: evidenceRoot,
      evidenceBaseDir: evidenceBaseDir,
      evidenceInitialized: false,
      evOpts: function() { return { root: evidenceRoot, baseDir: evidenceBaseDir }; },
      multi: false
    };

    if (parsed.task === 'all') {
      return runAllTasks(parsed, shared);
    }
    return runOneTask(parsed, shared);
  }

  return Promise.resolve({ exitCode: 1, result: null });
}

function handleCompile(parsed, deps, consoleObj, mkdirSync, writeFileSync) {
  var goal = parsed.goal;
  var taskId = parsed.task;
  var manifestPath = parsed.manifest;

  if (goal !== null && goal.trim().length === 0) {
    consoleObj.error('Error: empty goal text');
    return Promise.resolve({ exitCode: 2, result: null });
  }

  if (taskId) {
    var manifestResult = manifestModule.loadManifest(manifestPath);
    if (!manifestResult.valid) {
      consoleObj.error('Error loading manifest: ' + manifestResult.errors.join('; '));
      return Promise.resolve({ exitCode: 2, result: null });
    }
    var manifest = manifestResult.manifest;

    var integrityResult = integrityModule.verifyIntegrity(manifest);
    if (!integrityResult.ok) {
      consoleObj.error('Manifest integrity check failed');
      return Promise.resolve({ exitCode: 3, result: null });
    }

    var task = manifestModule.getTask(manifest, taskId);
    if (!task) {
      consoleObj.error('Unknown task: ' + taskId);
      return Promise.resolve({ exitCode: 2, result: null });
    }

    goal = task.expectedResult;
    taskId = task.canonicalId;
  } else {
    taskId = 'inline-goal';
  }

  var card = compilerModule.buildCard(goal, taskId);

  var runId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 4);
  var outDir = path.join(process.cwd(), 'runs', runId, 'cards');
  try {
    mkdirSync(outDir);
  } catch (e) {
    consoleObj.error('Failed to create output directory: ' + e.message);
    return Promise.resolve({ exitCode: 1, result: null });
  }

  var cardFileName = taskId + '.json';
  var cardPath = path.join(outDir, cardFileName);
  try {
    writeFileSync(cardPath, JSON.stringify(card, null, 2));
    consoleObj.log('Card written to: ' + cardPath);
    consoleObj.log('Status: ' + card.status);
  } catch (e) {
    consoleObj.error('Failed to write card: ' + e.message);
    return Promise.resolve({ exitCode: 1, result: null });
  }

  return Promise.resolve({ exitCode: 0, result: card });
}

// ---------------------------------------------------------------------------
// runOneTask
// ---------------------------------------------------------------------------

async function runOneTask(parsed, shared) {
  var manifest = shared.manifest;
  var taskId = parsed.task;
  var scope = parsed.scope || null;
  var consoleObj = shared.console;
  var writeFileSync = shared.writeFileSync;
  var getEnv = shared.getEnv;
  var workspace = null;
  var runEnvRecord = null;

  // a. getTask; unknown -> exit 2
  var task = manifestModule.getTask(manifest, taskId);
  if (!task) {
    consoleObj.error('Unknown task: ' + taskId);
    return { exitCode: 2, result: null, outDir: shared.outDir };
  }

  // b. scope
  if (scope && !isScopeValid(scope, taskId)) {
    consoleObj.error('Scope "' + scope + '" is not valid for task ' + taskId);
    return { exitCode: 2, result: null, outDir: shared.outDir };
  }

  // c. createWorkspace
  var wsKey = shared.multi ? (shared.runId + '-' + taskId) : shared.runId;
  var wsResult = workspaceModule.createWorkspace(shared.wsRoot, wsKey);
  if (!wsResult.success) {
    consoleObj.error('Failed to create workspace: ' + wsResult.error);
    return { exitCode: 2, result: null, outDir: shared.outDir };
  }
  workspace = wsResult.workspace;
  shared.workspace = workspace;

  // d. collectRunEnvironment
  var revisionId = 'rev-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 5);
  runEnvRecord = runEnvModule.collectRunEnvironment({
    root: process.cwd(),
    runId: shared.runId,
    revisionId: revisionId,
    startedAt: new Date().toISOString(),
    taskId: taskId,
    scope: scope,
    manifest: manifest,
    registry: shared.registry,
    result: null,
    classification: null,
    exitCode: null,
    childProcess: shared.childProcess
  });
  runEnvRecord.command = 'node bin/pipeline.js run --manifest ' + parsed.manifest + ' --task ' + taskId + (scope ? ' --scope ' + scope : '');

  // Environment evidence reflects the actual requiredInputs checked for this
  // run. Under a scope (readiness/shipping-dryrun/commission-tiers) the
  // profile's requiredInputs replace the manifest task's list.
  var effectiveRequiredInputs = task.requiredInputs || [];
  if (scope && manifest.readinessProfiles) {
    var profile = manifest.readinessProfiles[taskId + '|' + scope];
    if (profile && Array.isArray(profile.requiredInputs)) {
      effectiveRequiredInputs = profile.requiredInputs;
    }
  }

  // Evidence index + environment evidence come first so every later gate and
  // outcome (including early exits) has supporting files on disk.
  initRunEvidence(shared, runEnvRecord);
  writeEnvironmentEvidence(task, effectiveRequiredInputs, shared, runEnvRecord);

  // e. treeHash UNAVAILABLE / DIFFER -> exit 8
  if (runEnvRecord.treeHashComparison === 'UNAVAILABLE' || runEnvRecord.treeHashComparison === 'DIFFER') {
    var treeOutcome = {
      result: 'BLOCK',
      classification: FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE,
      cause: runEnvRecord.treeHashComparison === 'UNAVAILABLE' ? 'TREE_HASH_UNAVAILABLE' : 'TREE_HASH_DIFFER',
      reason: runEnvRecord.gitError ? String(runEnvRecord.gitError) : (runEnvRecord.executionRevisionNote || 'tree hash of migration-input could not be verified'),
      gitError: runEnvRecord.gitError,
      treeHashComparison: runEnvRecord.treeHashComparison
    };
    return finalizeGateExit(runEnvRecord, workspace, shared, 8, treeOutcome, task);
  }

  // f. protectedStart
  var startCheck = await checkProtectedStart(shared, runEnvRecord);
  if (!startCheck.ok) {
    return finalizeGateExit(runEnvRecord, workspace, shared, 7, startCheck.outcome, task);
  }

  // g. model lock
  var modelLockResult = preflightModule.checkModelLock(getEnv);
  if (!modelLockResult.ok) {
    var mlOutcome = {
      result: 'BLOCK',
      classification: FAILURE_CATEGORIES.SAFETY_AUTHORIZATION,
      cause: 'MODEL_LOCK',
      reason: modelLockResult.message
    };
    return finalizeGateExit(runEnvRecord, workspace, shared, 4, mlOutcome, task);
  }

  // h. api key
  var hasApiKey = getEnv()['OPENROUTER_API_KEY'];
  var apiKeyProviderType = hasApiKey ? 'real' : 'mock';
  var apiKeyResult = preflightModule.checkOpenRouterApiKey(getEnv, apiKeyProviderType);
  if (!apiKeyResult.ok) {
    var apiKeyOutcome = {
      result: 'BLOCK',
      classification: FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE,
      cause: 'MISSING_INPUT',
      reason: 'missing OpenRouter API key'
    };
    return finalizeGateExit(runEnvRecord, workspace, shared, 4, apiKeyOutcome, task);
  }

  // i. preflight (only the task's requiredInputs)
  var requiredInputs = task.requiredInputs || [];
  if (scope && manifest.readinessProfiles) {
    var profile = manifest.readinessProfiles[taskId + '|' + scope];
    if (profile && Array.isArray(profile.requiredInputs)) {
      requiredInputs = profile.requiredInputs;
    }
  }
  var taskForPreflight = { canonicalId: task.canonicalId, requiredInputs: requiredInputs };
  var manifestForPreflight = { tasks: [taskForPreflight] };
  var pfResult = preflightModule.preflight(manifestForPreflight, shared.registry, taskId, { getEnv: getEnv });

  if (pfResult.error) {
    consoleObj.error('Preflight error: ' + pfResult.error);
    return { exitCode: 2, result: null, outDir: shared.outDir };
  }

  runEnvRecord.preflightResult = {
    missing: pfResult.missing.map(function(m) {
      return { inputId: m.inputId, status: m.status, envVars: m.envVars || [], present: m.present || [], absent: m.absent || [] };
    }),
    unresolved: pfResult.unresolved.map(function(u) {
      return { inputId: u.inputId, status: u.status, reason: u.note || '' };
    }),
    satisfied: (pfResult.satisfied || []).map(function(s) {
      return { inputId: s.inputId, status: s.status, envVars: s.envVars || [], satisfiedBy: s.satisfiedBy || {} };
    })
  };

  if (pfResult.missing && pfResult.missing.length > 0) {
    var missingOutcome = finalizePreflightBlock(pfResult);
    missingOutcome.preflight = pfResult;
    runEnvRecord.currentResult = 'BLOCK';
    return finalizeGateExit(runEnvRecord, workspace, shared, exitCodeForOutcome('BLOCK', FAILURE_CATEGORIES.CLIENT_INPUT_SCOPE), missingOutcome, task, { preflightEvidence: runEnvRecord.preflightResult });
  }

  if (pfResult.unresolved && pfResult.unresolved.length > 0) {
    var unresolvedOutcome = {
      result: 'BLOCK',
      classification: FAILURE_CATEGORIES.UNRESOLVED_ASSUMPTION,
      cause: 'UNRESOLVED_INPUT',
      reason: 'unresolved contractor assumption'
    };
    return finalizeGateExit(runEnvRecord, workspace, shared, exitCodeForOutcome('BLOCK', FAILURE_CATEGORIES.UNRESOLVED_ASSUMPTION), unresolvedOutcome, task, { preflightEvidence: runEnvRecord.preflightResult });
  }

  // Fixtures failing to load is SAFETY_AUTHORIZATION: the frozen fixture data
  // cannot be trusted (missing, tampered, or a hash mismatch after the pin was
  // written). The BLOCK must never carry a null classification, and it exits 6
  // to distinguish it from other SAFETY_AUTHORIZATION gates (which exit 7).
  if (pfResult.classification === 'SAFETY_AUTHORIZATION' ||
      pfResult.error === 'FIXTURES_LOAD_FAILED' ||
      pfResult.error === 'FIXTURES_HASH_MISMATCH') {
    var fxMismatchOutcome = {
      result: 'BLOCK',
      classification: FAILURE_CATEGORIES.SAFETY_AUTHORIZATION,
      cause: pfResult.error === 'FIXTURES_LOAD_FAILED' ? 'FIXTURES_LOAD_FAILED' : 'FIXTURES_HASH_MISMATCH',
      reason: pfResult.reason || 'fixtures file could not be loaded or does not match the pinned hash',
      expectedHash: pfResult.expectedHash || null,
      actualHash: pfResult.actualHash || null
    };
    runEnvRecord.preflightResult = runEnvRecord.preflightResult || {};
    runEnvRecord.preflightResult.fixturesHashMismatch = {
      expected: pfResult.expectedHash || null,
      actual: pfResult.actualHash || null,
      reason: pfResult.reason || ''
    };
    return finalizeGateExit(runEnvRecord, workspace, shared, 6, fxMismatchOutcome, task, { preflightEvidence: runEnvRecord.preflightResult });
  }

  // j. health probe
  if (requiredInputs.indexOf('stagingUrl') !== -1) {
    var stagingUrl = runEnvModule.getFrozenValue(shared.registry, 'stagingUrl');
    if (stagingUrl) {
      var healthGate = await healthProbeGate(stagingUrl, shared, runEnvRecord);
      if (healthGate) {
        return finalizeGateExit(runEnvRecord, workspace, shared, healthGate.exitCode, healthGate.outcome, task, { preflightEvidence: runEnvRecord.preflightResult, healthEvidence: runEnvRecord.healthProbeResult });
      }
    }
  }

  // k. executor lookup
  var executor = executorModule.getTaskExecutor(taskId);
  var card = manifestModule.toTaskCard(task, {}, manifest);
  var plan = null;
  var execData = null;
  var outcome;

  if (!executor) {
    outcome = finalizeNoExecutor(taskId);
    runEnvRecord.result = outcome.result;
    runEnvRecord.classification = outcome.classification;
    runEnvRecord.taskCard = card;
  } else {
    var planResult = plannerModule.createExecutionPlan(card, {
      runId: runEnvRecord.runId,
      revisionId: runEnvRecord.revisionId
    });
    if (planResult.valid) { plan = planResult.plan; }
    // Executors may be async (they perform network reads); await so a resolved
    // handler result is consumed. A synchronous handler still works because
    // awaiting a non-Promise value returns it unchanged.
    var execOutcome = await executor.handler({
      taskId: taskId,
      task: task,
      taskCard: card,
      plan: plan,
      runEnvRecord: runEnvRecord,
      workspace: workspace,
      deps: shared.deps,
      outDir: shared.outDir,
      registry: shared.registry
    });
    execData = {
      success: !!(execOutcome && execOutcome.success),
      actual: execOutcome && execOutcome.actual !== undefined ? execOutcome.actual : null,
      evidence: (execOutcome && execOutcome.evidence) || null,
      error: (execOutcome && execOutcome.error) || null,
      errorCode: (execOutcome && execOutcome.errorCode) || null
    };
    outcome = terminalStateModule.finalizeTaskOutcome({
      applicable: true,
      executorFound: true,
      evidence: execData.evidence,
      expected: task.expectedResult,
      actual: execData.actual,
      executorEvidenceOk: execData.success === true,
      error: execData.error,
      errorCode: execData.errorCode
    });
    runEnvRecord.execution = {
      success: execData.success,
      actual: execData.actual,
      error: execData.error,
      errorCode: execData.errorCode
    };
    runEnvRecord.taskCard = card;
    runEnvRecord.result = outcome.result;
    runEnvRecord.classification = outcome.classification;
  }
  // A fixtures-load failure is SAFETY_AUTHORIZATION but exits 6 (distinct from
  // the generic SAFETY_AUTHORIZATION gate that exits 7).
  var finalExitCode = execData && execData.errorCode === 'FIXTURES_UNAVAILABLE'
    ? 6
    : exitCodeForOutcome(outcome.result, outcome.classification);
  runEnvRecord.exitCode = finalExitCode;

  // m. protected end hash
  var protectedEnd;
  if (shared.multi) {
    // Per-task records cannot hold the run-level end hash: it is computed
    // after the loop. The literal "run-level" keeps the record hash-stable and
    // the real hash lands in a run-level evidence file after the loop.
    protectedEnd = 'run-level';
  } else {
    var endPh = protectedPathsModule.computeProtectedHashes({ root: process.cwd() });
    var diff = protectedPathsModule.diffProtectedHashes(shared.protectedStart || [], endPh.entries);
    protectedEnd = { combinedHash: endPh.combinedHash, files: endPh.entries.length, changed: diff.changed };
    if (diff.changed.length > 0) {
      outcome = {
        result: 'BLOCK',
        classification: FAILURE_CATEGORIES.SAFETY_AUTHORIZATION,
        cause: 'END_HASH_DIFF',
        reason: 'protected path changed during run: ' + diff.changed.join(', ')
      };
      runEnvRecord.result = 'BLOCK';
      runEnvRecord.classification = FAILURE_CATEGORIES.SAFETY_AUTHORIZATION;
      runEnvRecord.exitCode = 7;
    }
  }

  // n. destroyWorkspace then write evidence so cleanup is real
  var cleanupResult = destroyWorkspaceRecord(workspace);

  var evResult = finalizeTaskEvidence(shared, task, outcome, runEnvRecord, cleanupResult, {
    execData: execData,
    plan: plan,
    protectedEnd: protectedEnd,
    preflightEvidence: runEnvRecord.preflightResult,
    healthEvidence: runEnvRecord.healthProbeResult
  });
  writeRunEnvironment(writeFileSync, shared.outDir, runEnvRecord, cleanupResult, consoleObj);
  writeRunReport(shared);

  var finalOutcome = evResult.outcome;
  var exitCode = runEnvRecord.exitCode;
  var evidenceInvalid = false;
  if (!evResult.finalVerifyOk) {
    exitCode = 3;
    evidenceInvalid = true;
  }

  // Record the single-task run summary so EVIDENCE_INVALID lands in
  // run-summary.json, matching the --task all shape.
  var sumData = buildRunSummary(shared, runEnvRecord, [{
    taskId: task.canonicalId,
    result: finalOutcome.result,
    classification: finalOutcome.classification,
    cause: finalOutcome.cause,
    exitCode: exitCode
  }], runEnvRecord.startedAt, protectedEnd === 'run-level' ? null : (protectedEnd ? protectedEnd.combinedHash : null), evidenceInvalid);
  writeJsonFile(writeFileSync, path.join(shared.outDir, 'run-summary.json'), sumData.summary, consoleObj);

  return {
    exitCode: exitCode,
    result: finalOutcome,
    outDir: shared.outDir,
    record: evResult.record,
    cleanupResult: cleanupResult,
    evidenceInvalid: evidenceInvalid
  };
}

async function healthProbeGate(stagingUrl, shared, runEnvRecord) {
  var parsedHealth;
  try { parsedHealth = new URL(stagingUrl); } catch (e) { parsedHealth = null; }
  if (!parsedHealth || !isHostAllowlisted(parsedHealth.hostname)) {
    runEnvRecord.healthProbeResult = { ok: false, finalHttpStatus: null, attempts: [] };
    return {
      exitCode: 7,
      outcome: {
        result: 'BLOCK',
        classification: FAILURE_CATEGORIES.SAFETY_AUTHORIZATION,
        cause: 'STAGING_URL',
        reason: 'host not allowlisted'
      }
    };
  }
  var healthResult = await healthProbeModule.probe(stagingUrl, {
    fetch: shared.deps.fetch || global.fetch,
    sleep: shared.deps.sleep || defaultSleep,
    timeoutMs: 10000
  });
  runEnvRecord.healthProbeResult = transformHealthResult(healthResult);
  if (!healthResult.ok) {
    return {
      exitCode: 6,
      outcome: {
        result: 'BLOCK',
        classification: FAILURE_CATEGORIES.DEPENDENCY_ENVIRONMENT,
        cause: 'HEALTH_PROBE',
        reason: 'health probe failed'
      }
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// runAllTasks
// ---------------------------------------------------------------------------

async function runAllTasks(parsed, shared) {
  var manifest = shared.manifest;
  var consoleObj = shared.console;
  var writeFileSync = shared.writeFileSync;
  shared.multi = true;

  var tasks = [];
  var ti;
  for (ti = 0; ti < manifest.tasks.length; ti++) {
    if (manifest.tasks[ti].origin === 'client-batch') {
      tasks.push(manifest.tasks[ti]);
    }
  }

  var startedAt = new Date().toISOString();
  var runEnvRecord = runEnvModule.collectRunEnvironment({
    root: process.cwd(),
    runId: shared.runId,
    revisionId: 'rev-' + Date.now().toString(36),
    startedAt: startedAt,
    taskId: 'all',
    scope: null,
    manifest: manifest,
    registry: shared.registry,
    result: null,
    classification: null,
    exitCode: null,
    childProcess: shared.childProcess
  });

  // protectedStart + pinned check once
  var startCheck = await checkProtectedStart(shared, runEnvRecord);
  if (!startCheck.ok) {
    initRunEvidence(shared, runEnvRecord);
    writeRunReport(shared);
    return { exitCode: 7, result: startCheck.outcome, outDir: shared.outDir, reportWritten: true, evidenceInvalid: false };
  }
  initRunEvidence(shared, runEnvRecord);

  var outcomes = [];
  var j;
  var evidenceInvalid = false;
  for (j = 0; j < tasks.length; j++) {
    var taskParsed = { manifest: parsed.manifest, task: tasks[j].canonicalId, scope: parsed.scope || null };
    var perTask = await runOneTask(taskParsed, shared);
    if (perTask && perTask.evidenceInvalid) {
      evidenceInvalid = true;
    }
    outcomes.push({
      taskId: tasks[j].canonicalId,
      result: perTask.result ? perTask.result.result : 'BLOCK',
      classification: perTask.result ? perTask.result.classification : null,
      cause: perTask.result ? perTask.result.cause : null,
      exitCode: perTask.exitCode,
      cleanupResult: perTask.cleanupResult,
      evidenceInvalid: !!(perTask && perTask.evidenceInvalid)
    });
  }

  // protectedEnd once: compute the run-level end hash, write it as a run-level
  // evidence file, and store it in index.json meta after the loop.
  var endPh = protectedPathsModule.computeProtectedHashes({ root: process.cwd() });
  var endDiff = protectedPathsModule.diffProtectedHashes(shared.protectedStart || [], endPh.entries);
  if (endDiff.changed.length > 0) {
    for (j = 0; j < outcomes.length; j++) {
      if (outcomes[j].result !== 'BLOCK') {
        outcomes[j].result = 'BLOCK';
        outcomes[j].classification = FAILURE_CATEGORIES.SAFETY_AUTHORIZATION;
        outcomes[j].cause = 'END_HASH_DIFF';
        outcomes[j].exitCode = 7;
      }
    }
  }
  try {
    writeProtectedEndRunLevel(shared, endPh);
  } catch (e) {
    consoleObj.error('Failed to write run-level protected-end evidence: ' + e.message);
  }

  // Report after every run, including runs where tasks BLOCK or gate early.
  writeRunReport(shared);

  var sumData = buildRunSummary(shared, runEnvRecord, outcomes, startedAt, endPh.combinedHash, evidenceInvalid);
  var summary = sumData.summary;
  var maxExit = sumData.maxExit;

  writeJsonFile(writeFileSync, path.join(shared.outDir, 'run-summary.json'), summary, consoleObj);
  runEnvRecord.result = 'SUMMARY';
  runEnvRecord.exitCode = maxExit;
  writeRunEnvironment(writeFileSync, shared.outDir, runEnvRecord, { ok: true }, consoleObj);

  return { exitCode: maxExit, result: summary, outDir: shared.outDir, tasks: outcomes, reportWritten: true, evidenceInvalid: evidenceInvalid };
}

module.exports = {
  run: run,
  runAsync: runAsync,
  parseArgs: parseArgs,
  isScopeValid: isScopeValid,
  isHostAllowlisted: isHostAllowlisted,
  FAILURE_CATEGORIES: FAILURE_CATEGORIES,
  exitCodeForOutcome: exitCodeForOutcome,
  finalizeNoExecutor: finalizeNoExecutor,
  finalizePreflightBlock: finalizePreflightBlock,
  runOneTask: runOneTask,
  runAllTasks: runAllTasks
};
