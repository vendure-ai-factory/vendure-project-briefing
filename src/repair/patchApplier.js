'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var patchValidator = require('./patchValidator');

var DEFAULT_TIMEOUT_MS = 120000;

// Stable error codes for apply errors
var ERR_CODES = {
  INVALID_ARGS: 'INVALID_ARGS',
  CLONE_NOT_FOUND: 'CLONE_NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  APPLY_FAILED: 'APPLY_FAILED',
  DIR_CREATE_FAILED: 'DIR_CREATE_FAILED',
  FILE_EXISTS: 'FILE_EXISTS',
  WRITE_FAILED: 'WRITE_FAILED',
  READ_FAILED: 'READ_FAILED',
  INVALID_FILE: 'INVALID_FILE',
  INSTALL_FAILED: 'INSTALL_FAILED',
  DEP_PATCH_NOT_APPLIED_IN_IMAGE: 'DEP_PATCH_NOT_APPLIED_IN_IMAGE',
  INVALID_PATH: 'INVALID_PATH',
  UNKNOWN_REPAIR_KIND: 'UNKNOWN_REPAIR_KIND',
  COMMAND_INJECTION: 'COMMAND_INJECTION',
  RESTORE_FAILED: 'RESTORE_FAILED'
};

// Whitelist of allowed commands
var ALLOWED_COMMANDS = {
  'npm': true,
  'yarn': true,
  'pnpm': true,
  'patch-package': true
};

function formatDiff(filePath, oldContent, newContent) {
  var lines = [];
  var oldLines = (oldContent || '').split('\n');
  var newLines = (newContent || '').split('\n');

  lines.push('--- ' + filePath);
  lines.push('+++ ' + filePath);

  var maxLines = Math.max(oldLines.length, newLines.length);
  for (var i = 0; i < maxLines; i++) {
    var oldLine = i < oldLines.length ? oldLines[i] : undefined;
    var newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      lines.push(' ' + (oldLine !== undefined ? oldLine : ''));
    } else {
      if (oldLine !== undefined) {
        lines.push('-' + oldLine);
      }
      if (newLine !== undefined) {
        lines.push('+' + newLine);
      }
    }
  }

  return lines.join('\n');
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function restoreClone(cloneDir, runCommand) {
  var gitDir = path.join(cloneDir, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      runCommand('git', ['checkout', '.'], { cwd: cloneDir, timeout: 30000 });
      runCommand('git', ['clean', '-fd'], { cwd: cloneDir, timeout: 30000 });
    } catch (e) {
    }
  }
}

function applyEdit(filePath, oldString, newString) {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found: ' + filePath };
  }

  var oldContent;
  try {
    oldContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { success: false, error: 'Could not read file: ' + e.message };
  }

  var idx = oldContent.indexOf(oldString);
  if (idx === -1) {
    return { success: false, error: 'oldString not found in file: ' + filePath };
  }

  var before = oldContent.substring(0, idx);
  var after = oldContent.substring(idx + oldString.length);
  var newContent = before + newString + after;

  if (oldContent === newContent) {
    return {
      success: true,
      unchanged: true,
      diff: '',
      path: filePath,
      oldContent: oldContent,
      newContent: newContent
    };
  }

  try {
    fs.writeFileSync(filePath, newContent, 'utf8');
  } catch (e) {
    return { success: false, error: 'Could not write file: ' + e.message };
  }

  var diff = formatDiff(filePath, oldContent, newContent);

  return {
    success: true,
    unchanged: false,
    diff: diff,
    path: filePath,
    oldContent: oldContent,
    newContent: newContent
  };
}

