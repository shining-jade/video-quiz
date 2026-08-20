const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('../teacher-deletion-core.js');
const { createFirestoreStore } = require('../firestore-store.js');

const DAYS_30_MS = 30 * 24 * 60 * 60 * 1000;

function allowance(overrides = {}) {
  return {
    uid: 'teacher-a',
    emailCanonical: 'teacher@school.kr',
    displayName: '김교사',
    status: 'active',
    enabled: true,
    role: 'teacher',
    administrativeHold: false,
    revision: 7,
    approvedAtMs: 1,
    approvedByUid: 'admin-a',
    updatedAtMs: 2,
    updatedByUid: 'admin-a',
    ...overrides
  };
}

test('active teacher requests deletion immutably with exact identity, revision, and 30-day display boundary', () => {
  const before = allowance();
  const requested = core.request(before, 10_000);

  assert.deepEqual(requested, {
    ...before,
    status: 'deletion_pending',
    enabled: false,
    revision: 8,
    deletionRequestedAtMs: 10_000,
    purgeEligibleAtMs: 10_000 + DAYS_30_MS,
    updatedAtMs: 10_000,
    updatedByUid: 'teacher-a'
  });
  assert.deepEqual(before, allowance());
  assert.notEqual(requested, before);
});

test('request rejects wrong lifecycle, malformed revision, UID, or canonical email without changing input', () => {
  for (const candidate of [
    allowance({ status: 'suspended', enabled: false }),
    allowance({ role: 'admin' }),
    allowance({ revision: Number.MAX_SAFE_INTEGER }),
    allowance({ revision: 1.5 }),
    allowance({ uid: '' }),
    allowance({ emailCanonical: ' Teacher@School.KR ' }),
    allowance({ administrativeHold: true })
  ]) {
    const copy = structuredClone(candidate);
    assert.throws(() => core.request(candidate, 10_000));
    assert.deepEqual(candidate, copy);
  }
});

test('pre-purge cancellation without an administrative hold restores active and removes deletion markers', () => {
  const pending = core.request(allowance(), 10_000);
  const cancelled = core.cancel(pending, 20_000);

  assert.equal(cancelled.status, 'active');
  assert.equal(cancelled.enabled, true);
  assert.equal(cancelled.administrativeHold, false);
  assert.equal(cancelled.revision, 9);
  assert.equal(cancelled.updatedAtMs, 20_000);
  assert.equal(cancelled.updatedByUid, 'teacher-a');
  assert.equal(Object.hasOwn(cancelled, 'deletionRequestedAtMs'), false);
  assert.equal(Object.hasOwn(cancelled, 'purgeEligibleAtMs'), false);
  assert.deepEqual(pending, core.request(allowance(), 10_000));
});

test('pre-purge cancellation with an administrative hold restores suspended and preserves hold audit', () => {
  const pending = core.request(allowance(), 10_000);
  const held = {
    ...pending,
    administrativeHold: true,
    revision: 9,
    suspendedAtMs: 15_000,
    suspendedByUid: 'admin-a',
    suspensionReason: 'independent-hold',
    updatedAtMs: 15_000,
    updatedByUid: 'admin-a'
  };
  const cancelled = core.cancel(held, 20_000);

  assert.equal(cancelled.status, 'suspended');
  assert.equal(cancelled.enabled, false);
  assert.equal(cancelled.administrativeHold, true);
  assert.equal(cancelled.revision, 10);
  assert.equal(cancelled.suspendedAtMs, 15_000);
  assert.equal(cancelled.suspendedByUid, 'admin-a');
  assert.equal(cancelled.suspensionReason, 'independent-hold');
  assert.equal(Object.hasOwn(cancelled, 'deletionRequestedAtMs'), false);
  assert.equal(Object.hasOwn(cancelled, 'purgeEligibleAtMs'), false);
});

test('cancellation refuses the exact purge boundary and malformed deletion timestamps', () => {
  const pending = core.request(allowance(), 10_000);
  assert.doesNotThrow(() => core.cancel(pending, 10_000 + DAYS_30_MS - 1));
  assert.throws(() => core.cancel(pending, 10_000 + DAYS_30_MS), /eligible|30|정리/);
  assert.throws(() => core.cancel({ ...pending, purgeEligibleAtMs: 9_999 }, 20_000), /timestamp|30|시각/);
  assert.throws(() => core.cancel({ ...pending, revision: Number.MAX_SAFE_INTEGER }, 20_000), /revision|safe/);
});

