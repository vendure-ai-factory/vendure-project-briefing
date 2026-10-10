'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var terminalState = require('../../src/terminalState');
var evidenceCollector = require('../../src/evidenceCollector');

var RESULT_PASS = terminalState.RESULT_PASS;
var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = 'readiness-subset';
var COVERAGE_PARTIAL = 'partial';
var TERMINAL_STATES = terminalState.TERMINAL_STATES;
var FAILURE_CLASSES = terminalState.FAILURE_CLASSES;
var MISSING_EVIDENCE = TERMINAL_STATES.MISSING_EVIDENCE;
var UNRESOLVED_ASSUMPTION = TERMINAL_STATES.UNRESOLVED_ASSUMPTION;
var BLOCK = TERMINAL_STATES.BLOCK;
var RUN_LEVEL_END = 'run-level';
var verifyEvidence = evidenceCollector.verifyEvidence;

var DEFAULT_EXPECTED_TASKS = 24;

/**
 * Locate chain-level summaries written by the chain runner (chunk 16) as
 * reports/<runId>/chain-<id>.json. Returns the parsed file list; a file that
 * fails to parse is included with valid:false so the review reports it rather
 * than silently ignoring it.
 */
function loadChainSummaries(runId, options) {
  var norm = normalizeOptions(options);
  var reportsDir = path.join(norm.root, norm.reportsBaseDir, runId);
  if (!fs.existsSync(reportsDir)) {
    return [];
  }
  var names;
  try {
    names = fs.readdirSync(reportsDir).sort();
  } catch (e) {
    return [];
  }
  var out = [];
  for (var i = 0; i < names.length; i++) {
    var match = /^chain-(.+)\.json$/.exec(names[i]);
    if (!match) {
      continue;
    }
    var file = path.join(reportsDir, names[i]);
    var parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      parsed = null;
    }
    out.push({ file: file, chainId: match[1], summary: parsed, valid: parsed !== null });
  }
  return out;
}
var PENDING_CLASSES = {};

// The Skill itself is delivered frozen with a content hash (SKILL.sha256).
var SKILL_MD_PATH = path.join(__dirname, 'SKILL.md');
var SKILL_SHA_PATH = path.join(__dirname, 'SKILL.sha256');

/**
 * sha256 over text that is insensitive to CRLF vs LF line endings. The pinned
 * SKILL.sha256 is LF-based, so normalizing makes a Windows checkout produce
 * the same hash as the pinned value without ever rewriting the pin.
 */
