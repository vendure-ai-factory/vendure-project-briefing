'use strict';

var buildAdapter = require('../src/repair/buildAdapter');

var test = require('node:test');
var assert = require('node:assert');

var TEST_FIX_SHA = 'abc123def456789012345678901234567890abcd';
var TEST_DIGEST = 'sha256:' + 'a'.repeat(64);
var TEST_IMAGE = 'ghcr.io/vendure-ai-factory/nail-patterns-vendure:v1.2.3';
var TEST_ARTIFACT_NAME = 'staging-image-identity-' + TEST_FIX_SHA;
var VALID_DEPLOY_REF = 'ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + 'a'.repeat(64);

function makeFakeFetch(responses) {
  var index = 0;
  var capturedRequests = [];
  function fetchFn(url, opts) {
    capturedRequests.push({ url: url, opts: opts });
    if (index < responses.length) {
      var resp = responses[index++];
      if (typeof resp === 'function') {
        return resp(url, opts, capturedRequests);
      }
      return resp;
    }
    return { status: 404, json: function() { return Promise.resolve({}); } };
  }
  fetchFn.getCaptured = function() { return capturedRequests; };
  return fetchFn;
}

function makeRunsResponse(runs) {
  return {
    status: 200,
    json: function() { return Promise.resolve({ workflow_runs: runs }); }
  };
}

function makeArtifactResponse(artifacts) {
  return {
    status: 200,
    json: function() { return Promise.resolve({ artifacts: artifacts }); }
  };
}

// CRC-32 table
var CRC_TABLE = [];
(function() {
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[n] = c;
  }
})();

function crc32(buf) {
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files, opts) {
  opts = opts || {};
  var method = opts.method || 8; // default deflate
  var dataDescriptor = opts.dataDescriptor || false;

  var parts = [];
  var centralDirParts = [];
  var localHeaderOffset = 0;

  for (var i = 0; i < files.length; i++) {
    var name = files[i].name;
    var content = Buffer.from(files[i].content, 'utf8');
    var nameBytes = Buffer.from(name, 'utf8');

    // Compress content
    var compressed;
    var uncompressedSize = content.length;
    var crc = crc32(content);

    if (method === 0) {
      // Stored - no compression
      compressed = content;
    } else {
      // Deflated
      compressed = require('zlib').deflateRawSync(content);
    }

    var compressedSize = compressed.length;

    // General purpose bit flag
    var gpFlag = dataDescriptor ? 0x08 : 0x00;

    // Local file header
    var localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(gpFlag, 6); // general purpose bit flag
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14); // crc32
    localHeader.writeUInt32LE(dataDescriptor ? 0 : compressedSize, 18); // compressed size (0 if data descriptor)
    localHeader.writeUInt32LE(dataDescriptor ? 0 : uncompressedSize, 22); // uncompressed size (0 if data descriptor)
    localHeader.writeUInt16LE(nameBytes.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30); // file name

    parts.push(localHeader);
    parts.push(compressed);

    // Data descriptor (if required)
    if (dataDescriptor) {
      var dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); // optional signature
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(compressedSize, 8);
      dd.writeUInt32LE(uncompressedSize, 12);
      parts.push(dd);
    }

    // Central directory entry
    var cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // signature
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(gpFlag, 8); // general purpose bit flag
    cdEntry.writeUInt16LE(method, 10); // compression method
    cdEntry.writeUInt16LE(0, 12); // mod time
    cdEntry.writeUInt16LE(0, 14); // mod date
    cdEntry.writeUInt32LE(crc, 16); // crc32
    cdEntry.writeUInt32LE(compressedSize, 20); // compressed size
    cdEntry.writeUInt32LE(uncompressedSize, 24); // uncompressed size
    cdEntry.writeUInt16LE(nameBytes.length, 28); // file name length
    cdEntry.writeUInt16LE(0, 30); // extra field length
    cdEntry.writeUInt16LE(0, 32); // file comment length
    cdEntry.writeUInt16LE(0, 34); // disk number start
    cdEntry.writeUInt16LE(0, 36); // internal file attributes
    cdEntry.writeUInt32LE(0, 38); // external file attributes
    cdEntry.writeUInt32LE(localHeaderOffset, 42); // relative offset of local header
    nameBytes.copy(cdEntry, 46);

    centralDirParts.push(cdEntry);

    localHeaderOffset += localHeader.length + compressed.length + (dataDescriptor ? 12 : 0);
  }

  var centralDir = Buffer.concat(centralDirParts);
  var cdOffset = 0;
  for (var i = 0; i < parts.length; i++) {
    if (i === 0) break;
  }
  // Actually calculate cdOffset by summing all parts before central dir
  var cdStartOffset = 0;
  for (var i = 0; i < parts.length; i++) {
    cdStartOffset += parts[i].length;
  }

  // EOCD record
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // size of central dir
  eocd.writeUInt32LE(cdStartOffset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat(parts.concat([centralDir, eocd]));
}

