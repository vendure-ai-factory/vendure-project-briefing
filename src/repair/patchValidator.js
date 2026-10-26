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
  PROPOSAL_IN_NODE_MODULES: 'PROPOSAL_IN_NODE_MODULES',

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
  DEPENDENCY_PATCH_UNAVAILABLE: 'DEPENDENCY_PATCH_UNAVAILABLE',

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

/**
 * List only the repair kinds that are currently available. The runtime may
 * switch dependency-patch off (--ignore-scripts image), so rejection messages
 * must not advertise a kind the model can never use.
 */
function currentlyAvailableKinds(capabilities) {
  var kinds = Object.keys(ALLOWED_REPAIR_KINDS).sort();
  if (capabilities && capabilities.dependencyPatch === false) {
    kinds = kinds.filter(function(k) { return k !== 'dependency-patch'; });
  }
  return kinds;
}

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
    // Find the closest match (Levenshtein-like: longest common subsequence)
    // Return context around the closest match for the model's next attempt
    var lines = content.split('\n');
    var closestMatch = findClosestMatch(lines, oldString);
    var errorResult = { valid: false, code: ERR_CODES.OLDSTRING_NOT_FOUND, message: 'oldString not found in file: ' + filePath };
    if (closestMatch) {
      errorResult.closestMatch = closestMatch;
    }
    return errorResult;
  }

  var nextIdx = content.indexOf(oldString, idx + 1);
  if (nextIdx !== -1) {
    return { valid: false, code: ERR_CODES.OLDSTRING_AMBIGUOUS, message: 'oldString occurs more than once in file: ' + filePath };
  }

  return { valid: true };
}

/**
 * Find the closest match to oldString in the file content.
 * Returns { beforeLines, matchLine, afterLines, lineNumber } with ±30 lines of context.
 * Lines are truncated to 300 chars max with secrets redacted.
 */
