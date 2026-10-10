'use strict';
var conditionExtractorModule = require('./conditionExtractor');

function buildCard(inputText, taskId, options) {  options = options || {};
  var hash = conditionExtractorModule.sha256(inputText);
  var extraction = conditionExtractorModule.extractConditions(inputText);

  var hasUnmatched = extraction.unmatched && extraction.unmatched.length > 0;
  var hasConditions = extraction.conditions && extraction.conditions.length > 0;
  var hasEmptyCondition = extraction.conditions && extraction.conditions.some(function(c) {
    return !c.text || c.text.trim().length === 0;
  });

  var status;
  if (!hasConditions || hasEmptyCondition) {
    status = 'NEEDS_REVIEW';
  } else if (hasUnmatched) {
    status = 'NEEDS_REVIEW';
  } else {
    status = 'VALID';
  }

  var card = {
    taskId: taskId || null,
    goalText: inputText,
    goalSha256: hash,
    conditions: extraction.conditions || [],
    unmatched: extraction.unmatched || [],
    status: status
  };

  return card;
}

module.exports = { buildCard: buildCard };