'use strict';

var manifestModule = require('../src/manifest');
var plannerModule = require('../src/planner');
var taskCardModule = require('../src/taskCard');
var path = require('path');

var test = require('node:test');
var assert = require('node:assert');

var MANIFEST_PATH = path.join(__dirname, '..', 'manifest', 'acceptance-manifest.v0.4.json');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeGoodTask(overrides) {
  return Object.assign({
    canonicalId: 'CAN-TST-01',
    batch: 'BATCH-1',
    title: 'Test task',
    summaryIds: ['TST-01'],
    specIds: ['TST-01'],
    mappingType: 'direct',
    expectedResult: 'Something observable and measurable.',
    negativeChecks: [],
    chains: [],
    countryMatrix: [],
    requiredInputs: [],
    evidenceRequired: ['browser', 'api'],
    status: 'READY',
    origin: 'client-batch',
    mandatoryAssertions: [
      {
        id: 'CAN-TST-01-A01',
        text: 'Something observable and measurable.',
        sourceRef: { doc: 'test', section: 'test' },
        evidenceKinds: ['browser', 'api']
      }
    ]
  }, overrides || {});
}

function makeGoodManifest(overrides) {
  var tasks = [];
  for (var i = 0; i < 24; i++) {
    tasks.push(makeGoodTask({
      canonicalId: 'CAN-TST-' + String(i + 1).padStart(2, '0'),
      summaryIds: ['TST-' + String(i + 1).padStart(2, '0')],
      specIds: ['TST-' + String(i + 1).padStart(2, '0')]
    }));
  }
  return Object.assign({
    schemaVersion: '1.0',
    manifestVersion: '0.4',
    tasks: tasks,
    chains: [
      { chainId: 'A', name: 'Test chain A', summaryChains: [1], canonicalIds: ['CAN-TST-01'] },
      { chainId: 'B', name: 'Test chain B', summaryChains: [2], canonicalIds: ['CAN-TST-02', 'CAN-TST-03'] }
    ],
    scripts: []
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

test('manifest: loadManifest loads valid JSON', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  assert.strictEqual(result.valid, true, 'Should load without error');
  assert.ok(result.manifest, 'Should return manifest object');
  assert.ok(Array.isArray(result.manifest.tasks), 'Tasks should be an array');
  done();
});

test('manifest: loadManifest fails on missing file', function(t, done) {
  var result = manifestModule.loadManifest(path.join(__dirname, '..', 'manifest', 'DOES_NOT_EXIST.json'));
  assert.strictEqual(result.valid, false, 'Should return invalid');
  assert.ok(result.errors.length > 0, 'Should have errors');
  assert.strictEqual(result.manifest, null, 'Manifest should be null');
  done();
});

test('manifest: loadManifest fails on invalid JSON', function(t, done) {
  var tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifest-test-'));
  var badPath = require('path').join(tmp, 'bad.json');
  require('fs').writeFileSync(badPath, '{ not valid json }');
  var result = manifestModule.loadManifest(badPath);
  assert.strictEqual(result.valid, false, 'Should return invalid');
  assert.ok(result.errors[0].indexOf('Invalid JSON') !== -1, 'Error should mention JSON');
  require('fs').rmSync(tmp, { recursive: true });
  done();
});

// ---------------------------------------------------------------------------
// loadRegistry
// ---------------------------------------------------------------------------

test('manifest: loadRegistry loads successfully', function(t, done) {
  var result = manifestModule.loadRegistry();
  assert.strictEqual(result.valid, true, 'Registry should load');
  assert.ok(Array.isArray(result.registry.inputs), 'Should have inputs array');
  done();
});

test('manifest: loadRegistry fails on missing file', function(t, done) {
  var result = manifestModule.loadRegistry(path.join(__dirname, '..', 'manifest', 'DOES_NOT_EXIST.json'));
  assert.strictEqual(result.valid, false, 'Should fail');
  assert.ok(result.errors.length > 0, 'Should have errors');
  done();
});

test('manifest [1d]: non-MISSING/PENDING_CLIENT entries have null secretRef and no key-like values', function(t, done) {
  var result = manifestModule.loadRegistry();
  assert.strictEqual(result.valid, true, 'Registry should load');
  var inputs = result.registry.inputs;
  var nonSecretEntries = inputs.filter(function(entry) {
    return entry.status !== 'PENDING_CLIENT' && entry.status !== 'MISSING';
  });
  nonSecretEntries.forEach(function(entry) {
    assert.strictEqual(entry.secretRef, null, 'Entry "' + entry.id + '" (status=' + entry.status + ') must have secretRef null');
  });
  var keyPattern = /sk-or-v1-[a-zA-Z0-9_-]{20,}/;
  var keyValuePattern = /OPENROUTER_API_KEY=(?!your_|sk-test-|test|_|placeholder|empty)[^\s&]{8,}/;
  inputs.forEach(function(entry) {
    var serialized = JSON.stringify(entry);
    assert.strictEqual(keyPattern.test(serialized), false, 'Entry "' + entry.id + '" must not contain sk-or-v1 key pattern');
    assert.strictEqual(keyValuePattern.test(serialized), false, 'Entry "' + entry.id + '" must not contain OPENROUTER_API_KEY with real value');
  });
  done();
});

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

test('manifest: valid manifest passes validation', function(t, done) {
  var m = makeGoodManifest();
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'Good manifest should be valid');
  assert.strictEqual(result.errors.length, 0, 'No errors');
  done();
});

test('manifest: missing schemaVersion fails', function(t, done) {
  var m = makeGoodManifest({ schemaVersion: undefined });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('schemaVersion') !== -1; }), 'Should mention schemaVersion');
  done();
});

test('manifest: missing manifestVersion fails', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: undefined });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('manifestVersion') !== -1; }), 'Should mention manifestVersion');
  done();
});

