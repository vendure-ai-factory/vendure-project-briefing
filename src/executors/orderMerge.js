'use strict';

/**
 * Order merging executor (CAN-B2-10).
 *
 * Canonical task: "Only paid, not-yet-exported, same-country orders merge;
 * different-country merge is rejected; a permitted merge recalculates weight,
 * shipping company, shipping price, tax, total and payment difference; an
 * exported order is no longer mergeable."
 *
 * Business rules (copied from source, never guessed):
 *   - PROJECT_OVERVIEW_EN.md section 7 and section 12.2: a paid but
 *     not-yet-exported order may be merged with a new product and the
 *     difference paid when the new product belongs to the same product
 *     country as the existing order; orders from different product countries
 *     may not be merged even if neither order has been exported.
 *   - account/orders/[code]/page.tsx:50: canMerge = !batchExportedAt && the
 *     order is in a paid state (PaymentSettled / PaymentAuthorized /
 *     ArrangingPayment / CollectingPayment).
 *   - The exported-order marker is the order custom field `batchExportedAt`
 *     (queries.ts:349-351 in the order list; mark_shipped_from_csv.sh:164-175
 *     sets it via setOrderCustomFields).
 *
 * Shop-API operations used (names and selection sets copied from source):
 *   - hasMergeableOrder              merge-operations.ts:3
 *   - getMergeableOrders             merge-operations.ts:9-30
 *   - mergeCartWithUnexportedOrder   merge-operations.ts:32-40
 *   - revertOrderMerge               merge-operations.ts:41-48
 *   - GetOrderDetailQuery (orderByCode) queries.ts:377-475
 *   - login                          mutations.ts:3-17 (shopApiSession)
 *   - addItemToOrder                 mutations.ts:19-42 (shopApiSession)
 *
 * Merge recalculation fields (from source):
 *   - weight: ProductVariant custom field `weight` in grams
 *     (german-post-calculator.ts:21 reads line.productVariant.customFields.weight;
 *     vendure-config.ts:120 defines the custom field; graphql-env.d.ts:199
 *     declares it).
 *   - shipping company: order.shippingLines[].shippingMethod.name
 *     (queries.ts:377 GetOrderDetailQuery shippingLines fragment).
 *   - shipping price: order.shipping / shippingWithTax (queries.ts:377).
 *   - tax: order.taxSummary[].taxTotal (queries.ts:377).
 *   - total: order.totalWithTax (queries.ts:377).
 *   - payment difference: order.totalWithTax minus the sum of the already
 *     recorded payment amounts (order.payments[] amount; queries.ts:377) -
 *     the extra amount paid at the final payment step after a merge.
 *
 * Safety (never relaxed):
 *   - The order-state mutations used to demonstrate a permitted merge (the
 *     cart addItemToOrder that builds the cart, and
 *     mergeCartWithUnexportedOrder) are only invoked when the run explicitly
 *     approves mutation (context.deps.allowOrderMerge === true). Without that
 *     explicit approval the executor performs the read-only checks (login,
 *     hasMergeableOrder, getMergeableOrders, dry-run) and lists the
 *     merge-and-recalculation assertions as unverified.
 *   - The supplied tools/mark_shipped_from_csv.sh is only ever run with
 *     DRY_RUN=true and a restricted child environment (no credentials
 *     forwarded, credential env NAMES recorded). The non-dry-run mode is
 *     never invoked.
 *   - No payment is ever created or cancelled by this executor; payment
 *     difference is computed from the order's existing payment records.
 *
 * The v0.4 manifest defines a single mandatory assertion CAN-B2-10-A01
 * covering the full expected result. The verified subset on a successful run
 * includes the merge-list preconditions (paid, not-yet-exported, same-country
 * orders only), the exported-order exclusion, the cross-country rejection, and
 * the recalculated weight / shipping company / shipping price / tax / total /
 * payment difference on the merged order when mutation is approved.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic account names from manifest/fixtures.v1.json (origin VERIFIED).
var BUYER_ACCOUNT = 'buyer.one@example.com';

// DE is the primary merge channel; AT is used for the cross-country rejection
// check (both use EUR but their country tracks must never merge,
// PROJECT_OVERVIEW_EN.md section 11 item 8).
var PRIMARY_COUNTRY = 'DE';
var OTHER_COUNTRY = 'AT';

// Paid states in which an order can still be shown for merging
// (account/orders/[code]/page.tsx:50 canMerge).
var PAID_STATES = ['PaymentSettled', 'PaymentAuthorized', 'ArrangingPayment', 'CollectingPayment'];

// Payment states that count as already paid for the payment-difference
// calculation (a settled or authorized Stripe charge on the order).
var PAID_PAYMENT_STATES = ['Settled', 'Authorized', 'PaymentSettled', 'PaymentAuthorized'];

// Repo-relative path of the supplied shipped-marker script (task note: only
// the dry-run mode may be used for the exported-order state).
var MARK_SHIPPED_SCRIPT = 'evaluation-demo/migration-input/legacy/vendure-store/tools/mark_shipped_from_csv.sh';

// Credential-holding env names that must never be forwarded to the dry-run
// child process (evidence records the names only, never the values).
var CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'VENDURE_ADMIN_TOKEN',
  'VENDURE_AUTH_TOKEN_HEADER',
  'STRIPE_SECRET_KEY'
];

var SHIPPED_FIXTURE_FILE = 'shipped-order-fixture.csv';

// ---------------------------------------------------------------------------
// GraphQL documents (names and selection sets copied from the source)
// ---------------------------------------------------------------------------

// hasMergeableOrder: merge-operations.ts:3.
var HAS_MERGEABLE_ORDER_QUERY = [
  'query HasMergeableOrder {',
  '  hasMergeableOrder',
  '}'
].join('\n');

// getMergeableOrders: merge-operations.ts:9-30 (the full selection set).
var GET_MERGEABLE_ORDERS_QUERY = [
  'query GetMergeableOrders {',
  '  getMergeableOrders {',
  '    id',
  '    code',
  '    totalWithTax',
  '    currencyCode',
  '    state',
  '    orderPlacedAt',
  '    shippingAddress {',
  '      fullName',
  '      streetLine1',
  '      city',
  '      postalCode',
  '      country',
  '      countryCode',
  '    }',
  '    shippingMethodId',
  '    shippingMethodName',
  '  }',
  '}'
].join('\n');

// mergeCartWithUnexportedOrder: merge-operations.ts:32-40.
var MERGE_CART_MUTATION = [
  'mutation MergeCartWithUnexportedOrder($targetOrderId: ID) {',
  '  mergeCartWithUnexportedOrder(targetOrderId: $targetOrderId) {',
  '    success',
  '    message',
  '    orderCode',
  '  }',
  '}'
].join('\n');

// revertOrderMerge: merge-operations.ts:41-48.
var REVERT_ORDER_MERGE_MUTATION = [
  'mutation RevertOrderMerge($orderCode: String!) {',
  '  revertOrderMerge(orderCode: $orderCode) {',
  '    success',
  '    message',
  '  }',
  '}'
].join('\n');

// Order detail selection for the merged order and the recalculation fields.
// Copied from GetOrderDetailQuery (queries.ts:377-475) with the variant
// `weight` custom field added (graphql-env.d.ts:199 / german-post-
// calculator.ts:21), because the whole task pivots on the recalculation.
var ORDER_MERGE_DETAIL_QUERY = [
  'query GetOrderMergeDetail($code: String!) {',
  '  orderByCode(code: $code) {',
  '    id',
  '    code',
  '    state',
  '    totalQuantity',
  '    subTotal',
  '    subTotalWithTax',
  '    shipping',
  '    shippingWithTax',
  '    total',
  '    totalWithTax',
  '    currencyCode',
  '    taxSummary {',
  '      description',
  '      taxRate',
  '      taxTotal',
  '    }',
  '    shippingLines {',
  '      priceWithTax',
  '      shippingMethod {',
  '        id',
  '        name',
  '        description',
  '      }',
  '    }',
  '    payments {',
  '      id',
  '      method',
  '      amount',
  '      state',
  '      transactionId',
  '    }',
  '    lines {',
  '      id',
  '      productVariant {',
  '        id',
  '        name',
  '        sku',
  '        customFields {',
  '          weight',
  '        }',
  '      }',
  '      quantity',
  '      unitPriceWithTax',
  '      linePriceWithTax',
  '    }',
  '    customFields {',
  '      batchExportedAt',
  '      isMergingWithOrderCode',
  '    }',
  '  }',
  '}'
].join('\n');

// ---------------------------------------------------------------------------
// Context helpers (delegate to the shared session module)
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
  var task = (context && context.task) || {};
  if (task.expectedResult) return task.expectedResult;
  return taskId;
}

function resultOrCall(step) {
  if (!step) return step;
  if (typeof step.success !== 'undefined') return step;
  return step;
}

function stepResponse(step) {
  if (step && step.response) return step.response;
  if (step && step.evidence && step.evidence.response) return step.evidence.response;
  return null;
}

function stepBody(step) {
  var response = stepResponse(resultOrCall(step));
  return response ? response.body : null;
}

function readData(step, pathArr) {
  var node = stepBody(step);
  for (var i = 0; i < pathArr.length; i++) {
    if (node === null || node === undefined) return null;
    node = node[pathArr[i]];
  }
  return node === undefined ? null : node;
}

function hasGraphQLErrors(step) {
  var response = stepResponse(step);
  return !!(response && response.body && response.body.errors && response.body.errors.length > 0);
}

function isNetworkDown(step) {
  var response = stepResponse(resultOrCall(step));
  if (!response) return false;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
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
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j++) {
        opts.secrets['orderMergeSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

var os = require('os');
var fs = require('fs');
var childProcess = require('child_process');

// ---------------------------------------------------------------------------
// Exported-order dry-run helper (mark_shipped_from_csv.sh, DRY_RUN only)
// ---------------------------------------------------------------------------

/**
 * Build the Chinese-column shipped fixture CSV the script consumes
 * (订单号,已发货 - the exact schema the script requires, see
 * mark_shipped_from_csv.sh:50-65). 已发货 = "1" marks a code as shipped-as-
 * the-test basis for an exported order.
 */
