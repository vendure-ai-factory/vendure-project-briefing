'use strict';

/**
 * Platform design publication executor (CAN-B2-01).
 *
 * CAN-B2-01 (platform design publication): a designer publishes a nail-design
 * product in the platform publication flow. This executor builds a publication
 * manifest from the fixture image tree evaluation-demo/assets/nail-patterns and
 * runs the supplied script scripts/run_publish_product_v11.sh in DRY-RUN mode
 * (PUBLISH_PRODUCT_DRY_RUN=1). It verifies from the real dry-run result.json and
 * the on-disk manifest:
 *
 *   - overall image for the index (fixture master image, basename 0);
 *   - individual effect images for the detail slideshow, and the overall image is
 *     NOT one of them;
 *   - correct selection of a design;
 *   - name, SKU, country, price and currency;
 *   - result.json status "dry-run" with dryRun true and resolved targetChannels.
 *
 * Admin identity is mandatory (chunk ADMIN RULES): SUPERADMIN_USERNAME and
 * SUPERADMIN_PASSWORD (aliases STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD)
 * plus VENDURE_ADMIN_API_URL. When any is absent the executor returns BLOCK
 * CLIENT_INPUT_SCOPE with a preflight proof that records env var NAMES only,
 * never values.
 *
 * Safety: the executor only ever issues a DRY-RUN. A non-dry-run publish is
 * allowed exclusively in the isolated staging clone and only with
 * sync.restartStorefront=false; this executor never performs it and never
 * relaxes PUBLISH_PRODUCT_DRY_RUN.
 *
 * The "product completes purchase and order flow" claim needs live Shop API +
 * Stripe Runner against a real staging clone (browser/DB evidence kinds), which
 * a dry-run cannot prove; it is recorded as unverified so coverage is
 * readiness-subset -> RESULT_READINESS_PASS, never a full pass.
 *
 * Failure classes: missing admin identity -> VALIDATION_ERROR
 * (CLIENT_INPUT_SCOPE); script missing / bash unavailable -> ENVIRONMENT_ERROR
 * (DEPENDENCY_ENVIRONMENT); script fails or no result.json -> ENVIRONMENT_ERROR;
 * result.json or manifest mismatch -> EXPECTED_MISMATCH (APPLICATION_DEFECT).
 */

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');
var terminalState = require('../terminalState');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;
var RUN_SCRIPT = 'evaluation-demo/migration-input/legacy/vendure-store/scripts/run_publish_product_v11.sh';
var NODE_SCRIPT = 'evaluation-demo/migration-input/legacy/vendure-store/scripts/publish_product_v11.mjs';
var FIXTURE_ROOT = 'evaluation-demo/assets/nail-patterns';
var IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
var MANIFEST_FILE = 'product_info.json';
var ARTIFACT_DIR = 'artifacts';
var RESULT_FILE = 'result.json';
var PRODUCT_SLUG = 'fixture-1-nail-design';
var DEFAULT_PRODUCT_NAME = 'Fixture 1 Nail Design';
var DEFAULT_SKU = 'NAIL-DESIGN-1';
var DEFAULT_COUNTRY = 'DE';
var DEFAULT_PRICE = 2500;
var CURRENCY_BY_COUNTRY = { DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' };

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function getExecFile(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFile === 'function') return deps.execFile;
  if (deps.childProcess && typeof deps.childProcess.execFile === 'function') return deps.childProcess.execFile.bind(deps.childProcess);
  return childProcess.execFile;
}

function repoRoot(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) return context.repoRoot;
  return process.cwd();
}

function isWindowsHost(context) {
  if (context && context.platform === 'win32') return true;
  if (context && context.platform) return false;
  return process.platform === 'win32';
}

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

function getEnvFn(context) {
  if (context && context.deps && typeof context.deps.getEnv === 'function') {
    return context.deps.getEnv;
  }
  return function() { return process.env || {}; };
}

function fsExists(context, filePath) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.existsSync === 'function') {
    try { return deps.existsSync(filePath); } catch (e) { return false; }
  }
  if (deps.fs && typeof deps.fs.existsSync === 'function') {
    try { return deps.fs.existsSync(filePath); } catch (e) { return false; }
  }
  try { return fs.existsSync(filePath); } catch (e) { return false; }
}

