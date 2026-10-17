'use strict';

var signatureExtractor = require('../src/repair/signatureExtractor');
var fs = require('fs');
var path = require('path');

var test = require('node:test');
var assert = require('node:assert');

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures/repair', name), 'utf8');
}

test('signatureExtractor: real API error JSON -> SQL_PARAM_TYPE, correct paramValue and path', function(t, done) {
  var apiErrorFixture = JSON.parse(loadFixture('apiError.json'));
  var input = { apiErrors: apiErrorFixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.strictEqual(result.message, 'invalid input syntax for type integer: "undefined"', 'message should match');
  assert.deepStrictEqual(result.path, ['products', 'filter', 'id'], 'path should be extracted');
  assert.strictEqual(result.sql.paramValue, 'undefined', 'paramValue should be undefined');
  assert.strictEqual(result.confidence, 'API_ONLY', 'confidence should be API_ONLY without logExcerpt');
  assert.strictEqual(Array.isArray(result.notes), true, 'notes should be an array');
  assert.strictEqual(result.signature.length, 64, 'signature should be a SHA256 hex string');
  done();
});

test('signatureExtractor: WITH_SQL when logExcerpt has valid Postgres context and statement', function(t, done) {
  var apiErrorFixture = JSON.parse(loadFixture('apiError.json'));
  var logExcerpt = loadFixture('postgresExcerpt.txt');
  var input = {
    apiErrors: apiErrorFixture.errors,
    logExcerpt: logExcerpt,
    operationName: 'GetProducts',
    query: 'query GetProducts { products(filter: { id: $id }) { id } }'
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.strictEqual(result.confidence, 'WITH_SQL', 'confidence should be WITH_SQL');
  assert.strictEqual(result.sql.column, 'id', 'column should be id');
  assert.strictEqual(result.sql.operator, '!=', 'operator should be !=');
  assert.strictEqual(result.sql.paramIndex, 3, 'paramIndex should be 3');
  assert.strictEqual(result.sql.paramValue, 'undefined', 'paramValue should be undefined');
  assert.ok(result.sql.statement && result.sql.statement.includes('"product"'), 'statement should contain product table');
  assert.strictEqual(result.signature.length, 64, 'signature should be a SHA256 hex string');
  done();
});

test('signatureExtractor: malformed input -> class UNKNOWN, note added', function(t, done) {
  var malformedFixture = JSON.parse(loadFixture('malformed.json'));
  var input = {
    apiErrors: malformedFixture.apiErrors,
    logExcerpt: malformedFixture.logExcerpt
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN for malformed input');
  assert.ok(result.notes.length > 0, 'notes should contain error message');
  assert.strictEqual(result.signature.length, 64, 'signature should still be generated');
  done();
});

test('signatureExtractor: email in logExcerpt is redacted, note added', function(t, done) {
  var logExcerpt = loadFixture('emailExcerpt.txt');
  var input = {
    apiErrors: [{ message: 'invalid input syntax for type integer: "john.doe@example.com"', path: ['products'] }],
    logExcerpt: logExcerpt
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.ok(result.notes.some(function(n) { return n.includes('redacted') || n.includes('Email'); }),
    'should have note about email redaction');
  assert.strictEqual(result.confidence, 'WITH_SQL', 'confidence should be WITH_SQL');
  assert.strictEqual(result.sql.paramValue, 'john.doe@example.com', 'paramValue should be extracted');
  done();
});

test('signatureExtractor: API-only case -> confidence API_ONLY, sql fields null', function(t, done) {
  var apiOnlyFixture = JSON.parse(loadFixture('apiOnly.json'));
  var input = {
    apiErrors: apiOnlyFixture.apiErrors
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.strictEqual(result.confidence, 'API_ONLY', 'confidence should be API_ONLY');
  assert.strictEqual(result.sql.statement, null, 'statement should be null');
  assert.strictEqual(result.sql.operator, null, 'operator should be null');
  assert.strictEqual(result.sql.column, null, 'column should be null');
  assert.strictEqual(result.sql.paramIndex, null, 'paramIndex should be null');
  assert.strictEqual(result.sql.paramValue, '42', 'paramValue should be 42');
  assert.strictEqual(result.signature.length, 64, 'signature should be a SHA256 hex string');
  done();
});

test('signatureExtractor: null input object -> class UNKNOWN, no throw', function(t, done) {
  var result = signatureExtractor.extractFinding(null);
  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN for null input');
  assert.strictEqual(result.signature.length, 64, 'signature should be generated');
  done();
});

test('signatureExtractor: empty apiErrors array -> class UNKNOWN', function(t, done) {
  var result = signatureExtractor.extractFinding({ apiErrors: [] });
  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN for empty apiErrors');
  done();
});

test('signatureExtractor: same error class+message+path produces same signature', function(t, done) {
  var apiErrorFixture = JSON.parse(loadFixture('apiError.json'));
  var input1 = { apiErrors: apiErrorFixture.errors };
  var input2 = { apiErrors: JSON.parse(JSON.stringify(apiErrorFixture.errors)) };
  var result1 = signatureExtractor.extractFinding(input1);
  var result2 = signatureExtractor.extractFinding(input2);
  assert.strictEqual(result1.signature, result2.signature, 'identical errors should produce same signature');
  done();
});
