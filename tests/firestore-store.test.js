const test = require('node:test');
const assert = require('node:assert/strict');
const GuestQuizShareCore = require('../guest-quiz-share-core.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../firestore-core.js');

test('operator can load an admin allowance without entering teacher-only deletion flow', async () => {
  const fake = makeFirestoreFake({
    'teacher_allowances/operator-uid': {
      uid: 'operator-uid', emailCanonical: 'operator@example.com',
      role: 'admin', status: 'active', enabled: true
    }
  });
  const store = createStore(fake);

  const allowance = await store.getOwnTeacherAllowance('operator-uid');

  assert.equal(allowance.role, 'admin');
  assert.equal(allowance.emailCanonical, 'operator@example.com');
});

test('browser script order exposes class planning thresholds before firestore store captures the core', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+\.js(?:\?[^"]*)?)"/g)]
    .map(match => match[1].split('?')[0]);
  assert.ok(scripts.indexOf('class-planning-core.js') < scripts.indexOf('firestore-store.js'));
  const context = {
    console, TextEncoder, Date, Math,
    FirestoreCore: { timestampMillis() { return null; }, offsetFromRoundTrip() {}, claimFirstAvailableCode() {}, chunk() {} },
    CollaborationTrashCore: {}, TeacherAccessRequestCore: {},
    firebase: { firestore: { Timestamp: class Timestamp {} } }
  };
  context.globalThis = context;
  for (const name of scripts.filter(name => ['class-planning-core.js', 'firestore-store.js'].includes(name))) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  }
  const store = context.FirestoreStore.createFirestoreStore(
    { doc() { return { async get() { return { exists: false }; } }; } }, {}, () => 0
  );
  assert.deepEqual({ ...(await store.getClassPlanningThresholds()) }, { caution: 60, crowded: 120 });
});

const SERVER_TIMESTAMP = Symbol('server timestamp');
const DELETE_FIELD = Symbol('delete field');

class Timestamp {
  constructor(milliseconds) {
    this.seconds = Math.floor(milliseconds / 1000);
    this.nanoseconds = Math.trunc((milliseconds - this.seconds * 1000) * 1_000_000);
  }

  toMillis() {
    return this.seconds * 1000 + this.nanoseconds / 1_000_000;
  }

  toDate() {
    return new Date(this.toMillis());
  }
}

function clone(value) {
  if (value === undefined) return undefined;
  if (value === SERVER_TIMESTAMP) return value;
  if (value === DELETE_FIELD) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value && value.constructor && value.constructor.name === 'Timestamp' &&
      typeof value.toMillis === 'function' && typeof value.toDate === 'function') return value;
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
      return new Timestamp(committedServerMillis);
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (value && value.constructor && value.constructor.name === 'Timestamp' &&
        typeof value.toMillis === 'function' && typeof value.toDate === 'function') return value;
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

  function queryComparable(value) {
    if (value instanceof Date) return value.getTime();
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    return value;
  }

  function querySnapshot(path, source = documents, filters = [], collectionGroup = false) {
    const limit = filters.find(filter => filter.type === 'limit');
    const order = filters.find(filter => filter.type === 'orderBy');
    const startAfter = filters.find(filter => filter.type === 'startAfter');
    const matches = (left, operator, right) => {
      const a = queryComparable(left);
      const b = queryComparable(right);
      if (operator === '==') return a === b;
      if (operator === 'in') return Array.isArray(right) && right.includes(a);
      if (operator === '>=') return a >= b;
      if (operator === '>') return a > b;
      if (operator === '<=') return a <= b;
      if (operator === '<') return a < b;
      return false;
    };
    const sourceDocs = collectionGroup
      ? [...source.keys()].filter(key => {
          const segments = key.split('/');
          return segments.length >= 2 && segments.at(-2) === path;
        }).sort().map(key => docSnapshot(key, source))
      : collectionDocs(path, source);
    const docs = sourceDocs.filter(document =>
      filters.every(filter => ['limit', 'orderBy'].includes(filter.type) ||
        filter.type === 'startAfter' ||
        matches(document.get(filter.field), filter.operator, filter.value))
    ).sort((left, right) => {
      if (!order) return 0;
      const compared = queryComparable(left.get(order.field)) - queryComparable(right.get(order.field));
      return order.direction === 'desc' ? -compared : compared;
    }).filter(document => {
      if (!startAfter || !order) return true;
      const cursorDocument = startAfter.values[0];
      const isDocumentCursor = cursorDocument &&
        typeof cursorDocument.get === 'function' && typeof cursorDocument.id === 'string';
      const current = queryComparable(document.get(order.field));
      const cursor = queryComparable(isDocumentCursor
        ? cursorDocument.get(order.field) : cursorDocument);
      if (current === cursor && isDocumentCursor) return document.id > cursorDocument.id;
      return order.direction === 'desc' ? current < cursor : current > cursor;
    }).slice(0, limit ? limit.value : undefined);
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

  function collectionRef(path, filters = [], collectionGroup = false) {
    return {
      id: path.split('/').at(-1),
      path,
      async get(optionsArg) {
        calls.push({ operation: 'getCollection', path, filters: clone(filters), options: clone(optionsArg) });
        return querySnapshot(path, documents, filters, collectionGroup);
      },
      where(field, operator, value) {
        calls.push({ operation: 'where', path, field, operator, value: clone(value) });
        return collectionRef(path, filters.concat({ field, operator, value }), collectionGroup);
      },
      limit(value) {
        return collectionRef(path, filters.concat({ type: 'limit', value }), collectionGroup);
      },
      orderBy(field, direction) {
        calls.push({ operation: 'orderBy', path, field, direction: direction || 'asc' });
        return collectionRef(path, filters.concat({ type: 'orderBy', field, direction: direction || 'asc' }), collectionGroup);
      },
      startAfter(...values) {
        calls.push({ operation: 'startAfter', path, values: clone(values) });
        return collectionRef(path, filters.concat({ type: 'startAfter', values }), collectionGroup);
      },
      onSnapshot(next, error) {
        return addListener(collectionListeners, path, next, error, querySnapshot);
      }
    };
  }

  const db = {
    doc: docRef,
    collection: collectionRef,
    collectionGroup(path) {
      calls.push({ operation: 'collectionGroup', path });
      return collectionRef(path, [], true);
    },
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
      if (options.beforeTransactionStart) {
        await options.beforeTransactionStart({
          attempt: transactionCommitCount + 1,
          set(path, value) { documents.set(path, clone(value)); },
          delete(path) { documents.delete(path); }
        });
      }
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
      if (options.failTransactionAfterCommitAt === transactionCommitCount) {
        throw new Error(options.failTransactionAfterCommitMessage ||
          'planned ambiguous transaction failure ' + transactionCommitCount);
      }
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
  if (!Object.hasOwn(context, 'PublicAuthorLabelCore')) {
    context.PublicAuthorLabelCore = require('../public-author-label-core.js');
  }
  names.forEach(name => vm.runInNewContext(extractFunction(html, name), context));
  return context;
}

test('편집기 문항 이동은 PlaylistCore를 한 번 호출해 영상 사이 이동과 이미지 키를 함께 반영한다', () => {
  let calls = 0;
  const base = require('../playlist-core.js');
  const context = {
    mk: {
      activeVideo: 0,
      videos: [
        { startSec: 0, endSec: 100, questions: [
          { text: '첫 문항', t: 50, imgUp: true, _img: 'data:image/a' }
        ] },
        { startSec: 100, endSec: 300, questions: [
          { text: '둘째 문항', t: 150 }
        ] }
      ]
    },
    PlaylistCore: {
      moveQuestion(...args) { calls += 1; return base.moveQuestion(...args); }
    },
    mkMarkDirty() {},
    renderMake() {}
  };
  loadStageFunctions(['mkQuestionImageMap', 'mkMoveQuestion'], context);

  assert.equal(context.mkMoveQuestion(0, 0, 1, 1), true);
  assert.equal(calls, 1);
  assert.equal(context.mk.videos[0].questions.length, 0);
  assert.equal(context.mk.videos[1].questions[1].text, '첫 문항');
  assert.equal(context.mk.videos[1].questions[1].t, 200);
  assert.equal(context.mk.videos[1].questions[1]._img, 'data:image/a');
});

test('문항 drop은 영상 끝과 빈 영상에 삽입하고 no-op은 history를 만들지 않는다', () => {
  let dirty = 0;
  const context = {
    mk: {
      activeVideo: 0,
      videos: [
        { startSec: 0, endSec: 100, questions: [{ text: 'A', t: 10 }, { text: 'B', t: 20 }] },
        { startSec: 100, endSec: 200, questions: [{ text: 'C', t: 110 }] },
        { startSec: 200, endSec: 300, questions: [] }
      ]
    },
    PlaylistCore: require('../playlist-core.js'),
    mkMarkDirty() { dirty += 1; }, renderMake() {}
  };
  loadStageFunctions(['mkQuestionImageMap', 'mkMoveQuestion', 'mkQuestionDrop'], context);
  const drop = (from, toVideo, toIndex) => context.mkQuestionDrop({
    preventDefault() {}, currentTarget: { classList: { remove() {} } },
    dataTransfer: { getData() { return JSON.stringify(from); } }
  }, toVideo, toIndex);

  assert.equal(drop({ videoIndex: 0, questionIndex: 0 }, 1, 1), true);
  assert.deepEqual(context.mk.videos[1].questions.map(q => q.text), ['C', 'A']);
  assert.equal(dirty, 1);

  assert.equal(drop({ videoIndex: 1, questionIndex: 1 }, 1, 2), false);
  assert.equal(dirty, 1);

  assert.equal(drop({ videoIndex: 1, questionIndex: 1 }, 2, 0), true);
  assert.deepEqual(context.mk.videos[2].questions.map(q => q.text), ['A']);
  assert.equal(dirty, 2);
});

test('늦게 끝난 이전 저장은 새 편집과 최신 저장 결과를 덮어쓰지 않는다', async () => {
  const pending = [];
  const context = {
    mk: {
      id: 'set-1', ownerUid: 'teacher-1', editRevision: 0, saveSequence: 0,
      title: '세트', author: '', settings: {}, createdAt: 1, activeVideo: 0, saved: false,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: '첫 값', choices: [] }] }]
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), SV_TS: {}, rid() { return 'new-id'; },
    mkValidate() { return ''; },
    mkPayload() {
      return { set: {
        title: context.mk.title, author: '', settings: {}, createdAt: 1,
        videos: clone(context.mk.videos)
      }, images: {} };
    },
    store: { saveOwnedQuizSet() { return new Promise(resolve => pending.push(resolve)); } },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    mkResetHistory() {}, mkShowSaveToast() {}, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console, alert() {}, Date
  };
  loadStageFunctions(['mkSave'], context);

  const first = context.mkSave(false);
  context.mk.videos[0].questions[0].text = '두 번째 값';
  context.mk.editRevision += 1;
  const second = context.mkSave(false);
  pending[0]();
  await new Promise(resolve => setImmediate(resolve));
  pending[1]();
  await second;
  await first;

  assert.equal(context.mk.videos[0].questions[0].text, '두 번째 값');
  assert.equal(context.mk.saved, true);
  assert.equal(context.mk.persistedSnapshot.videos[0].questions[0].text, '두 번째 값');
  assert.equal(context.mk.persistedSaveSequence, 2);
});

test('늦은 A 권한 확인 뒤 B 저장이 와도 Firestore 마지막 write는 최신 B payload다', async () => {
  const checks = [];
  const writes = [];
  const context = {
    mk: {
      id: 'set-1', ownerUid: 'teacher-1', editRevision: 0, saveSequence: 0,
      title: '세트', author: '', settings: {}, createdAt: 1, activeVideo: 0, saved: false,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: 'A', choices: [] }] }]
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), SV_TS: {}, rid() { return 'new-id'; },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '세트', videos: clone(context.mk.videos) }, images: {} }; },
    store: {
      canEditQuizSet() { return new Promise(resolve => checks.push(resolve)); },
      saveQuizSetWithImages(id, value) { writes.push(clone(value)); return Promise.resolve(); }
    },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    mkResetHistory() {}, mkShowSaveToast() {}, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console, alert() {}, Date
  };
  loadStageFunctions(['mkSave'], context);

  const saveA = context.mkSave(false);
  await new Promise(resolve => setImmediate(resolve));
  context.mk.videos[0].questions[0].text = 'B';
  context.mk.editRevision += 1;
  const saveB = context.mkSave(false);
  checks[0](true);
  await new Promise(resolve => setImmediate(resolve));
  checks[1](true);
  await Promise.all([saveA, saveB]);

  assert.deepEqual(writes.map(value => value.videos[0].questions[0].text), ['B']);
});

test('실패한 저장 뒤에 대기 중인 후속 저장은 같은 편집기 큐에서 계속 실행된다', async () => {
  const writes = [];
  let rejectA;
  const context = {
    mk: {
      id: 'set-1', ownerUid: 'teacher-1', editRevision: 0, saveSequence: 0,
      title: '세트', author: '', settings: {}, createdAt: 1, activeVideo: 0, saved: false,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: 'A', choices: [] }] }]
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), SV_TS: {}, rid() { return 'new-id'; },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '세트', videos: clone(context.mk.videos) }, images: {} }; },
    store: {
      saveOwnedQuizSet(id, value) {
        writes.push(clone(value));
        return writes.length === 1
          ? new Promise((resolve, reject) => { rejectA = reject; })
          : Promise.resolve();
      }
    },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    mkResetHistory() {}, mkShowSaveToast() {}, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console: { error() {} }, alert() {}, Date
  };
  loadStageFunctions(['mkSave'], context);

  const saveA = context.mkSave(false);
  await new Promise(resolve => setImmediate(resolve));
  context.mk.videos[0].questions[0].text = 'B';
  context.mk.editRevision += 1;
  const saveB = context.mkSave(false);
  rejectA(new Error('offline'));
  await Promise.all([saveA, saveB]);

  assert.deepEqual(writes.map(value => value.videos[0].questions[0].text), ['A', 'B']);
});

test('대기 중인 저장은 route 또는 교사 인증이 stale이면 Firestore write 전에 중단한다', async () => {
  let resolveCheck;
  let writes = 0;
  const context = {
    mk: {
      id: 'set-1', ownerUid: 'teacher-1', routeToken: '#/make/set-1', editRevision: 0, saveSequence: 0,
      title: '세트', author: '', settings: {}, createdAt: 1, activeVideo: 0, saved: false,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: 'A', choices: [] }] }]
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), SV_TS: {}, rid() { return 'new-id'; },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '세트', videos: clone(context.mk.videos) }, images: {} }; },
    store: {
      canEditQuizSet() { return new Promise(resolve => { resolveCheck = resolve; }); },
      saveQuizSetWithImages() { writes += 1; return Promise.resolve(); }
    },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    mkResetHistory() {}, mkShowSaveToast() {}, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console, alert() {}, Date
  };
  loadStageFunctions(['mkSave'], context);

  const saving = context.mkSave(false);
  await new Promise(resolve => setImmediate(resolve));
  context.location.hash = '#/sets';
  resolveCheck(true);
  await saving;

  assert.equal(writes, 0);
});

test('대기 중인 저장은 교사 인증이 stale이면 Firestore write 전에 중단한다', async () => {
  let resolveCheck;
  let writes = 0;
  const context = {
    mk: {
      id: 'set-1', ownerUid: 'teacher-1', routeToken: '#/make/set-1', editRevision: 0, saveSequence: 0,
      title: '세트', author: '', settings: {}, createdAt: 1, activeVideo: 0, saved: false,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: 'A', choices: [] }] }]
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), SV_TS: {}, rid() { return 'new-id'; },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: '세트', videos: clone(context.mk.videos) }, images: {} }; },
    store: {
      canEditQuizSet() { return new Promise(resolve => { resolveCheck = resolve; }); },
      saveQuizSetWithImages() { writes += 1; return Promise.resolve(); }
    },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    mkResetHistory() {}, mkShowSaveToast() {}, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console, alert() {}, Date
  };
  loadStageFunctions(['mkSave'], context);

  const saving = context.mkSave(false);
  await new Promise(resolve => setImmediate(resolve));
  context.teacherState.role = 'student';
  resolveCheck(true);
  await saving;

  assert.equal(writes, 0);
});

test('대기열의 최신 저장이 실행 직전 무효가 되면 dirty 초안을 남기고 다음 유효 저장을 허용한다', async () => {
  const writes = [];
  const drafts = [];
  const toasts = [];
  const historyResets = [];
  let resolveA;
  const context = {
    mk: {
      id: 'set-1', ownerUid: 'teacher-1', editRevision: 0, saveSequence: 0,
      title: '세트', author: '', settings: {}, createdAt: 1, activeVideo: 0, saved: false,
      videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
        questions: [{ type: 'long', t: 10, text: 'A', choices: [] }] }]
    },
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), SV_TS: {}, rid() { return 'new-id'; },
    mkValidate() { return context.mk.videos[0].questions[0].text ? '' : '문항 내용을 입력해 주세요.'; },
    mkPayload() { return { set: { title: '세트', videos: clone(context.mk.videos) }, images: {} }; },
    store: {
      saveOwnedQuizSet(id, value) {
        writes.push(clone(value));
        return writes.length === 1 ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve();
      }
    },
    toast(message) { toasts.push(message); }, mkSetSaveStatus() {}, mkClearDraft() {},
    mkPersistDraft() { drafts.push('draft'); },
    mkResetHistory() { historyResets.push('reset'); }, mkShowSaveToast() { toasts.push('저장 완료'); }, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console: { error() {} }, alert() {}, Date
  };
  loadStageFunctions(['mkSave'], context);

  const saveA = context.mkSave(false);
  await new Promise(resolve => setImmediate(resolve));
  context.mk.videos[0].questions[0].text = 'B';
  context.mk.editRevision += 1;
  const saveB = context.mkSave(false);
  context.mk.videos[0].questions[0].text = '';
  context.mk.editRevision += 1;
  resolveA();
  await Promise.all([saveA, saveB]);

  assert.deepEqual(writes.map(value => value.videos[0].questions[0].text), ['A']);
  assert.equal(context.mk.saved, false);
  assert.ok(drafts.length >= 1);
  assert.equal(historyResets.length, 0);
  assert.equal(toasts.includes('저장 완료'), false);

  context.mk.videos[0].questions[0].text = 'C';
  context.mk.editRevision += 1;
  await context.mkSave(false);

  assert.deepEqual(writes.map(value => value.videos[0].questions[0].text), ['A', 'C']);
  assert.equal(context.mk.saved, true);
  assert.equal(historyResets.length, 1);
});

test('B 저장 중 undo A는 local history를 보존하고 성공한 server baseline만 B로 갱신한다', async () => {
  const writes = [];
  let resolveA;
  let historyResets = 0;
  const snapshot = text => ({
    title: text, author: '', settings: {}, activeVideo: 0,
    videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
      questions: [{ type: 'long', t: 10, text, choices: [] }] }]
  });
  const context = {
    mk: Object.assign({
      id: 'set-1', ownerUid: 'teacher-1', editRevision: 1, saveSequence: 0,
      createdAt: 1, saved: true, persistedSnapshot: snapshot('서버 A')
    }, snapshot('편집 B')),
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    SV_TS: {}, rid() { return 'new-id'; }, normSettings(value) { return value || {}; },
    mkValidate() { return ''; },
    mkPayload() { return { set: { title: context.mk.title, videos: clone(context.mk.videos) }, images: {} }; },
    store: {
      saveOwnedQuizSet(id, value) {
        writes.push(clone(value));
        return writes.length === 1 ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve();
      }
    },
    toast() {}, mkSetSaveStatus() {}, mkClearDraft() {}, mkPersistDraft() {},
    mkResetHistory() { historyResets += 1; }, mkShowSaveToast() {}, mkUpdateHistoryControls() {},
    normQuestions(value) { return clone(value); }, imgCache: {},
    location: { hash: '#/make/set-1' }, history: { replaceState() {} },
    renderMake() {}, console: { error() {} }, alert() {}, Date
  };
  context.mk.history = {
    canUndo() { return true; }, undo() { return snapshot('서버 A'); },
    canRedo() { return true; }, redo() { return snapshot('편집 B'); }
  };
  loadStageFunctions(['mkHistorySnapshot', 'mkSnapshotsEqual', 'mkRestoreHistory', 'mkUndo', 'mkRedo', 'mkSave'], context);

  const saveB = context.mkSave(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.mkUndo(), true);
  assert.equal(context.mk.editRevision, 2);
  resolveA();
  await saveB;

  assert.deepEqual(writes.map(value => value.title), ['편집 B']);
  assert.equal(context.mk.title, '서버 A');
  assert.equal(context.mk.saved, false);
  assert.equal(historyResets, 0);
  assert.equal(context.mk.persistedSnapshot.title, '편집 B');

  assert.equal(context.mkRedo(), true);
  assert.equal(context.mk.title, '편집 B');
  assert.equal(context.mk.saved, true);
  assert.equal(context.mkUndo(), true);
  assert.equal(context.mk.title, '서버 A');
  assert.equal(context.mk.saved, false);
});

test('undo 복원은 이미지까지 포함한 저장 기준 snapshot과 같을 때만 저장됨 상태가 된다', () => {
  const persisted = {
    title: '세트', author: '', settings: {},
    videos: [{ videoUrl: '', videoId: '', questions: [{ text: '문항', imgUp: true, _img: 'data:image/original' }] }],
    activeVideo: 0
  };
  const context = {
    mk: {
      title: '세트', author: '', settings: {}, activeVideo: 0, saved: false,
      persistedSnapshot: clone(persisted), videos: clone(persisted.videos)
    },
    PlaylistCore: require('../playlist-core.js'), normSettings(value) { return value || {}; },
    mkSetSaveStatus() {}, mkPersistDraft() {}, renderMake() {}
  };
  loadStageFunctions(['mkHistorySnapshot', 'mkSnapshotsEqual', 'mkRestoreHistory'], context);
  context.mk.persistedSnapshot = context.mkHistorySnapshot(context.mk);

  context.mkRestoreHistory(clone(persisted));
  assert.equal(context.mk.saved, true);
  const changedImage = clone(persisted);
  changedImage.videos[0].questions[0]._img = 'data:image/changed';
  context.mkRestoreHistory(changedImage);
  assert.equal(context.mk.saved, false);
});

test('문항 타임라인 pointer drag는 시작 시 한 번만 이력 경계를 만들고 cancel은 값 변경을 확정하지 않는다', () => {
  const listeners = {};
  let snapshots = 0;
  let historyMutations = 0;
  const context = {
    mk: { videos: [{ startSec: 0, endSec: 100, questions: [{ t: 10 }] }] },
    document: {
      addEventListener(name, fn) { listeners[name] = fn; },
      removeEventListener(name) { delete listeners[name]; }
    },
    mkTimelineDomain() { return { start: 0, end: 100 }; },
    mkHistorySnapshot() { snapshots += 1; return {}; },
    mkSetQuestionTime() {},
    mkMarkDirty() { historyMutations += 1; }
  };
  loadStageFunctions(['mkStartQuestionDrag'], context);
  const timeline = { getBoundingClientRect() { return { left: 0, width: 100 }; } };
  const event = { currentTarget: { parentElement: timeline }, preventDefault() {} };

  context.mkStartQuestionDrag(event, 0, 0);
  listeners.pointermove({ clientX: 50 });
  listeners.pointermove({ clientX: 70 });
  listeners.pointercancel();

  assert.equal(snapshots, 1);
  assert.equal(historyMutations, 0);
});

test('browser Firestore store exposes no legacy owner probe or migration write API', () => {
  const store = loadStoreModule().createFirestoreStore({}, { serverTimestamp() {} }, Date.now);

  assert.equal(Object.prototype.hasOwnProperty.call(store, 'probeLegacyOwner'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'migrateLegacyOwnership'), false);
});

test('teacher request browser API resolves the access core loaded after firestore-store', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'firestore-store.js'), 'utf8');
  const context = {
    FirestoreCore: require('../firestore-core.js'),
    CollaborationTrashCore: require('../collaboration-trash-core.js'),
    TextEncoder
  };
  vm.runInNewContext(source, context);
  context.TeacherAccessRequestCore = require('../teacher-access-request-core.js');
  const fake = makeFirestoreFake();
  const store = context.FirestoreStore.createFirestoreStore(
    fake.db, fake.fieldValue, () => 1_000
  );

  await store.submitTeacherRequest(teacherRequestInput());

  assert.equal(fake.value('teacher_access_requests/teacher-a').status, 'pending');
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

function createStore(fake, nowFn) {
  const { createFirestoreStore } = loadStoreModule();
  return createFirestoreStore(fake.db, fake.fieldValue, nowFn || (() => 1000));
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

test('해설 이미지는 공개 문항이 아니라 정답 공개 데이터에만 안전하게 포함된다', () => {
  const { publicQuestion, publicAnswer } = loadStoreModule();
  const question = { type: 'choice', text: 'Q', choices: ['A', 'B'], answer: 0, explain: '해설' };

  assert.equal('explainImage' in publicQuestion(question, 1, 1, 'https://example.com/question.png'), false);
  assert.deepEqual(publicAnswer(question, 'data:image/png;base64,AA=='), {
    answer: 0,
    explain: '해설',
    explainImage: 'data:image/png;base64,AA=='
  });
  assert.throws(() => publicAnswer(question, 'javascript:alert(1)'), /해설 이미지/);
  assert.throws(() => publicAnswer(question, 'data:image/png;base64,' + 'A'.repeat(380101)), /해설 이미지/);
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
  const fake = makeFirestoreFake({
    'sessions/session-a': {
      status: 'live', registeredStudentCount: 0, studentCountRevision: 0
    }
  });
  const store = createStore(fake);

  const student = await store.joinStudent('session-a', 'anonymous-uid', {
    grade: 3, klass: 2, num: 7, name: '홍길동'
  });

  assert.deepEqual(fake.calls().filter(call =>
    ['transactionGet', 'transactionSet', 'transactionUpdate'].includes(call.operation)
  ).map(call => [
    call.operation, call.path
  ]), [
    ['transactionGet', 'sessions/session-a'],
    ['transactionGet', 'sessions/session-a/students/anonymous-uid'],
    ['transactionSet', 'sessions/session-a/students/anonymous-uid'],
    ['transactionUpdate', 'sessions/session-a']
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

test('수업 혼잡 임계값은 서버 설정을 검증하고 문서가 없을 때 한 곳의 기본값을 쓴다', async () => {
  const values = new Map([
    ['config/class_planning', { caution: 75, crowded: 150 }]
  ]);
  const writes = [];
  const db = {
    doc(path) {
      return {
        async get() {
          return { exists: values.has(path), data: () => values.get(path) };
        },
        async set(value) { writes.push([path, value]); }
      };
    }
  };
  const serverValue = Symbol('server-time');
  const store = loadStoreModule().createFirestoreStore(db, {
    serverTimestamp() { return serverValue; }
  }, () => 0);
  assert.deepEqual(await store.getClassPlanningThresholds(), { caution: 75, crowded: 150 });
  values.delete('config/class_planning');
  assert.deepEqual(await store.getClassPlanningThresholds(), { caution: 60, crowded: 120 });
  await store.updateClassPlanningThresholds({ caution: 80, crowded: 160 }, { uid: 'admin-a' });
  assert.deepEqual(writes, [['config/class_planning', {
    caution: 80, crowded: 160, updatedAt: serverValue, updatedByUid: 'admin-a'
  }]]);
  await assert.rejects(store.updateClassPlanningThresholds(
    { caution: 200, crowded: 100 }, { uid: 'admin-a' }
  ));
});

function pendingTeacherRequest(patch = {}) {
  const storedAt = { toMillis: () => 1_000 };
  return {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    organization: '1학년',
    note: '보건 수업',
    status: 'pending',
    revision: 3,
    createdAt: storedAt,
    updatedAt: storedAt,
    ...patch
  };
}

function teacherRequestInput(patch = {}) {
  return {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    organization: '1학년',
    note: '보건 수업',
    status: 'pending',
    revision: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...patch
  };
}

const teacherRequestAdmin = {
  uid: 'admin-uid', email: 'ADMIN@School.KR', role: 'admin'
};

function classPlanPair(patch = {}) {
  const privatePlan = {
    planId: 'plan-a',
    ownerUid: 'teacher-a',
    ownerEmailCanonical: 'teacher@school.kr',
    ownerDisplayName: '김교사',
    setId: 'set-a',
    setTitleSnapshot: '안전 수업',
    className: '2학년 1반',
    plannedStartAt: 10_000,
    plannedEndAt: 20_000,
    expectedStudents: 30,
    status: 'planned',
    revision: 1,
    warningLevel: 'caution',
    warningAcknowledgedAt: 9_000,
    createdAtMs: 8_000,
    updatedAtMs: 8_000,
    ...patch
  };
  const publicPlan = {
    planId: privatePlan.planId,
    setId: privatePlan.setId,
    setTitleSnapshot: privatePlan.setTitleSnapshot,
    className: privatePlan.className,
    plannedStartAt: privatePlan.plannedStartAt,
    plannedEndAt: privatePlan.plannedEndAt,
    expectedStudents: privatePlan.expectedStudents,
    status: privatePlan.status,
    revision: privatePlan.revision,
    warningLevel: privatePlan.warningLevel,
    warningAcknowledgedAt: privatePlan.warningAcknowledgedAt
  };
  for (const key of [
    'sessionId', 'actualStartedAtMs', 'actualEndedAtMs', 'actualParticipants'
  ]) {
    if (privatePlan[key] !== undefined) publicPlan[key] = privatePlan[key];
  }
  return { privatePlan, publicPlan };
}

function activeTeacherAllowance(patch = {}) {
  return {
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: '김교사',
    status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
    ...patch
  };
}

function storedClassPlanPair(patch = {}) {
  const { privatePlan, publicPlan } = classPlanPair(patch);
  const storedPrivate = {
    ...privatePlan,
    plannedStartAt: new Date(privatePlan.plannedStartAt),
    plannedEndAt: new Date(privatePlan.plannedEndAt),
    warningAcknowledgedAt: new Date(privatePlan.warningAcknowledgedAt),
    createdAt: { toMillis: () => privatePlan.createdAtMs },
    updatedAt: { toMillis: () => privatePlan.updatedAtMs }
  };
  delete storedPrivate.createdAtMs;
  delete storedPrivate.updatedAtMs;
  const storedPublic = {
    ...publicPlan,
    plannedStartAt: new Date(publicPlan.plannedStartAt),
    plannedEndAt: new Date(publicPlan.plannedEndAt),
    warningAcknowledgedAt: new Date(publicPlan.warningAcknowledgedAt),
    createdAt: { toMillis: () => privatePlan.createdAtMs },
    updatedAt: { toMillis: () => privatePlan.updatedAtMs }
  };
  return { storedPrivate, storedPublic };
}

test('12:00:45 serverNow에서 12:00 기본 계획의 24시간 겹침 조회를 허용한다', async () => {
  const now = Date.UTC(2026, 7, 20, 12, 0, 45);
  const start = Date.UTC(2026, 7, 19, 12, 0, 0);
  const end = Date.UTC(2026, 7, 20, 13, 0, 0);
  const fake = makeFirestoreFake();

  assert.deepEqual(await createStore(fake, () => now).listPublicPlans(start, end, 100), {});
});

test('class plan query horizon은 UI 5분 past·1분 절삭·2분 jitter를 넘으면 거부한다', async () => {
  const now = Date.UTC(2026, 7, 20, 12, 0, 0);
  const store = createStore(makeFirestoreFake(), () => now);
  const horizon = (24 * 60 + 8) * 60_000;

  await assert.doesNotReject(store.listPublicPlans(now - horizon, now + 60_000, 100));
  await assert.rejects(
    store.listPublicPlans(now - horizon - 1, now + 60_000, 100),
    /과거 horizon/
  );
  await assert.rejects(
    store.listPublicPlans(now + 24 * 60 * 60_000, now + 32 * 24 * 60 * 60_000, 100),
    /미래 horizon/
  );
});

test('class plan create atomically writes one exact private/public projection pair', async () => {
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance()
  }, { committedServerMillis: 8_500 });
  const store = createStore(fake);
  const pair = classPlanPair();

  const created = await store.createClassPlan(pair.privatePlan, pair.publicPlan);

  assert.equal(created.planId, 'plan-a');
  assert.equal(created.revision, 1);
  const privateStored = fake.value('class_plans_private/plan-a');
  const publicStored = fake.value('class_plans_public/plan-a');
  assert.equal(privateStored.ownerUid, 'teacher-a');
  assert.equal(publicStored.ownerUid, undefined);
  assert.equal(publicStored.ownerEmailCanonical, undefined);
  assert.equal(publicStored.ownerDisplayName, undefined);
  for (const key of [
    'planId', 'revision', 'setId', 'setTitleSnapshot', 'className',
    'expectedStudents', 'status', 'warningLevel'
  ]) assert.equal(publicStored[key], privateStored[key], key);
  assert.equal(publicStored.plannedStartAt.getTime(), privateStored.plannedStartAt.getTime());
  assert.equal(publicStored.plannedEndAt.getTime(), privateStored.plannedEndAt.getTime());
  assert.deepEqual(Object.keys(publicStored).sort(), [
    'className', 'createdAt', 'expectedStudents', 'planId', 'plannedEndAt',
    'plannedStartAt', 'revision', 'setId', 'setTitleSnapshot', 'status',
    'updatedAt', 'warningAcknowledgedAt', 'warningLevel'
  ]);
});

test('class plan create rollback leaves neither side when the atomic commit fails', async () => {
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance()
  }, { failTransactionAt: 1, failTransactionMessage: 'planned paired write failure' });
  const store = createStore(fake);
  const pair = classPlanPair();

  await assert.rejects(store.createClassPlan(pair.privatePlan, pair.publicPlan), /paired write failure/);

  assert.equal(fake.has('class_plans_private/plan-a'), false);
  assert.equal(fake.has('class_plans_public/plan-a'), false);
});

test('class plan create ambiguous commit retry accepts only the exact existing revision-1 pair', async () => {
  const pair = storedClassPlanPair();
  const exactFake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic
  });
  const retried = await createStore(exactFake).createClassPlan(
    classPlanPair().privatePlan, classPlanPair().publicPlan
  );
  assert.equal(retried.planId, 'plan-a');
  assert.equal(retried.revision, 1);
  assert.equal(exactFake.calls().filter(call =>
    ['transactionSet', 'transactionUpdate'].includes(call.operation)
  ).length, 0);

  const mismatchPair = storedClassPlanPair({ className: '다른 반' });
  const mismatchFake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': mismatchPair.storedPrivate,
    'class_plans_public/plan-a': mismatchPair.storedPublic
  });
  await assert.rejects(createStore(mismatchFake).createClassPlan(
    classPlanPair().privatePlan, classPlanPair().publicPlan
  ), /이미 존재|exact|일치|손상/);
});

test('class plan update and cancellation use exact revision CAS and keep both projections equal', async () => {
  const pair = storedClassPlanPair();
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic
  });
  const store = createStore(fake);

  await assert.rejects(store.updateOwnClassPlan('plan-a', 2, {
    className: '변조', expectedStudents: 31
  }), /revision/);
  assert.equal(fake.value('class_plans_private/plan-a').className, '2학년 1반');

  const updated = await store.updateOwnClassPlan('plan-a', 1, {
    className: '2학년 2반', plannedStartAt: 11_000, plannedEndAt: 21_000,
    expectedStudents: 31, warningLevel: 'green', warningAcknowledgedAt: 10_500
  });
  assert.equal(updated.revision, 2);
  for (const path of ['class_plans_private/plan-a', 'class_plans_public/plan-a']) {
    const value = fake.value(path);
    assert.equal(value.className, '2학년 2반');
    assert.equal(value.expectedStudents, 31);
    assert.equal(value.revision, 2);
    assert.equal(value.ownerUid, path.includes('private') ? 'teacher-a' : undefined);
  }

  await assert.rejects(store.updateOwnClassPlan('plan-a', 2, {
    ownerUid: 'forged-owner'
  }), /field|필드|owner/i);

  await assert.rejects(store.cancelOwnClassPlan('plan-a', 1), /revision/);
  const cancelled = await store.cancelOwnClassPlan('plan-a', 2);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.revision, 3);
  assert.equal(fake.value('class_plans_public/plan-a').status, 'cancelled');
  assert.equal(fake.value('class_plans_public/plan-a').revision, 3);
});

test('class plan public/admin queries require a bounded ordered server-time window', async () => {
  const first = storedClassPlanPair();
  const second = storedClassPlanPair({
    planId: 'plan-b', plannedStartAt: 30_000, plannedEndAt: 40_000,
    className: '2학년 2반'
  });
  const fake = makeFirestoreFake({
    'class_plans_public/plan-a': first.storedPublic,
    'class_plans_public/plan-b': second.storedPublic,
    'class_plans_private/plan-a': first.storedPrivate,
    'class_plans_private/plan-b': second.storedPrivate
  });
  const store = createStore(fake);

  const publicPlans = await store.listPublicPlans(9_000, 25_000, 20);
  const adminPlans = await store.listAdminPlans(9_000, 25_000, 20);

  assert.deepEqual(Object.keys(publicPlans), ['plan-a']);
  assert.equal(publicPlans['plan-a'].plannedStartAt, 10_000);
  assert.equal(publicPlans['plan-a'].ownerUid, undefined);
  assert.equal(adminPlans['plan-a'].ownerUid, 'teacher-a');
  assert.deepEqual(fake.calls().filter(call => call.operation === 'where').map(call => [
    call.path, call.field, call.operator, call.value.getTime()
  ]), [
    ['class_plans_public', 'plannedStartAt', '>=', 9_000],
    ['class_plans_public', 'plannedStartAt', '<', 25_000],
    ['class_plans_private', 'plannedStartAt', '>=', 9_000],
    ['class_plans_private', 'plannedStartAt', '<', 25_000]
  ]);
  await assert.rejects(store.listPublicPlans(25_000, 9_000, 20), /window|기간|범위/);
  await assert.rejects(store.listAdminPlans(9_000, 25_000, 101), /limit/);
  await assert.rejects(store.listPublicPlans(
    1_000 - (24 * 60 + 8) * 60 * 1000 - 1, 2_000, 20
  ), /server|과거|horizon|범위/);
  await assert.rejects(store.listPublicPlans(
    1_000 + 2 * 24 * 60 * 60 * 1000,
    1_000 + 32 * 24 * 60 * 60 * 1000 + 1, 20
  ), /server|미래|horizon|범위/);
});

test('own class plan query binds the current identity and returns only action-safe plan metadata', async () => {
  const own = storedClassPlanPair();
  const other = storedClassPlanPair({
    planId: 'plan-other', ownerUid: 'teacher-b', ownerEmailCanonical: 'teacher-b@school.kr',
    ownerDisplayName: '다른 교사'
  });
  const fake = makeFirestoreFake({
    'class_plans_private/plan-a': own.storedPrivate,
    'class_plans_private/plan-other': other.storedPrivate
  });
  const store = createStore(fake);

  const plans = await store.listOwnClassPlans(9_000, 25_000, 20, {
    uid: 'teacher-a', email: 'teacher@school.kr'
  });

  assert.deepEqual(plans, {
    'plan-a': { planId: 'plan-a', revision: 1, status: 'planned' }
  });
  assert.deepEqual(fake.calls().filter(call => call.operation === 'where').map(call => [
    call.path, call.field, call.operator, call.value
  ]), [
    ['class_plans_private', 'ownerUid', '==', 'teacher-a'],
    ['class_plans_private', 'plannedStartAt', '>=', new Date(9_000)],
    ['class_plans_private', 'plannedStartAt', '<', new Date(25_000)]
  ]);
  await assert.rejects(store.listOwnClassPlans(9_000, 25_000, 20, {
    uid: '', email: 'teacher@school.kr'
  }), /UID|identity|신원/);
});