test('manifest: non-array tasks fails', function(t, done) {
  var m = makeGoodManifest({ tasks: 'not an array' });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('tasks') !== -1; }), 'Should mention tasks');
  done();
});

test('manifest: not exactly 24 client-batch tasks fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks.push(makeGoodTask({ canonicalId: 'CAN-EXTRA-01', origin: 'client-batch' }));
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('24') !== -1; }), 'Should mention 24');
  done();
});

test('manifest: duplicate canonicalId fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[5].canonicalId = m.tasks[0].canonicalId; // duplicate
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('Duplicate') !== -1; }), 'Should mention duplicate');
  done();
});

test('manifest: invalid mappingType fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mappingType = 'NOT_A_TYPE';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('mappingType') !== -1; }), 'Should mention mappingType');
  done();
});

test('manifest: gap task without gapNotes fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mappingType = 'gap';
  m.tasks[0].gapNotes = undefined; // explicitly remove gapNotes
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('gap') !== -1; }), 'Should mention gap');
  done();
});

test('manifest: gap task with gapNotes passes', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mappingType = 'gap';
  m.tasks[0].gapNotes = 'No spec ID assigned in canonical map.';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'Should be valid');
  done();
});

test('manifest: task with invalid evidenceRequired item fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].evidenceRequired = ['browser', 'not_a_type'];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('evidenceRequired') !== -1; }), 'Should mention evidenceRequired');
  done();
});

test('manifest: task missing required fields fails', function(t, done) {
  var m = makeGoodManifest({ tasks: [makeGoodTask({ canonicalId: undefined })] });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('canonicalId') !== -1; }), 'Should mention canonicalId');
  done();
});

test('manifest: invalid origin fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].origin = 'NOT_VALID';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('origin') !== -1; }), 'Should mention origin');
  done();
});

test('manifest: invalid status fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].status = 'INVALID';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('status') !== -1; }), 'Should mention status');
  done();
});

test('manifest: non-array chains fails', function(t, done) {
  var m = makeGoodManifest({ chains: 'not array' });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('chains') !== -1; }), 'Should mention chains');
  done();
});

test('manifest: non-array summaryIds fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].summaryIds = 'not array';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('summaryIds') !== -1; }), 'Should mention summaryIds');
  done();
});

test('manifest: non-array specIds fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].specIds = 42;
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('specIds') !== -1; }), 'Should mention specIds');
  done();
});

test('manifest: non-array requiredInputs fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].requiredInputs = 'not array';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('requiredInputs') !== -1; }), 'Should mention requiredInputs');
  done();
});

test('manifest: missing expectedResult fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].expectedResult = undefined;
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('expectedResult') !== -1; }), 'Should mention expectedResult');
  done();
});

test('manifest: non-string expectedResult fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].expectedResult = 123;
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('expectedResult') !== -1; }), 'Should mention expectedResult');
  done();
});

// ---------------------------------------------------------------------------
// TEST A: Unknown required input fails validation
// ---------------------------------------------------------------------------

test('manifest [A]: unknown required input fails manifest validation', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].requiredInputs = ['DOES_NOT_EXIST'];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) {
    return e.indexOf('DOES_NOT_EXIST') !== -1 && e.indexOf('unknown') !== -1;
  }), 'Error should mention unknown input id: ' + result.errors.join('; '));
  done();
});

// ---------------------------------------------------------------------------
// TEST B: Real manifest + real registry consistency (shipping mismatch already fixed)
// ---------------------------------------------------------------------------

test('manifest [B]: real manifest has no unknown requiredInputs in registry', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  assert.strictEqual(result.valid, true, 'Real manifest should load');
  var validation = manifestModule.validateManifest(result.manifest);
  assert.strictEqual(validation.valid, true, 'Real manifest should validate against real registry: ' + validation.errors.join('; '));
  done();
});

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

test('manifest: getTask returns task by canonicalId', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B1-01');
  assert.ok(task, 'Should find CAN-B1-01');
  assert.strictEqual(task.title, 'Country terminology and cross-country browsing');
  done();
});

test('manifest: getTask returns null for unknown id', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-DOES-NOT-EXIST');
  assert.strictEqual(task, null, 'Should return null');
  done();
});

test('manifest: getTask returns null for null manifest', function(t, done) {
  var task = manifestModule.getTask(null, 'CAN-B1-01');
  assert.strictEqual(task, null, 'Should return null');
  done();
});

// ---------------------------------------------------------------------------
// toTaskCard
// ---------------------------------------------------------------------------

test('manifest: toTaskCard produces valid taskCard for CAN-B1-01', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B1-01');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.strictEqual(card.taskId, 'CAN-B1-01');
  assert.strictEqual(card.batchId, 'BATCH-1');
  assert.strictEqual(card.title, 'Country terminology and cross-country browsing');
  assert.strictEqual(card.goal.substring(0, 20), 'With Customer Countr');
  assert.ok(Array.isArray(card.expectedResults), 'expectedResults should be array');
  assert.ok(Array.isArray(card.acceptanceConditions), 'acceptanceConditions should be array');
  assert.ok(card.environment, 'environment should be object');
  done();
});

test('manifest: toTaskCard for gap task includes gap condition', function(t, done) {
  // CAN-B1-08 is resolved (direct) in v0.4; test with a synthetic gap task
  var gapTask = makeGoodTask({
    canonicalId: 'CAN-GAP-TEST',
    mappingType: 'gap',
    gapNotes: 'No spec ID assigned; contractor to confirm scope.'
  });
  var card = manifestModule.toTaskCard(gapTask);
  var hasGap = card.acceptanceConditions.some(function(c) { return c.indexOf('GAP') !== -1; });
  assert.ok(hasGap, 'Gap condition should be in acceptanceConditions for gap task');
  done();
});

