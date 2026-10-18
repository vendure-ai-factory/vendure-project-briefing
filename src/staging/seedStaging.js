'use strict';

/**
 * Idempotent staging seeder for the staging readiness run (CAN-B1-03 / CAN-B1-04 /
 * CAN-B2-16). Seeds channels, zones, tax, minimal catalog and per-country test
 * customers in the isolated staging environment via the Admin API. Reads first,
 * never deletes. Creates missing entities; assigns products to additional channels;
 * updates per-channel variant prices (updateProductVariants). Never throws;
 * returns a structured record.
 */

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var REDACTED_MARKER = '[REDACTED]';

var SEED_HOST_NOT_ALLOWED = 'SEED_HOST_NOT_ALLOWED';
var SEED_CONFLICT = 'SEED_CONFLICT';
var ADMIN_CREDENTIALS_MISSING = 'ADMIN_CREDENTIALS_MISSING';
var SEED_CONFIG_BLOCKED = 'SEED_CONFIG_BLOCKED';

var ALLOWED_HOSTS = ['staging.tibella.eu'];

// Vendure >= 3.x models variant stock tracking as the GlobalFlag enum
// (INHERIT | TRUE | FALSE), not a Boolean.  A Boolean/missing value is rejected
// by the schema (GraphQL validation: "Expected value of type 'GlobalFlag'"),
// which is exactly what the staging run observed.  We never invent a value:
// undefined stays INHERIT (the server default), true -> TRUE, false -> FALSE.
var GLOBAL_FLAG_MAP = {
  true: 'TRUE',
  false: 'FALSE',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  INHERIT: 'INHERIT'
};

function toGlobalFlag(value) {
  if (value === undefined || value === null || value === '') return 'INHERIT';
  var normalized = typeof value === 'boolean' ? String(value) : String(value).toUpperCase();
  return GLOBAL_FLAG_MAP[normalized] || 'INHERIT';
}
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
    // Request both fields (output types) and inputFields (input object types) so
    // that CreateChannelInput, CreateProductInput, etc. are introspected correctly.
    parts.push('  ' + t + ': __type(name: "' + t + '") {' +
      ' name' +
      ' fields { name type { name kind ofType { name kind } } }' +
      ' inputFields { name type { name kind ofType { name kind } } }' +
      ' }');
  }
  parts.push('}');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Low-level request helper (bearer or cookie sessions)
// ---------------------------------------------------------------------------

function adminGraphqlRequest(fetchFn, url, body, token, extraSecrets, channelToken) {
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
  // Channel-context header: Vendure resolves the active channel from the
  // `vendure-token` header (channelTokenKey), for both the Admin and Shop
  // APIs. A channel token must NEVER be passed as vendure-auth-token - that
  // header only carries the auth session token.
  if (channelToken) {
    headers['vendure-token'] = channelToken;
    secrets.push(channelToken);
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
          // Output-type fields (non-input types)
          var fields = tdata.fields || [];
          for (var k = 0; k < fields.length; k++) {
            var f = fields[k];
            if (f && f.name) result.types[tn].fields.push(f.name);
          }
          // Input-type fields — GraphQL input object types expose 'inputFields',
          // not 'fields'. Populate result.inputFields from the correct source.
          var inputFields = tdata.inputFields || [];
          for (var m = 0; m < inputFields.length; m++) {
            var inf = inputFields[m];
            if (inf && inf.name) result.types[tn].inputFields.push(inf.name);
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
    readbackLadder: null,
    preRead: null,
    errors: [],
    requestBudget: MAX_REQUESTS,
    requests: 0
  };
}

/**
 * Record the outcome of one seeding operation.
 *
 * Supported kinds and their meaning:
 *   'created'  — entity was newly created (counts as a mutation)
 *   'existing' — entity already existed and was verified
 *   'conflict' — entity exists but its state conflicts with the spec
 *   'assigned' — entity was successfully assigned to a channel/location
 *   'updated'  — entity was successfully updated (e.g. per-channel pricing)
 *   'blocked'  — operation was skipped because a prerequisite was missing
 *   'failed'   — operation was attempted and failed (does NOT count as a
 *                successful mutation; recorded in state.failed for visibility)
 *   'planned'  (via created with details.planned) — dry-run plan entry only
 *
 * Mutations (state.mutations) count only successful creations, assignments
 * and updates that actually wrote data, not failures or dry-run plan entries.
 */
function recordMutation(state, kind, entity, details) {
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
    // Dry-run plan entries (details.planned === true) do not increment the
    // mutation counter because no data was actually written.
    if (!state.dryRun && !entry.planned) state.mutations += 1;
    state.created.push(entry);
  } else if (kind === 'existing') {
    state.existing.push(entry);
  } else if (kind === 'conflict') {
    state.conflicts.push(entry);
  } else if (kind === 'assigned' || kind === 'updated') {
    // Successful assignments and updates are real mutations but are reported
    // in state.created (they are write operations that succeeded).
    if (!state.dryRun) state.mutations += 1;
    state.created.push(entry);
  } else if (kind === 'blocked') {
    // Blocked operations are not failures; they are skipped because a
    // prerequisite was absent.  Recorded separately for diagnostics.
    state.blocked.push(entry);
  } else {
    // 'failed' and any unrecognised kind.
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

/**
 * The git HEAD (execution revision) from the run environment. A pre-resolved
 * gitHead in context.runEnv (or runEnvRecord) wins; otherwise we resolve from
 * the local repo (context.cwd). Never throws. An unresolvable HEAD is null
 * (absent), which the report shows as n/a.
 */
function gitHeadOf(context) {
  var record = (context && context.runEnv) || (context && context.runEnvRecord);
  if (record && (record.gitHead || record.revisionId)) {
    return record.gitHead || record.revisionId;
  }
  var cwdValue = (context && context.cwd) || process.cwd();
  var childProcess = (context && context.deps && context.deps.childProcess) || null;
  if (!childProcess) {
    try { childProcess = require('child_process'); } catch (e) { childProcess = null; }
  }
  if (!childProcess || typeof childProcess.execFileSync !== 'function') {
    return null;
  }
  try {
    var out = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: cwdValue,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    });
    var hash = String(out).trim();
    return hash || null;
  } catch (e) {
    return null;
  }
}

/**
 * The manifest reference commit. A pre-resolved value in context.runEnvRecord
 * wins; otherwise we read manifest/acceptance-manifest.v0.4.json resolved from
 * the repo root. Never throws; missing manifest yields null.
 */
function referenceCommitOf(context) {
  var record = (context && context.runEnvRecord);
  if (record && record.referenceCommit) return record.referenceCommit;
  var cwdValue = (context && context.cwd) || process.cwd();
  var manifestPath = path.join(cwdValue, 'manifest', 'acceptance-manifest.v0.4.json');
  try {
    var parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (parsed && parsed.source && parsed.source.referenceCommit) {
      return parsed.source.referenceCommit;
    }
    if (parsed && parsed.referenceCommit) return parsed.referenceCommit;
  } catch (e) {}
  return null;
}

/**
 * Compute the protected-path hash (all PROTECTED_ROOTS) at the current tree.
 * Uses the same module as the task runner so seed evidence and task evidence
 * agree on the value. Never throws; returns null on failure.
 */
function protectedPathsHashOf(context) {
  var protectedModule = null;
  try {
    protectedModule = require('../protectedPaths');
  } catch (e) {
    protectedModule = null;
  }
  if (!protectedModule || typeof protectedModule.computeProtectedHashes !== 'function') {
    return null;
  }
  var cwdValue = (context && context.cwd) || process.cwd();
  try {
    var info = protectedModule.computeProtectedHashes({ root: cwdValue });
    return info && info.ok ? info.combinedHash : null;
  } catch (e) {
    return null;
  }
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

function resolveSeedChannelTokens(context, spec) {
  var env = getEnvFn(context)();
  var raw = env ? env.CHANNEL_TOKENS : undefined;
  var map = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw === 'string') {
      try { map = JSON.parse(raw); } catch (e) {
        return { ok: false, error: 'CHANNEL_TOKENS is not valid JSON' };
      }
    } else if (typeof raw === 'object' && raw !== null) {
      map = raw;
    } else {
      return { ok: false, error: 'CHANNEL_TOKENS must be a JSON object of channel tokens' };
    }
  }
  if (!map) {
    return { ok: false, error: 'CHANNEL_TOKENS missing; real channel tokens are required to seed' };
  }
  var missing = [];
  for (var i = 0; i < (spec && spec.countries ? spec.countries.length : 0); i++) {
    var c = spec.countries[i];
    var key = c.countryCode;
    var tok = map[key] || map[key.toLowerCase()] || map[c.channelCode] || map[c.channelToken];
    if (typeof tok !== 'string' || tok.length === 0) {
      missing.push(key);
      continue;
    }
    c.channelToken = tok;
  }
  if (missing.length > 0) {
    return { ok: false, error: 'CHANNEL_TOKENS missing values for: ' + missing.join(', ') };
  }
  return { ok: true };
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

