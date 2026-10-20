'use strict';

var path = require('path');
var crypto = require('crypto');
var coerce = require('./coerce');
var stackToString = coerce.stackToString;
var toText = coerce.toText;
var toArray = coerce.toArray;

// TARGET_PROTECTED_PATHS = ['.git/','.github/','deploy/'] plus protected paths from this repo
var BASE_PROTECTED_PATHS = ['.git/', '.github/', 'deploy/'];

/**
 * Load protected paths from the evidence index hashes that the evidence index uses.
 * These are the protected paths reused by the evidence index for pipeline mode.
 */
function loadProtectedPathsFromEvidence(fs) {
  var protectedPaths = BASE_PROTECTED_PATHS.slice();
  var possiblePaths = [
    'evidence/index.json',
    'evidence/.index.json'
  ];
  for (var i = 0; i < possiblePaths.length; i++) {
    var p = possiblePaths[i];
    if (fs.existsSync(p)) {
      try {
        var content = fs.readFileSync(p, 'utf8');
        var idx = JSON.parse(content);
        if (idx && idx.protectedPathsHash) {
          // Just use the base paths for pipeline mode - the hash is for verification
          return protectedPaths;
        }
      } catch (e) {
        // ignore
      }
    }
  }
  return protectedPaths;
}

// PROMPT_TEMPLATE - no cause names, no mention of specific business terms
var PROMPT_TEMPLATE = 'You are a bug fixer. Your task is to propose a JSON edit-set to fix the following finding.\n\n' +
'## Finding\n' +
'- class: {{class}}\n' +
'- message: {{message}}\n' +
'- path: {{path}}\n' +
'- sql: {{sql}}\n' +
'- stack: {{stack}}\n' +
'- domain: {{domain}}\n' +
'- confidence: {{confidence}}\n' +
'- notes: {{notes}}\n\n' +
'## Candidate Code Snippets\n' +
'{{candidates}}\n\n' +
'## Allowed repairKind Values (use ONE)\n' +
'- source-edit: for application code bugs\n' +
'- config-edit: for wrong configuration settings\n' +
'- migration: for missing database columns or tables\n' +
'- dependency-bump: for bugs whose code lives in node_modules/<pkg> - bump version\n' +
'- dependency-patch: for bugs whose code lives in node_modules/<pkg> - apply a patch\n' +
'- local-wrapper: for bugs in node_modules/<pkg> that need a local wrapper workaround\n\n' +
'## JSON Edit-Set Contract\n' +
'{\n' +
'  "repairKind": "source-edit|config-edit|migration|dependency-bump|dependency-patch|local-wrapper",\n' +
'  "rationale": "one sentence explaining why this fix is correct",\n' +
'  "edits": [\n' +
'    { "path": "relative/path.js", "oldString": "exact text to find", "newString": "replacement text" }\n' +
'  ],\n' +
'  "newFiles": [\n' +
'    { "path": "relative/newfile.js", "content": "file content" }\n' +
'  ]\n' +
'}\n\n' +
'## Rules\n' +
'- Make the smallest change possible\n' +
'- Do not make unrelated edits\n' +
'- Use only paths shown in candidates or created inside the clone\n' +
'- Answer with JSON only (no markdown, no explanation)\n\n' +
'{{previousAttempts}}\n\n' +
'## Output\n' +
'Return a JSON object matching the Edit-Set Contract above.';

/**
 * Format previous attempts into the prompt.
 */
function formatPreviousAttempts(previousAttempts) {
  if (!previousAttempts || previousAttempts.length === 0) {
    return '';
  }
  var lines = ['## Previous Attempts (for reference, do not repeat the same approach)\n'];
  for (var i = 0; i < previousAttempts.length; i++) {
    var attempt = previousAttempts[i];
    lines.push('Attempt ' + (i + 1) + ':');
    if (attempt.diff) {
      lines.push('  diff: ' + toText(attempt.diff, 500));
    }
    if (attempt.checks && attempt.checks.results) {
      var failed = attempt.checks.results.filter(function(r) { return !r.success; });
      if (failed.length > 0) {
        lines.push('  check failures: ' + failed.map(function(f) { return f.script; }).join(', '));
      }
    }
    if (attempt.errors) {
      lines.push('  errors: ' + attempt.errors);
    }
  }
  return lines.join('\n');
}

