(function (root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./firestore-core.js')
    : root.FirestoreCore;
  const migrationCore = typeof module === 'object' && module.exports
    ? require('./migration-core.js')
    : root.MigrationCore;
  const api = factory(core, migrationCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, migrationCore) {
  const { timestampMillis, offsetFromRoundTrip, claimFirstAvailableCode, chunk } = core;
  let fallbackLiveTokenSequence = 0;

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

    async function probeLegacyOwner() {
      try {
        await db.doc('config/__legacy_owner_probe__access').get({ source: 'server' });
        return true;
      } catch (error) {
        if (permissionDenied(error)) return false;
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
      batch.set(db.doc('quiz_sets/' + setId), withContentRevision(value));
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
      const deletes = Object.keys(current).filter(questionIndex =>
        questionIndex !== imageKey(questionIndex) ||
        !Object.prototype.hasOwnProperty.call(next, questionIndex)
      );
      const operationCount = 1 + deletes.length + Object.keys(next).length;
      if (operationCount > 500) {
        throw new Error('세트와 이미지를 한 번에 저장할 수 있는 500개 작업 한도를 넘었습니다.');
      }
      const batch = db.batch();
      batch.set(db.doc('quiz_sets/' + setId), {
        contentRevision: fieldValue.serverTimestamp()
      }, { merge: true });
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
            updatedAt: fieldValue.serverTimestamp(),
            contentRevision: fieldValue.serverTimestamp()
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

    function migrationReport(onProgress) {
      const collectionNames = ['sets', 'images', 'sessions', 'students', 'responses', 'snapshots'];
      const report = {
        migrated: [],
        skipped: [],
        failed: [],
        failedIds: [],
        duplicated: 0,
        counts: { migrated: 0, skipped: 0, failed: 0 },
        byCollection: Object.fromEntries(collectionNames.map(name => [name, {
          migrated: [], skipped: [], failed: []
        }])),
        remainingResponseLeakCount: 0,
        remainingResponseLeakIds: [],
        responseAuditFailedIds: [],
        safeToDeployStrictRules: false
      };
      const seen = new Set();
      function add(collectionName, status, id, error) {
        const key = collectionName + ':' + status + ':' + id;
        if (seen.has(key)) return;
        seen.add(key);
        const item = collectionName + ':' + id;
        report.byCollection[collectionName][status].push(id);
        report[status].push(item);
        report.counts[status] += 1;
        if (status === 'failed') report.failedIds.push(item);
        if (error) {
          report.errors = report.errors || {};
          report.errors[item] = String(error && error.message || error);
        }
        if (typeof onProgress === 'function') onProgress(report, {
          collection: collectionName, status, id, error: error || null
        });
      }
      return { report, add };
    }

    async function migrateLegacyOwnership(plan, onProgress) {
      const value = plan || {};
      const teacher = value.teacher || {};
      const email = migrationCore.normalizeEmail(teacher.email);
      if (value.legacyOwnerVerified !== true || !teacher.uid || !email) {
        throw new Error('A verified legacy owner migration plan is required.');
      }
      const { report, add } = migrationReport(onProgress);
      (value.skippedSetIds || []).forEach(id => add('sets', 'skipped', id));
      (value.skippedSessionIds || []).forEach(id => add('sessions', 'skipped', id));

      async function claimParents(collectionName, ids, uidField, emailField) {
        const available = new Set();
        const claimed = new Set();
        for (const group of chunk([...new Set(ids || [])], 400)) {
          const candidates = [];
          for (const id of group) {
            try {
              const reference = db.doc(collectionName + '/' + id);
              const snapshot = await reference.get();
              if (!snapshot.exists) {
                add(collectionName === 'quiz_sets' ? 'sets' : 'sessions', 'skipped', id);
                continue;
              }
              const current = snapshot.data() || {};
              if (current[uidField]) {
                if (current[uidField] === teacher.uid) available.add(id);
                add(collectionName === 'quiz_sets' ? 'sets' : 'sessions', 'skipped', id);
                continue;
              }
              candidates.push({ id, reference });
            } catch (error) {
              add(collectionName === 'quiz_sets' ? 'sets' : 'sessions', 'failed', id, error);
            }
          }
          if (!candidates.length) continue;
          const batch = db.batch();
          candidates.forEach(candidate => batch.set(candidate.reference, {
            [uidField]: teacher.uid,
            [emailField]: email
          }, { merge: true }));
          try {
            await batch.commit();
            candidates.forEach(candidate => {
              available.add(candidate.id);
              claimed.add(candidate.id);
              add(collectionName === 'quiz_sets' ? 'sets' : 'sessions', 'migrated', candidate.id);
            });
          } catch (error) {
            candidates.forEach(candidate =>
              add(collectionName === 'quiz_sets' ? 'sets' : 'sessions', 'failed', candidate.id, error)
            );
          }
        }
        return { available, claimed };
      }

      const sets = await claimParents('quiz_sets', value.setIds, 'ownerUid', 'ownerEmail');
      (value.resumeSetIds || []).forEach(id => sets.available.add(id));
      const imageSetIds = new Set([...sets.available, ...(value.skippedSetIds || [])]);
      for (const setId of imageSetIds) {
        try {
          const images = await db.collection('images/' + setId + '/q').get();
          images.docs.forEach(document => add(
            'images', sets.claimed.has(setId) ? 'migrated' : 'skipped', setId + '/' + document.id
          ));
        } catch (error) {
          add('images', 'failed', setId + '/*', error);
        }
      }

      const sessions = await claimParents('sessions', value.sessionIds, 'teacherUid', 'teacherEmail');
      (value.resumeSessionIds || []).forEach(id => sessions.available.add(id));

      async function backfillSnapshot(sessionId, session) {
        if (!session) return;
        const snapshotReference = db.doc('sessions/' + sessionId + '/snapshot/set');
        const existing = await snapshotReference.get();
        if (existing.exists) {
          add('snapshots', 'skipped', sessionId + '/set');
          return;
        }
        const sourceSnapshot = session.setSnapshot;
        if (!sourceSnapshot || typeof sourceSnapshot !== 'object' || Array.isArray(sourceSnapshot)) {
          add('snapshots', 'skipped', sessionId + '/set');
          return;
        }
        const sourceImages = Object.entries(normalizedImages(session.snapshotImages));
        const existingImages = await db.collection(
          'sessions/' + sessionId + '/snapshot_images'
        ).get();
        const existingIds = new Set(existingImages.docs.map(document => document.id));
        const missingImages = sourceImages.filter(([id]) => !existingIds.has(id));
        for (const group of chunk(missingImages, 400)) {
          const batch = db.batch();
          group.forEach(([id, data]) => batch.set(
            db.doc('sessions/' + sessionId + '/snapshot_images/' + id),
            { data }
          ));
          await batch.commit();
          group.forEach(([id]) => add('snapshots', 'migrated', sessionId + '/image/' + id));
        }
        const sourceData = { ...sourceSnapshot };
        delete sourceData.id;
        const finalBatch = db.batch();
        finalBatch.set(snapshotReference, sourceData);
        finalBatch.set(db.doc('sessions/' + sessionId), { snapshotVersion: 1 }, { merge: true });
        await finalBatch.commit();
        add('snapshots', 'migrated', sessionId + '/set');
      }

      async function migrateResponse(sessionId, document) {
        const id = sessionId + '/' + document.id;
        const prepared = migrationCore.prepareLegacyResponse(document.id, document.data());
        if (prepared.status === 'skip') {
          add('responses', 'skipped', id);
          return;
        }
        if (prepared.status === 'failed') {
          add('responses', 'failed', id, new Error(prepared.reason));
          return;
        }
        const gradeWrites = [];
        for (const grade of prepared.grades) {
          const gradeReference = db.doc('sessions/' + sessionId + '/grades/' + grade.id);
          const current = await gradeReference.get();
          const gradeValue = {
            uid: grade.uid,
            questionIndex: grade.questionIndex,
            revision: grade.revision,
            ok: grade.ok
          };
          if (current.exists) {
            if (JSON.stringify(stableValue(current.data())) !== JSON.stringify(stableValue(gradeValue))) {
              add('responses', 'failed', id, new Error('Existing private grade conflicts with legacy grading.'));
              return;
            }
          } else gradeWrites.push({ reference: gradeReference, value: gradeValue });
        }
        if (gradeWrites.length + 1 > 400) {
          add('responses', 'failed', id, new Error('Response migration exceeds the 400-write batch limit.'));
          return;
        }
        const batch = db.batch();
        gradeWrites.forEach(grade => batch.set(grade.reference, grade.value));
        batch.set(db.doc('sessions/' + sessionId + '/responses/' + document.id), prepared.response);
        try {
          await batch.commit();
          add('responses', 'migrated', id);
        } catch (error) {
          add('responses', 'failed', id, error);
        }
      }

      for (const sessionId of sessions.available) {
        let session = null;
        try {
          const sessionSnapshot = await db.doc('sessions/' + sessionId).get();
          session = sessionSnapshot.exists ? sessionSnapshot.data() : null;
          const students = await db.collection('sessions/' + sessionId + '/students').get();
          students.docs.forEach(document => add(
            'students', sessions.claimed.has(sessionId) ? 'migrated' : 'skipped',
            sessionId + '/' + document.id
          ));
        } catch (error) {
          add('students', 'failed', sessionId + '/*', error);
        }
        try {
          await backfillSnapshot(sessionId, session);
        } catch (error) {
          add('snapshots', 'failed', sessionId + '/set', error);
        }
        try {
          const responses = await db.collection('sessions/' + sessionId + '/responses').get();
          for (const document of responses.docs) await migrateResponse(sessionId, document);
        } catch (error) {
          add('responses', 'failed', sessionId + '/*', error);
        }
      }

      for (const sessionId of value.skippedSessionIds || []) {
        try {
          const students = await db.collection('sessions/' + sessionId + '/students').get();
          students.docs.forEach(document => add('students', 'skipped', sessionId + '/' + document.id));
        } catch (error) {
          add('students', 'failed', sessionId + '/*', error);
        }
        try {
          const responses = await db.collection('sessions/' + sessionId + '/responses').get();
          responses.docs.forEach(document => {
            const id = sessionId + '/' + document.id;
            if (migrationCore.responseLeakPaths(document.data()).length) {
              add('responses', 'failed', id, new Error('Another owner session still contains ok/score.'));
            } else add('responses', 'skipped', id);
          });
        } catch (error) {
          add('responses', 'failed', sessionId + '/*', error);
        }
      }

      const allSessionIds = [...new Set([
        ...(value.sessionIds || []),
        ...(value.resumeSessionIds || []),
        ...(value.skippedSessionIds || [])
      ])];
      const remainingLeakIds = [];
      for (const sessionId of allSessionIds) {
        try {
          const responses = await db.collection('sessions/' + sessionId + '/responses').get();
          responses.docs.forEach(document => {
            if (migrationCore.responseLeakPaths(document.data()).length) {
              remainingLeakIds.push(sessionId + '/' + document.id);
            }
          });
        } catch (error) {
          report.responseAuditFailedIds.push(sessionId);
        }
      }
      report.remainingResponseLeakIds = [...new Set(remainingLeakIds)].sort();
      report.remainingResponseLeakCount = report.remainingResponseLeakIds.length;
      report.safeToDeployStrictRules = report.remainingResponseLeakCount === 0 &&
        report.responseAuditFailedIds.length === 0;
      return report;
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
      probeLegacyOwner,
      migrateLegacyOwnership,
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
    publicQuestion,
    publicAnswer,
    createLiveToken,
    liveIdentity
  };
});
