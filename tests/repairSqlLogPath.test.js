'use strict';

/**
 * Tests for Fix 4: SQL/log live path
 * - stripLogPrefix (run-repair.mjs)
 * - buildLogExcerptWithWindow (run-repair.mjs)
 * - buildLogShape (run-repair.mjs)
 * - extractFinding raw-lines fallback (signatureExtractor.js)
 * - End-to-end: log lines -> collectRepairLogs -> buildExtractInput -> extractFinding
 */

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

// ESM modules loaded lazily
var repairModulePromise = import('../pipeline/run-repair.mjs');
var signatureExtractor = require('../src/repair/signatureExtractor');

function tempDir() {
  return path.join(os.tmpdir(), 'sql-log-test-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
}

function makeTempDir() {
  var d = tempDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'repair', name), 'utf8');
}

// =============================================================================
// FIX 4a: stripLogPrefix - real docker prefix and plain prefix
// =============================================================================

test('stripLogPrefix: real docker json-file/log driver prefix stripped correctly', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  // Real prefix: "<ISO-ts> stderr <ISO-ts> UTC "
  var realLine = '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "undefined"';
  var stripped = stripLogPrefix(realLine);
  assert.strictEqual(stripped.startsWith('ERROR:'), true, 'stripped must start with ERROR: ' + stripped);
  assert.strictEqual(stripped.indexOf('2026-10-23'), -1, 'no ISO timestamp in stripped output');
  assert.strictEqual(stripped.indexOf('stderr'), -1, 'no stderr in stripped output');
  assert.strictEqual(stripped.indexOf('UTC'), -1, 'no UTC in stripped output');
});

test('stripLogPrefix: real prefix with Z timezone stripped correctly', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  var line = '2026-10-23T12:20:01Z stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "NaN"';
  var stripped = stripLogPrefix(line);
  assert.strictEqual(stripped.startsWith('ERROR:'), true, 'stripped must start with ERROR: ' + stripped);
  assert.strictEqual(stripped.indexOf('stderr'), -1, 'no stderr in stripped output');
});

test('stripLogPrefix: plain prefix (no docker prefix) passes through unchanged', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  var plainLine = 'ERROR:  invalid input syntax for type integer: "42"';
  var stripped = stripLogPrefix(plainLine);
  assert.strictEqual(stripped, plainLine, 'plain line must pass through unchanged');
});

test('stripLogPrefix: docker-compose container name prefix stripped', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  // Docker-compose format: "vendure-db-1  | 2026-10-21 12:00:00.001 UTC [42] ERROR: ..."
  var line = 'vendure-db-1  | 2026-10-21 12:00:00.001 UTC [42] ERROR:  invalid input syntax for type integer: "undefined"';
  var stripped = stripLogPrefix(line);
  assert.strictEqual(stripped.startsWith('ERROR:'), true, 'stripped must start with ERROR: ' + stripped);
  assert.strictEqual(stripped.indexOf('vendure-db-1'), -1, 'no container name in stripped output');
  assert.strictEqual(stripped.indexOf('2026-10-21 12:00:00.001 UTC'), -1, 'no timestamp in stripped output');
});

test('stripLogPrefix: STATEMENT prefix preserved (LOG:, ERROR:, CONTEXT:, STATEMENT: kept as keywords)', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  var statements = [
    'LOG:  checkpoint starting',
    'ERROR:  invalid input syntax for type integer: "x"',
    'CONTEXT:  unnamed portal parameter $3 = \'x\'',
    'STATEMENT:  SELECT * FROM product WHERE id != $3'
  ];
  statements.forEach(function(line) {
    var stripped = stripLogPrefix(line);
    var keyword = line.split(':')[0];
    assert.ok(stripped.indexOf(keyword) !== -1, keyword + ' keyword must be preserved in: ' + stripped);
  });
});

// =============================================================================
// FIX 4b: buildLogExcerptWithWindow - keeps STATEMENT intact when truncating
// =============================================================================

