'use strict';

var patchApplier = require('../src/repair/patchApplier');
var patchValidator = require('../src/repair/patchValidator');
var path = require('path');
var fs = require('fs');

var test = require('node:test');
var assert = require('node:assert');

var ERR = patchApplier.ERR_CODES;

// Helper to create isolated temp dir
function makeTempDir() {
  var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pa-test-'));
  return tmpDir;
}

// Helper to cleanup temp dir
function cleanupTempDir(tmpDir) {
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  } catch (e) {
  }
}

// Helper to setup standard test files
function setupStandardFiles(tmpDir) {
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line 1\nline 2\nline 3\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', dependencies: {}, devDependencies: {} }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function app() {\n  return true;\n}\n', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'migrations', '001_init.sql'), '-- migration\n', 'utf8');
}

// Helper to make fake runCommand
function makeFakeRunCommand(success, stdout, stderr, exitCode) {
  return function(cmd, args, opts) {
    return {
      stdout: stdout || '',
      stderr: stderr || '',
      exitCode: exitCode !== undefined ? exitCode : (success ? 0 : 1)
    };
  };
}

// =============================================================================
// SOURCE-EDIT
// =============================================================================

test('apply: source-edit applies changes', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test fix',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true, 'should apply successfully');
    assert.deepStrictEqual(result.filesChanged, ['test.txt']);
    var content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8');
    assert.ok(content.includes('line 2 modified'));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: multiple edits across files', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [
        { path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' },
        { path: 'src/app.js', oldString: 'return true', newString: 'return false' }
      ]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.filesChanged.length, 2);
    var testContent = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8');
    var appContent = fs.readFileSync(path.join(tmpDir, 'src', 'app.js'), 'utf8');
    assert.ok(testContent.includes('line 2 modified'));
    assert.ok(appContent.includes('return false'));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: creates new file when specified', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }],
      newFiles: [{ path: 'newfile.txt', content: 'new file content\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'newfile.txt')));
    var content = fs.readFileSync(path.join(tmpDir, 'newfile.txt'), 'utf8');
    assert.strictEqual(content, 'new file content\n');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: returns diff stats for changed files', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    assert.ok(result.diffStats['test.txt']);
    assert.ok(result.diffStats['test.txt'].diff.includes('-line 2'));
    assert.ok(result.diffStats['test.txt'].diff.includes('+line 2 modified'));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: unchanged files not in filesChanged', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'unchanged.txt'), 'unchanged content\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [
        { path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' },
        { path: 'unchanged.txt', oldString: 'unchanged content', newString: 'unchanged content' }
      ]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.filesChanged.length, 1);
    assert.strictEqual(result.filesChanged[0], 'test.txt');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: creates parent directories for new files', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }],
      newFiles: [{ path: 'deep/nested/path/file.txt', content: 'nested content\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'deep/nested/path/file.txt')));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: exact string replacement', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'exact.txt'), 'START\nold content\nEND\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'exact.txt', oldString: 'old content', newString: 'new content' }]
    };
    var result = patchApplier.applySourceEdit(editSet, tmpDir);
    assert.strictEqual(result.ok, true);
    var content = fs.readFileSync(path.join(tmpDir, 'exact.txt'), 'utf8');
    assert.strictEqual(content, 'START\nnew content\nEND\n');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: blocker when oldString not found', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'nonexistent', newString: 'modified' }]
    };
    var result = patchApplier.applySourceEdit(editSet, tmpDir);
    assert.strictEqual(result.ok, false);
    assert.ok(result.blocker);
    assert.strictEqual(result.blocker.code, ERR.APPLY_FAILED);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// CONFIG-EDIT
// =============================================================================

test('apply: config-edit works same as source-edit', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'config-edit',
      rationale: 'config fix',
      edits: [{ path: 'test.txt', oldString: 'line 3', newString: 'line 3 modified' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    var content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8');
    assert.ok(content.includes('line 3 modified'));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// MIGRATION
// =============================================================================

test('apply: migration applies to migration files', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'migration',
      rationale: 'fix migration',
      edits: [{ path: 'migrations/001_init.sql', oldString: '-- migration', newString: '-- modified migration' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    var content = fs.readFileSync(path.join(tmpDir, 'migrations', '001_init.sql'), 'utf8');
    assert.ok(content.includes('modified migration'));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// LOCAL-WRAPPER
// =============================================================================

test('apply: local-wrapper allows new files', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'wrapper script',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }],
      newFiles: [{ path: 'wrapper.sh', content: '#!/bin/bash\necho hello\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'wrapper.sh')));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// DEPENDENCY-BUMP
// =============================================================================

test('apply: dependency-bump modifies package.json and runs install', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: { foo: '1.0.0' }, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    var newPkg = { name: 'test', version: '1.0.0', dependencies: { foo: '2.0.0' }, devDependencies: {} };
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'bump foo',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg, null, 2), newString: JSON.stringify(newPkg, null, 2) }]
    };
    var fakeRunCommand = makeFakeRunCommand(true, 'success', '', 0);
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: fakeRunCommand });
    assert.strictEqual(result.ok, true, 'should succeed');
    var content = fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8');
    assert.ok(content.includes('2.0.0'));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-bump fails install returns INSTALL_FAILED', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: { foo: '1.0.0' }, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    var newPkg = { name: 'test', version: '1.0.0', dependencies: { foo: '2.0.0' }, devDependencies: {} };
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'bump foo',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg, null, 2), newString: JSON.stringify(newPkg, null, 2) }]
    };
    var fakeRunCommand = makeFakeRunCommand(false, '', 'npm error', 1);
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: fakeRunCommand });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blocker);
    assert.strictEqual(result.blocker.code, 'LOCKFILE_REGEN_FAILED');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-bump only allows package.json and lockfile', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'src', 'foo.js'), 'module.exports = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [{ path: 'src/foo.js', oldString: 'module.exports = 1;', newString: 'module.exports = 2;' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blocker);
    // Validation catches it first with DEP_BUMP_NOT_PACKAGE -> VALIDATION_FAILED
    assert.strictEqual(result.blocker.code, 'VALIDATION_FAILED');
    assert.ok(result.blocker.evidence.errors.some(function(e) { return e.includes('[DEP_BUMP_NOT_PACKAGE]'); }));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// DEPENDENCY-PATCH
// =============================================================================

test('apply: dependency-patch blocked when Dockerfile lacks install script', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nCOPY . .\n', 'utf8');
    // dependency-patch only allows newFiles, not edits - no edits here
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'patch foo',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blocker);
    assert.strictEqual(result.blocker.code, ERR.DEP_PATCH_NOT_APPLIED_IN_IMAGE);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch succeeds when Dockerfile has install', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\nCOPY . .\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    // dependency-patch only allows newFiles, not edits
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'patch foo',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: function() { return { exitCode: 0 }; } });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js')));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch creates patches file', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\nCOPY . .\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }), 'utf8');
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'patch foo',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 2;\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: function() { return { exitCode: 0 }; } });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'patches', 'foo+1.0.0.patch')), 'should create patch file');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch adds patch-package to package.json', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\nCOPY . .\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'patch foo',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: function() { return { exitCode: 0 }; } });
    assert.strictEqual(result.ok, true);
    var pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
    assert.ok(pkg.devDependencies['patch-package'], 'should add patch-package');
    assert.ok(pkg.scripts.postinstall.includes('patch-package'), 'should add postinstall script');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch requires Dockerfile', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'patched' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch rejects non-node_modules/patches paths', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\n', 'utf8');
    // dependency-patch validation rejects non-node_modules/patches paths -> VALIDATION_FAILED
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'src/app.js', content: 'new content' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blocker);
    assert.strictEqual(result.blocker.code, 'VALIDATION_FAILED');
    assert.ok(result.blocker.evidence.errors.some(function(e) { return e.includes('[DEP_PATCH_NO_NODE_MODULES]'); }));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch edits node_modules file and creates patch', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\nCOPY . .\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'fixturepkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'package.json'), JSON.stringify({ name: 'fixturepkg', version: '1.2.3' }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'index.js'), 'module.exports = "bug line";\n', 'utf8');

    var recordedCalls = [];
    var fakeRunCommand = function(cmd, args, opts) {
      recordedCalls.push({ cmd: cmd, args: args, opts: opts });
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'fix bug in fixturepkg',
      edits: [{ path: 'node_modules/fixturepkg/index.js', oldString: 'module.exports = "bug line";', newString: 'module.exports = "fixed";' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: fakeRunCommand });
    assert.strictEqual(result.ok, true, 'apply should succeed');

    // (a) file is changed
    var fileContent = fs.readFileSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'index.js'), 'utf8');
    assert.ok(fileContent.includes('module.exports = "fixed";'), 'file should contain fixed line');
    assert.ok(!fileContent.includes('bug line'), 'file should not contain bug line');

    // (b) patches/fixturepkg+1.2.3.patch exists and contains both removed and added line
    var patchPath = path.join(tmpDir, 'patches', 'fixturepkg+1.2.3.patch');
    assert.ok(fs.existsSync(patchPath), 'patch file should exist');
    var patchContent = fs.readFileSync(patchPath, 'utf8');
    assert.ok(patchContent.includes('module.exports = "bug line";'), 'patch should contain removed line');
    assert.ok(patchContent.includes('module.exports = "fixed";'), 'patch should contain added line');

    // (c) package.json has patch-package and postinstall
    var pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
    assert.ok(pkg.devDependencies['patch-package'], 'package.json should have patch-package');
    assert.ok(pkg.scripts.postinstall && pkg.scripts.postinstall.includes('patch-package'), 'package.json should have postinstall script');

    // (d) runCommand recorded clean-install check with shell:false
    var installCalls = recordedCalls.filter(function(c) { return c.cmd === 'npm'; });
    assert.ok(installCalls.length > 0, 'should have recorded npm install call');
    installCalls.forEach(function(call) {
      assert.strictEqual(call.opts.shell, false, 'npm call should use shell:false');
    });

    // (e) the patched line is "seen" (file contains new content)
    var patchedFile = fs.readFileSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'index.js'), 'utf8');
    assert.strictEqual(patchedFile.indexOf('module.exports = "fixed";') >= 0, true, 'patched line should be visible');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: dependency-patch atomicity when clean-install fails', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\nCOPY . .\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'fixturepkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'package.json'), JSON.stringify({ name: 'fixturepkg', version: '1.2.3' }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'index.js'), 'module.exports = "bug line";\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'fixturepkg', 'node_modules'), { recursive: true });

    // Hash all files before apply
    function hashDir(dir) {
      var hashes = {};
      var entries = fs.readdirSync(dir, { recursive: true });
      entries.forEach(function(entry) {
        try {
          var fullPath = path.join(dir, entry);
          if (fs.statSync(fullPath).isFile()) {
            hashes[entry] = fs.readFileSync(fullPath);
          }
        } catch (e) {}
      });
      return hashes;
    }
    var beforeHashes = hashDir(tmpDir);

    var fakeRunCommand = function(cmd, args, opts) {
      return { stdout: '', stderr: 'npm ERR!', exitCode: 1 };  // simulate npm ci failure
    };

    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'fix bug',
      edits: [{ path: 'node_modules/fixturepkg/index.js', oldString: 'module.exports = "bug line";', newString: 'module.exports = "fixed";' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: fakeRunCommand });

    // blocker returned
    assert.strictEqual(result.ok, false, 'apply should fail');
    assert.ok(result.blocker, 'should have blocker');
    assert.strictEqual(result.blocker.code, ERR.INSTALL_FAILED);

    // (b) every file byte-identical to before (compare hashes)
    var afterHashes = hashDir(tmpDir);
    var allIdentical = true;
    var allKeys = Object.keys(beforeHashes);
    allKeys.forEach(function(k) {
      if (afterHashes[k] && beforeHashes[k].equals(afterHashes[k])) return;
      allIdentical = false;
    });
    Object.keys(afterHashes).forEach(function(k) {
      if (beforeHashes[k] && afterHashes[k].equals(beforeHashes[k])) return;
      allIdentical = false;
    });
    assert.strictEqual(allIdentical, true, 'all files should be byte-identical to before');

    // patches/ does not exist
    assert.ok(!fs.existsSync(path.join(tmpDir, 'patches')), 'patches/ should not exist');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: runCommand only receives allowlisted executables with shell:false', function() {
  var tmpDir = makeTempDir();
  var allCalls = [];
  var allowlist = { npm: true, yarn: true, pnpm: true, 'patch-package': true };

  function recordingFake(cmd, args, opts) {
    allCalls.push({ cmd: cmd, args: args, opts: opts });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  try {
    // dependency-bump (runs npm ci)
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: { foo: '1.0.0' }, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg), 'utf8');
    var newPkg = { name: 'test', version: '1.0.0', dependencies: { foo: '2.0.0' }, devDependencies: {} };
    patchApplier.apply({
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg), newString: JSON.stringify(newPkg) }]
    }, { cloneDir: tmpDir, runCommand: recordingFake });

    // source-edit (no runCommand)
    var editSet2 = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    patchApplier.apply(editSet2, { cloneDir: tmpDir, runCommand: recordingFake });

    // dependency-patch (runs npm ci)
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nRUN npm ci\nCOPY . .\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;\n', 'utf8');
    patchApplier.apply({
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 2;\n' }]
    }, { cloneDir: tmpDir, runCommand: recordingFake });

    // Now assert
    assert.ok(allCalls.length > 0, 'should have recorded some runCommand calls');
    allCalls.forEach(function(call, i) {
      assert.strictEqual(allowlist[call.cmd], true, 'call ' + i + ' cmd should be allowlisted: ' + call.cmd);
      assert.strictEqual(call.opts.shell, false, 'call ' + i + ' should use shell:false');
    });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// ATOMICITY
