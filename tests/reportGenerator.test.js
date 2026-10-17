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
