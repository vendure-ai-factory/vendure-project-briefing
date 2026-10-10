'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var test = require('node:test');
var assert = require('node:assert');

var TEST_BASE = path.resolve(__dirname, '..', 'runs', 'run-staging-test-' + Date.now());
var APPROVED = ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16'];
var MANIFEST = 'manifest/acceptance-manifest.v0.4.json';

function freshDir(label) {
  var d = path.join(TEST_BASE, label);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function stageOf(args) {
  args = args || [];
  var t = args.indexOf('--task');
  if (t !== -1 && args[t + 1]) return 'task-' + args[t + 1];
  return 'unknown';
}

function writeArtifacts(cwd, runId, stageName, classification) {
  var evDir = path.join(cwd, 'evidence', runId);
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'index.json'),
    JSON.stringify({ schemaVersion: '1.0', runId: runId, tasks: {} }, null, 2) + '\n', 'utf8');
  var repDir = path.join(cwd, 'reports', runId);
  fs.mkdirSync(repDir, { recursive: true });
  var uniq = stageName + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  var tasks = classification
    ? [{ taskId: uniq, result: 'BLOCK', classification: classification, cause: 'TEST' }]
    : [{ taskId: uniq, result: 'PASS', classification: null, cause: null }];
  fs.writeFileSync(path.join(repDir, 'run-summary.json'),
    JSON.stringify({ schemaVersion: '1.0', runId: runId, counts: {}, tasks: tasks }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(repDir, 'compliance-report.json'),
    JSON.stringify({ schemaVersion: '1.0', runId: runId, tasks: tasks }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(repDir, 'compliance-report.md'), '# compliance\n', 'utf8');
}

function makeChild(config) {
  config = config || {};
  var results = config.results || {};
  var execCalls = [];
  var spawnCalls = [];
  return {
    execCalls: execCalls,
    spawnCalls: spawnCalls,
    execFileSync: function(cmd, args) {
      execCalls.push({ cmd: cmd, args: args });
      if (String(cmd) === 'git' && args[0] === 'rev-parse') return 'abc123def456fedcba321\n';
      if (args[0] === 'skills/pipeline-review/review.js') return 'OVERALL: PASS\n';
      throw new Error('unexpected execFileSync ' + String(cmd) + ' ' + (args || []).join(' '));
    },
    spawnSync: function(cmd, args, options) {
      spawnCalls.push({ cmd: cmd, args: args, options: options });
      var env = (options && options.env) || {};
      var cwdVal = (options && options.cwd) || process.cwd();
      var runId = env.PIPELINE_RUN_ID || 'run-fallback-default';
      var stageName = stageOf(args);
      var stageConfig = results[stageName] ? results[stageName] : {};
      var classification = stageConfig.classification || null;
      writeArtifacts(cwdVal, runId, stageName, classification);
      var status = (stageConfig.status === undefined) ? 0 : stageConfig.status;
      return { status: status, stdout: 'pipeline output line\n', stderr: '' };
    }
  };
}

function makeFetch(healthStatus, shopStatus) {
  healthStatus = healthStatus === undefined ? 200 : healthStatus;
  shopStatus = shopStatus === undefined ? 200 : shopStatus;
  return function(url) {
    var u = String(url);
    if (u.endsWith('/health') || u.indexOf('/health') !== -1) {
      return Promise.resolve({ status: healthStatus,
        json: function() { return Promise.resolve(healthStatus === 200 ? { status: 'ok' } : {}); } });
    }
    if (u.indexOf('/shop-api') !== -1) {
      return Promise.resolve({ status: shopStatus,
        json: function() { return Promise.resolve(shopStatus === 200 ? { data: { __typename: 'Query' } } : {}); } });
    }
    return Promise.resolve({ status: 404, json: function() { return Promise.resolve({}); } });
  };
}

function baseEnv(overrides) {
  var env = {
    STAGING_ADMIN_EMAIL: 'admin@staging.local',
    STAGING_ADMIN_PASSWORD: 'staging-admin-pw-1',
    STRIPE_SECRET_KEY: 'dummy-stripe-secret',
    OPENROUTER_API_KEY: 'dummy-openrouter-secret'
  };
  if (overrides) Object.keys(overrides).forEach(function(k) { env[k] = overrides[k]; });
  return env;
}

function workflowArgs(archiveRoot, taskIds, mode) {
  var effectiveMode = mode !== undefined ? mode : (taskIds && taskIds.length ? 'full' : 'preflight');
  return { mode: effectiveMode, environment: 'staging', stagingUrl: 'http://staging.local', shopApiUrl: null, archiveDir: archiveRoot, taskIds: taskIds || [] };
}

function makeDeps(label, opts) {
  opts = opts || {};
  var cwd = opts.cwd || freshDir(label + '-cwd');
  var archiveRoot = opts.archiveRoot || path.join(cwd, 'archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  var child = opts.child || makeChild(opts.config || { results: {} });
  var runId = opts.runId || ('stg-' + label + '-' + Date.now());
  var env = opts.env || baseEnv();
  env.PIPELINE_ARCHIVE_ROOT = archiveRoot;
  var args = opts.args;
  if (args === undefined) args = workflowArgs(archiveRoot, opts.taskIds, opts.mode);
  var deps = {
    cwd: cwd,
    fs: opts.fs || require('fs'),
    childProcess: child,
    fetch: opts.fetch || makeFetch(opts.healthStatus),
    env: env,
    args: args,
    runId: runId,
    nodeVersion: opts.nodeVersion || 'v20.12.2'
  };
  deps.child = child;
  deps.archiveRoot = archiveRoot;
  return deps;
}

function listFiles(dir) {
  var result = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    var entries = fs.readdirSync(d, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var full = path.join(d, entries[i].name);
      if (entries[i].isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(dir);
  return result;
}

var runStagingModule = null;
async function loadModule() {
  if (!runStagingModule) {
    runStagingModule = await import('../pipeline/run-staging.mjs');
  }
  return runStagingModule;
}

// ---------------------------------------------------------------- CLI parsing

test('parseArgs: parses workflow flags including approved --task selections', async function() {
  var mod = await loadModule();
  var parsed = mod.parseArgs([
    '--environment', 'staging',
    '--staging-url', 'https://staging.tibella.eu',
    '--archive-dir', '/opt/pipeline-archive',
    '--task', 'CAN-B1-03', '--task', 'CAN-B2-16'
  ]);
  assert.strictEqual(parsed.error, undefined);
  assert.strictEqual(parsed.environment, 'staging');
  assert.strictEqual(parsed.stagingUrl, 'https://staging.tibella.eu');
  assert.strictEqual(parsed.archiveDir, '/opt/pipeline-archive');
  assert.deepStrictEqual(parsed.taskIds, ['CAN-B1-03', 'CAN-B2-16']);
  assert.strictEqual(parsed.mode, null);
});

test('parseArgs: rejects unknown flags and missing values', async function() {
  var mod = await loadModule();
  assert.ok(mod.parseArgs(['--bogus', 'x']).error);
  assert.ok(mod.parseArgs(['--staging-url']).error);
});

// ------------------------------------------------------------- config derivation

test('resolveConfig: derives shop API from staging URL and defaults to preflight mode', async function() {
  var mod = await loadModule();
  var cfg = mod.resolveConfig({
    env: baseEnv(),
    args: { mode: null, environment: 'staging', stagingUrl: 'https://staging.tibella.eu', shopApiUrl: null, archiveDir: '/opt/pipeline-archive', taskIds: [] }
  });
  assert.strictEqual(cfg.mode, 'preflight', 'safe non-mutating default');
  assert.strictEqual(cfg.stagingUrl, 'https://staging.tibella.eu');
  assert.strictEqual(cfg.shopApiUrl, 'https://staging.tibella.eu/shop-api');
  assert.strictEqual(cfg.archiveRoot, '/opt/pipeline-archive');
});

test('resolveConfig: env overrides PIPELINE_SHOP_API_URL / PIPELINE_STAGING_URL', async function() {
  var mod = await loadModule();
  var shop = mod.resolveConfig({
    env: baseEnv({ PIPELINE_SHOP_API_URL: 'https://shop.example/api' }),
    args: { mode: 'full', stagingUrl: 'https://staging.tibella.eu', shopApiUrl: null, archiveDir: '/opt/pipeline-archive', taskIds: APPROVED }
  });
  assert.strictEqual(shop.shopApiUrl, 'https://shop.example/api');

  var staging = mod.resolveConfig({
    env: baseEnv({ PIPELINE_STAGING_URL: 'https://env.example' }),
    args: { mode: 'full', stagingUrl: null, shopApiUrl: null, archiveDir: '/opt/pipeline-archive', taskIds: APPROVED }
  });
  assert.strictEqual(staging.stagingUrl, 'https://env.example');
  assert.strictEqual(staging.shopApiUrl, 'https://env.example/shop-api');
});

// ------------------------------------------------ task selection + rejection

test('checkTaskSelection: only the three approved ids are allowed', async function() {
  var mod = await loadModule();
  var cfg = { mode: 'full', taskIds: APPROVED };
  assert.strictEqual(mod.checkTaskSelection(cfg).ok, true);
  assert.deepStrictEqual(mod.AUTHORIZED_TASK_IDS, APPROVED);

  var empty = mod.checkTaskSelection({ mode: 'full', taskIds: [] });
  assert.strictEqual(empty.ok, false);
  assert.ok(empty.error.indexOf('approved') !== -1);

  var unapproved = mod.checkTaskSelection({ mode: 'full', taskIds: ['CAN-B1-03', 'CAN-B1-01', 'CAN-B2-16'] });
  assert.strictEqual(unapproved.ok, false);
  assert.ok(unapproved.error.indexOf('CAN-B1-01') !== -1);
  assert.ok(unapproved.error.indexOf('not approved') !== -1);

  var duplicate = mod.checkTaskSelection({ mode: 'full', taskIds: ['CAN-B1-03', 'CAN-B1-04', 'CAN-B1-03'] });
  assert.strictEqual(duplicate.ok, false, 'duplicate selection must be rejected');

  var additional = mod.checkTaskSelection({ mode: 'full', taskIds: ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16', 'CAN-B1-01'] });
  assert.strictEqual(additional.ok, false, 'additional id must be rejected');

  var reordered = mod.checkTaskSelection({ mode: 'full', taskIds: ['CAN-B1-04', 'CAN-B1-03', 'CAN-B2-16'] });
  assert.strictEqual(reordered.ok, false, 'reordered ids must be rejected');

  var preflight = mod.checkTaskSelection({ mode: 'preflight', taskIds: [] });
  assert.strictEqual(preflight.ok, true, 'preflight mode needs no task selection');
});

test('runStaging: empty task selection in full mode is rejected before spawning', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('empty-selection', { child: child });
  deps.args.mode = 'full';
  deps.args.taskIds = [];

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, mod.INVALID_MODE_EXIT);
  assert.strictEqual(result.taskSelectionError, true);
  assert.strictEqual(child.spawnCalls.length, 0, 'must not spawn');
  assert.strictEqual(fs.existsSync(path.join(deps.archiveRoot, deps.runId, 'preflight')), false,
    'must not write preflight evidence on rejected selection');
});

test('runStaging: unapproved task ids are rejected before spawning', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('unapproved', { child: child });
  deps.args.mode = 'full';
  deps.args.taskIds = ['CAN-B1-03', 'CAN-B1-01', 'CAN-B2-16'];

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, mod.INVALID_MODE_EXIT);
  assert.strictEqual(result.taskSelectionError, true);
  assert.strictEqual(child.spawnCalls.length, 0, 'must not spawn');
});

test('runStaging: full mode runs exactly the approved task ids in order', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('approved-run', { child: child, taskIds: APPROVED });

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.mode, 'full');
  assert.strictEqual(child.spawnCalls.length, 3);
  assert.deepStrictEqual(child.spawnCalls[0].args,
    ['bin/pipeline.js', 'run', '--manifest', MANIFEST, '--task', 'CAN-B1-03']);
  assert.deepStrictEqual(child.spawnCalls[1].args,
    ['bin/pipeline.js', 'run', '--manifest', MANIFEST, '--task', 'CAN-B1-04']);
  assert.deepStrictEqual(child.spawnCalls[2].args,
    ['bin/pipeline.js', 'run', '--manifest', MANIFEST, '--task', 'CAN-B2-16', '--scope', 'shipping-dryrun']);
  assert.strictEqual(result.exitCode, 0);
});