// =============================================================================

test('apply: atomic restore after failure - all files byte-identical to before', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    // Save original contents
    var origTestTxt = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8');
    var origAppJs = fs.readFileSync(path.join(tmpDir, 'src', 'app.js'), 'utf8');
    // First edit succeeds
    // Second edit fails (oldString not found after first edit modifies file)
    // But we need a case where edit 2 fails - let's use an invalid edit
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [
        { path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' },
        { path: 'src', oldString: 'invalid', newString: 'also invalid' }  // path is a directory, not valid
      ]
    };
    // This should fail and restore
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    // Now verify files are restored
    var afterTestTxt = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8');
    var afterAppJs = fs.readFileSync(path.join(tmpDir, 'src', 'app.js'), 'utf8');
    assert.strictEqual(afterTestTxt, origTestTxt, 'test.txt should be restored to original');
    assert.strictEqual(afterAppJs, origAppJs, 'src/app.js should be unchanged');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

test('apply: missing cloneDir returns INVALID_ARGS', function() {
  var editSet = {
    repairKind: 'source-edit',
    rationale: 'test',
    edits: [{ path: 'test.txt', oldString: 'old', newString: 'new' }]
  };
  var result = patchApplier.apply(editSet, { cloneDir: null });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, ERR.INVALID_ARGS);
});

