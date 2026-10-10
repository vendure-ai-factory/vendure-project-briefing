'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var test = require('node:test');
var assert = require('node:assert');

var TEST_BASE = path.resolve(__dirname, '..', 'runs', 'run-staging-test-' + Date.now());

function freshDir(label) {
  var d = path.join(TEST_BASE, label);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Mimics the pipeline writing ARTIFACTS under the run id it received via the
// PIPELINE_RUN_ID env var (which cli.js honours through deps.runId). This
// makes the archive step realistic: evidence/<runId> and reports/<runId> are
// created by the child under the SAME run id run-staging injected.
function writePipelineArtifacts(options) {
  var cwd = options && options.cwd;
  var runId = options && options.env && options.env.PIPELINE_RUN_ID;
  if (!cwd || !runId) {
    return;
  }
  var evDir = path.join(cwd, 'evidence', runId);
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'index.json'),
    JSON.stringify({ schemaVersion: '1.0', runId: runId, tasks: {} }, null, 2) + '\n', 'utf8');
  var repDir = path.join(cwd, 'reports', runId);
  fs.mkdirSync(repDir, { recursive: true });
  fs.writeFileSync(path.join(repDir, 'run-summary.json'),
    JSON.stringify({ runId: runId }) + '\n', 'utf8');
}

function makeChild(exitStatus) {
  return {
    execCalls: [],
    spawnCalls: [],
    execFileSync: function(cmd, args, options) {
      this.execCalls.push({ cmd: cmd, args: args });
      if (String(cmd) === 'git' && args[0] === 'rev-parse') {
        return 'abc123def456fedcba321\n';
      }
      if (args[0] === 'skills/pipeline-review/review.js') {
        return 'OVERALL: PASS\n';
      }
      throw new Error('unexpected execFileSync ' + String(cmd) + ' ' + (args || []).join(' '));
    },
    spawnSync: function(cmd, args, options) {
      this.spawnCalls.push({ cmd: cmd, args: args, options: options });
      if (exitStatus === null || exitStatus === undefined) {
        return { status: null, stdout: '', stderr: 'spawn boom' };
      }
      writePipelineArtifacts(options);
      return { status: exitStatus, stdout: 'pipeline output line\n', stderr: '' };
    }
  };
}

function makeFetch(healthStatus, shopStatus) {
  healthStatus = healthStatus === undefined ? 200 : healthStatus;
  shopStatus = shopStatus === undefined ? 200 : shopStatus;
  return function(url, options) {
    var u = String(url);
    if (u.indexOf('/api/health') !== -1 || u.endsWith('/health')) {
      return Promise.resolve({
        status: healthStatus,
        json: function() {
          return Promise.resolve(healthStatus === 200 ? { status: 'ok' } : {});
        }
      });
    }
    if (u.indexOf('/shop-api') !== -1 || u.endsWith('/shop-api')) {
      return Promise.resolve({
        status: shopStatus,
        json: function() {
          return Promise.resolve(shopStatus === 200 ? { data: { __typename: 'Query' } } : {});
        }
      });
    }
    return Promise.resolve({ status: 404, json: function() { return Promise.resolve({}); } });
  };
}

function baseEnv(overrides) {
  var env = Object.assign({}, process.env, {
    PIPELINE_ARCHIVE_ROOT: path.join(TEST_BASE, 'archive'),
    PIPELINE_MODE: 'preflight',
    PIPELINE_TASK: 'all',
    PIPELINE_STAGING_URL: 'http://staging.local',
    // Workflow-provided staging admin identity (the mapping source).
    STAGING_ADMIN_EMAIL: 'admin@staging.local',
    STAGING_ADMIN_PASSWORD: 'staging-admin-pw-1'
  }, overrides || {});
  return env;
}

