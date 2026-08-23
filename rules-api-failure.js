'use strict';

const MAX_MESSAGE = 2000;
const MAX_DETAILS = 5;

// The Rules API answers a rejected request with an `error` object and answers a
// rejected *compile* with HTTP 200 plus an `issues` array. Both were being
// discarded on the fail-closed path, which is why an HTTP 503 could never be
// told apart from a quota refusal or a server-side deadline.
function redact(value) {
  return String(value == null ? '' : value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/ya29\.[\w.\-]+/g, '[redacted]')
    .slice(0, MAX_MESSAGE);
}

function detailStrings(details) {
  if (!Array.isArray(details)) return [];
  return details.slice(0, MAX_DETAILS).map(detail => {
    if (!detail || typeof detail !== 'object') return redact(detail);
    const type = typeof detail['@type'] === 'string' ? detail['@type'] : '';
    const reason = typeof detail.reason === 'string' ? detail.reason : '';
    const domain = typeof detail.domain === 'string' ? detail.domain : '';
    const named = [type, reason, domain].filter(Boolean).join(' ');
    return redact(named || JSON.stringify(detail));
  });
}

function describeRulesApiFailure(response, error) {
  const failure = {
    httpStatus: 0,
    apiCode: 0,
    apiStatus: '',
    apiMessage: '',
    apiDetails: [],
    issueCount: 0,
    rawBody: '',
    transportError: ''
  };
  if (response && Number.isInteger(response.statusCode)) {
    failure.httpStatus = response.statusCode;
  }
  if (response && typeof response.rawBody === 'string' && response.rawBody) {
    failure.rawBody = redact(response.rawBody);
  }
  const body = response && response.body;
  if (body && typeof body === 'object') {
    if (Array.isArray(body.issues)) failure.issueCount = body.issues.length;
    const apiError = body.error;
    if (apiError && typeof apiError === 'object') {
      if (Number.isInteger(apiError.code)) failure.apiCode = apiError.code;
      if (typeof apiError.status === 'string') failure.apiStatus = redact(apiError.status);
      if (typeof apiError.message === 'string') failure.apiMessage = redact(apiError.message);
      failure.apiDetails = detailStrings(apiError.details);
    }
  }
  if (error) failure.transportError = redact(error && error.message || error);
  return failure;
}

function failureLine(failure) {
  if (!failure) return '';
  return [
    'httpStatus=' + failure.httpStatus,
    'apiCode=' + failure.apiCode,
    'apiStatus=' + (failure.apiStatus || '-'),
    'issueCount=' + failure.issueCount,
    'apiMessage=' + JSON.stringify(failure.apiMessage || ''),
    'transportError=' + JSON.stringify(failure.transportError || '')
  ].join(' ');
}

module.exports = { describeRulesApiFailure, failureLine, MAX_MESSAGE };
