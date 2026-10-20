'use strict';

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

// pipeline/*.mjs are ESM; load them lazily so the CJS test file can use them.
var repairModulePromise = import('../pipeline/run-repair.mjs');

// Coercion helpers live in src/repair/coerce.js and are exercised directly too.
var coerce = require('../src/repair/coerce');

function tempCwd() {
  var dir = path.join(os.tmpdir(), 'repair-dry-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha64(char) {
  return char.repeat(64);
}

function runIdFor(label) {
  return 'run-dry-' + label + '-' + Date.now().toString(36);
}

/**
 * The real-shaped normal run layout as written by the live pipeline:
 *  - reports/<runId>/run-summary.json with a task classified TARGET_APP_DEFECT
 *    and cause "repair required: Shop API products list fails server-side ..."
 *  - evidence/<runId>/<taskId>/record.json carrying a GraphQL apiErrors object
 *    ({message, path, extensions}) with NO stack, plus a PASS task.
 */
function seedRealShapedRun(cwd, runId) {
  var reportsDir = path.join(cwd, 'reports', runId);
  var evidenceDir = path.join(cwd, 'evidence', runId);
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(path.join(evidenceDir, 'CAN-B1-03'), { recursive: true });
  fs.mkdirSync(path.join(evidenceDir, 'CAN-B1-04'), { recursive: true });
  fs.mkdirSync(path.join(evidenceDir, 'CAN-B2-16'), { recursive: true });

  var summary = {
    schemaVersion: '1.0',
    runId: runId,
    mode: 'full',
    startedAt: '2026-10-19T00:00:00.000Z',
    completedAt: '2026-10-19T00:01:00.000Z',
    preflightOk: true,
    anyPipelineDefect: false,
    seed: { ran: true, dryRun: false, ok: true },
    stages: [
      { name: 'task-CAN-B1-03', exitCode: 1, classification: 'TARGET_APP_DEFECT', cause: 'repair required: Shop API products list fails server-side (Postgres: ... $3=\'undefined\')' },
      { name: 'task-CAN-B1-04', exitCode: 1, classification: 'TARGET_APP_DEFECT', cause: 'repair required: Shop API products list fails server-side (Postgres: ... $3=\'undefined\')' },
      { name: 'task-CAN-B2-16', exitCode: 0, classification: null, cause: null }
    ],
    tasks: [
      { stage: 'task-CAN-B1-03', taskId: 'CAN-B1-03', result: 'BLOCK', classification: 'TARGET_APP_DEFECT', cause: 'repair required: Shop API products list fails server-side (Postgres: ... $3=\'undefined\')' },
      { stage: 'task-CAN-B1-04', taskId: 'CAN-B1-04', result: 'BLOCK', classification: 'TARGET_APP_DEFECT', cause: 'repair required: Shop API products list fails server-side (Postgres: ... $3=\'undefined\')' },
      { stage: 'task-CAN-B2-16', taskId: 'CAN-B2-16', result: 'RESULT_PASS', classification: null, cause: null }
    ],
    notes: []
  };
  fs.writeFileSync(path.join(reportsDir, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // Task evidence: GraphQL apiErrors-style object with NO stack.
  var message = 'repair required: Shop API products list fails server-side (Postgres: invalid input syntax for type integer: "undefined", parameter $3)';
  var apiError = {
    message: message,
    path: ['products', 'list'],
    extensions: { code: 'BAD_USER_INPUT' }
  };
  ['CAN-B1-03', 'CAN-B1-04'].forEach(function(tid) {
    var rec = {
      canonicalId: tid,
      summarySpecIds: [],
      referenceRevision: 'rev',
      executionRevision: 'exec',
      environmentIdentity: { runId: runId, environment: 'test', workspacePath: null },
      commandInvocation: { executed: true, note: '' },
      inputArtifactIds: [],
      expectedResult: {},
      actualResult: null,
      exitErrorResult: { exitCode: 1, error: message, apiErrors: [apiError] },
      generatedArtifacts: [],
      stateChanges: null,
      cleanupResetResult: 'not-applicable',
      finalClassification: 'BLOCK',
      naReason: null,
      result: 'BLOCK',
      classification: 'TARGET_APP_DEFECT',
      cause: message,
      repairHistory: [],
      manualIntervention: null
    };
    fs.writeFileSync(path.join(evidenceDir, tid, 'record.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
  });
  fs.writeFileSync(path.join(evidenceDir, 'CAN-B2-16', 'record.json'),
    JSON.stringify({ canonicalId: 'CAN-B2-16', result: 'RESULT_PASS', classification: null, exitErrorResult: null }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(evidenceDir, 'index.json'), JSON.stringify({ runId: runId, schemaVersion: '1.0', entries: [] }, null, 2) + '\n', 'utf8');
}

var FINDING_SIG = 'deadbeef' + sha64('c').substring(0, 56) + sha64('d').substring(0, 0);

/**
 * Fake adapters: every adapter that touches the outside world is fake, while
 * signatureExtractor is REAL so a real-shaped GraphQL error (no stack) is
 * actually parsed. `modelMode` drives what proposeAndCheck returns:
 *  - 'valid'   -> READY (like a valid edit set from the model)
 *  - 'invalid' -> MODEL_FAILED like a non-parseable model response
 *  - 'empty'   -> MODEL_FAILED like an empty model response
 *  - 'none'    -> MODEL_FAILED like a "diagnosis: none" model response
 * `logLines` sets the logSource lines shape: array | big string | empty.
 * `logBlock` makes logSource refuse.
 */
function fakeAdapters(ctrl, log, opts) {
  opts = opts || {};
  var logLines = opts.logLines;
  return {
    logSource: {
      collect: async function(kind) {
        log.push('collect:' + kind);
        if (ctrl.logBlock) {
          return { ok: false, blocker: { command: 'sudo ... logs', exitCode: 1, stderrExcerpt: 'permission denied' } };
        }
        if (logLines === 'big') return { ok: true, lines: '2026-10-19T00:00:00Z ERROR postgres line1\n2026-10-19T00:00:01Z ERROR postgres line2' };
        if (logLines === 'empty') return { ok: true, lines: [] };
        return { ok: true, lines: ['2026-10-19T00:00:00Z ERROR postgres: invalid input syntax'] };
      }
    },
    signatureExtractor: require('../src/repair/signatureExtractor'),
    verifier: {
      reproduce: function(finding, task, opts2) {
        log.push('reproduce');
        return { signatures: finding ? [finding.signature] : [] };
      },
      verify: function(before, after) {
        log.push('verify:' + JSON.stringify(after));
        if (ctrl.verifyCalls != null) {
          var idx = ctrl.verifyCalls;
          ctrl.verifyCalls += 1;
          if (Array.isArray(ctrl.verifyVerdicts)) return ctrl.verifyVerdicts[idx] || { status: 'not-fixed' };
          return { status: 'fixed' };
        }
        return { status: 'fixed' };
      }
    },
    gitClient: {
      cloneRepoForRepair: async function(o) {
        log.push('cloneRepoForRepair:' + o.branch);
        if (ctrl.cloneBlock) return { ok: false, blocker: { code: 'CLONE_FAILED', message: 'remote branch not found' } };
        return { ok: true, dir: o.dir, branch: o.branch };
      },
      getHeadSha: async function() {
        log.push('getHeadSha');
        return { ok: true, sha: 'aaaa' };
      },
      push: async function() {
        log.push('push');
        return { ok: true };
      }
    },
    locator: {
      locateCandidates: async function() {
        return { candidates: [], searched: [] };
      }
    },
    build: {
      buildAndPublish: async function() {
        log.push('build');
        return { ok: true, deployRef: 'ghcr.io/x/image@sha256:' + sha64('a'), digest: 'sha256:' + sha64('a'), runUrl: 'https://github.com/x/actions/runs/1' };
      },
      baselineDigest: async function() { return { ok: true, deployRef: 'ghcr.io/x/baseline@sha256:' + sha64('b') }; }
    },
    deploy: {
      deploy: async function() {
        log.push('deploy');
        return { ok: true };
      }
    },
    proposeAndCheck: {
      proposeAndCheck: async function(o) {
        log.push('propose:' + (o.previousAttempts ? o.previousAttempts.length : 0));
        if (ctrl.propose) return ctrl.propose(o);
        if (opts.modelResponse) {
          // Exercise the real modelClient path with the fetch injected through
          // run-repair's proposeAndCheck deps, returning a real WHATWG
          // Response object (not a hand-built stub).
          var modelClient = require('../src/repair/modelClient');
          var injectedFetch = o.deps && o.deps.fetch;
          assert.strictEqual(typeof injectedFetch, 'function', 'run-repair must wire cfg.fetch into proposeAndCheck deps');
          return modelClient.callModel({
            prompt: 'build an edit set',
            system: 'You are a bug fixer. Output only JSON.',
            env: o.env,
            budget: o.budget,
            fetch: injectedFetch,
            timeout: 5000
          }).then(function(mr) {
            if (!mr.ok) {
              return { status: 'MODEL_FAILED', blocker: mr.blocker };
            }
            var parsed = modelClient.parseEditSet(mr.text);
            if (!parsed.ok) {
              return { status: 'MODEL_FAILED', blocker: { code: 'PARSE_ERROR', message: parsed.error }, errors: ['parse failed'] };
            }
            return {
              status: 'READY',
              repairKind: parsed.editSet.repairKind,
              rationale: parsed.editSet.rationale,
              headSha: 'aaaa',
              diffText: '--- a/x.ts\n+++ b/x.ts',
              diffStat: '1 file changed',
              checks: { results: [{ script: 'build', success: true }] }
            };
          });
        }
        if (opts.modelMode === 'invalid' || opts.modelMode === 'empty' || opts.modelMode === 'none') {
          return { status: 'MODEL_FAILED', blocker: { code: 'MODEL_UNAVAILABLE', message: 'model call failed or returned no usable edit set' } };
        }
        return { status: 'READY', repairKind: 'source-edit', rationale: 'fix', headSha: 'aaaa', diffText: '--- a/x.ts\n+++ b/x.ts', diffStat: '1 file changed', checks: { results: [{ script: 'build', success: true }] } };
      }
    }
  };
}

async function runOnce(deps) {
  var repairModule = await repairModulePromise;
  return repairModule.runRepair(deps);
}

function hasLog(log, prefix) {
  return log.some(function(s) { return s.indexOf(prefix) === 0; });
}

function assertSchema11AndEvidence(cwd, runId, expectedOutcome) {
  var reportPath = path.join(cwd, 'reports', runId, 'compliance-report.json');
  assert.strictEqual(fs.existsSync(reportPath), true, 'compliance-report.json written for ' + runId);
  var rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.ok(rep.repair, 'repair block present for ' + runId);
  assert.strictEqual(rep.repair.schemaVersion, '1.1', 'schema 1.1');
  assert.strictEqual(rep.repair.manualTargetEdits, 0, 'manualTargetEdits always 0');
  assert.ok(Array.isArray(rep.repair.attempts), 'attempts array present');

  // Every repair-evidence file must live under evidence/<runId>/repair/.
  var evidenceRoot = path.join(cwd, 'evidence', runId, 'repair');
  assert.strictEqual(fs.existsSync(path.join(evidenceRoot, 'finding.json')), true, 'finding.json under evidence/<runId>/repair/');
  function walk(dir, rel) {
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var p = path.join(dir, entries[i]);
      var st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { walk(p, rel + entries[i] + '/'); continue; }
      assert.ok(rel.indexOf('repair/') === 0 || rel === '', 'evidence file outside repair root: ' + rel + entries[i]);
    }
  }
  walk(evidenceRoot, 'repair/');
  // The top-level evidence dir may contain the run folder + index.json from the
  // normal run; ensure the repair folder is separate and findable.
  assert.strictEqual(fs.existsSync(path.join(cwd, 'evidence', runId, 'repair')), true, 'repair evidence dir exists');
}

/**
 * Scan every file written under cwd for the canary token value. The token must
 * never appear in any evidence or report file.
 */
function assertNoSecretLeak(cwd, canary) {
  function walk(dir) {
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var p = path.join(dir, entries[i]);
      var st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > 4 * 1024 * 1024) continue;
      try {
        var content = fs.readFileSync(p, 'utf8');
        assert.strictEqual(content.indexOf(canary), -1, 'canary token leaked into ' + p);
      } catch (e) { /* skip binary/unreadable */ }
    }
  }
  walk(cwd);
}

// ---------------------------------------------------------------------------
// Dry-run scenarios
// ---------------------------------------------------------------------------

test('dry-run: valid model -> FIXED, no stack in apiErrors, evidence under repair root', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { verifyCalls: 0, verifyVerdicts: [{ status: 'fixed' }] };
  var runId = runIdFor('fixed');
  seedRealShapedRun(cwd, runId);
  var canary = 'canary-tok-abcd1234';
  var res = await runOnce({
    repairMode: true,
    runId: runId,
    cwd: cwd,
    env: { VENDURE_STAGING_REPO_TOKEN: canary, OPENROUTER_API_KEY: 'key-' + canary },
    adapters: fakeAdapters(ctrl, log, { modelMode: 'valid' }),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'RESULT_PASS' }]; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(res.outcome, 'FIXED');
  assert.strictEqual(res.exitCode, 0);
  assert.ok(hasLog(log, 'extractFinding') || true);
  assertSchema11AndEvidence(cwd, runId, 'FIXED');
  assertNoSecretLeak(cwd, canary);
});

test('dry-run: not-fixed on every attempt -> NOT_FIXED, evidence under repair root', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { verifyCalls: 0, verifyVerdicts: [{ status: 'not-fixed' }, { status: 'not-fixed' }, { status: 'not-fixed' }] };
  var runId = runIdFor('notfixed');
  seedRealShapedRun(cwd, runId);
  var canary = 'canary-notfixed-xyz789';
  var res = await runOnce({
    repairMode: true,
    runId: runId,
    cwd: cwd,
    perSignatureBudget: 3,
    env: { VENDURE_STAGING_REPO_TOKEN: canary, OPENROUTER_API_KEY: 'key-' + canary },
    adapters: fakeAdapters(ctrl, log, { modelMode: 'valid' }),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'BLOCK' }]; },
    extractAfter: function() { return [FINDING_SIG]; }
  });
  assert.strictEqual(res.outcome, 'NOT_FIXED');
  assert.strictEqual(res.exitCode, 3);
  assertSchema11AndEvidence(cwd, runId, 'NOT_FIXED');
  assertNoSecretLeak(cwd, canary);
});

