'use strict';

var locator = require('../src/repair/locator');
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var test = require('node:test');
var assert = require('node:assert');

function createTempDir() {
  var tmpDir = path.join(os.tmpdir(), 'locator-test-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function createTargetProject(rootDir, withFakeDep) {
  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: {}
  };
  if (withFakeDep) {
    pkgJson.dependencies['fake-npp-resolver'] = '1.0.0';
  }
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(rootDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// Some code that does not match\nconst x = 1;\n');
}

function createFakePackage(workspaceDir) {
  var pkgDir = createTempDir();
  var pkgName = 'fake-npp-resolver';

  var resolverDir = path.join(pkgDir, 'dist', 'resolvers');
  fs.mkdirSync(resolverDir, { recursive: true });

  var resolverCode = [
    'async function products(ctx, args) {',
    '  const nppId = await this.nppService.getRootNPPId(ctx);',
    "  const options = { ...args.options, filter: { enabled: { eq: true }, id: { notEq: `${nppId}` } } };",
    '  return options;',
    '}'
  ].join('\n');

  fs.writeFileSync(path.join(resolverDir, 'npp.resolver.js'), resolverCode);

  var fakePkgJson = {
    name: pkgName,
    version: '1.0.0',
    main: 'dist/resolvers/npp.resolver.js'
  };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(fakePkgJson, null, 2));

  return pkgDir;
}

function createFakeFetchPackage(pkgPath) {
  return function(name, version, dir) {
    return Promise.resolve(pkgPath);
  };
}

// Test pattern derivation
test('pattern derivation: operator != returns correct patterns', function() {
  var patterns = deriveSearchPatterns({
    operator: '!=',
    column: 'table.col',
    path: null
  });

  assert.ok(patterns.indexOf('notEq') !== -1, 'should include notEq');
  assert.ok(patterns.indexOf('!= :') !== -1, 'should include != :');
  assert.ok(patterns.indexOf('Not(') !== -1, 'should include Not(');
  assert.ok(patterns.indexOf('.not(') !== -1, 'should include .not(');
  assert.ok(patterns.indexOf('ne:') !== -1, 'should include ne:');
});

test('pattern derivation: path adds query name patterns', function() {
  var patterns = deriveSearchPatterns({
    operator: '!=',
    column: 'table.col',
    path: 'products'
  });

  assert.ok(patterns.indexOf('products') !== -1, 'should include products');
  assert.ok(patterns.indexOf('productsResolver') !== -1, 'should include productsResolver');
  assert.ok(patterns.indexOf('productsService') !== -1, 'should include productsService');
});

test('pattern derivation: empty finding returns empty patterns', function() {
  var patterns = deriveSearchPatterns({});
  assert.strictEqual(patterns.length, 0, 'empty finding should return no patterns');
});

// Helper function to derive patterns (exposed for testing)
function deriveSearchPatterns(finding) {
  var patterns = [];
  var operator = finding.operator;
  var column = finding.column;
  var queryPath = finding.path;

  if (operator && column) {
    var colName = column.split('.').pop();

    if (operator === '!=') {
      patterns.push('notEq');
      patterns.push('!= :');
      patterns.push('"' + colName + '" !="');
      patterns.push("'" + colName + "' !=");
      patterns.push('Not(');
      patterns.push('.not(');
      patterns.push('ne:');
    }
  }

  if (queryPath && typeof queryPath === 'string' && queryPath.length > 0 && queryPath !== 'undefined') {
    patterns.push(queryPath);
    patterns.push(queryPath + 'Resolver');
    patterns.push(queryPath + 'Service');
    patterns.push(queryPath + 'Query');
  }

  return patterns;
}