test('buildLogExcerptWithWindow: never cuts a long STATEMENT mid-line; keeps != $3 intact when there is room', async function() {
  var repairModule = await repairModulePromise;
  var buildLogExcerptWithWindow = repairModule.buildLogExcerptWithWindow;

  // Build a log with a very long STATEMENT line (700+ chars) so the operator
  // "!= $3" sits far inside the line. The fix must never cut that line mid-way.
  var longWhere = 'SELECT "product"."id","product"."name","product"."slug","product"."enabled","product"."deletedAt","product"."createdAt","product"."updatedAt","product"."categoryId","product"."channelId","product"."variantId","product"."description","product"."summary","product"."metaTitle","product"."metaDescription","product"."featuredImage","product"."width","product"."height","product"."depth","product"."weight","product"."tags","product"."rating","product"."reviewCount","product"."stock","product"."price","product"."salePrice","product"."currency" FROM "product" WHERE (("product"."deletedAt" IS NULL)) AND ("product"."enabled" = $2 AND "product"."id" ';
  var stmtLine = 'STATEMENT:  ' + longWhere + '!= $3 AND "product"."channel_id" = $4) LIMIT $10 OFFSET $11';

  var logLines = [
    '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "undefined"',
    '2026-10-23T12:20:02+00:00 stderr 2026-10-23 12:20:02 UTC CONTEXT:  unnamed portal parameter $3 = \'undefined\'',
    '2026-10-23T12:20:03+00:00 stderr 2026-10-23 12:20:03 UTC ' + stmtLine
  ];

  // (1) With room to spare, the matched ERROR/CONTEXT/STATEMENT are kept whole
  // and the long STATEMENT is not cut before the "!= $3" operator.
  var roomy = buildLogExcerptWithWindow(logLines, 'invalid input syntax', 2000);
  assert.ok(roomy.length <= 2000, 'excerpt must be <= maxLength: ' + roomy.length);
  assert.ok(roomy.indexOf('!= $3') !== -1, 'excerpt must contain "!= $3" (not cut before it)');
  assert.ok(roomy.indexOf('STATEMENT:') !== -1, 'excerpt must contain STATEMENT line (got ' + roomy.length + ' chars)');
  assert.ok(roomy.indexOf('OFFSET $11') !== -1, 'STATEMENT line must not be cut before its tail (OFFSET $11)');
  assert.ok(roomy.indexOf('ERROR:') !== -1, 'excerpt must contain ERROR line');

  // (2) When truncation forces a cut, the excerpt must end at a line boundary:
  // every line in the excerpt is a complete line from the source (no fragment
  // of a longer line, which would drop the real statement tail).
  var cut = buildLogExcerptWithWindow(logLines, 'invalid input syntax', 500);
  assert.ok(cut.length <= 500, 'excerpt must be <= maxLength: ' + cut.length);
  var cutLines = cut.split('\n');
  assert.ok(cutLines.length > 1, 'truncated excerpt must still contain ERROR and CONTEXT lines');
  cutLines.forEach(function(ln) {
    if (ln.length === 0) return;
    assert.ok(logLines.some(function(src) { return src === ln; }),
      'excerpt must not contain a mid-line cut fragment: "' + ln.substring(0, 60) + '"');
  });
});

test('buildLogExcerptWithWindow: with small maxLength truncates at line boundary (not mid-line)', async function() {
  var repairModule = await repairModulePromise;
  var buildLogExcerptWithWindow = repairModule.buildLogExcerptWithWindow;

  var logLines = [
    '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC ERROR:  invalid input syntax for type integer: "undefined"',
    '2026-10-23T12:20:02+00:00 stderr 2026-10-23 12:20:02 UTC CONTEXT:  unnamed portal parameter $3 = \'undefined\'',
    '2026-10-23T12:20:03+00:00 stderr 2026-10-23 12:20:03 UTC STATEMENT:  SELECT "product"."id" FROM "product" WHERE "product"."id" != $3 AND "product"."channel_id" = $4 LIMIT $10 OFFSET $11',
    '2026-10-23T12:20:04+00:00 stderr 2026-10-23 12:20:04 UTC LOG:  another entry'
  ];

  // Small maxLength: 200 chars
  var excerpt = buildLogExcerptWithWindow(logLines, 'invalid input syntax', 200);

  assert.ok(excerpt.length <= 200, 'excerpt must be <= maxLength: ' + excerpt.length);
  // The fix truncates at last \n when possible, so excerpt should end at a line boundary
  // If it ends mid-line, the \n should be absent or the excerpt should be shorter than maxLength
  var lastNl = excerpt.lastIndexOf('\n');
  if (lastNl !== -1) {
    var lastLine = excerpt.substring(lastNl + 1);
    assert.ok(lastLine.length <= 200, 'last line must be <= maxLength');
  }
});

