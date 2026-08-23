'use strict';

const MAX_MESSAGE = 2000;
const MAX_DETAILS = 5;

const API_STATUSES = new Set([
  'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION',
  'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS',
  'UNAUTHENTICATED'
]);
const DETAIL_TYPES = new Map([
  ['type.googleapis.com/google.rpc.ErrorInfo', 'ERROR_INFO'],
  ['type.googleapis.com/google.rpc.RetryInfo', 'RETRY_INFO'],
  ['type.googleapis.com/google.rpc.QuotaFailure', 'QUOTA_FAILURE'],
  ['type.googleapis.com/google.rpc.BadRequest', 'BAD_REQUEST']
]);
const DETAIL_REASONS = new Set([
  'SERVICE_UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED',
  'API_DISABLED', 'AUTHENTICATION_FAILED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
]);
const DETAIL_DOMAINS = new Set(['firebaserules.googleapis.com', 'googleapis.com']);
const TRANSPORT_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND',
  'ETIMEDOUT'
]);

// The Rules API answers a rejected request with an `error` object and answers a
// rejected *compile* with HTTP 200 plus an `issues` array. Both were being
// discarded on the fail-closed path, which is why an HTTP 503 could never be
// told apart from a quota refusal or a server-side deadline.
function allowed(value, values, fallback) {
  return typeof value === 'string' && values.has(value) ? value : fallback;
}

function detailStrings(details) {
  if (!Array.isArray(details)) return [];
  return details.slice(0, MAX_DETAILS).map(detail => {
    const value = detail && typeof detail === 'object' ? detail : {};
    return {
      type: DETAIL_TYPES.get(value['@type']) || 'OTHER',
      reason: allowed(value.reason, DETAIL_REASONS, 'UNSPECIFIED'),
      domain: allowed(value.domain, DETAIL_DOMAINS, 'UNSPECIFIED')
    };
  });
}

function transportCategory(error) {
  return allowed(error && error.code, TRANSPORT_CODES, 'TRANSPORT_FAILURE');
}

function describeRulesApiFailure(response, error) {
  const failure = {
    httpStatus: 0,
    apiCode: 0,
    apiStatus: '',
    apiMessage: '',
    apiMessageCategory: '',
    apiDetails: [],
    issueCount: 0,
    rawBody: '',
    rawBodyCategory: '',
    transportError: ''
  };
  if (response && Number.isInteger(response.statusCode)) {
    failure.httpStatus = response.statusCode;
  }
  if (response && typeof response.rawBody === 'string' && response.rawBody) {
    failure.rawBodyCategory = 'NON_JSON_BODY_OMITTED';
  }
  const body = response && response.body;
  if (body && typeof body === 'object') {
    if (Array.isArray(body.issues)) failure.issueCount = body.issues.length;
    const apiError = body.error;
    if (apiError && typeof apiError === 'object') {
      if (Number.isInteger(apiError.code)) failure.apiCode = apiError.code;
      if (typeof apiError.status === 'string') {
        failure.apiStatus = allowed(apiError.status, API_STATUSES, 'UNRECOGNIZED');
      }
      if (typeof apiError.message === 'string' && apiError.message) {
        failure.apiMessageCategory = 'API_MESSAGE_OMITTED';
      }
      failure.apiDetails = detailStrings(apiError.details);
    }
  }
  if (error) failure.transportError = transportCategory(error);
  return failure;
}

function failureLine(failure) {
  if (!failure) return '';
  return [
    'httpStatus=' + failure.httpStatus,
    'apiCode=' + failure.apiCode,
    'apiStatus=' + (failure.apiStatus || '-'),
    'issueCount=' + failure.issueCount,
    'apiMessageCategory=' + (failure.apiMessageCategory || '-'),
    'rawBodyCategory=' + (failure.rawBodyCategory || '-'),
    'transportError=' + (failure.transportError || '-')
  ].join(' ');
}

module.exports = { describeRulesApiFailure, failureLine, MAX_MESSAGE };
