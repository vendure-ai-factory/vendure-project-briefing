'use strict';

/**
 * Chain runner (chunk 16).
 *
 * Reads the chains table in the manifest (A, B, C, D+F, B+E, G) and resolves a
 * `--chain` code to the ordered canonical task ids for that chain. A chain is
 * produces RESULT_PASS only if every task in it has coverage "full" and result RESULT_PASS;
 * otherwise the chain result is the worst task outcome (ranked by the same
 * severity ordering as the CLI exit codes) with a reason.
 */

var terminalState = require('./terminalState');

var RESULT_PASS = terminalState.RESULT_PASS;
var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_FULL = terminalState.COVERAGE_FULL;

// Chain codes accepted by `bin/pipeline.js run --chain`. Each code maps to the
// set of spec chain labels its chain stands for. The manifest chains table is
// resolved by comparing a row's specChains array to this target set.
var CHAIN_DEFINITIONS = {
  A: { specChains: ['A'] },
  B: { specChains: ['B'] },
  C: { specChains: ['C'] },
  DF: { specChains: ['D', 'F'] },
  BE: { specChains: ['B', 'E'] },
  G: { specChains: ['G'] }
};

function normalizeCode(code) {
  return String(code === undefined || code === null ? '' : code).toUpperCase();
}

function isValidChainCode(code) {
  return Object.prototype.hasOwnProperty.call(CHAIN_DEFINITIONS, normalizeCode(code));
}

function sameSpecChains(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  var sa = a.slice().sort();
  var sb = b.slice().sort();
  for (var i = 0; i < sa.length; i++) {
    if (String(sa[i]) !== String(sb[i])) return false;
  }
  return true;
}

// Normalize both legacy flat `chains: [...]` and the current
// `chains: { rows: [...], chainG: {...} }` reference structure.
function rowsOf(manifest) {
  var chains = (manifest && manifest.chains) ? manifest.chains : {};
  if (Array.isArray(chains)) return chains;
  if (chains && typeof chains === 'object') return Array.isArray(chains.rows) ? chains.rows : [];
  return [];
}

/**
 * Resolve a `--chain` code to its manifest chain definition.
 * Returns { error } or {
 *   chainId, specChains, specChainsRaw, mappingTypeSource, name,
 *   canonicalIds
 * }.
 */
function resolveChain(manifest, chainCode) {
  var code = normalizeCode(chainCode);
  if (!isValidChainCode(code)) {
    return { error: 'Unknown chain: ' + chainCode + ' (expected A, B, C, DF, BE or G)', chainId: null };
  }
  var target = CHAIN_DEFINITIONS[code].specChains;
  var rows = rowsOf(manifest);
  var row = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && Array.isArray(rows[i].specChains) && sameSpecChains(rows[i].specChains, target)) {
      row = rows[i];
      break;
    }
  }
  var canonicalIds = row ? (Array.isArray(row.canonicalIds) ? row.canonicalIds.slice() : []) : [];
  var specChainsRaw = row ? (row.specChainsRaw || null) : null;
  var mappingTypeSource = row ? (row.mappingTypeSource || null) : null;
  var name = row ? (row.tasksRaw || row.specChainsRaw || '') : '';

  // Chain G may be defined only in the reference chainG block (not as a row).
  if (!row && code === 'G' && manifest && manifest.chains && manifest.chains.chainG) {
    var g = manifest.chains.chainG;
    name = g.name || '';
    canonicalIds = Array.isArray(g.canonicalIds) ? g.canonicalIds.slice() : [];
    mappingTypeSource = 'added Chain G';
  }

  if (canonicalIds.length === 0) {
    return { error: 'chain ' + code + ' is not defined in the manifest chains table', chainId: code };
  }

  return {
    chainId: code,
    specChains: target.slice(),
    specChainsRaw: specChainsRaw,
    mappingTypeSource: mappingTypeSource,
    name: name,
    canonicalIds: canonicalIds
  };
}

