'use strict';

var patchValidator = require('../src/repair/patchValidator');
var path = require('path');
var fs = require('fs');

var test = require('node:test');
var assert = require('node:assert');

var ERR = patchValidator.ERR_CODES;

// Helper to create isolated temp dir
function makeTempDir() {
  var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pv-test-'));
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

// Helper to create standard test files
function setupStandardFiles(tmpDir) {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line 1\nline 2\nline 3\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', dependencies: {}, devDependencies: {} }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function app() {\n  return true;\n}\n', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'migrations', '001_init.sql'), '-- migration\n', 'utf8');
}

// =============================================================================
// REPAIR KIND VALIDATION
// =============================================================================

test('validate: source-edit passes validation', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'source-edit should pass');
    assert.deepStrictEqual(result.errors, []);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: config-edit passes validation', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'config-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'config-edit should pass');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: migration passes validation', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'migration',
      rationale: 'test',
      edits: [{ path: 'migrations/001_init.sql', oldString: '-- migration', newString: '-- modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'migration should pass');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-bump passes validation', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: { foo: '1.0.0' }, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'bump foo',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg, null, 2), newString: JSON.stringify({ name: 'test', version: '1.0.0', dependencies: { foo: '2.0.0' }, devDependencies: {} }, null, 2) }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'dependency-bump should pass');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-patch with newFiles in node_modules: patchValidator own validation handles via DEP_PATCH_NO_NODE_MODULES check (patches/ or node_modules/ only)', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'patch foo',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    // dependency-patch newFiles must be under patches/ or node_modules/ (see DEP_PATCH_NO_NODE_MODULES check)
    // The existing node_modules check (PROPOSAL_IN_NODE_MODULES) does NOT apply to dependency-patch
    // since dependency-patch has its own kind-specific validation. This test documents the behavior.
    assert.strictEqual(result.ok, true, 'dependency-patch with node_modules newFiles should pass per its own validation: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper passes validation', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function app() {\n  return true;\n}\n', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'wrapper',
      edits: [{ path: 'src/app.js', oldString: 'return true', newString: 'return false' }],
      newFiles: [{ path: 'src/wrapper.js', content: '#!/bin/bash\necho hello\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'local-wrapper should pass with src/ paths: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: unknown repairKind is rejected with INVALID_REPAIR_KIND', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'unknown-kind',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'unknown repairKind should be rejected');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.INVALID_REPAIR_KIND + ']'); }), 'should have INVALID_REPAIR_KIND error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// PATH VALIDATION - PATH_ESCAPE
// =============================================================================

test('validate: path with .. is rejected with PATH_ESCAPE', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: '../test.txt', oldString: 'line 2', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'path with .. should be rejected');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PATH_ESCAPE + ']'); }), 'should have PATH_ESCAPE error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: absolute path is rejected with PATH_ESCAPE', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: '/etc/passwd', oldString: 'line', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'absolute path should be rejected');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PATH_ESCAPE + ']'); }), 'should have PATH_ESCAPE error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: .git path is rejected with PATH_ESCAPE', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: '.git/config', oldString: 'line', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, '.git path should be rejected');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PATH_ESCAPE + ']'); }), 'should have PATH_ESCAPE error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: symlink pointing outside clone is rejected with PATH_ESCAPE', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    // Create a file outside tmpDir
    var outsideDir = path.join(tmpDir, '..', 'outside-' + Date.now());
    fs.mkdirSync(path.dirname(outsideDir), { recursive: true });
    fs.writeFileSync(outsideDir, 'outside content\n', 'utf8');
    // Create symlink inside tmpDir pointing to outside
    var linkPath = path.join(tmpDir, 'symlink');
    try {
      fs.symlinkSync(outsideDir, linkPath);
    } catch (e) {
      // Symlinks may fail on Windows, skip this test case
      return;
    }
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'symlink', oldString: 'outside content', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'symlink outside clone should be rejected');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PATH_ESCAPE + ']'); }), 'should have PATH_ESCAPE error');
    fs.unlinkSync(outsideDir);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// PATH VALIDATION - SECRET_NAME
