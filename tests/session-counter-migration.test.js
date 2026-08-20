const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../session-counter-migration.js');
const cli = require('../scripts/migrate-session-counters.js');

const DELETE = Symbol('delete-field');
function timestamp(milliseconds) {
  return {
    toMillis() { return milliseconds; },
    isEqual(other) { return Boolean(other) && other.toMillis() === milliseconds; }
  };
}

function fakeDb(initial, options = {}) {
  const docs = new Map(Object.entries(initial));
  const versions = new Map([...docs.keys()].map(documentPath => [documentPath, 1]));
  const writes = [];
  const collectionReads = new Map();
  let transactionCount = 0;
  const setValue = (documentPath, value) => {
    docs.set(documentPath, value);
    versions.set(documentPath, (versions.get(documentPath) || 0) + 1);
  };
  const snapshot = documentPath => ({
    exists: docs.has(documentPath), id: documentPath.split('/').at(-1),
    ref: { path: documentPath }, data: () => docs.get(documentPath),
    updateTime: { seconds: 100, nanoseconds: versions.get(documentPath) || 0 }
  });
  const children = collectionPath => [...docs.keys()].filter(documentPath =>
    documentPath.startsWith(collectionPath + '/') &&
    !documentPath.slice(collectionPath.length + 1).includes('/'));
  const collectionSnapshot = collectionPath => ({
    docs: children(collectionPath).map(snapshot), size: children(collectionPath).length
  });
  const collection = collectionPath => ({
    path: collectionPath, kind: 'collection', async get() {
      const call = (collectionReads.get(collectionPath) || 0) + 1;
      collectionReads.set(collectionPath, call);
      if (options.failCollectionRead && options.failCollectionRead[collectionPath] === call) {
        throw new Error(`authoritative collection read failed: ${collectionPath}:${call}`);
      }
      if (options.onCollectionRead) await options.onCollectionRead({ collectionPath, call, docs, setValue });
      return collectionSnapshot(collectionPath);
    }
  });
  return {
    docs, writes, setValue,
    collection,
    doc(documentPath) { return { path: documentPath, async get() { return snapshot(documentPath); } }; },
    async runTransaction(handler) {
      transactionCount += 1;
      if (options.beforeTransaction) {
        await options.beforeTransaction({ transactionCount, docs, setValue });
      }
      const pending = [];
      const transaction = {
        async get(target) {
          return target.kind === 'collection' ? collectionSnapshot(target.path) : snapshot(target.path);
        },
        set(ref, value, setOptions) { pending.push([ref.path, value, setOptions]); }
      };
      const result = await handler(transaction);
      for (const [documentPath, patch, setOptions] of pending) {
        const next = setOptions && setOptions.merge ? { ...(docs.get(documentPath) || {}) } : {};
        for (const [key, value] of Object.entries(patch)) {
          if (value === DELETE) delete next[key];
          else next[key] = value;
        }
        setValue(documentPath, next);
        writes.push({ path: documentPath, value: next });
      }
      return result;
    }
  };
}

function baseSession(status = 'live') {
  return { status, teacherUid: 'teacher-a', teacherEmail: 'teacher@school.kr' };
}