// Legacy helper for backwards compatibility with existing tests
function makeZipBuffer(content) {
  var zip = makeZip([{ name: 'image-identity.txt', content: content }], { method: 8 });
  // Return proper ArrayBuffer with correct size
  return Uint8Array.from(zip).buffer;
}

// 3a: branch not starting with codex/ is refused before any fetch
test('3a: branch not starting with codex/ is refused before any fetch', async function() {
  var fetchCalled = false;
  var fakeFetch = function() {
    fetchCalled = true;
    return Promise.resolve({ status: 204 });
  };
  var result = await buildAdapter.buildAndPublish({
    branch: 'main',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_DISPATCH_FAILED');
  assert.strictEqual(fetchCalled, false, 'fetch should not be called for invalid branch');
});

// 3a: dispatch body and headers are correct
test('3a: dispatch body and headers are correct', async function() {
  var capturedBody = null;
  var capturedHeaders = null;
  var fakeFetch = function(url, opts) {
    if (url.indexOf('/dispatches') !== -1) {
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return { status: 204 };
    }
    return { status: 200, json: function() { return Promise.resolve({ workflow_runs: [] }); } };
  };
  await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'test-token',
    fetch: fakeFetch,
    now: function() { return Date.now(); },
    sleep: function() { return Promise.resolve(); },
    maxMs: 100
  });
  assert.strictEqual(capturedBody.event_type, 'build-staging-image');
  assert.deepStrictEqual(capturedBody.client_payload, { ref: 'codex/fix-branch' });
  assert.strictEqual(capturedHeaders['Authorization'], 'Bearer test-token');
  assert.strictEqual(capturedHeaders['X-GitHub-Api-Version'], '2022-11-28');
});

// 3b: dispatch 401/403/404/422 -> IMAGE_BUILD_DISPATCH_FAILED
test('3b: dispatch 401 returns IMAGE_BUILD_DISPATCH_FAILED', async function() {
  var fakeFetch = function() {
    return Promise.resolve({ status: 401, text: function() { return Promise.resolve('unauthorized'); } });
  };
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'super-secret-token-12345',
    fetch: fakeFetch
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_DISPATCH_FAILED');
  assert.strictEqual(result.blocker.evidence.status, 401);
  assert.strictEqual(result.blocker.message.indexOf('super-secret-token'), -1, 'token should not appear in message');
});

test('3b: dispatch 403 returns IMAGE_BUILD_DISPATCH_FAILED', async function() {
  var fakeFetch = function() {
    return Promise.resolve({ status: 403, text: function() { return Promise.resolve('forbidden'); } });
  };
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'token-should-not-appear',
    fetch: fakeFetch
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_DISPATCH_FAILED');
  assert.strictEqual(result.blocker.evidence.status, 403);
});

test('3b: dispatch 404 returns IMAGE_BUILD_DISPATCH_FAILED', async function() {
  var fakeFetch = function() {
    return Promise.resolve({ status: 404, text: function() { return Promise.resolve('not found'); } });
  };
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'my-secret-key',
    fetch: fakeFetch
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_DISPATCH_FAILED');
  assert.strictEqual(result.blocker.evidence.status, 404);
});

test('3b: dispatch 422 returns IMAGE_BUILD_DISPATCH_FAILED', async function() {
  var fakeFetch = function() {
    return Promise.resolve({ status: 422, text: function() { return Promise.resolve('unprocessable'); } });
  };
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'another-secret',
    fetch: fakeFetch
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_DISPATCH_FAILED');
  assert.strictEqual(result.blocker.evidence.status, 422);
});

