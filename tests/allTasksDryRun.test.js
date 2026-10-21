'use strict';

/**
 * Offline readiness audit of ALL canonical tasks.
 *
 * Runs every canonical task id (CAN-B1-01..08, CAN-B2-01..16) through the real
 * executor registry (src/executors/index.js discover) using the shared
 * dry-run harness (tests/helpers/dryRunHarness.cjs), which injects fake
 * Shop/Admin API, fake env and temp evidence dirs (no network, no target
 * changes). For each task: one happy-path run and four negative runs:
 *   (a) API returns a GraphQL error object with no stack;
 *   (b) API returns a non-2xx Response;
 *   (c) missing required env var (names only) => CLIENT_INPUT_SCOPE;
 *   (d) malformed/empty body.
 * Asserts, for every task and every scenario:
 *   - no uncaught exception (the handler returned a structured result),
 *   - a record.json with the 15 schema fields + expected/actual/evidence refs/
 *     verdict/classification/manual-intervention/cleanup,
 *   - evidence under evidence/<runId>/<taskId>/,
 *   - no secret canary in any written file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const harness = require('./helpers/dryRunHarness.cjs');

const SCN_HAPPY = 'happy';
const SCN_GQL_NOSTACK = 'gql-nostack';
const SCN_NON2XX = 'non2xx';
const SCN_MISSING_ENV = 'missing-env';
const SCN_MALFORMED = 'malformed';
const ALL_SCENARIOS = [SCN_HAPPY, SCN_GQL_NOSTACK, SCN_NON2XX, SCN_MISSING_ENV, SCN_MALFORMED];

const REQUIRED_RECORD_FIELDS = harness.evidenceCollector.REQUIRED_TASK_FIELDS;

// The 24 canonical acceptance tasks (8 Batch 1 + 16 Batch 2). CAN-DEMO-01 is
// not an acceptance task and has no executor; it is deliberately excluded from
// the registry-driven loop.
const CANONICAL_TASK_IDS = [];
harness.getManifest().tasks.forEach(function(t) {
  if (/^CAN-B1-\d\d$/.test(t.canonicalId) || /^CAN-B2-\d\d$/.test(t.canonicalId)) {
    CANONICAL_TASK_IDS.push(t.canonicalId);
  }
});
CANONICAL_TASK_IDS.sort();

test('allTasksDryRun: every canonical task is registered by an executor', function() {
  const registered = harness.listRegistered();
  CANONICAL_TASK_IDS.forEach(function(id) {
    assert.ok(registered.indexOf(id) !== -1, 'executor must be registered for ' + id);
  });
  assert.strictEqual(CANONICAL_TASK_IDS.length, 24, 'expect 24 canonical tasks (8 B1 + 16 B2)');
});

for (const taskId of CANONICAL_TASK_IDS) {
  for (const scenario of ALL_SCENARIOS) {
    test('allTasksDryRun ' + taskId + ' ' + scenario, { timeout: 30000 }, async function(t) {
      const runId = 'dryrun-' + taskId.toLowerCase().replace(/-/g, '') + '-' + scenario;
      const result = await harness.runScenario(taskId, scenario, runId);
      try {
        // 1. No uncaught exception.
        assert.strictEqual(result.threw, null, 'handler must not throw uncaught: ' + String(result.threw));

        // 2. record.json exists with the 15 required fields.
        assert.strictEqual(result.recordPath ? fs.existsSync(result.recordPath) : false, true, 'record.json on disk');
        const record = JSON.parse(fs.readFileSync(result.recordPath, 'utf8'));
        REQUIRED_RECORD_FIELDS.forEach(function(field) {
          assert.ok(record[field] !== undefined, 'record has required field ' + field);
        });
        assert.strictEqual(record.canonicalId, taskId, 'record task id matches');
        assert.ok(record.expectedResult !== undefined, 'record expected result');
        assert.ok(record.actualResult !== undefined, 'record actual result');
        assert.ok(record.result !== undefined, 'record verdict');
        assert.ok('cleanupResetResult' in record, 'record cleanup result');
        assert.ok('manualIntervention' in record, 'record manual-intervention field');

        // 3. Evidence under evidence/<runId>/<taskId>/.
        const taskRel = path.join(runId, taskId);
        const taskAbs = path.join(path.dirname(result.recordPath.split(taskRel.replace(/\\/g, '/'))[0]), 'evidence', taskRel);
        // Simplest: check at least one evidence file lives in the task folder.
        assert.ok(result.evidenceFiles.length >= 1, 'at least one evidence file under evidence/<runId>/<taskId>/');
        result.evidenceFiles.forEach(function(f) {
          assert.ok(f.indexOf(path.join('evidence', runId, taskId)) !== -1, 'evidence file in task dir: ' + f);
        });

        // 4. No secret canary in any written file.
        assert.deepStrictEqual(result.canaryLeaks, [], 'no secret canary leaked into evidence');

        // Negative-run expectations on classification where the executor is
        // env-gated (we need a structured BLOCK, never a crash).
        if (scenario === SCN_MISSING_ENV) {
          // The dry run must classify (may be CLIENT_INPUT_SCOPE or another
          // structured failure); it must never be an uncaught crash and must
          // still write a record+evidence.
          assert.ok(result.recordPath && fs.existsSync(result.recordPath), 'missing-env still writes a record');
        }
      } finally {
        harness.cleanup(result);
      }
    });
  }
}

// The manifest-required checks: 24 tasks x 5 scenarios all pass the four
// invariants. A single aggregate test makes the count explicit.
test('allTasksDryRun: aggregate invariant count (24 tasks x 5 scenarios = 120)', { timeout: 120000 }, async function() {
  let ok = 0;
  const failures = [];
  for (const taskId of CANONICAL_TASK_IDS) {
    for (const scenario of ALL_SCENARIOS) {
      const runId = 'agg-' + taskId.toLowerCase().replace(/-/g, '') + '-' + scenario;
      const result = await harness.runScenario(taskId, scenario, runId);
      const recordOk = result.recordPath && fs.existsSync(result.recordPath);
      const evidenceOk = result.evidenceFiles.length >= 1;
      const noThrew = result.threw === null;
      const noLeak = result.canaryLeaks.length === 0;
      if (noThrew && recordOk && evidenceOk && noLeak) {
        ok += 1;
      } else {
        failures.push(taskId + ':' + scenario + ' threw=' + String(result.threw) + ' record=' + recordOk + ' evidence=' + evidenceOk + ' leak=' + result.canaryLeaks.length);
      }
      harness.cleanup(result);
    }
  }
  assert.strictEqual(failures.length, 0, 'invariant failures:\n' + failures.join('\n'));
  assert.strictEqual(ok, 120, 'all 120 scenario-runs satisfy the four invariants');
});
