'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');

var compilerModule = require('../src/compiler/conditionExtractor');
var cardBuilderModule = require('../src/compiler/cardBuilder');

var test = require('node:test');
var assert = require('node:assert');

var B2_10_EXPECTED_RESULT = 'Only paid, not-yet-exported, same-country orders merge; different-country merge is rejected; a permitted merge recalculates weight, shipping company, shipping price, tax, total and payment difference; an exported order is no longer mergeable.';

test('compiler: B2-10 expectedResult extracts correct MUST_NOT conditions', function(t, done) {
  var card = cardBuilderModule.buildCard(B2_10_EXPECTED_RESULT, 'CAN-B2-10');

  var mustNotConditions = card.conditions.filter(function(c) { return c.polarity === 'MUST_NOT'; });
  assert.ok(mustNotConditions.length >= 2, 'Should have at least 2 MUST_NOT conditions, got ' + mustNotConditions.length);

  var hasDifferentCountryRejected = mustNotConditions.some(function(c) {
    return c.text.toLowerCase().indexOf('different-country') !== -1 &&
           c.text.toLowerCase().indexOf('rejected') !== -1;
  });
  assert.ok(hasDifferentCountryRejected, 'Should have MUST_NOT condition for "different-country merge is rejected"');

  var hasExportedOrderNotMergeable = mustNotConditions.some(function(c) {
    return c.text.toLowerCase().indexOf('exported order') !== -1 &&
           c.text.toLowerCase().indexOf('no longer') !== -1;
  });
  assert.ok(hasExportedOrderNotMergeable, 'Should have MUST_NOT condition for "exported order is no longer mergeable"');

  done();
});

test('compiler: input text and sha256 are in card and match', function(t, done) {
  var card = cardBuilderModule.buildCard(B2_10_EXPECTED_RESULT, 'CAN-B2-10');

  assert.strictEqual(card.goalText, B2_10_EXPECTED_RESULT, 'goalText should match input');

  var expectedHash = compilerModule.sha256(B2_10_EXPECTED_RESULT);
  assert.strictEqual(card.goalSha256, expectedHash, 'goalSha256 should match computed hash of input');

  done();
});

test('compiler: vague sentence with no rule match produces NEEDS_REVIEW', function(t, done) {
  var vagueText = 'The system shall allow users to view their profile information.';
  var card = cardBuilderModule.buildCard(vagueText, 'TEST-01');

  assert.strictEqual(card.conditions.length, 0, 'No conditions should be extracted from vague text');
  assert.ok(card.unmatched.length > 0, 'Should have unmatched sentences');
  assert.strictEqual(card.status, 'NEEDS_REVIEW', 'Status should be NEEDS_REVIEW for vague text');
  done();
});

test('compiler: same input twice produces byte-identical card (determinism)', function(t, done) {
  var text = 'All orders must be completed before export.';
  var card1 = cardBuilderModule.buildCard(text, 'TEST-01');
  var card2 = cardBuilderModule.buildCard(text, 'TEST-01');

  var json1 = JSON.stringify(card1);
  var json2 = JSON.stringify(card2);
  assert.strictEqual(json1, json2, 'Same input should produce byte-identical card');
  done();
});

test('compiler: empty input produces no conditions', function(t, done) {
  var card = cardBuilderModule.buildCard('', 'TEST-01');
  assert.strictEqual(card.conditions.length, 0, 'No conditions for empty input');
  assert.strictEqual(card.status, 'NEEDS_REVIEW', 'Empty input should produce NEEDS_REVIEW');
  done();
});

test('compiler: conditionExtractor exports sha256', function(t, done) {
  var hash = compilerModule.sha256('test input');
  assert.ok(hash, 'sha256 should return a hash string');
  assert.strictEqual(hash.length, 64, 'sha256 should be 64 character hex string');
  done();
});

test('compiler: must conditions detected correctly', function(t, done) {
  var text = 'The system must validate all inputs.';
  var result = compilerModule.extractConditions(text);

  assert.ok(result.conditions.length > 0, 'Should detect condition');
  assert.strictEqual(result.conditions[0].polarity, 'MUST', 'Polarity should be MUST');
  done();
});

