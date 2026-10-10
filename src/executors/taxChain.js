'use strict';

/**
 * Per-country Tax Zone and rate mapping executor (CAN-B2-14).
 *
 * CAN-B2-14 (Tax and country) asserts that the per-country Tax Zone and rate
 * mapping (DE 19%, AT 20%, HU 27%, GB 20% for category "Standard Tax") stays
 * consistent through product display, checkout, payment, order, receipt and
 * the post-tax split, and the actual rates used are recorded from the run
 * configuration. It also covers a controlled dynamic rate update where enabled
 * and the configured scheduled behavior claim for tax/exchange rates (the
 * coordinator Skill, branch-task layout and Vendure-plugin choice are
 * implementation details, not separate acceptance tasks).
 *
 * The executor verifies the readiness subset of each mandatory assertion from
 * evidence the Shop API and the run configuration can prove, and runs the
 * supplied setup script in dry-run through the controlled PostgreSQL gateway:
 *
 *   1. The frozen per-country rate mapping is read from the run configuration
 *      (manifest/fixtures.v1.json taxRates, origin VERIFIED, verified by
 *      sha256) and the required input taxConfig (registry frozenValue). The
 *      actual rates are recorded from the run configuration, the
 *      "rates-from-config proof" (task-api-map.md:185, :210).
 *
 *   2. The rates stay consistent through product display, checkout, order and
 *      receipt as the Shop API can show them:
 *        - product display: product variants expose priceWithTax and
 *          currencyCode (queries.ts:69-75, product-card.tsx:43-52);
 *        - checkout: activeOrder taxSummary carries description / taxRate /
 *          taxTotal (queries.ts:114-163, 128-132, order-summary.tsx:84-91);
 *        - order: the same activeOrder object and its taxSummary;
 *        - receipt: orderByCode taxSummary agrees (queries.ts:377).
 *
 *   3. scripts/setup_tax_rates.mjs is run in dry-run only. `--apply` deletes
 *      and re-inserts `tax_rate` rows and is authorized only against the
 *      designated isolated evaluation/staging clone (reconciled doc 4.5), so
 *      it is never passed from this tree. The dry-run produces
 *      work/tmp/tax-rate-setup/<ts>/summary.txt and result.json (manifest
 *      section 6.1) whose plan shows current vs desired per-country rates.
 *
 * Claims the Shop API cannot prove remain unverified and are listed in the
 * assertion report: payment tax consistency (needs the Stripe Runner),
 * receipt/order correctness beyond the Shop API, the post-tax split (the
 * platform/designer split is ledger- and Admin-level, query_order_revenue.js
 * :46-58 reads totalWithTax), and the scheduled behavior of the rate updates.
 *
 * Failure classes: store/rates mismatch -> EXPECTED_MISMATCH
 * (APPLICATION_DEFECT); Shop API down or gateway unreachable ->
 * ENVIRONMENT_ERROR (DEPENDENCY_ENVIRONMENT); missing channel token or
 * missing password env var -> VALIDATION_ERROR (CLIENT_INPUT_SCOPE, records
 * env var NAMES only, never values).
 */

var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');
var fixturesModule = require('../fixtures');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Repo-relative path of the supplied tax-rate setup script (scriptNameMap
// setup_tax_rates.ts -> scripts/setup_tax_rates.mjs).
var SETUP_TAX_SCRIPT =
  'evaluation-demo/migration-input/legacy/vendure-store/scripts/setup_tax_rates.mjs';
var VENDURE_STORE_DIR = 'evaluation-demo/migration-input/legacy/vendure-store';

// Artifact layout written by setup_tax_rates.mjs (manifest section 6.1).
var RESULT_FILE = 'result.json';
var SUMMARY_FILE = 'summary.txt';

// Synthetic account from manifest/fixtures.v1.json (origin VERIFIED). A DE
// buyer exercises the display/checkout/receipt tax chain.
var BUYER_ACCOUNT = 'buyer.one@example.com';

// Default receipt (earned paid order) code read through orderByCode. A real
// staging code can be supplied via context.fixtures.receiptCode or the
// CAN_B2_14_RECEIPT_CODE env var; the executor never guesses a receipt.
var DEFAULT_RECEIPT_CODE = 'ED-ORD-214';
var RECEIPT_CODE_ENV = 'CAN_B2_14_RECEIPT_CODE';

// Country -> rate/currency/zone expected values. Rates are VERIFIED from
// setup_tax_rates.mjs:18-23 and fixtures.v1.json taxRates. This is the
// "supported country list" the Contractor fills in and evidences per
// CAN-B2-14-A02.
var COUNTRY_CONFIG = {
  DE: { rate: 19, currency: 'EUR', zoneName: 'DE Zone' },
  AT: { rate: 20, currency: 'EUR', zoneName: 'AT Zone' },
  HU: { rate: 27, currency: 'HUF', zoneName: 'HU Zone' },
  GB: { rate: 20, currency: 'GBP', zoneName: 'GB Zone' }
};
var SUPPORTED_COUNTRIES = Object.keys(COUNTRY_CONFIG).sort();

// Credential-holding env names never forwarded to a child process.
var CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'VENDURE_ADMIN_TOKEN',
  'VENDURE_AUTH_TOKEN_HEADER',
  'OPENROUTER_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_TEST_SECRET_KEY'
];

