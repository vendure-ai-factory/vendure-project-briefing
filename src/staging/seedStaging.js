'use strict';

/**
 * Idempotent staging seeder for the staging readiness run (CAN-B1-03 / CAN-B1-04 /
 * CAN-B2-16). Seeds channels, zones, tax, minimal catalog and per-country test
 * customers in the isolated staging environment via the Admin API. Reads first,
 * never deletes, never updates. Never throws; returns a structured record.
 */

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var REDACTED_MARKER = '[REDACTED]';

var SEED_HOST_NOT_ALLOWED = 'SEED_HOST_NOT_ALLOWED';
var SEED_CONFLICT = 'SEED_CONFLICT';
var ADMIN_CREDENTIALS_MISSING = 'ADMIN_CREDENTIALS_MISSING';

var ALLOWED_HOSTS = ['staging.tibella.eu'];
var MAX_REQUESTS = 80;
var SEED_EVIDENCE_FILENAME = 'seed-record.json';
var SEED_EVIDENCE_KIND = 'seed';

// ---------------------------------------------------------------------------
// Redaction helpers (mirror adminChannelInventory)
// ---------------------------------------------------------------------------

function redactValue(value, secrets) {
  if (typeof value !== 'string' || !secrets || secrets.length === 0) {
    return value;
  }
  var out = value;
  for (var i = 0; i < secrets.length; i++) {
    out = out.split(secrets[i]).join(REDACTED_MARKER);
  }
  return out;
}

function redactDeep(value, secrets) {
  if (Array.isArray(value)) {
    return value.map(function(item) { return redactDeep(item, secrets); });
  }
  if (value !== null && typeof value === 'object') {
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = redactDeep(value[keys[i]], secrets);
    }
    return out;
  }
  return redactValue(value, secrets);
}

