const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../teacher-access-migration.js');
const cli = require('../scripts/migrate-teacher-access-status.js');

const PRODUCTION_EVIDENCE_IDENTITY = [
  '--window-id', '8f81218d-f1ec-497a-9b33-2b895ef82780',
  '--control-id', '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45'
];

function timestamp(milliseconds) {
  return { toMillis() { return milliseconds; } };
}

function firestoreTimestamp(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const nanoseconds = (milliseconds - seconds * 1000) * 1_000_000;
  return {
    seconds, nanoseconds,
    toMillis() { return milliseconds; },
    isEqual(other) {
      return Boolean(other) && other.seconds === seconds && other.nanoseconds === nanoseconds;
    }
  };
}

function googleUser(uid, email, displayName = '교사') {
  return {
    uid, email, displayName, emailVerified: true,
    providerData: [{ providerId: 'google.com' }]
  };
}

function fakeDb(initial, options = {}) {
  const docs = new Map(Object.entries(initial));
  const versions = new Map([...docs.keys()].map(key => [key, 1]));
  const writes = [];
  const collectionReads = new Map();
  const documentReads = new Map();
  let transactionCount = 0;
  const snapshot = documentPath => ({
    exists: docs.has(documentPath),
    id: documentPath.split('/').at(-1),
    ref: { path: documentPath },
    data: () => docs.get(documentPath),
    updateTime: { seconds: versions.get(documentPath) || 0, nanoseconds: 0 }
  });
  const directChildren = collectionPath => [...docs.keys()]
    .filter(documentPath => documentPath.startsWith(collectionPath + '/') &&
      !documentPath.slice(collectionPath.length + 1).includes('/'));
  return {
    docs,
    writes,
    doc(documentPath) { return { path: documentPath, async get() {
      const call = (documentReads.get(documentPath) || 0) + 1;
      documentReads.set(documentPath, call);
      if (options.beforeDocumentRead) {
        await options.beforeDocumentRead({ documentPath, call, docs, versions });
      }
      return snapshot(documentPath);
    } }; },
    collection(collectionPath) {
      return { async get() {
        const call = (collectionReads.get(collectionPath) || 0) + 1;
        collectionReads.set(collectionPath, call);
        if (options.failCollectionRead && options.failCollectionRead[collectionPath] === call) {
          throw new Error(`authoritative collection read failed: ${collectionPath}:${call}`);
        }
        return { docs: directChildren(collectionPath).map(snapshot) };
      } };
    },
    collectionReadCount(collectionPath) { return collectionReads.get(collectionPath) || 0; },
    documentReadCount(documentPath) { return documentReads.get(documentPath) || 0; },
    async runTransaction(handler) {
      transactionCount += 1;
      if (options.beforeTransaction) {
        await options.beforeTransaction({ docs, transactionCount });
      }
      const pending = [];
      const transaction = {
        async get(ref) { return snapshot(ref.path); },
        set(ref, value) { pending.push([ref.path, value]); }
      };
      const result = await handler(transaction);
      for (const [documentPath, value] of pending) {
        docs.set(documentPath, value);
        versions.set(documentPath, (versions.get(documentPath) || 0) + 1);
        writes.push({ path: documentPath, value });
      }
      return result;
    }
  };
}

function fakeAuth(users, options = {}) {
  const byEmail = new Map(users.map(user => [String(user.email).toLowerCase(), user]));
  let readCount = 0;
  return {
    get readCount() { return readCount; },
    async getUserByEmail(email) {
      readCount += 1;
      if (options.failAt === readCount) throw new Error('auth enumeration failed');
      const user = byEmail.get(String(email).toLowerCase());
      if (!user) {
        const error = new Error('no auth user');
        error.code = 'auth/user-not-found';
        throw error;
      }
      return user;
    }
  };
}

function completedAccessState(patch = {}) {
  const at = firestoreTimestamp(1000);
  return {
    'teacher_allowlist/a@school.kr': {
      uid: 'uid-a', enabled: true, role: 'teacher', updatedAt: at, updatedByUid: 'admin-a'
    },
    'teacher_allowances/uid-a': {
      uid: 'uid-a', emailCanonical: 'a@school.kr', displayName: '교사',
      status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
      revision: 1, approvedAt: at, approvedByUid: 'admin-a',
      updatedAt: at, updatedByUid: 'admin-a'
    },
    'migration_gates/teacher_access_status': {
      locked: true, lockToken: 'token-a', projectId: 'demo-video-quiz',
      targetMode: 'emulator', lockedAt: at, lockedByUid: 'admin-a',
      status: 'complete', strictReady: true, migrationGeneration: '1:0',
      completedAt: at, completedByUid: 'admin-a',
      ...patch
    }
  };
}

