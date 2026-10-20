'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');
var coerce = require('./coerce');
var toText = coerce.toText;

var DEFAULT_MAX_CANDIDATES = 5;
var MAX_FILE_SIZE = 1024 * 1024; // 1MB
var EVIDENCE_ROOT = 'evidence';

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Derive search patterns from a finding.
 * Generic patterns based on operator and column, not hard-coded to one bug.
 * When the GraphQL path is absent, patterns are derived from the finding's
 * stack frames (function/file names) and the GraphQL operation name, keeping
 * the derivation task-id independent.
 */
function deriveSearchPatterns(finding) {
  var patterns = [];
  finding = finding || {};
  var operator = finding.operator;
  var column = finding.column;
  var queryPath = finding.path;

  if (operator && column) {
    var colName = toText(column).split('.').pop(); // e.g., 'col' from 'table.col'

    // Generic operator negation patterns
    if (operator === '!=') {
      patterns.push('notEq');
      patterns.push('!= :');
      patterns.push('"' + colName + '" !="');
      patterns.push("'" + colName + "' !=");
      patterns.push('Not(');
      patterns.push('.not(');
      patterns.push('ne:');
    }

    // Generic null/empty check patterns
    if (operator === 'IS NOT NULL' || operator === 'IS NULL') {
      patterns.push('isNull');
      patterns.push('isNotNull');
      patterns.push('!= null');
      patterns.push('== null');
    }

    // Generic comparison patterns
    if (operator === '>' || operator === '<' || operator === '>=' || operator === '<=') {
      var opLower = operator.toLowerCase().replace('=', '');
      patterns.push('gt:');
      patterns.push('lt:');
      patterns.push('gte:');
      patterns.push('lte:');
    }
  }

  // If path has a query name, search for resolvers/methods named like that
  if (queryPath && typeof queryPath === 'string' && queryPath.length > 0 && queryPath !== 'undefined') {
    patterns.push(queryPath); // e.g., 'products'
    patterns.push(queryPath + 'Resolver');
    patterns.push(queryPath + 'Service');
    patterns.push(queryPath + 'Query');
  }

  // When the GraphQL path is absent, fall back to stack-frame function/file
  // names and the GraphQL operation name (both task-id independent).
  if (!queryPath || queryPath === 'undefined') {
    var stack = finding.stack;
    var frames = Array.isArray(stack) ? stack : [];
    for (var fi = 0; fi < frames.length; fi++) {
      var f = frames[fi];
      if (!f) continue;
      var file = f.file ? String(f.file).replace(/\\/g, '/') : '';
      // Low-signal: skip node_modules frames and parent dirs for the millions
      // of frames that would otherwise flood the pattern set.
      if (file.indexOf('node_modules/') !== -1) continue;
      if (file.indexOf('node:') === 0) continue;
      var fn = f.fn ? String(f.fn) : '';
      var fnName = fn.split(/[.(]/)[0] || '';
      if (fnName && fnName.length >= 2 && ['async', 'at', 'module'].indexOf(fnName) === -1) {
        patterns.push(fnName);
      }
      var base = path.posix.basename(file).replace(/\.(ts|js|mjs|cjs)$/, '');
      if (base && base.length >= 2 && patterns.indexOf(base) === -1) {
        patterns.push(base);
      }
    }
    if (typeof finding.operationName === 'string' && finding.operationName.length > 0) {
      var opName = finding.operationName.trim();
      if (patterns.indexOf(opName) === -1) {
        patterns.push(opName);
      }
      if (patterns.indexOf(opName + 'Resolver') === -1) {
        patterns.push(opName + 'Resolver');
      }
    }
  }

  return patterns;
}

/**
 * Search for patterns in a single file.
 * Returns array of { line, lineNumber, matchedPattern }.
 */
function searchFileForPatterns(filePath, patterns) {
  var results = [];
  try {
    var stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      return results;
    }
    var content = fs.readFileSync(filePath, 'utf8');
    var lines = content.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      for (var j = 0; j < patterns.length; j++) {
        var pattern = patterns[j];
        if (line.indexOf(pattern) !== -1) {
          results.push({
            line: line,
            lineNumber: i + 1,
            matchedPattern: pattern
          });
        }
      }
    }
  } catch (err) {
    // Skip files that can't be read
  }
  return results;
}

/**
 * Get context lines (3 lines: 1 before, current, 1 after).
 */
