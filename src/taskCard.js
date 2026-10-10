'use strict';

var TASK_CARD_FIELDS = [
  'taskId',
  'batchId',
  'title',
  'goal',
  'description',
  'expectedResults',
  'acceptanceConditions',
  'fixtures',
  'environment',
  'status'
];

var VALID_STATUSES = ['PENDING', 'RUNNING', 'PASS_CANDIDATE', 'FAIL', 'SKIP'];

var REQUIRED_STRING_FIELDS = ['taskId', 'batchId', 'title', 'goal', 'description', 'status'];
var REQUIRED_ARRAY_FIELDS = ['expectedResults', 'acceptanceConditions', 'fixtures'];
var REQUIRED_OBJECT_FIELDS = ['environment'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isString(value) {
  return typeof value === 'string';
}

function isArray(value) {
  return Array.isArray(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateTaskCard(taskCard) {
  var errors = [];

  if (!taskCard || typeof taskCard !== 'object') {
    return { valid: false, errors: ['Task card must be an object'] };
  }

  for (var i = 0; i < REQUIRED_STRING_FIELDS.length; i++) {
    var field = REQUIRED_STRING_FIELDS[i];
    if (!taskCard[field]) {
      errors.push('Missing required field: ' + field);
    } else if (!isNonEmptyString(taskCard[field])) {
      errors.push('Field must be a non-empty string: ' + field);
    }
  }

  if (taskCard.taskId && !isNonEmptyString(taskCard.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (taskCard.batchId && !isNonEmptyString(taskCard.batchId)) {
    errors.push('batchId must be a non-empty string');
  }

  if (taskCard.status && !isString(taskCard.status)) {
    errors.push('status must be a string');
  } else if (taskCard.status && VALID_STATUSES.indexOf(taskCard.status) === -1) {
    errors.push('status must be one of: ' + VALID_STATUSES.join(', '));
  }

  for (var j = 0; j < REQUIRED_ARRAY_FIELDS.length; j++) {
    var arrField = REQUIRED_ARRAY_FIELDS[j];
    if (taskCard[arrField] !== undefined && !isArray(taskCard[arrField])) {
      errors.push(arrField + ' must be an array');
    }
  }

  if (taskCard.acceptanceConditions && isArray(taskCard.acceptanceConditions)) {
    for (var k = 0; k < taskCard.acceptanceConditions.length; k++) {
      if (typeof taskCard.acceptanceConditions[k] !== 'string') {
        errors.push('acceptanceConditions must contain only strings');
        break;
      }
    }
  }

  if (taskCard.expectedResults && isArray(taskCard.expectedResults)) {
    for (var l = 0; l < taskCard.expectedResults.length; l++) {
      if (typeof taskCard.expectedResults[l] !== 'string') {
        errors.push('expectedResults must contain only strings');
        break;
      }
    }
  }

  if (taskCard.fixtures && isArray(taskCard.fixtures)) {
    for (var m = 0; m < taskCard.fixtures.length; m++) {
      if (typeof taskCard.fixtures[m] !== 'string') {
        errors.push('fixtures must contain only strings');
        break;
      }
    }
  }

  for (var n = 0; n < REQUIRED_OBJECT_FIELDS.length; n++) {
    var objField = REQUIRED_OBJECT_FIELDS[n];
    if (taskCard[objField] !== undefined && !isObject(taskCard[objField])) {
      errors.push(objField + ' must be an object');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

function createTaskCard(data) {
  var taskCard = {
    taskId: data.taskId || null,
    batchId: data.batchId || null,
    title: data.title || null,
    goal: data.goal || null,
    description: data.description || null,
    expectedResults: data.expectedResults || [],
    acceptanceConditions: data.acceptanceConditions || [],
    fixtures: data.fixtures || [],
    environment: data.environment || {},
    status: data.status || 'PENDING'
  };

  return taskCard;
}

function serializeTaskCard(taskCard) {
  return JSON.stringify(taskCard, null, 2);
}

function deserializeTaskCard(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return null;
  }
}

module.exports = {
  validateTaskCard: validateTaskCard,
  createTaskCard: createTaskCard,
  serializeTaskCard: serializeTaskCard,
  deserializeTaskCard: deserializeTaskCard,
  VALID_STATUSES: VALID_STATUSES,
  TASK_CARD_FIELDS: TASK_CARD_FIELDS
};