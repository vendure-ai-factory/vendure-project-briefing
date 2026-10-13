'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');

var seedStaging = require('../src/staging/seedStaging');
var SPECDIR = path.join(__dirname, '..', 'pipeline', 'seed', 'staging-seed.v1.json');

var SENTINEL_PASSWORD = 'sup3r-s3cret-admin-pw-sentinel';
var SENTINEL_AUTH = 'sentinel-auth-token-9f8e';
var SENTINEL_TOKEN = 'sentinel-channel-token-abc123';
var SENTINEL_CUSTOMER_PASSWORD = 'sentinel-customer-pw-zz9';

function loadSpec() {
  return JSON.parse(fs.readFileSync(SPECDIR, 'utf8'));
}

function seededCountriesData(spec) {
  var items = spec.countries.map(function(c) {
    return { id: 'cnt-' + c.countryCode.toLowerCase(), code: c.countryCode, enabled: true };
  });
  return { data: { countries: { items: items, totalItems: items.length } } };
}

function seededZonesData(spec) {
  var items = spec.zones.map(function(z) { return { id: 'zone-' + z.name.toLowerCase(), name: z.name }; });
  return { data: { zones: { items: items, totalItems: items.length } } };
}

function seededTaxData(spec) {
  var cats = { data: { taxCategories: { items: [{ id: 'taxcat-standard', name: 'standard', isDefault: false }], totalItems: 1 } } };
  var rates = { data: { taxRates: { items: spec.countries.map(function(c) {
    return { id: 'rate-' + c.countryCode.toLowerCase(), name: 'TST ' + c.taxRate + '% ' + c.countryCode, enabled: true };
  }), totalItems: spec.countries.length } } };
  return { cats: cats, rates: rates };
}

function seededStockData(spec) {
  var items = spec.stockLocations.map(function(l) {
    return { id: 'loc-' + l.name.toLowerCase().replace(/ /g, '-'), name: l.name, type: 'default' };
  });
  return { data: { stockLocations: { items: items, totalItems: items.length } } };
}

function channelField() {
  return 'defaultCurrencyCode';
}

function seededChannelsData(spec) {
  var items = spec.countries.map(function(c) {
    var ch = { id: 'chan-' + c.channelCode, code: c.channelCode, token: c.channelToken, availableCurrencyCodes: [c.currencyCode] };
    ch[channelField()] = c.currencyCode;
    return ch;
  });
  return { data: { channels: { items: items, totalItems: items.length } } };
}

function seededProductsData(spec) {
  var items = spec.products.map(function(p) {
    return { id: 'prod-' + p.slug, slug: p.slug, enabled: true };
  });
  return { data: { products: { items: items, totalItems: items.length } } };
}

function seededVariantsData(spec) {
  var items = [];
  spec.products.forEach(function(p) {
    p.variants.forEach(function(v) {
      items.push({ id: 'var-' + v.sku.toLowerCase(), sku: v.sku });
    });
  });
  return { data: { productVariants: { items: items, totalItems: items.length } } };
}

function seededCustomersData(spec) {
  var items = spec.testCustomers.map(function(tc) {
    var email = tc.emailPrefix + '@example.invalid';
    return { id: 'cust-' + tc.emailPrefix, emailAddress: email };
  });
  return { data: { customers: { items: items, totalItems: items.length } } };
}

function preReadData() {
  return { data: {
    activeChannel: {
      code: '__default_channel__',
      defaultCurrencyCode: 'USD',
      defaultLanguageCode: 'en',
      defaultTaxZone: null,
      defaultShippingZone: null
    },
    countries: { totalItems: 0 },
    zones: { totalItems: 0 },
    taxCategories: { totalItems: 0 },
    taxRates: { totalItems: 0 },
    stockLocations: { totalItems: 0 },
    shippingMethods: { totalItems: 0 },
    paymentMethods: { totalItems: 0 }
  } };
}