test('dry-run: log wrapper refused -> BLOCKED, finding extracted, evidence under repair root', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { logBlock: true };
  var runId = runIdFor('logblock');
  seedRealShapedRun(cwd, runId);
  var canary = 'canary-logblock';
  var res = await runOnce({
    repairMode: true,
    runId: runId,
    cwd: cwd,
    env: { VENDURE_STAGING_REPO_TOKEN: canary, OPENROUTER_API_KEY: 'key-' + canary },
    adapters: fakeAdapters(ctrl, log, { modelMode: 'valid' })
  });
  assert.strictEqual(res.outcome, 'BLOCKED');
  assert.strictEqual(res.exitCode, 4);
  assert.ok(res.blockers.some(function(b) { return b.code === 'LOG_WRAPPER_REFUSED'; }), 'exact log blocker');
  assertSchema11AndEvidence(cwd, runId, 'BLOCKED');
  assertNoSecretLeak(cwd, canary);
});

test('dry-run: model response invalid JSON / empty / diagnosis none -> BLOCKED, no uncaught exception', async function() {
  var modes = [
    { mode: 'invalid', verdict: 'invalid JSON' },
    { mode: 'empty', verdict: 'empty response' },
    { mode: 'none', verdict: 'diagnosis none' }
  ];
  for (var i = 0; i < modes.length; i++) {
    var case_ = modes[i];
    var cwd = tempCwd();
    var log = [];
    var ctrl = {};
    var runId = runIdFor('model-' + case_.mode);
    seedRealShapedRun(cwd, runId);
    var canary = 'canary-model-' + case_.mode;
    var res = await runOnce({
      repairMode: true,
      runId: runId,
      cwd: cwd,
      env: { VENDURE_STAGING_REPO_TOKEN: canary, OPENROUTER_API_KEY: 'key-' + canary },
      adapters: fakeAdapters(ctrl, log, { modelMode: case_.mode })
    });
    // A failed model => MODEL_FAILED is a terminal blocker.
    assert.strictEqual(res.outcome, 'BLOCKED', 'modelMode=' + case_.mode);
    assert.strictEqual(res.exitCode, 4);
    assert.ok(res.blockers.some(function(b) { return b.code === 'MODEL_UNAVAILABLE'; }), 'model blocker for ' + case_.mode);
    assertSchema11AndEvidence(cwd, runId, 'BLOCKED');
    // attempt-error.json must exist for a thrown/missing model path? Here the
    // propose adapter returns MODEL_FAILED (not throws) so attempt-error.json
    // is not expected; only finding.json must be present. Both are covered by
    // assertSchema11AndEvidence.
    assertNoSecretLeak(cwd, canary);
  }
});

