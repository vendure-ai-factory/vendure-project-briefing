'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var workspaces = {};

function generateWorkspaceId() {
  var timestamp = Date.now().toString(36).toLowerCase();
  var randomPart = crypto.randomBytes(4).toString('hex');
  return 'ws-' + timestamp + '-' + randomPart;
}

function createWorkspace(rootPath, runId) {
  var workspaceId = generateWorkspaceId();
  var workspacePath = path.resolve(rootPath, runId || workspaceId);

  try {
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to create workspace: ' + err.message
    };
  }

  var workspace = {
    workspaceId: workspaceId,
    workspacePath: workspacePath,
    runId: runId || null,
    createdAt: new Date().toISOString(),
    exists: fs.existsSync(workspacePath)
  };

  workspaces[workspaceId] = workspace;

  return {
    success: true,
    workspace: workspace
  };
}

function getWorkspace(workspaceId) {
  return workspaces[workspaceId] || null;
}

function getWorkspacePath(workspaceId) {
  var workspace = workspaces[workspaceId];
  if (!workspace) {
    return null;
  }
  return workspace.workspacePath;
}

function workspaceExists(workspaceId) {
  var workspace = workspaces[workspaceId];
  if (!workspace) {
    return false;
  }
  return fs.existsSync(workspace.workspacePath);
}

function isPathInsideWorkspace(workspacePath, targetPath) {
  var resolvedWorkspace = path.resolve(workspacePath);
  var resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget.startsWith(resolvedWorkspace + path.sep)) {
    return true;
  }
  if (resolvedTarget === resolvedWorkspace) {
    return true;
  }
  return false;
}

function writeFileInsideWorkspace(workspaceId, relativePath, content) {
  var workspace = workspaces[workspaceId];
  if (!workspace) {
    return {
      success: false,
      error: 'Workspace not found: ' + workspaceId
    };
  }

  var fullPath = path.resolve(workspace.workspacePath, relativePath);
  var dirPath = path.dirname(fullPath);

  if (!isPathInsideWorkspace(workspace.workspacePath, fullPath)) {
    return {
      success: false,
      error: 'Path is outside workspace boundary: ' + relativePath
    };
  }

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
    return {
      success: true,
      path: fullPath
    };
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write file: ' + err.message
    };
  }
}

function readFileInsideWorkspace(workspaceId, relativePath) {
  var workspace = workspaces[workspaceId];
  if (!workspace) {
    return {
      success: false,
      error: 'Workspace not found: ' + workspaceId
    };
  }

  var fullPath = path.resolve(workspace.workspacePath, relativePath);

  if (!isPathInsideWorkspace(workspace.workspacePath, fullPath)) {
    return {
      success: false,
      error: 'Path is outside workspace boundary: ' + relativePath
    };
  }

  try {
    if (!fs.existsSync(fullPath)) {
      return {
        success: false,
        error: 'File not found: ' + relativePath
      };
    }
    var content = fs.readFileSync(fullPath, 'utf8');
    return {
      success: true,
      content: content,
      path: fullPath
    };
  } catch (err) {
    return {
      success: false,
      error: 'Failed to read file: ' + err.message
    };
  }
}

function destroyWorkspace(workspaceId) {
  var workspace = workspaces[workspaceId];
  if (!workspace) {
    return {
      success: false,
      error: 'Workspace not found: ' + workspaceId
    };
  }

  try {
    if (fs.existsSync(workspace.workspacePath)) {
      fs.rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
    delete workspaces[workspaceId];
    return {
      success: true
    };
  } catch (err) {
    return {
      success: false,
      error: 'Failed to destroy workspace: ' + err.message
    };
  }
}

function listWorkspaces() {
  return Object.keys(workspaces);
}

function clearWorkspaces() {
  workspaces = {};
}

module.exports = {
  generateWorkspaceId: generateWorkspaceId,
  createWorkspace: createWorkspace,
  getWorkspace: getWorkspace,
  getWorkspacePath: getWorkspacePath,
  workspaceExists: workspaceExists,
  isPathInsideWorkspace: isPathInsideWorkspace,
  writeFileInsideWorkspace: writeFileInsideWorkspace,
  readFileInsideWorkspace: readFileInsideWorkspace,
  destroyWorkspace: destroyWorkspace,
  listWorkspaces: listWorkspaces,
  clearWorkspaces: clearWorkspaces
};