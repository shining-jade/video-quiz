const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  auditLifecycle,
  planLifecycleBackfill,
  runLifecycleBackfill
} = require('../lifecycle-migration.js');

const PRODUCTION_EVIDENCE_IDENTITY = [
  '--window-id', '8f81218d-f1ec-497a-9b33-2b895ef82780',
  '--control-id', '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45'
];

function timestamp(milliseconds) {
  return { toMillis() { return milliseconds; } };
}

function fakeDb(initial, hooks = {}) {
  const docs = new Map(Object.entries(initial));
  const commits = [];
  let transactionNumber = 0;
  let collectionGetNumber = 0;
  return {
    docs,
    commits,
    collection() {
      return { async get() {
        collectionGetNumber += 1;
        if (hooks.failCollectionGetAt === collectionGetNumber) {
          throw new Error('injected final audit failure');
        }
        return { docs: [...docs.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) })) };
      } };
    },
    doc(path) { return { path }; },
    async runTransaction(handler) {
      transactionNumber += 1;
      if (hooks.beforeTransaction) hooks.beforeTransaction({ docs, transactionNumber });
      if (hooks.failTransactionAt === transactionNumber) {
        throw new Error('injected transaction failure');
      }
      const updates = [];
      const transaction = {
        async get(ref) {
          const id = ref.path.slice('quiz_sets/'.length);
          return {
            exists: docs.has(id),
            data: () => ({ ...docs.get(id) })
          };
        },
        update(ref, patch) { updates.push({ ref, patch }); }
      };
      const result = await handler(transaction);
      commits.push(updates.slice());
      updates.forEach(({ ref, patch }) => {
        const id = ref.path.slice('quiz_sets/'.length);
        docs.set(id, { ...docs.get(id), ...patch });
      });
      return result;
    },
    batch() {
      const updates = [];
      return {
        update(ref, patch) { updates.push({ ref, patch }); },
        async commit() {
          commits.push(updates.slice());
          updates.forEach(({ ref, patch }) => {
            const id = ref.path.slice('quiz_sets/'.length);
            docs.set(id, { ...docs.get(id), ...patch });
          });
        }
      };
    }
  };
}

test('lifecycle audit rejects incoherent states and non-Timestamp lifecycle markers', () => {
  const audit = auditLifecycle([
    { id: 'active-with-trash', data: { lifecycleState: 'active', trashedAt: timestamp(1) } },
    { id: 'trash-without-time', data: { lifecycleState: 'trashed' } },
    { id: 'trash-number-time', data: { lifecycleState: 'trashed', trashedAt: 1 } },
    { id: 'trash-with-purge', data: {
      lifecycleState: 'trashed', trashedAt: timestamp(1), purgeStartedAt: timestamp(2)
    } },
    { id: 'purging-without-trash', data: {
      lifecycleState: 'purging', purgeStartedAt: timestamp(2)
    } },
    { id: 'purging-number-time', data: {
      lifecycleState: 'purging', trashedAt: timestamp(1), purgeStartedAt: 2
    } },
    { id: 'valid-active', data: { lifecycleState: 'active' } },
    { id: 'valid-active-null', data: {
      lifecycleState: 'active', trashedAt: null, purgeStartedAt: null
    } },
    { id: 'valid-trash', data: { lifecycleState: 'trashed', trashedAt: timestamp(1) } },
    { id: 'valid-trash-null-purge', data: {
      lifecycleState: 'trashed', trashedAt: timestamp(1), purgeStartedAt: null
    } },
    { id: 'valid-purge', data: {
      lifecycleState: 'purging', trashedAt: timestamp(1), purgeStartedAt: timestamp(2)
    } }
  ]);

  assert.equal(audit.lifecycleMismatchCount, 6);
  assert.deepEqual(audit.lifecycleMismatchIds, [
    'active-with-trash', 'trash-without-time', 'trash-number-time',
    'trash-with-purge', 'purging-without-trash', 'purging-number-time'
  ]);
});