function uniqueSecrets(values) {
  var seen = {};
  var out = [];
  if (!Array.isArray(values)) return out;
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (typeof v !== 'string' || v.length === 0) continue;
    if (!seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Env access (context deps pattern; graceful fallback)
// ---------------------------------------------------------------------------

function getEnvFn(context) {
  var getEnv = context && context.deps && context.deps.getEnv;
  if (typeof getEnv === 'function') return getEnv;
  return function() { return {}; };
}

function getFetch(context) {
  var fetchFn = context && context.deps && context.deps.fetch;
  if (!fetchFn) fetchFn = global.fetch;
  return typeof fetchFn === 'function' ? fetchFn : null;
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function envValue(context, name) {
  var env = getEnvFn(context)();
  return env && typeof env === 'object' ? env[name] : undefined;
}

function getSeedSpec(context, options) {
  var specPath = options && options.specPath;
  if (!specPath) {
    specPath = path.join(__dirname, '..', '..', 'pipeline', 'seed', 'staging-seed.v1.json');
  }
  try {
    var raw = fs.readFileSync(specPath, 'utf8');
    return { spec: JSON.parse(raw), error: null };
  } catch (e) {
    return { spec: null, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Admin API / GraphQL documents
// ---------------------------------------------------------------------------

var LOGIN_MUTATION = [
  'mutation Login($username: String!, $password: String!) {',
  '  login(username: $username, password: $password) {',
  '    __typename',
  '    ... on CurrentUser { id identifier }',
  '    ... on ErrorResult { errorCode message }',
  '  }',
  '}'
].join('\n');

function introspectionDoc(typeNames) {
  var parts = ['query Introspect {'];
  for (var i = 0; i < typeNames.length; i++) {
    var t = typeNames[i];
    parts.push('  ' + t + ': __type(name: "' + t + '") { name fields { name type { name kind ofType { name kind } } } }');
  }
  parts.push('}');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Low-level request helper (bearer or cookie sessions)
// ---------------------------------------------------------------------------

function adminGraphqlRequest(fetchFn, url, body, token, extraSecrets) {
  if (!fetchFn) {
    return Promise.resolve({
      request: null,
      response: null,
      networkError: 'no fetch implementation available',
      authToken: null,
      secrets: []
    });
  }
  var headers = { 'content-type': 'application/json' };
  var secrets = (extraSecrets && Array.isArray(extraSecrets)) ? extraSecrets.slice() : [];
  if (token) {
    headers['vendure-auth-token'] = token;
    headers['Authorization'] = 'Bearer ' + token;
    secrets.push(token);
  }
  var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  var requestRecord = { method: 'POST', url: url, headers: headers, body: bodyStr };
  return fetchFn(url, {
    method: 'POST',
    headers: headers,
    body: bodyStr
  }).then(function(response) {
    var authToken = null;
    if (response.headers && typeof response.headers.get === 'function') {
      authToken = response.headers.get('vendure-auth-token');
    } else if (response.headers && typeof response.headers === 'object') {
      authToken = response.headers['vendure-auth-token'] || null;
    }
    return response.text().then(function(text) {
      var parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
      }
      return {
        request: requestRecord,
        response: { httpStatus: response.status, ok: response.status >= 200 && response.status < 300, body: parsed, text: text },
        networkError: null,
        authToken: authToken || null,
        secrets: secrets
      };
    }, function(err) {
      return {
        request: requestRecord,
        response: { httpStatus: response.status, ok: false, body: null, text: null },
        networkError: err && err.message ? err.message : String(err),
        authToken: null,
        secrets: secrets
      };
    });
  }).catch(function(err) {
    return {
      request: requestRecord,
      response: { httpStatus: null, ok: false, body: null, text: null },
      networkError: err && err.message ? err.message : String(err),
      authToken: null,
      secrets: secrets
    };
  });
}

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

/**
 * Introspect a set of type names. Returns a map: typeName -> { fields: [name], inputFields: [name], present: boolean }
 */
async function introspectTypes(fetchFn, adminUrl, token, typeNames) {
  var result = {
    types: {},
    call: null
  };
  for (var i = 0; i < typeNames.length; i++) {
    result.types[typeNames[i]] = { present: false, fields: [], inputFields: [] };
  }
  try {
    var call = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: introspectionDoc(typeNames),
      variables: {}
    }, token);
    result.call = call;
    if (call.response && call.response.ok && call.response.body && !call.response.body.errors) {
      var data = call.response.body.data || {};
      for (var j = 0; j < typeNames.length; j++) {
        var tn = typeNames[j];
        var tdata = data[tn];
        if (tdata && tdata.name) {
          result.types[tn].present = true;
          var fields = tdata.fields || [];
          for (var k = 0; k < fields.length; k++) {
            var f = fields[k];
            if (f && f.name) {
              var isArg = (f.type && f.type.kind === 'INPUT_OBJECT') || f.name.indexOf('Input') !== -1;
              if (f.name.indexOf('Input') !== -1) {
                result.types[tn].inputFields.push(f.name);
              } else {
                result.types[tn].fields.push(f.name);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // keep partial/empty result
  }
  return result;
}

function hasMutation(introspection, mutationName) {
  var t = introspection.types && introspection.types['Mutation'];
  return !!(t && t.present && t.fields.indexOf(mutationName) !== -1);
}

// ---------------------------------------------------------------------------
// Seed state record
// ---------------------------------------------------------------------------

function createState() {
  return {
    startedAt: null,
    completedAt: null,
    version: null,
    specSha256: null,
    hostAllowed: false,
    host: null,
    mode: 'full',
    mutations: 0,
    created: [],
    existing: [],
    conflicts: [],
    failed: [],
    blocked: [],
    channels: [],
    readback: null,
    preRead: null,
    errors: [],
    requestBudget: MAX_REQUESTS,
    requests: 0
  };
}

function recordMutation(state, kind, entity, details) {
  if (!state.dryRun && (kind === 'created' || kind === 'failed')) state.mutations += 1;
  var entry = { entity: entity };
  if (details && details.id) entry.id = details.id;
  if (details && details.code) entry.code = details.code;
  if (details) {
    for (var k in details) {
      if (k !== 'entity' && k !== 'id' && k !== 'code') {
        entry[k] = details[k];
      }
    }
  }
  if (kind === 'created') {
    state.created.push(entry);
  } else if (kind === 'existing') {
    state.existing.push(entry);
  } else if (kind === 'conflict') {
    state.conflicts.push(entry);
  } else {
    state.failed.push(entry);
  }
  return entry;
}

function bumpRequests(state, n) {
  state.requests += (n || 1);
  return state.requests;
}

function requestBudgetExceeded(state) {
  return state.requests >= MAX_REQUESTS;
}

// ---------------------------------------------------------------------------
// Evidence writing
// ---------------------------------------------------------------------------

function resolveEvidenceOptions(context) {
  var opts = {};
  var baseDir = (context && context.evidenceBaseDir) ? context.evidenceBaseDir : 'evidence';
  var root = (context && context.cwd) ? context.cwd : process.cwd();
  opts.root = root;
  opts.baseDir = baseDir;
  if (context && context.deps && context.deps.evidenceOptions) {
    var io = context.deps.evidenceOptions();
    if (io) Object.assign(opts, io);
  }
  return opts;
}

function runIdOf(context) {
  if (context && context.runId) return context.runId;
  if (context && context.runEnvRecord && context.runEnvRecord.runId) return context.runEnvRecord.runId;
  var env = getEnvFn(context)();
  if (env && env.PIPELINE_RUN_ID) return env.PIPELINE_RUN_ID;
  var opts = (context && context.options) || {};
  return opts.runId || null;
}

// ---------------------------------------------------------------------------
// Resolve admin URL + credentials (reuse adminChannelInventory)
// ---------------------------------------------------------------------------

function adminChannelInventoryModule() {
  try {
    return require('../executors/adminChannelInventory');
  } catch (e) {
    return null;
  }
}

function resolveAdminApiBase(context) {
  var module = adminChannelInventoryModule();
  if (module && typeof module.resolveAdminApiBase === 'function') {
    return module.resolveAdminApiBase(context);
  }
  var direct = envValue(context, 'VENDURE_ADMIN_API_URL');
  if (typeof direct === 'string' && direct.length > 0) {
    return direct.replace(/\/+$/, '');
  }
  var stagingBase = (context && context.runEnvRecord && context.runEnvRecord.stagingUrl) ||
    (context && context.stagingUrl) || (context && context.stagingUrlPlaceholder);
  if (typeof stagingBase === 'string' && stagingBase.length > 0) {
    return stagingBase.replace(/\/+$/, '') + '/admin-api';
  }
  return 'https://staging.tibella.eu/admin-api';
}

function adminCredentialState(context) {
  var module = adminChannelInventoryModule();
  if (module && typeof module.adminCredentialNames === 'function') {
    var cred = module.adminCredentialNames(context);
    return { present: cred.present || [], absent: cred.absent || [], credentialsPresent: !!cred.credentialsPresent };
  }
  var env = getEnvFn(context)();
  var username = String(env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '')  ;
  var password = String(env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '');
  return {
    present: [],
    absent: [],
    credentialsPresent: !!(username && password)
  };
}

function adminUsername(context) {
  var env = getEnvFn(context)();
  return String(env.SUPERADMIN_USERNAME || env.STAGING_ADMIN_EMAIL || '').trim();
}

function adminPassword(context) {
  var env = getEnvFn(context)();
  return String(env.SUPERADMIN_PASSWORD || env.STAGING_ADMIN_PASSWORD || '').trim();
}

// ---------------------------------------------------------------------------
// Host guard
// ---------------------------------------------------------------------------

function hostOf(url) {
  if (typeof url !== 'string') return null;
  var withoutProtocol = url.split('://').pop();
  var host = withoutProtocol.split('/')[0];
  if (host.indexOf(':') !== -1) {
    host = host.split(':')[0];
  }
  return host.toLowerCase();
}

function hostAllowed(adminUrl) {
  var h = hostOf(adminUrl);
  if (!h) return false;
  return ALLOWED_HOSTS.indexOf(h) !== -1;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function loginToAdmin(context, fetchFn, adminUrl, username, password, secrets) {
  try {
    var result = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: LOGIN_MUTATION,
      variables: { username: username, password: password }
    }, null, secrets);
    if (!result.response || result.response.httpStatus === null) {
      return { ok: false, reason: 'ADMIN_LOGIN_FAILED', error: 'network error during login: ' + (result.networkError || 'unknown'), callCount: 1 };
    }
    if (result.response.httpStatus >= 500) {
      return { ok: false, reason: 'ADMIN_LOGIN_FAILED', error: 'admin API returned HTTP ' + result.response.httpStatus + ' during login', callCount: 1 };
    }
    var loginBody = result.response.body;
    var loginData = loginBody && loginBody.data && loginBody.data.login;
    if (!loginData || loginData.__typename !== 'CurrentUser') {
      var errMsg = 'authentication failed';
      if (loginData && loginData.__typename === 'ErrorResult') {
        errMsg = 'authentication failed: ' + (loginData.message || loginData.errorCode || 'InvalidCredentialsError');
      }
      return { ok: false, reason: 'ADMIN_LOGIN_FAILED', error: errMsg, callCount: 1 };
    }
    return { ok: true, authToken: result.authToken || null, result: result, callCount: 1 };
  } catch (e) {
    return { ok: false, reason: 'ADMIN_LOGIN_FAILED', error: 'login threw: ' + (e && e.message ? e.message : String(e)), callCount: 1 };
  }
}

// ---------------------------------------------------------------------------
// Pre-read probe (no mutations)
// ---------------------------------------------------------------------------

async function preReadAdmin(context, fetchFn, adminUrl, authToken, secrets) {
  var query = [
    '{',
    '  activeChannel { code defaultCurrencyCode defaultLanguageCode',
    '    defaultTaxZone { id name } defaultShippingZone { id name }',
    '  }',
    '  countries { totalItems }',
    '  zones { totalItems }',
    '  taxCategories { totalItems }',
    '  taxRates { totalItems }',
    '  stockLocations { totalItems }',
    '  shippingMethods { totalItems }',
    '  paymentMethods { totalItems }',
    '}'
  ].join('\n');
  try {
    var result = await adminGraphqlRequest(fetchFn, adminUrl, { query: query, variables: {} }, authToken, secrets);
    if (result.response && result.response.ok && result.response.body) {
      var body = result.response.body;
      var data = body.data || {};
      var out = {
        activeChannel: {
          code: data.activeChannel ? data.activeChannel.code : null,
          currency: data.activeChannel ? (data.activeChannel.defaultCurrencyCode || data.activeChannel.currencyCode) : null,
          language: data.activeChannel ? data.activeChannel.defaultLanguageCode : null,
          defaultTaxZone: (data.activeChannel && data.activeChannel.defaultTaxZone) || null,
          defaultShippingZone: (data.activeChannel && data.activeChannel.defaultShippingZone) || null
        },
        counts: {
          countries: data.countries ? data.countries.totalItems : null,
          zones: data.zones ? data.zones.totalItems : null,
          taxCategories: data.taxCategories ? data.taxCategories.totalItems : null,
          taxRates: data.taxRates ? data.taxRates.totalItems : null,
          stockLocations: data.stockLocations ? data.stockLocations.totalItems : null,
          shippingMethods: data.shippingMethods ? data.shippingMethods.totalItems : null,
          paymentMethods: data.paymentMethods ? data.paymentMethods.totalItems : null
        },
        errors: body.errors || null
      };
      return { ok: true, data: out, rawCall: result };
    }
    return { ok: false, data: null, rawCall: result };
  } catch (e) {
    return { ok: false, data: null, rawCall: null, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Ensure helpers (read first, create if missing)
// ---------------------------------------------------------------------------

async function ensureCountries(context, state, fetchFn, adminUrl, authToken, secrets) {
  var countries = [
    { code: 'DE', name: 'Germany' },
    { code: 'AT', name: 'Austria' },
    { code: 'HU', name: 'Hungary' },
    { code: 'GB', name: 'United Kingdom' }
  ];
  var query = '{ countries { items { id code enabled } totalItems } }';
  var existing = {};
  try {
    var r = await adminGraphqlRequest(fetchFn, adminUrl, { query: query, variables: {} }, authToken, secrets);
    bumpRequests(state);
    if (r.response && r.response.ok && r.response.body && r.response.body.data &&
        r.response.body.data.countries && r.response.body.data.countries.items) {
      var items = r.response.body.data.countries.items;
      for (var i = 0; i < items.length; i++) {
        existing[String(items[i].code).toUpperCase()] = items[i];
      }
    }
  } catch (e) {
    state.errors.push('countries read failed: ' + ((e && e.message) || String(e)));
    return;
  }
  var create = [];
  for (var c = 0; c < countries.length; c++) {
    var code = countries[c].code;
    if (existing[code]) {
      recordMutation(state, 'existing', 'country', { code: code, id: existing[code].id });
    } else {
      create.push(countries[c]);
    }
  }
  if (state.dryRun) {
    for (var d = 0; d < create.length; d++) {
      recordMutation(state, 'created', 'country', { code: create[d].code, planned: true });
    }
    return;
  }
  for (var e2 = 0; e2 < create.length; e2++) {
    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return;
    }
    var country = create[e2];
    var mutation = [
      'mutation CreateCountry($input: CreateCountryInput!) {',
      '  createCountry(input: $input) {',
      '    ... on Country { id code enabled }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var input = {
      code: country.code,
      enabled: true,
      translations: [
        { languageCode: 'en', name: country.name }
      ]
    };
    var res;
    try {
      res = await adminGraphqlRequest(fetchFn, adminUrl, {
        query: mutation,
        variables: { input: input }
      }, authToken, secrets);
      bumpRequests(state);
    } catch (err) {
      recordMutation(state, 'failed', 'country', { code: country.code, error: (err && err.message) || String(err) });
      continue;
    }
    var respBody = res.response && res.response.body;
    var data = respBody && respBody.data && respBody.data.createCountry;
    if (data && data.__typename === 'Country') {
      recordMutation(state, 'created', 'country', { code: country.code, id: data.id });
    } else {
      var msg = (data && (data.message || data.errorCode)) || 'createCountry failed';
      recordMutation(state, 'failed', 'country', { code: country.code, error: msg });
    }
  }
}

async function ensureZones(context, state, fetchFn, adminUrl, authToken, secrets, spec) {
  var query = '{ zones { items { id name } totalItems } }';
  var existingByName = {};
  try {
    var r = await adminGraphqlRequest(fetchFn, adminUrl, { query: query, variables: {} }, authToken, secrets);
    bumpRequests(state);
    if (r.response && r.response.ok && r.response.body && r.response.body.data &&
        r.response.body.data.zones && r.response.body.data.zones.items) {
      var items = r.response.body.data.zones.items;
      for (var i = 0; i < items.length; i++) {
        existingByName[String(items[i].name)] = items[i];
      }
    }
  } catch (e) {
    state.errors.push('zones read failed: ' + ((e && e.message) || String(e)));
    return {};
  }
  var zoneIds = {};
  for (var z = 0; z < spec.zones.length; z++) {
    var zone = spec.zones[z];
    var name = zone.name;
    if (existingByName[name]) {
      zoneIds[name] = existingByName[name].id;
      recordMutation(state, 'existing', 'zone', { name: name, id: existingByName[name].id });
      continue;
    }
    if (state.dryRun) {
      zoneIds[name] = null;
      recordMutation(state, 'created', 'zone', { name: name, planned: true });
      continue;
    }
    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return zoneIds;
    }
    var members = [];
    for (var m = 0; m < zone.members.length; m++) {
      var memberCode = zone.members[m];
      var memberId = state.countryIds ? state.countryIds[memberCode] : null;
      members.push(memberId);
    }
    var mutation = [
      'mutation CreateZone($input: CreateZoneInput!) {',
      '  createZone(input: $input) {',
      '    ... on Zone { id name }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var res = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: mutation,
      variables: { input: { name: name, memberIds: members } }
    }, authToken, secrets);
    bumpRequests(state);
    var data = res.response && res.response.body && res.response.body.data && res.response.body.data.createZone;
    if (data && data.__typename === 'Zone') {
      zoneIds[name] = data.id;
      recordMutation(state, 'created', 'zone', { name: name, id: data.id });
    } else {
      var msg = (data && (data.message || data.errorCode)) || 'createZone failed';
      recordMutation(state, 'failed', 'zone', { name: name, error: msg });
    }
  }
  return zoneIds;
}

async function ensureTax(context, state, fetchFn, adminUrl, authToken, secrets, spec, zoneIds) {
  var taxCategoryId = state.taxCategoryId || null;
  var taxCategoryQuery = '{ taxCategories { items { id name isDefault } totalItems } }';
  if (!taxCategoryId) {
    try {
      var r = await adminGraphqlRequest(fetchFn, adminUrl, { query: taxCategoryQuery, variables: {} }, authToken, secrets);
      bumpRequests(state);
      if (r.response && r.response.ok && r.response.body && r.response.body.data &&
          r.response.body.data.taxCategories && r.response.body.data.taxCategories.items) {
        var items = r.response.body.data.taxCategories.items;
        for (var i = 0; i < items.length; i++) {
          if (String(items[i].name).toLowerCase() === 'standard') {
            taxCategoryId = items[i].id;
            state.taxCategoryId = taxCategoryId;
            recordMutation(state, 'existing', 'taxCategory', { name: 'standard', id: taxCategoryId, isDefault: items[i].isDefault });
            break;
          }
        }
        if (!taxCategoryId && items.length > 0 && items[0].isDefault) {
          taxCategoryId = items[0].id;
          state.taxCategoryId = taxCategoryId;
          recordMutation(state, 'existing', 'taxCategory', { name: items[0].name, id: taxCategoryId, isDefault: true });
        }
      }
    } catch (e) {
      state.errors.push('tax category read failed: ' + ((e && e.message) || String(e)));
    }
  }
  if (!taxCategoryId) {
    if (state.dryRun) {
      state.taxCategoryId = 'planned';
      recordMutation(state, 'created', 'taxCategory', { name: 'standard', planned: true });
    } else {
      if (requestBudgetExceeded(state)) {
        state.errors.push('request budget exhausted');
      } else {
        var createCat = [
          'mutation CreateTaxCategory($input: CreateTaxCategoryInput!) {',
          '  createTaxCategory(input: $input) { id name isDefault }',
          '}'
        ].join('\n');
        var cr = await adminGraphqlRequest(fetchFn, adminUrl, {
          query: createCat,
          variables: { input: { name: 'standard' } }
        }, authToken, secrets);
        bumpRequests(state);
        var cd = cr.response && cr.response.body && cr.response.body.data && cr.response.body.data.createTaxCategory;
        if (cd && cd.id) {
          taxCategoryId = cd.id;
          state.taxCategoryId = taxCategoryId;
          recordMutation(state, 'created', 'taxCategory', { name: 'standard', id: taxCategoryId });
        } else {
          state.errors.push('createTaxCategory failed');
          recordMutation(state, 'failed', 'taxCategory', { name: 'standard' });
          return;
        }
      }
    }
  }
  if (!taxCategoryId) return;

  var ratesByName = {};
  var ratesQuery = '{ taxRates { items { id name enabled } totalItems } }';
  try {
    var rr = await adminGraphqlRequest(fetchFn, adminUrl, { query: ratesQuery, variables: {} }, authToken, secrets);
    bumpRequests(state);
    if (rr.response && rr.response.ok && rr.response.body && rr.response.body.data &&
        rr.response.body.data.taxRates && rr.response.body.data.taxRates.items) {
      var rItems = rr.response.body.data.taxRates.items;
      for (var j = 0; j < rItems.length; j++) {
        ratesByName[String(rItems[j].name)] = rItems[j];
      }
    }
  } catch (e) {
    state.errors.push('tax rates read failed: ' + ((e && e.message) || String(e)));
  }

  for (var k = 0; k < spec.countries.length; k++) {
    var country = spec.countries[k];
    var rateName = 'TST ' + country.taxRate + '% ' + country.countryCode;
    if (ratesByName[rateName]) {
      recordMutation(state, 'existing', 'taxRate', { name: rateName, id: ratesByName[rateName].id });
      continue;
    }
    if (state.dryRun) {
      recordMutation(state, 'created', 'taxRate', { name: rateName, planned: true });
      continue;
    }
    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return;
    }
    var zoneId = zoneIds[country.zoneName];
    if (!zoneId) {
      recordMutation(state, 'blocked', 'taxRate', { name: rateName, error: 'zone missing: ' + country.zoneName });
      continue;
    }
    var createRate = [
      'mutation CreateTaxRate($input: CreateTaxRateInput!) {',
      '  createTaxRate(input: $input) {',
      '    ... on TaxRate { id name }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var rateInput = {
      name: rateName,
      enabled: true,
      value: country.taxRate,
      categoryId: taxCategoryId,
      zoneId: zoneId
    };
    var resRate = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: createRate,
      variables: { input: rateInput }
    }, authToken, secrets);
    bumpRequests(state);
    var rd = resRate.response && resRate.response.body && resRate.response.body.data && resRate.response.body.data.createTaxRate;
    if (rd && rd.__typename === 'TaxRate') {
      recordMutation(state, 'created', 'taxRate', { name: rateName, id: rd.id, value: country.taxRate, zone: country.zoneName });
    } else {
      var rmsg = (rd && (rd.message || rd.errorCode)) || 'createTaxRate failed';
      recordMutation(state, 'failed', 'taxRate', { name: rateName, error: rmsg });
    }
  }
}

async function ensureChannels(context, state, fetchFn, adminUrl, authToken, secrets, spec, introspection, zoneIds) {
  var query = '{ channels { items { id code token defaultCurrencyCode availableCurrencyCodes defaultTaxZoneId defaultShippingZoneId pricesIncludeTax } totalItems } }';
  // currency field name from introspection
  var currencyField = 'defaultCurrencyCode';
  if (introspection && introspection.types && introspection.types.Channel &&
      introspection.types.Channel.fields.indexOf('defaultCurrencyCode') === -1 &&
      introspection.types.Channel.fields.indexOf('currencyCode') !== -1) {
    currencyField = 'currencyCode';
  }
  var currencySelector = '{ ' + currencyField + ' }';
  query = query.replace('defaultCurrencyCode', currencyField);
  var channelsList = [];
  try {
    var r = await adminGraphqlRequest(fetchFn, adminUrl, { query: query, variables: { options: { take: 100 } } }, authToken, secrets);
    bumpRequests(state);
    if (r.response && r.response.ok && r.response.body && r.response.body.data &&
        r.response.body.data.channels && r.response.body.data.channels.items) {
      channelsList = r.response.body.data.channels.items;
    }
  } catch (e) {
    state.errors.push('channels read failed: ' + ((e && e.message) || String(e)));
  }

  // Build lookups by code and by token.
  var byCode = {};
  var byToken = {};
  for (var i = 0; i < channelsList.length; i++) {
    var ch = channelsList[i];
    if (ch.code) byCode[String(ch.code).toLowerCase()] = ch;
    if (ch.token) byToken[String(ch.token).toLowerCase()] = ch;
  }

  var channelIds = {};
  for (var c = 0; c < spec.countries.length; c++) {
    var country = spec.countries[c];
    var code = country.channelCode;
    var token = country.channelToken;
    var expectedCurrency = country.currencyCode;

    var byCodeHit = byCode[code.toLowerCase()];
    var byTokenHit = byToken[token.toLowerCase()];

    // Conflict detection (fail closed, no mutation): a channel that has this
    // token but a different currency, or this code but a different token.
    if (byCodeHit && (!byTokenHit || byCodeHit.id !== (byTokenHit ? byTokenHit.id : null))) {
      recordMutation(state, 'conflict', 'channel', { code: code, reason: 'code exists with different token/currency', currency: byCodeHit[currencyField] });
      continue;
    }
    if (byTokenHit && byTokenHit[currencyField] !== expectedCurrency) {
      recordMutation(state, 'conflict', 'channel', { code: code, reason: 'token exists with different currency' });
      continue;
    }
    if (byTokenHit && byTokenHit.code !== code) {
      recordMutation(state, 'conflict', 'channel', { code: code, reason: 'token exists with different code' });
      continue;
    }

    if (byCodeHit && byTokenHit) {
      channelIds[code] = byCodeHit.id;
      recordMutation(state, 'existing', 'channel', { code: code, id: byCodeHit.id, currency: byCodeHit[currencyField], tokenMatches: true });
      continue;
    }
    if (byCodeHit) {
      channelIds[code] = byCodeHit.id;
      recordMutation(state, 'existing', 'channel', { code: code, id: byCodeHit.id, currency: byCodeHit[currencyField] });
      continue;
    }
    if (byTokenHit) {
      channelIds[code] = byTokenHit.id;
      recordMutation(state, 'existing', 'channel', { code: code, id: byTokenHit.id, currency: byTokenHit[currencyField] });
      continue;
    }

    // Neither code nor token exists -> create.
    if (state.dryRun) {
      channelIds[code] = null;
      recordMutation(state, 'created', 'channel', { code: code, planned: true });
      continue;
    }
    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return channelIds;
    }
    var zoneId = zoneIds[country.zoneName] || null;
    var createChannel = [
      'mutation CreateChannel($input: CreateChannelInput!) {',
      '  createChannel(input: $input) {',
      '    ... on Channel { id code token defaultCurrencyCode }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var chanInput = {
      code: code,
      token: token,
      defaultLanguageCode: country.defaultLanguageCode,
      pricesIncludeTax: country.pricesIncludeTax
    };
    chanInput[currencyField] = expectedCurrency;
    var ac = ['availableCurrencyCodes'];
    if (introspection && introspection.types && introspection.types.CreateChannelInput &&
        introspection.types.CreateChannelInput.fields.indexOf('availableCurrencyCodes') !== -1) {
      chanInput.availableCurrencyCodes = [expectedCurrency];
    }
    if (zoneId) {
      chanInput.defaultTaxZoneId = zoneId;
      chanInput.defaultShippingZoneId = zoneId;
    }
    var resChan = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: createChannel,
      variables: { input: chanInput }
    }, authToken, secrets);
    bumpRequests(state);
    var data = resChan.response && resChan.response.body && resChan.response.body.data && resChan.response.body.data.createChannel;
    if (data && data.__typename === 'Channel') {
      channelIds[code] = data.id;
      recordMutation(state, 'created', 'channel', { code: code, id: data.id, currency: expectedCurrency });
      state.channels.push({ code: code, currency: expectedCurrency, token: token });
    } else {
      var cmsg = (data && (data.message || data.errorCode)) || 'createChannel failed';
      recordMutation(state, 'failed', 'channel', { code: code, error: cmsg });
    }
  }
  return channelIds;
}

async function ensureStockLocations(context, state, fetchFn, adminUrl, authToken, secrets, spec, channelIds) {
  var query = '{ stockLocations { items { id name type } totalItems } }';
  var existingByName = {};
  try {
    var r = await adminGraphqlRequest(fetchFn, adminUrl, { query: query, variables: {} }, authToken, secrets);
    bumpRequests(state);
    if (r.response && r.response.ok && r.response.body && r.response.body.data &&
        r.response.body.data.stockLocations && r.response.body.data.stockLocations.items) {
      var items = r.response.body.data.stockLocations.items;
      for (var i = 0; i < items.length; i++) {
        existingByName[String(items[i].name)] = items[i];
      }
    }
  } catch (e) {
    state.errors.push('stock locations read failed: ' + ((e && e.message) || String(e)));
    return {};
  }
  var locIds = {};
  for (var l = 0; l < spec.stockLocations.length; l++) {
    var loc = spec.stockLocations[l];
    var name = loc.name;
    if (existingByName[name]) {
      locIds[name] = existingByName[name].id;
      recordMutation(state, 'existing', 'stockLocation', { name: name, id: existingByName[name].id });
      continue;
    }
    if (state.dryRun) {
      locIds[name] = null;
      recordMutation(state, 'created', 'stockLocation', { name: name, planned: true });
      continue;
    }
    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return locIds;
    }
    var mutation = [
      'mutation CreateStockLocation($input: CreateStockLocationInput!) {',
      '  createStockLocation(input: $input) {',
      '    ... on StockLocation { id name }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var stockInput = { name: name, description: 'TST synthetic stock location' };
    var res = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: mutation,
      variables: { input: stockInput }
    }, authToken, secrets);
    bumpRequests(state);
    var data = res.response && res.response.body && res.response.body.data && res.response.body.data.createStockLocation;
    if (data && data.__typename === 'StockLocation') {
      locIds[name] = data.id;
      recordMutation(state, 'created', 'stockLocation', { name: name, id: data.id });
    } else {
      var msg = (data && (data.message || data.errorCode)) || 'createStockLocation failed';
      recordMutation(state, 'failed', 'stockLocation', { name: name, error: msg });
    }
  }
  return locIds;
}

function priceToMinorUnits(decimal, currencyCode) {
  // All currencies in the spec (EUR, HUF, GBP) use 2 decimal places in
  // Vendure; HUF included. Convert decimal to integer minor units.
  var n = Number(decimal);
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

function channelTokenByCode(spec, code) {
  for (var i = 0; i < spec.countries.length; i++) {
    if (spec.countries[i].channelCode === code) return spec.countries[i].channelToken;
  }
  return null;
}

/**
 * Create the TST- catalog. Products are looked up by slug; variants by SKU.
 * Price each product in its primary channel context (vendure-token header),
 * then assign to the additional channels and price in each channel's context.
 * Never updates an existing product or variant (record existing and skip).
 */
async function ensureProducts(context, state, fetchFn, adminUrl, authToken, secrets, spec, channelTokenById) {
  var currencyFieldForChannel = 'defaultCurrencyCode';
  for (var p = 0; p < spec.products.length; p++) {
    var product = spec.products[p];
    var slug = product.slug;

    // Look up product by slug
    var existingProduct = null;
    var productQuery = [
      'query ProductBySlug($slug: String) {',
      '  products(options: { filter: { slug: { eq: $slug } } }) { items { id slug channels { id code } } }',
      '}'
    ].join('\n');
    try {
      var r = await adminGraphqlRequest(fetchFn, adminUrl, {
        query: productQuery,
        variables: { slug: slug }
      }, authToken, secrets);
      bumpRequests(state);
      if (r.response && r.response.ok && r.response.body && r.response.body.data &&
          r.response.body.data.products && r.response.body.data.products.items &&
          r.response.body.data.products.items.length > 0) {
        existingProduct = r.response.body.data.products.items[0];
      }
    } catch (e) {
      state.errors.push('products read failed for ' + slug + ': ' + ((e && e.message) || String(e)));
      recordMutation(state, 'failed', 'product', { slug: slug, error: 'read failed' });
      continue;
    }

    if (existingProduct) {
      recordMutation(state, 'existing', 'product', { slug: slug, id: existingProduct.id });
      continue;
    }

    if (state.dryRun) {
      recordMutation(state, 'created', 'product', { slug: slug, planned: true });
      for (var vd = 0; vd < product.variants.length; vd++) {
        recordMutation(state, 'created', 'variant', { sku: product.variants[vd].sku, planned: true });
      }
      continue;
    }

    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return;
    }

    var primaryCode = product.channels[0];
    var primaryToken = channelTokenById[primaryCode] || channelTokenById[product.channels[0]] ||
      channelTokenByCode(spec, primaryCode);

    // Create the product in the primary channel context.
    var createProduct = [
      'mutation CreateProduct($input: CreateProductInput!) {',
      '  createProduct(input: $input) {',
      '    ... on Product { id slug }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var productInput = {
      translations: [{ languageCode: 'en', name: product.name, slug: product.slug, description: 'TST synthetic test product' }],
      enabled: product.enabled
    };
    var resProd = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: createProduct,
      variables: { input: productInput }
    }, primaryToken || authToken, secrets);
    bumpRequests(state);
    var prodData = resProd.response && resProd.response.body && resProd.response.body.data && resProd.response.body.data.createProduct;
    if (!prodData || prodData.__typename === 'ErrorResult') {
      var pmsg = (prodData && (prodData.message || prodData.errorCode)) || 'createProduct failed';
      recordMutation(state, 'failed', 'product', { slug: slug, error: pmsg });
      continue;
    }
    var productId = prodData.id;
    recordMutation(state, 'created', 'product', { slug: slug, id: productId });

    var primaryCurrency = null;
    for (var cc = 0; cc < spec.countries.length; cc++) {
      if (spec.countries[cc].channelCode === primaryCode) {
        primaryCurrency = spec.countries[cc].currencyCode;
        break;
      }
    }

    for (var v = 0; v < product.variants.length; v++) {
      var variant = product.variants[v];
      var sku = variant.sku;

      // Look up variant by SKU (idempotency)
      var existingVariant = null;
      var variantQuery = [
        'query VariantBySku($sku: String) {',
        '  search(input: { term: "" }) { totalItems }',
        '  productVariants(options: { filter: { sku: { eq: $sku } } }) { items { id sku } }',
        '}'
      ].join('\n');
      try {
        var vr = await adminGraphqlRequest(fetchFn, adminUrl, {
          query: variantQuery,
          variables: { sku: sku }
        }, authToken, secrets);
        bumpRequests(state);
        if (vr.response && vr.response.ok && vr.response.body && vr.response.body.data &&
            vr.response.body.data.productVariants && vr.response.body.data.productVariants.items &&
            vr.response.body.data.productVariants.items.length > 0) {
          existingVariant = vr.response.body.data.productVariants.items[0];
        }
      } catch (e) {
        state.errors.push('variant read failed for ' + sku + ': ' + ((e && e.message) || String(e)));
      }
      if (existingVariant) {
        recordMutation(state, 'existing', 'variant', { sku: sku, id: existingVariant.id });
        continue;
      }

      // Create variants in the primary channel context.
      var priceInfo = variant.price[primaryCode];
      var primaryPriceMinor = priceInfo ? priceToMinorUnits(priceInfo.decimal, priceInfo.currencyCode || primaryCurrency) : null;
      var createVariants = [
        'mutation CreateProductVariants($input: [CreateProductVariantInput!]!) {',
        '  createProductVariants(input: $input) {',
        '    ... on ProductVariant { id sku priceWithTax price }',
        '    ... on ErrorResult { errorCode message }',
        '  }',
        '}'
      ].join('\n');
      var variantInput = [{
        productId: productId,
        sku: sku,
        translations: [{ languageCode: 'en', name: variant.name }],
        price: primaryPriceMinor,
        stockOnHand: variant.stockOnHand,
        trackInventory: variant.trackInventory,
        useGlobalOutOfStockThreshold: variant.useGlobalOutOfStockThreshold || false,
        outOfStockThreshold: variant.outOfStockThreshold
      }];
      var resVar = await adminGraphqlRequest(fetchFn, adminUrl, {
        query: createVariants,
        variables: { input: variantInput }
      }, primaryToken || authToken, secrets);
      bumpRequests(state);
      var varData = resVar.response && resVar.response.body && resVar.response.body.data && resVar.response.body.data.createProductVariants;
      if (!varData || varData.__typename === 'ErrorResult') {
        var vmsg = (varData && (varData.message || varData.errorCode)) || 'createProductVariants failed';
        recordMutation(state, 'failed', 'variant', { sku: sku, error: vmsg });
        continue;
      }
      var variantId = (varData.items && varData.items[0]) ? varData.items[0].id : (varData.id || null);
      recordMutation(state, 'created', 'variant', { sku: sku, id: variantId, priceMinor: primaryPriceMinor, currency: primaryCurrency });

      // Assign to additional channels, then price in each channel's context.
      for (var a = 1; a < product.channels.length; a++) {
        var addCode = product.channels[a];
        var addToken = channelTokenById[addCode] || channelTokenByCode(spec, addCode);
        var addCurrency = null;
        for (var c2 = 0; c2 < spec.countries.length; c2++) {
          if (spec.countries[c2].channelCode === addCode) {
            addCurrency = spec.countries[c2].currencyCode;
            break;
          }
        }
        var addPriceInfo = variant.price[addCode];
        var addPriceMinor = addPriceInfo ? priceToMinorUnits(addPriceInfo.decimal, addPriceInfo.currencyCode || addCurrency) : null;

        // Assign product + variant to the channel
        var assignQuery = [
          'mutation AssignToChannel($productIds: [ID!]!, $variantIds: [ID!]!, $channelId: ID!) {',
          '  assignProductsToChannel(productIds: $productIds, channelId: $channelId) { id }',
          '  assignProductVariantsToChannel(productVariantIds: $variantIds, channelId: $channelId) { id }',
          '}'
        ].join('\n');
        var assignRes = await adminGraphqlRequest(fetchFn, adminUrl, {
          query: assignQuery,
          variables: {
            productIds: [productId],
            variantIds: [variantId],
            channelId: state.channelIdsByCode[addCode]
          }
        }, authToken, secrets);
        bumpRequests(state);

        // Set the price in the additional channel's context.
        if (addPriceMinor !== null && state.channelIdsByCode[addCode]) {
          var setPrice = [
            'mutation UpdateVariantPrice($input: [UpdateProductVariantInput!]!, $id: ID!) {',
            '  updateProductVariants(input: $input) {',
            '    ... on ProductVariant { id sku price priceWithTax }',
            '  }',
            '}'
          ].join('\n');
          var setPriceRes = await adminGraphqlRequest(fetchFn, adminUrl, {
            query: setPrice,
            variables: {
              input: [{ id: variantId, price: addPriceMinor }],
              id: variantId
            }
          }, addToken || authToken, secrets);
          bumpRequests(state);
          var spData = setPriceRes.response && setPriceRes.response.body && setPriceRes.response.body.data && setPriceRes.response.body.data.updateProductVariants;
          if (!spData || spData.items === undefined) {
            recordMutation(state, 'blocked', 'variantPrice', { sku: sku, channel: addCode, error: 'could not write price in channel context' });
          }
        }
      }
    }
  }
}