function getContextLines(filePath, targetLine, matchedPattern) {
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    var lines = content.split('\n');
    var startLine = Math.max(0, targetLine - 2);
    var endLine = Math.min(lines.length - 1, targetLine);
    var context = [];
    for (var i = startLine; i <= endLine; i++) {
      context.push({ line: lines[i], lineNumber: i + 1 });
    }
    return {
      snippet: context,
      matchedLine: targetLine,
      matchedPattern: matchedPattern
    };
  } catch (err) {
    return { snippet: [], matchedLine: targetLine, matchedPattern: matchedPattern };
  }
}

/**
 * Recursively copy a package's contents into the clone's node_modules/<pkg>
 * location without overwriting existing files, while skipping nested
 * node_modules/.git inside the package itself.
 */
function copyDirContents(src, dst) {
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    var s = path.join(src, entry.name);
    var d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      copyDirContents(s, d);
    } else if (entry.isFile()) {
      if (!fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  }
}

/**
 * Recursively find all .ts and .js files in a directory,
 * skipping node_modules, dist, .git, and files > 1MB.
 */
function findSourceFiles(dirPath, searched) {
  var files = [];
  try {
    var entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
          continue;
        }
        files = files.concat(findSourceFiles(fullPath, searched));
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
          try {
            var stats = fs.statSync(fullPath);
            if (stats.size <= MAX_FILE_SIZE) {
              files.push(fullPath);
              if (searched.indexOf(fullPath) === -1) {
                searched.push(fullPath);
              }
            }
          } catch (e) {
            // Skip files we can't stat
          }
        }
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }
  return files;
}

/**
 * Check if a function name in the content matches the query path.
 * Looks for function/class definitions that match the query name.
 */
function isInsideMatchingFunction(content, queryPath, targetLine) {
  if (!queryPath || !content) return false;

  var lines = content.split('\n');
  // Look backwards from targetLine for function/method definitions
  for (var i = targetLine - 1; i >= 0 && i >= targetLine - 20; i--) {
    var line = lines[i];
    // Function/method/async patterns
    if (/\b(function|async|class|\.method|\.query|Query|Resolver|Service)\b/.test(line)) {
      // Check if this function name contains the query path
      var funcPattern = new RegExp('\\b(' + queryPath + ')\\b', 'i');
      if (funcPattern.test(line)) {
        return true;
      }
    }
    // Stop at function boundary if we went too far
    if (i < targetLine - 20) break;
  }
  return false;
}

/**
 * Score a match based on criteria:
 * +3 operator with template-literal/variable operand
 * +3 inside a function whose name matches the failing query path
 * +1 per extra pattern hit
 */
function scoreMatch(match, finding, allPatterns) {
  var score = 0;
  var line = match.line;
  var matchedPattern = match.matchedPattern;

  // Check for operator with template-literal/variable operand
  // e.g., != `${someVar}`, != someVar, or != otherId
  var operator = finding.operator;
  if (operator && line.indexOf(operator) !== -1) {
    // Check for template literal or variable after operator
    if (/`[^`]*\$\{/.test(line) || /\bvar\b|\blet\b|\bconst\b/.test(line)) {
      score += 3;
    }
    // Also check for direct variable usage (no template literal)
    // e.g., 'notEq: `${someVar}`' has a variable in template
    if (/\$[a-zA-Z_][a-zA-Z0-9_]*/.test(line)) {
      score += 3;
    }
  }

  // Check if inside a function matching the query path
  var queryPath = finding.path;
  if (queryPath) {
    // Try to get file content and check function context
    try {
      var content = fs.readFileSync(match.file, 'utf8');
      if (isInsideMatchingFunction(content, queryPath, match.lineNumber)) {
        score += 3;
      }
    } catch (e) {
      // Can't read file, skip this check
    }
  }

  // Count additional pattern hits for +1 each
  var patternHits = 0;
  for (var i = 0; i < allPatterns.length; i++) {
    if (allPatterns[i] !== matchedPattern && line.indexOf(allPatterns[i]) !== -1) {
      patternHits++;
    }
  }
  score += patternHits;

  return score;
}

/**
 * Get package.json dependencies as { name: version } map.
 */
