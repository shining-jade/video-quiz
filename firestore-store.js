(function (root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./firestore-core.js')
    : root.FirestoreCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  const { timestampMillis, offsetFromRoundTrip } = core;

  function createFirestoreStore(db, fieldValue, nowFn) {
    let serverOffset = 0;

    const snapshotValue = snapshot => snapshot.exists
      ? { ...snapshot.data(), id: snapshot.id }
      : null;
    const collectionValue = snapshot => Object.fromEntries(
      snapshot.docs.map(document => [document.id, document.data()])
    );

    return {
      getDoc(path) {
        return db.doc(path).get().then(snapshotValue);
      },

      setDoc(path, value) {
        return db.doc(path).set(value);
      },

      mergeDoc(path, value) {
        return db.doc(path).set(value, { merge: true });
      },

      deleteDoc(path) {
        return db.doc(path).delete();
      },

      getCollection(path) {
        return db.collection(path).get().then(collectionValue);
      },

      subscribeDoc(path, next, error) {
        return db.doc(path).onSnapshot(snapshot => next(snapshotValue(snapshot)), error);
      },

      subscribeCollection(path, next, error) {
        return db.collection(path).onSnapshot(snapshot => next(collectionValue(snapshot)), error);
      },

      async syncClock(path) {
        const reference = db.doc(path);
        const startedAt = nowFn();
        try {
          await reference.set({ at: fieldValue.serverTimestamp() });
          const snapshot = await reference.get();
          const finishedAt = nowFn();
          const serverMillis = snapshot.exists
            ? timestampMillis(snapshot.data().at)
            : null;
          if (serverMillis === null) throw new Error('서버 시각을 읽지 못했습니다');
          serverOffset = offsetFromRoundTrip(serverMillis, startedAt, finishedAt);
        } finally {
          await reference.delete();
        }
      },

      serverNow() {
        return nowFn() + serverOffset;
      },

      claimSessionCode(code, sessionId, session) {
        return db.runTransaction(async transaction => {
          const codeReference = db.doc('codes/' + code);
          const codeSnapshot = await transaction.get(codeReference);
          if (codeSnapshot.exists) return false;

          transaction.set(codeReference, {
            sessionId,
            createdAt: fieldValue.serverTimestamp()
          });
          transaction.set(db.doc('sessions/' + sessionId), session);
          transaction.set(db.doc('sessions/' + sessionId + '/meta/live'), {
            q: -1,
            openedAt: 0,
            revealed: false,
            limitSec: 0
          });
          transaction.set(db.doc('sessions/' + sessionId + '/meta/board'), { scores: {} });
          return true;
        });
      }
    };
  }

  return { createFirestoreStore };
});