test('purge eligibility denies one millisecond early and any ownership or live-session blocker', () => {
  const requestedAt = Date.UTC(2026, 7, 20);
  const pending = core.request(allowance(), requestedAt);

  assert.equal(core.auditEligibility({ allowance: pending, ownedSetCount: 0, blockingSessionCount: 0 }, requestedAt + DAYS_30_MS - 1).eligible, false);
  assert.equal(core.auditEligibility({ allowance: pending, ownedSetCount: 1, blockingSessionCount: 0 }, requestedAt + DAYS_30_MS).eligible, false);
  assert.equal(core.auditEligibility({ allowance: pending, ownedSetCount: 0, blockingSessionCount: 1 }, requestedAt + DAYS_30_MS).eligible, false);
  assert.deepEqual(
    core.auditEligibility({ allowance: pending, ownedSetCount: 0, blockingSessionCount: 0 }, requestedAt + DAYS_30_MS),
    {
      eligible: true,
      blockers: [],
      deletionRequestedAtMs: requestedAt,
      purgeEligibleAtMs: requestedAt + DAYS_30_MS,
      remainingMs: 0,
      ownedSetCount: 0,
      blockingSessionCount: 0,
      revision: 8,
      uid: 'teacher-a'
    }
  );
});

test('purge eligibility treats allocating, active, and live sessions as one blocking count', () => {
  const requestedAt = Date.UTC(2026, 7, 20);
  const pending = core.request(allowance(), requestedAt);
  const result = core.auditEligibility({
    allowance: pending,
    ownedSetCount: 0,
    blockingSessionCount: 3
  }, requestedAt + DAYS_30_MS);

  assert.equal(result.eligible, false);
  assert.deepEqual(result.blockers, ['blocking_sessions']);
  assert.equal(result.blockingSessionCount, 3);
});

test('purge audit fails closed for malformed status, timestamp, revision, counts, UID, or email', () => {
  const pending = core.request(allowance(), 10_000);
  const cases = [
    { allowance: { ...pending, status: 'active' }, ownedSetCount: 0, blockingSessionCount: 0 },
    { allowance: { ...pending, purgeEligibleAtMs: pending.purgeEligibleAtMs + 1 }, ownedSetCount: 0, blockingSessionCount: 0 },
    { allowance: { ...pending, revision: 1.5 }, ownedSetCount: 0, blockingSessionCount: 0 },
    { allowance: { ...pending, uid: '' }, ownedSetCount: 0, blockingSessionCount: 0 },
    { allowance: { ...pending, emailCanonical: 'Teacher@School.KR' }, ownedSetCount: 0, blockingSessionCount: 0 },
    { allowance: pending, ownedSetCount: -1, blockingSessionCount: 0 },
    { allowance: pending, ownedSetCount: 0, blockingSessionCount: 1.5 }
  ];
  for (const value of cases) {
    const result = core.auditEligibility(value, pending.purgeEligibleAtMs);
    assert.equal(result.eligible, false);
    assert.ok(result.blockers.includes('invalid_state'));
  }
});

test('index loads the deletion core before the application inline script', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="teacher-deletion-core\.js"><\/script>/);
});

test('deletion lifecycle UI override requires the exact current UID and canonical email', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = {
    AuthCore: { teacherState: () => ({ status: 'unapproved', uid: '', email: '', role: '' }) }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(html, 'teacherStateFromAllowance'), context);
  const user = { uid: 'teacher-a', email: 'teacher@school.kr', emailVerified: true, isAnonymous: false };
  const pending = { uid: 'teacher-a', emailCanonical: 'teacher@school.kr', status: 'deletion_pending' };

  assert.equal(context.teacherStateFromAllowance(user, pending).status, 'deletion_pending');
  assert.equal(context.teacherStateFromAllowance(user, { ...pending, uid: 'teacher-b' }).status, 'unapproved');
  assert.equal(context.teacherStateFromAllowance(user, {
    ...pending, emailCanonical: 'other@school.kr'
  }).status, 'unapproved');
});

const SERVER_TIMESTAMP = Symbol('server-timestamp');
const DELETE_FIELD = Symbol('delete-field');

