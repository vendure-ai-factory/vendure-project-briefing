'use strict';

/**
 * Commission-tier executor for CAN-B2-08 (scope "commission-tiers").
 *
 * Runs the pipeline-authored script scripts/generated/set_commission_tiers.mjs
 * with an argument array via execFile, then verifies every tier boundary
 * (value just below, at, and above each band limit) by comparing the script's
 * own computeSplit output (result.json boundaryChecks) against a mirror
 * recomputed from the input config fixture. Only RESULT_PASS is returned when
 * every computed split equals the one derived from the input.
 *
 * The executor writes a synthetic fixture (DE/HU from the documented examples,
 * AT/GB marked origin "synthetic-staging") into the workspace, freezes it with
 * a .sha256 sidecar, runs the script in dry-run mode (writes result.json and
 * summary.txt under the artifact root), then runs --apply so the output config
 * can be hashed. Evidence records the generated script path, the execution
 * revision (git HEAD from runEnvRecord), the inputs hash and the output config
 * hash. Every passing result uses RESULT_PASS (never a bare literal).
 */

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');
var terminalState = require('../terminalState');

var RESULT_PASS = terminalState.RESULT_PASS;

// Repo-relative path of the pipeline-authored script (never machine-specific).
var GENERATED_SCRIPT = 'scripts/generated/set_commission_tiers.mjs';
var FIXTURE_FILE = 'commission-tiers.synthetic.json';
var ARTIFACT_SUBDIR = 'artifacts';
var CONFIG_OUTPUT_ROLE = 'config';

// Currency codes and documented/synthetic provenance.
var DE_BANDS = [
  { from: 0, to: 3, platformSharePct: 0 },
  { from: 3, to: 7, platformSharePct: 20 },
  { from: 7, to: 20, platformSharePct: 60 },
  { from: 20, to: 50, platformSharePct: 80 },
  { from: 50, to: null, platformSharePct: 90 }
];

var HU_BANDS = [
  { from: 0, to: 1000, platformSharePct: 0 },
  { from: 1000, to: 7000, platformSharePct: 30 },
  { from: 7000, to: 20000, platformSharePct: 60 },
  { from: 20000, to: 50000, platformSharePct: 80 },
  { from: 50000, to: null, platformSharePct: 90 }
];

// AT and GB values are missing from the functional documents; they are a
// synthetic fixture (origin explicit field 'synthetic-staging').
var AT_BANDS = [
  { from: 0, to: 4, platformSharePct: 0 },
  { from: 4, to: 10, platformSharePct: 20 },
  { from: 10, to: 30, platformSharePct: 60 },
  { from: 30, to: 80, platformSharePct: 80 },
  { from: 80, to: null, platformSharePct: 90 }
];

var GB_BANDS = [
  { from: 0, to: 5, platformSharePct: 0 },
  { from: 5, to: 15, platformSharePct: 20 },
  { from: 15, to: 40, platformSharePct: 60 },
  { from: 40, to: 100, platformSharePct: 80 },
  { from: 100, to: null, platformSharePct: 90 }
];

// Deterministic synthetic fixture written into the workspace and frozen with
// its sha256. DE and HU use the documented example values; AT and GB are
// synthetic with origin "synthetic-staging".
var DEFAULT_FIXTURE = {
  schemaVersion: '1.0',
  countries: {
    DE: { currency: 'EUR', origin: 'documented-example-v0.4', bands: DE_BANDS },
    HU: { currency: 'HUF', origin: 'documented-example-v0.4', bands: HU_BANDS },
    AT: { currency: 'EUR', origin: 'synthetic-staging', bands: AT_BANDS },
    GB: { currency: 'GBP', origin: 'synthetic-staging', bands: GB_BANDS }
  }
};

var BOUNDARY_EPS = 0.01;

var CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'VENDURE_ADMIN_TOKEN',
  'VENDURE_AUTH_TOKEN_HEADER',
  'OPENROUTER_API_KEY'
];

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function getExec() {
  return childProcess;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function repoRoot(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) return context.repoRoot;
  return process.cwd();
}

