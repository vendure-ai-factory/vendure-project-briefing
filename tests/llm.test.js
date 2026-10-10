'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');

var assert = require('node:assert');
var test = require('node:test');

var llmModule = require('../src/llm/index');
var mockProviderModule = require('../src/llm/mockProvider');
var openrouterProviderModule = require('../src/llm/openrouterProvider');
var runReconciliationModule = require('../src/llm/runReconciliation');
var providerErrors = require('../src/llm/provider');
var ledgerModule = require('../src/llm/usageLedger');
var budgetModule = require('../src/llm/budgetManager');
var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
var failureClassifier = require('../src/failureClassifier');
var preflightModule = require('../src/preflight');

// --- Test helpers ---

var TEST_RUN_ID = 'run-llm-test-001';
var TEST_DIR = path.resolve(__dirname);
var TEST_RUNS_DIR = path.resolve(TEST_DIR, 'runs');
var TEST_RUN_DIR = path.join(TEST_RUNS_DIR, TEST_RUN_ID);

function setupRunsDir() {
  if (!fs.existsSync(TEST_RUNS_DIR)) {
    fs.mkdirSync(TEST_RUNS_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEST_RUN_DIR)) {
    fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
  }
}

function cleanupRunsDir() {
  try {
    var ledgerPath = path.join(TEST_RUN_DIR, 'llm-usage.jsonl');
    if (fs.existsSync(ledgerPath)) {
      fs.unlinkSync(ledgerPath);
    }
    if (fs.existsSync(TEST_RUN_DIR)) {
      fs.rmdirSync(TEST_RUN_DIR);
    }
  } catch (e) {
    // ignore
  }
  try {
    if (fs.existsSync(TEST_RUNS_DIR)) {
      fs.rmdirSync(TEST_RUNS_DIR);
    }
  } catch (e) {
    // ignore
  }
}

function getLedgerEntries() {
  return ledgerModule.readLedger(TEST_RUN_ID);
}

function clearLedger() {
  ledgerModule.clearLedger(TEST_RUN_ID);
}

// --- TESTS ---

test('llm: provider errors are exported correctly', function(t, done) {
  assert.strictEqual(providerErrors.BudgetPausedError.name, 'BudgetPausedError');
  assert.strictEqual(providerErrors.ModelMismatchError.name, 'ModelMismatchError');
  var mme = new providerErrors.ModelMismatchError('a', 'b');
  assert.strictEqual(mme.requestedModel, 'a');
  assert.strictEqual(mme.receivedModel, 'b');
  done();
});

test('llm: mockProvider returns correct LLMResult shape', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider({
    defaultText: 'Hello world',
    defaultPromptTokens: 10,
    defaultCompletionTokens: 5,
    defaultCostUsd: 0.0003
  });

  mockProvider.complete({
    messages: [{ role: 'user', content: 'hi' }],
    taskId: 'test-task',
    purpose: 'test'
  }).then(function(result) {
    assert.strictEqual(result.text, 'Hello world');
    assert.strictEqual(result.model, 'z-ai/glm-5.3-flash');
    assert.strictEqual(result.usage.promptTokens, 10);
    assert.strictEqual(result.usage.completionTokens, 5);
    assert.strictEqual(result.costUsd, 0.0003);
    assert.ok(result.requestId.startsWith('mock-'));
    done();
  }).catch(done);
});

test('llm: mockProvider setNextResponse overrides defaults', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();

  mockProvider.setNextResponse({
    text: 'Custom response',
    promptTokens: 200,
    completionTokens: 100,
    costUsd: 0.005,
    model: 'custom/model'
  });

  mockProvider.complete({ messages: [], taskId: 't1', purpose: 'p1' }).then(function(result) {
    assert.strictEqual(result.text, 'Custom response');
    assert.strictEqual(result.model, 'custom/model');
    assert.strictEqual(result.usage.promptTokens, 200);
    assert.strictEqual(result.usage.completionTokens, 100);
    assert.strictEqual(result.costUsd, 0.005);
    done();
  }).catch(done);
});

test('llm: mockProvider setNextResponse error simulation - TIMEOUT', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ error: 'TIMEOUT' });

  mockProvider.complete({ messages: [], taskId: 't1', purpose: 'p1' })
    .then(function() { done(new Error('Should have rejected')); })
    .catch(function(err) {
      assert.ok(err.message.indexOf('timeout') !== -1 || err.message.indexOf('Timeout') !== -1);
      done();
    });
});

test('llm: mockProvider setNextResponse error simulation - 429', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ error: '429' });

  mockProvider.complete({ messages: [], taskId: 't1', purpose: 'p1' })
    .then(function() { done(new Error('Should have rejected')); })
    .catch(function(err) {
      assert.strictEqual(err.status, 429);
      done();
    });
});

test('llm: mockProvider setNextResponse error simulation - 5xx', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ error: '5xx' });

  mockProvider.complete({ messages: [], taskId: 't1', purpose: 'p1' })
    .then(function() { done(new Error('Should have rejected')); })
    .catch(function(err) {
      assert.strictEqual(err.status, 500);
      done();
    });
});

test('llm: mockProvider setNextResponse error simulation - MODEL_MISMATCH', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ error: 'MODEL_MISMATCH' });

  mockProvider.complete({ messages: [], taskId: 't1', purpose: 'p1' }).then(function(result) {
    assert.strictEqual(result.model, 'openai/gpt-4o');
    done();
  }).catch(done);
});

test('llm: model lock rejects request for different model', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [{ role: 'user', content: 'hello' }],
    taskId: 'test-model-lock',
    purpose: 'test',
    model: 'openai/gpt-4o', // wrong model
    runId: TEST_RUN_ID
  }).then(function() {
    done(new Error('Should have rejected'));
  }).catch(function(err) {
    assert.strictEqual(err.name, 'ModelLockError');
    assert.strictEqual(err.requestedModel, 'openai/gpt-4o');
    assert.strictEqual(err.allowedModel, 'z-ai/glm-5.3-flash');

    // Verify ledger entry was written for the failed call
    var entries = getLedgerEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].error, 'MODEL_LOCK_REJECTED');
    assert.strictEqual(entries[0].taskId, 'test-model-lock');

    // Verify no prompt text in ledger
    assert.strictEqual(entries[0].promptTokens, null);
    assert.strictEqual(JSON.stringify(entries[0]).indexOf('hello'), -1);

    done();
  }).catch(done);
});

test('llm: model lock rejects response with different model', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ error: 'MODEL_MISMATCH' }); // Returns wrong model

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [{ role: 'user', content: 'hello' }],
    taskId: 'test-response-model-lock',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash', // correct model
    runId: TEST_RUN_ID
  }).then(function() {
    done(new Error('Should have rejected'));
  }).catch(function(err) {
    assert.strictEqual(err.name, 'ModelMismatchError');
    assert.strictEqual(err.requestedModel, 'z-ai/glm-5.3-flash');
    assert.strictEqual(err.receivedModel, 'openai/gpt-4o');
    done();
  }).catch(done);
});

