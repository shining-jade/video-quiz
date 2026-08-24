'use strict';

const crypto = require('node:crypto');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const ERROR_CODES = new Set([
  'unauthenticated', 'permission-denied', 'invalid-argument', 'resource-exhausted',
  'not-found', 'failed-precondition', 'internal'
]);

class GuestShareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuestShareError';
    this.code = code;
  }
}

function safeCode(error) {
  return error && ERROR_CODES.has(error.code) ? error.code : 'internal';
}

function safeEqualHex(left, right) {
  if (!HASH.test(left || '') || !HASH.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function validateShare(share) {
  if (!share || typeof share !== 'object') throw new GuestShareError('not-found', '진행 링크를 사용할 수 없습니다.');
  if (share.status !== 'active' || share.sourceLifecycleState !== 'active') {
    throw new GuestShareError('not-found', '진행 링크를 사용할 수 없습니다.');
  }
  if (!HASH.test(share.tokenHash || '') || !Number.isSafeInteger(share.revision) || share.revision < 1 ||
      !SAFE_ID.test(share.sourceSetId || '') || !SAFE_ID.test(share.sourceOwnerUid || '')) {
    throw new GuestShareError('failed-precondition', '진행 링크 상태를 확인할 수 없습니다.');
  }
  return share;
}

function createGuestShareExchange(deps) {
  if (!deps || typeof deps.readShare !== 'function' || typeof deps.createCustomToken !== 'function' ||
      typeof deps.checkRateLimit !== 'function' || typeof deps.hashToken !== 'function' ||
      typeof deps.clock !== 'function') throw new TypeError('Guest share exchange dependencies are incomplete.');
  return async function exchange(request) {
    const auth = request && request.auth;
    if (!auth || !SAFE_ID.test(auth.uid || '')) throw new GuestShareError('unauthenticated', '익명 인증이 필요합니다.');
    const provider = auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider;
    if (provider !== 'anonymous') throw new GuestShareError('permission-denied', '새 익명 진행 인증이 필요합니다.');
    const data = request && request.data;
    if (!data || Object.keys(data).some(key => !['shareId', 'token'].includes(key)) ||
        !SAFE_ID.test(data.shareId || '') || !TOKEN.test(data.token || '')) {
      throw new GuestShareError('invalid-argument', '진행 링크 형식이 올바르지 않습니다.');
    }
    if (!(await deps.checkRateLimit(auth.uid))) {
      throw new GuestShareError('resource-exhausted', '잠시 후 다시 시도해 주세요.');
    }
    const share = validateShare(await deps.readShare(data.shareId));
    let suppliedHash;
    try { suppliedHash = await deps.hashToken(data.token); }
    catch (error) { throw new GuestShareError('invalid-argument', '진행 링크 형식이 올바르지 않습니다.'); }
    if (!safeEqualHex(suppliedHash, share.tokenHash)) {
      throw new GuestShareError('not-found', '진행 링크를 사용할 수 없습니다.');
    }
    const now = Math.floor(deps.clock());
    if (!Number.isSafeInteger(now) || now < 0) throw new GuestShareError('internal', '서버 시간을 확인할 수 없습니다.');
    const expiresAt = now + 900;
    const claims = {
      guestShareId: data.shareId,
      guestShareRevision: share.revision,
      guestCapabilityExpiresAt: expiresAt
    };
    const customToken = await deps.createCustomToken(auth.uid, claims);
    return {
      customToken, shareId: data.shareId, revision: share.revision, expiresAt,
      sourceSetId: share.sourceSetId, sourceOwnerUid: share.sourceOwnerUid
    };
  };
}

module.exports = { GuestShareError, createGuestShareExchange, safeCode };