function makeDeps(label, opts) {
  opts = opts || {};
  var cwd = opts.cwd || freshDir(label + '-cwd');
  var archiveRoot = opts.archiveRoot || path.join(cwd, 'archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  var child = opts.child || makeChild(opts.exitStatus === undefined ? 0 : opts.exitStatus);
  var runId = opts.runId || ('stg-' + label + '-' + Date.now());
  var deps = {
    cwd: cwd,
    fs: opts.fs || require('fs'),
    childProcess: child,
    fetch: opts.fetch || makeFetch(opts.healthStatus),
    env: opts.env || baseEnv({ PIPELINE_ARCHIVE_ROOT: archiveRoot }),
    runId: runId,
    nodeVersion: opts.nodeVersion || 'v20.12.2'
  };
  deps.child = child;
  deps.archiveRoot = archiveRoot;
  deps.cwd = cwd;
  deps.runId = runId;
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

function preflightDirOf(deps) {
  return path.join(deps.archiveRoot, deps.runId, 'preflight');
}

var runStagingModule = null;
async function loadModule() {
  if (!runStagingModule) {
    runStagingModule = await import('../pipeline/run-staging.mjs');
  }
  return runStagingModule;
}

test('runStaging: preflight passes with a healthy staging (health 200 / shop api ok)', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('healthy', { healthStatus: 200 });
  deps.env.PIPELINE_MODE = 'preflight';

  var result = await mod.runStaging(deps);

  assert.strictEqual(result.exitCode, 0, 'preflight-only healthy staging should exit 0');
  assert.strictEqual(result.preflightOk, true);

  var preflightDir = preflightDirOf(deps);
  assert.strictEqual(fs.existsSync(preflightDir), true, 'preflight evidence should be under archive/<runId>/preflight');
  var health = JSON.parse(fs.readFileSync(path.join(preflightDir, 'check-health.json'), 'utf8'));
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.classification, null);
  var preflight = JSON.parse(fs.readFileSync(path.join(preflightDir, 'preflight.json'), 'utf8'));
  assert.ok(Array.isArray(preflight.envVarNames), 'preflight.json should list env var NAMES');
  assert.strictEqual(preflight.envVarNames.indexOf('PIPELINE_STAGING_URL') !== -1, true);
  assert.strictEqual(preflight.envVarNames.indexOf('PIPELINE_ARCHIVE_ROOT') !== -1, true);

  // No index.json may be created under evidence/ by preflight.
  assert.strictEqual(fs.existsSync(path.join(deps.cwd, 'evidence', deps.runId, 'index.json')), false,
    'preflight must not create evidence/<runId>/index.json');
});

test('runStaging: health 500 is a DEPENDENCY_ENVIRONMENT failure and exits non-zero', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('healthy500', { healthStatus: 500 });
  deps.env.PIPELINE_MODE = 'preflight';

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'preflight failure should be non-zero');
  assert.strictEqual(result.preflightOk, false);

  var health = JSON.parse(fs.readFileSync(
    path.join(preflightDirOf(deps), 'check-health.json'), 'utf8'));
  assert.strictEqual(health.ok, false);
  assert.strictEqual(health.classification, 'DEPENDENCY_ENVIRONMENT');
  assert.ok(health.detail.indexOf('status=500') !== -1, 'detail should carry exact evidence');
});

test('runStaging: missing archive root fails preflight as DEPENDENCY_ENVIRONMENT', async function(t) {
  var mod = await loadModule();
  var cwd = freshDir('missing-archive-cwd');
  var missingArchive = path.join(cwd, 'does-not-exist-archive');
  var child = makeChild(0);
  var deps = {
    cwd: cwd,
    fs: require('fs'),
    childProcess: child,
    fetch: makeFetch(200),
    env: baseEnv({ PIPELINE_ARCHIVE_ROOT: missingArchive, PIPELINE_MODE: 'preflight' }),
    runId: 'stg-missing-archive',
    nodeVersion: 'v20.12.2'
  };
  deps.archiveRoot = missingArchive;
  deps.runId = 'stg-missing-archive';

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'missing archive root should fail');
  assert.strictEqual(result.preflightOk, false);

  var writable = JSON.parse(fs.readFileSync(
    path.join(preflightDirOf(deps), 'check-archive-writable.json'), 'utf8'));
  assert.strictEqual(writable.ok, false);
  assert.ok(writable.classification === 'DEPENDENCY_ENVIRONMENT' || writable.classification === 'CLIENT_INPUT_SCOPE');
});