test('llm: ledger written for success', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({
    text: 'Success text',
    promptTokens: 50,
    completionTokens: 30,
    costUsd: 0.002,
    model: 'z-ai/glm-5.3-flash'
  });

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [{ role: 'user', content: 'test prompt' }],
    taskId: 'test-ledger-success',
    purpose: 'planning',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function(result) {
    var entries = getLedgerEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].taskId, 'test-ledger-success');
    assert.strictEqual(entries[0].purpose, 'planning');
    assert.strictEqual(entries[0].model, 'z-ai/glm-5.3-flash');
    assert.strictEqual(entries[0].promptTokens, 50);
    assert.strictEqual(entries[0].completionTokens, 30);
    assert.strictEqual(entries[0].costUsd, 0.002);
    assert.ok(entries[0].cumulativeCostUsd >= 0);

    // No prompt text or key in ledger
    var ledgerStr = JSON.stringify(entries[0]);
    assert.strictEqual(ledgerStr.indexOf('test prompt'), -1);
    assert.strictEqual(ledgerStr.indexOf('OPENROUTER_API_KEY'), -1);
    assert.strictEqual(ledgerStr.indexOf('sk-'), -1);
    done();
  }).catch(done);
});

test('llm: ledger written for failure', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ error: new Error('Provider failure') });

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [{ role: 'user', content: 'SECRET_PROMPT_SENTINEL' }],
    taskId: 'test-ledger-failure',
    purpose: 'repair',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function() {
    done(new Error('Should have rejected'));
  }).catch(function() {
    var entries = getLedgerEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].taskId, 'test-ledger-failure');
    assert.strictEqual(entries[0].error.indexOf('Provider failure'), 0);
    assert.strictEqual(entries[0].promptTokens, null);
    assert.strictEqual(entries[0].costUsd, null);

    // No prompt text in ledger (prompt must never be recorded)
    var ledgerStr = JSON.stringify(entries[0]);
    assert.strictEqual(ledgerStr.indexOf('SECRET_PROMPT_SENTINEL'), -1, 'Prompt text should never appear in ledger');
    done();
  });
});

test('llm: cumulative cost correct in ledger', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();

  // First call: 0.005 USD
  mockProvider.setNextResponse({ text: 'r1', costUsd: 0.005, model: 'z-ai/glm-5.3-flash' });
  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [], taskId: 't1', purpose: 'p', model: 'z-ai/glm-5.3-flash', runId: TEST_RUN_ID
  }).then(function() {
    // Second call: 0.007 USD
    mockProvider.setNextResponse({ text: 'r2', costUsd: 0.007, model: 'z-ai/glm-5.3-flash' });
    return client.complete({
      messages: [], taskId: 't2', purpose: 'p', model: 'z-ai/glm-5.3-flash', runId: TEST_RUN_ID
    });
  }).then(function() {
    var entries = getLedgerEntries();
    assert.strictEqual(entries.length, 2);
    // First entry cumulative: should be 0.005
    assert.strictEqual(entries[0].cumulativeCostUsd, 0.005);
    // Second entry cumulative: should be 0.005 + 0.007 = 0.012
    assert.strictEqual(entries[1].cumulativeCostUsd, 0.012);
    done();
  }).catch(done);
});

test('llm: budget pause at hard limit - call refused, no provider call', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  var callCount = 0;
  var originalComplete = mockProvider.complete.bind(mockProvider);
  mockProvider.complete = function(options) {
    callCount++;
    return originalComplete(options);
  };

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  // Simulate prior calls consuming the full budget: cumulative === 20.00
  client.getBudgetManager().recordCost(20.00, TEST_RUN_ID, 'setup');

  clearLedger(); // Clear the ledger from setup

  // Next call should be refused with BUDGET_PAUSED, no provider call
  client.complete({
    messages: [{ role: 'user', content: 'should not reach provider' }],
    taskId: 't-budget-pause',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function() {
    done(new Error('Should have been rejected'));
  }).catch(function(err) {
    assert.strictEqual(err.name, 'BudgetPausedError');
    assert.strictEqual(callCount, 0, 'Provider should not have been called');

    // Verify ledger entry for paused call
    var entries = getLedgerEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].error, 'BUDGET_PAUSED');
    done();
  }).catch(done);
});

test('llm: budget pause at exactly 100% - provider not called once over limit', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  var callCount = 0;
  mockProvider.complete = function(options) {
    callCount++;
    return Promise.resolve({
      text: 'result',
      model: 'z-ai/glm-5.3-flash',
      usage: { promptTokens: 10, completionTokens: 5 },
      costUsd: 1.00,
      requestId: 'mock-call'
    });
  };

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  // First call: cumulative goes from 0 to 1.00 (within budget), allowed
  client.complete({
    messages: [],
    taskId: 't-budget-100',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function() {
    assert.strictEqual(callCount, 1, 'First call should be allowed');
    assert.strictEqual(client.getBudgetManager().getCumulativeCost(), 1.00);

    // Simulate that across many calls the budget reached 20.00
    client.getBudgetManager().recordCost(19.00, TEST_RUN_ID, 'setup-extra');
    assert.strictEqual(client.getBudgetManager().getCumulativeCost(), 20.00);

    clearLedger();

    return client.complete({
      messages: [],
      taskId: 't-budget-paused-after',
      purpose: 'test',
      model: 'z-ai/glm-5.3-flash',
      runId: TEST_RUN_ID
    });
  }).then(function() {
    done(new Error('Should have rejected'));
  }).catch(function(err) {
    assert.strictEqual(err.name, 'BudgetPausedError');
    assert.strictEqual(callCount, 1, 'Provider should not be called after pause');
    done();
  }).catch(done);
});

test('llm: budget warning at 80% emitted once', function(t, done) {
  setupRunsDir();
  clearLedger();

  var mockProvider = mockProviderModule.createMockProvider();
  var warnings = [];
  var logger = {
    warn: function(event, msg, extra) {
      warnings.push({ event: event, msg: msg, extra: extra });
    }
  };

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    logger: logger,
    budgetConfig: { totalUsd: 10.00, warningThreshold: 0.80 }
  });

  // 10.00 * 0.80 = 8.00. Warning should fire when cumulative >= 8.00

  mockProvider.setNextResponse({ text: 'r1', costUsd: 4.00, model: 'z-ai/glm-5.3-flash' });
  client.complete({
    messages: [], taskId: 't1', purpose: 'p', model: 'z-ai/glm-5.3-flash', runId: TEST_RUN_ID
  }).then(function() {
    mockProvider.setNextResponse({ text: 'r2', costUsd: 5.00, model: 'z-ai/glm-5.3-flash' });
    return client.complete({
      messages: [], taskId: 't2', purpose: 'p', model: 'z-ai/glm-5.3-flash', runId: TEST_RUN_ID
    });
  }).then(function() {
    // Total: 9.00 (> 8.00 warning threshold). Warning should have been recorded.
    assert.strictEqual(warnings.length >= 1, true, 'Warning should be emitted');
    var warnEvents = warnings.filter(function(w) { return w.event === 'LLM_BUDGET_WARNING'; });
    assert.strictEqual(warnEvents.length, 1, 'Warning should be emitted exactly once');
    done();
  }).catch(done);
});

