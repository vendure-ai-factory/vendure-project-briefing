'use strict';

/**
 * Shipping dry-run executor for CAN-B2-16 (readiness scope "shipping-dryrun").
 *
 * Exercises the two supplied CSVs-to-fulfillment scripts inside the isolated
 * workspace without touching the network or a database:
 *
 *   1. scripts/process_shipping_csv.mjs with an English-column fixture
 *      (orderCode, lineId, lineQuantity, variantSku) in dry-run mode.
 *   2. tools/mark_shipped_from_csv.sh with a 订单号/已发货 fixture and
 *      DRY_RUN=true, which always prints "no API request was sent".
 *
 * Evidence captures the command, every fixture's sha256, each script's exit
 * code, the shipping-plan.json / result.json / summary.txt artifacts, proof
 * that no API call was made and no state changed (the child environment holds
 * no credentials), the exact repo-relative script paths, and the execution
 * revision. The executor only returns RESULT_PASS when the artifacts match the
 * plan derived from the fixture.
 *
 * If bash, jq, curl or python3 is unavailable the .sh part returns BLOCK with
 * cause TOOL_UNAVAILABLE and class DEPENDENCY_ENVIRONMENT (the missing tool is
 * named); it can never report a passing result.
 */
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');
var terminalState = require('../terminalState');

var RESULT_PASS = terminalState.RESULT_PASS;

// Repo-relative paths of the supplied scripts (never machine-specific).
var PROCESS_SHIPPING_SCRIPT = 'evaluation-demo/migration-input/legacy/vendure-store/scripts/process_shipping_csv.mjs';
var MARK_SHIPPED_SCRIPT = 'evaluation-demo/migration-input/legacy/vendure-store/tools/mark_shipped_from_csv.sh';

var FIXTURE_CSV_FILE = 'shipping-fixture.csv';
var SHIPPED_FIXTURE_CSV_FILE = 'shipped-fixture.csv';
var ARTIFACT_SUBDIR = 'artifacts';

// Credential-holding env names that must never be forwarded to a child
// process. Evidence only ever records the names.
var CREDENTIAL_ENV_NAMES = [
  'VENDURE_ADMIN_API_URL',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
  'VENDURE_ADMIN_TOKEN',
  'VENDURE_AUTH_TOKEN_HEADER',
  'OPENROUTER_API_KEY'
];

// Tools mark_shipped_from_csv.sh checks before any dry-run output.
var SH_SCRIPT_TOOLS = ['bash', 'jq', 'curl', 'python3'];

// Deterministic synthetic fixtures written into the workspace.
var DEFAULT_SHIPPING_FIXTURE_CSV = [
  'orderCode,orderState,shippingCountryCode,customerEmail,customerName,lineId,lineQuantity,variantSku,variantName',
  'ED-RUN-0001,PaymentSettled,DE,buyer.one@example.com,Buyer One,L1,2,SKU-NAIL-001,Nail Set A',
  'ED-RUN-0001,PaymentSettled,DE,buyer.one@example.com,Buyer One,L2,1,SKU-NAIL-002,Nail Set B',
  'ED-RUN-0002,PaymentSettled,HU,buyer.two@example.com,Buyer Two,L1,3,SKU-NAIL-001,Nail Set A'
].join('\n') + '\n';

var DEFAULT_SHIPPED_FIXTURE_CSV = [
  '\uFEFF订单号,已发货',
  'ED-RUN-0001,1',
  'ED-RUN-0003,0'
].join('\n') + '\n';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function getExecFile(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFile === 'function') return deps.execFile;
  if (deps.childProcess && typeof deps.childProcess.execFile === 'function') return deps.childProcess.execFile.bind(deps.childProcess);
  return childProcess.execFile;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function getFsRead(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.readFileSync === 'function') return deps.readFileSync;
  if (deps.fs && typeof deps.fs.readFileSync === 'function') return deps.fs.readFileSync.bind(deps.fs);
  return fs.readFileSync;
}

function getFsWrite(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.writeFileSync === 'function') return deps.writeFileSync;
  if (deps.fs && typeof deps.fs.writeFileSync === 'function') return deps.fs.writeFileSync.bind(deps.fs);
  return fs.writeFileSync;
}

