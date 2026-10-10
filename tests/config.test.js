'use strict';

var configModule = require('../src/config');
var path = require('path');
var fs = require('fs');

var test = require('node:test');
var assert = require('node:assert');

var TEST_DIR = path.resolve(__dirname);
var TEST_ENV_FILE = path.resolve(TEST_DIR, '.env');

test('config: missing optional API key does not break Milestone 1', function(t, done) {
  if (fs.existsSync(TEST_ENV_FILE)) {
    fs.unlinkSync(TEST_ENV_FILE);
  }

  configModule.loadConfig();

  var status = configModule.getConfigStatus();
  assert.ok(status.OPENROUTER_API_KEY !== undefined, 'API key status should be defined');
  assert.strictEqual(status.OPENROUTER_API_KEY, 'not configured', 'API key should be not configured');
  done();
});

test('config: environment values are loaded and API key status reported securely', function(t, done) {
  var realEnvPath = path.resolve(process.cwd(), '.env');

  if (fs.existsSync(realEnvPath)) {
    fs.unlinkSync(realEnvPath);
  }

  fs.writeFileSync(realEnvPath, 'OPENROUTER_API_KEY=sk-test-12345678\nOPENROUTER_MODEL=gpt-4\nPIPELINE_LOG_LEVEL=debug\n', 'utf8');

  delete require.cache[require.resolve('../src/config')];
  var freshConfigModule = require('../src/config');

  var status = freshConfigModule.getConfigStatus();
  assert.strictEqual(status.OPENROUTER_API_KEY, 'configured', 'API key status should show configured');
  assert.strictEqual(status.OPENROUTER_API_KEY.includes('sk-'), false, 'API key should not be revealed');
  assert.strictEqual(status.OPENROUTER_MODEL, 'gpt-4', 'Model should be loaded');
  assert.strictEqual(status.PIPELINE_LOG_LEVEL, 'debug', 'Log level should be loaded');

  fs.unlinkSync(realEnvPath);
  done();
});

test('config: workspace root defaults to ./workspace', function(t, done) {
  var realEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(realEnvPath)) {
    fs.unlinkSync(realEnvPath);
  }

  configModule.loadConfig();

  var status = configModule.getConfigStatus();
  assert.ok(status.PIPELINE_WORKSPACE_ROOT.endsWith('workspace'), 'Workspace root should default to ./workspace');
  done();
});

test('config: log level defaults to info', function(t, done) {
  var realEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(realEnvPath)) {
    fs.unlinkSync(realEnvPath);
  }

  configModule.loadConfig();

  var status = configModule.getConfigStatus();
  assert.strictEqual(status.PIPELINE_LOG_LEVEL, 'info', 'Log level should default to info');
  done();
});

test('config: isApiKeyConfigured returns correct value', function(t, done) {
  var realEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(realEnvPath)) {
    fs.unlinkSync(realEnvPath);
  }

  configModule.loadConfig();

  var isConfigured = configModule.isApiKeyConfigured();
  var status = configModule.getConfigStatus();

  if (status.OPENROUTER_API_KEY === 'configured') {
    assert.strictEqual(isConfigured, true, 'Should return true when key is configured');
  } else {
    assert.strictEqual(isConfigured, false, 'Should return false when key is not set');
  }
  done();
});

test. after( function() {
  var realEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(realEnvPath)) {
    try {
      fs.unlinkSync(realEnvPath);
    } catch (e) {
    }
  }
  if (fs.existsSync(TEST_ENV_FILE)) {
    try {
      fs.unlinkSync(TEST_ENV_FILE);
    } catch (e) {
    }
  }
});