'use strict';

var loggerModule = require('../src/logger');
var path = require('path');
var fs = require('fs');
var os = require('os');

var test = require('node:test');
var assert = require('node:assert');

var TEST_LOG_FILE = path.resolve(__dirname, 'test-logs-temp.jsonl');

test('logger: structured JSON log generated', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-test-001', 'rev-test-001');

  loggerModule.info('TEST_EVENT', 'Test message');

  loggerModule.resetLogger();

  assert.ok(fs.existsSync(TEST_LOG_FILE), 'Log file should exist');

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  var lines = content.trim().split('\n');
  assert.ok(lines.length > 0, 'Log file should have content');

  var entry = JSON.parse(lines[0]);
  assert.ok(entry.timestamp, 'Log entry should have timestamp');
  assert.strictEqual(entry.level, 'INFO', 'Log level should be INFO');
  assert.strictEqual(entry.runId, 'run-test-001', 'Log entry should have runId');
  assert.strictEqual(entry.revisionId, 'rev-test-001', 'Log entry should have revisionId');
  assert.strictEqual(entry.event, 'TEST_EVENT', 'Log entry should have event');
  assert.strictEqual(entry.message, 'Test message', 'Log entry should have message');

  done();
});

test('logger: run ID included', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-abc-123', 'rev-xyz-789');

  loggerModule.info('TEST_EVENT', 'Test message');
  loggerModule.resetLogger();

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  var lines = content.trim().split('\n');
  var lastLine = lines[lines.length - 1];
  var entry = JSON.parse(lastLine);

  assert.strictEqual(entry.runId, 'run-abc-123', 'Run ID should be included');
  done();
});

test('logger: revision ID included', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-abc-123', 'rev-xyz-789');

  loggerModule.info('TEST_EVENT', 'Test message');
  loggerModule.resetLogger();

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  var lines = content.trim().split('\n');
  var lastLine = lines[lines.length - 1];
  var entry = JSON.parse(lastLine);

  assert.strictEqual(entry.revisionId, 'rev-xyz-789', 'Revision ID should be included');
  done();
});

test('logger: log levels work', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-test', 'rev-test');
  loggerModule.setLogLevel('debug');

  loggerModule.debug('DEBUG_EVENT', 'Debug message');
  loggerModule.info('INFO_EVENT', 'Info message');
  loggerModule.warn('WARN_EVENT', 'Warning message');
  loggerModule.error('ERROR_EVENT', 'Error message');
  loggerModule.resetLogger();

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  var lines = content.trim().split('\n');

  var levels = [];
  var events = [];
  lines.forEach(function(line) {
    var entry = JSON.parse(line);
    levels.push(entry.level);
    events.push(entry.event);
  });

  assert.ok(levels.indexOf('DEBUG') !== -1, 'Should have DEBUG level when log level is debug');
  assert.ok(levels.indexOf('INFO') !== -1, 'Should have INFO level');
  assert.ok(levels.indexOf('WARN') !== -1, 'Should have WARN level');
  assert.ok(levels.indexOf('ERROR') !== -1, 'Should have ERROR level');

  done();
});

test('logger: sensitive values are not emitted', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-test', 'rev-test');

  loggerModule.info('TEST_EVENT', 'Test message', {
    OPENROUTER_API_KEY: 'sk-secret12345',
    normalField: 'visible value',
    userPassword: 'super-secret'
  });
  loggerModule.resetLogger();

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  assert.strictEqual(content.includes('sk-secret12345'), false, 'API key should be redacted');
  assert.strictEqual(content.includes('super-secret'), false, 'Password should be redacted');
  assert.strictEqual(content.includes('visible value'), true, 'Normal field should be visible');
  assert.strictEqual(content.includes('****'), true, 'Sensitive values should be redacted with ****');

  done();
});

test('logger: extra data included in log', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-test', 'rev-test');

  loggerModule.info('TEST_EVENT', 'Test message', { customField: 'customValue' });
  loggerModule.resetLogger();

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  var lines = content.trim().split('\n');
  var lastLine = lines[lines.length - 1];
  var entry = JSON.parse(lastLine);

  assert.strictEqual(entry.customField, 'customValue', 'Extra data should be included');
  done();
});

test('logger: redactSensitiveValue works', function(t, done) {
  var result = loggerModule.redactSensitiveValue('OPENROUTER_API_KEY', 'sk-live-abcdefgh');
  assert.strictEqual(result, 'sk-l****', 'API key should be redacted');

  var result2 = loggerModule.redactSensitiveValue('normalField', 'visible');
  assert.strictEqual(result2, 'visible', 'Normal field should not be redacted');

  var result3 = loggerModule.redactSensitiveValue('api_key', 'short');
  assert.strictEqual(result3, '****', 'Short secrets should be fully masked');

  done();
});

