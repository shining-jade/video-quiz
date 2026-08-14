const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER_TIMESTAMP = Symbol('server timestamp');
const DELETE_FIELD = Symbol('delete field');

function clone(value) {
  if (value === undefined) return undefined;
  if (value === SERVER_TIMESTAMP) return value;
  if (value === DELETE_FIELD) return value;
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
    else result[key] = clone(value);
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
    },
    delete() {
      return DELETE_FIELD;
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
          calls.push({ operation: 'batchCommit', size: operations.length });
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

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 함수를 찾을 수 있어야 한다');
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

function createStore(fake) {
  const { createFirestoreStore } = loadStoreModule();
  return createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
}

test('이미지를 문항별 문서로 교체하고 기존 화면 형태로 읽는다', async () => {
  const fake = makeFirestoreFake({
    'images/set1/q/0': { data: 'old' },
    'images/set1/q/3': { data: 'remove-me' }
  });
  const store = createStore(fake);

  await store.replaceImages('set1', { '0': 'new', '2': 'third' });

  assert.deepEqual(await store.getImages('set1'), { '0': 'new', '2': 'third' });
  assert.equal(fake.has('images/set1/q/3'), false);
});

test('기존 JSON의 희소 이미지 배열은 null 슬롯을 이미지 문서로 저장하지 않는다', async () => {
  const fake = makeFirestoreFake({ 'images/set1/q/1': { data: 'remove-old' } });
  const store = createStore(fake);

  await store.replaceImages('set1', ['first', null, 'third']);

  assert.deepEqual(await store.getImages('set1'), { '0': 'first', '2': 'third' });
  assert.equal(fake.has('images/set1/q/1'), false);
});

test('세트 목록과 단건 읽기는 문서 ID를 우선하고 문항 배열을 보존한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      id: 'payload-id',
      title: '첫 세트',
      questions: [{ type: 'choice', text: '문항' }]
    }
  });
  const store = createStore(fake);

  assert.deepEqual(await store.listQuizSets(), [{
    id: 'set1',
    title: '첫 세트',
    questions: [{ type: 'choice', text: '문항' }]
  }]);
  assert.deepEqual(await store.getQuizSet('set1'), {
    id: 'set1',
    title: '첫 세트',
    questions: [{ type: 'choice', text: '문항' }]
  });
});

test('세트 날짜 Timestamp는 기존 화면과 내보내기가 쓰는 밀리초 숫자로 바꾼다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: '날짜 세트',
      createdAt: { toMillis: () => 1_700_000_000_000 },
      updatedAt: { toMillis: () => 1_700_000_100_000 }
    }
  });
  const store = createStore(fake);

  assert.deepEqual(await store.listQuizSets(), [{
    id: 'set1', title: '날짜 세트',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000
  }]);
  assert.deepEqual(await store.getQuizSet('set1'), {
    id: 'set1', title: '날짜 세트',
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

  assert.deepEqual(fake.value('quiz_sets/set1'), { title: '저장', questions });
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
  const fake = makeFirestoreFake({ 'images/set1/q/2': { data: 'data:image/png;base64,abc' } });
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
    questions: [{ type: 'choice', text: '문항' }], createdAt: 100, updatedAt: 100
  });
  assert.deepEqual(fake.value('quiz_sets/source'), {
    title: '원본', author: '교사', questions: [{ type: 'choice', text: '문항' }]
  });
  assert.deepEqual(fake.value('quiz_sets/copy'), {
    title: '원본 (사본)', author: '새 교사',
    questions: [{ type: 'choice', text: '문항' }], createdAt: 100, updatedAt: 100
  });
  assert.deepEqual(await store.getImages('copy'), { '0': 'first-image', '2': 'third-image' });
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
      async getImages() { return { '0': 'image-data' }; }
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
  assert.deepEqual(JSON.parse(JSON.stringify(pack.images)), { '0': 'image-data' });
  assert.equal(pack.v, 1);
  assert.match(pack.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('이미지가 없는 편집 저장도 빈 이미지 집합으로 교체한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    mk: { id: 'set1', saved: false, questions: [] },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '수정', questions: [{ text: '문항' }] }, images: {} }; },
    rid() { return 'new-id'; },
    SV_TS: { kind: 'timestamp' },
    store: {
      async saveQuizSet(id, data) { calls.push(['save', id, clone(data)]); },
      async replaceImages(id, images) { calls.push(['images', id, clone(images)]); }
    },
    toast() {},
    normQuestions(value) { return clone(value); },
    imgCache: {},
    location: { hash: '#/make/set1' },
    history: { replaceState() {} },
    renderMake() {},
    $() { return null; },
    alert(message) { throw new Error(message); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'mkSave'), context);

  await context.mkSave(false);

  assert.deepEqual(calls, [
    ['save', 'set1', { title: '수정', questions: [{ text: '문항' }] }],
    ['images', 'set1', {}]
  ]);
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
