'use strict';

var patchValidator = require('../src/repair/patchValidator');
var path = require('path');
var fs = require('fs');

var test = require('node:test');
var assert = require('node:assert');

var ERR = patchValidator.ERR_CODES;

function makeTempDir() {
  var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pv-test-'));
  return tmpDir;
}

function cleanupTempDir(tmpDir) {
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  } catch (e) { /* ignore */ }
}

function setupStandardFiles(tmpDir) {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line 1\nline 2\nline 3\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', dependencies: {}, devDependencies: {} }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function app() {\n  return true;\n}\n', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'migrations', '001_init.sql'), '-- migration\n', 'utf8');
}

// =============================================================================
// FIX 1: patches/ gating - dependencyPatch=false allows src/patches/x.ts
// (source-edit, config-edit, local-wrapper) but rejects top-level patches/
// =============================================================================

test('patches gating: src/patches/x.ts accepted for source-edit when dependencyPatch=false', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'original\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'add patch file under src/patches',
      edits: [{ path: 'src/x.js', oldString: 'original', newString: 'modified' }],
      newFiles: [{ path: 'src/patches/x.ts', content: 'export const patch = true;\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'src/patches/x.ts newFile must be accepted for source-edit with dependencyPatch=false: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: src/patches/x.ts accepted for local-wrapper when dependencyPatch=false', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'module.exports = function() {}\n', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'add wrapper under src/patches',
      edits: [{ path: 'src/app.js', oldString: 'module.exports', newString: '// wrapped\nmodule.exports' }],
      newFiles: [{ path: 'src/patches/x.ts', content: 'export const wrapper = true;\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'src/patches/x.ts newFile must be accepted for local-wrapper with dependencyPatch=false: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: src/patches/x.ts accepted for config-edit when dependencyPatch=false', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), '{}', 'utf8');
    var editSet = {
      repairKind: 'config-edit',
      rationale: 'add config patch under src/patches',
      edits: [{ path: 'config/settings.json', oldString: '{}', newString: '{"enabled":true}' }],
      newFiles: [{ path: 'src/patches/x.ts', content: 'export const patch = true;\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'src/patches/x.ts newFile must be accepted for config-edit with dependencyPatch=false: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: src/foo/patches/x.ts accepted when dependencyPatch=false', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src', 'foo', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'add nested patch',
      edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
      newFiles: [{ path: 'src/foo/patches/x.ts', content: '// nested patch\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'src/foo/patches/x.ts must be accepted: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: src/nested/deep/patches/x.ts accepted when dependencyPatch=false', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src', 'nested', 'deep', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'add deeply nested patch',
      edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
      newFiles: [{ path: 'src/nested/deep/patches/x.ts', content: '// deep nested patch\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'src/nested/deep/patches/x.ts must be accepted: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: absolute path to src/patches/x.ts normalizes correctly and is accepted', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');
    var absolutePath = path.join(tmpDir, 'src', 'patches', 'x.ts');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'add absolute-path patch',
      edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
      newFiles: [{ path: absolutePath, content: '// absolute patch\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'absolute path to src/patches/x.ts must be accepted and normalized: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: absolute path to top-level patches/ is normalized and rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');
    var absolutePath = path.join(tmpDir, 'patches', 'x.patch');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'absolute patch path',
      edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
      newFiles: [{ path: absolutePath, content: 'diff --git a/x b/x\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, false, 'absolute path to patches/x.patch must be rejected');
    var hasUnavailable = result.errors.some(function(e) { return e.indexOf('[' + ERR.DEPENDENCY_PATCH_UNAVAILABLE + ']') !== -1; });
    assert.ok(hasUnavailable, 'must reject with DEPENDENCY_PATCH_UNAVAILABLE: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: dependencyPatch=true still allows top-level patches/ (regression)', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'normal patch in patches dir',
      edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
      newFiles: [{ path: 'patches/foo.patch', content: 'diff --git a/x b/x\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: true }
    });
    assert.strictEqual(result.ok, true, 'patches/foo.patch must be allowed when dependencyPatch=true: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: src/patches/x.ts is an edit (not newFile) - accepted for source-edit', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'patches', 'existing.ts'), 'export const old = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'edit existing file under src/patches',
      edits: [{ path: 'src/patches/existing.ts', oldString: 'old = 1', newString: 'old = 2' }],
      newFiles: []
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, 'edit under src/patches/ must be accepted: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: top-level patches/ edit rejected with dependencyPatch=false', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'patches', 'foo.patch'), 'original\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'edit top-level patches file',
      edits: [{ path: 'patches/foo.patch', oldString: 'original', newString: 'modified' }],
      newFiles: []
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, false, 'edit under top-level patches/ must be rejected');
    var hasUnavailable = result.errors.some(function(e) { return e.indexOf('[' + ERR.DEPENDENCY_PATCH_UNAVAILABLE + ']') !== -1; });
    assert.ok(hasUnavailable, 'must reject with DEPENDENCY_PATCH_UNAVAILABLE: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Regression: local-wrapper still rejects node_modules, lockfiles, workflows, Dockerfile
test('patches gating regression: local-wrapper edit under node_modules still rejected', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'require("pkg")\n', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'try to edit node_modules',
      edits: [{ path: 'node_modules/pkg/index.js', oldString: '= 1', newString: '= 2' }],
      newFiles: []
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'local-wrapper node_modules edit must be rejected');
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }), 'must have PROPOSAL_IN_NODE_MODULES error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating regression: local-wrapper edit package-lock.json still rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'try to edit lockfile',
      edits: [{ path: 'package-lock.json', oldString: '{}', newString: '{"x":1}' }],
      newFiles: []
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'local-wrapper lockfile edit must be rejected');
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1 || e.indexOf('local-wrapper') !== -1; }), 'must reject lockfile: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating regression: local-wrapper newFile .github/workflows/ci.yml still rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true });
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'try to add workflow',
      edits: [],
      newFiles: [{ path: '.github/workflows/ci.yml', content: 'name: CI\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'local-wrapper workflow newFile must be rejected');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating regression: local-wrapper newFile Dockerfile still rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'app\n', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'try to add Dockerfile',
      edits: [],
      newFiles: [{ path: 'Dockerfile', content: 'FROM node:20\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'local-wrapper Dockerfile newFile must be rejected');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('patches gating: strips leading ./ from path before checking patches/ prefix', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'x.js'), 'x\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'patch with ./ prefix',
      edits: [{ path: 'src/x.js', oldString: 'x', newString: 'y' }],
      newFiles: [{ path: './src/patches/x.ts', content: '// with ./ prefix\n' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, true, './src/patches/x.ts must be accepted (./ stripped before checking): ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});
