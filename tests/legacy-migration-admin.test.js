const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adminMigration = require('../legacy-migration-admin.js');

const clone = value => value === undefined ? undefined : structuredClone(value);

function makeAdminFake(initial, options) {
  const values = new Map(Object.entries(initial || {}).map(([path, value]) => [path, clone(value)]));
  const writes = [];
  let transactionCount = 0;
  let collectionGroupReadCount = 0;

  const snapshot = path => ({
    id: path.split('/').at(-1),
    exists: values.has(path),
    ref: reference(path),
    data: () => clone(values.get(path))
  });
  const reference = path => ({
    path,
    get: async () => {
      if (options && options.failDocPath === path) throw new Error('document read unavailable: ' + path);
      return snapshot(path);
    }
  });
  const querySnapshot = paths => ({ docs: paths.sort().map(snapshot), size: paths.length });
  const immediateChildren = collectionPath => {
    const prefix = collectionPath + '/';
    const depth = collectionPath.split('/').length + 1;
    return [...values.keys()].filter(path => path.startsWith(prefix) && path.split('/').length === depth);
  };

  const db = {
    doc(path) { return reference(path); },
    collection(path) {
      return { get: async () => querySnapshot(immediateChildren(path)) };
    },
    collectionGroup(name) {
      return {
        get: async () => {
          collectionGroupReadCount += 1;
          if (options && options.onCollectionGroupRead) {
            options.onCollectionGroupRead(collectionGroupReadCount, {
              set(path, value) { values.set(path, clone(value)); },
              delete(path) { values.delete(path); }
            });
          }
          if (options && options.failCollectionGroup === name) {
            throw new Error('enumeration unavailable: ' + name);
          }
          return querySnapshot([...values.keys()].filter(path => {
            const parts = path.split('/');
            return parts.length >= 2 && parts.at(-2) === name;
          }));
        }
      };
    },
    async runTransaction(callback) {
      transactionCount += 1;
      if (options && options.beforeTransactionAt === transactionCount) {
        options.beforeTransaction({
          set(path, value) { values.set(path, clone(value)); },
          delete(path) { values.delete(path); }
        });
      }
      const pending = [];
      const transaction = {
        get: async ref => snapshot(ref.path),
        set(ref, value, setOptions) { pending.push(['set', ref.path, clone(value), setOptions]); },
        create(ref, value) { pending.push(['create', ref.path, clone(value)]); },
        delete(ref) { pending.push(['delete', ref.path]); }
      };
      const result = await callback(transaction);
      const next = new Map([...values].map(([path, value]) => [path, clone(value)]));
      for (const [operation, path, value, setOptions] of pending) {
        if (operation === 'create' && next.has(path)) throw new Error('already-exists');
        if (operation === 'delete') next.delete(path);
        else next.set(path, setOptions && setOptions.merge
          ? { ...(next.get(path) || {}), ...value }
          : value);
      }
      values.clear();
      next.forEach((value, path) => values.set(path, value));
      pending.forEach(([operation, path]) => writes.push({ operation, path }));
      if (options && options.ambiguousTransactionAt === transactionCount) {
        const error = new Error('commit result unknown');
        error.code = options.ambiguousCode === undefined
          ? 'deadline-exceeded'
          : options.ambiguousCode;
        throw error;
      }
      return result;
    }
  };

  const users = options && options.users || {
    'teacher-uid': {
      uid: 'teacher-uid', email: 'owner@school.kr', emailVerified: true,
      providerData: [{ providerId: 'google.com', email: 'owner@school.kr' }]
    }
  };
  const auth = { async getUser(uid) {
    if (!users[uid]) throw new Error('user-not-found');
    return clone(users[uid]);
  } };

  return {
    db,
    auth,
    writes,
    value(path) { return clone(values.get(path)); }
  };
}

function baseIdentity(extra) {
  return {
    'config/legacy_owner': { uid: 'teacher-uid', email: 'owner@school.kr' },
    'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' },
    ...(extra || {})
  };
}