test('llm: retry waits 2/4/8 with injected clock, stops after 3', function(t, done) {
  setupRunsDir();
  clearLedger();

  var delaysCalled = [];
  // Injected clock: records the requested backoff delay but resolves immediately
  // so tests do not actually sleep 2s/4s/8s.
  var mockSleepFn = function(ms) {
    delaysCalled.push(ms);
    return new Promise(function(resolve) { setTimeout(resolve, 1); });
  };

  var mockProvider = mockProviderModule.createMockProvider();
  var attempt = 0;
  mockProvider.complete = function(options) {
    attempt++;
    if (attempt < 3) {
      var err = new Error('Transient error');
      err.status = 500;
      return Promise.reject(err);
    }
    return Promise.resolve({
      text: 'Success on attempt 3',
      model: 'z-ai/glm-5.3-flash',
      usage: { promptTokens: 10, completionTokens: 5 },
      costUsd: 0.001,
      requestId: 'mock-retry'
    });
  };

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    sleepFn: mockSleepFn,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [],
    taskId: 't-retry',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function(result) {
    assert.strictEqual(attempt, 3);
    assert.deepStrictEqual(delaysCalled, [2000, 4000]);
    done();
  }).catch(done);
});

test('llm: retry stops after 3 failures', function(t, done) {
  setupRunsDir();
  clearLedger();

  var delaysCalled = [];
  var mockSleepFn = function(ms) {
    delaysCalled.push(ms);
    return new Promise(function(resolve) { setTimeout(resolve, 1); });
  };

  var mockProvider = mockProviderModule.createMockProvider();
  var attempt = 0;
  mockProvider.complete = function(options) {
    attempt++;
    var err = new Error('Persistent error');
    err.status = 500;
    return Promise.reject(err);
  };

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    sleepFn: mockSleepFn,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [],
    taskId: 't-retry-fail',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function() {
    done(new Error('Should have rejected'));
  }).catch(function(err) {
    assert.strictEqual(attempt, 4); // 1 initial + 3 retries
    assert.deepStrictEqual(delaysCalled, [2000, 4000, 8000]);
    done();
  }).catch(done);
});

test('llm: retry also handles 429 and timeout', function(t, done) {
  setupRunsDir();
  clearLedger();

  var delaysCalled = [];
  var mockSleepFn = function(ms) {
    delaysCalled.push(ms);
    return new Promise(function(resolve) { setTimeout(resolve, 1); });
  };

  var mockProvider = mockProviderModule.createMockProvider();
  var attempt = 0;
  mockProvider.complete = function(options) {
    attempt++;
    if (attempt === 1) {
      var err = new Error('Rate limited');
      err.status = 429;
      return Promise.reject(err);
    }
    if (attempt === 2) {
      var tErr = new Error('Request timeout');
      return Promise.reject(tErr);
    }
    return Promise.resolve({
      text: 'Success',
      model: 'z-ai/glm-5.3-flash',
      usage: { promptTokens: 5, completionTokens: 5 },
      costUsd: 0.001,
      requestId: 'mock-ok'
    });
  };

  var client = llmModule.createLLMClient({
    provider: mockProvider,
    sleepFn: mockSleepFn,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [],
    taskId: 't-retry-429-timeout',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function(result) {
    assert.strictEqual(result.text, 'Success');
    assert.strictEqual(attempt, 3);
    assert.deepStrictEqual(delaysCalled, [2000, 4000]);
    done();
  }).catch(done);
});

test('llm: fake OPENROUTER_API_KEY never appears in ledger', function(t, done) {
  setupRunsDir();
  clearLedger();

  process.env.OPENROUTER_API_KEY = 'sk-or-v1-test1234567890abcdef';

  var mockProvider = mockProviderModule.createMockProvider();
  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [],
    taskId: 't-no-key',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function() {
    var entries = getLedgerEntries();
    var ledgerStr = JSON.stringify(entries);
    assert.strictEqual(ledgerStr.indexOf('sk-or-v1'), -1, 'API key should not appear in ledger');
    assert.strictEqual(ledgerStr.indexOf('OPENROUTER_API_KEY'), -1, 'Key name should not appear in ledger');
    assert.strictEqual(ledgerStr.indexOf('sk-'), -1, 'sk- prefix should not appear in ledger');
    done();
  }).catch(done);
});

test('llm: no network call made with mock provider', function(t, done) {
  setupRunsDir();
  clearLedger();

  var fetchCalled = false;
  var originalFetch = global.fetch;

  // Override global fetch to track if it's called
  global.fetch = function() {
    fetchCalled = true;
    return originalFetch.apply(this, arguments);
  };

  var mockProvider = mockProviderModule.createMockProvider();
  var client = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });

  client.complete({
    messages: [],
    taskId: 't-no-network',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    runId: TEST_RUN_ID
  }).then(function() {
    assert.strictEqual(fetchCalled, false, 'fetch should not have been called');
    done();
  }).catch(done);
});

test('llm: budget manager records cost correctly', function(t, done) {
  var budget = budgetModule.createBudgetManager();
  budget._injectConfig({ totalUsd: 10.00, warningThreshold: 0.80 });

  budget.recordCost(3.00, 'run-x', 'task-y');
  assert.strictEqual(budget.getCumulativeCost(), 3.00);
  assert.strictEqual(budget.isPaused(), false);

  budget.recordCost(5.00, 'run-x', 'task-y');
  assert.strictEqual(budget.getCumulativeCost(), 8.00); // 80% warning should fire

  budget.recordCost(2.10, 'run-x', 'task-y');
  assert.strictEqual(budget.getCumulativeCost(), 10.10);
  assert.strictEqual(budget.isPaused(), true);
  done();
});

test('llm: budget manager checkBudget returns paused state', function(t, done) {
  var budget = budgetModule.createBudgetManager();
  budget._injectConfig({ totalUsd: 10.00, warningThreshold: 0.80 });
  budget.recordCost(10.00, 'run-x', 'task-y');

  var result = budget.checkBudget();
  assert.strictEqual(result.paused, true);
  assert.strictEqual(result.cumulativeCostUsd, 10.00);
  done();
});

test('llm: preflight checkOpenRouterApiKey - mock provider always ok', function(t, done) {
  var getEnv = function() { return {}; }; // no API key

  var result = preflightModule.checkOpenRouterApiKey(getEnv, 'mock');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.missing, ['OPENROUTER_API_KEY']);

  done();
});

test('llm: preflight checkOpenRouterApiKey - real provider fails without key', function(t, done) {
  var getEnv = function() { return {}; }; // no API key

  var result = preflightModule.checkOpenRouterApiKey(getEnv, 'real');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.exitCode, 4);
  assert.strictEqual(result.classification, 'CLIENT_INPUT_SCOPE');
  done();
});

test('llm: preflight checkOpenRouterApiKey - real provider ok with key', function(t, done) {
  var getEnv = function() { return { OPENROUTER_API_KEY: 'sk-test-12345678' }; };

  var result = preflightModule.checkOpenRouterApiKey(getEnv, 'real');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.missing, []);
  done();
});

