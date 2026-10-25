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
 * Generated/type/list files must never become candidates: *.d.ts, gql
 * generated or graphql-env*, dist/, build/, lock files, *.map, and test
 * fixtures. These are low-signal and drown the pattern search.
 */
var EXCLUDED_DIR_RE = /(^|\/)(node_modules|\.git|dist|build|generated|gql\/generated|__fixtures__|fixtures|test-fixtures)\//;
var EXCLUDED_FILE_RE = /\.d\.ts$|\.map$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|.*\.lock)$|graphql-env/;
function isGeneratedOrTypeFile(absPath) {
  if (!absPath) return false;
  var norm = String(absPath).replace(/\\/g, '/');
  if (EXCLUDED_DIR_RE.test(norm)) return true;
  if (EXCLUDED_FILE_RE.test(norm)) return true;
  if (/graphql-env\.d\.ts$/.test(norm)) return true;
  return false;
}

/**
 * Generic GraphQL pagination/list words that are never useful as search terms
 * (they appear in every query/args object and would flood the search).
 */
function graphQlFieldStoplist() {
  return ['take', 'skip', 'items', 'item', 'options', 'args', 'input', 'filter',
    'sort', 'orderBy', 'page', 'pages', 'limit', 'offset', 'first', 'last',
    'after', 'before', 'cursor', 'nodes', 'node', 'edges', 'edge', 'totalItems',
    'results', 'list', 'array', 'enable', 'enabled', 'id', 'ids', 'name', 'title'];
}

/**
 * Determine the failing GraphQL field from the finding. Priority:
 *  (1) finding.path (a string or an array path, last segment when array)
 *  (2) "path:<field>" embedded in the finding's message
 *  (3) falling back to finding.sql/path when present
 * Sets finding.path when it is null/undefined but derivable from the message.
 */