test('canonical UID anchors verified Google Auth, allowlist, and exact config email identity', async () => {
  const cases = [
    {
      name: 'config case mismatch',
      initial: baseIdentity({ 'config/legacy_owner': { uid: 'teacher-uid', email: 'Owner@school.kr' } })
    },
    {
      name: 'config whitespace mismatch',
      initial: baseIdentity({ 'config/legacy_owner': { uid: 'teacher-uid', email: ' owner@school.kr ' } })
    },
    {
      name: 'CLI UID mismatch',
      initial: baseIdentity(),
      ownerUid: 'different-uid'
    },
    {
      name: 'unverified Auth user',
      initial: baseIdentity(),
      users: {
        'teacher-uid': {
          uid: 'teacher-uid', email: 'owner@school.kr', emailVerified: false,
          providerData: [{ providerId: 'google.com', email: 'owner@school.kr' }]
        }
      }
    },
    {
      name: 'disabled allowlist',
      initial: baseIdentity({
        'teacher_allowlist/owner@school.kr': { enabled: false, role: 'teacher' }
      })
    }
  ];

  for (const value of cases) {
    const fake = makeAdminFake(value.initial, { users: value.users });
    await assert.rejects(
      adminMigration.runLegacyMigration({
        db: fake.db,
        auth: fake.auth,
        projectId: 'demo-video-quiz',
        ownerUid: value.ownerUid || 'teacher-uid'
      }),
      /legacy owner|canonical|verified|allowlist/i,
      value.name
    );
  }
});

test('owner provisioning creates only when absent, accepts an exact match, and never overwrites mismatch', async () => {
  const withoutConfig = {
    'teacher_allowlist/owner@school.kr': { enabled: true, role: 'teacher' }
  };
  const fake = makeAdminFake(withoutConfig);
  const created = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz', provisionOwnerEmail: 'owner@school.kr'
  });
  assert.deepEqual(fake.value('config/legacy_owner'), {
    uid: 'teacher-uid', email: 'owner@school.kr'
  });
  assert.equal(created.ownerConfigAction, 'created');

  const matched = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz', provisionOwnerEmail: 'owner@school.kr'
  });
  assert.equal(matched.ownerConfigAction, 'matched');

  const mismatch = makeAdminFake({
    ...withoutConfig,
    'config/legacy_owner': { uid: 'different-uid', email: 'different@school.kr' }
  });
  await assert.rejects(adminMigration.runLegacyMigration({
    db: mismatch.db, auth: mismatch.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz', provisionOwnerEmail: 'owner@school.kr'
  }), /already exists|mismatch/i);
  assert.deepEqual(mismatch.value('config/legacy_owner'), {
    uid: 'different-uid', email: 'different@school.kr'
  });
});

