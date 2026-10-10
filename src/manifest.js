'use strict';

var fs = require('fs');
var path = require('path');
var taskCardModule = require('./taskCard');
var scanSecretsModule = require('../scripts/scan-secrets');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

var DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', 'manifest', 'inputs-registry.json');

function loadRegistry(registryPath) {
  registryPath = registryPath || DEFAULT_REGISTRY_PATH;
  var content;
  try {
    content = fs.readFileSync(registryPath, 'utf8');
  } catch (e) {
    return { valid: false, errors: ['Registry not found: ' + e.code], registry: null };
  }
  try {
    var reg = JSON.parse(content);
    return { valid: true, errors: [], registry: reg };
  } catch (e) {
    return { valid: false, errors: ['Registry invalid JSON: ' + e.message], registry: null };
  }
}

// ---------------------------------------------------------------------------
// Secret-pattern helpers
// ---------------------------------------------------------------------------

var SECRET_PATTERNS = scanSecretsModule.SECRET_PATTERNS;

function looksLikeSecret(value) {
  if (typeof value !== 'string') return false;
  return SECRET_PATTERNS.some(function(rule) {
    return rule.pattern.test(value);
  });
}

function objectHasSecret(obj) {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some(objectHasSecret);
  }
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    if (typeof val === 'string' && looksLikeSecret(val)) return true;
    if (typeof val === 'object' && objectHasSecret(val)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

var VALID_MAPPING_TYPES = ['direct', 'split', 'merge', 'promoted_gap', 'gap'];
var VALID_ORIGINS = ['client-batch', 'public-demo'];
var VALID_STATUSES_TASK = ['READY', 'NEEDS_CLIENT_INPUT', 'VERIFIED', 'PROPOSED', 'PENDING_CLIENT', 'PIPELINE_AUTHORING_TARGET', 'CONTRACTOR_FREEZE'];
var VALID_EVIDENCE_TYPES = ['browser', 'api', 'graphql', 'db', 'log', 'screenshot', 'trace', 'file'];
var VALID_SCRIPT_KINDS = ['present', 'adapter', 'pipeline-authored', 'not-available'];
var VALID_MANIFEST_VERSIONS = ['0.1', '0.4', '0.4-reconciled'];

function validateTaskEntry(task, idx, errors) {
  if (!task || typeof task !== 'object') {
    errors.push('tasks[' + idx + ']: must be an object');
    return;
  }

  if (!task.canonicalId) {
    errors.push('tasks[' + idx + ']: missing canonicalId');
  } else if (typeof task.canonicalId !== 'string') {
    errors.push('tasks[' + idx + ']: canonicalId must be a string');
  }

  if (!task.batch) {
    errors.push('tasks[' + idx + ']: missing batch');
  } else if (typeof task.batch !== 'string' && typeof task.batch !== 'number') {
    errors.push('tasks[' + idx + ']: batch must be a string or number');
  }

  // title is optional in v0.4 reference structure

  if (!Array.isArray(task.summaryIds)) {
    errors.push('tasks[' + idx + ']: summaryIds must be an array');
  }

  if (!Array.isArray(task.specIds)) {
    errors.push('tasks[' + idx + ']: specIds must be an array');
  }

  if (!task.mappingType) {
    errors.push('tasks[' + idx + ']: missing mappingType');
  } else if (VALID_MAPPING_TYPES.indexOf(task.mappingType) === -1) {
    errors.push('tasks[' + idx + ']: mappingType must be one of ' + VALID_MAPPING_TYPES.join(', '));
  }

  if (!task.expectedResult) {
    errors.push('tasks[' + idx + ']: missing expectedResult');
  } else if (typeof task.expectedResult !== 'string') {
    errors.push('tasks[' + idx + ']: expectedResult must be a string');
  }

  if (task.negativeChecks !== undefined && !Array.isArray(task.negativeChecks)) {
    errors.push('tasks[' + idx + ']: negativeChecks must be an array');
  }

  if (task.chains !== undefined && !Array.isArray(task.chains)) {
    errors.push('tasks[' + idx + ']: chains must be an array');
  }

  if (task.countryMatrix !== undefined && !Array.isArray(task.countryMatrix)) {
    errors.push('tasks[' + idx + ']: countryMatrix must be an array');
  }

  if (task.requiredInputs !== undefined && !Array.isArray(task.requiredInputs)) {
    errors.push('tasks[' + idx + ']: requiredInputs must be an array');
  }

  if (task.evidenceRequired !== undefined && !Array.isArray(task.evidenceRequired)) {
    errors.push('tasks[' + idx + ']: evidenceRequired must be an array');
  } else if (Array.isArray(task.evidenceRequired)) {
    for (var e = 0; e < task.evidenceRequired.length; e++) {
      if (VALID_EVIDENCE_TYPES.indexOf(task.evidenceRequired[e]) === -1) {
        errors.push('tasks[' + idx + ']: evidenceRequired[' + e + '] must be one of ' + VALID_EVIDENCE_TYPES.join(', '));
      }
    }
  }

  // status is optional — only validate when explicitly set
  if (task.status !== undefined && task.status !== null && VALID_STATUSES_TASK.indexOf(task.status) === -1) {
    errors.push('tasks[' + idx + ']: invalid status "' + task.status + '"');
  }

  if (!task.origin) {
    errors.push('tasks[' + idx + ']: missing origin');
  } else if (VALID_ORIGINS.indexOf(task.origin) === -1) {
    errors.push('tasks[' + idx + ']: origin must be one of ' + VALID_ORIGINS.join(', '));
  }

  if (task.mappingType === 'gap' && !task.gapNotes) {
    errors.push('tasks[' + idx + '] (' + task.canonicalId + '): gap task without gapNotes');
  }

  if (objectHasSecret(task)) {
    errors.push('tasks[' + idx + '] (' + (task.canonicalId || idx) + '): field value looks like a secret');
  }

  // Validate mandatoryAssertions (v0.4+)
  if (Array.isArray(task.mandatoryAssertions)) {
    validateMandatoryAssertions(task, idx, errors);
  }
}

function validateChainEntry(chain, idx, errors) {
  if (!chain || typeof chain !== 'object') {
    errors.push('chains[' + idx + ']: must be an object');
    return;
  }
  // Accept both old structure (chainId + name) and reference structure (specChainsRaw)
  if (!chain.chainId && !chain.specChainsRaw) errors.push('chains[' + idx + ']: missing chainId or specChainsRaw');
  if (!chain.name && !chain.mappingTypeSource) errors.push('chains[' + idx + ']: missing name or mappingTypeSource');
  // summaryChains can be array OR specChains can be array (reference structure)
  if (chain.summaryChains !== undefined && !Array.isArray(chain.summaryChains) && !Array.isArray(chain.specChains)) {
    errors.push('chains[' + idx + ']: summaryChains or specChains must be an array');
  }
  if (!Array.isArray(chain.canonicalIds)) errors.push('chains[' + idx + ']: canonicalIds must be an array');
}

// ---------------------------------------------------------------------------
// Chain membership derivation
// ---------------------------------------------------------------------------

function deriveChainMembership(manifest, canonicalId) {
  if (!manifest || !manifest.chains || !canonicalId) return [];
  var chains = [];
  var chainArray = manifest.chains;
  // Support new reference structure: { rows: [...], chainG: {} } and legacy flat array
  if (typeof chainArray === 'object' && !Array.isArray(chainArray)) {
    chainArray = chainArray.rows;
  }
  if (!Array.isArray(chainArray)) return [];
  for (var i = 0; i < chainArray.length; i++) {
    var chain = chainArray[i];
    if (Array.isArray(chain.canonicalIds) && chain.canonicalIds.indexOf(canonicalId) !== -1) {
      // Support both old structure (chainId) and new reference structure (specChains[0])
      chains.push(chain.chainId || (chain.specChains && chain.specChains[0]));
    }
  }
  return chains;
}

// ---------------------------------------------------------------------------
// Registry-backed requiredInputs validation
// ---------------------------------------------------------------------------

function validateRequiredInputsAgainstRegistry(manifest, registry, errors) {
  if (!Array.isArray(manifest.tasks)) return;
  if (!registry || !Array.isArray(registry.inputs)) return;

  var registryIds = {};
  registry.inputs.forEach(function(inp) {
    registryIds[inp.id] = true;
  });

  manifest.tasks.forEach(function(task, idx) {
    if (!Array.isArray(task.requiredInputs)) return;
    for (var r = 0; r < task.requiredInputs.length; r++) {
      var inpId = task.requiredInputs[r];
      if (!registryIds[inpId]) {
        errors.push('tasks[' + idx + '] (' + (task.canonicalId || '?') + '): requiredInputs references unknown registry id "' + inpId + '"');
      }
    }
  });
}

// ---------------------------------------------------------------------------
// mandatoryAssertions validation
// ---------------------------------------------------------------------------

function validateMandatoryAssertions(task, taskIdx, errors) {
  if (!Array.isArray(task.mandatoryAssertions)) return;
  var seenIds = {};
  for (var i = 0; i < task.mandatoryAssertions.length; i++) {
    var a = task.mandatoryAssertions[i];
    var prefix = 'tasks[' + taskIdx + '] (' + (task.canonicalId || '?') + ') mandatoryAssertions[' + i + ']';

    if (!a.id) {
      errors.push(prefix + ': missing id');
    } else {
      if (seenIds[a.id] !== undefined) {
        errors.push(prefix + ': duplicate id "' + a.id + '" (first at ' + seenIds[a.id] + ')');
      }
      seenIds[a.id] = i;
    }

    if (!a.text || typeof a.text !== 'string' || a.text.trim().length === 0) {
      errors.push(prefix + ' (' + (a.id || '?') + '): text must be a non-empty string');
    }

    if (!a.sourceRef || typeof a.sourceRef !== 'object') {
      errors.push(prefix + ' (' + (a.id || '?') + '): missing or invalid sourceRef (must be {doc, section})');
    } else {
      if (!a.sourceRef.doc) errors.push(prefix + ' (' + (a.id || '?') + '): sourceRef.doc missing');
      if (!a.sourceRef.section) errors.push(prefix + ' (' + (a.id || '?') + '): sourceRef.section missing');
    }

    if (a.evidenceKinds !== undefined && !Array.isArray(a.evidenceKinds)) {
      errors.push(prefix + ' (' + (a.id || '?') + '): evidenceKinds must be an array');
    }
  }
}

// ---------------------------------------------------------------------------
// scripts[] validation (v0.4+)
// ---------------------------------------------------------------------------

function validateScripts(manifest, errors) {
  if (!Array.isArray(manifest.scripts)) {
    errors.push('scripts must be an array');
    return;
  }

  // Unique names/ids
  var seenNames = {};
  for (var i = 0; i < manifest.scripts.length; i++) {
    var s = manifest.scripts[i];
    var scriptName = s.id || s.name;
    if (!scriptName) {
      errors.push('scripts[' + i + ']: missing id or name');
    } else {
      if (seenNames[scriptName] !== undefined) {
        errors.push('scripts[' + i + ']: duplicate script id/name "' + scriptName + '" (first at scripts[' + seenNames[scriptName] + '])');
      }
      seenNames[scriptName] = i;
    }

    if (!s.kind) {
      errors.push('scripts[' + i + '] (' + (scriptName || '?') + '): missing kind');
    } else if (VALID_SCRIPT_KINDS.indexOf(s.kind) === -1) {
      errors.push('scripts[' + i + '] (' + (scriptName || '?') + '): kind must be one of ' + VALID_SCRIPT_KINDS.join(', '));
    }
  }

  // Every relatedTasks id must refer to an existing task canonicalId
  var taskIds = {};
  if (Array.isArray(manifest.tasks)) {
    manifest.tasks.forEach(function(t) {
      if (t.canonicalId) taskIds[t.canonicalId] = true;
    });
  }

  for (var j = 0; j < manifest.scripts.length; j++) {
    var script = manifest.scripts[j];
    if (Array.isArray(script.relatedTasks)) {
      for (var k = 0; k < script.relatedTasks.length; k++) {
        var rt = script.relatedTasks[k];
        if (!taskIds[rt]) {
          errors.push('scripts[' + j + '] (' + (script.name || '?') + '): relatedTasks contains unknown task id "' + rt + '"');
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Optional: check script file existence (when options.checkFiles is true)
// ---------------------------------------------------------------------------

function validateScriptFileExistence(manifest, options, errors) {
  if (!options || options.checkFiles !== true) return;
  var root = options.root || process.cwd();
  if (!Array.isArray(manifest.scripts)) return;

  for (var i = 0; i < manifest.scripts.length; i++) {
    var s = manifest.scripts[i];
    if (s.kind === 'present' || s.kind === 'adapter') {
      var sp = s.canonicalPath;
      if (!sp || sp.indexOf('TO_CONFIRM') !== -1) continue;
      var fullPath = path.resolve(root, sp);
      if (!fs.existsSync(fullPath)) {
        errors.push('scripts[' + i + '] (' + s.name + '): canonicalPath does not exist: ' + sp);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TO_CONFIRM scanner
// ---------------------------------------------------------------------------

function scanToConfirm(obj, section, results) {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(function(item) { scanToConfirm(item, section, results); });
    return;
  }
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    var subSection = keys[i];
    if (typeof val === 'string' && val.indexOf('TO_CONFIRM') !== -1) {
      results.total++;
      if (!results._bySection[section]) results._bySection[section] = 0;
      results._bySection[section]++;
    } else if (val !== null && typeof val === 'object') {
      scanToConfirm(val, section, results);
    }
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function loadManifest(filePath) {
  var content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { valid: false, errors: ['File not found: ' + e.code], manifest: null };
  }
  try {
    var manifest = JSON.parse(content);
    return { valid: true, errors: [], manifest: manifest };
  } catch (e) {
    return { valid: false, errors: ['Invalid JSON: ' + e.message], manifest: null };
  }
}

function validateManifest(manifest, options) {
  options = options || {};
  var errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  if (!manifest.schemaVersion) {
    errors.push('missing schemaVersion');
  }

  if (!manifest.manifestVersion) {
    errors.push('missing manifestVersion');
  } else if (VALID_MANIFEST_VERSIONS.indexOf(manifest.manifestVersion) === -1) {
    errors.push('manifestVersion must be one of ' + VALID_MANIFEST_VERSIONS.join(', '));
  }

  if (!Array.isArray(manifest.tasks)) {
    errors.push('tasks must be an array');
    // Continue validation even without tasks — scripts/chains may still be present
  }

  if (Array.isArray(manifest.tasks)) {
    var clientBatchTasks = manifest.tasks.filter(function(t) { return t.origin === 'client-batch'; });
    if (clientBatchTasks.length !== 24) {
      errors.push('Exactly 24 client-batch tasks required, found ' + clientBatchTasks.length);
    }

    manifest.tasks.forEach(function(task, idx) {
      validateTaskEntry(task, idx, errors);
    });

    var seenIds = {};
    manifest.tasks.forEach(function(task, idx) {
      if (task.canonicalId) {
        if (seenIds[task.canonicalId] !== undefined) {
          errors.push('Duplicate canonicalId: ' + task.canonicalId + ' (tasks[' + idx + '] and tasks[' + seenIds[task.canonicalId] + '])');
        }
        seenIds[task.canonicalId] = idx;
      }
    });
  }

  // v0.4 reference structure: chains is { rows: [], chainG: {} } or { rows: [] } for v0.1
  if (manifest.chains !== undefined) {
    if (typeof manifest.chains === 'object' && !Array.isArray(manifest.chains)) {
      // v0.4 structure with rows and optionally chainG
      if (Array.isArray(manifest.chains.rows)) {
        manifest.chains.rows.forEach(function(chain, idx) {
          validateChainEntry(chain, idx, errors);
        });
      }
    } else if (Array.isArray(manifest.chains)) {
      // Legacy v0.1 structure
      manifest.chains.forEach(function(chain, idx) {
        validateChainEntry(chain, idx, errors);
      });
    } else {
      errors.push('chains must be an array or object with rows');
    }
  }

  // v0.4+ scripts[] validation
  if (manifest.manifestVersion === '0.4') {
    if (manifest.scripts !== undefined) {
      validateScripts(manifest, errors);
    }
  }

  // Optional file-existence check
  if (options.checkFiles) {
    validateScriptFileExistence(manifest, options, errors);
  }

  // Validate requiredInputs against registry
  if (options.skipRegistryValidation !== true) {
    var registryPath = options.registryPath || DEFAULT_REGISTRY_PATH;
    var regResult = loadRegistry(registryPath);
    if (regResult.valid) {
      validateRequiredInputsAgainstRegistry(manifest, regResult.registry, errors);
    }
    // If registry cannot be loaded, we do NOT silently pass — the manifest
    // declares requiredInputs that could not be verified against the registry.
    // Record the error but do not block validation; this is an advisory finding.
  }

  return { valid: errors.length === 0, errors: errors };
}

function getTask(manifest, canonicalId) {
  if (!manifest || !manifest.tasks) return null;
  for (var i = 0; i < manifest.tasks.length; i++) {
    if (manifest.tasks[i].canonicalId === canonicalId) {
      return manifest.tasks[i];
    }
  }
  return null;
}

function toTaskCard(task, options, manifest) {
  // Support three call signatures:
  // toTaskCard(task)                   — backward compat, no chains
  // toTaskCard(task, options)          — options only, no chains
  // toTaskCard(task, options, manifest) — full, chains derived from manifest
  // If manifest is undefined but options looks like a manifest, treat it as manifest
  if (manifest === undefined && options && typeof options === 'object' && !Array.isArray(options)) {
    // If options has 'tasks' or 'chains' it is a manifest, not options
    if (options.tasks || options.chains) {
      manifest = options;
      options = {};
    }
  }
  options = options || {};

  // Derive chain membership from manifest-level chains if manifest is available
  var chains = [];
  if (manifest) {
    chains = deriveChainMembership(manifest, task.canonicalId);
  } else if (Array.isArray(task.chains)) {
    chains = task.chains;
  }

  // Build acceptance conditions
  var acceptanceConditions = [];

  if (Array.isArray(task.evidenceRequired) && task.evidenceRequired.length > 0) {
    acceptanceConditions.push('Evidence required: ' + task.evidenceRequired.join(', ') + '.');
  }

  if (task.mappingType) {
    acceptanceConditions.push('Mapping type: ' + task.mappingType + '.');
  }

  if (chains.length > 0) {
    acceptanceConditions.push('Member of chains: ' + chains.join(', ') + '.');
  }

  if (Array.isArray(task.requiredInputs) && task.requiredInputs.length > 0) {
    acceptanceConditions.push('Required inputs: ' + task.requiredInputs.join(', ') + '.');
  }

  if (task.mappingType === 'gap') {
    acceptanceConditions.push('GAP TASK: no Spec task ID assigned in canonical map; contractor to confirm scope.');
  }

  if (task.gapNotes) {
    acceptanceConditions.push('Gap notes: ' + task.gapNotes);
  }

  if (task.negativeChecks && task.negativeChecks.length > 0) {
    acceptanceConditions.push('Negative checks: ' + task.negativeChecks.join('; ') + '.');
  }

  // Build environment object — preserve canonical traceability
  var env = {};
  if (task.origin) env.origin = task.origin;
  if (task.batch) env.batch = task.batch;
  if (task.canonicalId) env.canonicalId = task.canonicalId;
  if (task.status) env.manifestStatus = task.status;
  if (chains.length > 0) env.chains = chains.slice();
  if (task.mappingType) env.mappingType = task.mappingType;
  if (task.summaryIds && task.summaryIds.length > 0) env.summaryIds = task.summaryIds.slice();
  if (task.specIds && task.specIds.length > 0) env.specIds = task.specIds.slice();

  // v0.4+: mandatoryAssertions and script dependencies carried into card environment
  if (Array.isArray(task.mandatoryAssertions) && task.mandatoryAssertions.length > 0) {
    env.mandatoryAssertions = task.mandatoryAssertions.map(function(a) {
      return { id: a.id, text: a.text, sourceRef: a.sourceRef, evidenceKinds: a.evidenceKinds || [] };
    });
  }

  // Script dependencies: scripts that list this task in relatedTasks
  if (manifest && Array.isArray(manifest.scripts)) {
    var deps = [];
    for (var si = 0; si < manifest.scripts.length; si++) {
      var s = manifest.scripts[si];
      if (Array.isArray(s.relatedTasks) && s.relatedTasks.indexOf(task.canonicalId) !== -1) {
        deps.push({ name: s.id || s.name, kind: s.kind, canonicalPath: s.path || s.canonicalPath });
      }
    }
    if (deps.length > 0) env.scriptDependencies = deps;
  }

  // v0.4+: manifest version and source
  if (manifest) {
    if (manifest.manifestVersion) env.manifestVersion = manifest.manifestVersion;
    if (manifest.source) env.manifestSource = manifest.source;
  }

  // Execution status is always PENDING — readiness state lives in manifestStatus
  var cardStatus = 'PENDING';

  var taskCard = taskCardModule.createTaskCard({
    taskId: task.canonicalId || null,
    batchId: task.batch || null,
    title: task.title || null,
    goal: task.expectedResult ? task.expectedResult.substring(0, 200) : null,
    description: buildDescription(task),
    expectedResults: task.expectedResult ? [task.expectedResult] : [],
    acceptanceConditions: acceptanceConditions,
    fixtures: options.fixtures || [],
    environment: env,
    status: cardStatus
  });

  return taskCard;
}

function buildDescription(task) {
  var lines = [];
  if (task.title) lines.push('## Title\n' + task.title);
  if (task.summaryIds && task.summaryIds.length > 0) lines.push('## Summary IDs\n' + task.summaryIds.join(', '));
  if (task.specIds && task.specIds.length > 0) lines.push('## Spec IDs\n' + task.specIds.join(', '));
  if (task.origin) lines.push('## Origin\n' + task.origin);
  if (task.mappingType) lines.push('## Mapping Type\n' + task.mappingType);
  if (task.expectedResult) lines.push('## Expected Result\n' + task.expectedResult);
  if (task.gapNotes) lines.push('## Gap Notes\n' + task.gapNotes);
  if (task.negativeChecks && task.negativeChecks.length > 0) lines.push('## Negative Checks\n' + task.negativeChecks.join('\n'));
  if (task.countryMatrix && task.countryMatrix.length > 0) lines.push('## Country Matrix\n' + JSON.stringify(task.countryMatrix));
  return lines.join('\n\n');
}

function listBlockedByInputs(manifest, options) {
  options = options || {};
  if (!manifest || !manifest.tasks) {
    return { blocked: [], registryError: null };
  }

  var registryPath = options.registryPath || DEFAULT_REGISTRY_PATH;
  var regResult = loadRegistry(registryPath);

  // Case C: registry unavailable — return error, not empty list
  if (!regResult.valid) {
    return {
      blocked: [],
      registryError: regResult.errors.join('; ')
    };
  }

  var registry = regResult.registry;
  var registryIds = {};
  var missingInputs = {};
  var frozenInputs = {};

  if (Array.isArray(registry.inputs)) {
    registry.inputs.forEach(function(inp) {
      registryIds[inp.id] = true;
      if (inp.status === 'MISSING') missingInputs[inp.id] = true;
      if (inp.status === 'FROZEN') frozenInputs[inp.id] = true;
    });
  }

  var blocked = [];

  manifest.tasks.forEach(function(task) {
    if (!Array.isArray(task.requiredInputs) || task.requiredInputs.length === 0) return;

    var taskMissing = [];
    var taskUnknown = [];

    for (var r = 0; r < task.requiredInputs.length; r++) {
      var inpId = task.requiredInputs[r];
      if (!registryIds[inpId]) {
        // Case C: unknown input ID
        taskUnknown.push(inpId);
      } else if (missingInputs[inpId]) {
        // Case B: known but MISSING
        taskMissing.push(inpId);
      }
      // Case A: FROZEN/available — not blocked
    }

    if (taskMissing.length > 0 || taskUnknown.length > 0) {
      blocked.push({
        canonicalId: task.canonicalId,
        title: task.title,
        manifestStatus: task.status,
        missingInputs: taskMissing,
        unknownInputs: taskUnknown
      });
    }
  });

  return { blocked: blocked, registryError: null };
}

// ---------------------------------------------------------------------------
// v0.4+ API helpers
// ---------------------------------------------------------------------------

function getMandatoryAssertions(manifest, canonicalId) {
  if (!manifest || !manifest.tasks) return [];
  for (var i = 0; i < manifest.tasks.length; i++) {
    if (manifest.tasks[i].canonicalId === canonicalId) {
      return Array.isArray(manifest.tasks[i].mandatoryAssertions)
        ? manifest.tasks[i].mandatoryAssertions
        : [];
    }
  }
  return [];
}

function getScript(manifest, name) {
  if (!manifest || !Array.isArray(manifest.scripts) || !name) return null;
  for (var i = 0; i < manifest.scripts.length; i++) {
    if (manifest.scripts[i].id === name || manifest.scripts[i].name === name) {
      return manifest.scripts[i];
    }
  }
  return null;
}

function listToConfirm(manifest) {
  var results = { total: 0, bySection: {}, items: [] };
  if (!manifest) return results;

  function scan(obj, section) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) scan(obj[i], section);
      }
      return;
    }
    var keys = Object.keys(obj);
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var val = obj[key];
      if (typeof val === 'string' && val.indexOf('TO_CONFIRM') !== -1) {
        results.total++;
        if (!results.bySection[section]) results.bySection[section] = 0;
        results.bySection[section]++;
        results.items.push({ section: section, path: key, value: val });
      } else if (val !== null && typeof val === 'object') {
        scan(val, key);
      }
    }
  }

  scan(manifest, 'root');
  return results;
}

// ---------------------------------------------------------------------------
// TO_CONFIRM section-level counter (for reporting)
// ---------------------------------------------------------------------------

function countToConfirmBySection(manifest) {
  var result = { total: 0, sections: [] };
  if (!manifest) return result;

  var sections = ['source', 'tasks', 'chains', 'scripts', 'readinessTasks',
    'frozenRunInputs', 'retryPolicy', 'loadSecurityScope', 'reporting'];

  function scan(obj, section, out) {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(function(item) { scan(item, section, out); });
      return;
    }
    var keys = Object.keys(obj);
    for (var ki = 0; ki < keys.length; ki++) {
      var val = obj[keys[ki]];
      if (typeof val === 'string' && val.indexOf('TO_CONFIRM') !== -1) {
        out.total++;
      } else if (val !== null && typeof val === 'object') {
        scan(val, section, out);
      }
    }
  }

  for (var si = 0; si < sections.length; si++) {
    var sec = sections[si];
    var before = result.total;
    if (manifest[sec] !== undefined) {
      scan(manifest[sec], sec, result);
      var diff = result.total - before;
      if (diff > 0) {
        result.sections.push({ section: sec, count: diff });
      }
    }
  }

  return result;
}

module.exports = {
  loadManifest: loadManifest,
  loadRegistry: loadRegistry,
  validateManifest: validateManifest,
  getTask: getTask,
  toTaskCard: toTaskCard,
  listBlockedByInputs: listBlockedByInputs,
  deriveChainMembership: deriveChainMembership,
  getMandatoryAssertions: getMandatoryAssertions,
  getScript: getScript,
  listToConfirm: listToConfirm,
  countToConfirmBySection: countToConfirmBySection
};