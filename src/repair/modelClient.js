'use strict';

var BUDGET_MODEL_MAX_TOKENS = 400000;
var SIGNAL_TIMEOUT_MS = 120000;
var DEFAULT_TIMEOUT_MS = 300000;
var MAX_TOKENS = 4000;
var MODEL_CONSTANT = 'z-ai/glm-5.3-flash';
var API_URL = 'https://openrouter.ai/api/v1/chat/completions';
var REDACTED_MARKER = '[REDACTED]';
var MAX_RAW_LOG = 500;
var fetchUtil = require('./fetchUtil');

/**
 * Resolve the configured repair model. REPAIR_MODEL comes first (the env object
 * passed in, then process.env), with the current model as the default.
 */
function resolveConfiguredModel(env) {
  if (env && typeof env.REPAIR_MODEL === 'string' && env.REPAIR_MODEL !== '') return env.REPAIR_MODEL;
  if (typeof process !== 'undefined' && process.env && typeof process.env.REPAIR_MODEL === 'string' && process.env.REPAIR_MODEL !== '') {
    return process.env.REPAIR_MODEL;
  }
  return MODEL_CONSTANT;
}

var BUDGET_SCHEMA = {
  perSignature: 3,
  global: 15,
  bySignature: {},
  total: 0
};

var REASONING_EFFORT = { effort: 'low' };

function consume(budget, signature) {
  if (!budget) return { ok: false, reason: 'no budget' };
  var cost = 1;
  budget.total = (budget.total || 0) + cost;
  if (!budget.bySignature) budget.bySignature = {};
  budget.bySignature[signature] = (budget.bySignature[signature] || 0) + cost;
  if (budget.total > budget.global) {
    return { ok: false, reason: 'global budget exhausted' };
  }
  if ((budget.bySignature[signature] || 0) > budget.perSignature) {
    return { ok: false, reason: 'per-signature budget exhausted for ' + signature };
  }
  return { ok: true };
}

function redactBody(body) {
  if (!body || typeof body !== 'string') return body;
  var out = body;
  out = out.replace(/"api_key"\s*:\s*"[^"]*"/g, '"api_key":"[REDACTED]"');
  out = out.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, function(m) {
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(m) && m.length > 20) return REDACTED_MARKER;
    return m;
  });
  return out;
}

/**
 * Resolve the total request timeout (ms). Order: explicit opts.timeout, then
 * env REPAIR_MODEL_TIMEOUT_MS (env object or process.env), then the default.
 */
function resolveTimeoutMs(opts) {
  var optsTimeout = opts && typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : null;
  if (optsTimeout) return optsTimeout;
  var env = opts && opts.env && typeof opts.env === 'object' ? opts.env : null;
  if (env && typeof env.REPAIR_MODEL_TIMEOUT_MS === 'string' && env.REPAIR_MODEL_TIMEOUT_MS !== '') {
    var n = parseInt(env.REPAIR_MODEL_TIMEOUT_MS, 10);
    if (n > 0) return n;
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env.REPAIR_MODEL_TIMEOUT_MS === 'string' && process.env.REPAIR_MODEL_TIMEOUT_MS !== '') {
    var pn = parseInt(process.env.REPAIR_MODEL_TIMEOUT_MS, 10);
    if (pn > 0) return pn;
  }
  return opts && opts.defaultTimeout && opts.defaultTimeout > 0 ? opts.defaultTimeout : DEFAULT_TIMEOUT_MS;
}

function defaultBackoff(attempt, opts) {
  var base = opts && opts._backoffBase && opts._backoffBase > 0 ? opts._backoffBase : 500;
  return Promise.resolve().then(function() {
    return new Promise(function(resolve) {
      var t = setTimeout(resolve, base * attempt);
      if (typeof t.unref === 'function') t.unref();
    });
  });
}