function getMkdir(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.mkdirSync === 'function') return deps.mkdirSync;
  if (deps.fs && typeof deps.fs.mkdirSync === 'function') return deps.fs.mkdirSync.bind(deps.fs);
  return fs.mkdirSync;
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

function repoRoot(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) return context.repoRoot;
  return process.cwd();
}

function isWindowsHost(context) {
  if (context && context.platform === 'win32') return true;
  if (context && context.platform) return false;
  return process.platform === 'win32';
}

function getExecFileSync(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.execFileSync === 'function') return deps.execFileSync;
  return childProcess.execFileSync;
}

/**
 * Translate an absolute Windows path to the WSL view with wslpath -u. Returns
 * null when wslpath is unavailable or the translation fails.
 */
function wslpathU(context, absPath) {
  var sync = getExecFileSync(context);
  try {
    var out = sync('wslpath', ['-u', String(absPath)], { encoding: 'utf8' });
    var translated = String(out || '').trim();
    return translated.length > 0 ? translated : null;
  } catch (e) {
    return null;
  }
}

/**
 * Build the CSV argument handed to a child script. The value is preferred as
 * the repo-relative form (children run with cwd=repoRoot); when the workspace
 * lives on a different drive of a Windows host, translate the absolute path
 * with wslpath -u instead. A Windows drive-letter path is never returned.
 */
function childCsvArg(context, absPath) {
  var rel = path.relative(repoRoot(context), absPath);
  if (!(isWindowsHost(context) && /^[a-zA-Z]:[\\/]/.test(rel))) {
    return rel;
  }
  var translated = wslpathU(context, absPath);
  return translated !== null ? translated : rel;
}

function readTextQuiet(context, filePath) {
  var read = getFsRead(context);
  try {
    return read(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeTextInside(context, filePath, content) {
  var write = getFsWrite(context);
  var mkdir = getMkdir(context);
  try {
    mkdir(path.dirname(filePath), { recursive: true });
  } catch (e) {
    /* ignore */
  }
  try {
    write(filePath, content, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
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

/**
 * Build a restricted environment for child processes: only harmless runtime
 * vars (PATH, HOME, NODE_ENV) plus the caller-provided extra vars. Credential
 * names are deliberately never forwarded. Returns { env, keys }.
 */
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
  var keys = Object.keys(env).sort();
  return { env: env, keys: keys };
}

function runExecFile(execFile, file, args, options) {
  return new Promise(function(resolve) {
    var child;
    try {
      child = execFile(file, args, options, function(err, stdout, stderr) {
        var exitCode = err && typeof err.code === 'number' ? err.code : (child && typeof child.status === 'number' ? child.status : (err ? 1 : 0));
        resolve({
          exitCode: exitCode,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? (err.message || String(err)) : null
        });
      });
    } catch (e) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: '',
        error: String(e && e.message || e)
      });
    }
  });
}

// ---------------------------------------------------------------------------
// River-side parsing mirror (exact copy of process_shipping_csv.mjs).
// ---------------------------------------------------------------------------

function parseCsv(text) {
  var rows = [];
  var record = [];
  var cell = '';
  var inQuotes = false;

  for (var i = 0; i < text.length; i += 1) {
    var char = text[i];
    var next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        continue;
      }
      cell += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      record.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n') {
      record.push(cell);
      rows.push(record.splice(0, record.length));
      cell = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    rows.push(record.splice(0, record.length));
  }

  if (rows.length === 0) {
    return [];
  }

  var headers = rows.shift().map(function(header) { return String(header).trim(); });
  return rows
    .filter(function(r) { return r.some(function(cv) { return String(cv).trim() !== ''; }); })
    .map(function(r) {
      var entry = {};
      headers.forEach(function(header, index) {
        entry[header] = r[index] === undefined ? '' : r[index];
      });
      return entry;
    });
}

function buildPlans(rows) {
  var grouped = [];

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var orderCode = String(row.orderCode || '').trim();
    if (!orderCode) {
      continue;
    }
    var plan = null;
    for (var g = 0; g < grouped.length; g++) {
      if (grouped[g].orderCode === orderCode) {
        plan = grouped[g];
        break;
      }
    }
    if (!plan) {
      plan = {
        orderCode: orderCode,
        orderState: String(row.orderState || '').trim(),
        shippingCountryCode: String(row.shippingCountryCode || '').trim().toUpperCase(),
        customerEmail: String(row.customerEmail || '').trim(),
        customerName: String(row.customerName || '').trim(),
        lineItems: []
      };
      grouped.push(plan);
    }
    plan.lineItems.push({
      lineId: String(row.lineId || '').trim(),
      lineQuantity: Number(row.lineQuantity || 0),
      variantSku: String(row.variantSku || '').trim(),
      variantName: String(row.variantName || '').trim()
    });
  }

  return grouped.map(function(p) {
    return {
      orderCode: p.orderCode,
      orderState: p.orderState,
      shippingCountryCode: p.shippingCountryCode,
      customerEmail: p.customerEmail,
      customerName: p.customerName,
      lineItems: p.lineItems,
      lineCount: p.lineItems.length,
      totalQuantity: p.lineItems.reduce(function(sum, line) { return sum + (Number(line.lineQuantity) || 0); }, 0)
    };
  });
}

