'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');

var integrityModule = require('../src/integrity');
var canonicalizeModule = require('../src/canonicalize');

var MANIFEST_PATH = path.join(__dirname, '..', 'manifest', 'acceptance-manifest.v0.4.json');

test('integrity: verifyIntegrity passes for valid manifest', function(t, done) {
  var manifestModule = require('../src/manifest');
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var integrityResult = integrityModule.verifyIntegrity(result.manifest);
  assert.strictEqual(integrityResult.ok, true, 'Integrity should verify');
  done();
});

test('integrity: verifyIntegrity fails when tampering', function(t, done) {
  var manifestModule = require('../src/manifest');
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var manifest = result.manifest;
  manifest.tasks[0].expectedResult = 'TAMPERED VALUE';
  var integrityResult = integrityModule.verifyIntegrity(manifest);
  assert.strictEqual(integrityResult.ok, false, 'Integrity should fail after tampering');
  assert.strictEqual(integrityResult.expected, manifest.integrity.expectedValuesHash);
  assert.notStrictEqual(integrityResult.actual, integrityResult.expected);
  done();
});

test('integrity: verifyIntegrity fails when mandatoryAssertions tampered', function(t, done) {
  var manifestModule = require('../src/manifest');
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var manifest = result.manifest;
  manifest.tasks[0].mandatoryAssertions[0].text = 'TAMPERED TEXT';
  var integrityResult = integrityModule.verifyIntegrity(manifest);
  assert.strictEqual(integrityResult.ok, false, 'Integrity should fail after tampering assertions');
  done();
});

test('integrity: verifyIntegrity fails for null manifest', function(t, done) {
  var result = integrityModule.verifyIntegrity(null);
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  done();
});

test('integrity: verifyIntegrity fails for manifest without integrity section', function(t, done) {
  var result = integrityModule.verifyIntegrity({ tasks: [] });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  done();
});

test('integrity: computeExpectedValuesHash returns null for null manifest', function(t, done) {
  var hash = integrityModule.computeExpectedValuesHash(null);
  assert.strictEqual(hash, null);
  done();
});

test('integrity: computeExpectedValuesHash returns null for manifest without tasks', function(t, done) {
  var hash = integrityModule.computeExpectedValuesHash({});
  assert.strictEqual(hash, null);
  done();
});

test('integrity: computeExpectedValuesHash is stable across runs', function(t, done) {
  var manifestModule = require('../src/manifest');
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var hash1 = integrityModule.computeExpectedValuesHash(result.manifest);
  var hash2 = integrityModule.computeExpectedValuesHash(result.manifest);
  assert.strictEqual(hash1, hash2, 'Hash should be deterministic');
  done();
});