'use strict';

/**
 * Shared offline dry-run harness for the all-tasks readiness audit.
 *
 * Runs every canonical task executor through the real executor registry
 * (src/executors/index.js discover) with injected fake deps: a fake fetch
 * acting as the Shop/Admin API (never touches the network), a fake getEnv,
 * a fake clock, a real fs rooted at a temp workspace, and evidence written to
 * a temp evidence root. For each task it:
 *   1. builds a context like cli.js does for a single task,
 *   2. calls executor.handler(context) (executors return, never throw),
 *   3. derives the CLI-equivalent outcome via terminalState.finalizeTaskOutcome
 *      (same classification mapping the pipeline would apply),
 *   4. writes environment.json + the canonical 15-field record.json through
 *      evidenceCollector like finalizeTaskEvidence does,
 *   5. verifies the evidence tree and surfaces whether any secret canary value
 *      leaked into any written file.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..', '..');
const executorModule = require(path.join(repoRoot, 'src', 'executor'));
const executorsIndex = require(path.join(repoRoot, 'src', 'executors'));
const terminalState = require(path.join(repoRoot, 'src', 'terminalState'));
const evidenceCollector = require(path.join(repoRoot, 'src', 'evidenceCollector'));
const protectedPaths = require(path.join(repoRoot, 'src', 'protectedPaths'));
const manifestModule = require(path.join(repoRoot, 'src', 'manifest'));

const RESULT_PASS = terminalState.RESULT_PASS;
const RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
const COVERAGE_READINESS_SUBSET = 'readiness-subset';
const FAILURE_CLASSES = terminalState.FAILURE_CLASSES;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let _registered = false;
function registerAll() {
  executorModule.resetTaskExecutors();
  const outcome = executorsIndex.register(executorModule);
  _registered = true;
  return outcome;
}
function registry() {
  if (!_registered) registerAll();
  return executorModule;
}
function taskExecutor(taskId) {
  return registry().getTaskExecutor(taskId);
}
function listRegistered() {
  return registry().listTaskExecutors().slice().sort();
}

// ---------------------------------------------------------------------------
// Fake fetch: a tiny fake Shop/Admin API server routed by URL path + operation
// ---------------------------------------------------------------------------

// Realistic GraphQL response bodies for the operations the canonical executors
// call through shopApiSession / readOnlyShopApi / adminChannelInventory. Shapes
// are derived from the executor modules' own GraphQL documents and from the
// existing readOnlyShopApi tests (there are no per-executor live fixtures).
function operationResponse(op) {
  const DATA = {};
  if (/^login$/i.test(op)) {
    DATA.login = { __typename: 'CurrentUser', id: 'u1', identifier: 'buyer.one@example.com' };
  } else if (/channels/i.test(op)) {
    DATA.channels = { totalItems: 4, items: [
      { id: 'c1', code: 'germany-channel', token: 'de-token', currencyCode: 'EUR' },
      { id: 'c2', code: 'austria-channel', token: 'at-token', currencyCode: 'EUR' },
      { id: 'c3', code: 'hungary-channel', token: 'hu-token', currencyCode: 'HUF' },
      { id: 'c4', code: 'uk-channel', token: 'gb-token', currencyCode: 'GBP' }
    ] };
  } else if (/activeChannel/i.test(op)) {
    DATA.activeChannel = { id: 'c1', code: 'germany-channel', currencyCode: 'EUR' };
  } else if (/products/i.test(op)) {
    DATA.products = { totalItems: 1, items: [
      { id: 'p1', name: 'Design One', slug: 'design-one', enabled: true, variants: [
        { id: 'v1', sku: 'SKU-DE-1', name: 'Design One / S', price: 2500, currencyCode: 'EUR' }
      ]}
    ] };
  } else if (/activeOrder/i.test(op)) {
    DATA.activeOrder = {
      id: 'o1', code: 'ED-DRY-0001', state: 'AddingItems', active: true,
      totalQuantity: 1, currencyCode: 'EUR',
      subTotal: 2500, subTotalWithTax: 2975, shipping: 349, shippingWithTax: 349,
      total: 2849, totalWithTax: 3324,
      customer: { id: 'u1', firstName: 'Buyer', lastName: 'One', emailAddress: 'buyer.one@example.com' },
      taxSummary: [{ description: 'Standard Tax', taxRate: 19, taxTotal: 475 }],
      lines: [{
        id: 'l1', quantity: 1, unitPriceWithTax: 2975, linePriceWithTax: 2975,
        productVariant: { id: 'v1', name: 'Design One / S', sku: 'SKU-DE-1',
          product: { id: 'p1', name: 'Design One', slug: 'design-one', customFields: { designFee: 1000 } } }
      }],
      payments: [{ id: 'pay1', method: 'stripe-payment-intents', amount: 3324, state: 'Settled', transactionId: 'pi_test_dryrun' }]
    };
  } else if (/orderByCode/i.test(op)) {
    return operationResponse('activeOrder');
  } else if (/addItemToOrder/i.test(op)) {
    DATA.addItemToOrder = { __typename: 'Order', id: 'o1', code: 'ED-DRY-0001', totalQuantity: 1,
      lines: [{ id: 'l1', productVariant: { id: 'v1', name: 'Design One / S' }, quantity: 1 }] };
  } else if (/eligiblePaymentMethods/i.test(op)) {
    DATA.eligiblePaymentMethods = [{ id: 'stripe', code: 'stripe-payment-intents', name: 'Stripe', isEligible: true }];
  } else if (/eligibleShippingMethods/i.test(op)) {
    DATA.eligibleShippingMethods = [
      { id: 'carrier-de', name: 'carrier-de', price: 349, priceWithTax: 349, metadata: {} }
    ];
  } else if (/setOrderShippingMethod/i.test(op)) {
    DATA.setOrderShippingMethod = { __typename: 'Order', id: 'o1', code: 'ED-DRY-0001', totalQuantity: 1 };
  } else if (/setOrderShippingAddress/i.test(op)) {
    DATA.setOrderShippingAddress = { __typename: 'Order', id: 'o1', code: 'ED-DRY-0001', totalQuantity: 1 };
  } else if (/setSessionCurrencyCode/i.test(op)) {
    DATA.setSessionCurrencyCode = { __typename: 'Order', id: 'o1', code: 'ED-DRY-0001', totalWithTax: 3324, currencyCode: 'EUR' };
  } else if (/activeCustomer/i.test(op)) {
    DATA.activeCustomer = {
      id: 'u1', firstName: 'Buyer', lastName: 'One', emailAddress: 'buyer.one@example.com',
      customFields: { countryCode: 'DE', isDesigner: false, isKycVerified: true },
      addresses: [{ id: 'a1', country: { code: 'DE' } }]
    };
  } else if (/registerCustomerAccount/i.test(op)) {
    DATA.registerCustomerAccount = { __typename: 'Success', success: true };
  } else if (/setSessionCurrencyCode/i.test(op)) {
    DATA.setSessionCurrencyCode = { __typename: 'Order', id: 'o1', code: 'ED-DRY-0001', totalWithTax: 3324, currencyCode: 'EUR' };
  } else if (/__typename/i.test(op)) {
    DATA.__typename = 'Query';
  }
  return { data: DATA };
}

/**
 * Build the fake fetch. `scenario` selects the response set:
 *   'happy'      - operation-shaped data (above) at HTTP 200.
 *   'gql-nostack'- HTTP 200 with { errors: [{ message: 'boom' }] } (no stack).
 *   'non2xx'     - HTTP 500 with { errors: [{ message: 'server error' }] }.
 *   'malformed'  - HTTP 200 with an empty body.
 * `tokenResponses` optionally overrides per-vendure-token bodies (used by the
 * B1-03/B1-04 fixtures in the existing unit harness).
 */
