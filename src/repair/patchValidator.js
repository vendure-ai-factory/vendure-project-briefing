'use strict';

var fs = require('fs');
var path = require('path');

// Stable error codes for all validation errors
var ERR_CODES = {
  // Path-related errors (checked before oldString matching)
  PATH_ESCAPE: 'PATH_ESCAPE',
  SECRET_NAME: 'SECRET_NAME',
  PROTECTED_PATH: 'PROTECTED_PATH',
  KIND_NOT_ALLOWED: 'KIND_NOT_ALLOWED',

  // File/content errors
  OLDSTRING_NOT_FOUND: 'OLDSTRING_NOT_FOUND',
  OLDSTRING_AMBIGUOUS: 'OLDSTRING_AMBIGUOUS',
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  TOO_MANY_LINES: 'TOO_MANY_LINES',

  // dependency-bump specific
  DEP_BUMP_NOT_PACKAGE: 'DEP_BUMP_NOT_PACKAGE',
  DEP_BUMP_INVALID_VERSION: 'DEP_BUMP_INVALID_VERSION',
  DEP_BUMP_NO_NEW_FILES: 'DEP_BUMP_NO_NEW_FILES',

  // dependency-patch specific
  DEP_PATCH_NO_NODE_MODULES: 'DEP_PATCH_NO_NODE_MODULES',
  DEP_PATCH_NOT_ONE_PKG: 'DEP_PATCH_NOT_ONE_PKG',

  // Command safety
  PACKAGE_NAME_INVALID: 'PACKAGE_NAME_INVALID',
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',

  // migration specific
  MIGRATION_NOT_UNDER_FOLDER: 'MIGRATION_NOT_UNDER_FOLDER',

  // Structural errors
  MISSING_REPAIR_KIND: 'MISSING_REPAIR_KIND',
  INVALID_REPAIR_KIND: 'INVALID_REPAIR_KIND',
  INVALID_EDITS: 'INVALID_EDITS',
  INVALID_EDIT: 'INVALID_EDIT',
  CLONE_NOT_FOUND: 'CLONE_NOT_FOUND',
  EDIT_SET_INVALID: 'EDIT_SET_INVALID'
};

var ALLOWED_REPAIR_KINDS = {
  'source-edit': true,
  'config-edit': true,
  'migration': true,
  'dependency-bump': true,
  'dependency-patch': true,
  'local-wrapper': true
};

var SECRET_NAME_PATTERNS = [
  /\.env$/i,
  /\.env\.[a-zA-Z0-9]+$/i,
  /\.pem$/i,
  /[_-]?key$/i,
  /[_-]?secret$/i,
  /id_rsa$/i,
  /[_-]?key[_-]/i,
  /[_-]?secret[_-]/i,
  /credential/i
];

function isSecretLookingName(filePath) {
  var name = path.basename(filePath);
  for (var i = 0; i < SECRET_NAME_PATTERNS.length; i++) {
    if (SECRET_NAME_PATTERNS[i].test(name)) {
      return true;
    }
  }
  return false;
}

// Package names must match ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ and not be path components
function validatePackageName(name) {
  // Explicitly reject path components and special names
  if (!name || name === '.' || name === '..' || name.startsWith('-')) {
    return false;
  }
  var packageNameRegex = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
  return packageNameRegex.test(name);
}

// Extract package name from node_modules path like node_modules/foo/index.js or node_modules/@scope/pkg/index.js
function extractPackageName(nodeModulesPath) {
  var match = nodeModulesPath.match(/^node_modules\/@?([^\/]+)(?:\/|$)/);
  if (match) {
    return match[1];
  }
  return null;
}