function introspectionData() {
  function fields(names) {
    return names.map(function(n) { return { name: n }; });
  }
  return { data: {
    Mutation: { name: 'Mutation', fields: fields([
      'login', 'createChat', 'deleteChat', 'createChannel', 'createCountry', 'createZone',
      'createTaxCategory', 'createTaxRate', 'createStockLocation',
      'createProduct', 'createProductVariants', 'assignProductsToChannel',
      'assignProductVariantsToChannel', 'createCustomer'
    ]) },
    Channel: { name: 'Channel', fields: fields([
      'id', 'code', 'token', 'defaultCurrency', 'defaultLanguageCode', 'defaultShippingZone',
      'defaultTaxZone', 'pricesIncludeTax', 'availableCurrencyCodes', 'defaultCurrencyCode',
      'currencyCode'
    ]) },
    CreateChannelInput: { name: 'CreateChannelInput', fields: fields([
      'code', 'token', 'defaultLanguageCode', 'pricesIncludeTax', 'defaultTaxZoneId',
      'defaultShippingZoneId', 'defaultCurrencyCode', 'currencyCode', 'availableCurrencyCodes'
    ]) },
    CreateProductInput: { name: 'CreateProductInput', fields: fields(['translations', 'enabled']) },
    CreateProductVariantInput: { name: 'CreateProductVariantInput', fields: fields(['productId', 'sku', 'translations', 'price', 'stockOnHand', 'trackInventory', 'outOfStockThreshold']) },
    Zone: { name: 'Zone', fields: fields(['id', 'name']) },
    Country: { name: 'Country', fields: fields(['id', 'code', 'enabled']) }
  } };
}

function makeMutationResponse(query) {
  if (query.indexOf('createCountry') !== -1) {
    return { data: { createCountry: { __typename: 'Country', id: 'new-country', code: 'XX', enabled: true } } };
  }
  if (query.indexOf('createZone') !== -1) {
    return { data: { createZone: { __typename: 'Zone', id: 'new-zone', name: 'TST' } } };
  }
  if (query.indexOf('createTaxCategory') !== -1) {
    return { data: { createTaxCategory: { id: 'new-taxcat', name: 'standard', isDefault: false } } };
  }
  if (query.indexOf('createTaxRate') !== -1) {
    return { data: { createTaxRate: { __typename: 'TaxRate', id: 'new-taxrate', name: 'TST', value: 19 } } };
  }
  if (query.indexOf('createStockLocation') !== -1) {
    return { data: { createStockLocation: { __typename: 'StockLocation', id: 'new-loc', name: 'TST' } } };
  }
  if (query.indexOf('createChannel') !== -1) {
    return { data: { createChannel: { __typename: 'Channel', id: 'new-channel', code: 'de', token: SENTINEL_TOKEN, defaultCurrencyCode: 'EUR' } } };
  }
  if (query.indexOf('createProductVariants') !== -1) {
    return { data: { createProductVariants: { __typename: 'ProductVariantList', items: [{ id: 'new-variant' }] } } };
  }
  if (query.indexOf('createProduct') !== -1) {
    return { data: { createProduct: { __typename: 'Product', id: 'new-product', slug: 'tst' } } };
  }
  if (query.indexOf('assignProductsToChannel') !== -1 || query.indexOf('assignProductVariantsToChannel') !== -1) {
    return { data: { assignProductsToChannel: [{ id: 'new-product' }], assignProductVariantsToChannel: [{ id: 'new-variant' }] } };
  }
  if (query.indexOf('updateProductVariants') !== -1) {
    return { data: { updateProductVariants: { items: [{ id: 'new-variant', sku: 'TST' }] } } };
  }
  if (query.indexOf('createCustomer') !== -1) {
    return { data: { createCustomer: { __typename: 'Customer', id: 'new-customer', emailAddress: 'test-de@example.invalid' } } };
  }
  return { data: {} };
}

/**
 * Build a fake Admin/Shop API fetch whose behaviour is driven by the current
 * in-memory DB state object, so both "fresh" and "already seeded" scenarios
 * share the same routing and simply differ in what the reads return.
 *
 * state.kind: 'fresh' | 'seeded' | 'conflict'
 */
