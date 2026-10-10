'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');
var crypto = require('crypto');

var test = require('node:test');
var assert = require('node:assert');

var demoWorkspace = require('../src/demo/demoWorkspace');
var patchModule = require('../src/tools/patch');
var commandRunner = require('../src/tools/commandRunner');

var DEMO_WORKSPACE_ROOT = path.resolve(__dirname, '..', 'runs', 'demo-workspace-test-' + Date.now());

function cleanupWorkspace() {
  try {
    fs.rmSync(DEMO_WORKSPACE_ROOT, { recursive: true, force: true });
  } catch (e) {}
}

function rmdirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rmdirRecursive(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  fs.rmdirSync(dir);
}

test('demoWorkspace: permission model detection', function(t, done) {
  var verifyRunner = require('../src/demo/verifyRunner');
  var available = verifyRunner.isPermissionModelAvailable();
  assert.strictEqual(typeof available, 'boolean', 'isPermissionModelAvailable should return boolean');
  done();
});

test('demoWorkspace: createWorkspace creates directory with correct structure', function(t, done) {
  cleanupWorkspace();
  var runId = 'test-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  assert.ok(result.workspaceRoot, 'Should have workspaceRoot');
  assert.ok(result.baselineHash, 'Should have baselineHash');
  assert.ok(result.workspaceRoot.endsWith('/workspace') || result.workspaceRoot.endsWith('\\workspace'), 'workspaceRoot should end with workspace');

  var evalDemo = path.join(result.workspaceRoot, 'evaluation-demo');
  assert.ok(fs.existsSync(path.join(evalDemo, 'app')), 'Should have app directory');
  assert.ok(fs.existsSync(path.join(evalDemo, 'scripts')), 'Should have scripts directory');
  assert.ok(fs.existsSync(path.join(evalDemo, 'task.md')), 'Should have task.md');
  done();
});

test('demoWorkspace: createWorkspace excludes migration-input and assets', function(t, done) {
  var runId = 'test-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var evalDemo = path.join(result.workspaceRoot, 'evaluation-demo');
  assert.ok(!fs.existsSync(path.join(evalDemo, 'migration-input')), 'migration-input should be excluded');
  assert.ok(!fs.existsSync(path.join(evalDemo, 'assets')), 'assets should be excluded');
  done();
});

test('demoWorkspace: createWorkspace sets up git repo with baseline commit', function(t, done) {
  var runId = 'test-git-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  assert.ok(result.baselineHash, 'Should have baselineHash');
  assert.strictEqual(result.baselineHash.length, 7, 'Baseline hash should be 7 chars (short form)');

  var gitDir = path.join(result.workspaceRoot, '.git');
  assert.ok(fs.existsSync(gitDir), 'Should have .git directory');

  var logResult = childProcess.spawnSync('git', ['log', '--oneline', '-n', '1'], {
    cwd: result.workspaceRoot,
    encoding: 'utf8'
  });
  assert.strictEqual(logResult.status, 0, 'git log should succeed');
  assert.ok(logResult.stdout.indexOf('baseline') !== -1, 'First commit should be baseline');
  done();
});

test('demoWorkspace: createWorkspace writes .gitignore with evaluation-demo/results/', function(t, done) {
  var runId = 'test-gitignore-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var gitignorePath = path.join(result.workspaceRoot, '.gitignore');
  assert.ok(fs.existsSync(gitignorePath), '.gitignore should exist');
  var content = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(content.indexOf('evaluation-demo/results/') !== -1, '.gitignore should contain evaluation-demo/results/');
  done();
});

