const test = require('node:test');
const assert = require('node:assert/strict');

const adminMigration = require('../legacy-migration-admin.js');

const clone = value => value === undefined ? undefined : structuredClone(value);

function makeAdminFake(initial, options) {
  const values = new Map(Object.entries(initial || {}).map(([path, value]) => [path, clone(value)]));
  const writes = [];
  let transactionCount = 0;

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
      const pending = [];
      const transaction = {
        get: async ref => snapshot(ref.path),
        set(ref, value, setOptions) { pending.push(['set', ref.path, clone(value), setOptions]); },
        create(ref, value) { pending.push(['create', ref.path, clone(value)]); }
      };
      const result = await callback(transaction);
      const next = new Map([...values].map(([path, value]) => [path, clone(value)]));
      for (const [operation, path, value, setOptions] of pending) {
        if (operation === 'create' && next.has(path)) throw new Error('already-exists');
        next.set(path, setOptions && setOptions.merge
          ? { ...(next.get(path) || {}), ...value }
          : value);
      }
      values.clear();
      next.forEach((value, path) => values.set(path, value));
      pending.forEach(([operation, path]) => writes.push({ operation, path }));
      if (options && options.ambiguousTransactionAt === transactionCount) {
        const error = new Error('commit result unknown');
        error.code = 'deadline-exceeded';
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

test('CLI parsing defaults to dry-run and apply requires exact project confirmation', () => {
  assert.deepEqual(
    adminMigration.parseCliArgs(['--project', 'demo-video-quiz', '--owner-uid', 'teacher-uid']),
    {
      projectId: 'demo-video-quiz', ownerUid: 'teacher-uid',
      apply: false, confirmProject: '', provisionOwnerEmail: '', output: ''
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
      writeFile(path, contents) { written = { path, contents }; },
      writeLine(line) { calls.push(['stdout', line]); }
    }
  );

  assert.equal(exitCode, 2);
  assert.deepEqual(calls.slice(0, 2), [
    ['initialize', 'demo-video-quiz'],
    ['run', 'demo-video-quiz', 'teacher-uid', false]
  ]);
  assert.equal(written.path, 'audit.json');
  assert.deepEqual(JSON.parse(written.contents), report);
  assert.equal(calls.flat().some(value => /credential|private.?key/i.test(String(value))), false);
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