test('manifest: toTaskCard for CAN-DEMO-01 includes negative checks', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-DEMO-01');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.strictEqual(card.taskId, 'CAN-DEMO-01');
  assert.strictEqual(card.status, 'PENDING');
  assert.ok(card.goal.indexOf('verify.sh') !== -1 || card.expectedResults.length > 0, 'Should have goal or results');
  done();
});

test('manifest: toTaskCard output passes planner.createExecutionPlan for all 25 tasks', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  assert.strictEqual(result.valid, true, 'Manifest should load');

  var failures = [];

  for (var i = 0; i < result.manifest.tasks.length; i++) {
    var task = result.manifest.tasks[i];
    var card = manifestModule.toTaskCard(task, result.manifest);
    var planResult = plannerModule.createExecutionPlan(card);

    if (!planResult.valid) {
      failures.push(task.canonicalId + ': ' + planResult.errors.join('; '));
    }
  }

  assert.strictEqual(failures.length, 0, 'All 25 tasks should produce valid execution plans. Failures: ' + failures.join(' | '));
  done();
});

// ---------------------------------------------------------------------------
// TEST G: Task card passes validateTaskCard after toTaskCard conversion
// ---------------------------------------------------------------------------

test('manifest [G]: toTaskCard output passes validateTaskCard for real tasks', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var failures = [];

  // Test a representative sample: first task of each batch, the gap task, and the demo task
  var samples = ['CAN-B1-01', 'CAN-B1-08', 'CAN-B2-01', 'CAN-B2-16', 'CAN-DEMO-01'];

  samples.forEach(function(id) {
    var task = manifestModule.getTask(result.manifest, id);
    if (!task) {
      failures.push('Not found: ' + id);
      return;
    }
    var card = manifestModule.toTaskCard(task, result.manifest);
    var validation = taskCardModule.validateTaskCard(card);
    if (!validation.valid) {
      failures.push(id + ': ' + validation.errors.join('; '));
    }
  });

  assert.strictEqual(failures.length, 0, 'All sampled tasks should produce valid task cards. Failures: ' + failures.join(' | '));
  done();
});

// ---------------------------------------------------------------------------
// TEST E: Chain propagation — CAN-B2-01 retains Chain B membership
// ---------------------------------------------------------------------------

test('manifest [E]: CAN-B2-01 retains Chain B membership after toTaskCard', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-01');
  var card = manifestModule.toTaskCard(task, result.manifest);

  // Chain B contains CAN-B2-01 according to the manifest
  assert.ok(card.environment && card.environment.chains, 'environment.chains should exist');
  assert.ok(card.environment.chains.indexOf('B') !== -1, 'Chain B should be present. Got: ' + JSON.stringify(card.environment.chains));
  done();
});

test('manifest [E]: deriveChainMembership returns correct chains for CAN-B2-01', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var chains = manifestModule.deriveChainMembership(result.manifest, 'CAN-B2-01');
  assert.ok(chains.indexOf('B') !== -1, 'Should include Chain B. Got: ' + JSON.stringify(chains));
  done();
});

test('manifest [E]: deriveChainMembership returns empty for unknown task', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var chains = manifestModule.deriveChainMembership(result.manifest, 'CAN-DOES-NOT-EXIST');
  assert.deepStrictEqual(chains, [], 'Unknown task should return empty chains');
  done();
});

test('manifest [E]: toTaskCard without manifest falls back to task.chains', function(t, done) {
  var card = manifestModule.toTaskCard({
    canonicalId: 'TST-01',
    batch: 'BATCH-1',
    title: 'Test',
    expectedResult: 'Result.',
    mappingType: 'direct',
    status: 'READY',
    origin: 'client-batch',
    chains: ['X', 'Y']
  });
  // When no manifest is passed, task.chains is used
  var hasChain = card.environment && card.environment.chains &&
    card.environment.chains.indexOf('X') !== -1;
  assert.ok(hasChain, 'Should have chains X from task.chains fallback. Got: ' + JSON.stringify(card.environment));
  done();
});

// ---------------------------------------------------------------------------
// TEST F: Manifest status preservation
// ---------------------------------------------------------------------------

test('manifest [F]: NEEDS_CLIENT_INPUT manifest task becomes PENDING with original status in environment', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].status = 'NEEDS_CLIENT_INPUT';
  var card = manifestModule.toTaskCard(m.tasks[0], m);
  assert.strictEqual(card.status, 'PENDING', 'Execution status should be PENDING');
  assert.strictEqual(card.environment && card.environment.manifestStatus, 'NEEDS_CLIENT_INPUT', 'Original manifest status should be preserved');
  done();
});

test('manifest [F]: READY manifest task has PENDING execution status and READY in environment', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].status = 'READY';
  var card = manifestModule.toTaskCard(m.tasks[0], m);
  assert.strictEqual(card.status, 'PENDING', 'Execution status should always be PENDING');
  assert.strictEqual(card.environment && card.environment.manifestStatus, 'READY', 'Original manifest status should be preserved');
  done();
});

// ---------------------------------------------------------------------------
// Canonical traceability preserved in environment
// ---------------------------------------------------------------------------

test('manifest: toTaskCard preserves canonical traceability in environment', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-07');
  var card = manifestModule.toTaskCard(task, result.manifest);

  assert.strictEqual(card.environment.canonicalId, 'CAN-B2-07', 'canonicalId should be in environment');
  assert.strictEqual(card.environment.batch, 'BATCH-2', 'batch should be in environment');
  assert.strictEqual(card.environment.origin, 'client-batch', 'origin should be in environment');
  assert.strictEqual(card.environment.mappingType, 'direct', 'mappingType should be in environment');
  assert.ok(card.environment.specIds, 'specIds should be in environment');
  assert.ok(card.environment.summaryIds, 'summaryIds should be in environment');
  done();
});

// ---------------------------------------------------------------------------
// listBlockedByInputs
// ---------------------------------------------------------------------------

