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

test('validate: dependency-patch passes with newFiles in node_modules', function() {
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
    assert.strictEqual(result.ok, true, 'dependency-patch with node_modules newFiles should pass');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('validate: local-wrapper passes validation', function() {
  var tmpDir = makeTempDir();
  try {
    setupStandardFiles(tmpDir);
    var editSet = {
      repairKind: 'local-wrapper',
      rationale: 'wrapper',
      edits: [{ path: 'test.txt', oldString: 'line 2', newString: 'line 2 modified' }],
      newFiles: [{ path: 'wrapper.sh', content: '#!/bin/bash\necho hello\n' }]
    };
    var result = patchValidator.validate(editSet, { cloneDir: tmpDir, mode: 'target' });
    assert.strictEqual(result.ok, true, 'local-wrapper should pass');
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

test('validate: dependency-patch allows edits to existing node_modules files', function() {
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
    assert.strictEqual(result.ok, true, 'dependency-patch should allow edits to existing node_modules files');
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

test('validate: dependency-patch allows newFiles in node_modules', function() {
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
    assert.strictEqual(result.ok, true, 'dependency-patch should allow node_modules newFiles');
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
