const test = require('node:test');
const assert = require('node:assert/strict');

let migration;
let loadError;
let cli;
let cliLoadError;
try {
  migration = require('../collaborator-share-migration.js');
} catch (error) {
  loadError = error;
}
try {
  cli = require('../scripts/migrate-collaborator-shares.js');
} catch (error) {
  cliLoadError = error;
}

const timestamp = (seconds = 1) => ({ seconds, nanoseconds: 0 });

function fakeAdminDb(initial, options = {}) {
  const docs = new Map(Object.entries(initial));
  let transactionAttempt = 0;

  function snapshot(path, source = docs) {
    const value = source.get(path);
    return {
      exists: value !== undefined,
      id: path.split('/').at(-1),
      ref: { path },
      data() { return value; }
    };
  }

  function groupQuery(name, limitValue) {
    return {
      limit(value) { return groupQuery(name, value); },
      async get() {
        if (options.beforeGroupGet) await options.beforeGroupGet({ name, docs });
        const matches = [...docs.keys()].filter(path => {
          const segments = path.split('/');
          return segments.length >= 2 && segments.at(-2) === name;
        }).sort();
        const selected = limitValue == null ? matches : matches.slice(0, limitValue);
        return { docs: selected.map(path => snapshot(path)) };
      }
    };
  }

  return {
    docs,
    collectionGroup(name) { return groupQuery(name); },
    doc(path) { return { path, get() { return Promise.resolve(snapshot(path)); } }; },
    async runTransaction(handler) {
      transactionAttempt += 1;
      if (options.beforeTransaction) {
        await options.beforeTransaction({ attempt: transactionAttempt, docs });
      }
      const staged = new Map(docs);
      const transaction = {
        get(reference) { return Promise.resolve(snapshot(reference.path, staged)); },
        set(reference, value) { staged.set(reference.path, value); },
        delete(reference) { staged.delete(reference.path); }
      };
      const result = await handler(transaction);
      docs.clear();
      staged.forEach((value, path) => docs.set(path, value));
      return result;
    },
    value(path) { return docs.get(path); },
    has(path) { return docs.has(path); }
  };
}

function validCollaborator(email = 'teacher@school.kr') {
  return { email, addedByUid: 'owner-uid', addedAt: timestamp() };
}

