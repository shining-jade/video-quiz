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
    else if (value && typeof value === 'object' && !Array.isArray(value) &&
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value);
    } else result[key] = clone(value);
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

  function querySnapshot(path, source = documents, filters = []) {
    const docs = collectionDocs(path, source).filter(document =>
      filters.every(filter => filter.operator === '==' && document.get(filter.field) === filter.value)
    );
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

  assert.deepEqual(await store.getImages('set1'), { v0q0: 'new', v0q2: 'third' });
  assert.equal(fake.has('images/set1/q/0'), false);
  assert.equal(fake.value('images/set1/q/v0q0').data, 'new');
  assert.equal(fake.has('images/set1/q/3'), false);
});

test('기존 JSON의 희소 이미지 배열은 null 슬롯을 이미지 문서로 저장하지 않는다', async () => {
  const fake = makeFirestoreFake({ 'images/set1/q/1': { data: 'remove-old' } });
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
  assert.equal(legacy.questions, undefined);
  assert.equal(legacy.videoId, undefined);
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
    questions: [{ type: 'choice', text: '문항' }], createdAt: 100, updatedAt: 100
  });
  assert.deepEqual(fake.value('quiz_sets/source'), {
    title: '원본', author: '교사', questions: [{ type: 'choice', text: '문항' }]
  });
  assert.deepEqual(fake.value('quiz_sets/copy'), {
    title: '원본 (사본)', author: '새 교사',
    questions: [{ type: 'choice', text: '문항' }], createdAt: 100, updatedAt: 100
  });
  assert.deepEqual(await store.getImages('copy'), { v0q0: 'first-image', v0q2: 'third-image' });
  assert.equal(fake.value('images/copy/q/v0q0').data, 'first-image');
  assert.equal(fake.has('images/copy/q/0'), false);
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
      async saveQuizSet(id, value) { saved.push([id, clone(value)]); },
      async replaceImages(id, value) { images.push([id, clone(value)]); }
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
          title: '세트', author: '교사', settings: {}, createdAt: 10, updatedAt: 20,
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
  loadStageFunctions(['screenMake'], context);

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

  assert.equal(elements.get('[data-range-input="0-end"]').value, '2:00');
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
    ['save', 'set1', { title: '수정', questions: [{ text: '문항' }] }],
    ['images', 'set1', {}]
  ]);
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
    mk: { id: 'set1', saved: false, questions: [] },
    localStorage: {},
    EditorDraft: {
      write(storage, id) { calls.push(['draft', id]); },
      clear(storage, id) { calls.push(['clear', id]); }
    },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '수정', questions: [] }, images: {} }; },
    rid() { return 'new-id'; }, SV_TS: {},
    store: { async saveQuizSet() {}, async replaceImages() {} },
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
      id: 'set1', title: '세트', author: '', settings: {}, createdAt: 10,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: '첫 값', choices: [] }] }],
      activeVideo: 0, saved: false
    },
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type; }, normSettings(value) { return value; },
    mkValidate() { return ''; }, rid() { return 'new-id'; }, SV_TS: {},
    store: {
      async saveQuizSet(id, value) { saved.push(clone(value)); },
      async replaceImages() {}
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

test('세션 시작은 충돌한 후보를 건너뛰고 열 개 안에서 선점한 코드를 반환한다', async () => {
  const fake = makeFirestoreFake({ 'codes/OLD234': { sessionId: 'old' } });
  const store = createStore(fake);
  const candidates = ['OLD234', 'NEW234'];
  const session = { setId: 'set1', status: 'live' };

  const code = await store.startSession('new', session, () => candidates.shift());

  assert.equal(code, 'NEW234');
  assert.deepEqual(fake.value('sessions/new'), { ...session, code: 'NEW234' });
  assert.equal(fake.value('codes/NEW234').sessionId, 'new');
});

test('세션 시작은 열 후보가 모두 충돌하면 더 만들지 않고 실패한다', async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => ['codes/CODE' + index, { sessionId: 'old-' + index }])
  );
  const fake = makeFirestoreFake(initial);
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