test('manifest: listBlockedByInputs returns empty when no MISSING inputs', function(t, done) {
  var m = makeGoodManifest({
    tasks: [makeGoodTask({ requiredInputs: ['stagingUrl'], status: 'READY' })]
  });
  var result = manifestModule.listBlockedByInputs(m);
  assert.ok(Array.isArray(result.blocked), 'Should return object with blocked array');
  assert.ok(result.registryError === null, 'Should have no registry error');
  assert.strictEqual(result.blocked.length, 0, 'No blocked tasks');
  done();
});

test('manifest: listBlockedByInputs returns empty for null manifest', function(t, done) {
  var result = manifestModule.listBlockedByInputs(null);
  assert.ok(Array.isArray(result.blocked), 'Should return blocked array');
  assert.strictEqual(result.blocked.length, 0, 'Should be empty for null');
  done();
});

test('manifest: listBlockedByInputs returns tasks with MISSING requiredInputs', function(t, done) {
  // stripeTestKeys is MISSING in registry and blocks; stagingAdminCredentials
  // is PENDING_CLIENT (not MISSING) so it does NOT block at manifest level.
  var m = makeGoodManifest();
  m.tasks[0].requiredInputs = ['stripeTestKeys'];

  var result = manifestModule.listBlockedByInputs(m);

  var stripeBlocked = result.blocked.some(function(b) {
    return b.canonicalId === m.tasks[0].canonicalId &&
           b.missingInputs.indexOf('stripeTestKeys') !== -1;
  });
  assert.ok(stripeBlocked, 'Task with MISSING input stripeTestKeys should be blocked. Got: ' + JSON.stringify(result.blocked));

  m.tasks[0].requiredInputs = ['stagingAdminCredentials'];
  var result2 = manifestModule.listBlockedByInputs(m);
  var adminBlocked = result2.blocked.some(function(b) {
    return b.canonicalId === m.tasks[0].canonicalId &&
           b.missingInputs.indexOf('stagingAdminCredentials') !== -1;
  });
  assert.ok(!adminBlocked, 'PENDING_CLIENT stagingAdminCredentials should not appear as MISSING. Got: ' + JSON.stringify(result2.blocked));
  done();
});

// ---------------------------------------------------------------------------
// TEST C: MISSING input blocks task
// ---------------------------------------------------------------------------

test('manifest [C]: known MISSING input blocks the task', function(t, done) {
  // CAN-B1-06 requires stripeTestKeys which is still MISSING (client-owned secret)
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B1-06');
  assert.ok(task, 'CAN-B1-06 should exist');

  var blockResult = manifestModule.listBlockedByInputs(result.manifest);
  assert.ok(blockResult.registryError === null, 'Registry should load');

  // stripeTestKeys is MISSING, so its dependent task blocks
  var b2Blocked = blockResult.blocked.some(function(b) {
    return b.canonicalId === 'CAN-B1-06' &&
           b.missingInputs.indexOf('stripeTestKeys') !== -1;
  });
  assert.ok(b2Blocked, 'CAN-B1-06 should be blocked by MISSING stripeTestKeys. Got: ' + JSON.stringify(blockResult.blocked));

  // stagingAdminCredentials is PENDING_CLIENT, not MISSING, so nothing may report it as missing
  var noAdminMissing = blockResult.blocked.every(function(b) {
    return b.missingInputs.indexOf('stagingAdminCredentials') === -1;
  });
  assert.ok(noAdminMissing, 'stagingAdminCredentials (PENDING_CLIENT) must not be reported as MISSING. Got: ' + JSON.stringify(blockResult.blocked));
  done();
});

// ---------------------------------------------------------------------------
// TEST D: Frozen input does not block task
// ---------------------------------------------------------------------------

test('manifest [D]: stagingUrl is FROZEN and does not block tasks', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  // CAN-B2-04 requires productsImagesArchiveRoot (now CONTRACTOR_FREEZE), so skip
  // Find a task that requires only FROZEN inputs
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-04');
  var blockResult = manifestModule.listBlockedByInputs(result.manifest);

  // CAN-B2-04 requires productsImagesArchiveRoot which is CONTRACTOR_FREEZE, so it is not blocked by that input.
  // Use the listBlockedByInputs result to verify stagingUrl (FROZEN) is not blocking anyone
  var stagingOnlyBlocked = blockResult.blocked.some(function(b) {
    return b.missingInputs.indexOf('stagingUrl') !== -1;
  });
  assert.strictEqual(stagingOnlyBlocked, false, 'stagingUrl (FROZEN) should not cause blocking. Got: ' + JSON.stringify(blockResult.blocked));
  done();
});

// ---------------------------------------------------------------------------
// TEST H: Registry unavailable returns error, not empty list
// ---------------------------------------------------------------------------

test('manifest [H]: unavailable registry returns registryError, not empty blocked list', function(t, done) {
  var m = makeGoodManifest();
  var result = manifestModule.listBlockedByInputs(m, { registryPath: path.join(__dirname, '..', 'manifest', 'DOES_NOT_EXIST.json') });
  assert.ok(result.registryError !== null, 'Should have registryError when registry unavailable');
  assert.deepStrictEqual(result.blocked, [], 'blocked should be empty [] when registry unavailable (error is in registryError)');
  done();
});

test('manifest [H]: unknown input ID is reported in unknownInputs, not silently ignored', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].requiredInputs = ['UNKNOWN_INPUT_XYZ'];

  var result = manifestModule.listBlockedByInputs(m);

  assert.ok(result.blocked.length > 0, 'Should have blocked task');
  var entry = result.blocked[0];
  assert.ok(entry.unknownInputs && entry.unknownInputs.indexOf('UNKNOWN_INPUT_XYZ') !== -1,
    'Unknown input should appear in unknownInputs. Got: ' + JSON.stringify(entry));
  done();
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('manifest: validateManifest handles null input', function(t, done) {
  var result = manifestModule.validateManifest(null);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  done();
});