async function ensureCustomers(context, state, fetchFn, adminUrl, authToken, secrets, spec) {
  var customerPassword = String(envValue(context, 'SEED_TEST_CUSTOMER_PASSWORD') || '').trim();
  if (!customerPassword) {
    state.blocked.push({ entity: 'customer', error: 'SEED_TEST_CUSTOMER_PASSWORD missing' });
    recordMutation(state, 'blocked', 'customer', { error: 'SEED_TEST_CUSTOMER_PASSWORD missing' });
    return;
  }
  state.hasTestCustomerPassword = true;
  for (var i = 0; i < spec.testCustomers.length; i++) {
    var tc = spec.testCustomers[i];
    var email = tc.emailPrefix + '@example.invalid';
    var customerQuery = [
      'query CustomerByEmail($email: String) {',
      '  customers(options: { filter: { emailAddress: { eq: $email } } }) { items { id emailAddress } }',
      '}'
    ].join('\n');
    var existing = null;
    try {
      var r = await adminGraphqlRequest(fetchFn, adminUrl, { query: customerQuery, variables: { email: email } }, authToken, secrets);
      bumpRequests(state);
      if (r.response && r.response.ok && r.response.body && r.response.body.data &&
          r.response.body.data.customers && r.response.body.data.customers.items &&
          r.response.body.data.customers.items.length > 0) {
        existing = r.response.body.data.customers.items[0];
      }
    } catch (e) {
      state.errors.push('customer read failed for ' + email + ': ' + ((e && e.message) || String(e)));
      recordMutation(state, 'failed', 'customer', { email: email });
      continue;
    }
    if (existing) {
      recordMutation(state, 'existing', 'customer', { email: email, id: existing.id });
      continue;
    }
    if (state.dryRun) {
      recordMutation(state, 'created', 'customer', { email: email, planned: true });
      continue;
    }
    if (requestBudgetExceeded(state)) {
      state.errors.push('request budget exhausted');
      return;
    }
    var mutation = [
      'mutation CreateCustomer($input: CreateCustomerInput!, $password: String) {',
      '  createCustomer(input: $input, password: $password) {',
      '    ... on Customer { id emailAddress }',
      '    ... on ErrorResult { errorCode message }',
      '  }',
      '}'
    ].join('\n');
    var res = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: mutation,
      variables: {
        input: {
          emailAddress: email,
          firstName: tc.emailPrefix,
          lastName: '',
          phoneNumber: ''
        },
        password: customerPassword
      }
    }, authToken, secrets);
    bumpRequests(state);
    var data = res.response && res.response.body && res.response.body.data && res.response.body.data.createCustomer;
    if (data && data.__typename === 'Customer') {
      recordMutation(state, 'created', 'customer', { email: email, id: data.id });
    } else {
      var msg = (data && (data.message || data.errorCode)) || 'createCustomer failed';
      recordMutation(state, 'failed', 'customer', { email: email, error: msg });
    }
  }
}