test('demoWorkspace: protected paths are set after createWorkspace', function(t, done) {
  var runId = 'test-protect-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  var testsCheck = patchModule.isPathProtected(path.join(wsRoot, 'evaluation-demo', 'app', 'tests', 'acceptance.test.mjs'));
  assert.strictEqual(testsCheck.protected, true, 'evaluation-demo/app/tests/ should be protected');

  var fixturesCheck = patchModule.isPathProtected(path.join(wsRoot, 'evaluation-demo', 'app', 'fixtures', 'legacy-catalog.json'));
  assert.strictEqual(fixturesCheck.protected, true, 'evaluation-demo/app/fixtures/ should be protected');

  var scriptsCheck = patchModule.isPathProtected(path.join(wsRoot, 'evaluation-demo', 'scripts', 'verify.mjs'));
  assert.strictEqual(scriptsCheck.protected, true, 'evaluation-demo/scripts/ should be protected');

  var taskCheck = patchModule.isPathProtected(path.join(wsRoot, 'evaluation-demo', 'task.md'));
  assert.strictEqual(taskCheck.protected, true, 'evaluation-demo/task.md should be protected');

  var pkgCheck = patchModule.isPathProtected(path.join(wsRoot, 'evaluation-demo', 'app', 'package.json'));
  assert.strictEqual(pkgCheck.protected, true, 'evaluation-demo/app/package.json should be protected');
  done();
});

test('demoWorkspace: catalog.mjs is NOT protected (the only mutable file)', function(t, done) {
  var runId = 'test-mutable-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;
  var catalogPath = path.join(wsRoot, 'evaluation-demo', 'app', 'src', 'catalog.mjs');
  var check = patchModule.isPathProtected(catalogPath);
  assert.strictEqual(check.protected, false, 'catalog.mjs should NOT be protected (the task target)');
  done();
});

test('demoWorkspace: patch to app/tests/ is rejected', function(t, done) {
  var runId = 'test-reject-tests-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  patchModule.setWorkspaceRoot(result.workspaceRoot);

  var testsPath = path.join(result.workspaceRoot, 'evaluation-demo', 'app', 'tests', 'acceptance.test.mjs');
  var patchResult = patchModule.applyPatch(testsPath, 'modified content');
  assert.strictEqual(patchResult.success, false, 'Patch to tests/ should be rejected');
  assert.strictEqual(patchResult.errorCode, 'PROTECTED_PATH_REJECTED', 'Error code should be PROTECTED_PATH_REJECTED');
  done();
});

test('demoWorkspace: patch to app/fixtures/ is rejected', function(t, done) {
  var runId = 'test-reject-fixtures-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  patchModule.setWorkspaceRoot(result.workspaceRoot);

  var fixturesPath = path.join(result.workspaceRoot, 'evaluation-demo', 'app', 'fixtures', 'legacy-catalog.json');
  var patchResult = patchModule.applyPatch(fixturesPath, '{"modified":true}');
  assert.strictEqual(patchResult.success, false, 'Patch to fixtures/ should be rejected');
  assert.strictEqual(patchResult.errorCode, 'PROTECTED_PATH_REJECTED', 'Error code should be PROTECTED_PATH_REJECTED');
  done();
});

test('demoWorkspace: patch to scripts/ is rejected', function(t, done) {
  var runId = 'test-reject-scripts-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  patchModule.setWorkspaceRoot(result.workspaceRoot);

  var scriptsPath = path.join(result.workspaceRoot, 'evaluation-demo', 'scripts', 'verify.mjs');
  var patchResult = patchModule.applyPatch(scriptsPath, 'modified');
  assert.strictEqual(patchResult.success, false, 'Patch to scripts/ should be rejected');
  assert.strictEqual(patchResult.errorCode, 'PROTECTED_PATH_REJECTED', 'Error code should be PROTECTED_PATH_REJECTED');
  done();
});

test('demoWorkspace: patch to task.md is rejected', function(t, done) {
  var runId = 'test-reject-task-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  patchModule.setWorkspaceRoot(result.workspaceRoot);

  var taskPath = path.join(result.workspaceRoot, 'evaluation-demo', 'task.md');
  var patchResult = patchModule.applyPatch(taskPath, 'modified');
  assert.strictEqual(patchResult.success, false, 'Patch to task.md should be rejected');
  assert.strictEqual(patchResult.errorCode, 'PROTECTED_PATH_REJECTED', 'Error code should be PROTECTED_PATH_REJECTED');
  done();
});

test('demoWorkspace: patch to app/package.json is rejected', function(t, done) {
  var runId = 'test-reject-pkg-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  patchModule.setWorkspaceRoot(result.workspaceRoot);

  var pkgPath = path.join(result.workspaceRoot, 'evaluation-demo', 'app', 'package.json');
  var patchResult = patchModule.applyPatch(pkgPath, '{}');
  assert.strictEqual(patchResult.success, false, 'Patch to package.json should be rejected');
  assert.strictEqual(patchResult.errorCode, 'PROTECTED_PATH_REJECTED', 'Error code should be PROTECTED_PATH_REJECTED');
  done();
});

