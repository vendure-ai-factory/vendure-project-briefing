'use strict';

var test = require('node:test');
var assert = require('node:assert');

var preflightModule = require('../src/preflight');

function makeManifest(taskId, requiredInputs) {
  return {
    tasks: [{
      canonicalId: taskId,
      requiredInputs: requiredInputs || []
    }]
  };
}

function makeRegistry(inputs) {
  return { inputs: inputs || [] };
}

test('preflight: returns ok when no required inputs', function(t, done) {
  var result = preflightModule.preflight(makeManifest('TST-01', []), makeRegistry([]), 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.missing.length, 0);
  assert.strictEqual(result.unresolved.length, 0);
  done();
});

test('preflight: returns error for unknown task', function(t, done) {
  var result = preflightModule.preflight(makeManifest('TST-01', []), makeRegistry([]), 'UNKNOWN-TASK', {
    getEnv: function() { return {}; }
  });
  assert.ok(result.error);
  done();
});

test('preflight: FROZEN input does not need env var', function(t, done) {
  var manifest = makeManifest('TST-01', ['stagingUrl']);
  var registry = makeRegistry([{
    id: 'stagingUrl',
    status: 'FROZEN',
    frozenValue: 'https://staging.tibella.eu',
    secretRef: null
  }]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, true, 'FROZEN input should be ok without env var');
  done();
});

test('preflight: PENDING_CLIENT input missing when env var absent', function(t, done) {
  var manifest = makeManifest('TST-01', ['testAccounts']);
  var registry = makeRegistry([{
    id: 'testAccounts',
    status: 'PENDING_CLIENT',
    secretRef: 'TEST_ACCOUNTS_JSON',
    frozenHash: null
  }]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].inputId, 'testAccounts');
  assert.deepStrictEqual(result.missing[0].absent, ['TEST_ACCOUNTS_JSON']);
  done();
});

test('preflight: PENDING_CLIENT input ok when env var present', function(t, done) {
  var manifest = makeManifest('TST-01', ['testAccounts']);
  var registry = makeRegistry([{
    id: 'testAccounts',
    status: 'PENDING_CLIENT',
    secretRef: 'TEST_ACCOUNTS_JSON',
    frozenHash: null
  }]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return { TEST_ACCOUNTS_JSON: '{"user":"test"}' }; }
  });
  assert.strictEqual(result.ok, true);
  done();
});

test('preflight: MISSING input missing when env var absent', function(t, done) {
  var manifest = makeManifest('TST-01', ['stripeTestKeys']);
  var registry = makeRegistry([{
    id: 'stripeTestKeys',
    status: 'MISSING',
    secretRef: 'STRIPE_TEST_SECRET_KEY',
    frozenHash: null
  }]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing.length, 1);
  done();
});

test('preflight: CONTRACTOR_FREEZE with null frozenHash is unresolved', function(t, done) {
  var manifest = makeManifest('TST-01', ['exchangeRates']);
  var registry = makeRegistry([{
    id: 'exchangeRates',
    status: 'CONTRACTOR_FREEZE',
    frozenHash: null,
    toConfirm: 'Configuration not yet provided.'
  }]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.unresolved.length, 1);
  assert.strictEqual(result.unresolved[0].inputId, 'exchangeRates');
  done();
});

test('preflight: CONTRACTOR_FREEZE with non-null frozenHash is ok', function(t, done) {
  var manifest = makeManifest('TST-01', ['exchangeRates']);
  var registry = makeRegistry([{
    id: 'exchangeRates',
    status: 'CONTRACTOR_FREEZE',
    frozenHash: 'abc123',
    toConfirm: 'Configuration provided.'
  }]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, true);
  done();
});

test('preflight: multiple missing inputs collected', function(t, done) {
  var manifest = makeManifest('TST-01', ['testAccounts', 'stripeTestKeys']);
  var registry = makeRegistry([
    { id: 'testAccounts', status: 'PENDING_CLIENT', secretRef: 'TEST_ACCOUNTS_JSON', frozenHash: null },
    { id: 'stripeTestKeys', status: 'MISSING', secretRef: 'STRIPE_TEST_SECRET_KEY', frozenHash: null }
  ]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing.length, 2);
  done();
});