test('apply: nonexistent cloneDir returns CLONE_NOT_FOUND', function() {
  var editSet = {
    repairKind: 'source-edit',
    rationale: 'test',
    edits: [{ path: 'test.txt', oldString: 'old', newString: 'new' }]
  };
  var result = patchApplier.apply(editSet, { cloneDir: '/nonexistent/path' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, ERR.CLONE_NOT_FOUND);
});

test('apply: invalid repairKind returns VALIDATION_FAILED', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'invalid-kind',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'modified' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocker.code, ERR.VALIDATION_FAILED);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: oldString not found returns blocker', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'nonexistent', newString: 'modified' }]
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blocker);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('apply: unknown repairKind returns VALIDATION_FAILED', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'unknown-type',
      rationale: 'test',
      edits: []
    };
    var result = patchApplier.apply(editSet, { cloneDir: tmpDir });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocker.code, ERR.VALIDATION_FAILED);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// COMMAND ALLOWLIST
// =============================================================================

test('apply: only allowed commands can run - npm/yarn/pnpm/patch-package', function() {
  // Verify ALLOWED_COMMANDS only contains expected commands
  var allowed = patchApplier.ALLOWED_COMMANDS;
  assert.strictEqual(allowed['npm'], true);
  assert.strictEqual(allowed['yarn'], true);
  assert.strictEqual(allowed['pnpm'], true);
  assert.strictEqual(allowed['patch-package'], true);
  assert.strictEqual(Object.keys(allowed).length, 4, 'only 4 allowed commands');
});