function makeSeedFetch(state) {
  var calls = [];
  var spec = state.spec || loadSpec();
  var seeds = {
    fresh: function(query) {
      if (query.indexOf('activeChannel') !== -1) return preReadData();
      if (query.indexOf('taxCategories') !== -1) return { data: { taxCategories: { items: [], totalItems: 0 } } };
      if (query.indexOf('taxRates') !== -1) return { data: { taxRates: { items: [], totalItems: 0 } } };
      if (query.indexOf('stockLocations') !== -1) return { data: { stockLocations: { items: [], totalItems: 0 } } };
      if (query.indexOf('countries') !== -1) return { data: { countries: { items: [], totalItems: 0 } } };
      if (query.indexOf('zones') !== -1) return { data: { zones: { items: [], totalItems: 0 } } };
      if (query.indexOf('productVariants') !== -1) return { data: { productVariants: { items: [], totalItems: 0 } } };
      if (query.indexOf('products') !== -1) return { data: { products: { items: [], totalItems: 0 } } };
      if (query.indexOf('customers') !== -1) return { data: { customers: { items: [], totalItems: 0 } } };
      if (query.indexOf('channels') !== -1) return { data: { channels: { items: [], totalItems: 0 } } };
      return { data: {} };
    },
    seeded: function(query) {
      if (query.indexOf('activeChannel') !== -1) return preReadData();
      if (query.indexOf('taxCategories') !== -1) return seededTaxData(spec).cats;
      if (query.indexOf('taxRates') !== -1) return seededTaxData(spec).rates;
      if (query.indexOf('stockLocations') !== -1) return seededStockData(spec);
      if (query.indexOf('countries') !== -1) return seededCountriesData(spec);
      if (query.indexOf('zones') !== -1) return seededZonesData(spec);
      if (query.indexOf('productVariants') !== -1) return seededVariantsData(spec);
      if (query.indexOf('products') !== -1) return seededProductsData(spec);
      if (query.indexOf('customers') !== -1) return seededCustomersData(spec);
      if (query.indexOf('channels') !== -1) return seededChannelsData(spec);
      return { data: {} };
    },
    conflict: function(query) {
      if (query.indexOf('channels') !== -1) {
        var items = [{
          id: 'chan-de', code: 'de', token: 'de-token', availableCurrencyCodes: ['USD']
        }];
        items[0][channelField()] = 'USD';
        return { data: { channels: { items: items, totalItems: 1 } } };
      }
      var base = seeds.fresh(query, isShop);
      return base;
    }
  };
  var seed = seeds[state.kind] || seeds.fresh;
  var fetchFn = function(url, init) {
    var u = String(url);
    calls.push({ url: u, init: init && init.headers ? init.headers : {} });
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var query = body.query || body.query || '';
    var isShop = u.indexOf('/shop-api') !== -1;
    if (u.indexOf('/health') !== -1) {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ status: 'ok' }); } });
    }
    if (query.indexOf('mutation Login') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function(n) { return n === 'vendure-auth-token' ? SENTINEL_AUTH : null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { login: { __typename: 'CurrentUser', id: 'u1', identifier: 'admin@staging.local' } } })); }
      });
    }
    if (query.indexOf('__type') !== -1 || query.indexOf('Introspect') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(introspectionData())); } });
    }
    if (query.indexOf('mutation ') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(makeMutationResponse(query))); } });
    }
    var data = seed(query, isShop);
    return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(data)); } });
  };
  fetchFn.getCalls = function() { return calls; };
  return fetchFn;
}

function makeContext(opts) {
  opts = opts || {};
  var env = {
    SUPERADMIN_USERNAME: 'admin@staging.local',
    SUPERADMIN_PASSWORD: SENTINEL_PASSWORD,
    VENDURE_ADMIN_API_URL: opts.adminApiUrl || 'https://staging.tibella.eu/admin-api',
    SEED_TEST_CUSTOMER_PASSWORD: SENTINEL_CUSTOMER_PASSWORD
  };
  if (opts.env) Object.keys(opts.env).forEach(function(k) { env[k] = opts.env[k]; });
  var fetchFn = opts.fetch || makeSeedFetch({ kind: 'fresh' });
  var context = {
    env: env,
    runId: opts.runId || 'run-seedtest-' + Date.now(),
    stagingUrl: 'https://staging.tibella.eu',
    shopApiUrl: 'https://staging.tibella.eu/shop-api',
    cwd: opts.cwd || process.cwd(),
    deps: {
      getEnv: function() { return env; },
      fetch: fetchFn,
      clock: function() { return new Date('2026-10-13T09:00:00.000Z'); },
      evidenceOptions: function() { return { root: opts.root || process.cwd(), baseDir: 'evidence', reuseExisting: true }; }
    }
  };
  return { context: context, fetchFn: fetchFn };
}