test('preflight: env var value never stored, only names', function(t, done) {
  var manifest = makeManifest('TST-01', ['testAccounts']);
  var registry = makeRegistry([{
    id: 'testAccounts',
    status: 'PENDING_CLIENT',
    secretRef: 'TEST_ACCOUNTS_JSON',
    frozenHash: null
  }]);
  var secretValue = 'sk-test-super-secret-key-12345';
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return { TEST_ACCOUNTS_JSON: secretValue }; }
  });
  assert.strictEqual(result.ok, true);
  var serialized = JSON.stringify(result);
  assert.strictEqual(serialized.indexOf(secretValue), -1, 'Secret value should not appear in result');
  done();
});

test('preflight: getEnvVarNames uses secretRef', function(t, done) {
  var names = preflightModule.getEnvVarNames({ secretRef: 'MY_SECRET' }, 'someInput');
  assert.deepStrictEqual(names, ['MY_SECRET']);
  done();
});

test('preflight: getEnvVarNames uses envVars array', function(t, done) {
  var names = preflightModule.getEnvVarNames({ envVars: ['VAR1', 'VAR2'] }, 'someInput');
  assert.deepStrictEqual(names, ['VAR1', 'VAR2']);
  done();
});

test('preflight: getEnvVarNames returns empty for missing entries', function(t, done) {
  var names = preflightModule.getEnvVarNames({ status: 'FROZEN' }, 'someInput');
  assert.deepStrictEqual(names, []);
  done();
});

test('preflight: checkModelLock - no model set is ok', function(t, done) {
  var getEnv = function() { return {}; };
  var result = preflightModule.checkModelLock(getEnv);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.message, null);
  assert.strictEqual(result.disallowedModel, null);
  done();
});

test('preflight: checkModelLock - allowed model via LLM_MODEL is ok', function(t, done) {
  var getEnv = function() { return { LLM_MODEL: 'z-ai/glm-5.3-flash' }; };
  var result = preflightModule.checkModelLock(getEnv);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.message, null);
  assert.strictEqual(result.disallowedModel, null);
  done();
});

test('preflight: checkModelLock - allowed model via OPENROUTER_MODEL is ok', function(t, done) {
  var getEnv = function() { return { OPENROUTER_MODEL: 'z-ai/glm-5.3-flash' }; };
  var result = preflightModule.checkModelLock(getEnv);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.message, null);
  assert.strictEqual(result.disallowedModel, null);
  done();
});

test('preflight: checkModelLock - disallowed model via LLM_MODEL fails with clear message', function(t, done) {
  var getEnv = function() { return { LLM_MODEL: 'openai/gpt-4o' }; };
  var result = preflightModule.checkModelLock(getEnv);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.disallowedModel, 'openai/gpt-4o');
  assert.strictEqual(result.exitCode, 4);
  assert.strictEqual(result.classification, 'SAFETY_AUTHORIZATION');
  assert.ok(result.message.indexOf('Model lock violation') !== -1, 'Message should say model lock violation');
  assert.ok(result.message.indexOf('z-ai/glm-5.3-flash') !== -1, 'Message should mention allowed model');
  assert.ok(result.message.indexOf('openai/gpt-4o') !== -1, 'Message should mention disallowed model');
  assert.ok(result.message.indexOf('No provider call will be made') !== -1, 'Message should clarify no provider call');
  done();
});

test('preflight: checkModelLock - disallowed model via OPENROUTER_MODEL fails with clear message', function(t, done) {
  var getEnv = function() { return { OPENROUTER_MODEL: 'anthropic/claude-3' }; };
  var result = preflightModule.checkModelLock(getEnv);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.disallowedModel, 'anthropic/claude-3');
  assert.strictEqual(result.exitCode, 4);
  assert.strictEqual(result.classification, 'SAFETY_AUTHORIZATION');
  assert.ok(result.message.indexOf('Model lock violation') !== -1);
  assert.ok(result.message.indexOf('No provider call will be made') !== -1);
  done();
});

test('preflight: checkModelLock - OPENROUTER_MODEL takes precedence over LLM_MODEL', function(t, done) {
  var getEnv = function() { return { LLM_MODEL: 'z-ai/glm-5.3-flash', OPENROUTER_MODEL: 'openai/gpt-4o' }; };
  var result = preflightModule.checkModelLock(getEnv);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.disallowedModel, 'openai/gpt-4o');
  done();
});

