const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../class-planning-core.js');

const identity = {
  uid: 'teacher-a',
  emailCanonical: ' Teacher@School.KR ',
  displayName: ' 김교사 '
};

const setSnapshot = { id: 'set-health', title: ' 보건 퀴즈 ' };
const input = {
  className: ' 2학년 1반 ',
  plannedStartAt: 20_000,
  plannedEndAt: 21_800,
  expectedStudents: 35,
  ownerUid: 'attacker',
  ownerEmailCanonical: 'attacker@example.com',
  ownerDisplayName: '공격자',
  setId: 'attacker-set',
  setTitleSnapshot: '공격 세트',
  status: 'ended',
  revision: 99,
  actualParticipants: 999,
  adminNote: 'forged'
};

function privatePlan(overrides = {}) {
  return Object.assign(core.normalizePlan(input, identity, setSnapshot, 10_000), {
    planId: 'plan-a',
    warningLevel: 'caution',
    warningAcknowledgedAt: 10_500,
    adminNote: 'requires support',
    internalAuditCode: 'private-only'
  }, overrides);
}

test('normalizePlan derives trusted identity and set snapshot while ignoring caller privileged fields', () => {
  const plan = core.normalizePlan(input, identity, setSnapshot, 10_000);
  assert.deepEqual(plan, {
    ownerUid: 'teacher-a',
    ownerEmailCanonical: 'teacher@school.kr',
    ownerDisplayName: '김교사',
    setId: 'set-health',
    setTitleSnapshot: '보건 퀴즈',
    className: '2학년 1반',
    plannedStartAt: 20_000,
    plannedEndAt: 21_800,
    expectedStudents: 35,
    status: 'planned',
    revision: 1,
    createdAtMs: 10_000,
    updatedAtMs: 10_000
  });
  assert.equal(input.status, 'ended');
  assert.equal(input.ownerUid, 'attacker');
  assert.equal(input.actualParticipants, 999);
  assert.equal(identity.emailCanonical, ' Teacher@School.KR ');
  assert.equal(setSnapshot.title, ' 보건 퀴즈 ');
});

test('normalizePlan rejects invalid class, count, duration, identity, set, and unsafe times', () => {
  const cases = [
    [{ ...input, className: '' }, identity, setSnapshot, 10_000],
    [{ ...input, className: 'x'.repeat(81) }, identity, setSnapshot, 10_000],
    [{ ...input, expectedStudents: 0 }, identity, setSnapshot, 10_000],
    [{ ...input, expectedStudents: 501 }, identity, setSnapshot, 10_000],
    [{ ...input, expectedStudents: 1.5 }, identity, setSnapshot, 10_000],
    [{ ...input, plannedEndAt: 20_000 }, identity, setSnapshot, 10_000],
    [{ ...input, plannedEndAt: 20_000 + 86_400_001 }, identity, setSnapshot, 10_000],
    [{ ...input, plannedStartAt: Infinity }, identity, setSnapshot, 10_000],
    [{ ...input, plannedEndAt: Number.MAX_SAFE_INTEGER + 1 }, identity, setSnapshot, 10_000],
    [input, { ...identity, uid: '' }, setSnapshot, 10_000],
    [input, { ...identity, emailCanonical: 'not-an-email' }, setSnapshot, 10_000],
    [input, { ...identity, displayName: '' }, setSnapshot, 10_000],
    [input, identity, { ...setSnapshot, id: '' }, 10_000],
    [input, identity, { ...setSnapshot, title: '' }, 10_000],
    [input, identity, setSnapshot, NaN],
    [input, identity, setSnapshot, Number.MAX_SAFE_INTEGER + 1]
  ];
  for (const args of cases) assert.throws(() => core.normalizePlan(...args));
});

test('touching endpoints do not overlap but a one millisecond intersection does', () => {
  assert.equal(core.overlaps({ startMs: 1_000, endMs: 2_000 }, { startMs: 2_000, endMs: 3_000 }), false);
  assert.equal(core.overlaps({ startMs: 1_000, endMs: 2_001 }, { startMs: 2_000, endMs: 3_000 }), true);
  assert.equal(core.overlaps({ plannedStartAt: 1_000, plannedEndAt: 2_000 }, { plannedStartAt: 2_000, plannedEndAt: 3_000 }), false);
  assert.throws(() => core.overlaps({ startMs: 3, endMs: 2 }, { startMs: 4, endMs: 5 }));
});

test('summarizeWindow excludes cancelled plans and the same plan when editing', () => {
  const candidate = privatePlan({ planId: 'plan-a', plannedStartAt: 10_000, plannedEndAt: 11_000, expectedStudents: 35 });
  const plans = [
    candidate,
    privatePlan({ planId: 'plan-b', plannedStartAt: 10_200, plannedEndAt: 10_700, expectedStudents: 40 }),
    privatePlan({ planId: 'plan-c', plannedStartAt: 10_500, plannedEndAt: 11_500, expectedStudents: 60 }),
    privatePlan({ planId: 'plan-d', plannedStartAt: 10_400, plannedEndAt: 10_600, expectedStudents: 500, status: 'cancelled' }),
    privatePlan({ planId: 'plan-e', plannedStartAt: 11_000, plannedEndAt: 11_500, expectedStudents: 500 })
  ];
  assert.deepEqual(core.summarizeWindow(plans, candidate, { caution: 60, crowded: 120 }), {
    overlappingClasses: 2,
    expectedConcurrentStudents: 135,
    level: 'crowded',
    canProceed: true
  });
  assert.deepEqual(core.summarizeWindow(plans, { ...candidate, status: 'cancelled' }, { caution: 60, crowded: 120 }), {
    overlappingClasses: 0,
    expectedConcurrentStudents: 0,
    level: 'green',
    canProceed: true
  });
});