// 3c: polling - maxMs exceeded -> IMAGE_BUILD_TIMEOUT
test('3c: IMAGE_BUILD_TIMEOUT when maxMs exceeded', async function() {
  var dispatchTime = Date.now();
  var callCount = 0;
  var elapsedMs = 0;
  var fakeFetch = function(url) {
    callCount++;
    if (url.indexOf('/dispatches') !== -1) {
      return Promise.resolve({ status: 204 });
    }
    if (url.indexOf('/workflows/') !== -1) {
      var run = {
        id: 123,
        head_sha: TEST_FIX_SHA,
        event: 'repository_dispatch',
        status: 'in_progress',
        created_at: new Date(dispatchTime + 1000).toISOString(),
        html_url: 'https://github.com/run/123'
      };
      return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ workflow_runs: [run] }); } });
    }
    return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ artifacts: [] }); } });
  };
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { elapsedMs += 50; return dispatchTime + elapsedMs; },
    sleep: function() { return Promise.resolve(); },
    maxMs: 100
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_TIMEOUT');
});

test('3c: IMAGE_BUILD_FAILED when workflow conclusion is failure', async function() {
  var dispatchTime = Date.now();
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{
      id: 123,
      head_sha: TEST_FIX_SHA,
      event: 'repository_dispatch',
      status: 'completed',
      conclusion: 'failure',
      created_at: new Date(dispatchTime + 1000).toISOString(),
      html_url: 'https://github.com/run/123'
    }])
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_FAILED');
  assert.strictEqual(result.blocker.evidence.runUrl, 'https://github.com/run/123');
  assert.strictEqual(result.blocker.evidence.conclusion, 'failure');
});

test('3c: IMAGE_BUILD_FAILED when workflow conclusion is cancelled', async function() {
  var dispatchTime = Date.now();
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{
      id: 123,
      head_sha: TEST_FIX_SHA,
      event: 'repository_dispatch',
      status: 'completed',
      conclusion: 'cancelled',
      created_at: new Date(dispatchTime + 1000).toISOString(),
      html_url: 'https://github.com/run/456'
    }])
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'IMAGE_BUILD_FAILED');
});

// 3d: artifact name must equal exactly 'staging-image-identity-<fixSha>'
test('3d: similarly named artifact is NOT accepted', async function() {
  var dispatchTime = Date.now();
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{
      id: 123,
      head_sha: TEST_FIX_SHA,
      event: 'repository_dispatch',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date(dispatchTime + 1000).toISOString(),
      html_url: 'https://github.com/run/123'
    }]),
    makeArtifactResponse([
      { id: 1, name: 'staging-image-identity-wrongsha', created_at: new Date().toISOString() },
      { id: 2, name: 'staging-image-identity-' + TEST_FIX_SHA + '-extra', created_at: new Date().toISOString() }
    ])
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_MISSING');
  assert.strictEqual(result.blocker.evidence.expectedName, TEST_ARTIFACT_NAME);
});

// 3g: identity validation - commit mismatch
test('3g: ARTIFACT_INVALID when commit !== fixSha', async function() {
  var dispatchTime = Date.now();
  var content = 'commit=wrongsha\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE;
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(makeZipBuffer(content)); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_INVALID');
  assert.strictEqual(result.blocker.message, 'commit mismatch');
});

// 3g: identity validation - published !== 'true'
test('3g: ARTIFACT_INVALID when published !== true', async function() {
  var dispatchTime = Date.now();
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=false\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE;
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(makeZipBuffer(content)); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_INVALID');
  assert.strictEqual(result.blocker.message, 'image not published');
});

// 3g: identity validation - digest not matching pattern
test('3g: ARTIFACT_INVALID when digest format is invalid', async function() {
  var dispatchTime = Date.now();
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=invalid-digest\nimage=' + TEST_IMAGE;
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(makeZipBuffer(content)); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_INVALID');
  assert.strictEqual(result.blocker.message, 'invalid digest format');
});