test('manifest: validateManifest handles non-object input', function(t, done) {
  var result = manifestModule.validateManifest('string');
  assert.strictEqual(result.valid, false, 'Should be invalid');
  done();
});

test('manifest: toTaskCard handles minimal task (backward compat without manifest)', function(t, done) {
  var card = manifestModule.toTaskCard({
    canonicalId: 'TST-01',
    batch: 'BATCH-1',
    title: 'Minimal task',
    expectedResult: 'Result.',
    mappingType: 'direct',
    status: 'READY',
    origin: 'client-batch'
  });
  assert.strictEqual(card.taskId, 'TST-01');
  assert.strictEqual(card.batchId, 'BATCH-1');
  assert.strictEqual(card.title, 'Minimal task');
  assert.ok(Array.isArray(card.acceptanceConditions), 'acceptanceConditions should be array');
  done();
});

test('manifest: chains array validation on good manifest', function(t, done) {
  var m = makeGoodManifest();
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'Good manifest with chains should pass');
  done();
});

test('manifest: chain entry without chainId fails', function(t, done) {
  var m = makeGoodManifest({
    chains: [{ name: 'No ID', summaryChains: [], canonicalIds: [] }]
  });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('chainId') !== -1; }), 'Should mention chainId');
  done();
});

test('manifest: chain entry without name fails', function(t, done) {
  var m = makeGoodManifest({
    chains: [{ chainId: 'X', summaryChains: [], canonicalIds: [] }]
  });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('name') !== -1; }), 'Should mention name');
  done();
});

test('manifest: validateManifest skips registry validation with skipRegistryValidation option', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].requiredInputs = ['TOTALLY_FAKE_INPUT_THAT_DOES_NOT_EXIST'];
  var result = manifestModule.validateManifest(m, { skipRegistryValidation: true });
  assert.strictEqual(result.valid, true, 'Should pass when registry validation is skipped even with fake input');
  done();
});

test('manifest: listBlockedByInputs returns blocked for task requiring only MISSING input', function(t, done) {
  var m = makeGoodManifest({
    tasks: [makeGoodTask({ requiredInputs: ['stripeTestKeys'] })]
  });
  var result = manifestModule.listBlockedByInputs(m);
  assert.ok(result.blocked.length > 0, 'Should have blocked task');
  assert.ok(result.blocked[0].missingInputs.indexOf('stripeTestKeys') !== -1, 'stripeTestKeys should be in missingInputs');
  done();
});

test('manifest: listBlockedByInputs does NOT block for task requiring only FROZEN input', function(t, done) {
  var m = makeGoodManifest({
    tasks: [makeGoodTask({ requiredInputs: ['stagingUrl'] })]
  });
  var result = manifestModule.listBlockedByInputs(m);
  var blockedIds = result.blocked.map(function(b) { return b.canonicalId; });
  assert.ok(blockedIds.indexOf(m.tasks[0].canonicalId) === -1, 'FROZEN inputs should not cause blocking. Blocked: ' + blockedIds.join(', '));
  done();
});

test('manifest: CAN-B2-13 uses simulatedCarrierConfig (not shippingCarrierConfig)', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-13');
  assert.ok(task.requiredInputs.indexOf('simulatedCarrierConfig') !== -1, 'CAN-B2-13 should require simulatedCarrierConfig');
  assert.strictEqual(task.requiredInputs.indexOf('shippingCarrierConfig'), -1, 'shippingCarrierConfig should NOT be present');
  done();
});

test('manifest: validateManifest passes for CAN-B2-13 with corrected input name', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var validation = manifestModule.validateManifest(result.manifest);
  assert.strictEqual(validation.valid, true, 'Real manifest should validate. Errors: ' + validation.errors.join('; '));
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — manifestVersion validation
// ---------------------------------------------------------------------------

test('manifest [v0.4]: manifestVersion "0.4" is accepted', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, '0.4 should be accepted: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: invalid manifestVersion fails', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '99.9' });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Invalid version should fail');
  assert.ok(result.errors.some(function(e) { return e.indexOf('manifestVersion') !== -1; }), 'Should mention manifestVersion');
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — mandatoryAssertions validation
// ---------------------------------------------------------------------------

