'use strict';

/**
 * Shared fetch-normalization helpers for the repair adapters.
 *
 * The injected fetch must behave like WHATWG fetch (Node >=18/22 global fetch):
 * res.ok, res.status, res.headers.get, res.text(), res.json(), res.arrayBuffer().
 * Consumers normalize what fetch returns into whitelisted evidence:
 * { stage, host, method, status, contentType, bodyLength, reason }.
 * Evidence never carries URLs with tokens, headers, body content or secrets.
 */

/**
 * Hostname-only extraction from a URL. Drops scheme, userinfo, port, path and
 * query so no token-bearing URL ever lands in evidence.
 */
function hostOf(url) {
  var s = String(url == null ? '' : url);
  var m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!m) return null;
  var authority = m[1];
  var at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.substring(at + 1);
  var colon = authority.indexOf(':');
  if (colon !== -1) authority = authority.substring(0, colon);
  return authority ? authority.toLowerCase() : null;
}

function responseStatus(response) {
  if (response && typeof response.status === 'number') return response.status;
  if (response && typeof response.status === 'string' && response.status !== '') {
    return parseInt(response.status, 10) || String(response.status);
  }
  return null;
}

function contentTypeOf(response) {
  try {
    if (response && response.headers && typeof response.headers.get === 'function') {
      var ct = response.headers.get('content-type');
      if (ct) return String(ct).split(';')[0].trim();
    }
  } catch (e) { /* ignore */ }
  return null;
}

function bodyLengthHint(response) {
  try {
    if (response && typeof response === 'object') {
      if (typeof response.body === 'string') return response.body.length;
      if (Array.isArray(response.body)) return response.body.length;
      if (response.headers && typeof response.headers.get === 'function') {
        var cl = response.headers.get('content-length');
        var n = parseInt(cl, 10);
        if (!isNaN(n)) return n;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Is this a WHATWG-style Response? The repair adapters rely on numeric status.
 * Anything without a numeric status is an adapter result, not an HTTP response.
 */
function isResponseLike(response) {
  return !!(response && typeof response === 'object' && typeof response.status === 'number');
}

/**
 * Build whitelisted blocker evidence for any fetch-related failure.
 * The shape is fixed: { stage, host, method, status, contentType, bodyLength,
 * reason }. Nulls are kept for schema stability.
 */
function fetchEvidence(stage, method, url, response, reason) {
  return {
    stage: stage,
    host: hostOf(url),
    method: method || null,
    status: responseStatus(response),
    contentType: contentTypeOf(response),
    bodyLength: bodyLengthHint(response),
    reason: reason || null
  };
}

module.exports = {
  hostOf: hostOf,
  responseStatus: responseStatus,
  contentTypeOf: contentTypeOf,
  bodyLengthHint: bodyLengthHint,
  isResponseLike: isResponseLike,
  fetchEvidence: fetchEvidence
};
