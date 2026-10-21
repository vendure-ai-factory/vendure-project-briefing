'use strict';

var modelClient = require('../src/repair/modelClient');
var test = require('node:test');
var assert = require('node:assert');

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

test('consume: within budget -> ok', function() {
  var budget = { perSignature: 3, global: 15, bySignature: {}, total: 0 };
  var r = modelClient.consume(budget, 'sig-a');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(budget.total, 1);
  assert.strictEqual(budget.bySignature['sig-a'], 1);
});

test('consume: per-signature limit reached -> BLOCK', function() {
  var budget = { perSignature: 2, global: 15, bySignature: { 'sig-a': 2 }, total: 2 };
  var r = modelClient.consume(budget, 'sig-a');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason.indexOf('sig-a') !== -1, true);
});

test('consume: global limit reached -> BLOCK', function() {
  var budget = { perSignature: 10, global: 5, bySignature: { 'sig-a': 5 }, total: 5 };
  var r = modelClient.consume(budget, 'sig-b');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason.indexOf('global') !== -1, true);
});

test('consume: no budget object -> false', function() {
  assert.strictEqual(modelClient.consume(null, 'sig-a').ok, false);
  assert.strictEqual(modelClient.consume(undefined, 'sig-a').ok, false);
});

// ---------------------------------------------------------------------------
// parseEditSet
// ---------------------------------------------------------------------------

test('parseEditSet: valid minimal edit set', function() {
  var input = JSON.stringify({
    repairKind: 'source-edit',
    rationale: 'Fix a bug',
    edits: [{ path: 'src/foo.js', oldString: 'old', newString: 'new' }],
    newFiles: []
  });
  var r = modelClient.parseEditSet(input);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.editSet.repairKind, 'source-edit');
  assert.strictEqual(r.editSet.edits.length, 1);
});

test('parseEditSet: JSON in ```json fence', function() {
  var input = '```json\n' + JSON.stringify({
    repairKind: 'config-edit',
    rationale: 'Update config',
    edits: [],
    newFiles: [{ path: 'cfg.json', content: '{}' }]
  }) + '\n```';
  var r = modelClient.parseEditSet(input);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.editSet.repairKind, 'config-edit');
});

test('parseEditSet: invalid JSON -> error', function() {
  var r = modelClient.parseEditSet('{ not json }');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('Invalid JSON') !== -1);
});

test('parseEditSet: null input -> error', function() {
  assert.strictEqual(modelClient.parseEditSet(null).ok, false);
  assert.strictEqual(modelClient.parseEditSet('').ok, false);
  assert.strictEqual(modelClient.parseEditSet(undefined).ok, false);
});

test('parseEditSet: missing repairKind -> error', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ rationale: 'x', edits: [], newFiles: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('repairKind') !== -1);
});

test('parseEditSet: unknown repairKind -> error', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ repairKind: 'unknown-kind', rationale: 'x', edits: [], newFiles: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('Unknown repairKind') !== -1);
});

test('parseEditSet: edits not array -> error', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ repairKind: 'source-edit', rationale: 'x', edits: 'not-array', newFiles: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('edits') !== -1);
});

test('parseEditSet: newFiles not array -> error', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ repairKind: 'source-edit', rationale: 'x', edits: [], newFiles: {} }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('newFiles') !== -1);
});

test('parseEditSet: edit missing path -> error', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ repairKind: 'source-edit', rationale: 'x', edits: [{ oldString: 'a', newString: 'b' }], newFiles: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('edit[0]') !== -1);
});

test('parseEditSet: all repairKind variants accepted', function() {
  var kinds = ['source-edit', 'config-edit', 'migration', 'dependency-bump', 'dependency-patch', 'local-wrapper'];
  kinds.forEach(function(kind) {
    var r = modelClient.parseEditSet(JSON.stringify({ repairKind: kind, rationale: 'x', edits: [], newFiles: [] }));
    assert.strictEqual(r.ok, true, kind + ' should be accepted');
  });
});

test('parseEditSet: rationale required', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ repairKind: 'source-edit', rationale: '', edits: [], newFiles: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('rationale') !== -1);
});