test('runStaging: default (no mode flag) is preflight-only and never spawns', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('preflight-default', { child: child, healthStatus: 200 });
  deps.args.mode = null;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.mode, 'preflight');
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(child.spawnCalls.length, 0, 'default must not spawn');
});

test('runStaging: a blocked or failed approved task does not stop the others', async function() {
  var mod = await loadModule();
  var child = makeChild({
    results: {
      'task-CAN-B1-03': { status: 4, classification: 'CLIENT_INPUT_SCOPE' }
    }
  });
  var deps = makeDeps('nonblocking', { child: child, taskIds: APPROVED });
  var result = await mod.runStaging(deps);
  assert.strictEqual(child.spawnCalls.length, 3, 'all approved tasks still run after a failure');
  assert.notStrictEqual(result.stages[0].exitCode, 0);
});

// ------------------------------------------------- exit code (requirement 5)

test('runStaging: any PIPELINE_DEFECT result exits non-zero', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: { 'task-CAN-B2-16': { status: 3, classification: 'PIPELINE_DEFECT' } } });
  var deps = makeDeps('defect', { child: child, taskIds: APPROVED });
  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'PIPELINE_DEFECT must exit non-zero');
  assert.strictEqual(result.anyPipelineDefect, true);
  assert.strictEqual(child.spawnCalls.length, 3, 'defect stage does not stop the others');
});

