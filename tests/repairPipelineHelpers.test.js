'use strict';

// Unit tests for pipeline helper functions exported from pipeline/run-repair.mjs:
// maskSecretsOnly, extractErrorContextLines, buildLogShape.
// These are ESM modules, so we load them lazily via import().

var test = require('node:test');
var assert = require('node:assert');

var repairModulePromise = import('../pipeline/run-repair.mjs');

// ---------------------------------------------------------------------------
// F: maskSecretsOnly - preserves keywords/$N/operators, redacts secrets
// ---------------------------------------------------------------------------
test('maskSecretsOnly: preserves ERROR/CONTEXT/STATEMENT/DETAIL keywords', async function() {
  var repairModule = await repairModulePromise;
  var maskSecretsOnly = repairModule.maskSecretsOnly;

  assert.ok(maskSecretsOnly('ERROR: 23505: duplicate key') .indexOf('ERROR') !== -1, 'ERROR keyword preserved');
  assert.ok(maskSecretsOnly('CONTEXT: unnamed portal') .indexOf('CONTEXT') !== -1, 'CONTEXT keyword preserved');
  assert.ok(maskSecretsOnly('STATEMENT: SELECT 1')     .indexOf('STATEMENT') !== -1, 'STATEMENT keyword preserved');
  assert.ok(maskSecretsOnly('DETAIL: Key (slug)')       .indexOf('DETAIL') !== -1, 'DETAIL keyword preserved');

  // $N markers and operators inside a STATEMENT survive masking.
  var stmt = maskSecretsOnly('STATEMENT: SELECT * FROM "product" WHERE "product"."id" != $3');
  assert.ok(stmt.indexOf('$3') !== -1, '$N marker preserved: ' + stmt);
  assert.ok(stmt.indexOf('!=') !== -1, '!= operator preserved: ' + stmt);
});

test('maskSecretsOnly: redacts sk-/ghp_/Bearer token values (label may remain)', async function() {
  var repairModule = await repairModulePromise;
  var maskSecretsOnly = repairModule.maskSecretsOnly;

  var secrets = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'gho_abcdefghijklmnopqrstuvwxyz1234567890',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890'
  ];

  secrets.forEach(function(secret) {
    var masked = maskSecretsOnly('Authorization: Bearer ' + secret);
    assert.strictEqual(masked.indexOf(secret), -1, 'raw token value must be gone: ' + masked);
    assert.ok(masked.indexOf('XXXX') !== -1, 'token redacted to XXXX: ' + masked);
  });
});

test('maskSecretsOnly: redacts long hex/base64 token values', async function() {
  var repairModule = await repairModulePromise;
  var maskSecretsOnly = repairModule.maskSecretsOnly;

  var hex = 'Token: 5f2c3d4e5f2c3d4e5f2c3d4e5f2c3d4e5f2c3d4e5f2c3d4e';
  var maskedHex = maskSecretsOnly(hex);
  assert.strictEqual(maskedHex.indexOf('5f2c3d4e'), -1, 'hex token value gone: ' + maskedHex);
  assert.ok(maskedHex.indexOf('XXXX') !== -1 || maskedHex.indexOf('TOKEN_') !== -1, 'hex redacted: ' + maskedHex);

  var b64 = 'Token: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+';
  var maskedB64 = maskSecretsOnly(b64);
  assert.ok(maskedB64.indexOf('XXXX') !== -1 || maskedB64.indexOf('B64_') !== -1, 'base64 redacted: ' + maskedB64);
  assert.strictEqual(maskedB64.indexOf('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'), -1, 'base64 token value gone');
});

test('maskSecretsOnly: redacts emails and DB connection passwords', async function() {
  var repairModule = await repairModulePromise;
  var maskSecretsOnly = repairModule.maskSecretsOnly;

  var email = maskSecretsOnly('contact: john.doe@example.com');
  assert.ok(email.indexOf('EMAIL_REDACTED') !== -1, 'email redacted: ' + email);
  assert.strictEqual(email.indexOf('john.doe@example.com'), -1, 'original email gone');

  var db = maskSecretsOnly('postgresql://admin:pw12345678@db:5432/shop');
  assert.ok(db.indexOf('USER:PASSWORD@') !== -1, 'db password redacted: ' + db);
  assert.strictEqual(db.indexOf('pw12345678'), -1, 'db password value gone');
});

