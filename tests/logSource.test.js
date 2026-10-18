'use strict';

var logSource = require('../src/repair/logSource');
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var test = require('node:test');
var assert = require('node:assert');

var TEST_EVIDENCE_ROOT = path.join(os.tmpdir(), 'logsource-test-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));

function fakeRunCommandOk(stdout, stderr, exitCode) {
  return function(cmd, args, opts) {
    return { stdout: stdout || '', stderr: stderr || '', exitCode: exitCode !== undefined ? exitCode : 0 };
  };
}

function makeFakeExecFile(result) {
  var captured = null;
  var fn = function(file, args, options, cb) {
    captured = { file: file, args: args, options: options };
    if (typeof result === 'function') {
      result(cb);
    } else {
      cb(null, result.stdout || '', result.stderr || '');
    }
    return undefined;
  };
  fn.capturedGet = function() { return captured; };
  return fn;
}

test('collect: ok case - valid vendure log', async function() {
  var logLines = [
    '2026-10-17T10:00:00Z [vendure] Server started on port 3000',
    '2026-10-17T10:01:00Z [vendure] Query products executed',
    '2026-10-17T10:02:00Z [vendure] Error: connection refused'
  ].join('\n');

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-ok-vendure',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(Array.isArray(result.lines), true);
  assert.strictEqual(result.lines.length, 3);
  assert.strictEqual(result.truncated, false);
  assert.ok(result.source.indexOf('pipeline-staging-ops') !== -1);
  assert.ok(result.evidencePath);
  assert.ok(result.evidenceSha256);
});

test('collect: ok case - worker log', async function() {
  var logLines = [
    '2026-10-17T09:00:00Z [worker] Job queue started',
    '2026-10-17T09:01:00Z [worker] Processing job id=123'
  ].join('\n');

  var result = await logSource.collect('worker', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-ok-worker',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.lines.length, 2);
});

test('collect: ok case - postgres log', async function() {
  var logLines = [
    '2026-10-17T08:00:00Z postgres: starting up',
    '2026-10-17T08:00:01Z postgres: ready for connections'
  ].join('\n');

  var result = await logSource.collect('postgres', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-ok-postgres',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.lines.length, 2);
});

test('collect: blocked case - non-zero exit code returns blocker', async function() {
  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk('', 'wrapper not available', 1),
    runId: 'test-blocked',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.blocker);
  assert.strictEqual(result.blocker.exitCode, 1);
  assert.ok(result.blocker.stderrExcerpt.indexOf('wrapper not available') !== -1);
  assert.ok(result.blocker.command.indexOf('pipeline-staging-ops') !== -1);
});

test('collect: blocked case - BLOCK in stderr', async function() {
  var result = await logSource.collect('worker', {
    runCommand: fakeRunCommandOk('', 'BLOCK: staging ops unavailable\ncontact admin', 1),
    runId: 'test-block-stderr',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.blocker);
  assert.strictEqual(result.blocker.exitCode, 1);
});

test('collect: timeout case - timed out', async function() {
  var result = await logSource.collect('vendure', {
    runCommand: function(cmd, args, opts) {
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    },
    runId: 'test-timeout',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.blocker);
  assert.ok(result.blocker.stderrExcerpt.indexOf('timed out') !== -1);
});

test('collect: oversize case - truncated when too many lines', async function() {
  var manyLines = [];
  for (var i = 0; i < 20000; i++) {
    manyLines.push('2026-10-17T10:' + String(Math.floor(i / 60)).padStart(2, '0') + ':00Z [log] line ' + i);
  }
  var logLines = manyLines.join('\n');

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-oversize',
    root: TEST_EVIDENCE_ROOT,
    maxLines: 100
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.lines.length, 100);
  assert.strictEqual(result.truncated, true);
});

test('collect: bad kind - rejected outside allowlist', async function() {
  var result = await logSource.collect('mysql', {
    runCommand: fakeRunCommandOk('some log', '', 0),
    runId: 'test-bad-kind',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.error.indexOf('mysql') !== -1);
  assert.ok(result.error.indexOf('vendure') !== -1);
});

test('collect: bad kind - arbitrary string rejected', async function() {
  var result = await logSource.collect('../../etc/passwd', {
    runCommand: fakeRunCommandOk('', '', 0),
    runId: 'test-bad-kind2',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.error.indexOf('Invalid log kind') !== -1);
});

test('collect: redaction - email addresses are redacted', async function() {
  var logLines = [
    '2026-10-17T10:00:00Z User john.doe@example.com logged in',
    '2026-10-17T10:01:00Z Sent email to admin@company.cn'
  ].join('\n');

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-redact-email',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  result.lines.forEach(function(line) {
    assert.ok(line.indexOf('john.doe@example.com') === -1, 'email should be redacted: ' + line);
    assert.ok(line.indexOf('admin@company.cn') === -1, 'email should be redacted: ' + line);
    assert.ok(line.indexOf('[REDACTED]') !== -1, 'REDACTED marker should appear');
  });
});

test('collect: redaction - secrets from env are redacted', async function() {
  var logLines = '2026-10-17T10:00:00Z Using API key super_secret_key_xyz789\n';
  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-redact-secret',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  result.lines.forEach(function(line) {
    assert.ok(line.indexOf('super_secret_key_xyz789') === -1, 'secret should be redacted: ' + line);
  });
});

test('collect: filter by sinceTs - returns only lines near timestamp', async function() {
  var logLines = [
    '2026-10-17T09:00:00Z [old] old log line',
    '2026-10-17T10:30:00Z [target] this is the target time',
    '2026-10-17T10:45:00Z [near] near target time',
    '2026-10-17T11:00:00Z [later] later log line'
  ].join('\n');

  var sinceTs = new Date('2026-10-17T10:30:00Z').getTime();

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-filter-time',
    root: TEST_EVIDENCE_ROOT,
    sinceTs: sinceTs
  });

  assert.strictEqual(result.ok, true);
  var joined = result.lines.join('\n');
  assert.ok(joined.indexOf('[target]') !== -1, 'should include target time line');
  assert.ok(joined.indexOf('[near]') !== -1, 'should include near target time');
  assert.ok(joined.indexOf('[old]') === -1, 'old (outside window) should be excluded');
  assert.ok(joined.indexOf('[later]') === -1, 'later (outside window) should be excluded');
});

