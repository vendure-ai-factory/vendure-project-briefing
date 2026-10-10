'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var executorModule = require('../src/executor');
var executorsIndex = require('../src/executors');

// The exact task ids registered before this chunk: CAN-B1-03, CAN-B1-04,
// CAN-B2-16, CAN-B2-08, CAN-B2-04. The CHECK-SECURITY-SUITE / CHECK-LOAD-SUITE
// entries live in src/ (not src/executors/) and are not registered today, so
// they must not appear in the discovered set.
var PREVIOUS_TASK_IDS = ['CAN-B1-03', 'CAN-B1-04', 'CAN-B2-16', 'CAN-B2-08', 'CAN-B2-04'];

function makeFakeModuleDir(files) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-index-'));
  Object.keys(files).forEach(function(name) {
    fs.writeFileSync(path.join(dir, name + '.js'), files[name]);
  });
  return dir;
}

var MODULE_WITH_REGISTER =
  "'use strict'; function register(reg) { reg.registerTaskExecutor('CAN-INDEX-01', { handler: function() { return {}; } }); } module.exports = { register: register };\n";

// Compute the ids the executor modules themselves register, from the same
// directory and with the same exclusions the index scans, so adding an
// executor needs no edit here: the equality below then covers the new id
// automatically instead of pinning an exact hard-coded list.
function idsRegisteredByModules() {
  var dir = path.join(__dirname, '..', 'src', 'executors');
  var raw = [];
  fs.readdirSync(dir).sort().forEach(function(name) {
    if (name.length < 3 || name.slice(-3) !== '.js') return;
    if (executorsIndex.EXCLUDED_FILES.indexOf(name) !== -1) return;
    var mod = require(path.join(dir, name));
    if (typeof mod.register !== 'function') return;
    mod.register({
      registerTaskExecutor: function(taskId) { raw.push(taskId); }
    });
  });
  return raw;
}

test('executors index: discovered registered list keeps the originals and matches the module-registered ids', function(t, done) {
  var moduleIds = idsRegisteredByModules();
  // A module must not register the same task id twice.
  assert.strictEqual(new Set(moduleIds).size, moduleIds.length);
  var expected = moduleIds.slice().sort();

  executorModule.resetTaskExecutors();
  var outcome = executorsIndex.register(executorModule);
  assert.ok(outcome);
  var actual = executorModule.listTaskExecutors().sort();

  // The five task ids that predate this refactor must still be registered.
  PREVIOUS_TASK_IDS.forEach(function(id) {
    assert.ok(actual.indexOf(id) !== -1, 'missing previously registered task id ' + id);
  });

  // The discovered set equals exactly what the modules themselves register:
  // nothing unexpected, nothing missing, no duplicates.
  assert.deepStrictEqual(actual, expected);
  executorModule.resetTaskExecutors();
  done();
});

test('executors index: a module without register is skipped and listed in the debug array', function(t, done) {
  var dir = makeFakeModuleDir({
    plain: "'use strict'; module.exports = { note: 'no register' };\n",
    real: MODULE_WITH_REGISTER
  });
  executorModule.resetTaskExecutors();
  var outcome = executorsIndex.discover({ dir: dir, executorModule: executorModule });
  assert.deepStrictEqual(outcome.skipped, ['plain.js']);
  assert.deepStrictEqual(executorModule.listTaskExecutors().sort(), ['CAN-INDEX-01']);
  executorModule.resetTaskExecutors();
  fs.rmSync(dir, { recursive: true, force: true });
  done();
});

test('executors index: two modules registering the same task id raise a clear error', function(t, done) {
  function moduleFor(id) {
    return "'use strict'; function register(reg) { reg.registerTaskExecutor('" + id +
      "', { handler: function() { return {}; } }); } module.exports = { register: register };\n";
  }
  var dir = makeFakeModuleDir({
    a: moduleFor('CAN-INDEX-02'),
    b: moduleFor('CAN-INDEX-02')
  });
  executorModule.resetTaskExecutors();
  assert.throws(function() {
    executorsIndex.discover({ dir: dir, executorModule: executorModule });
  }, /Duplicate task id CAN-INDEX-02/);
  executorModule.resetTaskExecutors();
  fs.rmSync(dir, { recursive: true, force: true });
  done();
});
