'use strict';

/**
 * Freeze the synthetic-staging fixture set as manifest/fixtures.v1.json and
 * pin its sha256 in manifest/fixtures.v1.sha256.
 *
 * Dry-run by default: prints the hash and the target path without writing.
 * Run with --apply to write both files. Values whose origin is set to
 * VERIFIED come from the manifest/legacy sources; everything else is marked
 * synthetic-staging. The nail-size mapping is read from the legacy
 * nail-size-data.ts source rather than duplicated by hand.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var REPO_ROOT = path.resolve(__dirname, '..');
var FIXTURES_FILE = path.join(REPO_ROOT, 'manifest', 'fixtures.v1.json');
var SHA_FILE = path.join(REPO_ROOT, 'manifest', 'fixtures.v1.sha256');
var NAIL_SIZE_DATA = path.join(REPO_ROOT, 'evaluation-demo/migration-input/legacy/vendure-store/src/plugins/nail-customization/nail-size-data.ts');

var COUNTRIES = ['DE', 'AT', 'HU', 'GB'];

function sha256Hex(value) {
  // Normalize CRLF to LF so the freeze hash is insensitive to line-ending style.
  return crypto.createHash('sha256').update(String(value).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Read the expected nail-size mapping from nail-size-data.ts. Returns the
 * four shapes with their 15 index/number/arcLength/chordLength rows.
 */
function loadNailSizes() {
  var source = fs.readFileSync(NAIL_SIZE_DATA, 'utf8');
  var shapes = [];
  var shapeRe = /code:\s*'([^']+)'[\s\S]*?sizes:\s*\[([\s\S]*?)\]\s*,?\s*\},/g;
  var rowRe = /\{\s*index:\s*(\d+),\s*number:\s*'([^']*)',\s*arcLength:\s*([0-9.]+)(?:,\s*chordLength:\s*([0-9.]+))?\s*\}/g;
  var match;
  while ((match = shapeRe.exec(source)) !== null) {
    var code = match[1];
    var rowsBlock = match[2];
    var sizes = [];
    var row;
    while ((row = rowRe.exec(rowsBlock)) !== null) {
      sizes.push({
        index: Number(row[1]),
        number: row[2],
        arcLength: Number(row[3]),
        chordLength: row[4] !== undefined ? Number(row[4]) : undefined
      });
    }
    if (sizes.length > 0) {
      shapes.push({ code: code, sizes: sizes });
    }
  }
  if (shapes.length === 0) {
    throw new Error('freeze-fixtures: could not parse nail-size-data.ts');
  }
  return shapes;
}

function buildFixture() {
  return {
    schemaVersion: '1.0',
    kind: 'synthetic-staging-fixtures',
    origin: 'synthetic-staging',
    metadata: {
      title: 'Frozen synthetic-staging fixture set for Readiness runs',
      note: 'Values marked origin synthetic-staging are simulated for readiness runs; VERIFIED values come from the manifest/legacy sources.'
    },
    exchangeRates: {
      origin: 'VERIFIED',
      base: 'EUR',
      rates: {
        EUR: 1,
        HUF: 395,
        GBP: 0.86
      }
    },
    taxRates: {
      origin: 'VERIFIED',
      category: 'Standard Tax',
      rates: {
        DE: 19,
        AT: 20,
        HU: 27,
        GB: 20
      }
    },
    carriers: {
      origin: 'synthetic-staging',
      weightBands: [0, 3, 7],
      productWeights: { base: 0.25, perNail: 0.01 },
      byCountry: COUNTRIES.reduce(function(acc, cc) {
        acc[cc] = {
          name: 'carrier-' + cc.toLowerCase(),
          bands: [
            { from: 0, to: 3, price: 3.49 },
            { from: 3, to: 7, price: 4.99 },
            { from: 7, to: null, price: 6.99 }
          ]
        };
        return acc;
      }, {})
    },
    craftFees: {
      origin: 'VERIFIED',
      designFee: { currency: 'EUR', amount: 10 },
      craftFeePct: 0.05
    },
    commissionTiers: {
      byCountry: {
        DE: { origin: 'VERIFIED', currency: 'EUR', bands: [{ from: 0, to: 3, platformSharePct: 0 }, { from: 3, to: 7, platformSharePct: 20 }, { from: 7, to: 20, platformSharePct: 60 }] },
        HU: { origin: 'VERIFIED', currency: 'HUF', bands: [{ from: 0, to: 100000, platformSharePct: 0 }, { from: 100000, to: 250000, platformSharePct: 20 }, { from: 250000, to: null, platformSharePct: 60 }] },
        AT: { origin: 'synthetic-staging', currency: 'EUR', bands: [{ from: 0, to: 3, platformSharePct: 0 }, { from: 3, to: 7, platformSharePct: 20 }, { from: 7, to: 20, platformSharePct: 60 }] },
        GB: { origin: 'synthetic-staging', currency: 'GBP', bands: [{ from: 0, to: 3, platformSharePct: 0 }, { from: 3, to: 7, platformSharePct: 20 }, { from: 7, to: 20, platformSharePct: 60 }] }
      }
    },
    lowStockThreshold: {
      origin: 'synthetic-staging',
      units: 5
    },
    virtualStock: {
      origin: 'synthetic-staging',
      byCountry: COUNTRIES.reduce(function(acc, cc) {
        acc[cc] = 100;
        return acc;
      }, {})
    },
    testAccounts: {
      origin: 'VERIFIED',
      names: ['buyer.one@example.com', 'buyer.two@example.com', 'designer.de@example.com']
    },
    nailSizeMapping: {
      origin: 'VERIFIED',
      source: 'evaluation-demo/migration-input/legacy/vendure-store/src/plugins/nail-customization/nail-size-data.ts',
      shapes: loadNailSizes()
    }
  };
}

function serialize(fixture) {
  return JSON.stringify(fixture, null, 2) + '\n';
}

function main() {
  var apply = process.argv.indexOf('--apply') !== -1;
  var fixture = buildFixture();
  var content = serialize(fixture);
  var hash = sha256Hex(content);

  if (!apply) {
    console.log('DRY RUN: would write ' + 'manifest/fixtures.v1.json');
    console.log('target sha256: ' + hash);
    return;
  }

  fs.writeFileSync(FIXTURES_FILE, content, 'utf8');
  fs.writeFileSync(SHA_FILE, hash + '\n', 'utf8');
  console.log('Wrote manifest/fixtures.v1.json');
  console.log('Wrote manifest/fixtures.v1.sha256');
  console.log('sha256: ' + hash);
}

if (require.main === module) {
  main();
}

module.exports = {
  COUNTRIES: COUNTRIES.slice(),
  loadNailSizes: loadNailSizes,
  buildFixture: buildFixture,
  serialize: serialize,
  sha256Hex: sha256Hex,
  FIXTURES_FILE: FIXTURES_FILE,
  SHA_FILE: SHA_FILE
};