test('parseEditSet: newFile missing content -> error', function() {
  var r = modelClient.parseEditSet(JSON.stringify({ repairKind: 'source-edit', rationale: 'x', edits: [], newFiles: [{ path: 'a.txt' }] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('newFiles[0]') !== -1);
});

// ---------------------------------------------------------------------------
// callModel
// ---------------------------------------------------------------------------

test('callModel: missing fetch -> BLOCK with IO_NOT_INJECTED', function() {
  return modelClient.callModel({ prompt: 'hello', env: { OPENROUTER_API_KEY: 'tok' }, budget: { used: 0, maxTokensTotal: 400000 } }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'IO_NOT_INJECTED');
  });
});

test('callModel: missing api key -> BLOCK with MISSING_API_KEY', function() {
  return modelClient.callModel({ prompt: 'hello', env: {}, budget: { used: 0, maxTokensTotal: 400000 }, fetch: function() {} }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MISSING_API_KEY');
  });
});

test('callModel: api key from process.env fallback', function() {
  var prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fallback-key-test';
  var capturedUrl = null;
  var capturedHeaders = null;
  return modelClient.callModel({
    prompt: 'hello',
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedUrl = url;
      capturedHeaders = opts && opts.headers;
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  }).then(function(r) {
    if (prev === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = prev;
    }
    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer fallback-key-test');
    assert.strictEqual(capturedUrl.indexOf('sk-or-') === -1, true, 'key must not appear in URL');
  });
});

test('callModel: missing prompt -> BLOCK', function() {
  return modelClient.callModel({ env: { OPENROUTER_API_KEY: 'tok' }, budget: { used: 0 }, fetch: function() {} }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'INVALID_PROMPT');
  });
});

test('callModel: no budget -> BLOCK', function() {
  return modelClient.callModel({ prompt: 'hello', env: { OPENROUTER_API_KEY: 'tok' }, fetch: function() {} }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'NO_BUDGET');
  });
});

test('callModel: budget exhausted -> BLOCK', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 400000, maxTokensTotal: 400000 } },
    fetch: function() {}
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MODEL_BUDGET_EXHAUSTED');
  });
});

test('callModel: wrong model constant -> HTTP_400 blocker', function() {
  var capturedBody = null;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedBody = opts && opts.body;
      return Promise.resolve({ status: 400, ok: false, json: function() { return Promise.resolve({ error: { message: 'model not found' } }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_400');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.host, 'openrouter.ai');
    assert.strictEqual(r.blocker.evidence.method, 'POST');
    assert.strictEqual(r.blocker.evidence.status, 400);
    assert.strictEqual(capturedBody.indexOf('z-ai/glm-5.3-flash') !== -1, true, 'model constant must be in request');
    assert.strictEqual(capturedBody.indexOf('sk-or-') === -1, true, 'raw key must not be in body');
  });
});

test('callModel: HTTP 401 -> HTTP_401 blocker with evidence', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'bad-key-12345' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 401, ok: false, json: function() { return Promise.resolve({ error: {} }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_401');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.host, 'openrouter.ai');
    assert.strictEqual(r.blocker.evidence.method, 'POST');
    assert.strictEqual(r.blocker.evidence.status, 401);
    assert.strictEqual(r.blocker.message.indexOf('sk-or-') === -1, true, 'key must not appear in message');
  });
});

test('callModel: HTTP 429 -> HTTP_429 blocker with evidence', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 429, ok: false, json: function() { return Promise.resolve({}); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_429');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.host, 'openrouter.ai');
    assert.strictEqual(r.blocker.evidence.status, 429);
    assert.strictEqual(r.blocker.message.indexOf('429') !== -1, true);
  });
});

test('callModel: HTTP 500 -> HTTP_500 blocker with evidence', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 500, ok: false, json: function() { return Promise.resolve({}); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_500');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.status, 500);
  });
});

test('callModel: network error -> NETWORK_ERROR blocker', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.reject(new Error('ENOTFOUND'));
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'NETWORK_ERROR');
  });
});