/**
 * Verify after seeding via the Shop API per channel token (the exact check
 * CAN-B1-03 runs): activeChannel.code, activeChannel.currencyCode, and the
 * products(options:{take:5}) query. Raw redacted result is stored in state.
 */
async function verifyReadback(context, state, fetchFn, adminUrl, authToken, secrets, spec, channelTokenById) {
  var shopBase = null;
  if (context && context.shopApiUrl) shopBase = context.shopApiUrl;
  if (!shopBase) {
    var stagingBase = (context && context.runEnvRecord && context.runEnvRecord.stagingUrl) ||
      (context && context.stagingUrl);
    if (typeof stagingBase === 'string' && stagingBase.length > 0) {
      shopBase = stagingBase.replace(/\/+$/, '') + '/shop-api';
    } else {
      shopBase = adminUrl.replace(/\/admin-api$/, '/shop-api');
    }
  }
  var query = [
    'query Readback {',
    '  activeChannel { code currencyCode }',
    '  products(options: { take: 5 }) { items { name variants { price currencyCode } } }',
    '}'
  ].join('\n');
  state.readback = [];
  for (var c = 0; c < spec.countries.length; c++) {
    var country = spec.countries[c];
    var token = channelTokenById[country.channelCode] || country.channelToken;
    var callSecrets = [token].concat(secrets);
    if (state.dryRun) {
      state.readback.push({ code: country.channelCode, dryRun: true });
      continue;
    }
    try {
      var result = await adminGraphqlRequest(fetchFn, shopBase, {
        query: query,
        variables: {}
      }, token, callSecrets);
      bumpRequests(state);
      var entry = { code: country.channelCode };
      var body = result.response && result.response.body;
      if (body && body.errors && body.errors.length > 0) {
        entry.error = body.errors.map(function(e) { return redactValue(e.message, [token]); }).join('; ');
        state.errors.push('readback error for ' + country.channelCode + ': ' + entry.error);
      }
      if (body && body.data) {
        entry.activeChannel = body.data.activeChannel ? { code: body.data.activeChannel.code, currency: body.data.activeChannel.currencyCode } : null;
        if (body.data.products && body.data.products.items) {
          entry.products = body.data.products.items.map(function(pp) {
            var variants = (pp.variants || []).map(function(vv) {
              return { price: vv.price, currencyCode: vv.currencyCode };
            });
            return { name: pp.name, variants: variants };
          });
        }
      }
      if (body && body.data && body.data.products && body.data.products.items === undefined) {
        entry.status = 'STAGING_PRODUCTS_API_ERROR';
        entry.httpStatus = result.response ? result.response.httpStatus : null;
        state.errors.push('readback products query returned no items for ' + country.channelCode);
      }
      state.readback.push(redactDeep(entry, [token]));
    } catch (e) {
      state.readback.push({ code: country.channelCode, error: (e && e.message) || String(e) });
    }
  }
}