test('llm: failureClassifier has BUDGET_PAUSED category', function(t, done) {
  var categories = failureClassifier.FAILURE_CATEGORIES;
  assert.strictEqual(categories.BUDGET_PAUSED, 'BUDGET_PAUSED');
  assert.strictEqual(failureClassifier.isRecoverable('BUDGET_PAUSED'), false);
  done();
});

test('llm: ledger read/write roundtrip', function(t, done) {
  setupRunsDir();
  clearLedger();

  ledgerModule.writeLedgerEntry(TEST_RUN_ID, {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 'roundtrip-test',
    purpose: 'test',
    model: 'z-ai/glm-5.3-flash',
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.003,
    requestId: 'req-123',
    cumulativeCostUsd: 0.003
  });

  var entries = getLedgerEntries();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].taskId, 'roundtrip-test');
  assert.strictEqual(entries[0].costUsd, 0.003);
  done();
});

test('llm: ledger handles missing run dir gracefully', function(t, done) {
  // Should not throw if runId dir doesn't exist
  try {
    ledgerModule.writeLedgerEntry('nonexistent-run-id-xyz', {
      timestamp: new Date().toISOString(),
      taskId: 't1',
      purpose: 'test',
      model: 'm1',
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.001,
      requestId: 'r1',
      cumulativeCostUsd: 0.001
    });
    done();
  } catch (e) {
    done(e);
  }
});

test('llm: budget config respects env vars when not injected', function(t, done) {
  // When _injectConfig is not used, budget should read from env
  process.env.LLM_BUDGET_TOTAL_USD = '5.00';
  process.env.LLM_BUDGET_WARNING_THRESHOLD = '0.60';

  var budget = budgetModule.createBudgetManager();
  var cfg = budget.getConfig();

  assert.strictEqual(cfg.totalUsd, 5.00);
  assert.strictEqual(cfg.warningThreshold, 0.60);

  delete process.env.LLM_BUDGET_TOTAL_USD;
  delete process.env.LLM_BUDGET_WARNING_THRESHOLD;
  done();
});

test('llm: keyUsageProbe mock returns scripted numbers', function(t, done) {
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  var probe = keyUsageProbeModule.createKeyUsageProbe({ providerType: 'mock' });
  probe.probeKeyUsage().then(function(result) {
    assert.strictEqual(result.usage, 0.0123);
    assert.strictEqual(result.limit, 5.00);
    assert.strictEqual(result.status, 'active');
    done();
  }).catch(done);
});

test('llm: keyUsageProbe mock never calls fetch', function(t, done) {
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  var callCount = 0;
  var mockFetch = function() { callCount++; return Promise.reject(new Error('no fetch')); };
  var probe = keyUsageProbeModule.createKeyUsageProbe({ providerType: 'mock', fetchFn: mockFetch });
  probe.probeKeyUsage().then(function() {
    assert.strictEqual(callCount, 0, 'fetch should not be called in mock mode');
    done();
  }).catch(done);
});

test('llm: mockProvider records X-Title and user headers', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.complete({
    messages: [{ role: 'user', content: 'hello' }],
    taskId: 'test-headers', purpose: 'test', runId: 'run-123'
  }).then(function() {
    var headers = mockProvider.getLastRequestHeaders();
    assert.deepStrictEqual(headers, { xTitle: 'vendure-pipeline', user: 'vendure-pipeline:run-123' });
    done();
  }).catch(done);
});

test('llm: mockProvider generationId returned in response', function(t, done) {
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ text: 'hi', generationId: 'gen-abc-123' });
  mockProvider.complete({ messages: [], taskId: 't1', purpose: 'test', runId: 'run-456' }).then(function(result) {
    assert.strictEqual(result.generationId, 'gen-abc-123');
    done();
  }).catch(done);
});

test('llm: ledger stores generationId when provided', function(t, done) {
  setupRunsDir();
  clearLedger();
  var mockProvider = mockProviderModule.createMockProvider();
  mockProvider.setNextResponse({ text: 'test', generationId: 'gen-ledger-test' });
  var client = llmModule.createLLMClient({
    provider: mockProvider, budgetConfig: { totalUsd: 20.00, warningThreshold: 0.80 }
  });
  client.complete({
    messages: [{ role: 'user', content: 'test' }],
    taskId: 'test-gen-id', purpose: 'test', model: 'z-ai/glm-5.3-flash', runId: TEST_RUN_ID
  }).then(function() {
    var entries = getLedgerEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].generationId, 'gen-ledger-test');
    done();
  }).catch(done);
});

test('llm: keyUsageReconciliation MATCH status', function(t, done) {
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  keyUsageProbeModule.writeKeyUsageReconciliation('test-run-match', {
    usageBefore: 1.00, usageAfter: 1.50, deltaReported: 0.50, ledgerTotal: 0.50,
    difference: 0.00, toleranceUsd: 0.01, status: 'MATCH'
  });
  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-run-match');
  assert.strictEqual(recon.status, 'MATCH');
  assert.strictEqual(recon.difference, 0.00);
  done();
});

test('llm: keyUsageReconciliation MISMATCH status', function(t, done) {
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  keyUsageProbeModule.writeKeyUsageReconciliation('test-run-mismatch', {
    usageBefore: 1.00, usageAfter: 2.00, deltaReported: 1.00, ledgerTotal: 0.50,
    difference: 0.50, toleranceUsd: 0.01, status: 'MISMATCH'
  });
  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-run-mismatch');
  assert.strictEqual(recon.status, 'MISMATCH');
  assert.strictEqual(recon.difference, 0.50);
  done();
});

test('llm: keyUsageReconciliation PROBE_UNAVAILABLE status', function(t, done) {
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  keyUsageProbeModule.writeKeyUsageReconciliation('test-run-unavail', {
    usageBefore: null, usageAfter: null, deltaReported: null, ledgerTotal: 0.50,
    difference: null, toleranceUsd: 0.01, status: 'PROBE_UNAVAILABLE'
  });
  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-run-unavail');
  assert.strictEqual(recon.status, 'PROBE_UNAVAILABLE');
  done();
});

test('llm: reconciliation write accepts deps for path control', function(t, done) {
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  var fs = require('fs');
  var path = require('path');
  var testDir = path.join(TEST_RUNS_DIR, 'test-recon-deps');
  var testRunDir = path.join(testDir, 'test-run-deps');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  if (!fs.existsSync(testRunDir)) fs.mkdirSync(testRunDir, { recursive: true });

  keyUsageProbeModule.writeKeyUsageReconciliation('test-run-deps', {
    usageBefore: 1.00, usageAfter: 1.50, deltaReported: 0.50, ledgerTotal: 0.50,
    difference: 0.00, toleranceUsd: 0.01, status: 'MATCH'
  }, { fs: fs, path: path });

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-run-deps', { fs: fs, path: path });
  assert.strictEqual(recon.status, 'MATCH');
  assert.strictEqual(recon.difference, 0.00);
  done();
});

test('llm: buildRequest - X-Title header present', function(t, done) {
  var result = openrouterProviderModule.buildRequest({
    runId: 'run-abc-123',
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.strictEqual(result.headers['X-Title'], 'vendure-pipeline');
  done();
});

test('llm: buildRequest - body.user correct format', function(t, done) {
  var result = openrouterProviderModule.buildRequest({
    runId: 'run-xyz-789',
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: 'test' }]
  });
  assert.strictEqual(result.body.user, 'vendure-pipeline:run-xyz-789');
  done();
});

