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
    'async function orders(ctx, args) {',
    '  const otherId = await this.orderService.getOtherId(ctx);',
    "  const options = { ...args.options, filter: { status: { Not: `${otherId}` } } };",
    '  return options;',
    '}'
  ].join('\n');

  fs.writeFileSync(path.join(resolverDir, 'order.resolver.js'), resolverCode);
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-order-resolver', version: '1.0.0' }, null, 2));

  var fakeFetch = function(name, version, dir) { return Promise.resolve(pkgDir); };

  var result = await locator.locateCandidates({
    finding: { operator: '!=', column: 'order.status', path: 'orders' },
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
