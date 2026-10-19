'use strict';

var deployAdapter = require('../src/repair/deployAdapter');

var test = require('node:test');
var assert = require('node:assert');

var VALID_DEPLOY_REF = 'ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + 'a'.repeat(64);
var SECRET_TOKEN = 'super-secret-deploy-token-12345';

function makeFakeRunCommand(results) {
  var index = 0;
  var capturedCalls = [];
  return function(cmd, args, opts) {
    capturedCalls.push({ cmd: cmd, args: args, opts: opts });
    if (index < results.length) {
      var result = results[index++];
      if (typeof result === 'function') {
        return result(cmd, args, opts);
      }
      return Promise.resolve(result);
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  };
}

function makeFakeFetch(responses) {
  var index = 0;
  return function(url, opts) {
    if (index < responses.length) {
      return responses[index++];
    }
    return { status: 404 };
  };
}

// 3j: invalid deployRef (tag instead of digest, other registry, uppercase hex, extra args, newline) -> DEPLOY_REF_INVALID
test('3j: tag instead of digest is invalid', async function() {
  var runCommandCalled = false;
  var fakeRunCommand = function() {
    runCommandCalled = true;
    return Promise.resolve({ exitCode: 0 });
  };
  var result = await deployAdapter.deploy('ghcr.io/vendure-ai-factory/nail-patterns-vendure:v1.0', {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_REF_INVALID');
  assert.strictEqual(runCommandCalled, false, 'runCommand should not be called');
});

test('3j: other registry is invalid', async function() {
  var runCommandCalled = false;
  var fakeRunCommand = function() {
    runCommandCalled = true;
    return Promise.resolve({ exitCode: 0 });
  };
  var result = await deployAdapter.deploy('docker.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + 'a'.repeat(64), {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_REF_INVALID');
  assert.strictEqual(runCommandCalled, false);
});

test('3j: uppercase hex is invalid', async function() {
  var runCommandCalled = false;
  var fakeRunCommand = function() {
    runCommandCalled = true;
    return Promise.resolve({ exitCode: 0 });
  };
  var upperDigest = 'sha256:' + 'A'.repeat(64);
  var result = await deployAdapter.deploy('ghcr.io/vendure-ai-factory/nail-patterns-vendure@' + upperDigest, {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_REF_INVALID');
  assert.strictEqual(runCommandCalled, false);
});

test('3j: extra args in deployRef is invalid', async function() {
  var runCommandCalled = false;
  var fakeRunCommand = function() {
    runCommandCalled = true;
    return Promise.resolve({ exitCode: 0 });
  };
  var result = await deployAdapter.deploy('ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + 'a'.repeat(64) + '/extra', {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_REF_INVALID');
  assert.strictEqual(runCommandCalled, false);
});

test('3j: newline in deployRef is invalid', async function() {
  var runCommandCalled = false;
  var fakeRunCommand = function() {
    runCommandCalled = true;
    return Promise.resolve({ exitCode: 0 });
  };
  var result = await deployAdapter.deploy('ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:\na' + 'a'.repeat(63), {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_REF_INVALID');
  assert.strictEqual(runCommandCalled, false);
});

// 3j: short digest is invalid
test('3j: short digest is invalid', async function() {
  var runCommandCalled = false;
  var fakeRunCommand = function() {
    runCommandCalled = true;
    return Promise.resolve({ exitCode: 0 });
  };
  var result = await deployAdapter.deploy('ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:abc123', {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_REF_INVALID');
  assert.strictEqual(runCommandCalled, false);
});

// 3k: deploy runs exactly ('sudo', ['/usr/local/sbin/pipeline-staging-ops','deploy', deployRef]) with shell:false and 600s timeout
test('3k: deployCommand is called with correct args and shell:false', async function() {
  var capturedCall = null;
  var fakeRunCommand = function(cmd, args, opts) {
    capturedCall = { cmd: cmd, args: args, opts: opts };
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  };
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(capturedCall.cmd, 'sudo');
  assert.deepStrictEqual(capturedCall.args, ['/usr/local/sbin/pipeline-staging-ops', 'deploy', VALID_DEPLOY_REF]);
  assert.strictEqual(capturedCall.opts.shell, undefined, 'shell should not be set (undefined means falsy)');
  assert.strictEqual(capturedCall.opts.timeout, 600000, 'timeout should be 600000ms');
});

// 3k: non-zero exit -> DEPLOY_REFUSED with redacted stderrExcerpt
test('3k: non-zero exit returns DEPLOY_REFUSED with redacted stderr', async function() {
  process.env.SECRET_TOKEN = SECRET_TOKEN;
  try {
    var fakeRunCommand = makeFakeRunCommand([{ exitCode: 1, stdout: '', stderr: 'permission denied ' + SECRET_TOKEN, timedOut: false }]);
    var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
      runCommand: fakeRunCommand
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocker.code, 'DEPLOY_REFUSED');
    assert.strictEqual(result.blocker.evidence.exitCode, 1);
    assert.strictEqual(result.blocker.evidence.stderrExcerpt.indexOf(SECRET_TOKEN), -1, 'secret token should be redacted');
  } finally {
    delete process.env.SECRET_TOKEN;
  }
});

test('3k: runCommand throws returns DEPLOY_REFUSED', async function() {
  process.env.SECRET_TOKEN = SECRET_TOKEN;
  try {
    var fakeRunCommand = function() {
      return Promise.reject(new Error('spawn error with ' + SECRET_TOKEN));
    };
    var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
      runCommand: fakeRunCommand
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocker.code, 'DEPLOY_REFUSED');
    assert.strictEqual(result.blocker.evidence.stderrExcerpt.indexOf(SECRET_TOKEN), -1, 'secret token should be redacted');
  } finally {
    delete process.env.SECRET_TOKEN;
  }
});

// 3k: timeout -> DEPLOY_TIMEOUT
test('3k: timeout returns DEPLOY_TIMEOUT', async function() {
  var fakeRunCommand = makeFakeRunCommand([{ exitCode: null, stdout: '', stderr: 'timeout', timedOut: true }]);
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'DEPLOY_TIMEOUT');
});

// 3l: health - success after N polls
test('3l: health check succeeds after retries', async function() {
  var callCount = 0;
  var fakeFetch = function() {
    callCount++;
    return Promise.resolve({ status: callCount >= 3 ? 200 : 503 });
  };
  var sleptValues = [];
  var fakeSleep = function(ms) {
    sleptValues.push(ms);
    return Promise.resolve();
  };
  var fakeRunCommand = makeFakeRunCommand([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand,
    healthUrl: 'http://health/check',
    fetch: fakeFetch,
    sleep: fakeSleep,
    healthMs: 60000
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(callCount, 3);
});

// 3l: never-200 -> HEALTH_TIMEOUT
test('3l: never-200 returns HEALTH_TIMEOUT', async function() {
  var fakeFetch = function() {
    return Promise.resolve({ status: 503 });
  };
  var fakeSleep = function() { return Promise.resolve(); };
  var fakeRunCommand = makeFakeRunCommand([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand,
    healthUrl: 'http://health/check',
    fetch: fakeFetch,
    sleep: fakeSleep,
    healthMs: 1000
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'HEALTH_TIMEOUT');
});

// 3l: fetch error counted as not healthy
test('3l: fetch error does not fail health check immediately', async function() {
  var callCount = 0;
  var fakeFetch = function() {
    callCount++;
    if (callCount < 3) {
      return Promise.reject(new Error('network error'));
    }
    return Promise.resolve({ status: 200 });
  };
  var sleptValues = [];
  var fakeSleep = function(ms) {
    sleptValues.push(ms);
    return Promise.resolve();
  };
  var fakeRunCommand = makeFakeRunCommand([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand,
    healthUrl: 'http://health/check',
    fetch: fakeFetch,
    sleep: fakeSleep,
    healthMs: 60000
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(callCount, 3);
});

// 3m: token never appears in any returned object
test('3m: token does not appear in result JSON', async function() {
  process.env.SECRET_TOKEN = SECRET_TOKEN;
  try {
    var fakeRunCommand = makeFakeRunCommand([{ exitCode: 1, stdout: '', stderr: 'error with ' + SECRET_TOKEN, timedOut: false }]);
    var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
      runCommand: fakeRunCommand
    });
    var resultJson = JSON.stringify(result);
    assert.strictEqual(resultJson.indexOf(SECRET_TOKEN), -1, 'token should not appear in result');
  } finally {
    delete process.env.SECRET_TOKEN;
  }
});

test('3m: token does not appear in success result', async function() {
  var fakeRunCommand = makeFakeRunCommand([{ exitCode: 0, stdout: 'deployed', stderr: '' }]);
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand
  });
  var resultJson = JSON.stringify(result);
  assert.strictEqual(resultJson.indexOf(SECRET_TOKEN), -1, 'token should not appear in result');
});

// DEPLOY_REF_RE tests
test('DEPLOY_REF_RE matches valid format', function() {
  assert.strictEqual(deployAdapter.DEPLOY_REF_RE.test(VALID_DEPLOY_REF), true);
  assert.strictEqual(deployAdapter.DEPLOY_REF_RE.test('ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:abc'), false);
  assert.strictEqual(deployAdapter.DEPLOY_REF_RE.test('ghcr.io/wrong/image@sha256:' + 'a'.repeat(64)), false);
  assert.strictEqual(deployAdapter.DEPLOY_REF_RE.test('docker.io/image:tag'), false);
});

test('DEPLOY_REF_RE is exported', function() {
  assert.ok(deployAdapter.DEPLOY_REF_RE instanceof RegExp);
});

// deploy: no healthUrl returns ok immediately
test('deploy: no healthUrl returns ok immediately', async function() {
  var fakeRunCommand = makeFakeRunCommand([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
  var result = await deployAdapter.deploy(VALID_DEPLOY_REF, {
    runCommand: fakeRunCommand,
    healthUrl: null
  });
  assert.strictEqual(result.ok, true);
});