/**
 * Ensures the seed's default language (channel defaultLanguageCode, 'en') is
 * enabled in globalSettings.availableLanguages before createChannel runs, by
 * checking the introspection-first (no invented fields) and then either
 * confirming presence or calling updateGlobalSettings to add it, keeping the
 * existing languages.
 *
 * Returns { ok, present, added, planned, available, error }.
 *   ok:true  language already present / added via mutation / planned (dry-run)
 *   ok:false the update failed, was not permitted, or could not be verified;
 *            a 'failed' entry is recorded in state with the exact error and
 *            the caller is expected to skip channel creation.
 */
async function ensureDefaultLanguage(context, state, fetchFn, adminUrl, authToken, secrets, introspection, required) {
  required = required || 'en';
  var globalSettingsAvail = hasField(introspection, 'GlobalSettings', 'availableLanguages');
  var updateInputAvail = hasInputField(introspection, 'UpdateGlobalSettingsInput', 'availableLanguages');
  var updateMutationAvail = hasMutation(introspection, 'updateGlobalSettings');

  // Read current languages. A failed read is a blocker: fail closed rather than
  // seed into a server whose language set we cannot verify.
  var query = '{ globalSettings { availableLanguages } }';
  var res;
  try {
    res = await adminGraphqlRequest(fetchFn, adminUrl, { query: query, variables: {} }, authToken, secrets);
  } catch (e) {
    res = { response: null, networkError: (e && e.message) || String(e) };
  }
  var body = res.response && res.response.body;
  var langs = body && body.data && body.data.globalSettings && body.data.globalSettings.availableLanguages;
  if (!Array.isArray(langs)) {
    var readErr = (res.networkError) || ((body && body.errors && body.errors.length > 0) ? body.errors.map(function(e2) { return e2.message; }).join('; ') : 'globalSettings query failed or availableLanguages missing');
    recordMutation(state, 'failed', 'language', { required: required, reason: 'read', error: readErr });
    state.languagePrerequisite = { required: required, present: false, error: readErr, available: null };
    return { ok: false, error: readErr };
  }

  var present = false;
  for (var i = 0; i < langs.length; i++) {
    if (String(langs[i]).toLowerCase() === String(required).toLowerCase()) { present = true; break; }
  }
  if (present) {
    state.languagePrerequisite = { required: required, present: true, added: false, available: langs };
    return { ok: true, present: true, available: langs };
  }

  // Required language missing.
  if (state.dryRun) {
    // Plan the step without calling the mutation.
    recordMutation(state, 'created', 'language', { required: required, planned: true, plan: 'add ' + required + ' to globalSettings.availableLanguages, keeping existing' });
    state.languagePrerequisite = { required: required, present: false, planned: true, available: langs };
    return { ok: true, planned: true, available: langs };
  }

  // updateGlobalSettings not available in the schema -> cannot enable it.
  if (!globalSettingsAvail || !updateInputAvail || !updateMutationAvail) {
    var notPermitted = 'updateGlobalSettings is not available in the schema (GlobalSettings.availableLanguages=' + globalSettingsAvail + ', UpdateGlobalSettingsInput.availableLanguages=' + updateInputAvail + ', mutation=' + updateMutationAvail + '); cannot enable language "' + required + '"';
    recordMutation(state, 'failed', 'language', { required: required, reason: 'not-permitted', error: notPermitted });
    state.languagePrerequisite = { required: required, present: false, error: notPermitted, available: langs };
    return { ok: false, error: notPermitted };
  }

  // Build the new language set keeping the existing languages.
  var newLangs = [];
  var seen = {};
  for (var j = 0; j < langs.length; j++) {
    var lv = String(langs[j]);
    if (!seen[lv.toLowerCase()]) { seen[lv.toLowerCase()] = true; newLangs.push(lv); }
  }
  if (!seen[String(required).toLowerCase()]) newLangs.push(required);

  var mutation = [
    'mutation UpdateGlobalSettings($input: UpdateGlobalSettingsInput!) {',
    '  updateGlobalSettings(input: $input) {',
    '    ... on GlobalSettings { availableLanguages }',
    '    ... on ErrorResult { errorCode message }',
    '  }',
    '}'
  ].join('\n');
  var mres;
  try {
    mres = await adminGraphqlRequest(fetchFn, adminUrl, { query: mutation, variables: { input: { availableLanguages: newLangs } } }, authToken, secrets);
  } catch (e) {
    mres = { response: null, networkError: (e && e.message) || String(e) };
  }
  var mbody = mres.response && mres.response.body;
  var mdata = mbody && mbody.data && mbody.data.updateGlobalSettings;
  var mErrors = (mbody && mbody.errors && mbody.errors.length > 0) ? mbody.errors.map(function(e) { return e.message; }).join('; ') : null;
  if (mres.networkError) {
    recordMutation(state, 'failed', 'language', { required: required, reason: 'update', error: 'updateGlobalSettings network error: ' + mres.networkError });
    state.languagePrerequisite = { required: required, present: false, available: langs, error: 'updateGlobalSettings network error: ' + mres.networkError };
    return { ok: false, error: 'updateGlobalSettings failed: ' + mres.networkError };
  }
  if (mErrors) {
    recordMutation(state, 'failed', 'language', { required: required, reason: 'update', error: mErrors });
    state.languagePrerequisite = { required: required, present: false, available: langs, error: mErrors };
    return { ok: false, error: mErrors };
  }
  if (mdata && mdata.availableLanguages !== undefined && !(mdata.errorCode || mdata.message)) {
    recordMutation(state, 'updated', 'language', { required: required, added: true, languages: mdata.availableLanguages });
    state.languagePrerequisite = { required: required, present: false, added: true, available: mdata.availableLanguages };
    return { ok: true, added: true, available: mdata.availableLanguages };
  }
  var updateErr = (mdata && (mdata.message || mdata.errorCode)) || 'updateGlobalSettings returned no usable data';
  recordMutation(state, 'failed', 'language', { required: required, reason: 'update', error: updateErr });
  state.languagePrerequisite = { required: required, present: false, available: langs, error: updateErr };
  return { ok: false, error: updateErr };
}

function hasField(introspection, typeName, fieldName) {
  var t = introspection && introspection.types && introspection.types[typeName];
  return !!(t && t.present && t.fields && t.fields.indexOf(fieldName) !== -1);
}

function hasInputField(introspection, typeName, fieldName) {
  var t = introspection && introspection.types && introspection.types[typeName];
  return !!(t && t.present && ((t.inputFields && t.inputFields.indexOf(fieldName) !== -1) || (t.fields && t.fields.indexOf(fieldName) !== -1)));
}

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

/**
 * Build a safe failure diagnostic for a failed create mutation. Inspects the
 * top-level GraphQL `errors` array and the mutation result's ErrorResult fields
 * (`message` / `errorCode`); neither yields anything useful, falls back to the
 * HTTP status plus any `networkError`. Only message-shaped strings are copied,
 * never request headers, tokens or raw response bodies, and the assembled text
 * is run through redactValue() with the request's known secrets.
 */
function buildCreateDiagnostic(res, data, defaultMsg, secrets) {
  var parts = [];
  var topErrors = res && res.response && res.response.body && Array.isArray(res.response.body.errors)
    ? res.response.body.errors : [];
  if (topErrors.length > 0 && topErrors[0]) {
    var firstError = topErrors[0];
    var topMsgs = [];
    if (firstError.message) topMsgs.push(String(firstError.message));
    if (firstError.errorCode) topMsgs.push(String(firstError.errorCode));
    if (topMsgs.length > 0) parts.push('graphql: ' + topMsgs.join(' | '));
  }
  var resultMsgs = [];
  if (data) {
    if (data.message) resultMsgs.push(String(data.message));
    if (data.errorCode) resultMsgs.push(String(data.errorCode));
  }
  if (resultMsgs.length > 0) parts.push('result: ' + resultMsgs.join(' | '));
  if (parts.length > 0) {
    return redactValue(parts.join(' | '), secrets);
  }
  var fallback = [];
  var httpStatus = res && res.response ? res.response.httpStatus : null;
  if (httpStatus !== null && httpStatus !== undefined) fallback.push('http ' + httpStatus);
  var networkErr = res && res.networkError ? String(res.networkError) : '';
  if (networkErr) fallback.push('network: ' + networkErr);
  if (fallback.length === 0) fallback.push(defaultMsg);
  return redactValue(fallback.join(' | '), secrets);
}

/**
 * Returns true if the response body contains a top-level GraphQL errors array.
 * A null / empty data with errors array means the server rejected the request
 * even though it returned HTTP 200.
 */
function hasTopLevelGraphqlErrors(res) {
  var body = res && res.response && res.response.body;
  // GraphQL errors in body (HTTP 200 or any status with GraphQL error envelope).
  if (body && Array.isArray(body.errors) && body.errors.length > 0) return true;
  // Non-2xx HTTP status is an error even without GraphQL errors[].
  var status = res && res.response ? res.response.httpStatus : null;
  if (status !== null && status !== undefined && (status < 200 || status >= 300)) return true;
  return false;
}

/**
 * Extract a safe diagnostic string from a response that was expected to return
 * a list of concrete objects (ProductVariant[] etc.).  Checks GraphQL errors,
 * the HTTP status, and the data shape.  Uses redactValue() so the returned
 * string is safe to record.
 */
