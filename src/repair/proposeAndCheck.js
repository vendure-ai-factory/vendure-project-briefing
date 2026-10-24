'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var coerce = require('./coerce');
var RESULT_PASS = require('../terminalState').RESULT_PASS;
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

// PROMPT_TEMPLATE - no cause names, no mention of specific business terms.
// Allowed repair kinds are injected per-run based on the clone's capabilities
// (e.g. dependency-patch is only offered when the runtime image can apply it).
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
'## Allowed repairKind Values (choose ONE from this list)\n' +
'{{allowedRepairKinds}}\n' +
'{{dependencyInfo}}\n' +
'{{capabilityNote}}\n' +
'## JSON Edit-Set Contract\n' +
'{\n' +
'  "repairKind": "<one of the allowed repairKind values>",\n' +
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
'- Answer with JSON only (no markdown, no explanation)\n' +
'{{allowedPathsPerKind}}\n' +
'{{previousAttempts}}\n\n' +
'## Output\n' +
'Return a JSON object matching the Edit-Set Contract above.';

function defaultAllowedRepairKinds(opts) {
  var d = opts || {};
  var allowDepPatch = d.capabilities ? d.capabilities.dependencyPatch : true;
  var lines = [
    '- source-edit: for application code bugs',
    '- config-edit: for wrong configuration settings',
    '- migration: for missing database columns or tables'
  ];
  if (d.domain === 'dependency') {
    lines.push('- dependency-bump: for bugs whose code lives in node_modules/<pkg> - upgrade to a newer version listed below');
    if (allowDepPatch) {
      lines.push('- dependency-patch: for bugs whose code lives in node_modules/<pkg> - apply a patch');
    }
    lines.push('- local-wrapper: for bugs in node_modules/<pkg> - add a NEW local module/plugin under src/ and register it in the config file that overrides, wraps or guards the faulty behaviour using REAL working code, never placeholders/TODOs/pseudo-code (e.g. an actual wrapper class/function with real logic that intercepts the bad call and substitutes the correct value). The wrapper must compile and be wired into the plugin registration (with an edit to the plugin-registration file), not merely create unused source files.');
  }
  return lines.join('\n');
}

function dependencyInfoText(depInfo) {
  if (!depInfo) return '';
  var lines = ['## Dependency Version Info'];
  lines.push('- package: ' + depInfo.package);
  lines.push('- installed version: ' + (depInfo.installedVersion || 'unknown'));
  if (depInfo.availableVersions && depInfo.availableVersions.length > 0) {
    lines.push('- available versions (newest first): ' + depInfo.availableVersions.join(', '));
  } else {
    lines.push('- no newer versions are available on the registry for this package');
  }
  if (depInfo.noNewer) {
    lines.push('- NOTE: this package has no version newer than the installed one; do NOT use dependency-bump, use local-wrapper instead.');
  }
  return lines.join('\n') + '\n';
}

function capabilityNoteText(capabilities) {
  if (!capabilities || capabilities.dependencyPatch) return '';
  return '## Capability Note\n' +
    '- Patching a dependency inside node_modules is NOT available in this runtime: ' + (capabilities.reason || 'not applicable in this image') + '\n';
}

