const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../counter-gate.js');
const cli = require('../scripts/manage-counter-gate.js');

const SERVER_TIMESTAMP = Symbol('serverTimestamp');

function fakeDb(initial) {
  let value = initial == null ? undefined : structuredClone(initial);
  let version = value == null ? 0 : 1;
  const snapshot = () => ({
    exists: value !== undefined,
    data: () => value === undefined ? undefined : structuredClone(value),
    updateTime: value === undefined ? undefined : {
      seconds: 100,
      nanoseconds: version,
      toMillis: () => 100_000
    }
  });
  const resolve = item => item === SERVER_TIMESTAMP
    ? { seconds: 200, nanoseconds: version + 1 }
    : item;
  const replace = next => {
    value = Object.fromEntries(Object.entries(next).map(([key, item]) => [key, resolve(item)]));
    version += 1;
  };
  const reference = { path: 'migration_gates/set_counters', get: async () => snapshot() };
  return {
    doc(requestedPath) {
      assert.equal(requestedPath, 'migration_gates/set_counters');
      return reference;
    },
    async runTransaction(handler) {
      let next;
      const result = await handler({
        async get(ref) {
          assert.equal(ref, reference);
          return snapshot();
        },
        set(ref, data) {
          assert.equal(ref, reference);
          next = data;
        }
      });
      if (next) replace(next);
      return result;
    },
    value: () => value === undefined ? undefined : structuredClone(value),
    rewriteSameData() { replace(value); }
  };
}