function callModel(opts) {
  opts = opts || {};
  var prompt = opts.prompt;
  var system = opts.system;
  var env = opts.env;
  var budget = opts.budget;
  var fetch = opts.fetch;

  if (typeof fetch !== 'function') {
    return Promise.resolve({
      ok: false,
      blocker: { code: 'IO_NOT_INJECTED', message: 'fetch was not injected', evidence: {} }
    });
  }

  // Model lock: the caller may only request the configured repair model
  // (REPAIR_MODEL, defaulting to the model constant). Any other caller-supplied
  // model is refused before a fetch is attempted.
  var configuredModel = resolveConfiguredModel(env);
  if (opts.model !== undefined && opts.model !== configuredModel) {
    return Promise.resolve({
      ok: false,
      blocker: {
        code: 'MODEL_NOT_ALLOWED',
        message: 'Only model "' + configuredModel + '" is accepted; got "' + opts.model + '"',
        evidence: {}
      }
    });
  }
  var usedModel = opts.model !== undefined ? opts.model : configuredModel;

  var apiKey;
  if (typeof env === 'object' && env !== null && env.OPENROUTER_API_KEY) {
    apiKey = env.OPENROUTER_API_KEY;
  } else if (process.env.OPENROUTER_API_KEY) {
    apiKey = process.env.OPENROUTER_API_KEY;
  }

  if (!apiKey) {
    return Promise.resolve({
      ok: false,
      blocker: { code: 'MISSING_API_KEY', message: 'OPENROUTER_API_KEY is not set', evidence: {} }
    });
  }

  if (!prompt || typeof prompt !== 'string') {
    return Promise.resolve({
      ok: false,
      blocker: { code: 'INVALID_PROMPT', message: 'A prompt string is required', evidence: {} }
    });
  }

  if (!budget || typeof budget !== 'object') {
    return Promise.resolve({
      ok: false,
      blocker: { code: 'NO_BUDGET', message: 'Budget object is required', evidence: {} }
    });
  }

  if (!budget.model) {
    budget.model = { maxTokensTotal: BUDGET_MODEL_MAX_TOKENS, used: 0 };
  } else {
    if (typeof budget.model.maxTokensTotal !== 'number') budget.model.maxTokensTotal = BUDGET_MODEL_MAX_TOKENS;
    if (typeof budget.model.used !== 'number') budget.model.used = 0;
  }

  if (budget.model.used >= budget.model.maxTokensTotal) {
    return Promise.resolve({
      ok: false,
      blocker: {
        code: 'MODEL_BUDGET_EXHAUSTED',
        message: 'Model token budget exhausted',
        evidence: { used: budget.model.used, max: budget.model.maxTokensTotal }
      }
    });
  }

  var messages = [];
  if (system && typeof system === 'string') messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  var timeoutMs = resolveTimeoutMs(opts);
  var maxAttempts = (typeof opts.maxAttempts === 'number' && opts.maxAttempts > 0) ? opts.maxAttempts : 2;
  var _setTimeout = opts._setTimeout || setTimeout;
  var _clearTimeout = opts._clearTimeout || clearTimeout;
  var _now = opts.now || function() { return Date.now(); };
  var promptChars = prompt.length;
  var host = fetchUtil.hostOf(API_URL) || 'openrouter.ai';

  // Parameters that may be dropped if the provider rejects them.
  // reasoning/response_format/max_tokens are optional niceties; when the
  // provider rejects one we retry once without it.
  var dropped = {};
  var attemptsMade = { n: 0 };

  function buildBody() {
    var b = {
      model: usedModel,
      messages: messages,
      provider: {
        data_collection: 'deny',
        require_parameters: true
      }
    };
    if (!dropped.max_tokens) b.max_tokens = MAX_TOKENS;
    if (!dropped.reasoning) b.reasoning = REASONING_EFFORT;
    if (!dropped.response_format) b.response_format = { type: 'json_object' };
    return JSON.stringify(b);
  }

  function attemptOne(attempt) {
    attemptsMade.n = attempt;
    var startedAt = _now();
    var body = buildBody();
    var controller = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
    }

    var fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: body
    };
    if (controller) fetchOptions.signal = controller.signal;

    var fetchPromise;
    try {
      fetchPromise = Promise.resolve(fetch(API_URL, fetchOptions));
    } catch (e) {
      fetchPromise = Promise.reject(e);
    }

    // ONE timer per attempt: aborts the fetch at timeoutMs
    var timerId = _setTimeout(function() {
      if (controller) controller.abort();
    }, timeoutMs);

    return fetchPromise.then(function(result) {
      return processResponse(result, { attempt: attempt, startedAt: startedAt, promptChars: promptChars, host: host });
    }).catch(function(fetchErr) {
      var elapsedMs = _now() - startedAt;
      if (fetchErr && fetchErr.name === 'AbortError') {
        return {
          ok: false,
          retry: true,
          blocker: {
            code: 'MODEL_TIMEOUT',
            message: 'OpenRouter request timed out after ' + Math.round(elapsedMs / 1000) + 's',
            evidence: { stage: 'model', host: host, elapsedMs: elapsedMs, promptChars: promptChars, attempt: attempt, requestedModel: usedModel }
          },
          requestedModel: usedModel
        };
      }
      return {
        ok: false,
        blocker: {
          code: 'NETWORK_ERROR',
          message: 'Failed to reach OpenRouter: ' + fetchErr.message,
          evidence: { stage: 'model', host: host, method: 'POST', elapsedMs: elapsedMs, promptChars: promptChars, attempt: attempt, requestedModel: usedModel }
        },
        requestedModel: usedModel
      };
    }).finally(function() {
      _clearTimeout(timerId);
    });
  }

  function run() {
    var attempt = 1;
    function next() {
      return attemptOne(attempt).then(function(result) {
        // Provider rejection of an optional parameter: drop it and retry once.
        if (!result.ok && result.retryDrop && !dropped[result.retryDrop] && attempt < maxAttempts) {
          dropped[result.retryDrop] = true;
          attempt += 1;
          return defaultBackoff(attempt, opts).then(next);
        }
        // Retry once on abort/timeout or HTTP 429/5xx
        if (!result.ok && result.retry && attempt < maxAttempts) {
          attempt += 1;
          return defaultBackoff(attempt, opts).then(next);
        }
        return result;
      });
    }
    return next();
  }

  return run();

  function processResponse(response, meta) {
    // Adapter-refusal shape (ok:false + blocker) is propagated unchanged except
    // for normalized evidence, so a refused fetch never masquerades as an HTTP
    // error or an invalid response.
    if (response && response.ok === false && response.blocker && response.blocker.code) {
      var refused = response.blocker;
      var refusedEvidence = Object.assign({}, refused.evidence || {},
        fetchUtil.fetchEvidence('model', 'POST', API_URL, response, 'fetch adapter refused'));
      return { ok: false, blocker: { code: refused.code, message: refused.message || ('fetch adapter ' + refused.code), evidence: refusedEvidence } };
    }

    if (!fetchUtil.isResponseLike(response)) {
      return { ok: false, blocker: { code: 'INVALID_RESPONSE', message: 'Invalid response from fetch', evidence: fetchUtil.fetchEvidence('model', 'POST', API_URL, response, 'fetch resolved with a non-Response value') } };
    }

    var status = response.status;
    if (status === 429 || status >= 500) {
      var reason = status === 429 ? 'rate limit exceeded' : (status >= 500 ? 'server error' : 'unexpected status');
      // Retryable once; evidence tracks the attempt.
      return {
        ok: false,
        retry: true,
        blocker: {
          code: 'HTTP_' + status,
          message: 'OpenRouter API returned ' + status + ' (' + reason + ')',
          evidence: Object.assign({ stage: 'model', host: host, promptChars: meta.promptChars, attempt: meta.attempt, requestedModel: usedModel },
            fetchUtil.fetchEvidence('model', 'POST', API_URL, response, reason))
        },
        requestedModel: usedModel
      };
    }

    if (status !== 200) {
      var reason2 = null;
      if (status === 401 || status === 403) {
        reason2 = 'credentials may be invalid';
      } else if (status === 400 || status === 422) {
        reason2 = 'request rejected by provider';
      } else {
        reason2 = 'unexpected status';
      }
      var message = 'OpenRouter API returned ' + status + ' (' + reason2 + ')';
      var evidence = Object.assign({ stage: 'model', host: host, promptChars: meta.promptChars, attempt: meta.attempt, requestedModel: usedModel },
        fetchUtil.fetchEvidence('model', 'POST', API_URL, response, reason2));

      // Detect provider rejection of an optional parameter (reasoning,
      // response_format, max_tokens) so we can retry without it. An isolated
      // "no eligible provider" error is recorded as its own code (the provider
      // preferences cannot be satisfied) and never retried.
      if (status === 400 || status === 422) {
        return readBody(response).then(function(bodyResult) {
          var errBody = '';
          if (bodyResult.ok && bodyResult.text) errBody = bodyResult.text;
          else if (bodyResult.ok && bodyResult.json) { try { errBody = JSON.stringify(bodyResult.json); } catch (e) { errBody = ''; } }
          if (detectNoEligibleProvider(errBody)) {
            return { ok: false, requestedModel: usedModel, blocker: { code: 'MODEL_NO_ELIGIBLE_PROVIDER', message: 'no eligible provider for model ' + usedModel + ' matching the data collection policy and required parameters', evidence: evidence } };
          }
          return { ok: false, retryDrop: detectRejectedParam(errBody), requestedModel: usedModel, blocker: { code: 'HTTP_' + status, message: message, evidence: evidence } };
        });
      }
      return { ok: false, requestedModel: usedModel, blocker: { code: 'HTTP_' + status, message: message, evidence: evidence } };
    }

    return readBody(response).then(function(bodyResult) {
      if (!bodyResult.ok) {
        return invalidResponse('response body not readable: ' + (bodyResult.error && bodyResult.error.message ? bodyResult.error.message : 'unknown'), bodyResult.length, response, meta);
      }
      var data = bodyResult.json;
      if (data == null && bodyResult.text != null) {
        try {
          data = JSON.parse(bodyResult.text);
        } catch (e) {
          return invalidResponse('response body is not valid JSON: ' + e.message, bodyResult.length, response, meta);
        }
      }
      if (data == null) {
        return invalidResponse('response has no readable body', bodyResult.length, response, meta);
      }
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        return invalidResponse('response JSON missing choices', bodyResult.length, response, meta);
      }
      var usage = data.usage || {};
      var totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens :
        ((typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0) +
         (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0));
      budget.model.used += totalTokens;

      // Record the requested model, the model actually served, and the
      // provider name OpenRouter returned (when it returns one).
      var servedModel = typeof data.model === 'string' && data.model !== '' ? data.model : usedModel;
      var providerName = null;
      if (data.provider != null) {
        if (typeof data.provider === 'string') providerName = data.provider;
        else if (typeof data.provider === 'object' && typeof data.provider.name === 'string') providerName = data.provider.name;
      }

      return {
        ok: true,
        text: data.choices[0].message.content || '',
        requestedModel: usedModel,
        model: servedModel,
        provider: providerName,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: totalTokens
        }
      };
    });
  }

  function invalidResponse(reason, length, response, meta) {
    var evidence = fetchUtil.fetchEvidence('model', 'POST', API_URL, response, reason);
    evidence.stage = 'model';
    evidence.host = host;
    evidence.promptChars = meta.promptChars;
    evidence.attempt = meta.attempt;
    if (length != null && evidence.bodyLength == null) evidence.bodyLength = length;
    return { ok: false, blocker: { code: 'INVALID_RESPONSE', message: 'Failed to parse OpenRouter response: ' + reason, evidence: evidence } };
  }
}

