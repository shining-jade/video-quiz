#!/usr/bin/env node

const crypto = require('node:crypto');
const deletionCore = require('../teacher-deletion-core.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function parseCliArgs(argv) {
  const result = {
    projectId: '', environment: '', mode: 'dry-run', uid: '', output: '',
    confirmProject: '', confirmUid: ''
  };
  const flags = new Map([
    ['--project', 'projectId'], ['--environment', 'environment'], ['--mode', 'mode'],
    ['--uid', 'uid'], ['--output', 'output'], ['--confirm-project', 'confirmProject'],
    ['--confirm-uid', 'confirmUid']
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const field = flags.get(flag);
    if (!field) throw new Error('Unknown argument: ' + flag);
    if (seen.has(flag)) throw new Error('Duplicate argument: ' + flag);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value.');
    result[field] = value;
    seen.add(flag);
    index += 1;
  }
  for (const [field, flag] of [
    ['projectId', '--project'], ['environment', '--environment'],
    ['uid', '--uid'], ['output', '--output']
  ]) {
    if (!result[field]) throw new Error(flag + ' is required.');
  }
  if (!['emulator', 'production'].includes(result.environment)) {
    throw new Error('--environment must be emulator or production.');
  }
  if (!['dry-run', 'apply'].includes(result.mode)) {
    throw new Error('--mode must be dry-run or apply.');
  }
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(result.uid)) throw new Error('--uid is malformed.');
  if (result.mode === 'apply') {
    if (!result.confirmProject) throw new Error('apply requires --confirm-project.');
    if (!result.confirmUid) throw new Error('apply requires --confirm-uid.');
    if (result.confirmProject !== result.projectId) throw new Error('--confirm-project does not match --project.');
    if (result.confirmUid !== result.uid) throw new Error('--confirm-uid does not match --uid.');
  } else if (result.confirmProject || result.confirmUid) {
    throw new Error('confirmation flags are only valid in apply mode.');
  }
  return result;
}

function validateTarget(options, environment) {
  const env = environment || {};
  const firestoreHost = String(env.FIRESTORE_EMULATOR_HOST || '');
  const authHost = String(env.FIREBASE_AUTH_EMULATOR_HOST || '');
  const expectedFirestore = /^(127\.0\.0\.1|localhost):8080$/;
  const expectedAuth = /^(127\.0\.0\.1|localhost):9099$/;
  if (options.environment === 'emulator') {
    if (!/^demo-[a-z0-9-]+$/.test(options.projectId)) {
      throw new Error('emulator mode requires a demo-* project ID.');
    }
    if (!expectedFirestore.test(firestoreHost) || !expectedAuth.test(authHost)) {
      throw new Error('emulator mode requires exact local Firestore :8080 and Auth :9099 hosts.');
    }
  } else {
    if (/^demo-/.test(options.projectId)) throw new Error('production mode refuses demo-* projects.');
    if (firestoreHost || authHost) throw new Error('production mode refuses emulator environment variables.');
  }
  return options.environment;
}

