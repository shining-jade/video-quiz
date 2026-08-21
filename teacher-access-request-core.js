(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.TeacherAccessRequestCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled']);
  const DECISIONS = new Set(['approved', 'rejected']);
  const ALLOWANCE_STATUSES = new Set(['active', 'suspended', 'deletion_pending']);

  function text(value) {
    return typeof value === 'string' ? value : String(value == null ? '' : value);
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function canonicalEmail(value) {
    return text(value).trim().toLowerCase();
  }

  function fail(message) {
    throw new Error(message);
  }

  function isVerifiedTeacherUser(user) {
    return !!user && user.isAnonymous !== true && user.emailVerified === true &&
      Array.isArray(user.providerData) && user.providerData.some(provider =>
        provider && ['google.com', 'password'].includes(provider.providerId)
      );
  }

  function validateProfile(displayName, organization, note) {
    if (displayName.length < 1 || displayName.length > 80) fail('displayName 이름은 1~80자여야 합니다.');
    if (organization.length > 120) fail('organization 조직은 120자 이하여야 합니다.');
    if (note.length > 500) fail('note 메모는 500자 이하여야 합니다.');
  }

  function buildRequest(user, input = {}, nowMs) {
    if (!isVerifiedTeacherUser(user)) fail('verified 교사 인증 사용자만 신청할 수 있습니다.');
    const uid = user.uid;
    const emailCanonical = canonicalEmail(user.email);
    const displayName = text(user.displayName).trim();
    const organization = text(input.organization).trim();
    const note = text(input.note).trim();
    if (!nonEmptyString(uid)) fail('uid가 필요합니다.');
    if (!emailCanonical || !emailCanonical.includes('@')) fail('유효한 이메일이 필요합니다.');
    validateProfile(displayName, organization, note);
    if (!Number.isFinite(nowMs)) fail('createdAtMs 시각이 필요합니다.');
    return {
      uid,
      emailCanonical,
      displayName,
      organization,
      note,
      status: 'pending',
      revision: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    };
  }

  function validateRequest(request) {
    const errors = [];
    const value = request && typeof request === 'object' ? request : {};
    const uid = value.uid;
    const storedEmail = value.emailCanonical;
    const email = canonicalEmail(storedEmail);
    const displayName = text(value.displayName).trim();
    const organization = text(value.organization).trim();
    const note = text(value.note).trim();
    if (!nonEmptyString(uid)) errors.push('uid');
    if (!nonEmptyString(storedEmail) || storedEmail !== email || !email.includes('@')) errors.push('emailCanonical');
    if (displayName.length < 1 || displayName.length > 80) errors.push('displayName');
    if (organization.length > 120) errors.push('organization');
    if (note.length > 500) errors.push('note');
    if (!STATUSES.has(value.status)) errors.push('status');
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) errors.push('revision');
    if (!Number.isFinite(value.createdAtMs)) errors.push('createdAtMs');
    if (!Number.isFinite(value.updatedAtMs)) errors.push('updatedAtMs');
    if (value.decidedAtMs !== undefined && !Number.isFinite(value.decidedAtMs)) errors.push('decidedAtMs');
    if (value.decidedByUid !== undefined && !nonEmptyString(value.decidedByUid)) errors.push('decidedByUid');
    if (value.decisionReason !== undefined && text(value.decisionReason).length > 200) errors.push('decisionReason');
    return { ok: errors.length === 0, errors };
  }

  function canCancel(request, uid) {
    return !!request && request.status === 'pending' && nonEmptyString(request.uid) &&
      nonEmptyString(uid) && request.uid === uid;
  }

  function normalizeDecision(decision) {
    if (typeof decision === 'string') return { status: decision, reason: '' };
    if (decision && typeof decision === 'object') {
      return { status: decision.status, reason: text(decision.reason == null ? decision.decisionReason : decision.reason) };
    }
    return { status: '', reason: '' };
  }

  function adminUid(admin) {
    return typeof admin === 'string' ? admin : admin && admin.uid;
  }

  function nextDecision(request, decision, admin, nowMs) {
    const validation = validateRequest(request);
    if (!validation.ok) fail('유효하지 않은 신청 문서입니다: ' + validation.errors.join(', '));
    if (request.status !== 'pending') fail('pending 신청만 결정할 수 있습니다.');
    const normalized = normalizeDecision(decision);
    if (!DECISIONS.has(normalized.status)) fail('approved 또는 rejected 결정만 허용됩니다.');
    const decidedByUid = adminUid(admin);
    if (!nonEmptyString(decidedByUid)) fail('관리자 UID가 필요합니다.');
    if (normalized.reason.length > 200) fail('decision reason 사유는 200자 이하여야 합니다.');
    if (!Number.isFinite(nowMs)) fail('updatedAtMs 시각이 필요합니다.');
    if (request.revision >= Number.MAX_SAFE_INTEGER) fail('revision 리비전은 safe integer 범위를 넘을 수 없습니다.');
    return Object.assign({}, request, {
      status: normalized.status,
      revision: request.revision + 1,
      decidedAtMs: nowMs,
      decidedByUid,
      decisionReason: normalized.reason,
      updatedAtMs: nowMs
    });
  }

  function teacherStatus(allowance) {
    if (!allowance || typeof allowance !== 'object') return 'unapproved';
    if (ALLOWANCE_STATUSES.has(allowance.status)) return allowance.status;
    return allowance.enabled === true ? 'active' : 'unapproved';
  }

  return { isVerifiedTeacherUser, buildRequest, validateRequest, canCancel, nextDecision, teacherStatus };
});
