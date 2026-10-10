'use strict';

var childProcess = require('child_process');
var path = require('path');
var crypto = require('crypto');

var repoRoot = null;

function setRepoRoot(root) {
  repoRoot = root ? path.resolve(root) : null;
}

function execGit(args, options) {
  options = options || {};
  var cwd = options.cwd || repoRoot || process.cwd();
  var timeout = options.timeout || 30000;

  if (!repoRoot) {
    return { success: false, error: 'Repo root not set', errorCode: 'REPO_ROOT_NOT_SET' };
  }

  try {
    var result = childProcess.execFileSync('git', args, {
      cwd: cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeout,
      maxBuffer: 10 * 1024 * 1024
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

function createCheckpoint(label) {
  if (!repoRoot) {
    return { success: false, error: 'Repo root not set', errorCode: 'REPO_ROOT_NOT_SET' };
  }

  var hash = crypto.randomBytes(8).toString('hex');
  var revisionId = 'rev-' + hash.substring(0, 12);

  var addResult = execGit(['add', '-A', '.'], { cwd: repoRoot });
  if (!addResult.success) {
    return { success: false, error: 'git add failed: ' + addResult.error, errorCode: 'GIT_ADD_FAILED' };
  }

  var commitResult = execGit(['commit', '-m', '[checkpoint] ' + label], { cwd: repoRoot });
  if (!commitResult.success) {
    if (commitResult.exitCode === 1 && (commitResult.stdout + commitResult.stderr).indexOf('nothing to commit') !== -1) {
      var headResult = execGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
      if (!headResult.success) {
        return { success: false, error: 'git rev-parse failed', errorCode: 'GIT_REV_PARSE_FAILED' };
      }
      var commitHash = headResult.stdout.trim();
      return {
        success: true,
        commitHash: commitHash,
        revisionId: revisionId,
        label: label,
        note: 'No changes to commit (clean tree)'
      };
    }
    return { success: false, error: 'git commit failed: ' + commitResult.stderr, errorCode: 'GIT_COMMIT_FAILED', stderr: commitResult.stderr };
  }

  var commitHash = (commitResult.stdout.match(/\[.*\s+([a-f0-9]+)\]/) || ['', ''])[1];
  if (!commitHash) {
    var headResult = execGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
    if (headResult.success) {
      commitHash = headResult.stdout.trim();
    } else {
      return { success: false, error: 'Could not determine commit hash', errorCode: 'GIT_HASH_FAILED' };
    }
  }

  return {
    success: true,
    commitHash: commitHash,
    revisionId: revisionId,
    label: label
  };
}

function diffSince(hash, options) {
  options = options || {};
  var targetDir = options.path || null;

  if (!repoRoot) {
    return { success: false, error: 'Repo root not set', errorCode: 'REPO_ROOT_NOT_SET' };
  }

  var args = ['diff', hash + '..HEAD', '--'];
  if (targetDir) {
    args.push(targetDir);
  }

  var result = execGit(args, { cwd: repoRoot });

  if (!result.success) {
    if (result.exitCode === 128 && result.stderr.indexOf('unknown commit') !== -1) {
      return { success: false, error: 'Commit not found: ' + hash, errorCode: 'COMMIT_NOT_FOUND' };
    }
    return { success: false, error: 'git diff failed: ' + result.error, errorCode: 'GIT_DIFF_FAILED' };
  }

  var hasChanges = (result.stdout && result.stdout.trim().length > 0) ? true : false;

  return {
    success: true,
    diff: result.stdout || '',
    hasChanges: hasChanges,
    since: hash
  };
}

function resetTo(hash, options) {
  options = options || {};
  var logger = options.logger || null;

  if (!repoRoot) {
    return { success: false, error: 'Repo root not set', errorCode: 'REPO_ROOT_NOT_SET' };
  }

  var statusBefore = execGit(['status', '--porcelain'], { cwd: repoRoot });
  var wasDirty = statusBefore.success && statusBefore.stdout.trim().length > 0;

  var checkoutResult = execGit(['checkout', hash, '--', '.'], { cwd: repoRoot });
  if (!checkoutResult.success) {
    if (checkoutResult.exitCode === 128 && checkoutResult.stderr.indexOf('unknown commit') !== -1) {
      return { success: false, error: 'Commit not found: ' + hash, errorCode: 'COMMIT_NOT_FOUND' };
    }
    return { success: false, error: 'git checkout failed: ' + checkoutResult.stderr, errorCode: 'GIT_CHECKOUT_FAILED' };
  }

  var statusAfter = execGit(['status', '--porcelain'], { cwd: repoRoot });
  var isClean = statusAfter.success && statusAfter.stdout.trim().length === 0;

  if (logger && logger.info) {
    logger.info('RESET_COMPLETED', 'Reset to checkpoint completed', {
      hash: hash,
      wasDirty: wasDirty,
      isClean: isClean
    });
  }

  return {
    success: true,
    resetTo: hash,
    wasDirty: wasDirty,
    isClean: isClean
  };
}

module.exports = {
  setRepoRoot: setRepoRoot,
  createCheckpoint: createCheckpoint,
  diffSince: diffSince,
  resetTo: resetTo,
  execGit: execGit
};