function eventId(uid) {
  return 'teacher-purge-' + crypto.createHash('sha256').update(uid).digest('hex').slice(0, 32);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function stateFingerprint(state) {
  const allowance = state && state.allowance;
  return JSON.stringify(stable({
    allowance: allowance && {
      uid: allowance.uid, emailCanonical: allowance.emailCanonical, role: allowance.role,
      status: allowance.status, enabled: allowance.enabled,
      administrativeHold: allowance.administrativeHold, revision: allowance.revision,
      deletionRequestedAtMs: allowance.deletionRequestedAtMs,
      purgeEligibleAtMs: allowance.purgeEligibleAtMs
    },
    requestExists: !!(state && state.requestExists),
    profileExists: !!(state && state.profileExists),
    legacyAllowanceExists: !!(state && state.legacyAllowanceExists),
    ownedSetIds: [...(state && state.ownedSetIds || [])].sort(),
    blockingSessionIds: [...(state && state.blockingSessionIds || [])].sort(),
    authUserExists: !!(state && state.authUserExists),
    auditEvent: state && state.auditEvent || null
  }));
}

function safeError(error) {
  return String(error && error.message || error)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(0, 1000);
}

function publicAudit(state, eligibility) {
  return {
    eligible: eligibility.eligible,
    blockers: [...eligibility.blockers],
    ownedSetCount: Array.isArray(state.ownedSetIds) ? state.ownedSetIds.length : null,
    blockingSessionCount: Array.isArray(state.blockingSessionIds) ? state.blockingSessionIds.length : null,
    revision: eligibility.revision,
    deletionRequestedAtMs: eligibility.deletionRequestedAtMs,
    purgeEligibleAtMs: eligibility.purgeEligibleAtMs,
    remainingMs: eligibility.remainingMs,
    requestExists: !!state.requestExists,
    profileExists: !!state.profileExists,
    allowanceExists: !!state.allowance,
    legacyAllowanceExists: !!state.legacyAllowanceExists,
    authUserExists: !!state.authUserExists,
    auditEventStatus: state.auditEvent && state.auditEvent.status || null
  };
}

function remainingState(state) {
  return {
    allowanceExists: !!(state && state.allowance),
    requestExists: !!(state && state.requestExists),
    profileExists: !!(state && state.profileExists),
    legacyAllowanceExists: !!(state && state.legacyAllowanceExists),
    ownedSetCount: Array.isArray(state && state.ownedSetIds) ? state.ownedSetIds.length : null,
    blockingSessionCount: Array.isArray(state && state.blockingSessionIds) ? state.blockingSessionIds.length : null,
    authUserExists: state && typeof state.authUserExists === 'boolean' ? state.authUserExists : null,
    auditEventStatus: state && state.auditEvent && state.auditEvent.status || null
  };
}

function baseReport(options, nowMs) {
  return {
    tool: 'purge-teacher-account', schemaVersion: 1,
    projectId: options.projectId, environment: options.environment,
    mode: options.mode, targetUid: options.uid,
    generatedAt: new Date(nowMs).toISOString(), status: 'failed', safeToPurge: false,
    stages: []
  };
}

async function auditAfterAmbiguity(adapter, uid, identity) {
  try {
    return await adapter.audit(uid, identity);
  } catch (_) {
    return null;
  }
}

function exactRecoveryEvent(event, options, requiredStatus) {
  const opId = eventId(options.uid);
  return !!event && event.eventId === opId && event.operationId === opId &&
    event.targetUid === options.uid && event.projectId === options.projectId &&
    event.environment === options.environment && event.mode === options.mode &&
    event.status === requiredStatus && event.result === requiredStatus &&
    Number.isSafeInteger(event.allowanceRevision) && event.allowanceRevision > 0 &&
    Number.isSafeInteger(event.deletionRequestedAtMs) &&
    Number.isSafeInteger(event.purgeEligibleAtMs) &&
    event.purgeEligibleAtMs === event.deletionRequestedAtMs + deletionCore.DAYS_30_MS &&
    Number.isSafeInteger(event.proofAtMs) && event.proofAtMs >= event.purgeEligibleAtMs;
}

function cleanFirestoreState(state) {
  return !!state && !state.allowance && !state.requestExists && !state.profileExists &&
    !state.legacyAllowanceExists && Array.isArray(state.ownedSetIds) &&
    state.ownedSetIds.length === 0 && Array.isArray(state.blockingSessionIds) &&
    state.blockingSessionIds.length === 0;
}

function validServerTimeProof(proof, expected) {
  return !!proof && proof.opId === expected.opId && proof.targetUid === expected.uid &&
    proof.projectId === expected.projectId && proof.environment === expected.environment &&
    proof.mode === expected.mode && proof.allowanceRevision === expected.revision &&
    proof.deletionRequestedAtMs === expected.deletionRequestedAtMs &&
    proof.purgeEligibleAtMs === expected.purgeEligibleAtMs &&
    Number.isSafeInteger(proof.proofAtMs) && Number.isSafeInteger(proof.updateTimeMs) &&
    proof.proofAtMs === proof.updateTimeMs;
}

async function cleanupProof(adapter, report, proof) {
  if (!proof || typeof adapter.cleanupServerTimeProof !== 'function') return;
  try {
    await adapter.cleanupServerTimeProof(proof);
    report.stages.push({ name: 'server-time-proof-cleanup', status: 'complete' });
  } catch (error) {
    report.stages.push({ name: 'server-time-proof-cleanup', status: 'ambiguous' });
    report.proofCleanupError = safeError(error);
  }
}

async function runTeacherPurge({ adapter, options, nowMs }) {
  const report = baseReport(options, nowMs);
  let initial;
  try {
    initial = await adapter.audit(options.uid);
    report.stages.push({ name: 'initial-audit', status: 'complete' });
  } catch (error) {
    report.stages.push({ name: 'initial-audit', status: 'ambiguous' });
    report.error = safeError(error);
    report.remaining = remainingState(null);
    return report;
  }

  const completeRetry = cleanFirestoreState(initial) && initial.authUserExists === false &&
    exactRecoveryEvent(initial.auditEvent, options, 'complete');
  if (completeRetry) {
    report.status = 'complete';
    report.safeToPurge = true;
    report.stages.push({ name: 'completed-audit-retry', status: 'recovered' });
    report.remaining = remainingState(initial);
    return report;
  }
  if (initial.auditEvent && initial.auditEvent.status === 'complete') {
    report.status = 'refused';
    report.error = 'Completed audit event does not match the exact UID, operation, and result.';
    report.stages.push({ name: 'completed-audit-retry', status: 'mismatch' });
    report.remaining = remainingState(initial);
    return report;
  }

  const recoveredFirestore = cleanFirestoreState(initial) &&
    exactRecoveryEvent(initial.auditEvent, options, 'firestore_purged');

  let eligibility;
  let expected;
  if (recoveredFirestore) {
    eligibility = {
      eligible: true, blockers: [], ownedSetCount: 0, blockingSessionCount: 0,
      revision: initial.auditEvent.allowanceRevision,
      deletionRequestedAtMs: initial.auditEvent.deletionRequestedAtMs,
      purgeEligibleAtMs: initial.auditEvent.purgeEligibleAtMs, remainingMs: 0,
      uid: options.uid
    };
    expected = {
      uid: options.uid, revision: initial.auditEvent.allowanceRevision,
      deletionRequestedAtMs: initial.auditEvent.deletionRequestedAtMs,
      purgeEligibleAtMs: initial.auditEvent.purgeEligibleAtMs,
      proofAtMs: initial.auditEvent.proofAtMs,
      opId: eventId(options.uid), eventId: eventId(options.uid),
      projectId: options.projectId, environment: options.environment, mode: options.mode
    };
  } else {
    const structuralEligibility = deletionCore.auditEligibility({
      allowance: initial.allowance,
      ownedSetCount: Array.isArray(initial.ownedSetIds) ? initial.ownedSetIds.length : -1,
      blockingSessionCount: Array.isArray(initial.blockingSessionIds)
        ? initial.blockingSessionIds.length : -1
    }, initial.allowance && initial.allowance.purgeEligibleAtMs);
    if (structuralEligibility.blockers.includes('invalid_state') ||
        structuralEligibility.uid !== options.uid) {
      const refusedEligibility = structuralEligibility.uid === options.uid
        ? structuralEligibility
        : deletionCore.auditEligibility({
          allowance: null,
          ownedSetCount: Array.isArray(initial.ownedSetIds) ? initial.ownedSetIds.length : -1,
          blockingSessionCount: Array.isArray(initial.blockingSessionIds)
            ? initial.blockingSessionIds.length : -1
        }, initial.allowance && initial.allowance.purgeEligibleAtMs);
      report.audit = publicAudit(initial, refusedEligibility);
      report.status = 'refused';
      report.stages.push({
        name: 'eligibility', status: 'refused', blockers: [...refusedEligibility.blockers]
      });
      report.remaining = remainingState(initial);
      return report;
    }
    expected = initial.allowance && {
      uid: options.uid, emailCanonical: initial.allowance.emailCanonical,
      revision: initial.allowance.revision,
      deletionRequestedAtMs: initial.allowance.deletionRequestedAtMs,
      purgeEligibleAtMs: initial.allowance.purgeEligibleAtMs,
      opId: eventId(options.uid), eventId: eventId(options.uid),
      projectId: options.projectId, environment: options.environment, mode: options.mode
    };
    let proof = null;
    try {
      if (!expected || typeof adapter.createServerTimeProof !== 'function') {
        throw new Error('Exact server-time proof adapter is unavailable.');
      }
      proof = await adapter.createServerTimeProof(expected);
      report.stages.push({ name: 'server-time-proof', status: 'complete' });
      if (!validServerTimeProof(proof, expected)) throw new Error('Server-time proof identity is forged or stale.');
      expected.proofAtMs = proof.proofAtMs;
    } catch (error) {
      report.stages.push({ name: 'server-time-proof', status: 'failed' });
      report.error = safeError(error);
      await cleanupProof(adapter, report, proof && expected
        ? { ...expected, proofAtMs: proof.proofAtMs } : null);
      report.remaining = remainingState(initial);
      return report;
    }
    eligibility = deletionCore.auditEligibility({
      allowance: initial.allowance,
      ownedSetCount: Array.isArray(initial.ownedSetIds) ? initial.ownedSetIds.length : -1,
      blockingSessionCount: Array.isArray(initial.blockingSessionIds)
        ? initial.blockingSessionIds.length : -1
    }, proof.proofAtMs);
    if (eligibility.uid !== options.uid) {
      eligibility = deletionCore.auditEligibility({
        allowance: null,
        ownedSetCount: Array.isArray(initial.ownedSetIds) ? initial.ownedSetIds.length : -1,
        blockingSessionCount: Array.isArray(initial.blockingSessionIds)
          ? initial.blockingSessionIds.length : -1
      }, proof.proofAtMs);
    }
    report.audit = publicAudit(initial, eligibility);
    if (!eligibility.eligible) {
      report.status = 'refused';
      report.stages.push({ name: 'eligibility', status: 'refused', blockers: [...eligibility.blockers] });
      await cleanupProof(adapter, report, expected);
      report.remaining = remainingState(initial);
      return report;
    }
    report.stages.push({ name: 'eligibility', status: 'complete' });
    if (options.mode === 'dry-run') {
      report.status = 'dry-run-eligible';
      report.safeToPurge = true;
      await cleanupProof(adapter, report, expected);
      report.remaining = remainingState(initial);
      return report;
    }
  }
  report.audit = publicAudit(initial, eligibility);

  if (!recoveredFirestore) {
    let repeated;
    try {
      repeated = await adapter.audit(options.uid, expected);
    } catch (error) {
      report.stages.push({ name: 'authoritative-re-audit', status: 'ambiguous' });
      report.error = safeError(error);
      report.remaining = remainingState(null);
      await cleanupProof(adapter, report, expected);
      return report;
    }
    if (stateFingerprint(initial) !== stateFingerprint(repeated)) {
      report.stages.push({ name: 'authoritative-re-audit', status: 'changed' });
      report.error = 'Authoritative re-audit changed before mutation.';
      report.remaining = remainingState(repeated);
      await cleanupProof(adapter, report, expected);
      return report;
    }
    report.stages.push({ name: 'authoritative-re-audit', status: 'complete' });
    try {
      await adapter.purgeFirestore(expected);
      report.stages.push({ name: 'firestore-transaction', status: 'complete' });
    } catch (error) {
      const observed = await auditAfterAmbiguity(adapter, options.uid, expected);
      report.stages.push({ name: 'firestore-transaction', status: 'ambiguous' });
      report.error = safeError(error);
      report.remaining = remainingState(observed);
      await cleanupProof(adapter, report, expected);
      return report;
    }
  } else {
    report.stages.push({ name: 'firestore-transaction', status: 'recovered' });
  }

  if (initial.authUserExists) {
    try {
      await adapter.deleteAuthUser(options.uid);
      report.stages.push({ name: 'firebase-auth-delete', status: 'complete' });
    } catch (error) {
      const observed = await auditAfterAmbiguity(adapter, options.uid, expected);
      report.stages.push({ name: 'firebase-auth-delete', status: 'ambiguous' });
      report.error = safeError(error);
      report.remaining = remainingState(observed);
      return report;
    }
  } else {
    report.stages.push({ name: 'firebase-auth-delete', status: 'already-absent' });
  }

  try {
    await adapter.completeAuditEvent(expected);
    report.stages.push({ name: 'audit-event-complete', status: 'complete' });
  } catch (error) {
    const observed = await auditAfterAmbiguity(adapter, options.uid, expected);
    report.stages.push({ name: 'audit-event-complete', status: 'ambiguous' });
    report.error = safeError(error);
    report.remaining = remainingState(observed);
    return report;
  }

  let finalState;
  try {
    finalState = await adapter.audit(options.uid, expected);
  } catch (error) {
    report.stages.push({ name: 'final-audit', status: 'ambiguous' });
    report.error = safeError(error);
    report.remaining = remainingState(null);
    return report;
  }
  const remaining = remainingState(finalState);
  report.remaining = remaining;
  const clean = remaining.allowanceExists === false && remaining.requestExists === false &&
    remaining.profileExists === false && remaining.legacyAllowanceExists === false &&
    remaining.ownedSetCount === 0 && remaining.blockingSessionCount === 0 &&
    remaining.authUserExists === false && remaining.auditEventStatus === 'complete';
  if (!clean) {
    report.stages.push({ name: 'final-audit', status: 'failed' });
    report.error = 'Final authoritative audit found remaining state.';
    return report;
  }
  report.stages.push({ name: 'final-audit', status: 'complete' });
  report.status = 'complete';
  report.safeToPurge = true;
  return report;
}

function normalizeAllowance(snapshot) {
  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  return {
    ...data,
    deletionRequestedAtMs: deletionCore.timestampMillis(data.deletionRequestedAt),
    purgeEligibleAtMs: deletionCore.timestampMillis(data.purgeEligibleAt)
  };
}

function productionDependencies() {
  const { applicationDefault, initializeApp } = require('firebase-admin/app');
  const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  return {
    environment: process.env,
    reserveReport,
    now: () => new Date().toISOString(),
    writeLine: line => process.stdout.write(line + '\n'),
    async initialize(projectId) {
      const app = initializeApp({ credential: applicationDefault(), projectId });
      const db = getFirestore(app);
      const auth = getAuth(app);
      const auditRef = uid => db.doc('teacher_account_audits/' + eventId(uid));
      const proofRef = uid => db.doc('teacher_purge_operations/' + eventId(uid));
      return {
        async audit(uid, identity) {
          const allowanceRef = db.doc('teacher_allowances/' + uid);
          const [allowanceSnap, requestSnap, profileSnap, eventSnap, setsSnap, sessionsSnap] = await Promise.all([
            allowanceRef.get(), db.doc('teacher_access_requests/' + uid).get(),
            db.doc('teacher_profiles/' + uid).get(), auditRef(uid).get(),
            db.collection('quiz_sets').where('ownerUid', '==', uid).get(),
            db.collection('sessions').where('teacherUid', '==', uid)
              .where('status', 'in', ['allocating', 'active', 'live']).get()
          ]);
          const allowance = normalizeAllowance(allowanceSnap);
          const email = allowance && allowance.emailCanonical || identity && identity.emailCanonical;
          const legacySnap = email ? await db.doc('teacher_allowlist/' + email).get() : null;
          let authUserExists = true;
          try { await auth.getUser(uid); } catch (error) {
            if (error && error.code === 'auth/user-not-found') authUserExists = false;
            else throw error;
          }
          const rawEvent = eventSnap.exists ? eventSnap.data() : null;
          const auditEvent = rawEvent && {
            eventId: eventSnap.id, type: rawEvent.type, targetUid: rawEvent.targetUid,
            allowanceRevision: rawEvent.allowanceRevision,
            deletionRequestedAtMs: deletionCore.timestampMillis(rawEvent.deletionRequestedAt),
            purgeEligibleAtMs: deletionCore.timestampMillis(rawEvent.purgeEligibleAt),
            proofAtMs: deletionCore.timestampMillis(rawEvent.proofAt),
            operationId: rawEvent.operationId, projectId: rawEvent.projectId,
            environment: rawEvent.environment, mode: rawEvent.mode,
            status: rawEvent.status, result: rawEvent.result
          };
          return {
            allowance, requestExists: requestSnap.exists, profileExists: profileSnap.exists,
            legacyAllowanceExists: legacySnap ? legacySnap.exists : false,
            ownedSetIds: setsSnap.docs.map(doc => doc.id),
            blockingSessionIds: sessionsSnap.docs.map(doc => doc.id),
            authUserExists, auditEvent
          };
        },
        async createServerTimeProof(expected) {
          const ref = proofRef(expected.uid);
          await ref.set({
            opId: expected.opId,
            targetUid: expected.uid,
            projectId: expected.projectId,
            environment: expected.environment,
            mode: expected.mode,
            allowanceRevision: expected.revision,
            deletionRequestedAt: Timestamp.fromMillis(expected.deletionRequestedAtMs),
            purgeEligibleAt: Timestamp.fromMillis(expected.purgeEligibleAtMs),
            proofAt: FieldValue.serverTimestamp()
          });
          const snapshot = await ref.get();
          const data = snapshot.exists ? snapshot.data() || {} : {};
          return {
            opId: data.opId,
            targetUid: data.targetUid,
            projectId: data.projectId,
            environment: data.environment,
            mode: data.mode,
            allowanceRevision: data.allowanceRevision,
            deletionRequestedAtMs: deletionCore.timestampMillis(data.deletionRequestedAt),
            purgeEligibleAtMs: deletionCore.timestampMillis(data.purgeEligibleAt),
            proofAtMs: deletionCore.timestampMillis(data.proofAt),
            updateTimeMs: deletionCore.timestampMillis(snapshot.updateTime)
          };
        },
        async cleanupServerTimeProof(expected) {
          const ref = proofRef(expected.uid || expected.targetUid);
          await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) return;
            const data = snapshot.data() || {};
            if (data.opId !== expected.opId || data.targetUid !== (expected.uid || expected.targetUid) ||
                data.projectId !== expected.projectId || data.environment !== expected.environment ||
                data.mode !== expected.mode || data.allowanceRevision !== expected.revision ||
                deletionCore.timestampMillis(data.proofAt) !== expected.proofAtMs) {
              throw new Error('Server-time proof changed before cleanup.');
            }
            transaction.delete(ref);
          });
        },
        async purgeFirestore(expected) {
          const allowanceRef = db.doc('teacher_allowances/' + expected.uid);
          const requestRef = db.doc('teacher_access_requests/' + expected.uid);
          const profileRef = db.doc('teacher_profiles/' + expected.uid);
          const legacyRef = db.doc('teacher_allowlist/' + expected.emailCanonical);
          const eventRef = auditRef(expected.uid);
          const operationRef = proofRef(expected.uid);
          await db.runTransaction(async transaction => {
            const [allowanceSnap, requestSnap, profileSnap, legacySnap, eventSnap, operationSnap, setsSnap, sessionsSnap] = await Promise.all([
              transaction.get(allowanceRef), transaction.get(requestRef), transaction.get(profileRef),
              transaction.get(legacyRef), transaction.get(eventRef), transaction.get(operationRef),
              transaction.get(db.collection('quiz_sets').where('ownerUid', '==', expected.uid).limit(1)),
              transaction.get(db.collection('sessions').where('teacherUid', '==', expected.uid)
                .where('status', 'in', ['allocating', 'active', 'live']).limit(1))
            ]);
            const allowance = normalizeAllowance(allowanceSnap);
            const operation = operationSnap.exists ? operationSnap.data() || {} : null;
            const operationProofAtMs = operation && deletionCore.timestampMillis(operation.proofAt);
            if (!allowance || allowance.uid !== expected.uid ||
                allowance.emailCanonical !== expected.emailCanonical ||
                allowance.status !== 'deletion_pending' || allowance.enabled !== false ||
                allowance.role !== 'teacher' || allowance.revision !== expected.revision ||
                allowance.deletionRequestedAtMs !== expected.deletionRequestedAtMs ||
                allowance.purgeEligibleAtMs !== expected.purgeEligibleAtMs ||
                !operation || operation.opId !== expected.opId ||
                operation.targetUid !== expected.uid || operation.projectId !== expected.projectId ||
                operation.environment !== expected.environment || operation.mode !== expected.mode ||
                operation.allowanceRevision !== expected.revision ||
                deletionCore.timestampMillis(operation.deletionRequestedAt) !== expected.deletionRequestedAtMs ||
                deletionCore.timestampMillis(operation.purgeEligibleAt) !== expected.purgeEligibleAtMs ||
                operationProofAtMs !== expected.proofAtMs || operationProofAtMs < expected.purgeEligibleAtMs ||
                !setsSnap.empty || !sessionsSnap.empty || eventSnap.exists) {
              throw new Error('Authoritative Firestore transaction re-read changed.');
            }
            if (requestSnap.exists && requestSnap.data().uid !== expected.uid) {
              throw new Error('Teacher request identity mismatch.');
            }
            transaction.delete(allowanceRef);
            if (requestSnap.exists) transaction.delete(requestRef);
            if (profileSnap.exists) transaction.delete(profileRef);
            if (legacySnap.exists) transaction.delete(legacyRef);
            transaction.delete(operationRef);
            transaction.create(eventRef, {
              type: 'teacher_account_purged', targetUid: expected.uid,
              operationId: expected.opId, projectId: expected.projectId,
              environment: expected.environment, mode: expected.mode,
              allowanceRevision: expected.revision,
              deletionRequestedAt: Timestamp.fromMillis(expected.deletionRequestedAtMs),
              purgeEligibleAt: Timestamp.fromMillis(expected.purgeEligibleAtMs),
              proofAt: Timestamp.fromMillis(expected.proofAtMs),
              status: 'firestore_purged', result: 'firestore_purged',
              firestorePurgedAt: FieldValue.serverTimestamp(),
              actor: 'admin-cli'
            });
          });
        },
        async deleteAuthUser(uid) {
          try { await auth.deleteUser(uid); } catch (error) {
            if (!error || error.code !== 'auth/user-not-found') throw error;
          }
        },
        async completeAuditEvent(expected) {
          await db.runTransaction(async transaction => {
            const ref = auditRef(expected.uid);
            const snapshot = await transaction.get(ref);
            const data = snapshot.exists ? snapshot.data() : null;
            if (!data || data.targetUid !== expected.uid ||
                data.operationId !== expected.opId || data.projectId !== expected.projectId ||
                data.environment !== expected.environment || data.mode !== expected.mode ||
                data.allowanceRevision !== expected.revision ||
                deletionCore.timestampMillis(data.proofAt) !== expected.proofAtMs) {
              throw new Error('Purge audit event changed before completion.');
            }
            if (data.status === 'complete' && data.result === 'complete') return;
            if (data.status !== 'firestore_purged' || data.result !== 'firestore_purged') {
              throw new Error('Purge audit event result changed before completion.');
            }
            transaction.update(ref, {
              status: 'complete', result: 'complete', authDeletedAt: FieldValue.serverTimestamp(),
              completedAt: FieldValue.serverTimestamp()
            });
          });
        }
      };
    }
  };
}