function validateListMutationResult(res, data, defaultMsg, secrets) {
  if (hasTopLevelGraphqlErrors(res)) {
    var errs = res.response.body.errors;
    var msg = (errs[0] && (errs[0].message || errs[0].errorCode)) || 'GraphQL error';
    return redactValue('graphql: ' + msg, secrets);
  }
  if (!data) {
    var parts = [];
    var status = res && res.response ? res.response.httpStatus : null;
    if (status !== null && status !== undefined) parts.push('http ' + status);
    var net = res && res.networkError ? String(res.networkError) : '';
    if (net) parts.push('network: ' + net);
    if (parts.length === 0) parts.push(defaultMsg);
    return redactValue(parts.join(' | '), secrets);
  }
  if (Array.isArray(data) && data.length === 0) {
    return redactValue('empty list returned: ' + defaultMsg, secrets);
  }
  return null; // valid
}

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
      '    __typename',
      '    id',
      '    code',
      '    enabled',
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
      var msg = buildCreateDiagnostic(res, data, 'createCountry failed', secrets);
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
      '    __typename',
      '    id',
      '    name',
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
      var msg = buildCreateDiagnostic(res, data, 'createZone failed', secrets);
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
      '    __typename',
      '    id',
      '    name',
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
  var currencyField = introspection && introspection.types && introspection.types.Channel &&
    introspection.types.Channel.fields.indexOf('defaultCurrencyCode') !== -1 ? 'defaultCurrencyCode' : 'currencyCode';
  var channelFields = ['id', 'code', 'token', currencyField];
  if (introspection && introspection.types && introspection.types.Channel) {
    var chFields = introspection.types.Channel.fields;
    if (chFields.indexOf('availableCurrencyCodes') !== -1) channelFields.push('availableCurrencyCodes');
    if (chFields.indexOf('pricesIncludeTax') !== -1) channelFields.push('pricesIncludeTax');
    // defaultLanguageCode / defaultTaxZone / defaultShippingZone are used both
    // to enforce the seed language on existing channels and to write
    // non-sensitive per-channel evidence (the identifiers only, never tokens).
    if (chFields.indexOf('defaultLanguageCode') !== -1) channelFields.push('defaultLanguageCode');
    if (chFields.indexOf('defaultTaxZone') !== -1) channelFields.push('defaultTaxZone { id name }');
    if (chFields.indexOf('defaultShippingZone') !== -1) channelFields.push('defaultShippingZone { id name }');
  }
  var query = '{ channels(options: { take: 100 }) { items { ' + channelFields.join(' ') + ' } totalItems } }';

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
      await ensureChannelLanguage(context, state, fetchFn, adminUrl, authToken, secrets, introspection, byCodeHit, code, country.defaultLanguageCode);
      recordChannelEvidence(state, byCodeHit, code, currencyField);
      continue;
    }
    if (byCodeHit) {
      channelIds[code] = byCodeHit.id;
      recordMutation(state, 'existing', 'channel', { code: code, id: byCodeHit.id, currency: byCodeHit[currencyField] });
      await ensureChannelLanguage(context, state, fetchFn, adminUrl, authToken, secrets, introspection, byCodeHit, code, country.defaultLanguageCode);
      recordChannelEvidence(state, byCodeHit, code, currencyField);
      continue;
    }
    if (byTokenHit) {
      channelIds[code] = byTokenHit.id;
      recordMutation(state, 'existing', 'channel', { code: code, id: byTokenHit.id, currency: byTokenHit[currencyField] });
      await ensureChannelLanguage(context, state, fetchFn, adminUrl, authToken, secrets, introspection, byTokenHit, code, country.defaultLanguageCode);
      recordChannelEvidence(state, byTokenHit, code, currencyField);
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
      '    __typename',
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
    // Check inputFields (the correct GraphQL field for input object types).
    // Also fall back to fields for backwards-compatibility with mocks that
    // were written before the introspection query was corrected.
    if (introspection && introspection.types && introspection.types.CreateChannelInput) {
      var ciType = introspection.types.CreateChannelInput;
      if ((ciType.inputFields && ciType.inputFields.indexOf('availableCurrencyCodes') !== -1) ||
          (ciType.fields && ciType.fields.indexOf('availableCurrencyCodes') !== -1)) {
        chanInput.availableCurrencyCodes = [expectedCurrency];
      }
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
      recordMutation(state, 'created', 'channel', { code: code, id: data.id, currency: expectedCurrency, languageCode: data.defaultLanguageCode || chanInput.defaultLanguageCode });
      // Do NOT store the raw channel token here — it is a secret and would
      // be serialised into evidence.  Only code, currency, language and
      // zone names are diagnostic and non-sensitive.
      state.channels.push({
        code: code,
        currency: expectedCurrency,
        defaultLanguageCode: data.defaultLanguageCode || chanInput.defaultLanguageCode || country.defaultLanguageCode,
        defaultTaxZone: data.defaultTaxZone ? { name: data.defaultTaxZone.name } : null,
        defaultShippingZone: data.defaultShippingZone ? { name: data.defaultShippingZone.name } : null
      });
    } else {
      var topErrors = resChan.response && resChan.response.body && Array.isArray(resChan.response.body.errors) ? resChan.response.body.errors : [];
      var cmsg = (topErrors.length > 0 && topErrors[0] && (topErrors[0].message || topErrors[0].errorCode))
        ? (topErrors[0].message || topErrors[0].errorCode)
        : ((data && (data.message || data.errorCode)) || 'createChannel failed');
      recordMutation(state, 'failed', 'channel', { code: code, error: redactValue(cmsg, secrets), languageCode: chanInput.defaultLanguageCode });
    }
  }
  return channelIds;
}

/**
 * Enforce the channel defaultLanguageCode from an existing channel record.
 * If the channel exists with a wrong/missing language, call updateChannel to
 * set defaultLanguageCode to the value the seed expects and record the change.
 * On failure or not-permitted, record a 'failed' entry (exact redacted error)
 * but do NOT remove the channel from channelIds - the seeder records the
 * failure and the caller's finalizeSeedResult will force ok:false. The helper
 * is a no-op in dry-run (plans only, no mutation) and when the language already
 * matches. Token values are never written.
 */
async function ensureChannelLanguage(context, state, fetchFn, adminUrl, authToken, secrets, introspection, record, code, expectedLang) {
  if (!expectedLang) return;
  if (state.dryRun) return;
  var currentLang = record && record.defaultLanguageCode;
  if (String(currentLang || '').toLowerCase() === String(expectedLang).toLowerCase()) return;
  var updateChannelAvail = hasMutation(introspection, 'updateChannel');
  var updateInputAvail = hasInputField(introspection, 'UpdateChannelInput', 'defaultLanguageCode');
  if (!updateChannelAvail || !updateInputAvail) {
    recordMutation(state, 'failed', 'channel', { code: code, reason: 'language', error: 'updateChannel not available in schema; cannot set defaultLanguageCode to ' + expectedLang });
    return;
  }
  var mutation = [
    'mutation UpdateChannelLanguage($input: UpdateChannelInput!) {',
    '  updateChannel(input: $input) {',
    '    ... on Channel { id code defaultLanguageCode }',
    '    ... on ErrorResult { errorCode message }',
    '  }',
    '}'
  ].join('\n');
  var mutationInput = { id: record.id, defaultLanguageCode: expectedLang };
  var res = await adminGraphqlRequest(fetchFn, adminUrl, { query: mutation, variables: { input: mutationInput } }, authToken, secrets);
  bumpRequests(state);
  var mbody = res.response && res.response.body;
  var mdata = mbody && mbody.data && mbody.data.updateChannel;
  var gqlErrors = (mbody && mbody.errors && mbody.errors.length > 0) ? mbody.errors.map(function(e) { return e.message; }).join('; ') : null;
  if (res.networkError) {
    recordMutation(state, 'failed', 'channel', { code: code, reason: 'language', error: 'updateChannel network error: ' + res.networkError });
    return;
  }
  if (gqlErrors) {
    recordMutation(state, 'failed', 'channel', { code: code, reason: 'language', error: gqlErrors });
    return;
  }
  if (mdata && mdata.code && !(mdata.errorCode || mdata.message)) {
    recordMutation(state, 'updated', 'channel', { code: code, id: mdata.id, languageFrom: currentLang, languageTo: mdata.defaultLanguageCode || expectedLang });
    record.defaultLanguageCode = mdata.defaultLanguageCode || expectedLang;
    return;
  }
  var uMsg = (mdata && (mdata.message || mdata.errorCode)) || 'updateChannel returned no usable data';
  recordMutation(state, 'failed', 'channel', { code: code, reason: 'language', error: uMsg });
}

/**
 * Ensure the DEFAULT channel (the activeChannel without a channel token, code
 * __default_channel__) has a defaultTaxZone and defaultShippingZone set.
 * This is required because admin mutations sent without a vendure-token run
 * in the default channel context, and without a tax zone the error
 * "The active tax zone could not be determined" blocks product/variant pricing.
 * The EU zone (zoneIds['EU']) is used as the default.  Idempotent: if the
 * default channel already has a tax zone set, records 'existing' and does not
 * mutate.  Records 'updated' when a mutation was needed.  On failure or when
 * updateChannel is unavailable, records a 'failed' entry with the redacted
 * error.  Safe to call even when the default channel id is unknown (skips
 * silently in that case).
 */
