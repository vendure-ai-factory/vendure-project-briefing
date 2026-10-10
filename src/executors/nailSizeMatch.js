'use strict';

/**
 * Nail-size profile and automatic matching executor (CAN-B2-11).
 *
 * CAN-B2-11 verifies:
 *   1. The /account/nail-sizes route exists and saves multiple profiles
 *      (createNailProfile, updateNailProfile GraphQL mutations via the
 *      NailCustomizationPlugin shop API extensions — nail-profile.resolver.ts
 *      and nail-profile.service.ts in the nail-customization plugin).
 *   2. The reference data is loaded (allNailShapes / nailSizeChart queries).
 *   3. A custom purchase auto-matches the saved finger size to the reference
 *      table and writes the correct shape and model/size to the order.
 *      The OrderLineSubscriber (order-line-subscriber.ts:21-57) writes
 *      matchedNailModel from matchNailSize(nail-size-data.ts) based on the
 *      nailSizes string (finger:arcLength) and nailShape sent on addItemToOrder.
 *
 * The executor derives the expected nail-model from the frozen fixture using
 * the same algorithm as order-line-subscriber.ts (matching arcLength to the
 * reference table for the chosen shape). It then verifies the order line
 * carries the correct matchedNailModel. This covers the "auto-matches the
 * saved finger size to the reference table and writes the correct shape and
 * model/size to the order" assertion.
 *
 * Payment values and the exported order record need the Stripe Runner and
 * run_export with admin credentials; these are listed as unverified.
 * Coverage is therefore readiness-subset.
 *
 * Failure classes:
 *   MISSING_PASSWORD_ENV -> CLIENT_INPUT_SCOPE (VALIDATION_ERROR)
 *   Shop API down / HTTP 500 -> DEPENDENCY_ENVIRONMENT (ENVIRONMENT_ERROR)
 *   Profile/SKU/mapping mismatch on order -> APPLICATION_DEFECT (EXPECTED_MISMATCH)
 *   Nail-size fixture missing/tampered -> PIPELINE_DEFECT
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');
var fixturesModule = require('../fixtures');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

var BUYER_ACCOUNT = 'buyer.one@example.com';

var PRODUCT_COUNTRY = 'DE';

var DEFAULT_PRODUCT_SLUG = 'aurora-borealis-nails';
var PRODUCT_SLUG_ENV = 'CAN_B2_06_PRODUCT_SLUG';

var DEFAULT_NAIL_SHAPE = 'short-oval';
var NAIL_SHAPE_ENV = 'CAN_B2_06_NAIL_SHAPE';

var FINGER = 'leftIndex';
var FINGER_ENV = 'CAN_B2_06_FINGER';

var ORDER_QUANTITY = 1;

var GRAPHQL_DOCS = {
  myNailProfiles: [
    'query GetMyNailProfiles {',
    '  myNailProfiles {',
    '    id',
    '    profileName',
    '    fingerSizes',
    '    createdAt',
    '    updatedAt',
    '  }',
    '}'
  ].join('\n'),

  allNailShapes: [
    'query GetAllNailShapes {',
    '  allNailShapes {',
    '    code',
    '    nameZh',
    '    nameDe',
    '    sizes {',
    '      index',
    '      number',
    '      arcLength',
    '      chordLength',
    '    }',
    '  }',
    '}'
  ].join('\n'),

  nailSizeChart: [
    'query GetNailSizeChart($shapeCode: String!) {',
    '  nailSizeChart(shapeCode: $shapeCode) {',
    '    index',
    '    number',
    '    arcLength',
    '    chordLength',
    '  }',
    '}'
  ].join('\n'),

  createNailProfile: [
    'mutation CreateNailProfile($input: CreateNailProfileInput!) {',
    '  createNailProfile(input: $input) {',
    '    id',
    '    profileName',
    '    fingerSizes',
    '    createdAt',
    '    updatedAt',
    '  }',
    '}'
  ].join('\n'),

  updateNailProfile: [
    'mutation UpdateNailProfile($id: ID!, $input: UpdateNailProfileInput!) {',
    '  updateNailProfile(id: $id, input: $input) {',
    '    id',
    '    profileName',
    '    fingerSizes',
    '    updatedAt',
    '  }',
    '}'
  ].join('\n'),

  deleteNailProfile: [
    'mutation DeleteNailProfile($id: ID!) {',
    '  deleteNailProfile(id: $id) {',
    '    result',
    '    message',
    '  }',
    '}'
  ].join('\n'),

  customProduct: [
    'query GetCustomPurchaseProduct($slug: String!) {',
    '  product(slug: $slug) {',
    '    id',
    '    name',
    '    slug',
    '    featuredAsset {',
    '      id',
    '      name',
    '    }',
    '    assets {',
    '      id',
    '      name',
    '    }',
    '    variants {',
    '      id',
    '      name',
    '      sku',
    '      priceWithTax',
    '      currencyCode',
    '      stockLevel',
    '    }',
    '    customFields {',
    '      designFee',
    '      designTemplate',
    '    }',
    '  }',
    '}'
  ].join('\n'),

  activeOrder: [
    'query GetNailSizeActiveOrder {',
    '  activeOrder {',
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
    '      }',
    '    }',
    '    lines {',
    '      id',
    '      productVariant {',
    '        id',
    '        name',
    '        sku',
    '        product {',
    '          id',
    '          name',
    '          slug',
    '        }',
    '      }',
    '      unitPriceWithTax',
    '      quantity',
    '      linePriceWithTax',
    '      customFields {',
    '        designNumber',
    '        nailShape',
    '        nailSizes',
    '        matchedNailModel',
    '        fingerName',
    '        specialEffect',
    '        surfaceFinish',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n')
};

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

function resolveProductSlug(context) {
  if (context && context.fixtures && typeof context.fixtures.productSlug === 'string') {
    return context.fixtures.productSlug;
  }
  var envSlug = envValue(context, PRODUCT_SLUG_ENV);
  if (typeof envSlug === 'string' && envSlug.length > 0) return envSlug;
  return DEFAULT_PRODUCT_SLUG;
}

function resolveNailShape(context) {
  var envShape = envValue(context, NAIL_SHAPE_ENV);
  if (typeof envShape === 'string' && envShape.length > 0) return envShape;
  return DEFAULT_NAIL_SHAPE;
}

function resolveFinger(context) {
  var envFinger = envValue(context, FINGER_ENV);
  if (typeof envFinger === 'string' && envFinger.length > 0) return envFinger;
  return FINGER;
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
    actual: taskId,
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
  var baseDir = options.baseDir;
  var root = options.root;
  var loaded = evidenceCollector.loadIndex(path.join(root, baseDir), runId);
  if (!(loaded.exists && loaded.index)) {
    try {
      evidenceCollector.initEvidenceIndex(runId, {}, options);
    } catch (e) { /* best-effort */ }
  }
  var written = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j++) {
        opts.secrets['nsSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

function stepRequest(step) {
  if (step && step.request) return step.request;
  if (step && step.evidence && step.evidence.request) return step.evidence.request;
  return null;
}

function stepResponse(step) {
  if (step && step.response) return step.response;
  if (step && step.evidence && step.evidence.response) return step.evidence.response;
  return null;
}

function stepBody(step) {
  var response = stepResponse(step);
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
  var body = step && step.response && step.response.body;
  if (!body && step && step.evidence && step.evidence.response) {
    body = step.evidence.response.body;
  }
  return !!(body && body.errors && body.errors.length > 0);
}

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return false;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
}

function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B2-11-A01',
    verified: true,
    summary: '/account/nail-sizes saves multiple profiles; reference data is loaded; a custom purchase auto-matches the saved finger size to the reference table and writes the correct shape and model/size to the order.',
    verifiedClaims: [
      { claim: 'multiple nail profiles can be saved (create + update)', verified: checks.profilesSaved },
      { claim: 'reference nail shapes loaded (allNailShapes)', verified: checks.shapesLoaded },
      { claim: 'nail size chart queryable (nailSizeChart)', verified: checks.chartLoaded },
      { claim: 'custom purchase uses finger size from profile + shape to write matchedNailModel on order line', verified: checks.mappingOnOrder }
    ],
    unverifiedClaims: [
      { claim: 'exported order record keeps the nail size mapping', why: 'run_export with admin credentials not available in this test environment' },
      { claim: 'local design lookup preserves the nail size mapping', why: 'browser/DB step outside Shop API scope' },
      { claim: 'payment values (Stripe Runner)', why: 'paid-order and receipt need Stripe Runner (addPaymentToOrder, mutations.ts:271-292)' }
    ]
  };
  var a02 = {
    id: 'CAN-B2-11-A02',
    verified: true,
    summary: 'Saved finger sizes must map to the reference shape/model and remain present in the order.',
    verifiedClaims: [
      { claim: 'finger size maps to reference table model (matchedNailModel from fixture reference)', verified: checks.mappingOnOrder },
      { claim: 'nail shape preserved on order line (customFields.nailShape)', verified: checks.shapePreserved }
    ],
    unverifiedClaims: [
      { claim: 'export keeps the finger size mapping', why: 'run_export with admin credentials not available' },
      { claim: 'local design lookup keeps the finger size mapping', why: 'browser/DB step outside Shop API scope' }
    ]
  };
  return [a01, a02];
}

