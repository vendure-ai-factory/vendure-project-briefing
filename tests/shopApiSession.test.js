'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var http = require('http');
var os = require('os');
var fs = require('fs');

var sessionModule = require('../src/executors/shopApiSession');
var terminalState = require('../src/terminalState');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var CLIENT_INPUT_SCOPE = terminalState.FAILURE_CLASSES.CLIENT_INPUT_SCOPE;
var DEPENDENCY_ENVIRONMENT = terminalState.FAILURE_CLASSES.DEPENDENCY_ENVIRONMENT;
var APPLICATION_DEFECT = terminalState.FAILURE_CLASSES.APPLICATION_DEFECT;

var TOKENS_JSON = JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' });

function fakeClock() {
  return function() { return new Date('2026-10-07T09:00:00.000Z'); };
}

function envWith(items) {
  return function() { return Object.assign({ CHANNEL_TOKENS: TOKENS_JSON }, items || {}); };
}

/**
 * A tiny fake staging server that serves /shop-api. The `scenario` selects
 * the responses:
 *  - 'ok-verify': register returns Success, login returns a CurrentUser with
 *    identifier equal to the username (auth success).
 *  - 'verify-required': register returns Success but login returns
 *    NotVerifiedError (email verification required).
 *  - '500': shop-api always returns HTTP 500.
 *  - 'wrong-channel': addItemToOrder returns NoActiveOrderError under the
 *    wrong channel token.
 */