test('학생·응답·live 구독은 세션의 각 Firestore 경로 데이터만 반환한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/students/s1': { name: '가' },
    'sessions/a/responses/s1': { answers: { '0': { c: 1, ok: true } } },
    'sessions/a/meta/live': { q: 0, openedAt: 123, revealed: false, limitSec: 20 }
  });
  const store = createStore(fake);
  let students;
  let responses;
  let live;

  const stops = [
    store.subscribeStudents('a', value => { students = value; }),
    store.subscribeResponses('a', value => { responses = value; }),
    store.subscribeLive('a', value => { live = value; })
  ];
  await fake.flush();

  assert.deepEqual(students, { s1: { name: '가' } });
  assert.deepEqual(responses, { s1: { answers: { '0': { c: 1, ok: true } } } });
  assert.deepEqual(live, { id: 'live', q: 0, openedAt: 123, revealed: false, limitSec: 20 });
  assert.deepEqual(fake.subscribedPaths(), [
    'sessions/a/students',
    'sessions/a/responses',
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

test('정답 공개는 revealed만 병합해 openedAt Timestamp를 그대로 보존한다', async () => {
  const openedAt = { toMillis: () => 12_345 };
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': { q: 2, openedAt, revealed: false, limitSec: 30 }
  });
  const store = createStore(fake);

  await store.revealLive('a');

  const live = fake.value('sessions/a/meta/live');
  assert.equal(live.q, 2);
  assert.equal(live.openedAt.toMillis(), 12_345);
  assert.equal(live.revealed, true);
  assert.equal(live.limitSec, 30);
});

test('세션 종료는 상태를 병합하고 live를 대기 상태로 되돌린다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': { setId: 'set1', status: 'live' },
    'sessions/a/meta/live': { q: 2, openedAt: 10, revealed: true, limitSec: 30 }
  }, { committedServerMillis: 20_000 });
  const store = createStore(fake);

  await store.endSession('a');

  const session = fake.value('sessions/a');
  assert.deepEqual({ setId: session.setId, status: session.status }, { setId: 'set1', status: 'ended' });
  assert.equal(session.endedAt.toMillis(), 20_000);
  assert.deepEqual(fake.value('sessions/a/meta/live'), {
    q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended'
  });
});

test('점수판은 meta/board 문서에 scores 필드로 쓴다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.writeBoard('a', { s1: 2, s2: 1 });

  assert.deepEqual(fake.value('sessions/a/meta/board'), { scores: { s1: 2, s2: 1 } });
});

test('교사 실행 화면은 학생·응답·live 구독을 저장소에 맡기고 응답 문서를 화면 형태로 바꾼다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const subscriptions = {};
  let boardWrites = 0;
  const app = { innerHTML: '' };
  const context = {
    pl: {
      sessionId: 'session-a', code: 'ABC234', students: {}, responses: {},
      live: { q: -1, openedAt: 0, revealed: false, limitSec: 0 },
      set: {
        title: '첫 세트', videoId: 'abcdefghijk', questions: [],
        settings: { revealMode: 'manual', limitSec: 0 }
      }
    },
    store: {
      subscribeStudents(id, next) { assert.equal(id, 'session-a'); subscriptions.students = next; return () => {}; },
      subscribeResponses(id, next) { assert.equal(id, 'session-a'); subscriptions.responses = next; return () => {}; },
      subscribeLive(id, next) { assert.equal(id, 'session-a'); subscriptions.live = next; return () => {}; }
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
    whenYT() {},
    every() {},
    plTick() {},
    plTimerTick() {},
    console
  };
  vm.runInNewContext(extractFunction(html, 'renderPlayRun'), context);

  context.renderPlayRun();
  subscriptions.students({ s1: { name: '가' } });
  subscriptions.responses({ s1: { answers: { '0': { c: 1, ok: true } } } });
  subscriptions.live({ q: 0, openedAt: 123, revealed: false, limitSec: 20 });

  assert.deepEqual(context.pl.students, { s1: { name: '가' } });
  assert.deepEqual(context.pl.responses, { '0': { s1: { c: 1, ok: true } } });
  assert.equal(context.pl.live.q, 0);
  assert.equal(boardWrites, 0);
  assert.match(app.innerHTML, /id="pl-stage" onpointerdown="plActivateStageControls\(\)"/);
  assert.doesNotMatch(app.innerHTML, /class="pl-stage-status"[^>]*aria-live/);
  assert.match(app.innerHTML, /<span aria-live="polite">참여 <b id="pl-nstu">0<\/b>명<\/span>/);
});

