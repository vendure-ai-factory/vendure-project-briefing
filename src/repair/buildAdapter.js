'use strict';

var zlib = require('zlib');
var path = require('path');
var fs = require('fs');

var OWNER_REPO = 'vendure-ai-factory/vendure-staging-baseline';
var WORKFLOW_FILE = 'staging-image.yml';
var IMAGE_REPO = 'ghcr.io/vendure-ai-factory/nail-patterns-vendure';
var BASE_BRANCH = 'codex/staging-vendure-3.7.3';

var DEPLOY_REF_RE = /^ghcr\.io\/vendure-ai-factory\/nail-patterns-vendure@sha256:[a-f0-9]{64}$/;

var REDACTED_MARKER = '[REDACTED]';

function redactSecrets(text, secretValues) {
  if (!secretValues || !Array.isArray(secretValues) || secretValues.length === 0) {
    return text;
  }
  var result = text;
  for (var i = 0; i < secretValues.length; i++) {
    var val = secretValues[i];
    if (val && typeof val === 'string' && result.indexOf(val) !== -1) {
      result = result.split(val).join(REDACTED_MARKER);
    }
  }
  return result;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') {
    return '';
  }
  return message.substring(0, 300);
}

function parseIdentity(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: 'invalid input' };
  }
  var identity = { image: null, digest: null, commit: null, ref: null, published: null };
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    var key = line.substring(0, eqIdx).trim();
    var value = line.substring(eqIdx + 1).trim();
    if (key === 'commit') identity.commit = value;
    else if (key === 'published') identity.published = value;
    else if (key === 'digest') identity.digest = value;
    else if (key === 'image') identity.image = value;
  }
  return { ok: true, identity: identity };
}