// Severity ranking for the "worst task outcome". It mirrors exitCodeForOutcome
// in cli.js so the chain's worst task is the one with the highest exit-code
// classification. N/A and a full pass are equally clean (0); a
// READINESS_PASS is not a full-pass task (coverage is not "full") so it ranks
// above a pass but below any BLOCK; every BLOCK ranks by its failure class.
var BLOCK_SEVERITY = {};
BLOCK_SEVERITY['SAFETY_AUTHORIZATION'] = 7;
BLOCK_SEVERITY['DEPENDENCY_ENVIRONMENT'] = 6;
BLOCK_SEVERITY['UNRESOLVED_ASSUMPTION'] = 5;
BLOCK_SEVERITY['OUT_OF_SCOPE_DECISION'] = 5;
BLOCK_SEVERITY['CLIENT_INPUT_SCOPE'] = 4;
BLOCK_SEVERITY['PIPELINE_DEFECT'] = 3;
BLOCK_SEVERITY['APPLICATION_DEFECT'] = 3;

function severityOfClassification(classification) {
  if (!classification) return 3;
  var sev = BLOCK_SEVERITY[classification];
  return sev === undefined ? 3 : sev;
}

function severityOfOutcome(outcome) {
  if (!outcome) return 0;
  var result = outcome.result;
  if (result === 'N/A' || result === 'NA' || result === RESULT_PASS) return 0;
  if (result === RESULT_READINESS_PASS) return 1;
  return severityOfClassification(outcome.classification);
}

/**
 * Aggregate per-task chain outcomes into a single chain verdict.
 * outcomes: array of { taskId, result, classification, cause, coverage,
 *   exitCode, evidenceInvalid } in chain order (only executed tasks).
 *
 * Returns { result, classification, cause, reason, coverage, worstTaskId }.
 */
function aggregateChain(chain, outcomes) {
  var total = outcomes.length;
  var allFullCoverage = true;
  var worst = null;

  for (var i = 0; i < total; i++) {
    var o = outcomes[i];
    if (o.coverage !== COVERAGE_FULL) allFullCoverage = false;
    var sev = severityOfOutcome(o);
    // Strictly greater so the worst is the first task with the highest
    // severity in chain order: deterministic and traceable.
    if (!worst || sev > worst.severity) {
      worst = { severity: sev, outcome: o };
    }
  }

  var allPass = !!worst && allFullCoverage && worst.outcome.result === RESULT_PASS && worst.severity === 0;
  if (allPass) {
    return {
      result: RESULT_PASS,
      classification: null,
      cause: null,
      reason: 'chain ' + chain.chainId + ' completed: all ' + total + ' task(s) have coverage full and result RESULT_PASS',
      coverage: COVERAGE_FULL,
      worstTaskId: null
    };
  }

  var w = worst ? worst.outcome : null;
  var reason = 'chain ' + chain.chainId + ' not passing: evaluated ' + total + (total === 1 ? ' task' : ' tasks');
  if (w) {
    reason += '; worst task ' + w.taskId + ' has result ' + w.result +
      (w.classification ? ' classification ' + w.classification : '') +
      (w.cause ? ' (' + w.cause + ')' : '');
    if (w.coverage && w.coverage !== COVERAGE_FULL) reason += ' with coverage ' + w.coverage;
  }
  if (!allFullCoverage) reason += ' (not every task has coverage full)';

  return {
    result: w ? w.result : 'BLOCK',
    classification: w ? w.classification : null,
    cause: w ? w.cause : null,
    reason: reason,
    coverage: allFullCoverage ? COVERAGE_FULL : 'partial',
    worstTaskId: w ? w.taskId : null
  };
}

module.exports = {
  CHAIN_DEFINITIONS: CHAIN_DEFINITIONS,
  normalizeCode: normalizeCode,
  isValidChainCode: isValidChainCode,
  resolveChain: resolveChain,
  severityOfClassification: severityOfClassification,
  severityOfOutcome: severityOfOutcome,
  aggregateChain: aggregateChain
};