function findClosestMatch(lines, oldString) {
  if (!lines || !Array.isArray(lines) || !oldString) return null;
  var CONTEXT_LINES = 30;
  var MAX_LINE_LEN = 300;
  var REDACTED = '[REDACTED]';

  // Simple Levenshtein distance for short strings
  function levenshtein(a, b) {
    if (!a || !b) return Infinity;
    var m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    var dp = Array(m + 1).fill(null).map(function() { return Array(n + 1).fill(0); });
    for (var i = 0; i <= m; i++) dp[i][0] = i;
    for (var j = 0; j <= n; j++) dp[0][j] = j;
    for (var ii = 1; ii <= m; ii++) {
      for (var jj = 1; jj <= n; jj++) {
        var cost = a[ii - 1] === b[jj - 1] ? 0 : 1;
        dp[ii][jj] = Math.min(dp[ii - 1][jj] + 1, dp[ii][jj - 1] + 1, dp[ii - 1][jj - 1] + cost);
      }
    }
    return dp[m][n];
  }

  // Score each line by similarity to oldString (line-level Levenshtein)
  var bestLineIdx = -1;
  var bestScore = Infinity;
  var oldLines = oldString.split('\n');
  var oldFirstLine = oldLines[0] || '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var dist = levenshtein(line.substring(0, 100), oldFirstLine.substring(0, 100));
    // Bonus: prefer lines that have some of the same characters in order
    var bonus = 0;
    for (var si = 0; si < Math.min(oldFirstLine.length, 20); si++) {
      if (line.indexOf(oldFirstLine[si]) !== -1) bonus++;
    }
    var score = dist - bonus * 0.5;
    if (score < bestScore) {
      bestScore = score;
      bestLineIdx = i;
    }
  }

  if (bestLineIdx === -1) return null;

  var startIdx = Math.max(0, bestLineIdx - CONTEXT_LINES);
  var endIdx = Math.min(lines.length - 1, bestLineIdx + CONTEXT_LINES);

  function truncateLine(line) {
    if (!line) return '';
    var truncated = line.length > MAX_LINE_LEN ? line.substring(0, MAX_LINE_LEN) + '...' : line;
    // Redact potential secrets (long alphanumeric strings)
    return truncated.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, function(m) {
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(m)) return REDACTED;
      return m;
    });
  }

  var beforeLines = [];
  for (var bi = startIdx; bi < bestLineIdx; bi++) {
    beforeLines.push({ lineNumber: bi + 1, line: truncateLine(lines[bi]) });
  }
  var afterLines = [];
  for (var ai = bestLineIdx + 1; ai <= endIdx; ai++) {
    afterLines.push({ lineNumber: ai + 1, line: truncateLine(lines[ai]) });
  }

  return {
    lineNumber: bestLineIdx + 1,
    line: truncateLine(lines[bestLineIdx]),
    beforeLines: beforeLines,
    afterLines: afterLines,
    rejectedOldString: oldString
  };
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
  var capabilities = options.capabilities || {};

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
    errors.push({ code: ERR_CODES.INVALID_REPAIR_KIND, message: 'repairKind must be one of: ' + currentlyAvailableKinds(capabilities).join(', ') + ', got: ' + editSet.repairKind });
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

  // node_modules path enforcement: source-edit, config-edit, and migration may NOT
  // target node_modules/ (they are read-only context). dependency-bump,
  // dependency-patch, and local-wrapper have their own kind-specific validation
  // that handles node_modules paths; this catch-all only catches kinds that have
  // NO other node_modules handling.
  // - dependency-patch when not available in this runtime → DEPENDENCY_PATCH_UNAVAILABLE.
  // - local-wrapper: edits/newFiles must be under src/ (tracked source only).
  // - dependency-bump: already restricted to package.json/lockfile by validateDependencyBump.
  var editSetKind = editSet.repairKind;
  var allEdits = edits || [];
  var allNewFiles = newFiles || [];

  // DEPENDENCY_PATCH_UNAVAILABLE: only for dependency-patch when explicitly disabled
  if (editSetKind === 'dependency-patch' && capabilities.dependencyPatch === false) {
    errors.push({ code: ERR_CODES.DEPENDENCY_PATCH_UNAVAILABLE, message: 'dependency-patch is not available in this runtime' });
  }

  // When dependency-patch is unavailable, patch files can never be applied, so
  // NO repair kind may add or edit files under the TOP-LEVEL patches/ directory
  // (they would be inert). This gate matches ONLY a top-level patches/
  // directory: a path such as src/patches/x.ts or any nested folder that
  // merely contains the word "patches" is an ordinary source path and is never
  // blocked here.
  if (capabilities.dependencyPatch === false) {
    function checkPatchesPath(pathStr) {
      if (!pathStr) return null;
      var normalized = String(pathStr).replace(/\\/g, '/');
      // Reduce an absolute path to a clone-relative form so a modeled absolute
      // path is judged exactly like its relative equivalent.
      if (cloneDir && path.isAbsolute(normalized)) {
        try {
          normalized = path.relative(cloneDir, normalized).replace(/\\/g, '/');
        } catch (ee) { /* keep normalized as-is */ }
      }
      normalized = normalized.replace(/^\.\//, '');
      if (normalized === 'patches' || normalized.indexOf('patches/') === 0) {
        return { code: ERR_CODES.DEPENDENCY_PATCH_UNAVAILABLE, message: 'dependency-patch is not available in this runtime; files under the top-level patches/ directory are not allowed (got: ' + pathStr + ')' };
      }
      return null;
    }
    for (var pEd = 0; pEd < allEdits.length; pEd++) {
      var pEdErr = checkPatchesPath(allEdits[pEd].path || '');
      if (pEdErr) { errors.push(pEdErr); }
    }
    for (var pNf = 0; pNf < allNewFiles.length; pNf++) {
      var pNfErr = checkPatchesPath(allNewFiles[pNf].path || '');
      if (pNfErr) { errors.push(pNfErr); }
    }
  }

  // node_modules catch-all: ALL repair kinds are restricted from node_modules/
  // by default. Each kind has its own specific path validation, but the
  // node_modules restriction is universal:
  // - dependency-bump: already restricted to package.json/lockfile by validateDependencyBump
  // - dependency-patch: needs node_modules for its patches
  // - local-wrapper: src/-only enforced separately below
  // Only source-edit, config-edit, migration get PROPOSAL_IN_NODE_MODULES here.
  var noNodeModulesKinds = {
    'source-edit': true,
    'config-edit': true,
    'migration': true
  };
  if (noNodeModulesKinds[editSetKind]) {
    function checkNodeModulesPath(pathStr) {
      if (!pathStr || pathStr.indexOf('node_modules/') === -1) return null;
      return { code: ERR_CODES.PROPOSAL_IN_NODE_MODULES, message: 'Paths under node_modules/ are not allowed for repairKind "' + editSetKind + '" (node_modules is read-only; use dependency-bump, dependency-patch, or local-wrapper if appropriate)' };
    }
    for (var nmI = 0; nmI < allEdits.length; nmI++) {
      var nmErr = checkNodeModulesPath(allEdits[nmI].path || '');
      if (nmErr) { errors.push(nmErr); break; }
    }
    for (var nmJ = 0; nmJ < allNewFiles.length; nmJ++) {
      var nmNewErr = checkNodeModulesPath(allNewFiles[nmJ].path || '');
      if (nmNewErr) { errors.push(nmNewErr); break; }
    }
  }

  // local-wrapper: all edits and newFiles must be under src/ (with explicit blocks for protected paths)
  if (editSetKind === 'local-wrapper') {
    function checkSrcOnly(pathStr) {
      if (!pathStr) return null;
      var normalized = pathStr.replace(/\\/g, '/');

      // Block node_modules paths with specific message
      if (normalized.indexOf('node_modules/') !== -1 || normalized.indexOf('node_modules\\') !== -1) {
        return {
          code: ERR_CODES.PROPOSAL_IN_NODE_MODULES,
          message: '[PROPOSAL_IN_NODE_MODULES] local-wrapper cannot edit or create files under node_modules/: ' + pathStr + '. Use dependency-patch or local-wrapper under src/ instead.'
        };
      }

      // Block lockfiles with specific message
      var lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
      var baseName = normalized.split('/').pop().split('\\').pop();
      if (lockfiles.indexOf(baseName) !== -1) {
        return {
          code: ERR_CODES.PROPOSAL_IN_NODE_MODULES,
          message: '[PROPOSAL_IN_NODE_MODULES] local-wrapper cannot modify lockfiles: ' + pathStr + '. Lockfile changes require dependency-bump repairKind.'
        };
      }

      // Block workflow files with specific message
      if (normalized.indexOf('.github/workflows/') !== -1 || normalized.indexOf('.github\\workflows\\') !== -1) {
        return {
          code: ERR_CODES.PROPOSAL_IN_NODE_MODULES,
          message: '[PROPOSAL_IN_NODE_MODULES] local-wrapper cannot modify GitHub workflow files: ' + pathStr + '. Workflow changes require separate CI configuration.'
        };
      }

      // Block Docker-related files with specific message
      var fileName = baseName;
      if (fileName === 'Dockerfile' || fileName.startsWith('Dockerfile.') ||
          fileName === 'docker-compose.yaml' || fileName === 'docker-compose.yml' ||
          normalized.indexOf('docker/') !== -1 || normalized.indexOf('docker\\') !== -1) {
        return {
          code: ERR_CODES.PROPOSAL_IN_NODE_MODULES,
          message: '[PROPOSAL_IN_NODE_MODULES] local-wrapper cannot modify Docker files: ' + pathStr + '. Docker changes require separate container configuration.'
        };
      }

      // Allow paths starting with src/ (or src\ on Windows)
      if (normalized.startsWith('src/') || normalized.startsWith('src\\')) return null;

      return {
        code: ERR_CODES.PROPOSAL_IN_NODE_MODULES,
        message: '[PROPOSAL_IN_NODE_MODULES] local-wrapper repairKind can only edit or create files under src/ (tracked source), but got: ' + pathStr + '. Reason: local wrappers are in-process fixes; --ignore-scripts prevents arbitrary scripts from running.'
      };
    }
    for (var lceI = 0; lceI < allEdits.length; lceI++) {
      var lceErr = checkSrcOnly(allEdits[lceI].path || '');
      if (lceErr) { errors.push(lceErr); break; }
    }
    for (var lcnI = 0; lcnI < allNewFiles.length; lcnI++) {
      var lcnErr = checkSrcOnly(allNewFiles[lcnI].path || '');
      if (lcnErr) { errors.push(lcnErr); break; }
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

  var pathFileMapKeys = Object.keys(pathFileMap);
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
  ERR_CODES: ERR_CODES,
  findClosestMatch: findClosestMatch
};