test('runStaging: exit code passthrough (non-zero never becomes 0)', async function(t) {
  var mod = await loadModule();
  var child = makeChild(7);
  var deps = makeDeps('passthrough', { child: child });
  deps.env.PIPELINE_MODE = 'full';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.pipelineExit, 7);
  assert.strictEqual(result.exitCode, 7, 'pipeline exit 7 must be passed through');

  assert.strictEqual(child.spawnCalls.length, 1, 'pipeline should be spawned once');
  var call = child.spawnCalls[0];
  assert.deepStrictEqual(call.args, [
    'bin/pipeline.js', 'run', '--manifest', 'manifest/acceptance-manifest.v0.4.json', '--task', 'all'
  ]);
});

test('runStaging: passes the generated run id to the pipeline and reuses it everywhere', async function(t) {
  var mod = await loadModule();
  var child = makeChild(0);
  var deps = makeDeps('runid', { child: child });
  deps.env.PIPELINE_MODE = 'full';

  var result = await mod.runStaging(deps);

  // 1) the child pipeline receives the run id via PIPELINE_RUN_ID env
  assert.strictEqual(child.spawnCalls.length, 1);
  var spawnOpts = child.spawnCalls[0].options;
  assert.strictEqual(spawnOpts.env.PIPELINE_RUN_ID, result.runId,
    'pipeline child env must carry the same run id');
  assert.strictEqual(result.runId, deps.runId);

  // 2) the review is invoked on the same run id
  var reviewCall = child.execCalls.filter(function(c) {
    return c.args && c.args[0] === 'skills/pipeline-review/review.js';
  })[0];
  assert.ok(reviewCall, 'review should be invoked');
  assert.strictEqual(reviewCall.args[1], result.runId, 'review must use the same run id');

  // 3) evidence written by the pipeline (same run id) is archived
  assert.strictEqual(fs.existsSync(path.join(deps.archiveRoot, result.runId, 'evidence', 'index.json')), true,
    'pipeline evidence under the injected run id should be archived');
  var summary = JSON.parse(fs.readFileSync(path.join(deps.archiveRoot, result.runId, 'run.json'), 'utf8'));
  assert.strictEqual(summary.runId, result.runId);
});

test('runStaging: preflight never creates or overwrites evidence index.json', async function(t) {
  var mod = await loadModule();
  // Preflight-only first: no evidence/<runId>/index.json may appear, and
  // preflight files live under archive/<runId>/preflight/.
  var deps = makeDeps('preflightonly', {});
  deps.env.PIPELINE_MODE = 'preflight';
  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(fs.existsSync(path.join(deps.cwd, 'evidence', deps.runId, 'index.json')), false,
    'preflight must not create index.json under evidence/');
  assert.strictEqual(fs.existsSync(path.join(preflightDirOf(deps), 'index.json')), false,
    'preflight evidence folder must not contain index.json');
  assert.strictEqual(fs.existsSync(path.join(preflightDirOf(deps), 'preflight.json')), true);

  // Full mode: the pipeline creates evidence/<runId>/index.json (via the
  // fake child); preflight must not slate over it, and it is archived as-is.
  var child = makeChild(0);
  var deps2 = makeDeps('full-nooverwrite', { child: child });
  deps2.env.PIPELINE_MODE = 'full';
  var result2 = await mod.runStaging(deps2);
  assert.strictEqual(result2.exitCode, 0);
  var evIndex = path.join(deps2.cwd, 'evidence', deps2.runId, 'index.json');
  assert.strictEqual(fs.existsSync(evIndex), true, 'pipeline index.json should exist after full mode');
  var content = JSON.parse(fs.readFileSync(evIndex, 'utf8'));
  assert.strictEqual(content.runId, deps2.runId, 'index.json content must be the pipeline\'s, untouched');
  assert.strictEqual(fs.existsSync(path.join(deps2.archiveRoot, deps2.runId, 'evidence', 'index.json')), true);
});

