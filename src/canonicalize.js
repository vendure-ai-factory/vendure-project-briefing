'use strict';

var crypto = require('crypto');

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize).sort();
  var keys = Object.keys(obj).sort();
  var result = {};
  keys.forEach(function(k) { result[k] = canonicalize(obj[k]); });
  return result;
}

function computeHash(obj, algorithm) {
  algorithm = algorithm || 'sha256';
  var canonicalJson = JSON.stringify(canonicalize(obj));
  return crypto.createHash(algorithm).update(canonicalJson).digest('hex');
}

module.exports = {
  canonicalize: canonicalize,
  computeHash: computeHash
};