test('callModel: success -> ok with text', function() {
  return modelClient.callModel({
    prompt: 'give me json',
    system: 'You are a helpful assistant.',
    env: { OPENROUTER_API_KEY: 'valid-key' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({
        status: 200,
        json: function() {
          return Promise.resolve({
            choices: [{ message: { content: '{"repairKind":"source-edit","rationale":"test","edits":[],"newFiles":[]}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
          });
        }
      });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.usage.total_tokens, 150);
    assert.strictEqual(r.usage.prompt_tokens, 100);
    assert.strictEqual(r.usage.completion_tokens, 50);
    assert.ok(r.text.length > 0);
  });
});

test('callModel: budget used updated after success', function() {
  var budget = { model: { used: 0, maxTokensTotal: 400000 } };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: budget,
    fetch: function() {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 200 } }); } });
    }
  }).then(function(r) {
    assert.strictEqual(budget.model.used, 200);
  });
});

test('callModel: raw key never logged beyond 500 chars redacted', function() {
  var longFakeKey = 'sk-or-v1-test' + 'a'.repeat(500);
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: longFakeKey },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      var body = opts && opts.body;
      assert.strictEqual(body.indexOf(longFakeKey), -1, 'long key must not appear in request body');
      return Promise.resolve({ status: 401, json: function() { return Promise.resolve({}); } });
    }
  });
});

test('callModel: openrouter.ai URL only', function() {
  var capturedUrl = null;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url) {
      capturedUrl = url;
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  }).then(function(r) {
    assert.ok(capturedUrl.indexOf('openrouter.ai') !== -1, 'URL must contain openrouter.ai, got: ' + capturedUrl);
  });
});

test('callModel: max_tokens=4000 constant', function() {
  var capturedBody = null;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedBody = opts && opts.body;
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  }).then(function(r) {
    var body = JSON.parse(capturedBody);
    assert.strictEqual(body.max_tokens, 4000);
    assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  });
});

test('callModel: wrong status code returns HTTP_502', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 502, ok: false, json: function() { return Promise.resolve({}); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_502');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.status, 502);
  });
});

test('callModel: missing choices in response -> INVALID_RESPONSE', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [] }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'INVALID_RESPONSE');
  });
});

test('callModel: response_format json_object in request', function() {
  var capturedBody = null;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function(url, opts) {
      capturedBody = opts && opts.body;
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  }).then(function(r) {
    var body = JSON.parse(capturedBody);
    assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  });
});

// ---------------------------------------------------------------------------
// Item 1b: provider rejection of an optional parameter drops it and retries once
// ---------------------------------------------------------------------------

function callModelWithSequencedFetch(sequences) {
  // sequences: array of per-attempt functions (url, opts) => { status, json }
  var attempt = 0;
  var capturedBodies = [];
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    _backoffBase: 1,
    fetch: function(url, opts) {
      capturedBodies.push(opts && opts.body);
      var seq = sequences[Math.min(attempt, sequences.length - 1)];
      attempt += 1;
      return Promise.resolve({ status: seq.status, ok: seq.status === 200, json: function() { return Promise.resolve(seq.json); } });
    }
  }).then(function(r) {
    return { result: r, capturedBodies: capturedBodies };
  });
}

test('callModel: rejected reasoning param is dropped and retried once', function() {
  return callModelWithSequencedFetch([
    { status: 400, json: { error: { message: 'reasoning is not supported by this model' } } },
    { status: 200, json: { choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 10 } } }
  ]).then(function(out) {
    assert.strictEqual(out.capturedBodies.length, 2, 'must retry once after provider rejects reasoning');
    var body1 = JSON.parse(out.capturedBodies[0]);
    var body2 = JSON.parse(out.capturedBodies[1]);
    assert.ok(body1.reasoning, 'first request must include reasoning');
    assert.ok(body1.reasoning && body1.reasoning.effort === 'low', 'reasoning effort low in first request');
    assert.strictEqual(body2.reasoning, undefined, 'retry must drop reasoning');
    assert.strictEqual(out.result.ok, true, 'retry after drop must succeed');
    assert.strictEqual(out.result.blocker, undefined, 'no blocker on successful retry');
  });
});