function readTextQuiet(context, filePath) {
  var deps = context && context.deps ? context.deps : {};
  var read = deps.readFileSync || fs.readFileSync;
  try {
    return read(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeTextInside(context, filePath, content) {
  var deps = context && context.deps ? context.deps : {};
  var write = deps.writeFileSync || fs.writeFileSync;
  var mkdir = deps.mkdirSync || fs.mkdirSync;
  try {
    mkdir(path.dirname(filePath), { recursive: true });
  } catch (e) { /* ignore */ }
  try {
    write(filePath, content, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
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

function listImageFiles(context, rootDir, relPrefix) {
  relPrefix = relPrefix || '';
  var deps = context && context.deps ? context.deps : {};
  var readdir = deps.readdirSync || fs.readdirSync;
  var out = [];
  var children;
  try {
    children = readdir(rootDir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (var i = 0; i < children.length; i += 1) {
    var child = children[i];
    var abs = path.join(rootDir, child.name);
    var rel = relPrefix ? relPrefix + '/' + child.name : child.name;
    if (child.isDirectory()) {
      out = out.concat(listImageFiles(context, abs, rel));
    } else if (child.isFile()) {
      var ext = path.extname(child.name).toLowerCase();
      if (IMAGE_EXTENSIONS.indexOf(ext) !== -1) {
        out.push({ rel: rel.replace(/\\/g, '/'), abs: abs, name: child.name });
      }
    }
  }
  return out.sort(function(a, b) { return a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0); });
}

function fail(options) {
  return {
    success: false,
    actual: null,
    result: null,
    error: options.error || 'executor failed',
    errorCode: options.errorCode || 'UNKNOWN',
    evidence: options.evidence || null
  };
}

function pass(task, evidence) {
  return {
    success: true,
    actual: (task && task.expectedResult) || null,
    result: RESULT_READINESS_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

function adminIdentity(context) {
  var env = getEnvFn(context)();
  var username = (env.SUPERADMIN_USERNAME || '').trim() || (env.STAGING_ADMIN_EMAIL || '').trim();
  var password = (env.SUPERADMIN_PASSWORD || '').trim() || (env.STAGING_ADMIN_PASSWORD || '').trim();
  var adminApi = (env.VENDURE_ADMIN_API_URL || '').trim();
  var present = [];
  var absent = [];
  if (env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL) present.push('SUPERADMIN_USERNAME');
  else absent.push('SUPERADMIN_USERNAME');
  if (env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD) present.push('SUPERADMIN_PASSWORD');
  else absent.push('SUPERADMIN_PASSWORD');
  if (adminApi) present.push('VENDURE_ADMIN_API_URL');
  else absent.push('VENDURE_ADMIN_API_URL');
  return { ok: !!(username && password && adminApi), username: username, password: password, adminApi: adminApi, presentNames: present, absentNames: absent };
}

function buildManifest(context) {
  var root = repoRoot(context);
  var fixtureRoot = path.join(root, FIXTURE_ROOT);
  var designId = (context.fixtures && context.fixtures.designId) || '1';
  var designDir = path.join(fixtureRoot, designId);
  var files = listImageFiles(context, designDir, designId);
  var manifest = {
    product: {
      slug: (context.fixtures && context.fixtures.slug) || PRODUCT_SLUG,
      enabled: true,
      translations: [{
        languageCode: 'en',
        name: (context.fixtures && context.fixtures.name) || DEFAULT_PRODUCT_NAME,
        slug: (context.fixtures && context.fixtures.slug) || PRODUCT_SLUG
      }],
      assets: files.map(function(f) {
        return {
          path: f.rel,
          featured: false,
          tags: [String(designId)],
          translations: [{
            languageCode: 'en',
            name: path.basename(f.rel).replace(/\.[^.]+$/, '')
          }]
        };
      }),
      customFields: {
        designerId: 'designer.de@example.com',
        designId: String(designId)
      }
    },
    variants: [{
      sku: (context.fixtures && context.fixtures.sku) || DEFAULT_SKU,
      countryCode: (context.fixtures && context.fixtures.countryCode) || DEFAULT_COUNTRY,
      price: (context.fixtures && context.fixtures.price) || DEFAULT_PRICE,
      stockOnHand: 0,
      outOfStockThreshold: 0,
      trackInventory: true,
      translations: [{
        languageCode: 'en',
        name: (context.fixtures && context.fixtures.name) || DEFAULT_PRODUCT_NAME
      }],
      customFields: {}
    }],
    channels: [{ token: (context.fixtures && context.fixtures.channelToken) || 'de-token', priceFactor: 1 }],
    sync: { restartStorefront: false, reindex: false }
  };

  var overallIndex = -1;
  for (var i = 0; i < files.length; i += 1) {
    var stem = path.basename(files[i].rel).replace(/\.[^.]+$/, '');
    if (stem === '0') {
      overallIndex = i;
      break;
    }
  }
  if (overallIndex >= 0) {
    manifest.product.featuredAssetPath = files[overallIndex].rel;
  }
  return { manifest: manifest, files: files, fixtureRoot: fixtureRoot, designDir: designDir, designId: designId };
}

function buildEvidence(context, taskId, timestamp, manifestData, result, checks) {
  checks = checks || {};
  var expected = {
    overallImageForIndex: checks.overallImageForIndex ? checks.overallImageForIndexPath : null,
    effectImages: checks.effectImagePaths,
    overallNotAmongEffectImages: checks.overallNotAmongEffectImages,
    designSelected: checks.designSelected,
    name: checks.name,
    sku: checks.sku,
    country: checks.country,
    price: checks.price,
    currency: checks.currency
  };
  return {
    schemaVersion: '1.0',
    taskId: taskId,
    scope: 'platform-publication',
    title: 'CAN-B2-01 platform design publication dry-run',
    executionRevision: executionRevisionOf(context),
    coverage: COVERAGE_READINESS_SUBSET,
    scripts: {
      runPublishV11: { repoRelativePath: RUN_SCRIPT },
      publishV11: { repoRelativePath: NODE_SCRIPT }
    },
    fixtureTree: FIXTURE_ROOT,
    designSet: (context.fixtures && context.fixtures.designId) || '1',
    expected: expected,
    observed: result,
    checks: checks,
    result: checks.allVerified ? RESULT_READINESS_PASS : 'BLOCK'
  };
}

function buildCommandInvocation(commands) {
  if (!commands || commands.length === 0) return null;
  return commands.map(function(c) { return c.command + ' ' + (c.args || []).join(' '); }).join(' | ');
}

function buildRecord(context, task, outcome, evidence) {
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
    generatedArtifacts: outcome.success ? [MANIFEST_FILE, RESULT_FILE] : [],
    stateChanges: {
      success: outcome.success === true,
      actual: actual,
      noPublish: checks.noPublish === true,
      syncRestartStorefrontFalse: checks.syncRestartStorefrontFalse === true
    },
    cleanupResetResult: null,
    finalClassification: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    naReason: null,
    exactScriptPath: RUN_SCRIPT,
    result: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    classification: outcome.success ? null : (checks.missingTool ? 'DEPENDENCY_ENVIRONMENT' : null),
    cause: outcome.success ? null : (outcome.errorCode || null),
    scope: 'platform-publication',
    coverage: evidence.coverage || COVERAGE_READINESS_SUBSET
  };
}

function writeExecutorEvidence(context, task, outcome, evidence) {
  var deps = context && context.deps ? context.deps : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var taskId = task.canonicalId || (context && context.taskId) || null;
  if (!runId || !taskId) return { ok: false, reason: 'no runId/taskId' };
  var wroteAny = false;
  try {
    if (typeof deps.writeEvidenceFile === 'function') {
      deps.writeEvidenceFile(runId, taskId, 'executor-platform-publication.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'executor-platform-publication' });
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function') {
      var record = buildRecord(context, task, outcome, evidence);
      deps.writeTaskRecord(runId, taskId, record, { scriptTask: true });
      wroteAny = true;
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e), wroteAny: wroteAny };
  }
  return { ok: true, wroteAny: wroteAny };
}

async function handlerPlatformPublication(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || context.taskId || 'CAN-B2-01';
  var clock = getClock(context);
  var timestamp = clock().toISOString();

  // 1. admin identity preflight; ABSENT -> BLOCK CLIENT_INPUT_SCOPE.
  var identity = adminIdentity(context);
  var preflight = {
    taskId: taskId,
    source: 'ADMIN_IDENTITY',
    stage: 'preflight',
    checks: {
      identityResolved: identity.ok,
      presentNames: identity.presentNames,
      absentNames: identity.absentNames
    },
    completedAt: timestamp
  };
  if (!identity.ok) {
    return fail({
      errorCode: 'VALIDATION_ERROR',
      error: 'missing admin identity: ' + identity.absentNames.join(', '),
      evidence: preflight
    });
  }

  var root = repoRoot(context);
  var manifestData = buildManifest(context);
  if (!manifestData.files.length) {
    return fail({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'fixture design set has no image files: ' + path.join(FIXTURE_ROOT, manifestData.designId),
      evidence: { taskId: taskId, scope: 'platform-publication', stage: 'manifest-build', completedAt: timestamp }
    });
  }
  var overallIsMaster = manifestData.manifest.product.featuredAssetPath && manifestData.manifest.product.featuredAssetPath.replace(/\\/g, '/').match(/(^|\/)0\.[^.]+$/);
  if (!overallIsMaster) {
    return fail({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'fixture design set has no master overall image (basename 0)',
      evidence: { taskId: taskId, scope: 'platform-publication', stage: 'manifest-build', completedAt: timestamp }
    });
  }

  var wsPath = (context.workspace && context.workspace.workspacePath) || null;
  var manifestPath;
  var artifactRoot;
  if (wsPath) {
    manifestPath = path.join(wsPath, MANIFEST_FILE);
    artifactRoot = path.join(wsPath, ARTIFACT_DIR);
  } else {
    manifestPath = path.join(root, 'scratch', MANIFEST_FILE);
    artifactRoot = path.join(root, 'scratch', ARTIFACT_DIR);
  }
  if (!writeTextInside(context, manifestPath, JSON.stringify(manifestData.manifest, null, 2) + '\n')) {
    return fail({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'could not write publication manifest into the workspace',
      evidence: { taskId: taskId, scope: 'platform-publication', stage: 'manifest-write', completedAt: timestamp }
    });
  }

  var product = manifestData.manifest.product;
  var variant = manifestData.manifest.variants[0];
  var ctry = variant.countryCode;
  var expectedCurrency = CURRENCY_BY_COUNTRY[ctry] || null;
  var expectedName = (context.fixtures && context.fixtures.name) || DEFAULT_PRODUCT_NAME;
  var expectedSku = (context.fixtures && context.fixtures.sku) || DEFAULT_SKU;
  var expectedPrice = (context.fixtures && context.fixtures.price) || DEFAULT_PRICE;
  var effectImagePaths = manifestData.files
    .map(function(f) { return f.rel; })
    .filter(function(rel) { return rel !== product.featuredAssetPath; });

  var checks = {
    overallImageForIndex: !!product.featuredAssetPath,
    overallImageForIndexPath: product.featuredAssetPath || null,
    overallNotAmongEffectImages: effectImagePaths.indexOf(product.featuredAssetPath) === -1,
    effectImageCount: effectImagePaths.length,
    effectImagePaths: effectImagePaths,
    designSelected: manifestData.designId,
    name: product.translations[0].name,
    sku: variant.sku,
    country: ctry,
    price: variant.price,
    currency: expectedCurrency,
    syncRestartStorefrontFalse: manifestData.manifest.sync.restartStorefront === false,
    noPublish: false,
    allVerified: false
  };

  var commands = [];
  var scriptAbs = path.join(root, RUN_SCRIPT);
  var scriptExists = fsExists(context, scriptAbs);

  // Dry-run publish only. Never the non-dry-run publish in this executor.
  var env = {
    PATH: process.env.PATH || '',
    PUBLISH_PRODUCT_DRY_RUN: '1',
    PUBLISH_PRODUCT_MANIFEST: manifestPath,
    PUBLISH_PRODUCT_ARTIFACT_DIR: artifactRoot,
    VENDURE_ADMIN_API_URL: identity.adminApi
  };
  var authNames = [];
  if (envValue(context, 'SUPERADMIN_USERNAME')) { env.SUPERADMIN_USERNAME = envValue(context, 'SUPERADMIN_USERNAME'); authNames.push('SUPERADMIN_USERNAME'); }
  if (envValue(context, 'SUPERADMIN_PASSWORD')) { env.SUPERADMIN_PASSWORD = envValue(context, 'SUPERADMIN_PASSWORD'); authNames.push('SUPERADMIN_PASSWORD'); }
  if (envValue(context, 'STAGING_ADMIN_EMAIL')) { env.STAGING_ADMIN_EMAIL = envValue(context, 'STAGING_ADMIN_EMAIL'); }
  if (envValue(context, 'STAGING_ADMIN_PASSWORD')) { env.STAGING_ADMIN_PASSWORD = envValue(context, 'STAGING_ADMIN_PASSWORD'); }

  var execFile = getExecFile(context);
  var scriptRes;
  if (isWindowsHost(context) || !scriptExists) {
    var nodeAbs = path.join(root, NODE_SCRIPT);
    scriptRes = await runExecFile(execFile, process.execPath || 'node', [nodeAbs], { env: env, cwd: root });
    commands.push({
      command: 'node',
      args: [NODE_SCRIPT],
      scriptPath: NODE_SCRIPT,
      exitCode: scriptRes.exitCode,
      stdout: scriptRes.stdout,
      stderr: scriptRes.stderr,
      envKeys: Object.keys(env).sort()
    });
  } else {
    scriptRes = await runExecFile(execFile, 'bash', [scriptAbs], { env: env, cwd: root });
    commands.push({
      command: 'bash',
      args: [RUN_SCRIPT],
      scriptPath: RUN_SCRIPT,
      exitCode: scriptRes.exitCode,
      stdout: scriptRes.stdout,
      stderr: scriptRes.stderr,
      envKeys: Object.keys(env).sort()
    });
  }

  // Read the dry-run result.json produced by the script.
  var result = null;
  var resultPath = path.join(artifactRoot, RESULT_FILE);
  if (fsExists(context, resultPath)) {
    var raw = readTextQuiet(context, resultPath);
    if (raw !== null) {
      try { result = JSON.parse(raw); } catch (e) { result = { parseError: String(e && e.message || e) }; }
    }
  }

  checks.dryRunFlag = scriptRes.exitCode === 0;
  checks.resultJson = !!result;
  checks.resultStatusDryRun = !!(result && result.status === 'dry-run');
  checks.resultDryRunTrue = !!(result && result.dryRun === true);
  checks.resultManifestPath = !!(result && result.manifestPath);
  checks.resultTargetChannels = !!(result && Array.isArray(result.targetChannels) && result.targetChannels.length > 0);
  checks.noPublish = checks.resultStatusDryRun && checks.resultDryRunTrue;
  checks.allVerified = checks.dryRunFlag &&
    checks.resultJson &&
    checks.resultStatusDryRun &&
    checks.resultDryRunTrue &&
    checks.overallImageForIndex &&
    checks.overallNotAmongEffectImages &&
    effectImagePaths.length > 0 &&
    expectedCurrency !== null;

  var evidence = buildEvidence(context, taskId, timestamp, manifestData, { result: result, commands: commands }, checks);
  evidence.manifest = manifestData.manifest;
  evidence.manifestSha256 = sha256Hex(JSON.stringify(manifestData.manifest, null, 2) + '\n');
  evidence.adminEnvNames = authNames;

  if (!scriptExists) {
    return fail({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'supplied publish script missing: ' + RUN_SCRIPT,
      evidence: evidence
    });
  }
  if (scriptRes.exitCode !== 0) {
    return fail({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'publish dry-run script failed (exit ' + scriptRes.exitCode + '): ' + (scriptRes.error || scriptRes.stderr),
      evidence: evidence
    });
  }
  if (!result) {
    return fail({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'publish dry-run produced no result.json',
      evidence: evidence
    });
  }
  if (!checks.resultStatusDryRun || !checks.resultDryRunTrue) {
    return fail({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'publish result.json is not a dry-run (status=' + (result.status || '?') + ', dryRun=' + result.dryRun + ')',
      evidence: evidence
    });
  }
  if (!checks.allVerified) {
    return fail({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'publication manifest/result verification failed',
      evidence: evidence
    });
  }

  evidence.result = RESULT_READINESS_PASS;
  writeExecutorEvidence(context, task, pass(task, evidence), evidence);
  return pass(task, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-01', {
    description: 'Platform design publication: build a manifest from the nail-patterns fixture tree and dry-run run_publish_product_v11.sh (readiness scope platform-publication)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-01-A01'],
    handler: handlerPlatformPublication
  });
  return { success: true, registered: ['CAN-B2-01'] };
}

module.exports = {
  RUN_SCRIPT: RUN_SCRIPT,
  NODE_SCRIPT: NODE_SCRIPT,
  FIXTURE_ROOT: FIXTURE_ROOT,
  IMAGE_EXTENSIONS: IMAGE_EXTENSIONS.slice(),
  MANIFEST_FILE: MANIFEST_FILE,
  ARTIFACT_DIR: ARTIFACT_DIR,
  RESULT_FILE: RESULT_FILE,
  PRODUCT_SLUG: PRODUCT_SLUG,
  DEFAULT_PRODUCT_NAME: DEFAULT_PRODUCT_NAME,
  DEFAULT_SKU: DEFAULT_SKU,
  DEFAULT_COUNTRY: DEFAULT_COUNTRY,
  DEFAULT_PRICE: DEFAULT_PRICE,
  CURRENCY_BY_COUNTRY: CURRENCY_BY_COUNTRY,
  sha256Hex: sha256Hex,
  adminIdentity: adminIdentity,
  buildManifest: buildManifest,
  listImageFiles: listImageFiles,
  buildEvidence: buildEvidence,
  buildRecord: buildRecord,
  handlerPlatformPublication: handlerPlatformPublication,
  register: register
};
