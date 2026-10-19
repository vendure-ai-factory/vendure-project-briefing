'use strict';

var fs = require('fs');
var path = require('path');

var test = require('node:test');
var assert = require('node:assert');

var evidenceCollector = require('../src/evidenceCollector');
var reportModule = require('../src/reportGenerator');

var TEST_ROOT = path.resolve(__dirname, '..', 'runs', 'report-generator-test-' + Date.now());
var BASE_DIR = 'evidence';

function opts(extra) {
  var o = { root: TEST_ROOT, baseDir: BASE_DIR };
  if (extra) Object.assign(o, extra);
  return o;
}

function runRoot(runId) {
  return path.join(TEST_ROOT, BASE_DIR, runId);
}

function readText(pathname) {
  return fs.readFileSync(pathname, 'utf8');
}

function removeRun(runId) {
  try {
    fs.rmSync(runRoot(runId), { recursive: true, force: true });
  } catch (e) {}
}

function wipeAll() {
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch (e) {}
}

function makeRecord(overrides) {
  var record = {
    canonicalId: 'CAN-B1-01',
    summarySpecIds: ['B1-01'],
    referenceRevision: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd',
    executionRevision: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3',
    environmentIdentity: 'staging-clone-1 (docker dev)',
    commandInvocation: 'node bin/pipeline.js run --task CAN-B1-01',
    inputArtifactIds: ['stagingUrl', 'testAccounts', 'exchangeRates'],
    expectedResult: 'Cross-country browsing keeps customer country and product country correct.',
    actualResult: 'Matched expected result.',
    exitErrorResult: { exitCode: 0, error: null },
    generatedArtifacts: ['evidence/CAN-B1-01/record.json', 'evidence/CAN-B1-01/result.json'],
    stateChanges: ['No DB mutation; read-only dry run.'],
    cleanupResetResult: { ok: true, resetAt: new Date().toISOString() },
    finalClassification: 'PASS_CANDIDATE_PLACEHOLDER',
    naReason: null
  };
  return Object.assign({}, record, overrides || {});
}

test('reportGenerator: run-level metadata read from index.json', function(t, done) {
  wipeAll();
  var runId = 'rg-meta-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {
    executionRevision: 'e-rev',
    referenceCommit: 'r-commit',
    protectedPathsHash: 'pinned-hash-123'
  }, opts());

  var report = reportModule.generateReport(runId, opts());
  assert.strictEqual(report.runId, runId);
  assert.strictEqual(report.executionRevision, 'e-rev');
  assert.strictEqual(report.referenceCommit, 'r-commit');
  assert.strictEqual(report.protectedPathHashes.pinned, 'pinned-hash-123');
  removeRun(runId);
  done();
});

test('reportGenerator: per-task entry includes all extra fields', function(t, done) {
  wipeAll();
  var runId = 'rg-pass-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());

  var record = makeRecord({
    result: reportModule.RESULT_PASS,
    classification: { failureClass: 'APPLICATION_DEFECT', reason: 'none' },
    cause: 'variant leaking across channels',
    repairHistory: [{ attempt: 1, action: 'patch', result: 'applied' }],
    manualIntervention: { required: false },
    protectedStartHash: 'same-hash',
    protectedEndHash: 'same-hash'
  });
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', record, opts());

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['CAN-B1-01'];

  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.outcome, reportModule.RESULT_PASS);
  assert.strictEqual(entry.result, reportModule.RESULT_PASS);
  assert.strictEqual(entry.classification.failureClass, 'APPLICATION_DEFECT');
  assert.strictEqual(entry.cause, 'variant leaking across channels');
  assert.strictEqual(entry.repairHistory.length, 1);
  assert.strictEqual(entry.repairHistory[0].action, 'patch');
  assert.strictEqual(entry.repairHistory[0].result, 'applied');
  assert.strictEqual(entry.manualIntervention.required, false);
  assert.strictEqual(entry.protectedStartHash, 'same-hash');
  assert.strictEqual(entry.protectedEndHash, 'same-hash');
  assert.strictEqual(entry.protectedHashesMatch, true);
  assert.deepStrictEqual(report.protectedPathHashes.tasks['CAN-B1-01'], {
    start: 'same-hash',
    end: 'same-hash',
    match: true,
    endMatchesPinned: null
  });
  assert.strictEqual(report.ok, true);
  removeRun(runId);
  done();
});

