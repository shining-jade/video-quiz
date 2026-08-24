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
        { type: 'mc', t: 12, text: '문제', choices: ['A', 'B'], answer: 1,
          explain: '해설', imgUp: true, explainImgUp: true }
      ] }],
    ...patch
  };
}

test('projection allow-lists run data and excludes private ownership', () => {
  const output = Core.projectQuizSet(sampleSet(), {
    v0q0: 'data:image/png;base64,question',
    v0q0_explain: 'data:image/png;base64,explain',
    unrelated: 'data:image/png;base64,private'
  });
  assert.equal(output.parent.title, '심폐소생술');
  assert.equal(output.questions[0].answer, 1);
  assert.equal(output.questions[0].imageKey, 'v0q0');
  assert.equal(output.questions[0].explainImageKey, 'v0q0_explain');
  assert.deepEqual(Object.keys(output.images).sort(), ['v0q0', 'v0q0_explain']);
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

test('random token has exact url-safe entropy and sha256 is canonical', async () => {
  const token = Core.randomToken(32, crypto);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await Core.sha256Hex('secret', crypto),
    '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b');
  assert.throws(() => Core.randomToken(15, crypto), /byteLength/);
});

test('guest route accepts one bounded share and token only', () => {
  assert.deepEqual(Core.parseGuestRoute('share_ABC-123', 'token=abc_DEF-123'), {
    shareId: 'share_ABC-123', token: 'abc_DEF-123'
  });
  assert.deepEqual(Core.parseGuestRoute('bad/id', 'token=abc'), { invalid: true });
  assert.deepEqual(Core.parseGuestRoute('share-a', 'token=a&token=b'), { invalid: true });
  assert.deepEqual(Core.parseGuestRoute('share-a', 'token=a&extra=b'), { invalid: true });
});

test('guest claims expire and bind exact share revision', () => {
  const claims = { guestShareId: 'share-a', guestShareRevision: 4, guestCapabilityExpiresAt: 200 };
  assert.equal(Core.guestClaimsValid(claims, 'share-a', 4, 199), true);
  assert.equal(Core.guestClaimsValid(claims, 'share-a', 3, 199), false);
  assert.equal(Core.guestClaimsValid(claims, 'share-a', 4, 200), false);
});

test('share lifecycle never revives a revoked identity', () => {
  const active = Core.nextShareState(null, { type: 'create', shareId: 'share-a', tokenHash: 'a'.repeat(64) }, 10);
  assert.equal(active.status, 'active');
  const revoked = Core.nextShareState(active, { type: 'revoke' }, 20);
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => Core.nextShareState(revoked, { type: 'refresh', revision: 2 }, 30), /revoked/i);
  assert.throws(() => Core.nextShareState(revoked, { type: 'create', shareId: 'share-a', tokenHash: 'b'.repeat(64) }, 30), /new share/i);
});