// 3g: identity validation - image not starting with IMAGE_REPO + ':'
test('3g: ARTIFACT_INVALID when image prefix is wrong', async function() {
  var dispatchTime = Date.now();
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=wrong/image:v1';
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(makeZipBuffer(content)); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_INVALID');
  assert.strictEqual(result.blocker.message, 'image does not match expected prefix');
});

// 3h: success returns deployRef = IMAGE_REPO + '@' + digest
test('3h: success returns correct deployRef format', async function() {
  var dispatchTime = Date.now();
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE;
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(makeZipBuffer(content)); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deployRef, 'ghcr.io/vendure-ai-factory/nail-patterns-vendure@' + TEST_DIGEST);
  assert.strictEqual(result.digest, TEST_DIGEST);
  assert.strictEqual(result.runUrl, 'https://github.com/run/123');
  assert.strictEqual(result.runId, '123');
});

// 3i: baselineDigest uses branch codex/staging-vendure-3.7.3 and status success
test('3i: baselineDigest uses correct branch and status parameters', async function() {
  var capturedUrl = null;
  var fakeFetch = function(url) {
    // Only capture the runs URL, not subsequent artifact URLs
    if (url.indexOf('/workflows/') !== -1 && url.indexOf('/runs') !== -1) {
      capturedUrl = url;
      if (url.indexOf('branch=codex%2Fstaging-vendure-3.7.3') !== -1 && url.indexOf('status=success') !== -1) {
        return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ workflow_runs: [{ id: 789, name: 'test', created_at: new Date().toISOString() }] }); } });
      }
    }
    return Promise.resolve({ status: 200, json: function() { return Promise.resolve({ artifacts: [] }); } });
  };
  var result = await buildAdapter.baselineDigest({
    token: 'fake-token',
    fetch: fakeFetch
  });
  assert.strictEqual(result.ok, false);
  assert.ok(capturedUrl.indexOf('branch=codex%2Fstaging-vendure-3.7.3') !== -1);
  assert.ok(capturedUrl.indexOf('status=success') !== -1);
});

// parseIdentity tests
test('parseIdentity: returns ok:true with identity object', function() {
  var result = buildAdapter.parseIdentity('commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.identity.commit, TEST_FIX_SHA);
  assert.strictEqual(result.identity.published, 'true');
  assert.strictEqual(result.identity.digest, TEST_DIGEST);
  assert.strictEqual(result.identity.image, TEST_IMAGE);
});

test('parseIdentity: returns ok:false with error for invalid input', function() {
  var result1 = buildAdapter.parseIdentity(null);
  assert.strictEqual(result1.ok, false);
  assert.ok(result1.error);
  var result2 = buildAdapter.parseIdentity(undefined);
  assert.strictEqual(result2.ok, false);
  var result3 = buildAdapter.parseIdentity(123);
  assert.strictEqual(result3.ok, false);
});

test('parseIdentity: CRLF line endings work', function() {
  var result = buildAdapter.parseIdentity('commit=' + TEST_FIX_SHA + '\r\npublished=true\r\ndigest=' + TEST_DIGEST + '\r\nimage=' + TEST_IMAGE);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.identity.commit, TEST_FIX_SHA);
});