test('callModel: rejected response_format param is dropped and retried once', function() {
  return callModelWithSequencedFetch([
    { status: 400, json: { error: { message: 'response_format is not supported here' } } },
    { status: 200, json: { choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 10 } } }
  ]).then(function(out) {
    assert.strictEqual(out.capturedBodies.length, 2, 'must retry once after response_format rejection');
    var body1 = JSON.parse(out.capturedBodies[0]);
    var body2 = JSON.parse(out.capturedBodies[1]);
    assert.deepStrictEqual(body1.response_format, { type: 'json_object' });
    assert.strictEqual(body2.response_format, undefined, 'retry must drop response_format');
    assert.strictEqual(out.result.ok, true, 'retry after drop must succeed');
  });
});

test('callModel: rejected max_tokens param is dropped and retried once', function() {
  return callModelWithSequencedFetch([
    { status: 422, json: { error: { message: 'max_tokens exceeds limit for this model' } } },
    { status: 200, json: { choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 10 } } }
  ]).then(function(out) {
    assert.strictEqual(out.capturedBodies.length, 2, 'must retry once after max_tokens rejection');
    var body1 = JSON.parse(out.capturedBodies[0]);
    var body2 = JSON.parse(out.capturedBodies[1]);
    assert.strictEqual(body1.max_tokens, 4000, 'first request must include max_tokens=4000');
    assert.strictEqual(body2.max_tokens, undefined, 'retry must drop max_tokens');
    assert.strictEqual(out.result.ok, true, 'retry after drop must succeed');
  });
});

test('callModel: unrelated HTTP 400 is NOT retried', function() {
  var attempts = 0;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      attempts += 1;
      return Promise.resolve({ status: 400, ok: false, json: function() { return Promise.resolve({ error: { message: 'model not found' } }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_400');
    assert.strictEqual(attempts, 1, 'unrelated 400 must NOT be retried');
  });
});

test('callModel: unrelated HTTP 401 is NOT retried', function() {
  var attempts = 0;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      attempts += 1;
      return Promise.resolve({ status: 401, ok: false, json: function() { return Promise.resolve({ error: {} }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_401');
    assert.strictEqual(attempts, 1, 'unrelated 401 must NOT be retried');
  });
});

test('callModel: HTTP 500 is retried once then returns blocker', function() {
  var attempts = 0;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    _backoffBase: 1,
    fetch: function() {
      attempts += 1;
      return Promise.resolve({ status: 500, ok: false, json: function() { return Promise.resolve({}); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_500');
    assert.strictEqual(attempts, 2, '500 must be retried once');
  });
});

test('callModel: HTTP 429 is retried once then returns blocker', function() {
  var attempts = 0;
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    _backoffBase: 1,
    fetch: function() {
      attempts += 1;
      return Promise.resolve({ status: 429, ok: false, json: function() { return Promise.resolve({}); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_429');
    assert.strictEqual(attempts, 2, '429 must be retried once');
  });
});

// ---------------------------------------------------------------------------
// Item 1: model constant enforcement
// ---------------------------------------------------------------------------

test('callModel: wrong model option -> MODEL_NOT_ALLOWED, fetch never called', function() {
  var fetchCalled = false;
  var fakeFetch = function() {
    fetchCalled = true;
    return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
  };
  return modelClient.callModel({
    prompt: 'hello',
    model: 'anthropic/claude-3',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: fakeFetch
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MODEL_NOT_ALLOWED');
    assert.strictEqual(fetchCalled, false, 'fetch must never be called');
  });
});

// ---------------------------------------------------------------------------
// Item 2: timeout and token budget
// ---------------------------------------------------------------------------

test('callModel: budget.model.used increases by total_tokens after success', function() {
  var budget = { model: { used: 0, maxTokensTotal: 400000 } };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: budget,
    fetch: function() {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 50, completion_tokens: 150, total_tokens: 200 } }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.usage.total_tokens, 200);
    assert.strictEqual(budget.model.used, 200, 'budget.model.used must be incremented');
  });
});

test('callModel: MODEL_BUDGET_EXHAUSTED when budget.model.used >= maxTokensTotal', function() {
  var budget = { model: { used: 400000, maxTokensTotal: 400000 } };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: budget,
    fetch: function() { return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } }); }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MODEL_BUDGET_EXHAUSTED');
    assert.strictEqual(budget.model.used, 400000, 'used must not change');
  });
});