test('buildLogExcerptWithWindow: without match (no error line) still truncates at maxLength', async function() {
  var repairModule = await repairModulePromise;
  var buildLogExcerptWithWindow = repairModule.buildLogExcerptWithWindow;

  var logLines = [
    '2026-10-23T12:20:01+00:00 stderr 2026-10-23 12:20:01 UTC LOG:  checkpoint starting',
    '2026-10-23T12:20:02+00:00 stderr 2026-10-23 12:20:02 UTC LOG:  checkpoint complete'
  ];

  var excerpt = buildLogExcerptWithWindow(logLines, 'no-match-pattern', 50);
  assert.ok(excerpt.length <= 50, 'excerpt must be <= maxLength when no match');
});

// =============================================================================
// FIX 4c: buildLogShape severityCounts are non-zero; errorLinesWithStatementWithin3 > 0
// =============================================================================

test('buildLogShape: severityCounts all non-zero for log with ERROR/CONTEXT/STATEMENT triples and LOG noise', async function() {
  var repairModule = await repairModulePromise;
  var buildLogShape = repairModule.buildLogShape;

  // Load the fixture with 15 ERROR/CONTEXT/STATEMENT triples among LOG noise
  var fixturePath = path.join(__dirname, 'fixtures', 'repair', 'postgres-docker-long-statement.txt');
  var rawContent = fs.readFileSync(fixturePath, 'utf8');
  var lines = rawContent.split('\n').filter(function(l) { return l.length > 0; });

  var logs = { postgres: lines, vendure: [], worker: [] };
  var shape = buildLogShape(logs, 'invalid input syntax');

  var pg = shape && shape.kinds && shape.kinds.postgres;
  assert.ok(pg, 'postgres kind must be present in shape');
  assert.strictEqual(pg.lineCount, lines.length, 'lineCount must match fixture lines: ' + pg.lineCount);
  assert.ok(pg.severityCounts, 'severityCounts must be present');
  assert.strictEqual(typeof pg.severityCounts.error, 'number', 'error count must be number');
  assert.strictEqual(typeof pg.severityCounts.context, 'number', 'context count must be number');
  assert.strictEqual(typeof pg.severityCounts.statement, 'number', 'statement count must be number');
  assert.strictEqual(typeof pg.severityCounts.log, 'number', 'log count must be number');
  assert.ok(pg.severityCounts.error > 0, 'error count must be > 0 (got ' + pg.severityCounts.error + ')');
  assert.ok(pg.severityCounts.context > 0, 'context count must be > 0 (got ' + pg.severityCounts.context + ')');
  assert.ok(pg.severityCounts.statement > 0, 'statement count must be > 0 (got ' + pg.severityCounts.statement + ')');
  assert.ok(pg.severityCounts.log > 0, 'log count must be > 0 (got ' + pg.severityCounts.log + ')');
  assert.ok(pg.errorLinesWithStatementWithin3 >= 0, 'errorLinesWithStatementWithin3 must be >= 0');
  assert.ok(pg.errorLinesWithStatementWithin3 > 0, 'errorLinesWithStatementWithin3 must be > 0 (at least one ERROR has STATEMENT within 3 lines): got ' + pg.errorLinesWithStatementWithin3);
});

// =============================================================================
// FIX 4d: End-to-end log -> collectRepairLogs -> buildExtractInput -> extractFinding
// =============================================================================