// ---------------------------------------------------------------------------
// PENDING_CLIENT / MISSING with NO env-var name (secretRef null and no envVars)
// ---------------------------------------------------------------------------

test('preflight: PENDING_CLIENT with no secretRef and no envVars is missing', function(t, done) {
  var registry = makeRegistry([
    { id: 'channelTokens', status: 'PENDING_CLIENT', secretRef: null, envVars: null, frozenValue: null }
  ]);
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['channelTokens'] }] },
    registry,
    'TST-01',
    { getEnv: function() { return {}; } }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].inputId, 'channelTokens');
  assert.ok(result.missing[0].note, 'should have a note explaining no env-var name');
  done();
});

test('preflight: MISSING with no secretRef and no envVars is missing', function(t, done) {
  var registry = makeRegistry([
    { id: 'isolatedCloneRestartRollback', status: 'MISSING', secretRef: null, envVars: null, frozenValue: null }
  ]);
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['isolatedCloneRestartRollback'] }] },
    registry,
    'TST-01',
    { getEnv: function() { return {}; } }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].inputId, 'isolatedCloneRestartRollback');
  done();
});

test('preflight: PENDING_CLIENT with envVars passes when the env var is set', function(t, done) {
  var registry = makeRegistry([
    { id: 'channelTokens', status: 'PENDING_CLIENT', secretRef: null, envVars: ['CHANNEL_TOKENS'], frozenValue: null }
  ]);
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['channelTokens'] }] },
    registry,
    'TST-01',
    { getEnv: function() { return { CHANNEL_TOKENS: 'abc' }; } }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.missing.length, 0);
  done();
});

test('preflight: input not required by the task is never checked', function(t, done) {
  // testAccounts is MISSING but not in requiredInputs -> no block
  var registry = makeRegistry([
    { id: 'testAccounts', status: 'MISSING', secretRef: 'TEST_ACCOUNTS_JSON', frozenValue: null },
    { id: 'stagingUrl', status: 'FROZEN', secretRef: null, frozenValue: 'https://staging.tibella.eu' }
  ]);
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingUrl'] }] },
    registry,
    'TST-01',
    { getEnv: function() { return {}; } }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.missing.length, 0);
  done();
});

test('preflight: entryHasEnvVars reflects secretRef and envVars presence', function(t, done) {
  assert.strictEqual(preflightModule.entryHasEnvVars({ secretRef: 'X' }), true);
  assert.strictEqual(preflightModule.entryHasEnvVars({ envVars: ['X'] }), true);
  assert.strictEqual(preflightModule.entryHasEnvVars({ secretRef: null, envVars: [] }), false);
  assert.strictEqual(preflightModule.entryHasEnvVars({}), false);
  assert.strictEqual(preflightModule.entryHasEnvVars(null), false);
  done();
});

test('preflight: fixtures hash mismatch blocks with SAFETY_AUTHORIZATION', function(t, done) {
  var manifest = makeManifest('TST-01', ['exchangeRates']);
  var registry = makeRegistry([
    { id: 'exchangeRates', status: 'CONTRACTOR_FREEZE', fixturePath: 'manifest/fixtures.v1.json', frozenHash: 'deadbeef' + 'x'.repeat(56) }
  ]);
  registry.frozenHash = 'deadbeef' + 'x'.repeat(56);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.classification, 'SAFETY_AUTHORIZATION');
  assert.strictEqual(result.error, 'FIXTURES_HASH_MISMATCH');
  assert.ok(result.expectedHash, 'expected hash recorded');
  assert.ok(result.actualHash, 'actual hash recorded');
  done();
});

test('preflight: fixture-backed inputs resolve only when fixtures hash verifies', function(t, done) {
  var manifest = makeManifest('TST-01', ['exchangeRates']);
  var registry = makeRegistry([
    { id: 'exchangeRates', status: 'CONTRACTOR_FREEZE', fixturePath: 'manifest/fixtures.v1.json', frozenHash: require('fs').readFileSync(require('path').resolve(__dirname, '..', 'manifest', 'fixtures.v1.sha256'), 'utf8').trim() }
  ]);
  registry.frozenHash = null;
  // No top-level frozenHash means no hash pin to compare: not a mismatch, but
  // the input still resolves via its own frozenHash.
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, true, 'CONTRACTOR_FREEZE with frozenHash is resolved');
  done();
});