test('runStaging: any blocked or failed approved task exits non-zero and still runs the others', async function() {
  var mod = await loadModule();
  var child = makeChild({
    results: {
      'task-CAN-B1-03': { status: 4, classification: 'CLIENT_INPUT_SCOPE' },
      'task-CAN-B1-04': { status: 6, classification: 'DEPENDENCY_ENVIRONMENT' }
    }
  });
  var deps = makeDeps('nondefect', { child: child, taskIds: APPROVED });
  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'blocked or failed task must exit non-zero');
  assert.strictEqual(child.spawnCalls.length, 3, 'failure of one task does not stop the others');
  assert.strictEqual(result.anyPipelineDefect, false, 'no PIPELINE_DEFECT classification was seen');
});

// ------------------------------------------------- mode / preflight behaviour

test('runStaging: preflight failure exits non-zero in preflight mode', async function() {
  var mod = await loadModule();
  var deps = makeDeps('preflight-health500', { healthStatus: 500 });
  deps.args.mode = 'preflight';
  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0);
  assert.strictEqual(result.preflightOk, false);
});

test('runStaging: invalid mode fails safely without spawning', async function() {
  var mod = await loadModule();
  var deps = makeDeps('invalid-mode');
  deps.args.mode = 'staging';
  var result = await mod.runStaging(deps);
  assert.strictEqual(result.invalidMode, true);
  assert.strictEqual(result.exitCode, mod.INVALID_MODE_EXIT);
  assert.strictEqual(deps.child.spawnCalls.length, 0);
});