test('callModel: budget.model created with defaults if absent', function() {
  var budget = {};
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: budget,
    fetch: function() {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(budget.model.maxTokensTotal, 400000);
    assert.strictEqual(budget.model.used, 10);
  });
});

test('callModel: AbortError from fetch -> MODEL_TIMEOUT', function() {
  var err = new Error('aborted');
  err.name = 'AbortError';
  var calls = 0;
  var fakeFetch = function() { calls += 1; return Promise.reject(err); };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: fakeFetch,
    _backoffBase: 1
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MODEL_TIMEOUT');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.host, 'openrouter.ai');
    assert.strictEqual(typeof r.blocker.evidence.elapsedMs, 'number');
    assert.strictEqual(typeof r.blocker.evidence.promptChars, 'number');
    assert.strictEqual(r.blocker.evidence.promptChars, 5);
    assert.strictEqual(calls, 2, 'should retry once on abort');
  });
});

// ---------------------------------------------------------------------------
// Item 1: callModel returns Promise for all inputs
// ---------------------------------------------------------------------------

test('callModel: bad input -> instanceof Promise', function() {
  var r = modelClient.callModel({ prompt: 'hello', env: {}, budget: {}, fetch: function() {} });
  assert.strictEqual(r instanceof Promise, true);
});

// ---------------------------------------------------------------------------
// Item 2b: fetch never resolves -> aborted at timeout via AbortController
// ---------------------------------------------------------------------------

test('callModel: fetch that never resolves -> aborted at opts.timeout, returns MODEL_TIMEOUT', function() {
  // Like a real fetch: never settles on its own, but rejects with AbortError
  // when the injected signal is aborted. Short timeout makes the test fast.
  var calls = 0;
  var fakeFetch = function(url, fetchOpts) {
    calls += 1;
    return new Promise(function(resolve, reject) {
      if (fetchOpts && fetchOpts.signal) {
        fetchOpts.signal.addEventListener('abort', function() {
          var err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
      // never resolves otherwise
    });
  };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: fakeFetch,
    timeout: 50,
    _backoffBase: 1
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MODEL_TIMEOUT');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(typeof r.blocker.evidence.elapsedMs, 'number');
    assert.strictEqual(calls, 2, 'should retry once');
  });
});

// ---------------------------------------------------------------------------
// Timer injection tests (one timer, created == cleared on success)
// ---------------------------------------------------------------------------

test('callModel: after success all timers are cleared (created == cleared)', function() {
  var createdTimers = [];
  var clearedTimers = [];
  function fakeSetTimeout(fn, delay) {
    var id = createdTimers.length + 1; // fake ID
    createdTimers.push({ id: id, delay: delay });
    return id;
  }
  function fakeClearTimeout(id) {
    clearedTimers.push(id);
  }
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    },
    _setTimeout: fakeSetTimeout,
    _clearTimeout: fakeClearTimeout
  }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(createdTimers.length, clearedTimers.length, 'every created timer must be cleared');
    assert.strictEqual(createdTimers.length, 1, 'exactly one timer must be created');
  });
});

test('callModel: default REPAIR_MODEL_TIMEOUT_MS is 300000', function() {
  assert.strictEqual(modelClient.DEFAULT_TIMEOUT_MS, 300000);
});

test('callModel: injected setTimeout receives resolved default timeout (300000)', function() {
  var capturedDelay = null;
  function captureDelay(fn, delay) {
    capturedDelay = delay;
    return 1; // fake timer id, never actually fires
  }
  function noopClearTimeout() {}
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 10 } }); } });
    },
    _setTimeout: captureDelay,
    _clearTimeout: noopClearTimeout
  }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(capturedDelay, modelClient.DEFAULT_TIMEOUT_MS, '_setTimeout must be called with DEFAULT_TIMEOUT_MS');
  });
});

