'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');

var executors = require('../src/executors/nailSizeMatch');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

function fakeClock() {
  return function() { return new Date('2026-10-09T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

var reference = (function() {
  var r = executors.resolveNailReference({});
  if (!r.ok) throw new Error('resolveNailReference failed: ' + r.error);
  return r;
})();

var EXPECTED_MODEL = String(reference.modelNumber);
var TEST_ARC_LENGTH = reference.arcLength;
var TEST_SHAPE = reference.shapeCode;

var PROFILE_COUNTER = 0;
function nextProfileName() {
  PROFILE_COUNTER++;
  return 'Test Profile ' + PROFILE_COUNTER + ' ' + Date.now();
}

function allFingers() {
  return ['leftThumb', 'leftIndex', 'leftMiddle', 'leftRing', 'leftPinky',
          'rightThumb', 'rightIndex', 'rightMiddle', 'rightRing', 'rightPinky'];
}

function fingerSizesFor(arcLength) {
  var result = {};
  var fingers = allFingers();
  for (var i = 0; i < fingers.length; i++) {
    result[fingers[i]] = arcLength;
  }
  return result;
}

var SHAPES_DATA = [
  { code: 'short-stiletto', nameZh: '短尖形', nameDe: 'Kurz Spitze Form', sizes: [
    { index: 1, number: '0', arcLength: 18 }, { index: 2, number: '1', arcLength: 16 },
    { index: 3, number: '2', arcLength: 15 }, { index: 4, number: '3', arcLength: 14 },
    { index: 5, number: '4', arcLength: 13.5 }, { index: 6, number: '5', arcLength: 13 },
    { index: 7, number: '6', arcLength: 12.5, chordLength: 9.8 }, { index: 8, number: '7', arcLength: 12.5, chordLength: 9.3 },
    { index: 9, number: '8', arcLength: 11 }, { index: 10, number: '8.5', arcLength: 10.5 },
    { index: 11, number: '9', arcLength: 10 }, { index: 12, number: '9.5', arcLength: 9 },
    { index: 13, number: '10', arcLength: 9 }, { index: 14, number: '10.5', arcLength: 8 },
    { index: 15, number: '11', arcLength: 7.5 }
  ]},
  { code: 'short-oval', nameZh: '短椭圆', nameDe: 'Kurz Oval', sizes: [
    { index: 1, number: '0', arcLength: 17.5 }, { index: 2, number: '1', arcLength: 17 },
    { index: 3, number: '2', arcLength: 16.5 }, { index: 4, number: '3', arcLength: 15 },
    { index: 5, number: '4', arcLength: 14.2, chordLength: 11.2 }, { index: 6, number: '5', arcLength: 14, chordLength: 10.6 },
    { index: 7, number: '6', arcLength: 13.3 }, { index: 8, number: '7', arcLength: 13 },
    { index: 9, number: '8', arcLength: 12.5 }, { index: 10, number: '8.5', arcLength: 11.5, chordLength: 8.9 },
    { index: 11, number: '9', arcLength: 11.5, chordLength: 8.5 }, { index: 12, number: '9.5', arcLength: 11 },
    { index: 13, number: '10', arcLength: 10 }, { index: 14, number: '10.5', arcLength: 9.5 },
    { index: 15, number: '11', arcLength: 8.5 }
  ]},
  { code: 'short-coffin', nameZh: '短棺材/芭蕾', nameDe: 'Kurz Sargform', sizes: [
    { index: 1, number: '0', arcLength: 18.5 }, { index: 2, number: '1', arcLength: 17 },
    { index: 3, number: '2', arcLength: 15.7, chordLength: 11.5 }, { index: 4, number: '3', arcLength: 15, chordLength: 11.2 },
    { index: 5, number: '4', arcLength: 14 }, { index: 6, number: '5', arcLength: 13.5 },
    { index: 7, number: '6', arcLength: 13 }, { index: 8, number: '7', arcLength: 12.5, chordLength: 9.3 },
    { index: 9, number: '8', arcLength: 12.2, chordLength: 8.8 }, { index: 10, number: '8.5', arcLength: 11.8 },
    { index: 11, number: '9', arcLength: 11 }, { index: 12, number: '9.5', arcLength: 10.2 },
    { index: 13, number: '10', arcLength: 9.5 }, { index: 14, number: '10.5', arcLength: 9 },
    { index: 15, number: '11', arcLength: 8.5 }
  ]},
  { code: 'short-squoval', nameZh: '短方椭圆', nameDe: 'Kurz Squoval', sizes: [
    { index: 1, number: '0', arcLength: 17 }, { index: 2, number: '1', arcLength: 16 },
    { index: 3, number: '2', arcLength: 15 }, { index: 4, number: '3', arcLength: 14.5 },
    { index: 5, number: '4', arcLength: 13.8 }, { index: 6, number: '5', arcLength: 13 },
    { index: 7, number: '6', arcLength: 12, chordLength: 9.3 }, { index: 8, number: '7', arcLength: 11.7, chordLength: 9 },
    { index: 9, number: '8', arcLength: 11.3, chordLength: 8.6 }, { index: 10, number: '8.5', arcLength: 11, chordLength: 8.3 },
    { index: 11, number: '9', arcLength: 10.5, chordLength: 8.3 }, { index: 12, number: '9.5', arcLength: 10.2, chordLength: 7.9 },
    { index: 13, number: '10', arcLength: 9.5, chordLength: 7.7 }, { index: 14, number: '10.5', arcLength: 9.5, chordLength: 7.5 },
    { index: 15, number: '11', arcLength: 9, chordLength: 7.2 }
  ]}
];

var CHART_DATA = SHAPES_DATA.filter(function(s) { return s.code === TEST_SHAPE; })[0].sizes;
var PROFILES = [
  { id: 'prof-1', profileName: 'Profile One', fingerSizes: fingerSizesFor(TEST_ARC_LENGTH), createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 'prof-2', profileName: 'Profile Two', fingerSizes: fingerSizesFor(TEST_ARC_LENGTH + 1.5), createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' }
];
var PROFILE_SEQ = 3;
var PROFILE_SEQ_LOCK = 3;

function makeProductBody() {
  return {
    data: {
      product: {
        id: 'p1', name: 'Aurora Borealis Nails', slug: 'aurora-borealis-nails',
        featuredAsset: { id: 'a1', name: 'design-1.png' },
        assets: [{ id: 'a1', name: 'design-1.png' }, { id: 'a2', name: 'design-2.png' }],
        variants: [{ id: 'v1', name: 'Standard', sku: 'AUR-001', priceWithTax: 2500, currencyCode: 'EUR', stockLevel: 'IN_STOCK' }],
        customFields: { designFee: 800, designTemplate: '{"indexTable":[]}' }
      }
    }
  };
}

function makeActiveOrderBody(overrides) {
  overrides = overrides || {};
  var nailSizesStr = 'leftIndex:' + TEST_ARC_LENGTH;
  return {
    data: {
      activeOrder: {
        id: '1', code: 'ED-NSM-001', state: 'AddingItems', totalQuantity: 1,
        subTotal: 2500, subTotalWithTax: 2975, shipping: 0, shippingWithTax: 0,
        total: 2500, totalWithTax: 2975, currencyCode: 'EUR',
        taxSummary: [{ description: 'VAT', taxRate: 19, taxTotal: 475 }],
        shippingLines: [{ priceWithTax: 0, shippingMethod: { id: 's1', name: 'Standard' } }],
        lines: [{
          id: 'l1',
          productVariant: { id: 'v1', name: 'Standard', sku: 'AUR-001', product: { id: 'p1', name: 'Aurora Borealis Nails', slug: 'aurora-borealis-nails' } },
          unitPriceWithTax: 2500, quantity: 1, linePriceWithTax: 2500,
          customFields: Object.assign({
            designNumber: 'design-1.png',
            nailShape: TEST_SHAPE,
            nailSizes: nailSizesStr,
            matchedNailModel: EXPECTED_MODEL,
            specialEffect: 'none', surfaceFinish: 'glossy'
          }, overrides.lineCustomFields || {})
        }]
      }
    }
  };
}

function startServer(scenario, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
      if (req.url !== '/shop-api') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var body = raw ? JSON.parse(raw) : {};
        var query = body.query || '';

        function send(status, obj) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        }

        if (scenario === '500') { send(500, { errors: [{ message: 'boom' }] }); return; }

        if (query.indexOf('mutation Login') !== -1) {
          send(200, { data: { login: { __typename: 'CurrentUser', id: '1', identifier: body.variables.username } } });
          return;
        }

        if (query.indexOf('GetMyNailProfiles') !== -1) {
          send(200, { data: { myNailProfiles: options.profiles || PROFILES } });
          return;
        }

        if (query.indexOf('GetNailSizeActiveOrder') !== -1) {
          var orderBody;
          if (scenario === 'bad-mapping') {
            orderBody = makeActiveOrderBody({ lineCustomFields: { matchedNailModel: '99' } });
          } else if (scenario === 'bad-shape') {
            orderBody = makeActiveOrderBody({ lineCustomFields: { nailShape: 'short-coffin' } });
          } else if (scenario === 'bad-finger') {
            orderBody = makeActiveOrderBody({ lineCustomFields: { nailSizes: 'rightThumb:15' } });
          } else if (scenario === 'reject-order') {
            orderBody = { data: { activeOrder: null } };
          } else {
            orderBody = makeActiveOrderBody();
          }
          send(200, orderBody);
          return;
        }

        if (query.indexOf('GetNailSizeChart') !== -1) {
          if (scenario === 'no-chart') send(200, { data: { nailSizeChart: [] } });
          else send(200, { data: { nailSizeChart: CHART_DATA } });
          return;
        }

        if (query.indexOf('GetAllNailShapes') !== -1) {
          if (scenario === 'no-shapes') send(200, { data: { allNailShapes: [] } });
          else send(200, { data: { allNailShapes: SHAPES_DATA } });
          return;
        }

        if (query.indexOf('CreateNailProfile') !== -1) {
          var newProfile = {
            id: 'prof-' + (PROFILE_SEQ++),
            profileName: body.variables.input.profileName,
            fingerSizes: body.variables.input.fingerSizes,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          send(200, { data: { createNailProfile: newProfile } });
          return;
        }

        if (query.indexOf('UpdateNailProfile') !== -1) {
          var updated = {
            id: body.variables.id,
            profileName: body.variables.input.profileName,
            fingerSizes: body.variables.input.fingerSizes || {},
            updatedAt: new Date().toISOString()
          };
          send(200, { data: { updateNailProfile: updated } });
          return;
        }

        if (query.indexOf('GetCustomPurchaseProduct') !== -1) {
          if (scenario === 'not-found') send(200, { data: { product: null } });
          else send(200, makeProductBody());
          return;
        }

        if (query.indexOf('addItemToOrder') !== -1) {
          if (scenario === 'reject-order') {
            send(200, { data: { addItemToOrder: { __typename: 'InsufficientStockError', message: 'no stock' } } });
          } else {
            send(200, { data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-NSM-001', totalQuantity: 1, lines: [] } } });
          }
          return;
        }

        send(200, { data: {} });
      });
    });
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port });
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise(function(resolve) { server.close(resolve); });
}