function skillSha256Hex(value) {
  return crypto.createHash('sha256').update(String(value).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Verify the pipeline-review SKILL.md content hash against the pinned
 * SKILL.sha256. Returns { ok, pinned, actual, error }. The pin is never
 * rewritten; a mismatch means the Skill was tampered with.
 */
function verifySkillHash(skillPath, shaPath) {
  skillPath = skillPath || SKILL_MD_PATH;
  shaPath = shaPath || SKILL_SHA_PATH;
  if (!fs.existsSync(skillPath)) {
    return { ok: false, error: 'skill file missing: ' + skillPath };
  }
  if (!fs.existsSync(shaPath)) {
    return { ok: false, error: 'skill sha256 missing: ' + shaPath };
  }
  var content = fs.readFileSync(skillPath, 'utf8');
  var pinned = fs.readFileSync(shaPath, 'utf8').trim();
  var actual = skillSha256Hex(content);
  if (pinned !== actual) {
    return { ok: false, error: 'skill sha256 mismatch: pinned=' + pinned + ' actual=' + actual, pinned: pinned, actual: actual };
  }
  return { ok: true, sha256: actual, pinned: pinned };
}
PENDING_CLASSES[FAILURE_CLASSES.CLIENT_INPUT_SCOPE] = true;
PENDING_CLASSES[FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT] = true;

var STATUS_PENDING = 'pending';
var STATUS_UNMET = 'unmet';

// Accepted string classifications a record may carry: every failure class plus
// the terminal/decision classes the pipeline can persist on a BLOCK record
// (e.g. UNRESOLVED_ASSUMPTION). A record's classification is stored as a plain
// string, so the review must read it directly instead of defaulting to
// APPLICATION_DEFECT.
var RECORD_CLASSIFICATIONS = {};
Object.keys(FAILURE_CLASSES).forEach(function(key) {
  RECORD_CLASSIFICATIONS[FAILURE_CLASSES[key]] = true;
});
RECORD_CLASSIFICATIONS[TERMINAL_STATES.UNRESOLVED_ASSUMPTION] = true;
RECORD_CLASSIFICATIONS[TERMINAL_STATES.MISSING_EVIDENCE] = true;
RECORD_CLASSIFICATIONS[TERMINAL_STATES.BLOCK] = true;
RECORD_CLASSIFICATIONS[TERMINAL_STATES.AUTH_REQUIRED] = true;
RECORD_CLASSIFICATIONS['PASS_CANDIDATE'] = true;
RECORD_CLASSIFICATIONS['N/A'] = true;
RECORD_CLASSIFICATIONS['NA'] = true;

function normalizeOptions(options) {
  options = options || {};
  var root = path.resolve(options.root || process.cwd());
  return {
    root: root,
    evidenceBaseDir: options.evidenceBaseDir || 'evidence',
    reportsBaseDir: options.reportsBaseDir || 'reports',
    expectedTaskCount: options.expectedTaskCount || DEFAULT_EXPECTED_TASKS
  };
}

function reportFilePath(norm, runId) {
  return path.join(norm.root, norm.reportsBaseDir, runId, 'compliance-report.json');
}

/**
 * Load the persisted compliance report (generateReport output) if present.
 * The review never trusts its claims; it is read only so the derived verdict
 * can be compared against what the report asserted.
 */
function loadComplianceReport(runId, options) {
  var norm = normalizeOptions(options);
  var file = reportFilePath(norm, runId);
  if (!fs.existsSync(file)) {
    return null;
  }
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  return { path: file, report: parsed };
}

function deriveFailureClass(record) {
  if (!record) {
    return null;
  }
  if (typeof record.classification === 'string' && RECORD_CLASSIFICATIONS[record.classification]) {
    return record.classification;
  }
  if (record.classification && record.classification.failureClass) {
    return record.classification.failureClass;
  }
  if (record.finalClassification && FAILURE_CLASSES[record.finalClassification]) {
    return record.finalClassification;
  }
  return null;
}

function resolveStatus(failureClass, record) {
  if (record && record.exhaustedRepair === true) {
    return STATUS_UNMET;
  }
  if (failureClass && PENDING_CLASSES[failureClass]) {
    return STATUS_PENDING;
  }
  return STATUS_UNMET;
}

function isAssumptionRecord(record) {
  if (!record) {
    return false;
  }
  if (record.unresolvedAssumption === true) {
    return true;
  }
  if (record.finalClassification === UNRESOLVED_ASSUMPTION) {
    return true;
  }
  if (record.confirmedAssumption === false) {
    return true;
  }
  if (Array.isArray(record.pendingClientInputs) && record.pendingClientInputs.length > 0) {
    return true;
  }
  return false;
}

function protectedHashesMismatch(record) {
  var start = record.protectedStartHash;
  var end = record.protectedEndHash;
  if (start === undefined && end === undefined) {
    return false;
  }
  // A per-task protectedEndHash of "run-level" is deferred: the real run-level
  // end hash is written after the loop and surfaced via index.meta, so a
  // per-task start/end can never be compared. Same logic as reportGenerator.
  if (end === RUN_LEVEL_END) {
    return false;
  }
  return start !== end;
}

function protectedEndMismatchPinned(record, index) {
  var end = record.protectedEndHash;
  if (end === RUN_LEVEL_END) {
    // Deferred: compare the run-level protected-end hash (index.meta) against
    // the pinned hash instead of the per-task "run-level" literal.
    var runLevelEnd = index && index.meta ? index.meta.protectedEndHash : undefined;
    if (runLevelEnd === undefined || runLevelEnd === null || !index || !index.protectedPathsHash) {
      return false;
    }
    return runLevelEnd !== index.protectedPathsHash;
  }
  if (end === undefined || !index || !index.protectedPathsHash) {
    return false;
  }
  return end !== index.protectedPathsHash;
}

/**
 * Derive a single task verdict from evidence only.
 * A task is never a passing outcome unless every integrity, result,
 * expectation, intervention, cleanup, hash and assumption condition holds.
 */
function deriveTaskVerdict(taskId, verifyTask, index) {
  var record = verifyTask.record;
  var reason = [];

  if (!verifyTask.ok) {
    reason.push('evidence integrity failure (missing, tampered or field-short file)');
  }
  if (record === null) {
    reason.push('record.json missing');
  } else {
    if (record.result === undefined) {
      reason.push('result field missing');
    }
    if (record.cleanupResetResult === undefined || record.cleanupResetResult === null) {
      reason.push('cleanup not verified');
    }
    if (protectedHashesMismatch(record)) {
      reason.push('protected-path hash mismatch (start != end)');
    }
    if (protectedEndMismatchPinned(record, index)) {
      reason.push('protected-path end hash differs from pinned hash');
    }
  }

  if (reason.length > 0) {
    return {
      taskId: taskId,
      verdict: MISSING_EVIDENCE,
      failureClass: null,
      status: null,
      reason: reason.join('; ')
    };
  }

  if (index === null || index.protectedPathsHash === undefined || index.protectedPathsHash === null) {
    return {
      taskId: taskId,
      verdict: UNRESOLVED_ASSUMPTION,
      failureClass: null,
      status: null,
      reason: 'missing protected-hashes pin'
    };
  }

  if (isAssumptionRecord(record)) {
    return {
      taskId: taskId,
      verdict: UNRESOLVED_ASSUMPTION,
      failureClass: null,
      status: null,
      reason: 'depends on unconfirmed assumption or pending client value'
    };
  }

  var expected = record.expectedResult;
  var actual = record.actualResult;
  var expectedMatchesActual = expected === actual || (expected !== undefined && actual !== undefined &&
    String(expected) === String(actual));
  var coverage = record.coverage || 'full';
  var isReadinessPass = record.result === RESULT_READINESS_PASS ||
    (record.result === RESULT_PASS && coverage === COVERAGE_READINESS_SUBSET);

  if ((record.result !== RESULT_PASS && record.result !== RESULT_READINESS_PASS) || !expectedMatchesActual) {
    var failureClass = deriveFailureClass(record) || FAILURE_CLASSES.APPLICATION_DEFECT;
    var status = resolveStatus(failureClass, record);
    var why = (record.result !== RESULT_PASS && record.result !== RESULT_READINESS_PASS)
      ? 'result is ' + String(record.result)
      : 'expected did not equal actual';
    return {
      taskId: taskId,
      verdict: BLOCK,
      failureClass: failureClass,
      status: status,
      reason: why + (record.cause ? ' (' + record.cause + ')' : ''),
      cause: record.cause || null
    };
  }

  if (coverage === COVERAGE_PARTIAL) {
    return {
      taskId: taskId,
      verdict: BLOCK,
      failureClass: FAILURE_CLASSES.APPLICATION_DEFECT,
      status: STATUS_UNMET,
      reason: 'partial coverage cannot be a passing outcome'
    };
  }

  if (record.manualIntervention && record.manualIntervention.required === true) {
    return {
      taskId: taskId,
      verdict: BLOCK,
      failureClass: FAILURE_CLASSES.SAFETY_AUTHORIZATION,
      status: STATUS_UNMET,
      reason: 'manual intervention required'
    };
  }

  return {
    taskId: taskId,
    verdict: isReadinessPass ? RESULT_READINESS_PASS : RESULT_PASS,
    failureClass: null,
    status: null,
    reason: null
  };
}

/**
 * Rank a chain-task entry for "worst" selection, mirroring the review's
 * overall precedence: a verified PASS is the best, every other verdict is
 * worse, with MISSING_EVIDENCE the worst and an unmet BLOCK above a pending
 * BLOCK above UNRESOLVED_ASSUMPTION.
 */
function chainEntrySeverity(entry) {
  if (entry.verdict === RESULT_PASS) return 0;
  if (entry.verdict === RESULT_READINESS_PASS) return 1;
  if (entry.verdict === BLOCK && entry.status === STATUS_PENDING) return 2;
  if (entry.verdict === UNRESOLVED_ASSUMPTION) return 3;
  if (entry.verdict === BLOCK) return 4;
  return 5;
}

/**
 * Re-derive a chain summary's verdict from evidence alone (never from the
 * summary's own claims). A chain is a passing outcome only when every task in
 * its canonicalIds has an evidence verdict of RESULT_PASS. The worst task by
 * severity wins otherwise.
 */
function deriveChainVerdict(chainSummary, taskVerdicts) {
  var ids = (chainSummary && Array.isArray(chainSummary.canonicalIds)) ? chainSummary.canonicalIds : [];
  var per = [];
  var allPass = true;
  var worstSev = -1;
  var worst = null;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var v = taskVerdicts ? taskVerdicts[id] : null;
    var entry = { taskId: id };
    if (!v) {
      entry.verdict = MISSING_EVIDENCE;
      entry.failureClass = null;
      entry.status = null;
      entry.reason = 'no evidence for chain task ' + id;
      allPass = false;
    } else {
      entry.verdict = v.verdict;
      entry.failureClass = v.failureClass;
      entry.status = v.status;
      entry.cause = v.cause;
      entry.reason = v.reason;
      if (v.verdict !== RESULT_PASS) {
        allPass = false;
      }
    }
    per.push(entry);
    var sev = chainEntrySeverity(entry);
    if (sev > worstSev) {
      worstSev = sev;
      worst = entry;
    }
  }

  var verdict = allPass ? RESULT_PASS : (worst ? worst.verdict : MISSING_EVIDENCE);
  var declaredResult = chainSummary ? chainSummary.result : null;
  var declaredCoverage = chainSummary ? chainSummary.coverage : null;
  var claimsPass = declaredResult === RESULT_PASS;
  var evidencePass = verdict === RESULT_PASS;

  return {
    chainId: chainSummary ? (chainSummary.chainId || null) : null,
    verdict: verdict,
    failureClass: worst ? worst.failureClass : null,
    status: worst ? worst.status : null,
    taskVerdicts: per,
    declaredResult: declaredResult,
    declaredCoverage: declaredCoverage,
    consistent: declaredResult === null || claimsPass === evidencePass
  };
}

function groupByVerdict(tasks, fields) {
  var groups = [];
  var ids = Object.keys(tasks);
  for (var i = 0; i < ids.length; i++) {
    var summary = tasks[ids[i]];
    if (summary.verdict === RESULT_PASS) {
      continue;
    }
    var key = summary.verdict + '|' + (summary.failureClass || '') + '|' + (summary.status || '');
    var group = null;
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].key === key) {
        group = groups[g];
        break;
      }
    }
    if (!group) {
      group = { key: key, verdict: summary.verdict, failureClass: summary.failureClass || null, status: summary.status || null, taskIds: [], reasons: {} };
      groups.push(group);
    }
    group.taskIds.push(summary.taskId);
    group.reasons[summary.taskId] = summary.reason;
  }
  groups.sort(function(a, b) {
    return a.verdict < b.verdict ? -1 : a.verdict > b.verdict ? 1 : 0;
  });
  return groups;
}