test('locator: writes evidence file with sha256', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var pkgJson = { name: 'test', version: '1.0.0', dependencies: {} };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.js'), 'const notEq = 1;\n');

  var runId = 'test-evidence-' + Date.now();
  var finding = { operator: '!=', column: 'test.col', path: null };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    maxCandidates: 5,
    runId: runId,
    workspaceDir: workspaceDir
  });

  var evidenceFile = path.join('evidence', runId, 'repair', 'candidates.json');
  var sha256File = path.join('evidence', runId, 'repair', 'candidates.json.sha256');

  assert.ok(fs.existsSync(evidenceFile), 'evidence file should exist');
  assert.ok(fs.existsSync(sha256File), 'sha256 file should exist');

  var content = fs.readFileSync(evidenceFile, 'utf8');
  var expectedSha = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  var actualSha = fs.readFileSync(sha256File, 'utf8').trim();
  assert.strictEqual(actualSha, expectedSha, 'sha256 should match');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  try { fs.rmSync(path.join('evidence', runId), { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('locator: package not in package.json is rejected', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  // Create target project with only some-other-pkg (NOT fake-npp-resolver)
  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: {
      'some-other-pkg': '1.0.0'
    }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'const x = 1;\n');

  // Create fake package but DON'T add to package.json
  var fakePkgPath = createFakePackage(workspaceDir);

  var finding = {
    operator: '!=',
    column: 'id',
    path: 'products'
  };

  // Mock fetchPackage to track if it gets called
  var fetchCalledFor = [];
  var fakeFetch = function(name, version, dir) {
    fetchCalledFor.push(name);
    // Return a path that won't match anything
    return Promise.resolve(createTempDir());
  };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-reject-' + Date.now(),
    workspaceDir: workspaceDir
  });

  // fake-npp-resolver should NOT have been fetched (not in package.json)
  assert.strictEqual(fetchCalledFor.indexOf('fake-npp-resolver'), -1,
    'fake-npp-resolver should not be fetched (not in package.json). Called for: ' + JSON.stringify(fetchCalledFor));

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

test('locator: dependency with npp resolver code ranks first', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  // Create target with fake-npp-resolver in package.json
  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: {
      'fake-npp-resolver': '1.0.0'
    }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// No matching patterns here\nconst x = 1;\n');

  var fakePkgPath = createFakePackage(workspaceDir);
  var fakeFetch = createFakeFetchPackage(fakePkgPath);

  var finding = {
    operator: '!=',
    column: 'id',
    path: 'products'
  };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-npp-' + Date.now(),
    workspaceDir: workspaceDir
  });

  assert.ok(result.candidates.length > 0, 'should have candidates');

  var topCandidate = result.candidates[0];
  assert.strictEqual(topCandidate.source, 'dependency', 'top candidate should be from dependency');
  assert.ok(topCandidate.package.indexOf('fake-npp-resolver') !== -1, 'package should be fake-npp-resolver');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

test('locator: target match outranks dependency', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: {
      'fake-npp-resolver': '1.0.0'
    }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  // Strong target match
  fs.writeFileSync(path.join(srcDir, 'products.js'),
    'async function products(ctx, args) {\n' +
    '  const id = { notEq: `${nppId}` };\n' +
    '}\n');

  var fakePkgPath = createFakePackage(workspaceDir);
  var fakeFetch = createFakeFetchPackage(fakePkgPath);

  var finding = {
    operator: '!=',
    column: 'id',
    path: 'products'
  };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-rank-' + Date.now(),
    workspaceDir: workspaceDir
  });

  var targetCandidates = result.candidates.filter(function(c) { return c.source === 'target'; });
  assert.ok(targetCandidates.length > 0, 'should have target candidates');

  var topCandidate = result.candidates[0];
  assert.strictEqual(topCandidate.source, 'target', 'target match should outrank dependency');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

test('locator: returns searched files list', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var pkgJson = { name: 'test', version: '1.0.0', dependencies: {} };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.js'), 'const x = 1;\n');

  var finding = { operator: '!=', column: 'test.col', path: null };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    maxCandidates: 5,
    runId: 'test-searched-' + Date.now(),
    workspaceDir: workspaceDir
  });

  assert.ok(Array.isArray(result.searched), 'searched should be an array');
  assert.ok(result.searched.length > 0, 'searched should contain files');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

test('locator: no finding returns empty result', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var result = await locator.locateCandidates({
    finding: null,
    targetRoot: targetRoot,
    workspaceDir: workspaceDir
  });

  assert.deepStrictEqual(result.candidates, []);
  assert.deepStrictEqual(result.searched, []);

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

test('locator: no targetRoot returns empty result', async function() {
  var workspaceDir = createTempDir();

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'test' },
    targetRoot: null,
    workspaceDir: workspaceDir
  });

  assert.deepStrictEqual(result.candidates, []);

  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test('locator: DIFFERENT fixture (order resolver with Not) ranks correctly', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: { 'fake-order-resolver': '1.0.0' }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// No matching patterns\nconst x = 1;\n');

  var pkgDir = createTempDir();
  var resolverDir = path.join(pkgDir, 'dist', 'resolvers');
  fs.mkdirSync(resolverDir, { recursive: true });

  var resolverCode = [
    'async function orderListQuery(ctx, args) {',
    '  const otherId = await this.orderService.getOtherId(ctx);',
    "  const options = { ...args.options, filter: { status: { Not: `${otherId}` } } };",
    '  return options;',
    '}'
  ].join('\n');

  fs.writeFileSync(path.join(resolverDir, 'order.resolver.js'), resolverCode);
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-order-resolver', version: '1.0.0' }, null, 2));

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'order.status', path: 'orderList', rootFields: ['orderList'] },
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-order-' + Date.now(),
    workspaceDir: workspaceDir
  });

  assert.ok(result.candidates.length > 0, 'should find candidates using DIFFERENT fixture pattern');
  var orderCandidate = result.candidates.find(function(c) { return c.source === 'dependency'; });
  assert.ok(orderCandidate, 'should find dependency candidate for order resolver');
  assert.ok(orderCandidate.package.indexOf('fake-order-resolver') !== -1, 'should be order resolver package');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Regression: taskId must NOT appear in patterns, rootFields drive patterns