test('collect: filter by sinceTs with very old timestamp returns all', async function() {
  var logLines = [
    '2026-10-17T09:00:00Z old line',
    '2026-10-17T10:00:00Z new line'
  ].join('\n');

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-filter-old',
    root: TEST_EVIDENCE_ROOT,
    sinceTs: 0
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.lines.length, 2);
});

test('collect: evidence file written to logs.json', async function() {
  var runId = 'test-ev-' + Date.now();
  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk('line1\nline2\n', '', 0),
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  var evPath = path.join(TEST_EVIDENCE_ROOT, runId, 'logs.json');
  assert.ok(fs.existsSync(evPath), 'logs.json should exist at ' + evPath);
  var content = JSON.parse(fs.readFileSync(evPath, 'utf8'));
  assert.strictEqual(content.runId, runId);
  assert.strictEqual(content.kind, 'vendure');
  assert.strictEqual(Array.isArray(content.lines), true);
});

test('collect: index.json updated with log evidence entry', async function() {
  var runId = 'test-idx-' + Date.now();
  await logSource.collect('postgres', {
    runCommand: fakeRunCommandOk('postgres log line\n', '', 0),
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  var idxPath = path.join(TEST_EVIDENCE_ROOT, runId, 'index.json');
  assert.ok(fs.existsSync(idxPath), 'index.json should exist');
  var idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  assert.strictEqual(idx.runId, runId);
  assert.ok(Array.isArray(idx.entries));
  assert.ok(idx.entries.length > 0);
  var logEntry = idx.entries.filter(function(e) { return e.kind === 'log-source'; });
  assert.ok(logEntry.length > 0);
});

test('collect: runCommand throws - returns blocker', async function() {
  var result = await logSource.collect('worker', {
    runCommand: function(cmd, args, opts) {
      throw new Error('execFile failed: permission denied');
    },
    runId: 'test-throws',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.blocker);
  assert.strictEqual(result.blocker.exitCode, null);
  assert.ok(result.blocker.stderrExcerpt.indexOf('permission denied') !== -1);
});

test('collect: evidence sha256 is valid hex', async function() {
  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk('some log\n', '', 0),
    runId: 'test-sha-' + Date.now(),
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.evidenceSha256.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(result.evidenceSha256), 'sha256 should be 64 hex chars');
});

test('collect: lines with no timestamp are included when filtering by sinceTs', async function() {
  var logLines = [
    '2026-10-17T10:00:00Z [ts] has timestamp',
    'no timestamp here',
    '2026-10-17T10:30:00Z [mid] middle'
  ].join('\n');

  var sinceTs = new Date('2026-10-17T10:15:00Z').getTime();

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-no-ts',
    root: TEST_EVIDENCE_ROOT,
    sinceTs: sinceTs
  });

  assert.strictEqual(result.ok, true);
  var lines = result.lines.join('\n');
  assert.ok(lines.indexOf('no timestamp here') !== -1, 'lines without ts should be included');
  assert.ok(lines.indexOf('[ts]') !== -1, 'ts line should be included');
  assert.ok(lines.indexOf('[mid]') !== -1, 'mid line should be included');
});

