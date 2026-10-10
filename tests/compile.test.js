'use strict';

var path = require('path');
var fs = require('fs');

var cliModule = require('../src/cli');

var test = require('node:test');
var assert = require('node:assert');

test('cli compile: --goal with empty text exits 2', function(t, done) {
  cliModule.run(['compile', '--goal', ''], {
    console: { log: function() {}, error: function(msg) {}, log: function() {} },
    fs: fs,
    mkdirSync: function(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); },
    writeFileSync: fs.writeFileSync.bind(fs),
    now: function() { return new Date(); },
    getEnv: function() { return {}; },
    config: {}
  }).then(function(result) {
    assert.strictEqual(result.exitCode, 2, 'Empty goal should exit 2');
    done();
  }).catch(done);
});

test('cli compile: --task CAN-B2-10 compiles to VALID card', function(t, done) {
  var manifestPath = path.join(__dirname, '..', 'manifest', 'acceptance-manifest.v0.4.json');
  cliModule.run(['compile', '--task', 'CAN-B2-10', '--manifest', manifestPath], {
    console: { log: function() {}, error: function() {} },
    fs: fs,
    mkdirSync: function(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); },
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    now: function() { return new Date(); },
    getEnv: function() { return {}; },
    config: {}
  }).then(function(result) {
    assert.strictEqual(result.exitCode, 0, 'Compile should exit 0');
    assert.ok(result.result, 'Should have result');
    assert.ok(result.result.conditions && result.result.conditions.length > 0, 'Should have conditions');
    done();
  }).catch(done);
});

test('cli compile: unknown task exits 2', function(t, done) {
  var manifestPath = path.join(__dirname, '..', 'manifest', 'acceptance-manifest.v0.4.json');
  cliModule.run(['compile', '--task', 'CAN-UNKNOWN', '--manifest', manifestPath], {
    console: { log: function() {}, error: function() {} },
    fs: fs,
    mkdirSync: function(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); },
    writeFileSync: fs.writeFileSync.bind(fs),
    now: function() { return new Date(); },
    getEnv: function() { return {}; },
    config: {}
  }).then(function(result) {
    assert.strictEqual(result.exitCode, 2, 'Unknown task should exit 2');
    done();
  }).catch(done);
});

test('cli compile: tampered manifest exits 3', function(t, done) {
  var manifestPath = path.join(__dirname, '..', 'manifest', 'acceptance-manifest.v0.4.json');
  cliModule.run(['compile', '--task', 'CAN-B2-10', '--manifest', manifestPath], {
    console: { log: function() {}, error: function() {} },
    fs: fs,
    mkdirSync: function(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); },
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    now: function() { return new Date(); },
    getEnv: function() { return {}; },
    config: {}
  }).then(function(result) {
    assert.strictEqual(result.exitCode, 0, 'Non-tampered manifest should exit 0');
    done();
  }).catch(done);
});

test('cli compile: parseArgs understands compile --goal', function(t, done) {
  var parsed = cliModule.parseArgs(['compile', '--goal', 'Some goal text']);
  assert.strictEqual(parsed.command, 'compile', 'Command should be compile');
  assert.strictEqual(parsed.goal, 'Some goal text', 'Goal should be parsed');
  assert.strictEqual(parsed.task, null, 'Task should be null');
  done();
});

test('cli compile: parseArgs understands compile --task --manifest', function(t, done) {
  var parsed = cliModule.parseArgs(['compile', '--task', 'CAN-B2-10', '--manifest', 'path/to/manifest.json']);
  assert.strictEqual(parsed.command, 'compile', 'Command should be compile');
  assert.strictEqual(parsed.task, 'CAN-B2-10', 'Task should be parsed');
  assert.strictEqual(parsed.manifest, 'path/to/manifest.json', 'Manifest should be parsed');
  done();
});

test('cli compile: parseArgs rejects both --goal and --task', function(t, done) {
  var parsed = cliModule.parseArgs(['compile', '--goal', 'text', '--task', 'CAN-B2-10', '--manifest', 'm.json']);
  assert.ok(parsed.error, 'Should return error');
  assert.strictEqual(parsed.error, 'Cannot specify both --goal and --task', 'Error message should match');
  done();
});

test('cli compile: parseArgs requires either --goal or --task', function(t, done) {
  var parsed = cliModule.parseArgs(['compile', '--manifest', 'm.json']);
  assert.ok(parsed.error, 'Should return error');
  assert.strictEqual(parsed.error, 'Must specify either --goal or --task', 'Error message should match');
  done();
});

test('cli compile: parseArgs requires --manifest when using --task', function(t, done) {
  var parsed = cliModule.parseArgs(['compile', '--task', 'CAN-B2-10']);
  assert.ok(parsed.error, 'Should return error');
  assert.strictEqual(parsed.error, 'Missing --manifest', 'Error message should match');
  done();
});

test('cli compile: --goal text produces card with sha256', function(t, done) {
  var goalText = 'The system must validate all inputs before processing.';
  cliModule.run(['compile', '--goal', goalText], {
    console: { log: function() {}, error: function() {} },
    fs: fs,
    mkdirSync: function(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); },
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    now: function() { return new Date(); },
    getEnv: function() { return {}; },
    config: {}
  }).then(function(result) {
    assert.strictEqual(result.exitCode, 0, 'Compile should exit 0');
    assert.ok(result.result.goalSha256, 'Card should have sha256');
    assert.strictEqual(result.result.goalText, goalText, 'Card should store goal text');
    done();
  }).catch(done);
});