test('manifest [v0.4]: duplicate mandatory assertion id fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mandatoryAssertions = [
    { id: 'CAN-B1-01-A01', text: 'First assertion', sourceRef: { doc: 'd', section: 's' }, evidenceKinds: [] },
    { id: 'CAN-B1-01-A01', text: 'Duplicate id', sourceRef: { doc: 'd', section: 's' }, evidenceKinds: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail with duplicate assertion id');
  assert.ok(result.errors.some(function(e) { return e.indexOf('duplicate') !== -1; }), 'Should mention duplicate: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: mandatory assertion without text fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mandatoryAssertions = [
    { id: 'CAN-B1-01-A01', text: '', sourceRef: { doc: 'd', section: 's' }, evidenceKinds: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail with empty text');
  assert.ok(result.errors.some(function(e) { return e.indexOf('text') !== -1; }), 'Should mention text: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: mandatory assertion without sourceRef fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mandatoryAssertions = [
    { id: 'CAN-B1-01-A01', text: 'Some text', sourceRef: {}, evidenceKinds: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail without sourceRef');
  assert.ok(result.errors.some(function(e) { return e.indexOf('sourceRef') !== -1; }), 'Should mention sourceRef: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: mandatory assertion missing sourceRef.doc fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mandatoryAssertions = [
    { id: 'CAN-B1-01-A01', text: 'Some text', sourceRef: { section: 's' }, evidenceKinds: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail without sourceRef.doc');
  done();
});

test('manifest [v0.4]: mandatory assertion missing sourceRef.section fails', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mandatoryAssertions = [
    { id: 'CAN-B1-01-A01', text: 'Some text', sourceRef: { doc: 'd' }, evidenceKinds: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail without sourceRef.section');
  done();
});

test('manifest [v0.4]: valid mandatoryAssertions pass validation', function(t, done) {
  var m = makeGoodManifest();
  m.tasks[0].mandatoryAssertions = [
    { id: 'CAN-B1-01-A01', text: 'Some assertion text here.', sourceRef: { doc: 'test', section: 'test' }, evidenceKinds: ['browser'] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'Should pass: ' + result.errors.join('; '));
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — scripts[] validation
// ---------------------------------------------------------------------------

test('manifest [v0.4]: duplicate script name fails', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'setup_tax_rates', kind: 'present', canonicalPath: 'a.mjs', relatedTasks: [] },
    { name: 'setup_tax_rates', kind: 'adapter', canonicalPath: 'b.sh', relatedTasks: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail with duplicate script name');
  assert.ok(result.errors.some(function(e) { return e.indexOf('duplicate') !== -1; }), 'Should mention duplicate: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: invalid script kind fails', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'test_script', kind: 'NOT_VALID', canonicalPath: 'test.mjs', relatedTasks: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail with invalid kind');
  assert.ok(result.errors.some(function(e) { return e.indexOf('kind') !== -1; }), 'Should mention kind: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: script relatedTasks with unknown task id fails', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'test_script', kind: 'present', canonicalPath: 'test.mjs', relatedTasks: ['CAN-DOES-NOT-EXIST'] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Should fail with unknown related task');
  assert.ok(result.errors.some(function(e) { return e.indexOf('CAN-DOES-NOT-EXIST') !== -1; }), 'Should mention unknown task: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: valid scripts pass validation', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'setup_tax_rates', kind: 'present', canonicalPath: 'scripts/setup_tax_rates.mjs', relatedTasks: ['CAN-TST-01'] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'Should pass: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: scripts not validated for manifestVersion 0.1', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.1' });
  m.scripts = [
    { name: 'bad_script', kind: 'INVALID_KIND', canonicalPath: 'x.mjs', relatedTasks: [] }
  ];
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'v0.1 should not validate scripts: ' + result.errors.join('; '));
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — getMandatoryAssertions
// ---------------------------------------------------------------------------

test('manifest [v0.4]: getMandatoryAssertions returns assertions for task', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var assertions = manifestModule.getMandatoryAssertions(result.manifest, 'CAN-B2-07');
  assert.ok(assertions.length > 0, 'CAN-B2-07 should have assertions');
  assert.strictEqual(assertions[0].id, 'CAN-B2-07-A01');
  done();
});

test('manifest [v0.4]: getMandatoryAssertions returns empty for unknown task', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var assertions = manifestModule.getMandatoryAssertions(result.manifest, 'CAN-DOES-NOT-EXIST');
  assert.deepStrictEqual(assertions, [], 'Unknown task returns empty array');
  done();
});

test('manifest [v0.4]: getMandatoryAssertions on null manifest returns empty', function(t, done) {
  var assertions = manifestModule.getMandatoryAssertions(null, 'CAN-B1-01');
  assert.deepStrictEqual(assertions, []);
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — getScript
// ---------------------------------------------------------------------------

test('manifest [v0.4]: getScript returns script by name', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var script = manifestModule.getScript(result.manifest, 'setup_tax_rates');
  assert.ok(script, 'Should find setup_tax_rates');
  assert.strictEqual(script.kind, 'present');
  done();
});

test('manifest [v0.4]: getScript returns null for unknown name', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var script = manifestModule.getScript(result.manifest, 'does_not_exist');
  assert.strictEqual(script, null, 'Unknown script returns null');
  done();
});

test('manifest [v0.4]: getScript on null manifest returns null', function(t, done) {
  var script = manifestModule.getScript(null, 'setup_tax_rates');
  assert.strictEqual(script, null);
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — listToConfirm
// ---------------------------------------------------------------------------

test('manifest [v0.4]: listToConfirm returns count and items', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var report = manifestModule.listToConfirm(result.manifest);
  assert.ok(report.total > 0, 'Should have TO_CONFIRM values');
  assert.ok(Array.isArray(report.items), 'items should be array');
  assert.ok(report.items.length > 0, 'items should not be empty');
  done();
});

test('manifest [v0.4]: listToConfirm on null manifest returns zero', function(t, done) {
  var report = manifestModule.listToConfirm(null);
  assert.strictEqual(report.total, 0);
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — countToConfirmBySection
// ---------------------------------------------------------------------------

test('manifest [v0.4]: countToConfirmBySection returns section breakdown', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var count = manifestModule.countToConfirmBySection(result.manifest);
  assert.ok(count.total > 0, 'Should have TO_CONFIRM values');
  assert.ok(Array.isArray(count.sections), 'sections should be array');
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — toTaskCard carries mandatoryAssertions, scripts, manifestVersion
// ---------------------------------------------------------------------------

test('manifest [v0.4]: toTaskCard carries mandatoryAssertions into card environment', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-07');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.ok(card.environment.mandatoryAssertions, 'mandatoryAssertions should be in environment');
  assert.ok(card.environment.mandatoryAssertions.length > 0, 'should have assertions');
  assert.strictEqual(card.environment.mandatoryAssertions[0].id, 'CAN-B2-07-A01');
  done();
});

test('manifest [v0.4]: toTaskCard carries scriptDependencies into card environment', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-14');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.ok(card.environment.scriptDependencies, 'scriptDependencies should be in environment');
  assert.ok(card.environment.scriptDependencies.length > 0, 'should have script deps');
  // setup_tax_rates is related to CAN-B2-14
  var names = card.environment.scriptDependencies.map(function(s) { return s.name; });
  assert.ok(names.indexOf('setup_tax_rates') !== -1, 'setup_tax_rates should be in deps: ' + names.join(','));
  done();
});

test('manifest [v0.4]: toTaskCard carries manifestVersion into card environment', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B1-01');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.strictEqual(card.environment.manifestVersion, '0.4-reconciled', 'manifestVersion should be 0.4-reconciled');
  done();
});

test('manifest [v0.4]: toTaskCard carries manifestSource into card environment', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B1-01');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.ok(card.environment.manifestSource, 'manifestSource should be present');
  assert.ok(card.environment.manifestSource.pinnedRepoCommit, 'pinnedRepoCommit should be in source');
  done();
});

test('manifest [v0.4]: toTaskCard status stays PENDING regardless of manifestStatus', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B1-01');
  var card = manifestModule.toTaskCard(task, result.manifest);
  assert.strictEqual(card.status, 'PENDING', 'card status should always be PENDING');
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — mandatoryAssertions round-trip through planner.createExecutionPlan
// ---------------------------------------------------------------------------

test('manifest [v0.4]: every task with mandatoryAssertions produces valid plan', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var failures = [];
  for (var i = 0; i < result.manifest.tasks.length; i++) {
    var task = result.manifest.tasks[i];
    if (!Array.isArray(task.mandatoryAssertions) || task.mandatoryAssertions.length === 0) continue;
    var card = manifestModule.toTaskCard(task, result.manifest);
    var planResult = plannerModule.createExecutionPlan(card);
    if (!planResult.valid) {
      failures.push(task.canonicalId + ': ' + planResult.errors.join('; '));
    }
    // Verify assertions are preserved in the card environment
    if (!card.environment.mandatoryAssertions || card.environment.mandatoryAssertions.length === 0) {
      failures.push(task.canonicalId + ': assertions not preserved in card');
    }
  }
  assert.strictEqual(failures.length, 0, 'All tasks with assertions should round-trip cleanly. Failures: ' + failures.join(' | '));
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — checkFiles option
// ---------------------------------------------------------------------------

test('manifest [v0.4]: checkFiles option reports missing present script', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'missing_script', kind: 'present', canonicalPath: 'DOES_NOT_EXIST/notpresent.mjs', relatedTasks: ['CAN-B1-01'] }
  ];
  var result = manifestModule.validateManifest(m, { checkFiles: true, root: process.cwd() });
  assert.strictEqual(result.valid, false, 'Should fail when script file missing');
  assert.ok(result.errors.some(function(e) { return e.indexOf('missing_script') !== -1 && e.indexOf('canonicalPath') !== -1; }),
    'Should report missing script: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: checkFiles option passes for existing adapter script', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'mark_shipped', kind: 'adapter', canonicalPath: 'evaluation-demo/migration-input/legacy/vendure-store/tools/mark_shipped_from_csv.sh', relatedTasks: ['CAN-TST-01'] }
  ];
  var result = manifestModule.validateManifest(m, { checkFiles: true, root: process.cwd() });
  assert.strictEqual(result.valid, true, 'Should pass for existing adapter script: ' + result.errors.join('; '));
  done();
});

test('manifest [v0.4]: checkFiles option skips TO_CONFIRM paths', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4' });
  m.scripts = [
    { name: 'set_commission_tiers', kind: 'pipeline-authored', canonicalPath: 'TO_CONFIRM: not yet available', relatedTasks: ['CAN-TST-01'] }
  ];
  var result = manifestModule.validateManifest(m, { checkFiles: true, root: process.cwd() });
  assert.strictEqual(result.valid, true, 'TO_CONFIRM path should be skipped in checkFiles: ' + result.errors.join('; '));
  done();
});

// ---------------------------------------------------------------------------
// v0.4 — toTaskCard mandatoryAssertions round-trip with planner
// ---------------------------------------------------------------------------

test('manifest [v0.4]: toTaskCard + createExecutionPlan for CAN-DEMO-01', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-DEMO-01');
  assert.ok(task, 'CAN-DEMO-01 should exist');
  var card = manifestModule.toTaskCard(task, result.manifest);
  var plan = plannerModule.createExecutionPlan(card);
  assert.strictEqual(plan.valid, true, 'CAN-DEMO-01 plan should be valid: ' + (plan.errors || []).join('; '));
  done();
});

// ---------------------------------------------------------------------------
// Chunk 1c new tests — CAN-B2-16 scope, COV-A13, scriptNameMap, CONTRACTOR_FREEZE
// ---------------------------------------------------------------------------

test('manifest [1c]: CAN-B2-16-A03 is absent (parallel-task-orchestrator assertion deleted)', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var task = manifestModule.getTask(result.manifest, 'CAN-B2-16');
  assert.ok(task, 'CAN-B2-16 should exist');
  var ids = task.mandatoryAssertions.map(function(a) { return a.id; });
  assert.strictEqual(ids.indexOf('CAN-B2-16-A03'), -1, 'CAN-B2-16-A03 must not exist. Got: ' + ids.join(', '));
  done();
});

test('manifest [1c]: COV-A13 coverage maps only to CAN-B2-14 (not CAN-B2-16)', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var t14 = manifestModule.getTask(result.manifest, 'CAN-B2-14');
  var t16 = manifestModule.getTask(result.manifest, 'CAN-B2-16');
  var a14 = t14.mandatoryAssertions.filter(function(a) { return a.coverageRef === 'COV-A13'; });
  var a16 = t16.mandatoryAssertions.filter(function(a) { return a.coverageRef === 'COV-A13'; });
  assert.ok(a14.length > 0, 'At least one CAN-B2-14 assertion must have coverageRef COV-A13. Found: ' + a14.length);
  assert.strictEqual(a16.length, 0, 'No CAN-B2-16 assertion may have coverageRef COV-A13. Found: ' + a16.length + ' (' + t16.mandatoryAssertions.map(function(a){return a.id+':'+a.coverageRef;}).join(', ') + ')');
  done();
});

test('manifest [1c/2]: scriptNameMap has exactly 9 entries from section 4.8', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var m = result.manifest;
  assert.ok(m.scriptNameMap, 'scriptNameMap must be present');
  var keys = Object.keys(m.scriptNameMap);
  assert.strictEqual(keys.length, 9, 'scriptNameMap must have exactly 9 entries. Got: ' + keys.length + ' (' + keys.join(', ') + ')');
  // Verify key mappings
  assert.strictEqual(m.scriptNameMap['setup_tax_rates.ts'], 'scripts/setup_tax_rates.mjs', 'setup_tax_rates.ts mapping');
  assert.strictEqual(m.scriptNameMap['process_shipping_csv.ts'], 'scripts/process_shipping_csv.mjs', 'process_shipping_csv.ts mapping');
  assert.strictEqual(m.scriptNameMap['mark_shipped_from_csv.sh'], 'tools/mark_shipped_from_csv.sh', 'mark_shipped_from_csv.sh mapping');
  assert.strictEqual(m.scriptNameMap['set_craft_fee.ts'], 'scripts/set_craft_fee.mjs', 'set_craft_fee.ts mapping');
  assert.strictEqual(m.scriptNameMap['admin_delist_products.ts'], 'scripts/admin_delist_products.mjs', 'admin_delist_products.ts mapping');
  done();
});

test('manifest [1c]: no task or assertion text contains "four branch tasks" or "parallel-task-orchestrator"', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var forbidden = ['four branch tasks', 'parallel-task-orchestrator'];
  var found = [];
  result.manifest.tasks.forEach(function(task) {
    if (task.scopeNote && task.scopeNote.toLowerCase().indexOf('four branch tasks') !== -1) return; // scopeNote is allowed
    forbidden.forEach(function(term) {
      if (task.expectedResult && task.expectedResult.toLowerCase().indexOf(term) !== -1) {
        found.push(task.canonicalId + '.expectedResult: ' + term);
      }
      (task.mandatoryAssertions || []).forEach(function(a) {
        if (a.text && a.text.toLowerCase().indexOf(term) !== -1) {
          found.push(task.canonicalId + '.' + a.id + ': ' + term);
        }
      });
    });
  });
  assert.strictEqual(found.length, 0, 'Forbidden terms found: ' + found.join('; '));
  done();
});

test('manifest [1c]: CONTRACTOR_FREEZE is accepted as a valid task status', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4-reconciled' });
  m.tasks[0].status = 'CONTRACTOR_FREEZE';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, 'CONTRACTOR_FREEZE should be accepted: ' + result.errors.join('; '));
  done();
});

test('manifest [1c]: an invalid status is still rejected', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4-reconciled' });
  m.tasks[0].status = 'NOT_A_VALID_STATUS';
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, false, 'Invalid status must be rejected');
  assert.ok(result.errors.some(function(e) { return e.indexOf('status') !== -1; }), 'Error should mention status');
  done();
});