function getPackageDependencies(targetRoot) {
  var pkgPath = path.join(targetRoot, 'package.json');
  var deps = {};
  try {
    var content = fs.readFileSync(pkgPath, 'utf8');
    var pkg = JSON.parse(content);

    var sources = ['dependencies', 'devDependencies', 'peerDependencies'];
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      if (pkg[source]) {
        var keys = Object.keys(pkg[source]);
        for (var j = 0; j < keys.length; j++) {
          var name = keys[j];
          var version = pkg[source][name];
          if (version && !/^[\^~>=<]/.test(version)) {
            deps[name] = version;
          }
        }
      }
    }
  } catch (err) {
    deps = {};
  }
  // Prefer exact installed versions from the lockfile for anything that was
  // pinned with a range in package.json.
  var lockVersions = getLockfileVersions(targetRoot);
  var lockKeys = Object.keys(lockVersions);
  for (var li = 0; li < lockKeys.length; li++) {
    deps[lockKeys[li]] = lockVersions[lockKeys[li]];
  }
  return deps;
}

/**
 * Protected paths the locator must never search or read.
 */
var PROTECTED_PATHS = [
  'manifest/acceptance-manifest.v0.4.json',
  'manifest/inputs-registry.json',
  'evaluation-demo/migration-input'
];

