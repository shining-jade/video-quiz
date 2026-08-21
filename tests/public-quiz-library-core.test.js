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
      imgUp: true, explainImgUrl: 'https://images.example/explanation.png',
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

function timestamp(ms) {
  return { toMillis() { return ms; } };
}

test('projection contains bounded public content and strips every private identity field', () => {
  const value = projection();

  assert.equal(value.status, 'building');
  assert.equal(value.publishedAt, null);
  assert.equal(value.updatedAt instanceof Date, true);
  assert.equal(value.authorDisplayName, '홍교사');
  assert.equal(value.title, '우리 반 과학 퀴즈');
  assert.equal(value.videos[0].ownerEmail, undefined);
  assert.equal(value.videos[0].questions[0].studentResponses, undefined);
  assert.equal(value.videos[0].questions[0].imgUp, true);
  assert.equal(value.videos[0].questions[0].explainImgUrl, 'https://images.example/explanation.png');
  for (const key of [
    'ownerUid', 'ownerEmail', 'collaborators', 'students', 'sessions', 'responses',
    'scores', 'plans', 'adminAudit'
  ]) {
    assert.equal(key in value, false, key + ' must not be public');
  }
  assert.deepEqual(Core.validateProjection(value), { ok: true, errors: [] });
  const summary = Core.publicSummary(value);
  assert.equal(summary.updatedAtMs, 100);
  assert.equal('updatedAt' in summary, false);
});

test('flat storage splits exact video and question children and reassembles only a complete revision', () => {
  const value = projection();
  const flat = Core.flattenProjection(value, 'build-token-1');

  assert.equal(Core.PUBLIC_CHILD_SCHEMA_VERSION, 1);
  assert.equal('videos' in flat.parent, false);
  assert.equal('settings' in flat.parent, false);
  assert.deepEqual(Object.keys(flat.videos), ['v0']);
  assert.deepEqual(Object.keys(flat.questions), ['v0q0']);
  assert.deepEqual(Object.keys(flat.videos.v0).sort(), [
    'buildToken', 'endSec', 'revision', 'schemaVersion', 'startSec',
    'videoId', 'videoKey', 'videoUrl'
  ]);
  assert.equal(flat.videos.v0.schemaVersion, 1);
  assert.equal(flat.questions.v0q0.schemaVersion, 1);
  assert.equal(flat.questions.v0q0.reviewerEmail, undefined);
  assert.equal(flat.questions.v0q0.studentResponses, undefined);
  assert.equal(flat.questions.v0q0.questionKey, 'v0q0');
  assert.equal(flat.questions.v0q0.videoKey, 'v0');
  assert.equal(flat.parent.revealMode, value.settings.revealMode);

  const rebuilt = Core.assembleProjection(flat.parent, flat.videos, flat.questions);
  assert.deepEqual(rebuilt, value);
  assert.throws(() => Core.assembleProjection(
    flat.parent,
    flat.videos,
    { ...flat.questions, v0q1: { ...flat.questions.v0q0, questionKey: 'v0q1' } }
  ), /count|question|문항/i);
  assert.throws(() => Core.assembleProjection(
    flat.parent,
    { v0: { ...flat.videos.v0, reviewerEmail: 'private@school.kr' } },
    flat.questions
  ), /unknown field|video/i);
});

test('copy patch is private and starts the destination image counter at zero', () => {
  const value = projection();
  assert.equal(value.imageCount, 2, 'source image count remains available for copy preflight');

  assert.deepEqual(Core.copyPatch(value), {
    publicationId: 'set-1', sourceTitle: value.title,
    sourceAuthorDisplayName: '홍교사', visibility: 'private',
    collaboratorCount: 0, imageCount: 0, lifecycleState: 'active'
  });
});

test('validation rejects unknown public fields, noncanonical identifiers, unsafe counts, and invalid statuses', () => {
  const value = projection();
  value.ownerUid = 'leaked';
  value.publicationId = 'set/1';
  value.videoCount = Number.MAX_SAFE_INTEGER + 1;
  value.status = 'visible';

  const result = Core.validateProjection(value);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /unknown field: .*ownerUid/.test(error)));
  assert.ok(result.errors.some(error => /publicationId/.test(error)));
  assert.ok(result.errors.some(error => /videoCount/.test(error)));
  assert.ok(result.errors.some(error => /status/.test(error)));
});

test('projection keeps a safe source image count without inventing an unsupported 300-image ceiling', () => {
  const source = structuredClone(privateSet);
  source.imageCount = 301;

  const value = Core.buildProjection(source, {
    setId: 'set-301', authorDisplayName: '홍교사', revision: '10:20', nowMs: 100
  });

  assert.equal(value.imageCount, 301);
  assert.deepEqual(Core.copyPatch(value).imageCount, 0);
});

test('projection reuses playlist normalization for a legacy single-video set', () => {
  const legacy = structuredClone(privateSet);
  delete legacy.videos;
  legacy.videoId = 'dQw4w9WgXcQ';
  legacy.videoUrl = 'https://youtu.be/dQw4w9WgXcQ';
  legacy.questions = [{ type: 'choice', t: 10, text: 'legacy', choices: ['a', 'b'], answer: 0 }];

  const value = Core.buildProjection(legacy, {
    setId: 'legacy-1', authorDisplayName: '홍교사', revision: '10:20', nowMs: 100
  });

  assert.equal(value.videos.length, 1);
  assert.equal(value.videos[0].videoUrl, 'https://youtu.be/dQw4w9WgXcQ');
});