test('apply: runInstall uses correct argv (shell:false)', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: {}, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg), 'utf8');
    var newPkg = { name: 'test', version: '1.0.0', dependencies: { foo: '2.0.0' }, devDependencies: {} };
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'bump',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg), newString: JSON.stringify(newPkg) }]
    };
    var recordedCalls = [];
    var fakeRunCommand = function(cmd, args, opts) {
      recordedCalls.push({ cmd: cmd, args: args, opts: opts });
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    patchApplier.apply(editSet, { cloneDir: tmpDir, runCommand: fakeRunCommand });
    assert.strictEqual(recordedCalls.length, 2);
    assert.strictEqual(recordedCalls[0].cmd, 'npm');
    assert.deepStrictEqual(recordedCalls[0].args, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.strictEqual(recordedCalls[1].cmd, 'npm');
    assert.deepStrictEqual(recordedCalls[1].args, ['ci', '--dry-run']);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// EXPORTED VALUES
// =============================================================================

test('apply: DEFAULT_TIMEOUT_MS is set correctly', function() {
  assert.strictEqual(patchApplier.DEFAULT_TIMEOUT_MS, 120000);
});

test('apply: ERR_CODES contains expected error codes', function() {
  var expectedCodes = [
    'INVALID_ARGS',
    'CLONE_NOT_FOUND',
    'VALIDATION_FAILED',
    'APPLY_FAILED',
    'DIR_CREATE_FAILED',
    'FILE_EXISTS',
    'WRITE_FAILED',
    'READ_FAILED',
    'INVALID_FILE',
    'INSTALL_FAILED',
    'DEP_PATCH_NOT_APPLIED_IN_IMAGE',
    'INVALID_PATH',
    'UNKNOWN_REPAIR_KIND',
    'COMMAND_INJECTION',
    'COMMAND_INJECTION',
    'LOCKFILE_REGEN_FAILED',
    'LOCKFILE_OUT_OF_SYNC',
    'RESTORE_FAILED'
  ];
  expectedCodes.forEach(function(code) {
    assert.ok(ERR[code], code + ' should be defined');
  });
});