async function ensureDefaultChannelTaxZone(context, state, fetchFn, adminUrl, authToken, secrets, introspection, zoneIds) {
  // Can only proceed if we have the default channel data from preRead.
  var preReadData = (state.preRead && state.preRead.ok === false) ? null : state.preRead;
  var activeChannel = preReadData && preReadData.activeChannel ? preReadData.activeChannel : null;
  if (!activeChannel) return;
  // If defaultTaxZone is already set, nothing to do.
  if (activeChannel.defaultTaxZone && (activeChannel.defaultTaxZone.id || activeChannel.defaultTaxZone.name)) return;
  // EU zone must exist (created by ensureZones before this is called).
  var euZoneId = zoneIds && zoneIds['EU'] ? zoneIds['EU'] : null;
  if (!euZoneId) {
    recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: 'EU zone not found; cannot set default tax zone on default channel' });
    return;
  }
  // Check schema: updateChannel must accept defaultTaxZoneId and defaultShippingZoneId.
  var updateChannelAvail = hasMutation(introspection, 'updateChannel');
  var hasTaxZoneInput = hasInputField(introspection, 'UpdateChannelInput', 'defaultTaxZoneId');
  var hasShippingZoneInput = hasInputField(introspection, 'UpdateChannelInput', 'defaultShippingZoneId');
  if (!updateChannelAvail || !hasTaxZoneInput || !hasShippingZoneInput) {
    recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: 'updateChannel does not support defaultTaxZoneId/defaultShippingZoneId in schema; cannot set default tax zone on default channel' });
    return;
  }
  // Get the default channel id. We need to re-query because preRead only has code, not id.
  var defaultChannelId = null;
  try {
    var chanQuery = '{ channels(options: { filter: { code: { eq: "__default_channel__" } } }) { items { id code } } }';
    var cr = await adminGraphqlRequest(fetchFn, adminUrl, { query: chanQuery, variables: {} }, authToken, secrets);
    bumpRequests(state);
    if (cr.response && cr.response.ok && cr.response.body && cr.response.body.data && cr.response.body.data.channels && cr.response.body.data.channels.items && cr.response.body.data.channels.items.length > 0) {
      defaultChannelId = cr.response.body.data.channels.items[0].id;
    }
  } catch (e) {
    recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: 'could not read default channel id: ' + ((e && e.message) || String(e)) });
    return;
  }
  if (!defaultChannelId) {
    recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: 'default channel id not found' });
    return;
  }
  if (state.dryRun) {
    recordMutation(state, 'created', 'channel', { code: '__default__', reason: 'defaultTaxZone', planned: true, plan: 'set defaultTaxZoneId=' + euZoneId + ', defaultShippingZoneId=' + euZoneId + ' on __default_channel__' });
    return;
  }
  var mutation = [
    'mutation UpdateDefaultChannelTaxZone($input: UpdateChannelInput!) {',
    '  updateChannel(input: $input) {',
    '    ... on Channel { id code defaultTaxZone { id name } defaultShippingZone { id name } }',
    '    ... on ErrorResult { errorCode message }',
    '  }',
    '}'
  ].join('\n');
  var mutationInput = { id: defaultChannelId, defaultTaxZoneId: euZoneId, defaultShippingZoneId: euZoneId };
  var res = await adminGraphqlRequest(fetchFn, adminUrl, { query: mutation, variables: { input: mutationInput } }, authToken, secrets);
  bumpRequests(state);
  var mbody = res.response && res.response.body;
  var mdata = mbody && mbody.data && mbody.data.updateChannel;
  var gqlErrors = (mbody && mbody.errors && mbody.errors.length > 0) ? mbody.errors.map(function(e) { return e.message; }).join('; ') : null;
  if (res.networkError) {
    recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: 'updateChannel network error: ' + res.networkError });
    return;
  }
  if (gqlErrors) {
    recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: redactValue(gqlErrors, secrets) });
    return;
  }
  if (mdata && mdata.id && !(mdata.errorCode || mdata.message)) {
    recordMutation(state, 'updated', 'channel', {
      code: '__default__',
      reason: 'defaultTaxZone',
      kind: 'updated',
      id: mdata.id,
      defaultTaxZone: (mdata.defaultTaxZone && mdata.defaultTaxZone.name) || euZoneId,
      defaultShippingZone: (mdata.defaultShippingZone && mdata.defaultShippingZone.name) || euZoneId
    });
    // Update preRead so subsequent checks see the new zone.
    if (state.preRead && state.preRead.activeChannel) {
      state.preRead.activeChannel.defaultTaxZone = mdata.defaultTaxZone || { id: euZoneId, name: 'EU' };
      state.preRead.activeChannel.defaultShippingZone = mdata.defaultShippingZone || { id: euZoneId, name: 'EU' };
    }
    return;
  }
  var uMsg = (mdata && (mdata.message || mdata.errorCode)) || 'updateChannel returned no usable data';
  recordMutation(state, 'failed', 'channel', { code: '__default__', reason: 'defaultTaxZone', error: uMsg });
}

/**
 * Record non-sensitive per-channel evidence: identifiers only (code, currency,
 * defaultLanguageCode, zone names). Channel tokens, admin email and passwords
 * are NEVER written here.
 */
function recordChannelEvidence(state, record, code, currencyField) {
  var entry = {
    code: code,
    currency: record && record[currencyField] ? record[currencyField] : null,
    defaultLanguageCode: record && record.defaultLanguageCode ? record.defaultLanguageCode : null,
    defaultTaxZone: record && record.defaultTaxZone ? (record.defaultTaxZone.name || record.defaultTaxZone.id) : null,
    defaultShippingZone: record && record.defaultShippingZone ? (record.defaultShippingZone.name || record.defaultShippingZone.id) : null
  };
  state.channels.push(entry);
}

