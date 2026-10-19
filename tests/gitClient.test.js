'use strict';

var gitClient = require('../src/repair/gitClient');
var test = require('node:test');
var assert = require('node:assert');

function makeFakeRunCommand(ops) {
  ops = ops || {};
  return function(cmd, args, opts) {
    if (ops.throwError) {
      return Promise.reject(ops.throwError);
    }
    return Promise.resolve(ops.results ? ops.results.shift() : { success: true, stdout: '', stderr: '', exitCode: 0 });
  };
}

// ---------------------------------------------------------------------------
// cloneTarget
// ---------------------------------------------------------------------------

test('cloneTarget: token only in env, not argv, url or logs', async function() {
  var capturedEnv = null;
  var capturedArgs = null;
  var fakeRunner = function(cmd, args, opts) {
    capturedEnv = opts && opts.env;
    capturedArgs = args;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };

  await gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test-repo',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/test-clone',
    token: 'super-secret-token-xyz',
    runCommand: fakeRunner
  });

  assert.ok(capturedEnv, 'env was passed');
  assert.ok(capturedEnv.GIT_CONFIG_VALUE_0.indexOf('super-secret-token-xyz') === -1, 'plain token absent from env value');
  assert.ok(capturedArgs.indexOf('super-secret-token-xyz') === -1, 'token absent from argv');
  assert.ok(capturedArgs.indexOf('https://github.com/vendure-ai-factory/test-repo') !== -1, 'url is in args (git clones via argv)');
  var encoded = Buffer.from('x-access-token:super-secret-token-xyz', 'utf8').toString('base64');
  assert.ok(capturedEnv.GIT_CONFIG_VALUE_0.indexOf(encoded) !== -1, 'base64-encoded token present in env');
});

test('cloneTarget: missing runCommand -> BLOCK', async function() {
  var result = await gitClient.cloneTarget({ repoUrl: 'https://github.com/vendure-ai-factory/test', branch: 'codex/pipeline-fix-run1-abc', dir: '/tmp/x', token: 'tok' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IO_NOT_INJECTED');
});

test('cloneTarget: non-vendure-ai-factory repoUrl -> BLOCK', async function() {
  var result = await gitClient.cloneTarget({
    repoUrl: 'https://github.com/other-org/test',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/x',
    token: 'tok',
    runCommand: makeFakeRunCommand()
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'UNSAFE_REPOSITORY_URL');
});

test('cloneTarget: non-fix-branch name -> BLOCK', async function() {
  var result = await gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test',
    branch: 'main',
    dir: '/tmp/x',
    token: 'tok',
    runCommand: makeFakeRunCommand()
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'UNSAFE_BRANCH_NAME');
});

test('cloneTarget: missing dir -> BLOCK', async function() {
  var result = await gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '',
    token: 'tok',
    runCommand: makeFakeRunCommand()
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'MISSING_CLONE_DIR');
});

test('cloneTarget: missing token -> BLOCK', async function() {
  var result = await gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/x',
    token: '',
    runCommand: makeFakeRunCommand()
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'MISSING_TOKEN');
});

test('cloneTarget: clone failure returns BLOCK', async function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: false, stdout: '', stderr: 'fatal: could not create work tree', exitCode: 128 }] });
  var result = await gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/x',
    token: 'tok',
    runCommand: fakeRunner
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'CLONE_FAILED');
});

test('cloneTarget: success case', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: 'Cloning', stderr: '', exitCode: 0 }] });
  var result = gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/my-clone',
    token: 'tok',
    runCommand: fakeRunner
  });
  return result.then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dir, '/tmp/my-clone');
    assert.strictEqual(r.branch, 'codex/pipeline-fix-run1-abc12345');
  });
});

// ---------------------------------------------------------------------------
// createBranch
// ---------------------------------------------------------------------------

test('createBranch: non-fix-branch -> BLOCK', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.createBranch('/tmp/repo', 'main', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_BRANCH_NAME');
  });
});

test('createBranch: fix branch accepted', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.createBranch('/tmp/repo', 'codex/pipeline-fix-run2-def67890', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.branch, 'codex/pipeline-fix-run2-def67890');
  });
});

test('createBranch: missing runCommand -> BLOCK', function() {
  return gitClient.createBranch('/tmp/repo', 'codex/pipeline-fix-run2-abc12345').then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'IO_NOT_INJECTED');
  });
});

// ---------------------------------------------------------------------------
// commitAll
// ---------------------------------------------------------------------------

test('commitAll: empty message -> BLOCK', function() {
  return gitClient.commitAll('/tmp/repo', '', { runCommand: makeFakeRunCommand() }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MISSING_COMMIT_MESSAGE');
  });
});