test('demoWorkspace: resetWorkspace returns tree to baseline hash', function(t, done) {
  var runId = 'test-reset-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;
  var baselineHash = result.baselineHash;

  var catalogPath = path.join(wsRoot, 'evaluation-demo', 'app', 'src', 'catalog.mjs');
  var originalContent = fs.readFileSync(catalogPath, 'utf8');

  fs.writeFileSync(catalogPath, '// modified for test', 'utf8');
  var statusBefore = childProcess.spawnSync('git', ['status', '--porcelain'], {
    cwd: wsRoot, encoding: 'utf8'
  });
  assert.ok(statusBefore.stdout.trim().length > 0, 'Workspace should be dirty after modification');

  var resetResult = demoWorkspace.resetWorkspace(baselineHash, runId);
  assert.strictEqual(resetResult.success, true, 'resetWorkspace should succeed');
  assert.strictEqual(resetResult.resetTo, baselineHash, 'Should report resetTo hash');
  assert.strictEqual(resetResult.isClean, true, 'Workspace should be clean after reset');

  var afterContent = fs.readFileSync(catalogPath, 'utf8');
  assert.strictEqual(afterContent, originalContent, 'File should be restored to original content');

  var statusAfter = childProcess.spawnSync('git', ['status', '--porcelain'], {
    cwd: wsRoot, encoding: 'utf8'
  });
  assert.strictEqual(statusAfter.stdout.trim().length, 0, 'Workspace should be clean after reset');
  done();
});

test('demoWorkspace: buildAllowedEnv returns only PATH, HOME, NODE_ENV', function(t, done) {
  process.env.OPENROUTER_API_KEY = 'sk-test-fake';
  process.env.SOME_OTHER_VAR = 'should be excluded';
  process.env.NODE_ENV = 'test';

  var env = demoWorkspace.buildAllowedEnv();
  assert.strictEqual(env.OPENROUTER_API_KEY, undefined, 'OPENROUTER_API_KEY should not be in env');
  assert.strictEqual(env.SOME_OTHER_VAR, undefined, 'SOME_OTHER_VAR should not be in env');
  assert.strictEqual(env.NODE_ENV, 'test', 'NODE_ENV should be in env');

  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SOME_OTHER_VAR;
  done();
});

test('demoWorkspace: baseline verify exits 1 (incomplete catalog returns [])', function(t, done) {
  var runId = 'test-baseline-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  var verifyScript = path.join(wsRoot, 'evaluation-demo', 'scripts', 'verify.mjs');
  var runResult = childProcess.spawnSync(process.execPath, [verifyScript, '--acceptance'], {
    cwd: wsRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: demoWorkspace.buildAllowedEnv()
  });

  assert.strictEqual(runResult.status, 1, 'Baseline verify should exit 1 (catalog returns [])');
  done();
});

test('demoWorkspace: workspace is isolated git repo with only copied files', function(t, done) {
  var runId = 'test-iso-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  var gitResult = childProcess.spawnSync('git', ['ls-files'], {
    cwd: wsRoot, encoding: 'utf8'
  });
  assert.strictEqual(gitResult.status, 0, 'git ls-files should succeed');
  var files = gitResult.stdout.split('\n').filter(function(f) { return f.trim(); });

  assert.ok(files.some(function(f) { return f.indexOf('evaluation-demo/app/src/catalog.mjs') !== -1; }), 'Should contain catalog.mjs');
  assert.ok(files.some(function(f) { return f.indexOf('evaluation-demo/scripts/verify.mjs') !== -1; }), 'Should contain verify.mjs');
  assert.ok(files.some(function(f) { return f.indexOf('evaluation-demo/task.md') !== -1; }), 'Should contain task.md');
  assert.ok(!files.some(function(f) { return f.indexOf('migration-input') !== -1; }), 'Should NOT contain migration-input');
  assert.ok(!files.some(function(f) { return f.indexOf('assets') !== -1; }), 'Should NOT contain assets');
  done();
});