test('lifecycle backfill plans only legacy active sets and skips trash/present state', () => {
  const plan = planLifecycleBackfill([
    { id: 'legacy', data: { title: 'A' } },
    { id: 'legacy-null', data: { title: 'B', trashedAt: null, purgeStartedAt: null } },
    { id: 'active', data: { lifecycleState: 'active' } },
    { id: 'trash', data: { trashedAt: 1 } },
    { id: 'purging', data: { purgeStartedAt: 1 } }
  ]);
  assert.deepEqual(plan.planned.map(item => item.id), ['legacy', 'legacy-null']);
  assert.equal(plan.skipped.length, 3);
});

test('lifecycle backfill dry-run is read-only and apply is idempotent in batches', async () => {
  const db = fakeDb({ legacy: { title: 'A' }, legacy2: { title: 'B' } });
  const dry = await runLifecycleBackfill({ db, projectId: 'demo-video-quiz' });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.plannedCount, 2);
  assert.equal(db.commits.length, 0);
  await assert.rejects(
    runLifecycleBackfill({ db, projectId: 'video-quiz-65798', apply: true, confirmProject: 'wrong' }),
    /exact project/
  );
  const applied = await runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'demo-video-quiz', batchSize: 1
  });
  assert.equal(applied.appliedCount, 2);
  assert.equal(db.commits.length, 2);
  const retry = await runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(retry.plannedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
});

test('lifecycle backfill transaction never overwrites a concurrent trash transition as active', async () => {
  let raced = false;
  const db = fakeDb({ legacy: { title: 'A' } }, {
    beforeTransaction({ docs }) {
      if (raced) return;
      raced = true;
      docs.set('legacy', { title: 'A', trashedAt: timestamp(10) });
    }
  });

  const report = await runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true,
    confirmProject: 'demo-video-quiz', batchSize: 1
  });

  assert.equal(report.appliedCount, 0);
  assert.equal(report.concurrentlySkippedCount, 1);
  assert.equal(db.docs.get('legacy').lifecycleState, undefined);
  assert.equal(db.docs.get('legacy').trashedAt.toMillis(), 10);
  assert.equal(report.safeToDeployStrictRules, false);
});

test('lifecycle backfill deployment gate stays closed for a state-marker mismatch', async () => {
  const db = fakeDb({ broken: {
    lifecycleState: 'active', trashedAt: timestamp(10)
  } });

  const report = await runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true,
    confirmProject: 'demo-video-quiz'
  });

  assert.equal(report.plannedCount, 0);
  assert.equal(report.audit.lifecycleMismatchCount, 1);
  assert.equal(report.safeToDeployStrictRules, false);
});

test('lifecycle backfill exposes a fail-closed partial report after a later transaction fails', async () => {
  const db = fakeDb({ first: { title: 'A' }, second: { title: 'B' } }, {
    failTransactionAt: 2
  });

  await assert.rejects(runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true,
    confirmProject: 'demo-video-quiz', batchSize: 1
  }), error => {
    assert.match(error.message, /injected transaction failure/);
    assert.equal(error.partialReport.status, 'partial-failure');
    assert.equal(error.partialReport.appliedCount, 1);
    assert.equal(error.partialReport.safeToDeployStrictRules, false);
    assert.match(error.partialReport.error, /injected transaction failure/);
    assert.equal(error.partialReport.audit.missingLifecycleState, 1);
    return true;
  });
  assert.equal(db.docs.get('first').lifecycleState, 'active');
  assert.equal(db.docs.get('second').lifecycleState, undefined);
});

test('lifecycle backfill preserves applied and skipped side effects when final audit fails', async () => {
  const db = fakeDb({ first: { title: 'A' }, second: { title: 'B' } }, {
    failCollectionGetAt: 2,
    beforeTransaction({ docs, transactionNumber }) {
      if (transactionNumber === 2) {
        docs.set('second', { title: 'B', trashedAt: timestamp(20) });
      }
    }
  });

  await assert.rejects(runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true,
    confirmProject: 'demo-video-quiz', batchSize: 1
  }), error => {
    assert.match(error.message, /final audit failure/);
    assert.equal(error.partialReport.status, 'partial-failure');
    assert.equal(error.partialReport.appliedCount, 1);
    assert.equal(error.partialReport.concurrentlySkippedCount, 1);
    assert.deepEqual(error.partialReport.concurrentlySkipped, [
      { id: 'second', reason: 'changed-after-scan' }
    ]);
    assert.equal(error.partialReport.safeToDeployStrictRules, false);
    assert.match(error.partialReport.auditError, /final audit failure/);
    return true;
  });
  assert.equal(db.docs.get('first').lifecycleState, 'active');
  assert.equal(db.docs.get('second').lifecycleState, undefined);
});