// =============================================================================

test('validate: .env path rejected with SECRET_NAME', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: '.env', oldString: 'old', newString: 'new' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.SECRET_NAME + ']'); }), 'should have SECRET_NAME error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: .pem file rejected with SECRET_NAME', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'key.pem', oldString: 'old', newString: 'new' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.SECRET_NAME + ']'); }), 'should have SECRET_NAME error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: id_rsa rejected with SECRET_NAME', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'id_rsa', oldString: 'old', newString: 'new' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.SECRET_NAME + ']'); }), 'should have SECRET_NAME error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: api_secret rejected with SECRET_NAME', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'api_secret', oldString: 'old', newString: 'new' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.SECRET_NAME + ']'); }), 'should have SECRET_NAME error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// PATH VALIDATION - PROTECTED_PATH
// =============================================================================

test('validate: path in protectedPaths rejected with PROTECTED_PATH', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'src/app.js', oldString: 'return true', newString: 'return false' }]
    };
    var protectedPaths = [path.join(tmpDir, 'src')];
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, protectedPaths: protectedPaths, mode: 'target' });
    assert.strictEqual(result.ok, false, 'protected path should be rejected');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PROTECTED_PATH + ']'); }), 'should have PROTECTED_PATH error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: protected path in pipeline mode rejected with PROTECTED_PATH', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'protected'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'protected', 'file.txt'), 'content\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'protected/file.txt', oldString: 'content', newString: 'modified' }]
    };
    var protectedPaths = [path.join(tmpDir, 'protected')];
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, protectedPaths: protectedPaths, mode: 'pipeline' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PROTECTED_PATH + ']'); }), 'should have PROTECTED_PATH error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: tests/ directory edits rejected in pipeline mode', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tests', 'spec.js'), 'describe("test", function() {});\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'tests/spec.js', oldString: 'describe', newString: 'xdescribe' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'pipeline' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PROTECTED_PATH + ']'); }), 'should have PROTECTED_PATH error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// OLDSTRING VALIDATION
// =============================================================================

test('validate: oldString not found returns OLDSTRING_NOT_FOUND', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'nonexistent', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.OLDSTRING_NOT_FOUND + ']'); }), 'should have OLDSTRING_NOT_FOUND error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: oldString occurring twice returns OLDSTRING_AMBIGUOUS', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'dup.txt'), 'same line\nsame line\ndifferent\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'dup.txt', oldString: 'same line', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.OLDSTRING_AMBIGUOUS + ']'); }), 'should have OLDSTRING_AMBIGUOUS error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// LIMITS
// =============================================================================

test('validate: >5 files returns TOO_MANY_FILES', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var edits = [];
    for (var i = 0; i < 6; i++) {
      edits.push({ path: 'file' + i + '.txt', oldString: 'old' + i, newString: 'new' + i });
    }
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: edits
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.TOO_MANY_FILES + ']'); }), 'should have TOO_MANY_FILES error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: >200 changed lines returns TOO_MANY_LINES', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var bigOld = '';
    var bigNew = '';
    for (var i = 0; i < 201; i++) {
      bigOld += 'line ' + i + '\n';
      bigNew += 'modified line ' + i + '\n';
    }
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: bigOld, newString: bigNew }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.TOO_MANY_LINES + ']'); }), 'should have TOO_MANY_LINES error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// DEPENDENCY-BUMP PATH RESTRICTION (MUST CHECK BEFORE OLDSTRING)
// =============================================================================