test('owner removal requires a clean authoritative audit and exact current identity', async () => {
  const clean = makeAdminFake(baseIdentity());
  const removed = await adminMigration.removeLegacyOwner({
    db: clean.db, auth: clean.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz', targetMode: 'emulator'
  });
  assert.equal(clean.value('config/legacy_owner'), undefined);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.targetMode, 'emulator');
  assert.equal(removed.migrationAudit.safeToDeployStrictRules, true);
  assert.equal(removed.postRemovalAudit.safeToDeployStrictRules, true);
  assert.equal(removed.ownerConfigAbsent, true);
  assert.match(removed.auditDigest, /^[a-f0-9]{64}$/);

  const incomplete = makeAdminFake(baseIdentity({
    'sessions/session-a': { teacherUid: 'teacher-uid', teacherEmail: 'owner@school.kr' },
    'sessions/session-a/responses/student-1': {
      uid: 'student-1', answers: { 0: { answer: 1, ok: true } }
    }
  }));
  const blocked = await adminMigration.removeLegacyOwner({
    db: incomplete.db, auth: incomplete.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(blocked.action, 'blocked');
  assert.notEqual(incomplete.value('config/legacy_owner'), undefined);
  assert.equal(blocked.migrationAudit.safeToDeployStrictRules, false);

  const mismatched = makeAdminFake(baseIdentity());
  await assert.rejects(adminMigration.removeLegacyOwner({
    db: mismatched.db, auth: mismatched.auth, projectId: 'demo-video-quiz', ownerUid: 'other-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  }), /canonical owner UID|legacy owner/i);
  assert.notEqual(mismatched.value('config/legacy_owner'), undefined);
});

test('owner removal post-audit catches a leak inserted after the pre-audit and gives recovery instructions', async () => {
  const raced = makeAdminFake(baseIdentity(), {
    beforeTransactionAt: 1,
    beforeTransaction(store) {
      store.set('sessions/raced/responses/student-1', {
        uid: 'student-1', answers: { 0: { answer: 1, revision: 1, ok: true } }
      });
    }
  });

  const report = await adminMigration.removeLegacyOwner({
    db: raced.db, auth: raced.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz', targetMode: 'emulator'
  });

  assert.equal(raced.value('config/legacy_owner'), undefined);
  assert.equal(report.preRemovalAudit.safeToDeployStrictRules, true);
  assert.equal(report.postRemovalAudit.safeToDeployStrictRules, false);
  assert.equal(report.migrationAudit, report.postRemovalAudit);
  assert.equal(report.safeToRemoveOwner, false);
  assert.equal(report.action, 'removed-post-audit-failed');
  assert.match(report.recoveryInstructions, /re-provision|--provision-owner-email/i);
  assert.equal(report.postRemovalAudit.remainingResponseLeakCount, 1);
});

test('owner removal confirms config absence after the complete post-delete audit', async () => {
  const raced = makeAdminFake(baseIdentity(), {
    onCollectionGroupRead(count, store) {
      if (count === 19) {
        store.set('config/legacy_owner', { uid: 'teacher-uid', email: 'owner@school.kr' });
      }
    }
  });

  const report = await adminMigration.removeLegacyOwner({
    db: raced.db, auth: raced.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz', targetMode: 'emulator'
  });

  assert.equal(report.postRemovalAudit.safeToDeployStrictRules, true);
  assert.equal(report.ownerConfigAbsent, false);
  assert.equal(report.safeToRemoveOwner, false);
  assert.equal(report.action, 'removed-post-audit-failed');
});

test('CLI parsing defaults to dry-run and apply requires exact project confirmation', () => {
  assert.deepEqual(
    adminMigration.parseCliArgs(['--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid']),
    {
      projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
      apply: false, confirmProject: '', provisionOwnerEmail: '',
      removeOwner: false, emulator: false, output: ''
    }
  );
  assert.throws(
    () => adminMigration.parseCliArgs([
      '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--apply'
    ]),
    /confirm-project/i
  );
  assert.throws(
    () => adminMigration.parseCliArgs([
      '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--apply',
      '--confirm-project', 'production-video-quiz'
    ]),
    /does not match/i
  );
});

test('operator command initializes only the confirmed project, defaults to dry-run, and writes a credential-free report', async () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const calls = [];
  let written = null;
  const report = {
    projectId: 'demo-video-quiz', mode: 'dry-run', safeToDeployStrictRules: false,
    auditDigest: 'a'.repeat(64), categories: {}, auditFailures: [],
    remainingResponseLeakCount: 1
  };
  const exitCode = await command.main(
    ['--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--output', 'audit.json'],
    {
      initialize(projectId) {
        calls.push(['initialize', projectId]);
        return { db: { projectId }, auth: { projectId } };
      },
      runLegacyMigration(options) {
        calls.push(['run', options.projectId, options.ownerUid, options.apply]);
        return Promise.resolve(report);
      },
      reserveReport(path) {
        calls.push(['reserve', path]);
        return { commit(contents) { written = { path, contents }; } };
      },
      writeLine(line) { calls.push(['stdout', line]); }
    }
  );

  assert.equal(exitCode, 2);
  assert.deepEqual(calls.slice(0, 3), [
    ['reserve', 'audit.json'],
    ['initialize', 'demo-video-quiz'],
    ['run', 'demo-video-quiz', 'teacher-uid', false]
  ]);
  assert.equal(written.path, 'audit.json');
  assert.deepEqual(JSON.parse(written.contents), report);
  assert.equal(calls.flat().some(value => /credential|private.?key/i.test(String(value))), false);
});

test('CLI rejects emulator environment leakage before Admin initialization unless explicit safe emulator mode is valid', async () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  for (const environment of [
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }
  ]) {
    let initialized = 0;
    await assert.rejects(command.main(
      ['--project', 'production-video-quiz', '--owner-uid', 'teacher-uid'],
      {
        environment,
        initialize() { initialized += 1; throw new Error('must not initialize'); }
      }
    ), /--emulator|emulator environment/i);
    assert.equal(initialized, 0);
  }

  for (const argv of [
    ['--project', 'production-video-quiz', '--owner-uid', 'teacher-uid', '--emulator'],
    ['--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--emulator']
  ]) {
    let initialized = 0;
    await assert.rejects(command.main(argv, {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: argv[1].startsWith('demo-') ? '' : '127.0.0.1:9099'
      },
      initialize() { initialized += 1; throw new Error('must not initialize'); }
    }), /demo-|emulator host|expected local/i);
    assert.equal(initialized, 0);
  }

  await assert.rejects(command.main([
    '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--emulator'
  ], {
    environment: {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
    },
    initialize() { throw new Error('must not initialize'); }
  }), /expected local|:8080/i);

  const calls = [];
  const exitCode = await command.main([
    '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--emulator', '--output', 'audit.json'
  ], {
    environment: {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099'
    },
    initialize(projectId) { calls.push(['initialize', projectId]); return { db: {}, auth: {} }; },
    runLegacyMigration(options) {
      calls.push(['target', options.targetMode]);
      return Promise.resolve({
        projectId: options.projectId, mode: 'dry-run', targetMode: options.targetMode,
        safeToDeployStrictRules: true, remainingResponseLeakCount: 0,
        auditFailures: [], auditDigest: 'b'.repeat(64), categories: {}
      });
    },
    reserveReport() { return { commit() {} }; },
    writeLine() {}
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [['initialize', 'demo-video-quiz'], ['target', 'emulator']]);
});

test('CLI reserves a fail-closed report before Admin initialization and reports later failures', async () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  let initialized = 0;
  await assert.rejects(command.main([
    '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--apply',
    '--confirm-project', 'demo-video-quiz', '--output', 'existing.json'
  ], {
    environment: {},
    reserveReport() { throw new Error('report already exists'); },
    initialize() { initialized += 1; throw new Error('must not initialize'); }
  }), /already exists/);
  assert.equal(initialized, 0);

  const events = [];
  let finalContents = '';
  await assert.rejects(command.main([
    '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--apply',
    '--confirm-project', 'demo-video-quiz', '--output', 'failure.json'
  ], {
    environment: {},
    reserveReport(path, initialContents) {
      events.push('reserve');
      assert.equal(path, 'failure.json');
      const initial = JSON.parse(initialContents);
      assert.equal(initial.status, 'reserved-fail-closed');
      assert.equal(initial.safeToDeployStrictRules, false);
      return { commit(contents) { events.push('commit'); finalContents = contents; } };
    },
    initialize() { events.push('initialize'); return { db: {}, auth: {} }; },
    async runLegacyMigration() { events.push('run'); throw new Error('migration stopped'); },
    writeLine() {}
  }), /migration stopped/);
  assert.deepEqual(events, ['reserve', 'initialize', 'run', 'commit']);
  const failure = JSON.parse(finalContents);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.safeToDeployStrictRules, false);
  assert.equal(failure.auditDigestKind, 'checksum');
  assert.match(failure.auditDigest, /^[a-f0-9]{64}$/);
});