test('class plan attach rechecks active identity, revision, owner and set then binds one session idempotently', async () => {
  const pair = storedClassPlanPair();
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'sessions/session-a': {
      teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', setId: 'set-a',
      status: 'live', createdAt: { toMillis: () => 12_000 },
      registeredStudentCount: 1, studentCountRevision: 1, lastStudentUid: 'student-1'
    }
  });
  const store = createStore(fake);
  const owner = {
    uid: 'teacher-a', email: 'teacher@school.kr', expectedRevision: 1
  };

  const attached = await store.attachPlanToSession('plan-a', 'session-a', owner);
  assert.equal(attached.status, 'live');
  assert.equal(attached.revision, 2);
  assert.equal(attached.sessionId, 'session-a');
  assert.equal(fake.value('class_plans_public/plan-a').sessionId, 'session-a');
  assert.equal(fake.value('class_plans_public/plan-a').actualStartedAt.toMillis(), 12_000);
  assert.equal(fake.value('class_plans_public/plan-a').actualParticipants, 1);
  assert.equal(fake.value('class_plans_private/plan-a').actualParticipants, undefined);
  assert.equal(fake.value('sessions/session-a').classPlanId, 'plan-a');
  assert.equal(fake.value('sessions/session-a').classPlanRevision, 2);

  const writesBeforeRetry = fake.calls().filter(call =>
    ['transactionSet', 'transactionUpdate'].includes(call.operation)
  ).length;
  const retried = await store.attachPlanToSession('plan-a', 'session-a', owner);
  assert.equal(retried.revision, 2);
  assert.equal(fake.calls().filter(call =>
    ['transactionSet', 'transactionUpdate'].includes(call.operation)
  ).length, writesBeforeRetry);

  fake.emit('sessions/session-b', {
    teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', setId: 'other-set',
    status: 'live', createdAt: { toMillis: () => 13_000 }
  });
  await assert.rejects(store.attachPlanToSession('plan-a', 'session-b', {
    ...owner, expectedRevision: 2
  }), /already|연결|session|세트|상태/i);
  assert.equal(fake.value('class_plans_private/plan-a').sessionId, 'session-a');
});

test('class plan finish ignores forged actuals and ends only after authoritative ended session count', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'session-a', actualStartedAtMs: 12_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 12_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 12_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'sessions/session-a': {
      teacherUid: 'teacher-a', setId: 'set-a', status: 'ended',
      createdAt: { toMillis: () => 12_000 }, endedAt: { toMillis: () => 25_000 },
      registeredStudentCount: 2, studentCountRevision: 2, lastStudentUid: 'student-2',
      actualParticipants: 2, classPlanId: 'plan-a', classPlanRevision: 2
    }
  });
  const store = createStore(fake);

  const finished = await store.finishClassPlan('plan-a', 'session-a', {
    expectedRevision: 2, actualParticipants: 999, actualEndedAtMs: 1
  });

  assert.equal(finished.status, 'ended');
  assert.equal(finished.revision, 3);
  assert.equal(finished.actualParticipants, 2);
  assert.equal(finished.actualEndedAtMs, 25_000);
  const stored = fake.value('class_plans_public/plan-a');
  assert.equal(stored.actualParticipants, 2);
  assert.equal(stored.actualEndedAt.toMillis(), 25_000);
});

test('class plan finish rejects missing or mismatched persistent authoritative counter', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'session-a', actualStartedAtMs: 12_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 12_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 12_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'sessions/session-a': {
      teacherUid: 'teacher-a', setId: 'set-a', status: 'ended',
      createdAt: { toMillis: () => 12_000 }, endedAt: { toMillis: () => 25_000 },
      actualParticipants: 1, classPlanId: 'plan-a', classPlanRevision: 2
    }
  });

  await assert.rejects(createStore(fake).finishClassPlan('plan-a', 'session-a', {
    expectedRevision: 2
  }), /count|집계|participant|인원/);
  assert.equal(fake.value('class_plans_private/plan-a').status, 'live');
});

test('class plan session end records the persistent authoritative student count in the atomic ended parent', async () => {
  const fake = makeFirestoreFake({
    'sessions/session-a': {
      teacherUid: 'teacher-a', status: 'live', registeredStudentCount: 2,
      studentCountRevision: 2, lastStudentUid: 'student-2'
    },
    'sessions/session-a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 },
    'sessions/session-a/students/student-1': { uid: 'student-1' },
    'sessions/session-a/students/student-2': { uid: 'student-2' }
  });

  await createStore(fake).endSession('session-a');

  assert.equal(fake.value('sessions/session-a').status, 'ended');
  assert.equal(fake.value('sessions/session-a').actualParticipants, 2);
  assert.equal(fake.value('sessions/session-a/meta/live').status, 'ended');
});

test('class plan finish failure commits no fabricated ended projection and remains retryable', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'session-a', actualStartedAtMs: 12_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 12_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 12_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'sessions/session-a': {
      teacherUid: 'teacher-a', setId: 'set-a', status: 'live',
      createdAt: { toMillis: () => 12_000 }
    }
  });
  const store = createStore(fake);

  await assert.rejects(store.finishClassPlan('plan-a', 'session-a', {
    expectedRevision: 2
  }), /ended|종료/);

  assert.equal(fake.value('class_plans_private/plan-a').status, 'live');
  assert.equal(fake.value('class_plans_public/plan-a').status, 'live');
});

test('teacher request submit, server read, and exact-revision cancellation preserve owner identity', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.submitTeacherRequest(teacherRequestInput());
  const submitted = fake.value('teacher_access_requests/teacher-a');
  assert.deepEqual({
    ...submitted,
    createdAt: submitted.createdAt.toMillis(),
    updatedAt: submitted.updatedAt.toMillis()
  }, {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    organization: '1학년',
    note: '보건 수업',
    status: 'pending',
    revision: 1,
    createdAt: 50_000,
    updatedAt: 50_000
  });

  assert.deepEqual(await store.getOwnTeacherRequest('teacher-a'), {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    organization: '1학년',
    note: '보건 수업',
    status: 'pending',
    revision: 1,
    createdAtMs: 50_000,
    updatedAtMs: 50_000
  });

  await store.cancelTeacherRequest('teacher-a', 1);
  const cancelled = fake.value('teacher_access_requests/teacher-a');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.revision, 2);
  assert.equal(cancelled.uid, 'teacher-a');
  assert.equal(cancelled.emailCanonical, 'teacher@school.kr');
  assert.equal(cancelled.updatedAt.toMillis(), 50_000);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 2);
});

test('teacher request submit and cancellation reject duplicates, privileged fields, stale revisions, and identity drift', async () => {
  const existing = pendingTeacherRequest();
  const fake = makeFirestoreFake({ 'teacher_access_requests/teacher-a': existing });
  const store = createStore(fake);

  await assert.rejects(store.submitTeacherRequest(teacherRequestInput()), /이미 존재|existing/);
  await assert.rejects(store.submitTeacherRequest(teacherRequestInput({
    decidedByUid: 'forged-admin'
  })), /허용되지 않은|invalid/i);
  await assert.rejects(store.cancelTeacherRequest('teacher-a', 2), /revision|리비전/);
  fake.emit('teacher_access_requests/teacher-a', pendingTeacherRequest({ uid: 'teacher-b' }));
  await assert.rejects(store.cancelTeacherRequest('teacher-a', 3), /identity|UID|신원/);
  assert.equal(fake.value('teacher_access_requests/teacher-a').status, 'pending');
});

test('admin approval atomically updates the teacher request and both authoritative and legacy allowances', async () => {
  const fake = makeFirestoreFake({
    'teacher_access_requests/teacher-a': pendingTeacherRequest(),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);

  await store.decideTeacherRequest(
    'teacher-a', 3, { status: 'approved', reason: 'approved-school' }, teacherRequestAdmin
  );

  const request = fake.value('teacher_access_requests/teacher-a');
  assert.equal(request.status, 'approved');
  assert.equal(request.revision, 4);
  assert.equal(request.decidedByUid, 'admin-uid');
  assert.equal(request.decisionReason, 'approved-school');
  assert.equal(request.decidedAt.toMillis(), 50_000);
  assert.equal(request.updatedAt.toMillis(), 50_000);

  const allowance = fake.value('teacher_allowances/teacher-a');
  assert.deepEqual({
    ...allowance,
    approvedAt: allowance.approvedAt.toMillis(),
    updatedAt: allowance.updatedAt.toMillis()
  }, {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    status: 'active',
    enabled: true,
    role: 'teacher',
    administrativeHold: false,
    approvedAt: 50_000,
    approvedByUid: 'admin-uid',
    updatedAt: 50_000,
    updatedByUid: 'admin-uid'
  });
  const legacy = fake.value('teacher_allowlist/teacher@school.kr');
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.uid, 'teacher-a');
  assert.equal(legacy.role, 'teacher');
  assert.equal(legacy.updatedByUid, 'admin-uid');
  assert.equal(legacy.updatedAt.toMillis(), 50_000);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 1);
});

test('admin approval or rejection commits nothing for stale revision, noncanonical request email, or allowance identity mismatch', async t => {
  const cases = [
    {
      name: 'stale revision', expectedRevision: 2,
      initial: { 'teacher_access_requests/teacher-a': pendingTeacherRequest() }
    },
    {
      name: 'noncanonical request email', expectedRevision: 3,
      initial: { 'teacher_access_requests/teacher-a': pendingTeacherRequest({ emailCanonical: 'Teacher@School.KR' }) }
    },
    {
      name: 'allowance identity mismatch', expectedRevision: 3,
      initial: {
        'teacher_access_requests/teacher-a': pendingTeacherRequest(),
        'teacher_allowances/teacher-a': {
          uid: 'teacher-a', emailCanonical: 'other@school.kr', status: 'suspended',
          enabled: false, role: 'teacher'
        }
      }
    },
    {
      name: 'already authoritative allowance', expectedRevision: 3,
      initial: {
        'teacher_access_requests/teacher-a': pendingTeacherRequest(),
        'teacher_allowances/teacher-a': {
          uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: '김교사',
          status: 'suspended', enabled: false, role: 'teacher', administrativeHold: false,
          approvedAt: { toMillis: () => 1 }, approvedByUid: 'first-admin',
          updatedAt: { toMillis: () => 1 }, updatedByUid: 'first-admin',
          suspendedAt: { toMillis: () => 1 }, suspendedByUid: 'first-admin',
          suspensionReason: ''
        }
      }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fake = makeFirestoreFake({
        ...entry.initial,
        'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
      });
      const before = clone(entry.initial);
      const store = createStore(fake);
      await assert.rejects(store.decideTeacherRequest(
        'teacher-a', entry.expectedRevision, { status: 'approved' }, teacherRequestAdmin
      ));
      assert.deepEqual(fake.value('teacher_access_requests/teacher-a'), before['teacher_access_requests/teacher-a']);
      assert.deepEqual(fake.value('teacher_allowances/teacher-a'), before['teacher_allowances/teacher-a']);
      assert.equal(fake.value('teacher_allowlist/teacher@school.kr'), undefined);
    });
  }
});

test('admin rejection is atomic, increments the exact pending revision, and creates no allowance', async () => {
  const fake = makeFirestoreFake({
    'teacher_access_requests/teacher-a': pendingTeacherRequest(),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  }, { failTransactionAt: 1 });
  const store = createStore(fake);

  await assert.rejects(store.decideTeacherRequest(
    'teacher-a', 3, { status: 'rejected', reason: 'not-current-staff' }, teacherRequestAdmin
  ), /planned transaction failure/);
  assert.equal(fake.value('teacher_access_requests/teacher-a').status, 'pending');
  assert.equal(fake.value('teacher_allowances/teacher-a'), undefined);

  const successFake = makeFirestoreFake({
    'teacher_access_requests/teacher-a': pendingTeacherRequest(),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  await createStore(successFake).decideTeacherRequest(
    'teacher-a', 3, { status: 'rejected', reason: 'not-current-staff' }, teacherRequestAdmin
  );
  const rejected = successFake.value('teacher_access_requests/teacher-a');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.revision, 4);
  assert.equal(rejected.decisionReason, 'not-current-staff');
  assert.equal(successFake.value('teacher_allowances/teacher-a'), undefined);
  assert.equal(successFake.value('teacher_allowlist/teacher@school.kr'), undefined);
});

test('admin approval list rejects an omitted identity before reading request profiles', async () => {
  const fake = makeFirestoreFake({
    'teacher_access_requests/sensitive': pendingTeacherRequest({
      uid: 'sensitive', emailCanonical: 'sensitive@school.kr', note: 'private-note'
    })
  });

  await assert.rejects(
    createStore(fake).listPendingTeacherRequests(50),
    /관리자/
  );
  assert.equal(fake.calls().some(call => call.operation === 'getCollection'), false);
});

test('admin approval list is bounded to pending teacher requests and requires current admin authority', async () => {
  const fake = makeFirestoreFake({
    'teacher_access_requests/a': pendingTeacherRequest({ uid: 'a', emailCanonical: 'a@school.kr' }),
    'teacher_access_requests/b': pendingTeacherRequest({ uid: 'b', emailCanonical: 'b@school.kr' }),
    'teacher_access_requests/c': pendingTeacherRequest({ uid: 'c', emailCanonical: 'c@school.kr', status: 'cancelled' }),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);

  const requests = await store.listPendingTeacherRequests(1, teacherRequestAdmin);
  assert.deepEqual(Object.keys(requests), ['a']);
  assert.equal(requests.a.createdAtMs, 1_000);
  assert.ok(fake.calls().some(call => call.operation === 'where' &&
    call.path === 'teacher_access_requests' && call.field === 'status' &&
    call.operator === '==' && call.value === 'pending'));
  assert.ok(fake.calls().some(call => call.operation === 'getCollection' &&
    call.path === 'teacher_access_requests' && call.options?.source === 'server'));
  await assert.rejects(store.listPendingTeacherRequests(100, {
    uid: 'teacher-a', email: 'teacher@school.kr', role: 'teacher'
  }), /관리자/);
  await assert.rejects(store.listPendingTeacherRequests(101, teacherRequestAdmin), /limit|개수/);
});

test('admin approval list returns no request profile when current admin authority is stale or offline', async t => {
  const sensitiveRequest = pendingTeacherRequest({
    uid: 'sensitive-teacher',
    emailCanonical: 'sensitive@school.kr',
    note: 'private-note'
  });

  await t.test('stale authoritative admin allowance overrides active legacy cache', async () => {
    const fake = makeFirestoreFake({
      'teacher_access_requests/sensitive-teacher': sensitiveRequest,
      'teacher_allowances/admin-uid': {
        uid: 'admin-uid', emailCanonical: 'admin@school.kr', status: 'suspended',
        enabled: false, role: 'admin'
      },
      'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
    });

    await assert.rejects(
      createStore(fake).listPendingTeacherRequests(50, teacherRequestAdmin),
      /더 이상 유효하지|관리자/
    );
    assert.equal(fake.calls().some(call => call.operation === 'getCollection'), false);
  });

  await t.test('offline server authority check never reaches request query', async () => {
    const unavailable = Object.assign(new Error('offline'), { code: 'unavailable' });
    let queryReads = 0;
    const db = {
      doc() {
        return { get(options) {
          assert.equal(options?.source, 'server');
          return Promise.reject(unavailable);
        } };
      },
      collection() {
        queryReads += 1;
        throw new Error('request query must not run');
      }
    };
    const store = loadStoreModule().createFirestoreStore(db, {
      serverTimestamp() { return SERVER_TIMESTAMP; }
    }, () => 0);

    await assert.rejects(
      store.listPendingTeacherRequests(50, teacherRequestAdmin),
      unavailable
    );
    assert.equal(queryReads, 0);
  });

  await t.test('cache-only request query cannot return email or note after server admin validation', async () => {
    const unavailable = Object.assign(new Error('server unavailable'), { code: 'unavailable' });
    const adminAllowance = {
      uid: 'admin-uid', emailCanonical: 'admin@school.kr', status: 'active',
      enabled: true, role: 'admin'
    };
    let queryOptions;
    const queryRef = {
      where() { return this; },
      limit() { return this; },
      get(options) {
        queryOptions = options;
        if (options?.source === 'server') return Promise.reject(unavailable);
        return Promise.resolve({
          docs: [{
            id: 'sensitive-teacher',
            data: () => sensitiveRequest
          }]
        });
      }
    };
    const db = {
      doc(path) {
        return { get(options) {
          assert.equal(options?.source, 'server');
          return Promise.resolve(path === 'teacher_allowances/admin-uid'
            ? { exists: true, data: () => adminAllowance }
            : { exists: false, data: () => undefined });
        } };
      },
      collection(path) {
        assert.equal(path, 'teacher_access_requests');
        return queryRef;
      }
    };
    const store = loadStoreModule().createFirestoreStore(db, {
      serverTimestamp() { return SERVER_TIMESTAMP; }
    }, () => 0);

    await assert.rejects(
      store.listPendingTeacherRequests(50, teacherRequestAdmin),
      unavailable
    );
    assert.deepEqual(queryOptions, { source: 'server' });
  });
});

test('admin approval lifecycle suspends and restores the exact teacher identity in one transaction', async () => {
  const approvedAt = { toMillis: () => 1_000 };
  const allowance = {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    status: 'active',
    enabled: true,
    role: 'teacher',
    administrativeHold: false,
    approvedAt,
    approvedByUid: 'first-admin',
    updatedAt: approvedAt,
    updatedByUid: 'first-admin'
  };
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': allowance,
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);

  await store.suspendTeacher('teacher-a', 'leave', teacherRequestAdmin);
  const suspended = fake.value('teacher_allowances/teacher-a');
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.enabled, false);
  assert.equal(suspended.suspensionReason, 'leave');
  assert.equal(suspended.suspendedByUid, 'admin-uid');
  assert.equal(suspended.suspendedAt.toMillis(), 50_000);
  assert.equal(fake.value('teacher_allowlist/teacher@school.kr').enabled, false);

  await store.restoreTeacher('teacher-a', teacherRequestAdmin);
  const restored = fake.value('teacher_allowances/teacher-a');
  assert.equal(restored.status, 'active');
  assert.equal(restored.enabled, true);
  assert.equal(Object.hasOwn(restored, 'suspendedAt'), false);
  assert.equal(Object.hasOwn(restored, 'suspendedByUid'), false);
  assert.equal(Object.hasOwn(restored, 'suspensionReason'), false);
  assert.equal(restored.uid, 'teacher-a');
  assert.equal(restored.emailCanonical, 'teacher@school.kr');
  assert.equal(fake.value('teacher_allowlist/teacher@school.kr').enabled, true);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 3);
});

test('admin approval lifecycle rejects non-admin, wrong UID, overlong reason, and deletion-pending restore without writes', async () => {
  const approvedAt = { toMillis: () => 1 };
  const allowance = {
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: '김교사',
    status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
    approvedAt, approvedByUid: 'admin-uid', updatedAt: approvedAt,
    updatedByUid: 'admin-uid'
  };
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': allowance,
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);
  const teacher = { uid: 'teacher-a', email: 'teacher@school.kr', role: 'teacher' };

  await assert.rejects(store.suspendTeacher('teacher-a', 'x', teacher), /관리자/);
  await assert.rejects(store.suspendTeacher('teacher-b', 'x', teacherRequestAdmin), /allowance|승인|문서/);
  await assert.rejects(store.suspendTeacher('teacher-a', 'x'.repeat(201), teacherRequestAdmin), /200/);
  fake.emit('teacher_allowances/teacher-a', { ...allowance, status: 'deletion_pending', enabled: false });
  await assert.rejects(store.restoreTeacher('teacher-a', teacherRequestAdmin), /deletion|탈퇴/);
  assert.equal(fake.value('teacher_allowances/teacher-a').status, 'deletion_pending');
  assert.equal(fake.value('teacher_allowlist/teacher@school.kr').enabled, true);
});

test('allowance listing exposes migrated UID revision and email-only mutation APIs fail closed', async () => {
  const approvedAt = { toMillis: () => 1 };
  const fake = makeFirestoreFake({
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' },
    'teacher_allowlist/new@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowances/new-uid': activeTeacherAllowance({
      uid: 'new-uid', emailCanonical: 'new@school.kr', revision: 3,
      approvedAt, approvedByUid: 'admin-uid', updatedAt: approvedAt, updatedByUid: 'admin-uid'
    })
  });
  const store = createStore(fake);
  const admin = { uid: 'admin-uid', email: 'ADMIN@School.KR', role: 'admin', authGeneration: 7 };

  const allowances = await store.listTeacherAllowances(admin);
  assert.deepEqual(allowances['admin@school.kr'], { enabled: true, role: 'admin', migrated: false });
  assert.equal(allowances['new@school.kr'].uid, 'new-uid');
  assert.equal(allowances['new@school.kr'].revision, 3);
  assert.equal(allowances['new@school.kr'].migrated, true);
  assert.equal(allowances['new@school.kr'].role, 'teacher');
  await assert.rejects(store.upsertTeacherAllowance('new@school.kr', 'teacher', admin), /이메일 전용/);
  await assert.rejects(store.disableTeacherAllowance('new@school.kr', admin), /이메일 전용/);
});

test('휴지통 자동 정리는 counter migration gate가 해제된 경우에만 허용된다', async () => {
  const ready = makeFirestoreFake({
    'migration_gates/set_counters': {
      locked: false, lockId: 'gate-1', projectId: 'video-quiz-65798', targetMode: 'production',
      lockedAt: new Date(1), lockedByUid: 'admin', unlockedAt: new Date(2), unlockedByUid: 'admin'
    }
  });
  const store = createStore(ready);
  assert.equal((await store.getCounterMigrationState()).ready, true);
  const locked = makeFirestoreFake({ 'migration_gates/set_counters': { locked: true } });
  assert.equal((await createStore(locked).getCounterMigrationState()).ready, false);
});

test('휴지통 만료 판정은 동기화된 serverNow를 사용하고 client clock을 신뢰하지 않는다', async () => {
  const base = Date.UTC(2026, 7, 1);
  const deadline = base + 30 * 86400000;
  const fake = makeFirestoreFake({
    'quiz_sets/skew': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'trashed',
      trashedAt: base, purgeStartedAt: null, collaboratorCount: 0, imageCount: 0
    }
  }, { committedServerMillis: deadline - 1 });
  let clientNow = deadline - 5001;
  const store = createStore(fake, () => clientNow);
  await store.syncClock('clock/skew-before');
  await assert.rejects(store.beginSetPurge('skew', 'expired', { uid: 'owner', role: 'teacher' }), /30일/);
  const exactFake = makeFirestoreFake({
    'quiz_sets/skew': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'trashed',
      trashedAt: base, purgeStartedAt: null, collaboratorCount: 0, imageCount: 0
    }
  }, { committedServerMillis: deadline });
  clientNow = deadline - 5001;
  const exactStore = createStore(exactFake, () => clientNow);
  await exactStore.syncClock('clock/skew-exact');
  const result = await exactStore.beginSetPurge('skew', 'expired', { uid: 'owner', role: 'teacher' });
  assert.equal(result.started, true);
});

test('legacy email-only allowance API rejects every caller before writes', async () => {
  const fake = makeFirestoreFake({
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);
  await assert.rejects(store.upsertTeacherAllowance('x@school.kr', 'teacher', {
    uid: 'admin-uid', email: 'admin@school.kr', role: 'admin',
    authGeneration: 2, currentAuthGeneration: 3
  }), /이메일 전용/);
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
  }, {
    beforeTransactionGet(path) {
      if (path === 'quiz_sets/set1/collaborators/disabled@school.kr') {
        throw Object.assign(new Error('rules denied unapproved target'), {
          code: 'permission-denied'
        });
      }
    }
  });
  const store = createStore(fake);
  const owner = { uid: 'owner', email: 'owner@school.kr', role: 'teacher' };
  const editor = { uid: 'editor', email: 'editor@school.kr', role: 'teacher' };
  await assert.rejects(store.addCollaborator('set1', 'disabled@school.kr', owner),
    /승인된 교사/);
  await store.addCollaborator('set1', 'EDITOR@School.KR', owner);
  assert.equal(fake.value('quiz_sets/set1').collaboratorCount, 1);
  assert.equal(fake.value('quiz_sets/set1/collaborators/editor@school.kr').email, 'editor@school.kr');
  assert.deepEqual(fake.value('quiz_set_shares/editor@school.kr/sets/set1'), {
    email: 'editor@school.kr', setId: 'set1'
  });
  assert.equal(await store.canEditQuizSet('set1', editor), true);
  assert.deepEqual((await store.listCollaborators('set1', owner)).map(item => item.email), ['editor@school.kr']);
  await assert.rejects(store.addCollaborator('set1', 'other@school.kr', editor), /소유자/);
  assert.equal(await store.removeCollaborator('set1', 'EDITOR@School.KR', owner), true);
  assert.equal(fake.value('quiz_sets/set1').collaboratorCount, 0);
  assert.equal(fake.value('quiz_set_shares/editor@school.kr/sets/set1'), undefined);
  assert.equal(await store.canEditQuizSet('set1', editor), false);
});

test('일반 교사의 공동 편집자 추가는 admin 전용 승인 목록을 직접 읽지 않는다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      ownerUid: 'owner', ownerEmail: 'owner@school.kr', lifecycleState: 'active',
      collaboratorCount: 0, imageCount: 0
    },
    'teacher_allowlist/editor@school.kr': { enabled: true, role: 'teacher' }
  });
  const store = createStore(fake);

  await store.addCollaborator('set1', 'EDITOR@School.KR', {
    uid: 'owner', email: 'owner@school.kr', role: 'teacher'
  });

  assert.equal(fake.calls().some(call =>
    (call.operation === 'get' || call.operation === 'transactionGet') &&
    call.path === 'teacher_allowlist/editor@school.kr'
  ), false);
  assert.equal(fake.value('quiz_sets/set1/collaborators/editor@school.kr').email,
    'editor@school.kr');
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
    'quiz_sets/other-trash': {
      ownerUid: 'other', trashedAt: 1, lifecycleState: 'trashed'
    }
  });
  const store = createStore(fake);
  await assert.rejects(
    () => store.listQuizSets({ role: 'teacher' }),
    /ownerUid|소유자/
  );
  assert.deepEqual((await store.listQuizSets({ ownerUid: 'owner', role: 'teacher' }))
    .map(set => set.id), ['active']);
  assert.ok(fake.calls().some(call => call.operation === 'where' &&
    call.path === 'quiz_sets' && call.field === 'ownerUid' && call.value === 'owner'));
  await assert.rejects(
    () => store.listQuizSets({ ownerUid: 'owner', includeTrash: true }),
    /휴지통과 정리 중/,
  );
  assert.deepEqual((await store.listTrashQuizSets('owner', 'trashed'))
    .map(set => set.id), ['trash']);
  assert.deepEqual((await store.listTrash({ role: 'admin' }))
    .map(set => set.id).sort(), ['other-trash', 'trash']);
});

test('two pending UIDs sharing one canonical email cannot replace the first approved mirror identity', async () => {
  const sharedEmail = 'shared@school.kr';
  const fake = makeFirestoreFake({
    'teacher_access_requests/teacher-a': pendingTeacherRequest({
      uid: 'teacher-a', emailCanonical: sharedEmail, displayName: '첫 교사'
    }),
    'teacher_access_requests/teacher-b': pendingTeacherRequest({
      uid: 'teacher-b', emailCanonical: sharedEmail, displayName: '둘째 교사'
    }),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });
  const store = createStore(fake);

  await store.decideTeacherRequest(
    'teacher-a', 3, { status: 'approved' }, teacherRequestAdmin
  );
  await assert.rejects(() => store.decideTeacherRequest(
    'teacher-b', 3, { status: 'approved' }, teacherRequestAdmin
  ), /UID|identity|신원|이미/);
  await store.decideTeacherRequest(
    'teacher-b', 3, { status: 'rejected', reason: '동일 이메일의 기존 UID 승인' }, teacherRequestAdmin
  );

  assert.equal(fake.value(`teacher_allowlist/${sharedEmail}`).uid, 'teacher-a');
  assert.equal(fake.value('teacher_allowances/teacher-a').uid, 'teacher-a');
  assert.equal(fake.value('teacher_allowances/teacher-b'), undefined);
  assert.equal(fake.value('teacher_access_requests/teacher-b').status, 'rejected');
});

test('approval preserves an existing canonical mirror only when it already names the exact same UID', async () => {
  const fake = makeFirestoreFake({
    'teacher_access_requests/teacher-a': pendingTeacherRequest(),
    'teacher_allowlist/teacher@school.kr': {
      uid: 'teacher-a', enabled: true, role: 'teacher',
      updatedAt: { toMillis: () => 1 }, updatedByUid: 'previous-admin'
    },
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });

  await createStore(fake).decideTeacherRequest(
    'teacher-a', 3, { status: 'approved' }, teacherRequestAdmin
  );

  assert.equal(fake.value('teacher_allowances/teacher-a').uid, 'teacher-a');
  assert.equal(fake.value('teacher_allowlist/teacher@school.kr').uid, 'teacher-a');
});

test('approval refuses an existing canonical mirror assigned to a different UID without partial writes', async () => {
  const mirror = {
    uid: 'other-uid', enabled: true, role: 'teacher',
    updatedAt: { toMillis: () => 1 }, updatedByUid: 'previous-admin'
  };
  const fake = makeFirestoreFake({
    'teacher_access_requests/teacher-a': pendingTeacherRequest(),
    'teacher_allowlist/teacher@school.kr': mirror,
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' }
  });

  await assert.rejects(() => createStore(fake).decideTeacherRequest(
    'teacher-a', 3, { status: 'approved' }, teacherRequestAdmin
  ), /UID|identity|신원/);

  assert.deepEqual(fake.value('teacher_allowlist/teacher@school.kr'), mirror);
  assert.equal(fake.value('teacher_allowances/teacher-a'), undefined);
  assert.equal(fake.value('teacher_access_requests/teacher-a').status, 'pending');
});

test('공동편집 세트 discovery는 자기 전용 exact index 결과만 direct get한다', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/shared': { ownerUid: 'owner', lifecycleState: 'active', title: '공유' },
    'quiz_set_shares/teacher@school.kr/sets/shared': {
      email: 'teacher@school.kr', setId: 'shared'
    },
    'quiz_sets/own': { ownerUid: 'teacher', lifecycleState: 'active', title: '내 것' },
    'quiz_set_shares/teacher@school.kr/sets/own': {
      email: 'teacher@school.kr', setId: 'own'
    },
    'quiz_sets/hidden': { ownerUid: 'owner', lifecycleState: 'trashed', title: '휴지통' },
    'quiz_set_shares/teacher@school.kr/sets/hidden': {
      email: 'teacher@school.kr', setId: 'hidden'
    },
    'quiz_set_shares/other@school.kr/sets/shared': {
      email: 'other@school.kr', setId: 'shared'
    }
  });
  const store = createStore(fake);

  const shared = await store.listSharedQuizSets({
    uid: 'teacher', email: 'teacher@school.kr', role: 'teacher'
  });

  assert.deepEqual(shared.map(set => set.id), ['shared']);
  assert.ok(fake.calls().some(call => call.operation === 'getCollection' &&
    call.path === 'quiz_set_shares/teacher@school.kr/sets'));
  assert.equal(fake.calls().some(call => call.operation === 'collectionGroup'), false);
});

test('공유 목록은 stale permission-denied parent만 건너뛰고 실제 읽기 장애는 전파한다', async () => {
  const actor = { uid: 'teacher', email: 'teacher@school.kr', role: 'teacher' };
  const permissionDenied = Object.assign(new Error('stale trashed parent'), {
    code: 'permission-denied'
  });
  const unavailable = Object.assign(new Error('network unavailable'), { code: 'unavailable' });
  const makeDb = hiddenFailure => ({
    collection(path) {
      assert.equal(path, 'quiz_set_shares/teacher@school.kr/sets');
      return {
        limit(value) {
          assert.equal(value, 50);
          return this;
        },
        async get(options) {
          assert.deepEqual(options, { source: 'server' });
          return {
            docs: ['active', 'hidden'].map(id => ({
              id,
              data() { return { email: actor.email, setId: id }; }
            }))
          };
        }
      };
    },
    doc(path) {
      return { async get(options) {
        assert.deepEqual(options, { source: 'server' });
        const id = path.split('/').at(-1);
        if (id === 'hidden') throw hiddenFailure;
        return {
          exists: true,
          id,
          data() { return { ownerUid: 'owner', lifecycleState: 'active', title: '공유' }; }
        };
      } };
    }
  });

  const store = loadStoreModule().createFirestoreStore(makeDb(permissionDenied), {}, () => 0);
  assert.deepEqual((await store.listSharedQuizSets(actor)).map(set => set.id), ['active']);

  const offlineStore = loadStoreModule().createFirestoreStore(makeDb(unavailable), {}, () => 0);
  await assert.rejects(offlineStore.listSharedQuizSets(actor), unavailable);
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

test('문제 이미지와 해설 이미지는 서로 다른 정규 키로 함께 저장된다', async () => {
  const fake = makeFirestoreFake();
  const store = createStore(fake);

  await store.saveQuizSet('set1', { title: '세트', videos: [{ questions: [{}] }] });
  await store.replaceImages('set1', { v0q0: 'question-image', v0q0e: 'explanation-image' });

  assert.deepEqual(await store.getImages('set1'), {
    v0q0: 'question-image', v0q0e: 'explanation-image'
  });
  assert.equal(await store.getQuestionImage('set1', 'v0q0e'), 'explanation-image');
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

  assert.deepEqual(await store.listQuizSets({ role: 'admin', allowAdminAll: true }), [{
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
      imgUrl: '', imgUp: false, _img: '', explain: '',
      explainImgUrl: '', explainImgUp: false, _explainImg: '', _explainOpen: false,
      limitSec: null
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

  assert.deepEqual(await store.listQuizSets({ role: 'admin', allowAdminAll: true }), [{
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
          questions: [{ type: 'long', t: 15, text: ' A ', choices: [], imgUp: true, _img: 'img-a',
            explain: '해설 A', explainImgUp: true, _explainImg: 'explain-a' }] },
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
      questions: [{ type: 'long', t: 15, text: 'A', choices: [], answer: 0, imgUp: true,
        explain: '해설 A', explainImgUp: true }] },
    { videoId: 'b', videoUrl: 'url-b', startSec: 30, endSec: 60,
      questions: [{ type: 'long', t: 40, text: 'B', choices: [], answer: 0, imgUp: true }] }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.images)), {
    v0q0: 'img-a', v0q0e: 'explain-a', v1q0: 'img-b'
  });
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
              questions: [{ text: 'A', imgUp: true, _img: '', explainImgUp: true, _explainImg: '' }] },
            { videoId: 'b', videoUrl: 'url-b', startSec: 30, endSec: 60,
              questions: [{ text: 'B', imgUp: true, _img: '' }] }
          ]
        };
      },
      async getImages() { return { v0q0: 'img-a', v0q0e: 'explain-a', v1q0: 'img-b' }; }
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
  assert.equal(context.mk.videos[0].questions[0]._explainImg, 'explain-a');
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
        { videoId: 'a', videoUrl: 'a', startSec: 10, endSec: 60, durationSec: 90,
          questions: [{ type: 'choice', t: 20, text: '한 줄 질문', choices: [], explain: '', limitSec: null }] },
        { videoId: 'b', videoUrl: 'b', startSec: 0, endSec: null, durationSec: null, questions: [] }
      ]
    },
    mkPlayer: null, mkPlayerVid: '',
    APP() { return app; }, topbar() { return ''; }, esc(value) { return String(value ?? ''); },
    fmtTime(value) { return '0:' + String(value || 0).padStart(2, '0'); },
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type || 'choice'; }, QTYPES: { choice: '객관식' },
    mkAnswerField() { return ''; }, mkImageField() { return ''; }, mkExplanationField() { return ''; },
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
  assert.match(app.innerHTML, /class="mk-question-text"[^>]*rows="2"[^>]*>한 줄 질문<\/textarea>/);
});

test('문항 제목 버블은 영상 전체 번호와 빈 영상·마지막 삽입 dropzone을 렌더링한다', () => {
  const app = { innerHTML: '' };
  const elements = new Map();
  const question = text => ({ type: 'long', t: 10, text, choices: [], explain: '', limitSec: null });
  const context = {
    mk: {
      id: null, title: '세트', author: '', settings: {}, activeVideo: 0, saved: false,
      videos: [
        { videoId: 'a', videoUrl: 'a', startSec: 0, endSec: 60, durationSec: 90, questions: [question('첫째'), question('둘째')] },
        { videoId: 'b', videoUrl: 'b', startSec: 0, endSec: 60, durationSec: 90, questions: [question('셋째')] },
        { videoId: 'c', videoUrl: 'c', startSec: 0, endSec: 60, durationSec: 90, questions: [] }
      ]
    },
    mkPlayer: null, mkPlayerVid: '',
    APP() { return app; }, topbar() { return ''; }, esc(value) { return String(value ?? ''); },
    fmtTime(value) { return '0:' + String(value || 0).padStart(2, '0'); },
    PlaylistCore: require('../playlist-core.js'),
    qType(q) { return q.type || 'long'; }, QTYPES: { long: '서술형' },
    mkAnswerField() { return ''; }, mkImageField() { return ''; }, mkExplanationField() { return ''; },
    mkRenderSettings() {}, mkSyncVideo() {}, mkShowShare() {}, mkMarkDirty() {}, lsSet() {},
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { addEventListener() {}, style: {} });
      return elements.get(selector);
    }
  };
  loadStageFunctions(['mkTimelineDomain', 'renderMake'], context);

  context.renderMake();

  assert.match(app.innerHTML, /data-global-question="1"[^>]*>[\s\S]*?<b>1<\/b>/);
  assert.match(app.innerHTML, /data-global-question="2"[^>]*>[\s\S]*?<b>2<\/b>/);
  assert.match(app.innerHTML, /data-global-question="3"[^>]*>[\s\S]*?<b>3<\/b>/);
  assert.match(app.innerHTML, /data-drop-video="0" data-drop-index="2"/);
  assert.match(app.innerHTML, /data-drop-video="2" data-drop-index="0"/);
});