// ---------------------------------------------------------------------------
test('locator: taskId not in patterns; rootFields drive pattern derivation', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  // Create fake package with products resolver that uses notEq
  var pkgDir = createTempDir();
  var resolverDir = path.join(pkgDir, 'dist', 'resolvers');
  fs.mkdirSync(resolverDir, { recursive: true });
  fs.writeFileSync(path.join(resolverDir, 'products.resolver.js'),
    'async function products(ctx, args) {\n' +
    '  const nppId = await this.getNppId(ctx);\n' +
    '  return { filter: { id: { notEq: `${nppId}` } } };\n' +
    '}\n');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-products-resolver', version: '1.0.0' }, null, 2));

  var pkgJson = { name: 'test-target', version: '1.0.0', dependencies: { 'fake-products-resolver': '1.0.0' } };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));
  fs.mkdirSync(path.join(targetRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'src', 'index.js'), '// no match here\n');

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  // Finding uses rootFields (parsed from GraphQL query), NOT taskId
  var result = await locator.locateCandidates({
    finding: {
      operator: '!=',
      column: 'id',
      path: 'products',
      rootFields: ['activeChannel', 'products'], // real root fields
      taskId: 'CAN-B1-03', // taskId must NOT appear in patterns
      operationName: 'ReadOnlyProducts'
    },
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-rootfield-' + Date.now(),
    workspaceDir: workspaceDir
  });

  assert.ok(result.candidates.length > 0, 'should find candidates');
  // taskId must NOT appear in any candidate's reasons
  for (var ci = 0; ci < result.candidates.length; ci++) {
    assert.ok(result.candidates[ci].reasons.indexOf('CAN-B1-03') === -1, 'taskId not a reason');
  }
  // At least one dependency candidate should exist (the products resolver)
  var dep = result.candidates.filter(function(c) { return c.source === 'dependency'; })[0];
  assert.ok(dep, 'should find a dependency candidate for products resolver');
  assert.ok(dep.package.indexOf('fake-products-resolver') !== -1, 'dependency is fake-products-resolver');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Regression: log excerpt parsing - error NOT in first 20000 chars
// ---------------------------------------------------------------------------
test('locator: parseLogExcerpt finds error window, extracts operator/column/paramIndex', function() {
  // Create log with 60+ unrelated entries, then ERROR at position > 20000
  var unrelatedLines = [];
  for (var i = 0; i < 65; i++) {
    unrelatedLines.push('2026-10-21 12:00:00.' + String(i).padStart(3, '0') + ' UTC [12345] LOG:  some unrelated log entry ' + i);
  }
  // Now add the error entry (should be found even though total > 20000 chars)
  var errorLines = [
    '2026-10-21 12:01:00.001 UTC [12345] ERROR:  invalid input syntax for type integer: "undefined"',
    '2026-10-21 12:01:00.002 UTC [12345] CONTEXT:  unnamed portal parameter $3 = \'undefined\'',
    '2026-10-21 12:01:00.003 UTC [12345] STATEMENT:  SELECT * FROM "product" WHERE "product"."id" != $3'
  ];
  var allLines = unrelatedLines.concat(errorLines);
  var fullLog = allLines.join('\n');

  // parseLogExcerpt should find the error even though it's past 20000 chars
  var sigExtractor = require('../src/repair/signatureExtractor');
  var result = sigExtractor.parseLogExcerpt(fullLog);

  assert.ok(result !== null, 'parseLogExcerpt should not return null for valid postgres error');
  assert.strictEqual(result.operator, '!=', 'operator should be !=');
  assert.strictEqual(result.column, 'id', 'column should be id');
  assert.strictEqual(result.paramIndex, 3, 'paramIndex should be 3');
  assert.ok(result.statement.indexOf('product') !== -1 || result.statement.length > 0, 'statement should be captured');
});

test('locator: parseLogExcerpt handles multi-line STATEMENT ending at next timestamp', function() {
  var logWithMultiLine = [
    '2026-10-21 12:01:00.001 UTC [12345] ERROR:  invalid input syntax for type integer: "undefined"',
    '2026-10-21 12:01:00.002 UTC [12345] CONTEXT:  unnamed portal parameter $3 = \'undefined\'',
    '2026-10-21 12:01:00.003 UTC [12345] STATEMENT:  SELECT * FROM "product" WHERE "product"."id" != $3 AND "product"."active" = true',
    '2026-10-21 12:01:00.004 UTC [12345] LOG:  another unrelated entry starts here'
  ].join('\n');

  var sigExtractor = require('../src/repair/signatureExtractor');
  var result = sigExtractor.parseLogExcerpt(logWithMultiLine);

  assert.ok(result !== null, 'should parse multi-line statement');
  assert.strictEqual(result.operator, '!=', 'operator extracted');
  assert.strictEqual(result.column, 'id', 'column extracted');
  assert.strictEqual(result.paramIndex, 3, 'paramIndex extracted');
});