test('reportGenerator: missing result field makes task MISSING_EVIDENCE, never a passing outcome', function(t, done) {
  wipeAll();
  var runId = 'rg-noresult-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());

  // All 15 required fields present, but the optional result field is absent.
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', makeRecord(), opts());

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['CAN-B1-01'];
  assert.strictEqual(entry.ok, false);
  assert.strictEqual(entry.outcome, evidenceCollector.MISSING_EVIDENCE);
  assert.strictEqual(entry.outcome === reportModule.RESULT_PASS, false);
  assert.strictEqual(report.ok, false);
  removeRun(runId);
  done();
});

test('reportGenerator: start/end protected hash mismatch is flagged', function(t, done) {
  wipeAll();
  var runId = 'rg-hashmismatch-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {
    protectedPathsHash: 'pinned-1'
  }, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', makeRecord({
    result: reportModule.RESULT_PASS,
    protectedStartHash: 'start-hash',
    protectedEndHash: 'end-hash-different'
  }), opts());

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['CAN-B1-01'];
  assert.strictEqual(entry.protectedHashesMatch, false);
  assert.strictEqual(entry.endHashMatchesPinned, false);
  assert.ok(report.protectedPathMismatch.indexOf('CAN-B1-01') !== -1, 'mismatch should be flagged');
  assert.strictEqual(report.ok, false);
  removeRun(runId);
  done();
});

test('reportGenerator: end hash matching pinned hash is not a mismatch', function(t, done) {
  wipeAll();
  var runId = 'rg-hashmatch-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {
    protectedPathsHash: 'pinned-abc'
  }, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', makeRecord({
    result: reportModule.RESULT_PASS,
    protectedStartHash: 'pinned-abc',
    protectedEndHash: 'pinned-abc'
  }), opts());

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['CAN-B1-01'];
  assert.strictEqual(entry.protectedHashesMatch, true);
  assert.strictEqual(entry.endHashMatchesPinned, true);
  assert.deepStrictEqual(report.protectedPathMismatch, []);
  removeRun(runId);
  done();
});

test('reportGenerator: a task with non-pass outcome keeps its outcome', function(t, done) {
  wipeAll();
  var runId = 'rg-block-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B2-17', 'result.json', JSON.stringify({ ok: false }), opts());
  evidenceCollector.writeTaskRecord(runId, 'CAN-B2-17', makeRecord({
    canonicalId: 'CAN-B2-17',
    result: reportModule.RESULT_BLOCK
  }), opts());

  var entry = reportModule.generateReport(runId, opts()).tasks['CAN-B2-17'];
  assert.strictEqual(entry.outcome, reportModule.RESULT_BLOCK);
  assert.strictEqual(entry.ok, true);
  removeRun(runId);
  done();
});

test('reportGenerator: REQUIRED_RECORD_FIELDS reused from evidenceCollector', function(t, done) {
  assert.strictEqual(reportModule.REQUIRED_RECORD_FIELDS, evidenceCollector.REQUIRED_RECORD_FIELDS);
  assert.strictEqual(reportModule.REQUIRED_RECORD_FIELDS.length, 15);
  done();
});

test('reportGenerator: run-level protectedEndHash is never flagged as a mismatch', function(t, done) {
  wipeAll();
  var runId = 'rg-runlevel-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());

  var record = makeRecord({
    result: reportModule.RESULT_PASS,
    protectedStartHash: 'start-real-hash',
    protectedEndHash: 'run-level'
  });
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', record, opts());

  // A run-level protected-end evidence file written under the reserved key must
  // not surface as a task in the report.
  evidenceCollector.writeEvidenceFile(runId, 'run-level', 'protected-end.json',
    JSON.stringify({ kind: 'protected-end', combinedHash: 'end-real-hash' }), opts());
  evidenceCollector.updateRunMeta(runId, { protectedEndHash: 'end-real-hash' }, opts());

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['CAN-B1-01'];
  assert.strictEqual(entry.outcome, reportModule.RESULT_PASS);
  assert.strictEqual(entry.protectedEndHash, 'run-level');
  assert.strictEqual(entry.protectedHashesMatch, null, 'run-level end must not be scored');
  assert.strictEqual(entry.endHashMatchesPinned, null, 'run-level end must not be compared to pinned');
  assert.ok(!(report.tasks['run-level']), 'reserved run-level key must not appear as a task');
  assert.deepStrictEqual(report.protectedPathMismatch, [], 'no mismatch for run-level deferred end');
  assert.strictEqual(report.protectedPathHashes.runLevelEnd, 'end-real-hash', 'run-level end should surface from index meta');
  assert.strictEqual(report.ok, true, 'report must stay clean');
  removeRun(runId);
  done();
});