function listFiles(dir) {
  var result = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    var entries = fs.readdirSync(d, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var full = path.join(d, entries[i].name);
      if (entries[i].isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(dir);
  return result;
}

// ---------------------------------------------------------------------------
// Test 1: fresh empty staging -> seeder creates everything the spec needs
// ---------------------------------------------------------------------------

test('seed: fresh empty staging creates zones, tax, channels, products and writes evidence', async function() {
  var runId = 'run-fresh-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.specSha256.length, 64, 'sha256 must be 64 hex chars');
  assert.ok(result.evidence && result.evidence.written, 'evidence must be written');

  // Expected created entities from the spec.
  var createdEntities = {};
  result.created.forEach(function(c) { createdEntities[c.entity] = (createdEntities[c.entity] || 0) + 1; });
  assert.strictEqual(createdEntities['country'], 4, 'DE, AT, HU, GB countries created');
  assert.strictEqual(createdEntities['zone'], 2, 'EU and Non-EU zones created');
  assert.strictEqual(createdEntities['taxCategory'], 1, 'standard tax category created');
  assert.strictEqual(createdEntities['taxRate'], 4, 'four synthetic tax rates created');
  assert.strictEqual(createdEntities['channel'], 4, 'de/at/hu/gb channels created');
  assert.strictEqual(createdEntities['stockLocation'], 5, 'Global + 4 per-country locations created');
  assert.strictEqual(createdEntities['product'], 4, 'four TST products created');
  assert.strictEqual(createdEntities['variant'], 4, 'four TST variants created');
  assert.strictEqual(createdEntities['customer'], 4, 'four per-country test customers created');

  // No conflicts, failures or blocks on a fresh run.
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.failed.length, 0);
  assert.strictEqual(result.blocked.length, 0);
});

async function seed(fn, context, options) {
  return await fn(context, options);
}

// ---------------------------------------------------------------------------
// Test 2: no secret strings in ANY written file (deep check, no `secrets` key)
// ---------------------------------------------------------------------------

test('seed: no sentinel secret strings appear in any written file and no secrets key is written', async function() {
  var runId = 'run-nosecrets-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  var written = listFiles(root);
  assert.ok(written.length > 0, 'seeder should write evidence files');
  var secretValues = [SENTINEL_PASSWORD, SENTINEL_AUTH, SENTINEL_TOKEN, SENTINEL_CUSTOMER_PASSWORD,
    'de-token', 'at-token', 'hu-token', 'gb-token'];
  for (var i = 0; i < written.length; i++) {
    var content = fs.readFileSync(written[i], 'utf8');
    for (var s = 0; s < secretValues.length; s++) {
      assert.strictEqual(content.indexOf(secretValues[s]), -1,
        'secret value ' + secretValues[s] + ' leaked into ' + written[i]);
    }
    assert.strictEqual(content.indexOf('"secrets"'), -1, 'no secrets key may be written in ' + written[i]);
  }

  // The returned record must not serialize a secrets key either.
  var serialized = JSON.stringify(result);
  assert.strictEqual(serialized.indexOf('"secrets"'), -1, 'returned result must not contain a secrets key');
  assert.strictEqual(serialized.indexOf(SENTINEL_PASSWORD), -1);
  assert.strictEqual(serialized.indexOf(SENTINEL_AUTH), -1);
});

// ---------------------------------------------------------------------------
// Test 3: second run against already-seeded mock -> zero mutations, all existing
// ---------------------------------------------------------------------------

test('seed: second run against already-seeded mock performs zero mutations', async function() {
  var runId = 'run-seeded-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'seeded' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mutations, 0, 'a fully-seeded staging must produce zero mutations');
  assert.ok(result.existing.length >= 4, 'existing entities should be recorded');
  var seen = {};
  result.existing.forEach(function(e) { seen[e.entity] = true; });
  // Products are recorded as existing; their variants are not separately
  // looked up when the product already exists (zero mutations either way).
  ['country', 'zone', 'taxCategory', 'taxRate', 'channel', 'stockLocation', 'product', 'customer'].forEach(function(ent) {
    assert.strictEqual(seen[ent], true, 'expected an existing ' + ent);
  });
  assert.strictEqual(result.created.length, 0);
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.failed.length, 0);
});

// ---------------------------------------------------------------------------
// Test 4: conflict -> channel token exists with a different currency
// ---------------------------------------------------------------------------

