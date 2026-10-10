'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var freezeModule = require('../scripts/freeze-fixtures');
var fixturesModule = require('../src/fixtures');

var REPO_ROOT = path.resolve(__dirname, '..');
var FIXTURES_FILE = path.join(REPO_ROOT, 'manifest', 'fixtures.v1.json');
var SHA_FILE = path.join(REPO_ROOT, 'manifest', 'fixtures.v1.sha256');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('fixturesFreeze: generated file sha256 matches the pinned hash', function(t) {
  var content = fs.readFileSync(FIXTURES_FILE, 'utf8');
  var pinned = fs.readFileSync(SHA_FILE, 'utf8').trim();
  assert.strictEqual(sha256Hex(content), pinned, 'json content hashes to the pinned sha256');
  assert.strictEqual(freezeModule.sha256Hex(freezeModule.serialize(freezeModule.buildFixture())), pinned,
    'rebuilding the fixture must reproduce the same hash (deterministic freeze)');
});

test('fixturesFreeze: loader verifies the hash and returns the frozen data', function(t) {
  var loaded = fixturesModule.loadFixturesFile();
  assert.strictEqual(loaded.ok, true, 'loader accepts the frozen file');
  assert.ok(loaded.fixtures, 'fixtures returned');
  assert.strictEqual(loaded.fixtures.schemaVersion, '1.0');
  assert.strictEqual(loaded.sha256, fs.readFileSync(SHA_FILE, 'utf8').trim());
});

