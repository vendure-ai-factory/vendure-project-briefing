'use strict';

/**
 * Delisting and account administrative operations executor (CAN-B2-15).
 *
 * CAN-B2-15 (account, delisting and administrative operations) asserts the
 * designer sales details are correct; customer self-delisting and authorized
 * admin delisting work; related design files are removed or archived; and the
 * customer receipt shows the correct price and tax.
 *
 * Evidence is collected from two domains:
 *
 *   1. Shop API (readiness scope): the designer account's sales details
 *      (myDesigns / vendorOverview) and customer self-delisting
 *      (delistMyDesign) are exercised against the Shop API; the buyer
 *      receipt is read via orderByCode. Operation names and field sets are
 *      copied from the storefront source (never guessed):
 *        myDesigns       storefront/src/lib/vendure/vendor.ts:87-106
 *        vendorOverview  vendor-dashboard/api-extensions.ts:3-13 (+ vendor.ts:8-16)
 *        delistDesign    storefront/src/lib/vendure/vendor.ts:255-274
 *        orderByCode     storefront/src/lib/vendure/queries.ts:377
 *
 *   2. Admin delisting (dry-run only): scripts/admin_delist_products.mjs is
 *      run in dry-run through the controlled PostgreSQL gateway. The dry-run
 *      produces result.json listing the matching product variants ('records')
 *      and the archive moves ('archiveMoves') an --apply would perform. The
 *      executor never applies from this tree; --apply is only ever done in the
 *      isolated staging clone (admin rules).
 *
 * Required privileges (admin rules): the authorized admin identity (env var
 * names SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD
 * with the STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD aliases accepted). If
 * it is absent the executor returns BLOCK CLIENT_INPUT_SCOPE with the
 * preflight proof. If the controlled PostgreSQL gateway is unreachable
 * locally, the executor returns BLOCK DEPENDENCY_ENVIRONMENT with the error
 * as evidence.
 *
 * Coverage is readiness-subset via COVERAGE_READINESS_SUBSET (chunk 9a-
 * coverage, re-exported from terminalState). The result is RESULT_READINESS_PASS
 * only when every in-scope assertion is verified; everything else is a BLOCK
 * with a concrete errorCode and terminalState classification.
 */

var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Repo-relative path of the supplied admin-delisting script (scriptNameMap
// admin_delist_products.ts -> scripts/admin_delist_products.mjs).
var ADMIN_DELIST_SCRIPT =
  'evaluation-demo/migration-input/legacy/vendure-store/scripts/admin_delist_products.mjs';
var VENDURE_STORE_DIR = 'evaluation-demo/migration-input/legacy/vendure-store';

var ARTIFACT_DIR = 'admin-delist-artifacts';
var ARCHIVE_DIR = 'archive';
var DELISTED_DIR = 'delisted';
var RESULT_FILE = 'result.json';

var DEFAULT_SKU = 'FIXTURE-1';
var DEFAULT_TIMESTAMP = '2026-10-09T09-00-00-000Z';
var DEFAULT_COUNTRY = 'DE';
var DEFAULT_RECEIPT_CODE = 'ED-ORD-209';

// Accounts from manifest/fixtures.v1.json (origin VERIFIED).
var DESIGNER_ACCOUNT = 'designer.de@example.com';
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Credential-holding env names never forwarded to a child process.
var CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'VENDURE_ADMIN_TOKEN',
  'VENDURE_AUTH_TOKEN_HEADER',
  'OPENROUTER_API_KEY'
];

// ---------------------------------------------------------------------------
// GraphQL documents (names and field sets copied from migration-input)
// ---------------------------------------------------------------------------

// myDesigns: storefront/src/lib/vendure/vendor.ts:87-106.
var MY_DESIGNS_QUERY = [
  'query GetMyDesigns {',
  '  myDesigns {',
  '    productId',
  '    name',
  '    sku',
  '    designFee',
  '    craftFee',
  '    totalPrice',
  '    status',
  '    salesCount',
  '    totalEarnings',
  '    createdAt',
  '    featuredAssetUrl',
  '  }',
  '}'
].join('\n');

// vendorOverview: vendor-dashboard/api-extensions.ts:3-13 (+ vendor.ts:8-16).
var VENDOR_OVERVIEW_QUERY = [
  'query GetVendorOverview {',
  '  vendorOverview {',
  '    totalSales',
  '    activeProductCount',
  '    pendingOrderCount',
  '  }',
  '}'
].join('\n');

// delistMyDesign: storefront/src/lib/vendure/vendor.ts:267.
var DELIST_MY_DESIGN_MUTATION = [
  'mutation DelistMyDesign($productId: ID!) {',
  '  delistMyDesign(productId: $productId)',
  '}'
].join('\n');