function extractZipEntry(zipBuffer, targetName) {
  var MAX_ENTRY_SIZE = 64 * 1024;
  try {
    var len = zipBuffer.length;
    if (len < 22) {
      return null;
    }

    // Find EOCD (End Of Central Directory) signature 0x06054b50 at end of file
    var eocdPos = -1;
    for (var i = len - 22; i >= 0; i--) {
      if (zipBuffer[i] === 0x50 && zipBuffer[i + 1] === 0x4b &&
          zipBuffer[i + 2] === 0x05 && zipBuffer[i + 3] === 0x06) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos === -1) {
      return null;
    }

    // Read EOCD fields
    var cdEntries = zipBuffer.readUInt16LE(eocdPos + 10);
    var cdSize = zipBuffer.readUInt32LE(eocdPos + 12);
    var cdOffset = zipBuffer.readUInt32LE(eocdPos + 16);

    // Validate central directory bounds
    if (cdOffset >= len || cdEntries === 0 || cdSize === 0) {
      return null;
    }
    if (cdOffset + cdSize > eocdPos) {
      return null;
    }

    // Scan central directory for target entry
    var pos = cdOffset;
    for (var i = 0; i < cdEntries; i++) {
      // Check central directory signature 0x02014b50 (bytes: 50 4b 01 02)
      if (pos + 46 > len || zipBuffer[pos] !== 0x50 || zipBuffer[pos + 1] !== 0x4b ||
          zipBuffer[pos + 2] !== 0x01 || zipBuffer[pos + 3] !== 0x02) {
        return null;
      }

      var versionMade = zipBuffer[pos + 4] | (zipBuffer[pos + 5] << 8);
      var gpFlag = zipBuffer[pos + 8] | (zipBuffer[pos + 9] << 8);
      var method = zipBuffer[pos + 10] | (zipBuffer[pos + 11] << 8);
      var crc32 = zipBuffer.readUInt32LE(pos + 16);
      var compSize = zipBuffer.readUInt32LE(pos + 20);
      var uncompSize = zipBuffer.readUInt32LE(pos + 24);
      var nameLen = zipBuffer.readUInt16LE(pos + 28);
      var extraLen = zipBuffer.readUInt16LE(pos + 30);
      var commentLen = zipBuffer.readUInt16LE(pos + 32);
      var localHeaderOffset = zipBuffer.readUInt32LE(pos + 42);

      // Check for zip64 (version needed >= 4.5)
      var versionNeeded = zipBuffer[pos + 6] | (zipBuffer[pos + 7] << 8);
      if (versionNeeded >= 45) {
        return null; // zip64 not supported
      }

      // Check for encrypted bit
      if ((gpFlag & 0x01) !== 0) {
        return null; // encrypted not supported
      }

      // Security: reject absolute paths and .. entries
      if (nameLen === 0 || pos + 46 + nameLen > len) {
        return null;
      }
      var entryName = zipBuffer.toString('utf8', pos + 46, pos + 46 + nameLen);
      if (entryName.indexOf('/') === 0 || entryName.indexOf('\\') === 0) {
        return null; // absolute path
      }
      if (entryName.indexOf('..') !== -1) {
        return null; // path traversal
      }

      if (entryName === targetName) {
        // Found target entry
        if (uncompSize > MAX_ENTRY_SIZE) {
          return null;
        }

        // Check compression method
        if (method !== 0 && method !== 8) {
          return null; // only stored (0) and deflate (8) supported
        }

        // Data descriptor flag (bit 3 of gpFlag)
        var hasDataDescriptor = (gpFlag & 0x08) !== 0;

        // Read from local file header
        var localPos = localHeaderOffset;
        if (localPos + 30 + nameLen > len) {
          return null;
        }

        // Verify local header signature
        if (zipBuffer[localPos] !== 0x50 || zipBuffer[localPos + 1] !== 0x4b ||
            zipBuffer[localPos + 2] !== 0x03 || zipBuffer[localPos + 3] !== 0x04) {
          return null;
        }

        localPos += 4; // signature
        localPos += 2; // version needed
        localPos += 2; // gp flag
        localPos += 2; // compression method
        localPos += 2; // mod time
        localPos += 2; // mod date
        // crc32 already read from central dir
        localPos += 4;

        // Skip compressed size and uncompressed size (8 bytes)
        // Sizes come from the central directory (local header may be 0 with data descriptor)
        localPos += 8;

        var localNameLen = zipBuffer.readUInt16LE(localPos);
        localPos += 2;
        var localExtraLen = zipBuffer.readUInt16LE(localPos);
        localPos += 2;

        localPos += localNameLen;
        localPos += localExtraLen;

        // Now at start of file data
        if (localPos > len) {
          return null;
        }

        var fileData;
        if (hasDataDescriptor) {
          // Read until we find the data descriptor signature or run out of data
          // Data descriptor: optional signature 0x08074b50 followed by crc32, compSize, uncompSize
          // Since we have the sizes from central dir, use them directly
          fileData = zipBuffer.slice(localPos, localPos + compSize);
        } else {
          if (localPos + compSize > len) {
            return null;
          }
          fileData = zipBuffer.slice(localPos, localPos + compSize);
        }

        // Decompress if needed
        if (method === 0) {
          // Stored - return as-is
          return fileData.toString('utf8');
        } else if (method === 8) {
          // Deflated - use inflateRawSync
          var decompressed = zlib.inflateRawSync(fileData);
          return decompressed.toString('utf8');
        }
      }

      // Move to next central directory entry
      pos += 46 + nameLen + extraLen + commentLen;
      if (pos >= len) {
        return null;
      }
    }

    // Entry not found in central directory
    return null;
  } catch (e) {
    return null;
  }
}

async function downloadArtifactZip(fetchFn, artifactUrl, token, onRedirectHeaders) {
  var headers = {};
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  headers['Accept'] = 'application/vnd.github+json';
  headers['X-GitHub-Api-Version'] = '2022-11-28';
  var response = await fetchFn(artifactUrl, {
    method: 'GET',
    headers: headers,
    redirect: 'manual'
  });
  if (response.status !== 302 && response.status !== 303) {
    return { ok: false, blocker: { code: 'ARTIFACT_DOWNLOAD_FAILED', message: 'unexpected redirect status', evidence: { status: response.status } } };
  }
  var location = null;
  if (response.headers && typeof response.headers.get === 'function') {
    location = response.headers.get('location');
  }
  if (!location) {
    return { ok: false, blocker: { code: 'ARTIFACT_DOWNLOAD_FAILED', message: 'no redirect location', evidence: {} } };
  }
  var redirectHeaders = {};
  var redirectResponse = await fetchFn(location, {
    method: 'GET',
    headers: redirectHeaders,
    redirect: 'manual'
  });
  if (onRedirectHeaders && typeof onRedirectHeaders === 'function') {
    onRedirectHeaders(redirectHeaders);
  }
  if (redirectResponse.status !== 200) {
    return { ok: false, blocker: { code: 'ARTIFACT_DOWNLOAD_FAILED', message: 'download failed', evidence: { status: redirectResponse.status } } };
  }
  var buffer = null;
  if (redirectResponse.arrayBuffer) {
    var ab = await redirectResponse.arrayBuffer();
    buffer = Buffer.from(ab);
  } else if (redirectResponse.buffer) {
    buffer = await redirectResponse.buffer();
  } else if (redirectResponse.body && redirectResponse.body.getReader) {
    buffer = Buffer.alloc(0);
    var reader = redirectResponse.body.getReader();
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      var oldLen = buffer.length;
      var newBuf = Buffer.alloc(oldLen + r.value.length);
      newBuf.set(buffer, 0);
      newBuf.set(r.value, oldLen);
      buffer = newBuf;
    }
  }
  return { ok: true, buffer: buffer };
}