test('compiler: must_not conditions detected for is not', function(t, done) {
  var text = 'The system is not required to store logs.';
  var result = compilerModule.extractConditions(text);

  assert.ok(result.conditions.length > 0, 'Should detect condition');
  assert.strictEqual(result.conditions[0].polarity, 'MUST_NOT', 'Polarity should be MUST_NOT');
  done();
});

test('compiler: never keyword triggers MUST_NOT', function(t, done) {
  var text = 'The system shall never expose internal error details.';
  var result = compilerModule.extractConditions(text);

  assert.ok(result.conditions.length > 0, 'Should detect condition');
  assert.strictEqual(result.conditions[0].polarity, 'MUST_NOT', 'Polarity should be MUST_NOT');
  done();
});

test('compiler: is rejected triggers MUST_NOT', function(t, done) {
  var text = 'Invalid requests are rejected.';
  var result = compilerModule.extractConditions(text);

  assert.ok(result.conditions.length > 0, 'Should detect condition');
  assert.strictEqual(result.conditions[0].polarity, 'MUST_NOT', 'Polarity should be MUST_NOT');
  done();
});

test('compiler: no longer triggers MUST_NOT', function(t, done) {
  var text = 'Expired sessions are no longer valid.';
  var result = compilerModule.extractConditions(text);

  assert.ok(result.conditions.length > 0, 'Should detect condition');
  assert.strictEqual(result.conditions[0].polarity, 'MUST_NOT', 'Polarity should be MUST_NOT');
  done();
});

test('compiler: A or B sentence stays as ONE condition', function(t, done) {
  var text = 'The system must validate inputs A or B.';
  var result = compilerModule.extractConditions(text);

  var mustConditions = result.conditions.filter(function(c) { return c.polarity === 'MUST'; });
  assert.ok(mustConditions.length === 1, 'A or B should be ONE condition');
  assert.ok(mustConditions[0].text.indexOf('or') !== -1, 'Condition text should contain or');
  done();
});

test('compiler: sentence not matching any rule goes to unmatched', function(t, done) {
  var text = 'The application starts successfully.';
  var result = compilerModule.extractConditions(text);

  assert.strictEqual(result.conditions.length, 0, 'No conditions should be detected');
  assert.ok(result.unmatched.length > 0, 'Should have unmatched sentences');
  done();
});

test('compiler: bullet lines under Verify are extracted', function(t, done) {
  var text = 'Verify that the system authenticates users.';
  var result = compilerModule.extractConditions(text);

  assert.ok(result.conditions.length > 0, 'Should detect condition from Verify line');
  assert.strictEqual(result.conditions[0].polarity, 'MUST', 'Verify line should have MUST polarity');
  done();
});

test('compiler: card stores taskId correctly', function(t, done) {
  var card = cardBuilderModule.buildCard('Test text', 'CAN-B2-10');
  assert.strictEqual(card.taskId, 'CAN-B2-10', 'taskId should be stored in card');
  done();
});

test('compiler: card with no conditions is NEEDS_REVIEW', function(t, done) {
  var card = cardBuilderModule.buildCard('Just some text with no rules.', 'TEST-01');
  assert.strictEqual(card.status, 'NEEDS_REVIEW', 'Card with no conditions should be NEEDS_REVIEW');
  done();
});

test('compiler: card with conditions but no unmatched is VALID', function(t, done) {
  var card = cardBuilderModule.buildCard('The system must validate all inputs.', 'TEST-01');
  assert.strictEqual(card.status, 'VALID', 'Card with conditions and no unmatched should be VALID');
  done();
});

test('compiler: card with empty condition text is NEEDS_REVIEW', function(t, done) {
  var card = cardBuilderModule.buildCard('', 'TEST-01');
  assert.strictEqual(card.status, 'NEEDS_REVIEW', 'Card with empty condition should be NEEDS_REVIEW');
  done();
});