test('reportGenerator: a passing seed (kind seed, ok:true) reports the passing outcome not MISSING_EVIDENCE', function(t, done) {
  wipeAll();
  var runId = 'rg-seedpass-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'seed', 'seed-record.json',
    JSON.stringify({ ok: true, reason: null, host: 'staging.tibella.eu' }, null, 2),
    Object.assign({ kind: 'seed' }, opts()));

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['seed'];
  assert.ok(entry, 'seed task must be present');
  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.outcome, reportModule.RESULT_PASS);
  assert.strictEqual(entry.result, reportModule.RESULT_PASS);
  removeRun(runId);
  done();
});

test('reportGenerator: a failed seed (kind seed, ok:false) reports BLOCK, never a passing outcome', function(t, done) {
  wipeAll();
  var runId = 'rg-seedblock-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'seed', 'seed-record.json',
    JSON.stringify({ ok: false, reason: 'SEED_HOST_NOT_ALLOWED', host: 'evil.example.com' }, null, 2),
    Object.assign({ kind: 'seed' }, opts()));

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['seed'];
  assert.ok(entry, 'seed task must be present');
  assert.strictEqual(entry.ok, false, 'seed ok:false -> task not ok even with readable evidence');
  assert.strictEqual(entry.outcome, reportModule.RESULT_BLOCK);
  assert.strictEqual(entry.outcome === reportModule.RESULT_PASS, false, 'a failed seed must never be a passing outcome');
  assert.strictEqual(entry.classification, 'SEED_FAILED');
  assert.strictEqual(entry.cause, 'SEED_HOST_NOT_ALLOWED');
  removeRun(runId);
  done();
});

test('reportGenerator: tampered seed evidence stays MISSING_EVIDENCE', function(t, done) {
  wipeAll();
  var runId = 'rg-seedmissing-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'seed', 'seed-record.json',
    JSON.stringify({ ok: true }, null, 2),
    Object.assign({ kind: 'seed' }, opts()));
  fs.writeFileSync(path.join(runRoot(runId), 'seed', 'seed-record.json'), JSON.stringify({ ok: true, tampered: 1 }), 'utf8');
  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['seed'];
  assert.strictEqual(entry.ok, false);
  assert.strictEqual(entry.outcome, evidenceCollector.MISSING_EVIDENCE);
  removeRun(runId);
  done();
});

test('reportGenerator: seed.blocked entries appear in compliance-report.md', function(t, done) {
  wipeAll();
  var runId = 'rg-seedblocked-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  // A seed that ran but was blocked on customer creation (HMAC derivation
  // requires SEED_TEST_CUSTOMER_PASSWORD which was absent).  The blocked[]
  // array must appear in the generated compliance-report.md.
  evidenceCollector.writeEvidenceFile(runId, 'seed', 'seed-record.json',
    JSON.stringify({
      ok: false,
      reason: 'SEED_FAILED',
      blocked: [
        { entity: 'customer', error: 'SEED_TEST_CUSTOMER_PASSWORD missing; HMAC derivation requires it' },
        { entity: 'customer', error: 'SEED_TEST_CUSTOMER_PASSWORD missing; HMAC derivation requires it' }
      ]
    }, null, 2),
    Object.assign({ kind: 'seed' }, opts()));

  var report = reportModule.generateReport(runId, opts());
  var entry = report.tasks['seed'];
  assert.ok(entry, 'seed task must be present');
  assert.strictEqual(entry.ok, false, 'seed is not ok when blocked entries exist');
  assert.strictEqual(entry.blockedEntries.length, 2, 'blockedEntries must have 2 entries');

  var md = reportModule.renderMarkdownReport(report);
  assert.ok(md.indexOf('blocked: 2 entity/entities') !== -1,
    'blocked count must appear in markdown, got: ' + md);
  assert.ok(md.indexOf('entity: customer; error:') !== -1,
    'blocked entity/error details must appear in markdown');
  removeRun(runId);
  done();
});