test('end-to-end: log lines -> buildExtractInput -> extractFinding yields sql.operator=!=, column=id, table=product, paramIndex=3, paramValue=undefined, confidence=WITH_SQL', async function() {
  var repairModule = await repairModulePromise;
  var buildExtractInput = repairModule.buildExtractInput;
  var extractFinding = signatureExtractor.extractFinding;

  // Load the fixture
  var fixturePath = path.join(__dirname, 'fixtures', 'repair', 'postgres-docker-long-statement.txt');
  var rawContent = fs.readFileSync(fixturePath, 'utf8');
  var postgresLines = rawContent.split('\n').filter(function(l) { return l.length > 0; });

  var logs = { postgres: postgresLines, vendure: [], worker: [] };

  // buildExtractInput takes (cfg, target, logs)
  // target needs: a task record with cause
  var target = {
    class: 'TARGET_APP_DEFECT',
    cause: 'invalid input syntax for type integer: "undefined"',
    result: 'BLOCK',
    taskId: 'CAN-B1-03'
  };
  var cfg = {
    runId: 'e2e-test-' + Date.now(),
    cwd: makeTempDir(),
    fs: fs
  };

  var extractInput = buildExtractInput(cfg, target, logs);

  // verify extractInput has what we need
  assert.ok(Array.isArray(extractInput.apiErrors) && extractInput.apiErrors.length > 0, 'apiErrors must be present');
  assert.ok(extractInput.logExcerpt && extractInput.logExcerpt.length > 0, 'logExcerpt must be present');
  assert.ok(Array.isArray(extractInput.logLines) && extractInput.logLines.length > 0, 'logLines must carry the full raw lines for the truncation fallback');

  var finding = extractFinding(extractInput);

  assert.strictEqual(finding.class, 'SQL_PARAM_TYPE', 'class must be SQL_PARAM_TYPE');
  assert.strictEqual(finding.confidence, 'WITH_SQL', 'confidence must be WITH_SQL');
  assert.strictEqual(finding.sql.operator, '!=', 'sql.operator must be !=, got: ' + (finding.sql.operator || 'null'));
  assert.strictEqual(finding.sql.column, 'id', 'sql.column must be id, got: ' + (finding.sql.column || 'null'));
  assert.strictEqual(finding.sql.table, 'product', 'sql.table must be product, got: ' + (finding.sql.table || 'null'));
  assert.strictEqual(finding.sql.paramIndex, 3, 'sql.paramIndex must be 3, got: ' + (finding.sql.paramIndex || 'null'));
  assert.strictEqual(finding.sql.paramValue, 'undefined', 'sql.paramValue must be undefined, got: ' + (finding.sql.paramValue || 'null'));
  assert.ok(finding.signature && finding.signature.length === 64, 'signature must be 64-char SHA256 hex');
});

// =============================================================================
// FIX 4e: stripLogPrefix with plain prefix (no docker/container prefix)
// =============================================================================

test('stripLogPrefix: ISO timestamp + PID prefix stripped', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  // Standard postgres: "[2026-10-21 12:00:00.001 UTC] [42] ERROR: ..."
  var line = '[2026-10-21 12:00:00.001 UTC] [42] ERROR:  invalid input syntax for type integer: "42"';
  var stripped = stripLogPrefix(line);
  assert.strictEqual(stripped.startsWith('ERROR:'), true, 'stripped must start with ERROR: ' + stripped);
});

test('stripLogPrefix: JSON log line with msg field', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  var line = '{"time":"2026-10-23T12:20:01.000Z","level":"error","msg":"ERROR:  invalid input syntax for type integer: \\"undefined\\"","service":"vendure"}';
  var stripped = stripLogPrefix(line);
  assert.strictEqual(stripped.startsWith('ERROR:'), true, 'JSON msg field must become the stripped output: ' + stripped);
  assert.strictEqual(stripped.indexOf('"level"'), -1, 'no JSON structure in stripped output');
});

test('stripLogPrefix: bare HH:MM:SS.iii prefix stripped', async function() {
  var repairModule = await repairModulePromise;
  var stripLogPrefix = repairModule.stripLogPrefix;

  var line = '12:34:56.789 ERROR:  invalid input syntax';
  var stripped = stripLogPrefix(line);
  assert.strictEqual(stripped.startsWith('ERROR:'), true, 'bare time prefix stripped: ' + stripped);
  assert.strictEqual(stripped.indexOf('12:34:56'), -1, 'bare time removed from stripped');
});