function failingField(finding) {
  if (!finding) return null;
  var pathVal = null;
  if (typeof finding.path === 'string' && finding.path !== '' && finding.path !== 'undefined' && finding.path !== 'null') {
    pathVal = finding.path;
  } else if (Array.isArray(finding.path) && finding.path.length > 0) {
    pathVal = finding.path[finding.path.length - 1];
  }
  if (!pathVal) {
    // "path:products" or "path: ['products']" style hints in the message.
    var msg = (typeof finding.message === 'string') ? finding.message : '';
    var m = msg.match(/path:\s*\[?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\]?/);
    if (m) pathVal = m[1];
    if (!pathVal) {
      var m2 = msg.match(/"(?:path|field)"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/);
      if (m2) pathVal = m2[1];
    }
    if (pathVal && (finding.path == null || finding.path === 'undefined')) {
      try { finding.path = pathVal; } catch (e) { /* ignore */ }
    }
  }
  if (pathVal && typeof pathVal === 'string') {
    return pathVal.split('.').pop(); // last segment of a dotted path
  }
  return null;
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
  var rootFields = Array.isArray(finding.rootFields) ? finding.rootFields : [];
  // The signature extractor nests parsed SQL under finding.sql; fall back to it.
  if (!operator && finding.sql && finding.sql.operator) operator = finding.sql.operator;
  if (!column && finding.sql && finding.sql.column) column = finding.sql.column;

  if (operator && column) {
    var colName = toText(column).split('.').pop();
    if (operator === '!=') {
      patterns.push('notEq');
      patterns.push('!= :');
      patterns.push('"' + colName + '" !="');
      patterns.push("'" + colName + "' !=");
      patterns.push('Not(');
      patterns.push('.not(');
      patterns.push('ne:');
    }
    if (operator === 'IS NOT NULL' || operator === 'IS NULL') {
      patterns.push('isNull');
      patterns.push('isNotNull');
    }
    if (operator === '>' || operator === '<' || operator === '>=' || operator === '<=') {
      patterns.push('gt:');
      patterns.push('lt:');
      patterns.push('gte:');
      patterns.push('lte:');
    }
  }

  // Use ONLY the failing field from the finding's error path, never every field
  // that appeared in the query. Generic GraphQL pagination/list words (take,
  // skip, items, options, ...) are dropped via the stoplist below.
  var field = failingField(finding);
  if (field && graphQlFieldStoplist().indexOf(field) === -1 && field.length >= 2) {
    if (patterns.indexOf(field) === -1) patterns.push(field);
    if (patterns.indexOf(field + 'Resolver') === -1) patterns.push(field + 'Resolver');
    if (patterns.indexOf(field + 'Service') === -1) patterns.push(field + 'Service');
    if (patterns.indexOf(field + 'Query') === -1) patterns.push(field + 'Query');
  } else if (queryPath && typeof queryPath === 'string' && queryPath.length > 0 && queryPath !== 'undefined' && graphQlFieldStoplist().indexOf(queryPath) === -1) {
    if (patterns.indexOf(queryPath) === -1) patterns.push(queryPath);
    if (patterns.indexOf(queryPath + 'Resolver') === -1) patterns.push(queryPath + 'Resolver');
    if (patterns.indexOf(queryPath + 'Service') === -1) patterns.push(queryPath + 'Service');
    if (patterns.indexOf(queryPath + 'Query') === -1) patterns.push(queryPath + 'Query');
  } else {
    // Fall back to real query root fields, still filtering the stoplist.
    for (var rf = 0; rf < rootFields.length; rf++) {
      var fld = rootFields[rf];
      if (!fld || graphQlFieldStoplist().indexOf(fld) !== -1 || fld.length < 2) continue;
      if (patterns.indexOf(fld) === -1) patterns.push(fld);
      if (patterns.indexOf(fld + 'Resolver') === -1) patterns.push(fld + 'Resolver');
      if (patterns.indexOf(fld + 'Service') === -1) patterns.push(fld + 'Service');
      if (patterns.indexOf(fld + 'Query') === -1) patterns.push(fld + 'Query');
    }
  }

  // When no field is available, fall back to stack-frame names and operationName.
  if ((!queryPath || queryPath === 'undefined') && !field) {
    var stack = finding.stack;
    var frames = Array.isArray(stack) ? stack : [];
    for (var fi = 0; fi < frames.length; fi++) {
      var f = frames[fi];
      if (!f) continue;
      var file = f.file ? String(f.file).replace(/\\/g, '/') : '';
      if (file.indexOf('node_modules/') !== -1) continue;
      if (file.indexOf('node:') === 0) continue;
      var fn = f.fn ? String(f.fn) : '';
      var fnName = fn.split(/[.(]/)[0] || '';
      if (fnName && fnName.length >= 2 && ['async', 'at', 'module'].indexOf(fnName) === -1) {
        if (patterns.indexOf(fnName) === -1) patterns.push(fnName);
      }
      var base = path.posix.basename(file).replace(/\.(ts|js|mjs|cjs)$/, '');
      if (base && base.length >= 2 && patterns.indexOf(base) === -1) {
        patterns.push(base);
      }
    }
    if (typeof finding.operationName === 'string' && finding.operationName.length > 0) {
      var opName = finding.operationName.trim();
      if (patterns.indexOf(opName) === -1) patterns.push(opName);
      if (patterns.indexOf(opName + 'Resolver') === -1) patterns.push(opName + 'Resolver');
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
 * Get context lines (±15 around the hit line) for snippet display.
 * The model sees real code around each hit, not just the matching line.
 */
function getContextLines(filePath, targetLine, matchedPattern) {
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    var lines = content.split('\n');
    var CONTEXT_LINES = 30;
    var startLine = Math.max(0, targetLine - 1 - CONTEXT_LINES); // 30 lines before
    var endLine = Math.min(lines.length - 1, targetLine - 1 + CONTEXT_LINES); // 30 lines after
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
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.git' || entry.name === '__fixtures__' || entry.name === 'fixtures') {
          continue;
        }
        files = files.concat(findSourceFiles(fullPath, searched));
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
          if (isGeneratedOrTypeFile(fullPath)) continue;
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
  var operator = finding.operator;
  if (!operator && finding.sql && finding.sql.operator) operator = finding.sql.operator;
  // e.g., != `${someVar}`, != someVar, or != otherId
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

  // If path has a query name and this line is inside a function matching it
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

  // Bonus: a candidate whose file contains BOTH a graphql root field name (or
  // the query path) AND an operator idiom within ~60 lines ranks above single
  // matches. This captures the resolver that implements the failing field with
  // the failing filter idiom (field name + operator idiom together).
  var opIdioms = ['notEq', 'Equals(', 'Not(', '.not(', 'isNull', 'isNotNull', 'gt:', 'lt:', 'gte:', 'lte:', 'ne:'];

  var hasFieldText = false;
  var fieldNames = [];
  if (Array.isArray(finding.rootFields)) {
    for (var rf = 0; rf < finding.rootFields.length; rf++) {
      if (finding.rootFields[rf]) fieldNames.push(String(finding.rootFields[rf]));
    }
  }
  if (queryPath && fieldNames.indexOf(queryPath) === -1) fieldNames.push(String(queryPath));

  var hasOpIdiom = opIdioms.some(function(o) { return line.indexOf(o) !== -1; });

  if (fieldNames.length > 0 && !hasOpIdiom) {
    try {
      var fileContent = fs.readFileSync(match.file, 'utf8').split('\n');
      var startLine = Math.max(0, match.lineNumber - 61);
      var endLine = Math.min(fileContent.length - 1, match.lineNumber + 61);
      for (var li = startLine; li <= endLine; li++) {
        var liLine = fileContent[li];
        if (opIdioms.some(function(o) { return liLine.indexOf(o) !== -1; })) {
          score += 5;
          break;
        }
      }
      // Also for the field name appearing near an operator
      if (fieldNames.some(function(fn) { return line.indexOf(fn) !== -1; })) {
        score += 4;
      }
    } catch (e) { /* skip */ }
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
 * A candidate is a "strong match" (which skips the dependency search) only when
 * it is a stack frame, OR the file contains BOTH an operator-idiom hit and the
 * failing GraphQL field name within ~60 lines of the matched line. A pure
 * field-name-only hit is NEVER strong.
 */
var OPERATOR_IDIOMS = ['notEq', 'Equals(', 'Not(', '.not(', 'isNull', 'isNotNull', 'gt:', 'lt:', 'gte:', 'lte:', 'ne:', '!= :'];
function isStrongCandidate(finding, candidate) {
  if (!candidate) return false;
  if (candidate.source === 'stack') return true;
  if (candidate.source === 'dependency') return true; // dependency candidates are explicit
  var field = failingField(finding);
  if (!field) return false;
  if (!candidate.file) return false;
  var content;
  try {
    content = fs.readFileSync(candidate.file, 'utf8');
  } catch (e) {
    return false;
  }
  var contentLines = content.split('\n');
  var fieldAt = [];
  var idiomAt = [];
  for (var li = 0; li < contentLines.length; li++) {
    var l = contentLines[li];
    var toks = (field + 'Resolver,' + field + 'Service,' + field + 'Query,' + field).split(',');
    var fieldHit = toks.some(function(t) { return l.indexOf(t) !== -1; });
    if (fieldHit && fieldAt.indexOf(li) === -1) fieldAt.push(li);
    if (OPERATOR_IDIOMS.some(function(o) { return l.indexOf(o) !== -1; })) {
      if (idiomAt.indexOf(li) === -1) idiomAt.push(li);
    }
  }
  if (fieldAt.length === 0 || idiomAt.length === 0) return false;
  var anchor = (candidate.line || 1) - 1;
  for (var f = 0; f < fieldAt.length; f++) {
    for (var g = 0; g < idiomAt.length; g++) {
      if (Math.abs(fieldAt[f] - idiomAt[g]) <= 60) return true;
    }
  }
  void anchor;
  return false;
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

function addConfigBuildingCandidates(targetRoot, finding, candidates, searched) {
  if (!targetRoot) return;
  var dirs = [];
  var srcDir = path.join(targetRoot, 'src');
  if (fs.existsSync(srcDir)) dirs.push(srcDir);
  var cfgRoot = path.join(targetRoot, 'config');
  if (fs.existsSync(cfgRoot)) dirs.push(cfgRoot);
  var scanned = [];
  var seen = {};
  var configCount = 0;
  var MAX_CONFIG_CANDIDATES = 2;
  var CONFIG_CANDIDATE_SCORE = 5; // below stack (1000) and typical matched-dependency scores
  for (var d = 0; d < dirs.length && configCount < MAX_CONFIG_CANDIDATES; d++) {
    var files = [];
    try {
      files = findSourceFiles(dirs[d], []);
    } catch (e) { /* ignore */ }
    for (var i = 0; i < files.length && configCount < MAX_CONFIG_CANDIDATES; i++) {
      var fp = files[i];
      var rel2 = path.relative(targetRoot, fp).replace(/\\/g, '/');
      if (seen[rel2]) continue;
      seen[rel2] = true;
      var rel2full = rel2;
      var content;
      try {
        content = fs.readFileSync(fp, 'utf8');
      } catch (e2) { /* ignore */ }
      if (content == null) continue;
      // Never offer generated, migration, test, or .d.ts files as config
      // candidates: they are low-signal and would displace matched code.
      if (isExcludedConfigPath(rel2full)) continue;
      // Detect config-building content: a plugins array, a config object, or an
      // import/require of any dependency matched by the finding. This is generic
      // and never mentions a concrete filename.
      var isConfig = /plugins\s*:\s*\[/.test(content) ||
        /VendureConfig\b/.test(content) || /createServer\s*\(/.test(content) ||
        /\bconfig\s*=\s*\{/.test(content) || /\bregister\s*\(/.test(content);
      if (!isConfig && /from\s+['"]|require\s*\(\s*['"]/.test(content)) {
        // A module that imports external packages is a plausible registration
        // site for a fix (e.g. it may already import the plugin being fixed).
        isConfig = true;
      }
      if (!isConfig) continue;
      if (rel2full === '') continue;
      if (searched && searched.indexOf(rel2full) === -1) searched.push(rel2full);
      var snippet = []
      try {
        var ctx = getContextLines(fp, 1, null);
        snippet = (ctx && ctx.snippet) || ctx || [];
      } catch (e3) { snippet = []; }
      candidates.push({
        source: 'config',
        package: null,
        file: rel2full,
        line: 1,
        snippet: snippet,
        score: CONFIG_CANDIDATE_SCORE,
        reasons: ['config-building registration site'],
        why: 'tracked config/registration file that builds the application configuration (plugins array / config object / dependency import)'
      });
      configCount++;
    }
  }
  return { candidates: candidates, scanned: scanned };
}

/**
 * True when a clone-relative path must never become a config candidate:
 * generated code (graphql.ts / *.generated.*), migration files, tests, and
 * type declarations (.d.ts). These low-signal paths were displacing real
 * code/dependency candidates in the live run.
 */
function isExcludedConfigPath(relPath) {
  if (!relPath) return true;
  var norm = String(relPath).replace(/\\/g, '/');
  if (/\.d\.ts$/.test(norm)) return true;
  // Generated code: a file named graphql.ts (live-run regression example) or
  // any file with a '.generated.' marker (e.g. api-client.generated.ts).
  if (/(^|\/)graphql\.ts$/.test(norm)) return true;
  if (/\.generated\./.test(norm)) return true;
  if (/generated/.test(norm) && /\.(ts|js|mjs|json)$/.test(norm)) return true;
  // Migrations: any directory whose name contains 'migration'.
  if (/(^|\/)[^/]*migration[^/]*\//.test(norm)) return true;
  // Tests: __tests__/, tests/ dirs or *.test.* / *.spec.* files.
  if (/(^|\/)(tests?|__tests__)\//.test(norm)) return true;
  if (/\.(test|spec)\.(js|ts|tsx|mjs)$/.test(norm)) return true;
  return false;
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
  var packageStatuses = [];

  if (!finding || !targetRoot) {
    writeCandidatesEvidence(runId, evidenceRoot, finding, [], candidates, searched, packageNotes, packageStatuses);
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
    writeCandidatesEvidence(runId, evidenceRoot, finding, patterns, candidates, searched, packageNotes, packageStatuses);
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

  // (3.5) Config-building registration files are ALWAYS candidates, even when
  // no pattern matched them. A plugin/route/middleware registration lives in a
  // config-style file (e.g. a `plugins: [...]` array, a VendureConfig-like
  // object, or a bootstrapping module) that the bug fix may need to edit. Those
  // files must be offered to the model regardless of pattern hits, so a
  // proposal touching the registration site is not rejected as
  // PROPOSAL_OUTSIDE_CANDIDATES. Detection is purely content-based (no
  // hard-coded filenames).
  addConfigBuildingCandidates(targetRoot, finding, candidates, searched);

  // Check if we have a strong match (score >= 6)
  // Strong match skips the dependency search. A candidate is strong only when
  // it is a stack frame, or its file contains BOTH an operator idiom and the
  // failing field within ~60 lines. A pure field-name hit is never strong.
  var hasStrongMatch = candidates.some(function(c) { return isStrongCandidate(finding, c); });

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
      var fetchStatus = { package: pkgName + '@' + pkgVersion, status: null, kind: null };

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
          fetchStatus.status = 'notFound';
          fetchStatus.kind = respKind;
          packageNotes.push({
            package: pkgName + '@' + pkgVersion,
            status: 'candidate-not-found',
            kind: respKind,
            reason: 'package fetch resolved to HTTP ' + respStatus
          });
          packageStatuses.push(fetchStatus);
          continue;
        }

        var pkgFetchedForReal = (pkgPath && typeof pkgPath === 'string' && fs.existsSync(pkgPath));
        fetchStatus.status = pkgFetchedForReal ? 'fetched' : 'alias-skipped';
        fetchStatus.kind = pkgFetchedForReal ? null : 'unavailable';
        packageStatuses.push(fetchStatus);

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
                        // Prefer packages whose source defines the failing-field
                        // resolver/extension AND the operator idiom together.
                        try {
                          if (isStrongCandidate(finding, { source: 'stack', file: full, score: pkgScore })) {
                            pkgScore += 8;
                          }
                        } catch (e) { /* ignore */ }

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
        // Mark per-package search outcome: matched if any candidate hit,
        // otherwise noMatch.
        if (pkgResults.length > 0) {
          fetchStatus.status = 'matched';
        } else if (fetchStatus.status === 'fetched') {
          fetchStatus.status = 'noMatch';
        }
      } catch (err) {
        // Package fetch failed (e.g. npm 404/401 for a missing or private
        // package): record candidate-not-found and keep searching. This must
        // never block the locator.
        fetchStatus.status = 'notFound';
        fetchStatus.kind = classifyPackageFetchError(err);
        packageStatuses.push(fetchStatus);
        packageNotes.push({
          package: pkgName + '@' + pkgVersion,
          status: 'candidate-not-found',
          kind: classifyPackageFetchError(err),
          reason: 'package could not be fetched'
        });
      }
    }

    // --- (b) .d.ts exclusion/penalization ---
    // Build a map of package -> set of base paths that have .js/.ts matches
    // Then exclude .d.ts candidates where .js exists in same package, or penalize heavily
    var pkgToBasePaths = {};
    for (var di = 0; di < candidates.length; di++) {
      var c = candidates[di];
      if (c.source !== 'dependency') continue;
      if (!c.file) continue;
      var isDts = /\.d\.ts$/.test(c.file);
      var base = c.file.replace(/\.d\.ts$/, '').replace(/\.(js|mjs|ts)$/, '');
      if (!pkgToBasePaths[c.package]) pkgToBasePaths[c.package] = { jsBases: {}, dtsOnly: [] };
      if (isDts) {
        pkgToBasePaths[c.package].dtsOnly.push(di);
      } else {
        pkgToBasePaths[c.package].jsBases[base] = true;
      }
    }
    for (var pkg in pkgToBasePaths) {
      var info = pkgToBasePaths[pkg];
      var dtsList = info.dtsOnly;
      for (var dti = 0; dti < dtsList.length; dti++) {
        var dtsIdx = dtsList[dti];
        var dtsCandidate = candidates[dtsIdx];
        var dtsBase = dtsCandidate.file.replace(/\.d\.ts$/, '').replace(/\.(js|mjs|ts)$/, '');
        if (info.jsBases[dtsBase]) {
          // .d.ts candidate has corresponding .js/.ts in same package -> exclude
          candidates[dtsIdx] = null;
        } else {
          // No corresponding source -> penalize heavily but keep
          candidates[dtsIdx].score -= 50;
          candidates[dtsIdx].reasons.push('dts-only (no corresponding source)');
        }
      }
    }
    candidates = candidates.filter(function(c) { return c !== null; });

    // --- (b2) Add src/ files that import dependency packages as candidates ---
    // When a bug is in node_modules/<pkg>, the fix may be a local-wrapper in src/
    // that imports/registers the dependency. Find src/ files that import each
    // dependency package we found and add them as candidates with snippets.
    if (candidates.length > 0) {
      // Collect unique dependency package names from candidates
      var depPkgs = {};
      for (var depIdx = 0; depIdx < candidates.length; depIdx++) {
        var c = candidates[depIdx];
        if (c.source === 'dependency' && c.package) {
          // c.package is like 'lodash@4.17.21', extract just 'lodash'
          var pkgBase = c.package.replace(/@[^@]+$/, '');
          depPkgs[pkgBase] = true;
        }
      }
      var depPkgNames = Object.keys(depPkgs);

      // If we found dependency packages, search src/ for files that import them
      if (depPkgNames.length > 0) {
        // Get list of src/ files to search
        var srcDir = path.join(targetRoot, 'src');
        var srcFiles = [];
        try {
          srcFiles = findSourceFiles(srcDir, []);
        } catch (e) { /* ignore */ }

        // For each package, find src/ files that import it
        for (var pi = 0; pi < depPkgNames.length; pi++) {
          var pkgName = depPkgNames[pi];
          // Build patterns to find imports of this package
          var importPatterns = [
            "require('" + pkgName + "')",
            'require("' + pkgName + '")',
            "from '" + pkgName + "'",
            'from "' + pkgName + '"',
            "import '" + pkgName + "'",
            'import "' + pkgName + '"',
            'register(\'' + pkgName + '\')',
            'register("' + pkgName + '")'
          ];

          for (var fi = 0; fi < srcFiles.length; fi++) {
            var srcFile = srcFiles[fi];
            // Skip if already a candidate (avoid duplicates)
            var alreadyCandidate = candidates.some(function(c) {
              return c.file === srcFile;
            });
            if (alreadyCandidate) continue;

            // Search for import patterns
            var matches = searchFileForPatterns(srcFile, importPatterns);
            if (matches.length > 0) {
              var context = getContextLines(srcFile, matches[0].lineNumber, matches[0].matchedPattern);
              var relFile = path.relative(targetRoot, srcFile).replace(/\\/g, '/');
              candidates.push({
                source: 'import',
                package: pkgName,
                file: relFile,
                line: matches[0].lineNumber,
                snippet: context.snippet,
                score: 50, // Moderate score - import site is relevant but not the bug site
                reasons: ['imports: ' + pkgName],
                why: 'src/ file that imports dependency ' + pkgName + ': ' + relFile + ':' + matches[0].lineNumber
              });
              // Add to searched list
              if (searched.indexOf(relFile) === -1) {
                searched.push(relFile);
              }
            }
          }
        }
      }
    }

    // --- (c) Per-package cap (stack package is exempt) ---
    // Identify the stack package from finding.stack (look for node_modules pattern)
    var stackPackage = null;
    if (finding && finding.stack) {
      var frames = Array.isArray(finding.stack) ? finding.stack : [];
      for (var si = 0; si < frames.length; si++) {
        var f = frames[si];
        if (!f || !f.file) continue;
        var fileStr = String(f.file).replace(/\\/g, '/');
        var nmMatch = fileStr.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)/);
        if (nmMatch) {
          stackPackage = nmMatch[1];
          break;
        }
      }
    }
    var MAX_PER_PKG = 2;
    var MAX_TOTAL_CANDIDATES = 8;
    var MIN_DEPENDENCY_SLOTS = 4; // always reserve >=4 slots for dep candidates

    // Split into dependency and non-dependency pools so the fixed cap never
    // lets low-signal config files displace matched dependency candidates.
    var depPool = [];
    var nonDepPool = [];
    for (var si2 = 0; si2 < candidates.length; si2++) {
      if (candidates[si2] && candidates[si2].source === 'dependency') {
        depPool.push(candidates[si2]);
      } else {
        nonDepPool.push(candidates[si2]);
      }
    }
    depPool.sort(function(a, b) { return b.score - a.score; });
    nonDepPool.sort(function(a, b) { return b.score - a.score; });

    // (c1) Select dependency candidates (per-package cap, stack package exempt)
    // up to MIN_DEPENDENCY_SLOTS so the highest-scoring always survives.
    var depPkgCounts = {};
    var selectedDep = [];
    for (var di = 0; di < depPool.length && selectedDep.length < MIN_DEPENDENCY_SLOTS; di++) {
      var dcand = depPool[di];
      var depPkg = dcand.package || '';
      var depPkgName = depPkg.replace(/@[^@]+$/, ''); // strip version
      if (depPkgName === stackPackage) {
        selectedDep.push(dcand);
      } else {
        depPkgCounts[depPkg] = (depPkgCounts[depPkg] || 0) + 1;
        if (depPkgCounts[depPkg] <= MAX_PER_PKG) {
          selectedDep.push(dcand);
        }
      }
    }

    // (c2) Non-dependency candidates fill the remaining slots, best score
    // first (so stack/log-derived candidates always beat config candidates).
    var finalCandidates = [];
    var nonDepSlots = MAX_TOTAL_CANDIDATES - selectedDep.length;
    for (var ndi = 0; ndi < nonDepPool.length && finalCandidates.length < nonDepSlots; ndi++) {
      finalCandidates.push(nonDepPool[ndi]);
    }
    finalCandidates = finalCandidates.concat(selectedDep);

    // (c3) Sort the merged set by score so the prompt sees the best first.
    finalCandidates.sort(function(a, b) { return b.score - a.score; });
    candidates = finalCandidates;

    // Clean up package workspace
    try {
      fs.rmSync(pkgWorkspace, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }

  // Filter to top maxCandidates
  candidates = candidates.slice(0, maxCandidates);

  // Write candidates.json evidence (always, even with no candidates).
  writeCandidatesEvidence(runId, evidenceRoot, finding, patterns, candidates, searched, packageNotes, packageStatuses);

  return { candidates: candidates, searched: searched, notFound: packageNotes };
}

function classifyPackageFetchError(err) {
  var text = String((err && err.message) || err || '');
  if (/E404|\b404\b|not found/i.test(text)) return 'not-found';
  if (/E401|\b401\b|E403|\b403\b|unauthor|forbidden|access/i.test(text)) return 'unavailable';
  return 'failed';
}

/**
 * Always write candidates.json (and its sha256) under evidenceRoot/<runId>/repair,
 * even when there are no candidates (NO_CANDIDATES). Includes the derived patterns
 * and per-package fetch status.
 */
function writeCandidatesEvidence(runId, evidenceRoot, finding, patterns, candidates, searched, packageNotes, packageStatuses) {
  var evidenceDir = path.join(evidenceRoot, runId, 'repair');
  ensureDir(evidenceDir);
  var evidenceData = {
    runId: runId,
    finding: finding,
    patterns: patterns || [],
    candidateNotFound: packageNotes || [],
    packageStatuses: packageStatuses || [],
    candidates: (candidates || []).map(function(c) {
      var snippetArr = c.snippet && Array.isArray(c.snippet) ? c.snippet : null;
      return {
        source: c.source,
        package: c.package,
        file: c.file,
        line: c.line,
        snippetLines: snippetArr ? snippetArr.length : 0,
        score: c.score,
        reasons: c.reasons
      };
    }),
    searched: searched || [],
    timestamp: new Date().toISOString()
  };
  var evidenceJson = JSON.stringify(evidenceData, null, 2);
  var sha = sha256Hex(evidenceJson);
  fs.writeFileSync(path.join(evidenceDir, 'candidates.json'), evidenceJson, 'utf8');
  fs.writeFileSync(path.join(evidenceDir, 'candidates.json.sha256'), sha, 'utf8');
}

function writeCapabilities(runId, evidenceRoot, dependencyPatch, reason) {
  try {
    var dir = path.join(evidenceRoot, runId, 'repair');
    ensureDir(dir);
    var data = {
      dependencyPatch: dependencyPatch || false,
      reason: reason || null,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) { /* best effort */ }
}

module.exports = { locateCandidates: locateCandidates, writeCapabilities: writeCapabilities, deriveSearchPatterns: deriveSearchPatterns, writeCandidatesEvidence: writeCandidatesEvidence };
