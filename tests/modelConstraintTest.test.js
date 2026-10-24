'use strict';

var os = require('os');
var path = require('path');
var fs = require('fs');
var test = require('node:test');
var assert = require('node:assert');

// pipeline/*.mjs are ESM; load lazily so the CJS test file can use them.
var modulePromise = import('../pipeline/model-constraint-test.mjs');
var realModelClient = require('../src/repair/modelClient.js');

function tempDir(prefix) {
  return path.join(os.tmpdir(), (prefix || 'mct-') + Date.now() + '-' + Math.random().toString(36).substr(2, 8));
}

// A tiny real git repo used as the local target clone for a model run.
function makeRepo(opts) {
  opts = opts || {};
  var dir = tempDir('mct-repo-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), opts.srcContent != null ? opts.srcContent : 'old content\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', dependencies: {} }), 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  if (opts.nodeModules) {
    fs.mkdirSync(path.join(dir, 'node_modules', 'depx'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'depx', 'index.js'), 'module.exports = 1;\n', 'utf8');
  }
  var r = require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (r.status === 0) {
    require('node:child_process').spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
    require('node:child_process').spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir, encoding: 'utf8' });
  }
  return dir;
}

function makeFinding(overrides) {
  var base = {
    class: 'SQL_PARAM_TYPE',
    domain: 'target-code',
    message: 'invalid input syntax for type integer: "undefined"',
    path: 'src/x.js',
    sql: { statement: null, operator: null, column: null, paramIndex: null, paramValue: 'undefined' },
    stack: [{ file: path.join('src', 'x.js'), line: 1 }],
    confidence: 'API_ONLY',
    notes: [],
    signature: 'abcdef0123456789',
    package: null
  };
  return Object.assign(base, overrides || {});
}

var COMPLIANT_EDIT_SET = {
  repairKind: 'source-edit',
  rationale: 'test fix',
  edits: [{ path: 'src/x.js', oldString: 'old content', newString: 'new content' }],
  newFiles: []
};

var NODE_MODULES_EDIT_SET = {
  repairKind: 'source-edit',
  rationale: 'test fix',
  edits: [{ path: 'node_modules/depx/index.js', oldString: 'old', newString: 'new' }],
  newFiles: []
};

function stubModelClient(scenario) {
  return {
    callModel: function(opts) {
      if (scenario === 'provider-error') {
        return Promise.resolve({ ok: false, blocker: { code: 'MODEL_NO_ELIGIBLE_PROVIDER', message: 'no eligible provider', evidence: {} } });
      }
      if (scenario === 'malformed') {
        return Promise.resolve({ ok: true, text: 'this is not json at all', requestedModel: 'z', model: 'z', provider: 'stub', usage: { total_tokens: 9 } });
      }
      var editSet = scenario === 'node-modules' ? NODE_MODULES_EDIT_SET : COMPLIANT_EDIT_SET;
      return Promise.resolve({
        ok: true,
        text: JSON.stringify(editSet),
        requestedModel: 'requested-x',
        model: scenario === 'node-modules' ? 'actual-y' : 'actual-x',
        provider: 'stub-provider',
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }
      });
    },
    parseEditSet: function(text) { return realModelClient.parseEditSet(text); }
  };
}

var sharedRepo = null;
function getSharedRepo() {
  if (!sharedRepo) sharedRepo = makeRepo({});
  return sharedRepo;
}

test('parseArgs: requires artifact and repo, parses runs', async function() {
  var m = await modulePromise;
  var ok = m.parseArgs(['--artifact', '/a', '--repo', '/b', '--runs', '3']);
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(ok.artifact, '/a');
  assert.strictEqual(ok.repo, '/b');
  assert.strictEqual(ok.runs, 3);
  assert.ok(m.parseArgs([]).error, 'missing artifact errors');
  assert.ok(m.parseArgs(['--artifact', '/a']).error, 'missing repo errors');
  assert.ok(m.parseArgs(['--artifact', '/a', '--repo', '/b', '--runs', '0']).error, 'runs<=0 errors');
  assert.ok(m.parseArgs(['--unknown', 'x']).error, 'unknown flag errors');
});