// ------------------------------------------------------- archiving (requirement 3)

test('runStaging: archives reports and evidence under --archive-dir/<runId>/', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('archive-src', { child: child, taskIds: APPROVED });

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);

  var archiveRun = path.join(deps.archiveRoot, result.runId);
  assert.strictEqual(fs.existsSync(path.join(archiveRun, 'reports', 'run-summary.json')), true);
  assert.strictEqual(fs.existsSync(path.join(archiveRun, 'reports', 'compliance-report.json')), true);
  assert.strictEqual(fs.existsSync(path.join(archiveRun, 'evidence', 'index.json')), true);
  assert.strictEqual(fs.existsSync(path.join(archiveRun, 'review.txt')), true);
  var runJson = JSON.parse(fs.readFileSync(path.join(archiveRun, 'run.json'), 'utf8'));
  assert.strictEqual(runJson.runId, result.runId);
  assert.strictEqual(runJson.archiveOk, true);
});

// ------------------------------------------------------- secrets (requirement 4)

test('runStaging: secrets are never logged or written to any output file', async function() {
  var mod = await loadModule();
  var stripeSecret = 'sk-live-0099-x';
  var openrouterSecret = 'or-live-8821-token';
  var child = makeChild({ results: {} });
  var deps = makeDeps('secrets', { child: child, taskIds: APPROVED });
  deps.env.STRIPE_SECRET_KEY = stripeSecret;
  deps.env.OPENROUTER_API_KEY = openrouterSecret;
  deps.env.STAGING_ADMIN_PASSWORD = 'another-secret';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);

  var dirs = [
    path.join(deps.cwd, 'evidence', deps.runId),
    path.join(deps.cwd, 'reports', deps.runId),
    path.join(deps.archiveRoot, deps.runId),
    path.join(deps.cwd, 'reports')
  ];
  var files = [];
  dirs.forEach(function(d) { if (fs.existsSync(d)) files = files.concat(listFiles(d)); });
  assert.ok(files.length > 0, 'should have written output files');
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(content.indexOf(stripeSecret), -1, 'stripe secret in ' + files[i]);
    assert.strictEqual(content.indexOf(openrouterSecret), -1, 'openrouter secret in ' + files[i]);
    assert.strictEqual(content.indexOf('another-secret'), -1, 'admin password in ' + files[i]);
  }
  assert.strictEqual(child.spawnCalls[0].options.env.STRIPE_SECRET_KEY, stripeSecret,
    'secrets are read from env and forwarded to the child only');
});

