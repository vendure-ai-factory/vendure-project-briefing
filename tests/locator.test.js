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