/**
 * Detect which optional parameter the provider rejected in an error body.
 * Returns a key like 'reasoning', 'response_format', 'max_tokens', or null.
 */
function detectRejectedParam(errBody) {
  if (!errBody || typeof errBody !== 'string') return null;
  var recognized = [
    { key: 'reasoning', patterns: [/reasoning/i, /reasoning_effort/i] },
    { key: 'response_format', patterns: [/response_format/i, /response format/i] },
    { key: 'max_tokens', patterns: [/max_tokens/i, /max tokens/i] }
  ];
  for (var i = 0; i < recognized.length; i++) {
    var entry = recognized[i];
    var hit = entry.patterns.some(function(p) { return p.test(errBody); });
    if (hit) return entry.key;
  }
  return null;
}

/**
 * Detect whether OpenRouter rejected the request because no eligible provider
 * satisfies the provider preferences (data_collection deny / require_parameters
 * true). Returns true only for the isolated no-eligible-provider case so it can
 * be recorded as MODEL_NO_ELIGIBLE_PROVIDER instead of a generic HTTP error.
 */
function detectNoEligibleProvider(errBody) {
  if (!errBody || typeof errBody !== 'string') return false;
  var lower = errBody.toLowerCase();
  if (lower.indexOf('no providers') !== -1 || lower.indexOf('no provider') !== -1) return true;
  if (lower.indexOf('eligible') !== -1 && lower.indexOf('provider') !== -1) return true;
  if (lower.indexOf('provider preference') !== -1) return true;
  if (lower.indexOf('data policy') !== -1) return true;
  if ((lower.indexOf('data_collection') !== -1 || lower.indexOf('data collection') !== -1) && lower.indexOf('deny') !== -1) return true;
  if (lower.indexOf('require_parameters') !== -1 || lower.indexOf('require parameters') !== -1) return true;
  return false;
}