test('manifest [1c]: expectedValuesHash changes when a mandatory assertion changes', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var originalHash = result.manifest.integrity.expectedValuesHash;

  // Mutate one assertion text in a copy
  var m2 = JSON.parse(JSON.stringify(result.manifest));
  m2.tasks[0].mandatoryAssertions[0].text = 'Modified assertion text that changes the hash';

  // Recompute hash the same way the builder does
  var canonicalData = {
    tasks: m2.tasks.map(function(task) {
      return {
        canonicalId: task.canonicalId,
        expectedResult: task.expectedResult,
        mandatoryAssertions: task.mandatoryAssertions
      };
    })
  };

  function canonicalize(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(canonicalize).sort();
    var keys = Object.keys(obj).sort();
    var result = {};
    keys.forEach(function(k) { result[k] = canonicalize(obj[k]); });
    return result;
  }

  var newHash = require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(canonicalData)))
    .digest('hex');

  assert.notStrictEqual(newHash, originalHash, 'Hash must change when assertion changes. Old: ' + originalHash + ', New: ' + newHash);
  done();
});

test('manifest [1c]: manifestVersion "0.4-reconciled" is accepted', function(t, done) {
  var m = makeGoodManifest({ manifestVersion: '0.4-reconciled' });
  var result = manifestModule.validateManifest(m);
  assert.strictEqual(result.valid, true, '0.4-reconciled should be accepted: ' + result.errors.join('; '));
  done();
});

