'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PROTECTED_ROOTS = [
  'manifest/acceptance-manifest.v0.4.json',
  'manifest/inputs-registry.json',
  'evaluation-demo/migration-input',
  'evaluation-demo/migration-input/legacy/vendure-store/scripts',
  'evaluation-demo/migration-input/legacy/vendure-store/tools'
];

function hashFile(filePath, crypto) {
  try {
    var content = fs.readFileSync(filePath);
    var isBinary = false;
    var sampleLen = Math.min(content.length, 8000);
    for (var i = 0; i < sampleLen; i++) {
      if (content[i] === 0) {
        isBinary = true;
        break;
      }
    }
    var data = content;
    if (!isBinary) {
      data = content.toString('utf8').replace(/\r\n/g, '\n');
    }
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch (e) {
    return null;
  }
}

function walkDir(rootPath, repoRoot, crypto) {
  var entries = [];
  var stack = [rootPath];

  while (stack.length > 0) {
    var current = stack.pop();
    var dirents;
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      continue;
    }

    for (var i = 0; i < dirents.length; i++) {
      var dirent = dirents[i];
      var fullPath = path.join(current, dirent.name);
      var repoRelPath = path.relative(repoRoot, fullPath);
      repoRelPath = repoRelPath.replace(/\\/g, '/');

      if (dirent.isDirectory()) {
        stack.push(fullPath);
      } else if (dirent.isFile()) {
        var fileHash = hashFile(fullPath, crypto);
        if (fileHash !== null) {
          entries.push({
            path: repoRelPath,
            hash: fileHash,
            root: path.relative(repoRoot, rootPath).replace(/\\/g, '/') || '.'
          });
        }
      }
    }
  }

  return entries;
}

function computeProtectedHashes(options) {
  options = options || {};
  var repoRoot = options.root || process.cwd();
  var cryptoImpl = options.crypto || crypto;

  var allEntries = [];

  for (var i = 0; i < PROTECTED_ROOTS.length; i++) {
    var rootRel = PROTECTED_ROOTS[i];
    var rootAbs = path.resolve(repoRoot, rootRel);
    var rootEntries;

    if (!fs.existsSync(rootAbs)) {
      continue;
    }

    var stat = fs.statSync(rootAbs);
    if (stat.isFile()) {
      var repoRelPath = rootRel;
      var fileHash = hashFile(rootAbs, cryptoImpl);
      if (fileHash !== null) {
        rootEntries = [{
          path: repoRelPath,
          hash: fileHash,
          root: '.'
        }];
      } else {
        rootEntries = [];
      }
    } else {
      rootEntries = walkDir(rootAbs, repoRoot, cryptoImpl);
    }

    for (var j = 0; j < rootEntries.length; j++) {
      allEntries.push(rootEntries[j]);
    }
  }

  var seen = {};
  var deduplicated = [];
  for (var k = 0; k < allEntries.length; k++) {
    var entry = allEntries[k];
    if (!seen[entry.path]) {
      seen[entry.path] = true;
      deduplicated.push(entry);
    }
  }

  deduplicated.sort(function(a, b) {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  var combinedData = '';
  for (var m = 0; m < deduplicated.length; m++) {
    combinedData += deduplicated[m].path + ':' + deduplicated[m].hash + '\n';
  }
  var combinedHash = cryptoImpl.createHash('sha256').update(combinedData).digest('hex');

  return {
    ok: true,
    entries: deduplicated,
    combinedHash: combinedHash,
    rootCount: deduplicated.length,
    error: null
  };
}

function diffProtectedHashes(before, after) {
  if (!before || !after) {
    return { ok: false, changed: [], error: 'Both before and after must be provided' };
  }
  var beforeMap = {};
  for (var i = 0; i < before.length; i++) {
    beforeMap[before[i].path] = before[i].hash;
  }
  var changed = [];
  for (var j = 0; j < after.length; j++) {
    var apath = after[j].path;
    var ahash = after[j].hash;
    if (!beforeMap.hasOwnProperty(apath)) {
      changed.push(apath);
    } else if (beforeMap[apath] !== ahash) {
      changed.push(apath);
    }
  }
  return { ok: true, changed: changed };
}

function loadPinnedHashes(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, valid: false, pinned: null, error: null };
  }
  var content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { exists: true, valid: false, pinned: null, error: e.message };
  }
  if (!content || content.trim().length === 0) {
    return { exists: true, valid: false, pinned: null, error: 'File is empty' };
  }
  var parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { exists: true, valid: false, pinned: null, error: e.message };
  }
  if (!Array.isArray(parsed.entries)) {
    return { exists: true, valid: false, pinned: null, error: 'pinned file must have entries array' };
  }
  return { exists: true, valid: true, pinned: parsed, error: null };
}

function verifyAgainstPinned(entries, pinned) {
  if (!pinned || !Array.isArray(pinned.entries)) {
    return { ok: false, changed: [], error: 'Invalid pinned structure' };
  }
  return diffProtectedHashes(pinned.entries, entries);
}

function writePinnedHashes(entries, targetPath) {
  var data = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    entries: entries
  };
  fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  PROTECTED_ROOTS: PROTECTED_ROOTS,
  hashFile: hashFile,
  computeProtectedHashes: computeProtectedHashes,
  diffProtectedHashes: diffProtectedHashes,
  loadPinnedHashes: loadPinnedHashes,
  verifyAgainstPinned: verifyAgainstPinned,
  writePinnedHashes: writePinnedHashes
};