// ---------------------------------------------------------------------------
// WHATWG fetch conformance (real Response objects, not hand-built stubs)
// ---------------------------------------------------------------------------

test('callModel: real WHATWG Response (new Response) works end to end', function() {
  var payload = {
    choices: [{ message: { content: '{"repairKind":"source-edit","rationale":"real response","edits":[],"newFiles":[]}' } }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
  };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, true, 'real Response must be accepted');
    assert.strictEqual(r.text.indexOf('source-edit') !== -1, true);
    assert.strictEqual(r.usage.total_tokens, 12);
  });
});

test('callModel: real Response with non-2xx maps to HTTP_<status> with evidence fields', function() {
  var canary = 'sk-or-v1-nodefaultresponse' + Math.random().toString(36).slice(2);
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok-' + canary },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve(new Response('nope ' + canary, { status: 429, headers: { 'content-type': 'text/plain' } }));
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HTTP_429');
    var ev = r.blocker.evidence;
    assert.strictEqual(ev.stage, 'model');
    assert.strictEqual(ev.host, 'openrouter.ai');
    assert.strictEqual(ev.method, 'POST');
    assert.strictEqual(ev.status, 429);
    assert.strictEqual(ev.contentType, 'text/plain');
    assert.strictEqual(ev.reason, 'rate limit exceeded');
    assert.strictEqual(JSON.stringify(ev).indexOf(canary), -1, 'canary must never appear in evidence');
    assert.strictEqual(JSON.stringify(r.blocker).indexOf(canary), -1, 'canary must never appear in blocker');
  });
});

test('callModel: malformed body -> INVALID_RESPONSE with evidence fields', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve(new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }));
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'INVALID_RESPONSE');
    var ev = r.blocker.evidence;
    assert.strictEqual(ev.stage, 'model');
    assert.strictEqual(ev.host, 'openrouter.ai');
    assert.strictEqual(ev.method, 'POST');
    assert.strictEqual(ev.status, 200);
    assert.strictEqual(ev.bodyLength, 7, '{broken is 7 chars, so evidence.bodyLength must be 7');
  });
});

test('callModel: MODEL_TIMEOUT on retry succeeds, budget.model.used is NOT incremented on failure', function() {
  // Both attempts fail with AbortError (never resolved). The retry succeeds on
  // the second attempt. The budget must NOT be consumed by the failed attempts.
  var calls = 0;
  var attemptsUsed = [];
  var fakeFetch = function(url, opts) {
    calls += 1;
    attemptsUsed.push(calls);
    return new Promise(function(resolve, reject) {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', function() {
          var e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  };
  var budget = { model: { used: 0, maxTokensTotal: 400000 } };
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: budget,
    fetch: fakeFetch,
    timeout: 50,
    _backoffBase: 1
  }).then(function(r) {
    assert.strictEqual(calls, 2, 'should have retried once');
    assert.strictEqual(budget.model.used, 0, 'budget must NOT be consumed when model call fails');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MODEL_TIMEOUT');
  });
});

test('callModel: adapter-refusal shape is passed through, not hidden as INVALID_RESPONSE', function() {
  return modelClient.callModel({
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'tok' },
    budget: { model: { used: 0, maxTokensTotal: 400000 } },
    fetch: function() {
      return Promise.resolve({ ok: false, blocker: { code: 'IO_NOT_INJECTED', message: 'fetch was not injected' } });
    }
  }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'IO_NOT_INJECTED', 'adapter-refusal shape is passed through');
    assert.strictEqual(r.blocker.evidence.stage, 'model');
    assert.strictEqual(r.blocker.evidence.host, 'openrouter.ai');
    assert.strictEqual(r.blocker.evidence.method, 'POST');
    assert.strictEqual(r.blocker.evidence.bodyLength, null);
  });
});
