(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ClassPlanningCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATUSES = new Set(['planned', 'live', 'ended', 'cancelled']);
  const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

  function fail(message) {
    throw new Error(message);
  }

  function object(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message);
    return value;
  }

  function string(value, name, min, max) {
    if (typeof value !== 'string') fail(name + ' must be a string.');
    const normalized = value.trim();
    if (normalized.length < min || (max !== undefined && normalized.length > max)) {
      fail(name + ' has an invalid length.');
    }
    return normalized;
  }

  function opaqueId(value, name) {
    if (typeof value !== 'string' || value.length === 0) fail(name + ' is required.');
    return value;
  }

  function safeMs(value, name) {
    if (!Number.isSafeInteger(value)) fail(name + ' must be a finite safe millisecond timestamp.');
    return value;
  }

  function expectedStudents(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
      fail('expectedStudents must be a safe integer from 1 to 500.');
    }
    return value;
  }

  function canonicalEmail(value) {
    const email = string(value, 'owner email', 1);
    const canonical = email.toLowerCase();
    if (!canonical.includes('@')) fail('owner email must be valid.');
    return canonical;
  }

  function status(value) {
    if (!STATUSES.has(value)) fail('status must be planned, live, ended, or cancelled.');
    return value;
  }

  function planTimes(plan) {
    object(plan, 'plan is required.');
    const start = plan.plannedStartAt === undefined ? plan.startMs : plan.plannedStartAt;
    const end = plan.plannedEndAt === undefined ? plan.endMs : plan.plannedEndAt;
    safeMs(start, 'plannedStartAt');
    safeMs(end, 'plannedEndAt');
    if (end <= start) fail('plannedEndAt must be after plannedStartAt.');
    if (end - start > MAX_DURATION_MS) fail('plan duration must be at most 24 hours.');
    return { start, end };
  }

  function normalizePlan(input, identity, setSnapshot, serverNowMs) {
    object(input, 'plan input is required.');
    object(identity, 'identity is required.');
    object(setSnapshot, 'set snapshot is required.');
    const now = safeMs(serverNowMs, 'serverNowMs');
    const times = planTimes(input);
    return {
      ownerUid: opaqueId(identity.uid, 'owner UID'),
      ownerEmailCanonical: canonicalEmail(identity.emailCanonical === undefined ? identity.email : identity.emailCanonical),
      ownerDisplayName: string(identity.displayName, 'owner display name', 1, 80),
      setId: opaqueId(setSnapshot.id === undefined ? setSnapshot.setId : setSnapshot.id, 'set ID'),
      setTitleSnapshot: string(setSnapshot.title === undefined ? setSnapshot.setTitleSnapshot : setSnapshot.title, 'set title', 1),
      className: string(input.className, 'className', 1, 80),
      plannedStartAt: times.start,
      plannedEndAt: times.end,
      expectedStudents: expectedStudents(input.expectedStudents),
      status: 'planned',
      revision: 1,
      createdAtMs: now,
      updatedAtMs: now
    };
  }

  function overlaps(a, b) {
    const first = planTimes(a);
    const second = planTimes(b);
    return first.start < second.end && second.start < first.end;
  }

  function thresholds(value) {
    object(value, 'thresholds are required.');
    const caution = value.caution;
    const crowded = value.crowded;
    if (!Number.isSafeInteger(caution) || !Number.isSafeInteger(crowded) || caution < 1 || caution >= crowded) {
      fail('thresholds must satisfy 1 <= caution < crowded.');
    }
    return { caution, crowded };
  }

  function planExpectedStudents(plan) {
    object(plan, 'plan is required.');
    expectedStudents(plan.expectedStudents);
    status(plan.status);
    planTimes(plan);
    return plan.expectedStudents;
  }

  function isSamePlan(plan, candidate) {
    if (plan === candidate) return true;
    return typeof plan.planId === 'string' && plan.planId.length > 0 && plan.planId === candidate.planId;
  }

  function summarizeWindow(plans, candidate, suppliedThresholds) {
    if (!Array.isArray(plans)) fail('plans must be an array.');
    const limits = thresholds(suppliedThresholds);
    const candidateStudents = planExpectedStudents(candidate);
    if (candidate.status === 'cancelled') {
      return { overlappingClasses: 0, expectedConcurrentStudents: 0, level: 'green', canProceed: true };
    }
    let overlappingClasses = 0;
    let expectedConcurrentStudents = candidateStudents;
    for (const plan of plans) {
      const students = planExpectedStudents(plan);
      if (plan.status === 'cancelled' || isSamePlan(plan, candidate) || !overlaps(plan, candidate)) continue;
      if (expectedConcurrentStudents > Number.MAX_SAFE_INTEGER - students) {
        fail('expected concurrent students exceed safe integer range.');
      }
      overlappingClasses += 1;
      expectedConcurrentStudents += students;
    }
    const level = expectedConcurrentStudents >= limits.crowded ? 'crowded' :
      (overlappingClasses > 0 || expectedConcurrentStudents >= limits.caution) ? 'caution' : 'green';
    return { overlappingClasses, expectedConcurrentStudents, level, canProceed: true };
  }

  function copyIfDefined(output, source, key, validate) {
    if (source[key] === undefined) return;
    output[key] = validate ? validate(source[key]) : source[key];
  }

  function publicProjection(privatePlan) {
    object(privatePlan, 'private plan is required.');
    const times = planTimes(privatePlan);
    const projection = {
      setId: opaqueId(privatePlan.setId, 'set ID'),
      setTitleSnapshot: string(privatePlan.setTitleSnapshot, 'set title', 1),
      className: string(privatePlan.className, 'className', 1, 80),
      plannedStartAt: times.start,
      plannedEndAt: times.end,
      expectedStudents: expectedStudents(privatePlan.expectedStudents),
      status: status(privatePlan.status)
    };
    copyIfDefined(projection, privatePlan, 'planId', value => opaqueId(value, 'plan ID'));
    copyIfDefined(projection, privatePlan, 'warningLevel', value => {
      if (!['green', 'caution', 'crowded'].includes(value)) fail('warningLevel is invalid.');
      return value;
    });
    copyIfDefined(projection, privatePlan, 'warningAcknowledgedAt', value => safeMs(value, 'warningAcknowledgedAt'));
    copyIfDefined(projection, privatePlan, 'actualStartedAtMs', value => safeMs(value, 'actualStartedAtMs'));
    copyIfDefined(projection, privatePlan, 'actualEndedAtMs', value => safeMs(value, 'actualEndedAtMs'));
    copyIfDefined(projection, privatePlan, 'actualParticipants', value => {
      if (!Number.isSafeInteger(value) || value < 0) fail('actualParticipants must be a non-negative safe integer.');
      return value;
    });
    if (projection.actualEndedAtMs !== undefined && projection.actualStartedAtMs === undefined) {
      fail('actualEndedAtMs requires actualStartedAtMs.');
    }
    if (projection.actualEndedAtMs !== undefined && projection.actualEndedAtMs < projection.actualStartedAtMs) {
      fail('actual end must not precede actual start.');
    }
    return projection;
  }

  function applyActuals(plan, sessionSummary) {
    object(plan, 'plan is required.');
    object(sessionSummary, 'session summary is required.');
    if (!['planned', 'live'].includes(plan.status)) fail('only planned or live plans can receive actuals.');
    const sessionId = opaqueId(sessionSummary.sessionId, 'session ID');
    const startedAtMs = safeMs(sessionSummary.startedAtMs, 'startedAtMs');
    const endedAtMs = sessionSummary.endedAtMs === undefined ? undefined : safeMs(sessionSummary.endedAtMs, 'endedAtMs');
    if (endedAtMs !== undefined && endedAtMs < startedAtMs) fail('endedAtMs must not precede startedAtMs.');
    if (!Number.isSafeInteger(sessionSummary.participantCount) || sessionSummary.participantCount < 0) {
      fail('participantCount must be a non-negative safe integer.');
    }
    const actual = Object.assign({}, plan, {
      status: endedAtMs === undefined ? 'live' : 'ended',
      sessionId,
      actualStartedAtMs: startedAtMs,
      actualParticipants: sessionSummary.participantCount
    });
    if (endedAtMs !== undefined) actual.actualEndedAtMs = endedAtMs;
    return actual;
  }

  return { normalizePlan, overlaps, summarizeWindow, publicProjection, applyActuals };
});
