'use strict';

var fs = require('fs');
var path = require('path');
var test = require('node:test');
var assert = require('node:assert');

var WORKFLOW_PATH = path.resolve(__dirname, '../.github/workflows/staging-pipeline.yml');
var content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
var lines = content.split('\n');

function stepEnvKeys(name) {
  var keys = [];
  var inStep = false;
  var inEnv = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!inStep) {
      if (l.trim().slice(8) === name) inStep = true;
    } else {
      var t = l.trim();
      if (t.slice(0, 8) === '- name: ') break;          // next step
      if (t === 'env:') { inEnv = true; continue; }
      if (t.slice(0, 5) === 'run: ') break;            // end env block
      if (inEnv && t.match(/^[A-Z_][A-Z0-9_]*:\s/)) keys.push(t.match(/^[A-Z_][A-Z0-9_]*/)[0]);
    }
  }
  return keys;
}

function stepRunText(name) {
  var parts = [];
  var inStep = false, inRun = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!inStep) { if (l.trim().slice(8) === name) inStep = true; continue; }
    var t = l.trim();
    if (t.slice(0, 8) === '- name: ') break;
    if (!inRun && t.slice(0, 5) === 'run: ') { inRun = true; continue; }
    if (inRun && t) parts.push(t);
  }
  return parts.join('\n');
}

var PIPELINE_NAMES = [
  'STRIPE_SECRET_KEY','OPENROUTER_API_KEY',
  'STAGING_ADMIN_EMAIL','STAGING_ADMIN_PASSWORD',
  'SEED_TEST_CUSTOMER_PASSWORD','CHANNEL_TOKENS'
];
var REPAIR_NAMES = [
  'VENDURE_STAGING_REPO_TOKEN','OPENROUTER_API_KEY',
  'REPAIR_MODE','PIPELINE_STAGING_URL','PIPELINE_ARCHIVE_ROOT',
  'STRIPE_SECRET_KEY','STAGING_ADMIN_EMAIL','STAGING_ADMIN_PASSWORD',
  'SEED_TEST_CUSTOMER_PASSWORD','CHANNEL_TOKENS'
];
var SECRET_RE = /\b(set -x|echo\s+\$\{|printenv\s+[A-Z_])/;

var pKeys = stepEnvKeys('Run Pipeline in staging');
var rKeys = stepEnvKeys('Repair run');
var pRun  = stepRunText('Run Pipeline in staging');
var rRun  = stepRunText('Repair run');

test('workflowSecrets: pipeline step has every required secret', function() {
  for (var i = 0; i < PIPELINE_NAMES.length; i++)
    assert.ok(pKeys.indexOf(PIPELINE_NAMES[i]) !== -1, PIPELINE_NAMES[i] + ' in pipeline env');
});
test('workflowSecrets: pipeline step excludes VENDURE_STAGING_REPO_TOKEN', function() {
  assert.ok(pKeys.indexOf('VENDURE_STAGING_REPO_TOKEN') === -1);
});
test('workflowSecrets: repair step has every required secret', function() {
  for (var i = 0; i < REPAIR_NAMES.length; i++)
    assert.ok(rKeys.indexOf(REPAIR_NAMES[i]) !== -1, REPAIR_NAMES[i] + ' in repair env');
});
test('workflowSecrets: VENDURE_STAGING_REPO_TOKEN only in repair step', function() {
  assert.ok(pKeys.indexOf('VENDURE_STAGING_REPO_TOKEN') === -1, 'not in pipeline');
  assert.ok(rKeys.indexOf('VENDURE_STAGING_REPO_TOKEN') !== -1, 'in repair');
});
test('workflowSecrets: pipeline run block clean', function() {
  assert.ok(!SECRET_RE.test(pRun));
});
test('workflowSecrets: repair run block clean', function() {
  assert.ok(!SECRET_RE.test(rRun));
});
