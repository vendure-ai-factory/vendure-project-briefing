'use strict';

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');

function generateShortId() {
  var timestamp = Date.now().toString(36).toLowerCase();
  var randomPart = crypto.randomBytes(3).toString('hex');
  return timestamp + '-' + randomPart;
}

function generateRunId() {
  return 'run-' + generateShortId();
}

function generateRevisionId() {
  return 'rev-' + generateShortId();
}

function createRun(options) {
  var runId = options.runId || generateRunId();
  var revisionId = options.revisionId || generateRevisionId();

  return {
    runId: runId,
    taskId: options.taskId || null,
    revisionId: revisionId,
    startedAt: options.startedAt || new Date().toISOString(),
    status: options.status || 'STARTED',
    workspaceId: options.workspaceId || null,
    endedAt: null,
    metadata: options.metadata || {}
  };
}

function updateRunStatus(run, status) {
  var updatedRun = {
    runId: run.runId,
    taskId: run.taskId,
    revisionId: run.revisionId,
    startedAt: run.startedAt,
    status: status,
    workspaceId: run.workspaceId,
    endedAt: run.endedAt,
    metadata: run.metadata
  };

  if (status === 'COMPLETED' || status === 'FAILED') {
    updatedRun.endedAt = new Date().toISOString();
  }

  return updatedRun;
}

function setWorkspaceId(run, workspaceId) {
  return {
    runId: run.runId,
    taskId: run.taskId,
    revisionId: run.revisionId,
    startedAt: run.startedAt,
    status: run.status,
    workspaceId: workspaceId,
    endedAt: run.endedAt,
    metadata: run.metadata
  };
}

function serializeRun(run) {
  return JSON.stringify(run, null, 2);
}

function deserializeRun(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return null;
  }
}

function isValidRunId(runId) {
  if (typeof runId !== 'string') {
    return false;
  }
  return /^run-[a-z0-9]+-[a-z0-9]+$/.test(runId);
}

function isValidRevisionId(revisionId) {
  if (typeof revisionId !== 'string') {
    return false;
  }
  return /^rev-[a-z0-9]+-[a-z0-9]+$/.test(revisionId);
}

module.exports = {
  generateRunId: generateRunId,
  generateRevisionId: generateRevisionId,
  createRun: createRun,
  updateRunStatus: updateRunStatus,
  setWorkspaceId: setWorkspaceId,
  serializeRun: serializeRun,
  deserializeRun: deserializeRun,
  isValidRunId: isValidRunId,
  isValidRevisionId: isValidRevisionId
};