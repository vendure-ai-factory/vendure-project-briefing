'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var test = require('node:test');
var assert = require('node:assert');

var evidence = require('../src/evidenceCollector');

var TEST_ROOT = path.resolve(__dirname, '..', 'runs', 'evidence-test-' + Date.now());
var BASE_DIR = 'evidence';

function opts(extra) {
  var o = { root: TEST_ROOT, baseDir: BASE_DIR };
  if (extra) Object.assign(o, extra);
  return o;
}

function runRoot(runId) {
  return path.join(TEST_ROOT, BASE_DIR, runId);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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
    finalClassification: 'PASS_CANDIDATE',
    naReason: null
  };
  var merged = Object.assign({}, record, overrides || {});
  return merged;
}

var SECRET_VALUE = 'super-secret-token-7f3c';

test('evidenceCollector: initEvidenceIndex creates correct schema', function(t, done) {
  wipeAll();
  var runId = 'run-schema-' + Date.now();
  var meta = {
    executionRevision: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3',
    referenceCommit: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd',
    protectedPathsHash: 'deadbeef'
  };
  var result = evidence.initEvidenceIndex(runId, meta, opts());
  assert.strictEqual(result.ok, true);

  var indexPath = path.join(runRoot(runId), 'index.json');
  assert.strictEqual(fs.existsSync(indexPath), true, 'index.json should exist');
  var index = JSON.parse(readText(indexPath));
  assert.strictEqual(index.schemaVersion, '1.0');
  assert.strictEqual(index.runId, runId);
  assert.strictEqual(index.executionRevision, meta.executionRevision);
  assert.strictEqual(index.referenceCommit, meta.referenceCommit);
  assert.strictEqual(index.protectedPathsHash, meta.protectedPathsHash);
  assert.deepStrictEqual(index.tasks, {});
  removeRun(runId);
  done();
});

test('evidenceCollector: writeEvidenceFile computes sha256, updates index, redacts secrets', function(t, done) {
  wipeAll();
  var runId = 'run-write-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());

  var content = 'operator note with secret ' + SECRET_VALUE + ' embedded\n';
  var res = evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'note.txt', content, opts({ secrets: { NOTE_KEY: SECRET_VALUE } }));

  assert.strictEqual(res.ok, true);
  assert.ok(res.sha256, 'should compute sha256');

  var filePath = path.join(runRoot(runId), 'CAN-B1-01', 'note.txt');
  var written = readText(filePath);
  assert.strictEqual(written.indexOf(SECRET_VALUE), -1, 'secret should be redacted in file');
  assert.strictEqual(written, 'operator note with secret [REDACTED] embedded\n');

  assert.strictEqual(res.sha256, sha(written), 'sha256 must be of the redacted final content');

  var index = JSON.parse(readText(path.join(runRoot(runId), 'index.json')));
  assert.ok(index.tasks['CAN-B1-01'], 'index should have task key');
  assert.strictEqual(index.tasks['CAN-B1-01'].length, 1);
  var entry = index.tasks['CAN-B1-01'][0];
  assert.strictEqual(entry.path, 'CAN-B1-01/note.txt');
  assert.strictEqual(entry.sha256, sha(written));
  assert.ok(entry.timestamp, 'should record UTC timestamp');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(entry.timestamp), 'timestamp should be ISO 8601 UTC');
  assert.strictEqual(entry.kind, 'artifact');
  removeRun(runId);
  done();
});