function writeSeedEvidence(context, state, evidencePayload) {
  var runId = runIdOf(context);
  if (!runId) return { ok: false, reason: 'no run id' };
  var opts = resolveEvidenceOptions(context);
  opts.kind = SEED_EVIDENCE_KIND;
  if (state && state.secrets && Array.isArray(state.secrets) && state.secrets.length > 0) {
    if (!opts.secrets) opts.secrets = {};
    for (var i = 0; i < state.secrets.length; i++) {
      opts.secrets['seed-secret-' + i] = state.secrets[i];
    }
  }
  var content = typeof evidencePayload === 'string' ? evidencePayload : JSON.stringify(evidencePayload, null, 2);
  var evidenceCollector = null;
  try {
    evidenceCollector = require('../evidenceCollector');
  } catch (e) {
    // fallback below
  }
  if (evidenceCollector && typeof evidenceCollector.writeEvidenceFile === 'function') {
    try {
      // The evidence collector requires the run index to exist before
      // writeEvidenceFile appends to it; initialise it at the same resolved
      // root+baseDir so the file lands at evidence/<runId>/seed/seed-record.json.
      var initOpts = { root: (opts.root || process.cwd()), baseDir: (opts.baseDir || 'evidence'), reuseExisting: true };
      var loaded = evidenceCollector.loadIndex(path.resolve(initOpts.root, initOpts.baseDir), runId);
      if (!loaded.exists) {
        evidenceCollector.initEvidenceIndex(runId, {}, initOpts);
      }
      var res = evidenceCollector.writeEvidenceFile(runId, 'seed', SEED_EVIDENCE_FILENAME, content, opts);
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
  }
  // Direct fallback write to evidence/<runId>/seed/seed-record.json
  try {
    var baseDir = (opts && opts.baseDir) || 'evidence';
    var root = (opts && opts.root) || process.cwd();
    var fullPath = path.join(root, baseDir, runId, 'seed', SEED_EVIDENCE_FILENAME);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return { ok: true, result: { path: fullPath } };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

async function seedStaging(context, options) {
  context = context || {};
  options = options || {};
  var state = createState();
  state.mode = options.dryRun ? 'dry-run' : 'full';
  state.dryRun = !!options.dryRun;
  state.startedAt = getClock(context)().toISOString();

  var fetchFn = getFetch(context);
  if (!fetchFn) {
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: 'NO_FETCH', errors: ['no fetch implementation available'] });
  }
  state.fetchAvailable = true;

  var specLoad = getSeedSpec(context, options);
  if (specLoad.error) {
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: 'SEED_SPEC_MISSING', errors: [specLoad.error] });
  }
  var spec = specLoad.spec;
  state.version = spec.version;
  state.specSha256 = crypto.createHash('sha256').update(JSON.stringify(spec), 'utf8').digest('hex');

  var adminUrl = resolveAdminApiBase(context);
  state.host = hostOf(adminUrl);
  state.hostAllowed = hostAllowed(adminUrl);

  if (!state.hostAllowed) {
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: SEED_HOST_NOT_ALLOWED, host: state.host });
  }

  var credState = adminCredentialState(context);
  if (!credState.credentialsPresent) {
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: ADMIN_CREDENTIALS_MISSING, credentialNames: credState });
  }

  var username = adminUsername(context);
  var password = adminPassword(context);
  var allSecrets = uniqueSecrets([password]);
  // Nominal channel tokens are needed only to reach the per-channel contexts;
  // they are secrets and are never kept in evidence.
  for (var sc = 0; sc < spec.countries.length; sc++) {
    allSecrets.push(spec.countries[sc].channelToken);
  }
  allSecrets = uniqueSecrets(allSecrets);
  state.secrets = allSecrets;

  var login = await loginToAdmin(context, fetchFn, adminUrl, username, password, allSecrets);
  if (!login.ok) {
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: login.reason, error: login.error });
  }
  state.mutations += 0; // login is allowed but not counted as a seed mutation
  bumpRequests(state, login.callCount);
  var authToken = login.authToken;
  if (authToken) allSecrets.push(authToken);
  allSecrets = uniqueSecrets(allSecrets);
  state.secrets = allSecrets;

  // Introspect schema types before building inputs.
  var introspectResult = await introspectTypes(fetchFn, adminUrl, authToken, [
    'Mutation', 'Channel', 'CreateChannelInput', 'CreateProductInput', 'CreateProductVariantInput', 'Zone', 'Country'
  ]);
  bumpRequests(state);
  state.introspectedTypes = {};
  var keys = Object.keys(introspectResult.types);
  for (var ki = 0; ki < keys.length; ki++) {
    var t = introspectResult.types[keys[ki]];
    state.introspectedTypes[keys[ki]] = { present: t.present, fields: t.fields, inputFields: t.inputFields };
  }
  state.onboardCountryAvailable = hasMutation(introspectResult, 'onboardCountry');
  if (state.onboardCountryAvailable) {
    state.conflicts.push({ entity: 'channel', reason: 'onboardCountry present but channels require code <cc>; refusing onboardCountry flow' });
  }

  // Pre-read probe (READ-ONLY) before any mutation.
  var preRead = await preReadAdmin(context, fetchFn, adminUrl, authToken, allSecrets);
  bumpRequests(state);
  state.preRead = preRead.ok ? redactDeep(preRead.data, allSecrets) : { error: (preRead.error || 'pre-read failed') };

  if (state.dryRun) {
    state.created = [];
    state.conflicts = [];
    state.failed = [];
    state.mutations = 0;
    // Still record the plan for each entity.
    await planDryRun(context, state, spec, fetchFn, adminUrl, authToken, allSecrets);
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { ok: true, path: null });
  }

  // 1. Countries
  var countryIds = {};
  await ensureCountries(context, state, fetchFn, adminUrl, authToken, allSecrets);
  var countryQuery = '{ countries { items { id code } } }';
  try {
    var cr = await adminGraphqlRequest(fetchFn, adminUrl, { query: countryQuery, variables: {} }, authToken, allSecrets);
    bumpRequests(state);
    if (cr.response && cr.response.ok && cr.response.body && cr.response.body.data && cr.response.body.data.countries) {
      var citems = cr.response.body.data.countries.items || [];
      for (var ci = 0; ci < citems.length; ci++) {
        countryIds[String(citems[ci].code).toUpperCase()] = citems[ci].id;
      }
    }
  } catch (e) {
    state.errors.push('countries id read failed: ' + ((e && e.message) || String(e)));
  }
  state.countryIds = countryIds;

  // 2. Zones
  var zoneIds = await ensureZones(context, state, fetchFn, adminUrl, authToken, allSecrets, spec);

  // 3. Tax category + tax rates
  await ensureTax(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, zoneIds);

  // 4. Channels
  var channelIds = await ensureChannels(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, introspectResult, zoneIds);
  state.channelIdsByCode = channelIds || {};

  // 5. Stock locations
  await ensureStockLocations(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, channelIds);

  // Build channel code->token lookup for per-channel context pricing.
  var channelTokenById = {};
  for (var s = 0; s < spec.countries.length; s++) {
    channelTokenById[spec.countries[s].channelCode] = spec.countries[s].channelToken;
  }

  // 6. Products + variants (priced per channel context)
  await ensureProducts(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, channelTokenById);

  // 7. Test customers
  await ensureCustomers(context, state, fetchFn, adminUrl, authToken, allSecrets, spec);

  // 8. Read-back verification via Shop API per channel token
  await verifyReadback(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, channelTokenById);

  state.completedAt = getClock(context)().toISOString();
  return finalizeSeedResult(context, state, { ok: true });
}