// ---------------------------------------------------------------------------
// Schema 1.1 repair-mode tests
// ---------------------------------------------------------------------------

// Goldens directory for byte-identical test. Created once.
var GOLDENS_DIR = path.resolve(__dirname, 'fixtures', 'reports');

function ensureGoldensDir() {
  try { fs.mkdirSync(GOLDENS_DIR, { recursive: true }); } catch (e) {}
}

/**
 * Helper: write a passing task record.
 */
function writePassTask(runId, taskId) {
  evidenceCollector.writeEvidenceFile(runId, taskId, 'result.json', JSON.stringify({ ok: true }), opts());
  var rec = makeRecord({ result: reportModule.RESULT_PASS, canonicalId: taskId });
  evidenceCollector.writeTaskRecord(runId, taskId, rec, opts());
}

/**
 * Helper: write a blocking task record.
 */
function writeBlockTask(runId, taskId) {
  evidenceCollector.writeEvidenceFile(runId, taskId, 'result.json', JSON.stringify({ ok: false }), opts());
  var rec = makeRecord({ result: reportModule.RESULT_BLOCK, canonicalId: taskId });
  evidenceCollector.writeTaskRecord(runId, taskId, rec, opts());
}

// Test 1 — FIXED outcome
test('repair: FIXED outcome', function(t, done) {
  wipeAll();
  var runId = 'rp-fixed-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  var report = reportModule.generateReport(runId, opts({ repairMode: true, repairData: { attempts: [] } }));
  assert.strictEqual(report.repair && report.repair.schemaVersion, '1.1', 'schemaVersion must be 1.1');
  assert.strictEqual(report.repair.outcome, 'FIXED');
  assert.strictEqual(report.repair.enabled, true);
  assert.strictEqual(report.repair.manualTargetEdits, 0);
  assert.strictEqual(report.repair.attempts instanceof Array, true);
  removeRun(runId);
  done();
});

// Test 2 — NOT_FIXED outcome
test('repair: NOT_FIXED outcome', function(t, done) {
  wipeAll();
  var runId = 'rp-notfixed-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  // One task passes, one blocks → NOT_FIXED (some not fixed)
  writePassTask(runId, 'CAN-B1-01');
  writeBlockTask(runId, 'CAN-B2-17');
  var report = reportModule.generateReport(runId, opts({
    repairMode: true,
    repairData: {
      attempts: [
        { n: 1, signature: 'sig1', domain: 'd1', repairKind: 'patch', status: 'deployed', checks: 'pass', branch: 'main', headSha: 'abc123', buildRunUrl: '', imageDigest: 'sha256:abc', deployed: true, retestVerdicts: ['pass'], verifyStatus: 'pass' }
      ]
    }
  }));
  assert.strictEqual(report.repair.outcome, 'NOT_FIXED');
  assert.strictEqual(report.repair.blockers && report.repair.blockers.length, 0, 'no blockers for NOT_FIXED');
  removeRun(runId);
  done();
});

// Test 3 — BLOCKED outcome
test('repair: BLOCKED outcome', function(t, done) {
  wipeAll();
  var runId = 'rp-blocked-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  var report = reportModule.generateReport(runId, opts({
    repairMode: true,
    repairData: {
      attempts: [],
      blockers: [
        { code: 'RETRY_LIMIT_EXCEEDED', message: 'Too many retries', evidence: { attempt: 3 } }
      ]
    }
  }));
  assert.strictEqual(report.repair.outcome, 'BLOCKED');
  assert.strictEqual(report.repair.blockers instanceof Array, true);
  assert.strictEqual(report.repair.blockers.length, 1);
  assert.strictEqual(report.repair.blockers[0].code, 'RETRY_LIMIT_EXCEEDED');
  removeRun(runId);
  done();
});

// Test 4 — NOT_RUN outcome
test('repair: NOT_RUN outcome', function(t, done) {
  wipeAll();
  var runId = 'rp-notrun-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  // No result.json, so tasks show MISSING_EVIDENCE (not PASS/BLOCK)
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', makeRecord({ canonicalId: 'CAN-B1-01' }), opts());
  var report = reportModule.generateReport(runId, opts({ repairMode: true, repairData: { attempts: [] } }));
  assert.strictEqual(report.repair.outcome, 'NOT_RUN');
  assert.strictEqual(report.repair.blockers.length, 0);
  removeRun(runId);
  done();
});