function firestoreFake(initial = {}, options = {}) {
  const docs = new Map();
  const calls = [];
  let transactions = 0;
  const committedAt = options.committedAt || 50_000;
  const timestamp = millis => ({ toMillis: () => millis, toDate: () => new Date(millis) });
  const clone = value => {
    if (value === SERVER_TIMESTAMP || value === DELETE_FIELD) return value;
    if (value && typeof value.toMillis === 'function') return timestamp(value.toMillis());
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    return value;
  };
  for (const [key, value] of Object.entries(initial)) docs.set(key, clone(value));
  const resolve = value => value === SERVER_TIMESTAMP ? timestamp(committedAt) :
    value instanceof Date ? timestamp(value.getTime()) :
      Array.isArray(value) ? value.map(resolve) :
        value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)])) : value;
  const snapshot = key => ({
    exists: docs.has(key), id: key.split('/').at(-1),
    data: () => clone(docs.get(key)),
    get: field => clone((docs.get(key) || {})[field])
  });
  const apply = (current, patch) => {
    const output = clone(current || {});
    for (const [key, value] of Object.entries(patch)) {
      if (value === DELETE_FIELD) delete output[key];
      else output[key] = resolve(value);
    }
    return output;
  };
  const docRef = key => ({
    path: key,
    get: async () => snapshot(key),
    set: async (value, config) => {
      docs.set(key, config && config.merge ? apply(docs.get(key), value) : resolve(value));
    }
  });
  const query = collectionPath => {
    const filters = [];
    let maximum = Infinity;
    const api = {
      where(field, operator, value) { filters.push({ field, operator, value }); return api; },
      limit(value) { maximum = value; return api; },
      async get() {
        const prefix = collectionPath + '/';
        const found = [...docs.entries()].filter(([key, value]) => {
          if (!key.startsWith(prefix) || key.slice(prefix.length).includes('/')) return false;
          return filters.every(filter => filter.operator === '=='
            ? value[filter.field] === filter.value
            : filter.operator === 'in' && filter.value.includes(value[filter.field]));
        }).slice(0, maximum).map(([key]) => snapshot(key));
        calls.push({ operation: 'query', collectionPath, filters: clone(filters), limit: maximum });
        return { docs: found, size: found.length, empty: found.length === 0 };
      }
    };
    return api;
  };
  const db = {
    doc: docRef,
    collection: query,
    async runTransaction(callback) {
      transactions += 1;
      calls.push({ operation: 'transaction', number: transactions });
      if (options.failTransaction === transactions) throw new Error('injected transaction failure');
      const staged = [];
      const tx = {
        get: async ref => snapshot(ref.path),
        set(ref, value, config) { staged.push({ ref, value, config }); },
        update(ref, value) { staged.push({ ref, value, config: { merge: true } }); }
      };
      const output = await callback(tx);
      for (const item of staged) {
        docs.set(item.ref.path, item.config && item.config.merge
          ? apply(docs.get(item.ref.path), item.value) : resolve(item.value));
      }
      return output;
    }
  };
  return {
    db,
    fieldValue: { serverTimestamp: () => SERVER_TIMESTAMP, delete: () => DELETE_FIELD },
    read: key => clone(docs.get(key)),
    calls: () => clone(calls)
  };
}

function storedAllowance(overrides = {}) {
  const at = { toMillis: () => 1, toDate: () => new Date(1) };
  return allowance({
    revision: undefined,
    approvedAt: at,
    updatedAt: at,
    ...overrides
  });
}

test('store request uses a server timestamp then settles the exact 30-day Timestamp and disables legacy access', async () => {
  const fake = firestoreFake({
    'teacher_allowances/teacher-a': storedAllowance(),
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 49_000);

  const result = await store.requestTeacherDeletion('teacher-a');
  const saved = fake.read('teacher_allowances/teacher-a');

  assert.equal(result.status, 'deletion_pending');
  assert.equal(saved.status, 'deletion_pending');
  assert.equal(saved.enabled, false);
  assert.equal(saved.revision, 2);
  assert.equal(saved.deletionRequestedAt.toMillis(), 50_000);
  assert.equal(saved.purgeEligibleAt.toMillis(), 50_000 + DAYS_30_MS);
  assert.equal(saved.updatedByUid, 'teacher-a');
  assert.equal(fake.read('teacher_allowlist/teacher@school.kr').enabled, false);
  assert.equal(fake.calls().filter(call => call.operation === 'transaction').length, 2);
});

test('store request leaves an immediately disabled recoverable state when exact eligibility settlement fails', async () => {
  const fake = firestoreFake({
    'teacher_allowances/teacher-a': storedAllowance(),
    'teacher_allowlist/teacher@school.kr': { enabled: true, role: 'teacher' }
  }, { failTransaction: 2 });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 49_000);

  await assert.rejects(store.requestTeacherDeletion('teacher-a'), /transaction|settle|timestamp|failure/i);
  const saved = fake.read('teacher_allowances/teacher-a');
  assert.equal(saved.status, 'deletion_pending');
  assert.equal(saved.enabled, false);
  assert.equal(saved.revision, 1);
  assert.equal(saved.deletionRequestedAt.toMillis(), 50_000);
  assert.equal(Object.hasOwn(saved, 'purgeEligibleAt'), false);
  assert.equal(fake.read('teacher_allowlist/teacher@school.kr').enabled, false);
});

