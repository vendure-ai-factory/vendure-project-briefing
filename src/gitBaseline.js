'use strict';

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

var gitAvailable = null;

function isGitAvailable() {
  if (gitAvailable !== null) {
    return gitAvailable;
  }

  try {
    execSync('git --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    gitAvailable = true;
  } catch (err) {
    gitAvailable = false;
  }

  return gitAvailable;
}

function captureBaseline(repoPath) {
  var baseline = {
    repositoryPath: repoPath,
    branch: null,
    currentCommit: null,
    baselineCommit: null,
    commitMessage: null,
    authorName: null,
    authorEmail: null,
    committedAt: null,
    isDirty: false,
    capturedAt: new Date().toISOString(),
    gitAvailable: isGitAvailable()
  };

  if (!isGitAvailable()) {
    baseline.error = 'Git is not available';
    return baseline;
  }

  try {
    var resolvedPath = path.resolve(repoPath);

    baseline.branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: resolvedPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    baseline.currentCommit = execSync('git rev-parse HEAD', {
      cwd: resolvedPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    baseline.baselineCommit = baseline.currentCommit;

    var logOutput = execSync('git log -1 --format="%H|%s|%an|%ae|%ci"', {
      cwd: resolvedPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    var parts = logOutput.split('|');
    if (parts.length >= 5) {
      baseline.commitMessage = parts[1];
      baseline.authorName = parts[2];
      baseline.authorEmail = parts[3];
      baseline.committedAt = parts[4];
    }

    var statusOutput = execSync('git status --porcelain', {
      cwd: resolvedPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    baseline.isDirty = statusOutput.length > 0;

  } catch (err) {
    baseline.error = 'Failed to capture baseline: ' + err.message;
  }

  return baseline;
}

function hasUncommittedChanges(repoPath) {
  if (!isGitAvailable()) {
    return null;
  }

  try {
    var resolvedPath = path.resolve(repoPath);
    var statusOutput = execSync('git status --porcelain', {
      cwd: resolvedPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return statusOutput.length > 0;
  } catch (err) {
    return null;
  }
}

function getCurrentCommit(repoPath) {
  if (!isGitAvailable()) {
    return null;
  }

  try {
    var resolvedPath = path.resolve(repoPath);
    return execSync('git rev-parse HEAD', {
      cwd: resolvedPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    return null;
  }
}

function serializeBaseline(baseline) {
  return JSON.stringify(baseline, null, 2);
}

function deserializeBaseline(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return null;
  }
}

module.exports = {
  isGitAvailable: isGitAvailable,
  captureBaseline: captureBaseline,
  hasUncommittedChanges: hasUncommittedChanges,
  getCurrentCommit: getCurrentCommit,
  serializeBaseline: serializeBaseline,
  deserializeBaseline: deserializeBaseline
};