test('runStaging: exit code 0 passes through and archives evidence + reports + review', async function(t) {
  var mod = await loadModule();
  var child = makeChild(0);
  var deps = makeDeps('full0', { child: child });
  deps.env.PIPELINE_MODE = 'full';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.pipelineExit, 0);

  var archive = path.join(deps.archiveRoot, deps.runId);
  assert.strictEqual(fs.existsSync(path.join(archive, 'evidence', 'index.json')), true,
    'evidence should be archived');
  assert.strictEqual(fs.existsSync(path.join(archive, 'reports', 'run-summary.json')), true,
    'reports should be archived');
  assert.strictEqual(fs.existsSync(path.join(archive, 'preflight', 'preflight.json')), true,
    'preflight should sit under the archive run folder');
  assert.strictEqual(fs.existsSync(path.join(archive, 'logs', 'pipeline.log')), true, 'pipeline log should be in archive');
  assert.strictEqual(fs.existsSync(path.join(archive, 'review.txt')), true, 'review output should be stored next to them');
  var reviewText = fs.readFileSync(path.join(archive, 'review.txt'), 'utf8');
  assert.strictEqual(reviewText.indexOf('OVERALL:') !== -1, true);
  var summary = JSON.parse(fs.readFileSync(path.join(archive, 'run.json'), 'utf8'));
  assert.strictEqual(summary.pipelineExit, 0);
  assert.strictEqual(summary.preflightOk, true);
});

test('runStaging: secret values never appear in any output file', async function(t) {
  var mod = await loadModule();
  var secretValue = 'super-secret-token-0099';
  var child = makeChild(0);
  var deps = makeDeps('secret', { child: child });
  deps.env.PIPELINE_MODE = 'full';
  deps.env.PIPELINE_SECRET_TOKEN = secretValue;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);

  var dirs = [
    path.join(deps.cwd, 'evidence', deps.runId),
    path.join(deps.cwd, 'reports', deps.runId),
    path.join(deps.archiveRoot, deps.runId)
  ];
  var files = [];
  dirs.forEach(function(d) { files = files.concat(listFiles(d)); });
  assert.ok(files.length > 0, 'should have written output files');
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(content.indexOf(secretValue), -1,
      'secret must never appear in ' + files[i]);
  }
});

test('runStaging: maps STAGING_ADMIN_* onto SUPERADMIN_* only on the child env', async function(t) {
  var mod = await loadModule();
  var child = makeChild(0);
  var deps = makeDeps('admins-map', { child: child });
  deps.env.PIPELINE_MODE = 'full';
  delete deps.env.SUPERADMIN_USERNAME;
  delete deps.env.SUPERADMIN_PASSWORD;
  delete deps.env.VENDURE_ADMIN_API_URL;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(child.spawnCalls.length, 1, 'pipeline should be spawned once');

  // 1) mapping happens: child env receives the workflow identity
  var childEnv = child.spawnCalls[0].options.env;
  assert.strictEqual(childEnv.SUPERADMIN_USERNAME, 'admin@staging.local',
    'unset SUPERADMIN_USERNAME should be fed from STAGING_ADMIN_EMAIL');
  assert.strictEqual(childEnv.SUPERADMIN_PASSWORD, 'staging-admin-pw-1',
    'unset SUPERADMIN_PASSWORD should be fed from STAGING_ADMIN_PASSWORD');
  assert.strictEqual(childEnv.VENDURE_ADMIN_API_URL, 'http://staging.local/admin-api',
    'unset VENDURE_ADMIN_API_URL should derive from the staging URL + config admin path');

  // 2) the parent env must not be mutated (CHILD environment only)
  assert.strictEqual(deps.env.SUPERADMIN_USERNAME === undefined, true,
    'parent env SUPERADMIN_USERNAME must stay unset');
  assert.strictEqual(deps.env.SUPERADMIN_PASSWORD === undefined, true,
    'parent env SUPERADMIN_PASSWORD must stay unset');
  assert.strictEqual(deps.env.VENDURE_ADMIN_API_URL === undefined, true,
    'parent env VENDURE_ADMIN_API_URL must stay unset');
});

