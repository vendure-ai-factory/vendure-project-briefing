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
  assert.strictEqual(status.status, 'fetched', 'fake package should be marked fetched');

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