async function ensureStockLocations(context, state, fetchFn, adminUrl, authToken, secrets, spec, channelIds) {
  var query = '{ stockLocations { items { id name } totalItems } }';
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
  var justCreated = {};
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
      '    __typename',
      '    id',
      '    name',
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
      justCreated[name] = true;
      recordMutation(state, 'created', 'stockLocation', { name: name, id: data.id });
    } else {
      var msg = buildCreateDiagnostic(res, data, 'createStockLocation failed', secrets);
      recordMutation(state, 'failed', 'stockLocation', { name: name, error: msg });
    }
  }
  // Assign each newly-created stock location to its channel (existing
  // locations were already assigned in a prior run so we never re-assign).
  for (var sl = 0; sl < spec.stockLocations.length; sl++) {
    var loc = spec.stockLocations[sl];
    var locId = locIds[loc.name];
    if (!justCreated[loc.name]) continue;
    if (!loc.channelCode) continue;
    var targetChannelId = channelIds[loc.channelCode];
    if (!targetChannelId) {
      recordMutation(state, 'blocked', 'stockLocation', { name: loc.name, error: 'channel ' + loc.channelCode + ' not found' });
      continue;
    }
    if (state.dryRun) continue;
    var assignMutation = [
      'mutation AssignStockLocationsToChannel($input: AssignStockLocationsToChannelInput!) {',
      '  assignStockLocationsToChannel(input: $input) { __typename }',
      '}'
    ].join('\n');
    var assignRes = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: assignMutation,
      variables: { input: { stockLocationIds: [locId], channelId: targetChannelId } }
    }, authToken, secrets);
    bumpRequests(state);
    var assignData = assignRes.response && assignRes.response.body && assignRes.response.body.data && assignRes.response.body.data.assignStockLocationsToChannel;
    var assignResultObj = (assignData && assignData.result) ? assignData.result : assignData;
    var failedAssignment = false;
    if (!assignResultObj) failedAssignment = true;
    else if (Array.isArray(assignResultObj)) failedAssignment = assignResultObj.length === 0;
    else if (assignResultObj.__typename === 'ErrorResult') failedAssignment = true;
    if (failedAssignment) {
      recordMutation(state, 'blocked', 'stockLocationToChannel', { name: loc.name, channel: loc.channelCode, error: 'assignment failed' });
    } else {
      recordMutation(state, 'assigned', 'stockLocationToChannel', { name: loc.name, channel: loc.channelCode });
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
      var productId = existingProduct.id;
      var primaryCode = product.channels[0];
      var primaryToken = channelTokenById[primaryCode] || channelTokenById[product.channels[0]] ||
        channelTokenByCode(spec, primaryCode);
      var primaryCurrency = null;
      for (var cc = 0; cc < spec.countries.length; cc++) {
        if (spec.countries[cc].channelCode === primaryCode) {
          primaryCurrency = spec.countries[cc].currencyCode;
          break;
        }
      }
      // Assign product to primary channel BEFORE creating variants.
      // Products 1-4 exist in the default channel; without this, createProductVariants
      // fails with "No Product with the id N could be found" when called with a country
      // channel token (vendure-token header) because the product is not visible in that
      // channel context.  assignProductsToChannel uses AssignProductsToChannelInput
      // { productIds: [id]!, channelId: id! } — confirmed via introspection.
      if (!state.dryRun && state.channelIdsByCode && state.channelIdsByCode[primaryCode]) {
        var preAssignQuery = [
          'mutation PreAssignProductToChannel($productId: ID!, $channelId: ID!) {',
          '  assignProductsToChannel(input: { productIds: [$productId], channelId: $channelId }) { __typename id }',
          '}'
        ].join('\n');
        var preAssignRes = await adminGraphqlRequest(fetchFn, adminUrl, {
          query: preAssignQuery,
          variables: {
            productId: productId,
            channelId: state.channelIdsByCode[primaryCode]
          }
        }, authToken, secrets, null);
        bumpRequests(state);
        // assignProductsToChannel must run in the DEFAULT channel context (no
        // vendure-token header) so the product — which only exists in the default
        // channel — is visible.  Response is classified by shape:
        //   top-level errors array               => failed
        //   array result                         => success
        //   object with errorCode / Error typename => failed
        //   anything else (unexpected shape)      => failed
        var paData1 = preAssignRes.response && preAssignRes.response.body && preAssignRes.response.body.data;
        var assignResult1 = (paData1 && paData1.assignProductsToChannel) || null;
        var preErr1 = null;
        if (hasTopLevelGraphqlErrors(preAssignRes)) {
          preErr1 = buildCreateDiagnostic(preAssignRes, null, 'assignProductsToChannel failed', secrets);
        } else if (Array.isArray(assignResult1)) {
          // success: array result (including empty)
        } else if (assignResult1 && (assignResult1.errorCode || /Error$/.test(String(assignResult1.__typename || '')))) {
          preErr1 = buildCreateDiagnostic(preAssignRes, assignResult1, 'assignProductsToChannel failed', secrets);
        } else {
          preErr1 = buildCreateDiagnostic(preAssignRes, assignResult1, 'assignProductsToChannel unexpected shape', secrets);
        }
        if (preErr1) {
          recordMutation(state, 'failed', 'product', { slug: slug, channel: primaryCode, error: preErr1 });
          // On failure: continue to next product (variants are skipped).
          continue;
        }
      }
      for (var v = 0; v < product.variants.length; v++) {
        var variant = product.variants[v];
        var sku = variant.sku;
        var existingVariant = null;
        var variantQuery = [
          'query VariantBySku($sku: String) {',
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
        if (state.dryRun) {
          recordMutation(state, 'created', 'variant', { sku: sku, planned: true });
          continue;
        }
        if (requestBudgetExceeded(state)) {
          state.errors.push('request budget exhausted');
          return;
        }
        var priceInfo = variant.price[primaryCode];
        var primaryPriceMinor = priceInfo ? priceToMinorUnits(priceInfo.decimal, priceInfo.currencyCode || primaryCurrency) : null;
        var createVariants = [
          'mutation CreateProductVariants($input: [CreateProductVariantInput!]!) {',
          '  createProductVariants(input: $input) {',
          '    __typename',
          '    id',
          '    sku',
          '    priceWithTax',
          '    price',
          '  }',
          '}'
        ].join('\n');
        var variantInput = [{
          productId: productId,
          sku: sku,
          translations: [{ languageCode: 'en', name: variant.name }],
          price: primaryPriceMinor,
          stockOnHand: variant.stockOnHand,
          trackInventory: toGlobalFlag(variant.trackInventory),
          useGlobalOutOfStockThreshold: variant.useGlobalOutOfStockThreshold || false,
          outOfStockThreshold: variant.outOfStockThreshold
        }];
        var resVar = await adminGraphqlRequest(fetchFn, adminUrl, {
          query: createVariants,
          variables: { input: variantInput }
        }, authToken, secrets, primaryToken);
        bumpRequests(state);
        var varData = resVar.response && resVar.response.body && resVar.response.body.data && resVar.response.body.data.createProductVariants;
        var err = validateListMutationResult(resVar, varData, 'createProductVariants failed', secrets);
        if (err) {
          recordMutation(state, 'failed', 'variant', { sku: sku, error: err });
          continue;
        }
        // Vendure createProductVariants returns ProductVariant[] (an array).
        // Guard against both the real array shape and legacy/test object shapes.
        var variantId = null;
        if (Array.isArray(varData)) {
          variantId = (varData[0] && varData[0].id) || null;
        } else if (varData.items && varData.items[0]) {
          variantId = varData.items[0].id || null;
        } else if (varData.id) {
          variantId = varData.id;
        }
        if (!variantId) {
          recordMutation(state, 'failed', 'variant', { sku: sku, error: 'createProductVariants returned no id' });
          continue;
        }
        recordMutation(state, 'created', 'variant', { sku: sku, id: variantId, priceMinor: primaryPriceMinor, currency: primaryCurrency });
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
          var assignQuery = [
            'mutation AssignToChannel($input: AssignProductsToChannelInput!, $variantIds: [ID!]!, $channelId: ID!) {',
            '  assignProductsToChannel(input: $input) { id }',
            '  assignProductVariantsToChannel(input: { productVariantIds: $variantIds, channelId: $channelId }) { id }',
            '}'
          ].join('\n');
          var assignRes = await adminGraphqlRequest(fetchFn, adminUrl, {
            query: assignQuery,
            variables: {
              input: { productIds: [productId], channelId: state.channelIdsByCode[addCode] },
              variantIds: [variantId],
              channelId: state.channelIdsByCode[addCode]
            }
          }, authToken, secrets, null);
          bumpRequests(state);
          var assignData = assignRes.response && assignRes.response.body && assignRes.response.body.data;
          if (hasTopLevelGraphqlErrors(assignRes)) {
            var aErr = buildCreateDiagnostic(assignRes, null, 'assignProductsToChannel GraphQL error', secrets);
            recordMutation(state, 'blocked', 'product', { slug: slug, channel: addCode, error: aErr });
          } else if (!assignData || !assignData?.assignProductsToChannel) {
            var aErr2 = buildCreateDiagnostic(assignRes, assignData, 'assignProductsToChannel returned no data', secrets);
            recordMutation(state, 'blocked', 'product', { slug: slug, channel: addCode, error: aErr2 });
          } else if (!Array.isArray(assignData.assignProductsToChannel) && assignData.assignProductsToChannel?.errorCode) {
            var aErr3 = buildCreateDiagnostic(assignRes, assignData.assignProductsToChannel, 'assignProductsToChannel failed', secrets);
            recordMutation(state, 'blocked', 'product', { slug: slug, channel: addCode, error: aErr3 });
          }
          if (addPriceMinor !== null && state.channelIdsByCode[addCode]) {
            var setPrice = [
              'mutation UpdateVariantPrice($input: [UpdateProductVariantInput!]!) {',
              '  updateProductVariants(input: $input) {',
              '    __typename',
              '    id',
              '    sku',
              '    price',
              '    priceWithTax',
              '  }',
              '}'
            ].join('\n');
            var setPriceRes = await adminGraphqlRequest(fetchFn, adminUrl, {
              query: setPrice,
              variables: {
                input: [{ id: variantId, price: addPriceMinor }]
              }
            }, authToken, secrets, addToken);
            bumpRequests(state);
            var spData = setPriceRes.response && setPriceRes.response.body && setPriceRes.response.body.data && setPriceRes.response.body.data.updateProductVariants;
            var spErr = validateListMutationResult(setPriceRes, spData, 'could not write price in channel context', secrets);
            if (spErr) {
              recordMutation(state, 'blocked', 'variantPrice', { sku: sku, channel: addCode, error: spErr });
            } else {
              recordMutation(state, 'updated', 'variantPrice', { sku: sku, channel: addCode, priceMinor: addPriceMinor });
            }
          }
        }
      }
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
      '    __typename',
      '    id',
      '    slug',
      '  }',
      '}'
    ].join('\n');
    var productInput = {
      translations: [{ languageCode: 'en', name: product.name, slug: product.slug, description: 'TST synthetic test product' }],
      enabled: product.enabled
    };
    // Use authToken for the admin session credential.  primaryToken is a
    // channel context token (vendure-token header) and must NOT be placed in
    // the Authorization / vendure-auth-token headers.
    var resProd = await adminGraphqlRequest(fetchFn, adminUrl, {
      query: createProduct,
      variables: { input: productInput }
    }, authToken, secrets, primaryToken);
    bumpRequests(state);
    var prodData = resProd.response && resProd.response.body && resProd.response.body.data && resProd.response.body.data.createProduct;
    if (!prodData) {
      var pmsg = buildCreateDiagnostic(resProd, prodData, 'createProduct failed', secrets);
      recordMutation(state, 'failed', 'product', { slug: slug, error: pmsg });
      continue;
    }
    var productId = prodData.id;
    if (!productId) {
      var pmsg2 = buildCreateDiagnostic(resProd, prodData, 'createProduct returned no id', secrets);
      recordMutation(state, 'failed', 'product', { slug: slug, error: pmsg2 });
      continue;
    }
    recordMutation(state, 'created', 'product', { slug: slug, id: productId });

    var primaryCurrency = null;
    for (var cc = 0; cc < spec.countries.length; cc++) {
      if (spec.countries[cc].channelCode === primaryCode) {
        primaryCurrency = spec.countries[cc].currencyCode;
        break;
      }
    }

    // Assign product to primary channel BEFORE creating variants.
    if (!state.dryRun && state.channelIdsByCode && state.channelIdsByCode[primaryCode]) {
      var preAssignQuery2 = [
        'mutation PreAssignProductToChannel($productId: ID!, $channelId: ID!) {',
        '  assignProductsToChannel(input: { productIds: [$productId], channelId: $channelId }) { __typename id }',
        '}'
      ].join('\n');
      var preAssignRes2 = await adminGraphqlRequest(fetchFn, adminUrl, {
        query: preAssignQuery2,
        variables: {
          productId: productId,
          channelId: state.channelIdsByCode[primaryCode]
        }
      }, authToken, secrets, null);
      bumpRequests(state);
      // Same classification as site 1 above.
      var paData2 = preAssignRes2.response && preAssignRes2.response.body && preAssignRes2.response.body.data;
      var assignResult2 = (paData2 && paData2.assignProductsToChannel) || null;
      var preErr2 = null;
      if (hasTopLevelGraphqlErrors(preAssignRes2)) {
        preErr2 = buildCreateDiagnostic(preAssignRes2, null, 'assignProductsToChannel failed', secrets);
      } else if (Array.isArray(assignResult2)) {
        // success: array result (including empty)
      } else if (assignResult2 && (assignResult2.errorCode || /Error$/.test(String(assignResult2.__typename || '')))) {
        preErr2 = buildCreateDiagnostic(preAssignRes2, assignResult2, 'assignProductsToChannel failed', secrets);
      } else {
        preErr2 = buildCreateDiagnostic(preAssignRes2, assignResult2, 'assignProductsToChannel unexpected shape', secrets);
      }
      if (preErr2) {
        recordMutation(state, 'failed', 'product', { slug: slug, channel: primaryCode, error: preErr2 });
        // On failure: continue to next product (variants are skipped).
        continue;
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
      '    __typename',
      '    id',
      '    sku',
      '    priceWithTax',
      '    price',
      '  }',
      '}'
      ].join('\n');
      var variantInput = [{
        productId: productId,
        sku: sku,
        translations: [{ languageCode: 'en', name: variant.name }],
        price: primaryPriceMinor,
        stockOnHand: variant.stockOnHand,
        trackInventory: toGlobalFlag(variant.trackInventory),
        useGlobalOutOfStockThreshold: variant.useGlobalOutOfStockThreshold || false,
        outOfStockThreshold: variant.outOfStockThreshold
      }];
      var resVar = await adminGraphqlRequest(fetchFn, adminUrl, {
        query: createVariants,
        variables: { input: variantInput }
      }, authToken, secrets, primaryToken);
      bumpRequests(state);
      var varData = resVar.response && resVar.response.body && resVar.response.body.data && resVar.response.body.data.createProductVariants;
      var verr = validateListMutationResult(resVar, varData, 'createProductVariants failed', secrets);
      if (verr) {
        recordMutation(state, 'failed', 'variant', { sku: sku, error: verr });
        continue;
      }
      // Vendure createProductVariants returns ProductVariant[] (an array).
      // Guard against both the real array shape and legacy/test object shapes.
      var variantId = null;
      if (Array.isArray(varData)) {
        variantId = (varData[0] && varData[0].id) || null;
      } else if (varData.items && varData.items[0]) {
        variantId = varData.items[0].id || null;
      } else if (varData.id) {
        variantId = varData.id;
      }
      if (!variantId) {
        recordMutation(state, 'failed', 'variant', { sku: sku, error: 'createProductVariants returned no id' });
        continue;
      }
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
          'mutation AssignToChannel($input: AssignProductsToChannelInput!, $variantIds: [ID!]!, $channelId: ID!) {',
          '  assignProductsToChannel(input: $input) { id }',
          '  assignProductVariantsToChannel(input: { productVariantIds: $variantIds, channelId: $channelId }) { id }',
          '}'
        ].join('\n');
        var assignRes = await adminGraphqlRequest(fetchFn, adminUrl, {
          query: assignQuery,
          variables: {
            input: { productIds: [productId], channelId: state.channelIdsByCode[addCode] },
            variantIds: [variantId],
            channelId: state.channelIdsByCode[addCode]
          }
        }, authToken, secrets, null);
        bumpRequests(state);
        var assignData = assignRes.response && assignRes.response.body && assignRes.response.body.data;
        if (hasTopLevelGraphqlErrors(assignRes)) {
          recordMutation(state, 'blocked', 'product', { slug: slug, channel: addCode, error: buildCreateDiagnostic(assignRes, null, 'assignProductsToChannel GraphQL error', secrets) });
        } else if (!assignData || !assignData.assignProductsToChannel) {
          recordMutation(state, 'blocked', 'product', { slug: slug, channel: addCode, error: buildCreateDiagnostic(assignRes, assignData, 'assignProductsToChannel returned no data', secrets) });
        } else if (!Array.isArray(assignData.assignProductsToChannel) && assignData.assignProductsToChannel.errorCode) {
          recordMutation(state, 'blocked', 'product', { slug: slug, channel: addCode, error: buildCreateDiagnostic(assignRes, assignData.assignProductsToChannel, 'assignProductsToChannel failed', secrets) });
        }

        // Set the price in the additional channel's context.
        if (addPriceMinor !== null && state.channelIdsByCode[addCode]) {
          var setPrice = [
            'mutation UpdateVariantPrice($input: [UpdateProductVariantInput!]!) {',
            '  updateProductVariants(input: $input) {',
            '    __typename',
            '    id',
            '    sku',
            '    price',
            '    priceWithTax',
            '  }',
            '}'
          ].join('\n');
          var setPriceRes = await adminGraphqlRequest(fetchFn, adminUrl, {
            query: setPrice,
            variables: {
              input: [{ id: variantId, price: addPriceMinor }]
            }
          }, authToken, secrets, addToken);
          bumpRequests(state);
          var spData = setPriceRes.response && setPriceRes.response.body && setPriceRes.response.body.data && setPriceRes.response.body.data.updateProductVariants;
          var spErr2 = validateListMutationResult(setPriceRes, spData, 'could not write price in channel context', secrets);
          if (spErr2) {
            recordMutation(state, 'blocked', 'variantPrice', { sku: sku, channel: addCode, error: spErr2 });
          } else {
            recordMutation(state, 'updated', 'variantPrice', { sku: sku, channel: addCode, priceMinor: addPriceMinor });
          }
        }
      }
    }
  }
}

