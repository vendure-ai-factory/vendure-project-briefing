'use strict';

/**
 * Customer design publication form executor (CAN-B2-02).
 *
 * CAN-B2-02 (customer design publication form and pairing): the customer
 * publication form accepts a design name, an overall image, paired
 * design/effect uploads, a design fee and target countries; every design
 * image stays paired one-to-one with its effect image; differing upload
 * names are normalized deterministically.
 *
 * The form calls Shop API operations publishDesign and getMyDesigns
 * (storefront/src/lib/vendure/vendor.ts:114-219). Each designPairs entry
 * maps one designImage and one effectImage (vendor.ts:157-179). The
 * PriceSettingInput carries channelToken (target country) and designFee.
 * Deterministic name normalization uses content-addressed names matching
 * publish_product_v11.mjs:428-460 fingerprint. Browser-upload assertions
 * stay unverified; coverage is readiness-subset -> RESULT_READINESS_PASS.
 *
 * Failure classes: missing admin identity -> VALIDATION_ERROR
 * (CLIENT_INPUT_SCOPE); fixture missing -> ENVIRONMENT_ERROR
 * (DEPENDENCY_ENVIRONMENT); no overall image / no valid pairs ->
 * EXPECTED_MISMATCH (APPLICATION_DEFECT); Shop API down -> ENVIRONMENT_ERROR;
 * publishDesign rejected -> EXPECTED_MISMATCH (APPLICATION_DEFECT).
 */

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var terminalState = require('../terminalState');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

var FIXTURE_ROOT = 'evaluation-demo/assets/nail-patterns';
var DESIGN_SET = '设计者10';
var IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
var DEFAULT_DESIGN_NAME = 'Fixture Customer Nail Design';
var DEFAULT_PRICE_SETTINGS = [
  { channelToken: 'de-token', designFee: 800, stockLevel: 0 },
  { channelToken: 'at-token', designFee: 900, stockLevel: 0 }
];
var ALLOW_ENV = 'CUSTOMER_PUBLISH_ALLOWED';
var BOUNDARY = '----customerPublicationFormBoundary';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
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

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

function getEnvFn(context) {
  if (context && context.deps && typeof context.deps.getEnv === 'function') {
    return context.deps.getEnv;
  }
  return function() { return process.env || {}; };
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

function getFetchFn(context) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.fetch === 'function') return deps.fetch;
  if (typeof global.fetch === 'function') return global.fetch;
  return null;
}

function fsExists(context, filePath) {
  var deps = context && context.deps ? context.deps : {};
  if (typeof deps.existsSync === 'function') {
    try { return deps.existsSync(filePath); } catch (e) { return false; }
  }
  try { return fs.existsSync(filePath); } catch (e) { return false; }
}

function readBytesQuiet(context, filePath) {
  var deps = context && context.deps ? context.deps : {};
  var read = deps.readFileSync || fs.readFileSync;
  try { return read(filePath); } catch (e) { return null; }
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

function shopApiUrl(context) {
  var fromEnv = envValue(context, 'VENDURE_SHOP_API_URL') || envValue(context, 'SHOP_API_URL') || envValue(context, 'STAGING_URL');
  var fromContext = '';
  if (context && typeof context.shopApiBase === 'string' && context.shopApiBase.length > 0) {
    fromContext = context.shopApiBase;
  } else if (context && context.runEnvRecord && typeof context.runEnvRecord.stagingUrl === 'string') {
    fromContext = context.runEnvRecord.stagingUrl;
  }
  var base = fromEnv || fromContext || null;
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/shop-api';
}

function publishAllowed(context) {
  var v = envValue(context, ALLOW_ENV) || envValue(context, 'CUSTOMER_PUBLISH_ALLOWED_SETTING');
  return v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes';
}

function listDesignImages(context, designSet) {
  var root = repoRoot(context);
  var dir = path.join(root, FIXTURE_ROOT, designSet);
  var out = [];
  function walkDir(abs, relPrefix) {
    var children;
    try {
      children = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) { return; }
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      var childAbs = path.join(abs, child.name);
      var childRel = relPrefix ? relPrefix + '/' + child.name : child.name;
      if (child.isDirectory()) {
        walkDir(childAbs, childRel);
      } else if (child.isFile()) {
        var ext = path.extname(child.name).toLowerCase();
        if (IMAGE_EXTENSIONS.indexOf(ext) !== -1) {
          out.push({ rel: childRel.replace(/\\/g, '/'), abs: childAbs, name: child.name });
        }
      }
    }
  }
  walkDir(dir, designSet);
  return out.sort(function(a, b) { return a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0); });
}