test('share migration dry-run plans a missing legacy index without writing it', async () => {
  assert.ifError(loadError);
  const db = fakeAdminDb({
    'quiz_sets/legacy': { ownerUid: 'owner-uid', lifecycleState: 'active' },
    'quiz_sets/legacy/collaborators/teacher@school.kr': validCollaborator()
  });

  const report = await migration.runCollaboratorShareMigration({
    db,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator'
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.operation, 'collaborator-share-backfill');
  assert.equal(report.plannedUpsertCount, 1);
  assert.equal(report.appliedUpsertCount, 0);
  assert.equal(report.audit.missingIndexCount, 1);
  assert.equal(report.safeToUseShareIndex, false);
  assert.equal(db.has('quiz_set_shares/teacher@school.kr/sets/legacy'), false);
});

test('share migration apply backfills, normalizes, deletes stale indexes, and is idempotent', async () => {
  assert.ifError(loadError);
  const db = fakeAdminDb({
    'quiz_sets/legacy': { ownerUid: 'owner-uid', lifecycleState: 'active' },
    'quiz_sets/legacy/collaborators/teacher@school.kr': validCollaborator(),
    'quiz_sets/repair': { ownerUid: 'owner-uid', lifecycleState: 'trashed' },
    'quiz_sets/repair/collaborators/editor@school.kr': validCollaborator('editor@school.kr'),
    'quiz_set_shares/editor@school.kr/sets/repair': {
      email: 'editor@school.kr', setId: 'repair', reviewerEmail: 'private@school.kr'
    },
    'quiz_set_shares/ghost@school.kr/sets/stale': {
      email: 'ghost@school.kr', setId: 'stale'
    },
    'admin_private/victim/collaborators/teacher@school.kr': {
      email: 'teacher@school.kr', secret: 'never-index-this'
    }
  });

  const applied = await migration.runCollaboratorShareMigration({
    db,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    apply: true,
    confirmProject: 'demo-video-quiz'
  });

  assert.equal(applied.plannedUpsertCount, 2);
  assert.equal(applied.plannedDeleteCount, 1);
  assert.equal(applied.appliedUpsertCount, 2);
  assert.equal(applied.appliedDeleteCount, 1);
  assert.equal(applied.safeToUseShareIndex, true);
  assert.deepEqual(db.value('quiz_set_shares/teacher@school.kr/sets/legacy'), {
    email: 'teacher@school.kr', setId: 'legacy'
  });
  assert.deepEqual(db.value('quiz_set_shares/editor@school.kr/sets/repair'), {
    email: 'editor@school.kr', setId: 'repair'
  });
  assert.equal(db.has('quiz_set_shares/ghost@school.kr/sets/stale'), false);
  assert.equal(db.has('quiz_set_shares/teacher@school.kr/sets/victim'), false);

  const retry = await migration.runCollaboratorShareMigration({
    db,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    apply: true,
    confirmProject: 'demo-video-quiz'
  });
  assert.equal(retry.plannedUpsertCount, 0);
  assert.equal(retry.plannedDeleteCount, 0);
  assert.equal(retry.appliedUpsertCount, 0);
  assert.equal(retry.appliedDeleteCount, 0);
  assert.equal(retry.safeToUseShareIndex, true);
});

test('share migration CLI reserves a fail-closed durable report before Admin initialization', async () => {
  assert.ifError(cliLoadError);
  const events = [];
  let reserved;
  let published;
  const expected = {
    tool: 'collaborator-share-migration',
    schemaVersion: 2,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    windowId: '',
    controlId: '',
    capturedAt: '2026-08-23T01:00:00.123456789Z',
    mode: 'apply',
    operation: 'collaborator-share-backfill',
    status: 'complete',
    safeToUseShareIndex: true
  };

  const report = await cli.main([
    '--project', 'demo-video-quiz',
    '--target-mode', 'emulator',
    '--apply',
    '--confirm-project', 'demo-video-quiz',
    '--output', 'ignored.json'
  ], {
    environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    now: () => '2026-08-23T01:00:00.123456789Z',
    reserveReport(path, contents) {
      events.push('reserve');
      assert.equal(path, 'ignored.json');
      reserved = JSON.parse(contents);
      return { async commit(text) { events.push('commit'); published = JSON.parse(text); } };
    },
    async initialize(projectId) {
      events.push('initialize');
      assert.equal(projectId, 'demo-video-quiz');
      return { db: {}, async close() { events.push('close'); } };
    },
    async runCollaboratorShareMigration(options) {
      events.push('run');
      assert.equal(options.confirmProject, 'demo-video-quiz');
      return expected;
    },
    writeLine() {}
  });

  assert.deepEqual(events, ['reserve', 'initialize', 'run', 'commit', 'close']);
  assert.equal(reserved.status, 'reserved-fail-closed');
  assert.equal(reserved.safeToUseShareIndex, false);
  assert.deepEqual(published, expected);
  assert.deepEqual(report, expected);
});

test('share migration CLI prints only a non-PII summary while the restricted durable report retains details', async () => {
  assert.ifError(cliLoadError);
  const email = 'private-teacher@school.kr';
  const setId = 'private-set-id';
  const detailedReport = {
    tool: 'collaborator-share-migration', schemaVersion: 1,
    projectId: 'demo-video-quiz', targetMode: 'emulator', mode: 'dry-run',
    operation: 'collaborator-share-backfill', status: 'complete',
    plannedUpsertCount: 1, plannedDeleteCount: 0,
    appliedUpsertCount: 0, appliedDeleteCount: 0,
    concurrentlySkipped: [{ email, setId, reason: 'missing-parent' }],
    concurrentlySkippedCount: 1,
    audit: { findingDetails: [{ type: 'missing-index', email, setId }] },
    safeToUseShareIndex: false
  };
  let durable = '';
  const stdout = [];

  await cli.main([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator',
    '--output', 'restricted-report.json'
  ], {
    environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    reserveReport() { return { async commit(text) { durable = text; } }; },
    async initialize() { return { db: {}, async close() {} }; },
    async runCollaboratorShareMigration() { return detailedReport; },
    writeLine(line) { stdout.push(line); }
  });

  assert.match(durable, new RegExp(email));
  assert.match(durable, new RegExp(setId));
  assert.equal(stdout.length, 1);
  assert.match(stdout[0], /status=complete/);
  assert.match(stdout[0], /safeToUseShareIndex=false/);
  assert.match(stdout[0], /plannedUpserts=1/);
  assert.doesNotMatch(stdout[0], new RegExp(email));
  assert.doesNotMatch(stdout[0], new RegExp(setId));
  assert.doesNotMatch(stdout[0], /findingDetails|concurrentlySkipped\s*:/);
});

test('share migration transaction reread handles concurrent child removal and exact add safely', async () => {
  assert.ifError(loadError);
  const removed = fakeAdminDb({
    'quiz_sets/legacy': { ownerUid: 'owner-uid' },
    'quiz_sets/legacy/collaborators/teacher@school.kr': validCollaborator()
  }, {
    beforeTransaction({ attempt, docs }) {
      if (attempt === 1) docs.delete(
        'quiz_sets/legacy/collaborators/teacher@school.kr'
      );
    }
  });
  const removedReport = await migration.runCollaboratorShareMigration({
    db: removed,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    apply: true,
    confirmProject: 'demo-video-quiz'
  });
  assert.equal(removedReport.plannedUpsertCount, 1);
  assert.deepEqual(removedReport.concurrentlySkipped, [{
    setId: 'legacy', email: 'teacher@school.kr', reason: 'missing-collaborator'
  }]);
  assert.equal(removedReport.safeToUseShareIndex, true);
  assert.equal(removed.has('quiz_set_shares/teacher@school.kr/sets/legacy'), false);

  const added = fakeAdminDb({
    'quiz_sets/concurrent': { ownerUid: 'owner-uid' },
    'quiz_set_shares/teacher@school.kr/sets/concurrent': {
      email: 'teacher@school.kr', setId: 'concurrent'
    }
  }, {
    beforeTransaction({ attempt, docs }) {
      if (attempt === 1) {
        docs.set(
          'quiz_sets/concurrent/collaborators/teacher@school.kr',
          validCollaborator()
        );
      }
    }
  });
  const addedReport = await migration.runCollaboratorShareMigration({
    db: added,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    apply: true,
    confirmProject: 'demo-video-quiz'
  });
  assert.equal(addedReport.plannedDeleteCount, 1);
  assert.deepEqual(addedReport.concurrentlySkipped, [{
    setId: 'concurrent', email: 'teacher@school.kr', reason: 'already-current'
  }]);
  assert.equal(addedReport.safeToUseShareIndex, true);
  assert.deepEqual(added.value('quiz_set_shares/teacher@school.kr/sets/concurrent'), {
    email: 'teacher@school.kr', setId: 'concurrent'
  });
});

test('share migration fails closed on orphan or malformed collaborators and removes stale privacy data', async () => {
  assert.ifError(loadError);
  const db = fakeAdminDb({
    'quiz_sets/orphan/collaborators/orphan@school.kr': validCollaborator('orphan@school.kr'),
    'quiz_sets/malformed': { ownerUid: 'owner-uid' },
    'quiz_sets/malformed/collaborators/bad@school.kr': {
      ...validCollaborator('bad@school.kr'),
      secret: 'private collaborator field'
    },
    'quiz_sets/bad id': { ownerUid: 'owner-uid' },
    'quiz_sets/bad id/collaborators/path@school.kr': validCollaborator('path@school.kr'),
    'quiz_set_shares/stale@school.kr/sets/missing-child': {
      email: 'stale@school.kr',
      setId: 'missing-child',
      reviewerEmail: 'private@school.kr'
    },
    'quiz_set_shares/victim@school.kr/sets/bad id': {
      email: 'victim@school.kr',
      setId: 'bad id',
      secret: 'raw self-list privacy data'
    },
    'admin_private/victim/collaborators/victim@school.kr': {
      email: 'victim@school.kr',
      secret: 'unrelated collection group data'
    }
  });

  const report = await migration.runCollaboratorShareMigration({
    db,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    apply: true,
    confirmProject: 'demo-video-quiz'
  });

  assert.equal(report.appliedDeleteCount, 2);
  assert.equal(report.audit.orphanCollaboratorCount, 1);
  assert.equal(report.audit.malformedCollaboratorCount, 2);
  assert.equal(report.safeToUseShareIndex, false);
  assert.equal(db.has('quiz_set_shares/stale@school.kr/sets/missing-child'), false);
  assert.equal(db.has('quiz_set_shares/victim@school.kr/sets/bad id'), false);
  assert.equal(db.has('quiz_set_shares/orphan@school.kr/sets/orphan'), false);
  assert.equal(db.has('quiz_set_shares/victim@school.kr/sets/victim'), false);
});

test('share migration bounded scan and project confirmation fail closed with a partial report', async () => {
  assert.ifError(loadError);
  const db = fakeAdminDb({
    'quiz_sets/a': { ownerUid: 'owner-uid' },
    'quiz_sets/a/collaborators/a@school.kr': validCollaborator('a@school.kr'),
    'quiz_sets/b': { ownerUid: 'owner-uid' },
    'quiz_sets/b/collaborators/b@school.kr': validCollaborator('b@school.kr')
  });
  await assert.rejects(migration.runCollaboratorShareMigration({
    db,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    maxDocuments: 1
  }), error => {
    assert.match(error.message, /exceeds maxDocuments/);
    assert.equal(error.partialReport.status, 'failed');
    assert.equal(error.partialReport.safeToUseShareIndex, false);
    return true;
  });
  await assert.rejects(migration.runCollaboratorShareMigration({
    db,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    apply: true,
    confirmProject: 'wrong-project'
  }), /exact project/i);
});

test('share migration CLI rejects unsafe targets and durably publishes partial runner failures', async () => {
  assert.ifError(cliLoadError);
  assert.throws(() => cli.parseArgs([
    '--project', 'demo-video-quiz', '--apply'
  ]), /confirm-project/i);
  assert.throws(() => cli.validateTarget({
    projectId: 'video-quiz-65798', targetMode: 'emulator'
  }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /demo-/i);
  assert.throws(() => cli.validateTarget({
    projectId: 'video-quiz-65798', targetMode: 'production'
  }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /stale/i);

  let published;
  const partialReport = {
    tool: 'collaborator-share-migration',
    schemaVersion: 2,
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    windowId: '',
    controlId: '',
    capturedAt: '2026-08-23T01:00:01.123456789Z',
    mode: 'apply',
    operation: 'collaborator-share-backfill',
    appliedUpsertCount: 1,
    status: 'partial-failure',
    safeToUseShareIndex: false
  };
  const failure = Object.assign(new Error('transaction stopped'), { partialReport });
  await assert.rejects(cli.main([
    '--project', 'demo-video-quiz',
    '--target-mode', 'emulator',
    '--apply',
    '--confirm-project', 'demo-video-quiz',
    '--output', 'ignored.json'
  ], {
    environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    now: () => '2026-08-23T01:00:01.123456789Z',
    reserveReport() { return { async commit(text) { published = JSON.parse(text); } }; },
    async initialize() { return { db: {}, async close() {} }; },
    async runCollaboratorShareMigration() { throw failure; },
    writeLine() {}
  }), /transaction stopped/);
  assert.deepEqual(published, partialReport);
});
