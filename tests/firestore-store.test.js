const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../firestore-core.js');

const SERVER_TIMESTAMP = Symbol('server timestamp');
const DELETE_FIELD = Symbol('delete field');

function clone(value) {
  if (value === undefined) return undefined;
  if (value === SERVER_TIMESTAMP) return value;
  if (value === DELETE_FIELD) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function merge(current, update) {
  const result = clone(current || {});
  Object.entries(update).forEach(([key, value]) => {
    if (value === DELETE_FIELD) delete result[key];
    else if (value instanceof Date) result[key] = new Date(value.getTime());
    else if (value && typeof value === 'object' && !Array.isArray(value) &&
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value);
    } else result[key] = clone(value);
  });
  return result;
}

function pendingAllocationTestContext(overrides = {}) {
  return {
    Date,
    PENDING_ALLOCATION_RECOVERY_DELAY_MS: 30_000,
    pendingAllocationRemember() { return true; },
    pendingAllocationPatch() { return true; },
    pendingAllocationRemove() { return true; },
    plStartSessionHeartbeat() { return null; },
    ...overrides
  };
}

function updateFieldPaths(current, update, resolveValue = clone) {
  const result = clone(current || {});
  Object.entries(update).forEach(([fieldPath, value]) => {
    const segments = fieldPath.split('.');
    let target = result;
    segments.slice(0, -1).forEach(segment => {
      if (!target[segment] || typeof target[segment] !== 'object') target[segment] = {};
      target = target[segment];
    });
    const key = segments.at(-1);
    if (value === DELETE_FIELD) delete target[key];
    else target[key] = resolveValue(value);
  });
  return result;
}

function requestTransformCount(value) {
  if (value === SERVER_TIMESTAMP) return 1;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + requestTransformCount(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce(
      (count, item) => count + requestTransformCount(item), 0
    );
  }
  return 0;
}

function requestBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value, (key, item) =>
    item === SERVER_TIMESTAMP ? '__server_timestamp__' : item
  ) || '').length;
}

function fakeIndexBytes(value, fieldPath = '', documentPath = '') {
  if (value === SERVER_TIMESTAMP || value === null || value === undefined) return 0;
  if (Array.isArray(value)) {
    return value.reduce((count, item, index) =>
      count + fakeIndexBytes(item, fieldPath + '.' + index, documentPath), 0
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((count, [key, item]) =>
      count + fakeIndexBytes(item, fieldPath ? fieldPath + '.' + key : key, documentPath), 0
    );
  }
  const encodedValue = new TextEncoder().encode(String(value)).length;
  const encodedPath = new TextEncoder().encode(fieldPath).length;
  const encodedDocument = new TextEncoder().encode(documentPath).length;
  return 2 * (Math.min(encodedValue, 1_500) + encodedPath + encodedDocument + 48);
}

function fakeOperationBytes(operation, existingDocuments) {
  const previous = existingDocuments.get(operation.ref.path);
  const value = operation.operation === 'delete' ? previous : operation.value;
  const nextBytes = requestBytes(operation.ref.path) + 256 + requestBytes(value) +
    fakeIndexBytes(value, '', operation.ref.path);
  if (operation.operation === 'delete' || previous === undefined) return nextBytes;
  return nextBytes + requestBytes(operation.ref.path) + 256 + requestBytes(previous) +
    fakeIndexBytes(previous, '', operation.ref.path);
}

function makeFirestoreFake(initial = {}, options = {}) {
  const committedServerMillis = options.committedServerMillis ?? 50_000;
  const documents = new Map(Object.entries(initial).map(([path, value]) => [path, clone(value)]));
  const documentListeners = new Map();
  const collectionListeners = new Map();
  const subscribed = [];
  const calls = [];
  let pending = Promise.resolve();
  let batchCommitCount = 0;
  let transactionCommitCount = 0;

  const fieldValue = {
    serverTimestamp() {
      return SERVER_TIMESTAMP;
    },
    delete() {
      return DELETE_FIELD;
    }
  };

  function resolveServerTimestamps(value) {
    if (value === SERVER_TIMESTAMP) {
      return { toMillis: () => committedServerMillis };
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(resolveServerTimestamps);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveServerTimestamps(item)])
      );
    }
    return value;
  }

  function docSnapshot(path, source = documents) {
    const value = source.get(path);
    return {
      exists: value !== undefined,
      id: path.split('/').at(-1),
      ref: docRef(path),
      metadata: { fromCache: false, hasPendingWrites: false },
      data: () => value === undefined ? undefined : clone(value),
      get: field => value && clone(value[field])
    };
  }

  function collectionDocs(path, source = documents) {
    const prefix = path + '/';
    return [...source.keys()]
      .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .sort()
      .map(key => docSnapshot(key, source));
  }

  function querySnapshot(path, source = documents, filters = []) {
    const limit = filters.find(filter => filter.type === 'limit');
    const docs = collectionDocs(path, source).filter(document =>
      filters.every(filter => filter.type === 'limit' ||
        filter.operator === '==' && document.get(filter.field) === filter.value)
    ).slice(0, limit ? limit.value : undefined);
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach(callback) { docs.forEach(callback); },
      metadata: { fromCache: false, hasPendingWrites: false }
    };
  }

  function schedule(callback) {
    pending = pending.then(() => new Promise(resolve => {
      setImmediate(() => {
        callback();
        resolve();
      });
    }));
  }

  function notify(path) {
    for (const listener of documentListeners.get(path) || []) {
      schedule(() => listener.next(docSnapshot(path)));
    }
    const segments = path.split('/');
    if (segments.length > 1) {
      const collectionPath = segments.slice(0, -1).join('/');
      for (const listener of collectionListeners.get(collectionPath) || []) {
        schedule(() => listener.next(querySnapshot(collectionPath)));
      }
    }
  }

  function write(path, value, optionsArg, shouldNotify = true) {
    calls.push({ operation: 'set', path, value: clone(value), options: clone(optionsArg) });
    const resolved = resolveServerTimestamps(value);
    documents.set(path, optionsArg && optionsArg.merge
      ? merge(documents.get(path), resolved)
      : clone(resolved));
    if (shouldNotify) notify(path);
  }

  function remove(path, shouldNotify = true) {
    calls.push({ operation: 'delete', path });
    documents.delete(path);
    if (shouldNotify) notify(path);
  }

  function addListener(registry, path, next, error, snapshot) {
    subscribed.push(path);
    const listener = { next, error };
    const listeners = registry.get(path) || [];
    listeners.push(listener);
    registry.set(path, listeners);
    schedule(() => next(snapshot(path)));
    return () => {
      const active = registry.get(path) || [];
      registry.set(path, active.filter(item => item !== listener));
    };
  }

  function docRef(path) {
    return {
      id: path.split('/').at(-1),
      path,
      parent: { path: path.split('/').slice(0, -1).join('/') },
      async get() {
        calls.push({ operation: 'get', path });
        return docSnapshot(path);
      },
      async set(value, optionsArg) {
        write(path, value, optionsArg);
      },
      async delete() {
        remove(path);
      },
      onSnapshot(next, error) {
        return addListener(documentListeners, path, next, error, docSnapshot);
      }
    };
  }

  function collectionRef(path, filters = []) {
    return {
      id: path.split('/').at(-1),
      path,
      async get() {
        calls.push({ operation: 'getCollection', path, filters: clone(filters) });
        return querySnapshot(path, documents, filters);
      },
      where(field, operator, value) {
        calls.push({ operation: 'where', path, field, operator, value: clone(value) });
        return collectionRef(path, filters.concat({ field, operator, value }));
      },
      limit(value) {
        return collectionRef(path, filters.concat({ type: 'limit', value }));
      },
      onSnapshot(next, error) {
        return addListener(collectionListeners, path, next, error, querySnapshot);
      }
    };
  }

  const db = {
    doc: docRef,
    collection: collectionRef,
    batch() {
      const operations = [];
      return {
        set(ref, value, optionsArg) {
          operations.push({ operation: 'set', ref, value, optionsArg });
          return this;
        },
        delete(ref) {
          operations.push({ operation: 'delete', ref });
          return this;
        },
        async commit() {
          batchCommitCount += 1;
          calls.push({ operation: 'batchCommit', size: operations.length });
          const requestWrites = operations.length + operations.reduce(
            (count, operation) => count + requestTransformCount(operation.value), 0
          );
          const batchBytes = operations.reduce((count, operation) =>
            count + fakeOperationBytes(operation, documents), 0
          );
          if (options.maxRequestWrites && requestWrites > options.maxRequestWrites) {
            throw new Error('fake Firestore request exceeds write limit');
          }
          if (options.maxRequestBytes && batchBytes > options.maxRequestBytes) {
            throw new Error('fake Firestore request exceeds byte limit');
          }
          if (options.failBatchCommitAt === batchCommitCount) {
            throw new Error('planned batch failure ' + batchCommitCount);
          }
          if (options.failBatchCommit) throw new Error(options.failBatchCommit);
          const touched = [];
          operations.forEach(operation => {
            if (operation.operation === 'set') {
              write(operation.ref.path, operation.value, operation.optionsArg, false);
            } else {
              remove(operation.ref.path, false);
            }
            touched.push(operation.ref.path);
          });
          touched.forEach(notify);
        }
      };
    },
    async runTransaction(updateFunction) {
      calls.push({ operation: 'runTransaction' });
      const staged = new Map(documents);
      const touched = new Set();
      const requestOperations = [];
      const transaction = {
        async get(ref) {
          calls.push({ operation: 'transactionGet', path: ref.path });
          if (options.beforeTransactionGet) await options.beforeTransactionGet(ref.path);
          return docSnapshot(ref.path, staged);
        },
        set(ref, value, optionsArg) {
          calls.push({ operation: 'transactionSet', path: ref.path, value: clone(value), options: clone(optionsArg) });
          requestOperations.push({ operation: 'set', ref, value });
          const resolved = resolveServerTimestamps(value);
          staged.set(ref.path, optionsArg && optionsArg.merge
            ? merge(staged.get(ref.path), resolved)
            : clone(resolved));
          touched.add(ref.path);
          return transaction;
        },
        update(ref, value) {
          calls.push({ operation: 'transactionUpdate', path: ref.path, value: clone(value) });
          requestOperations.push({ operation: 'update', ref, value });
          if (!staged.has(ref.path)) throw new Error('not-found');
          staged.set(ref.path, updateFieldPaths(
            staged.get(ref.path), value, resolveServerTimestamps
          ));
          touched.add(ref.path);
          return transaction;
        },
        delete(ref) {
          calls.push({ operation: 'transactionDelete', path: ref.path });
          requestOperations.push({ operation: 'delete', ref });
          staged.delete(ref.path);
          touched.add(ref.path);
          return transaction;
        }
      };
      const result = await updateFunction(transaction);
      const requestWrites = requestOperations.length + requestOperations.reduce(
        (count, operation) => count + requestTransformCount(operation.value), 0
      );
      const transactionBytes = requestOperations.reduce((count, operation) =>
        count + fakeOperationBytes(operation, documents), 0
      );
      if (options.maxRequestWrites && requestWrites > options.maxRequestWrites) {
        throw new Error('fake Firestore transaction exceeds write limit');
      }
      if (options.maxRequestBytes && transactionBytes > options.maxRequestBytes) {
        throw new Error('fake Firestore transaction exceeds byte limit');
      }
      transactionCommitCount += 1;
      if (options.failTransactionAt === transactionCommitCount) {
        throw new Error(options.failTransactionMessage || 'planned transaction failure ' + transactionCommitCount);
      }
      documents.clear();
      staged.forEach((value, path) => documents.set(path, value));
      touched.forEach(notify);
      return result;
    }
  };

  return {
    db,
    fieldValue,
    async flush() { await pending; },
    emit(path, value) {
      documents.set(path, clone(value));
      notify(path);
    },
    fail(path, error) {
      for (const listener of documentListeners.get(path) || []) listener.error(error);
      for (const listener of collectionListeners.get(path) || []) listener.error(error);
    },
    value(path) { return clone(documents.get(path)); },
    has(path) { return documents.has(path); },
    subscribedPaths() { return [...subscribed]; },
    calls() { return clone(calls); }
  };
}

function loadStoreModule() {
  return require('../firestore-store.js');
}

function extractFunction(source, name) {
  let start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 함수를 찾을 수 있어야 한다');
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(name + ' 함수 끝을 찾을 수 없습니다');
}

function loadStageFunctions(names, context) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  names.forEach(name => vm.runInNewContext(extractFunction(html, name), context));
  return context;
}

test('browser Firestore store exposes no legacy owner probe or migration write API', () => {
  const store = loadStoreModule().createFirestoreStore({}, { serverTimestamp() {} }, Date.now);

  assert.equal(Object.prototype.hasOwnProperty.call(store, 'probeLegacyOwner'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'migrateLegacyOwnership'), false);
});

test('캐시된 YouTube API가 콜백보다 먼저 준비돼도 대기 작업을 즉시 실행한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {
    ytReady: false,
    ytWaiters: [],
    window: { YT: { Player: function Player() {} } },
    callbackRuns: 0
  };
  vm.runInNewContext(extractFunction(html, 'markYTReady'), context);
  vm.runInNewContext(extractFunction(html, 'whenYT'), context);

  vm.runInNewContext('whenYT(() => { callbackRuns += 1; })', context);

  assert.equal(context.callbackRuns, 1);
  assert.equal(context.ytReady, true);
  assert.equal(context.ytWaiters.length, 0);
});

test('캐시된 YouTube API 준비 경로는 기존 대기 작업과 현재 작업을 한 번씩 비운다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const blockStart = html.indexOf('let ytReady = false;');
  const blockEnd = html.indexOf('/* ── 유튜브 자막', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, 'YouTube 준비 블록을 찾을 수 있어야 한다');

  const context = { window: { YT: { Player: function Player() {} } } };
  vm.runInNewContext(html.slice(blockStart, blockEnd), context);
  vm.runInNewContext(`
    var priorRuns = 0;
    var currentRuns = 0;
    ytWaiters.push(() => { priorRuns += 1; });
    whenYT(() => { currentRuns += 1; });
  `, context);

  assert.equal(context.priorRuns, 1);
  assert.equal(context.currentRuns, 1);
  assert.equal(vm.runInNewContext('ytWaiters.length', context), 0);

  vm.runInNewContext('window.onYouTubeIframeAPIReady(); window.onYouTubeIframeAPIReady();', context);

  assert.equal(context.priorRuns, 1);
  assert.equal(context.currentRuns, 1);
  assert.equal(vm.runInNewContext('ytWaiters.length', context), 0);
});

function createStore(fake) {
  const { createFirestoreStore } = loadStoreModule();
  return createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
}

test('휴지통 이동과 복원은 소유자 상태 전환을 원자적으로 기록하고 archived를 보존한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-trash': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', archived: true,
      lifecycleState: 'active', trashedAt: null, purgeStartedAt: null,
      collaboratorCount: 0, imageCount: 0
    }
  }, { committedServerMillis: 1_000 });
  const { createFirestoreStore } = loadStoreModule();
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1 + 30 * 86400000 - 1);
  await store.moveSetToTrash('set-trash', { uid: 'owner' });
  assert.equal(fake.value('quiz_sets/set-trash').lifecycleState, 'trashed');
  assert.equal(fake.value('quiz_sets/set-trash').archived, true);
  assert.ok(fake.value('quiz_sets/set-trash').trashedAt);
  await store.restoreSet('set-trash', { uid: 'owner' });
  assert.equal(fake.value('quiz_sets/set-trash').lifecycleState, 'active');
  assert.equal(fake.value('quiz_sets/set-trash').trashedAt, undefined);
  await assert.rejects(store.moveSetToTrash('set-trash', { uid: 'editor' }), /소유자/);
});

test('휴지통 purge는 collaborators/images를 200개 이하 batch로 지우고 parent를 마지막에 idempotently 삭제한다', async () => {
  const initial = {
    'quiz_sets/set-purge': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'trashed',
      trashedAt: 1, purgeStartedAt: null, collaboratorCount: 0, imageCount: 201
    },
    'sessions/keep': { teacherUid: 'owner' },
    'sessions/keep/snapshot/set': { title: 'keep' }
  };
  for (let index = 0; index < 201; index += 1) {
    initial['images/set-purge/q/v0q' + index] = { data: 'image' };
  }
  const fake = makeFirestoreFake(initial, { committedServerMillis: 100 });
  const store = createStore(fake);
  await store.beginSetPurge('set-purge', 'immediate', { uid: 'owner', role: 'teacher' });
  const first = await store.continueSetPurge('set-purge');
  assert.equal(first.done, false);
  assert.equal(first.deleted, 200);
  assert.equal(fake.has('quiz_sets/set-purge'), true);
  const second = await store.continueSetPurge('set-purge');
  assert.equal(second.done, false);
  assert.equal(second.deleted, 1);
  const completed = await store.continueSetPurge('set-purge');
  assert.equal(completed.parentDeleted, true);
  assert.equal(fake.has('quiz_sets/set-purge'), false);
  assert.equal(fake.has('sessions/keep'), true);
  assert.equal(fake.has('sessions/keep/snapshot/set'), true);
  const third = await store.continueSetPurge('set-purge');
  assert.equal(third.parentDeleted, true);
});

test('purge는 30일 경계 전 admin을 거부하고 경계 후에만 시작한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'quiz_sets/set-expired': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'trashed',
      trashedAt: 1, purgeStartedAt: null, collaboratorCount: 0, imageCount: 0
    }
  }, { committedServerMillis: 1 + 30 * 86400000 - 1 });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1 + 30 * 86400000 - 1);
  await assert.rejects(
    store.beginSetPurge('set-expired', 'expired', { uid: 'admin', role: 'admin' }),
    /30일/
  );
  const exactFake = makeFirestoreFake({
    'quiz_sets/set-expired': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'trashed',
      trashedAt: 1, purgeStartedAt: null, collaboratorCount: 0, imageCount: 0
    }
  }, { committedServerMillis: 1 + 30 * 86400000 });
  const exactStore = createFirestoreStore(exactFake.db, exactFake.fieldValue, () => 1 + 30 * 86400000);
  assert.deepEqual(
    await exactStore.beginSetPurge('set-expired', 'expired', { uid: 'admin', role: 'admin' }),
    { started: true }
  );
});

test('공개 전 문항에는 정답과 해설과 비공개 이미지 경로가 없다', () => {
  const { publicQuestion } = loadStoreModule();

  const value = publicQuestion({
    type: 'mc', text: 'Q', choices: ['A', 'B'], answer: 1, explain: 'E',
    answers: [1], accept: ['secret'], imgUp: true, imgUrl: 'private-url', key: 'v1q2'
  }, 3, 8, 'data:image/jpeg;base64,public');

  assert.deepEqual(value, {
    number: 3,
    total: 8,
    type: 'mc',
    text: 'Q',
    choices: ['A', 'B'],
    image: 'data:image/jpeg;base64,public'
  });
  for (const field of ['answer', 'answers', 'accept', 'explain', 'imgUp', 'imgUrl', 'key']) {
    assert.equal(field in value, false);
  }
});

test('공개 답은 필요한 정답 필드만 복사하고 legacy accept를 안전한 경계로 제한한다', () => {
  const { publicAnswer } = loadStoreModule();

  assert.deepEqual(publicAnswer({
    type: 'short', accept: ['서울', 'Seoul'], explain: '대한민국의 수도'
  }), {
    accept: ['서울', 'Seoul'],
    explain: '대한민국의 수도'
  });
  const capped = publicAnswer({
    type: 'short',
    accept: ['가'.repeat(101)].concat(Array.from({ length: 20 }, (_, i) => String(i)))
  });
  assert.equal(capped.accept.length, 20);
  assert.equal(capped.accept[0].length, 100);
  assert.throws(
    () => publicAnswer({ type: 'short', accept: ['정답', { private: true }] }),
    /문자열/
  );
});

test('공개 문항 projection은 편집기와 같은 문자열·이미지 경계를 적용한다', () => {
  const { publicQuestion } = loadStoreModule();
  assert.throws(() => publicQuestion({ type: 'choice', text: 'x'.repeat(1001), choices: [] }, 1, 1), /문항/);
  assert.throws(() => publicQuestion({ type: 'choice', text: 'Q', choices: ['x'.repeat(201)] }, 1, 1), /보기/);
  assert.throws(() => publicQuestion({ type: 'choice', text: 'Q', choices: [] }, 1, 1, 'javascript:alert(1)'), /이미지/);
  assert.throws(() => publicQuestion({ type: 'choice', text: 'Q', choices: [] }, 1, 1,
    'data:image/jpeg;base64,' + 'A'.repeat(380101)), /이미지/);
});

test('학생 응답 client validation은 공개 문항 유형과 같은 경계를 적용한다', () => {
  const { validateStudentAnswer } = loadStoreModule();
  assert.doesNotThrow(() => validateStudentAnswer({ type: 'choice', choices: ['A', 'B'] }, 1));
  assert.throws(() => validateStudentAnswer({ type: 'choice', choices: ['A', 'B'] }, 2), /객관식/);
  assert.throws(() => validateStudentAnswer({ type: 'multi', choices: ['A', 'B'] }, [0, 0]), /중복/);
  assert.throws(() => validateStudentAnswer({ type: 'short', choices: [] }, 'x'.repeat(101)), /단답형/);
  assert.throws(() => validateStudentAnswer({ type: 'long', choices: [] }, 'x'.repeat(1001)), /서술형/);
});

test('학생 참여는 자기 UID 문서를 먼저 읽고 프로필 필드로 저장한다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  const student = await store.joinStudent('session-a', 'anonymous-uid', {
    grade: 3, klass: 2, num: 7, name: '홍길동'
  });

  assert.deepEqual(fake.calls().filter(call => ['get', 'set'].includes(call.operation)).map(call => [
    call.operation, call.path
  ]), [
    ['get', 'sessions/session-a/students/anonymous-uid'],
    ['set', 'sessions/session-a/students/anonymous-uid']
  ]);
  const stored = fake.value('sessions/session-a/students/anonymous-uid');
  assert.deepEqual({ ...stored, joinedAt: stored.joinedAt.toMillis() }, {
    uid: 'anonymous-uid', grade: 3, klass: 2, num: 7, name: '홍길동', joinedAt: 50_000
  });
  assert.equal(student.uid, 'anonymous-uid');
});

test('학생 응답은 자기 UID 경로에 Task 2 허용 필드만 기록한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/session-a/responses/anonymous-uid': {
      uid: 'anonymous-uid',
      answers: { '0': { answer: 0, submitted: true, revision: 1, ok: true } }
    }
  });
  const store = createStore(fake);

  await store.writeStudentAnswer('session-a', 'anonymous-uid', 4, {
    answer: [1, 3], submitted: true, revision: 2, submittedAt: SERVER_TIMESTAMP,
    ok: true, score: 10, source: 'button', ms: 200
  });

  const stored = fake.value('sessions/session-a/responses/anonymous-uid');
  assert.deepEqual({
    ...stored,
    answers: {
      ...stored.answers,
      '4': { ...stored.answers['4'], submittedAt: stored.answers['4'].submittedAt.toMillis() }
    }
  }, {
    uid: 'anonymous-uid',
    answers: {
      '0': { answer: 0, submitted: true, revision: 1, ok: true },
      '4': { answer: [1, 3], submitted: true, revision: 2, submittedAt: 50_000 }
    }
  });
  assert.equal(fake.has('sessions/session-a/responses/3_2_7'), false);
});

test('returning student response keeps immutable uid and replaces the complete graded answer leaf', async () => {
  const fake = makeFirestoreFake({
    'sessions/session-a/responses/anonymous-uid': {
      uid: 'anonymous-uid',
      answers: {
        '0': { answer: 0, submitted: true, revision: 1 },
        '4': { answer: 1, submitted: true, revision: 2, ok: true }
      }
    }
  });
  const store = createStore(fake);

  await store.writeStudentAnswer('session-a', 'anonymous-uid', 4, {
    answer: 1, submitted: false, revision: 3, submittedAt: SERVER_TIMESTAMP
  });

  const stored = fake.value('sessions/session-a/responses/anonymous-uid');
  assert.equal(stored.uid, 'anonymous-uid');
  assert.deepEqual(stored.answers['0'], {
    answer: 0, submitted: true, revision: 1
  });
  assert.deepEqual({
    ...stored.answers['4'],
    submittedAt: stored.answers['4'].submittedAt.toMillis()
  }, {
    answer: 1, submitted: false, revision: 3, submittedAt: 50_000
  });
  assert.equal(Object.hasOwn(stored.answers['4'], 'ok'), false);
});

test('교사 승인 프로브는 정규화 이메일의 보호 문서를 서버에서만 읽고 역할을 판정한다', async () => {
  const reads = [];
  const denied = Object.assign(new Error('permission denied'), { code: 'permission-denied' });
  const db = {
    doc(path) {
      return {
        async get(options) {
          reads.push([path, options]);
          if (path.startsWith('config/')) throw denied;
          return { exists: false, id: path.split('/').at(-1), data() {} };
        }
      };
    }
  };
  const { createFirestoreStore } = loadStoreModule();
  const store = createFirestoreStore(db, {}, () => 0);

  const allowance = await store.probeTeacherAllowance(' Teacher@School.KR ');

  assert.deepEqual(allowance, { enabled: true, role: 'teacher' });
  assert.deepEqual(clone(reads), [
    ['quiz_sets/__teacher_allowance_probe__teacher%40school.kr', { source: 'server' }],
    ['config/__admin_allowance_probe__teacher%40school.kr', { source: 'server' }]
  ]);
});

test('교사 승인 서버 프로브가 오프라인이면 캐시 성공으로 폴백하지 않는다', async () => {
  const unavailable = Object.assign(new Error('offline'), { code: 'unavailable' });
  let cachedReads = 0;
  const db = {
    doc() {
      return {
        get(options) {
          if (options && options.source === 'server') return Promise.reject(unavailable);
          cachedReads += 1;
          return Promise.resolve({ exists: false, id: 'cached', data() {} });
        }
      };
    }
  };
  const store = loadStoreModule().createFirestoreStore(db, {}, () => 0);

  await assert.rejects(store.probeTeacherAllowance('teacher@school.kr'), unavailable);
  assert.equal(cachedReads, 0);
});

test('승인 프로브는 교사 보호 문서가 거부되면 미승인으로 끝내고 admin은 구분한다', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'permission-denied' });
  const makeStore = results => {
    let index = 0;
    const db = { doc() { return { get() { return results[index++](); } }; } };
    return loadStoreModule().createFirestoreStore(db, {}, () => 0);
  };

  assert.equal(await makeStore([
    () => Promise.reject(denied)
  ]).probeTeacherAllowance('blocked@school.kr'), null);

  assert.deepEqual(await makeStore([
    () => Promise.resolve({ exists: false, id: 'teacher', data() {} }),
    () => Promise.resolve({ exists: false, id: 'admin', data() {} })
  ]).probeTeacherAllowance('admin@school.kr'), { enabled: true, role: 'admin' });
});

test('allowance API canonicalizes email and writes audited admin changes', async () => {
  const fake = makeFirestoreFake({
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);
  const admin = { uid: 'admin-uid', email: 'ADMIN@School.KR', role: 'admin', authGeneration: 7 };

  await store.upsertTeacherAllowance(' New@School.KR ', 'teacher', admin);
  const stored = fake.value('teacher_allowlist/new@school.kr');
  assert.equal(stored.enabled, true);
  assert.equal(stored.role, 'teacher');
  assert.equal(stored.updatedByUid, 'admin-uid');
  assert.equal(stored.updatedAt.toMillis(), 50_000);

  const allowances = await store.listTeacherAllowances(admin);
  assert.deepEqual(allowances['admin@school.kr'], { enabled: true, role: 'admin' });
  assert.equal(allowances['new@school.kr'].role, 'teacher');

  await store.disableTeacherAllowance('new@school.kr', admin);
  assert.equal(fake.value('teacher_allowlist/new@school.kr').enabled, false);
  await assert.rejects(
    store.disableTeacherAllowance('ADMIN@School.KR', admin),
    /자기 계정/
  );
});

test('allowance API rejects non-admin, invalid role, empty email and stale auth generation before writes', async () => {
  const fake = makeFirestoreFake({
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);
  await assert.rejects(store.upsertTeacherAllowance('x@school.kr', 'owner', {
    uid: 'admin-uid', email: 'admin@school.kr', role: 'admin'
  }), /역할/);
  await assert.rejects(store.upsertTeacherAllowance('', 'teacher', {
    uid: 'admin-uid', email: 'admin@school.kr', role: 'admin'
  }), /이메일/);
  await assert.rejects(store.upsertTeacherAllowance('x@school.kr', 'teacher', {
    uid: 'teacher-uid', email: 'teacher@school.kr', role: 'teacher'
  }), /관리자/);
  await assert.rejects(store.upsertTeacherAllowance('x@school.kr', 'teacher', {
    uid: 'admin-uid', email: 'admin@school.kr', role: 'admin',
    authGeneration: 2, currentAuthGeneration: 3
  }), /로그인/);
  assert.equal(fake.value('teacher_allowlist/x@school.kr'), undefined);
});

test('공동 편집자는 승인된 교사만 소유자 트랜잭션으로 추가·조회·삭제한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'active',
      collaboratorCount: 0, imageCount: 0
    },
    'teacher_allowlist/editor@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowlist/disabled@school.kr': { enabled: false, role: 'teacher' }
  });
  const store = createStore(fake);
  const owner = { uid: 'owner', email: 'owner@school.kr', role: 'teacher' };
  const editor = { uid: 'editor', email: 'editor@school.kr', role: 'teacher' };
  await assert.rejects(store.addCollaborator('set1', 'disabled@school.kr', owner), /unapproved/);
  await store.addCollaborator('set1', 'EDITOR@School.KR', owner);
  assert.equal(fake.value('quiz_sets/set1').collaboratorCount, 1);
  assert.equal(fake.value('quiz_sets/set1/collaborators/editor@school.kr').email, 'editor@school.kr');
  assert.equal(await store.canEditQuizSet('set1', editor), true);
  assert.deepEqual((await store.listCollaborators('set1', owner)).map(item => item.email), ['editor@school.kr']);
  await assert.rejects(store.addCollaborator('set1', 'other@school.kr', editor), /소유자/);
  assert.equal(await store.removeCollaborator('set1', 'EDITOR@School.KR', owner), true);
  assert.equal(fake.value('quiz_sets/set1').collaboratorCount, 0);
  assert.equal(await store.canEditQuizSet('set1', editor), false);
});

test('공동 편집자 저장 API는 휴지통 세트와 권한 없는 actor를 거부한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/trash': { ownerUid: 'owner', ownerEmail: 'owner@school.kr', trashedAt: 1 },
    'quiz_sets/active': { ownerUid: 'owner', ownerEmail: 'owner@school.kr' }
  });
  const store = createStore(fake);
  await assert.rejects(store.saveQuizSet('active', { title: 'x' }, {
    uid: 'other', email: 'other@school.kr', role: 'admin'
  }), /편집할 권한/);
  await assert.rejects(store.replaceImages('trash', {}, {
    uid: 'owner', email: 'owner@school.kr', role: 'teacher'
  }), /편집할 권한/);
});

test('휴지통·정리 중인 원본은 사본과 새 수업 시작에 사용할 수 없다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/trash': { ownerUid: 'owner', ownerEmail: 'owner@school.kr', trashedAt: 1 },
    'quiz_sets/purging': { ownerUid: 'owner', ownerEmail: 'owner@school.kr', purgeStartedAt: 2 }
  });
  const store = createStore(fake);
  const teacher = { uid: 'owner', email: 'owner@school.kr', role: 'teacher' };
  await assert.rejects(store.copyOwnedQuizSet('trash', 'copy', teacher), /복사할 수/);
  await assert.rejects(store.startSession('s1', {
    setId: 'trash', teacherUid: 'owner', teacherEmail: 'owner@school.kr'
  }, () => 'NEW234'), /수업을 시작할 수/);
  await assert.rejects(store.startSession('s2', {
    setId: 'purging', teacherUid: 'owner', teacherEmail: 'owner@school.kr'
  }, () => 'NEW235'), /수업을 시작할 수/);
});

test('승인된 다른 교사도 활성 원본으로 수업을 시작할 수 있다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { ownerUid: 'owner', ownerEmail: 'owner@school.kr', trashedAt: null, purgeStartedAt: null },
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  });
  const store = createStore(fake);
  const code = await store.startSession('session1', {
    setId: 'set1', teacherUid: 'teacher', teacherEmail: 'teacher@school.kr'
  }, () => 'ACTIVE1');
  assert.equal(code, 'ACTIVE1');
});

test('세트 목록은 활성 query와 소유자 휴지통 query를 분리한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/active': { ownerUid: 'owner', trashedAt: null, purgeStartedAt: null, lifecycleState: 'active' },
    'quiz_sets/trash': { ownerUid: 'owner', trashedAt: 1, lifecycleState: 'trashed' },
    'quiz_sets/other-trash': { ownerUid: 'other', trashedAt: 1 }
  });
  const store = createStore(fake);
  assert.deepEqual((await store.listQuizSets()).map(set => set.id), ['active']);
  await assert.rejects(
    () => store.listQuizSets({ ownerUid: 'owner', includeTrash: true }),
    /휴지통과 정리 중/,
  );
  assert.deepEqual((await store.listTrashQuizSets('owner', 'trashed'))
    .map(set => set.id), ['trash']);
});

test('사본은 공동 편집·휴지통 상태를 물려받지 않고 활성 빈 상태로 시작한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'active',
      collaboratorCount: 3, collaboratorMutation: { email: 'x@school.kr', action: 'add' }, title: '원본'
    },
    'quiz_sets/source/collaborators/x@school.kr': { email: 'x@school.kr' }
  });
  const store = createStore(fake);
  const copied = await store.copyOwnedQuizSet('source', 'copy', {
    uid: 'teacher', email: 'teacher@school.kr'
  });
  assert.equal(copied.lifecycleState, 'active');
  assert.equal(copied.collaboratorCount, 0);
  assert.equal(copied.collaboratorMutation, undefined);
  assert.equal(copied.trashedAt, undefined);
  assert.equal(fake.has('quiz_sets/copy/collaborators/x@school.kr'), false);
});

test('새 세트와 사본은 현재 교사를 소유자로 기록한다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.saveOwnedQuizSet(
    's1',
    { title: 'A', videos: [], ownerUid: 'spoofed', ownerEmail: 'spoofed@example.com' },
    { v0q0: 'source-image', v1q2: 'second-image' },
    { uid: 't1', email: 't@school.kr' }
  );
  assert.equal(fake.value('quiz_sets/s1').ownerUid, 't1');
  assert.equal(fake.value('quiz_sets/s1').ownerEmail, 't@school.kr');
  assert.equal(fake.value('quiz_sets/s1').collaboratorCount, 0);
  assert.equal(fake.value('quiz_sets/s1').imageCount, 2);
  assert.equal(fake.value('quiz_sets/s1').lifecycleState, 'active');
  assert.equal(fake.value('quiz_sets/s1').contentRevision.toMillis(), 50_000);

  const copied = await store.copyOwnedQuizSet(
    's1',
    's2',
    { uid: 't2', email: 'other@school.kr' }
  );
  assert.equal(fake.value('quiz_sets/s2').ownerUid, 't2');
  assert.equal(fake.value('quiz_sets/s2').ownerEmail, 'other@school.kr');
  assert.equal(fake.value('quiz_sets/s2').collaboratorCount, 0);
  assert.equal(fake.value('quiz_sets/s2').imageCount, 2);
  assert.equal(fake.value('quiz_sets/s2').lifecycleState, 'active');
  assert.equal(fake.value('quiz_sets/s2').contentRevision.toMillis(), 50_000);
  assert.equal(copied.ownerUid, 't2');
  assert.equal(copied.ownerEmail, 'other@school.kr');
  assert.deepEqual(await store.getImages('s2'), {
    v0q0: 'source-image', v1q2: 'second-image'
  });
});

test('replaceImages는 strict counter transaction으로 이미지와 부모 revision을 기록한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': {
      title: '원본', ownerUid: 'owner', ownerEmail: 'owner@school.kr', contentRevision: 1,
      lifecycleState: 'active', collaboratorCount: 0, imageCount: 2
    },
    'images/source/q/v0q0': { data: 'old-image' },
    'images/source/q/v0q1': { data: 'delete-image' }
  });
  const store = createStore(fake);

  await store.replaceImages('source', { v0q0: 'new-image' });

  assert.equal(fake.value('quiz_sets/source').contentRevision.toMillis(), 50_000);
  assert.equal(fake.value('quiz_sets/source').imageCount, 1);
  assert.deepEqual(await store.getImages('source'), { v0q0: 'new-image' });
  assert.ok(fake.calls().some(call => call.operation === 'transactionSet' &&
    call.path === 'quiz_sets/source' && call.options && call.options.merge === true));
});

test('소유 세트 복사는 이미지 전용 변경과 삭제가 끼어들면 부모 revision으로 재시도한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': {
      title: '원본', ownerUid: 'owner', ownerEmail: 'owner@school.kr', contentRevision: 1,
      lifecycleState: 'active', collaboratorCount: 0, imageCount: 2
    },
    'images/source/q/v0q0': { data: 'delete-me' },
    'images/source/q/v0q1': { data: 'old-image' }
  });
  const originalCollection = fake.db.collection;
  let firstImageRead = true;
  let store;
  fake.db.collection = path => {
    const reference = originalCollection(path);
    if (path !== 'images/source/q') return reference;
    return {
      ...reference,
      async get() {
        const snapshot = await reference.get();
        if (firstImageRead) {
          firstImageRead = false;
          await store.replaceImages('source', { v0q1: 'new-image' });
        }
        return snapshot;
      }
    };
  };
  store = createStore(fake);

  const copied = await store.copyOwnedQuizSet(
    'source', 'copy', { uid: 'teacher-2', email: 'teacher2@school.kr' }
  );

  assert.equal(copied.title, '원본 (사본)');
  assert.deepEqual(await store.getImages('source'), { v0q1: 'new-image' });
  assert.deepEqual(await store.getImages('copy'), { v0q1: 'new-image' });
  assert.equal(fake.has('images/copy/q/v0q0'), false);
  assert.equal(fake.value('quiz_sets/copy').contentRevision.toMillis(), 50_000);
  assert.ok(fake.calls().filter(call => call.operation === 'transactionGet' &&
    call.path === 'quiz_sets/source').length >= 2);
});

test('소유 세트 복사는 원본과 이미지가 동시에 바뀌면 같은 최신 리비전으로 재시도한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': { title: '원본 v1', ownerUid: 'owner', ownerEmail: 'owner@school.kr' },
    'images/source/q/v0q0': { data: 'image-v1' }
  });
  const originalCollection = fake.db.collection;
  let firstImageRead = true;
  fake.db.collection = path => {
    const reference = originalCollection(path);
    if (path !== 'images/source/q') return reference;
    return {
      ...reference,
      async get() {
        const snapshot = await reference.get();
        if (firstImageRead) {
          firstImageRead = false;
          fake.emit('quiz_sets/source', {
            title: '원본 v2', ownerUid: 'owner', ownerEmail: 'owner@school.kr'
          });
          fake.emit('images/source/q/v0q0', { data: 'image-v2' });
        }
        return snapshot;
      }
    };
  };
  const store = createStore(fake);

  const copied = await store.copyOwnedQuizSet(
    'source', 'copy', { uid: 'teacher-2', email: 'teacher2@school.kr' }
  );

  assert.equal(copied.title, '원본 v2 (사본)');
  assert.equal(fake.value('quiz_sets/copy').title, '원본 v2 (사본)');
  assert.deepEqual(await store.getImages('copy'), { v0q0: 'image-v2' });
  assert.ok(fake.calls().filter(call => call.operation === 'transactionGet' &&
    call.path === 'quiz_sets/source').length >= 2);
});

test('소유 세트 복사 중 원본이 삭제되면 목적지를 만들지 않고 null을 반환한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': { title: '원본', ownerUid: 'owner', ownerEmail: 'owner@school.kr' },
    'images/source/q/v0q0': { data: 'source-image' }
  });
  const originalCollection = fake.db.collection;
  fake.db.collection = path => {
    const reference = originalCollection(path);
    if (path !== 'images/source/q') return reference;
    return {
      ...reference,
      async get() {
        const snapshot = await reference.get();
        fake.emit('quiz_sets/source', undefined);
        return snapshot;
      }
    };
  };
  const store = createStore(fake);

  const copied = await store.copyOwnedQuizSet(
    'source', 'copy', { uid: 'teacher-2', email: 'teacher2@school.kr' }
  );

  assert.equal(copied, null);
  assert.equal(fake.has('quiz_sets/copy'), false);
  assert.equal(fake.has('images/copy/q/v0q0'), false);
});

test('세트 편집은 관리자 여부와 무관하게 기록된 소유자에게만 허용한다', () => {
  const context = { AuthCore: require('../auth-core.js') };
  loadStageFunctions(['canEditSet'], context);

  assert.equal(context.canEditSet(
    { ownerUid: 'teacher-1' },
    { uid: 'teacher-1', role: 'teacher' }
  ), true);
  assert.equal(context.canEditSet(
    { ownerUid: 'teacher-1' },
    { uid: 'admin-1', role: 'admin' }
  ), false);
  assert.equal(context.canEditSet(
    {},
    { uid: 'teacher-1', role: 'teacher' }
  ), false);
  assert.equal(context.canEditSet(
    { ownerUid: 'teacher-1' },
    { status: 'unapproved', uid: 'teacher-1', role: '' }
  ), false);
  assert.equal(context.canEditSet(
    { ownerUid: 'teacher-1' },
    { status: 'unverified', uid: 'teacher-1', role: '' }
  ), false);
});

test('이미지를 문항별 문서로 교체하고 기존 화면 형태로 읽는다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { lifecycleState: 'active', collaboratorCount: 0, imageCount: 2 },
    'images/set1/q/0': { data: 'old' },
    'images/set1/q/3': { data: 'remove-me' }
  });
  const store = createStore(fake);

  await store.replaceImages('set1', { '0': 'new', '2': 'third' });

  assert.deepEqual(await store.getImages('set1'), { v0q0: 'new', v0q2: 'third' });
  assert.equal(fake.has('images/set1/q/0'), false);
  assert.equal(fake.value('images/set1/q/v0q0').data, 'new');
  assert.equal(fake.has('images/set1/q/3'), false);
});

test('기존 JSON의 희소 이미지 배열은 null 슬롯을 이미지 문서로 저장하지 않는다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { lifecycleState: 'active', collaboratorCount: 0, imageCount: 1 },
    'images/set1/q/1': { data: 'remove-old' }
  });
  const store = createStore(fake);

  await store.replaceImages('set1', ['first', null, 'third']);

  assert.deepEqual(await store.getImages('set1'), { v0q0: 'first', v0q2: 'third' });
  assert.equal(fake.value('images/set1/q/v0q0').data, 'first');
  assert.equal(fake.has('images/set1/q/1'), false);
});

test('구형 숫자 이미지 문서는 첫 영상의 신형 키로 읽는다', async () => {
  const fake = makeFirestoreFake({
    'images/set1/q/0': { data: 'legacy-shadowed' },
    'images/set1/q/1': { data: 'legacy-only' },
    'images/set1/q/v0q0': { data: 'canonical' },
    'images/set1/q/v1q0': { data: 'second-video' }
  });
  const store = createStore(fake);

  assert.deepEqual(await store.getImages('set1'), {
    v0q0: 'canonical', v0q1: 'legacy-only', v1q0: 'second-video'
  });
  assert.equal(await store.getQuestionImage('set1', 'v0q0'), 'canonical');
  assert.equal(await store.getQuestionImage('set1', 'v0q1'), 'legacy-only');
  assert.equal(await store.getQuestionImage('set1', 'v1q0'), 'second-video');
});

test('다중 영상 세트와 영상별 이미지 키를 보존한다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);
  const videos = [
    { videoId: 'a', questions: [{ text: 'A' }] },
    { videoId: 'b', questions: [{ text: 'B' }] }
  ];

  await store.saveQuizSet('set1', { title: '세트', videos });
  await store.replaceImages('set1', { v0q0: 'img-a', v1q0: 'img-b' });

  assert.deepEqual(fake.value('quiz_sets/set1').videos, videos);
  assert.equal(fake.value('images/set1/q/v0q0').data, 'img-a');
  assert.equal(fake.value('images/set1/q/v1q0').data, 'img-b');
});

test('세트 목록과 단건 읽기는 문서 ID를 우선하고 문항 배열을 보존한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      id: 'payload-id',
      title: '첫 세트',
      trashedAt: null,
      purgeStartedAt: null,
      lifecycleState: 'active',
      questions: [{ type: 'choice', text: '문항' }]
    }
  });
  const store = createStore(fake);

  assert.deepEqual(await store.listQuizSets(), [{
    id: 'set1',
    title: '첫 세트',
    trashedAt: null,
    purgeStartedAt: null,
    lifecycleState: 'active',
    questions: [{ type: 'choice', text: '문항' }]
  }]);
  assert.deepEqual(await store.getQuizSet('set1'), {
    id: 'set1',
    title: '첫 세트',
    trashedAt: null,
    purgeStartedAt: null,
    lifecycleState: 'active',
    questions: [{ type: 'choice', text: '문항' }]
  });
});

test('구형·신형 세트를 영상 배열 중심의 같은 화면 모델로 정규화한다', () => {
  const context = {
    DEFAULT_SETTINGS: { revealMode: 'timer', limitSec: 20, revealDelaySec: 5, autoPause: true },
    REVEAL_LABEL: { timer: '타이머' },
    QTYPES: { choice: '객관식' },
    OX_CHOICES: ['O', 'X'],
    PlaylistCore: require('../playlist-core.js')
  };
  loadStageFunctions(['normSettings', 'normQuestions', 'normSet'], context);

  const legacy = context.normSet({
    title: '구형', videoId: 'a', videoUrl: 'url-a', questions: [{ t: 10, text: 'A' }]
  });
  const modern = context.normSet({
    title: '신형', videos: [
      { videoId: 'a', startSec: 10, endSec: 20, questions: [{ t: 15, text: 'A' }] },
      { videoId: 'b', startSec: 30, endSec: 60, questions: [{ t: 40, text: 'B' }] }
    ]
  });

  assert.deepEqual(JSON.parse(JSON.stringify(legacy.videos)), [{
    videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
    questions: [{
      type: 'choice', t: 10, text: 'A', choices: [], answer: 0, answers: [], accept: [],
      imgUrl: '', imgUp: false, _img: '', explain: '', limitSec: null
    }]
  }]);
  assert.deepEqual(modern.videos.map(video => video.videoId), ['a', 'b']);
  assert.deepEqual(context.PlaylistCore.flattenQuestions(legacy.videos).map(q => [q.number, q.videoIndex, q.text]), [
    [1, 0, 'A']
  ]);
  assert.equal(legacy.questions, undefined);
  assert.equal(legacy.videoId, undefined);
});

test('화면용 세트 정규화는 소유자 UID와 이메일을 보존한다', () => {
  const context = {
    DEFAULT_SETTINGS: { revealMode: 'timer', limitSec: 20, revealDelaySec: 5, autoPause: true },
    REVEAL_LABEL: { timer: '타이머' },
    QTYPES: { choice: '객관식' },
    OX_CHOICES: ['O', 'X'],
    PlaylistCore: require('../playlist-core.js')
  };
  loadStageFunctions(['normSettings', 'normQuestions', 'normSet'], context);

  const set = context.normSet({
    title: '소유 세트', ownerUid: 'teacher-1', ownerEmail: 'teacher@school.kr', videos: []
  });

  assert.equal(set.ownerUid, 'teacher-1');
  assert.equal(set.ownerEmail, 'teacher@school.kr');
});

test('세트 날짜 Timestamp는 기존 화면과 내보내기가 쓰는 밀리초 숫자로 바꾼다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: '날짜 세트',
      lifecycleState: 'active',
      createdAt: { toMillis: () => 1_700_000_000_000 },
      updatedAt: { toMillis: () => 1_700_000_100_000 }
    }
  });
  const store = createStore(fake);

  assert.deepEqual(await store.listQuizSets(), [{
    id: 'set1', title: '날짜 세트', lifecycleState: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000
  }]);
  assert.deepEqual(await store.getQuizSet('set1'), {
    id: 'set1', title: '날짜 세트', lifecycleState: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000
  });
});

test('세트 저장은 문서 ID를 중복 저장하지 않고 문항 배열을 그대로 쓴다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);
  const questions = [
    { type: 'choice', choices: ['가', '나'], answer: 1 },
    { type: 'short', accept: ['정답'] }
  ];

  await store.saveQuizSet('set1', { id: 'wrong', title: '저장', questions });

  assert.deepEqual(fake.value('quiz_sets/set1'), {
    title: '저장', questions, lifecycleState: 'active', collaboratorCount: 0, imageCount: 0
  });
});

test('세트 숨김 패치는 다른 필드를 보존한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { title: '원본', questions: [{ text: '유지' }], archived: false }
  });
  const store = createStore(fake);

  await store.patchQuizSet('set1', { archived: true });

  assert.deepEqual(fake.value('quiz_sets/set1'), {
    title: '원본', questions: [{ text: '유지' }], archived: true
  });
});

test('세트 숨김 해제는 기존 내보내기처럼 archived 필드를 제거한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { title: '원본', questions: [{ text: '유지' }], archived: true }
  });
  const store = createStore(fake);

  await store.patchQuizSet('set1', { archived: false });

  assert.deepEqual(fake.value('quiz_sets/set1'), {
    title: '원본', questions: [{ text: '유지' }]
  });
});

test('문항 이미지 한 장은 data만 반환하고 없으면 빈 문자열을 반환한다', async () => {
  const fake = makeFirestoreFake({ 'images/set1/q/v0q2': { data: 'data:image/png;base64,abc' } });
  const store = createStore(fake);

  assert.equal(await store.getQuestionImage('set1', 2), 'data:image/png;base64,abc');
  assert.equal(await store.getQuestionImage('set1', 3), '');
});

test('세트 복제는 새 문서와 모든 이미지를 만들고 원본을 바꾸지 않는다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': {
      title: '원본', author: '교사', questions: [{ type: 'choice', text: '문항' }]
    },
    'images/source/q/0': { data: 'first-image' },
    'images/source/q/2': { data: 'third-image' }
  });
  const store = createStore(fake);

  const copied = await store.copyQuizSet('source', 'copy', {
    title: '원본 (사본)', author: '새 교사', createdAt: 100, updatedAt: 100
  });

  assert.deepEqual(copied, {
    id: 'copy', title: '원본 (사본)', author: '새 교사',
    questions: [{ type: 'choice', text: '문항' }], createdAt: 100, updatedAt: 100,
    collaboratorCount: 0, imageCount: 0, lifecycleState: 'active'
  });
  assert.deepEqual(fake.value('quiz_sets/source'), {
    title: '원본', author: '교사', questions: [{ type: 'choice', text: '문항' }]
  });
  const storedCopy = fake.value('quiz_sets/copy');
  assert.equal(storedCopy.contentRevision.toMillis(), 50_000);
  delete storedCopy.contentRevision;
  assert.deepEqual(storedCopy, {
    title: '원본 (사본)', author: '새 교사',
    questions: [{ type: 'choice', text: '문항' }], createdAt: 100, updatedAt: 100,
    collaboratorCount: 0, imageCount: 2, lifecycleState: 'active',
    imageMutation: { key: 'v0q2', action: 'add' }
  });
  assert.deepEqual(await store.getImages('copy'), { v0q0: 'first-image', v0q2: 'third-image' });
  assert.equal(fake.value('images/copy/q/v0q0').data, 'first-image');
  assert.equal(fake.has('images/copy/q/0'), false);
});

test('모든 새 세트 저장은 빈 authoritative counters와 active lifecycle로 시작한다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.saveQuizSet('plain', {
    ownerUid: 'owner', ownerEmail: 'owner@school.kr', title: '일반 저장',
    lifecycleState: 'purging', collaboratorCount: 7, imageCount: -1,
    collaboratorMutation: { email: 'x@school.kr', action: 'add' },
    imageMutation: { key: 'q', action: 'add' }, trashedAt: 1, purgeStartedAt: 2
  });
  assert.deepEqual(fake.value('quiz_sets/plain'), {
    ownerUid: 'owner', ownerEmail: 'owner@school.kr', title: '일반 저장',
    lifecycleState: 'active', collaboratorCount: 0, imageCount: 0
  });

  await store.saveOwnedQuizSet('owned', {
    title: '소유 저장', lifecycleState: 'trashed', collaboratorCount: 3, imageCount: -1,
    collaboratorMutation: { email: 'x@school.kr', action: 'add' },
    imageMutation: { key: 'q', action: 'add' }, trashedAt: 1, purgeStartedAt: 2
  }, {}, { uid: 'owner', email: 'owner@school.kr' });
  const owned = fake.value('quiz_sets/owned');
  assert.equal(owned.lifecycleState, 'active');
  assert.equal(owned.collaboratorCount, 0);
  assert.equal(owned.imageCount, 0);
  assert.equal(owned.collaboratorMutation, undefined);
  assert.equal(owned.imageMutation, undefined);
  assert.equal(owned.trashedAt, undefined);
  assert.equal(owned.purgeStartedAt, undefined);
});

test('legacy 또는 음수 counter 세트의 이미지 저장은 migration 전 fail-closed다', async () => {
  for (const [name, parent] of [
    ['missing', { ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'active' }],
    ['negative', { ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'active', imageCount: -1, collaboratorCount: 0 }]
  ]) {
    const fake = makeFirestoreFake({
      [`quiz_sets/${name}`]: parent,
      [`images/${name}/q/v0q0`]: { data: 'old' }
    });
    const store = createStore(fake);
    await assert.rejects(
      store.saveQuizSetWithImages(name, { ...parent, title: '변경' }, { v0q0: 'new' }),
      /counter migration/
    );
    await assert.rejects(
      store.replaceImages(name, { v0q0: 'new' }),
      /counter migration/
    );
    assert.equal(fake.value(`quiz_sets/${name}`).title, undefined);
    assert.equal(fake.value(`images/${name}/q/v0q0`).data, 'old');
  }
});

test('사본 만들기는 현재 교사를 소유자로 지정하는 복사 API를 사용한다', async () => {
  const calls = [];
  const notices = [];
  const routes = [];
  const context = {
    teacherState: { uid: 'teacher-2', email: 'teacher2@school.kr', role: 'teacher' },
    store: {
      async copyOwnedQuizSet(...args) {
        calls.push(clone(args));
        return { id: args[1] };
      }
    },
    rid() { return 'copy-1'; }, lsGet() { return '새 교사'; }, SV_TS: {},
    toast(message) { notices.push(message); }, go(route) { routes.push(route); }, console,
    alert(message) { throw new Error(message); }
  };
  loadStageFunctions(['setDuplicate'], context);

  context.setDuplicate('source');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, [[
    'source', 'copy-1',
    { uid: 'teacher-2', email: 'teacher2@school.kr', role: 'teacher' }
  ]]);
  assert.deepEqual(notices, ['사본을 만들었습니다']);
  assert.deepEqual(routes, ['make/copy-1']);
});

test('복사 API가 null을 반환하면 성공 안내나 편집 이동을 하지 않는다', async () => {
  const notices = [];
  const routes = [];
  const context = {
    teacherState: { uid: 'teacher-2', email: 'teacher2@school.kr', role: 'teacher' },
    store: { async copyOwnedQuizSet() { return null; } },
    rid() { return 'copy-1'; },
    toast(message) { notices.push(message); }, go(route) { routes.push(route); },
    console, alert(message) { throw new Error(message); }
  };
  loadStageFunctions(['setDuplicate'], context);

  await context.setDuplicate('missing-source');

  assert.deepEqual(notices, ['세트를 찾을 수 없습니다']);
  assert.deepEqual(routes, []);
});

test('단일 세트 내보내기는 Firestore 문서 ID를 빼고 기존 JSON 형식을 유지한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let downloaded;
  class FakeBlob {
    constructor(parts, options) { this.parts = parts; this.type = options.type; }
  }
  const context = {
    store: {
      async getQuizSet() { return { id: 'set1', title: '내보내기', questions: [{ text: '문항' }] }; },
      async getImages() { return { v0q0: 'image-data' }; }
    },
    EXPORT_VERSION: 1,
    Date,
    Blob: FakeBlob,
    safeFileName(value) { return value; },
    downloadBlob(name, blob) { downloaded = { name, blob }; },
    toast() {},
    alert(message) { throw new Error(message); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'setExport'), context);

  await context.setExport('set1');

  const pack = JSON.parse(downloaded.blob.parts[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(pack.set)), {
    title: '내보내기', questions: [{ text: '문항' }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(pack.images)), { v0q0: 'image-data' });
  assert.equal(pack.v, 1);
  assert.match(pack.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('가져오기는 모든 영상과 문항을 videos 배열로 저장한다', async () => {
  const saved = [];
  const images = [];
  const context = {
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    normSet() {
      return {
        title: '세트', author: '교사', settings: { limitSec: 20 },
        videos: [
          { videoId: 'a', videoUrl: 'url-a', startSec: 10, endSec: 20, questions: [{ type: 'long', t: 15, text: 'A' }] },
          { videoId: 'b', videoUrl: 'url-b', startSec: 30, endSec: 60, questions: [{ type: 'long', t: 40, text: 'B' }] }
        ]
      };
    },
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type; },
    rid() { return 'new-set'; },
    lsGet() { return ''; },
    SV_TS: { kind: 'timestamp' },
    store: {
      async saveOwnedQuizSet(id, value, valueImages) {
        saved.push([id, clone(value)]);
        images.push([id, clone(valueImages)]);
      }
    }
  };
  loadStageFunctions(['setImportOne'], context);

  await context.setImportOne({ set: {}, images: { '0': 'legacy-image', v1q0: 'new-image' } });

  assert.deepEqual(saved[0][1].videos.map(video => ({
    videoId: video.videoId, startSec: video.startSec, endSec: video.endSec,
    questions: video.questions.map(question => question.text)
  })), [
    { videoId: 'a', startSec: 10, endSec: 20, questions: ['A'] },
    { videoId: 'b', startSec: 30, endSec: 60, questions: ['B'] }
  ]);
  assert.equal(saved[0][1].questions, undefined);
  assert.deepEqual(images, [['new-set', { '0': 'legacy-image', v1q0: 'new-image' }]]);
});

test('가져온 세트는 현재 교사를 소유자로 지정하는 저장 API를 사용한다', async () => {
  const calls = [];
  const context = {
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    PlaylistCore: require('../playlist-core.js'),
    normSet() {
      return {
        title: '가져온 세트', author: '', settings: {},
        videos: [{ videoId: 'a', videoUrl: '', startSec: 0, endSec: null,
          questions: [{ type: 'long', t: 1, text: '문항', choices: [], answer: 0 }] }]
      };
    },
    qType(q) { return q.type; }, rid() { return 'imported-1'; }, lsGet() { return ''; }, SV_TS: {},
    store: {
      async saveOwnedQuizSet(id, value, images, teacher) {
        calls.push([id, clone(value), clone(images), clone(teacher)]);
      }
    }
  };
  loadStageFunctions(['setImportOne'], context);

  await context.setImportOne({
    set: { ownerUid: 'spoofed', ownerEmail: 'spoofed@example.com' },
    images: { v0q0: 'image' }
  });

  assert.equal(calls[0][0], 'imported-1');
  assert.deepEqual(calls[0][2], { v0q0: 'image' });
  assert.deepEqual(calls[0][3], {
    uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
  });
});

test('편집 payload는 영상별 문항과 업로드 이미지를 신형 키로 보존한다', () => {
  const context = {
    mk: {
      title: ' 세트 ', author: ' 교사 ', settings: {}, createdAt: 10, archived: false,
      videos: [
        { videoId: 'a', videoUrl: ' url-a ', startSec: 10, endSec: 20,
          questions: [{ type: 'long', t: 15, text: ' A ', choices: [], imgUp: true, _img: 'img-a' }] },
        { videoId: 'b', videoUrl: ' url-b ', startSec: 30, endSec: 60,
          questions: [{ type: 'long', t: 40, text: ' B ', choices: [], imgUp: true, _img: 'img-b' }] }
      ]
    },
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type; },
    normSettings(value) { return value; },
    SV_TS: { kind: 'timestamp' }
  };
  loadStageFunctions(['mkPayload'], context);

  const payload = context.mkPayload();

  assert.deepEqual(JSON.parse(JSON.stringify(payload.set.videos)), [
    { videoId: 'a', videoUrl: 'url-a', startSec: 10, endSec: 20,
      questions: [{ type: 'long', t: 15, text: 'A', choices: [], answer: 0, imgUp: true }] },
    { videoId: 'b', videoUrl: 'url-b', startSec: 30, endSec: 60,
      questions: [{ type: 'long', t: 40, text: 'B', choices: [], answer: 0, imgUp: true }] }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.images)), { v0q0: 'img-a', v1q0: 'img-b' });
  assert.equal(payload.set.questions, undefined);
});

test('저장된 세트 편집은 모든 영상과 영상별 canonical 이미지를 복원한다', async () => {
  const app = { innerHTML: '' };
  const errors = [];
  let rendered = 0;
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    lsGet() { return '기본 교사'; },
    DEFAULT_SETTINGS: {},
    blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} },
    mkHandleSaveShortcut() {},
    onCleanup() {}, clearTimeout() {}, every() {}, $() { return null; },
    APP() { return app; }, topbar() { return '<nav></nav>'; },
    store: {
      async getQuizSet() {
        return {
          title: '세트', author: '교사', ownerUid: 'teacher-1', settings: {}, createdAt: 10, updatedAt: 20,
          videos: [
            { videoId: 'a', videoUrl: 'url-a', startSec: 10, endSec: 20,
              questions: [{ text: 'A', imgUp: true, _img: '' }] },
            { videoId: 'b', videoUrl: 'url-b', startSec: 30, endSec: 60,
              questions: [{ text: 'B', imgUp: true, _img: '' }] }
          ]
        };
      },
      async getImages() { return { v0q0: 'img-a', v1q0: 'img-b' }; }
    },
    normSet(value) { return value; }, mkRestoreDraft() { return false; },
    renderMake() { rendered += 1; },
    console: { error(error) { errors.push(error); } }, toast() {}
  };
  loadStageFunctions(['canEditSet', 'screenMake'], context);

  context.screenMake('set1');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(errors, []);
  assert.equal(rendered, 1);
  assert.deepEqual(context.mk.videos.map(video => video.videoId), ['a', 'b']);
  assert.equal(context.mk.activeVideo, 0);
  assert.equal(context.mk.videoId, undefined);
  assert.equal(context.mk.questions, undefined);
  assert.equal(context.mk.videos[0].questions[0]._img, 'img-a');
  assert.equal(context.mk.videos[1].questions[0]._img, 'img-b');
});

test('비소유 세트 편집 URL은 읽기 전용 안내와 시작·사본 동작만 제공한다', async () => {
  const app = { innerHTML: '' };
  let imageReads = 0;
  let editorRenders = 0;
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    lsGet() { return '교사'; }, DEFAULT_SETTINGS: {}, blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} },
    mkHandleSaveShortcut() {}, onCleanup() {}, clearTimeout() {}, every() {}, $() { return null; },
    APP() { return app; }, topbar() { return '<nav></nav>'; }, esc(value) { return String(value); },
    store: {
      async getQuizSet() {
        return {
          id: 'shared-1', title: '공유 세트', ownerUid: 'teacher-2', ownerEmail: 'other@school.kr',
          settings: {}, videos: [{ videoId: 'a', questions: [{ text: 'A' }] }]
        };
      },
      async getImages() { imageReads += 1; return {}; }
    },
    normSet(value) { return value; }, mkRestoreDraft() { return false; },
    renderMake() { editorRenders += 1; }, console, toast() {}
  };
  loadStageFunctions(['canEditSet', 'screenMake'], context);

  context.screenMake('shared-1');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(imageReads, 0);
  assert.equal(editorRenders, 0);
  assert.match(app.innerHTML, /읽기 전용/);
  assert.match(app.innerHTML, /우리 반 시작하기/);
  assert.match(app.innerHTML, /사본 만들기/);
  assert.doesNotMatch(app.innerHTML, /변경 사항 저장|세트 편집/);
});

test('세트 로드 중 승인이 취소되면 같은 UID 소유자도 편집 화면을 열지 않는다', async () => {
  const app = { innerHTML: '' };
  let finishSet;
  let imageReads = 0;
  let editorRenders = 0;
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: { status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    lsGet() { return '교사'; }, DEFAULT_SETTINGS: {}, blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} },
    mkHandleSaveShortcut() {}, onCleanup() {}, clearTimeout() {}, every() {}, $() { return null; },
    APP() { return app; }, topbar() { return '<nav></nav>'; }, esc(value) { return String(value); },
    store: {
      getQuizSet() { return new Promise(resolve => { finishSet = resolve; }); },
      async getImages() { imageReads += 1; return {}; }
    },
    normSet(value) { return value; }, mkRestoreDraft() { return false; },
    renderMake() { editorRenders += 1; }, console, toast() {}
  };
  loadStageFunctions(['canEditSet', 'screenMake'], context);

  context.screenMake('owned-1');
  context.teacherState = {
    status: 'unapproved', uid: 'teacher-1', email: 'teacher@school.kr', role: ''
  };
  finishSet({
    id: 'owned-1', title: '내 세트', ownerUid: 'teacher-1', ownerEmail: 'teacher@school.kr',
    settings: {}, videos: [{ videoId: 'a', questions: [{ text: 'A' }] }]
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(imageReads, 0);
  assert.equal(editorRenders, 0);
  assert.match(app.innerHTML, /읽기 전용/);
});

test('이미지 로드 중 교사가 교체되면 이전 소유 세트 편집 화면을 렌더링하지 않는다', async () => {
  const app = { innerHTML: '' };
  let finishImages;
  let editorRenders = 0;
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher1@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    lsGet() { return '교사'; }, DEFAULT_SETTINGS: {}, blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} },
    mkHandleSaveShortcut() {}, onCleanup() {}, clearTimeout() {}, every() {}, $() { return null; },
    APP() { return app; }, topbar() { return '<nav></nav>'; }, esc(value) { return String(value); },
    store: {
      async getQuizSet() {
        return {
          id: 'owned-1', title: '이전 교사 세트', ownerUid: 'teacher-1',
          ownerEmail: 'teacher1@school.kr', settings: {},
          videos: [{ videoId: 'a', questions: [{ text: 'A', imgUp: true }] }]
        };
      },
      getImages() { return new Promise(resolve => { finishImages = resolve; }); }
    },
    normSet(value) { return value; }, mkRestoreDraft() { return false; },
    renderMake() { editorRenders += 1; }, console, toast() {}
  };
  loadStageFunctions(['canEditSet', 'screenMake'], context);

  context.screenMake('owned-1');
  await new Promise(resolve => setImmediate(resolve));
  context.teacherState = {
    status: 'teacher', uid: 'teacher-2', email: 'teacher2@school.kr', role: 'teacher'
  };
  finishImages({ v0q0: 'private-image' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(editorRenders, 0);
  assert.equal(context.mk.readOnly, true);
  assert.match(app.innerHTML, /읽기 전용/);
  assert.equal(context.mk.videos[0].questions[0]._img, undefined);
});

test('다중 영상 편집기는 영상 카드와 추가 버튼을 렌더링한다', () => {
  const app = { innerHTML: '' };
  const elements = new Map();
  const context = {
    mk: {
      id: null, title: '세트', author: '', settings: {}, activeVideo: 0, saved: false,
      videos: [
        { videoId: 'a', videoUrl: 'a', startSec: 10, endSec: 60, durationSec: 90, questions: [] },
        { videoId: 'b', videoUrl: 'b', startSec: 0, endSec: null, durationSec: null, questions: [] }
      ]
    },
    mkPlayer: null, mkPlayerVid: '',
    APP() { return app; }, topbar() { return ''; }, esc(value) { return String(value ?? ''); },
    fmtTime(value) { return '0:' + String(value || 0).padStart(2, '0'); },
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type || 'choice'; }, QTYPES: { choice: '객관식' },
    mkAnswerField() { return ''; }, mkImageField() { return ''; },
    mkRenderSettings() {}, mkSyncVideo() {},
    mkShowShare() {}, mkMarkDirty() {}, lsSet() {},
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { addEventListener() {}, style: {} });
      return elements.get(selector);
    }
  };
  loadStageFunctions(['mkTimelineDomain', 'renderMake'], context);

  context.renderMake();

  assert.match(app.innerHTML, /class="mk-video-card[^\"]*" data-video-index="0"/);
  assert.match(app.innerHTML, /class="mk-video-card[^\"]*" data-video-index="1"/);
  assert.match(app.innerHTML, /다음 YouTube 영상 추가/);
  assert.equal((app.innerHTML.match(/id="mk-player-wrap"/g) || []).length, 1);
});

test('영상 카드는 추가·복사·이동·삭제해도 서로의 문항을 공유하지 않는다', () => {
  const context = {
    mk: {
      activeVideo: 0,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 10, endSec: 60,
        durationSec: 90, questions: [{ text: 'A' }] }]
    },
    blankQuestion(t) { return { t, text: '' }; }, renderMake() {}, mkMarkDirty() {},
    confirm() { return true; }
  };
  loadStageFunctions(['mkAddVideo', 'mkCopyVideo', 'mkMoveVideo', 'mkRemoveVideo'], context);

  context.mkAddVideo();
  assert.equal(context.mk.videos.length, 2);
  assert.equal(context.mk.activeVideo, 1);
  context.mkCopyVideo(0);
  context.mk.videos[1].questions[0].text = '사본 수정';
  assert.equal(context.mk.videos[0].questions[0].text, 'A');
  context.mkMoveVideo(1, 1);
  assert.equal(context.mk.videos[2].videoId, 'a');
  context.mkRemoveVideo(2);
  assert.equal(context.mk.videos.length, 2);
});

test('구간 손잡이와 직접 입력은 1초 간격을 지키며 같은 초 값을 갱신한다', () => {
  const context = {
    mk: { videos: [{ startSec: 10, endSec: 90, durationSec: 120 }] },
    parseTime(value) {
      if (typeof value === 'number') return value;
      const parts = String(value).split(':').map(Number);
      return parts.length === 2 ? parts[0] * 60 + parts[1] : Number(value);
    },
    renderMake() {}, mkMarkDirty() {}
  };
  loadStageFunctions(['mkTimelineDomain', 'mkRefreshVideoTiming', 'mkSetRange'], context);

  context.mkSetRange(0, 'start', '00:20');
  context.mkSetRange(0, 'end', 100);
  assert.deepEqual([context.mk.videos[0].startSec, context.mk.videos[0].endSec], [20, 100]);
  context.mkSetRange(0, 'start', 100);
  assert.deepEqual([context.mk.videos[0].startSec, context.mk.videos[0].endSec], [99, 100]);
});

test('타임라인 문항 시각은 현재 영상의 원본 YouTube 초로 저장된다', () => {
  const context = {
    mk: { videos: [{ startSec: 120, endSec: 630, durationSec: 700, questions: [{ t: 375 }] }] },
    parseTime(value) { return Number(value); }, renderMake() {}, mkMarkDirty() {}
  };
  loadStageFunctions(['mkTimelineDomain', 'mkSetQuestionTime'], context);

  context.mkSetQuestionTime(0, 0, 500);
  assert.equal(context.mk.videos[0].questions[0].t, 500);
  context.mkSetQuestionTime(0, 0, 999);
  assert.equal(context.mk.videos[0].questions[0].t, 630);
});

test('종료 시각이 없는 타임라인 드래그는 렌더와 같은 미확정 구간을 원본 초로 역산한다', () => {
  const listeners = {};
  let setTime;
  const timeline = { getBoundingClientRect() { return { left: 100, width: 600 }; } };
  const context = {
    mk: { videos: [{ startSec: 100, endSec: null, durationSec: null, questions: [{ t: 300 }] }] },
    document: {
      addEventListener(name, listener) { listeners[name] = listener; },
      removeEventListener() {}
    },
    mkSetQuestionTime(videoIndex, questionIndex, value) { setTime = [videoIndex, questionIndex, value]; }
  };
  loadStageFunctions(['mkTimelineDomain', 'mkStartQuestionDrag'], context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.mkTimelineDomain(context.mk.videos[0]))), {
    start: 100, end: 700, max: 700
  });
  context.mkStartQuestionDrag({ currentTarget: { parentElement: timeline }, preventDefault() {} }, 0, 0);
  listeners.pointermove({ clientX: 400 });

  assert.deepEqual(setTime, [0, 0, 400]);
});

test('늦게 확인한 영상 길이는 종료 입력·손잡이 max·문항 점을 즉시 갱신한다', () => {
  const elements = new Map();
  const dot = { style: {} };
  const timeline = { querySelectorAll() { return [dot]; } };
  const selector = key => {
    if (key === '[data-timeline-video="0"]') return timeline;
    if (!elements.has(key)) elements.set(key, { value: '', max: '' });
    return elements.get(key);
  };
  const context = {
    mk: { videos: [{ startSec: 0, endSec: null, durationSec: null, questions: [{ t: 60 }] }] },
    document: { querySelector: selector },
    PlaylistCore: require('../playlist-core.js'),
    fmtTime(value) { return value === 120 ? '2:00' : '0:00'; }
  };
  loadStageFunctions(['mkTimelineDomain', 'mkRefreshVideoTiming', 'mkApplyDuration'], context);

  context.mkApplyDuration(0, 120);

  assert.equal(elements.get('[data-range-input="0-end"]').value, '');
  assert.equal(elements.get('[data-range-slider="0-start"]').max, 120);
  assert.equal(elements.get('[data-range-slider="0-end"]').max, 120);
  assert.equal(elements.get('[data-range-slider="0-end"]').value, 120);
  assert.equal(dot.style.left, '50%');
});

test('처리 중인 이미지 업로드는 재정렬 뒤에도 원래 문항에만 적용되고 삭제 뒤에는 폐기된다', async () => {
  const pending = [];
  const first = { text: 'A', _img: '' }, second = { text: 'B', _img: '' };
  const context = {
    mk: { videos: [{ questions: [first, second] }] },
    prepareImage() { return new Promise(resolve => pending.push(resolve)); },
    toast() {}, mkMarkDirty() {}, renderMake() {},
    console, alert(message) { throw new Error(message); }, Math
  };
  loadStageFunctions(['mkUploadImage'], context);
  const inputA = { files: [{ name: 'a.png' }], value: 'a' };
  const uploadA = context.mkUploadImage(0, 0, inputA);
  context.mk.videos[0].questions.reverse();
  pending.shift()('image-a');
  await uploadA;

  assert.equal(first._img, 'image-a');
  assert.equal(second._img, '');

  const inputB = { files: [{ name: 'b.png' }], value: 'b' };
  const uploadB = context.mkUploadImage(0, 0, inputB);
  context.mk.videos[0].questions.splice(0, 1);
  pending.shift()('image-b');
  await uploadB;

  assert.equal(second._img, '');
});

test('저장 검증은 모든 영상의 재생 구간 오류에 영상 번호를 붙인다', () => {
  const context = {
    mk: {
      title: '세트', videos: [
        { videoId: 'a', startSec: 0, endSec: 60, durationSec: 60,
          questions: [{ type: 'long', t: 20, text: 'A', choices: [] }] },
        { videoId: 'b', startSec: 30, endSec: 60, durationSec: 90,
          questions: [{ type: 'long', t: 20, text: 'B', choices: [] }] }
      ]
    },
    PlaylistCore: require('../playlist-core.js'), qType(q) { return q.type; }
  };
  loadStageFunctions(['mkValidate'], context);

  assert.equal(context.mkValidate(), '영상 2: 1번 문항이 재생 구간 밖에 있습니다.');
});

test('이미지가 없는 편집 저장도 빈 이미지 집합으로 교체한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    mk: { id: 'set1', ownerUid: 'teacher-1', saved: false, questions: [] },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '수정', questions: [{ text: '문항' }] }, images: {} }; },
    rid() { return 'new-id'; },
    SV_TS: { kind: 'timestamp' },
    store: {
      async saveOwnedQuizSet(id, data, images, teacher) {
        calls.push(['saveOwned', id, clone(data), clone(images), clone(teacher)]);
      }
    },
    toast() {},
    normQuestions(value) { return clone(value); },
    imgCache: {},
    location: { hash: '#/make/set1' },
    history: { replaceState() {} },
    renderMake() {},
    mkSetSaveStatus() {},
    mkClearDraft() {},
    mkPersistDraft() {},
    Date,
    $() { return null; },
    alert(message) { throw new Error(message); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'mkSave'), context);

  await context.mkSave(false);

  assert.deepEqual(calls, [
    ['saveOwned', 'set1', { title: '수정', questions: [{ text: '문항' }] }, {},
      { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' }]
  ]);
});

test('편집 저장은 현재 교사 상태를 소유권 저장 API에 전달한다', async () => {
  const calls = [];
  const context = {
    mk: { id: 'set1', ownerUid: 'teacher-1', saved: false, questions: [] },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '수정', questions: [] }, images: {} }; },
    rid() { return 'new-id'; }, SV_TS: {},
    store: {
      async saveOwnedQuizSet(id, value, images, teacher) {
        calls.push([id, clone(value), clone(images), clone(teacher)]);
      }
    },
    toast() {}, normQuestions(value) { return value; }, imgCache: {},
    location: { hash: '#/make/set1' }, history: { replaceState() {} },
    renderMake() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    $() { return null; }, Date, console,
    alert(message) { throw new Error(message); }
  };
  loadStageFunctions(['mkSave'], context);

  await context.mkSave(false);

  assert.deepEqual(calls, [[
    'set1', { title: '수정', questions: [] }, {},
    { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' }
  ]]);
});

test('읽기 전용 세트는 단축키를 포함한 저장 진입점에서 쓰기를 차단한다', async () => {
  let writes = 0;
  const notices = [];
  const context = {
    mk: { id: 'shared-1', readOnly: true },
    teacherState: null,
    mkValidate() { throw new Error('읽기 전용 세트는 검증에도 들어가면 안 된다'); },
    store: { async saveOwnedQuizSet() { writes += 1; } },
    toast(message) { notices.push(message); }
  };
  loadStageFunctions(['mkSave'], context);

  await context.mkSave(false);

  assert.equal(writes, 0);
  assert.deepEqual(notices, ['읽기 전용 세트는 원본을 저장할 수 없습니다. 사본을 만들어 주세요.']);
});

test('열어 둔 편집기의 소유 교사 승인이 취소되면 저장소 호출 전에 쓰기를 차단한다', async () => {
  let writes = 0;
  const notices = [];
  const context = {
    mk: { id: 'owned-1', ownerUid: 'teacher-1', saved: false },
    teacherState: {
      status: 'unapproved', uid: 'teacher-1', email: 'teacher1@school.kr', role: ''
    },
    AuthCore: require('../auth-core.js'),
    mkValidate() { throw new Error('권한이 없으면 payload 검증 전 차단해야 한다'); },
    store: { async saveOwnedQuizSet() { writes += 1; } },
    toast(message) { notices.push(message); }
  };
  loadStageFunctions(['mkSave'], context);

  await context.mkSave(false);

  assert.equal(writes, 0);
  assert.equal(context.mk.readOnly, true);
  assert.deepEqual(notices, ['읽기 전용 세트는 원본을 저장할 수 없습니다. 사본을 만들어 주세요.']);
});

test('열어 둔 편집기의 교사 계정이 교체되면 새 세트로 저장도 차단한다', async () => {
  let writes = 0;
  const context = {
    mk: { id: 'owned-1', ownerUid: 'teacher-1', saved: false },
    teacherState: {
      status: 'teacher', uid: 'teacher-2', email: 'teacher2@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '사본' }, images: {} }; },
    rid() { return 'new-copy'; }, SV_TS: {},
    store: { async saveOwnedQuizSet() { writes += 1; } },
    toast() {}, mkSetSaveStatus() {}, normQuestions(value) { return value; },
    imgCache: {}, location: { hash: '' }, history: { replaceState() {} },
    renderMake() {}, mkClearDraft() {}, mkPersistDraft() {}, $() { return null; },
    Date, console, alert() {}
  };
  loadStageFunctions(['mkSave'], context);

  await context.mkSave(true);

  assert.equal(writes, 0);
  assert.equal(context.mk.readOnly, true);
});

test('Ctrl+S는 브라우저 저장을 막고 편집 화면의 정식 저장을 한 번 실행한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let saves = 0;
  const context = { mk: {}, mkSave() { saves += 1; } };
  vm.runInNewContext(extractFunction(html, 'mkHandleSaveShortcut'), context);
  const event = {
    key: 's', ctrlKey: true, metaKey: false, prevented: false,
    preventDefault() { this.prevented = true; }
  };

  context.mkHandleSaveShortcut(event);

  assert.equal(event.prevented, true);
  assert.equal(saves, 1);
});

test('편집 변경은 로컬 초안을 남기고 정식 저장 성공 뒤 삭제한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    mk: { id: 'set1', ownerUid: 'teacher-1', saved: false, questions: [] },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    localStorage: {},
    EditorDraft: {
      write(storage, id) { calls.push(['draft', id]); },
      clear(storage, id) { calls.push(['clear', id]); }
    },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '수정', questions: [] }, images: {} }; },
    rid() { return 'new-id'; }, SV_TS: {},
    store: { async saveOwnedQuizSet() {} },
    toast() {}, normQuestions(value) { return value; }, imgCache: {},
    location: { hash: '#/make/set1' }, history: { replaceState() {} },
    renderMake() {}, $() { return null; }, console, alert() {},
    clearTimeout() {}, setTimeout(fn) { fn(); return 1; }, Date,
    mkDraftTimer: null, mkSetSaveStatus() {}
  };
  vm.runInNewContext(extractFunction(html, 'mkPersistDraft'), context);
  vm.runInNewContext(extractFunction(html, 'mkClearDraft'), context);
  vm.runInNewContext(extractFunction(html, 'mkMarkDirty'), context);
  vm.runInNewContext(extractFunction(html, 'mkSave'), context);

  context.mkMarkDirty();
  await context.mkSave(false);

  assert.deepEqual(calls, [['draft', 'set1'], ['clear', 'set1']]);
});

test('영상 배열 중심 편집 초안은 모든 영상의 현재 값을 함께 보존한다', () => {
  let savedModel;
  const context = {
    mk: {
      id: 'set1', title: '세트', activeVideo: 0,
      videos: [
        { videoId: 'a-new', videoUrl: 'url-a-new', questions: [{ text: '수정 문항' }] },
        { videoId: 'b', videoUrl: 'url-b', questions: [{ text: '둘째 영상 문항' }] }
      ]
    },
    localStorage: {}, Date,
    EditorDraft: { write(storage, id, model) { savedModel = clone(model); } }
  };
  loadStageFunctions(['mkPersistDraft'], context);

  context.mkPersistDraft();

  assert.deepEqual(JSON.parse(JSON.stringify(savedModel.videos.map(video => ({
    videoId: video.videoId, videoUrl: video.videoUrl,
    questions: video.questions.map(question => question.text)
  })))), [
    { videoId: 'a-new', videoUrl: 'url-a-new', questions: ['수정 문항'] },
    { videoId: 'b', videoUrl: 'url-b', questions: ['둘째 영상 문항'] }
  ]);
});

test('두 번째 Ctrl+S는 첫 저장 뒤 수정한 문항 값을 다시 저장한다', async () => {
  const saved = [];
  const context = {
    mk: {
      id: 'set1', ownerUid: 'teacher-1', title: '세트', author: '', settings: {}, createdAt: 10,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: '첫 값', choices: [] }] }],
      activeVideo: 0, saved: false
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type; }, normSettings(value) { return value; },
    mkValidate() { return ''; }, rid() { return 'new-id'; }, SV_TS: {},
    store: {
      async saveOwnedQuizSet(id, value) { saved.push(clone(value)); }
    },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set1' }, history: { replaceState() {} },
    renderMake() {}, $() { return null; }, Date, console, alert() {}
  };
  loadStageFunctions(['mkPayload', 'mkSave', 'mkHandleSaveShortcut'], context);
  const shortcut = () => ({
    key: 's', ctrlKey: true, metaKey: false, preventDefault() {}
  });

  context.mkHandleSaveShortcut(shortcut());
  await new Promise(resolve => setImmediate(resolve));
  context.mk.videos[0].questions[0].text = '두 번째 값';
  context.mkHandleSaveShortcut(shortcut());
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(saved.map(value => value.videos[0].questions[0].text), ['첫 값', '두 번째 값']);
});

test('문항 추가처럼 입력 이벤트가 없는 편집도 로컬 초안을 갱신한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let dirty = 0;
  const context = {
    mk: { videos: [{ startSec: 0, endSec: null, questions: [{ t: 10 }] }] },
    blankQuestion(t) { return { t }; },
    renderMake() {}, mkFocusQuestion() {}, mkMarkDirty() { dirty += 1; }
  };
  vm.runInNewContext(extractFunction(html, 'mkAddQuestion'), context);

  context.mkAddQuestion(0);

  assert.equal(dirty, 1);
});

test('세트 목록을 떠난 뒤 늦게 온 Firestore 결과가 다음 화면을 덮어쓰지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let finishList;
  let cleanup;
  let rendered = 0;
  const app = { innerHTML: '' };
  const context = {
    setList: null,
    store: { listQuizSets: () => new Promise(resolve => { finishList = resolve; }) },
    onCleanup(fn) { cleanup = fn; },
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    normSet(value) { return value; },
    renderSetList() { rendered += 1; },
    esc(value) { return value; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'screenSetList'), context);

  context.screenSetList();
  cleanup();
  app.innerHTML = '<main>새 화면</main>';
  finishList([{ id: 'late', title: '늦은 세트' }]);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(app.innerHTML, '<main>새 화면</main>');
  assert.equal(rendered, 0);
});

test('세트 목록 행은 신구 영상 구조와 표시 상태를 안전하게 렌더링한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const escapeHtml = value => String(value).replace(/[&<>]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;'
  })[ch]);
  const context = {
    PlaylistCore: require('../playlist-core.js'),
    AuthCore: require('../auth-core.js'),
    REVEAL_LABEL: { timer: '타이머 종료 후 자동' },
    teacherState: { uid: 'teacher-1', role: 'teacher' },
    esc: escapeHtml,
    fmtDate() { return ''; },
    linkTo(value) { return value; }
  };
  loadStageFunctions(['canEditSet', 'setListRow'], context);

  const cases = [
    {
      name: '신형 다중 영상',
      set: {
        id: 'playlist', title: '두 영상', author: '', archived: false,
        settings: { revealMode: 'timer' },
        videos: [
          { questions: [{ text: '1' }, { text: '2' }] },
          { questions: [{ text: '3' }] }
        ]
      },
      matches: [/영상 2개 · 문항 3개/]
    },
    {
      name: '구형 최상위 단일 영상',
      set: {
        id: 'legacy', title: '이전 세트', author: '', archived: false,
        settings: { revealMode: 'timer' },
        videoId: 'legacy-id', questions: [{ text: '1' }, { text: '2' }]
      },
      matches: [/영상 1개 · 문항 2개/]
    },
    {
      name: '빈 영상 배열',
      set: {
        id: 'empty', title: '빈 세트', author: '', archived: false,
        settings: { revealMode: 'timer' }, videos: []
      },
      matches: [/영상 1개 · 문항 0개/]
    },
    {
      name: '제목과 작성자 이스케이프',
      set: {
        id: 'escaped', title: '<script>', author: 'A&B', archived: false,
        settings: { revealMode: 'timer' }, videos: [{ questions: [] }]
      },
      matches: [/&lt;script&gt;/, /A&amp;B/],
      rejects: [/<script>/, /A&B/]
    },
    {
      name: '숨김 표시',
      set: {
        id: 'archived', title: '숨긴 세트', author: '', archived: true,
        settings: { revealMode: 'timer' }, videos: [{ questions: [] }]
      },
      matches: [/opacity:.6/, /<span class="tag mute"[^>]*>숨김<\/span>/]
    }
  ];

  for (const item of cases) {
    const row = context.setListRow(item.set);
    for (const pattern of item.matches) assert.match(row, pattern, item.name);
    for (const pattern of item.rejects || []) assert.doesNotMatch(row, pattern, item.name);
  }
});

test('세트 목록은 소유자만 편집·숨김을 표시하고 공유·이전 세트는 시작·사본만 표시한다', () => {
  const context = {
    PlaylistCore: require('../playlist-core.js'),
    AuthCore: require('../auth-core.js'),
    REVEAL_LABEL: { timer: '타이머 종료 후 자동' },
    teacherState: { uid: 'owner-1', role: 'teacher' },
    esc(value) { return String(value); },
    fmtDate() { return ''; },
    linkTo(value) { return value; }
  };
  loadStageFunctions(['canEditSet', 'setListRow'], context);
  const base = {
    id: 'set-1', title: '공유 세트', author: '', archived: false,
    settings: { revealMode: 'timer' }, videos: [{ questions: [] }]
  };

  const owned = context.setListRow({ ...base, ownerUid: 'owner-1' });
  assert.match(owned, /편집/);
  assert.match(owned, /숨기기/);

  const shared = context.setListRow({ ...base, ownerUid: 'other-1' });
  assert.match(shared, /우리 반 시작하기/);
  assert.match(shared, /사본 만들기/);
  assert.doesNotMatch(shared, /편집|숨기기|다시 표시|📤 파일|🔗 링크/);

  context.teacherState = { uid: 'admin-1', role: 'admin' };
  const adminShared = context.setListRow({ ...base, ownerUid: 'other-1' });
  assert.doesNotMatch(adminShared, /편집|숨기기|다시 표시/);

  const legacy = context.setListRow(base);
  assert.match(legacy, /읽기 전용/);
  assert.match(legacy, /우리 반 시작하기/);
  assert.match(legacy, /사본 만들기/);
  assert.doesNotMatch(legacy, /편집|숨기기|다시 표시|📤 파일|🔗 링크/);
});

test('공유 세트 진행 화면은 시작·사본만 제공하고 소유자에게만 편집 링크를 표시한다', () => {
  const app = { innerHTML: '' };
  const context = {
    teacherState: { uid: 'teacher-1', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    pl: {
      setId: 'shared-1',
      set: {
        title: '공유 세트', ownerUid: 'teacher-2', author: '',
        settings: { revealMode: 'timer', limitSec: 20 },
        videos: [{ questions: [] }]
      },
      flatQuestions: [{ t: 1, text: '문항', answer: 0 }]
    },
    APP() { return app; }, topbar(extra) { return '<nav>' + (extra || '') + '</nav>'; },
    esc(value) { return String(value); }, REVEAL_LABEL: { timer: '타이머' },
    lsGet() { return ''; }, fmtTime() { return '00:01'; }, LETTERS: ['A']
  };
  loadStageFunctions(['canEditSet', 'renderPlayIntro'], context);

  context.renderPlayIntro();
  assert.match(app.innerHTML, /우리 반 시작하기/);
  assert.match(app.innerHTML, /사본 만들기/);
  assert.doesNotMatch(app.innerHTML, /세트 편집/);

  context.pl.set.ownerUid = 'teacher-1';
  context.renderPlayIntro();
  assert.match(app.innerHTML, /세트 편집/);
});

test('비소유 세트는 숨김 진입점을 직접 호출해도 저장소를 변경하지 않는다', () => {
  let writes = 0;
  const notices = [];
  const context = {
    teacherState: { uid: 'teacher-1', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    setList: { all: [{ id: 'shared-1', ownerUid: 'teacher-2', archived: true }] },
    store: { patchQuizSet() { writes += 1; return Promise.resolve(); } },
    confirm() { return true; }, toast(message) { notices.push(message); },
    renderSetList() {}, console, alert() {}
  };
  loadStageFunctions(['canEditSet', 'setArchive'], context);

  context.setArchive('shared-1', false);

  assert.equal(writes, 0);
  assert.deepEqual(notices, ['소유한 세트만 숨김 상태를 바꿀 수 있습니다.']);
});

test('공동 편집자는 서버 재검증 후 공동 편집 저장 API로 저장한다', async () => {
  const calls = [];
  const context = {
    mk: { id: 'set1', ownerUid: 'owner', saved: false, questions: [] },
    teacherState: { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, AuthCore: require('../auth-core.js'),
    mkValidate() { return ''; }, mkPayload() { return { set: { title: '공동 수정', questions: [] }, images: {} }; },
    rid() { return 'new'; }, SV_TS: {},
    store: {
      async canEditQuizSet(id, actor) { calls.push(['check', id, actor.uid]); return true; },
      async saveQuizSetWithImages(id, value, images, actor) { calls.push(['save', id, value.title, actor.uid]); },
      async saveOwnedQuizSet() { throw new Error('owner-only API must not be used'); }
    },
    toast() {}, normQuestions(value) { return value; }, imgCache: {}, location: { hash: '#/make/set1' },
    history: { replaceState() {} }, renderMake() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    $() { return null; }, Date, console, alert(message) { throw new Error(message); }
  };
  loadStageFunctions(['mkSave'], context);
  await context.mkSave(false);
  assert.deepEqual(calls, [['check', 'set1', 'editor'], ['save', 'set1', '공동 수정', 'editor']]);
});

test('공동 편집자와 휴지통 상태에 맞는 목록 행 동작을 표시한다', () => {
  const context = {
    PlaylistCore: require('../playlist-core.js'),
    AuthCore: require('../auth-core.js'),
    REVEAL_LABEL: { timer: '타이머' },
    teacherState: { uid: 'owner', email: 'owner@school.kr', role: 'teacher' },
    esc(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]); },
    fmtDate() { return ''; },
    linkTo(value) { return value; }
  };
  loadStageFunctions(['canEditSet', 'setListRow'], context);
  const base = { id: 'set-1', title: '공유 세트', ownerUid: 'owner', ownerEmail: 'owner@school.kr', archived: false,
    trashedAt: null, purgeStartedAt: null, settings: { revealMode: 'timer' }, videos: [{ questions: [] }] };
  const owned = context.setListRow(base);
  assert.match(owned, /공동 편집자/);
  assert.match(owned, /휴지통/);
  const collaborator = context.setListRow({ ...base, ownerUid: 'other', collaboratorEmails: ['owner@school.kr'] });
  assert.match(collaborator, /공동 편집/);
  assert.match(collaborator, /편집/);
  assert.doesNotMatch(collaborator, /공동 편집자 관리|휴지통으로 이동/);
  const other = context.setListRow({ ...base, ownerUid: 'other', collaboratorEmails: [] });
  assert.match(other, /우리 반 시작하기/);
  assert.match(other, /사본 만들기/);
  assert.doesNotMatch(other, /href="#\/make\/|휴지통/);
  const trashed = context.setListRow({ ...base, trashedAt: 1, lifecycleState: 'trashed' });
  assert.match(trashed, /휴지통/);
  assert.match(trashed, /복원/);
  assert.match(trashed, /영구 삭제/);
});

test('휴지통 화면은 보관 기간과 복원·입력 확인 영구 삭제를 표시한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {
    setList: null, teacherState: { uid: 'owner', email: 'owner@school.kr', role: 'teacher' },
    store: {}, APP() { return { innerHTML: '' }; }, topbar(extra) { return '<nav>' + (extra || '') + '</nav>'; },
    onCleanup() {}, esc(value) { return String(value); }, fmtDate() { return ''; }, toast() {}, console
  };
  loadStageFunctions(['setPurgeNow', 'screenTrash'], context);
  assert.equal(typeof context.screenTrash, 'function');
  assert.equal(typeof context.setPurgeNow, 'function');
});

test('휴지통 행은 삭제일·30일 자동 삭제일·남은 기간을 표시한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {
    PlaylistCore: require('../playlist-core.js'), AuthCore: require('../auth-core.js'),
    REVEAL_LABEL: { timer: '타이머' }, teacherState: { uid: 'owner', email: 'owner@school.kr', role: 'teacher' },
    esc(value) { return String(value); }, fmtDate(value) { return String(value); }, linkTo(value) { return value; }
  };
  loadStageFunctions(['canEditSet', 'uiTrashMillis', 'trashDates', 'setListRow'], context);
  const deleted = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const row = context.setListRow({ id: 'old', title: '보관 세트', ownerUid: 'owner', trashedAt: deleted,
    lifecycleState: 'trashed', settings: { revealMode: 'timer' }, videos: [{ questions: [] }] });
  assert.match(row, /삭제일/);
  assert.match(row, /자동 삭제 예정/);
  assert.match(row, /남은 기간/);
});

test('휴지통 목록은 trashed와 purging 세트를 함께 반환한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/a': { ownerUid: 'owner', lifecycleState: 'trashed', trashedAt: 1 },
    'quiz_sets/b': { ownerUid: 'owner', lifecycleState: 'purging', trashedAt: 1, purgeStartedAt: 2 }
  });
  const store = createStore(fake);
  assert.deepEqual((await store.listTrash({ ownerUid: 'owner' })).map(set => set.id).sort(), ['a', 'b']);
});

test('세트 숨김 상태 변경은 actor를 전달한 경우 소유자만 허용한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'active', collaboratorCount: 0, imageCount: 0 }
  });
  const store = createStore(fake);
  await assert.rejects(() => store.patchQuizSet('set1', { archived: true }, { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }), /소유자만/);
  await store.patchQuizSet('set1', { archived: true }, { uid: 'owner', email: 'owner@school.kr', role: 'teacher' });
  assert.equal(fake.value('quiz_sets/set1').archived, true);
});

test('공동 편집자 저장 권한 상실은 JSON 내보내기 선택 후 초안을 지우고 목록으로 보낸다', async () => {
  const events = [];
  const context = {
    mk: { id: 'set1', ownerUid: 'owner', saved: false, questions: [] },
    teacherState: { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, AuthCore: require('../auth-core.js'),
    mkValidate() { return ''; }, mkPayload() { return { set: { title: '로컬 수정' }, images: {} }; },
    store: { async canEditQuizSet() { return true; }, async saveQuizSetWithImages() { throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' }); } },
    toast(message) { events.push(['toast', message]); }, mkSetSaveStatus() {}, mkPersistDraft() {}, mkClearDraft(id) { events.push(['clear', id]); },
    normQuestions(value) { return value; }, imgCache: {}, location: { hash: '#/make/set1' }, history: { replaceState() {} }, renderMake() {}, $() { return null; },
    confirm() { return true; }, downloadBlob() { events.push(['export']); }, safeFileName(value) { return value; }, Blob, go(hash) { events.push(['go', hash]); }, console,
    alert() {}
  };
  loadStageFunctions(['mkHandlePermissionLoss', 'mkSave'], context);
  await context.mkSave(false);
  assert.deepEqual(events.filter(event => ['export', 'clear', 'go'].includes(event[0])), [['export'], ['clear', 'set1'], ['go', 'sets']]);
  assert.equal(context.mk.readOnly, true);
});

test('공동 편집자의 다른 세트로 복제 저장은 원본 ID를 쓰지 않는다', async () => {
  const calls = [];
  const context = {
    mk: { id: 'source', ownerUid: 'owner', saved: true, questions: [] },
    teacherState: { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, AuthCore: require('../auth-core.js'),
    mkValidate() { return ''; }, mkPayload() { return { set: { title: '복제본', questions: [] }, images: {} }; },
    rid() { return 'copy-id'; }, SV_TS: {},
    store: {
      async canEditQuizSet() { return true; },
      async saveOwnedQuizSet(id, value, images, actor) { calls.push(['owned', id, actor.uid]); },
      async saveQuizSetWithImages() { throw new Error('source overwrite'); }
    }, toast() {}, normQuestions(value) { return value; }, imgCache: {}, location: { hash: '#/make/source' },
    history: { replaceState() {} }, renderMake() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {}, $() { return null; }, Date, console,
    alert(message) { throw new Error(message); }
  };
  loadStageFunctions(['mkSave'], context);
  await context.mkSave(true);
  assert.deepEqual(calls, [['owned', 'copy-id', 'editor']]);
  assert.equal(context.mk.id, 'copy-id');
});

test('편집기 실시간 권한 감시는 휴지통 전환을 한 번만 처리하고 구독을 해제한다', async () => {
  const app = { innerHTML: '' }; const callbacks = []; const stopped = []; let losses = 0;
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, AuthCore: require('../auth-core.js'),
    lsGet() { return ''; }, DEFAULT_SETTINGS: {}, blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {} },
    mkHandleSaveShortcut() {}, onCleanup() {}, clearTimeout() {}, every() {}, $() { return null; }, APP() { return app; }, topbar() { return ''; },
    esc(value) { return String(value); }, normSet(value) { return value; }, mkRestoreDraft() {}, renderMake() {}, toast() {}, console,
    store: {
      async getQuizSet() { return { title: '공유', ownerUid: 'owner', ownerEmail: 'owner@school.kr', settings: {}, videos: [{ questions: [] }] }; },
      async canEditQuizSet() { return true; }, async getImages() { return {}; },
      subscribeDoc(path, next) { callbacks.push({ path, next }); return () => stopped.push(path); }
    },
    mkHandlePermissionLoss() { losses += 1; },
    setInterval() {}, setTimeout() {}, Date
  };
  loadStageFunctions(['canEditSet', 'screenMake'], context);
  context.screenMake('set1');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  const parent = callbacks.find(item => item.path === 'quiz_sets/set1');
  assert.ok(parent);
  parent.next({ ownerUid: 'owner', lifecycleState: 'purging', purgeStartedAt: 2 });
  parent.next({ ownerUid: 'owner', lifecycleState: 'purging', purgeStartedAt: 2 });
  assert.equal(losses, 1);
  assert.ok(stopped.includes('quiz_sets/set1'));
});

test('학생 live 구독은 정확히 한 문서를 구독하고 해제할 수 있다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': { id: 'payload-live', q: 2, revealed: false }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
  let received;
  const stop = store.subscribeDoc('sessions/a/meta/live', value => { received = value; });
  await fake.flush();
  assert.deepEqual(received, { id: 'live', q: 2, revealed: false });
  stop();
  fake.emit('sessions/a/meta/live', { q: 3 });
  await fake.flush();
  assert.deepEqual(received, { id: 'live', q: 2, revealed: false });
  assert.deepEqual(fake.subscribedPaths(), ['sessions/a/meta/live']);
});

test('문서와 컬렉션 CRUD는 Firestore 데이터를 화면용 객체로 반환한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'quiz_sets/a': { id: 'payload-a', title: '첫 세트', archived: false },
    'quiz_sets/b': { title: '둘째 세트', archived: true }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);

  assert.deepEqual(await store.getDoc('quiz_sets/a'), {
    id: 'a', title: '첫 세트', archived: false
  });
  assert.equal(await store.getDoc('quiz_sets/missing'), null);
  assert.deepEqual(await store.getCollection('quiz_sets'), {
    a: { id: 'payload-a', title: '첫 세트', archived: false },
    b: { title: '둘째 세트', archived: true }
  });

  await store.setDoc('quiz_sets/c', { title: '셋째 세트', settings: { shuffle: false } });
  await store.mergeDoc('quiz_sets/c', { archived: true });
  assert.deepEqual(fake.value('quiz_sets/c'), {
    title: '셋째 세트', settings: { shuffle: false }, archived: true
  });
  await store.deleteDoc('quiz_sets/c');
  assert.equal(fake.has('quiz_sets/c'), false);
});

test('컬렉션 구독은 문서 ID별 객체를 갱신하고 해제 후에는 멈춘다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({ 'sessions/a/students/s1': { name: '가' } });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
  const received = [];
  const stop = store.subscribeCollection('sessions/a/students', value => received.push(value));
  await fake.flush();
  assert.deepEqual(received, [{ s1: { name: '가' } }]);

  fake.emit('sessions/a/students/s2', { name: '나' });
  await fake.flush();
  assert.deepEqual(received.at(-1), { s1: { name: '가' }, s2: { name: '나' } });
  stop();
  fake.emit('sessions/a/students/s3', { name: '다' });
  await fake.flush();
  assert.equal(received.length, 2);
  assert.deepEqual(fake.subscribedPaths(), ['sessions/a/students']);
});

test('구독 오류를 호출자가 제공한 오류 처리기에 전달한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake();
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
  let receivedError;
  const stop = store.subscribeDoc('sessions/a/meta/live', () => {}, error => { receivedError = error; });
  const failure = new Error('permission-denied');
  fake.fail('sessions/a/meta/live', failure);
  assert.equal(receivedError, failure);
  stop();
});

test('서버 Timestamp를 되읽어 오프셋을 캐시하고 임시 문서를 삭제한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({}, { committedServerMillis: 10_250 });
  const times = [10_000, 10_100];
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => times.shift() ?? 10_100);
  await store.syncClock('clock/sample-a');
  assert.equal(store.serverNow(), 10_300);
  assert.equal(fake.has('clock/sample-a'), false);
  assert.deepEqual(fake.calls().map(call => [call.operation, call.path]).filter(([, path]) => path), [
    ['set', 'clock/sample-a'],
    ['get', 'clock/sample-a'],
    ['delete', 'clock/sample-a']
  ]);
});

test('이미 존재하는 반 코드는 덮어쓰지 않는다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'codes/ABC234': { sessionId: 'old' },
    'quiz_sets/set1': { lifecycleState: 'active' }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1_000);
  assert.equal(await store.claimSessionCode('ABC234', 'new', { setId: 'set1' }), false);
  assert.deepEqual(fake.value('codes/ABC234'), { sessionId: 'old' });
  assert.equal(fake.has('sessions/new'), false);
  assert.equal(fake.calls().some(call => call.operation === 'transactionSet'), false);
});

test('빈 반 코드는 소유 교사 정보와 함께 한 트랜잭션에서 코드·세션·live·board를 초기화한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      ownerUid: 'teacher-1', ownerEmail: 'teacher@school.kr', lifecycleState: 'active'
    },
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  }, { committedServerMillis: 20_000 });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1_000);
  const session = {
    setId: 'set1', label: '3학년 2반', status: 'active',
    teacherUid: 'teacher-1', teacherEmail: 'teacher@school.kr'
  };

  assert.equal(await store.claimSessionCode('ABC234', 'new', session), true);
  const codeDocument = fake.value('codes/ABC234');
  assert.equal(codeDocument.sessionId, 'new');
  assert.equal(codeDocument.createdAt.toMillis(), 20_000);
  assert.deepEqual(fake.value('sessions/new'), { ...session, status: 'allocating' });
  assert.deepEqual(fake.value('sessions/new/meta/live'), {
    q: -1, openedAt: 0, revealed: false, limitSec: 0
  });
  assert.deepEqual(fake.value('sessions/new/meta/board'), { scores: {} });
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 1);
});

test('세션 시작은 충돌한 후보를 건너뛰고 열 개 안에서 선점한 코드를 반환한다', async () => {
  const fake = makeFirestoreFake({
    'codes/OLD234': { sessionId: 'old' },
    'quiz_sets/set1': { ownerUid: 'owner-uid', ownerEmail: 'owner@school.kr', trashedAt: null, purgeStartedAt: null }
  });
  const store = createStore(fake);
  const candidates = ['OLD234', 'NEW234'];
  const session = { setId: 'set1', status: 'live' };

  const code = await store.startSession('new', session, () => candidates.shift());

  assert.equal(code, 'NEW234');
  assert.deepEqual(fake.value('sessions/new'), {
    ...session, status: 'allocating', code: 'NEW234'
  });
  assert.equal(fake.value('codes/NEW234').sessionId, 'new');
});

test('세션 allocation은 처음에는 입장 불가이며 exact code·owner CAS 뒤에만 live가 된다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { ownerUid: 'owner-uid', ownerEmail: 'owner@school.kr', trashedAt: null, purgeStartedAt: null },
    'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' }
  });
  const store = createStore(fake);

  const code = await store.startSession('session-a', {
    setId: 'set1', status: 'live', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr'
  }, () => 'ABC234');

  assert.equal(code, 'ABC234');
  assert.equal(fake.value('sessions/session-a').status, 'allocating');
  assert.equal(await store.activateSessionAllocation(
    'session-a', 'ABC234', 'owner-uid'
  ), true);
  assert.equal(fake.value('sessions/session-a').status, 'live');
  assert.equal(await store.activateSessionAllocation(
    'session-a', 'WRONG1', 'owner-uid'
  ), false);
});

test('allocation과 heartbeat lease는 호출 시작의 보정 서버 시각에 고정된다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  let now = 60_000;
  let moveClockDuringRenew = false;
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { ownerUid: 'teacher-1', ownerEmail: 'teacher@school.kr', trashedAt: null, purgeStartedAt: null },
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  }, {
    committedServerMillis: 999_999,
    beforeTransactionGet(path) {
      if (moveClockDuringRenew && path === 'sessions/leased-session') now = 600_000;
    }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => now);
  const token = 'allocation-token-123456';

  assert.equal(await store.startSession('leased-session', {
    setId: 'set1', status: 'live', teacherUid: 'teacher-1',
    teacherEmail: 'teacher@school.kr', allocationToken: token
  }, () => 'LEASE1'), 'LEASE1');
  assert.equal(fake.value('sessions/leased-session').allocationToken, undefined);
  assert.deepEqual(fake.value('sessions/leased-session/meta/allocation'), {
    token, ownerUid: 'teacher-1'
  });

  assert.equal(await store.activateSessionAllocation(
    'leased-session', 'LEASE1', 'teacher-1', 'wrong-token'
  ), false);
  assert.equal(await store.activateSessionAllocation(
    'leased-session', 'LEASE1', 'teacher-1', token
  ), true);
  assert.equal(fake.value('sessions/leased-session').status, 'live');
  assert.equal(fake.value('sessions/leased-session').activationLeaseUntil.getTime(), 75_000);

  now = 70_000;
  moveClockDuringRenew = true;
  assert.equal(await store.renewSessionActivationLease(
    'leased-session', 'LEASE1', 'teacher-1', token
  ), true);
  assert.equal(fake.value('sessions/leased-session').activationLeaseUntil.getTime(), 85_000);
});

test('allocation abort는 code를 CAS 삭제한 뒤 모든 생성 문서를 지우며 부분 실패를 재시도한다', async () => {
  const fake = makeFirestoreFake({
    'codes/ABC234': { sessionId: 'session-a' },
    'sessions/session-a': {
      code: 'ABC234', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'live'
    },
    'sessions/session-a/meta/live': { q: -1 },
    'sessions/session-a/meta/board': { scores: {} },
    'sessions/session-a/snapshot/set': { videos: [{ questions: [] }] },
    'sessions/session-a/snapshot_images/v0q0': { data: 'image' },
    'sessions/session-a/students/student-a': { uid: 'student-a' },
    'sessions/session-a/responses/student-a': { uid: 'student-a', answers: {} },
    'sessions/session-a/grades/student-a__0': {
      uid: 'student-a', questionIndex: 0, revision: 1, ok: true
    },
    'sessions/session-a/student_scores/student-a': { correct: 1 }
  }, { failBatchCommitAt: 1 });
  const store = createStore(fake);

  assert.equal(await store.abortSessionAllocation(
    'session-a', 'ABC234', 'owner-uid'
  ), true);

  assert.equal(fake.has('codes/ABC234'), false);
  assert.equal(fake.has('sessions/session-a'), false);
  for (const path of [
    'sessions/session-a/meta/live',
    'sessions/session-a/meta/board',
    'sessions/session-a/snapshot/set',
    'sessions/session-a/snapshot_images/v0q0',
    'sessions/session-a/students/student-a',
    'sessions/session-a/responses/student-a',
    'sessions/session-a/grades/student-a__0',
    'sessions/session-a/student_scores/student-a'
  ]) assert.equal(fake.has(path), false, path);
  assert.ok(fake.calls().filter(call => call.operation === 'batchCommit').length >= 2);
});

test('allocation abort는 reassigned code와 newer session을 보존하고 반복 호출은 idempotent하다', async () => {
  const fake = makeFirestoreFake({
    'codes/ABC234': { sessionId: 'newer-session' },
    'sessions/session-a': {
      code: 'ABC234', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'allocating'
    },
    'sessions/session-a/meta/live': { q: -1 },
    'sessions/newer-session': {
      code: 'ABC234', teacherUid: 'other-owner', teacherEmail: 'other@school.kr', status: 'live'
    }
  });
  const store = createStore(fake);

  assert.equal(await store.abortSessionAllocation(
    'session-a', 'ABC234', 'owner-uid'
  ), true);
  assert.equal(await store.abortSessionAllocation(
    'session-a', 'ABC234', 'owner-uid'
  ), true);

  assert.deepEqual(fake.value('codes/ABC234'), { sessionId: 'newer-session' });
  assert.equal(fake.has('sessions/session-a'), false);
  assert.equal(fake.value('sessions/newer-session').status, 'live');
});

test('pending allocation 복구는 token 소유 allocating만 지우고 fresh live·ended는 보존한다', async () => {
  const activeLeaseUntil = 114_000;
  const fake = makeFirestoreFake({
    'codes/PEND12': { sessionId: 'pending' },
    'sessions/pending': {
      code: 'PEND12', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'allocating'
    },
    'sessions/pending/meta/allocation': { token: 'pending-token-1234', ownerUid: 'owner-uid' },
    'codes/BLANK1': { sessionId: 'blank-code' },
    'sessions/blank-code': {
      code: 'BLANK1', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'allocating'
    },
    'sessions/blank-code/meta/allocation': {
      token: 'blank-token-12345', ownerUid: 'owner-uid'
    },
    'codes/LIVE12': { sessionId: 'active' },
    'sessions/active': {
      code: 'LIVE12', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr',
      status: 'live', activationLeaseUntil: activeLeaseUntil
    },
    'sessions/active/meta/allocation': { token: 'active-token-12345', ownerUid: 'owner-uid' },
    'sessions/ended': {
      code: 'ENDED1', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'ended'
    },
    'sessions/ended/meta/allocation': { token: 'ended-token-12345', ownerUid: 'owner-uid' }
  });
  const { createFirestoreStore } = loadStoreModule();
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 100_000);

  assert.deepEqual(await store.recoverPendingSessionAllocation({
    sessionId: 'active', code: 'LIVE12', ownerUid: 'owner-uid', token: 'active-token-12345'
  }), { complete: false, active: true });
  assert.equal(fake.has('sessions/active'), true);

  assert.deepEqual(await store.recoverPendingSessionAllocation({
    sessionId: 'ended', code: 'ENDED1', ownerUid: 'owner-uid', token: 'ended-token-12345'
  }), { complete: true, ended: true });
  assert.equal(fake.has('sessions/ended'), true);

  assert.deepEqual(await store.recoverPendingSessionAllocation({
    sessionId: 'pending', code: 'PEND12', ownerUid: 'owner-uid', token: 'pending-token-1234'
  }), { complete: true, cleaned: true });
  assert.equal(fake.has('sessions/pending'), false);
  assert.equal(fake.has('codes/PEND12'), false);

  assert.deepEqual(await store.recoverPendingSessionAllocation({
    sessionId: 'blank-code', code: '', ownerUid: 'owner-uid', token: 'blank-token-12345'
  }), { complete: true, cleaned: true });
  assert.equal(fake.has('sessions/blank-code'), false);
  assert.equal(fake.has('codes/BLANK1'), false);
});

test('세션 시작은 열 후보가 모두 충돌하면 더 만들지 않고 실패한다', async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => ['codes/CODE' + index, { sessionId: 'old-' + index }])
  );
  const fake = makeFirestoreFake({
    ...initial,
    'quiz_sets/set1': { ownerUid: 'owner-uid', ownerEmail: 'owner@school.kr', trashedAt: null, purgeStartedAt: null }
  });
  const store = createStore(fake);
  let generated = 0;

  await assert.rejects(
    store.startSession('new', { setId: 'set1' }, () => 'CODE' + generated++),
    /사용 가능한 반 코드/
  );

  assert.equal(generated, 10);
  assert.equal(fake.has('sessions/new'), false);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 10);
});

test('세션 snapshot reader는 세트 구조와 이미지를 같은 content revision에서 다시 읽는다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: 'v1', contentRevision: 1, videos: [{ questions: [{ imgUp: true }] }]
    },
    'images/set1/q/v0q0': { data: 'image-v1' }
  });
  const originalCollection = fake.db.collection;
  let firstImageRead = true;
  fake.db.collection = path => {
    const reference = originalCollection(path);
    if (path !== 'images/set1/q') return reference;
    return {
      ...reference,
      async get() {
        const snapshot = await reference.get();
        if (firstImageRead) {
          firstImageRead = false;
          fake.emit('quiz_sets/set1', {
            title: 'v2', contentRevision: 2,
            videos: [{ questions: [{ imgUp: true }] }]
          });
          fake.emit('images/set1/q/v0q0', { data: 'image-v2' });
        }
        return snapshot;
      }
    };
  };
  const store = createStore(fake);

  const snapshot = await store.getQuizSetSnapshot('set1');

  assert.equal(snapshot.setSnapshot.title, 'v2');
  assert.deepEqual(snapshot.snapshotImages, { v0q0: 'image-v2' });
  assert.ok(fake.calls().filter(call => call.path === 'quiz_sets/set1').length >= 4);
});

test('학생·응답·live 구독은 세션의 각 Firestore 경로 데이터만 반환한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/students/s1': { name: '가' },
    'sessions/a/responses/s1': { answers: { '0': { c: 1, ok: true } } },
    'sessions/a/grades/s1__0': { uid: 's1', questionIndex: 0, revision: 1, ok: true },
    'sessions/a/meta/live': { q: 0, openedAt: 123, revealed: false, limitSec: 20 }
  });
  const store = createStore(fake);
  let students;
  let responses;
  let grades;
  let live;

  const stops = [
    store.subscribeStudents('a', value => { students = value; }),
    store.subscribeResponses('a', value => { responses = value; }),
    store.subscribeGrades('a', value => { grades = value; }),
    store.subscribeLive('a', value => { live = value; })
  ];
  await fake.flush();

  assert.deepEqual(students, { s1: { name: '가' } });
  assert.deepEqual(responses, { s1: { answers: { '0': { c: 1, ok: true } } } });
  assert.deepEqual(grades, { 's1__0': { uid: 's1', questionIndex: 0, revision: 1, ok: true } });
  assert.deepEqual(live, { id: 'live', q: 0, openedAt: 123, revealed: false, limitSec: 20 });
  assert.deepEqual(fake.subscribedPaths(), [
    'sessions/a/students',
    'sessions/a/responses',
    'sessions/a/grades',
    'sessions/a/meta/live'
  ]);
  stops.forEach(stop => stop());
});

test('live 갱신은 meta/live 문서를 통째로 교체한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': { q: 2, openedAt: 10, revealed: true, limitSec: 30, stale: true }
  });
  const store = createStore(fake);
  const waiting = { q: -1, openedAt: 0, revealed: false, limitSec: 0 };

  await store.setLive('a', waiting);

  assert.deepEqual(fake.value('sessions/a/meta/live'), waiting);
});

test('정답 공개는 publicAnswer를 병합해 openedAt Timestamp를 그대로 보존한다', async () => {
  const openedAt = { toMillis: () => 12_345 };
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': {
      q: 2, liveToken: 'live-q2', openedAt, revealed: false, limitSec: 30
    }
  });
  const store = createStore(fake);

  const revealed = await store.revealLive('a', {
    q: 2, liveToken: 'live-q2', openedAt: 12_345
  }, { answer: 1, explain: '해설' });

  const live = fake.value('sessions/a/meta/live');
  assert.equal(revealed, true);
  assert.equal(live.q, 2);
  assert.equal(live.liveToken, 'live-q2');
  assert.equal(live.openedAt.toMillis(), 12_345);
  assert.equal(live.revealed, true);
  assert.equal(live.limitSec, 30);
  assert.deepEqual(live.publicAnswer, { answer: 1, explain: '해설' });
});

function staleLiveFixture() {
  const current = {
    q: 1, liveToken: 'live-q1', openedAt: 20_000, revealed: false,
    accepting: true, limitSec: 30, publicQuestion: { text: 'new question' }
  };
  const fake = makeFirestoreFake({ 'sessions/a/meta/live': current });
  return {
    current,
    fake,
    store: createStore(fake),
    stale: { q: 0, liveToken: 'live-q0', openedAt: 10_000 }
  };
}

test('stale reveal identity makes zero live mutation', async () => {
  const { current, fake, store, stale } = staleLiveFixture();
  assert.equal(await store.revealLive('a', stale, { answer: 0 }), false);
  assert.deepEqual(fake.value('sessions/a/meta/live'), current);
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet').length, 0);
});

test('stale freeze identity makes zero live mutation', async () => {
  const { current, fake, store, stale } = staleLiveFixture();
  assert.equal(await store.freezeLive('a', stale), false);
  assert.deepEqual(fake.value('sessions/a/meta/live'), current);
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet').length, 0);
});

test('stale final close identity makes zero live mutation', async () => {
  const { current, fake, store, stale } = staleLiveFixture();
  assert.equal(typeof store.closeLive, 'function');
  assert.equal(await store.closeLive('a', stale), false);
  assert.deepEqual(fake.value('sessions/a/meta/live'), current);
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet').length, 0);
});

test('captured live identity freezes and closes the same server instance', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': {
      q: 0, liveToken: 'live-q0', openedAt: 10_000, revealed: false,
      accepting: true, limitSec: 30, publicQuestion: { text: 'question' }
    }
  });
  const store = createStore(fake);
  const identity = { q: 0, liveToken: 'live-q0', openedAt: 10_000 };

  assert.equal(await store.freezeLive('a', identity), true);
  assert.equal(fake.value('sessions/a/meta/live').accepting, false);
  assert.equal(await store.closeLive('a', identity), true);
  assert.deepEqual(fake.value('sessions/a/meta/live'), {
    q: -1, openedAt: 0, revealed: false, limitSec: 0
  });
});

test('live token identity works while the local openedAt server timestamp is unresolved', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': {
      q: 0, liveToken: 'live-q0', openedAt: 10_000, revealed: false,
      accepting: true, limitSec: 30, publicQuestion: { text: 'question' }
    }
  });
  const store = createStore(fake);

  assert.equal(await store.freezeLive('a', {
    q: 0, liveToken: 'live-q0', openedAt: null
  }), true);
  assert.equal(fake.value('sessions/a/meta/live').accepting, false);
});

test('세션 종료는 타이머 제출 유예 중에도 parent와 안전한 ended live를 원자적으로 쓴다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': { setId: 'set1', status: 'live' },
    'sessions/a/meta/live': {
      q: 2,
      openedAt: 10,
      revealed: false,
      accepting: true,
      limitSec: 30,
      publicQuestion: { number: 3, total: 3, type: 'mc', text: 'question', choices: [] },
      responseClosesAt: new Date(19_000),
      submitGraceUntil: new Date(21_000),
      revealAt: new Date(21_000)
    }
  }, { committedServerMillis: 20_000 });
  const store = createStore(fake);

  await store.endSession('a');

  const session = fake.value('sessions/a');
  assert.deepEqual({ setId: session.setId, status: session.status }, { setId: 'set1', status: 'ended' });
  assert.equal(session.endedAt.toMillis(), 20_000);
  assert.deepEqual(fake.value('sessions/a/meta/live'), {
    q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended'
  });
  assert.deepEqual(
    fake.calls().filter(call => call.operation === 'batchCommit'),
    [{ operation: 'batchCommit', size: 2 }]
  );
});

test('점수판은 meta/board 문서에 scores 필드로 쓴다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.writeBoard('a', { s1: 2, s2: 1 });

  assert.deepEqual(fake.value('sessions/a/meta/board'), { scores: { s1: 2, s2: 1 } });
});

test('teacher writes aggregate scores separately and student reads only the own score document', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.writeBoard('a', { s1: 2, s2: 1 }, {
    s1: { uid: 's1', visible: true, score: 2, graded: 3, answered: 3, rank: 1, total: 2 },
    s2: { uid: 's2', visible: false }
  });

  assert.deepEqual(fake.value('sessions/a/meta/board'), {
    scores: { s1: 2, s2: 1 }
  });
  assert.deepEqual(fake.value('sessions/a/student_scores/s1'), {
    uid: 's1', visible: true, score: 2, graded: 3, answered: 3, rank: 1, total: 2
  });
  assert.deepEqual(fake.value('sessions/a/student_scores/s2'), {
    uid: 's2', visible: false
  });
  assert.deepEqual(await store.getOwnScore('a', 's1'), {
    uid: 's1', visible: true, score: 2, graded: 3, answered: 3, rank: 1, total: 2
  });
});

test('교사 실행 화면은 학생·응답·live 구독을 저장소에 맡기고 응답 문서를 화면 형태로 바꾼다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const subscriptions = {};
  const subscriptionCounts = { students: 0, responses: 0, grades: 0, live: 0 };
  const playerLoads = [];
  const playerConfigs = [];
  let boardWrites = 0;
  const app = { innerHTML: '' };
  const player = { loadVideoById(options) { playerLoads.push(options); } };
  const context = {
    pl: {
      sessionId: 'session-a', code: 'ABC234', students: {}, responses: {},
      live: { q: -1, openedAt: 0, revealed: false, limitSec: 0 },
      videoIndex: 0,
      flatQuestions: [
        { number: 1, videoIndex: 0, t: 12, text: '첫 문항' },
        { number: 2, videoIndex: 1, t: 35, text: '둘째 문항' }
      ],
      set: {
        title: '첫 세트', questions: [],
        videos: [
          { videoId: 'abcdefghijk', startSec: 10, questions: [] },
          { videoId: 'lmnopqrstuv', startSec: 30, questions: [] }
        ],
        settings: { revealMode: 'manual', limitSec: 0 }
      }
    },
    store: {
      subscribeStudents(id, next) { assert.equal(id, 'session-a'); subscriptionCounts.students++; subscriptions.students = next; return () => {}; },
      subscribeResponses(id, next) { assert.equal(id, 'session-a'); subscriptionCounts.responses++; subscriptions.responses = next; return () => {}; },
      subscribeGrades(id, next) { assert.equal(id, 'session-a'); subscriptionCounts.grades++; subscriptions.grades = next; return () => {}; },
      subscribeLive(id, next) { assert.equal(id, 'session-a'); subscriptionCounts.live++; subscriptions.live = next; return () => {}; }
    },
    FirestoreCore: require('../firestore-core.js'),
    onCleanup() {},
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    linkTo() { return 'https://example.test/join/ABC234'; },
    esc(value) { return String(value); },
    ccButton() { return ''; },
    REVEAL_LABEL: { manual: '교사 공개' },
    window: {},
    document: { getElementById() { return {}; } },
    $(selector) { return selector === '#pl-qr' ? { style: {} } : null; },
    plRenderQList() {},
    plRenderStudents() {},
    plRenderBoardOverlay() {},
    plRenderOverlay() {},
    plRenderOverlayCounts() {},
    plRenderStageControls() {},
    plPushBoard() { boardWrites += 1; },
    whenYT(next) { next(); },
    ytEvents() { return {}; },
    plHandlePlayerStateChange() {},
    plHandlePlayerError() {},
    YT: {
      Player: function Player(id, config) {
        playerConfigs.push({ id, config });
        return player;
      }
    },
    every() {},
    plTick() {},
    plTimerTick() {},
    console
  };
  loadStageFunctions(['plLoadVideo', 'plGradeCurrentResponses', 'renderPlayRun'], context);

  context.renderPlayRun();
  subscriptions.students({ s1: { name: '가' } });
  subscriptions.responses({ s1: { answers: { '0': { c: 1, revision: 2, ok: true } } } });
  subscriptions.grades({ 's1__0': { uid: 's1', questionIndex: 0, revision: 2, ok: false } });
  subscriptions.live({
    q: 0, liveToken: 'live-q0', openedAt: null, revealed: false, limitSec: 20
  });
  const pendingLiveGeneration = context.pl.liveGeneration;
  subscriptions.live({
    q: 0, liveToken: 'live-q0', openedAt: 123, revealed: false, limitSec: 20
  });
  const studentsBefore = context.pl.students;
  const responsesBefore = context.pl.responses;
  context.plLoadVideo(1, true);

  assert.deepEqual(context.pl.students, { s1: { name: '가' } });
  assert.deepEqual(context.pl.responses, { '0': { s1: { c: 1, revision: 2, ok: false } } });
  assert.equal(context.pl.live.q, 0);
  assert.equal(context.pl.liveGeneration, pendingLiveGeneration);
  assert.equal(boardWrites, 0);
  assert.match(app.innerHTML, /id="pl-stage" onpointerdown="plActivateStageControls\(\)"/);
  assert.match(app.innerHTML, /id="pl-quiz-timeline"/);
  assert.doesNotMatch(app.innerHTML, /class="pl-stage-status"[^>]*aria-live/);
  assert.match(app.innerHTML, /<span aria-live="polite">참여 <b id="pl-nstu">0<\/b>명<\/span>/);
  assert.equal(playerConfigs.length, 1);
  assert.equal(playerConfigs[0].id, 'pl-player');
  assert.equal(playerConfigs[0].config.videoId, 'abcdefghijk');
  assert.equal(playerConfigs[0].config.playerVars.start, 10);
  assert.deepEqual(clone(playerLoads), [{ videoId: 'lmnopqrstuv', startSeconds: 30 }]);
  assert.equal(context.pl.player, player);
  assert.deepEqual(subscriptionCounts, { students: 1, responses: 1, grades: 1, live: 1 });
  assert.equal(context.pl.students, studentsBefore);
  assert.equal(context.pl.responses, responsesBefore);
});

test('teacher grades only submitted auto-graded responses after reveal with a separate write', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const state = {
    sessionId: 'session-a',
    live: { q: 0, revealed: true },
    flatQuestions: [
      { type: 'choice', answer: 1 },
      { type: 'long' }
    ],
    responses: {
      '0': {
        submitted: { answer: 1, submitted: true, revision: 2 },
        draft: { answer: 1, submitted: false, revision: 3 },
        graded: { answer: 0, submitted: true, revision: 1, ok: false }
      },
      '1': {
        essay: { answer: 'reason', submitted: true, revision: 1 }
      }
    }
  };
  const context = {
    pl: state,
    qType(q) { return q.type || 'choice'; },
    isAutoGraded(q) { return q.type !== 'long'; },
    gradeResponse(q, response) { return Number(response.answer) === Number(q.answer); },
    store: {
      async gradeAnswer(...args) { calls.push(args); return true; }
    },
    console
  };
  loadStageFunctions(['plGradeCurrentResponses'], context);

  await context.plGradeCurrentResponses(state);
  assert.equal(state.responses['0'].submitted.ok, true);
  await context.plGradeCurrentResponses(state);
  state.live = { q: 1, revealed: true };
  await context.plGradeCurrentResponses(state);

  assert.deepEqual(calls, [['session-a', 'submitted', 0, 2, true]]);
});

test('teacher grades submitted auto responses before an unrevealed never-mode close', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const state = {
    sessionId: 'session-a',
    live: { q: 0, revealed: false },
    flatQuestions: [{ type: 'choice', answer: 1 }],
    responses: {
      '0': { student: { answer: 1, submitted: true, revision: 4 } }
    }
  };
  const context = {
    pl: state,
    isAutoGraded() { return true; },
    gradeResponse() { return true; },
    store: {
      async gradeAnswer(...args) { calls.push(args); return true; }
    },
    console
  };
  loadStageFunctions(['plGradeCurrentResponses'], context);

  await context.plGradeCurrentResponses(state, 0);

  assert.deepEqual(calls, [['session-a', 'student', 0, 4, true]]);
  assert.equal(state.responses['0'].student.ok, true);
});

test('close reuses and awaits the in-flight grade promise before persisting the board', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const order = [];
  let resolveGrade;
  const gradeReady = new Promise(resolve => { resolveGrade = resolve; });
  const state = {
    sessionId: 'session-a',
    live: { q: 0, revealed: false },
    flatQuestions: [{ type: 'choice', answer: 1 }],
    responses: {
      '0': { student: { answer: 1, submitted: true, revision: 7 } }
    },
    player: { playVideo() { order.push('play'); } }
  };
  const context = {
    pl: state,
    isAutoGraded() { return true; },
    gradeResponse() { return true; },
    store: {
      async freezeLive() { return true; },
      async getResponses() {
        return { student: { uid: 'student', answers: {
          '0': { answer: 1, submitted: true, revision: 7 }
        } } };
      },
      async getGrades() { return {}; },
      gradeAnswer() {
        order.push('grade-start');
        return gradeReady.then(() => { order.push('grade-end'); return true; });
      },
      async closeLive() { order.push('live-close'); return true; }
    },
    async plPushBoard() { order.push('board'); },
    FirestoreCore: core,
    console
  };
  loadStageFunctions([
    'plGradeCurrentResponses', 'plOpenNextDueQuestion', 'plCloseQuestion'
  ], context);

  const firstGrade = context.plGradeCurrentResponses(state, 0);
  const secondGrade = context.plGradeCurrentResponses(state, 0);
  const closing = context.plCloseQuestion();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(order, ['grade-start']);
  resolveGrade();
  await Promise.all([firstGrade, secondGrade, closing]);
  assert.deepEqual(order, ['grade-start', 'grade-end', 'board', 'live-close', 'play']);
});

test('grade failure keeps the frozen question and queue retryable until grading succeeds', async () => {
  const opened = [];
  let gradeAttempts = 0;
  let boardWrites = 0;
  let liveCloses = 0;
  const state = {
    sessionId: 'session-a', live: { q: 0, accepting: true }, liveGeneration: 4,
    flatQuestions: [{ type: 'choice', answer: 1 }, { type: 'choice', answer: 0 }],
    responses: {}, dueQuestions: [1], pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    isAutoGraded() { return true; },
    gradeResponse() { return true; },
    store: {
      async freezeLive() { return true; },
      async getResponses() {
        return { s1: { uid: 's1', answers: {
          '0': { answer: 1, submitted: true, revision: 2 }
        } } };
      },
      async getGrades() { return {}; },
      async gradeAnswer() {
        gradeAttempts += 1;
        if (gradeAttempts === 1) throw new Error('grade offline');
        return true;
      },
      async closeLive() { liveCloses += 1; return true; }
    },
    async plPushBoard() { boardWrites += 1; },
    plOpenQuestion(i) { opened.push(i); state.pendingLiveQuestion = i; },
    plTick() {},
    console: { error() {} }
  };
  loadStageFunctions(['plGradeCurrentResponses', 'plOpenNextDueQuestion', 'plCloseQuestion'], context);

  await assert.rejects(context.plCloseQuestion(), /grade offline/);
  assert.equal(state.live.q, 0);
  assert.equal(state.live.accepting, false);
  assert.match(state.closeError, /grade offline/);
  assert.deepEqual(state.dueQuestions, [1]);
  assert.deepEqual(opened, []);
  assert.equal(boardWrites, 0);
  assert.equal(liveCloses, 0);

  await context.plCloseQuestion();
  assert.equal(gradeAttempts, 2);
  assert.equal(boardWrites, 1);
  assert.equal(liveCloses, 1);
  assert.deepEqual(opened, [1]);
});

test('board failure keeps the frozen question and succeeds on retry before consuming queue', async () => {
  const opened = [];
  let boardAttempts = 0;
  let liveCloses = 0;
  const state = {
    sessionId: 'session-a', live: { q: 0, accepting: true }, liveGeneration: 2,
    students: { s1: { name: 'A', num: 1 } },
    flatQuestions: [{ type: 'choice' }, { type: 'choice' }],
    set: { settings: { revealMode: 'never' } },
    responses: {}, dueQuestions: [1], pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    store: {
      async freezeLive() { return true; },
      async getResponses() {
        return { s1: { uid: 's1', answers: {
          '0': { answer: 1, submitted: true, revision: 3 }
        } } };
      },
      async getGrades() {
        return { 's1__0': { uid: 's1', questionIndex: 0, revision: 3, ok: true } };
      },
      async writeBoard() {
        boardAttempts += 1;
        if (boardAttempts === 1) throw new Error('board offline');
      },
      async closeLive() { liveCloses += 1; return true; }
    },
    async plGradeCurrentResponses() {},
    plOpenQuestion(i) { opened.push(i); state.pendingLiveQuestion = i; },
    plTick() {},
    console: { warn() {} }
  };
  loadStageFunctions([
    'plScoreboard', 'plPushBoard', 'plOpenNextDueQuestion', 'plCloseQuestion'
  ], context);

  await assert.rejects(context.plCloseQuestion(), /board offline/);
  assert.equal(state.live.q, 0);
  assert.equal(state.live.accepting, false);
  assert.match(state.closeError, /board offline/);
  assert.deepEqual(state.dueQuestions, [1]);
  assert.deepEqual(opened, []);
  assert.equal(liveCloses, 0);

  await context.plCloseQuestion();
  assert.equal(boardAttempts, 2);
  assert.equal(liveCloses, 1);
  assert.deepEqual(opened, [1]);
});

test('simultaneous close calls share one per-question promise and open queued next once', async () => {
  let releaseFreeze;
  const freezeReady = new Promise(resolve => { releaseFreeze = resolve; });
  let freezes = 0;
  let closes = 0;
  const opened = [];
  const state = {
    sessionId: 'session-a', live: { q: 0, accepting: true }, liveGeneration: 7,
    responses: {}, dueQuestions: [1], pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    store: {
      freezeLive() { freezes += 1; return freezeReady.then(() => true); },
      async getResponses() { return {}; },
      async getGrades() { return {}; },
      async closeLive() { closes += 1; return true; }
    },
    async plGradeCurrentResponses() {},
    async plPushBoard() {},
    plOpenQuestion(i) { opened.push(i); state.pendingLiveQuestion = i; },
    plTick() {}
  };
  loadStageFunctions(['plOpenNextDueQuestion', 'plCloseQuestion'], context);

  const first = context.plCloseQuestion();
  const second = context.plCloseQuestion();
  assert.equal(first, second);
  assert.equal(freezes, 1);

  releaseFreeze();
  await first;
  assert.equal(closes, 1);
  assert.deepEqual(opened, [1]);
});

test('stale close completion cannot close a newer live question', async () => {
  let releaseFreeze;
  const freezeReady = new Promise(resolve => { releaseFreeze = resolve; });
  let responseReads = 0;
  let closes = 0;
  const state = {
    sessionId: 'session-a', live: { q: 0, accepting: true }, liveGeneration: 5,
    responses: {}, pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    store: {
      freezeLive() { return freezeReady.then(() => true); },
      async getResponses() { responseReads += 1; return {}; },
      async getGrades() { return {}; },
      async closeLive() { closes += 1; return true; }
    },
    async plGradeCurrentResponses() {},
    async plPushBoard() {},
    plOpenNextDueQuestion() { throw new Error('must not advance'); },
    plTick() {}
  };
  loadStageFunctions(['plCloseQuestion'], context);

  const closing = context.plCloseQuestion();
  state.live = { q: 1, accepting: true };
  state.liveGeneration = 6;
  releaseFreeze();

  assert.equal(await closing, false);
  assert.equal(responseReads, 0);
  assert.equal(closes, 0);
  assert.equal(state.live.q, 1);
});

test('server-rejected stale freeze stops close before reading responses', async () => {
  let responseReads = 0;
  let unconditionalCloses = 0;
  let advances = 0;
  const state = {
    sessionId: 'session-a',
    live: { q: 0, liveToken: 'live-q0', openedAt: 10_000, accepting: true },
    liveGeneration: 5,
    responses: {}, pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    store: {
      async freezeLive() { return false; },
      async getResponses() { responseReads += 1; return {}; },
      async getGrades() { return {}; },
      async setLive() { unconditionalCloses += 1; }
    },
    async plGradeCurrentResponses() {},
    async plPushBoard() {},
    plOpenNextDueQuestion() { advances += 1; return false; },
    plTick() {}
  };
  loadStageFunctions(['plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), false);
  assert.equal(responseReads, 0);
  assert.equal(unconditionalCloses, 0);
  assert.equal(advances, 0);
  assert.equal(state.live.accepting, true);
});

test('close passes one captured live identity to freeze and final close CAS writes', async () => {
  const calls = [];
  const state = {
    sessionId: 'session-a',
    live: { q: 0, liveToken: 'live-q0', openedAt: 10_000, accepting: true },
    liveGeneration: 3,
    responses: {}, pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    store: {
      async freezeLive(...args) { calls.push(['freeze', ...args]); return true; },
      async getResponses() { return {}; },
      async getGrades() { return {}; },
      async closeLive(...args) { calls.push(['close', ...args]); return true; },
      async setLive(...args) { calls.push(['unconditional', ...args]); }
    },
    async plGradeCurrentResponses() {},
    async plPushBoard() {},
    plOpenNextDueQuestion() { return false; },
    plTick() {}
  };
  loadStageFunctions(['plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), true);
  assert.deepEqual(clone(calls), [
    ['freeze', 'session-a', {
      q: 0, liveToken: 'live-q0', openedAt: 10_000
    }],
    ['close', 'session-a', {
      q: 0, liveToken: 'live-q0', openedAt: 10_000
    }]
  ]);
});

test('교사 재생 초기화는 videos를 평탄화해 전역 문항 상태를 만든다', async () => {
  let introRendered = 0;
  const savedSet = {
    title: '플레이리스트', settings: {},
    videos: [
      { videoId: 'a', startSec: 10, endSec: 20, questions: [{ t: 12, text: 'A' }] },
      { videoId: 'b', startSec: 30, endSec: 50, questions: [{ t: 35, text: 'B' }] }
    ]
  };
  const context = {
    pl: null,
    PlaylistCore: require('../playlist-core.js'),
    store: { getQuizSet() { return Promise.resolve(savedSet); } },
    normSet(value) { return value; },
    renderPlayIntro() { introRendered++; },
    onCleanup() {},
    APP() { return { innerHTML: '' }; },
    topbar() { return ''; },
    esc(value) { return String(value); },
    go() {},
    document: {
      addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
      body: { classList: { remove() {} } }, fullscreenElement: null
    },
    window: { addEventListener() {}, removeEventListener() {} },
    plCleanupStageFullscreen() {},
    plHandleFullscreenChange() {}, plHandleStageKeydown() {}, plClampQrBubble() {},
    console
  };
  loadStageFunctions(['screenPlay'], context);

  context.screenPlay('set1');
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();

  assert.equal(introRendered, 1);
  assert.equal(context.pl.videos, savedSet.videos);
  assert.deepEqual(context.pl.flatQuestions.map(q => [q.number, q.videoIndex, q.text]), [
    [1, 0, 'A'], [2, 1, 'B']
  ]);
  assert.deepEqual(context.pl.fired, [false, false]);
  assert.equal(context.pl.videoIndex, 0);
  assert.equal(context.pl.playlistDone, false);
  assert.equal(context.pl.transitionUntil, 0);
});

test('다음 영상은 같은 플레이어에 시작 시각으로 로드된다', () => {
  const calls = [];
  const player = { loadVideoById(options) { calls.push(options); } };
  const ctx = loadStageFunctions(['plLoadVideo'], {
    pl: {
      videoIndex: 0,
      set: { questions: [], videos: [
        { videoId: 'a', startSec: 10 },
        { videoId: 'b', startSec: 30 }
      ] },
      player
    }
  });

  ctx.plLoadVideo(1, true);

  assert.deepEqual(clone(calls), [{ videoId: 'b', startSeconds: 30 }]);
  assert.equal(ctx.pl.videoIndex, 1);
  assert.equal(ctx.pl.player, player);
  assert.equal(ctx.pl.playerLoading, true);
});

test('다음 영상 로드 중에는 이전 영상 시각으로 문항이나 전환을 실행하지 않는다', () => {
  let reads = 0, opened = 0, transitioned = 0;
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      playerLoading: true, videoIndex: 1, transitionUntil: 0, playlistDone: false,
      lastT: 20, fired: [false], live: { q: -1 },
      flatQuestions: [{ t: 40, videoIndex: 1 }],
      set: { videos: [{}, { startSec: 30, endSec: 50 }] },
      player: { getCurrentTime() { reads++; return 40; } }
    },
    Date: { now() { return 1000; } },
    $() { return null; },
    fmtTime() { return ''; },
    plOpenQuestion() { opened++; },
    plRenderTransition() { transitioned++; }
  });

  ctx.plTick();

  assert.equal(reads, 0);
  assert.equal(opened, 0);
  assert.equal(transitioned, 0);
  assert.deepEqual(ctx.pl.fired, [false]);
});

test('영상 진행 인터페이스는 다음 영상을 로드하고 마지막에서는 완료한다', () => {
  const loaded = [];
  let completed = 0;
  const ctx = loadStageFunctions(['plAdvanceVideo'], {
    pl: { videoIndex: 0, set: { videos: [{ startSec: 10 }, { startSec: 20 }] } },
    PlaylistCore: require('../playlist-core.js'),
    plLoadVideo(index, autoplay) { loaded.push([index, autoplay]); },
    plCompletePlaylist() { completed++; }
  });

  ctx.plAdvanceVideo();
  ctx.pl.videoIndex = 1;
  ctx.plAdvanceVideo();

  assert.deepEqual(loaded, [[1, true]]);
  assert.equal(completed, 1);
});

test('영상 종료 후 3초 안내를 거쳐 다음 영상으로 이동한다', () => {
  const loaded = [];
  let rendered = 0;
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      videoIndex: 0, transitionUntil: 0, playlistDone: false,
      lastT: 39, fired: [], live: { q: -1 }, flatQuestions: [],
      set: { questions: [], videos: [
        { startSec: 10, endSec: 40, questions: [] },
        { startSec: 20, endSec: 50, questions: [] }
      ] },
      player: { getCurrentTime() { return 40; }, pauseVideo() {} }
    },
    Date: { now() { return 1000; } },
    $() { return null; },
    fmtTime() { return ''; },
    plLoadVideo(index, autoplay) { loaded.push([index, autoplay]); },
    plRenderTransition() { rendered++; }
  });

  ctx.plTick();
  assert.equal(ctx.pl.transitionUntil, 4000);
  assert.deepEqual(loaded, []);
  assert.equal(rendered, 1);

  ctx.Date.now = () => 2500;
  ctx.plTick();
  assert.equal(rendered, 2);
  assert.deepEqual(loaded, []);

  ctx.Date.now = () => 4000;
  ctx.plTick();
  assert.deepEqual(loaded, [[1, true]]);
});

test('전환 카운트다운 중 문항이 열리면 이동을 취소하고 문항 종료 뒤 다시 센다', () => {
  const loaded = [];
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      videoIndex: 0, transitionUntil: 4000, playlistDone: false,
      playerLoading: false, pendingLiveQuestion: -1,
      lastT: 40, fired: [], live: { q: -1 }, flatQuestions: [],
      set: { videos: [
        { startSec: 10, endSec: 40, questions: [] },
        { startSec: 20, endSec: 50, questions: [] }
      ] },
      player: { getCurrentTime() { return 40; }, pauseVideo() {} }
    },
    Date: { now() { return 1000; } },
    $() { return null; }, fmtTime() { return ''; },
    plLoadVideo(index, autoplay) { loaded.push([index, autoplay]); },
    plRenderTransition() {}
  });

  ctx.plTick();
  ctx.pl.pendingLiveQuestion = 1;
  ctx.Date.now = () => 2000;
  ctx.plTick();

  assert.equal(ctx.pl.transitionUntil, 0);
  assert.deepEqual(loaded, []);

  ctx.pl.pendingLiveQuestion = -1;
  ctx.plTick();
  assert.equal(ctx.pl.transitionUntil, 5000);
});

test('마지막 영상 종료 시 3초 전환 없이 완료 메뉴로 들어간다', () => {
  let completed = 0, paused = 0;
  const ctx = loadStageFunctions(['plCompletePlaylist', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      videoIndex: 1, transitionUntil: 0, playlistDone: false,
      lastT: 49, fired: [], live: { q: -1 }, flatQuestions: [],
      set: { questions: [], videos: [
        { startSec: 10, endSec: 40, questions: [] },
        { startSec: 20, endSec: 50, questions: [] }
      ] },
      player: { getCurrentTime() { return 50; }, pauseVideo() { paused++; } }
    },
    Date: { now() { return 1000; } },
    $() { return null; },
    fmtTime() { return ''; },
    plOpenQuestion() {},
    plRenderCompletion() { completed++; }
  });

  ctx.plTick();

  assert.equal(completed, 1);
  assert.equal(paused, 1);
  assert.equal(ctx.pl.playlistDone, true);
  assert.equal(ctx.pl.transitionUntil, 0);
});

test('열린 문항이 있으면 종료 시각에 도달해도 영상 전환을 보류한다', () => {
  let paused = 0;
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      videoIndex: 0, transitionUntil: 0, playlistDone: false,
      lastT: 39, fired: [], live: { q: 1 }, flatQuestions: [],
      set: { questions: [], videos: [
        { startSec: 10, endSec: 40, questions: [] },
        { startSec: 20, endSec: 50, questions: [] }
      ] },
      player: { getCurrentTime() { return 40; }, pauseVideo() { paused++; } }
    },
    Date: { now() { return 1000; } },
    $() { return null; },
    fmtTime() { return ''; },
    plLoadVideo() { throw new Error('문항이 열린 동안 이동하면 안 됨'); },
    plRenderTransition() {}
  });

  ctx.plTick();

  assert.equal(ctx.pl.transitionUntil, 0);
  assert.equal(ctx.pl.videoIndex, 0);
  assert.equal(paused, 1);

  ctx.pl.live.q = -1;
  ctx.plTick();
  assert.equal(ctx.pl.transitionUntil, 4000);
});

test('현재 영상의 문항만 자동으로 열고 live에는 전역 인덱스를 쓴다', () => {
  const opened = [];
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      videoIndex: 1, transitionUntil: 0, playlistDone: false,
      lastT: 39, fired: [false, false], live: { q: -1 },
      flatQuestions: [
        { t: 40, videoIndex: 0, text: '첫 영상 문항' },
        { t: 40, videoIndex: 1, text: '둘째 영상 문항' }
      ],
      set: {
        questions: [{ t: 40, text: '구형 지역 인덱스 문항' }],
        videos: [
          { startSec: 0, endSec: 60, questions: [] },
          { startSec: 0, endSec: 60, questions: [] }
        ]
      },
      player: { getCurrentTime() { return 40; } }
    },
    Date: { now() { return 1000; } },
    $() { return null; },
    fmtTime() { return ''; },
    plOpenQuestion(index) { opened.push(index); },
    plRenderTransition() {}
  });

  ctx.plTick();

  assert.deepEqual(opened, [1]);
  assert.deepEqual(ctx.pl.fired, [false, true]);
});

test('종료 시각 문항의 live 반영이 늦어도 영상 전환을 시작하지 않는다', () => {
  let paused = 0;
  const ctx = loadStageFunctions(['plOpenQuestion', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
    pl: {
      sessionId: 'session-a', videoIndex: 0, transitionUntil: 0, playlistDone: false,
      lastT: 39, fired: [false], live: { q: -1 }, pendingLiveQuestion: -1,
      flatQuestions: [{
        t: 40, videoIndex: 0, limitSec: null, number: 1,
        type: 'choice', text: '끝 문항', choices: ['A', 'B']
      }],
      set: {
        settings: { autoPause: false, revealMode: 'manual', limitSec: 20 },
        videos: [{ startSec: 0, endSec: 40 }, { startSec: 0, endSec: 60 }]
      },
      player: { getCurrentTime() { return 40; }, pauseVideo() { paused++; } }
    },
    Date: { now() { return 1000; } },
    $() { return null; }, fmtTime() { return ''; },
    SV_TS: 1234,
    limitFor() { return 20; },
    FirestoreStore: loadStoreModule(),
    store: { setLive() { return new Promise(() => {}); } },
    plRenderTransition() {}
  });

  ctx.plTick();
  ctx.plTick();

  assert.equal(ctx.pl.pendingLiveQuestion, 0);
  assert.equal(ctx.pl.transitionUntil, 0);
  assert.equal(paused, 1);
});

test('마지막 영상 완료는 세션을 종료하지 않는다', () => {
  let ended = 0, paused = 0, rendered = 0;
  const ctx = loadStageFunctions(['plCompletePlaylist'], {
    pl: { playlistDone: false, transitionUntil: 100, player: { pauseVideo() { paused++; } } },
    store: { endSession() { ended++; } },
    plRenderCompletion() { rendered++; }
  });

  ctx.plCompletePlaylist();
  ctx.plCompletePlaylist();

  assert.equal(ctx.pl.playlistDone, true);
  assert.equal(ctx.pl.transitionUntil, 0);
  assert.equal(paused, 1);
  assert.equal(rendered, 1);
  assert.equal(ended, 0);
});

test('전환 안내는 stage 안에 한 번만 표시되고 남은 초를 갱신한다', () => {
  const appended = [];
  let transition = null;
  const stage = { appendChild(node) { appended.push(node); transition = node; } };
  const ctx = loadStageFunctions(['plStageRoot', 'plRenderTransition'], {
    pl: { videoIndex: 0, transitionUntil: 4000, set: { videos: [{}, { title: '둘째 영상' }] } },
    Date: { now() { return 1000; } },
    document: {
      body: stage,
      getElementById(id) {
        if (id === 'pl-stage') return stage;
        if (id === 'pl-transition') return transition;
        return null;
      },
      createElement() { return { id: '', innerHTML: '' }; }
    },
    esc(value) { return String(value); }
  });

  ctx.plRenderTransition();
  ctx.Date.now = () => 2500;
  ctx.plRenderTransition();

  assert.equal(appended.length, 1);
  assert.equal(transition.id, 'pl-transition');
  assert.match(transition.innerHTML, /다음 영상으로 이동합니다/);
  assert.match(transition.innerHTML, /2초/);
});

test('완료 메뉴는 순위·대시보드·처음부터 재생·명시적 진행 종료를 제공한다', () => {
  let completion = null;
  const stage = { appendChild(node) { completion = node; } };
  const ctx = loadStageFunctions(['plStageRoot', 'plRenderCompletion'], {
    pl: { sessionId: 'session-a', set: { title: '세트' } },
    document: {
      body: stage,
      getElementById(id) {
        if (id === 'pl-stage') return stage;
        if (id === 'pl-completion') return completion;
        return null;
      },
      createElement() { return { id: '', innerHTML: '' }; }
    },
    esc(value) { return String(value); }
  });

  ctx.plRenderCompletion();

  assert.equal(completion.id, 'pl-completion');
  assert.match(completion.innerHTML, /모든 영상 재생 완료/);
  assert.match(completion.innerHTML, /onclick="plToggleBoard\(\)"/);
  assert.match(completion.innerHTML, /href="#\/live\/session-a"/);
  assert.match(completion.innerHTML, /onclick="plReplayPlaylist\(\)"/);
  assert.match(completion.innerHTML, /onclick="plEndSession\(\)"/);
});

test('YouTube 상태는 새 영상 로드 잠금을 풀고 종료는 tick에 위임하며 오류는 자동 건너뛰지 않는다', () => {
  let ticks = 0, errors = 0, loads = 0;
  const ctx = loadStageFunctions(['plPlayerEventVideoId', 'plPlayerEventStatus', 'plHandlePlayerStateChange', 'plHandlePlayerError'], {
    pl: { playbackEnded: false, playerError: null, playerLoading: true },
    YT: { PlayerState: { ENDED: 0, PLAYING: 1, CUED: 5 } },
    plTick() { ticks++; },
    plRenderPlayerError() { errors++; },
    plLoadVideo() { loads++; },
    plAdvanceVideo() { loads++; }
  });

  ctx.plHandlePlayerStateChange({ data: 1 });
  assert.equal(ctx.pl.playerLoading, false);
  ctx.plHandlePlayerStateChange({ data: 0 });
  ctx.pl.playerLoading = true;
  ctx.plHandlePlayerError({ data: 100 });

  assert.equal(ctx.pl.playbackEnded, false);
  assert.equal(ticks, 1);
  assert.equal(ctx.pl.playerError, 100);
  assert.equal(ctx.pl.playerLoading, false);
  assert.equal(errors, 1);
  assert.equal(loads, 0);
});

test('이전 영상의 지연 ENDED와 오류는 다음 영상 및 다시 보기 세대에 영향을 주지 않는다', () => {
  let currentVideoId = 'a', ticks = 0, errors = 0;
  const player = {
    getVideoData() { return { video_id: currentVideoId }; },
    loadVideoById() {}
  };
  const ctx = loadStageFunctions([
    'plLoadVideo', 'plReplayPlaylist', 'plPlayerEventVideoId', 'plPlayerEventStatus',
    'plHandlePlayerStateChange', 'plHandlePlayerError'
  ], {
    pl: {
      videoIndex: 0, loadGeneration: 1, activePlaybackGeneration: 1,
      expectedVideoId: 'a', playbackEnded: false, playerLoading: false,
      fired: [true, true],
      set: { videos: [
        { videoId: 'a', startSec: 10 },
        { videoId: 'b', startSec: 20 }
      ] },
      player
    },
    YT: { PlayerState: { ENDED: 0, PLAYING: 1, CUED: 5 } },
    plTick() { ticks++; },
    plRenderPlayerError() { errors++; }
  });

  ctx.plLoadVideo(1, true);
  ctx.plHandlePlayerStateChange({ data: 0, target: player });
  assert.equal(ctx.pl.playbackEnded, false);
  assert.equal(ticks, 0);

  currentVideoId = 'b';
  ctx.plHandlePlayerStateChange({ data: 1, target: player });
  assert.equal(ctx.pl.activePlaybackGeneration, ctx.pl.loadGeneration);
  assert.equal(ctx.pl.playbackEnded, false);

  ctx.pl.playbackEnded = true;
  ctx.plReplayPlaylist();
  ctx.plHandlePlayerError({ data: 100, target: player });
  assert.equal(errors, 0);
  assert.equal(ctx.pl.playerError, null);
  assert.equal(ctx.pl.playbackEnded, true);

  currentVideoId = 'a';
  ctx.plHandlePlayerStateChange({ data: 1, target: player });
  assert.equal(ctx.pl.playbackEnded, false);
  ctx.plHandlePlayerStateChange({ data: 0, target: player });
  assert.equal(ticks, 1);
  assert.equal(ctx.pl.playbackEnded, true);
});

test('새 영상이 PLAYING인 뒤 도착한 이전 ENDED와 오류는 실제 플레이어 상태로 무시한다', () => {
  let currentVideoId = 'a', actualState = 1, currentTime = 10, ticks = 0, errors = 0;
  const loads = [];
  const player = {
    getVideoData() { return { video_id: currentVideoId }; },
    getPlayerState() { return actualState; },
    getCurrentTime() { return currentTime; },
    getDuration() { return currentVideoId === 'a' ? 20 : 50; },
    loadVideoById(options) { loads.push(options); }
  };
  const ctx = loadStageFunctions([
    'plLoadVideo', 'plReplayPlaylist', 'plPlayerEventVideoId', 'plPlayerEventStatus',
    'plHandlePlayerStateChange', 'plHandlePlayerError'
  ], {
    pl: {
      videoIndex: 0, loadGeneration: 1, activePlaybackGeneration: 1,
      expectedVideoId: 'a', playbackEnded: false, playerLoading: false,
      playerError: null, fired: [false, false], transitionUntil: 0,
      set: { videos: [
        { videoId: 'a', startSec: 0, endSec: 20 },
        { videoId: 'b', startSec: 20, endSec: 50 }
      ] },
      player
    },
    YT: { PlayerState: { ENDED: 0, PLAYING: 1, CUED: 5 } },
    plTick() { ticks++; },
    plRenderPlayerError() { errors++; }
  });

  ctx.plLoadVideo(1, true);
  currentVideoId = 'b';
  currentTime = 25;
  ctx.plHandlePlayerStateChange({ data: 1, target: player });
  ctx.plHandlePlayerStateChange({ data: 0, target: player });
  ctx.plHandlePlayerError({ data: 100, target: player });

  assert.equal(ctx.pl.playbackEnded, false);
  assert.equal(ctx.pl.playerError, null);
  assert.equal(ticks, 0);
  assert.equal(errors, 0);

  actualState = 0;
  currentTime = 50;
  ctx.plHandlePlayerStateChange({ data: 0, target: player });

  assert.equal(ctx.pl.playbackEnded, true);
  assert.equal(ticks, 1);

  ctx.plReplayPlaylist();
  currentVideoId = 'a';
  actualState = 1;
  currentTime = 10;
  ctx.plHandlePlayerStateChange({ data: 1, target: player });
  ctx.plHandlePlayerStateChange({ data: 0, target: player });
  ctx.plHandlePlayerError({ data: 101, target: player });

  assert.equal(ctx.pl.playbackEnded, false);
  assert.equal(ctx.pl.playerError, null);
  assert.equal(ticks, 1);
  assert.equal(errors, 0);
  assert.deepEqual(loads.map(load => load.videoId), ['b', 'a']);

  actualState = 0;
  currentTime = 20;
  ctx.plHandlePlayerStateChange({ data: 0, target: player });

  assert.equal(ctx.pl.playbackEnded, true);
  assert.equal(ticks, 2);
});

test('현재 영상 로드 오류는 남은 종료 신호를 지우고 자동 전환을 보류한다', () => {
  let errors = 0, transitions = 0, pauses = 0, loads = 0, completions = 0;
  const player = {
    getVideoData() { return { video_id: 'a' }; },
    getPlayerState() { return -1; },
    getCurrentTime() { return 30; },
    getDuration() { return 30; },
    pauseVideo() { pauses++; }
  };
  const ctx = loadStageFunctions([
    'plPlayerEventVideoId', 'plPlayerEventStatus', 'plHandlePlayerError', 'plTick'
  ], {
    pl: {
      videoIndex: 0, loadGeneration: 2, activePlaybackGeneration: 0,
      expectedVideoId: 'a', playbackEnded: true, playerLoading: true,
      playerError: null, playlistDone: false, transitionUntil: 0,
      live: { q: -1 }, pendingLiveQuestion: -1, lastT: 29,
      flatQuestions: [], fired: [],
      set: { videos: [
        { videoId: 'a', startSec: 0, endSec: 30 },
        { videoId: 'b', startSec: 0, endSec: 30 }
      ] },
      player
    },
    YT: { PlayerState: { ENDED: 0, PLAYING: 1, CUED: 5 } },
    Date: { now() { return 1000; } },
    $() { return null; },
    fmtTime(value) { return String(value); },
    plRenderPlayerError() { errors++; },
    plRenderTransition() { transitions++; },
    plLoadVideo() { loads++; },
    plCompletePlaylist() { completions++; },
    plOpenQuestion() {}
  });

  ctx.plHandlePlayerError({ data: 100, target: player });
  ctx.plTick();

  assert.equal(ctx.pl.playerError, 100);
  assert.equal(ctx.pl.playbackEnded, false);
  assert.equal(ctx.pl.transitionUntil, 0);
  assert.equal(errors, 1);
  assert.equal(transitions, 0);
  assert.equal(pauses, 0);
  assert.equal(loads, 0);
  assert.equal(completions, 0);
});

test('YouTube 공용 이벤트는 자막 처리 뒤 교사 종료·오류 콜백을 전달한다', () => {
  const calls = [];
  const player = {};
  const ctx = loadStageFunctions(['ytEvents'], {
    YT: { PlayerState: { PLAYING: 1, BUFFERING: 3, ENDED: 0 } },
    applyCaptions(value) { calls.push(['captions', value]); }
  });
  const events = ctx.ytEvents(
    () => player,
    event => { calls.push(['state', event.data]); },
    event => { calls.push(['error', event.data]); }
  );

  events.onStateChange({ data: 0 });
  events.onStateChange({ data: 1 });
  events.onError({ data: 100 });

  assert.deepEqual(calls, [
    ['state', 0],
    ['captions', player], ['state', 1],
    ['error', 100]
  ]);
});

test('처음부터 다시 보기는 응답과 참여 상태를 유지하고 첫 영상만 다시 로드한다', () => {
  const loads = [];
  const students = { s1: { name: '가' } };
  const responses = { '0': { s1: { ok: true } } };
  const ctx = loadStageFunctions(['plReplayPlaylist'], {
    pl: {
      playlistDone: true, transitionUntil: 3000, playbackEnded: true,
      fired: [true, true], students, responses
    },
    plLoadVideo(index, autoplay) { loads.push([index, autoplay]); }
  });

  ctx.plReplayPlaylist();

  assert.equal(ctx.pl.playlistDone, false);
  assert.equal(ctx.pl.transitionUntil, 0);
  assert.equal(ctx.pl.playbackEnded, true);
  assert.deepEqual(ctx.pl.fired, [false, false]);
  assert.equal(ctx.pl.students, students);
  assert.equal(ctx.pl.responses, responses);
  assert.deepEqual(loads, [[0, true]]);
});

test('순위는 모든 영상의 전역 문항 응답을 합산한다', () => {
  const ctx = loadStageFunctions(['plScoreboard'], {
    pl: {
      students: { s1: { name: '가', grade: 1, klass: 2, num: 3 } },
      responses: {
        '0': { s1: { ok: true } },
        '1': { s1: { ok: true } }
      },
      flatQuestions: [
        { videoIndex: 0, text: 'A' },
        { videoIndex: 1, text: 'B' }
      ],
      set: { questions: [] }
    }
  });

  const rows = ctx.plScoreboard();

  assert.equal(rows[0].answered, 2);
  assert.equal(rows[0].correct, 2);
});

test('score publication keeps aggregate teacher-only and hides own score until policy allows it', async () => {
  const writes = [];
  const context = {
    pl: {
      sessionId: 'session-a',
      students: {
        s1: { name: 'A', grade: 1, klass: 1, num: 1 },
        s2: { name: 'B', grade: 1, klass: 1, num: 2 }
      },
      responses: {
        '0': { s1: { ok: true }, s2: { ok: false } }
      },
      flatQuestions: [{ type: 'choice' }],
      live: { q: 0, revealed: false },
      set: { settings: { revealMode: 'never' } }
    },
    store: {
      async writeBoard(...args) { writes.push(clone(args)); }
    },
    console
  };
  loadStageFunctions(['plScoreboard', 'plPushBoard'], context);

  await context.plPushBoard();
  context.pl.set.settings.revealMode = 'manual';
  context.pl.live.revealed = true;
  await context.plPushBoard();

  assert.deepEqual(writes, [
    ['session-a', { s1: 1, s2: 0 }, {
      s1: { uid: 's1', visible: false },
      s2: { uid: 's2', visible: false }
    }],
    ['session-a', { s1: 1, s2: 0 }, {
      s1: { uid: 's1', visible: true, score: 1, graded: 1, answered: 1, rank: 1, total: 2 },
      s2: { uid: 's2', visible: true, score: 0, graded: 1, answered: 1, rank: 2, total: 2 }
    }]
  ]);
});

test('문항 열기는 평탄화 문항의 전역 인덱스와 개별 제한 시간을 쓴다', async () => {
  let written;
  const ctx = loadStageFunctions(['limitFor', 'plOpenQuestion'], {
    pl: {
      sessionId: 'session-a',
      flatQuestions: [
        { videoIndex: 0, limitSec: null, type: 'choice', text: 'A', choices: [] },
        { videoIndex: 1, limitSec: 7, number: 2, type: 'choice', text: 'B', choices: ['가', '나'] }
      ],
      set: {
        questions: [{ limitSec: 99 }],
        settings: { autoPause: false, revealMode: 'manual', limitSec: 20 }
      },
      player: {}
    },
    SV_TS: 1234,
    FirestoreStore: {
      ...loadStoreModule(),
      createLiveToken() { return 'live-q1-token'; }
    },
    store: { setLive(id, value) { written = [id, value]; return Promise.resolve(); } }
  });

  await ctx.plOpenQuestion(1);

  assert.deepEqual(clone(written), ['session-a', {
    q: 1, liveToken: 'live-q1-token', openedAt: 1234,
    revealed: false, accepting: true, limitSec: 7,
    publicQuestion: {
      number: 2, total: 2, type: 'choice', text: 'B', choices: ['가', '나']
    }
  }]);
});

test('열린 timer 문항의 grace 전에는 교사가 다른 문항을 직접 열 수 없다', async () => {
  let writes = 0;
  let pauses = 0;
  let now = 10_000;
  const ctx = loadStageFunctions(['limitFor', 'plOpenQuestion'], {
    pl: {
      sessionId: 'session-a',
      live: { q: 0, accepting: true, submitGraceUntil: 20_000 },
      pendingLiveQuestion: -1,
      flatQuestions: [
        { type: 'choice', text: 'A', choices: [] },
        { type: 'choice', text: 'B', choices: [] }
      ],
      set: { settings: { autoPause: true, revealMode: 'timer', revealDelaySec: 5 } },
      player: { pauseVideo() { pauses += 1; } }
    },
    serverNow() { return now; },
    SV_TS: 10_000,
    FirestoreStore: loadStoreModule(),
    store: { async setLive() { writes += 1; } }
  });

  assert.equal(await ctx.plOpenQuestion(1), false);
  assert.equal(writes, 0);
  assert.equal(pauses, 0);
  assert.equal(ctx.pl.pendingLiveQuestion, -1);

  now = 21_000;
  assert.equal(await ctx.plOpenQuestion(1), true);
  assert.equal(writes, 1);
  assert.equal(pauses, 1);
});

test('교사 문항 목록은 모든 영상의 전역 번호를 이어서 렌더링한다', () => {
  const box = { innerHTML: '' };
  const ctx = loadStageFunctions(['plRenderQList'], {
    pl: {
      live: { q: -1 }, responses: {},
      flatQuestions: [
        { number: 1, videoIndex: 0, t: 10, text: '첫 영상 문항' },
        { number: 2, videoIndex: 1, t: 30, text: '둘째 영상 문항' }
      ],
      set: { questions: [{ t: 99, text: '구형 문항' }] }
    },
    $(selector) { return selector === '#pl-qlist' ? box : null; },
    fmtTime(value) { return String(value); },
    esc(value) { return String(value); }
  });

  ctx.plRenderQList();

  assert.match(box.innerHTML, /1\. 첫 영상 문항/);
  assert.match(box.innerHTML, /2\. 둘째 영상 문항/);
  assert.doesNotMatch(box.innerHTML, /구형 문항/);
});

test('다른 영상 문항으로 이동하면 로드 뒤 목표 3초 전을 기준 시각으로 유지한다', () => {
  const loads = [], seeks = [];
  const player = {
    loadVideoById(options) { loads.push(options); },
    seekTo(time) { seeks.push(time); },
    playVideo() {}
  };
  const ctx = loadStageFunctions(['plLoadVideo', 'plJumpTo'], {
    pl: {
      videoIndex: 0, fired: [true, true], lastT: 0,
      flatQuestions: [
        { videoIndex: 1, t: 15, text: '앞 문항' },
        { videoIndex: 1, t: 30, text: '목표 문항' }
      ],
      set: { videos: [
        { videoId: 'a', startSec: 0 },
        { videoId: 'b', startSec: 10 }
      ] },
      player
    }
  });

  ctx.plJumpTo(1);

  assert.deepEqual(clone(loads), [{ videoId: 'b', startSeconds: 10 }]);
  assert.deepEqual(seeks, [27]);
  assert.equal(ctx.pl.lastT, 27);
  assert.equal(ctx.pl.fired[1], false);
});

test('교사 수업 시작은 세션 정보와 코드 생성기를 저장소에 전달한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const serverTimestamp = Symbol('server timestamp');
  let received;
  let rendered = 0;
  const generated = ['SESSION12345', 'allocation-token-123456', 'OLD234', 'NEW234'];
  const context = {
    ...pendingAllocationTestContext(),
    pl: { setId: 'set1', set: { title: '오래된 세트', author: '이전 교사' } },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    $(selector) { return selector === '#pl-label' ? { value: '  2학년 3반  ' } : null; },
    lsSet() {},
    rid() { return generated.shift(); },
    SV_TS: serverTimestamp,
    store: {
      async getQuizSetSnapshot() {
        return {
          setSnapshot: { title: '첫 세트', author: '교사' },
          snapshotImages: { v0q0: 'exact-image' }
        };
      },
      async startSession(sessionId, session, createCode) {
        received = { sessionId, session, codes: [createCode(), createCode()] };
        return 'NEW234';
      }
    },
    renderPlayRun() { rendered += 1; },
    alert() {},
    console
  };
  vm.runInNewContext(extractFunction(html, 'plStartSession'), context);

  await context.plStartSession();

  assert.deepEqual(clone(received), {
    sessionId: 'SESSION12345',
    session: {
      setId: 'set1', setTitle: '첫 세트', label: '2학년 3반',
      teacher: '교사', createdAt: serverTimestamp, status: 'live',
      teacherUid: 'teacher-1', teacherEmail: 'teacher@school.kr',
      setSnapshot: { title: '첫 세트', author: '교사' },
      snapshotImages: { v0q0: 'exact-image' },
      allocationToken: 'allocation-token-123456'
    },
    codes: ['OLD234', 'NEW234']
  });
  assert.equal(context.pl.code, 'NEW234');
  assert.equal(context.pl.sessionId, 'SESSION12345');
  assert.equal(rendered, 1);
});

test('pending allocation 저장 검증 실패는 Firestore allocation 전에 시작을 중단한다', async () => {
  let backendCalls = 0;
  let message = '';
  const context = {
    ...pendingAllocationTestContext({
      pendingAllocationRemember() { return false; }
    }),
    pl: { setId: 'set1', set: { title: 'set' } },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    $() { return { value: '' }; },
    lsSet() {}, rid(length) { return length === 12 ? 'SESSION12345' : 'allocation-token-123456'; },
    store: {
      async getQuizSetSnapshot() { backendCalls += 1; throw new Error('must not read'); },
      async startSession() { backendCalls += 1; throw new Error('must not allocate'); }
    },
    alert(value) { message = value; }
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'plStartSession'
  ), context);

  assert.equal(await context.plStartSession(), null);
  assert.equal(backendCalls, 0);
  assert.match(message, /복구 정보|로컬 저장소/);
  assert.equal(context.pl.startingSession, false);
});

test('세션 할당 성공은 캡처 B를 runtime에 한 번에 재바인딩해 공개·타이밍·채점에만 사용한다', async () => {
  const setA = {
    title: 'A', author: '이전 교사',
    settings: { autoPause: false, revealMode: 'manual', limitSec: 10, revealDelaySec: 0 },
    videos: [{ videoId: 'video-a', startSec: 0, endSec: 20,
      questions: [{ t: 5, type: 'choice', text: 'A 문항', choices: ['A0', 'A1'], answer: 0 }] }]
  };
  const setB = {
    title: 'B', author: '현재 교사',
    settings: { autoPause: false, revealMode: 'manual', limitSec: 25, revealDelaySec: 0 },
    videos: [{ videoId: 'video-b', startSec: 30, endSec: 90,
      questions: [{ t: 45, type: 'choice', text: 'B 문항', choices: ['B0', 'B1'], answer: 1 }] }]
  };
  const liveWrites = [], gradeWrites = [], events = [];
  const context = {
    ...pendingAllocationTestContext(),
    pl: {
      setId: 'set1', set: setA, videos: setA.videos,
      flatQuestions: require('../playlist-core.js').flattenQuestions(setA.videos),
      fired: [true], dueQuestions: [0], live: { q: -1 }, pendingLiveQuestion: -1,
      player: { pauseVideo() {} }
    },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    teacherAuthVersion: 7,
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    FirestoreStore: loadStoreModule(), imgCache: {},
    $() { return { value: '' }; }, lsSet() {},
    rid(valueLength) { return valueLength === 12 ? 'SESSION12345' : 'NEW234'; },
    SV_TS: SERVER_TIMESTAMP,
    normSet(value) { return value; },
    limitFor(set) { return set.settings.limitSec; }, serverNow() { return 1_000; },
    isAutoGraded() { return true; },
    gradeResponse(question, response) { return Number(question.answer) === Number(response.c); },
    store: {
      async getQuizSetSnapshot() {
        return { setSnapshot: setB, snapshotImages: { v0q0: 'image-b' } };
      },
      async startSession() { events.push('allocated'); return 'NEW234'; },
      async activateSessionAllocation() { events.push('activated'); return true; },
      async setLive(sessionId, live) { liveWrites.push([sessionId, live]); },
      async gradeAnswer(...args) { gradeWrites.push(args); return true; }
    },
    renderPlayRun() { events.push('rendered'); },
    plRenderQList() {}, plRenderTimeline() {}, toast() {}, alert() {}, console
  };
  loadStageFunctions(['plStartSession', 'plOpenQuestion', 'plGradeCurrentResponses'], context);

  await context.plStartSession();

  assert.equal(context.pl.set.title, 'B');
  assert.equal(context.pl.videos[0].videoId, 'video-b');
  assert.equal(context.pl.flatQuestions[0].text, 'B 문항');
  assert.equal(context.pl.lastT, 29.4);
  assert.deepEqual(Array.from(context.pl.fired), [false]);
  assert.deepEqual(Array.from(context.pl.dueQuestions), []);
  assert.equal(context.imgCache['SESSION12345/v0q0'], 'image-b');
  assert.deepEqual(events, ['allocated', 'activated', 'rendered']);

  await context.plOpenQuestion(0);
  assert.equal(liveWrites[0][1].publicQuestion.text, 'B 문항');
  assert.equal(liveWrites[0][1].limitSec, 25);

  context.pl.live = { q: 0 };
  context.pl.responses = { '0': { studentB: { c: 1, submitted: true, revision: 4 } } };
  await context.plGradeCurrentResponses(context.pl, 0);
  assert.deepEqual(gradeWrites, [['SESSION12345', 'studentB', 0, 4, true]]);
});

test('이미지 스냅샷을 읽는 동안 승인이 취소되면 세션을 만들지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let finishImages;
  let starts = 0;
  const context = {
    ...pendingAllocationTestContext(),
    pl: { setId: 'set1', set: { title: '첫 세트', author: '교사' } },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    $() { return { value: '' }; }, lsSet() {}, rid() { return 'SESSION12345'; },
    SV_TS: Symbol('server timestamp'),
    store: {
      getImages() { return new Promise(resolve => { finishImages = resolve; }); },
      async startSession() { starts += 1; return 'NEW234'; }
    },
    renderPlayRun() {}, alert() {}, console
  };
  vm.runInNewContext(extractFunction(html, 'plStartSession'), context);

  const starting = context.plStartSession();
  context.teacherState = {
    status: 'unapproved', uid: 'teacher-1', email: 'teacher@school.kr', role: ''
  };
  finishImages({});
  await starting;

  assert.equal(starts, 0);
  assert.equal(context.pl.sessionId, undefined);
  assert.equal(context.pl.startingSession, false);
});

test('세션 할당 뒤 화면을 떠나면 exact allocation을 CAS abort한다', async () => {
  let finishStart;
  const aborted = [];
  const oldState = { setId: 'set1', set: { title: '첫 세트', author: '교사' } };
  const context = {
    ...pendingAllocationTestContext(),
    pl: oldState,
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    $() { return { value: '' }; }, lsSet() {}, rid() { return 'SESSION12345'; },
    SV_TS: Symbol('server timestamp'),
    store: {
      async getImages() { return {}; },
      startSession() { return new Promise(resolve => { finishStart = resolve; }); },
      async abortSessionAllocation(...args) { aborted.push(args); return true; }
    },
    renderPlayRun() { throw new Error('떠난 화면을 렌더하면 안 된다'); },
    alert() {}, console
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'plStartSession'
  ), context);

  const starting = context.plStartSession();
  await new Promise(resolve => setImmediate(resolve));
  context.pl = { setId: 'other' };
  finishStart('NEW234');
  await starting;

  assert.deepEqual(aborted, [[
    'SESSION12345', 'NEW234', 'teacher-1', 'SESSION12345'
  ]]);
  assert.equal(oldState.sessionId, undefined);
  assert.equal(oldState.code, undefined);
});

test('allocation 뒤 인증 교체도 abort를 시도하고 실패를 사용자에게 알린다', async () => {
  let finishStart;
  const aborted = [], notices = [];
  const context = {
    ...pendingAllocationTestContext(),
    pl: { setId: 'set1', set: { title: '첫 세트', author: '교사' } },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    teacherAuthVersion: 3,
    AuthCore: require('../auth-core.js'),
    $() { return { value: '' }; }, lsSet() {}, rid() { return 'SESSION12345'; },
    SV_TS: SERVER_TIMESTAMP,
    store: {
      async getImages() { return {}; },
      startSession() { return new Promise(resolve => { finishStart = resolve; }); },
      async abortSessionAllocation(...args) {
        aborted.push(args);
        throw new Error('permission-denied');
      }
    },
    renderPlayRun() { throw new Error('교체된 인증으로 렌더하면 안 된다'); },
    toast(message) { notices.push(message); }, alert(message) { notices.push(message); },
    console: { error() {} }
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'plStartSession'
  ), context);

  const starting = context.plStartSession();
  await new Promise(resolve => setImmediate(resolve));
  context.teacherState = {
    status: 'teacher', uid: 'teacher-2', email: 'other@school.kr', role: 'teacher'
  };
  context.teacherAuthVersion = 4;
  finishStart('NEW234');
  await starting;

  assert.deepEqual(aborted, [[
    'SESSION12345', 'NEW234', 'teacher-1', 'SESSION12345'
  ]]);
  assert.equal(notices.some(message => /정리.*실패|permission-denied/.test(message)), true);
  assert.equal(context.pl.sessionId, undefined);
});

test('activation resolve 전 auth 교체는 heartbeat·render를 막고 recovery identity를 유지한다', async () => {
  let finishActivation;
  const records = new Map();
  const aborts = [];
  let intervals = 0;
  let rendered = 0;
  const context = {
    pl: { setId: 'set1', set: { title: '세트', videos: [{ startSec: 0, questions: [] }] } },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    teacherAuthVersion: 8,
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    imgCache: {}, Date,
    $() { return { value: '' }; }, lsSet() {},
    rid(length) {
      if (length === 12) return 'SESSION12345';
      if (length === 24) return 'allocation-token-123456';
      return 'CODE12';
    },
    pendingAllocationRemember(record) { records.set(record.sessionId, clone(record)); return true; },
    pendingAllocationPatch(sessionId, patch) {
      records.set(sessionId, { ...records.get(sessionId), ...clone(patch) }); return true;
    },
    pendingAllocationRemove(sessionId) { records.delete(sessionId); return true; },
    PENDING_ALLOCATION_RECOVERY_DELAY_MS: 30_000,
    every() { intervals += 1; },
    SV_TS: SERVER_TIMESTAMP,
    normSet(value) { return value; },
    store: {
      async getQuizSetSnapshot() {
        return { setSnapshot: context.pl.set, snapshotImages: {} };
      },
      async startSession() { return 'CODE12'; },
      activateSessionAllocation() {
        return new Promise(resolve => { finishActivation = resolve; });
      },
      async abortSessionAllocation(...args) {
        aborts.push(args);
        throw new Error('permission-denied');
      },
      async renewSessionActivationLease() { throw new Error('heartbeat must not start'); }
    },
    renderPlayRun() { rendered += 1; }, toast() {}, alert() {}, console: { error() {} }
  };
  loadStageFunctions(['plStartSessionHeartbeat', 'plStartSession'], context);

  const starting = context.plStartSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.get('SESSION12345').code, 'CODE12');
  context.teacherState = {
    status: 'teacher', uid: 'teacher-2', email: 'other@school.kr', role: 'teacher'
  };
  context.teacherAuthVersion = 9;
  finishActivation(true);
  await starting;

  assert.equal(intervals, 0);
  assert.equal(rendered, 0);
  assert.equal(records.has('SESSION12345'), true);
  assert.deepEqual(aborts, [[
    'SESSION12345', 'CODE12', 'teacher-1', 'allocation-token-123456'
  ]]);
});

test('heartbeat는 single-flight이고 stale 완료 뒤 재예약하지 않으며 cleanup이 timer를 멈춘다', async () => {
  const owner = {
    status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
  };
  let nextTimerId = 0;
  const timers = new Map();
  const cleared = [];
  const cleanups = [];
  const renewCalls = [];
  let finishFirstRenew;
  const state = { sessionId: 'session-a', code: 'CODE12' };
  const context = {
    pl: state,
    teacherState: clone(owner),
    teacherAuthVersion: 12,
    AuthCore: require('../auth-core.js'),
    setTimeout(callback, ms) {
      assert.equal(ms, 5000);
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    every(ms, callback) {
      assert.equal(ms, 5000);
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { cleared.push(id); timers.delete(id); },
    onCleanup(callback) { cleanups.push(callback); },
    store: {
      renewSessionActivationLease(...args) {
        renewCalls.push(args);
        if (renewCalls.length === 1) {
          return new Promise(resolve => { finishFirstRenew = resolve; });
        }
        return Promise.resolve(true);
      }
    },
    toast() {}
  };
  loadStageFunctions(['plStartSessionHeartbeat'], context);
  context.plStartSessionHeartbeat(state, clone(owner), 12, 'allocation-token-123456');

  const firstTick = timers.get(1);
  const first = firstTick();
  const overlappingSecond = firstTick();
  const overlappingThird = firstTick();
  assert.equal(renewCalls.length, 1);
  assert.equal(await overlappingSecond, false);
  assert.equal(await overlappingThird, false);

  context.teacherState = {
    status: 'teacher', uid: 'teacher-2', email: 'other@school.kr', role: 'teacher'
  };
  context.teacherAuthVersion = 13;
  finishFirstRenew(true);
  assert.equal(await first, false);
  assert.equal(renewCalls.length, 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(cleared, [1]);

  cleanups[0]();
  assert.deepEqual(cleared, [1]);

  const currentState = { sessionId: 'session-b', code: 'CODE34' };
  context.pl = currentState;
  context.teacherState = clone(owner);
  context.teacherAuthVersion = 14;
  context.plStartSessionHeartbeat(currentState, clone(owner), 14, 'allocation-token-654321');
  assert.equal(await timers.get(2)(), true);
  assert.deepEqual(renewCalls[1], [
    'session-b', 'CODE34', 'teacher-1', 'allocation-token-654321'
  ]);
  assert.equal(timers.has(3), true);

  cleanups[1]();
  assert.equal(timers.has(3), false);
  assert.equal(cleared.includes(3), true);
});

test('current heartbeat failure schedules one non-overlapping retry', async () => {
  const owner = {
    status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
  };
  let nextTimerId = 0;
  const timers = new Map();
  const cleanups = [];
  const renewCalls = [];
  const messages = [];
  const state = { sessionId: 'session-a', code: 'CODE12' };
  const context = {
    pl: state,
    teacherState: clone(owner),
    teacherAuthVersion: 12,
    AuthCore: require('../auth-core.js'),
    setTimeout(callback, ms) {
      assert.equal(ms, 5000);
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    onCleanup(callback) { cleanups.push(callback); },
    store: {
      async renewSessionActivationLease(...args) {
        renewCalls.push(args);
        throw new Error('temporary outage');
      }
    },
    toast(message) { messages.push(message); }
  };
  loadStageFunctions(['plStartSessionHeartbeat'], context);
  context.plStartSessionHeartbeat(state, clone(owner), 12, 'allocation-token-123456');

  assert.equal(await timers.get(1)(), false);
  assert.equal(renewCalls.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(timers.has(2), true);

  cleanups[0]();
  assert.equal(timers.has(2), false);
});

test('반 코드 후보를 모두 쓴 실패는 기존 안내 문구를 유지한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let message = '';
  const context = {
    ...pendingAllocationTestContext(),
    pl: { setId: 'set1', set: { title: '첫 세트', author: '' } },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'),
    $() { return { value: '' }; },
    lsSet() {},
    rid() { return 'SESSION12345'; },
    SV_TS: Symbol('server timestamp'),
    store: {
      async startSession() {
        throw new Error('사용 가능한 반 코드를 만들지 못했습니다. 다시 시도해 주세요.');
      }
    },
    renderPlayRun() {},
    alert(value) { message = value; },
    console: { error() {} }
  };
  vm.runInNewContext(extractFunction(html, 'plStartSession'), context);

  await context.plStartSession();

  assert.equal(message, '반 코드 발급에 실패했습니다. 잠시 후 다시 시도해 주세요.');
});

test('문항 열기는 안전한 공개 문항과 현재 이미지만 쓰고 공개 때만 정답을 병합한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const serverTimestamp = Symbol('server timestamp');
  const writes = [];
  const context = {
    pl: {
      sessionId: 'session-a',
      live: { q: 2, openedAt: 123, revealed: false, limitSec: 20 },
      player: { pauseVideo() {} },
      flatQuestions: [{}, {}, {}, {
        number: 4, key: 'v1q1', type: 'choice', text: '공개 질문', choices: ['A', 'B'],
        answer: 1, explain: '정답 해설', imgUp: true
      }],
      set: { settings: { autoPause: true, revealMode: 'manual' } }
    },
    SV_TS: serverTimestamp,
    limitFor() { return 20; },
    loadQuestionImage(setId, key, sessionId) {
      assert.deepEqual([setId, key, sessionId], [undefined, 'v1q1', 'session-a']);
      return Promise.resolve('data:image/jpeg;base64,current');
    },
    FirestoreStore: {
      ...loadStoreModule(),
      createLiveToken() { return 'live-q3-token'; }
    },
    store: {
      setLive(id, value) { writes.push(['setLive', id, value]); return Promise.resolve(); },
      revealLive(id, identity, answer) {
        writes.push(['revealLive', id, identity, answer]);
        return Promise.resolve(true);
      }
    }
  };
  vm.runInNewContext(extractFunction(html, 'plOpenQuestion'), context);
  vm.runInNewContext(extractFunction(html, 'plReveal'), context);

  await context.plOpenQuestion(3);
  context.pl.live = { q: 3, openedAt: 456, revealed: false, limitSec: 20 };
  await context.plReveal();

  assert.deepEqual(clone(writes), [
    ['setLive', 'session-a', {
      q: 3,
      liveToken: 'live-q3-token',
      openedAt: serverTimestamp,
      revealed: false,
      accepting: true,
      limitSec: 20,
      publicQuestion: {
        number: 4,
        total: 4,
        type: 'choice',
        text: '공개 질문',
        choices: ['A', 'B'],
        image: 'data:image/jpeg;base64,current'
      }
    }],
    ['revealLive', 'session-a', { q: 3, openedAt: 456 }, {
      answer: 1, explain: '정답 해설'
    }]
  ]);
});

test('교사 수업 종료는 저장소 종료가 끝난 뒤 안내 화면으로 이동한다', async () => {
  const events = [];
  const context = {
    pendingAllocationRemove() { return true; },
    pl: { sessionId: 'session-a' },
    confirm() { return true; },
    document: {
      fullscreenElement: null,
      getElementById() { return null; },
      body: { classList: { remove() {} } }
    },
    store: { async endSession(id) { events.push(['end', id]); } },
    toast(message) { events.push(['toast', message]); },
    go(route) { events.push(['go', route]); }
  };
  loadStageFunctions(['plResetStageFullscreenUI', 'plExitStageFullscreen', 'plEndSession'], context);

  await context.plEndSession();

  assert.deepEqual(events, [
    ['end', 'session-a'],
    ['toast', '진행을 종료했습니다'],
    ['go', 'live/session-a']
  ]);
});

test('교사 전체화면 진입은 기존 플레이어를 재생성하지 않고 stage만 요청한다', async () => {
  let requested = 0;
  const player = { getCurrentTime() { return 42; } };
  const classes = new Set();
  const stage = {
    requestFullscreen() { requested++; return Promise.resolve(); },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); }
    }
  };
  const ctx = loadStageFunctions(['plEnterStageFullscreen'], {
    pl: { player, stageFallback: false },
    toast() {},
    plClampQrBubble() {},
    document: {
      fullscreenElement: null,
      body: { classList: stage.classList },
      getElementById(id) { return id === 'pl-stage' ? stage : null; }
    }
  });

  await ctx.plEnterStageFullscreen();

  assert.equal(requested, 1);
  assert.equal(ctx.pl.player, player);
  assert.equal(ctx.pl.player.getCurrentTime(), 42);
});

test('홈은 확인 후 전체화면만 해제하고 세션을 종료하거나 이동하지 않는다', async () => {
  let exited = 0, ended = 0, routed = 0;
  const classList = { add() {}, remove() {} };
  const ctx = loadStageFunctions(['plResetStageFullscreenUI', 'plExitStageFullscreen', 'plGoHomeFromStage'], {
    confirm() { return true; },
    document: {
      fullscreenElement: {},
      exitFullscreen() { exited++; return Promise.resolve(); },
      getElementById() { return { classList }; },
      body: { classList }
    },
    store: { endSession() { ended++; } },
    go() { routed++; },
    pl: { sessionId: 'session1' }
  });

  await ctx.plGoHomeFromStage();

  assert.equal(exited, 1);
  assert.equal(ended, 0);
  assert.equal(routed, 0);
  assert.ok(ctx.pl);
});

test('전체화면 요청 거부와 미지원은 모두 화면 확장 모드로 전환한다', async () => {
  for (const requestFullscreen of [
    () => Promise.reject(new Error('denied')),
    undefined
  ]) {
    const stageClasses = new Set();
    const bodyClasses = new Set();
    const messages = [];
    const stage = {
      requestFullscreen,
      classList: {
        add(name) { stageClasses.add(name); },
        remove(name) { stageClasses.delete(name); }
      }
    };
    const ctx = loadStageFunctions(['plEnterStageFullscreen'], {
      pl: { stageFallback: false, isStageFullscreen: false },
      toast(message) { messages.push(message); },
      plClampQrBubble() {},
      document: {
        body: { classList: {
          add(name) { bodyClasses.add(name); },
          remove(name) { bodyClasses.delete(name); }
        } },
        getElementById() { return stage; }
      }
    });

    await ctx.plEnterStageFullscreen();

    assert.equal(ctx.pl.stageFallback, true);
    assert.equal(ctx.pl.isStageFullscreen, true);
    assert.equal(stageClasses.has('fullscreen-fallback'), true);
    assert.equal(bodyClasses.has('stage-fallback-open'), true);
    assert.equal(messages.length, 1);
  }
});

test('fullscreenchange로 stage를 벗어나면 UI 상태와 잠금만 정리한다', () => {
  let ended = 0, routed = 0;
  const stageClasses = new Set(['fullscreen-fallback']);
  const bodyClasses = new Set(['stage-fallback-open']);
  const stage = { classList: { remove(name) { stageClasses.delete(name); } } };
  const ctx = loadStageFunctions(['plResetStageFullscreenUI', 'plHandleFullscreenChange'], {
    pl: { isStageFullscreen: true, stageFallback: true },
    store: { endSession() { ended++; } },
    go() { routed++; },
    plClampQrBubble() {},
    document: {
      fullscreenElement: null,
      getElementById() { return stage; },
      body: { classList: { remove(name) { bodyClasses.delete(name); } } }
    }
  });

  ctx.plHandleFullscreenChange();

  assert.equal(stageClasses.has('fullscreen-fallback'), false);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
  assert.equal(ctx.pl.isStageFullscreen, false);
  assert.equal(ctx.pl.stageFallback, false);
  assert.equal(ended, 0);
  assert.equal(routed, 0);
});

test('fullscreenchange는 진입과 해제 모두에서 QR 버블 위치를 다시 보정한다', () => {
  let clamped = 0;
  const stage = { classList: { remove() {} } };
  const ctx = loadStageFunctions(['plResetStageFullscreenUI', 'plHandleFullscreenChange'], {
    pl: { isStageFullscreen: false, stageFallback: false },
    plClampQrBubble() { clamped++; },
    document: {
      fullscreenElement: stage,
      getElementById() { return stage; },
      body: { classList: { remove() {} } }
    }
  });

  ctx.plHandleFullscreenChange();
  ctx.document.fullscreenElement = null;
  ctx.plHandleFullscreenChange();

  assert.equal(clamped, 2);
});

test('Escape는 fallback 전체화면만 해제하고 세션과 라우팅을 유지한다', async () => {
  let ended = 0, routed = 0, prevented = 0;
  const bodyClasses = new Set(['stage-fallback-open']);
  const stageClasses = new Set(['fullscreen-fallback']);
  const stage = { classList: { remove(name) { stageClasses.delete(name); } } };
  const ctx = loadStageFunctions([
    'plResetStageFullscreenUI', 'plExitStageFullscreen', 'plHandleStageKeydown'
  ], {
    pl: { sessionId: 'session1', isStageFullscreen: true, stageFallback: true },
    store: { endSession() { ended++; } },
    go() { routed++; },
    document: {
      fullscreenElement: null,
      getElementById() { return stage; },
      body: { classList: { remove(name) { bodyClasses.delete(name); } } }
    }
  });

  await ctx.plHandleStageKeydown({ key: 'Escape', preventDefault() { prevented++; } });

  assert.equal(prevented, 1);
  assert.equal(stageClasses.has('fullscreen-fallback'), false);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
  assert.equal(ended, 0);
  assert.equal(routed, 0);
});

test('진행 종료는 전체화면 UI를 정리한 뒤 기존 순서로 세션을 종료한다', async () => {
  const events = [];
  const bodyClasses = new Set(['stage-fallback-open']);
  const stageClasses = new Set(['fullscreen-fallback']);
  const stage = { classList: { remove(name) { stageClasses.delete(name); } } };
  const ctx = loadStageFunctions([
    'plResetStageFullscreenUI', 'plExitStageFullscreen', 'plEndSession'
  ], {
    pendingAllocationRemove() { return true; },
    pl: { sessionId: 'session-a', isStageFullscreen: true, stageFallback: true },
    confirm() { return true; },
    document: {
      fullscreenElement: null,
      getElementById() { return stage; },
      body: { classList: { remove(name) { bodyClasses.delete(name); } } }
    },
    store: { async endSession(id) { events.push(['end', id]); } },
    toast(message) { events.push(['toast', message]); },
    go(route) { events.push(['go', route]); }
  });

  await ctx.plEndSession();

  assert.equal(stageClasses.has('fullscreen-fallback'), false);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
  assert.deepEqual(events, [
    ['end', 'session-a'],
    ['toast', '진행을 종료했습니다'],
    ['go', 'live/session-a']
  ]);
});

test('브라우저 전체화면 해제가 실패해도 Firestore 세션 종료와 라우팅은 계속한다', async () => {
  const events = [];
  const bodyClasses = new Set(['stage-fallback-open']);
  const stageClasses = new Set(['fullscreen-fallback']);
  const stage = { classList: { remove(name) { stageClasses.delete(name); } } };
  const ctx = loadStageFunctions([
    'plResetStageFullscreenUI', 'plExitStageFullscreen', 'plEndSession'
  ], {
    pendingAllocationRemove() { return true; },
    pl: { sessionId: 'session-a', isStageFullscreen: true, stageFallback: true },
    confirm() { return true; },
    document: {
      fullscreenElement: stage,
      exitFullscreen() { return Promise.reject(new Error('exit denied')); },
      getElementById() { return stage; },
      body: { classList: { remove(name) { bodyClasses.delete(name); } } }
    },
    store: { async endSession(id) { events.push(['end', id]); } },
    toast(message) { events.push(['toast', message]); },
    go(route) { events.push(['go', route]); },
    console: { warn() {} }
  });

  await ctx.plEndSession();

  assert.equal(stageClasses.has('fullscreen-fallback'), false);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
  assert.deepEqual(events, [
    ['end', 'session-a'],
    ['toast', '진행을 종료했습니다'],
    ['go', 'live/session-a']
  ]);
});

test('교사 화면 cleanup은 전체화면 잠금과 이벤트를 함께 정리한다', () => {
  let cleanup;
  const listeners = new Map();
  const windowListeners = new Map();
  const removed = [];
  const bodyClasses = new Set(['stage-fallback-open']);
  const context = {
    pl: null,
    onCleanup(fn) { cleanup = fn; },
    document: {
      fullscreenElement: null,
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) removed.push(name); },
      getElementById() { return null; },
      body: { classList: { remove(name) { bodyClasses.delete(name); } } }
    },
    window: {
      addEventListener(name, fn) { windowListeners.set(name, fn); },
      removeEventListener(name, fn) { if (windowListeners.get(name) === fn) removed.push(name); }
    },
    store: { getQuizSet() { return new Promise(() => {}); } },
    APP() { return { innerHTML: '' }; },
    topbar() { return ''; },
    go() {},
    console
  };
  loadStageFunctions([
    'plResetStageFullscreenUI', 'plCleanupStageFullscreen',
    'plHandleFullscreenChange', 'plHandleStageKeydown', 'plClampQrBubble', 'screenPlay'
  ], context);

  context.screenPlay('set1');
  cleanup();

  assert.deepEqual([...listeners.keys()].sort(), ['fullscreenchange', 'keydown']);
  assert.deepEqual([...windowListeners.keys()], ['resize']);
  assert.deepEqual(removed.sort(), ['fullscreenchange', 'keydown', 'resize']);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
  assert.equal(context.pl, null);
});

test('학생 목록 렌더링은 열린 QR 버블의 참여 수도 함께 갱신한다', () => {
  let rendered = 0;
  const ctx = loadStageFunctions(['plRenderStudents'], {
    pl: { set: { questions: [] } },
    $() { return null; },
    plScoreboard() { return []; },
    plRenderQrBubble() { rendered++; }
  });

  ctx.plRenderStudents();

  assert.equal(rendered, 1);
});

test('음소거 해제는 이전 음량이 0이어도 그대로 복원한다', () => {
  let restored = null;
  const ctx = loadStageFunctions(['plToggleMute'], {
    pl: {
      previousVolume: 0,
      player: {
        isMuted() { return true; },
        unMute() {},
        setVolume(value) { restored = value; }
      }
    },
    plRenderStageControls() {},
    console
  });

  ctx.plToggleMute();

  assert.equal(restored, 0);
});

test('QR 버블 열기와 닫기는 영상과 live 상태를 변경하지 않는다', () => {
  let paused = 0, liveWrites = 0;
  const player = { pauseVideo() { paused++; } };
  const ctx = loadStageFunctions(['plToggleQrBubble'], {
    store: { setLive() { liveWrites++; } },
    pl: { qrOpen: false, player, live: { q: 0, openedAt: 1000 } },
    plRenderQrBubble() {}
  });

  ctx.plToggleQrBubble();
  ctx.plToggleQrBubble();

  assert.equal(paused, 0);
  assert.equal(liveWrites, 0);
  assert.deepEqual(ctx.pl.live, { q: 0, openedAt: 1000 });
});

test('학생 수 변경은 열린 QR 버블의 참여 인원을 갱신한다', () => {
  const count = { textContent: '' };
  const ctx = loadStageFunctions(['plRenderQrBubble'], {
    pl: { students: { a: {}, b: {} }, qrOpen: true, code: 'ABC123' },
    document: { getElementById(id) { return id === 'pl-qr-count' ? count : {}; } },
    linkTo() { return 'https://example/#/join/ABC123'; },
    esc(value) { return String(value); }
  });
  ctx.plRenderQrBubble();
  assert.equal(count.textContent, '참여 2명');
});

test('열린 QR 버블은 stage 안에 한 번만 생성하고 같은 참여 링크를 표시한다', () => {
  const appended = [];
  const nodes = {};
  const stage = {
    clientWidth: 800, clientHeight: 600,
    appendChild(node) { appended.push(node); nodes[node.id] = node; }
  };
  const head = { addEventListener() {} };
  const qrCode = {};
  const count = { textContent: '' };
  const ctx = loadStageFunctions([
    'plClampQrBubble', 'plStartQrDrag', 'plMoveQrDrag', 'plEndQrDrag', 'plRenderQrBubble'
  ], {
    pl: { students: { a: {} }, qrOpen: true, code: 'ABC123', qrPosition: null },
    document: {
      getElementById(id) {
        if (id === 'pl-stage') return stage;
        if (id === 'pl-qr-count') return count;
        if (id === 'pl-qr-code') return qrCode;
        return nodes[id] || null;
      },
      createElement() {
        return {
          id: '', innerHTML: '', style: {}, offsetWidth: 180, offsetHeight: 240,
          setAttribute() {},
          querySelector(selector) { return selector === '.pl-qr-head' ? head : null; }
        };
      }
    },
    window: { TeacherStage: require('../teacher-stage.js') },
    linkTo() { return 'https://example.test/#/join/ABC123'; },
    esc(value) { return String(value); }
  });

  ctx.plRenderQrBubble();
  ctx.plRenderQrBubble();

  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, 'pl-qr-bubble');
  assert.match(appended[0].innerHTML, /학생 참여/);
  assert.match(appended[0].innerHTML, /ABC123/);
  assert.match(appended[0].innerHTML, /example\.test\/#\/join\/ABC123/);
  assert.equal(count.textContent, '참여 1명');
});

test('QR 헤더 포인터 드래그는 stage 경계 안에서 버블 위치를 갱신한다', () => {
  let captured = null;
  const bubble = { offsetWidth: 100, offsetHeight: 80, style: {} };
  const stage = { clientWidth: 300, clientHeight: 200 };
  const ctx = loadStageFunctions(['plStartQrDrag', 'plMoveQrDrag', 'plEndQrDrag'], {
    pl: { qrPosition: { x: 100, y: 60 }, qrDrag: null },
    document: { getElementById(id) { return id === 'pl-stage' ? stage : bubble; } },
    window: { TeacherStage: require('../teacher-stage.js') }
  });
  const target = { setPointerCapture(id) { captured = id; } };

  ctx.plStartQrDrag({ pointerId: 7, clientX: 10, clientY: 20, button: 0, currentTarget: target });
  ctx.plMoveQrDrag({ pointerId: 7, clientX: 500, clientY: 500 });

  assert.equal(captured, 7);
  assert.deepEqual(ctx.pl.qrPosition, { x: 184, y: 104 });
  assert.equal(bubble.style.left, '184px');
  assert.equal(bubble.style.top, '104px');

  ctx.plEndQrDrag({ pointerId: 7 });
  assert.equal(ctx.pl.qrDrag, null);
});

test('QR 닫기 버튼의 포인터 입력은 헤더 드래그를 시작하거나 포인터를 가로채지 않는다', () => {
  let captured = 0;
  const closeButton = { closest(selector) { return selector === 'button, a, input, select, textarea' ? this : null; } };
  const ctx = loadStageFunctions(['plStartQrDrag'], {
    pl: { qrPosition: null, qrDrag: null },
    document: { getElementById() { return { offsetLeft: 20, offsetTop: 20 }; } }
  });

  ctx.plStartQrDrag({
    pointerId: 8, clientX: 10, clientY: 10, button: 0,
    target: closeButton,
    currentTarget: { setPointerCapture() { captured++; } }
  });

  assert.equal(ctx.pl.qrDrag, null);
  assert.equal(captured, 0);
});

test('stage 포인터 입력은 전체화면 도구를 잠시 선명하게 표시한다', () => {
  const classes = new Set();
  let scheduled = null;
  const stage = { classList: {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); }
  } };
  const ctx = loadStageFunctions(['plActivateStageControls'], {
    document: { getElementById(id) { return id === 'pl-stage' ? stage : null; } },
    clearTimeout() {},
    setTimeout(callback) { scheduled = callback; return 1; }
  });

  ctx.plActivateStageControls();
  assert.equal(classes.has('controls-active'), true);

  scheduled();
  assert.equal(classes.has('controls-active'), false);
});

test('stage 크기 변경은 열린 QR 버블을 새 경계 안으로 되돌린다', () => {
  const bubble = { hidden: false, offsetWidth: 100, offsetHeight: 80, style: {} };
  const stage = { clientWidth: 300, clientHeight: 200 };
  const ctx = loadStageFunctions(['plClampQrBubble'], {
    pl: { qrPosition: { x: 250, y: 150 } },
    document: { getElementById(id) { return id === 'pl-stage' ? stage : bubble; } },
    window: { TeacherStage: require('../teacher-stage.js') }
  });

  ctx.plClampQrBubble();

  assert.deepEqual(ctx.pl.qrPosition, { x: 184, y: 104 });
  assert.equal(bubble.style.left, '184px');
  assert.equal(bubble.style.top, '104px');
});

test('문제와 순위 오버레이는 전체화면 stage 안에 생성된다', () => {
  const appended = [];
  const stageClasses = new Set();
  const stage = {
    appendChild(node) { appended.push(node); },
    classList: {
      add(name) { stageClasses.add(name); },
      remove(name) { stageClasses.delete(name); }
    }
  };
  const body = { appendChild() { throw new Error('body에 붙이면 안 됨'); } };
  const ctx = loadStageFunctions(['plStageRoot', 'plRenderOverlay', 'plToggleBoard'], {
    pl: {
      live: { q: 0 }, students: {}, responses: {},
      closeFlight: { questionIndex: 0 }, closeError: 'board offline',
      flatQuestions: [{ type: 'choice', text: '문제', choices: ['1', '2'] }],
      set: {
        title: '세트', settings: { revealMode: 'manual' },
        questions: []
      }
    },
    document: {
      body,
      getElementById(id) { return id === 'pl-stage' ? stage : null; },
      createElement() { return { id: '', innerHTML: '', querySelector() { return null; } }; }
    },
    qType() { return 'choice'; },
    isTextType() { return false; }, hasImage() { return false; },
    esc(value) { return String(value); }, LETTERS: ['A', 'B'], QTYPES: {},
    plRenderOverlayCounts() {}, plRenderQList() {}, plRenderBoardOverlay() {},
    plScoreboard() { return []; }
  });

  ctx.plRenderOverlay();
  ctx.plToggleBoard();

  assert.deepEqual(appended.map(node => node.id), ['overlay', 'board-overlay']);
  assert.equal(stageClasses.has('quiz-open'), true);
  assert.match(appended[0].innerHTML, /종료 저장 실패: board offline/);
  assert.match(appended[0].innerHTML, /disabled aria-busy="true"/);
  assert.match(appended[0].innerHTML, /저장 중…/);
});

test('전체화면 문제 레이아웃은 같은 player-box와 중앙 카드를 유지한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ctx = loadStageFunctions(['plStagePlayerGeometry'], {});
  const hd = ctx.plStagePlayerGeometry(1920, 1080, 176);
  const portrait = ctx.plStagePlayerGeometry(1000, 1000, 176);

  assert.equal(Math.round(hd.height), 904);
  assert.equal(Math.round(hd.width / hd.height * 1000), 1778);
  assert.equal(Math.round(portrait.width), 920);
  assert.equal(Math.round(portrait.width / portrait.height * 1000), 1778);
  assert.match(html, /width:\s*var\(--pl-player-width,[^;]+;\s*height:\s*var\(--pl-player-height,/s);
  assert.match(html, /#pl-stage:fullscreen \.player-box,[\s\S]*aspect-ratio:\s*16\s*\/\s*9[^}]*flex:\s*none/);
  assert.match(html, /#pl-stage\.quiz-open \.player-box\s*\{[^}]*filter:\s*brightness\(\.42\)/s);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open\s+\.player-box\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open\s+\.player-box\s*\{[^}]*width:/s);
  assert.match(html, /#pl-stage\.quiz-open #overlay\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*top:\s*50%[^}]*transform:\s*translate\(-50%,\s*-50%\)[^}]*width:\s*min\(64vw,\s*960px\)/s);
  assert.match(html, /@media \(max-width:\s*900px\)[\s\S]*#pl-stage\.quiz-open #overlay\s*\{[^}]*width:\s*calc\(100% - 32px\)/);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open #overlay\s*\{[^}]*left:\s*53vw/s);
});

test('중앙 문제·순위 카드 위에서 교사 도구와 QR을 조작하고 타임라인은 흐름을 유지한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const overlayRule = html.match(/^#overlay\s*\{([^}]*)\}/ms);
  const toolsRule = html.match(/#pl-stage\.quiz-open\s+\.pl-stage-tools\s*\{([^}]*)\}/s);
  const bubbleRule = html.match(/#pl-stage\s+#pl-qr-bubble\s*\{([^}]*)\}/s);
  const timelineRule = html.match(/#pl-quiz-timeline\s*\{([^}]*)\}/s);
  const boardRule = html.match(/^#board-overlay\s*\{([^}]*)\}/ms);
  const rankToolsRule = html.match(/#pl-stage\.rank-open\s+\.pl-stage-tools\s*\{([^}]*)\}/s);

  assert.ok(overlayRule && toolsRule && bubbleRule && timelineRule && boardRule && rankToolsRule);
  const overlayZ = Number(overlayRule[1].match(/z-index:\s*(\d+)/)[1]);
  const toolsZ = Number(toolsRule[1].match(/z-index:\s*(\d+)/)[1]);
  const bubbleZ = Number(bubbleRule[1].match(/z-index:\s*(\d+)/)[1]);
  const boardZ = Number(boardRule[1].match(/z-index:\s*(\d+)/)[1]);

  assert.ok(toolsZ > overlayZ);
  assert.ok(bubbleZ > overlayZ);
  assert.ok(toolsZ > boardZ);
  assert.ok(bubbleZ > boardZ);
  assert.match(html, /<button class="btn sm" onclick="plToggleQrBubble\(\)"[^>]*>▦ QR<\/button>/);
  assert.match(html, /aria-label="QR 닫기" onclick="plToggleQrBubble\(\)"/);
  assert.match(bubbleRule[1], /right:\s*20px/);
  assert.match(bubbleRule[1], /top:\s*20px/);
  assert.match(toolsRule[1], /position:\s*fixed/);
  assert.match(toolsRule[1], /top:\s*16px/);
  assert.match(timelineRule[1], /position:\s*relative/);
  assert.doesNotMatch(timelineRule[1], /position:\s*(?:fixed|absolute)/);
  assert.match(boardRule[1], /left:\s*50%[^}]*top:\s*50%[^}]*width:\s*min\(64vw,\s*960px\)/s);
  assert.match(rankToolsRule[1], /z-index:\s*202/);
  assert.doesNotMatch(toolsRule[1] + bubbleRule[1], /pointer-events:\s*none/);
});

test('계속 재생은 전체화면을 유지하고 같은 플레이어를 재생한다', async () => {
  let writes = 0, played = 0, exits = 0;
  const player = { playVideo() { played++; } };
  const ctx = loadStageFunctions(['plOpenNextDueQuestion', 'plCloseQuestion'], {
    pl: { sessionId: 'session1', live: { q: 0 }, liveGeneration: 1, player },
    plGradeCurrentResponses() { return Promise.resolve(); },
    plPushBoard() { return Promise.resolve(); },
    document: { fullscreenElement: {}, exitFullscreen() { exits++; } },
    FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; },
      closeLive() { writes++; return Promise.resolve(true); }
    }
  });

  await ctx.plCloseQuestion();

  assert.equal(writes, 1);
  assert.equal(played, 1);
  assert.equal(exits, 0);
  assert.equal(ctx.pl.player, player);
});

test('문항 닫기는 현재 점수판을 한 번 쓴 뒤 live를 닫는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    pl: {
      sessionId: 'session-a', live: { q: 0 }, liveGeneration: 1,
      player: { playVideo() { calls.push('play'); } }
    },
    plGradeCurrentResponses() { return Promise.resolve(); },
    plPushBoard() { calls.push('board'); return Promise.resolve(); },
    FirestoreCore: core,
    store: {
      async freezeLive() { calls.push('freeze'); return true; },
      async getResponses() { return {}; },
      async getGrades() { return {}; },
      closeLive(id, identity) {
        calls.push(['live', id, identity]);
        return Promise.resolve(true);
      }
    }
  };
  vm.runInNewContext(extractFunction(html, 'plOpenNextDueQuestion'), context);
  vm.runInNewContext(extractFunction(html, 'plCloseQuestion'), context);

  await context.plCloseQuestion();

  assert.equal(calls.filter(call => call === 'board').length, 1);
  assert.deepEqual(clone(calls[2]), ['live', 'session-a', { q: 0, openedAt: undefined }]);
  assert.equal(calls[3], 'play');
});

test('정답 공개 전 교사 오버레이는 제출 인원만 보이고 정답과 보기별 수를 숨긴다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const count = { textContent: '' };
  const explain = { style: {} };
  const reveal = { disabled: false, textContent: '' };
  const choices = [0, 1].map(index => {
    const bar = { style: {} };
    const number = { textContent: '' };
    const classes = new Set();
    return {
      dataset: { c: String(index) }, bar, number, classes,
      querySelector(selector) { return selector === '.bar' ? bar : number; },
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } }
    };
  });
  const overlay = {
    querySelector(selector) {
      if (selector === '#ov-count') return count;
      if (selector === '#ov-explain-top') return explain;
      if (selector === '#ov-reveal') return reveal;
      return null;
    }
  };
  const context = {
    pl: {
      live: { q: 0, revealed: false },
      students: { s1: {}, s2: {} },
      responses: { '0': { s1: { c: 1 }, s2: { c: 0 } } },
      flatQuestions: [{ type: 'choice', choices: ['오답', '정답'], answer: 1 }],
      set: {
        settings: { revealMode: 'manual' },
        questions: []
      }
    },
    document: { getElementById() { return overlay; } },
    qType() { return 'choice'; },
    isTextType() { return false; },
    parseMulti() { return []; },
    plRevealed() { return false; },
    $$(selector) { return selector === '.ov-choice' ? choices : []; },
    FirestoreCore: core
  };
  vm.runInNewContext(extractFunction(html, 'plRenderOverlayCounts'), context);

  context.plRenderOverlayCounts();

  const rendered = JSON.stringify({
    count: count.textContent,
    choices: choices.map(choice => ({
      width: choice.bar.style.width,
      number: choice.number.textContent,
      correct: choice.classes.has('correct')
    }))
  });
  assert.match(rendered, /참여 2명 · 제출 2명 · 미제출 0명/);
  assert.doesNotMatch(rendered, /1명|50%|"correct":true/);
});

test('centered overlay preserves the player node and only toggles stage presentation', () => {
  const player = { id: 'pl-player' };
  const classes = new Set();
  const stage = {
    querySelector(selector) { return selector === '#pl-player' ? player : null; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); }
    }
  };
  const ctx = loadStageFunctions(['plStageRoot', 'plRenderCenteredOverlay'], {
    document: { getElementById() { return stage; }, body: {} }
  });

  assert.equal(ctx.plRenderCenteredOverlay(true), stage);
  assert.equal(classes.has('quiz-open'), true);
  assert.equal(stage.querySelector('#pl-player'), player);
  ctx.plRenderCenteredOverlay(false);
  assert.equal(classes.has('quiz-open'), false);
  assert.equal(stage.querySelector('#pl-player'), player);
});

test('quiz timeline maps progress and question markers to the active video range', () => {
  let writes = 0;
  const progress = { style: {} };
  const remaining = { textContent: '' };
  const timeline = {
    _html: '',
    set innerHTML(value) { writes += 1; this._html = value; },
    get innerHTML() { return this._html; },
    querySelector(selector) {
      if (selector === '.pl-timeline-progress') return progress;
      if (selector === '.pl-timeline-next') return remaining;
      return null;
    }
  };
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plTimelineDomain', 'plUpdateTimeline', 'plRenderTimeline'], {
    pl: {
      videoIndex: 0,
      set: { videos: [{ startSec: 120, endSec: 620 }] },
      flatQuestions: [
        { videoIndex: 0, t: 170, number: 1 },
        { videoIndex: 0, t: 220, number: 2 },
        { videoIndex: 0, t: 370, number: 3 },
        { videoIndex: 1, t: 15, number: 4 }
      ],
      live: { q: 1 }, fired: [true, true, false, false],
      player: { getCurrentTime() { return 220; }, getDuration() { return 900; } }
    },
    PlaylistCore: require('../playlist-core.js'),
    document: { getElementById(id) { return id === 'pl-quiz-timeline' ? timeline : null; } },
    fmtTime(value) { return Math.round(value) + 's'; }
  });

  ctx.plRenderTimeline();

  assert.equal(writes, 1);
  assert.equal(progress.style.width, '20%');
  assert.match(timeline.innerHTML, /pl-timeline-marker completed[^>]*left:10%/);
  assert.match(timeline.innerHTML, /pl-timeline-marker current[^>]*left:20%/);
  assert.match(timeline.innerHTML, /pl-timeline-marker upcoming[^>]*left:50%/);
  assert.doesNotMatch(timeline.innerHTML, /left:-?21%/);
  assert.match(timeline.innerHTML, /pl-timeline-announcement[^>]*aria-live="polite"/);
  assert.doesNotMatch(timeline.innerHTML, /pl-timeline-next[^>]*aria-live/);
  assert.equal(remaining.textContent, '다음 문제 3 · 150초');

  ctx.plUpdateTimeline(270, ctx.plTimelineDomain());
  assert.equal(writes, 1, 'ticks update progress and text without rebuilding markers');
  assert.equal(progress.style.width, '30%');
  assert.equal(remaining.textContent, '다음 문제 3 · 100초');

  ctx.pl.fired[0] = false;
  ctx.plRenderTimeline();
  assert.equal(writes, 2, 'marker status changes rebuild structure once');
  assert.match(timeline.innerHTML, /pl-timeline-marker upcoming[^>]*left:10%/);
});

test('quiz timeline uses player duration when the active video has no end time', () => {
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plTimelineDomain'], {
    pl: {
      videoIndex: 0,
      set: { videos: [{ startSec: 30, endSec: null }] },
      player: { getDuration() { return 330; } }
    }
  });

  assert.deepEqual(clone(ctx.plTimelineDomain()), { start: 30, end: 330 });
});

test('video switch rebuilds quiz timeline markers for the new active video', () => {
  let renders = 0;
  const loads = [];
  const ctx = loadStageFunctions(['plLoadVideo'], {
    pl: {
      videoIndex: 0, playlistDone: false, transitionUntil: 0,
      loadGeneration: 1, activePlaybackGeneration: 1, expectedVideoId: 'old',
      set: { videos: [{ videoId: 'first', startSec: 0 }, { videoId: 'second', startSec: 40 }] },
      player: { loadVideoById(value) { loads.push(value); } }
    },
    document: { getElementById() { return null; } },
    plRenderTimeline() { renders += 1; }
  });

  ctx.plLoadVideo(1, true);

  assert.equal(renders, 1);
  assert.deepEqual(clone(loads), [{ videoId: 'second', startSeconds: 40 }]);
});

test('timeline defers null-end markers until duration is known and does not rebuild again on PLAYING', () => {
  let duration = 0;
  let state = 5;
  let writes = 0;
  const timeline = {
    _html: '<div class="old-marker"></div>',
    set innerHTML(value) { writes += 1; this._html = value; },
    get innerHTML() { return this._html; },
    querySelector() { return null; }
  };
  const player = {
    getVideoData() { return { video_id: 'second' }; },
    getPlayerState() { return state; },
    getCurrentTime() { return 40; },
    getDuration() { return duration; },
    loadVideoById() {}
  };
  const ctx = loadStageFunctions([
    'plEffectiveEnd', 'plTimelineDomain', 'plUpdateTimeline', 'plRenderTimeline', 'plLoadVideo',
    'plPlayerEventVideoId', 'plPlayerEventStatus', 'plHandlePlayerStateChange'
  ], {
    pl: {
      videoIndex: 0, playlistDone: false, transitionUntil: 0,
      loadGeneration: 1, activePlaybackGeneration: 1, expectedVideoId: 'first',
      playbackEnded: false, playerLoading: false, playerError: null,
      live: { q: -1 }, fired: [false],
      flatQuestions: [{ videoIndex: 1, t: 190, number: 1 }],
      set: { videos: [{ videoId: 'first', startSec: 0 }, { videoId: 'second', startSec: 40, endSec: null }] },
      player
    },
    PlaylistCore: require('../playlist-core.js'),
    document: { getElementById(id) { return id === 'pl-quiz-timeline' ? timeline : null; } },
    fmtTime(value) { return Math.round(value) + 's'; },
    YT: { PlayerState: { ENDED: 0, PLAYING: 1, CUED: 5 } },
    plTick() {}
  });

  ctx.plLoadVideo(1, true);
  assert.equal(timeline.innerHTML, '');
  assert.doesNotMatch(timeline.innerHTML, /pl-timeline-marker/);

  duration = 340;
  ctx.plHandlePlayerStateChange({ data: 5, target: player });
  const writesAfterCued = writes;
  assert.match(timeline.innerHTML, /pl-timeline-marker upcoming[^>]*left:50%/);

  state = 1;
  ctx.plHandlePlayerStateChange({ data: 1, target: player });
  assert.equal(writes, writesAfterCued);
});

test('rewind and jump rebuild marker states once only when fired changes', () => {
  let now = 10;
  let renders = 0;
  const player = {
    getCurrentTime() { return now; },
    getDuration() { return 100; },
    seekTo() {}, playVideo() {}
  };
  const ctx = loadStageFunctions(['plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick', 'plJumpTo'], {
    pl: {
      videoIndex: 0, lastT: 50, fired: [true], playlistDone: false,
      playerLoading: false, playerError: null, playbackEnded: false,
      transitionUntil: 0, pendingLiveQuestion: -1, live: { q: -1 },
      flatQuestions: [{ videoIndex: 0, t: 20, number: 1 }],
      set: { videos: [{ videoId: 'first', startSec: 0, endSec: 100 }] },
      player
    },
    $(selector) { return selector === '#pl-next' ? { textContent: '' } : null; },
    fmtTime(value) { return String(value); },
    plRenderTimeline() { renders += 1; },
    plOpenQuestion() {}, plCompletePlaylist() {}, plRenderTransition() {}, Date
  });

  ctx.plTick();
  assert.equal(ctx.pl.fired[0], false);
  assert.equal(renders, 1);

  ctx.plTick();
  ctx.plJumpTo(0);
  assert.equal(renders, 1);

  ctx.pl.fired[0] = true;
  ctx.plJumpTo(0);
  assert.equal(renders, 2);
});

test('Firestore 초기화 구간은 ref 없는 Firestore 인스턴스에서도 중단되지 않는다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('"use strict";');
  const utilitiesHeading = html.indexOf('   1. 공용 유틸', start);
  const end = html.lastIndexOf('/*', utilitiesHeading);
  assert.ok(start >= 0 && utilitiesHeading >= 0 && end > start, 'Firebase 초기화 구간을 찾을 수 있어야 한다');

  const firestore = () => Object.freeze({ kind: 'firestore' });
  firestore.FieldValue = { serverTimestamp: () => ({ kind: 'server-timestamp' }) };
  const firebase = {
    apps: [],
    initializeApp() { this.apps.push({}); },
    firestore
  };
  const context = {
    firebase,
    FirestoreStore: {
      createFirestoreStore() { return { serverNow: () => 1_000 }; }
    },
    document: {
      getElementById() { return null; },
      createElement() { return {}; },
      body: { appendChild() {} }
    },
    setInterval() { return 1; }
  };

  assert.doesNotThrow(() => vm.runInNewContext(html.slice(start, end), context));
});

test('새 답은 같은 학생 문서의 다른 문항 답을 보존한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': { answers: { '0': { c: 1, ok: true } } }
  });
  const store = createStore(fake);

  await store.mergeAnswer('a', 's1', 2, {
    answer: '서술', submitted: true, revision: 2, submittedAt: SERVER_TIMESTAMP
  });

  const answers = await store.getOwnResponses('a', 's1');
  assert.deepEqual({
    ...answers,
    '2': { ...answers['2'], submittedAt: answers['2'].submittedAt.toMillis() }
  }, {
    '0': { c: 1 },
    '2': { answer: '서술', submitted: true, revision: 2, submittedAt: 50_000 }
  });
});

test('응답 제출 상태는 현재 문항만 병합하고 다시 고르는 답도 보존한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': { answers: { '0': { c: 0, submitted: true } } }
  });
  const store = createStore(fake);

  await store.setAnswerState('a', 's1', 2, {
    answer: 1, submitted: false, revision: 2
  });

  assert.deepEqual(await store.getOwnResponses('a', 's1'), {
    '0': { c: 0, submitted: true },
    '2': { answer: 1, submitted: false, revision: 2 }
  });
});

test('학생 단발 조회는 코드·세션·본인 문서·점수판의 정해진 경로만 읽는다', async () => {
  const fake = makeFirestoreFake({
    'codes/ABC234': { sessionId: 'a' },
    'sessions/a': { setId: 'set1', status: 'live' },
    'sessions/a/students/s1': { name: '가' },
    'sessions/a/responses/s1': { answers: { '0': { c: 1 } } },
    'sessions/a/meta/board': { scores: { s1: 1 } },
    'sessions/a/responses/s2': { answers: { '0': { c: 0 } } }
  });
  const store = createStore(fake);

  assert.equal((await store.getCode('ABC234')).sessionId, 'a');
  assert.equal((await store.getSession('a')).setId, 'set1');
  assert.equal((await store.getStudent('a', 's1')).name, '가');
  assert.deepEqual(await store.getOwnResponses('a', 's1'), { '0': { c: 1 } });
  assert.deepEqual(await store.getBoard('a'), { s1: 1 });
  await store.saveStudent('a', 's1', { name: '나' });

  assert.deepEqual(fake.calls().filter(call => call.operation === 'get').map(call => call.path), [
    'codes/ABC234',
    'sessions/a',
    'sessions/a/students/s1',
    'sessions/a/responses/s1',
    'sessions/a/meta/board'
  ]);
  assert.deepEqual(fake.value('sessions/a/students/s1'), { name: '나' });
  assert.equal(fake.calls().some(call => call.path === 'sessions/a/responses/s2'), false);
});

test('live 구독은 openedAt Timestamp를 서버 밀리초로 바꾼다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': {
      q: 1,
      openedAt: { toMillis: () => 12_345 },
      revealed: false,
      limitSec: 20
    }
  });
  const store = createStore(fake);
  let received;

  const stop = store.subscribeLive('a', value => { received = value; });
  await fake.flush();

  assert.equal(received.openedAt, 12_345);
  stop();
});

test('교사와 학생 타이머는 같은 서버 시각으로 5초 경과를 동일하게 계산한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let now = 15_000;
  const live = { q: 0, openedAt: 10_000, revealed: false, limitSec: 20 };
  const fill = { style: {} };
  const timer = {
    style: {}, classList: { toggle() {} },
    querySelector() { return fill; }
  };
  const timerNumber = { textContent: '' };
  const overlay = {
    querySelector(selector) {
      return selector === '#ov-timer' ? timer : timerNumber;
    }
  };
  const context = {
    st: { live },
    pl: { live, uiRevealed: false },
    serverNow() { return now; },
    document: { getElementById() { return overlay; } },
    plRevealed() { return false; },
    plRenderOverlayCounts() {},
    FirestoreCore: core
  };
  vm.runInNewContext(extractFunction(html, 'stLeftRatio'), context);
  vm.runInNewContext(extractFunction(html, 'plTimerTick'), context);

  assert.equal(context.stLeftRatio().left, 15);
  context.plTimerTick();
  assert.equal(timerNumber.textContent, '15초');

  now += 5_000;
  assert.equal(context.stLeftRatio().left, 10);
  context.plTimerTick();
  assert.equal(timerNumber.textContent, '10초');
});

test('학생은 세트 원본 대신 live 공개 문항의 전체 번호와 내용을 표시한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {};
  vm.runInNewContext(extractFunction(html, 'studentQuestionView'), context);

  assert.deepEqual(clone(context.studentQuestionView({
    q: 2,
    publicQuestion: { number: 3, total: 7, type: 'choice', text: '공개 문항', choices: ['A', 'B'] }
  })), {
    number: 3,
    total: 7,
    question: { number: 3, total: 7, type: 'choice', text: '공개 문항', choices: ['A', 'B'] }
  });
});

test('학생 문항 이미지는 live 공개 projection만 사용하고 비공개 경로를 읽지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const image = {};
  const context = {
    st: {},
    $(selector) { return selector === '#st-img' ? image : null; },
    loadQuestionImage() {
      throw new Error('학생은 비공개 이미지 경로를 읽으면 안 된다');
    }
  };
  vm.runInNewContext(extractFunction(html, 'stShowImage'), context);

  context.stShowImage({ image: 'data:image/jpeg;base64,current' }, 2);
  await Promise.resolve();

  assert.equal(image.src, 'data:image/jpeg;base64,current');
});

test('학생 코드 조회는 원본 세트와 snapshot 이미지 경로를 읽지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    st: { code: '', sessionId: null, session: null },
    store: {
      getCode(code) { calls.push(['code', code]); return Promise.resolve({ sessionId: 'session-a' }); },
      getSession(id) { calls.push(['session', id]); return Promise.resolve({ id, label: '3-2', status: 'live' }); },
      getSessionQuizSet() { throw new Error('학생은 snapshot 세트를 읽으면 안 된다'); },
      getQuizSet() { throw new Error('학생은 원본 세트를 읽으면 안 된다'); },
      getSessionQuestionImage() { throw new Error('학생은 snapshot 이미지를 읽으면 안 된다'); }
    },
    stShell() {}, stRenderCodeForm() {}, stRenderIdentityForm() { calls.push(['identity']); },
    lsSet() {}, console
  };
  vm.runInNewContext(extractFunction(html, 'stLookupCode'), context);

  await context.stLookupCode('ABC123');

  assert.deepEqual(calls, [
    ['code', 'ABC123'],
    ['session', 'session-a'],
    ['identity']
  ]);
  assert.equal(context.st.set, undefined);
});

test('학생의 이전 코드 조회와 cleanup은 새 참여 화면을 바꾸지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let resolveCode;
  const codeReady = new Promise(resolve => { resolveCode = resolve; });
  const cleanups = [];
  const calls = [];
  const context = {
    st: null,
    onCleanup(fn) { cleanups.push(fn); },
    stLookupCode() {},
    stRenderCodeForm() {},
    stShell() { calls.push('shell'); },
    store: {
      getCode() { return codeReady; },
      getSession() { calls.push('getSession'); return Promise.resolve(null); }
    },
    lsSet() {},
    normSet(value) { return value; },
    PlaylistCore: require('../playlist-core.js'),
    console
  };
  vm.runInNewContext(extractFunction(html, 'screenStudent'), context);
  vm.runInNewContext(extractFunction(html, 'stLookupCode'), context);

  context.screenStudent('');
  const oldCleanup = cleanups[0];
  const pending = context.stLookupCode('OLD123');
  context.screenStudent('');
  const newState = context.st;
  oldCleanup();
  resolveCode({ sessionId: 'old-session' });
  await pending;

  assert.equal(context.st, newState);
  assert.deepEqual(calls, ['shell']);
});

test('이전 학생 익명 인증 완료는 cleanup 뒤 새 화면을 열지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let resolveAuth;
  const authReady = new Promise(resolve => { resolveAuth = resolve; });
  let cleanup;
  let studentScreens = 0;
  const app = { innerHTML: '' };
  const context = {
    APP() { return app; }, topbar() { return ''; },
    ensureAnonymousStudent() { return authReady; },
    onCleanup(fn) { cleanup = fn; },
    screenStudent() { studentScreens += 1; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'screenJoin'), context);

  context.screenJoin('ABC123');
  cleanup();
  resolveAuth({ uid: 'late-uid', isAnonymous: true });
  await authReady;
  await Promise.resolve();

  assert.equal(studentScreens, 0);
});

test('대시보드와 CSV는 모든 영상 문항을 합산한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {
    PlaylistCore: require('../playlist-core.js'),
    QTYPES: { choice: '객관식 — 하나 고르기' },
    qType() { return 'choice'; },
    answerLabel() { return ''; }
  };
  vm.runInNewContext(extractFunction(html, 'dashBuildRowsFor'), context);
  vm.runInNewContext(extractFunction(html, 'dashCsvRows'), context);
  const set = {
    videos: [
      { title: '영상 1', questions: [{ text: 'A' }, { text: 'B' }] },
      { title: '영상 2', questions: [{ text: 'C' }] }
    ]
  };

  const rows = context.dashCsvRows(set, {}, {});

  assert.match(rows[0].join(','), /영상 1 · 문항 1/);
  assert.match(rows[0].join(','), /영상 2 · 문항 3/);
});

test('학생 입장 흐름은 익명 Auth UID 문서로 참여하고 본인 답만 복원한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const fields = {
    '#st-grade': { value: '3' },
    '#st-klass': { value: '2' },
    '#st-num': { value: '7' },
    '#st-name': { value: ' 홍길동 ' }
  };
  const context = {
    st: { sessionId: 'a', authUid: 'anonymous-uid', myAnswers: {}, revision: 0 },
    $(selector) { return fields[selector]; },
    lsSet() {},
    SV_TS: Symbol('server timestamp'),
    store: {
      async joinStudent(sessionId, authUid, value) {
        calls.push(['joinStudent', sessionId, authUid, value]);
        return { ...value, uid: authUid };
      },
      async getOwnResponses(sessionId, studentId) {
        calls.push(['getOwnResponses', sessionId, studentId]);
        return { '0': { answer: 1, ok: true, submitted: true, revision: 4 } };
      }
    },
    stRenderIdentityForm() {},
    stStartWatching() { calls.push(['watch']); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'stJoin'), context);

  await context.stJoin();

  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['joinStudent', 'a', 'anonymous-uid'],
    ['getOwnResponses', 'a', 'anonymous-uid'],
    ['watch']
  ]);
  assert.deepEqual(clone(context.st.myAnswers), {
    '0': { answer: 1, ok: true, submitted: true, revision: 4 }
  });
});

test('학생 입장 조회가 늦게 끝나도 새 참여 화면에 저장하거나 구독하지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let resolveStudent;
  const studentReady = new Promise(resolve => { resolveStudent = resolve; });
  const fields = {
    '#st-grade': { value: '3' }, '#st-klass': { value: '2' },
    '#st-num': { value: '7' }, '#st-name': { value: '홍길동' }
  };
  const calls = [];
  const oldState = { sessionId: 'old-session', authUid: 'old-uid', myAnswers: {} };
  const newState = { sessionId: 'new-session', myAnswers: {} };
  const context = {
    st: oldState,
    $(selector) { return fields[selector]; }, lsSet() {}, SV_TS: 1,
    store: {
      joinStudent() { return studentReady; },
      getOwnResponses() { calls.push('getOwnResponses'); return Promise.resolve({}); }
    },
    stRenderIdentityForm() {},
    stStartWatching() { calls.push('watch'); }, console
  };
  vm.runInNewContext(extractFunction(html, 'stJoin'), context);

  const pending = context.stJoin();
  context.st = newState;
  resolveStudent(null);
  await pending;

  assert.equal(context.st, newState);
  assert.deepEqual(calls, []);
  assert.equal(newState.sid, undefined);
});

test('학생 화면은 live 하나만 구독하고 문항이 닫힐 때 점수판을 한 번 읽는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let liveNext;
  const subscriptions = [];
  let scoreReads = 0;
  const context = {
    st: {
      sessionId: 'a', session: { status: 'live' },
      live: { q: 2, openedAt: 10, revealed: false, limitSec: 20 },
      authUid: 'student-uid', myAnswers: {}, ownScore: null
    },
    store: {
      subscribeLive(id, next) {
        subscriptions.push(id);
        liveNext = next;
        return () => {};
      },
      async getOwnScore(id, uid) {
        assert.equal(id, 'a');
        assert.equal(uid, 'student-uid');
        scoreReads += 1;
        return { uid, visible: true, score: 2, rank: 1, total: 3 };
      }
    },
    onCleanup() {},
    every() {},
    stTick() {},
    stRender() {},
    parseMulti() { return []; },
    studentQuestionView(live) { return { number: 0, total: 0, question: live.publicQuestion || null }; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'stStartWatching'), context);

  context.stStartWatching();
  await liveNext({ q: -1, openedAt: 0, revealed: false, limitSec: 0 });

  assert.deepEqual(subscriptions, ['a']);
  assert.equal(scoreReads, 1);
  assert.deepEqual(clone(context.st.ownScore), {
    uid: 'student-uid', visible: true, score: 2, rank: 1, total: 3
  });

  await liveNext({ q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended' });
  assert.equal(context.st.session.status, 'ended');
  assert.equal(scoreReads, 1);
});

test('이전 학생 live 콜백과 오류는 새 참여 화면을 바꾸거나 출력하지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let liveNext, liveError;
  let renders = 0, errors = 0;
  const oldState = {
    sessionId: 'old-session', session: { status: 'live' },
    live: { q: 0, openedAt: 10 }, myAnswers: {}, board: {}
  };
  const newState = {
    sessionId: 'new-session', session: { status: 'live' },
    live: { q: 5, openedAt: 50 }, myAnswers: {}, board: {}
  };
  const context = {
    st: oldState,
    store: {
      subscribeLive(id, next, error) { liveNext = next; liveError = error; return () => {}; },
      getBoard() { throw new Error('stale callback must not read board'); }
    },
    onCleanup() {}, every() {}, stTick() {},
    stRender() { renders += 1; }, parseMulti() { return []; },
    studentQuestionView(live) { return { number: 0, total: 0, question: live.publicQuestion || null }; },
    console: { error() { errors += 1; } }
  };
  vm.runInNewContext(extractFunction(html, 'stStartWatching'), context);
  context.stStartWatching();
  context.st = newState;

  await liveNext({ q: 6, openedAt: 60, status: 'ended' });
  liveError(new Error('late'));

  assert.equal(context.st, newState);
  assert.deepEqual(newState.live, { q: 5, openedAt: 50 });
  assert.equal(renders, 1);
  assert.equal(errors, 0);
});

test('느린 점수판 조회는 뒤이어 열린 문항의 선택 상태를 덮지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let liveNext;
  let resolveBoard;
  const boardReady = new Promise(resolve => { resolveBoard = resolve; });
  const context = {
    st: {
      sessionId: 'a', session: { status: 'live' },
      live: { q: 2, openedAt: 10, revealed: false, limitSec: 20 },
      authUid: 'student-uid', myAnswers: { '3': { answer: 1 } }, ownScore: null
    },
    store: {
      subscribeLive(id, next) { liveNext = next; return () => {}; },
      async getOwnScore() { await boardReady; return { uid: 'student-uid', visible: true, score: 2, rank: 1, total: 3 }; }
    },
    onCleanup() {},
    every() {},
    stTick() {},
    stRender() {},
    parseMulti() { return []; },
    studentQuestionView(live) { return { number: 4, total: 4, question: live.publicQuestion || null }; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'stStartWatching'), context);
  context.stStartWatching();

  const closeRun = liveNext({ q: -1, openedAt: 0, revealed: false, limitSec: 0 });
  await Promise.resolve();
  await liveNext({
    q: 3, openedAt: 30, revealed: false, limitSec: 20,
    publicQuestion: { number: 4, total: 4, type: 'choice', text: 'Q', choices: ['A', 'B'] }
  });
  resolveBoard();
  await closeRun;

  assert.equal(context.st.live.q, 3);
  assert.equal(context.st.sel, 1);
  assert.equal(context.st.submitted, true);
});

test('학생 답 전송은 Auth UID 문서에 Task 2 payload만 기록한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const writes = [];
  const context = {
    st: { sessionId: 'a', authUid: 'anonymous-uid', live: { q: 2 }, myAnswers: {} },
    store: {
      writeStudentAnswer(...args) {
        writes.push(args);
        return Promise.resolve();
      }
    },
    stRender() {},
    toast() {},
    console
  };
  vm.runInNewContext(extractFunction(html, 'stQueueWrite'), context);
  vm.runInNewContext(extractFunction(html, 'stSend'), context);

  context.stSend({ answer: '서술', submitted: true, revision: 3, submittedAt: 123 }, {
    answer: '서술', submitted: true, revision: 3
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(writes, [[
    'a', 'anonymous-uid', 2,
    { answer: '서술', submitted: true, revision: 3, submittedAt: 123 }
  ]]);
});

test('두 번째 영상 객관식은 전체 문항 키로 제출하고 다시 고르기만 서버 상태를 바꾼다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const writes = [];
  const context = {
    st: {
      sessionId: 'a', authUid: 'anonymous-uid', sid: 'anonymous-uid',
      live: { q: 2, openedAt: 1000, limitSec: 15 },
      currentQuestion: { type: 'choice', choices: ['가', '나'], number: 3 },
      myAnswers: {}, sel: null, multiSel: [], draft: '', submitted: false, revision: 0
    },
    store: { writeStudentAnswer(...args) { writes.push(args); return Promise.resolve(); } },
    qType(q) { return q.type; }, serverNow() { return 2000; }, SV_TS: 999,
    multiCorrect() { return false; }, fmtMulti(v) { return v.join(','); }, shortCorrect() { return false; },
    stLocked() { return false; }, stRender() {}, toast() {}, console
  };
  for (const name of ['stAnswer', 'stHasDraftAnswer', 'stBuildAnswer', 'stQueueWrite', 'stSend', 'stSubmitCurrent', 'stReviseAnswer']) {
    vm.runInNewContext(extractFunction(html, name), context);
  }

  context.stAnswer(1);
  assert.equal(writes.length, 0);
  await context.stSubmitCurrent('button');
  assert.equal(writes[0][2], 2);
  assert.equal(writes[0][3].submitted, true);
  assert.equal(writes[0][3].answer, 1);
  assert.equal('ok' in writes[0][3], false);
  assert.equal('score' in writes[0][3], false);
  await context.stReviseAnswer();
  assert.equal(writes[1][3].submitted, false);
  assert.equal(context.st.submitted, false);
  assert.equal(context.st.sel, 1);
});

test('마감 시 선택한 답은 한 번 자동 제출하고 빈 답은 미제출로 둔다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let submits = 0;
  const context = {
    st: { live: { q: 0, openedAt: 1000, limitSec: 5 }, sel: 0, submitted: false, deadlineHandled: '' },
    serverNow() { return 6000; },
    stLeftRatio() { return { left: 0, ratio: 0 }; },
    stHasDraftAnswer() { return context.st.sel !== null; },
    stSubmitCurrent(source) { assert.equal(source, 'timer'); submits += 1; return Promise.resolve(); }
  };
  vm.runInNewContext(extractFunction(html, 'stDeadlineTick'), context);

  context.stDeadlineTick();
  context.stDeadlineTick();
  assert.equal(submits, 1);

  context.st.deadlineHandled = '';
  context.st.sel = null;
  context.stDeadlineTick();
  assert.equal(submits, 1);
});

test('타이머 자동 제출은 마감 잠금이 시작된 순간에도 선택 답을 저장한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let sent = 0;
  const context = {
    st: { live: { q: 0 }, submitted: false, revision: 0 },
    stLocked() { return true; },
    SV_TS: 999,
    stBuildAnswer() { return { payload: { answer: 0 }, local: { answer: 0 } }; },
    stSend(payload) {
      sent += 1;
      assert.deepEqual(clone(payload), { answer: 0, submitted: true, revision: 1, submittedAt: 999 });
      return Promise.resolve();
    },
    toast() {}
  };
  vm.runInNewContext(extractFunction(html, 'stSubmitCurrent'), context);

  await context.stSubmitCurrent('timer');

  assert.equal(sent, 1);
});

test('a password session linked to Google is removed from the teacher UI state', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const priorClock = {};
  const context = {
    teacherUser: null,
    teacherAllowance: null,
    teacherState: null,
    clockUserId: 'prior-user',
    clockPromise: priorClock,
    clockPromiseUid: 'prior-user',
    teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'),
    renderTeacherAuthArea() {},
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; }
    }
  };
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);

  await context.applyTeacherUser({
    uid: 'password-user', email: 'teacher@school.kr', emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'google.com' }, { providerId: 'password' }],
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'password' } } });
    }
  });

  assert.equal(context.teacherUser, null);
  assert.equal(context.clockUserId, '');
  assert.equal(context.clockPromise, null);
  assert.equal(context.clockPromiseUid, '');
});

test('auth generation 교체는 token 확인을 기다리지 않고 현재 heartbeat timer를 즉시 중단한다', async () => {
  let finishToken;
  let stops = 0;
  const context = {
    pl: {
      sessionId: 'session-a', code: 'CODE12', allocationToken: 'allocation-token-123456',
      stopActivationHeartbeat() { stops += 1; }
    },
    teacherUser: { uid: 'teacher-1', email: 'teacher@school.kr' },
    teacherAllowance: { enabled: true, role: 'teacher' },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 12,
    AuthCore: require('../auth-core.js'),
    renderTeacherAuthArea() {},
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; }
    }
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'applyTeacherUser'
  ), context);
  const applying = context.applyTeacherUser({
    uid: 'teacher-2', email: 'other@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return new Promise(resolve => { finishToken = resolve; });
    }
  });

  assert.equal(stops, 1);
  finishToken({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applying;
  assert.equal(stops, 1);
});

test('같은 owner의 auth generation 갱신은 heartbeat를 새 generation으로 다시 시작한다', async () => {
  let stops = 0;
  const restarts = [];
  const state = {
    sessionId: 'session-a', code: 'CODE12', allocationToken: 'allocation-token-123456',
    stopActivationHeartbeat() { stops += 1; }
  };
  const context = {
    pl: state,
    teacherUser: { uid: 'teacher-1', email: 'teacher@school.kr' },
    teacherAllowance: { enabled: true, role: 'teacher' },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 20,
    AuthCore: require('../auth-core.js'),
    renderTeacherAuthArea() {},
    plStartSessionHeartbeat(...args) { restarts.push(args); },
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; }
    }
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'applyTeacherUser'
  ), context);
  const user = {
    uid: 'teacher-1', email: 'teacher@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  };

  await context.applyTeacherUser(user);

  assert.equal(stops, 1);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0][0], state);
  assert.equal(restarts[0][1].uid, 'teacher-1');
  assert.equal(restarts[0][2], 21);
  assert.equal(restarts[0][3], 'allocation-token-123456');
});

test('a persisted Google session remains in the teacher UI state', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const user = {
    uid: 'google-user', email: 'teacher@school.kr', emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'google.com' }],
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  };
  const context = {
    teacherUser: null,
    teacherAllowance: null,
    teacherState: null,
    clockUserId: '',
    clockPromise: null,
    clockPromiseUid: '',
    teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'),
    renderTeacherAuthArea() {},
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; }
    }
  };
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);

  await context.applyTeacherUser(user);

  assert.equal(context.teacherUser, user);
  assert.equal(context.teacherState.status, 'teacher');
});

test('pending allocation queue는 auth 교체를 무시하고 원 소유자 재로그인·reload·retry로 복구한다', async () => {
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const key = 'vq_pending_allocations_v1';
  values.set(key, JSON.stringify([{
    sessionId: 'pending-session', code: 'PEND12', ownerUid: 'owner-user',
    ownerEmail: 'owner@school.kr', token: 'pending-token-1234', createdAt: 1,
    recoverAfter: 2
  }]));
  let failRecovery = true;
  const calls = [];
  const context = {
    PENDING_ALLOCATION_KEY: key,
    PENDING_ALLOCATION_RECOVERY_DELAY_MS: 30_000,
    localStorage,
    teacherUser: null, teacherAllowance: null, teacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    pendingAllocationRecoveryTimer: null,
    AuthCore: require('../auth-core.js'), Date,
    renderTeacherAuthArea() {}, esc(value) { return String(value); }, toast() {},
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; },
      async recoverPendingSessionAllocation(record) {
        calls.push(record.ownerUid);
        if (failRecovery) throw new Error('planned cleanup failure');
        return { complete: true, cleaned: true };
      }
    }
  };
  loadStageFunctions([
    'pendingAllocationRead', 'pendingAllocationWrite', 'pendingAllocationPatch',
    'pendingAllocationRemove', 'pendingAllocationsForOwner',
    'recoverPendingAllocationsForTeacher', 'retryPendingAllocations',
    'teacherAuthMarkup', 'applyTeacherUser'
  ], context);
  const googleUser = (uid, email) => ({
    uid, email, emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  });

  await context.applyTeacherUser(googleUser('other-user', 'other@school.kr'));
  assert.deepEqual(calls, []);
  assert.equal(context.pendingAllocationRead().length, 1);

  await context.applyTeacherUser(googleUser('owner-user', 'owner@school.kr'));
  assert.deepEqual(calls, ['owner-user']);
  assert.match(context.pendingAllocationRead()[0].lastError, /planned cleanup failure/);
  assert.match(context.teacherAuthMarkup(), /정리 재시도/);

  const reloadContext = { PENDING_ALLOCATION_KEY: key, localStorage };
  loadStageFunctions(['pendingAllocationRead'], reloadContext);
  assert.match(reloadContext.pendingAllocationRead()[0].lastError, /planned cleanup failure/);

  failRecovery = false;
  await context.retryPendingAllocations();
  assert.deepEqual(calls, ['owner-user', 'owner-user']);
  assert.deepEqual(Array.from(context.pendingAllocationRead()), []);
});

test('원 소유자가 복구 유예 중 재로그인하면 유예 종료 뒤 자동 cleanup을 다시 시도한다', async () => {
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
  const key = 'vq_pending_allocations_v1';
  values.set(key, JSON.stringify([{
    sessionId: 'pending-session', code: 'PEND12', ownerUid: 'owner-user',
    ownerEmail: 'owner@school.kr', token: 'pending-token-1234', createdAt: 1_000,
    recoverAfter: 31_000
  }]));
  let now = 1_000;
  let scheduled = null;
  let recoveries = 0;
  const context = {
    PENDING_ALLOCATION_KEY: key,
    PENDING_ALLOCATION_RECOVERY_DELAY_MS: 30_000,
    pendingAllocationRecoveryTimer: null,
    localStorage,
    teacherUser: null, teacherAllowance: null, teacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), Date: { now() { return now; } },
    setTimeout(callback, delay) { scheduled = { callback, delay }; return 7; },
    clearTimeout() {},
    renderTeacherAuthArea() {},
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; },
      async recoverPendingSessionAllocation() {
        recoveries += 1;
        return { complete: true, cleaned: true };
      }
    }
  };
  loadStageFunctions([
    'pendingAllocationRead', 'pendingAllocationWrite', 'pendingAllocationRemove',
    'pendingAllocationsForOwner', 'recoverPendingAllocationsForTeacher', 'applyTeacherUser'
  ], context);
  const owner = {
    uid: 'owner-user', email: 'owner@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  };

  await context.applyTeacherUser(owner);
  assert.equal(recoveries, 0);
  assert.equal(scheduled.delay, 30_000);

  now = 31_001;
  await scheduled.callback();
  assert.equal(recoveries, 1);
  assert.deepEqual(Array.from(context.pendingAllocationRead()), []);
});

test('a verified Google session hydrates teacher allowance through the normalized protected probe', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const probed = [];
  const user = {
    uid: 'google-user', email: ' Teacher@School.KR ', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  };
  const context = {
    teacherUser: null, teacherAllowance: null, teacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    store: {
      async probeTeacherAllowance(email) {
        probed.push(email);
        return { enabled: true, role: 'teacher' };
      }
    }
  };
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);

  await context.applyTeacherUser(user);

  assert.deepEqual(probed, ['teacher@school.kr']);
  assert.equal(context.teacherState.status, 'teacher');
  assert.equal(context.teacherState.uid, 'google-user');
});

test('approved Google teacher never probes or hydrates browser legacy-owner authority', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const user = {
    uid: 'legacy-owner', email: ' Owner@School.KR ', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  };
  const context = {
    teacherUser: null, teacherAllowance: null, teacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    store: {
      async probeTeacherAllowance(email) {
        calls.push(['allowance', email]);
        return { enabled: true, role: 'teacher' };
      },
      async probeLegacyOwner() {
        calls.push(['legacy']);
        return true;
      }
    }
  };
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);

  await context.applyTeacherUser(user);

  assert.deepEqual(calls, [['allowance', 'owner@school.kr']]);
  assert.equal(context.teacherState.status, 'teacher');
});

test('an offline server-only allowance probe leaves a verified Google user unapproved', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const unavailable = Object.assign(new Error('offline'), { code: 'unavailable' });
  const user = {
    uid: 'google-user', email: 'teacher@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  };
  const errors = [];
  const context = {
    teacherUser: null, teacherAllowance: null, teacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    store: { async probeTeacherAllowance() { throw unavailable; } },
    console: { error(error) { errors.push(error); } }
  };
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);

  await context.applyTeacherUser(user);

  assert.equal(context.teacherState.status, 'unapproved');
  assert.equal(context.teacherAllowance, null);
  assert.deepEqual(errors, [unavailable]);
});

test('a late allowance probe from an older auth generation cannot authorize the replacement user', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let resolveA;
  const googleUser = (uid, email) => ({
    uid, email, emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } });
    }
  });
  const userA = googleUser('google-a', 'a@school.kr');
  const userB = googleUser('google-b', 'b@school.kr');
  const context = {
    teacherUser: null, teacherAllowance: null, teacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    store: {
      probeTeacherAllowance(email) {
        if (email === 'a@school.kr') return new Promise(resolve => { resolveA = resolve; });
        return Promise.resolve({ enabled: true, role: 'teacher' });
      }
    }
  };
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);

  const applyingA = context.applyTeacherUser(userA);
  await new Promise(resolve => setImmediate(resolve));
  const applyingB = context.applyTeacherUser(userB);
  await applyingB;
  assert.equal(context.teacherState.uid, 'google-b');
  assert.equal(context.teacherState.status, 'teacher');

  resolveA({ enabled: true, role: 'admin' });
  assert.equal(await applyingA, false);
  assert.equal(context.teacherState.uid, 'google-b');
  assert.equal(context.teacherState.status, 'teacher');
});

test('a late Google token from an older auth observer cannot replace the newer session', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let authListener;
  const tokenResolves = {};
  const userA = {
    uid: 'google-a', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return new Promise(resolve => { tokenResolves.a = resolve; });
    }
  };
  const userB = {
    uid: 'google-b', email: 'b@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() {
      return new Promise(resolve => { tokenResolves.b = resolve; });
    }
  };
  const context = {
    teacherUser: null,
    teacherAllowance: null,
    teacherState: null,
    clockUserId: '',
    clockPromise: null,
    clockPromiseUid: '',
    authReady: false,
    teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'),
    store: {
      async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; }
    },
    renderTeacherAuthArea() {},
    APP() { return { innerHTML: '' }; },
    topbar() { return '<nav></nav>'; },
    firebase: {
      auth() {
        return { onAuthStateChanged(listener) { authListener = listener; } };
      }
    },
    router() {},
    console
  };
  vm.runInNewContext(
    extractFunction(html, 'applyTeacherUser') + '\n' + extractFunction(html, 'bootWithAuth'),
    context
  );

  context.bootWithAuth();
  const observerA = authListener(userA);
  await Promise.resolve();
  const observerB = authListener(userB);
  await Promise.resolve();
  tokenResolves.b({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await observerB;
  assert.equal(context.teacherUser, userB);
  tokenResolves.a({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await observerA;

  assert.equal(context.teacherUser, userB);
});

test('clock synchronization does not share pending work across authenticated users', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const resolves = {};
  const context = {
    clockUserId: '',
    clockPromise: null,
    clockPromiseUid: '',
    store: {
      syncClock(pathValue) {
        calls.push(pathValue);
        return new Promise(resolve => { resolves[pathValue] = resolve; });
      }
    },
    rid(size) { assert.equal(size, 8); return 'SAMPLE12'; }
  };
  vm.runInNewContext(extractFunction(html, 'ensureClock'), context);

  const first = context.ensureClock({ uid: 'user-a' });
  const second = context.ensureClock({ uid: 'user-b' });

  assert.deepEqual(calls, ['clock/user-a-SAMPLE12', 'clock/user-b-SAMPLE12']);
  resolves['clock/user-a-SAMPLE12']();
  resolves['clock/user-b-SAMPLE12']();
  await Promise.all([first, second]);
  assert.equal(context.clockUserId, 'user-b');
});

test('teacher route waits for the replacement account clock before opening its screen', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const resolves = {};
  let opened = 0;
  const context = {
    teacherUser: { uid: 'user-a' },
    teacherState: { role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    ensureClock(user) {
      calls.push(user.uid);
      return new Promise(resolve => { resolves[user.uid] = resolve; });
    },
    signInTeacher() { throw new Error('existing account should not sign in again'); },
    teacherAuthMessage() { return 'not used'; },
    alert() {},
    showTeacherAuthError(error) { throw error; }
  };
  vm.runInNewContext(extractFunction(html, 'requireTeacher'), context);

  const gate = context.requireTeacher(() => { opened += 1; });
  await Promise.resolve();
  assert.deepEqual(calls, ['user-a']);
  context.teacherUser = { uid: 'user-b' };
  context.teacherState = { role: 'teacher' };
  resolves['user-a']();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['user-a', 'user-b']);
  assert.equal(opened, 0);
  resolves['user-b']();
  await gate;
  assert.equal(opened, 1);
});

test('admin route waits for the replacement account clock before opening its screen', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const resolves = {};
  let opened = 0;
  const context = {
    teacherUser: { uid: 'admin-a' },
    teacherState: { role: 'admin' },
    AuthCore: require('../auth-core.js'),
    ensureClock(user) {
      calls.push(user.uid);
      return new Promise(resolve => { resolves[user.uid] = resolve; });
    },
    signInTeacher() { throw new Error('existing account should not sign in again'); },
    alert() {},
    showTeacherAuthError(error) { throw error; }
  };
  vm.runInNewContext(extractFunction(html, 'requireAdmin'), context);

  const gate = context.requireAdmin(() => { opened += 1; });
  await Promise.resolve();
  assert.deepEqual(calls, ['admin-a']);
  context.teacherUser = { uid: 'admin-b' };
  context.teacherState = { role: 'admin' };
  resolves['admin-a']();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['admin-a', 'admin-b']);
  assert.equal(opened, 0);
  resolves['admin-b']();
  await gate;
  assert.equal(opened, 1);
});

test('startup does not create an anonymous student session or sync its clock', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let authListener;
  let anonymousSignIns = 0;
  let routed = 0;
  const app = { innerHTML: '' };
  const context = {
    authReady: false,
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    applyTeacherUser() { return true; },
    firebase: {
      auth() {
        return {
          onAuthStateChanged(listener) { authListener = listener; },
          signInAnonymously() { anonymousSignIns += 1; return Promise.resolve(); }
        };
      }
    },
    store: {
      async syncClock() { throw new Error('startup must not sync the student clock'); }
    },
    rid(size) { assert.equal(size, 8); return 'SAMPLE12'; },
    router() { routed += 1; },
    esc(value) { return String(value); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'bootWithAuth'), context);

  context.bootWithAuth();
  assert.equal(anonymousSignIns, 0);
  const authRun = authListener({ uid: 'user-a' });
  await Promise.resolve();
  await authRun;
  assert.equal(routed, 1);
  assert.equal(anonymousSignIns, 0);
});

test('startup routes after auth state without syncing a student clock', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let authListener;
  let routed = 0;
  const app = { innerHTML: '' };
  const context = {
    authReady: false,
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    applyTeacherUser() { return true; },
    firebase: {
      auth() {
        return {
          onAuthStateChanged(listener) { authListener = listener; },
          signInAnonymously() { return Promise.resolve(); }
        };
      }
    },
    store: { async syncClock() { throw new Error('offline'); } },
    rid() { return 'SAMPLE12'; },
    router() { routed += 1; },
    esc(value) { return String(value); },
    console: { error() {} }
  };
  vm.runInNewContext(extractFunction(html, 'bootWithAuth'), context);

  context.bootWithAuth();
  await authListener({ uid: 'user-a' });

  assert.equal(routed, 1);
  assert.match(app.innerHTML, /연결 중/);
});

test('서술형 채점은 학생 응답을 보존하고 private grade만 변경한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': {
      uid: 's1',
      answers: { '3': { answer: '학생 글', submitted: true, revision: 2, submittedAt: 10 } }
    }
  });
  const store = createStore(fake);

  await store.gradeAnswer('a', 's1', 3, 2, true);
  assert.deepEqual((await store.getOwnResponses('a', 's1'))['3'], {
    answer: '학생 글', submitted: true, revision: 2, submittedAt: 10
  });
  assert.deepEqual(fake.value('sessions/a/grades/s1__3'), {
    uid: 's1', questionIndex: 3, revision: 2, ok: true
  });

  assert.equal(await store.gradeAnswer('a', 's1', 3, 2, null), true);
  assert.equal(fake.value('sessions/a/grades/s1__3'), undefined);
  assert.deepEqual((await store.getOwnResponses('a', 's1'))['3'], {
    answer: '학생 글', submitted: true, revision: 2, submittedAt: 10
  });
});

test('anonymous identity stays pinned through clock sync and rejects an auth replacement', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let resolveClock;
  const original = { uid: 'student-a', isAnonymous: true };
  const replacement = { uid: 'student-b', isAnonymous: true };
  const auth = { currentUser: original, signInAnonymously() { throw new Error('already anonymous'); } };
  const context = {
    firebase: { auth() { return auth; } },
    ensureClock() { return new Promise(resolve => { resolveClock = resolve; }); }
  };
  vm.runInNewContext(extractFunction(html, 'ensureAnonymousStudent'), context);
  const pending = context.ensureAnonymousStudent();
  await Promise.resolve();
  auth.currentUser = replacement;
  resolveClock();
  await assert.rejects(pending, /변경/);
});

test('student join retry preserves the original six-digit code', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(extractFunction(html, 'screenJoin'), /onclick="screenJoin\(' \+ JSON\.stringify\(codeArg \|\| ''\)/);
});

test('observer auth loss, downgrade, and account replacement retract protected routes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const events = [];
  const app = { innerHTML: 'private teacher data' };
  const context = {
    authReady: true, location: { hash: '#/sets' }, AuthCore: require('../auth-core.js'),
    runCleanups() { events.push('cleanup'); }, router() { events.push('router'); },
    go(route) { events.push('go:' + route); }, APP() { return app; }, topbar() { return '<nav></nav>'; }
  };
  vm.runInNewContext(extractFunction(html, 'teacherRouteRequirement') + '\n' +
    extractFunction(html, 'retractProtectedTeacherScreen') + '\n' +
    extractFunction(html, 'reconcileTeacherRoute'), context);
  assert.equal(context.retractProtectedTeacherScreen(), true);
  assert.doesNotMatch(app.innerHTML, /private teacher data/);
  events.length = 0;
  context.reconcileTeacherRoute({ uid: 'teacher-a', role: 'teacher' }, { status: 'signed-out', uid: '', role: '' });
  assert.deepEqual(events, ['cleanup', 'go:home']);
  events.length = 0; context.location.hash = '#/admin';
  context.reconcileTeacherRoute({ uid: 'admin-a', role: 'admin' }, { uid: 'teacher-b', role: 'teacher' });
  assert.deepEqual(events, ['cleanup', 'go:home']);
  events.length = 0; context.location.hash = '#/live/session';
  context.reconcileTeacherRoute({ uid: 'teacher-a', role: 'teacher' }, { uid: 'teacher-b', role: 'teacher' });
  assert.deepEqual(events, ['cleanup', 'router']);
  events.length = 0;
  context.reconcileTeacherRoute({ uid: 'teacher-b', role: 'teacher' }, { uid: 'teacher-b', role: 'teacher' });
  assert.deepEqual(events, []);
});

test('pending same-user refresh cannot hide the rendered A identity from a synchronous B retraction', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: 'private A data' };
  const events = [];
  const tokenResolvers = {};
  const userA = {
    uid: 'teacher-a', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { tokenResolvers.refreshA = resolve; }); }
  };
  const userB = {
    uid: 'teacher-b', email: 'b@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { tokenResolvers.accountB = resolve; }); }
  };
  const context = {
    authReady: true, location: { hash: '#/live/session-a' },
    teacherUser: { uid: 'teacher-a', email: 'a@school.kr' },
    teacherAllowance: { enabled: true, role: 'teacher' },
    teacherState: { status: 'teacher', uid: 'teacher-a', email: 'a@school.kr', role: 'teacher' },
    appliedTeacherState: { status: 'teacher', uid: 'teacher-a', email: 'a@school.kr', role: 'teacher' },
    teacherAuthVersion: 0, clockUserId: 'teacher-a', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'),
    store: { async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; } },
    renderTeacherAuthArea() {}, runCleanups() { events.push('cleanup'); },
    router() { events.push('router'); }, go(route) { events.push('go:' + route); },
    APP() { return app; }, topbar() { return '<nav></nav>'; }, console
  };
  vm.runInNewContext(
    extractFunction(html, 'teacherRouteRequirement') + '\n' +
    extractFunction(html, 'retractProtectedTeacherScreen') + '\n' +
    extractFunction(html, 'reconcileTeacherRoute') + '\n' +
    extractFunction(html, 'applyTeacherUser'),
    context
  );

  const refreshingA = context.applyTeacherUser(userA);
  assert.equal(context.teacherUser, null);
  assert.match(app.innerHTML, /private A data/);

  const applyingB = context.applyTeacherUser(userB);
  assert.doesNotMatch(app.innerHTML, /private A data/);
  assert.deepEqual(events, ['cleanup']);

  await Promise.resolve();
  tokenResolvers.accountB({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingB;
  assert.equal(context.teacherState.uid, 'teacher-b');
  assert.deepEqual(events, ['cleanup', 'cleanup', 'router']);

  tokenResolvers.refreshA({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  assert.equal(await refreshingA, false);
  assert.equal(context.teacherState.uid, 'teacher-b');
  assert.equal(context.appliedTeacherState.uid, 'teacher-b');
});

test('teacher grading transaction ignores a stale expected revision and grades the current submitted revision only', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': {
      uid: 's1',
      answers: {
        '3': { answer: 'new answer', submitted: true, revision: 2 }
      }
    }
  });
  const store = createStore(fake);

  assert.equal(await store.gradeAnswer('a', 's1', 3, 1, true), false);
  assert.equal(Object.hasOwn(
    fake.value('sessions/a/responses/s1').answers['3'], 'ok'
  ), false);

  assert.equal(await store.gradeAnswer('a', 's1', 3, 2, false), true);
  assert.deepEqual(fake.value('sessions/a/responses/s1').answers['3'], {
    answer: 'new answer', submitted: true, revision: 2
  });
  assert.deepEqual(fake.value('sessions/a/grades/s1__3'), {
    uid: 's1', questionIndex: 3, revision: 2, ok: false
  });
});

test('세션 목록은 문서 ID와 화면용 밀리초 시각을 반환한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': { setId: 'set1', createdAt: { toMillis: () => 12_345 } },
    'sessions/b': { setId: 'set2', createdAt: 67_890 }
  });

  assert.deepEqual(await createStore(fake).listSessions(), [
    { id: 'a', setId: 'set1', createdAt: 12_345 },
    { id: 'b', setId: 'set2', createdAt: 67_890 }
  ]);
});

test('기간 삭제는 세션 하위 문서와 연결 코드만 지운다', async () => {
  const fake = makeFirestoreFake({
    'codes/CODE23': { sessionId: 's1' },
    'codes/KEEP23': { sessionId: 's2' },
    'sessions/s1': { setId: 'set1' },
    'sessions/s1/meta/live': { q: -1 },
    'sessions/s1/meta/board': { scores: {} },
    'sessions/s1/students/a': { name: '가' },
    'sessions/s1/responses/a': { answers: {} },
    'sessions/s2': { setId: 'set1' },
    'quiz_sets/set1': { title: '보존' }
  });

  await createStore(fake).purgeSessions(['s1']);

  assert.equal(fake.value('sessions/s1'), undefined);
  assert.equal(fake.value('sessions/s1/meta/live'), undefined);
  assert.equal(fake.value('sessions/s1/meta/board'), undefined);
  assert.equal(fake.value('sessions/s1/students/a'), undefined);
  assert.equal(fake.value('sessions/s1/responses/a'), undefined);
  assert.equal(fake.value('codes/CODE23'), undefined);
  assert.deepEqual(fake.value('codes/KEEP23'), { sessionId: 's2' });
  assert.deepEqual(fake.value('sessions/s2'), { setId: 'set1' });
  assert.deepEqual(fake.value('quiz_sets/set1'), { title: '보존' });
  assert.deepEqual(
    fake.calls().filter(call => call.operation === 'where').map(call => [call.path, call.field, call.value]),
    [['codes', 'sessionId', 's1']]
  );
});

test('기간 삭제 batch는 450개를 넘지 않고 모든 대상을 나누어 지운다', async () => {
  const initial = { 'sessions/s1': { setId: 'set1' } };
  for (let index = 0; index < 451; index += 1) {
    initial['sessions/s1/responses/student-' + index] = { answers: {} };
  }
  const fake = makeFirestoreFake(initial);

  await createStore(fake).purgeSessions(['s1']);

  const commits = fake.calls().filter(call => call.operation === 'batchCommit');
  assert.deepEqual(commits.map(call => call.size), [450, 2]);
  assert.equal(fake.value('sessions/s1/responses/student-450'), undefined);
  assert.equal(fake.value('sessions/s1'), undefined);
});

test('대시보드는 세션과 세트를 단발 조회하고 학생과 응답만 구독한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const subscriptions = {};
  const calls = [];
  const app = { innerHTML: '' };
  const context = {
    dash: null,
    store: {
      async getSession(id) {
        calls.push(['getSession', id]);
        return { id, setId: 'set1', code: 'ABC234', status: 'live' };
      },
      async getQuizSet(id) {
        calls.push(['getQuizSet', id]);
        return {
          id,
          title: '첫 세트',
          videos: [
            { title: '영상 1', questions: [{ text: 'A' }] },
            { title: '영상 2', questions: [{ text: 'B' }] }
          ]
        };
      },
      subscribeStudents(id, next) {
        calls.push(['subscribeStudents', id]); subscriptions.students = next; return () => {};
      },
      subscribeResponses(id, next) {
        calls.push(['subscribeResponses', id]); subscriptions.responses = next; return () => {};
      },
      subscribeGrades(id, next) {
        calls.push(['subscribeGrades', id]); subscriptions.grades = next; return () => {};
      }
    },
    FirestoreCore: require('../firestore-core.js'),
    PlaylistCore: require('../playlist-core.js'),
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    normSet(value) { return value; },
    normSettings() { return {}; },
    renderDash() {},
    onCleanup() {},
    go() {},
    esc(value) { return String(value); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'screenDashboard'), context);

  context.screenDashboard('session-a');
  await new Promise(resolve => setImmediate(resolve));
  subscriptions.students({ s1: { name: '가' } });
  subscriptions.responses({ s1: { answers: { '2': { txt: '학생 글', revision: 3, ok: true } } } });
  subscriptions.grades({ 's1__2': { uid: 's1', questionIndex: 2, revision: 3, ok: false } });

  assert.deepEqual(calls, [
    ['getSession', 'session-a'],
    ['getQuizSet', 'set1'],
    ['subscribeStudents', 'session-a'],
    ['subscribeResponses', 'session-a'],
    ['subscribeGrades', 'session-a']
  ]);
  assert.deepEqual(context.dash.students, { s1: { name: '가' } });
  assert.deepEqual(context.dash.answers, {
    '2': { s1: { txt: '학생 글', revision: 3, ok: false } }
  });
  assert.deepEqual(context.dash.flatQuestions.map(q => [q.number, q.videoIndex, q.text]), [
    [1, 0, 'A'],
    [2, 1, 'B']
  ]);
});

test('이전 대시보드 조회와 cleanup은 새 대시보드 상태나 구독을 바꾸지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let resolveOldSession;
  const oldSessionReady = new Promise(resolve => { resolveOldSession = resolve; });
  const cleanups = [];
  const subscriptions = [];
  const app = { innerHTML: '' };
  const context = {
    dash: null,
    store: {
      getSession(id) {
        if (id === 'old-session') return oldSessionReady;
        return Promise.resolve({ id, setId: 'new-set', code: 'NEW123', status: 'live' });
      },
      getQuizSet(id) {
        return Promise.resolve({ id, title: '새 세트', videos: [{ questions: [{ text: '새 문항' }] }] });
      },
      subscribeStudents(id) { subscriptions.push(['students', id]); return () => {}; },
      subscribeResponses(id) { subscriptions.push(['responses', id]); return () => {}; },
      subscribeGrades(id) { subscriptions.push(['grades', id]); return () => {}; }
    },
    FirestoreCore: require('../firestore-core.js'),
    PlaylistCore: require('../playlist-core.js'),
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    normSet(value) { return value; },
    normSettings() { return {}; },
    renderDash() {},
    onCleanup(fn) { cleanups.push(fn); },
    go() {}, esc(value) { return String(value); }, console
  };
  vm.runInNewContext(extractFunction(html, 'screenDashboard'), context);

  const oldRun = context.screenDashboard('old-session');
  const oldCleanup = cleanups[0];
  await context.screenDashboard('new-session');
  const newState = context.dash;
  oldCleanup();
  resolveOldSession({ id: 'old-session', setId: 'old-set', code: 'OLD123', status: 'live' });
  await oldRun;

  assert.equal(context.dash, newState);
  assert.equal(context.dash.sessionId, 'new-session');
  assert.deepEqual(subscriptions, [
    ['students', 'new-session'],
    ['responses', 'new-session'],
    ['grades', 'new-session']
  ]);
});

test('이전 대시보드 구독 콜백과 오류는 새 대시보드를 바꾸거나 출력하지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let studentsNext, studentsError, responsesNext, responsesError, gradesNext, gradesError;
  let renders = 0, errors = 0;
  const app = { innerHTML: '' };
  const context = {
    dash: null,
    store: {
      getSession() { return Promise.resolve({ setId: 'set1', code: 'OLD123', status: 'live' }); },
      getQuizSet() { return Promise.resolve({ videos: [{ questions: [{ text: '문항' }] }] }); },
      subscribeStudents(id, next, error) {
        studentsNext = next; studentsError = error || (() => { errors += 1; }); return () => {};
      },
      subscribeResponses(id, next, error) {
        responsesNext = next; responsesError = error || (() => { errors += 1; }); return () => {};
      },
      subscribeGrades(id, next, error) {
        gradesNext = next; gradesError = error || (() => { errors += 1; }); return () => {};
      }
    },
    FirestoreCore: require('../firestore-core.js'), PlaylistCore: require('../playlist-core.js'),
    APP() { return app; }, topbar() { return ''; }, normSet(value) { return value; }, normSettings() { return {}; },
    renderDash() { renders += 1; }, onCleanup() {}, go() {}, esc(value) { return String(value); },
    console: { error() { errors += 1; } }
  };
  vm.runInNewContext(extractFunction(html, 'screenDashboard'), context);
  await context.screenDashboard('old-session');
  const newState = { sessionId: 'new-session', students: {}, answers: {} };
  context.dash = newState;

  studentsNext({ old: { name: '이전' } });
  responsesNext({ old: { answers: { '0': { c: 1 } } } });
  gradesNext({ 'old__0': { uid: 'old', questionIndex: 0, revision: 1, ok: true } });
  studentsError(new Error('late students'));
  responsesError(new Error('late responses'));
  gradesError(new Error('late grades'));

  assert.equal(context.dash, newState);
  assert.deepEqual(newState.students, {});
  assert.deepEqual(newState.answers, {});
  assert.equal(renders, 0);
  assert.equal(errors, 0);
});

test('대시보드는 두 번째 영상의 전체 문항 응답을 학생 합계에 포함한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {};
  vm.runInNewContext(extractFunction(html, 'dashBuildRowsFor'), context);
  const flatQuestions = require('../playlist-core.js').flattenQuestions([
    { questions: [{ text: 'A' }, { text: 'B' }] },
    { questions: [{ text: 'C' }] }
  ]);

  const rows = context.dashBuildRowsFor(
    flatQuestions,
    { s1: { grade: 1, klass: 2, num: 3, name: '가' } },
    {
      '0': { s1: { c: 0, ok: true, ms: 1000 } },
      '2': { s1: { txt: '둘째 영상 답', ok: null, ms: 3000 } }
    }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), {
    sid: 's1', grade: 1, klass: 2, num: 3, name: '가',
    cells: [
      { c: 0, ok: true, ms: 1000 },
      null,
      { txt: '둘째 영상 답', ok: null, ms: 3000 }
    ],
    correct: 1, answered: 2, graded: 1, ungraded: 1, rate: 1, avgMs: 2000
  });
});

test('대시보드 서술형 채점은 저장소에 ok만 전달한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    dash: {
      sessionId: 'session-a',
      answers: { '3': { 'student-a': { revision: 5 } } }
    },
    store: {
      async gradeAnswer(...args) { calls.push(args); }
    },
    alert() {},
    console
  };
  vm.runInNewContext(extractFunction(html, 'dashGrade'), context);

  await context.dashGrade(3, 'student-a', null);

  assert.deepEqual(calls, [['session-a', 'student-a', 3, 5, null]]);
});

test('관리자 조회는 세션과 해당 학생·응답 컬렉션을 각각 한 번만 읽는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const body = { innerHTML: '' };
  const context = {
    adm: {
      sessions: {}, resp: {}, sets: {}, from: '2024-01-01', to: '2024-01-31',
      loading: false, detail: null
    },
    store: {
      async listSessions() {
        calls.push(['listSessions']);
        return [
          { id: 'in', createdAt: new Date('2024-01-15T00:00:00').getTime(), setId: 'set1' },
          { id: 'in-2', createdAt: new Date('2024-01-16T00:00:00').getTime(), setId: 'set1' },
          { id: 'out', createdAt: new Date('2024-02-15T00:00:00').getTime(), setId: 'set2' }
        ];
      },
      async getQuizSet(id) {
        calls.push(['getQuizSet', id]);
        return {
          id, title: '세트', videos: [
            { questions: [{ text: '첫 영상' }] },
            { questions: [{ text: '두 번째 영상' }] }
          ]
        };
      },
      async getCollection(collectionPath) {
        calls.push(['getCollection', collectionPath]);
        if (collectionPath.endsWith('/grades')) return {
          's1__0': { uid: 's1', questionIndex: 0, revision: 2, ok: true }
        };
        if (collectionPath.endsWith('/students')) return { s1: { name: '가' } };
        return { s1: { answers: {
          '0': { c: 1, revision: 2 },
          '2': { txt: '두 번째 영상 답', ok: null }
        } } };
      }
    },
    FirestoreCore: require('../firestore-core.js'),
    PlaylistCore: require('../playlist-core.js'),
    normSet(value) { return value; },
    $(selector) { return selector === '#adm-body' ? body : null; },
    admFillSetOptions() {},
    admRenderBody() {},
    esc(value) { return String(value); },
    Date,
    console
  };
  vm.runInNewContext(extractFunction(html, 'admLoad'), context);

  await context.admLoad();

  assert.deepEqual(calls, [
    ['listSessions'],
    ['getQuizSet', 'set1'],
    ['getCollection', 'sessions/in/students'],
    ['getCollection', 'sessions/in/responses'],
    ['getCollection', 'sessions/in/grades'],
    ['getCollection', 'sessions/in-2/students'],
    ['getCollection', 'sessions/in-2/responses'],
    ['getCollection', 'sessions/in-2/grades']
  ]);
  assert.deepEqual(context.adm.sessions.in.students, { s1: { name: '가' } });
  assert.deepEqual(context.adm.resp.in, {
    '0': { s1: { c: 1, revision: 2, ok: true } },
    '2': { s1: { txt: '두 번째 영상 답' } }
  });
  assert.deepEqual(context.adm.sets.set1.flatQuestions.map(q => [q.number, q.videoIndex, q.text]), [
    [1, 0, '첫 영상'],
    [2, 1, '두 번째 영상']
  ]);
  assert.equal(context.adm.loading, false);
});

test('관리자 조회도 snapshotVersion 필드가 있으면 값의 truthiness와 무관하게 strict reader를 사용한다', async () => {
  const calls = [];
  const body = { innerHTML: '' };
  const session = {
    id: 'version-zero', setId: 'set1', snapshotVersion: 0,
    createdAt: new Date('2024-01-15T00:00:00').getTime()
  };
  const context = {
    adm: {
      sessions: {}, resp: {}, sets: {}, from: '2024-01-01', to: '2024-01-31',
      loading: false, detail: null
    },
    store: {
      async listSessions() { return [session]; },
      async getSessionQuizSet(value) {
        calls.push(['snapshot', value.snapshotVersion]);
        throw new Error('지원하지 않는 세션 스냅샷 버전입니다.');
      },
      async getQuizSet() {
        calls.push(['mutable']);
        return { videos: [] };
      },
      async getCollection() { return {}; }
    },
    FirestoreCore: require('../firestore-core.js'),
    PlaylistCore: require('../playlist-core.js'),
    normSet(value) { return value; },
    $(selector) { return selector === '#adm-body' ? body : null; },
    admFillSetOptions() {}, admRenderBody() {}, esc(value) { return String(value); },
    Date, console: { error() {} }
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'admLoad'
  ), context);

  await context.admLoad();

  assert.deepEqual(calls, [['snapshot', 0]]);
  assert.deepEqual(Object.keys(context.adm.sessions), []);
  assert.deepEqual(Array.from(context.adm.purgeSessionIds), []);
});

test('관리자 집계는 세트별 평탄 문항 키만 포함하고 범위 밖 응답은 제외한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {
    adm: {
      sessions: {
        in: {
          id: 'in', setId: 'set1', setTitle: '세트', createdAt: 10,
          students: { s1: { grade: 1, klass: 2, num: 3, name: '가' } }
        }
      },
      sets: {
        set1: { flatQuestions: [{ number: 1 }, { number: 2 }, { number: 3, videoIndex: 1 }] }
      },
      resp: {
        in: {
          '0': { s1: { c: 0, ok: true } },
          '2': { s1: { txt: '두 번째 영상 답', ok: null } },
          '99': { s1: { c: 0, ok: true } }
        }
      },
      setFilter: '', gradeFilter: '', klassFilter: ''
    }
  };
  vm.runInNewContext(extractFunction(html, 'admCompute'), context);

  const result = context.admCompute();

  assert.equal(result.perSession.in.answered, 2);
  assert.equal(result.perSession.in.correct, 1);
  assert.equal(result.students.s1.answered, 2);
  assert.equal(result.students.s1.correct, 1);
});

test('admin Google 역할을 통과한 관리자 화면은 폐기된 비밀번호 설정 없이 바로 열린다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    onCleanup(fn) { calls.push(['cleanup', typeof fn]); },
    admRenderShell() { calls.push(['render']); },
    admRenderLogin() { calls.push(['password']); },
    ssGet() { calls.push(['legacy-session-read']); return ''; }
  };
  vm.runInNewContext(extractFunction(html, 'screenAdmin'), context);
  context.screenAdmin();

  assert.deepEqual(clone(calls), [
    ['cleanup', 'function'],
    ['render']
  ]);
});

test('관리자 기간 삭제는 화면에서 경로를 만들지 않고 저장소 API에 세션 ID를 맡긴다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    adm: {
      from: '2024-01-01', to: '2024-01-31', setFilter: '', gradeFilter: '', klassFilter: '',
      purgeSessionIds: ['a', 'b'],
      purgeFilterSnapshot: {
        from: '2024-01-01', to: '2024-01-31', setFilter: '', gradeFilter: '', klassFilter: ''
      }
    },
    prompt() { return '삭제'; },
    store: {
      async purgeSessions(ids) { calls.push(['purgeSessions', ids]); }
    },
    toast(message) { calls.push(['toast', message]); },
    admLoad() { calls.push(['load']); },
    alert(message) { throw new Error(message); }
  };
  loadStageFunctions(['admPurgeFilterChanged', 'admPurge'], context);

  await context.admPurge();

  assert.deepEqual(calls, [
    ['purgeSessions', ['a', 'b']],
    ['toast', '2건을 삭제했습니다'],
    ['load']
  ]);
});

test('대시보드 CSV는 서술형 텍스트와 미채점 표시를 유지한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let downloaded;
  const context = {
    dash: {
      session: { code: 'ABC234', createdAt: 1, setTitle: '세트' },
      set: {
        title: '세트',
        videos: [
          { title: '도입', questions: [{ type: 'choice', text: '앞 문항' }] },
          { title: '정리', questions: [{ type: 'long', text: '설명' }] }
        ]
      },
      students: {}, answers: {},
      sort: { key: 'no', dir: 1 }
    },
    dashBuildRows() {
      return [{
        grade: 1, klass: 2, num: 3, name: '가',
        cells: [null, { txt: '학생 글', ok: null, ms: 1200 }],
        correct: 0, graded: 0, ungraded: 1, answered: 1, rate: 0, avgMs: 1200
      }];
    },
    dashSortRows(rows) { return rows; },
    PlaylistCore: require('../playlist-core.js'),
    qType(question) { return question.type || 'choice'; },
    QTYPES: { choice: '객관식 — 하나 고르기', long: '서술형 — 직접 채점' },
    answerLabel(question, answer) { return answer.txt; },
    fmtDate() { return '날짜'; },
    fmtDay() { return '날짜'; },
    downloadCSV(name, rows) { downloaded = { name, rows }; },
    toast() {}
  };
  vm.runInNewContext(extractFunction(html, 'dashCsvRows'), context);
  vm.runInNewContext(extractFunction(html, 'dashExportCSV'), context);

  context.dashExportCSV();

  assert.match(downloaded.rows[5].join(','), /영상 2 \(정리\) · 문항 2 답\(서술형\)/);
  assert.equal(downloaded.rows[6][7], '학생 글');
  assert.equal(downloaded.rows[6][8], '미채점');
});

test('세트 구조와 이미지는 strict counter transaction으로 함께 교체된다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: '이전', videos: [{ questions: [{ text: '이전 문항' }] }],
      lifecycleState: 'active', collaboratorCount: 0, imageCount: 1
    },
    'images/set1/q/v0q0': { data: 'old-image' }
  });
  const store = createStore(fake);

  await store.saveQuizSetWithImages('set1', {
    title: '새 값', videos: [{ questions: [{ text: '새 문항' }] }]
  }, { v0q0: 'new-image', v0q1: 'second-image' });

  assert.equal(fake.value('quiz_sets/set1').title, '새 값');
  assert.equal(fake.value('images/set1/q/v0q0').data, 'new-image');
  assert.equal(fake.value('images/set1/q/v0q1').data, 'second-image');
  assert.equal(fake.value('quiz_sets/set1').imageCount, 2);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 2);
  assert.equal(fake.calls().filter(call => call.operation === 'batchCommit').length, 0);
});

test('estimateBatchRequest는 transform 포함 500 쓰기와 10 MiB 안전 경계를 계산한다', () => {
  const { estimateBatchRequest } = loadStoreModule();
  const atLimit = Object.fromEntries(
    Array.from({ length: 497 }, (_, index) => ['v0q' + index, 'x'])
  );
  const overWrites = Object.assign({}, atLimit, { v0q497: 'x' });

  assert.deepEqual(estimateBatchRequest({ title: '세트' }, atLimit), {
    writes: 500, bytes: 229248, allowed: true, reason: ''
  });
  assert.equal(estimateBatchRequest({ title: '세트' }, overWrites).writes, 501);
  assert.equal(estimateBatchRequest({ title: '세트' }, overWrites).reason, 'writes');

  const overBytes = estimateBatchRequest({}, { v0q0: '가'.repeat(3_166_667) });
  assert.equal(overBytes.allowed, false);
  assert.equal(overBytes.reason, 'bytes');
  assert.ok(overBytes.bytes > 9_500_000);
});

test('세트 이미지 저장은 실제 transform 수와 10 MiB를 Firestore 호출 전에 거부한다', async () => {
  const transformFake = makeFirestoreFake({}, {
    maxRequestWrites: 500,
    maxRequestBytes: 10_000_000
  });
  const transformStore = createStore(transformFake);
  const images = Object.fromEntries(
    Array.from({ length: 497 }, (_, index) => ['v0q' + index, 'x'])
  );

  await assert.rejects(
    () => transformStore.saveQuizSetWithImages('set1', {
      title: '세트', createdAt: SERVER_TIMESTAMP, updatedAt: SERVER_TIMESTAMP
    }, images),
    /500개.*변환/
  );
  assert.deepEqual(transformFake.calls(), []);

  const byteFake = makeFirestoreFake({}, {
    maxRequestWrites: 500,
    maxRequestBytes: 10_000_000
  });
  const byteStore = createStore(byteFake);
  await assert.rejects(
    () => byteStore.saveQuizSetWithImages('set1', { title: '세트' }, {
      v0q0: '가'.repeat(3_166_667)
    }),
    /10 MiB/
  );
  assert.deepEqual(byteFake.calls(), []);
});

test('사본과 세션 snapshot 트랜잭션도 transform 수와 10 MiB를 쓰기 전에 거부한다', async () => {
  const sourceImages = Object.fromEntries(
    Array.from({ length: 497 }, (_, index) => [
      'images/source/q/v0q' + index, { data: 'x' }
    ])
  );
  const copyFake = makeFirestoreFake({
    'quiz_sets/source': {
      title: '원본', videos: [{ questions: [] }], ownerUid: 'owner'
    },
    ...sourceImages
  }, { maxRequestWrites: 500, maxRequestBytes: 10_000_000 });
  const copyStore = createStore(copyFake);
  await assert.rejects(
    () => copyStore.copyOwnedQuizSet('source', 'copy', {
      uid: 'teacher-1', email: 'teacher@school.kr'
    }),
    /500개.*변환/
  );
  assert.equal(copyFake.calls().some(call => call.operation === 'runTransaction'), false);

  const huge = '가'.repeat(3_166_667);
  const sessionFake = makeFirestoreFake({}, {
    maxRequestWrites: 500,
    maxRequestBytes: 10_000_000
  });
  const sessionStore = createStore(sessionFake);
  await assert.rejects(
    () => sessionStore.startSession('session1', {
      setId: 'set1', createdAt: SERVER_TIMESTAMP,
      setSnapshot: { title: '세트', videos: [{ questions: [] }] },
      snapshotImages: { v0q0: huge }
    }, () => 'ABC234'),
    /10 MiB/
  );
  assert.equal(sessionFake.calls().some(call => call.operation === 'runTransaction'), false);
});

test('8 MB 안전 ceiling은 Unicode·base64 save/copy/session 요청을 backend 전에 거부한다', async () => {
  const unicodePayload = '가'.repeat(2_700_000);
  const base64Payload = 'data:image/jpeg;base64,' + 'A'.repeat(8_100_000);

  const saveFake = makeFirestoreFake({}, { maxRequestBytes: 10_000_000 });
  await assert.rejects(
    () => createStore(saveFake).saveQuizSetWithImages(
      '세트-한글', { title: '세트' }, { v0q0: unicodePayload }
    ),
    /10 MiB/
  );
  assert.deepEqual(saveFake.calls(), []);

  const copyFake = makeFirestoreFake({
    'quiz_sets/source': {
      title: '원본', videos: [{ questions: [] }], ownerUid: 'owner', contentRevision: 1
    },
    'images/source/q/v0q0': { data: base64Payload }
  }, { maxRequestBytes: 10_000_000 });
  await assert.rejects(
    () => createStore(copyFake).copyOwnedQuizSet('source', 'copy', {
      uid: 'teacher-1', email: 'teacher@school.kr'
    }),
    /10 MiB/
  );
  assert.equal(copyFake.calls().some(call => call.operation === 'runTransaction'), false);

  const sessionFake = makeFirestoreFake({}, { maxRequestBytes: 10_000_000 });
  await assert.rejects(
    () => createStore(sessionFake).startSession('session1', {
      setId: 'set1', teacherUid: 'teacher-1', createdAt: SERVER_TIMESTAMP,
      setSnapshot: { title: '세트', videos: [{ questions: [] }] },
      snapshotImages: { v0q0: unicodePayload }
    }, () => 'ABC234'),
    /10 MiB/
  );
  assert.equal(sessionFake.calls().some(call => call.operation === 'runTransaction'), false);
});

test('delete-heavy 이미지 교체는 기존 문서·index 비용을 읽은 뒤 batch 전에 거부한다', async () => {
  const existingData = '가'.repeat(10_500);
  const initial = {
    'quiz_sets/set1': {
      title: '세트', ownerUid: 'teacher-1', contentRevision: 1,
      lifecycleState: 'active', collaboratorCount: 0, imageCount: 300
    }
  };
  for (let index = 0; index < 300; index += 1) {
    initial['images/set1/q/v0q' + index] = { data: existingData };
  }
  const fake = makeFirestoreFake(initial, { maxRequestBytes: 10_000_000 });
  const store = createStore(fake);

  await assert.rejects(
    () => store.saveQuizSetWithImages('set1', { title: '모두 삭제' }, {}),
    /10 MiB/
  );

  assert.equal(fake.calls().some(call => call.operation === 'getCollection'), true);
  assert.equal(fake.calls().some(call => call.operation === 'batchCommit'), false);
});

test('작은 overwrite도 기존 Unicode 부모와 same-key 이미지의 제거 비용까지 8 MB 전에 거부한다', async () => {
  const oldParent = {
    title: '가'.repeat(1_400_000),
    ...Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [
      '색인필드' + index, '값' + index
    ]))
  };
  const initial = {
    'quiz_sets/set1': {
      ...oldParent, lifecycleState: 'active', collaboratorCount: 0, imageCount: 1
    },
    'images/set1/q/v0q0': { data: 'data:image/jpeg;base64,' + 'A'.repeat(4_000_000) }
  };
  const fake = makeFirestoreFake(initial, {
    maxRequestBytes: 10_000_000,
    maxRequestWrites: 500
  });
  const store = createStore(fake);

  await assert.rejects(
    () => store.saveQuizSetWithImages('set1', {
      title: '작은 교체', videos: [{ questions: [{ text: '교체' }] }]
    }, { v0q0: 'small' }),
    /8 MB.*사전 제한/
  );

  assert.equal(fake.calls().some(call => call.operation === 'get'), true);
  assert.equal(fake.calls().some(call => call.operation === 'getCollection'), true);
  assert.equal(fake.calls().some(call => call.operation === 'batchCommit'), false);
});

test('사본 목적지 overwrite도 기존 부모와 same-key image 비용을 transaction 전에 거부한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/source': {
      title: '원본', videos: [{ questions: [{ text: '문항' }] }],
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', contentRevision: 1
    },
    'images/source/q/v0q0': { data: 'small-source' },
    'quiz_sets/destination': { title: '가'.repeat(1_400_000) },
    'images/destination/q/v0q0': {
      data: 'data:image/jpeg;base64,' + 'B'.repeat(4_000_000)
    }
  }, { maxRequestBytes: 10_000_000, maxRequestWrites: 500 });
  const store = createStore(fake);

  await assert.rejects(
    () => store.copyOwnedQuizSet('source', 'destination', {
      uid: 'owner', email: 'owner@school.kr'
    }),
    /8 MB.*사전 제한/
  );

  assert.equal(fake.calls().some(call => call.operation === 'runTransaction'), false);
});

test('이미지 transaction이 실패하면 authoritative counter를 어기지 않고 재시도할 수 있다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: '이전', videos: [{ questions: [{ text: '이전 문항' }] }],
      lifecycleState: 'active', collaboratorCount: 0, imageCount: 1
    },
    'images/set1/q/v0q0': { data: 'old-image' }
  }, { failTransactionAt: 2, failTransactionMessage: 'image write failed' });
  const store = createStore(fake);

  await assert.rejects(store.saveQuizSetWithImages('set1', {
    title: '새 값', videos: [{ questions: [{ text: '새 문항' }, { text: '추가 문항' }] }]
  }, { v0q0: 'new-image', v0q1: 'second-image' }), /image write failed/);

  assert.equal(fake.value('quiz_sets/set1').title, '새 값');
  assert.equal(fake.value('quiz_sets/set1').imageCount, 1);
  assert.equal(fake.value('images/set1/q/v0q0').data, 'new-image');
  assert.equal(fake.value('images/set1/q/v0q1'), undefined);
});

test('세션 시작은 세트와 이미지 revision을 고정하고 이후 편집과 분리한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: '시작 전', videos: [{ questions: [{ text: '원래 문항', imgUp: true }] }],
      lifecycleState: 'active', collaboratorCount: 0, imageCount: 1
    },
    'images/set1/q/v0q0': { data: 'original-image' }
  });
  const store = createStore(fake);
  const setSnapshot = await store.getQuizSet('set1');
  const snapshotImages = await store.getImages('set1');

  await store.startSession('session1', {
    setId: 'set1', setTitle: '시작 전', setSnapshot, snapshotImages,
    createdAt: SERVER_TIMESTAMP, status: 'live'
  }, () => 'ABC234');
  await store.saveQuizSetWithImages('set1', {
    title: '수정 후', videos: [{ questions: [{ text: '바뀐 문항', imgUp: true }] }]
  }, { v0q0: 'changed-image' });

  assert.equal((await store.getSessionQuizSet('session1', 'set1')).title, '시작 전');
  assert.equal((await store.getSessionQuizSet('session1', 'set1')).videos[0].questions[0].text, '원래 문항');
  assert.equal(await store.getSessionQuestionImage('session1', 'set1', 'v0q0'), 'original-image');
  assert.equal(fake.value('sessions/session1').setSnapshot, undefined);
  assert.equal(fake.value('sessions/session1').snapshotImages, undefined);
  assert.equal(fake.value('sessions/session1/snapshot/set').title, '시작 전');
});

test('snapshotVersion 1은 누락되거나 손상된 snapshot을 mutable 세트로 fallback하지 않는다', async () => {
  const missingFake = makeFirestoreFake({
    'quiz_sets/set1': { title: '수정 가능한 현재 세트', videos: [{ questions: [] }] }
  });
  const missingStore = createStore(missingFake);

  await assert.rejects(
    () => missingStore.getSessionQuizSet({ id: 's1', setId: 'set1', snapshotVersion: 1 }),
    /스냅샷/
  );
  assert.equal(missingFake.calls().some(call => call.path === 'quiz_sets/set1'), false);

  const corruptFake = makeFirestoreFake({
    'sessions/s1/snapshot/set': { title: 'videos가 없는 손상 문서' },
    'quiz_sets/set1': { title: '현재 세트', videos: [{ questions: [] }] }
  });
  const corruptStore = createStore(corruptFake);
  await assert.rejects(
    () => corruptStore.getSessionQuizSet({ id: 's1', setId: 'set1', snapshotVersion: 1 }),
    /스냅샷/
  );
  await assert.rejects(
    () => corruptStore.getSessionQuestionImage(
      { id: 's1', setId: 'set1', snapshotVersion: 1 }, 'v0q0'
    ),
    /스냅샷 이미지/
  );
});

test('snapshotVersion 없는 legacy 세션만 현재 세트와 이미지 fallback을 사용한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': { title: 'legacy 현재 세트', videos: [{ questions: [] }] },
    'images/set1/q/v0q0': { data: 'legacy-image' }
  });
  const store = createStore(fake);
  const legacySession = { id: 'legacy', setId: 'set1' };

  assert.equal((await store.getSessionQuizSet(legacySession)).title, 'legacy 현재 세트');
  assert.equal(await store.getSessionQuestionImage(legacySession, 'v0q0'), 'legacy-image');
});

test('학생은 세션 snapshot과 현재 편집본을 읽지 않고 공개 live만 기다린다', async () => {
  const calls = [];
  const context = {
    st: {
      code: 'ABC234', sessionId: null, session: null
    },
    store: {
      async getCode() { return { sessionId: 'session1' }; },
      async getSession() { return { id: 'session1', setId: 'set1', setTitle: '원래 세트' }; },
      async getSessionQuizSet(sessionId, setId) {
        calls.push(['snapshot', sessionId, setId]);
        return { title: '원래 세트', videos: [{ questions: [{ text: '원래 문항' }] }] };
      },
      async getQuizSet() { calls.push(['mutable']); return { title: '수정본', videos: [] }; }
    },
    PlaylistCore: require('../playlist-core.js'),
    stShell() {}, stRenderCodeForm() {}, stRenderIdentityForm() { calls.push(['identity']); },
    lsSet() {}, normSet(value) { return value; }, console
  };
  loadStageFunctions(['stLookupCode'], context);

  await context.stLookupCode('ABC234');

  assert.deepEqual(calls, [['identity']]);
  assert.equal(context.st.set, undefined);
});

test('대시보드는 세션 snapshot을 현재 편집본보다 우선한다', async () => {
  const calls = [];
  const context = {
    dash: null,
    store: {
      async getSession() {
        return { id: 'session1', setId: 'set1', setTitle: '원래 세트', snapshotVersion: 1 };
      },
      async getSessionQuizSet(session) {
        calls.push(['snapshot', session]);
        return { title: '원래 세트', videos: [{ questions: [{ text: '원래 문항' }] }] };
      },
      async getQuizSet() { calls.push(['mutable']); return null; },
      subscribeStudents() { return () => {}; }, subscribeResponses() { return () => {}; },
      subscribeGrades() { return () => {}; }
    },
    FirestoreCore: require('../firestore-core.js'), PlaylistCore: require('../playlist-core.js'),
    APP() { return { innerHTML: '' }; }, topbar() { return ''; }, normSet(value) { return value; },
    normSettings() { return {}; }, renderDash() {}, onCleanup() {}, go() {}, esc(value) { return value; }, console
  };
  loadStageFunctions(['screenDashboard'], context);

  await context.screenDashboard('session1');

  assert.deepEqual(calls, [['snapshot', {
    id: 'session1', setId: 'set1', setTitle: '원래 세트', snapshotVersion: 1
  }]]);
  assert.equal(context.dash.flatQuestions[0].text, '원래 문항');
});

test('이전 편집 화면 cleanup과 조회 결과는 새 편집 상태와 player를 건드리지 않는다', async () => {
  let resolveOld;
  const oldLoad = new Promise(resolve => { resolveOld = resolve; });
  const cleanups = [];
  let renders = 0;
  let oldDestroyed = 0;
  let newDestroyed = 0;
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    lsGet() { return ''; }, DEFAULT_SETTINGS: {}, blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} }, mkHandleSaveShortcut() {},
    onCleanup(fn) { cleanups.push(fn); }, clearTimeout() {}, every() {}, $() { return null; },
    APP() { return { innerHTML: '' }; }, topbar() { return ''; },
    store: {
      getQuizSet(id) { return id === 'old' ? oldLoad : Promise.resolve(null); },
      async getImages() { return {}; }
    },
    normSet(value) { return value; }, mkRestoreDraft() {}, renderMake() { renders += 1; },
    console, toast() {}
  };
  loadStageFunctions(['screenMake'], context);

  context.screenMake('old');
  const oldCleanup = cleanups[0];
  context.mkPlayer = { destroy() { oldDestroyed += 1; } };
  context.mk.player = context.mkPlayer;
  context.screenMake();
  const newState = context.mk;
  const newPlayer = { destroy() { newDestroyed += 1; } };
  context.mkPlayer = newPlayer;
  newState.player = newPlayer;
  oldCleanup();
  resolveOld({ title: '늦은 세트', settings: {}, videos: [{ questions: [{ text: '늦은 문항' }] }] });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(context.mk, newState);
  assert.equal(context.mkPlayer, newPlayer);
  assert.equal(oldDestroyed, 1);
  assert.equal(newDestroyed, 0);
  assert.equal(renders, 1);
});

test('이전 재생 화면 cleanup과 조회 결과는 새 재생 상태와 player를 건드리지 않는다', async () => {
  let resolveOld;
  const oldLoad = new Promise(resolve => { resolveOld = resolve; });
  const cleanups = [];
  let intros = 0;
  let oldDestroyed = 0;
  let newDestroyed = 0;
  const context = {
    pl: null, PlaylistCore: require('../playlist-core.js'),
    store: {
      getQuizSet(id) {
        if (id === 'old') return oldLoad;
        return Promise.resolve({ title: '새 세트', videos: [{ questions: [{ text: '새 문항' }] }] });
      }
    },
    normSet(value) { return value; }, renderPlayIntro() { intros += 1; }, onCleanup(fn) { cleanups.push(fn); },
    APP() { return { innerHTML: '' }; }, topbar() { return ''; }, esc(value) { return value; }, go() {},
    document: {
      addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
      body: { classList: { remove() {} } }, fullscreenElement: null
    },
    window: { addEventListener() {}, removeEventListener() {} },
    plCleanupStageFullscreen() {}, plHandleFullscreenChange() {}, plHandleStageKeydown() {}, plClampQrBubble() {}, console
  };
  loadStageFunctions(['screenPlay'], context);

  context.screenPlay('old');
  const oldCleanup = cleanups[0];
  context.pl.player = { destroy() { oldDestroyed += 1; } };
  await context.screenPlay('new');
  const newState = context.pl;
  const newPlayer = { destroy() { newDestroyed += 1; } };
  newState.player = newPlayer;
  oldCleanup();
  resolveOld({ title: '늦은 세트', videos: [{ questions: [{ text: '늦은 문항' }] }] });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(context.pl, newState);
  assert.equal(newState.player, newPlayer);
  assert.equal(oldDestroyed, 1);
  assert.equal(newDestroyed, 0);
  assert.equal(intros, 1);
});

test('화면 cleanup은 아직 준비되지 않은 YouTube waiter를 취소한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const blockStart = html.indexOf('let ytReady = false;');
  const blockEnd = html.indexOf('/* ── 유튜브 자막', blockStart);
  const context = { window: {} };
  vm.runInNewContext(html.slice(blockStart, blockEnd), context);
  vm.runInNewContext(`
    var runs = 0;
    var cancel = whenYT(() => { runs += 1; });
    cancel();
    markYTReady();
  `, context);

  assert.equal(context.runs, 0);
});

test('이전 편집 화면의 지연 focus는 새 화면에서 실행되지 않는다', () => {
  let delayed;
  let focused = 0;
  const textarea = { focus() { focused += 1; } };
  const card = {
    scrollIntoView() {}, offsetWidth: 10,
    classList: { remove() {}, add() {} }, querySelector() { return textarea; }
  };
  const oldState = { videos: [] };
  const context = {
    mk: oldState,
    document: { getElementById() { return card; } },
    setTimeout(callback) { delayed = callback; }
  };
  loadStageFunctions(['mkFocusQuestion'], context);

  context.mkFocusQuestion(0, 0);
  context.mk = { videos: [] };
  delayed();

  assert.equal(focused, 0);
});

test('이전 편집 화면의 지연 초안 저장은 새 화면 내용을 저장하지 않는다', () => {
  let delayed;
  let writes = 0;
  const oldState = { id: 'old', saved: true };
  const context = {
    mk: oldState, mkDraftTimer: null,
    mkSetSaveStatus() {}, clearTimeout() {},
    setTimeout(callback) { delayed = callback; return 1; },
    mkPersistDraft() { writes += 1; }
  };
  loadStageFunctions(['mkMarkDirty'], context);

  context.mkMarkDirty();
  context.mk = { id: 'new', saved: true };
  delayed();

  assert.equal(writes, 0);
});

test('live 공개 실패는 due 문항을 제거하거나 fired 처리하지 않고 재시도 상태를 남긴다', async () => {
  const notices = [];
  let pauses = 0;
  const error = Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
  const context = {
    pl: {
      sessionId: 'session1', setId: 'set1', live: { q: -1 }, pendingLiveQuestion: -1,
      dueQuestions: [1], fired: [false, false],
      flatQuestions: [
        { type: 'choice', text: 'A', choices: [] },
        { number: 2, type: 'choice', text: 'B', choices: [] }
      ],
      set: { settings: { autoPause: true, revealMode: 'manual', limitSec: 20 } },
      player: { pauseVideo() { pauses += 1; } }
    },
    SV_TS: 999,
    limitFor() { return 20; },
    FirestoreStore: loadStoreModule(),
    store: { async setLive() { throw error; } },
    plRenderQList() {}, plRenderTimeline() {},
    toast(message) { notices.push(message); },
    console: { error() {} }
  };
  loadStageFunctions(['plOpenQuestion', 'plOpenNextDueQuestion'], context);

  await assert.rejects(() => context.plOpenNextDueQuestion(), /permission-denied/);

  assert.deepEqual(Array.from(context.pl.dueQuestions), [1]);
  assert.equal(context.pl.fired[1], false);
  assert.equal(context.pl.pendingLiveQuestion, -1);
  assert.equal(pauses, 1);
  assert.match(context.pl.openError, /permission-denied/);
  assert.equal(notices.length, 1);
});

test('live 공개 실패 뒤 수동 재시도 성공은 같은 due를 제거하고 재생 가능 상태를 복원한다', async () => {
  let writes = 0;
  const context = {
    pl: {
      sessionId: 'session1', setId: 'set1', live: { q: -1 }, pendingLiveQuestion: -1,
      dueQuestions: [0], fired: [false],
      flatQuestions: [{ number: 1, type: 'choice', text: '재시도 문항', choices: [] }],
      set: { settings: { autoPause: true, revealMode: 'manual', limitSec: 20 } },
      player: { pauseVideo() {} }
    },
    SV_TS: 999, limitFor() { return 20; }, FirestoreStore: loadStoreModule(),
    store: {
      async setLive() {
        writes += 1;
        if (writes === 1) throw new Error('permission-denied');
      }
    },
    plRenderQList() {}, plRenderTimeline() {}, toast() {}, console: { error() {} }
  };
  loadStageFunctions(['plOpenQuestion', 'plOpenNextDueQuestion'], context);

  await assert.rejects(() => context.plOpenNextDueQuestion(), /permission-denied/);
  assert.equal(await context.plOpenQuestion(0), true);

  assert.equal(writes, 2);
  assert.deepEqual(Array.from(context.pl.dueQuestions), []);
  assert.equal(context.pl.fired[0], true);
  assert.equal(context.pl.openError, '');
  assert.equal(context.pl.pendingLiveQuestion, 0);
});

test('수동 문항 공개 성공은 같은 due 항목을 제거하고 fired를 완료 처리한다', async () => {
  const context = {
    pl: {
      sessionId: 'session1', setId: 'set1', live: { q: -1 }, pendingLiveQuestion: -1,
      dueQuestions: [1], fired: [false, false],
      flatQuestions: [
        { type: 'choice', text: 'A', choices: [] },
        { number: 2, type: 'choice', text: 'B', choices: [] }
      ],
      set: { settings: { autoPause: false, revealMode: 'manual', limitSec: 20 } },
      player: {}
    },
    SV_TS: 999,
    limitFor() { return 20; },
    FirestoreStore: loadStoreModule(),
    store: { async setLive() {} },
    plRenderQList() {}, plRenderTimeline() {}, toast() {}, console
  };
  loadStageFunctions(['plOpenQuestion'], context);

  assert.equal(await context.plOpenQuestion(1), true);
  assert.deepEqual(Array.from(context.pl.dueQuestions), []);
  assert.equal(context.pl.fired[1], true);
});

test('snapshot 이미지 누락은 빈 이미지 공개로 진행하지 않고 due 재시도 상태를 보존한다', async () => {
  let liveWrites = 0;
  const notices = [];
  const context = {
    pl: {
      sessionId: 'session1', setId: 'set1', snapshotVersion: 1,
      live: { q: -1 }, pendingLiveQuestion: -1,
      dueQuestions: [0], fired: [false],
      flatQuestions: [{ number: 1, key: 'v0q0', type: 'choice', text: 'A', choices: [], imgUp: true }],
      set: { settings: { autoPause: true, revealMode: 'manual', limitSec: 20 } },
      player: { pauseVideo() {} }
    },
    SV_TS: 999, limitFor() { return 20; },
    loadQuestionImage() { return Promise.reject(new Error('세션 스냅샷 이미지를 찾을 수 없습니다.')); },
    FirestoreStore: loadStoreModule(),
    store: { async setLive() { liveWrites += 1; } },
    plRenderQList() {}, plRenderTimeline() {}, toast(message) { notices.push(message); },
    console: { error() {} }
  };
  loadStageFunctions(['plOpenQuestion', 'plOpenNextDueQuestion'], context);

  await assert.rejects(() => context.plOpenNextDueQuestion(), /스냅샷 이미지/);

  assert.equal(liveWrites, 0);
  assert.deepEqual(Array.from(context.pl.dueQuestions), [0]);
  assert.equal(context.pl.fired[0], false);
  assert.equal(context.pl.pendingLiveQuestion, -1);
  assert.equal(notices.length, 1);
});

test('같은 tick에 지난 문항은 모두 queue에 남고 첫 문항만 연다', () => {
  const opened = [];
  const context = {
    pl: {
      player: { getCurrentTime() { return 10; }, getDuration() { return 100; } },
      playlistDone: false, playerLoading: false, playerError: null,
      set: { videos: [{ startSec: 0, endSec: 100 }], settings: { autoPause: false } },
      videoIndex: 0, lastT: 9, live: { q: -1 }, pendingLiveQuestion: -1,
      flatQuestions: [{ videoIndex: 0, t: 10 }, { videoIndex: 0, t: 10 }],
      fired: [false, false], dueQuestions: [], playbackEnded: false, transitionUntil: 0
    },
    PlaylistCore: require('../playlist-core.js'),
    plOpenQuestion(i) { opened.push(i); context.pl.pendingLiveQuestion = i; },
    plRenderTimeline() {}, plUpdateTimeline() {}, plTimelineDomain() { return { start: 0, end: 100 }; },
    plRenderTransition() {}, plCompletePlaylist() {}, plEffectiveEnd() { return 100; },
    $() { return null; }, document: { getElementById() { return null; } }, Date, fmtTime() { return ''; }
  };
  loadStageFunctions(['plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], context);

  context.plTick();

  assert.deepEqual(opened, [0]);
  assert.deepEqual(context.pl.dueQuestions, [1]);
  assert.deepEqual(context.pl.fired, [true, false]);
});

test('문항이 열린 동안 지난 문항을 queue에 보존하고 닫을 때 먼저 연다', async () => {
  const opened = [];
  let plays = 0;
  const context = {
    pl: {
      sessionId: 'session1', live: { q: 0 }, pendingLiveQuestion: -1,
      dueQuestions: [],
      player: {
        getCurrentTime() { return 20; }, getDuration() { return 100; },
        playVideo() { plays += 1; }
      },
      playlistDone: false, playerLoading: false, playerError: null,
      set: { videos: [{ startSec: 0, endSec: 100 }], settings: { autoPause: false } },
      videoIndex: 0, lastT: 10,
      flatQuestions: [{ videoIndex: 0, t: 5 }, { videoIndex: 0, t: 15 }],
      fired: [true, false], playbackEnded: false, transitionUntil: 0
    },
    async plGradeCurrentResponses() {},
    async plPushBoard() {},
    FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() {}, async closeLive() { return true; }
    },
    plOpenQuestion(i) { opened.push(i); context.pl.pendingLiveQuestion = i; },
    PlaylistCore: require('../playlist-core.js'),
    plRenderTimeline() {}, plUpdateTimeline() {}, plTimelineDomain() { return { start: 0, end: 100 }; },
    plRenderTransition() {}, plCompletePlaylist() {}, plEffectiveEnd() { return 100; },
    $() { return null; }, document: { getElementById() { return null; } }, Date, fmtTime() { return ''; }
  };
  loadStageFunctions(['plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick', 'plCloseQuestion'], context);

  context.plTick();
  assert.deepEqual(context.pl.dueQuestions, [1]);

  await context.plCloseQuestion();

  assert.deepEqual(opened, [1]);
  assert.equal(plays, 0);
  assert.equal(context.pl.live.q, -1);
});

test('물리 영상 길이는 설정 종료보다 우선하고 ENDED는 terminal 신호다', () => {
  let ticks = 0;
  const context = {
    pl: {
      expectedVideoId: 'video', playerLoading: false, activePlaybackGeneration: 1, loadGeneration: 1,
      videoIndex: 0, set: { videos: [{ endSec: 200 }] }, playbackEnded: false
    },
    YT: { PlayerState: { PLAYING: 1, CUED: 5, ENDED: 0 } },
    plPlayerEventVideoId() { return 'video'; },
    plPlayerEventStatus() { return { state: 0, currentTime: 120, duration: 120 }; },
    plTick() { ticks += 1; }, plRenderTimeline() {}
  };
  loadStageFunctions(['plEffectiveEnd', 'plHandlePlayerStateChange'], context);

  assert.equal(context.plEffectiveEnd({ endSec: 200 }, null, 120), 120);

  context.plHandlePlayerStateChange({ data: 0, target: {} });

  assert.equal(context.pl.playbackEnded, true);
  assert.equal(ticks, 1);
});

test('이전 재생 화면의 늦은 이미지 조회는 새 문항 overlay를 바꾸지 않는다', async () => {
  let resolveImage;
  const oldImage = new Promise(resolve => { resolveImage = resolve; });
  const oldElement = { src: '' };
  const newElement = { src: '' };
  const stage = { appendChild() {}, classList: { add() {} } };
  const context = {
    pl: {
      setId: 'set1', sessionId: 'session1', live: { q: 0, revealed: false },
      set: { settings: { revealMode: 'manual' } },
      flatQuestions: [{ type: 'choice', choices: ['A'], answer: 0, imgUp: true, key: 'v0q0' }],
      students: {}, responses: {}
    },
    document: {
      getElementById(id) {
        if (id === 'pl-stage') return stage;
        return null;
      },
      createElement() {
        return {
          id: '', className: '', innerHTML: '',
          querySelector() { return oldElement; }
        };
      },
      querySelector() { return newElement; }
    },
    loadQuestionImage() { return oldImage; },
    qType() { return 'choice'; }, hasImage() { return true; }, esc(value) { return value; },
    plStageRoot() { return stage; }, isTextType() { return false; },
    LETTERS: ['A'], plRenderOverlayCounts() {}, plRenderQList() {},
    plRevealed() { return false; }
  };
  loadStageFunctions(['plRenderOverlay'], context);

  context.plRenderOverlay();
  context.pl = {
    setId: 'set2', sessionId: 'session2', live: { q: 0 },
    set: { settings: { revealMode: 'manual' } }, flatQuestions: []
  };
  resolveImage('stale-image');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(newElement.src, '');
});

test('영상 길이를 알면 종료를 clamp하고 빈 종료 입력은 null을 복원한다', () => {
  const endInput = { value: '' };
  const endSlider = { max: 0, value: 0 };
  const context = {
    mk: { videos: [{ startSec: 10, endSec: 200, durationSec: null, questions: [] }] },
    document: {
      querySelector(selector) {
        if (selector === '[data-range-input="0-end"]') return endInput;
        if (selector === '[data-range-slider="0-end"]') return endSlider;
        return null;
      }
    },
    PlaylistCore: require('../playlist-core.js'), fmtTime(value) { return value + 's'; },
    mkMarkDirty() {}
  };
  loadStageFunctions(['mkTimelineDomain', 'mkRefreshVideoTiming', 'mkApplyDuration', 'mkSetRange'], context);

  context.mkApplyDuration(0, 120);
  assert.equal(context.mk.videos[0].endSec, 120);
  context.mkSetRange(0, 'end', '');

  assert.equal(context.mk.videos[0].endSec, null);
  assert.equal(endInput.value, '');
  assert.equal(endSlider.value, 120);
});

test('학생의 제출 다시고르기 재제출은 문항별 revision 순서로 직렬화된다', async () => {
  const writes = [];
  const resolvers = [];
  const context = {
    st: {
      sessionId: 'session1', authUid: 'student1', sid: 'student1',
      live: { q: 0, openedAt: 1000, limitSec: 30 },
      currentQuestion: { type: 'choice', choices: ['A', 'B'] },
      myAnswers: {}, sel: 0, multiSel: [], draft: '', submitted: false, revision: 0, writeQueues: {}
    },
    store: {
      writeStudentAnswer(...args) {
        writes.push(clone(args));
        return new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
      }
    },
    qType(q) { return q.type; }, serverNow() { return 1500; }, SV_TS: 999,
    multiCorrect() { return false; }, fmtMulti(value) { return value.join(','); }, shortCorrect() { return false; },
    stLocked() { return false; }, stRender() {}, toast() {}, console
  };
  for (const name of ['stHasDraftAnswer', 'stBuildAnswer', 'stQueueWrite', 'stSend', 'stSubmitCurrent', 'stReviseAnswer']) {
    vm.runInNewContext(extractFunction(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), name), context);
  }

  const first = context.stSubmitCurrent('button');
  const revise = context.stReviseAnswer();
  context.st.sel = 1;
  const second = context.stSubmitCurrent('button');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][3].revision, 1);

  resolvers[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1][3].revision, 2);
  assert.equal(writes[1][3].submitted, false);

  resolvers[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 3);
  assert.equal(writes[2][3].revision, 3);
  assert.equal(writes[2][3].answer, 1);
  resolvers[2].resolve();
  await Promise.all([first, revise, second]);
});

test('이전 revision 실패는 뒤이은 학생 답의 낙관 상태를 rollback하지 않는다', async () => {
  const writes = [];
  let rejectFirst;
  const context = {
    st: {
      sessionId: 'session1', authUid: 'student1', sid: 'student1', live: { q: 0 }, myAnswers: {},
      submitted: false, revision: 1, writeQueues: {}
    },
    store: {
      writeStudentAnswer(...args) {
        writes.push(clone(args));
        if (writes.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
        return Promise.resolve();
      }
    },
    stRender() {}, toast() {}, console: { error() {} }
  };
  loadStageFunctions(['stQueueWrite', 'stSend'], context);

  const first = context.stSend(
    { answer: 0, revision: 1, submitted: true, submittedAt: 999 },
    { answer: 0, revision: 1, submitted: true }
  );
  context.st.revision = 2;
  const secondLocal = { answer: 1, revision: 2, submitted: true };
  const second = context.stSend(
    { answer: 1, revision: 2, submitted: true, submittedAt: 999 }, secondLocal
  );
  await new Promise(resolve => setImmediate(resolve));
  rejectFirst(new Error('late failure'));
  await Promise.all([first, second]);

  assert.equal(context.st.submitted, true);
  assert.equal(context.st.myAnswers[0], secondLocal);
});

test('학생 queued 쓰기 실패는 live 문항이 바뀌어도 소유 revision을 rollback하고 알린다', async () => {
  let rejectWrite;
  const notices = [];
  const context = {
    st: {
      sessionId: 'session1', authUid: 'student1', sid: 'student1', live: { q: 0 },
      myAnswers: {}, submitted: false, revision: 1, writeQueues: {}
    },
    store: {
      writeStudentAnswer() {
        return new Promise((resolve, reject) => { rejectWrite = reject; });
      }
    },
    stRender() {}, toast(message) { notices.push(message); }, console: { error() {} }
  };
  loadStageFunctions(['stQueueWrite', 'stSend'], context);
  const local = { answer: 0, revision: 1, submitted: true };

  const sending = context.stSend(
    { answer: 0, revision: 1, submitted: true, submittedAt: 999 }, local
  );
  await new Promise(resolve => setImmediate(resolve));
  context.st.live = { q: 1 };
  context.st.revision = 2;
  context.st.submitted = false;
  rejectWrite(new Error('permission-denied'));
  assert.equal(await sending, false);

  assert.equal(context.st.myAnswers[0], undefined);
  assert.equal(context.st.submitted, false);
  assert.deepEqual(notices, ['전송 실패 — 다시 시도해 주세요']);
});

test('겹친 관리자 조회는 최신 filter snapshot만 게시한다', async () => {
  const pending = [];
  const body = { innerHTML: '' };
  const context = {
    adm: {
      sessions: {}, resp: {}, sets: {}, from: '2024-01-01', to: '2024-01-31',
      setFilter: '', gradeFilter: '', klassFilter: '', loading: false, detail: null,
      loadGeneration: 0, displayedSessionIds: []
    },
    store: {
      listSessions() { return new Promise(resolve => pending.push(resolve)); },
      async getSessionQuizSet(id) { return { title: id, videos: [{ questions: [{ text: id }] }] }; },
      async getCollection() { return {}; }
    },
    FirestoreCore: require('../firestore-core.js'), PlaylistCore: require('../playlist-core.js'),
    normSet(value) { return value; }, $(selector) { return selector === '#adm-body' ? body : null; },
    admFillSetOptions() {}, admRenderBody() {}, esc(value) { return value; }, Date, console
  };
  loadStageFunctions(['admLoad'], context);

  const first = context.admLoad();
  context.adm.from = '2024-02-01'; context.adm.to = '2024-02-29';
  const second = context.admLoad();
  pending[1]([{ id: 'new', createdAt: new Date('2024-02-10T00:00:00').getTime(), setId: 'set1' }]);
  await second;
  pending[0]([{ id: 'old', createdAt: new Date('2024-01-10T00:00:00').getTime(), setId: 'set1' }]);
  await first;

  assert.deepEqual(Object.keys(context.adm.sessions), ['new']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.adm.displayedSessionIds)), ['new']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.adm.displayedRange)), { from: '2024-02-01', to: '2024-02-29' });
});

test('300건 초과 결과는 sessions를 게시하지 않고 탭 전환 뒤에도 purge 대상이 되지 않는다', async () => {
  const body = { innerHTML: '' };
  const sessions = Array.from({ length: 301 }, (_, index) => ({
    id: 'session-' + index,
    createdAt: new Date('2024-01-15T00:00:00').getTime(),
    setId: 'set1'
  }));
  const context = {
    adm: {
      sessions: { stale: { setId: 'old' } }, resp: {}, sets: {},
      from: '2024-01-01', to: '2024-01-31', setFilter: '', gradeFilter: '', klassFilter: '',
      tab: 'sessions', loading: false, detail: null, loadGeneration: 0,
      displayedSessionIds: ['stale'], purgeSessionIds: ['stale']
    },
    store: { async listSessions() { return sessions; } },
    $(selector) { return selector === '#adm-body' ? body : null; },
    admCompute() {
      return {
        sessions: Object.keys(context.adm.sessions).map(id => ({ id })),
        students: {}, perSession: {}
      };
    },
    admSessionsView() { return 'sessions'; }, admManage() { return 'manage'; },
    admStudentsView() { return 'students'; }, admClassesView() { return 'classes'; },
    esc(value) { return String(value); }, Date, console
  };
  loadStageFunctions(['admLoad', 'admRenderBody'], context);

  await context.admLoad();
  context.adm.tab = 'manage';
  context.admRenderBody();

  assert.deepEqual(Object.keys(context.adm.sessions), []);
  assert.deepEqual(Array.from(context.adm.displayedSessionIds), []);
  assert.deepEqual(Array.from(context.adm.purgeSessionIds), []);
});

test('관리자 filter 입력이 accepted snapshot과 달라지면 purge를 막고 재조회를 요구한다', async () => {
  let purged, warning = '';
  const context = {
    adm: {
      from: '2024-02-01', to: '2024-02-29', displayedRange: { from: '2024-01-01', to: '2024-01-31' },
      setFilter: '', gradeFilter: '', klassFilter: '',
      purgeFilterSnapshot: {
        from: '2024-01-01', to: '2024-01-31', setFilter: '', gradeFilter: '', klassFilter: ''
      },
      displayedSessionIds: ['changed-session'], purgeSessionIds: ['shown-session']
    },
    admCompute() { return { sessions: [{ id: 'changed-session' }] }; },
    prompt() { return '삭제'; }, alert(message) { warning = message; }, toast() {}, admLoad() {},
    store: { async purgeSessions(ids) { purged = ids; } }
  };
  loadStageFunctions(['admPurgeFilterChanged', 'admPurge'], context);

  await context.admPurge();

  assert.equal(purged, undefined);
  assert.match(warning, /다시 조회/);
});

test('관리자 filter·tab 렌더는 accepted purge ID snapshot을 다시 쓰지 않는다', () => {
  const body = { innerHTML: '' };
  const context = {
    adm: {
      loading: false, detail: null, tab: 'sessions', setFilter: 'set-b',
      sessions: {
        one: { setId: 'set-a', students: {} },
        two: { setId: 'set-b', students: {} }
      },
      resp: {}, sets: {}, gradeFilter: '', klassFilter: '',
      displayedSessionIds: [], purgeSessionIds: Object.freeze(['one', 'two']),
      purgeFilterSnapshot: {
        from: '2024-01-01', to: '2024-01-31', setFilter: '', gradeFilter: '', klassFilter: ''
      },
      from: '2024-01-01', to: '2024-01-31'
    },
    $(selector) { return selector === '#adm-body' ? body : null; },
    admCompute() {
      return {
        sessions: [{ id: 'two', setId: 'set-b' }], students: {}, perSession: {
          two: { students: 0, answered: 0, correct: 0, graded: 0 }
        }
      };
    },
    admSessionsView() { return 'rendered'; }, admManage() { return 'manage'; },
    admStudentsView() {}, admClassesView() {}
  };
  loadStageFunctions(['admRenderBody'], context);

  context.admRenderBody();
  context.adm.tab = 'manage';
  context.admRenderBody();

  assert.deepEqual(Array.from(context.adm.displayedSessionIds), ['two']);
  assert.deepEqual(Array.from(context.adm.purgeSessionIds), ['one', 'two']);
  assert.equal(body.innerHTML, 'manage');
});

test('CSV 셀은 수식으로 해석되는 선행 문자를 quoting 전에 중화한다', () => {
  const context = {};
  loadStageFunctions(['csvSafeCell'], context);

  assert.equal(context.csvSafeCell('=HYPERLINK("https://bad")'), '\'=HYPERLINK("https://bad")');
  assert.equal(context.csvSafeCell('+1+1'), "'+1+1");
  assert.equal(context.csvSafeCell('-2+3'), "'-2+3");
  assert.equal(context.csvSafeCell('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(context.csvSafeCell('\tformula'), "'\tformula");
  assert.equal(context.csvSafeCell('\rformula'), "'\rformula");
  assert.equal(context.csvSafeCell('안전한 값'), '안전한 값');
  assert.equal(context.csvSafeCell(-2), '-2');
});

test('timer question stores authoritative close grace and reveal timestamps', async () => {
  let written;
  const context = {
    pl: {
      sessionId: 'session-a', setId: 'set-a', pendingLiveQuestion: -1,
      flatQuestions: [
        { number: 1, key: 'v0q0', type: 'choice', text: 'Q', choices: ['A', 'B'] }
      ],
      set: {
        settings: {
          autoPause: false, revealMode: 'timer', limitSec: 20, revealDelaySec: 5
        }
      },
      player: {}
    },
    serverNow() { return 100_000; },
    SV_TS: Symbol('server timestamp'),
    FirestoreStore: loadStoreModule(),
    limitFor() { return 20; },
    store: {
      async setLive(id, value) { written = [id, value]; }
    }
  };
  loadStageFunctions(['plOpenQuestion'], context);

  await context.plOpenQuestion(0);

  assert.equal(written[0], 'session-a');
  assert.equal(written[1].limitSec, 5);
  assert.equal(written[1].responseClosesAt.getTime(), 105_000);
  assert.equal(written[1].submitGraceUntil.getTime(), 107_000);
  assert.equal(written[1].revealAt.getTime(), 107_000);
  assert.equal(written[1].revealed, false);
  assert.equal(typeof written[1].liveToken, 'string');
  assert.ok(written[1].liveToken.length > 0);
  assert.equal('publicAnswer' in written[1], false);
});

test('timer reveal UI waits for the observed live document and stays hidden after write failure', async () => {
  let renders = 0;
  let rejects = 0;
  const overlay = { querySelector() { return null; } };
  const state = {
    set: { settings: { revealMode: 'timer', revealDelaySec: 5 } },
    live: {
      q: 0, openedAt: 1_000, revealed: false, revealAt: 5_000,
      publicQuestion: { number: 1, total: 1, type: 'choice', text: 'Q', choices: [] }
    },
    uiRevealed: false,
    revealPending: false,
    revealRequested: false,
    revealRetryAt: 0
  };
  const context = {
    pl: state,
    serverNow() { return 10_000; },
    document: { getElementById() { return overlay; } },
    FirestoreCore: core,
    plReveal() { rejects += 1; return Promise.reject(new Error('offline')); },
    plRenderOverlayCounts() { renders += 1; },
    console: { error() {} }
  };
  loadStageFunctions(['plRevealed', 'plTimerTick'], context);

  assert.equal(context.plRevealed(), false);
  context.plTimerTick();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(rejects, 1);
  assert.equal(renders, 0);
  assert.equal(state.revealPending, false);
  assert.equal(state.revealRequested, false);
  state.live.revealed = true;
  state.live.publicAnswer = { answer: 1 };
  assert.equal(context.plRevealed(), true);
});

test('close freezes writes, reloads the accepted revision, grades it, then persists the board', async () => {
  const events = [];
  const state = {
    sessionId: 'session-a',
    live: { q: 0, accepting: true },
    responseDocs: { s1: { uid: 's1', answers: {
      '0': { answer: 0, submitted: true, revision: 1 }
    } } },
    gradeDocs: {},
    responses: { '0': { s1: { answer: 0, submitted: true, revision: 1 } } },
    player: { playVideo() {} }
  };
  const context = {
    pl: state,
    FirestoreCore: core,
    store: {
      async freezeLive() { events.push('freeze'); return true; },
      async getResponses() {
        events.push('read-responses');
        return { s1: { uid: 's1', answers: {
          '0': { answer: 1, submitted: true, revision: 2 }
        } } };
      },
      async getGrades() { events.push('read-grades'); return {}; },
      async closeLive() { events.push('close'); return true; }
    },
    async plGradeCurrentResponses(current, questionIndex) {
      const response = current.responses[String(questionIndex)].s1;
      events.push('grade:' + response.revision);
      response.ok = true;
    },
    async plPushBoard() {
      events.push('board:' + (state.responses['0'].s1.ok ? 1 : 0));
    },
    plOpenNextDueQuestion() { return false; },
    plTick() {}
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'plCloseQuestion'
  ), context);

  await context.plCloseQuestion();

  assert.deepEqual(events, [
    'freeze', 'read-responses', 'read-grades', 'grade:2', 'board:1', 'close'
  ]);
});
