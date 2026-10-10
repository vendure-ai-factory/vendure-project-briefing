'use strict';

/**
 * LLM smoke test script - verifies OpenRouter API key and connectivity.
 *
 * Requires: OPENROUTER_API_KEY env var and real-provider setting.
 * Exits with message if requirements not met (never runs silently).
 *
 * Flow: probe before -> one LLM call -> probe after -> finalizeRunKeyUsage
 * Prints: model, tokens, costUsd, ledgerTotal, deltaReported, status
 * Never prints: the key or any headers.
 */

var fs = require('fs');
var path = require('path');

var openrouterModule = require('../src/llm/openrouterProvider');
var keyUsageProbeModule = require('../src/llm/keyUsageProbe');
var ledgerModule = require('../src/llm/usageLedger');
var runReconciliationModule = require('../src/llm/runReconciliation');
var llmModule = require('../src/llm/index');

function main() {
  // Check OPENROUTER_API_KEY
  var apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('llm-smoke: OPENROUTER_API_KEY is not set. Exiting.');
    process.exit(1);
  }

  var runId = 'smoke-' + Date.now().toString(36);

  // Ensure runs/<runId> directory exists for ledger
  var runsDir = path.resolve(process.cwd(), 'runs');
  var runDir = path.join(runsDir, runId);
  try {
    if (!fs.existsSync(runDir)) {
      fs.mkdirSync(runDir, { recursive: true });
    }
  } catch (e) {
    console.error('llm-smoke: Failed to create run directory: ' + e.message);
    process.exit(1);
  }

  // Create key usage probe and real provider
  var probe = keyUsageProbeModule.createKeyUsageProbe({ providerType: 'real' });
  var openrouterProvider = openrouterModule.createOpenRouterProvider();
  var llmClient = llmModule.createLLMClient({ provider: openrouterProvider });

  var probeBefore = null;
  var probeAfter = null;

  // Probe before
  probe.probeKeyUsage({ apiKey: apiKey }).then(function(beforeResult) {
    probeBefore = beforeResult;

    // One LLM call
    return llmClient.complete({
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      taskId: 'smoke-test',
      purpose: 'smoke',
      model: 'z-ai/glm-5.3-flash',
      runId: runId
    });
  }).then(function(llmResult) {
    // Probe after
    return probe.probeKeyUsage({ apiKey: apiKey }).then(function(afterResult) {
      probeAfter = afterResult;
      return llmResult;
    });
  }).then(function(llmResult) {
    // Finalize reconciliation
    var reconciliation = runReconciliationModule.finalizeRunKeyUsage({
      probeBefore: probeBefore,
      probeAfter: probeAfter,
      ledger: ledgerModule,
      runId: runId
    });

    // Print results - never print key or headers
    console.log('model: ' + (llmResult.model || 'unknown'));
    console.log('tokens: prompt=' + (llmResult.usage ? llmResult.usage.promptTokens : '?') +
                ' completion=' + (llmResult.usage ? llmResult.usage.completionTokens : '?'));
    console.log('costUsd: ' + (llmResult.costUsd || 0));

    if (reconciliation) {
      console.log('ledgerTotal: ' + reconciliation.ledgerTotal);
      console.log('deltaReported: ' + (reconciliation.deltaReported !== null ? reconciliation.deltaReported : 'n/a'));
      console.log('status: ' + reconciliation.status);
    } else {
      console.log('ledgerTotal: 0');
      console.log('deltaReported: n/a');
      console.log('status: NO_CALLS');
    }

    // Cleanup run dir
    try {
      ledgerModule.clearLedger(runId);
      if (fs.existsSync(runDir)) {
        fs.rmdirSync(runDir);
      }
    } catch (e) {}

    process.exit(0);
  }).catch(function(err) {
    console.error('llm-smoke: Error: ' + err.message);
    // Cleanup
    try {
      ledgerModule.clearLedger(runId);
      if (fs.existsSync(runDir)) {
        fs.rmdirSync(runDir);
      }
    } catch (e) {}
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main: main };