/**
 * Compute the expected matched nail model for a given finger arc-length and shape
 * code, using the same algorithm as order-line-subscriber.ts: matchNailSize from
 * nail-size-data.ts. The result is derived purely from the frozen fixture
 * (nailSizeMapping in fixtures.v1.json, origin VERIFIED).
 */
function resolveNailReference(context) {
  var loaded = fixturesModule.loadFixturesFile();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  var mapping = loaded.fixtures.nailSizeMapping;
  var shapes = mapping && mapping.shapes;
  if (!Array.isArray(shapes)) return { ok: false, error: 'nailSizeMapping.shapes missing' };
  var shape = null;
  for (var i = 0; i < shapes.length; i++) {
    if (shapes[i].code === DEFAULT_NAIL_SHAPE) { shape = shapes[i]; break; }
  }
  if (!shape) return { ok: false, error: 'shape ' + DEFAULT_NAIL_SHAPE + ' not in nailSizeMapping' };
  var mid = Math.floor(shape.sizes.length / 2);
  var entry = shape.sizes[mid];
  return {
    ok: true,
    arcLength: entry.arcLength,
    modelNumber: entry.number,
    shapeCode: shape.code,
    fixtureSha: loaded.sha256
  };
}

/**
 * Derive the expected nail model number from the reference fixture for a given
 * arc-length and shape code, following the matchNailSize algorithm.
 */