test('store cancellation restores active or suspended from the exact server state without changing identity', async t => {
  for (const administrativeHold of [false, true]) {
    await t.test(administrativeHold ? 'administrative hold' : 'no hold', async () => {
      const requestedAt = { toMillis: () => 10_000, toDate: () => new Date(10_000) };
      const purgeAt = { toMillis: () => 10_000 + DAYS_30_MS, toDate: () => new Date(10_000 + DAYS_30_MS) };
      const fake = firestoreFake({
        'teacher_allowances/teacher-a': storedAllowance({
          status: 'deletion_pending', enabled: false, administrativeHold, revision: 4,
          deletionRequestedAt: requestedAt, purgeEligibleAt: purgeAt,
          ...(administrativeHold ? {
            suspendedAt: { toMillis: () => 20_000, toDate: () => new Date(20_000) },
            suspendedByUid: 'admin-a', suspensionReason: 'independent-hold'
          } : {})
        }),
        'teacher_allowlist/teacher@school.kr': { enabled: false, role: 'teacher' }
      }, { committedAt: 30_000 });
      const store = createFirestoreStore(fake.db, fake.fieldValue, () => 29_000);

      const result = await store.cancelTeacherDeletion('teacher-a');
      const saved = fake.read('teacher_allowances/teacher-a');
      assert.equal(result.status, administrativeHold ? 'suspended' : 'active');
      assert.equal(saved.status, administrativeHold ? 'suspended' : 'active');
      assert.equal(saved.enabled, !administrativeHold);
      assert.equal(saved.revision, 5);
      assert.equal(saved.uid, 'teacher-a');
      assert.equal(saved.emailCanonical, 'teacher@school.kr');
      assert.equal(Object.hasOwn(saved, 'deletionRequestedAt'), false);
      assert.equal(Object.hasOwn(saved, 'purgeEligibleAt'), false);
      assert.equal(fake.read('teacher_allowlist/teacher@school.kr').enabled, !administrativeHold);
    });
  }
});

test('store cancellation recovers the safely disabled phase-one state before timestamp settlement', async () => {
  const requestedAt = { toMillis: () => 10_000, toDate: () => new Date(10_000) };
  const fake = firestoreFake({
    'teacher_allowances/teacher-a': storedAllowance({
      status: 'deletion_pending', enabled: false, administrativeHold: false, revision: 4,
      deletionRequestedAt: requestedAt
    }),
    'teacher_allowlist/teacher@school.kr': { enabled: false, role: 'teacher' }
  }, { committedAt: 30_000 });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 29_000);

  const result = await store.cancelTeacherDeletion('teacher-a');

  assert.equal(result.status, 'active');
  assert.equal(result.enabled, true);
  assert.equal(result.revision, 5);
  assert.equal(Object.hasOwn(result, 'deletionRequestedAt'), false);
  assert.equal(Object.hasOwn(result, 'purgeEligibleAt'), false);
  assert.equal(fake.read('teacher_allowlist/teacher@school.kr').enabled, true);
});

