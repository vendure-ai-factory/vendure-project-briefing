'use strict';

var test = require('node:test');
var assert = require('node:assert');

var c = require('../src/canonicalize');
var canonicalize = c.canonicalize;
var computeHash = c.computeHash;

test('canonicalize: preserves primitives', function(t, done) {
  assert.strictEqual(canonicalize(42), 42);
  assert.strictEqual(canonicalize('hello'), 'hello');
  assert.strictEqual(canonicalize(null), null);
  assert.strictEqual(canonicalize(true), true);
  done();
});

test('canonicalize: sorts object keys', function(t, done) {
  var input = { z: 1, a: 2, m: 3 };
  var result = canonicalize(input);
  var keys = Object.keys(result);
  assert.deepStrictEqual(keys, ['a', 'm', 'z']);
  done();
});

test('canonicalize: sorts array of primitives', function(t, done) {
  var input = [3, 1, 4, 1, 5, 9, 2, 6];
  var result = canonicalize(input);
  assert.deepStrictEqual(result, [1, 1, 2, 3, 4, 5, 6, 9]);
  done();
});

test('canonicalize: nested objects sorted recursively', function(t, done) {
  var input = { b: { d: 1, c: 2 }, a: { f: 3, e: 4 } };
  var result = canonicalize(input);
  var keysB = Object.keys(result.b);
  var keysA = Object.keys(result.a);
  assert.deepStrictEqual(keysB, ['c', 'd']);
  assert.deepStrictEqual(keysA, ['e', 'f']);
  done();
});

test('canonicalize: array of objects sorted by JSON string', function(t, done) {
  var input = [
    { b: 1, a: 2 },
    { a: 1, b: 2 }
  ];
  var result = canonicalize(input);
  assert.strictEqual(result.length, 2);
  done();
});

test('computeHash: produces consistent hash', function(t, done) {
  var obj1 = { b: 1, a: 2 };
  var obj2 = { a: 2, b: 1 };
  var hash1 = computeHash(obj1);
  var hash2 = computeHash(obj2);
  assert.strictEqual(hash1, hash2, 'Same data should produce same hash regardless of key order');
  assert.strictEqual(typeof hash1, 'string', 'Hash should be a string');
  assert.strictEqual(hash1.length, 64, 'SHA256 hash should be 64 hex chars');
  done();
});

test('computeHash: different objects produce different hashes', function(t, done) {
  var hash1 = computeHash({ a: 1 });
  var hash2 = computeHash({ b: 1 });
  assert.notStrictEqual(hash1, hash2);
  done();
});