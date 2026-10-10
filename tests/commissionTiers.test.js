'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var childProcess = require('child_process');

var executors = require('../src/executors/commissionTiers');
var terminalState = require('../src/terminalState');
var executorModule = require('../src/executor');

var RESULT_PASS = terminalState.RESULT_PASS;
var REPO_ROOT = path.resolve(__dirname, '..');
var SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/generated/set_commission_tiers.mjs');

function fakeClock(iso) {
  var current = new Date(iso || '2026-10-07T09:00:00.000Z');
  return function() { return new Date(current.getTime()); };
}

function taskFor(taskId, expectedResult) {
  return {
    canonicalId: taskId,
    summaryIds: ['B2-05'],
    requiredInputs: ['stagingUrl', 'testAccounts', 'exchangeRates', 'splitTiers'],
    expectedResult: expectedResult || ('expected result for ' + taskId)
  };
}

function realWorkspace(prefix) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ws-ct-'));
  return { workspaceId: 'ws-ct', workspacePath: dir, runId: 'run-ct', exists: true };
}

function baseDeps(execFile) {
  return {
    execFile: execFile || childProcess.execFile,
    writeFileSync: function(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    mkdirSync: function(p, o) { fs.mkdirSync(p, o || { recursive: true }); },
    readFileSync: function(p, e) { return fs.readFileSync(p, e || 'utf8'); },
    readdirSync: function(p, o) { return fs.readdirSync(p, o || { withFileTypes: true }); },
    existsSync: function(p) { return fs.existsSync(p); }
  };
}

function baseContext(overrides) {
  overrides = overrides || {};
  var ws = overrides.workspace || realWorkspace();
  var ctx = {
    taskId: 'CAN-B2-08',
    task: taskFor('CAN-B2-08', 'expected result for CAN-B2-08'),
    workspace: ws,
    runEnvRecord: { runId: ws.runId, gitHead: 'deadbeef1234', revisionId: 'rev-t' },
    repoRoot: REPO_ROOT,
    deps: baseDeps(overrides.execFile)
  };
  if (overrides.runId) ctx.runId = overrides.runId;
  if (overrides.fixtures) ctx.fixtures = overrides.fixtures;
  if (overrides.extraDeps) Object.assign(ctx.deps, overrides.extraDeps);
  return ctx;
}

function finalizeLikeCli(outcome, taskId) {
  return terminalState.finalizeTaskOutcome({
    applicable: true,
    executorFound: true,
    evidence: outcome.evidence,
    expected: 'expected result for ' + (taskId || 'unknown'),
    actual: outcome.actual,
    executorEvidenceOk: outcome.success === true,
    error: outcome.error,
    errorCode: outcome.errorCode
  });
}

// ---------------------------------------------------------------------------
// Script-level: run the actual generated script as a child process. The
// script's own exports are exercised via a real CLI invocation so the schema
// validation and dry-run/apply write behaviours are tested directly.
// ---------------------------------------------------------------------------

function runScript(args, env) {
  return new Promise(function(resolve) {
    childProcess.execFile(process.execPath, [SCRIPT_PATH].concat(args), {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, env || {})
    }, function(err, stdout, stderr) {
      resolve({
        exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
  });
}

function writeFixture(dir, name, config) {
  var p = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return p;
}

function listFilesUnder(rootDir) {
  var out = [];
  function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function(e) {
      var fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else out.push(fp);
    });
  }
  walk(rootDir);
  return out;
}

var DE_BANDS = [
  { from: 0, to: 3, platformSharePct: 0 },
  { from: 3, to: 7, platformSharePct: 20 },
  { from: 7, to: 20, platformSharePct: 60 },
  { from: 20, to: 50, platformSharePct: 80 },
  { from: 50, to: null, platformSharePct: 90 }
];

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validConfig() {
  return {
    schemaVersion: '1.0',
    countries: {
      DE: { currency: 'EUR', origin: 'test', bands: deepClone(DE_BANDS) }
    }
  };
}

test('set_commission_tiers: valid config passes and result.json has boundary checks', async function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-script-'));
  var artifactRoot = path.join(tmp, 'work/tmp/commission-tiers');
  var configPath = path.join(tmp, 'work/tmp/config-in.json');
  var configOut = path.join(tmp, 'out/commission_tiers.json');
  writeFixture(path.dirname(configPath), 'config-in.json', validConfig());

  var res = await runScript(['--config=' + configPath], {
    COMMISSION_TIERS_ARTIFACT_ROOT: artifactRoot,
    COMMISSION_TIERS_CONFIG_PATH: configOut
  });
  assert.strictEqual(res.exitCode, 0, 'dry-run should pass: ' + res.stderr);
  assert.ok(res.stdout.indexOf('platform 0%') !== -1, 'prints the tier table');

  var files = listFilesUnder(tmp);
  var resultJson = files.find(function(f) { return f.indexOf('result.json') !== -1; });
  var summaryTxt = files.find(function(f) { return f.indexOf('summary.txt') !== -1; });
  assert.ok(resultJson, 'result.json written under the artifact root');
  assert.ok(summaryTxt, 'summary.txt written under the artifact root');
  assert.ok(files.indexOf(configOut) === -1, 'no config written in dry-run');

  var parsed = JSON.parse(fs.readFileSync(resultJson, 'utf8'));
  assert.strictEqual(parsed.mode, 'dry-run');
  assert.ok(parsed.configSha256, 'config hash present');
  assert.ok(parsed.boundaryChecks.DE, 'boundary checks present');
  assert.ok(parsed.boundaryChecks.DE.length > 0, 'boundary checks non-empty');
  var boundary3 = parsed.boundaryChecks.DE.find(function(c) { return c.amount === 3; });
  assert.strictEqual(boundary3.platformSharePct, 20);
  assert.strictEqual(boundary3.platform, 0.6, 'amount 3 in EUR: platform 20% of 3');
  assert.strictEqual(boundary3.designer, 2.4);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('set_commission_tiers: a gap between bands is rejected', async function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-script-'));
  var cfg = validConfig();
  cfg.countries.DE.bands[1].from = 4; // gap 3 -> 4
  var configPath = path.join(tmp, 'gap.json');
  writeFixture(tmp, 'gap.json', cfg);
  var res = await runScript(['--config=' + configPath], {
    COMMISSION_TIERS_ARTIFACT_ROOT: path.join(tmp, 'art'),
    COMMISSION_TIERS_CONFIG_PATH: path.join(tmp, 'out.json')
  });
  assert.notStrictEqual(res.exitCode, 0, 'gap must fail validation');
  assert.ok(res.stderr.indexOf('not contiguous') !== -1, 'names the contiguity failure: ' + res.stderr);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('set_commission_tiers: an overlap is rejected', async function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-script-'));
  var cfg = validConfig();
  cfg.countries.DE.bands[1].from = 2; // overlap: previous covers up to 3
  var configPath = path.join(tmp, 'overlap.json');
  writeFixture(tmp, 'overlap.json', cfg);
  var res = await runScript(['--config=' + configPath], {
    COMMISSION_TIERS_ARTIFACT_ROOT: path.join(tmp, 'art'),
    COMMISSION_TIERS_CONFIG_PATH: path.join(tmp, 'out.json')
  });
  assert.notStrictEqual(res.exitCode, 0, 'overlap must fail validation');
  assert.ok(res.stderr.indexOf('not contiguous') !== -1, 'names the overlap: ' + res.stderr);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('set_commission_tiers: a share above 100 is rejected', async function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-script-'));
  var cfg = validConfig();
  cfg.countries.DE.bands[0].platformSharePct = 101;
  var configPath = path.join(tmp, 'high.json');
  writeFixture(tmp, 'high.json', cfg);
  var res = await runScript(['--config=' + configPath], {
    COMMISSION_TIERS_ARTIFACT_ROOT: path.join(tmp, 'art'),
    COMMISSION_TIERS_CONFIG_PATH: path.join(tmp, 'out.json')
  });
  assert.notStrictEqual(res.exitCode, 0, 'share > 100 must fail validation');
  assert.ok(res.stderr.indexOf('0 and 100') !== -1, 'names the range: ' + res.stderr);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('set_commission_tiers: dry-run writes nothing outside the artifact root', async function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-script-'));
  var artifactRoot = path.join(tmp, 'work/tmp/commission-tiers');
  var configPath = path.join(tmp, 'cfg.json');
  writeFixture(tmp, 'cfg.json', validConfig());
  var res = await runScript(['--config=' + configPath], {
    COMMISSION_TIERS_ARTIFACT_ROOT: artifactRoot,
    COMMISSION_TIERS_CONFIG_PATH: path.join(tmp, 'should-not-exist/commission_tiers.json')
  });
  assert.strictEqual(res.exitCode, 0, res.stderr);
  var files = listFilesUnder(tmp);
  assert.ok(files.every(function(f) { return f.indexOf(artifactRoot) === 0 || f === configPath; }),
    'nothing written outside artifact root + input config: ' + files.join('; '));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('set_commission_tiers: --apply writes only the config file', async function(t) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-script-'));
  var artifactRoot = path.join(tmp, 'work/tmp/commission-tiers');
  var configPath = path.join(tmp, 'cfg.json');
  var configOut = path.join(tmp, 'config/commission_tiers.json');
  writeFixture(tmp, 'cfg.json', validConfig());
  var res = await runScript(['--config=' + configPath, '--apply'], {
    COMMISSION_TIERS_ARTIFACT_ROOT: artifactRoot,
    COMMISSION_TIERS_CONFIG_PATH: configOut
  });
  assert.strictEqual(res.exitCode, 0, res.stderr);
  assert.ok(fs.existsSync(configOut), 'config file written');
  var parsed = JSON.parse(fs.readFileSync(configOut, 'utf8'));
  assert.strictEqual(parsed.countries.DE.currency, 'EUR');

  var files = listFilesUnder(tmp);
  var outside = files.filter(function(f) {
    return f !== configPath && f !== configOut;
  });
  assert.deepStrictEqual(outside, [], '--apply writes ONLY the config file (plus input): ' + outside.join('; '));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Script exports: split function gives designer + platform at every boundary
// ---------------------------------------------------------------------------

test('set_commission_tiers exports: computeSplit returns platform + designer at every boundary', async function(t) {
  var mod = await import(pathToFileUrl(SCRIPT_PATH));
  var bands = DE_BANDS;
  var boundaries = mod.boundaryAmounts(bands);
  assert.ok(boundaries.indexOf(3) !== -1, 'limit 3 included');
  assert.ok(boundaries.indexOf(2.99) !== -1, 'just below 3 included');
  assert.ok(boundaries.indexOf(3.01) !== -1, 'just above 3 included');

  var at3 = mod.computeSplit(bands, 3);
  assert.strictEqual(at3.platformSharePct, 20);
  assert.strictEqual(at3.platform, 0.6);
  assert.strictEqual(at3.designer, 2.4);

  var below = mod.computeSplit(bands, 2.99);
  assert.strictEqual(below.platformSharePct, 0);
  assert.strictEqual(below.platform, 0);

  var above = mod.computeSplit(bands, 3.01);
  assert.strictEqual(above.platformSharePct, 20);

  // open-ended last band: everything at/above 50 is 90/10
  var at50 = mod.computeSplit(bands, 50);
  assert.strictEqual(at50.platformSharePct, 90);
  assert.strictEqual(at50.platform, 45);
  assert.strictEqual(at50.designer, 5);
});

function pathToFileUrl(filePath) {
  var resolved = path.resolve(filePath);
  return require('url').pathToFileURL(resolved).href;
}

// ---------------------------------------------------------------------------
// Executor: PASS path, mirror checks, evidence persistence, register()
// ---------------------------------------------------------------------------

/**
 * A fake script execution that writes result.json (with boundaryChecks from
 * the script's own exports) and summary.txt under the artifact root, then (for
 * --apply) writes the config file. Mirrors what the real generated script does.
 */
function makeScriptExec(calls) {
  return async function(file, args, options, cb) {
    if (calls) calls.push({ file: file, args: args.slice(), options: options });
    try {
      var configArg = args.find(function(a) { return a.indexOf('--config=') === 0; });
      if (!configArg) throw new Error('no --config arg');
      var configPath = configArg.split('=').slice(1).join('=');
      var fixture = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      var apply = args.indexOf('--apply') !== -1;
      var artifactRoot = options.env.COMMISSION_TIERS_ARTIFACT_ROOT;
      var configOut = options.env.COMMISSION_TIERS_CONFIG_PATH;
      var timestamp = '2026-10-07T09-00-00-000Z';

      if (apply) {
        fs.mkdirSync(path.dirname(configOut), { recursive: true });
        fs.writeFileSync(configOut, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
        cb(null, 'config written\n', '');
        return;
      }

      // dry-run: write boundary checks consistent with the input config.
      return import(pathToFileUrl(SCRIPT_PATH)).then(function(mod) {
        var checks = {};
        Object.keys(fixture.countries).sort().forEach(function(code) {
          var bands = fixture.countries[code].bands;
          checks[code] = mod.boundaryAmounts(bands).map(function(amount) {
            var tier = mod.resolveTier(bands, amount);
            var split = mod.computeSplit(bands, amount);
            return { amount: amount, from: tier.from, to: tier.to, platformSharePct: tier.platformSharePct, platform: split.platform, designer: split.designer };
          });
        });
        var dir = path.join(artifactRoot, timestamp);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
          schemaVersion: '1.0', mode: 'dry-run', timestamp: timestamp,
          config: fixture, configSha256: executors.sha256Hex(JSON.stringify(fixture, null, 2) + '\n'),
          boundaryChecks: checks
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'summary.txt'), 'DE (EUR)\n', 'utf8');
        cb(null, 'PASS\n', '');
      }).catch(function(e) { throw e; });
    } catch (e) {
      cb({ code: 1, message: String((e && e.message) || e) }, '', '');
    }
  };
}

test('commissionTiers: valid synthetic fixture, all boundary splits match -> PASS', async function(t) {
  var calls = [];
  var ctx = baseContext({ execFile: makeScriptExec(calls) });
  var outcome = await executors.handlerCommissionTiers(ctx);

  assert.strictEqual(outcome.success, true, 'run should succeed');
  assert.strictEqual(outcome.result, RESULT_PASS, 'must use RESULT_PASS');
  assert.strictEqual(outcome.actual, 'expected result for CAN-B2-08');
  assert.ok(outcome.evidence, 'evidence present');

  var ev = outcome.evidence;
  assert.strictEqual(ev.scope, 'commission-tiers');
  assert.strictEqual(ev.executionRevision, 'deadbeef1234', 'execution revision captured');
  assert.strictEqual(ev.script.repoRelativePath, executors.GENERATED_SCRIPT);
  assert.strictEqual(ev.checks.exitDryRun, 0);
  assert.strictEqual(ev.checks.exitApply, 0);
  assert.strictEqual(ev.checks.artifactsFound, true);
  assert.strictEqual(ev.checks.allSplitsMatch, true);
  assert.strictEqual(ev.checks.noApiCall, true);
  assert.strictEqual(ev.checks.credentialsAbsent, true);
  assert.ok(ev.inputs.sha256, 'inputs hash present');
  assert.ok(ev.outputConfigHash, 'output config hash present');
  assert.strictEqual(ev.expected.countrySplitChecks.DE.length, ev.artifacts.result.boundaryChecks.DE.length);
  assert.strictEqual(typeof ev.artifacts.result.configSha256, 'string');

  // fixture frozen with sha256 in the workspace
  assert.ok(fs.existsSync(path.join(ctx.workspace.workspacePath, executors.FIXTURE_FILE)), 'fixture written');
  assert.ok(fs.existsSync(path.join(ctx.workspace.workspacePath, executors.FIXTURE_FILE + '.sha256')), 'fixture frozen');
  assert.strictEqual(fs.readFileSync(path.join(ctx.workspace.workspacePath, executors.FIXTURE_FILE + '.sha256'), 'utf8').trim().split(/\s+/)[0],
    executors.sha256Hex(JSON.stringify(executors.DEFAULT_FIXTURE, null, 2) + '\n'));

  // commands are argument arrays and repo-relative
  assert.strictEqual(ev.commands.length, 2);
  assert.strictEqual(ev.commands[0].command, 'node');
  assert.strictEqual(ev.commands[0].args[0], executors.GENERATED_SCRIPT);
  assert.ok(ev.commands[0].args[1].indexOf('--config=') === 0);
  assert.strictEqual(ev.commands[1].args[2], '--apply');

  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-08');
  assert.strictEqual(finalOutcome.result, RESULT_PASS);
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('commissionTiers: synthetic fixture marks AT and GB origin synthetic-staging', function(t) {
  var fx = executors.DEFAULT_FIXTURE;
  assert.strictEqual(fx.countries.AT.origin, 'synthetic-staging');
  assert.strictEqual(fx.countries.GB.origin, 'synthetic-staging');
  assert.strictEqual(fx.countries.DE.origin, 'documented-example-v0.4');
  assert.strictEqual(fx.countries.HU.origin, 'documented-example-v0.4');
  assert.strictEqual(fx.countries.DE.currency, 'EUR');
  assert.strictEqual(fx.countries.HU.currency, 'HUF');
  assert.strictEqual(fx.countries.AT.currency, 'EUR');
  assert.strictEqual(fx.countries.GB.currency, 'GBP');
  assert.strictEqual(fx.countries.DE.bands.length, 5);
  assert.strictEqual(fx.countries.HU.bands.length, 5);
});

test('commissionTiers: boundary mismatch -> EXPECTED_MISMATCH, not PASS', async function(t) {
  function tamperExec(file, args, options, cb) {
    try {
      var configArg = args.find(function(a) { return a.indexOf('--config=') === 0; });
      var configPath = configArg.split('=').slice(1).join('=');
      var fixture = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      var apply = args.indexOf('--apply') !== -1;
      var artifactRoot = options.env.COMMISSION_TIERS_ARTIFACT_ROOT;
      var configOut = options.env.COMMISSION_TIERS_CONFIG_PATH;
      if (apply) {
        fs.writeFileSync(configOut, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
        cb(null, 'config\n', '');
        return;
      }
      var timestamp = '2026-10-07T09-00-00-000Z';
      var dir = path.join(artifactRoot, timestamp);
      fs.mkdirSync(dir, { recursive: true });
      // Plant a mismatch: DE amount 3 reports platformSharePct 60 instead of 20.
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
        schemaVersion: '1.0', mode: 'dry-run', timestamp: timestamp, config: fixture,
        configSha256: 'x',
        boundaryChecks: {
          DE: [{ amount: 3, from: 3, to: 7, platformSharePct: 60, platform: 1.8, designer: 1.2 }]
        }
      }, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'summary.txt'), 'DE (EUR)\n', 'utf8');
      cb(null, 'PASS\n', '');
    } catch (e) {
      cb({ code: 1, message: String((e && e.message) || e) }, '', '');
    }
  }
  var ctx = baseContext({ execFile: tamperExec });
  var outcome = await executors.handlerCommissionTiers(ctx);

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.errorCode, 'EXPECTED_MISMATCH');
  assert.strictEqual(outcome.evidence.checks.allSplitsMatch, false);
  var finalOutcome = finalizeLikeCli(outcome, 'CAN-B2-08');
  assert.strictEqual(finalOutcome.classification, 'APPLICATION_DEFECT');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('commissionTiers: writes executor evidence + canonical record via writeEvidenceFile/writeTaskRecord', async function(t) {
  var evidenceFiles = [];
  var records = [];
  var ctx = baseContext({
    runId: 'run-x',
    execFile: makeScriptExec([]),
    extraDeps: {
      writeEvidenceFile: function(runId, taskId, filename, content, opts) {
        evidenceFiles.push({ runId: runId, taskId: taskId, filename: filename, content: content, opts: opts });
      },
      writeTaskRecord: function(runId, taskId, record, opts) {
        records.push({ runId: runId, taskId: taskId, record: record, opts: opts });
      }
    }
  });
  var outcome = await executors.handlerCommissionTiers(ctx);
  assert.strictEqual(outcome.success, true);

  assert.strictEqual(evidenceFiles.length, 1);
  assert.strictEqual(evidenceFiles[0].runId, 'run-x');
  assert.strictEqual(evidenceFiles[0].taskId, 'CAN-B2-08');
  assert.strictEqual(evidenceFiles[0].filename, 'executor-commission-tiers.json');
  var parsed = JSON.parse(evidenceFiles[0].content);
  assert.ok(parsed.evidence && parsed.evidence.checks.allSplitsMatch === true);

  assert.strictEqual(records.length, 1);
  var rec = records[0].record;
  assert.strictEqual(rec.canonicalId, 'CAN-B2-08');
  assert.strictEqual(rec.executionRevision, 'deadbeef1234');
  assert.strictEqual(rec.exactScriptPath, executors.GENERATED_SCRIPT);
  assert.strictEqual(rec.finalClassification, RESULT_PASS);
  assert.strictEqual(rec.stateChanges.noApiCall, true);
  assert.strictEqual(rec.scope, 'commission-tiers');
  fs.rmSync(ctx.workspace.workspacePath, { recursive: true, force: true });
});

test('commissionTiers: register() registers CAN-B2-08', function(t) {
  executorModule.resetTaskExecutors();
  var reg = executors.register(executorModule);
  assert.strictEqual(reg.success, true);
  assert.deepStrictEqual(reg.registered, ['CAN-B2-08']);
  assert.strictEqual(executorModule.hasTaskExecutor('CAN-B2-08'), true);
  assert.strictEqual(typeof executorModule.getTaskExecutor('CAN-B2-08').handler, 'function');
  executorModule.resetTaskExecutors();
});
