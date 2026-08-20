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
  const api = factory(core, collaboration, teacherAccess);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, collaboration, teacherAccess) {
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
    const SESSION_ACTIVATION_LEASE_MS = 120_000;
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
      const validation = teacherAccessCore().validateRequest(value);
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
        if (legacySnapshot.exists && legacy.role !== 'teacher') {
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
      if (adminIdentity) await requireCurrentAdmin(adminIdentity);
      const snapshot = await db.collection('teacher_access_requests')
        .where('status', '==', 'pending').limit(count).get();
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
          !allowance.emailCanonical || allowance.role !== 'teacher') {
        throw new Error('teacher allowance identity 신원이 일치하지 않습니다.');
      }
      return allowance;
    }

    async function suspendTeacher(uid, reason, adminIdentity) {
      const exactUid = assertUid(uid);
      const suspensionReason = String(reason || '');
      if (suspensionReason.length > 200) throw new Error('중지 사유는 200자 이하여야 합니다.');
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
        if (allowance.status !== 'active' || allowance.enabled !== true) {
          throw new Error('active 교사만 중지할 수 있습니다.');
        }
        const timestamp = fieldValue.serverTimestamp();
        transaction.set(allowanceRef, {
          ...allowance,
          status: 'suspended',
          enabled: false,
          suspendedAt: timestamp,
          suspendedByUid: admin.uid,
          suspensionReason,
          updatedAt: timestamp,
          updatedByUid: admin.uid
        });
        transaction.set(legacyRef, {
          enabled: false,
          role: 'teacher',
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: admin.uid
        });
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
        restored.updatedAt = fieldValue.serverTimestamp();
        restored.updatedByUid = admin.uid;
        transaction.set(allowanceRef, restored);
        transaction.set(legacyRef, {
          enabled: true,
          role: 'teacher',
          updatedAt: fieldValue.serverTimestamp(),
          updatedByUid: admin.uid
        });
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
      const snapshot = await db.collection('teacher_allowlist').get();
      return Object.fromEntries(snapshot.docs.map(document => [
        canonicalTeacherEmail(document.id), allowanceData(document)
      ]));
    }

    async function upsertTeacherAllowance(email, role, actor) {
      const current = await requireCurrentAdmin(actor);
      const normalizedEmail = canonicalTeacherEmail(email);
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        throw new Error('유효한 이메일을 입력해 주세요.');
      }
      validateAllowanceRole(role);
      if (normalizedEmail === current.email && role !== 'admin') {
        throw new Error('현재 관리자 계정은 자기 계정을 teacher로 낮출 수 없습니다.');
      }
      await db.doc('teacher_allowlist/' + normalizedEmail).set({
        enabled: true,
        role,
        updatedAt: fieldValue.serverTimestamp(),
        updatedByUid: current.uid
      }, { merge: true });
      return db.doc('teacher_allowlist/' + normalizedEmail).get({ source: 'server' })
        .then(allowanceData);
    }

    async function disableTeacherAllowance(email, actor) {
      const current = await requireCurrentAdmin(actor);
      const normalizedEmail = canonicalTeacherEmail(email);
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        throw new Error('유효한 이메일을 입력해 주세요.');
      }
      if (normalizedEmail === current.email) {
        throw new Error('현재 관리자 계정은 자기 계정을 비활성화할 수 없습니다.');
      }
      await db.doc('teacher_allowlist/' + normalizedEmail).set({
        enabled: false,
        updatedAt: fieldValue.serverTimestamp(),
        updatedByUid: current.uid
      }, { merge: true });
      return db.doc('teacher_allowlist/' + normalizedEmail).get({ source: 'server' })
        .then(allowanceData);
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
        if (config.ownerUid && state !== 'active') {
          query = query.where('ownerUid', '==', config.ownerUid);
        } else if (config.ownerUid) {
          query = query.where('ownerUid', '==', config.ownerUid);
        }
      }
      const snapshot = await query.get();
      return snapshot.docs.map(quizSetValue);
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

    async function moveSetToTrash(setId, actor) {
      const current = actor || {};
      const reference = db.doc('quiz_sets/' + setId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        const set = quizSetValue(snapshot);
        if (!set || set.ownerUid !== current.uid || !activeSet(set)) {
          throw new Error('소유자만 활성 세트를 휴지통으로 이동할 수 있습니다.');
        }
        requireAuthoritativeCounters(set);
        transaction.set(reference, {
          trashedAt: fieldValue.serverTimestamp(),
          purgeStartedAt: null,
          lifecycleState: 'trashed',
          contentRevision: fieldValue.serverTimestamp()
        }, { merge: true });
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
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
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
        transaction.set(reference, {
          purgeStartedAt: fieldValue.serverTimestamp(),
          lifecycleState: 'purging'
        }, { merge: true });
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
      if (deleted > 0) return { done: false, deleted, parentDeleted: false };

      // Both child collections were observed empty. The transaction re-reads the
      // parent and deletes only the same purge generation, with the Rules closing
      // child creation once purgeStartedAt exists.
      const collaboratorProbe = await db.collection(
        'quiz_sets/' + setId + '/collaborators'
      ).limit(1).get();
      const imageProbe = await db.collection('images/' + setId + '/q').limit(1).get();
      if (!collaboratorProbe.empty || !imageProbe.empty) {
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
        return listQuizSets({ ownerUid: config.ownerUid, lifecycleState: config.lifecycleState, allowAdminTrash: config.role === 'admin' });
      }
      const options = { ownerUid: config.ownerUid, allowAdminTrash: config.role === 'admin' };
      const [trashed, purging] = await Promise.all([
        listQuizSets({ ...options, lifecycleState: 'trashed' }),
        listQuizSets({ ...options, lifecycleState: 'purging' })
      ]);
      return trashed.concat(purging);
    }

    async function listExpiredTrash(scope, limit) {
      const config = typeof scope === 'string' ? { ownerUid: scope } : (scope || {});
      const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 20;
      const listOptions = { ownerUid: config.ownerUid, allowAdminTrash: config.role === 'admin' };
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
      const sourceReference = storedSession.setId && db.doc('quiz_sets/' + storedSession.setId);
      const sourceCheck = storedSession.setId && sourceReference &&
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
            const codeSnapshot = await transaction.get(codeReference);
            const mapping = codeSnapshot.exists ? codeSnapshot.data() || {} : null;
            if (!sessionSnapshot.exists) {
              return !mapping || mapping.sessionId !== sessionId;
            }
            const session = sessionSnapshot.data() || {};
            if (session.teacherUid !== teacherUid || session.code !== code ||
                session.status !== 'aborted') return false;
            if (mapping && mapping.sessionId === sessionId) transaction.delete(codeReference);
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
      if (session.status === 'ended') return { complete: true, ended: true };
      const allocationSnapshot = await db.doc(
        'sessions/' + pending.sessionId + '/meta/allocation'
      ).get();
      const allocation = allocationSnapshot.exists ? allocationSnapshot.data() || {} : null;
      if (!allocation || allocation.ownerUid !== pending.ownerUid ||
          allocation.token !== pending.token) {
        return { complete: false, ignored: true };
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
      const batch = db.batch();
      batch.set(db.doc('sessions/' + sessionId), {
        status: 'ended',
        endedAt: fieldValue.serverTimestamp()
      }, { merge: true });
      batch.set(db.doc('sessions/' + sessionId + '/meta/live'), {
        q: -1,
        openedAt: 0,
        revealed: false,
        limitSec: 0,
        status: 'ended'
      });
      await batch.commit();
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
      listPendingTeacherRequests,
      decideTeacherRequest,
      suspendTeacher,
      restoreTeacher,
      listTeacherAllowances,
      upsertTeacherAllowance,
      disableTeacherAllowance,
      getCounterMigrationState,
      listQuizSets,
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