function allowedPathsPerKindText(opts) {
  var d = opts || {};
  var allowDepPatch = !d.capabilities || d.capabilities.dependencyPatch !== false;
  var lines = ['## Allowed Paths per Kind'];
  lines.push('- source-edit: any path EXCEPT node_modules/ and protected paths');
  lines.push('- config-edit: any path EXCEPT node_modules/ and protected paths');
  lines.push('- migration: under the migrations directory only');
  lines.push('- dependency-bump: package.json and lockfile only (upgrade to a newer version)');
  if (allowDepPatch) {
    lines.push('- dependency-patch: edits under node_modules/<pkg>/ only or NEW patch files under patches/ (apply a patch to an installed package)');
  }
  lines.push('- local-wrapper: under src/ only (adds a NEW local module/plugin registered in the config that overrides, wraps or guards the faulty behaviour with REAL code, plus an edit to the plugin-registration file); Reason: --ignore-scripts prevents arbitrary scripts from running, so the wrapper must be a tracked source file');
  return lines.join('\n') + '\n';
}


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
    if (attempt.rejectionCodes && attempt.rejectionCodes.length > 0) {
      lines.push('  rejection codes: ' + attempt.rejectionCodes.join(', '));
    }
    if (attempt.validCandidatePaths && attempt.validCandidatePaths.length > 0) {
      lines.push('  valid candidate paths: ' + attempt.validCandidatePaths.join(', '));
    }
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
    // Include closest match context for OLDSTRING_NOT_FOUND rejections
    if (attempt.rejectionCodes && attempt.rejectionCodes.indexOf('OLDSTRING_NOT_FOUND') !== -1 && attempt.closestMatch) {
      var cm = attempt.closestMatch;
      lines.push('  rejected oldString: ' + (cm.rejectedOldString || '').substring(0, 200));
      lines.push('  closest match in file (line ' + cm.lineNumber + '):');
      if (cm.beforeLines && Array.isArray(cm.beforeLines)) {
        for (var bi = 0; bi < cm.beforeLines.length; bi++) {
          var bLine = cm.beforeLines[bi];
          if (bLine && typeof bLine.line === 'string') {
            lines.push('    ' + bLine.lineNumber + ': ' + bLine.line.substring(0, 250));
          }
        }
      }
      if (cm.line) {
        lines.push('    ' + cm.lineNumber + ': ' + cm.line.substring(0, 250) + ' <-- CLOSEST MATCH');
      }
      if (cm.afterLines && Array.isArray(cm.afterLines)) {
        for (var ai = 0; ai < cm.afterLines.length; ai++) {
          var aLine = cm.afterLines[ai];
          if (aLine && typeof aLine.line === 'string') {
            lines.push('    ' + aLine.lineNumber + ': ' + aLine.line.substring(0, 250));
          }
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * Format candidates for the prompt.
 * Dedupes candidates by file, prefers real code over generated/type files
 * (.d.ts, graphql-env, generated, dist, build), caps each snippet and the
 * total candidate text (<= totalCap). Keeps the highest-scoring candidate per
 * file.
 */
var PROMPT_SNIPPET_CAP = 2000;     // chars per candidate snippet
var PROMPT_CANDIDATE_TOTAL_CAP = 12000; // chars of candidate text total

function isGeneratedPath(relFile) {
  if (!relFile) return false;
  var f = String(relFile).replace(/\\/g, '/');
  if (/\.d\.ts$/.test(f)) return true;
  if (/graphql-env/.test(f)) return true;
  if (/\/gql\/.*generated/.test(f) || /generated.*\.(ts|js)$/.test(f)) return true;
  if (/\/dist\//.test(f) || f.indexOf('/dist/') !== -1) return true;
  if (/\/build\//.test(f) || f.indexOf('/build/') !== -1) return true;
  if (/\.map$/.test(f)) return true;
  return false;
}

function formatCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    return '(no candidates found)';
  }
  // Dedupe by file, keeping the highest score; prefer real code over generated.
  var byFile = {};
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!c || !c.file) continue;
    var key = String(c.file).replace(/\\/g, '/');
    var stored = byFile[key];
    if (!stored) {
      byFile[key] = c;
    } else if ((stored.score || 0) < (c.score || 0)) {
      byFile[key] = c;
    }
  }
  var unique = Object.keys(byFile).map(function(k) { return byFile[k]; });
  // Real code over type files: real (non-generated) candidates sort first.
  unique.sort(function(a, b) {
    var ag = isGeneratedPath(a.file) ? 1 : 0;
    var bg = isGeneratedPath(b.file) ? 1 : 0;
    if (ag !== bg) return ag - bg;
    return (b.score || 0) - (a.score || 0);
  });

  var lines = [];
  var totalChars = 0;
  for (var j = 0; j < unique.length && totalChars < PROMPT_CANDIDATE_TOTAL_CAP; j++) {
    var cand = unique[j];
    var snippet = '';
    if (cand.snippet && Array.isArray(cand.snippet)) {
      // Include line numbers in the snippet output: "NN: line content"
      snippet = cand.snippet.map(function(s) {
        var ln = s.lineNumber !== undefined ? s.lineNumber : 0;
        return String(ln).padStart(4, ' ') + ': ' + s.line;
      }).join('\n');
    }
    if (snippet.length > PROMPT_SNIPPET_CAP) {
      snippet = snippet.substring(0, PROMPT_SNIPPET_CAP) + '\n... (truncated)';
    }
    var block = '[' + (j + 1) + '] file: ' + cand.file + ' (line: ' + cand.line + ')\n   snippet:\n   ' + snippet.split('\n').join('\n   ');
    if (totalChars + block.length > PROMPT_CANDIDATE_TOTAL_CAP) {
      // Truncate the block to fit the total cap.
      var remaining = PROMPT_CANDIDATE_TOTAL_CAP - totalChars;
      block = block.substring(0, Math.max(0, remaining)) + '\n... (truncated)';
    }
    totalChars += block.length;
    lines.push(block);
    if (totalChars >= PROMPT_CANDIDATE_TOTAL_CAP) break;
  }
  return lines.join('\n\n');
}

/**
 * Build the prompt from template.
 */
function buildPrompt(finding, candidates, previousAttempts, opts) {
  opts = opts || {};
  var allowed = opts.allowedRepairKinds || defaultAllowedRepairKinds(opts);
  var dependencyInfo = opts.dependencyInfo ? dependencyInfoText(opts.dependencyInfo) : '';
  var capabilityNote = opts.capabilities ? capabilityNoteText(opts.capabilities) : '';
  var allowedPathsPerKind = allowedPathsPerKindText(opts);
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
    .replace('{{allowedRepairKinds}}', allowed)
    .replace('{{dependencyInfo}}', dependencyInfo)
    .replace('{{capabilityNote}}', capabilityNote)
    .replace('{{allowedPathsPerKind}}', allowedPathsPerKind)
    .replace('{{previousAttempts}}', formatPreviousAttempts(previousAttempts));
  return prompt;
}

/**
 * Write evidence files for an attempt.
 */
function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Extract stable error codes embedded as '[CODE]' at the start of error strings.
 */
function extractErrorCodes(errors) {
  var codes = [];
  for (var i = 0; i < (errors || []).length; i++) {
    var m = /^\[([A-Z_]+)\]/.exec(toText(errors[i]));
    if (m && codes.indexOf(m[1]) === -1) codes.push(m[1]);
  }
  return codes;
}

/**
 * Write the compact attempt summary (evidence/<runId>/repair/attempt-<n>.json).
 * Paths and codes only — never file contents, log lines, or secrets.
 */
var CHECK_STDERR_TAIL = 500;

/**
 * Per-check status derived from the exact fields the verifier's runChecks
 * compliance evidence (runChecks.json) records, so attempt summaries and the
 * compliance report never disagree. Precedence: SKIPPED, TIMED_OUT, ok-result, FAIL.
 */
function checkStatus(r) {
  if (!r) return 'FAIL';
  if (r.skipped) return 'SKIPPED';
  if (r.timedOut) return 'TIMED_OUT';
  if (r.success) return RESULT_PASS;
  return 'FAIL';
}

/**
 * Compact per-check summary for attempt-N.json: check name, status (identical
 * to the compliance report), exit code, and the tail of stderr (redacted by
 * the verifier already). Never full stdout/stderr contents.
 */
function summarizeChecks(checkData) {
  var results = checkData && Array.isArray(checkData.results) ? checkData.results : [];
  return results.map(function(r) {
    var stderr = typeof r.stderr === 'string' ? r.stderr : '';
    return {
      name: r.script,
      status: checkStatus(r),
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      stderrTail: stderr.length > CHECK_STDERR_TAIL ? stderr.substring(stderr.length - CHECK_STDERR_TAIL) : stderr
    };
  });
}

function writeAttemptSummary(runId, attemptNumber, data, fsMod, now) {
  try {
    var dir = path.join('evidence', runId, 'repair');
    ensureDir(fsMod, dir);
    var summary = {
      attempt: attemptNumber,
      status: data.status,
      codes: Array.isArray(data.codes) ? data.codes : [],
      requestedPaths: Array.isArray(data.requestedPaths) ? data.requestedPaths : [],
      candidatePaths: Array.isArray(data.candidatePaths) ? data.candidatePaths : [],
      tokensUsed: typeof data.tokensUsed === 'number' ? data.tokensUsed : null,
      promptChars: typeof data.promptChars === 'number' ? data.promptChars : null,
      elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : null,
      model: typeof data.model === 'string' ? data.model : null,
      requestedModel: typeof data.requestedModel === 'string' ? data.requestedModel : null,
      provider: typeof data.provider === 'string' ? data.provider : null,
      timestamp: (typeof now === 'function' ? now() : new Date().toISOString())
    };
    if (data.checks) {
      summary.checks = summarizeChecks(data.checks);
    }
    fsMod.writeFileSync(path.join(dir, 'attempt-' + attemptNumber + '.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  } catch (e) { /* best effort */ }
}

/**
 * Write evidence/<runId>/repair/capabilities.json for the dependency-patch
 * capability decision (and its reason). Written once per attempt.
 */
function writeCapabilitiesEvidence(capabilities, runId, fsMod, now) {
  try {
    var dir = path.join('evidence', runId, 'repair');
    ensureDir(fsMod, dir);
    var data = {
      dependencyPatch: capabilities ? capabilities.dependencyPatch : false,
      reason: capabilities ? capabilities.reason : null,
      timestamp: (typeof now === 'function' ? now() : new Date().toISOString())
    };
    fsMod.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) { /* best effort */ }
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
 * Normalize a candidate or proposal path to a forward-slash clone-relative form.
 * Absolute clone paths and bare relative paths both map to the same key so a
 * modeled edit path can be matched against a candidate's absolute file path.
 */
function normRelPath(p, cloneDir, isCandidate) {
  if (!p || typeof p !== 'string') return '';
  var out;
  if (path.isAbsolute(p)) {
    try {
      out = path.relative(cloneDir, p);
    } catch (e) {
      out = p;
    }
  } else {
    out = p;
  }
  out = out.replace(/\\/g, '/');
  if (out.indexOf('../') === 0) out = out.replace(/^(\.\.\/)+/, '');
  if (out === '.') out = '';
  void isCandidate;
  return out;
}

/**
 * Collect clone-relative candidate paths for the prompt/gate. The prompt and
 * the PROPOSAL_OUTSIDE_CANDIDATES validator both describe the same normalized
 * set so a modeled path like 'node_modules/pkg/dist/x.js' matches the located
 * candidate frames.
 */
function candidateRelPaths(cloneDir, candidates) {
  var set = [];
  for (var i = 0; i < (candidates || []).length; i++) {
    var c = candidates[i];
    if (!c || !c.file) continue;
    var rel = normRelPath(c.file, cloneDir, true);
    if (rel !== '' && set.indexOf(rel) === -1) set.push(rel);
  }
  return set;
}

function isUnderMigrationDir(rel, cloneDir) {
  var dir = findMigrationsDir(cloneDir);
  if (!dir) return false;
  var base = path.basename(dir);
  return rel === base || rel.indexOf(base + '/') === 0;
}

function findMigrationsDir(cloneDir) {
  var commonNames = ['migrations', 'src/migrations', 'db/migrations', 'typeorm/migrations', 'mikro-orm/migrations'];
  for (var i = 0; i < commonNames.length; i++) {
    var dir = path.join(cloneDir, commonNames[i]);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  try {
    var entries = fs.readdirSync(cloneDir, { withFileTypes: true });
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (e.isDirectory() && e.name.indexOf('migration') !== -1) {
        return path.join(cloneDir, e.name);
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Enforce that every proposed edit path is one of the listed candidate paths
 * (or an allowed new-file location: patches/ when dependency-patch is
 * available, a migrations dir, or a new local-wrapper file under src/).
 * Returns { ok, offending, validPaths }.
 */
function validateProposalPaths(editSet, candidates, cloneDir, capabilities) {
  var allowed = candidateRelPaths(cloneDir, candidates);
  var offending = [];
  var edits = (editSet && editSet.edits) || [];
  var isLocalWrapper = editSet && editSet.repairKind === 'local-wrapper';
  var dependencyPatchAvailable = !capabilities || capabilities.dependencyPatch !== false;

  // Helper to check if a path is a blocked local-wrapper path type
  function isBlockedLocalWrapperPath(relPath) {
    if (!isLocalWrapper) return false;
    var normalized = relPath.replace(/\\/g, '/');
    // Block node_modules
    if (normalized.indexOf('node_modules/') !== -1 || normalized.indexOf('node_modules\\') !== -1) return true;
    // Block lockfiles
    var baseName = normalized.split('/').pop().split('\\').pop();
    var lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
    if (lockfiles.indexOf(baseName) !== -1) return true;
    // Block workflows
    if (normalized.indexOf('.github/workflows/') !== -1 || normalized.indexOf('.github\\workflows\\') !== -1) return true;
    // Block Docker files
    var fileName = baseName;
    if (fileName === 'Dockerfile' || fileName.startsWith('Dockerfile.') ||
        fileName === 'docker-compose.yaml' || fileName === 'docker-compose.yml' ||
        normalized.indexOf('docker/') !== -1 || normalized.indexOf('docker\\') !== -1) return true;
    return false;
  }

  for (var i = 0; i < edits.length; i++) {
    var e = edits[i];
    if (!e || !e.path) continue;
    var rel = normRelPath(e.path, cloneDir, false);
    if (rel === '') continue;
    var isMigrationEdit = isUnderMigrationDir(rel, cloneDir);
    var isLocalWrapperEdit = isLocalWrapper && rel.indexOf('src/') === 0;
    var isBlocked = isBlockedLocalWrapperPath(rel);
    // Blocked paths are explicitly rejected; valid src/ paths and candidates pass
    if (isBlocked) {
      if (offending.indexOf(e.path) === -1) offending.push(e.path);
    } else if (allowed.indexOf(rel) === -1 && !isMigrationEdit && !isLocalWrapperEdit) {
      if (offending.indexOf(e.path) === -1) offending.push(e.path);
    }
  }
  var newFiles = (editSet && editSet.newFiles) || [];
  for (var j = 0; j < newFiles.length; j++) {
    var nf = newFiles[j];
    if (!nf || !nf.path) continue;
    var relNf = normRelPath(nf.path, cloneDir, false);
    if (relNf === '') continue;
    var inPatches = dependencyPatchAvailable && relNf.indexOf('patches/') === 0;
    var inMigration = isUnderMigrationDir(relNf, cloneDir);
    var localWrapperNew = isLocalWrapper && relNf.indexOf('src/') === 0;
    var isBlockedNf = isBlockedLocalWrapperPath(relNf);
    if (isBlockedNf) {
      if (offending.indexOf(nf.path) === -1) offending.push(nf.path);
    } else if (!inPatches && !inMigration && !localWrapperNew) {
      if (offending.indexOf(nf.path) === -1) offending.push(nf.path);
    }
  }
  return { ok: offending.length === 0, offending: offending, validPaths: allowed };
}

/**
 * Find Dockerfile(s) at the clone root (Dockerfile, Dockerfile.*, docker/…).
 * Returns absolute paths, empty when none exist.
 */
function findDockerfiles(cloneDir) {
  var found = [];
  try {
    var entries = fs.readdirSync(cloneDir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.isFile() && /^Dockerfile($|\.)/.test(e.name)) {
        found.push(path.join(cloneDir, e.name));
      } else if (e.isDirectory() && e.name === 'docker') {
        try {
          var sub = fs.readdirSync(path.join(cloneDir, e.name));
          for (var j = 0; j < sub.length; j++) {
            if (/^Dockerfile($|\.)/.test(sub[j])) found.push(path.join(cloneDir, e.name, sub[j]));
          }
        } catch (err) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
  return found;
}

/**
 * Detect whether dependency patches can be applied at runtime by inspecting the
 * clone's Dockerfile(s) and package.json. patch-package (or equivalent) must be
 * installed and the install that produces the runtime node_modules must not use
 * --ignore-scripts. Never modifies the Dockerfile.
 */
function detectDependencyPatchCapability(cloneDir) {
  var reason = null;
  var installsOk = true;
  var patchRuntimeDep = false;
  var patchDevDep = false;
  var omitDev = false;
  var patchViaDockerfile = false;

  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8'));
    if ((pkg.dependencies || {})['patch-package']) patchRuntimeDep = true;
    if ((pkg.devDependencies || {})['patch-package']) patchDevDep = true;
  } catch (e) { /* no package.json */ }

  var dockerfiles = findDockerfiles(cloneDir);
  for (var i = 0; i < dockerfiles.length; i++) {
    var content = '';
    try { content = fs.readFileSync(dockerfiles[i], 'utf8'); } catch (e) { continue; }
    if (/RUN\s+(npm|yarn|pnpm)\s+(ci|install)[^\n]*--ignore-scripts/i.test(content)) {
      if (!reason) reason = 'install step uses --ignore-scripts; the patch postinstall cannot run';
      installsOk = false;
    }
    if (/\b--omit=dev\b|\b--production\b/i.test(content)) omitDev = true;
    if (/patch-package/i.test(content)) patchViaDockerfile = true;
  }

  var patchInNodeModules = fs.existsSync(path.join(cloneDir, 'node_modules', 'patch-package'));
  var patchPackageReady = patchRuntimeDep || patchInNodeModules || patchViaDockerfile || (patchDevDep && !omitDev);

  if (dockerfiles.length === 0) {
    if (!reason) reason = 'no Dockerfile found in the clone';
  } else if (!patchPackageReady) {
    if (!reason) reason = 'patch-package (or equivalent) is not installed in the runtime image';
  } else if (!installsOk) {
    reason = reason || 'install does not run package postinstall scripts';
  }

  var ok = dockerfiles.length > 0 && patchPackageReady && installsOk;
  return { dependencyPatch: ok, reason: ok ? null : (reason || 'dependency-patch is not applicable in this image') };
}

/**
 * Query the npm registry for available versions of a package. Reuses the
 * injected fetch path (no shell, no network beyond the one GET) and tolerates
 * 401/404/other failures by returning an empty list. Never throws.
 */
function queryDependencyVersions(pkgName, fetch) {
  if (!pkgName || typeof fetch !== 'function') {
    return Promise.resolve({ package: pkgName || null, availableVersions: [], error: 'no fetch path' });
  }
  var safeName = pkgName.replace(/@/g, '%40').replace(/\//g, '%2F');
  var url = 'https://registry.npmjs.org/' + safeName;
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = controller ? setTimeout(function() { controller.abort(); }, 20000) : null;
  return Promise.resolve().then(function() {
    return fetch(url, {
      headers: { 'Accept': 'application/vnd.npm.install-v1+json' },
      signal: controller ? controller.signal : undefined
    });
  }).then(function(res) {
    var status = res && typeof res.status === 'number' ? res.status : 0;
    if (status === 401 || status === 403 || status === 404) {
      return { package: pkgName, availableVersions: [], error: 'registry ' + status };
    }
    if (res == null || typeof res.ok !== 'boolean' || !res.ok) {
      return { package: pkgName, availableVersions: [], error: 'non-ok response' };
    }
    var read = typeof res.json === 'function' ? res.json() : null;
    if (!read) return { package: pkgName, availableVersions: [], error: 'unreadable body' };
    return read.then(function(data) {
      var versions = [];
      var body = data || {};
      var map = body.versions && typeof body.versions === 'object' ? body.versions : {};
      var keys = Object.keys(map);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] && versions.indexOf(keys[i]) === -1) versions.push(keys[i]);
      }
      versions.sort(semverDesc);
      return { package: pkgName, availableVersions: versions.slice(0, 15).map(String), versionsAll: versions.length };
    });
  }).catch(function(err) {
    if (err && err.name === 'AbortError') {
      return { package: pkgName, availableVersions: [], error: 'registry timeout' };
    }
    return { package: pkgName, availableVersions: [], error: 'registry query failed' };
  }).finally(function() {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Build the re-ask prompt with JSON schema and validation error.
 */
function buildReAskPrompt(validationError) {
  var schema = '{\n  "repairKind": "source-edit|config-edit|migration|dependency-bump|dependency-patch|local-wrapper",\n  "rationale": "string",\n  "edits": [{"path": "string", "oldString": "string", "newString": "string"}],\n  "newFiles": "[optional] array of {path: string, content: string}"\n}';
  return 'Your previous response could not be parsed as a valid edit set.\n\n' +
    'Error: ' + validationError + '\n\n' +
    'Required JSON structure:\n' + schema + '\n\n' +
    'Output ONLY valid JSON that matches this structure. Do not include any explanation or prose, only the JSON object.';
}

/**
 * Build a re-ask prompt specifically for when the model's response was
 * truncated (finish_reason=length). The model is told the previous answer was
 * cut off and asked to return a shorter edit set covering only the most
 * critical changes.
 */
function buildTruncatedReAskPrompt() {
  var schema = '{\n  "repairKind": "source-edit|config-edit|migration|dependency-bump|dependency-patch|local-wrapper",\n  "rationale": "string",\n  "edits": [{"path": "string", "oldString": "string", "newString": "string"}],\n  "newFiles": "[optional] array of {path: string, content: string}"\n}';
  return 'Your previous response was cut off before it could be completed (the output exceeded the max token limit).\n\n' +
    'Please provide a shorter, more concise edit set that addresses the most critical fixes only.\n\n' +
    'Required JSON structure:\n' + schema + '\n\n' +
    'Output ONLY valid JSON. Keep the edits array minimal — prefer 1-3 high-impact edits over exhaustive coverage.\n' +
    'Do not include any explanation or prose, only the JSON object.';
}

/**
 * Compare two version strings without a dependency on semver. Returns positive
 * when b is newer than a's numeric segments are compared componentwise.
 */
function semverDesc(a, b) {
  var pa = String(a).split('-')[0].split('.').map(function(n) { return parseInt(n, 10) || 0; });
  var pb = String(b).split('-')[0].split('.').map(function(n) { return parseInt(n, 10) || 0; });
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var ca = pa[i] || 0;
    var cb = pb[i] || 0;
    if (ca !== cb) return cb - ca;
  }
  return 0;
}

/**
 * Read the exact installed version of a package from the clone's lockfile data
 * (package-lock.json dependencies/packages), falling back to package.json.
 */
function installedDependencyVersion(cloneDir, pkgName) {
  try {
    var lock = JSON.parse(fs.readFileSync(path.join(cloneDir, 'package-lock.json'), 'utf8'));
    var deps = lock.dependencies || {};
    if (deps[pkgName] && deps[pkgName].version) return String(deps[pkgName].version);
    var pkgs = lock.packages || {};
    if (pkgs['node_modules/' + pkgName] && pkgs['node_modules/' + pkgName].version) {
      return String(pkgs['node_modules/' + pkgName].version);
    }
  } catch (e) { /* no lockfile */ }
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8'));
    var ver = (pkg.dependencies || {})[pkgName] || (pkg.devDependencies || {})[pkgName];
    if (ver) return String(ver).replace(/^[\^~>=<]+/, '');
  } catch (e) { /* no package.json */ }
  return null;
}

/**
 * Main function: propose and check.
 */
async function proposeAndCheck(options) {
  var finding = options.finding;
  var candidates = options.candidates || [];
  var searched = options.searched || [];
  var previousAttempts = options.previousAttempts || [];
  var budget = options.budget;
  var runId = options.runId;
  var cloneDir = options.cloneDir;
  var attemptNumber = options.attemptNumber != null ? options.attemptNumber : 1;
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
  var modelNow = deps.modelNow || function() { return Date.now(); };
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
    writeAttemptSummary(runId, attemptNumber, {
      status: 'BLOCKED',
      codes: ['DOMAIN_NOT_REPAIRABLE'],
      requestedPaths: [],
      candidatePaths: (candidates || []).map(function(c) { return c.file; }),
      domain: domain
    }, fs, now);
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

  // Step 1b: zero real candidates -> BLOCKED NO_CANDIDATES, model never called.
  var realCandidates = (candidates || []).filter(function(c) { return c && c.file; });
  var framesEv = [];
  var stack = finding.stack;
  if (Array.isArray(stack)) {
    for (var fe = 0; fe < stack.length; fe++) {
      var sf = stack[fe];
      if (sf && sf.file) framesEv.push({ file: sf.file, line: sf.line || null });
    }
  }
  var pkgNames = [];
  var findingPkg = finding.package;
  if (findingPkg && typeof findingPkg === 'string' && pkgNames.indexOf(findingPkg) === -1) pkgNames.push(findingPkg);
  for (var pc = 0; pc < realCandidates.length; pc++) {
    var cp = realCandidates[pc].package;
    if (cp && typeof cp === 'string') {
      var rawName = cp.split('@')[0];
      if (rawName && pkgNames.indexOf(rawName) === -1) pkgNames.push(rawName);
    }
  }
  if (realCandidates.length === 0) {
    return {
      status: 'BLOCKED',
      blocker: {
        code: 'NO_CANDIDATES',
        message: 'no candidate code locations were found for this finding',
        evidence: {
          frames: framesEv,
          packages: pkgNames,
          searched: Array.isArray(searched) ? searched.slice() : []
        }
      }
    };
  }

  // Step 2: consume budget
  var consumeResult = model.consume(budget, finding.signature);
  if (!consumeResult.ok) {
    writeAttemptSummary(runId, attemptNumber, {
      status: 'BLOCKED',
      codes: ['BUDGET_EXHAUSTED'],
      requestedPaths: [],
      candidatePaths: (candidates || []).map(function(c) { return c.file; }),
      reason: consumeResult.reason
    }, fs, now);
    return {
      status: 'BUDGET_EXHAUSTED',
      blocker: { code: 'BUDGET_EXHAUSTED', message: consumeResult.reason }
    };
  }

  // Step 3: resolve the clone first (pipeline mode uses a scratch copy) so
  // capabilities and dependency info are derived from the exact tree the prompt
  // will point at. Dockerfile is never modified.
  var scratchCopied = false;
  if (mode === 'pipeline') {
    var repoRoot = path.resolve(__dirname, '..', '..');
    var scratchResult = await scratchCopy(repoRoot, runId, runCommand);
    if (!scratchResult.ok) {
      writeAttemptSummary(runId, attemptNumber, {
        status: 'BLOCKED',
        codes: ['SCRATCH_COPY_FAILED'],
        requestedPaths: [],
        candidatePaths: (candidates || []).map(function(c) { return c.file; }),
        error: scratchResult.error
      }, fs, now);
      return { status: 'BLOCKED', blocker: { code: 'SCRATCH_COPY_FAILED', message: scratchResult.error } };
    }
    cloneDir = scratchResult.dir;
    scratchCopied = true;
  }

  var capabilities = detectDependencyPatchCapability(cloneDir);
  var capabilitiesForPrompt = { dependencyPatch: capabilities.dependencyPatch, reason: capabilities.reason };
  writeCapabilitiesEvidence(capabilities, runId, fs, now);

  var dependencyInfo = null;
  if (finding.domain === 'dependency' && finding.package) {
    var reg = await queryDependencyVersions(finding.package, fetch);
    var installedVersion = installedDependencyVersion(cloneDir, finding.package);
    var newerExists = Array.isArray(reg.availableVersions) && reg.availableVersions.some(function(v) {
      return semverDesc(v, installedVersion) < 0;
    });
    dependencyInfo = {
      package: finding.package,
      installedVersion: installedVersion || 'unknown',
      availableVersions: reg.availableVersions || [],
      noNewer: !newerExists && (installedVersion !== null)
    };
  }

  // Step 3b: build the prompt with the resolved capabilities and dependency info.
  var prompt = buildPrompt(finding, candidates, previousAttempts, {
    domain: finding.domain,
    capabilities: { dependencyPatch: capabilities.dependencyPatch, reason: capabilities.reason },
    dependencyInfo: dependencyInfo
  });
  var promptChars = prompt.length;
  var modelStartMs = (typeof modelNow === 'function' ? modelNow() : Date.now());

  // Step 4: call model
  var modelResult;
  modelResult = await model.callModel({
    prompt: prompt,
    system: 'You are a bug fixer. Output only JSON.',
    env: env,
    budget: budget,
    fetch: fetch
  });
  var elapsedMs = (typeof modelNow === 'function' ? modelNow() : Date.now()) - modelStartMs;

  if (!modelResult.ok) {
    writeAttemptSummary(runId, attemptNumber, {
      status: 'MODEL_FAILED',
      codes: [modelResult.blocker && modelResult.blocker.code ? modelResult.blocker.code : 'MODEL_FAILED'],
      requestedPaths: [],
      candidatePaths: (candidates || []).map(function(c) { return c.file; }),
      tokensUsed: null,
      promptChars: promptChars,
      elapsedMs: elapsedMs,
      model: modelResult.model,
      requestedModel: modelResult.requestedModel,
      provider: modelResult.provider,
      blocker: modelResult.blocker
    }, fs, now);
    return {
      status: 'MODEL_FAILED',
      blocker: modelResult.blocker,
      errors: ['model call failed']
    };
  }

  // Parse edit set
  var parseResult = model.parseEditSet(modelResult.text);
  if (!parseResult.ok) {
    // Store evidence for the failed parse (no raw content, no secrets)
    var parseEvidence = {
      responseLength: modelResult.text ? modelResult.text.length : 0,
      finishReason: modelResult.finishReason || null,
      truncated: modelResult.truncated || false
    };
    try {
      var partial = JSON.parse((modelResult.text || '{}').trim().substring(0, 500));
      parseEvidence.topLevelKeys = Object.keys(partial).slice(0, 20);
    } catch (e) { /* partial parse failed, keys unknown */ }
    parseEvidence.validationRuleFailed = parseResult.error;

    // When finish_reason='length' the response was truncated; use a shorter
    // re-ask that tells the model the answer was cut off.
    var reAskPrompt = modelResult.truncated
      ? buildTruncatedReAskPrompt()
      : buildReAskPrompt(parseResult.error);
    var reAskStartMs = (typeof modelNow === 'function' ? modelNow() : Date.now());
    var reAskResult = await model.callModel({
      prompt: reAskPrompt,
      system: 'You are a bug fixer. Output only JSON.',
      env: env,
      budget: budget,
      fetch: fetch
    });
    var reAskElapsedMs = (typeof modelNow === 'function' ? modelNow() : Date.now()) - reAskStartMs;

    if (reAskResult.ok) {
      var reAskParseResult = model.parseEditSet(reAskResult.text);
      if (reAskParseResult.ok) {
        // Re-ask succeeded - use the new result
        modelResult = reAskResult;
        elapsedMs = reAskElapsedMs;
        parseResult = reAskParseResult;
      } else {
        // Re-ask parse failed - record REJECTED with evidence
        writeAttemptSummary(runId, attemptNumber, {
          status: 'REJECTED',
          codes: ['PARSE_ERROR'],
          requestedPaths: [],
          candidatePaths: [],
          tokensUsed: reAskResult.usage ? reAskResult.usage.total_tokens : null,
          promptChars: reAskPrompt.length,
          elapsedMs: reAskElapsedMs,
          model: reAskResult.model,
          requestedModel: reAskResult.requestedModel,
          provider: reAskResult.provider,
          parseEvidence: parseEvidence
        }, fs, now);
        return {
          status: 'REJECTED',
          rejectionCodes: ['PARSE_ERROR'],
          errors: ['parseEditSet re-ask failed: ' + reAskParseResult.error],
          blocker: { code: 'PARSE_ERROR', message: 're-ask parse failed: ' + reAskParseResult.error, evidence: parseEvidence }
        };
      }
    } else {
      // Re-ask model call failed - record REJECTED with evidence
      writeAttemptSummary(runId, attemptNumber, {
        status: 'REJECTED',
        codes: ['PARSE_ERROR'],
        requestedPaths: [],
        candidatePaths: [],
        tokensUsed: null,
        promptChars: reAskPrompt.length,
        elapsedMs: reAskElapsedMs,
        model: reAskResult.model,
        requestedModel: reAskResult.requestedModel,
        provider: reAskResult.provider,
        parseEvidence: parseEvidence
      }, fs, now);
      return {
        status: 'REJECTED',
        rejectionCodes: ['PARSE_ERROR'],
        errors: ['model re-ask failed: ' + (reAskResult.blocker && reAskResult.blocker.message)],
        blocker: reAskResult.blocker
      };
    }
  }

  var editSet = parseResult.editSet;

  // Check for identical repeat proposal: if the same repairKind+edits+newFiles
  // appeared in a previous attempt that was rejected, reject without spending
  // an attempt (model already "knows" this approach failed).
  if (previousAttempts && previousAttempts.length > 0) {
    var proposalHash = crypto.createHash('md5').update(JSON.stringify(editSet)).digest('hex');
    for (var rpi = 0; rpi < previousAttempts.length; rpi++) {
      var prev = previousAttempts[rpi];
      if (prev._proposalHash && prev._proposalHash === proposalHash) {
        // Identical proposal - reject without spending an attempt
        var identicalResult = {
          status: 'REJECTED',
          rejectionCodes: ['IDENTICAL_REPEAT_PROPOSAL'],
          errors: ['proposal is identical to a previously rejected attempt - do not repeat the same approach'],
          blocker: { code: 'IDENTICAL_REPEAT_PROPOSAL', message: 'proposal is identical to a previously rejected attempt - do not repeat the same approach' }
        };
        writeAttemptSummary(runId, attemptNumber, {
          status: 'REJECTED',
          codes: ['IDENTICAL_REPEAT_PROPOSAL'],
          requestedPaths: [],
          candidatePaths: [],
          tokensUsed: modelResult.usage ? modelResult.usage.total_tokens : null,
          promptChars: promptChars,
          elapsedMs: elapsedMs
        }, fs, now);
        return identicalResult;
      }
    }
    // Store the hash on this proposal so future attempts can detect repeats
    editSet._proposalHash = proposalHash;
  }

  // Collect the paths the model requested (trimmed to names only for evidence).
  var requestedPaths = [];
  (editSet.edits || []).forEach(function(e) { if (e && e.path) requestedPaths.push(e.path); });
  (editSet.newFiles || []).forEach(function(nf) { if (nf && nf.path) requestedPaths.push(nf.path); });

  // Step 4c: PROPOSAL_OUTSIDE_CANDIDATES gate — edits only on listed
  // candidate paths (plus newFiles under patches/, migrations dirs, or new
  // local-wrapper files under src/). An invented path is rejected here before
  // any general validation masking.
  var pathGate = validateProposalPaths(editSet, realCandidates, cloneDir, capabilities);
  if (!pathGate.ok) {
    var rejectionCodes = ['PROPOSAL_OUTSIDE_CANDIDATES'];
    var validPaths = pathGate.validPaths;
    writeAttemptSummary(runId, attemptNumber, {
      status: 'REJECTED',
      codes: rejectionCodes,
      requestedPaths: requestedPaths,
      candidatePaths: validPaths,
      tokensUsed: modelResult.usage ? modelResult.usage.total_tokens : null,
      promptChars: promptChars,
      elapsedMs: elapsedMs,
      model: modelResult.model,
      requestedModel: modelResult.requestedModel,
      provider: modelResult.provider
    }, fs, now);
    return {
      status: 'REJECTED',
      rejectionCodes: rejectionCodes,
      validCandidatePaths: validPaths,
      requestedPaths: requestedPaths,
      errors: pathGate.offending.map(function(p) { return '[' + rejectionCodes[0] + '] path not a listed candidate: ' + p; }),
      blocker: { code: 'PROPOSAL_OUTSIDE_CANDIDATES', message: 'proposal edits a path that is not a listed candidate: ' + pathGate.offending.join(', ') }
    };
  }

  // Step 5: validate
  var protectedPaths = getProtectedPaths(mode, fs);
  var validationResult = validator.validate(editSet, {
    cloneDir: cloneDir,
    requestedPaths: requestedPaths,
    protectedPaths: protectedPaths,
    mode: mode,
    capabilities: { dependencyPatch: capabilities.dependencyPatch }
  });

  if (!validationResult.ok) {
    var vCodes = extractErrorCodes(validationResult.errors);
    var vValid = candidateRelPaths(cloneDir, realCandidates);
    writeAttemptSummary(runId, attemptNumber, {
      status: 'REJECTED',
      codes: vCodes,
      requestedPaths: requestedPaths,
      candidatePaths: vValid,
      tokensUsed: modelResult.usage ? modelResult.usage.total_tokens : null,
      promptChars: promptChars,
      elapsedMs: elapsedMs,
      model: modelResult.model,
      requestedModel: modelResult.requestedModel,
      provider: modelResult.provider
    }, fs, now);
    return {
      status: 'REJECTED',
      rejectionCodes: vCodes,
      validCandidatePaths: vValid,
      requestedPaths: requestedPaths,
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
    // A lockfile/sync mismatch is a retryable rejection, not a hard failure.
    if (applyResult.blocker && (applyResult.blocker.code === 'LOCKFILE_OUT_OF_SYNC' || applyResult.blocker.code === 'LOCKFILE_REGEN_FAILED')) {
      var depCodes = [applyResult.blocker.code];
      var depValid = candidateRelPaths(cloneDir, realCandidates);
      writeAttemptSummary(runId, attemptNumber, {
        status: 'REJECTED',
        codes: depCodes,
        requestedPaths: requestedPaths,
        candidatePaths: depValid,
        tokensUsed: modelResult.usage ? modelResult.usage.total_tokens : null,
        promptChars: promptChars,
        elapsedMs: elapsedMs
      }, fs, now);
      return {
        status: 'REJECTED',
        rejectionCodes: depCodes,
        validCandidatePaths: depValid,
        requestedPaths: requestedPaths,
        errors: [applyResult.blocker.message],
        blocker: { code: applyResult.blocker.code, message: applyResult.blocker.message }
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

  // Detect if any script was killed by signal (e.g. SIGKILL on timeout) with no
  // output — this is distinct from a clean exit-with-non-zero-code failure.
  var killedWithNoOutput = false;
  var killedResults = [];
  if (!checkResult.ok && Array.isArray(checkResult.results)) {
    for (var ci = 0; ci < checkResult.results.length; ci++) {
      var cr = checkResult.results[ci];
      if (cr.signal && !cr.stdout && !cr.stderr) {
        killedWithNoOutput = true;
        killedResults.push(cr);
      }
    }
  }

  if (!checkResult.ok) {
    var checkStatus = killedWithNoOutput ? 'CHECKS_ERROR' : 'CHECKS_FAILED';
    var checkCodes = killedWithNoOutput ? ['CHECKS_ERROR'] : ['CHECKS_FAILED'];
    writeAttemptSummary(runId, attemptNumber, {
      status: checkStatus,
      codes: checkCodes,
      requestedPaths: requestedPaths,
      candidatePaths: (candidates || []).map(function(c) { return c.file; }),
      tokensUsed: modelResult.usage ? modelResult.usage.total_tokens : null,
      promptChars: promptChars,
      elapsedMs: elapsedMs,
      checks: { results: checkResult.results },
      checkKilled: killedWithNoOutput ? {
        signal: killedResults[0] ? killedResults[0].signal : null,
        timedOut: killedResults[0] ? killedResults[0].timedOut : null,
        cwd: killedResults[0] ? killedResults[0].cwd : null
      } : null
    }, fs, now);
    // Restore clone
    if (mode === 'target') {
      applier.restoreClone(cloneDir, runCommand);
    }
    return {
      status: checkStatus,
      checks: { results: checkResult.results },
      errors: killedWithNoOutput
        ? ['checks error: process killed with signal ' + (killedResults[0] ? killedResults[0].signal : 'unknown')]
        : ['checks failed']
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

  writeAttemptSummary(runId, attemptNumber, {
    status: 'READY',
    codes: [],
    requestedPaths: requestedPaths,
    candidatePaths: candidateRelPaths(cloneDir, realCandidates),
    tokensUsed: modelResult.usage ? modelResult.usage.total_tokens : null,
    promptChars: promptChars,
    elapsedMs: elapsedMs,
    model: modelResult.model,
    requestedModel: modelResult.requestedModel,
    provider: modelResult.provider
  }, fs, now);


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
  buildPrompt: buildPrompt,
  detectDependencyPatchCapability: detectDependencyPatchCapability,
  queryDependencyVersions: queryDependencyVersions,
  candidateRelPaths: candidateRelPaths,
  validateProposalPaths: validateProposalPaths,
  installedDependencyVersion: installedDependencyVersion
};