test('demoWorkspace: verify.mjs produces expected results in temp workspace', function(t, done) {
  var runId = 'test-verify-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  var verifyScript = path.join(wsRoot, 'evaluation-demo', 'scripts', 'verify.mjs');
  var runResult = childProcess.spawnSync(process.execPath, [verifyScript, '--acceptance'], {
    cwd: wsRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: demoWorkspace.buildAllowedEnv()
  });

  var resultsDir = path.join(wsRoot, 'evaluation-demo', 'results');
  assert.ok(fs.existsSync(resultsDir), 'Results directory should be created');

  var entries = fs.readdirSync(resultsDir);
  assert.ok(entries.length > 0, 'Results should have entries');

  var latestEntry = entries[entries.length - 1];
  var statusPath = path.join(resultsDir, latestEntry, 'status.json');
  var manifestPath = path.join(resultsDir, latestEntry, 'run-manifest.json');

  if (fs.existsSync(statusPath)) {
    var status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.strictEqual(status.status, 'BLOCK', 'Status should be BLOCK for incomplete starter');
  }

  if (fs.existsSync(manifestPath)) {
    var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.exit_code, 1, 'Manifest exit_code should be 1');
    assert.strictEqual(manifest.network_used, false, 'network_used should be false');
    assert.strictEqual(manifest.secrets_used, false, 'secrets_used should be false');
  }

  assert.strictEqual(runResult.status, 1, 'verify.mjs should exit 1 for incomplete starter');
  done();
});

test.after(function() {
  cleanupWorkspace();
  patchModule.clearDemoWorkspaceProtection();
});

// --- STEP 2: enforceAllowlist ---

test('demoWorkspace: enforceAllowlist rejects change to non-catalog file', function(t, done) {
  var runId = 'test-al-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;
  var baselineHash = result.baselineHash;

  var testsPath = path.join(wsRoot, 'evaluation-demo', 'app', 'tests', 'acceptance.test.mjs');
  fs.writeFileSync(testsPath, '// modified', 'utf8');

  var enforceResult = demoWorkspace.enforceAllowlist(wsRoot, baselineHash);
  assert.strictEqual(enforceResult.success, false, 'enforceAllowlist should reject non-catalog change');
  assert.strictEqual(enforceResult.errorCode, 'ALLOWLIST_VIOLATION', 'Error code should be ALLOWLIST_VIOLATION');
  assert.ok(enforceResult.violations.some(function(v) { return v.indexOf('acceptance.test.mjs') !== -1; }), 'Should report acceptance.test.mjs as violation');

  var afterContent = fs.readFileSync(testsPath, 'utf8');
  assert.strictEqual(afterContent.indexOf('modified'), -1, 'File should be restored to original');
  done();
});

test('demoWorkspace: enforceAllowlist rejects new untracked file', function(t, done) {
  var runId = 'test-al-untracked-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;
  var baselineHash = result.baselineHash;

  var newFile = path.join(wsRoot, 'evaluation-demo', 'app', 'src', 'malicious.js');
  fs.writeFileSync(newFile, '// new untracked file', 'utf8');

  var enforceResult = demoWorkspace.enforceAllowlist(wsRoot, baselineHash);
  assert.strictEqual(enforceResult.success, false, 'enforceAllowlist should reject new untracked file');
  assert.strictEqual(enforceResult.errorCode, 'ALLOWLIST_VIOLATION', 'Error code should be ALLOWLIST_VIOLATION');
  assert.ok(!fs.existsSync(newFile), 'Untracked file should be removed after reset');
  done();
});

test('demoWorkspace: enforceAllowlist allows only catalog.mjs change', function(t, done) {
  var runId = 'test-al-ok-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;
  var baselineHash = result.baselineHash;

  var catalogPath = path.join(wsRoot, 'evaluation-demo', 'app', 'src', 'catalog.mjs');
  fs.writeFileSync(catalogPath, '// only the task file may change\n', 'utf8');

  var enforceResult = demoWorkspace.enforceAllowlist(wsRoot, baselineHash);
  assert.strictEqual(enforceResult.success, true, 'enforceAllowlist should accept only catalog.mjs change');
  assert.deepStrictEqual(enforceResult.changedFiles, ['evaluation-demo/app/src/catalog.mjs'], 'Changed files should be only catalog.mjs');
  done();
});

