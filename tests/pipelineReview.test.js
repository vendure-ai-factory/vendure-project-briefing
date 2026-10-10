'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');

var test = require('node:test');
var assert = require('node:assert');

var terminalState = require('../src/terminalState');
var evidenceCollector = require('../src/evidenceCollector');
var reportGenerator = require('../src/reportGenerator');
var review = require('../skills/pipeline-review/review');

var RESULT_PASS = terminalState.RESULT_PASS;
var FAILURE_CLASSES = terminalState.FAILURE_CLASSES;
var MISSING_EVIDENCE = terminalState.TERMINAL_STATES.MISSING_EVIDENCE;
var UNRESOLVED_ASSUMPTION = terminalState.TERMINAL_STATES.UNRESOLVED_ASSUMPTION;
var BLOCK = terminalState.TERMINAL_STATES.BLOCK;

var REVIEW_PATH = path.resolve(__dirname, '..', 'skills', 'pipeline-review', 'review.js');
var TEST_ROOT = path.resolve(__dirname, '..', 'runs', 'pipeline-review-test-' + Date.now());
var EV_BASE = 'evidence';
var REP_BASE = 'reports';

var ACCEPTANCE_IDS = (function() {
  var manifest = require('../manifest/acceptance-manifest.v0.4.json');
  return manifest.tasks.map(function(t) { return t.canonicalId; })
    .filter(function(id) { return id !== 'CAN-DEMO-01'; });
})();

function opts(extra) {
  var o = {
    root: TEST_ROOT,
    evidenceBaseDir: EV_BASE,
    reportsBaseDir: REP_BASE,
    expectedTaskCount: ACCEPTANCE_IDS.length
  };
  if (extra) Object.assign(o, extra);
  return o;
}

function runEvidencePath(runId) {
  return path.join(TEST_ROOT, EV_BASE, runId);
}

function removeRun(runId) {
  try {
    fs.rmSync(runEvidencePath(runId), { recursive: true, force: true });
  } catch (e) {}
}

function wipeAll() {
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch (e) {}
}

function makeRecord(canonicalId, overrides) {
  var record = {
    canonicalId: canonicalId,
    summarySpecIds: [canonicalId],
    referenceRevision: 'ref-commit',
    executionRevision: 'exec-commit',
    environmentIdentity: 'isolated-clone-1',
    commandInvocation: 'node start --task ' + canonicalId,
    inputArtifactIds: [],
    expectedResult: 'expected',
    actualResult: 'expected',
    exitErrorResult: { exitCode: 0, error: null },
    generatedArtifacts: [],
    stateChanges: ['read-only'],
    cleanupResetResult: { ok: true, resetAt: new Date().toISOString() },
    finalClassification: 'PASS_CANDIDATE',
    naReason: null,
    result: RESULT_PASS,
    classification: null,
    cause: null,
    repairHistory: [],
    manualIntervention: { required: false },
    protectedStartHash: 'pin-abc',
    protectedEndHash: 'pin-abc'
  };
  var merged = Object.assign({}, record, overrides || {});
  return merged;
}

function buildTask(runId, canonicalId, recordOverrides) {
  evidenceCollector.writeEvidenceFile(runId, canonicalId, 'result.json', '{}', opts());
  evidenceCollector.writeTaskRecord(runId, canonicalId, makeRecord(canonicalId, recordOverrides), opts());
}

function buildAllPass(runId) {
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts());
  for (var i = 0; i < ACCEPTANCE_IDS.length; i++) {
    buildTask(runId, ACCEPTANCE_IDS[i]);
  }
}