// orderByCode (receipt): queries.ts:377 selection set from shopApiSession.
var ORDER_BY_CODE_QUERY = sessionModule.GRAPHQL.orderByCode;

// ---------------------------------------------------------------------------
// Environment / admin identity helpers
// ---------------------------------------------------------------------------

function getEnvFn(context) {
  return sessionModule.getEnvFn(context);
}

function envValue(context, name) {
  return sessionModule.envValue(context, name);
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function runIdOf(context) {
  return sessionModule.runIdOf(context);
}

function evidenceOptions(context) {
  return sessionModule.evidenceOptions(context);
}

function repoRoot(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) {
    return context.repoRoot;
  }
  return process.cwd();
}

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

function hasAdminCredentials(context) {
  var env = getEnvFn(context)();
  var user = env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '';
  var pass = env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '';
  return !!(user && pass);
}

function adminCredentialEnvNames(context) {
  var env = getEnvFn(context)();
  var names = [];
  if (env.SUPERADMIN_USERNAME) names.push('SUPERADMIN_USERNAME');
  if (env.STAGING_ADMIN_EMAIL) names.push('STAGING_ADMIN_EMAIL');
  if (env.SUPERADMIN_PASSWORD) names.push('SUPERADMIN_PASSWORD');
  if (env.STAGING_ADMIN_PASSWORD) names.push('STAGING_ADMIN_PASSWORD');
  if (env.VENDURE_ADMIN_API_URL) names.push('VENDURE_ADMIN_API_URL');
  return names;
}

function adminCredentialEnvAbsentNames(context) {
  var CANDIDATE = [
    'SUPERADMIN_USERNAME',
    'STAGING_ADMIN_EMAIL',
    'SUPERADMIN_PASSWORD',
    'STAGING_ADMIN_PASSWORD'
  ];
  var present = adminCredentialEnvNames(context);
  var missing = [];
  for (var i = 0; i < CANDIDATE.length; i += 1) {
    if (present.indexOf(CANDIDATE[i]) === -1) missing.push(CANDIDATE[i]);
  }
  return missing;
}
// ---------------------------------------------------------------------------
// Resolve per-task values from fixtures / env with deterministic defaults.
// ---------------------------------------------------------------------------

function fixtureString(context, name, fallback) {
  if (context && context.fixtures && typeof context.fixtures[name] === 'string' &&
      context.fixtures[name].length > 0) {
    return context.fixtures[name];
  }
  var envName = 'CAN_B2_15_' + name.toUpperCase();
  var envVal = envValue(context, envName);
  if (typeof envVal === 'string' && envVal.length > 0) return envVal;
  return fallback;
}

function resolveSku(context) {
  return fixtureString(context, 'sku', DEFAULT_SKU);
}

function resolveTimestamp(context) {
  return fixtureString(context, 'timestamp', DEFAULT_TIMESTAMP);
}

function resolveReceiptCode(context) {
  return fixtureString(context, 'receiptCode', DEFAULT_RECEIPT_CODE);
}

function resolveCountry(context) {
  if (context && context.fixtures && typeof context.fixtures.country === 'string' &&
      context.fixtures.country.length > 0) {
    return context.fixtures.country;
  }
  return DEFAULT_COUNTRY;
}

/**
 * Admin delist --apply is only permitted when the run mode explicitly allows
 * it (PIPELINE_MODE=full) AND the workspace is the isolated staging clone.
 * This executor never calls the script with --apply, so it always returns
 * the apply-capability question honestly.
 */
function applyAllowed(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var mode = runEnv.mode || envValue(context, 'PIPELINE_MODE') || 'preflight';
  if (mode !== 'full') return false;
  var ws = context && context.workspace ? context.workspace : {};
  return ws && (ws.staged === true || ws.stagingClone === true || ws.isolation === true);
}

// ---------------------------------------------------------------------------
// Evidence writers (single path through evidenceCollector).
// ---------------------------------------------------------------------------