function baseContext(taskId, overrides) {
  overrides = overrides || {};
  var base = {
    taskId: taskId,
    task: { canonicalId: taskId, mandatoryAssertions: [], expectedResult: 'expected result for ' + taskId },
    shopApiBase: 'https://staging.tibella.eu',
    deps: {
      fetch: function(url, init) { return global.fetch(url, init); },
      clock: overrides.clock || fakeClock(),
      getEnv: overrides.getEnv || envWith({}),
      config: overrides.config || {}
    }
  };
  if (overrides.runEnvRecord) base.runEnvRecord = overrides.runEnvRecord;
  if (overrides.registry) base.registry = overrides.registry;
  if (overrides.fixtures) base.fixtures = overrides.fixtures;
  return base;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'expected result for ' + (taskId || 'unknown'),
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

test('nailSizeMatch: success returns READINESS_PASS with profile save, shapes loaded, mapping verified', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-ok', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_READINESS_PASS, 'readiness pass constant');
  assert.ok(outcome.evidence, 'evidence present');
  assert.strictEqual(outcome.evidence.observed.shapesCount, 4, 'all 4 nail shapes loaded');
  assert.strictEqual(outcome.evidence.observed.chartSizes > 0, true, 'nail size chart loaded');
  assert.ok(outcome.evidence.observed.profile1Id, 'first profile created with id');
  assert.ok(outcome.evidence.observed.profile2Id, 'second profile created with id');
  assert.strictEqual(outcome.evidence.checks.profilesSaved, true, 'both profiles saved');
  assert.strictEqual(outcome.evidence.checks.shapesLoaded, true, 'allNailShapes returned 4 shapes');
  assert.strictEqual(outcome.evidence.checks.chartLoaded, true, 'nailSizeChart returned sizes');
  assert.strictEqual(outcome.evidence.checks.shapePreserved, true, 'nailShape on order line preserved');
  assert.strictEqual(outcome.evidence.checks.fingerPreserved, true, 'nailSizes on order line preserved');
  assert.strictEqual(outcome.evidence.checks.mappingOnOrder, true, 'matchedNailModel on order line matches reference');
  assert.ok(outcome.evidence.observed.matchedModelOnLine, 'matched model on line is not empty');
  assert.strictEqual(outcome.evidence.observed.matchedModelOnLine.indexOf(EXPECTED_MODEL) !== -1, true, 'matchedModelOnLine contains ' + EXPECTED_MODEL);
  assert.ok(outcome.evidence.assertionReport.length >= 2, 'assertion report has 2 entries');
  var joined = outcome.evidence.unverified.join(' ');
  assert.ok(joined.indexOf('Stripe') !== -1 || joined.indexOf('run_export') !== -1 || joined.indexOf('export') !== -1, 'unverified mentions export or Stripe');
  assert.strictEqual(JSON.stringify(outcome.evidence.rawRequests).indexOf('de-token'), -1, 'token redacted');
});

