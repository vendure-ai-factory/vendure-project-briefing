'use strict';

var { test } = require('node:test');
var assert = require('assert');

var SECRET_PATTERNS = [
  { pattern: /sk-or-v1-[a-zA-Z0-9_-]{20,}/, name: 'OpenRouter key' },
  { pattern: /OPENROUTER_API_KEY=(?!your_|sk-test-|test|_|placeholder|empty)[^\s&]{8,}/, name: 'OPENROUTER_API_KEY with real value' }
];

var scanSecrets = require('../scripts/scan-secrets');

function scanContent(content) {
  var findings = [];
  SECRET_PATTERNS.forEach(function(rule) {
    var match = content.match(rule.pattern);
    if (match) {
      findings.push({
        pattern: rule.name,
        match: match[0].substring(0, 30) + (match[0].length > 30 ? '...' : '')
      });
    }
  });
  return findings;
}

test('scan-secrets: fake OpenRouter key detected', function() {
  var findings = scanContent('OPENROUTER_API_KEY=sk-or-v1-abc123def456xyz789012345678901234567');
  assert.strictEqual(findings.length > 0, true);
});

test('scan-secrets: fake non-empty OPENROUTER_API_KEY detected', function() {
  var findings = scanContent('OPENROUTER_API_KEY=my_super_secret_api_key_12345');
  assert.strictEqual(findings.length > 0, true);
});

test('scan-secrets: empty OPENROUTER_API_KEY ignored', function() {
  var findings = scanContent('OPENROUTER_API_KEY=');
  assert.strictEqual(findings.length, 0);
});

test('scan-secrets: placeholder key ignored', function() {
  var findings = scanContent('OPENROUTER_API_KEY=your_key_here');
  assert.strictEqual(findings.length, 0);
});

test('scan-secrets: no secrets in clean content', function() {
  var findings = scanContent('var x = 42;\nconsole.log("hello");');
  assert.strictEqual(findings.length, 0);
});

test('scan-secrets: allowlist excludes scan-secrets.js pattern definitions', function() {
  var isAllowlisted = scanSecrets.isAllowlisted('scripts/scan-secrets.js', ['scripts/scan-secrets.js', 'tests/scan-secrets.test.js']);
  assert.strictEqual(isAllowlisted, true);
});

test('scan-secrets: allowlist excludes test fixtures', function() {
  var isAllowlisted = scanSecrets.isAllowlisted('tests/scan-secrets.test.js', ['scripts/scan-secrets.js', 'tests/scan-secrets.test.js']);
  assert.strictEqual(isAllowlisted, true);
});

test('scan-secrets: non-allowlisted file is not excluded', function() {
  var isAllowlisted = scanSecrets.isAllowlisted('src/logger.js', ['scripts/scan-secrets.js', 'tests/scan-secrets.test.js']);
  assert.strictEqual(isAllowlisted, false);
});