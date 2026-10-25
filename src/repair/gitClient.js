'use strict';

var FIX_BRANCH_RE = /^codex\/pipeline-fix-[A-Za-z0-9._-]+$/;
var REPO_PREFIX = 'https://github.com/vendure-ai-factory/';
var DEFAULT_TIMEOUT_MS = 60000;
var REDACTED_MARKER = '[REDACTED]';

var FORBIDDEN_REF_NAMES = {
  'main': true,
  'master': true,
  'codex/staging-vendure-3.7.3': true
};

var COMMIT_AUTHOR_NAME = 'Pipeline';
var COMMIT_AUTHOR_EMAIL = 'pipeline@users.noreply.github.com';

/**
 * Build the git credential env block. The token is only ever placed inside a
 * value that git itself passes as an HTTP header; it never appears in argv,
 * the repository URL or any string we log directly.
 */
function gitAuthEnv(token) {
  var trailing = Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + trailing
  };
}

function commitAuthorEnv() {
  return {
    GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL
  };
}

function isAllowedRepoUrl(repoUrl) {
  if (typeof repoUrl !== 'string') return false;
  var parsed;
  try {
    parsed = new URL(repoUrl);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== 'github.com') return false;
  var pathParts = parsed.pathname.split('/').filter(function(p) { return p.length > 0; });
  if (pathParts.length < 2) return false;
  if (pathParts[0] !== 'vendure-ai-factory') return false;
  return true;
}

function isFixBranch(name) {
  return typeof name === 'string' && FIX_BRANCH_RE.test(name);
}

function blockerFor(code, message, evidence) {
  return {
    ok: false,
    blocker: {
      code: code,
      message: message,
      evidence: evidence || {}
    }
  };
}

/**
 * Classify a git auth failure as CLIENT_INPUT_SCOPE so the pipeline
 * surfaces it as a token problem (pending client input) rather than a
 * generic clone failure.
 */
function classifyGitAuthError(stderr, error) {
  var combined = (stderr || '') + '|' + (error || '');
  var lower = combined.toLowerCase();
  if (lower.indexOf('could not read username') !== -1) {
    return {
      code: 'REPO_TOKEN_MISSING',
      message: 'Git auth failed: could not read username for remote (token missing or URL malformed)',
      cls: 'CLIENT_INPUT_SCOPE'
    };
  }
  if (lower.indexOf('authentication failed') !== -1) {
    return {
      code: 'REPO_TOKEN_INVALID_OR_EXPIRED',
      message: 'Git auth failed: authentication rejected (token is invalid or expired)',
      cls: 'CLIENT_INPUT_SCOPE'
    };
  }
  return null;
}

function redactOutput(text, secrets) {
  var out = text || '';
  if (secrets && Array.isArray(secrets)) {
    for (var i = 0; i < secrets.length; i++) {
      var val = secrets[i];
      if (val && typeof val === 'string' && out.indexOf(val) !== -1) {
        out = out.split(val).join(REDACTED_MARKER);
      }
    }
  }
  return out;
}

function redactEmails(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED_MARKER);
}

function redactBearer(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/(Bearer[:\s]+)[A-Za-z0-9_.-]{10,}/g, '$1' + REDACTED_MARKER);
}

function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/(?:secret[_-]?token[_-]?)[A-Za-z0-9_.-]{3,}/g, '[REDACTED]');
}

function redactAll(text, secrets) {
  var out = redactOutput(text, secrets || []);
  out = redactEmails(out);
  out = redactBearer(out);
  out = redactSecrets(out);
  return out;
}

function normalizeExecResult(res) {
  res = res || {};
  return {
    success: res.success === true,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: typeof res.exitCode === 'number' ? res.exitCode : (res.success === true ? 0 : 1),
    error: res.error || null,
    timedOut: res.timedOut === true
  };
}

/**
 * Clone a target repository on the fix branch. Credentials go only through the
 * git config env block described in gitAuthEnv; they never travel in argv, the
 * URL or stdout/stderr.
 */
