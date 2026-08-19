const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../counter-migration.js');
const cli = require('../scripts/migrate-set-counters.js');

test('counter migration target validation fails closed for stale emulator environment and requires explicit demo emulator', () => {
  assert.throws(() => cli.validateTarget({ projectId: 'video-quiz-65798', targetMode: 'production' }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /stale/);
  assert.throws(() => cli.validateTarget({ projectId: 'video-quiz-65798', targetMode: 'emulator' }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /demo/);
  assert.deepEqual(cli.validateTarget({ projectId: 'demo-video-quiz', targetMode: 'emulator' }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }).targetMode, 'emulator');
});

test('counter migration publishes targetMode and cumulative counters on a runner partial failure report', async () => {
  let published;
  const partialReport = {
    tool: 'set-counter-migration-cli', schemaVersion: 1,
    projectId: 'video-quiz-65798', mode: 'apply', operation: 'set-counter-backfill',
    status: 'partial-failure', safeToDeployStrictRules: false,
    plannedCount: 3, appliedCount: 1,
    concurrentlySkipped: [{ id: 'b', reason: 'missing-parent' }], concurrentlySkippedCount: 1
  };
  const failure = Object.assign(new Error('stopped'), { partialReport });
  await assert.rejects(cli.main([
    '--project', 'video-quiz-65798', '--apply',
    '--confirm-project', 'video-quiz-65798', '--gate-id', 'gate-1', '--output', 'ignored.json'
  ], {
    environment: {},
    reserveReport() { return { async commit(text) { published = JSON.parse(text); } }; },
    async initialize() { return { db: {}, async close() {} }; },
    async runCounterBackfill() { throw failure; },
    writeLine() {}
  }), /stopped/);
  assert.equal(published.targetMode, 'production');
  assert.equal(published.plannedCount, 3);
  assert.equal(published.appliedCount, 1);
  assert.equal(published.concurrentlySkippedCount, 1);
});

function fakeDb(initial, options = {}) {
  const docs = new Map(Object.entries(initial));
  const versions = new Map([...docs.keys()].map(path => [path, 1]));
  const setValue = (path, value) => {
    docs.set(path, value);
    versions.set(path, (versions.get(path) || 0) + 1);
  };
  const snapshot = path => {
    const value = docs.get(path);
    return {
      exists: value !== undefined,
      data: () => value,
      id: path.split('/').at(-1),
      updateTime: {
        seconds: 0,
        nanoseconds: versions.get(path) || 0,
        toMillis: () => 0
      }
    };
  };
  const calls = new Map();
  const beforeGet = async path => {
    const call = (calls.get(path) || 0) + 1;
    calls.set(path, call);
    if (options.failCollectionGet && options.failCollectionGet[path] === call) {
      throw new Error(`collection read failed: ${path}:${call}`);
    }
    if (options.onCollectionGet) await options.onCollectionGet({ path, call, docs, setValue });
  };
  const ref = path => ({ path, get: async () => snapshot(path) });
  const query = path => ({ path, async get() {
    await beforeGet(path);
    const prefix = path + '/';
    const child = [...docs.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'));
    return { docs: child.map(([id, data]) => ({ id: id.split('/').at(-1), data: () => data })), size: child.length };
  }});
  return {
    docs,
    setValue,
    collection(path) { return path === 'quiz_sets' ? { async get() {
      await beforeGet(path);
      const sets = [...docs.entries()].filter(([key]) => key.startsWith('quiz_sets/') && !key.slice(10).includes('/'));
      return { docs: sets.map(([key, data]) => ({ id: key.split('/').at(-1), data: () => data })) };
    }} : query(path); },
    doc: ref,
    async runTransaction(handler) {
      const updates = [];
      const transaction = {
        async get(target) { return typeof target.get === 'function' ? target.get() : snapshot(target.path); },
        update(target, patch) { updates.push([target.path, patch]); }
      };
      const result = await handler(transaction);
      updates.forEach(([path, patch]) => setValue(path, { ...docs.get(path), ...patch }));
      return result;
    }
  };
}

test('counter migration dry-run is read-only and plans authoritative child counts', async () => {
  const db = fakeDb({
    'quiz_sets/a': { title: 'A' },
    'quiz_sets/a/collaborators/e@school.kr': { email: 'e@school.kr' },
    'images/a/q/v0q0': { data: 'image' }
  });
  const report = await migration.runCounterBackfill({ db, projectId: 'demo-video-quiz' });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plannedCount, 1);
  assert.equal(db.docs.get('quiz_sets/a').imageCount, undefined);
  assert.equal(report.safeToDeployStrictRules, false);
});

test('counter migration apply is exact-project gated, idempotent, and concurrency-safe on reread', async () => {
  const db = fakeDb({
    'migration_gates/set_counters': {
      locked: true, lockId: 'gate-1', projectId: 'demo-video-quiz', targetMode: 'emulator'
    },
    'quiz_sets/a': { title: 'A' },
    'quiz_sets/a/collaborators/e@school.kr': { email: 'e@school.kr' }
  });
  await assert.rejects(migration.runCounterBackfill({ db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'wrong' }), /exact project/);
  const applied = await migration.runCounterBackfill({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', gateId: 'gate-1',
    apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.gate.lockId, 'gate-1');
  assert.equal(applied.gate.locked, true);
  assert.deepEqual(db.docs.get('quiz_sets/a'), { title: 'A', collaboratorCount: 1, imageCount: 0 });
  const retry = await migration.runCounterBackfill({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', gateId: 'gate-1',
    apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(retry.plannedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
});

test('counter migration apply requires the exact locked server gate identity', async () => {
  for (const [name, gate, pattern] of [
    ['missing', undefined, /gate.*missing/i],
    ['unlocked', { locked: false, lockId: 'gate-1', projectId: 'demo-video-quiz', targetMode: 'emulator' }, /locked/i],
    ['wrong-project', { locked: true, lockId: 'gate-1', projectId: 'other', targetMode: 'emulator' }, /project/i],
    ['wrong-mode', { locked: true, lockId: 'gate-1', projectId: 'demo-video-quiz', targetMode: 'production' }, /mode/i],
    ['wrong-id', { locked: true, lockId: 'other', projectId: 'demo-video-quiz', targetMode: 'emulator' }, /identity/i]
  ]) {
    const initial = { 'quiz_sets/a': { title: name } };
    if (gate) initial['migration_gates/set_counters'] = gate;
    const db = fakeDb(initial);
    await assert.rejects(migration.runCounterBackfill({
      db, projectId: 'demo-video-quiz', targetMode: 'emulator', gateId: 'gate-1',
      apply: true, confirmProject: 'demo-video-quiz'
    }), pattern);
    assert.equal(db.docs.get('quiz_sets/a').imageCount, undefined);
  }
});

test('counter migration final audit rejects an unlock or changed gate generation', async () => {
  const gate = { locked: true, lockId: 'gate-1', projectId: 'demo-video-quiz', targetMode: 'emulator' };
  const db = fakeDb({
    'migration_gates/set_counters': gate,
    'quiz_sets/a': { title: 'A' }
  }, {
    onCollectionGet({ path, call, setValue }) {
      if (path === 'quiz_sets' && call === 2) setValue('migration_gates/set_counters', { ...gate, locked: false });
    }
  });
  let failure;
  try {
    await migration.runCounterBackfill({
      db, projectId: 'demo-video-quiz', targetMode: 'emulator', gateId: 'gate-1',
      apply: true, confirmProject: 'demo-video-quiz'
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /gate.*changed|locked/i);
  assert.equal(failure.partialReport.plannedCount, 1);
  assert.equal(failure.partialReport.appliedCount, 1);
  assert.deepEqual(failure.partialReport.concurrentlySkipped, []);
  assert.equal(failure.partialReport.safeToDeployStrictRules, false);
});

test('counter migration detects a same-data gate rewrite within one millisecond', async () => {
  const gate = { locked: true, lockId: 'gate-1', projectId: 'demo-video-quiz', targetMode: 'emulator' };
  const db = fakeDb({
    'migration_gates/set_counters': gate,
    'quiz_sets/a': { title: 'A' }
  }, {
    onCollectionGet({ path, call, setValue }) {
      if (path === 'quiz_sets' && call === 2) setValue('migration_gates/set_counters', { ...gate });
    }
  });
  await assert.rejects(migration.runCounterBackfill({
    db, projectId: 'demo-video-quiz', targetMode: 'emulator', gateId: 'gate-1',
    apply: true, confirmProject: 'demo-video-quiz'
  }), /generation changed/i);
});

test('counter migration final audit read failure carries cumulative fail-closed progress', async () => {
  const db = fakeDb({
    'migration_gates/set_counters': {
      locked: true, lockId: 'gate-1', projectId: 'demo-video-quiz', targetMode: 'emulator'
    },
    'quiz_sets/a': { title: 'A' }
  }, { failCollectionGet: { quiz_sets: 2 } });
  let failure;
  try {
    await migration.runCounterBackfill({
      db, projectId: 'demo-video-quiz', targetMode: 'emulator', gateId: 'gate-1',
      apply: true, confirmProject: 'demo-video-quiz'
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /collection read failed/);
  assert.equal(failure.partialReport.plannedCount, 1);
  assert.equal(failure.partialReport.appliedCount, 1);
  assert.deepEqual(failure.partialReport.concurrentlySkipped, []);
  assert.equal(failure.partialReport.concurrentlySkippedCount, 0);
  assert.equal(failure.partialReport.status, 'partial-failure');
  assert.equal(failure.partialReport.safeToDeployStrictRules, false);
});

test('counter migration CLI requires and forwards gate identity for apply', async () => {
  assert.throws(() => cli.parseArgs([
    '--project', 'demo-video-quiz', '--apply', '--confirm-project', 'demo-video-quiz'
  ]), /gate/i);
  let received;
  await cli.main([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator', '--apply',
    '--confirm-project', 'demo-video-quiz', '--gate-id', 'gate-1', '--output', 'ignored.json'
  ], {
    environment: {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
    },
    reserveReport() { return { async commit() {} }; },
    async initialize() { return { db: {}, async close() {} }; },
    async runCounterBackfill(options) {
      received = options;
      return { status: 'complete', safeToDeployStrictRules: true };
    },
    writeLine() {}
  });
  assert.equal(received.gateId, 'gate-1');
  assert.equal(received.targetMode, 'emulator');
});
