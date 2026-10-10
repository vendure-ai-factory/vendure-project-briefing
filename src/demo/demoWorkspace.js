'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');
var patchModule = require('../tools/patch');

var ALLOWED_ENV_VARS = ['PATH', 'HOME', 'NODE_ENV'];

function getRunsRoot() {
  var repoRoot = path.resolve(__dirname, '..', '..');
  var runsRoot = path.resolve(repoRoot, 'runs');
  return runsRoot;
}

function copyDir(src, dest, options) {
  options = options || {};
  var excludes = options.excludes || [];

  if (!fs.existsSync(src)) {
    return { success: false, error: 'Source does not exist: ' + src };
  }

  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (err) {
    return { success: false, error: 'Failed to create destination dir: ' + err.message };
  }

  var entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (err) {
    return { success: false, error: 'Failed to read source dir: ' + err.message };
  }

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var srcPath = path.join(src, entry.name);
    var destPath = path.join(dest, entry.name);

    if (excludes.indexOf(entry.name) !== -1) {
      continue;
    }

    if (entry.isDirectory()) {
      var subResult = copyDir(srcPath, destPath, { excludes: excludes });
      if (!subResult.success) {
        return subResult;
      }
    } else {
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      } catch (err) {
        return { success: false, error: 'Failed to copy file: ' + err.message };
      }
    }
  }

  return { success: true };
}

function execGit(repoDir, args, options) {
  options = options || {};
  var timeout = options.timeout || 30000;

  try {
    var result = childProcess.execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeout,
      maxBuffer: 50 * 1024 * 1024,
      env: buildAllowedEnv()
    });
    return {
      success: true,
      stdout: result || '',
      stderr: '',
      exitCode: 0
    };
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
      error: err.message
    };
  }
}

function buildAllowedEnv() {
  var env = {};
  for (var i = 0; i < ALLOWED_ENV_VARS.length; i++) {
    var key = ALLOWED_ENV_VARS[i];
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function createWorkspace(runId) {
  var runsRoot = getRunsRoot();
  var workspaceRoot = path.resolve(runsRoot, runId || 'default', 'workspace');

  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (err) {
    return {
      success: false,
      error: 'Failed to create workspace root: ' + err.message,
      errorCode: 'DIR_CREATE_ERROR'
    };
  }

  var repoRoot = path.resolve(__dirname, '..', '..');
  var demoSrc = path.resolve(repoRoot, 'evaluation-demo');
  var demoDest = path.join(workspaceRoot, 'evaluation-demo');

  var copyResult = copyDir(demoSrc, demoDest, {
    excludes: ['migration-input', 'assets', 'results', 'expected-results']
  });

  if (!copyResult.success) {
    return {
      success: false,
      error: 'Failed to copy evaluation-demo: ' + copyResult.error,
      errorCode: 'COPY_ERROR'
    };
  }

  var gitignoreContent = 'evaluation-demo/results/\n';
  var gitignorePath = path.join(workspaceRoot, '.gitignore');
  try {
    fs.writeFileSync(gitignorePath, gitignoreContent, 'utf8');
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write .gitignore: ' + err.message,
      errorCode: 'FILE_WRITE_ERROR'
    };
  }

  var gitattributesContent = '* text=auto eol=lf\n';
  var gitattributesPath = path.join(workspaceRoot, '.gitattributes');
  try {
    fs.writeFileSync(gitattributesPath, gitattributesContent, 'utf8');
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write .gitattributes: ' + err.message,
      errorCode: 'FILE_WRITE_ERROR'
    };
  }

  var gitInitResult = execGit(workspaceRoot, ['init']);
  if (!gitInitResult.success) {
    return {
      success: false,
      error: 'git init failed: ' + gitInitResult.stderr,
      errorCode: 'GIT_INIT_FAILED'
    };
  }

  execGit(workspaceRoot, ['config', 'user.email', 'pipeline@test.local']);
  execGit(workspaceRoot, ['config', 'user.name', 'Pipeline Test']);

  var addResult = execGit(workspaceRoot, ['add', '-A']);
  if (!addResult.success) {
    return {
      success: false,
      error: 'git add failed: ' + addResult.stderr,
      errorCode: 'GIT_ADD_FAILED'
    };
  }

  var commitResult = execGit(workspaceRoot, ['commit', '-m', 'baseline']);
  var baselineHash = null;

  if (commitResult.success) {
    var match = commitResult.stdout.match(/\[.*\s+([a-f0-9]+)\]/);
    baselineHash = match ? match[1] : null;
  }

  if (!baselineHash) {
    var hashResult = execGit(workspaceRoot, ['rev-parse', 'HEAD']);
    baselineHash = hashResult.success ? hashResult.stdout.trim() : null;
  }

  if (!baselineHash) {
    return {
      success: false,
      error: 'Could not determine baseline commit hash',
      errorCode: 'HASH_ERROR'
    };
  }

  patchModule.setupDemoWorkspaceProtection(workspaceRoot);

  return {
    success: true,
    workspaceRoot: workspaceRoot,
    baselineHash: baselineHash,
    runId: runId || null
  };
}