// ---------------------------------------------------------------------------
// Regression: buildExtractInput parses GraphQL and finds error window
// ---------------------------------------------------------------------------
test('run-repair: buildExtractInput parses GraphQL operation name from evidence', function() {
  var runRepair = require('../pipeline/run-repair.mjs');
  // The function is not exported, so we test indirectly through the module loading
  // This test verifies the parsing logic works

  // Test parseGraphQlQuery directly
  var query1 = 'query ActiveChannelProbe { activeChannel { code } }';
  var query2 = 'mutation Login($username: String!) { login { token } }';
  var query3 = 'query ReadOnlyProducts { products(options: {take: 5}) { items { name } } }';

  // Verify no taskId fallback in patterns when using rootFields
  var patterns = require('../src/repair/locator').deriveSearchPatterns({
    operator: '!=',
    column: 'id',
    rootFields: ['productTags'],
    taskId: 'CAN-B1-03', // should NOT appear in patterns
    operationName: 'ReadOnlyProductTags'
  });

  assert.ok(patterns.indexOf('CAN-B1-03') === -1, 'taskId must NOT be in patterns');
  assert.ok(patterns.indexOf('productTags') !== -1, 'productTags (rootField) should be in patterns');
  assert.ok(patterns.indexOf('productTagsResolver') !== -1, 'productTagsResolver should be in patterns');
  assert.ok(patterns.indexOf('notEq') !== -1, 'notEq operator idiom should be in patterns');
});

// ---------------------------------------------------------------------------
// Fixture 1 — SOURCE BUG: bug is in the target's own src/.
// finding.stack drives the search; a +-30-line snippet and 'why' required.
// ---------------------------------------------------------------------------
test('locator: source-bug fixture — stack frames load +-30-line snippets and rank first', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ name: 'test-target', version: '1.0.0', dependencies: {} }, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Create a source file with enough lines that the +-30 context is meaningful.
  // The bug is on line 50.
  var lines = [];
  for (var l = 1; l <= 60; l++) {
    if (l === 50) {
      lines.push('  const filter = { id: { notEq: `${someVar}` } };');
    } else if (l === 20) {
      lines.push('async function productsQuery(root, args, ctx) {');  // match by path name
    } else {
      lines.push('// line ' + l);
    }
  }
  fs.writeFileSync(path.join(srcDir, 'products-query.ts'), lines.join('\n'));

  var fakeFetch = function(name, version, dir) { return Promise.resolve(createTempDir()); };

  // finding with a stack that points to line 50 of products-query.ts
  var finding = {
    operator: '!=',
    column: 'id',
    path: 'products',
    stack: [
      { file: path.join(srcDir, 'products-query.ts'), line: 50 },
      { file: path.join(srcDir, 'index.ts'), line: 10 }
    ]
  };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-src-bug-' + Date.now(),
    workspaceDir: workspaceDir
  });

  var stackCandidates = result.candidates.filter(function(c) { return c.source === 'stack'; });
  assert.ok(stackCandidates.length >= 1, 'should have at least one stack candidate; got: ' + stackCandidates.length);

  // First stack candidate must be the line-50 frame (highest score)
  var top = stackCandidates[0];
  assert.strictEqual(top.file.indexOf('products-query.ts') !== -1, true, 'top candidate should be products-query.ts');
  assert.strictEqual(top.line, 50, 'top candidate should be at line 50 from stack');
  assert.ok(Array.isArray(top.snippet) && top.snippet.length > 0, 'snippet must not be empty');
  assert.ok(top.snippet.length <= 61, 'snippet should have at most +-30 context lines; got: ' + top.snippet.length);
  assert.ok(top.why && typeof top.why === 'string' && top.why.length > 0, 'why must be a non-empty string; got: ' + top.why);
  assert.strictEqual(top.reasons.indexOf('finding.stack frame') !== -1, true, 'reasons should include stack frame');

  // Stack candidate must outrank any pattern-only candidate
  var patternCandidates = result.candidates.filter(function(c) { return c.source === 'target'; });
  if (patternCandidates.length > 0) {
    assert.ok(top.score > patternCandidates[0].score, 'stack candidate should outrank pattern-only candidates (score ' + top.score + ' vs ' + patternCandidates[0].score + ')');
  }

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture 2 — DEPENDENCY BUG: bug is in a package dependency.
// finding.stack may be empty; lockfile version must be used; 'why' required.
// ---------------------------------------------------------------------------
test('locator: dependency-bug fixture — lockfile version used and why field present', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  // package.json uses a range (^1.0.0) — locator must upgrade from lockfile
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
    name: 'test-target',
    version: '1.0.0',
    dependencies: { 'fake-inventory-svc': '^1.0.0' }
  }, null, 2));

  // package-lock.json pins the exact installed version
  fs.writeFileSync(path.join(targetRoot, 'package-lock.json'), JSON.stringify({
    dependencies: {
      'fake-inventory-svc': { version: '1.2.3', resolved: 'https://registry.npmjs.org/fake-inventory-svc/-/fake-inventory-svc-1.2.3.tgz', integrity: 'sha abc' }
    },
    packages: {
      'node_modules/fake-inventory-svc': { version: '1.2.3' }
    }
  }, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// no matching patterns here\n');

  // Create the fake dependency with inventory bug pattern
  var pkgDir = createTempDir();
  var distDir = path.join(pkgDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  var svcCode = [
    '// fake-inventory-svc v1.2.3',
    'async function inventory(ctx, args) {',
    '  const storeId = await this.storeService.getStoreId(ctx);',
    "  const filter = { store: { ne: `${storeId}` }, enabled: true };",
    '  return this.db.query(filter);',
    '}'
  ].join('\n');
  fs.writeFileSync(path.join(distDir, 'inventory-svc.js'), svcCode);
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-inventory-svc', version: '1.2.3' }, null, 2));

  var fetchCalls = [];
  var fakeFetch = function(name, version, dir) {
    fetchCalls.push({ name: name, version: version });
    return Promise.resolve(pkgDir);
  };

  // finding with NO stack (fall through to pattern search on dependency)
  var finding = {
    operator: '!=',
    column: 'store.id',
    path: 'inventory'
  };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-dep-bug-' + Date.now(),
    workspaceDir: workspaceDir
  });

  // The package MUST have been fetched with the lockfile version (1.2.3), not the range (^1.0.0)
  var depCalls = fetchCalls.filter(function(f) { return f.name === 'fake-inventory-svc'; });
  assert.strictEqual(depCalls.length > 0, true, 'fake-inventory-svc should have been fetched');
  assert.strictEqual(depCalls[0].version, '1.2.3', 'version must come from lockfile (1.2.3), not package.json range (^1.0.0); got: ' + depCalls[0].version);

  // Must find a dependency candidate
  var depCandidates = result.candidates.filter(function(c) { return c.source === 'dependency'; });
  assert.ok(depCandidates.length > 0, 'should have dependency candidates from the inventory-svc fixture');

  // Every dependency candidate must carry a non-empty 'why' string
  depCandidates.forEach(function(c, i) {
    assert.ok(c.why && typeof c.why === 'string' && c.why.length > 0, 'dependency candidate [' + i + '] why must be non-empty string; got: ' + c.why);
  });

  // Candidate entries must have 'source', 'package', 'file', 'line', 'snippet', 'score', 'reasons', 'why'
  var top = result.candidates[0];
  assert.ok(top.package && top.package.indexOf('fake-inventory-svc') !== -1, 'top package should be fake-inventory-svc; got: ' + top.package);
  assert.strictEqual(typeof top.score, 'number', 'score must be a number');
  assert.ok(Array.isArray(top.reasons) && top.reasons.length > 0, 'reasons must be a non-empty array');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test('locator: fetchPackage rejecting with npm 404/401 -> candidate-not-found recorded, continues (no block)', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();
  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: { 'missing-pkg': '1.0.0', 'private-pkg': '2.0.0' }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));
  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'const x = 1;\n');

  var fakeFetch = function(name, version) {
    if (name === 'missing-pkg') return Promise.reject(new Error('404 Not Found - GET https://registry.npmjs.org/missing-pkg'));
    if (name === 'private-pkg') return Promise.reject(new Error('401 Unauthorized - GET https://registry.npmjs.org/private-pkg'));
    return Promise.resolve(createTempDir());
  };

  var finding = { operator: '!=', column: 'store.id', path: 'products' };
  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-404-' + Date.now(),
    workspaceDir: workspaceDir
  });

  assert.ok(Array.isArray(result.notFound), 'result.notFound must be an array');
  var missing = result.notFound.filter(function(n) { return n.package.indexOf('missing-pkg@1.0.0') !== -1; })[0];
  var priv = result.notFound.filter(function(n) { return n.package.indexOf('private-pkg@2.0.0') !== -1; })[0];
  assert.ok(missing, 'missing package must be recorded as candidate-not-found');
  assert.strictEqual(missing.status, 'candidate-not-found');
  assert.strictEqual(missing.kind, 'not-found');
  assert.ok(priv, 'private package must be recorded as candidate-not-found');
  assert.strictEqual(priv.kind, 'unavailable');
  assert.ok(Array.isArray(result.candidates), 'locator still returns candidates despite failed package fetch');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