test('store deletion readiness returns exact own sets and allocating/active/live session identities', async () => {
  const fake = firestoreFake({
    'quiz_sets/own-active': { ownerUid: 'teacher-a', lifecycleState: 'active', title: 'private-title' },
    'quiz_sets/own-trash': { ownerUid: 'teacher-a', lifecycleState: 'trashed', title: 'private-trash' },
    'quiz_sets/other': { ownerUid: 'teacher-b', lifecycleState: 'active', title: 'other-private' },
    'sessions/live': { teacherUid: 'teacher-a', status: 'live', label: 'own-live' },
    'sessions/allocating': { teacherUid: 'teacher-a', status: 'allocating', code: 'ABC123', label: 'recover-me' },
    'sessions/active': { teacherUid: 'teacher-a', status: 'active', code: 'ABC124', label: 'legacy-live' },
    'sessions/ended': { teacherUid: 'teacher-a', status: 'ended', label: 'old' },
    'sessions/other': { teacherUid: 'teacher-b', status: 'live', label: 'other-live' }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1);

  assert.deepEqual(await store.getTeacherDeletionReadiness('teacher-a'), {
    ownedSetCount: 2,
    blockingSessionCount: 3,
    blockingSessions: [
      { sessionId: 'live', status: 'live', code: '', label: 'own-live' },
      { sessionId: 'allocating', status: 'allocating', code: 'ABC123', label: 'recover-me' },
      { sessionId: 'active', status: 'active', code: 'ABC124', label: 'legacy-live' }
    ],
    ownedSetLimitReached: false,
    blockingSessionLimitReached: false
  });
  assert.deepEqual(fake.calls().filter(call => call.operation === 'query').map(call => call.filters), [
    [{ field: 'ownerUid', operator: '==', value: 'teacher-a' }],
    [
      { field: 'teacherUid', operator: '==', value: 'teacher-a' },
      { field: 'status', operator: 'in', value: ['allocating', 'active', 'live'] }
    ]
  ]);
});

test('admin cancellation uses exact target and revision and preserves an administrative hold', async () => {
  const requestedAt = { toMillis: () => 10_000, toDate: () => new Date(10_000) };
  const purgeAt = { toMillis: () => 10_000 + DAYS_30_MS, toDate: () => new Date(10_000 + DAYS_30_MS) };
  const fake = firestoreFake({
    'teacher_allowances/admin-a': storedAllowance({
      uid: 'admin-a', emailCanonical: 'admin@school.kr', role: 'admin',
      status: 'active', enabled: true, revision: 2
    }),
    'teacher_allowances/teacher-a': storedAllowance({
      status: 'deletion_pending', enabled: false, administrativeHold: true, revision: 9,
      deletionRequestedAt: requestedAt, purgeEligibleAt: purgeAt,
      suspendedAt: requestedAt, suspendedByUid: 'admin-a', suspensionReason: 'independent-hold'
    }),
    'teacher_allowlist/teacher@school.kr': { enabled: false, role: 'teacher' }
  }, { committedAt: 20_000 });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 19_000);
  const actor = {
    uid: 'admin-a', email: 'admin@school.kr', role: 'admin',
    authGeneration: 3, currentAuthGeneration: 3
  };

  await assert.rejects(store.adminCancelTeacherDeletion('teacher-a', 8, actor), /revision|변경/);
  const result = await store.adminCancelTeacherDeletion('teacher-a', 9, actor);

  assert.equal(result.status, 'suspended');
  assert.equal(result.enabled, false);
  assert.equal(result.administrativeHold, true);
  assert.equal(result.revision, 10);
  assert.equal(result.updatedByUid, 'admin-a');
  assert.equal(Object.hasOwn(result, 'deletionRequestedAt'), false);
  assert.equal(Object.hasOwn(result, 'purgeEligibleAt'), false);
});

function extractFunction(source, name) {
  let start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('unterminated function ' + name);
}