test('report reservation is exclusive and immediately contains a fail-closed artifact', () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-report-'));
  const reportPath = path.join(directory, 'audit.json');
  try {
    const reservation = command.reserveReport(reportPath, '{"status":"reserved-fail-closed"}\n');
    assert.equal(fs.existsSync(reportPath), false);
    assert.equal(JSON.parse(fs.readFileSync(reportPath + '.reserved', 'utf8')).status,
      'reserved-fail-closed');
    assert.throws(() => command.reserveReport(reportPath, '{}\n'), /exist|EEXIST/i);
    reservation.commit('{"status":"failed","safeToDeployStrictRules":false}\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), {
      status: 'failed', safeToDeployStrictRules: false
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function faultingReportFileSystem(method, persistent) {
  const pathsByDescriptor = new Map();
  let failuresRemaining = persistent ? Number.POSITIVE_INFINITY : 1;
  const shouldFail = () => failuresRemaining > 0 && (failuresRemaining--, true);
  const injectedError = operation => {
    const error = new Error('injected ' + operation + ' failure');
    error.code = 'EIO';
    return error;
  };
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (...args) => {
        const descriptor = target.openSync(...args);
        pathsByDescriptor.set(descriptor, String(args[0]));
        return descriptor;
      };
      if (property === 'closeSync') return descriptor => {
        const descriptorPath = String(pathsByDescriptor.get(descriptor) || '');
        const failReservedClose = method === 'reserved-close' && descriptorPath.endsWith('.reserved');
        const failDirectoryClose = method === 'directory-close' &&
          descriptorPath && !descriptorPath.endsWith('.reserved') &&
          !descriptorPath.endsWith('.pending');
        if ((failReservedClose || failDirectoryClose) && shouldFail()) {
          pathsByDescriptor.delete(descriptor);
          target.closeSync(descriptor);
          throw injectedError(method);
        }
        pathsByDescriptor.delete(descriptor);
        return target.closeSync(descriptor);
      };
      if (property === 'ftruncateSync' && method === 'truncate') {
        return () => { throw new Error('injected truncate failure'); };
      }
      if (property === 'writeSync' && method === 'write') return (descriptor, ...args) => {
        if (String(pathsByDescriptor.get(descriptor) || '').endsWith('.pending') && shouldFail()) {
          throw new Error('injected write failure');
        }
        return target.writeSync(descriptor, ...args);
      };
      if (property === 'fsyncSync' && method === 'fsync') return descriptor => {
        if (String(pathsByDescriptor.get(descriptor) || '').endsWith('.pending') && shouldFail()) {
          throw new Error('injected fsync failure');
        }
        return target.fsyncSync(descriptor);
      };
      if (property === 'fsyncSync' && method === 'directory-fsync') return descriptor => {
        const descriptorPath = String(pathsByDescriptor.get(descriptor) || '');
        if (descriptorPath && !descriptorPath.endsWith('.reserved') &&
            !descriptorPath.endsWith('.pending') && shouldFail()) {
          throw injectedError(method);
        }
        return target.fsyncSync(descriptor);
      };
      if (property === 'linkSync' && method === 'link') return (...args) => {
        if (shouldFail()) throw new Error('injected link failure');
        return target.linkSync(...args);
      };
      if (property === 'linkSync' && method === 'unsupported-link') return () => {
        if (shouldFail()) {
          const error = new Error('injected unsupported link failure');
          error.code = 'ENOTSUP';
          throw error;
        }
        throw new Error('unsupported-link fault was unexpectedly exhausted');
      };
      return Reflect.get(target, property);
    }
  });
}

