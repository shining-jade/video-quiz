const test = require('node:test');
const assert = require('node:assert/strict');

test('legacy response grading moves to private revision grades and removes public leaks', () => {
  const core = require('../migration-core.js');
  const prepared = core.prepareLegacyResponse('student-1', {
    answers: {
      0: { answer: 2, submitted: true, revision: 4, ok: true, score: 1 },
      1: { answer: 'text', submitted: true, revision: 2, ok: false }
    }
  });

  assert.equal(prepared.status, 'migrate');
  assert.deepEqual(prepared.response, {
    uid: 'student-1',
    answers: {
      0: { answer: 2, submitted: true, revision: 4 },
      1: { answer: 'text', submitted: true, revision: 2 }
    }
  });
  assert.deepEqual(prepared.grades, [
    { id: 'student-1__0', uid: 'student-1', questionIndex: 0, revision: 4, ok: true },
    { id: 'student-1__1', uid: 'student-1', questionIndex: 1, revision: 2, ok: false }
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

test('every present non-null ok and score value is independently validated', () => {
  const core = require('../migration-core.js');
  const invalidOk = core.prepareLegacyResponse('student-1', {
    answers: { 0: { answer: 1, revision: 2, ok: 'yes', score: 1 } }
  });
  const invalidScore = core.prepareLegacyResponse('student-1', {
    answers: { 0: { answer: 1, revision: 2, ok: true, score: '1' } }
  });

  assert.equal(invalidOk.status, 'failed');
  assert.match(invalidOk.reason, /ok/i);
  assert.equal(invalidScore.status, 'failed');
  assert.match(invalidScore.reason, /score/i);
});

test('question keys must be canonical safe non-negative integers', () => {
  const core = require('../migration-core.js');
  for (const questionKey of ['01', '+1', '1.0', '9007199254740992']) {
    const prepared = core.prepareLegacyResponse('student-1', {
      answers: { [questionKey]: { answer: 1, revision: 2, ok: true } }
    });
    assert.equal(prepared.status, 'failed', questionKey);
    assert.match(prepared.reason, /question index/i, questionKey);
  }
});

test('correctness-bearing leaves without an explicit positive integer revision fail closed', () => {
  const core = require('../migration-core.js');
  for (const revision of [undefined, null, 0, '2', 1.5]) {
    const answer = { answer: 1, ok: true };
    if (revision !== undefined) answer.revision = revision;
    const prepared = core.prepareLegacyResponse('student-1', { answers: { 0: answer } });
    assert.equal(prepared.status, 'failed', String(revision));
    assert.match(prepared.reason, /revision/i, String(revision));
  }
});

test('null grading without a revision is removed without inventing one', () => {
  const core = require('../migration-core.js');
  const prepared = core.prepareLegacyResponse('student-1', {
    answers: { 0: { answer: 'essay', ok: null, score: null } }
  });

  assert.equal(prepared.status, 'migrate');
  assert.deepEqual(prepared.response, {
    uid: 'student-1', answers: { 0: { answer: 'essay' } }
  });
  assert.deepEqual(prepared.grades, []);
});