test('nailSizeMatch: wrong mapping is APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-mapping');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-bad-map', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('matched model') !== -1 || outcome.error.indexOf('matchedNailModel') !== -1, 'error names the mapping');
  assert.strictEqual(outcome.evidence.observed.matchedModelOnLine, '99');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: wrong shape on order is APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-shape');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-bad-shape', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('shape') !== -1, 'error names the shape');
  assert.strictEqual(outcome.evidence.observed.shapeOnLine, 'short-coffin');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: wrong finger on order is APPLICATION_DEFECT', async function() {
  var s = await startServer('bad-finger');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-bad-finger', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('finger') !== -1, 'error names the finger');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: missing shapes is APPLICATION_DEFECT', async function() {
  var s = await startServer('no-shapes');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-no-shapes', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('shapes') !== -1, 'error names shapes');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: missing chart is APPLICATION_DEFECT', async function() {
  var s = await startServer('no-chart');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-no-chart', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('chart') !== -1, 'error names chart');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: order rejected is APPLICATION_DEFECT', async function() {
  var s = await startServer('reject-order');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-reject', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('addItemToOrder') !== -1 || outcome.error.indexOf('not create') !== -1, 'error names the add step');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: product not found is APPLICATION_DEFECT', async function() {
  var s = await startServer('not-found');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-notfound', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.ok(outcome.error.indexOf('not found') !== -1 || outcome.error.indexOf('product') !== -1, 'error names product');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, APPLICATION_DEFECT);
});

test('nailSizeMatch: server down is DEPENDENCY_ENVIRONMENT', async function() {
  var s = await startServer('500');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    runEnvRecord: { runId: 'run-nsm-down', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  // Provide an explicit fetch so we don't rely on global.fetch being wired.
  ctx.deps.fetch = function(url, init) { return global.fetch(url, init); };
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'ENVIRONMENT_ERROR');
  assert.ok(outcome.error.indexOf('500') !== -1 || outcome.error.indexOf('down') !== -1 || outcome.error.indexOf('failed') !== -1, 'error mentions failure');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, DEPENDENCY_ENVIRONMENT);
});

test('nailSizeMatch: missing password is CLIENT_INPUT_SCOPE with env NAMES only', async function() {
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({}),
    runEnvRecord: { runId: 'run-nsm-nopwd', stagingUrl: s.url }
  });
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'VALIDATION_ERROR');
  assert.ok(outcome.evidence.passwordEnvNames && outcome.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  assert.strictEqual(JSON.stringify(outcome.evidence).indexOf('test-pass'), -1, 'no password value leaked');
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-11');
  assert.strictEqual(finalOutcome.result, 'BLOCK');
  assert.strictEqual(finalOutcome.classification, CLIENT_INPUT_SCOPE);
});