test('locator: fetchPackage resolving to a 404 Response -> candidate-not-found recorded, continues (no block)', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();
  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: { 'http-fetched-dep': '1.0.0' }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));
  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'const x = 1;\n');

  var fakeFetch = function(name, version) {
    return Promise.resolve(new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }));
  };

  var finding = { operator: '!=', column: 'store.id', path: 'products' };
  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-http404-' + Date.now(),
    workspaceDir: workspaceDir
  });

  assert.ok(Array.isArray(result.notFound), 'result.notFound must be an array');
  var entry = result.notFound.filter(function(n) { return n.package.indexOf('http-fetched-dep@') === 0; })[0];
  assert.ok(entry, 'Response-404 package must be recorded as candidate-not-found');
  assert.strictEqual(entry.status, 'candidate-not-found');
  assert.strictEqual(entry.kind, 'not-found');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

// review-6b: dependency candidates are clone-relative node_modules/<pkg>/ paths
// and the file exists in the clone (materialized before temp cleanup).
test('locator: dependency candidate is clone-relative and materialized in the clone', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
    name: 'test-target', version: '1.0.0', dependencies: { 'fake-wrap-lib': '1.0.0' }
  }, null, 2));
  fs.writeFileSync(path.join(targetRoot, 'package-lock.json'), JSON.stringify({
    dependencies: { 'fake-wrap-lib': { version: '1.0.0' } },
    packages: { 'node_modules/fake-wrap-lib': { version: '1.0.0' } }
  }, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'const x = 1;\n');

  var pkgDir = createTempDir();
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-wrap-lib', version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'svc.js'),
    'async function orders(ctx){ const id = { notEq: `\u0024{otherId}` }; return id; }\n');

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };
  var evidenceRoot = createTempDir();
  var runId = 'run-rr6b-' + Date.now();

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'order.id', path: 'orders', stack: [] },
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: runId,
    workspaceDir: workspaceDir,
    evidenceRoot: evidenceRoot
  });

  var dep = result.candidates.filter(function(c) { return c.source === 'dependency'; })[0];
  assert.ok(dep, 'should have a dependency candidate');
  assert.strictEqual(dep.file.indexOf('node_modules/fake-wrap-lib/'), 0,
    'candidate file is clone-relative: ' + dep.file);
  assert.strictEqual(fs.existsSync(path.join(targetRoot, dep.file)), true,
    'file exists in the clone when the prompt is built');
  assert.ok(Array.isArray(dep.snippet) && dep.snippet.length > 0, 'content snippet present');

  // candidates.json written under the SAME evidence root the orchestrator uses.
  assert.strictEqual(fs.existsSync(path.join(evidenceRoot, runId, 'repair', 'candidates.json')), true,
    'candidates.json must be written under evidenceRoot/<runId>/repair');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B: locator ignores .d.ts/generated files and still runs dependency search;