test('서버보다 최신 draft를 복원해도 persistedSnapshot은 이미지 포함 서버 canonical을 유지한다', async () => {
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); }
  };
  const EditorDraft = require('../editor-draft.js');
  EditorDraft.write(localStorage, 'set1', {
    title: '로컬 draft', author: '', settings: {}, createdAt: 10, archived: false,
    videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
      questions: [{ type: 'long', t: 10, text: 'draft 문항', imgUp: true, _img: 'draft-image' }] }]
  }, 30);
  const app = { innerHTML: '' };
  const context = {
    mk: null, mkPlayer: null, mkPlayerVid: '', mkDraftTimer: null,
    teacherState: { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    EditorDraft, EditorHistoryCore: require('../editor-history-core.js'), localStorage,
    lsGet() { return ''; }, DEFAULT_SETTINGS: {}, blankQuestion(t) { return { t }; },
    document: { addEventListener() {}, removeEventListener() {} },
    mkHandleSaveShortcut() {}, onCleanup() {}, clearTimeout() {}, every() {}, $() { return null; },
    APP() { return app; }, topbar() { return ''; }, confirm() { return true; },
    mkUpdateHistoryControls() {}, mkSetSaveStatus() {}, mkPersistDraft() {},
    normSettings(value) { return value || {}; }, renderMake() {}, Date,
    store: {
      async getQuizSet() {
        return {
          title: '서버 canonical', author: '', ownerUid: 'teacher-1', settings: {}, createdAt: 10, updatedAt: 20,
          videos: [{ videoId: 'a', videoUrl: 'url-a', startSec: 0, endSec: null,
            questions: [{ type: 'long', t: 10, text: '서버 문항', imgUp: true, _img: '' }] }]
        };
      },
      async getImages() { return { v0q0: 'server-image' }; }
    },
    normSet(value) { return value; }, console, toast() {}
  };
  loadStageFunctions(['mkHistorySnapshot', 'mkSnapshotsEqual', 'mkHistoryRecord', 'mkResetHistory', 'mkRestoreHistory', 'mkUndo', 'mkClearDraft', 'mkRestoreDraft', 'canEditSet', 'screenMake'], context);

  context.screenMake('set1');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(context.mk.title, '로컬 draft');
  assert.equal(context.mk.videos[0].questions[0]._img, 'draft-image');
  assert.equal(context.mk.saved, false);
  assert.equal(context.mk.persistedSnapshot.title, '서버 canonical');
  assert.equal(context.mk.persistedSnapshot.videos[0].questions[0]._img, 'server-image');

  context.mk.title = 'draft에서 추가 편집';
  context.mkHistoryRecord('title');
  assert.equal(context.mkUndo(), true);
  assert.equal(context.mk.title, '로컬 draft');
  assert.equal(context.mk.saved, false);
});

test('새 세트 draft 복원은 서버 기준점 없이 dirty history로 시작한다', () => {
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); }
  };
  const EditorDraft = require('../editor-draft.js');
  EditorDraft.write(localStorage, null, {
    title: '새 draft', author: '', settings: {}, createdAt: 0, archived: false,
    videos: [{ videoId: '', videoUrl: '', startSec: 0, endSec: null, questions: [{ text: '임시 문항' }] }]
  }, 10);
  const context = {
    mk: {
      id: null, title: '', author: '', settings: {}, videos: [], activeVideo: 0,
      saved: false, persistedSnapshot: null, history: null
    },
    EditorDraft, EditorHistoryCore: require('../editor-history-core.js'), localStorage,
    PlaylistCore: require('../playlist-core.js'), confirm() { return true; },
    mkUpdateHistoryControls() {}
  };
  loadStageFunctions(['mkHistorySnapshot', 'mkResetHistory', 'mkClearDraft', 'mkRestoreDraft'], context);

  assert.equal(context.mkRestoreDraft(0), true);
  context.mkResetHistory();

  assert.equal(context.mk.title, '새 draft');
  assert.equal(context.mk.saved, false);
  assert.equal(context.mk.persistedSnapshot, null);
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

test('문항 시간 변경은 새 범위로 타임라인 점과 문항 목록 시간을 함께 갱신한다', () => {
  const input = { value: '' };
  const bubbleTime = { textContent: '' };
  const dots = [{ style: {}, title: '' }, { style: {}, title: '' }];
  const timeline = { querySelectorAll() { return dots; } };
  const startSlider = { max: '', value: '' };
  const endSlider = { max: '', value: '' };
  const context = {
    mk: { videos: [{ startSec: 0, endSec: null, durationSec: null, questions: [{ t: 300 }, { t: 600 }] }] },
    parseTime(value) { return Number(value); },
    fmtTime(value) { return value === 900 ? '15:00' : value === 300 ? '5:00' : String(value); },
    PlaylistCore: require('../playlist-core.js'),
    document: {
      querySelector(selector) {
        if (selector === '[data-question-time="0-1"]') return input;
        if (selector === '[data-question-bubble-time="0-1"]') return bubbleTime;
        if (selector === '[data-timeline-video="0"]') return timeline;
        if (selector === '[data-range-slider="0-start"]') return startSlider;
        if (selector === '[data-range-slider="0-end"]') return endSlider;
        return null;
      }
    },
    mkMarkDirty() {}
  };
  loadStageFunctions(['mkTimelineDomain', 'mkRefreshVideoTiming', 'mkSetQuestionTime'], context);

  assert.equal(context.mkSetQuestionTime(0, 1, 900), true);
  assert.equal(context.mk.videos[0].questions[1].t, 900);
  assert.equal(input.value, '15:00');
  assert.equal(bubbleTime.textContent, '15:00');
  assert.ok(Math.abs(parseFloat(dots[0].style.left) - (100 / 3)) < 0.001);
  assert.equal(dots[1].style.left, '100%');
  assert.match(dots[0].title, /5:00/);
  assert.match(dots[1].title, /15:00/);
  assert.equal(startSlider.max, 900);
  assert.equal(endSlider.max, 900);
  assert.equal(endSlider.value, 900);
});

test('문항 시간 실시간 입력은 완성된 시각만 반영하고 입력 문자열을 유지한다', () => {
  const source = { value: '5:' };
  const updates = [];
  const context = {
    mkSetQuestionTime(videoIndex, questionIndex, value, options) {
      updates.push([videoIndex, questionIndex, value, options]);
      return true;
    }
  };
  loadStageFunctions(['mkInputQuestionTime'], context);

  assert.equal(context.mkInputQuestionTime(0, 0, source), false);
  assert.deepEqual(updates, []);

  source.value = '5:08';
  assert.equal(context.mkInputQuestionTime(0, 0, source), true);
  assert.equal(source.value, '5:08');
  assert.equal(updates.length, 1);
  assert.equal(updates[0][2], '5:08');
  assert.equal(updates[0][3].preserveInput, true);
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
    teacherState: null,
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

test('세트 목록 화면은 중단한 공동편집 discovery 없이 소유자 세트만 조회한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const app = { innerHTML: '' };
  const teacher = { uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' };
  const context = {
    setList: null,
    teacherState: teacher,
    store: {
      async listQuizSets(options) { calls.push(['owned', clone(options)]); return []; },
      async listSharedQuizSets(actor) { calls.push(['shared', clone(actor)]); return []; },
      async listTrash() { return []; }
    },
    onCleanup() {}, APP() { return app; }, topbar() { return '<nav></nav>'; },
    normSet(value) { return value; }, renderSetList() {}, esc(value) { return value; },
    console
  };
  vm.runInNewContext(extractFunction(html, 'screenSetList'), context);

  context.screenSetList();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(Object.fromEntries(calls), {
    owned: { ownerUid: teacher.uid, role: teacher.role }
  });
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
    linkTo(value) { return value; }, collaborationUiEnabled: false
  };
  loadStageFunctions(['canEditSet', 'setListRow'], context);
  const base = { id: 'set-1', title: '공유 세트', ownerUid: 'owner', ownerEmail: 'owner@school.kr', archived: false,
    trashedAt: null, purgeStartedAt: null, settings: { revealMode: 'timer' }, videos: [{ questions: [] }] };
  const owned = context.setListRow(base);
  assert.doesNotMatch(owned, /공동 편집자/);
  assert.match(owned, /휴지통/);
  const collaborator = context.setListRow({ ...base, ownerUid: 'other', collaboratorEmails: ['owner@school.kr'] });
  assert.doesNotMatch(collaborator, /공동 편집/);
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

test('숨김 공동 편집자는 편집·시작·파일·링크만 보고 다시 표시 토글은 보지 않는다', () => {
  const context = {
    PlaylistCore: require('../playlist-core.js'), AuthCore: require('../auth-core.js'), REVEAL_LABEL: { timer: '타이머' },
    teacherState: { uid: 'editor', email: 'editor@school.kr', role: 'teacher' },
    esc(value) { return String(value); }, fmtDate() { return ''; }, linkTo(value) { return value; }
  };
  loadStageFunctions(['canEditSet', 'setListRow'], context);
  const row = context.setListRow({ id: 'hidden', title: '숨김 공유', ownerUid: 'owner', archived: true,
    collaboratorEmails: ['editor@school.kr'], settings: { revealMode: 'timer' }, videos: [{ questions: [] }] });
  assert.match(row, /편집|우리 반 시작하기|📤 파일|🔗 링크/);
  assert.doesNotMatch(row, /다시 표시|휴지통/);
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
  assert.deepEqual(fake.value('sessions/new'), {
    ...session, status: 'allocating', registeredStudentCount: 0, studentCountRevision: 0
  });
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
    ...session, status: 'allocating', code: 'NEW234',
    registeredStudentCount: 0, studentCountRevision: 0
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
  assert.equal(fake.value('sessions/leased-session').activationLeaseUntil.getTime(), 150_000);

  now = 70_000;
  moveClockDuringRenew = true;
  assert.equal(await store.renewSessionActivationLease(
    'leased-session', 'LEASE1', 'teacher-1', token
  ), true);
  assert.equal(fake.value('sessions/leased-session').activationLeaseUntil.getTime(), 160_000);
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
  assert.equal(live.accepting, false);
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
    'sessions/a': {
      setId: 'set1', status: 'live', registeredStudentCount: 0, studentCountRevision: 0
    },
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
  assert.equal(session.actualParticipants, 0);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 1);
  assert.equal(fake.calls().filter(call => call.operation === 'batchCommit').length, 0);
});

test('admin allowance mutation requires exact UID email and revision and atomically syncs legacy', async () => {
  const approvedAt = { toMillis: () => 1 };
  const fake = makeFirestoreFake({
    'teacher_allowances/admin-uid': activeTeacherAllowance({
      uid: 'admin-uid', emailCanonical: 'admin@school.kr', displayName: '관리자',
      role: 'admin', revision: 7, approvedAt, approvedByUid: 'root',
      updatedAt: approvedAt, updatedByUid: 'root'
    }),
    'teacher_allowances/teacher-a': activeTeacherAllowance({
      revision: 4, approvedAt, approvedByUid: 'admin-uid',
      updatedAt: approvedAt, updatedByUid: 'admin-uid'
    }),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' },
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  });
  const store = createStore(fake);

  const changed = await store.adminUpdateTeacherAllowance({
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', expectedRevision: 4,
    status: 'active', role: 'admin'
  }, teacherRequestAdmin);

  assert.equal(changed.uid, 'teacher-a');
  assert.equal(changed.emailCanonical, 'teacher@school.kr');
  assert.equal(changed.revision, 5);
  assert.equal(changed.role, 'admin');
  assert.deepEqual(fake.value('teacher_allowlist/teacher@school.kr').role, 'admin');
  await assert.rejects(store.adminUpdateTeacherAllowance({
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', expectedRevision: 4,
    status: 'suspended', role: 'admin'
  }, teacherRequestAdmin), /revision/);
  await assert.rejects(store.adminUpdateTeacherAllowance({
    uid: 'teacher-a', emailCanonical: 'other@school.kr', expectedRevision: 5,
    status: 'suspended', role: 'admin'
  }, teacherRequestAdmin), /email|신원/);
});

test('admin allowance mutation fails closed while teacher access migration lock is active', async () => {
  const approvedAt = { toMillis: () => 1 };
  const fake = makeFirestoreFake({
    'migration_gates/teacher_access_status': {
      locked: true, lockToken: 'lock-1', projectId: 'demo-video-quiz', targetMode: 'emulator'
    },
    'teacher_allowances/admin-uid': activeTeacherAllowance({
      uid: 'admin-uid', emailCanonical: 'admin@school.kr', displayName: '관리자',
      role: 'admin', revision: 1, approvedAt, approvedByUid: 'root',
      updatedAt: approvedAt, updatedByUid: 'root'
    }),
    'teacher_allowances/teacher-a': activeTeacherAllowance({
      revision: 2, approvedAt, approvedByUid: 'admin-uid',
      updatedAt: approvedAt, updatedByUid: 'admin-uid'
    }),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' },
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  });

  await assert.rejects(createStore(fake).adminUpdateTeacherAllowance({
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', expectedRevision: 2,
    status: 'suspended', role: 'teacher', reason: 'hold'
  }, teacherRequestAdmin), /migration|마이그레이션|잠금/);
  assert.equal(fake.value('teacher_allowances/teacher-a').status, 'active');
});

test('cancelled or rejected teacher request resubmits as pending with immutable identity and next revision', async () => {
  for (const status of ['cancelled', 'rejected']) {
    const decided = status === 'rejected' ? {
      decidedAt: { toMillis: () => 2 }, decidedByUid: 'admin-uid', decisionReason: 'retry'
    } : {};
    const fake = makeFirestoreFake({
      'teacher_access_requests/teacher-a': pendingTeacherRequest({ status, revision: 6, ...decided })
    });
    const saved = await createStore(fake).resubmitTeacherRequest('teacher-a', 6, {
      emailCanonical: 'teacher@school.kr', displayName: '김교사',
      organization: '2학년', note: '다시 신청'
    });
    const stored = fake.value('teacher_access_requests/teacher-a');
    assert.equal(saved.status, 'pending');
    assert.equal(stored.revision, 7);
    assert.equal(stored.uid, 'teacher-a');
    assert.equal(stored.emailCanonical, 'teacher@school.kr');
    assert.equal(stored.organization, '2학년');
    assert.equal(Object.hasOwn(stored, 'decidedAt'), false);
    assert.equal(Object.hasOwn(stored, 'decidedByUid'), false);
    assert.equal(Object.hasOwn(stored, 'decisionReason'), false);
  }
});

test('attached live allocation abort는 server pair를 확인해 거부하고 ambiguous reload는 attach를 재개한다', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'attached', actualStartedAtMs: 12_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 12_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 12_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'codes/ATT123': { sessionId: 'attached' },
    'sessions/attached': {
      code: 'ATT123', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr',
      setId: 'set-a', status: 'live', createdAt: { toMillis: () => 12_000 },
      activationLeaseUntil: 1, classPlanId: 'plan-a', classPlanRevision: 2,
      registeredStudentCount: 0, studentCountRevision: 0
    },
    'sessions/attached/meta/allocation': { token: 'attached-token-1234', ownerUid: 'teacher-a' }
  });
  const { createFirestoreStore } = loadStoreModule();
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 100_000);

  assert.equal(await store.abortSessionAllocation(
    'attached', 'ATT123', 'teacher-a', 'attached-token-1234'
  ), false);
  assert.equal(fake.value('sessions/attached').status, 'live');
  assert.deepEqual(await store.recoverPendingSessionAllocation({
    sessionId: 'attached', code: 'ATT123', ownerUid: 'teacher-a',
    ownerEmail: 'teacher@school.kr', token: 'attached-token-1234',
    planId: 'plan-a', planRevision: 1, setId: 'set-a', attachStatus: 'attaching'
  }), { complete: false, active: true, attached: true, planRevision: 2 });
  assert.equal(fake.value('sessions/attached').status, 'live');
});

test('end와 plan finish 사이 reload 복구는 reciprocal live plan을 끝낸 뒤 complete를 반환한다', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'ended-attached', actualStartedAtMs: 12_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 12_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 12_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'sessions/ended-attached': {
      code: 'ENDED2', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr',
      setId: 'set-a', status: 'ended', endedAt: { toMillis: () => 20_000 },
      actualParticipants: 0, registeredStudentCount: 0, studentCountRevision: 0,
      classPlanId: 'plan-a', classPlanRevision: 2
    },
    'sessions/ended-attached/meta/allocation': {
      token: 'ended-attached-token', ownerUid: 'teacher-a'
    }
  }, { committedServerMillis: 21_000 });

  const result = await createStore(fake).recoverPendingSessionAllocation({
    sessionId: 'ended-attached', code: 'ENDED2', ownerUid: 'teacher-a',
    ownerEmail: 'teacher@school.kr', token: 'ended-attached-token',
    planId: 'plan-a', planRevision: 1, setId: 'set-a', attachStatus: 'attached'
  });

  assert.deepEqual(result, {
    complete: true, ended: true, finished: true, planRevision: 3
  });
  assert.equal(fake.value('class_plans_private/plan-a').status, 'ended');
  assert.equal(fake.value('class_plans_public/plan-a').actualParticipants, 0);
  assert.equal(fake.value('sessions/ended-attached').classPlanRevision, 3);
});

test('ended reciprocal plan finish 실패는 복구를 complete로 오인하지 않고 재시도 상태를 보존한다', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'ended-attached', actualStartedAtMs: 12_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 12_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 12_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-a': activeTeacherAllowance(),
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic,
    'sessions/ended-attached': {
      code: 'ENDED2', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr',
      setId: 'set-a', status: 'ended', endedAt: { toMillis: () => 20_000 },
      actualParticipants: 0, registeredStudentCount: 0, studentCountRevision: 0,
      classPlanId: 'plan-a', classPlanRevision: 2
    }
  }, { failTransactionAt: 1, failTransactionMessage: 'planned finish failure' });

  await assert.rejects(createStore(fake).recoverPendingSessionAllocation({
    sessionId: 'ended-attached', code: 'ENDED2', ownerUid: 'teacher-a',
    ownerEmail: 'teacher@school.kr', token: 'ended-attached-token',
    planId: 'plan-a', planRevision: 1, setId: 'set-a', attachStatus: 'attached'
  }), /planned finish failure/);
  assert.equal(fake.value('class_plans_private/plan-a').status, 'live');
  assert.equal(fake.value('sessions/ended-attached').classPlanRevision, 2);
});

test('학생 최초 join만 parent counter와 exact pair로 증가하고 재가입 프로필 수정은 증가시키지 않는다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': {
      teacherUid: 'teacher-a', status: 'live',
      registeredStudentCount: 0, studentCountRevision: 0
    }
  });
  const store = createStore(fake);

  await store.joinStudent('a', 'student-1', { name: '가', grade: 1 });
  await store.joinStudent('a', 'student-1', { name: '가 수정', grade: 2 });
  await store.joinStudent('a', 'student-2', { name: '나', grade: 1 });

  assert.deepEqual(fake.value('sessions/a'), {
    teacherUid: 'teacher-a', status: 'live',
    registeredStudentCount: 2, studentCountRevision: 2,
    lastStudentUid: 'student-2'
  });
  assert.equal(fake.value('sessions/a/students/student-1').name, '가 수정');
  assert.equal(fake.value('sessions/a/students/student-1').joinedAt.toMillis(), 50_000);
  assert.equal(fake.calls().filter(call =>
    call.operation === 'transactionUpdate' && call.path === 'sessions/a'
  ).length, 2);
});

test('attached live session join atomically mirrors exact participant count to public plan only', async () => {
  const pair = storedClassPlanPair({
    status: 'live', revision: 2, sessionId: 'a', actualStartedAtMs: 10_000
  });
  pair.storedPrivate.actualStartedAt = { toMillis: () => 10_000 };
  pair.storedPublic.actualStartedAt = { toMillis: () => 10_000 };
  delete pair.storedPrivate.actualStartedAtMs;
  delete pair.storedPublic.actualStartedAtMs;
  const fake = makeFirestoreFake({
    'sessions/a': {
      teacherUid: 'teacher-a', setId: 'set-a', status: 'live',
      registeredStudentCount: 0, studentCountRevision: 0,
      classPlanId: 'plan-a', classPlanRevision: 2
    },
    'class_plans_private/plan-a': pair.storedPrivate,
    'class_plans_public/plan-a': pair.storedPublic
  });

  await createStore(fake).joinStudent('a', 'student-1', { name: '가' });

  assert.equal(fake.value('sessions/a').registeredStudentCount, 1);
  assert.equal(fake.value('class_plans_public/plan-a').actualParticipants, 1);
  assert.equal(fake.value('class_plans_private/plan-a').actualParticipants, undefined);
  assert.equal(fake.value('class_plans_public/plan-a').revision, 2);
  assert.equal(fake.calls().filter(call => call.operation === 'runTransaction').length, 1);
});

test('세션 종료 재시도는 이미 확정된 ended 시각과 참여 집계를 다시 쓰지 않는다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': {
      setId: 'set1', status: 'live', registeredStudentCount: 0, studentCountRevision: 0
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  }, { committedServerMillis: 20_000 });
  const store = createStore(fake);

  await store.endSession('a');
  const firstEndedAt = fake.value('sessions/a').endedAt;
  await store.endSession('a');

  assert.equal(fake.value('sessions/a').endedAt.toMillis(), firstEndedAt.toMillis());
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet').length, 2);
});

test('세션 종료는 student query 결과가 아니라 paired parent counter만 actualParticipants로 확정한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': {
      setId: 'set1', status: 'live', registeredStudentCount: 2, studentCountRevision: 2,
      lastStudentUid: 'student-2'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 },
    'sessions/a/students/student-1': { uid: 'student-1' }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').actualParticipants, 2);
  assert.equal(fake.calls().some(call =>
    call.operation === 'getCollection' && call.path === 'sessions/a/students'
  ), false);
});

test('migration gate 전 counter 없는 legacy session은 actual을 만들지 않고 atomic 안전 종료한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 },
    'sessions/a/students/student-1': { uid: 'student-1' }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').status, 'ended');
  assert.equal(fake.value('sessions/a').actualParticipants, undefined);
  assert.equal(fake.value('sessions/a/meta/live').status, 'ended');
  assert.equal(fake.calls().some(call =>
    call.operation === 'getCollection' && call.path === 'sessions/a/students'
  ), false);
});

test('migration gate 완료 뒤 counter 없는 legacy session 종료는 fail closed한다', async () => {
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt: new Date(10_000), updatedAt: new Date(10_000), completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await assert.rejects(createStore(fake).endSession('a'), /counter|migration|집계/);
  assert.equal(fake.value('sessions/a').status, 'live');
  assert.equal(fake.value('sessions/a/meta/live').status, undefined);
});

test('Date와 Firebase Timestamp가 섞인 gate는 같은 millis여도 legacy safe end를 유지한다', async () => {
  const { Timestamp } = require('firebase/firestore');
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt: new Date(10_000), updatedAt: new Timestamp(10, 0),
      completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').status, 'ended');
  assert.equal(fake.value('sessions/a').actualParticipants, undefined);
  assert.equal(fake.value('sessions/a/meta/live').status, 'ended');
});

test('raw numeric gate timestamps는 완료로 오인하지 않고 legacy session을 안전 종료한다', async () => {
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt: 10_000, updatedAt: 10_000, completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').status, 'ended');
  assert.equal(fake.value('sessions/a').actualParticipants, undefined);
  assert.equal(fake.value('sessions/a/meta/live').status, 'ended');
});

test('millis가 불일치하는 timestamp-shaped gate는 완료로 오인하지 않고 legacy safe end를 유지한다', async () => {
  class Timestamp {
    constructor() { this.seconds = 10; this.nanoseconds = 0; }
    toMillis() { return 10_001; }
    toDate() { return new Date(10_001); }
    isEqual() { return false; }
  }
  const shaped = new Timestamp();
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt: shaped, updatedAt: shaped, completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').status, 'ended');
  assert.equal(fake.value('sessions/a').actualParticipants, undefined);
});

test('SDK를 흉내 낸 coherent Timestamp class도 완료 gate brand로 인정하지 않는다', async () => {
  class Timestamp {
    constructor() { this.seconds = 10; this.nanoseconds = 0; }
    toMillis() { return 10_000; }
    toDate() { return new Date(10_000); }
    isEqual(other) {
      return other && other.seconds === this.seconds &&
        other.nanoseconds === this.nanoseconds;
    }
  }
  const forged = new Timestamp();
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt: forged, updatedAt: forged, completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').status, 'ended');
  assert.equal(fake.value('sessions/a').actualParticipants, undefined);
});

test('toMillis가 충돌해도 nanos가 다른 실제 Firebase Timestamp gate는 legacy safe end를 유지한다', async () => {
  const { Timestamp } = require('firebase/firestore');
  const verifiedAt = new Timestamp(253_402_300_799, 1);
  const updatedAt = new Timestamp(253_402_300_799, 2);
  assert.equal(verifiedAt.toMillis(), updatedAt.toMillis());
  assert.equal(verifiedAt.isEqual(updatedAt), false);
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt, updatedAt, completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').status, 'ended');
  assert.equal(fake.value('sessions/a').actualParticipants, undefined);
  assert.equal(fake.value('sessions/a/meta/live').status, 'ended');
});

test('동일 nanos의 별도 Firebase Timestamp exact gate는 strict migration 완료를 활성화한다', async () => {
  const { Timestamp } = require('firebase/firestore');
  const verifiedAt = new Timestamp(10, 123_456_789);
  const updatedAt = new Timestamp(10, 123_456_789);
  const fake = makeFirestoreFake({
    'migration_gates/session_counters': {
      complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
      rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
      verifiedAt, updatedAt, completedByUid: 'admin-uid'
    },
    'sessions/a': {
      setId: 'set1', teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr', status: 'live'
    },
    'sessions/a/meta/live': { q: -1, openedAt: 0, revealed: false, limitSec: 0 }
  });

  await assert.rejects(createStore(fake).endSession('a'), /counter|migration|집계/);
  assert.equal(fake.value('sessions/a').status, 'live');
});