test('collect: allowlist exactly vendure, worker, postgres', async function() {
  var allowed = ['vendure', 'worker', 'postgres'];
  for (var i = 0; i < allowed.length; i++) {
    var result = await logSource.collect(allowed[i], {
      runCommand: fakeRunCommandOk('log line\n', '', 0),
      runId: 'test-allow-' + allowed[i],
      root: TEST_EVIDENCE_ROOT
    });
    assert.strictEqual(result.ok, true, allowed[i] + ' should be allowed');
  }
});

test('collect: runs exactly sudo pipeline-staging-ops logs <kind> via execFile-style runCommand', async function() {
  var captured = null;
  var runCommand = function(cmd, args, opts) {
    captured = { cmd: cmd, args: args, opts: opts };
    return { stdout: '2026-10-17T10:00:00Z line\n', stderr: '', exitCode: 0 };
  };

  var result = await logSource.collect('worker', {
    runCommand: runCommand,
    runId: 'test-exact-cmd',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(captured.cmd, 'sudo');
  assert.deepStrictEqual(captured.args, ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'worker']);
  // execFile contract: array args, no shell string, cwd and timeout carried into options
  assert.ok(typeof captured.opts.cwd === 'string');
  assert.strictEqual(typeof captured.opts.timeout, 'number');
  assert.strictEqual(captured.cmd + ' ' + captured.args.join(' '), 'sudo /usr/local/sbin/pipeline-staging-ops logs worker');
  assert.ok(result.source.indexOf('pipeline-staging-ops') !== -1);
});

test('collect: every allowed kind uses the exact executable and argument array', async function() {
  var expected = {
    vendure: ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'vendure'],
    worker: ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'worker'],
    postgres: ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'postgres']
  };
  var kinds = Object.keys(expected);
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    var captured = null;
    await logSource.collect(kind, {
      runCommand: function(cmd, args, opts) { captured = { cmd: cmd, args: args }; return { stdout: 'x\n', stderr: '', exitCode: 0 }; },
      runId: 'test-all-kinds-' + kind,
      root: TEST_EVIDENCE_ROOT
    });
    assert.strictEqual(captured.cmd, 'sudo', kind + ' executable');
    assert.deepStrictEqual(captured.args, expected[kind], kind + ' argument array');
  }
});