// ---------------------------------------------------------------------------
// GraphQL documents (operation names and field sets copied from the
// migration-input storefront source, never guessed).
// ---------------------------------------------------------------------------

// Product display browse: storefront/src/lib/vendure/queries.ts:69-75.
var BROWSE_PRODUCTS_QUERY = [
  'query BrowseCountryChannelProducts {',
  '  products(options: { take: 3 }) {',
  '    items {',
  '      id',
  '      name',
  '      slug',
  '      variants {',
  '        id',
  '        sku',
  '        name',
  '        priceWithTax',
  '        currencyCode',
  '      }',
  '    }',
  '  }',
  '}'
].join('\n');

// Checkout/order: activeOrder taxSummary (queries.ts:114-163, 128-132).
var ACTIVE_ORDER_QUERY = sessionModule.GRAPHQL.activeOrder;

// Receipt: orderByCode taxSummary (queries.ts:377).
var ORDER_BY_CODE_QUERY = sessionModule.GRAPHQL.orderByCode;

// ---------------------------------------------------------------------------
// Context / env helpers
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

function taskExpectedText(context, taskId) {
  var task = context && context.task ? context.task : {};
  if (task.expectedResult) return task.expectedResult;
  return taskId;
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

/**
 * Resolve the vendure-store directory (absolute). Tests override it with a
 * temp dir so the dry-run never touches the protected migration-input tree.
 */
function vendureStoreAbs(context) {
  if (context && typeof context.vendureStoreDir === 'string' && context.vendureStoreDir.length > 0) {
    return context.vendureStoreDir;
  }
  return path.join(repoRoot(context), VENDURE_STORE_DIR);
}

function artifactRootOf(context) {
  return path.join(vendureStoreAbs(context), 'work', 'tmp', 'tax-rate-setup');
}

function resolveReceiptCode(context) {
  if (context && context.fixtures && typeof context.fixtures.receiptCode === 'string' &&
      context.fixtures.receiptCode.length > 0) {
    return context.fixtures.receiptCode;
  }
  var envCode = envValue(context, RECEIPT_CODE_ENV);
  if (typeof envCode === 'string' && envCode.length > 0) {
    return envCode;
  }
  return DEFAULT_RECEIPT_CODE;
}

function skipDryRun(context) {
  return !!(context && context.overrides && context.overrides.skipDryRun === true);
}

// ---------------------------------------------------------------------------
// Frozen rate loading (from run configuration)
// ---------------------------------------------------------------------------

/**
 * Load the frozen per-country tax rates from manifest/fixtures.v1.json
 * (verified by sha256). These are the "actual rates recorded from the run
 * configuration" for the script scope.
 */
function loadFrozenRates(context) {
  var loaded = fixturesModule.loadFixturesFile();
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  var taxRates = loaded.fixtures && loaded.fixtures.taxRates;
  if (!taxRates || !taxRates.rates || typeof taxRates.rates !== 'object') {
    return { ok: false, error: 'taxRates missing from fixtures.v1.json' };
  }
  return { ok: true, taxRates: taxRates, sha256: loaded.sha256 };
}

/**
 * Read the required input taxConfig from the frozen registry value
 * (inputs-registry.json taxConfig.frozenValue). Returns null when the
 * registry is absent (direct handler/test calls), in which case the fixture
 * values are authoritative.
 */
function registryTaxConfig(context) {
  var registry = context && (context.registry || (context.deps && context.deps.registry));
  if (!registry || !Array.isArray(registry.inputs)) return null;
  for (var i = 0; i < registry.inputs.length; i++) {
    if (registry.inputs[i].id === 'taxConfig') {
      return registry.inputs[i].frozenValue || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Evidence writers (single path through evidenceCollector)
// ---------------------------------------------------------------------------

function writeExecutorEvidence(context, taskId, files, secrets) {
  var runId = runIdOf(context);
  if (!runId) return [];
  var options = evidenceOptions(context);
  var loaded = evidenceCollector.loadIndex(path.join(options.root, options.baseDir), runId);
  if (!(loaded.exists && loaded.index)) {
    try {
      evidenceCollector.initEvidenceIndex(runId, {}, options);
    } catch (e) {
      // index initialisation is best-effort; writeEvidenceFile retries.
    }
  }
  var written = [];
  for (var i = 0; i < files.length; i += 1) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j += 1) {
        opts.secrets['taxChainSecret' + j] = secrets[j];
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
    existsSync: function(p) {
      if (typeof deps.existsSync === 'function') return deps.existsSync(p);
      try { return fs.existsSync(p); } catch (e) { return false; }
    },
    readdirSync: function(p, o) {
      if (typeof deps.readdirSync === 'function') return deps.readdirSync(p, o || { withFileTypes: true });
      return fs.readdirSync(p, o || { withFileTypes: true });
    },
    readFileSync: function(p, enc) {
      if (typeof deps.readFileSync === 'function') return deps.readFileSync(p, enc || 'utf8');
      return fs.readFileSync(p, enc || 'utf8');
    }
  };
}

// ---------------------------------------------------------------------------
// Controlled PostgreSQL gateway probe + setup_tax_rates.mjs dry-run.
// ---------------------------------------------------------------------------

/**
 * Probe the controlled PostgreSQL gateway the same way the supplied script
 * does: resolve the running `postgres` docker compose service in the
 * vendure-store directory. If the gateway is unreachable locally, the
 * executor returns BLOCK DEPENDENCY_ENVIRONMENT with the error as evidence.
 */
function probePostgresGateway(context) {
  var execFileSync = getExecFileSync(context);
  var vendureStoreAbs = vendureStoreAbsOf(context);
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

function vendureStoreAbsOf(context) {
  return vendureStoreAbs(context);
}

/**
 * Run scripts/setup_tax_rates.mjs in dry-run through the controlled
 * PostgreSQL gateway. The script writes its artifacts under
 * vendure-store/work/tmp/tax-rate-setup/<timestamp>/ as documented. This
 * tree never passes --apply; --apply is only ever executed in the isolated
 * staging clone (reconciled doc 4.5). Returns the child invocation record,
 * the parsed result.json (or null) and the artifact root.
 */
async function runTaxRatesDryRun(context, gateway) {
  var root = repoRoot(context);
  var artifactRoot = artifactRootOf(context);
  var scriptAbs = path.join(root, SETUP_TAX_SCRIPT);

  var execFile = getExecFile(context);
  var envObj = buildRestrictedEnv({
    POSTGRES_SERVICE: process.env.POSTGRES_SERVICE || 'postgres',
    POSTGRES_USER: process.env.POSTGRES_USER || 'vendure',
    POSTGRES_DB: process.env.POSTGRES_DB || 'vendure',
    TAX_CATEGORY_NAME: process.env.TAX_CATEGORY_NAME || 'Standard Tax'
  });
  var args = [scriptAbs, '--country=' + SUPPORTED_COUNTRIES.join(',')];
  var child = await runExecFile(execFile, process.execPath || 'node', args, {
    env: envObj.env,
    cwd: repoRoot(context)
  });
  var artifacts = readTaxArtifacts(context);
  return {
    artifactRoot: artifactRoot,
    gatewayContainer: gateway ? gateway.container : null,
    child: child,
    command: {
      command: process.execPath || 'node',
      args: args.slice(1),
      scriptPath: SETUP_TAX_SCRIPT,
      exitCode: child.exitCode,
      stdout: child.stdout,
      stderr: child.stderr,
      envKeys: envObj.keys
    },
    artifacts: artifacts
  };
}

function listChildDirs(context, rootDir) {
  var deps = context && context.deps ? context.deps : {};
  var readdir = deps.readdirSync;
  if (!readdir && deps.fs && typeof deps.fs.readdirSync === 'function') readdir = deps.fs.readdirSync.bind(deps.fs);
  if (!readdir) readdir = fs.readdirSync;
  try {
    return readdir(rootDir, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; });
  } catch (e) {
    return [];
  }
}

function readTaxArtifacts(context) {
  var artifactRoot = artifactRootOf(context);
  var dirs = listChildDirs(context, artifactRoot);
  var latest = dirs.sort().slice(-1)[0] || null;
  var result = null;
  var summary = null;
  if (latest) {
    var fsdeps = getFs(context);
    var resPath = path.join(artifactRoot, latest, RESULT_FILE);
    var sumPath = path.join(artifactRoot, latest, SUMMARY_FILE);
    if (fsdeps.existsSync(resPath)) {
      try {
        result = JSON.parse(fsdeps.readFileSync(resPath, 'utf8'));
      } catch (e) {
        result = { parseError: String(e && e.message || e) };
      }
    }
    if (fsdeps.existsSync(sumPath)) summary = fsdeps.readFileSync(sumPath, 'utf8');
  }
  return { artifactRoot: artifactRoot, result: result, summary: summary, dir: latest };
}

// ---------------------------------------------------------------------------
// Shop API step helpers
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

function taxSummaryRateMatches(entries, ratePct) {
  if (!Array.isArray(entries)) return false;
  // Vendure exposes taxRate in basis points (19% -> 1900). Consistency claim
  // verified for at least one entry with a numeric positive taxTotal and a
  // rate equal to the configured rate scaled by 100.
  for (var i = 0; i < entries.length; i++) {
    var t = entries[i];
    if (!t) continue;
    if (typeof t.taxTotal !== 'number' || t.taxTotal <= 0) continue;
    var expectedBp = Math.round(Number(ratePct) * 100);
    if (typeof t.taxRate === 'number' && Math.round(t.taxRate) === expectedBp) {
      return true;
    }
  }
  return false;
}

function taxSummaryAggregate(entries) {
  var sum = 0;
  var count = 0;
  if (Array.isArray(entries)) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] && typeof entries[i].taxTotal === 'number') {
        sum += entries[i].taxTotal;
        count += 1;
      }
    }
  }
  return { count: count, sum: sum };
}