test('pipelineReview: each failure class fixture keeps its own class and prints the cause', function(t, done) {
  wipeAll();
  var runId = 'pr-foundclasses-' + Date.now();
  var classes = [
    { id: ACCEPTANCE_IDS[0], classification: FAILURE_CLASSES.CLIENT_INPUT_SCOPE, cause: 'VALIDATION_ERROR', expectPending: true },
    { id: ACCEPTANCE_IDS[1], classification: FAILURE_CLASSES.PIPELINE_DEFECT, cause: 'NOT_IMPLEMENTED', expectPending: false },
    { id: ACCEPTANCE_IDS[2], classification: FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT, cause: 'ENVIRONMENT_ERROR', expectPending: true },
    { id: ACCEPTANCE_IDS[3], classification: 'UNRESOLVED_ASSUMPTION', cause: 'PENDING_CLIENT_VALUE', expectPending: false }
  ];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 4 }));
  classes.forEach(function(c) {
    buildTask(runId, c.id, {
      result: BLOCK,
      finalClassification: BLOCK,
      classification: c.classification,
      cause: c.cause
    });
  });
  var result = review.reviewRun(runId, opts({ expectedTaskCount: 4 }));
  assert.strictEqual(result.verdict, BLOCK);
  assert.ok(classes.every(function(c) {
    return result.tasks[c.id].failureClass === c.classification;
  }), 'each fixture keeps its own class');
  classes.forEach(function(c) {
    var row = result.tasks[c.id];
    assert.strictEqual(row.status, c.expectPending ? 'pending' : 'unmet', c.id + ' status');
  });
  var formatted = review.formatReview(result);
  classes.forEach(function(c) {
    assert.ok(formatted.indexOf(c.id + ' BLOCK ' + c.classification) !== -1, c.id + ' prints its own class');
    assert.ok(formatted.indexOf('(' + c.cause + ')') !== -1, c.id + ' prints its cause');
  });
  removeRun(runId);
  done();
});

test('pipelineReview: all 24 tasks PASS gives PASS and CLI exit 0', function(t, done) {
  wipeAll();
  var runId = 'pr-allpass-' + Date.now();
  buildAllPass(runId);

  var result = review.reviewRun(runId, opts());
  assert.strictEqual(result.verdict, RESULT_PASS, 'overall verdict should be PASS');
  assert.strictEqual(result.observedTaskCount, 24);
  assert.strictEqual(result.missingTaskCount, 0);
  assert.strictEqual(result.reportRead, false, 'no compliance report present');

  var formatted = review.formatReview(result);
  assert.ok(formatted.indexOf('OVERALL: ' + RESULT_PASS) !== -1);

  var spawned = childProcess.spawnSync(process.execPath, [REVIEW_PATH, runId], {
    cwd: TEST_ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(spawned.status, 0, 'CLI exit code should be 0 only for PASS');
  assert.ok(spawned.stdout.indexOf('OVERALL: ' + RESULT_PASS) !== -1);
  removeRun(runId);
  done();
});

test('pipelineReview: tampered evidence file gives MISSING_EVIDENCE', function(t, done) {
  wipeAll();
  var runId = 'pr-tamper-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId);
  // Tamper directly on disk, bypassing writeEvidenceFile, so the index hash no longer matches.
  fs.writeFileSync(path.join(runEvidencePath(runId), canonicalId, 'result.json'), 'TAMPERED', 'utf8');

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.verdict, MISSING_EVIDENCE);
  assert.strictEqual(result.tasks[canonicalId].verdict, MISSING_EVIDENCE);
  removeRun(runId);
  done();
});

test('pipelineReview: CLIENT_INPUT_SCOPE block is reported pending', function(t, done) {
  wipeAll();
  var runId = 'pr-pending-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId, {
    result: BLOCK,
    classification: { failureClass: FAILURE_CLASSES.CLIENT_INPUT_SCOPE, reason: 'staging credentials pending' },
    cause: 'staging credentials not supplied'
  });

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.verdict, BLOCK);
  assert.strictEqual(result.tasks[canonicalId].verdict, BLOCK);
  assert.strictEqual(result.tasks[canonicalId].status, 'pending');
  assert.strictEqual(result.tasks[canonicalId].failureClass, FAILURE_CLASSES.CLIENT_INPUT_SCOPE);

  var formatted = review.formatReview(result);
  assert.ok(formatted.indexOf(canonicalId + ' BLOCK ' + FAILURE_CLASSES.CLIENT_INPUT_SCOPE + ' pending') !== -1);
  removeRun(runId);
  done();
});