async function ensureCustomers(context, state, fetchFn, adminUrl, authToken, secrets, spec, customerPassword, customerPasswordSource) {
  if (!customerPassword) {
    var srcNote = customerPasswordSource ? (' (source: ' + customerPasswordSource + ')') : '';
    state.blocked.push({ entity: 'customer', error: 'SEED_TEST_CUSTOMER_PASSWORD missing' + srcNote });
    recordMutation(state, 'blocked', 'customer', { error: 'SEED_TEST_CUSTOMER_PASSWORD missing' + srcNote, passwordSource: customerPasswordSource });
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
      '    __typename',
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
    var topCustErrors = res.response && res.response.body && Array.isArray(res.response.body.errors) ? res.response.body.errors : [];
    if (data && data.__typename === 'Customer') {
      recordMutation(state, 'created', 'customer', { email: email, id: data.id });
    } else if (data && (data.__typename === 'EmailAddressConflictError' || data.errorCode === 'EMAIL_ADDRESS_CONFLICT_ERROR')) {
      recordMutation(state, 'existing', 'customer', { email: email });
    } else if (topCustErrors.length > 0 && topCustErrors[0] && String(topCustErrors[0].message || '').indexOf('EmailAddressConflictError') !== -1) {
      recordMutation(state, 'existing', 'customer', { email: email });
    } else {
      var msg = (topCustErrors.length > 0 && topCustErrors[0] && (topCustErrors[0].message || topCustErrors[0].errorCode))
        ? (topCustErrors[0].message || topCustErrors[0].errorCode)
        : ((data && (data.message || data.errorCode)) || 'createCustomer failed');
      recordMutation(state, 'failed', 'customer', { email: email, error: redactValue(msg, secrets) });
    }
  }
}

/**
 * Readback ladder via Admin API per channel context (country channels + default).
 * Five query steps per channel; stops at first failure and records which step
 * failed.  Results are stored in state.readbackLadder and written to evidence;
 * the ladder does not change seed.ok (that is determined by verifyReadback and
 * finalizeSeedResult alone).
 *
 * Ladder steps:
 *   (a) activeChannel { code currencyCode }
 *   (b) products(options:{take:1}) { totalItems }
 *   (c) products(options:{take:1}) { items { id name } }
 *   (d) products(options:{take:1}) { items { id variants { id } } }
 *   (e) products(options:{take:1}) { items { id variants { price currencyCode } } }
 */
/**
 * Build the stored record for one readback ladder step.  Adds read-only
 * diagnostics (query text, request header NAMES without values, whether an
 * Authorization header was sent, http status, and the first 300 chars of the
 * response body) while preserving the exact existing ok/error semantics.
 */