test('parseIdentity: whitespace is trimmed', function() {
  var result = buildAdapter.parseIdentity('  commit  =  ' + TEST_FIX_SHA + '  \n  published = true  \ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.identity.commit, TEST_FIX_SHA);
  assert.strictEqual(result.identity.published, 'true');
});

// DEPLOY_REF_RE tests
test('DEPLOY_REF_RE matches valid format', function() {
  assert.strictEqual(buildAdapter.DEPLOY_REF_RE.test(VALID_DEPLOY_REF), true);
  assert.strictEqual(buildAdapter.DEPLOY_REF_RE.test('ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:abc'), false);
  assert.strictEqual(buildAdapter.DEPLOY_REF_RE.test('ghcr.io/wrong/image@sha256:' + 'a'.repeat(64)), false);
  assert.strictEqual(buildAdapter.DEPLOY_REF_RE.test('docker.io/image:tag'), false);
  assert.strictEqual(buildAdapter.DEPLOY_REF_RE.test('ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:' + 'A'.repeat(64)), false);
});

// 3m: token never appears in returned objects
test('3m: token does not appear in result JSON', async function() {
  var fakeFetch = makeFakeFetch([
    { status: 401, text: function() { return Promise.resolve('unauthorized'); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'super-secret-token-abc123',
    fetch: fakeFetch
  });
  var resultJson = JSON.stringify(result);
  assert.strictEqual(resultJson.indexOf('super-secret-token-abc123'), -1, 'token should not appear in result');
});

// a: zip: stored entry (method 0)
test('zip: stored entry', function() {
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE;
  var zipBuf = makeZip([{ name: 'image-identity.txt', content: content }], { method: 0 });
  var result = buildAdapter.extractZipEntry(zipBuf, 'image-identity.txt');
  assert.strictEqual(result, content);
});

// b: zip: deflated entry (method 8)
test('zip: deflated entry', function() {
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE;
  var zipBuf = makeZip([{ name: 'image-identity.txt', content: content }], { method: 8 });
  var result = buildAdapter.extractZipEntry(zipBuf, 'image-identity.txt');
  assert.strictEqual(result, content);
});

// c: zip: deflated entry with data descriptor (local header sizes are 0)
test('zip: deflated entry with data descriptor (local header sizes are 0)', function() {
  var content = 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE;
  var zipBuf = makeZip([{ name: 'image-identity.txt', content: content }], { method: 8, dataDescriptor: true });
  var result = buildAdapter.extractZipEntry(zipBuf, 'image-identity.txt');
  assert.strictEqual(result, content);
});

// d: zip: real GitHub artifact fixture
test('zip: real GitHub artifact fixture', async function() {
  var path = require('path');
  var fs = require('fs');
  var fixturePath = path.join(__dirname, 'fixtures/repair/staging-image-identity-c42a1a37.zip');
  var zipBuf = fs.readFileSync(fixturePath);
  var extracted = buildAdapter.extractZipEntry(zipBuf, 'image-identity.txt');
  assert.notStrictEqual(extracted, null, 'extractZipEntry should return content, not null');
  var identityResult = buildAdapter.parseIdentity(extracted);
  assert.strictEqual(identityResult.ok, true);
  assert.strictEqual(identityResult.identity.digest, 'sha256:0ce203e6b20dfda605ce02c491a0f6fced549d4f37bbdd42379ad17d1bd70a76');
  assert.strictEqual(identityResult.identity.commit, 'c42a1a37a58f364c848637dcb922c950f58ddc6f');
  assert.strictEqual(identityResult.identity.published, 'true');

  var dispatchTime = Date.now();
  var fixtureBuf = fs.readFileSync(fixturePath);
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: 'c42a1a37a58f364c848637dcb922c950f58ddc6f', event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: 'staging-image-identity-c42a1a37a58f364c848637dcb922c950f58ddc6f', created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(Uint8Array.from(fixtureBuf).buffer); } }
  ]);
  var buildResult = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: 'c42a1a37a58f364c848637dcb922c950f58ddc6f',
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(buildResult.ok, true);
  assert.strictEqual(buildResult.deployRef, 'ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:0ce203e6b20dfda605ce02c491a0f6fced549d4f37bbdd42379ad17d1bd70a76');
});

// e: zip: no image-identity.txt -> ARTIFACT_INVALID
test('zip: no image-identity.txt -> ARTIFACT_INVALID', async function() {
  var dispatchTime = Date.now();
  var zipBuf = makeZip([{ name: 'other-file.txt', content: 'some content' }], { method: 8 });
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(Uint8Array.from(zipBuf).buffer); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_INVALID');
  assert.strictEqual(result.blocker.message, 'image-identity.txt not found in artifact');
});

// f: zip: corrupt zip (truncated and wrong signature) -> ARTIFACT_INVALID
test('zip: corrupt zip (truncated and wrong signature) -> ARTIFACT_INVALID', async function() {
  var dispatchTime = Date.now();
  var corruptZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
  var fakeFetch = makeFakeFetch([
    { status: 204 },
    makeRunsResponse([{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }]),
    makeArtifactResponse([{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }]),
    { status: 302, headers: { get: function() { return 'https://download.example.com/zip'; } } },
    { status: 200, arrayBuffer: function() { return Promise.resolve(Uint8Array.from(corruptZip).buffer); } }
  ]);
  var result = await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'fake-token',
    fetch: fakeFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker.code, 'ARTIFACT_INVALID');
});