test('durable report reservation survives close and directory durability errors with a discoverable path', () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-report-reserve-faults-'));
  const reserved = '{"status":"reserved-fail-closed","safeToDeployStrictRules":false}\n';
  try {
    for (const method of ['reserved-close', 'directory-fsync', 'directory-close']) {
      const reportPath = path.join(directory, method + '.json');
      const reservedPath = reportPath + '.reserved';
      let thrown;
      assert.throws(() => command.reserveReport(
        reportPath, reserved, faultingReportFileSystem(method)
      ), error => {
        thrown = error;
        return error.message.includes('injected ' + method + ' failure');
      });
      assert.equal(thrown.message.includes(reservedPath), true, method);
      assert.deepEqual(JSON.parse(fs.readFileSync(reservedPath, 'utf8')), {
        status: 'reserved-fail-closed', safeToDeployStrictRules: false
      }, method);
      assert.equal(fs.existsSync(reportPath), false, method);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic report publication preserves fail-closed JSON across truncate, write, fsync, and link faults', () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-report-faults-'));
  const reserved = '{"status":"reserved-fail-closed","safeToDeployStrictRules":false}\n';
  const safe = '{"status":"complete","safeToDeployStrictRules":true}\n';
  const failed = '{"status":"failed","safeToDeployStrictRules":false}\n';
  try {
    const truncatePath = path.join(directory, 'truncate.json');
    const truncateReservation = command.reserveReport(
      truncatePath, reserved, faultingReportFileSystem('truncate')
    );
    truncateReservation.commit(safe);
    assert.equal(JSON.parse(fs.readFileSync(truncatePath, 'utf8')).safeToDeployStrictRules, true);

    for (const method of ['write', 'fsync', 'link']) {
      const reportPath = path.join(directory, method + '.json');
      const reservation = command.reserveReport(
        reportPath, reserved, faultingReportFileSystem(method)
      );
      assert.throws(() => reservation.commit(safe), new RegExp('injected ' + method));
      assert.equal(fs.existsSync(reportPath), false, method);
      assert.equal(
        JSON.parse(fs.readFileSync(reportPath + '.reserved', 'utf8')).safeToDeployStrictRules,
        false,
        method
      );
      reservation.commit(failed);
      assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).safeToDeployStrictRules, false);
      assert.equal(fs.existsSync(reportPath + '.reserved'), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('report publication never replaces a target created immediately before atomic publish', () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-report-race-'));
  const reportPath = path.join(directory, 'audit.json');
  const reserved = '{"status":"reserved-fail-closed","safeToDeployStrictRules":false}\n';
  const safe = '{"status":"complete","safeToDeployStrictRules":true}\n';
  const foreign = '{"status":"foreign","safeToDeployStrictRules":false}\n';
  let barrierReached = false;
  const racingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync' || property === 'linkSync') return (...args) => {
        if (!barrierReached) {
          target.writeFileSync(reportPath, foreign, { flag: 'wx' });
          barrierReached = true;
        }
        return target[property](...args);
      };
      return Reflect.get(target, property);
    }
  });
  try {
    const reservation = command.reserveReport(reportPath, reserved, racingFileSystem);
    assert.throws(() => reservation.commit(safe), /EEXIST|exist/i);
    assert.equal(barrierReached, true);
    assert.equal(fs.readFileSync(reportPath, 'utf8'), foreign);
    assert.equal(fs.readFileSync(reportPath + '.reserved', 'utf8'), reserved);
    assert.notEqual(fs.readFileSync(reportPath, 'utf8'), safe);
    assert.equal(fs.existsSync(reportPath + '.pending'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported hard links fail closed without falling back to overwrite publication', () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-report-link-unsupported-'));
  const reportPath = path.join(directory, 'audit.json');
  const reserved = '{"status":"reserved-fail-closed","safeToDeployStrictRules":false}\n';
  const safe = '{"status":"complete","safeToDeployStrictRules":true}\n';
  try {
    const reservation = command.reserveReport(
      reportPath, reserved, faultingReportFileSystem('unsupported-link', true)
    );
    assert.throws(() => reservation.commit(safe), error => error.code === 'ENOTSUP');
    assert.equal(fs.existsSync(reportPath), false);
    assert.equal(fs.readFileSync(reportPath + '.reserved', 'utf8'), reserved);
    assert.equal(fs.existsSync(reportPath + '.pending'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI catch path leaves a discoverable fail-closed companion when hard-link publication keeps failing', async () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-report-catch-'));
  const reportPath = path.join(directory, 'audit.json');
  const fileSystem = faultingReportFileSystem('link', true);
  try {
    await assert.rejects(command.main([
      '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--output', reportPath
    ], {
      environment: {},
      reserveReport(filePath, contents) {
        return command.reserveReport(filePath, contents, fileSystem);
      },
      initialize() { return { db: {}, auth: {} }; },
      runLegacyMigration() {
        return Promise.resolve({
          projectId: 'demo-video-quiz', mode: 'dry-run', targetMode: 'production',
          safeToDeployStrictRules: true, remainingResponseLeakCount: 0,
          auditFailures: [], auditDigest: 'd'.repeat(64)
        });
      },
      writeLine() {}
    }), /injected link failure/);
    assert.equal(fs.existsSync(reportPath), false);
    assert.equal(
      JSON.parse(fs.readFileSync(reportPath + '.reserved', 'utf8')).safeToDeployStrictRules,
      false
    );
    assert.throws(() => command.reserveReport(reportPath, '{}\n'), /exist|EEXIST/i);
    const newPath = path.join(directory, 'retry-new-path.json');
    const retry = command.reserveReport(newPath, '{"safeToDeployStrictRules":false}\n');
    retry.commit('{"safeToDeployStrictRules":false}\n');
    assert.equal(JSON.parse(fs.readFileSync(newPath, 'utf8')).safeToDeployStrictRules, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI selects the isolated owner-removal workflow and never combines it with provisioning', async () => {
  const command = require('../scripts/migrate-legacy-ownership.js');
  assert.throws(() => adminMigration.parseCliArgs([
    '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--apply',
    '--confirm-project', 'demo-video-quiz', '--remove-owner',
    '--provision-owner-email', 'owner@school.kr'
  ]), /cannot be combined/i);

  const calls = [];
  const exitCode = await command.main([
    '--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid', '--apply',
    '--confirm-project', 'demo-video-quiz', '--remove-owner', '--output', 'remove.json'
  ], {
    environment: {},
    reserveReport() { return { commit() {} }; },
    initialize() { return { db: {}, auth: {} }; },
    runLegacyMigration() { throw new Error('wrong workflow'); },
    removeLegacyOwner(options) {
      calls.push(options);
      return Promise.resolve({
        projectId: options.projectId, mode: 'apply', targetMode: options.targetMode,
        action: 'removed', safeToRemoveOwner: true, auditDigest: 'c'.repeat(64)
      });
    },
    writeLine() {}
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apply, true);
});

test('Admin apply authoritatively enumerates, migrates atomically, audits exact coverage, and digests report', async () => {
  const fake = makeAdminFake(baseIdentity({
    'quiz_sets/legacy-set': { title: 'Legacy' },
    'images/legacy-set/q/v0q0': { data: 'image' },
    'sessions/legacy-session': {
      setId: 'legacy-set', status: 'ended',
      setSnapshot: { title: 'Historic', questions: [{ text: 'Q' }] },
      snapshotImages: { v0q0: 'image' }
    },
    'sessions/legacy-session/students/student-1': { uid: 'student-1', name: 'Student' },
    'sessions/legacy-session/responses/student-1': {
      uid: 'student-1',
      answers: { 0: { answer: 1, submitted: true, revision: 3, ok: true, score: 1 } }
    }
  }));

  const dryRun = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid'
  });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(fake.writes.length, 0);
  assert.equal(dryRun.safeToDeployStrictRules, false);

  const report = await adminMigration.runLegacyMigration({
    db: fake.db,
    auth: fake.auth,
    projectId: 'demo-video-quiz',
    ownerUid: 'teacher-uid',
    apply: true,
    confirmProject: 'demo-video-quiz',
    now: () => '2026-08-19T00:00:00.000Z'
  });

  assert.equal(fake.value('quiz_sets/legacy-set').ownerUid, 'teacher-uid');
  assert.equal(fake.value('sessions/legacy-session').teacherEmail, 'owner@school.kr');
  assert.deepEqual(fake.value('sessions/legacy-session/responses/student-1'), {
    uid: 'student-1', answers: { 0: { answer: 1, submitted: true, revision: 3 } }
  });
  assert.deepEqual(fake.value('sessions/legacy-session/grades/student-1__0'), {
    uid: 'student-1', questionIndex: 0, revision: 3, ok: true
  });
  assert.equal(fake.value('sessions/legacy-session/snapshot/set').title, 'Historic');
  assert.deepEqual(fake.value('sessions/legacy-session/snapshot_images/v0q0'), { data: 'image' });
  assert.equal(fake.value('sessions/legacy-session').snapshotVersion, 1);
  assert.deepEqual(Object.keys(report.categories).sort(), [
    'grades', 'images', 'responses', 'sessions', 'sets', 'snapshots', 'students'
  ]);
  for (const category of Object.values(report.categories)) {
    for (const status of ['success', 'skipped', 'failed']) {
      assert.equal(category[status].count, category[status].ids.length);
    }
  }
  assert.equal(report.categories.grades.success.ids.includes('legacy-session/student-1__0'), true);
  assert.equal(report.remainingResponseLeakCount, 0);
  assert.deepEqual(report.auditFailures, []);
  assert.deepEqual(report.ambiguousCommitRereads, []);
  assert.equal(report.safeToDeployStrictRules, true);
  assert.match(report.auditDigest, /^[a-f0-9]{64}$/);
});

test('ambiguous commits and incomplete snapshot metadata fail the deployment gate until a clean retry', async () => {
  const fake = makeAdminFake(baseIdentity({
    'quiz_sets/legacy-set': { title: 'Legacy' },
    'sessions/broken-snapshot': {
      teacherUid: 'teacher-uid', teacherEmail: 'owner@school.kr', snapshotVersion: 1
    }
  }), { ambiguousTransactionAt: 1 });

  const first = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(first.safeToDeployStrictRules, false);
  assert.equal(first.ambiguousCommitRereads.length, 1);
  assert.equal(first.auditFailures.some(item => item.id === 'broken-snapshot'), true);

  const second = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(second.ambiguousCommitRereads.length, 0);
  assert.equal(second.safeToDeployStrictRules, false);
});

test('numeric and string Firestore ambiguous commit codes close the gate after a successful reread', async () => {
  const codes = [
    1, 2, 4, 8, 10, 13, 14, 15,
    '1', '2 UNKNOWN', '4 DEADLINE_EXCEEDED', '10 ABORTED',
    '13 INTERNAL', '14 UNAVAILABLE', '8 RESOURCE_EXHAUSTED', '15 DATA_LOSS',
    'cancelled', 'deadline-exceeded'
  ];
  for (const code of codes) {
    const fake = makeAdminFake(baseIdentity({
      'quiz_sets/legacy-set': { title: 'Legacy' }
    }), { ambiguousTransactionAt: 1, ambiguousCode: code });
    const report = await adminMigration.runLegacyMigration({
      db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
      apply: true, confirmProject: 'demo-video-quiz'
    });
    assert.equal(report.ambiguousCommitRereads.length, 1, String(code));
    assert.equal(report.ambiguousCommitRereads[0].confirmed, true, String(code));
    assert.equal(report.safeToDeployStrictRules, false, String(code));
  }
});

test('orphan response, grade, and snapshot documents fail exact parent coverage', async () => {
  const fake = makeAdminFake(baseIdentity({
    'sessions/orphan/responses/student-1': {
      uid: 'student-1', answers: { 0: { answer: 1, submitted: true, revision: 2 } }
    },
    'sessions/orphan/grades/student-1__0': {
      uid: 'student-1', questionIndex: 0, revision: 2, ok: true
    },
    'sessions/orphan/snapshot/set': { title: 'Orphan snapshot' }
  }));

  const report = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  });

  assert.equal(report.safeToDeployStrictRules, false);
  assert.deepEqual(report.categories.responses.failed.ids, ['orphan/student-1']);
  assert.deepEqual(report.categories.grades.failed.ids, ['orphan/student-1__0']);
  assert.deepEqual(report.categories.snapshots.failed.ids, ['orphan/set']);
  assert.equal(report.auditFailures.filter(item => /parent/i.test(item.reason)).length, 3);
});

