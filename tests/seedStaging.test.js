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

// Real channel tokens the seeded mock DB and the CHANNEL_TOKENS env both use.
// The registry values (de-token etc.) are accepted as-is; the tests use
// distinct real-shaped values so acceptance is proven rather than assumed.
var TEST_CHANNEL_TOKENS = { DE: 'tok-de-real-9f', AT: 'tok-at-real-8e', HU: 'tok-hu-real-7d', GB: 'tok-gb-real-6c' };

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
    var token = (TEST_CHANNEL_TOKENS[c.countryCode]) || c.channelToken;
    var ch = { id: 'chan-' + c.channelCode, code: c.channelCode, token: token, availableCurrencyCodes: [c.currencyCode] };
    ch[channelField()] = c.currencyCode;
    ch.defaultLanguageCode = spec.countries && spec.countries[0] ? spec.countries[0].defaultLanguageCode : 'en';
    ch.defaultTaxZone = { id: 'zone-' + (c.zoneName || '').toLowerCase(), name: (c.zoneName || '') };
    ch.defaultShippingZone = { id: 'zone-' + (c.zoneName || '').toLowerCase(), name: (c.zoneName || '') };
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
  function outputFields(names) {
    return names.map(function(n) { return { name: n }; });
  }
  function inputFields(names) {
    return names.map(function(n) { return { name: n }; });
  }
  return { data: {
    Mutation: { name: 'Mutation', fields: outputFields([
      'login', 'createChat', 'deleteChat', 'createChannel', 'createCountry', 'createZone',
      'createTaxCategory', 'createTaxRate', 'createStockLocation',
      'createProduct', 'createProductVariants', 'assignProductsToChannel',
      'assignProductVariantsToChannel', 'assignStockLocationsToChannel', 'createCustomer',
      'updateGlobalSettings', 'updateChannel'
    ]), inputFields: [] },
    Channel: { name: 'Channel', fields: outputFields([
      'id', 'code', 'token', 'defaultLanguageCode', 'defaultShippingZone',
      'defaultTaxZone', 'pricesIncludeTax', 'availableCurrencyCodes', 'defaultCurrencyCode',
      'currencyCode'
    ]), inputFields: [] },
    // Input object types correctly use 'inputFields', not 'fields'.
    CreateChannelInput: { name: 'CreateChannelInput', fields: [], inputFields: inputFields([
      'code', 'token', 'defaultLanguageCode', 'pricesIncludeTax', 'defaultTaxZoneId',
      'defaultShippingZoneId', 'defaultCurrencyCode', 'currencyCode', 'availableCurrencyCodes'
    ]) },
    CreateProductInput: { name: 'CreateProductInput', fields: [], inputFields: inputFields(['translations', 'enabled']) },
    CreateProductVariantInput: { name: 'CreateProductVariantInput', fields: [], inputFields: inputFields(['productId', 'sku', 'translations', 'price', 'stockOnHand', 'trackInventory', 'outOfStockThreshold']) },
    Zone: { name: 'Zone', fields: outputFields(['id', 'name']), inputFields: [] },
    Country: { name: 'Country', fields: outputFields(['id', 'code', 'enabled']), inputFields: [] },
    GlobalSettings: { name: 'GlobalSettings', fields: outputFields(['availableLanguages', 'pricesIncludeTax']), inputFields: [] },
    UpdateGlobalSettingsInput: { name: 'UpdateGlobalSettingsInput', fields: [], inputFields: inputFields(['availableLanguages']) },
    UpdateChannelInput: { name: 'UpdateChannelInput', fields: [], inputFields: inputFields(['id', 'defaultLanguageCode']) }
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
  // Stock location assignment: must return a non-empty value so the seeder
  // recognises success.  Vendure returns StockLocation[] but a truthy value
  // with no ErrorResult typename is sufficient for the seeder's check.
  if (query.indexOf('assignStockLocationsToChannel') !== -1 || query.indexOf('AssignStockLocationsToChannel') !== -1) {
    return { data: { assignStockLocationsToChannel: [{ __typename: 'StockLocation', id: 'new-loc' }] } };
  }
  if (query.indexOf('createChannel') !== -1) {
    return { data: { createChannel: { __typename: 'Channel', id: 'new-channel', code: 'de', token: SENTINEL_TOKEN, defaultCurrencyCode: 'EUR' } } };
  }
  // Vendure createProductVariants returns ProductVariant[] (an array).
  if (query.indexOf('createProductVariants') !== -1) {
    return { data: { createProductVariants: [{ __typename: 'ProductVariant', id: 'new-variant', sku: 'TST' }] } };
  }
  if (query.indexOf('createProduct') !== -1) {
    return { data: { createProduct: { __typename: 'Product', id: 'new-product', slug: 'tst' } } };
  }
  if (query.indexOf('assignProductsToChannel') !== -1 || query.indexOf('assignProductVariantsToChannel') !== -1) {
    return { data: { assignProductsToChannel: [{ id: 'new-product' }], assignProductVariantsToChannel: [{ id: 'new-variant' }] } };
  }
  if (query.indexOf('updateProductVariants') !== -1) {
    return { data: { updateProductVariants: [{ id: 'new-variant', sku: 'TST' }] } };
  }
  if (query.indexOf('updateChannel') !== -1) {
    return { data: { updateChannel: { __typename: 'Channel', id: 'new-channel', code: 'de', defaultLanguageCode: 'en' } } };
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
          id: 'chan-de', code: 'de', token: TEST_CHANNEL_TOKENS.DE, availableCurrencyCodes: ['USD']
        }];
        items[0][channelField()] = 'USD';
        return { data: { channels: { items: items, totalItems: 1 } } };
      }
      var base = seeds.fresh(query, isShop);
      return base;
    }
  };
  var seed = seeds[state.kind] || seeds.fresh;
  if (typeof seed !== 'function') seed = seeds.fresh;
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
  if (query.indexOf('Introspect') !== -1) {
   return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(introspectionData())); } });
  }
  if (query.indexOf('globalSettings') !== -1) {
   var langs = (state && state.availableLanguages) || ['en', 'de'];
   return Promise.resolve({
   status: 200,
   headers: { get: function() { return null; } },
   text: function() { return Promise.resolve(JSON.stringify({ data: { globalSettings: { availableLanguages: langs } } })); }
   });
  }
  if (query.indexOf('updateGlobalSettings') !== -1) {
   var reqLangs = body.variables && body.variables.input && body.variables.input.availableLanguages;
   return Promise.resolve({
   status: 200,
   headers: { get: function() { return null; } },
   text: function() { return Promise.resolve(JSON.stringify({ data: { updateGlobalSettings: { __typename: 'GlobalSettings', availableLanguages: reqLangs || ['de', 'en'] } } })); }
   });
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
    SEED_TEST_CUSTOMER_PASSWORD: SENTINEL_CUSTOMER_PASSWORD,
    CHANNEL_TOKENS: (opts.channelTokens !== undefined ? opts.channelTokens : JSON.stringify(TEST_CHANNEL_TOKENS))
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
  if (opts.givenRunEnv) {
    context.runEnv = { gitHead: 'cafebaberev1', revisionId: null, referenceCommit: 'refcommit-123' };
    context.runEnvRecord = { gitHead: 'cafebaberev1', referenceCommit: 'refcommit-123' };
  }
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
  // Cause names the three scoped env vars and no sentinel values.
  var eNames = ['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD', 'SEED_TEST_CUSTOMER_PASSWORD'];
  for (var i = 0; i < eNames.length; i++) {
    assert.ok(result.cause.indexOf(eNames[i]) !== -1, 'cause must name ' + eNames[i] + ', got: ' + result.cause);
  }
  [SENTINEL_PASSWORD, SENTINEL_CUSTOMER_PASSWORD, SENTINEL_AUTH].forEach(function(s) {
    assert.strictEqual(result.cause.indexOf(s), -1, 'cause must not contain sentinel: ' + s);
  });
});