test('maskSecretsOnly: masks ISO timestamps to 9999-99-99 format', async function() {
  var repairModule = await repairModulePromise;
  var maskSecretsOnly = repairModule.maskSecretsOnly;

  var lines = [
    '2026-10-21T12:00:00.001Z ERROR: something',
    '2026-10-21 12:00:00 UTC [42] ERROR: something',
    '[2026-10-21T12:00:00.001Z] ERROR: something'
  ];

  lines.forEach(function(line) {
    var masked = maskSecretsOnly(line);
    assert.ok(masked.indexOf('9999') !== -1, 'timestamp masked in: ' + masked);
    assert.strictEqual(masked.indexOf('2026-10-21'), -1, 'original date gone');
  });
});

test('maskSecretsOnly: preserves operators != LIKE = and $N markers', async function() {
  var repairModule = await repairModulePromise;
  var maskSecretsOnly = repairModule.maskSecretsOnly;

  var lines = [
    'WHERE "product"."id" != $3',
    'WHERE "product"."name" LIKE $1',
    'WHERE "product"."active" = $2'
  ];

  lines.forEach(function(line) {
    var masked = maskSecretsOnly(line);
    assert.ok(masked.indexOf('!=') !== -1 || masked.indexOf('LIKE') !== -1 || masked.indexOf('=') !== -1,
      'operators preserved in: ' + masked);
    assert.ok(/\$\d+/.test(masked), '$N preserved in: ' + masked);
  });
});

// ---------------------------------------------------------------------------
// G: extractErrorContextLines - extracts non-severity continuation lines
// following an ERROR that carry != or $N
// ---------------------------------------------------------------------------
test('extractErrorContextLines: extracts freeform continuation lines with != / $N', async function() {
  var repairModule = await repairModulePromise;
  var extractErrorContextLines = repairModule.extractErrorContextLines;

  var lines = [
    'ERROR: invalid input syntax',
    '  WHERE "product"."id" != $3',
    '  AND "product"."optional" = $4'
  ];

  var context = extractErrorContextLines(lines, 3);
  assert.ok(context.length >= 1, 'should extract context lines, got: ' + JSON.stringify(context));
  assert.ok(context[0].indexOf('!=') !== -1 && context[0].indexOf('$3') !== -1,
    'context should contain != and $N: ' + JSON.stringify(context));
});

test('extractErrorContextLines: respects maxContext limit', async function() {
  var repairModule = await repairModulePromise;
  var extractErrorContextLines = repairModule.extractErrorContextLines;

  var lines = ['ERROR: test', '  a != $1', '  b != $2', '  c != $3', '  d != $4'];

  var ctx2 = extractErrorContextLines(lines, 2);
  assert.strictEqual(ctx2.length, 2, 'maxContext=2 gives 2, got: ' + ctx2.length);

  var ctx3 = extractErrorContextLines(lines, 3);
  assert.strictEqual(ctx3.length, 3, 'maxContext=3 gives 3, got: ' + ctx3.length);
});

test('extractErrorContextLines: stops at severity markers', async function() {
  var repairModule = await repairModulePromise;
  var extractErrorContextLines = repairModule.extractErrorContextLines;

  var lines = ['ERROR: test', '  x != $1', 'LOG: stop here', '  y != $2'];

  var context = extractErrorContextLines(lines, 5);
  assert.strictEqual(context.length, 1, 'should stop at LOG, got: ' + context.length);
  assert.ok(context[0].indexOf('$1') !== -1, 'captured line before LOG');
});

test('extractErrorContextLines: skips CONTEXT/DETAIL/STATEMENT severity lines itself', async function() {
  var repairModule = await repairModulePromise;
  var extractErrorContextLines = repairModule.extractErrorContextLines;
  // CONTEXT/DETAIL/STATEMENT are severity markers; extractErrorContextLines does
  // not include them (parseLogExcerpt consumes them separately).
  var lines = [
    'ERROR: invalid input syntax',
    'CONTEXT: unnamed portal parameter $3',
    'STATEMENT: SELECT * FROM t WHERE id != $3'
  ];
  var context = extractErrorContextLines(lines, 3);
  assert.strictEqual(context.length, 0,
    'CONTEXT/STATEMENT severity lines are skipped, got: ' + JSON.stringify(context));
});