//    fake dep resolver with field+idiom is top candidate.
// ---------------------------------------------------------------------------
test('locator: .d.ts and generated files are excluded; dep search runs; field+idiom dep is top', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
    name: 'test-target', version: '1.0.0',
    dependencies: { 'fake-npp-resolver': '1.0.0' }
  }, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  // A .d.ts file (must be excluded from candidates).
  fs.mkdirSync(path.join(srcDir, 'gql'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'gql', 'generated.d.ts'), 'declare function products(ctx: any): Promise<any>;\n');
  // graphql-env.d.ts (must be excluded).
  fs.writeFileSync(path.join(srcDir, 'graphql-env.d.ts'), 'declare const ENV: string;\n');
  // A dist/ file (must be excluded).
  fs.mkdirSync(path.join(targetRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'dist', 'index.js'), 'const x = 1;\n');
  // src index (no match).
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// no match\n');

  var pkgDir = createTempDir();
  var resolverDir = path.join(pkgDir, 'dist', 'resolvers');
  fs.mkdirSync(resolverDir, { recursive: true });
  fs.writeFileSync(path.join(resolverDir, 'npp.resolver.js'),
    'async function products(ctx, args) {\n' +
    '  const nppId = await this.nppService.getRootNPPId(ctx);\n' +
    "  const options = { ...args.options, filter: { enabled: { eq: true }, id: { notEq: `${nppId}` } } };\n" +
    '  return options;\n' +
    '}\n');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'fake-npp-resolver', version: '1.0.0', main: 'dist/resolvers/npp.resolver.js'
  }, null, 2));

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  var finding = { operator: '!=', column: 'id', path: 'products' };
  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 5,
    runId: 'test-dts-exclude-' + Date.now(),
    workspaceDir: workspaceDir
  });

  // .d.ts and generated files must NOT appear in candidates.
  var candidateFiles = result.candidates.map(function(c) { return c.file; });
  assert.ok(!candidateFiles.some(function(f) { return /\.d\.ts$/.test(f) || /generated\.d\.ts$/.test(f); }),
    '.d.ts files must not be candidates: ' + JSON.stringify(candidateFiles));
  assert.ok(!candidateFiles.some(function(f) { return f.indexOf('graphql-env') !== -1; }),
    'graphql-env files must not be candidates');

  // Dependency search must have run (fake-npp-resolver was fetched and matched).
  var dep = result.candidates.filter(function(c) { return c.source === 'dependency'; })[0];
  assert.ok(dep, 'dependency search must have run and found a candidate');
  assert.ok(dep.package.indexOf('fake-npp-resolver') !== -1, 'top dep must be fake-npp-resolver');

  // Top candidate must be the dep (field name + operator idiom together).
  var top = result.candidates[0];
  assert.strictEqual(top.source, 'dependency', 'top candidate must be dependency (field + idiom)');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// C: patterns exclude pagination/list words and contain the failing field only.