test('counter gate target guard rejects stale production env and requires exact demo emulator', () => {
  assert.throws(() => cli.validateTarget({
    projectId: 'video-quiz-65798', targetMode: 'production'
  }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /stale/i);
  assert.throws(() => cli.validateTarget({
    projectId: 'video-quiz-65798', targetMode: 'emulator'
  }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /demo/i);
  assert.throws(() => cli.validateTarget({
    projectId: 'demo-video-quiz', targetMode: 'emulator'
  }, {
    FIRESTORE_EMULATOR_HOST: 'localhost:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }), /127\.0\.0\.1:8080/);
  assert.equal(cli.validateTarget({
    projectId: 'demo-video-quiz', targetMode: 'emulator'
  }, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  }).targetMode, 'emulator');
});

test('counter gate CLI generates lock identities instead of accepting an operator-supplied lock id', () => {
  assert.throws(() => cli.parseArgs([
    '--action', 'lock', '--project', 'demo-video-quiz', '--target-mode', 'emulator',
    '--confirm-project', 'demo-video-quiz', '--admin-uid', 'admin-uid',
    '--gate-id', 'reused-id'
  ]), /generat|gate-id/i);
});

test('lock creates an exact new identity and returns authoritative readback generation', async () => {
  const db = fakeDb();
  const report = await gate.runCounterGateOperation({
    db,
    action: 'lock',
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    actorUid: 'admin-uid',
    createLockId: () => 'generated-lock-id',
    serverTimestamp: () => SERVER_TIMESTAMP
  });

  assert.deepEqual(db.value(), {
    locked: true,
    lockId: 'generated-lock-id',
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    lockedAt: { seconds: 200, nanoseconds: 1 },
    lockedByUid: 'admin-uid'
  });
  assert.equal(report.gate.lockId, 'generated-lock-id');
  assert.equal(report.gate.updateTimeGeneration, '100:1');
  assert.equal(report.status, 'complete');
});

test('lock refuses to replace a currently locked generation', async () => {
  const db = fakeDb({
    locked: true, lockId: 'existing', projectId: 'demo-video-quiz',
    targetMode: 'emulator', lockedAt: { seconds: 1 }, lockedByUid: 'admin-uid'
  });
  await assert.rejects(gate.runCounterGateOperation({
    db, action: 'lock', projectId: 'demo-video-quiz', targetMode: 'emulator',
    actorUid: 'admin-uid', createLockId: () => 'new-id',
    serverTimestamp: () => SERVER_TIMESTAMP
  }), /already locked/i);
  assert.equal(db.value().lockId, 'existing');
});

test('unlock requires exact lock id and updateTime generation of the current locked doc', async () => {
  const current = {
    locked: true, lockId: 'lock-1', projectId: 'demo-video-quiz',
    targetMode: 'emulator', lockedAt: { seconds: 1 }, lockedByUid: 'admin-uid'
  };
  const wrongId = fakeDb(current);
  await assert.rejects(gate.runCounterGateOperation({
    db: wrongId, action: 'unlock', projectId: 'demo-video-quiz', targetMode: 'emulator',
    actorUid: 'admin-uid', gateId: 'other', gateGeneration: '100:1',
    serverTimestamp: () => SERVER_TIMESTAMP
  }), /identity/i);

  const stale = fakeDb(current);
  stale.rewriteSameData();
  await assert.rejects(gate.runCounterGateOperation({
    db: stale, action: 'unlock', projectId: 'demo-video-quiz', targetMode: 'emulator',
    actorUid: 'admin-uid', gateId: 'lock-1', gateGeneration: '100:1',
    serverTimestamp: () => SERVER_TIMESTAMP
  }), /generation/i);

  const unlocked = fakeDb({ ...current, locked: false });
  await assert.rejects(gate.runCounterGateOperation({
    db: unlocked, action: 'unlock', projectId: 'demo-video-quiz', targetMode: 'emulator',
    actorUid: 'admin-uid', gateId: 'lock-1', gateGeneration: '100:1',
    serverTimestamp: () => SERVER_TIMESTAMP
  }), /locked/i);
});

test('unlock preserves lock identity and records a new authoritative generation', async () => {
  const db = fakeDb({
    locked: true, lockId: 'lock-1', projectId: 'demo-video-quiz',
    targetMode: 'emulator', lockedAt: { seconds: 1 }, lockedByUid: 'first-admin'
  });
  const report = await gate.runCounterGateOperation({
    db, action: 'unlock', projectId: 'demo-video-quiz', targetMode: 'emulator',
    actorUid: 'second-admin', gateId: 'lock-1', gateGeneration: '100:1',
    serverTimestamp: () => SERVER_TIMESTAMP
  });

  assert.deepEqual(db.value(), {
    locked: false,
    lockId: 'lock-1',
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    lockedAt: { seconds: 1 },
    lockedByUid: 'first-admin',
    unlockedAt: { seconds: 200, nanoseconds: 2 },
    unlockedByUid: 'second-admin'
  });
  assert.equal(report.gate.previousUpdateTimeGeneration, '100:1');
  assert.equal(report.gate.updateTimeGeneration, '100:2');
});

test('status is read-only and reports missing or current gate identity', async () => {
  const missing = await gate.runCounterGateOperation({
    db: fakeDb(), action: 'status', projectId: 'demo-video-quiz',
    targetMode: 'emulator'
  });
  assert.equal(missing.gate.exists, false);

  const present = await gate.runCounterGateOperation({
    db: fakeDb({
      locked: true, lockId: 'lock-1', projectId: 'demo-video-quiz',
      targetMode: 'emulator', lockedAt: { seconds: 1 }, lockedByUid: 'admin-uid'
    }),
    action: 'status', projectId: 'demo-video-quiz', targetMode: 'emulator'
  });
  assert.equal(present.gate.updateTimeGeneration, '100:1');
});

test('counter gate CLI reserves report before Admin initialization and never overwrites output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-gate-report-'));
  const output = path.join(directory, 'gate.json');
  const events = [];
  let placeholder;
  let published;
  try {
    const report = await cli.main([
      '--action', 'lock', '--project', 'demo-video-quiz', '--target-mode', 'emulator',
      '--confirm-project', 'demo-video-quiz', '--admin-uid', 'admin-uid',
      '--output', output
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      createLockId: () => 'generated-id',
      reserveReport(filePath, contents) {
        events.push('reserve');
        assert.equal(filePath, output);
        placeholder = JSON.parse(contents);
        return { async commit(contents) { events.push('commit'); published = JSON.parse(contents); } };
      },
      async initialize(projectId) {
        events.push('initialize');
        assert.equal(projectId, 'demo-video-quiz');
        return { db: {}, serverTimestamp: () => SERVER_TIMESTAMP, async close() { events.push('close'); } };
      },
      async runCounterGateOperation(options) {
        events.push('run');
        assert.equal(options.gateId, 'generated-id');
        return { status: 'complete', gate: { lockId: 'generated-id' } };
      },
      writeLine() {}
    });
    assert.deepEqual(events, ['reserve', 'initialize', 'run', 'commit', 'close']);
    assert.equal(placeholder.targetMode, 'emulator');
    assert.equal(placeholder.lockId, 'generated-id');
    assert.equal(published.targetMode, 'emulator');
    assert.equal(report.targetMode, 'emulator');

    fs.writeFileSync(output, '{"foreign":true}\n', { flag: 'w' });
    let initialized = false;
    await assert.rejects(cli.main([
      '--action', 'status', '--project', 'demo-video-quiz', '--target-mode', 'emulator',
      '--output', output
    ], {
      environment: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
      },
      reserveReport: cli.reserveReport,
      async initialize() { initialized = true; throw new Error('must not initialize'); },
      runCounterGateOperation() { throw new Error('must not run'); },
      writeLine() {}
    }), /exist|EEXIST/i);
    assert.equal(initialized, false);
    assert.equal(fs.readFileSync(output, 'utf8'), '{"foreign":true}\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