test('pipelineReview: PIPELINE_DEFECT block is reported unmet', function(t, done) {
  wipeAll();
  var runId = 'pr-unmet-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId, {
    result: BLOCK,
    classification: { failureClass: FAILURE_CLASSES.PIPELINE_DEFECT, reason: 'runner bug' },
    cause: 'runner crashed mid-step'
  });

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.verdict, BLOCK);
  assert.strictEqual(result.tasks[canonicalId].status, 'unmet');
  assert.strictEqual(result.tasks[canonicalId].failureClass, FAILURE_CLASSES.PIPELINE_DEFECT);

  var formatted = review.formatReview(result);
  assert.ok(formatted.indexOf('BLOCK (' + FAILURE_CLASSES.PIPELINE_DEFECT + ' unmet)') !== -1);
  removeRun(runId);
  done();
});

test('pipelineReview: missing protected-hashes pin gives UNRESOLVED_ASSUMPTION', function(t, done) {
  wipeAll();
  var runId = 'pr-nopin-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];
  // No protectedPathsHash in the index meta => no pin.
  evidenceCollector.initEvidenceIndex(runId, {}, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId);

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.verdict, UNRESOLVED_ASSUMPTION);
  assert.strictEqual(result.tasks[canonicalId].verdict, UNRESOLVED_ASSUMPTION);
  removeRun(runId);
  done();
});

test('pipelineReview: report claims PASS but evidence says BLOCK so review returns BLOCK', function(t, done) {
  wipeAll();
  var runId = 'pr-distrust-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];

  // Build genuine PASS evidence and persist a PASS-claiming compliance report.
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId, { result: RESULT_PASS, classification: null });
  var generated = reportGenerator.generateReport(runId, { root: TEST_ROOT, baseDir: EV_BASE });
  assert.strictEqual(generated.ok, true, 'report generated from PASS evidence should claim ok');
  var reportsDir = path.join(TEST_ROOT, REP_BASE, runId);
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'compliance-report.json'), JSON.stringify(generated, null, 2) + '\n', 'utf8');

  // Replace the evidence with a clean BLOCK run through the real writers.
  var cleanupResult = evidenceCollector.cleanupEvidence(runId, { root: TEST_ROOT, baseDir: EV_BASE });
  assert.strictEqual(cleanupResult.ok, true);
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId, {
    result: BLOCK,
    classification: { failureClass: FAILURE_CLASSES.PIPELINE_DEFECT, reason: 'runner bug' },
    cause: 'runner crashed'
  });

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.reportRead, true, 'compliance report should have been read');
  assert.strictEqual(result.reportClaim, RESULT_PASS, 'report claims a PASS verdict');
  assert.strictEqual(result.reportClaimDiffers, true, 'report claim must differ from derived verdict');
  assert.strictEqual(result.verdict, BLOCK, 'review must not trust the report; returns BLOCK');
  assert.strictEqual(result.tasks[canonicalId].verdict, BLOCK);
  removeRun(runId);
  done();
});

test('pipelineReview: verdict precedence MISSING_EVIDENCE beats BLOCK', function(t, done) {
  wipeAll();
  var runId = 'pr-precedence-' + Date.now();
  var idA = ACCEPTANCE_IDS[0];
  var idB = ACCEPTANCE_IDS[1];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 2 }));
  // One BLOCK (unmet) and one MISSING_EVIDENCE (tampered hash).
  buildTask(runId, idA, {
    result: BLOCK,
    classification: { failureClass: FAILURE_CLASSES.PIPELINE_DEFECT, reason: 'x' }
  });
  buildTask(runId, idB);
  fs.writeFileSync(path.join(runEvidencePath(runId), idB, 'result.json'), 'TAMPERED', 'utf8');

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 2 }));
  assert.strictEqual(result.verdict, MISSING_EVIDENCE, 'missing evidence must take precedence over an unmet block');
  removeRun(runId);
  done();
});

