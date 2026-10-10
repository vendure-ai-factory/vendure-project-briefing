'use strict';

var fs = require('fs');
var path = require('path');

var SECRET_PATTERNS = [
  { pattern: /sk-or-v1-[a-zA-Z0-9_-]{20,}/, name: 'OpenRouter key' },
  { pattern: /OPENROUTER_API_KEY=(?!your_|sk-test-|test|_|placeholder|empty)[^\s&]{8,}/, name: 'OPENROUTER_API_KEY with real value' }
];

var TRACKED_EXTENSIONS = ['.js', '.mjs', '.json', '.md', '.ts', '.sh', '.yml', '.yaml', '.txt', '.env'];

function getTrackedFiles() {
  var execSync = require('child_process').execSync;
  try {
    var output = execSync('git ls-files', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return output.split('\n').filter(function(file) {
      return file.trim() && TRACKED_EXTENSIONS.some(function(ext) { return file.endsWith(ext); });
    });
  } catch (e) {
    console.error('Failed to get tracked files:', e.message);
    process.exit(1);
  }
}

function getAllowlist() {
  var allowlistPath = path.join(__dirname, 'scan-secrets.allowlist.json');
  try {
    return JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function isAllowlisted(filePath, allowlist) {
  return allowlist.some(function(allowed) {
    return filePath === allowed || filePath.endsWith(allowed);
  });
}

function scanFile(filePath) {
  var content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return [];
  }

  var findings = [];
  SECRET_PATTERNS.forEach(function(rule) {
    var match = content.match(rule.pattern);
    if (match) {
      findings.push({
        file: filePath,
        pattern: rule.name,
        match: match[0].substring(0, 30) + (match[0].length > 30 ? '...' : '')
      });
    }
  });

  return findings;
}

function main() {
  var files = getTrackedFiles();
  var allowlist = getAllowlist();
  var allFindings = [];

  files.forEach(function(file) {
    if (isAllowlisted(file, allowlist)) {
      return;
    }
    var findings = scanFile(file);
    allFindings = allFindings.concat(findings);
  });

  if (allFindings.length > 0) {
    console.error('Secrets detected:');
    allFindings.forEach(function(f) {
      console.error('  ' + f.file + ': ' + f.pattern + ' (' + f.match + ')');
    });
    process.exit(1);
  }

  console.log('No secrets detected in tracked files.');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { scanFile: scanFile, SECRET_PATTERNS: SECRET_PATTERNS, isAllowlisted: isAllowlisted };