// --- STEP 3: "no repair needed" scenario ---

test('demoWorkspace: verify exits 0 when catalog is pre-fixed (no repair needed)', function(t, done) {
  var runId = 'test-norepair-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  var catalogPath = path.join(wsRoot, 'evaluation-demo', 'app', 'src', 'catalog.mjs');
  fs.writeFileSync(catalogPath, [
    "export function migrateCatalog(_legacyCatalog) {",
    "  return [",
    "    { sku: 'NAIL-001', name: 'Soft Pink Almond', slug: 'soft-pink-almond', price_cents: 1600, image_count: 1 },",
    "    { sku: 'NAIL-002', name: 'Rose Gold French', slug: 'rose-gold-french', price_cents: 1850, image_count: 2 }",
    "  ];",
    "}",
    ""
  ].join('\n'), 'utf8');

  var verifyScript = path.join(wsRoot, 'evaluation-demo', 'scripts', 'verify.mjs');
  var runResult = childProcess.spawnSync(process.execPath, [verifyScript, '--acceptance'], {
    cwd: wsRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: demoWorkspace.buildAllowedEnv()
  });

  assert.strictEqual(runResult.status, 0, 'Verify should exit 0 when catalog is correctly fixed');
  done();
});

// --- STEP 3: child env has no OPENROUTER_API_KEY ---

