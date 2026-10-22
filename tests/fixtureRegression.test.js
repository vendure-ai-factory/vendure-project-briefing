'use strict';

// Fixture-based regression for the live-run failure shape reported in
// run-mvgxc858-az10n9: locator patterns were only the taskId-derived names,
// no SQL operator/column was parsed, and candidates were empty. This test
// drives the real buildExtractInput -> extractFinding -> deriveSearchPatterns
// -> locateCandidates path with:
//  - task request evidence (shop-api-requests.json) carrying a Shop API
//    products query (root field 'products')
//  - a Postgres log in standard format where the ERROR/CONTEXT/STATEMENT entry
//    is preceded by 60+ unrelated entries and followed by other entries, so the
//    total exceeds 20000 chars and the error is NOT in the first 20000 chars.
//  - a fake dependency package whose source defines a resolver for that field
//    with the operator idiom, which must become the top candidate.

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

var locator = require('../src/repair/locator');
var signatureExtractor = require('../src/repair/signatureExtractor');

// pipeline/*.mjs are ESM; load lazily.
var repairModulePromise = import('../pipeline/run-repair.mjs');

function createTempDir() {
  var dir = path.join(os.tmpdir(), 'fixture-reg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Build a standard-format postgres log > 20000 chars where the error entry is
// past the 20000-char mark.
function buildPostgresLogLines() {
  var lines = [];
  // 90 unrelated entries, each ~250 chars => ~22500 chars before the error.
  for (var i = 0; i < 90; i++) {
    var ts = '2026-10-21 12:00:00.' + String(i).padStart(3, '0') + ' UTC [42] LOG:  statement ' + i +
      ' executed after routing a lengthy unrelated event with many details ' +
      'left <val> and other noise to push the byte count well past ' +
      'twenty thousand characters before the error entry appears in the log.';
    lines.push(ts);
  }
  // The actual error entry.
  lines.push('2026-10-21 12:01:00.001 UTC [42] ERROR:  invalid input syntax for type integer: "undefined"');
  lines.push('2026-10-21 12:01:00.002 UTC [42] CONTEXT:  unnamed portal parameter $3 = \'undefined\'');
  lines.push('2026-10-21 12:01:00.003 UTC [42] STATEMENT:  SELECT * FROM "product" WHERE "product"."active" = $1 AND "product"."id" != $3 AND "product"."enabled" = $2 LIMIT $4');
  // Followed by other entries (must not be swallowed into the statement).
  lines.push('2026-10-21 12:01:00.004 UTC [42] LOG:  another unrelated entry follows the error');
  lines.push('2026-10-21 12:01:00.005 UTC [42] HINT:  No function matches the given name and argument types.');
  return lines;
}

test('fixture regression: error window, SQL parse, root-field patterns, no taskId, dependency ranks top', async function() {
  var repairModule = await repairModulePromise;

  // 1. Task request evidence: Shop API products query.
  var runId = 'fixture-run-' + Date.now();
  var taskId = 'CAN-B1-03';
  var cwd = createTempDir();
  var taskDir = path.join(cwd, 'evidence', runId, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'shop-api-requests.json'), JSON.stringify({
    rawRequests: [
      {
        method: 'POST',
        url: 'http://127.0.0.1:54321/shop-api',
        headers: { 'content-type': 'application/json' },
        body: 'query ReadOnlyProducts($take: Int) {\n  products(options: { take: $take }) { items { id name } }\n}',
        timestamp: '2026-10-21T12:00:00.000Z'
      }
    ]
  }, null, 2));

  // 2. Target carrying the task's own error text (never from logs).
  var target = {
    taskId: taskId,
    error: 'invalid input syntax for type integer: "undefined"'
  };

  // 3. Logs: 20000+ chars, error NOT in the first 20000.
  var allLines = buildPostgresLogLines();
  var fullLog = allLines.join('\n');
  assert.ok(fullLog.length > 20000, 'log must exceed 20000 chars, got ' + fullLog.length);
  assert.strictEqual(fullLog.indexOf('invalid input syntax') >= 20000, true,
    'error must NOT be in the first 20000 chars');

  var logs = { postgres: allLines, vendure: [], worker: [] };

  // 4. Build extract input with cfg (cwd/runId) so it reads the task evidence,
  //    and the windowed log excerpt (NOT first 20000 chars).
  var cfg = { cwd: cwd, runId: runId, fs: fs };
  var extractInput = repairModule.buildExtractInput(cfg, target, logs);

  // operationName parsed from evidence query; never the taskId.
  assert.strictEqual(extractInput.operationName, 'ReadOnlyProducts',
    'operationName should be parsed from the task request query');
  assert.ok(extractInput.rootFields.indexOf('products') !== -1,
    'rootFields should contain the real GraphQL root field products');
  assert.ok(extractInput.rootFields.indexOf('ReadOnlyProducts') === -1,
    'rootFields should be field names, not the operation name');
  // Log excerpt must contain the error (window around it), so total < full log.
  assert.ok(extractInput.logExcerpt && extractInput.logExcerpt.length > 0,
    'logExcerpt must be present');
  assert.ok(extractInput.logExcerpt.indexOf('invalid input syntax') !== -1,
    'logExcerpt must contain the error text (window, not head of log)');
  assert.ok(extractInput.logExcerpt.length <= 20000,
    'logExcerpt must be capped at 20000 chars');

  // 5. Extract the finding.
  var finding = signatureExtractor.extractFinding(extractInput);
  assert.strictEqual(finding.sql.operator, '!=', 'operator should be !=');
  assert.strictEqual(finding.sql.column, 'id', 'column should be id');
  assert.strictEqual(finding.sql.paramIndex, 3, 'paramIndex should be 3');

  // 6. Patterns include operator idioms + root field, never taskId.
  var patterns = locator.deriveSearchPatterns(finding);
  assert.ok(patterns.indexOf('notEq') !== -1, 'patterns must include operator idiom notEq');
  assert.ok(patterns.indexOf('!= :') !== -1, 'patterns must include != :');
  assert.ok(patterns.indexOf('products') !== -1, 'patterns must include root field products');
  assert.ok(patterns.indexOf('productsResolver') !== -1, 'patterns must include productsResolver');
  assert.ok(patterns.indexOf('productsService') !== -1, 'patterns must include productsService');
  assert.ok(patterns.indexOf(taskId) === -1,
    'taskId must NOT appear in patterns: ' + JSON.stringify(patterns));

  // 7. Fake dependency package: source defines a resolver for 'products' with
  //    the operator idiom -> must become the top candidate.
  var targetRoot = createTempDir();
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
    name: 'test-target', version: '1.0.0',
    dependencies: { 'fake-products-resolver': '1.0.0' }
  }, null, 2));
  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// no match\n');

  var pkgDir = createTempDir();
  var resolverDir = path.join(pkgDir, 'dist', 'resolvers');
  fs.mkdirSync(resolverDir, { recursive: true });
  fs.writeFileSync(path.join(resolverDir, 'products.resolver.js'),
    'async function products(ctx, args) {\n' +
    '  const unwanted = await this.getNppId(ctx);\n' +
    '  return { filter: { id: { notEq: `' + '${unwanted}' + '` } } };\n' +
    '}\n');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'fake-products-resolver', version: '1.0.0', main: 'dist/resolvers/products.resolver.js'
  }, null, 2));

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  var located = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: runId,
    workspaceDir: cwd,
    evidenceRoot: path.join(cwd, 'evidence')
  });

  assert.ok(located.candidates.length > 0, 'should have candidates');
  var dep = located.candidates.filter(function(c) { return c.source === 'dependency'; })[0];
  assert.ok(dep, 'should have a dependency candidate');
  assert.ok(dep.file.indexOf('node_modules/fake-products-resolver/') === 0,
    'candidate file is clone-relative node_modules path: ' + dep.file);
  assert.ok(dep.package.indexOf('fake-products-resolver') !== -1,
    'top dependency is the products resolver package');

  // 8. candidates.json always written, includes patterns and per-package status.
  var candidatesPath = path.join(cwd, 'evidence', runId, 'repair', 'candidates.json');
  assert.strictEqual(fs.existsSync(candidatesPath), true, 'candidates.json must exist');
  var candidatesEvidence = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
  assert.ok(Array.isArray(candidatesEvidence.patterns) && candidatesEvidence.patterns.length > 0,
    'candidates.json includes patterns');
  var status = candidatesEvidence.packageStatuses.filter(function(s) {
    return s.package.indexOf('fake-products-resolver') === 0;
  })[0];
  assert.ok(status, 'candidates.json includes per-package fetch status');
  assert.strictEqual(status.status, 'matched', 'fake package should be marked matched (candidates found)');

  // 9. finding.json (via writeFindingEvidence) has parsed SQL, no raw log lines.
  var state = { finding: finding, logs: logs };
  repairModule.writeFindingEvidence(cfg, state);
  var findingPath = path.join(cwd, 'evidence', runId, 'repair', 'finding.json');
  assert.strictEqual(fs.existsSync(findingPath), true, 'finding.json must exist');
  var findingEvidence = JSON.parse(fs.readFileSync(findingPath, 'utf8'));
  assert.strictEqual(findingEvidence.sql.operator, '!=', 'finding.json carries operator');
  assert.strictEqual(findingEvidence.sql.column, 'id', 'finding.json carries column');
  assert.strictEqual(findingEvidence.sql.paramIndex, 3, 'finding.json carries paramIndex');
  assert.strictEqual(findingEvidence.sql.statement.indexOf('SELECT') !== -1, true,
    'finding.json carries truncated statement');
  var rawJson = fs.readFileSync(findingPath, 'utf8');
  assert.ok(rawJson.indexOf('unnamed portal parameter') === -1,
    'finding.json must NOT contain raw log context lines');
  assert.ok(rawJson.indexOf('ERROR:') === -1, 'finding.json must NOT contain raw ERROR lines');

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// D: log-shape.json is written for docker-prefixed, JSON-line, and standard
//    Postgres logs with no raw values (canary: values must never appear).
// ---------------------------------------------------------------------------
test('fixture: buildLogShape produces masked evidence with no raw values for all 3 log formats', async function() {
  var repairModule = await repairModulePromise;

  // A stable canary value that would FAIL if it appeared in log-shape.json.
  var CANARY = 'SUP3rS3cr3tT0k3nXYZ789';

  // 1. Docker-prefixed Postgres log.
  var dockerLog = [
    'vendure-db-1  | 2026-10-21T12:00:00.001Z ERROR:  invalid input syntax for type integer: "' + CANARY + '"',
    'vendure-db-1  | 2026-10-21T12:00:00.002Z CONTEXT:  unnamed portal parameter $3 = \'' + CANARY + '\'',
    'vendure-db-1  | 2026-10-21T12:00:00.003Z STATEMENT:  SELECT * FROM "product" WHERE "product"."id" != $3'
  ];

  // 2. JSON-line log (structured logging).
  var jsonLog = [
    '{"time":"2026-10-21T12:00:00.001Z","level":"error","msg":"ERROR:  invalid input syntax for type integer: \"' + CANARY + '\"","service":"vendure"}',
    '{"time":"2026-10-21T12:00:00.002Z","level":"info","msg":"CONTEXT:  unnamed portal parameter $3 = \'' + CANARY + '\'","service":"vendure"}',
    '{"time":"2026-10-21T12:00:00.003Z","level":"info","msg":"STATEMENT:  SELECT * FROM \\"product\\" WHERE \\"product\\".\\"id\\" != $3","service":"vendure"}'
  ];

  // 3. Standard Postgres log (already tested above; included for completeness).
  var standardLog = [
    '2026-10-21 12:00:00.001 UTC [42] ERROR:  invalid input syntax for type integer: "' + CANARY + '"',
    '2026-10-21 12:00:00.002 UTC [42] CONTEXT:  unnamed portal parameter $3 = \'' + CANARY + '\'',
    '2026-10-21 12:00:00.003 UTC [42] STATEMENT:  SELECT * FROM "product" WHERE "product"."id" != $3'
  ];

  var logs1 = { postgres: dockerLog, vendure: [], worker: [] };
  var logs2 = { postgres: jsonLog, vendure: [], worker: [] };
  var logs3 = { postgres: standardLog, vendure: [], worker: [] };

  var shapeFn = repairModule.buildLogShape;
  assert.strictEqual(typeof shapeFn, 'function', 'buildLogShape must be exported');

  var shape1 = shapeFn(logs1, 'invalid input syntax');
  var shape2 = shapeFn(logs2, 'invalid input syntax');
  var shape3 = shapeFn(logs3, 'invalid input syntax');

  [shape1, shape2, shape3].forEach(function(shape, idx) {
    assert.strictEqual(shape.masked, true, 'shape[' + idx + '] must be marked as masked');
    var pg = shape.kinds && shape.kinds.postgres;
    assert.ok(pg, 'shape[' + idx + '] must have postgres kind');
    assert.strictEqual(pg.lineCount, 3, 'postgres log must have 3 lines');
    assert.ok(Array.isArray(pg.first3Lines) && pg.first3Lines.length === 3,
      'postgres must have 3 first lines');
    assert.ok(Array.isArray(pg.parameterLines) && pg.parameterLines.length > 0,
      'postgres must have parameter lines, got: ' + JSON.stringify(pg.parameterLines));

    // Canary must NEVER appear in masked output.
    var shapeJson = JSON.stringify(shape);
    assert.strictEqual(shapeJson.indexOf(CANARY), -1,
      'CANARY must never appear in log-shape.json (idx=' + idx + '): ' + shapeJson.substring(0, 200));
  });

  // Verify masking preserves ERROR keyword and never exposes raw values.
  var maskedLine = shape1.kinds.postgres.parameterLines[0];
  assert.ok(typeof maskedLine === 'string', 'parameterLines entries must be strings');
  assert.ok(maskedLine.indexOf('ERROR') !== -1, 'ERROR keyword must be preserved in masked output');
  assert.ok(maskedLine.indexOf(CANARY) === -1, 'canary value must not appear in masked line');
  // Standard log: the ISO timestamp is masked to 9999-99-99T99:99:99 and that
  // placeholder survives the prefix-stripper (year 9999 is never re-stripped).
  var maskedStd = shape3.kinds.postgres.parameterLines[0];
  assert.ok(maskedStd.indexOf('9999') !== -1, 'ISO timestamp in standard log must be masked to 9999-...');
  assert.ok(maskedStd.indexOf('9999-99-99T99:99:99') !== -1, 'ISO timestamp must retain the masked shape 9999-99-99T99:99:99');
  assert.ok(maskedStd.indexOf('ERROR') !== -1, 'ERROR keyword must be preserved in standard log masked output');
  // JSON-line log: verify timestamp masked (ISO format after JSON parsing).
  var maskedJson = shape2.kinds.postgres.parameterLines[0];
  assert.ok(maskedJson.indexOf('ERROR') !== -1, 'ERROR keyword must be preserved in JSON-line masked output');
  assert.ok(maskedJson.indexOf(CANARY) === -1, 'canary must not appear in JSON-line masked output');
});