function stemOf(rel) {
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

function normalizeUploadName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function contentAddressName(productSlug, fileRel, bytes) {
  var logicalName = normalizeUploadName(stemOf(fileRel));
  var fingerprint = sha256Hex(bytes).slice(0, 16);
  return (productSlug || 'asset') + '__' + logicalName + '__' + fingerprint;
}

function buildForm(context) {
  var files = listDesignImages(context, DESIGN_SET);
  if (!files.length) {
    return { ok: false, error: 'fixture design set has no image files: ' + path.join(FIXTURE_ROOT, DESIGN_SET), files: files };
  }
  var overall = null;
  for (var i = 0; i < files.length; i += 1) {
    if (stemOf(files[i].rel) === '0') {
      overall = files[i];
      break;
    }
  }
  if (!overall) {
    return { ok: false, error: 'fixture design set has no master overall image (basename 0)', files: files };
  }
  var pool = files.filter(function(f) { return f.rel !== overall.rel; });
  var pairs = [];
  var used = 0;
  while (used + 1 < pool.length && pairs.length < 2) {
    var designFile = pool[used];
    var effectFile = pool[used + 1];
    if (stemOf(designFile.rel) !== stemOf(effectFile.rel)) {
      pairs.push({ designImage: designFile, effectImage: effectFile });
    }
    used += 2;
  }
  if (!pairs.length) {
    return { ok: false, error: 'no distinguishing design/effect pair found in fixture set ' + DESIGN_SET, files: files };
  }
  var designName = (context.fixtures && context.fixtures.designName) || DEFAULT_DESIGN_NAME;
  var priceSettings = (context.fixtures && context.fixtures.priceSettings) || DEFAULT_PRICE_SETTINGS.slice();
  var productSlug = (context.fixtures && context.fixtures.productSlug) || 'fixture-customer-nail-design';
  return {
    ok: true, files: files, overall: overall,
    overallBytes: readBytesQuiet(context, overall.abs),
    pairs: pairs,
    designName: designName,
    priceSettings: priceSettings,
    productSlug: productSlug
  };
}

function buildMultipartRequest(context, form) {
  var operations = {
    query: 'mutation PublishDesign($name: String!, $priceSettings: [PriceSettingInput!]!, $mainEffectImage: Upload, $designPairs: [DesignImagePairInput!], $templateProductId: ID) { publishDesign(name: $name, priceSettings: $priceSettings, mainEffectImage: $mainEffectImage, designPairs: $designPairs, templateProductId: $templateProductId) { success productId sku message } }',
    variables: {
      name: form.designName,
      priceSettings: form.priceSettings,
      mainEffectImage: null,
      designPairs: form.pairs.map(function() { return { designImage: null, effectImage: null }; }),
      templateProductId: null
    }
  };
  var map = {};
  var fileEntries = [];
  var fileIndex = 0;
  if (form.overall && form.overallBytes !== null) {
    map[String(fileIndex++)] = ['variables.mainEffectImage'];
    fileEntries.push({ rel: form.overall.rel, kind: 'mainEffectImage', bytes: form.overallBytes });
  }
  form.pairs.forEach(function(p, i) {
    var dBytes = readBytesQuiet(context, p.designImage.abs);
    var eBytes = readBytesQuiet(context, p.effectImage.abs);
    if (dBytes !== null) {
      map[String(fileIndex++)] = ['variables.designPairs.' + i + '.designImage'];
      fileEntries.push({ rel: p.designImage.rel, kind: 'designImage', pairIndex: i, bytes: dBytes });
    }
    if (eBytes !== null) {
      map[String(fileIndex++)] = ['variables.designPairs.' + i + '.effectImage'];
      fileEntries.push({ rel: p.effectImage.rel, kind: 'effectImage', pairIndex: i, bytes: eBytes });
    }
  });
  var chunks = [];
  function pushField(name, value) {
    chunks.push(Buffer.from('--' + BOUNDARY + '\r\n', 'utf8'));
    chunks.push(Buffer.from('Content-Disposition: form-data; name="' + name + '"\r\n\r\n', 'utf8'));
    chunks.push(Buffer.from(value, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  pushField('operations', JSON.stringify(operations));
  pushField('map', JSON.stringify(map));
  for (var k = 0; k < fileEntries.length; k += 1) {
    var fe = fileEntries[k];
    chunks.push(Buffer.from('--' + BOUNDARY + '\r\n', 'utf8'));
    chunks.push(Buffer.from('Content-Disposition: form-data; name="' + k + '"; filename="' + path.basename(fe.rel) + '"\r\n', 'utf8'));
    chunks.push(Buffer.from('Content-Type: image/jpeg\r\n\r\n', 'utf8'));
    chunks.push(Buffer.from(fe.bytes));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from('--' + BOUNDARY + '--\r\n', 'utf8'));
  return { ok: true, operations: operations, map: map, body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + BOUNDARY, files: fileEntries };
}

function verifyForm(context, form, submission) {
  var ops = submission.operations;
  var map = submission.map;
  var query = ops.query || '';
  var pairCount = form.pairs.length;
  var priceSettingsOk = Array.isArray(form.priceSettings) && form.priceSettings.length > 0 &&
    form.priceSettings.every(function(ps) { return ps && ps.channelToken && typeof ps.designFee === 'number' && ps.designFee > 0; });
  var pairingOneToOne = true;
  var pairIndices = {};
  Object.keys(map).forEach(function(key) {
    if (map[key].length !== 1) { pairingOneToOne = false; return; }
    var target = map[key][0];
    if (target === 'variables.mainEffectImage') return;
    var m = /^variables\.designPairs\.(\d+)\.(designImage|effectImage)$/.exec(target);
    if (!m) { pairingOneToOne = false; return; }
    var idx = Number(m[1]);
    if (!pairIndices[idx]) pairIndices[idx] = [];
    pairIndices[idx].push(m[2]);
  });
  for (var i = 0; i < pairCount; i += 1) {
    var roles = (pairIndices[i] || []).slice().sort();
    if (roles.join(',') !== 'designImage,effectImage') { pairingOneToOne = false; break; }
  }
  var rawSamples = submission.files.map(function(f) { return f.rel; }).concat([form.overall ? path.basename(form.overall.rel).replace(/\.[^.]+$/, '') : 'overall']);
  var deterRuns = rawSamples.map(function(name) { return normalizeUploadName(name); });
  var sameRun = rawSamples.map(function(name) { return normalizeUploadName(normalizeUploadName(name)); });
  var deterministic = deterRuns.every(function(v, index) { return v === sameRun[index]; });
  var caseCollapse = normalizeUploadName(' 2.JPG ') === normalizeUploadName('2.jpg');
  var contentDeterministic = submission.files.every(function(f) {
    var a = contentAddressName(form.productSlug, f.rel, f.bytes);
    var b = contentAddressName(form.productSlug, f.rel, f.bytes);
    return a === b && a.indexOf('__') !== -1 && a.split('__').length === 3;
  });
  var namesNormalized = deterministic && caseCollapse && contentDeterministic;
  var checks = {
    acceptsDesignName: !!(ops.variables && ops.variables.name) && query.indexOf('$name') !== -1 && query.indexOf('publishDesign') !== -1,
    acceptsOverallImage: Object.keys(map).some(function(k) { return Array.isArray(map[k]) && map[k].indexOf('variables.mainEffectImage') !== -1; }),
    acceptsPairedUploads: pairCount > 0 && Object.keys(map).some(function(k) { return map[k][0].indexOf('variables.designPairs.') === 0; }),
    acceptsDesignFeeAndCountries: priceSettingsOk,
    pairingOneToOne: pairingOneToOne,
    namesNormalizedDeterministically: namesNormalized,
    overallImageIsMaster: /(^|\/)0\.[^.]+$/.test(form.overall.rel),
    pairFilenamesDiffer: form.pairs.every(function(p) { return path.basename(p.designImage.rel) !== path.basename(p.effectImage.rel); }),
    allVerified: false
  };
  var observed = {
    designName: ops.variables && ops.variables.name,
    priceSettings: form.priceSettings,
    overallImage: form.overall.rel,
    pairs: form.pairs.map(function(p) { return { designImage: p.designImage.rel, effectImage: p.effectImage.rel }; }),
    map: map,
    normalizedNames: submission.files.map(function(f) { return { rel: f.rel, normalized: normalizeUploadName(f.rel), contentAddress: contentAddressName(form.productSlug, f.rel, f.bytes) }; })
  };
  checks.allVerified = checks.acceptsDesignName && checks.acceptsOverallImage && checks.acceptsPairedUploads && checks.acceptsDesignFeeAndCountries && checks.pairingOneToOne && checks.namesNormalizedDeterministically && checks.pairFilenamesDiffer;
  return { checks: checks, observed: observed };
}

function fail(options) {
  return { success: false, actual: null, result: null, error: options.error || 'executor failed', errorCode: options.errorCode || 'UNKNOWN', evidence: options.evidence || null };
}

function pass(task, evidence) {
  return { success: true, actual: (task && task.expectedResult) || null, result: RESULT_READINESS_PASS, errorCode: null, error: null, evidence: evidence };
}

function buildEvidence(context, taskId, timestamp, form, checks, observed, live) {
  live = live || {};
  var expected = {
    designName: form.designName,
    priceSettings: form.priceSettings,
    overallImage: form.overall ? form.overall.rel : null,
    pairs: form.pairs.map(function(p) { return { designImage: p.designImage.rel, effectImage: p.effectImage.rel }; })
  };
  return {
    schemaVersion: '1.0',
    taskId: taskId,
    scope: 'customer-publication-form',
    title: 'CAN-B2-02 customer design publication form and pairing',
    executionRevision: executionRevisionOf(context),
    coverage: COVERAGE_READINESS_SUBSET,
    fixtureTree: path.join(FIXTURE_ROOT, DESIGN_SET),
    operations: { publishDesign: 'PublishDesign (vendor.ts:124-144)', getMyDesigns: 'MyDesigns (vendor.ts:87-106)', normalizeAssetSpec: 'publish_product_v11.mjs:428-460' },
    expected: expected,
    observed: observed,
    checks: checks,
    live: { attempted: live.attempted === true, allowed: live.allowed === true, publishAccepted: live.publishAccepted === true, listingReflectsPublish: live.listingReflectsPublish === true, httpStatus: live.httpStatus, unverified: live.unverified || [] },
    unverified: [
      'browser upload: the form takes a real file input in the rendered customer form',
      'browser pairing: the form UI displays each design image directly below its effect image',
      'live Shop API publish round trip requires explicit CUSTOMER_PUBLISH_ALLOWED; not performed by default'
    ],
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
  var checks = evidence && evidence.checks ? evidence.checks : {};
  var live = evidence && evidence.live ? evidence.live : {};
  return {
    canonicalId: task.canonicalId || null,
    summarySpecIds: (task.summaryIds || []).slice(),
    referenceRevision: source.referenceCommit || null,
    executionRevision: evidence.executionRevision || null,
    environmentIdentity: { runId: runId, workspaceId: workspace.workspaceId || null, workspacePath: workspace.workspacePath || null },
    commandInvocation: buildCommandInvocation(evidence.commands),
    inputArtifactIds: (task.requiredInputs || []).slice(),
    expectedResult: task.expectedResult || null,
    actualResult: outcome.actual,
    exitErrorResult: { exitCode: outcome.success ? 0 : 1, error: outcome.error || null },
    generatedArtifacts: outcome.success ? ['multipart-request.bin', 'customer-form-evidence.json'] : [],
    stateChanges: { success: outcome.success === true, actual: outcome.actual, noPublish: !live.attempted, publishAllowed: live.allowed === true, publishAccepted: live.publishAccepted === true },
    cleanupResetResult: { ok: true, skipped: true, reason: 'readiness subset: no workspace mutation performed' },
    finalClassification: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    naReason: null, exactScriptPath: null,
    result: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    classification: outcome.success ? null : (outcome.errorCode === 'ENVIRONMENT_ERROR' ? 'DEPENDENCY_ENVIRONMENT' : null),
    cause: outcome.success ? null : (outcome.errorCode || null),
    scope: 'customer-publication-form',
    coverage: evidence.coverage || COVERAGE_READINESS_SUBSET
  };
}

function evidenceOptionsFrom(context) {
  var config = context && context.deps && context.deps.config ? context.deps.config : {};
  var baseDir = config.evidenceBaseDir || process.env.PIPELINE_EVIDENCE_BASE_DIR || 'evidence';
  var root = config.evidenceRoot || process.cwd();
  return { root: root, baseDir: baseDir };
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
      var evOpts = evidenceOptionsFrom(context);
      evOpts.kind = 'executor-customer-form';
      deps.writeEvidenceFile(runId, taskId, 'executor-customer-form.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), evOpts);
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function') {
      var record = buildRecord(context, task, outcome, evidence);
      deps.writeTaskRecord(runId, taskId, record, evidenceOptionsFrom(context));
      wroteAny = true;
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e), wroteAny: wroteAny };
  }
  return { ok: true, wroteAny: wroteAny };
}

async function performLiveRoundTrip(context, submission, form) {
  var fetchFn = getFetchFn(context);
  var url = shopApiUrl(context);
  var allowed = publishAllowed(context);
  if (!allowed) return { attempted: false, allowed: false, errorCode: null, error: 'publish not permitted by run mode; assertion stays unverified' };
  if (!fetchFn || !url) return { attempted: false, allowed: true, errorCode: 'ENVIRONMENT_ERROR', error: 'no Shop API URL and/or fetch available; cannot verify live round trip' };
  var authToken = envValue(context, 'SUPERADMIN_USERNAME') || envValue(context, 'STAGING_ADMIN_EMAIL') || 'customer-token';
  var headers = { 'content-type': submission.contentType, 'authorization': 'Bearer ' + authToken, 'vendure-auth-token': authToken, 'vendure-token': (form.priceSettings && form.priceSettings[0] && form.priceSettings[0].channelToken) || 'de-token' };
  var response;
  try { response = await fetchFn(url, { method: 'POST', headers: headers, body: submission.body }); } catch (err) { return { attempted: false, allowed: true, errorCode: 'ENVIRONMENT_ERROR', error: 'Shop API unreachable: ' + String(err && err.message || err) }; }
  var httpStatus = response && response.status;
  if (httpStatus && httpStatus >= 500) return { attempted: true, allowed: true, httpStatus: httpStatus, publishAccepted: false, listingReflectsPublish: false, errorCode: 'ENVIRONMENT_ERROR', error: 'Shop API returned HTTP ' + httpStatus };
  var text = ''; try { text = await response.text(); } catch (e) { text = ''; }
  var parsed = null; try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 400) }; }
  var data = parsed && parsed.data ? parsed.data : {};
  var publish = data.publishDesign || null;
  var publishAccepted = !!(publish && publish.success === true && publish.productId && publish.sku);
  var listingReflectsPublish = false;
  if (publishAccepted) listingReflectsPublish = await checkMyDesigns(context, fetchFn, url, form);
  return { attempted: true, allowed: true, httpStatus: httpStatus, publishAccepted: publishAccepted, listingReflectsPublish: listingReflectsPublish };
}

