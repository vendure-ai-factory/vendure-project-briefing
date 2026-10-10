'use strict';

var fs = require('fs');
var path = require('path');
var execSync = require('child_process').execSync;

var ROOT = path.resolve(__dirname, '..');
var MANIFEST_PATH = path.join(ROOT, 'manifest', 'acceptance-manifest.v0.4.json');

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return null;
  }
}

function main() {
  console.log('=== manifest/acceptance-manifest.v0.4.json — Repository Verification ===\n');

  // 1. Load manifest
  var manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    console.error('FAILED: Cannot read manifest: ' + e.message);
    process.exit(1);
  }
  console.log('Loaded manifest version: ' + manifest.manifestVersion);

  // 2. Source block
  var src = manifest.source || {};
  console.log('Document path: ' + (src.documentPath || 'n/a'));
  console.log('SHA256:        ' + (src.sha256 || 'n/a'));
  console.log('Pinned repo commit: ' + (src.pinnedRepoCommit || 'n/a'));
  console.log('');

  // 3. Git ancestor check
  var pinned = src.pinnedRepoCommit;
  if (pinned && pinned !== 'TO_CONFIRM') {
    var headRev = run('git rev-parse HEAD');
    headRev = (headRev || '').trim();

    var mergeBase = run('git merge-base ' + pinned + ' HEAD');
    mergeBase = (mergeBase || '').trim();

    var isAncestor = mergeBase === pinned;
    console.log('HEAD commit:       ' + headRev);
    console.log('Merge-base:        ' + mergeBase);
    console.log('Pinned is ancestor: ' + (isAncestor ? 'YES' : 'NO'));
    if (!isAncestor) {
      console.log('WARNING: Pinned commit is NOT an ancestor of HEAD. Evidence may not be reproducible.');
    }

    // 3b. Compare git tree hash of evaluation-demo/migration-input at HEAD vs pinned
    var pinnedTree = run('git rev-parse ' + pinned + ':evaluation-demo/migration-input');
    pinnedTree = (pinnedTree || '').trim();
    var headTree = run('git rev-parse HEAD:evaluation-demo/migration-input');
    headTree = (headTree || '').trim();

    console.log('Tree hash at pinned: ' + pinnedTree);
    console.log('Tree hash at HEAD:   ' + headTree);
    console.log('Migration-input tree: ' + (pinnedTree === headTree ? 'MATCH' : 'DIFFER'));
  } else {
    console.log('Pinned commit: TO_CONFIRM — ancestor check skipped');
  }
  console.log('');

  // 4. Script path checks
  if (!manifest.scripts || manifest.scripts.length === 0) {
    console.log('No scripts[] in manifest — skipping file checks');
  } else {
    console.log('Script path existence (present / adapter):');
    console.log('');
    console.log('  ' + padRight('Script', 28) + padRight('Kind', 12) + padRight('Path', 62) + 'Exists?');
    console.log('  ' + '-'.repeat(28) + '  ' + '-'.repeat(12) + '  ' + '-'.repeat(62) + '-------');

    var presentAdapterCount = 0;
    var existsCount = 0;

    manifest.scripts.forEach(function(script) {
      var kind = script.kind || 'n/a';
      var isCheckable = (kind === 'present' || kind === 'adapter');

      // Check main path
      var scriptPath = script.path || '';
      var exists = false;

      if (isCheckable && scriptPath && scriptPath.indexOf('TO_CONFIRM') === -1) {
        var fullPath = path.join(ROOT, scriptPath);
        exists = fs.existsSync(fullPath);
        presentAdapterCount++;
        if (exists) existsCount++;
      }

      // Also check wrapperPath if present
      if (script.wrapperPath && script.wrapperPath.indexOf('TO_CONFIRM') === -1) {
        var wrapperFull = path.join(ROOT, script.wrapperPath);
        if (!fs.existsSync(wrapperFull)) {
          exists = false;
        }
      }

      // Also check implementationPath if present
      if (script.implementationPath && script.implementationPath.indexOf('TO_CONFIRM') === -1) {
        var implFull = path.join(ROOT, script.implementationPath);
        if (!fs.existsSync(implFull)) {
          exists = false;
        }
      }

      var flag = isCheckable ? (exists ? 'YES' : 'NO') : '—';
      console.log(
        '  ' + padRight(script.id || '', 28) +
        '  ' + padRight(kind, 12) +
        '  ' + padRight(scriptPath, 62) +
        flag
      );

      // Print wrapper/implementation if present
      if (script.wrapperPath) {
        console.log('    wrapperPath: ' + script.wrapperPath + ' (' + (fs.existsSync(path.join(ROOT, script.wrapperPath)) ? 'exists' : 'missing') + ')');
      }
      if (script.implementationPath) {
        console.log('    implPath:    ' + script.implementationPath + ' (' + (fs.existsSync(path.join(ROOT, script.implementationPath)) ? 'exists' : 'missing') + ')');
      }
    });

    console.log('');
    console.log('  Checkable (present/adapter): ' + presentAdapterCount + '  |  Found: ' + existsCount + '  |  Missing: ' + (presentAdapterCount - existsCount));
  }
  console.log('');

  // 5. Task count summary
  var allTasks = manifest.tasks || [];
  var clientBatchTasks = allTasks.filter(function(t) { return t.origin === 'client-batch'; });
  var demoTasks = allTasks.filter(function(t) { return t.origin === 'public-demo'; });
  console.log('Task counts:');
  console.log('  client-batch: ' + clientBatchTasks.length + ' (expected 24)');
  console.log('  public-demo:  ' + demoTasks.length + ' (expected 1: CAN-DEMO-01)');
  console.log('  total:        ' + allTasks.length);

  // 6. Chain summary
  var chains = manifest.chains || [];
  if (chains.rows) {
    console.log('');
    console.log('Chains: ' + chains.rows.length + ' (expected 6: A-F)');
    chains.rows.forEach(function(c) {
      console.log('  Chain ' + c.specChainsRaw + ': ' + (c.canonicalIds || []).join(', '));
    });
    if (chains.chainG) {
      console.log('  Chain G: ' + (chains.chainG.canonicalIds || []).join(', '));
    }
  }

  // 7. TO_CONFIRM count
  console.log('');
  var toConfirmCount = countToConfirm(manifest);
  console.log('TO_CONFIRM values across manifest: ' + toConfirmCount.total);
  if (toConfirmCount.sections.length > 0) {
    console.log('');
    console.log('  Sections with TO_CONFIRM:');
    toConfirmCount.sections.forEach(function(item) {
      console.log('    ' + item.section + ': ' + item.count);
    });
  }

  console.log('');
  console.log('=== End of Verification ===');
}

function countToConfirm(obj, section, results) {
  results = results || { total: 0, sections: [] };
  section = section || 'root';

  if (obj === null || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    obj.forEach(function(item) { countToConfirm(item, section, results); });
    return results;
  }

  for (var key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    var val = obj[key];

    if (typeof val === 'string' && val.indexOf('TO_CONFIRM') !== -1) {
      results.total++;
    } else if (typeof val === 'object') {
      var subSection = (key === 'scripts' || key === 'chains' || key === 'readinessTasks' ||
                        key === 'frozenRunInputs' || key === 'retryPolicy' ||
                        key === 'loadSecurityScope' || key === 'reporting')
        ? key
        : section;
      countToConfirm(val, subSection, results);
    }
  }

  return results;
}

function padRight(str, len) {
  str = String(str);
  while (str.length < len) str += ' ';
  return str.substring(0, len);
}

main();