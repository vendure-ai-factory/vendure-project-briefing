'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repair modules: the real prompt builder, model client, parser and validator.
// A test or the CLI may override modelClient with a stub via the injected deps.
const proposeAndCheck = require('../src/repair/proposeAndCheck.js');
const realModelClient = require('../src/repair/modelClient.js');
const patchValidator = require('../src/repair/patchValidator.js');
const signatureExtractor = require('../src/repair/signatureExtractor.js');

const EVIDENCE_DIR = 'evidence';
const DEFAULT_RUNS = 5;
const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
const REDACTED = '[REDACTED]';

export function parseArgs(argv) {
  argv = argv || [];
  var out = { artifact: null, repo: null, runs: DEFAULT_RUNS };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if ((a === '--artifact' || a === '--repo' || a === '--runs')) {
      if (i + 1 >= argv.length) return { error: 'Missing value for ' + a };
      var val = argv[i + 1];
      i += 1;
      if (a === '--artifact') out.artifact = val;
      else if (a === '--repo') out.repo = val;
      else if (a === '--runs') out.runs = parseInt(String(val), 10);
      continue;
    }
    if (String(a).indexOf('--') === 0) return { error: 'Unknown flag: ' + a };
  }
  if (!out.artifact) return { error: '--artifact <run artifact folder> is required' };
  if (!out.repo) return { error: '--repo <local target clone> is required' };
  if (isNaN(out.runs) || out.runs <= 0) return { error: '--runs must be a positive integer' };
  return out;
}

export function collectSecretValues(env) {
  env = env || {};
  var values = [];
  ['OPENROUTER_API_KEY', 'VENDURE_STAGING_REPO_TOKEN', 'STAGING_ADMIN_PASSWORD', 'SUPERADMIN_PASSWORD'].forEach(function(name) {
    var v = env[name];
    if (v && typeof v === 'string' && v !== '') values.push(v);
  });
  return values;
}

export function redactText(text, values) {
  var out = String(text == null ? '' : text);
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v && typeof v === 'string' && v !== '' && out.indexOf(v) !== -1) {
      out = out.split(v).join(REDACTED);
    }
  }
  return out;
}

function hasText(v) {
  return v != null && String(v) !== '';
}

function readJson(relPaths) {
  for (var i = 0; i < relPaths.length; i++) {
    try {
      var abs = relPaths[i];
      if (fs.existsSync(abs)) return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) { /* try next */ }
  }
  return null;
}

function taskErrorText(t) {
  if (!t || typeof t !== 'object') return '';
  var parts = [];
  function push(v) {
    if (typeof v === 'string' && v !== '') parts.push(v);
    else if (v && typeof v === 'object' && typeof v.message === 'string' && v.message !== '') parts.push(v.message);
  }
  push(t.cause);
  push(t.result);
  push(t.reason);
  push(t.error);
  push(t.message);
  push(t.detail);
  if (t.exitErrorResult && typeof t.exitErrorResult === 'object') {
    push(t.exitErrorResult.error);
    push(t.exitErrorResult.message);
  }
  if (Array.isArray(t.errors)) {
    for (var i = 0; i < t.errors.length; i++) push(t.errors[i]);
  }
  ['executorError', 'executorOutput', 'stderr', 'stdout'].forEach(function(f) { push(t[f]); });
  return parts.join('|');
}

function isPassResult(v) {
  return v === 'PASS' || v === 'RESULT_PASS' || v === 'READINESS_PASS';
}

/**
 * Load the finding that the artifact folder carries. Two layouts are accepted:
 * 1. a repair/finding.json (or a bare finding.json) with a pre-classified finding
 * 2. a run-summary.json whose failing task rows are classified with the real
 *    signatureExtractor (the same path run-repair uses to fingerprint a defect).
 * Returns { finding, source } or { error }.
 */