test('legacy enabled state maps to exact active or suspended authoritative allowance', () => {
  const at = timestamp(1000);
  assert.deepEqual(migration.buildAllowance({
    emailCanonical: 'active@school.kr', legacy: { enabled: true, role: 'teacher' },
    user: googleUser('uid-active', 'active@school.kr', '홍교사'), adminUid: 'admin-a', at
  }), {
    uid: 'uid-active', emailCanonical: 'active@school.kr', displayName: '홍교사',
    status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
    revision: 1,
    approvedAt: at, approvedByUid: 'admin-a', updatedAt: at, updatedByUid: 'admin-a'
  });
  assert.equal(migration.buildAllowance({
    emailCanonical: 'off@school.kr', legacy: { enabled: false, role: 'admin' },
    user: googleUser('uid-off', 'off@school.kr'), adminUid: 'admin-a', at
  }).status, 'suspended');
  assert.equal(migration.buildAllowance({
    emailCanonical: 'off@school.kr', legacy: { enabled: false, role: 'admin' },
    user: googleUser('uid-off', 'off@school.kr'), adminUid: 'admin-a', at
  }).administrativeHold, true);
});

test('planned writes accept the opaque Admin serverTimestamp transform before commit materializes it', () => {
  const serverTimestampTransform = Object.freeze({ kind: 'ServerTimestampTransform' });
  const allowance = migration.buildAllowance({
    emailCanonical: 'active@school.kr', legacy: { enabled: true, role: 'teacher' },
    user: googleUser('uid-active', 'active@school.kr', '홍교사'),
    adminUid: 'admin-a', at: serverTimestampTransform
  });
  assert.equal(allowance.approvedAt, serverTimestampTransform);
  assert.equal(allowance.updatedAt, serverTimestampTransform);
});