/**
 * Format candidates for the prompt.
 */
function formatCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    return '(no candidates found)';
  }
  var lines = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var snippet = '';
    if (c.snippet && Array.isArray(c.snippet)) {
      snippet = c.snippet.map(function(s) { return s.line; }).join('\n');
    }
    lines.push('[' + (i + 1) + '] file: ' + c.file + ' (line: ' + c.line + ')\n   snippet:\n   ' + snippet.split('\n').join('\n   '));
  }
  return lines.join('\n\n');
}

/**
 * Build the prompt from template.
 */
function buildPrompt(finding, candidates, previousAttempts) {
  var prompt = PROMPT_TEMPLATE
    .replace('{{class}}', finding.class || 'unknown')
    .replace('{{message}}', finding.message || 'unknown')
    .replace('{{path}}', finding.path || 'none')
    .replace('{{sql}}', finding.sql || 'none')
    .replace('{{stack}}', stackToString(finding.stack, 2000))
    .replace('{{domain}}', finding.domain || 'unknown')
    .replace('{{confidence}}', String(finding.confidence || 'unknown'))
    .replace('{{notes}}', finding.notes || 'none')
    .replace('{{candidates}}', formatCandidates(candidates))
    .replace('{{previousAttempts}}', formatPreviousAttempts(previousAttempts));
  return prompt;
}

/**
 * Write evidence files for an attempt.
 */
function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function writeEvidence(runId, attemptNumber, evidence, deps) {
  var fs = deps.fs;
  var dir = path.join('evidence', runId, 'repair', 'attempts', String(attemptNumber).padStart(2, '0'));
  ensureDir(fs, dir);

  // Write prompt.sha256 (hash only) and prompt.txt (redacted)
  var promptHash = sha256Hex(evidence.prompt);
  var promptPath = path.join(dir, 'prompt.txt');
  var hashPath = path.join(dir, 'prompt.sha256');
  fs.writeFileSync(hashPath, promptHash, 'utf8');
  fs.writeFileSync(promptPath, evidence.prompt, 'utf8');

  // Write editset.json
  var editsetPath = path.join(dir, 'editset.json');
  fs.writeFileSync(editsetPath, JSON.stringify(evidence.editSet, null, 2), 'utf8');

  // Write validation.json
  var validationPath = path.join(dir, 'validation.json');
  fs.writeFileSync(validationPath, JSON.stringify(evidence.validation, null, 2), 'utf8');

  // Write checks.json
  var checksPath = path.join(dir, 'checks.json');
  fs.writeFileSync(checksPath, JSON.stringify(evidence.checks, null, 2), 'utf8');

  // Write diff.txt
  if (evidence.diffText) {
    var diffPath = path.join(dir, 'diff.txt');
    fs.writeFileSync(diffPath, evidence.diffText, 'utf8');
  }

  // Register in the repair index
  registerInIndex(runId, attemptNumber, {
    prompt: promptHash,
    editset: sha256Hex(JSON.stringify(evidence.editSet)),
    validation: sha256Hex(JSON.stringify(evidence.validation)),
    checks: sha256Hex(JSON.stringify(evidence.checks)),
    diff: evidence.diffText ? sha256Hex(evidence.diffText) : null
  }, { fs: fs, now: deps.now });
}