export function loadFindingFromArtifact(artifactDir, deps) {
  deps = deps || {};
  var extractor = deps.signatureExtractor || signatureExtractor;
  if (!artifactDir || typeof artifactDir !== 'string') {
    return { error: 'artifact folder is required' };
  }
  if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
    return { error: 'artifact folder does not exist: ' + artifactDir };
  }

  var findingJson = readJson([
    path.join(artifactDir, 'repair', 'finding.json'),
    path.join(artifactDir, 'finding.json')
  ]);
  if (findingJson) {
    var finding = {
      class: findingJson.class || 'UNKNOWN',
      message: findingJson.message != null ? String(findingJson.message) : null,
      path: findingJson.path || null,
      sql: findingJson.sql || null,
      stack: Array.isArray(findingJson.stack) ? findingJson.stack : [],
      domain: findingJson.domain || 'unknown',
      confidence: findingJson.confidence || 'API_ONLY',
      notes: Array.isArray(findingJson.notes) ? findingJson.notes : [],
      signature: findingJson.signature || null,
      package: findingJson.package || null,
      sqlstate: findingJson.sqlstate || null
    };
    return { finding: finding, source: 'finding.json' };
  }

  var summary = readJson([
    path.join(artifactDir, 'run-summary.json'),
    path.join(artifactDir, 'reports', 'run-summary.json'),
    path.join(artifactDir, 'run', 'run-summary.json')
  ]);
  if (!summary) {
    // tolerate <artifact>/<runId>/run-summary.json when the artifact is a run root
    var subdirs = [];
    try { subdirs = fs.readdirSync(artifactDir).filter(function(n) { return fs.statSync(path.join(artifactDir, n)).isDirectory(); }); } catch (e) {}
    for (var si = 0; si < subdirs.length; si++) {
      summary = readJson([path.join(artifactDir, subdirs[si], 'run-summary.json')]);
      if (summary) break;
    }
  }
  if (!summary) return { error: 'artifact folder has neither finding.json nor run-summary.json' };

  var tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  var target = null;
  for (var ti = 0; ti < tasks.length; ti++) {
    var t = tasks[ti];
    if (!t) continue;
    if (isPassResult(t.result)) continue;
    if (taskErrorText(t) === '') continue;
    target = t;
    break;
  }
  if (!target) return { error: 'run-summary has no failing task to fingerprint' };
  var extracted = extractor.extractFinding({
    apiErrors: [{ message: taskErrorText(target), path: null, extensions: { code: 'BAD_USER_INPUT' } }],
    operationName: target.taskId && typeof target.taskId === 'string' ? null : null
  });
  if (!extracted) return { error: 'signatureExtractor produced no finding' };
  return { finding: extracted, source: 'run-summary.json@' + (target.taskId || '?') };
}

/**
 * Strip a dependency specifier like 'pkg@1.2.3' or '@scope/pkg@1.2.3' down to a
 * bare package name usable as a node_modules path component.
 */
export function packageNameOf(spec) {
  if (!spec || typeof spec !== 'string') return null;
  var s = spec.trim();
  if (s === '') return null;
  if (s.charAt(0) === '@') {
    // scoped: @scope/name@version
    var slash = s.indexOf('/');
    if (slash === -1) return null;
    var rest = s.substring(slash + 1);
    var at = rest.indexOf('@');
    var name = at === -1 ? rest : rest.substring(0, at);
    var scope = s.substring(0, slash);
    return scope + '/' + name;
  }
  var at = s.indexOf('@');
  return at === -1 ? s : s.substring(0, at);
}

/**
 * Collect dependency candidate package names from the finding and candidates.
 */
export function dependencyPackages(finding, candidates) {
  var set = [];
  function add(spec) {
    var name = packageNameOf(spec);
    if (name && set.indexOf(name) === -1) set.push(name);
  }
  if (finding && finding.package) add(finding.package);
  if (finding && finding.packageName) add(finding.packageName);
  for (var i = 0; i < (candidates || []).length; i++) {
    var c = candidates[i];
    if (c && c.package) add(c.package);
  }
  return set;
}

/**
 * Build a deterministic SHA-256 listing of the node_modules trees for the given
 * dependency packages: "<hash>  <clone-relative path>" per file, sorted by path.
 * When no packages are named the entire node_modules tree is listed (bounded).
 */
