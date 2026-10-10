'use strict';

var fs = require('fs');
var path = require('path');

var repairAgent = require('../demo/repairAgent');
var mockRepairProvider = require('../demo/mockRepairProvider');
var verifyRunner = require('../demo/verifyRunner');
var configModule = require('../config');
var preflightModule = require('../preflight');
var openrouterProviderModule = require('../llm/openrouterProvider');

async function handleDemoRepair(parsed, deps) {
  deps = deps || {};
  var consoleObj = deps.console || console;
  var getEnv = deps.getEnv || function() { return process.env; };
  var parseArgs = deps.parseArgs;

  var providerType = parsed.provider || 'mock';
  var scenario = parsed.scenario || null;
  var acceptNoSandbox = !!parsed.iAcceptNoSandbox;

  var runId = 'demo-repair-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);

  // Real provider gate: OPENROUTER_API_KEY must be present
  if (providerType === 'real') {
    if (!getEnv()['OPENROUTER_API_KEY']) {
      if (consoleObj.error) consoleObj.error('demo-repair: OPENROUTER_API_KEY not set, exiting with code 4');
      return Promise.resolve({ exitCode: 4 });
    }

    // Sandbox gate: permission model must be available OR --i-accept-no-sandbox must be set
    var permissionModelUsed = verifyRunner.isPermissionModelAvailable();
    if (!permissionModelUsed && !acceptNoSandbox) {
      if (consoleObj.error) consoleObj.error('demo-repair: sandbox (Node permission model) unavailable, exiting with code 5');
      return Promise.resolve({ exitCode: 5 });
    }
  }

  var provider = null;
  if (providerType === 'mock') {
    provider = mockRepairProvider.createMockRepairProvider(scenario || 'fix-on-second');
  } else if (providerType === 'real') {
    provider = openrouterProviderModule.createOpenRouterProvider();
  }

  var result = await repairAgent.runDemoRepair({
    provider: provider,
    providerType: providerType,
    runId: runId,
    scenario: scenario,
    acceptNoSandbox: acceptNoSandbox
  });

  if (result.result === 'PASS_CANDIDATE' || result.result === 'NO_REPAIR_NEEDED') {
    return { exitCode: 0 };
  } else {
    return { exitCode: 1 };
  }
}

module.exports = { handleDemoRepair: handleDemoRepair };