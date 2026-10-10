'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var protectedPaths = require('../src/protectedPaths');

function makeFixture() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  var dirs = [
    path.join(root, 'manifest'),
    path.join(root, 'evaluation-demo', 'migration-input'),
    path.join(root, 'evaluation-demo', 'migration-input', 'legacy', 'vendure-store', 'scripts'),
    path.join(root, 'evaluation-demo', 'migration-input', 'legacy', 'vendure-store', 'tools')
  ];
  dirs.forEach(function(d) { fs.mkdirSync(d, { recursive: true }); });

  fs.writeFileSync(path.join(root, 'manifest', 'acceptance-manifest.v0.4.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, 'manifest', 'inputs-registry.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'a.txt'), 'aaa', 'utf8');
  fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'legacy', 'vendure-store', 'scripts', 's1.mjs'), 's1', 'utf8');
  fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'legacy', 'vendure-store', 'tools', 't.sh'), 't', 'utf8');

  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

test('protectedPaths: PROTECTED_ROOTS are the exact sanctioned relative paths', function(t, done) {
  assert.deepStrictEqual(protectedPaths.PROTECTED_ROOTS, [
    'manifest/acceptance-manifest.v0.4.json',
    'manifest/inputs-registry.json',
    'evaluation-demo/migration-input',
    'evaluation-demo/migration-input/legacy/vendure-store/scripts',
    'evaluation-demo/migration-input/legacy/vendure-store/tools'
  ]);
  done();
});