test('dry-run is read-only and malformed or missing exact Auth identity closes the gate', async () => {
  const db = fakeDb({
    'teacher_allowlist/good@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowlist/Mixed@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowlist/missing@school.kr': { enabled: true, role: 'teacher' }
  });
  const report = await migration.runTeacherAccessMigration({
    db,
    auth: fakeAuth([googleUser('uid-good', 'good@school.kr')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    serverTimestamp: () => timestamp(1000)
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plannedCount, 1);
  assert.equal(report.audit.invalidLegacyCount, 1);
  assert.equal(report.audit.missingAuthUserCount, 1);
  assert.equal(report.safeToDeployStrictRules, false);
  assert.deepEqual(db.writes, []);
});

test('apply writes exact compatibility and authoritative records, then retries idempotently', async () => {
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': { enabled: true, role: 'teacher', displayName: '홍교사' },
    'teacher_allowlist/b@school.kr': { enabled: false, role: 'admin' }
  });
  const auth = fakeAuth([
    googleUser('uid-a', 'a@school.kr', '홍교사'),
    googleUser('uid-b', 'b@school.kr', '박교사')
  ]);
  const options = {
    db, auth, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', serverTimestamp: () => timestamp(1000)
  };
  const applied = await migration.runTeacherAccessMigration(options);
  assert.equal(applied.appliedCount, 2);
  assert.equal(applied.safeToDeployStrictRules, true);
  assert.deepEqual(db.docs.get('teacher_allowlist/a@school.kr'), {
    uid: 'uid-a', enabled: true, role: 'teacher', updatedAt: db.docs.get('teacher_allowlist/a@school.kr').updatedAt,
    updatedByUid: 'admin-a'
  });
  assert.deepEqual(db.docs.get('teacher_allowances/uid-b'), {
    uid: 'uid-b', emailCanonical: 'b@school.kr', displayName: '박교사',
    status: 'suspended', enabled: false, role: 'admin', administrativeHold: true,
    revision: 1,
    approvedAt: db.docs.get('teacher_allowances/uid-b').approvedAt,
    approvedByUid: 'admin-a', updatedAt: db.docs.get('teacher_allowances/uid-b').updatedAt,
    updatedByUid: 'admin-a'
  });
  const writeCount = db.writes.length;
  const retry = await migration.runTeacherAccessMigration(options);
  assert.equal(retry.plannedCount, 0);
  assert.equal(retry.appliedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
  assert.equal(db.writes.length, writeCount);
});

test('apply holds exact generation-bound migration lock until explicit token unlock', async () => {
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': { enabled: true, role: 'teacher' }
  });
  const report = await migration.runTeacherAccessMigration({
    db, auth: fakeAuth([googleUser('uid-a', 'a@school.kr')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', lockToken: 'exact-lock-token',
    serverTimestamp: () => timestamp(1000)
  });
  assert.equal(report.lock.locked, true);
  assert.equal(report.lock.status, 'complete');
  assert.equal(report.lock.strictReady, true);
  assert.equal(report.lock.lockToken, 'exact-lock-token');
  assert.match(report.lock.updateTimeGeneration, /^\d+:\d+$/);
  assert.equal(db.docs.get('migration_gates/teacher_access_status').locked, true);
  await assert.rejects(migration.unlockTeacherAccessGate({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    lockToken: 'wrong', expectedGeneration: report.lock.updateTimeGeneration,
    serverTimestamp: () => timestamp(2000)
  }), /token/i);
  const unlocked = await migration.unlockTeacherAccessGate({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    lockToken: 'exact-lock-token', expectedGeneration: report.lock.updateTimeGeneration,
    serverTimestamp: () => timestamp(2000)
  });
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.status, 'complete');
  assert.equal(unlocked.strictReady, true);
  assert.equal(db.docs.get('migration_gates/teacher_access_status').lockToken, 'exact-lock-token');
  const relocked = await migration.acquireTeacherAccessGate({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    lockToken: 'retry-token', serverTimestamp: () => timestamp(3000)
  });
  assert.equal(relocked.status, 'complete');
  assert.equal(relocked.strictReady, true);
  assert.equal(relocked.migrationGeneration, report.lock.migrationGeneration);
});

test('Auth display name remains stable after legacy-only profile fields are removed', async () => {
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': {
      enabled: true, role: 'teacher', displayName: '낡은 레거시 이름'
    }
  });
  const options = {
    db, auth: fakeAuth([googleUser('uid-a', 'a@school.kr', '현재 Auth 이름')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', serverTimestamp: () => timestamp(1000)
  };
  const applied = await migration.runTeacherAccessMigration(options);
  assert.equal(db.docs.get('teacher_allowances/uid-a').displayName, '현재 Auth 이름');
  assert.equal(applied.safeToDeployStrictRules, true);
  const retry = await migration.runTeacherAccessMigration(options);
  assert.equal(retry.plannedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
});

test('transaction reread reclassifies a concurrent enabled change instead of restoring stale access', async () => {
  let raced = false;
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': { enabled: true, role: 'teacher' }
  }, {
    beforeTransaction({ docs, transactionCount }) {
      if (!raced && transactionCount === 2) {
        raced = true;
        docs.set('teacher_allowlist/a@school.kr', { enabled: false, role: 'teacher' });
      }
    }
  });
  const report = await migration.runTeacherAccessMigration({
    db, auth: fakeAuth([googleUser('uid-a', 'a@school.kr')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', serverTimestamp: () => timestamp(1000)
  });
  assert.equal(report.reclassifiedCount, 1);
  assert.equal(db.docs.get('teacher_allowances/uid-a').status, 'suspended');
  assert.equal(db.docs.get('teacher_allowances/uid-a').enabled, false);
  assert.equal(report.safeToDeployStrictRules, true);
});

test('mismatched existing allowance and orphan allowance remain untouched and fail final audit', async () => {
  const existing = {
    uid: 'wrong-uid', emailCanonical: 'a@school.kr', displayName: '교사',
    status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
    approvedAt: timestamp(1), approvedByUid: 'admin-a', updatedAt: timestamp(1), updatedByUid: 'admin-a'
  };
  const orphan = { ...existing, uid: 'uid-orphan', emailCanonical: 'orphan@school.kr' };
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': { enabled: true, role: 'teacher' },
    'teacher_allowances/uid-a': existing,
    'teacher_allowances/uid-orphan': orphan
  });
  const report = await migration.runTeacherAccessMigration({
    db, auth: fakeAuth([googleUser('uid-a', 'a@school.kr')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', serverTimestamp: () => timestamp(1000)
  });
  assert.equal(report.appliedCount, 0);
  assert.equal(report.audit.allowanceMismatchCount >= 1, true);
  assert.equal(report.audit.orphanAllowanceCount, 1);
  assert.equal(report.safeToDeployStrictRules, false);
  assert.equal(db.docs.get('teacher_allowances/uid-a'), existing);
});

test('a failed authoritative final audit carries cumulative partial progress', async () => {
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': { enabled: true, role: 'teacher' }
  }, { failCollectionRead: { teacher_allowlist: 2 } });
  await assert.rejects(migration.runTeacherAccessMigration({
    db, auth: fakeAuth([googleUser('uid-a', 'a@school.kr')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', serverTimestamp: () => timestamp(1000)
  }), error => {
    assert.match(error.message, /authoritative collection read failed/);
    assert.equal(error.partialReport.appliedCount, 1);
    assert.equal(error.partialReport.status, 'partial-failure');
    assert.equal(error.partialReport.safeToDeployStrictRules, false);
    assert.match(error.partialReport.auditError, /authoritative collection read failed/);
    return true;
  });
});

test('a completion-generation post-audit failure never claims release safety', async () => {
  const db = fakeDb({
    'teacher_allowlist/a@school.kr': { enabled: true, role: 'teacher' }
  }, { failCollectionRead: { teacher_allowlist: 3 } });
  await assert.rejects(migration.runTeacherAccessMigration({
    db, auth: fakeAuth([googleUser('uid-a', 'a@school.kr')]),
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: true, confirmProject: 'demo-video-quiz', serverTimestamp: () => timestamp(1000)
  }), error => {
    assert.equal(error.partialReport.safeToDeployStrictRules, false);
    assert.equal(error.partialReport.lock.status, 'complete');
    assert.match(error.message, /authoritative collection read failed/);
    return true;
  });
});

test('CLI validates target and output before Admin initialization and keeps published success on stdout failure', async () => {
  assert.throws(() => cli.parseArgs([
    '--project', 'demo-video-quiz', '--apply', '--admin-uid', 'admin-a'
  ]), /confirm-project/i);
  assert.throws(() => cli.parseArgs([
    '--project', 'demo-video-quiz', '--apply', '--confirm-project', 'demo-video-quiz',
    '--admin-uid', 'admin-a'
  ]), /lock-token/i);
  assert.deepEqual(cli.parseArgs([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
    '--unlock', '--confirm-project', 'demo-video-quiz', '--lock-token', 'token-a',
    '--expected-generation', '4:0'
  ]), {
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a',
    apply: false, confirmProject: 'demo-video-quiz', output: '', lockToken: 'token-a',
    expectedGeneration: '4:0', expectedMigrationGeneration: '',
    unlock: true, verifyLock: false, windowId: '', controlId: ''
  });
  assert.throws(() => cli.validateTarget({ projectId: 'video-quiz-65798', targetMode: 'production' }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
  }), /stale/i);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-access-migration-'));
  const output = path.join(directory, 'report.json');
  let initialized = 0;
  try {
    fs.writeFileSync(output, '{"foreign":true}\n', { flag: 'wx' });
    await assert.rejects(cli.main([
      '--project', 'demo-video-quiz', '--admin-uid', 'admin-a',
      ...PRODUCTION_EVIDENCE_IDENTITY, '--output', output
    ], {
      environment: {}, reserveReport: cli.reserveReport,
      initialize() { initialized += 1; throw new Error('must not initialize'); },
      runTeacherAccessMigration() { throw new Error('must not run'); }, writeLine() {}
    }), /exist|EEXIST/i);
    assert.equal(initialized, 0);

    const successPath = path.join(directory, 'success.json');
    await assert.rejects(cli.main([
      '--project', 'demo-video-quiz', '--admin-uid', 'admin-a',
      ...PRODUCTION_EVIDENCE_IDENTITY, '--output', successPath
    ], {
      environment: {}, reserveReport: cli.reserveReport,
      initialize() { initialized += 1; return { db: {}, auth: {}, serverTimestamp() {}, close() {} }; },
      async runTeacherAccessMigration() {
        return { status: 'complete', mode: 'dry-run', safeToDeployStrictRules: false };
      },
      writeLine() { throw new Error('stdout failed after publication'); }
    }), /stdout failed/);
    assert.equal(JSON.parse(fs.readFileSync(successPath, 'utf8')).status, 'complete');
    assert.equal(fs.existsSync(successPath + '.reserved'), false);
    assert.equal(fs.existsSync(successPath + '.pending'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI verifies and unlocks only the exact reported lock generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-access-lock-'));
  let initializeCount = 0;
  let unlocked;
  try {
    const output = path.join(directory, 'unlock.json');
    const report = await cli.main([
      '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
      '--unlock', '--confirm-project', 'demo-video-quiz', '--lock-token', 'token-a',
      '--expected-generation', '4:0', '--output', output
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      reserveReport: cli.reserveReport,
      async initialize() {
        initializeCount += 1;
        return { db: {}, serverTimestamp() {}, close() {} };
      },
      async unlockTeacherAccessGate(options) {
        unlocked = options;
        return { locked: false, lockToken: 'token-a', updateTimeGeneration: '5:0' };
      },
      writeLine() {}
    });
    assert.equal(initializeCount, 1);
    assert.equal(unlocked.lockToken, 'token-a');
    assert.equal(unlocked.expectedGeneration, '4:0');
    assert.equal(report.operation, 'teacher-access-status-unlock');
    assert.equal(report.status, 'complete');
    assert.equal(report.gate.locked, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('access verify-lock reports lock-only or malformed completion evidence as unsafe', async () => {
  assert.throws(() => cli.parseArgs([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
    '--verify-lock', '--lock-token', 'token-a', '--expected-generation', '5:0'
  ]), /expected-migration-generation/i);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-access-verify-'));
  try {
    const output = path.join(directory, 'unsafe.json');
    const report = await cli.main([
      '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
      '--verify-lock', '--lock-token', 'token-a', '--expected-generation', '5:0',
      '--expected-migration-generation', '4:0', '--output', output
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      reserveReport: cli.reserveReport,
      async initialize() { return { db: {}, close() {} }; },
      async verifyTeacherAccessGate() {
        return {
          path: 'migration_gates/teacher_access_status', locked: true,
          lockToken: 'token-a', projectId: 'demo-video-quiz', targetMode: 'emulator',
          updateTimeGeneration: '5:0', status: 'running', strictReady: false,
          migrationGeneration: '4:0'
        };
      },
      async verifyTeacherAccessReleaseState() {
        return {
          status: 'complete', safeToDeployStrictRules: false,
          verificationReason: 'teacher access completion state is invalid',
          gate: {
            path: 'migration_gates/teacher_access_status', locked: true,
            lockToken: 'token-a', projectId: 'demo-video-quiz', targetMode: 'emulator',
            updateTimeGeneration: '5:0', status: 'running', strictReady: false,
            migrationGeneration: '4:0'
          }
        };
      },
      writeLine() {}
    });
    assert.equal(report.status, 'complete');
    assert.equal(report.safeToDeployStrictRules, false);
    assert.match(report.verificationReason, /completion|strict/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('access release verification requires exact complete state and both reported generations', () => {
  const completedAt = firestoreTimestamp(1000);
  const options = {
    projectId: 'demo-video-quiz', targetMode: 'emulator', adminUid: 'admin-a', lockToken: 'token-a',
    expectedGeneration: '5:0', expectedMigrationGeneration: '4:0'
  };
  const exact = {
    locked: true, lockToken: 'token-a', projectId: 'demo-video-quiz', targetMode: 'emulator',
    updateTimeGeneration: '5:0', status: 'complete', strictReady: true,
    migrationGeneration: '4:0', completedAt, completedByUid: 'admin-a'
  };
  assert.equal(cli.evaluateAccessReleaseVerification(exact, options).safeToDeployStrictRules, true);
  for (const patch of [
    { status: 'running' }, { strictReady: false }, { migrationGeneration: '3:0' },
    { migrationGeneration: 'invalid' }, { updateTimeGeneration: '5:1' },
    { projectId: 'other-project' }, { targetMode: 'production' },
    { completedAt: undefined }, { completedAt: timestamp(1000) },
    { completedByUid: '' }, { completedByUid: 'other-admin' }
  ]) {
    assert.equal(cli.evaluateAccessReleaseVerification({ ...exact, ...patch }, options)
      .safeToDeployStrictRules, false);
  }
});

test('public access verify CLI performs authoritative DB and Auth reads before reporting safe', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-access-authoritative-'));
  const db = fakeDb(completedAccessState());
  const auth = fakeAuth([googleUser('uid-a', 'a@school.kr')]);
  try {
    const output = path.join(directory, 'verify.json');
    const report = await cli.main([
      '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
      '--verify-lock', '--lock-token', 'token-a', '--expected-generation', '1:0',
      '--expected-migration-generation', '1:0', '--output', output
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      reserveReport: cli.reserveReport,
      async initialize() { return { db, auth, close() {} }; },
      verifyTeacherAccessGate: migration.verifyTeacherAccessGate,
      verifyTeacherAccessReleaseState: migration.verifyTeacherAccessReleaseState,
      writeLine() {}
    });
    assert.equal(report.safeToDeployStrictRules, true);
    assert.equal(report.audit.safe, true);
    assert.equal(db.collectionReadCount('teacher_allowlist') > 0, true);
    assert.equal(db.collectionReadCount('teacher_allowances') > 0, true);
    assert.equal(auth.readCount > 0, true);
    assert.equal(db.documentReadCount('migration_gates/teacher_access_status'), 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public access verify CLI reports missing completion fields and post-scan gate races unsafe', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-access-release-race-'));
  try {
    for (const [name, patch] of [
      ['missing-completed-at', { completedAt: undefined }],
      ['missing-completed-by', { completedByUid: '' }]
    ]) {
      const output = path.join(directory, name + '.json');
      const db = fakeDb(completedAccessState(patch));
      const auth = fakeAuth([googleUser('uid-a', 'a@school.kr')]);
      const report = await cli.main([
        '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
        '--verify-lock', '--lock-token', 'token-a', '--expected-generation', '1:0',
        '--expected-migration-generation', '1:0', '--output', output
      ], {
        environment: {
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
          FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
        },
        reserveReport: cli.reserveReport,
        async initialize() { return { db, auth, close() {} }; },
        verifyTeacherAccessGate: migration.verifyTeacherAccessGate,
        verifyTeacherAccessReleaseState: migration.verifyTeacherAccessReleaseState,
        writeLine() {}
      });
      assert.equal(report.safeToDeployStrictRules, false, name);
      assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).safeToDeployStrictRules, false);
    }

    const racedDb = fakeDb(completedAccessState(), {
      beforeDocumentRead({ documentPath, call, docs, versions }) {
        if (documentPath === 'migration_gates/teacher_access_status' && call === 2) {
          docs.set(documentPath, { ...docs.get(documentPath), strictReady: false });
          versions.set(documentPath, 2);
        }
      }
    });
    const raceOutput = path.join(directory, 'gate-race.json');
    const raced = await cli.main([
      '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
      '--verify-lock', '--lock-token', 'token-a', '--expected-generation', '1:0',
      '--expected-migration-generation', '1:0', '--output', raceOutput
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      reserveReport: cli.reserveReport,
      async initialize() {
        return { db: racedDb, auth: fakeAuth([googleUser('uid-a', 'a@school.kr')]), close() {} };
      },
      verifyTeacherAccessGate: migration.verifyTeacherAccessGate,
      verifyTeacherAccessReleaseState: migration.verifyTeacherAccessReleaseState,
      writeLine() {}
    });
    assert.equal(raced.safeToDeployStrictRules, false);
    assert.match(raced.verificationReason, /generation|gate|changed/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public access verify CLI publishes partial unsafe evidence when authoritative Auth scan fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-access-auth-failure-'));
  try {
    const output = path.join(directory, 'verify.json');
    const report = await cli.main([
      '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--admin-uid', 'admin-a',
      '--verify-lock', '--lock-token', 'token-a', '--expected-generation', '1:0',
      '--expected-migration-generation', '1:0', '--output', output
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      reserveReport: cli.reserveReport,
      async initialize() {
        return {
          db: fakeDb(completedAccessState()),
          auth: fakeAuth([googleUser('uid-a', 'a@school.kr')], { failAt: 1 }),
          close() {}
        };
      },
      verifyTeacherAccessGate: migration.verifyTeacherAccessGate,
      verifyTeacherAccessReleaseState: migration.verifyTeacherAccessReleaseState,
      writeLine() {}
    });
    assert.equal(report.status, 'partial-failure');
    assert.equal(report.safeToDeployStrictRules, false);
    assert.match(report.auditError, /auth enumeration failed/i);
    const durable = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(durable.status, 'partial-failure');
    assert.equal(durable.safeToDeployStrictRules, false);
    assert.match(durable.auditError, /auth enumeration failed/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
