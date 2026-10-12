'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');

var adminChannelInventory = require('../src/executors/adminChannelInventory');
var terminalState = require('../src/terminalState');
var evidenceCollector = require('../src/evidenceCollector');

var RESULT_PASS = terminalState.RESULT_PASS;

// ---------------------------------------------------------------------------
// Fake fetch factory for Admin API tests
// ---------------------------------------------------------------------------

function fakeClock(iso) {
  var current = new Date(iso || '2026-10-07T09:00:00.000Z');
  return function() {
    return new Date(current.getTime());
  };
}

/**
 * Build a fake Admin API fetch from a config object.
 * Routes:
 *   any URL + login mutation -> loginResponse
 *   any URL + introspection query (__type) -> introspectionResponse
 *   any URL + channels query -> channelsResponse
 *   shopApiBase/shop-api + products query -> productCountResponse per channel token
 */
function fakeAdminFetch(config) {
  config = config || {};
  return function fakeFetch(url, init) {
    var body = init && init.body ? JSON.parse(init.body) : {};
    var query = body.query || '';
    var token = (init && init.headers)
      ? (init.headers['vendure-token'] || (init.headers['Authorization'] ? init.headers['Authorization'].replace('Bearer ', '') : null))
      : null;

    // Product count query via Shop API
    if (query.indexOf('products(options') !== -1 && url.indexOf('/shop-api') !== -1) {
      var count = config.productCounts && token && config.productCounts[token] != null
        ? config.productCounts[token]
        : 0;
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() {
          return Promise.resolve(JSON.stringify({
            data: { products: { totalItems: count } }
          }));
        }
      });
    }

    if (query.indexOf('mutation Login') !== -1 || query.indexOf('login(username') !== -1) {
      return Promise.resolve({
        status: config.loginStatus || 200,
        headers: config.loginTokenHeader
          ? { get: function(n) { return n === 'vendure-auth-token' ? config.loginTokenHeader : null; }, 'vendure-auth-token': config.loginTokenHeader }
          : { get: function() { return null; } },
        text: function() {
          return Promise.resolve(JSON.stringify(config.loginResponse || {
            data: {
              login: {
                __typename: 'CurrentUser',
                id: 'user-1',
                identifier: 'admin@example.com'
              }
            }
          }));
        }
      });
    }

    if (query.indexOf('__type') !== -1 || query.indexOf('IntrospectChannelType') !== -1) {
      var resp = config.introspectionResponse || {
        data: {
          __type: {
            fields: [
              { name: 'id' },
              { name: 'code' },
              { name: 'token' },
              { name: 'defaultCurrencyCode' }
            ]
          }
        }
      };
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify(resp)); }
      });
    }

    if (query.indexOf('channels(options') !== -1 || query.indexOf('channels(') !== -1) {
      var chResp = config.channelsResponse || {
        data: {
          channels: {
            items: [],
            totalItems: 0
          }
        }
      };
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify(chResp)); }
      });
    }

    return Promise.resolve({
      status: 404,
      headers: { get: function() { return null; } },
      text: function() { return Promise.resolve(JSON.stringify({ error: 'not found' })); }
    });
  };
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function makeContext(fetchFn, env, overrides) {
  overrides = overrides || {};
  return {
    deps: {
      fetch: fetchFn,
      clock: fakeClock(),
      getEnv: typeof env === 'function' ? env : function() { return env || {}; },
      config: {}
    },
    runEnvRecord: overrides.runEnvRecord || { runId: 'run-test-' + Date.now(), stagingUrl: 'https://staging.tibella.eu' }
  };
}

// ---------------------------------------------------------------------------
// Test: credentials missing -> available: false, reason ADMIN_CREDENTIALS_MISSING
// ---------------------------------------------------------------------------