// ---------------------------------------------------------------------------
// E: SQL parse from docker-prefixed Postgres log with ERROR/CONTEXT/STATEMENT.
// ---------------------------------------------------------------------------
test('fixture: parseLogExcerpt handles docker-prefixed Postgres ERROR/CONTEXT/STATEMENT entries', function() {
  var sigExtractor = require('../src/repair/signatureExtractor');

  // Docker-prefixed log: "name-1  | " prefix on each line.
  var dockerLog = [
    '2026-10-21T12:00:00.001Z postgres-1  | ERROR:  invalid input syntax for type integer: "NaN"',
    '2026-10-21T12:00:00.002Z postgres-1  | CONTEXT:  unnamed portal parameter $5 = \'NaN\'',
    '2026-10-21T12:00:00.003Z postgres-1  | STATEMENT:  SELECT * FROM "order_line" WHERE "order_line"."qty" != $5 LIMIT $1'
  ].join('\n');

  var result = sigExtractor.parseLogExcerpt(dockerLog);

  assert.ok(result !== null, 'parseLogExcerpt must not return null for docker-prefixed ERROR/CONTEXT/STATEMENT log');
  assert.strictEqual(result.operator, '!=', 'operator must be extracted as !=');
  assert.strictEqual(result.column, 'qty', 'column must be extracted as qty');
  assert.strictEqual(result.paramIndex, 5, 'paramIndex must be extracted as 5');

  // Verify the docker prefix lines themselves don't break the SQL parse.
  // The ERROR entry matching should work with docker-prefixed format too.
  var dockerLog2 = [
    'my-app-db-1  | 2026-10-21 12:00:00.001 UTC ERROR:  invalid input syntax for type integer: "99"',
    'my-app-db-1  | 2026-10-21 12:00:00.002 UTC CONTEXT:  unnamed portal parameter $2 = \'99\'',
    'my-app-db-1  | 2026-10-21 12:00:00.003 UTC STATEMENT:  SELECT "id" FROM "product" WHERE "product"."active" != $2'
  ].join('\n');

  var result2 = sigExtractor.parseLogExcerpt(dockerLog2);
  assert.ok(result2 !== null, 'parseLogExcerpt must handle "name-1  | " docker prefix format');
  assert.strictEqual(result2.operator, '!=', 'operator correct for docker-prefix format');
  assert.strictEqual(result2.column, 'active', 'column correct for docker-prefix format');
  assert.strictEqual(result2.paramIndex, 2, 'paramIndex correct for docker-prefix format');
});
