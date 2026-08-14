const test = require('node:test');
const assert = require('node:assert/strict');

const SERVER_TIMESTAMP = Symbol('server timestamp');

function clone(value) {
  if (value === undefined) return undefined;
  if (value === SERVER_TIMESTAMP) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function merge(current, update) {
  const result = clone(current || {});
  Object.entries(update).forEach(([key, value]) => {
    result[key] = clone(value);
  });
  return result;
}

function makeFirestoreFake(initial = {}, options = {}) {
  const committedServerMillis = options.committedServerMillis ?? 50_000;
  const documents = new Map(Object.entries(initial).map(([path, value]) => [path, clone(value)]));
  const documentListeners = new Map();
  const collectionListeners = new Map();
  const subscribed = [];
  const calls = [];
  let pending = Promise.resolve();

  const fieldValue = {
    serverTimestamp() {
      return SERVER_TIMESTAMP;
    }
  };

  function resolveServerTimestamps(value) {
    if (value === SERVER_TIMESTAMP) {
      return { toMillis: () => committedServerMillis };
    }
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

  function querySnapshot(path, source = documents) {
    const docs = collectionDocs(path, source);
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

  function collectionRef(path) {
    return {
      id: path.split('/').at(-1),
      path,
      async get() {
        calls.push({ operation: 'getCollection', path });
        return querySnapshot(path);
      },
      onSnapshot(next, error) {
        return addListener(collectionListeners, path, next, error, querySnapshot);
      }
    };
  }

  const db = {
    doc: docRef,
    collection: collectionRef,
    async runTransaction(updateFunction) {
      calls.push({ operation: 'runTransaction' });
      const staged = new Map(documents);
      const touched = new Set();
      const transaction = {
        async get(ref) {
          calls.push({ operation: 'transactionGet', path: ref.path });
          return docSnapshot(ref.path, staged);
        },
        set(ref, value, optionsArg) {
          calls.push({ operation: 'transactionSet', path: ref.path, value: clone(value), options: clone(optionsArg) });
          const resolved = resolveServerTimestamps(value);
          staged.set(ref.path, optionsArg && optionsArg.merge
            ? merge(staged.get(ref.path), resolved)
            : clone(resolved));
          touched.add(ref.path);
          return transaction;
        },
        delete(ref) {
          calls.push({ operation: 'transactionDelete', path: ref.path });
          staged.delete(ref.path);
          touched.add(ref.path);
          return transaction;
        }
      };
      const result = await updateFunction(transaction);
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

test('학생 live 구독은 정확히 한 문서를 구독하고 해제할 수 있다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': { q: 2, revealed: false }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
  let received;
  const stop = store.subscribeDoc('sessions/a/meta/live', value => { received = value; });
  await fake.flush();
  assert.deepEqual(received, { q: 2, revealed: false });
  stop();
  fake.emit('sessions/a/meta/live', { q: 3 });
  await fake.flush();
  assert.deepEqual(received, { q: 2, revealed: false });
  assert.deepEqual(fake.subscribedPaths(), ['sessions/a/meta/live']);
});

test('문서와 컬렉션 CRUD는 Firestore 데이터를 화면용 객체로 반환한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({
    'quiz_sets/a': { title: '첫 세트', archived: false },
    'quiz_sets/b': { title: '둘째 세트', archived: true }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);

  assert.deepEqual(await store.getDoc('quiz_sets/a'), { title: '첫 세트', archived: false });
  assert.equal(await store.getDoc('quiz_sets/missing'), null);
  assert.deepEqual(await store.getCollection('quiz_sets'), {
    a: { title: '첫 세트', archived: false },
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
  const fake = makeFirestoreFake({ 'codes/ABC234': { sessionId: 'old' } });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1_000);
  assert.equal(await store.claimSessionCode('ABC234', 'new', { setId: 'set1' }), false);
  assert.deepEqual(fake.value('codes/ABC234'), { sessionId: 'old' });
  assert.equal(fake.has('sessions/new'), false);
  assert.equal(fake.calls().some(call => call.operation === 'transactionSet'), false);
});

test('빈 반 코드는 한 트랜잭션에서 코드·세션·live·board를 초기화한다', async () => {
  const { createFirestoreStore } = loadStoreModule();
  const fake = makeFirestoreFake({}, { committedServerMillis: 20_000 });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1_000);
  const session = { setId: 'set1', label: '3학년 2반', status: 'active' };

  assert.equal(await store.claimSessionCode('ABC234', 'new', session), true);
  const codeDocument = fake.value('codes/ABC234');
  assert.equal(codeDocument.sessionId, 'new');
  assert.equal(codeDocument.createdAt.toMillis(), 20_000);
  assert.deepEqual(fake.value('sessions/new'), session);
  assert.deepEqual(fake.value('sessions/new/meta/live'), {
    q: -1, openedAt: 0, revealed: false, limitSec: 0
  });
  assert.deepEqual(fake.value('sessions/new/meta/board'), { scores: {} });
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 1);
});