test('adminChannelInventory: missing credentials returns available:false, ADMIN_CREDENTIALS_MISSING', async function(t) {
  var fetch = fakeAdminFetch({});
  var ctx = makeContext(fetch, { VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api' });
  // No SUPERADMIN_USERNAME or SUPERADMIN_PASSWORD
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, false, 'available is false');
  assert.strictEqual(result.reason, 'ADMIN_CREDENTIALS_MISSING', 'reason is ADMIN_CREDENTIALS_MISSING');
  assert.strictEqual(result.timestamp != null, true, 'timestamp present');
  assert.strictEqual(result.callCount, 0, 'no Admin API calls made');
});

test('adminChannelInventory: STAGING_ADMIN_EMAIL/PASSWORD aliases also satisfy credentials check', async function(t) {
  var fetch = fakeAdminFetch({});
  // STAGING_ADMIN_EMAIL/PASSWORD are also valid credential sources
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    STAGING_ADMIN_EMAIL: 'admin@example.com',
    STAGING_ADMIN_PASSWORD: 'secretpass'
  });
  // Credentials present; login will fail but not with ADMIN_CREDENTIALS_MISSING
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});
  assert.strictEqual(result.reason !== 'ADMIN_CREDENTIALS_MISSING', true, 'credentials are not reported missing');
});

// ---------------------------------------------------------------------------
// Test: login fails -> available: false, reason ADMIN_LOGIN_FAILED
// ---------------------------------------------------------------------------

test('adminChannelInventory: login returns InvalidCredentialsError -> available:false, ADMIN_LOGIN_FAILED', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginResponse: {
      data: {
        login: {
          __typename: 'ErrorResult',
          errorCode: 'INVALID_CREDENTIALS_ERROR',
          message: 'Invalid credentials'
        }
      }
    }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'bad@example.com',
    SUPERADMIN_PASSWORD: 'wrongpassword'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, false, 'available is false');
  assert.strictEqual(result.reason, 'ADMIN_LOGIN_FAILED', 'reason is ADMIN_LOGIN_FAILED');
  assert.strictEqual(result.credentialNames.credentialsPresent, true, 'credentials were present (not a credentials-missing issue)');
  // Auth token and password must NOT appear in the returned object values
  assert.strictEqual(JSON.stringify(result).indexOf('wrongpassword'), -1, 'password never appears in result');
});

test('adminChannelInventory: login network error -> available:false, ADMIN_LOGIN_FAILED', async function(t) {
  var failingFetch = function() { return Promise.reject(new Error('ECONNREFUSED')); };
  var ctx = makeContext(failingFetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'ADMIN_LOGIN_FAILED');
});

test('adminChannelInventory: login HTTP 503 -> available:false, ADMIN_LOGIN_FAILED', async function(t) {
  var fetch = fakeAdminFetch({ loginStatus: 503 });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'ADMIN_LOGIN_FAILED');
});

// ---------------------------------------------------------------------------
// Test: Admin returns only __default_channel__ -> unexpectedDefaultOnly:true, DE/AT/HU/GB missing
// ---------------------------------------------------------------------------

test('adminChannelInventory: only __default_channel__ -> missing DE,AT,HU,GB; unexpectedDefaultOnly:true', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginTokenHeader: 'admin-auth-token-xyz',
    channelsResponse: {
      data: {
        channels: {
          items: [{ id: 'ch-default', code: '__default_channel__', token: null, defaultCurrencyCode: 'USD' }],
          totalItems: 1
        }
      }
    }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, true, 'inventory is available');
  assert.strictEqual(result.unexpectedDefaultOnly, true, 'unexpectedDefaultOnly is true');
  assert.deepStrictEqual(result.missing.sort(), ['AT', 'DE', 'GB', 'HU'].sort(), 'all four countries reported missing');
  assert.strictEqual(result.perCountry.DE.exists, false, 'DE channel missing');
  assert.strictEqual(result.perCountry.AT.exists, false, 'AT channel missing');
  assert.strictEqual(result.perCountry.HU.exists, false, 'HU channel missing');
  assert.strictEqual(result.perCountry.GB.exists, false, 'GB channel missing');
  assert.strictEqual(result.channels.length, 1, 'only one channel returned');
  assert.strictEqual(result.channels[0].code, '__default_channel__');
  assert.strictEqual(result.callCount > 0, true, 'calls were made');
});

// ---------------------------------------------------------------------------
// Test: Admin returns all four channels with correct tokens and currencies
// ---------------------------------------------------------------------------