// g: zip: entry name with '..' -> ARTIFACT_INVALID
test("zip: entry name with '..' -> ARTIFACT_INVALID", function() {
  var zipBuf = makeZip([{ name: '../etc/passwd', content: 'secret' }], { method: 0 });
  var result = buildAdapter.extractZipEntry(zipBuf, '../etc/passwd');
  assert.strictEqual(result, null);
});

// h: 3e: artifact zip download - first request has Authorization, redirected request to another host has NO Authorization
test('3e: artifact zip download - first request has Authorization, redirected request to another host has NO Authorization', async function() {
  var firstReqHeaders = null;
  var secondReqUrl = null;
  var secondReqHeaders = null;
  var requestSeq = 0;
  var dispatchTime = Date.now();

  function captureFetch(url, opts) {
    requestSeq++;
    if (requestSeq === 1) {
      firstReqHeaders = opts && opts.headers || {};
      return { status: 204 };
    }
    if (requestSeq === 2) {
      return { status: 200, json: function() { return Promise.resolve({ workflow_runs: [{ id: 123, head_sha: TEST_FIX_SHA, event: 'repository_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(dispatchTime + 1000).toISOString(), html_url: 'https://github.com/run/123' }] }); } };
    }
    if (requestSeq === 3) {
      return { status: 200, json: function() { return Promise.resolve({ artifacts: [{ id: 456, name: TEST_ARTIFACT_NAME, created_at: new Date().toISOString() }] }); } };
    }
    if (requestSeq === 4) {
      firstReqHeaders = opts && opts.headers || {};
      return { status: 302, headers: { get: function() { return 'https://redirect.example.com/artifact.zip'; } } };
    }
    if (requestSeq === 5) {
      secondReqUrl = url;
      secondReqHeaders = opts && opts.headers || {};
      return { status: 200, arrayBuffer: function() { return Promise.resolve(makeZipBuffer('commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE)); } };
    }
    return { status: 404 };
  }

  await buildAdapter.buildAndPublish({
    branch: 'codex/fix-branch',
    fixSha: TEST_FIX_SHA,
    token: 'my-secret-token',
    fetch: captureFetch,
    now: function() { return dispatchTime; },
    sleep: function() { return Promise.resolve(); }
  });

  assert.strictEqual(firstReqHeaders['Authorization'], 'Bearer my-secret-token', 'first (artifact download) request must have Authorization');
  assert.strictEqual(secondReqHeaders['Authorization'], undefined, 'redirected request must NOT have Authorization');
  assert.ok(secondReqUrl.indexOf('https://') === 0, 'redirect target must use https (not http)');
});

// i: 3f: zip reading does not use child_process
test('3f: zip reading does not use child_process', function() {
  var fs = require('fs');
  var path = require('path');
  var srcPath = path.join(__dirname, '../src/repair/buildAdapter.js');
  var srcText = fs.readFileSync(srcPath, 'utf8');
  assert.strictEqual(srcText.indexOf('child_process'), -1, 'buildAdapter.js must not contain child_process');
  var Module = require('module');
  var originalLoad = Module._load;
  var execFileThrew = false;
  Module._load = function(request, parent) {
    if (request === 'child_process') {
      var fake = {};
      fake.execFile = function() { execFileThrew = true; throw new Error('execFile should not be called'); };
      return fake;
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../src/repair/buildAdapter')];
  var freshAdapter = require('../src/repair/buildAdapter');
  var zipBuf = makeZip([{ name: 'image-identity.txt', content: 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE }], { method: 8 });
  var result = freshAdapter.extractZipEntry(zipBuf, 'image-identity.txt');
  assert.strictEqual(execFileThrew, false, 'child_process.execFile must not be called');
  assert.strictEqual(result, 'commit=' + TEST_FIX_SHA + '\npublished=true\ndigest=' + TEST_DIGEST + '\nimage=' + TEST_IMAGE);
  Module._load = originalLoad;
});