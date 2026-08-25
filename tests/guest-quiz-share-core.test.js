const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const Core = require('../guest-quiz-share-core.js');

function sampleSet(patch = {}) {
  return {
    id: 'set-1', title: '심폐소생술', description: '수업용',
    ownerUid: 'owner-secret', ownerEmail: 'owner@school.kr', collaborators: ['private'],
    settings: { revealMode: 'timer', limitSec: 20, revealDelaySec: 2, autoPause: true },
    videos: [{ id: 'v1', url: 'https://youtu.be/abcdefghijk', videoId: 'abcdefghijk',
      startSec: 0, endSec: 90, questions: [
        { type: 'choice', t: 12, text: '문제', choices: ['A', 'B'], answer: 1,
          explain: '해설', imgUp: true, explainImgUp: true }
      ] }],
    ...patch
  };
}

test('projection allow-lists run data and excludes private ownership', () => {
  const output = Core.projectQuizSet(sampleSet(), {
    v0q0: 'data:image/png;base64,question',
    v0q0e: 'data:image/png;base64,explain',
    unrelated: 'data:image/png;base64,private'
  });
  assert.equal(output.parent.title, '심폐소생술');
  assert.equal(output.questions[0].answer, 1);
  assert.equal(output.questions[0].imageKey, 'v0q0');
  assert.equal(output.questions[0].explainImageKey, 'v0q0e');
  assert.deepEqual(Object.keys(output.images).sort(), ['v0q0', 'v0q0e']);
  assert.equal(JSON.stringify(output).includes('owner@school.kr'), false);
  assert.equal(JSON.stringify(output).includes('owner-secret'), false);
  assert.equal(Object.hasOwn(output.parent, 'ownerUid'), false);
  assert.equal(Object.isFrozen(output.questions[0]), true);
});

test('projection validates content bounds and supported question types', () => {
  assert.throws(() => Core.projectQuizSet(sampleSet({ title: '' }), {}), /title/i);
  assert.throws(() => Core.projectQuizSet(sampleSet({ videos: [] }), {}), /videos/i);
  const invalid = sampleSet();
  invalid.videos[0].questions[0].type = 'script';
  assert.throws(() => Core.projectQuizSet(invalid, {}), /question type/i);
});

test('projection keeps an open-ended video shareable', () => {
  const set = sampleSet();
  set.videos[0].endSec = null;

  const output = Core.projectQuizSet(set, {});

  assert.equal(output.videos[0].endSec, null);
  assert.equal(output.questions[0].t, 12);
});

test('projection preserves the application question and setting schema', () => {
  const set = sampleSet({
    settings: { revealMode: 'never', limitSec: 0, revealDelaySec: 0, autoPause: true },
    videos: [{
      id: 'v1', url: 'https://youtu.be/abcdefghijk', videoId: 'abcdefghijk',
      startSec: 0, endSec: 90, questions: [
        { type: 'choice', t: 12, text: '객관식', choices: ['A', 'B'], answer: 1, limitSec: 0 },
        { type: 'long', t: 20, text: '서술형', choices: [], answer: 0, limitSec: 0 }
      ]
    }]
  });

  const output = Core.projectQuizSet(set, {});

  assert.equal(output.parent.revealMode, 'never');
  assert.equal(output.parent.limitSec, 0);
  assert.deepEqual(output.questions.map(question => question.type), ['choice', 'long']);
  assert.equal(output.questions[0].limitSec, 0);
  assert.equal(output.questions[1].limitSec, 0);
  assert.equal(Object.hasOwn(output.questions[1], 'answer'), false);
});

test('projection accepts the application share limit of fifty videos', () => {
  const base = sampleSet().videos[0];
  const set = sampleSet({ videos: Array.from({ length: 50 }, (_, index) => ({
    ...base,
    videoId: 'video-' + index,
    questions: []
  })) });

  assert.equal(Core.projectQuizSet(set, {}).videos.length, 50);
});

test('random token has exact url-safe entropy', () => {
  const token = Core.randomToken(32, crypto);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => Core.randomToken(15, crypto), /byteLength/);
});

test('guest route accepts one 43-character share id and no query capability', () => {
  const shareId = 'A'.repeat(43);
  assert.deepEqual(Core.parseGuestRoute(shareId, ''), { shareId });
  assert.deepEqual(Core.parseGuestRoute(shareId, 'token=legacy'), { invalid: true });
  assert.deepEqual(Core.parseGuestRoute('short', ''), { invalid: true });
});

test('share lifecycle never revives a revoked identity', () => {
  const shareId = 'A'.repeat(43);
  const active = Core.nextShareState(null, { type: 'create', shareId }, 10);
  assert.equal(active.status, 'active');
  assert.equal(Object.hasOwn(active, 'tokenHash'), false);
  const revoked = Core.nextShareState(active, { type: 'revoke' }, 20);
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => Core.nextShareState(revoked, { type: 'refresh', revision: 2 }, 30), /revoked/i);
  assert.throws(() => Core.nextShareState(revoked, { type: 'create', shareId }, 30), /new share/i);
});