test('교사 수업 시작은 세션 정보와 코드 생성기를 저장소에 전달한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const serverTimestamp = Symbol('server timestamp');
  let received;
  let rendered = 0;
  const generated = ['SESSION12345', 'OLD234', 'NEW234'];
  const context = {
    pl: { setId: 'set1', set: { title: '첫 세트', author: '교사' } },
    $(selector) { return selector === '#pl-label' ? { value: '  2학년 3반  ' } : null; },
    lsSet() {},
    rid() { return generated.shift(); },
    SV_TS: serverTimestamp,
    store: {
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
      teacher: '교사', createdAt: serverTimestamp, status: 'live'
    },
    codes: ['OLD234', 'NEW234']
  });
  assert.equal(context.pl.code, 'NEW234');
  assert.equal(context.pl.sessionId, 'SESSION12345');
  assert.equal(rendered, 1);
});

test('반 코드 후보를 모두 쓴 실패는 기존 안내 문구를 유지한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let message = '';
  const context = {
    pl: { setId: 'set1', set: { title: '첫 세트', author: '' } },
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

test('문항 열기는 live 전체 상태를 쓰고 정답 공개는 revealed만 병합한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const serverTimestamp = Symbol('server timestamp');
  const writes = [];
  const context = {
    pl: {
      sessionId: 'session-a',
      live: { q: 2, openedAt: 123, revealed: false, limitSec: 20 },
      player: { pauseVideo() {} },
      set: { settings: { autoPause: true, revealMode: 'manual' } }
    },
    SV_TS: serverTimestamp,
    limitFor() { return 20; },
    store: {
      setLive(id, value) { writes.push(['setLive', id, value]); return Promise.resolve(); },
      revealLive(id) { writes.push(['revealLive', id]); return Promise.resolve(); }
    }
  };
  vm.runInNewContext(extractFunction(html, 'plOpenQuestion'), context);
  vm.runInNewContext(extractFunction(html, 'plReveal'), context);

  await context.plOpenQuestion(3);
  await context.plReveal();

  assert.deepEqual(clone(writes), [
    ['setLive', 'session-a', { q: 3, openedAt: serverTimestamp, revealed: false, limitSec: 20 }],
    ['revealLive', 'session-a']
  ]);
});

test('교사 수업 종료는 저장소 종료가 끝난 뒤 안내 화면으로 이동한다', async () => {
  const events = [];
  const context = {
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
      set: {
        title: '세트', settings: { revealMode: 'manual' },
        questions: [{ type: 'choice', text: '문제', choices: ['1', '2'] }]
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
});

test('넓은 화면의 문제 레이아웃은 stage 안의 실제 player-box를 왼쪽 패널로 배치한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(html, /#pl-stage\.quiz-open\s+\.player-box\s*\{[^}]*position:\s*fixed[^}]*width:\s*53vw[^}]*height:\s*100vh/s);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open\s+#pl-video/);
});

test('문제 오버레이 중 도구와 상태는 화면 가장자리에 고정되고 QR 제어는 클릭할 수 있다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const overlayRule = html.match(/^#overlay\s*\{([^}]*)\}/ms);
  const toolsRule = html.match(/#pl-stage\.quiz-open\s+\.pl-stage-tools\s*\{([^}]*)\}/s);
  const statusRule = html.match(/#pl-stage:fullscreen\.quiz-open\s+\.pl-stage-status,\s*#pl-stage\.fullscreen-fallback\.quiz-open\s+\.pl-stage-status\s*\{([^}]*)\}/s);
  const bubbleRule = html.match(/#pl-stage\s+#pl-qr-bubble\s*\{([^}]*)\}/s);

  assert.ok(overlayRule && toolsRule && statusRule && bubbleRule);
  const overlayZ = Number(overlayRule[1].match(/z-index:\s*(\d+)/)[1]);
  const toolsZ = Number(toolsRule[1].match(/z-index:\s*(\d+)/)[1]);
  const bubbleZ = Number(bubbleRule[1].match(/z-index:\s*(\d+)/)[1]);

  assert.ok(toolsZ > overlayZ);
  assert.ok(bubbleZ > overlayZ);
  assert.match(html, /<button class="btn sm" onclick="plToggleQrBubble\(\)"[^>]*>▦ QR<\/button>/);
  assert.match(html, /aria-label="QR 닫기" onclick="plToggleQrBubble\(\)"/);
  assert.match(bubbleRule[1], /right:\s*20px/);
  assert.match(bubbleRule[1], /top:\s*20px/);
  assert.match(toolsRule[1], /position:\s*fixed/);
  assert.match(toolsRule[1], /top:\s*16px/);
  assert.match(statusRule[1], /position:\s*fixed/);
  assert.match(statusRule[1], /bottom:\s*16px/);
  assert.match(html, /@media \(min-width:\s*900px\)[\s\S]*#pl-stage\.fullscreen-fallback\.quiz-open \.pl-stage-status\s*\{[^}]*right:\s*calc\(47vw \+ 20px\)/);
  assert.match(html, /#pl-stage:fullscreen\.quiz-open #overlay,\s*#pl-stage\.fullscreen-fallback\.quiz-open #overlay\s*\{[^}]*padding-top:\s*104px[^}]*padding-bottom:\s*64px/);
  assert.doesNotMatch(toolsRule[1] + bubbleRule[1], /pointer-events:\s*none/);
});

test('계속 재생은 전체화면을 유지하고 같은 플레이어를 재생한다', async () => {
  let writes = 0, played = 0, exits = 0;
  const player = { playVideo() { played++; } };
  const ctx = loadStageFunctions(['plCloseQuestion'], {
    pl: { sessionId: 'session1', player },
    plPushBoard() { return Promise.resolve(); },
    document: { fullscreenElement: {}, exitFullscreen() { exits++; } },
    store: { setLive() { writes++; return Promise.resolve(); } }
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
    pl: { sessionId: 'session-a', player: { playVideo() { calls.push('play'); } } },
    plPushBoard() { calls.push('board'); return Promise.resolve(); },
    store: {
      setLive(id, value) {
        calls.push(['live', id, value]);
        return Promise.resolve();
      }
    }
  };
  vm.runInNewContext(extractFunction(html, 'plCloseQuestion'), context);

  await context.plCloseQuestion();

  assert.equal(calls.filter(call => call === 'board').length, 1);
  assert.deepEqual(clone(calls[1]), ['live', 'session-a', {
    q: -1, openedAt: 0, revealed: false, limitSec: 0
  }]);
  assert.equal(calls[2], 'play');
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
      set: {
        settings: { revealMode: 'manual' },
        questions: [{ type: 'choice', choices: ['오답', '정답'], answer: 1 }]
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

  await store.mergeAnswer('a', 's1', 2, { txt: '서술', at: 123, ms: 456 });

  assert.deepEqual(await store.getOwnResponses('a', 's1'), {
    '0': { c: 1, ok: true },
    '2': { txt: '서술', at: 123, ms: 456 }
  });
});

test('응답 제출 상태는 현재 문항만 병합하고 다시 고르는 답도 보존한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': { answers: { '0': { c: 0, submitted: true } } }
  });
  const store = createStore(fake);

  await store.setAnswerState('a', 's1', 2, {
    c: 1, submitted: false, revision: 2
  });

  assert.deepEqual(await store.getOwnResponses('a', 's1'), {
    '0': { c: 0, submitted: true },
    '2': { c: 1, submitted: false, revision: 2 }
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

test('학생 입장 흐름은 단발 조회로 본인 정보와 본인 답만 복원한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const fields = {
    '#st-grade': { value: '3' },
    '#st-klass': { value: '2' },
    '#st-num': { value: '7' },
    '#st-name': { value: ' 홍길동 ' }
  };
  const context = {
    st: { sessionId: 'a', myAnswers: {} },
    $(selector) { return fields[selector]; },
    lsSet() {},
    SV_TS: Symbol('server timestamp'),
    store: {
      async getStudent(sessionId, studentId) {
        calls.push(['getStudent', sessionId, studentId]);
        return null;
      },
      async saveStudent(sessionId, studentId, value) {
        calls.push(['saveStudent', sessionId, studentId, value]);
      },
      async getOwnResponses(sessionId, studentId) {
        calls.push(['getOwnResponses', sessionId, studentId]);
        return { '0': { c: 1, ok: true, ms: 500 } };
      }
    },
    confirm() { return true; },
    stRenderIdentityForm() {},
    stStartWatching() { calls.push(['watch']); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'stJoin'), context);

  await context.stJoin();

  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['getStudent', 'a', '3_2_7'],
    ['saveStudent', 'a', '3_2_7'],
    ['getOwnResponses', 'a', '3_2_7'],
    ['watch']
  ]);
  assert.deepEqual(clone(context.st.myAnswers), {
    '0': { c: 1, cs: undefined, txt: undefined, ok: true, ms: 500, submitted: true, revision: 0 }
  });
});

test('학생 화면은 live 하나만 구독하고 문항이 닫힐 때 점수판을 한 번 읽는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let liveNext;
  const subscriptions = [];
  let boardReads = 0;
  const context = {
    st: {
      sessionId: 'a', session: { status: 'live' },
      live: { q: 2, openedAt: 10, revealed: false, limitSec: 20 },
      myAnswers: {}, board: {}
    },
    store: {
      subscribeLive(id, next) {
        subscriptions.push(id);
        liveNext = next;
        return () => {};
      },
      async getBoard(id) {
        assert.equal(id, 'a');
        boardReads += 1;
        return { s1: 2 };
      }
    },
    onCleanup() {},
    every() {},
    stTick() {},
    stRender() {},
    parseMulti() { return []; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'stStartWatching'), context);

  context.stStartWatching();
  await liveNext({ q: -1, openedAt: 0, revealed: false, limitSec: 0 });

  assert.deepEqual(subscriptions, ['a']);
  assert.equal(boardReads, 1);
  assert.deepEqual(clone(context.st.board), { s1: 2 });

  await liveNext({ q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended' });
  assert.equal(context.st.session.status, 'ended');
  assert.equal(boardReads, 1);
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
      myAnswers: { '3': { c: 1 } }, board: {}
    },
    store: {
      subscribeLive(id, next) { liveNext = next; return () => {}; },
      async getBoard() { await boardReady; return { s1: 2 }; }
    },
    onCleanup() {},
    every() {},
    stTick() {},
    stRender() {},
    parseMulti() { return []; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'stStartWatching'), context);
  context.stStartWatching();

  const closeRun = liveNext({ q: -1, openedAt: 0, revealed: false, limitSec: 0 });
  await Promise.resolve();
  await liveNext({ q: 3, openedAt: 30, revealed: false, limitSec: 20 });
  resolveBoard();
  await closeRun;

  assert.equal(context.st.live.q, 3);
  assert.equal(context.st.sel, 1);
  assert.equal(context.st.submitted, true);
});

test('학생 답 전송은 본인 응답 문서의 현재 문항만 병합한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const writes = [];
  const context = {
    st: { sessionId: 'a', sid: 's1', live: { q: 2 }, myAnswers: {} },
    store: {
      mergeAnswer(...args) {
        writes.push(args);
        return Promise.resolve();
      }
    },
    stRender() {},
    toast() {},
    console
  };
  vm.runInNewContext(extractFunction(html, 'stSend'), context);

  context.stSend({ txt: '서술', at: 123, ms: 456 }, { txt: '서술', ms: 456 });
  await Promise.resolve();

  assert.deepEqual(writes, [['a', 's1', 2, { txt: '서술', at: 123, ms: 456 }]]);
});

test('객관식 번호 선택은 제출하지 않고 제출 버튼과 다시 고르기만 서버 상태를 바꾼다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const writes = [];
  const context = {
    st: {
      sessionId: 'a', sid: 's1', live: { q: 0, openedAt: 1000, limitSec: 15 },
      set: { questions: [{ type: 'choice', choices: ['가', '나'], answer: 1 }] },
      myAnswers: {}, sel: null, multiSel: [], draft: '', submitted: false, revision: 0
    },
    store: { setAnswerState(...args) { writes.push(args); return Promise.resolve(); } },
    qType(q) { return q.type; }, serverNow() { return 2000; }, SV_TS: 999,
    multiCorrect() { return false; }, fmtMulti(v) { return v.join(','); }, shortCorrect() { return false; },
    stLocked() { return false; }, stRender() {}, toast() {}, console
  };
  for (const name of ['stAnswer', 'stHasDraftAnswer', 'stBuildAnswer', 'stSend', 'stSubmitCurrent', 'stReviseAnswer']) {
    vm.runInNewContext(extractFunction(html, name), context);
  }

  context.stAnswer(1);
  assert.equal(writes.length, 0);
  await context.stSubmitCurrent('button');
  assert.equal(writes[0][3].submitted, true);
  assert.equal(writes[0][3].c, 1);
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
    stBuildAnswer() { return { payload: { c: 0 }, local: { c: 0 } }; },
    stSend(payload) { sent += 1; assert.equal(payload.source, 'timer'); return Promise.resolve(); },
    toast() {}
  };
  vm.runInNewContext(extractFunction(html, 'stSubmitCurrent'), context);

  await context.stSubmitCurrent('timer');

  assert.equal(sent, 1);
});

test('익명 인증 뒤 고유 서버 시각 동기화가 끝나야 라우터를 시작한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let authListener;
  let resolveClock;
  let routed = 0;
  const clockReady = new Promise(resolve => { resolveClock = resolve; });
  const app = { innerHTML: '' };
  const context = {
    authReady: false,
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
    firebase: {
      auth() {
        return {
          onAuthStateChanged(listener) { authListener = listener; },
          signInAnonymously() { return Promise.resolve(); }
        };
      }
    },
    store: {
      async syncClock(pathValue) {
        assert.equal(pathValue, 'clock/user-a-SAMPLE12');
        await clockReady;
      }
    },
    rid(size) { assert.equal(size, 8); return 'SAMPLE12'; },
    router() { routed += 1; },
    esc(value) { return String(value); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'bootWithAuth'), context);

  context.bootWithAuth();
  const authRun = authListener({ uid: 'user-a' });
  await Promise.resolve();
  assert.equal(routed, 0);
  resolveClock();
  await authRun;
  assert.equal(routed, 1);
});

