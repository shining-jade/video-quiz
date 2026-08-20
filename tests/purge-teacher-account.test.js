const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reserveReport } = require('../scripts/migrate-legacy-ownership.js');
const {
  parseCliArgs,
  validateTarget,
  eventId,
  runTeacherPurge,
  main
} = require('../scripts/purge-teacher-account.js');

const DAYS_30_MS = 30 * 24 * 60 * 60 * 1000;
const REQUESTED_AT = Date.UTC(2026, 6, 1);
const NOW = REQUESTED_AT + DAYS_30_MS;

function pendingAllowance(overrides = {}) {
  return {
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: 'private',
    role: 'teacher', status: 'deletion_pending', enabled: false,
    administrativeHold: false, revision: 8,
    deletionRequestedAtMs: REQUESTED_AT,
    purgeEligibleAtMs: REQUESTED_AT + DAYS_30_MS,
    ...overrides
  };
}

function auditState(overrides = {}) {
  return {
    allowance: pendingAllowance(), requestExists: true, profileExists: true,
    legacyAllowanceExists: true, ownedSetIds: [], blockingSessionIds: [],
    authUserExists: true, auditEvent: null,
    ...overrides
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fakeAdapter(initial = auditState(), options = {}) {
  let state = clone(initial);
  let auditIndex = 0;
  let proof = null;
  const calls = [];
  return {
    calls,
    state: () => clone(state),
    async createServerTimeProof(expected) {
      calls.push(['createServerTimeProof', clone(expected)]);
      proof = {
        opId: expected.opId,
        targetUid: expected.uid,
        projectId: expected.projectId,
        environment: expected.environment,
        mode: expected.mode,
        allowanceRevision: expected.revision,
        deletionRequestedAtMs: expected.deletionRequestedAtMs,
        purgeEligibleAtMs: expected.purgeEligibleAtMs,
        proofAtMs: options.proofAtMs === undefined ? NOW : options.proofAtMs,
        updateTimeMs: options.proofAtMs === undefined ? NOW : options.proofAtMs
      };
      return clone(options.forgedProof ? { ...proof, ...options.forgedProof } : proof);
    },
    async cleanupServerTimeProof(expectedProof) {
      calls.push(['cleanupServerTimeProof', clone(expectedProof)]);
      if (proof && expectedProof && proof.opId === expectedProof.opId) proof = null;
      return true;
    },
    async audit(uid, identity) {
      calls.push(['audit', uid, identity && identity.emailCanonical]);
      if (options.auditErrorAt === auditIndex) {
        auditIndex += 1;
        throw new Error('injected audit ambiguity');
      }
      const sequenced = options.auditSequence && options.auditSequence[auditIndex];
      auditIndex += 1;
      return clone(sequenced || state);
    },
    async purgeFirestore(expected) {
      calls.push(['purgeFirestore', clone(expected)]);
      if (!proof || proof.opId !== expected.opId || proof.proofAtMs !== expected.proofAtMs) {
        throw new Error('server-time proof changed');
      }
      if (options.raceAtMutation) throw new Error('authoritative transaction re-read changed');
      if (options.allocationRaceAtMutation) {
        state.blockingSessionIds = ['new-allocating'];
        throw new Error('blocking session appeared before mutation');
      }
      state.allowance = null;
      state.requestExists = false;
      state.profileExists = false;
      state.legacyAllowanceExists = false;
      state.auditEvent = {
        eventId: expected.eventId, type: 'teacher_account_purged',
        targetUid: expected.uid, allowanceRevision: expected.revision,
        operationId: expected.opId, result: 'firestore_purged',
        projectId: expected.projectId, environment: expected.environment, mode: expected.mode,
        proofAtMs: expected.proofAtMs,
        deletionRequestedAtMs: expected.deletionRequestedAtMs,
        purgeEligibleAtMs: expected.purgeEligibleAtMs,
        status: 'firestore_purged'
      };
      proof = null;
      if (options.firestoreAmbiguous) throw new Error('injected Firestore ambiguity');
    },
    async deleteAuthUser(uid) {
      calls.push(['deleteAuthUser', uid]);
      state.authUserExists = false;
      if (options.authAmbiguous) throw new Error('injected Auth ambiguity');
    },
    async completeAuditEvent(expected) {
      calls.push(['completeAuditEvent', expected.eventId]);
      if (!state.auditEvent) throw new Error('missing audit event');
      state.auditEvent.status = 'complete';
      state.auditEvent.result = 'complete';
    }
  };
}

function applyOptions(overrides = {}) {
  return {
    projectId: 'demo-video-quiz', environment: 'emulator', mode: 'apply',
    uid: 'teacher-a', output: 'unused.json', confirmProject: 'demo-video-quiz',
    confirmUid: 'teacher-a', ...overrides
  };
}

test('CLI parsing defaults to dry-run but requires exact project, environment, UID, and output', () => {
  assert.deepEqual(parseCliArgs([
    '--project', 'demo-video-quiz', '--environment', 'emulator',
    '--uid', 'teacher-a', '--output', 'report.json'
  ]), {
    projectId: 'demo-video-quiz', environment: 'emulator', mode: 'dry-run',
    uid: 'teacher-a', output: 'report.json', confirmProject: '', confirmUid: ''
  });
  assert.throws(() => parseCliArgs(['--project', 'demo-x']), /environment|required/i);
  assert.throws(() => parseCliArgs([
    '--project', 'demo-x', '--environment', 'emulator', '--uid', 'u', '--output', 'x',
    '--mode', 'apply', '--confirm-project', 'demo-x'
  ]), /confirm-uid/i);
  assert.throws(() => parseCliArgs([
    '--project', 'demo-x', '--environment', 'emulator', '--uid', 'u', '--output', 'x',
    '--mode', 'invalid'
  ]), /mode/i);
});

test('target validation rejects mismatched project/emulator state', () => {
  const emulatorEnv = {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  };
  assert.equal(validateTarget(applyOptions(), emulatorEnv), 'emulator');
  assert.throws(() => validateTarget(applyOptions({ projectId: 'real-project' }), emulatorEnv), /demo-/i);
  assert.throws(() => validateTarget(applyOptions({ environment: 'production' }), emulatorEnv), /production|demo|emulator/i);
  assert.throws(() => validateTarget(applyOptions({ projectId: 'demo-x', environment: 'production' }), {}), /production|demo/i);
});

test('dry-run performs authoritative audit and no mutations', async () => {
  const adapter = fakeAdapter();
  const report = await runTeacherPurge({
    adapter, options: applyOptions({ mode: 'dry-run', confirmProject: '', confirmUid: '' }), nowMs: NOW
  });
  assert.equal(report.status, 'dry-run-eligible');
  assert.equal(report.safeToPurge, true);
  assert.deepEqual(adapter.calls.map(call => call[0]), [
    'audit', 'createServerTimeProof', 'cleanupServerTimeProof'
  ]);
  assert.equal(report.audit.ownedSetCount, 0);
  assert.equal(report.audit.blockingSessionCount, 0);
  assert.equal(JSON.stringify(report).includes('teacher@school.kr'), false);
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('apply refuses blockers, malformed state, and a transaction re-read race before writes', async t => {
  await t.test('blockers', async () => {
    const adapter = fakeAdapter(auditState({ ownedSetIds: ['set-private'], blockingSessionIds: ['session-private'] }));
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'refused');
    assert.deepEqual(report.audit.blockers, ['owned_sets', 'blocking_sessions']);
    assert.equal(JSON.stringify(report).includes('set-private'), false);
  });
  await t.test('malformed timestamp', async () => {
    const adapter = fakeAdapter(auditState({ allowance: pendingAllowance({ purgeEligibleAtMs: NOW + 1 }) }));
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'refused');
    assert.ok(report.audit.blockers.includes('invalid_state'));
    assert.equal(adapter.calls.some(call => call[0] === 'purgeFirestore'), false);
  });
  await t.test('wrong allowance UID', async () => {
    const adapter = fakeAdapter(auditState({ allowance: pendingAllowance({ uid: 'teacher-b' }) }));
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'refused');
    assert.ok(report.audit.blockers.includes('invalid_state'));
    assert.equal(adapter.calls.some(call => call[0] === 'purgeFirestore'), false);
  });
  await t.test('re-audit race', async () => {
    const first = auditState();
    const changed = auditState({ allowance: pendingAllowance({ revision: 9 }) });
    const adapter = fakeAdapter(first, { auditSequence: [first, changed] });
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'failed');
    assert.match(report.error, /re-audit|changed/i);
    assert.equal(adapter.calls.some(call => call[0] === 'purgeFirestore'), false);
  });
  await t.test('allocating race inside transaction', async () => {
    const adapter = fakeAdapter(auditState(), { allocationRaceAtMutation: true });
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW + 9_999 });
    assert.equal(report.status, 'failed');
    assert.equal(report.remaining.blockingSessionCount, 1);
    assert.equal(adapter.calls.some(call => call[0] === 'deleteAuthUser'), false);
  });
});