test('dry-run scans every allocating active and live session, ignores ended/aborted, and writes nothing', async () => {
  const db = fakeDb({
    'sessions/alloc': baseSession('allocating'),
    'sessions/active': baseSession('active'),
    'sessions/live': baseSession('live'),
    'sessions/ended': baseSession('ended'),
    'sessions/aborted': baseSession('aborted'),
    'sessions/live/students/s1': { uid: 's1' }
  });
  const report = await migration.runSessionCounterMigration({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.audit.totalNonEndedSessions, 3);
  assert.equal(report.audit.missingCounterCount, 3);
  assert.equal(report.plannedCount, 3);
  assert.equal(report.safeToDeployStrictRules, false);
  assert.deepEqual(db.writes, []);
  assert.equal(db.docs.has('migration_gates/session_counters'), false);
});

test('apply recounts authoritative student documents and creates the exact completion gate last', async () => {
  const db = fakeDb({
    'sessions/a': baseSession('live'),
    'sessions/a/students/student-a': { uid: 'student-a' },
    'sessions/a/students/student-b': { uid: 'student-b' },
    'sessions/b': { ...baseSession('active'), registeredStudentCount: 0, studentCountRevision: 0 }
  });
  const report = await migration.runSessionCounterMigration({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  });
  assert.deepEqual(db.docs.get('sessions/a'), {
    ...baseSession('live'), registeredStudentCount: 2, studentCountRevision: 2,
    lastStudentUid: 'student-b'
  });
  assert.deepEqual(db.docs.get('migration_gates/session_counters'), {
    complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
    rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
    verifiedAt: db.docs.get('migration_gates/session_counters').verifiedAt,
    updatedAt: db.docs.get('migration_gates/session_counters').updatedAt,
    completedByUid: 'admin-a'
  });
  assert.equal(report.appliedCount, 1);
  assert.equal(report.gate.updateTimeGeneration, '100:1');
  assert.equal(report.safeToDeployStrictRules, true);
  assert.equal(db.writes.at(-1).path, 'migration_gates/session_counters');
});

test('transaction recount re-reads a concurrent join and never installs a stale count', async () => {
  let raced = false;
  const db = fakeDb({
    'sessions/a': baseSession('live'),
    'sessions/a/students/student-a': { uid: 'student-a' }
  }, {
    beforeTransaction({ docs, setValue }) {
      if (!raced) {
        raced = true;
        setValue('sessions/a/students/student-b', { uid: 'student-b' });
      }
    }
  });
  const report = await migration.runSessionCounterMigration({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  });
  assert.equal(db.docs.get('sessions/a').registeredStudentCount, 2);
  assert.equal(db.docs.get('sessions/a').studentCountRevision, 2);
  assert.equal(report.reclassifiedCount, 1);
  assert.equal(report.safeToDeployStrictRules, true);
});

test('malformed student identity or counter mismatch keeps the gate absent and report unsafe', async () => {
  const malformed = fakeDb({
    'sessions/a': baseSession('live'),
    'sessions/a/students/student-a': { uid: 'other-student' }
  });
  const report = await migration.runSessionCounterMigration({
    db: malformed, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  });
  assert.equal(report.audit.invalidStudentCount, 1);
  assert.equal(report.safeToDeployStrictRules, false);
  assert.equal(malformed.docs.has('migration_gates/session_counters'), false);
});

test('an exact existing completion gate is idempotent, but a wrong target gate is never overwritten', async () => {
  const gateTime = timestamp(1000);
  const gate = {
    complete: true, projectId: 'demo-video-quiz', environment: 'emulator',
    rulesVersion: 'session-counters-v1', preflightNonEndedLegacyCount: 0,
    verifiedAt: gateTime, updatedAt: gateTime, completedByUid: 'admin-a'
  };
  const exact = fakeDb({
    'migration_gates/session_counters': gate,
    'sessions/a': { ...baseSession('live'), registeredStudentCount: 0, studentCountRevision: 0 }
  });
  const retry = await migration.runSessionCounterMigration({
    db: exact, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  });
  assert.equal(retry.appliedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
  assert.deepEqual(exact.writes, []);

  const wrong = fakeDb({
    'migration_gates/session_counters': { ...gate, projectId: 'other-project' },
    'sessions/a': baseSession('live')
  });
  await assert.rejects(migration.runSessionCounterMigration({
    db: wrong, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  }), /gate.*project|project.*gate/i);
  assert.deepEqual(wrong.docs.get('migration_gates/session_counters'), { ...gate, projectId: 'other-project' });
});

test('post-gate authoritative audit failure exposes cumulative progress and never claims safety', async () => {
  const db = fakeDb({ 'sessions/a': baseSession('live') }, {
    failCollectionRead: { sessions: 3 }
  });
  await assert.rejects(migration.runSessionCounterMigration({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz',
    serverTimestamp: () => timestamp(1000), deleteField: () => DELETE
  }), error => {
    assert.match(error.message, /authoritative collection read failed/);
    assert.equal(error.partialReport.appliedCount, 1);
    assert.equal(error.partialReport.gate.created, true);
    assert.equal(error.partialReport.status, 'partial-failure');
    assert.equal(error.partialReport.safeToDeployStrictRules, false);
    return true;
  });
});

test('CLI enforces exact targets and output reservation before Admin init, preserving success if stdout fails', async () => {
  assert.throws(() => cli.parseArgs([
    '--project', 'demo-video-quiz', '--apply', '--admin-uid', 'admin-a'
  ]), /confirm-project/i);
  assert.throws(() => cli.validateTarget({ projectId: 'video-quiz-65798', targetMode: 'emulator' }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /demo/i);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-counter-migration-'));
  let initialized = 0;
  try {
    const existing = path.join(directory, 'existing.json');
    fs.writeFileSync(existing, '{"foreign":true}\n', { flag: 'wx' });
    await assert.rejects(cli.main([
      '--project', 'demo-video-quiz', '--admin-uid', 'admin-a', '--output', existing
    ], {
      environment: {}, reserveReport: cli.reserveReport,
      initialize() { initialized += 1; throw new Error('must not initialize'); },
      runSessionCounterMigration() { throw new Error('must not run'); }, writeLine() {}
    }), /exist|EEXIST/i);
    assert.equal(initialized, 0);

    const success = path.join(directory, 'success.json');
    await assert.rejects(cli.main([
      '--project', 'demo-video-quiz', '--admin-uid', 'admin-a', '--output', success
    ], {
      environment: {}, reserveReport: cli.reserveReport,
      initialize() {
        initialized += 1;
        return { db: {}, serverTimestamp() {}, deleteField() {}, close() {} };
      },
      async runSessionCounterMigration() {
        return { status: 'complete', mode: 'dry-run', safeToDeployStrictRules: false };
      },
      writeLine() { throw new Error('stdout failed after publication'); }
    }), /stdout failed/);
    assert.equal(JSON.parse(fs.readFileSync(success, 'utf8')).status, 'complete');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