test('extractErrorContextLines: returns empty for lines without ERROR', async function() {
  var repairModule = await repairModulePromise;
  var extractErrorContextLines = repairModule.extractErrorContextLines;

  var context = extractErrorContextLines([
    '2026-10-21 12:00:00 UTC [42] LOG:  some log entry',
    '2026-10-21 12:00:00 UTC [42] INFO:  another entry'
  ], 3);
  assert.deepStrictEqual(context, [], 'no ERROR lines returns empty');
});

test('extractErrorContextLines: caps each line at 300 chars after masking', async function() {
  var repairModule = await repairModulePromise;
  var extractErrorContextLines = repairModule.extractErrorContextLines;

  // Many short tokens (not one long run) so masking does NOT collapse the line.
  var longLine = Array(100).join('word ') + ' != $1'; // ~500 chars
  var context = extractErrorContextLines(['ERROR: ' + longLine.substring(0, 10), '  ' + longLine], 3);
  assert.ok(context.length > 0, 'should extract context');
  assert.ok(context[0].length <= 303, 'capped at 300 (+"..." if truncated), got: ' + context[0].length);
});

// ---------------------------------------------------------------------------
// H: buildLogShape - edge cases
// ---------------------------------------------------------------------------
test('buildLogShape: handles empty logs gracefully', async function() {
  var repairModule = await repairModulePromise;
  var buildLogShape = repairModule.buildLogShape;

  var shape = buildLogShape({ postgres: [], vendure: [], worker: [] }, 'some error');

  assert.strictEqual(shape.masked, true, 'masked marker');
  assert.ok(shape.kinds, 'kinds present');
  assert.strictEqual(shape.kinds.postgres.lineCount, 0, 'postgres lineCount 0');
  assert.strictEqual(shape.kinds.postgres.first3Lines.length, 0, 'first3Lines empty');
});

test('buildLogShape: handles null/undefined logs', async function() {
  var repairModule = await repairModulePromise;
  var buildLogShape = repairModule.buildLogShape;

  var s1 = buildLogShape(null, 'error');
  assert.ok(s1.kinds, 'null logs still produce kinds');
  assert.strictEqual(s1.kinds.postgres.lineCount, 0, 'null postgres lineCount 0');

  var s2 = buildLogShape(undefined, 'error');
  assert.ok(s2.kinds, 'undefined logs still produce kinds');
});

test('buildLogShape: includes errorContextLines from extractErrorContextLines', async function() {
  var repairModule = await repairModulePromise;
  var buildLogShape = repairModule.buildLogShape;

  // Non-severity continuation lines carrying != / $N after an ERROR populate
  // errorContextLines (CONTEXT/STATEMENT severity lines are skipped there).
  var logs = {
    postgres: [
      '2026-10-21T12:00:00.001Z ERROR:  invalid input syntax for type integer: "NaN"',
      '2026-10-21T12:00:00.002Z   WHERE "order_line"."qty" != $5',
      '2026-10-21T12:00:00.003Z   AND "order_line"."id" != $3'
    ],
    vendure: [],
    worker: []
  };

  var shape = buildLogShape(logs, 'invalid input syntax');
  var pg = shape.kinds.postgres;
  assert.ok(pg.errorContextLines, 'should have errorContextLines');
  assert.ok(Array.isArray(pg.errorContextLines), 'errorContextLines should be array');
  assert.ok(pg.errorContextLines.length > 0, 'errorContextLines not empty');
  assert.ok(pg.errorContextLines[0].indexOf('$5') !== -1, 'context line carries $N');
});

test('buildLogShape: parameterLines is undefined when nothing matches', async function() {
  var repairModule = await repairModulePromise;
  var buildLogShape = repairModule.buildLogShape;

  var logs = {
    postgres: ['2026-10-21T12:00:00.001Z LOG:  some benign entry'],
    vendure: [],
    worker: []
  };

  var shape = buildLogShape(logs, 'no-match-marker');
  assert.strictEqual(shape.kinds.postgres.parameterLines, undefined, 'no parameterLines when nothing matches');
});