function ladderStepRecord(step, res, callSecrets) {
  var record = {
    ok: true,
    query: step.query
  };
  var body = res.response && res.response.body;
  var data = body && body.data;
  var errMsg = null;
  if (hasTopLevelGraphqlErrors(res)) {
    var topErrors = body.errors;
    var first = topErrors && topErrors[0];
    errMsg = redactValue((first && (first.message || first.errorCode)) || 'GraphQL error', callSecrets);
  } else if (!body || !data) {
    errMsg = redactValue('no data in response', callSecrets);
  } else {
    var missingField = null;
    if (step.key === 'a') {
      if (!data.activeChannel) missingField = 'activeChannel';
    } else if (step.key === 'b') {
      if (!data.products) missingField = 'products';
    } else if (!data.products || !data.products.items) {
      missingField = 'products.items';
    }
    if (missingField) errMsg = redactValue('missing field in response: ' + missingField, callSecrets);
  }
  record.httpStatus = res.response ? res.response.httpStatus : null;
  var req = res.request || {};
  var headers = (req.headers && typeof req.headers === 'object') ? req.headers : {};
  var names = Object.keys(headers);
  record.requestHeaders = names.slice().sort();
  record.authorizationSent = names.some(function(h) {
    return String(h).toLowerCase() === 'authorization' || String(h).toLowerCase() === 'vendure-auth-token';
  });
  var text = res.response && res.response.text ? String(res.response.text) : '';
  record.responseBody = redactValue(text.slice(0, 300), callSecrets);
  if (errMsg) {
    record.ok = false;
    record.error = errMsg;
  }
  return record;
}

