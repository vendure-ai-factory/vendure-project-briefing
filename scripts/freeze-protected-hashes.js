'use strict';

var path = require('path');
var protectedPathsModule = require('../src/protectedPaths');

function main() {
  var repoRoot = path.resolve(__dirname, '..');
  var targetPath = path.resolve(repoRoot, 'manifest', 'protected-hashes.json');

  var result = protectedPathsModule.computeProtectedHashes({ root: repoRoot });
  if (!result.ok) {
    console.error('Failed to compute protected hashes: ' + result.error);
    process.exit(1);
  }

  protectedPathsModule.writePinnedHashes(result.entries, targetPath);
  console.log('Protected hashes written to: ' + targetPath);
  console.log('Files hashed: ' + result.rootCount);
  console.log('Combined hash: ' + result.combinedHash);
}

if (require.main === module) {
  main();
}