test('commitAll: success case', function() {
  var count = 0;
  var fakeRunner = function(cmd, args, opts) {
    count++;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  return gitClient.commitAll('/tmp/repo', 'fix: correct thing', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(count, 2, 'add then commit');
  });
});

// ---------------------------------------------------------------------------
// getHeadSha
// ---------------------------------------------------------------------------

test('getHeadSha: returns sha on success', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: 'abc1234567890def', stderr: '', exitCode: 0 }] });
  return gitClient.getHeadSha('/tmp/repo', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sha, 'abc1234567890def');
  });
});

test('getHeadSha: invalid sha -> BLOCK', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: 'not-a-sha', stderr: '', exitCode: 0 }] });
  return gitClient.getHeadSha('/tmp/repo', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HEAD_SHA_INVALID');
  });
});

test('getHeadSha: git failure -> BLOCK', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: false, stdout: '', stderr: 'not a git repo', exitCode: 128 }] });
  return gitClient.getHeadSha('/tmp/repo', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'HEAD_SHA_FAILED');
  });
});

// ---------------------------------------------------------------------------
// push refusal cases
// ---------------------------------------------------------------------------

test('push: base branch (main) -> refused', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'main', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_PUSH_REF');
  });
});

test('push: master -> refused', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'master', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_PUSH_REF');
  });
});

test('push: codex/staging-vendure-3.7.3 -> refused', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'codex/staging-vendure-3.7.3', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_PUSH_REF');
  });
});

test('push: colon in ref -> refused (refspec injection)', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345:refs/heads/main', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_PUSH_REF');
    assert.strictEqual(r.blocker.message.indexOf(':') !== -1 || r.blocker.message.indexOf('refspec') !== -1, true);
  });
});

test('push: plus in ref -> refused (force-like)', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345+fake', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_PUSH_REF');
  });
});

test('push: --force in branch name -> refused', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345--force', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'UNSAFE_PUSH_REF');
  });
});

test('push: valid fix branch succeeds', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.branch, 'codex/pipeline-fix-run1-abc12345');
  });
});

test('push: missing runCommand -> BLOCK', function() {
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345', 'tok').then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'IO_NOT_INJECTED');
  });
});

test('push: missing token -> BLOCK', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345', '', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'MISSING_TOKEN');
  });
});

test('push: failure -> BLOCK with redacted stderr', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: false, stdout: '', stderr: 'git: permission denied', exitCode: 1 }] });
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.code, 'PUSH_FAILED');
    assert.strictEqual(r.blocker.message.indexOf('tok') === -1, true, 'token must not appear in blocker message');
  });
});

test('validatePushRef: valid branch returns ok', function() {
  var r = gitClient.validatePushRef('codex/pipeline-fix-run1-abc12345');
  assert.strictEqual(r.ok, true);
});

test('validatePushRef: tok returns false', function() {
  var r = gitClient.validatePushRef('tok');
  assert.strictEqual(r.ok, false);
});

// ---------------------------------------------------------------------------
// diffStat / diffText
// ---------------------------------------------------------------------------

test('diffStat: success', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: 'file.js | 5 ++', stderr: '', exitCode: 0 }] });
  return gitClient.diffStat('/tmp/repo', 'abc1234', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.ok(r.stat.indexOf('file.js') !== -1);
  });
});

test('diffText: truncates at maxBytes', function() {
  var longDiff = 'a\n'.repeat(1000);
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: longDiff, stderr: '', exitCode: 0 }] });
  return gitClient.diffText('/tmp/repo', 'abc1234', 500, { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.text.length, 500);
  });
});