test('summarizeWindow returns advisory levels at the caution and crowded boundaries', () => {
  const candidate = privatePlan({ planId: 'candidate', expectedStudents: 20 });
  const other = privatePlan({ planId: 'other', expectedStudents: 40 });
  assert.deepEqual(core.summarizeWindow([], candidate, { caution: 60, crowded: 120 }), {
    overlappingClasses: 0, expectedConcurrentStudents: 20, level: 'green', canProceed: true
  });
  assert.deepEqual(core.summarizeWindow([other], candidate, { caution: 60, crowded: 120 }), {
    overlappingClasses: 1, expectedConcurrentStudents: 60, level: 'caution', canProceed: true
  });
  assert.deepEqual(core.summarizeWindow([other, privatePlan({ planId: 'third', expectedStudents: 60 })], candidate, {
    caution: 60, crowded: 120
  }), {
    overlappingClasses: 2, expectedConcurrentStudents: 120, level: 'crowded', canProceed: true
  });
  for (const thresholds of [{ caution: 0, crowded: 120 }, { caution: 120, crowded: 120 }, { caution: 121, crowded: 120 }, { caution: 1.5, crowded: 120 }]) {
    assert.throws(() => core.summarizeWindow([], candidate, thresholds));
  }
});

test('summarizeWindow gives any non-cancelled low-count overlap a caution advisory', () => {
  const candidate = privatePlan({ planId: 'candidate-low', expectedStudents: 1 });
  const other = privatePlan({ planId: 'other-low', expectedStudents: 1 });
  assert.deepEqual(core.summarizeWindow([other], candidate, { caution: 60, crowded: 120 }), {
    overlappingClasses: 1,
    expectedConcurrentStudents: 2,
    level: 'caution',
    canProceed: true
  });
});

test('publicProjection whitelists dashboard-safe fields without owner or arbitrary private data', () => {
  const projection = core.publicProjection(privatePlan({
    status: 'ended', actualStartedAtMs: 20_050, actualEndedAtMs: 21_700, actualParticipants: 31,
    sessionId: 'private-session', ownerUid: 'teacher-a', ownerEmailCanonical: 'teacher@school.kr',
    ownerDisplayName: '김교사', adminNote: 'requires support', privateToken: 'never'
  }));
  assert.deepEqual(projection, {
    planId: 'plan-a', setId: 'set-health', setTitleSnapshot: '보건 퀴즈', className: '2학년 1반',
    plannedStartAt: 20_000, plannedEndAt: 21_800, expectedStudents: 35, status: 'ended',
    warningLevel: 'caution', warningAcknowledgedAt: 10_500,
    actualStartedAtMs: 20_050, actualEndedAtMs: 21_700, actualParticipants: 31
  });
  assert.equal(projection.ownerUid, undefined);
  assert.equal(projection.ownerEmailCanonical, undefined);
  assert.equal(projection.ownerDisplayName, undefined);
  assert.equal(projection.adminNote, undefined);
  assert.equal(projection.sessionId, undefined);
  assert.equal(projection.privateToken, undefined);
});

test('applyActuals derives session facts immutably without accepting owner or planned overrides', () => {
  const before = privatePlan({ plannedStartAt: 20_000, plannedEndAt: 21_800, expectedStudents: 35 });
  const summary = {
    sessionId: 'session-1', startedAtMs: 20_050, endedAtMs: 21_700, participantCount: 31,
    ownerUid: 'attacker', plannedStartAt: 1, expectedStudents: 500
  };
  const actual = core.applyActuals(before, summary);
  assert.deepEqual(actual, {
    ...before,
    status: 'ended', sessionId: 'session-1', actualStartedAtMs: 20_050,
    actualEndedAtMs: 21_700, actualParticipants: 31
  });
  assert.deepEqual(before, privatePlan({ plannedStartAt: 20_000, plannedEndAt: 21_800, expectedStudents: 35 }));
  assert.throws(() => core.applyActuals(before, { sessionId: '', startedAtMs: 20_050, participantCount: 31 }));
  assert.throws(() => core.applyActuals(before, { sessionId: 'session-1', startedAtMs: 20_050, participantCount: -1 }));
  assert.throws(() => core.applyActuals(before, { sessionId: 'session-1', startedAtMs: 21_700, endedAtMs: 20_050, participantCount: 31 }));
});

test('index loads the browser planning core alongside local scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="class-planning-core\.js"><\/script>/);
});