function validatePath(filePath, cloneDir, protectedPaths) {
  var errors = [];

  if (!filePath || typeof filePath !== 'string') {
    errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'Path must be a non-empty string' });
    return errors;
  }

  // Check for path escape attempts
  if (filePath.includes('..')) {
    errors.push({ code: ERR_CODES.PATH_ESCAPE, message: 'Path must not contain ".." (path escape attempt): ' + filePath });
    return errors;
  }

  // Check for .git references
  if (filePath.includes('.git')) {
    errors.push({ code: ERR_CODES.PATH_ESCAPE, message: 'Path must not contain ".git": ' + filePath });
  }

  // Check for secret-looking names
  if (isSecretLookingName(filePath)) {
    errors.push({ code: ERR_CODES.SECRET_NAME, message: 'Path looks like it contains a secret: ' + filePath });
  }

  // Check path is within cloneDir
  try {
    var resolved = path.resolve(cloneDir, filePath);
    var realCloneDir = fs.realpathSync(cloneDir);
    var realPath;
    var pathExists = fs.existsSync(resolved);

    if (pathExists) {
      realPath = fs.realpathSync(resolved);
      if (!realPath.startsWith(realCloneDir + path.sep) && realPath !== realCloneDir) {
        errors.push({ code: ERR_CODES.PATH_ESCAPE, message: 'Resolved path is outside cloneDir: ' + filePath });
      }
    } else {
      // For non-existent paths (new files), check parent directory
      var parentDir = path.dirname(resolved);
      if (parentDir !== resolved) {
        try {
          var realParent = fs.realpathSync(parentDir);
          if (!realParent.startsWith(realCloneDir + path.sep) && realParent !== realCloneDir) {
            errors.push({ code: ERR_CODES.PATH_ESCAPE, message: 'Resolved path is outside cloneDir: ' + filePath });
          }
        } catch (e) {
          // If parent doesn't exist, use resolved path directly
          if (!resolved.startsWith(realCloneDir + path.sep) && resolved !== realCloneDir) {
            errors.push({ code: ERR_CODES.PATH_ESCAPE, message: 'Resolved path is outside cloneDir: ' + filePath });
          }
        }
      } else {
        if (!resolved.startsWith(realCloneDir + path.sep) && resolved !== realCloneDir) {
          errors.push({ code: ERR_CODES.PATH_ESCAPE, message: 'Resolved path is outside cloneDir: ' + filePath });
        }
      }
    }
  } catch (e) {
    errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'Could not resolve path: ' + filePath + ' - ' + e.message });
  }

  // Check protected paths
  if (protectedPaths && Array.isArray(protectedPaths)) {
    var resolved = path.resolve(cloneDir, filePath);
    for (var i = 0; i < protectedPaths.length; i++) {
      var protectedPath = protectedPaths[i];
      if (resolved.startsWith(protectedPath + path.sep) || resolved === protectedPath) {
        errors.push({ code: ERR_CODES.PROTECTED_PATH, message: 'Path is in protected directory: ' + protectedPath });
        break;
      }
    }
  }

  return errors;
}

function countChangedLines(oldString, newString) {
  var oldLines = (oldString || '').split('\n').length;
  var newLines = (newString || '').split('\n').length;
  return Math.max(oldLines, newLines);
}

function findLockfile(cloneDir) {
  var lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
  for (var i = 0; i < lockfiles.length; i++) {
    var lockPath = path.join(cloneDir, lockfiles[i]);
    if (fs.existsSync(lockPath)) {
      return lockfiles[i];
    }
  }
  return null;
}

function findMigrationsDir(cloneDir) {
  var commonNames = ['migrations', 'src/migrations', 'db/migrations', 'typeorm/migrations', 'mikro-orm/migrations'];

  for (var i = 0; i < commonNames.length; i++) {
    var dir = path.join(cloneDir, commonNames[i]);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
  }

  try {
    var entries = fs.readdirSync(cloneDir, { withFileTypes: true });
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (entry.isDirectory() && entry.name.includes('migration')) {
        return path.join(cloneDir, entry.name);
      }
    }
  } catch (e) {
  }

  return null;
}