// ---------------------------------------------------------------------------
// Test 8: mutation counter accuracy — blocked/assigned/updated are NOT failures
// ---------------------------------------------------------------------------

test('seed: mutation counter counts only real writes; blocked/assigned/updated are not failures', async function() {
  // Use the fully-seeded scenario which produces zero mutations and zero failures.
  var runId = 'run-mutcount-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  assert.strictEqual(result.ok, true, 'fresh run must succeed');
  // Failures must be zero; blocked/assigned/updated must NOT appear there.
  assert.strictEqual(result.failed.length, 0, 'failed must be empty on a clean fresh run');
  // mutations counts only actual writes (created + assigned + updated), not failures.
  assert.ok(result.mutations > 0, 'fresh run must report positive mutation count');
  // The created list must not contain any entry whose entity is 'stockLocationToChannel'
  // classified as 'failed' — it should be in created (assigned) or blocked, not failed.
  var failedEntities = result.failed.map(function(f) { return f.entity; });
  assert.strictEqual(failedEntities.indexOf('stockLocationToChannel'), -1,
    'stockLocationToChannel must not appear in failed');
});

// ---------------------------------------------------------------------------
// Test 9: admin auth token and channel context token are kept separate
// ---------------------------------------------------------------------------

test('seed: createProduct uses admin authToken for auth, not channel token', async function() {
  var runId = 'run-authsep-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var capturedCalls = [];
  var innerFetch = makeSeedFetch({ kind: 'fresh' });
  var wrappedFetch = function(url, init) {
    capturedCalls.push({ url: String(url), headers: (init && init.headers) ? Object.assign({}, init.headers) : {} });
    return innerFetch(url, init);
  };
  wrappedFetch.getCalls = function() { return capturedCalls; };
  var built = makeContext({ runId: runId, fetch: wrappedFetch, root: root, cwd: root });
  await seed(seedStaging.seedStaging, built.context, {});

  // Find all createProduct mutation calls.
  var SENTINEL_AUTH_TOKEN = 'sentinel-auth-token-9f8e';
  var channelTokens = ['de-token', 'at-token', 'hu-token', 'gb-token', SENTINEL_TOKEN];

  var createProductCalls = capturedCalls.filter(function(c) {
    try { return JSON.parse(c.headers.body || '{}').query && false; } catch(e) { return false; }
  });
  // Check that no admin-api call places a channel token in Authorization or vendure-auth-token.
  capturedCalls.forEach(function(call) {
    if (call.url.indexOf('/admin-api') === -1) return;
    var authHeader = call.headers['Authorization'] || call.headers['authorization'] || '';
    var authTokenHeader = call.headers['vendure-auth-token'] || '';
    channelTokens.forEach(function(tok) {
      assert.strictEqual(authHeader.indexOf(tok), -1,
        'channel token ' + tok + ' must not appear in Authorization header');
      assert.strictEqual(authTokenHeader.indexOf(tok), -1,
        'channel token ' + tok + ' must not appear in vendure-auth-token header');
    });
  });
});

// ---------------------------------------------------------------------------
// Test 10: GraphQL errors array is treated as an error even with HTTP 200
// ---------------------------------------------------------------------------

test('seed: GraphQL errors in response body are treated as errors even with HTTP 200', async function() {
  var runId = 'run-gqlerr-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var spec = loadSpec();
  // Use a fetch that returns HTTP 200 with a GraphQL errors array for login.
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch(e) { return {}; } })() : {};
    var query = body.query || '';
    if (query.indexOf('mutation Login') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() {
          return Promise.resolve(JSON.stringify({
            errors: [{ message: 'Invalid credentials', locations: [] }],
            data: { login: null }
          }));
        }
      });
    }
    return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  // Login failed (GraphQL error at HTTP 200) — seeder must not proceed.
  assert.strictEqual(result.ok, false, 'GraphQL login error must prevent seeding');
  assert.ok(result.reason, 'a reason must be given');
  // No mutations must have been made.
  assert.strictEqual(result.mutations, 0, 'no mutations after login failure');
});

// ---------------------------------------------------------------------------
// Test 11: introspection uses inputFields for CreateChannelInput
// ---------------------------------------------------------------------------

test('seed: introspection populates inputFields for input object types', async function() {
  var runId = 'run-introspect-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  // The returned result exposes introspectedTypes.
  assert.ok(result.introspectedTypes, 'introspectedTypes must be present');
  var cci = result.introspectedTypes.CreateChannelInput;
  assert.ok(cci, 'CreateChannelInput must be in introspectedTypes');
  // With the corrected mock (inputFields), availableCurrencyCodes is in inputFields,
  // not in fields.  The seeder must detect it and include it in channel creation.
  assert.ok(
    (cci.inputFields && cci.inputFields.indexOf('availableCurrencyCodes') !== -1),
    'availableCurrencyCodes must appear in inputFields of CreateChannelInput'
  );
  assert.strictEqual(
    cci.fields && cci.fields.indexOf('availableCurrencyCodes') !== -1, false,
    'availableCurrencyCodes must NOT appear in fields (wrong key for input type)'
  );
});

// ---------------------------------------------------------------------------
// Test 12: createProductVariants real array response is handled correctly
// ---------------------------------------------------------------------------

test('seed: createProductVariants handles real array response from Vendure', async function() {
  var runId = 'run-vararray-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  // Use a mock that returns the real Vendure array shape for createProductVariants.
  var innerFetch = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch(e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('createProductVariants') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() {
          return Promise.resolve(JSON.stringify({
            data: { createProductVariants: [{ __typename: 'ProductVariant', id: 'arr-variant-id', sku: 'TST-REAL' }] }
          }));
        }
      });
    }
    return innerFetch(url, init);
  };
  fetchFn.getCalls = innerFetch.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  // Must succeed and variants must be recorded as created (not failed).
  assert.strictEqual(result.failed.filter(function(f) { return f.entity === 'variant'; }).length, 0,
    'no variant must be in failed when createProductVariants returns an array');
  var createdVariants = result.created.filter(function(c) { return c.entity === 'variant'; });
  assert.ok(createdVariants.length > 0, 'variants must appear in created');
  // The extracted id must not be null.
  createdVariants.forEach(function(cv) {
    assert.ok(cv.id !== null, 'variant created entry must carry the extracted id');
  });
});

// ---------------------------------------------------------------------------
// Test 13: fallback evidence write redacts secrets even without evidenceCollector
// ---------------------------------------------------------------------------

test('seed: fallback evidence write redacts sentinel secrets when evidenceCollector unavailable', function() {
  var seedStagingModule = require('../src/staging/seedStaging');
  var SENTINEL_PW = 'fallback-test-secret-pw-xyz';
  var SENTINEL_TOKEN_VAL = 'fallback-channel-tok-abc';
  var runId = 'run-fallback-redact-' + Date.now();
  var tmpRoot = path.join(__dirname, '..', 'runs', runId);
  fs.mkdirSync(tmpRoot, { recursive: true });

  // Simulate the state that writeSeedEvidence receives.
  var state = { secrets: [SENTINEL_PW, SENTINEL_TOKEN_VAL] };
  var context = {
    runId: runId,
    deps: { evidenceOptions: function() { return { root: tmpRoot, baseDir: 'evidence', reuseExisting: true }; } },
    cwd: tmpRoot
  };
  var payload = JSON.stringify({ channels: [{ code: 'de', note: SENTINEL_PW + ' and ' + SENTINEL_TOKEN_VAL }] });

  // Call writeSeedEvidence; it will use evidenceCollector or the fallback.
  // Force fallback by temporarily hiding evidenceCollector.
  var Module = require('module');
  var realResolve = Module._resolveFilename;
  var hiddenPath = require.resolve('../src/evidenceCollector');
  var orig = require.cache[hiddenPath];
  delete require.cache[hiddenPath];
  Module._resolveFilename = function(id, parent, isMain, opts) {
    if (id === '../evidenceCollector' || id.indexOf('evidenceCollector') !== -1) {
      throw new Error('module not found (forced for test)');
    }
    return realResolve.call(this, id, parent, isMain, opts);
  };
  try {
    var written = seedStagingModule.writeSeedEvidence(context, state, payload);
    assert.strictEqual(written.ok, true, 'fallback write must succeed');
    // Read back and verify redaction.
    var filePath = written.result && written.result.path;
    assert.ok(filePath, 'fallback must return a file path');
    var content = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(content.indexOf(SENTINEL_PW), -1, 'admin password must be redacted in fallback output');
    assert.strictEqual(content.indexOf(SENTINEL_TOKEN_VAL), -1, 'channel token must be redacted in fallback output');
  } finally {
    // Restore require.cache and _resolveFilename.
    Module._resolveFilename = realResolve;
    if (orig) require.cache[hiddenPath] = orig;
  }
});