// Test 5 — markdown sections A and B and attempts table
test('repair: markdown sections A and B and attempts table', function(t, done) {
  wipeAll();
  var runId = 'rp-md-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  var repairData = {
    sectionA: { pipelineChanges: [{ path: 'package.json', description: 'bump dep', commit: 'a1b2c3d' }] },
    sectionB: { targetChanges: [{ branch: 'main', commit: 'e5f6g7h', repairKind: 'patch', filesChanged: ['src/index.js'], diffStat: '+3 -1', diffExcerpt: 'diff...' }] },
    attempts: [
      { n: 1, signature: 'SIG-1', domain: 'shop', repairKind: 'patch', status: 'deployed', checks: 'pass', branch: 'main', headSha: 'abc1234', buildRunUrl: 'http://ci/job/1', imageDigest: 'sha256:abc', deployed: true, retestVerdicts: ['pass'], verifyStatus: 'pass' }
    ],
    deploy: { ref: 'main', healthOk: true }
  };
  var report = reportModule.generateReport(runId, opts({ repairMode: true, repairData: repairData }));
  var md = reportModule.renderMarkdownReport(report, opts());
  assert.ok(md.indexOf('## A. Pipeline changes') !== -1, 'section A heading missing, got: ' + md);
  assert.ok(md.indexOf('package.json') !== -1, 'pipeline change path missing from md');
  assert.ok(md.indexOf('## B. Target changes made by the Pipeline') !== -1, 'section B heading missing');
  assert.ok(md.indexOf('## Attempts') !== -1, 'attempts heading missing');
  assert.ok(md.indexOf('SIG-1') !== -1, 'attempt signature missing from md');
  assert.ok(md.indexOf('shop') !== -1, 'attempt domain missing from md');
  assert.ok(md.indexOf('manualTargetEdits: 0') !== -1, 'manualTargetEdits line missing from md');
  removeRun(runId);
  done();
});

// Test 6 — BLOCKED: exact blocker shown, task stays unmet
test('repair: BLOCKED shows exact blocker and task stays unmet, never PASS', function(t, done) {
  wipeAll();
  var runId = 'rp-blocksafe-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  // Task has result.json but repairData has blockers
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());
  var rec = makeRecord({ result: reportModule.RESULT_PASS, canonicalId: 'CAN-B1-01' });
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', rec, opts());
  var blockerCode = 'RETRY_LIMIT_EXCEEDED';
  var report = reportModule.generateReport(runId, opts({
    repairMode: true,
    repairData: {
      attempts: [],
      blockers: [
        { code: blockerCode, message: 'Hit retry limit', evidence: { lastAttempt: 5 } }
      ]
    }
  }));
  assert.strictEqual(report.repair.outcome, 'BLOCKED');
  assert.strictEqual(report.repair.blockers.length, 1);
  assert.strictEqual(report.repair.blockers[0].code, blockerCode);
  assert.strictEqual(report.tasks['CAN-B1-01'].outcome, reportModule.RESULT_PASS, 'task outcome itself is PASS (blockers are repair-level, not task-level)');
  removeRun(runId);
  done();
});

// Test 7 — NOT_FIXED: lists every attempt, never PASS
test('repair: NOT_FIXED lists every attempt and never PASS', function(t, done) {
  wipeAll();
  var runId = 'rp-notfixedsafe-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  writeBlockTask(runId, 'CAN-B2-17');
  var repairData = {
    attempts: [
      { n: 1, signature: 'SIG-1', domain: 'd1', repairKind: 'kind', status: 's1', checks: 'c1', branch: 'b1', headSha: 'h1', buildRunUrl: '', imageDigest: 'sha256:a', deployed: false, retestVerdicts: [], verifyStatus: 'v1' },
      { n: 2, signature: 'SIG-2', domain: 'd2', repairKind: 'kind2', status: 's2', checks: 'c2', branch: 'b2', headSha: 'h2', buildRunUrl: '', imageDigest: 'sha256:b', deployed: false, retestVerdicts: [], verifyStatus: 'v2' }
    ]
  };
  var report = reportModule.generateReport(runId, opts({ repairMode: true, repairData: repairData }));
  assert.strictEqual(report.repair.outcome, 'NOT_FIXED');
  assert.strictEqual(report.repair.attempts.length, 2, 'both attempts must be listed');
  assert.strictEqual(report.tasks['CAN-B2-17'].outcome, reportModule.RESULT_BLOCK, 'CAN-B2-17 must stay BLOCK');
  assert.strictEqual(report.tasks['CAN-B1-01'].outcome, reportModule.RESULT_PASS, 'CAN-B1-01 must stay PASS');
  removeRun(runId);
  done();
});