test('llm: buildRequest - body.model equals locked model', function(t, done) {
  var result = openrouterProviderModule.buildRequest({
    runId: 'run-test',
    model: 'z-ai/glm-5.3-flash',
    messages: []
  });
  assert.strictEqual(result.body.model, 'z-ai/glm-5.3-flash');
  done();
});

test('llm: buildRequest - Authorization never in returned headers', function(t, done) {
  var result = openrouterProviderModule.buildRequest({
    runId: 'run-test',
    model: 'z-ai/glm-5.3-flash',
    messages: []
  });
  assert.strictEqual(result.headers['Authorization'], undefined);
  assert.strictEqual(result.headers['authorization'], undefined);
  // Verify the word 'Authorization' does not appear in the stringified headers
  var headersStr = JSON.stringify(result.headers);
  assert.strictEqual(headersStr.indexOf('Authorization'), -1);
  done();
});

// --- Real OpenRouter provider mocked-fetch tests ---
// These stub global.fetch so the real HTTP path is exercised without any
// network access. The key used here is a fake test value and must never be
// echoed in results or errors.

var FAKE_REAL_KEY = 'sk-test-real-provider-0123456789abcdef'; // fake key for tests only

function makeFakeFetch(spyCalls, status, bodyOrError) {
  return function(url, options) {
    if (spyCalls) { spyCalls.push({ url: url, options: options }); }
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function() {
        if (bodyOrError instanceof Error) { return Promise.reject(bodyOrError); }
        return Promise.resolve(bodyOrError);
      }
    });
  };
}

function withRealEnvFakeKey(work) {
  var prevKey = process.env.OPENROUTER_API_KEY;
  var prevModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = FAKE_REAL_KEY;
  process.env.OPENROUTER_MODEL = 'z-ai/glm-5.3-flash';
  var restored = false;
  function restore() {
    if (restored) { return; }
    restored = true;
    if (prevKey === undefined) { delete process.env.OPENROUTER_API_KEY; } else { process.env.OPENROUTER_API_KEY = prevKey; }
    if (prevModel === undefined) { delete process.env.OPENROUTER_MODEL; } else { process.env.OPENROUTER_MODEL = prevModel; }
  }
  return Promise.resolve().then(work).then(function(val) { restore(); return val; }, function(err) { restore(); throw err; });
}

function stubGlobalFetch(fakeFetch) {
  var originalFetch = global.fetch;
  global.fetch = fakeFetch;
  return function restore() { global.fetch = originalFetch; };
}

test('llm: real provider parses a successful completion', function(t, done) {
  withRealEnvFakeKey(function() {
    var provider = openrouterProviderModule.createOpenRouterProvider();
    var calls = [];
    var restoreFetch = stubGlobalFetch(makeFakeFetch(calls, 200, {
      id: 'gen-abc123',
      model: 'z-ai/glm-5.3-flash',
      choices: [{ message: { role: 'assistant', content: 'Hello world' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 }
    }));
    return provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      taskId: 'task-1',
      purpose: 'test',
      model: 'z-ai/glm-5.3-flash',
      runId: TEST_RUN_ID
    }).then(function(result) {
      restoreFetch();
      assert.strictEqual(result.text, 'Hello world');
      assert.strictEqual(result.model, 'z-ai/glm-5.3-flash');
      assert.strictEqual(result.usage.promptTokens, 1000);
      assert.strictEqual(result.usage.completionTokens, 500);
      assert.ok(result.costUsd > 0, 'costUsd should be > 0 for nonzero tokens');
      assert.ok(result.requestId, 'requestId should be set');
      assert.strictEqual(result.generationId, 'gen-abc123');
      assert.strictEqual(calls.length, 1, 'exactly one fetch call');
      assert.ok(calls[0].url.indexOf('/chat/completions') !== -1, 'should hit chat completions endpoint');
      assert.strictEqual(JSON.stringify(result).indexOf(FAKE_REAL_KEY), -1, 'key must not appear in result');
    });
  }).then(function() { done(); }, function(err) { done(err); });
});

test('llm: real provider sends Authorization header without exposing the key', function(t, done) {
  withRealEnvFakeKey(function() {
    var provider = openrouterProviderModule.createOpenRouterProvider();
    var calls = [];
    var restoreFetch = stubGlobalFetch(makeFakeFetch(calls, 200, {
      choices: [{ message: { content: 'ok' } }],
      usage: {}
    }));
    return provider.complete({
      messages: [],
      taskId: 'task-2',
      purpose: 'test',
      model: 'z-ai/glm-5.3-flash',
      runId: TEST_RUN_ID
    }).then(function(result) {
      restoreFetch();
      assert.ok(calls[0], 'fetch should have been called');
      var auth = calls[0].options.headers['Authorization'];
      assert.strictEqual(auth, 'Bearer ' + FAKE_REAL_KEY, 'Authorization header should be Bearer key');
      assert.ok(calls[0].options.headers['HTTP-Referer'], 'HTTP-Referer should be present');
      assert.ok(calls[0].options.headers['X-Title'], 'X-Title should be present');
      assert.strictEqual(JSON.stringify(result).indexOf(FAKE_REAL_KEY), -1, 'key must not appear in result');
    });
  }).then(function() { done(); }, function(err) { done(err); });
});

test('llm: real provider rejects on auth/payment errors 401/402/403 without leaking key', function(t, done) {
  withRealEnvFakeKey(function() {
    var provider = openrouterProviderModule.createOpenRouterProvider();
    var statuses = [401, 402, 403];
    var chain = Promise.resolve();
    statuses.forEach(function(status) {
      chain = chain.then(function() {
        var calls = [];
        var restoreFetch = stubGlobalFetch(makeFakeFetch(calls, status, {}));
        return provider.complete({
          messages: [{ role: 'user', content: 'hi' }],
          taskId: 'task-auth',
          purpose: 'test',
          model: 'z-ai/glm-5.3-flash',
          runId: TEST_RUN_ID
        }).then(function() {
          restoreFetch();
          return Promise.reject(new Error('should have rejected with ' + status));
        }, function(err) {
          restoreFetch();
          assert.strictEqual(err.status, status, 'status should be ' + status);
          assert.strictEqual(err.message.indexOf('OpenRouter HTTP error'), 0, 'error should name the HTTP error');
          assert.strictEqual(err.message.indexOf(FAKE_REAL_KEY), -1, 'key must never appear in error message');
        });
      });
    });
    return chain;
  }).then(function() { done(); }, function(err) { done(err); });
});