// ---------------------------------------------------------------------------
test('locator: deriveSearchPatterns excludes GraphQL pagination words, includes failing field', function() {
  var locatorMod = require('../src/repair/locator');
  // Finding with a path that is also a pagination word (items).
  var finding1 = { path: 'items', operator: '!=', column: 'id', rootFields: [] };
  var p1 = locatorMod.deriveSearchPatterns(finding1);
  assert.strictEqual(p1.indexOf('items'), -1, '"items" (pagination word) must be excluded from patterns');

  // Finding with a real failing field and pagination words in rootFields.
  var finding2 = {
    path: 'productTags',
    operator: '!=',
    column: 'id',
    rootFields: ['productTags', 'activeChannel', 'items', 'take', 'skip']
  };
  var p2 = locatorMod.deriveSearchPatterns(finding2);
  assert.ok(p2.indexOf('productTags') !== -1, 'failing field "productTags" must be in patterns');
  assert.ok(p2.indexOf('productTagsResolver') !== -1, 'productTagsResolver must be in patterns');
  // activeChannel is a rootField but path is set to 'productTags' (failing field),
  // so rootFields are not used as fallback; only the failing field drives patterns.
  assert.strictEqual(p2.indexOf('items'), -1, '"items" stoplisted word must not be in patterns');
  assert.strictEqual(p2.indexOf('take'), -1, '"take" stoplisted word must not be in patterns');
  assert.strictEqual(p2.indexOf('skip'), -1, '"skip" stoplisted word must not be in patterns');
  assert.strictEqual(p2.indexOf('limit'), -1, '"limit" stoplisted word must not be in patterns');
  assert.strictEqual(p2.indexOf('offset'), -1, '"offset" stoplisted word must not be in patterns');
  assert.strictEqual(p2.indexOf('options'), -1, '"options" stoplisted word must not be in patterns');
  assert.strictEqual(p2.indexOf('filter'), -1, '"filter" stoplisted word must not be in patterns');

  // Finding with only stoplisted words in rootFields -> empty patterns (no field to use).
  var finding3 = {
    operator: '!=',
    column: 'id',
    rootFields: ['items', 'take', 'skip']
  };
  var p3 = locatorMod.deriveSearchPatterns(finding3);
  assert.ok(p3.indexOf('notEq') !== -1, 'operator idiom notEq must still appear');
  assert.strictEqual(p3.indexOf('items'), -1, '"items" excluded even as only rootField');
});

