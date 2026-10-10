'use strict';

var VALID_PREFLIGHT_STATUSES = ['FROZEN', 'PENDING_CLIENT', 'MISSING', 'CONTRACTOR_FREEZE', 'VERIFIED', 'PROPOSED'];

var fixturesModule;

/**
 * Lazily load fixtures module to avoid circular dependency.
 */
function getFixturesModule() {
  if (!fixturesModule) {
    fixturesModule = require('./fixtures');
  }
  return fixturesModule;
}

/**
 * Verify the frozen fixtures hash. Returns null if verification passes.
 * Returns an error object if verification fails.
 *
 * A mismatch means the fixtures file has been tampered with after the hash
 * was pinned. This is a SAFETY_AUTHORIZATION failure: the frozen values
 * cannot be trusted. Note: this proves frozen values exist; executors
 * still verify live behaviour independently.
 *
 * @param {Object} registry - loaded inputs registry
 * @returns {Object|null} error object or null if verification passes
 */
function checkFixturesHash(registry) {
  var fx = getFixturesModule();
  var loaded = fx.loadFixturesFile();
  if (!loaded.ok) {
    return {
      ok: false,
      error: 'FIXTURES_LOAD_FAILED',
      reason: loaded.error,
      classification: 'SAFETY_AUTHORIZATION'
    };
  }
  // The registry's top-level frozenHash must match the verified fixtures sha.
  // A mismatch means the fixtures file was modified after the registry was
  // written (tampering attempt).
  if (registry && registry.frozenHash && registry.frozenHash !== loaded.sha256) {
    return {
      ok: false,
      error: 'FIXTURES_HASH_MISMATCH',
      reason: 'fixtures file sha256 does not match registry frozenHash',
      expectedHash: registry.frozenHash,
      actualHash: loaded.sha256,
      classification: 'SAFETY_AUTHORIZATION'
    };
  }
  return null;
}

function preflight(manifest, registry, taskId, deps) {
  deps = deps || {};
  var getEnv = deps.getEnv || function() { return process.env; };
  var logger = deps.logger;
  var checkFx = deps.checkFixturesHash !== false;

  if (!manifest || !manifest.tasks) {
    return { ok: false, missing: [], unresolved: [], error: 'Invalid manifest' };
  }
  if (!registry || !Array.isArray(registry.inputs)) {
    return { ok: false, missing: [], unresolved: [], error: 'Invalid registry' };
  }

  var task = null;
  for (var i = 0; i < manifest.tasks.length; i++) {
    if (manifest.tasks[i].canonicalId === taskId) {
      task = manifest.tasks[i];
      break;
    }
  }

  if (!task) {
    return { ok: false, missing: [], unresolved: [], error: 'Task not found: ' + taskId };
  }

  var requiredInputs = task.requiredInputs || [];
  var registryMap = {};
  for (var j = 0; j < registry.inputs.length; j++) {
    registryMap[registry.inputs[j].id] = registry.inputs[j];
  }

  // Verify the frozen fixtures hash only when this task actually resolves a
  // fixture-backed input. A mismatch is SAFETY_AUTHORIZATION: the frozen
  // fixture data cannot be trusted (tampering detected after hash was pinned).
  // This proves frozen values exist; executors still verify live behaviour
  // independently.
  var usesFixtures = requiredInputs.some(function(inputId) {
    var e = registryMap[inputId];
    return !!(e && e.fixturePath);
  });
  if (checkFx && usesFixtures) {
    var fxCheck = checkFixturesHash(registry);
    if (fxCheck && !fxCheck.ok) {
      return {
        ok: false,
        missing: [],
        unresolved: [],
        error: fxCheck.error,
        reason: fxCheck.reason,
        classification: fxCheck.classification,
        expectedHash: fxCheck.expectedHash || null,
        actualHash: fxCheck.actualHash || null
      };
    }
  }

  var missing = [];
  var unresolved = [];
  var satisfied = [];

  for (var k = 0; k < requiredInputs.length; k++) {
    var inputId = requiredInputs[k];
    var entry = registryMap[inputId];

    if (!entry) {
      missing.push({
        inputId: inputId,
        status: 'UNKNOWN',
        envVars: [],
        note: 'Input not found in registry'
      });
      continue;
    }

    var status = entry.status;

    if (status === 'PENDING_CLIENT' || status === 'MISSING') {
      var envVarNames = getEnvVarNames(entry, inputId);
      if (envVarNames.length === 0) {
        missing.push({
          inputId: inputId,
          status: status,
          envVars: [],
          present: [],
          absent: [],
          note: 'input has no env-var name in registry; cannot be satisfied'
        });
      } else {
        var present = [];
        var absent = [];
        var satisfiedBy = {};
        for (var m = 0; m < envVarNames.length; m++) {
          var varName = envVarNames[m];
          var satisfyingName = findSatisfyingEnvVarName(entry, varName, getEnv);
          if (satisfyingName !== null) {
            present.push(satisfyingName);
            satisfiedBy[varName] = satisfyingName;
          } else {
            absent.push(varName);
          }
        }
        if (absent.length > 0) {
          missing.push({
            inputId: inputId,
            status: status,
            envVars: envVarNames,
            present: present,
            absent: absent,
            satisfiedBy: satisfiedBy
          });
        } else {
          // All required env vars are satisfied; record WHICH NAME satisfied
          // each (the name itself or an alias). Values are never recorded.
          satisfied.push({
            inputId: inputId,
            status: status,
            envVars: envVarNames,
            satisfiedBy: satisfiedBy
          });
        }
      }
    } else if (status === 'CONTRACTOR_FREEZE') {
      if (entry.frozenHash === null || entry.frozenHash === undefined) {
        unresolved.push({
          inputId: inputId,
          status: status,
          note: entry.toConfirm || 'Contractor freeze value not yet resolved'
        });
      }
    }
  }

  return {
    ok: missing.length === 0 && unresolved.length === 0,
    missing: missing,
    unresolved: unresolved,
    satisfied: satisfied
  };
}