test('nailSizeMatch: register() registers CAN-B2-11 with readiness-subset coverage', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-11'), true);
  var ex = executorModule.getTaskExecutor('CAN-B2-11');
  assert.strictEqual(ex.coverage, 'readiness-subset');
  assert.deepStrictEqual(ex.verifiedAssertionIds, ['CAN-B2-11-A01']);
  executorModule.resetTaskExecutors();
});

test('nailSizeMatch: evidence written through writeEvidenceFile and verifyEvidence passes', async function() {
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var evidenceCollector = require('../src/evidenceCollector');
  var evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-nsm-'));
  var runId = 'run-nsm-ev-' + Date.now().toString(36) + '-x1y';
  var s = await startServer('ok');
  var ctx = baseContext('CAN-B2-11', {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' }),
    config: { evidenceRoot: evidenceRoot },
    runEnvRecord: { runId: runId, stagingUrl: s.url }
  });
  ctx.deps.config.evidenceRoot = evidenceRoot;
  ctx.shopApiBase = s.url;
  var outcome = await executors.handlerNailSizeMatch(ctx);
  await closeServer(s.server);

  assert.strictEqual(outcome.success, true, 'run succeeds');
  var taskDir = path.join(evidenceRoot, 'evidence', runId, 'CAN-B2-11');
  assert.strictEqual(fs.existsSync(taskDir), true, 'evidence task dir exists');
  ['shop-api-requests.json', 'shop-api-responses.json', 'nail-size-table.json', 'expected-vs-actual.json', 'assertion-report.json', 'executor-summary.json'].forEach(function(name) {
    assert.strictEqual(fs.existsSync(path.join(taskDir, name)), true, name + ' written');
  });
  var reqSerialized = JSON.stringify(JSON.parse(fs.readFileSync(path.join(taskDir, 'shop-api-requests.json'), 'utf8')));
  assert.strictEqual(reqSerialized.indexOf('de-token'), -1, 'channel token redacted');
  assert.strictEqual(reqSerialized.indexOf('test-pass'), -1, 'password redacted');
  var verify = evidenceCollector.verifyEvidence(runId, { root: evidenceRoot });
  assert.strictEqual(verify.ok, true, 'verifyEvidence passes over executor evidence');
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

test('nailSizeMatch: resolveNailReference derives correct model number from fixture', function() {
  var r = executors.resolveNailReference({});
  assert.strictEqual(r.ok, true, 'reference resolved');
  assert.strictEqual(typeof r.modelNumber, 'string', 'modelNumber is string');
  assert.strictEqual(typeof r.arcLength, 'number', 'arcLength is number');
  assert.strictEqual(r.shapeCode, TEST_SHAPE, 'shape code matches expected');
  assert.ok(r.fixtureSha, 'fixture sha present');
});

test('nailSizeMatch: deriveMatchedModel computes model from fixture data correctly', function() {
  var fixturesModule = require('../src/fixtures');
  var loaded = fixturesModule.loadFixturesFile();
  assert.strictEqual(loaded.ok, true, 'fixtures loaded');
  var model = executors.deriveMatchedModel(loaded.fixtures, TEST_ARC_LENGTH, TEST_SHAPE);
  assert.strictEqual(model, EXPECTED_MODEL, 'derived model equals expected from reference');
});