async function main(argv, dependencies) {
  const options = parseCliArgs(argv);
  const runtime = dependencies || productionDependencies();
  validateTarget(options, runtime.environment || process.env);
  const nowIso = (runtime.now || (() => new Date().toISOString()))();
  const nowMs = Date.parse(nowIso);
  if (!Number.isSafeInteger(nowMs)) throw new Error('Runtime clock is invalid.');
  const placeholder = {
    tool: 'purge-teacher-account', schemaVersion: 1, projectId: options.projectId,
    environment: options.environment, mode: options.mode, targetUid: options.uid,
    generatedAt: nowIso, status: 'reserved-fail-closed', safeToPurge: false, stages: []
  };
  const reservation = (runtime.reserveReport || reserveReport)(
    options.output, JSON.stringify(placeholder, null, 2) + '\n'
  );
  let report;
  try {
    const adapter = await runtime.initialize(options.projectId);
    report = await runTeacherPurge({ adapter, options, nowMs });
    (runtime.writeLine || (line => process.stdout.write(line + '\n')))([
      'mode=' + options.mode, 'project=' + options.projectId,
      'environment=' + options.environment, 'uid=' + options.uid,
      'status=' + report.status, 'report=' + options.output
    ].join(' '));
  } catch (error) {
    report = report || baseReport(options, nowMs);
    report.status = 'failed';
    report.safeToPurge = false;
    report.error = safeError(error);
    report.stages.push({ name: report.stages.length ? 'stdout' : 'initialize', status: 'failed' });
    try {
      reservation.commit(JSON.stringify(report, null, 2) + '\n');
    } catch (publicationError) {
      throw new Error(safeError(error) + '; fail-closed report remains at ' +
        reservation.failClosedPath + '; publication error: ' + safeError(publicationError));
    }
    throw error;
  }
  reservation.commit(JSON.stringify(report, null, 2) + '\n');
  return report.status === 'complete' || report.status === 'dry-run-eligible' ? 0 : 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write('Teacher purge failed: ' + safeError(error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  parseCliArgs, validateTarget, eventId, runTeacherPurge,
  productionDependencies, main
};