/**
 * Per-channel token payloads for the read-only currency/visibility queries
 * (B1-03 / B1-04), mirroring tests/executorsE2E.test.js scenario helpers so a
 * correct happy-path run reaches a genuine observed PASS/READINESS_PASS.
 */
function tokenShopBody(token, query) {
  const CURRENCIES = { 'de-token': 'EUR', 'at-token': 'EUR', 'hu-token': 'HUF', 'gb-token': 'GBP' };
  const cur = CURRENCIES[token] || 'EUR';
  const isVisibility = /variants \{ id sku name/.test(query);
  if (isVisibility) {
    return {
      data: {
        products: { totalItems: 1, items: [
          { id: 'p1', name: 'Design One', slug: 'design-one', enabled: true, variants: [
            { id: 'v1', sku: 'SKU-' + token.toUpperCase(), name: 'Design One / S', price: 2500, currencyCode: cur }
          ]}
        ]}
      }
    };
  }
  return {
    data: {
      activeChannel: { code: token.replace('-token', '-channel'), currencyCode: cur },
      products: { totalItems: 1, items: [
        { name: 'Design One', variants: [{ price: 2500, currencyCode: cur }] }
      ]}
    }
  };
}

function makeFakeFetch(scenario) {
  return function fakeFetch(url, init) {
    const bodyText = init && init.body ? String(init.body) : '';
    const headers = init && init.headers ? init.headers : {};

    if (scenario === 'non2xx') {
      return Promise.resolve({ status: 500, ok: false, text: () => Promise.resolve(JSON.stringify({ errors: [{ message: 'server error' }] })) });
    }
    if (scenario === 'gql-nostack') {
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify({ errors: [{ message: 'boom' }] })) });
    }
    if (scenario === 'malformed') {
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('') });
    }
    // happy path: route by URL + operation name
    const token = headers['vendure-token'] || '';
    const opMatch = /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(bodyText);
    const op = opMatch ? opMatch[1] : '';
    // Currency/visibility probes are token-scoped so a happy B1-03/B1-04 run
    // observes per-country data.
    const isCountryProbe = /ActiveChannelProbe|activeChannel/.test(bodyText) || /products\(options/.test(bodyText);
    if (token && isCountryProbe) {
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(tokenShopBody(token, bodyText))) });
    }
    const body = JSON.stringify(operationResponse(op));
    return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(body) });
  };
}

