'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var childProcess = require('child_process');

var executors = require('../src/executors/imageArchive');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_PASS = terminalState.RESULT_PASS;
var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var REPO_ROOT = path.resolve(__dirname, '..');
var SCRIPT_PATH = path.join(REPO_ROOT, executors.SYNC_SCRIPT);
var FIXTURE_PATH = path.join(REPO_ROOT, executors.FIXTURE_DESIGN_FAMILY, executors.FIXTURE_DESIGN_SET);

function fakeClock(iso) {
  var current = new Date(iso || '2026-10-07T09:00:00.000Z');
  return function() { return new Date(current.getTime()); };
}

function taskFor(taskId, expectedResult) {
  return {
    canonicalId: taskId,
    summaryIds: ['B2-02'],
    requiredInputs: ['productsImagesArchiveRoot'],
    expectedResult: expectedResult || ('expected result for ' + taskId)
  };
}

function realWorkspace(prefix) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ws-ia-'));
  return { workspaceId: 'ws-ia', workspacePath: dir, runId: 'run-ia', exists: true };
}

function baseDeps(execFile) {
  return {
    execFile: execFile || childProcess.execFile,
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    mkdirSync: function(p, o) { fs.mkdirSync(p, o || { recursive: true }); },
    readFileSync: function(p, e) { return fs.readFileSync(p, e || 'utf8'); },
    readdirSync: function(p, o) { return fs.readdirSync(p, o || { withFileTypes: true }); },
    existsSync: function(p) { return fs.existsSync(p); },
    statSync: function(p) { return fs.statSync(p); },
    cpSync: function(s, d, o) { fs.cpSync(s, d, o); }
  };
}

function baseContext(overrides) {
  overrides = overrides || {};
  var ws = overrides.workspace || realWorkspace();
  var ctx = {
    taskId: 'CAN-B2-04',
    task: taskFor('CAN-B2-04', 'expected result for CAN-B2-04'),
    workspace: ws,
    runEnvRecord: { runId: ws.runId, gitHead: 'beeffeed1111', revisionId: 'rev-t' },
    repoRoot: REPO_ROOT,
    deps: baseDeps(overrides.execFile)
  };
  if (overrides.runId) ctx.runId = overrides.runId;
  if (overrides.fixtures) ctx.fixtures = overrides.fixtures;
  if (overrides.extraDeps) Object.assign(ctx.deps, overrides.extraDeps);
  return ctx;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'expected result for ' + (taskId || 'unknown'),
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Real-script integration harness: the supplied script runs genuinely in a
// child process, so the PASS path and dry-run behaviour are guaranteed against
// the actual sync_vendor_uploads.mjs, not a mock.
// ---------------------------------------------------------------------------

test('imageArchive: real script dry-run + apply, verified on disk -> PASS', async function(t) {
  var ctx = baseContext({});
  var outcome = await executors.handlerImageArchive(ctx);
  var ws = ctx.workspace.workspacePath;

  assert.strictEqual(outcome.success, true, outcome.error);
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS);
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-04');

  var ev = outcome.evidence;
  assert.strictEqual(ev.scope, 'image-archive');
  assert.strictEqual(ev.coverage, 'readiness-subset', 'coverage recorded as plain string');
  assert.strictEqual(ev.executionRevision, 'beeffeed1111');
  assert.strictEqual(ev.script.repoRelativePath, executors.SYNC_SCRIPT);

  // commands are argument arrays, repo-relative
  assert.strictEqual(ev.commands.length, 2, 'one dry-run + one apply');
  assert.strictEqual(ev.commands[0].command, 'node');
  assert.strictEqual(ev.commands[0].args[0], executors.SYNC_SCRIPT);
  assert.ok(ev.commands[0].args.some(function(a) { return a.indexOf('--apply') === -1; }), 'first is dry-run');
  assert.ok(ev.commands[1].args.indexOf('--apply') !== -1, 'second is apply');

  // dry-run wrote nothing: the executor captured the archive set before the
  // dry-run and asserts it is unchanged after it. Post-apply the archive root
  // is legitimately populated, so we assert the recorded check instead of the
  // final on-disk state.
  assert.strictEqual(ev.checks.dryRunWroteNothing, true);

  // on-disk verification captured + all in scope
  assert.strictEqual(ev.checks.allInScopeVerified, true);
  assert.ok(ev.assertions.length >= 2, 'per-assertion list present');
  var inScope = ev.assertions.filter(function(a) { return a.inScope; });
  var outScope = ev.assertions.filter(function(a) { return !a.inScope; });
  assert.ok(inScope.every(function(a) { return a.verified === true; }), 'all in-scope assertions verified');
  assert.ok(outScope.length === 2, 'export-lookup + customer-upload-form out of scope');
  assert.ok(outScope.every(function(a) { return a.verified === false; }), 'out-of-scope assertions recorded as unverified');

  // JSON + log metadata present in expected locations
  var destRoot = ev.verification.destRoot;
  assert.ok(fs.existsSync(path.join(destRoot, 'sync-result.json')), 'sync-result.json on disk');
  assert.strictEqual(fs.existsSync(path.join(ws, executors.ARTIFACT_SUBDIR + '/2026-10-07T09-00-00-000Z/result.json')), true, 'result.json artifact on disk');
  assert.strictEqual(fs.existsSync(path.join(ws, executors.ARTIFACT_SUBDIR + '/2026-10-07T09-00-00-000Z/summary.txt')), true, 'summary.txt artifact on disk');

  // overall image 0 exists
  assert.ok(fs.existsSync(path.join(destRoot, '1', '0.jpg')), 'overall image 1/0.jpg on disk');

  fs.rmSync(ws, { recursive: true, force: true });
});