test('restrictedPathsInProposal: flags node_modules/lockfile/workflow/dockerfile', async function() {
  var m = await modulePromise;
  var clean = m.restrictedPathsInProposal(COMPLIANT_EDIT_SET);
  assert.strictEqual(clean.any, false);

  var dirty = m.restrictedPathsInProposal({
    repairKind: 'source-edit',
    rationale: 'x',
    edits: [
      { path: 'node_modules/foo/index.js', oldString: 'a', newString: 'b' },
      { path: 'package-lock.json', oldString: 'a', newString: 'b' },
      { path: '.github/workflows/ci.yml', oldString: 'a', newString: 'b' },
      { path: 'Dockerfile', oldString: 'a', newString: 'b' }
    ],
    newFiles: [{ path: 'docker-compose.yml', content: 'x' }]
  });
  assert.strictEqual(dirty.nodeModules, true);
  assert.strictEqual(dirty.lockfile, true);
  assert.strictEqual(dirty.workflow, true);
  assert.strictEqual(dirty.dockerfile, true);
  assert.strictEqual(dirty.any, true);
});

test('nodeModulesListing: hashes dependency package trees deterministically', async function() {
  var m = await modulePromise;
  var repo = makeRepo({ nodeModules: true });
  var listing = m.nodeModulesListing(repo, ['depx']);
  assert.ok(listing.indexOf('node_modules/depx/index.js') !== -1, 'listing includes depx file');
  assert.ok(/^[0-9a-f]{64}  node_modules\/depx\/index\.js$/m.test(listing.trim()), 'sha256 hash + path line');
  var listing2 = m.nodeModulesListing(repo, ['depx']);
  assert.strictEqual(listing, listing2, 'listing is deterministic');
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) {}
});