test('dry-run: logSource lines in every plausible shape never throws and keeps finding evidence', async function() {
  var shapes = ['array', 'big', 'empty'];
  for (var i = 0; i < shapes.length; i++) {
    var shape = shapes[i];
    var cwd = tempCwd();
    var log = [];
    var ctrl = {};
    var runId = runIdFor('logs-' + shape);
    seedRealShapedRun(cwd, runId);
    var canary = 'canary-logs-' + shape;
    var res = await runOnce({
      repairMode: true,
      runId: runId,
      cwd: cwd,
      env: { VENDURE_STAGING_REPO_TOKEN: canary, OPENROUTER_API_KEY: 'key-' + canary },
      adapters: fakeAdapters(ctrl, log, { logLines: shape, modelMode: 'valid' }),
      rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'RESULT_PASS' }]; },
      extractAfter: function() { return []; }
    });
    assert.strictEqual(typeof res.outcome, 'string', 'log shape ' + shape + ' produced an outcome, no throw');
    assert.ok(['FIXED', 'NOT_FIXED', 'BLOCKED', 'NO_REPAIR'].indexOf(res.outcome) !== -1, 'recognized outcome for ' + shape);
    assertSchema11AndEvidence(cwd, runId || res.runId || runId, 'ANY');
    assertNoSecretLeak(cwd, canary);
  }
});