function startServer(scenario) {
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
        var body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        var query = body.query || '';
        var vars = body.variables || {};
        if (scenario === '500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"errors":[{"message":"boom"}]}');
          return;
        }
        if (query.indexOf('RegisterCustomerAccount') !== -1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { registerCustomerAccount: { __typename: 'Success', success: true } } }));
          return;
        }
        if (query.indexOf('mutation Login') !== -1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          if (scenario === 'verify-required') {
            res.end(JSON.stringify({ data: { login: { __typename: 'NotVerifiedError', errorCode: 'NOT_VERIFIED', message: 'Please verify your email address' } } }));
          } else {
            res.end(JSON.stringify({ data: { login: { __typename: 'CurrentUser', id: '1', identifier: vars.username } } }));
          }
          return;
        }
        if (query.indexOf('addItemToOrder') !== -1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          if (scenario === 'wrong-channel') {
            res.end(JSON.stringify({ data: { addItemToOrder: { __typename: 'NoActiveOrderError', errorCode: 'NO_ACTIVE_ORDER', message: 'No active order for this channel' } } }));
          } else {
            res.end(JSON.stringify({ data: { addItemToOrder: { __typename: 'Order', id: '1', code: 'ED-RUN-0001', totalQuantity: 2, lines: [] } } }));
          }
          return;
        }
        if (query.indexOf('activeCustomer') !== -1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { activeCustomer: { id: '1', firstName: 'Buyer', lastName: 'One', emailAddress: vars.username || 'buyer.one@example.com', customFields: { countryCode: 'DE' }, addresses: [] } } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":{}}');
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

function contextFor(port, overrides) {
  var base = {
    task: { canonicalId: 'CAN-TEST' },
    taskId: 'CAN-TEST',
    shopApiBase: 'http://127.0.0.1:' + port,
    deps: {
      fetch: function(url, init) { return (overrides && overrides.fetch) ? overrides.fetch(url, init) : fetch(url, init); },
      clock: overrides && overrides.clock ? overrides.clock : fakeClock(),
      getEnv: overrides && overrides.getEnv ? overrides.getEnv : envWith({}),
      config: overrides && overrides.config ? overrides.config : {}
    }
  };
  if (overrides && overrides.runEnvRecord) base.runEnvRecord = overrides.runEnvRecord;
  return base;
}

function hasSecret(evidence, value) {
  return JSON.stringify(evidence).indexOf(value) !== -1;
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

test('shopApiSession store.register succeeds with Success result', async function() {
  var s = await startServer('ok-verify');
  var ctx = contextFor(s.port, {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.register('buyer.one@example.com');
  await closeServer(s.server);
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.result, RESULT_READINESS_PASS);
  assert.ok(out.evidence.request, 'evidence has request');
  assert.ok(out.evidence.response, 'evidence has response');
  // password value must be redacted from evidence
  assert.strictEqual(hasSecret(out.evidence, 'test-pass'), false, 'password redacted');
});

test('shopApiSession store.register returns CLIENT_INPUT_SCOPE when password env absent', async function() {
  var s = await startServer('ok-verify');
  var ctx = contextFor(s.port, { getEnv: envWithNoPasswords() });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.register('buyer.one@example.com');
  await closeServer(s.server);
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.errorCode, 'VALIDATION_ERROR');
  assert.ok(out.evidence.passwordEnvNames.indexOf('SHOP_ACCOUNT_PASSWORD_BUYER_ONE') !== -1, 'names the env var');
  assert.strictEqual(hasSecret(out.evidence, 'SHOP_ACCOUNT_PASSWORD_BUYER_ONE='), false, 'no value leaked');
});

function envWithNoPasswords() {
  return envWith({});
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test('shopApiSession store.login succeeds with CurrentUser', async function() {
  var s = await startServer('ok-verify');
  var ctx = contextFor(s.port, {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.login('buyer.one@example.com');
  await closeServer(s.server);
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.result, RESULT_READINESS_PASS);
  assert.strictEqual(hasSecret(out.evidence, 'test-pass'), false, 'password redacted');
});

test('shopApiSession store.login returns APPLICATION_DEFECT on NotVerifiedError', async function() {
  var s = await startServer('verify-required');
  var ctx = contextFor(s.port, {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.login('buyer.one@example.com');
  await closeServer(s.server);
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(out.evidence.response.body.data.login.__typename, 'NotVerifiedError');
});

// ---------------------------------------------------------------------------
// add to cart
// ---------------------------------------------------------------------------

test('shopApiSession store.addItemToOrder succeeds', async function() {
  var s = await startServer('ok-verify');
  var ctx = contextFor(s.port, {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.addItemToOrder('buyer.one@example.com', 'v1', 2, 'DE');
  await closeServer(s.server);
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.result, RESULT_READINESS_PASS);
});

// ---------------------------------------------------------------------------
// wrong channel
// ---------------------------------------------------------------------------

test('shopApiSession store.addItemToOrder returns APPLICATION_DEFECT on wrong channel', async function() {
  var s = await startServer('wrong-channel');
  var ctx = contextFor(s.port, {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.addItemToOrder('buyer.one@example.com', 'v1', 2, 'DE');
  await closeServer(s.server);
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(out.evidence.response.body.data.addItemToOrder.__typename, 'NoActiveOrderError');
});

// ---------------------------------------------------------------------------
// 500
// ---------------------------------------------------------------------------

test('shopApiSession store.login returns ENVIRONMENT_ERROR on HTTP 500', async function() {
  var s = await startServer('500');
  var ctx = contextFor(s.port, {
    getEnv: envWith({ SHOP_ACCOUNT_PASSWORD_BUYER_ONE: 'test-pass' })
  });
  var store = sessionModule.createSessionStore(ctx);
  var out = await store.login('buyer.one@example.com');
  await closeServer(s.server);
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.errorCode, 'ENVIRONMENT_ERROR');
  assert.strictEqual(out.evidence.response.httpStatus, 500);
});

// ---------------------------------------------------------------------------
// helper-level checks
// ---------------------------------------------------------------------------

test('shopApiSession.passwordEnvName is deterministic', function() {
  assert.strictEqual(sessionModule.passwordEnvName('buyer.one@example.com'), 'SHOP_ACCOUNT_PASSWORD_BUYER_ONE');
  assert.strictEqual(sessionModule.passwordEnvName('designer.de@example.com'), 'SHOP_ACCOUNT_PASSWORD_DESIGNER_DE');
});

test('shopApiSession.resolveChannelTokens respects CHANNEL_TOKENS env override', function() {
  var ctx = contextFor(0, { getEnv: envWith({}) });
  ctx.shopApiBase = undefined;
  var resolved = sessionModule.resolveChannelTokens(ctx);
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.tokens.DE, 'de-token');
});

test('shopApiSession module exports no register function', function() {
  assert.strictEqual(sessionModule.register, undefined, 'must not export register()');
});