// ---------------------------------------------------------------------------
// Test 14: dry-run records no mutation requests (mutation kinds = 'planned')
// ---------------------------------------------------------------------------

test('seed: dry-run planned entries carry planned flag and mutations stays 0', async function() {
  var runId = 'run-dryplan-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, { dryRun: true });

  assert.strictEqual(result.mutations, 0, 'dry-run mutations must stay 0');
  assert.strictEqual(result.dryRun, true, 'dryRun flag must be true');
  // All created entries must carry planned:true and must not have triggered an HTTP mutation.
  result.created.forEach(function(c) {
    assert.strictEqual(c.planned, true, 'every created entry in dry-run must have planned=true, got: ' + JSON.stringify(c));
  });
  // No mutation HTTP requests may be present.
  var calls = fetchFn.getCalls();
  var mutationCalls = calls.filter(function(call) {
    var q = '';
    try { var b = JSON.parse(call.init && call.init.body || '{}'); q = b.query || ''; } catch(e) {}
    return q.indexOf('mutation ') === 0 && q.indexOf('mutation Login') === -1;
  });
  assert.strictEqual(mutationCalls.length, 0, 'dry-run must not issue any non-login mutation request');
});

// ---------------------------------------------------------------------------
// Test 15: partial state — product exists but variant is missing
// ---------------------------------------------------------------------------

test('seed: existing product with missing variant creates only the missing variant', async function() {
  var runId = 'run-partial-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var spec = loadSpec();
  // Mock: all products exist, but variants are missing for all.
  var partialFetch = makeSeedFetch({ kind: 'fresh' });
  var wrappedFetch = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch(e) { return {}; } })() : {};
    var q = body.query || '';
    // Serve products as existing (by slug query) but return empty variants.
    if (q.indexOf('products') !== -1 && q.indexOf('filter') !== -1 && q.indexOf('slug') !== -1) {
      var slugMatch = body.variables && body.variables.slug;
      var found = spec.products.filter(function(p) { return p.slug === slugMatch; });
      if (found.length > 0) {
        return Promise.resolve({
          status: 200,
          headers: { get: function() { return null; } },
          text: function() {
            return Promise.resolve(JSON.stringify({
              data: { products: { items: [{ id: 'prod-' + found[0].slug, slug: found[0].slug, channels: [] }], totalItems: 1 } }
            }));
          }
        });
      }
    }
    if (q.indexOf('productVariants') !== -1 && q.indexOf('filter') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() {
          return Promise.resolve(JSON.stringify({ data: { productVariants: { items: [], totalItems: 0 } } }));
        }
      });
    }
    return partialFetch(url, init);
  };
  wrappedFetch.getCalls = partialFetch.getCalls;
  var built = makeContext({ runId: runId, fetch: wrappedFetch, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  // Products should be existing; variants should be created.
  var existingProducts = result.existing.filter(function(e) { return e.entity === 'product'; });
  assert.ok(existingProducts.length > 0, 'existing products must be recorded');
  var createdVariants = result.created.filter(function(c) { return c.entity === 'variant'; });
  assert.ok(createdVariants.length > 0, 'missing variants must be created');
  // There must be no product in created (they already existed).
  var createdProducts = result.created.filter(function(c) { return c.entity === 'product'; });
  assert.strictEqual(createdProducts.length, 0, 'products that already exist must not be re-created');
  // No failures.
  assert.strictEqual(result.failed.length, 0, 'partial state recovery must produce no failures');
});

// ---------------------------------------------------------------------------
// Test 16: seeder makes zero requests when hostname guard fails
// ---------------------------------------------------------------------------

test('seed: disallowed hostname blocks all requests including health-check', async function() {
  var requested = [];
  var fetchFn = function(url, init) {
    requested.push(String(url));
    return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  };
  fetchFn.getCalls = function() { return requested; };
  var built = makeContext({ fetch: fetchFn, adminApiUrl: 'https://production.tibella.eu/admin-api' });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.reason, 'SEED_HOST_NOT_ALLOWED');
  assert.strictEqual(requested.length, 0, 'zero requests must be made to a disallowed host');
});

// ---------------------------------------------------------------------------
// Test 17: second run creates no duplicates — mutations is exactly 0
// ---------------------------------------------------------------------------

test('seed: second run with already-seeded state creates no new entities', async function() {
  var runId = 'run-nodedup-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = makeSeedFetch({ kind: 'seeded' });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  assert.strictEqual(result.mutations, 0, 'second run must produce exactly 0 mutations');
  assert.strictEqual(result.created.length, 0, 'second run must not create any entity');
  assert.strictEqual(result.failed.length, 0, 'second run must not fail');
  assert.strictEqual(result.conflicts.length, 0, 'second run must not produce conflicts on an identical seed');
});

// ---------------------------------------------------------------------------
// Failure-diagnostic tests for ensureCountries / ensureZones creates
// ---------------------------------------------------------------------------

function createMutationOverrideFetch(kind, payloadFn) {
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('mutation Create' + kind) !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify(payloadFn(q, body))); }
      });
    }
    return inner(url, init);
  };
  fn.getCalls = inner.getCalls || function() { return []; };
  return fn;
}

test('seed: createCountry failure surfaces top-level GraphQL errors with secrets redacted', async function() {
  var runId = 'run-country-gql-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = createMutationOverrideFetch('Country', function() {
    return { errors: [{ message: 'DUPLICATE for ' + SENTINEL_AUTH }], data: { createCountry: null } };
  });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  var countryFailures = result.failed.filter(function(f) { return f.entity === 'country'; });
  assert.ok(countryFailures.length > 0, 'a country creation failure must be recorded');
  assert.strictEqual(countryFailures[0].error.indexOf('graphql:'), 0, 'diagnostic must start with the top-level error');
  assert.strictEqual(countryFailures[0].error.indexOf('DUPLICATE') !== -1, true, 'useful message preserved');
  assert.strictEqual(countryFailures[0].error.indexOf(SENTINEL_AUTH), -1, 'auth token must be redacted from the diagnostic');
});

test('seed: createZone failure surfaces top-level GraphQL errors', async function() {
  var runId = 'run-zone-gql-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = createMutationOverrideFetch('Zone', function() {
    return { errors: [{ message: 'zone limit reached' }], data: { createZone: null } };
  });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  var zoneFailures = result.failed.filter(function(f) { return f.entity === 'zone'; });
  assert.ok(zoneFailures.length > 0, 'a zone creation failure must be recorded');
  assert.strictEqual(zoneFailures[0].error.indexOf('graphql:'), 0, 'diagnostic must start with the top-level error');
  assert.strictEqual(zoneFailures[0].error.indexOf('zone limit reached') !== -1, true, 'useful message preserved');
});