test('collect: rejects kinds not in allowlist (never reaches runCommand)', async function() {
  var called = false;
  var result = await logSource.collect('postgresql', {
    runCommand: function() { called = true; return { stdout: '', stderr: '', exitCode: 0 }; },
    runId: 'test-kind-reject',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(called, false);
  assert.ok(result.error.indexOf('Invalid log kind') !== -1);

  result = await logSource.collect('../../etc/passwd', {
    runCommand: function() { called = true; return { stdout: '', stderr: '', exitCode: 0 }; },
    runId: 'test-kind-reject2',
    root: TEST_EVIDENCE_ROOT
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(called, false);
});

test('collect: empty worker log returns ok:true with empty lines array', async function() {
  var result = await logSource.collect('worker', {
    runCommand: fakeRunCommandOk('', '', 0),
    runId: 'test-empty-worker',
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.lines, []);
  assert.strictEqual(result.evidenceSha256.length, 64);
});

test('collect: secrets and emails are redacted BEFORE evidence is written to disk', async function() {
  var logLines = [
    '2026-10-17T10:00:00Z login admin@secret-host.example with api_key_top_secret_999',
    '2026-10-17T10:01:00Z contact buyer@shop.co'
  ].join('\n');

  var runId = 'test-redact-ev-' + Date.now();
  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: runId,
    root: TEST_EVIDENCE_ROOT
  });

  assert.strictEqual(result.ok, true);

  // The on-disk evidence must never contain the raw values.
  var evPath = path.join(TEST_EVIDENCE_ROOT, runId, 'logs.json');
  assert.ok(fs.existsSync(evPath), 'evidence should exist at ' + evPath);
  var onDisk = fs.readFileSync(evPath, 'utf8');

  assert.ok(onDisk.indexOf('top_secret_999') === -1, 'secret must not reach evidence file');
  assert.ok(onDisk.indexOf('admin@secret-host.example') === -1, 'email must not reach evidence file');
  assert.ok(onDisk.indexOf('buyer@shop.co') === -1, 'email must not reach evidence file');
  assert.ok(onDisk.indexOf('[REDACTED]') !== -1, 'evidence must carry the redaction marker');
});

test('collect: no-timezone-offset lines use a wide +-3h window', async function() {
  var logLines = [
    '2026-10-17T08:00:00 [old] five hours before sinceTs',
    '2026-10-17T09:30:00 [within] two hours before sinceTs',
    '2026-10-17T13:00:00 [after] two hours after sinceTs'
  ].join('\n');

  var sinceTs = new Date('2026-10-17T11:30:00Z').getTime();

  var result = await logSource.collect('vendure', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-wide-window',
    root: TEST_EVIDENCE_ROOT,
    sinceTs: sinceTs
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.notes, []);
  var joined = result.lines.join('\n');
  assert.ok(joined.indexOf('[within]') !== -1, '2h before should be inside the +-3h window');
  assert.ok(joined.indexOf('[after]') !== -1, '2h after should be inside the +-3h window');
  assert.ok(joined.indexOf('[old]') === -1, '5h before should be outside the +-3h window');
});

test('collect: filtering that would leave zero lines returns unfiltered lines with a note', async function() {
  var logLines = [
    '2026-10-17T04:00:00Z [far] ten hours earlier',
    '2026-10-17T20:00:00Z [later] ten hours later'
  ].join('\n');

  var sinceTs = new Date('2026-10-17T14:00:00Z').getTime();

  var result = await logSource.collect('postgres', {
    runCommand: fakeRunCommandOk(logLines, '', 0),
    runId: 'test-zero-filter',
    root: TEST_EVIDENCE_ROOT,
    sinceTs: sinceTs
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.notes, ['sinceTs filter not applied']);
  assert.strictEqual(result.lines.length, 2, 'all bounded lines are returned unfiltered');
  var joined = result.lines.join('\n');
  assert.ok(joined.indexOf('[far]') !== -1);
  assert.ok(joined.indexOf('[later]') !== -1);
});

test('production adapter: runLogCommand uses child_process.execFile with shell:false and exact argv', async function() {
  var captured = null;
  var fakeCp = {
    execFile: function(file, args, options, cb) {
      captured = { file: file, args: args, options: options };
      cb(null, '2026-10-17T10:00:00Z log line\n', '');
      return undefined;
    }
  };

  var result = await logSource.runLogCommand('sudo', ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'worker'], { timeout: 30000 }, fakeCp);

  assert.strictEqual(captured.file, 'sudo');
  assert.deepStrictEqual(captured.args, ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'worker']);
  assert.strictEqual(captured.options.shell, false);
  assert.strictEqual(typeof captured.options.timeout, 'number');
  assert.strictEqual(captured.options.encoding, 'utf8');
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.spawnError, null);
});

test('production adapter: runLogCommand reports a nonzero exit code', async function() {
  var err = new Error('command exited');
  err.code = 3;
  var fakeCp = {
    execFile: function(file, args, options, cb) {
      cb(err, 'partial out', 'boom');
      return undefined;
    }
  };

  var result = await logSource.runLogCommand('sudo', ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'postgres'], { timeout: 30000 }, fakeCp);

  assert.strictEqual(result.exitCode, 3);
  assert.strictEqual(result.timedOut, false);
});

test('production adapter: runLogCommand surfaces a spawn error when the wrapper cannot start', async function() {
  var err = new Error('spawn sudo ENOENT');
  err.code = 'ENOENT';
  var fakeCp = {
    execFile: function(file, args, options, cb) {
      cb(err, '', '');
      return undefined;
    }
  };

  var result = await logSource.runLogCommand('sudo', ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'vendure'], { timeout: 30000 }, fakeCp);

  assert.strictEqual(result.spawnError.indexOf('ENOENT') !== -1, true);
  assert.strictEqual(result.exitCode, null);
});

test('collect: production default (no runCommand) goes through execFile with shell:false', async function() {
  var runId = 'test-prod-default-' + Date.now();
  var captured = null;
  var fakeCp = {
    execFile: function(file, args, options, cb) {
      captured = { file: file, args: args, options: options };
      cb(null, 'line1\nline2\n', '');
      return undefined;
    }
  };

  var result = await logSource.collect('worker', {
    runId: runId,
    root: TEST_EVIDENCE_ROOT,
    childProcess: fakeCp
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.lines, ['line1', 'line2']);
  assert.strictEqual(captured.file, 'sudo');
  assert.deepStrictEqual(captured.args, ['/usr/local/sbin/pipeline-staging-ops', 'logs', 'worker']);
  assert.strictEqual(captured.options.shell, false);
});