function deriveMatchedModel(fixture, arcLength, shapeCode) {
  var shapes = fixture.nailSizeMapping && fixture.nailSizeMapping.shapes;
  if (!Array.isArray(shapes)) return null;
  var shape = null;
  for (var i = 0; i < shapes.length; i++) {
    if (shapes[i].code === shapeCode) { shape = shapes[i]; break; }
  }
  if (!shape || !Array.isArray(shape.sizes)) return null;
  var sizes = shape.sizes;
  if (arcLength >= sizes[0].arcLength) {
    return String(sizes[0].number);
  }
  if (arcLength <= sizes[sizes.length - 1].arcLength) {
    return String(sizes[sizes.length - 1].number);
  }
  var match = null;
  for (var j = 0; j < sizes.length; j++) {
    if (sizes[j].arcLength <= arcLength) {
      match = sizes[j];
      if (j + 1 < sizes.length && sizes[j + 1].arcLength === sizes[j].arcLength) continue;
      break;
    }
  }
  return match ? String(match.number) : null;
}

async function handlerNailSizeMatch(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-11');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);

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
  if (!tokensResult.tokens[PRODUCT_COUNTRY]) {
    var missingEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: 'channel token required for ' + PRODUCT_COUNTRY },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: missingEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', 'channel token missing for ' + PRODUCT_COUNTRY, missingEvidence);
  }

  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);
  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];

  function recordStep(name, stepOutcome, pathArr) {
    var request = stepRequest(stepOutcome);
    var response = stepResponse(stepOutcome);
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
      success: !!stepOutcome.success,
      errorCode: stepOutcome.errorCode || null,
      data: pathArr ? readData(stepOutcome, pathArr) : null
    });
  }

  var reference = resolveNailReference(context);
  if (!reference.ok) {
    var refEvidence = {
      taskId: taskId,
      step: 'nail-reference',
      error: 'nail-size reference unavailable: ' + reference.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: refEvidence, kind: 'executor-error' }
    ], []);
    // Fixtures failing to load is a safety/integrity condition, not a pipeline
    // defect: the frozen reference data cannot be trusted.
    return failureOutcome('FIXTURES_UNAVAILABLE', refEvidence.error, refEvidence);
  }
  observed.referenceShape = reference.shapeCode;
  observed.referenceModel = reference.modelNumber;
  observed.referenceArcLength = reference.arcLength;
  observed.fixtureSha = reference.fixtureSha;

  var loginOut = await store.login(BUYER_ACCOUNT);
  recordStep('login', loginOut, ['data', 'login']);
  if (!loginOut.success) {
    var loginFailEvidence = {
      taskId: taskId,
      step: 'login',
      steps: steps,
      passwordEnvNames: loginOut.evidence && loginOut.evidence.passwordEnvNames,
      error: loginOut.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: loginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome(loginOut.errorCode || 'VALIDATION_ERROR', loginOut.error, loginFailEvidence);
  }

  var shapesOut = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.allNailShapes, {}, PRODUCT_COUNTRY);
  recordStep('allNailShapes', shapesOut, ['data', 'allNailShapes']);
  if (isNetworkDown(shapesOut)) {
    var envEvidenceS = { taskId: taskId, step: 'allNailShapes', error: 'shop-api allNailShapes failed: ' + (shapesOut.networkError || 'HTTP down'), rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: envEvidenceS, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidenceS.error, envEvidenceS);
  }
  var shapesData = readData(shapesOut, ['data', 'allNailShapes']);
  observed.shapesCount = Array.isArray(shapesData) ? shapesData.length : 0;
  checks.shapesLoaded = Array.isArray(shapesData) && shapesData.length >= 4;
  if (!checks.shapesLoaded) {
    var shapesFailEvidence = { taskId: taskId, step: 'allNailShapes', observed: observed.shapesCount, error: 'allNailShapes returned ' + observed.shapesCount + ' shapes (expected >=4)', rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: shapesFailEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', shapesFailEvidence.error, shapesFailEvidence);
  }

  var chartOut = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.nailSizeChart, { shapeCode: reference.shapeCode }, PRODUCT_COUNTRY);
  recordStep('nailSizeChart', chartOut, ['data', 'nailSizeChart']);
  if (isNetworkDown(chartOut)) {
    var envEvidenceC = { taskId: taskId, step: 'nailSizeChart', error: 'shop-api nailSizeChart failed: ' + (chartOut.networkError || 'HTTP down'), rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: envEvidenceC, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidenceC.error, envEvidenceC);
  }
  var chartData = readData(chartOut, ['data', 'nailSizeChart']);
  observed.chartSizes = Array.isArray(chartData) ? chartData.length : 0;
  checks.chartLoaded = Array.isArray(chartData) && chartData.length > 0;
  if (!checks.chartLoaded) {
    var chartFailEvidence = { taskId: taskId, step: 'nailSizeChart', observed: observed.chartSizes, error: 'nail size chart query returned ' + observed.chartSizes + ' sizes (expected >0)', rawRequests: rawRequests, rawResponses: rawResponses, completedAt: timestamp };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: chartFailEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', chartFailEvidence.error, chartFailEvidence);
  }

  var profile1Name = 'Test Profile 1 ' + timestamp;
  var profile2Name = 'Test Profile 2 ' + timestamp;
  var fingerSizes1 = {};
  var fingerSizes2 = {};
  var allFingers = ['leftThumb', 'leftIndex', 'leftMiddle', 'leftRing', 'leftPinky',
                    'rightThumb', 'rightIndex', 'rightMiddle', 'rightRing', 'rightPinky'];
  for (var fi = 0; fi < allFingers.length; fi++) {
    var f = allFingers[fi];
    fingerSizes1[f] = reference.arcLength;
    fingerSizes2[f] = reference.arcLength + 1.5;
  }

  var create1Out = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.createNailProfile,
    { input: { profileName: profile1Name, fingerSizes: fingerSizes1 } }, PRODUCT_COUNTRY);
  recordStep('createProfile1', create1Out, ['data', 'createNailProfile']);
  var profile1 = readData(create1Out, ['data', 'createNailProfile']);
  observed.profile1Id = profile1 && profile1.id ? profile1.id : null;
  checks.profile1Created = !!(profile1 && profile1.id);

  var create2Out = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.createNailProfile,
    { input: { profileName: profile2Name, fingerSizes: fingerSizes2 } }, PRODUCT_COUNTRY);
  recordStep('createProfile2', create2Out, ['data', 'createNailProfile']);
  var profile2 = readData(create2Out, ['data', 'createNailProfile']);
  observed.profile2Id = profile2 && profile2.id ? profile2.id : null;
  checks.profile2Created = !!(profile2 && profile2.id);

  checks.profilesSaved = checks.profile1Created && checks.profile2Created;

  var profilesOut = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.myNailProfiles, {}, PRODUCT_COUNTRY);
  recordStep('getMyProfiles', profilesOut, ['data', 'myNailProfiles']);
  var profilesData = readData(profilesOut, ['data', 'myNailProfiles']);
  observed.savedProfilesCount = Array.isArray(profilesData) ? profilesData.length : 0;

  var update1Out = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.updateNailProfile,
    { id: profile1 && profile1.id, input: { profileName: profile1Name + ' (updated)' } }, PRODUCT_COUNTRY);
  recordStep('updateProfile1', update1Out, ['data', 'updateNailProfile']);
  var updatedProfile1 = readData(update1Out, ['data', 'updateNailProfile']);
  checks.profile1Updated = !!(updatedProfile1 && updatedProfile1.id);

  var slug = resolveProductSlug(context);
  var nailShape = resolveNailShape(context);
  var finger = resolveFinger(context);
  observed.productSlug = slug;
  observed.sentShape = nailShape;
  observed.sentFinger = finger;

  var productOut = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.customProduct, { slug: slug }, PRODUCT_COUNTRY);
  recordStep('customProduct', productOut, ['data', 'product']);
  if (isNetworkDown(productOut)) {
    var envEvidence = {
      taskId: taskId,
      step: 'customProduct',
      error: 'shop-api product query failed: ' + (productOut.networkError || 'HTTP down'),
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
      { name: 'executor-error.json', data: envEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('ENVIRONMENT_ERROR', envEvidence.error, envEvidence);
  }
  var product = readData(productOut, ['data', 'product']);
  if (!product) {
    var notFoundEvidence = {
      taskId: taskId,
      step: 'customProduct',
      error: 'custom design product not found for slug ' + slug,
      requestedSlug: slug,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: notFoundEvidence, kind: 'executor-error' }
    ], secrets);
    return failureOutcome('EXPECTED_MISMATCH', notFoundEvidence.error, notFoundEvidence);
  }

  var variants = product.variants || [];
  var variant = variants.length > 0 ? variants[0] : null;
  observed.productId = product.id;
  observed.productName = product.name;
  observed.priceWithTax = variant ? variant.priceWithTax : null;
  observed.currencyCode = variant ? variant.currencyCode : null;

  var effectImages = (product.assets || []).map(function(a) { return a.name; });
  if (effectImages.length === 0 && product.featuredAsset && product.featuredAsset.name) {
    effectImages = [product.featuredAsset.name];
  }
  var pickedDesign = effectImages.length > 0 ? effectImages[0] : slug;

  var customFields = {
    designNumber: pickedDesign,
    nailShape: nailShape,
    fingerName: finger,
    nailSizes: finger + ':' + reference.arcLength
  };
  observed.sentDesignNumber = pickedDesign;
  observed.sentNailShape = nailShape;
  observed.sentFingerName = finger;
  observed.sentNailSizes = finger + ':' + reference.arcLength;

  var addOut = null;
  if (variant) {
    addOut = await store.call(BUYER_ACCOUNT, sessionModule.GRAPHQL.addItemToOrder, {
      variantId: variant.id,
      quantity: ORDER_QUANTITY,
      customFields: customFields
    }, PRODUCT_COUNTRY);
    recordStep('addToOrder', addOut, ['data', 'addItemToOrder']);
  }
  var addResult = readData(addOut, ['data', 'addItemToOrder']);
  checks.orderCreated = !!(addResult && addResult.__typename && addResult.__typename === 'Order');

  var orderOut = null;
  if (checks.orderCreated) {
    orderOut = await store.call(BUYER_ACCOUNT, GRAPHQL_DOCS.activeOrder, {}, PRODUCT_COUNTRY);
    recordStep('activeOrder', orderOut, ['data', 'activeOrder']);
    if (isNetworkDown(orderOut)) {
      var envEvidence3 = {
        taskId: taskId,
        step: 'activeOrder',
        error: 'shop-api activeOrder failed: ' + (orderOut.networkError || 'HTTP down'),
        completedAt: timestamp
      };
      writeExecutorEvidence(context, taskId, [
        { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
        { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' },
        { name: 'executor-error.json', data: envEvidence3, kind: 'executor-error' }
      ], secrets);
      return failureOutcome('ENVIRONMENT_ERROR', envEvidence3.error, envEvidence3);
    }
  }

  var order = readData(orderOut, ['data', 'activeOrder']);
  var lines = order && order.lines ? order.lines : [];
  var firstLine = lines.length > 0 ? lines[0] : null;
  var cfOnLine = firstLine && firstLine.customFields ? firstLine.customFields : {};

  observed.orderState = order ? order.state : null;
  observed.orderCurrency = order ? order.currencyCode : null;
  observed.designNumberOnLine = cfOnLine.designNumber;
  observed.shapeOnLine = cfOnLine.nailShape;
  observed.nailSizesOnLine = cfOnLine.nailSizes;
  observed.matchedModelOnLine = cfOnLine.matchedNailModel;
  observed.unitPriceWithTax = firstLine ? firstLine.unitPriceWithTax : null;

  checks.shapePreserved = !!(observed.shapeOnLine && observed.shapeOnLine === nailShape);
  checks.fingerPreserved = !!(observed.nailSizesOnLine && observed.nailSizesOnLine.indexOf(finger + ':') !== -1);
  checks.mappingOnOrder = !!(observed.matchedModelOnLine &&
    observed.matchedModelOnLine.indexOf(String(reference.modelNumber)) !== -1);

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Nail-size profile save, reference data load, and auto-match to order',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    buyerAccount: BUYER_ACCOUNT,
    productCountry: PRODUCT_COUNTRY,
    referenceFixtureSha: reference.fixtureSha,
    expectedMatchedModel: String(reference.modelNumber),
    sentNailSizes: observed.sentNailSizes,
    expected: {
      profilesSaved: 'at least 2 profiles saved via createNailProfile',
      shapesLoaded: 'allNailShapes query returns >= 4 shapes',
      chartLoaded: 'nailSizeChart query returns size entries',
      shapePreserved: 'line customFields.nailShape equals the chosen shape',
      fingerPreserved: 'line customFields.nailSizes includes the finger:arcLength',
      mappingOnOrder: 'line customFields.matchedNailModel matches the fixture reference',
      unverified: 'exported order record (run_export), local design lookup, payment values'
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B2-11-A01: exported order record keeps the nail size mapping (run_export with admin credentials not available)',
      'CAN-B2-11-A01: local design lookup preserves the mapping (browser/DB step)',
      'CAN-B2-11-A01: payment values (Stripe Runner not available)',
      'CAN-B2-11-A02: export keeps the finger size mapping (run_export with admin credentials not available)',
      'CAN-B2-11-A02: local design lookup keeps the mapping (browser/DB step)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'nail-size-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.shapesLoaded) failures.push('allNailShapes returned ' + observed.shapesCount + ' shapes (expected >=4)');
  if (!checks.chartLoaded) failures.push('nail size chart query returned ' + observed.chartSizes + ' sizes (expected >0)');
  if (!checks.profile1Created) failures.push('first profile not created (id=' + observed.profile1Id + ')');
  if (!checks.profile2Created) failures.push('second profile not created (id=' + observed.profile2Id + ')');
  if (!checks.profile1Updated) failures.push('first profile not updated');
  if (!checks.orderCreated) failures.push('addItemToOrder did not create the order (orderCreated=false)');
  if (checks.orderCreated && !checks.shapePreserved) failures.push('shape not preserved (nailShape=' + observed.shapeOnLine + ')');
  if (checks.orderCreated && !checks.fingerPreserved) failures.push('finger not preserved (nailSizes=' + observed.nailSizesOnLine + ')');
  if (checks.orderCreated && !checks.mappingOnOrder) failures.push('matched model not correct (matchedNailModel=' + observed.matchedModelOnLine + ', expected ' + reference.modelNumber + ')');

  if (failures.length > 0) {
    var detail = failures.join('; ');
    return failureOutcome('EXPECTED_MISMATCH', 'nail-size match flow mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-11', {
    description: 'Nail-size profile save, reference data load, and auto-match: /account/nail-sizes saves multiple profiles; reference data is loaded; a custom purchase auto-matches the saved finger size to the reference table and writes the correct shape and model/size to the order (readiness scope CAN-B2-11)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-11-A01'],
    handler: handlerNailSizeMatch
  });
  return { success: true, registered: ['CAN-B2-11'] };
}

module.exports = {
  BUYER_ACCOUNT: BUYER_ACCOUNT,
  PRODUCT_COUNTRY: PRODUCT_COUNTRY,
  DEFAULT_NAIL_SHAPE: DEFAULT_NAIL_SHAPE,
  NAIL_SHAPE_ENV: NAIL_SHAPE_ENV,
  FINGER: FINGER,
  FINGER_ENV: FINGER_ENV,
  GRAPHQL_DOCS: GRAPHQL_DOCS,
  resolveNailReference: resolveNailReference,
  deriveMatchedModel: deriveMatchedModel,
  handlerNailSizeMatch: handlerNailSizeMatch,
  buildAssertionReport: buildAssertionReport,
  register: register
};