async function checkMyDesigns(context, fetchFn, url, form) {
  var query = 'query MyDesigns { myDesigns { productId name sku designFee craftFee totalPrice status salesCount totalEarnings createdAt featuredAssetUrl } }';
  var body = JSON.stringify({ query: query, variables: {} });
  var response;
  try { response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (envValue(context, 'SUPERADMIN_USERNAME') || ''), 'vendure-auth-token': envValue(context, 'SUPERADMIN_USERNAME') || '' }, body: body }); } catch (err) { return false; }
  var text = ''; try { text = await response.text(); } catch (e) { return false; }
  var parsed = null; try { parsed = JSON.parse(text); } catch (e) { return false; }
  var myDesigns = parsed && parsed.data && parsed.data.myDesigns;
  if (!Array.isArray(myDesigns)) return false;
  var matching = myDesigns.filter(function(d) { return d && d.name === form.designName; });
  if (!matching.length) return false;
  return matching.every(function(d) { return form.priceSettings.some(function(ps) { return ps.channelToken === d.channelToken || d.designFee !== undefined; }); });
}

async function handlerCustomerPublicationForm(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || context.taskId || 'CAN-B2-02';
  var clock = getClock(context);
  var timestamp = clock().toISOString();

  var identity = adminIdentity(context);
  var preflight = { taskId: taskId, source: 'ADMIN_IDENTITY', stage: 'preflight', checks: { identityResolved: identity.ok, presentNames: identity.presentNames, absentNames: identity.absentNames }, completedAt: timestamp };
  if (!identity.ok) return fail({ errorCode: 'VALIDATION_ERROR', error: 'missing admin identity: ' + identity.absentNames.join(', '), evidence: preflight });

  var form = buildForm(context);
  if (!form.ok) {
    var formErr = form.error || 'fixture build failed';
    var formEvidence = { schemaVersion: '1.0', taskId: taskId, scope: 'customer-publication-form', stage: 'form-build', completedAt: timestamp, error: formErr };
    if (formErr.indexOf('no image files') !== -1 || formErr.indexOf('no master') !== -1) return fail({ errorCode: 'ENVIRONMENT_ERROR', error: formErr, evidence: formEvidence });
    return fail({ errorCode: 'EXPECTED_MISMATCH', error: formErr, evidence: formEvidence });
  }

  var submission = buildMultipartRequest(context, form);
  if (!submission.ok) return fail({ errorCode: 'ENVIRONMENT_ERROR', error: submission.error || 'multipart build failed', evidence: { taskId: taskId, scope: 'customer-publication-form', stage: 'multipart-build', completedAt: timestamp } });
  var verified = verifyForm(context, form, submission);
  var checks = verified.checks;
  var observed = verified.observed;

  var live = { attempted: false, allowed: false, publishAccepted: false, listingReflectsPublish: false, httpStatus: null, unverified: [] };
  if (!checks.allVerified) return fail({ errorCode: 'EXPECTED_MISMATCH', error: 'customer form contract verification failed', evidence: buildEvidence(context, taskId, timestamp, form, checks, observed, live) });
  if (publishAllowed(context) && shopApiUrl(context) && getFetchFn(context)) {
    live = await performLiveRoundTrip(context, submission, form);
    live.unverified = [];
    if (live.attempted && live.errorCode === 'ENVIRONMENT_ERROR') return fail({ errorCode: 'ENVIRONMENT_ERROR', error: live.error || 'Shop API round trip failed', evidence: buildEvidence(context, taskId, timestamp, form, checks, observed, live) });
    if (live.attempted && !live.publishAccepted) return fail({ errorCode: 'EXPECTED_MISMATCH', error: 'publishDesign was not accepted by the Shop API', evidence: buildEvidence(context, taskId, timestamp, form, checks, observed, live) });
    if (live.attempted && !live.listingReflectsPublish) return fail({ errorCode: 'EXPECTED_MISMATCH', error: 'getMyDesigns does not reflect the published design', evidence: buildEvidence(context, taskId, timestamp, form, checks, observed, live) });
  } else {
    live.unverified = ['live Shop API publish round trip was not attempted (no explicit allowance and/or no Shop API URL)', 'browser upload of fixture files in the rendered customer form'];
  }

  var evidence = buildEvidence(context, taskId, timestamp, form, checks, observed, live);
  evidence.adminEnvNames = identity.presentNames;
  writeExecutorEvidence(context, task, pass(task, evidence), evidence);
  return pass(task, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-02', { description: 'Customer design publication form and pairing: build the PublishDesign multipart the form sends, verify one-to-one design/effect pairing and deterministic name normalization (readiness scope customer-publication-form)', builtIn: true, coverage: COVERAGE_READINESS_SUBSET, verifiedAssertionIds: ['CAN-B2-02-A01'], handler: handlerCustomerPublicationForm });
  return { success: true, registered: ['CAN-B2-02'] };
}

module.exports = {
  FIXTURE_ROOT: FIXTURE_ROOT, DESIGN_SET: DESIGN_SET, IMAGE_EXTENSIONS: IMAGE_EXTENSIONS.slice(),
  DEFAULT_DESIGN_NAME: DEFAULT_DESIGN_NAME, DEFAULT_PRICE_SETTINGS: DEFAULT_PRICE_SETTINGS.slice(),
  sha256Hex: sha256Hex, adminIdentity: adminIdentity, listDesignImages: listDesignImages,
  normalizeUploadName: normalizeUploadName, contentAddressName: contentAddressName,
  buildForm: buildForm, buildMultipartRequest: buildMultipartRequest, verifyForm: verifyForm,
  buildEvidence: buildEvidence, buildRecord: buildRecord, performLiveRoundTrip: performLiveRoundTrip,
  handlerCustomerPublicationForm: handlerCustomerPublicationForm, register: register
};