test('diffText: no maxBytes uses default 1MB', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: 'diff', stderr: '', exitCode: 0 }] });
  return gitClient.diffText('/tmp/repo', 'abc1234', null, { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// FIX_BRANCH_RE
// ---------------------------------------------------------------------------

test('FIX_BRANCH_RE matches valid fix branch names', function() {
  assert.ok(gitClient.FIX_BRANCH_RE.test('codex/pipeline-fix-run1-abc12345'), 'run1');
  assert.ok(gitClient.FIX_BRANCH_RE.test('codex/pipeline-fix-my-run_def.12-abc12345'), 'underscore dash dot');
  assert.ok(gitClient.FIX_BRANCH_RE.test('codex/pipeline-fix-abc'), 'short sig');
});

test('FIX_BRANCH_RE rejects invalid names', function() {
  assert.ok(!gitClient.FIX_BRANCH_RE.test('main'));
  assert.ok(!gitClient.FIX_BRANCH_RE.test('master'));
  assert.ok(!gitClient.FIX_BRANCH_RE.test('codex/staging-vendure-3.7.3'));
  assert.ok(!gitClient.FIX_BRANCH_RE.test('codex/pipeline-fix-run1-abc:def'));
  assert.ok(!gitClient.FIX_BRANCH_RE.test('codex/pipeline-fix-run1+abc'));
  assert.ok(!gitClient.FIX_BRANCH_RE.test('codex/pipeline-fix'));
});

// ---------------------------------------------------------------------------
// gitAuthEnv
// ---------------------------------------------------------------------------

test('gitAuthEnv: token encoded in base64 in env value', function() {
  var env = gitClient.gitAuthEnv('my-secret-token');
  assert.strictEqual(env.GIT_CONFIG_COUNT, '1');
  assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.extraheader');
  assert.ok(env.GIT_CONFIG_VALUE_0.indexOf('AUTHORIZATION: basic') !== -1, 'has auth header');
  var encoded = env.GIT_CONFIG_VALUE_0.split('AUTHORIZATION: basic ')[1];
  var decoded = Buffer.from(encoded, 'base64').toString('utf8');
  assert.strictEqual(decoded, 'x-access-token:my-secret-token');
});

test('cloneTarget: exact env keys - GIT_CONFIG_COUNT, KEY_0, VALUE_0 prefix', function() {
  var capturedEnv = null;
  var fakeRunner = function(cmd, args, opts) {
    capturedEnv = opts && opts.env;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test-repo',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/test-clone',
    token: 'tok-for-env-check',
    runCommand: fakeRunner
  });
  var keys = Object.keys(capturedEnv).sort();
  assert.deepStrictEqual(keys, [
    'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'
  ], 'only these 7 env keys');
  assert.strictEqual(capturedEnv.GIT_CONFIG_COUNT, '1');
  assert.strictEqual(capturedEnv.GIT_CONFIG_KEY_0, 'http.extraheader');
  assert.ok(capturedEnv.GIT_CONFIG_VALUE_0.indexOf('AUTHORIZATION: basic ') === 0, 'VALUE_0 starts with "AUTHORIZATION: basic "');
  assert.ok(capturedEnv.GIT_CONFIG_VALUE_0.indexOf('tok-for-env-check') === -1, 'plain token absent from VALUE_0');
});

test('cloneTarget: token and base64 never in argv', function() {
  var capturedArgs = null;
  var capturedEnv = null;
  var fakeRunner = function(cmd, args, opts) {
    capturedArgs = args;
    capturedEnv = opts && opts.env;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  gitClient.cloneTarget({
    repoUrl: 'https://github.com/vendure-ai-factory/test-repo',
    branch: 'codex/pipeline-fix-run1-abc12345',
    dir: '/tmp/test-clone',
    token: 'super-secret-123',
    runCommand: fakeRunner
  });
  var argsStr = JSON.stringify(capturedArgs);
  var base64 = Buffer.from('x-access-token:super-secret-123', 'utf8').toString('base64');
  assert.ok(argsStr.indexOf('super-secret-123') === -1, 'plain token not in argv');
  assert.ok(argsStr.indexOf(base64) === -1, 'base64 token not in argv');
  assert.ok(capturedEnv.GIT_CONFIG_VALUE_0.indexOf(base64) !== -1, 'base64 token IS in env VALUE_0');
});

test('cloneTarget: URL host/path validation - allowed and refused', function() {
  var check = function(repoUrl, expectBlock) {
    var fakeRunner = makeFakeRunCommand({ results: [{ success: true, stdout: '', stderr: '', exitCode: 0 }] });
    var result = gitClient.cloneTarget({
      repoUrl: repoUrl,
      branch: 'codex/pipeline-fix-run1-abc12345',
      dir: '/tmp/x',
      token: 'tok',
      runCommand: fakeRunner
    });
    return Promise.resolve(result).then(function(r) {
      if (expectBlock) {
        assert.strictEqual(r.ok, false, repoUrl + ' should be blocked');
        assert.strictEqual(r.blocker.code, 'UNSAFE_REPOSITORY_URL', repoUrl);
      } else {
        assert.strictEqual(r.ok, true, repoUrl + ' should be allowed');
      }
    });
  };
  check('https://github.com/vendure-ai-factory/x', false);
  check('https://github.com/vendure-ai-factory/my-repo', false);
  check('https://evil.com/vendure-ai-factory/x', true);
  check('https://github.com.evil.com/vendure-ai-factory/x', true);
  check('http://github.com/vendure-ai-factory/x', true);
  check('https://github.com/other-org/x', true);
  check('https://github.com/vendure-ai-factory/', true);
});

test('push: argv never contains --force, -f, +, or colon', function() {
  var capturedArgs = null;
  var fakeRunner = function(cmd, args, opts) {
    capturedArgs = args;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345', 'tok', { runCommand: fakeRunner }).then(function() {
    var argsStr = JSON.stringify(capturedArgs);
    assert.ok(capturedArgs.every(function(a) { return !a.startsWith('--force') && !a.startsWith('-f') && a !== '+' && a.indexOf(':') === -1; }), 'no -f in argv');
  });
});

test('push: argv uses -- protection (branch as explicit ref)', function() {
  var capturedArgs = null;
  var fakeRunner = function(cmd, args, opts) {
    capturedArgs = args;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  return gitClient.push('/tmp/repo', 'codex/pipeline-fix-run1-abc12345', 'tok', { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, true);
    var idx = capturedArgs.indexOf('origin');
    assert.ok(idx !== -1, 'has origin');
    var dashIdx = capturedArgs.indexOf('--');
    assert.ok(dashIdx !== -1 && dashIdx > idx, 'has -- separator after origin');
    var branchIdx = capturedArgs.indexOf('codex/pipeline-fix-run1-abc12345');
    assert.ok(branchIdx !== -1 && branchIdx > dashIdx, 'branch comes after --');
  });
});

test('commitAll: uses Pipeline author identity', function() {
  var capturedEnv = null;
  var fakeRunner = function(cmd, args, opts) {
    capturedEnv = opts && opts.env;
    return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
  };
  return gitClient.commitAll('/tmp/repo', 'fix: test', { runCommand: fakeRunner }).then(function() {
    assert.strictEqual(capturedEnv.GIT_AUTHOR_NAME, 'Pipeline');
    assert.strictEqual(capturedEnv.GIT_AUTHOR_EMAIL, 'pipeline@users.noreply.github.com');
    assert.strictEqual(capturedEnv.GIT_COMMITTER_NAME, 'Pipeline');
    assert.strictEqual(capturedEnv.GIT_COMMITTER_EMAIL, 'pipeline@users.noreply.github.com');
  });
});

test('diffText: output is redacted (secret, email, bearer)', function() {
  var fakeRunner = makeFakeRunCommand({ results: [{
    success: false, stdout: '', stderr: 'error: secret-token-12345 invalid; email: test@example.com; Bearer: tok1234567890abcdef',
    exitCode: 1
  }] });
  return gitClient.diffText('/tmp/repo', 'abc1234', null, { runCommand: fakeRunner }).then(function(r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocker.message.indexOf('secret-token-12345') === -1, true, 'secret absent from message');
    assert.strictEqual(r.blocker.message.indexOf('test@example.com') === -1, true, 'email absent from message');
    assert.strictEqual(r.blocker.message.indexOf('tok1234567890abcdef') === -1, true, 'bearer token absent from message');
    assert.strictEqual(r.blocker.message.indexOf('secret-token-12345') === -1, true);
    assert.strictEqual(r.blocker.message.indexOf('[REDACTED]') !== -1, true, 'has redaction markers');
  });
});

