'use strict';

const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createGuestShareExchange, safeCode } = require('./guest-share-service');

if (!getApps().length) initializeApp();
const db = getFirestore();
const auth = getAuth();

async function readShare(shareId) {
  const shareSnapshot = await db.doc(`guest_quiz_shares/${shareId}`).get();
  if (!shareSnapshot.exists) return null;
  const share = shareSnapshot.data() || {};
  const [sourceSnapshot, allowanceSnapshot] = await Promise.all([
    db.doc(`quiz_sets/${String(share.sourceSetId || '')}`).get(),
    db.doc(`teacher_allowances/${String(share.sourceOwnerUid || '')}`).get()
  ]);
  const source = sourceSnapshot.exists ? sourceSnapshot.data() || {} : {};
  const allowance = allowanceSnapshot.exists ? allowanceSnapshot.data() || {} : {};
  return {
    ...share,
    sourceLifecycleState: source.ownerUid === share.sourceOwnerUid &&
      source.lifecycleState === 'active' && allowance.uid === share.sourceOwnerUid &&
      allowance.status === 'active' ? 'active' : 'blocked'
  };
}

async function checkRateLimit(uid) {
  const ref = db.doc(`guest_share_rate_limits/${uid}`);
  const now = Date.now();
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const value = snapshot.exists ? snapshot.data() || {} : {};
    const started = Number(value.windowStartedAtMs) || 0;
    const current = now - started < 60000 ? Number(value.count) || 0 : 0;
    if (current >= 12) return false;
    transaction.set(ref, {
      windowStartedAtMs: current ? started : now,
      count: current + 1,
      updatedAtMs: now
    });
    return true;
  });
}

const exchange = createGuestShareExchange({
  readShare,
  checkRateLimit,
  createCustomToken: (uid, claims) => auth.createCustomToken(uid, claims),
  hashToken: token => crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
  clock: () => Math.floor(Date.now() / 1000)
});

exports.exchangeGuestQuizShare = onCall({ region: 'asia-northeast3', enforceAppCheck: false }, async request => {
  try { return await exchange(request); }
  catch (error) {
    const code = safeCode(error);
    const message = code === 'internal' ? '진행 링크를 확인하지 못했습니다.' : error.message;
    throw new HttpsError(code, message);
  }
});

