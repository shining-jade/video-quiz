'use strict';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function canonicalEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function setAccess(set = {}, auth = {}, collaboratorEmails = []) {
  const active = !set.trashedAt && !set.purgeStartedAt;
  const owner = !!auth.uid && set.ownerUid === auth.uid;
  const email = canonicalEmail(auth.email);
  const editors = collaboratorEmails.map(canonicalEmail);
  const editor = active && editors.includes(email);
  return {
    canRead: active && (owner || editor || auth.role === 'teacher' || auth.role === 'admin'),
    canEdit: active && (owner || editor),
    canManage: active && owner,
    canRestore: !!set.trashedAt && !set.purgeStartedAt && owner
  };
}

function trashDeadlineMs(trashedAtMs) {
  if (!Number.isFinite(trashedAtMs)) return null;
  return trashedAtMs + RETENTION_MS;
}

function trashRetention(set = {}, nowMs) {
  const deadlineMs = trashDeadlineMs(set.trashedAt);
  if (deadlineMs == null || !Number.isFinite(nowMs)) {
    return { deadlineMs, expired: false, remainingMs: null };
  }
  return {
    deadlineMs,
    expired: deadlineMs <= nowMs,
    remainingMs: Math.max(0, deadlineMs - nowMs)
  };
}

function validateCollaboratorChange(input = {}) {
  const email = canonicalEmail(input.email);
  const ownerEmail = canonicalEmail(input.ownerEmail);
  const existing = Array.isArray(input.existing) ? input.existing.map(canonicalEmail) : [];
  let code = null;
  if (!email || !email.includes('@')) code = 'invalid';
  else if (email === ownerEmail) code = 'owner';
  else if (existing.includes(email)) code = 'duplicate';
  else if (input.enabled !== true) code = 'unapproved';
  else if (existing.length >= 20) code = 'limit';
  return code ? { ok: false, code, email } : { ok: true, code: null, email };
}

function nextPurgeStep(state = {}) {
  return (state.collaboratorsRemaining > 0 || state.imagesRemaining > 0) ? 'children' : 'parent';
}

module.exports = {
  canonicalEmail,
  setAccess,
  trashDeadlineMs,
  trashRetention,
  validateCollaboratorChange,
  nextPurgeStep
};