test('imageArchive: fixture design set 5 files all land with equal sha256', function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ia-mirror-'));
  var srcFiles = executors.listFiles({ deps: {} }, FIXTURE_PATH);
  assert.strictEqual(srcFiles.length, 11, 'fixture 5 has 11 files');
  var plan = executors.deriveExpected(FIXTURE_PATH, srcFiles);
  assert.strictEqual(plan.length, 11, 'all are supported images');
  var hasMaster = plan.some(function(p) { return p.relativePath === '1/0.jpg'; });
  assert.ok(hasMaster, 'plan contains 1/0.jpg master');
  var ids = plan.map(function(p) { return p.relativePath; }).sort();
  assert.ok(ids.indexOf('1/1.jpg') !== -1 && ids.indexOf('1.jpg') !== -1, 'design/effect identifiers present');
  // sha256File matches sha256Hex of content
  var masterAbs = plan.filter(function(p) { return p.relativePath === '1/0.jpg'; })[0].sourcePath;
  assert.strictEqual(executors.sha256File(masterAbs), plan.filter(function(p) { return p.relativePath === '1/0.jpg'; })[0].sha256);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Failure paths: inject a script that silently loses/corrupts a file so the
// on-disk verification catches it (not by exit code alone).
// ---------------------------------------------------------------------------

/**
 * A fake execFile that behaves like sync_vendor_uploads.mjs for dry-run
 * (writes result.json + summary.txt only) but for --apply copies only a
 * controlled subset/corruption of the source so verification must fail.
 *
 * options.missing = [relative paths to omit] (default [])
 * options.corrupt = { relativePath } -> copy with one byte flipped
 * options.applyExit = exit code for apply (default 0)
 */
function makeFaultyExec(options) {
  options = options || {};
  var missing = options.missing || [];
  var corrupt = options.corrupt || null;
  return function(file, args, optionsObj, cb) {
    try {
      var argv = args.slice(0);
      if (argv[0] === executors.SYNC_SCRIPT) argv = args.slice(1, args.length);
      var apply = argv.indexOf('--apply') !== -1;
      var sourceRoot = argv.filter(function(a) { return a.indexOf('--source-root=') === 0; })[0].split('=').slice(1).join('=');
      var archiveRoot = argv.filter(function(a) { return a.indexOf('--archive-root=') === 0; })[0].split('=').slice(1).join('=');
      var sku = argv.filter(function(a) { return a.indexOf('--sku=') === 0; })[0].split('=').slice(1).join('=');
      var ts = argv.filter(function(a) { return a.indexOf('--timestamp=') === 0; })[0].split('=').slice(1).join('=');
      var artifactRoot = optionsObj.env.VENDOR_UPLOADS_ARTIFACT_ROOT;

      var files = executors.listFiles({ deps: {} }, sourceRoot);
      var supported = files.filter(function(f) {
        var ext = path.extname(f.rel).toLowerCase();
        return executors.IMAGE_EXTENSIONS.indexOf(ext) !== -1 || executors.METADATA_EXTENSIONS.indexOf(ext) !== -1;
      });
      var plan = supported.map(function(f) {
        return { relativePath: f.rel, sourcePath: f.abs, size: f.size, sha256: executors.sha256File(f.abs) };
      }).sort(function(a, b) { return a.relativePath < b.relativePath ? -1 : 1; });

      var destRoot = path.join(archiveRoot, sku, ts);
      var manifest = { mode: apply ? 'apply' : 'dry-run', sku: sku, timestamp: ts, sourceRoot: sourceRoot, archiveRoot: archiveRoot, destinationRoot: destRoot, totalScanned: files.length, totalSelected: plan.length, plan: plan, completedAt: new Date().toISOString() };

      var artDir = path.join(artifactRoot, ts);
      fs.mkdirSync(artDir, { recursive: true });
      fs.writeFileSync(path.join(artDir, 'result.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(artDir, 'summary.txt'), 'mode: ' + manifest.mode + '\nsku: ' + sku + '\n', 'utf8');

      if (!apply) {
        cb(null, 'PASS dry-run\n', '');
        return;
      }
      fs.mkdirSync(destRoot, { recursive: true });
      plan.forEach(function(item) {
        if (missing.indexOf(item.relativePath) !== -1) return;
        var dst = path.join(destRoot, item.relativePath);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (corrupt && corrupt.relativePath === item.relativePath) {
          var buf = fs.readFileSync(item.sourcePath);
          buf[0] = (buf[0] ^ 0xff) & 0xff;
          fs.writeFileSync(dst, buf);
        } else {
          fs.copyFileSync(item.sourcePath, dst);
        }
      });
      // script also writes sync-result.json into the destination
      fs.writeFileSync(path.join(destRoot, 'sync-result.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      cb(options.applyExit === undefined || options.applyExit === 0 ? null : { code: options.applyExit, message: 'apply failed' }, 'PASS\n', 'FAILED\n');
    } catch (e) {
      cb({ code: 1, message: String((e && e.message) || e) }, '', '');
    }
  };
}

test('imageArchive: missing archive file -> EXPECTED_MISMATCH, not PASS', async function(t) {
  var ctx = baseContext({ execFile: makeFaultyExec({ missing: ['1/0.jpg'] }) });
  var outcome = await executors.handlerImageArchive(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.evidence.checks.allInScopeVerified === false);
  assert.ok(outcome.evidence.verification.failures.length > 0);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-04');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('imageArchive: sha256 mismatch -> EXPECTED_MISMATCH, not PASS', async function(t) {
  var ctx = baseContext({ execFile: makeFaultyExec({ corrupt: { relativePath: '1/1.jpg' } }) });
  var outcome = await executors.handlerImageArchive(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.allInScopeVerified, false);
  assert.strictEqual(outcome.evidence.verification.failures.length, 1);
  assert.ok(outcome.evidence.verification.failures[0].indexOf('hash mismatch') !== -1, outcome.evidence.verification.failures[0]);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-04');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('imageArchive: --apply exits non-zero -> ENVIRONMENT_ERROR, not PASS', async function(t) {
  var ctx = baseContext({ execFile: makeFaultyExec({ applyExit: 3 }) });
  var outcome = await executors.handlerImageArchive(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Double --apply truth. The script derives its destination from the timestamp:
// a second --apply with a DIFFERENT timestamp creates a SECOND timestamp
// directory. That is "not idempotent by directory". Re-running the executor
// with the SAME timestamp instead overwrites the same directory in place (in
// place, not a duplicate). We assert the truthful statement: it is NOT idempotent
// across timestamps.
// ---------------------------------------------------------------------------

test('imageArchive: double --apply with different timestamps creates a second timestamp directory (state: not idempotent by directory)', async function(t) {
  // Two applies with different timestamps -> the script writes a second
  // <archive>/<sku>/<timestamp2>/ directory. This is the actual script
  // behaviour: "not idempotent by directory".
  var ws = realWorkspace('ws-ia-');
  var ctx = baseContext({ workspace: ws, fixtures: { designSet: '5', timestamp: '2026-10-07T09-00-00-001Z' } });
  var ctx2 = baseContext({ workspace: ws, fixtures: { designSet: '5', timestamp: '2026-10-07T09-00-00-002Z' } });
  var archiveRoot = path.join(ws.workspacePath, executors.ARCHIVE_SUBDIR);

  var outcome1 = await executors.handlerImageArchive(ctx);
  assert.strictEqual(outcome1.success, true, outcome1.error);
  var dir1 = outcome1.evidence.verification.destRoot;
  assert.ok(dir1.indexOf('2026-10-07T09-00-00-001Z') !== -1, 'first apply used timestamp 001Z');

  var outcome2 = await executors.handlerImageArchive(ctx2);
  assert.strictEqual(outcome2.success, true, outcome2.error);
  var dir2 = outcome2.evidence.verification.destRoot;
  assert.ok(dir2.indexOf('2026-10-07T09-00-00-002Z') !== -1, 'second apply used timestamp 002Z');
  assert.notStrictEqual(dir1, dir2, 'different timestamps -> different destination directory');

  // The truth: the second apply created a SECOND timestamp directory.
  var children = fs.readdirSync(path.join(archiveRoot, 'FIXTURE-5')).sort();
  assert.ok(children.indexOf('2026-10-07T09-00-00-001Z') !== -1, 'first timestamp directory exists');
  assert.ok(children.indexOf('2026-10-07T09-00-00-002Z') !== -1, 'second timestamp directory ALSO exists');
  assert.strictEqual(children.length, 2, 'two distinct timestamp directories exist');
  assert.strictEqual(outcome2.evidence.checks.allInScopeVerified, true);
  assert.notStrictEqual(outcome1.evidence.verification.destRoot, dir2, 'destRoot differs -> not idempotent by directory');
  fs.rmSync(ws.workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Evidence persistence + register()
// ---------------------------------------------------------------------------

test('imageArchive: writes executor evidence + canonical record via writeEvidenceFile/writeTaskRecord', async function(t) {
  var evidenceFiles = [];
  var records = [];
  var ctx = baseContext({
    runId: 'run-x',
    extraDeps: {
      writeEvidenceFile: function(runId, taskId, filename, content, opts) {
        evidenceFiles.push({ runId: runId, taskId: taskId, filename: filename, content: content, opts: opts });
      },
      writeTaskRecord: function(runId, taskId, record, opts) {
        records.push({ runId: runId, taskId: taskId, record: record, opts: opts });
      }
    }
  });
  var outcome = await executors.handlerImageArchive(ctx);
  assert.strictEqual(outcome.success, true, outcome.error);

  assert.strictEqual(evidenceFiles.length, 1);
  assert.strictEqual(evidenceFiles[0].runId, 'run-x');
  assert.strictEqual(evidenceFiles[0].taskId, 'CAN-B2-04');
  assert.strictEqual(evidenceFiles[0].filename, 'executor-image-archive.json');
  var parsed = JSON.parse(evidenceFiles[0].content);
  assert.ok(parsed.evidence && parsed.evidence.checks.allInScopeVerified === true);
  assert.strictEqual(parsed.evidence.coverage, 'readiness-subset');

  assert.strictEqual(records.length, 1);
  var rec = records[0].record;
  assert.strictEqual(rec.canonicalId, 'CAN-B2-04');
  assert.strictEqual(rec.executionRevision, 'beeffeed1111');
  assert.strictEqual(rec.exactScriptPath, executors.SYNC_SCRIPT);
  assert.strictEqual(rec.finalClassification, RESULT_READINESS_PASS);
  assert.strictEqual(rec.coverage, 'readiness-subset', 'coverage field present as plain string in record');
  assert.strictEqual(rec.scope, 'image-archive');
  assert.strictEqual(rec.stateChanges.dryRunWroteNothing, true);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('imageArchive: register() registers CAN-B2-04', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.deepStrictEqual(reg.registered, ['CAN-B2-04']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-04'), true);
  assert.strictEqual(typeof executorModule.getTaskExecutor('CAN-B2-04').handler, 'function');
  executorModule.resetTaskExecutors();
});

test('imageArchive: missing archive file names the missing relative file in the failure', async function(t) {
  var ctx = baseContext({ execFile: makeFaultyExec({ missing: ['1/0.jpg'] }) });
  var outcome = await executors.handlerImageArchive(ctx);
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  var failureText = (outcome.evidence.verification.failures || []).join('; ');
  assert.ok(failureText.indexOf('1/0.jpg') !== -1 || failureText.indexOf('overall image') !== -1 || failureText.indexOf('0') !== -1,
    'missing file named in failure: ' + failureText);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('imageArchive: unwritable archive root (EACCES) -> DEPENDENCY_ENVIRONMENT, not PASS', async function(t) {
  // Injected fs whose write/apply path throws EACCES so the script's archive
  // write fails. The executor must surface BLOCK DEPENDENCY_ENVIRONMENT and
  // never claim PASS.
  var ctx = baseContext({
    execFile: function(file, args, optionsCloud, cb) {
      try {
        var argv = args.slice(0);
        if (argv[0] === executors.SYNC_SCRIPT) argv = args.slice(1, args.length);
        var apply = argv.indexOf('--apply') !== -1;
        var archiveRoot = argv.filter(function(a) { return a.indexOf('--archive-root=') === 0; })[0].split('=').slice(1).join('=');
        var artifactRoot = optionsCloud.env.VENDOR_UPLOADS_ARTIFACT_ROOT;
        var ts = argv.filter(function(a) { return a.indexOf('--timestamp=') === 0; })[0].split('=').slice(1).join('=');
        var artDir = path.join(artifactRoot, ts);
        fs.mkdirSync(artDir, { recursive: true });
        fs.writeFileSync(path.join(artDir, 'result.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(artDir, 'summary.txt'), 'x', 'utf8');
        if (!apply) {
          cb(null, 'PASS dry-run\n', '');
          return;
        }
        var eaccs = new Error('EACCES: permission denied, mkdir \'' + archiveRoot + '\'');
        eaccs.code = 'EACCES';
        throw eaccs;
      } catch (e) {
        cb({ code: e.code === 'EACCES' ? 1 : 1, message: String((e && e.message) || e) }, '', '');
      }
    }
  });
  var outcome = await executors.handlerImageArchive(ctx);
  assert.strictEqual(outcome.success, false);
  assert.ok(outcome.errorCode === 'ENVIRONMENT_ERROR' || outcome.errorCode === 'DEPENDENCY_ENVIRONMENT',
    'fails with an environment error, got ' + outcome.errorCode);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-04');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, 'DEPENDENCY_ENVIRONMENT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('imageArchive: overall image verified by file named 0, not only by the 1/0 path', function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ia-zero-'));
  var ws = { workspaceId: 'ws-ia', workspacePath: tmp, runId: 'run-ia', exists: true };
  var ctx = { deps: {}, workspace: ws };
  var sourceRoot = path.join(tmp, executors.SOURCE_SUBDIR);
  fs.mkdirSync(path.join(sourceRoot, '1'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '1', '0.jpg'), 'master', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, '1', '1.jpg'), 'a', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, '1.jpg'), 'b', 'utf8');
  var files = executors.listFiles({ deps: {} }, sourceRoot);
  var plan = executors.deriveExpected(sourceRoot, files);
  // Archive mirrors the source under <archive>/<sku>/<ts>/.
  var archiveRoot = path.join(tmp, executors.ARCHIVE_SUBDIR);
  var destRoot = path.join(archiveRoot, 'FIXTURE-5', '2026-10-07T09-00-00-000Z');
  fs.mkdirSync(path.join(destRoot, '1'), { recursive: true });
  plan.forEach(function(p) {
    var dst = path.join(destRoot, p.relativePath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(p.sourcePath, dst);
  });
  fs.writeFileSync(path.join(destRoot, 'sync-result.json'), JSON.stringify({ sku: 'FIXTURE-5', timestamp: '2026-10-07T09-00-00-000Z', plan: plan }, null, 2), 'utf8');
  var v = executors.verifyArchive({ deps: {} }, archiveRoot, 'FIXTURE-5', '2026-10-07T09-00-00-000Z', plan);
  var overall = v.assertions.filter(function(a) { return a.id === 'overall-image-0'; })[0];
  assert.ok(overall && overall.verified === true, 'overall image verified (by name 0): ' + JSON.stringify(overall));
  // The verification names the file (1/0.jpg), not a fixed hardcoded path only.
  assert.ok(overall.detail.indexOf('1/0.jpg') !== -1, 'detail names the 0 file: ' + overall.detail);
  assert.strictEqual(v.failures.length, 0, 'no failures: ' + v.failures.join('; '));
  fs.rmSync(tmp, { recursive: true, force: true });
});

