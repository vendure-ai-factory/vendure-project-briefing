'use strict';

/**
 * Read-only loader for the frozen synthetic-staging fixture set.
 *
 * Loads manifest/fixtures.v1.json and verifies its sha256 against
 * manifest/fixtures.v1.sha256 before returning the parsed fixture. Any
 * tampering or a missing/mismatched pin is reported as an error and no data
 * is returned. Not yet wired into preflight.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var REPO_ROOT = path.resolve(__dirname, '..');
var FIXTURES_FILE = path.join(REPO_ROOT, 'manifest', 'fixtures.v1.json');
var SHA_FILE = path.join(REPO_ROOT, 'manifest', 'fixtures.v1.sha256');

function sha256Hex(value) {
  // Normalize CRLF to LF so a checkout that converts fixtures.v1.json to CRLF
  // (or back) still produces the pinned hash. Pinned hashes are LF-based.
  return crypto.createHash('sha256').update(String(value).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function loadFixturesFile(filePath, shaPath) {
  filePath = filePath || FIXTURES_FILE;
  shaPath = shaPath || SHA_FILE;

  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'fixtures file missing: ' + filePath };
  }
  if (!fs.existsSync(shaPath)) {
    return { ok: false, error: 'fixtures sha256 missing: ' + shaPath };
  }

  var content = fs.readFileSync(filePath, 'utf8');
  var pinned = fs.readFileSync(shaPath, 'utf8').trim();
  var actual = sha256Hex(content);

  if (pinned !== actual) {
    return { ok: false, error: 'fixtures sha256 mismatch: pinned=' + pinned + ' actual=' + actual };
  }

  var parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { ok: false, error: 'fixtures file not valid JSON: ' + e.message };
  }

  return { ok: true, fixtures: parsed, sha256: actual };
}

module.exports = {
  FIXTURES_FILE: FIXTURES_FILE,
  SHA_FILE: SHA_FILE,
  loadFixturesFile: loadFixturesFile
};