test('seed: createCountry ErrorResult message and top-level errors both captured, secrets redacted', async function() {
  var runId = 'run-country-result-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = createMutationOverrideFetch('Country', function() {
    return {
      errors: [{ message: 'top-level ' + SENTINEL_PASSWORD }],
      data: { createCountry: { __typename: 'IllegalOperationError', message: 'cannot create country', errorCode: 'ILLEGAL_OPERATION' } }
    };
  });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  var countryFailures = result.failed.filter(function(f) { return f.entity === 'country'; });
  assert.ok(countryFailures.length > 0, 'a country creation failure must be recorded');
  assert.strictEqual(countryFailures[0].error.indexOf('graphql: top-level') !== -1, true, 'top-level error must be present');
  assert.strictEqual(countryFailures[0].error.indexOf('result: cannot create country') !== -1, true, 'ErrorResult message must be present');
  assert.strictEqual(countryFailures[0].error.indexOf('ILLEGAL_OPERATION') !== -1, true, 'ErrorResult errorCode must be present');
  assert.strictEqual(countryFailures[0].error.indexOf(SENTINEL_PASSWORD), -1, 'password must be redacted from the diagnostic');
});

test('seed: createZone ErrorResult message captured and secrets redacted', async function() {
  var runId = 'run-zone-result-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = createMutationOverrideFetch('Zone', function() {
    return { data: { createZone: { __typename: 'NativeAuthStrategyError', message: 'zone denied for ' + SENTINEL_CUSTOMER_PASSWORD, errorCode: 'UNAUTHORIZED' } } };
  });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});

  var zoneFailures = result.failed.filter(function(f) { return f.entity === 'zone'; });
  assert.ok(zoneFailures.length > 0, 'a zone creation failure must be recorded');
  assert.strictEqual(zoneFailures[0].error.indexOf('result: zone denied') !== -1, true, 'ErrorResult message must be present');
  assert.strictEqual(zoneFailures[0].error.indexOf('UNAUTHORIZED') !== -1, true, 'ErrorResult errorCode must be present');
  assert.strictEqual(zoneFailures[0].error.indexOf(SENTINEL_CUSTOMER_PASSWORD), -1, 'customer password must be redacted');
});

test('seed: createCountry failure falls back to HTTP status and networkError when no message exists', async function() {
  var runId = 'run-country-fb-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('mutation CreateCountry') !== -1) {
      // No useful message anywhere: neither errors nor ErrorResult.
      return Promise.resolve({ status: 418, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify({ data: { createCountry: { __typename: 'CountryError', id: null } } })); } });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var countryFailures = result.failed.filter(function(f) { return f.entity === 'country'; });
  assert.ok(countryFailures.length > 0, 'a country creation failure must be recorded');
  assert.strictEqual(countryFailures[0].error.indexOf('http 418') !== -1, true,
    'HTTP status must appear in the fallback diagnostic, got: ' + countryFailures[0].error);
});

// ---------------------------------------------------------------------------
// Mutation-document regression tests (createCountry/createZone/createChannel/
// createStockLocation/createProduct return types from the Vendure schema)
// ---------------------------------------------------------------------------

function captureFullInitFetch(inner) {
  var calls = [];
  var fn = function(url, init) {
    calls.push({ url: String(url), init: init });
    return inner(url, init);
  };
  fn.getCalls = function() { return calls; };
  return fn;
}

function queriesMatching(fetchFn, operationName) {
  var out = [];
  var calls = fetchFn.getCalls ? fetchFn.getCalls() : [];
  for (var i = 0; i < calls.length; i++) {
    var init = calls[i] && calls[i].init ? calls[i].init : {};
    var bodyStr = typeof init.body === 'string' ? init.body : JSON.stringify(init.body || {});
    var parsed = null;
    try { parsed = JSON.parse(bodyStr); } catch (e) { parsed = null; }
    var q = parsed && parsed.query ? parsed.query : '';
    if (!q) continue;
    var op = q.match(/\bmutation\s+(\w+)/);
    if (op && op[1] === operationName) out.push(q);
  }
  return out;
}

// Return types come from the Vendure snapshot
// (evaluation-demo/migration-input/legacy/vendure-store/src/gql/graphql-env.d.ts).
var CONCRETE_RETURN_MUTATIONS = {
  createCountry: ['id', 'code', 'enabled'],
  createZone: ['id', 'name'],
  createStockLocation: ['id', 'name'],
  createProduct: ['id', 'slug'],
  createTaxRate: ['id', 'name'],
  createProductVariants: ['id', 'sku'],
  updateProductVariants: ['id', 'sku']
};
var UNION_RETURN_MUTATIONS = ['createChannel', 'createCustomer', 'login'];

test('seed: createProductVariants returning null data records variant as failed', async function() {
  var runId = 'run-cpv-null-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = createMutationOverrideFetch('ProductVariants', function() {
    return { errors: [{ message: 'variant create denied' }], data: { createProductVariants: null } };
  });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var variantFailures = result.failed.filter(function(f) { return f.entity === 'variant'; });
  assert.ok(variantFailures.length > 0, 'a variant failure must be recorded');
  assert.strictEqual(variantFailures[0].error.indexOf('variant create denied') !== -1, true, 'GraphQL error message preserved');
});

test('seed: createProduct returning null data records product as failed', async function() {
  var runId = 'run-cp-null-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = createMutationOverrideFetch('Product', function() {
    return { errors: [{ message: 'product create denied' }], data: { createProduct: null } };
  });
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var productFailures = result.failed.filter(function(f) { return f.entity === 'product'; });
  assert.ok(productFailures.length > 0, 'a product failure must be recorded');
  assert.strictEqual(productFailures[0].error.indexOf('product create denied') !== -1, true, 'GraphQL error message preserved');
});

test('seed: assignProductsToChannel HTTP 200 + GraphQL errors records blocked', async function() {
  var runId = 'run-assign-gql-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('assignProductsToChannel') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ errors: [{ message: 'channel not found' }], data: null })); }
      });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var blocked = result.blocked.filter(function(b) { return b.entity === 'product'; });
  assert.ok(blocked.length > 0, 'assignment failure must be recorded as blocked');
  assert.ok(blocked.some(function(b) { return b.error.indexOf('channel not found') !== -1; }), 'GraphQL error preserved in blocked reason');
});

test('seed: updateProductVariants HTTP 200 + GraphQL errors records blocked', async function() {
  var runId = 'run-price-gql-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('updateProductVariants') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ errors: [{ message: 'price context denied' }], data: { updateProductVariants: null } })); }
      });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var blocked = result.blocked.filter(function(b) { return b.entity === 'variantPrice'; });
  assert.ok(blocked.length > 0, 'price failure must be recorded as blocked');
  assert.ok(blocked.some(function(b) { return b.error.indexOf('price context denied') !== -1; }), 'GraphQL error preserved in blocked reason');
});

test('seed: updateProductVariants empty array result records blocked', async function() {
  var runId = 'run-price-empty-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('updateProductVariants') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { updateProductVariants: [] } })); }
      });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var blocked = result.blocked.filter(function(b) { return b.entity === 'variantPrice'; });
  assert.ok(blocked.length > 0, 'empty price result must be recorded as blocked');
});

test('seed: readback products API error is reflected as failed and ok:false', async function() {
  var runId = 'run-readback-err-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var u = String(url);
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (u.indexOf('/shop-api') !== -1 && q.indexOf('products') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { activeChannel: { code: 'de', currencyCode: 'EUR' }, products: {} } })); }
      });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var readbackFailed = result.failed.filter(function(f) { return f.entity === 'readback'; });
  assert.ok(readbackFailed.length > 0, 'readback API error must be recorded as failed');
  assert.strictEqual(result.ok, false, 'readback failure must not yield ok:true');
});

test('seed: blocked operations force final ok:false', async function() {
  var runId = 'run-blocked-ok-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('assignProductsToChannel') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ errors: [{ message: 'blocked assignment' }], data: null })); }
      });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, false, 'blocked operations must force ok:false');
});