test('runStaging: an explicit SUPERADMIN_* value always wins over the workflow mapping', async function(t) {
  var mod = await loadModule();
  var child = makeChild(0);
  var deps = makeDeps('admins-explicit', { child: child });
  deps.env.PIPELINE_MODE = 'full';
  deps.env.SUPERADMIN_USERNAME = 'explicit-admin-user';
  deps.env.SUPERADMIN_PASSWORD = 'explicit-admin-pass';
  deps.env.VENDURE_ADMIN_API_URL = 'http://explicit.example/admin-api';

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  var childEnv = child.spawnCalls[0].options.env;
  assert.strictEqual(childEnv.SUPERADMIN_USERNAME, 'explicit-admin-user',
    'explicit SUPERADMIN_USERNAME must win');
  assert.strictEqual(childEnv.SUPERADMIN_PASSWORD, 'explicit-admin-pass',
    'explicit SUPERADMIN_PASSWORD must win');
  assert.strictEqual(childEnv.VENDURE_ADMIN_API_URL, 'http://explicit.example/admin-api',
    'explicit VENDURE_ADMIN_API_URL must win');
});

test('runStaging: mapped admin values never appear in any output or evidence file', async function(t) {
  var mod = await loadModule();
  var email = 'map-email-' + Date.now() + '@example.com';
  var pass = 'map-pass-' + Date.now() + '-secret';
  var child = makeChild(0);
  var deps = makeDeps('admins-secret', { child: child });
  deps.env.PIPELINE_MODE = 'full';
  deps.env.STAGING_ADMIN_EMAIL = email;
  deps.env.STAGING_ADMIN_PASSWORD = pass;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);

  var dirs = [
    path.join(deps.cwd, 'evidence', deps.runId),
    path.join(deps.cwd, 'reports', deps.runId),
    path.join(deps.archiveRoot, deps.runId)
  ];
  var files = [];
  dirs.forEach(function(d) { files = files.concat(listFiles(d)); });
  assert.ok(files.length > 0, 'should have written output files');
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(content.indexOf(email), -1,
      'mapped admin email must never appear in ' + files[i]);
    assert.strictEqual(content.indexOf(pass), -1,
      'mapped admin password must never appear in ' + files[i]);
  }
});

test('runStaging: missing admin email makes preflight admin-env-mapping CLIENT_INPUT_SCOPE', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('no-email', {});
  deps.env.PIPELINE_MODE = 'preflight';
  delete deps.env.SUPERADMIN_USERNAME;
  delete deps.env.STAGING_ADMIN_EMAIL;

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'missing admin identity must fail preflight');
  assert.strictEqual(result.preflightOk, false);

  var check = JSON.parse(fs.readFileSync(
    path.join(preflightDirOf(deps), 'check-admin-env-mapping.json'), 'utf8'));
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.classification, 'CLIENT_INPUT_SCOPE');
  assert.strictEqual(check.value.usernamePresent, false);
  assert.strictEqual(check.value.usernameProvidedBy, null);

  var raw = fs.readFileSync(path.join(preflightDirOf(deps), 'check-admin-env-mapping.json'), 'utf8');
  assert.strictEqual(raw.indexOf('admin@staging.local'), -1, 'email value must not appear in evidence');
  assert.strictEqual(raw.indexOf('staging-admin-pw-1'), -1, 'password value must not appear in evidence');
});

