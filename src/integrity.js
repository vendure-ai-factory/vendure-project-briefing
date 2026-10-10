'use strict';

var canonicalizeModule = require('./canonicalize');

function computeExpectedValuesHash(manifest) {
  if (!manifest || !Array.isArray(manifest.tasks)) {
    return null;
  }
  var canonicalData = {
    tasks: manifest.tasks.map(function(t) {
      return {
        canonicalId: t.canonicalId,
        expectedResult: t.expectedResult,
        mandatoryAssertions: t.mandatoryAssertions
      };
    })
  };
  return canonicalizeModule.computeHash(canonicalData);
}

function verifyIntegrity(manifest) {
  if (!manifest) {
    return { ok: false, expected: null, actual: null, error: 'Manifest is null or undefined' };
  }
  if (!manifest.integrity) {
    return { ok: false, expected: null, actual: null, error: 'Manifest has no integrity section' };
  }
  if (!manifest.integrity.expectedValuesHash) {
    return { ok: false, expected: null, actual: null, error: 'Manifest integrity section has no expectedValuesHash' };
  }

  var actual = computeExpectedValuesHash(manifest);
  var expected = manifest.integrity.expectedValuesHash;

  if (actual === null) {
    return { ok: false, expected: expected, actual: null, error: 'Could not compute hash from manifest' };
  }

  return {
    ok: actual === expected,
    expected: expected,
    actual: actual
  };
}

module.exports = {
  computeExpectedValuesHash: computeExpectedValuesHash,
  verifyIntegrity: verifyIntegrity
};