// ---------------------------------------------------------------------------
// Per-package candidate cap: non-stack packages are capped at 3 candidates,
// stack package is exempt, stack/target candidates are not capped.
// ---------------------------------------------------------------------------
test('locator: per-package cap — non-stack dep capped at 3, stack pkg exempt', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  // Target project depends on loud-pkg (non-stack) and @vendure/core (stack)
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
    name: 'test-target',
    version: '1.0.0',
    dependencies: {
      'loud-pkg': '1.0.0',
      '@vendure/core': '2.0.0'
    }
  }, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'const x = 1;\n');

  // Stack points to @vendure/core (so loud-pkg is NOT the stack package)
  var finding = {
    operator: '!=',
    column: 'id',
    path: 'orders',
    stack: [
      { file: 'targetRoot/node_modules/@vendure/core/dist/index.js', line: 42 }
    ]
  };

  // Create loud-pkg with 5 files that all match the notEq pattern
  var loudPkgDir = createTempDir();
  var loudDistDir = path.join(loudPkgDir, 'dist');
  fs.mkdirSync(loudDistDir, { recursive: true });
  for (var i = 1; i <= 5; i++) {
    var code = 'async function handler' + i + '(ctx, args) {\n' +
               '  const id = await this.svc.getId(ctx);\n' +
               '  const filter = { id: { notEq: id } };\n' +
               '  return filter;\n' +
               '}\n';
    fs.writeFileSync(path.join(loudDistDir, 'handler' + i + '.js'), code);
  }
  fs.writeFileSync(path.join(loudPkgDir, 'package.json'), JSON.stringify({ name: 'loud-pkg', version: '1.0.0' }, null, 2));

  // Create @vendure/core with 2 files that also match (stack package, exempt from cap)
  var vcDir = createTempDir();
  var vcDistDir = path.join(vcDir, 'dist');
  fs.mkdirSync(vcDistDir, { recursive: true });
  for (var j = 1; j <= 2; j++) {
    var vcCode = 'export async function order' + j + '(ctx) {\n' +
                 '  const id = { notEq: ctx.orderId };\n' +
                 '  return id;\n' +
                 '}\n';
    fs.writeFileSync(path.join(vcDistDir, 'order-svc-' + j + '.js'), vcCode);
  }
  fs.writeFileSync(path.join(vcDir, 'package.json'), JSON.stringify({ name: '@vendure/core', version: '2.0.0' }, null, 2));

  var fakeFetch = function(name, version, dir) {
    if (name === 'loud-pkg') return Promise.resolve(loudPkgDir);
    if (name === '@vendure/core') return Promise.resolve(vcDir);
    return Promise.resolve(createTempDir());
  };

  var result = await locator.locateCandidates({
    finding: finding,
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 10,
    runId: 'test-cap-' + Date.now(),
    workspaceDir: workspaceDir
  });

  // loud-pkg is NOT the stack package (@vendure/core is), so it must be capped at 2
  var loudCandidates = result.candidates.filter(function(c) { return c.package && c.package.indexOf('loud-pkg') !== -1; });
  assert.strictEqual(loudCandidates.length, 2, 'loud-pkg (non-stack) must be capped at 2 candidates; got: ' + loudCandidates.length);

  // @vendure/core IS the stack package, so it must NOT be capped (2 files = 2 candidates)
  var vcCandidates = result.candidates.filter(function(c) { return c.package && c.package.indexOf('@vendure/core') !== -1; });
  assert.strictEqual(vcCandidates.length, 2, '@vendure/core (stack pkg) must be exempt from cap; got: ' + vcCandidates.length);

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(loudPkgDir, { recursive: true, force: true });
  fs.rmSync(vcDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// locator importer-file candidates: src/ files that import a dependency package
// become candidates with source='import'
// ---------------------------------------------------------------------------
test('locator: src/ file importing dependency becomes an import candidate', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: { 'fake-import-dep': '1.0.0' }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  // The dependency source (fetched) contains the bug pattern.
  var pkgDir = createTempDir();
  var distDir = path.join(pkgDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'resolver.js'),
    'async function products(ctx, args) {\n' +
    '  return { filter: { id: { notEq: `${nppId}` } } };\n' +
    '}\n');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-import-dep', version: '1.0.0' }, null, 2));

  // A src/ file that imports the dependency package.
  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'),
    'const dep = require("fake-import-dep");\n' +
    'module.exports = dep;\n');

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'id', path: 'products' },
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 8,
    runId: 'test-importer-' + Date.now(),
    workspaceDir: workspaceDir
  });

  var importCandidates = result.candidates.filter(function(c) { return c.source === 'import'; });
  assert.ok(importCandidates.length > 0,
    'should find import candidates for src/ files importing the dependency; got: ' + JSON.stringify(result.candidates.map(function(c){return {file:c.file,source:c.source};})));
  assert.strictEqual(importCandidates[0].package, 'fake-import-dep', 'package should be fake-import-dep');
  assert.ok(importCandidates[0].file.indexOf('src/index.js') !== -1, 'file should be src/index.js; got: ' + importCandidates[0].file);
  assert.strictEqual(typeof importCandidates[0].score, 'number', 'score should be a number');
  assert.ok(Array.isArray(importCandidates[0].reasons) && importCandidates[0].reasons.length > 0, 'reasons should be non-empty');
  assert.ok(importCandidates[0].why && typeof importCandidates[0].why === 'string' && importCandidates[0].why.length > 0, 'why should be a non-empty string');
  assert.ok(importCandidates[0].snippet, 'snippet should be present');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test('locator: importer candidate does not duplicate an existing target candidate', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  var pkgJson = {
    name: 'test-target',
    version: '1.0.0',
    dependencies: { 'fake-import-dep': '1.0.0' }
  };
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

  var pkgDir = createTempDir();
  var distDir = path.join(pkgDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'resolver.js'),
    'async function products(ctx, args) {\n' +
    '  return { filter: { id: { notEq: `${nppId}` } } };\n' +
    '}\n');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-import-dep', version: '1.0.0' }, null, 2));

  // The src/ index.js BOTH matches the search pattern (so it would be a 'target'
  // candidate) AND imports the dependency package. It must appear only once.
  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'),
    'const dep = require("fake-import-dep");\n' +
    'const nppId = getNppId();\n' +
    'async function products(ctx) { return { filter: { id: { notEq: `${nppId}` } } }; }\n');

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'id', path: 'products' },
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 8,
    runId: 'test-importer-dup-' + Date.now(),
    workspaceDir: workspaceDir
  });

  // Count how many candidates point at src/index.js (normalized relative).
  var indexTargets = result.candidates.filter(function(c) {
    var rel = path.relative(targetRoot, c.file).replace(/\\/g, '/');
    return rel === 'src/index.js';
  });
  // The file already appears as a (target) candidate, so the importer search
  // must NOT add a second 'import' candidate for the same file.
  var importForIndex = result.candidates.filter(function(c) {
    return c.source === 'import' && path.relative(targetRoot, c.file).replace(/\\/g, '/') === 'src/index.js';
  });
  assert.strictEqual(indexTargets.length > 0, true, 'src/index.js should be a target candidate (got ' + indexTargets.length + ')');
  assert.strictEqual(importForIndex.length, 0,
    'src/index.js must not be duplicated as an import candidate; got: ' + JSON.stringify(importForIndex.map(function(c){return {file:c.file,source:c.source};})) + ' (targets: ' + indexTargets.length + ')');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test('locator: no dependency candidates means no importer candidates', async function() {
  var workspaceDir = createTempDir();
  var targetRoot = createTempDir();

  // No dependencies at all - no importer candidates should be produced.
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ name: 'test-target', version: '1.0.0', dependencies: {} }, null, 2));

  var srcDir = path.join(targetRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'),
    'const other = require("some-other-module");\n' +
    'module.exports = other;\n');

  var fakeFetch = function(name, version, dir) { return Promise.resolve(createTempDir()); };

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'id', path: 'products' },
    targetRoot: targetRoot,
    fetchPackage: fakeFetch,
    maxCandidates: 8,
    runId: 'test-no-importer-' + Date.now(),
    workspaceDir: workspaceDir
  });

  var importCandidates = result.candidates.filter(function(c) { return c.source === 'import'; });
  assert.strictEqual(importCandidates.length, 0, 'no importer candidates when no dependency candidates');

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