/**
 * Dry-run: perform reads only and record the plan (no mutations).
 */
async function planDryRun(context, state, spec, fetchFn, adminUrl, authToken, allSecrets) {
  await ensureCountries(context, state, fetchFn, adminUrl, authToken, allSecrets);
  var zoneIds = {};
  var zoneQuery = '{ zones { items { id name } } }';
  try {
    var zr = await adminGraphqlRequest(fetchFn, adminUrl, { query: zoneQuery, variables: {} }, authToken, allSecrets);
    bumpRequests(state);
    if (zr.response && zr.response.ok && zr.response.body && zr.response.body.data && zr.response.body.data.zones) {
      var zitems = zr.response.body.data.zones.items || [];
      for (var i = 0; i < zitems.length; i++) zoneIds[zitems[i].name] = zitems[i].id;
    }
  } catch (e) {}
  await ensureChannels(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, null, zoneIds);
  await ensureProducts(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, {});
  await ensureCustomers(context, state, fetchFn, adminUrl, authToken, allSecrets, spec);
}

function finalizeSeedResult(context, state, extra) {
  var out = {
    ok: false,
    reason: null,
    host: state.host,
    hostAllowed: state.hostAllowed,
    mode: state.mode,
    dryRun: !!state.dryRun,
    version: state.version,
    specSha256: state.specSha256,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    requests: state.requests,
    requestBudget: state.requestBudget,
    mutations: state.mutations,
    created: state.created,
    existing: state.existing,
    conflicts: state.conflicts,
    failed: state.failed,
    blocked: state.blocked,
    channels: state.channels,
    preRead: state.preRead,
    readback: state.readback,
    onboardCountryAvailable: state.onboardCountryAvailable,
    introspectedTypes: state.introspectedTypes,
    errors: state.errors,
    hasTestCustomerPassword: state.hasTestCustomerPassword || false,
    evidence: null
  };
  if (extra) {
    if (extra.reason !== undefined) out.reason = extra.reason;
    if (extra.error !== undefined) out.error = extra.error;
    if (extra.errors !== undefined) out.errors = extra.errors;
    if (extra.host !== undefined) out.host = extra.host;
    if (extra.credentialNames !== undefined) out.credentialNames = extra.credentialNames;
  }
  out.ok = !!(extra && extra.ok) && state.failed.length === 0 && state.conflicts.length === 0;

  var written = writeSeedEvidence(context, state, out);
  out.evidence = written.ok ? { written: true, file: SEED_EVIDENCE_FILENAME } : { written: false, reason: written.reason };

  // Never expose the secrets on the returned record.
  delete state.secrets;
  Object.defineProperty(out, 'secrets', {
    value: (state.secretValues || []),
    enumerable: false,
    writable: true,
    configurable: true
  });
  return out;
}

module.exports = {
  seedStaging: seedStaging,
  writeSeedEvidence: writeSeedEvidence,
  SEED_HOST_NOT_ALLOWED: 'SEED_HOST_NOT_ALLOWED',
  SEED_CONFLICT: 'SEED_CONFLICT',
  ADMIN_CREDENTIALS_MISSING: 'ADMIN_CREDENTIALS_MISSING',
  resolveAdminApiBase: resolveAdminApiBase,
  redactDeep: redactDeep
};