test('runStaging: preflight admin-env-mapping evidence records booleans and names only', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('preflight-admin', {});
  deps.env.PIPELINE_MODE = 'preflight';
  delete deps.env.SUPERADMIN_USERNAME;
  delete deps.env.SUPERADMIN_PASSWORD;

  var result = await mod.runStaging(deps);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.preflightOk, true);

  var check = JSON.parse(fs.readFileSync(
    path.join(preflightDirOf(deps), 'check-admin-env-mapping.json'), 'utf8'));
  assert.strictEqual(check.ok, true);
  assert.strictEqual(check.classification, null);
  assert.strictEqual(check.value.usernamePresent, false);
  assert.strictEqual(check.value.usernameProvidedBy, 'STAGING_ADMIN_EMAIL');
  assert.strictEqual(check.value.passwordPresent, false);
  assert.strictEqual(check.value.passwordProvidedBy, 'STAGING_ADMIN_PASSWORD');
  assert.strictEqual(check.value.adminApiUrlPresent, false);
  assert.strictEqual(check.value.adminApiUrlProvidedBy, 'derived-from-staging-url');
});

test('runStaging: missing staging URL is CLIENT_INPUT_SCOPE', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('nostaging', {});
  delete deps.env.PIPELINE_STAGING_URL;
  deps.env.PIPELINE_MODE = 'preflight';

  var result = await mod.runStaging(deps);
  assert.notStrictEqual(result.exitCode, 0, 'missing staging URL must fail');
  var health = JSON.parse(fs.readFileSync(
    path.join(preflightDirOf(deps), 'check-health.json'), 'utf8'));
  assert.strictEqual(health.ok, false);
  assert.strictEqual(health.classification, 'CLIENT_INPUT_SCOPE');
});