test('pipelineReview: --task all style fixtures with per-task "run-level" ends stay PASS', function(t, done) {
  wipeAll();
  var runId = 'pr-rl-defer-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts());
  for (var i = 0; i < ACCEPTANCE_IDS.length; i++) {
    buildTask(runId, ACCEPTANCE_IDS[i], {
      protectedStartHash: 'pin-abc',
      protectedEndHash: 'run-level'
    });
  }
  // The run-level protected-end evidence file and its hash in index.meta are
  // what the review must defer per-task "run-level" ends to.
  evidenceCollector.writeEvidenceFile(runId, 'run-level', 'protected-end.json',
    JSON.stringify({ kind: 'protected-end', combinedHash: 'pin-abc' }), opts());
  evidenceCollector.updateRunMeta(runId, { protectedEndHash: 'pin-abc' }, opts());

  var result = review.reviewRun(runId, opts());
  assert.strictEqual(result.verdict, RESULT_PASS, 'run-level deferred ends must not give MISSING_EVIDENCE');
  assert.strictEqual(result.observedTaskCount, 24, 'the run-level pseudo-task must not count toward the 24');
  assert.strictEqual(result.missingTaskCount, 0);
  assert.strictEqual(result.tasks['run-level'], undefined, 'run-level pseudo-task must not be scored');
  removeRun(runId);
  done();
});

test('pipelineReview: a real start/end mismatch still gives MISSING_EVIDENCE', function(t, done) {
  wipeAll();
  var runId = 'pr-rl-realmismatch-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId, {
    protectedStartHash: 'start-hash',
    protectedEndHash: 'end-differs'
  });

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.verdict, MISSING_EVIDENCE);
  assert.strictEqual(result.tasks[canonicalId].verdict, MISSING_EVIDENCE);
  assert.ok(
    result.tasks[canonicalId].reason.indexOf('protected-path hash mismatch (start != end)') !== -1,
    'reason should cite the start/end mismatch'
  );
  removeRun(runId);
  done();
});

test('pipelineReview: a changed run-level end hash still gives MISSING_EVIDENCE', function(t, done) {
  wipeAll();
  var runId = 'pr-rl-endmismatch-' + Date.now();
  var canonicalId = ACCEPTANCE_IDS[0];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: 1 }));
  buildTask(runId, canonicalId, {
    protectedStartHash: 'pin-abc',
    protectedEndHash: 'run-level'
  });
  // Run-level end hash in index.meta differs from the pinned hash.
  evidenceCollector.writeEvidenceFile(runId, 'run-level', 'protected-end.json',
    JSON.stringify({ kind: 'protected-end', combinedHash: 'changed-hash' }), opts());
  evidenceCollector.updateRunMeta(runId, { protectedEndHash: 'changed-hash' }, opts());

  var result = review.reviewRun(runId, opts({ expectedTaskCount: 1 }));
  assert.strictEqual(result.verdict, MISSING_EVIDENCE);
  assert.strictEqual(result.tasks[canonicalId].verdict, MISSING_EVIDENCE);
  assert.ok(
    result.tasks[canonicalId].reason.indexOf('protected-path end hash differs from pinned hash') !== -1,
    'reason should cite the run-level end hash mismatch'
  );
  removeRun(runId);
  done();
});

// ---------------------------------------------------------------------------
// Chain summaries (chunk 16): the review reads reports/<runId>/chain-<id>.json
// and re-derives each chain's verdict from evidence.
// ---------------------------------------------------------------------------

function writeChainSummary(runId, chainId, summaryOverrides) {
  var chainDir = path.join(TEST_ROOT, REP_BASE, runId);
  fs.mkdirSync(chainDir, { recursive: true });
  var summary = {
    chainId: chainId,
    canonicalIds: [],
    result: RESULT_PASS,
    coverage: 'full',
    tasks: []
  };
  Object.assign(summary, summaryOverrides || {});
  fs.writeFileSync(path.join(chainDir, 'chain-' + chainId + '.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

test('pipelineReview: reads a chain summary and re-derives a PASS chain from evidence', function(t, done) {
  wipeAll();
  var runId = 'pr-chain-pass-' + Date.now();
  var ids = ['CAN-B2-04', 'CAN-B2-11', 'CAN-B2-12'];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: ids.length }));
  ids.forEach(function(id) { buildTask(runId, id); });
  writeChainSummary(runId, 'BE', { canonicalIds: ids });

  var result = review.reviewRun(runId, opts({ expectedTaskCount: ids.length }));
  assert.strictEqual(result.verdict, RESULT_PASS);
  assert.strictEqual(result.chains.length, 1);
  var ch = result.chains[0];
  assert.strictEqual(ch.chainId, 'BE');
  assert.strictEqual(ch.verdict, RESULT_PASS);
  assert.strictEqual(ch.consistent, true);
  var formatted = review.formatReview(result);
  assert.ok(formatted.indexOf('CHAIN BE ' + RESULT_PASS) !== -1);
  assert.ok(formatted.indexOf('consistent') !== -1);
  removeRun(runId);
  done();
});