test('adminChannelInventory: all four channels present with correct tokens/currencies -> no missing', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginTokenHeader: 'admin-auth-token-xyz',
    channelsResponse: {
      data: {
        channels: {
          items: [
            { id: 'ch-de', code: 'DE', token: 'de-token', defaultCurrencyCode: 'EUR' },
            { id: 'ch-at', code: 'AT', token: 'at-token', defaultCurrencyCode: 'EUR' },
            { id: 'ch-hu', code: 'HU', token: 'hu-token', defaultCurrencyCode: 'HUF' },
            { id: 'ch-gb', code: 'GB', token: 'gb-token', defaultCurrencyCode: 'GBP' }
          ],
          totalItems: 4
        }
      }
    },
    productCounts: {
      'de-token': 12,
      'at-token': 8,
      'hu-token': 5,
      'gb-token': 3
    }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {
    shopApiBase: 'https://staging.tibella.eu/shop-api'
  });

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.missing.length, 0, 'no missing channels');
  assert.strictEqual(result.unexpectedDefaultOnly, false);
  assert.strictEqual(result.perCountry.DE.exists, true, 'DE channel exists');
  assert.strictEqual(result.perCountry.DE.currency, 'EUR', 'DE currency is EUR');
  assert.strictEqual(result.perCountry.HU.exists, true, 'HU channel exists');
  assert.strictEqual(result.perCountry.HU.currency, 'HUF', 'HU currency is HUF');
  assert.strictEqual(result.perCountry.GB.currencyMatches, true, 'GB currency matches expected (GBP)');
  assert.strictEqual(result.perChannelProductCounts.length, 4, 'product counts collected for all channels');
  assert.strictEqual(result.perChannelProductCounts[0].totalItems, 12, 'DE product count is 12');
});

// ---------------------------------------------------------------------------
// Test: Introspection lacks defaultCurrencyCode -> falls back to currencyCode
// ---------------------------------------------------------------------------

test('adminChannelInventory: introspection lacks defaultCurrencyCode -> falls back to currencyCode field', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginTokenHeader: 'admin-auth-token-xyz',
    introspectionResponse: {
      data: {
        __type: {
          fields: [
            { name: 'id' },
            { name: 'code' },
            { name: 'token' },
            { name: 'currencyCode' }
          ]
        }
      }
    },
    channelsResponse: {
      data: {
        channels: {
          items: [
            { id: 'ch-de', code: 'DE', token: 'de-token', currencyCode: 'EUR' }
          ],
          totalItems: 1
        }
      }
    }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.introspectedFields.indexOf('defaultCurrencyCode'), -1, 'defaultCurrencyCode not in introspected fields');
  assert.strictEqual(result.introspectedFields.indexOf('currencyCode') !== -1, true, 'currencyCode is in introspected fields');
  assert.strictEqual(result.channels[0].currency, 'EUR', 'currency from currencyCode field is used');
  assert.strictEqual(result.perCountry.DE.currency, 'EUR', 'per-country currency uses fallback field');
});

// ---------------------------------------------------------------------------
// Test: Introspection with no fields -> query still runs with id, code, token only
// ---------------------------------------------------------------------------

test('adminChannelInventory: introspection with empty fields -> query runs with id,code,token only', async function(t) {
  var introspectionCalled = false;
  var channelsCalled = false;
  var hasLogin = false;

  function trackingFetch(url, init) {
    var body = init && init.body ? JSON.parse(init.body) : {};
    var query = body.query || '';

    if (query.indexOf('mutation Login') !== -1) {
      hasLogin = true;
      return Promise.resolve({
        status: 200,
        headers: { get: function(n) { return n === 'vendure-auth-token' ? 'fake-token' : null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { login: { __typename: 'CurrentUser', id: '1', identifier: 'a' } } })); }
      });
    }
    if (query.indexOf('IntrospectChannelType') !== -1 || query.indexOf('__type(name: "Channel")') !== -1) {
      introspectionCalled = true;
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { __type: { fields: [] } } })); }
      });
    }
    if (query.indexOf('channels(') !== -1) {
      channelsCalled = true;
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { channels: { items: [{ id: 'ch-1', code: 'DE', token: 'de-token' }], totalItems: 1 } } })); }
      });
    }
    return Promise.resolve({ status: 404, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  }

  var ctx = makeContext(trackingFetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, true, 'inventory available despite empty introspection');
  assert.strictEqual(introspectionCalled, true, 'introspection was called');
  assert.strictEqual(channelsCalled, true, 'channels query was called');
  assert.strictEqual(result.introspectedFields.length, 0, 'no fields introspected');
});