test('llm: real provider rejects on 429 and 5xx', function(t, done) {
  withRealEnvFakeKey(function() {
    var provider = openrouterProviderModule.createOpenRouterProvider();
    var statuses = [429, 500, 503];
    var chain = Promise.resolve();
    statuses.forEach(function(status) {
      chain = chain.then(function() {
        var restoreFetch = stubGlobalFetch(makeFakeFetch([], status, {}));
        return provider.complete({
          messages: [{ role: 'user', content: 'hi' }],
          taskId: 'task-retry',
          purpose: 'test',
          model: 'z-ai/glm-5.3-flash',
          runId: TEST_RUN_ID
        }).then(function() {
          restoreFetch();
          return Promise.reject(new Error('should have rejected with ' + status));
        }, function(err) {
          restoreFetch();
          assert.strictEqual(err.status, status, 'status should be ' + status);
        });
      });
    });
    return chain;
  }).then(function() { done(); }, function(err) { done(err); });
});

test('llm: real provider rejects on invalid JSON body', function(t, done) {
  withRealEnvFakeKey(function() {
    var provider = openrouterProviderModule.createOpenRouterProvider();
    var badJson = new SyntaxError('Unexpected token < in JSON at position 0');
    var restoreFetch = stubGlobalFetch(makeFakeFetch([], 200, badJson));
    return provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      taskId: 'task-json',
      purpose: 'test',
      model: 'z-ai/glm-5.3-flash',
      runId: TEST_RUN_ID
    }).then(function() {
      restoreFetch();
      return Promise.reject(new Error('should have rejected on invalid JSON'));
    }, function(err) {
      restoreFetch();
      assert.ok(err.message, 'should reject with the parse error');
      assert.strictEqual(err.message.indexOf('JSON') !== -1, true, 'error should mention JSON parsing');
      assert.strictEqual(err.message.indexOf(FAKE_REAL_KEY), -1, 'key must never appear in error message');
    });
  }).then(function() { done(); }, function(err) { done(err); });
});

test('llm: real provider tolerates malformed success bodies without crashing', function(t, done) {
  withRealEnvFakeKey(function() {
    var provider = openrouterProviderModule.createOpenRouterProvider();
    var bodies = [{}, { choices: [] }, { choices: [{}] }];
    var chain = Promise.resolve();
    bodies.forEach(function(body, idx) {
      chain = chain.then(function() {
        var restoreFetch = stubGlobalFetch(makeFakeFetch([], 200, body));
        return provider.complete({
          messages: [{ role: 'user', content: 'hi' }],
          taskId: 'task-malformed-' + idx,
          purpose: 'test',
          model: 'z-ai/glm-5.3-flash',
          runId: TEST_RUN_ID
        }).then(function(result) {
          restoreFetch();
          assert.strictEqual(typeof result.text, 'string');
          assert.strictEqual(result.model, 'z-ai/glm-5.3-flash');
          assert.ok(result.requestId, 'requestId should still be set');
          if (result.usage) {
            assert.strictEqual(typeof result.usage.promptTokens, 'number', 'promptTokens should be a number');
          }
        });
      });
    });
    return chain;
  }).then(function() { done(); }, function(err) { done(err); });
});

test('llm: real provider rejects missing key without any fetch', function(t, done) {
  var prevKey = process.env.OPENROUTER_API_KEY;
  var prevModel = process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;

  var calls = [];
  var restoreFetch = stubGlobalFetch(makeFakeFetch(calls, 200, { choices: [] }));

  function cleanup() {
    restoreFetch();
    if (prevKey === undefined) { delete process.env.OPENROUTER_API_KEY; } else { process.env.OPENROUTER_API_KEY = prevKey; }
    if (prevModel === undefined) { delete process.env.OPENROUTER_MODEL; } else { process.env.OPENROUTER_MODEL = prevModel; }
  }

  var provider = openrouterProviderModule.createOpenRouterProvider();
  provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'z-ai/glm-5.3-flash' }).then(function() {
    cleanup();
    done(new Error('should have rejected without a key'));
  }, function(err) {
    cleanup();
    assert.strictEqual(err.message, 'OPENROUTER_API_KEY is not set');
    assert.strictEqual(calls.length, 0, 'no network call should be made without a key');
    done();
  });
});

test('llm: finalizeRunKeyUsage MATCH', function(t, done) {
  setupRunsDir();
  ledgerModule.clearLedger('test-recon-match'); // clear correct runId

  // Write two ledger entries totaling 0.005
  ledgerModule.writeLedgerEntry('test-recon-match', {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
    promptTokens: 100, completionTokens: 50, costUsd: 0.003,
    requestId: 'r1', cumulativeCostUsd: 0.003
  });
  ledgerModule.writeLedgerEntry('test-recon-match', {
    timestamp: '2026-10-03T00:01:00.000Z',
    taskId: 't2', purpose: 'p2', model: 'z-ai/glm-5.3-flash',
    promptTokens: 50, completionTokens: 25, costUsd: 0.002,
    requestId: 'r2', cumulativeCostUsd: 0.005
  });

  var probeBefore = { usage: 1.00, limit: 5.00, status: 'active' };
  var probeAfter = { usage: 1.005, limit: 5.00, status: 'active' }; // delta = 0.005 = ledgerTotal → MATCH

  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: probeBefore,
    probeAfter: probeAfter,
    ledger: ledgerModule,
    runId: 'test-recon-match'
  });

  assert.strictEqual(result.status, 'MATCH');
  assert.ok(Math.abs(result.deltaReported - 0.005) < 0.0001, 'deltaReported ~0.005');
  assert.ok(Math.abs(result.ledgerTotal - 0.005) < 0.0001, 'ledgerTotal ~0.005');
  assert.ok(Math.abs(result.difference) < 0.001, 'difference ~0');

  // Verify file was written
  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-match');
  assert.strictEqual(recon.status, 'MATCH');

  ledgerModule.clearLedger('test-recon-match');
  done();
});

test('llm: finalizeRunKeyUsage MISMATCH', function(t, done) {
  setupRunsDir();
  clearLedger();

  ledgerModule.writeLedgerEntry('test-recon-mismatch', {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
    promptTokens: 100, completionTokens: 50, costUsd: 0.010,
    requestId: 'r1', cumulativeCostUsd: 0.010
  });

  var probeBefore = { usage: 1.00, limit: 5.00, status: 'active' };
  var probeAfter = { usage: 1.50, limit: 5.00, status: 'active' }; // delta=0.50, ledger=0.01, diff=0.49

  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: probeBefore,
    probeAfter: probeAfter,
    ledger: ledgerModule,
    runId: 'test-recon-mismatch'
  });

  assert.strictEqual(result.status, 'MISMATCH');
  assert.strictEqual(result.deltaReported, 0.50);
  assert.strictEqual(result.ledgerTotal, 0.01);
  assert.strictEqual(result.difference, 0.49);

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-mismatch');
  assert.strictEqual(recon.status, 'MISMATCH');

  ledgerModule.clearLedger('test-recon-mismatch');
  done();
});

test('llm: finalizeRunKeyUsage PROBE_UNAVAILABLE', function(t, done) {
  setupRunsDir();
  clearLedger();

  ledgerModule.writeLedgerEntry('test-recon-unavail', {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
    promptTokens: 100, completionTokens: 50, costUsd: 0.003,
    requestId: 'r1', cumulativeCostUsd: 0.003
  });

  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: null,
    probeAfter: null,
    ledger: ledgerModule,
    runId: 'test-recon-unavail'
  });

  assert.strictEqual(result.status, 'PROBE_UNAVAILABLE');
  assert.strictEqual(result.deltaReported, null);
  assert.strictEqual(result.ledgerTotal, 0.003);

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-unavail');
  assert.strictEqual(recon.status, 'PROBE_UNAVAILABLE');

  ledgerModule.clearLedger('test-recon-unavail');
  done();
});