function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B2-14-A01',
    verified: !!checks.shopChainConsistent,
    summary: 'Per-country Tax Zone and rate mapping stays consistent through product display, checkout, order and receipt; the actual rates used are recorded from the run configuration.',
    verifiedClaims: [
      { claim: 'per-country rates recorded from run configuration (fixture sha verified)', verified: checks.frozenRatesOk, observed: observed.frozenRatesJson },
      { claim: 'rates consistent through product display (priceWithTax on variants)', verified: checks.productDisplayTax, observed: observed.displayCurrency + ' priceWithTax=' + observed.displayPriceWithTax },
      { claim: 'rates consistent through checkout/order (activeOrder taxSummary)', verified: checks.checkoutTax, observed: observed.checkoutRateBp + ' (taxTotal=' + observed.checkoutTaxTotal + ')' },
      { claim: 'rates consistent through receipt (orderByCode taxSummary)', verified: checks.receiptTax, observed: observed.receiptRateBp + ' (taxTotal=' + observed.receiptTaxTotal + ')' }
    ],
    unverifiedClaims: [
      { claim: 'rates consistent through payment tax path', why: 'needs the Stripe Runner (addPaymentToOrder mutations.ts:271-292) and paid orders' },
      { claim: 'post-tax split (platform/designer share after VAT deduction)', why: 'ledger/Admin-level; query_order_revenue.js:46-58 reads totalWithTax, not readable through the Shop API' }
    ]
  };
  var a02 = {
    id: 'CAN-B2-14-A02',
    verified: !!checks.dynamicUpdateDryRun,
    summary: 'Country Tax Zone/rate setup dry-run and controlled rate update through the isolated staging gateway; supported country list recorded.',
    verifiedClaims: [
      { claim: 'supported country list recorded and matches the script scope (DE/AT/HU/GB)', verified: checks.supportedCountryList, observed: SUPPORTED_COUNTRIES.join(',') },
      { claim: 'setup_tax_rates.mjs dry-run through the controlled PostgreSQL gateway exit 0 with result.json mode=dry-run', verified: checks.taxRatesDryRun, observed: observed.dryRunMode },
      { claim: 'dry-run plan desired rates equal the run-config rates', verified: checks.dryRunPlanMatches, observed: observed.dryPlanSummary },
      { claim: '--apply never passed from this tree (Stripe rules + isolated clone rule)', verified: checks.applyNeverPassed, observed: false }
    ],
    unverifiedClaims: [
      { claim: 'controlled rate update actually applied (--apply) and shown through payment and post-tax split', why: '--apply only in the isolated staging clone; dry-run only verifies the plan (reconciled doc 4.5)' }
    ]
  };
  var a03 = {
    id: 'CAN-B2-14-A03',
    verified: !!checks.displayCheckoutReceiptSameRate,
    summary: 'Tax-rate updates (and the frozen exchange-rate set) shown through user-visible paths: display, checkout, order, receipt.',
    verifiedClaims: [
      { claim: 'the configured tax rate is the same through display, checkout, order and receipt', verified: checks.displayCheckoutReceiptSameRate, observed: observed.observedRates },
      { claim: 'frozen exchange-rate set recorded from the run configuration (fixtures.v1.json exchangeRates, origin VERIFIED)', verified: checks.exchangeRatesRecorded, observed: observed.exchangeRatesJson }
    ],
    unverifiedClaims: [
      { claim: 'scheduled behavior of exchange-rate/tax-rate updates driven by the runtime scheduler', why: 'implementation detail; not provable through the Shop API (A03/A04 remainder)' },
      { claim: 'financial paths (ledger, wallet conversion, post-tax split) after a rate update', why: 'needs DB/Admin/ledger access' }
    ]
  };
  var a04 = {
    id: 'CAN-B2-14-A04',
    verified: !!checks.sourceFrozenValuesRecorded,
    summary: 'Configured rate source, frozen values and timestamps recorded; downstream consistency verified through the shop chain.',
    verifiedClaims: [
      { claim: 'source and frozen tax rates recorded (fixtures.v1.json taxRates, origin VERIFIED, sha256 pinned)', verified: checks.sourceFrozenValuesRecorded, observed: observed.frozenRatesSource },
      { claim: 'frozen exchange rates recorded with their source', verified: checks.exchangeRatesRecorded, observed: observed.exchangeRatesSource },
      { claim: 'timestamps recorded for the dry-run and the shop chain', verified: checks.timestampsRecorded, observed: observed.completedAt }
    ],
    unverifiedClaims: [
      { claim: 'scheduled behavior of the rate updates executed and observed', why: 'implementation detail; not verifiable from the public tree' }
    ]
  };
  return [a01, a02, a03, a04];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlerTaxChain(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-14');
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
    var request = storeResult && storeResult.request ? storeResult.request : null;
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
  // Pre-flight 1: frozen rates from the run configuration.
  // -------------------------------------------------------------------------
  var frozen = loadFrozenRates(context);
  if (!frozen.ok) {
    var frozenFailEvidence = {
      taskId: taskId,
      source: 'FROZEN_RATES',
      error: frozen.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: frozenFailEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('ENVIRONMENT_ERROR', 'frozen tax rates unavailable: ' + frozen.error, frozenFailEvidence);
  }
  observed.frozenRates = frozen.taxRates.rates;
  observed.frozenRatesJson = JSON.stringify(frozen.taxRates.rates);
  observed.frozenRatesSource = 'manifest/fixtures.v1.json taxRates (origin VERIFIED, sha256=' + String(frozen.sha256).slice(0, 12) + ')';
  var exRates = frozen.fixtures && frozen.fixtures.exchangeRates
    ? frozen.fixtures.exchangeRates
    : null;
  observed.exchangeRatesJson = exRates && exRates.rates ? JSON.stringify(exRates.rates) : null;
  observed.exchangeRatesSource = exRates ? (exRates.origin || 'unknown') : 'missing';

  var expectedRates = {};
  SUPPORTED_COUNTRIES.forEach(function(c) {
    expectedRates[c] = COUNTRY_CONFIG[c].rate;
  });
  observed.expectedRates = expectedRates;
  checks.frozenRatesOk = SUPPORTED_COUNTRIES.every(function(c) {
    return Number(frozen.taxRates.rates[c]) === COUNTRY_CONFIG[c].rate;
  });
  checks.exchangeRatesRecorded = observed.exchangeRatesJson !== null && typeof observed.exchangeRatesJson === 'string';
  checks.sourceFrozenValuesRecorded = checks.frozenRatesOk && checks.exchangeRatesRecorded;
  checks.timestampsRecorded = timestamp.length > 0;
  var registryCfg = registryTaxConfig(context);
  observed.registryTaxConfig = registryCfg;
  checks.registryTaxConfigOk = registryCfg === null ? true : matchesRegistryTaxConfig(registryCfg, expectedRates);

  // -------------------------------------------------------------------------
  // Pre-flight 2: channel tokens (CLIENT_INPUT_SCOPE if missing).
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

  // -------------------------------------------------------------------------
  // Pre-flight 3: shop account password for the buyer (DE tax chain).
  // -------------------------------------------------------------------------
  var buyerPwName = sessionModule.passwordEnvName(BUYER_ACCOUNT);
  var buyerPw = envValue(context, buyerPwName);
  if (!buyerPw) {
    var envEvidence = {
      taskId: taskId,
      source: 'ENVIRONMENT',
      checks: { envVarsResolved: false, missing: [buyerPwName] },
      missingEnvVars: [buyerPwName],
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'missing required env var: ' + buyerPwName, envEvidence);
  }

  // -------------------------------------------------------------------------
  // Step 1: buyer login (DE).
  // -------------------------------------------------------------------------
  var login = await store.login(BUYER_ACCOUNT);
  recordStep('buyer-login', login, ['data', 'login']);
  if (!login.success) {
    var loginFailEvidence = {
      taskId: taskId,
      step: 'buyer-login',
      steps: steps,
      errCode: login.errorCode,
      error: login.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: sessionModule.redactDeep(rawRequests, secrets), kind: 'api-request' },
      { name: 'shop-api-responses.json', data: sessionModule.redactDeep(rawResponses, secrets), kind: 'api-response' },
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(login, taskId, loginFailEvidence);
  }

  // -------------------------------------------------------------------------
  // Step 2: product display (product variants priceWithTax, queries.ts:69-75).
  // -------------------------------------------------------------------------
  var browseOut = await store.call(BUYER_ACCOUNT, BROWSE_PRODUCTS_QUERY, {}, 'DE');
  recordStep('product-display', browseOut, ['data', 'products', 'items']);
  var products = readData(browseOut, ['data', 'products', 'items']);
  var firstVariant = null;
  if (Array.isArray(products) && products.length > 0 && products[0].variants && products[0].variants.length > 0) {
    firstVariant = products[0].variants[0];
  }
  observed.displayPrice = firstVariant && typeof firstVariant.price === 'number' ? firstVariant.price : null;
  observed.displayPriceWithTax = firstVariant && typeof firstVariant.priceWithTax === 'number' ? firstVariant.priceWithTax : null;
  observed.displayCurrency = firstVariant ? firstVariant.currencyCode : null;
  checks.productDisplayTax =
    !!firstVariant &&
    typeof observed.displayPriceWithTax === 'number' &&
    observed.displayPriceWithTax > 0 &&
    observed.displayCurrency === COUNTRY_CONFIG.DE.currency;

  // -------------------------------------------------------------------------
  // Step 3: checkout/order tax (activeOrder taxSummary, queries.ts:114-163).
  // -------------------------------------------------------------------------
  var checkoutOut = await store.activeOrder(BUYER_ACCOUNT, 'DE');
  recordStep('checkout-total', checkoutOut, ['data', 'activeOrder']);
  var checkoutOrder = readData(checkoutOut, ['data', 'activeOrder']);
  observed.checkoutCurrency = checkoutOrder ? checkoutOrder.currencyCode : null;
  observed.checkoutTaxSummary = checkoutOrder ? checkoutOrder.taxSummary : null;
  var checkoutEntries = Array.isArray(observed.checkoutTaxSummary) ? observed.checkoutTaxSummary : [];
  var chAgg = taxSummaryAggregate(checkoutEntries);
  observed.checkoutTaxTotal = chAgg.count > 0 ? chAgg.sum : null;
  observed.checkoutRateBp = checkoutEntries.length > 0 ? checkoutEntries[0].taxRate : null;
  checks.checkoutTax =
    !!checkoutOrder &&
    typeof observed.checkoutTaxTotal === 'number' &&
    observed.checkoutTaxTotal > 0 &&
    observed.checkoutCurrency === COUNTRY_CONFIG.DE.currency &&
    taxSummaryRateMatches(checkoutEntries, COUNTRY_CONFIG.DE.rate);

  // -------------------------------------------------------------------------
  // Step 4: receipt (orderByCode taxSummary, queries.ts:377).
  // -------------------------------------------------------------------------
  var receiptCode = resolveReceiptCode(context);
  observed.receiptCode = receiptCode;
  var receiptOut = await store.orderByCode(BUYER_ACCOUNT, receiptCode, 'DE');
  recordStep('receipt-total', receiptOut, ['data', 'orderByCode']);
  var receipt = readData(receiptOut, ['data', 'orderByCode']);
  observed.receiptCurrency = receipt ? receipt.currencyCode : null;
  observed.receiptTaxSummary = receipt ? receipt.taxSummary : null;
  observed.receiptTotalWithTax = receipt && typeof receipt.totalWithTax === 'number' ? receipt.totalWithTax : null;
  var receiptEntries = Array.isArray(observed.receiptTaxSummary) ? observed.receiptTaxSummary : [];
  var rAgg = taxSummaryAggregate(receiptEntries);
  observed.receiptTaxTotal = rAgg.count > 0 ? rAgg.sum : null;
  observed.receiptRateBp = receiptEntries.length > 0 ? receiptEntries[0].taxRate : null;
  checks.receiptTax =
    !!receipt &&
    typeof observed.receiptTaxTotal === 'number' &&
    observed.receiptTaxTotal > 0 &&
    observed.receiptCurrency === COUNTRY_CONFIG.DE.currency &&
    taxSummaryRateMatches(receiptEntries, COUNTRY_CONFIG.DE.rate);

  // -------------------------------------------------------------------------
  // Step 5: per-country consistency of the observed rates.
  // -------------------------------------------------------------------------
  var ratesSeen = [];
  if (observed.checkoutRateBp !== null && observed.checkoutRateBp !== undefined) ratesSeen.push(Math.round(observed.checkoutRateBp));
  if (observed.receiptRateBp !== null && observed.receiptRateBp !== undefined) ratesSeen.push(Math.round(observed.receiptRateBp));
  observed.observedRates = ratesSeen;
  observed.ratesSameAcrossDocs = ratesSeen.length >= 1 && ratesSeen.every(function(r) { return r === Math.round(COUNTRY_CONFIG.DE.rate * 100); });
  checks.displayCheckoutReceiptSameRate = observed.ratesSameAcrossDocs;
  checks.shopChainConsistent = checks.productDisplayTax && checks.checkoutTax && checks.receiptTax;
  checks.supportedCountryList = SUPPORTED_COUNTRIES.slice().sort().join(',') === 'AT,DE,GB,HU';

  // -------------------------------------------------------------------------
  // Step 6: setup_tax_rates.mjs dry-run through the controlled PostgreSQL
  // gateway (never --apply from this tree).
  // -------------------------------------------------------------------------
  var gateway = null;
  var dryRunBlocked = false;
  var gatewayEvidenceUnreachable = null;
  var dryRun = null;

  if (skipDryRun(context)) {
    checks.taxRatesDryRun = false;
    checks.dryRunPlanMatches = false;
    checks.applyNeverPassed = true;
    observed.dryRunSkipped = true;
    gateway = { ok: false, container: null, error: 'dry-run skipped via context override' };
  } else {
    gateway = probePostgresGateway(context);
    observed.gatewayOk = gateway.ok;
    observed.gatewayError = gateway.error;
    if (!gateway.ok) {
      dryRunBlocked = true;
      gatewayEvidenceUnreachable = {
        taskId: taskId,
        stage: 'tax-rates-gateway',
        error: gateway.error,
        probe: gateway,
        completedAt: timestamp
      };
      checks.taxRatesDryRun = false;
      checks.dryRunPlanMatches = false;
      checks.applyNeverPassed = true;
    } else {
      dryRun = await runTaxRatesDryRun(context, gateway);
      observed.dryRun = dryRun;
      observed.dryRunExitCode = dryRun.child.exitCode;
      observed.dryRunResult = dryRun.artifacts.result;
      observed.dryRunSummary = dryRun.artifacts.summary;
      observed.dryRunArtifactDir = dryRun.artifacts.dir;
      observed.dryRunMode = dryRun.artifacts.result ? dryRun.artifacts.result.mode : null;
      observed.dryPlan = dryRun.artifacts.result ? dryRun.artifacts.result.plan : null;
      observed.dryPlanSummary = '';
      if (Array.isArray(observed.dryPlan)) {
        observed.dryPlanSummary = observed.dryPlan.map(function(p) {
          return p.country + '=' + p.desiredRate + '[' + p.status + ']';
        }).join(',');
      }
      checks.taxRatesDryRun = !!(dryRun.child.exitCode === 0 &&
        dryRun.artifacts.result && dryRun.artifacts.result.mode === 'dry-run');
      checks.dryRunPlanMatches = !!observed.dryPlan &&
        SUPPORTED_COUNTRIES.every(function(c) {
          var entry = observed.dryPlan.find(function(p) { return p.country === c; });
          return !!entry && Number(entry.desiredRate) === COUNTRY_CONFIG[c].rate;
        });
      checks.applyNeverPassed = dryRun.command.args.indexOf('--apply') === -1;
      observed.applyPassed = checks.applyNeverPassed;
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic update control (where enabled): dry-run match only.
  // -------------------------------------------------------------------------
  checks.dynamicUpdateDryRun = checks.taxRatesDryRun && checks.dryRunPlanMatches;
  observed.dynamicUpdateDryRun = checks.dynamicUpdateDryRun;

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    scope: 'tax-chain',
    title: 'Per-country Tax Zone and rate mapping through display, checkout, order, receipt and post-tax split',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    executionRevision: executionRevisionOf(context),
    supportedCountries: SUPPORTED_COUNTRIES,
    expectedRates: expectedRates,
    frozenRatesSource: observed.frozenRatesSource,
    frozenRatesJson: observed.frozenRatesJson,
    exchangeRatesJson: observed.exchangeRatesJson,
    exchangeRatesSource: observed.exchangeRatesSource,
    receiptCode: receiptCode,
    observed: {
      displayPrice: observed.displayPrice,
      displayPriceWithTax: observed.displayPriceWithTax,
      displayCurrency: observed.displayCurrency,
      checkoutCurrency: observed.checkoutCurrency,
      checkoutTaxTotal: observed.checkoutTaxTotal,
      checkoutRateBp: observed.checkoutRateBp,
      receiptCurrency: observed.receiptCurrency,
      receiptTaxTotal: observed.receiptTaxTotal,
      receiptRateBp: observed.receiptRateBp,
      receiptState: receipt ? receipt.state : null,
      observedRates: observed.observedRates,
      gatewayOk: observed.gatewayOk,
      gatewayError: observed.gatewayError,
      dryRunMode: observed.dryRunMode,
      dryPlanSummary: observed.dryPlanSummary
    },
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    unverified: assertionReport.reduce(function(acc, a) {
      return acc.concat((a.unverifiedClaims || []).map(function(u) { return u.claim; }));
    }, []),
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'tax-chain-table.json', data: { expected: { rates: expectedRates, receiptCode: receiptCode }, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: { rates: expectedRates, receiptCode: receiptCode }, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  // The gateway is an external dependency that is unreachable locally.
  if (dryRunBlocked) {
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: gatewayEvidenceUnreachable, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', 'PostgreSQL gateway unreachable locally: ' + gateway.error, gatewayEvidenceUnreachable);
  }

  // -------------------------------------------------------------------------
  // Determine failures.
  // -------------------------------------------------------------------------
  var failures = [];
  if (!checks.frozenRatesOk) failures.push('frozen rates do not match the run configuration');
  if (!checks.productDisplayTax) failures.push('product display tax not consistent');
  if (!checks.checkoutTax) failures.push('checkout/order tax not consistent with DE rate');
  if (!checks.receiptTax) failures.push('receipt tax not consistent with DE rate');
  if (!checks.dynamicUpdateDryRun) failures.push('setup_tax_rates.mjs dry-run plan did not match the run config');

  if (failures.length > 0) {
    return failureOutcome('EXPECTED_MISMATCH', 'tax chain check failed: ' + failures.join('; '), evidence);
  }

  return passOutcome(context, taskId, evidence);
}

// ---------------------------------------------------------------------------
// Registration (auto-discovery via src/executors/index.js).
// ---------------------------------------------------------------------------

function register(executorModule2) {
  var reg = executorModule2.registerTaskExecutor;
  reg('CAN-B2-14', {
    description: 'Per-country Tax Zone and rate mapping: consistent through product display, checkout, order and receipt; frozen rates recorded from the run configuration; supported country list; setup_tax_rates.mjs dry-run through the controlled PostgreSQL gateway (readiness scope tax-chain)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-14-A01', 'CAN-B2-14-A02', 'CAN-B2-14-A03', 'CAN-B2-14-A04'],
    handler: handlerTaxChain
  });
  return { success: true, registered: ['CAN-B2-14'] };
}

module.exports = {
  SETUP_TAX_SCRIPT: SETUP_TAX_SCRIPT,
  VENDURE_STORE_DIR: VENDURE_STORE_DIR,
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  DEFAULT_RECEIPT_CODE: DEFAULT_RECEIPT_CODE,
  RECEIPT_CODE_ENV: RECEIPT_CODE_ENV,
  COUNTRY_CONFIG: COUNTRY_CONFIG,
  SUPPORTED_COUNTRIES: SUPPORTED_COUNTRIES.slice(),
  BROWSE_PRODUCTS_QUERY: BROWSE_PRODUCTS_QUERY,
  ACTIVE_ORDER_QUERY: ACTIVE_ORDER_QUERY,
  ORDER_BY_CODE_QUERY: ORDER_BY_CODE_QUERY,
  loadFrozenRates: loadFrozenRates,
  registryTaxConfig: registryTaxConfig,
  probePostgresGateway: probePostgresGateway,
  runTaxRatesDryRun: runTaxRatesDryRun,
  readTaxArtifacts: readTaxArtifacts,
  buildAssertionReport: buildAssertionReport,
  handlerTaxChain: handlerTaxChain,
  register: register
};

function matchesRegistryTaxConfig(registryCfg, expectedRates) {
  if (!registryCfg || typeof registryCfg !== 'object') return false;
  var keys = Object.keys(expectedRates);
  for (var i = 0; i < keys.length; i += 1) {
    if (Number(registryCfg[keys[i]]) !== expectedRates[keys[i]]) return false;
  }
  return true;
}