test('gitAuthEnv: token never appears in plain text in env', function() {
  var env = gitClient.gitAuthEnv('plain-text-token-123');
  var envStr = JSON.stringify(env);
  assert.strictEqual(envStr.indexOf('plain-text-token-123'), -1, 'token should only be in base64 value, not plain in JSON');
});

// ---------------------------------------------------------------------------
// Item 1: all exported async functions return Promise even for blocked inputs
// ---------------------------------------------------------------------------

test('cloneTarget: bad input -> instanceof Promise', function() {
  var r = gitClient.cloneTarget({ repoUrl: 'bad', branch: 'bad', dir: '', token: '' });
  assert.strictEqual(r instanceof Promise, true);
});

test('createBranch: bad input -> instanceof Promise', function() {
  var r = gitClient.createBranch('/tmp', 'main');
  assert.strictEqual(r instanceof Promise, true);
});

test('commitAll: bad input -> instanceof Promise', function() {
  var r = gitClient.commitAll('/tmp', '');
  assert.strictEqual(r instanceof Promise, true);
});

test('getHeadSha: bad input -> instanceof Promise', function() {
  var r = gitClient.getHeadSha('/tmp');
  assert.strictEqual(r instanceof Promise, true);
});

test('push: bad input -> instanceof Promise', function() {
  var r = gitClient.push('/tmp', 'main', '');
  assert.strictEqual(r instanceof Promise, true);
});

test('diffStat: bad input -> instanceof Promise', function() {
  var r = gitClient.diffStat('/tmp', 'abc1234');
  assert.strictEqual(r instanceof Promise, true);
});

test('diffText: bad input -> instanceof Promise', function() {
  var r = gitClient.diffText('/tmp', 'abc1234');
  assert.strictEqual(r instanceof Promise, true);
});
