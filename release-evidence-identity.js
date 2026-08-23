'use strict';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const EVIDENCE_ARGUMENT_FIELDS = Object.freeze({
  '--window-id': 'windowId',
  '--control-id': 'controlId'
});

function validCapturedAt(value) {
  return rfc3339Nanoseconds(value) !== null;
}

function rfc3339Nanoseconds(value) {
  if (typeof value !== 'string' || !RFC3339_PATTERN.test(value)) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
  if (!match) return null;
  const wholeSecond = Date.parse(match[1] + 'Z');
  if (!Number.isFinite(wholeSecond) || wholeSecond % 1000 !== 0 ||
      new Date(wholeSecond).toISOString().slice(0, 19) !== match[1]) return null;
  const fractional = (match[2] || '').padEnd(9, '0');
  return BigInt(wholeSecond) * 1_000_000n + BigInt(fractional || '0');
}

function validateEvidenceIdentityOptions(options) {
  const windowId = String(options && options.windowId || '');
  const controlId = String(options && options.controlId || '');
  const supplied = Boolean(windowId || controlId);
  if (options && options.targetMode === 'production' && !supplied) {
    throw new Error('Production evidence requires --window-id and --control-id.');
  }
  if (supplied && (!UUID_PATTERN.test(windowId) || !UUID_PATTERN.test(controlId))) {
    throw new Error('--window-id and --control-id must both be exact lowercase UUIDs.');
  }
  if (supplied && windowId === controlId) {
    throw new Error('--window-id and --control-id must be distinct identities.');
  }
  return { windowId, controlId };
}

function captureEvidenceIdentity(options, descriptor, now = () => new Date().toISOString()) {
  const ids = validateEvidenceIdentityOptions(options);
  const capturedAt = now();
  if (!validCapturedAt(capturedAt)) {
    throw new Error('Evidence capture clock must return a full RFC3339 UTC timestamp.');
  }
  if (!descriptor || typeof descriptor.tool !== 'string' || !descriptor.tool ||
      !Number.isInteger(descriptor.schemaVersion) || descriptor.schemaVersion < 1) {
    throw new Error('Evidence producer must declare an exact tool and schema version.');
  }
  return Object.freeze({
    tool: descriptor.tool,
    schemaVersion: descriptor.schemaVersion,
    projectId: options.projectId,
    targetMode: options.targetMode,
    windowId: ids.windowId,
    controlId: ids.controlId,
    capturedAt
  });
}

function authorEvidenceReport(report, identity) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Evidence report body must be an object.');
  }
  return { ...report, ...identity };
}

module.exports = {
  EVIDENCE_ARGUMENT_FIELDS,
  RFC3339_PATTERN,
  UUID_PATTERN,
  authorEvidenceReport,
  captureEvidenceIdentity,
  rfc3339Nanoseconds,
  validCapturedAt,
  validateEvidenceIdentityOptions
};