function validateOldStringExists(filePath, oldString) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, code: ERR_CODES.OLDSTRING_NOT_FOUND, message: 'File does not exist: ' + filePath };
  }

  var content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { valid: false, code: ERR_CODES.INVALID_EDIT, message: 'Could not read file: ' + filePath };
  }

  var idx = content.indexOf(oldString);
  if (idx === -1) {
    return { valid: false, code: ERR_CODES.OLDSTRING_NOT_FOUND, message: 'oldString not found in file: ' + filePath };
  }

  var nextIdx = content.indexOf(oldString, idx + 1);
  if (nextIdx !== -1) {
    return { valid: false, code: ERR_CODES.OLDSTRING_AMBIGUOUS, message: 'oldString occurs more than once in file: ' + filePath };
  }

  return { valid: true };
}

function validateDependencyBump(editSet, cloneDir) {
  var errors = [];

  // Check edits are only to package.json or lockfile
  var edits = editSet.edits || [];
  var newFiles = editSet.newFiles || [];

  if (newFiles.length > 0) {
    errors.push({ code: ERR_CODES.DEP_BUMP_NO_NEW_FILES, message: 'dependency-bump repairKind cannot create new files' });
  }

  var lockfileName = findLockfile(cloneDir);

  for (var i = 0; i < edits.length; i++) {
    var edit = edits[i];
    if (edit.path !== 'package.json' && edit.path !== lockfileName) {
      errors.push({ code: ERR_CODES.DEP_BUMP_NOT_PACKAGE, message: 'dependency-bump repairKind can only modify package.json and lockfile, but found: ' + edit.path });
    }
  }

  // Validate package.json version changes
  for (var k = 0; k < edits.length; k++) {
    var edit = edits[k];
    if (edit.path === 'package.json') {
      var pkgEditErrors = validatePackageJsonEdit(cloneDir, edit.oldString, edit.newString);
      errors = errors.concat(pkgEditErrors);
    }
  }

  return errors;
}

function validatePackageJsonEdit(cloneDir, oldString, newString) {
  var errors = [];

  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8'));
    var oldPkg;
    try {
      oldPkg = JSON.parse(oldString);
    } catch (e) {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'oldString is not valid JSON for package.json' });
      return errors;
    }

    try {
      JSON.parse(newString);
    } catch (e) {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'newString is not valid JSON for package.json' });
      return errors;
    }

    var newPkg = JSON.parse(newString);
    var oldDeps = Object.assign({}, oldPkg.dependencies || {}, oldPkg.devDependencies || {});
    var newDeps = Object.assign({}, newPkg.dependencies || {}, newPkg.devDependencies || {});

    var allOldDeps = Object.keys(oldDeps);
    var allNewDeps = Object.keys(newDeps);

    // Check existing dependency version changes
    for (var i = 0; i < allOldDeps.length; i++) {
      var depName = allOldDeps[i];
      if (newDeps[depName] && newDeps[depName] !== oldDeps[depName]) {
        var versionRegex = /^[\d.]+$/;
        if (!versionRegex.test(newDeps[depName])) {
          errors.push({ code: ERR_CODES.DEP_BUMP_INVALID_VERSION, message: 'Dependency version must be a simple version string without ranges (e.g. "1.2.3"), got: ' + newDeps[depName] + ' for ' + depName });
        }
      }
    }

    // Check new dependency version
    for (var j = 0; j < allNewDeps.length; j++) {
      var newDepName = allNewDeps[j];
      if (!oldDeps[newDepName]) {
        var versionRegex2 = /^[\d.]+$/;
        if (!versionRegex2.test(newDeps[newDepName])) {
          errors.push({ code: ERR_CODES.DEP_BUMP_INVALID_VERSION, message: 'New dependency version must be a simple version string without ranges, got: ' + newDeps[newDepName] + ' for ' + newDepName });
        }
      }
    }
  } catch (e) {
    errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'Error validating package.json: ' + e.message });
  }

  return errors;
}