test('manifest [1c]: CONTRACTOR_FREEZE appears in statusLegend', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  assert.ok(result.manifest.statusLegend.CONTRACTOR_FREEZE, 'CONTRACTOR_FREEZE must be in statusLegend');
  assert.ok(result.manifest.statusLegend.CONTRACTOR_FREEZE.indexOf('freeze') !== -1, 'statusLegend.CONTRACTOR_FREEZE should mention freeze');
  done();
});

test('manifest [2b]: readinessProfiles does not change expectedValuesHash', function(t, done) {
  var result = manifestModule.loadManifest(MANIFEST_PATH);
  var m = result.manifest;
  var originalHash = m.integrity.expectedValuesHash;

  var m2 = JSON.parse(JSON.stringify(m));
  m2.readinessProfiles = {
    'CAN-B1-03|readiness': { scope: 'readiness', taskId: 'CAN-B1-03', requiredInputs: ['stagingUrl', 'channelTokens'] },
    'CAN-B1-04|readiness': { scope: 'readiness', taskId: 'CAN-B1-04', requiredInputs: ['stagingUrl', 'channelTokens'], fixtureEntries: ['nailSizeReferenceData'] },
    'CAN-B2-16|shipping-dryrun': { scope: 'shipping-dryrun', taskId: 'CAN-B2-16', requiredInputs: [] }
  };

  var integrityModule = require('../src/integrity');
  var newHash = integrityModule.computeExpectedValuesHash(m2);
  assert.strictEqual(newHash, originalHash, 'readinessProfiles must not affect expectedValuesHash');
  done();
});