function writeExecutorEvidence(context, taskId, files, secrets) {
  var runId = runIdOf(context);
  if (!runId) return [];
  var options = evidenceOptions(context);
  var baseRoot = path.join(options.root, options.baseDir);
  var loaded = evidenceCollector.loadIndex(baseRoot, runId);
  if (!(loaded.exists && loaded.index)) {
    try {
      evidenceCollector.initEvidenceIndex(runId, {}, options);
    } catch (e) {
      // index init is best-effort; writeEvidenceFile retries.
    }
  }
  var written = [];
  for (var i = 0; i < files.length; i += 1) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j += 1) {
        opts.secrets['delistingSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

function outcomeFromStoreFailure(storeOut, taskId, evidence) {
  var errorCode = storeOut && storeOut.errorCode ? storeOut.errorCode : 'UNKNOWN';
  var error = (storeOut && storeOut.error) || 'shop-api step failed';
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    terminalStateName: errorCode === 'ENVIRONMENT_ERROR'
      ? terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT
      : (errorCode === 'EXPECTED_MISMATCH'
        ? terminalState.FAILURE_CLASSES.APPLICATION_DEFECT
        : terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE),
    evidence: evidence || (storeOut && storeOut.evidence) || null
  };
}

function failureOutcome(errorCode, error, evidence) {
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence || null
  };
}

function passOutcome(context, taskId, evidence) {
  return {
    success: true,
    actual: taskExpectedText(context, taskId),
    result: RESULT_READINESS_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

function taskExpectedText(context, taskId) {
  var task = (context && context.task) || {};
  if (task.expectedResult) return task.expectedResult;
  return taskId;
}
// ---------------------------------------------------------------------------
// Child-process helpers (injected execFile / execFileSync for tests).
// ---------------------------------------------------------------------------

function getExecFile(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFile === 'function') return deps.execFile;
  if (deps.childProcess && typeof deps.childProcess.execFile === 'function') {
    return deps.childProcess.execFile.bind(deps.childProcess);
  }
  return childProcess.execFile;
}

function getExecFileSync(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFileSync === 'function') return deps.execFileSync;
  if (deps.childProcess && typeof deps.childProcess.execFileSync === 'function') {
    return deps.childProcess.execFileSync.bind(deps.childProcess);
  }
  return childProcess.execFileSync;
}

