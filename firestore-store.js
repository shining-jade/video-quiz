(function (root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./firestore-core.js')
    : root.FirestoreCore;
  const collaboration = typeof module === 'object' && module.exports
    ? require('./collaboration-trash-core.js')
    : root.CollaborationTrashCore;
  const teacherAccess = typeof module === 'object' && module.exports
    ? require('./teacher-access-request-core.js')
    : root.TeacherAccessRequestCore;
  const classPlanning = typeof module === 'object' && module.exports
    ? require('./class-planning-core.js')
    : root.ClassPlanningCore;
  const publicQuizLibrary = typeof module === 'object' && module.exports
    ? require('./public-quiz-library-core.js')
    : root.PublicQuizLibraryCore;
  const publicAuthorLabel = typeof module === 'object' && module.exports
    ? require('./public-author-label-core.js')
    : root.PublicAuthorLabelCore;
  const guestQuizShare = typeof module === 'object' && module.exports
    ? require('./guest-quiz-share-core.js')
    : root.GuestQuizShareCore;
  const firestoreTimestamp = typeof module === 'object' && module.exports
    ? require('firebase/firestore').Timestamp
    : root.firebase && root.firebase.firestore && root.firebase.firestore.Timestamp;
  const api = factory(
    core, collaboration, teacherAccess, classPlanning, publicQuizLibrary, publicAuthorLabel, guestQuizShare,
    firestoreTimestamp
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  core, collaboration, teacherAccess, classPlanning, publicQuizLibrary, publicAuthorLabel, guestQuizShare,
  FirestoreTimestamp
) {
  const { timestampMillis, offsetFromRoundTrip, claimFirstAvailableCode, chunk } = core;
  let fallbackLiveTokenSequence = 0;
  const SAFE_REQUEST_BYTES = 8_000_000;

  const utf8Bytes = value => new TextEncoder().encode(String(value == null ? '' : value)).length;
  const jsonBytes = value => utf8Bytes(JSON.stringify(value == null ? {} : value));
  function indexByteEstimate(value, fieldPath, documentPath) {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value)) {
      return value.reduce((count, item, index) =>
        count + indexByteEstimate(item, (fieldPath || '') + '.' + index, documentPath), 0
      );
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).reduce((count, [key, item]) =>
        count + indexByteEstimate(item, fieldPath ? fieldPath + '.' + key : key, documentPath), 0
      );
    }
    return 2 * (
      Math.min(utf8Bytes(value), 1_500) + utf8Bytes(fieldPath) + utf8Bytes(documentPath) + 48
    );
  }

  function operationByteEstimate(operation) {
    const value = operation && operation.value;
    return utf8Bytes(operation && operation.path) + 256 + jsonBytes(value) +
      indexByteEstimate(value, '', operation && operation.path);
  }

  function estimateResult(writes, bytes) {
    return {
      writes,
      bytes,
      allowed: writes <= 500 && bytes <= SAFE_REQUEST_BYTES,
      reason: writes > 500 ? 'writes' : bytes > SAFE_REQUEST_BYTES ? 'bytes' : ''
    };
  }

  function estimateBatchRequest(set, images) {
    const operations = [{ path: 'quiz_sets/estimated-set', value: set || {} }]
      .concat(Object.entries(images || {}).map(([key, data]) => ({
        path: 'images/estimated-set/q/' + key,
        value: { data }
      })));
    const imageWrites = Object.keys(images || {}).length;
    const transformWrites = 2;
    const writes = 1 + imageWrites + transformWrites;
    return estimateResult(
      writes,
      operations.reduce((count, operation) => count + operationByteEstimate(operation), 0)
    );
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
    if (!Array.isArray(choices) || choices.length > 6 || choices.some(choice =>
      typeof choice !== 'string' || choice.length > 200)) {
      throw new Error('공개 문항 보기는 문자열 6개 이하이어야 합니다.');
    }
    const text = String(question.text || '');
    if (text.length > 1000) throw new Error('공개 문항은 1000자 이하여야 합니다.');
    const value = {
      number,
      total,
      type: String(question.type || 'choice'),
      text,
      choices: choices.slice()
    };
    if (typeof image === 'string' && image) {
      const permitted = image.startsWith('data:image/') || /^https:\/\//i.test(image);
      if (!permitted || image.length > 380100) {
        throw new Error('공개 이미지는 허용된 형식과 크기여야 합니다.');
      }
      value.image = image;
    }
    return value;
  }

  function validateStudentAnswer(publicQuestionValue, answer) {
    const question = publicQuestionValue || {};
    const type = String(question.type || 'choice');
    const choices = Array.isArray(question.choices) ? question.choices : [];
    if (type === 'choice' || type === 'mc') {
      if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
        throw new Error('객관식 답안이 보기 범위를 벗어났습니다.');
      }
    } else if (type === 'multi') {
      if (!Array.isArray(answer) || answer.length < 1 || answer.length > choices.length ||
          answer.some(value => !Number.isInteger(value) || value < 0 || value >= choices.length) ||
          new Set(answer).size !== answer.length) {
        throw new Error(new Set(answer || []).size !== (answer || []).length
          ? '복수 선택 답안에 중복이 있습니다.' : '복수 선택 답안이 보기 범위를 벗어났습니다.');
      }
    } else if (type === 'short') {
      if (typeof answer !== 'string' || answer.length > 100) throw new Error('단답형 답안은 100자 이하여야 합니다.');
    } else if (type === 'long') {
      if (typeof answer !== 'string' || answer.length > 1000) throw new Error('서술형 답안은 1000자 이하여야 합니다.');
    } else {
      throw new Error('지원하지 않는 문항 유형입니다.');
    }
    return true;
  }

  function publicAnswer(flatQuestion, explainImage) {
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
      value.explain = typeof question.explain === 'string' ? question.explain.slice(0, 1000) : '';
    } else {
      value.answer = question.answer;
    }
    if (type !== 'long' && typeof question.explain === 'string') {
      value.explain = question.explain.slice(0, 1000);
    }
    if (typeof explainImage === 'string' && explainImage) {
      const permitted = explainImage.startsWith('data:image/') || /^https:\/\//i.test(explainImage);
      if (!permitted || explainImage.length > 380100) {
        throw new Error('공개 해설 이미지는 허용된 형식과 크기여야 합니다.');
      }
      value.explainImage = explainImage;
    }
    return value;
  }

  function createFirestoreStore(db, fieldValue, nowFn) {
    // Rules는 activationLeaseUntil을 request.time + 120초까지만 허용한다. 리스를 상한과
    // 똑같이 계산하면 여유가 0초라, 기기 시계가 서버보다 조금이라도 빠르면 반 활성화가
    // permission-denied로 거부된다(그래서 "됐다 안 됐다" 한다). 시계 오차 여유를 빼고
    // 요청한다. 하트비트가 60초마다 갱신하므로 90초 리스로도 수업은 끊기지 않는다.
    const SESSION_ACTIVATION_LEASE_LIMIT_MS = 120_000;
    const SESSION_ACTIVATION_CLOCK_SKEW_MS = 30_000;
    const SESSION_ACTIVATION_LEASE_MS =
      SESSION_ACTIVATION_LEASE_LIMIT_MS - SESSION_ACTIVATION_CLOCK_SKEW_MS;
    let serverOffset = 0;
    const serverNow = () => nowFn() + serverOffset;
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
      const match = /^v(\d+)q(\d+)(e?)$/.exec(key);
      return match ? 'v' + Number(match[1]) + 'q' + Number(match[2]) + match[3] : null;
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
    const operationsEstimate = operations => {
      const writes = operations.length + operations.reduce(
        (count, operation) => count + transformCount(operation.value), 0
      );
      const bytes = operations.reduce(
        (count, operation) => count + operationByteEstimate(operation), 0
      );
      return estimateResult(writes, bytes);
    };
    const requestEstimate = (set, images, options) => {
      const config = options || {};
      const setPath = config.setPath || 'quiz_sets/estimated-set';
      const imagePath = config.imagePath || 'images/estimated-set/q';
      const operations = [{ path: setPath, value: set }]
        .concat(Object.entries(images || {}).map(([key, data]) => ({
          path: imagePath + '/' + key,
          value: { data }
        })))
        .concat(Object.entries(config.deleteDocuments || {}).map(([key, value]) => ({
          path: imagePath + '/' + key,
          value
        })));
      const estimate = operationsEstimate(operations);
      estimate.bytes += Object.entries(config.previousDocuments || {}).reduce(
        (count, [path, value]) => count + operationByteEstimate({ path, value }), 0
      );
      estimate.allowed = estimate.writes <= 500 && estimate.bytes <= SAFE_REQUEST_BYTES;
      estimate.reason = estimate.writes > 500
        ? 'writes' : estimate.bytes > SAFE_REQUEST_BYTES ? 'bytes' : '';
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
        '세트와 이미지 저장 요청이 Firestore 10 MiB 한도를 안전하게 지키는 8 MB 사전 제한을 넘었습니다. ' +
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

    const canonicalTeacherEmail = email => String(email == null ? '' : email).trim().toLowerCase();

    function teacherAccessCore() {
      const value = teacherAccess ||
        (typeof globalThis !== 'undefined' && globalThis.TeacherAccessRequestCore);
      if (!value || typeof value.validateRequest !== 'function') {
        throw new Error('TeacherAccessRequestCore가 준비되지 않았습니다.');
      }
      return value;
    }

    const teacherRequestBaseKeys = [
      'uid', 'emailCanonical', 'displayName', 'organization', 'note',
      'status', 'revision', 'createdAt', 'updatedAt'
    ];
    const teacherRequestDecisionKeys = teacherRequestBaseKeys.concat([
      'decidedAt', 'decidedByUid', 'decisionReason'
    ]);

    const ownKeysOnly = (value, allowed) => {
      const keys = Object.keys(value || {});
      return keys.length === allowed.length && keys.every(key => allowed.includes(key));
    };

    function teacherRequestValue(snapshot) {
      if (!snapshot || !snapshot.exists) return null;
      const data = snapshot.data() || {};
      const value = { ...data };
      const createdAtMs = timestampMillis(data.createdAt);
      const updatedAtMs = timestampMillis(data.updatedAt);
      delete value.createdAt;
      delete value.updatedAt;
      value.createdAtMs = createdAtMs;
      value.updatedAtMs = updatedAtMs;
      if (Object.prototype.hasOwnProperty.call(data, 'decidedAt')) {
        value.decidedAtMs = timestampMillis(data.decidedAt);
        delete value.decidedAt;
      }
      return value;
    }

    function assertStoredTeacherRequest(data, uid, requiredStatus) {
      const value = data || {};
      const decided = value.status !== 'pending' && value.status !== 'cancelled';
      const allowed = decided ? teacherRequestDecisionKeys : teacherRequestBaseKeys;
      if (!ownKeysOnly(value, allowed)) {
        throw new Error('교사 신청 문서에 허용되지 않은 필드가 있습니다.');
      }
      const request = {
        ...value,
        createdAtMs: timestampMillis(value.createdAt),
        updatedAtMs: timestampMillis(value.updatedAt)
      };
      delete request.createdAt;
      delete request.updatedAt;
      if (Object.prototype.hasOwnProperty.call(value, 'decidedAt')) {
        request.decidedAtMs = timestampMillis(value.decidedAt);
        delete request.decidedAt;
      }
      const validation = teacherAccessCore().validateRequest(request);
      if (!validation.ok || request.uid !== uid ||
          request.emailCanonical !== canonicalTeacherEmail(request.emailCanonical)) {
        throw new Error('교사 신청 신원 또는 문서 형식이 유효하지 않습니다.');
      }
      if (requiredStatus && request.status !== requiredStatus) {
        throw new Error(requiredStatus + ' 교사 신청만 처리할 수 있습니다.');
      }
      return request;
    }

    function assertNewTeacherRequest(request) {
      const value = request || {};
      const allowed = [
        'uid', 'emailCanonical', 'displayName', 'organization', 'note',
        'status', 'revision', 'createdAtMs', 'updatedAtMs'
      ];
      const access = teacherAccessCore();
      const validation = typeof access.validateNewRequest === 'function'
        ? access.validateNewRequest(value) : access.validateRequest(value);
      if (!ownKeysOnly(value, allowed) || !validation.ok || value.status !== 'pending' ||
          value.revision !== 1 || value.emailCanonical !== canonicalTeacherEmail(value.emailCanonical)) {
        throw new Error('invalid 교사 신청: 허용되지 않은 필드 또는 신원 값입니다.');
      }
      return value;
    }

    function assertUid(uid) {
      if (typeof uid !== 'string' || !uid) throw new Error('교사 UID가 필요합니다.');
      return uid;
    }

    function assertExpectedRevision(revision) {
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('정확한 positive safe integer revision이 필요합니다.');
      }
      return revision;
    }

    function assertAdminIdentity(actor) {
      const value = actor || {};
      const email = canonicalTeacherEmail(value.email);
      if (!value.uid || !email || value.role !== 'admin') {
        throw new Error('관리자 계정만 교사 신청과 승인 상태를 변경할 수 있습니다.');
      }
      if (value.authGeneration != null && value.currentAuthGeneration != null &&
          value.authGeneration !== value.currentAuthGeneration) {
        throw new Error('로그인 상태가 변경되어 다시 시도해 주세요.');
      }
      return { ...value, email };
    }

    function assertLifecycleOperationCurrent(actor) {
      const value = actor || {};
      if (value.authGeneration != null && value.currentAuthGeneration != null &&
          value.authGeneration !== value.currentAuthGeneration) {
        throw new Error('로그인 상태가 변경되어 lifecycle 작업을 다시 시도해 주세요.');
      }
      if (typeof value.isCurrent === 'function' && value.isCurrent() !== true) {
        throw new Error('화면 또는 로그인 상태가 변경되어 lifecycle 작업을 다시 시도해 주세요.');
      }
      return value;
    }

    function publicAuthorLabelCore() {
      const value = publicAuthorLabel ||
        (typeof globalThis !== 'undefined' && globalThis.PublicAuthorLabelCore);
      if (!value || typeof value.requireSafe !== 'function') {
        throw new Error('PublicAuthorLabelCore가 준비되지 않았습니다.');
      }
      return value;
    }

    function validAuthoritativeAdmin(data, actor) {
      return !!data && data.uid === actor.uid &&
        data.emailCanonical === actor.email && data.status === 'active' &&
        data.enabled === true && data.role === 'admin';
    }

    function validLegacyAdmin(data) {
      return !!data && data.enabled === true && data.role === 'admin';
    }

    async function requireTransactionAdmin(transaction, actor) {
      const current = assertAdminIdentity(actor);
      const authoritativeRef = db.doc('teacher_allowances/' + current.uid);
      const legacyRef = db.doc('teacher_allowlist/' + current.email);
      const authoritativeSnapshot = await transaction.get(authoritativeRef);
      const legacySnapshot = await transaction.get(legacyRef);
      const authoritative = authoritativeSnapshot.exists ? authoritativeSnapshot.data() : null;
      const legacy = legacySnapshot.exists ? legacySnapshot.data() : null;
      if (authoritativeSnapshot.exists
        ? !validAuthoritativeAdmin(authoritative, current)
        : !validLegacyAdmin(legacy)) {
        throw new Error('현재 계정의 관리자 승인이 더 이상 유효하지 않습니다.');
      }
      return current;
    }

    async function submitTeacherRequest(request) {
      const value = assertNewTeacherRequest(request);
      const reference = db.doc('teacher_access_requests/' + value.uid);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (snapshot.exists) throw new Error('교사 신청이 이미 존재합니다.');
        transaction.set(reference, {
          uid: value.uid,
          emailCanonical: value.emailCanonical,
          displayName: value.displayName,
          organization: value.organization,
          note: value.note,
          status: 'pending',
          revision: 1,
          createdAt: fieldValue.serverTimestamp(),
          updatedAt: fieldValue.serverTimestamp()
        });
        return { ...value };
      });
    }

    async function getOwnTeacherRequest(uid) {
      const exactUid = assertUid(uid);
      const snapshot = await db.doc('teacher_access_requests/' + exactUid).get({ source: 'server' });
      if (!snapshot.exists) return null;
      assertStoredTeacherRequest(snapshot.data(), exactUid);
      return teacherRequestValue(snapshot);
    }

    async function cancelTeacherRequest(uid, expectedRevision) {
      const exactUid = assertUid(uid);
      const revision = assertExpectedRevision(expectedRevision);
      const reference = db.doc('teacher_access_requests/' + exactUid);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) throw new Error('교사 신청 문서가 없습니다.');
        const request = assertStoredTeacherRequest(snapshot.data(), exactUid, 'pending');
        if (request.revision !== revision) throw new Error('교사 신청 revision이 변경되었습니다.');
        if (request.revision >= Number.MAX_SAFE_INTEGER) throw new Error('교사 신청 revision이 범위를 넘었습니다.');
        transaction.update(reference, {
          status: 'cancelled',
          revision: request.revision + 1,
          updatedAt: fieldValue.serverTimestamp()
        });
        return { ...request, status: 'cancelled', revision: request.revision + 1 };
      });
    }

    async function resubmitTeacherRequest(uid, expectedRevision, input) {
      const exactUid = assertUid(uid);
      const revision = assertExpectedRevision(expectedRevision);
      const value = input || {};
      const exactEmail = canonicalTeacherEmail(value.emailCanonical);
      const displayName = String(value.displayName || '').trim();
      const organization = String(value.organization || '');
      const note = String(value.note || '');
      if (!exactEmail || exactEmail !== value.emailCanonical) {
        throw new Error('현재 verified canonical email 신원이 필요합니다.');
      }
      if (!displayName || displayName.length > 80 || organization.length > 120 || note.length > 500) {
        throw new Error('교사 재신청 입력 범위가 유효하지 않습니다.');
      }
      const reference = db.doc('teacher_access_requests/' + exactUid);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) throw new Error('교사 신청 문서가 없습니다.');
        const request = assertStoredTeacherRequest(snapshot.data(), exactUid);
        if (!['cancelled', 'rejected'].includes(request.status)) {
          throw new Error('cancelled 또는 rejected 신청만 다시 제출할 수 있습니다.');
        }
        if (request.revision !== revision) throw new Error('교사 신청 revision이 변경되었습니다.');
        if (request.emailCanonical !== exactEmail || request.displayName !== displayName) {
          throw new Error('교사 신청 UID/email/displayName 신원을 바꿀 수 없습니다.');
        }
        const deletion = deleteFieldValue();
        transaction.update(reference, {
          status: 'pending', revision: revision + 1,
          organization, note,
          decidedAt: deletion, decidedByUid: deletion, decisionReason: deletion,
          updatedAt: fieldValue.serverTimestamp()
        });
        return {
          ...request, status: 'pending', revision: revision + 1,
          organization, note, decidedAt: undefined, decidedByUid: undefined,
          decisionReason: undefined
        };
      });
    }

    function assertDecision(decision) {
      const value = decision || {};
      if (!value || !['approved', 'rejected'].includes(value.status)) {
        throw new Error('approved 또는 rejected 결정만 허용됩니다.');
      }
      const reason = String(value.reason == null ? value.decisionReason || '' : value.reason);
      if (reason.length > 200) throw new Error('decision reason 사유는 200자 이하여야 합니다.');
      return { status: value.status, reason };
    }

    async function decideTeacherRequest(uid, expectedRevision, decision, adminIdentity) {
      const exactUid = assertUid(uid);
      const revision = assertExpectedRevision(expectedRevision);
      const normalized = assertDecision(decision);
      const requestRef = db.doc('teacher_access_requests/' + exactUid);
      const allowanceRef = db.doc('teacher_allowances/' + exactUid);
      return db.runTransaction(async transaction => {
        const admin = await requireTransactionAdmin(transaction, adminIdentity);
        const requestSnapshot = await transaction.get(requestRef);
        if (!requestSnapshot.exists) throw new Error('교사 신청 문서가 없습니다.');
        const request = assertStoredTeacherRequest(requestSnapshot.data(), exactUid, 'pending');
        if (request.revision !== revision) throw new Error('교사 신청 revision이 변경되었습니다.');
        if (request.revision >= Number.MAX_SAFE_INTEGER) throw new Error('교사 신청 revision이 범위를 넘었습니다.');
        const legacyRef = db.doc('teacher_allowlist/' + request.emailCanonical);
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const legacySnapshot = await transaction.get(legacyRef);
        const allowance = allowanceSnapshot.exists ? allowanceSnapshot.data() : null;
        const legacy = legacySnapshot.exists ? legacySnapshot.data() : null;
        if (allowanceSnapshot.exists) {
          if (allowance.uid !== exactUid || allowance.emailCanonical !== request.emailCanonical ||
              allowance.role !== 'teacher') {
            throw new Error('기존 teacher allowance identity가 신청 신원과 일치하지 않습니다.');
          }
          throw new Error('기존 teacher allowance 승인 문서가 이미 존재합니다.');
        }
        if (normalized.status === 'approved' && legacySnapshot.exists &&
            (legacy.role !== 'teacher' || legacy.uid !== exactUid)) {
          throw new Error('기존 legacy allowance identity가 신청 신원과 일치하지 않습니다.');
        }
        transaction.update(requestRef, {
          status: normalized.status,
          revision: request.revision + 1,
          decidedAt: fieldValue.serverTimestamp(),
          decidedByUid: admin.uid,
          decisionReason: normalized.reason,
          updatedAt: fieldValue.serverTimestamp()
        });
        if (normalized.status === 'approved') {
          publicAuthorLabelCore().requireSafe(request.displayName, {
            emailCanonical: request.emailCanonical,
            uid: exactUid
          });
          const timestamp = fieldValue.serverTimestamp();
          transaction.set(allowanceRef, {
            uid: exactUid,
            emailCanonical: request.emailCanonical,
            displayName: request.displayName,
            status: 'active',
            enabled: true,
            role: 'teacher',
            administrativeHold: false,
            approvedAt: timestamp,
            approvedByUid: admin.uid,
            updatedAt: timestamp,
            updatedByUid: admin.uid
          });
          transaction.set(legacyRef, {
            uid: exactUid,
            enabled: true,
            role: 'teacher',
            updatedAt: fieldValue.serverTimestamp(),
            updatedByUid: admin.uid
          });
        }
        return { ...request, status: normalized.status, revision: request.revision + 1 };
      });
    }

    async function listPendingTeacherRequests(limit, adminIdentity) {
      const count = limit == null ? 50 : Number(limit);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
        throw new Error('신청 조회 limit 개수는 1~100이어야 합니다.');
      }
      await requireCurrentAdmin(adminIdentity);
      const snapshot = await db.collection('teacher_access_requests')
        .where('status', '==', 'pending').limit(count).get({ source: 'server' });
      const values = {};
      snapshot.docs.forEach(document => {
        assertStoredTeacherRequest(document.data(), document.id, 'pending');
        values[document.id] = teacherRequestValue(document);
      });
      return values;
    }

    function assertAllowanceIdentity(snapshot, uid) {
      if (!snapshot.exists) throw new Error('teacher allowance 승인 문서가 없습니다.');
      const allowance = snapshot.data() || {};
      if (allowance.uid !== uid ||
          allowance.emailCanonical !== canonicalTeacherEmail(allowance.emailCanonical) ||
          !allowance.emailCanonical || !['teacher', 'admin'].includes(allowance.role)) {
        throw new Error('teacher allowance identity 신원이 일치하지 않습니다.');
      }
      return allowance;
    }

    function allowanceRevision(value) {
      const revision = value && value.revision === undefined ? 0 : value.revision;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('teacher allowance revision이 유효하지 않습니다.');
      }
      return revision;
    }

    function teacherAllowanceValue(snapshot) {
      if (!snapshot || !snapshot.exists) return null;
      const value = { ...(snapshot.data() || {}) };
      [
        'approvedAt', 'updatedAt', 'suspendedAt',
        'deletionRequestedAt', 'purgeEligibleAt'
      ].forEach(field => {
        const millis = timestampMillis(value[field]);
        if (millis !== null) value[field + 'Ms'] = millis;
      });
      return value;
    }

    function assertDeletionTeacherAllowance(snapshot, uid) {
      const allowance = assertAllowanceIdentity(snapshot, uid);
      if (allowance.role !== 'teacher') throw new Error('teacher 계정만 탈퇴를 요청할 수 있습니다.');
      if (allowance.emailCanonical !== canonicalTeacherEmail(allowance.emailCanonical)) {
        throw new Error('teacher allowance canonical email이 유효하지 않습니다.');
      }
      return allowance;
    }

    function deleteFieldValue() {
      if (!fieldValue || typeof fieldValue.delete !== 'function') {
        throw new Error('Firestore delete field sentinel이 준비되지 않았습니다.');
      }
      return fieldValue.delete();
    }

    async function getOwnTeacherAllowance(uid) {
      const exactUid = assertUid(uid);
      const snapshot = await db.doc('teacher_allowances/' + exactUid).get({ source: 'server' });
      if (!snapshot.exists) return null;
      assertAllowanceIdentity(snapshot, exactUid);
      return teacherAllowanceValue(snapshot);
    }

    async function requestTeacherDeletion(uid, lifecycleActor) {
      const exactUid = assertUid(uid);
      const allowanceRef = db.doc('teacher_allowances/' + exactUid);
      const initialSnapshot = await allowanceRef.get({ source: 'server' });
      const initialAllowance = assertDeletionTeacherAllowance(initialSnapshot, exactUid);
      const initialRevision = allowanceRevision(initialAllowance);
      const operationActor = lifecycleActor || {
        uid: exactUid,
        email: initialAllowance.emailCanonical,
        role: 'teacher'
      };
      let lifecycleOperationId = '';
      if (initialAllowance.status === 'active') {
        assertLifecycleOperationCurrent(operationActor);
        lifecycleOperationId = await acquirePublicationLifecycleLock(
          exactUid, initialRevision, 'teacher-deletion-pending', operationActor
        );
        try {
          await withdrawOwnedPublicationsForLifecycle(
            exactUid, initialRevision, 'teacher-deletion-pending', {
              ...operationActor, lifecycleOperationId
            }
          );
        } catch (error) {
          try {
            await releasePublicationLifecycleLock(
              exactUid, initialRevision, 'teacher-deletion-pending',
              operationActor, lifecycleOperationId
            );
          } catch (_) {
            // A failed release leaves the exact retry-adoptable lock fail-closed.
          }
          throw error;
        }
        assertLifecycleOperationCurrent(operationActor);
      }
      const lifecycleLockRef = db.doc('publication_lifecycle_locks/' + exactUid);
      const lifecycleGateRef = db.doc('publication_lifecycle_gates/current');
      const first = await db.runTransaction(async transaction => {
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = assertDeletionTeacherAllowance(allowanceSnapshot, exactUid);
        const legacyRef = db.doc('teacher_allowlist/' + allowance.emailCanonical);
        if (lifecycleOperationId) {
          const lockSnapshot = await transaction.get(lifecycleLockRef);
          const gateSnapshot = await transaction.get(lifecycleGateRef);
          requireLifecycleAllowance(
            allowanceSnapshot, exactUid, initialRevision, initialAllowance
          );
          requireLifecycleLock(
            lockSnapshot, exactUid, allowance, 'teacher-deletion-pending',
            operationActor, lifecycleOperationId
          );
          requireLifecycleLock(
            gateSnapshot, exactUid, allowance, 'teacher-deletion-pending',
            operationActor, lifecycleOperationId
          );
        }
        if (allowance.status === 'deletion_pending' && allowance.enabled === false) {
          const requestedAtMs = timestampMillis(allowance.deletionRequestedAt);
          const purgeEligibleAtMs = timestampMillis(allowance.purgeEligibleAt);
          if (requestedAtMs === null) throw new Error('탈퇴 요청 server timestamp가 유효하지 않습니다.');
          if (purgeEligibleAtMs !== null) {
            if (purgeEligibleAtMs !== requestedAtMs + 30 * 24 * 60 * 60 * 1000) {
              throw new Error('탈퇴 정리 eligibility timestamp가 정확히 30일이 아닙니다.');
            }
            return { settled: true };
          }
          return { settled: false, revision: allowanceRevision(allowance), requestedAtMs };
        }
        if (allowance.status !== 'active' || allowance.enabled !== true ||
            allowance.administrativeHold !== false) {
          throw new Error('administrative hold가 없는 active teacher만 탈퇴를 요청할 수 있습니다.');
        }
        if (allowanceRevision(allowance) !== initialRevision) {
          throw new Error('publication preflight 뒤 teacher allowance revision이 변경되었습니다.');
        }
        assertLifecycleOperationCurrent(operationActor);
        const revision = allowanceRevision(allowance) + 1;
        const timestamp = fieldValue.serverTimestamp();
        transaction.update(allowanceRef, {
          status: 'deletion_pending',
          enabled: false,
          revision,
          deletionRequestedAt: timestamp,
          purgeEligibleAt: deleteFieldValue(),
          updatedAt: timestamp,
          updatedByUid: exactUid
        });
        transaction.set(legacyRef, {
          uid: exactUid,
          enabled: false,
          role: 'teacher',
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: exactUid
        });
        if (lifecycleOperationId) {
          transaction.delete(lifecycleLockRef);
          transaction.delete(lifecycleGateRef);
        }
        return { settled: false, revision };
      }).catch(async error => {
        if (lifecycleOperationId) {
          try {
            await releasePublicationLifecycleLock(
              exactUid, initialRevision, 'teacher-deletion-pending',
              operationActor, lifecycleOperationId
            );
          } catch (_) {
            // A failed release leaves the exact retry-adoptable lock fail-closed.
          }
        }
        throw error;
      });
      if (!first.settled) {
        await db.runTransaction(async transaction => {
          const snapshot = await transaction.get(allowanceRef);
          const allowance = assertDeletionTeacherAllowance(snapshot, exactUid);
          const revision = allowanceRevision(allowance);
          const requestedAtMs = timestampMillis(allowance.deletionRequestedAt);
          const existingEligibleAtMs = timestampMillis(allowance.purgeEligibleAt);
          if (!['deletion_pending', 'suspended'].includes(allowance.status) || allowance.enabled !== false ||
              revision !== first.revision || requestedAtMs === null) {
            throw new Error('탈퇴 요청 상태가 eligibility timestamp 정착 전에 변경되었습니다.');
          }
          const exactEligibleAtMs = requestedAtMs + 30 * 24 * 60 * 60 * 1000;
          if (!Number.isSafeInteger(exactEligibleAtMs)) throw new Error('탈퇴 정리 timestamp 범위를 넘었습니다.');
          if (existingEligibleAtMs !== null) {
            if (existingEligibleAtMs !== exactEligibleAtMs) {
              throw new Error('탈퇴 정리 eligibility timestamp가 정확히 30일이 아닙니다.');
            }
            return;
          }
          transaction.update(allowanceRef, {
            purgeEligibleAt: new Date(exactEligibleAtMs),
            revision: revision + 1,
            updatedAt: fieldValue.serverTimestamp(),
            updatedByUid: exactUid
          });
        });
      }
      const saved = await allowanceRef.get({ source: 'server' });
      return teacherAllowanceValue(saved);
    }

    async function cancelTeacherDeletion(uid) {
      const exactUid = assertUid(uid);
      const allowanceRef = db.doc('teacher_allowances/' + exactUid);
      await db.runTransaction(async transaction => {
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = assertDeletionTeacherAllowance(allowanceSnapshot, exactUid);
        const legacyRef = db.doc('teacher_allowlist/' + allowance.emailCanonical);
        const revision = allowanceRevision(allowance);
        const requestedAtMs = timestampMillis(allowance.deletionRequestedAt);
        const purgeEligibleAtMs = timestampMillis(allowance.purgeEligibleAt);
        if (allowance.status !== 'deletion_pending' || allowance.enabled !== false ||
            requestedAtMs === null ||
            (purgeEligibleAtMs !== null &&
              purgeEligibleAtMs !== requestedAtMs + 30 * 24 * 60 * 60 * 1000)) {
          throw new Error('정확한 deletion_pending 탈퇴 요청만 철회할 수 있습니다.');
        }
        if (purgeEligibleAtMs !== null && serverNow() >= purgeEligibleAtMs) {
          throw new Error('30일 정리 eligible 경계 이후에는 탈퇴 요청을 철회할 수 없습니다.');
        }
        const held = allowance.administrativeHold === true;
        const deletion = deleteFieldValue();
        const update = {
          status: held ? 'suspended' : 'active',
          enabled: !held,
          revision: revision + 1,
          deletionRequestedAt: deletion,
          purgeEligibleAt: deletion,
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: exactUid
        };
        if (!held) {
          update.suspendedAt = deletion;
          update.suspendedByUid = deletion;
          update.suspensionReason = deletion;
        }
        transaction.update(allowanceRef, update);
        if (!held) {
          transaction.set(legacyRef, {
            uid: exactUid,
            enabled: true,
            role: 'teacher',
            updatedAt: fieldValue.serverTimestamp(),
            updatedByUid: exactUid
          });
        }
      });
      return getOwnTeacherAllowance(exactUid);
    }

    async function adminCancelTeacherDeletion(uid, expectedRevision, adminIdentity) {
      const exactUid = assertUid(uid);
      const expected = assertExpectedRevision(expectedRevision);
      const allowanceRef = db.doc('teacher_allowances/' + exactUid);
      await db.runTransaction(async transaction => {
        const admin = await requireTransactionAdmin(transaction, adminIdentity);
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = assertDeletionTeacherAllowance(allowanceSnapshot, exactUid);
        const revision = allowanceRevision(allowance);
        const requestedAtMs = timestampMillis(allowance.deletionRequestedAt);
        const purgeEligibleAtMs = timestampMillis(allowance.purgeEligibleAt);
        if (revision !== expected) throw new Error('teacher allowance revision이 변경되었습니다.');
        if (allowance.status !== 'deletion_pending' || allowance.enabled !== false ||
            requestedAtMs === null || purgeEligibleAtMs === null ||
            purgeEligibleAtMs !== requestedAtMs + 30 * 24 * 60 * 60 * 1000) {
          throw new Error('정확한 deletion_pending 탈퇴 요청만 관리자가 철회할 수 있습니다.');
        }
        const held = allowance.administrativeHold === true;
        const legacyRef = db.doc('teacher_allowlist/' + allowance.emailCanonical);
        const legacySnapshot = await transaction.get(legacyRef);
        if (!legacySnapshot.exists || (legacySnapshot.data() || {}).role !== 'teacher') {
          throw new Error('legacy allowance 승인 문서가 일치하지 않습니다.');
        }
        const deletion = deleteFieldValue();
        const update = {
          status: held ? 'suspended' : 'active',
          enabled: !held,
          revision: revision + 1,
          deletionRequestedAt: deletion,
          purgeEligibleAt: deletion,
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: admin.uid
        };
        if (!held) {
          update.suspendedAt = deletion;
          update.suspendedByUid = deletion;
          update.suspensionReason = deletion;
        }
        transaction.update(allowanceRef, update);
        if (!held) {
          transaction.set(legacyRef, {
            uid: exactUid,
            enabled: true,
            role: 'teacher',
            updatedAt: fieldValue.serverTimestamp(),
            updatedByUid: admin.uid
          });
        }
      });
      const saved = await allowanceRef.get({ source: 'server' });
      return teacherAllowanceValue(saved);
    }

    async function listDeletionPendingTeachers(limit, adminIdentity) {
      const count = limit == null ? 50 : Number(limit);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
        throw new Error('탈퇴 대기 조회 limit 개수는 1~100이어야 합니다.');
      }
      await requireCurrentAdmin(adminIdentity);
      const snapshot = await db.collection('teacher_allowances')
        .where('status', '==', 'deletion_pending').limit(count).get({ source: 'server' });
      const values = {};
      snapshot.docs.forEach(document => {
        const normalizedSnapshot = {
          exists: true,
          id: document.id,
          data: () => document.data() || {}
        };
        assertDeletionTeacherAllowance(normalizedSnapshot, document.id);
        values[document.id] = teacherAllowanceValue(normalizedSnapshot);
      });
      return values;
    }

    async function getTeacherDeletionReadiness(uid) {
      const exactUid = assertUid(uid);
      const maximum = 101;
      const [sets, sessions, livePlans] = await Promise.all([
        db.collection('quiz_sets').where('ownerUid', '==', exactUid).limit(maximum).get({ source: 'server' }),
        db.collection('sessions').where('teacherUid', '==', exactUid)
          .where('status', 'in', ['allocating', 'active', 'live']).limit(maximum).get({ source: 'server' }),
        db.collection('class_plans_private').where('ownerUid', '==', exactUid)
          .where('status', '==', 'live').limit(maximum).get({ source: 'server' })
      ]);
      const sessionIds = new Set(sessions.docs.map(document => document.id));
      const blockingSessions = sessions.docs.map(document => {
        const value = document.data() || {};
        if (value.teacherUid !== exactUid || !['allocating', 'active', 'live'].includes(value.status)) {
          throw new Error('정리 대상 세션 신원이 일치하지 않습니다.');
        }
        return {
          sessionId: document.id,
          status: value.status,
          code: typeof value.code === 'string' ? value.code : '',
          label: typeof value.label === 'string' ? value.label : ''
        };
      });
      const orphanPlanSessions = livePlans.docs.flatMap(document => {
        const value = document.data() || {};
        if (value.ownerUid !== exactUid || value.status !== 'live' ||
            typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.includes('/')) {
          throw new Error('정리 대상 live class plan 신원이 일치하지 않습니다.');
        }
        if (sessionIds.has(value.sessionId)) return [];
        return [{
          sessionId: value.sessionId,
          status: 'plan_live',
          code: '',
          label: typeof value.label === 'string' ? value.label
            : typeof value.setTitle === 'string' ? value.setTitle : document.id,
          planId: document.id
        }];
      });
      const combinedBlockers = blockingSessions.concat(orphanPlanSessions);
      return {
        ownedSetCount: Math.min(sets.docs.length, 100),
        blockingSessionCount: Math.min(combinedBlockers.length, 100),
        blockingSessions: combinedBlockers.slice(0, 100),
        liveClassPlanCount: Math.min(livePlans.docs.length, 100),
        ownedSetLimitReached: sets.docs.length > 100,
        blockingSessionLimitReached: sessions.docs.length > 100 || livePlans.docs.length > 100 ||
          combinedBlockers.length > 100
      };
    }

    async function resolveTeacherDeletionSession(uid, sessionId) {
      const exactUid = assertUid(uid);
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || sessionId.includes('/')) {
        throw new Error('유효한 session ID가 필요합니다.');
      }
      const exactSessionId = sessionId;
      const sessionRef = db.doc('sessions/' + exactSessionId);
      const snapshot = await sessionRef.get({ source: 'server' });
      if (!snapshot.exists) throw new Error('정리 대상 세션을 찾을 수 없습니다.');
      const session = snapshot.data() || {};
      const attachedPlan = typeof session.classPlanId === 'string' && session.classPlanId &&
        Number.isSafeInteger(session.classPlanRevision) && session.classPlanRevision > 0;
      if (session.teacherUid !== exactUid ||
          (!['allocating', 'active', 'live'].includes(session.status) &&
            !(session.status === 'ended' && attachedPlan))) {
        throw new Error('정리 대상 세션 소유권 또는 상태가 일치하지 않습니다.');
      }
      if (session.status === 'allocating') {
        return db.runTransaction(async transaction => {
          const allowanceSnapshot = await transaction.get(db.doc('teacher_allowances/' + exactUid));
          const allowance = assertDeletionTeacherAllowance(allowanceSnapshot, exactUid);
          const currentSnapshot = await transaction.get(sessionRef);
          const current = currentSnapshot.exists ? currentSnapshot.data() || {} : null;
          if (allowance.status !== 'deletion_pending' || allowance.enabled !== false ||
              !current || current.teacherUid !== exactUid || current.status !== 'allocating' ||
              current.classPlanId !== undefined || current.classPlanRevision !== undefined) {
            throw new Error('고아 세션 할당 상태가 변경되었습니다.');
          }
          transaction.set(sessionRef, {
            status: 'aborted',
            abortedAt: fieldValue.serverTimestamp()
          }, { merge: true });
          return true;
        });
      }
      if (session.status !== 'ended') await endSession(exactSessionId);
      if (attachedPlan) {
        await finishClassPlan(session.classPlanId, exactSessionId, {
          expectedRevision: session.classPlanRevision
        });
      }
      return true;
    }

    async function suspendTeacher(uid, reason, adminIdentity) {
      const exactUid = assertUid(uid);
      const suspensionReason = String(reason || '');
      if (suspensionReason.length > 200) throw new Error('중지 사유는 200자 이하여야 합니다.');
      const allowanceRef = db.doc('teacher_allowances/' + exactUid);
      assertLifecycleOperationCurrent(adminIdentity);
      await requireCurrentAdmin(adminIdentity);
      const initialSnapshot = await allowanceRef.get({ source: 'server' });
      const initialAllowance = assertAllowanceIdentity(initialSnapshot, exactUid);
      const initialRevision = allowanceRevision(initialAllowance);
      let lifecycleOperationId = '';
      if (initialAllowance.status === 'active') {
        lifecycleOperationId = await acquirePublicationLifecycleLock(
          exactUid, initialRevision, 'teacher-suspension', adminIdentity
        );
        try {
          await withdrawOwnedPublicationsForLifecycle(
            exactUid, initialRevision, 'teacher-suspension', {
              ...adminIdentity, lifecycleOperationId
            }
          );
        } catch (error) {
          try {
            await releasePublicationLifecycleLock(
              exactUid, initialRevision, 'teacher-suspension',
              adminIdentity, lifecycleOperationId
            );
          } catch (_) {
            // A failed release leaves the exact retry-adoptable lock fail-closed.
          }
          throw error;
        }
      }
      assertLifecycleOperationCurrent(adminIdentity);
      return db.runTransaction(async transaction => {
        const admin = await requireTransactionAdmin(transaction, adminIdentity);
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = assertAllowanceIdentity(allowanceSnapshot, exactUid);
        const legacyRef = db.doc('teacher_allowlist/' + allowance.emailCanonical);
        const legacySnapshot = await transaction.get(legacyRef);
        if (!legacySnapshot.exists || legacySnapshot.data().role !== 'teacher') {
          throw new Error('legacy allowance 승인 문서가 일치하지 않습니다.');
        }
        if (!['active', 'deletion_pending'].includes(allowance.status) ||
            (allowance.status === 'active' ? allowance.enabled !== true : allowance.enabled !== false)) {
          throw new Error('active 또는 deletion_pending 교사만 중지할 수 있습니다.');
        }
        if (allowanceRevision(allowance) !== initialRevision) {
          throw new Error('publication preflight 뒤 teacher allowance revision이 변경되었습니다.');
        }
        assertLifecycleOperationCurrent(adminIdentity);
        const lifecycleLockRef = db.doc('publication_lifecycle_locks/' + exactUid);
        const lifecycleGateRef = db.doc('publication_lifecycle_gates/current');
        if (lifecycleOperationId) {
          const lockSnapshot = await transaction.get(lifecycleLockRef);
          const gateSnapshot = await transaction.get(lifecycleGateRef);
          requireLifecycleLock(
            lockSnapshot, exactUid, allowance, 'teacher-suspension',
            adminIdentity, lifecycleOperationId
          );
          requireLifecycleLock(
            gateSnapshot, exactUid, allowance, 'teacher-suspension',
            adminIdentity, lifecycleOperationId
          );
        }
        const pendingDeletion = allowance.status === 'deletion_pending';
        const timestamp = fieldValue.serverTimestamp();
        transaction.set(allowanceRef, {
          ...allowance,
          status: pendingDeletion ? 'deletion_pending' : 'suspended',
          enabled: false,
          administrativeHold: true,
          revision: allowanceRevision(allowance) + 1,
          suspendedAt: timestamp,
          suspendedByUid: admin.uid,
          suspensionReason,
          updatedAt: timestamp,
          updatedByUid: admin.uid
        });
        transaction.set(legacyRef, {
          uid: exactUid,
          enabled: false,
          role: 'teacher',
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: admin.uid
        });
        if (lifecycleOperationId) {
          transaction.delete(lifecycleLockRef);
          transaction.delete(lifecycleGateRef);
        }
      }).catch(async error => {
        if (lifecycleOperationId) {
          try {
            await releasePublicationLifecycleLock(
              exactUid, initialRevision, 'teacher-suspension',
              adminIdentity, lifecycleOperationId
            );
          } catch (_) {
            // A failed release leaves the exact retry-adoptable lock fail-closed.
          }
        }
        throw error;
      });
    }

    async function restoreTeacher(uid, adminIdentity) {
      const exactUid = assertUid(uid);
      const allowanceRef = db.doc('teacher_allowances/' + exactUid);
      return db.runTransaction(async transaction => {
        const admin = await requireTransactionAdmin(transaction, adminIdentity);
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = assertAllowanceIdentity(allowanceSnapshot, exactUid);
        const legacyRef = db.doc('teacher_allowlist/' + allowance.emailCanonical);
        const legacySnapshot = await transaction.get(legacyRef);
        if (!legacySnapshot.exists || legacySnapshot.data().role !== 'teacher') {
          throw new Error('legacy allowance 승인 문서가 일치하지 않습니다.');
        }
        if (allowance.status === 'deletion_pending') {
          throw new Error('deletion_pending 탈퇴 대기 교사는 복구할 수 없습니다.');
        }
        if (allowance.status !== 'suspended' || allowance.enabled !== false) {
          throw new Error('suspended 교사만 복구할 수 있습니다.');
        }
        const restored = { ...allowance };
        delete restored.suspendedAt;
        delete restored.suspendedByUid;
        delete restored.suspensionReason;
        restored.status = 'active';
        restored.enabled = true;
        restored.administrativeHold = false;
        restored.revision = allowanceRevision(allowance) + 1;
        restored.updatedAt = fieldValue.serverTimestamp();
        restored.updatedByUid = admin.uid;
        transaction.set(allowanceRef, restored);
        transaction.set(legacyRef, {
          uid: exactUid,
          enabled: true,
          role: 'teacher',
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: admin.uid
        });
      });
    }

    const CLASS_PLAN_WINDOW_MAX_MS = 31 * 24 * 60 * 60 * 1000;
    // UI allows a five-minute past start. Keep a further minute for
    // datetime-local truncation and two minutes for client/server transport.
    const CLASS_PLAN_QUERY_PAST_MS = (24 * 60 + 8) * 60 * 1000;
    const CLASS_PLAN_QUERY_FUTURE_MS = 32 * 24 * 60 * 60 * 1000;
    const SESSION_COUNTER_GATE_KEYS = [
      'complete', 'projectId', 'environment', 'rulesVersion',
      'preflightNonEndedLegacyCount', 'verifiedAt', 'updatedAt', 'completedByUid'
    ];
    const classPlanPrivateBaseKeys = [
      'planId', 'ownerUid', 'ownerEmailCanonical', 'ownerDisplayName',
      'setId', 'setTitleSnapshot', 'className', 'plannedStartAt', 'plannedEndAt',
      'expectedStudents', 'status', 'revision', 'createdAt', 'updatedAt'
    ];
    const classPlanPublicBaseKeys = [
      'planId', 'setId', 'setTitleSnapshot', 'className', 'plannedStartAt',
      'plannedEndAt', 'expectedStudents', 'status', 'revision', 'createdAt', 'updatedAt'
    ];
    const classPlanOptionalKeys = [
      'warningLevel', 'warningAcknowledgedAt', 'sessionId', 'actualStartedAt',
      'actualEndedAt', 'actualParticipants'
    ];

    function classPlanningCore() {
      const value = classPlanning ||
        (typeof globalThis !== 'undefined' && globalThis.ClassPlanningCore);
      if (!value || typeof value.publicProjection !== 'function') {
        throw new Error('ClassPlanningCore가 준비되지 않았습니다.');
      }
      return value;
    }

    function validSessionCounterMigrationGate(data) {
      const value = data || {};
      const keys = Object.keys(value).sort();
      const exactKeys = [...SESSION_COUNTER_GATE_KEYS].sort();
      const exactGateTimestamp = timestamp => {
        if (timestamp instanceof Date) {
          const millis = timestamp.getTime();
          return Number.isSafeInteger(millis) ? { kind: 'date', millis } : null;
        }
        if (typeof FirestoreTimestamp !== 'function' ||
            !(timestamp instanceof FirestoreTimestamp)) return null;
        if (!Object.prototype.hasOwnProperty.call(timestamp, 'seconds') ||
            !Object.prototype.hasOwnProperty.call(timestamp, 'nanoseconds') ||
            typeof FirestoreTimestamp.prototype.isEqual !== 'function') return null;
        const seconds = timestamp.seconds;
        const nanoseconds = timestamp.nanoseconds;
        if (!Number.isSafeInteger(seconds) || seconds < -62135596800 ||
            seconds > 253402300799 || !Number.isInteger(nanoseconds) ||
            nanoseconds < 0 || nanoseconds >= 1_000_000_000) return null;
        return { kind: 'timestamp', seconds, nanoseconds, value: timestamp };
      };
      const sameExactGateTimestamp = (left, right) => {
        if (!left || !right || left.kind !== right.kind) return false;
        if (left.kind === 'date') return left.millis === right.millis;
        if (left.seconds !== right.seconds || left.nanoseconds !== right.nanoseconds) return false;
        try {
          return FirestoreTimestamp.prototype.isEqual.call(left.value, right.value) === true &&
            FirestoreTimestamp.prototype.isEqual.call(right.value, left.value) === true;
        } catch (error) {
          return false;
        }
      };
      const verifiedAt = exactGateTimestamp(value.verifiedAt);
      const updatedAt = exactGateTimestamp(value.updatedAt);
      return JSON.stringify(keys) === JSON.stringify(exactKeys) &&
        value.complete === true && typeof value.projectId === 'string' &&
        value.projectId.length > 0 && value.projectId.length <= 120 &&
        ['production', 'emulator'].includes(value.environment) &&
        value.rulesVersion === 'session-counters-v1' &&
        value.preflightNonEndedLegacyCount === 0 &&
        sameExactGateTimestamp(verifiedAt, updatedAt) &&
        typeof value.completedByUid === 'string' && value.completedByUid.length > 0 &&
        value.completedByUid.length <= 128;
    }

    function assertPlanId(value) {
      if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) {
        throw new Error('유효한 class plan ID가 필요합니다.');
      }
      return value;
    }

    function classPlanTimestamp(value, name) {
      const millis = value instanceof Date ? value.getTime() : timestampMillis(value);
      if (!Number.isSafeInteger(millis)) throw new Error(name + ' timestamp가 유효하지 않습니다.');
      return millis;
    }

    function classPlanClientValue(data, id) {
      if (!data) return null;
      const value = { ...data, planId: data.planId || id };
      value.plannedStartAt = classPlanTimestamp(data.plannedStartAt, 'plannedStartAt');
      value.plannedEndAt = classPlanTimestamp(data.plannedEndAt, 'plannedEndAt');
      if (data.warningAcknowledgedAt !== undefined) {
        value.warningAcknowledgedAt = classPlanTimestamp(
          data.warningAcknowledgedAt, 'warningAcknowledgedAt'
        );
      }
      if (data.actualStartedAt !== undefined) {
        value.actualStartedAtMs = classPlanTimestamp(data.actualStartedAt, 'actualStartedAt');
        delete value.actualStartedAt;
      }
      if (data.actualEndedAt !== undefined) {
        value.actualEndedAtMs = classPlanTimestamp(data.actualEndedAt, 'actualEndedAt');
        delete value.actualEndedAt;
      }
      if (data.createdAt !== undefined) {
        value.createdAtMs = classPlanTimestamp(data.createdAt, 'createdAt');
        delete value.createdAt;
      }
      if (data.updatedAt !== undefined) {
        value.updatedAtMs = classPlanTimestamp(data.updatedAt, 'updatedAt');
        delete value.updatedAt;
      }
      return value;
    }

    function classPlanPublicValue(privateValue) {
      const value = {
        ...classPlanningCore().publicProjection(privateValue),
        planId: privateValue.planId,
        revision: privateValue.revision
      };
      if (privateValue.sessionId !== undefined) value.sessionId = privateValue.sessionId;
      return value;
    }

    function assertClassPlanShape(value, isPrivate, stored) {
      const plan = value || {};
      assertPlanId(plan.planId);
      if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
        throw new Error('class plan revision은 positive safe integer여야 합니다.');
      }
      const base = isPrivate ? classPlanPrivateBaseKeys : classPlanPublicBaseKeys;
      const allowed = base.concat(classPlanOptionalKeys);
      const keys = Object.keys(plan);
      if (keys.some(key => !allowed.includes(key)) || base.some(key => !keys.includes(key))) {
        throw new Error('class plan 문서에 허용되지 않은 필드가 있습니다.');
      }
      const client = stored ? classPlanClientValue(plan, plan.planId) : { ...plan };
      if (!stored) {
        if (client.createdAtMs === undefined || client.updatedAtMs === undefined) {
          throw new Error('class plan 생성 시각이 필요합니다.');
        }
        classPlanTimestamp(client.createdAtMs, 'createdAtMs');
        classPlanTimestamp(client.updatedAtMs, 'updatedAtMs');
      }
      classPlanningCore().publicProjection(client);
      if (isPrivate) {
        if (typeof client.ownerUid !== 'string' || !client.ownerUid ||
            client.ownerEmailCanonical !== canonicalTeacherEmail(client.ownerEmailCanonical) ||
            !client.ownerEmailCanonical || typeof client.ownerDisplayName !== 'string' ||
            !client.ownerDisplayName.trim() || client.ownerDisplayName.trim().length > 80) {
          throw new Error('class plan owner identity가 유효하지 않습니다.');
        }
      }
      return client;
    }

    function assertClassPlanPair(privateData, publicData, stored) {
      const privateValue = assertClassPlanShape(privateData, true, stored);
      const publicValue = assertClassPlanShape(publicData, false, stored);
      const expected = classPlanPublicValue(privateValue);
      const publicComparable = { ...publicValue };
      delete publicComparable.createdAtMs;
      delete publicComparable.updatedAtMs;
      const livePublicCount = privateValue.status === 'live' &&
        privateValue.actualParticipants === undefined &&
        Number.isSafeInteger(publicComparable.actualParticipants) &&
        publicComparable.actualParticipants >= 0;
      if (livePublicCount) delete publicComparable.actualParticipants;
      const comparableKeys = Object.keys(publicComparable);
      const expectedKeys = Object.keys(expected);
      const mismatch = expectedKeys.find(key =>
        JSON.stringify(publicComparable[key]) !== JSON.stringify(expected[key])
      );
      if (comparableKeys.length !== expectedKeys.length || mismatch) {
        throw new Error('class plan private/public projection pair가 일치하지 않습니다.' +
          (mismatch ? ' field=' + mismatch : ' fields=' + comparableKeys.join(',')));
      }
      return { privateValue, publicValue };
    }

    function storedClassPlanDocuments(privateValue) {
      const publicValue = classPlanPublicValue(privateValue);
      const convert = value => {
        const stored = { ...value };
        stored.plannedStartAt = new Date(value.plannedStartAt);
        stored.plannedEndAt = new Date(value.plannedEndAt);
        if (value.warningAcknowledgedAt !== undefined) {
          stored.warningAcknowledgedAt = new Date(value.warningAcknowledgedAt);
        }
        if (value.actualStartedAtMs !== undefined) {
          stored.actualStartedAt = new Date(value.actualStartedAtMs);
          delete stored.actualStartedAtMs;
        }
        if (value.actualEndedAtMs !== undefined) {
          stored.actualEndedAt = new Date(value.actualEndedAtMs);
          delete stored.actualEndedAtMs;
        }
        delete stored.createdAtMs;
        delete stored.updatedAtMs;
        stored.createdAt = fieldValue.serverTimestamp();
        stored.updatedAt = fieldValue.serverTimestamp();
        return stored;
      };
      return { privateDocument: convert(privateValue), publicDocument: convert(publicValue) };
    }

    async function requireActiveClassPlanOwner(transaction, owner) {
      const allowanceSnapshot = await transaction.get(
        db.doc('teacher_allowances/' + owner.ownerUid)
      );
      if (!allowanceSnapshot.exists) throw new Error('active teacher allowance가 필요합니다.');
      const allowance = allowanceSnapshot.data() || {};
      if (allowance.uid !== owner.ownerUid ||
          allowance.emailCanonical !== owner.ownerEmailCanonical ||
          allowance.status !== 'active' || allowance.enabled !== true ||
          !['teacher', 'admin'].includes(allowance.role)) {
        throw new Error('현재 active 교사 신원이 class plan owner와 일치하지 않습니다.');
      }
      return allowance;
    }

    async function readClassPlanPair(transaction, planId) {
      const privateRef = db.doc('class_plans_private/' + planId);
      const publicRef = db.doc('class_plans_public/' + planId);
      const privateSnapshot = await transaction.get(privateRef);
      const publicSnapshot = await transaction.get(publicRef);
      if (!privateSnapshot.exists || !publicSnapshot.exists) {
        throw new Error('paired class plan 문서가 없습니다.');
      }
      const pair = assertClassPlanPair(
        privateSnapshot.data(), publicSnapshot.data(), true
      );
      return { ...pair, privateRef, publicRef };
    }

    async function createClassPlan(privatePlan, publicPlan) {
      const privateInput = { ...(privatePlan || {}) };
      const publicInput = { ...(publicPlan || {}) };
      if (privateInput.createdAtMs === undefined || privateInput.updatedAtMs === undefined) {
        throw new Error('class plan 생성 시각이 필요합니다.');
      }
      const createPrivate = { ...privateInput };
      const createPublic = { ...publicInput };
      createPrivate.createdAt = new Date(createPrivate.createdAtMs);
      createPrivate.updatedAt = new Date(createPrivate.updatedAtMs);
      delete createPrivate.createdAtMs;
      delete createPrivate.updatedAtMs;
      createPublic.createdAt = createPrivate.createdAt;
      createPublic.updatedAt = createPrivate.updatedAt;
      const pair = assertClassPlanPair(createPrivate, createPublic, true);
      if (pair.privateValue.status !== 'planned' || pair.privateValue.revision !== 1 ||
          pair.privateValue.sessionId !== undefined || pair.privateValue.actualStartedAtMs !== undefined ||
          pair.privateValue.actualEndedAtMs !== undefined || pair.privateValue.actualParticipants !== undefined) {
        throw new Error('새 class plan은 revision 1 planned 상태여야 합니다.');
      }
      const planId = assertPlanId(pair.privateValue.planId);
      const privateRef = db.doc('class_plans_private/' + planId);
      const publicRef = db.doc('class_plans_public/' + planId);
      return db.runTransaction(async transaction => {
        await requireActiveClassPlanOwner(transaction, pair.privateValue);
        const privateSnapshot = await transaction.get(privateRef);
        const publicSnapshot = await transaction.get(publicRef);
        if (privateSnapshot.exists || publicSnapshot.exists) {
          if (!privateSnapshot.exists || !publicSnapshot.exists) {
            throw new Error('class plan ID가 이미 존재하거나 pair가 손상되었습니다.');
          }
          const existing = assertClassPlanPair(
            privateSnapshot.data(), publicSnapshot.data(), true
          ).privateValue;
          const comparableKeys = [
            'planId', 'ownerUid', 'ownerEmailCanonical', 'ownerDisplayName',
            'setId', 'setTitleSnapshot', 'className', 'plannedStartAt', 'plannedEndAt',
            'expectedStudents', 'status', 'revision', 'warningLevel',
            'warningAcknowledgedAt', 'sessionId', 'actualStartedAtMs',
            'actualEndedAtMs', 'actualParticipants'
          ];
          const comparable = value => comparableKeys.map(key => {
            const current = value[key];
            return current === undefined ? null : current;
          });
          if (existing.status !== 'planned' || existing.revision !== 1 ||
              JSON.stringify(comparable(existing)) !==
                JSON.stringify(comparable(pair.privateValue))) {
            throw new Error('기존 class plan이 exact revision-1 planned pair와 일치하지 않습니다.');
          }
          return { ...existing };
        }
        const documents = storedClassPlanDocuments(pair.privateValue);
        transaction.set(privateRef, documents.privateDocument);
        transaction.set(publicRef, documents.publicDocument);
        return { ...pair.privateValue };
      });
    }

    function classPlanUpdate(updates) {
      const value = updates || {};
      const allowed = [
        'className', 'plannedStartAt', 'plannedEndAt', 'expectedStudents',
        'warningLevel', 'warningAcknowledgedAt'
      ];
      const keys = Object.keys(value);
      if (!keys.length || keys.some(key => !allowed.includes(key))) {
        throw new Error('class plan update 필드가 허용되지 않습니다.');
      }
      return value;
    }

    async function updateOwnClassPlan(planId, expectedRevision, updates) {
      const id = assertPlanId(planId);
      const revision = assertExpectedRevision(expectedRevision);
      const patch = classPlanUpdate(updates);
      return db.runTransaction(async transaction => {
        const pair = await readClassPlanPair(transaction, id);
        await requireActiveClassPlanOwner(transaction, pair.privateValue);
        if (pair.privateValue.status !== 'planned') {
          throw new Error('planned class plan만 수정할 수 있습니다.');
        }
        if (pair.privateValue.revision !== revision) {
          throw new Error('class plan revision이 변경되었습니다.');
        }
        const next = {
          ...pair.privateValue,
          ...patch,
          revision: revision + 1,
          updatedAtMs: serverNow()
        };
        classPlanningCore().publicProjection(next);
        const publicNext = classPlanPublicValue(next);
        const privateUpdate = {
          ...patch,
          plannedStartAt: new Date(next.plannedStartAt),
          plannedEndAt: new Date(next.plannedEndAt),
          revision: next.revision,
          updatedAt: fieldValue.serverTimestamp()
        };
        if (patch.warningAcknowledgedAt !== undefined) {
          privateUpdate.warningAcknowledgedAt = new Date(patch.warningAcknowledgedAt);
        }
        const publicUpdate = { ...privateUpdate };
        transaction.update(pair.privateRef, privateUpdate);
        transaction.update(pair.publicRef, publicUpdate);
        return { ...next, ...publicNext };
      });
    }

    async function cancelOwnClassPlan(planId, expectedRevision) {
      const id = assertPlanId(planId);
      const revision = assertExpectedRevision(expectedRevision);
      return db.runTransaction(async transaction => {
        const pair = await readClassPlanPair(transaction, id);
        await requireActiveClassPlanOwner(transaction, pair.privateValue);
        if (pair.privateValue.status !== 'planned') {
          throw new Error('planned class plan만 취소할 수 있습니다.');
        }
        if (pair.privateValue.revision !== revision) {
          throw new Error('class plan revision이 변경되었습니다.');
        }
        const update = {
          status: 'cancelled', revision: revision + 1,
          updatedAt: fieldValue.serverTimestamp()
        };
        transaction.update(pair.privateRef, update);
        transaction.update(pair.publicRef, update);
        return { ...pair.privateValue, status: 'cancelled', revision: revision + 1 };
      });
    }

    function classPlanWindow(from, to, limit) {
      const start = classPlanTimestamp(from, 'class plan window start');
      const end = classPlanTimestamp(to, 'class plan window end');
      const count = limit == null ? 50 : Number(limit);
      if (end <= start || end - start > CLASS_PLAN_WINDOW_MAX_MS) {
        throw new Error('class plan 조회 기간은 양수이며 31일 이하여야 합니다.');
      }
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
        throw new Error('class plan query limit은 1~100이어야 합니다.');
      }
      const now = serverNow();
      if (start < now - CLASS_PLAN_QUERY_PAST_MS) {
        throw new Error('class plan 조회 시작은 server-time 과거 horizon 안이어야 합니다.');
      }
      if (end >= now + CLASS_PLAN_QUERY_FUTURE_MS) {
        throw new Error('class plan 조회 끝은 server-time 미래 horizon 안이어야 합니다.');
      }
      return { start, end, count };
    }

    async function listClassPlans(collectionName, from, to, limit) {
      const window = classPlanWindow(from, to, limit);
      const snapshot = await db.collection(collectionName)
        .where('plannedStartAt', '>=', new Date(window.start))
        .where('plannedStartAt', '<', new Date(window.end))
        .orderBy('plannedStartAt', 'asc')
        .limit(window.count)
        .get({ source: 'server' });
      const values = {};
      snapshot.docs.forEach(document => {
        values[document.id] = classPlanClientValue(document.data(), document.id);
      });
      return values;
    }

    function listPublicPlans(from, to, limit) {
      return listClassPlans('class_plans_public', from, to, limit);
    }

    async function getClassPlanningThresholds() {
      const snapshot = await db.doc('config/class_planning').get({ source: 'server' });
      return classPlanning.normalizeThresholds(snapshot.exists ? snapshot.data() : undefined);
    }

    async function updateClassPlanningThresholds(input, actor) {
      const thresholds = classPlanning.normalizeThresholds(input);
      const uid = assertUid(actor && actor.uid);
      await db.doc('config/class_planning').set({
        ...thresholds,
        updatedAt: fieldValue.serverTimestamp(),
        updatedByUid: uid
      });
      return thresholds;
    }

    function listAdminPlans(from, to, limit) {
      return listClassPlans('class_plans_private', from, to, limit);
    }

    function subscribeClassPlans(collectionName, from, to, limit, next, error) {
      const window = classPlanWindow(from, to, limit);
      if (typeof next !== 'function') throw new Error('class plan listener callback이 필요합니다.');
      return db.collection(collectionName)
        .where('plannedStartAt', '>=', new Date(window.start))
        .where('plannedStartAt', '<', new Date(window.end))
        .orderBy('plannedStartAt', 'asc')
        .limit(window.count)
        .onSnapshot(snapshot => {
          const values = {};
          snapshot.docs.forEach(document => {
            values[document.id] = classPlanClientValue(document.data(), document.id);
          });
          next(values);
        }, error);
    }

    function subscribePublicPlans(from, to, limit, next, error) {
      return subscribeClassPlans('class_plans_public', from, to, limit, next, error);
    }

    function subscribeAdminPlans(from, to, limit, next, error) {
      return subscribeClassPlans('class_plans_private', from, to, limit, next, error);
    }

    async function getOwnClassPlan(planId, identity) {
      const id = assertPlanId(planId);
      const owner = identity || {};
      const uid = assertUid(owner.uid);
      const email = canonicalTeacherEmail(owner.emailCanonical === undefined
        ? owner.email : owner.emailCanonical);
      if (!email) throw new Error('class plan owner identity가 유효하지 않습니다.');
      const snapshot = await db.doc('class_plans_private/' + id).get({ source: 'server' });
      if (!snapshot.exists) return null;
      const plan = assertClassPlanShape(snapshot.data(), true, true);
      if (plan.ownerUid !== uid || plan.ownerEmailCanonical !== email) {
        throw new Error('class plan owner identity가 일치하지 않습니다.');
      }
      return { ...plan };
    }

    async function listOwnClassPlans(from, to, limit, identity) {
      const owner = identity || {};
      const uid = assertUid(owner.uid);
      const email = canonicalTeacherEmail(owner.emailCanonical === undefined
        ? owner.email : owner.emailCanonical);
      if (!email) throw new Error('class plan owner identity가 유효하지 않습니다.');
      const window = classPlanWindow(from, to, limit);
      const snapshot = await db.collection('class_plans_private')
        .where('ownerUid', '==', uid)
        .where('plannedStartAt', '>=', new Date(window.start))
        .where('plannedStartAt', '<', new Date(window.end))
        .orderBy('plannedStartAt', 'asc')
        .limit(window.count)
        .get({ source: 'server' });
      const values = {};
      snapshot.docs.forEach(document => {
        const plan = classPlanClientValue(document.data(), document.id);
        if (plan.ownerUid !== uid) return;
        values[document.id] = {
          planId: document.id,
          revision: plan.revision,
          status: plan.status
        };
      });
      return values;
    }

    async function attachPlanToSession(planId, sessionId, ownerIdentity) {
      const id = assertPlanId(planId);
      const exactSessionId = assertPlanId(sessionId);
      const owner = ownerIdentity || {};
      const uid = assertUid(owner.uid);
      const email = canonicalTeacherEmail(owner.emailCanonical === undefined
        ? owner.email : owner.emailCanonical);
      const revision = assertExpectedRevision(owner.expectedRevision);
      if (!email || email !== (owner.emailCanonical === undefined
        ? canonicalTeacherEmail(owner.email) : owner.emailCanonical)) {
        throw new Error('class plan owner email 신원이 유효하지 않습니다.');
      }
      return db.runTransaction(async transaction => {
        const pair = await readClassPlanPair(transaction, id);
        if (pair.privateValue.ownerUid !== uid || pair.privateValue.ownerEmailCanonical !== email) {
          throw new Error('class plan owner identity가 일치하지 않습니다.');
        }
        await requireActiveClassPlanOwner(transaction, pair.privateValue);
        const sessionRef = db.doc('sessions/' + exactSessionId);
        const sessionSnapshot = await transaction.get(sessionRef);
        if (!sessionSnapshot.exists) throw new Error('연결할 session이 없습니다.');
        const session = sessionSnapshot.data() || {};
        if (session.teacherUid !== uid || session.setId !== pair.privateValue.setId ||
            (session.teacherEmail && canonicalTeacherEmail(session.teacherEmail) !== email)) {
          throw new Error('class plan과 session의 owner 또는 세트가 일치하지 않습니다.');
        }
        if (pair.privateValue.sessionId === exactSessionId &&
            ['live', 'ended'].includes(pair.privateValue.status)) {
          if (session.classPlanId !== id ||
              session.classPlanRevision !== pair.privateValue.revision) {
            throw new Error('class plan과 session의 reciprocal attachment가 손상되었습니다.');
          }
          return { ...pair.privateValue };
        }
        if (pair.privateValue.status !== 'planned' || pair.privateValue.sessionId !== undefined) {
          throw new Error('class plan은 이미 다른 session에 연결되었거나 상태가 변경되었습니다.');
        }
        if (pair.privateValue.revision !== revision) {
          throw new Error('class plan revision이 변경되었습니다.');
        }
        if (session.status !== 'live') throw new Error('활성화된 live session만 연결할 수 있습니다.');
        const participantCount = session.registeredStudentCount;
        if (!Number.isSafeInteger(participantCount) || participantCount < 0 ||
            session.studentCountRevision !== participantCount ||
            (participantCount === 0
              ? session.lastStudentUid !== undefined
              : typeof session.lastStudentUid !== 'string' || !session.lastStudentUid)) {
          throw new Error('session participant counter가 유효하지 않습니다.');
        }
        const startedAtMs = classPlanTimestamp(session.createdAt, 'session createdAt');
        const update = {
          status: 'live', sessionId: exactSessionId, actualStartedAt: session.createdAt,
          revision: revision + 1, updatedAt: fieldValue.serverTimestamp()
        };
        transaction.update(pair.privateRef, update);
        transaction.update(pair.publicRef, { ...update, actualParticipants: participantCount });
        transaction.update(sessionRef, {
          classPlanId: id,
          classPlanRevision: revision + 1
        });
        return {
          ...pair.privateValue, status: 'live', sessionId: exactSessionId,
          actualStartedAtMs: startedAtMs, revision: revision + 1
        };
      });
    }

    async function finishClassPlan(planId, sessionId, actuals) {
      const id = assertPlanId(planId);
      const exactSessionId = assertPlanId(sessionId);
      const revision = assertExpectedRevision(actuals && actuals.expectedRevision);
      return db.runTransaction(async transaction => {
        const pair = await readClassPlanPair(transaction, id);
        const sessionSnapshot = await transaction.get(db.doc('sessions/' + exactSessionId));
        if (!sessionSnapshot.exists) throw new Error('종료된 session을 찾을 수 없습니다.');
        const session = sessionSnapshot.data() || {};
        if (pair.privateValue.sessionId !== exactSessionId ||
            session.teacherUid !== pair.privateValue.ownerUid ||
            session.setId !== pair.privateValue.setId) {
          throw new Error('class plan과 종료 session identity가 일치하지 않습니다.');
        }
        const count = session.registeredStudentCount;
        const validCounter = Number.isSafeInteger(count) && count >= 0 &&
          session.studentCountRevision === count && session.actualParticipants === count &&
          session.classPlanId === id &&
          (count === 0
            ? session.lastStudentUid === undefined
            : typeof session.lastStudentUid === 'string' && Boolean(session.lastStudentUid));
        if (pair.privateValue.status === 'ended') {
          if (session.status !== 'ended' || !validCounter ||
              session.classPlanRevision !== pair.privateValue.revision ||
              pair.privateValue.actualParticipants !== count ||
              classPlanTimestamp(session.endedAt, 'session endedAt') !==
                pair.privateValue.actualEndedAtMs) {
            throw new Error('ended class plan의 authoritative session summary가 손상되었습니다.');
          }
          return { ...pair.privateValue };
        }
        if (pair.privateValue.status !== 'live' || pair.privateValue.revision !== revision) {
          throw new Error('live class plan revision이 변경되었습니다.');
        }
        if (session.status !== 'ended') {
          throw new Error('authoritative session 종료 후에만 class plan을 ended로 만들 수 있습니다.');
        }
        if (!validCounter || session.classPlanRevision !== revision) {
          throw new Error('authoritative session participant counter와 plan attachment가 일치하지 않습니다.');
        }
        const endedAtMs = classPlanTimestamp(session.endedAt, 'session endedAt');
        const update = {
          status: 'ended', actualEndedAt: session.endedAt,
          actualParticipants: count, revision: revision + 1,
          updatedAt: fieldValue.serverTimestamp()
        };
        transaction.update(pair.privateRef, update);
        transaction.update(pair.publicRef, update);
        transaction.update(db.doc('sessions/' + exactSessionId), {
          classPlanRevision: revision + 1
        });
        return {
          ...pair.privateValue, status: 'ended', actualEndedAtMs: endedAtMs,
          actualParticipants: count, revision: revision + 1
        };
      });
    }

    function allowanceData(snapshot) {
      if (!snapshot || !snapshot.exists) return null;
      const data = snapshot.data() || {};
      return {
        enabled: data.enabled === true,
        role: data.role === 'admin' ? 'admin' : 'teacher',
        ...(data.updatedAt == null ? {} : { updatedAt: timestampMillis(data.updatedAt) }),
        ...(data.updatedByUid == null ? {} : { updatedByUid: data.updatedByUid })
      };
    }

    async function requireCurrentAdmin(actor) {
      const value = assertAdminIdentity(actor);
      const authoritativeSnapshot = await db.doc('teacher_allowances/' + value.uid)
        .get({ source: 'server' });
      const legacySnapshot = await db.doc('teacher_allowlist/' + value.email)
        .get({ source: 'server' });
      const authoritative = authoritativeSnapshot.exists ? authoritativeSnapshot.data() : null;
      const legacy = legacySnapshot.exists ? legacySnapshot.data() : null;
      if (authoritativeSnapshot.exists
        ? !validAuthoritativeAdmin(authoritative, value)
        : !validLegacyAdmin(legacy)) {
        throw new Error('현재 계정의 관리자 승인이 더 이상 유효하지 않습니다.');
      }
      return { ...value, allowance: authoritative || legacy };
    }

    function validateAllowanceRole(role) {
      if (role !== 'teacher' && role !== 'admin') {
        throw new Error('역할은 teacher 또는 admin이어야 합니다.');
      }
    }

    async function listTeacherAllowances(actor) {
      await requireCurrentAdmin(actor);
      const [legacySnapshot, authoritativeSnapshot] = await Promise.all([
        db.collection('teacher_allowlist').get({ source: 'server' }),
        db.collection('teacher_allowances').get({ source: 'server' })
      ]);
      const result = Object.fromEntries(legacySnapshot.docs.map(document => [
        canonicalTeacherEmail(document.id), { ...allowanceData(document), migrated: false }
      ]));
      authoritativeSnapshot.docs.forEach(document => {
        const data = document.data() || {};
        const email = canonicalTeacherEmail(data.emailCanonical);
        if (!email || data.uid !== document.id || !['teacher', 'admin'].includes(data.role)) return;
        result[email] = {
          ...teacherAllowanceValue(document), uid: document.id, emailCanonical: email,
          revision: allowanceRevision(data), migrated: true
        };
      });
      return result;
    }

    async function upsertTeacherAllowance(email, role, actor) {
      void email; void role; void actor;
      throw new Error('이메일 전용 allowance 변경은 폐쇄되었습니다. exact UID/email/revision API를 사용하세요.');
    }

    async function disableTeacherAllowance(email, actor) {
      void email; void actor;
      throw new Error('이메일 전용 allowance 변경은 폐쇄되었습니다. exact UID/email/revision API를 사용하세요.');
    }

    async function getCounterMigrationState() {
      const snapshot = await db.doc('migration_gates/set_counters').get({ source: 'server' });
      if (!snapshot || !snapshot.exists) return { ready: false, reason: 'missing' };
      const data = snapshot.data() || {};
      const required = ['locked', 'lockId', 'projectId', 'targetMode', 'lockedAt', 'lockedByUid',
        'unlockedAt', 'unlockedByUid'];
      const complete = required.every(key => data[key] != null);
      const ready = complete && data.locked === false &&
        typeof data.lockId === 'string' && data.lockId.length > 0 &&
        typeof data.projectId === 'string' && data.projectId.length > 0 &&
        ['production', 'emulator'].includes(data.targetMode);
      return { ready, locked: data.locked === true, projectId: data.projectId || '', targetMode: data.targetMode || '', reason: ready ? '' : 'locked-or-incomplete' };
    }

    async function listQuizSets(options) {
      const config = options || {};
      const adminAll = config.role === 'admin' &&
        (config.allowAdminAll === true || config.allowAdminTrash === true);
      if (!adminAll && (typeof config.ownerUid !== 'string' || !config.ownerUid.trim())) {
        throw new Error('비관리자 세트 목록에는 정확한 ownerUid 소유자 제한이 필요합니다.');
      }
      let query = db.collection('quiz_sets');
      if (typeof query.where === 'function') {
        const state = config.lifecycleState || 'active';
        if (state !== 'active' && !config.ownerUid && config.allowAdminTrash !== true) {
          throw new Error('휴지통 목록은 소유자 제한이 필요합니다.');
        }
        if (config.includeTrash && !config.lifecycleState) {
          throw new Error('휴지통과 정리 중 목록을 한 번에 조회할 수 없습니다.');
        }
        query = query.where('lifecycleState', '==', state);
        if (!adminAll || config.ownerUid) {
          query = query.where('ownerUid', '==', config.ownerUid);
        }
      }
      const snapshot = await query.get();
      return snapshot.docs.map(quizSetValue);
    }

    async function listSharedQuizSets(actor) {
      const current = actor || {};
      const email = actorEmail(current);
      if (!current.uid || !email || !['teacher', 'admin'].includes(current.role)) {
        throw new Error('공동편집 shared discovery에는 승인 교사 identity가 필요합니다.');
      }
      const snapshot = await db.collection('quiz_set_shares/' + email + '/sets')
        .limit(50).get({ source: 'server' });
      const setIds = [...new Set((snapshot.docs || []).map(document => {
        const value = document && typeof document.data === 'function'
          ? document.data() || {} : {};
        return value.email === email && value.setId === document.id &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(document.id)
          ? document.id : '';
      }).filter(Boolean))];
      const sets = await Promise.all(setIds.map(async setId => {
        try {
          const parent = await db.doc('quiz_sets/' + setId).get({ source: 'server' });
          return quizSetValue(parent);
        } catch (error) {
          if (permissionDenied(error)) return null;
          throw error;
        }
      }));
      return sets.filter(set => set && set.ownerUid !== current.uid && activeSet(set));
    }

    function actorEmail(actor) {
      return collaboration.canonicalEmail(actor && actor.email);
    }

    function activeSet(value) {
      return !!value && !value.trashedAt && !value.purgeStartedAt &&
        (!value.lifecycleState || value.lifecycleState === 'active');
    }

    async function canEditQuizSet(setId, actor) {
      const set = await getQuizSet(setId);
      if (!set || !activeSet(set) || !actor || !actor.uid) return false;
      if (set.ownerUid === actor.uid) return true;
      const email = actorEmail(actor);
      if (!email) return false;
      const collaborator = await db.doc(
        'quiz_sets/' + setId + '/collaborators/' + email
      ).get({ source: 'server' });
      return collaborator.exists && (actor.role === 'teacher' || actor.role === 'admin');
    }

    async function listCollaborators(setId, actor) {
      const allowed = await canEditQuizSet(setId, actor);
      if (!allowed) throw new Error('공동 편집자 목록을 볼 권한이 없습니다.');
      const snapshot = await db.collection('quiz_sets/' + setId + '/collaborators').get();
      return snapshot.docs.map(document => ({ ...document.data(), email: document.id }));
    }

    function listTrashQuizSets(ownerUid, lifecycleState) {
      const state = lifecycleState || 'trashed';
      if (!['trashed', 'purging'].includes(state)) {
        return Promise.reject(new Error('휴지통 상태가 올바르지 않습니다.'));
      }
      return listQuizSets({ ownerUid, lifecycleState: state });
    }

    function trashDateMillis(value) {
      return timestampMillis(value && value.trashedAt);
    }

    function purgeDateMillis(value) {
      return timestampMillis(value && value.purgeStartedAt);
    }

    function lifecycleWithdrawalWrite(publicSnapshot, publicationId) {
      if (!publicSnapshot || !publicSnapshot.exists) return null;
      const raw = publicSnapshot.data() || {};
      const projection = requireStoredProjection(
        raw, publicationId
      );
      if (projection.status === 'building') {
        return {
          ...raw,
          status: 'cancelled',
          moderationStatus: 'clear',
          updatedAt: fieldValue.serverTimestamp()
        };
      }
      if (projection.status !== 'published') return null;
      const withdrawn = {
        ...projection,
        status: 'withdrawn',
        moderationStatus: 'clear',
        updatedAt: projection.updatedAt
      };
      if (!publicLibraryCore().validateParent(withdrawn).ok) {
        throw new Error('lifecycle 철회 projection이 유효하지 않습니다.');
      }
      return { ...withdrawn, updatedAt: fieldValue.serverTimestamp() };
    }

    async function moveSetToTrash(setId, actor) {
      const current = actor || {};
      const reference = db.doc('quiz_sets/' + setId);
      const publicReference = db.doc('published_quiz_sets/' + setId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        const publicSnapshot = await transaction.get(publicReference);
        const set = quizSetValue(snapshot);
        if (!set || set.ownerUid !== current.uid || !activeSet(set)) {
          throw new Error('소유자만 활성 세트를 휴지통으로 이동할 수 있습니다.');
        }
        requireAuthoritativeCounters(set);
        const withdrawal = lifecycleWithdrawalWrite(publicSnapshot, setId);
        if (withdrawal && requireContentRevision(set) !== withdrawal.revision) {
          throw new Error('원본과 공개 projection revision이 일치하지 않습니다.');
        }
        transaction.set(reference, {
          trashedAt: fieldValue.serverTimestamp(),
          purgeStartedAt: null,
          lifecycleState: 'trashed',
          contentRevision: fieldValue.serverTimestamp()
        }, { merge: true });
        if (withdrawal) transaction.set(publicReference, withdrawal);
        return true;
      });
    }

    async function restoreSet(setId, actor) {
      const current = actor || {};
      const reference = db.doc('quiz_sets/' + setId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        const set = quizSetValue(snapshot);
        if (!set || set.ownerUid !== current.uid || !set.trashedAt || set.purgeStartedAt) {
          throw new Error('정리 시작 전 휴지통 세트의 소유자만 복원할 수 있습니다.');
        }
        requireAuthoritativeCounters(set);
        transaction.set(reference, {
          trashedAt: fieldValue.delete(),
          lifecycleState: 'active',
          contentRevision: fieldValue.serverTimestamp()
        }, { merge: true });
        return true;
      });
    }

    async function beginSetPurge(setId, mode, actor) {
      const current = actor || {};
      const purgeMode = mode || 'immediate';
      if (!['immediate', 'expired'].includes(purgeMode)) {
        throw new Error('영구 삭제 방식이 올바르지 않습니다.');
      }
      const reference = db.doc('quiz_sets/' + setId);
      const publicReference = db.doc('published_quiz_sets/' + setId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        const publicSnapshot = await transaction.get(publicReference);
        const set = quizSetValue(snapshot);
        if (!set || !set.trashedAt) {
          throw new Error('휴지통에 있는 세트만 영구 삭제할 수 있습니다.');
        }
        if (set.purgeStartedAt) return { started: false, purgeStartedAt: purgeDateMillis(set) };
        if (!Number.isInteger(set.collaboratorCount) || set.collaboratorCount < 0 ||
            set.collaboratorCount > 20 || !Number.isInteger(set.imageCount) ||
            set.imageCount < 0) {
          throw new Error('영구 삭제 전에 세트 문서의 authoritative counter migration이 필요합니다.');
        }
        const owner = set.ownerUid === current.uid;
        const admin = current.role === 'admin';
        const expired = collaboration.trashRetention({ trashedAt: trashDateMillis(set) }, serverNow()).expired;
        if (purgeMode === 'immediate' && !owner) {
          throw new Error('즉시 영구 삭제는 소유자만 시작할 수 있습니다.');
        }
        if (purgeMode !== 'immediate' && !(owner || admin) || (purgeMode !== 'immediate' && !expired)) {
          throw new Error('30일이 지나기 전에는 영구 삭제할 수 없습니다.');
        }
        const withdrawal = lifecycleWithdrawalWrite(publicSnapshot, setId);
        if (withdrawal && requireContentRevision(set) !== withdrawal.revision) {
          throw new Error('원본과 공개 projection revision이 일치하지 않습니다.');
        }
        transaction.set(reference, {
          purgeStartedAt: fieldValue.serverTimestamp(),
          lifecycleState: 'purging'
        }, { merge: true });
        if (withdrawal) transaction.set(publicReference, withdrawal);
        return { started: true };
      });
    }

    async function purgeOneChild(setId, type, document) {
      const parentReference = db.doc('quiz_sets/' + setId);
      return db.runTransaction(async transaction => {
        const parentSnapshot = await transaction.get(parentReference);
        const parent = quizSetValue(parentSnapshot);
        const childSnapshot = await transaction.get(document.ref);
        if (!parent || !childSnapshot.exists) return false;
        if (!parent.purgeStartedAt || parent.lifecycleState !== 'purging') {
          throw new Error('정리 세트 상태가 변경되어 삭제를 중단했습니다.');
        }
        if (type === 'collaborator') {
          requireAuthoritativeCounters(parent);
          const count = parent.collaboratorCount;
          if (count < 1) throw new Error('공동 편집자 수가 올바르지 않습니다.');
          transaction.set(parentReference, {
            collaboratorCount: count - 1,
            collaboratorMutation: { email: document.id, action: 'purge-remove' }
          }, { merge: true });
          transaction.delete(db.doc(
            'quiz_set_shares/' + document.id + '/sets/' + setId
          ));
        } else {
          requireAuthoritativeCounters(parent);
          const count = parent.imageCount;
          if (count < 1) throw new Error('이미지 수가 올바르지 않습니다.');
          transaction.set(parentReference, {
            imageCount: count - 1,
            imageMutation: { key: document.id, action: 'purge-remove' }
          }, { merge: true });
        }
        transaction.delete(document.ref);
        return true;
      });
    }

    async function continueSetPurge(setId) {
      const reference = db.doc('quiz_sets/' + setId);
      const snapshot = await reference.get();
      const set = quizSetValue(snapshot);
      if (!set) return { done: true, parentDeleted: true, deleted: 0 };
      if (!set.purgeStartedAt || set.lifecycleState !== 'purging') {
        throw new Error('정리 시작된 세트만 계속 삭제할 수 있습니다.');
      }
      const collaboratorSnapshot = await db.collection(
        'quiz_sets/' + setId + '/collaborators'
      ).limit(200).get();
      let deleted = 0;
      for (const document of collaboratorSnapshot.docs) {
        if (await purgeOneChild(setId, 'collaborator', document)) deleted += 1;
      }
      if (deleted < 200) {
        const imageSnapshot = await db.collection('images/' + setId + '/q')
          .limit(200 - deleted).get();
        for (const document of imageSnapshot.docs) {
          if (await purgeOneChild(setId, 'image', document)) deleted += 1;
        }
      }
      if (deleted < 200) {
        const publicImageSnapshot = await db.collection(
          'published_quiz_sets/' + setId + '/images'
        ).limit(200 - deleted).get({ source: 'server' });
        storedPublicImages(publicImageSnapshot);
        const publicImageBatch = db.batch();
        for (const document of publicImageSnapshot.docs) {
          publicImageBatch.delete(document.ref);
          deleted += 1;
        }
        if (!publicImageSnapshot.empty) await publicImageBatch.commit();
      }
      if (deleted > 0) return { done: false, deleted, parentDeleted: false };

      // Both child collections were observed empty. The transaction re-reads the
      // parent and deletes only the same purge generation, with the Rules closing
      // child creation once purgeStartedAt exists.
      const collaboratorProbe = await db.collection(
        'quiz_sets/' + setId + '/collaborators'
      ).limit(1).get();
      const imageProbe = await db.collection('images/' + setId + '/q').limit(1).get();
      const publicImageProbe = await db.collection(
        'published_quiz_sets/' + setId + '/images'
      ).limit(1).get({ source: 'server' });
      const publicParentSnapshot = await db.doc(
        'published_quiz_sets/' + setId
      ).get({ source: 'server' });
      if (publicParentSnapshot.exists) {
        const publicParent = requireStoredProjection(
          publicParentSnapshot.data() || {}, setId
        );
        if (publicParent.status === 'published') {
          throw new Error('공개 projection이 보이는 동안 원본 parent를 정리할 수 없습니다.');
        }
      }
      if (!collaboratorProbe.empty || !imageProbe.empty || !publicImageProbe.empty) {
        return { done: false, deleted: 0, parentDeleted: false };
      }
      const result = await db.runTransaction(async transaction => {
        const latestSnapshot = await transaction.get(reference);
        const latest = quizSetValue(latestSnapshot);
        if (!latest) return { done: true, parentDeleted: true, deleted: 0 };
        if (!latest.purgeStartedAt || latest.lifecycleState !== 'purging' ||
            latest.collaboratorCount !== 0 || latest.imageCount !== 0) {
          throw new Error('정리 세트 검증 상태가 변경되어 삭제를 중단했습니다.');
        }
        transaction.delete(reference);
        return { done: true, parentDeleted: true, deleted: 0 };
      });
      return result;
    }

    async function listTrash(scope) {
      const config = typeof scope === 'string' ? { ownerUid: scope } : (scope || {});
      if (config.lifecycleState) {
        return listQuizSets({
          ownerUid: config.ownerUid, role: config.role,
          lifecycleState: config.lifecycleState, allowAdminTrash: config.role === 'admin'
        });
      }
      const options = {
        ownerUid: config.ownerUid, role: config.role,
        allowAdminTrash: config.role === 'admin'
      };
      const [trashed, purging] = await Promise.all([
        listQuizSets({ ...options, lifecycleState: 'trashed' }),
        listQuizSets({ ...options, lifecycleState: 'purging' })
      ]);
      return trashed.concat(purging);
    }

    async function listExpiredTrash(scope, limit) {
      const config = typeof scope === 'string' ? { ownerUid: scope } : (scope || {});
      const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 20;
      const listOptions = {
        ownerUid: config.ownerUid, role: config.role,
        allowAdminTrash: config.role === 'admin'
      };
      const [trashed, purging] = await Promise.all([
        listQuizSets({ ...listOptions, lifecycleState: 'trashed' }),
        listQuizSets({ ...listOptions, lifecycleState: 'purging' })
      ]);
      const now = serverNow();
      return trashed.concat(purging).filter(set =>
        set.purgeStartedAt || collaboration.trashRetention(set, now).expired
      ).slice(0, max);
    }

    async function addCollaborator(setId, email, actor) {
      const current = actor || {};
      const normalizedEmail = collaboration.canonicalEmail(email);
      if (!current.uid || !current.email || !normalizedEmail) {
        throw new Error('공동 편집자를 추가할 권한이 없습니다.');
      }
      const setReference = db.doc('quiz_sets/' + setId);
      const collaboratorReference = db.doc(
        'quiz_sets/' + setId + '/collaborators/' + normalizedEmail
      );
      const shareReference = db.doc(
        'quiz_set_shares/' + normalizedEmail + '/sets/' + setId
      );
      const [setSnapshot, collaboratorsSnapshot] = await Promise.all([
        setReference.get({ source: 'server' }),
        db.collection('quiz_sets/' + setId + '/collaborators').get()
      ]);
      const set = quizSetValue(setSnapshot);
      const existing = collaboratorsSnapshot.docs.map(document => document.id);
      const validation = collaboration.validateCollaboratorChange({
        ownerEmail: set && set.ownerEmail,
        email: normalizedEmail,
        // The target allowance is private to admins. Firestore Rules validates it
        // authoritatively as part of the atomic collaborator + counter write.
        enabled: true,
        existing
      });
      if (!set || set.ownerUid !== current.uid || !activeSet(set)) {
        throw new Error('소유자만 활성 세트의 공동 편집자를 관리할 수 있습니다.');
      }
      if (validation.code) throw new Error('공동 편집자 추가가 거부되었습니다: ' + validation.code);
      try {
        return await db.runTransaction(async transaction => {
          const latestSnapshot = await transaction.get(setReference);
          const existingTarget = await transaction.get(collaboratorReference);
          const latest = quizSetValue(latestSnapshot);
          if (!latest || latest.ownerUid !== current.uid || !activeSet(latest)) {
            throw new Error('소유자만 활성 세트의 공동 편집자를 관리할 수 있습니다.');
          }
          if (existingTarget.exists) throw new Error('이미 공동 편집자로 등록되어 있습니다.');
          requireAuthoritativeCounters(latest);
          const count = latest.collaboratorCount;
          if (count < 0 || count >= 20) throw new Error('공동 편집자는 최대 20명까지 추가할 수 있습니다.');
          transaction.set(collaboratorReference, {
            email: normalizedEmail,
            addedByUid: current.uid,
            addedAt: fieldValue.serverTimestamp()
          });
          transaction.set(shareReference, {
            email: normalizedEmail,
            setId
          });
          transaction.set(setReference, {
            collaboratorCount: count + 1,
            collaboratorMutation: { email: normalizedEmail, action: 'add' }
          }, { merge: true });
          return normalizedEmail;
        });
      } catch (error) {
        if (permissionDenied(error)) {
          throw new Error('승인된 교사만 공동 편집자로 추가할 수 있습니다.');
        }
        throw error;
      }
    }

    async function removeCollaborator(setId, email, actor) {
      const current = actor || {};
      const normalizedEmail = collaboration.canonicalEmail(email);
      const setReference = db.doc('quiz_sets/' + setId);
      const collaboratorReference = db.doc(
        'quiz_sets/' + setId + '/collaborators/' + normalizedEmail
      );
      const shareReference = db.doc(
        'quiz_set_shares/' + normalizedEmail + '/sets/' + setId
      );
      return db.runTransaction(async transaction => {
        const setSnapshot = await transaction.get(setReference);
        const collaboratorSnapshot = await transaction.get(collaboratorReference);
        const set = quizSetValue(setSnapshot);
        if (!set || set.ownerUid !== current.uid || !activeSet(set)) {
          throw new Error('소유자만 활성 세트의 공동 편집자를 관리할 수 있습니다.');
        }
        if (!collaboratorSnapshot.exists) return false;
        requireAuthoritativeCounters(set);
        const count = set.collaboratorCount;
        if (count < 1) throw new Error('공동 편집자 수가 올바르지 않습니다.');
        transaction.delete(collaboratorReference);
        transaction.delete(shareReference);
        transaction.set(setReference, {
          collaboratorCount: count - 1,
          collaboratorMutation: { email: normalizedEmail, action: 'remove' }
        }, { merge: true });
        return true;
      });
    }

    function getQuizSet(setId) {
      return db.doc('quiz_sets/' + setId).get().then(quizSetValue);
    }

    function requireAuthoritativeCounters(set) {
      if (!set || !Number.isInteger(set.collaboratorCount) ||
          set.collaboratorCount < 0 || set.collaboratorCount > 20 ||
          !Number.isInteger(set.imageCount) || set.imageCount < 0) {
        throw new Error('세트 저장 전에 authoritative counter migration이 필요합니다.');
      }
      return set;
    }

    function initializedQuizSet(value) {
      const data = withoutDocumentId(value);
      delete data.collaboratorMutation;
      delete data.imageMutation;
      delete data.trashedAt;
      delete data.purgeStartedAt;
      return {
        ...data,
        lifecycleState: 'active',
        collaboratorCount: 0,
        imageCount: 0
      };
    }

    async function saveQuizSet(setId, value, actor) {
      if (actor && !(await canEditQuizSet(setId, actor))) {
        throw new Error('퀴즈 세트를 편집할 권한이 없습니다.');
      }
      const reference = db.doc('quiz_sets/' + setId);
      const snapshot = await reference.get();
      return reference.set(snapshot.exists
        ? withoutDocumentId(value)
        : initializedQuizSet(value));
    }

    const ownedQuizSet = (value, teacher) => ({
      ...withoutDocumentId(value),
      lifecycleState: withoutDocumentId(value).lifecycleState || 'active',
      imageCount: Number.isInteger(withoutDocumentId(value).imageCount)
        ? withoutDocumentId(value).imageCount : 0,
      collaboratorCount: Number.isInteger(withoutDocumentId(value).collaboratorCount)
        ? withoutDocumentId(value).collaboratorCount : 0,
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

    async function saveQuizSetWithImages(setId, value, images, actor) {
      if (actor && !(await canEditQuizSet(setId, actor))) {
        throw new Error('퀴즈 세트를 편집할 권한이 없습니다.');
      }
      const path = 'images/' + setId + '/q';
      const next = normalizedImages(images);
      let storedSet = withContentRevision(value);
      const estimateOptions = {
        setPath: 'quiz_sets/' + setId,
        imagePath: path
      };
      assertRequestAllowed(requestEstimate(storedSet, next, estimateOptions));
      const parentSnapshot = await db.doc('quiz_sets/' + setId).get();
      const current = parentSnapshot.exists
        ? await db.collection(path).get().then(collectionValue)
        : {};
      if (parentSnapshot.exists) {
        requireAuthoritativeCounters(parentSnapshot.data() || {});
      } else {
        storedSet = withContentRevision(initializedQuizSet(value));
      }
      let counterReady = parentSnapshot.exists;
      const deletes = Object.keys(current).filter(questionIndex =>
        questionIndex !== imageKey(questionIndex) ||
        !Object.prototype.hasOwnProperty.call(next, questionIndex)
      );
      estimateOptions.deleteDocuments = Object.fromEntries(
        deletes.map(questionIndex => [questionIndex, current[questionIndex]])
      );
      estimateOptions.previousDocuments = {};
      if (parentSnapshot.exists) {
        estimateOptions.previousDocuments['quiz_sets/' + setId] = parentSnapshot.data();
      }
      Object.keys(next).forEach(questionIndex => {
        if (Object.prototype.hasOwnProperty.call(current, questionIndex)) {
          estimateOptions.previousDocuments[path + '/' + questionIndex] = current[questionIndex];
        }
      });
      assertRequestAllowed(requestEstimate(storedSet, next, estimateOptions));
      const parentReference = db.doc('quiz_sets/' + setId);
      if (!parentSnapshot.exists) {
        await parentReference.set(withoutDocumentId(storedSet));
        counterReady = true;
      } else {
        const previous = parentSnapshot.data() || {};
        const contentDocument = withoutDocumentId(storedSet);
        for (const key of [
          'ownerUid', 'ownerEmail', 'lifecycleState', 'trashedAt', 'purgeStartedAt',
          'collaboratorCount', 'collaboratorMutation', 'imageCount', 'imageMutation'
        ]) {
          if (Object.prototype.hasOwnProperty.call(previous, key)) contentDocument[key] = previous[key];
          else delete contentDocument[key];
        }
        await parentReference.set(contentDocument);
      }
      if (counterReady) {
        let count = parentSnapshot.exists ? Number(parentSnapshot.data().imageCount) : 0;
        const operations = [];
        deletes.forEach(questionIndex => {
          operations.push({ key: questionIndex, action: 'remove' });
        });
        Object.entries(next).forEach(([questionIndex]) => {
          operations.push({
            key: questionIndex,
            action: Object.prototype.hasOwnProperty.call(current, questionIndex)
              ? 'update' : 'add',
            data: next[questionIndex]
          });
        });
        for (const operation of operations) {
          const childReference = db.doc(path + '/' + operation.key);
          await db.runTransaction(async transaction => {
            const latestParent = await transaction.get(parentReference);
            const latestChild = await transaction.get(childReference);
            const latest = quizSetValue(latestParent) || {};
            requireAuthoritativeCounters(latest);
            let nextCount = latest.imageCount;
            if (operation.action === 'add' && !latestChild.exists) nextCount += 1;
            if (operation.action === 'remove' && latestChild.exists) {
              if (nextCount < 1) throw new Error('이미지 수 counter underflow를 거부했습니다.');
              nextCount -= 1;
            }
            const patch = {};
            patch.imageCount = nextCount;
            patch.contentRevision = fieldValue.serverTimestamp();
            if (operation.action !== 'update') {
              patch.imageMutation = { key: operation.key, action: operation.action };
            }
            transaction.set(parentReference, patch, { merge: true });
            if (operation.action === 'remove') transaction.delete(childReference);
            else transaction.set(childReference, { data: operation.data });
            count = nextCount;
          });
        }
        return;
      }
      throw new Error('세트 저장 전에 authoritative counter migration이 필요합니다.');
    }

    function saveOwnedQuizSet(setId, value, images, teacher) {
      return saveQuizSetWithImages(setId, ownedQuizSet(value, teacher), images);
    }

    async function patchQuizSet(setId, value, actor) {
      const data = withoutDocumentId(value);
      if (Object.prototype.hasOwnProperty.call(data, 'archived') && actor) {
        const current = await getQuizSet(setId);
        if (!current || current.ownerUid !== actor.uid || !(await canEditQuizSet(setId, actor))) {
          throw new Error('소유자만 세트 숨김 상태를 변경할 수 있습니다.');
        }
      }
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

    async function replaceImages(setId, images, actor) {
      if (actor && !(await canEditQuizSet(setId, actor))) {
        throw new Error('퀴즈 세트 이미지를 편집할 권한이 없습니다.');
      }
      const path = 'images/' + setId + '/q';
      const next = normalizedImages(images);
      const revisionPatch = { contentRevision: fieldValue.serverTimestamp() };
      const estimateOptions = {
        setPath: 'quiz_sets/' + setId,
        imagePath: path
      };
      assertRequestAllowed(requestEstimate(revisionPatch, next, estimateOptions));
      const parentSnapshot = await db.doc('quiz_sets/' + setId).get();
      if (!parentSnapshot.exists) throw new Error('이미지를 저장할 퀴즈 세트를 찾을 수 없습니다.');
      requireAuthoritativeCounters(parentSnapshot.data() || {});
      await saveQuizSetWithImages(setId, {
        ...(parentSnapshot.data() || {}), contentRevision: fieldValue.serverTimestamp()
      }, images, actor);
    }

    function sanitizedCopy(value, newId, patch) {
      const copy = { ...withoutDocumentId(value), ...(patch || {}), id: newId };
      copy.collaboratorCount = 0;
      copy.imageCount = 0;
      delete copy.collaboratorMutation;
      delete copy.imageMutation;
      delete copy.trashedAt;
      delete copy.purgeStartedAt;
      copy.lifecycleState = 'active';
      return copy;
    }

    async function copyQuizSet(sourceId, newId, patch) {
      const source = await getQuizSet(sourceId);
      if (!source) return null;
      const images = await getImages(sourceId);
      const copy = sanitizedCopy(source, newId, patch);
      await saveQuizSetWithImages(newId, copy, images);
      return copy;
    }

    async function copyOwnedQuizSet(sourceId, newId, teacher) {
      const sourceReference = db.doc('quiz_sets/' + sourceId);
      const destinationReference = db.doc('quiz_sets/' + newId);
      const copyValue = current => ownedQuizSet({
        ...sanitizedCopy(current, newId),
        title: ((current.title || '제목 없음') + ' (사본)').slice(0, 200),
        createdAt: fieldValue.serverTimestamp(),
        updatedAt: fieldValue.serverTimestamp(),
        contentRevision: fieldValue.serverTimestamp()
      }, teacher);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await getQuizSet(sourceId);
        if (!before) return null;
        if (!activeSet(before)) throw new Error('휴지통 또는 정리 중인 세트는 복사할 수 없습니다.');
        const images = await getImages(sourceId);
        const entries = Object.entries(normalizedImages(images));
        const destinationImagePath = 'images/' + newId + '/q';
        const destinationSnapshot = await destinationReference.get();
        const destinationImages = destinationSnapshot.exists
          ? await db.collection(destinationImagePath).get().then(collectionValue)
          : {};
        const previousDocuments = {};
        if (destinationSnapshot.exists) {
          previousDocuments['quiz_sets/' + newId] = destinationSnapshot.data();
        }
        entries.forEach(([questionIndex]) => {
          if (Object.prototype.hasOwnProperty.call(destinationImages, questionIndex)) {
            previousDocuments[destinationImagePath + '/' + questionIndex] =
              destinationImages[questionIndex];
          }
        });
        assertRequestAllowed(requestEstimate(
          copyValue(before), Object.fromEntries(entries), {
            setPath: 'quiz_sets/' + newId,
            imagePath: destinationImagePath,
            previousDocuments
          }
        ));
        const result = await db.runTransaction(async transaction => {
          const currentSnapshot = await transaction.get(sourceReference);
          const current = quizSetValue(currentSnapshot);
          if (!current) return { missing: true };
          if (!sameRevision(before, current)) return { retry: true };
          const copy = copyValue(current);
          transaction.set(destinationReference, withoutDocumentId(copy));
          return { copy };
        });
        if (result.missing) return null;
        if (!result.retry) {
          await saveQuizSetWithImages(newId, result.copy, Object.fromEntries(entries));
          return { ...result.copy, id: newId, imageCount: entries.length };
        }
      }
      throw new Error('원본 세트가 계속 변경되어 사본을 만들지 못했습니다. 다시 시도해 주세요.');
    }

    function publicLibraryCore() {
      const value = publicQuizLibrary ||
        (typeof globalThis !== 'undefined' && globalThis.PublicQuizLibraryCore);
      if (!value || typeof value.buildProjection !== 'function' ||
          typeof value.validateProjection !== 'function' ||
          typeof value.copyPatch !== 'function' ||
          typeof value.publicSummary !== 'function') {
        throw new Error('PublicQuizLibraryCore가 준비되지 않았습니다.');
      }
      return value;
    }

    function canonicalPublicationId(value, name) {
      const id = String(value == null ? '' : value);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
        throw new Error((name || 'publicationId') + '가 canonical 형식이 아닙니다.');
      }
      return id;
    }

    function contentRevisionToken(value) {
      if (typeof value === 'string') {
        const revision = value.trim();
        if (revision && revision.length <= 200) return revision;
        return '';
      }
      if (Number.isSafeInteger(value) && value >= 0) return String(value);
      if (value instanceof Date && Number.isSafeInteger(value.getTime()) && value.getTime() >= 0) {
        return String(value.getTime());
      }
      if (value && typeof value.toMillis === 'function') {
        const millis = value.toMillis();
        if (!Number.isSafeInteger(millis) || millis < 0) return '';
        if (Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 &&
            value.nanoseconds < 1_000_000_000) {
          const revision = millis + ':' + value.nanoseconds;
          return revision.length <= 200 ? revision : '';
        }
        return String(millis);
      }
      if (value && Number.isInteger(value.seconds) && value.seconds >= 0 &&
          Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 &&
          value.nanoseconds < 1_000_000_000) {
        const revision = value.seconds + ':' + value.nanoseconds;
        return revision.length <= 200 ? revision : '';
      }
      return '';
    }

    function requireContentRevision(source) {
      const revision = contentRevisionToken(source && source.contentRevision);
      if (!revision) throw new Error('원본 content revision이 유효하지 않습니다.');
      return revision;
    }

    function publicServerNowMs() {
      const value = Math.trunc(serverNow());
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('공개 자료실 서버 시각이 유효하지 않습니다.');
      }
      return value;
    }

    function publicProjectionValue(value) {
      const source = value || {};
      return Object.fromEntries(publicLibraryCore().PUBLIC_PARENT_KEYS
        .filter(key => Object.prototype.hasOwnProperty.call(source, key))
        .map(key => [key, source[key]]));
    }

    function storedProjectionAllowedKeys(status) {
      const allowed = new Set(publicLibraryCore().PUBLIC_PARENT_KEYS);
      if (status === 'building' || status === 'cancelled') {
        allowed.add('buildToken');
        allowed.add('buildVideoCount');
        allowed.add('buildQuestionCount');
        allowed.add('buildImageCount');
        allowed.add('buildMutation');
      }
      return allowed;
    }

    function requireStoredProjection(value, publicationId, requiredStatus) {
      const raw = value || {};
      const status = raw.status;
      const allowed = storedProjectionAllowedKeys(status);
      if (Object.keys(raw).some(key => !allowed.has(key))) {
        throw new Error('공개 projection에 허용되지 않은 필드가 있습니다.');
      }
      const projection = publicProjectionValue(raw);
      const validation = publicLibraryCore().validateParent(projection);
      if (!validation.ok || projection.publicationId !== publicationId ||
          projection.sourceSetId !== publicationId) {
        throw new Error('공개 projection 형식 또는 원본 연결이 유효하지 않습니다.');
      }
      if (requiredStatus && projection.status !== requiredStatus) {
        throw new Error(requiredStatus + ' 공개 projection만 처리할 수 있습니다.');
      }
      if ((status === 'building' || status === 'cancelled') &&
          (typeof raw.buildToken !== 'string' || !raw.buildToken ||
           !Number.isSafeInteger(raw.buildVideoCount) || raw.buildVideoCount < 0 ||
           !Number.isSafeInteger(raw.buildQuestionCount) || raw.buildQuestionCount < 0 ||
           !Number.isSafeInteger(raw.buildImageCount) || raw.buildImageCount < 0)) {
        throw new Error('building 공개 projection counter가 유효하지 않습니다.');
      }
      return projection;
    }

    async function publicRevisionDocuments(publicationId, collectionName, revision) {
      const snapshot = await db.collection(
        'published_quiz_sets/' + publicationId + '/' + collectionName
      ).where('revision', '==', revision)
        .where('schemaVersion', '==', publicLibraryCore().PUBLIC_CHILD_SCHEMA_VERSION)
        .get({ source: 'server' });
      return Object.fromEntries((snapshot.docs || []).map(document => [
        document.id, document.data() || {}
      ]));
    }

    async function assembleStoredProjection(parent, publicationId) {
      const [videos, questions] = await Promise.all([
        publicRevisionDocuments(publicationId, 'videos', parent.revision),
        publicRevisionDocuments(publicationId, 'questions', parent.revision)
      ]);
      return publicLibraryCore().assembleProjection(parent, videos, questions);
    }

    function publicTimestampMillis(value, name) {
      let millis = null;
      try {
        millis = value instanceof Date
          ? value.getTime()
          : timestampMillis(value);
        if (millis === null && value && Number.isInteger(value.seconds) &&
            Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 &&
            value.nanoseconds < 1_000_000_000) {
          millis = value.seconds * 1000 + value.nanoseconds / 1_000_000;
        }
      } catch (_) {
        millis = null;
      }
      if (typeof millis !== 'number' || !Number.isFinite(millis) || millis < 0) {
        throw new Error((name || '공개 timestamp') + '가 유효하지 않습니다.');
      }
      return millis;
    }

    function requireModerationAudit(value, publicationId, revision, requiredStatus) {
      const raw = value || {};
      const status = raw.status;
      const allowed = status === 'restored'
        ? [
            'publicationId', 'revision', 'status', 'moderatedByUid',
            'moderationReason', 'moderatedAt', 'restoredByUid', 'restoredAt'
          ]
        : [
            'publicationId', 'revision', 'status', 'moderatedByUid',
            'moderationReason', 'moderatedAt'
          ];
      const reason = typeof raw.moderationReason === 'string'
        ? raw.moderationReason.trim() : '';
      if (!['moderated', 'restored'].includes(status) ||
          Object.keys(raw).length !== allowed.length ||
          Object.keys(raw).some(key => !allowed.includes(key)) ||
          raw.publicationId !== publicationId || raw.revision !== revision ||
          typeof raw.moderatedByUid !== 'string' || !raw.moderatedByUid ||
          reason.length < 1 || reason.length > 200) {
        throw new Error('관리자 공개 중지 audit 문서가 유효하지 않습니다.');
      }
      const moderatedAtMs = publicTimestampMillis(raw.moderatedAt, 'moderatedAt');
      if (status === 'restored' &&
          (typeof raw.restoredByUid !== 'string' || !raw.restoredByUid ||
           publicTimestampMillis(raw.restoredAt, 'restoredAt') < moderatedAtMs)) {
        throw new Error('관리자 공개 복구 audit 문서가 유효하지 않습니다.');
      }
      if (requiredStatus && status !== requiredStatus) {
        throw new Error(requiredStatus + ' audit 문서만 처리할 수 있습니다.');
      }
      return raw;
    }

    async function authoritativePublicProjection(
      publicRef, publicationId, requiredStatus, previousUpdatedAt
    ) {
      const snapshot = await publicRef.get({ source: 'server' });
      if (!snapshot.exists) throw new Error('서버 공개 projection 재읽기에 실패했습니다.');
      const projection = requireStoredProjection(
        snapshot.data() || {}, publicationId, requiredStatus
      );
      const nextUpdatedAtMs = publicTimestampMillis(projection.updatedAt, 'updatedAt');
      if (previousUpdatedAt !== undefined && previousUpdatedAt !== null &&
          nextUpdatedAtMs < publicTimestampMillis(previousUpdatedAt, '이전 updatedAt')) {
        throw new Error('서버 공개 projection updatedAt이 이전 시각보다 퇴행했습니다.');
      }
      return projection;
    }

    function activeAllowanceIdentity(snapshot, uid, email, roles) {
      if (!snapshot || !snapshot.exists) return null;
      const value = snapshot.data() || {};
      const exactEmail = canonicalTeacherEmail(email);
      const allowedRoles = roles || ['teacher', 'admin'];
      if (!uid || !exactEmail || value.uid !== uid ||
          value.emailCanonical !== exactEmail || value.status !== 'active' ||
          value.enabled !== true || !allowedRoles.includes(value.role)) return null;
      return value;
    }

    function requireActiveActorAllowance(snapshot, actor) {
      const current = actor || {};
      const allowance = activeAllowanceIdentity(
        snapshot, current.uid, current.email, ['teacher', 'admin']
      );
      if (!allowance) {
        throw new Error('active 승인 교사 allowance가 유효하지 않습니다.');
      }
      return allowance;
    }

    function requireActiveSourceOwnerIdentity(source, allowanceSnapshot, actor) {
      const value = source || {};
      if (!activeSet(value)) throw new Error('active 원본 세트만 공개할 수 있습니다.');
      const ownerEmail = canonicalTeacherEmail(value.ownerEmail);
      if (!value.ownerUid || !ownerEmail) {
        throw new Error('원본 소유자 UID/email binding이 유효하지 않습니다.');
      }
      if (actor && (value.ownerUid !== actor.uid || ownerEmail !== canonicalTeacherEmail(actor.email))) {
        throw new Error('정확한 세트 소유자만 공개 상태를 변경할 수 있습니다.');
      }
      if (!activeAllowanceIdentity(
        allowanceSnapshot, value.ownerUid, ownerEmail, ['teacher', 'admin']
      )) {
        throw new Error('원본 소유자의 active 승인 상태가 유효하지 않습니다.');
      }
      return value;
    }

    function requireActiveSourceOwner(source, allowanceSnapshot, actor) {
      const value = requireActiveSourceOwnerIdentity(
        source, allowanceSnapshot, actor
      );
      requireAuthoritativeCounters(value);
      return value;
    }

    function requirePublicAuthorAllowance(source, allowanceSnapshot, actor) {
      const value = requireActiveSourceOwner(source, allowanceSnapshot, actor);
      const ownerEmail = canonicalTeacherEmail(value.ownerEmail);
      const allowance = activeAllowanceIdentity(
        allowanceSnapshot, value.ownerUid, ownerEmail, ['teacher', 'admin']
      );
      const authorDisplayName = publicAuthorLabelCore().requireSafe(allowance.displayName, {
        emailCanonical: ownerEmail,
        uid: value.ownerUid
      });
      if (actor) {
        const actorLabel = publicAuthorLabelCore().requireSafe(actor.displayName, {
          emailCanonical: actor.email,
          uid: actor.uid
        });
        if (actorLabel !== authorDisplayName) {
          throw new Error('게시 제작자 표시명은 authoritative allowance와 일치해야 합니다.');
        }
      }
      return { source: value, authorDisplayName };
    }

    async function requireAuthoritativePublicationAdmin(transaction, actor) {
      const current = assertAdminIdentity(actor);
      const snapshot = await transaction.get(db.doc('teacher_allowances/' + current.uid));
      if (!snapshot.exists || !validAuthoritativeAdmin(snapshot.data() || {}, current)) {
        throw new Error('authoritative active 관리자 allowance가 유효하지 않습니다.');
      }
      return current;
    }

    function allowedPublicImageData(value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 380_100 &&
        (value.startsWith('data:image/') || value.startsWith('https://'));
    }

    function canonicalPublicImageData(value) {
      return typeof value === 'string' ? value.replace(/^https:\/\//i, 'https://') : value;
    }

    function privatePublicationImages(snapshot) {
      const images = {};
      for (const document of snapshot.docs || []) {
        const key = document.id;
        const data = document.data() || {};
        const normalized = canonicalPublicImageData(data.data);
        if (imageKey(key) !== key || !allowedPublicImageData(normalized)) {
          throw new Error('원본 공개 이미지 키 또는 크기가 유효하지 않습니다.');
        }
        images[key] = normalized;
      }
      return images;
    }

    function storedPublicImages(snapshot, expectedRevision) {
      const images = {};
      const documents = {};
      for (const document of snapshot.docs || []) {
        const key = document.id;
        const data = document.data() || {};
        const keys = Object.keys(data);
        if (imageKey(key) !== key || keys.length !== 4 ||
            !keys.every(name => [
              'data', 'revision', 'schemaVersion', 'buildToken'
            ].includes(name)) ||
            !allowedPublicImageData(data.data) ||
            typeof data.revision !== 'string' || !data.revision ||
            data.schemaVersion !== publicLibraryCore().PUBLIC_CHILD_SCHEMA_VERSION ||
            typeof data.buildToken !== 'string' || !data.buildToken) {
          throw new Error('공개 이미지 projection binding이 유효하지 않습니다.');
        }
        if (expectedRevision && data.revision !== expectedRevision) {
          throw new Error('공개 이미지 revision binding이 일치하지 않습니다.');
        }
        images[key] = data.data;
        documents[key] = data;
      }
      return { images, documents };
    }

    function sameImageValues(left, right) {
      const leftKeys = Object.keys(left || {}).sort();
      const rightKeys = Object.keys(right || {}).sort();
      return leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
    }

    function assertPublishedImageBinding(projection, stored, expectedImages) {
      const entries = Object.entries(stored.documents || {});
      if (projection.imageCount !== entries.length ||
          !sameImageValues(stored.images, expectedImages)) {
        throw new Error('공개 이미지 counter 또는 projection 내용이 일치하지 않습니다.');
      }
      const tokens = new Set(entries.map(([, image]) => image.buildToken));
      if (tokens.size > 1 || entries.some(([, image]) => image.revision !== projection.revision)) {
        throw new Error('공개 이미지 build binding이 일치하지 않습니다.');
      }
    }

    function publicationProjectionFingerprint(left, right) {
      return JSON.stringify(stableValue(left || null)) === JSON.stringify(stableValue(right || null));
    }

    function samePublicProjectionContent(left, right) {
      const keys = [
        'publicationId', 'sourceSetId', 'revision', 'title', 'description',
        'authorDisplayName', 'videos', 'settings', 'videoCount', 'questionCount', 'imageCount'
      ];
      return publicationProjectionFingerprint(
        Object.fromEntries(keys.map(key => [key, (left || {})[key]])),
        Object.fromEntries(keys.map(key => [key, (right || {})[key]]))
      );
    }

    function samePublicParentContent(left, right) {
      const keys = [
        'publicationId', 'sourceSetId', 'revision', 'title', 'description',
        'authorDisplayName', 'revealMode', 'limitSec', 'revealDelaySec', 'autoPause',
        'videoCount', 'questionCount', 'imageCount'
      ];
      return publicationProjectionFingerprint(
        Object.fromEntries(keys.map(key => [key, (left || {})[key]])),
        Object.fromEntries(keys.map(key => [key, (right || {})[key]]))
      );
    }

    function rebuiltSourceProjection(
      source, publicationId, revision, authorDisplayName
    ) {
      return publicLibraryCore().buildProjection(source, {
        setId: publicationId,
        authorDisplayName,
        ownerEmailCanonical: canonicalTeacherEmail(source && source.ownerEmail),
        ownerUid: source && source.ownerUid,
        revision,
        nowMs: publicServerNowMs()
      });
    }

    function requireMatchingPublicationSource(
      source, allowanceSnapshot, actor, initialProjection
    ) {
      const author = requirePublicAuthorAllowance(source, allowanceSnapshot, actor);
      if (requireContentRevision(source) !== initialProjection.revision) {
        throw new Error('원본 content revision이 게시 준비 중 변경되었습니다.');
      }
      const rebuilt = rebuiltSourceProjection(
        source,
        initialProjection.publicationId,
        initialProjection.revision,
        author.authorDisplayName
      );
      const matches = Array.isArray(initialProjection.videos)
        ? samePublicProjectionContent(rebuilt, initialProjection)
        : samePublicParentContent(
          publicLibraryCore().flattenProjection(rebuilt, 'source-integrity-check').parent,
          initialProjection
        );
      if (!matches) {
        throw new Error('같은 revision의 원본 content fingerprint가 변경되었습니다.');
      }
      return rebuilt;
    }

    function assertNoPublicationLifecycleLock(snapshot) {
      if (snapshot && snapshot.exists) {
        throw new Error('소유자 publication lifecycle 작업 중에는 게시할 수 없습니다.');
      }
    }

    async function publishQuizSet(setId, actor) {
      const publicationId = canonicalPublicationId(setId, 'setId');
      const currentActor = actor || {};
      const sourceRef = db.doc('quiz_sets/' + publicationId);
      const publicRef = db.doc('published_quiz_sets/' + publicationId);
      const sourceSnapshot = await sourceRef.get({ source: 'server' });
      const source = quizSetValue(sourceSnapshot);
      if (!source) throw new Error('게시할 원본 세트를 찾을 수 없습니다.');
      const ownerAllowanceRef = db.doc('teacher_allowances/' + String(source.ownerUid || ''));
      const ownerLockRef = db.doc(
        'publication_lifecycle_locks/' + String(source.ownerUid || '')
      );
      const [allowanceSnapshot, lockSnapshot, imageSnapshot, existingSnapshot] = await Promise.all([
        ownerAllowanceRef.get({ source: 'server' }),
        ownerLockRef.get({ source: 'server' }),
        db.collection('images/' + publicationId + '/q').get({ source: 'server' }),
        publicRef.get({ source: 'server' })
      ]);
      const author = requirePublicAuthorAllowance(source, allowanceSnapshot, currentActor);
      assertNoPublicationLifecycleLock(lockSnapshot);
      const revision = requireContentRevision(source);
      const privateImages = privatePublicationImages(imageSnapshot);
      if (Object.keys(privateImages).length !== source.imageCount) {
        throw new Error('원본 imageCount와 공개할 이미지 수가 일치하지 않습니다.');
      }
      const desiredBuilding = rebuiltSourceProjection(
        source, publicationId, revision, author.authorDisplayName
      );
      const existingRaw = existingSnapshot.exists ? existingSnapshot.data() || {} : null;
      const existingParent = existingRaw
        ? requireStoredProjection(existingRaw, publicationId) : null;
      if (existingParent && existingParent.status === 'moderated') {
        throw new Error('관리자 공개 중지 projection은 소유자가 덮어쓸 수 없습니다.');
      }
      if (existingParent && existingParent.status === 'building' &&
          (existingParent.revision !== revision || !existingRaw.buildToken)) {
        throw new Error('다른 revision의 building 게시 작업을 덮어쓸 수 없습니다.');
      }
      if (existingParent && existingParent.status === 'published' &&
          existingParent.revision === revision) {
        const [assembled, imageDocuments] = await Promise.all([
          assembleStoredProjection(existingParent, publicationId),
          publicRevisionDocuments(publicationId, 'images', revision)
        ]);
        if (!samePublicProjectionContent(assembled, desiredBuilding)) {
          throw new Error('같은 revision의 원본 content와 공개 projection이 일치하지 않습니다.');
        }
        const images = storedPublicImages({ docs: Object.entries(imageDocuments).map(
          ([id, value]) => ({ id, data: () => value })
        ) }, revision);
        assertPublishedImageBinding(existingParent, images, privateImages);
        return assembled;
      }

      const buildToken = existingParent && existingParent.status === 'building'
        ? existingRaw.buildToken : createLiveToken();
      const flat = publicLibraryCore().flattenProjection(desiredBuilding, buildToken);
      if (existingParent && existingParent.status === 'building' &&
          !samePublicParentContent(existingParent, flat.parent)) {
        throw new Error('같은 revision의 building content가 변경되었습니다.');
      }
      const buildingDocument = {
        ...flat.parent,
        publishedAt: existingParent && existingParent.publishedAt !== null
          ? existingParent.publishedAt : null,
        updatedAt: fieldValue.serverTimestamp(),
        buildToken,
        buildVideoCount: 0,
        buildQuestionCount: 0,
        buildImageCount: 0
      };
      assertRequestAllowed(operationsEstimate([
        { path: 'published_quiz_sets/' + publicationId, value: buildingDocument },
        ...Object.entries(flat.videos).map(([key, value]) => ({
          path: 'published_quiz_sets/' + publicationId + '/videos/' + key, value
        })),
        ...Object.entries(flat.questions).map(([key, value]) => ({
          path: 'published_quiz_sets/' + publicationId + '/questions/' + key, value
        })),
        ...Object.entries(privateImages).map(([key, data]) => ({
          path: 'published_quiz_sets/' + publicationId + '/images/' + key,
          value: {
            data, revision,
            schemaVersion: publicLibraryCore().PUBLIC_CHILD_SCHEMA_VERSION,
            buildToken
          }
        }))
      ]));

      const initialized = await db.runTransaction(async transaction => {
        const latestSourceSnapshot = await transaction.get(sourceRef);
        const latestAllowanceSnapshot = await transaction.get(ownerAllowanceRef);
        const latestLockSnapshot = await transaction.get(ownerLockRef);
        const latestPublicSnapshot = await transaction.get(publicRef);
        const latestSource = quizSetValue(latestSourceSnapshot);
        requireMatchingPublicationSource(
          latestSource, latestAllowanceSnapshot, currentActor, desiredBuilding
        );
        assertNoPublicationLifecycleLock(latestLockSnapshot);
        const latestRaw = latestPublicSnapshot.exists ? latestPublicSnapshot.data() || {} : null;
        if (!publicationProjectionFingerprint(existingRaw, latestRaw)) {
          throw new Error('공개 projection이 게시 준비 중 변경되었습니다.');
        }
        if (latestRaw) {
          const latestParent = requireStoredProjection(latestRaw, publicationId);
          if (latestParent.status === 'published' && latestParent.revision === revision) {
            return { alreadyPublished: true, parent: latestParent };
          }
          if (latestParent.status === 'building') {
            if (latestParent.revision !== revision || latestRaw.buildToken !== buildToken ||
                !samePublicParentContent(latestParent, flat.parent)) {
              throw new Error('building 게시 작업 token 또는 content가 변경되었습니다.');
            }
            return { alreadyBuilding: true };
          }
          if (latestParent.status === 'moderated') {
            throw new Error('관리자 공개 중지 projection은 게시할 수 없습니다.');
          }
        }
        transaction.set(publicRef, buildingDocument);
        return { building: true };
      });
      if (initialized.alreadyPublished) {
        return assembleStoredProjection(initialized.parent, publicationId);
      }

      const authoritativeBuildingSnapshot = await publicRef.get({ source: 'server' });
      if (!authoritativeBuildingSnapshot.exists) {
        throw new Error('서버 building 공개 projection 재읽기에 실패했습니다.');
      }
      const authoritativeBuildingRaw = authoritativeBuildingSnapshot.data() || {};
      const authoritativeBuilding = requireStoredProjection(
        authoritativeBuildingRaw, publicationId, 'building'
      );
      if (authoritativeBuildingRaw.buildToken !== buildToken ||
          !samePublicParentContent(authoritativeBuilding, flat.parent)) {
        throw new Error('서버 building 공개 projection binding이 일치하지 않습니다.');
      }
      if (existingParent &&
          publicTimestampMillis(authoritativeBuilding.updatedAt, 'building updatedAt') <
            publicTimestampMillis(existingParent.updatedAt, '이전 updatedAt')) {
        throw new Error('서버 building 공개 projection updatedAt이 이전 시각보다 퇴행했습니다.');
      }

      async function bindPublicChild(collectionName, key, value, countField, expectedCount) {
        const childRef = db.doc(
          'published_quiz_sets/' + publicationId + '/' + collectionName + '/' + key
        );
        await db.runTransaction(async transaction => {
          const latestSourceSnapshot = await transaction.get(sourceRef);
          const latestAllowanceSnapshot = await transaction.get(ownerAllowanceRef);
          const latestLockSnapshot = await transaction.get(ownerLockRef);
          const parentSnapshot = await transaction.get(publicRef);
          const childSnapshot = await transaction.get(childRef);
          const latestSource = quizSetValue(latestSourceSnapshot);
          requireMatchingPublicationSource(
            latestSource, latestAllowanceSnapshot, currentActor, desiredBuilding
          );
          assertNoPublicationLifecycleLock(latestLockSnapshot);
          if (!parentSnapshot.exists) throw new Error('building 공개 projection이 사라졌습니다.');
          const parentRaw = parentSnapshot.data() || {};
          const parent = requireStoredProjection(parentRaw, publicationId, 'building');
          if (parent.revision !== revision || parentRaw.buildToken !== buildToken ||
              !samePublicParentContent(parent, flat.parent)) {
            throw new Error('building 공개 projection token 또는 revision이 변경되었습니다.');
          }
          if (childSnapshot.exists &&
              publicationProjectionFingerprint(childSnapshot.data() || {}, value)) return;
          if (childSnapshot.exists &&
              (childSnapshot.data() || {}).buildToken === buildToken) {
            throw new Error('같은 build token의 공개 child 충돌을 거부했습니다.');
          }
          const currentCount = parentRaw[countField];
          if (!Number.isSafeInteger(currentCount) || currentCount < 0 ||
              currentCount >= expectedCount) {
            throw new Error('building 공개 child counter overflow를 거부했습니다.');
          }
          transaction.set(childRef, value);
          transaction.set(publicRef, {
            [countField]: currentCount + 1,
            buildMutation: { collection: collectionName, key, action: 'bind' }
          }, { merge: true });
        });
      }

      for (const [key, value] of Object.entries(flat.videos)) {
        await bindPublicChild('videos', key, value, 'buildVideoCount', flat.parent.videoCount);
      }
      for (const [key, value] of Object.entries(flat.questions)) {
        await bindPublicChild(
          'questions', key, value, 'buildQuestionCount', flat.parent.questionCount
        );
      }
      for (const [key, data] of Object.entries(privateImages)) {
        await bindPublicChild(
          'images', key, {
            data, revision,
            schemaVersion: publicLibraryCore().PUBLIC_CHILD_SCHEMA_VERSION,
            buildToken
          },
          'buildImageCount', flat.parent.imageCount
        );
      }

      const finalized = await db.runTransaction(async transaction => {
        const latestSourceSnapshot = await transaction.get(sourceRef);
        const latestAllowanceSnapshot = await transaction.get(ownerAllowanceRef);
        const latestLockSnapshot = await transaction.get(ownerLockRef);
        const latestPublicSnapshot = await transaction.get(publicRef);
        const latestSource = quizSetValue(latestSourceSnapshot);
        requireMatchingPublicationSource(
          latestSource, latestAllowanceSnapshot, currentActor, desiredBuilding
        );
        assertNoPublicationLifecycleLock(latestLockSnapshot);
        if (!latestPublicSnapshot.exists) throw new Error('building 공개 projection이 없습니다.');
        const parentRaw = latestPublicSnapshot.data() || {};
        const parent = requireStoredProjection(parentRaw, publicationId, 'building');
        if (parent.revision !== revision || parentRaw.buildToken !== buildToken ||
            parentRaw.buildVideoCount !== flat.parent.videoCount ||
            parentRaw.buildQuestionCount !== flat.parent.questionCount ||
            parentRaw.buildImageCount !== flat.parent.imageCount ||
            !samePublicParentContent(parent, flat.parent)) {
          throw new Error('공개 content build counter가 완료되지 않았습니다.');
        }
        const firstPublishedAt = parent.publishedAt;
        const validationParent = {
          ...flat.parent,
          status: 'published',
          moderationStatus: 'clear',
          publishedAt: firstPublishedAt || parent.updatedAt,
          updatedAt: parent.updatedAt
        };
        const validation = publicLibraryCore().validateParent(validationParent);
        if (!validation.ok) throw new Error('최종 공개 projection이 유효하지 않습니다.');
        transaction.set(publicRef, {
          ...validationParent,
          publishedAt: firstPublishedAt || fieldValue.serverTimestamp(),
          updatedAt: fieldValue.serverTimestamp()
        });
        return { previousUpdatedAt: parent.updatedAt };
      });
      const parent = await authoritativePublicProjection(
        publicRef, publicationId, 'published', finalized.previousUpdatedAt
      );
      return assembleStoredProjection(parent, publicationId);
    }

    async function withdrawPublishedQuizSet(setId, actor) {
      const publicationId = canonicalPublicationId(setId, 'setId');
      const sourceRef = db.doc('quiz_sets/' + publicationId);
      const publicRef = db.doc('published_quiz_sets/' + publicationId);
      const transition = await db.runTransaction(async transaction => {
        const sourceSnapshot = await transaction.get(sourceRef);
        const source = quizSetValue(sourceSnapshot);
        if (!source) throw new Error('철회할 원본 세트를 찾을 수 없습니다.');
        const allowanceRef = db.doc('teacher_allowances/' + String(source.ownerUid || ''));
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const publicSnapshot = await transaction.get(publicRef);
        requireActiveSourceOwnerIdentity(source, allowanceSnapshot, actor || {});
        if (!publicSnapshot.exists) throw new Error('철회할 공개 projection이 없습니다.');
        const projection = requireStoredProjection(
          publicSnapshot.data() || {}, publicationId, 'published'
        );
        if (requireContentRevision(source) !== projection.revision) {
          throw new Error('원본과 공개 projection revision이 일치하지 않습니다.');
        }
        const validationProjection = {
          ...projection,
          status: 'withdrawn', moderationStatus: 'clear',
          updatedAt: projection.updatedAt
        };
        if (!publicLibraryCore().validateParent(validationProjection).ok) {
          throw new Error('철회 projection이 유효하지 않습니다.');
        }
        const next = {
          ...validationProjection,
          updatedAt: fieldValue.serverTimestamp()
        };
        transaction.set(publicRef, next);
        return { previousUpdatedAt: projection.updatedAt };
      });
      return authoritativePublicProjection(
        publicRef, publicationId, 'withdrawn', transition.previousUpdatedAt
      );
    }

    function exactPublicationRevision(value) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
        throw new Error('정확한 publication revision이 필요합니다.');
      }
      return value.trim();
    }

    async function adminModeratePublishedQuiz(setId, expectedRevision, reason, admin) {
      const publicationId = canonicalPublicationId(setId, 'setId');
      const expected = exactPublicationRevision(expectedRevision);
      const moderationReason = typeof reason === 'string' ? reason.trim() : '';
      if (moderationReason.length < 1 || moderationReason.length > 200) {
        throw new Error('관리자 공개 중지 사유는 1~200자여야 합니다.');
      }
      const publicRef = db.doc('published_quiz_sets/' + publicationId);
      const auditRef = db.doc('published_quiz_audits/' + publicationId);
      const transition = await db.runTransaction(async transaction => {
        const currentAdmin = await requireAuthoritativePublicationAdmin(transaction, admin);
        const snapshot = await transaction.get(publicRef);
        if (!snapshot.exists) throw new Error('중지할 공개 projection이 없습니다.');
        const projection = requireStoredProjection(snapshot.data() || {}, publicationId, 'published');
        if (projection.revision !== expected) {
          throw new Error('공개 projection revision이 변경되었습니다.');
        }
        const nextProjection = {
          ...projection,
          status: 'moderated', moderationStatus: 'moderated',
          updatedAt: projection.updatedAt
        };
        if (!publicLibraryCore().validateParent(nextProjection).ok) {
          throw new Error('관리자 공개 중지 projection이 유효하지 않습니다.');
        }
        const nextAudit = {
          publicationId,
          revision: projection.revision,
          status: 'moderated',
          moderatedByUid: currentAdmin.uid,
          moderationReason,
          moderatedAt: fieldValue.serverTimestamp()
        };
        transaction.set(publicRef, {
          ...nextProjection,
          updatedAt: fieldValue.serverTimestamp()
        });
        transaction.set(auditRef, nextAudit);
        return { previousUpdatedAt: projection.updatedAt };
      });
      const projection = await authoritativePublicProjection(
        publicRef, publicationId, 'moderated', transition.previousUpdatedAt
      );
      const auditSnapshot = await auditRef.get({ source: 'server' });
      if (!auditSnapshot.exists) throw new Error('관리자 공개 중지 audit 재읽기에 실패했습니다.');
      requireModerationAudit(
        auditSnapshot.data() || {}, publicationId, expected, 'moderated'
      );
      return projection;
    }

    async function adminRestorePublishedQuiz(setId, expectedRevision, admin) {
      const publicationId = canonicalPublicationId(setId, 'setId');
      const expected = exactPublicationRevision(expectedRevision);
      const sourceRef = db.doc('quiz_sets/' + publicationId);
      const publicRef = db.doc('published_quiz_sets/' + publicationId);
      const auditRef = db.doc('published_quiz_audits/' + publicationId);
      const transition = await db.runTransaction(async transaction => {
        const currentAdmin = await requireAuthoritativePublicationAdmin(transaction, admin);
        const sourceSnapshot = await transaction.get(sourceRef);
        const source = quizSetValue(sourceSnapshot);
        if (!source) throw new Error('복구할 공개 projection의 원본이 없습니다.');
        const ownerAllowanceRef = db.doc(
          'teacher_allowances/' + String(source.ownerUid || '')
        );
        const ownerAllowanceSnapshot = await transaction.get(ownerAllowanceRef);
        const publicSnapshot = await transaction.get(publicRef);
        const auditSnapshot = await transaction.get(auditRef);
        if (!publicSnapshot.exists) throw new Error('복구할 공개 projection이 없습니다.');
        const projection = requireStoredProjection(
          publicSnapshot.data() || {}, publicationId, 'moderated'
        );
        if (projection.revision !== expected) {
          throw new Error('원본 또는 공개 projection revision이 변경되었습니다.');
        }
        requireMatchingPublicationSource(
          source, ownerAllowanceSnapshot, null, projection
        );
        if (!auditSnapshot.exists) {
          throw new Error('복구할 관리자 moderation audit 문서가 없습니다.');
        }
        const audit = requireModerationAudit(
          auditSnapshot.data() || {}, publicationId, expected, 'moderated'
        );
        const nextProjection = {
          ...projection,
          status: 'published', moderationStatus: 'clear',
          updatedAt: projection.updatedAt
        };
        if (!publicLibraryCore().validateParent(nextProjection).ok) {
          throw new Error('복구할 공개 projection이 유효하지 않습니다.');
        }
        transaction.set(publicRef, {
          ...nextProjection,
          updatedAt: fieldValue.serverTimestamp()
        });
        transaction.set(auditRef, {
          publicationId,
          revision: expected,
          status: 'restored',
          moderatedByUid: audit.moderatedByUid,
          moderationReason: audit.moderationReason,
          moderatedAt: audit.moderatedAt,
          restoredByUid: currentAdmin.uid,
          restoredAt: fieldValue.serverTimestamp()
        });
        return { previousUpdatedAt: projection.updatedAt };
      });
      const projection = await authoritativePublicProjection(
        publicRef, publicationId, 'published', transition.previousUpdatedAt
      );
      const auditSnapshot = await auditRef.get({ source: 'server' });
      if (!auditSnapshot.exists) throw new Error('관리자 공개 복구 audit 재읽기에 실패했습니다.');
      requireModerationAudit(
        auditSnapshot.data() || {}, publicationId, expected, 'restored'
      );
      return projection;
    }

    async function listPublishedQuizSets(options) {
      const config = options || {};
      const limit = config.limit == null ? 50 : Number(config.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('공개 자료실 limit은 1~50이어야 합니다.');
      }
      if (config.cursor != null &&
          (!config.cursor || typeof config.cursor.id !== 'string' ||
           typeof config.cursor.get !== 'function')) {
        throw new Error('공개 자료실 cursor가 유효하지 않습니다.');
      }
      let query = db.collection('published_quiz_sets')
        .where('status', '==', 'published')
        .orderBy('updatedAt', 'desc');
      if (config.cursor != null) query = query.startAfter(config.cursor);
      const snapshot = await query.limit(limit).get({ source: 'server' });
      const items = [];
      for (const document of snapshot.docs || []) {
        try {
          const projection = requireStoredProjection(
            document.data() || {}, document.id, 'published'
          );
          items.push(publicLibraryCore().publicSummary(projection));
        } catch (_) {
          // A malformed row must never become visible; the raw cursor still advances.
        }
      }
      const last = (snapshot.docs || []).at(-1);
      return {
        items,
        nextCursor: (snapshot.docs || []).length === limit ? last : null
      };
    }

    async function getOwnedPublicationStatus(publicationId) {
      const id = canonicalPublicationId(publicationId, 'publicationId');
      const snapshot = await db.doc('published_quiz_sets/' + id)
        .get({ source: 'server' });
      if (!snapshot.exists) {
        return { publicationId: id, status: 'private', revision: '' };
      }
      const projection = requireStoredProjection(snapshot.data() || {}, id);
      return {
        publicationId: id,
        status: projection.status,
        revision: projection.revision
      };
    }

    function adminPublicationSummary(projection) {
      return {
        publicationId: projection.publicationId,
        status: projection.status,
        moderationStatus: projection.moderationStatus,
        revision: projection.revision,
        title: projection.title,
        authorDisplayName: projection.authorDisplayName,
        videoCount: projection.videoCount,
        questionCount: projection.questionCount,
        updatedAtMs: publicTimestampMillis(projection.updatedAt, 'updatedAt')
      };
    }

    async function listAdminPublishedQuizSets(options) {
      const config = options || {};
      const limit = config.limit == null ? 50 : Number(config.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('관리자 공개 세트 limit은 1~50이어야 합니다.');
      }
      if (config.cursor != null &&
          (!config.cursor || typeof config.cursor.id !== 'string' ||
           typeof config.cursor.get !== 'function')) {
        throw new Error('관리자 공개 세트 cursor가 유효하지 않습니다.');
      }
      const currentAdmin = assertAdminIdentity(config.admin);
      const allowanceSnapshot = await db.doc(
        'teacher_allowances/' + currentAdmin.uid
      ).get({ source: 'server' });
      if (!allowanceSnapshot.exists ||
          !validAuthoritativeAdmin(allowanceSnapshot.data() || {}, currentAdmin)) {
        throw new Error('authoritative active 관리자 allowance가 유효하지 않습니다.');
      }
      let query = db.collection('published_quiz_sets')
        .where('status', 'in', ['published', 'moderated'])
        .orderBy('updatedAt', 'desc');
      if (config.cursor != null) query = query.startAfter(config.cursor);
      const snapshot = await query.limit(limit).get({ source: 'server' });
      const items = [];
      for (const document of snapshot.docs || []) {
        try {
          const projection = requireStoredProjection(
            document.data() || {}, document.id
          );
          if (['published', 'moderated'].includes(projection.status)) {
            items.push(adminPublicationSummary(projection));
          }
        } catch (_) {
          // Malformed rows stay hidden while the raw cursor still advances.
        }
      }
      const last = (snapshot.docs || []).at(-1);
      return {
        items,
        nextCursor: (snapshot.docs || []).length === limit ? last : null
      };
    }

    function requireLifecycleAllowance(snapshot, ownerUid, expectedRevision, starting) {
      if (!snapshot || !snapshot.exists) {
        throw new Error('lifecycle 대상 teacher allowance가 없습니다.');
      }
      const allowance = snapshot.data() || {};
      const email = canonicalTeacherEmail(allowance.emailCanonical);
      if (allowance.uid !== ownerUid || !email || email !== allowance.emailCanonical ||
          !['teacher', 'admin'].includes(allowance.role) ||
          allowanceRevision(allowance) !== expectedRevision) {
        throw new Error('lifecycle 대상 allowance identity 또는 revision이 변경되었습니다.');
      }
      if (starting && (allowance.emailCanonical !== starting.emailCanonical ||
          allowance.role !== starting.role || allowance.status !== starting.status ||
          allowance.enabled !== starting.enabled)) {
        throw new Error('lifecycle 대상 allowance 상태가 작업 중 변경되었습니다.');
      }
      return allowance;
    }

    function lifecycleLockValue(ownerUid, allowance, reason, operationId, actor) {
      return {
        ownerUid,
        ownerEmailCanonical: allowance.emailCanonical,
        allowanceRevision: allowanceRevision(allowance),
        allowanceRole: allowance.role,
        allowanceStatus: allowance.status,
        allowanceEnabled: allowance.enabled,
        reason,
        operationId,
        initiatedByUid: actor.uid,
        initiatedByRole: actor.role,
        createdAt: fieldValue.serverTimestamp()
      };
    }

    function requireLifecycleLock(snapshot, ownerUid, allowance, reason, actor, operationId) {
      if (!snapshot || !snapshot.exists) {
        throw new Error('publication lifecycle lock이 없습니다. 작업을 다시 시작해 주세요.');
      }
      const lock = snapshot.data() || {};
      const exact = lock.ownerUid === ownerUid &&
        lock.ownerEmailCanonical === allowance.emailCanonical &&
        lock.allowanceRevision === allowanceRevision(allowance) &&
        lock.allowanceRole === allowance.role &&
        lock.allowanceStatus === allowance.status &&
        lock.allowanceEnabled === allowance.enabled &&
        lock.reason === reason && lock.initiatedByUid === actor.uid &&
        lock.initiatedByRole === actor.role &&
        typeof lock.operationId === 'string' && lock.operationId.length > 0 &&
        (!operationId || lock.operationId === operationId);
      if (!exact) {
        throw new Error('publication lifecycle lock 신원 또는 allowance binding이 변경되었습니다.');
      }
      return lock;
    }

    async function acquirePublicationLifecycleLock(
      ownerUid, expectedAllowanceRevision, reason, actor
    ) {
      const uid = assertUid(ownerUid);
      const operationActor = assertLifecycleOperationCurrent(actor);
      const allowanceRef = db.doc('teacher_allowances/' + uid);
      const lockRef = db.doc('publication_lifecycle_locks/' + uid);
      const gateRef = db.doc('publication_lifecycle_gates/current');
      const proposedOperationId = createLiveToken();
      return db.runTransaction(async transaction => {
        if (operationActor.uid !== uid) {
          await requireTransactionAdmin(transaction, operationActor);
        }
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = requireLifecycleAllowance(
          allowanceSnapshot, uid, expectedAllowanceRevision
        );
        const actorEmail = canonicalTeacherEmail(operationActor.email);
        if (operationActor.uid === uid &&
            (actorEmail !== allowance.emailCanonical ||
             !['teacher', 'admin'].includes(operationActor.role))) {
          throw new Error('publication lifecycle lock 소유자 신원이 일치하지 않습니다.');
        }
        const lockSnapshot = await transaction.get(lockRef);
        const gateSnapshot = await transaction.get(gateRef);
        if (lockSnapshot.exists) {
          const lock = requireLifecycleLock(
            lockSnapshot, uid, allowance, reason, operationActor
          );
          requireLifecycleLock(
            gateSnapshot, uid, allowance, reason, operationActor, lock.operationId
          );
          return lock.operationId;
        }
        if (gateSnapshot.exists) {
          throw new Error('다른 publication lifecycle 작업이 진행 중입니다. 다시 시도해 주세요.');
        }
        const lockValue = lifecycleLockValue(
          uid, allowance, reason, proposedOperationId, operationActor
        );
        transaction.set(lockRef, lockValue);
        transaction.set(gateRef, lockValue);
        return proposedOperationId;
      });
    }

    async function releasePublicationLifecycleLock(
      ownerUid, expectedAllowanceRevision, reason, actor, operationId
    ) {
      const uid = assertUid(ownerUid);
      const operationActor = assertLifecycleOperationCurrent(actor);
      const allowanceRef = db.doc('teacher_allowances/' + uid);
      const lockRef = db.doc('publication_lifecycle_locks/' + uid);
      const gateRef = db.doc('publication_lifecycle_gates/current');
      return db.runTransaction(async transaction => {
        if (operationActor.uid !== uid) {
          await requireTransactionAdmin(transaction, operationActor);
        }
        const allowanceSnapshot = await transaction.get(allowanceRef);
        const allowance = requireLifecycleAllowance(
          allowanceSnapshot, uid, expectedAllowanceRevision
        );
        const lockSnapshot = await transaction.get(lockRef);
        const gateSnapshot = await transaction.get(gateRef);
        if (!lockSnapshot.exists) return false;
        requireLifecycleLock(
          lockSnapshot, uid, allowance, reason, operationActor, operationId
        );
        requireLifecycleLock(
          gateSnapshot, uid, allowance, reason, operationActor, operationId
        );
        transaction.delete(lockRef);
        transaction.delete(gateRef);
        return true;
      });
    }

    async function auditOwnedPublications(ownerUid, limit, cursor) {
      const uid = assertUid(ownerUid);
      const count = limit == null ? 50 : Number(limit);
      if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
        throw new Error('소유 publication 감사 limit은 1~50이어야 합니다.');
      }
      if (cursor != null && (!cursor || typeof cursor.id !== 'string' ||
          typeof cursor.get !== 'function')) {
        throw new Error('소유 publication 감사 cursor가 유효하지 않습니다.');
      }
      let query = db.collection('quiz_sets')
        .where('ownerUid', '==', uid);
      if (typeof query.orderBy === 'function') query = query.orderBy('ownerUid', 'asc');
      if (cursor != null) {
        if (typeof query.startAfter !== 'function') {
          throw new Error('소유 publication 감사 cursor paging을 지원하지 않습니다.');
        }
        query = query.startAfter(cursor);
      }
      const sourceSnapshot = await query.limit(count).get({ source: 'server' });
      const items = [];
      let visibleCount = 0;
      for (const sourceDocument of sourceSnapshot.docs || []) {
        const publicationId = canonicalPublicationId(sourceDocument.id, 'publicationId');
        const source = quizSetValue(sourceDocument);
        if (!source || source.ownerUid !== uid) {
          throw new Error('소유 publication 감사 source identity가 일치하지 않습니다.');
        }
        const publicSnapshot = await db.doc(
          'published_quiz_sets/' + publicationId
        ).get({ source: 'server' });
        if (!publicSnapshot.exists) continue;
        const projection = requireStoredProjection(
          publicSnapshot.data() || {}, publicationId
        );
        if (projection.status === 'published') {
          if (requireContentRevision(source) !== projection.revision) {
            throw new Error('보이는 publication과 source revision이 일치하지 않습니다.');
          }
          visibleCount += 1;
        }
        items.push({
          publicationId,
          status: projection.status,
          revision: projection.revision
        });
      }
      const last = (sourceSnapshot.docs || []).at(-1);
      return {
        items,
        nextCursor: (sourceSnapshot.docs || []).length === count ? last : null,
        visibleCount
      };
    }

    async function withdrawOwnedPublicationsForLifecycle(
      ownerUid, expectedAllowanceRevision, reason, actor
    ) {
      const uid = assertUid(ownerUid);
      const expectedRevision = Number(expectedAllowanceRevision);
      const lifecycleReason = typeof reason === 'string' ? reason.trim() : '';
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('정확한 lifecycle allowance revision이 필요합니다.');
      }
      if (!lifecycleReason || lifecycleReason.length > 200) {
        throw new Error('lifecycle 철회 사유는 1~200자여야 합니다.');
      }
      const operationActor = assertLifecycleOperationCurrent(actor);
      if (!operationActor.lifecycleOperationId) {
        const lifecycleOperationId = await acquirePublicationLifecycleLock(
          uid, expectedRevision, lifecycleReason, operationActor
        );
        const lockedActor = { ...operationActor, lifecycleOperationId };
        try {
          return await withdrawOwnedPublicationsForLifecycle(
            uid, expectedRevision, lifecycleReason, lockedActor
          );
        } finally {
          await releasePublicationLifecycleLock(
            uid, expectedRevision, lifecycleReason, operationActor, lifecycleOperationId
          );
        }
      }
      const allowanceRef = db.doc('teacher_allowances/' + uid);
      const lockRef = db.doc('publication_lifecycle_locks/' + uid);
      const gateRef = db.doc('publication_lifecycle_gates/current');
      const startingSnapshot = await allowanceRef.get({ source: 'server' });
      const starting = requireLifecycleAllowance(
        startingSnapshot, uid, expectedRevision
      );
      const actorEmail = canonicalTeacherEmail(operationActor.email);
      const ownerOperation = operationActor.uid === uid &&
        actorEmail === starting.emailCanonical;
      if (ownerOperation) {
        if (starting.status !== 'active' || starting.enabled !== true ||
            !['teacher', 'admin'].includes(operationActor.role)) {
          throw new Error('active publication 소유자만 lifecycle 철회를 요청할 수 있습니다.');
        }
      } else {
        await requireCurrentAdmin(operationActor);
      }

      const rereadBoundAllowance = async () => {
        assertLifecycleOperationCurrent(operationActor);
        const [snapshot, lockSnapshot, gateSnapshot] = await Promise.all([
          allowanceRef.get({ source: 'server' }),
          lockRef.get({ source: 'server' }),
          gateRef.get({ source: 'server' })
        ]);
        const allowance = requireLifecycleAllowance(
          snapshot, uid, expectedRevision, starting
        );
        requireLifecycleLock(
          lockSnapshot, uid, allowance, lifecycleReason,
          operationActor, operationActor.lifecycleOperationId
        );
        requireLifecycleLock(
          gateSnapshot, uid, allowance, lifecycleReason,
          operationActor, operationActor.lifecycleOperationId
        );
        return allowance;
      };

      let withdrawnCount = 0;
      let remainingVisibleCount = 0;
      for (let pass = 0; pass < 5; pass += 1) {
        let cursor = null;
        do {
          await rereadBoundAllowance();
          const page = await auditOwnedPublications(uid, 50, cursor);
          for (const item of page.items) {
            if (!['published', 'building'].includes(item.status)) continue;
            assertLifecycleOperationCurrent(operationActor);
            const sourceRef = db.doc('quiz_sets/' + item.publicationId);
            const publicRef = db.doc('published_quiz_sets/' + item.publicationId);
            const changed = await db.runTransaction(async transaction => {
              if (!ownerOperation) await requireTransactionAdmin(transaction, operationActor);
              const allowanceSnapshot = await transaction.get(allowanceRef);
              const lockSnapshot = await transaction.get(lockRef);
              const gateSnapshot = await transaction.get(gateRef);
              const sourceSnapshot = await transaction.get(sourceRef);
              const publicSnapshot = await transaction.get(publicRef);
              const boundAllowance = requireLifecycleAllowance(
                allowanceSnapshot, uid, expectedRevision, starting
              );
              requireLifecycleLock(
                lockSnapshot, uid, boundAllowance, lifecycleReason,
                operationActor, operationActor.lifecycleOperationId
              );
              requireLifecycleLock(
                gateSnapshot, uid, boundAllowance, lifecycleReason,
                operationActor, operationActor.lifecycleOperationId
              );
              assertLifecycleOperationCurrent(operationActor);
              const source = quizSetValue(sourceSnapshot);
              if (!source || source.ownerUid !== uid) {
                throw new Error('lifecycle 철회 source identity가 변경되었습니다.');
              }
              if (ownerOperation && (source.ownerUid !== operationActor.uid ||
                  canonicalTeacherEmail(source.ownerEmail) !== actorEmail)) {
                throw new Error('lifecycle 철회 source 소유권이 일치하지 않습니다.');
              }
              if (!publicSnapshot.exists) return false;
              const projection = requireStoredProjection(
                publicSnapshot.data() || {}, item.publicationId
              );
              if (!['published', 'building'].includes(projection.status)) return false;
              if (requireContentRevision(source) !== projection.revision) {
                throw new Error('lifecycle 철회 source/publication revision이 변경되었습니다.');
              }
              const withdrawal = lifecycleWithdrawalWrite(
                publicSnapshot, item.publicationId
              );
              transaction.set(publicRef, withdrawal);
              return true;
            });
            if (changed) withdrawnCount += 1;
          }
          cursor = page.nextCursor;
        } while (cursor);

        remainingVisibleCount = 0;
        cursor = null;
        do {
          await rereadBoundAllowance();
          const audit = await auditOwnedPublications(uid, 50, cursor);
          remainingVisibleCount += audit.visibleCount;
          cursor = audit.nextCursor;
        } while (cursor);
        if (remainingVisibleCount === 0) {
          await rereadBoundAllowance();
          return { withdrawnCount, remainingVisibleCount: 0 };
        }
      }
      throw new Error(
        '보이는 publication이 계속 생성되어 lifecycle 철회를 재개해야 합니다.'
      );
    }

    async function getPublishedQuizSet(publicationId) {
      const id = canonicalPublicationId(publicationId, 'publicationId');
      const snapshot = await db.doc('published_quiz_sets/' + id)
        .get({ source: 'server' });
      if (!snapshot.exists) return null;
      try {
        const parent = requireStoredProjection(snapshot.data() || {}, id, 'published');
        return await assembleStoredProjection(parent, id);
      } catch (_) {
        return null;
      }
    }

    function publicCopyParent(projection, newId, actor) {
      const patch = publicLibraryCore().copyPatch(projection);
      return {
        title: ((projection.title || '제목 없음') + ' (사본)').slice(0, 200),
        description: projection.description,
        videos: projection.videos,
        settings: projection.settings,
        ...patch,
        sourcePublicationRevision: projection.revision,
        ownerUid: actor.uid,
        ownerEmail: canonicalTeacherEmail(actor.email),
        lifecycleState: 'copying',
        copyStatus: 'building',
        collaboratorCount: 0,
        imageCount: 0,
        createdAt: fieldValue.serverTimestamp(),
        updatedAt: fieldValue.serverTimestamp(),
        contentRevision: fieldValue.serverTimestamp()
      };
    }

    function samePublicCopyDestination(destination, expected, actor, imageCount) {
      const value = destination || {};
      if (value.ownerUid !== actor.uid ||
          canonicalTeacherEmail(value.ownerEmail) !== canonicalTeacherEmail(actor.email) ||
          value.publicationId !== expected.publicationId ||
          value.sourcePublicationRevision !== expected.sourcePublicationRevision ||
          value.visibility !== 'private' || value.collaboratorCount !== 0 ||
          !Number.isSafeInteger(value.imageCount) || value.imageCount < 0 ||
          value.imageCount > imageCount || value.trashedAt || value.purgeStartedAt ||
          !['copying', 'active'].includes(value.lifecycleState)) return false;
      for (const key of [
        'title', 'description', 'videos', 'settings', 'sourceTitle',
        'sourceAuthorDisplayName'
      ]) {
        if (!publicationProjectionFingerprint(value[key], expected[key])) return false;
      }
      if (value.lifecycleState === 'copying') return value.copyStatus === 'building';
      return value.copyStatus === undefined && value.imageCount === imageCount;
    }

    function exactDestinationImages(snapshot, sourceImages) {
      const stored = {};
      for (const document of snapshot.docs || []) {
        const data = document.data() || {};
        if (imageKey(document.id) !== document.id ||
            Object.keys(data).length !== 1 || typeof data.data !== 'string') {
          return false;
        }
        stored[document.id] = data.data;
      }
      return sameImageValues(stored, sourceImages);
    }

    async function copyPublishedQuizSet(publicationId, newSetId, actor) {
      const id = canonicalPublicationId(publicationId, 'publicationId');
      const destinationId = canonicalPublicationId(newSetId, 'newSetId');
      if (id === destinationId) throw new Error('공개 원본과 사본 목적지 ID가 같을 수 없습니다.');
      const currentActor = actor || {};
      const actorAllowanceRef = db.doc(
        'teacher_allowances/' + String(currentActor.uid || '')
      );
      const publicRef = db.doc('published_quiz_sets/' + id);
      const destinationRef = db.doc('quiz_sets/' + destinationId);
      const [allowanceSnapshot, publicSnapshot] = await Promise.all([
        actorAllowanceRef.get({ source: 'server' }),
        publicRef.get({ source: 'server' })
      ]);
      requireActiveActorAllowance(allowanceSnapshot, currentActor);
      if (!publicSnapshot.exists) throw new Error('복사할 published 공개 projection이 없습니다.');
      const projectionParent = requireStoredProjection(
        publicSnapshot.data() || {}, id, 'published'
      );
      const [projection, imageDocuments] = await Promise.all([
        assembleStoredProjection(projectionParent, id),
        publicRevisionDocuments(id, 'images', projectionParent.revision)
      ]);
      const publicImages = storedPublicImages({ docs: Object.entries(imageDocuments).map(
        ([documentId, value]) => ({ id: documentId, data: () => value })
      ) }, projection.revision);
      assertPublishedImageBinding(projectionParent, publicImages, publicImages.images);
      const expectedParent = publicCopyParent(projection, destinationId, currentActor);
      assertRequestAllowed(requestEstimate(expectedParent, publicImages.images, {
        setPath: 'quiz_sets/' + destinationId,
        imagePath: 'images/' + destinationId + '/q'
      }));

      const initialized = await db.runTransaction(async transaction => {
        const latestPublicSnapshot = await transaction.get(publicRef);
        const latestAllowanceSnapshot = await transaction.get(actorAllowanceRef);
        const destinationSnapshot = await transaction.get(destinationRef);
        requireActiveActorAllowance(latestAllowanceSnapshot, currentActor);
        if (!latestPublicSnapshot.exists) {
          throw new Error('복사 중 공개 projection이 철회되었습니다.');
        }
        const latestParent = requireStoredProjection(
          latestPublicSnapshot.data() || {}, id, 'published'
        );
        if (latestParent.revision !== projectionParent.revision ||
            !publicationProjectionFingerprint(latestParent, projectionParent)) {
          throw new Error('복사 중 published 공개 projection이 변경되었습니다.');
        }
        if (destinationSnapshot.exists) {
          const destination = destinationSnapshot.data() || {};
          if (!samePublicCopyDestination(
            destination, expectedParent, currentActor, projection.imageCount
          )) {
            throw new Error('사본 destination ID가 이미 존재하거나 충돌했습니다.');
          }
          return {
            complete: destination.lifecycleState === 'active', destination
          };
        }
        transaction.set(destinationRef, expectedParent);
        return { complete: false, destination: expectedParent };
      });

      if (initialized.complete) {
        const destinationImages = await db.collection(
          'images/' + destinationId + '/q'
        ).get({ source: 'server' });
        if (!exactDestinationImages(destinationImages, publicImages.images)) {
          throw new Error('완료된 사본 destination 이미지가 provenance와 일치하지 않습니다.');
        }
        return { ...initialized.destination, id: destinationId };
      }

      for (const [key, data] of Object.entries(publicImages.images)) {
        const destinationImageRef = db.doc(
          'images/' + destinationId + '/q/' + key
        );
        await db.runTransaction(async transaction => {
          const latestPublicSnapshot = await transaction.get(publicRef);
          const latestAllowanceSnapshot = await transaction.get(actorAllowanceRef);
          const destinationSnapshot = await transaction.get(destinationRef);
          const destinationImageSnapshot = await transaction.get(destinationImageRef);
          requireActiveActorAllowance(latestAllowanceSnapshot, currentActor);
          if (!latestPublicSnapshot.exists) {
            throw new Error('복사 중 공개 projection이 철회되었습니다.');
          }
          const latestParent = requireStoredProjection(
            latestPublicSnapshot.data() || {}, id, 'published'
          );
          if (latestParent.revision !== projectionParent.revision ||
              !publicationProjectionFingerprint(latestParent, projectionParent)) {
            throw new Error('복사 중 published 공개 projection이 변경되었습니다.');
          }
          if (!destinationSnapshot.exists) throw new Error('사본 destination 부모가 없습니다.');
          const destination = destinationSnapshot.data() || {};
          if (!samePublicCopyDestination(
            destination, expectedParent, currentActor, projection.imageCount
          ) || destination.lifecycleState !== 'copying') {
            throw new Error('사본 destination 상태 또는 provenance가 변경되었습니다.');
          }
          if (destinationImageSnapshot.exists) {
            const stored = destinationImageSnapshot.data() || {};
            if (Object.keys(stored).length !== 1 || stored.data !== data) {
              throw new Error('사본 destination 이미지 충돌을 거부했습니다.');
            }
            return;
          }
          const nextCount = destination.imageCount + 1;
          if (nextCount > projection.imageCount) {
            throw new Error('사본 destination image counter overflow를 거부했습니다.');
          }
          transaction.set(destinationImageRef, { data });
          transaction.set(destinationRef, {
            imageCount: nextCount,
            imageMutation: { key, action: 'add' },
            updatedAt: fieldValue.serverTimestamp(),
            contentRevision: fieldValue.serverTimestamp()
          }, { merge: true });
        });
      }

      const finalized = await db.runTransaction(async transaction => {
        const latestPublicSnapshot = await transaction.get(publicRef);
        const latestAllowanceSnapshot = await transaction.get(actorAllowanceRef);
        const destinationSnapshot = await transaction.get(destinationRef);
        requireActiveActorAllowance(latestAllowanceSnapshot, currentActor);
        if (!latestPublicSnapshot.exists) {
          throw new Error('최종 복사 전 공개 projection이 철회되었습니다.');
        }
        const latestParent = requireStoredProjection(
          latestPublicSnapshot.data() || {}, id, 'published'
        );
        if (latestParent.revision !== projectionParent.revision ||
            !publicationProjectionFingerprint(latestParent, projectionParent)) {
          throw new Error('최종 복사 전 published 공개 projection이 변경되었습니다.');
        }
        if (!destinationSnapshot.exists) throw new Error('사본 destination 부모가 없습니다.');
        const destination = destinationSnapshot.data() || {};
        if (!samePublicCopyDestination(
          destination, expectedParent, currentActor, projection.imageCount
        ) || destination.lifecycleState !== 'copying' ||
            destination.imageCount !== projection.imageCount) {
          throw new Error('사본 destination image counter가 완료되지 않았습니다.');
        }
        const deletion = deleteFieldValue();
        transaction.set(destinationRef, {
          lifecycleState: 'active',
          copyStatus: deletion,
          imageMutation: deletion,
          updatedAt: fieldValue.serverTimestamp(),
          contentRevision: fieldValue.serverTimestamp()
        }, { merge: true });
        return {
          ...destination,
          lifecycleState: 'active',
          copyStatus: undefined,
          imageMutation: undefined,
          id: destinationId
        };
      });
      delete finalized.copyStatus;
      delete finalized.imageMutation;
      return finalized;
    }

    function claimSessionCode(code, sessionId, session) {
      const setSnapshot = session && session.setSnapshot;
      const snapshotImages = normalizedImages(session && session.snapshotImages);
      const storedSession = { ...(session || {}) };
      const allocationToken = typeof storedSession.allocationToken === 'string'
        ? storedSession.allocationToken : '';
      delete storedSession.setSnapshot;
      delete storedSession.snapshotImages;
      delete storedSession.allocationToken;
      storedSession.status = 'allocating';
      storedSession.registeredStudentCount = 0;
      storedSession.studentCountRevision = 0;
      delete storedSession.lastStudentUid;
      if (setSnapshot) storedSession.snapshotVersion = 1;
      const snapshotOperations = [
        {
          path: 'codes/' + code,
          value: { sessionId, createdAt: fieldValue.serverTimestamp() }
        },
        { path: 'sessions/' + sessionId, value: storedSession },
        {
          path: 'sessions/' + sessionId + '/meta/live',
          value: { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
        },
        { path: 'sessions/' + sessionId + '/meta/board', value: { scores: {} } }
      ];
      if (allocationToken) snapshotOperations.push({
        path: 'sessions/' + sessionId + '/meta/allocation',
        value: { token: allocationToken, ownerUid: storedSession.teacherUid || '' }
      });
      if (setSnapshot) snapshotOperations.push({
        path: 'sessions/' + sessionId + '/snapshot/set',
        value: withoutDocumentId(setSnapshot)
      });
      Object.entries(snapshotImages).forEach(([questionIndex, data]) => {
        snapshotOperations.push({
          path: 'sessions/' + sessionId + '/snapshot_images/' + questionIndex,
          value: { data }
        });
      });
      const snapshotRequest = operationsEstimate(snapshotOperations);
      try {
        assertRequestAllowed(snapshotRequest);
      } catch (error) {
        return Promise.reject(error);
      }
      const guestSession = storedSession.sessionActorType === 'guest';
      const sourceReference = !guestSession && storedSession.setId && db.doc('quiz_sets/' + storedSession.setId);
      const sourceCheck = !guestSession && storedSession.setId && sourceReference &&
        typeof sourceReference.get === 'function'
        ? getQuizSet(storedSession.setId).then(source => {
          if (!source) throw new Error('수업을 시작할 원본 세트를 찾을 수 없습니다.');
          if (!activeSet(source)) throw new Error('휴지통 또는 정리 중인 세트는 수업을 시작할 수 없습니다.');
          return true;
        })
        : Promise.resolve(true);
      return sourceCheck.then(() => db.runTransaction(async transaction => {
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
        if (allocationToken) {
          transaction.set(db.doc('sessions/' + sessionId + '/meta/allocation'), {
            token: allocationToken,
            ownerUid: storedSession.teacherUid || ''
          });
        }
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
      }));
    }

    function startSession(sessionId, session, createCode) {
      const candidates = Array.from({ length: 10 }, () => createCode());
      return claimFirstAvailableCode(
        candidates,
        code => claimSessionCode(code, sessionId, { ...session, code })
      );
    }

    async function loadGuestQuizRevision(shareIdValue, revisionValue, sourceContext) {
      const shareId = guestShareId(shareIdValue);
      if (!Number.isSafeInteger(revisionValue) || revisionValue < 1) {
        throw new Error('비로그인 공유 revision이 유효하지 않습니다.');
      }
      const context = sourceContext || {};
      const sourceSetId = canonicalPublicationId(context.sourceSetId, 'sourceSetId');
      const sourceOwnerUid = canonicalPublicationId(context.sourceOwnerUid, 'sourceOwnerUid');
      const base = 'guest_quiz_shares/' + shareId + '/revisions/' + revisionValue;
      const [parentSnapshot, videosSnapshot, questionsSnapshot, imagesSnapshot] = await Promise.all([
        db.doc(base).get({ source: 'server' }),
        db.collection(base + '/videos').get({ source: 'server' }),
        db.collection(base + '/questions').get({ source: 'server' }),
        db.collection(base + '/images').get({ source: 'server' })
      ]);
      if (!parentSnapshot.exists) throw new Error('공유받은 퀴즈 revision을 찾을 수 없습니다.');
      const parent = parentSnapshot.data() || {};
      if (parent.shareId !== shareId || parent.revision !== revisionValue ||
          parent.status !== 'ready' || parent.schemaVersion !== 1) {
        throw new Error('공유받은 퀴즈 revision이 유효하지 않습니다.');
      }
      const videos = (videosSnapshot.docs || []).map(document => ({ ...document.data() }))
        .sort((left, right) => left.videoKey.localeCompare(right.videoKey));
      const questions = (questionsSnapshot.docs || []).map(document => ({ ...document.data() }))
        .sort((left, right) => left.questionKey.localeCompare(right.questionKey));
      const imageValues = {};
      for (const document of imagesSnapshot.docs || []) {
        const image = document.data() || {};
        if (image.shareId !== shareId || image.revision !== revisionValue || image.schemaVersion !== 1 ||
            typeof image.data !== 'string') throw new Error('공유받은 퀴즈 이미지가 유효하지 않습니다.');
        imageValues[document.id] = image.data;
      }
      if (videos.length !== parent.videoCount || questions.length !== parent.questionCount ||
          Object.keys(imageValues).length !== parent.imageCount) {
        throw new Error('공유받은 퀴즈 projection 개수가 일치하지 않습니다.');
      }
      const playlist = videos.map(video => ({
        id: video.videoId,
        videoId: video.videoId,
        url: video.videoUrl,
        startSec: video.startSec,
        endSec: video.endSec,
        questions: questions.filter(question => question.videoKey === video.videoKey).map(question => {
          const value = { ...question };
          value.key = question.questionKey;
          delete value.shareId;
          delete value.revision;
          delete value.schemaVersion;
          delete value.questionKey;
          delete value.videoKey;
          if (question.imageKey) value.imgUp = true;
          if (question.explainImageKey) value.explainImgUp = true;
          return value;
        })
      }));
      const setSnapshot = {
        id: sourceSetId,
        title: parent.title,
        description: parent.description || '',
        author: '',
        settings: {
          revealMode: parent.revealMode,
          limitSec: parent.limitSec,
          revealDelaySec: parent.revealDelaySec,
          autoPause: parent.autoPause
        },
        videos: playlist
      };
      return {
        setSnapshot,
        snapshotImages: imageValues,
        shareId,
        revision: revisionValue,
        sourceSetId,
        sourceOwnerUid
      };
    }

    async function loadActiveGuestQuizShare(shareIdValue) {
      const shareId = guestShareId(shareIdValue);
      if (!/^[A-Za-z0-9_-]{43}$/.test(shareId)) {
        throw new Error('사용할 수 없는 진행 링크입니다.');
      }
      const snapshot = await db.doc('guest_quiz_shares/' + shareId).get({ source: 'server' });
      if (!snapshot.exists) throw new Error('사용할 수 없는 진행 링크입니다.');
      const share = snapshot.data() || {};
      if (share.shareId !== shareId || share.status !== 'active' ||
          !Number.isSafeInteger(share.revision) || share.revision < 1 ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(share.sourceSetId || '') ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(share.sourceOwnerUid || '')) {
        throw new Error('사용할 수 없는 진행 링크입니다.');
      }
      return loadGuestQuizRevision(shareId, share.revision, {
        sourceSetId: share.sourceSetId,
        sourceOwnerUid: share.sourceOwnerUid
      });
    }

    function prepareGuestSession(loaded, labelValue, guest, allocationToken) {
      const value = loaded || {};
      const current = guest || {};
      const label = typeof labelValue === 'string' ? labelValue.trim() : '';
      if (!current.uid || !/^[A-Za-z0-9_-]{1,128}$/.test(current.uid) || label.length > 80 ||
          !value.setSnapshot || !Array.isArray(value.setSnapshot.videos) ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.shareId || '') ||
          !Number.isSafeInteger(value.revision) || value.revision < 1 ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceSetId || '') ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceOwnerUid || '') ||
          typeof allocationToken !== 'string' || allocationToken.length < 16 || allocationToken.length > 128) {
        throw new Error('비로그인 세션 준비 정보가 유효하지 않습니다.');
      }
      return {
        setId: value.sourceSetId,
        setTitle: value.setSnapshot.title,
        label,
        teacher: '',
        teacherUid: current.uid,
        teacherEmail: '',
        sessionActorType: 'guest',
        sourceShareId: value.shareId,
        sourceSetId: value.sourceSetId,
        sourceRevision: value.revision,
        sourceOwnerUid: value.sourceOwnerUid,
        createdAt: fieldValue.serverTimestamp(),
        status: 'live',
        setSnapshot: value.setSnapshot,
        snapshotImages: value.snapshotImages || {},
        allocationToken
      };
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
      const sessionReference = db.doc('sessions/' + sessionId);
      const studentReference = db.doc('sessions/' + sessionId + '/students/' + authUid);
      return db.runTransaction(async transaction => {
        const sessionSnapshot = await transaction.get(sessionReference);
        const studentSnapshot = await transaction.get(studentReference);
        if (!sessionSnapshot.exists) throw new Error('학생이 참여할 session이 없습니다.');
        const session = sessionSnapshot.data() || {};
        const current = studentSnapshot.exists ? studentSnapshot.data() || {} : null;
        const count = session.registeredStudentCount;
        const revision = session.studentCountRevision;
        if (!Number.isSafeInteger(count) || count < 0 || revision !== count) {
          throw new Error('session student counter migration이 필요합니다.');
        }
        if (!['active', 'live'].includes(session.status)) {
          throw new Error('종료된 session에는 학생이 참여할 수 없습니다.');
        }
        let publicPlanReference = null;
        if (session.classPlanId !== undefined || session.classPlanRevision !== undefined) {
          const planId = assertPlanId(session.classPlanId);
          if (!Number.isSafeInteger(session.classPlanRevision) || session.classPlanRevision < 1) {
            throw new Error('session class plan revision이 유효하지 않습니다.');
          }
          publicPlanReference = db.doc('class_plans_public/' + planId);
        }
        const student = {
          ...(profile || {}),
          uid: authUid,
          joinedAt: current && current.joinedAt || fieldValue.serverTimestamp()
        };
        transaction.set(studentReference, student);
        if (!current) {
          transaction.update(sessionReference, {
            registeredStudentCount: count + 1,
            studentCountRevision: revision + 1,
            lastStudentUid: authUid
          });
          if (publicPlanReference) {
            transaction.update(publicPlanReference, { actualParticipants: count + 1 });
          }
        }
        return student;
      });
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

    async function listOwnedDerivedSessions(setId, actor) {
      const id = canonicalPublicationId(setId, 'setId');
      const current = actor || {};
      const source = await db.doc('quiz_sets/' + id).get().then(snapshotValue);
      requireGuestShareOwner(source, current);
      const snapshot = await db.collection('sessions')
        .where('sourceOwnerUid', '==', current.uid)
        .where('sourceSetId', '==', id)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
      return snapshot.docs.map(sessionValue).filter(value =>
        value.sessionActorType === 'guest' && value.sourceOwnerUid === current.uid && value.sourceSetId === id
      );
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
        { accepting: false, revealed: true, publicAnswer: answer },
        { merge: true }
      );
    }

    function activateSessionAllocation(sessionId, code, teacherUid, allocationToken) {
      const sessionReference = db.doc('sessions/' + sessionId);
      const codeReference = db.doc('codes/' + code);
      const allocationReference = db.doc('sessions/' + sessionId + '/meta/allocation');
      const activationLeaseUntil = new Date(nowFn() + serverOffset + SESSION_ACTIVATION_LEASE_MS);
      return db.runTransaction(async transaction => {
        const sessionSnapshot = await transaction.get(sessionReference);
        const codeSnapshot = await transaction.get(codeReference);
        const allocationSnapshot = await transaction.get(allocationReference);
        if (!sessionSnapshot.exists || !codeSnapshot.exists) return false;
        const session = sessionSnapshot.data() || {};
        const mapping = codeSnapshot.data() || {};
        if (session.teacherUid !== teacherUid || session.code !== code ||
            mapping.sessionId !== sessionId) return false;
        if (allocationToken && (!allocationSnapshot.exists ||
            (allocationSnapshot.data() || {}).token !== allocationToken ||
            (allocationSnapshot.data() || {}).ownerUid !== teacherUid)) return false;
        if (!['allocating', 'live'].includes(session.status)) return false;
        transaction.set(sessionReference, {
          status: 'live',
          activationLeaseUntil
        }, { merge: true });
        return true;
      });
    }

    function renewSessionActivationLease(sessionId, code, teacherUid, allocationToken) {
      const sessionReference = db.doc('sessions/' + sessionId);
      const codeReference = db.doc('codes/' + code);
      const allocationReference = db.doc('sessions/' + sessionId + '/meta/allocation');
      const activationLeaseUntil = new Date(nowFn() + serverOffset + SESSION_ACTIVATION_LEASE_MS);
      return db.runTransaction(async transaction => {
        const sessionSnapshot = await transaction.get(sessionReference);
        const codeSnapshot = await transaction.get(codeReference);
        const allocationSnapshot = await transaction.get(allocationReference);
        if (!sessionSnapshot.exists || !codeSnapshot.exists || !allocationSnapshot.exists) return false;
        const session = sessionSnapshot.data() || {};
        const mapping = codeSnapshot.data() || {};
        const allocation = allocationSnapshot.data() || {};
        if (session.teacherUid !== teacherUid || session.code !== code ||
            session.status !== 'live' || mapping.sessionId !== sessionId ||
            allocation.ownerUid !== teacherUid || allocation.token !== allocationToken) return false;
        transaction.set(sessionReference, {
          activationLeaseUntil
        }, { merge: true });
        return true;
      });
    }

    async function abortSessionAllocation(sessionId, code, teacherUid, allocationToken) {
      const sessionReference = db.doc('sessions/' + sessionId);
      const codeReference = db.doc('codes/' + code);
      const allocationReference = db.doc('sessions/' + sessionId + '/meta/allocation');
      const collectionNames = [
        'meta', 'students', 'responses', 'grades', 'student_scores', 'snapshot', 'snapshot_images'
      ];
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const prepared = await db.runTransaction(async transaction => {
            const sessionSnapshot = await transaction.get(sessionReference);
            const codeSnapshot = await transaction.get(codeReference);
            const mapping = codeSnapshot.exists ? codeSnapshot.data() || {} : null;
            if (!sessionSnapshot.exists) {
              const complete = !mapping || mapping.sessionId !== sessionId;
              return { allowed: complete, complete };
            }
            const session = sessionSnapshot.data() || {};
            if (session.teacherUid !== teacherUid || session.code !== code) {
              return { allowed: false, complete: false };
            }
            if (session.classPlanId !== undefined) {
              const planId = assertPlanId(session.classPlanId);
              const privatePlanSnapshot = await transaction.get(
                db.doc('class_plans_private/' + planId)
              );
              const publicPlanSnapshot = await transaction.get(
                db.doc('class_plans_public/' + planId)
              );
              if (!privatePlanSnapshot.exists || !publicPlanSnapshot.exists) {
                return { allowed: false, complete: false };
              }
              const plan = assertClassPlanPair(
                privatePlanSnapshot.data(), publicPlanSnapshot.data(), true
              ).privateValue;
              if (plan.sessionId === sessionId && ['live', 'ended'].includes(plan.status)) {
                return { allowed: false, complete: false };
              }
              return { allowed: false, complete: false };
            }
            if (allocationToken) {
              const allocationSnapshot = await transaction.get(allocationReference);
              const allocation = allocationSnapshot.exists ? allocationSnapshot.data() || {} : null;
              if (!allocation || allocation.token !== allocationToken ||
                  allocation.ownerUid !== teacherUid) {
                return { allowed: false, complete: false };
              }
            }
            transaction.set(sessionReference, {
              status: 'aborted',
              abortedAt: fieldValue.serverTimestamp()
            }, { merge: true });
            if (mapping && mapping.sessionId === sessionId) transaction.delete(codeReference);
            return { allowed: true, complete: false };
          });
          if (!prepared.allowed) return false;
          if (prepared.complete) return true;

          const childReferences = [];
          for (const collectionName of collectionNames) {
            const snapshot = await db.collection(
              'sessions/' + sessionId + '/' + collectionName
            ).get();
            snapshot.docs.forEach(document => childReferences.push(document.ref));
          }
          for (const group of chunk(childReferences, 400)) {
            const batch = db.batch();
            group.forEach(reference => batch.delete(reference));
            await batch.commit();
          }

          return db.runTransaction(async transaction => {
            const sessionSnapshot = await transaction.get(sessionReference);
            if (!sessionSnapshot.exists) return true;
            const session = sessionSnapshot.data() || {};
            if (session.teacherUid !== teacherUid || session.code !== code ||
                session.status !== 'aborted') return false;
            transaction.delete(sessionReference);
            return true;
          });
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(
        '할당된 반 세션 정리에 실패했습니다. 원래 교사 계정으로 다시 시도해 주세요: ' +
        (lastError && lastError.message ? lastError.message : String(lastError || 'unknown'))
      );
    }

    async function recoverPendingSessionAllocation(record) {
      const pending = record || {};
      const sessionSnapshot = await db.doc('sessions/' + pending.sessionId).get();
      if (!sessionSnapshot.exists) return { complete: true, missing: true };
      const session = sessionSnapshot.data() || {};
      const code = pending.code || session.code;
      if (session.teacherUid !== pending.ownerUid || !code ||
          (pending.code && session.code !== pending.code)) {
        return { complete: false, ignored: true };
      }
      if (session.status === 'ended') {
        if (session.classPlanId === undefined && session.classPlanRevision === undefined) {
          return { complete: true, ended: true };
        }
        if (!pending.planId || pending.planId !== session.classPlanId ||
            !['attaching', 'attached'].includes(pending.attachStatus) ||
            !Number.isSafeInteger(session.classPlanRevision)) {
          return { complete: false, ignored: true };
        }
        const privateSnapshot = await db.doc(
          'class_plans_private/' + pending.planId
        ).get({ source: 'server' });
        const publicSnapshot = await db.doc(
          'class_plans_public/' + pending.planId
        ).get({ source: 'server' });
        if (!privateSnapshot.exists || !publicSnapshot.exists) {
          return { complete: false, ignored: true };
        }
        const plan = assertClassPlanPair(
          privateSnapshot.data(), publicSnapshot.data(), true
        ).privateValue;
        if (plan.sessionId !== pending.sessionId ||
            !['live', 'ended'].includes(plan.status) ||
            plan.revision !== session.classPlanRevision) {
          return { complete: false, ignored: true };
        }
        const finished = await finishClassPlan(pending.planId, pending.sessionId, {
          expectedRevision: session.classPlanRevision
        });
        return {
          complete: true,
          ended: true,
          finished: true,
          planRevision: finished.revision
        };
      }
      const allocationSnapshot = await db.doc(
        'sessions/' + pending.sessionId + '/meta/allocation'
      ).get();
      const allocation = allocationSnapshot.exists ? allocationSnapshot.data() || {} : null;
      if (!allocation || allocation.ownerUid !== pending.ownerUid ||
          allocation.token !== pending.token) {
        return { complete: false, ignored: true };
      }
      if (pending.planId && ['attaching', 'attached'].includes(pending.attachStatus)) {
        if (!pending.ownerEmail || !pending.setId || !Number.isSafeInteger(pending.planRevision)) {
          return { complete: false, ignored: true };
        }
        if (session.setId !== pending.setId) return { complete: false, ignored: true };
        const attached = await attachPlanToSession(
          pending.planId, pending.sessionId, {
            uid: pending.ownerUid,
            email: pending.ownerEmail,
            expectedRevision: pending.planRevision
          }
        );
        return {
          complete: false, active: true, attached: true,
          planRevision: attached.revision
        };
      }
      if (session.status === 'live') {
        const leaseUntil = timestampMillis(session.activationLeaseUntil);
        if (leaseUntil && nowFn() + serverOffset <= leaseUntil) {
          return { complete: false, active: true };
        }
      } else if (!['allocating', 'aborted'].includes(session.status)) {
        return { complete: false, ignored: true };
      }
      const cleaned = await abortSessionAllocation(
        pending.sessionId, code, pending.ownerUid, pending.token
      );
      return cleaned === true
        ? { complete: true, cleaned: true }
        : { complete: false, ignored: true };
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
      const sessionRef = db.doc('sessions/' + sessionId);
      const liveRef = db.doc('sessions/' + sessionId + '/meta/live');
      const migrationGateRef = db.doc('migration_gates/session_counters');
      return db.runTransaction(async transaction => {
        const sessionSnapshot = await transaction.get(sessionRef);
        const liveSnapshot = await transaction.get(liveRef);
        const migrationGateSnapshot = await transaction.get(migrationGateRef);
        if (!sessionSnapshot.exists || !liveSnapshot.exists) {
          throw new Error('종료할 session 또는 live 문서가 없습니다.');
        }
        const session = sessionSnapshot.data() || {};
        const live = liveSnapshot.data() || {};
        const count = session.registeredStudentCount;
        const revision = session.studentCountRevision;
        const validCounter = Number.isSafeInteger(count) && count >= 0 && revision === count &&
          (count === 0 && session.lastStudentUid === undefined ||
            count > 0 && typeof session.lastStudentUid === 'string' &&
              Boolean(session.lastStudentUid));
        if (!validCounter) {
          if (migrationGateSnapshot.exists &&
              validSessionCounterMigrationGate(migrationGateSnapshot.data())) {
            throw new Error('session student counter migration이 완료되어 legacy 종료가 닫혔습니다.');
          }
          if (session.registeredStudentCount !== undefined ||
              session.studentCountRevision !== undefined || session.lastStudentUid !== undefined ||
              session.actualParticipants !== undefined || session.classPlanId !== undefined ||
              session.classPlanRevision !== undefined) {
            throw new Error('session student counter migration이 필요합니다.');
          }
          if (session.status === 'ended' && live.status === 'ended') {
            return { endedAt: session.endedAt, legacy: true };
          }
          if (!['active', 'live'].includes(session.status)) {
            throw new Error('종료할 수 없는 legacy session 상태입니다.');
          }
          transaction.set(sessionRef, {
            status: 'ended', endedAt: fieldValue.serverTimestamp()
          }, { merge: true });
          transaction.set(liveRef, {
            q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended'
          });
          return { legacy: true };
        }
        if (session.status === 'ended' && live.status === 'ended' &&
            session.actualParticipants === count) {
          return {
            endedAt: session.endedAt,
            actualParticipants: session.actualParticipants
          };
        }
        if (session.status === 'ended' && live.status === 'ended') {
          transaction.set(sessionRef, { actualParticipants: count }, { merge: true });
          transaction.set(liveRef, {
            q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended'
          });
          return { endedAt: session.endedAt, actualParticipants: count, repaired: true };
        }
        if (!['active', 'live'].includes(session.status)) {
          throw new Error('종료할 수 없는 session 상태입니다.');
        }
        transaction.set(sessionRef, {
          status: 'ended',
          endedAt: fieldValue.serverTimestamp(),
          actualParticipants: count
        }, { merge: true });
        transaction.set(liveRef, {
          q: -1,
          openedAt: 0,
          revealed: false,
          limitSec: 0,
          status: 'ended'
        });
      });
    }

    async function requireTeacherAccessMigrationUnlocked(transaction) {
      const gate = await transaction.get(db.doc('migration_gates/teacher_access_status'));
      if (gate.exists && (gate.data() || {}).locked === true) {
        throw new Error('teacher access migration 잠금 중에는 관리자 계정을 변경할 수 없습니다.');
      }
    }

    async function adminUpdateTeacherAllowance(change, actor) {
      const value = change || {};
      const uid = assertUid(value.uid);
      const email = canonicalTeacherEmail(value.emailCanonical);
      const expectedRevision = assertExpectedRevision(value.expectedRevision);
      const role = value.role;
      const status = value.status;
      const reason = String(value.reason || '');
      if (!email || email !== value.emailCanonical) throw new Error('정확한 canonical email이 필요합니다.');
      validateAllowanceRole(role);
      if (!['active', 'suspended'].includes(status)) throw new Error('active 또는 suspended 상태만 허용됩니다.');
      if (reason.length > 200) throw new Error('중지 사유는 200자 이하여야 합니다.');
      assertLifecycleOperationCurrent(actor);
      const admin = await requireCurrentAdmin(actor);
      if (admin.uid === uid && (status !== 'active' || role !== 'admin')) {
        throw new Error('현재 관리자 계정은 자기 역할을 낮추거나 중지할 수 없습니다.');
      }
      const allowanceRef = db.doc('teacher_allowances/' + uid);
      let lifecycleOperationId = '';
      if (status === 'suspended') {
        const initialSnapshot = await allowanceRef.get({ source: 'server' });
        const initialAllowance = requireLifecycleAllowance(
          initialSnapshot, uid, expectedRevision
        );
        if (initialAllowance.emailCanonical !== email) {
          throw new Error('teacher allowance email 신원이 일치하지 않습니다.');
        }
        if (initialAllowance.status === 'deletion_pending') {
          throw new Error('deletion_pending 교사는 이 API로 변경할 수 없습니다.');
        }
        lifecycleOperationId = await acquirePublicationLifecycleLock(
          uid, expectedRevision, 'teacher-suspension', actor
        );
        try {
          await withdrawOwnedPublicationsForLifecycle(
            uid, expectedRevision, 'teacher-suspension', {
              ...actor, lifecycleOperationId
            }
          );
        } catch (error) {
          try {
            await releasePublicationLifecycleLock(
              uid, expectedRevision, 'teacher-suspension', actor, lifecycleOperationId
            );
          } catch (_) {
            // A failed release leaves the exact retry-adoptable lock fail-closed.
          }
          throw error;
        }
        assertLifecycleOperationCurrent(actor);
      }
      return db.runTransaction(async transaction => {
        const transactionAdmin = await requireTransactionAdmin(transaction, actor);
        await requireTeacherAccessMigrationUnlocked(transaction);
        const allowanceSnapshot = await transaction.get(allowanceRef);
        if (!allowanceSnapshot.exists) throw new Error('teacher allowance 승인 문서가 없습니다.');
        const allowance = allowanceSnapshot.data() || {};
        if (allowance.uid !== uid || allowance.emailCanonical !==
            canonicalTeacherEmail(allowance.emailCanonical) ||
            !['teacher', 'admin'].includes(allowance.role)) {
          throw new Error('teacher allowance identity 신원이 일치하지 않습니다.');
        }
        const currentRevision = allowanceRevision(allowance);
        if (currentRevision !== expectedRevision) throw new Error('teacher allowance revision이 변경되었습니다.');
        if (allowance.emailCanonical !== email) throw new Error('teacher allowance email 신원이 일치하지 않습니다.');
        if (allowance.status === 'deletion_pending') throw new Error('deletion_pending 교사는 이 API로 변경할 수 없습니다.');
        if (transactionAdmin.uid === uid && (status !== 'active' || role !== 'admin')) {
          throw new Error('현재 관리자 계정은 자기 역할을 낮추거나 중지할 수 없습니다.');
        }
        assertLifecycleOperationCurrent(actor);
        const lifecycleLockRef = db.doc('publication_lifecycle_locks/' + uid);
        const lifecycleGateRef = db.doc('publication_lifecycle_gates/current');
        if (lifecycleOperationId) {
          const lockSnapshot = await transaction.get(lifecycleLockRef);
          const gateSnapshot = await transaction.get(lifecycleGateRef);
          requireLifecycleLock(
            lockSnapshot, uid, allowance, 'teacher-suspension',
            actor, lifecycleOperationId
          );
          requireLifecycleLock(
            gateSnapshot, uid, allowance, 'teacher-suspension',
            actor, lifecycleOperationId
          );
        }
        const legacyRef = db.doc('teacher_allowlist/' + email);
        const legacySnapshot = await transaction.get(legacyRef);
        if (!legacySnapshot.exists) throw new Error('legacy allowance 승인 문서가 일치하지 않습니다.');
        const legacy = legacySnapshot.data() || {};
        if (legacy.role !== allowance.role || legacy.enabled !== allowance.enabled) {
          throw new Error('legacy allowance와 authoritative allowance가 일치하지 않습니다.');
        }
        const next = { ...allowance };
        next.status = status;
        next.enabled = status === 'active';
        next.role = role;
        next.administrativeHold = status === 'suspended';
        next.revision = currentRevision + 1;
        next.updatedAt = fieldValue.serverTimestamp();
        next.updatedByUid = transactionAdmin.uid;
        if (status === 'suspended') {
          next.suspendedAt = fieldValue.serverTimestamp();
          next.suspendedByUid = transactionAdmin.uid;
          next.suspensionReason = reason;
        } else {
          delete next.suspendedAt;
          delete next.suspendedByUid;
          delete next.suspensionReason;
        }
        transaction.set(allowanceRef, next);
        transaction.set(legacyRef, {
          uid, enabled: next.enabled, role: next.role,
          updatedAt: fieldValue.serverTimestamp(), updatedByUid: transactionAdmin.uid
        });
        if (lifecycleOperationId) {
          transaction.delete(lifecycleLockRef);
          transaction.delete(lifecycleGateRef);
        }
        return { ...next };
      }).catch(async error => {
        if (lifecycleOperationId) {
          try {
            await releasePublicationLifecycleLock(
              uid, expectedRevision, 'teacher-suspension', actor, lifecycleOperationId
            );
          } catch (_) {
            // A failed release leaves the exact retry-adoptable lock fail-closed.
          }
        }
        throw error;
      });
    }

    function requireGuestShareProjection(projection) {
      const value = projection || {};
      if (!guestQuizShare || !value.parent || !Array.isArray(value.videos) ||
          !Array.isArray(value.questions) || !value.images || typeof value.images !== 'object' ||
          value.parent.videoCount !== value.videos.length ||
          value.parent.questionCount !== value.questions.length ||
          value.parent.imageCount !== Object.keys(value.images).length) {
        throw new Error('비로그인 실행 projection이 유효하지 않습니다.');
      }
      return value;
    }

    function requireGuestShareOwner(source, actor) {
      const current = actor || {};
      if (!source || !activeSet(source) || source.ownerUid !== current.uid ||
          collaboration.canonicalEmail(source.ownerEmail) !== actorEmail(current)) {
        throw new Error('정확한 활성 세트 소유자만 비로그인 진행 링크를 관리할 수 있습니다.');
      }
      return source;
    }

    function guestShareId(value) {
      return canonicalPublicationId(value, 'shareId');
    }

    function guestRevisionDocuments(shareId, revision, projection, sourceRevision) {
      const base = 'guest_quiz_shares/' + shareId + '/revisions/' + revision;
      const documents = [{
        path: base,
        value: {
          ...projection.parent,
          shareId,
          revision,
          sourceContentRevision: sourceRevision,
          status: 'ready',
          createdAt: fieldValue.serverTimestamp()
        }
      }];
      projection.videos.forEach(video => documents.push({
        path: base + '/videos/' + video.videoKey,
        value: { ...video, shareId, revision }
      }));
      projection.questions.forEach(question => documents.push({
        path: base + '/questions/' + question.questionKey,
        value: { ...question, shareId, revision }
      }));
      Object.entries(projection.images).forEach(([key, data]) => documents.push({
        path: base + '/images/' + key,
        value: { data, shareId, revision, schemaVersion: 1 }
      }));
      return documents;
    }

    async function writeGuestRevision(shareId, revision, projection, sourceRevision) {
      const documents = guestRevisionDocuments(
        shareId, revision, requireGuestShareProjection(projection), sourceRevision
      );
      for (const group of chunk(documents, 400)) {
        const batch = db.batch();
        group.forEach(document => batch.set(db.doc(document.path), document.value));
        await batch.commit();
      }
    }

    async function getOwnedGuestQuizShare(setId, actor) {
      const id = canonicalPublicationId(setId, 'setId');
      const source = await getQuizSet(id);
      requireGuestShareOwner(source, actor);
      const mappingSnapshot = await db.doc('guest_quiz_share_sources/' + id)
        .get({ source: 'server' });
      if (!mappingSnapshot.exists) return null;
      const mapping = mappingSnapshot.data() || {};
      if (mapping.sourceSetId !== id || mapping.sourceOwnerUid !== source.ownerUid ||
          !mapping.shareId) throw new Error('비로그인 진행 링크 소유 매핑이 유효하지 않습니다.');
      const shareSnapshot = await db.doc('guest_quiz_shares/' + guestShareId(mapping.shareId))
        .get({ source: 'server' });
      if (!shareSnapshot.exists) throw new Error('비로그인 진행 링크 문서가 없습니다.');
      const share = shareSnapshot.data() || {};
      if (share.sourceSetId !== id || share.sourceOwnerUid !== source.ownerUid ||
          share.shareId !== mapping.shareId || share.status !== mapping.status ||
          share.revision !== mapping.revision) {
        throw new Error('비로그인 진행 링크와 소유 매핑이 일치하지 않습니다.');
      }
      return { ...share };
    }

    async function createGuestQuizShare(setId, projection, actor, requestedShareId) {
      const id = canonicalPublicationId(setId, 'setId');
      const source = requireGuestShareOwner(await getQuizSet(id), actor);
      const sourceRevision = requireContentRevision(source);
      const shareId = guestShareId(requestedShareId || createLiveToken());
      if (!/^[A-Za-z0-9_-]{43}$/.test(shareId)) {
        throw new Error('비로그인 진행 링크 식별자가 유효하지 않습니다.');
      }
      const projectionValue = requireGuestShareProjection(projection);
      const shareRef = db.doc('guest_quiz_shares/' + shareId);
      const mappingRef = db.doc('guest_quiz_share_sources/' + id);
      const [existingShare, existingMapping] = await Promise.all([
        shareRef.get({ source: 'server' }), mappingRef.get({ source: 'server' })
      ]);
      if (existingShare.exists || existingMapping.exists) {
        throw new Error('이미 존재하는 공유 식별자는 다시 사용할 수 없습니다.');
      }
      await shareRef.set({
        shareId, sourceSetId: id, sourceOwnerUid: source.ownerUid,
        sourceContentRevision: sourceRevision, status: 'building',
        revision: 1, createdAt: fieldValue.serverTimestamp(),
        updatedAt: fieldValue.serverTimestamp(), revokedAt: null
      });
      await writeGuestRevision(shareId, 1, projectionValue, sourceRevision);
      await db.runTransaction(async transaction => {
        const [latestSourceSnapshot, latestShareSnapshot, latestMappingSnapshot] = await Promise.all([
          transaction.get(db.doc('quiz_sets/' + id)), transaction.get(shareRef), transaction.get(mappingRef)
        ]);
        const latestSource = quizSetValue(latestSourceSnapshot);
        requireGuestShareOwner(latestSource, actor);
        if (requireContentRevision(latestSource) !== sourceRevision || latestMappingSnapshot.exists ||
            !latestShareSnapshot.exists) throw new Error('공유 활성화 전 원본 또는 매핑이 변경되었습니다.');
        const latestShare = latestShareSnapshot.data() || {};
        if (latestShare.status !== 'building' || latestShare.revision !== 1) {
          throw new Error('공유 활성화 상태가 변경되었습니다.');
        }
        transaction.set(shareRef, { status: 'active', updatedAt: fieldValue.serverTimestamp() }, { merge: true });
        transaction.set(mappingRef, {
          sourceSetId: id, sourceOwnerUid: source.ownerUid, shareId,
          status: 'active', revision: 1, updatedAt: fieldValue.serverTimestamp()
        });
      });
      return { shareId, revision: 1, status: 'active' };
    }

    async function refreshGuestQuizShare(setId, projection, actor) {
      const id = canonicalPublicationId(setId, 'setId');
      const source = requireGuestShareOwner(await getQuizSet(id), actor);
      const sourceRevision = requireContentRevision(source);
      const current = await getOwnedGuestQuizShare(id, actor);
      if (!current || current.status !== 'active') throw new Error('활성 비로그인 공유가 없습니다.');
      const revision = current.revision + 1;
      const shareId = guestShareId(current.shareId);
      await writeGuestRevision(shareId, revision, projection, sourceRevision);
      const shareRef = db.doc('guest_quiz_shares/' + shareId);
      const mappingRef = db.doc('guest_quiz_share_sources/' + id);
      await db.runTransaction(async transaction => {
        const [latestSourceSnapshot, shareSnapshot, mappingSnapshot] = await Promise.all([
          transaction.get(db.doc('quiz_sets/' + id)), transaction.get(shareRef), transaction.get(mappingRef)
        ]);
        const latestSource = quizSetValue(latestSourceSnapshot);
        requireGuestShareOwner(latestSource, actor);
        const share = shareSnapshot.exists ? shareSnapshot.data() || {} : {};
        const mapping = mappingSnapshot.exists ? mappingSnapshot.data() || {} : {};
        if (requireContentRevision(latestSource) !== sourceRevision || share.status !== 'active' ||
            mapping.status !== 'active' || share.revision !== current.revision ||
            mapping.revision !== current.revision || mapping.shareId !== shareId) {
          throw new Error('활성 공유 revision이 갱신 중 변경되었습니다.');
        }
        transaction.set(shareRef, {
          revision, sourceContentRevision: sourceRevision, updatedAt: fieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(mappingRef, { revision, updatedAt: fieldValue.serverTimestamp() }, { merge: true });
      });
      return { shareId, revision, status: 'active' };
    }

    async function revokeGuestQuizShare(setId, actor) {
      const id = canonicalPublicationId(setId, 'setId');
      const source = requireGuestShareOwner(await getQuizSet(id), actor);
      const current = await getOwnedGuestQuizShare(id, actor);
      if (!current || current.status !== 'active') throw new Error('활성 비로그인 공유가 없습니다.');
      const shareRef = db.doc('guest_quiz_shares/' + guestShareId(current.shareId));
      const mappingRef = db.doc('guest_quiz_share_sources/' + id);
      await db.runTransaction(async transaction => {
        const [shareSnapshot, mappingSnapshot] = await Promise.all([
          transaction.get(shareRef), transaction.get(mappingRef)
        ]);
        const share = shareSnapshot.exists ? shareSnapshot.data() || {} : {};
        const mapping = mappingSnapshot.exists ? mappingSnapshot.data() || {} : {};
        if (share.status !== 'active' || mapping.status !== 'active' ||
            share.sourceOwnerUid !== source.ownerUid || mapping.shareId !== current.shareId) {
          throw new Error('공유 해제 전 상태가 변경되었습니다.');
        }
        const patch = {
          status: 'revoked', revokedAt: fieldValue.serverTimestamp(), updatedAt: fieldValue.serverTimestamp()
        };
        transaction.set(shareRef, patch, { merge: true });
        transaction.set(mappingRef, patch, { merge: true });
      });
      return { shareId: current.shareId, status: 'revoked' };
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
      submitTeacherRequest,
      getOwnTeacherRequest,
      cancelTeacherRequest,
      resubmitTeacherRequest,
      getOwnTeacherAllowance,
      requestTeacherDeletion,
      cancelTeacherDeletion,
      adminCancelTeacherDeletion,
      listDeletionPendingTeachers,
      getTeacherDeletionReadiness,
      resolveTeacherDeletionSession,
      listPendingTeacherRequests,
      decideTeacherRequest,
      suspendTeacher,
      restoreTeacher,
      createClassPlan,
      updateOwnClassPlan,
      cancelOwnClassPlan,
      getClassPlanningThresholds,
      updateClassPlanningThresholds,
      listPublicPlans,
      listAdminPlans,
      subscribePublicPlans,
      subscribeAdminPlans,
      getOwnClassPlan,
      listOwnClassPlans,
      attachPlanToSession,
      finishClassPlan,
      listTeacherAllowances,
      adminUpdateTeacherAllowance,
      upsertTeacherAllowance,
      disableTeacherAllowance,
      getCounterMigrationState,
      listQuizSets,
      listSharedQuizSets,
      listTrashQuizSets,
      listTrash,
      listExpiredTrash,
      moveSetToTrash,
      restoreSet,
      beginSetPurge,
      continueSetPurge,
      getQuizSet,
      listCollaborators,
      addCollaborator,
      removeCollaborator,
      canEditQuizSet,
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
      publishQuizSet,
      withdrawPublishedQuizSet,
      adminModeratePublishedQuiz,
      adminRestorePublishedQuiz,
      listPublishedQuizSets,
      getOwnedPublicationStatus,
      getOwnedGuestQuizShare,
      createGuestQuizShare,
      refreshGuestQuizShare,
      revokeGuestQuizShare,
      listAdminPublishedQuizSets,
      auditOwnedPublications,
      withdrawOwnedPublicationsForLifecycle,
      getPublishedQuizSet,
      copyPublishedQuizSet,
      loadGuestQuizRevision,
      loadActiveGuestQuizShare,
      prepareGuestSession,
      startSession,
      activateSessionAllocation,
      renewSessionActivationLease,
      abortSessionAllocation,
      recoverPendingSessionAllocation,
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
      listOwnedDerivedSessions,
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
        return serverNow();
      },

      claimSessionCode
    };
  }

  return {
    createFirestoreStore,
    estimateBatchRequest,
    publicQuestion,
    validateStudentAnswer,
    publicAnswer,
    createLiveToken,
    liveIdentity
  };
});
