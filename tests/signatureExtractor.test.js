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

test('signatureExtractor: docker-compose prefixed log strips container prefix and parses SQL', function(t, done) {
  var apiErrorFixture = JSON.parse(loadFixture('apiError.json'));
  var logExcerpt = loadFixture('postgres-docker-log.txt');
  var input = {
    apiErrors: apiErrorFixture.errors,
    logExcerpt: logExcerpt,
    operationName: 'GetProducts',
    query: 'query GetProducts { products(filter: { id: $id }) { id } }'
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.strictEqual(result.confidence, 'WITH_SQL', 'confidence should be WITH_SQL when container prefix present');
  assert.strictEqual(result.sql.column, 'id', 'column should be id');
  assert.strictEqual(result.sql.operator, '!=', 'operator should be !=');
  assert.strictEqual(result.sql.paramIndex, 3, 'paramIndex should be 3');
  assert.ok(result.sql.statement && result.sql.statement.includes('"product"'),
    'statement should contain product table: ' + result.sql.statement);
  // The trailing LOG entry must not be swallowed into the statement capture.
  assert.ok(result.sql.statement.indexOf('unrelated') === -1, 'statement should stop at the next timestamp entry');
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

// (a) exact case from bug report: GraphQL SQL integer mismatch -> domain NOT infrastructure
test('signatureExtractor: GraphQL SQL integer mismatch -> domain target-code (not infrastructure)', function(t, done) {
  var input = {
    apiErrors: [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products'], extensions: { code: 'BAD_USER_INPUT' } }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.notStrictEqual(result.domain, 'infrastructure', 'domain must NOT be infrastructure for SQL integer mismatch');
  assert.strictEqual(result.domain, 'target-code', 'domain should be target-code for GraphQL SQL param error');
  assert.strictEqual(result.sqlstate, null, 'sqlstate should be null (no SQLSTATE in apiErrors)');
  done();
});

// (a2) same GraphQL SQL error with undefined in cause text -> domain target-code
test('signatureExtractor: GraphQL error with product.id != $3 undefined -> domain target-code', function(t, done) {
  var input = {
    apiErrors: [
      { message: 'invalid input syntax for type integer: "undefined"', path: ['products'], extensions: { code: 'BAD_USER_INPUT' } }
    ]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'target-code', 'domain should be target-code, not infrastructure');
  done();
});

// (b) ECONNREFUSED -> domain infrastructure
test('signatureExtractor: ECONNREFUSED -> domain infrastructure', function(t, done) {
  var input = {
    apiErrors: [{ message: 'connect ECONNREFUSED 127.0.0.1:54321', path: null, extensions: {} }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'infrastructure', 'ECONNREFUSED should be infrastructure');
  done();
});

// (b2) 503 Service Unavailable -> domain infrastructure
test('signatureExtractor: 503 Service Unavailable -> domain infrastructure', function(t, done) {
  var input = {
    apiErrors: [{ message: 'HTTP 503 Service Unavailable', path: null, extensions: {} }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'infrastructure', '503 Service Unavailable should be infrastructure');
  done();
});

// (b3) 504 Gateway Timeout -> domain infrastructure
test('signatureExtractor: 504 Gateway Timeout -> domain infrastructure', function(t, done) {
  var input = {
    apiErrors: [{ message: '504 Gateway Timeout', path: null, extensions: {} }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'infrastructure', '504 Gateway Timeout should be infrastructure');
  done();
});

// (c) missing-relation SQL error -> domain database
test('signatureExtractor: missing relation -> domain database', function(t, done) {
  var input = {
    apiErrors: [{ message: 'relation "public.products" does not exist', path: null, extensions: { code: '42P01' } }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'database', 'missing-relation SQL error should be database');
  done();
});

// (d) no signals -> domain unknown (not infrastructure)
test('signatureExtractor: no input signals -> domain unknown', function(t, done) {
  var input = {
    apiErrors: [{ message: 'something went wrong but not sure what', path: ['x'] }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.domain, 'unknown', 'domain should be unknown when no signals found');
  assert.notStrictEqual(result.domain, 'infrastructure', 'unknown must NOT be infrastructure');
  done();
});

// (d2) null input -> domain unknown (not infrastructure)
test('signatureExtractor: null input -> domain unknown (not infrastructure)', function(t, done) {
  var result = signatureExtractor.extractFinding(null);

  assert.strictEqual(result.domain, 'unknown', 'null input should give domain unknown');
  assert.notStrictEqual(result.domain, 'infrastructure', 'unknown must NOT be infrastructure');
  done();
});

// (e) forbidden terms guard: source strings must not contain classification keywords
test('signatureExtractor: forbidden terms guard - store-credit not in src/', function(t, done) {
  var sigExtSrc = require('fs').readFileSync(require('path').resolve(__dirname, '../src/repair/signatureExtractor.js'), 'utf8');
  var forbidden = ['store-credit', 'npp', 'notEq'];
  var found = forbidden.filter(function(term) { return sigExtSrc.indexOf(term) !== -1; });
  assert.deepStrictEqual(found, [], 'src/repair/signatureExtractor.js must not contain forbidden classification keywords: ' + forbidden.join(', '));
  done();
});

// DOMAIN_DECISION_TABLE is exported
test('signatureExtractor: DOMAIN_DECISION_TABLE is exported', function(t, done) {
  var exported = require('../src/repair/signatureExtractor');
  assert.ok(exported.DOMAIN_DECISION_TABLE, 'DOMAIN_DECISION_TABLE should be exported');
  assert.ok(Array.isArray(exported.DOMAIN_DECISION_TABLE.rules), 'rules should be an array');
  assert.ok(exported.DOMAIN_DECISION_TABLE.fallback, 'fallback should be present');
  assert.ok(exported.DOMAIN_DECISION_TABLE.infra_scope, 'infra_scope should be present');
  done();
});

// Integer type mismatch via APP_LAYER_SQL_PATTERNS before INFRA_PATTERNS
test('signatureExtractor: integer type mismatch does NOT trigger infrastructure via 5xx pattern', function(t, done) {
  var input = {
    apiErrors: [{ message: 'invalid input syntax for type integer: "NaN"', path: ['products'], extensions: {} }]
  };
  var result = signatureExtractor.extractFinding(input);

  assert.notStrictEqual(result.domain, 'infrastructure', 'integer type mismatch must not be classified as infrastructure');
  assert.strictEqual(result.domain, 'target-code', 'integer type mismatch should be target-code');
  done();
});

// (review-6a) log lines with a node_modules frame => domain dependency + package
test('signatureExtractor: log lines with node_modules frame => domain dependency, scoped package', function(t, done) {
  var result = signatureExtractor.extractFinding({
    apiErrors: [{ message: 'TypeError: Cannot read properties of undefined (reading "id")', path: null, extensions: {} }],
    logLines: [
      '2026-10-19T00:00:00Z ERROR server: TypeError: Cannot read properties of undefined',
      '    at Ns.connect (node_modules/@scope/pkg/dist/conn.js:88:15)',
      '    at execute (src/resolvers/order.ts:134:5)',
      '    at run (src/run.ts:3:2)'
    ]
  });
  assert.strictEqual(result.domain, 'dependency', 'domain from node_modules frame');
  assert.strictEqual(result.package, '@scope/pkg', 'scoped package derives from path');
  assert.ok(Array.isArray(result.stack) && result.stack.length >= 3, 'stack has parsed frames');
  assert.ok(result.stack.every(function(f) { return f && f.file && typeof f.line === 'number'; }), 'frames are {file,line}');
  done();
});

test('signatureExtractor: log lines with only target-source frames => domain target-code', function(t, done) {
  var result = signatureExtractor.extractFinding({
    apiErrors: [{ message: 'boom', path: null, extensions: {} }],
    logLines: [
      'ERROR: boom at request time',
      '  at handle (src/resolvers/product.ts:22:4)'
    ]
  });
  assert.strictEqual(result.domain, 'target-code', 'target-source frame overrides domain');
  assert.strictEqual(result.package, null, 'no package for target-source frames');
  done();
});

test('signatureExtractor: no log frames => domain is NOT overridden', function(t, done) {
  var result = signatureExtractor.extractFinding({
    apiErrors: [{ message: 'invalid input syntax for type integer: "x"', path: ['products'], extensions: {} }],
    logLines: ['2026-10-19T00:00:00Z ERROR postgres: no stack in logs']
  });
  assert.strictEqual(result.domain, 'target-code', 'no frames -> keep SQL-signal domain decision');
  done();
});

test('signatureExtractor: parseLogExcerpt parses ERROR/DETAIL/STATEMENT (unique constraint)', function(t, done) {
  var logExcerpt = loadFixture('postgres-detail-error.txt');
  var result = signatureExtractor.parseLogExcerpt(logExcerpt);

  assert.notStrictEqual(result, null, 'parseLogExcerpt should not return null for ERROR/DETAIL/STATEMENT');
  assert.strictEqual(result.column, 'slug', 'column should be slug from DETAIL');
  assert.strictEqual(result.operator, 'unique constraint', 'operator should be unique constraint');
  assert.strictEqual(result.paramIndex, 3, 'paramIndex should be 3 (slug is 3rd column in INSERT)');
  assert.ok(result.statement && result.statement.includes('INSERT INTO'), 'statement should contain INSERT');
  done();
});

test('signatureExtractor: ERROR/DETAIL/STATEMENT via extractFinding sets sql fields correctly', function(t, done) {
  var apiErrorFixture = JSON.parse(loadFixture('apiError.json'));
  var logExcerpt = loadFixture('postgres-detail-error.txt');
  var input = {
    apiErrors: apiErrorFixture.errors,
    logExcerpt: logExcerpt,
    operationName: 'CreateProduct',
    query: 'mutation CreateProduct { createProduct(input: $input) { id } }'
  };
  var result = signatureExtractor.extractFinding(input);

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class should be SQL_PARAM_TYPE');
  assert.strictEqual(result.confidence, 'WITH_SQL', 'confidence should be WITH_SQL');
  assert.strictEqual(result.sql.column, 'slug', 'column should be slug from DETAIL');
  assert.strictEqual(result.sql.operator, 'unique constraint', 'operator should be unique constraint');
  assert.strictEqual(result.sql.paramIndex, 3, 'paramIndex should be 3 (slug is 3rd column in INSERT)');
  assert.ok(result.sql.statement && result.sql.statement.includes('INSERT INTO'), 'statement should contain INSERT');
  assert.strictEqual(result.sql.paramValue, 'undefined', 'paramValue comes from API error, not DETAIL');
  done();
});

test('signatureExtractor: docker-prefixed ERROR/DETAIL/STATEMENT also parses correctly', function(t, done) {
  var logExcerpt = [
    'vendure-db-1  | 2026-10-21 12:00:00.001 UTC [42] ERROR:  23505: duplicate key value violates unique constraint "idx_product_slug"',
    'vendure-db-1  | 2026-10-21 12:00:00.002 UTC [42] DETAIL:  Key (slug)=(nail-art-001) already exists.',
    'vendure-db-1  | 2026-10-21 12:00:00.003 UTC [42] STATEMENT:  INSERT INTO "product" ("id", "name", "slug", "price") VALUES ($1, $2, $3, $4)'
  ].join('\n');
  var result = signatureExtractor.parseLogExcerpt(logExcerpt);

  assert.notStrictEqual(result, null, 'parseLogExcerpt should parse docker-prefixed ERROR/DETAIL/STATEMENT');
  assert.strictEqual(result.column, 'slug', 'column should be slug');
  assert.strictEqual(result.operator, 'unique constraint', 'operator should be unique constraint');
  assert.strictEqual(result.paramIndex, 3, 'paramIndex should be 3 (slug is 3rd column)');
  done();
});

test('signatureExtractor: real Postgres log shape with <ts> stderr <ts> UTC prefix, paramValue/table extracted', function(t, done) {
  var logExcerpt = loadFixture('postgres-realtime-log.txt');
  var result = signatureExtractor.parseLogExcerpt(logExcerpt);

  assert.notStrictEqual(result, null, 'parseLogExcerpt must not return null for real Postgres log shape');
  assert.strictEqual(result.operator, '!=', 'operator must be !=');
  assert.strictEqual(result.column, 'id', 'column must be id');
  assert.strictEqual(result.table, 'product', 'table must be product');
  assert.strictEqual(result.paramIndex, 3, 'paramIndex must be 3');
  assert.strictEqual(result.paramValue, 'undefined', 'paramValue must be undefined from ERROR text');
  assert.ok(result.statement && result.statement.indexOf('SELECT') !== -1, 'statement must be present');
  assert.strictEqual(result.statement.indexOf('"undefined"'), -1, 'statement must not contain raw param');
  assert.strictEqual(result.statement.indexOf('$3'), -1, 'statement must not contain $3 marker');
  done();
});

test('signatureExtractor: extractFinding with real Postgres log shape sets full sql object', function(t, done) {
  var logExcerpt = loadFixture('postgres-realtime-log.txt');
  var apiErrors = [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products', 'filter', 'id'], extensions: {} }];
  var result = signatureExtractor.extractFinding({ apiErrors: apiErrors, logExcerpt: logExcerpt, operationName: 'searchProducts' });

  assert.strictEqual(result.class, 'SQL_PARAM_TYPE', 'class must be SQL_PARAM_TYPE');
  assert.strictEqual(result.confidence, 'WITH_SQL', 'confidence must be WITH_SQL');
  assert.strictEqual(result.sql.operator, '!=', 'operator from STATEMENT');
  assert.strictEqual(result.sql.column, 'id', 'column from STATEMENT');
  assert.strictEqual(result.sql.table, 'product', 'table from STATEMENT');
  assert.strictEqual(result.sql.paramIndex, 3, 'paramIndex from CONTEXT');
  assert.strictEqual(result.sql.paramValue, 'undefined', 'paramValue from ERROR text');
  assert.strictEqual(result.sql.statement && result.sql.statement.length > 0, true, 'statement present');
  assert.strictEqual(result.path && result.path.length > 0, true, 'path extracted');
  done();
});

// FIX 4: raw-lines fallback when logExcerpt is truncated before the != $3 part
test('signatureExtractor: truncated logExcerpt but rawLines has full statement -> WITH_SQL with operator/column from raw', function(t, done) {
  // A log excerpt that includes ERROR/CONTEXT but is truncated before the end of STATEMENT
  var truncatedExcerpt = [
    '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "undefined"',
    '2026-10-23T12:20:02+00:00 stderr 2026-10-23 12:20:02 UTC CONTEXT:  unnamed portal parameter $3 = \'undefined\'',
    '2026-10-23T12:20:03+00:00 stderr 2026-10-23 12:20:03 UTC STATEMENT:  SELECT "product"."id","product"."name","product"."slug","product"."enabled","product"."deletedAt","product"."createdAt","product"."updatedAt","product"."category_id","product"."channel_id","product"."variantId","product"."description","product"."summary","product"."metaTitle","product"."metaDescription","product"."featuredImage","product"."width","product"."height","product"."depth","product"."weight" FROM "product" WHERE (("product"."deletedAt" IS NULL)) AND ("product"."enabled" = $2 AND "product"."id" '
  ].join('\n');

  // Full raw log lines carry the complete (untruncated) STATEMENT that includes
  // the "!= $3" condition lost by the truncated excerpt. extractFinding reads
  // these from input.logLines and falls back to them via parseLogExcerpt.
  var fullRawLines = [
    '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "undefined"',
    '2026-10-23T12:20:02+00:00 stderr 2026-10-23 12:20:02 UTC CONTEXT:  unnamed portal parameter $3 = \'undefined\'',
    '2026-10-23T12:20:03+00:00 stderr 2026-10-23 12:20:03 UTC STATEMENT:  SELECT "product"."id","product"."name","product"."slug" FROM "product" WHERE ("product"."enabled" = $2 AND "product"."id" != $3 AND "product"."channel_id" = $4) LIMIT $10 OFFSET $11',
    '2026-10-23T12:20:04+00:00 stderr 2026-10-23 12:20:04 UTC LOG:  execute <unnamed>: $1'
  ];

  var result = signatureExtractor.extractFinding({
    apiErrors: [{ message: 'invalid input syntax for type integer: "undefined"', path: ['products'], extensions: { code: '22P02' } }],
    logExcerpt: truncatedExcerpt,
    logLines: fullRawLines
  });

  assert.strictEqual(result.confidence, 'WITH_SQL', 'confidence must be WITH_SQL via raw-lines fallback');
  assert.strictEqual(result.sql.operator, '!=', 'operator != must be extracted from raw lines');
  assert.strictEqual(result.sql.column, 'id', 'column id must be extracted from raw lines');
  assert.strictEqual(result.sql.table, 'product', 'table product must be extracted from raw lines');
  assert.strictEqual(result.sql.paramIndex, 3, 'paramIndex 3 must be extracted from CONTEXT');
  assert.strictEqual(result.sql.paramValue, 'undefined', 'paramValue undefined from ERROR text');
  done();
});

test('signatureExtractor: raw-lines fallback not used when logExcerpt already yields sqlInfo', function(t, done) {
  var fullLogExcerpt = [
    '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "42"',
    '2026-10-23T12:20:02+00:00 stderr 2026-10-23 12:20:02 UTC CONTEXT:  unnamed portal parameter $3 = \'42\'',
    '2026-10-23T12:20:03+00:00 stderr 2026-10-23 12:20:03 UTC STATEMENT:  SELECT "product"."id" FROM "product" WHERE "product"."id" != $3'
  ].join('\n');

  var result = signatureExtractor.extractFinding({
    apiErrors: [{ message: 'invalid input syntax for type integer: "42"', path: ['products'], extensions: {} }],
    logExcerpt: fullLogExcerpt,
    logLines: ['extra', 'irrelevant', 'lines']
  });

  // logExcerpt is complete, so rawLines fallback should NOT be needed
  assert.strictEqual(result.confidence, 'WITH_SQL');
  assert.strictEqual(result.sql.operator, '!=', 'operator from logExcerpt, not affected by rawLines');
  assert.strictEqual(result.sql.column, 'id', 'column from logExcerpt');
  done();
});

test('signatureExtractor: raw-lines fallback gracefully handles null/undefined rawLogLines', function(t, done) {
  var truncatedLog = 'ERROR:  invalid input syntax\nCONTEXT:  unnamed portal parameter $3';
  var result = signatureExtractor.extractFinding({
    apiErrors: [{ message: 'invalid input syntax for type integer: "NaN"', path: ['x'], extensions: {} }],
    logExcerpt: truncatedLog,
    rawLogLines: null  // null should not throw
  });

  // Should fall back to notes (no crash), class is SQL_PARAM_TYPE or UNKNOWN
  assert.strictEqual(typeof result.class, 'string', 'class must be defined');
  assert.ok(result.notes && result.notes.length > 0, 'should have note about logExcerpt parsing failure');
  done();
});