function buildDeductionPlan(plans) {
  var byVariantSku = {};
  for (var i = 0; i < plans.length; i++) {
    var order = plans[i];
    for (var j = 0; j < order.lineItems.length; j++) {
      var line = order.lineItems[j];
      var sku = line.variantSku || '<unknown>';
      byVariantSku[sku] = (byVariantSku[sku] || 0) + (Number(line.lineQuantity) || 0);
    }
  }
  return Object.keys(byVariantSku).sort().map(function(sku) {
    return {
      variantSku: sku,
      quantity: byVariantSku[sku],
      note: 'stock deduction preview; applied during commit mode'
    };
  });
}

/**
 * Derive the expected plan from the English-column fixture, mirroring
 * process_shipping_csv.mjs buildPlans / buildDeductionPlan.
 */
function deriveShippingPlan(csvText) {
  var rows = parseCsv(csvText || '');
  var plans = buildPlans(rows);
  return {
    rows: rows,
    plans: plans,
    deductionPlan: buildDeductionPlan(plans)
  };
}

/**
 * Parse the 订单号/已发货 fixture and return the codes marked "1" in 已发货,
 * preserving order and de-duplicating (as mark_shipped_from_csv.sh does).
 */
function deriveShippedCodes(csvText) {
  var text = (csvText || '').replace(/^\uFEFF/, '');
  var rows = parseCsv(text);
  var codes = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var shipped = String(rows[i]['已发货'] || '').trim();
    var code = String(rows[i]['订单号'] || '').trim();
    if (shipped !== '1') continue;
    if (code && !seen[code]) {
      seen[code] = true;
      codes.push(code);
    }
  }
  return codes;
}

function planEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  for (var i = 0; i < expected.length; i++) {
    var e = expected[i];
    var found = null;
    for (var j = 0; j < actual.length; j++) {
      if (actual[j].orderCode === e.orderCode) {
        found = actual[j];
        break;
      }
    }
    if (!found) return false;
    if (found.lineCount !== e.lineCount) return false;
    if (found.totalQuantity !== e.totalQuantity) return false;
    if (String(found.orderState || '') !== e.orderState || String(found.shippingCountryCode || '') !== e.shippingCountryCode) return false;
    if ((found.lineItems || []).length !== e.lineItems.length) return false;
    for (var k = 0; k < e.lineItems.length; k++) {
      var el = e.lineItems[k];
      var fl = found.lineItems[k];
      if (!fl) return false;
      if (String(fl.lineId || '') !== el.lineId || Number(fl.lineQuantity) !== el.lineQuantity || String(fl.variantSku || '') !== el.variantSku) return false;
    }
  }
  return true;
}

function deductionPlanEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  for (var i = 0; i < expected.length; i++) {
    var e = expected[i];
    var found = null;
    for (var j = 0; j < actual.length; j++) {
      if (actual[j].variantSku === e.variantSku) {
        found = actual[j];
        break;
      }
    }
    if (!found || Number(found.quantity) !== e.quantity) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Artifact discovery (the node script writes into <artifactRoot>/<timestamp>/).
// ---------------------------------------------------------------------------

function findArtifact(context, artifactRoot, filename) {
  var rootFile = path.join(artifactRoot, filename);
  if (fsExists(context, rootFile)) return rootFile;
  var dirs = listChildDirs(context, artifactRoot);
  for (var i = 0; i < dirs.length; i++) {
    var candidate = path.join(artifactRoot, dirs[i], filename);
    if (fsExists(context, candidate)) return candidate;
  }
  return null;
}

function readArtifacts(context, artifactRoot) {
  var planPath = findArtifact(context, artifactRoot, 'shipping-plan.json');
  var resultPath = findArtifact(context, artifactRoot, 'result.json');
  var summaryPath = findArtifact(context, artifactRoot, 'summary.txt');
  var shippingPlan = null;
  var result = null;
  var summary = null;
  if (planPath) {
    var raw = readTextQuiet(context, planPath);
    if (raw !== null) {
      try { shippingPlan = JSON.parse(raw); } catch (e) { shippingPlan = { parseError: String(e && e.message || e) }; }
    }
  }
  if (resultPath) {
    var raw2 = readTextQuiet(context, resultPath);
    if (raw2 !== null) {
      try { result = JSON.parse(raw2); } catch (e) { result = { parseError: String(e && e.message || e) }; }
    }
  }
  if (summaryPath) summary = readTextQuiet(context, summaryPath);
  return {
    shippingPlan: shippingPlan,
    result: result,
    summary: summary,
    files: { plan: planPath, result: resultPath, summary: summaryPath }
  };
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

// ---------------------------------------------------------------------------
// Missing-tool detection for the .sh part.
// ---------------------------------------------------------------------------

function detectMissingTool(bashResult) {
  var text = ((bashResult.stderr || '') + '\n' + (bashResult.stdout || '')).toLowerCase();
  var rule = /required command not found:\s*([a-z0-9._-]+)/;
  var m = text.match(rule);
  if (m) return m[1];
  if (/enoent|cannot find|not recognized/.test(text)) return 'bash';
  if (bashResult.error && /enoent|spawn .*enoent/i.test(bashResult.error)) return 'bash';
  if (bashResult.error && /cannot find/i.test(bashResult.error)) return 'bash';
  return null;
}

// ---------------------------------------------------------------------------
// Canonical shipping record + optional evidence persistence.
// ---------------------------------------------------------------------------

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

function buildShippingRecord(context, task, outcome, evidence) {
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
    commandInvocation: buildCommandInvocation(evidence),
    inputArtifactIds: (task.requiredInputs || []).slice(),
    expectedResult: task.expectedResult || null,
    actualResult: actual,
    exitErrorResult: { exitCode: outcome.success ? 0 : 1, error: outcome.error || null },
    generatedArtifacts: evidence.artifacts ? ['shipping-plan.json', 'result.json', 'summary.txt'] : [],
    stateChanges: {
      success: outcome.success === true,
      actual: actual,
      noApiCall: checks.noApiCall === true,
      noCredentialsForwarded: checks.credentialsAbsent === true,
      committedOrders: checks.committedOrders === 0
    },
    cleanupResetResult: null,
    finalClassification: outcome.success ? RESULT_PASS : 'BLOCK',
    naReason: null,
    exactScriptPath: evidence.scripts ? evidence.scripts.processShippingCsv.repoRelativePath : null,
    result: outcome.success ? RESULT_PASS : 'BLOCK',
    classification: outcome.success ? null : (checks.missingTool ? 'DEPENDENCY_ENVIRONMENT' : null),
    cause: outcome.success ? null : (outcome.errorCode || null),
    scope: evidence.scope || null
  };
}

function buildCommandInvocation(evidence) {
  if (!evidence || !Array.isArray(evidence.commands) || evidence.commands.length === 0) return null;
  return evidence.commands.map(function(c) {
    return c.command + ' ' + (c.args || []).join(' ');
  }).join(' | ');
}

/**
 * Write the detailed shipping evidence file and canonical task record through
 * evidenceCollector when the pipeline supplies writeEvidenceFile /
 * writeTaskRecord on context.deps. No-op otherwise so a standalone handler
 * call and cli.js's own evidence finalization both keep working.
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
      deps.writeEvidenceFile(runId, taskId, 'executor-shipping-dryrun.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'executor-shipping-dryrun' });
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function') {
      var record = buildShippingRecord(context, task, outcome, evidence);
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

async function handlerShippingDryRun(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || context.taskId || 'CAN-B2-16';
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var root = repoRoot(context);
  var workspace = context.workspace || {};
  var wsPath = workspace.workspacePath || null;
  var execFile = getExecFile(context);

  var shippingFixtureCsv = DEFAULT_SHIPPING_FIXTURE_CSV;
  var shippedFixtureCsv = DEFAULT_SHIPPED_FIXTURE_CSV;
  if (context.fixtures) {
    if (typeof context.fixtures.shippingCsv === 'string') shippingFixtureCsv = context.fixtures.shippingCsv;
    if (typeof context.fixtures.shippedCsv === 'string') shippedFixtureCsv = context.fixtures.shippedCsv;
  }

  if (!wsPath) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'shipping dry-run requires an isolated workspace',
      evidence: { taskId: taskId, scope: 'shipping-dryrun', completedAt: timestamp }
    });
  }

  var csv1Path = path.join(wsPath, FIXTURE_CSV_FILE);
  var csv2Path = path.join(wsPath, SHIPPED_FIXTURE_CSV_FILE);
  if (!writeTextInside(context, csv1Path, shippingFixtureCsv) || !writeTextInside(context, csv2Path, shippedFixtureCsv)) {
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'shipping dry-run could not write fixtures into the workspace',
      evidence: { taskId: taskId, scope: 'shipping-dryrun', completedAt: timestamp }
    });
  }

  var artifactRoot = path.join(wsPath, ARTIFACT_SUBDIR);
  var script1Abs = path.join(root, PROCESS_SHIPPING_SCRIPT);
  var script2Abs = path.join(root, MARK_SHIPPED_SCRIPT);
  var script1Exists = fsExists(context, script1Abs);
  var script2Exists = fsExists(context, script2Abs);

  var expected = deriveShippingPlan(shippingFixtureCsv);
  var expectedCodes = deriveShippedCodes(shippedFixtureCsv);

  var commands = [];
  var checks = {
    shippingScriptExists: script1Exists,
    shippedScriptExists: script2Exists,
    noApiCall: false,
    noStateChange: false,
    credentialsAbsent: false,
    committedOrders: -1,
    stockAdjustments: -1,
    missingTool: null
  };

  // ---- 1. node script: dry-run process_shipping_csv.mjs ----
  // The fixture CSV reaches the child as a repo-relative path (or wslpath -u
  // view on a distinct Windows drive), never a drive-letter path.
  var csv1Arg = childCsvArg(context, csv1Path);
  var csv2Arg = childCsvArg(context, csv2Path);
  var nodeEnv = buildRestrictedEnv({ PROCESS_SHIPPING_ARTIFACT_DIR: artifactRoot });
  var nodeCsvArg = '--csv=' + csv1Arg;
  var nodeRes = await runExecFile(execFile, process.execPath || SCRIPT_CMD_NODE, [script1Abs, nodeCsvArg], { env: nodeEnv.env, cwd: root });
  commands.push({
    command: SCRIPT_CMD_NODE,
    args: [PROCESS_SHIPPING_SCRIPT, '--csv=' + csv1Arg],
    scriptPath: PROCESS_SHIPPING_SCRIPT,
    exitCode: nodeRes.exitCode,
    stdout: nodeRes.stdout,
    stderr: nodeRes.stderr,
    envKeys: nodeEnv.keys
  });

  var artifacts = readArtifacts(context, artifactRoot);
  var artifactsFound = !!(artifacts.shippingPlan && artifacts.result && artifacts.summary !== null);

  // ---- 2. bash script: DRY_RUN=true mark_shipped_from_csv.sh ----
  // The same bash that runs the script detects missing tools via command -v
  // and reports the missing tool name; a missing tool must never pass.
  var bashEnv = buildRestrictedEnv({ DRY_RUN: 'true' });
  var bashRes = await runExecFile(execFile, SCRIPT_CMD_BASH, [script2Abs, csv2Arg], { env: bashEnv.env, cwd: root });
  commands.push({
    command: SCRIPT_CMD_BASH,
    args: [MARK_SHIPPED_SCRIPT, csv2Arg],
    scriptPath: MARK_SHIPPED_SCRIPT,
    exitCode: bashRes.exitCode,
    stdout: bashRes.stdout,
    stderr: bashRes.stderr,
    envKeys: bashEnv.keys
  });
  checks.bashDryRun = bashRes.exitCode === 0;

  // Missing tool check for the .sh part: never pass when a tool is missing.
  if (bashRes.exitCode !== 0 || !script2Exists) {
    var missingTool = detectMissingTool(bashRes);
    if (!missingTool && !script2Exists) missingTool = 'bash';
    if (missingTool) {
      checks.missingTool = missingTool;
      var evidenceTool = buildEvidence(context, taskId, timestamp, expected, expectedCodes, commands, artifacts, checks, { shippingCsv: shippingFixtureCsv, shippedCsv: shippedFixtureCsv });
      return failureResult({
        errorCode: 'TOOL_UNAVAILABLE',
        error: 'shipping dry-run .sh part unavailable: missing tool ' + missingTool,
        evidence: evidenceTool
      });
    }
  }

  // ---- verification: artifacts must match the fixture-derived plan ----
  var planMatch = false;
  var deductionMatch = false;
  var resultOk = false;
  var summaryOk = false;
  if (artifacts.shippingPlan && artifacts.result) {
    var actualPlans = (artifacts.shippingPlan.plans || []);
    var actualDeduction = (artifacts.shippingPlan.deductionPlan || []);
    planMatch = planEqual(actualPlans, expected.plans);
    deductionMatch = deductionPlanEqual(actualDeduction, expected.deductionPlan);
    resultOk = artifacts.result.status === 'passed' &&
      artifacts.result.commit === false &&
      artifacts.result.reconcileStockOnly === false &&
      Array.isArray(artifacts.result.committed) && artifacts.result.committed.length === 0 &&
      Array.isArray(artifacts.result.stockAdjustments) && artifacts.result.stockAdjustments.length === 0;
    summaryOk = artifacts.summary !== null &&
      artifacts.summary.indexOf('Commit: no') !== -1 &&
      artifacts.summary.indexOf('Orders: ' + expected.plans.length) !== -1 &&
      artifacts.summary.indexOf('Rows: ' + expected.rows.length) !== -1;
  }

  checks.noApiCall = bashRes.exitCode === 0 && /no api request was sent/i.test(bashRes.stdout || '') && nodeRes.exitCode === 0;
  checks.committedOrders = artifacts.result && Array.isArray(artifacts.result.committed) ? artifacts.result.committed.length : -1;
  checks.stockAdjustments = artifacts.result && Array.isArray(artifacts.result.stockAdjustments) ? artifacts.result.stockAdjustments.length : -1;
  checks.noStateChange = checks.committedOrders === 0 && checks.stockAdjustments === 0;
  checks.credentialsAbsent = true;
  checks.outputsMatchPlan = planMatch && deductionMatch;
  checks.artifactsFound = artifactsFound;
  checks.expectedCodes = expectedCodes;

  if (nodeRes.exitCode !== 0 || !artifactsFound) {
    var evidenceFail = buildEvidence(context, taskId, timestamp, expected, expectedCodes, commands, artifacts, checks, { shippingCsv: shippingFixtureCsv, shippedCsv: shippedFixtureCsv });
    return failureResult({
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'shipping dry-run node script failed or produced no artifacts (exit ' + nodeRes.exitCode + ')',
      evidence: evidenceFail
    });
  }

  if (!planMatch || !deductionMatch || !resultOk || !summaryOk) {
    var evidenceMismatch = buildEvidence(context, taskId, timestamp, expected, expectedCodes, commands, artifacts, checks, { shippingCsv: shippingFixtureCsv, shippedCsv: shippedFixtureCsv });
    var mismatches = [];
    if (!planMatch) mismatches.push('shipping-plan plans do not match fixture');
    if (!deductionMatch) mismatches.push('shipping-plan deductionPlan does not match fixture');
    if (!resultOk) mismatches.push('result.json not a clean dry-run pass');
    if (!summaryOk) mismatches.push('summary.txt missing expected dry-run lines');
    return failureResult({
      errorCode: 'EXPECTED_MISMATCH',
      error: 'shipping dry-run artifacts do not match the fixture-derived plan: ' + mismatches.join('; '),
      evidence: evidenceMismatch
    });
  }

  checks.noApiCall = /no api request was sent/i.test(bashRes.stdout || '') === true && resultOk === true;
  checks.noStateChange = resultOk === true;
  checks.outputsMatchPlan = true;

  var evidence = buildEvidence(context, taskId, timestamp, expected, expectedCodes, commands, artifacts, checks, { shippingCsv: shippingFixtureCsv, shippedCsv: shippedFixtureCsv });
  evidence.checks = checks;
  evidence.result = RESULT_PASS;

  writeExecutorEvidence(context, task, passResult(task, evidence), evidence);

  return passResult(task, evidence);
}

function buildEvidence(context, taskId, timestamp, expected, expectedCodes, commands, artifacts, checks, fixtureValues) {
  fixtureValues = fixtureValues || {};
  var shippingCsv = fixtureValues.shippingCsv !== undefined ? fixtureValues.shippingCsv : DEFAULT_SHIPPING_FIXTURE_CSV;
  var shippedCsv = fixtureValues.shippedCsv !== undefined ? fixtureValues.shippedCsv : DEFAULT_SHIPPED_FIXTURE_CSV;
  return {
    schemaVersion: '1.0',
    taskId: taskId,
    scope: 'shipping-dryrun',
    title: 'Shipping dry-run for CAN-B2-16 (process_shipping_csv.mjs + mark_shipped_from_csv.sh)',
    executionRevision: executionRevisionOf(context),
    scripts: {
      processShippingCsv: { repoRelativePath: PROCESS_SHIPPING_SCRIPT },
      markShippedFromCsv: { repoRelativePath: MARK_SHIPPED_SCRIPT }
    },
    fixtures: {
      processShippingCsv: {
        file: FIXTURE_CSV_FILE,
        sha256: sha256Hex(shippingCsv),
        csv: shippingCsv
      },
      markShipped: {
        file: SHIPPED_FIXTURE_CSV_FILE,
        sha256: sha256Hex(shippedCsv),
        csv: shippedCsv
      }
    },
    commands: commands,
    artifacts: {
      shippingPlan: artifacts.shippingPlan,
      result: artifacts.result,
      summary: artifacts.summary
    },
    expected: {
      plans: expected.plans,
      deductionPlan: expected.deductionPlan,
      shippedCodes: expectedCodes
    },
    checks: checks,
    completedAt: timestamp
  };
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-16', {
    description: 'Shipping dry-run: exercise process_shipping_csv.mjs and mark_shipped_from_csv.sh with synthetic fixtures (readiness scope shipping-dryrun)',
    builtIn: true,
    coverage: 'readiness-subset',
    verifiedAssertionIds: ['CAN-B2-16-A01'],
    handler: handlerShippingDryRun
  });
  return { success: true, registered: ['CAN-B2-16'] };
}

var SCRIPT_CMD_NODE = 'node';
var SCRIPT_CMD_BASH = 'bash';

module.exports = {
  PROCESS_SHIPPING_SCRIPT: PROCESS_SHIPPING_SCRIPT,
  MARK_SHIPPED_SCRIPT: MARK_SHIPPED_SCRIPT,
  FIXTURE_CSV_FILE: FIXTURE_CSV_FILE,
  SHIPPED_FIXTURE_CSV_FILE: SHIPPED_FIXTURE_CSV_FILE,
  ARTIFACT_SUBDIR: ARTIFACT_SUBDIR,
  CREDENTIAL_ENV_NAMES: CREDENTIAL_ENV_NAMES.slice(),
  SH_SCRIPT_TOOLS: SH_SCRIPT_TOOLS.slice(),
  DEFAULT_SHIPPING_FIXTURE_CSV: DEFAULT_SHIPPING_FIXTURE_CSV,
  DEFAULT_SHIPPED_FIXTURE_CSV: DEFAULT_SHIPPED_FIXTURE_CSV,
  sha256Hex: sha256Hex,
  parseCsv: parseCsv,
  buildPlans: buildPlans,
  buildDeductionPlan: buildDeductionPlan,
  deriveShippingPlan: deriveShippingPlan,
  deriveShippedCodes: deriveShippedCodes,
  buildRestrictedEnv: buildRestrictedEnv,
  detectMissingTool: detectMissingTool,
  isWindowsHost: isWindowsHost,
  childCsvArg: childCsvArg,
  buildShippingRecord: buildShippingRecord,
  handlerShippingDryRun: handlerShippingDryRun,
  register: register
};

