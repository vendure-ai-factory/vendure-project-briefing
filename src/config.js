'use strict';

var fs = require('fs');
var path = require('path');

var CONFIG_PATH = path.resolve(process.cwd(), '.env');

var config = null;

function loadConfig() {
  if (config) {
    return config;
  }

  var rawConfig = {};
  var configStatus = {
    OPENROUTER_API_KEY: 'not configured',
    OPENROUTER_MODEL: 'not configured',
    PIPELINE_WORKSPACE_ROOT: 'not configured',
    PIPELINE_LOG_LEVEL: 'not configured'
  };

  if (fs.existsSync(CONFIG_PATH)) {
    var lines = fs.readFileSync(CONFIG_PATH, 'utf8').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line && !line.startsWith('#')) {
        var parts = line.split('=');
        if (parts.length >= 2) {
          var key = parts[0].trim();
          var value = parts.slice(1).join('=').trim();
          rawConfig[key] = value;
        }
      }
    }
  }

  if (rawConfig.OPENROUTER_API_KEY) {
    configStatus.OPENROUTER_API_KEY = 'configured';
  }
  if (rawConfig.OPENROUTER_MODEL) {
    configStatus.OPENROUTER_MODEL = rawConfig.OPENROUTER_MODEL;
  }
  if (rawConfig.PIPELINE_WORKSPACE_ROOT) {
    configStatus.PIPELINE_WORKSPACE_ROOT = rawConfig.PIPELINE_WORKSPACE_ROOT;
  } else {
    configStatus.PIPELINE_WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
  }
  if (rawConfig.PIPELINE_LOG_LEVEL) {
    configStatus.PIPELINE_LOG_LEVEL = rawConfig.PIPELINE_LOG_LEVEL;
  } else {
    configStatus.PIPELINE_LOG_LEVEL = 'info';
  }

  config = {
    openrouterApiKey: rawConfig.OPENROUTER_API_KEY || null,
    openrouterModel: rawConfig.OPENROUTER_MODEL || rawConfig.LLM_MODEL || 'z-ai/glm-5.3-flash',
    pipelineWorkspaceRoot: configStatus.PIPELINE_WORKSPACE_ROOT,
    pipelineLogLevel: configStatus.PIPELINE_LOG_LEVEL,
    _rawConfig: rawConfig,
    _configStatus: configStatus
  };

  return config;
}

function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

function getConfigStatus() {
  var cfg = getConfig();
  return cfg._configStatus;
}

function isApiKeyConfigured() {
  var cfg = getConfig();
  return cfg.openrouterApiKey !== null && cfg.openrouterApiKey !== '';
}

module.exports = {
  loadConfig: loadConfig,
  getConfig: getConfig,
  getConfigStatus: getConfigStatus,
  isApiKeyConfigured: isApiKeyConfigured
};