// ---------------------------------------------------------------------------
// Fake env (names + values, with canary secrets where a secret would live)
// ---------------------------------------------------------------------------

const CANARY_PREFIX = '__CANARY_';
function canaryValue(name) {
  return CANARY_PREFIX + name + '_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 10);
}

/**
 * Build the fake getEnv. `mode` controls which vars are present:
 *   'ok'          - everything the executors need is present (canary values).
 *   'missing-env' - a required var is absent (names only in evidence).
 */
function makeGetEnv(mode) {
  // Values are canaries so the harness can assert none leaked into evidence.
  const env = {
    CHANNEL_TOKENS: JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' }),
    STAGING_URL: 'https://staging.tibella.eu',
    SHOP_ACCOUNT_PASSWORD_BUYER_ONE: canaryValue('buyer_one'),
    SHOP_ACCOUNT_PASSWORD_BUYER_TWO: canaryValue('buyer_two'),
    SHOP_ACCOUNT_PASSWORD_DESIGNER_DE: canaryValue('designer_de'),
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: canaryValue('superadmin'),
    STAGING_ADMIN_EMAIL: 'admin@example.com',
    STAGING_ADMIN_PASSWORD: canaryValue('staging_admin'),
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    STRIPE_TEST_SECRET_KEY: canaryValue('stripe_test'),
    STRIPE_SECRET_KEY: canaryValue('stripe'),
    STRIPE_API_BASE: 'https://api.stripe.com',
    CAN_B2_06_PRODUCT_SLUG: 'aurora-borealis-nails',
    CAN_B2_12_PRODUCT_SLUG: 'fixture-1-nail-design',
    CAN_B2_05_PRODUCT_SLUG: 'jelly-glue',
    CAN_B2_03_PRODUCT_SLUG: 'fixture-1-nail-design',
    CAN_B2_06_NAIL_SHAPE: 'short-oval',
    CAN_B2_06_FINGER: 'leftIndex',
    CAN_B1_06_ORDER_CODE: 'ED-DRY-0001',
    CAN_B2_14_RECEIPT_CODE: 'ED-RUN-0001',
    CAN_B1_04_EXPECTED_FIXTURE: '',
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || os.homedir()
  };
  if (mode === 'missing-env') {
    // Drop the single most load-bearing required env var so the executor's
    // first validation gate fires with CLIENT_INPUT_SCOPE.
    delete env.CHANNEL_TOKENS;
    delete env.SUPERADMIN_USERNAME;
    delete env.SUPERADMIN_PASSWORD;
    delete env.STAGING_ADMIN_EMAIL;
    delete env.STAGING_ADMIN_PASSWORD;
    delete env.VENDURE_ADMIN_API_URL;
    delete env.SHOP_ACCOUNT_PASSWORD_BUYER_ONE;
    delete env.SHOP_ACCOUNT_PASSWORD_BUYER_TWO;
    delete env.SHOP_ACCOUNT_PASSWORD_DESIGNER_DE;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Temp sandbox
// ---------------------------------------------------------------------------

/**
 * Expected-visibility fixture for CAN-B1-04 happy path: matches the
 * token-based visibility responses from tokenShopBody so variant isolation
 * can be genuinely verified (DE/AT/HU/GB each expose one product/variant).
 */
function b1_04Fixture() {
  var fixture = {};
  ['DE', 'AT', 'HU', 'GB'].forEach(function(country) {
    var token = ({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' })[country];
    var cur = ({ DE: 'EUR', AT: 'EUR', HU: 'HUF', GB: 'GBP' })[country];
    fixture[country] = [{
      id: 'p1', name: 'Design One', slug: 'design-one', enabled: true,
      variants: [{ id: 'v1', sku: 'SKU-' + token.toUpperCase(), name: 'Design One / S', enabled: true, price: 2500, currencyCode: cur }]
    }];
  });
  return fixture;
}

function makeSandbox(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dryrun-'));
  // cli.js resolves evidence under <root>/<baseDir>; baseDir defaults to
  // 'evidence' exactly like PIPELINE_EVIDENCE_BASE_DIR. Keep the same layout.
  const evidenceRoot = base; // resolveRoot(base, 'evidence') => base/evidence
  const evidenceBaseDir = 'evidence';
  const evidenceDir = path.join(base, 'evidence');
  const workspaceDir = path.join(base, 'workspace');
  const reportsDir = path.join(base, 'reports');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  return { base: base, evidenceDir: evidenceDir, evidenceRoot: evidenceRoot, evidenceBaseDir: evidenceBaseDir, workspaceDir: workspaceDir, reportsDir: reportsDir };
}

// ---------------------------------------------------------------------------
// Context builder (mirrors cli.js single-task context)
// ---------------------------------------------------------------------------

let manifestCache = null;
function getManifest() {
  if (manifestCache) return manifestCache;
  const result = manifestModule.loadManifest(path.join(repoRoot, 'manifest', 'acceptance-manifest.v0.4.json'));
  if (!result.valid) throw new Error('manifest load failed: ' + result.errors.join('; '));
  manifestCache = result.manifest;
  return manifestCache;
}
let registryCache = null;
function getRegistry() {
  if (registryCache) return registryCache;
  const result = manifestModule.loadRegistry();
  if (!result.valid) throw new Error('registry load failed: ' + result.errors.join('; '));
  registryCache = result.registry;
  return registryCache;
}
function taskFor(taskId) {
  const task = manifestModule.getTask(getManifest(), taskId);
  if (!task) throw new Error('no canonical task ' + taskId);
  return task;
}

function makeRunEnvRecord(runId, stagingUrl) {
  return {
    runId: runId,
    stagingUrl: stagingUrl || 'https://staging.tibella.eu',
    gitHead: '0000000000000000000000000000000000000000',
    revisionId: 'dryrun',
    scope: null,
    taskId: null
  };
}

function evidenceOptions(base) {
  return { root: base.evidenceRoot, baseDir: base.evidenceBaseDir };
}

function buildContext(taskId, sandbox, scenario, runId) {
  const task = taskFor(taskId);
  const env = makeGetEnv(scenario === 'missing-env' ? 'missing-env' : 'ok');
  // CAN-B1-04 needs an independent pinned expected-visibility fixture to
  // verify variant isolation; point it at the sandbox fixture.
  if (taskId === 'CAN-B1-04') {
    const fixturePath = path.join(sandbox.base, 'expected-visibility.json');
    fs.writeFileSync(fixturePath, JSON.stringify(b1_04Fixture(), null, 2) + '\n', 'utf8');
    env.CAN_B1_04_EXPECTED_FIXTURE = fixturePath;
  }
  const getEnv = () => env;
  const clock = () => new Date('2026-10-07T09:00:00.000Z');
  const fetchFn = makeFakeFetch(scenario);
  const stagingUrl = 'https://staging.tibella.eu';
  const runEnvRecord = makeRunEnvRecord(runId, stagingUrl);

  return {
    taskId: taskId,
    task: task,
    taskCard: manifestModule.toTaskCard(task, {}, getManifest()),
    plan: null,
    runEnvRecord: runEnvRecord,
    runId: runId,
    workspace: { workspaceId: 'ws-dryrun', workspacePath: sandbox.workspaceDir },
    outDir: path.join(sandbox.reportsDir, runId),
    repoRoot: repoRoot,
    stagingUrl: stagingUrl,
    environment: 'dryrun',
    deps: {
      getEnv: getEnv,
      fetch: fetchFn,
      clock: clock,
      fs: fs,
      mkdirSync: function(p) { return fs.mkdirSync(p, { recursive: true }); },
      writeFileSync: fs.writeFileSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      existsSync: fs.existsSync.bind(fs),
      execFileSync: function() { return Buffer.from(''); },
      execFile: function(file, args, options, cb) {
        // Support both (file, args, options, cb) and (file, args, cb).
        if (typeof options === 'function') { cb = options; options = undefined; }
        const err = Object.assign(new Error('dry-run: child process not executed: ' + file), { code: 'ENOENT', status: null });
        if (typeof cb === 'function') {
          cb(err, '', '');
          return;
        }
        return Promise.reject(err);
      },
      childProcess: { execFile: function() {}, execFileSync: function() { return Buffer.from(''); } },
      writeEvidenceFile: function(r2, t2, name2, content2, opts) {
        return evidenceCollector.writeEvidenceFile(r2, t2, name2, content2, Object.assign({ root: sandbox.evidenceRoot, baseDir: sandbox.evidenceBaseDir }, opts || {}));
      },
      writeTaskRecord: function(r2, t2, record2, opts) {
        return evidenceCollector.writeTaskRecord(r2, t2, record2, Object.assign({ root: sandbox.evidenceRoot, baseDir: sandbox.evidenceBaseDir }, opts || {}));
      },
      config: {
        evidenceRoot: sandbox.evidenceRoot,
        evidenceBaseDir: sandbox.evidenceBaseDir,
        pipelineWorkspaceRoot: sandbox.workspaceDir,
        shopApiUrl: stagingUrl + '/shop-api'
      }
    },
    registry: getRegistry(),
    fixtures: getRegistry()
  };
}

// ---------------------------------------------------------------------------
// Outcome + record finalization (mirrors cli.js finalizeTaskEvidence)
// ---------------------------------------------------------------------------

const CLEANUP_OK = { ok: true, success: true, error: null };

// Acceptance tasks whose outcome is gated on a genuine observed result rather
// than a copied manifest text. Mirrors cli.js GENUINE_ACTUAL_TASKS.
const GENUINE_ACTUAL_TASKS = ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16'];

function finalizeOutcome(execData, task) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: execData.evidence,
    expected: task.expectedResult,
    actual: execData.actual,
    executorEvidenceOk: execData.success === true,
    error: execData.error,
    errorCode: execData.errorCode,
    requireGenuineActual: GENUINE_ACTUAL_TASKS.indexOf(task.canonicalId) !== -1
  });
}

function buildCanonicalRecord(task, outcome, execData, runEnvRecord, runId, protectedHashes) {
  const manifest = getManifest();
  const source = manifest.source || {};
  return {
    canonicalId: task.canonicalId,
    summarySpecIds: task.summaryIds || [],
    referenceRevision: source.referenceCommit || null,
    executionRevision: runEnvRecord.revisionId || null,
    environmentIdentity: { runId: runId, workspacePath: null },
    commandInvocation: null,
    inputArtifactIds: task.requiredInputs || [],
    expectedResult: task.expectedResult,
    actualResult: execData.actual,
    exitErrorResult: { exitCode: execData.success ? 0 : 1, error: execData.error },
    generatedArtifacts: [],
    stateChanges: execData.success ? { success: true, actual: execData.actual } : null,
    cleanupResetResult: CLEANUP_OK,
    finalClassification: outcome.result === RESULT_PASS ? terminalState.TERMINAL_STATES.PASS_CANDIDATE : outcome.result,
    naReason: null,
    result: outcome.result,
    classification: outcome.classification || null,
    cause: outcome.cause || null,
    repairHistory: [],
    manualIntervention: null,
    protectedStartHash: protectedHashes,
    protectedEndHash: protectedHashes
  };
}

/**
 * Run one scenario for one canonical task. Returns a structured result with
 * the executor outcome (or a thrown error), the derived CLI-style outcome,
 * record/classification, the written evidence files, and the canary leak list.
 */
async function runScenario(taskId, scenario, runId) {
  const sandbox = makeSandbox('dryrun-' + taskId + '-');
  const ctx = buildContext(taskId, sandbox, scenario, runId);
  const executor = taskExecutor(taskId);
  let handlerOutcome = null;
  let threw = null;
  let stackedError = null;

  if (!executor) {
    return {
      taskId: taskId,
      scenario: scenario,
      runId: runId,
      executorRegistered: false,
      handlerOutcome: null,
      threw: 'NO_EXECUTOR',
      stackedError: null,
      outcome: { result: 'BLOCK', classification: FAILURE_CLASSES.PIPELINE_DEFECT, cause: 'NOT_IMPLEMENTED' },
      recordPath: null,
      evidenceFiles: [],
      canaryLeaks: [],
      sandbox: sandbox
    };
  }

  try {
    handlerOutcome = await executor.handler(ctx);
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
    stackedError = e && e.stack ? e.stack : null;
  }

  const execData = {
    success: !!(handlerOutcome && handlerOutcome.success),
    actual: handlerOutcome && handlerOutcome.actual !== undefined ? handlerOutcome.actual : null,
    evidence: (handlerOutcome && handlerOutcome.evidence) || null,
    error: (handlerOutcome && handlerOutcome.error) || null,
    errorCode: (handlerOutcome && handlerOutcome.errorCode) || null
  };
  const outcome = finalizeOutcome(execData, ctx.task);

  // Coverage honesty, mirroring cli.js finalizeTaskEvidence: a readiness-subset
  // pass is reported as READINESS_PASS, never as a full pass.
  const covExec2 = executor;
  const coverage2 = (covExec2 && covExec2.coverage) || 'full';
  if (coverage2 === COVERAGE_READINESS_SUBSET && outcome.result === RESULT_PASS) {
    outcome.result = RESULT_READINESS_PASS;
  }
  let protectedHash = 'dryrun-hash';
  try {
    const info = protectedPaths.computeProtectedHashes({ root: repoRoot });
    if (info.ok) protectedHash = info.combinedHash;
  } catch (e) {
    protectedHash = 'dryrun-hash';
  }
  const record = buildCanonicalRecord(ctx.task, outcome, execData, ctx.runEnvRecord, runId, protectedHash);

  let recordPath = null;
  let evidenceFiles = [];
  const evOpts = { root: sandbox.evidenceRoot, baseDir: sandbox.evidenceBaseDir };
  try {
    // cli.js explicitly initializes the run-level index before any task write,
    // so the auto-init fallback (which re-appends the baseDir) is never hit.
    evidenceCollector.initEvidenceIndex(runId, {}, Object.assign({}, evOpts, { reuseExisting: true }));

    // environment.json documenting the input sources (names only).
    const envSources = (ctx.task.requiredInputs || []).map(function(id) {
      return { inputId: id, status: 'DRYRUN', source: 'dryrun-fake' };
    });
    evidenceCollector.writeEvidenceFile(runId, taskId, 'environment.json',
      JSON.stringify({ schemaVersion: '1.0', taskId: taskId, inputs: envSources }, null, 2),
      Object.assign({}, evOpts, { kind: 'environment', env: {} }));

    const covExec = executor;
    const coverage = (covExec && covExec.coverage) || 'full';
    const verifiedIds = (covExec && covExec.verifiedAssertionIds) || [];
    const mandatory = ctx.task.mandatoryAssertions || [];
    const coverageAssertions = {
      verified: mandatory.filter(function(a) { return verifiedIds.indexOf(a.id) !== -1; })
        .map(function(a) { return { id: a.id, text: a.text }; }),
      unverified: mandatory.filter(function(a) { return verifiedIds.indexOf(a.id) === -1; })
        .map(function(a) { return { id: a.id, text: a.text }; })
    };
    record.coverage = coverage;
    record.coverageAssertions = coverageAssertions;

    evidenceCollector.writeTaskRecord(runId, taskId, record,
      Object.assign({}, evOpts, { scriptTask: false, coverage: coverage, coverageAssertions: coverageAssertions }));
    recordPath = path.join(sandbox.evidenceDir, runId, taskId, 'record.json');

    // List every file the executor + harness produced for the task.
    const taskDir = path.join(sandbox.evidenceDir, runId, taskId);
    if (fs.existsSync(taskDir)) {
      fs.readdirSync(taskDir).forEach(function(f) { evidenceFiles.push(path.join(taskDir, f)); });
    }
  } catch (e) {
    threw = threw || (e && e.message ? e.message : String(e));
    if (!stackedError) stackedError = e && e.stack ? e.stack : null;
  }

  // Secret canary scan: any canary string leaking into a written file.
  const canaryLeaks = [];
  const env = makeGetEnv('ok');
  const canaries = Object.keys(env).map(function(k) { return env[k]; }).filter(function(v) { return String(v).indexOf(CANARY_PREFIX) !== -1; });
  evidenceFiles.concat(recordPath ? [recordPath] : []).forEach(function(file) {
    if (!fs.existsSync(file)) return;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    canaries.forEach(function(canary) {
      if (content.indexOf(canary) !== -1) canaryLeaks.push({ file: file, canary: canary });
    });
  });

  return {
    taskId: taskId,
    scenario: scenario,
    runId: runId,
    executorRegistered: true,
    handlerOutcome: handlerOutcome,
    threw: threw,
    stackedError: stackedError,
    outcome: outcome,
    record: record,
    recordPath: recordPath,
    evidenceFiles: evidenceFiles,
    canaryLeaks: canaryLeaks,
    sandbox: sandbox
  };
}

function cleanup(result) {
  if (result && result.sandbox) {
    fs.rmSync(result.sandbox.base, { recursive: true, force: true });
  }
}

function SHA256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

module.exports = {
  repoRoot: repoRoot,
  CANARY_PREFIX: CANARY_PREFIX,
  canaryValue: canaryValue,
  registerAll: registerAll,
  registry: registry,
  taskExecutor: taskExecutor,
  listRegistered: listRegistered,
  makeFakeFetch: makeFakeFetch,
  makeGetEnv: makeGetEnv,
  makeSandbox: makeSandbox,
  getManifest: getManifest,
  getRegistry: getRegistry,
  taskFor: taskFor,
  buildContext: buildContext,
  runScenario: runScenario,
  cleanup: cleanup,
  SHA256: SHA256,
  terminalState: terminalState,
  evidenceCollector: evidenceCollector,
  fs: fs,
  path: path
};