function isProtectedPath(absPath) {
  var norm = path.normalize(absPath).replace(/\\/g, '/');
  for (var i = 0; i < PROTECTED_PATHS.length; i++) {
    var p = PROTECTED_PATHS[i];
    if (norm === p || norm.indexOf('/' + p) !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * Parse finding.stack into [{ file, line }] frames.
 * Accepts a string stack trace or an array of { file, line } objects.
 */
function extractStackFrames(finding) {
  if (!finding || !finding.stack) return [];
  var frames = [];
  var stack = finding.stack;
  if (typeof stack === 'string') {
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var match = /\(([^()]+):(\d+):\d+\)/.exec(lines[i]) ||
        /^\s*at\s+([^:]+):(\d+):\d+/.exec(lines[i]) ||
        /([^\s()]+\.(?:js|mjs|ts|cjs)):(\d+)/.exec(lines[i]);
      if (match) {
        frames.push({ file: match[1], line: parseInt(match[2], 10) });
      }
    }
  } else if (Array.isArray(stack)) {
    for (var j = 0; j < stack.length; j++) {
      var f = stack[j];
      if (f && f.file && f.line) {
        frames.push({ file: String(f.file), line: parseInt(f.line, 10) });
      }
    }
  }
  return frames;
}

/**
 * Resolve a stack frame file path against targetRoot or the repo root,
 * falling back to interpreting it as an absolute path.
 */
function isSecretsName(absPath) {
  var base = path.basename(absPath);
  if (/^\.env\b/.test(base)) return true;
  if (/\.pem$/.test(base)) return true;
  if (/^id_/.test(base)) return true;
  return false;
}

/**
 * Resolve a stack frame file path against targetRoot or the repo root,
 * falling back to interpreting it as an absolute path.
 * Rejects: path traversal (..), protected paths, .git dirs, secrets names,
 * paths resolving outside the respective root.
 */
function resolveFramePath(frameFile, targetRoot, repoRoot) {
  if (!frameFile) return null;
  if (frameFile.indexOf('..') !== -1) return null;

  var roots = [];
  if (targetRoot) roots.push({ root: targetRoot, label: 'target' });
  if (repoRoot) roots.push({ root: repoRoot, label: 'pipeline' });

  for (var i = 0; i < roots.length; i++) {
    var r = roots[i];
    var abs = path.resolve(r.root, frameFile);

    var realAbs;
    try { realAbs = fs.realpathSync(abs); }
    catch (e) {
      // non-existent or broken symlink — skip
      return null;
    }

    var realNorm = realAbs.replace(/\\/g, '/');
    var rootNorm = r.root.replace(/\\/g, '/');

    if (!realNorm.startsWith(rootNorm + '/') && realNorm !== rootNorm) {
      continue;
    }
    if (realNorm.includes('/.git/') || realNorm.endsWith('/.git')) return null;
    if (isSecretsName(realAbs)) return null;
    if (isProtectedPath(realAbs)) return null;

    try { if (fs.statSync(realAbs).isFile()) return realAbs; } catch (e) { /* skip */ }
  }

  if (path.isAbsolute(frameFile)) {
    var absRaw = path.resolve(frameFile);
    var realRaw;
    try { realRaw = fs.realpathSync(absRaw); }
    catch (e) { return null; }
    var realRawNorm = realRaw.replace(/\\/g, '/');
    if (realRawNorm.includes('/.git/') || realRawNorm.endsWith('/.git')) return null;
    if (isSecretsName(realRaw)) return null;
    if (isProtectedPath(realRaw)) return null;
    try { if (fs.statSync(realRaw).isFile()) return realRaw; } catch (e) { /* skip */ }
  }

  return null;
}

/**
 * Context lines around a line number with a caller-specified window.
 */
function getWideContextLines(filePath, targetLine, before, after) {
  var lines = [];
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    var all = content.split('\n');
    var start = Math.max(0, targetLine - 1 - before);
    var end = Math.min(all.length - 1, targetLine - 1 + after);
    for (var i = start; i <= end; i++) {
      lines.push({ line: all[i], lineNumber: i + 1 });
    }
  } catch (e) {
    return [];
  }
  return lines;
}

/**
 * Walk up from __dirname to find the repository root (a dir containing
 * both src/ and pipeline/).
 */
function findRepoRoot() {
  var dir = path.resolve(__dirname);
  for (var i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pipeline')) && fs.existsSync(path.join(dir, 'src'))) {
      return dir;
    }
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read exact installed versions from the target's lockfile (package-lock.json),
 * covering both the legacy dependencies map and the packages map.
 */
function getLockfileVersions(targetRoot) {
  var versions = {};
  var lockPath = path.join(targetRoot, 'package-lock.json');
  try {
    var lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    var deps = lock.dependencies || {};
    var depKeys = Object.keys(deps);
    for (var i = 0; i < depKeys.length; i++) {
      if (deps[depKeys[i]] && deps[depKeys[i]].version) {
        versions[depKeys[i]] = deps[depKeys[i]].version;
      }
    }
    var packages = lock.packages || {};
    var pkgKeys = Object.keys(packages);
    for (var j = 0; j < pkgKeys.length; j++) {
      var name = pkgKeys[j].replace(/^node_modules\//, '');
      if (name && name.indexOf('/') === -1 && packages[pkgKeys[j]] && packages[pkgKeys[j]].version &&
          !versions[name]) {
        versions[name] = packages[pkgKeys[j]].version;
      }
    }
  } catch (e) {
    return {};
  }
  return versions;
}

/**
 * Collect files for the pattern search: target src/, migrations/, config
 * files, package.json and (for domain=pipeline) this repo's src/ and
 * pipeline/, always skipping protected paths.
 */
function addConfigFiles(targetRoot, targets, searched) {
  try {
    var entries = fs.readdirSync(targetRoot, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var full = path.join(targetRoot, e.name);
      if (e.isFile() && /\.config\.(?:js|cjs|mjs|ts|json)$/.test(e.name)) {
        if (searched.indexOf(full) === -1) {
          targets.push(full);
          searched.push(full);
        }
      } else if (e.isDirectory() && e.name === 'config') {
        var found = findSourceFiles(full, searched);
        for (var j = 0; j < found.length; j++) {
          targets.push(found[j]);
        }
      }
    }
  } catch (err) { /* ignore unreadable dirs */ }
}

function collectSearchTargets(targetRoot, finding, searched) {
  var targets = [];
  // Target src/
  var srcDir = path.join(targetRoot, 'src');
  if (fs.existsSync(srcDir)) {
    targets = targets.concat(findSourceFiles(srcDir, searched));
  }
  // Migrations dir
  var migrationsDir = path.join(targetRoot, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    targets = targets.concat(findSourceFiles(migrationsDir, searched));
  }
  // Config files and config/ dir
  addConfigFiles(targetRoot, targets, searched);
  // package.json itself
  var pkgJson = path.join(targetRoot, 'package.json');
  try {
    if (fs.statSync(pkgJson).isFile() && searched.indexOf(pkgJson) === -1) {
      targets.push(pkgJson);
      searched.push(pkgJson);
    }
  } catch (e) { /* no package.json */ }
  // For domain=pipeline, also search THIS repo's src/ and pipeline/.
  if (finding && finding.domain === 'pipeline') {
    var repoRoot = findRepoRoot();
    if (repoRoot) {
      ['src', 'pipeline'].forEach(function(sub) {
        var dir = path.join(repoRoot, sub);
        if (!fs.existsSync(dir)) return;
        var found = findSourceFiles(dir, []);
        for (var i = 0; i < found.length; i++) {
          if (isProtectedPath(found[i])) continue;
          targets.push(found[i]);
          if (searched.indexOf(found[i]) === -1) searched.push(found[i]);
        }
      });
    }
  }
  return targets;
}

/**
 * Default fetchPackage implementation using npm pack.
 * Extracts into a NEW EMPTY dir under the run workspace.
 * NEVER runs any code from the package.
 */
function defaultFetchPackage(name, version, workspaceDir) {
  return new Promise(function(resolve, reject) {
    var extractDir = path.join(workspaceDir, 'pkg-' + name.replace('/', '_') + '-' + Date.now());
    ensureDir(extractDir);

    // npm pack name@version --ignore-scripts
    var args = ['pack', name + '@' + version, '--ignore-scripts'];
    childProcess.execFile('npm', args, { timeout: 60000 }, function(error, stdout, stderr) {
      if (error) {
        reject(new Error('npm pack failed: ' + error.message));
        return;
      }

      // stdout contains the tarball name
      var tarballName = (stdout || '').trim();
      if (!tarballName || !tarballName.endsWith('.tgz')) {
        reject(new Error('npm pack produced invalid tarball: ' + tarballName));
        return;
      }

      // Check for path traversal in tarball name
      if (tarballName.indexOf('..') !== -1 || tarballName.indexOf('/') !== -1) {
        reject(new Error('Path traversal detected in tarball name'));
        return;
      }

      var tarballPath = path.resolve(process.cwd(), tarballName);

      // Check for path traversal in tarball contents before extraction
      if (hasPathTraversal(tarballPath, extractDir)) {
        // Clean up tarball
        try { fs.unlinkSync(tarballPath); } catch (e) { /* ignore */ }
        reject(new Error('Path traversal detected in tarball contents'));
        return;
      }

      // Extract using tar
      childProcess.execFile('tar', ['-xzf', tarballPath, '-C', extractDir], function(tarError) {
        // Clean up tarball
        try { fs.unlinkSync(tarballPath); } catch (e) { /* ignore */ }

        if (tarError) {
          reject(new Error('tar extraction failed: ' + tarError.message));
          return;
        }

        // Find the package directory (npm pack creates package/)
        var packageDir = path.join(extractDir, 'package');
        if (!fs.existsSync(packageDir)) {
          // Some packages have different structure
          var entries = fs.readdirSync(extractDir);
          for (var i = 0; i < entries.length; i++) {
            var entry = path.join(extractDir, entries[i]);
            try {
              var stats = fs.statSync(entry);
              if (stats.isDirectory()) {
                packageDir = entry;
                break;
              }
            } catch (e) { /* ignore */ }
          }
        }

        resolve(packageDir);
      });
    });
  });
}

/**
 * Check for path traversal in tarball contents.
 * Returns true if traversal detected.
 */
function hasPathTraversal(tarballPath, extractDir) {
  try {
    // List contents of tarball
    var listing = childProcess.spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
    if (listing.status !== 0) {
      return false; // Can't read tar, assume safe
    }

    var files = (listing.stdout || '').split('\n');
    var resolvedExtract = path.resolve(extractDir);

    for (var i = 0; i < files.length; i++) {
      var file = files[i].trim();
      if (!file) continue;

      // Check for path traversal patterns
      if (file.indexOf('..') !== -1 || file.startsWith('/')) {
        return true;
      }

      // Check if extracted file would be outside extractDir
      var fullPath = path.resolve(extractDir, file);
      if (!fullPath.startsWith(resolvedExtract + path.sep) && fullPath !== resolvedExtract) {
        return true;
      }
    }
  } catch (e) {
    // If we can't check, assume safe
  }
  return false;
}

/**
 * Main locator function.
 * Searches targetRoot/src and optionally package dependencies for code patterns
 * related to a finding, scoring and ranking candidates.
 */
async function locateCandidates(options) {
  var finding = options.finding;
  var targetRoot = options.targetRoot;
  var fetchPackage = options.fetchPackage || function(name, version, dir) {
    return defaultFetchPackage(name, version, dir);
  };
  var maxCandidates = options.maxCandidates || DEFAULT_MAX_CANDIDATES;
  var runId = options.runId || ('locator-' + Date.now());
  var workspaceDir = options.workspaceDir || process.cwd();
  // Evidence root is passed through from the orchestrator (cfg.cwd + EVIDENCE_DIR)
  // so locator evidence is written to the same tree as finding.json and never
  // silently depends on process.cwd().
  var evidenceRoot = options.evidenceRoot || EVIDENCE_ROOT;

  var candidates = [];
  var searched = [];
  var packageNotes = [];

  if (!finding || !targetRoot) {
    return { candidates: candidates, searched: searched };
  }

  var patterns = deriveSearchPatterns(finding);
  var frames = extractStackFrames(finding);

  // (1) Stack-driven search: load the frame files first with a wide (+-30 line)
  // context window.  The observed failure sites rank above pattern-only hits.
  if (frames.length > 0) {
    var repoRoot = findRepoRoot();
    for (var fi = 0; fi < frames.length; fi++) {
      var frame = frames[fi];
      var frameFile = resolveFramePath(frame.file, targetRoot, repoRoot);
      if (!frameFile || isProtectedPath(frameFile)) {
        continue;
      }
      var frameContext = getWideContextLines(frameFile, frame.line, 30, 30);
      if (frameContext.length === 0) {
        continue;
      }
      candidates.push({
        source: 'stack',
        package: null,
        file: frameFile,
        line: frame.line,
        snippet: frameContext,
        score: 1000 - fi,
        reasons: ['finding.stack frame'],
        why: 'frame in finding.stack at ' + frameFile + ':' + frame.line
      });
    }
  }

  if (patterns.length === 0) {
    return { candidates: candidates, searched: searched };
  }

  // (2)+(3)+(4) Pattern search over src/, migrations/, config files,
  // package.json and (for domain=pipeline) this repo's src/ and pipeline/.
  var searchTargets = collectSearchTargets(targetRoot, finding, searched);
  for (var st = 0; st < searchTargets.length; st++) {
    var filePath = searchTargets[st];
    var matches = searchFileForPatterns(filePath, patterns);

    for (var mj = 0; mj < matches.length; mj++) {
      var match = matches[mj];
      var context = getContextLines(filePath, match.lineNumber, match.matchedPattern);
      var score = scoreMatch({ line: match.line, lineNumber: match.lineNumber, matchedPattern: match.matchedPattern, file: filePath }, finding, patterns);

      candidates.push({
        source: 'target',
        package: null,
        file: filePath,
        line: match.lineNumber,
        snippet: context.snippet,
        score: score,
        reasons: [match.matchedPattern],
        why: 'pattern "' + match.matchedPattern + '" matched in ' + filePath + ':' + match.lineNumber
      });
    }
  }

  // Sort by score descending
  candidates.sort(function(a, b) { return b.score - a.score; });

  // Check if we have a strong match (score >= 6)
  var hasStrongMatch = candidates.length > 0 && (candidates[0].score >= 6 || candidates[0].source === 'stack');

  // If no strong match, search in package dependencies
  if (!hasStrongMatch) {
    var deps = getPackageDependencies(targetRoot);
    var depNames = Object.keys(deps);

    // Create a temporary workspace dir for package extraction
    var pkgWorkspace = path.join(workspaceDir, 'locator-packages-' + Date.now());
    ensureDir(pkgWorkspace);

    for (var k = 0; k < depNames.length; k++) {
      var pkgName = depNames[k];
      var pkgVersion = deps[pkgName];

      try {
        var pkgPath = await fetchPackage(pkgName, pkgVersion, pkgWorkspace);

        // A fetchPackage that resolves to an HTTP Response (e.g. the npm
        // registry or a private mirror) rather than a directory: a 4xx means
        // the package is missing or not accessible. Record candidate-not-found
        // and keep searching; never block on a single package.
        if (pkgPath && typeof pkgPath.status === 'number') {
          var respStatus = pkgPath.status;
          var respKind = (respStatus === 404) ? 'not-found'
            : (respStatus === 401 || respStatus === 403) ? 'unavailable'
            : 'failed';
          packageNotes.push({
            package: pkgName + '@' + pkgVersion,
            status: 'candidate-not-found',
            kind: respKind,
            reason: 'package fetch resolved to HTTP ' + respStatus
          });
          continue;
        }

        // Materialize the fetched package into the clone so the candidate
        // paths survive the temp-workspace cleanup below and the prompt can
        // point at real files in the clone's node_modules.
        var nodeModulesPkgDir = path.join(targetRoot, 'node_modules', pkgName);
        try {
          fs.mkdirSync(nodeModulesPkgDir, { recursive: true });
        } catch (e) { /* fall through: report below */ }
        if (pkgPath && typeof pkgPath === 'string' && fs.existsSync(pkgPath)) {
          try {
            copyDirContents(pkgPath, nodeModulesPkgDir);
          } catch (e) { /* skip */ }
        }

        // Search in the materialized package (clone-relative paths), avoiding
        // node_modules nested inside packages.
        var searchInPackage = function(dir) {
          var found = [];
          try {
            var entries = fs.readdirSync(dir, { withFileTypes: true });
            for (var idx = 0; idx < entries.length; idx++) {
              var entry = entries[idx];
              var full = path.join(dir, entry.name);

              if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                  continue;
                }
                found = found.concat(searchInPackage(full));
              } else if (entry.isFile()) {
                if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
                  try {
                    var stats = fs.statSync(full);
                    if (stats.size <= MAX_FILE_SIZE) {
                      var pkgMatches = searchFileForPatterns(full, patterns);
                      for (var m = 0; m < pkgMatches.length; m++) {
                        var pkgMatch = pkgMatches[m];
                        var pkgContext = getContextLines(full, pkgMatch.lineNumber, pkgMatch.matchedPattern);
                        var pkgScore = scoreMatch({ line: pkgMatch.line, lineNumber: pkgMatch.lineNumber, matchedPattern: pkgMatch.matchedPattern, file: full }, finding, patterns);
                        var relFile = path.relative(targetRoot, full).replace(/\\/g, '/');

                        found.push({
                          source: 'dependency',
                          package: pkgName + '@' + pkgVersion,
                          file: relFile,
                          line: pkgMatch.lineNumber,
                          snippet: pkgContext.snippet,
                          score: pkgScore,
                          reasons: [pkgMatch.matchedPattern],
                          why: 'pattern "' + pkgMatch.matchedPattern + '" matched in dependency ' + pkgName + '@' + pkgVersion
                        });
                        if (searched.indexOf(relFile) === -1) {
                          searched.push(relFile);
                        }
                      }
                    }
                  } catch (e) { /* skip */ }
                }
              }
            }
          } catch (e) { /* skip */ }
          return found;
        };

        var pkgResults = searchInPackage(nodeModulesPkgDir);
        candidates = candidates.concat(pkgResults);
      } catch (err) {
        // Package fetch failed (e.g. npm 404/401 for a missing or private
        // package): record candidate-not-found and keep searching. This must
        // never block the locator.
        packageNotes.push({
          package: pkgName + '@' + pkgVersion,
          status: 'candidate-not-found',
          kind: classifyPackageFetchError(err),
          reason: 'package could not be fetched'
        });
      }
    }

    // Re-sort after adding package candidates
    candidates.sort(function(a, b) { return b.score - a.score; });

    // Clean up package workspace
    try {
      fs.rmSync(pkgWorkspace, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }

  // Filter to top maxCandidates
  candidates = candidates.slice(0, maxCandidates);

  // Write evidence file
  var evidenceDir = path.join(evidenceRoot, runId, 'repair');
  ensureDir(evidenceDir);

  var evidenceData = {
    runId: runId,
    finding: finding,
    patterns: patterns,
    candidateNotFound: packageNotes,
    candidates: candidates.map(function(c) {
      return {
        source: c.source,
        package: c.package,
        file: c.file,
        line: c.line,
        snippet: null,
        score: c.score,
        reasons: c.reasons
      };
    }),
    searched: searched,
    timestamp: new Date().toISOString()
  };

  var evidenceJson = JSON.stringify(evidenceData, null, 2);
  var sha = sha256Hex(evidenceJson);

  var evidenceFile = path.join(evidenceDir, 'candidates.json');
  fs.writeFileSync(evidenceFile, evidenceJson, 'utf8');

  // Also write sha256 file
  fs.writeFileSync(path.join(evidenceDir, 'candidates.json.sha256'), sha, 'utf8');

  return { candidates: candidates, searched: searched, notFound: packageNotes };
}

function classifyPackageFetchError(err) {
  var text = String((err && err.message) || err || '');
  if (/E404|\b404\b|not found/i.test(text)) return 'not-found';
  if (/E401|\b401\b|E403|\b403\b|unauthor|forbidden|access/i.test(text)) return 'unavailable';
  return 'failed';
}

module.exports = { locateCandidates: locateCandidates };