test('evidenceCollector: writeTaskRecord writes all 15 fields; throws on missing field', function(t, done) {
  wipeAll();
  var runId = 'run-record-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());

  var record = makeRecord();
  var res = evidence.writeTaskRecord(runId, 'CAN-B1-01', record, opts());
  assert.strictEqual(res.ok, true);

  var recordPath = path.join(runRoot(runId), 'CAN-B1-01', 'record.json');
  assert.strictEqual(fs.existsSync(recordPath), true);
  var parsed = JSON.parse(readText(recordPath));
  var requiredFields = evidence.REQUIRED_TASK_FIELDS;
  for (var i = 0; i < requiredFields.length; i++) {
    assert.strictEqual(parsed[requiredFields[i]] !== undefined, true,
      'record.json must contain required field ' + requiredFields[i]);
  }
  assert.strictEqual(parsed.canonicalId, 'CAN-B1-01');

  // Missing required field -> throws with field name, no partial record written.
  var badPath = path.join(runRoot(runId), 'CAN-B2-01', 'record.json');
  var threw = null;
  try {
    evidence.writeTaskRecord(runId, 'CAN-B2-01', {
      canonicalId: 'CAN-B2-01'
    }, opts());
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'should throw on missing required fields');
  assert.ok(threw.message.indexOf('required field') !== -1, 'throw should mention missing fields');
  assert.ok(threw.message.indexOf('summarySpecIds') !== -1, 'throw should name a missing field');
  assert.strictEqual(fs.existsSync(badPath), false, 'no partial record.json should be written');
  removeRun(runId);
  done();
});

test('evidenceCollector: REQUIRED_RECORD_FIELDS exported with exact 15 field names', function(t, done) {
  assert.strictEqual(Array.isArray(evidence.REQUIRED_RECORD_FIELDS), true);
  assert.strictEqual(evidence.REQUIRED_RECORD_FIELDS.length, 15);
  // Must be the same list as the required validation fields.
  assert.deepStrictEqual(evidence.REQUIRED_RECORD_FIELDS, evidence.REQUIRED_TASK_FIELDS);
  var expected = [
    'canonicalId', 'summarySpecIds', 'referenceRevision', 'executionRevision',
    'environmentIdentity', 'commandInvocation', 'inputArtifactIds',
    'expectedResult', 'actualResult', 'exitErrorResult', 'generatedArtifacts',
    'stateChanges', 'cleanupResetResult', 'finalClassification', 'naReason'
  ];
  assert.deepStrictEqual(evidence.REQUIRED_RECORD_FIELDS, expected);
  done();
});

test('evidenceCollector: writeTaskRecord accepts and persists extra optional fields', function(t, done) {
  wipeAll();
  var runId = 'run-extra-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());

  var record = makeRecord({
    result: 'PASS_CANDIDATE',
    classification: { failureClass: 'APPLICATION_DEFECT' },
    cause: 'variant leaking across channels',
    repairHistory: [{ attempt: 1, action: 'patch', result: 'applied' }],
    manualIntervention: { required: false },
    protectedStartHash: 'aa11bb22',
    protectedEndHash: 'cc33dd44'
  });
  var res = evidence.writeTaskRecord(runId, 'CAN-B1-01', record, opts());
  assert.strictEqual(res.ok, true);

  var index = JSON.parse(readText(path.join(runRoot(runId), 'index.json')));
  assert.ok(index.tasks['CAN-B1-01'], 'index should contain task');

  var parsed = JSON.parse(readText(path.join(runRoot(runId), 'CAN-B1-01', 'record.json')));
  assert.strictEqual(parsed.result, 'PASS_CANDIDATE');
  assert.strictEqual(parsed.classification.failureClass, 'APPLICATION_DEFECT');
  assert.strictEqual(parsed.cause, 'variant leaking across channels');
  assert.strictEqual(parsed.repairHistory.length, 1);
  assert.strictEqual(parsed.repairHistory[0].action, 'patch');
  assert.strictEqual(parsed.manualIntervention.required, false);
  assert.strictEqual(parsed.protectedStartHash, 'aa11bb22');
  assert.strictEqual(parsed.protectedEndHash, 'cc33dd44');

  // Extra optional fields must not break verification.
  var verify = evidence.verifyEvidence(runId, opts());
  assert.strictEqual(verify.ok, true, 'extra optional fields should not break verifyEvidence');
  removeRun(runId);
  done();
});