test('llm: finalizeRunKeyUsage - key string never in written file', function(t, done) {
  setupRunsDir();
  clearLedger();

  // Use a fake key pattern that matches the secret scanner
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-testonly1234567890123456';
  try {
    ledgerModule.writeLedgerEntry('test-recon-nokey', {
      timestamp: '2026-10-03T00:00:00.000Z',
      taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
      promptTokens: 100, completionTokens: 50, costUsd: 0.003,
      requestId: 'r1', cumulativeCostUsd: 0.003
    });

    runReconciliationModule.finalizeRunKeyUsage({
      probeBefore: { usage: 1.00, limit: 5.00, status: 'active' },
      probeAfter: { usage: 1.50, limit: 5.00, status: 'active' },
      ledger: ledgerModule,
      runId: 'test-recon-nokey'
    });

    var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-nokey');
    var reconStr = JSON.stringify(recon);

    // The fake key should NOT appear in the reconciliation file
    assert.strictEqual(reconStr.indexOf('sk-or-v1'), -1, 'API key must not appear in reconciliation file');
    assert.strictEqual(reconStr.indexOf('OPENROUTER_API_KEY'), -1, 'Env var name must not appear in reconciliation file');

    ledgerModule.clearLedger('test-recon-nokey');
    done();
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('llm: finalizeRunKeyUsage no calls writes nothing and returns null', function(t, done) {
  setupRunsDir();
  clearLedger();

  // No ledger entries written

  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: { usage: 1.00, limit: 5.00, status: 'active' },
    probeAfter: { usage: 1.50, limit: 5.00, status: 'active' },
    ledger: ledgerModule,
    runId: 'nonexistent-run-no-calls'
  });

  assert.strictEqual(result, null);

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('nonexistent-run-no-calls');
  assert.strictEqual(recon, null);

  done();
});

test('llm: keyUsageProbe BAD_PROBE_SHAPE -> PROBE_UNAVAILABLE in reconcile', function(t, done) {
  setupRunsDir();
  clearLedger();

  ledgerModule.writeLedgerEntry('test-recon-bad-probe', {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
    promptTokens: 100, completionTokens: 50, costUsd: 0.003,
    requestId: 'r1', cumulativeCostUsd: 0.003
  });

  // probeAfter has BAD_PROBE_SHAPE error
  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: { usage: 1.00, limit: 5.00 },
    probeAfter: { usage: undefined, limit: 5.00, error: { code: 'BAD_PROBE_SHAPE' } },
    ledger: ledgerModule,
    runId: 'test-recon-bad-probe'
  });

  assert.strictEqual(result.status, 'PROBE_UNAVAILABLE');
  assert.strictEqual(result.deltaReported, null);

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-bad-probe');
  assert.strictEqual(recon.status, 'PROBE_UNAVAILABLE');
  assert.strictEqual(recon.toleranceUsd, 0.0001);

  ledgerModule.clearLedger('test-recon-bad-probe');
  done();
});

test('llm: keyUsageProbe parses data-wrapper shape correctly', function(t, done) {
  // Test that the real provider path correctly extracts usage/limit from a
  // data-wrapped response matching real OpenRouter shape:
  // { data: { label, usage, limit, limit_remaining, expires_at } }
  // data.label is NEVER read, stored, or logged.
  var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
  var probe = keyUsageProbeModule.createKeyUsageProbe({
    providerType: 'real',
    fetchFn: function() {
      return Promise.resolve({
        ok: true,
        json: function() {
          return Promise.resolve({
            data: {
              label: 'REDACTED-LABEL',
              usage: 0,
              limit: 20,
              limit_remaining: 20,
              expires_at: '2026-10-29T09:16:00.016Z'
            }
          });
        }
      });
    }
  });

  probe.probeKeyUsage({ apiKey: 'test-key' }).then(function(result) {
    assert.strictEqual(result.usage, 0, 'usage from data wrapper');
    assert.strictEqual(result.limit, 20, 'limit from data wrapper');
    assert.strictEqual(result.limitRemaining, 20, 'limit_remaining from data wrapper');
    assert.strictEqual(result.expiresAt, '2026-10-29T09:16:00.016Z', 'expires_at from data wrapper');
    done();
  }).catch(done);
});

test('llm: finalizeRunKeyUsage delta 0 with ledger 0.002 -> MISMATCH', function(t, done) {
  setupRunsDir();
  clearLedger();

  // ledgerTotal = 0.002, but usageBefore == usageAfter (delta = 0)
  ledgerModule.writeLedgerEntry('test-recon-delta-zero', {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
    promptTokens: 100, completionTokens: 50, costUsd: 0.002,
    requestId: 'r1', cumulativeCostUsd: 0.002
  });

  var probeBefore = { usage: 1.00, limit: 5.00 };
  var probeAfter = { usage: 1.00, limit: 5.00 }; // same as before -> delta = 0

  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: probeBefore,
    probeAfter: probeAfter,
    ledger: ledgerModule,
    runId: 'test-recon-delta-zero'
  });

  assert.strictEqual(result.status, 'MISMATCH', 'delta=0 with ledger activity > tolerance is MISMATCH');
  assert.strictEqual(result.deltaReported, 0);

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-delta-zero');
  assert.strictEqual(recon.status, 'MISMATCH');
  assert.strictEqual(recon.toleranceUsd, 0.0001);

  ledgerModule.clearLedger('test-recon-delta-zero');
  done();
});

test('llm: finalizeRunKeyUsage outside spend 0.005 on top of ledger -> MISMATCH', function(t, done) {
  setupRunsDir();
  ledgerModule.clearLedger('test-recon-outside-spend');

  // ledgerTotal = 0.010, but provider delta only 0.005 (outside spend by 0.005)
  ledgerModule.writeLedgerEntry('test-recon-outside-spend', {
    timestamp: '2026-10-03T00:00:00.000Z',
    taskId: 't1', purpose: 'p1', model: 'z-ai/glm-5.3-flash',
    promptTokens: 200, completionTokens: 100, costUsd: 0.010,
    requestId: 'r1', cumulativeCostUsd: 0.010
  });

  var probeBefore = { usage: 1.00, limit: 5.00 };
  var probeAfter = { usage: 1.005, limit: 5.00 }; // delta = 0.005, ledger = 0.010, diff = 0.005

  var result = runReconciliationModule.finalizeRunKeyUsage({
    probeBefore: probeBefore,
    probeAfter: probeAfter,
    ledger: ledgerModule,
    runId: 'test-recon-outside-spend'
  });

  assert.strictEqual(result.status, 'MISMATCH', 'outside spend beyond tolerance is MISMATCH');
  assert.ok(Math.abs(result.deltaReported - 0.005) < 0.0001, 'deltaReported ~0.005');
  assert.strictEqual(result.ledgerTotal, 0.010);
  assert.ok(Math.abs(result.difference + 0.005) < 0.001, 'difference ~-0.005 (ledger > delta)');

  var recon = keyUsageProbeModule.readKeyUsageReconciliation('test-recon-outside-spend');
  assert.strictEqual(recon.status, 'MISMATCH');
  assert.strictEqual(recon.toleranceUsd, 0.0001);

  ledgerModule.clearLedger('test-recon-outside-spend');
  done();
});