// ---------------------------------------------------------------------------
// Test: resolveAdminApiBase uses VENDURE_ADMIN_API_URL when set
// ---------------------------------------------------------------------------

test('adminChannelInventory: resolveAdminApiBase prefers VENDURE_ADMIN_API_URL over staging URL', function(t) {
  var ctx = {
    deps: { getEnv: function() { return { VENDURE_ADMIN_API_URL: 'https://custom.admin.example.com' }; }, config: {} },
    runEnvRecord: { stagingUrl: 'https://staging.tibella.eu' }
  };
  var url = adminChannelInventory.resolveAdminApiBase(ctx);
  assert.strictEqual(url, 'https://custom.admin.example.com');
});

test('adminChannelInventory: resolveAdminApiBase falls back to stagingUrl/admin-api', function(t) {
  var ctx = {
    deps: { getEnv: function() { return {}; }, config: {} },
    runEnvRecord: { stagingUrl: 'https://staging.tibella.eu' }
  };
  var url = adminChannelInventory.resolveAdminApiBase(ctx);
  assert.strictEqual(url, 'https://staging.tibella.eu/admin-api');
});

// ---------------------------------------------------------------------------
// Test: credential names are tracked without exposing values
// ---------------------------------------------------------------------------

test('adminChannelInventory: credential names tracked but values never appear in result', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginResponse: { data: { login: { __typename: 'ErrorResult', errorCode: 'INVALID_CREDENTIALS_ERROR' } } }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'MySecretPassword123'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, false);
  assert.deepStrictEqual(result.credentialNames.present.sort(), ['SUPERADMIN_PASSWORD', 'SUPERADMIN_USERNAME', 'VENDURE_ADMIN_API_URL'].sort());
  var serialized = JSON.stringify(result);
  assert.strictEqual(serialized.indexOf('MySecretPassword123'), -1, 'password must never appear in serialized result');
  assert.strictEqual(serialized.indexOf('admin@example.com'), -1, 'username must never appear in serialized result');
});

// ---------------------------------------------------------------------------
// Test: adminChannelInventory collects per-channel product counts (non-fatal)
// ---------------------------------------------------------------------------

test('adminChannelInventory: perChannelProductCounts collected without failing the whole diagnostic', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginTokenHeader: 'admin-auth-token-xyz',
    channelsResponse: {
      data: {
        channels: {
          items: [
            { id: 'ch-de', code: 'DE', token: 'de-token', defaultCurrencyCode: 'EUR' },
            { id: 'ch-at', code: 'AT', token: 'at-token', defaultCurrencyCode: 'EUR' }
          ],
          totalItems: 2
        }
      }
    },
    productCounts: {
      'de-token': 42,
      'at-token': 17
    }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {
    shopApiBase: 'https://staging.tibella.eu/shop-api'
  });

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.perChannelProductCounts.length, 2);
  var deCount = result.perChannelProductCounts.find(function(c) { return c.channelCode === 'DE'; });
  assert.strictEqual(deCount && deCount.totalItems, 42);
  assert.strictEqual(deCount && deCount.error, null);
});

// ---------------------------------------------------------------------------
// Test: adminChannelInventory does not fail when shopApiBase is not provided
// ---------------------------------------------------------------------------

test('adminChannelInventory: works when shopApiBase not provided (product counts skipped)', async function(t) {
  var fetch = fakeAdminFetch({
    loginStatus: 200,
    loginTokenHeader: 'admin-auth-token-xyz',
    channelsResponse: {
      data: {
        channels: {
          items: [{ id: 'ch-de', code: 'DE', token: 'de-token', defaultCurrencyCode: 'EUR' }],
          totalItems: 1
        }
      }
    }
  });
  var ctx = makeContext(fetch, {
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SUPERADMIN_USERNAME: 'admin@example.com',
    SUPERADMIN_PASSWORD: 'secretpass'
  });
  var result = await adminChannelInventory.collectChannelInventory(ctx, {});

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.perChannelProductCounts.length, 0, 'no product counts when shopApiBase not set');
});