test('서버 시각 보정 실패는 한국어 오류를 표시하고 수업 라우팅을 차단한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let authListener;
  let routed = 0;
  const app = { innerHTML: '' };
  const context = {
    authReady: false,
    APP() { return app; },
    topbar() { return '<nav></nav>'; },
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

  assert.equal(routed, 0);
  assert.match(app.innerHTML, /서버 시각을 확인하지 못했습니다\. 새로고침해 주세요\./);
});

test('서술형 채점은 답안 내용을 보존하고 ok만 변경한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': { answers: { '3': { txt: '학생 글', at: 10, ms: 20 } } }
  });
  const store = createStore(fake);

  await store.gradeAnswer('a', 's1', 3, true);
  assert.deepEqual((await store.getOwnResponses('a', 's1'))['3'], {
    txt: '학생 글', at: 10, ms: 20, ok: true
  });

  await store.gradeAnswer('a', 's1', 3, null);
  const ungraded = (await store.getOwnResponses('a', 's1'))['3'];
  assert.deepEqual(ungraded, { txt: '학생 글', at: 10, ms: 20 });
  assert.equal(Object.hasOwn(ungraded, 'ok'), false);
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
        return { id, title: '첫 세트', questions: [] };
      },
      subscribeStudents(id, next) {
        calls.push(['subscribeStudents', id]); subscriptions.students = next; return () => {};
      },
      subscribeResponses(id, next) {
        calls.push(['subscribeResponses', id]); subscriptions.responses = next; return () => {};
      }
    },
    FirestoreCore: require('../firestore-core.js'),
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
  subscriptions.responses({ s1: { answers: { '2': { txt: '학생 글', ok: null } } } });

  assert.deepEqual(calls, [
    ['getSession', 'session-a'],
    ['getQuizSet', 'set1'],
    ['subscribeStudents', 'session-a'],
    ['subscribeResponses', 'session-a']
  ]);
  assert.deepEqual(context.dash.students, { s1: { name: '가' } });
  assert.deepEqual(context.dash.answers, { '2': { s1: { txt: '학생 글', ok: null } } });
});

