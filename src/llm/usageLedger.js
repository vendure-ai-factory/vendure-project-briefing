'use strict';

var fs = require('fs');
var path = require('path');

/**
 * Append-only JSONL usage ledger at runs/<runId>/llm-usage.jsonl
 *
 * Each line is a JSON object with:
 *   timestamp, taskId, purpose, model, promptTokens, completionTokens,
 *   costUsd, requestId, cumulativeCostUsd
 *
 * For failed calls, the line includes an `error` field instead of token/cost fields.
 * Never records prompts, responses, or the API key.
 */

function writeLedgerEntry(runId, entry, deps) {
  deps = deps || {};
  var fs_ = deps.fs || fs;
  var path_ = deps.path || path;

  if (!runId) {
    throw new Error('runId is required for usage ledger');
  }

  var runsDir = path_.resolve(process.cwd(), 'runs');
  var runDir = path_.join(runsDir, runId);
  var ledgerPath = path_.join(runDir, 'llm-usage.jsonl');

  // Ensure directory exists
  try {
    if (!fs_.existsSync(runDir)) {
      fs_.mkdirSync(runDir, { recursive: true });
    }
  } catch (e) {
    // If we can't create the dir, skip writing (non-fatal)
    return;
  }

  var jsonLine = JSON.stringify(entry) + '\n';
  try {
    fs_.appendFileSync(ledgerPath, jsonLine, 'utf8');
  } catch (e) {
    // Non-fatal: don't break the call if ledger write fails
  }
}

/**
 * Read all ledger entries for a runId.
 * Used by tests to verify ledger contents.
 */
function readLedger(runId, deps) {
  deps = deps || {};
  var fs_ = deps.fs || fs;
  var path_ = deps.path || path;

  if (!runId) return [];

  var ledgerPath = path_.join(path_.resolve(process.cwd(), 'runs'), runId, 'llm-usage.jsonl');
  if (!fs_.existsSync(ledgerPath)) return [];

  var content = fs_.readFileSync(ledgerPath, 'utf8');
  var lines = content.split('\n');
  var entries = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line) {
      try {
        entries.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
      }
    }
  }
  return entries;
}

/**
 * Clear ledger for a runId (used by tests).
 */
function clearLedger(runId, deps) {
  deps = deps || {};
  var fs_ = deps.fs || fs;
  var path_ = deps.path || path;

  if (!runId) return;

  var ledgerPath = path_.join(path_.resolve(process.cwd(), 'runs'), runId, 'llm-usage.jsonl');
  if (fs_.existsSync(ledgerPath)) {
    try { fs_.unlinkSync(ledgerPath); } catch (e) {}
  }
}

module.exports = {
  writeLedgerEntry: writeLedgerEntry,
  readLedger: readLedger,
  clearLedger: clearLedger
};