test('preflight: fixtures check is skipped when no fixture-backed input is required', function(t, done) {
  var manifest = makeManifest('TST-01', ['stagingUrl']);
  var registry = makeRegistry([
    { id: 'stagingUrl', status: 'FROZEN', frozenValue: 'https://staging.tibella.eu' }
  ]);
  registry.frozenHash = 'wrong-hash-not-matching-anything';
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, true, 'non-fixture input does not run the fixtures gate');
  done();
});

test('preflight: unresolved fixture input keeps UNRESOLVED_ASSUMPTION path', function(t, done) {
  var manifest = makeManifest('TST-01', ['testAccounts']);
  var registry = makeRegistry([
    { id: 'testAccounts', status: 'CONTRACTOR_FREEZE', fixturePath: 'manifest/fixtures.v1.json', frozenHash: null, toConfirm: 'not yet frozen' }
  ]);
  var result = preflightModule.preflight(manifest, registry, 'TST-01', {
    getEnv: function() { return {}; }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.unresolved.length, 1, 'null frozenHash stays unresolved (UNRESOLVED_ASSUMPTION)');
  assert.strictEqual(result.unresolved[0].inputId, 'testAccounts');
  done();
});

test('preflight: checkFixturesHash stays SAFETY_AUTHORIZATION for a tampered pin', function(t, done) {
  var mismatch = preflightModule.checkFixturesHash({ frozenHash: 'deadbeef' + 'x'.repeat(56) });
  assert.ok(mismatch && mismatch.ok === false, 'mismatch is returned as a blockage');
  assert.strictEqual(mismatch.classification, 'SAFETY_AUTHORIZATION');
  var pass = preflightModule.checkFixturesHash({ frozenHash: require('fs').readFileSync(require('path').resolve(__dirname, '..', 'manifest', 'fixtures.v1.sha256'), 'utf8').trim() });
  assert.strictEqual(pass, null, 'matching pin returns null (no blockage)');
  done();
});

// ---------------------------------------------------------------------------
// chunk 11e: admin credential env var aliases (stagingAdminCredentials)
// ---------------------------------------------------------------------------

function makeAdminCredentialsEntry() {
  return {
    id: 'stagingAdminCredentials',
    status: 'PENDING_CLIENT',
    secretRef: null,
    envVars: ['SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD'],
    envVarAliases: {
      SUPERADMIN_USERNAME: ['STAGING_ADMIN_EMAIL'],
      SUPERADMIN_PASSWORD: ['STAGING_ADMIN_PASSWORD']
    }
  };
}

test('chunk 11e: admin credentials primary names set passes and evidence names the primary', function(t, done) {
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingAdminCredentials'] }] },
    makeRegistry([makeAdminCredentialsEntry()]),
    'TST-01',
    { getEnv: function() { return { SUPERADMIN_USERNAME: 'staging-admin-user', SUPERADMIN_PASSWORD: 'staging-admin-pw' }; } }
  );
  assert.strictEqual(result.ok, true, 'primary names set should pass');
  assert.strictEqual(result.missing.length, 0);
  assert.strictEqual(result.satisfied.length, 1);
  assert.deepStrictEqual(result.satisfied[0].satisfiedBy, {
    SUPERADMIN_USERNAME: 'SUPERADMIN_USERNAME',
    SUPERADMIN_PASSWORD: 'SUPERADMIN_PASSWORD'
  }, 'evidence records primary names as the satisfying source');
  done();
});

test('chunk 11e: admin credentials alias names set passes and evidence names the alias', function(t, done) {
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingAdminCredentials'] }] },
    makeRegistry([makeAdminCredentialsEntry()]),
    'TST-01',
    { getEnv: function() { return { STAGING_ADMIN_EMAIL: 'deploy@tibella.eu', STAGING_ADMIN_PASSWORD: 'deploy-pw' }; } }
  );
  assert.strictEqual(result.ok, true, 'alias names set should pass');
  assert.strictEqual(result.missing.length, 0);
  assert.strictEqual(result.satisfied.length, 1);
  assert.deepStrictEqual(result.satisfied[0].satisfiedBy, {
    SUPERADMIN_USERNAME: 'STAGING_ADMIN_EMAIL',
    SUPERADMIN_PASSWORD: 'STAGING_ADMIN_PASSWORD'
  }, 'evidence names the alias for each logical env var, never a value');
  done();
});