test('대시보드 서술형 채점은 저장소에 ok만 전달한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    dash: { sessionId: 'session-a' },
    store: {
      async gradeAnswer(...args) { calls.push(args); }
    },
    alert() {},
    console
  };
  vm.runInNewContext(extractFunction(html, 'dashGrade'), context);

  await context.dashGrade(3, 'student-a', null);

  assert.deepEqual(calls, [['session-a', 'student-a', 3, null]]);
});

test('관리자 조회는 세션과 해당 학생·응답 컬렉션을 각각 한 번만 읽는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const body = { innerHTML: '' };
  const context = {
    adm: {
      sessions: {}, resp: {}, from: '2024-01-01', to: '2024-01-31',
      loading: false, detail: null
    },
    store: {
      async listSessions() {
        calls.push(['listSessions']);
        return [
          { id: 'in', createdAt: new Date('2024-01-15T00:00:00').getTime(), setId: 'set1' },
          { id: 'out', createdAt: new Date('2024-02-15T00:00:00').getTime(), setId: 'set2' }
        ];
      },
      async getCollection(collectionPath) {
        calls.push(['getCollection', collectionPath]);
        if (collectionPath.endsWith('/students')) return { s1: { name: '가' } };
        return { s1: { answers: { '0': { c: 1, ok: true } } } };
      }
    },
    FirestoreCore: require('../firestore-core.js'),
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
    ['getCollection', 'sessions/in/students'],
    ['getCollection', 'sessions/in/responses']
  ]);
  assert.deepEqual(context.adm.sessions.in.students, { s1: { name: '가' } });
  assert.deepEqual(context.adm.resp.in, { '0': { s1: { c: 1, ok: true } } });
  assert.equal(context.adm.loading, false);
});

