const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGuestShareExchange, safeCode } = require('../functions/guest-share-service.js');

const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const secret = 'secret-token-123456';

function fixture(patch = {}) {
  const calls = { tokens: [], limits: [] };
  const share = { status: 'active', tokenHash: hash(secret), revision: 7,
    sourceSetId: 'set-1', sourceOwnerUid: 'owner-a', sourceLifecycleState: 'active', ...patch };
  return {
    calls,
    handler: createGuestShareExchange({
      async readShare(id) { return id === 'share-a' ? share : null; },
      async createCustomToken(uid, claims) { calls.tokens.push({ uid, claims }); return 'signed-token'; },
      async checkRateLimit(uid) { calls.limits.push(uid); return true; },
      hashToken: hash,
      clock: () => 1000
    })
  };
}

function request(data = { shareId: 'share-a', token: secret }, authPatch = {}) {
  return {
    auth: { uid: 'anon-a', token: { firebase: { sign_in_provider: 'anonymous' } }, ...authPatch },
    data
  };
}

test('exchange binds a short-lived share capability to the anonymous caller uid', async () => {
  const { handler, calls } = fixture();
  const result = await handler(request());
  assert.deepEqual(result, { customToken: 'signed-token', shareId: 'share-a', revision: 7, expiresAt: 1900 });
  assert.deepEqual(calls.tokens[0], { uid: 'anon-a', claims: {
    guestShareId: 'share-a', guestShareRevision: 7, guestCapabilityExpiresAt: 1900
  } });
  assert.deepEqual(calls.limits, ['anon-a']);
});

test('exchange rejects unauthenticated, non-anonymous, malformed and rate-limited callers', async () => {
  const { handler } = fixture();
  await assert.rejects(() => handler({ data: request().data }), error => safeCode(error) === 'unauthenticated');
  await assert.rejects(() => handler(request(undefined, {
    token: { firebase: { sign_in_provider: 'google.com' } }
  })), error => safeCode(error) === 'permission-denied');
  await assert.rejects(() => handler(request({ shareId: 'bad/id', token: 'secret' })),
    error => safeCode(error) === 'invalid-argument');
  const limited = createGuestShareExchange({ readShare: async () => null,
    checkRateLimit: async () => false, hashToken: hash, clock: () => 1000,
    createCustomToken: async () => 'unused' });
  await assert.rejects(() => limited(request()), error => safeCode(error) === 'resource-exhausted');
});

test('exchange rejects missing, revoked, disabled and wrong-secret shares without leaking secrets', async () => {
  for (const patch of [null, { status: 'revoked' }, { sourceLifecycleState: 'trashed' }]) {
    const deps = fixture(patch || {});
    if (patch === null) deps.handler = createGuestShareExchange({
      readShare: async () => null, createCustomToken: async () => 'unused',
      checkRateLimit: async () => true, hashToken: hash, clock: () => 1000
    });
    await assert.rejects(() => deps.handler(request()), error => {
      assert.equal(JSON.stringify(error).includes('secret'), false);
      assert.equal(JSON.stringify(error).includes(hash(secret)), false);
      return safeCode(error) === 'not-found';
    });
  }
  const wrong = fixture();
  await assert.rejects(() => wrong.handler(request({ shareId: 'share-a', token: 'wrong-token-123456' })),
    error => safeCode(error) === 'not-found');
});

test('exchange rejects malformed authoritative share state', async () => {
  for (const patch of [{ revision: 0 }, { tokenHash: 'bad' }, { sourceOwnerUid: '' }]) {
    const { handler } = fixture(patch);
    await assert.rejects(() => handler(request()), error => safeCode(error) === 'failed-precondition');
  }
});