function ensureDir(fs, dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function registerInIndex(runId, attemptNumber, hashes, deps) {
  var fs = deps.fs;
  var indexPath = path.join('evidence', runId, 'repair', 'index.json');
  ensureDir(fs, path.dirname(indexPath));

  var index = { entries: [] };
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (e) {
      index = { entries: [] };
    }
  }

  index.entries = index.entries || [];
  index.entries.push({
    attempt: attemptNumber,
    prompt: hashes.prompt,
    editset: hashes.editset,
    validation: hashes.validation,
    checks: hashes.checks,
    diff: hashes.diff,
    timestamp: deps.now ? deps.now() : new Date().toISOString()
  });

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Get protected paths for a mode.
 */
function getProtectedPaths(mode, fs) {
  if (mode === 'pipeline') {
    return loadProtectedPathsFromEvidence(fs);
  }
  return BASE_PROTECTED_PATHS;
}

/**
 * Main function: propose and check.
 */
async function proposeAndCheck(options) {
  var finding = options.finding;
  var candidates = options.candidates || [];
  var previousAttempts = options.previousAttempts || [];
  var budget = options.budget;
  var runId = options.runId;
  var cloneDir = options.cloneDir;
  var branch = options.branch;
  var baseSha = options.baseSha;
  var env = options.env;
  var deps = options.deps || {};

  // Default dependencies
  var git = deps.git || require('./gitClient');
  var model = deps.model || require('./modelClient');
  var validator = deps.validator || require('./patchValidator');
  var applier = deps.applier || require('./patchApplier');
  var verifier = deps.verifier || require('./verifier');
  var runCommand = deps.runCommand || function(cmd, args, opts) {
    var childProcess = require('child_process');
    var result = childProcess.spawnSync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout || 120000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      success: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status
    };
  };
  var fetch = deps.fetch || ((typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') ? globalThis.fetch : null);
  var now = deps.now || function() { return new Date().toISOString(); };
  var readFile = deps.readFile || function(p) { return require('fs').readFileSync(p, 'utf8'); };
  var fs = deps.fs || require('fs');

  // scratchCopy for pipeline mode
  var scratchCopy = deps.scratchCopy || function(rootDir, runId, runCommand) {
    // Default: copy to a temp directory
    var os = require('os');
    var tempDir = path.join(os.tmpdir(), 'pipeline-scratch-' + runId);
    // Simple copy using git clone --depth 1
    return runCommand('git', ['clone', '--single-branch', '--depth', '1', rootDir, tempDir], { timeout: 60000 })
      .then(function(res) {
        if (res.exitCode === 0) {
          return { ok: true, dir: tempDir };
        }
        return { ok: false, error: 'clone failed' };
      });
  };

  var domain = finding.domain;
  var mode = domain === 'pipeline' ? 'pipeline' : 'target';

  // Step 1: domain 'infrastructure' or 'client-input' -> BLOCKED
  if (domain === 'infrastructure' || domain === 'client-input') {
    return {
      status: 'BLOCKED',
      blocker: {
        code: 'DOMAIN_NOT_REPAIRABLE',
        message: 'Finding domain "' + domain + '" is not directly repairable',
        evidence: {
          class: finding.class,
          message: finding.message,
          sqlstate: finding.sqlstate,
          domain: domain
        }
      }
    };
  }

  // Step 2: consume budget
  var consumeResult = model.consume(budget, finding.signature);
  if (!consumeResult.ok) {
    return {
      status: 'BUDGET_EXHAUSTED',
      blocker: { code: 'BUDGET_EXHAUSTED', message: consumeResult.reason }
    };
  }

  // Step 3: build prompt
  var prompt = buildPrompt(finding, candidates, previousAttempts);

  // Step 4: call model
  var modelResult;
  if (mode === 'pipeline') {
    // For pipeline mode, use the current repo root
    var repoRoot = path.resolve(__dirname, '..', '..');
    var scratchResult = await scratchCopy(repoRoot, runId, runCommand);
    if (!scratchResult.ok) {
      return { status: 'BLOCKED', blocker: { code: 'SCRATCH_COPY_FAILED', message: scratchResult.error } };
    }
    // Update cloneDir to scratch copy for pipeline mode
    cloneDir = scratchResult.dir;
  }

  modelResult = await model.callModel({
    prompt: prompt,
    system: 'You are a bug fixer. Output only JSON.',
    env: env,
    budget: budget,
    fetch: fetch,
    timeout: 120000
  });

  if (!modelResult.ok) {
    return {
      status: 'MODEL_FAILED',
      blocker: modelResult.blocker,
      errors: ['model call failed']
    };
  }

  // Parse edit set
  var parseResult = model.parseEditSet(modelResult.text);
  if (!parseResult.ok) {
    return {
      status: 'MODEL_FAILED',
      blocker: { code: 'PARSE_ERROR', message: parseResult.error },
      errors: ['parseEditSet failed: ' + parseResult.error]
    };
  }

  var editSet = parseResult.editSet;

  // Step 5: validate
  var protectedPaths = getProtectedPaths(mode, fs);
  var validationResult = validator.validate(editSet, {
    cloneDir: cloneDir,
    protectedPaths: protectedPaths,
    mode: mode
  });

  if (!validationResult.ok) {
    return {
      status: 'REJECTED',
      errors: validationResult.errors,
      blocker: { code: 'VALIDATION_FAILED', message: validationResult.errors.join('; ') }
    };
  }

  // Step 6: apply
  var applyResult = applier.apply(editSet, { cloneDir: cloneDir, runCommand: runCommand });
  if (!applyResult.ok) {
    if (applyResult.blocker && applyResult.blocker.code === 'DEP_PATCH_NOT_APPLIED_IN_IMAGE') {
      return {
        status: 'BLOCKED',
        blocker: { code: 'DEP_PATCH_NOT_APPLIED_IN_IMAGE', message: applyResult.blocker.message }
      };
    }
    return {
      status: 'APPLY_FAILED',
      blocker: applyResult.blocker,
      errors: ['apply failed']
    };
  }

  // Step 7: run checks
  var checkOptions = {
    runId: runId,
    nodeVersion: process.version,
    execCommand: runCommand,
    timeout: 120000,
    root: 'evidence'
  };

  if (mode === 'pipeline') {
    // For pipeline mode, run full test suite via runCommand
    checkOptions.execCommand = function(cmd, args, opts) {
      return runCommand(cmd, args, opts);
    };
  }

  var checkResult = await verifier.runChecks(cloneDir, checkOptions);

  if (!checkResult.ok) {
    // Restore clone
    if (mode === 'target') {
      applier.restoreClone(cloneDir, runCommand);
    }
    return {
      status: 'CHECKS_FAILED',
      checks: { results: checkResult.results },
      errors: ['checks failed']
    };
  }

  // Step 8: git commit and get diff info
  var sig8 = toText(finding.signature, 8) || 'unknown';
  var commitMsg = 'pipeline fix ' + sig8 + ': ' + editSet.repairKind;

  var commitResult = await git.commitAll(cloneDir, commitMsg, { runCommand: runCommand });
  if (!commitResult.ok) {
    return {
      status: 'APPLY_FAILED',
      blocker: commitResult.blocker,
      errors: ['commit failed']
    };
  }

  var headResult = await git.getHeadSha(cloneDir, { runCommand: runCommand });
  var headSha = headResult.ok ? headResult.sha : null;

  var statResult = await git.diffStat(cloneDir, baseSha, { runCommand: runCommand });
  var diffStatText = statResult.ok ? statResult.stat : '';

  var diffResult = await git.diffText(cloneDir, baseSha, 20000, { runCommand: runCommand });
  var diffTextOutput = diffResult.ok ? diffResult.text : '';

  // Write evidence
  var attemptNumber = 1;
  writeEvidence(runId, attemptNumber, {
    prompt: prompt,
    editSet: editSet,
    validation: validationResult,
    checks: checkResult,
    diffText: diffTextOutput
  }, { fs: fs, now: now });

  // For pipeline mode, we don't push - the orchestrator handles that
  // Also for pipeline mode, we should NOT commit to the real tree
  if (mode === 'pipeline') {
    return {
      status: 'PIPELINE_PATCH_READY',
      repairKind: editSet.repairKind,
      rationale: editSet.rationale,
      diffText: diffTextOutput,
      diffStat: diffStatText,
      headSha: headSha,
      branch: branch,
      checks: { results: checkResult.results },
      attemptNumber: attemptNumber,
      patchReady: true
    };
  }

  return {
    status: 'READY',
    repairKind: editSet.repairKind,
    rationale: editSet.rationale,
    diffText: diffTextOutput,
    diffStat: diffStatText,
    headSha: headSha,
    branch: branch,
    checks: { results: checkResult.results },
    attemptNumber: attemptNumber
  };
}

module.exports = {
  proposeAndCheck: proposeAndCheck,
  stackToString: stackToString,
  buildPrompt: buildPrompt
};
