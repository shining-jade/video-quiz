const test = require('node:test');
const assert = require('node:assert/strict');

test('approved legacy owner plans only ownerless documents and resumes own sessions', () => {
  const core = require('../migration-core.js');
  const plan = core.planLegacyMigration(
    [
      { id: 'legacy-set' },
      { id: 'own-set', ownerUid: 'teacher-1' },
      { id: 'other-set', ownerUid: 'teacher-2' }
    ],
    [
      { id: 'legacy-session', setId: 'legacy-set' },
      { id: 'own-session', teacherUid: 'teacher-1' },
      { id: 'other-session', teacherUid: 'teacher-2' }
    ],
    {
      status: 'teacher', uid: 'teacher-1', email: ' Teacher@School.KR ',
      legacyOwnerVerified: true
    }
  );

  assert.deepEqual(plan.setIds, ['legacy-set']);
  assert.deepEqual(plan.sessionIds, ['legacy-session']);
  assert.deepEqual(plan.resumeSetIds, ['own-set']);
  assert.deepEqual(plan.resumeSessionIds, ['own-session']);
  assert.deepEqual(plan.skippedSetIds, ['other-set']);
  assert.deepEqual(plan.skippedSessionIds, ['other-session']);
  assert.deepEqual(plan.teacher, { uid: 'teacher-1', email: 'teacher@school.kr' });
});

test('unverified, unapproved, anonymous, and non-legacy teachers cannot plan a claim', () => {
  const core = require('../migration-core.js');
  const invalidTeachers = [
    { status: 'unverified', uid: 'u1', email: 'owner@school.kr', legacyOwnerVerified: true },
    { status: 'unapproved', uid: 'u1', email: 'owner@school.kr', legacyOwnerVerified: true },
    { status: 'teacher', uid: 'u1', email: 'owner@school.kr', legacyOwnerVerified: false },
    { status: 'teacher', uid: 'u1', email: '', legacyOwnerVerified: true },
    { status: 'teacher', uid: '', email: 'owner@school.kr', legacyOwnerVerified: true }
  ];

  invalidTeachers.forEach(teacher => {
    assert.throws(
      () => core.planLegacyMigration([{ id: 'set' }], [], teacher),
      /verified legacy owner/i
    );
  });
});

test('legacy response grading moves to private revision grades and removes public leaks', () => {
  const core = require('../migration-core.js');
  const prepared = core.prepareLegacyResponse('student-1', {
    answers: {
      0: { answer: 2, submitted: true, revision: 4, ok: true, score: 1 },
      1: { answer: 'text', submitted: true, ok: false }
    }
  });

  assert.equal(prepared.status, 'migrate');
  assert.deepEqual(prepared.response, {
    uid: 'student-1',
    answers: {
      0: { answer: 2, submitted: true, revision: 4 },
      1: { answer: 'text', submitted: true, revision: 1 }
    }
  });
  assert.deepEqual(prepared.grades, [
    { id: 'student-1__0', uid: 'student-1', questionIndex: 0, revision: 4, ok: true },
    { id: 'student-1__1', uid: 'student-1', questionIndex: 1, revision: 1, ok: false }
  ]);
  assert.deepEqual(core.responseLeakPaths(prepared.response), []);
});

test('conflicting or unrepresentable legacy scores block cleanup instead of losing grading', () => {
  const core = require('../migration-core.js');

  const conflict = core.prepareLegacyResponse('student-1', {
    answers: { 0: { answer: 2, revision: 3, ok: true, score: 0 } }
  });
  const partial = core.prepareLegacyResponse('student-1', {
    answers: { 0: { answer: 2, revision: 3, score: 0.5 } }
  });

  assert.equal(conflict.status, 'failed');
  assert.match(conflict.reason, /conflicting/i);
  assert.equal(partial.status, 'failed');
  assert.match(partial.reason, /score/i);
  assert.deepEqual(core.responseLeakPaths(conflict.response), ['answers.0.ok', 'answers.0.score']);
});

test('already clean responses are skipped and mismatched response uid is rejected', () => {
  const core = require('../migration-core.js');
  assert.equal(core.prepareLegacyResponse('student-1', {
    uid: 'student-1', answers: { 0: { answer: 1, submitted: true, revision: 2 } }
  }).status, 'skip');

  const mismatch = core.prepareLegacyResponse('student-1', {
    uid: 'student-2', answers: { 0: { answer: 1, revision: 2, ok: true } }
  });
  assert.equal(mismatch.status, 'failed');
  assert.match(mismatch.reason, /uid/i);
});

test('null legacy grading is removed as ungraded without fabricating a private grade', () => {
  const core = require('../migration-core.js');
  const prepared = core.prepareLegacyResponse('student-1', {
    answers: { 0: { answer: 'essay', submitted: true, revision: 2, ok: null, score: null } }
  });

  assert.equal(prepared.status, 'migrate');
  assert.deepEqual(prepared.response, {
    uid: 'student-1',
    answers: { 0: { answer: 'essay', submitted: true, revision: 2 } }
  });
  assert.deepEqual(prepared.grades, []);
});