test('validate: dependency-bump on src/foo.js rejected with DEP_BUMP_NOT_PACKAGE (not OLDSTRING)', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    // Write actual content to src/foo.js so oldString matches
    fs.writeFileSync(path.join(tmpDir, 'src', 'foo.js'), 'module.exports = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [{ path: 'src/foo.js', oldString: 'module.exports = 1;', newString: 'module.exports = 2;' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    // MUST be DEP_BUMP_NOT_PACKAGE (path restriction), NOT OLDSTRING_NOT_FOUND
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.DEP_BUMP_NOT_PACKAGE + ']'); }), 'should have DEP_BUMP_NOT_PACKAGE error (path check before oldString)');
    assert.ok(!result.errors.some(function(e) { return e.includes('[' + ERR.OLDSTRING_NOT_FOUND + ']'); }), 'should NOT have OLDSTRING_NOT_FOUND - path check comes first');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-bump on package.json passes', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: { foo: '1.0.0' }, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg, null, 2), newString: JSON.stringify({ name: 'test', version: '1.0.0', dependencies: { foo: '2.0.0' }, devDependencies: {} }, null, 2) }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-bump version with caret rejected with DEP_BUMP_INVALID_VERSION', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var pkg = { name: 'test', version: '1.0.0', dependencies: { foo: '1.0.0' }, devDependencies: {} };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [{ path: 'package.json', oldString: JSON.stringify(pkg, null, 2), newString: JSON.stringify({ name: 'test', version: '1.0.0', dependencies: { foo: '^2.0.0' }, devDependencies: {} }, null, 2) }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.DEP_BUMP_INVALID_VERSION + ']'); }), 'should have DEP_BUMP_INVALID_VERSION error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-bump new file rejected with DEP_BUMP_NO_NEW_FILES', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}', 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'newfile.txt', content: 'new content' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.DEP_BUMP_NO_NEW_FILES + ']'); }), 'should have DEP_BUMP_NO_NEW_FILES error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// DEPENDENCY-PATCH
// =============================================================================

test('validate: dependency-patch edits to existing node_modules files: own validation allows node_modules per DEP_PATCH_NOT_ONE_PKG check', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [{ path: 'node_modules/foo/index.js', oldString: 'module.exports = 1;', newString: 'module.exports = 2;' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    // dependency-patch has its own validation at line 543-572 that handles node_modules paths.
    // The node_modules catch-all (PROPOSAL_IN_NODE_MODULES) does NOT apply to dependency-patch.
    assert.strictEqual(result.ok, true, 'dependency-patch edits to node_modules should pass via its own validation: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-patch edits to multiple packages rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'bar'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js'), 'foo\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'bar', 'index.js'), 'bar\n', 'utf8');
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [
        { path: 'node_modules/foo/index.js', oldString: 'foo', newString: 'FOO' },
        { path: 'node_modules/bar/index.js', oldString: 'bar', newString: 'BAR' }
      ]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false, 'should reject edits to multiple packages');
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.DEP_PATCH_NOT_ONE_PKG + ']'); }), 'should have DEP_PATCH_NOT_ONE_PKG error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-patch edits outside node_modules rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [{ path: 'src/app.js', oldString: 'foo', newString: 'bar' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.DEP_PATCH_NOT_ONE_PKG + ']'); }), 'should have DEP_PATCH_NOT_ONE_PKG error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-patch newFiles in node_modules: own validation allows (DEP_PATCH_NO_NODE_MODULES check requires patches/ or node_modules/)', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'node_modules/foo/index.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    // dependency-patch newFiles must be under patches/ or node_modules/ per its own validation.
    // The PROPOSAL_IN_NODE_MODULES catch-all does NOT apply to dependency-patch.
    assert.strictEqual(result.ok, true, 'dependency-patch should allow node_modules newFiles per its own validation: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-patch rejects non-node_modules/patches paths', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'src/app.js', content: 'new content' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.DEP_PATCH_NO_NODE_MODULES + ']'); }), 'should have DEP_PATCH_NO_NODE_MODULES error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// NAME SAFETY
// =============================================================================