test('unknown existing snapshotVersion is audited without being downgraded or fabricated', async () => {
  const fake = makeAdminFake(baseIdentity({
    'sessions/versioned': {
      teacherUid: 'teacher-uid', teacherEmail: 'owner@school.kr', snapshotVersion: 2
    },
    'sessions/versioned/snapshot/set': { title: 'Future snapshot schema' }
  }));

  const report = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  });

  assert.equal(fake.value('sessions/versioned').snapshotVersion, 2);
  assert.equal(report.categories.snapshots.failed.ids.includes('versioned/set'), true);
  assert.equal(report.safeToDeployStrictRules, false);
});

test('snapshotImages rejects aliases, invalid keys, empty data, and non-string data without partial writes', async () => {
  const cases = [
    ['alias collision', { 1: 'legacy', v0q1: 'canonical' }],
    ['unsafe legacy integer', { '9007199254740993': 'image' }],
    ['unsafe question integer', { v0q9007199254740993: 'image' }],
    ['unsafe video integer', { v9007199254740993q0: 'image' }],
    ['leading-zero legacy alias', { '01': 'image' }],
    ['leading-zero canonical alias', { v00q1: 'image' }],
    ['invalid key', { question1: 'image' }],
    ['empty data', { v0q1: '' }],
    ['non-string data', { v0q1: { data: 'image' } }]
  ];
  for (const [name, snapshotImages] of cases) {
    const fake = makeAdminFake(baseIdentity({
      'sessions/session-a': {
        teacherUid: 'teacher-uid', teacherEmail: 'owner@school.kr',
        setSnapshot: { title: 'Historic' }, snapshotImages
      }
    }));
    const report = await adminMigration.runLegacyMigration({
      db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
      apply: true, confirmProject: 'demo-video-quiz'
    });
    assert.equal(report.safeToDeployStrictRules, false, name);
    assert.equal(report.categories.snapshots.failed.count > 0, true, name);
    assert.equal(fake.value('sessions/session-a/snapshot/set'), undefined, name);
    assert.equal(fake.value('sessions/session-a').snapshotVersion, undefined, name);
  }

  const withoutSet = makeAdminFake(baseIdentity({
    'sessions/session-a': {
      teacherUid: 'teacher-uid', teacherEmail: 'owner@school.kr',
      snapshotImages: { v0q1: 'orphaned-embedded-image' }
    }
  }));
  const report = await adminMigration.runLegacyMigration({
    db: withoutSet.db, auth: withoutSet.auth, projectId: 'demo-video-quiz',
    ownerUid: 'teacher-uid', apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(report.safeToDeployStrictRules, false);
  assert.equal(report.categories.snapshots.failed.count > 0, true);
  assert.equal(withoutSet.value('sessions/session-a/snapshot_images/v0q1'), undefined);
});

test('authoritative enumeration failures still produce a digested fail-closed audit report', async () => {
  const fake = makeAdminFake(baseIdentity(), { failCollectionGroup: 'responses' });

  const report = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid'
  });

  assert.equal(report.safeToDeployStrictRules, false);
  assert.equal(report.auditFailures.some(item =>
    item.category === 'enumeration' && /responses/.test(item.reason)
  ), true);
  assert.match(report.auditDigest, /^[a-f0-9]{64}$/);
});

