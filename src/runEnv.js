'use strict';

var os = require('os');

function collectRunEnvironment(deps) {
  deps = deps || {};

  var fs = deps.fs || require('fs');
  var pathModule = deps.path || require('path');
  var childProcess = deps.childProcess || require('child_process');
  var crypto = deps.crypto || require('crypto');

  var root = deps.root || process.cwd();

  var record = {
    runId: deps.runId || null,
    revisionId: deps.revisionId || null,
    startedAt: deps.startedAt || new Date().toISOString(),
    gitHead: null,
    gitError: null,
    migrationInputTreeHashAtHead: null,
    migrationInputTreeHashAtPinned: null,
    treeHashComparison: null,
    executionRevisionNote: null,
    pinnedExecutionCommit: null,
    referenceCommit: null,
    manifestVersion: null,
    expectedValuesHash: null,
    nodeVersion: process.version,
    platform: process.platform,
    stagingUrl: null,
    healthProbeResult: null,
    preflightResult: null,
    envVarsChecked: [],
    frozenHashesChecked: [],
    workspaceCleanup: null,
    taskId: deps.taskId || null,
    scope: deps.scope || null,
    classification: deps.classification || null,
    result: deps.result || null,
    exitCode: deps.exitCode || null
  };

  if (deps.manifest) {
    record.pinnedExecutionCommit = deps.manifest.source ? deps.manifest.source.pinnedExecutionCommit : null;
    record.referenceCommit = deps.manifest.source ? deps.manifest.source.referenceCommit : null;
    record.manifestVersion = deps.manifest.manifestVersion || null;
    if (deps.manifest.integrity) {
      record.expectedValuesHash = deps.manifest.integrity.expectedValuesHash || null;
    }
    if (deps.registry) {
      record.stagingUrl = getFrozenValue(deps.registry, 'stagingUrl');
    }
  }

  var gitResult = getGitHead(root, childProcess);
  record.gitHead = gitResult.hash;
  record.gitError = gitResult.error || null;

  var migrationInputSubpath = 'evaluation-demo/migration-input';
  var pinnedCommit = record.pinnedExecutionCommit || (deps.manifest && deps.manifest.source ? deps.manifest.source.pinnedRepoCommit : null);

  record.migrationInputTreeHashAtHead = getTreeHash(root, migrationInputSubpath, 'HEAD', childProcess);
  if (pinnedCommit) {
    record.migrationInputTreeHashAtPinned = getTreeHash(root, migrationInputSubpath, pinnedCommit, childProcess);
  }

  if (record.gitHead === null) {
    record.treeHashComparison = 'UNAVAILABLE';
  } else if (record.migrationInputTreeHashAtHead && record.migrationInputTreeHashAtPinned) {
    if (record.migrationInputTreeHashAtHead === record.migrationInputTreeHashAtPinned) {
      record.treeHashComparison = 'MATCH';
    } else {
      record.treeHashComparison = 'DIFFER';
      record.executionRevisionNote = 'git rev-parse HEAD must equal the pinned commit';
    }
  }

  return record;
}

function getGitHead(repoRoot, childProcess) {
  try {
    var result = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    });
    return { hash: result.trim(), error: null };
  } catch (e) {
    return { hash: null, error: e.message || String(e) };
  }
}

function getTreeHash(repoRoot, subpath, commit, childProcess) {
  try {
    var output = childProcess.execFileSync('git', ['ls-tree', commit, subpath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    }).trim();

    var parts = output.split(/\s+/);
    if (parts.length >= 3 && parts[1] === 'tree') {
      return parts[2];
    }
    return null;
  } catch (e) {
    return null;
  }
}

function getFrozenValue(registry, inputId) {
  if (!registry || !Array.isArray(registry.inputs)) return null;
  for (var i = 0; i < registry.inputs.length; i++) {
    if (registry.inputs[i].id === inputId) {
      return registry.inputs[i].frozenValue || null;
    }
  }
  return null;
}

function addEnvVarChecked(record, name, present) {
  if (!record.envVarsChecked) record.envVarsChecked = [];
  for (var i = 0; i < record.envVarsChecked.length; i++) {
    if (record.envVarsChecked[i].name === name) return;
  }
  record.envVarsChecked.push({ name: name, present: !!present });
}

function addFrozenHashChecked(record, inputId, frozenHash) {
  if (!record.frozenHashesChecked) record.frozenHashesChecked = [];
  record.frozenHashesChecked.push({ inputId: inputId, frozenHash: frozenHash || null });
}

module.exports = {
  collectRunEnvironment: collectRunEnvironment,
  addEnvVarChecked: addEnvVarChecked,
  addFrozenHashChecked: addFrozenHashChecked,
  getGitHead: getGitHead,
  getTreeHash: getTreeHash,
  getFrozenValue: getFrozenValue
};