/**
 * Re-run verification and build the overall review verdict from evidence.
 * @returns {Object} { runId, verdict, tasks, groups, reportClaim, reportRead }
 */
function reviewRun(runId, options) {
  if (!runId) {
    throw new Error('reviewRun: runId is required');
  }
  var norm = normalizeOptions(options);
  var evidenceRoot = path.join(norm.root, norm.evidenceBaseDir);
  var verify = verifyEvidence(runId, { root: norm.root, baseDir: norm.evidenceBaseDir });
  var loaded = evidenceCollector.loadIndex(evidenceRoot, runId);
  var index = loaded && loaded.index ? loaded.index : null;
  var compliance = loadComplianceReport(runId, options);

  var taskIds = Object.keys(verify.tasks || {});
  // The reserved "run-level" key holds run-level evidence files (e.g. the
  // protected-end hash) and is not a canonical task; never score it and never
  // count it against the expected task count.
  taskIds = taskIds.filter(function(id) { return id !== RUN_LEVEL_END; });
  var tasks = {};
  var hasMissing = false;
  var hasUnmetBlock = false;
  var hasPendingBlock = false;
  var hasAssumption = false;
  var hasReadinessPass = false;

  for (var i = 0; i < taskIds.length; i++) {
    var id = taskIds[i];
    var derived = deriveTaskVerdict(id, verify.tasks[id], index);
    tasks[id] = derived;
    if (derived.verdict === MISSING_EVIDENCE) hasMissing = true;
    else if (derived.verdict === RESULT_READINESS_PASS) hasReadinessPass = true;
    else if (derived.verdict === UNRESOLVED_ASSUMPTION) hasAssumption = true;
    else if (derived.verdict === BLOCK) {
      if (derived.status === STATUS_PENDING) hasPendingBlock = true;
      else hasUnmetBlock = true;
    }
  }

  var missingCount = 0;
  if (taskIds.length < norm.expectedTaskCount) {
    missingCount = norm.expectedTaskCount - taskIds.length;
    hasMissing = true;
  }

  var verdict;
  if (hasMissing) verdict = MISSING_EVIDENCE;
  else if (hasUnmetBlock) verdict = BLOCK;
  else if (hasAssumption) verdict = UNRESOLVED_ASSUMPTION;
  else if (hasPendingBlock) verdict = BLOCK;
  else if (hasReadinessPass) verdict = RESULT_READINESS_PASS;
  else verdict = RESULT_PASS;

  var groups = groupByVerdict(tasks);
  if (missingCount > 0 && groups.length === 0) {
    groups.push({
      key: MISSING_EVIDENCE,
      verdict: MISSING_EVIDENCE,
      failureClass: null,
      status: null,
      taskIds: [],
      reasons: {},
      missingCount: missingCount
    });
  }

  var reportClaim = null;
  if (compliance && compliance.report) {
    reportClaim = compliance.report.ok === true ? RESULT_PASS :
      (compliance.report.verdict || compliance.report.overall || null);
  }

  // Chain summaries are read and re-derived from the same evidence verdict map.
  // A chain never changes the overall verdict; the overall verdict comes from
  // all evidence tasks exactly as before. The chains cross-check exists so the
  // review Skill can see the chain-level claim against evidence.
  var chainFiles = loadChainSummaries(runId, options);
  var chains = [];
  for (var c = 0; c < chainFiles.length; c++) {
    var cf = chainFiles[c];
    if (!cf.valid) {
      chains.push({ chainId: cf.chainId, file: cf.file, valid: false, verdict: MISSING_EVIDENCE, failureClass: null, status: null, taskVerdicts: [], declaredResult: null, declaredCoverage: null, consistent: false });
      continue;
    }
    var derived = deriveChainVerdict(cf.summary, tasks);
    derived.file = cf.file;
    derived.valid = true;
    chains.push(derived);
  }

  return {
    runId: runId,
    verdict: verdict,
    reportRead: !!compliance,
    reportClaim: reportClaim,
    reportClaimDiffers: reportClaim !== null && reportClaim !== verdict,
    expectedTaskCount: norm.expectedTaskCount,
    observedTaskCount: taskIds.length,
    missingTaskCount: missingCount,
    tasks: tasks,
    groups: groups,
    chains: chains
  };
}