test('관리자 로그인과 비밀번호 변경은 config/app의 adminHash를 사용한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const fields = {
    '#adm-pw': { value: 'old-password' },
    '#adm-newpw': { value: 'new-password' },
    '#adm-newpw2': { value: 'new-password' }
  };
  const context = {
    store: {
      async getDoc(documentPath) {
        calls.push(['getDoc', documentPath]);
        return { adminHash: 'hash:old-password' };
      },
      async mergeDoc(documentPath, value) {
        calls.push(['mergeDoc', documentPath, value]);
      }
    },
    $(selector) { return fields[selector]; },
    async sha256(value) { return 'hash:' + value; },
    DEFAULT_ADMIN_HASH: 'default',
    ssSet(key, value) { calls.push(['ssSet', key, value]); },
    admRenderShell() { calls.push(['render']); },
    admRenderLogin(message) { throw new Error(message); },
    toast(message) { calls.push(['toast', message]); },
    alert(message) { throw new Error(message); },
    console
  };
  vm.runInNewContext(extractFunction(html, 'admLogin'), context);
  vm.runInNewContext(extractFunction(html, 'admChangePw'), context);

  await context.admLogin();
  await context.admChangePw();

  assert.deepEqual(clone(calls), [
    ['getDoc', 'config/app'],
    ['ssSet', 'vq_admin', '1'],
    ['render'],
    ['mergeDoc', 'config/app', { adminHash: 'hash:new-password' }],
    ['toast', '비밀번호를 변경했습니다']
  ]);
});