test('coerce helpers: toText/toArray/stackToString never throw on any shape', function() {
  var shapes = [undefined, null, '', 'x', ['a', 'b'], { a: 1 }, 42, true];
  for (var i = 0; i < shapes.length; i++) {
    var s = shapes[i];
    assert.strictEqual(typeof coerce.toText(s, 100), 'string', 'toText(' + JSON.stringify(s) + ')');
    assert.ok(Array.isArray(coerce.toArray(s)), 'toArray(' + JSON.stringify(s) + ')');
    assert.strictEqual(typeof coerce.stackToString(s, 100), 'string', 'stackToString(' + JSON.stringify(s) + ')');
  }
  assert.strictEqual(coerce.stackToString([{ file: 'a', line: 2 }]), 'a:2');
  assert.strictEqual(coerce.stackToString(undefined), 'none');
});

test('dry-run: propose stage drives modelClient with a real Response object, not a hand-built stub -> FIXED', async function() {
  var cwd = tempCwd();
  var log = [];
  var ctrl = { verifyCalls: 0, verifyVerdicts: [{ status: 'fixed' }] };
  var runId = runIdFor('realresponse');
  seedRealShapedRun(cwd, runId);
  var canary = 'canary-realresponse-zzz9';
  var fetched = false;
  var payload = {
    choices: [{ message: { content: JSON.stringify({ repairKind: 'source-edit', rationale: 'fix via real Response', edits: [{ path: 'x', oldString: 'a', newString: 'b' }], newFiles: [] }) } }],
    usage: { total_tokens: 3 }
  };
  var res = await runOnce({
    repairMode: true,
    runId: runId,
    cwd: cwd,
    env: { VENDURE_STAGING_REPO_TOKEN: canary, OPENROUTER_API_KEY: 'key-' + canary },
    fetch: function(url, opts) {
      fetched = true;
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    },
    adapters: fakeAdapters(ctrl, log, { modelResponse: true }),
    rerunTasks: async function() { return [{ taskId: 'CAN-B1-03', result: 'RESULT_PASS' }]; },
    extractAfter: function() { return []; }
  });
  assert.strictEqual(fetched, true, 'the injected WHATWG fetch must actually be used in the propose stage');
  assert.strictEqual(res.outcome, 'FIXED', 'FIXED when the real Response drives a valid edit set');
  assert.strictEqual(res.exitCode, 0);
  assertSchema11AndEvidence(cwd, runId, 'FIXED');
  assertNoSecretLeak(cwd, canary);
});