test('protectedPaths: computeProtectedHashes hashes each unique file once (dedup by path)', function(t, done) {
  var root = makeFixture();
  try {
    var res = protectedPaths.computeProtectedHashes({ root: root });
    assert.strictEqual(res.ok, true);
    // 5 unique files: manifest, inputs-registry, a.txt, s1.mjs, t.sh
    // (scripts/tools files appear both via migration-input recursion and their
    // own root -> deduped)
    assert.strictEqual(res.entries.length, 5, 'expected 5 unique entries, got ' + res.entries.length);
    assert.ok(res.combinedHash && /^[a-f0-9]{64}$/.test(res.combinedHash), 'combinedHash should be a sha256 hex string');
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: computeProtectedHashes is deterministic', function(t, done) {
  var root = makeFixture();
  try {
    var a = protectedPaths.computeProtectedHashes({ root: root });
    var b = protectedPaths.computeProtectedHashes({ root: root });
    assert.strictEqual(a.combinedHash, b.combinedHash);
    assert.deepStrictEqual(a.entries, b.entries);
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: diffProtectedHashes detects a changed file by path', function(t, done) {
  var root = makeFixture();
  try {
    var before = protectedPaths.computeProtectedHashes({ root: root }).entries;
    fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'a.txt'), 'MUTATED', 'utf8');
    var after = protectedPaths.computeProtectedHashes({ root: root }).entries;
    var diff = protectedPaths.diffProtectedHashes(before, after);
    assert.ok(diff.changed.indexOf('evaluation-demo/migration-input/a.txt') !== -1,
      'changed should name a.txt, got ' + diff.changed.join(','));
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: diffProtectedHashes reports added files', function(t, done) {
  var root = makeFixture();
  try {
    var before = protectedPaths.computeProtectedHashes({ root: root }).entries;
    fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'new.txt'), 'n', 'utf8');
    var after = protectedPaths.computeProtectedHashes({ root: root }).entries;
    var diff = protectedPaths.diffProtectedHashes(before, after);
    assert.ok(diff.changed.indexOf('evaluation-demo/migration-input/new.txt') !== -1);
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: loadPinnedHashes returns exists=false when missing', function(t, done) {
  var root = makeFixture();
  try {
    var r = protectedPaths.loadPinnedHashes(path.join(root, 'manifest', 'protected-hashes.json'));
    assert.strictEqual(r.exists, false);
    assert.strictEqual(r.pinned, null);
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: writePinnedHashes + loadPinnedHashes roundtrip', function(t, done) {
  var root = makeFixture();
  try {
    var entries = protectedPaths.computeProtectedHashes({ root: root }).entries;
    var target = path.join(root, 'manifest', 'protected-hashes.json');
    protectedPaths.writePinnedHashes(entries, target);
    var loaded = protectedPaths.loadPinnedHashes(target);
    assert.strictEqual(loaded.exists, true);
    assert.strictEqual(loaded.valid, true);
    assert.strictEqual(loaded.pinned.entries.length, entries.length);
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: loadPinnedHashes reports invalid for empty content', function(t, done) {
  var root = makeFixture();
  try {
    var target = path.join(root, 'manifest', 'protected-hashes.json');
    fs.writeFileSync(target, '', 'utf8');
    var loaded = protectedPaths.loadPinnedHashes(target);
    assert.strictEqual(loaded.exists, true);
    assert.strictEqual(loaded.valid, false);
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: verifyAgainstPinned passes when unchanged, fails when tampered', function(t, done) {
  var root = makeFixture();
  try {
    var entries = protectedPaths.computeProtectedHashes({ root: root }).entries;
    var ok = protectedPaths.verifyAgainstPinned(entries, { entries: entries });
    assert.strictEqual(ok.changed.length, 0, 'matched pinned should be clean');

    var tampered = entries.map(function(e) { return { path: e.path, hash: e.hash }; });
    for (var i = 0; i < tampered.length; i++) {
      if (tampered[i].path.indexOf('a.txt') !== -1) {
        tampered[i].hash = 'deadbeef'.repeat(8);
      }
    }
    var bad = protectedPaths.verifyAgainstPinned(tampered, { entries: entries });
    assert.ok(bad.changed.length > 0, 'tampered pinned should report changed paths');
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: hashFile gives one hash for the same text in LF and CRLF', function(t, done) {
  var root = makeFixture();
  try {
    var lfPath = path.join(root, 'lf.txt');
    var crlfPath = path.join(root, 'crlf.txt');
    fs.writeFileSync(lfPath, 'alpha\nbeta\ngamma\n', 'utf8');
    fs.writeFileSync(crlfPath, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8');
    var lfHash = protectedPaths.hashFile(lfPath, crypto);
    var crlfHash = protectedPaths.hashFile(crlfPath, crypto);
    assert.ok(lfHash && crlfHash, 'both hashes should be computed');
    assert.strictEqual(lfHash, crlfHash, 'LF and CRLF text must hash identically');
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: hashFile hashes a binary file with CRLF bytes raw', function(t, done) {
  var root = makeFixture();
  try {
    var binPath = path.join(root, 'bin.dat');
    var raw = Buffer.from([0x61, 0x00, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]);
    fs.writeFileSync(binPath, raw);
    var binHash = protectedPaths.hashFile(binPath, crypto);
    var expectedRaw = crypto.createHash('sha256').update(raw).digest('hex');
    assert.strictEqual(binHash, expectedRaw, 'binary (NUL-containing) file must be hashed raw');

    var normalized = raw.toString('utf8').replace(/\r\n/g, '\n');
    var normalizedHash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
    assert.notStrictEqual(binHash, normalizedHash, 'binary CRLF bytes must not be normalized');
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: hashFile changes the hash for a real content change', function(t, done) {
  var root = makeFixture();
  try {
    var p = path.join(root, 'change.txt');
    fs.writeFileSync(p, 'original content', 'utf8');
    var before = protectedPaths.hashFile(p, crypto);
    fs.writeFileSync(p, 'original content!', 'utf8');
    var after = protectedPaths.hashFile(p, crypto);
    assert.ok(before && after, 'both hashes should be computed');
    assert.notStrictEqual(before, after, 'a real content change must change the hash');
    done();
  } finally {
    cleanup(root);
  }
});

test('protectedPaths: combined hash is stable across a run with mixed line endings', function(t, done) {
  var root = makeFixture();
  try {
    fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'lf.txt'), 'alpha\nbeta\n', 'utf8');
    fs.writeFileSync(path.join(root, 'evaluation-demo', 'migration-input', 'crlf.txt'), 'alpha\r\nbeta\r\n', 'utf8');
    var a = protectedPaths.computeProtectedHashes({ root: root });
    var b = protectedPaths.computeProtectedHashes({ root: root });
    assert.ok(a.combinedHash && /^[a-f0-9]{64}$/.test(a.combinedHash), 'combinedHash is a sha256 hex string');
    assert.strictEqual(a.combinedHash, b.combinedHash, 'combined hash must be stable across a run');
    done();
  } finally {
    cleanup(root);
  }
});