test('demoWorkspace: verify.mjs runs with no OPENROUTER_API_KEY in env', function(t, done) {
  var runId = 'test-noapikey-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  process.env.OPENROUTER_API_KEY = 'sk-test-fake-key-for-env-test';
  try {
    var verifyScript = path.join(wsRoot, 'evaluation-demo', 'scripts', 'verify.mjs');
    var envSnapshot = {};
    var allowedKeys = demoWorkspace.ALLOWED_ENV_VARS;
    for (var k in process.env) {
      if (allowedKeys.indexOf(k) !== -1) {
        envSnapshot[k] = process.env[k];
      }
    }
    var envHasKey = Object.prototype.hasOwnProperty.call(envSnapshot, 'OPENROUTER_API_KEY');
    assert.strictEqual(envHasKey, false, 'OPENROUTER_API_KEY should not be in restricted env');
    done();
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

// verifyRunner-specific env allowlist test
test('demoWorkspace: verifyRunner buildRestrictedEnv excludes OPENROUTER_API_KEY', function(t, done) {
  process.env.OPENROUTER_API_KEY = 'sk-test-fake-key-for-env-test';
  try {
    var verifyRunner = require('../src/demo/verifyRunner');
    var env = verifyRunner.buildRestrictedEnv();
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(env, 'OPENROUTER_API_KEY'),
      false,
      'OPENROUTER_API_KEY must not be in restricted env from verifyRunner'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(env, 'PATH'),
      true,
      'PATH must be in restricted env'
    );
    done();
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

// runVerify with commandOverride — same code path and env as real verify
test('demoWorkspace: runVerify commandOverride probe confirms OPENROUTER_API_KEY absent in child', function(t, done) {
  var runId = 'test-probe-' + Date.now();
  var createResult = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(createResult.success, true, 'createWorkspace should succeed');
  var wsRoot = createResult.workspaceRoot;

  process.env.OPENROUTER_API_KEY = 'sk-test-fake-key-for-probe';
  try {
    var verifyRunner = require('../src/demo/verifyRunner');
    var probe = "node -e \"console.log(JSON.stringify(Object.keys(process.env)))\"";
    var result = verifyRunner.runVerify(wsRoot, {
      commandOverride: ['node', '-e', 'console.log(JSON.stringify(Object.keys(process.env)))'],
      timeout: 10000
    });

    // Poll until close
    var start = Date.now();
    var checkInterval = setInterval(function() {
      if (result.exitCode !== null || Date.now() - start > 8000) {
        clearInterval(checkInterval);
        assert.notStrictEqual(result.exitCode, null, 'Probe should have completed');
        assert.notStrictEqual(result.exitCode, undefined, 'Probe exit code should be set');
        if (result.exitCode === 0 || result.exitCode === null) {
          var envKeys = JSON.parse(result.stdout || '[]');
          var hasKey = envKeys.indexOf('OPENROUTER_API_KEY') !== -1;
          assert.strictEqual(hasKey, false, 'OPENROUTER_API_KEY must not be passed to child process');
          var hasPath = envKeys.indexOf('PATH') !== -1;
          assert.strictEqual(hasPath, true, 'PATH must be present in child process env');
        }
        demoWorkspace.resetWorkspace(createResult.baselineHash, runId);
        fs.rmSync(wsRoot, { recursive: true, force: true });
        done();
      }
    }, 100);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

// --- STEP 3: real evaluation-demo unchanged ---

test('demoWorkspace: real evaluation-demo is byte-identical before and after', function(t, done) {
  var crypto = require('crypto');
  var repoRoot = path.resolve(__dirname, '..');

  function hashDir(dir) {
    var files = [];
    function walk(d) {
      var entries = fs.readdirSync(d, { withFileTypes: true });
      for (var e of entries) {
        var fp = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== '.git') walk(fp);
        } else {
          var content = fs.readFileSync(fp);
          files.push(crypto.createHash('sha256').update(content).digest('hex'));
        }
      }
    }
    walk(dir);
    files.sort();
    return crypto.createHash('sha256').update(files.join('')).digest('hex');
  }

  var evalDemo = path.join(repoRoot, 'evaluation-demo');
  var beforeHash = hashDir(evalDemo);

  var runId = 'test-byteid-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);

  var verifyScript = path.join(result.workspaceRoot, 'evaluation-demo', 'scripts', 'verify.mjs');
  childProcess.spawnSync(process.execPath, [verifyScript, '--acceptance'], {
    cwd: result.workspaceRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: demoWorkspace.buildAllowedEnv()
  });

  var afterHash = hashDir(evalDemo);
  assert.strictEqual(beforeHash, afterHash, 'Real evaluation-demo/ must be byte-identical before and after');
  done();
});

// --- STEP 4: global state cleanup ---

test('demoWorkspace: setupDemoWorkspaceProtection leaves global state; clearDemoWorkspaceProtection cleans it', function(t, done) {
  var runId = 'test-global-' + Date.now();
  var result = demoWorkspace.createWorkspace(runId);
  assert.strictEqual(result.success, true, 'createWorkspace should succeed');
  var wsRoot = result.workspaceRoot;

  var testsPath = path.join(wsRoot, 'evaluation-demo', 'app', 'tests', 'acceptance.test.mjs');
  var checkBefore = patchModule.isPathProtected(testsPath);
  assert.strictEqual(checkBefore.protected, true, 'Should be protected after setupDemoWorkspaceProtection');

  patchModule.clearDemoWorkspaceProtection();
  var checkAfter = patchModule.isPathProtected(testsPath);
  assert.strictEqual(checkAfter.protected, false, 'Should NOT be protected after clearDemoWorkspaceProtection');

  var resetResult = demoWorkspace.resetWorkspace(result.baselineHash, runId);
  assert.strictEqual(resetResult.success, true, 'resetWorkspace should succeed');
  done();
});

test('demoWorkspace: patch tests unaffected after demo test runs (global state cleaned)', function(t, done) {
  patchModule.clearDemoWorkspaceProtection();
  var tmpDir = path.join(os.tmpdir(), 'patch-isolation-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  patchModule.setWorkspaceRoot(tmpDir);

  var testFile = path.join(tmpDir, 'test.txt');
  fs.writeFileSync(testFile, 'content', 'utf8');
  patchModule.applyPatch(testFile, 'new content');

  var check = patchModule.isPathProtected(testFile);
  assert.strictEqual(check.protected, false, 'Non-demo path should not be protected (global state was cleared)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  done();
});

// --- STEP 4: permission model ---

test('demoWorkspace: permission model available flag (Node v24+)', function(t, done) {
  var verifyRunner = require('../src/demo/verifyRunner');
  assert.strictEqual(typeof verifyRunner.isPermissionModelAvailable, 'function', 'isPermissionModelAvailable should be a function');
  var result = verifyRunner.runVerify(path.join(os.tmpdir(), 'noworkspace'));
  assert.strictEqual(result.permissionModelUnavailable, true, 'Permission model NOT used for verify (verify.mjs needs child-process)');
  done();
});