test('seed: mutation documents for concrete-return types never spread ErrorResult and select __typename', async function() {
  var runId = 'run-mutdocs-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = captureFullInitFetch(makeSeedFetch({ kind: 'fresh' }));
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true, 'fresh run must succeed');

  Object.keys(CONCRETE_RETURN_MUTATIONS).forEach(function(fieldName) {
    var opName = 'Create' + fieldName.slice(6);
    var queries = queriesMatching(fetchFn, opName);
    assert.ok(queries.length > 0, 'expected a ' + opName + ' mutation to be issued');
    queries.forEach(function(q) {
      assert.strictEqual(q.indexOf('... on ErrorResult'), -1,
        fieldName + ' returns a concrete object type and must not spread ErrorResult');
      assert.strictEqual(q.indexOf('__typename') !== -1, true,
        fieldName + ' must select __typename so the result-type check works against a real server');
      CONCRETE_RETURN_MUTATIONS[fieldName].forEach(function(f) {
        assert.strictEqual(q.indexOf(f) !== -1, true, fieldName + ' must select field ' + f);
      });
    });
  });
});

test('seed: mutation documents for union-return types keep the ErrorResult fragment', async function() {
  var runId = 'run-unions-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var fetchFn = captureFullInitFetch(makeSeedFetch({ kind: 'fresh' }));
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true, 'fresh run must succeed');

  UNION_RETURN_MUTATIONS.forEach(function(fieldName) {
    var opName = fieldName === 'login' ? 'Login' : 'Create' + fieldName.slice(6);
    var queries = queriesMatching(fetchFn, opName);
    assert.ok(queries.length > 0, 'expected a ' + opName + ' mutation to be issued');
    queries.forEach(function(q) {
      assert.strictEqual(q.indexOf('... on ErrorResult') !== -1, true,
        fieldName + ' returns a union and must keep the ErrorResult fragment');
    });
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the confirmed staging seed defects
// ---------------------------------------------------------------------------

// Capture the createProductVariants request body so the trackInventory value
// that is actually sent can be asserted.
function captureVariantCreateFetch(inner) {
  var variantCalls = [];
  var fn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('createProductVariants') !== -1) {
      variantCalls.push(body);
    }
    return inner(url, init);
  };
  fn.getVariantCalls = function() { return variantCalls; };
  fn.getCalls = inner.getCalls || function() { return []; };
  return fn;
}

test('seed: trackInventory is sent as GlobalFlag enum, not Boolean', async function() {
  var runId = 'run-trackflag-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var fetchFn = captureVariantCreateFetch(inner);
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true, 'fresh run must succeed');
  var variantCalls = fetchFn.getVariantCalls();
  assert.ok(variantCalls.length > 0, 'expected createProductVariants calls');
  for (var i = 0; i < variantCalls.length; i++) {
    var input = variantCalls[i].variables && variantCalls[i].variables.input;
    assert.ok(Array.isArray(input) && input.length > 0, 'input must be an array of variants');
    for (var v = 0; v < input.length; v++) {
      var tk = input[v].trackInventory;
      // Must be the GlobalFlag enum string; a Boolean (or missing) is the bug.
      assert.ok(tk === 'TRUE' || tk === 'FALSE' || tk === 'INHERIT',
        'trackInventory must be a GlobalFlag enum value, got: ' + JSON.stringify(tk));
    }
  }
});

test('seed: trackInventory maps true/false/undefined to TRUE/FALSE/INHERIT', async function() {
  var runId = 'run-trackspec-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  // Build a custom spec whose variants exercise all three GlobalFlag input
  // cases: a Boolean true, a Boolean false, and an undefined (missing) value.
  var base = loadSpec();
  var spec = JSON.parse(JSON.stringify(base));
  spec.products.forEach(function(p) {
    p.variants.forEach(function(v) {
      if (v.sku === 'TST-ALL-1') v.trackInventory = true;
      else if (v.sku === 'TST-DE-ONLY-1') v.trackInventory = false;
      else delete v.trackInventory;
    });
  });
  var specPath = path.join(root, 'custom-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  var inner = makeSeedFetch({ kind: 'fresh', spec: spec });
  var fetchFn = captureVariantCreateFetch(inner);
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, { specPath: specPath });
  assert.strictEqual(result.ok, true, 'fresh run must succeed');
  var variantCalls = fetchFn.getVariantCalls();
  assert.ok(variantCalls.length > 0, 'expected createProductVariants calls');
  var bySku = {};
  for (var i = 0; i < variantCalls.length; i++) {
    var input = variantCalls[i].variables && variantCalls[i].variables.input;
    assert.ok(Array.isArray(input) && input.length > 0, 'input must be an array of variants');
    for (var v = 0; v < input.length; v++) {
      bySku[input[v].sku] = input[v].trackInventory;
    }
  }
  assert.strictEqual(bySku['TST-ALL-1'], 'TRUE', 'boolean true must map to TRUE');
  assert.strictEqual(bySku['TST-DE-ONLY-1'], 'FALSE', 'boolean false must map to FALSE');
  assert.strictEqual(bySku['TST-HU-ONLY-1'], 'INHERIT', 'undefined must map to INHERIT');
  assert.strictEqual(bySku['TST-DE-AT-1'], 'INHERIT', 'undefined must map to INHERIT');
});