test('runStaging: generated run ids match the run-id shape', async function(t) {
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

test('runStaging: unset PIPELINE_MODE defaults to preflight and never spawns the pipeline', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('default-preflight', { healthStatus: 200 });
  delete deps.env.PIPELINE_MODE;   // simulate a bare `node pipeline/run-staging.mjs`

  var result = await mod.runStaging(deps);

  assert.strictEqual(result.mode, 'preflight', 'unset mode must default to preflight');
  assert.strictEqual(result.exitCode, 0, 'healthy preflight-only run should exit 0');
  assert.strictEqual(result.pipelineExit, null, 'nothing may run the pipeline');
  assert.strictEqual(deps.child.spawnCalls.length, 0, 'pipeline must not be spawned in preflight mode');
});

test('runStaging: full mode requires explicit PIPELINE_MODE=full', async function(t) {
  var mod = await loadModule();
  // Same setup with the mode unset: no spawn.
  var deps = makeDeps('full-explicit-unset', { child: makeChild(0) });
  delete deps.env.PIPELINE_MODE;
  var resDefault = await mod.runStaging(deps);
  assert.strictEqual(resDefault.mode, 'preflight');
  assert.strictEqual(resDefault.exitCode, 0);
  assert.strictEqual(deps.child.spawnCalls.length, 0, 'default must not spawn');

  // Explicit full configuration: the pipeline is spawned.
  var deps2 = makeDeps('full-explicit-set', { child: makeChild(0) });
  deps2.env.PIPELINE_MODE = 'full';
  var resFull = await mod.runStaging(deps2);
  assert.strictEqual(resFull.mode, 'full');
  assert.strictEqual(resFull.exitCode, 0);
  assert.strictEqual(deps2.child.spawnCalls.length, 1, 'explicit full must spawn the pipeline');
});

test('runStaging: invalid PIPELINE_MODE fails safely without spawning', async function(t) {
  var mod = await loadModule();
  var deps = makeDeps('invalid-mode');
  deps.env.PIPELINE_MODE = 'staging';   // not a valid mode value

  var result = await mod.runStaging(deps);

  assert.strictEqual(typeof mod.INVALID_MODE_EXIT, 'number');
  assert.strictEqual(result.invalidMode, true);
  assert.strictEqual(result.mode, 'staging');
  assert.strictEqual(result.exitCode, mod.INVALID_MODE_EXIT);
  assert.strictEqual(result.pipelineExit, null);
  assert.strictEqual(result.preflightOk, false);
  assert.strictEqual(deps.child.spawnCalls.length, 0, 'invalid mode must not spawn');
  assert.strictEqual(fs.existsSync(path.join(deps.archiveRoot, deps.runId, 'preflight')), false,
    'invalid mode must not write preflight evidence');
});

test('runStaging: validateMode accepts only preflight and full', async function(t) {
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

test('bin/pipeline.js: validateRunId forwards valid ids and rejects invalid ones', async function(t) {
  var pipeline = require('../bin/pipeline.js');
  assert.strictEqual(typeof pipeline.validateRunId, 'function');

  var valid = pipeline.validateRunId('run-abc1-2def');
  assert.strictEqual(valid.ok, true, 'valid id should be accepted');
  assert.strictEqual(valid.runId, 'run-abc1-2def', 'valid id must be forwarded');

  ['../x', 'run-ABC-1', ''].forEach(function(bad) {
    var result = pipeline.validateRunId(bad);
    assert.strictEqual(result.ok, false, 'should reject ' + JSON.stringify(bad));
    assert.strictEqual(result.runId, null);
    assert.ok(result.error.indexOf('PIPELINE_RUN_ID') !== -1, 'error must name the variable, not its value');
    if (bad.length > 0) {
      assert.strictEqual(result.error.indexOf(bad), -1, 'error must never contain the value');
    }
  });

  // Undefined (unset) is allowed so direct pipeline runs keep their default.
  var unset = pipeline.validateRunId(undefined);
  assert.strictEqual(unset.ok, true);
  assert.strictEqual(unset.runId, undefined);
});

test('runStaging: invalid PIPELINE_RUN_ID makes bin/pipeline.js exit 2', async function(t) {
  var child = childProcess.spawnSync(process.execPath,
    ['bin/pipeline.js', 'run', '--manifest', 'manifest/acceptance-manifest.v0.4.json', '--task', 'all'],
    { cwd: process.cwd(), env: Object.assign({}, process.env, { PIPELINE_RUN_ID: '../x' }), encoding: 'utf8' });
  assert.strictEqual(child.status, 2, 'invalid run id should exit 2');
  assert.ok(child.stderr.indexOf('PIPELINE_RUN_ID') !== -1, 'stderr should name the variable');
  assert.ok(child.stderr.indexOf('../x') === -1, 'stderr must not echo the value');
});

test('runStaging: a valid PIPELINE_RUN_ID passes validation and reaches the CLI', async function(t) {
  var child = childProcess.spawnSync(process.execPath,
    ['bin/pipeline.js', 'run', '--task', 'all'],
    { cwd: process.cwd(), env: Object.assign({}, process.env, { PIPELINE_RUN_ID: 'run-abc1-2def' }), encoding: 'utf8' });
  // It must get past run-id validation to arg parsing (Missing --manifest),
  // not fail with the run-id error.
  assert.strictEqual(child.status, 2, 'still exits 2 from the CLI, not validation');
  assert.ok(child.stderr.indexOf('PIPELINE_RUN_ID') === -1, 'run-id must have passed validation');
  assert.ok(child.stderr.indexOf('--manifest') !== -1, 'CLI should complain about the missing manifest');
});