test('server-time proof denies exactly one millisecond early and rejects forged proof identity', async t => {
  await t.test('one millisecond early', async () => {
    const adapter = fakeAdapter(auditState(), { proofAtMs: NOW - 1 });
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW + 99_999 });
    assert.equal(report.status, 'refused');
    assert.deepEqual(report.audit.blockers, ['waiting_period']);
    assert.equal(adapter.calls.some(call => call[0] === 'purgeFirestore'), false);
  });
  await t.test('forged target', async () => {
    const adapter = fakeAdapter(auditState(), { forgedProof: { targetUid: 'teacher-b' } });
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'failed');
    assert.match(report.error, /proof|target|identity/i);
    assert.equal(adapter.calls.some(call => call[0] === 'purgeFirestore'), false);
  });
});

test('partial Firestore or Auth ambiguity is reported fail closed with exact remaining state', async t => {
  await t.test('Firestore ambiguity', async () => {
    const adapter = fakeAdapter(auditState(), { firestoreAmbiguous: true });
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'failed');
    assert.equal(report.safeToPurge, false);
    assert.equal(report.remaining.authUserExists, true);
    assert.equal(report.remaining.allowanceExists, false);
    assert.match(report.error, /Firestore ambiguity/);
  });
  await t.test('Auth ambiguity', async () => {
    const adapter = fakeAdapter(auditState(), { authAmbiguous: true });
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
    assert.equal(report.status, 'failed');
    assert.equal(report.remaining.authUserExists, false);
    assert.equal(report.remaining.auditEventStatus, 'firestore_purged');
    assert.equal(adapter.calls.some(call => call[0] === 'completeAuditEvent'), false);
  });
});