test('evidenceCollector: script task record requires exactScriptPath', function(t, done) {
  wipeAll();
  var runId = 'run-script-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());

  var scriptRecord = makeRecord({ canonicalId: 'CAN-B2-16' });
  var threw = null;
  try {
    evidence.writeTaskRecord(runId, 'CAN-B2-16', scriptRecord, opts({ scriptTask: true }));
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'script task without exactScriptPath should throw');
  assert.ok(threw.message.indexOf('exactScriptPath') !== -1, 'throw should name exactScriptPath');

  scriptRecord.exactScriptPath = 'evaluation-demo/migration-input/legacy/vendure-store/scripts/setup_tax_rates.mjs';
  var res = evidence.writeTaskRecord(runId, 'CAN-B2-16', scriptRecord, opts({ scriptTask: true }));
  assert.strictEqual(res.ok, true);
  removeRun(runId);
  done();
});

test('evidenceCollector: verifyEvidence passes on untampered files', function(t, done) {
  wipeAll();
  var runId = 'run-verify-ok-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());
  evidence.writeTaskRecord(runId, 'CAN-B1-01', makeRecord(), opts());

  var result = evidence.verifyEvidence(runId, opts());
  assert.strictEqual(result.ok, true, 'should verify ok');
  assert.strictEqual(result.tasks['CAN-B1-01'].ok, true);
  var files = result.tasks['CAN-B1-01'].files;
  var recordEntry = files.filter(function(f) { return f.path.indexOf('record.json') !== -1; });
  assert.strictEqual(recordEntry.length, 1);
  var resultEntry = files.filter(function(f) { return f.path.indexOf('result.json') !== -1; });
  assert.strictEqual(resultEntry.length, 1);
  removeRun(runId);
  done();
});

test('evidenceCollector: verifyEvidence returns MISSING_EVIDENCE on tampered file', function(t, done) {
  wipeAll();
  var runId = 'run-tamper-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());
  evidence.writeTaskRecord(runId, 'CAN-B1-01', makeRecord(), opts());

  fs.writeFileSync(path.join(runRoot(runId), 'CAN-B1-01', 'result.json'), 'TAMPERED', 'utf8');

  var result = evidence.verifyEvidence(runId, opts());
  assert.strictEqual(result.ok, false);
  var files = result.tasks['CAN-B1-01'].files;
  var tampered = files.filter(function(f) { return f.path.indexOf('result.json') !== -1; })[0];
  assert.strictEqual(tampered.match, false);
  assert.strictEqual(tampered.result, 'MISSING_EVIDENCE');
  removeRun(runId);
  done();
});

test('evidenceCollector: verifyEvidence returns MISSING_EVIDENCE on deleted file', function(t, done) {
  wipeAll();
  var runId = 'run-delete-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());
  evidence.writeTaskRecord(runId, 'CAN-B1-01', makeRecord(), opts());

  fs.rmSync(path.join(runRoot(runId), 'CAN-B1-01', 'result.json'));

  var result = evidence.verifyEvidence(runId, opts());
  assert.strictEqual(result.ok, false);
  var files = result.tasks['CAN-B1-01'].files;
  var deleted = files.filter(function(f) { return f.path.indexOf('result.json') !== -1; })[0];
  assert.strictEqual(deleted.match, false);
  assert.strictEqual(deleted.result, 'MISSING_EVIDENCE');
  removeRun(runId);
  done();
});

test('evidenceCollector: verifyEvidence returns MISSING_EVIDENCE on missing required field', function(t, done) {
  wipeAll();
  var runId = 'run-field-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', JSON.stringify({ ok: true }), opts());

  // Write a record, then tamper record.json to drop a required field.
  evidence.writeTaskRecord(runId, 'CAN-B1-01', makeRecord(), opts());
  var recordPath = path.join(runRoot(runId), 'CAN-B1-01', 'record.json');
  var record = JSON.parse(readText(recordPath));
  delete record.environmentIdentity;
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8');

  var result = evidence.verifyEvidence(runId, opts());
  assert.strictEqual(result.ok, false);
  var files = result.tasks['CAN-B1-01'].files;
  var badRecord = files.filter(function(f) { return f.path.indexOf('record.json') !== -1 && f.reason; })[0];
  assert.strictEqual(badRecord.result, 'MISSING_EVIDENCE');
  assert.ok(badRecord.reason.indexOf('required-field-missing') !== -1);
  removeRun(runId);
  done();
});