test('fixturesFreeze: tampering the fixture is detected and no data is returned', function(t) {
  var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fx-tamper-'));
  var jsonPath = path.join(tmpDir, 'fixtures.v1.json');
  var shaPath = path.join(tmpDir, 'fixtures.v1.sha256');
  fs.copyFileSync(FIXTURES_FILE, jsonPath);
  fs.copyFileSync(SHA_FILE, shaPath);

  // Tamper after the hash was pinned.
  var tampered = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  tampered.lowStockThreshold.units = 999;
  fs.writeFileSync(jsonPath, JSON.stringify(tampered, null, 2) + '\n', 'utf8');

  var loaded = fixturesModule.loadFixturesFile(jsonPath, shaPath);
  assert.strictEqual(loaded.ok, false, 'tampered file must be rejected');
  assert.ok(loaded.error.indexOf('mismatch') !== -1, 'error names the hash mismatch');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('fixturesFreeze: a missing sha256 pin is reported', function(t) {
  var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fx-nopin-'));
  var jsonPath = path.join(tmpDir, 'fixtures.v1.json');
  var shaPath = path.join(tmpDir, 'missing.sha256');
  fs.copyFileSync(FIXTURES_FILE, jsonPath);
  var loaded = fixturesModule.loadFixturesFile(jsonPath, shaPath);
  assert.strictEqual(loaded.ok, false, 'missing pin must be reported');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('fixturesFreeze: every country has every table', function(t) {
  var loaded = fixturesModule.loadFixturesFile();
  assert.strictEqual(loaded.ok, true);
  var fx = loaded.fixtures;
  var countries = freezeModule.COUNTRIES;
  assert.deepStrictEqual(Object.keys(fx.taxRates.rates).sort(), ['AT', 'DE', 'GB', 'HU']);
  countries.forEach(function(cc) {
    assert.ok(fx.taxRates.rates[cc] !== undefined, 'tax rate for ' + cc);
    assert.ok(fx.carriers.byCountry[cc], 'carrier for ' + cc);
    assert.ok(fx.carriers.byCountry[cc].bands.length >= 3, '3 weight bands for ' + cc);
    assert.ok(fx.commissionTiers.byCountry[cc], 'commission tier for ' + cc);
    assert.ok(fx.virtualStock.byCountry[cc] !== undefined, 'virtual stock for ' + cc);
  });
  assert.ok(fx.exchangeRates.rates.EUR && fx.exchangeRates.rates.HUF && fx.exchangeRates.rates.GBP,
    'exchange-rate table covers EUR, HUF, GBP');
  assert.strictEqual(fx.taxRates.rates.DE, 19);
  assert.strictEqual(fx.taxRates.rates.AT, 20);
  assert.strictEqual(fx.taxRates.rates.HU, 27);
  assert.strictEqual(fx.taxRates.rates.GB, 20);
});

test('fixturesFreeze: verified vs synthetic-staging origins are marked', function(t) {
  var fx = freezeModule.buildFixture();
  assert.strictEqual(fx.exchangeRates.origin, 'VERIFIED');
  assert.strictEqual(fx.taxRates.origin, 'VERIFIED');
  assert.strictEqual(fx.craftFees.origin, 'VERIFIED');
  assert.strictEqual(fx.testAccounts.origin, 'VERIFIED');
  assert.strictEqual(fx.nailSizeMapping.origin, 'VERIFIED');
  assert.strictEqual(fx.commissionTiers.byCountry.DE.origin, 'VERIFIED');
  assert.strictEqual(fx.commissionTiers.byCountry.HU.origin, 'VERIFIED');
  assert.strictEqual(fx.commissionTiers.byCountry.AT.origin, 'synthetic-staging');
  assert.strictEqual(fx.commissionTiers.byCountry.GB.origin, 'synthetic-staging');
  assert.strictEqual(fx.carriers.origin, 'synthetic-staging');
  assert.strictEqual(fx.lowStockThreshold.origin, 'synthetic-staging');
  assert.strictEqual(fx.virtualStock.origin, 'synthetic-staging');

  // test account names carry no secret values.
  fx.testAccounts.names.forEach(function(n) {
    assert.ok(!/:|@.*@|password|secret|token/i.test(n.replace(/@[^@]+$/, '@host')), 'no credential in name ' + n);
  });
});

test('fixturesFreeze: nail-size mapping was read from the legacy source', function(t) {
  var fx = freezeModule.buildFixture();
  assert.ok(fx.nailSizeMapping.shapes.length >= 4, 'four nail shapes');
  var stiletto = fx.nailSizeMapping.shapes[0];
  assert.strictEqual(stiletto.code, 'short-stiletto');
  assert.strictEqual(stiletto.sizes.length, 15, 'stiletto has 15 sizes');
  assert.strictEqual(stiletto.sizes[0].arcLength, 18);
  assert.ok(fx.nailSizeMapping.source.indexOf('nail-size-data.ts') !== -1, 'source is nail-size-data.ts');
});

test('fixturesFreeze: sha256Hex gives one hash for the same text in LF and CRLF', function(t) {
  var lf = 'alpha\nbeta\ngamma\n';
  var crlf = 'alpha\r\nbeta\r\ngamma\r\n';
  assert.strictEqual(freezeModule.sha256Hex(lf), freezeModule.sha256Hex(crlf),
    'LF and CRLF content must hash identically');
});

test('fixturesFreeze: pinned hash is unchanged and still matches the LF content', function(t) {
  var pinned = fs.readFileSync(SHA_FILE, 'utf8').trim();
  var lf = fs.readFileSync(FIXTURES_FILE, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(freezeModule.sha256Hex(lf), pinned,
    'the pinned hash stays valid for LF content');
});

test('fixturesFreeze: loader accepts CRLF fixture content and still verifies', function(t) {
  var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fx-crlf-'));
  var jsonPath = path.join(tmpDir, 'fixtures.v1.json');
  var shaPath = path.join(tmpDir, 'fixtures.v1.sha256');
  var lf = fs.readFileSync(FIXTURES_FILE, 'utf8').replace(/\r\n/g, '\n');
  var crlf = lf.replace(/\n/g, '\r\n');
  fs.writeFileSync(jsonPath, crlf, 'utf8');
  fs.writeFileSync(shaPath, fs.readFileSync(SHA_FILE, 'utf8').trim() + '\n', 'utf8');

  var loaded = fixturesModule.loadFixturesFile(jsonPath, shaPath);
  assert.strictEqual(loaded.ok, true, 'CRLF-on-disk fixtures must load and verify');
  assert.strictEqual(loaded.sha256, fs.readFileSync(SHA_FILE, 'utf8').trim(), 'hash matches the pinned sha256');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