test('llm: circuit breaker integration - isCircuitOpen uses real breaker', function(t, done) {
  var circuitBreakerModule = require('../src/circuitBreaker');
  var circuitBreaker = circuitBreakerModule.createCircuitBreaker({});

  // Open the 'openrouter' circuit (3 failures in 5)
  circuitBreaker.recordOutcome('openrouter', false);
  circuitBreaker.recordOutcome('openrouter', false);
  circuitBreaker.recordOutcome('openrouter', false);

  // Also open the global breaker for isCircuitOpen to see
  var globalBreaker = circuitBreakerModule.getGlobalBreaker();
  globalBreaker.recordOutcome('openrouter', false);
  globalBreaker.recordOutcome('openrouter', false);
  globalBreaker.recordOutcome('openrouter', false);

  // Verify isCircuitOpen returns open state from the global breaker
  var circuitStatus = circuitBreaker.isCircuitOpen('openrouter');
  assert.strictEqual(circuitStatus.open, true, 'Circuit should be open for openrouter');
  assert.strictEqual(circuitStatus.safeStop, true, 'safeStop should be true');
  assert.strictEqual(circuitStatus.state, 'OPEN', 'State should be OPEN');

  // Verify circuit breaker state from breaker itself
  var breakerStats = circuitBreaker.getStats('openrouter');
  assert.strictEqual(breakerStats.state, 'OPEN', 'Breaker state should be OPEN');
  assert.strictEqual(breakerStats.safeStop, true, 'Breaker safeStop should be true');

  done();
});

test('llm: circuit breaker integration - open circuit refuses calls', function(t, done) {
  var circuitBreakerModule = require('../src/circuitBreaker');

  var callCount = 0;
  var mockProvider = mockProviderModule.createMockProvider({
    generate: function() {
      callCount++;
      return Promise.resolve({ text: 'response', model: 'z-ai/glm-5.3-flash' });
    }
  });

  // Use a budget config to ensure budget is not paused
  var llmClient = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 10.0 }
  });

  // Reset and open the global circuit
  circuitBreakerModule.resetGlobalBreaker();
  var breaker = circuitBreakerModule.getGlobalBreaker();
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);
  breaker.recordOutcome('openrouter', false);

  // Try to complete - should be refused because circuit is open
  llmClient.complete({
    messages: [{ role: 'user', content: 'hello' }],
    taskId: 'test-task',
    purpose: 'test',
    runId: 'test-run'
  }).then(function() {
    assert.fail('Should have been rejected due to open circuit');
    done();
  }).catch(function(err) {
    assert.strictEqual(err.name, 'CircuitOpenError', 'Should reject with CircuitOpenError');
    assert.strictEqual(err.safeStop, true, 'CircuitOpenError should have safeStop=true');
    assert.strictEqual(callCount, 0, 'Provider should not have been called');

    // Reset for cleanup
    circuitBreakerModule.resetGlobalBreaker();
    done();
  });
});

test('llm: circuit breaker closed - calls proceed normally', function(t, done) {
  var circuitBreakerModule = require('../src/circuitBreaker');

  // Reset circuit breaker BEFORE creating llmClient
  // so that llmClient's closure captures the fresh breaker
  circuitBreakerModule.resetGlobalBreaker();

  var callCount = 0;
  var mockProvider = mockProviderModule.createMockProvider({
    generate: function() {
      callCount++;
      return Promise.resolve({
        text: 'success response',
        model: 'z-ai/glm-5.3-flash',
        usage: { promptTokens: 10, completionTokens: 20 },
        costUsd: 0.001
      });
    }
  });

  // Create llmClient AFTER reset so it captures the fresh breaker
  var llmClient = llmModule.createLLMClient({
    provider: mockProvider,
    budgetConfig: { totalUsd: 10.0 }
  });

  // Verify circuit is closed
  var circuitStatus = llmClient.isCircuitOpen('openrouter');
  assert.strictEqual(circuitStatus.open, false, 'Circuit should be closed');
  assert.strictEqual(circuitStatus.safeStop, false, 'safeStop should be false');

  llmClient.complete({
    messages: [{ role: 'user', content: 'hello' }],
    taskId: 'test-task',
    purpose: 'test',
    runId: 'test-run'
  }).then(function(result) {
    assert.strictEqual(callCount, 1, 'Provider should have been called once');
    assert.strictEqual(result.text, 'success response', 'Should return response');
    done();
  }).catch(function(err) {
    assert.fail('Should not have failed: ' + err.message + ' (' + err.name + ')');
    done();
  });
});

test('llm: no src/ file emits PASS as a final verdict (grep test)', function(t, done) {
  var srcDir = path.resolve(__dirname, '..', 'src');
  var decisionModuleDir = path.resolve(srcDir, 'decision');

  // Files in src/ that we should check (recursively)
  var filesWithPASS = [];

  function checkFile(filePath) {
    try {
      var content = fs.readFileSync(filePath, 'utf8');
      // Check for the string 'PASS' as a status value (not in comments, not in strings)
      // Simple heuristic: look for 'PASS' that appears in a status/verdict context
      // We look for patterns like : 'PASS' or : "PASS" (not in URLs or identifiers)
      var passRegex = /['"]PASS['"]/g;
      var matches = content.match(passRegex);
      if (matches && matches.length > 0) {
        // Check if it's in a decision module directory (excluded)
        if (filePath.indexOf(decisionModuleDir) === 0) {
          return; // Excluded - future decision module
        }
        // Allow exactly the single sanctioned RESULT_PASS definition line in
        // src/terminalState.js; any other 'PASS' literal in src/ still fails
        var barePASS = content.split('\n').filter(function(line) {
          return /['"]PASS['"]/.test(line) && !/RESULT_PASS\s*=\s*'PASS'\s*;/.test(line);
        });
        if (barePASS.length === 0) {
          return;
        }
        filesWithPASS.push(filePath + ' -> ' + barePASS.join(' | '));
      }
    } catch (e) {
      // Skip files that can't be read
    }
  }

  function walkDir(dir) {
    try {
      var entries = fs.readdirSync(dir, { withFileTypes: true });
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          checkFile(fullPath);
        }
      }
    } catch (e) {
      // Skip directories that can't be read
    }
  }

  walkDir(srcDir);

  assert.strictEqual(filesWithPASS.length, 0,
    'No src/ file should contain \'PASS\' as a final verdict. Found: ' + filesWithPASS.join('; '));

  done();
});

// Cleanup after all tests
test.after(function() {
  cleanupRunsDir();
  try { delete process.env.OPENROUTER_API_KEY; } catch (e) {}
  try { delete process.env.LLM_BUDGET_TOTAL_USD; } catch (e) {}
  try { delete process.env.LLM_BUDGET_WARNING_THRESHOLD; } catch (e) {}
});