test('관리자 기간 삭제는 화면에서 경로를 만들지 않고 저장소 API에 세션 ID를 맡긴다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    adm: { from: '2024-01-01', to: '2024-01-31' },
    admCompute() { return { sessions: [{ id: 'a' }, { id: 'b' }] }; },
    prompt() { return '삭제'; },
    store: {
      async purgeSessions(ids) { calls.push(['purgeSessions', ids]); }
    },
    toast(message) { calls.push(['toast', message]); },
    admLoad() { calls.push(['load']); },
    alert(message) { throw new Error(message); }
  };
  vm.runInNewContext(extractFunction(html, 'admPurge'), context);

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
      set: { title: '세트', questions: [{ type: 'long', text: '설명' }] },
      sort: { key: 'no', dir: 1 }
    },
    dashBuildRows() {
      return [{
        grade: 1, klass: 2, num: 3, name: '가',
        cells: [{ txt: '학생 글', ok: null, ms: 1200 }],
        correct: 0, graded: 0, ungraded: 1, answered: 1, rate: 0, avgMs: 1200
      }];
    },
    dashSortRows(rows) { return rows; },
    qType() { return 'long'; },
    QTYPES: { long: '서술형 — 직접 채점' },
    answerLabel(question, answer) { return answer.txt; },
    fmtDate() { return '날짜'; },
    fmtDay() { return '날짜'; },
    downloadCSV(name, rows) { downloaded = { name, rows }; },
    toast() {}
  };
  vm.runInNewContext(extractFunction(html, 'dashExportCSV'), context);

  context.dashExportCSV();

  assert.equal(downloaded.rows[6][4], '학생 글');
  assert.equal(downloaded.rows[6][5], '미채점');
});