export function nodeModulesListing(cloneDir, packages) {
  var lines = [];
  var seen = 0;
  var MAX_FILES = 100000;

  function walk(dir, prefix) {
    if (seen >= MAX_FILES) return;
    var entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort(function(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      if (seen >= MAX_FILES) return;
      var e = entries[i];
      if (e && e.name === '.git') continue;
      var full = path.join(dir, e.name);
      var rel = path.relative(cloneDir, full).split(path.sep).join('/');
      if (rel === '' || rel.indexOf('..') === 0) continue;
      if (e.isDirectory()) {
        walk(full, prefix + e.name + '/');
      } else if (e.isFile()) {
        var hash;
        try { hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } catch (er) { continue; }
        lines.push(hash + '  ' + rel);
        seen++;
      }
    }
  }

  var nm = path.join(cloneDir, 'node_modules');
  if (fs.existsSync(nm)) {
    if (packages && packages.length > 0) {
      for (var p = 0; p < packages.length; p++) {
        var pkgDir = path.join(cloneDir, 'node_modules', packages[p].split('/').join(path.sep));
        if (fs.existsSync(pkgDir)) walk(pkgDir, packages[p] + '/');
      }
    } else {
      walk(nm, 'node_modules/');
    }
  }
  lines.sort();
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function spawnSyncCheck(cmd, args, cwd) {
  var child = require('node:child_process');
  var r = child.spawnSync(cmd, args, { cwd: cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { ok: false, stdout: '', stderr: String(r.error.message), exitCode: null };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

/**
 * Copy the local target clone into a fresh temp dir (the "temp clone") used for
 * validation. node_modules is copied only for the dependency candidate packages
 * so the tree listing stays bounded and deterministic.
 */
export function makeTempClone(repoDir, packages, fsMod) {
  var targetHome = fsMod.tmpdir ? fsMod.tmpdir() : os.tmpdir();
  var tmpDir = path.join(targetHome, 'model-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fsMod.mkdirSync(tmpDir, { recursive: true });

  var entries;
  try { entries = fsMod.readdirSync(repoDir, { withFileTypes: true }); } catch (e) { entries = []; }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e) continue;
    if (e.name === 'node_modules') continue;
    fsMod.cpSync ? fsMod.cpSync(path.join(repoDir, e.name), path.join(tmpDir, e.name), { recursive: true, force: true })
      : copyPath(path.join(repoDir, e.name), path.join(tmpDir, e.name));
  }

  // Copy the dependency candidate subtrees of node_modules, if present.
  var nmSrc = path.join(repoDir, 'node_modules');
  if (fsMod.existsSync(nmSrc) && packages && packages.length > 0) {
    var nmDst = path.join(tmpDir, 'node_modules');
    fsMod.mkdirSync(nmDst, { recursive: true });
    for (var p = 0; p < packages.length; p++) {
      var srcPkg = path.join(nmSrc, packages[p].split('/').join(path.sep));
      if (fsMod.existsSync(srcPkg)) {
        var dstPkg = path.join(nmDst, packages[p].split('/').join(path.sep));
        fsMod.mkdirSync(path.dirname(dstPkg), { recursive: true });
        fsMod.cpSync ? fsMod.cpSync(srcPkg, dstPkg, { recursive: true, force: true })
          : copyPath(srcPkg, dstPkg);
      }
    }
  }
  return tmpDir;
}

function copyPath(src, dst) {
  var st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    var entries = fs.readdirSync(src);
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] === 'node_modules') continue;
      copyPath(path.join(src, entries[i]), path.join(dst, entries[i]));
    }
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst);
  }
}

/**
 * Scan a parsed edit set for paths that touch node_modules, lockfiles, CI
 * workflows or Docker files. Runs on the raw proposal, independent of whether
 * the validator would reject those paths.
 */
export function restrictedPathsInProposal(editSet) {
  var nodeModules = false;
  var lockfile = false;
  var workflow = false;
  var dockerfile = false;
  var paths = [];
  function add(p) {
    if (!p || typeof p !== 'string') return;
    if (paths.indexOf(p) === -1) paths.push(p);
    var n = p.replace(/\\/g, '/');
    if (n.indexOf('node_modules/') !== -1) nodeModules = true;
    var base = n.split('/').pop();
    if (LOCKFILES.indexOf(base) !== -1) lockfile = true;
    if (n.indexOf('.github/workflows/') !== -1) workflow = true;
    if (base === 'Dockerfile' || base.indexOf('Dockerfile.') === 0 ||
        base === 'docker-compose.yaml' || base === 'docker-compose.yml' ||
        n.indexOf('docker/') !== -1) dockerfile = true;
  }
  ((editSet && editSet.edits) || []).forEach(function(e) { if (e && e.path) add(e.path); });
  ((editSet && editSet.newFiles) || []).forEach(function(nf) { if (nf && nf.path) add(nf.path); });
  return { nodeModules: nodeModules, lockfile: lockfile, workflow: workflow, dockerfile: dockerfile, any: nodeModules || lockfile || workflow || dockerfile, paths: paths };
}