test('lifecycle CLI exposes the repository durable exclusive report reservation protocol', () => {
  const command = require('../scripts/migrate-lifecycle-state.js');
  assert.equal(typeof command.reserveReport, 'function');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-report-'));
  const reportPath = path.join(directory, 'audit.json');
  try {
    fs.writeFileSync(reportPath, '{"foreign":true}\n', { flag: 'wx' });
    assert.throws(() => command.reserveReport(
      reportPath, '{"status":"reserved-fail-closed","safeToDeployStrictRules":false}\n'
    ), /exist|EEXIST/i);
    assert.equal(fs.readFileSync(reportPath, 'utf8'), '{"foreign":true}\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle CLI target validation rejects stale emulator env and requires exact demo hosts', () => {
  const command = require('../scripts/migrate-lifecycle-state.js');
  assert.throws(() => command.validateTarget({
    projectId: 'video-quiz-65798', targetMode: 'production'
  }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /stale/i);
  assert.throws(() => command.validateTarget({
    projectId: 'video-quiz-65798', targetMode: 'emulator'
  }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /demo/i);
  assert.throws(() => command.validateTarget({
    projectId: 'demo-video-quiz', targetMode: 'emulator'
  }, {
    FIRESTORE_EMULATOR_HOST: 'localhost:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /127\.0\.0\.1:8080/);
  assert.equal(command.validateTarget({
    projectId: 'demo-video-quiz', targetMode: 'emulator'
  }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }).targetMode, 'emulator');
});

test('lifecycle CLI reports and forwards the validated target mode', async () => {
  const command = require('../scripts/migrate-lifecycle-state.js');
  let placeholder;
  let published;
  let received;
  const report = await command.main([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator',
    '--output', 'ignored.json'
  ], {
    environment: {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
    },
    reserveReport(_path, contents) {
      placeholder = JSON.parse(contents);
      return { async commit(contents) { published = JSON.parse(contents); } };
    },
    async initialize() { return { db: {}, async close() {} }; },
    async runLifecycleBackfill(options) {
      received = options;
      return { status: 'complete', safeToDeployStrictRules: true };
    },
    writeLine() {}
  });
  assert.equal(placeholder.targetMode, 'emulator');
  assert.equal(received.targetMode, 'emulator');
  assert.equal(published.targetMode, 'emulator');
  assert.equal(report.targetMode, 'emulator');
});

test('lifecycle CLI reserves output before Admin initialization and refuses an existing target', async () => {
  const command = require('../scripts/migrate-lifecycle-state.js');
  const admin = require('firebase-admin');
  const migrationModule = require('../lifecycle-migration.js');
  const originalInitialize = admin.initializeApp;
  const originalFirestore = admin.firestore;
  const originalRunner = migrationModule.runLifecycleBackfill;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-cli-order-'));
  const output = path.join(directory, 'audit.json');
  const events = [];
  let committed = '';
  try {
    // Safe fallback for the pre-fix implementation, which ignores injected dependencies.
    admin.initializeApp = () => ({ async delete() {} });
    admin.firestore = () => ({});
    migrationModule.runLifecycleBackfill = async () => ({
      projectId: 'demo-video-quiz', mode: 'dry-run', status: 'complete',
      safeToDeployStrictRules: false
    });
    const report = await command.main([
      '--project', 'demo-video-quiz', ...PRODUCTION_EVIDENCE_IDENTITY, '--output', output
    ], {
      reserveReport(filePath, initialContents) {
        events.push('reserve');
        assert.equal(filePath, output);
        assert.equal(JSON.parse(initialContents).status, 'reserved-fail-closed');
        return { commit(contents) { events.push('commit'); committed = contents; } };
      },
      initialize(projectId) {
        events.push('initialize');
        assert.equal(projectId, 'demo-video-quiz');
        return { db: {}, async close() { events.push('close'); } };
      },
      async runLifecycleBackfill() {
        events.push('run');
        return {
          projectId: 'demo-video-quiz', mode: 'dry-run', status: 'complete',
          safeToDeployStrictRules: false
        };
      },
      writeLine() {}
    });
    assert.deepEqual(events, ['reserve', 'initialize', 'run', 'commit', 'close']);
    assert.equal(JSON.parse(committed).status, 'complete');
    assert.equal(report.status, 'complete');

    fs.writeFileSync(output, '{"foreign":true}\n', { flag: 'w' });
    let initialized = 0;
    await assert.rejects(command.main([
      '--project', 'demo-video-quiz', ...PRODUCTION_EVIDENCE_IDENTITY, '--output', output
    ], {
      reserveReport: command.reserveReport,
      initialize() { initialized += 1; throw new Error('must not initialize'); },
      runLifecycleBackfill() { throw new Error('must not run'); },
      writeLine() {}
    }), /exist|EEXIST/i);
    assert.equal(initialized, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), '{"foreign":true}\n');
  } finally {
    admin.initializeApp = originalInitialize;
    admin.firestore = originalFirestore;
    migrationModule.runLifecycleBackfill = originalRunner;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle CLI publishes a valid fail-closed partial report when a later batch fails', async () => {
  const command = require('../scripts/migrate-lifecycle-state.js');
  const events = [];
  let published = '';
  const original = new Error('second transaction failed');
  original.partialReport = {
    projectId: 'demo-video-quiz', mode: 'apply', operation: 'lifecycle-backfill',
    status: 'partial-failure', plannedCount: 2, appliedCount: 1,
    safeToDeployStrictRules: false,
    audit: { totalSets: 2, missingLifecycleState: 1 }
  };

  await assert.rejects(command.main([
    '--project', 'demo-video-quiz', '--apply',
    '--confirm-project', 'demo-video-quiz', ...PRODUCTION_EVIDENCE_IDENTITY,
    '--output', 'partial.json'
  ], {
    reserveReport() {
      events.push('reserve');
      return { commit(contents) { events.push('commit'); published = contents; } };
    },
    initialize() {
      events.push('initialize');
      return { db: {}, async close() { events.push('close'); } };
    },
    async runLifecycleBackfill() { events.push('run'); throw original; },
    writeLine() { throw new Error('must not print success'); }
  }), error => error === original);

  assert.deepEqual(events, ['reserve', 'initialize', 'run', 'commit', 'close']);
  const report = JSON.parse(published);
  assert.equal(report.status, 'partial-failure');
  assert.equal(report.appliedCount, 1);
  assert.equal(report.safeToDeployStrictRules, false);
  assert.match(report.error, /second transaction failed/);
});

test('lifecycle CLI keeps published success JSON when stdout fails after commit', async () => {
  const command = require('../scripts/migrate-lifecycle-state.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-cli-stdout-'));
  const output = path.join(directory, 'audit.json');
  try {
    await assert.rejects(command.main([
      '--project', 'demo-video-quiz', ...PRODUCTION_EVIDENCE_IDENTITY, '--output', output
    ], {
      reserveReport: command.reserveReport,
      initialize() { return { db: {}, async close() {} }; },
      async runLifecycleBackfill() {
        return {
          projectId: 'demo-video-quiz', mode: 'dry-run', status: 'complete',
          appliedCount: 0, safeToDeployStrictRules: false
        };
      },
      writeLine() { throw new Error('injected stdout failure'); }
    }), error => {
      assert.match(error.message, /injected stdout failure/);
      assert.doesNotMatch(error.message, /fail-closed report remains|already published/i);
      return true;
    });
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'complete');
    assert.equal(fs.existsSync(output + '.reserved'), false);
    assert.equal(fs.existsSync(output + '.pending'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