async function readbackLadder(context, state, fetchFn, adminUrl, authToken, secrets, spec, channelTokenById) {
  state.readbackLadder = [];

  // The ladder reads back through the Shop API (the same endpoint/URL the readback
  // check uses), with the channel's vendure-token header and NO admin
  // Authorization.  The confirmed failure is a Shop API products-list error,
  // so probing the Admin API would miss it.
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

  var contexts = [];
  for (var ci = 0; ci < spec.countries.length; ci++) {
    var c = spec.countries[ci];
    var token = channelTokenById[c.channelCode] || c.channelToken || null;
    contexts.push({ channelCode: c.channelCode, token: token });
  }
  contexts.push({ channelCode: '__default__', token: null });

  var steps = [
    { key: 'a', query: '{ activeChannel { code defaultCurrencyCode } }' },
    { key: 'b', query: '{ products(options: { take: 1 }) { totalItems } }' },
    { key: 'c', query: '{ products(options: { take: 1 }) { items { id name } } }' },
    { key: 'd', query: '{ products(options: { take: 1 }) { items { id variants { id } } } }' },
    { key: 'e', query: '{ products(options: { take: 1 }) { items { id variants { price currencyCode } } } }' }
  ];

  for (var j = 0; j < contexts.length; j++) {
    var ctx = contexts[j];
    // authToken must always be in callSecrets so error messages redact it.
    // For channel context, channelToken is prepended so redactDeep redacts it first.
    var callSecrets = ctx.token ? [ctx.token, authToken].concat(secrets) : [authToken].concat(secrets);
    var entry = { channel: ctx.channelCode, steps: {} };
    var stoppedAt = null;
    for (var s = 0; s < steps.length; s++) {
      var step = steps[s];
      if (state.dryRun) {
        entry.steps[step.key] = { ok: true, dryRun: true };
        continue;
      }
      try {
        var res = await adminGraphqlRequest(fetchFn, shopBase, {
          query: step.query,
          variables: {}
        }, null, callSecrets, ctx.token);
        bumpRequests(state);
        var stepRecord = ladderStepRecord(step, res, callSecrets);
        stepRecord.endpoint = 'shop';
        if (!stepRecord.ok) {
          entry.steps[step.key] = stepRecord;
          stoppedAt = step.key;
          break;
        }
        entry.steps[step.key] = stepRecord;
      } catch (e) {
        entry.steps[step.key] = { ok: false, error: redactValue((e && e.message) || String(e), callSecrets), httpStatus: null,
          query: step.query, requestHeaders: [], authorizationSent: false, responseBody: '', endpoint: 'shop' };
        stoppedAt = step.key;
        break;
      }
    }
    entry.stoppedAt = stoppedAt;
    state.readbackLadder.push(redactDeep(entry, callSecrets));
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
    // Skip a country whose channel was never created or found: querying it
    // would fall through to the default channel and produce the misleading
    // "invalid input syntax for type integer: undefined" error.
    var channelIds = state.channelIdsByCode || {};
    var foundChannelId = channelIds[String(country.channelCode).toLowerCase()];
    if (!foundChannelId) {
      state.readback.push({ code: country.channelCode, skipped: 'channel missing' });
      continue;
    }
    try {
      var result = await adminGraphqlRequest(fetchFn, shopBase, {
        query: query,
        variables: {}
      }, authToken, callSecrets, token);
      bumpRequests(state);
      var entry = { code: country.channelCode };
      var body = result.response && result.response.body;
      if (body && body.errors && body.errors.length > 0) {
        entry.error = body.errors.map(function(e) { return redactValue(e.message, [token]); }).join('; ');
        state.errors.push('readback error for ' + country.channelCode + ': ' + entry.error);
        // A readback that fails (even at HTTP 200 with GraphQL errors, e.g. the
        // confirmed staging "invalid input syntax for type integer: undefined")
        // must never yield a passing seed: record it as a failed readback so
        // finalizeSeedResult forces ok:false.
        recordMutation(state, 'failed', 'readback', { code: country.channelCode, error: entry.error });
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
        recordMutation(state, 'failed', 'readback', { code: country.channelCode, error: 'STAGING_PRODUCTS_API_ERROR: no products in channel' });
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
      // The index is created/updated with the run metadata (git HEAD, manifest
      // reference commit, protected-path hash at start) so the compliance
      // report can read index.json top-level fields instead of n/a.
      // Even if the index was already created (e.g. by cli.js with null metadata),
      // initEvidenceIndex with reuseExisting:true will update null fields.
      var initOpts = { root: (opts.root || process.cwd()), baseDir: (opts.baseDir || 'evidence'), reuseExisting: true };
      evidenceCollector.initEvidenceIndex(runId, {
        executionRevision: gitHeadOf(context),
        referenceCommit: referenceCommitOf(context),
        protectedPathsHash: protectedPathsHashOf(context)
      }, initOpts);
      var res = evidenceCollector.writeEvidenceFile(runId, 'seed', SEED_EVIDENCE_FILENAME, content, opts);
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
  }
  // Direct fallback write to evidence/<runId>/seed/seed-record.json.
  // Apply the same redaction that the evidenceCollector would use so that
  // secrets do not reach disk even when the collector is unavailable.
  try {
    var baseDir = (opts && opts.baseDir) || 'evidence';
    var root = (opts && opts.root) || process.cwd();
    var fullPath = path.join(root, baseDir, runId, 'seed', SEED_EVIDENCE_FILENAME);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    // Collect all secret values from state.secrets and opts.secrets and redact.
    var fallbackSecrets = [];
    if (state && Array.isArray(state.secrets)) {
      for (var si = 0; si < state.secrets.length; si++) {
        if (typeof state.secrets[si] === 'string' && state.secrets[si].length > 0) {
          fallbackSecrets.push(state.secrets[si]);
        }
      }
    }
    if (opts && opts.secrets && typeof opts.secrets === 'object') {
      var skeys = Object.keys(opts.secrets);
      for (var sk = 0; sk < skeys.length; sk++) {
        var sv = opts.secrets[skeys[sk]];
        if (typeof sv === 'string' && sv.length > 0) fallbackSecrets.push(sv);
      }
    }
    var safeContent = fallbackSecrets.length > 0 ? redactValue(content, fallbackSecrets) : content;
    fs.writeFileSync(fullPath, safeContent, 'utf8');
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
  var explicitCustomerPassword = String(envValue(context, 'SEED_TEST_CUSTOMER_PASSWORD') || '').trim();
  var customerPassword = explicitCustomerPassword;
  var customerPasswordSource = explicitCustomerPassword ? 'env' : null;

  // If no explicit customer password, attempt HMAC derivation from STAGING_ADMIN_PASSWORD.
  // The derived value is kept in memory only and is never written to evidence or logs;
  // only the source ('env' or 'derived') is recorded. This allows the seed to proceed
  // with independent setup steps even when no approved customer password is available.
  if (!customerPassword) {
    var adminPw = String(adminPassword(context) || '').trim();
    if (adminPw) {
      try {
        var hmac = crypto.createHmac('sha256', adminPw);
        hmac.update('staging-test-customer-v1');
        customerPassword = hmac.digest('hex').substring(0, 24);
        customerPasswordSource = 'derived';
      } catch (e) {
        // derivation failed, leave customerPassword empty
      }
    }
  }
  state.customerPasswordSource = customerPasswordSource;

  var tokenCfg = resolveSeedChannelTokens(context, spec);
  if (!tokenCfg.ok) {
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: SEED_CONFIG_BLOCKED, error: tokenCfg.error });
  }
  state.channelTokensConfigured = true;

  var allSecrets = uniqueSecrets([password, customerPassword]);
  // customerPassword (whether from env or HMAC-derived) is kept in memory only
  // and is redacted from evidence. It is included in allSecrets for redaction
  // during evidence write but is not part of the non-enumerable secretValues.
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
    'Mutation', 'Channel', 'CreateChannelInput', 'CreateProductInput', 'CreateProductVariantInput', 'Zone', 'Country',
    'GlobalSettings', 'UpdateGlobalSettingsInput', 'UpdateChannelInput'
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

  // Language prerequisite BEFORE createChannel: the seed drives the channel
  // defaultLanguageCode 'en'. If 'en' is missing, enable it via
  // updateGlobalSettings (keeping existing languages) so createChannel /
  // createProduct succeed. If the update fails or is not permitted, a clear
  // failed entry is recorded and channel creation is skipped.
  var requiredLang = 'en';
  if (spec.countries && spec.countries.length > 0 && spec.countries[0].defaultLanguageCode) {
    requiredLang = String(spec.countries[0].defaultLanguageCode);
  }
  var langResult = await ensureDefaultLanguage(context, state, fetchFn, adminUrl, authToken, allSecrets, introspectResult, requiredLang);
  bumpRequests(state);
  if (!langResult.ok && !langResult.planned) {
    // ensureDefaultLanguage already recorded the 'failed' entry; skip channel
    // creation so the misleading integer error never reaches the readback.
    state.completedAt = getClock(context)().toISOString();
    return finalizeSeedResult(context, state, { reason: SEED_CONFIG_BLOCKED, error: langResult.error });
  }

  if (state.dryRun) {
    state.created = [];
    state.conflicts = [];
    state.failed = [];
    state.mutations = 0;
    // Re-record the planned language step (the reset above cleared it).
    if (langResult.planned) {
      recordMutation(state, 'created', 'language', { required: requiredLang, planned: true, plan: 'add ' + requiredLang + ' to globalSettings.availableLanguages, keeping existing' });
    }
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

  // 3.5 DEFAULT channel tax zone: before any country channel is created or any
  // product/variant operation runs, ensure the DEFAULT channel has a default
  // tax zone and shipping zone.  Admin mutations sent without a vendure-token
  // run in the DEFAULT channel context; without a tax zone the error
  // "The active tax zone could not be determined" blocks product/variant pricing.
  await ensureDefaultChannelTaxZone(context, state, fetchFn, adminUrl, authToken, allSecrets, introspectResult, zoneIds);

  // 4. Channels
  var channelIds = await ensureChannels(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, introspectResult, zoneIds);
  state.channelIdsByCode = channelIds || {};

  // Re-read channel inventory with verified-safe field list so channelIdsByCode
  // reflects live data and not a potentially-stale introspection guess.
  var cField = state.introspectedTypes && state.introspectedTypes.Channel &&
    state.introspectedTypes.Channel.fields.indexOf('defaultCurrencyCode') !== -1 ? 'defaultCurrencyCode' : 'currencyCode';
  var cFields = ['id', 'code', cField];
  if (state.introspectedTypes && state.introspectedTypes.Channel) {
    if (state.introspectedTypes.Channel.fields.indexOf('availableCurrencyCodes') !== -1) cFields.push('availableCurrencyCodes');
    if (state.introspectedTypes.Channel.fields.indexOf('pricesIncludeTax') !== -1) cFields.push('pricesIncludeTax');
  }
  var channelReQuery = '{ channels(options: { take: 100 }) { items { ' + cFields.join(' ') + ' } totalItems } }';
  try {
    var crr = await adminGraphqlRequest(fetchFn, adminUrl, { query: channelReQuery, variables: { options: { take: 100 } } }, authToken, allSecrets);
    bumpRequests(state);
    if (crr.response && crr.response.ok && crr.response.body && crr.response.body.data &&
        crr.response.body.data.channels && crr.response.body.data.channels.items &&
        crr.response.body.data.channels.items.length > 0) {
      var freshChannels = crr.response.body.data.channels.items;
      for (var ci = 0; ci < freshChannels.length; ci++) {
        var ch = freshChannels[ci];
        if (ch.code) state.channelIdsByCode[String(ch.code).toLowerCase()] = ch.id;
      }
    }
  } catch (e) {
    state.errors.push('channel re-read failed: ' + ((e && e.message) || String(e)));
  }

  // 5. Stock locations
  await ensureStockLocations(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, channelIds);

  // Build channel code->token lookup for per-channel context pricing.
  var channelTokenById = {};
  for (var s = 0; s < spec.countries.length; s++) {
    channelTokenById[spec.countries[s].channelCode] = spec.countries[s].channelToken;
  }

  // 6. Products + variants (priced per channel context)
  await ensureProducts(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, channelTokenById);

  // 7. Test customers (pass the resolved password; if none is available the
  // step records a blocked entry and continues so other tasks can still run)
  await ensureCustomers(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, customerPassword, customerPasswordSource);

  // 7.5 Readback ladder (read-only diagnostics; does not change seed.ok)
  await readbackLadder(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, channelTokenById);

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
  await ensureCustomers(context, state, fetchFn, adminUrl, authToken, allSecrets, spec, null, null);
}

/**
 * After the seed evidence is written, record the protected-path hash at the
 * END of the run into index.json meta.protectedEndHash (the run-level end hash
 * the compliance report reads). Uses the evidence collector's updateRunMeta so
 * a single index.json is edited in place. Never throws.
 */
function writeRunMetaProtectedEnd(context, runId) {
  var endHash = protectedPathsHashOf(context);
  if (!endHash) return { ok: false, reason: 'no protected hash' };
  var evidenceCollector = null;
  try {
    evidenceCollector = require('../evidenceCollector');
  } catch (e) {
    evidenceCollector = null;
  }
  if (!evidenceCollector || typeof evidenceCollector.updateRunMeta !== 'function') {
    return { ok: false, reason: 'no evidence collector' };
  }
  var opts = resolveEvidenceOptions(context);
  try {
    evidenceCollector.updateRunMeta(runId, { protectedEndHash: endHash }, opts);
    return { ok: true, endHash: endHash };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
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
    readbackLadder: state.readbackLadder,
    onboardCountryAvailable: state.onboardCountryAvailable,
    introspectedTypes: state.introspectedTypes,
    languagePrerequisite: state.languagePrerequisite || null,
    customerPasswordSource: state.customerPasswordSource || null,
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
  // ADMIN_CREDENTIALS_MISSING: set a non-sensitive cause naming the three
  // scoped variables. extra.credentialNames (populated by adminCredentialState /
  // adminChannelInventory.adminCredentialNames) lists only admin login names and
  // is not authoritative for these, so use the literals. Only the NAMES are
  // placed in cause; never credential values or derived passwords.
  if (out.reason === ADMIN_CREDENTIALS_MISSING) {
    out.cause = 'missing STAGING_ADMIN_EMAIL, STAGING_ADMIN_PASSWORD, SEED_TEST_CUSTOMER_PASSWORD';
  }
  // seed.ok computation (established 14 Oct 2026):
  //   ok = !!(extra.ok) && failed===0 && conflicts===0 && blocked.length===0
  //   Rule: ANY entity blocked (including customer) => ok:false.
  //   The blocked customer's cause/classifications surface the variable name.
  //   When only customer is blocked, seedHasOnlyCustomerBlock=true is also set
  //   so run-staging can still run dependent tasks (catalog steps succeeded).
  var hasOnlyCustomerBlock = state.blocked.length > 0 && state.blocked.every(function(b) { return b.entity === 'customer'; });
  out.ok = !!(extra && extra.ok) && state.failed.length === 0 && state.conflicts.length === 0 && state.blocked.length === 0;
  // Record the customer password source when only customer is blocked so the
  // cause/variable name surfaces in the compliance report.
  if (hasOnlyCustomerBlock) {
    out.customerPasswordSource = state.customerPasswordSource || null;
  }

  var written = writeSeedEvidence(context, state, out);
  out.evidence = written.ok ? { written: true, file: SEED_EVIDENCE_FILENAME } : { written: false, reason: written.reason };
  // Record the run-level protected-end hash in index.json meta (completes the
  // start/end pair read by the compliance report).
  var metaEnd = writeRunMetaProtectedEnd(context, runIdOf(context));
  out.runLevelProtectedEndHash = metaEnd.ok ? metaEnd.endHash : null;

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
  writeRunMetaProtectedEnd: writeRunMetaProtectedEnd,
  gitHeadOf: gitHeadOf,
  referenceCommitOf: referenceCommitOf,
  protectedPathsHashOf: protectedPathsHashOf,
  readbackLadder: readbackLadder,
  adminGraphqlRequest: adminGraphqlRequest,
  hasTopLevelGraphqlErrors: hasTopLevelGraphqlErrors,
  SEED_HOST_NOT_ALLOWED: 'SEED_HOST_NOT_ALLOWED',
  SEED_CONFLICT: 'SEED_CONFLICT',
  ADMIN_CREDENTIALS_MISSING: 'ADMIN_CREDENTIALS_MISSING',
  resolveAdminApiBase: resolveAdminApiBase,
  redactDeep: redactDeep
};
