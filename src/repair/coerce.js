'use strict';

/**
 * Shared safe-coercion helpers for repair input shapes. Every helper never
 * throws and returns a well-typed value for string, array, object and
 * undefined/null inputs. Use these instead of raw .substring/.split/.map on
 * finding/task/apiErrors/evidence/logs/model output properties.
 */

/**
 * Convert any value to a string. Arrays are joined row-wise (objects become
 * 'file:line' frames), objects are JSON-stringified, everything else uses
 * String(). Optional maxLen truncates the result.
 */
function stackToString(stack, maxLen) {
  maxLen = typeof maxLen === 'number' ? maxLen : 2000;
  var result;
  if (stack == null) {
    result = 'none';
  } else if (typeof stack === 'string') {
    result = stack;
  } else if (Array.isArray(stack)) {
    result = stack.map(function(f) {
      if (f && typeof f === 'object') {
        return (f.file || '') + ':' + (f.line || '');
      }
      return String(f);
    }).join('\n');
  } else if (typeof stack === 'object') {
    result = JSON.stringify(stack);
  } else {
    result = String(stack);
  }
  return result.substring(0, maxLen);
}

/**
 * Convert any value to a non-empty-safe text string. null/undefined -> '',
 * arrays -> JSON.stringify (preserves structure), objects -> JSON.stringify,
 * primitives -> String(). Optional maxLen truncates.
 */
function toText(value, maxLen) {
  var result;
  if (value == null) {
    result = '';
  } else if (typeof value === 'string') {
    result = value;
  } else {
    result = JSON.stringify(value);
  }
  if (typeof result !== 'string') {
    result = String(result);
  }
  if (typeof maxLen === 'number' && maxLen > 0 && result.length > maxLen) {
    result = result.substring(0, maxLen);
  }
  return result;
}

/**
 * Convert any value to an array. null/undefined -> [], arrays -> a shallow
 * copy, strings -> split on newline if it contains any, otherwise a single
 * element, everything else -> a single-element array.
 */
function toArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'string') {
    if (value.indexOf('\n') !== -1) {
      return value.split('\n').filter(function(line) { return line !== ''; });
    }
    return [value];
  }
  return [value];
}

module.exports = {
  stackToString: stackToString,
  toText: toText,
  toArray: toArray
};
