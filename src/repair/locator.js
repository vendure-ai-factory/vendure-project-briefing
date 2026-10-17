'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');

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
 */
function deriveSearchPatterns(finding) {
  var patterns = [];
  var operator = finding.operator;
  var column = finding.column;
  var queryPath = finding.path;

  if (operator && column) {
    var colName = column.split('.').pop(); // e.g., 'col' from 'table.col'

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
  try {
    var content = fs.readFileSync(pkgPath, 'utf8');
    var pkg = JSON.parse(content);
    var deps = {};

    // Collect dependencies, devDependencies, peerDependencies with exact versions
    var sources = ['dependencies', 'devDependencies', 'peerDependencies'];
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      if (pkg[source]) {
        var keys = Object.keys(pkg[source]);
        for (var j = 0; j < keys.length; j++) {
          var name = keys[j];
          var version = pkg[source][name];
          // Only include exact versions (no ranges like ^, ~, etc.)
          if (version && !/^[\^~>=<]/.test(version)) {
            deps[name] = version;
          }
        }
      }
    }
    return deps;
  } catch (err) {
    return {};
  }
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

  var candidates = [];
  var searched = [];

  if (!finding || !targetRoot) {
    return { candidates: candidates, searched: searched };
  }

  var patterns = deriveSearchPatterns(finding);
  if (patterns.length === 0) {
    return { candidates: candidates, searched: searched };
  }

  // Search targetRoot/src first
  var srcDir = path.join(targetRoot, 'src');
  if (fs.existsSync(srcDir)) {
    var sourceFiles = findSourceFiles(srcDir, searched);

    for (var i = 0; i < sourceFiles.length; i++) {
      var filePath = sourceFiles[i];
      var matches = searchFileForPatterns(filePath, patterns);

      for (var j = 0; j < matches.length; j++) {
        var match = matches[j];
        var context = getContextLines(filePath, match.lineNumber, match.matchedPattern);
        var score = scoreMatch({ line: match.line, lineNumber: match.lineNumber, matchedPattern: match.matchedPattern, file: filePath }, finding, patterns);

        candidates.push({
          source: 'target',
          package: null,
          file: filePath,
          line: match.lineNumber,
          snippet: context.snippet,
          score: score,
          reasons: [match.matchedPattern]
        });
      }
    }
  }

  // Sort by score descending
  candidates.sort(function(a, b) { return b.score - a.score; });

  // Check if we have a strong match (score >= 6)
  var hasStrongMatch = candidates.length > 0 && candidates[0].score >= 6;

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

        // Search in package, avoiding node_modules inside packages
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

                        found.push({
                          source: 'dependency',
                          package: pkgName + '@' + pkgVersion,
                          file: full,
                          line: pkgMatch.lineNumber,
                          snippet: pkgContext.snippet,
                          score: pkgScore,
                          reasons: [pkgMatch.matchedPattern]
                        });
                        if (searched.indexOf(full) === -1) {
                          searched.push(full);
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

        var pkgResults = searchInPackage(pkgPath);
        candidates = candidates.concat(pkgResults);
      } catch (err) {
        // Package fetch failed, skip
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
  var evidenceDir = path.join(EVIDENCE_ROOT, runId, 'repair');
  ensureDir(evidenceDir);

  var evidenceData = {
    runId: runId,
    finding: finding,
    patterns: patterns,
    candidates: candidates.map(function(c) {
      return {
        source: c.source,
        package: c.package,
        file: c.file,
        line: c.line,
        snippet: c.snippet,
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

  return { candidates: candidates, searched: searched };
}

module.exports = { locateCandidates: locateCandidates };