test('ended 재시도는 preserved endedAt으로 actual count를 counter invariant에 복구한다', async () => {
  const endedAt = { toMillis: () => 20_000 };
  const fake = makeFirestoreFake({
    'sessions/a': {
      setId: 'set1', status: 'ended', endedAt, actualParticipants: 1,
      registeredStudentCount: 2, studentCountRevision: 2, lastStudentUid: 'student-2'
    },
    'sessions/a/meta/live': {
      q: -1, openedAt: 0, revealed: false, limitSec: 0, status: 'ended'
    }
  });

  await createStore(fake).endSession('a');

  assert.equal(fake.value('sessions/a').actualParticipants, 2);
  assert.equal(fake.value('sessions/a').endedAt.toMillis(), 20_000);
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet').length, 2);
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

  assert.deepEqual(order, ['play', 'grade-start']);
  resolveGrade();
  await Promise.all([firstGrade, secondGrade, closing]);
  assert.deepEqual(order, ['play', 'grade-start', 'grade-end', 'board', 'live-close']);
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

test('timer 문항은 제출 보호 시간이 끝나기 전 권한 쓰기를 시도하지 않고 안내 후 재시도한다', async () => {
  let now = 12_100;
  let freezes = 0;
  let closes = 0;
  const state = {
    sessionId: 'session-a',
    live: {
      q: 0, liveToken: 'live-q0', openedAt: 10_000, accepting: true,
      revealed: true, submitGraceUntil: 14_000
    },
    liveGeneration: 1, responses: {}, pendingLiveQuestion: -1,
    player: { playVideo() {} }
  };
  const context = {
    pl: state, FirestoreCore: core, serverNow() { return now; },
    store: {
      async freezeLive() { freezes += 1; return true; },
      async getResponses() { return {}; }, async getGrades() { return {}; },
      async closeLive() { closes += 1; return true; }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { return false; }, plTick() {}, plRenderOverlay() {}
  };
  loadStageFunctions(['plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), false);
  assert.equal(freezes, 0);
  assert.equal(closes, 0);
  assert.match(state.closeError, /제출.*마감.*2초/);
  assert.equal(state.closeFlight, undefined);

  now = 14_000;
  assert.equal(await context.plCloseQuestion(), true);
  assert.equal(freezes, 1);
  assert.equal(closes, 1);
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plCompletePlaylist', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plOpenQuestion', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], {
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

test('완료 메뉴는 대시보드 없이 순위·처음부터 재생·명시적 진행 종료만 제공한다', () => {
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
  assert.doesNotMatch(completion.innerHTML, /대시보드|href="#\/live\/session-a"/);
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

test('운영 우리 반 시작하기는 수업계획을 보관한 채 반 이름으로 바로 시작한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(html, /const classPlanningUiEnabled = false/);
  assert.match(html, /classPlanningUiEnabled[\s\S]*?id="pl-label"[\s\S]*?onclick="plStartSession\(\)"/);
  assert.match(html, /id="pl-label"[^>]*placeholder="학년반을 입력해 주세요"[^>]*value=""/);
  assert.doesNotMatch(html, /id="pl-label"[^>]*value="[^"]*vq_last_label/);
  assert.match(html, /planningEnabled\s*=\s*\(typeof classPlanningUiEnabled[^;]+classPlanningUiEnabled\)[\s\S]*?&&/);
  // 재개할 때 사용할 계획 UI와 저장 흐름은 삭제하지 않고 보관한다.
  assert.match(html, /id="pl-plan-dialog"/);
  assert.match(html, /id="pl-plan-class-name"/);
  assert.match(html, /id="pl-plan-start"[^>]*type="datetime-local"|type="datetime-local"[^>]*id="pl-plan-start"/);
  assert.match(html, /id="pl-plan-end"[^>]*type="datetime-local"|type="datetime-local"[^>]*id="pl-plan-end"/);
  assert.match(html, /id="pl-plan-expected"/);
  assert.match(html, /id="pl-plan-warning"/);
  assert.match(html, /id="pl-plan-ack"/);
  assert.match(html, /경고 확인 후 진행/);
  assert.match(html, /function plOpenClassPlanDialog\(\)/);
});

test('datetime-local 기본값은 server 12:00:45를 같은 로컬 분의 12:00으로 절삭한다', () => {
  const start = { value: '' };
  const end = { value: '' };
  const dialog = { showModal() { this.opened = true; } };
  const elements = {
    '#pl-plan-dialog': dialog,
    '#pl-plan-start': start,
    '#pl-plan-end': end,
    '#pl-plan-warning': { textContent: '' }
  };
  const serverMillis = new Date(2026, 7, 20, 12, 0, 45).getTime();
  const context = {
    pl: {}, teacherState: { status: 'teacher', role: 'teacher' },
    AuthCore: require('../auth-core.js'),
    $(selector) { return elements[selector] || null; },
    store: { serverNow() { return serverMillis; } },
    serverNow() { throw new Error('store serverNow를 사용해야 한다'); }
  };
  loadStageFunctions(['plOpenClassPlanDialog'], context);

  assert.equal(context.plOpenClassPlanDialog(), true);
  assert.equal(start.value, '2026-08-20T12:00');
  assert.equal(end.value, '2026-08-20T12:50');
  assert.equal(dialog.opened, true);
});

test('겹침 조회 실패는 현황 확인 불가를 표시하지만 로컬 확인 뒤 계획 진행을 허용한다', async () => {
  const warning = { textContent: '', className: '' };
  const ack = { checked: true };
  const dialog = { closeCalls: 0, close() { this.closeCalls += 1; } };
  const elements = {
    '#pl-plan-class-name': { value: ' 2학년 3반 ' },
    '#pl-plan-start': { value: '2026-08-20T10:00' },
    '#pl-plan-end': { value: '2026-08-20T10:50' },
    '#pl-plan-expected': { value: '35' },
    '#pl-plan-warning': warning,
    '#pl-plan-ack': ack,
    '#pl-plan-dialog': dialog
  };
  let starts = 0;
  const context = {
    pl: { setId: 'set-a', set: { title: '분수', author: '김교사' } },
    teacherState: {
      status: 'teacher', role: 'teacher', uid: 'teacher-a',
      email: 'Teacher@School.kr', displayName: '김교사'
    },
    teacherAuthVersion: 4,
    AuthCore: require('../auth-core.js'),
    ClassPlanningCore: require('../class-planning-core.js'),
    $(selector) { return elements[selector] || null; },
    store: {
      serverNow() { return new Date('2026-08-20T00:59:00Z').getTime(); },
      async listPublicPlans() { throw new Error('offline'); }
    },
    rid() { return 'plan-stable'; },
    lsSet() {},
    plStartSession() { starts += 1; return Promise.resolve(true); },
    alert() {}
  };
  loadStageFunctions(['plReviewClassPlan', 'plConfirmClassPlan'], context);

  assert.equal(await context.plReviewClassPlan(), true);
  assert.match(warning.textContent, /현황 확인 불가.*수업은 진행할 수 있습니다/);
  ack.checked = true;
  assert.equal(await context.plConfirmClassPlan(), true);
  assert.equal(starts, 1);
  assert.equal(context.pl.reviewedClassPlan.privatePlan.warningLevel, 'caution');
  assert.equal(context.pl.reviewedClassPlan.privatePlan.warningAcknowledgedAt,
    new Date('2026-08-20T00:59:00Z').getTime());
  assert.equal(dialog.closeCalls, 1);
});

test('계획 저장 성공 전에는 allocation을 시작하지 않고 성공 뒤 한 세션에 한 번만 attach한다', async () => {
  const events = [];
  let finishCreate;
  const context = {
    ...pendingAllocationTestContext(),
    pl: {
      setId: 'set1', set: { title: '세트', author: '교사', videos: [] }, flatQuestions: [],
      reviewedClassPlan: { privatePlan: { planId: 'plan-a', revision: 1 }, publicPlan: { planId: 'plan-a' } }
    },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    teacherAuthVersion: 7,
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    $() { return { value: '2학년 3반' }; }, lsSet() {},
    rid(length) { return length === 12 ? 'SESSION12345' : length === 24 ? 'allocation-token-123456' : 'CODE12'; },
    SV_TS: SERVER_TIMESTAMP, normSet(value) { return value; }, imgCache: {},
    store: {
      createClassPlan() { events.push('create'); return new Promise(resolve => { finishCreate = resolve; }); },
      async getQuizSetSnapshot() { events.push('snapshot'); return { setSnapshot: context.pl.set, snapshotImages: {} }; },
      async startSession() { events.push('allocate'); return 'CODE12'; },
      async activateSessionAllocation() { events.push('activate'); return true; },
      async attachPlanToSession(planId, sessionId, owner) {
        events.push(['attach', planId, sessionId, owner.expectedRevision]);
        return { revision: 2 };
      }
    },
    renderPlayRun() { events.push('render'); }, alert() {}, console
  };
  loadStageFunctions(['plStartSessionHeartbeat', 'plStartSession'], context);

  const starting = context.plStartSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['create']);
  finishCreate({ revision: 1 });
  await starting;

  assert.deepEqual(events, [
    'create', 'snapshot', 'allocate', 'activate', ['attach', 'plan-a', 'SESSION12345', 1], 'render'
  ]);
  assert.equal(context.pl.classPlanId, 'plan-a');
  assert.equal(context.pl.classPlanSessionId, 'SESSION12345');
  assert.equal(context.pl.classPlanRevision, 2);
});

test('allocation 실패 재시도는 저장된 planned 계획과 동일 session identity를 재사용한다', async () => {
  let creates = 0, allocations = 0;
  const sessions = [];
  const context = {
    ...pendingAllocationTestContext(),
    pl: {
      setId: 'set1', set: { title: '세트', author: '교사', videos: [] }, flatQuestions: [],
      reviewedClassPlan: { privatePlan: { planId: 'plan-a', revision: 1 }, publicPlan: { planId: 'plan-a' } }
    },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    $() { return { value: '' }; }, lsSet() {},
    rid(length) { return length === 12 ? 'SESSION-STABLE' : length === 24 ? 'token-stable-123456789012' : 'CODE12'; },
    SV_TS: SERVER_TIMESTAMP, normSet(value) { return value; }, imgCache: {},
    store: {
      async createClassPlan() { creates += 1; return { revision: 1 }; },
      async getQuizSetSnapshot() { return { setSnapshot: context.pl.set, snapshotImages: {} }; },
      async startSession(sessionId) {
        sessions.push(sessionId);
        allocations += 1;
        if (allocations === 1) throw new Error('allocation failed');
        return 'CODE12';
      },
      async activateSessionAllocation() { return true; },
      async attachPlanToSession() { return { revision: 2 }; }
    },
    renderPlayRun() {}, alert() {}, console: { error() {} }
  };
  loadStageFunctions(['plStartSessionHeartbeat', 'plStartSession'], context);

  await context.plStartSession();
  assert.equal(context.pl.classPlanPersisted, true);
  assert.equal(context.pl.classPlanAttached, undefined);
  await context.plStartSession();

  assert.equal(creates, 1);
  assert.deepEqual(sessions, ['SESSION-STABLE', 'SESSION-STABLE']);
  assert.equal(context.pl.classPlanAttached, true);
});

test('계획 create 응답이 유실돼도 같은 plan ID exact retry 뒤 allocation을 계속한다', async () => {
  let creates = 0, allocations = 0;
  const context = {
    ...pendingAllocationTestContext(),
    pl: {
      setId: 'set1', set: { title: '세트', author: '교사', videos: [] }, flatQuestions: [],
      reviewedClassPlan: { privatePlan: { planId: 'plan-a', revision: 1 }, publicPlan: { planId: 'plan-a' } }
    },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    $() { return { value: '' }; }, lsSet() {},
    rid(length) { return length === 12 ? 'SESSION-STABLE' : length === 24 ? 'token-stable-123456789012' : 'CODE12'; },
    SV_TS: SERVER_TIMESTAMP, normSet(value) { return value; }, imgCache: {},
    store: {
      async createClassPlan(privatePlan) {
        creates += 1;
        assert.equal(privatePlan.planId, 'plan-a');
        if (creates === 1) throw new Error('commit response lost');
        return { planId: 'plan-a', revision: 1 };
      },
      async getQuizSetSnapshot() { return { setSnapshot: context.pl.set, snapshotImages: {} }; },
      async startSession() { allocations += 1; return 'CODE12'; },
      async activateSessionAllocation() { return true; },
      async attachPlanToSession() { return { revision: 2 }; }
    },
    renderPlayRun() {}, alert() {}, console: { error() {} }
  };
  loadStageFunctions(['plStartSessionHeartbeat', 'plStartSession'], context);

  await context.plStartSession();
  assert.equal(allocations, 0);
  await context.plStartSession();

  assert.equal(creates, 2);
  assert.equal(allocations, 1);
  assert.equal(context.pl.classPlanAttached, true);
});

test('attach 응답 실패 재시도는 활성 allocation을 덮어쓰지 않고 같은 identity로 attach만 재시도한다', async () => {
  let allocations = 0, attachAttempts = 0, renders = 0;
  const attaches = [];
  const records = new Map();
  const context = {
    ...pendingAllocationTestContext({
      pendingAllocationRemember(record) { records.set(record.sessionId, clone(record)); return true; },
      pendingAllocationPatch(sessionId, patch) {
        records.set(sessionId, { ...records.get(sessionId), ...clone(patch) }); return true;
      },
      pendingAllocationRemove(sessionId) { records.delete(sessionId); return true; }
    }),
    pl: {
      setId: 'set1', set: { title: '세트', author: '교사', videos: [] }, flatQuestions: [],
      reviewedClassPlan: { privatePlan: { planId: 'plan-a', revision: 1 }, publicPlan: { planId: 'plan-a' } }
    },
    teacherState: {
      status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
    },
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    $() { return { value: '' }; }, lsSet() {},
    rid(length) { return length === 12 ? 'SESSION-STABLE' : length === 24 ? 'token-stable-123456789012' : 'CODE12'; },
    SV_TS: SERVER_TIMESTAMP, normSet(value) { return value; }, imgCache: {},
    store: {
      async createClassPlan() { return { revision: 1 }; },
      async getQuizSetSnapshot() { return { setSnapshot: context.pl.set, snapshotImages: {} }; },
      async startSession() { allocations += 1; return 'CODE12'; },
      async activateSessionAllocation() { return true; },
      async attachPlanToSession(planId, sessionId, owner) {
        attaches.push([planId, sessionId, owner.expectedRevision]);
        attachAttempts += 1;
        if (attachAttempts === 1) throw new Error('ambiguous attach response');
        return { revision: 2 };
      },
      async abortSessionAllocation() { return true; }
    },
    renderPlayRun() { renders += 1; }, alert() {}, toast() {}, console: { error() {} }
  };
  loadStageFunctions(['plStartSessionHeartbeat', 'plStartSession'], context);

  await context.plStartSession();
  assert.equal(context.pl.classPlanAllocationActivated, true);
  assert.equal(renders, 0);
  assert.deepEqual({
    planId: records.get('SESSION-STABLE').planId,
    planRevision: records.get('SESSION-STABLE').planRevision,
    setId: records.get('SESSION-STABLE').setId,
    attachStatus: records.get('SESSION-STABLE').attachStatus
  }, { planId: 'plan-a', planRevision: 1, setId: 'set1', attachStatus: 'attaching' });
  await context.plStartSession();

  assert.equal(allocations, 1);
  assert.deepEqual(attaches, [
    ['plan-a', 'SESSION-STABLE', 1], ['plan-a', 'SESSION-STABLE', 1]
  ]);
  assert.equal(context.pl.classPlanAttached, true);
  assert.equal(renders, 1);
  assert.equal(records.get('SESSION-STABLE').attachStatus, 'attached');
  assert.equal(records.get('SESSION-STABLE').planRevision, 2);
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
    SESSION_HEARTBEAT_MS: 30_000,
    SESSION_HEARTBEAT_RETRY_MS: 5_000,
    SESSION_ACTIVATION_LEASE_MS: 90_000,
    setTimeout(callback, ms) {
      assert.equal(ms, 30000);
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    every(ms, callback) {
      assert.equal(ms, 30000);
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
  const scheduledDelays = [];
  const state = { sessionId: 'session-a', code: 'CODE12' };
  const context = {
    pl: state,
    teacherState: clone(owner),
    teacherAuthVersion: 12,
    AuthCore: require('../auth-core.js'),
    SESSION_HEARTBEAT_MS: 30_000,
    SESSION_HEARTBEAT_RETRY_MS: 5_000,
    SESSION_ACTIVATION_LEASE_MS: 90_000,
    setTimeout(callback, ms) {
      scheduledDelays.push(ms);
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
  // 실패했을 때는 다음 주기(30초)를 기다리지 않고 곧바로 다시 시도해야
  // lease가 비는 동안 학생 제출이 거부되는 구간이 생기지 않는다.
  assert.deepEqual(scheduledDelays, [30_000, 5_000]);

  cleanups[0]();
  assert.equal(timers.has(2), false);
});

test('heartbeat는 lease 90초를 여유 있게 덮는 30초 간격을 사용한다', () => {
  const owner = {
    status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher'
  };
  let delay = 0;
  const state = { sessionId: 'session-a', code: 'CODE12' };
  const context = {
    pl: state,
    teacherState: clone(owner),
    teacherAuthVersion: 1,
    AuthCore: require('../auth-core.js'),
    SESSION_HEARTBEAT_MS: 30_000,
    setTimeout(callback, ms) { delay = ms; return 1; },
    clearTimeout() {},
    onCleanup() {},
    store: { async renewSessionActivationLease() { return true; } },
    toast() {}
  };
  loadStageFunctions(['plStartSessionHeartbeat'], context);

  context.plStartSessionHeartbeat(state, owner, 1, 'allocation-token-123456');
  assert.equal(delay, 30_000);
});

test('Firestore 무료 사용량 초과는 원인과 재시도 안내를 보여준다', () => {
  const context = {};
  loadStageFunctions(['plSessionStartErrorMessage'], context);

  assert.match(
    context.plSessionStartErrorMessage({ code: 'resource-exhausted', message: 'Quota exceeded.' }),
    /Firestore 무료 사용량[\s\S]*자동으로 초기화[\s\S]*다시 시도/
  );
  assert.equal(
    context.plSessionStartErrorMessage(new Error('network down')),
    '반 시작 실패: network down'
  );
});

test('문항 미리보기 HTML은 현재 편집값의 질문과 보기를 즉시 반영한다', () => {
  const context = {
    esc(value) { return String(value).replace(/</g, '&lt;'); },
    qType(q) { return q.type || 'choice'; },
    QTYPES: { choice: '객관식 — 하나 고르기' },
    LETTERS: ['①', '②', '③', '④']
  };
  loadStageFunctions(['mkQuestionPreviewHtml'], context);

  const html = context.mkQuestionPreviewHtml({
    type: 'choice', text: '지금 입력한 질문?', choices: ['첫째', '둘째'], explain: '해설'
  }, 3);
  assert.match(html, /문항 3/);
  assert.match(html, /지금 입력한 질문\?/);
  assert.match(html, /①[\s\S]*첫째/);
  assert.match(html, /②[\s\S]*둘째/);
});

test('흐름형 문항 미리보기는 3초 전 영상을 재생하고 문항 시각에 멈춘다', () => {
  const calls = [];
  let currentTime = 7;
  const player = {
    seekTo(value) { calls.push(['seek', value]); currentTime = value; },
    playVideo() { calls.push(['play']); },
    pauseVideo() { calls.push(['pause']); },
    getCurrentTime() { return currentTime; },
    getPlayerState() { return 2; }
  };
  const context = {
    mk: { activeVideo: 0, videos: [{ videoId: 'video', startSec: 0, questions: [
      { type: 'choice', t: 10, text: '질문', choices: ['가', '나'], answer: 1 }
    ] }] },
    mkPlayer: player,
    mkQuestionPreviewState: null,
    mkQuestionPreviewTimer: null,
    mkQuestionPreviewRequest: 0,
    QuizPreviewCore: require('../quiz-preview-core.js'),
    Date: { now() { return 1000; } },
    document: { getElementById() { return null; } },
    mkCloseQuestionPreview() {},
    mkPreviewRender() { calls.push(['render']); return true; },
    renderMake() {}, toast() {},
    setTimeout(callback) { callback(); return 1; },
    setInterval() { return 2; }, clearInterval() {}
  };
  loadStageFunctions(['mkOpenQuestionPreview', 'mkPreviewTick'], context);

  assert.equal(context.mkOpenQuestionPreview(0, 0), true);
  assert.deepEqual(calls.slice(0, 2), [['seek', 7], ['play']]);
  currentTime = 10;
  assert.equal(context.mkPreviewTick(), true);
  assert.equal(context.mkQuestionPreviewState.phase, 'question');
  assert.deepEqual(calls.slice(-2), [['pause'], ['render']]);
});

test('흐름형 문항 미리보기는 비동기 seek가 3초 전 위치에 도착하기 전에 퀴즈를 열지 않는다', () => {
  const calls = [];
  let currentTime = 315;
  let now = 1000;
  const player = {
    seekTo(value) { calls.push(['seek', value]); },
    playVideo() { calls.push(['play']); },
    pauseVideo() { calls.push(['pause']); },
    getCurrentTime() { return currentTime; },
    getPlayerState() { return 2; }
  };
  const context = {
    mk: { activeVideo: 0, videos: [{ videoId: 'video', startSec: 0, questions: [
      { type: 'choice', t: 308, text: '질문', choices: ['가', '나'], answer: 1 }
    ] }] },
    mkPlayer: player,
    mkQuestionPreviewState: null,
    mkQuestionPreviewTimer: null,
    mkQuestionPreviewRequest: 0,
    QuizPreviewCore: require('../quiz-preview-core.js'),
    Date: { now() { return now; } },
    document: { getElementById() { return null; } },
    mkCloseQuestionPreview() {},
    mkPreviewRender() { calls.push(['render']); return true; },
    renderMake() {}, toast(message) { calls.push(['toast', message]); },
    setTimeout(callback) { callback(); return 1; },
    setInterval() { return 2; }, clearInterval() {}
  };
  loadStageFunctions(['mkOpenQuestionPreview', 'mkPreviewTick'], context);

  assert.equal(context.mkOpenQuestionPreview(0, 0), true);
  assert.deepEqual(calls.slice(0, 2), [['seek', 305], ['play']]);
  assert.equal(context.mkQuestionPreviewState.phase, 'video');
  assert.equal(context.mkPreviewTick(), false);
  assert.equal(context.mkQuestionPreviewState.phase, 'video');
  assert.equal(calls.some(call => call[0] === 'render'), false);

  currentTime = 305.2;
  now = 1400;
  assert.equal(context.mkPreviewTick(), false);
  assert.equal(context.mkQuestionPreviewState.phase, 'video');

  currentTime = 308;
  now = 4400;
  assert.equal(context.mkPreviewTick(), true);
  assert.equal(context.mkQuestionPreviewState.phase, 'question');
  assert.deepEqual(calls.slice(-2), [['pause'], ['render']]);
});

test('흐름형 문항 미리보기는 3초 전 위치 이동이 지연되면 안내하고 종료한다', () => {
  const calls = [];
  const context = {
    mkQuestionPreviewState: {
      phase: 'video', startAt: 305, targetTime: 308,
      seekPending: true, seekRequestedAt: 1000,
      player: { getCurrentTime() { return 315; } }
    },
    mkQuestionPreviewTimer: 2,
    Date: { now() { return 8001; } },
    QuizPreviewCore: require('../quiz-preview-core.js'),
    toast(message) { calls.push(['toast', message]); },
    mkCloseQuestionPreview() { calls.push(['close']); }
  };
  loadStageFunctions(['mkPreviewTick'], context);

  assert.equal(context.mkPreviewTick(), false);
  assert.match(calls[0][1], /3초 전 위치로 이동하지 못했습니다/);
  assert.deepEqual(calls[1], ['close']);
});

test('흐름형 문항 미리보기는 현재 시간 읽기 실패를 seek 완료로 오인하지 않는다', () => {
  const calls = [];
  let now = 1000;
  const context = {
    mkQuestionPreviewState: {
      phase: 'video', startAt: 305, targetTime: 308,
      seekPending: true, seekRequestedAt: 1000,
      player: { getCurrentTime() { throw new Error('player not ready'); } }
    },
    mkQuestionPreviewTimer: 2,
    Date: { now() { return now; } },
    QuizPreviewCore: require('../quiz-preview-core.js'),
    toast(message) { calls.push(['toast', message]); },
    mkCloseQuestionPreview() { calls.push(['close']); }
  };
  loadStageFunctions(['mkPreviewTick'], context);

  assert.equal(context.mkPreviewTick(), false);
  assert.equal(context.mkQuestionPreviewState.seekPending, true);
  assert.deepEqual(calls, []);

  now = 8001;
  assert.equal(context.mkPreviewTick(), false);
  assert.match(calls[0][1], /3초 전 위치로 이동하지 못했습니다/);
  assert.deepEqual(calls[1], ['close']);
});

test('흐름형 문항 미리보기는 seek 완료 후 시간 읽기가 실패해도 재생 제한 시간에 문항을 연다', () => {
  const calls = [];
  const context = {
    mkQuestionPreviewState: {
      phase: 'video', startAt: 305, targetTime: 308,
      seekPending: false, startedAt: 1000,
      player: {
        getCurrentTime() { throw new Error('player clock unavailable'); },
        pauseVideo() { calls.push(['pause']); }
      }
    },
    mkQuestionPreviewTimer: 2,
    Date: { now() { return 7001; } },
    QuizPreviewCore: require('../quiz-preview-core.js'),
    clearInterval() { calls.push(['clear']); },
    mkPreviewRender() { calls.push(['render']); return true; }
  };
  loadStageFunctions(['mkPreviewTick'], context);

  assert.equal(context.mkPreviewTick(), true);
  assert.equal(context.mkQuestionPreviewState.phase, 'question');
  assert.deepEqual(calls.slice(-2), [['pause'], ['render']]);
});

test('흐름형 문항 미리보기는 제출을 채점하고 해설 뒤 계속 재생한다', () => {
  const calls = [];
  const context = {
    mkQuestionPreviewState: Object.assign(
      require('../quiz-preview-core.js').select(
        require('../quiz-preview-core.js').advance(
          require('../quiz-preview-core.js').create({
            type: 'choice', t: 10, answer: 1, explain: '정답 해설'
          }), 10
        ), 1
      ),
      { player: { seekTo(value) { calls.push(['seek', value]); }, playVideo() { calls.push(['play']); } } }
    ),
    mkQuestionPreviewTimer: null,
    QuizPreviewCore: require('../quiz-preview-core.js'),
    document: { getElementById() { return null; } },
    mkPreviewRender() { calls.push(['render']); return true; },
    clearInterval() {}, toast() {}
  };
  loadStageFunctions(['mkPreviewSubmit', 'mkPreviewContinue'], context);

  assert.equal(context.mkPreviewSubmit(), true);
  assert.equal(context.mkQuestionPreviewState.phase, 'result');
  assert.equal(context.mkQuestionPreviewState.correct, true);
  assert.equal(context.mkQuestionPreviewState.explanation, '정답 해설');
  assert.equal(context.mkPreviewContinue(), true);
  assert.deepEqual(calls.slice(-2), [['seek', 10.05], ['play']]);
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
        answer: 1, explain: '정답 해설', imgUp: true, explainImgUp: true
      }],
      set: { settings: { autoPause: true, revealMode: 'manual' } }
    },
    SV_TS: serverTimestamp,
    limitFor() { return 20; },
    loadQuestionImage(setId, key, sessionId) {
      assert.equal(setId, undefined);
      assert.equal(sessionId, 'session-a');
      return Promise.resolve(key === 'v1q1e'
        ? 'data:image/jpeg;base64,explanation'
        : 'data:image/jpeg;base64,current');
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
  vm.runInNewContext(extractFunction(html, 'plExplanationImage'), context);
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
      answer: 1, explain: '정답 해설', explainImage: 'data:image/jpeg;base64,explanation'
    }]
  ]);
});

test('미리보기는 교사용과 학생 모바일 카드를 한 화면에 같은 답안 상태로 렌더링한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dialog = {
    innerHTML: '',
    setAttribute() {},
    querySelector() { return null; }
  };
  const context = {
    mkQuestionPreviewState: {
      phase: 'question', number: 1, answer: 1,
      question: { type: 'choice', text: '질문', choices: ['가', '나'], answer: 0 }
    },
    document: {
      getElementById() { return dialog; },
      createElement() { throw new Error('dialog already exists'); },
      body: { appendChild() {} }
    },
    QuizPreviewCore: require('../quiz-preview-core.js'),
    LETTERS: ['①', '②'],
    esc(value) { return String(value); },
    mkPreviewChoiceIsCorrect(question, index) { return Number(question.answer) === index; },
    mkCloseQuestionPreview() {}
  };
  vm.runInNewContext(extractFunction(html, 'mkPreviewRender'), context);

  assert.equal(context.mkPreviewRender(), true);
  assert.match(dialog.innerHTML, /mk-preview-grid/);
  assert.match(dialog.innerHTML, /교사용 화면/);
  assert.match(dialog.innerHTML, /학생 모바일 화면/);
  assert.match(dialog.innerHTML, /mk-question-preview-card teacher/);
  assert.match(dialog.innerHTML, /mk-question-preview-card mobile/);
  assert.equal((dialog.innerHTML.match(/preview-choice selected/g) || []).length, 2);
  assert.doesNotMatch(dialog.innerHTML, /mk-preview-modes|교사용 크게 보기|학생 모바일 보기/);
});

test('한쪽 미리보기의 서술형 입력은 반대쪽 입력과 같은 답안 상태로 동기화된다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const teacherInput = { value: '새 답' };
  const studentInput = { value: '' };
  const context = {
    mkQuestionPreviewState: { phase: 'question', question: { type: 'long' }, answer: '' },
    QuizPreviewCore: require('../quiz-preview-core.js'),
    document: { querySelectorAll() { return [teacherInput, studentInput]; } }
  };
  vm.runInNewContext(extractFunction(html, 'mkPreviewSetText'), context);

  assert.equal(context.mkPreviewSetText('새 답', teacherInput), true);
  assert.equal(context.mkQuestionPreviewState.answer, '새 답');
  assert.equal(studentInput.value, '새 답');
});

test('문항 이미지는 저장된 그림이 있어도 기본 접힘이고 펼친 뒤에만 미리보기를 렌더링한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = { esc(value) { return String(value); }, Math };
  vm.runInNewContext(extractFunction(html, 'mkImageField'), context);
  const question = { _img: 'data:image/jpeg;base64,abc', imgUrl: '', imgUp: true, _imgOpen: false };

  const collapsed = context.mkImageField(question, 0, 0);
  assert.match(collapsed, /이미지 보기·변경/);
  assert.doesNotMatch(collapsed, /<img/);

  question._imgOpen = true;
  const expanded = context.mkImageField(question, 0, 0);
  assert.match(expanded, /문항 이미지/);
  assert.match(expanded, /접기/);
});

test('표시된 문제·해설 이미지는 실제 현재 주소와 설명으로 공통 확대창을 연다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [];
  const context = {
    document: { fullscreenElement: null, getElementById() { return null; } },
    imageLightbox: { open(src, alt) { calls.push({ src, alt }); return true; } }
  };
  vm.runInNewContext(extractFunction(html, 'openImageLightbox'), context);

  const opened = context.openImageLightbox({
    currentSrc: 'https://cdn.example.com/rendered.jpg',
    src: 'https://example.com/fallback.jpg',
    alt: '해설 이미지'
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, [{ src: 'https://cdn.example.com/rendered.jpg', alt: '해설 이미지' }]);
});

test('네이티브 전체화면에서는 확대창을 전체화면 요소 안에 배치한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const root = {};
  const fullscreen = { appended: null, appendChild(node) { this.appended = node; } };
  const context = {
    document: {
      fullscreenElement: fullscreen,
      getElementById(id) { return id === 'image-lightbox' ? root : null; }
    },
    imageLightbox: { open() { return true; } }
  };
  vm.runInNewContext(extractFunction(html, 'openImageLightbox'), context);

  assert.equal(context.openImageLightbox({ src: 'image.jpg', alt: '문항 이미지' }), true);
  assert.equal(fullscreen.appended, root);
});

test('확대창 상태가 열리면 이미지와 설명을 표시하고 닫히면 원본을 비운다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const elements = {
    'image-lightbox': { hidden: true },
    'image-lightbox-img': { src: '', alt: '' },
    'image-lightbox-caption': { textContent: '' },
    'image-lightbox-close': { focusCalls: 0, focus() { this.focusCalls += 1; } }
  };
  const body = { appended: null, appendChild(node) { this.appended = node; } };
  const returnFocus = { calls: 0, focus() { this.calls += 1; } };
  const context = {
    imageLightboxReturnFocus: returnFocus,
    document: { body, getElementById(id) { return elements[id]; } }
  };
  vm.runInNewContext(extractFunction(html, 'renderImageLightbox'), context);

  context.renderImageLightbox({ open: true, src: 'data:image/png;base64,abc', alt: '문항 이미지' });
  assert.equal(elements['image-lightbox'].hidden, false);
  assert.equal(elements['image-lightbox-img'].src, 'data:image/png;base64,abc');
  assert.equal(elements['image-lightbox-img'].alt, '문항 이미지');
  assert.equal(elements['image-lightbox-caption'].textContent, '문항 이미지');
  assert.equal(elements['image-lightbox-close'].focusCalls, 1);

  context.renderImageLightbox({ open: false, src: '', alt: '' });
  assert.equal(elements['image-lightbox'].hidden, true);
  assert.equal(elements['image-lightbox-img'].src, '');
  assert.equal(body.appended, elements['image-lightbox']);
  assert.equal(returnFocus.calls, 1);
  assert.equal(context.imageLightboxReturnFocus, null);
});

test('학생 문항 view는 공개 전 해설 이미지를 숨기고 공개 뒤에만 합친다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {};
  vm.runInNewContext(extractFunction(html, 'studentQuestionView'), context);
  const base = { q: 0, publicQuestion: { number: 1, total: 1, text: 'Q', choices: [] } };

  assert.equal(context.studentQuestionView({ ...base, revealed: false }).question.explainImage, undefined);
  assert.equal(context.studentQuestionView({ ...base, revealed: true,
    publicAnswer: { explain: '해설', explainImage: 'https://example.com/e.png' }
  }).question.explainImage, 'https://example.com/e.png');
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

test('session 종료 실패는 class plan ended를 만들거나 이동하지 않는다', async () => {
  let finishes = 0, routes = 0;
  const context = {
    pendingAllocationRemove() { return true; },
    pl: {
      sessionId: 'session-a', classPlanId: 'plan-a', classPlanRevision: 2,
      classPlanAttached: true
    },
    confirm() { return true; },
    document: {
      fullscreenElement: null,
      getElementById() { return null; },
      body: { classList: { remove() {} } }
    },
    store: {
      async endSession() { throw new Error('end failed'); },
      async finishClassPlan() { finishes += 1; }
    },
    toast() {}, go() { routes += 1; }
  };
  loadStageFunctions(['plResetStageFullscreenUI', 'plExitStageFullscreen', 'plEndSession'], context);

  await assert.rejects(context.plEndSession(), /end failed/);
  assert.equal(finishes, 0);
  assert.equal(routes, 0);
});

test('plan finish 실패 재시도는 동일 plan/session/revision으로 끝낸 뒤에만 이동한다', async () => {
  const finishes = [];
  let attempts = 0, routes = 0;
  const context = {
    pendingAllocationRemove() { return true; },
    pl: {
      sessionId: 'session-a', classPlanId: 'plan-a', classPlanRevision: 2,
      classPlanAttached: true
    },
    confirm() { return true; },
    document: {
      fullscreenElement: null,
      getElementById() { return null; },
      body: { classList: { remove() {} } }
    },
    store: {
      async endSession() {},
      async finishClassPlan(planId, sessionId, actuals) {
        finishes.push([planId, sessionId, actuals.expectedRevision]);
        attempts += 1;
        if (attempts === 1) throw new Error('finish failed');
        return { revision: 3 };
      }
    },
    toast() {}, go() { routes += 1; }
  };
  loadStageFunctions(['plResetStageFullscreenUI', 'plExitStageFullscreen', 'plEndSession'], context);

  await assert.rejects(context.plEndSession(), /finish failed/);
  assert.equal(routes, 0);
  await context.plEndSession();

  assert.deepEqual(finishes, [
    ['plan-a', 'session-a', 2], ['plan-a', 'session-a', 2]
  ]);
  assert.equal(context.pl.classPlanRevision, 3);
  assert.equal(routes, 1);
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
  assert.deepEqual([...windowListeners.keys()].sort(), ['orientationchange', 'resize']);
  assert.deepEqual(removed.sort(), ['fullscreenchange', 'keydown', 'orientationchange', 'resize']);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
  assert.equal(context.pl, null);
});

test('학생 목록 렌더링은 열린 QR 버블의 참여 수도 함께 갱신한다', () => {
  let rendered = 0;
  const ctx = loadStageFunctions(['plRoster', 'plRenderStudents'], {
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
  assert.match(appended[0].innerHTML, /🏆 순위/);
  assert.doesNotMatch(appended[0].innerHTML, /대시보드|href="#\/live\//);
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
  assert.match(html, /#pl-stage:fullscreen #pl-quiz-timeline,[\s\S]*?width:\s*var\(--pl-player-width\)/);
  assert.match(html, /#pl-stage:fullscreen \.player-box,[\s\S]*aspect-ratio:\s*16\s*\/\s*9[^}]*flex:\s*none/);
  assert.match(html, /#pl-stage\.quiz-open \.player-box\s*\{[^}]*filter:\s*brightness\(\.42\)/s);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open\s+\.player-box\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open\s+\.player-box\s*\{[^}]*width:/s);
  assert.match(html, /#pl-stage\.quiz-open #overlay\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*top:\s*var\(--quiz-center-y\)[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.match(html, /#pl-stage #overlay\s*\{[^}]*width:\s*var\(--quiz-max-w\)[^}]*max-height:\s*var\(--quiz-max-h\)/s);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open #overlay\s*\{[^}]*left:\s*53vw/s);
});

test('overlay geometry는 작은 stage의 타임라인 여백과 넓은 화면의 중앙 최대 폭을 함께 지킨다', () => {
  const stageVars = new Map();
  const stage = {
    getBoundingClientRect() { return { width: 1024, height: 640 }; },
    style: {
      setProperty(name, value) { stageVars.set(name, value); },
      removeProperty(name) { stageVars.delete(name); }
    },
    classList: { remove() {} }
  };
  const bodyClasses = new Set(['stage-fallback-open']);
  const ctx = loadStageFunctions([
    'plStagePlayerGeometry', 'plLayoutMode', 'plStageUsableQuizRect', 'plStageTimelineSafeBottom',
    'plApplyStageLayout', 'plClearStageLayout',
    'plResetStageFullscreenUI'
  ], {
    pl: { isStageFullscreen: true, stageFallback: true },
    window: { innerWidth: 1024, innerHeight: 640 },
    document: {
      fullscreenElement: null,
      getElementById(id) { return id === 'pl-stage' ? stage : null; },
      body: { classList: { remove(name) { bodyClasses.delete(name); } } }
    }
  });

  const compact = ctx.plLayoutMode({ width: 1024, height: 640 });
  const wide = ctx.plLayoutMode({ width: 1920, height: 1080 });
  assert.equal(compact.compact, true);
  assert.equal(compact.overlayMaxWidth, 920);
  assert.equal(compact.overlayMaxHeight, 512);
  assert.equal(wide.compact, false);
  assert.equal(wide.overlayMaxWidth, 920);
  assert.equal(wide.overlayMaxHeight, 952);

  ctx.plApplyStageLayout();
  assert.equal(stageVars.get('--quiz-max-w'), '920px');
  assert.equal(stageVars.get('--quiz-max-h'), '512px');
  assert.equal(stageVars.get('--pl-layout-compact'), '1');

  ctx.plResetStageFullscreenUI();
  assert.equal(stageVars.size, 0);
  assert.equal(bodyClasses.has('stage-fallback-open'), false);
});

test('초소형 stage와 실제 타임라인 높이도 퀴즈 안전 영역 밖으로 넘지 않는다', () => {
  const stageVars = new Map();
  let timelineHeight = 180;
  const stage = {
    getBoundingClientRect() { return { width: 1024, height: 640 }; },
    style: { setProperty(name, value) { stageVars.set(name, value); } }
  };
  const timeline = { getBoundingClientRect() { return { height: timelineHeight }; } };
  const ctx = loadStageFunctions([
    'plStagePlayerGeometry', 'plLayoutMode', 'plStageUsableQuizRect',
    'plStageTimelineSafeBottom', 'plApplyStageLayout'
  ], {
    window: { innerWidth: 1024, innerHeight: 640 },
    document: {
      getElementById(id) {
        return id === 'pl-stage' ? stage : id === 'pl-quiz-timeline' ? timeline : null;
      }
    }
  });

  for (const rect of [{ width: 240, height: 200 }, { width: 320, height: 240 }]) {
    const layout = ctx.plLayoutMode(rect);
    assert.ok(layout.overlayMaxWidth <= rect.width);
    assert.ok(layout.overlayMaxHeight <= rect.height - layout.safeBottom);
    assert.ok(layout.overlayMaxHeight >= 0);
  }

  ctx.plApplyStageLayout();
  assert.equal(stageVars.get('--quiz-safe-bottom'), '212px');
  assert.equal(stageVars.get('--quiz-max-h'), '428px');

  timelineHeight = 0;
  ctx.plApplyStageLayout();
  assert.equal(stageVars.get('--quiz-safe-bottom'), '128px');
  assert.equal(stageVars.get('--quiz-max-h'), '512px');
});

test('퀴즈는 타임라인 실제 top 앞의 usable rect 중앙에 놓이고 겹치지 않는다', () => {
  const ctx = loadStageFunctions(['plLayoutMode', 'plStageUsableQuizRect'], {});
  const stage = { top: 100, left: 20, width: 1024, height: 640 };
  const timeline = { top: 560, left: 20, width: 1024, height: 80 };
  const usable = ctx.plStageUsableQuizRect(stage, timeline);
  const layout = ctx.plLayoutMode({
    width: stage.width, height: stage.height,
    usableTop: usable.top, usableBottom: usable.bottom
  });
  const overlay = {
    top: layout.overlayCenterY - layout.overlayMaxHeight / 2,
    bottom: layout.overlayCenterY + layout.overlayMaxHeight / 2
  };

  assert.equal(usable.top, 16);
  assert.equal(usable.bottom, 448);
  assert.equal(layout.overlayMaxHeight, usable.height);
  assert.equal(overlay.top, usable.top);
  assert.equal(overlay.bottom, usable.bottom);
  assert.ok(overlay.bottom <= timeline.top - stage.top - 12);
});

test('240x200 ultra-small usable rect은 actions의 클릭 가능한 행을 남긴다', () => {
  const ctx = loadStageFunctions(['plLayoutMode', 'plStageUsableQuizRect'], {});
  const stage = { top: 0, left: 0, width: 240, height: 200 };
  const timeline = { top: 150, left: 0, width: 240, height: 50 };
  const usable = ctx.plStageUsableQuizRect(stage, timeline);
  const layout = ctx.plLayoutMode({
    width: stage.width, height: stage.height,
    usableTop: usable.top, usableBottom: usable.bottom
  });

  assert.equal(layout.overlayMaxHeight, usable.height);
  assert.ok(layout.actionVisibleHeight >= Math.min(56, usable.height));
  assert.ok(layout.actionVisibleHeight > 0);
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
  assert.equal(calls[0], 'play');
  assert.equal(calls[1], 'freeze');
  assert.deepEqual(clone(calls[3]), ['live', 'session-a', { q: 0, openedAt: undefined }]);
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
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plEffectiveEnd', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick', 'plJumpTo'], {
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
      if (selector === '#ov-timer') return timer;
      if (selector === '#ov-timer-n') return timerNumber;
      return null;
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

test('교사 타이머는 제출 보호 시간도 위 타이머 한 곳에서만 안내한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let now = 12_100;
  const live = {
    q: 0, openedAt: 10_000, revealed: true, limitSec: 2,
    submitGraceUntil: 14_000, liveToken: 'live-q0'
  };
  const fill = { style: {} };
  const timer = { style: {}, classList: { toggle() {} }, querySelector() { return fill; } };
  const timerNumber = { textContent: '' };
  const closeButton = { disabled: false, textContent: '', style: {} };
  const overlay = {
    querySelector(selector) {
      if (selector === '#ov-timer') return timer;
      if (selector === '#ov-timer-n') return timerNumber;
      if (selector === '#ov-close') return closeButton;
      return null;
    }
  };
  const context = {
    pl: { live, liveGeneration: 1, uiRevealed: true, closeError: '' },
    serverNow() { return now; }, document: { getElementById() { return overlay; } },
    plRevealed() { return true; }, plRenderOverlayCounts() {}, plRenderOverlay() {},
    FirestoreCore: core
  };
  vm.runInNewContext(extractFunction(html, 'plTimerTick'), context);

  context.plTimerTick();
  assert.equal(closeButton.disabled, true);
  assert.equal(closeButton.style.display, 'none');
  assert.equal(timerNumber.textContent, '제출 정리 중… 2초');

  now = 14_000;
  context.plTimerTick();
  assert.equal(closeButton.disabled, false);
  assert.equal(closeButton.textContent, '▶ 계속 재생');
});

test('종료 저장 중 숨긴 퀴즈 overlay는 live 구독 렌더가 다시 만들지 않는다', () => {
  let closed = 0;
  const context = {
    pl: {
      live: { q: 0 },
      closeFlight: { questionIndex: 0, overlayHidden: true }
    },
    plSetQuizOpen(open) { if (!open) closed += 1; },
    plRenderQList() {},
    document: { getElementById() { return null; } }
  };
  loadStageFunctions(['plRenderOverlay'], context);

  context.plRenderOverlay();
  assert.equal(closed, 1);
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
  vm.runInNewContext(extractFunction(html, 'stJoinRetryable'), context);
  vm.runInNewContext(extractFunction(html, 'stJoinWithRetry'), context);
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

test('a verified password session remains eligible for the protected allowance probe', async () => {
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

  assert.equal(context.teacherUser.uid, 'password-user');
  assert.equal(context.teacherState.status, 'teacher');
  assert.equal(context.clockUserId, '');
  assert.equal(context.clockPromise, null);
  assert.equal(context.clockPromiseUid, '');
});

function teacherEmailAuthTestRuntime(overrides = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const passwordInputs = [{ value: '' }, { value: '' }];
  let focusedSelector = '';
  const dialog = {
    open: false,
    innerHTML: '',
    showModal() { this.open = true; },
    close() { this.open = false; },
    removeAttribute(name) { if (name === 'open') this.open = false; },
    querySelectorAll(selector) { return selector === 'input[type="password"]' ? passwordInputs : []; },
    querySelector(selector) {
      return { focus() { focusedSelector = selector; } };
    }
  };
  const context = {
    teacherAuthVersion: 3,
    teacherAuthDialogRevision: 0,
    teacherAuthDialogState: { mode: 'login', status: 'idle', email: '', message: '', error: '' },
    teacherEmailAuthUiEnabled: true,
    teacherEmailAuthRequests: {
      signup: { inFlight: null, cooldownUntil: 0 },
      resend: { inFlight: null, cooldownUntil: 0 },
      reset: { inFlight: null, cooldownUntil: 0 }
    },
    TeacherEmailAuthCore: require('../teacher-email-auth-core.js'),
    esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    document: {
      getElementById(id) { return id === 'teacher-auth-dialog' ? dialog : null; },
      querySelectorAll(selector) { return dialog.querySelectorAll(selector); }
    },
    firebase: { auth() { throw new Error('auth fake required'); } },
    applyTeacherUser() { throw new Error('apply fake required'); },
    console,
    ...overrides
  };
  loadStageFunctions([
    'teacherAuthDialogMarkup', 'renderTeacherAuthDialog', 'teacherEmailAuthFormValue',
    'teacherEmailAuthOperationIsCurrent', 'teacherEmailAuthRequestEntry',
    'beginTeacherEmailAuthRequest', 'finishTeacherEmailAuthRequest',
    'buildTeacherVerificationState', 'teacherVerificationStateIsCurrent',
    'clearTeacherAuthPasswords', 'invalidateTeacherAuthDialog', 'closeTeacherAuthDialog',
    'openTeacherAuthDialog', 'resumeTeacherEmailVerificationState', 'submitTeacherEmailSignup',
    'submitTeacherEmailLogin', 'sendTeacherVerificationEmail',
    'confirmTeacherEmailVerification', 'sendTeacherPasswordReset'
  ], context);
  return { context, dialog, passwordInputs, focusedSelector: () => focusedSelector };
}

function authForm(values) {
  return {
    preventDefault() {},
    currentTarget: {
      elements: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]))
    }
  };
}

test('email signup creates the user, updates the profile, sends verification, and does not show request UI yet', async () => {
  const calls = [];
  let teacherRequestRendered = false;
  const user = {
    uid: 'email-teacher', email: 'teacher@example.com',
    async updateProfile(profile) { calls.push('profile:' + profile.displayName); },
    async sendEmailVerification() { calls.push('verify'); }
  };
  const auth = {
    currentUser: user,
    async createUserWithEmailAndPassword(email, password) {
      assert.equal(email, 'teacher@example.com');
      assert.equal(password, '12345678');
      calls.push('create');
      return { user };
    }
  };
  const { context } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    screenTeacherRequest() { teacherRequestRendered = true; }
  });

  const event = authForm({
    displayName: ' 홍교사 ', email: 'Teacher@Example.com', password: '12345678'
  });
  const result = await context.submitTeacherEmailSignup(event);

  assert.deepEqual(calls, ['create', 'profile:홍교사', 'verify']);
  assert.equal(result.status, 'verification-sent');
  assert.equal(teacherRequestRendered, false);
  assert.match(context.teacherAuthDialogState.message, /인증/);
  assert.equal(event.currentTarget.elements.password.value, '');
});

test('post-create profile or verification failure keeps a bound recovery state and retries the missing step', async t => {
  for (const failureStage of ['profile', 'verification']) {
    await t.test(failureStage, async () => {
      const raw = 'backend internal detail must stay private';
      let profileCalls = 0;
      let verificationCalls = 0;
      const user = {
        uid: 'new-email-user', email: 'teacher@example.com', displayName: '',
        emailVerified: false, isAnonymous: false,
        async updateProfile(profile) {
          profileCalls += 1;
          if (failureStage === 'profile' && profileCalls === 1) throw new Error(raw);
          this.displayName = profile.displayName;
        },
        async sendEmailVerification() {
          verificationCalls += 1;
          if (failureStage === 'verification' && verificationCalls === 1) throw new Error(raw);
        }
      };
      const auth = {
        currentUser: null,
        async createUserWithEmailAndPassword() {
          this.currentUser = user;
          return { user };
        }
      };
      const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
      const event = authForm({
        displayName: '홍교사', email: 'teacher@example.com', password: '12345678'
      });

      const result = await context.submitTeacherEmailSignup(event);

      assert.equal(result.status, 'verification-recovery');
      assert.equal(result.message, '인증 처리에 실패했습니다. 다시 시도해 주세요.');
      assert.equal(context.teacherAuthDialogState.status, 'verification-sent');
      assert.equal(context.teacherAuthDialogState.uid, 'new-email-user');
      assert.equal(context.teacherAuthDialogState.authGeneration, context.teacherAuthVersion);
      assert.equal(context.teacherAuthDialogState.needsProfile, failureStage === 'profile');
      assert.doesNotMatch(context.teacherAuthDialogState.error, /backend internal/);
      assert.equal(event.currentTarget.elements.password.value, '');

      const retry = await context.sendTeacherVerificationEmail(authForm({ displayName: ' 홍교사 ' }));
      assert.equal(retry.status, 'verification-sent');
      assert.equal(profileCalls, failureStage === 'profile' ? 2 : 1);
      assert.equal(verificationCalls, failureStage === 'verification' ? 2 : 1);
      assert.equal(user.displayName, '홍교사');
      assert.equal(context.teacherAuthDialogState.needsProfile, false);
    });
  }
});

test('an observed unverified password user resumes a UID and generation bound verification dialog', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let verificationCalls = 0;
  const user = {
    uid: 'password-user', email: 'teacher@example.com', displayName: '홍교사',
    emailVerified: false, isAnonymous: false,
    async sendEmailVerification() { verificationCalls += 1; },
    async getIdTokenResult() {
      return { claims: { firebase: { sign_in_provider: 'password' } } };
    }
  };
  const auth = { currentUser: user };
  const { context, dialog } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    teacherUser: null,
    teacherAllowance: null,
    teacherState: require('../auth-core.js').teacherState(null, null),
    appliedTeacherState: require('../auth-core.js').teacherState(null, null),
    clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'),
    authReady: false,
    renderTeacherAuthArea() {},
    store: {}
  });
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);
  context.closeTeacherAuthDialog();

  const applied = await context.applyTeacherUser(user);

  assert.equal(applied, true);
  assert.equal(dialog.open, true);
  assert.equal(context.teacherAuthDialogState.status, 'verification-sent');
  assert.equal(context.teacherAuthDialogState.uid, 'password-user');
  assert.equal(context.teacherAuthDialogState.authGeneration, context.teacherAuthVersion);
  assert.equal(context.teacherAuthDialogState.needsProfile, false);
  assert.equal(verificationCalls, 0);
});

test('password relogin leaves an unverified user in recovery instead of closing the dialog', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const user = {
    uid: 'password-user', email: 'teacher@example.com', displayName: '',
    emailVerified: false, isAnonymous: false,
    async getIdTokenResult() {
      return { claims: { firebase: { sign_in_provider: 'password' } } };
    }
  };
  const auth = {
    currentUser: null,
    async signInWithEmailAndPassword() { this.currentUser = user; return { user }; }
  };
  const { context, dialog } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    teacherUser: null,
    teacherAllowance: null,
    teacherState: require('../auth-core.js').teacherState(null, null),
    appliedTeacherState: require('../auth-core.js').teacherState(null, null),
    clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'),
    authReady: false,
    renderTeacherAuthArea() {},
    store: {}
  });
  vm.runInNewContext(extractFunction(html, 'applyTeacherUser'), context);
  context.openTeacherAuthDialog('login');

  const result = await context.submitTeacherEmailLogin(authForm({
    email: 'teacher@example.com', password: '12345678'
  }));

  assert.equal(result.status, 'verification-required');
  assert.equal(dialog.open, true);
  assert.equal(context.teacherAuthDialogState.status, 'verification-sent');
  assert.equal(context.teacherAuthDialogState.needsProfile, true);
});