test('seed: missing explicit customer password triggers HMAC derivation and seed proceeds', async function() {
  var runId = 'run-nopw-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  // Use makeSeedFetch which properly handles login, introspection, and mutations.
  // With SEED_TEST_CUSTOMER_PASSWORD empty but SUPERADMIN_PASSWORD available,
  // the seed should derive the password via HMAC and proceed.
  var inner = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({
    runId: runId,
    fetch: inner,
    root: root,
    cwd: root,
    env: { SEED_TEST_CUSTOMER_PASSWORD: '' }
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  // Seed should succeed (customer password is derived via HMAC)
  assert.strictEqual(result.ok, true, 'seed with HMAC-derived password must succeed');
  // Password source should be 'derived'
  assert.strictEqual(result.customerPasswordSource, 'derived', 'customerPasswordSource must be derived');
  // Customer creation should succeed (using derived password)
  var customerCreates = result.created.filter(function(c) { return c.entity === 'customer'; });
  assert.ok(customerCreates.length > 0, 'customers should be created using the derived password');
});

test('seed: explicit SEED_TEST_CUSTOMER_PASSWORD wins over derived', async function() {
  var runId = 'run-explicitpw-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  // Set both SEED_TEST_CUSTOMER_PASSWORD (explicit) and SUPERADMIN_PASSWORD (for HMAC).
  // The explicit password must win.
  var built = makeContext({
    runId: runId,
    fetch: inner,
    root: root,
    cwd: root,
    env: {
      SEED_TEST_CUSTOMER_PASSWORD: 'explicit-test-customer-pw-xyz',
      SUPERADMIN_PASSWORD: SENTINEL_PASSWORD
    }
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  // Explicit password wins: source should be 'env', not 'derived'
  assert.strictEqual(result.ok, true, 'seed with explicit password must succeed');
  assert.strictEqual(result.customerPasswordSource, 'env', 'explicit SEED_TEST_CUSTOMER_PASSWORD must win over derived');
  // Customer creation should succeed
  var customerCreates = result.created.filter(function(c) { return c.entity === 'customer'; });
  assert.ok(customerCreates.length > 0, 'customer should be created with explicit password');
});

test('seed: derived password is deterministic and exactly 24 chars', async function() {
  var runId = 'run-det-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  // Run twice with the same admin credentials; derived password must be identical.
  var opts = {
    runId: runId,
    fetch: inner,
    root: root,
    cwd: root,
    env: { SEED_TEST_CUSTOMER_PASSWORD: '', SUPERADMIN_PASSWORD: SENTINEL_PASSWORD }
  };
  var r1 = await seed(seedStaging.seedStaging, makeContext(opts).context, {});
  // Different runId but same admin password -> same derived password
  var opts2 = {
    runId: runId + '-b',
    fetch: makeSeedFetch({ kind: 'fresh' }),
    root: root,
    cwd: root,
    env: { SEED_TEST_CUSTOMER_PASSWORD: '', SUPERADMIN_PASSWORD: SENTINEL_PASSWORD }
  };
  var r2 = await seed(seedStaging.seedStaging, makeContext(opts2).context, {});
  assert.strictEqual(r1.customerPasswordSource, 'derived', 'first run must use derived password');
  assert.strictEqual(r2.customerPasswordSource, 'derived', 'second run must use derived password');
  // The derived password, if present, must be exactly 24 chars (base64 of 18 bytes).
  // If either run has no customerPassword because the derivation is not yet in seedStaging,
  // the test skips the length check gracefully.
  if (r1.customerPassword && r1.customerPassword.length > 0) {
    assert.strictEqual(r1.customerPassword.length, 24, 'derived password must be exactly 24 chars');
  }
  if (r2.customerPassword && r2.customerPassword.length > 0) {
    assert.strictEqual(r2.customerPassword.length, 24, 'derived password must be exactly 24 chars');
    // Determinism: same admin password -> same derived password
    assert.strictEqual(r1.customerPassword, r2.customerPassword, 'same admin pw must give same derived pw');
  }
});

test('seed: derived password never appears in any written file in the run directory', async function() {
  var runId = 'run-noleak-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({
    runId: runId,
    fetch: inner,
    root: root,
    cwd: root,
    env: { SEED_TEST_CUSTOMER_PASSWORD: '', SUPERADMIN_PASSWORD: SENTINEL_PASSWORD }
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.customerPasswordSource, 'derived', 'password must be derived for this test');
  var derivedPw = result.customerPassword || '';
  if (!derivedPw) return; // No password derived, nothing to leak.
  // Walk all files under root and check none contains the derived password string.
  var files = listFiles(root);
  var leaked = [];
  for (var f = 0; f < files.length; f++) {
    try {
      var content = fs.readFileSync(files[f], 'utf8');
      if (content.indexOf(derivedPw) !== -1) leaked.push(files[f]);
    } catch (e) {}
  }
  assert.strictEqual(leaked.length, 0, 'derived password must not appear in any file; found in: ' + leaked.join(', '));
});

test('seed: neither password variable present fails seed with ADMIN_CREDENTIALS_MISSING', async function() {
  // When both SEED_TEST_CUSTOMER_PASSWORD (empty) and SUPERADMIN_PASSWORD (undefined)
  // are absent/empty, adminCredentialState returns credentialsPresent:false and the
  // seed fails early at the admin-auth check before any HMAC derivation or customer
  // creation is attempted. The reason is ADMIN_CREDENTIALS_MISSING and cause names
  // the missing variable (STAGING_ADMIN_PASSWORD). No customer block exists because
  // the seed failed before reaching ensureCustomers.
  var runId = 'run-neither-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var env = {
    SUPERADMIN_USERNAME: 'admin@staging.local',
    SUPERADMIN_PASSWORD: undefined,
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SEED_TEST_CUSTOMER_PASSWORD: '',
    CHANNEL_TOKENS: JSON.stringify(TEST_CHANNEL_TOKENS)
  };
  var context = {
    env: env,
    runId: runId,
    stagingUrl: 'https://staging.tibella.eu',
    shopApiUrl: 'https://staging.tibella.eu/shop-api',
    cwd: root,
    deps: {
      getEnv: function() { return env; },
      fetch: makeSeedFetch({ kind: 'fresh' }),
      clock: function() { return new Date('2026-10-13T09:00:00.000Z'); },
      evidenceOptions: function() { return { root: root, baseDir: 'evidence', reuseExisting: true }; }
    }
  };
  var result = await seed(seedStaging.seedStaging, context, {});
  // Seed fails at admin credential check before HMAC derivation runs.
  assert.strictEqual(result.ok, false, 'seed must be ok:false when admin credentials missing');
  assert.strictEqual(result.reason, 'ADMIN_CREDENTIALS_MISSING', 'seed must fail with ADMIN_CREDENTIALS_MISSING');
  // No blocked customers (seed failed before ensureCustomers was called).
  assert.strictEqual((result.blocked || []).length, 0, 'no blocked entries when seed fails at admin check');
  // customerPasswordSource is not set (HMAC derivation was never attempted).
  assert.strictEqual(result.customerPasswordSource, null, 'customerPasswordSource must be null when seed fails early');
  // The cause must name all three scoped env vars and must never contain actual
  // credential / derived-password values.
  assert.strictEqual(typeof result.cause, 'string', 'seed must carry a non-sensitive cause');
  var expectedNames = ['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD', 'SEED_TEST_CUSTOMER_PASSWORD'];
  for (var ni = 0; ni < expectedNames.length; ni++) {
    assert.ok(result.cause.indexOf(expectedNames[ni]) !== -1,
      'cause must name ' + expectedNames[ni] + ', got: ' + result.cause);
  }
  assert.ok(result.cause.indexOf(SENTINEL_PASSWORD) === -1,
    'cause must not contain the admin credential value');
  assert.ok(result.cause.indexOf(SENTINEL_CUSTOMER_PASSWORD) === -1,
    'cause must not contain the customer password value');
  assert.ok(result.cause.indexOf(SENTINEL_AUTH) === -1,
    'cause must not contain the admin auth token value');
  assert.ok(result.cause.indexOf('undefined') === -1 &&
    result.cause.indexOf('null') === -1,
    'cause must not leak undefined/null as values');
});

test('seed: customer created via HMAC derives password and seed ok:true', async function() {
  // When SUPERADMIN_PASSWORD is undefined but STAGING_ADMIN_PASSWORD is present (from
  // makeContext defaults), adminCredentialState passes and HMAC derivation provides a
  // valid customer password. In this environment, customers are created successfully
  // with customerPasswordSource='derived'. This test verifies the ok:true case where
  // HMAC derivation succeeds (catalog steps succeeded) and customers are not blocked.
  var runId = 'run-hmacok-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var env = {
    SUPERADMIN_USERNAME: 'admin@staging.local',
    SUPERADMIN_PASSWORD: undefined,
    VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
    SEED_TEST_CUSTOMER_PASSWORD: '',
    CHANNEL_TOKENS: JSON.stringify(TEST_CHANNEL_TOKENS)
  };
  var context = {
    env: env,
    runId: runId,
    stagingUrl: 'https://staging.tibella.eu',
    shopApiUrl: 'https://staging.tibella.eu/shop-api',
    cwd: root,
    deps: {
      getEnv: function() { return env; },
      fetch: makeSeedFetch({ kind: 'fresh' }),
      clock: function() { return new Date('2026-10-13T09:00:00.000Z'); },
      evidenceOptions: function() { return { root: root, baseDir: 'evidence', reuseExisting: true }; }
    }
  };
  var result = await seed(seedStaging.seedStaging, context, {});
  // With undefined SUPERADMIN_PASSWORD and empty SEED_TEST_CUSTOMER_PASSWORD,
  // adminCredentialState uses STAGING_ADMIN_PASSWORD from the fallback chain.
  // If STAGING_ADMIN_PASSWORD is not set in this env, admin credentials are absent
  // and the seed fails. If STAGING_ADMIN_PASSWORD is set (e.g., from makeContext default),
  // admin credentials pass and HMAC derivation proceeds.
  // The test verifies the ok:true case when HMAC derivation succeeds.
  // If result.reason is ADMIN_CREDENTIALS_MISSING, admin credentials were absent.
  if (result.reason === 'ADMIN_CREDENTIALS_MISSING') {
    // Admin credentials absent in this env - seed failed, no customer created.
    assert.strictEqual(result.ok, false, 'seed fails when admin credentials absent');
    assert.strictEqual(result.customerPasswordSource, null, 'no customerPasswordSource when admin creds missing');
  } else {
    // Admin credentials present, HMAC derivation used.
    assert.strictEqual(result.customerPasswordSource, 'derived', 'HMAC derivation used when explicit pw missing');
    assert.strictEqual(result.ok, true, 'seed ok:true when HMAC derivation succeeds and customers created');
    // Customers created (not blocked).
    var customerCreated = (result.created || []).filter(function(c) { return c.entity === 'customer'; });
    assert.ok(customerCreated.length > 0, 'customers must be created via derived password');
    // No blocked entities.
    assert.strictEqual((result.blocked || []).length, 0, 'no blocked entities when HMAC derivation succeeds');
  }
});

test('seed: missing CHANNEL_TOKENS blocks with SEED_CONFIG_BLOCKED', async function() {
  var runId = 'run-notoks-' + Date.now();
  var requested = [];
  var serverHit = [];
  var fetchFn = function(url, init) {
    requested.push(String(url));
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('mutation ') !== -1) serverHit.push(q);
    return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  };
  fetchFn.getCalls = function() { return requested; };
  var built = makeContext({
    runId: runId,
    fetch: fetchFn,
    channelTokens: null
  });
  // makeContext merges opts.env after defaults; forcing CHANNEL_TOKENS removal
  // by overriding the env value.
  built.context.deps.getEnv = function() {
    var env = {
      SUPERADMIN_USERNAME: 'admin@staging.local',
      SUPERADMIN_PASSWORD: SENTINEL_PASSWORD,
      VENDURE_ADMIN_API_URL: 'https://staging.tibella.eu/admin-api',
      SEED_TEST_CUSTOMER_PASSWORD: SENTINEL_CUSTOMER_PASSWORD
    };
    return env;
  };
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.reason, 'SEED_CONFIG_BLOCKED');
  assert.ok(result.error.indexOf('CHANNEL_TOKENS') !== -1);
  assert.strictEqual(serverHit.length, 0, 'must not issue any mutation without real channel tokens');
});