async function buildAndPublish(options) {
  options = options || {};
  var branch = options.branch;
  var fixSha = options.fixSha;
  var token = options.token;
  var fetch = options.fetch || global.fetch;
  var now = options.now || Date.now;
  var sleep = options.sleep || function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var pollMs = options.pollMs || 15000;
  var maxMs = options.maxMs || 1500000;

  var branchPattern = /^codex\//;
  if (!branch || !branchPattern.test(branch)) {
    return {
      ok: false,
      blocker: {
        code: 'IMAGE_BUILD_DISPATCH_FAILED',
        message: 'branch validation failed',
        evidence: { status: 400, sanitizedMessage: 'branch must match ^codex/' }
      }
    };
  }

  var dispatchUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/dispatches';
  var dispatchHeaders = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
  var dispatchBody = JSON.stringify({
    event_type: 'build-staging-image',
    client_payload: { ref: branch }
  });

  var dispatchResponse;
  try {
    dispatchResponse = await fetch(dispatchUrl, {
      method: 'POST',
      headers: dispatchHeaders,
      body: dispatchBody
    });
  } catch (err) {
    return {
      ok: false,
      blocker: {
        code: 'IMAGE_BUILD_DISPATCH_FAILED',
        message: 'dispatch request failed',
        evidence: { status: null, sanitizedMessage: sanitizeMessage(err.message) }
      }
    };
  }

  if (dispatchResponse.status !== 204) {
    var errMsg = 'dispatch failed with status ' + dispatchResponse.status;
    var respText = '';
    try { respText = await dispatchResponse.text(); } catch (e) { /* ok */ }
    return {
      ok: false,
      blocker: {
        code: 'IMAGE_BUILD_DISPATCH_FAILED',
        message: errMsg,
        evidence: {
          status: dispatchResponse.status,
          sanitizedMessage: sanitizeMessage(respText)
        }
      }
    };
  }

  var startTime = typeof now === 'function' ? now() : Date.now();
  var dispatchTime = typeof now === 'function' ? now() : Date.now();
  var runsUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/actions/workflows/' + WORKFLOW_FILE + '/runs?per_page=20';
  var runUrl = null;
  var runId = null;

  while (true) {
    var elapsed = (typeof now === 'function' ? now() : Date.now()) - startTime;
    if (elapsed > maxMs) {
      return {
        ok: false,
        blocker: {
          code: 'IMAGE_BUILD_TIMEOUT',
          message: 'polling timed out',
          evidence: { elapsed: elapsed, maxMs: maxMs }
        }
      };
    }

    await sleep(pollMs);

    var runsResponse;
    try {
      runsResponse = await fetch(runsUrl, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
    } catch (err) {
      await sleep(pollMs);
      continue;
    }

    if (runsResponse.status !== 200) {
      await sleep(pollMs);
      continue;
    }

    var runsData;
    try {
      runsData = await runsResponse.json();
    } catch (e) {
      await sleep(pollMs);
      continue;
    }

    var runs = runsData.workflow_runs || [];
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      var createdTs = new Date(run.created_at).getTime();
      if (createdTs < dispatchTime) continue;
      if (run.head_sha !== fixSha && run.event !== 'repository_dispatch') continue;
      if (run.status !== 'completed') continue;
      if (run.conclusion === 'success') {
        runUrl = run.html_url;
        runId = String(run.id);
        break;
      }
      if (run.conclusion && run.conclusion !== 'success') {
        return {
          ok: false,
          blocker: {
            code: 'IMAGE_BUILD_FAILED',
            message: 'workflow run failed',
            evidence: { runUrl: run.html_url, conclusion: run.conclusion }
          }
        };
      }
    }

    if (runId) break;
  }

  var artifactsUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/actions/runs/' + runId + '/artifacts';
  var artifactsResponse;
  try {
    artifactsResponse = await fetch(artifactsUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch (err) {
    return { ok: false, blocker: { code: 'ARTIFACT_FETCH_ERROR', message: sanitizeMessage(err.message), evidence: {} } };
  }

  if (artifactsResponse.status !== 200) {
    return { ok: false, blocker: { code: 'ARTIFACT_FETCH_ERROR', message: 'artifacts fetch failed', evidence: { status: artifactsResponse.status } } };
  }

  var artifactsData;
  try {
    artifactsData = await artifactsResponse.json();
  } catch (e) {
    return { ok: false, blocker: { code: 'ARTIFACT_PARSE_ERROR', message: 'failed to parse artifacts', evidence: {} } };
  }

  var artifacts = artifactsData.artifacts || [];
  var targetArtifactId = null;
  var latestCreatedAt = null;
  var expectedName = 'staging-image-identity-' + fixSha;

  for (var j = 0; j < artifacts.length; j++) {
    var art = artifacts[j];
    if (art.name === expectedName) {
      var artCreated = new Date(art.created_at).getTime();
      if (!latestCreatedAt || artCreated > latestCreatedAt) {
        latestCreatedAt = artCreated;
        targetArtifactId = art.id;
      }
    }
  }

  if (!targetArtifactId) {
    return {
      ok: false,
      blocker: {
        code: 'ARTIFACT_MISSING',
        message: 'artifact not found',
        evidence: { expectedName: expectedName, fixSha: fixSha }
      }
    };
  }

  var downloadUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/actions/artifacts/' + targetArtifactId + '/zip';
  var redirectHeadersCaptured = {};
  var dlResult = await downloadArtifactZip(fetch, downloadUrl, token, function(headers) {
    redirectHeadersCaptured = headers || {};
  });
  if (!dlResult.ok) {
    return dlResult;
  }

  var identityContent = extractZipEntry(dlResult.buffer, 'image-identity.txt');
  if (!identityContent) {
    return { ok: false, blocker: { code: 'ARTIFACT_INVALID', message: 'image-identity.txt not found in artifact', evidence: {} } };
  }

  var parseResult = parseIdentity(identityContent);
  if (!parseResult.ok) {
    return { ok: false, blocker: { code: 'ARTIFACT_EXTRACT_FAILED', message: parseResult.error, evidence: {} } };
  }

  var identity = parseResult.identity;
  var identityDigest = identity.digest;
  var identityPublished = identity.published;
  var identityImage = identity.image;
  var identityCommit = identity.commit;

  if (!identityCommit || identityCommit !== fixSha) {
    return {
      ok: false,
      blocker: {
        code: 'ARTIFACT_INVALID',
        message: 'commit mismatch',
        evidence: { expected: fixSha, actual: identityCommit }
      }
    };
  }

  if (identityPublished !== 'true') {
    return {
      ok: false,
      blocker: {
        code: 'ARTIFACT_INVALID',
        message: 'image not published',
        evidence: { published: identityPublished }
      }
    };
  }

  var digestPattern = /^sha256:[a-f0-9]{64}$/;
  if (!identityDigest || !digestPattern.test(identityDigest)) {
    return {
      ok: false,
      blocker: {
        code: 'ARTIFACT_INVALID',
        message: 'invalid digest format',
        evidence: { digest: identityDigest }
      }
    };
  }

  var expectedImagePrefix = IMAGE_REPO + ':';
  if (!identityImage || identityImage.indexOf(expectedImagePrefix) !== 0) {
    return {
      ok: false,
      blocker: {
        code: 'ARTIFACT_INVALID',
        message: 'image does not match expected prefix',
        evidence: { image: identityImage, expectedPrefix: expectedImagePrefix }
      }
    };
  }

  var deployRef = IMAGE_REPO + '@' + identityDigest;

  return {
    ok: true,
    deployRef: deployRef,
    digest: identityDigest,
    runUrl: runUrl,
    runId: runId
  };
}

async function baselineDigest(options) {
  options = options || {};
  var token = options.token;
  var fetch = options.fetch || global.fetch;

  var runsUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/actions/workflows/' + WORKFLOW_FILE + '/runs?branch=' + encodeURIComponent(BASE_BRANCH) + '&status=success&per_page=1';

  var runsResponse;
  try {
    runsResponse = await fetch(runsUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch (err) {
    return { ok: false, blocker: { code: 'BASELINE_FETCH_ERROR', message: sanitizeMessage(err.message), evidence: {} } };
  }

  if (runsResponse.status !== 200) {
    return { ok: false, blocker: { code: 'BASELINE_FETCH_ERROR', message: 'runs fetch failed', evidence: { status: runsResponse.status } } };
  }

  var runsData;
  try {
    runsData = await runsResponse.json();
  } catch (e) {
    return { ok: false, blocker: { code: 'BASELINE_PARSE_ERROR', message: 'failed to parse runs', evidence: {} } };
  }

  var runs = runsData.workflow_runs || [];
  if (runs.length === 0) {
    return { ok: false, blocker: { code: 'BASELINE_NOT_FOUND', message: 'no successful runs found', evidence: { branch: BASE_BRANCH } } };
  }

  var latestRun = runs[0];
  var runId = String(latestRun.id);

  var artifactsUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/actions/runs/' + runId + '/artifacts';
  var artifactsResponse;
  try {
    artifactsResponse = await fetch(artifactsUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch (err) {
    return { ok: false, blocker: { code: 'BASELINE_FETCH_ERROR', message: sanitizeMessage(err.message), evidence: {} } };
  }

  if (artifactsResponse.status !== 200) {
    return { ok: false, blocker: { code: 'BASELINE_FETCH_ERROR', message: 'artifacts fetch failed', evidence: { status: artifactsResponse.status } } };
  }

  var artifactsData;
  try {
    artifactsData = await artifactsResponse.json();
  } catch (e) {
    return { ok: false, blocker: { code: 'BASELINE_PARSE_ERROR', message: 'failed to parse artifacts', evidence: {} } };
  }

  var artifacts = artifactsData.artifacts || [];
  var targetArtifact = null;
  var latestCreatedAt = null;

  for (var i = 0; i < artifacts.length; i++) {
    var art = artifacts[i];
    var isTarget = art.name && art.name.indexOf('staging-image-identity-') === 0;
    if (isTarget) {
      var artCreated = new Date(art.created_at).getTime();
      if (!latestCreatedAt || artCreated > latestCreatedAt) {
        latestCreatedAt = artCreated;
        targetArtifact = art;
      }
    }
  }

  if (!targetArtifact) {
    return { ok: false, blocker: { code: 'BASELINE_NOT_FOUND', message: 'no matching artifact found', evidence: {} } };
  }

  var downloadUrl = 'https://api.github.com/repos/' + OWNER_REPO + '/actions/artifacts/' + targetArtifact.id + '/zip';
  var dlResult = await downloadArtifactZip(fetch, downloadUrl, token);
  if (!dlResult.ok) {
    return dlResult;
  }

  var identityContent = extractZipEntry(dlResult.buffer, 'image-identity.txt');
  if (!identityContent) {
    return { ok: false, blocker: { code: 'BASELINE_INVALID', message: 'image-identity.txt not found in artifact', evidence: {} } };
  }

  var parseResult = parseIdentity(identityContent);
  if (!parseResult.ok) {
    return { ok: false, blocker: { code: 'BASELINE_INVALID', message: parseResult.error, evidence: {} } };
  }

  var identity = parseResult.identity;
  var digestPattern = /^sha256:[a-f0-9]{64}$/;
  if (!identity.digest || !digestPattern.test(identity.digest)) {
    return { ok: false, blocker: { code: 'BASELINE_INVALID', message: 'invalid digest in identity file', evidence: { digest: identity.digest } } };
  }

  var deployRef = IMAGE_REPO + '@' + identity.digest;

  return { ok: true, deployRef: deployRef };
}

module.exports = {
  buildAndPublish: buildAndPublish,
  baselineDigest: baselineDigest,
  parseIdentity: parseIdentity,
  extractZipEntry: extractZipEntry,
  DEPLOY_REF_RE: DEPLOY_REF_RE
};