test('verification confirmation reloads and force-refreshes the token before applying the user', async () => {
  const calls = [];
  const user = {
    uid: 'email-teacher', email: 'teacher@example.com', emailVerified: false,
    async reload() { calls.push('reload'); this.emailVerified = true; },
    async getIdToken(forceRefresh) { calls.push('token:' + forceRefresh); }
  };
  const auth = { currentUser: user };
  const { context } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    async applyTeacherUser(applied) { assert.equal(applied, user); calls.push('apply'); }
  });
  context.teacherAuthDialogState = {
    mode: 'signup', status: 'verification-sent', uid: user.uid,
    authGeneration: context.teacherAuthVersion, email: user.email,
    displayName: '홍교사', needsProfile: false, message: '', error: ''
  };

  const result = await context.confirmTeacherEmailVerification();

  assert.deepEqual(calls, ['reload', 'token:true', 'apply']);
  assert.equal(result.status, 'verified');
});

test('password reset returns the same safe text for success and a missing account', async () => {
  const outcomes = [null, Object.assign(new Error('missing'), { code: 'auth/user-not-found' })];
  const messages = [];
  for (const outcome of outcomes) {
    const auth = {
      async sendPasswordResetEmail(email) {
        assert.equal(email, 'teacher@example.com');
        if (outcome) throw outcome;
      }
    };
    const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
    const result = await context.sendTeacherPasswordReset(authForm({ email: 'Teacher@Example.com' }));
    messages.push(result.message);
  }
  assert.equal(messages[0], messages[1]);
  assert.equal(messages[0], '입력한 이메일을 확인해 주세요.');
});

test('password reset renders account-neutral network and throttle failures as retry errors', async t => {
  const cases = [
    ['auth/network-request-failed', /네트워크/],
    ['auth/too-many-requests', /요청이 너무 많/]
  ];
  for (const [code, copy] of cases) {
    await t.test(code, async () => {
      const auth = {
        currentUser: null,
        async sendPasswordResetEmail() {
          throw Object.assign(new Error('private backend detail'), { code });
        }
      };
      const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });

      const result = await context.sendTeacherPasswordReset(authForm({ email: 'Teacher@Example.com' }));

      assert.equal(result.status, 'error');
      assert.match(result.message, copy);
      assert.equal(context.teacherAuthDialogState.message, '');
      assert.match(context.teacherAuthDialogState.error, copy);
      assert.doesNotMatch(result.message, /계정|가입|등록|존재/);
      assert.doesNotMatch(context.teacherAuthDialogState.error, /private backend detail/);
    });
  }
});

test('verification actions reject a recovery state after its UID or auth generation changes', async t => {
  for (const mismatch of ['uid', 'generation']) {
    await t.test(mismatch, async () => {
      let sends = 0;
      const user = {
        uid: 'password-user', email: 'teacher@example.com', displayName: '홍교사',
        emailVerified: false, isAnonymous: false,
        async sendEmailVerification() { sends += 1; }
      };
      const auth = { currentUser: user };
      const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
      context.teacherAuthDialogState = {
        mode: 'signup', status: 'verification-sent', uid: user.uid,
        authGeneration: context.teacherAuthVersion, email: user.email,
        displayName: user.displayName, needsProfile: false, message: '', error: ''
      };
      if (mismatch === 'uid') auth.currentUser = { ...user, uid: 'replacement-user' };
      else context.teacherAuthVersion += 1;

      const result = await context.sendTeacherVerificationEmail();

      assert.equal(result.status, 'stale');
      assert.equal(sends, 0);
    });
  }
});

test('signup, verification resend, and reset suppress in-flight duplicates and immediate cooldown retries', async t => {
  await t.test('signup', async () => {
    let createCalls = 0;
    let finishCreate;
    const user = {
      uid: 'new-user', email: 'teacher@example.com', displayName: '',
      emailVerified: false, isAnonymous: false,
      async updateProfile(profile) { this.displayName = profile.displayName; },
      async sendEmailVerification() {}
    };
    const auth = {
      currentUser: null,
      createUserWithEmailAndPassword() {
        createCalls += 1;
        return new Promise(resolve => {
          finishCreate = () => { this.currentUser = user; resolve({ user }); };
        });
      }
    };
    let now = 1000;
    const { context } = teacherEmailAuthTestRuntime({
      firebase: { auth() { return auth; } },
      Date: { now() { return now; } }
    });
    const event = authForm({ displayName: '홍교사', email: 'teacher@example.com', password: 'signup-secret' });

    const first = context.submitTeacherEmailSignup(event);
    const duplicate = context.submitTeacherEmailSignup(authForm({
      displayName: '홍교사', email: 'teacher@example.com', password: 'other-secret'
    }));

    assert.equal(createCalls, 1);
    assert.equal((await duplicate).status, 'busy');
    assert.equal(context.teacherAuthDialogState.busy, true);
    assert.match(context.teacherAuthDialogMarkup(), /disabled aria-busy="true"/);
    assert.doesNotMatch(JSON.stringify(context.teacherEmailAuthRequests), /signup-secret|other-secret/);
    finishCreate();
    assert.equal((await first).status, 'verification-sent');
    assert.equal((await context.submitTeacherEmailSignup(authForm({
      displayName: '홍교사', email: 'teacher@example.com', password: 'third-secret'
    }))).status, 'cooldown');
    assert.equal(createCalls, 1);
    now += 3001;
  });

  await t.test('verification resend', async () => {
    let sends = 0;
    let finishSend;
    const user = {
      uid: 'password-user', email: 'teacher@example.com', displayName: '홍교사',
      emailVerified: false, isAnonymous: false,
      sendEmailVerification() {
        sends += 1;
        return new Promise(resolve => { finishSend = resolve; });
      }
    };
    const auth = { currentUser: user };
    const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
    context.teacherAuthDialogState = {
      mode: 'signup', status: 'verification-sent', uid: user.uid,
      authGeneration: context.teacherAuthVersion, email: user.email,
      displayName: user.displayName, needsProfile: false, message: '', error: ''
    };

    const first = context.sendTeacherVerificationEmail();
    const duplicate = context.sendTeacherVerificationEmail();

    assert.equal(sends, 1);
    assert.equal((await duplicate).status, 'busy');
    assert.equal(context.teacherAuthDialogState.busy, true);
    finishSend();
    assert.equal((await first).status, 'verification-sent');
    assert.equal((await context.sendTeacherVerificationEmail()).status, 'cooldown');
    assert.equal(sends, 1);
  });

  await t.test('password reset cooldown expires deterministically', async () => {
    let sends = 0;
    const resolvers = [];
    const auth = {
      currentUser: null,
      sendPasswordResetEmail() {
        sends += 1;
        return new Promise(resolve => { resolvers.push(resolve); });
      }
    };
    let now = 5000;
    const { context } = teacherEmailAuthTestRuntime({
      firebase: { auth() { return auth; } },
      Date: { now() { return now; } }
    });
    const event = () => authForm({ email: 'teacher@example.com' });

    const first = context.sendTeacherPasswordReset(event());
    const duplicate = context.sendTeacherPasswordReset(event());

    assert.equal(sends, 1);
    assert.equal((await duplicate).status, 'busy');
    resolvers.shift()();
    assert.equal((await first).status, 'reset-sent');
    assert.equal((await context.sendTeacherPasswordReset(event())).status, 'cooldown');
    assert.equal(sends, 1);
    now += 3001;
    const afterCooldown = context.sendTeacherPasswordReset(event());
    assert.equal(sends, 2);
    resolvers.shift()();
    assert.equal((await afterCooldown).status, 'reset-sent');
  });
});

test('provider collision never applies a teacher user or probes an allowance', async () => {
  let applied = 0;
  let allowanceProbes = 0;
  const collision = Object.assign(new Error('collision'), {
    code: 'auth/account-exists-with-different-credential'
  });
  const auth = {
    currentUser: null,
    async signInWithEmailAndPassword() { throw collision; }
  };
  const { context } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    async applyTeacherUser() { applied += 1; },
    store: { async probeTeacherAllowance() { allowanceProbes += 1; } }
  });

  const result = await context.submitTeacherEmailLogin(authForm({
    email: 'teacher@example.com', password: '12345678'
  }));

  assert.equal(result.status, 'error');
  assert.match(result.message, /기존 로그인 방식/);
  assert.equal(applied, 0);
  assert.equal(allowanceProbes, 0);
});

test('a code-less asynchronous login error never exposes its raw message and clears the password', async () => {
  const raw = 'upstream stack and tenant detail';
  const auth = {
    currentUser: null,
    async signInWithEmailAndPassword() { throw new Error(raw); }
  };
  const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
  const event = authForm({ email: 'teacher@example.com', password: '12345678' });

  const result = await context.submitTeacherEmailLogin(event);

  assert.equal(result.status, 'error');
  assert.equal(result.message, '인증 처리에 실패했습니다. 다시 시도해 주세요.');
  assert.doesNotMatch(context.teacherAuthDialogState.error, /upstream stack/);
  assert.equal(event.currentTarget.elements.password.value, '');
});

test('local email validation keeps its actionable message without exposing async errors', async () => {
  const auth = { currentUser: null, signInWithEmailAndPassword() { throw new Error('must not call'); } };
  const { context } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
  const event = authForm({ email: 'teacher@example.com', password: 'short' });

  const result = await context.submitTeacherEmailLogin(event);

  assert.equal(result.status, 'error');
  assert.match(result.message, /8자 이상/);
  assert.equal(event.currentTarget.elements.password.value, '');
});

test('closing the teacher auth dialog clears every password input', () => {
  const { context, dialog, passwordInputs } = teacherEmailAuthTestRuntime();
  dialog.open = true;
  passwordInputs[0].value = 'first-secret';
  passwordInputs[1].value = 'second-secret';

  context.closeTeacherAuthDialog();

  assert.equal(dialog.open, false);
  assert.deepEqual(passwordInputs.map(input => input.value), ['', '']);
});

test('mode controls expose selection state and rerender focuses the active mode field', () => {
  const { context, focusedSelector } = teacherEmailAuthTestRuntime();

  context.openTeacherAuthDialog('signup');
  const signupMarkup = context.teacherAuthDialogMarkup();

  assert.match(signupMarkup, /aria-pressed="true"[^>]*onclick="openTeacherAuthDialog\('signup'\)"/);
  assert.equal(focusedSelector(), '#teacher-signup-name');

  context.teacherAuthDialogState = {
    mode: 'login', status: 'error', email: 'teacher@example.com', message: '', error: '로그인 실패'
  };
  context.renderTeacherAuthDialog();
  assert.equal(focusedSelector(), '#teacher-login-email');
});

test('production Google-only teacher auth focuses the Google sign-in button', () => {
  const { context, focusedSelector } = teacherEmailAuthTestRuntime({ teacherEmailAuthUiEnabled: false });

  context.openTeacherAuthDialog('login');

  assert.equal(focusedSelector(), '#teacher-google-signin');
  assert.doesNotMatch(context.teacherAuthDialogMarkup(), /이메일로 로그인|이메일로 가입|비밀번호 재설정/);
});

test('verification resend failure is rendered as an accessible error', () => {
  const { context } = teacherEmailAuthTestRuntime();
  context.teacherAuthDialogState = {
    mode: 'signup', status: 'verification-sent', email: 'teacher@example.com',
    message: '', error: '인증 메일을 다시 보내지 못했습니다.'
  };

  const markup = context.teacherAuthDialogMarkup();

  assert.match(markup, /role="alert"/);
  assert.match(markup, /인증 메일을 다시 보내지 못했습니다/);
});

test('auth generation change prevents a stale signup continuation from rendering verification UI', async () => {
  let finishVerification;
  const user = {
    uid: 'email-teacher', email: 'teacher@example.com',
    async updateProfile() {},
    sendEmailVerification() { return new Promise(resolve => { finishVerification = resolve; }); }
  };
  const auth = {
    currentUser: user,
    async createUserWithEmailAndPassword() { return { user }; }
  };
  const { context, dialog } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
  dialog.innerHTML = 'original dialog';
  const event = authForm({
    displayName: '홍교사', email: 'teacher@example.com', password: '12345678'
  });
  const pending = context.submitTeacherEmailSignup(event);
  for (let turn = 0; turn < 10 && !finishVerification; turn += 1) await Promise.resolve();
  assert.equal(typeof finishVerification, 'function');
  const busyDialog = dialog.innerHTML;
  assert.match(busyDialog, /aria-busy="true"/);
  context.teacherAuthVersion += 1;
  auth.currentUser = { uid: 'replacement-user' };
  finishVerification();

  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(dialog.innerHTML, busyDialog);
  assert.notEqual(context.teacherAuthDialogState.status, 'verification-sent');
  assert.equal(event.currentTarget.elements.password.value, '');
});

test('closing and reopening in another mode prevents an older signup from replacing or clearing the new form', async () => {
  let finishVerification;
  const user = {
    uid: 'email-teacher', email: 'teacher@example.com',
    async updateProfile() {},
    sendEmailVerification() { return new Promise(resolve => { finishVerification = resolve; }); }
  };
  const auth = {
    currentUser: user,
    async createUserWithEmailAndPassword() { return { user }; }
  };
  const { context, dialog, passwordInputs } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
  context.openTeacherAuthDialog('signup');
  const event = authForm({ displayName: '홍교사', email: 'teacher@example.com', password: 'old-secret' });
  const pending = context.submitTeacherEmailSignup(event);
  for (let turn = 0; turn < 10 && !finishVerification; turn += 1) await Promise.resolve();
  context.closeTeacherAuthDialog();
  context.openTeacherAuthDialog('login');
  passwordInputs[0].value = 'new-form-secret';
  const currentMarkup = dialog.innerHTML;
  finishVerification();

  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(dialog.open, true);
  assert.equal(dialog.innerHTML, currentMarkup);
  assert.equal(passwordInputs[0].value, 'new-form-secret');
  assert.equal(event.currentTarget.elements.password.value, '');
});

test('an older email login cannot apply or close a reopened signup dialog', async () => {
  let finishLogin;
  const user = { uid: 'email-teacher', email: 'teacher@example.com' };
  const auth = {
    currentUser: null,
    signInWithEmailAndPassword() { return new Promise(resolve => { finishLogin = () => { this.currentUser = user; resolve({ user }); }; }); }
  };
  let applied = 0;
  const { context, dialog } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    async applyTeacherUser() { applied += 1; return true; }
  });
  context.openTeacherAuthDialog('login');
  const pending = context.submitTeacherEmailLogin(authForm({ email: 'teacher@example.com', password: '12345678' }));
  context.openTeacherAuthDialog('signup');
  const currentMarkup = dialog.innerHTML;
  finishLogin();

  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(applied, 0);
  assert.equal(dialog.open, true);
  assert.equal(dialog.innerHTML, currentMarkup);
});

test('email login keeps the dialog open when applyTeacherUser rejects the continuation', async () => {
  const user = { uid: 'email-teacher', email: 'teacher@example.com' };
  const auth = {
    currentUser: user,
    async signInWithEmailAndPassword() { return { user }; }
  };
  const { context, dialog } = teacherEmailAuthTestRuntime({
    firebase: { auth() { return auth; } },
    async applyTeacherUser() { return false; }
  });
  context.openTeacherAuthDialog('login');

  const result = await context.submitTeacherEmailLogin(authForm({
    email: 'teacher@example.com', password: '12345678'
  }));

  assert.equal(result.status, 'stale');
  assert.equal(dialog.open, true);
});

test('an older verification resend cannot overwrite a newly selected login mode', async () => {
  let finishVerification;
  const user = {
    uid: 'email-teacher', email: 'teacher@example.com', isAnonymous: false,
    sendEmailVerification() { return new Promise(resolve => { finishVerification = resolve; }); }
  };
  const auth = { currentUser: user };
  const { context, dialog } = teacherEmailAuthTestRuntime({ firebase: { auth() { return auth; } } });
  context.openTeacherAuthDialog('signup');
  context.teacherAuthDialogState = {
    mode: 'signup', status: 'verification-sent', uid: user.uid,
    authGeneration: context.teacherAuthVersion, email: user.email,
    displayName: '홍교사', needsProfile: false, message: '', error: ''
  };
  const pending = context.sendTeacherVerificationEmail();
  context.openTeacherAuthDialog('login');
  const currentMarkup = dialog.innerHTML;
  finishVerification();

  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(dialog.innerHTML, currentMarkup);
});

test('an older Google popup completion cannot close a reopened email dialog', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let finishGoogle;
  let closes = 0;
  const context = {
    teacherAuthDialogRevision: 4,
    teacherAuthVersion: 8,
    signInTeacher() { return new Promise(resolve => { finishGoogle = resolve; }); },
    closeTeacherAuthDialog() { closes += 1; },
    showTeacherAuthError(error) { throw error; },
    firebase: { auth() { return { currentUser: { uid: 'google-user' } }; } }
  };
  vm.runInNewContext(extractFunction(html, 'teacherEmailAuthOperationIsCurrent'), context);
  vm.runInNewContext(extractFunction(html, 'signInTeacherFromDialog'), context);

  const pending = context.signInTeacherFromDialog();
  context.teacherAuthDialogRevision += 1;
  finishGoogle({ uid: 'google-user' });
  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(closes, 0);
});

test('an older Google popup completion is rejected before manually applying its user', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let finishPopup;
  let applied = 0;
  let closes = 0;
  const user = { uid: 'google-user' };
  const auth = {
    currentUser: null,
    signInWithPopup() {
      return new Promise(resolve => {
        finishPopup = () => { this.currentUser = user; resolve({ user }); };
      });
    }
  };
  function authFactory() { return auth; }
  authFactory.GoogleAuthProvider = function GoogleAuthProvider() {};
  const context = {
    teacherUser: null,
    teacherAuthDialogRevision: 4,
    teacherAuthVersion: 8,
    firebase: { auth: authFactory },
    async applyTeacherUser() { applied += 1; return true; },
    closeTeacherAuthDialog() { closes += 1; },
    showTeacherAuthError(error) { throw error; }
  };
  vm.runInNewContext(extractFunction(html, 'teacherEmailAuthOperationIsCurrent'), context);
  vm.runInNewContext(extractFunction(html, 'signInTeacher'), context);
  vm.runInNewContext(extractFunction(html, 'signInTeacherFromDialog'), context);

  const pending = context.signInTeacherFromDialog();
  context.teacherAuthDialogRevision += 1;
  finishPopup();
  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(applied, 0);
  assert.equal(closes, 0);
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

function currentUidGuardContext(auth, overrides = {}) {
  const renders = [];
  const context = {
    teacherUser: null,
    teacherAllowance: null,
    teacherState: null,
    appliedTeacherState: null,
    clockUserId: '',
    clockPromise: null,
    clockPromiseUid: '',
    teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'),
    firebase: { auth() { return auth; } },
    renderTeacherAuthArea() { renders.push(context.teacherUser && context.teacherUser.uid || 'signed-out'); },
    store: {},
    console,
    ...overrides
  };
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'applyTeacherUser'
  ), context);
  return { context, renders };
}

test('applyTeacherUser rejects an old user when current Firebase UID changes during token loading', async () => {
  let finishToken;
  let allowanceProbes = 0;
  const userA = {
    uid: 'teacher-a', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { finishToken = resolve; }); }
  };
  const auth = { currentUser: userA };
  const { context, renders } = currentUidGuardContext(auth, {
    store: { async probeTeacherAllowance() { allowanceProbes += 1; return { enabled: true, role: 'teacher' }; } }
  });

  const pending = context.applyTeacherUser(userA);
  auth.currentUser = { uid: 'teacher-b' };
  finishToken({ claims: { firebase: { sign_in_provider: 'password' } } });
  const result = await pending;

  assert.equal(result, false);
  assert.equal(context.teacherUser, null);
  assert.equal(allowanceProbes, 0);
  assert.doesNotMatch(renders.join(','), /teacher-a/);
});

test('applyTeacherUser rejects an old user when current Firebase UID changes during allowance loading', async () => {
  let finishAllowance;
  const userA = {
    uid: 'teacher-a', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
    async getIdTokenResult() { return { claims: { firebase: { sign_in_provider: 'password' } } }; }
  };
  const auth = { currentUser: userA };
  const { context, renders } = currentUidGuardContext(auth, {
    store: { probeTeacherAllowance() { return new Promise(resolve => { finishAllowance = resolve; }); } }
  });

  const pending = context.applyTeacherUser(userA);
  for (let turn = 0; turn < 10 && !finishAllowance; turn += 1) await Promise.resolve();
  auth.currentUser = { uid: 'teacher-b' };
  finishAllowance({ enabled: true, role: 'teacher' });
  const result = await pending;

  assert.equal(result, false);
  assert.equal(context.teacherUser, null);
  assert.doesNotMatch(renders.join(','), /teacher-a/);
});

test('applyTeacherUser retracts an old user when current Firebase UID changes during recovery', async () => {
  let finishRecovery;
  const userA = {
    uid: 'teacher-a', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
    async getIdTokenResult() { return { claims: { firebase: { sign_in_provider: 'password' } } }; }
  };
  const auth = { currentUser: userA };
  const { context, renders } = currentUidGuardContext(auth, {
    store: { async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; } },
    recoverPendingAllocationsForTeacher() {
      return new Promise(resolve => { finishRecovery = resolve; });
    }
  });

  const pending = context.applyTeacherUser(userA);
  for (let turn = 0; turn < 10 && !finishRecovery; turn += 1) await Promise.resolve();
  auth.currentUser = { uid: 'teacher-b' };
  finishRecovery([]);
  const result = await pending;

  assert.equal(result, false);
  assert.equal(context.teacherUser, null);
  assert.equal(context.teacherState.status, 'signed-out');
  assert.doesNotMatch(renders.join(','), /teacher-a/);
});