function cloneTarget(opts) {
  opts = opts || {};
  var repoUrl = opts.repoUrl;
  var branch = opts.branch;
  var dir = opts.dir;
  var token = opts.token;
  var runCommand = opts.runCommand;

  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  if (!isAllowedRepoUrl(repoUrl)) {
    return Promise.resolve(blockerFor('UNSAFE_REPOSITORY_URL', 'Only https://github.com/vendure-ai-factory/* repositories may be cloned', { repoUrl: repoUrl }));
  }
  if (!isFixBranch(branch)) {
    return Promise.resolve(blockerFor('UNSAFE_BRANCH_NAME', 'Branch name must match codex/pipeline-fix-<runId>-<sig8>', { branch: branch }));
  }
  if (typeof dir !== 'string' || dir.length === 0) {
    return Promise.resolve(blockerFor('MISSING_CLONE_DIR', 'A clone directory is required', {}));
  }
  if (typeof token !== 'string' || token.length === 0) {
    return Promise.resolve(blockerFor('MISSING_TOKEN', 'A token is required to clone', {}));
  }

  var authEnv = gitAuthEnv(token);
  var authorEnv = commitAuthorEnv();
  var env = {
    GIT_CONFIG_COUNT: authEnv.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: authEnv.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: authEnv.GIT_CONFIG_VALUE_0,
    GIT_AUTHOR_NAME: authorEnv.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: authorEnv.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: authorEnv.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: authorEnv.GIT_COMMITTER_EMAIL
  };

  return runCommand('git', ['clone', '--single-branch', '--branch', branch, '--depth', '1', repoUrl, dir], {
    cwd: opts.cwd,
    env: env,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    var stderr = redactOutput(redactOutput(r.stderr, [token]), [repoUrl]);
    var stdout = redactOutput(r.stdout, [token, repoUrl]);
    if (!r.success) {
      return blockerFor('CLONE_FAILED', 'git clone failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: stderr
      });
    }
    return { ok: true, dir: dir, branch: branch };
  });
}

/**
 * Create the fix branch in an existing checkout. The branch name must match
 * the fix-branch contract exactly (codex/pipeline-fix-<runId>-<sig8>).
 */
function createBranch(dir, name, opts) {
  opts = opts || {};
  var runCommand = opts.runCommand;
  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  if (!isFixBranch(name)) {
    return Promise.resolve(blockerFor('UNSAFE_BRANCH_NAME', 'Branch name must match codex/pipeline-fix-<runId>-<sig8>', { branch: name }));
  }
  return runCommand('git', ['checkout', '-b', name], {
    cwd: dir,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    if (!r.success) {
      return blockerFor('BRANCH_FAILED', 'git checkout -b failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: redactOutput(r.stderr, [])
      });
    }
    return { ok: true, dir: dir, branch: name };
  });
}

/**
 * Stage every change and commit with the fixed pipeline author identity.
 */
function commitAll(dir, message, opts) {
  opts = opts || {};
  var runCommand = opts.runCommand;
  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    return Promise.resolve(blockerFor('MISSING_COMMIT_MESSAGE', 'A commit message is required', {}));
  }
  var env = commitAuthorEnv();
  return runCommand('git', ['add', '-A'], {
    cwd: dir,
    env: env,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(addRes) {
    var addResult = normalizeExecResult(addRes);
    if (!addResult.success) {
      return blockerFor('COMMIT_FAILED', 'git add -A failed: ' + (addResult.error || ('exit code ' + addResult.exitCode)), {
        exitCode: addResult.exitCode,
        stderr: redactOutput(addResult.stderr, [])
      });
    }
    return runCommand('git', ['commit', '-m', message], {
      cwd: dir,
      env: env,
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS
    });
  }).then(function(commitRes) {
    var r = normalizeExecResult(commitRes);
    if (!r.success) {
      return blockerFor('COMMIT_FAILED', 'git commit failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: redactOutput(r.stderr, [])
      });
    }
    return { ok: true, dir: dir };
  });
}

/**
 * Resolve the current HEAD sha of the checkout.
 */
