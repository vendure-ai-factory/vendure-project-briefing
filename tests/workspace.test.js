'use strict';

var workspaceModule = require('../src/workspace');
var path = require('path');
var fs = require('fs');

var test = require('node:test');
var assert = require('node:assert');

var TEST_WORKSPACE_ROOT = path.resolve(__dirname, 'test-workspace-temp');

test('workspace: workspace created', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);

  assert.strictEqual(result.success, true, 'Workspace creation should succeed');
  assert.ok(result.workspace, 'Workspace object should be returned');
  assert.ok(result.workspace.workspaceId, 'Workspace should have an ID');
  done();
});

test('workspace: workspace ID generated', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);

  assert.ok(result.workspace.workspaceId.startsWith('ws-'), 'Workspace ID should start with "ws-"');
  done();
});

test('workspace: workspace path exists', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);

  assert.strictEqual(result.workspace.exists, true, 'Workspace should exist on disk');
  assert.ok(fs.existsSync(result.workspace.workspacePath), 'Workspace path should exist');
  done();
});

test('workspace: file can be created inside workspace', function(t, done) {
  workspaceModule.clearWorkspaces();
  var createResult = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = createResult.workspace;

  var writeResult = workspaceModule.writeFileInsideWorkspace(
    workspace.workspaceId,
    'test-file.txt',
    'Test content'
  );

  assert.strictEqual(writeResult.success, true, 'File write should succeed');
  assert.ok(fs.existsSync(writeResult.path), 'File should exist on disk');

  var readResult = workspaceModule.readFileInsideWorkspace(workspace.workspaceId, 'test-file.txt');
  assert.strictEqual(readResult.success, true, 'File read should succeed');
  assert.strictEqual(readResult.content, 'Test content', 'File content should match');
  done();
});

test('workspace: workspace boundary can be checked', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  var insidePath = path.join(workspace.workspacePath, 'subdir', 'file.txt');
  var insideResult = workspaceModule.isPathInsideWorkspace(workspace.workspacePath, insidePath);
  assert.strictEqual(insideResult, true, 'Path inside workspace should be detected');

  var outsidePath = path.join(workspace.workspacePath, '..', 'outside.txt');
  var outsideResult = workspaceModule.isPathInsideWorkspace(workspace.workspacePath, outsidePath);
  assert.strictEqual(outsideResult, false, 'Path outside workspace should be rejected');

  done();
});

test('workspace: workspace cleanup works', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;
  var workspacePath = workspace.workspacePath;

  workspaceModule.writeFileInsideWorkspace(workspace.workspaceId, 'test.txt', 'content');
  assert.ok(fs.existsSync(workspacePath), 'Workspace should exist before destroy');

  var destroyResult = workspaceModule.destroyWorkspace(workspace.workspaceId);
  assert.strictEqual(destroyResult.success, true, 'Workspace destroy should succeed');
  assert.ok(!fs.existsSync(workspacePath), 'Workspace should not exist after destroy');
  done();
});

test('workspace: getWorkspace returns workspace', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  var retrieved = workspaceModule.getWorkspace(workspace.workspaceId);
  assert.deepStrictEqual(retrieved, workspace, 'Retrieved workspace should match original');
  done();
});

test('workspace: getWorkspacePath returns path', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  var retrievedPath = workspaceModule.getWorkspacePath(workspace.workspaceId);
  assert.strictEqual(retrievedPath, workspace.workspacePath, 'Retrieved path should match');
  done();
});

test('workspace: workspaceExists checks existence', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  assert.strictEqual(workspaceModule.workspaceExists(workspace.workspaceId), true, 'Created workspace should exist');
  assert.strictEqual(workspaceModule.workspaceExists('nonexistent'), false, 'Nonexistent workspace should not exist');
  done();
});

test('workspace: write outside boundary rejected', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  var writeResult = workspaceModule.writeFileInsideWorkspace(
    workspace.workspaceId,
    '../../../etc/passwd',
    'malicious'
  );

  assert.strictEqual(writeResult.success, false, 'Write outside workspace should be rejected');
  assert.ok(writeResult.error.includes('outside workspace'), 'Error should mention workspace boundary');
  done();
});

test('workspace: write with directory traversal rejected', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  var writeResult = workspaceModule.writeFileInsideWorkspace(
    workspace.workspaceId,
    'subdir/../../../etc/passwd',
    'malicious'
  );

  assert.strictEqual(writeResult.success, false, 'Write with directory traversal should be rejected');
  done();
});

test('workspace: read nonexistent file fails', function(t, done) {
  workspaceModule.clearWorkspaces();
  var result = workspaceModule.createWorkspace(TEST_WORKSPACE_ROOT);
  var workspace = result.workspace;

  var readResult = workspaceModule.readFileInsideWorkspace(workspace.workspaceId, 'nonexistent.txt');
  assert.strictEqual(readResult.success, false, 'Read nonexistent file should fail');
  done();
});

test('workspace: destroy nonexistent workspace fails', function(t, done) {
  workspaceModule.clearWorkspaces();
  var destroyResult = workspaceModule.destroyWorkspace('nonexistent-id');
  assert.strictEqual(destroyResult.success, false, 'Destroy nonexistent workspace should fail');
  done();
});

test.after(function() {
  workspaceModule.clearWorkspaces();
  if (fs.existsSync(TEST_WORKSPACE_ROOT)) {
    try {
      fs.rmSync(TEST_WORKSPACE_ROOT, { recursive: true, force: true });
    } catch (e) {
    }
  }
});