test('pending allocation recovery never renders an owner after Firebase current UID changes', async () => {
  let finishRecovery;
  const owner = { status: 'teacher', uid: 'teacher-a', email: 'a@school.kr', role: 'teacher' };
  const auth = { currentUser: { uid: 'teacher-a' } };
  const renders = [];
  const context = pendingAllocationTestContext({
    teacherUser: { uid: 'teacher-a', email: 'a@school.kr' },
    teacherState: owner,
    teacherAuthVersion: 9,
    pendingAllocationRecoveryTimer: null,
    AuthCore: require('../auth-core.js'),
    firebase: { auth() { return auth; } },
    pendingAllocationsForOwner() {
      return [{ sessionId: 'session-a', token: 'allocation-token-1234', recoverAfter: 0 }];
    },
    store: {
      recoverPendingSessionAllocation() {
        return new Promise(resolve => { finishRecovery = resolve; });
      }
    },
    renderTeacherAuthArea() { renders.push(context.teacherUser && context.teacherUser.uid || 'signed-out'); },
    toast() {},
    console,
    Date
  });
  vm.runInNewContext(extractFunction(
    fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'recoverPendingAllocationsForTeacher'
  ), context);

  const pending = context.recoverPendingAllocationsForTeacher(owner);
  for (let turn = 0; turn < 10 && !finishRecovery; turn += 1) await Promise.resolve();
  auth.currentUser = { uid: 'teacher-b' };
  finishRecovery({ complete: true });
  await pending;

  assert.doesNotMatch(renders.join(','), /teacher-a/);
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

test('ended plan finish 실패 pending은 auth 교체·reload에도 보존되고 원 소유자 retry 뒤 삭제된다', async () => {
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
    recoverAfter: 2, planId: 'plan-a', planRevision: 2, setId: 'set-a',
    attachStatus: 'attached'
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
        if (failRecovery) throw new Error('planned finish failure');
        return { complete: true, ended: true, finished: true, planRevision: 3 };
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
  assert.match(context.pendingAllocationRead()[0].lastError, /planned finish failure/);
  assert.match(context.teacherAuthMarkup(), /정리 재시도/);

  const reloadContext = { PENDING_ALLOCATION_KEY: key, localStorage };
  loadStageFunctions(['pendingAllocationRead'], reloadContext);
  assert.match(reloadContext.pendingAllocationRead()[0].lastError, /planned finish failure/);

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
  const auth = {
    currentUser: null,
    onAuthStateChanged(listener) { authListener = listener; }
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
      auth() { return auth; }
    },
    router() {},
    console
  };
  vm.runInNewContext(
    extractFunction(html, 'applyTeacherUser') + '\n' + extractFunction(html, 'bootWithAuth'),
    context
  );

  context.bootWithAuth();
  auth.currentUser = userA;
  const observerA = authListener(userA);
  await Promise.resolve();
  auth.currentUser = userB;
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

test('ambiguous attach 뒤 reload recovery는 plan/revision/status를 보존하고 attached live를 삭제하지 않는다', async () => {
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
  const key = 'vq_pending_allocations_v1';
  values.set(key, JSON.stringify([{
    sessionId: 'attached-session', code: 'ATT123', ownerUid: 'owner-user',
    ownerEmail: 'owner@school.kr', token: 'attached-token-1234',
    createdAt: 1, recoverAfter: 2, planId: 'plan-a', planRevision: 1,
    setId: 'set-a', attachStatus: 'attaching'
  }]));
  let scheduled = 0;
  const context = {
    PENDING_ALLOCATION_KEY: key,
    PENDING_ALLOCATION_RECOVERY_DELAY_MS: 30_000,
    pendingAllocationRecoveryTimer: null,
    localStorage, Date: { now() { return 10_000; } },
    teacherAuthVersion: 3,
    teacherState: {
      status: 'teacher', role: 'teacher', uid: 'owner-user', email: 'owner@school.kr'
    },
    AuthCore: require('../auth-core.js'),
    setTimeout() { scheduled += 1; return 9; }, clearTimeout() {},
    renderTeacherAuthArea() {},
    store: {
      async recoverPendingSessionAllocation(record) {
        assert.equal(record.attachStatus, 'attaching');
        return { complete: false, active: true, attached: true, planRevision: 2 };
      }
    }
  };
  loadStageFunctions([
    'pendingAllocationRead', 'pendingAllocationWrite', 'pendingAllocationPatch',
    'pendingAllocationRemove', 'pendingAllocationsForOwner',
    'recoverPendingAllocationsForTeacher'
  ], context);

  const results = await context.recoverPendingAllocationsForTeacher(context.teacherState);
  assert.equal(results[0].attached, true);
  assert.equal(scheduled, 0);
  assert.deepEqual(clone(context.pendingAllocationRead()[0]), {
    sessionId: 'attached-session', code: 'ATT123', ownerUid: 'owner-user',
    ownerEmail: 'owner@school.kr', token: 'attached-token-1234',
    createdAt: 1, recoverAfter: 2, planId: 'plan-a', planRevision: 2,
    setId: 'set-a', attachStatus: 'attached',
    lastError: '연결된 수업계획 세션이 진행 중입니다. 이 기록은 자동 삭제하지 않습니다.'
  });

  const reloadContext = { PENDING_ALLOCATION_KEY: key, localStorage };
  loadStageFunctions(['pendingAllocationRead'], reloadContext);
  assert.equal(reloadContext.pendingAllocationRead()[0].attachStatus, 'attached');
  assert.equal(reloadContext.pendingAllocationRead()[0].planRevision, 2);
});

test('same-user request refresh synchronously clears the previous request screen and draft before rerouting', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: 'A 신청 화면 teacher-a@school.kr 이유 A' };
  const context = {
    authReady: true, location: { hash: '#/' },
    teacherUser: { uid: 'teacher-a', email: 'teacher-a@school.kr' }, teacherAllowance: null,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    teacherRequestScreen: { uid: 'teacher-a', draft: { displayName: 'A', organization: '이유 A', note: '메모 A' } },
    teacherAuthVersion: 0, clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {}, APP() { return app; }, topbar() { return '<nav></nav>'; },
    store: { async probeTeacherAllowance() { return null; } },
    router() {}, reconcileTeacherRoute() {}, console
  };
  loadStageFunctions(['teacherRequestRouteIsCurrent', 'clearTeacherRequestScreen', 'applyTeacherUser'], context);
  let resolveToken;
  const delayedUser = { uid: 'teacher-a', email: 'teacher-a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolveToken = resolve; }); } };

  const applying = context.applyTeacherUser(delayedUser);

  assert.equal(context.teacherRequestScreen, null);
  assert.doesNotMatch(app.innerHTML, /teacher-a@school\.kr|이유 A|메모 A/);
  resolveToken({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applying;
});

test('overlapping same-user request refresh keeps the reroute marker for only the newest auth generation', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: 'A 신청 화면 teacher-a@school.kr' };
  const resolvers = [];
  const routes = [];
  const context = {
    authReady: true, location: { hash: '#/' }, teacherRequestReroute: null,
    teacherUser: { uid: 'teacher-a', email: 'teacher-a@school.kr' }, teacherAllowance: null,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    teacherRequestScreen: { uid: 'teacher-a', draft: { displayName: 'A', organization: 'A', note: 'A' } },
    teacherAuthVersion: 0, clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {}, APP() { return app; }, topbar() { return '<nav></nav>'; },
    store: { async probeTeacherAllowance() { return null; } }, reconcileTeacherRoute() {}, retractProtectedTeacherScreen() {},
    router() { routes.push(context.teacherUser && context.teacherUser.uid); app.innerHTML = 'route:' + (context.teacherUser && context.teacherUser.uid); }, console
  };
  loadStageFunctions(['teacherRequestRouteIsCurrent', 'clearTeacherRequestScreen', 'applyTeacherUser'], context);
  const user = { uid: 'teacher-a', email: 'teacher-a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolvers.push(resolve); }); } };

  const first = context.applyTeacherUser(user);
  const second = context.applyTeacherUser(user);
  await Promise.resolve();
  resolvers[1]({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await second;
  resolvers[0]({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await first;

  assert.deepEqual(routes, ['teacher-a']);
  assert.equal(app.innerHTML, 'route:teacher-a');
  assert.equal(context.teacherRequestReroute, null);
});

test('A request refresh followed by B routes only B after B allowance resolution and leaves no stale request DOM', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: 'A 신청 화면 teacher-a@school.kr 사유 A' };
  const resolvers = {};
  const routes = [];
  const context = {
    authReady: true, location: { hash: '#/' }, teacherRequestReroute: null,
    teacherUser: { uid: 'teacher-a', email: 'teacher-a@school.kr' }, teacherAllowance: null,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    teacherRequestScreen: { uid: 'teacher-a', draft: { displayName: 'A', organization: '사유 A', note: '메모 A' } },
    teacherAuthVersion: 0, clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {}, APP() { return app; }, topbar() { return '<nav></nav>'; },
    store: { async probeTeacherAllowance() { return null; } }, reconcileTeacherRoute() {}, retractProtectedTeacherScreen() {},
    router() { routes.push(context.teacherUser && context.teacherUser.uid); app.innerHTML = 'route:' + (context.teacherUser && context.teacherUser.uid); }, console
  };
  loadStageFunctions(['teacherRequestRouteIsCurrent', 'clearTeacherRequestScreen', 'applyTeacherUser'], context);
  const user = uid => ({ uid, email: uid + '@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolvers[uid] = resolve; }); } });

  const applyingA = context.applyTeacherUser(user('teacher-a'));
  const applyingB = context.applyTeacherUser(user('teacher-b'));
  await Promise.resolve();
  resolvers['teacher-b']({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingB;
  resolvers['teacher-a']({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingA;

  assert.deepEqual(routes, ['teacher-b']);
  assert.equal(app.innerHTML, 'route:teacher-b');
  assert.doesNotMatch(app.innerHTML, /teacher-a|사유 A|인증 상태/);
});

test('request auth completion does not reroute after leaving home for the join screen', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: 'A 신청 화면 teacher-a@school.kr' };
  const routes = [];
  let resolveToken;
  const context = {
    authReady: true, location: { hash: '#/' }, teacherRequestReroute: null,
    teacherUser: { uid: 'teacher-a', email: 'teacher-a@school.kr' }, teacherAllowance: null,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    teacherRequestScreen: { uid: 'teacher-a', draft: { displayName: 'A', organization: '', note: '' } },
    teacherAuthVersion: 0, clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {}, APP() { return app; }, topbar() { return '<nav></nav>'; },
    store: { async probeTeacherAllowance() { return null; } }, reconcileTeacherRoute() {}, retractProtectedTeacherScreen() {},
    router() { routes.push(context.location.hash); app.innerHTML = 'unexpected router'; }, console
  };
  loadStageFunctions(['teacherRequestRouteIsCurrent', 'clearTeacherRequestScreen', 'applyTeacherUser'], context);
  const user = { uid: 'teacher-a', email: 'teacher-a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolveToken = resolve; }); } };

  const applying = context.applyTeacherUser(user);
  context.location.hash = '#/join';
  app.innerHTML = '<input id="join-code" value="123456">';
  resolveToken({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applying;

  assert.deepEqual(routes, []);
  assert.match(app.innerHTML, /join-code.*123456/);
  assert.equal(context.teacherRequestReroute, null);
});

test('A-to-B request refresh at the sets route reconciles once without a stale reroute', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: 'A 신청 화면 teacher-a@school.kr 사유 A' };
  const events = [];
  const resolvers = {};
  const context = {
    authReady: true, location: { hash: '#/' }, teacherRequestReroute: null,
    teacherUser: { uid: 'teacher-a', email: 'teacher-a@school.kr' }, teacherAllowance: null,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    teacherRequestScreen: { uid: 'teacher-a', draft: { displayName: 'A', organization: '사유 A', note: '메모 A' } },
    teacherAuthVersion: 0, clockUserId: '', clockPromise: null, clockPromiseUid: '',
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {}, APP() { return app; }, topbar() { return '<nav></nav>'; },
    store: { async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; } },
    runCleanups() { events.push('cleanup'); },
    router() { events.push('router'); app.innerHTML = 'sets for ' + context.teacherUser.uid; },
    go(route) { events.push('go:' + route); context.location.hash = '#/' + route; },
    retractProtectedTeacherScreen() {}, console
  };
  vm.runInNewContext(
    extractFunction(html, 'teacherRouteRequirement') + '\n' +
    extractFunction(html, 'reconcileTeacherRoute') + '\n' +
    extractFunction(html, 'teacherRequestRouteIsCurrent') + '\n' +
    extractFunction(html, 'clearTeacherRequestScreen') + '\n' +
    extractFunction(html, 'applyTeacherUser'),
    context
  );
  const user = uid => ({ uid, email: uid + '@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolvers[uid] = resolve; }); } });

  const applyingA = context.applyTeacherUser(user('teacher-a'));
  const applyingB = context.applyTeacherUser(user('teacher-b'));
  context.location.hash = '#/sets';
  app.innerHTML = 'sets loading for teacher-b';
  await Promise.resolve();
  resolvers['teacher-b']({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingB;
  resolvers['teacher-a']({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingA;

  assert.deepEqual(events, ['cleanup', 'router']);
  assert.equal(app.innerHTML, 'sets for teacher-b');
  assert.equal(context.teacherRequestReroute, null);
  assert.doesNotMatch(app.innerHTML, /teacher-a|사유 A|인증 상태/);
});

test('관리자 교사 계정 화면은 canonical 이메일과 자기 계정 보호를 표시한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = { innerHTML: '' };
  const context = {
    adm: { allowances: {}, loadingAllowances: false },
    teacherState: { uid: 'admin-uid', email: ' Admin@School.KR ', role: 'admin', status: 'admin' },
    AuthCore: { isAdmin(state) { return !!state && state.role === 'admin'; } },
    store: {
      async listTeacherAllowances() {
        return {
          ' Admin@School.KR ': { enabled: true, role: 'admin' },
          'teacher@school.kr': { enabled: true, role: 'teacher' }
        };
      }
    },
    $() { return body; },
    esc(value) { return String(value); },
    collaboration: { canonicalEmail(value) { return String(value || '').trim().toLowerCase(); } },
    admRenderBody() {}
  };
  loadStageFunctions(['maintenanceCanonicalEmail', 'admTeacherAccounts'], context);
  const markup = await context.admTeacherAccounts();
  assert.match(markup, /teacher@school\.kr/);
  assert.match(markup, /disabled/);
  assert.match(markup, /admin@school\.kr/);
  assert.equal(context.adm.allowances['admin@school.kr'].role, 'admin');
});

test('휴지통 로그인 정리는 owner/admin 범위를 지키고 한 번에 한 세트만 처리한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const calls = [], resolvers = [];
  const context = {
    teacherUser: { uid: 'owner-uid', email: 'owner@school.kr' },
    teacherState: { uid: 'owner-uid', email: 'owner@school.kr', role: 'teacher', status: 'teacher' },
    teacherAuthVersion: 9, clockUserId: 'owner-uid', authReady: true,
    trashMaintenance: null,
    AuthCore: { isTeacher(state) { return !!state && (state.role === 'teacher' || state.role === 'admin'); } },
    store: {
      async listExpiredTrash(scope, limit) {
        calls.push(['list', scope, limit]);
        return [{ id: 'expired-1' }];
      },
      async beginSetPurge(id, mode, actor) {
        calls.push(['begin', id, mode, actor.uid]);
        return { started: true };
      },
      continueSetPurge(id) {
        calls.push(['continue', id]);
        return new Promise(resolve => resolvers.push(resolve));
      }
    },
    toast() {}, setTimeout() { return 1; }, clearTimeout() {}
  };
  loadStageFunctions(['maintenanceIsCurrent', 'startTrashMaintenance', 'runTrashMaintenancePage', 'stopTrashMaintenance'], context);
  const started = context.startTrashMaintenance(9);
  const second = context.runTrashMaintenancePage();
  assert.equal(second, context.trashMaintenance.promise);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(item => item[0] === 'continue').length, 1);
  resolvers.shift()({ done: true, parentDeleted: true });
  await started;
  assert.deepEqual(calls.slice(0, 3).map(item => item[0]), ['list', 'begin', 'continue']);
  assert.equal(calls[0][1].ownerUid, 'owner-uid');
  assert.equal(calls[0][1].role, 'teacher');
  assert.equal(calls[0][2], 20);
  assert.equal(calls[1][1], 'expired-1');
  assert.equal(calls[1][2], 'expired');
  assert.equal(calls[1][3], 'owner-uid');
  assert.equal(calls[2][1], 'expired-1');
  context.teacherAuthVersion = 10;
  context.stopTrashMaintenance();
  assert.equal(context.trashMaintenance, null);
});

test('관리자 휴지통 정리는 실패를 화면에 남기고 앱 진입을 막지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const notices = [];
  let timer;
  const context = {
    teacherUser: { uid: 'admin-uid', email: 'admin@school.kr' },
    teacherState: { uid: 'admin-uid', email: 'admin@school.kr', role: 'admin', status: 'admin' },
    teacherAuthVersion: 2, clockUserId: 'admin-uid', trashMaintenance: null,
    AuthCore: { isTeacher() { return true; }, isAdmin() { return true; } },
    store: {
      async listExpiredTrash(scope, limit) { if (!scope || scope.role !== 'admin' || limit !== 20) throw new Error('bad scope'); return [{ id: 'bad' }]; },
      async beginSetPurge() { throw new Error('permission-denied'); }
      , async continueSetPurge() { return { done: true, parentDeleted: true }; }
    },
    toast(message) { notices.push(message); },
    setTimeout(callback, delay) { timer = { callback, delay }; return 4; },
    clearTimeout() {}
  };
  loadStageFunctions(['maintenanceIsCurrent', 'startTrashMaintenance', 'runTrashMaintenancePage', 'stopTrashMaintenance'], context);
  await context.startTrashMaintenance(2);
  assert.match(context.trashMaintenance.warning, /permission-denied/);
  assert.ok(timer && timer.delay <= 5000);
  assert.equal(notices.length > 0, true);
});

test('휴지통 로그인 정리는 같은 인증 세대에서 단일 flight를 재사용하고 20개 초과 페이지를 끝까지 처리한다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let page = 0, listCalls = 0, begins = 0;
  const context = {
    teacherUser: { uid: 'admin-uid', email: 'admin@school.kr' },
    teacherState: { uid: 'admin-uid', email: 'admin@school.kr', role: 'admin' },
    teacherAuthVersion: 4, clockUserId: 'admin-uid', trashMaintenance: null,
    AuthCore: { isTeacher() { return true; } },
    store: {
      async listExpiredTrash() {
        listCalls += 1;
        if (page++ === 0) return Array.from({ length: 20 }, (_, index) => ({ id: 'a-' + index }));
        return [{ id: 'last' }];
      },
      async beginSetPurge() { begins += 1; },
      async continueSetPurge() { return { done: true, parentDeleted: true }; }
    },
    toast() {}, setTimeout() { return 1; }, clearTimeout() {}
  };
  loadStageFunctions(['maintenanceIsCurrent', 'startTrashMaintenance', 'runTrashMaintenancePage', 'stopTrashMaintenance'], context);
  const first = context.startTrashMaintenance(4);
  const second = context.startTrashMaintenance(4);
  assert.equal(first, second);
  await first;
  assert.equal(listCalls, 2);
  assert.equal(begins, 21);
  assert.equal(context.trashMaintenance.completed, true);
  assert.equal(context.startTrashMaintenance(4), first);
});

test('휴지통 정리 중 인증 세대가 바뀌면 대기 중 결과를 게시하거나 purge하지 않는다', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let release;
  let begins = 0;
  const context = {
    teacherUser: { uid: 'owner-uid', email: 'owner@school.kr' },
    teacherState: { uid: 'owner-uid', email: 'owner@school.kr', role: 'teacher' },
    teacherAuthVersion: 7, clockUserId: 'owner-uid', trashMaintenance: null,
    AuthCore: { isTeacher() { return true; } },
    store: {
      listExpiredTrash() { return new Promise(resolve => { release = resolve; }); },
      async beginSetPurge() { begins += 1; },
      async continueSetPurge() { return { done: true }; }
    },
    toast() {}, setTimeout() { return 1; }, clearTimeout() {}
  };
  loadStageFunctions(['maintenanceIsCurrent', 'startTrashMaintenance', 'runTrashMaintenancePage', 'stopTrashMaintenance'], context);
  const running = context.startTrashMaintenance(7);
  context.teacherAuthVersion = 8;
  context.stopTrashMaintenance();
  release([{ id: 'stale' }]);
  await running;
  assert.equal(begins, 0);
  assert.equal(context.trashMaintenance, null);
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
  loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick'], context);

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
  loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plQueueDueQuestions', 'plOpenNextDueQuestion', 'plTick', 'plCloseQuestion'], context);

  context.plTick();
  assert.deepEqual(context.pl.dueQuestions, [1]);

  await context.plCloseQuestion();

  assert.deepEqual(opened, [1]);
  assert.equal(plays, 0);
  assert.equal(context.pl.live.q, -1);
});

test('열려 있는 현재 문항이 due queue에 중복되면 계속 재생 때 같은 문항을 다시 열지 않는다', async () => {
  let plays = 0;
  let opened = 0;
  const context = {
    pl: {
      sessionId: 'session1', live: { q: 0, openedAt: 1, liveToken: 'token', accepting: false },
      liveGeneration: 0, dueQuestions: [0], fired: [true],
      flatQuestions: [{ t: 120, videoIndex: 0 }], set: { settings: {} },
      player: { playVideo() { plays += 1; } }
    },
    FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; }, async closeLive() { return true; }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { opened += 1; return false; },
    plTick() {}, plRenderOverlay() {}, console
  };
  loadStageFunctions(['plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), true);
  assert.equal(plays, 1);
  assert.deepEqual(context.pl.dueQuestions, []);
  assert.equal(opened, 1);
  assert.equal(context.pl.live.q, -1);
});

test('계속 재생은 overlay를 가역적으로 숨긴 뒤 player 시작을 확인하고 완료 문항을 확정한다', async () => {
  const order = [];
  const classes = {
    add() {},
    remove(name) { order.push('class:' + name); }
  };
  const overlay = { remove() { order.push('overlay'); } };
  const trigger = require('../quiz-trigger-core.js').create([{ t: 174, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 173, currentTime: 174, event: 'tick' });
  trigger.open(0);
  const context = {
    pl: {
      sessionId: 'session1', live: { q: 0, openedAt: 1, liveToken: 'token' },
      liveGeneration: 0, dueQuestions: [], fired: [true], quizTrigger: trigger,
      flatQuestions: [{ t: 174, videoIndex: 0 }], set: { settings: {} },
      player: { playVideo() { order.push('play'); } }
    },
    FirestoreCore: core,
    store: {
      async freezeLive() { order.push('freeze'); return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; }, async closeLive() { return true; }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { return false; }, plTick() {},
    document: { getElementById(id) { return id === 'overlay' ? overlay : id === 'pl-stage'
      ? { classList: classes } : null; }, body: { classList: classes } },
    plRenderOverlay() {}, console
  };
  loadStageFunctions(['plStageRoot', 'plRenderCenteredOverlay', 'plSetQuizOpen', 'plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), true);
  assert.equal(trigger.state()[0], 'completed');
  assert.ok(order.indexOf('overlay') >= 0);
  assert.ok(order.indexOf('class:quiz-open') >= 0);
  assert.ok(order.indexOf('overlay') < order.indexOf('play'));
  assert.ok(order.indexOf('class:quiz-open') < order.indexOf('play'));
  assert.ok(order.indexOf('play') < order.indexOf('freeze'));
});

test('계속 재생이 첫 시도에 실패하면 live·overlay·open 상태를 보존하고 다음 시도에서만 완료한다', async () => {
  let attempts = 0;
  let closes = 0;
  const trigger = require('../quiz-trigger-core.js').create([{ t: 174, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 173, currentTime: 174, event: 'tick' });
  trigger.open(0);
  const state = {
    sessionId: 'session1', live: { q: 0, openedAt: 1, liveToken: 'token' },
    liveGeneration: 0, dueQuestions: [], fired: [true], quizTrigger: trigger,
    flatQuestions: [{ t: 174, videoIndex: 0 }], set: { settings: {} },
    player: {
      playVideo() {
        attempts += 1;
        if (attempts === 1) throw new Error('autoplay blocked');
      }
    }
  };
  const context = {
    pl: state, FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; }, async closeLive() { closes += 1; return true; }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { return false; }, plTick() {}, plRenderOverlay() {},
    console
  };
  loadStageFunctions(['plContinuePlayback', 'plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), false);
  assert.equal(state.live.q, 0);
  assert.equal(trigger.state()[0], 'open');
  assert.equal(closes, 0);
  assert.match(state.closeError, /재생/);

  assert.equal(await context.plCloseQuestion(), true);
  assert.equal(state.live.q, -1);
  assert.equal(trigger.state()[0], 'completed');
  assert.equal(closes, 1);
  assert.equal(attempts, 2);
});

test('closeLive rejection 뒤에는 재생을 pause하고 live·overlay·open 상태를 가역적으로 복원한다', async () => {
  const order = [];
  const trigger = require('../quiz-trigger-core.js').create([{ t: 174, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 173, currentTime: 174, event: 'tick' });
  trigger.open(0);
  const state = {
    sessionId: 'session1', live: { q: 0, openedAt: 1, liveToken: 'token' },
    liveGeneration: 0, dueQuestions: [], fired: [true], quizTrigger: trigger,
    flatQuestions: [{ t: 174, videoIndex: 0 }], set: { settings: {} },
    player: { playVideo() { order.push('play'); }, pauseVideo() { order.push('pause'); } }
  };
  const context = {
    pl: state, FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; }, async closeLive() { throw new Error('close offline'); }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { return false; }, plTick() {},
    plSetQuizOpen(open) { order.push(open ? 'overlay-open' : 'overlay-close'); },
    plRenderOverlay() { order.push('overlay-restore'); },
    toast(message) { order.push('toast:' + message); }, console
  };
  loadStageFunctions(['plContinuePlayback', 'plCloseQuestion'], context);

  await assert.rejects(context.plCloseQuestion(), /close offline/);
  assert.equal(order.filter(item => item === 'play').length, 1);
  assert.equal(order.filter(item => item === 'pause').length, 1);
  assert.ok(order.indexOf('overlay-close') < order.indexOf('play'));
  assert.ok(order.indexOf('pause') < order.lastIndexOf('overlay-restore'));
  assert.equal(state.live.q, 0);
  assert.equal(trigger.state()[0], 'open');
  assert.match(state.closeError, /close offline/);
});

test('closeLive 성공 직후 newer live로 바뀐 stale 경로도 이전 재생을 pause하고 새 q1을 보존한다', async () => {
  const order = [];
  const renders = [];
  const trigger = require('../quiz-trigger-core.js').create([{ t: 174, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 173, currentTime: 174, event: 'tick' });
  trigger.open(0);
  const state = {
    sessionId: 'session1', live: { q: 0, openedAt: 1, liveToken: 'token' },
    liveGeneration: 0, dueQuestions: [], fired: [true], quizTrigger: trigger,
    flatQuestions: [{ t: 174, videoIndex: 0 }], set: { settings: {} },
    player: { playVideo() { order.push('play'); }, pauseVideo() { order.push('pause'); } }
  };
  const context = {
    pl: state, FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; },
      async closeLive() {
        state.live = { q: 1, openedAt: 2, liveToken: 'new-token' };
        state.liveGeneration = 1;
        state.dueQuestions = [1];
        return true;
      }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { throw new Error('stale old question must not open due'); }, plTick() {},
    plSetQuizOpen(open) { order.push(open ? 'overlay-open' : 'overlay-close'); },
    plRenderOverlay() { renders.push(state.live.q); }, console
  };
  loadStageFunctions(['plContinuePlayback', 'plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), false);
  assert.deepEqual(order.filter(item => item === 'play'), ['play']);
  assert.deepEqual(order.filter(item => item === 'pause'), ['pause']);
  assert.equal(state.live.q, 1);
  assert.equal(state.liveGeneration, 1);
  assert.deepEqual(state.dueQuestions, [1]);
  assert.equal(trigger.state()[0], 'open');
  assert.equal(renders.at(-1), 1);
});

test('계속 재생 시작기는 YouTube 내부 비동기 rejection과 재생 명령을 분리한다', async () => {
  const ctx = loadStageFunctions(['plContinuePlayback'], {});
  assert.equal((await ctx.plContinuePlayback({ player: { playVideo() { return false; } } })).ok, false);
  assert.equal((await ctx.plContinuePlayback({ player: { playVideo() { throw new Error('blocked'); } } })).ok, false);
  assert.equal((await ctx.plContinuePlayback({ player: {
    playVideo() { return Promise.reject(new Error('youtube anti-adblock fetch')); }
  } })).ok, true);
  assert.equal((await ctx.plContinuePlayback({ player: { playVideo() {} } })).ok, true);
});

test('계속 재생은 명령 반환값이 아니라 실제 YouTube 재생 상태를 확인하고 한 번 복구한다', async () => {
  let state = 2;
  let currentTime = 120;
  let plays = 0;
  let seeks = 0;
  const ctx = loadStageFunctions(['plContinuePlayback'], {});
  const result = await ctx.plContinuePlayback({
    playbackProbeDelay: async () => {
      if (state === 1) currentTime += 0.2;
    },
    player: {
      playVideo() {
        plays += 1;
        if (plays === 2) state = 1;
        return Promise.reject(new Error('youtube anti-adblock fetch'));
      },
      getPlayerState() { return state; },
      getCurrentTime() { return currentTime; },
      seekTo(value) { seeks += 1; currentTime = value; }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(plays, 2);
  assert.equal(seeks, 1);
});

test('계속 재생 명령 뒤에도 YouTube가 멈춰 있으면 live를 완료하지 않는다', async () => {
  const ctx = loadStageFunctions(['plContinuePlayback'], {});
  const result = await ctx.plContinuePlayback({
    playbackProbeDelay: async () => {},
    player: {
      playVideo() {},
      getPlayerState() { return 2; },
      getCurrentTime() { return 120; },
      seekTo() {}
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /재생/);
});

test('지금 공개는 제출 마감 전에도 atomic 공개 쓰기를 보낸다', async () => {
  let reveals = 0;
  const context = {
    pl: {
      sessionId: 'session-a',
      live: { q: 0, accepting: true, revealAt: 5_000 },
      flatQuestions: [{ type: 'choice', answer: 0 }]
    },
    serverNow() { return 2_000; },
    FirestoreStore: {
      liveIdentity(live) { return { q: live.q }; },
      publicAnswer() { return { answer: 0 }; }
    },
    async plExplanationImage() { return ''; },
    plRenderOverlayCounts() {},
    store: { revealLive() { reveals += 1; return true; } }
  };
  loadStageFunctions(['plReveal'], context);

  assert.equal(await context.plReveal(), true);
  assert.equal(reveals, 1);
});

test('repeated Google login clicks share one popup request instead of cancelling each other', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let finishPopup;
  let popupCount = 0;
  const user = { uid: 'google-user' };
  const auth = {
    currentUser: null,
    signInWithPopup() {
      popupCount += 1;
      return new Promise(resolve => {
        finishPopup = () => { this.currentUser = user; resolve({ user }); };
      });
    }
  };
  function authFactory() { return auth; }
  authFactory.GoogleAuthProvider = function GoogleAuthProvider() {};
  const context = {
    teacherUser: null, teacherGoogleSignInFlight: null,
    teacherAuthDialogRevision: 1, teacherAuthVersion: 1,
    firebase: { auth: authFactory },
    teacherEmailAuthOperationIsCurrent() { return true; },
    async applyTeacherUser(value) { context.teacherUser = value; return true; }
  };
  vm.runInNewContext(extractFunction(html, 'signInTeacher'), context);

  const first = context.signInTeacher(1);
  const second = context.signInTeacher(1);
  assert.equal(first, second);
  assert.equal(popupCount, 1);
  finishPopup();
  assert.equal(await first, user);
  assert.equal(context.teacherGoogleSignInFlight, null);
});

test('지금 공개로 제출이 이미 마감되면 원래 grace 시각 전에도 계속 재생한다', async () => {
  let closed = 0;
  const context = {
    pl: {
      sessionId: 'session1',
      live: { q: 0, openedAt: 1, liveToken: 'token', accepting: false, submitGraceUntil: 99_000 },
      liveGeneration: 0, dueQuestions: [], fired: [true],
      flatQuestions: [{ t: 10, videoIndex: 0 }], set: { settings: {} },
      player: { playVideo() {} }
    },
    serverNow() { return 1_000; },
    FirestoreCore: core,
    store: {
      async freezeLive() { return true; }, async getResponses() { return {}; },
      async getGrades() { return {}; }, async closeLive() { closed += 1; return true; }
    },
    async plGradeCurrentResponses() {}, async plPushBoard() {},
    plOpenNextDueQuestion() { return false; }, plTick() {}, plRenderOverlay() {}, console
  };
  loadStageFunctions(['plCloseQuestion'], context);

  assert.equal(await context.plCloseQuestion(), true);
  assert.equal(closed, 1);
});

test('YouTube가 PLAYING을 순간 보고해도 재생 시간이 전진하지 않으면 성공으로 보지 않는다', async () => {
  let plays = 0;
  const ctx = loadStageFunctions(['plContinuePlayback'], {});
  const result = await ctx.plContinuePlayback({
    playbackProbeDelay: async () => {},
    player: {
      playVideo() { plays += 1; },
      getPlayerState() { return 1; },
      getCurrentTime() { return 120; },
      seekTo() {}
    }
  });

  assert.equal(result.ok, false);
  assert.equal(plays, 2);
});

test('player tick은 quiz trigger가 준 문항만 queue하고 완료 직후 같은 시각을 다시 넣지 않는다', () => {
  const trigger = require('../quiz-trigger-core.js').create([{ t: 174, videoIndex: 0 }]);
  const ctx = loadStageFunctions(['plDetectSeek', 'plAutoResumeRemainingMs', 'plAutoResumeDue', 'plQueueDueQuestions'], {
    pl: {
      videoIndex: 0, dueQuestions: [], fired: [false], quizTrigger: trigger,
      flatQuestions: [{ t: 174, videoIndex: 0 }]
    }
  });

  assert.equal(ctx.plQueueDueQuestions(173.5, 174.1), true);
  assert.deepEqual(ctx.pl.dueQuestions, [0]);
  trigger.open(0);
  trigger.complete(0);
  ctx.pl.dueQuestions = [];
  assert.equal(ctx.plQueueDueQuestions(174.1, 174.2), false);
  assert.deepEqual(ctx.pl.dueQuestions, []);
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
  loadStageFunctions(
    ['stQueueWrite', 'stSend', 'stSubmitFailureReason', 'stSubmitFailureText'], context
  );
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
  // 이미 지나간 문항은 다시 시도해 봐야 소용없으므로 사유를 그대로 알린다.
  assert.deepEqual(notices, ['다음 문항으로 넘어가 제출되지 않았습니다']);
});

test('열려 있는 문항의 제출 실패는 학생에게 알리기 전에 한 번 조용히 다시 보낸다', async () => {
  const notices = [];
  const attempts = [];
  const context = {
    st: {
      sessionId: 'session1', authUid: 'student1', sid: 'student1',
      live: { q: 0, revealed: false, limitSec: 0 },
      myAnswers: {}, submitted: false, revision: 1, writeQueues: {}
    },
    store: {
      writeStudentAnswer(sessionId, uid, index, payload) {
        attempts.push(payload.revision);
        return attempts.length === 1
          ? Promise.reject(new Error('permission-denied'))
          : Promise.resolve();
      }
    },
    stRevealed() { return false; },
    stLocked() { return false; },
    setTimeout(callback) { return callback(); },
    stRender() {}, toast(message) { notices.push(message); }, console: { error() {} }
  };
  loadStageFunctions(
    ['stQueueWrite', 'stSend', 'stSubmitFailureReason', 'stSubmitFailureText'], context
  );
  const local = { answer: 0, revision: 1, submitted: true };

  assert.equal(await context.stSend({ answer: 0, revision: 1, submitted: true }, local), true);
  // 두 번째 시도는 revision을 올려 보내야 기존 답안 위에 덮어쓸 수 있다.
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(notices, []);
  assert.equal(context.st.myAnswers[0], local);
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

test('approved teacher dashboard shows today\'s schedule and counts without identities', async () => {
  const panel = { innerHTML: '', isConnected: true };
  let publicReads = 0;
  const plans = {
    a: {
      planId: 'a', className: '2학년 1반', setTitleSnapshot: '분수',
      plannedStartAt: Date.UTC(2026, 7, 20, 1), plannedEndAt: Date.UTC(2026, 7, 20, 2),
      expectedStudents: 35, actualParticipants: 24, status: 'live', warningLevel: 'caution',
      ownerUid: 'teacher-a-uid', ownerEmailCanonical: 'teacher-a@school.kr', ownerDisplayName: '김교사'
    },
    b: {
      planId: 'b', className: '2학년 2반', setTitleSnapshot: '분수',
      plannedStartAt: Date.UTC(2026, 7, 20, 1, 30), plannedEndAt: Date.UTC(2026, 7, 20, 2, 30),
      expectedStudents: 50, actualParticipants: 0, status: 'planned', warningLevel: 'caution',
      ownerUid: 'teacher-b-uid', ownerEmailCanonical: 'teacher-b@school.kr', ownerDisplayName: '박교사'
    }
  };
  const teacher = { uid: 'teacher-a-uid', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' };
  const context = {
    teacherDashboard: null, teacherUser: { uid: 'teacher-a-uid' }, teacherState: teacher, teacherAuthVersion: 7,
    clockUserId: 'teacher-a-uid',
    location: { hash: '#/' }, ClassPlanningCore: require('../class-planning-core.js'),
    AuthCore: require('../auth-core.js'),
    document: {
      body: { contains() { return true; } },
      getElementById(id) { return id === 'teacher-dashboard' ? panel : null; }
    },
    onCleanup() {},
    store: {
      serverNow() { return Date.UTC(2026, 7, 20, 1, 15); },
      async listPublicPlans() { publicReads += 1; return plans; },
      async listOwnClassPlans() { return {}; }
    }
  };
  loadStageFunctions(['stopTeacherDashboard', 'renderTeacherDashboard', 'startTeacherDashboard'], context);

  await context.startTeacherDashboard(teacher);

  assert.match(panel.innerHTML, /현재 진행 1개/);
  assert.match(panel.innerHTML, /실제 참여 24명/);
  assert.match(panel.innerHTML, /예상 동시 참여 85명/);
  assert.match(panel.innerHTML, /노랑/);
  assert.doesNotMatch(panel.innerHTML, /teacher-a@school\.kr|teacher-b@school\.kr|teacher-a-uid|teacher-b-uid|김교사|박교사/);
  await context.startTeacherDashboard(teacher);
  assert.equal(publicReads, 1);
  context.renderTeacherDashboard({ a: { ...plans.a, status: 'ended' } }, teacher, false);
  assert.match(panel.innerHTML, /현재 진행 0개/);
  assert.match(panel.innerHTML, /실제 참여 0명/);
});

test('admin dashboard alone renders teacher identity and stale dashboard work cannot restore A after A to B', async () => {
  const panel = { innerHTML: '', isConnected: true };
  let resolvePlans;
  const admin = { uid: 'admin-a', email: 'admin@school.kr', role: 'admin', status: 'admin' };
  const teacherB = { uid: 'teacher-b', email: 'teacher-b@school.kr', role: 'teacher', status: 'teacher' };
  const context = {
    teacherDashboard: null, teacherUser: { uid: 'admin-a' }, teacherState: admin, teacherAuthVersion: 3,
    clockUserId: 'admin-a',
    location: { hash: '#/' }, ClassPlanningCore: require('../class-planning-core.js'),
    AuthCore: require('../auth-core.js'),
    document: {
      body: { contains() { return true; } },
      getElementById(id) { return id === 'teacher-dashboard' ? panel : null; }
    },
    onCleanup() {},
    store: {
      serverNow() { return Date.UTC(2026, 7, 20, 1, 15); },
      async probeTeacherAllowance() { return { enabled: true, role: 'admin' }; },
      async listPublicPlans() { return {}; },
      listAdminPlans() { return new Promise(resolve => { resolvePlans = resolve; }); },
      async listOwnClassPlans() { return {}; }
    }
  };
  loadStageFunctions(['stopTeacherDashboard', 'renderTeacherDashboard', 'startTeacherDashboard'], context);

  const loadingA = context.startTeacherDashboard(admin);
  await new Promise(resolve => setImmediate(resolve));
  context.teacherState = teacherB;
  context.teacherAuthVersion = 4;
  resolvePlans({ a: {
    planId: 'a', className: '3학년 1반', setTitleSnapshot: '과학',
    plannedStartAt: Date.UTC(2026, 7, 20, 1), plannedEndAt: Date.UTC(2026, 7, 20, 2),
    expectedStudents: 30, status: 'planned', ownerDisplayName: '박교사', ownerEmailCanonical: 'teacher-b@school.kr'
  } });
  await loadingA;
  assert.equal(panel.innerHTML, '');

  context.teacherState = admin;
  context.teacherAuthVersion = 5;
  context.store.listAdminPlans = async () => ({ a: {
    planId: 'a', className: '3학년 1반', setTitleSnapshot: '과학',
    plannedStartAt: Date.UTC(2026, 7, 20, 1), plannedEndAt: Date.UTC(2026, 7, 20, 2),
    expectedStudents: 30, status: 'planned', ownerDisplayName: '박교사', ownerEmailCanonical: 'teacher-b@school.kr'
  } });
  await context.startTeacherDashboard(admin);
  assert.match(panel.innerHTML, /박교사/);
  assert.match(panel.innerHTML, /teacher-b@school\.kr/);
});

test('teacher dashboard stops outside protected home and exposes one explicit retry after a query failure', async () => {
  const panel = { innerHTML: '', isConnected: true };
  let calls = 0;
  const teacher = { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' };
  const context = {
    teacherDashboard: null, teacherUser: { uid: 'teacher-a' }, teacherState: teacher, teacherAuthVersion: 2,
    clockUserId: 'teacher-a',
    location: { hash: '#/' }, ClassPlanningCore: require('../class-planning-core.js'),
    AuthCore: require('../auth-core.js'),
    document: {
      body: { contains() { return true; } },
      getElementById(id) { return id === 'teacher-dashboard' ? panel : null; }
    },
    onCleanup() {},
    store: {
      serverNow() { return Date.UTC(2026, 7, 20, 1, 15); },
      async listPublicPlans() {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return {};
      },
      async listOwnClassPlans() { return {}; }
    }
  };
  loadStageFunctions(['stopTeacherDashboard', 'renderTeacherDashboard', 'startTeacherDashboard', 'retryTeacherDashboard'], context);

  await context.startTeacherDashboard(teacher);
  assert.match(panel.innerHTML, /현황을 불러오지 못했습니다/);
  assert.match(panel.innerHTML, /retryTeacherDashboard/);
  assert.equal(calls, 1);
  await context.retryTeacherDashboard();
  assert.match(panel.innerHTML, /오늘의 수업 현황/);
  assert.equal(calls, 2);
  context.location.hash = '#/join';
  await context.retryTeacherDashboard();
  assert.equal(calls, 2);
});

test('teacher dashboard consumes bounded public plan listener updates and unsubscribes on cleanup', async () => {
  const panel = { innerHTML: '', isConnected: true };
  let nextPlans;
  let unsubscribed = 0;
  const teacher = { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' };
  const context = {
    teacherDashboard: null, teacherUser: { uid: 'teacher-a' }, teacherState: teacher,
    teacherAuthVersion: 2, clockUserId: 'teacher-a', location: { hash: '#/' },
    ClassPlanningCore: require('../class-planning-core.js'), AuthCore: require('../auth-core.js'),
    document: { body: { contains() { return true; } }, getElementById(id) { return id === 'teacher-dashboard' ? panel : null; } },
    onCleanup() {},
    store: {
      serverNow() { return Date.UTC(2026, 7, 20, 1, 15); },
      async listPublicPlans() { return {}; },
      async listOwnClassPlans() { return {}; },
      subscribePublicPlans(from, to, limit, next) {
        assert.equal(limit, 100);
        assert.ok(to > from);
        nextPlans = next;
        return () => { unsubscribed += 1; };
      }
    }
  };
  loadStageFunctions(['stopTeacherDashboard', 'renderTeacherDashboard', 'startTeacherDashboard'], context);

  await context.startTeacherDashboard(teacher);
  nextPlans({ live: {
    planId: 'live', setId: 'set1', setTitleSnapshot: '세트', className: '1반',
    plannedStartAt: Date.UTC(2026, 7, 20, 1), plannedEndAt: Date.UTC(2026, 7, 20, 2),
    expectedStudents: 30, actualParticipants: 3, status: 'live'
  } });
  assert.match(panel.innerHTML, /실제 참여 3명/);
  context.stopTeacherDashboard();
  assert.equal(unsubscribed, 1);
});

test('auth changes synchronously retract populated teacher dashboard DOM before A-to-B or sign-out awaits', async () => {
  const removed = [];
  const panel = { innerHTML: 'teacher-b@school.kr private plan', remove() { removed.push(this.innerHTML); } };
  const userA = { uid: 'teacher-a', email: 'teacher-a@school.kr', emailVerified: true, isAnonymous: false };
  const context = {
    authReady: false, teacherUser: userA, teacherAllowance: { enabled: true, role: 'admin' },
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'admin', status: 'admin' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'admin', status: 'admin' },
    teacherDashboard: { uid: 'teacher-a', authGeneration: 0, panel, stopped: false },
    teacherAuthVersion: 0, clockUserId: 'teacher-a', clockPromise: null, clockPromiseUid: '',
    document: { getElementById(id) { return id === 'teacher-dashboard' ? panel : null; } },
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    store: { async probeTeacherAllowance() { return null; } }, console
  };
  loadStageFunctions(['stopTeacherDashboard', 'clearTeacherDashboard', 'applyTeacherUser'], context);
  let resolveToken;
  const userB = {
    uid: 'teacher-b', email: 'teacher-b@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolveToken = resolve; }); }
  };

  const switching = context.applyTeacherUser(userB);
  assert.deepEqual(removed, ['teacher-b@school.kr private plan']);
  assert.equal(context.teacherDashboard, null);
  resolveToken({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await switching;

  context.teacherDashboard = { uid: 'teacher-b', authGeneration: context.teacherAuthVersion, panel, stopped: false };
  panel.innerHTML = 'teacher-b@school.kr private plan again';
  await context.applyTeacherUser(null);
  assert.deepEqual(removed, [
    'teacher-b@school.kr private plan', 'teacher-b@school.kr private plan again'
  ]);
});

test('same-user admin-to-teacher allowance transition synchronously retracts dashboard private DOM', () => {
  const removed = [];
  const rerenders = [];
  const panel = { innerHTML: 'admin-only teacher-b@school.kr', remove() { removed.push(this.innerHTML); } };
  const context = {
    authReady: true, location: { hash: '#/' }, teacherUser: { uid: 'admin-a', email: 'admin@school.kr', emailVerified: true, isAnonymous: false },
    teacherAllowance: { enabled: true, role: 'admin' },
    teacherState: { uid: 'admin-a', email: 'admin@school.kr', role: 'admin', status: 'admin' },
    appliedTeacherState: { uid: 'admin-a', email: 'admin@school.kr', role: 'admin', status: 'admin' },
    teacherDashboard: { uid: 'admin-a', authGeneration: 3, panel, stopped: false }, teacherAuthVersion: 4,
    document: { getElementById(id) { return id === 'teacher-dashboard' ? panel : null; } },
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    reconcileTeacherRoute() { return false; },
    rerenderEligibleTeacherHome(generation, uid) { rerenders.push([generation, uid]); return true; }
  };
  loadStageFunctions(['stopTeacherDashboard', 'clearTeacherDashboard', 'setTeacherAllowance'], context);

  context.setTeacherAllowance({ enabled: true, role: 'teacher' });

  assert.deepEqual(removed, ['admin-only teacher-b@school.kr']);
  assert.equal(context.teacherDashboard, null);
  assert.equal(context.teacherState.role, 'teacher');
  assert.deepEqual(rerenders, [[4, 'admin-a']]);
});

test('teacher dashboard synchronizes its clock and keeps the KST day query inside the 1448-minute server horizon', async () => {
  const panel = { innerHTML: '', isConnected: true };
  const now = Date.UTC(2026, 7, 20, 6, 0, 0); // 15:00 KST
  const teacher = { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' };
  const queries = [];
  let clockCalls = 0;
  const context = {
    teacherDashboard: null, teacherUser: { uid: 'teacher-a' }, teacherState: teacher,
    teacherAuthVersion: 2, clockUserId: '', location: { hash: '#/' },
    ClassPlanningCore: require('../class-planning-core.js'), AuthCore: require('../auth-core.js'),
    document: { body: { contains() { return true; } }, getElementById(id) { return id === 'teacher-dashboard' ? panel : null; } },
    onCleanup() {},
    async ensureClock(user) { clockCalls += 1; context.clockUserId = user.uid; },
    store: {
      serverNow() { return now; },
      async listPublicPlans(from, to, limit) { queries.push([from, to, limit]); return {}; },
      async listOwnClassPlans() { return {}; }
    }
  };
  loadStageFunctions(['stopTeacherDashboard', 'renderTeacherDashboard', 'startTeacherDashboard'], context);

  await context.startTeacherDashboard(teacher);

  assert.equal(clockCalls, 1);
  assert.deepEqual(queries, [[
    now - (24 * 60 + 7) * 60_000,
    Date.UTC(2026, 7, 20, 15, 0, 0),
    100
  ]]);
});

test('teacher dashboard shows actions only for the caller own planned public row and excludes ended or cancelled plans', async () => {
  const panel = { innerHTML: '', isConnected: true };
  const teacher = { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' };
  const publicPlans = {
    own: { planId: 'own', setId: 'set-own', setTitleSnapshot: '내 세트', className: '내 반', plannedStartAt: 10_000, plannedEndAt: 20_000, expectedStudents: 20, status: 'planned' },
    other: { planId: 'other', setId: 'set-other', setTitleSnapshot: '다른 세트', className: '다른 반', plannedStartAt: 10_000, plannedEndAt: 20_000, expectedStudents: 20, status: 'planned' },
    ended: { planId: 'ended', setId: 'set-ended', setTitleSnapshot: '종료', className: '종료 반', plannedStartAt: 10_000, plannedEndAt: 20_000, expectedStudents: 99, actualParticipants: 99, status: 'ended' },
    cancelled: { planId: 'cancelled', setId: 'set-cancelled', setTitleSnapshot: '취소', className: '취소 반', plannedStartAt: 10_000, plannedEndAt: 20_000, expectedStudents: 99, status: 'cancelled' }
  };
  const routes = [];
  const context = {
    teacherDashboard: null, teacherUser: { uid: 'teacher-a' }, teacherState: teacher,
    teacherAuthVersion: 3, clockUserId: 'teacher-a', location: { hash: '#/' },
    ClassPlanningCore: require('../class-planning-core.js'), AuthCore: require('../auth-core.js'),
    document: { body: { contains() { return true; } }, getElementById(id) { return id === 'teacher-dashboard' ? panel : null; } },
    onCleanup() {}, go(route) { routes.push(route); },
    store: {
      serverNow() { return 12_000; },
      async listPublicPlans() { return publicPlans; },
      async listOwnClassPlans() { return { own: { planId: 'own', revision: 4, status: 'planned' } }; }
    }
  };
  loadStageFunctions(['stopTeacherDashboard', 'renderTeacherDashboard', 'startTeacherDashboard', 'teacherDashboardPlanAction'], context);

  await context.startTeacherDashboard(teacher);

  assert.match(panel.innerHTML, /계획 수정/);
  assert.match(panel.innerHTML, /수업 시작/);
  assert.doesNotMatch(panel.innerHTML, /종료 반|취소 반|teacher-a|teacher-b/);
  assert.equal((panel.innerHTML.match(/계획 수정/g) || []).length, 1);
  assert.equal(context.teacherDashboardPlanAction('other', 'start'), false);
  assert.equal(context.teacherDashboardPlanAction('own', 'edit'), true);
  assert.deepEqual(routes, ['play/set-own?plan=own&revision=4&mode=edit']);
});

test('production class-planning stop skips dashboard reads and blocks dashboard and direct-route entry points', async () => {
  const panel = { innerHTML: 'loading', isConnected: true };
  let reads = 0;
  const routes = [];
  const context = {
    classPlanningUiEnabled: false,
    teacherDashboard: {
      stopped: false, isCurrent() { return true; },
      ownPlans: { own: { planId: 'own', revision: 1, status: 'planned' } },
      publicPlans: { own: { planId: 'own', setId: 'set-own', status: 'planned' } }
    },
    teacherAuthVersion: 1,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' },
    location: { hash: '#/' }, AuthCore: require('../auth-core.js'),
    document: { getElementById(id) { return id === 'teacher-dashboard' ? panel : null; } },
    store: {
      async listPublicPlans() { reads += 1; return {}; },
      async listOwnClassPlans() { reads += 1; return {}; }
    },
    go(route) { routes.push(route); }
  };
  loadStageFunctions(['stopTeacherDashboard', 'startTeacherDashboard', 'teacherDashboardPlanAction'], context);

  assert.equal(await context.startTeacherDashboard(context.teacherState), false);
  assert.equal(reads, 0);
  assert.equal(context.teacherDashboardPlanAction('own', 'edit'), false);
  assert.deepEqual(routes, []);

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /const canShowClassPlanningDashboard = canShowTeacherDashboard &&/);
  assert.match(html, /\(canShowClassPlanningDashboard\s*\? '<section id="teacher-dashboard"/);
  assert.match(html, /routeClassPlan:\s*\(typeof classPlanningUiEnabled === 'undefined' \|\| classPlanningUiEnabled\)\s*&& routeClassPlan\s*\? routeClassPlan : null/);
});

test('own class plan direct read returns the exact current owner plan and rejects a mismatched identity', async () => {
  const pair = storedClassPlanPair({ revision: 7 });
  const fake = makeFirestoreFake({
    'class_plans_private/plan-a': pair.storedPrivate
  });
  const store = createStore(fake);

  const plan = await store.getOwnClassPlan('plan-a', {
    uid: 'teacher-a', email: 'teacher@school.kr'
  });

  assert.equal(plan.planId, 'plan-a');
  assert.equal(plan.revision, 7);
  assert.equal(plan.ownerUid, 'teacher-a');
  await assert.rejects(store.getOwnClassPlan('plan-a', {
    uid: 'teacher-b', email: 'teacher-b@school.kr'
  }), /owner|identity|신원/);
});

test('selected class-plan loader server-rechecks exact planned owner, revision, and set before enabling the route', async () => {
  const selected = {
    planId: 'plan-a', revision: 7, status: 'planned', setId: 'set-a',
    ownerUid: 'teacher-a', ownerEmailCanonical: 'teacher-a@school.kr',
    className: '2학년 3반', plannedStartAt: 10_000, plannedEndAt: 20_000,
    expectedStudents: 30, createdAtMs: 8_000
  };
  const state = { setId: 'set-a' };
  const context = {
    pl: state,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher', status: 'teacher' },
    teacherAuthVersion: 4,
    AuthCore: require('../auth-core.js'),
    store: { async getOwnClassPlan() { return { ...selected }; } }
  };
  loadStageFunctions(['plLoadSelectedClassPlan'], context);

  assert.equal(await context.plLoadSelectedClassPlan(state, {
    planId: 'plan-a', revision: 7, mode: 'start'
  }), true);
  assert.equal(state.classPlanPersisted, true);
  assert.equal(state.classPlanId, 'plan-a');
  assert.equal(state.classPlanRevision, 7);
  assert.equal(state.selectedClassPlan.ownerUid, 'teacher-a');

  context.store.getOwnClassPlan = async () => ({ ...selected, revision: 8 });
  await assert.rejects(context.plLoadSelectedClassPlan(state, {
    planId: 'plan-a', revision: 7, mode: 'start'
  }), /revision|변경|일치/);
});

test('selected planned class starts by allocation then attaches its existing revision without creating a new plan', async () => {
  const events = [];
  let creates = 0;
  const context = {
    ...pendingAllocationTestContext(),
    pl: {
      setId: 'set1', set: { title: '세트', author: '교사', videos: [] }, flatQuestions: [],
      selectedClassPlan: { planId: 'plan-existing', revision: 7, status: 'planned', className: '선택한 2학년 3반' },
      classPlanId: 'plan-existing', classPlanRevision: 7, classPlanPersisted: true
    },
    teacherState: { status: 'teacher', uid: 'teacher-1', email: 'teacher@school.kr', role: 'teacher' },
    AuthCore: require('../auth-core.js'), PlaylistCore: require('../playlist-core.js'),
    $() { return { value: '' }; }, lsSet() {},
    rid(length) { return length === 12 ? 'SESSION-EXIST' : length === 24 ? 'token-existing-123456789012' : 'CODE12'; },
    SV_TS: SERVER_TIMESTAMP, normSet(value) { return value; }, imgCache: {},
    store: {
      async createClassPlan() { creates += 1; throw new Error('must not create'); },
      async getQuizSetSnapshot() { events.push('snapshot'); return { setSnapshot: context.pl.set, snapshotImages: {} }; },
      async startSession(sessionId, session) { events.push(['allocate', sessionId, session.label]); return 'CODE12'; },
      async activateSessionAllocation() { events.push('activate'); return true; },
      async attachPlanToSession(planId, sessionId, owner) {
        events.push(['attach', planId, sessionId, owner.expectedRevision]);
        return { revision: 8 };
      }
    },
    renderPlayRun() { events.push('render'); }, alert() {}, console
  };
  loadStageFunctions(['plStartSessionHeartbeat', 'plStartSession'], context);

  await context.plStartSession();

  assert.equal(creates, 0);
  assert.deepEqual(events, [
    'snapshot', ['allocate', 'SESSION-EXIST', '선택한 2학년 3반'], 'activate',
    ['attach', 'plan-existing', 'SESSION-EXIST', 7], 'render'
  ]);
  assert.equal(context.pl.classPlanRevision, 8);
});

test('editing a selected planned class updates its exact revision, reports success, and never starts a session', async () => {
  const calls = [];
  const alerts = [];
  const toasts = [];
  const warning = { textContent: '', className: '' };
  const ack = { checked: true };
  const dialog = { close() {} };
  const reviewed = {
    planId: 'plan-existing', revision: 7, ownerUid: 'teacher-a',
    ownerEmailCanonical: 'teacher-a@school.kr', setId: 'set-a', className: '2학년 3반',
    plannedStartAt: 60_000, plannedEndAt: 120_000, expectedStudents: 30,
    warningLevel: 'green', status: 'planned'
  };
  const elements = {
    '#pl-plan-class-name': { value: '2학년 3반' },
    '#pl-plan-start': { value: '1970-01-01T09:00' },
    '#pl-plan-end': { value: '1970-01-01T09:00' },
    '#pl-plan-expected': { value: '30' },
    '#pl-plan-warning': warning, '#pl-plan-ack': ack, '#pl-plan-dialog': dialog
  };
  const context = {
    pl: {
      setId: 'set-a',
      selectedClassPlan: { ...reviewed },
      pendingClassPlanReview: { privatePlan: { ...reviewed }, authGeneration: 3 }
    },
    teacherState: { status: 'teacher', uid: 'teacher-a', email: 'teacher-a@school.kr', role: 'teacher' },
    teacherAuthVersion: 3, AuthCore: require('../auth-core.js'),
    $(selector) { return elements[selector] || null; }, lsSet() {}, alert(message) { alerts.push(message); },
    store: {
      serverNow() { return 30_000; },
      async updateOwnClassPlan(planId, revision, updates) {
        calls.push([planId, revision, updates]);
        return { ...reviewed, ...updates, revision: 8, status: 'planned' };
      },
      async createClassPlan() { throw new Error('must not create'); }
    },
    toast(message) { toasts.push(message); },
    async plStartSession() { calls.push('start'); return true; }
  };
  // datetime-local comparisons are intentionally expressed as matching local test values.
  elements['#pl-plan-start'].value = new Date(60_000 - new Date(60_000).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  elements['#pl-plan-end'].value = new Date(120_000 - new Date(120_000).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  loadStageFunctions(['plConfirmClassPlan'], context);

  assert.equal(await context.plConfirmClassPlan(), true, alerts.join('\n'));
  assert.deepEqual(clone(calls), [[
    'plan-existing', 7, {
      className: '2학년 3반', plannedStartAt: 60_000, plannedEndAt: 120_000,
      expectedStudents: 30, warningLevel: 'green', warningAcknowledgedAt: 30_000
    }
  ]]);
  assert.equal(context.pl.classPlanPersisted, true);
  assert.equal(context.pl.classPlanId, 'plan-existing');
  assert.equal(context.pl.classPlanRevision, 8);
  assert.deepEqual(toasts, ['수업계획을 수정했습니다.']);
});

test('eligible current home rerenders once for only its matching auth generation', () => {
  const calls = [];
  const context = {
    teacherAuthVersion: 5, location: { hash: '#/' },
    teacherState: { uid: 'teacher-b', email: 'teacher-b@school.kr', role: 'teacher', status: 'teacher' },
    AuthCore: require('../auth-core.js'),
    screenHome() { calls.push(context.teacherState.uid); }
  };
  loadStageFunctions(['rerenderEligibleTeacherHome'], context);

  assert.equal(context.rerenderEligibleTeacherHome(5, 'teacher-b'), true);
  assert.equal(context.rerenderEligibleTeacherHome(4, 'teacher-b'), false);
  assert.equal(context.rerenderEligibleTeacherHome(5, 'teacher-a'), false);
  context.location.hash = '#/sets';
  assert.equal(context.rerenderEligibleTeacherHome(5, 'teacher-b'), false);
  assert.deepEqual(calls, ['teacher-b']);
});

test('home auth replacement rerenders only the resolved current eligible teacher generation', async () => {
  const resolvers = {};
  const homeRenders = [];
  const context = {
    authReady: true, location: { hash: '#/' }, teacherRequestReroute: null,
    teacherUser: null, teacherAllowance: null, teacherState: null, appliedTeacherState: null,
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    reconcileTeacherRoute() { return false; },
    rerenderEligibleTeacherHome(generation, uid) { homeRenders.push([generation, uid]); return true; },
    store: { async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; } }, console
  };
  loadStageFunctions(['applyTeacherUser'], context);
  const user = uid => ({ uid, email: uid + '@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return new Promise(resolve => { resolvers[uid] = resolve; }); } });

  const applyingA = context.applyTeacherUser(user('teacher-a'));
  const applyingB = context.applyTeacherUser(user('teacher-b'));
  await Promise.resolve();
  resolvers['teacher-b']({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingB;
  resolvers['teacher-a']({ claims: { firebase: { sign_in_provider: 'google.com' } } });
  await applyingA;

  assert.deepEqual(homeRenders, [[2, 'teacher-b']]);
});

test('request-marker home router and dashboard rerender are mutually exclusive', async () => {
  const events = [];
  const context = {
    authReady: true, location: { hash: '#/' }, teacherRequestReroute: null,
    teacherUser: { uid: 'teacher-a', email: 'teacher-a@school.kr' }, teacherAllowance: null,
    teacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    appliedTeacherState: { uid: 'teacher-a', email: 'teacher-a@school.kr', status: 'unapproved' },
    clockUserId: '', clockPromise: null, clockPromiseUid: '', teacherAuthVersion: 0,
    AuthCore: require('../auth-core.js'), renderTeacherAuthArea() {},
    clearTeacherRequestScreen() { return true; },
    reconcileTeacherRoute() { return false; },
    router() { events.push('router'); },
    rerenderEligibleTeacherHome() { events.push('rerender'); return true; },
    store: { async probeTeacherAllowance() { return { enabled: true, role: 'teacher' }; } }, console
  };
  loadStageFunctions(['applyTeacherUser'], context);
  const user = {
    uid: 'teacher-a', email: 'teacher-a@school.kr', emailVerified: true, isAnonymous: false,
    getIdTokenResult() { return Promise.resolve({ claims: { firebase: { sign_in_provider: 'google.com' } } }); }
  };

  await context.applyTeacherUser(user);

  assert.deepEqual(events, ['router']);
});

const PublicQuizLibraryCore = require('../public-quiz-library-core.js');

function publicLibraryActor(uid = 'owner', email = 'owner@school.kr', overrides = {}) {
  return {
    uid, email, displayName: uid === 'owner' ? '홍교사' : '김교사', role: 'teacher',
    ...overrides
  };
}

function publicLibraryAllowance(uid = 'owner', email = 'owner@school.kr', overrides = {}) {
  return {
    uid, emailCanonical: email, role: 'teacher', status: 'active', enabled: true,
    displayName: uid === 'owner' ? '홍교사' : '김교사', revision: 1, ...overrides
  };
}

function publicLibrarySource(overrides = {}) {
  return {
    title: '공개 과학 퀴즈',
    description: '힘과 운동 복습',
    settings: { revealMode: 'timer', limitSec: 20, revealDelaySec: 5, autoPause: true },
    videos: [{
      videoId: 'dQw4w9WgXcQ',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      startSec: 0,
      endSec: 120,
      questions: [{
        type: 'choice', t: 10, text: '힘의 단위는?', choices: ['N', 'm'], answer: 0,
        imgUp: true
      }]
    }],
    ownerUid: 'owner', ownerEmail: 'owner@school.kr',
    lifecycleState: 'active', collaboratorCount: 0, imageCount: 0,
    contentRevision: 'rev-1',
    ...overrides
  };
}

function publicLibraryFullProjection(id = 'set-1', options = {}) {
  const revision = options.revision || 'rev-1';
  const source = publicLibrarySource({
    imageCount: options.imageCount ?? 0,
    contentRevision: revision
  });
  const projection = PublicQuizLibraryCore.buildProjection(source, {
    setId: id,
    authorDisplayName: options.authorDisplayName || '홍교사',
    revision,
    nowMs: options.updatedAtMs ?? 1_000
  });
  return {
    ...projection,
    status: 'published', moderationStatus: 'clear',
    publishedAt: new Timestamp(
      options.publishedAtMs ?? Math.min(900, options.updatedAtMs ?? 1_000)
    ),
    updatedAt: new Timestamp(options.updatedAtMs ?? 1_000),
    ...(options.patch || {})
  };
}

function publicLibraryFlat(id = 'set-1', options = {}, buildToken = 'build-token-1') {
  return PublicQuizLibraryCore.flattenProjection(
    publicLibraryFullProjection(id, options), buildToken
  );
}

function publicLibraryProjection(id = 'set-1', options = {}) {
  return publicLibraryFlat(id, options).parent;
}

function publicLibraryStoredDocuments(id = 'set-1', options = {}, buildToken = 'build-token-1') {
  const flat = publicLibraryFlat(id, options, buildToken);
  return {
    [`published_quiz_sets/${id}`]: flat.parent,
    ...Object.fromEntries(Object.entries(flat.videos).map(([key, value]) => [
      `published_quiz_sets/${id}/videos/${key}`, value
    ])),
    ...Object.fromEntries(Object.entries(flat.questions).map(([key, value]) => [
      `published_quiz_sets/${id}/questions/${key}`, value
    ]))
  };
}

const PUBLIC_LIBRARY_IMAGE_A = 'data:image/png;base64,AAAA';
const PUBLIC_LIBRARY_IMAGE_B = 'data:image/png;base64,BBBB';

test('publish rejects unsafe or allowance-mismatched public author labels before creating a projection', async t => {
  for (const entry of [
    {
      name: 'email-shaped allowance label',
      allowanceName: 'owner@school.kr', actorName: 'owner@school.kr'
    },
    {
      name: 'UID-like allowance label',
      allowanceName: 'AbCDefghijklmnopqrst1234', actorName: 'AbCDefghijklmnopqrst1234'
    },
    {
      name: 'actor and allowance display-name mismatch',
      allowanceName: '홍교사', actorName: '다른교사'
    }
  ]) {
    await t.test(entry.name, async () => {
      const fake = makeFirestoreFake({
        'quiz_sets/set-1': publicLibrarySource(),
        'teacher_allowances/owner': publicLibraryAllowance('owner', 'owner@school.kr', {
          displayName: entry.allowanceName
        })
      });
      await assert.rejects(() => createStore(fake).publishQuizSet('set-1',
        publicLibraryActor('owner', 'owner@school.kr', { displayName: entry.actorName })
      ), /표시 이름|author|displayName|allowance/i);
      assert.equal(fake.value('published_quiz_sets/set-1'), undefined);
    });
  }
});

test('publish keeps a building projection hidden until bound images and the source reread finalize', async () => {
  const source = publicLibrarySource({ imageCount: 2 });
  source.videos[0].questions[0].reviewerEmail = 'private-reviewer@school.kr';
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': source,
    'teacher_allowances/owner': publicLibraryAllowance(),
    'images/set-1/q/v0q0': { data: PUBLIC_LIBRARY_IMAGE_A },
    'images/set-1/q/v0q0e': { data: 'HTTPS://images.example/explanation.png' }
  }, { committedServerMillis: 1_000 });
  const store = createStore(fake, () => 1_000);

  const result = await store.publishQuizSet('set-1', publicLibraryActor());

  assert.equal(result.status, 'published');
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'published');
  assert.equal(fake.value('published_quiz_sets/set-1').buildToken, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').buildVideoCount, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').buildQuestionCount, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').buildImageCount, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').ownerUid, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').ownerEmail, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').publishedAt instanceof Timestamp, true);
  assert.equal(fake.value('published_quiz_sets/set-1').updatedAt instanceof Timestamp, true);
  assert.equal(fake.value('published_quiz_sets/set-1').publishedAtMs, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').updatedAtMs, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').videos, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').settings, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').revealMode, 'timer');
  assert.ok(
    fake.value('published_quiz_sets/set-1').updatedAt.toMillis() >=
      fake.value('published_quiz_sets/set-1').publishedAt.toMillis()
  );
  assert.equal(fake.value('published_quiz_sets/set-1/images/v0q0').data, PUBLIC_LIBRARY_IMAGE_A);
  assert.equal(fake.value('published_quiz_sets/set-1/images/v0q0').revision, 'rev-1');
  assert.equal(fake.value('published_quiz_sets/set-1/images/v0q0e').data,
    'https://images.example/explanation.png');
  assert.equal(fake.value('published_quiz_sets/set-1/videos/v0').videoKey, 'v0');
  assert.equal(fake.value('published_quiz_sets/set-1/questions/v0q0').questionKey, 'v0q0');
  assert.equal(fake.value('published_quiz_sets/set-1/questions/v0q0').reviewerEmail, undefined);
  assert.equal(result.videos[0].questions[0].text, '힘의 단위는?');

  const calls = fake.calls();
  const buildingIndex = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1' && call.value.status === 'building');
  const imageIndex = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1/images/v0q0');
  const publishedIndex = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1' && call.value.status === 'published');
  const authoritativePublishedRead = calls.findIndex((call, index) => index > publishedIndex &&
    call.operation === 'get' && call.path === 'published_quiz_sets/set-1');
  const finalSourceRead = calls.findLastIndex(call => call.operation === 'transactionGet' &&
    call.path === 'quiz_sets/set-1');
  assert.ok(buildingIndex >= 0 && buildingIndex < imageIndex);
  assert.ok(imageIndex < finalSourceRead && finalSourceRead < publishedIndex);
  assert.ok(publishedIndex < authoritativePublishedRead);
  assert.equal(calls[buildingIndex].value.updatedAt, SERVER_TIMESTAMP);
  assert.equal(calls[publishedIndex].value.publishedAt, SERVER_TIMESTAMP);
  assert.equal(calls[publishedIndex].value.updatedAt, SERVER_TIMESTAMP);
});

test('탈퇴 lifecycle UI actor는 인증 세대와 현재 route에 묶인다', async () => {
  let capturedActor;
  const state = {
    uid: 'owner-uid', authGeneration: 4,
    allowance: { uid: 'owner-uid', status: 'active' }, busy: false
  };
  const context = {
    teacherDeletionScreen: state,
    teacherAuthVersion: 4,
    teacherUser: { uid: 'owner-uid', email: 'owner@school.kr' },
    teacherState: {
      uid: 'owner-uid', email: 'owner@school.kr', role: 'teacher', status: 'teacher'
    },
    location: { hash: '#/' },
    renderTeacherDeletion() {},
    alert() {},
    store: {
      async requestTeacherDeletion(uid, actor) {
        assert.equal(uid, 'owner-uid');
        capturedActor = actor;
        context.location.hash = '#/admin';
        throw new Error('stale lifecycle route');
      }
    }
  };
  loadStageFunctions(['teacherDeletionScreenIsCurrent', 'requestTeacherDeletion'], context);

  assert.equal(await context.requestTeacherDeletion({ value: '계정 사용 종료 요청' }), false);
  assert.equal(capturedActor.authGeneration, 4);
  assert.equal(capturedActor.currentAuthGeneration, 4);
  assert.equal(capturedActor.isCurrent(), false);
});

test('publish rejects collaborator authority, stale source revision, trash, and suspended owner without exposure', async t => {
  await t.test('collaborator authority', async () => {
    const fake = makeFirestoreFake({
      'quiz_sets/set-1': publicLibrarySource(),
      'teacher_allowances/editor': publicLibraryAllowance('editor', 'editor@school.kr'),
      'quiz_sets/set-1/collaborators/editor%40school.kr': {
        uid: 'editor', email: 'editor@school.kr', role: 'editor'
      }
    });
    await assert.rejects(
      () => createStore(fake).publishQuizSet(
        'set-1', publicLibraryActor('editor', 'editor@school.kr')
      ),
      /소유자/
    );
    assert.equal(fake.value('published_quiz_sets/set-1'), undefined);
  });

  await t.test('stale source revision', async () => {
    let fake;
    fake = makeFirestoreFake({
      'quiz_sets/set-1': publicLibrarySource(),
      'teacher_allowances/owner': publicLibraryAllowance()
    }, {
      beforeTransactionStart({ attempt, set }) {
        if (attempt === 1) {
          set('quiz_sets/set-1', {
            ...fake.value('quiz_sets/set-1'), contentRevision: 'rev-2'
          });
        }
      }
    });
    await assert.rejects(
      () => createStore(fake).publishQuizSet('set-1', publicLibraryActor()),
      /revision|리비전|변경/
    );
    assert.equal(fake.value('published_quiz_sets/set-1'), undefined);
  });

  for (const [name, source, allowance] of [
    ['trash source', publicLibrarySource({ lifecycleState: 'trashed', trashedAt: 10 }), publicLibraryAllowance()],
    ['suspended owner', publicLibrarySource(), publicLibraryAllowance('owner', 'owner@school.kr', {
      status: 'suspended', enabled: false
    })]
  ]) {
    await t.test(name, async () => {
      const fake = makeFirestoreFake({
        'quiz_sets/set-1': source,
        'teacher_allowances/owner': allowance
      });
      await assert.rejects(
        () => createStore(fake).publishQuizSet('set-1', publicLibraryActor()),
        /active|활성|승인|중지/
      );
      assert.equal(fake.value('published_quiz_sets/set-1'), undefined);
    });
  }
});

test('publish resumes a partial image build while every incomplete attempt stays hidden', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({ imageCount: 2 }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'images/set-1/q/v0q0': { data: PUBLIC_LIBRARY_IMAGE_A },
    'images/set-1/q/v0q0e': { data: PUBLIC_LIBRARY_IMAGE_B }
  }, {
    failTransactionAfterCommitAt: 4,
    failTransactionAfterCommitMessage: 'partial public image write'
  });
  const store = createStore(fake);

  await assert.rejects(
    () => store.publishQuizSet('set-1', publicLibraryActor()),
    /partial public image write/
  );
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'building');
  assert.equal(fake.value('published_quiz_sets/set-1').buildImageCount, 1);
  assert.equal(await store.getPublishedQuizSet('set-1'), null);

  const result = await store.publishQuizSet('set-1', publicLibraryActor());
  assert.equal(result.status, 'published');
  assert.equal(fake.value('published_quiz_sets/set-1/images/v0q0').data, PUBLIC_LIBRARY_IMAGE_A);
  assert.equal(fake.value('published_quiz_sets/set-1/images/v0q0e').data, PUBLIC_LIBRARY_IMAGE_B);
});

test('republish preserves the first publishedAt through a failed hidden build and retry', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({ imageCount: 1 }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'images/set-1/q/v0q0': { data: PUBLIC_LIBRARY_IMAGE_A },
    'published_quiz_sets/set-1': publicLibraryProjection('set-1', {
      imageCount: 1,
      publishedAtMs: 400,
      updatedAtMs: 600,
      patch: { status: 'withdrawn' }
    }),
    'published_quiz_sets/set-1/images/v0q0': {
      data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1',
      schemaVersion: 1, buildToken: 'first-build'
    }
  }, {
    committedServerMillis: 1_000,
    failTransactionAt: 4,
    failTransactionMessage: 'planned republish image failure'
  });
  const store = createStore(fake, () => 1_000);

  await assert.rejects(
    () => store.publishQuizSet('set-1', publicLibraryActor()),
    /planned republish image failure/
  );
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'building');
  assert.equal(fake.value('published_quiz_sets/set-1').publishedAt.toMillis(), 400);

  const result = await store.publishQuizSet('set-1', publicLibraryActor());
  assert.equal(result.status, 'published');
  assert.equal(result.publishedAt.toMillis(), 400);
  assert.equal(result.updatedAt.toMillis(), 1_000);
  const finalWrite = fake.calls().findLast(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1' && call.value.status === 'published');
  assert.equal(finalWrite.value.publishedAt instanceof Timestamp, true);
  assert.equal(finalWrite.value.publishedAt.toMillis(), 400);
  assert.equal(finalWrite.value.updatedAt, SERVER_TIMESTAMP);
});

test('publish refuses to overwrite a building projection from another source revision and token', async () => {
  const oldProjection = PublicQuizLibraryCore.buildProjection(publicLibrarySource(), {
    setId: 'set-1', authorDisplayName: '홍교사', revision: 'rev-old', nowMs: 1_000
  });
  const oldParent = PublicQuizLibraryCore.flattenProjection(
    oldProjection, 'other-build'
  ).parent;
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({ contentRevision: 'rev-new' }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'published_quiz_sets/set-1': {
      ...oldParent, buildToken: 'other-build', buildVideoCount: 0,
      buildQuestionCount: 0, buildImageCount: 0
    }
  });

  await assert.rejects(
    () => createStore(fake).publishQuizSet('set-1', publicLibraryActor()),
    /building|게시 작업|revision|리비전/
  );
  assert.equal(fake.value('published_quiz_sets/set-1').buildToken, 'other-build');
});

test('publish fails closed when source content drifts without changing its revision', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({ title: 'revision 없이 바뀐 제목' }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    ...publicLibraryStoredDocuments('set-1')
  });

  await assert.rejects(
    () => createStore(fake).publishQuizSet('set-1', publicLibraryActor()),
    /content|projection|revision|리비전|불일치/
  );
  assert.equal(fake.value('published_quiz_sets/set-1').title, '공개 과학 퀴즈');
});

test('publish rebuilds the normalized source fingerprint inside every image transaction', async () => {
  let fake;
  fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({ imageCount: 1 }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'images/set-1/q/v0q0': { data: PUBLIC_LIBRARY_IMAGE_A }
  }, {
    beforeTransactionStart({ attempt, set }) {
      if (attempt === 2) {
        set('quiz_sets/set-1', {
          ...fake.value('quiz_sets/set-1'),
          title: 'revision 없이 transaction 사이에 바뀐 제목'
        });
      }
    }
  });

  await assert.rejects(
    () => createStore(fake).publishQuizSet('set-1', publicLibraryActor()),
    /content|projection|fingerprint|revision|변경|불일치/
  );
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'building');
  assert.equal(fake.value('published_quiz_sets/set-1').buildImageCount, 0);
  assert.equal(fake.value('published_quiz_sets/set-1/images/v0q0'), undefined);
});

test('withdraw uses owner and source revision CAS and immediately hides the projection', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource(),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'published_quiz_sets/set-1': publicLibraryProjection()
  });
  const store = createStore(fake);

  const result = await store.withdrawPublishedQuizSet('set-1', publicLibraryActor());

  assert.equal(result.status, 'withdrawn');
  assert.equal(result.updatedAt instanceof Timestamp, true);
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'withdrawn');
  assert.equal(await store.getPublishedQuizSet('set-1'), null);
  const withdrawalWrite = fake.calls().findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1' && call.value.status === 'withdrawn');
  assert.equal(fake.calls()[withdrawalWrite].value.updatedAt, SERVER_TIMESTAMP);
  assert.ok(fake.calls().some((call, index) => index > withdrawalWrite &&
    call.operation === 'get' && call.path === 'published_quiz_sets/set-1'));

  const stale = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({ contentRevision: 'rev-2' }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'published_quiz_sets/set-1': publicLibraryProjection()
  });
  await assert.rejects(
    () => createStore(stale).withdrawPublishedQuizSet('set-1', publicLibraryActor()),
    /revision|리비전/
  );
  assert.equal(stale.value('published_quiz_sets/set-1').status, 'published');
});

test('withdraw lowers visibility despite same-revision source content and counter drift', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({
      title: 'revision을 올리지 않고 바뀐 private 제목',
      imageCount: -1
    }),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'published_quiz_sets/set-1': publicLibraryProjection()
  });

  const result = await createStore(fake).withdrawPublishedQuizSet(
    'set-1', publicLibraryActor()
  );

  assert.equal(result.status, 'withdrawn');
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'withdrawn');
  assert.equal(fake.value('published_quiz_sets/set-1').title, '공개 과학 퀴즈');
});

test('trash atomically withdraws a published set and restore remains private', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource(),
    'teacher_allowances/owner': publicLibraryAllowance(),
    ...publicLibraryStoredDocuments('set-1')
  });
  const store = createStore(fake);

  await store.moveSetToTrash('set-1', publicLibraryActor());

  assert.equal(fake.value('quiz_sets/set-1').lifecycleState, 'trashed');
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'withdrawn');
  const trashWrites = fake.calls().filter(call => call.operation === 'transactionSet');
  assert.ok(trashWrites.some(call => call.path === 'quiz_sets/set-1' &&
    call.value.lifecycleState === 'trashed'));
  assert.ok(trashWrites.some(call => call.path === 'published_quiz_sets/set-1' &&
    call.value.status === 'withdrawn'));

  await store.restoreSet('set-1', publicLibraryActor());

  assert.equal(fake.value('quiz_sets/set-1').lifecycleState, 'active');
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'withdrawn');
});

test('trash cancels an unfinished publication and restore can republish with a fresh build', async () => {
  const flat = publicLibraryFlat('set-building', {}, 'abandoned-build-token');
  const building = {
    ...flat.parent,
    status: 'building',
    publishedAt: null,
    buildToken: 'abandoned-build-token',
    buildVideoCount: 0,
    buildQuestionCount: 0,
    buildImageCount: 0
  };
  const fake = makeFirestoreFake({
    'quiz_sets/set-building': publicLibrarySource(),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'published_quiz_sets/set-building': building
  }, { committedServerMillis: 2_000 });
  const store = createStore(fake, () => 2_000);

  await store.moveSetToTrash('set-building', publicLibraryActor());
  assert.equal(fake.value('published_quiz_sets/set-building').status, 'cancelled');
  assert.equal(fake.value('published_quiz_sets/set-building').buildToken,
    'abandoned-build-token');

  await store.restoreSet('set-building', publicLibraryActor());
  const result = await store.publishQuizSet('set-building', publicLibraryActor());

  assert.equal(result.status, 'published');
  assert.equal(fake.value('published_quiz_sets/set-building').status, 'published');
  assert.notEqual(fake.calls().findLast(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-building' && call.value.status === 'building')
    .value.buildToken, 'abandoned-build-token');
});

test('exact-owner lifecycle audit includes legacy sources missing lifecycleState', async () => {
  const legacy = publicLibrarySource();
  delete legacy.lifecycleState;
  const fake = makeFirestoreFake({
    'teacher_allowances/owner': publicLibraryAllowance(),
    'quiz_sets/legacy-set': legacy,
    'published_quiz_sets/legacy-set': publicLibraryProjection('legacy-set')
  });

  const page = await createStore(fake).auditOwnedPublications('owner', 50, null);

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].publicationId, 'legacy-set');
  const query = fake.calls().find(call => call.operation === 'getCollection' &&
    call.path === 'quiz_sets');
  assert.equal(query.filters.some(filter => filter.field === 'lifecycleState'), false);
});

test('lifecycle lock is committed before withdrawal and consumed with suspension', async () => {
  const approvedAt = new Timestamp(1);
  let fake;
  fake = makeFirestoreFake({
    'teacher_allowances/admin-uid': activeTeacherAllowance({
      uid: 'admin-uid', emailCanonical: 'admin@school.kr', displayName: '관리자',
      role: 'admin', revision: 2, approvedAt, approvedByUid: 'root',
      updatedAt: approvedAt, updatedByUid: 'root'
    }),
    'teacher_allowances/owner': activeTeacherAllowance({
      uid: 'owner', emailCanonical: 'owner@school.kr', displayName: '홍교사',
      revision: 1, approvedAt, approvedByUid: 'admin-uid',
      updatedAt: approvedAt, updatedByUid: 'admin-uid'
    }),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' },
    'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' },
    'quiz_sets/set-1': publicLibrarySource(),
    ...publicLibraryStoredDocuments('set-1')
  }, {
    beforeTransactionStart({ attempt }) {
      if (attempt === 2) {
        const lock = fake.value('publication_lifecycle_locks/owner');
        assert.equal(lock.ownerUid, 'owner');
        assert.equal(lock.allowanceRevision, 1);
        assert.equal(lock.reason, 'teacher-suspension');
      }
    }
  });

  await createStore(fake).adminUpdateTeacherAllowance({
    uid: 'owner', emailCanonical: 'owner@school.kr', expectedRevision: 1,
    role: 'teacher', status: 'suspended', reason: 'hold'
  }, { uid: 'admin-uid', email: 'admin@school.kr', role: 'admin' });

  assert.equal(fake.value('teacher_allowances/owner').status, 'suspended');
  assert.equal(fake.has('publication_lifecycle_locks/owner'), false);
});

test('lifecycle withdrawal audits bounded pages and returns zero visible publications', async () => {
  const initial = {
    'teacher_allowances/owner': publicLibraryAllowance()
  };
  for (let index = 0; index < 51; index += 1) {
    const id = `owned-${String(index).padStart(2, '0')}`;
    initial[`quiz_sets/${id}`] = publicLibrarySource();
    initial[`published_quiz_sets/${id}`] = publicLibraryProjection(id);
  }
  const fake = makeFirestoreFake(initial);
  const store = createStore(fake);

  const result = await store.withdrawOwnedPublicationsForLifecycle(
    'owner', 1, 'teacher-suspension', publicLibraryActor()
  );

  assert.deepEqual(result, { withdrawnCount: 51, remainingVisibleCount: 0 });
  for (let index = 0; index < 51; index += 1) {
    const id = `owned-${String(index).padStart(2, '0')}`;
    assert.equal(fake.value(`published_quiz_sets/${id}`).status, 'withdrawn');
  }
  const sourceQueries = fake.calls().filter(call => call.operation === 'getCollection' &&
    call.path === 'quiz_sets');
  assert.ok(sourceQueries.length >= 4);
  assert.ok(sourceQueries.every(call => call.filters.some(filter =>
    filter.type === 'limit' && filter.value <= 50)));
  assert.ok(sourceQueries.every(call => call.filters.some(filter =>
    filter.field === 'ownerUid' && filter.operator === '==' && filter.value === 'owner')));
});

test('suspension and deletion pending withdraw every publication before access is removed', async t => {
  const approvedAt = new Timestamp(1);
  const adminAllowance = activeTeacherAllowance({
    uid: 'admin-uid', emailCanonical: 'admin@school.kr', displayName: '관리자',
    role: 'admin', revision: 2, approvedAt, approvedByUid: 'root',
    updatedAt: approvedAt, updatedByUid: 'root'
  });
  const targetAllowance = activeTeacherAllowance({
    uid: 'owner', emailCanonical: 'owner@school.kr', displayName: '홍교사',
    revision: 1, approvedAt, approvedByUid: 'admin-uid',
    updatedAt: approvedAt, updatedByUid: 'admin-uid'
  });

  await t.test('admin suspension', async () => {
    const buildingFlat = publicLibraryFlat('set-building', {}, 'lifecycle-build-token');
    const fake = makeFirestoreFake({
      'teacher_allowances/admin-uid': adminAllowance,
      'teacher_allowances/owner': targetAllowance,
      'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' },
      'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' },
      'quiz_sets/set-1': publicLibrarySource(),
      'quiz_sets/set-building': publicLibrarySource(),
      'published_quiz_sets/set-building': {
        ...buildingFlat.parent,
        status: 'building', publishedAt: null,
        buildToken: 'lifecycle-build-token', buildVideoCount: 0,
        buildQuestionCount: 0, buildImageCount: 0
      },
      ...publicLibraryStoredDocuments('set-1')
    });
    const store = createStore(fake);
    const actor = {
      uid: 'admin-uid', email: 'admin@school.kr', role: 'admin',
      authGeneration: 4, currentAuthGeneration: 4, isCurrent: () => true
    };

    await store.adminUpdateTeacherAllowance({
      uid: 'owner', emailCanonical: 'owner@school.kr', expectedRevision: 1,
      role: 'teacher', status: 'suspended', reason: 'hold'
    }, actor);

    assert.equal(fake.value('published_quiz_sets/set-1').status, 'withdrawn');
    assert.equal(fake.value('published_quiz_sets/set-building').status, 'cancelled');
    assert.equal(fake.value('teacher_allowances/owner').status, 'suspended');
  });

  await t.test('owner deletion request', async () => {
    const fake = makeFirestoreFake({
      'teacher_allowances/owner': targetAllowance,
      'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' },
      'quiz_sets/set-1': publicLibrarySource(),
      ...publicLibraryStoredDocuments('set-1')
    });
    const store = createStore(fake);

    await store.requestTeacherDeletion('owner', {
      ...publicLibraryActor(), authGeneration: 7, currentAuthGeneration: 7,
      isCurrent: () => true
    });

    assert.equal(fake.value('published_quiz_sets/set-1').status, 'withdrawn');
    assert.equal(fake.value('teacher_allowances/owner').status, 'deletion_pending');
  });
});

