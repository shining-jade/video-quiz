const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../public-quiz-library-core');

const privateSet = {
  title: '  우리 반 과학 퀴즈  ',
  description: '힘과 운동을 복습합니다.',
  author: '원본에 남은 이름',
  settings: { revealMode: 'timer', limitSec: 20, revealDelaySec: 5, autoPause: true },
  videos: [{
    videoId: 'dQw4w9WgXcQ',
    videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startSec: 0,
    endSec: 120,
    ownerEmail: 'leak@example.com',
    questions: [{
      type: 'choice', t: 10, text: '힘의 단위는?', choices: ['N', 'm'], answer: 0,
      studentResponses: [{ email: 'student@example.com' }]
    }]
  }],
  imageCount: 2,
  ownerUid: 'teacher-uid',
  ownerEmail: 'teacher@example.com',
  collaborators: { 'other@example.com': true },
  sessions: [{ id: 'session-1' }],
  responses: [{ id: 'response-1' }],
  scores: [{ score: 100 }],
  plans: [{ id: 'plan-1' }],
  adminAudit: { reason: 'private' }
};

function projection() {
  return Core.buildProjection(privateSet, {
    setId: 'set-1', authorDisplayName: '홍교사', revision: '10:20', nowMs: 100
  });
}

test('projection contains bounded public content and strips every private identity field', () => {
  const value = projection();

  assert.equal(value.status, 'building');
  assert.equal(value.authorDisplayName, '홍교사');
  assert.equal(value.title, '우리 반 과학 퀴즈');
  assert.equal(value.videos[0].ownerEmail, undefined);
  assert.equal(value.videos[0].questions[0].studentResponses, undefined);
  for (const key of [
    'ownerUid', 'ownerEmail', 'collaborators', 'students', 'sessions', 'responses',
    'scores', 'plans', 'adminAudit'
  ]) {
    assert.equal(key in value, false, key + ' must not be public');
  }
  assert.deepEqual(Core.validateProjection(value), { ok: true, errors: [] });
});

test('copy patch is private and resets collaborators and lifecycle counters', () => {
  const value = projection();

  assert.deepEqual(Core.copyPatch(value), {
    publicationId: 'set-1', sourceTitle: value.title,
    sourceAuthorDisplayName: '홍교사', visibility: 'private',
    collaboratorCount: 0, imageCount: value.imageCount, lifecycleState: 'active'
  });
});

test('validation rejects unknown public fields, noncanonical identifiers, unsafe counts, and invalid statuses', () => {
  const value = projection();
  value.ownerUid = 'leaked';
  value.publicationId = 'set/1';
  value.videoCount = Number.MAX_SAFE_INTEGER;
  value.status = 'visible';

  const result = Core.validateProjection(value);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /unknown field: .*ownerUid/.test(error)));
  assert.ok(result.errors.some(error => /publicationId/.test(error)));
  assert.ok(result.errors.some(error => /videoCount/.test(error)));
  assert.ok(result.errors.some(error => /status/.test(error)));
});

test('validation rejects oversized public copy, malformed videos, and malformed questions', () => {
  const value = projection();
  value.description = 'x'.repeat(1001);
  value.videos[0].videoId = 'not a canonical YouTube id';
  value.videos[0].questions[0] = { type: 'choice', t: -1, text: '', choices: ['only one'], answer: 2 };

  const result = Core.validateProjection(value);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /description/.test(error)));
  assert.ok(result.errors.some(error => /videoId/.test(error)));
  assert.ok(result.errors.some(error => /question/.test(error)));
});

test('summary is a bounded allowlist item and never returns publication content', () => {
  const summary = Core.publicSummary(projection());

  assert.deepEqual(Object.keys(summary).sort(), [
    'authorDisplayName', 'description', 'publicationId', 'questionCount', 'title', 'updatedAtMs', 'videoCount'
  ]);
  assert.equal('videos' in summary, false);
  assert.equal('settings' in summary, false);
});