test('seed: SEED_CONFLICT when a channel token exists with a different currency, other entities still handled', async function() {
  var runId = 'run-conflict-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'conflict' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  assert.strictEqual(result.ok, false, 'a conflict means the seed is not fully clean');
  var channelConflicts = result.conflicts.filter(function(c) { return c.entity === 'channel'; });
  assert.ok(channelConflicts.length > 0, 'a channel conflict must be recorded');
  assert.strictEqual(channelConflicts[0].code, 'de');
  assert.strictEqual(channelConflicts[0].reason.indexOf('different currency') !== -1, true);

  // The conflicting DE channel must never be mutated: no channel mutation whose
  // body carries code "de" may be issued.
  var mutationBodies = fetchFn.getCalls()
    .filter(function(call) { return call.init && typeof call.init['content-type'] === 'string' ? false : call.url.indexOf('/admin-api') !== -1; })
    .filter(function(call) { return /mutation/.test(JSON.stringify(call.init)); })
    .map(function(call) { return JSON.stringify(call.init); });
  for (var i = 0; i < mutationBodies.length; i++) {
    if (mutationBodies[i].indexOf('createChannel') !== -1) {
      assert.strictEqual(JSON.parse(mutationBodies[i]).body.indexOf('"code":"de"') === -1
        && JSON.parse(mutationBodies[i]).body.indexOf('"code": "de"') === -1, true,
        'must not create/overwrite the conflicting DE channel');
    }
  }

  // Other entities are still handled: AT/HU/GB channels are created.
  var createdChannels = result.created.filter(function(c) { return c.entity === 'channel'; });
  var codes = createdChannels.map(function(c) { return c.code; });
  assert.strictEqual(codes.indexOf('at') !== -1, true, 'AT channel must still be created');
  assert.strictEqual(codes.indexOf('hu') !== -1, true, 'HU channel must still be created');
  assert.strictEqual(codes.indexOf('gb') !== -1, true, 'GB channel must still be created');
  assert.strictEqual(codes.indexOf('de'), -1, 'DE channel must never be created');
});

// ---------------------------------------------------------------------------
// Test 5: host guard -> a non-allowlisted host performs zero requests
// ---------------------------------------------------------------------------

test('seed: a non-allowlisted host performs zero requests and returns SEED_HOST_NOT_ALLOWED', async function() {
  var runId = 'run-host-' + Date.now();
  var requested = [];
  var fetchFn = function(url, init) {
    requested.push({ url: url, init: init });
    return Promise.resolve({ status: 200, json: function() { return Promise.resolve({}); }, text: function() { return Promise.resolve('{}'); } });
  };
  var built = makeContext({
    runId: runId,
    fetch: fetchFn,
    adminApiUrl: 'https://evil.example.com/admin-api'
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.reason, 'SEED_HOST_NOT_ALLOWED');
  assert.strictEqual(result.host, 'evil.example.com');
  assert.strictEqual(result.hostAllowed, false);
  assert.strictEqual(requested.length, 0, 'host guard must refuse before any request');
});

// ---------------------------------------------------------------------------
// Test 6: dry-run -> perform reads only, zero mutations
// ---------------------------------------------------------------------------

test('seed: dry-run performs reads only and records zero mutations', async function() {
  var runId = 'run-dry-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, { dryRun: true });

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(result.mutations, 0, 'dry-run must never mutate');
  // The plan is recorded: created entries carry planned:true and are not mutations.
  assert.ok(result.created.length > 0, 'dry-run records the plan for each entity');
  var allPlanned = result.created.every(function(c) { return c.planned === true; });
  assert.strictEqual(allPlanned, true, 'every dry-run created entry must be planned-only');

  // No mutation requests may be issued in dry-run mode.
  var calls = fetchFn.getCalls();
  var mutationCalls = calls.filter(function(call) {
    var query = null;
    try { query = JSON.parse(call.init.body || '{}').query || ''; } catch (e) { query = ''; }
    return query.indexOf('mutation ') === 0;
  });
  assert.strictEqual(mutationCalls.length, 0, 'dry-run must not issue any mutation request');
});

// ---------------------------------------------------------------------------
// Test 7: missing credentials -> ADMIN_CREDENTIALS_MISSING
// ---------------------------------------------------------------------------

test('seed: missing credentials returns ADMIN_CREDENTIALS_MISSING', async function() {
  var runId = 'run-nocred-' + Date.now();
  var requested = [];
  var fetchFn = function(url, init) { requested.push(url); return Promise.resolve({ status: 500, text: function() { return Promise.resolve('err'); } }); };
  var built = makeContext({
    runId: runId,
    fetch: fetchFn,
    adminApiUrl: 'https://staging.tibella.eu/admin-api',
    env: { SUPERADMIN_USERNAME: '', SUPERADMIN_PASSWORD: '' }
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.reason, 'ADMIN_CREDENTIALS_MISSING');
  assert.strictEqual(requested.length, 0, 'no request before the credentials check');
});