function resetWorkspace(hash, runId) {
  var runsRoot = getRunsRoot();
  var workspaceRoot = path.resolve(runsRoot, runId || 'default', 'workspace');

  var statusResult = execGit(workspaceRoot, ['status', '--porcelain'], { timeout: 10000 });
  var wasDirty = statusResult.success && statusResult.stdout.trim().length > 0;

  var resetResult = execGit(workspaceRoot, ['reset', '--hard', hash]);
  if (!resetResult.success) {
    return {
      success: false,
      error: 'git reset --hard failed: ' + resetResult.stderr,
      errorCode: 'GIT_RESET_FAILED'
    };
  }

  var cleanResult = execGit(workspaceRoot, ['clean', '-fd']);
  if (!cleanResult.success) {
    return {
      success: false,
      error: 'git clean failed: ' + cleanResult.stderr,
      errorCode: 'GIT_CLEAN_FAILED'
    };
  }

  return {
    success: true,
    resetTo: hash,
    wasDirty: wasDirty,
    isClean: true
  };
}

function enforceAllowlist(workspaceRoot, baselineHash) {
  var statusResult = execGit(workspaceRoot, ['status', '--porcelain'], { timeout: 10000 });
  if (!statusResult.success) {
    return { success: false, error: 'git status failed: ' + statusResult.stderr, errorCode: 'GIT_STATUS_FAILED' };
  }

  var diffResult = execGit(workspaceRoot, ['diff', '--name-only', 'HEAD'], { timeout: 10000 });
  if (!diffResult.success) {
    return { success: false, error: 'git diff failed: ' + diffResult.stderr, errorCode: 'GIT_DIFF_FAILED' };
  }

  var trackedChanges = (diffResult.stdout || '').split('\n').filter(function(f) { return f.trim(); });
  var untracked = (statusResult.stdout || '').split('\n').filter(function(line) {
    return line.trim() && line.charAt(0) === '?' && line.substring(2).trim();
  }).map(function(line) { return line.substring(2).trim(); });

  var allowedFile = 'evaluation-demo/app/src/catalog.mjs';
  var allChanges = trackedChanges.concat(untracked);
  var violations = allChanges.filter(function(f) { return f !== allowedFile; });

  if (violations.length > 0) {
    execGit(workspaceRoot, ['reset', '--hard', baselineHash], { timeout: 10000 });
    execGit(workspaceRoot, ['clean', '-fd'], { timeout: 10000 });
    return {
      success: false,
      error: 'Changed files not in allowlist: ' + violations.join(', '),
      errorCode: 'ALLOWLIST_VIOLATION',
      violations: violations,
      resetTo: baselineHash,
      isClean: true
    };
  }

  return { success: true, changedFiles: allChanges };
}

function getBaselineHash(runId) {
  var runsRoot = getRunsRoot();
  var workspaceRoot = path.resolve(runsRoot, runId || 'default', 'workspace');
  var hashResult = execGit(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
  if (!hashResult.success) {
    return null;
  }
  return hashResult.stdout.trim();
}

module.exports = {
  createWorkspace: createWorkspace,
  resetWorkspace: resetWorkspace,
  enforceAllowlist: enforceAllowlist,
  getBaselineHash: getBaselineHash,
  buildAllowedEnv: buildAllowedEnv,
  ALLOWED_ENV_VARS: ALLOWED_ENV_VARS
};