test('projection canonicalizes an uppercase HTTPS scheme before Rules-bound storage', () => {
  const source = structuredClone(privateSet);
  source.videos[0].videoUrl = 'HTTPS://www.youtube.com/watch?v=dQw4w9WgXcQ';
  source.videos[0].questions[0].imgUrl = 'HTTPS://images.example/question.png';
  source.videos[0].questions[0].explainImgUrl = 'HTTPS://images.example/explanation.png';

  const value = Core.buildProjection(source, {
    setId: 'https-normalized', authorDisplayName: '홍교사', revision: '10:20', nowMs: 100
  });

  assert.equal(value.videos[0].videoUrl,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(value.videos[0].questions[0].imgUrl,
    'https://images.example/question.png');
  assert.equal(value.videos[0].questions[0].explainImgUrl,
    'https://images.example/explanation.png');
});

test('projection preserves playlist duration bounds that are not public projection fields', () => {
  const source = structuredClone(privateSet);
  source.videos[0].endSec = null;
  source.videos[0].durationSec = 100;
  source.videos[0].questions[0].t = 101;

  assert.throws(() => Core.buildProjection(source, {
    setId: 'duration-1', authorDisplayName: '홍교사', revision: '10:20', nowMs: 100
  }), /playback range/);
});

test('validation rejects YouTube URL/ID mismatches and question times outside the clip', () => {
  const value = projection();
  value.videos[0].videoUrl = 'https://youtu.be/aaaaaaaaaaa';
  value.videos[0].questions[0].t = 121;
  value.videos[0].questions[0].explainImgUrl = 'http://images.example/private.png';

  const result = Core.validateProjection(value);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /videoUrl/.test(error)));
  assert.ok(result.errors.some(error => /question.*clip/.test(error)));
  assert.ok(result.errors.some(error => /explainImgUrl.*https/.test(error)));
});

test('validation keeps editor-compatible choice bounds and exact OX choices', () => {
  const tooLong = projection();
  tooLong.videos[0].questions[0].choices[0] = 'x'.repeat(201);
  const ox = projection();
  ox.videos[0].questions[0] = { type: 'ox', t: 10, text: 'O/X', choices: ['O', 'X', 'extra'], answer: 0 };

  assert.equal(Core.validateProjection(tooLong).ok, false);
  assert.equal(Core.validateProjection(ox).ok, false);
});

test('moderation and publication timestamps have exact state relations', () => {
  const value = projection();
  value.status = 'moderated';
  value.moderationStatus = 'clear';
  value.publishedAt = timestamp(101);
  value.updatedAt = timestamp(100);

  const result = Core.validateProjection(value);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /moderationStatus/.test(error)));
  assert.ok(result.errors.some(error => /updatedAt/.test(error)));
});

test('public storage uses Timestamp-like fields and rejects legacy numeric timestamp fields', () => {
  const value = projection();
  value.status = 'published';
  value.publishedAt = timestamp(90);
  value.updatedAt = timestamp(100);

  assert.deepEqual(Core.validateProjection(value), { ok: true, errors: [] });
  assert.equal(Core.publicSummary(value).updatedAtMs, 100);
  assert.equal('updatedAt' in Core.publicSummary(value), false);
  assert.equal(Core.PUBLIC_KEYS.includes('publishedAt'), true);
  assert.equal(Core.PUBLIC_KEYS.includes('updatedAt'), true);
  assert.equal(Core.PUBLIC_KEYS.includes('publishedAtMs'), false);
  assert.equal(Core.PUBLIC_KEYS.includes('updatedAtMs'), false);

  value.updatedAt = 100;
  value.publishedAtMs = 90;
  const invalid = Core.validateProjection(value);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some(error => /unknown field: .*publishedAtMs/.test(error)));
  assert.ok(invalid.errors.some(error => /updatedAt/.test(error)));
});

test('a hidden rebuilding projection may carry the original valid publishedAt', () => {
  const value = projection();
  value.publishedAt = timestamp(90);
  value.updatedAt = timestamp(100);

  assert.deepEqual(Core.validateProjection(value), { ok: true, errors: [] });
});

test('the exported allowlist cannot weaken internal unknown-field validation', () => {
  const keys = Core.PUBLIC_KEYS;
  assert.throws(() => keys.push('ownerUid'), TypeError);
  const value = projection();
  value.ownerUid = 'leaked';
  assert.equal(Core.validateProjection(value).ok, false);
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
  assert.equal(summary.updatedAtMs, 100);
});

test('cancelled publication parents remain building-shaped hidden tombstones', () => {
  const flat = Core.flattenProjection(projection(), 'cancelled-build-token');
  const cancelled = {
    ...flat.parent,
    status: 'cancelled'
  };

  assert.deepEqual(Core.validateParent(cancelled), { ok: true, errors: [] });
});