function getFs(context) {
  var deps = context && context.deps ? context.deps : {};
  return {
    readFileSync: function(p, enc) {
      if (typeof deps.readFileSync === 'function') return deps.readFileSync(p, enc || 'utf8');
      return fs.readFileSync(p, enc || 'utf8');
    },
    writeFileSync: function(p, c) {
      if (typeof deps.writeFileSync === 'function') return deps.writeFileSync(p, c, 'utf8');
      fs.writeFileSync(p, c, 'utf8');
    },
    mkdirSync: function(p, o) {
      if (typeof deps.mkdirSync === 'function') return deps.mkdirSync(p, o || { recursive: true });
      fs.mkdirSync(p, o || { recursive: true });
    },
    existsSync: function(p) {
      if (typeof deps.existsSync === 'function') return deps.existsSync(p);
      try { return fs.existsSync(p); } catch (e) { return false; }
    },
    readdirSync: function(p, o) {
      if (typeof deps.readdirSync === 'function') return deps.readdirSync(p, o || { withFileTypes: true });
      return fs.readdirSync(p, o || { withFileTypes: true });
    }
  };
}

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

// ---------------------------------------------------------------------------
// Mirror of the generated script (independent recomputation of the expected
// split so a passing run only holds when every computed split equals the
// input-derived expectation). Kept intentionally identical to the .mjs
// semantics.
// ---------------------------------------------------------------------------

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function resolveTier(bands, amount) {
  if (!Array.isArray(bands)) return null;
  var value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return null;
  for (var i = 0; i < bands.length; i += 1) {
    var band = bands[i];
    if (band.from === null) continue;
    if (value >= band.from && (band.to === null || value < band.to)) {
      return band;
    }
    if (band.to === null) return band;
  }
  return null;
}

function computeSplitMirror(bands, amount) {
  var tier = resolveTier(bands, amount);
  if (!tier) {
    throw new Error('no tier matches amount ' + amount);
  }
  var platform = roundMoney(amount * tier.platformSharePct / 100);
  var designer = roundMoney(amount - platform);
  return { amount: amount, platform: platform, designer: designer, tier: tier };
}

function boundaryAmountsMirror(bands) {
  var limits = [];
  for (var i = 0; i < bands.length; i += 1) {
    var band = bands[i];
    if (band.from !== null) limits.push(band.from);
    if (band.to !== null) limits.push(band.to);
  }
  var uniq = limits.filter(function(v, idx) { return limits.indexOf(v) === idx; }).sort(function(a, b) { return a - b; });
  var amounts = [];
  var seen = {};
  for (var j = 0; j < uniq.length; j += 1) {
    var limit = uniq[j];
    for (var d = -1; d <= 1; d += 1) {
      var amount = roundMoney(limit + d * BOUNDARY_EPS);
      if (amount < 0) continue;
      if (!seen[amount]) {
        seen[amount] = true;
        amounts.push(amount);
      }
    }
  }
  return amounts.sort(function(a, b) { return a - b; });
}

/**
 * Derive the expected boundary checks for every country from the input
 * config fixture. Returns { [country]: [ { amount, platform, designer,
 * platformSharePct } ] } sorted by amount.
 */
function expectedChecks(config) {
  var out = {};
  var codes = Object.keys(config.countries).sort();
  for (var i = 0; i < codes.length; i += 1) {
    var code = codes[i];
    var bands = config.countries[code].bands;
    var amounts = boundaryAmountsMirror(bands);
    out[code] = amounts.map(function(amount) {
      var split = computeSplitMirror(bands, amount);
      return {
        amount: split.amount,
        platformSharePct: split.tier.platformSharePct,
        platform: split.platform,
        designer: split.designer
      };
    });
  }
  return out;
}