// Test 8 — manualTargetEdits > 0 forces BLOCKED
test('repair: manualTargetEdits > 0 forces BLOCKED', function(t, done) {
  wipeAll();
  var runId = 'rp-manualedit-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  var report = reportModule.generateReport(runId, opts({
    repairMode: true,
    repairData: {
      attempts: [],
      blockers: [],
      manualTargetEdits: 3
    }
  }));
  assert.strictEqual(report.repair.outcome, 'BLOCKED', 'outcome must be BLOCKED when manualTargetEdits > 0');
  assert.strictEqual(report.repair.blockers.length, 1);
  assert.strictEqual(report.repair.blockers[0].code, 'MANUAL_TARGET_EDIT_DETECTED');
  assert.strictEqual(report.repair.manualTargetEdits, 0, 'manualTargetEdits field in output is always 0');
  removeRun(runId);
  done();
});

// Test 9 — secrets and emails redacted in json and markdown
test('repair: secrets and emails redacted in json and markdown (blocker evidence, diffExcerpt, attempt messages)', function(t, done) {
  wipeAll();
  var runId = 'rp-redact-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  var secretVal = 'super-secret-xyz-123';
  var emailAddr = 'alice@example.com';
  var repairData = {
    attempts: [
      { n: 1, signature: 'SIG', domain: 'shop', repairKind: 'patch', status: 'ok', checks: 'pass', branch: 'main', headSha: 'abc', buildRunUrl: 'http://ci/build?token=' + secretVal, imageDigest: 'sha256:abc', deployed: false, retestVerdicts: [], verifyStatus: 'pass', message: 'Build log: using key ' + secretVal + ' for auth' }
    ],
    sectionB: {
      targetChanges: [
        { branch: 'main', commit: 'abc', repairKind: 'patch', filesChanged: [], diffStat: '+1', diffExcerpt: 'Token: ' + secretVal + '\nEmail: ' + emailAddr + '\n' + 'x'.repeat(5000) }
      ]
    },
    blockers: [
      { code: 'BLK1', message: 'Failed with key: ' + secretVal, evidence: { token: secretVal, email: emailAddr } }
    ]
  };
  var options = opts({ repairMode: true, repairData: repairData, secrets: { CI_TOKEN: secretVal } });
  var report = reportModule.generateReport(runId, options);
  var reportJson = JSON.stringify(report);

  // The secret value must NOT appear in JSON output
  assert.strictEqual(reportJson.indexOf(secretVal), -1, 'secret must be redacted from JSON: ' + reportJson);

  // The blocker message in JSON must have secret redacted
  var blockerMsg = report.repair.blockers[0].message;
  assert.strictEqual(blockerMsg.indexOf(secretVal), -1, 'secret must be redacted from blocker message in JSON');

  // Email must be redacted from JSON
  assert.strictEqual(reportJson.indexOf(emailAddr), -1, 'email must be redacted from JSON');

  // diffExcerpt must be truncated at 4000 (+ '\n... (truncated)' = 4016)
  var diffExcerpt = report.repair.sectionB.targetChanges[0].diffExcerpt;
  assert.ok(diffExcerpt.length >= 4000 && diffExcerpt.length <= 4016, 'diffExcerpt must be truncated at 4000 chars (got ' + diffExcerpt.length + ')');
  assert.strictEqual(diffExcerpt.indexOf(secretVal), -1, 'secret must be redacted in diffExcerpt');

  // Markdown redaction
  var md = reportModule.renderMarkdownReport(report, options);
  assert.strictEqual(md.indexOf(secretVal), -1, 'secret must be redacted from markdown');
  assert.strictEqual(md.indexOf(emailAddr), -1, 'email must be redacted from markdown');

  removeRun(runId);
  done();
});