test('pipelineReview: flags a chain summary that claims PASS when evidence BLOCKS', function(t, done) {
  wipeAll();
  var runId = 'pr-chain-liar-' + Date.now();
  var ids = ['CAN-B2-04', 'CAN-B2-11', 'CAN-B2-12'];
  evidenceCollector.initEvidenceIndex(runId, { protectedPathsHash: 'pin-abc' }, opts({ expectedTaskCount: ids.length }));
  for (var bi = 0; bi < ids.length; bi++) {
    var bid = ids[bi];
    if (bid === 'CAN-B2-12') {
      // Bust this task's evidence once so its re-derived verdict is not PASS.
      buildTask(runId, 'CAN-B2-12', {
        result: BLOCK,
        finalClassification: BLOCK,
        classification: FAILURE_CLASSES.PIPELINE_DEFECT,
        cause: 'NOT_IMPLEMENTED'
      });
    } else {
      buildTask(runId, bid);
    }
  }
  writeChainSummary(runId, 'BE', { canonicalIds: ids, result: RESULT_PASS });

  var result = review.reviewRun(runId, opts({ expectedTaskCount: ids.length }));
  assert.strictEqual(result.verdict, BLOCK);
  var ch = result.chains[0];
  assert.strictEqual(ch.chainId, 'BE');
  assert.strictEqual(ch.verdict, BLOCK);
  assert.strictEqual(ch.failureClass, FAILURE_CLASSES.PIPELINE_DEFECT);
  assert.strictEqual(ch.consistent, false, 'summary over-claims PASS');
  var formatted = review.formatReview(result);
  assert.ok(formatted.indexOf('INCONSISTENT') !== -1);
  removeRun(runId);
  done();
});

// ---------------------------------------------------------------------------
// pipeline-review Skill content hash (SKILL.md pinned by SKILL.sha256)
// ---------------------------------------------------------------------------

var SKILL_MD_PATH = path.join(__dirname, '..', 'skills', 'pipeline-review', 'SKILL.md');
var SKILL_SHA_PATH = path.join(__dirname, '..', 'skills', 'pipeline-review', 'SKILL.sha256');

test('pipelineReview skill hash: matches the pin for LF and CRLF content', function(t, done) {
  var lf = fs.readFileSync(SKILL_MD_PATH, 'utf8').replace(/\r\n/g, '\n');
  var crlf = lf.replace(/\n/g, '\r\n');
  var pinned = fs.readFileSync(SKILL_SHA_PATH, 'utf8').trim();
  assert.strictEqual(review.skillSha256Hex(lf), pinned, 'LF content hashes to the pinned skill sha256');
  assert.strictEqual(review.skillSha256Hex(crlf), pinned, 'CRLF content hashes to the same pinned skill sha256');
  done();
});

test('pipelineReview skill hash: verifySkillHash passes on the real files', function(t, done) {
  var res = review.verifySkillHash();
  assert.strictEqual(res.ok, true, 'skill hash verifies against the pinned sha256');
  assert.strictEqual(res.sha256, fs.readFileSync(SKILL_SHA_PATH, 'utf8').trim(), 'verified sha256 is the pinned value');
  done();
});

test('pipelineReview skill hash: verifySkillHash detects a tampered skill file', function(t, done) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tamper-'));
  var mdPath = path.join(tmpDir, 'SKILL.md');
  var shaPath = path.join(tmpDir, 'SKILL.sha256');
  fs.copyFileSync(SKILL_MD_PATH, mdPath);
  fs.copyFileSync(SKILL_SHA_PATH, shaPath);
  fs.appendFileSync(mdPath, '\ntampered\n', 'utf8');

  var res = review.verifySkillHash(mdPath, shaPath);
  assert.strictEqual(res.ok, false, 'tampered skill must be rejected');
  assert.ok(res.error.indexOf('mismatch') !== -1, 'error names the hash mismatch');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  done();
});