function buildShippedFixtureCsv(codes) {
  var lines = ['\uFEFF订单号,已发货'];
  var seen = {};
  (codes || []).forEach(function(code) {
    if (code && !seen[code]) {
      seen[code] = true;
      lines.push(code + ',1');
    }
  });
  if (lines.length === 1) lines.push('ED-RUN-NONE,0');
  return lines.join('\n') + '\n';
}

/**
 * Parse the marked order codes out of the script output. The script prints
 * each marked order code on its own line prefixed by two spaces, between
 * "Found N order(s)" and the DRY_RUN line (mark_shipped_from_csv.sh:73-74).
 */
function parseDryRunShippedCodes(output) {
  if (typeof output !== 'string') return [];
  var codes = [];
  var lines = output.split(/\r?\n/);
  var capturing = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/Found \d+ order\(s\) marked for shipment/.test(line)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (/^\s{2}\S+/.test(line)) {
        codes.push(line.trim());
      } else if (/DRY_RUN=true/.test(line)) {
        capturing = false;
      }
    }
  }
  return codes;
}

/**
 * Restrict the child environment to non-credential variables only. The
 * returned object records which credential env NAMES were dropped (only names,
 * never values).
 */
function restrictChildEnv(env, credentialNames) {
  var out = {};
  var dropped = [];
  var keys = Object.keys(env || {});
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (credentialNames.indexOf(key) !== -1) {
      dropped.push(key);
      continue;
    }
    out[key] = env[key];
  }
  return { env: out, droppedNames: dropped };
}