test('chunk 11e: admin credentials both unset is missing (CLIENT_INPUT_SCOPE at CLI)', function(t, done) {
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingAdminCredentials'] }] },
    makeRegistry([makeAdminCredentialsEntry()]),
    'TST-01',
    { getEnv: function() { return {}; } }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].inputId, 'stagingAdminCredentials');
  assert.deepStrictEqual(result.missing[0].absent, ['SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD']);
  assert.deepStrictEqual(result.missing[0].present, []);
  done();
});

test('chunk 11e: mixed primary and alias both satisfy the same input', function(t, done) {
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingAdminCredentials'] }] },
    makeRegistry([makeAdminCredentialsEntry()]),
    'TST-01',
    { getEnv: function() { return { SUPERADMIN_USERNAME: 'primary-user', STAGING_ADMIN_PASSWORD: 'alias-pw' }; } }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.missing.length, 0);
  assert.deepStrictEqual(result.satisfied[0].satisfiedBy, {
    SUPERADMIN_USERNAME: 'SUPERADMIN_USERNAME',
    SUPERADMIN_PASSWORD: 'STAGING_ADMIN_PASSWORD'
  });
  done();
});

test('chunk 11e: primary name takes precedence over its alias when both set', function(t, done) {
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingAdminCredentials'] }] },
    makeRegistry([makeAdminCredentialsEntry()]),
    'TST-01',
    { getEnv: function() { return { SUPERADMIN_USERNAME: 'primary', STAGING_ADMIN_EMAIL: 'alias', SUPERADMIN_PASSWORD: 'pw' }; } }
  );
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.satisfied[0].satisfiedBy.SUPERADMIN_USERNAME, 'SUPERADMIN_USERNAME');
  done();
});

test('chunk 11e: vendureAdminToken absent does not block any task', function(t, done) {
  // vendureAdminToken is optional (PENDING_CLIENT) and unset; a task that does
  // not require it passes and is never blocked by it.
  var registry = makeRegistry([
    { id: 'vendureAdminToken', status: 'PENDING_CLIENT', secretRef: 'VENDURE_ADMIN_TOKEN', frozenValue: null },
    { id: 'stagingUrl', status: 'FROZEN', frozenValue: 'https://staging.tibella.eu' }
  ]);
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingUrl'] }] },
    registry,
    'TST-01',
    { getEnv: function() { return { VENDURE_ADMIN_TOKEN: undefined }; } }
  );
  assert.strictEqual(result.ok, true, 'unrequired optional input never blocks');
  assert.strictEqual(result.missing.length, 0);
  var tokenNotChecked = result.satisfied.every(function(s) { return s.inputId !== 'vendureAdminToken'; });
  assert.ok(tokenNotChecked, 'vendureAdminToken not in satisfied (never checked)');
  done();
});

test('chunk 11e: no credential value appears in any evidence', function(t, done) {
  var result = preflightModule.preflight(
    { tasks: [{ canonicalId: 'TST-01', requiredInputs: ['stagingAdminCredentials'] }] },
    makeRegistry([makeAdminCredentialsEntry()]),
    'TST-01',
    { getEnv: function() { return { STAGING_ADMIN_EMAIL: 'deploy@tibella.eu', STAGING_ADMIN_PASSWORD: 'super-secret-alias-pw' }; } }
  );
  var serialized = JSON.stringify(result);
  assert.strictEqual(serialized.indexOf('deploy@tibella.eu'), -1, 'email alias value must never appear');
  assert.strictEqual(serialized.indexOf('super-secret-alias-pw'), -1, 'alias password value must never appear');
  assert.ok(serialized.indexOf('STAGING_ADMIN_EMAIL') !== -1, 'alias NAME should appear in evidence; only values are never stored');
  done();
});

