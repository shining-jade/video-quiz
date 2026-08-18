(function (root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./firestore-core.js')
    : root.FirestoreCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  const { timestampMillis, offsetFromRoundTrip, claimFirstAvailableCode, chunk } = core;

  function createFirestoreStore(db, fieldValue, nowFn) {
    let serverOffset = 0;

    const snapshotValue = snapshot => snapshot.exists
      ? { ...snapshot.data(), id: snapshot.id }
      : null;
    const collectionValue = snapshot => Object.fromEntries(
      snapshot.docs.map(document => [document.id, document.data()])
    );
    const quizSetValue = snapshot => {
      const value = snapshotValue(snapshot);
      if (!value) return null;
      ['createdAt', 'updatedAt'].forEach(field => {
        const millis = timestampMillis(value[field]);
        if (millis !== null) value[field] = millis;
      });
      return value;
    };
    const liveValue = snapshot => {
      const value = snapshotValue(snapshot);
      if (!value) return null;
      const millis = timestampMillis(value.openedAt);
      if (millis !== null) value.openedAt = millis;
      return value;
    };
    const sessionValue = snapshot => {
      const value = snapshotValue(snapshot);
      if (!value) return null;
      ['createdAt', 'endedAt'].forEach(field => {
        const millis = timestampMillis(value[field]);
        if (millis !== null) value[field] = millis;
      });
      return value;
    };
    const withoutDocumentId = value => {
      const { id, ...data } = value || {};
      return data;
    };
    const imageKey = value => {
      const key = String(value == null ? '' : value);
      if (/^\d+$/.test(key)) return 'v0q' + Number(key);
      const match = /^v(\d+)q(\d+)$/.exec(key);
      return match ? 'v' + Number(match[1]) + 'q' + Number(match[2]) : null;
    };
    const normalizedImages = images => {
      const result = {};
      const entries = Object.entries(images || {});
      entries
        .filter(([key]) => /^\d+$/.test(key))
        .concat(entries.filter(([key]) => !/^\d+$/.test(key)))
        .forEach(([key, data]) => {
          const normalizedKey = imageKey(key);
          if (normalizedKey && typeof data === 'string' && data.length > 0) {
            result[normalizedKey] = data;
          }
        });
      return result;
    };

    const permissionDenied = error =>
      String(error && error.code || '').indexOf('permission-denied') >= 0;

    async function probeTeacherAllowance(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) return null;
      const key = encodeURIComponent(normalizedEmail);
      try {
        await db.doc('quiz_sets/__teacher_allowance_probe__' + key).get();
      } catch (error) {
        if (permissionDenied(error)) return null;
        throw error;
      }
      try {
        await db.doc('config/__admin_allowance_probe__' + key).get();
        return { enabled: true, role: 'admin' };
      } catch (error) {
        if (permissionDenied(error)) return { enabled: true, role: 'teacher' };
        throw error;
      }
    }

    async function listQuizSets() {
      const snapshot = await db.collection('quiz_sets').get();
      return snapshot.docs.map(quizSetValue);
    }

    function getQuizSet(setId) {
      return db.doc('quiz_sets/' + setId).get().then(quizSetValue);
    }

    function saveQuizSet(setId, value) {
      return db.doc('quiz_sets/' + setId).set(withoutDocumentId(value));
    }

    const ownedQuizSet = (value, teacher) => ({
      ...withoutDocumentId(value),
      ownerUid: teacher && teacher.uid || '',
      ownerEmail: teacher && teacher.email || ''
    });

    function stableValue(value) {
      if (value && typeof value.toMillis === 'function') return ['timestamp', value.toMillis()];
      if (Array.isArray(value)) return value.map(stableValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
      }
      return value;
    }

    const sameRevision = (left, right) =>
      JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

    async function saveQuizSetWithImages(setId, value, images) {
      const path = 'images/' + setId + '/q';
      const current = await db.collection(path).get().then(collectionValue);
      const next = normalizedImages(images);
      const deletes = Object.keys(current).filter(questionIndex =>
        questionIndex !== imageKey(questionIndex) ||
        !Object.prototype.hasOwnProperty.call(next, questionIndex)
      );
      const operationCount = 1 + deletes.length + Object.keys(next).length;
      if (operationCount > 500) {
        throw new Error('세트와 이미지를 한 번에 저장할 수 있는 500개 작업 한도를 넘었습니다.');
      }
      const batch = db.batch();
      batch.set(db.doc('quiz_sets/' + setId), withoutDocumentId(value));
      deletes.forEach(questionIndex => batch.delete(db.doc(path + '/' + questionIndex)));
      Object.entries(next).forEach(([questionIndex, data]) => {
        batch.set(db.doc(path + '/' + questionIndex), { data });
      });
      await batch.commit();
    }

    function saveOwnedQuizSet(setId, value, images, teacher) {
      return saveQuizSetWithImages(setId, ownedQuizSet(value, teacher), images);
    }

    function patchQuizSet(setId, value) {
      const data = withoutDocumentId(value);
      if (data.archived === false) data.archived = fieldValue.delete();
      return db.doc('quiz_sets/' + setId).set(data, { merge: true });
    }

    async function getQuestionImage(setId, questionIndex) {
      const key = imageKey(questionIndex);
      if (!key) return '';
      let image = await db.doc('images/' + setId + '/q/' + key).get().then(snapshotValue);
      if (!image && key.startsWith('v0q')) {
        image = await db.doc('images/' + setId + '/q/' + key.slice(3)).get().then(snapshotValue);
      }
      return image ? image.data || '' : '';
    }

    async function getImages(setId) {
      const images = await db.collection('images/' + setId + '/q').get().then(collectionValue);
      return normalizedImages(Object.fromEntries(
        Object.entries(images)
          .filter(([, image]) => image && typeof image.data === 'string' && image.data.length > 0)
          .map(([questionIndex, image]) => [questionIndex, image.data])
      ));
    }

    async function replaceImages(setId, images) {
      const path = 'images/' + setId + '/q';
      const current = await db.collection(path).get().then(collectionValue);
      const next = normalizedImages(images);
      const batch = db.batch();
      Object.keys(current).forEach(questionIndex => {
        if (questionIndex !== imageKey(questionIndex) ||
            !Object.prototype.hasOwnProperty.call(next, questionIndex)) {
          batch.delete(db.doc(path + '/' + questionIndex));
        }
      });
      Object.entries(next).forEach(([questionIndex, data]) => {
        batch.set(db.doc(path + '/' + questionIndex), { data });
      });
      await batch.commit();
    }

    async function copyQuizSet(sourceId, newId, patch) {
      const source = await getQuizSet(sourceId);
      if (!source) return null;
      const images = await getImages(sourceId);
      const copy = { ...source, ...(patch || {}), id: newId };
      await saveQuizSetWithImages(newId, copy, images);
      return copy;
    }

    async function copyOwnedQuizSet(sourceId, newId, teacher) {
      const sourceReference = db.doc('quiz_sets/' + sourceId);
      const destinationReference = db.doc('quiz_sets/' + newId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await getQuizSet(sourceId);
        if (!before) return null;
        const images = await getImages(sourceId);
        const entries = Object.entries(normalizedImages(images));
        if (1 + entries.length > 500) {
          throw new Error('세트와 이미지를 한 번에 저장할 수 있는 500개 작업 한도를 넘었습니다.');
        }
        const result = await db.runTransaction(async transaction => {
          const currentSnapshot = await transaction.get(sourceReference);
          const current = quizSetValue(currentSnapshot);
          if (!current) return { missing: true };
          if (!sameRevision(before, current)) return { retry: true };
          const copy = ownedQuizSet({
            ...current,
            id: newId,
            title: ((current.title || '제목 없음') + ' (사본)').slice(0, 200),
            createdAt: fieldValue.serverTimestamp(),
            updatedAt: fieldValue.serverTimestamp()
          }, teacher);
          transaction.set(destinationReference, withoutDocumentId(copy));
          entries.forEach(([questionIndex, data]) => {
            transaction.set(db.doc('images/' + newId + '/q/' + questionIndex), { data });
          });
          return { copy };
        });
        if (result.missing) return null;
        if (!result.retry) return { ...result.copy, id: newId };
      }
      throw new Error('원본 세트가 계속 변경되어 사본을 만들지 못했습니다. 다시 시도해 주세요.');
    }

    function claimSessionCode(code, sessionId, session) {
      const setSnapshot = session && session.setSnapshot;
      const snapshotImages = normalizedImages(session && session.snapshotImages);
      const storedSession = { ...(session || {}) };
      delete storedSession.setSnapshot;
      delete storedSession.snapshotImages;
      if (setSnapshot) storedSession.snapshotVersion = 1;
      const operationCount = 4 + (setSnapshot ? 1 : 0) + Object.keys(snapshotImages).length;
      if (operationCount > 500) {
        return Promise.reject(new Error('세션 snapshot이 Firestore 500개 작업 한도를 넘었습니다.'));
      }
      return db.runTransaction(async transaction => {
        const codeReference = db.doc('codes/' + code);
        const codeSnapshot = await transaction.get(codeReference);
        if (codeSnapshot.exists) return false;

        transaction.set(codeReference, {
          sessionId,
          createdAt: fieldValue.serverTimestamp()
        });
        transaction.set(db.doc('sessions/' + sessionId), storedSession);
        transaction.set(db.doc('sessions/' + sessionId + '/meta/live'), {
          q: -1,
          openedAt: 0,
          revealed: false,
          limitSec: 0
        });
        transaction.set(db.doc('sessions/' + sessionId + '/meta/board'), { scores: {} });
        if (setSnapshot) {
          transaction.set(
            db.doc('sessions/' + sessionId + '/snapshot/set'),
            withoutDocumentId(setSnapshot)
          );
        }
        Object.entries(snapshotImages).forEach(([questionIndex, data]) => {
          transaction.set(
            db.doc('sessions/' + sessionId + '/snapshot_images/' + questionIndex),
            { data }
          );
        });
        return true;
      });
    }

    function startSession(sessionId, session, createCode) {
      const candidates = Array.from({ length: 10 }, () => createCode());
      return claimFirstAvailableCode(
        candidates,
        code => claimSessionCode(code, sessionId, { ...session, code })
      );
    }

    function subscribeStudents(sessionId, next, error) {
      return db.collection('sessions/' + sessionId + '/students')
        .onSnapshot(snapshot => next(collectionValue(snapshot)), error);
    }

    function subscribeResponses(sessionId, next, error) {
      return db.collection('sessions/' + sessionId + '/responses')
        .onSnapshot(snapshot => next(collectionValue(snapshot)), error);
    }

    function subscribeLive(sessionId, next, error) {
      return db.doc('sessions/' + sessionId + '/meta/live')
        .onSnapshot(snapshot => next(liveValue(snapshot)), error);
    }

    function getCode(code) {
      return db.doc('codes/' + code).get().then(snapshotValue);
    }

    function getSession(sessionId) {
      return db.doc('sessions/' + sessionId).get().then(sessionValue);
    }

    async function getSessionQuizSet(sessionId, setId) {
      const snapshot = await db.doc('sessions/' + sessionId + '/snapshot/set').get();
      if (snapshot.exists) {
        const value = { ...snapshot.data() };
        ['createdAt', 'updatedAt'].forEach(field => {
          const millis = timestampMillis(value[field]);
          if (millis !== null) value[field] = millis;
        });
        return value;
      }
      return getQuizSet(setId);
    }

    async function getSessionQuestionImage(sessionId, setId, questionIndex) {
      const key = imageKey(questionIndex);
      if (!key) return '';
      const image = await db.doc(
        'sessions/' + sessionId + '/snapshot_images/' + key
      ).get().then(snapshotValue);
      return image ? image.data || '' : getQuestionImage(setId, key);
    }

    function getStudent(sessionId, studentId) {
      return db.doc('sessions/' + sessionId + '/students/' + studentId).get().then(snapshotValue);
    }

    function saveStudent(sessionId, studentId, student) {
      return db.doc('sessions/' + sessionId + '/students/' + studentId).set(student);
    }

    async function getOwnResponses(sessionId, studentId) {
      const value = await db.doc('sessions/' + sessionId + '/responses/' + studentId)
        .get().then(snapshotValue);
      return value && value.answers ? value.answers : {};
    }

    function mergeAnswer(sessionId, studentId, questionIndex, answer) {
      return db.doc('sessions/' + sessionId + '/responses/' + studentId).set({
        answers: { [String(questionIndex)]: answer }
      }, { merge: true });
    }

    function setAnswerState(sessionId, studentId, questionIndex, answer) {
      return mergeAnswer(sessionId, studentId, questionIndex, answer);
    }

    function gradeAnswer(sessionId, studentId, questionIndex, ok) {
      return db.doc('sessions/' + sessionId + '/responses/' + studentId).set({
        answers: { [String(questionIndex)]: { ok: ok == null ? fieldValue.delete() : ok } }
      }, { merge: true });
    }

    async function listSessions() {
      const snapshot = await db.collection('sessions').get();
      return snapshot.docs.map(sessionValue);
    }

    async function purgeSessions(sessionIds) {
      const references = [];
      for (const sessionId of [...new Set(sessionIds || [])]) {
        for (const collectionName of ['meta', 'students', 'responses', 'snapshot', 'snapshot_images']) {
          const snapshot = await db.collection(
            'sessions/' + sessionId + '/' + collectionName
          ).get();
          snapshot.docs.forEach(document => references.push(document.ref));
        }
        references.push(db.doc('sessions/' + sessionId));

        const codes = await db.collection('codes')
          .where('sessionId', '==', sessionId)
          .get();
        codes.docs.forEach(document => references.push(document.ref));
      }

      for (const group of chunk(references, 450)) {
        const batch = db.batch();
        group.forEach(reference => batch.delete(reference));
        await batch.commit();
      }
    }

    async function getBoard(sessionId) {
      const value = await db.doc('sessions/' + sessionId + '/meta/board')
        .get().then(snapshotValue);
      return value && value.scores ? value.scores : {};
    }

    function setLive(sessionId, live) {
      return db.doc('sessions/' + sessionId + '/meta/live').set(live);
    }

    function revealLive(sessionId) {
      return db.doc('sessions/' + sessionId + '/meta/live')
        .set({ revealed: true }, { merge: true });
    }

    async function endSession(sessionId) {
      await db.doc('sessions/' + sessionId).set({
        status: 'ended',
        endedAt: fieldValue.serverTimestamp()
      }, { merge: true });
      await setLive(sessionId, {
        q: -1,
        openedAt: 0,
        revealed: false,
        limitSec: 0,
        status: 'ended'
      });
    }

    function writeBoard(sessionId, board) {
      return db.doc('sessions/' + sessionId + '/meta/board').set({ scores: board });
    }

    return {
      probeTeacherAllowance,
      listQuizSets,
      getQuizSet,
      saveQuizSet,
      saveQuizSetWithImages,
      saveOwnedQuizSet,
      patchQuizSet,
      getQuestionImage,
      getImages,
      replaceImages,
      copyQuizSet,
      copyOwnedQuizSet,
      startSession,
      subscribeStudents,
      subscribeResponses,
      subscribeLive,
      getCode,
      getSession,
      getSessionQuizSet,
      getSessionQuestionImage,
      getStudent,
      saveStudent,
      getOwnResponses,
      mergeAnswer,
      setAnswerState,
      gradeAnswer,
      listSessions,
      purgeSessions,
      getBoard,
      setLive,
      revealLive,
      endSession,
      writeBoard,

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

      claimSessionCode
    };
  }

  return { createFirestoreStore };
});