test('a resumable lifecycle failure keeps allowance active and preserves earlier withdrawals', async () => {
  const approvedAt = new Timestamp(1);
  const fake = makeFirestoreFake({
    'teacher_allowances/admin-uid': activeTeacherAllowance({
      uid: 'admin-uid', emailCanonical: 'admin@school.kr', displayName: '관리자',
      role: 'admin', revision: 2, approvedAt, approvedByUid: 'root',
      updatedAt: approvedAt, updatedByUid: 'root'
    }),
    'teacher_allowances/owner': activeTeacherAllowance({
      uid: 'owner', emailCanonical: 'owner@school.kr', displayName: '홍교사',
      revision: 1, approvedAt, approvedByUid: 'admin-uid',
      updatedAt: approvedAt, updatedByUid: 'admin-uid'
    }),
    'teacher_allowlist/admin@school.kr': { enabled: true, role: 'admin' },
    'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' },
    'quiz_sets/a': publicLibrarySource(),
    'quiz_sets/b': publicLibrarySource(),
    'published_quiz_sets/a': publicLibraryProjection('a'),
    'published_quiz_sets/b': publicLibraryProjection('b')
  }, {
    failTransactionAt: 3,
    failTransactionMessage: 'planned lifecycle batch failure'
  });

  await assert.rejects(() => createStore(fake).adminUpdateTeacherAllowance({
    uid: 'owner', emailCanonical: 'owner@school.kr', expectedRevision: 1,
    role: 'teacher', status: 'suspended', reason: 'hold'
  }, { uid: 'admin-uid', email: 'admin@school.kr', role: 'admin' }),
  /planned lifecycle batch failure/);

  assert.equal(fake.value('published_quiz_sets/a').status, 'withdrawn');
  assert.equal(fake.value('published_quiz_sets/b').status, 'published');
  assert.equal(fake.value('teacher_allowances/owner').status, 'active');
  assert.equal(fake.has('publication_lifecycle_locks/owner'), false);
  assert.equal(fake.has('publication_lifecycle_gates/current'), false);
});

test('purge removes bounded public images and refuses parent deletion while an orphan remains', async () => {
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource({
      lifecycleState: 'trashed', trashedAt: 1, purgeStartedAt: null
    }),
    'published_quiz_sets/set-1': publicLibraryProjection('set-1', {
      imageCount: 1, patch: { status: 'withdrawn' }
    }),
    'published_quiz_sets/set-1/images/v0q0': {
      data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1',
      schemaVersion: 1, buildToken: 'build-token-1'
    }
  });
  const store = createStore(fake);

  await store.beginSetPurge('set-1', 'immediate', publicLibraryActor());
  const first = await store.continueSetPurge('set-1');

  assert.deepEqual(first, { done: false, deleted: 1, parentDeleted: false });
  assert.equal(fake.has('published_quiz_sets/set-1/images/v0q0'), false);
  assert.equal(fake.has('quiz_sets/set-1'), true);
  const done = await store.continueSetPurge('set-1');
  assert.equal(done.parentDeleted, true);
});

