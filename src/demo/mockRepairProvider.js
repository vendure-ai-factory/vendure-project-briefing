'use strict';

var fs = require('fs');
var path = require('path');

function createMockRepairProvider(scenario, overrideModel) {
  scenario = scenario || 'fix-on-second';
  var fixturesRoot = path.resolve(__dirname, 'fixtures');
  var callCount = 0;

  var provider = {
    complete: function(options) {
      callCount++;
      options = options || {};

      var resolvedModel = overrideModel || 'mock-repair';

      // Error-simulation scenarios: throw the appropriate error
      if (scenario === 'budget-pause') {
        var err = new Error('Budget limit reached');
        err.name = 'BudgetPausedError';
        return Promise.reject(err);
      }
      if (scenario === 'circuit-open') {
        var err2 = new Error('Circuit breaker open');
        err2.name = 'CircuitOpenError';
        return Promise.reject(err2);
      }
      if (scenario === 'model-lock') {
        var err3 = new Error('Model is locked');
        err3.name = 'ModelLockError';
        return Promise.reject(err3);
      }
      if (scenario === 'infra-fault') {
        var err4 = new Error('Infrastructure fault');
        err4.name = 'InfrastructureFaultError';
        return Promise.reject(err4);
      }

      var fixtureName = scenario;
      // Multi-attempt scenarios: cycle through different fixtures
      if (scenario === 'fix-on-second') {
        fixtureName = callCount === 1 ? 'wrong1' : 'correct';
      } else if (scenario === 'never-fixed') {
        if (callCount === 1) fixtureName = 'wrong1';
        else if (callCount === 2) fixtureName = 'wrong2';
        else fixtureName = 'wrong3';
      }

      var fixturePath = path.join(fixturesRoot, fixtureName + '.js.txt');
      var text = '';
      try {
        text = fs.readFileSync(fixturePath, 'utf8');
      } catch (err) {
        text = '// No fixture for: ' + scenario + ' call ' + callCount;
      }

      // Fixtures that already begin with a fence are full raw LLM responses and
      // are returned as-is; bare code fixtures are wrapped in the fence the
      // repair agent expects so they look like a normal LLM reply.
      var isRawResponse = /^\s*```/.test(text);
      var responseText = isRawResponse ? text : ('```js catalog.mjs\n' + text + '\n```');

      if (scenario === 'bad-otherfile' && options.runId) {
        // Simulate the model touching a non-allowlisted file so the git-tree
        // guard (enforceAllowlist) is exercised and the attempt is rejected.
        var strayDir = path.resolve(__dirname, '..', '..', 'runs', options.runId, 'workspace', 'evaluation-demo', 'app', 'fixtures');
        try {
          fs.mkdirSync(strayDir, { recursive: true });
          fs.writeFileSync(path.join(strayDir, 'another.js'), '// malicious stub\n', 'utf8');
        } catch (e) { /* ignore */ }
      }

      return Promise.resolve({
        text: responseText,
        model: resolvedModel,
        usage: { promptTokens: 0, completionTokens: 0 },
        costUsd: 0,
        requestId: 'mock-' + Date.now()
      });
    }
  };

  return provider;
}

module.exports = { createMockRepairProvider: createMockRepairProvider };
