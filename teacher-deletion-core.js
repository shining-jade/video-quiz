(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.TeacherDeletionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAYS_30_MS = 30 * 24 * 60 * 60 * 1000;

  function fail(message) {
    throw new Error(message);
  }

  function timestampMillis(value) {
    if (Number.isSafeInteger(value)) return value;
    if (value && typeof value.toMillis === 'function') {
      const millis = value.toMillis();
      return Number.isSafeInteger(millis) ? millis : null;
    }
    if (value instanceof Date && Number.isSafeInteger(value.getTime())) return value.getTime();
    return null;
  }

  function exactUid(value) {
    if (typeof value !== 'string' || value.length === 0) fail('exact UID가 필요합니다.');
    return value;
  }

  function exactEmail(value) {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim().toLowerCase() ||
        !value.includes('@')) {
      fail('exact canonical email이 필요합니다.');
    }
    return value;
  }

  function revision(value, allowMaximum) {
    if (!Number.isSafeInteger(value) || value < 1 || (!allowMaximum && value >= Number.MAX_SAFE_INTEGER)) {
      fail('positive safe revision이 필요합니다.');
    }
    return value;
  }

  function nowMillis(value) {
    if (!Number.isSafeInteger(value)) fail('server millisecond timestamp가 필요합니다.');
    return value;
  }

  function commonAllowance(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('teacher allowance가 필요합니다.');
    exactUid(value.uid);
    exactEmail(value.emailCanonical);
    if (value.role !== 'teacher') fail('teacher allowance만 처리할 수 있습니다.');
    if (typeof value.administrativeHold !== 'boolean') fail('administrativeHold boolean이 필요합니다.');
    revision(value.revision, true);
    return value;
  }

  function pendingAllowance(value) {
    commonAllowance(value);
    const requestedAtMs = timestampMillis(value.deletionRequestedAtMs === undefined
      ? value.deletionRequestedAt : value.deletionRequestedAtMs);
    const purgeEligibleAtMs = timestampMillis(value.purgeEligibleAtMs === undefined
      ? value.purgeEligibleAt : value.purgeEligibleAtMs);
    if (value.status !== 'deletion_pending' || value.enabled !== false) {
      fail('deletion_pending disabled allowance가 필요합니다.');
    }
    if (requestedAtMs === null || purgeEligibleAtMs === null ||
        requestedAtMs > Number.MAX_SAFE_INTEGER - DAYS_30_MS ||
        purgeEligibleAtMs !== requestedAtMs + DAYS_30_MS) {
      fail('정확한 30-day deletion timestamp가 필요합니다.');
    }
    return { requestedAtMs, purgeEligibleAtMs };
  }

  function request(allowance, serverNowMs) {
    const value = commonAllowance(allowance);
    const now = nowMillis(serverNowMs);
    if (value.status !== 'active' || value.enabled !== true || value.administrativeHold !== false) {
      fail('administrative hold가 없는 active teacher만 탈퇴를 요청할 수 있습니다.');
    }
    revision(value.revision, false);
    if (now > Number.MAX_SAFE_INTEGER - DAYS_30_MS) fail('30-day timestamp가 safe integer 범위를 넘습니다.');
    return Object.assign({}, value, {
      status: 'deletion_pending',
      enabled: false,
      revision: value.revision + 1,
      deletionRequestedAtMs: now,
      purgeEligibleAtMs: now + DAYS_30_MS,
      updatedAtMs: now,
      updatedByUid: value.uid
    });
  }

  function cancel(allowance, serverNowMs) {
    const value = commonAllowance(allowance);
    const now = nowMillis(serverNowMs);
    const times = pendingAllowance(value);
    revision(value.revision, false);
    if (now >= times.purgeEligibleAtMs) fail('30일 정리 eligible 경계 이후에는 탈퇴 요청을 철회할 수 없습니다.');
    const output = Object.assign({}, value, {
      status: value.administrativeHold ? 'suspended' : 'active',
      enabled: value.administrativeHold ? false : true,
      revision: value.revision + 1,
      updatedAtMs: now,
      updatedByUid: value.uid
    });
    delete output.deletionRequestedAt;
    delete output.deletionRequestedAtMs;
    delete output.purgeEligibleAt;
    delete output.purgeEligibleAtMs;
    if (!value.administrativeHold) {
      delete output.suspendedAt;
      delete output.suspendedAtMs;
      delete output.suspendedByUid;
      delete output.suspensionReason;
    } else if (timestampMillis(value.suspendedAtMs === undefined ? value.suspendedAt : value.suspendedAtMs) === null ||
        typeof value.suspendedByUid !== 'string' || value.suspendedByUid.length === 0 ||
        typeof value.suspensionReason !== 'string' || value.suspensionReason.length > 200) {
      fail('administrative hold 감사 필드가 유효하지 않습니다.');
    }
    return output;
  }

  function invalidAudit(value) {
    const allowance = value && value.allowance || {};
    return {
      eligible: false,
      blockers: ['invalid_state'],
      deletionRequestedAtMs: null,
      purgeEligibleAtMs: null,
      remainingMs: null,
      ownedSetCount: Number.isSafeInteger(value && value.ownedSetCount) ? value.ownedSetCount : null,
      liveSessionCount: Number.isSafeInteger(value && value.liveSessionCount) ? value.liveSessionCount : null,
      revision: Number.isSafeInteger(allowance.revision) ? allowance.revision : null,
      uid: typeof allowance.uid === 'string' ? allowance.uid : ''
    };
  }

  function auditEligibility(input, serverNowMs) {
    const value = input && typeof input === 'object' ? input : {};
    const now = timestampMillis(serverNowMs);
    try {
      const allowance = commonAllowance(value.allowance);
      const times = pendingAllowance(allowance);
      revision(allowance.revision, true);
      if (now === null || !Number.isSafeInteger(value.ownedSetCount) || value.ownedSetCount < 0 ||
          !Number.isSafeInteger(value.liveSessionCount) || value.liveSessionCount < 0) {
        return invalidAudit(value);
      }
      const blockers = [];
      if (now < times.purgeEligibleAtMs) blockers.push('waiting_period');
      if (value.ownedSetCount > 0) blockers.push('owned_sets');
      if (value.liveSessionCount > 0) blockers.push('live_sessions');
      return {
        eligible: blockers.length === 0,
        blockers,
        deletionRequestedAtMs: times.requestedAtMs,
        purgeEligibleAtMs: times.purgeEligibleAtMs,
        remainingMs: Math.max(0, times.purgeEligibleAtMs - now),
        ownedSetCount: value.ownedSetCount,
        liveSessionCount: value.liveSessionCount,
        revision: allowance.revision,
        uid: allowance.uid
      };
    } catch (_) {
      return invalidAudit(value);
    }
  }

  return { DAYS_30_MS, request, cancel, auditEligibility, timestampMillis };
});