/**
 * Read the response body as text, falling back to json() for non-standards
 * stubs. Returns { ok, text?, json?, length }.
 */
function readBody(response) {
  if (response && typeof response.text === 'function') {
    return Promise.resolve().then(function() { return response.text(); })
      .then(function(t) { return { ok: true, text: t, json: null, length: t ? t.length : 0 }; })
      .catch(function(err) { return { ok: false, error: err, length: fetchUtil.bodyLengthHint(response) }; });
  }
  if (response && typeof response.json === 'function') {
    return Promise.resolve().then(function() { return response.json(); })
      .then(function(data) { return { ok: true, text: null, json: data, length: null }; })
      .catch(function(err) { return { ok: false, error: err, length: fetchUtil.bodyLengthHint(response) }; });
  }
  return Promise.resolve({ ok: true, text: null, json: null, length: null });
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  var trimmed = text.trim();

  // Try fenced JSON first: ```json ... ```
  var fencedMatch = /^```json\s*([\s\S]*?)```/im.exec(trimmed);
  if (fencedMatch && fencedMatch[1]) {
    var candidate = fencedMatch[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (e) { /* continue to other strategies */ }
  }

  // Try fenced JSON without language tag
  var fencedNoLang = /^```\s*([\s\S]*?)```/im.exec(trimmed);
  if (fencedNoLang && fencedNoLang[1]) {
    var candidate2 = fencedNoLang[1].trim();
    try {
      JSON.parse(candidate2);
      return candidate2;
    } catch (e) { /* continue */ }
  }

  // Try text before/after JSON fences (prose around JSON)
  var jsonBlockMatch = /\{[\s\S]*\}/.exec(trimmed);
  if (jsonBlockMatch) {
    return jsonBlockMatch[0];
  }

  return null;
}

function parseEditSet(text) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'Input is not a non-empty string' };

  var extracted = extractJson(text);
  if (!extracted) return { ok: false, error: 'No JSON object found in response' };

  var parsed;
  try {
    parsed = JSON.parse(extracted);
  } catch (e) {
    return { ok: false, error: 'Invalid JSON: ' + e.message };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Edit set must be a JSON object' };
  }
  if (typeof parsed.repairKind !== 'string') return { ok: false, error: 'Edit set missing required field: repairKind' };
  if (!Array.isArray(parsed.edits)) return { ok: false, error: 'Edit set missing or invalid edits array' };
  if (parsed.newFiles != null && !Array.isArray(parsed.newFiles)) return { ok: false, error: 'Edit set newFiles must be an array if present' };
  if (typeof parsed.rationale !== 'string' || parsed.rationale.trim().length === 0) return { ok: false, error: 'Edit set missing required field: rationale' };

  var VALID_REPAIR_KINDS = {
    'source-edit': true, 'config-edit': true, 'migration': true,
    'dependency-bump': true, 'dependency-patch': true, 'local-wrapper': true
  };
  if (!VALID_REPAIR_KINDS[parsed.repairKind]) return { ok: false, error: 'Unknown repairKind: ' + parsed.repairKind };

  for (var i = 0; i < parsed.edits.length; i++) {
    var edit = parsed.edits[i];
    if (typeof edit !== 'object' || edit === null) return { ok: false, error: 'edit[' + i + '] must be an object' };
    if (typeof edit.path !== 'string') return { ok: false, error: 'edit[' + i + '] missing path' };
    if (typeof edit.oldString !== 'string') return { ok: false, error: 'edit[' + i + '] missing oldString' };
    if (typeof edit.newString !== 'string') return { ok: false, error: 'edit[' + i + '] missing newString' };
  }
  if (parsed.newFiles) {
    for (var j = 0; j < parsed.newFiles.length; j++) {
      var nf = parsed.newFiles[j];
      if (typeof nf !== 'object' || nf === null) return { ok: false, error: 'newFiles[' + j + '] must be an object' };
      if (typeof nf.path !== 'string') return { ok: false, error: 'newFiles[' + j + '] missing path' };
      if (typeof nf.content !== 'string') return { ok: false, error: 'newFiles[' + j + '] missing content' };
    }
  }

  // Normalize optional fields to match schema defaults
  var normalized = {
    repairKind: parsed.repairKind,
    rationale: parsed.rationale,
    edits: parsed.edits,
    newFiles: parsed.newFiles || []
  };

  return { ok: true, editSet: normalized };
}

module.exports = {
  callModel: callModel,
  parseEditSet: parseEditSet,
  consume: consume,
  BUDGET_SCHEMA: BUDGET_SCHEMA,
  MODEL_CONSTANT: MODEL_CONSTANT,
  resolveConfiguredModel: resolveConfiguredModel,
  detectNoEligibleProvider: detectNoEligibleProvider,
  REDACTED_MARKER: REDACTED_MARKER,
  SIGNAL_TIMEOUT_MS: SIGNAL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  MAX_TOKENS: MAX_TOKENS,
  resolveTimeoutMs: resolveTimeoutMs
};