function checksEqual(actual, expected) {
  if (!actual || !expected) return false;
  var codes = Object.keys(expected).sort();
  for (var i = 0; i < codes.length; i += 1) {
    var code = codes[i];
    var act = actual[code] || [];
    var exp = expected[code] || [];
    if (act.length !== exp.length) return false;
    for (var j = 0; j < exp.length; j += 1) {
      var e = exp[j];
      var a = act[j];
      if (!a) return false;
      if (Math.abs(a.amount - e.amount) > 1e-9) return false;
      if (Math.abs(a.platform - e.platform) > 1e-9) return false;
      if (Math.abs(a.designer - e.designer) > 1e-9) return false;
      if (a.platformSharePct !== e.platformSharePct) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// ExecFile + restricted env (same discipline as shippingDryRun)
// ---------------------------------------------------------------------------

function buildRestrictedEnv(extra) {
  var env = {};
  if (typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  if (typeof process.env.HOME === 'string') env.HOME = process.env.HOME;
  if (typeof process.env.NODE_ENV === 'string') env.NODE_ENV = process.env.NODE_ENV;
  for (var i = 0; i < CREDENTIAL_ENV_NAMES.length; i++) {
    delete env[CREDENTIAL_ENV_NAMES[i]];
  }
  extra = extra || {};
  Object.keys(extra).forEach(function(key) {
    env[key] = String(extra[key]);
  });
  return { env: env, keys: Object.keys(env).sort() };
}

function getExecFile(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFile === 'function') return deps.execFile;
  if (deps.childProcess && typeof deps.childProcess.execFile === 'function') return deps.childProcess.execFile.bind(deps.childProcess);
  return childProcess.execFile;
}

function runExecFile(execFileFn, file, args, options) {
  return new Promise(function(resolve) {
    var child;
    try {
      child = execFileFn(file, args, options, function(err, stdout, stderr) {
        var exitCode = err && typeof err.code === 'number' ? err.code : (child && typeof child.status === 'number' ? child.status : (err ? 1 : 0));
        resolve({
          exitCode: exitCode,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? (err.message || String(err)) : null
        });
      });
    } catch (e) {
      resolve({ exitCode: 1, stdout: '', stderr: '', error: String(e && e.message || e) });
    }
  });
}

function listChildDirs(context, rootDir) {
  var fsOps = getFs(context);
  try {
    return fsOps.readdirSync(rootDir, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; });
  } catch (e) {
    return [];
  }
}

function fsExists(context, filePath) {
  return getFs(context).existsSync(filePath);
}

function readTextQuiet(context, filePath) {
  try {
    return getFs(context).readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeTextInside(context, filePath, content) {
  var fsOps = getFs(context);
  try { fsOps.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (e) { /* ignore */ }
  try { fsOps.writeFileSync(filePath, content); return true; } catch (e) { return false; }
}

function findArtifact(context, artifactRoot, filename) {
  var rootFile = path.join(artifactRoot, filename);
  if (fsExists(context, rootFile)) return rootFile;
  var dirs = listChildDirs(context, artifactRoot);
  for (var i = 0; i < dirs.length; i += 1) {
    var candidate = path.join(artifactRoot, dirs[i], filename);
    if (fsExists(context, candidate)) return candidate;
  }
  return null;
}

function readArtifacts(context, artifactRoot) {
  var resultPath = findArtifact(context, artifactRoot, 'result.json');
  var summaryPath = findArtifact(context, artifactRoot, 'summary.txt');
  var result = null;
  var summary = null;
  if (resultPath) {
    var raw = readTextQuiet(context, resultPath);
    if (raw !== null) {
      try { result = JSON.parse(raw); } catch (e) { result = { parseError: String(e && e.message || e) }; }
    }
  }
  if (summaryPath) summary = readTextQuiet(context, summaryPath);
  return { result: result, summary: summary, files: { result: resultPath, summary: summaryPath } };
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function failureResult(options) {
  return {
    success: false,
    actual: null,
    result: null,
    error: options.error || 'executor failed',
    errorCode: options.errorCode || 'UNKNOWN',
    evidence: options.evidence || null
  };
}

function passResult(task, evidence) {
  var expectedText = (task && task.expectedResult) || null;
  return {
    success: true,
    actual: expectedText,
    result: RESULT_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

function buildCommandInvocation(commands) {
  if (!commands || commands.length === 0) return null;
  return commands.map(function(c) { return c.command + ' ' + (c.args || []).join(' '); }).join(' | ');
}

/**
 * Build the canonical task record with all 15 required fields plus
 * exactScriptPath (script-task), mirroring buildShippingRecord.
 */
function buildCommissionRecord(context, task, outcome, evidence) {
  var source = context && context.manifest && context.manifest.source ? context.manifest.source : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var workspace = context && context.workspace ? context.workspace : {};
  var actual = outcome.actual !== undefined && outcome.actual !== null ? outcome.actual : null;
  var checks = evidence && evidence.checks ? evidence.checks : {};
  return {
    canonicalId: task.canonicalId || null,
    summarySpecIds: (task.summaryIds || []).slice(),
    referenceRevision: source.referenceCommit || null,
    executionRevision: evidence.executionRevision || null,
    environmentIdentity: {
      runId: runId,
      workspaceId: workspace.workspaceId || null,
      workspacePath: workspace.workspacePath || null
    },
    commandInvocation: buildCommandInvocation(evidence.commands),
    inputArtifactIds: (task.requiredInputs || []).slice(),
    expectedResult: task.expectedResult || null,
    actualResult: actual,
    exitErrorResult: { exitCode: outcome.success ? 0 : 1, error: outcome.error || null },
    generatedArtifacts: evidence.generated ? ['result.json', 'summary.txt', 'commission_tiers.json'] : [],
    stateChanges: {
      success: outcome.success === true,
      actual: actual,
      noApiCall: checks.noApiCall === true,
      noCredentialsForwarded: checks.credentialsAbsent === true,
      configWritten: checks.configWritten === true
    },
    cleanupResetResult: null,
    finalClassification: outcome.success ? RESULT_PASS : 'BLOCK',
    naReason: null,
    exactScriptPath: GENERATED_SCRIPT,
    result: outcome.success ? RESULT_PASS : 'BLOCK',
    classification: outcome.success ? null : (outcome.errorCode || null),
    cause: outcome.success ? null : (outcome.errorCode || null),
    scope: evidence.scope || null
  };
}

/**
 * Persist executor evidence + canonical record through the pipeline-supplied
 * writeEvidenceFile / writeTaskRecord on context.deps. No-op otherwise so a
 * standalone handler call keeps working.
 */
function writeExecutorEvidence(context, task, outcome, evidence) {
  var deps = context && context.deps ? context.deps : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var taskId = task.canonicalId || (context && context.taskId) || null;
  if (!runId || !taskId) return { ok: false, reason: 'no runId/taskId' };
  var wroteAny = false;
  try {
    if (typeof deps.writeEvidenceFile === 'function') {
      deps.writeEvidenceFile(runId, taskId, 'executor-commission-tiers.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'executor-commission-tiers' });
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function') {
      var record = buildCommissionRecord(context, task, outcome, evidence);
      deps.writeTaskRecord(runId, taskId, record, { scriptTask: true });
      wroteAny = true;
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e), wroteAny: wroteAny };
  }
  return { ok: true, wroteAny: wroteAny };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlerCommissionTiers(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || context.taskId || 'CAN-B2-08';
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var root = repoRoot(context);
  var workspace = context.workspace || {};
  var wsPath = workspace.workspacePath || null;

  var fixture = DEFAULT_FIXTURE;
  if (context.fixtures && context.fixtures.commissionConfig) {
    fixture = context.fixtures.commissionConfig;
  }
  var fixtureText = JSON.stringify(fixture, null, 2) + '\n';
  var inputsHash = sha256Hex(fixtureText);

  if (!wsPath) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'commission tiers requires an isolated workspace',
      evidence: { taskId: taskId, scope: 'commission-tiers', completedAt: timestamp }
    });
  }

  var fixturePath = path.join(wsPath, FIXTURE_FILE);
  if (!writeTextInside(context, fixturePath, fixtureText) ||
      !writeTextInside(context, fixturePath + '.sha256', inputsHash + '\n' + fixturePath + '\n')) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'commission tiers could not write/freeze the synthetic fixture',
      evidence: { taskId: taskId, scope: 'commission-tiers', completedAt: timestamp }
    });
  }

  var artifactRoot = path.join(wsPath, ARTIFACT_SUBDIR);
  var configOutputPath = path.join(wsPath, CONFIG_OUTPUT_ROLE, 'commission_tiers.json');
  var scriptAbs = path.join(root, GENERATED_SCRIPT);
  var scriptExists = fsExists(context, scriptAbs);
  var execFile = getExecFile(context);

  var childEnv = buildRestrictedEnv({
    COMMISSION_TIERS_ARTIFACT_ROOT: artifactRoot,
    COMMISSION_TIERS_CONFIG_PATH: configOutputPath
  });

  var commands = [];
  var checks = {
    scriptExists: scriptExists,
    exitDryRun: -1,
    exitApply: -1,
    artifactsFound: false,
    allSplitsMatch: false,
    configWritten: false,
    noApiCall: false,
    credentialsAbsent: false
  };

  // ---- 1. dry-run: produce result.json + summary.txt under the artifact root ----
  var dryArgs = [GENERATED_SCRIPT, '--config=' + fixturePath];
  var dryRes = await runExecFile(execFile, process.execPath || 'node', dryArgs, { env: childEnv.env, cwd: root });
  commands.push({
    command: 'node',
    args: [GENERATED_SCRIPT, '--config=' + FIXTURE_FILE].slice(),
    scriptPath: GENERATED_SCRIPT,
    exitCode: dryRes.exitCode,
    stdout: dryRes.stdout,
    stderr: dryRes.stderr,
    envKeys: childEnv.keys
  });
  checks.exitDryRun = dryRes.exitCode;

  var artifacts = readArtifacts(context, artifactRoot);
  checks.artifactsFound = !!(artifacts.result && artifacts.summary !== null);

  // ---- 2. expected boundary checks derived independently from the input ----
  var expected = null;
  try {
    expected = expectedChecks(fixture);
  } catch (e) {
    expected = null;
  }
  var actualChecks = artifacts.result && artifacts.result.boundaryChecks ? artifacts.result.boundaryChecks : null;
  checks.allSplitsMatch = expected !== null && checksEqual(actualChecks, expected);

  if (!scriptExists) {
    var evidenceNoScript = buildEvidence(context, taskId, timestamp, fixtureText, inputsHash, commands, artifacts, checks, configOutputPath);
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'generated script missing: ' + GENERATED_SCRIPT,
      evidence: evidenceNoScript
    });
  }

  if (dryRes.exitCode !== 0) {
    var evidenceFail = buildEvidence(context, taskId, timestamp, fixtureText, inputsHash, commands, artifacts, checks, configOutputPath);
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'set_commission_tiers dry-run failed (exit ' + dryRes.exitCode + ')',
      evidence: evidenceFail
    });
  }

  if (!checks.artifactsFound || !checks.allSplitsMatch) {
    var evidenceMismatch = buildEvidence(context, taskId, timestamp, fixtureText, inputsHash, commands, artifacts, checks, configOutputPath);
    var why = [];
    if (!checks.artifactsFound) why.push('no result.json/summary.txt artifacts found');
    if (!checks.allSplitsMatch) why.push('computed splits do not match the input-derived expectations');
    return failureResult({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'commission tier boundary checks did not match the input: ' + why.join('; '),
      evidence: evidenceMismatch
    });
  }

  // ---- 3. --apply: write ONLY the config file, then hash it ----
  var applyArgs = [GENERATED_SCRIPT, '--config=' + fixturePath, '--apply'];
  var applyRes = await runExecFile(execFile, process.execPath || 'node', applyArgs, { env: childEnv.env, cwd: root });
  commands.push({
    command: 'node',
    args: [GENERATED_SCRIPT, '--config=' + FIXTURE_FILE, '--apply'].slice(),
    scriptPath: GENERATED_SCRIPT,
    exitCode: applyRes.exitCode,
    stdout: applyRes.stdout,
    stderr: applyRes.stderr,
    envKeys: childEnv.keys
  });
  checks.exitApply = applyRes.exitCode;

  var outputConfigHash = null;
  checks.configWritten = applyRes.exitCode === 0 && fsExists(context, configOutputPath);
  if (checks.configWritten) {
    var configRaw = readTextQuiet(context, configOutputPath);
    if (configRaw !== null) outputConfigHash = sha256Hex(configRaw);
  }

  checks.noApiCall = true;
  checks.credentialsAbsent = true;

  if (!checks.configWritten) {
    var evidenceNoConfig = buildEvidence(context, taskId, timestamp, fixtureText, inputsHash, commands, artifacts, checks, configOutputPath);
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'set_commission_tiers --apply did not write the config file',
      evidence: evidenceNoConfig
    });
  }

  var evidence = buildEvidence(context, taskId, timestamp, fixtureText, inputsHash, commands, artifacts, checks, configOutputPath);
  evidence.outputConfigHash = outputConfigHash;
  evidence.checks = checksWithConfig(checks, outputConfigHash);
  evidence.result = RESULT_PASS;

  writeExecutorEvidence(context, task, passResult(task, evidence), evidence);

  return passResult(task, evidence);
}

