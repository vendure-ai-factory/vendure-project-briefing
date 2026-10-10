'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PROTECTED_PATTERNS = [
  { pattern: /manifest\//, reason: 'manifest/ is protected' },
  { pattern: /frozen\//, reason: 'frozen/ is protected' },
  { pattern: /acceptance-manifest.*\.json$/, reason: 'acceptance-manifest files are protected' },
  { pattern: /evaluation-demo\/migration-input\//, reason: 'evaluation-demo/migration-input/ is protected' },
  { pattern: /\.env$/, reason: '.env files are protected' },
  { pattern: /[\/\\]AGENTS\.md$/, reason: 'AGENTS.md is protected' }
];

var workspaceRoot = null;
var additionalProtectedPaths = [];

function setWorkspaceRoot(root) {
  workspaceRoot = root ? path.resolve(root) : null;
}

function addProtectedPaths(paths, options) {
  options = options || {};
  if (Array.isArray(paths)) {
    for (var i = 0; i < paths.length; i++) {
      if (typeof paths[i] === 'string') {
        var p = paths[i];
        if (workspaceRoot && !path.isAbsolute(p)) {
          p = path.resolve(workspaceRoot, p);
        }
        additionalProtectedPaths.push(p);
      }
    }
  }
}

function isPathProtected(filePath) {
  if (!filePath) return false;
  var resolved = path.resolve(filePath);

  for (var i = 0; i < PROTECTED_PATTERNS.length; i++) {
    var entry = PROTECTED_PATTERNS[i];
    if (entry.pattern.test(resolved) || entry.pattern.test(filePath)) {
      return { protected: true, reason: entry.reason };
    }
  }

  for (var j = 0; j < additionalProtectedPaths.length; j++) {
    var protectedPath = additionalProtectedPaths[j];
    var isAbs = path.isAbsolute(protectedPath);
    var checkPath = isAbs ? path.resolve(protectedPath) : path.resolve(protectedPath);
    var isInside = resolved.startsWith(checkPath + path.sep) || resolved === checkPath;
    if (isInside) {
      return { protected: true, reason: 'Path in protected list: ' + checkPath };
    }
  }

  return { protected: false };
}

function isPathInsideWorkspace(targetPath) {
  if (!workspaceRoot) return false;
  var resolved = path.resolve(targetPath);
  if (resolved.startsWith(workspaceRoot + path.sep)) return true;
  if (resolved === workspaceRoot) return true;
  return false;
}

function applyPatch(filePath, newContent, options) {
  options = options || {};
  var logger = options.logger || null;

  if (!workspaceRoot) {
    return {
      success: false,
      error: 'Workspace root not set',
      errorCode: 'WORKSPACE_ROOT_NOT_SET'
    };
  }

  var resolvedPath = path.resolve(filePath);

  if (!isPathInsideWorkspace(resolvedPath)) {
    return {
      success: false,
      error: 'File path is outside workspace boundary: ' + filePath,
      errorCode: 'PATH_OUTSIDE_WORKSPACE'
    };
  }

  var protectionCheck = isPathProtected(resolvedPath);
  if (protectionCheck.protected) {
    if (logger && logger.warn) {
      logger.warn('PATCH_REJECTED', 'Patch to protected path rejected', {
        path: filePath,
        reason: protectionCheck.reason
      });
    }
    return {
      success: false,
      error: 'Cannot patch protected path: ' + filePath,
      errorCode: 'PROTECTED_PATH_REJECTED',
      reason: protectionCheck.reason,
      path: filePath
    };
  }

  var oldContent = null;
  var fileExisted = fs.existsSync(resolvedPath);

  if (fileExisted) {
    try {
      oldContent = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      return {
        success: false,
        error: 'Failed to read file: ' + err.message,
        errorCode: 'FILE_READ_ERROR'
      };
    }
  } else {
    oldContent = '';
  }

  if (!options.onlyIfExists && !fileExisted) {
    var dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return {
          success: false,
          error: 'Failed to create directory: ' + err.message,
          errorCode: 'DIR_CREATE_ERROR'
        };
      }
    }
  }

  if (fileExisted && oldContent === newContent) {
    return {
      success: true,
      unchanged: true,
      diff: '',
      path: resolvedPath
    };
  }

  try {
    fs.writeFileSync(resolvedPath, newContent, 'utf8');
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write file: ' + err.message,
      errorCode: 'FILE_WRITE_ERROR'
    };
  }

  var diff = formatDiff(resolvedPath, oldContent, newContent);

  return {
    success: true,
    unchanged: false,
    diff: diff,
    path: resolvedPath,
    oldContent: oldContent,
    newContent: newContent
  };
}