test('successful apply records a non-sensitive event, verifies final state, and supports idempotent recovery', async () => {
  const adapter = fakeAdapter();
  const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW });
  assert.equal(report.status, 'complete');
  assert.equal(report.safeToPurge, true);
  assert.deepEqual(adapter.calls.map(call => call[0]), [
    'audit', 'createServerTimeProof', 'audit', 'purgeFirestore',
    'deleteAuthUser', 'completeAuditEvent', 'audit'
  ]);
  const event = adapter.state().auditEvent;
  assert.equal(event.status, 'complete');
  assert.equal(/email|name|note/i.test(Object.keys(event).join(' ')), false);
  assert.equal(JSON.stringify(event).includes('@'), false);

  const recovery = fakeAdapter({
    allowance: null, requestExists: false, profileExists: false,
    legacyAllowanceExists: false, ownedSetIds: [], blockingSessionIds: [],
    authUserExists: true, auditEvent: {
      ...event, status: 'firestore_purged', result: 'firestore_purged'
    }
  });
  const recovered = await runTeacherPurge({ recovery, adapter: recovery, options: applyOptions(), nowMs: NOW + 1 });
  assert.equal(recovered.status, 'complete');
  assert.deepEqual(recovery.calls.map(call => call[0]), [
    'audit', 'deleteAuthUser', 'completeAuditEvent', 'audit'
  ]);
});