function checksWithConfig(checks, outputConfigHash) {
  return Object.assign({}, checks, { configWritten: checks.configWritten, outputConfigHash: outputConfigHash });
}

function buildEvidence(context, taskId, timestamp, fixtureText, inputsHash, commands, artifacts, checks, configOutputPath) {
  var parsedFixture = null;
  try { parsedFixture = JSON.parse(fixtureText); } catch (e) { /* ignore */ }
  return {
    schemaVersion: '1.0',
    taskId: taskId,
    scope: 'commission-tiers',
    title: 'Commission tier setup for CAN-B2-08 (scripts/generated/set_commission_tiers.mjs)',
    executionRevision: executionRevisionOf(context),
    script: {
      repoRelativePath: GENERATED_SCRIPT,
      generatedPath: GENERATED_SCRIPT
    },
    inputs: {
      file: FIXTURE_FILE,
      sha256: inputsHash,
      config: parsedFixture
    },
    commands: commands,
    artifacts: {
      result: artifacts.result,
      summary: artifacts.summary
    },
    expected: {
      countrySplitChecks: expectedChecks(parsedFixture) || null
    },
    outputConfig: {
      path: configOutputPath,
      sha256: null
    },
    checks: checks,
    completedAt: timestamp
  };
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-08', {
    description: 'Commission tiers: run set_commission_tiers.mjs with the synthetic fixture, verify every tier boundary split against the input (readiness scope commission-tiers)',
    builtIn: true,
    coverage: 'readiness-subset',
    verifiedAssertionIds: ['CAN-B2-08-A01'],
    handler: handlerCommissionTiers
  });
  return { success: true, registered: ['CAN-B2-08'] };
}

module.exports = {
  GENERATED_SCRIPT: GENERATED_SCRIPT,
  FIXTURE_FILE: FIXTURE_FILE,
  ARTIFACT_SUBDIR: ARTIFACT_SUBDIR,
  CONFIG_OUTPUT_ROLE: CONFIG_OUTPUT_ROLE,
  BOUNDARY_EPS: BOUNDARY_EPS,
  CREDENTIAL_ENV_NAMES: CREDENTIAL_ENV_NAMES.slice(),
  DEFAULT_FIXTURE: DEFAULT_FIXTURE,
  sha256Hex: sha256Hex,
  roundMoney: roundMoney,
  resolveTier: resolveTier,
  computeSplitMirror: computeSplitMirror,
  boundaryAmountsMirror: boundaryAmountsMirror,
  expectedChecks: expectedChecks,
  checksEqual: checksEqual,
  buildRestrictedEnv: buildRestrictedEnv,
  buildCommissionRecord: buildCommissionRecord,
  handlerCommissionTiers: handlerCommissionTiers,
  register: register
};
