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
  assert.ok(result.domain, 'domain should be present');
  assert.ok(result.sqlstate !== undefined, 'sqlstate should be present');
  assert.ok(Array.isArray(result.stack), 'stack should be an array');
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
  assert.strictEqual(result.domain, 'unknown', 'domain should be unknown');
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

test('signatureExtractor: domain=database from hard SQLSTATE in logExcerpt with stack', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-database.json'));
  var input = { apiErrors: fixture.errors, logExcerpt: fixture.logExcerpt };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.strictEqual(result.domain, 'database', 'domain should be database');
  assert.strictEqual(result.sqlstate, '42P01', 'sqlstate should be 42P01');
  assert.ok(Array.isArray(result.stack), 'stack should be an array');
  done();
});

test('signatureExtractor: domain=target-code from repo src/ stack frame', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-target-code.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'target-code', 'domain should be target-code from non-node_modules non-repo frame');
  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN (no integer mismatch)');
  assert.ok(Array.isArray(result.stack), 'stack should be an array');
  assert.ok(result.stack.length > 0, 'stack should have parsed frames');
  done();
});

test('signatureExtractor: domain=dependency from node_modules stack frame', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-dependency.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'dependency', 'domain should be dependency from node_modules frame');
  done();
});

test('signatureExtractor: domain=pipeline from repo src/ stack frame', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-pipeline.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'pipeline', 'domain should be pipeline from src/evidenceCollector frame');
  done();
});

test('signatureExtractor: domain=infrastructure from ECONNREFUSED', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-infrastructure.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'infrastructure', 'domain should be infrastructure from ECONNREFUSED');
  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN');
  done();
});

test('signatureExtractor: domain=infrastructure from 403 Forbidden', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-infrastructure-403.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'infrastructure', 'domain should be infrastructure from 403');
  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN');
  done();
});

test('signatureExtractor: stack parsed correctly from extension exception', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-database.json'));
  var input = { apiErrors: fixture.errors, logExcerpt: fixture.logExcerpt };
  var result = signatureExtractor.extractFinding(input);

  assert.ok(result.stack.length > 0, 'stack should have parsed frames from exception.stacktrace');
  var firstFrame = result.stack[0];
  assert.strictEqual(typeof firstFrame.file, 'string', 'frame file should be string');
  assert.strictEqual(typeof firstFrame.line, 'number', 'frame line should be number');
  assert.ok(firstFrame.fn === null || typeof firstFrame.fn === 'string', 'frame fn should be null or string');
  done();
});

test('signatureExtractor: SQLSTATE 23505 from apiErrors extensions.code', function(t, done) {
  var input = {
    apiErrors: [{ message: 'duplicate key value violates unique constraint', path: ['products'], extensions: { code: '23505' } }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.sqlstate, '23505', 'sqlstate should be extracted from extensions.code');
  assert.strictEqual(result.domain, 'database', 'domain should be database from SQLSTATE');
  done();
});

test('signatureExtractor: domain unknown when no signals found', function(t, done) {
  var input = {
    apiErrors: [{ message: 'something went wrong but not sure what', path: ['x'] }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'unknown', 'domain should be unknown when no signals found');
  assert.strictEqual(result.class, 'UNKNOWN', 'class should be UNKNOWN');
  done();
});

test('signatureExtractor: 22P02 without stack -> domain target-code', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-22p02-nostack.json'));
  var input = { apiErrors: fixture.errors, logExcerpt: fixture.logExcerpt };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.sqlstate, '22P02', 'sqlstate should be 22P02');
  assert.strictEqual(result.domain, 'target-code', '22P02 without stack should be target-code');
  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  done();
});

test('signatureExtractor: 42P01 -> domain database', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-42p01.json'));
  var input = { apiErrors: fixture.errors, logExcerpt: fixture.logExcerpt };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.sqlstate, '42P01', 'sqlstate should be 42P01');
  assert.strictEqual(result.domain, 'database', '42P01 should be database');
  done();
});

test('signatureExtractor: src/plugins/foo.ts -> domain target-code (not pipeline)', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-src-plugins.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'target-code', 'src/plugins/ frame should be target-code not pipeline');
  done();
});

test('signatureExtractor: /app/dist/plugins/foo.js -> domain target-code (not pipeline)', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-app-dist.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'target-code', '/app/dist/plugins/ frame should be target-code');
  done();
});

test('signatureExtractor: GraphQL unknown field -> domain pipeline (our query is wrong)', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-client-input-field.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'pipeline', 'unknown field should be pipeline');
  done();
});

test('signatureExtractor: GraphQL non-null type error -> domain pipeline (our query is wrong)', function(t, done) {
  var fixture = JSON.parse(loadFixture('domain-client-input.json'));
  var input = { apiErrors: fixture.errors };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'pipeline', 'expected non-nullable type should be pipeline');
  done();
});

test('signatureExtractor: missing artifact -> domain client-input', function(t, done) {
  var input = {
    apiErrors: [{ message: 'no such file or directory, missing artifact: fixture.json', path: null, extensions: {} }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'client-input', 'missing artifact should be client-input');
  done();
});