test('deletion UI requires typed acknowledgment, preserves safe pending state on failure, and never renders other-account details', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = { innerHTML: '' };
  const alerts = [];
  let allowanceReads = 0;
  const context = {
    Promise,
    console,
    teacherDeletionScreen: null,
    teacherAuthVersion: 4,
    teacherUser: { uid: 'teacher-a', email: 'teacher@school.kr' },
    teacherState: { uid: 'teacher-a', status: 'teacher', role: 'teacher' },
    teacherAllowance: { uid: 'teacher-a', emailCanonical: 'teacher@school.kr', status: 'active', enabled: true },
    location: { hash: '#/' },
    APP: () => app,
    topbar: () => '<nav>safe</nav>',
    esc: value => String(value),
    alert: message => alerts.push(message),
    renderTeacherAuthArea() {},
    setTeacherAllowance(value) { context.teacherState = { uid: value.uid, status: value.status, role: '' }; },
    store: {
      async getTeacherDeletionReadiness() {
        return {
          ownedSetCount: 2,
          blockingSessionCount: 2,
          blockingSessions: [
            { sessionId: 'alloc-a', status: 'allocating', code: 'ABC123', label: '복구할 반' },
            { sessionId: 'live-a', status: 'live', code: 'ABC124', label: '종료할 반' }
          ],
          ownedSetLimitReached: false,
          blockingSessionLimitReached: false
        };
      },
      async resolveTeacherDeletionSession(uid, sessionId) {
        if (uid !== 'teacher-a' || sessionId !== 'alloc-a') throw new Error('wrong target');
        return { complete: true, status: 'aborted' };
      },
      async requestTeacherDeletion() {
        throw new Error('settlement failed after safe disable');
      },
      async getOwnTeacherAllowance() {
        allowanceReads += 1;
        return allowanceReads === 1
          ? { uid: 'teacher-a', emailCanonical: 'teacher@school.kr', status: 'active', enabled: true }
          : { uid: 'teacher-a', emailCanonical: 'teacher@school.kr', status: 'deletion_pending', enabled: false };
      }
    }
  };
  vm.createContext(context);
  for (const name of [
    'teacherDeletionScreenIsCurrent', 'renderTeacherDeletion', 'screenTeacherDeletion',
    'requestTeacherDeletion', 'cancelTeacherDeletion', 'resolveTeacherDeletionSession'
  ]) vm.runInContext(extractFunction(html, name), context);

  await context.screenTeacherDeletion();
  assert.match(app.innerHTML, /소유 세트 2개/);
  assert.match(app.innerHTML, /정리 필요 세션 2개/);
  assert.doesNotMatch(app.innerHTML, /할당 정리|안전 종료/);
  assert.doesNotMatch(app.innerHTML, /teacher-b|other-private|other-live/);

  const wrong = { value: '탈퇴', disabled: false };
  assert.equal(await context.requestTeacherDeletion(wrong), false);
  assert.equal(alerts.length, 1);

  const exact = { value: '계정 사용 종료 요청', disabled: false };
  assert.equal(await context.requestTeacherDeletion(exact), false);
  assert.equal(context.teacherState.status, 'deletion_pending');
  assert.match(app.innerHTML, /안전하게 중지|정리 시각|다시 확인/);
  assert.match(app.innerHTML, /복구할 반/);
  assert.match(app.innerHTML, /할당 정리/);
  assert.match(app.innerHTML, /종료할 반/);
  assert.match(app.innerHTML, /안전 종료/);

  context.teacherDeletionScreen.readiness = {
    ownedSetCount: 0,
    blockingSessionCount: 1,
    blockingSessions: [{ sessionId: 'alloc-a', status: 'allocating', code: 'ABC123', label: '복구할 반' }]
  };
  assert.equal(await context.resolveTeacherDeletionSession('alloc-a'), true);
  assert.equal(context.teacherDeletionScreen.readiness.blockingSessionCount, 0);
});

test('admin deletion UI submits the exact pending target and revision and removes only that row', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = { innerHTML: '' };
  const calls = [];
  const state = {
    adm: { tab: 'requests' }, body, uid: 'admin-a', authGeneration: 5,
    requests: {}, deletions: {
      'teacher-a': {
        uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: '김교사',
        status: 'deletion_pending', revision: 9, administrativeHold: true
      }
    },
    loading: false, inFlight: null, message: '', error: '', loadError: ''
  };
  const context = {
    Promise,
    teacherAuthVersion: 5,
    teacherUser: { uid: 'admin-a' },
    teacherState: { uid: 'admin-a', email: 'admin@school.kr', role: 'admin', status: 'teacher' },
    adm: state.adm,
    adminTeacherRequestScreen: state,
    location: { hash: '#/admin' },
    AuthCore: { isAdmin: value => value && value.role === 'admin' },
    $: selector => selector === '#adm-body' ? body : null,
    esc: value => String(value),
    store: {
      async adminCancelTeacherDeletion(uid, revision, actor) {
        calls.push({ uid, revision, actorUid: actor.uid });
        return { status: 'suspended', revision: revision + 1 };
      }
    }
  };
  vm.createContext(context);
  for (const name of [
    'adminTeacherRequestScreenIsCurrent', 'renderAdminTeacherRequests',
    'adminCancelTeacherDeletionRequest'
  ]) vm.runInContext(extractFunction(html, name), context);

  assert.equal(context.renderAdminTeacherRequests(), true);
  assert.match(body.innerHTML, /김교사/);
  assert.match(body.innerHTML, /관리자 철회/);
  assert.equal(await context.adminCancelTeacherDeletionRequest('teacher-a', 8), false);
  assert.equal(await context.adminCancelTeacherDeletionRequest('teacher-a', 9), true);
  assert.deepEqual(calls, [{ uid: 'teacher-a', revision: 9, actorUid: 'admin-a' }]);
  assert.equal(Object.hasOwn(state.deletions, 'teacher-a'), false);
});