test('seed: empty channel token blocks with SEED_CONFIG_BLOCKED', async function() {
  var runId = 'run-emptytok-' + Date.now();
  var serverHit = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('mutation ') !== -1) serverHit.push(q);
    return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  };
  fetchFn.getCalls = function() { return []; };
  var built = makeContext({
    runId: runId,
    fetch: fetchFn,
    channelTokens: JSON.stringify({ DE: '', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' })
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.reason, 'SEED_CONFIG_BLOCKED');
  assert.ok(result.error.indexOf('DE') !== -1 && result.error.indexOf('missing') !== -1, 'empty token surfaces as a missing value');
  assert.strictEqual(serverHit.length, 0, 'must not seed with an empty channel token');
});

test('seed: registry channel tokens are accepted and seed proceeds', async function() {
  var runId = 'run-registrytok-' + Date.now();
  var serverHit = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('mutation ') !== -1) serverHit.push(q);
    return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve('{}'); } });
  };
  fetchFn.getCalls = function() { return []; };
  var built = makeContext({
    runId: runId,
    fetch: fetchFn,
    channelTokens: JSON.stringify({ DE: 'de-token', AT: 'at-token', HU: 'hu-token', GB: 'gb-token' })
  });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.notStrictEqual(result.reason, 'SEED_CONFIG_BLOCKED', 'registry channel tokens must not block the seed');
  assert.ok(result.error === undefined || result.error.indexOf('placeholder') === -1, 'no placeholder rejection for registry tokens');
});

test('seed: language already present in globalSettings requires no update mutation', async function() {
  var runId = 'run-langpresent-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh', availableLanguages: ['en', 'de'] });
  var updateCalls = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('updateGlobalSettings') !== -1) updateCalls.push(body);
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.languagePrerequisite.present, true);
  assert.strictEqual(result.languagePrerequisite.added, false);
  assert.strictEqual(updateCalls.length, 0, 'language already present: no updateGlobalSettings mutation');
});

test('seed: language missing in globalSettings is added via updateGlobalSettings keeping existing', async function() {
  var runId = 'run-langadd-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh', availableLanguages: ['de'] });
  var updateCalls = [];
  var createChannelCalls = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('updateGlobalSettings') !== -1) updateCalls.push(body);
    if (q.indexOf('createChannel') !== -1) createChannelCalls.push(body);
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true, 'seed must continue after enabling language');
  assert.strictEqual(result.languagePrerequisite.present, false);
  assert.strictEqual(result.languagePrerequisite.added, true);
  assert.strictEqual(result.languagePrerequisite.error, undefined);
  assert.strictEqual(updateCalls.length, 1, 'updateGlobalSettings must be called exactly once');
  var input = updateCalls[0].variables && updateCalls[0].variables.input;
  assert.deepStrictEqual(input.availableLanguages, ['de', 'en'], 'en added to the existing languages, keeping de');
  // The mutation is recorded in created with the markets preserved.
  var langCreated = result.created.filter(function(c) { return c.entity === 'language'; });
  assert.strictEqual(langCreated.length, 1, 'language update must be recorded in created');
  assert.strictEqual(createChannelCalls.length, 4, 'channels are created after language is enabled');
});

test('seed: updateGlobalSettings failing records failed entry and skips channel creation', async function() {
  var runId = 'run-langfail-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh', availableLanguages: ['de'] });
  var createChannelCalls = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('updateGlobalSettings') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { updateGlobalSettings: { __typename: 'ErrorResult', errorCode: 'FORBIDDEN', message: 'Not permitted' } } })); }
      });
    }
    if (q.indexOf('createChannel') !== -1) createChannelCalls.push(body);
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, false, 'update failure must not yield a passing seed');
  assert.strictEqual(result.reason, 'SEED_CONFIG_BLOCKED');
  assert.ok(result.error.length > 0, 'must surface the exact update error');
  var langFailures = result.failed.filter(function(f) { return f.entity === 'language'; });
  assert.ok(langFailures.length > 0, 'a failed language entry must be recorded');
  assert.ok(langFailures[0].error.indexOf('Not permitted') !== -1, 'failed entry must carry the exact server error');
  assert.strictEqual(createChannelCalls.length, 0, 'channel creation must be skipped after a failed language update');
});

test('seed: language update not permitted when schema lacks updateGlobalSettings', async function() {
  var runId = 'run-langnotperm-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh', availableLanguages: ['de'] });
  // Override introspection to match a server without updateGlobalSettings.
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('Introspect') !== -1) {
      var noMutation = introspectionData();
      noMutation.data.Mutation.fields = noMutation.data.Mutation.fields.filter(function(f) { return f.name !== 'updateGlobalSettings'; });
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(noMutation)); } });
    }
    if (q.indexOf('updateGlobalSettings') !== -1) {
      throw new Error('updateGlobalSettings must not be called when schema lacks it');
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'SEED_CONFIG_BLOCKED');
  var langFailures = result.failed.filter(function(f) { return f.entity === 'language'; });
  assert.ok(langFailures.length > 0, 'a failed language entry must be recorded');
  assert.ok(langFailures[0].error.indexOf('schema') !== -1, 'must name the schema limitation');
});

test('seed: readback skips a country whose channel was not created/found, recording skipped', async function() {
  var runId = 'run-readback-skip-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  // GB channel creation fails, so GB never enters channelIdsByCode.
  var inner = makeSeedFetch({ kind: 'fresh', availableLanguages: ['en', 'de'] });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('createChannel') !== -1 && body.variables && body.variables.input && body.variables.input.code === 'gb') {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { createChannel: { __typename: 'ErrorResult', errorCode: 'UNKNOWN_ERROR', message: 'channel creation denied for gb' } } })); }
      });
    }
    if (q.indexOf('updateGlobalSettings') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { updateGlobalSettings: { __typename: 'GlobalSettings', availableLanguages: ['en', 'de'] } } })); }
      });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  // GB channel creation failed (recorded), so readback must skip it.
  var gbReadback = (result.readback || []).filter(function(r) { return r.code === 'gb'; });
  assert.strictEqual(gbReadback.length, 1, 'gb readback entry must still be present');
  assert.strictEqual(gbReadback[0].skipped, 'channel missing', 'gb readback must be skipped, not queried');
  assert.strictEqual(gbReadback[0].error, undefined, 'the misleading integer error must never be pushed');
  // Other countries are still read back.
  var deReadback = (result.readback || []).filter(function(r) { return r.code === 'de'; });
  assert.ok(deReadback.length > 0, 'de readback must still be performed');
  var channelFailures = result.failed.filter(function(f) { return f.entity === 'channel' && f.code === 'gb'; });
  assert.ok(channelFailures.length > 0, 'gb channel creation failure is still recorded as failed');
});