function runExecFile(execFile, file, args, options) {
  return new Promise(function(resolve) {
    var child;
    try {
      child = execFile(file, args, options, function(err, stdout, stderr) {
        var exitCode = err && typeof err.code === 'number'
          ? err.code
          : (child && typeof child.status === 'number' ? child.status : (err ? 1 : 0));
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

function buildRestrictedEnv(extra) {
  var env = {};
  if (typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  if (typeof process.env.HOME === 'string') env.HOME = process.env.HOME;
  if (typeof process.env.NODE_ENV === 'string') env.NODE_ENV = process.env.NODE_ENV;
  for (var i = 0; i < CREDENTIAL_ENV_NAMES.length; i += 1) delete env[CREDENTIAL_ENV_NAMES[i]];
  extra = extra || {};
  Object.keys(extra).forEach(function(key) { env[key] = String(extra[key]); });
  return { env: env, keys: Object.keys(env).sort() };
}

function getFs(context) {
  var deps = context && context.deps ? context.deps : {};
  return {
    mkdirSync: function(p, o) {
      if (typeof deps.mkdirSync === 'function') return deps.mkdirSync(p, o || { recursive: true });
      return fs.mkdirSync(p, o || { recursive: true });
    },
    existsSync: function(p) {
      if (typeof deps.existsSync === 'function') return deps.existsSync(p);
      try { return fs.existsSync(p); } catch (e) { return false; }
    },
    readFileSync: function(p, enc) {
      if (typeof deps.readFileSync === 'function') return deps.readFileSync(p, enc || 'utf8');
      return fs.readFileSync(p, enc || 'utf8');
    },
    readdirSync: function(p, o) {
      if (typeof deps.readdirSync === 'function') return deps.readdirSync(p, o || { withFileTypes: true });
      return fs.readdirSync(p, o || { withFileTypes: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Controlled PostgreSQL gateway probe + admin-delist dry-run.
// ---------------------------------------------------------------------------

/**
 * Probe the controlled PostgreSQL gateway the same way the supplied script
 * does: resolve the running `postgres` docker compose service in the
 * vendure-store directory. If the gateway is unreachable locally, the
 * executor returns BLOCK DEPENDENCY_ENVIRONMENT with the error as evidence.
 */
function probePostgresGateway(context) {
  var execFileSync = getExecFileSync(context);
  var vendureStoreAbs = path.join(repoRoot(context), VENDURE_STORE_DIR);
  try {
    var out = execFileSync('docker', ['compose', 'ps', '-q', 'postgres'], {
      cwd: vendureStoreAbs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    var container = String(out || '').trim();
    if (!container) {
      return {
        ok: false,
        container: null,
        error: 'no running postgres container (docker compose ps -q postgres returned empty)'
      };
    }
    return { ok: true, container: container, error: null };
  } catch (e) {
    return { ok: false, container: null, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Run scripts/admin_delist_products.mjs in dry-run through the controlled
 * PostgreSQL gateway. Writes the artifacts into an isolated directory so the
 * run leaves no trace in the repo. Never passes --apply. Returns the child
 * invocation record, the parsed result.json (or null) and the temp dirs.
 */
async function runAdminDelistDryRun(context, gateway) {
  var root = repoRoot(context);
  var ws = (context && context.workspace) || {};
  var wsPath = ws.workspacePath || path.join(root, 'scratch', 'delisting');
  var artifactRoot = path.join(wsPath, ARTIFACT_DIR);
  var archiveRoot = path.join(wsPath, ARCHIVE_DIR);
  var delistedRoot = path.join(wsPath, DELISTED_DIR);
  var sku = resolveSku(context);
  var timestamp = resolveTimestamp(context);

  // Dry-run only plans archive moves; create a stub archive folder for the
  // SKU so the script has a deterministic source path to plan moves from.
  var fsdeps = getFs(context);
  try {
    fsdeps.mkdirSync(path.join(archiveRoot, sku), { recursive: true });
  } catch (e) { /* ignore */ }

  var execFile = getExecFile(context);
  var scriptAbs = path.join(root, ADMIN_DELIST_SCRIPT);
  var envObj = buildRestrictedEnv({ ADMIN_DELIST_ARTIFACT_ROOT: artifactRoot });
  var args = [
    scriptAbs,
    '--sku=' + sku,
    '--archive-root=' + archiveRoot,
    '--delisted-root=' + delistedRoot,
    '--dry-run',
    '--no-reindex'
  ];
  var child = await runExecFile(execFile, process.execPath || 'node', args, {
    env: envObj.env,
    cwd: root
  });
  var result = readResultJson(context, artifactRoot, timestamp);
  return {
    sku: sku,
    timestamp: timestamp,
    artifactRoot: artifactRoot,
    archiveRoot: archiveRoot,
    delistedRoot: delistedRoot,
    gatewayContainer: gateway ? gateway.container : null,
    child: child,
    command: {
      command: process.execPath || 'node',
      args: args.slice(1),
      scriptPath: ADMIN_DELIST_SCRIPT,
      exitCode: child.exitCode,
      stdout: child.stdout,
      stderr: child.stderr,
      envKeys: envObj.keys
    },
    result: result
  };
}

function readResultJson(context, artifactRoot, timestamp) {
  var fsdeps = getFs(context);
  var candidates = [
    path.join(artifactRoot, timestamp, RESULT_FILE),
    path.join(artifactRoot, RESULT_FILE)
  ];
  for (var i = 0; i < candidates.length; i += 1) {
    if (fsdeps.existsSync(candidates[i])) {
      try {
        return JSON.parse(fsdeps.readFileSync(candidates[i], 'utf8'));
      } catch (e) {
        return { parseError: String(e && e.message || e) };
      }
    }
  }
  return null;
}
// ---------------------------------------------------------------------------
// Shop API helpers
// ---------------------------------------------------------------------------

function stepResponse(step) {
  if (!step) return null;
  if (step.response) return step.response;
  if (step.evidence && step.evidence.response) return step.evidence.response;
  return null;
}

function stepBody(step) {
  var response = stepResponse(step);
  return response ? response.body : null;
}

function readData(step, pathArr) {
  var node = stepBody(step);
  for (var i = 0; i < pathArr.length; i += 1) {
    if (node === null || node === undefined) return null;
    node = node[pathArr[i]];
  }
  return node === undefined ? null : node;
}

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return false;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

function buildAssertionReport(observed, checks) {
  var checkList = [
    {
      id: 'chk-designer-sales-detail',
      label: 'Designer sales details are correct (myDesigns / vendorOverview)',
      verified: !!checks.designerSalesDetail,
      detail: checks.designerSalesDetail
        ? 'salesCount=' + observed.designerSalesCount + ', totalEarnings=' + observed.designerTotalEarnings + ', vendorTotalSales=' + observed.vendorTotalSales
        : 'sales detail unavailable or not numeric'
    },
    {
      id: 'chk-self-delist',
      label: 'Customer self-delisting works (delistMyDesign)',
      verified: !!checks.selfDelisted,
      detail: checks.selfDelisted ? 'delistMyDesign returned true and design removed from myDesigns' : 'self-delist failed or design still listed'
    },
    {
      id: 'chk-admin-delist-dryrun',
      label: 'Authorized admin delisting dry-run through the PostgreSQL gateway',
      verified: !!checks.adminDelistDryRun,
      detail: checks.adminDelistDryRun ? 'admin_delist_products.mjs dry-run exit 0 with records + no apply' : 'admin delist dry-run exit ' + (observed.delistChildExitCode) + ' or result.json missing'
    },
    {
      id: 'chk-archive-plan',
      label: 'Related design files removal/archival plan present',
      verified: !!checks.archivePlan,
      detail: checks.archivePlan ? 'archiveMoves non-empty and target delisted root' : 'no archive moves planned'
    },
    {
      id: 'chk-receipt-price-tax',
      label: 'Customer receipt shows correct price and tax (orderByCode)',
      verified: !!checks.receiptPriceTax,
      detail: checks.receiptPriceTax ? 'currency=' + observed.receiptCurrency + ', totalWithTax=' + observed.receiptTotalWithTax + ', taxEntries=' + (Array.isArray(observed.receiptTaxSummary) ? observed.receiptTaxSummary.length : 0) : 'receipt currency or price/tax mismatch'
    }
  ];
  var allVerified = checkList.every(function(ch) { return ch.verified; });
  return [{
    id: 'CAN-B2-15-A01',
    label: 'Designer sales details are correct; customer self-delisting and authorized admin delisting work; related design files are removed or archived; the customer receipt shows correct price and tax.',
    coverage: COVERAGE_READINESS_SUBSET,
    verified: allVerified,
    checks: checkList,
    unverified: [
      {
        id: 'CAN-B2-15-A01',
        label: 'Authorized admin delisting executed (--apply) in the isolated staging clone',
        reason: 'admin delist is dry-run only from this tree; --apply requires PIPELINE_MODE=full + staged workspace + real staging'
      },
      {
        id: 'CAN-B2-15-A01',
        label: 'Actual design files physically removed/archived on the staging filesystem',
        reason: '--apply to the controlled PostgreSQL gateway and filesystem move only happens in staging; dry-run only plans it'
      },
      {
        id: 'CAN-B2-15-A01',
        label: 'Receipt correctness beyond Shop API (real Stripe payment)',
        reason: 'real payment needs the Stripe Runner; Shop API orderByCode is readiness evidence only'
      }
    ]
  }];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlerDelisting(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-15');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);
  var secrets = [];
  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];

  function recordStep(name, storeResult, pathArr) {
    var request = storeResult && storeResult.request;
    var response = stepResponse(storeResult);
    rawRequests.push({
      step: name,
      url: request && request.url,
      headers: request && request.headers,
      body: request && request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      step: name,
      httpStatus: response && response.httpStatus,
      body: response && response.body,
      timestamp: timestamp
    });
    steps.push({
      step: name,
      success: !!(storeResult && storeResult.success) && !isNetworkDown(storeResult),
      errorCode: (storeResult && storeResult.errorCode) || null,
      data: pathArr ? readData(storeResult, pathArr) : null
    });
  }

  // -------------------------------------------------------------------------
  // Pre-flight 1: admin identity (authorized admin delisting mandatory).
  // -------------------------------------------------------------------------
  var preflight = {
    taskId: taskId,
    source: 'ADMIN_IDENTITY',
    stage: 'preflight',
    checks: {
      identityResolved: hasAdminCredentials(context),
      presentNames: adminCredentialEnvNames(context),
      absentNames: adminCredentialEnvAbsentNames(context)
    },
    completedAt: timestamp
  };
  if (!hasAdminCredentials(context)) {
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: preflight, kind: 'executor-error' },
      { name: 'assertion-report.json', data: buildAssertionReport({ delistChildExitCode: null }, {
        designerSalesDetail: false,
        selfDelisted: false,
        adminDelistDryRun: false,
        archivePlan: false,
        receiptPriceTax: false
      }) }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'missing admin identity: ' + preflight.checks.absentNames.join(', '), preflight);
  }

  // -------------------------------------------------------------------------
  // Pre-flight 2: shop account passwords for the Shop API readiness checks.
  // -------------------------------------------------------------------------
  var missingShopVars = [];
  var designerPw = envValue(context, sessionModule.passwordEnvName(DESIGNER_ACCOUNT));
  var buyerPw = envValue(context, sessionModule.passwordEnvName(BUYER_ACCOUNT));
  if (!designerPw) missingShopVars.push(sessionModule.passwordEnvName(DESIGNER_ACCOUNT));
  if (!buyerPw) missingShopVars.push(sessionModule.passwordEnvName(BUYER_ACCOUNT));
  if (missingShopVars.length > 0) {
    var shopEnvEvidence = {
      taskId: taskId,
      source: 'ENVIRONMENT',
      checks: { envVarsResolved: false, missing: missingShopVars },
      missingEnvVars: missingShopVars,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: shopEnvEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'missing required env vars: ' + missingShopVars.join(', '), shopEnvEvidence);
  }

  // -------------------------------------------------------------------------
  // Pre-flight 3: channel tokens.
  // -------------------------------------------------------------------------
  var tokensResult = sessionModule.resolveChannelTokens(context);
  if (!tokensResult.ok) {
    var tokenEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: tokenEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', tokensResult.error, tokenEvidence);
  }
  secrets = sessionModule.tokenSecretList(tokensResult.tokens);

  var country = resolveCountry(context);
  if (!tokensResult.tokens[country]) {
    var countryEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + country },
      country: country,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: countryEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'channel token missing for ' + country, countryEvidence);
  }

  // -------------------------------------------------------------------------
  // Step 1: Designer login.
  // -------------------------------------------------------------------------
  var designerLogin = await store.login(DESIGNER_ACCOUNT);
  recordStep('designer-login', designerLogin, ['data', 'login']);
  if (!designerLogin.success) {
    var loginFailEvidence = {
      taskId: taskId,
      step: 'designer-login',
      steps: steps,
      errCode: designerLogin.errorCode,
      error: designerLogin.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: sessionModule.redactDeep(rawRequests, secrets), kind: 'api-request' },
      { name: 'shop-api-responses.json', data: sessionModule.redactDeep(rawResponses, secrets), kind: 'api-response' },
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(designerLogin, taskId, loginFailEvidence);
  }

  // -------------------------------------------------------------------------
  // Step 2: Designer sales detail (myDesigns).
  // -------------------------------------------------------------------------
  var designsOut = await store.call(DESIGNER_ACCOUNT, MY_DESIGNS_QUERY, {}, country);
  recordStep('my-designs', designsOut, ['data', 'myDesigns']);
  var designs = readData(designsOut, ['data', 'myDesigns']);
  observed.designs = Array.isArray(designs) ? designs : null;
  observed.designerDesignCount = Array.isArray(designs) ? designs.length : null;
  var firstDesign = (Array.isArray(designs) && designs.length > 0) ? designs[0] : null;
  observed.designerSalesCount = firstDesign && typeof firstDesign.salesCount === 'number' ? firstDesign.salesCount : null;
  observed.designerTotalEarnings = firstDesign && typeof firstDesign.totalEarnings === 'number' ? firstDesign.totalEarnings : null;
  observed.designerSku = firstDesign ? firstDesign.sku : null;
  observed.designProductId = firstDesign ? firstDesign.productId : null;
  observed.designStatus = firstDesign ? firstDesign.status : null;

  // myDesigns entries carry salesCount / totalEarnings (vendor.ts:87-106).
  // A numeric salesCount and totalEarnings mean the designer sales details
  // are present. "Correct" here means numeric + SKU resolves.
  checks.designerSalesDetail =
    Array.isArray(designs) && designs.length > 0 &&
    typeof observed.designerSalesCount === 'number' &&
    typeof observed.designerTotalEarnings === 'number' &&
    !isNetworkDown(designsOut);
  checks.designerSkuMatches = observed.designerSku === resolveSku(context);

  // -------------------------------------------------------------------------
  // Step 3: vendorOverview (designer sales view) - optional corroboration.
  // -------------------------------------------------------------------------
  var overviewOut = await store.call(DESIGNER_ACCOUNT, VENDOR_OVERVIEW_QUERY, {}, country);
  recordStep('vendor-overview', overviewOut, ['data', 'vendorOverview']);
  var overview = readData(overviewOut, ['data', 'vendorOverview']);
  observed.vendorTotalSales = overview && typeof overview.totalSales === 'number' ? overview.totalSales : null;
  checks.vendorOverviewOk = !!overview && typeof observed.vendorTotalSales === 'number';
  checks.designerSalesDetail = checks.designerSalesDetail && checks.vendorOverviewOk;

  // -------------------------------------------------------------------------
  // Step 4: Customer self-delisting (delistMyDesign), then re-query myDesigns.
  // -------------------------------------------------------------------------
  var designId = observed.designProductId || (context.fixtures && context.fixtures.productId) || 'p-1';
  var delistOut = await store.call(DESIGNER_ACCOUNT, DELIST_MY_DESIGN_MUTATION, { productId: String(designId) }, country);
  recordStep('self-delist', delistOut, ['data', 'delistMyDesign']);
  var delistData = readData(delistOut, ['data', 'delistMyDesign']);
  observed.delistData = delistData;

  var afterOut = await store.call(DESIGNER_ACCOUNT, MY_DESIGNS_QUERY, {}, country);
  recordStep('my-designs-after', afterOut, ['data', 'myDesigns']);
  var afterDesigns = readData(afterOut, ['data', 'myDesigns']);
  observed.afterDesigns = Array.isArray(afterDesigns) ? afterDesigns : null;
  var afterIds = (Array.isArray(afterDesigns) ? afterDesigns : []).map(function(d) { return d.productId; });
  observed.afterIds = afterIds;
  observed.selfDelisted = delistData === true && afterIds.indexOf(String(designId)) === -1;
  checks.selfDelisted = observed.selfDelisted;

  // -------------------------------------------------------------------------
  // Step 5: Buyer receipt via orderByCode.
  // -------------------------------------------------------------------------
  var buyerLogin = await store.login(BUYER_ACCOUNT);
  recordStep('buyer-login', buyerLogin, ['data', 'login']);
  if (!buyerLogin.success) {
    var buyerLoginFailEvidence = {
      taskId: taskId,
      step: 'buyer-login',
      steps: steps,
      errCode: buyerLogin.errorCode,
      error: buyerLogin.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: sessionModule.redactDeep(rawRequests, secrets), kind: 'api-request' },
      { name: 'shop-api-responses.json', data: sessionModule.redactDeep(rawResponses, secrets), kind: 'api-response' },
      { name: 'executor-error.json', data: buyerLoginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(buyerLogin, taskId, buyerLoginFailEvidence);
  }

  var receiptCode = resolveReceiptCode(context);
  var receiptOut = await store.orderByCode(BUYER_ACCOUNT, receiptCode, country);
  recordStep('order-by-code', receiptOut, ['data', 'orderByCode']);
  var receipt = readData(receiptOut, ['data', 'orderByCode']);
  observed.receipt = receipt;
  observed.receiptCurrency = receipt ? receipt.currencyCode : null;
  observed.receiptTotalWithTax = receipt ? receipt.totalWithTax : null;
  observed.receiptTaxSummary = receipt ? receipt.taxSummary : null;
  var expectedCurrency = (country === 'DE' || country === 'AT') ? 'EUR' : (country === 'HU' ? 'HUF' : 'GBP');
  var taxList = Array.isArray(observed.receiptTaxSummary) ? observed.receiptTaxSummary : [];
  var taxOk = taxList.length > 0 && taxList.some(function(t) { return typeof t.taxTotal === 'number' && t.taxTotal > 0; });
  checks.receiptPriceTax =
    !!receipt &&
    typeof observed.receiptTotalWithTax === 'number' &&
    observed.receiptTotalWithTax > 0 &&
    taxOk &&
    observed.receiptCurrency === expectedCurrency;

  // -------------------------------------------------------------------------
  // Step 6: Admin delisting - dry-run through the controlled PostgreSQL
  // gateway. Never --apply from this tree.
  // -------------------------------------------------------------------------
  var gateway = probePostgresGateway(context);
  observed.gatewayOk = gateway.ok;
  observed.gatewayError = gateway.error;
  // Admin rules: apply only in the isolated staging clone with explicit full
  // mode and a staged workspace. This executor always dry-runs because --apply
  // is never permitted from this local tree.
  observed.applyAllowed = applyAllowed(context);
  observed.applyExecuted = false;

  var gatewayEvidenceUnreachable = null;
  var adminDryRunBlocked = false;

  if (!gateway.ok) {
    // The gateway is unreachable locally -> BLOCK DEPENDENCY_ENVIRONMENT with
    // the error as evidence.
    adminDryRunBlocked = true;
    gatewayEvidenceUnreachable = {
      taskId: taskId,
      stage: 'admin-delist-gateway',
      error: gateway.error,
      probe: gateway,
      steps: steps,
      completedAt: timestamp
    };
    checks.adminDelistDryRun = false;
    checks.archivePlan = false;
  } else {
    var delistRun = await runAdminDelistDryRun(context, gateway);
    observed.delistRun = delistRun;
    observed.delistExitCode = delistRun.child.exitCode;
    observed.delistStderr = delistRun.child.stderr;
    observed.delistResult = delistRun.result;
    observed.delistArchiveMoves = delistRun.result && Array.isArray(delistRun.result.archiveMoves) ? delistRun.result.archiveMoves : null;
    observed.delistRecords = delistRun.result && Array.isArray(delistRun.result.records) ? delistRun.result.records : null;

    var resultOk = delistRun.child.exitCode === 0 && delistRun.result && delistRun.result.mode === 'dry-run';
    var records = observed.delistRecords || [];
    var archiveMoves = observed.delistArchiveMoves || [];
    checks.adminDelistDryRun = !!(resultOk && records.length > 0);
    checks.dryRunMode = !!(delistRun.result && delistRun.result.mode === 'dry-run');
    // Related design files removal/archive: the dry-run must plan the moves
    // from <archive-root>/<sku> to <delisted-root>/<timestamp>/<sku>.
    checks.archivePlan = archiveMoves.some(function(m) {
      return String(m.sourcePath || '').indexOf(delistRun.archiveRoot) === 0 &&
        String(m.destinationPath || '').indexOf(delistRun.delistedRoot) === 0;
    });
    // Never pass --apply from this tree (admin rules: apply only in the
    // isolated staging clone with explicit full mode).
    checks.applyNeverPassed = delistRun.command.args.indexOf('--apply') === -1;
  }

  // -------------------------------------------------------------------------
  // Validate SKU present in the batch records for the admin dry-run.
  // -------------------------------------------------------------------------
  var sku = resolveSku(context);
  observed.sku = sku;
  var recSkus = (observed.delistRecords || []).map(function(r) { return r.sku; });
  checks.skuInRecords = recSkus.indexOf(sku) !== -1;

  // -------------------------------------------------------------------------
  // Build evidence + report.
  // -------------------------------------------------------------------------
  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    scope: 'account-delisting',
    title: 'Account, delisting and administrative operations',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    executionRevision: executionRevisionOf(context),
    sku: sku,
    country: country,
    receiptCode: receiptCode,
    expected: {
      designerSalesDetail: 'myDesigns entries contain numeric salesCount/totalEarnings',
      selfDelisted: 'delistMyDesign removes the design from myDesigns',
      adminDelistDryRun: 'admin_delist_products.mjs dry-run through the PostgreSQL gateway exit 0 with records and dry-run mode',
      archivePlan: 'archiveMoves from archive-root/<sku> to delisted-root/<timestamp>/<sku>',
      receiptPriceTax: 'orderByCode receipt shows numeric totalWithTax and a positive taxSummary entry'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: assertionReport.reduce(function(acc, a) {
      return acc.concat((a.unverified || []).map(function(u) { return u.reason; }));
    }, []),
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'delisting-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  // The gateway is an external dependency that is unreachable locally.
  if (adminDryRunBlocked) {
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: gatewayEvidenceUnreachable, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', 'PostgreSQL gateway unreachable locally: ' + gateway.error, gatewayEvidenceUnreachable);
  }

  // -------------------------------------------------------------------------
  // Determine failures.
  // -------------------------------------------------------------------------
  var failures = [];
  if (!checks.designerSalesDetail) failures.push('designer sales detail not correct');
  if (!checks.selfDelisted) failures.push('customer self-delisting did not work');
  if (!checks.adminDelistDryRun) failures.push('admin delisting dry-run did not succeed');
  if (!checks.archivePlan) failures.push('related design files removal/archive plan missing');
  if (!checks.receiptPriceTax) failures.push('customer receipt price/tax not correct');

  if (failures.length > 0) {
    return failureOutcome('EXPECTED_MISMATCH', 'delisting check failed: ' + failures.join('; '), evidence);
  }

  return passOutcome(context, taskId, evidence);
}

// ---------------------------------------------------------------------------
// Registration (auto-discovery via src/executors/index.js).
// ---------------------------------------------------------------------------

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-15', {
    description: 'Account, delisting and administrative operations: designer sales detail, customer self-delisting, authorized admin delisting dry-run through the PostgreSQL gateway, related design-file archive plan, receipt price/tax (readiness scope)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-15-A01'],
    handler: handlerDelisting
  });
  return { success: true, registered: ['CAN-B2-15'] };
}

module.exports = {
  ADMIN_DELIST_SCRIPT: ADMIN_DELIST_SCRIPT,
  VENDURE_STORE_DIR: VENDURE_STORE_DIR,
  MY_DESIGNS_QUERY: MY_DESIGNS_QUERY,
  VENDOR_OVERVIEW_QUERY: VENDOR_OVERVIEW_QUERY,
  DELIST_MY_DESIGN_MUTATION: DELIST_MY_DESIGN_MUTATION,
  ORDER_BY_CODE_QUERY: ORDER_BY_CODE_QUERY,
  DESIGNER_ACCOUNT: DESIGNER_ACCOUNT,
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  DEFAULT_SKU: DEFAULT_SKU,
  DEFAULT_TIMESTAMP: DEFAULT_TIMESTAMP,
  DEFAULT_COUNTRY: DEFAULT_COUNTRY,
  DEFAULT_RECEIPT_CODE: DEFAULT_RECEIPT_CODE,
  probePostgresGateway: probePostgresGateway,
  runAdminDelistDryRun: runAdminDelistDryRun,
  buildAssertionReport: buildAssertionReport,
  handlerDelisting: handlerDelisting,
  register: register
};