function getHeadSha(dir, opts) {
  opts = opts || {};
  var runCommand = opts.runCommand;
  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  return runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    if (!r.success) {
      return blockerFor('HEAD_SHA_FAILED', 'git rev-parse HEAD failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: redactOutput(r.stderr, [])
      });
    }
    var sha = r.stdout.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
      return blockerFor('HEAD_SHA_INVALID', 'git rev-parse HEAD returned an unexpected value', { sha: redactOutput(sha, []) });
    }
    return { ok: true, sha: sha };
  });
}

/**
 * Reject a ref for pushing. Only fix-branch refs are accepted; base/trunk refs,
 * anything containing ':' or '+' (force/refspec) and any force flag are refused.
 */
function validatePushRef(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'empty ref' };
  }
  if (!isFixBranch(name)) {
    return { ok: false, reason: 'ref does not match the fix-branch contract' };
  }
  if (FORBIDDEN_REF_NAMES[name]) {
    return { ok: false, reason: 'ref is a protected base branch' };
  }
  if (name.indexOf(':') !== -1) {
    return { ok: false, reason: 'refspec separator (:) is not allowed' };
  }
  if (name.indexOf('+') !== -1) {
    return { ok: false, reason: 'forced refspec (+) is not allowed' };
  }
  if (name.indexOf('--force') !== -1 || name.indexOf(' -f') !== -1) {
    return { ok: false, reason: 'force push is not allowed' };
  }
  return { ok: true };
}

/**
 * Push the current branch to origin. Never force pushes and never pushes a
 * base/trunk ref.
 */
function push(dir, branch, token, opts) {
  opts = opts || {};
  var runCommand = opts.runCommand;
  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  if (typeof token !== 'string' || token.length === 0) {
    return Promise.resolve(blockerFor('MISSING_TOKEN', 'A token is required to push', {}));
  }
  var refCheck = validatePushRef(branch);
  if (!refCheck.ok) {
    return Promise.resolve(blockerFor('UNSAFE_PUSH_REF', 'push refused: ' + refCheck.reason, { branch: branch }));
  }
  var authEnv = gitAuthEnv(token);
  var authorEnv = commitAuthorEnv();
  var env = {
    GIT_CONFIG_COUNT: authEnv.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: authEnv.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: authEnv.GIT_CONFIG_VALUE_0,
    GIT_AUTHOR_NAME: authorEnv.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: authorEnv.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: authorEnv.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: authorEnv.GIT_COMMITTER_EMAIL
  };
  return runCommand('git', ['push', 'origin', '--', branch], {
    cwd: dir,
    env: env,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    var stderr = redactAll(r.stderr, [token, branch]);
    if (!r.success) {
      return blockerFor('PUSH_FAILED', 'git push failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: stderr
      });
    }
    return { ok: true, branch: branch };
  });
}

/**
 * Diff stat against a base sha, output redacted.
 */
function diffStat(dir, baseSha, opts) {
  opts = opts || {};
  var runCommand = opts.runCommand;
  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  return runCommand('git', ['diff', '--stat', baseSha], {
    cwd: dir,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    if (!r.success) {
      return blockerFor('DIFF_FAILED', 'git diff --stat failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: redactOutput(r.stderr, [])
      });
    }
    var stat = redactOutput(r.stdout.trim(), []);
    return { ok: true, stat: stat };
  });
}

/**
 * Full diff text against a base sha, redacted and bounded in bytes.
 */
function diffText(dir, baseSha, maxBytes, opts) {
  opts = opts || {};
  var runCommand = opts.runCommand;
  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  var limit = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : (1024 * 1024);
  return runCommand('git', ['diff', baseSha], {
    cwd: dir,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    if (!r.success) {
      var redactedStderr = redactAll(r.stderr, []);
      var msg = 'git diff failed: ' + redactedStderr;
      return blockerFor('DIFF_FAILED', msg, {
        exitCode: r.exitCode,
        stderr: redactedStderr
      });
    }
    var raw = redactOutput(r.stdout, []);
    var truncated = false;
    var text = raw;
    if (text.length > limit) {
      text = text.substring(0, limit);
      truncated = true;
    }
    return { ok: true, text: text, truncated: truncated };
  });
}