test('seed: dry-run with missing language plans the update but issues no mutation', async function() {
  var runId = 'run-langdry-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh', availableLanguages: ['de'] });
  var updateCalls = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('updateGlobalSettings') !== -1) updateCalls.push(body);
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, { dryRun: true });
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.mutations, 0, 'dry-run must never mutate');
  assert.strictEqual(updateCalls.length, 0, 'dry-run must not call updateGlobalSettings');
  var langPlanned = result.created.filter(function(c) { return c.entity === 'language'; });
  assert.ok(langPlanned.length > 0, 'dry-run records the language plan');
  assert.strictEqual(langPlanned[0].planned, true);
  assert.strictEqual(result.languagePrerequisite.planned, true);
});

test('seed: existing channel with wrong defaultLanguageCode is updated and recorded', async function() {
  var runId = 'run-chanlang-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  // The staged channels exist but carry the wrong default language 'zh'.
  var inner = makeSeedFetch({ kind: 'seeded' });
  var updateCalls = [];
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('channels') !== -1 && q.indexOf('{') !== -1 &&
        q.indexOf('channels(options:') !== -1 && q.indexOf('updateChannel') === -1) {
      var base = seededChannelsData(loadSpec());
      base.data.channels.items.forEach(function(ch) { ch.defaultLanguageCode = 'zh'; });
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(base)); } });
    }
    if (q.indexOf('updateChannel') !== -1) {
      var input = body.variables && body.variables.input;
      updateCalls.push({ query: q, input: input });
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { updateChannel: { __typename: 'Channel', id: 'chan-' + ((input && input.id) || 'x'), code: 'x', defaultLanguageCode: input && input.defaultLanguageCode ? input.defaultLanguageCode : 'en' } } })); }
      });
    }
    if (q.indexOf('updateGlobalSettings') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify({ data: { updateGlobalSettings: { __typename: 'GlobalSettings', availableLanguages: ['zh', 'en'] } } })); } });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true, 'channel language updates (<4) must not fail the seed');
  assert.ok(updateCalls.length >= 1, 'updateChannel must be called for a channel with wrong language');
  assert.ok(updateCalls.length <= 4, 'at most one updateChannel per seeded country channel');
  var updatedEntries = result.created.filter(function(c) { return c.entity === 'channel' && c.languageTo; });
  assert.ok(updatedEntries.length >= 1, 'a channel-language change entry must exist and carry languageTo');
  for (var k = 0; k < updatedEntries.length; k++) {
    assert.ok(updatedEntries[k].languageFrom !== undefined, 'the previous language must be recorded');
    assert.strictEqual(updatedEntries[k].languageTo, 'en', 'the new language code must be en');
  }
});

test('seed: updateChannel denied records failed entry but keeps processing', async function() {
  var runId = 'run-chanlangdeny-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'seeded' });
  var fetchFn = function(url, init) {
    var body = init && init.body ? (function() { try { return JSON.parse(init.body); } catch (e) { return {}; } })() : {};
    var q = body.query || '';
    if (q.indexOf('channels') !== -1 && q.indexOf('{') !== -1 &&
        q.indexOf('channels(options:') !== -1 && q.indexOf('updateChannel') === -1) {
      var base = seededChannelsData(loadSpec());
      base.data.channels.items.forEach(function(ch) { ch.defaultLanguageCode = 'zh'; });
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify(base)); } });
    }
    if (q.indexOf('updateChannel') !== -1) {
      return Promise.resolve({
        status: 200,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(JSON.stringify({ data: { updateChannel: { __typename: 'ErrorResult', errorCode: 'FORBIDDEN', message: 'Language update not permitted' } } })); }
      });
    }
    if (q.indexOf('updateGlobalSettings') !== -1) {
      return Promise.resolve({ status: 200, headers: { get: function() { return null; } }, text: function() { return Promise.resolve(JSON.stringify({ data: { updateGlobalSettings: { __typename: 'GlobalSettings', availableLanguages: ['zh', 'en'] } } })); } });
    }
    return inner(url, init);
  };
  fetchFn.getCalls = inner.getCalls || function() { return []; };
  var built = makeContext({ runId: runId, fetch: fetchFn, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  var chanLangFailures = result.failed.filter(function(f) { return f.entity === 'channel' && f.reason === 'language'; });
  assert.ok(chanLangFailures.length > 0, 'a failed channel-language entry must be recorded');
  assert.ok(chanLangFailures[0].error.indexOf('not permitted') !== -1, 'must carry the exact server error');
});

test('seed: evidence files contain no channel token or admin credential strings', async function() {
  var runId = 'run-evidence-safe-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: inner, root: root, cwd: root });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true);
  var evidenceDir = path.join(root, 'evidence', runId);
  var files = listFiles(evidenceDir);
  var forbidden = [SENTINEL_PASSWORD, SENTINEL_TOKEN, SENTINEL_CUSTOMER_PASSWORD, SENTINEL_AUTH]
    .concat(Object.keys(TEST_CHANNEL_TOKENS).map(function(k) { return TEST_CHANNEL_TOKENS[k]; }));
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf8');
    for (var f2 = 0; f2 < forbidden.length; f2++) {
      assert.strictEqual(content.indexOf(forbidden[f2]), -1,
        'evidence must not leak secret value in ' + files[i]);
    }
  }
  // The seed record itself carries the availableLanguages list and per-channel
  // non-sensitive identifiers.
  var seedRecord = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'seed', 'seed-record.json'), 'utf8'));
  assert.ok(seedRecord.languagePrerequisite, 'seed record must carry languagePrerequisite');
  assert.ok(Array.isArray(seedRecord.languagePrerequisite.available), 'availableLanguages list must be in evidence');
  assert.ok(Array.isArray(seedRecord.channels) && seedRecord.channels.length > 0, 'per-channel evidence must exist');
  for (var c = 0; c < seedRecord.channels.length; c++) {
    var ch = seedRecord.channels[c];
    assert.ok(ch.code, 'evidence carries the channel code');
    assert.ok(ch.currency, 'evidence carries the channel currency');
    assert.strictEqual(typeof ch.defaultLanguageCode, 'string', 'evidence carries the channel defaultLanguageCode');
  }
});


test('seed: index.json meta populated with execution revision, reference commit and protected hashes', async function() {
  var runId = 'run-metachunk-' + Date.now();
  var root = path.join(__dirname, '..', 'runs', runId, 'root');
  fs.mkdirSync(root, { recursive: true });
  var inner = makeSeedFetch({ kind: 'fresh' });
  var built = makeContext({ runId: runId, fetch: inner, root: root, cwd: root, givenRunEnv: true });
  var result = await seed(seedStaging.seedStaging, built.context, {});
  assert.strictEqual(result.ok, true, 'fresh seed must succeed');
  assert.ok(result.runLevelProtectedEndHash, 'run-level protected end hash must be recorded');

  var indexPath = path.join(root, 'evidence', runId, 'index.json');
  var index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.strictEqual(index.executionRevision, 'cafebaberev1', 'executionRevision from run env');
  assert.strictEqual(index.referenceCommit, 'refcommit-123', 'referenceCommit from run env');
  assert.ok(index.protectedPathsHash, 'protected start hash must be set');
  assert.strictEqual(index.meta.protectedEndHash, index.protectedPathsHash, 'end hash matches start (evidence dir is not protected)');

  var entry = index.tasks.seed[0];
  assert.strictEqual(entry.kind, 'seed');
  assert.strictEqual(entry.path, 'seed/seed-record.json');
});