function validateMigration(cloneDir, edits, newFiles) {
  var errors = [];
  var migrationsDir = findMigrationsDir(cloneDir);

  if (!migrationsDir) {
    errors.push({ code: ERR_CODES.MIGRATION_NOT_UNDER_FOLDER, message: 'Could not find migrations directory in clone' });
    return errors;
  }

  var allPaths = [];
  for (var i = 0; i < edits.length; i++) {
    allPaths.push(edits[i].path);
  }
  for (var j = 0; j < newFiles.length; j++) {
    allPaths.push(newFiles[j].path);
  }

  var migrationsDirResolved = path.resolve(migrationsDir);

  for (var k = 0; k < allPaths.length; k++) {
    var filePath = allPaths[k];
    var resolved = path.resolve(cloneDir, filePath);
    if (!resolved.startsWith(migrationsDirResolved + path.sep)) {
      errors.push({ code: ERR_CODES.MIGRATION_NOT_UNDER_FOLDER, message: 'migration repairKind requires path to be under migrations folder (' + migrationsDir + '), got: ' + filePath });
    }
  }

  return errors;
}

function validateModePipeline(editSet, protectedPaths) {
  var errors = [];

  if (!protectedPaths || !Array.isArray(protectedPaths)) {
    return errors;
  }

  var edits = editSet.edits || [];
  var newFiles = editSet.newFiles || [];

  for (var i = 0; i < edits.length; i++) {
    var edit = edits[i];

    for (var j = 0; j < protectedPaths.length; j++) {
      var protectedPath = protectedPaths[j];
      var resolved = path.resolve(edit.path);
      if (resolved.startsWith(protectedPath + path.sep) || resolved === protectedPath) {
        errors.push({ code: ERR_CODES.PROTECTED_PATH, message: 'Pipeline mode: edit to protected path not allowed: ' + edit.path });
      }
    }

    if (edit.path.startsWith('tests' + path.sep) || edit.path.startsWith('tests/')) {
      errors.push({ code: ERR_CODES.PROTECTED_PATH, message: 'Pipeline mode: edits to tests/ directory not allowed: ' + edit.path });
    }
  }

  for (var k = 0; k < newFiles.length; k++) {
    var newFile = newFiles[k];

    for (var m = 0; m < protectedPaths.length; m++) {
      var protectedPath2 = protectedPaths[m];
      var resolvedNew = path.resolve(newFile.path);
      if (resolvedNew.startsWith(protectedPath2 + path.sep) || resolvedNew === protectedPath2) {
        errors.push({ code: ERR_CODES.PROTECTED_PATH, message: 'Pipeline mode: new file in protected path not allowed: ' + newFile.path });
      }
    }

    if (newFile.path.startsWith('tests' + path.sep) || newFile.path.startsWith('tests/')) {
      errors.push({ code: ERR_CODES.PROTECTED_PATH, message: 'Pipeline mode: new files in tests/ directory not allowed: ' + newFile.path });
    }
  }

  return errors;
}

function formatErrors(errors) {
  // Convert error objects to error strings with code prefix
  return errors.map(function (e) {
    if (typeof e === 'string') {
      return e;
    }
    return '[' + e.code + '] ' + e.message;
  });
}

