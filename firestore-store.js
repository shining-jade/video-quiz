(function (root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./firestore-core.js')
    : root.FirestoreCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  const { timestampMillis, offsetFromRoundTrip, claimFirstAvailableCode, chunk } = core;
  let fallbackLiveTokenSequence = 0;

  function estimateBatchRequest(set, images) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(JSON.stringify(set || {})).length +
      Object.entries(images || {}).reduce((count, [key, data]) =>
        count + encoder.encode(key).length + encoder.encode(data).length + 64, 0
      );
    const imageWrites = Object.keys(images || {}).length;
    const transformWrites = 2;
    const writes = 1 + imageWrites + transformWrites;
    return {
      writes,
      bytes,
      allowed: writes <= 500 && bytes <= 9_500_000,
      reason: writes > 500 ? 'writes' : bytes > 9_500_000 ? 'bytes' : ''
    };
  }

  function createLiveToken() {
    const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }
    fallbackLiveTokenSequence += 1;
    return Date.now().toString(36) + '-' + fallbackLiveTokenSequence.toString(36) + '-' +
      Math.random().toString(36).slice(2);
  }

  function liveIdentity(live) {
    const value = live || {};
    const q = Number(value.q);
    const openedAt = timestampMillis(value.openedAt);
    const liveToken = typeof value.liveToken === 'string' && value.liveToken
      ? value.liveToken
      : '';
    if (!Number.isInteger(q) || q < 0 || (!liveToken && openedAt === null)) return null;
    const identity = { q };
    if (liveToken) identity.liveToken = liveToken;
    if (openedAt !== null) identity.openedAt = openedAt;
    return identity;
  }

  function sameLiveIdentity(current, expected) {
    const currentIdentity = liveIdentity(current);
    const expectedIdentity = liveIdentity(expected);
    if (!currentIdentity || !expectedIdentity ||
        currentIdentity.q !== expectedIdentity.q) return false;
    if (expectedIdentity.liveToken) {
      return currentIdentity.liveToken === expectedIdentity.liveToken;
    }
    return !currentIdentity.liveToken &&
      currentIdentity.openedAt === expectedIdentity.openedAt;
  }

  function publicQuestion(flatQuestion, number, total, image) {
    const question = flatQuestion || {};
    const choices = question.choices == null ? [] : question.choices;
    if (!Array.isArray(choices) || choices.length > 6 || choices.some(choice => typeof choice !== 'string')) {
      throw new Error('공개 문항 보기는 문자열 6개 이하이어야 합니다.');
    }
    const value = {
      number,
      total,
      type: String(question.type || 'choice'),
      text: String(question.text || ''),
      choices: choices.slice()
    };
    if (typeof image === 'string' && image) value.image = image;
    return value;
  }

  function publicAnswer(flatQuestion) {
    const question = flatQuestion || {};
    const type = String(question.type || 'choice');
    const value = {};
    if (type === 'multi') {
      value.answers = Array.isArray(question.answers) ? question.answers.slice() : [];
    } else if (type === 'short') {
      const accepted = question.accept;
      if (!Array.isArray(accepted) || accepted.length < 1) {
        throw new Error('단답형 인정 답안은 1개 이상이어야 합니다.');
      }
      if (accepted.some(answer => typeof answer !== 'string')) {
        throw new Error('단답형 인정 답안은 모두 문자열이어야 합니다.');
      }
      value.accept = accepted.slice(0, 20).map(answer => answer.slice(0, 100));
    } else if (type === 'long') {
      value.explain = typeof question.explain === 'string' ? question.explain : '';
    } else {
      value.answer = question.answer;
    }
    if (type !== 'long' && typeof question.explain === 'string') value.explain = question.explain;
    return value;
  }

  function createFirestoreStore(db, fieldValue, nowFn) {
    let serverOffset = 0;
    const serverTimestampProbe = fieldValue && typeof fieldValue.serverTimestamp === 'function'
      ? fieldValue.serverTimestamp()
      : null;

    const snapshotValue = snapshot => snapshot.exists
      ? { ...snapshot.data(), id: snapshot.id }
      : null;
    const collectionValue = snapshot => Object.fromEntries(
      snapshot.docs.map(document => [document.id, document.data()])
    );
    const responseRecordValue = record => {
      if (!record || !Object.prototype.hasOwnProperty.call(record, 'answer')) return record;
      const value = { ...record };
      if (Array.isArray(record.answer)) value.cs = record.answer.join(',');
      else if (typeof record.answer === 'string') value.txt = record.answer;
      else value.c = record.answer;
      return value;
    };
    const responseDocumentValue = document => ({
      ...document,
      answers: Object.fromEntries(Object.entries(document && document.answers || {}).map(
        ([questionIndex, answer]) => [questionIndex, responseRecordValue(answer)]
      ))
    });
    const responseCollectionValue = snapshot => Object.fromEntries(
      snapshot.docs.map(document => [document.id, responseDocumentValue(document.data())])
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
      ['openedAt', 'responseClosesAt', 'submitGraceUntil', 'revealAt'].forEach(field => {
        const millis = timestampMillis(value[field]);
        if (millis !== null) value[field] = millis;
      });
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
    const isServerTimestamp = value => {
      if (serverTimestampProbe !== null && value === serverTimestampProbe) return true;
      if (!value || typeof value !== 'object') return false;
      const methodName = value._methodName ||
        value._delegate && value._delegate._methodName || '';
      return methodName === 'FieldValue.serverTimestamp' || methodName === 'serverTimestamp';
    };
    const transformCount = value => {
      if (isServerTimestamp(value)) return 1;
      if (Array.isArray(value)) {
        return value.reduce((count, item) => count + transformCount(item), 0);
      }
      if (value && typeof value === 'object') {
        return Object.values(value).reduce(
          (count, item) => count + transformCount(item), 0
        );
      }
      return 0;
    };
    const requestEstimate = (set, images, extraWrites) => {
      const estimate = estimateBatchRequest(set, images);
      estimate.writes = 1 + Object.keys(images || {}).length +
        transformCount(set) + (Number(extraWrites) || 0);
      estimate.allowed = estimate.writes <= 500 && estimate.bytes <= 9_500_000;
      estimate.reason = estimate.writes > 500
        ? 'writes'
        : estimate.bytes > 9_500_000 ? 'bytes' : '';
      return estimate;
    };
    const assertRequestAllowed = estimate => {
      if (estimate.allowed) return;
      if (estimate.reason === 'writes') {
        throw new Error(
          '세트와 이미지를 한 번에 저장할 수 있는 Firestore 500개 쓰기·변환 한도를 넘었습니다.'
        );
      }
      throw new Error(
        '세트와 이미지 저장 요청이 Firestore 10 MiB 한도에 가까워 저장할 수 없습니다. ' +
        '이미지 크기나 개수를 줄여 주세요.'
      );
    };

    const permissionDenied = error =>
      String(error && error.code || '').indexOf('permission-denied') >= 0;

    async function probeTeacherAllowance(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) return null;
      const key = encodeURIComponent(normalizedEmail);
      try {
        await db.doc('quiz_sets/__teacher_allowance_probe__' + key).get({ source: 'server' });
      } catch (error) {
        if (permissionDenied(error)) return null;
        throw error;
      }
      try {
        await db.doc('config/__admin_allowance_probe__' + key).get({ source: 'server' });
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
    const withContentRevision = value => ({
      ...withoutDocumentId(value),
      contentRevision: fieldValue.serverTimestamp()
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
      const next = normalizedImages(images);
      const storedSet = withContentRevision(value);
      assertRequestAllowed(requestEstimate(storedSet, next));
      const current = await db.collection(path).get().then(collectionValue);
      const deletes = Object.keys(current).filter(questionIndex =>
        questionIndex !== imageKey(questionIndex) ||
        !Object.prototype.hasOwnProperty.call(next, questionIndex)
      );
      assertRequestAllowed(requestEstimate(storedSet, next, deletes.length));
      const batch = db.batch();
      batch.set(db.doc('quiz_sets/' + setId), storedSet);
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

    async function getQuizSetSnapshot(setId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await getQuizSet(setId);
        if (!before) throw new Error('세션 스냅샷을 만들 퀴즈 세트를 찾을 수 없습니다.');
        const snapshotImages = await getImages(setId);
        const after = await getQuizSet(setId);
        if (!after) throw new Error('세션 스냅샷을 만들던 중 퀴즈 세트가 삭제되었습니다.');
        if (sameRevision(before, after)) {
          return { setSnapshot: after, snapshotImages };
        }
      }
      throw new Error('퀴즈 세트가 계속 변경되어 같은 리비전의 세션 스냅샷을 만들지 못했습니다.');
    }

    async function replaceImages(setId, images) {
      const path = 'images/' + setId + '/q';
      const next = normalizedImages(images);
      const revisionPatch = { contentRevision: fieldValue.serverTimestamp() };
      assertRequestAllowed(requestEstimate(revisionPatch, next));
      const current = await db.collection(path).get().then(collectionValue);
      const deletes = Object.keys(current).filter(questionIndex =>
        questionIndex !== imageKey(questionIndex) ||
        !Object.prototype.hasOwnProperty.call(next, questionIndex)
      );
      assertRequestAllowed(requestEstimate(revisionPatch, next, deletes.length));
      const batch = db.batch();
      batch.set(db.doc('quiz_sets/' + setId), revisionPatch, { merge: true });
      deletes.forEach(questionIndex => batch.delete(db.doc(path + '/' + questionIndex)));
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
      const copyValue = current => ownedQuizSet({
        ...current,
        id: newId,
        title: ((current.title || '제목 없음') + ' (사본)').slice(0, 200),
        createdAt: fieldValue.serverTimestamp(),
        updatedAt: fieldValue.serverTimestamp(),
        contentRevision: fieldValue.serverTimestamp()
      }, teacher);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await getQuizSet(sourceId);
        if (!before) return null;
        const images = await getImages(sourceId);
        const entries = Object.entries(normalizedImages(images));
        assertRequestAllowed(requestEstimate(copyValue(before), Object.fromEntries(entries)));
        const result = await db.runTransaction(async transaction => {
          const currentSnapshot = await transaction.get(sourceReference);
          const current = quizSetValue(currentSnapshot);
          if (!current) return { missing: true };
          if (!sameRevision(before, current)) return { retry: true };
          const copy = copyValue(current);
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
      const snapshotRequest = estimateBatchRequest(setSnapshot || {}, snapshotImages);
      snapshotRequest.writes = 4 + (setSnapshot ? 1 : 0) +
        Object.keys(snapshotImages).length + transformCount(storedSession) + 1 +
        transformCount(setSnapshot || {});
      snapshotRequest.bytes += estimateBatchRequest(storedSession, {}).bytes + 512;
      snapshotRequest.allowed = snapshotRequest.writes <= 500 && snapshotRequest.bytes <= 9_500_000;
      snapshotRequest.reason = snapshotRequest.writes > 500
        ? 'writes'
        : snapshotRequest.bytes > 9_500_000 ? 'bytes' : '';
      try {
        assertRequestAllowed(snapshotRequest);
      } catch (error) {
        return Promise.reject(error);
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
        .onSnapshot(snapshot => next(responseCollectionValue(snapshot)), error);
    }

    function subscribeGrades(sessionId, next, error) {
      return db.collection('sessions/' + sessionId + '/grades')
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

    const sessionReader = (sessionOrId, setId) => {
      if (sessionOrId && typeof sessionOrId === 'object') {
        return {
          id: String(sessionOrId.id || ''),
          setId: String(sessionOrId.setId || ''),
          snapshotVersion: sessionOrId.snapshotVersion,
          versioned: Object.prototype.hasOwnProperty.call(sessionOrId, 'snapshotVersion')
        };
      }
      return {
        id: String(sessionOrId || ''),
        setId: String(setId || ''),
        snapshotVersion: undefined,
        versioned: false
      };
    };
    const validSnapshotSet = value => !!value && Array.isArray(value.videos) &&
      value.videos.every(video => video && Array.isArray(video.questions));

    async function getSessionQuizSet(sessionOrId, setId) {
      const session = sessionReader(sessionOrId, setId);
      const strict = session.versioned;
      if (strict && session.snapshotVersion !== 1) {
        throw new Error('지원하지 않는 세션 스냅샷 버전입니다.');
      }
      const snapshot = await db.doc('sessions/' + session.id + '/snapshot/set').get();
      if (snapshot.exists) {
        const value = { ...snapshot.data() };
        if (!validSnapshotSet(value)) {
          if (strict) throw new Error('세션 세트 스냅샷이 손상되었습니다.');
          return getQuizSet(session.setId);
        }
        ['createdAt', 'updatedAt'].forEach(field => {
          const millis = timestampMillis(value[field]);
          if (millis !== null) value[field] = millis;
        });
        return value;
      }
      if (strict) throw new Error('세션 세트 스냅샷을 찾을 수 없습니다.');
      return getQuizSet(session.setId);
    }

    async function getSessionQuestionImage(sessionOrId, setId, questionIndex) {
      const objectSession = sessionOrId && typeof sessionOrId === 'object';
      const session = sessionReader(sessionOrId, objectSession ? undefined : setId);
      const requestedQuestion = objectSession ? setId : questionIndex;
      const strict = session.versioned;
      if (strict && session.snapshotVersion !== 1) {
        throw new Error('지원하지 않는 세션 스냅샷 버전입니다.');
      }
      const key = imageKey(requestedQuestion);
      if (!key) {
        if (strict) throw new Error('세션 스냅샷 이미지 키가 손상되었습니다.');
        return '';
      }
      const image = await db.doc(
        'sessions/' + session.id + '/snapshot_images/' + key
      ).get().then(snapshotValue);
      if (image && typeof image.data === 'string' && image.data) return image.data;
      if (strict) throw new Error('세션 스냅샷 이미지를 찾을 수 없거나 손상되었습니다.');
      return getQuestionImage(session.setId, key);
    }

    function getStudent(sessionId, studentId) {
      return db.doc('sessions/' + sessionId + '/students/' + studentId).get().then(snapshotValue);
    }

    function saveStudent(sessionId, studentId, student) {
      return db.doc('sessions/' + sessionId + '/students/' + studentId).set(student);
    }

    async function joinStudent(sessionId, authUid, profile) {
      const reference = db.doc('sessions/' + sessionId + '/students/' + authUid);
      const current = await reference.get().then(snapshotValue);
      const student = {
        ...(profile || {}),
        uid: authUid,
        joinedAt: current && current.joinedAt || fieldValue.serverTimestamp()
      };
      await reference.set(student);
      return student;
    }

    async function getOwnResponses(sessionId, studentId) {
      const value = await db.doc('sessions/' + sessionId + '/responses/' + studentId)
        .get().then(snapshotValue);
      const answers = value && value.answers ? value.answers : {};
      return Object.fromEntries(Object.entries(answers).map(([question, raw]) => {
        const answer = { ...(raw || {}) };
        delete answer.ok;
        delete answer.score;
        return [question, answer];
      }));
    }

    async function getResponses(sessionId) {
      const snapshot = await db.collection('sessions/' + sessionId + '/responses').get();
      return responseCollectionValue(snapshot);
    }

    async function getGrades(sessionId) {
      const snapshot = await db.collection('sessions/' + sessionId + '/grades').get();
      return collectionValue(snapshot);
    }

    function writeStudentAnswer(sessionId, authUid, questionIndex, patch) {
      const source = patch || {};
      const answer = {
        answer: source.answer,
        submitted: source.submitted,
        revision: source.revision
      };
      if (Object.prototype.hasOwnProperty.call(source, 'submittedAt')) {
        answer.submittedAt = source.submittedAt;
      }
      const reference = db.doc('sessions/' + sessionId + '/responses/' + authUid);
      const answerPath = 'answers.' + String(questionIndex);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) {
          transaction.set(reference, {
            uid: authUid,
            answers: { [String(questionIndex)]: answer }
          });
        } else {
          transaction.update(reference, {
            uid: authUid,
            [answerPath]: answer
          });
        }
      });
    }

    function mergeAnswer(sessionId, authUid, questionIndex, answer) {
      return writeStudentAnswer(sessionId, authUid, questionIndex, answer);
    }

    function setAnswerState(sessionId, authUid, questionIndex, answer) {
      return writeStudentAnswer(sessionId, authUid, questionIndex, answer);
    }

    function gradeAnswer(sessionId, studentId, questionIndex, expectedRevision, ok) {
      const reference = db.doc('sessions/' + sessionId + '/responses/' + studentId);
      const questionKey = String(questionIndex);
      const gradeReference = db.doc(
        'sessions/' + sessionId + '/grades/' + studentId + '__' + questionKey
      );
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) return false;
        const response = snapshot.data() || {};
        const answer = response.answers && response.answers[questionKey];
        if (response.uid !== studentId || !answer || answer.submitted !== true ||
            Number(answer.revision) !== Number(expectedRevision)) return false;
        if (ok == null) transaction.delete(gradeReference);
        else transaction.set(gradeReference, {
          uid: studentId,
          questionIndex: Number(questionIndex),
          revision: Number(expectedRevision),
          ok: !!ok
        });
        return true;
      });
    }

    async function listSessions() {
      const snapshot = await db.collection('sessions').get();
      return snapshot.docs.map(sessionValue);
    }

    async function purgeSessions(sessionIds) {
      const references = [];
      for (const sessionId of [...new Set(sessionIds || [])]) {
        for (const collectionName of [
          'meta', 'students', 'responses', 'grades', 'student_scores', 'snapshot', 'snapshot_images'
        ]) {
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

    async function getOwnScore(sessionId, authUid) {
      const snapshot = await db.doc(
        'sessions/' + sessionId + '/student_scores/' + authUid
      ).get();
      return snapshot.exists ? snapshot.data() : null;
    }

    function setLive(sessionId, live) {
      return db.doc('sessions/' + sessionId + '/meta/live').set(live);
    }

    function updateCurrentLive(sessionId, expectedLive, update, options) {
      const expectedIdentity = liveIdentity(expectedLive);
      if (!expectedIdentity) return Promise.resolve(false);
      const reference = db.doc('sessions/' + sessionId + '/meta/live');
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists || !sameLiveIdentity(snapshot.data(), expectedIdentity)) return false;
        transaction.set(reference, update, options);
        return true;
      });
    }

    function revealLive(sessionId, expectedLive, answer) {
      return updateCurrentLive(
        sessionId,
        expectedLive,
        { revealed: true, publicAnswer: answer },
        { merge: true }
      );
    }

    function freezeLive(sessionId, expectedLive) {
      return updateCurrentLive(
        sessionId,
        expectedLive,
        { accepting: false },
        { merge: true }
      );
    }

    function closeLive(sessionId, expectedLive) {
      return updateCurrentLive(sessionId, expectedLive, {
        q: -1,
        openedAt: 0,
        revealed: false,
        limitSec: 0
      });
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

    function writeBoard(sessionId, board, studentScores) {
      if (!studentScores) {
        return db.doc('sessions/' + sessionId + '/meta/board').set({ scores: board });
      }
      const batch = db.batch();
      batch.set(db.doc('sessions/' + sessionId + '/meta/board'), { scores: board });
      Object.entries(studentScores).forEach(([studentId, score]) => {
        batch.set(db.doc(
          'sessions/' + sessionId + '/student_scores/' + studentId
        ), score);
      });
      return batch.commit();
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
      getQuizSetSnapshot,
      replaceImages,
      copyQuizSet,
      copyOwnedQuizSet,
      startSession,
      subscribeStudents,
      subscribeResponses,
      subscribeGrades,
      subscribeLive,
      getCode,
      getSession,
      getSessionQuizSet,
      getSessionQuestionImage,
      getStudent,
      saveStudent,
      joinStudent,
      getOwnResponses,
      getResponses,
      getGrades,
      writeStudentAnswer,
      mergeAnswer,
      setAnswerState,
      gradeAnswer,
      listSessions,
      purgeSessions,
      getBoard,
      getOwnScore,
      setLive,
      revealLive,
      freezeLive,
      closeLive,
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
        return db.collection(path).get().then(snapshot =>
          /\/responses$/.test(path) ? responseCollectionValue(snapshot) : collectionValue(snapshot)
        );
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

  return {
    createFirestoreStore,
    estimateBatchRequest,
    publicQuestion,
    publicAnswer,
    createLiveToken,
    liveIdentity
  };
});