function entryHasEnvVars(entry) {
  if (!entry) return false;
  if (entry.secretRef && typeof entry.secretRef === 'string') return true;
  if (Array.isArray(entry.envVars) && entry.envVars.length > 0) return true;
  return false;
}

function getEnvVarNames(entry, inputId) {
  if (entry.secretRef) {
    return [entry.secretRef];
  }
  if (entry.envVars && Array.isArray(entry.envVars)) {
    return entry.envVars;
  }
  return [];
}

/**
 * Return the alias names registered for a logical env var name, or [].
 * Aliases live in entry.envVarAliases[envVarName] as an array.
 */
function getEnvVarAliases(entry, envVarName) {
  if (!entry || !entry.envVarAliases) return [];
  var aliases = entry.envVarAliases[envVarName];
  return Array.isArray(aliases) ? aliases : [];
}

/**
 * A required env var is satisfied if the name OR any of its aliases is set
 * and non-empty. Returns the NAME that actually satisfied it (the primary
 * takes precedence, then aliases in order), or null when none is set.
 * Values are never returned - only the name.
 */
function findSatisfyingEnvVarName(entry, envVarName, getEnv) {
  var candidates = [envVarName].concat(getEnvVarAliases(entry, envVarName));
  for (var i = 0; i < candidates.length; i++) {
    var value = getEnv()[candidates[i]];
    if (value !== undefined && value !== null && value !== '') {
      return candidates[i];
    }
  }
  return null;
}

/**
 * Check OPENROUTER_API_KEY status.
 * With mock provider: missing key is NOT a failure.
 * With real provider: missing key triggers CLIENT_INPUT_SCOPE exit code.
 *
 * @param {Function} getEnv - Returns env vars object
 * @param {string} [providerType] - 'mock' or 'real' (default: 'mock')
 * @returns {Object} {ok, missing, exitCode}
 */
function checkOpenRouterApiKey(getEnv, providerType) {
  getEnv = getEnv || function() { return process.env; };
  providerType = providerType || 'mock';

  var apiKey = getEnv()['OPENROUTER_API_KEY'];
  var isPresent = apiKey !== undefined && apiKey !== null && apiKey !== '';

  if (isPresent) {
    return { ok: true, missing: [] };
  }

  // Missing key: only fail if real provider
  if (providerType === 'real') {
    return {
      ok: false,
      missing: ['OPENROUTER_API_KEY'],
      exitCode: 4,
      classification: 'CLIENT_INPUT_SCOPE',
      message: 'OPENROUTER_API_KEY is required for real OpenRouter provider'
    };
  }

  // Mock provider: missing key is OK
  return { ok: true, missing: ['OPENROUTER_API_KEY'] };
}

var ALLOWED_MODEL = 'z-ai/glm-5.3-flash';

/**
 * Check model lock - LLM_MODEL or OPENROUTER_MODEL must be z-ai/glm-5.3-flash if set.
 * This prevents selecting any model other than the locked one.
 * This check runs in preflight before any provider call is made.
 *
 * @param {Function} getEnv - Returns env vars object
 * @returns {Object} {ok, message, disallowedModel}
 */
function checkModelLock(getEnv) {
  getEnv = getEnv || function() { return process.env; };

  var llmModel = getEnv()['LLM_MODEL'];
  var openrouterModel = getEnv()['OPENROUTER_MODEL'];
  var configuredModel = openrouterModel || llmModel;

  // If no model is configured, that's OK (uses default)
  if (!configuredModel) {
    return { ok: true, message: null, disallowedModel: null };
  }

  // If a model is configured but it's not the allowed one, fail
  if (configuredModel !== ALLOWED_MODEL) {
    return {
      ok: false,
      message: 'Model lock violation: LLM_MODEL/OPENROUTER_MODEL is set to "' + configuredModel + '" but only "' + ALLOWED_MODEL + '" is allowed. No provider call will be made.',
      disallowedModel: configuredModel,
      exitCode: 4,
      classification: 'SAFETY_AUTHORIZATION'
    };
  }

  // Configured model is the allowed one
  return { ok: true, message: null, disallowedModel: null };
}

module.exports = {
  preflight: preflight,
  getEnvVarNames: getEnvVarNames,
  getEnvVarAliases: getEnvVarAliases,
  findSatisfyingEnvVarName: findSatisfyingEnvVarName,
  entryHasEnvVars: entryHasEnvVars,
  checkOpenRouterApiKey: checkOpenRouterApiKey,
  checkModelLock: checkModelLock,
  checkFixturesHash: checkFixturesHash
};