// ------------------------------------------------- run id + review + admin mapping

test('runStaging: injects the same run id into every child and uses it for the review', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('runid', { child: child, taskIds: APPROVED });

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  for (var i = 0; i < child.spawnCalls.length; i++) {
    assert.strictEqual(child.spawnCalls[i].options.env.PIPELINE_RUN_ID, result.runId);
  }
  assert.strictEqual(result.runId, deps.runId);
  var reviewCall = child.execCalls.filter(function(c) {
    return c.args && c.args[0] === 'skills/pipeline-review/review.js';
  })[0];
  assert.ok(reviewCall);
  assert.strictEqual(reviewCall.args[1], result.runId);
});

test('runStaging: maps STAGING_ADMIN_* onto SUPERADMIN_* only on the child env', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('admins-map', { child: child, taskIds: APPROVED });
  delete deps.env.SUPERADMIN_USERNAME;
  delete deps.env.SUPERADMIN_PASSWORD;
  delete deps.env.VENDURE_ADMIN_API_URL;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  var childEnv = child.spawnCalls[0].options.env;
  assert.strictEqual(childEnv.SUPERADMIN_USERNAME, 'admin@staging.local');
  assert.strictEqual(childEnv.SUPERADMIN_PASSWORD, 'staging-admin-pw-1');
  assert.strictEqual(childEnv.VENDURE_ADMIN_API_URL, 'http://staging.local/admin-api');
  assert.strictEqual(deps.env.SUPERADMIN_USERNAME === undefined, true, 'parent env must stay unset');
});