/**
 * Clone a target repository using the default branch (no --branch), then
 * create the fix branch locally with `git checkout -b`.  The clone step
 * carries no fix-branch ref so it never 128s on a missing branch; the
 * subsequent checkout -b raises a new local branch that is pushed via the
 * existing push() path (which already enforces the fix-branch contract).
 *
 * Credentials go only through the git config env block; they never travel in
 * argv, the URL or stdout/stderr.
 */
function cloneRepoForRepair(opts) {
  opts = opts || {};
  var repoUrl = opts.repoUrl;
  var branch = opts.branch;  // the fix branch name to create after clone
  var dir = opts.dir;
  var token = opts.token;
  var runCommand = opts.runCommand;

  if (typeof runCommand !== 'function') {
    return Promise.resolve(blockerFor('IO_NOT_INJECTED', 'runCommand executor was not injected', {}));
  }
  if (!isAllowedRepoUrl(repoUrl)) {
    return Promise.resolve(blockerFor('UNSAFE_REPOSITORY_URL', 'Only https://github.com/vendure-ai-factory/* repositories may be cloned', { repoUrl: repoUrl }));
  }
  if (!isFixBranch(branch)) {
    return Promise.resolve(blockerFor('UNSAFE_BRANCH_NAME', 'Branch name must match codex/pipeline-fix-<runId>-<sig8>', { branch: branch }));
  }
  if (typeof dir !== 'string' || dir.length === 0) {
    return Promise.resolve(blockerFor('MISSING_CLONE_DIR', 'A clone directory is required', {}));
  }
  if (typeof token !== 'string' || token.length === 0) {
    return Promise.resolve(blockerFor('MISSING_TOKEN', 'A token is required to clone', {}));
  }

  var authEnv = gitAuthEnv(token);
  var authorEnv = commitAuthorEnv();
  var env = {
    GIT_CONFIG_COUNT: authEnv.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: authEnv.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: authEnv.GIT_CONFIG_VALUE_0,
    GIT_AUTHOR_NAME: authorEnv.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: authorEnv.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: authorEnv.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: authorEnv.GIT_COMMITTER_EMAIL
  };

  // Step 1: clone the default branch (no --branch flag)
  return runCommand('git', ['clone', '--single-branch', '--depth', '1', repoUrl, dir], {
    cwd: opts.cwd,
    env: env,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS
  }).then(function(res) {
    var r = normalizeExecResult(res);
    var stderr = redactOutput(redactOutput(r.stderr, [token]), [repoUrl]);
    if (!r.success) {
      var authErr = classifyGitAuthError(r.stderr, r.error);
      if (authErr) {
        return blockerFor(authErr.code, authErr.message, {
          exitCode: r.exitCode,
          stderr: stderr,
          classification: authErr.cls
        });
      }
      return blockerFor('CLONE_FAILED', 'git clone failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: stderr
      });
    }
    // Step 2: create the fix branch locally (only on successful clone)
    return runCommand('git', ['checkout', '-b', branch], {
      cwd: dir,
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS
    });
  }).then(function(res) {
    // If clone step returned a blocker (early exit), propagate it unchanged
    if (res && res.ok === false && res.blocker) {
      return res;
    }
    var r = normalizeExecResult(res);
    if (!r.success) {
      return blockerFor('BRANCH_FAILED', 'git checkout -b failed: ' + (r.error || ('exit code ' + r.exitCode)), {
        exitCode: r.exitCode,
        stderr: redactOutput(r.stderr, [])
      });
    }
    return { ok: true, dir: dir, branch: branch };
  });
}

module.exports = {
  cloneTarget: cloneTarget,
  cloneRepoForRepair: cloneRepoForRepair,
  createBranch: createBranch,
  commitAll: commitAll,
  getHeadSha: getHeadSha,
  push: push,
  diffStat: diffStat,
  diffText: diffText,
  gitAuthEnv: gitAuthEnv,
  validatePushRef: validatePushRef,
  FIX_BRANCH_RE: FIX_BRANCH_RE
};