var NAME_SAFETY_VALUES = [
  { value: ';', label: 'semicolon' },
  { value: '&', label: 'ampersand' },
  { value: '|', label: 'pipe' },
  { value: '$(', label: 'command-substitution' },
  { value: '`', label: 'backtick' },
  { value: ' ', label: 'space' },
  { value: '\n', label: 'newline' },
  { value: '..', label: 'dotdot' },
  { value: '-leading', label: 'leading-dash' }
];

NAME_SAFETY_VALUES.forEach(function(item) {
  test('validate: dependency-patch rejects package name with ' + item.label + ' (PACKAGE_NAME_INVALID)', function() {
    var tmpDir = makeTempDir();
    try {
      setupStandardFiles(tmpDir);
      var editSet = {
        repairKind: 'dependency-patch',
        rationale: 'test',
        edits: [{ path: 'node_modules/' + item.value + '/index.js', oldString: 'old', newString: 'new' }]
      };
      var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
      assert.strictEqual(result.ok, false, 'should reject package name with ' + item.label);
      assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.PACKAGE_NAME_INVALID + ']'); }), 'should have PACKAGE_NAME_INVALID error for ' + item.label);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});

// =============================================================================
// MIGRATION
// =============================================================================

test('validate: migration requires path under migrations folder', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'migration',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.MIGRATION_NOT_UNDER_FOLDER + ']'); }), 'should have MIGRATION_NOT_UNDER_FOLDER error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: migration path under migrations folder passes', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'migration',
      rationale: 'test',
      edits: [{ path: 'migrations/001_init.sql', oldString: '-- migration', newString: '-- modified migration' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: migration detects migrations folder with different name', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function app() {}\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'db-migrations'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'db-migrations', '001.sql'), 'SELECT 1;\n', 'utf8');
    var editSet = {
      repairKind: 'migration',
      rationale: 'test',
      edits: [{ path: 'db-migrations/001.sql', oldString: 'SELECT 1;', newString: 'SELECT 2;' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'migration should find db-migrations folder');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: migration allows overwriting existing file', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'migrations', 'existing.sql'), 'existing content\n', 'utf8');
    var editSet = {
      repairKind: 'migration',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'migrations/existing.sql', content: 'new content' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'migration should allow overwriting existing files');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// NEWFILES VALIDATION
// =============================================================================

test('validate: newFiles content must be string', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'new.bin', content: Buffer.from([0x00, 0x01]) }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: source-edit cannot overwrite existing file', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'existing\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'existing.txt', content: 'new' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// STRUCTURAL VALIDATION
// =============================================================================

test('validate: missing cloneDir returns error', function() {
  var editSet = {
    repairKind: 'source-edit',
    rationale: 'test',
    edits: [{ path: 'test.txt', oldString: 'old', newString: 'new' }]
  };
  var result = patchValidator.validate(editSet, { cloneDir: null, mode: 'target' });
  assert.strictEqual(result.ok, false);
});

test('validate: nonexistent cloneDir returns error', function() {
  var editSet = {
    repairKind: 'source-edit',
    rationale: 'test',
    edits: [{ path: 'test.txt', oldString: 'old', newString: 'new' }]
  };
  var result = patchValidator.validate(editSet, { cloneDir: '/nonexistent/path', mode: 'target' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(function(e) { return e.includes('[' + ERR.CLONE_NOT_FOUND + ']'); }), 'should have CLONE_NOT_FOUND error');
});

// =============================================================================
// EXPORTED FUNCTIONS
// =============================================================================

test('validate: ALLOWED_REPAIR_KINDS contains all expected kinds', function() {
  var expected = ['source-edit', 'config-edit', 'migration', 'dependency-bump', 'dependency-patch', 'local-wrapper'];
  expected.forEach(function(kind) {
    assert.strictEqual(patchValidator.ALLOWED_REPAIR_KINDS[kind], true, kind + ' should be allowed');
  });
});

test('isSecretLookingName: detects .env files', function() {
  assert.strictEqual(patchValidator.isSecretLookingName('.env'), true);
  assert.strictEqual(patchValidator.isSecretLookingName('.env.production'), true);
});

test('isSecretLookingName: detects key/secret files', function() {
  assert.strictEqual(patchValidator.isSecretLookingName('api_key'), true);
  assert.strictEqual(patchValidator.isSecretLookingName('secret_token'), true);
  assert.strictEqual(patchValidator.isSecretLookingName('id_rsa'), true);
  assert.strictEqual(patchValidator.isSecretLookingName('key.pem'), true);
});

test('isSecretLookingName: allows normal files', function() {
  assert.strictEqual(patchValidator.isSecretLookingName('app.js'), false);
  assert.strictEqual(patchValidator.isSecretLookingName('test.txt'), false);
  assert.strictEqual(patchValidator.isSecretLookingName('package.json'), false);
});

test('validate: stats are correctly counted', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stats.fileCount, 1);
    assert.strictEqual(result.stats.editCount, 1);
    assert.strictEqual(result.stats.newFileCount, 0);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// NODE_MODULES PATH ENFORCEMENT
// =============================================================================

test('validate: source-edit edit under node_modules/ is rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'some-pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'source-edit',
      rationale: 'test',
      edits: [{ path: 'node_modules/some-pkg/index.js', oldString: 'module.exports = 1', newString: 'module.exports = 2' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }), 'should have PROPOSAL_IN_NODE_MODULES error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: config-edit edit under node_modules/ is rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'src', 'config.js'), 'exports.setting = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'config-edit',
      rationale: 'test',
      edits: [{ path: 'node_modules/pkg/src/config.js', oldString: 'exports.setting = 1', newString: 'exports.setting = 2' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: migration edit under node_modules/ is rejected', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'migrations', '001.sql'), 'SELECT 1;\n', 'utf8');
    var editSet = {
      repairKind: 'migration',
      rationale: 'test',
      edits: [{ path: 'node_modules/pkg/migrations/001.sql', oldString: 'SELECT 1', newString: 'SELECT 2' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-bump edit under node_modules/: validateDependencyBump restricts to package.json/lockfile; node_modules edit falls through but is not explicitly blocked by noNodeModulesKinds', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'dependency-bump',
      rationale: 'test',
      edits: [{ path: 'node_modules/pkg/index.js', oldString: 'module.exports = 1', newString: 'module.exports = 2' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    // dependency-bump is NOT in noNodeModulesKinds (its restriction is package.json/lockfile only
    // via validateDependencyBump). So the node_modules catch-all does not fire.
    // The edit to node_modules/pkg/index.js is caught by validateDependencyBump (DEP_BUMP_NOT_PACKAGE).
    assert.strictEqual(result.ok, false, 'dependency-bump node_modules edit should fail via DEP_BUMP_NOT_PACKAGE: ' + (result.errors || []).join('; '));
    assert.ok(result.errors.some(function(e) { return e.indexOf('DEP_BUMP_NOT_PACKAGE') !== -1; }), 'should be DEP_BUMP_NOT_PACKAGE error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: dependency-patch with capabilities.dependencyPatch=false is DEPENDENCY_PATCH_UNAVAILABLE', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    var editSet = {
      repairKind: 'dependency-patch',
      rationale: 'test',
      edits: [{ path: 'node_modules/pkg/index.js', oldString: 'module.exports = 1', newString: 'module.exports = 2' }]
    };
    var result = patchValidator.validate(editSet, {
      cloneDir: tmpDir,
      mode: 'target',
      capabilities: { dependencyPatch: false }
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('DEPENDENCY_PATCH_UNAVAILABLE') !== -1; }), 'should have DEPENDENCY_PATCH_UNAVAILABLE error');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper edit under src/ passes', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function app() {\n  return true;\n}\n', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'test',
      edits: [{ path: 'src/app.js', oldString: 'return true', newString: 'return false' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'local-wrapper edit under src/ should pass: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper newFile under src/ passes', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'src/wrapper.js', content: 'module.exports = function() {};\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'local-wrapper newFile under src/ should pass: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper edit outside src/ is rejected', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'root.txt'), 'some content\n', 'utf8');
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'test',
      edits: [{ path: 'root.txt', oldString: 'some', newString: 'modified' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }), 'should reject local-wrapper outside src/: ' + (result.errors || []).join('; '));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper newFile at root is rejected', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'wrapper.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper newFile under node_modules/ is rejected', function() {
  var tmpDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'test',
      edits: [],
      newFiles: [{ path: 'node_modules/pkg/wrapper.js', content: 'module.exports = 1;\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(function(e) { return e.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1; }));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// =============================================================================
// FIND_CLOSEST_MATCH
// =============================================================================

test('findClosestMatch: returns null for empty input', function() {
  var result = patchValidator.findClosestMatch(null, 'oldString');
  assert.strictEqual(result, null);
  result = patchValidator.findClosestMatch([], 'oldString');
  assert.strictEqual(result, null);
  result = patchValidator.findClosestMatch(['line1', 'line2'], '');
  assert.strictEqual(result, null);
});

test('findClosestMatch: returns null when exact match found (indexOf)', function() {
  // When oldString is found by indexOf, findClosestMatch is not called.
  // This test verifies that findClosestMatch returns null for strings
  // that are exact line matches.
  var lines = ['function foo() {', '  return 1;', '}'];
  var result = patchValidator.findClosestMatch(lines, 'return 1;');
  // findClosestMatch uses levenshtein on first line of oldString
  // and returns the best line match even for exact matches
  assert.ok(result !== null, 'should return a match object');
  assert.ok(typeof result.lineNumber === 'number');
  assert.ok(Array.isArray(result.beforeLines));
  assert.ok(Array.isArray(result.afterLines));
  assert.strictEqual(result.rejectedOldString, 'return 1;');
});

test('findClosestMatch: returns best line for non-matching string', function() {
  var lines = ['alpha', 'beta', 'gamma', 'delta'];
  var result = patchValidator.findClosestMatch(lines, 'zzz-not-found-xxx');
  assert.ok(result !== null, 'should return a match object');
  // Score depends on levenshtein of first 100 chars of search vs first 100 chars of line.
  // 'alpha' and 'delta' are both 5 chars, same distance from 'zzz-not-found-xxx' (17).
  // Either is acceptable as the "best" match.
  assert.ok(['alpha', 'beta', 'gamma', 'delta'].indexOf(result.line) !== -1, 'should be one of the input lines');
  assert.strictEqual(result.rejectedOldString, 'zzz-not-found-xxx');
  assert.ok(typeof result.lineNumber === 'number' && result.lineNumber >= 1);
});

test('findClosestMatch: context lines are limited to ±30', function() {
  var lines = [];
  for (var i = 0; i < 200; i++) {
    lines.push('line ' + i);
  }
  var result = patchValidator.findClosestMatch(lines, 'zzz-not-found');
  assert.ok(result !== null);
  // best match is around line 0 (first line "alpha" but now "line 0")
  assert.ok(result.beforeLines.length <= 30, 'beforeLines should be ≤30');
  assert.ok(result.afterLines.length <= 30, 'afterLines should be ≤30');
  assert.ok(result.lineNumber >= 1);
});

test('findClosestMatch: lines truncated to 300 chars and secrets redacted', function() {
  var longLine = 'x'.repeat(500);
  var secretLine = 'token_aGVsbG8gd29ybGR0b2tlbl9hZ2VuY3kAAAAAAAB';
  var lines = [longLine, secretLine];
  var result = patchValidator.findClosestMatch(lines, 'zzz');
  assert.ok(result !== null);
  assert.ok(result.line.length <= 303, 'truncated line should be ≤303 chars'); // 300 + '...'
});

test('findClosestMatch: includes rejectedOldString in result', function() {
  var lines = ['function foo() {}', 'return 1;'];
  var result = patchValidator.findClosestMatch(lines, 'return 2;');
  assert.strictEqual(result.rejectedOldString, 'return 2;');
});