function replaceInFile(filePath, oldString, newString, options) {
  options = options || {};
  var logger = options.logger || null;

  if (!workspaceRoot) {
    return {
      success: false,
      error: 'Workspace root not set',
      errorCode: 'WORKSPACE_ROOT_NOT_SET'
    };
  }

  var resolvedPath = path.resolve(filePath);

  if (!isPathInsideWorkspace(resolvedPath)) {
    return {
      success: false,
      error: 'File path is outside workspace boundary: ' + filePath,
      errorCode: 'PATH_OUTSIDE_WORKSPACE'
    };
  }

  var protectionCheck = isPathProtected(resolvedPath);
  if (protectionCheck.protected) {
    if (logger && logger.warn) {
      logger.warn('PATCH_REJECTED', 'Patch to protected path rejected', {
        path: filePath,
        reason: protectionCheck.reason
      });
    }
    return {
      success: false,
      error: 'Cannot patch protected path: ' + filePath,
      errorCode: 'PROTECTED_PATH_REJECTED',
      reason: protectionCheck.reason,
      path: filePath
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      error: 'File not found: ' + filePath,
      errorCode: 'FILE_NOT_FOUND'
    };
  }

  var oldContent;
  try {
    oldContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    return {
      success: false,
      error: 'Failed to read file: ' + err.message,
      errorCode: 'FILE_READ_ERROR'
    };
  }

  var idx = oldContent.indexOf(oldString);
  if (idx === -1) {
    return {
      success: false,
      error: 'Old string not found in file: ' + filePath,
      errorCode: 'STRING_NOT_FOUND',
      path: filePath
    };
  }

  var before = oldContent.substring(0, idx);
  var after = oldContent.substring(idx + oldString.length);
  var newContent = before + newString + after;

  if (oldContent === newContent) {
    return {
      success: true,
      unchanged: true,
      diff: '',
      path: resolvedPath
    };
  }

  try {
    fs.writeFileSync(resolvedPath, newContent, 'utf8');
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write file: ' + err.message,
      errorCode: 'FILE_WRITE_ERROR'
    };
  }

  var diff = formatDiff(resolvedPath, oldContent, newContent);

  return {
    success: true,
    unchanged: false,
    diff: diff,
    path: resolvedPath,
    oldContent: oldContent,
    newContent: newContent
  };
}

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

function setupDemoWorkspaceProtection(workspaceRootPath) {
  setWorkspaceRoot(workspaceRootPath);
  addProtectedPaths([
    'evaluation-demo/app/tests/',
    'evaluation-demo/app/fixtures/',
    'evaluation-demo/scripts/',
    'evaluation-demo/task.md',
    'evaluation-demo/app/package.json'
  ]);
}

function getProtectedPatterns() {
  return PROTECTED_PATTERNS.map(function(p) { return p.pattern.source; });
}

function clearDemoWorkspaceProtection() {
  additionalProtectedPaths = [];
}

module.exports = {
  setWorkspaceRoot: setWorkspaceRoot,
  addProtectedPaths: addProtectedPaths,
  setupDemoWorkspaceProtection: setupDemoWorkspaceProtection,
  clearDemoWorkspaceProtection: clearDemoWorkspaceProtection,
  isPathProtected: isPathProtected,
  applyPatch: applyPatch,
  replaceInFile: replaceInFile,
  getProtectedPatterns: getProtectedPatterns
};