test('moderate and restore require authoritative admin CAS and active source owner state', async () => {
  const admin = publicLibraryActor('admin', 'admin@school.kr', {
    displayName: '관리자', role: 'admin'
  });
  const initial = {
    'quiz_sets/set-1': publicLibrarySource(),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'teacher_allowances/admin': publicLibraryAllowance('admin', 'admin@school.kr', {
      role: 'admin'
    }),
    'published_quiz_sets/set-1': publicLibraryProjection()
  };
  const fake = makeFirestoreFake(initial);
  const store = createStore(fake);

  const moderated = await store.adminModeratePublishedQuiz(
    'set-1', 'rev-1', '저작권 확인 필요', admin
  );
  assert.equal(moderated.status, 'moderated');
  assert.equal(fake.value('published_quiz_sets/set-1').moderatedByUid, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').moderationReason, undefined);
  assert.deepEqual(Object.keys(fake.value('published_quiz_audits/set-1')).sort(), [
    'moderatedAt', 'moderatedByUid', 'moderationReason', 'publicationId', 'revision', 'status'
  ]);
  assert.equal(fake.value('published_quiz_audits/set-1').moderatedByUid, 'admin');
  assert.equal(fake.value('published_quiz_audits/set-1').moderationReason, '저작권 확인 필요');
  assert.equal(fake.value('published_quiz_audits/set-1').moderatedAt instanceof Timestamp, true);
  assert.equal(await store.getPublishedQuizSet('set-1'), null);

  const restored = await store.adminRestorePublishedQuiz('set-1', 'rev-1', admin);
  assert.equal(restored.status, 'published');
  assert.equal(fake.value('published_quiz_sets/set-1').moderatedByUid, undefined);
  assert.equal(fake.value('published_quiz_sets/set-1').moderationReason, undefined);
  assert.deepEqual(Object.keys(fake.value('published_quiz_audits/set-1')).sort(), [
    'moderatedAt', 'moderatedByUid', 'moderationReason', 'publicationId', 'restoredAt',
    'restoredByUid', 'revision', 'status'
  ]);
  assert.equal(fake.value('published_quiz_audits/set-1').status, 'restored');
  assert.equal(fake.value('published_quiz_audits/set-1').restoredByUid, 'admin');
  assert.equal(fake.value('published_quiz_audits/set-1').restoredAt instanceof Timestamp, true);

  const calls = fake.calls();
  const moderatedPublicWrite = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1' && call.value.status === 'moderated');
  const moderatedAuditWrite = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_audits/set-1' && call.value.status === 'moderated');
  const restoredPublicWrite = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_sets/set-1' && call.value.status === 'published');
  const restoredAuditWrite = calls.findIndex(call => call.operation === 'transactionSet' &&
    call.path === 'published_quiz_audits/set-1' && call.value.status === 'restored');
  assert.ok(moderatedPublicWrite >= 0 && moderatedAuditWrite > moderatedPublicWrite);
  assert.ok(restoredPublicWrite > moderatedAuditWrite && restoredAuditWrite > restoredPublicWrite);
  assert.equal(calls[moderatedPublicWrite].value.updatedAt, SERVER_TIMESTAMP);
  assert.equal(calls[moderatedAuditWrite].value.moderatedAt, SERVER_TIMESTAMP);
  assert.equal(calls[restoredPublicWrite].value.updatedAt, SERVER_TIMESTAMP);
  assert.equal(calls[restoredAuditWrite].value.restoredAt, SERVER_TIMESTAMP);
  assert.ok(calls.some((call, index) => index > moderatedAuditWrite &&
    call.operation === 'get' && call.path === 'published_quiz_audits/set-1'));
  assert.ok(calls.some((call, index) => index > restoredAuditWrite &&
    call.operation === 'get' && call.path === 'published_quiz_audits/set-1'));

  const stale = makeFirestoreFake(initial);
  await assert.rejects(
    () => createStore(stale).adminModeratePublishedQuiz(
      'set-1', 'rev-stale', '사유', admin
    ),
    /revision|리비전/
  );
  assert.equal(stale.value('published_quiz_sets/set-1').status, 'published');

  const suspendedOwner = makeFirestoreFake({
    ...initial,
    'teacher_allowances/owner': publicLibraryAllowance('owner', 'owner@school.kr', {
      status: 'suspended', enabled: false
    }),
    'published_quiz_sets/set-1': {
      ...publicLibraryProjection(), status: 'moderated', moderationStatus: 'moderated'
    },
    'published_quiz_audits/set-1': {
      publicationId: 'set-1', revision: 'rev-1', status: 'moderated',
      moderatedByUid: 'admin', moderationReason: '사유', moderatedAt: new Timestamp(1_000)
    }
  });
  await assert.rejects(
    () => createStore(suspendedOwner).adminRestorePublishedQuiz('set-1', 'rev-1', admin),
    /active|활성|중지/
  );
  assert.equal(suspendedOwner.value('published_quiz_sets/set-1').status, 'moderated');
});

test('restore fails closed unless the paired admin-only moderation audit is exact', async () => {
  const admin = publicLibraryActor('admin', 'admin@school.kr', {
    displayName: '관리자', role: 'admin'
  });
  const fake = makeFirestoreFake({
    'quiz_sets/set-1': publicLibrarySource(),
    'teacher_allowances/owner': publicLibraryAllowance(),
    'teacher_allowances/admin': publicLibraryAllowance('admin', 'admin@school.kr', {
      role: 'admin'
    }),
    'published_quiz_sets/set-1': {
      ...publicLibraryProjection(), status: 'moderated', moderationStatus: 'moderated'
    }
  });

  await assert.rejects(
    () => createStore(fake).adminRestorePublishedQuiz('set-1', 'rev-1', admin),
    /audit|감사|moderation|중지/
  );
  assert.equal(fake.value('published_quiz_sets/set-1').status, 'moderated');
});

test('public projection list and get return only validated published rows with a bounded cursor query', async () => {
  const fake = makeFirestoreFake({
    ...publicLibraryStoredDocuments('pub-1', { updatedAtMs: 300 }),
    'published_quiz_sets/pub-2': publicLibraryProjection('pub-2', { updatedAtMs: 200 }),
    'published_quiz_sets/pub-2b': publicLibraryProjection('pub-2b', { updatedAtMs: 200 }),
    'published_quiz_sets/pub-3': publicLibraryProjection('pub-3', { updatedAtMs: 100 }),
    'published_quiz_sets/building': {
      ...PublicQuizLibraryCore.buildProjection(publicLibrarySource(), {
        setId: 'building', authorDisplayName: '홍교사', revision: 'rev-1', nowMs: 400
      }),
      buildToken: 'hidden', buildImageCount: 0
    },
    'published_quiz_sets/withdrawn': publicLibraryProjection('withdrawn', {
      patch: { status: 'withdrawn' }
    }),
    'published_quiz_sets/moderated': publicLibraryProjection('moderated', {
      patch: { status: 'moderated', moderationStatus: 'moderated' }
    })
  });
  const store = createStore(fake);

  const first = await store.listPublishedQuizSets({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.publicationId), ['pub-1', 'pub-2']);
  assert.equal(first.nextCursor.id, 'pub-2');
  assert.deepEqual(Object.keys(first.items[0]).sort(), [
    'authorDisplayName', 'description', 'publicationId', 'questionCount',
    'title', 'updatedAtMs', 'videoCount'
  ]);

  const second = await store.listPublishedQuizSets({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.publicationId), ['pub-2b', 'pub-3']);
  assert.equal(second.nextCursor.id, 'pub-3');
  const third = await store.listPublishedQuizSets({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items, []);
  assert.equal(third.nextCursor, null);
  assert.equal((await store.getPublishedQuizSet('pub-1')).status, 'published');
  assert.equal(await store.getPublishedQuizSet('building'), null);
  assert.equal(await store.getPublishedQuizSet('withdrawn'), null);
  assert.equal(await store.getPublishedQuizSet('moderated'), null);

  await assert.rejects(() => store.listPublishedQuizSets({ limit: 51 }), /1.*50|limit/);
  const calls = fake.calls();
  assert.ok(calls.some(call => call.operation === 'where' && call.field === 'status' && call.value === 'published'));
  assert.ok(calls.some(call => call.operation === 'orderBy' && call.field === 'updatedAt' && call.direction === 'desc'));
  assert.ok(calls.some(call => call.operation === 'startAfter' && call.values[0].id === 'pub-2'));
});

test('owner status probe returns only minimal authoritative state and never audit or projection fields', async () => {
  const fake = makeFirestoreFake({
    'published_quiz_sets/set-1': publicLibraryProjection('set-1', {
      patch: { status: 'moderated', moderationStatus: 'moderated' }
    }),
    'published_quiz_audits/set-1': {
      publicationId: 'set-1', revision: 'rev-1', status: 'moderated',
      moderatedByUid: 'admin-secret', moderationReason: 'private reason',
      moderatedAt: new Timestamp(1_000)
    }
  });
  const store = createStore(fake);

  const status = await store.getOwnedPublicationStatus('set-1');

  assert.deepEqual(status, {
    publicationId: 'set-1', status: 'moderated', revision: 'rev-1'
  });
  assert.equal(JSON.stringify(status).includes('admin-secret'), false);
  assert.equal(JSON.stringify(status).includes('private reason'), false);
  assert.equal(status.title, undefined);
  assert.deepEqual(await store.getOwnedPublicationStatus('missing-set'), {
    publicationId: 'missing-set', status: 'private', revision: ''
  });
  assert.equal(fake.calls().some(call => call.path === 'published_quiz_audits/set-1'), false);
});

test('admin publication list is exact authenticated status-set query with bounded cursor pagination', async () => {
  const admin = publicLibraryActor('admin', 'admin@school.kr', {
    displayName: '관리자', role: 'admin'
  });
  const fake = makeFirestoreFake({
    'teacher_allowances/admin': publicLibraryAllowance('admin', 'admin@school.kr', { role: 'admin' }),
    'published_quiz_sets/pub-1': publicLibraryProjection('pub-1', { updatedAtMs: 400 }),
    'published_quiz_sets/mod-1': publicLibraryProjection('mod-1', {
      updatedAtMs: 300, patch: { status: 'moderated', moderationStatus: 'moderated' }
    }),
    'published_quiz_sets/pub-2': publicLibraryProjection('pub-2', { updatedAtMs: 200 }),
    'published_quiz_sets/withdrawn': publicLibraryProjection('withdrawn', {
      updatedAtMs: 500, patch: { status: 'withdrawn' }
    })
  });
  const store = createStore(fake);

  const first = await store.listAdminPublishedQuizSets({ limit: 2, admin });
  assert.deepEqual(first.items.map(item => [item.publicationId, item.status]), [
    ['pub-1', 'published'], ['mod-1', 'moderated']
  ]);
  assert.equal(first.nextCursor.id, 'mod-1');
  const second = await store.listAdminPublishedQuizSets({
    limit: 2, cursor: first.nextCursor, admin
  });
  assert.deepEqual(second.items.map(item => item.publicationId), ['pub-2']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(Object.keys(first.items[1]).sort(), [
    'authorDisplayName', 'moderationStatus', 'publicationId', 'questionCount', 'revision',
    'status', 'title', 'updatedAtMs', 'videoCount'
  ]);
  await assert.rejects(
    () => store.listAdminPublishedQuizSets({ limit: 51, admin }), /1.*50|limit/
  );
  await assert.rejects(
    () => store.listAdminPublishedQuizSets({
      limit: 50, admin: { ...admin, role: 'teacher' }
    }), /관리자|admin/
  );
  const calls = fake.calls();
  assert.ok(calls.some(call => call.operation === 'where' && call.field === 'status' &&
    call.operator === 'in' && JSON.stringify(call.value) === '["published","moderated"]'));
  assert.ok(calls.some(call => call.operation === 'get' && call.path === 'teacher_allowances/admin'));
  assert.ok(calls.some(call => call.operation === 'startAfter' && call.values[0].id === 'mod-1'));
});

test('public list advances its DocumentSnapshot cursor when the page boundary row is malformed', async () => {
  const fake = makeFirestoreFake({
    'published_quiz_sets/pub-1': publicLibraryProjection('pub-1', { updatedAtMs: 300 }),
    'published_quiz_sets/malformed': {
      ...publicLibraryProjection('malformed', { updatedAtMs: 250 }),
      ownerEmail: 'must-not-leak@example.com'
    },
    'published_quiz_sets/pub-2': publicLibraryProjection('pub-2', { updatedAtMs: 200 })
  });
  const store = createStore(fake);

  const first = await store.listPublishedQuizSets({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.publicationId), ['pub-1']);
  assert.equal(first.nextCursor.id, 'malformed');

  const second = await store.listPublishedQuizSets({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.publicationId), ['pub-2']);
});

test('copyPublished reads public projection only and finalizes a strict private counter destination', async () => {
  const actor = publicLibraryActor('teacher-b', 'teacher-b@school.kr');
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-b': publicLibraryAllowance('teacher-b', 'teacher-b@school.kr'),
    ...publicLibraryStoredDocuments('set-1', { imageCount: 2 }),
    'published_quiz_sets/set-1/images/v0q0': {
      data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-1'
    },
    'published_quiz_sets/set-1/images/v0q0e': {
      data: PUBLIC_LIBRARY_IMAGE_B, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-1'
    }
  });
  const store = createStore(fake);

  const result = await store.copyPublishedQuizSet('set-1', 'copy-1', actor);

  assert.equal(result.id, 'copy-1');
  assert.equal(fake.value('quiz_sets/copy-1').ownerUid, 'teacher-b');
  assert.equal(fake.value('quiz_sets/copy-1').ownerEmail, 'teacher-b@school.kr');
  assert.equal(fake.value('quiz_sets/copy-1').visibility, 'private');
  assert.equal(fake.value('quiz_sets/copy-1').lifecycleState, 'active');
  assert.equal(fake.value('quiz_sets/copy-1').collaboratorCount, 0);
  assert.equal(fake.value('quiz_sets/copy-1').imageCount, 2);
  assert.equal(fake.value('quiz_sets/copy-1').publicationId, 'set-1');
  assert.equal(fake.value('quiz_sets/copy-1').sourcePublicationRevision, 'rev-1');
  assert.equal(fake.value('quiz_sets/copy-1').copyStatus, undefined);
  assert.equal(fake.value('images/copy-1/q/v0q0').data, PUBLIC_LIBRARY_IMAGE_A);
  assert.equal(fake.value('images/copy-1/q/v0q0e').data, PUBLIC_LIBRARY_IMAGE_B);

  const calls = fake.calls();
  assert.equal(calls.some(call => call.path === 'quiz_sets/set-1'), false);
  assert.equal(calls.some(call => call.path === 'images/set-1/q'), false);
  const increments = calls.filter(call => call.operation === 'transactionSet' &&
    call.path === 'quiz_sets/copy-1' && call.value.imageMutation &&
    call.value.imageMutation.action === 'add');
  assert.deepEqual(increments.map(call => call.value.imageCount), [1, 2]);
});

test('copyPublished rejects withdrawal races, moderated rows, partial public images, and suspended copier', async t => {
  const actor = publicLibraryActor('teacher-b', 'teacher-b@school.kr');
  const allowance = publicLibraryAllowance('teacher-b', 'teacher-b@school.kr');

  await t.test('withdrawal during copy', async () => {
    const fake = makeFirestoreFake({
      'teacher_allowances/teacher-b': allowance,
      ...publicLibraryStoredDocuments('set-1'),
    }, {
      beforeTransactionStart({ attempt, set }) {
        if (attempt === 1) {
          set('published_quiz_sets/set-1', publicLibraryProjection('set-1', {
            updatedAtMs: 1_100, patch: { status: 'withdrawn' }
          }));
        }
      }
    });
    await assert.rejects(
      () => createStore(fake).copyPublishedQuizSet('set-1', 'copy-1', actor),
      /published|공개|철회|변경/
    );
    assert.equal(fake.value('quiz_sets/copy-1'), undefined);
  });

  await t.test('moderated projection', async () => {
    const fake = makeFirestoreFake({
      'teacher_allowances/teacher-b': allowance,
      'published_quiz_sets/set-1': publicLibraryProjection('set-1', {
        patch: { status: 'moderated', moderationStatus: 'moderated' }
      })
    });
    await assert.rejects(
      () => createStore(fake).copyPublishedQuizSet('set-1', 'copy-1', actor),
      /published|공개|중지/
    );
    assert.equal(fake.calls().some(call => call.operation === 'runTransaction'), false);
  });

  await t.test('partial public image projection', async () => {
    const fake = makeFirestoreFake({
      'teacher_allowances/teacher-b': allowance,
      ...publicLibraryStoredDocuments('set-1', { imageCount: 2 }),
      'published_quiz_sets/set-1/images/v0q0': {
        data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1',
        schemaVersion: 1, buildToken: 'build-1'
      }
    });
    await assert.rejects(
      () => createStore(fake).copyPublishedQuizSet('set-1', 'copy-1', actor),
      /image|이미지|counter/
    );
    assert.equal(fake.value('quiz_sets/copy-1'), undefined);
  });

  await t.test('suspended copier', async () => {
    const fake = makeFirestoreFake({
      'teacher_allowances/teacher-b': publicLibraryAllowance(
        'teacher-b', 'teacher-b@school.kr', { status: 'suspended', enabled: false }
      ),
      'published_quiz_sets/set-1': publicLibraryProjection()
    });
    await assert.rejects(
      () => createStore(fake).copyPublishedQuizSet('set-1', 'copy-1', actor),
      /active|활성|승인|중지/
    );
    assert.equal(fake.calls().some(call => call.operation === 'runTransaction'), false);
  });
});

test('copyPublished refuses a destination collision before changing either document', async () => {
  const actor = publicLibraryActor('teacher-b', 'teacher-b@school.kr');
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-b': publicLibraryAllowance('teacher-b', 'teacher-b@school.kr'),
    ...publicLibraryStoredDocuments('set-1'),
    'quiz_sets/copy-1': {
      title: '기존 세트', ownerUid: 'teacher-b', lifecycleState: 'active',
      collaboratorCount: 0, imageCount: 0
    }
  });

  await assert.rejects(
    () => createStore(fake).copyPublishedQuizSet('set-1', 'copy-1', actor),
    /destination|목적지|이미 존재|충돌/
  );
  assert.equal(fake.value('quiz_sets/copy-1').title, '기존 세트');
});

test('copyPublished retries safely after an ambiguous final commit without duplicating image counters', async () => {
  const actor = publicLibraryActor('teacher-b', 'teacher-b@school.kr');
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-b': publicLibraryAllowance('teacher-b', 'teacher-b@school.kr'),
    ...publicLibraryStoredDocuments('set-1', { imageCount: 1 }),
    'published_quiz_sets/set-1/images/v0q0': {
      data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-1'
    }
  }, {
    failTransactionAfterCommitAt: 3,
    failTransactionAfterCommitMessage: 'ambiguous copy commit'
  });
  const store = createStore(fake);

  await assert.rejects(
    () => store.copyPublishedQuizSet('set-1', 'copy-1', actor),
    /ambiguous copy commit/
  );
  assert.equal(fake.value('quiz_sets/copy-1').lifecycleState, 'active');
  assert.equal(fake.value('quiz_sets/copy-1').imageCount, 1);

  const result = await store.copyPublishedQuizSet('set-1', 'copy-1', actor);
  assert.equal(result.id, 'copy-1');
  assert.equal(fake.value('quiz_sets/copy-1').imageCount, 1);
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet' &&
    call.path === 'images/copy-1/q/v0q0').length, 1);
});

test('copyPublished resumes a hidden copying destination after an ambiguous image commit', async () => {
  const actor = publicLibraryActor('teacher-b', 'teacher-b@school.kr');
  const fake = makeFirestoreFake({
    'teacher_allowances/teacher-b': publicLibraryAllowance('teacher-b', 'teacher-b@school.kr'),
    ...publicLibraryStoredDocuments('set-1', { imageCount: 1 }),
    'published_quiz_sets/set-1/images/v0q0': {
      data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-1'
    }
  }, {
    failTransactionAfterCommitAt: 2,
    failTransactionAfterCommitMessage: 'ambiguous destination image commit'
  });
  const store = createStore(fake);

  await assert.rejects(
    () => store.copyPublishedQuizSet('set-1', 'copy-1', actor),
    /ambiguous destination image commit/
  );
  assert.equal(fake.value('quiz_sets/copy-1').lifecycleState, 'copying');
  assert.equal(fake.value('quiz_sets/copy-1').copyStatus, 'building');
  assert.equal(fake.value('quiz_sets/copy-1').imageCount, 1);

  const result = await store.copyPublishedQuizSet('set-1', 'copy-1', actor);
  assert.equal(result.id, 'copy-1');
  assert.equal(fake.value('quiz_sets/copy-1').lifecycleState, 'active');
  assert.equal(fake.value('quiz_sets/copy-1').imageCount, 1);
  assert.equal(fake.calls().filter(call => call.operation === 'transactionSet' &&
    call.path === 'images/copy-1/q/v0q0').length, 1);
  const increments = fake.calls().filter(call => call.operation === 'transactionSet' &&
    call.path === 'quiz_sets/copy-1' && call.value.imageMutation &&
    call.value.imageMutation.action === 'add');
  assert.equal(increments.length, 1);
});

test('copyPublished preflight rejects more than 500 writes before destination transaction', async () => {
  const actor = publicLibraryActor('teacher-b', 'teacher-b@school.kr');
  const initial = {
    'teacher_allowances/teacher-b': publicLibraryAllowance('teacher-b', 'teacher-b@school.kr'),
    ...publicLibraryStoredDocuments('set-1', { imageCount: 497 })
  };
  for (let index = 0; index < 497; index += 1) {
    initial['published_quiz_sets/set-1/images/v0q' + index] = {
      data: PUBLIC_LIBRARY_IMAGE_A, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-1'
    };
  }
  const fake = makeFirestoreFake(initial, { maxRequestWrites: 500 });

  await assert.rejects(
    () => createStore(fake).copyPublishedQuizSet('set-1', 'copy-1', actor),
    /500개.*변환/
  );
  assert.equal(fake.calls().some(call => call.operation === 'runTransaction'), false);
  assert.equal(fake.value('quiz_sets/copy-1'), undefined);
});

function guestShareProjection() {
  return GuestQuizShareCore.projectQuizSet({
    id: 'set1', title: '공유 세트', description: '',
    settings: { revealMode: 'manual', limitSec: 20, revealDelaySec: 0, autoPause: true },
    videos: [{ id: 'abcdefghijk', videoId: 'abcdefghijk',
      url: 'https://youtu.be/abcdefghijk', startSec: 0, endSec: 60,
      questions: [{ type: 'choice', t: 10, text: '문제', choices: ['A', 'B'], answer: 0 }] }]
  }, {});
}

test('guest quiz share publishes a ready revision before activating its owner mapping', async () => {
  const shareId = 'A'.repeat(43);
  const fake = makeFirestoreFake({
    'quiz_sets/set1': {
      title: '공유 세트', ownerUid: 'owner-uid', ownerEmail: 'owner@school.kr',
      lifecycleState: 'active', contentRevision: 3, videos: []
    }
  });
  const store = createStore(fake);
  const result = await store.createGuestQuizShare(
    'set1', guestShareProjection(),
    { uid: 'owner-uid', email: 'owner@school.kr' }, shareId
  );
  assert.deepEqual(result, { shareId, revision: 1, status: 'active' });
  assert.equal(fake.value('guest_quiz_shares/' + shareId).status, 'active');
  assert.equal(fake.value('guest_quiz_shares/' + shareId + '/revisions/1').status, 'ready');
  assert.equal(fake.value('guest_quiz_share_sources/set1').shareId, shareId);
  const parent = fake.value('guest_quiz_shares/' + shareId);
  assert.equal(JSON.stringify(parent).includes('owner@school.kr'), false);
  assert.equal(Object.hasOwn(parent, 'tokenHash'), false);
});

test('guest quiz share refresh pins a new revision and revoke never reactivates it', async () => {
  const shareId = 'B'.repeat(43);
  const initial = {
    'quiz_sets/set1': {
      title: '공유 세트', ownerUid: 'owner-uid', ownerEmail: 'owner@school.kr',
      lifecycleState: 'active', contentRevision: 4, videos: []
    },
    'guest_quiz_share_sources/set1': {
      sourceSetId: 'set1', sourceOwnerUid: 'owner-uid', shareId, status: 'active', revision: 1
    },
    ['guest_quiz_shares/' + shareId]: {
      shareId, sourceSetId: 'set1', sourceOwnerUid: 'owner-uid',
      status: 'active', revision: 1, sourceContentRevision: 3
    }
  };
  const fake = makeFirestoreFake(initial);
  const store = createStore(fake);
  const refreshed = await store.refreshGuestQuizShare(
    'set1', guestShareProjection(), { uid: 'owner-uid', email: 'owner@school.kr' }
  );
  assert.equal(refreshed.revision, 2);
  assert.equal(fake.value('guest_quiz_shares/' + shareId + '/revisions/2').status, 'ready');
  const revoked = await store.revokeGuestQuizShare(
    'set1', { uid: 'owner-uid', email: 'owner@school.kr' }
  );
  assert.equal(revoked.status, 'revoked');
  await assert.rejects(() => store.refreshGuestQuizShare(
    'set1', guestShareProjection(), { uid: 'owner-uid', email: 'owner@school.kr' }
  ), /활성.*공유/);
});

test('active share loader rejects revoked parent before reading children', async () => {
  const shareId = 'C'.repeat(43);
  const fake = makeFirestoreFake({
    ['guest_quiz_shares/' + shareId]: {
      shareId, sourceSetId: 'set1', sourceOwnerUid: 'owner-uid', status: 'revoked', revision: 1
    }
  });
  await assert.rejects(() => createStore(fake).loadActiveGuestQuizShare(shareId), /사용할 수 없는/);
  assert.equal(fake.calls().some(call => call.path.includes('/revisions/')), false);
});

test('guest revision loader assembles playlist data without reading the private source set', async () => {
  const fake = makeFirestoreFake({
    'guest_quiz_shares/share-a/revisions/2': {
      shareId: 'share-a', revision: 2, sourceContentRevision: '3', status: 'ready',
      title: '공유 세트', description: '', revealMode: 'manual', limitSec: 20,
      revealDelaySec: 0, autoPause: true, videoCount: 1, questionCount: 1,
      imageCount: 0, schemaVersion: 1
    },
    'guest_quiz_shares/share-a/revisions/2/videos/v0': {
      shareId: 'share-a', revision: 2, videoKey: 'v0', videoId: 'abcdefghijk',
      videoUrl: 'https://youtu.be/abcdefghijk', startSec: 0, endSec: 60, schemaVersion: 1
    },
    'guest_quiz_shares/share-a/revisions/2/questions/v0q0': {
      shareId: 'share-a', revision: 2, questionKey: 'v0q0', videoKey: 'v0',
      type: 'mc', t: 10, text: '문제', choices: ['A', 'B'], answer: 0
    }
  });
  const loaded = await createStore(fake).loadGuestQuizRevision('share-a', 2, {
    sourceSetId: 'set1', sourceOwnerUid: 'owner-uid'
  });
  assert.equal(loaded.setSnapshot.title, '공유 세트');
  assert.equal(loaded.setSnapshot.videos[0].questions[0].answer, 0);
  assert.equal(fake.calls().some(call => call.path === 'quiz_sets/set1'), false);
});

test('guest session preparation pins share provenance and uses the ordinary allocation snapshot', async () => {
  const fake = makeFirestoreFake({});
  const store = createStore(fake);
  const loaded = {
    setSnapshot: { title: '공유 세트', author: '', videos: [{ questions: [] }] },
    snapshotImages: {}, shareId: 'share-a', revision: 2,
    sourceSetId: 'set1', sourceOwnerUid: 'owner-uid'
  };
  const session = store.prepareGuestSession(loaded, '3학년 2반', { uid: 'guest-a' }, 'token-1234567890123456');
  assert.equal(session.teacherUid, 'guest-a');
  assert.equal(session.teacherEmail, '');
  assert.equal(session.sessionActorType, 'guest');
  assert.equal(session.sourceShareId, 'share-a');
  assert.equal(session.sourceRevision, 2);
  assert.equal(session.setId, 'set1');
  assert.equal(session.setSnapshot.title, '공유 세트');
});

test('옆 패널 학생 명단은 순위가 아니라 번호 순으로 보여 준다', () => {
  const rows = [];
  const ctx = loadStageFunctions(['plRoster', 'plRenderStudents'], {
    pl: { flatQuestions: [{}, {}] },
    $(selector) {
      if (selector === '#pl-roster-count') return { set textContent(value) { rows.push('count:' + value); } };
      if (selector === '#pl-nstu') return null;
      if (selector === '#pl-stulist') return { set innerHTML(value) { rows.push(value); } };
      return null;
    },
    plScoreboard() {
      return [
        { sid: 'c', name: '박세', grade: 2, klass: 3, num: 11, correct: 2, answered: 2, graded: 2, rank: 1 },
        { sid: 'a', name: '김일', grade: 2, klass: 3, num: 2, correct: 0, answered: 1, graded: 1, rank: 3 },
        { sid: 'b', name: '이이', grade: 2, klass: 3, num: 7, correct: 1, answered: 1, graded: 1, rank: 2 }
      ];
    },
    plRenderQrBubble() {},
    esc(value) { return String(value); }
  });

  ctx.plRenderStudents();

  assert.equal(rows[0], 'count:3');
  const html = rows[1];
  // 등수(1등 박세)가 아니라 번호 순(2 → 7 → 11)으로 나와야 출석 확인이 된다.
  assert.ok(html.indexOf('김일') < html.indexOf('이이'));
  assert.ok(html.indexOf('이이') < html.indexOf('박세'));
  assert.match(html, /2-3-2/);
});

test('동시 입장 경합으로 튕긴 학생은 간격을 벌려 다시 시도한다', async () => {
  const waits = [];
  let calls = 0;
  const ctx = loadStageFunctions(['stJoinRetryable', 'stJoinWithRetry'], {
    store: {
      async joinStudent() {
        calls += 1;
        if (calls < 3) {
          const error = new Error('aborted');
          error.code = 'aborted';
          throw error;
        }
        return true;
      }
    },
    Math, setTimeout
  });

  const result = await ctx.stJoinWithRetry('s1', 'stu-1', { num: 1 }, ms => {
    waits.push(ms);
    return Promise.resolve();
  });

  assert.equal(result, true);
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  // 한꺼번에 다시 몰리지 않도록 간격이 점점 벌어져야 한다.
  assert.ok(waits[0] >= 200 && waits[1] >= 400 && waits[1] > waits[0] - 400);
});

test('권한 거부처럼 다시 시도해도 소용없는 실패는 곧바로 알린다', async () => {
  let calls = 0;
  const ctx = loadStageFunctions(['stJoinRetryable', 'stJoinWithRetry'], {
    store: {
      async joinStudent() {
        calls += 1;
        const error = new Error('permission-denied');
        error.code = 'permission-denied';
        throw error;
      }
    },
    Math, setTimeout
  });

  await assert.rejects(() => ctx.stJoinWithRetry('s1', 'stu-1', { num: 1 }, () => Promise.resolve()));
  assert.equal(calls, 1);
});

/* ── 비로그인 진행 반 복구 ─────────────────────────────────────────── */
function guestResumeContext(overrides) {
  const options = overrides || {};
  const store = Object.assign({
    async getSession() { return options.session; },
    async activateSessionAllocation() { return options.activated !== false; }
  }, options.store || {});
  const state = {
    guestLoad: {
      guestUser: { uid: 'guest-1' },
      shareId: 'S'.repeat(43),
      setSnapshot: { videos: [{ questions: [{ t: 1, text: 'Q' }] }] },
      snapshotImages: {}
    },
    setId: 'set-1'
  };
  const stored = options.stored === undefined ? {
    sessionId: 'sess-1', code: 'ABC123',
    allocationToken: 'allocation-token-1234', sourceSetId: 'set-1'
  } : options.stored;
  const removed = [];
  const context = {
    pl: state,
    store,
    imgCache: {},
    PlaylistCore: require('../playlist-core.js'),
    lsGet() { return stored === null ? '' : JSON.stringify(stored); },
    lsDel(key) { removed.push(key); },
    plStartSessionHeartbeat() { context.heartbeatStarted = true; },
    renderPlayRun() { context.rendered = true; },
    toast(message) { context.notice = message; },
    console: { error() {} },
    JSON, Object, String, Number, Array
  };
  context.state = state;
  context.removed = removed;
  loadStageFunctions([
    'guestActiveSessionKey', 'readGuestActiveSession', 'clearGuestActiveSession',
    'guestSessionIsResumable', 'plResumeGuestSession'
  ], context);
  return context;
}

test('새로고침해도 진행 중이던 비로그인 반에 같은 코드로 다시 붙는다', async () => {
  const ctx = guestResumeContext({
    session: {
      teacherUid: 'guest-1', status: 'live', sourceShareId: 'S'.repeat(43)
    }
  });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), true);
  assert.equal(ctx.state.sessionId, 'sess-1');
  assert.equal(ctx.state.code, 'ABC123');
  assert.equal(ctx.state.allocationToken, 'allocation-token-1234');
  assert.equal(ctx.heartbeatStarted, true);
  assert.equal(ctx.rendered, true);
  assert.match(ctx.notice, /ABC123/);
});

test('이미 끝난 반에는 다시 붙지 않고 저장 정보를 지운다', async () => {
  const ctx = guestResumeContext({
    session: { teacherUid: 'guest-1', status: 'ended', sourceShareId: 'S'.repeat(43) }
  });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), false);
  assert.equal(ctx.removed.length, 1);
  assert.equal(ctx.rendered, undefined);
});

test('다른 사람이 연 반에는 붙지 않는다', async () => {
  const ctx = guestResumeContext({
    session: { teacherUid: 'someone-else', status: 'live', sourceShareId: 'S'.repeat(43) }
  });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), false);
  assert.equal(ctx.removed.length, 1);
});

test('다른 공유 링크의 반에는 붙지 않는다', async () => {
  const ctx = guestResumeContext({
    session: { teacherUid: 'guest-1', status: 'live', sourceShareId: 'X'.repeat(43) }
  });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), false);
});

test('활성화 토큰이 맞지 않으면 붙지 않고 저장 정보를 지운다', async () => {
  const ctx = guestResumeContext({
    session: { teacherUid: 'guest-1', status: 'live', sourceShareId: 'S'.repeat(43) },
    activated: false
  });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), false);
  assert.equal(ctx.removed.length, 1);
  assert.equal(ctx.rendered, undefined);
});

test('저장된 반이 없으면 조용히 시작 화면으로 간다', async () => {
  const ctx = guestResumeContext({ stored: null });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), false);
  assert.equal(ctx.removed.length, 0);
});

test('저장 정보가 깨져 있으면 복구를 시도하지 않는다', async () => {
  const ctx = guestResumeContext({ stored: { sessionId: 'sess-1', code: '', allocationToken: 'x' } });

  assert.equal(await ctx.plResumeGuestSession(ctx.state), false);
});

test('비로그인 실행 기록은 반마다 결과 보기로 들어갈 수 있다', async () => {
  const body = { innerHTML: '' };
  const context = {
    teacherState: { uid: 'owner-1', email: 'owner@school.kr', role: 'teacher', status: 'teacher' },
    store: {
      async listOwnedDerivedSessions() {
        return [
          { id: 'sess-live', label: '1학년 1반', code: 'AAA111', status: 'live',
            registeredStudentCount: 3, sourceRevision: 1, createdAt: 0 },
          { id: 'sess-ended', label: '2학년 5반', code: 'BBB222', status: 'ended',
            registeredStudentCount: 2, sourceRevision: 1, createdAt: 0 },
          { id: 'sess-aborted', label: '취소된 반', code: 'CCC333', status: 'aborted',
            registeredStudentCount: 0, sourceRevision: 1, createdAt: 0 }
        ];
      }
    },
    APP() { return { set innerHTML(value) {} }; },
    $(selector) { return selector === '#guest-run-history' ? body : null; },
    topbar() { return ''; },
    onCleanup() {},
    go() {},
    esc(value) { return String(value); },
    fmtDate() { return '2026-08-25'; },
    Number, console
  };
  loadStageFunctions(['screenGuestRunHistory'], context);

  context.screenGuestRunHistory('set-1');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.match(body.innerHTML, /href="#\/live\/sess-live"/);
  assert.match(body.innerHTML, /href="#\/live\/sess-ended"/);
  // 취소된 반은 볼 결과가 없다.
  assert.doesNotMatch(body.innerHTML, /href="#\/live\/sess-aborted"/);
});

test('실행 기록 삭제는 확인을 받고 그 행만 없앤다', async () => {
  const removed = [];
  const calls = [];
  const card = {
    removed: false,
    querySelectorAll() { return [{ disabled: false }]; },
    remove() { this.removed = true; removed.push('card'); }
  };
  const context = {
    teacherState: { uid: 'owner-1', email: 'owner@school.kr', role: 'teacher', status: 'teacher' },
    store: {
      async deleteOwnedDerivedSession(...args) { calls.push(args); return true; }
    },
    document: { querySelector() { return card; } },
    $() { return { querySelector() { return null; }, set innerHTML(value) {} }; },
    confirm(message) { calls.push(['confirm', message]); return true; },
    alert() {}, toast() {}, console: { error() {} }, Number
  };
  loadStageFunctions(['deleteGuestRunSession'], context);

  assert.equal(await context.deleteGuestRunSession('set-1', 'sess-1', 'ABC123', 3), true);
  assert.match(calls[0][1], /ABC123/);
  assert.match(calls[0][1], /3명/);
  assert.deepEqual(calls[1], ['set-1', 'sess-1', context.teacherState]);
  assert.equal(card.removed, true);
});

test('실행 기록 삭제는 취소하면 아무것도 지우지 않는다', async () => {
  let deleteCalls = 0;
  const context = {
    teacherState: { uid: 'owner-1' },
    store: { async deleteOwnedDerivedSession() { deleteCalls += 1; return true; } },
    document: { querySelector() { return null; } },
    $() { return null; },
    confirm() { return false; },
    alert() {}, toast() {}, console: { error() {} }, Number
  };
  loadStageFunctions(['deleteGuestRunSession'], context);

  assert.equal(await context.deleteGuestRunSession('set-1', 'sess-1', 'ABC123', 3), false);
  assert.equal(deleteCalls, 0);
});

test('비로그인 진행 안내는 다섯 단계와 주의사항을 갖추고 열고 닫힌다', () => {
  let open = false;
  const dialog = {
    showModal() { open = true; },
    close() { open = false; }
  };
  const ctx = loadStageFunctions(
    ['plGuestGuideSteps', 'plGuestGuideTips', 'plGuestGuideDialog', 'plOpenGuestGuide', 'plCloseGuestGuide'],
    { $(selector) { return selector === '#pl-guest-guide' ? dialog : null; }, esc(v) { return String(v); } }
  );

  assert.equal(ctx.plGuestGuideSteps().length, 5);
  assert.ok(ctx.plGuestGuideTips().length >= 3);
  const html = ctx.plGuestGuideDialog();
  assert.match(html, /id="pl-guest-guide"/);
  assert.match(html, /비로그인 수업 진행 방법/);

  assert.equal(ctx.plOpenGuestGuide(), true);
  assert.equal(open, true);
  assert.equal(ctx.plCloseGuestGuide(), true);
  assert.equal(open, false);
});

function autoResumeContext(settings, live, patch) {
  const state = Object.assign({
    set: { settings: Object.assign({ revealMode: 'timer', autoResumeSec: 5 }, settings) },
    live: Object.assign({ q: 0, revealed: true, publicAnswer: { answer: 0 } }, live),
    closeFlight: null
  }, patch || {});
  const context = {
    pl: state,
    serverNow() { return context.now; },
    now: 1_000_000,
    Number, Math, Date
  };
  loadStageFunctions(['plAutoResumeRemainingMs', 'plAutoResumeDue'], context);
  return context;
}

test('정답 공개 뒤 설정한 시간이 지나면 자동으로 계속 재생한다', () => {
  const ctx = autoResumeContext();

  assert.equal(ctx.plAutoResumeRemainingMs(), 5000);
  assert.equal(ctx.plAutoResumeDue(), false);

  ctx.now += 4000;
  assert.equal(ctx.plAutoResumeRemainingMs(), 1000);
  assert.equal(ctx.plAutoResumeDue(), false);

  ctx.now += 1000;
  assert.equal(ctx.plAutoResumeDue(), true);
});

test('0초로 두면 교사가 누를 때까지 기다린다', () => {
  const ctx = autoResumeContext({ autoResumeSec: 0 });

  assert.equal(ctx.plAutoResumeRemainingMs(), null);
  ctx.now += 600_000;
  assert.equal(ctx.plAutoResumeDue(), false);
});

test('정답이 공개되기 전에는 자동으로 넘어가지 않는다', () => {
  const ctx = autoResumeContext(undefined, { revealed: false, publicAnswer: undefined });

  assert.equal(ctx.plAutoResumeRemainingMs(), null);
  ctx.now += 600_000;
  assert.equal(ctx.plAutoResumeDue(), false);
});

test('학생 제출 마감이 안 끝났으면 시간이 지나도 기다린다', () => {
  const ctx = autoResumeContext(undefined, { accepting: true, submitGraceUntil: 1_010_000 });

  ctx.plAutoResumeRemainingMs();
  ctx.now += 5000;
  assert.equal(ctx.plAutoResumeDue(), false);

  ctx.now = 1_010_001;
  assert.equal(ctx.plAutoResumeDue(), true);
});

test('문항이 바뀌면 자동 재생 시각을 새로 잡는다', () => {
  const ctx = autoResumeContext();

  assert.equal(ctx.plAutoResumeRemainingMs(), 5000);
  ctx.now += 3000;
  ctx.pl.live = { q: 1, revealed: true, publicAnswer: { answer: 1 } };
  assert.equal(ctx.plAutoResumeRemainingMs(), 5000);
});