test('runStaging: preflight evidence lists env var names only and never values', async function() {
  var mod = await loadModule();
  var deps = makeDeps('preflight-ev', { healthStatus: 200 });
  deps.args.mode = 'preflight';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  var preflightDir = path.join(deps.archiveRoot, result.runId, 'preflight');
  assert.strictEqual(fs.existsSync(preflightDir), true);
  var preflight = JSON.parse(fs.readFileSync(path.join(preflightDir, 'preflight.json'), 'utf8'));
  assert.strictEqual(preflight.envVarNames.indexOf('STRIPE_SECRET_KEY') !== -1, true);
  assert.strictEqual(preflight.envVarNames.indexOf('OPENROUTER_API_KEY') !== -1, true);
  var raw = fs.readFileSync(path.join(preflightDir, 'preflight.json'), 'utf8');
  assert.strictEqual(raw.indexOf('admin@staging.local'), -1, 'values never appear');
  assert.strictEqual(fs.existsSync(path.join(deps.cwd, 'evidence', result.runId, 'index.json')), false,
    'preflight must not write evidence index.json');
});

// ------------------------------------------------- missing inputs (requirement 5)

test('runStaging: full mode runs zero tasks when its own preflight fails', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('missing-archive', { child: child, taskIds: APPROVED });
  deps.args.archiveDir = path.join(deps.cwd, 'no-such-archive');
  deps.env.PIPELINE_ARCHIVE_ROOT = deps.args.archiveDir;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.preflightOk, false, 'blocked preflight must not become a pass');
  assert.strictEqual(child.spawnCalls.length, 0, 'zero tasks may run when the runner preflight fails');
  assert.notStrictEqual(result.exitCode, 0, 'a blocked preflight must exit non-zero');
});

// ------------------------------------------------- bin/pipeline.js validation

test('bin/pipeline.js: validateRunId forwards valid ids and rejects invalid ones', async function() {
  var pipeline = require('../bin/pipeline.js');
  var valid = pipeline.validateRunId('run-abc1-2def');
  assert.strictEqual(valid.ok, true);
  ['../x', 'run-ABC-1'].forEach(function(bad) {
    var r = pipeline.validateRunId(bad);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.indexOf('PIPELINE_RUN_ID') !== -1);
    assert.strictEqual(r.error.indexOf(bad), -1);
  });
  var unset = pipeline.validateRunId(undefined);
  assert.strictEqual(unset.ok, true);
});

test('bin/pipeline.js: a valid PIPELINE_RUN_ID passes validation to the CLI', async function() {
  var out = childProcess.spawnSync(process.execPath,
    ['bin/pipeline.js', 'run', '--task', 'all'],
    { cwd: process.cwd(), env: Object.assign({}, process.env, { PIPELINE_RUN_ID: 'run-abc1-2def' }), encoding: 'utf8' });
  assert.strictEqual(out.status, 2, 'CLI exits 2 on missing manifest, not on run-id validation');
  assert.strictEqual(out.stderr.indexOf('PIPELINE_RUN_ID'), -1);
  assert.ok(out.stderr.indexOf('--manifest') !== -1);
});

// ------------------------------------------------- restored original regression coverage
// (re-added from the pre-refactor suite; adapted only where the config API
// moved from env-only to deps.args. None of these assertions was weakened.)

test('runStaging: validateMode accepts only preflight and full', async function() {
  var mod = await loadModule();
  assert.strictEqual(mod.validateMode('preflight').ok, true);
  assert.strictEqual(mod.validateMode('full').ok, true);
  ['', 'FULL', 'preflight ', 'staging', 'prod'].forEach(function(bad) {
    var r = mod.validateMode(bad);
    assert.strictEqual(r.ok, false, 'should reject ' + JSON.stringify(bad));
    assert.ok(r.error.indexOf('PIPELINE_MODE') !== -1, 'error must name the variable');
    if (bad.length > 0) {
      assert.strictEqual(r.error.indexOf(bad), -1, 'error must not echo the value');
    }
  });
});

test('runStaging: generated run ids match the run-id shape', async function() {
  var mod = await loadModule();
  var runIdRe = /^run-[a-z0-9]+-[a-z0-9]+$/;
  var seen = {};
  for (var i = 0; i < 20; i++) {
    var id = mod.generateRunId();
    assert.strictEqual(runIdRe.test(id), true, 'generated id should match shape, got ' + id);
    seen[id] = true;
  }
  assert.ok(Object.keys(seen).length > 1, 'generated ids should vary');
});