function repoRoot(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) return context.repoRoot;
  return process.cwd();
}

function getDryRunExecFile(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFile === 'function') return deps.execFile;
  if (deps.childProcess && typeof deps.childProcess.execFile === 'function') {
    return deps.childProcess.execFile.bind(deps.childProcess);
  }
  return childProcess.execFile;
}

function dryRunWorkspaceDir(context) {
  if (context && context.workspace && typeof context.workspace.workspacePath === 'string') {
    return context.workspace.workspacePath;
  }
  return os.tmpdir();
}

/**
 * Run tools/mark_shipped_from_csv.sh in DRY_RUN=true mode against a fixture
 * CSV that marks the given codes as shipped. Only invoked when the run
 * explicitly requests it (context.deps.runShippedDryRun === true) so unit
 * tests can inject a stub. Never runs non-dry-run.
 */
function runMarkShippedDryRun(context, codes) {
  var deps = context && context.deps ? context.deps : {};
  if (deps.runShippedDryRun !== true) {
    return Promise.resolve({ skipped: true, reason: 'dry-run not requested (deps.runShippedDryRun !== true)' });
  }
  var execFile = getDryRunExecFile(context);
  if (typeof execFile !== 'function') {
    return Promise.resolve({ skipped: true, reason: 'no injected execFile for the dry-run' });
  }
  var scriptPath = path.join(repoRoot(context), MARK_SHIPPED_SCRIPT);
  var dir = dryRunWorkspaceDir(context);
  var csvPath = path.join(dir, SHIPPED_FIXTURE_FILE);
  var csvBody = buildShippedFixtureCsv(codes || []);
  try {
    fs.writeFileSync(csvPath, csvBody, 'utf8');
  } catch (e) {
    return Promise.resolve({ skipped: true, reason: 'cannot write shipped fixture (' + e.message + ')' });
  }
  var baseEnv = deps.env || {};
  var restricted = restrictChildEnv(baseEnv, CREDENTIAL_ENV_NAMES.slice());
  var runEnv = Object.assign({}, restricted.env, {
    DRY_RUN: 'true',
    VENDURE_ADMIN_API_URL: '',
    VENDURE_ADMIN_TOKEN: ''
  });
  return new Promise(function(resolve) {
    execFile('bash', [scriptPath, csvPath], { env: runEnv }, function(err, stdout, stderr) {
      var out = String(stdout || '');
      var errText = String(stderr || '');
      if (err) {
        resolve({
          ok: false,
          skipped: false,
          error: 'mark_shipped_from_csv.sh dry-run failed: ' + (err.message || String(err)),
          stdout: out,
          stderr: errText,
          credentialEnvNames: restricted.droppedNames,
          csvPath: csvPath
        });
        return;
      }
      var codesOut = parseDryRunShippedCodes(out);
      resolve({
        ok: true,
        skipped: false,
        stdout: out,
        stderr: errText,
        codes: codesOut,
        apiCalled: out.indexOf('DRY_RUN=true; no API request was sent') === -1,
        credentialEnvNames: restricted.droppedNames,
        csvPath: csvPath
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Recalculation computation helpers
// ---------------------------------------------------------------------------

// Total line weight in grams: sum of (variant weight x quantity), exactly the
// formula german-post-calculator.ts:18-23 uses after a merge.
function orderWeightOf(order) {
  var lines = (order && order.lines) || [];
  var total = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || !line.productVariant) continue;
    var cw = line.productVariant.customFields || {};
    var weight = Number(cw.weight) || 0;
    var qty = Number(line.quantity) || 1;
    total += weight * qty;
  }
  return total;
}

// Sum of already recorded paid amounts on the order (payments fragment,
// queries.ts:377). This is what a permitted merge pays on top of.
function paidAmountOf(order) {
  var payments = (order && order.payments) || [];
  var total = 0;
  for (var i = 0; i < payments.length; i++) {
    var p = payments[i];
    if (p && PAID_PAYMENT_STATES.indexOf(p.state) !== -1) {
      total += Number(p.amount) || 0;
    }
  }
  return total;
}

// Shipping company name from the first shipping line's shippingMethod
// (queries.ts:377 shippingLines fragment).
function shippingCompanyOf(order) {
  var lines = (order && order.shippingLines) || [];
  for (var i = 0; i < lines.length; i++) {
    var method = lines[i] && lines[i].shippingMethod;
    if (method && typeof method.name === 'string' && method.name.length > 0) {
      return method.name;
    }
  }
  return null;
}

function taxTotalOf(order) {
  var summary = (order && order.taxSummary) || [];
  var total = 0;
  for (var i = 0; i < summary.length; i++) {
    total += Number(summary[i] && summary[i].taxTotal) || 0;
  }
  return total;
}

// Derive the recalculated values the task expects from the merged order.
function computeRecalculations(mergedOrder) {
  var order = mergedOrder || {};
  var totalWithTax = order.totalWithTax != null ? Number(order.totalWithTax) : null;
  var subTotalWithTax = order.subTotalWithTax != null ? Number(order.subTotalWithTax) : null;
  var shipping = order.shipping != null ? Number(order.shipping) : null;
  var shippingWithTax = order.shippingWithTax != null ? Number(order.shippingWithTax) : null;
  var paid = paidAmountOf(order);
  var weight = orderWeightOf(order);
  var taxTotal = taxTotalOf(order);
  return {
    weight: weight,
    shippingCompany: shippingCompanyOf(order),
    shipping: shipping,
    shippingWithTax: shippingWithTax,
    taxTotal: taxTotal,
    subTotalWithTax: subTotalWithTax,
    totalWithTax: totalWithTax,
    paidAmount: paid,
    paymentDifference: totalWithTax != null ? (totalWithTax - paid) : null,
    totalConsistent: totalWithTax != null && subTotalWithTax != null && shippingWithTax != null
      ? totalWithTax === subTotalWithTax + shippingWithTax
      : false
  };
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

/**
 * Build the verified/unverified assertion report for CAN-B2-10.
 *
 * The v0.4 manifest defines one mandatory assertion CAN-B2-10-A01 (the full
 * expected result). Verified claims depend on what the run could observe.
 */
function buildAssertionReport(observed, checks) {
  var verifiedClaims = [];
  var unverifiedClaims = [];

  if (checks.getMergeableOk && observed.mergeableList && observed.mergeableList.length > 0) {
    verifiedClaims.push({
      claim: 'getMergeableOrders returns mergeable orders (paid, same-country, unexported list)',
      verified: checks.paidOnly && checks.sameCountryOnly,
      observed: 'codes=' + (observed.mergeableCodes || []).join(',')
    });
  }
  if (observed.mergeableList && observed.mergeableList.length === 0) {
    unverifiedClaims.push({
      claim: 'same-country merge executes against a paid unexported order',
      why: 'no mergeable order was returned in this environment'
    });
  }

  verifiedClaims.push({
    claim: 'only paid orders are mergeable (unpaid orders excluded)',
    verified: checks.paidOnly,
    observed: 'states=' + (observed.mergeableStates || []).join(',')
  });
  verifiedClaims.push({
    claim: 'only same-country orders are mergeable (different-country merge rejected)',
    verified: checks.sameCountryOnly && (checks.crossCountryRejected === true),
    observed: 'crossCountryCodes=' + (observed.crossCountryCodes || []).join(',') + '; rejected=' + checks.crossCountryRejected
  });

  if (observable(checks.exportedExcluded)) {
    verifiedClaims.push({
      claim: 'an exported order is no longer mergeable',
      verified: checks.exportedExcluded,
      observed: 'shipped=' + (observed.shippedCodes || []).join(',') + '; leakedInList=' + (observed.shippedInMergeable || []).join(',')
    });
  } else {
    unverifiedClaims.push({
      claim: 'an exported order is no longer mergeable',
      why: 'no exported-order input supplied (shipped dry-run not requested or fixture absent)'
    });
  }

  if (checks.mergeAllowed === true && checks.mergeSucceeded === true && checks.recalcOk === true) {
    verifiedClaims.push({
      claim: 'a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference',
      verified: true,
      observed: JSON.stringify(observed.recalc || {})
    });
  } else if (!observed.mergeableList || observed.mergeableList.length === 0) {
    unverifiedClaims.push({
      claim: 'a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference',
      why: 'no mergeable order present to merge'
    });
  } else if (checks.mergeAllowed !== true) {
    unverifiedClaims.push({
      claim: 'a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference',
      why: 'order-state mutations not approved in this run (allowOrderMerge)'
    });
  } else {
    unverifiedClaims.push({
      claim: 'a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference',
      why: 'merge or recalculation was not fully verified (mergeSucceeded=' + checks.mergeSucceeded + ', recalcOk=' + checks.recalcOk + ')'
    });
  }

  verifiedClaims.push({
    claim: 'payment difference derived from the existing payment records (no payment created)',
    verified: checks.recalcPaymentDifference === true,
    observed: 'paid=' + (observed.recalc && observed.recalc.paidAmount) + ', diff=' + (observed.recalc && observed.recalc.paymentDifference)
  });

  return [{
    id: 'CAN-B2-10-A01',
    verified: verifiedClaims.length > 0 && verifiedClaims.every(function(c) { return c.verified; }),
    summary: 'Only paid, not-yet-exported, same-country orders merge; different-country merge is rejected; a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference; an exported order is no longer mergeable.',
    verifiedClaims: verifiedClaims,
    unverifiedClaims: unverifiedClaims
  }];
}

function observable(value) {
  return value === true || value === false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * CAN-B2-10 handler.  Flow:
 *   1. Resolve channel tokens (DE primary, AT for the cross-country check).
 *   2. Validate the buyer password env var is present (NAMES only).
 *   3. Login the buyer.
 *   4. hasMergeableOrder + getMergeableOrders (DE channel) - verify the list
 *      contains only paid, not-yet-exported, same-country orders.
 *   5. Optional mark_shipped_from_csv.sh dry-run to establish which orders are
 *      treated as exported; verify none of those codes are in the mergeable
 *      list (an exported order is no longer mergeable).
 *   6. If mutation is approved (deps.allowOrderMerge), build a cart, merge the
 *      chosen DE order, read the merged order and verify the recalculation of
 *      weight / shipping company / shipping price / tax / total / payment
 *      difference. Also attempt a cross-country (AT) merge that must be
 *      rejected. Whenever mutation is not approved those assertions are
 *      recorded unverified.
 */
async function handlerOrderMerge(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-10');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var allowOrderMerge = !!(context.deps && context.deps.allowOrderMerge === true);

  var observed = {};
  var checks = {
    channelTokensOk: false,
    envVarsOk: false,
    loginOk: false,
    hasMergeableQueryOk: false,
    getMergeableOk: false,
    sameCountryOnly: true,
    paidOnly: true,
    exportedExcluded: false,
    crossCountryRejected: null,
    mergeAllowed: allowOrderMerge,
    mergeSucceeded: false,
    recalcWeight: false,
    recalcShippingCompany: false,
    recalcShipping: false,
    recalcTax: false,
    recalcTotal: false,
    recalcPaymentDifference: false,
    recalcOk: false,
    dryRunNoApiCall: null
  };
  var rawRequests = [];
  var rawResponses = [];
  var steps = [];

  function writeMerits(files, secrets) {
    writeExecutorEvidence(context, taskId, files, secrets || []);
  }
  function writeApiEvidence(extraFiles, secrets) {
    var files = [];
    if (extraFiles) files = files.concat(extraFiles);
    files.unshift(
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'merge-table.json', data: { observed: observed, checks: checks }, kind: 'table' },
      { name: 'expected-vs-actual.json', data: { expected: taskExpectedText(context, taskId), actual: observed }, kind: 'assertion' }
    );
    writeMerits(files, secrets);
  }

  // -------------------------------------------------------------------------
  // 1. Channel tokens.
  // -------------------------------------------------------------------------
  var tokensResult = sessionModule.resolveChannelTokens(context);
  checks.channelTokensOk = tokensResult.ok;
  if (!tokensResult.ok) {
    var tokenEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeMerits([
      { name: 'executor-error.json', data: tokenEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', tokensResult.error, tokenEvidence);
  }

  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);

  // -------------------------------------------------------------------------
  // 2. Required inputs.
  // -------------------------------------------------------------------------
  var missingEnvVars = [];
  if (!envValue(context, 'SHOP_ACCOUNT_PASSWORD_BUYER_ONE')) missingEnvVars.push('SHOP_ACCOUNT_PASSWORD_BUYER_ONE');
  checks.envVarsOk = missingEnvVars.length === 0;
  if (missingEnvVars.length > 0) {
    var envEvidence = {
      taskId: taskId,
      source: 'ENVIRONMENT',
      checks: { envVarsResolved: false, missing: missingEnvVars },
      missingEnvVars: missingEnvVars,
      completedAt: timestamp
    };
    writeMerits([
      { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'missing required env vars: ' + missingEnvVars.join(', '), envEvidence);
  }

  if (!tokensResult.tokens[PRIMARY_COUNTRY] || !tokensResult.tokens[OTHER_COUNTRY]) {
    var tokenMissing = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + PRIMARY_COUNTRY + ' and ' + OTHER_COUNTRY },
      completedAt: timestamp
    };
    writeMerits([
      { name: 'executor-error.json', data: tokenMissing, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', tokenMissing.checks.error, tokenMissing);
  }

  var store = sessionModule.createSessionStore(context);
  store.ensure(BUYER_ACCOUNT);

  function recordStep(name, storeResult, pathArr) {
    var outcome = resultOrCall(storeResult);
    var response = stepResponse(outcome);
    var request = (outcome && outcome.request) || (outcome && outcome.evidence && outcome.evidence.request);
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
      success: typeof outcome.success === 'boolean' ? outcome.success : false,
      errorCode: (outcome && outcome.errorCode) || null,
      data: pathArr ? readData(outcome, pathArr) : null
    });
  }

  // -------------------------------------------------------------------------
  // 3. Buyer login.
  // -------------------------------------------------------------------------
  var loginOut = await store.login(BUYER_ACCOUNT);
  recordStep('buyer-login', loginOut, ['data', 'login']);
  checks.loginOk = loginOut.success === true;
  if (!checks.loginOk) {
    var loginFail = {
      taskId: taskId,
      step: 'buyer-login',
      steps: steps,
      errCode: loginOut.errorCode,
      error: loginOut.error,
      completedAt: timestamp
    };
    writeApiEvidence([
      { name: 'executor-error.json', data: loginFail, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(loginOut, taskId, loginFail);
  }

  // -------------------------------------------------------------------------
  // 4. hasMergeableOrder.
  // -------------------------------------------------------------------------
  var hasOut = await store.call(BUYER_ACCOUNT, HAS_MERGEABLE_ORDER_QUERY, {}, PRIMARY_COUNTRY);
  recordStep('has-mergeable-order', hasOut, ['data', 'hasMergeableOrder']);
  observed.hasMergeable = readData(hasOut, ['data', 'hasMergeableOrder']);
  if (isNetworkDown(hasOut)) {
    var downEvidence = {
      taskId: taskId,
      step: 'has-mergeable-order',
      error: 'shop-api down: ' + ((hasOut && hasOut.networkError) || 'HTTP down'),
      steps: steps,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeApiEvidence([
      { name: 'executor-error.json', data: downEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', downEvidence.error, downEvidence);
  }
  checks.hasMergeableQueryOk = !hasGraphQLErrors(hasOut);

  // -------------------------------------------------------------------------
  // 5. getMergeableOrders (DE channel) and list validation.
  // -------------------------------------------------------------------------
  var listOut = await store.call(BUYER_ACCOUNT, GET_MERGEABLE_ORDERS_QUERY, {}, PRIMARY_COUNTRY);
  recordStep('get-mergeable-orders', listOut, ['data', 'getMergeableOrders']);
  if (isNetworkDown(listOut)) {
    var listDown = {
      taskId: taskId,
      step: 'get-mergeable-orders',
      error: 'shop-api down: ' + ((listOut && listOut.networkError) || 'HTTP down'),
      steps: steps,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeApiEvidence([
      { name: 'executor-error.json', data: listDown, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', listDown.error, listDown);
  }
  if (hasGraphQLErrors(listOut)) {
    var listErr = {
      taskId: taskId,
      step: 'get-mergeable-orders',
      error: 'getMergeableOrders returned a GraphQL error',
      steps: steps,
      rawRequests: rawRequests,
      rawResponses: rawResponses,
      completedAt: timestamp
    };
    writeApiEvidence([
      { name: 'executor-error.json', data: listErr, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', listErr.error, listErr);
  }

  var mergeableList = readData(listOut, ['data', 'getMergeableOrders']);
  observed.mergeableList = Array.isArray(mergeableList) ? mergeableList : [];
  var validAny = false;
  if (Array.isArray(mergeableList)) {
    validAny = true;
    checks.getMergeableOk = true;
  }
  observed.mergeableCodes = observed.mergeableList.map(function(o) { return o && o.code; }).filter(Boolean);
  observed.mergeableStates = unique(observed.mergeableList.map(function(o) { return o && o.state; }).filter(Boolean));
  observed.mergeableCountries = unique(observed.mergeableList.map(function(o) {
    return o && o.shippingAddress && o.shippingAddress.countryCode;
  }).filter(Boolean));
  observed.crossCountryCodes = [];
  observed.unpaidCodes = [];
  observed.mergeableList.forEach(function(o) {
    var cc = o && o.shippingAddress && o.shippingAddress.countryCode;
    if (cc && cc.toUpperCase() !== PRIMARY_COUNTRY) observed.crossCountryCodes.push(o.code);
    if (o && o.state && PAID_STATES.indexOf(o.state) === -1) observed.unpaidCodes.push(o.code);
  });
  checks.sameCountryOnly = observed.crossCountryCodes.length === 0;
  checks.paidOnly = observed.unpaidCodes.length === 0;
  if (!validAny) {
    checks.getMergeableOk = false;
  }

  // -------------------------------------------------------------------------
  // 6. Exported-order state via mark_shipped_from_csv.sh dry-run (only the
  //    dry-run mode, never the real one).
  // -------------------------------------------------------------------------
  var shippedFixtureCodes = (context.deps && Array.isArray(context.deps.shippedFixtureCodes)) ? context.deps.shippedFixtureCodes : [];
  var dryRun = await runMarkShippedDryRun(context, shippedFixtureCodes);
  observed.shippedFixtureCodes = shippedFixtureCodes.slice();
  observed.shippedDryRun = {
    skipped: dryRun.skipped,
    reason: dryRun.reason || null,
    ok: dryRun.ok || false,
    codes: dryRun.codes || [],
    apiCalled: dryRun.apiCalled || null,
    stdout: dryRun.stdout || null,
    stderr: dryRun.stderr || null,
    credentialEnvNames: dryRun.credentialEnvNames || [],
    csvPath: dryRun.csvPath || null
  };
  observed.shippedCodes = dryRun.skipped ? [] : (dryRun.codes || []);
  if (!dryRun.skipped) {
    checks.dryRunNoApiCall = dryRun.ok === true && dryRun.apiCalled === false;
  }
  observed.shippedInMergeable = observed.shippedCodes.filter(function(code) {
    return observed.mergeableCodes.indexOf(code) !== -1;
  });
  // exportedExcluded is only testable when an exported-order code was supplied
  // for the dry-run; without an exported-order input it stays null (unverified).
  if (dryRun.skipped || observed.shippedCodes.length === 0) {
    checks.exportedExcluded = null;
  } else {
    checks.exportedExcluded = observed.shippedInMergeable.length === 0;
  }

  // -------------------------------------------------------------------------
  // 7. Cross-country rejection + permitted merge (only when mutation approved).
  // -------------------------------------------------------------------------
  observed.otherCountryList = [];
  observed.otherCountryMergeResult = null;
  observed.mergeResult = null;
  observed.mergedOrder = null;
  observed.recalc = null;

  if (allowOrderMerge) {
    var otherOut = await store.call(BUYER_ACCOUNT, GET_MERGEABLE_ORDERS_QUERY, {}, OTHER_COUNTRY);
    recordStep('get-mergeable-orders-' + OTHER_COUNTRY.toLowerCase(), otherOut, ['data', 'getMergeableOrders']);
    if (!isNetworkDown(otherOut) && !hasGraphQLErrors(otherOut)) {
      observed.otherCountryList = Array.isArray(readData(otherOut, ['data', 'getMergeableOrders']))
        ? readData(otherOut, ['data', 'getMergeableOrders'])
        : [];
    }
    var otherTarget = observed.otherCountryList.find(function(o) {
      var cc = o && o.shippingAddress && o.shippingAddress.countryCode;
      return cc && cc.toUpperCase() !== PRIMARY_COUNTRY;
    });
    if (otherTarget) {
      var crossMerge = await store.call(
        BUYER_ACCOUNT,
        MERGE_CART_MUTATION,
        { targetOrderId: otherTarget.id },
        PRIMARY_COUNTRY
      );
      recordStep('merge-cross-country-reject', crossMerge, ['data', 'mergeCartWithUnexportedOrder']);
      observed.otherCountryMergeResult = readData(crossMerge, ['data', 'mergeCartWithUnexportedOrder']);
      // A real server must reject the different-country merge.
      if (observed.otherCountryMergeResult) {
        checks.crossCountryRejected = observed.otherCountryMergeResult.success === false;
      }
    } else {
      checks.crossCountryRejected = null;
      observed.crossCountryNotTestable = 'no different-country order present in the ' + OTHER_COUNTRY + ' channel to test rejection';
    }

    // Permitted merge on the DE order.
    var target = observed.mergeableList
      .filter(function(o) {
        var cc = o && o.shippingAddress && o.shippingAddress.countryCode;
        return cc && cc.toUpperCase() === PRIMARY_COUNTRY;
      })[0];
    observed.mergeTargetId = target ? target.id : null;
    observed.mergeTargetCode = target ? target.code : null;
    if (target) {
      var cartOut = await store.addItemToOrder(BUYER_ACCOUNT, 'vl-merge-1', 1, PRIMARY_COUNTRY);
      recordStep('add-item-to-cart', cartOut, ['data', 'addItemToOrder']);
      var mergeOut = await store.call(
        BUYER_ACCOUNT,
        MERGE_CART_MUTATION,
        { targetOrderId: target.id },
        PRIMARY_COUNTRY
      );
      recordStep('merge-permitted', mergeOut, ['data', 'mergeCartWithUnexportedOrder']);
      observed.mergeResult = readData(mergeOut, ['data', 'mergeCartWithUnexportedOrder']);
      if (observed.mergeResult) {
        checks.mergeSucceeded = observed.mergeResult.success === true;
      } else {
        checks.mergeSucceeded = false;
      }

      if (checks.mergeSucceeded && observed.mergeResult.orderCode) {
        var detailOut = await store.call(
          BUYER_ACCOUNT,
          ORDER_MERGE_DETAIL_QUERY,
          { code: observed.mergeResult.orderCode },
          PRIMARY_COUNTRY
        );
        recordStep('merged-order-detail', detailOut, ['data', 'orderByCode']);
        observed.mergedOrder = readData(detailOut, ['data', 'orderByCode']);
        if (observed.mergedOrder) {
          observed.recalc = computeRecalculations(observed.mergedOrder);
          var rec = observed.recalc;
          checks.recalcWeight = typeof rec.weight === 'number' && rec.weight > 0;
          checks.recalcShippingCompany = typeof rec.shippingCompany === 'string' && rec.shippingCompany.length > 0;
          checks.recalcShipping = typeof rec.shippingWithTax === 'number' && rec.shippingWithTax > 0;
          checks.recalcTax = typeof rec.taxTotal === 'number' && rec.taxTotal > 0;
          checks.recalcTotal = rec.totalConsistent === true;
          checks.recalcPaymentDifference = typeof rec.paymentDifference === 'number' &&
            rec.paymentDifference >= 0 &&
            rec.paymentDifference === rec.totalWithTax - rec.paidAmount;
          checks.recalcOk = checks.recalcWeight && checks.recalcShippingCompany &&
            checks.recalcShipping && checks.recalcTax && checks.recalcTotal && checks.recalcPaymentDifference;
          observed.totalRecalculated = rec.totalWithTax;
          observed.baseTotalWithTax = target ? target.totalWithTax : null;
          observed.totalIncreasedAfterMerge = observed.baseTotalWithTax != null && rec.totalWithTax != null &&
            rec.totalWithTax > observed.baseTotalWithTax;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Build evidence and report.
  // -------------------------------------------------------------------------
  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Order merging: paid/unexported/same-country preconditions, cross-country rejection, recalculation, exported exclusion',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    buyerAccount: BUYER_ACCOUNT,
    primaryCountry: PRIMARY_COUNTRY,
    otherCountry: OTHER_COUNTRY,
    allowOrderMerge: allowOrderMerge,
    expected: {
      mergeableListOnlyPaid: 'getMergeableOrders returns only paid, not-yet-exported, same-country orders',
      crossCountryRejected: 'a different-country merge is rejected',
      recalculated: 'a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference',
      exportedNoLongerMergeable: 'an exported order is no longer mergeable'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    unverified: buildUnverifiedList(observed, checks),
    completedAt: timestamp
  };

  writeApiEvidence([
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  // -------------------------------------------------------------------------
  // Determine failures.
  // -------------------------------------------------------------------------
  var failures = [];
  if (!checks.getMergeableOk) failures.push('getMergeableOrders did not return a list');
  if (!checks.paidOnly) failures.push('unpaid order present in mergeable list (' + observed.unpaidCodes.join(',') + ')');
  if (!checks.sameCountryOnly) failures.push('different-country order present in mergeable list (' + observed.crossCountryCodes.join(',') + ')');
  if (observable(checks.exportedExcluded) && !checks.exportedExcluded) {
    failures.push('exported (shipped) order still mergeable (' + observed.shippedInMergeable.join(',') + ')');
  }
  if (checks.mergeAllowed === true) {
    if (checks.crossCountryRejected === false) failures.push('different-country merge was NOT rejected');
    if (observed.mergeTargetId && !checks.mergeSucceeded) failures.push('permitted same-country merge did not succeed');
    if (observed.mergedOrder && !checks.recalcOk) failures.push('recalculated values inconsistent on merged order');
  }

  if (failures.length > 0) {
    var detail = failures.join('; ');
    writeMerits([
      { name: 'executor-error.json', data: { taskId: taskId, error: 'order merge mismatch: ' + detail, checks: checks, observed: observed, completedAt: timestamp }, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', 'order merge mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

function unique(arr) {
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] !== null && arr[i] !== undefined && !seen[arr[i]]) {
      seen[arr[i]] = true;
      out.push(arr[i]);
    }
  }
  return out;
}

function buildUnverifiedList(observed, checks) {
  var out = [];
  if (!observed.mergeableList || observed.mergeableList.length === 0) {
    out.push('CAN-B2-10-A01: same-country merge not demonstrated (no mergeable order returned)');
  }
  if (checks.mergeAllowed !== true) {
    out.push('CAN-B2-10-A01: merged-order recalculation not exercised (order-state mutations not approved, allowOrderMerge=false)');
    out.push('CAN-B2-10-A01: cross-country merge rejection not exercised (merge mutation not approved)');
  } else {
    if (!checks.mergeSucceeded) out.push('CAN-B2-10-A01: permitted merge not verified as successful');
    if (!checks.recalcOk && observed.mergedOrder) out.push('CAN-B2-10-A01: recalculated weight/shipping/tax/total/payment difference not fully consistent');
    if (checks.crossCountryRejected !== true) out.push('CAN-B2-10-A01: different-country merge rejection not verified on a real cross-country order');
  }
  if (!observed.shippedDryRun || observed.shippedDryRun.skipped) {
    out.push('CAN-B2-10-A01: exported-order exclusion evidenced only from the shop list (no mark_shipped_from_csv.sh dry-run supplied)');
  } else if (observed.shippedDryRun.apiCalled !== false) {
    out.push('CAN-B2-10-A01: shipped dry-run did not prove no API request was sent');
  }
  out.push('CAN-B2-10-A01: real payment difference charged through the Stripe Runner is not exercised in this readiness run');
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-10', {
    description: 'Order merging: paid/unexported/same-country merge preconditions, cross-country rejection, recalculation of weight/shipping company/shipping price/tax/total/payment difference, exported-order exclusion (readiness scope order-merge)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-10-A01'],
    handler: handlerOrderMerge
  });
  return { success: true, registered: ['CAN-B2-10'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  PRIMARY_COUNTRY: PRIMARY_COUNTRY,
  OTHER_COUNTRY: OTHER_COUNTRY,
  PAID_STATES: PAID_STATES.slice(),
  PAID_PAYMENT_STATES: PAID_PAYMENT_STATES.slice(),
  MARK_SHIPPED_SCRIPT: MARK_SHIPPED_SCRIPT,
  SHIPPED_FIXTURE_FILE: SHIPPED_FIXTURE_FILE,
  CREDENTIAL_ENV_NAMES: CREDENTIAL_ENV_NAMES.slice(),
  HAS_MERGEABLE_ORDER_QUERY: HAS_MERGEABLE_ORDER_QUERY,
  GET_MERGEABLE_ORDERS_QUERY: GET_MERGEABLE_ORDERS_QUERY,
  MERGE_CART_MUTATION: MERGE_CART_MUTATION,
  REVERT_ORDER_MERGE_MUTATION: REVERT_ORDER_MERGE_MUTATION,
  ORDER_MERGE_DETAIL_QUERY: ORDER_MERGE_DETAIL_QUERY,
  buildShippedFixtureCsv: buildShippedFixtureCsv,
  parseDryRunShippedCodes: parseDryRunShippedCodes,
  restrictChildEnv: restrictChildEnv,
  runMarkShippedDryRun: runMarkShippedDryRun,
  orderWeightOf: orderWeightOf,
  paidAmountOf: paidAmountOf,
  shippingCompanyOf: shippingCompanyOf,
  computeRecalculations: computeRecalculations,
  buildAssertionReport: buildAssertionReport,
  handlerOrderMerge: handlerOrderMerge,
  register: register
};