test('evidenceCollector: secret value never appears in any written file', function(t, done) {
  wipeAll();
  var runId = 'run-secret-' + Date.now();
  var SECRET_B = 'another-secret-9d4f';
  evidence.initEvidenceIndex(runId, {}, opts({ secrets: { A: SECRET_VALUE, B: SECRET_B } }));

  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json',
    'secret is ' + SECRET_VALUE + ' and ' + SECRET_B, opts({ secrets: { A: SECRET_VALUE, B: SECRET_B } }));
  var record = makeRecord({ actualResult: 'contains ' + SECRET_VALUE });
  evidence.writeTaskRecord(runId, 'CAN-B1-01', record, opts({ secrets: { A: SECRET_VALUE, B: SECRET_B } }));

  var collected = [];
  function collect(dir) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var full = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) collect(full);
      else collected.push(readText(full));
    }
  }
  collect(runRoot(runId));
  assert.ok(collected.length >= 3, 'should have written files');
  for (var j = 0; j < collected.length; j++) {
    assert.strictEqual(collected[j].indexOf(SECRET_VALUE), -1, 'secret value must never appear in files');
    assert.strictEqual(collected[j].indexOf(SECRET_B), -1, 'secret value must never appear in files');
  }
  removeRun(runId);
  done();
});

test('evidenceCollector: cleanupEvidence removes folder and records result', function(t, done) {
  wipeAll();
  var runId = 'run-cleanup-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', '{}', opts());

  var result = evidence.cleanupEvidence(runId, opts());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.error, null);
  assert.strictEqual(fs.existsSync(runRoot(runId)), false, 'folder should be removed');

  var logPath = path.join(TEST_ROOT, BASE_DIR, 'cleanup-log.json');
  assert.strictEqual(fs.existsSync(logPath), true, 'cleanup record should be persisted');
  var log = JSON.parse(readText(logPath));
  var entry = log.filter(function(e) { return e.runId === runId; })[0];
  assert.ok(entry, 'cleanup-log should contain entry for runId');
  assert.strictEqual(entry.ok, true);

  // Cleaning a nonexistent run does not throw and records an error.
  var missing = evidence.cleanupEvidence('no-such-run', opts());
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.error);
  wipeAll();
  done();
});

test('evidenceCollector: unverified cleanup blocks PASS (cleanupResetResult null)', function(t, done) {
  wipeAll();
  var runId = 'run-unc-' + Date.now();
  var TEST_ROOT_LOCAL = TEST_ROOT;
  var BASE_DIR_LOCAL = BASE_DIR;
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', '{}', opts());
  var record = makeRecord({ cleanupResetResult: null });
  evidence.writeTaskRecord(runId, 'CAN-B1-01', record, opts());
  var result = evidence.verifyEvidence(runId, opts());
  assert.strictEqual(result.ok, false, 'null cleanupResetResult must block PASS');
  assert.strictEqual(result.tasks['CAN-B1-01'].ok, false);
  var files = result.tasks['CAN-B1-01'].files;
  var badRecord = files.filter(function(f) { return f.path.indexOf('record.json') !== -1 && f.reason; })[0];
  assert.ok(badRecord, 'should have a record entry with reason field');
  assert.strictEqual(badRecord.result, 'MISSING_EVIDENCE');
  assert.ok(badRecord.reason.indexOf('cleanupResetResult') !== -1, 'reason should mention cleanupResetResult');
  removeRun(runId);
  done();
});

test('evidenceCollector: unverified cleanup blocks PASS (cleanupResetResult missing)', function(t, done) {
  wipeAll();
  var runId = 'run-unc2-' + Date.now();
  evidence.initEvidenceIndex(runId, {}, opts());
  evidence.writeEvidenceFile(runId, 'CAN-B1-01', 'result.json', '{}', opts());
  var record = makeRecord();
  delete record.cleanupResetResult;
  var threw = null;
  try {
    evidence.writeTaskRecord(runId, 'CAN-B1-01', record, opts());
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'writeTaskRecord should throw when cleanupResetResult is missing');
  assert.ok(threw.message.indexOf('cleanupResetResult') !== -1, 'throw should name missing field');
  removeRun(runId);
  done();
});