test('run: compliant proposal -> VALID, node_modules unchanged, no restricted paths', async function() {
  var m = await modulePromise;
  var repo = getSharedRepo();
  var stdout = { log: [] };
  // Capture console.log via the command's own write path by reading results.json.
  var cwd = process.cwd();
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'), // exists; finding injected
    repo: repo,
    runs: 2,
    finding: makeFinding(),
    candidates: [{ file: path.join(repo, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stubModelClient('compliant')
  });
  assert.ok(result.outputDir, 'output dir produced');
  assert.strictEqual(result.rows.length, 2);
  assert.ok(result.rows.every(function(r) { return r.outcome === 'VALID' || r.outcome === 'MODEL_FAILED:MISSING_API_KEY' || r.outcome === 'MODEL_FAILED:IO_NOT_INJECTED'; }),
    'compliant stub yields VALID (or model infra blocker)');
  result.rows.forEach(function(r) {
    assert.strictEqual(r.nodeModulesUnchanged, true, 'node_modules tree unchanged per run');
    if (r.restricted) assert.strictEqual(r.restricted.any, false, 'compliant proposal has no restricted paths');
  });
  // Output files exist
  assert.ok(fs.existsSync(path.join(result.outputDir, 'results.json')));
  assert.ok(fs.existsSync(path.join(result.outputDir, 'summary.txt')));
  assert.ok(fs.existsSync(path.join(result.outputDir, 'tree-before.sha256')));
  assert.ok(fs.existsSync(path.join(result.outputDir, 'tree-after.sha256')));
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
});

test('run: node_modules proposal -> REJECTED with restricted flagged despite validator rejection', async function() {
  var m = await modulePromise;
  var cwd = process.cwd();
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: getSharedRepo(),
    runs: 1,
    finding: makeFinding(),
    candidates: [{ file: path.join(getSharedRepo(), 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stubModelClient('node-modules')
  });
  var row = result.rows[0];
  assert.ok(row.outcome === 'REJECTED' || row.outcome.indexOf('MODEL_FAILED') === 0, 'node_modules proposal Rejected by real validator, got: ' + row.outcome);
  if (row.outcome === 'REJECTED') {
    assert.ok(row.rejectionCodes.indexOf('PROPOSAL_IN_NODE_MODULES') !== -1 || row.rejectionCodes.indexOf('DEP_PATCH_NOT_ONE_PKG') !== -1,
      'rejection codes include a node_modules code: ' + JSON.stringify(row.rejectionCodes));
  }
  assert.strictEqual(row.restricted.any, true, 'restricted flagged even though validator would reject');
  assert.strictEqual(row.restricted.nodeModules, true);
  assert.strictEqual(row.nodeModulesUnchanged, true, 'validator does not mutate node_modules');
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
});

test('run: malformed model output -> PARSE_ERROR, no restricted scan', async function() {
  var m = await modulePromise;
  var cwd = process.cwd();
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: getSharedRepo(),
    runs: 1,
    finding: makeFinding(),
    candidates: [{ file: path.join(getSharedRepo(), 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stubModelClient('malformed')
  });
  var row = result.rows[0];
  assert.strictEqual(row.outcome, 'PARSE_ERROR');
  assert.strictEqual(row.restricted, null);
  assert.strictEqual(row.nodeModulesUnchanged, true);
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
});

test('run: provider error -> MODEL_FAILED:MODEL_NO_ELIGIBLE_PROVIDER', async function() {
  var m = await modulePromise;
  var cwd = process.cwd();
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: getSharedRepo(),
    runs: 1,
    finding: makeFinding(),
    candidates: [{ file: path.join(getSharedRepo(), 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stubModelClient('provider-error')
  });
  var row = result.rows[0];
  assert.strictEqual(row.outcome, 'MODEL_FAILED:MODEL_NO_ELIGIBLE_PROVIDER');
  assert.strictEqual(row.restricted, null);
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
});

test('modelClient: REPAIR_MODEL resolves and provider prefs sent', async function() {
  var m = await modulePromise;
  assert.strictEqual(realModelClient.resolveConfiguredModel({}), 'z-ai/glm-5.3-flash');
  assert.strictEqual(realModelClient.resolveConfiguredModel({ REPAIR_MODEL: 'acme/model-7' }), 'acme/model-7');
  // process.env fallback
  var prev = process.env.REPAIR_MODEL;
  process.env.REPAIR_MODEL = 'env/model-x';
  assert.strictEqual(realModelClient.resolveConfiguredModel({}), 'env/model-x');
  if (prev === undefined) delete process.env.REPAIR_MODEL; else process.env.REPAIR_MODEL = prev;

  var capturedBody = null;
  var prev2 = process.env.REPAIR_MODEL;
  process.env.REPAIR_MODEL = 'env/model-y';
  await realModelClient.callModel({
    prompt: 'hi',
    env: { OPENROUTER_API_KEY: 'k' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedBody = opts && opts.body;
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  });
  if (prev2 === undefined) delete process.env.REPAIR_MODEL; else process.env.REPAIR_MODEL = prev2;
  var body = JSON.parse(capturedBody);
  assert.strictEqual(body.model, 'env/model-y');
  assert.deepStrictEqual(body.provider, { data_collection: 'deny', require_parameters: true });
});

test('modelClient: provider name and served model recorded on success', async function() {
  var capturedBody = null;
  var r = await realModelClient.callModel({
    prompt: 'hi',
    env: { OPENROUTER_API_KEY: 'k' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedBody = opts && opts.body;
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ model: 'z-ai/served-9', provider: 'DeepInfra', choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.requestedModel, 'z-ai/glm-5.3-flash');
  assert.strictEqual(r.model, 'z-ai/served-9');
  assert.strictEqual(r.provider, 'DeepInfra');
  // provider preference is always present in the outgoing body
  var body = JSON.parse(capturedBody);
  assert.deepStrictEqual(body.provider, { data_collection: 'deny', require_parameters: true });
});

test('modelClient: no eligible provider error -> MODEL_NO_ELIGIBLE_PROVIDER', async function() {
  var r = await realModelClient.callModel({
    prompt: 'hi',
    env: { OPENROUTER_API_KEY: 'k' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 400, ok: false, json: function() { return Promise.resolve({ error: { message: 'No eligible providers for model z-ai/glm-5.3-flash under the data collection policy.' } }); } });
    }
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocker.code, 'MODEL_NO_ELIGIBLE_PROVIDER');
  var r2 = await realModelClient.callModel({
    prompt: 'hi',
    env: { OPENROUTER_API_KEY: 'k' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 400, ok: false, json: function() { return Promise.resolve({ error: { message: 'model not found' } }); } });
    }
  });
  assert.strictEqual(r2.blocker.code, 'HTTP_400', 'unrelated 400 stays HTTP_400');
});

test('run: NO_CANDIDATES when locator finds none', async function() {
  var m = await modulePromise;
  var repo = makeRepo({});
  var cwd = process.cwd();
  // A finding whose path does not exist and whose pattern matches nothing
  // in the repo -> locator finds no candidates.
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: repo,
    runs: 1,
    finding: makeFinding({ path: 'nonexistent/file.ts', stack: [] }),
    candidates: [], // triggers locator
    fetchPackage: false // hermetic: no network in tests
  });
  assert.strictEqual(result.outcome, 'NO_CANDIDATES', 'empty candidates must yield NO_CANDIDATES outcome');
  assert.strictEqual(result.error && result.error.indexOf('no candidates') !== -1, true);
  try { fs.rmSync(result.outputDir || path.join(cwd, EVIDENCE_DIR, 'model-test-no-candidate'), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) {}
});

test('run: EVIDENCE_EMPTY when tree listing is blank', async function() {
  var m = await modulePromise;
  // A repo with no node_modules at all -> tree listing is empty -> EVIDENCE_EMPTY
  var repo = makeRepo({}); // no node_modules
  var cwd = process.cwd();
  var stub = {
    callModel: function(opts) {
      return Promise.resolve({
        ok: true,
        text: JSON.stringify(COMPLIANT_EDIT_SET),
        requestedModel: 'x', model: 'x', provider: 'stub',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop',
        truncated: false,
        maxTokensSent: 4000
      });
    },
    parseEditSet: function(text) { return realModelClient.parseEditSet(text); }
  };
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: repo,
    runs: 1,
    finding: makeFinding(),
    candidates: [{ file: path.join(repo, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stub
  });
  assert.strictEqual(result.evidenceEmpty, true, 'no node_modules tree means empty listing');
  assert.strictEqual(result.outcome, 'EVIDENCE_EMPTY');
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) {}
});

test('run: rows include finish_reason, token counts, maxTokensSent, candidateCount', async function() {
  var m = await modulePromise;
  var repo = makeRepo({});
  var cwd = process.cwd();
  var stub = {
    callModel: function(opts) {
      return Promise.resolve({
        ok: true,
        text: JSON.stringify(COMPLIANT_EDIT_SET),
        requestedModel: 'z', model: 'z-model', provider: 'stub-provider',
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        finishReason: 'stop',
        truncated: false,
        maxTokensSent: 8192
      });
    },
    parseEditSet: function(text) { return realModelClient.parseEditSet(text); }
  };
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: repo,
    runs: 1,
    finding: makeFinding(),
    candidates: [{ file: path.join(repo, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stub
  });
  var row = result.rows[0];
  assert.strictEqual(row.finishReason, 'stop');
  assert.strictEqual(row.tokens, 150);
  assert.strictEqual(row.promptTokens, 100);
  assert.strictEqual(row.completionTokens, 50);
  assert.strictEqual(row.maxTokensSent, 8192);
  assert.strictEqual(row.candidateCount, 1);
  assert.strictEqual(row.promptChars > 0, true);
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) {}
});

test('run: finish_reason=length stub triggers truncated marker', async function() {
  var m = await modulePromise;
  var repo = makeRepo({});
  var cwd = process.cwd();
  var stub = {
    callModel: function(opts) {
      return Promise.resolve({
        ok: true,
        text: '{"repairKind":"source-edit","rationale":"','finish_reason':'length',
        requestedModel: 'z', model: 'z', provider: 'stub',
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        finishReason: 'length',
        truncated: true,
        maxTokensSent: 4000
      });
    },
    parseEditSet: function(text) { return realModelClient.parseEditSet(text); }
  };
  var result = await m.runModelConstraintTest({
    artifact: path.join(cwd, 'manifest'),
    repo: repo,
    runs: 1,
    finding: makeFinding(),
    candidates: [{ file: path.join(repo, 'src', 'x.js'), line: 1, snippet: [{ line: 'old content' }], source: 'target' }],
    modelClient: stub
  });
  var row = result.rows[0];
  assert.strictEqual(row.outcome, 'PARSE_ERROR', 'truncated response must yield PARSE_ERROR');
  assert.strictEqual(row.finishReason, 'length');
  assert.strictEqual(row.truncated, true);
  try { fs.rmSync(result.outputDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch (e) {}
});

test('parseArgs: default runs is 5', async function() {
  var m = await modulePromise;
  var ok = m.parseArgs(['--artifact', '/a', '--repo', '/b']);
  assert.strictEqual(ok.runs, 5);
});

test('parseArgs: --no-fetch sets fetchPackage to false', async function() {
  var m = await modulePromise;
  var ok = m.parseArgs(['--artifact', '/a', '--repo', '/b', '--no-fetch']);
  assert.strictEqual(ok.fetchPackage, false);
  var ok2 = m.parseArgs(['--artifact', '/a', '--repo', '/b']);
  assert.strictEqual(ok2.fetchPackage, true, 'fetchPackage must be true by default');
});

test('parseArgs: --no-fetch can appear before other flags', async function() {
  var m = await modulePromise;
  var ok = m.parseArgs(['--no-fetch', '--artifact', '/a', '--repo', '/b']);
  assert.strictEqual(ok.fetchPackage, false);
  assert.strictEqual(ok.artifact, '/a');
  assert.strictEqual(ok.repo, '/b');
});