test('completed audit retry is idempotent only for the exact same operation and result', async t => {
  const completeEvent = {
    eventId: eventId('teacher-a'), operationId: eventId('teacher-a'),
    type: 'teacher_account_purged', targetUid: 'teacher-a', allowanceRevision: 8,
    deletionRequestedAtMs: REQUESTED_AT, purgeEligibleAtMs: NOW,
    proofAtMs: NOW, projectId: 'demo-video-quiz', environment: 'emulator', mode: 'apply',
    status: 'complete', result: 'complete'
  };
  const completedState = auditState({
    allowance: null, requestExists: false, profileExists: false,
    legacyAllowanceExists: false, ownedSetIds: [], blockingSessionIds: [],
    authUserExists: false, auditEvent: completeEvent
  });
  await t.test('exact completed retry performs no destructive mutation', async () => {
    const adapter = fakeAdapter(completedState);
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW + 1 });
    assert.equal(report.status, 'complete');
    assert.deepEqual(adapter.calls.map(call => call[0]), ['audit']);
  });
  await t.test('mismatched completed result is denied', async () => {
    const adapter = fakeAdapter(auditState({
      ...completedState,
      auditEvent: { ...completeEvent, result: 'different' }
    }));
    const report = await runTeacherPurge({ adapter, options: applyOptions(), nowMs: NOW + 1 });
    assert.equal(report.status, 'refused');
    assert.equal(adapter.calls.some(call => call[0] === 'purgeFirestore'), false);
  });
});

test('main validates and reserves output before Admin initialization, never overwrites, and publishes stdout failures', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-teacher-'));
  const env = {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
  };
  await t.test('wrong target before initialize', async () => {
    let initialized = 0;
    await assert.rejects(main([
      '--project', 'real-project', '--environment', 'emulator', '--uid', 'teacher-a',
      '--output', path.join(directory, 'wrong.json')
    ], { environment: env, initialize: async () => { initialized += 1; } }), /demo-/i);
    assert.equal(initialized, 0);
  });
  await t.test('existing report before initialize', async () => {
    const output = path.join(directory, 'existing.json');
    fs.writeFileSync(output, 'do-not-overwrite');
    let initialized = 0;
    await assert.rejects(main([
      '--project', 'demo-video-quiz', '--environment', 'emulator', '--uid', 'teacher-a',
      '--output', output
    ], {
      environment: env, reserveReport,
      initialize: async () => { initialized += 1; }
    }), /already exists/i);
    assert.equal(initialized, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), 'do-not-overwrite');
  });
  await t.test('stdout issue publishes cumulative failure', async () => {
    const output = path.join(directory, 'stdout.json');
    await assert.rejects(main([
      '--project', 'demo-video-quiz', '--environment', 'emulator', '--uid', 'teacher-a',
      '--output', output
    ], {
      environment: env, reserveReport, now: () => new Date(NOW).toISOString(),
      initialize: async () => fakeAdapter(),
      writeLine() { throw new Error('stdout unavailable'); }
    }), /stdout unavailable/);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.match(report.error, /stdout unavailable/);
    assert.equal(report.safeToPurge, false);
  });
  await t.test('report publication failure retries from completed audit without destructive mutation', async () => {
    const adapter = fakeAdapter();
    const baseArgs = [
      '--project', 'demo-video-quiz', '--environment', 'emulator', '--uid', 'teacher-a',
      '--mode', 'apply', '--confirm-project', 'demo-video-quiz', '--confirm-uid', 'teacher-a'
    ];
    await assert.rejects(main([
      ...baseArgs, '--output', path.join(directory, 'publish-failed.json')
    ], {
      environment: env,
      now: () => new Date(NOW).toISOString(),
      reserveReport() {
        return {
          failClosedPath: path.join(directory, 'publish-failed.json.reserved'),
          commit() { throw new Error('report publication failed'); }
        };
      },
      initialize: async () => adapter,
      writeLine() {}
    }), /report publication failed/);
    const destructiveCalls = adapter.calls.filter(call =>
      ['purgeFirestore', 'deleteAuthUser'].includes(call[0])).length;

    const code = await main([
      ...baseArgs, '--output', path.join(directory, 'publish-retry.json')
    ], {
      environment: env,
      reserveReport,
      now: () => new Date(NOW + 1).toISOString(),
      initialize: async () => adapter,
      writeLine() {}
    });
    assert.equal(code, 0);
    assert.equal(adapter.calls.filter(call =>
      ['purgeFirestore', 'deleteAuthUser'].includes(call[0])).length, destructiveCalls);
  });
});