/**
 * One line per task plus a reasoned paragraph per non-passing group and the
 * overall verdict. Returns the formatted text.
 */
function formatReview(result) {
  var lines = [];
  var ids = Object.keys(result.tasks);
  ids.sort();
  for (var i = 0; i < ids.length; i++) {
    var summary = result.tasks[ids[i]];
    var line = summary.taskId + ' ' + summary.verdict;
    if (summary.failureClass) line += ' ' + summary.failureClass;
    if (summary.status) line += ' ' + summary.status;
    if (summary.cause) line += ' (' + summary.cause + ')';
    lines.push(line);
  }

  for (var g = 0; g < result.groups.length; g++) {
    var group = result.groups[g];
    var names = group.taskIds.length > 0 ? group.taskIds.join(', ') : '';
    var ctx = group.failureClass ? group.failureClass : '';
    if (group.status) ctx += (ctx ? ' ' : '') + group.status;
    var header = group.verdict + (ctx ? ' (' + ctx + ')' : '') + ': ' +
      (names || (group.missingCount ? group.missingCount + ' expected task(s) absent' : 'no tasks'));
    var reason = groupReason(group);
    lines.push(header);
    if (reason) lines.push('  ' + reason);
  }

  // Chain summaries read from reports/<runId>/chain-<id>.json. Each chain is
  // shown with its evidence-derived verdict and whether the chain summary's
  // own claim agrees with the evidence.
  var chainList = result.chains || [];
  for (var ci = 0; ci < chainList.length; ci++) {
    var ch = chainList[ci];
    var chainLine = 'CHAIN ' + (ch.chainId || '?') + ' ' + ch.verdict;
    if (ch.declaredResult) {
      chainLine += ' (summary declared ' + ch.declaredResult + ', ' + (ch.consistent ? 'consistent' : 'INCONSISTENT') + ')';
    }
    if (ch.failureClass) chainLine += ' ' + ch.failureClass;
    if (ch.status) chainLine += ' ' + ch.status;
    lines.push(chainLine);
  }

  lines.push('OVERALL: ' + result.verdict);
  return lines.join('\n');
}