test('runStaging: unset mode defaults to preflight and never spawns the pipeline', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('default-preflight', { child: child, healthStatus: 200 });
  deps.args.mode = null;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.mode, 'preflight', 'unset mode must default to preflight');
  assert.strictEqual(result.exitCode, 0, 'healthy preflight-only run should exit 0');
  assert.strictEqual(result.pipelineExit, 0, 'nothing may run the pipeline');
  assert.strictEqual(child.spawnCalls.length, 0, 'pipeline must not be spawned in preflight mode');
});

test('runStaging: preflight passes with a healthy staging (health 200 / shop api ok)', async function() {
  var mod = await loadModule();
  var deps = makeDeps('healthy-restored', { healthStatus: 200 });
  deps.args.mode = 'preflight';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.preflightOk, true);

  var preflightDir = path.join(deps.archiveRoot, deps.runId, 'preflight');
  assert.strictEqual(fs.existsSync(preflightDir), true, 'preflight evidence should be under archive/<runId>/preflight');
  var health = JSON.parse(fs.readFileSync(path.join(preflightDir, 'check-health.json'), 'utf8'));
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.classification, null);
  var preflight = JSON.parse(fs.readFileSync(path.join(preflightDir, 'preflight.json'), 'utf8'));
  assert.ok(Array.isArray(preflight.envVarNames), 'preflight.json should list env var NAMES');
  assert.strictEqual(preflight.envVarNames.indexOf('PIPELINE_STAGING_URL') !== -1, true);
  assert.strictEqual(preflight.envVarNames.indexOf('PIPELINE_ARCHIVE_ROOT') !== -1, true);
  assert.strictEqual(fs.existsSync(path.join(deps.cwd, 'evidence', deps.runId, 'index.json')), false,
    'preflight must not create evidence/<runId>/index.json');
});

test('runStaging: health 500 is a DEPENDENCY_ENVIRONMENT failure and exits non-zero', async function() {
  var mod = await loadModule();
  var deps = makeDeps('healthy500-restored', { healthStatus: 500 });
  deps.args.mode = 'preflight';

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'preflight failure should be non-zero');
  assert.strictEqual(result.preflightOk, false);
  var health = JSON.parse(fs.readFileSync(
    path.join(deps.archiveRoot, deps.runId, 'preflight', 'check-health.json'), 'utf8'));
  assert.strictEqual(health.ok, false);
  assert.strictEqual(health.classification, 'DEPENDENCY_ENVIRONMENT');
  assert.ok(health.detail.indexOf('status=500') !== -1, 'detail should carry exact evidence');
});

test('runStaging: missing admin email makes preflight admin-env-mapping CLIENT_INPUT_SCOPE', async function() {
  var mod = await loadModule();
  var deps = makeDeps('no-email-restored', {});
  deps.args.mode = 'preflight';
  delete deps.env.SUPERADMIN_USERNAME;
  delete deps.env.STAGING_ADMIN_EMAIL;
  delete deps.env.STAGING_ADMIN_PASSWORD;

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'missing admin identity must fail preflight');
  assert.strictEqual(result.preflightOk, false);

  var check = JSON.parse(fs.readFileSync(
    path.join(deps.archiveRoot, deps.runId, 'preflight', 'check-admin-env-mapping.json'), 'utf8'));
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.classification, 'CLIENT_INPUT_SCOPE');
  assert.strictEqual(check.value.usernamePresent, false);
  assert.strictEqual(check.value.usernameProvidedBy, null);
});

test('runStaging: missing staging URL is CLIENT_INPUT_SCOPE', async function() {
  var mod = await loadModule();
  var deps = makeDeps('nostaging-restored', {});
  deps.args.mode = 'preflight';
  deps.args.stagingUrl = null;
  delete deps.env.PIPELINE_STAGING_URL;

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'missing staging URL must fail');
  var health = JSON.parse(fs.readFileSync(
    path.join(deps.archiveRoot, deps.runId, 'preflight', 'check-health.json'), 'utf8'));
  assert.strictEqual(health.ok, false);
  assert.strictEqual(health.classification, 'CLIENT_INPUT_SCOPE');
});