// Test 10 — repair off: output byte-identical to goldens
// Goldens were produced from the ORIGINAL code: `git show
// HEAD:src/reportGenerator.js` was written to src/_orig_reportGenerator.js and
// required directly (so its ./evidenceCollector resolves against src/). A
// deterministic fixture run (fixed runId 'golden-ref', fixed
// cleanupResetResult.resetAt) was written via evidenceCollector, and
// compliance-report.json, run-summary.json and compliance-report.md were saved
// to tests/fixtures/reports/. The fixture is deterministic so runId/sha256/
// timestamps match across runs; no fields are stripped.
test('repair off: output byte-identical to goldens', function(t, done) {
  ensureGoldensDir();

  var goldenSummaryJson = path.join(GOLDENS_DIR, 'run-summary.json');
  var goldenComplianceMd = path.join(GOLDENS_DIR, 'compliance-report.md');

  // Must FAIL if a golden is missing — never silently create goldens here.
  assert.strictEqual(fs.existsSync(goldenSummaryJson), true,
    'golden run-summary.json is missing; regenerate from the original code via gens.js');
  assert.strictEqual(fs.existsSync(goldenComplianceMd), true,
    'golden compliance-report.md is missing; regenerate from the original code via gens.js');

  // Same deterministic fixture as the goldens: fixed runId + fixed timestamp.
  wipeAll();
  var runId = 'golden-ref';
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  evidenceCollector.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json',
    JSON.stringify({ ok: true }), opts());
  var rec = {
    canonicalId: 'CAN-B1-01',
    summarySpecIds: ['B1-01'],
    referenceRevision: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd',
    executionRevision: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3',
    environmentIdentity: 'staging-clone-1 (docker dev)',
    commandInvocation: 'node bin/pipeline.js run --task CAN-B1-01',
    inputArtifactIds: ['stagingUrl', 'testAccounts', 'exchangeRates'],
    expectedResult: 'Cross-country browsing keeps customer country and product country correct.',
    actualResult: 'Matched expected result.',
    exitErrorResult: { exitCode: 0, error: null },
    generatedArtifacts: ['evidence/CAN-B1-01/record.json', 'evidence/CAN-B1-01/result.json'],
    stateChanges: ['No DB mutation; read-only dry run.'],
    cleanupResetResult: { ok: true, resetAt: '2025-01-01T00:00:00.000Z' },
    finalClassification: 'PASS_CANDIDATE_PLACEHOLDER',
    naReason: null,
    result: reportModule.RESULT_PASS
  };
  evidenceCollector.writeTaskRecord(runId, 'CAN-B1-01', rec, opts());

  var report = reportModule.generateReport(runId, opts());
  var md = reportModule.renderMarkdownReport(report, opts());

  var goldenJson = fs.readFileSync(goldenSummaryJson, 'utf8');
  var goldenMdContent = fs.readFileSync(goldenComplianceMd, 'utf8');

  // Byte-identical: runId, timestamps and sha256 are all deterministic.
  assert.strictEqual(JSON.stringify(report, null, 2), goldenJson,
    'run-summary.json must be byte-identical to golden (repairMode off)');
  assert.strictEqual(md, goldenMdContent,
    'compliance-report.md must be byte-identical to golden (repairMode off)');

  removeRun(runId);
  done();
});

// Test 11 — repair off: no repair key and schemaVersion unchanged
test('repair off: no repair key and schemaVersion unchanged', function(t, done) {
  wipeAll();
  var runId = 'rp-reproff-' + Date.now();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');

  // With repairMode explicitly false (default)
  var report = reportModule.generateReport(runId, opts({ repairMode: false }));
  assert.strictEqual('repair' in report, false, 'report.repair must be absent when repairMode is false');
  assert.strictEqual(report.schemaVersion, '1.0', 'schemaVersion must remain 1.0 when repairMode is false');

  // Without repairMode key at all
  wipeAll();
  evidenceCollector.initEvidenceIndex(runId, {}, opts());
  writePassTask(runId, 'CAN-B1-01');
  var report2 = reportModule.generateReport(runId, opts());
  assert.strictEqual('repair' in report2, false, 'report.repair must be absent when repairMode is omitted');
  assert.strictEqual(report2.schemaVersion, '1.0');

  removeRun(runId);
  done();
});