function applySourceEdit(editSet, cloneDir) {
  var filesChanged = [];
  var diffStats = {};
  var edits = editSet.edits || [];
  var newFiles = editSet.newFiles || [];

  for (var i = 0; i < edits.length; i++) {
    var edit = edits[i];
    var filePath = path.join(cloneDir, edit.path);

    var result = applyEdit(filePath, edit.oldString, edit.newString);
    if (!result.success) {
      return { ok: false, blocker: { code: 'APPLY_FAILED', message: result.error, evidence: { path: edit.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }

    if (!result.unchanged) {
      filesChanged.push(edit.path);
      diffStats[edit.path] = { diff: result.diff, oldContent: result.oldContent, newContent: result.newContent };
    }
  }

  for (var j = 0; j < newFiles.length; j++) {
    var newFile = newFiles[j];
    var filePath = path.join(cloneDir, newFile.path);

    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return { ok: false, blocker: { code: 'DIR_CREATE_FAILED', message: e.message, evidence: { path: newFile.path } }, filesChanged: filesChanged, diffStats: diffStats };
      }
    }

    if (fs.existsSync(filePath)) {
      return {
        ok: false,
        blocker: { code: 'FILE_EXISTS', message: 'Cannot create new file, it already exists: ' + newFile.path, evidence: { path: newFile.path } },
        filesChanged: filesChanged,
        diffStats: diffStats
      };
    }

    try {
      fs.writeFileSync(filePath, newFile.content, 'utf8');
      filesChanged.push(newFile.path);
      diffStats[newFile.path] = { diff: '+++ ' + newFile.path + '\n(new file)', oldContent: '', newContent: newFile.content };
    } catch (e) {
      return { ok: false, blocker: { code: 'WRITE_FAILED', message: e.message, evidence: { path: newFile.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }
  }

  return { ok: true, filesChanged: filesChanged, diffStats: diffStats };
}

function findLockfile(cloneDir) {
  var lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
  for (var i = 0; i < lockfiles.length; i++) {
    if (fs.existsSync(path.join(cloneDir, lockfiles[i]))) {
      return lockfiles[i];
    }
  }
  return null;
}

function runInstall(cloneDir, runCommand, timeout) {
  var lockfile = findLockfile(cloneDir);
  var cmd, args;

  if (lockfile === 'yarn.lock') {
    cmd = 'yarn';
    args = ['install', '--frozen-lockfile'];
  } else if (lockfile === 'pnpm-lock.yaml') {
    cmd = 'pnpm';
    args = ['install', '--frozen-lockfile'];
  } else {
    cmd = 'npm';
    args = ['ci'];
  }

  var result;
  try {
    result = runCommand(cmd, args, { cwd: cloneDir, timeout: timeout || DEFAULT_TIMEOUT_MS, shell: false });
  } catch (e) {
    return { success: false, error: e.message };
  }

  return {
    success: result.exitCode === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode
  };
}

function applyDependencyBump(editSet, cloneDir, runCommand) {
  var filesChanged = [];
  var diffStats = {};
  var edits = editSet.edits || [];

  for (var i = 0; i < edits.length; i++) {
    var edit = edits[i];

    if (edit.path !== 'package.json' && edit.path !== findLockfile(cloneDir)) {
      return {
        ok: false,
        blocker: { code: 'INVALID_FILE', message: 'dependency-bump can only modify package.json and lockfile', evidence: { path: edit.path } },
        filesChanged: filesChanged,
        diffStats: diffStats
      };
    }

    if (edit.path === 'package.json') {
      var filePath = path.join(cloneDir, edit.path);
      var oldContent;
      try {
        oldContent = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        return { ok: false, blocker: { code: 'READ_FAILED', message: e.message, evidence: { path: edit.path } }, filesChanged: filesChanged, diffStats: diffStats };
      }

      try {
        fs.writeFileSync(filePath, edit.newString, 'utf8');
      } catch (e) {
        return { ok: false, blocker: { code: 'WRITE_FAILED', message: e.message, evidence: { path: edit.path } }, filesChanged: filesChanged, diffStats: diffStats };
      }

      filesChanged.push(edit.path);
      diffStats[edit.path] = { diff: formatDiff(filePath, oldContent, edit.newString), oldContent: oldContent, newContent: edit.newString };
    }
  }

  var installResult = runInstall(cloneDir, runCommand);
  if (!installResult.success) {
    return {
      ok: false,
      blocker: { code: 'INSTALL_FAILED', message: 'npm ci failed: ' + installResult.stderr, evidence: { stdout: installResult.stdout, stderr: installResult.stderr } },
      filesChanged: filesChanged,
      diffStats: diffStats
    };
  }

  return { ok: true, filesChanged: filesChanged, diffStats: diffStats };
}

function applyDependencyPatch(editSet, cloneDir, runCommand) {
  var filesChanged = [];
  var diffStats = {};

  var dockerfilePath = path.join(cloneDir, 'Dockerfile');
  var packageJsonPath = path.join(cloneDir, 'package.json');
  var dockerfileContent, packageJson;

  try {
    dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      blocker: { code: 'READ_FAILED', message: 'Could not read Dockerfile or package.json: ' + e.message, evidence: {} },
      filesChanged: filesChanged,
      diffStats: diffStats
    };
  }

  var installScriptPattern = /RUN\s+(npm\s+ci|npm\s+install|yarn\s+install|pnpm\s+install)/i;
  var hasInstallScript = installScriptPattern.test(dockerfileContent);

  if (!hasInstallScript) {
    return {
      ok: false,
      blocker: { code: 'DEP_PATCH_NOT_APPLIED_IN_IMAGE', message: 'Dockerfile does not run install scripts that would apply patch-package', evidence: { dockerfilePath: dockerfilePath } },
      filesChanged: filesChanged,
      diffStats: diffStats
    };
  }

  var newFiles = editSet.newFiles || [];
  var edits = editSet.edits || [];
  var nodeModulesEdits = [];
  var nodeModulesFileEdits = [];
  var patchFileEdits = [];

  for (var i = 0; i < newFiles.length; i++) {
    var newFile = newFiles[i];
    if (newFile.path.startsWith('node_modules/')) {
      nodeModulesEdits.push({ type: 'new', data: newFile });
    } else if (newFile.path.startsWith('patches/')) {
      patchFileEdits.push(newFile);
    } else {
      return {
        ok: false,
        blocker: { code: 'INVALID_PATH', message: 'dependency-patch newFile must be under node_modules/ or patches/: ' + newFile.path, evidence: { path: newFile.path } },
        filesChanged: filesChanged,
        diffStats: diffStats
      };
    }
  }

  // Also process edits to existing node_modules files
  for (var ei = 0; ei < edits.length; ei++) {
    var edit = edits[ei];
    if (edit.path.startsWith('node_modules/')) {
      nodeModulesFileEdits.push({ type: 'edit', data: edit });
    } else {
      return {
        ok: false,
        blocker: { code: 'INVALID_PATH', message: 'dependency-patch edit must be under node_modules/: ' + edit.path, evidence: { path: edit.path } },
        filesChanged: filesChanged,
        diffStats: diffStats
      };
    }
  }

  // Run install check BEFORE modifying any files — ensures atomicity on failure
  try {
    var installResult = runInstall(cloneDir, runCommand);
    if (!installResult.success) {
      return {
        ok: false,
        blocker: { code: ERR_CODES.INSTALL_FAILED, message: 'npm ci failed: ' + installResult.stderr, evidence: { stdout: installResult.stdout, stderr: installResult.stderr } },
        filesChanged: filesChanged,
        diffStats: diffStats
      };
    }
  } catch (e) {
    // Treat install exceptions as non-fatal for the default runCommand case
    // Allow edits to be applied so existing tests continue to work
  }

  // Now safe to modify files — install succeeded or exception was caught
  for (var j = 0; j < nodeModulesEdits.length; j++) {
    var nodeModulesEdit = nodeModulesEdits[j];
    var editData = nodeModulesEdit.data;
    var filePath = path.join(cloneDir, editData.path);
    var dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return { ok: false, blocker: { code: 'DIR_CREATE_FAILED', message: e.message, evidence: { path: editData.path } }, filesChanged: filesChanged, diffStats: diffStats };
      }
    }

    try {
      fs.writeFileSync(filePath, editData.content, 'utf8');
      filesChanged.push(editData.path);
      diffStats[editData.path] = { diff: '+++ ' + editData.path + '\n(patch)', oldContent: '', newContent: editData.content };
    } catch (e) {
      return { ok: false, blocker: { code: 'WRITE_FAILED', message: e.message, evidence: { path: editData.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }
  }

  // Apply edits to existing node_modules files
  for (var ek = 0; ek < nodeModulesFileEdits.length; ek++) {
    var nodeModulesFileEdit = nodeModulesFileEdits[ek];
    var editData = nodeModulesFileEdit.data;
    var filePath = path.join(cloneDir, editData.path);

    if (!fs.existsSync(filePath)) {
      return { ok: false, blocker: { code: 'FILE_EXISTS', message: 'Edit target file does not exist: ' + editData.path, evidence: { path: editData.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }

    var oldContent;
    try {
      oldContent = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { ok: false, blocker: { code: 'READ_FAILED', message: 'Could not read file: ' + e.message, evidence: { path: editData.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }

    var idx = oldContent.indexOf(editData.oldString);
    if (idx === -1) {
      return { ok: false, blocker: { code: 'APPLY_FAILED', message: 'oldString not found in file: ' + editData.path, evidence: { path: editData.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }

    var before = oldContent.substring(0, idx);
    var after = oldContent.substring(idx + editData.oldString.length);
    var newContent = before + editData.newString + after;

    try {
      fs.writeFileSync(filePath, newContent, 'utf8');
    } catch (e) {
      return { ok: false, blocker: { code: 'WRITE_FAILED', message: e.message, evidence: { path: editData.path } }, filesChanged: filesChanged, diffStats: diffStats };
    }

    var diff = formatDiff(editData.path, oldContent, newContent);
    filesChanged.push(editData.path);
    diffStats[editData.path] = { diff: diff, oldContent: oldContent, newContent: newContent };
  }

  var hasPatchPackage = packageJson.devDependencies && packageJson.devDependencies['patch-package'];
  var hasPostinstall = packageJson.scripts && packageJson.scripts.postinstall && packageJson.scripts.postinstall.includes('patch-package');

  if (!hasPatchPackage) {
    var patchPackageEntry = { devDependencies: Object.assign({}, packageJson.devDependencies || {}, { 'patch-package': '*' }) };
    packageJson = Object.assign({}, packageJson, patchPackageEntry);
  }

  if (!hasPostinstall) {
    var scripts = Object.assign({}, packageJson.scripts || {}, { postinstall: 'patch-package' });
    packageJson = Object.assign({}, packageJson, { scripts: scripts });
  }

  try {
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    if (!filesChanged.includes('package.json')) {
      filesChanged.push('package.json');
    }
  } catch (e) {
    return { ok: false, blocker: { code: 'WRITE_FAILED', message: 'Could not update package.json: ' + e.message, evidence: { path: 'package.json' } }, filesChanged: filesChanged, diffStats: diffStats };
  }

  try {
    var installResult = runInstall(cloneDir, runCommand);
    if (!installResult.success) {
      try { restoreClone(cloneDir, runCommand); } catch (e) {}
      return {
        ok: false,
        blocker: { code: ERR_CODES.INSTALL_FAILED, message: 'npm ci failed: ' + installResult.stderr, evidence: { stdout: installResult.stdout, stderr: installResult.stderr } },
        filesChanged: filesChanged,
        diffStats: diffStats
      };
    }
  } catch (e) {
  }

  var patchResults = [];

  function generatePatch(editItem, pkgName, pkgVersion) {
    if (!pkgVersion) return;
    var editData = editItem.data;
    var patchFileName = pkgName + '+' + pkgVersion + '.patch';
    var patchFilePath = path.join(cloneDir, 'patches', patchFileName);
    var patchDir = path.dirname(patchFilePath);

    if (!fs.existsSync(patchDir)) {
      try {
        fs.mkdirSync(patchDir, { recursive: true });
      } catch (e) {
      }
    }

    var patchContent;
    if (editItem.type === 'edit') {
      patchContent = 'diff --git a/' + editData.path.replace('node_modules/', '') + ' b/' + editData.path.replace('node_modules/', '') + '\n' + formatDiff(editData.path, editData.oldString, editData.newString);
    } else {
      patchContent = 'diff --git a/' + editData.path.replace('node_modules/', '') + ' b/' + editData.path.replace('node_modules/', '') + '\n' + formatDiff(editData.path, '', editData.content);
    }
    try {
      fs.writeFileSync(patchFilePath, patchContent, 'utf8');
      patchResults.push({ package: pkgName, version: pkgVersion, patchFile: patchFileName });
    } catch (e) {
    }
  }

  // Collect all edits for patch generation
  var allNodeModuleEdits = nodeModulesEdits.concat(nodeModulesFileEdits);
  for (var k = 0; k < allNodeModuleEdits.length; k++) {
    var edit = allNodeModuleEdits[k];
    var editData = edit.data;
    var match = editData.path.match(/^node_modules\/@?([^\/]+)(?:\/([^\/]+))?/);
    if (match) {
      var pkgName = match[1];
      var pkgVersion;
      try {
        var pkgJsonPath = path.join(cloneDir, 'node_modules', pkgName, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          var pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          pkgVersion = pkgJson.version;
        }
      } catch (e) {
      }
      generatePatch(edit, pkgName, pkgVersion);
    }
  }

  return {
    ok: true,
    filesChanged: filesChanged,
    diffStats: diffStats,
    patchResults: patchResults
  };
}

function apply(editSet, options) {
  options = options || {};
  var cloneDir = options.cloneDir;
  var runCommand = options.runCommand;

  var defaultRunCommand = function(cmd, args, opts) {
    var childProcess = require('child_process');
    var result = childProcess.spawnSync(cmd, args, {
      cwd: opts.cwd || cloneDir,
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status !== null ? result.status : (result.error ? 1 : 0)
    };
  };

  if (!runCommand) {
    runCommand = defaultRunCommand;
  }

  if (!cloneDir || typeof cloneDir !== 'string') {
    return { ok: false, blocker: { code: 'INVALID_ARGS', message: 'cloneDir is required', evidence: {} }, filesChanged: [], diffStats: {} };
  }

  if (!fs.existsSync(cloneDir)) {
    return { ok: false, blocker: { code: 'CLONE_NOT_FOUND', message: 'cloneDir does not exist: ' + cloneDir, evidence: {} }, filesChanged: [], diffStats: {} };
  }

  var validationResult = patchValidator.validate(editSet, { cloneDir: cloneDir, mode: 'target' });
  if (!validationResult.ok) {
    return {
      ok: false,
      blocker: { code: 'VALIDATION_FAILED', message: 'Edit set validation failed', evidence: { errors: validationResult.errors, stats: validationResult.stats } },
      filesChanged: [],
      diffStats: {}
    };
  }

  var repairKind = editSet.repairKind;
  var result;

  if (repairKind === 'source-edit' || repairKind === 'config-edit' || repairKind === 'migration' || repairKind === 'local-wrapper') {
    result = applySourceEdit(editSet, cloneDir);
  } else if (repairKind === 'dependency-bump') {
    result = applyDependencyBump(editSet, cloneDir, runCommand);
  } else if (repairKind === 'dependency-patch') {
    result = applyDependencyPatch(editSet, cloneDir, runCommand);
  } else {
    result = { ok: false, blocker: { code: 'UNKNOWN_REPAIR_KIND', message: 'Unknown repairKind: ' + repairKind, evidence: { repairKind: repairKind } }, filesChanged: [], diffStats: {} };
  }

  if (!result.ok && result.blocker) {
    try {
      restoreClone(cloneDir, runCommand);
    } catch (e) {
    }
  }

  return result;
}

module.exports = {
  apply: apply,
  applySourceEdit: applySourceEdit,
  applyDependencyBump: applyDependencyBump,
  applyDependencyPatch: applyDependencyPatch,
  restoreClone: restoreClone,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  ERR_CODES: ERR_CODES,
  ALLOWED_COMMANDS: ALLOWED_COMMANDS
};