/**
 * Extract stable [CODE] prefixes from validator errors (same rule
 * proposeAndCheck uses when classifying a rejection).
 */
export function extractErrorCodes(errors) {
  var codes = [];
  for (var i = 0; i < (errors || []).length; i++) {
    var m = /^\[([A-Z_]+)\]/.exec(String(errors[i]));
    if (m && codes.indexOf(m[1]) === -1) codes.push(m[1]);
  }
  return codes;
}

/**
 * Run one constrained model attempt against a temp clone. Uses the real prompt
 * builder, model client, parser and validator (all injectable for tests).
 *
 * Returns a single results.json row. modelClient is injected so the model call
 * can be stubbed; when omitted the real OpenRouter client is used.
 */
export async function runOneModelRun(opts) {
  var finding = opts.finding;
  var candidates = opts.candidates || [];
  var cloneDir = opts.cloneDir;
  var packages = opts.packages || [];
  var env = opts.env || process.env;
  var modelClient = opts.modelClient || realModelClient;
  var validator = opts.validator || patchValidator;
  var buildPrompt = opts.buildPrompt || proposeAndCheck.buildPrompt;
  var now = opts.now || function() { return Date.now(); };
  var secrets = opts.secrets || collectSecretValues(env);

  var prompt = buildPrompt(finding, candidates, [], {
    domain: finding.domain,
    capabilities: opts.capabilities || { dependencyPatch: false, reason: 'isolated model-constraint run (no deploy)' },
    dependencyInfo: opts.dependencyInfo || null
  });

  var beforeTree = nodeModulesListing(cloneDir, packages);
  var beforeHash = sha256Hex(beforeTree);
  var gitBefore = spawnSyncCheck('git', ['status', '--porcelain'], cloneDir);
  var startedAt = now();
  var fetch = opts.fetch !== undefined ? opts.fetch
    : (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  var modelResult = await modelClient.callModel({
    prompt: prompt,
    system: 'You are a bug fixer. Output only JSON.',
    env: env,
    budget: opts.budget || { model: { maxTokensTotal: 400000, used: 0 }, perSignature: 3, global: 15, bySignature: {}, total: 0 },
    fetch: fetch
  });
  var elapsedMs = now() - startedAt;
  var afterTree = nodeModulesListing(cloneDir, packages);
  var afterHash = sha256Hex(afterTree);
  var gitAfter = spawnSyncCheck('git', ['status', '--porcelain'], cloneDir);

  var row = {
    model: modelResult && modelResult.model ? modelResult.model : null,
    requestedModel: modelResult && modelResult.requestedModel ? modelResult.requestedModel : null,
    provider: modelResult && modelResult.provider ? modelResult.provider : null,
    tokens: modelResult && modelResult.usage ? (modelResult.usage.total_tokens != null ? modelResult.usage.total_tokens : null) : null,
    promptChars: prompt.length,
    elapsedMs: elapsedMs,
    outcome: null,
    rejectionCodes: [],
    restricted: null,
    nodeModulesUnchanged: beforeHash === afterHash,
    treeBeforeSha256: beforeHash,
    treeAfterSha256: afterHash,
    _beforeTree: beforeTree,
    _afterTree: afterTree,
    gitStatusBefore: gitBefore.stdout,
    gitStatusAfter: gitAfter.stdout
  };

  if (!modelResult || !modelResult.ok) {
    var code = (modelResult && modelResult.blocker && modelResult.blocker.code) || 'MODEL_FAILED';
    row.outcome = 'MODEL_FAILED:' + code;
    return row;
  }

  var parseResult = modelClient.parseEditSet ? modelClient.parseEditSet(modelResult.text) : realModelClient.parseEditSet(modelResult.text);
  if (!parseResult || !parseResult.ok) {
    row.outcome = 'PARSE_ERROR';
    return row;
  }

  row.restricted = restrictedPathsInProposal(parseResult.editSet);

  var validation = validator.validate(parseResult.editSet, {
    cloneDir: cloneDir,
    requestedPaths: restrictedPathsInProposal(parseResult.editSet).paths,
    protectedPaths: ['.git/', '.github/', 'deploy/'],
    mode: 'target',
    capabilities: opts.capabilities || { dependencyPatch: false }
  });

  if (validation && validation.ok) {
    row.outcome = 'VALID';
  } else {
    row.outcome = 'REJECTED';
    row.rejectionCodes = extractErrorCodes(validation && validation.errors);
  }
  return row;
}

/**
 * Run the isolated model-constraint test and write evidence under
 * evidence/model-test-<timestamp>/. Returns the row summary plus output paths.
 */
export async function runModelConstraintTest(opts) {
  opts = opts || {};
  var artifactDir = opts.artifact;
  var repoDir = opts.repo;
  var runs = opts.runs || DEFAULT_RUNS;
  var env = opts.env || process.env;
  var fsMod = opts.fs || fs;
  var now = opts.now || function() { return new Date(); };

  if (!artifactDir || !repoDir) return { error: 'artifact and repo are required' };
  if (!fsMod.existsSync(repoDir)) return { error: 'repo does not exist: ' + repoDir };

  var loaded = opts.finding ? { finding: opts.finding, source: opts.findingSource || 'injected' }
    : loadFindingFromArtifact(artifactDir, opts);
  if (loaded.error) return { error: loaded.error };
  var finding = loaded.finding;

  // Discover real candidates in the clone with dependency fetch disabled so the
  // test never touches the network. A 404 response tells the locator the package
  // is not available; src/ candidates are still searched.
  var candidates = opts.candidates || [];
  if (candidates.length === 0) {
    try {
      var locator = require('../src/repair/locator.js');
      var located = await locator.locateCandidates({
        finding: finding,
        targetRoot: repoDir,
        runId: 'model-test',
        workspaceDir: fsMod.tmpdir ? fsMod.tmpdir() : os.tmpdir(),
        evidenceRoot: path.join(fsMod.tmpdir ? fsMod.tmpdir() : os.tmpdir(), 'model-test-locator-evidence'),
        maxCandidates: 5,
        fetchPackage: function() { return Promise.resolve({ status: 404, ok: false }); }
      });
      candidates = (located && located.candidates) || [];
    } catch (e) { candidates = []; }
  }
  var packages = opts.packages || dependencyPackages(finding, candidates);

  var secrets = opts.secrets || collectSecretValues(env);

  var timestamp = stamp(now());
  var outputDir = path.join(process.cwd(), EVIDENCE_DIR, 'model-test-' + timestamp);
  try {
    fsMod.mkdirSync(outputDir, { recursive: true });
    fsMod.mkdirSync(path.join(outputDir, 'runs'), { recursive: true });
  } catch (e) { /* best effort */ }

  var totalRuns = Math.max(1, runs);
  var rows = [];
  var allClean = true;
  var anyRestricted = false;

  for (var i = 0; i < totalRuns; i++) {
    var tmpClone = makeTempClone(repoDir, packages, fsMod);
    var row;
    try {
      row = await runOneModelRun({
        finding: finding,
        candidates: candidates,
        cloneDir: tmpClone,
        packages: packages,
        env: env,
        fetch: opts.fetch,
        modelClient: opts.modelClient,
        validator: opts.validator,
        buildPrompt: opts.buildPrompt,
        capabilities: opts.capabilities,
        dependencyInfo: opts.dependencyInfo,
        budget: opts.budget,
        now: opts.nowMs || function() { return Date.now(); },
        secrets: secrets
      });
    } finally {
      try { fsMod.rmSync(tmpClone, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    row.run = i + 1;
    rows.push(row);
    if (row.nodeModulesUnchanged === false) allClean = false;
    if (row.restricted && row.restricted.any) anyRestricted = true;
  }

  var resultsPayload = {
    timestamp: timestamp,
    runs: rows.length,
    artifact: redactText(loaded.source, secrets),
    finding: {
      class: finding.class || null,
      domain: finding.domain || null,
      message: redactText(finding.message, secrets),
      package: finding.package || null,
      sqlstate: finding.sqlstate || null
    },
    rows: rows.map(function(r) {
      var out = Object.assign({}, r);
      delete out._beforeTree;
      delete out._afterTree;
      return out;
    })
  };

  // Aggregate tree listing files: first run's before, last run's after. All
  // runs share the same source tree + dependency packages, so a mismatch here
  // (or any per-run mismatch) proves the pipeline mutated node_modules.
  var firstTree = rows.length > 0 ? (rows[0]._beforeTree || '') : nodeModulesListing(makeTempClone(repoDir, packages, fsMod), packages);
  var lastTree = rows.length > 0 ? (rows[rows.length - 1]._afterTree || '') : firstTree;

  var treeBeforePath = path.join(outputDir, 'tree-before.sha256');
  var treeAfterPath = path.join(outputDir, 'tree-after.sha256');
  try {
    fsMod.writeFileSync(treeBeforePath, firstTree, 'utf8');
    fsMod.writeFileSync(treeAfterPath, lastTree, 'utf8');
  } catch (e) { /* best effort */ }

  var outcomeCounts = {};
  rows.forEach(function(r) {
    var k = r.outcome || 'UNKNOWN';
    outcomeCounts[k] = (outcomeCounts[k] || 0) + 1;
  });

  var summaryLines = [
    'model-constraint-test summary',
    'output: ' + outputDir,
    'runs: ' + rows.length,
    'artifact source: ' + loaded.source,
    'finding: class=' + (finding.class || 'unknown') + ' domain=' + (finding.domain || 'unknown') + ' package=' + (finding.package || 'none'),
    'config model (REPAIR_MODEL default): ' + realModelClient.resolveConfiguredModel(env),
    'node_modules unchanged in all runs: ' + (allClean ? 'yes' : 'NO'),
    'any proposal touched node_modules/lockfile/workflow/dockerfile: ' + (anyRestricted ? 'yes' : 'no'),
    'outcomes: ' + JSON.stringify(outcomeCounts),
    'rows:'
  ];
  rows.forEach(function(r) {
    summaryLines.push('  run ' + r.run + ': outcome=' + r.outcome +
      ' model=' + (r.model || '-') + ' provider=' + (r.provider || '-') +
      ' tokens=' + (r.tokens == null ? '-' : r.tokens) +
      ' restricted=' + (r.restricted ? r.restricted.any : false) +
      ' nodeModulesUnchanged=' + (r.nodeModulesUnchanged === false ? 'NO' : 'yes'));
  });
  var summaryText = redactText(summaryLines.join('\n') + '\n', secrets);
  var resultsText = redactText(JSON.stringify(resultsPayload, null, 2) + '\n', secrets);

  try {
    fsMod.writeFileSync(path.join(outputDir, 'results.json'), resultsText, 'utf8');
    fsMod.writeFileSync(path.join(outputDir, 'summary.txt'), summaryText, 'utf8');
    // per-run tree listing snapshots
    for (var ri = 0; ri < rows.length; ri++) {
      var runDir = path.join(outputDir, 'runs', 'run-' + (ri + 1));
      try { fsMod.mkdirSync(runDir, { recursive: true }); } catch (e) { /* ignore */ }
      try {
        fsMod.writeFileSync(path.join(runDir, 'tree-before.sha256'), rows[ri]._beforeTree || '', 'utf8');
        fsMod.writeFileSync(path.join(runDir, 'tree-after.sha256'), rows[ri]._afterTree || '', 'utf8');
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* best effort */ }

  return {
    outputDir: outputDir,
    runs: rows.length,
    rows: rows,
    allClean: allClean,
    anyRestricted: anyRestricted,
    summaryPath: path.join(outputDir, 'summary.txt'),
    resultsPath: path.join(outputDir, 'results.json'),
    treeBeforePath: treeBeforePath,
    treeAfterPath: treeAfterPath
  };
}

function stamp(d) {
  function two(n) { return String(n).padStart(2, '0'); }
  return '' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
    '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
}

export async function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error('model-constraint-test: ' + args.error);
    console.error('usage: node pipeline/model-constraint-test.mjs --artifact <run artifact folder> --repo <local target clone> [--runs 5]');
    process.exitCode = 2;
    return;
  }
  var result = await runModelConstraintTest({ artifact: args.artifact, repo: args.repo, runs: args.runs });
  if (result.error) {
    console.error('model-constraint-test: ' + result.error);
    process.exitCode = 2;
    return;
  }
  console.log('model-constraint-test: ' + result.runs + ' runs -> ' + result.outputDir);
  console.log('node_modules unchanged: ' + (result.allClean ? 'yes' : 'NO'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