test('logger: redactSensitiveObject preserves nested arrays of objects', function(t, done) {
  var input = {
    users: [
      { name: 'Alice', api_key: 'secret-key-1' },
      { name: 'Bob', token: 'token-value-2' }
    ],
    items: [['nested', 'array'], { sub: 'object' }]
  };
  var redacted = loggerModule.redactSensitiveObject(input);
  assert.ok(Array.isArray(redacted.users), 'users should remain array');
  assert.strictEqual(redacted.users[0].name, 'Alice', 'name should be visible');
  assert.strictEqual(redacted.users[0].api_key, 'secr****', 'api_key should be redacted');
  assert.strictEqual(redacted.users[1].name, 'Bob', 'name should be visible');
  assert.strictEqual(redacted.users[1].token, 'toke****', 'token should be redacted');
  assert.ok(Array.isArray(redacted.items), 'top-level items should remain array');
  assert.ok(Array.isArray(redacted.items[0]), 'nested array should remain array');
  assert.ok(Array.isArray(redacted.items[1].sub) === false, 'object in array should be object');
  done();
});

test('logger: redactSensitiveObject makes JSON.stringify contain [ not {0}', function(t, done) {
  var input = { items: [], nested: { arr: ['a', 'b'] } };
  var redacted = loggerModule.redactSensitiveObject(input);
  var json = JSON.stringify(redacted);
  assert.ok(json.indexOf('[') !== -1, 'JSON should contain [ for arrays');
  assert.ok(json.indexOf('{"0"') === -1, 'JSON should not contain {"0" (array serialized as object)');
  done();
});

test('logger: redactSensitiveObject redacts secret keys inside array items', function(t, done) {
  var input = { api_keys: [{ secret: 'my-secret-key-value' }, { token: 'another-secret' }] };
  var redacted = loggerModule.redactSensitiveObject(input);
  assert.strictEqual(redacted.api_keys[0].secret, 'my-s****', 'secret key should be redacted');
  assert.strictEqual(redacted.api_keys[1].token, 'anot****', 'token key should be redacted');
  done();
});

test('logger: redactSensitiveObject works', function(t, done) {
  var input = {
    OPENROUTER_API_KEY: 'sk-live-secret',
    username: 'testuser',
    password: 'secret123'
  };

  var redacted = loggerModule.redactSensitiveObject(input);

  assert.strictEqual(redacted.OPENROUTER_API_KEY.includes('****'), true, 'API key should be redacted');
  assert.strictEqual(redacted.password.includes('****'), true, 'Password should be redacted');
  assert.strictEqual(redacted.username, 'testuser', 'Username should be visible');
  done();
});

test('logger: createLogger creates module-scoped logger', function(t, done) {
  loggerModule.resetLogger();
  loggerModule.setLogFile(TEST_LOG_FILE);
  loggerModule.setLogContext('run-test', 'rev-test');

  var log = loggerModule.createLogger('TestModule');
  log.info('EVENT', 'Message');
  loggerModule.resetLogger();

  var content = fs.readFileSync(TEST_LOG_FILE, 'utf8');
  var lines = content.trim().split('\n');
  var lastLine = lines[lines.length - 1];
  var entry = JSON.parse(lastLine);

  assert.strictEqual(entry.event, 'TestModule:EVENT', 'Event should be prefixed with module name');
  done();
});

test('logger: channelTokens key bypasses redaction and frozen token values bypass value redaction', function(t, done) {
  var input = {
    channelTokens: 'de-token',
    CHANNEL_TOKENS: 'at-token',
    adminToken: 'admin-secret-redacted',
    authToken: 'auth-secret-redacted',
    accessToken: 'access-secret-redacted',
    userToken: 'user-token-redacted',
    TOKEN_UPPER: 'token-upper-redacted',
    someToken: 'some-token-redacted'
  };
  var redacted = loggerModule.redactSensitiveObject(input);
  // The frozen token values (de-token, at-token, hu-token, gb-token) bypass
  // value redaction because they are public channel identifiers confirmed
  // non-secret by the client on 2 Oct 2026.
  assert.strictEqual(redacted.channelTokens, 'de-token', 'channelTokens key is allowlisted and frozen value de-token is visible');
  assert.strictEqual(redacted.CHANNEL_TOKENS, 'at-token', 'CHANNEL_TOKENS key is allowlisted and frozen value at-token is visible');
  assert.strictEqual(redacted.adminToken, 'admi****', 'adminToken contains token substring, redacted');
  assert.strictEqual(redacted.authToken, 'auth****', 'authToken contains token substring, redacted');
  assert.strictEqual(redacted.accessToken, 'acce****', 'accessToken contains token substring, redacted');
  assert.strictEqual(redacted.userToken, 'user****', 'userToken contains token substring, redacted');
  assert.strictEqual(redacted.TOKEN_UPPER, 'toke****', 'TOKEN_UPPER contains token substring, redacted (case-insensitive key match)');
  assert.strictEqual(redacted.someToken, 'some****', 'someToken contains token substring, redacted');
  done();
});

test.after(function() {
  loggerModule.resetLogger();
  if (fs.existsSync(TEST_LOG_FILE)) {
    try {
      fs.unlinkSync(TEST_LOG_FILE);
    } catch (e) {
    }
  }
});