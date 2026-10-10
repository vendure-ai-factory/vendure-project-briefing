'use strict';

/**
 * Executor auto-discovery (chunk 12a).
 *
 * Scans its own directory for *.js modules, requires every one except this
 * index and shopApiSession.js (a credential/session module, never an
 * executor), and calls register() on each module that exports a register
 * function. Modules without a register function are skipped and listed in the
 * returned debug array. Registering the same task id from two different
 * modules raises a clear error so a colliding executor cannot silently
 * overwrite another. New executors need no edits here or in cli.js: drop a
 * module exporting register() into src/executors/ and it is picked up
 * automatically.
 */

var fs = require('fs');
var path = require('path');
var executorModule = require('../executor');

// Never treated as task executors.
var EXCLUDED_FILES = ['index.js', 'shopApiSession.js'];

function isJsFile(name) {
  return name.length >= 3 && name.indexOf('.js') === name.length - 3;
}

function sortedTaskIds(reg) {
  if (!reg || typeof reg.listTaskExecutors !== 'function') return [];
  try {
    return reg.listTaskExecutors().slice().sort();
  } catch (e) {
    return [];
  }
}

/**
 * Scan dir (default: this folder) and register every module that exports a
 * register() function. Returns { registered, skipped } where skipped is the
 * debug array of module filenames without a register function.
 */
function discover(options) {
  options = options || {};
  var dir = options.dir || __dirname;
  var reg = options.executorModule || executorModule;
  var excluded = EXCLUDED_FILES.slice();
  if (Array.isArray(options.excludedFiles)) {
    excluded = excluded.concat(options.excludedFiles);
  }

  if (!reg || typeof reg.registerTaskExecutor !== 'function') {
    throw new Error('executor discovery: executorModule must expose registerTaskExecutor');
  }

  var entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new Error('executor discovery: cannot read ' + dir + ' (' + err.message + ')');
  }

  var files = entries
    .filter(isJsFile)
    .filter(function(name) { return excluded.indexOf(name) === -1; })
    .sort();

  // Task id -> filename of the first module that claimed it, so a second
  // module claiming the same id is rejected with both names.
  var claimed = {};
  var registered = [];
  // Debug array of modules without a register function.
  var skipped = [];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var modulePath = path.join(dir, file);
    var mod;
    try {
      mod = require(modulePath);
    } catch (err) {
      throw new Error('executor discovery: failed to load ' + file + ' (' + err.message + ')');
    }
    if (typeof mod.register !== 'function') {
      skipped.push(file);
      continue;
    }

    var original = reg.registerTaskExecutor;
    var before = sortedTaskIds(reg);
    var proxy = {
      registerTaskExecutor: function(taskId, config) {
        if (claimed.hasOwnProperty(taskId)) {
          throw new Error('Duplicate task id ' + taskId + ' (registered by ' + claimed[taskId] + ' and ' + file + ')');
        }
        claimed[taskId] = file;
        return original.call(reg, taskId, config);
      }
    };
    mod.register(proxy);
    var after = sortedTaskIds(reg);
    for (var j = 0; j < after.length; j++) {
      var id = after[j];
      if (before.indexOf(id) === -1 && registered.indexOf(id) === -1) {
        registered.push(id);
      }
    }
  }

  return { registered: registered, skipped: skipped };
}

function register(reg, options) {
  var opts = options ? Object.assign({}, options) : {};
  opts.executorModule = reg;
  return discover(opts);
}

module.exports = {
  EXCLUDED_FILES: EXCLUDED_FILES.slice(),
  discover: discover,
  register: register
};