function groupReason(group) {
  var firstReason;
  var firstId;
  var ids = Object.keys(group.reasons || {});
  for (var i = 0; i < ids.length; i++) {
    if (group.reasons[ids[i]]) {
      firstId = ids[i];
      firstReason = group.reasons[ids[i]];
      break;
    }
  }
  if (!firstReason) {
    return null;
  }
  return firstId + ': ' + firstReason;
}

function print(result) {
  console.log(formatReview(result));
}

function main() {
  var runId = process.argv[2];
  if (!runId) {
    console.error('usage: node review.js <runId>');
    process.exit(2);
  }
  var result;
  try {
    result = reviewRun(runId);
  } catch (e) {
    console.error('review failed: ' + e.message);
    process.exit(3);
  }
  print(result);
  process.exit(result.verdict === RESULT_PASS ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  RESULT_PASS: RESULT_PASS,
  RESULT_READINESS_PASS: RESULT_READINESS_PASS,
  MISSING_EVIDENCE: MISSING_EVIDENCE,
  UNRESOLVED_ASSUMPTION: UNRESOLVED_ASSUMPTION,
  BLOCK: BLOCK,
  STATUS_PENDING: STATUS_PENDING,
  STATUS_UNMET: STATUS_UNMET,
  DEFAULT_EXPECTED_TASKS: DEFAULT_EXPECTED_TASKS,
  normalizeOptions: normalizeOptions,
  loadComplianceReport: loadComplianceReport,
  deriveTaskVerdict: deriveTaskVerdict,
  reviewRun: reviewRun,
  formatReview: formatReview,
  groupReason: groupReason,
  loadChainSummaries: loadChainSummaries,
  deriveChainVerdict: deriveChainVerdict,
  SKILL_MD_PATH: SKILL_MD_PATH,
  SKILL_SHA_PATH: SKILL_SHA_PATH,
  skillSha256Hex: skillSha256Hex,
  verifySkillHash: verifySkillHash
};
