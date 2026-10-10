'use strict';

var crypto = require('crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function extractConditions(text) {
  var lines = text.split('\n');
  var conditions = [];
  var unmatched = [];
  var currentBulletContext = null;
  var idCounter = 1;

  function makeId() {
    return 'cond-' + (idCounter++);
  }

  function classifyPolarity(sentence) {
    var lower = sentence.toLowerCase();
    if (lower.indexOf('must not') !== -1 ||
        lower.indexOf('is not') !== -1 ||
        lower.indexOf('are not') !== -1 ||
        lower.indexOf('never') !== -1 ||
        lower.indexOf('not a pass') !== -1 ||
        lower.indexOf('not pass') !== -1 ||
        lower.indexOf('no longer') !== -1 ||
        lower.indexOf('is rejected') !== -1 ||
        lower.indexOf('are rejected') !== -1 ||
        lower.indexOf('is not permitted') !== -1 ||
        lower.indexOf('is not allowed') !== -1 ||
        lower.indexOf('is not possible') !== -1) {
      return 'MUST_NOT';
    }
    return 'MUST';
  }

  function makeSourceRef(lineIdx) {
    return { line: lineIdx + 1 };
  }

  function processBulletLine(line, lineIdx) {
    var trimmed = line.replace(/^[\s\-*]+/, '').trim();
    if (!trimmed) return null;

    var lower = trimmed.toLowerCase();
    if (lower.indexOf('verify that') !== -1 || lower === 'verify') {
      return {
        id: makeId(),
        text: trimmed,
        polarity: classifyPolarity(trimmed),
        sourceRef: makeSourceRef(lineIdx)
      };
    }
    return null;
  }

  function processSentence(sentence, lineIdx) {
    var trimmed = sentence.trim();
    if (!trimmed) return null;

    var lower = trimmed.toLowerCase();
    if (lower.indexOf('must not') !== -1 ||
        lower.indexOf('must') !== -1 ||
        lower.indexOf('is not') !== -1 ||
        lower.indexOf('are not') !== -1 ||
        lower.indexOf('not a pass') !== -1 ||
        lower.indexOf('never') !== -1 ||
        lower.indexOf('no longer') !== -1 ||
        lower.indexOf('is rejected') !== -1 ||
        lower.indexOf('are rejected') !== -1 ||
        lower.indexOf('is not permitted') !== -1 ||
        lower.indexOf('is not allowed') !== -1 ||
        lower.indexOf('is not possible') !== -1 ||
        lower.indexOf('verify that') !== -1 ||
        lower.indexOf('verify') !== -1) {
      return {
        id: makeId(),
        text: trimmed,
        polarity: classifyPolarity(trimmed),
        sourceRef: makeSourceRef(lineIdx)
      };
    }
    return null;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    if (!trimmed) {
      currentBulletContext = null;
      continue;
    }

    var isBullet = /^[\s\-*]/.test(line);
    var lower = trimmed.toLowerCase();

    if (isBullet && (lower.indexOf('verify that') !== -1 || lower === 'verify')) {
      var cond = processBulletLine(line, i);
      if (cond) {
        conditions.push(cond);
        currentBulletContext = 'verify';
      }
    } else if (currentBulletContext === 'verify' && isBullet) {
      var bulletCond = processBulletLine(line, i);
      if (bulletCond) {
        conditions.push(bulletCond);
      } else {
        var sentenceCond = processSentence(trimmed, i);
        if (sentenceCond) {
          conditions.push(sentenceCond);
        } else {
          unmatched.push({ line: i + 1, text: trimmed });
        }
      }
    } else if (!isBullet) {
      currentBulletContext = null;
      var sentences = trimmed.split(/[.!?;]\s+/);
      for (var j = 0; j < sentences.length; j++) {
        var sent = sentences[j].trim();
        if (!sent) continue;

        var sentLower = sent.toLowerCase();
        if (sentLower.indexOf('must not') !== -1 ||
            sentLower.indexOf('must') !== -1 ||
            sentLower.indexOf('is not') !== -1 ||
            sentLower.indexOf('are not') !== -1 ||
            sentLower.indexOf('not a pass') !== -1 ||
            sentLower.indexOf('never') !== -1 ||
            sentLower.indexOf('no longer') !== -1 ||
            sentLower.indexOf('is rejected') !== -1 ||
            sentLower.indexOf('are rejected') !== -1 ||
            sentLower.indexOf('is not permitted') !== -1 ||
            sentLower.indexOf('is not allowed') !== -1 ||
            sentLower.indexOf('is not possible') !== -1 ||
            sentLower.indexOf('verify that') !== -1 ||
            sentLower.indexOf('verify') !== -1) {
          conditions.push({
            id: makeId(),
            text: sent,
            polarity: classifyPolarity(sent),
            sourceRef: makeSourceRef(i)
          });
        } else {
          unmatched.push({ line: i + 1, text: sent });
        }
      }
    } else {
      unmatched.push({ line: i + 1, text: trimmed });
    }
  }

  return { conditions: conditions, unmatched: unmatched };
}

module.exports = {
  extractConditions: extractConditions,
  sha256: sha256
};