test('runStaging: exit code passthrough (non-zero never becomes 0)', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: { 'task-CAN-B1-03': { status: 7, classification: 'PIPELINE_DEFECT' } } });
  var deps = makeDeps('passthrough-restored', { child: child, taskIds: APPROVED });

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.stages[0].exitCode, 7, 'failed stage exit must be passed through');
  assert.notStrictEqual(result.exitCode, 0, 'non-zero pipeline exit never becomes 0');
  assert.strictEqual(result.anyPipelineDefect, true, 'failed stage is a PIPELINE_DEFECT');
  assert.strictEqual(child.spawnCalls.length, 3, 'others still run after a failure');
});

test('runStaging: preflight never creates or overwrites evidence index.json', async function() {
  var mod = await loadModule();
  var deps = makeDeps('preflightonly-restored', { healthStatus: 200 });
  deps.args.mode = 'preflight';
  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(fs.existsSync(path.join(deps.cwd, 'evidence', deps.runId, 'index.json')), false,
    'preflight must not create index.json under evidence/');
  assert.strictEqual(fs.existsSync(path.join(deps.archiveRoot, deps.runId, 'preflight', 'index.json')), false,
    'preflight evidence folder must not contain index.json');
  assert.strictEqual(fs.existsSync(path.join(deps.archiveRoot, deps.runId, 'preflight', 'preflight.json')), true);
});

test('runStaging: an explicit SUPERADMIN_* value always wins over the workflow mapping', async function() {
  var mod = await loadModule();
  var child = makeChild({ results: {} });
  var deps = makeDeps('superadmin-wins', { child: child, taskIds: APPROVED });
  deps.env.SUPERADMIN_USERNAME = 'boss@example.com';
  deps.env.SUPERADMIN_PASSWORD = 'boss-password';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  var childEnv = child.spawnCalls[0].options.env;
  assert.strictEqual(childEnv.SUPERADMIN_USERNAME, 'boss@example.com', 'explicit value must win');
  assert.strictEqual(childEnv.SUPERADMIN_PASSWORD, 'boss-password', 'explicit value must win');
});

test('runStaging: mapped admin values never appear in any output or evidence file', async function() {
  var mod = await loadModule();
  var email = 'map-email-restored-' + Date.now() + '@example.com';
  var pass = 'map-pass-restored-' + Date.now() + '-secret';
  var child = makeChild({ results: {} });
  var deps = makeDeps('admins-secret-restored', { child: child, taskIds: APPROVED });
  deps.env.SUPERADMIN_USERNAME = email;
  deps.env.SUPERADMIN_PASSWORD = pass;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  var dirs = [
    path.join(deps.cwd, 'evidence', deps.runId),
    path.join(deps.cwd, 'reports', deps.runId),
    path.join(deps.archiveRoot, deps.runId)
  ];
  var files = [];
  dirs.forEach(function(d) { if (fs.existsSync(d)) files = files.concat(listFiles(d)); });
  assert.ok(files.length > 0, 'should have written output files');
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(content.indexOf(email), -1, 'mapped admin email must never appear in ' + files[i]);
    assert.strictEqual(content.indexOf(pass), -1, 'mapped admin password must never appear in ' + files[i]);
  }
});

test('runStaging: invalid PIPELINE_RUN_ID makes bin/pipeline.js exit 2', async function() {
  var out = childProcess.spawnSync(process.execPath,
    ['bin/pipeline.js', 'run', '--manifest', 'manifest/acceptance-manifest.v0.4.json', '--task', 'all'],
    { cwd: process.cwd(), env: Object.assign({}, process.env, { PIPELINE_RUN_ID: '../x' }), encoding: 'utf8' });
  assert.strictEqual(out.status, 2, 'invalid run id should exit 2');
  assert.ok(out.stderr.indexOf('PIPELINE_RUN_ID') !== -1, 'stderr should name the variable');
  assert.ok(out.stderr.indexOf('../x') === -1, 'stderr must not echo the value');
});