test('every malformed collection-group result path is audited instead of silently dropped', async () => {
  const unexpectedPaths = [
    'unexpected/set/q/image',
    'unexpected/session/snapshot/set',
    'unexpected/session/snapshot_images/v0q0',
    'sessions/session-a/nested/students/student-1',
    'sessions/session-a/nested/responses/student-1',
    'sessions/session-a/nested/grades/student-1__0'
  ];
  const fake = makeAdminFake(baseIdentity(Object.fromEntries(
    unexpectedPaths.map(path => [path, { value: path }])
  )));

  const report = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid'
  });

  assert.equal(report.safeToDeployStrictRules, false);
  assert.deepEqual(
    report.auditFailures
      .filter(item => item.category === 'enumeration-path')
      .map(item => item.id)
      .sort(),
    unexpectedPaths.sort()
  );
});

test('document read failures are reported instead of escaping without an audit artifact', async () => {
  const fake = makeAdminFake(baseIdentity({
    'sessions/session-a': { teacherUid: 'teacher-uid', teacherEmail: 'owner@school.kr' },
    'sessions/session-a/responses/student-1': {
      uid: 'student-1', answers: { 0: { answer: 1, revision: 2, ok: true } }
    }
  }), { failDocPath: 'sessions/session-a/grades/student-1__0' });

  const report = await adminMigration.runLegacyMigration({
    db: fake.db, auth: fake.auth, projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
    apply: true, confirmProject: 'demo-video-quiz'
  });

  assert.equal(report.safeToDeployStrictRules, false);
  assert.deepEqual(report.categories.responses.failed.ids, ['session-a/student-1']);
  assert.match(report.auditDigest, /^[a-f0-9]{64}$/);
});