function validate(editSet, options) {
  options = options || {};
  var cloneDir = options.cloneDir;
  var protectedPaths = options.protectedPaths || [];
  var mode = options.mode || 'target';

  var errors = [];
  var stats = { fileCount: 0, totalChangedLines: 0, editCount: 0, newFileCount: 0 };

  if (!editSet || typeof editSet !== 'object') {
    return { ok: false, errors: ['[' + ERR_CODES.EDIT_SET_INVALID + '] editSet must be a non-null object'], stats: stats };
  }

  if (!cloneDir || typeof cloneDir !== 'string') {
    return { ok: false, errors: ['[' + ERR_CODES.CLONE_NOT_FOUND + '] cloneDir must be a non-empty string'], stats: stats };
  }

  if (!fs.existsSync(cloneDir)) {
    return { ok: false, errors: ['[' + ERR_CODES.CLONE_NOT_FOUND + '] cloneDir does not exist: ' + cloneDir], stats: stats };
  }

  if (!editSet.repairKind) {
    errors.push({ code: ERR_CODES.MISSING_REPAIR_KIND, message: 'editSet.repairKind is required' });
  } else if (!ALLOWED_REPAIR_KINDS[editSet.repairKind]) {
    errors.push({ code: ERR_CODES.INVALID_REPAIR_KIND, message: 'repairKind must be one of: ' + Object.keys(ALLOWED_REPAIR_KINDS).join(', ') + ', got: ' + editSet.repairKind });
  }

  var edits = editSet.edits;
  if (!edits || !Array.isArray(edits)) {
    errors.push({ code: ERR_CODES.INVALID_EDITS, message: 'editSet.edits must be an array' });
  }

  var newFiles = editSet.newFiles;
  if (newFiles && !Array.isArray(newFiles)) {
    errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'editSet.newFiles must be an array if provided' });
  }

  if (errors.length > 0) {
    stats.fileCount = 0;
    return { ok: false, errors: formatErrors(errors), stats: stats };
  }

  // DEPENDENCY-PATCH: validate package name safety BEFORE edits loop
  // This runs before PATH_ESCAPE checks so invalid package names get PACKAGE_NAME_INVALID first
  if (editSet.repairKind === 'dependency-patch') {
    var depEditsArr = edits || [];
    if (depEditsArr.length > 0) {
      var depEditPackage = null;
      for (var depEi = 0; depEi < depEditsArr.length; depEi++) {
        if (!depEditsArr[depEi].path.startsWith('node_modules/')) {
          errors.push({ code: ERR_CODES.DEP_PATCH_NOT_ONE_PKG, message: 'dependency-patch repairKind edits must be under node_modules/: ' + depEditsArr[depEi].path });
        } else {
          var depPkgName = extractPackageName(depEditsArr[depEi].path);
          if (!depPkgName) {
            errors.push({ code: ERR_CODES.PACKAGE_NAME_INVALID, message: 'Could not extract package name: ' + depEditsArr[depEi].path });
          } else if (!validatePackageName(depPkgName)) {
            errors.push({ code: ERR_CODES.PACKAGE_NAME_INVALID, message: 'Invalid package name: ' + depPkgName });
          } else if (!depEditPackage) {
            depEditPackage = depPkgName;
          } else if (depEditPackage !== depPkgName) {
            errors.push({ code: ERR_CODES.DEP_PATCH_NOT_ONE_PKG, message: 'dependency-patch edits must all target the same package, found both ' + depEditPackage + ' and ' + depPkgName });
          }
        }
      }
    }
    var depNewFilesArr = newFiles || [];
    for (var depNi = 0; depNi < depNewFilesArr.length; depNi++) {
      if (!depNewFilesArr[depNi].path.startsWith('patches/') && !depNewFilesArr[depNi].path.startsWith('node_modules/')) {
        errors.push({ code: ERR_CODES.DEP_PATCH_NO_NODE_MODULES, message: 'dependency-patch newFile path must be under patches/ or node_modules/: ' + depNewFilesArr[depNi].path });
      }
    }
  }

  var allPaths = [];
  var pathFileMap = {};

  // STEP 1: Validate structure and path rules BEFORE oldString matching
  // This ensures PATH_ESCAPE, SECRET_NAME, PROTECTED_PATH, KIND_NOT_ALLOWED are caught first

  for (var i = 0; i < edits.length; i++) {
    var edit = edits[i];
    if (!edit.path || typeof edit.path !== 'string') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'edit at index ' + i + ' must have a path string' });
      continue;
    }
    if (!edit.oldString || typeof edit.oldString !== 'string') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'edit at index ' + i + ' must have oldString' });
      continue;
    }
    if (!edit.newString || typeof edit.newString !== 'string') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'edit at index ' + i + ' must have newString' });
      continue;
    }

    if (edit.oldString.length > 10000 || edit.newString.length > 10000) {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'edit strings must be under 10000 characters each' });
    }

    // Path validation (checks PATH_ESCAPE, SECRET_NAME, PROTECTED_PATH first)
    var pathErrors = validatePath(edit.path, cloneDir, protectedPaths);
    if (pathErrors.length > 0) {
      errors = errors.concat(pathErrors);
    }

    if (!pathFileMap[edit.path]) {
      pathFileMap[edit.path] = { edits: [], isNew: false };
      allPaths.push(edit.path);
    }
    pathFileMap[edit.path].edits.push(i);
    stats.editCount++;
    stats.totalChangedLines += countChangedLines(edit.oldString, edit.newString);
  }

  var newFilesArr = newFiles || [];
  for (var j = 0; j < newFilesArr.length; j++) {
    var newFile = newFilesArr[j];
    if (!newFile.path || typeof newFile.path !== 'string') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'newFile at index ' + j + ' must have a path string' });
      continue;
    }
    if (!newFile.content && newFile.content !== '') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'newFile at index ' + j + ' must have content' });
      continue;
    }

    if (typeof newFile.content !== 'string') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'newFile.content must be a string (no binary content allowed)' });
      continue;
    }

    // Path validation for newFiles (checks PATH_ESCAPE, SECRET_NAME, PROTECTED_PATH first)
    var newFilePathErrors = validatePath(newFile.path, cloneDir, protectedPaths);
    if (newFilePathErrors.length > 0) {
      errors = errors.concat(newFilePathErrors);
    }

    var fullPath = path.join(cloneDir, newFile.path);
    var exists = fs.existsSync(fullPath);

    if (exists && editSet.repairKind !== 'migration' && editSet.repairKind !== 'local-wrapper') {
      errors.push({ code: ERR_CODES.INVALID_EDIT, message: 'newFile already exists and repairKind is not migration/local-wrapper: ' + newFile.path });
    }

    if (!pathFileMap[newFile.path]) {
      pathFileMap[newFile.path] = { edits: [], isNew: true };
      allPaths.push(newFile.path);
    }
    pathFileMap[newFile.path].isNew = true;
    stats.newFileCount++;
  }

  stats.fileCount = allPaths.length;

  if (stats.fileCount > 5) {
    errors.push({ code: ERR_CODES.TOO_MANY_FILES, message: 'Maximum 5 files allowed, got: ' + stats.fileCount });
  }

  if (stats.totalChangedLines > 200) {
    errors.push({ code: ERR_CODES.TOO_MANY_LINES, message: 'Maximum 200 changed lines allowed, got: ' + stats.totalChangedLines });
  }

  // STEP 2: RepairKind-specific path restrictions (MUST happen before oldString check)
  // For dependency-bump, only package.json and lockfile are allowed - check here, not in oldString STEP

  if (editSet.repairKind === 'dependency-bump') {
    var depErrors = validateDependencyBump(editSet, cloneDir);
    errors = errors.concat(depErrors);
  }

  // STEP 3: oldString validation (only for existing files, after path rules STEP)
  // This runs AFTER path validation ensures the file is in an allowed location

  for (var pathKey in pathFileMap) {
    if (pathFileMap.hasOwnProperty(pathKey)) {
      var fileInfo = pathFileMap[pathKey];
      var fullFilePath = path.join(cloneDir, pathKey);

      if (!fileInfo.isNew) {
        // Only check oldString for files that exist
        var oldStringResults = [];
        for (var ei = 0; ei < edits.length; ei++) {
          if (edits[ei].path === pathKey) {
            oldStringResults.push(validateOldStringExists(fullFilePath, edits[ei].oldString));
          }
        }

        for (var ri = 0; ri < oldStringResults.length; ri++) {
          if (!oldStringResults[ri].valid) {
            errors.push({ code: oldStringResults[ri].code, message: oldStringResults[ri].message });
          }
        }
      }
    }
  }

  if (mode === 'pipeline' && errors.length === 0) {
    var pipelineErrors = validateModePipeline(editSet, protectedPaths);
    errors = errors.concat(pipelineErrors);
  }

  if (editSet.repairKind === 'migration' && errors.length === 0) {
    var migrationErrors = validateMigration(cloneDir, edits, newFilesArr);
    errors = errors.concat(migrationErrors);
  }

  return {
    ok: errors.length === 0,
    errors: formatErrors(errors),
    stats: stats
  };
}

module.exports = {
  validate: validate,
  ALLOWED_REPAIR_KINDS: ALLOWED_REPAIR_KINDS,
  isSecretLookingName: isSecretLookingName,
  ERR_CODES: ERR_CODES
};
