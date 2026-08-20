'use strict';

const ACTIVE_STATUSES = new Set(['allocating', 'active', 'live']);
const GATE_PATH = 'migration_gates/session_counters';
const LOCK_PATH = 'migration_gates/session_counter_migration';
const GATE_KEYS = [
  'complete', 'projectId', 'environment', 'rulesVersion',
  'preflightNonEndedLegacyCount', 'verifiedAt', 'updatedAt', 'completedByUid'
].sort();

function validUid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

function exactTimestamp(value) {
  if (!value || typeof value !== 'object' || typeof value.toMillis !== 'function') return null;
  try {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? { value, millis } : null;
  } catch (_) {
    return null;
  }
}

function sameTimestamp(left, right) {
  const a = exactTimestamp(left);
  const b = exactTimestamp(right);
  if (!a || !b || a.millis !== b.millis) return false;
  if (typeof left.isEqual === 'function' && typeof right.isEqual === 'function') {
    try { return left.isEqual(right) === true && right.isEqual(left) === true; } catch (_) { return false; }
  }
  return true;
}

function updateTimeGeneration(snapshot) {
  const value = snapshot && snapshot.updateTime;
  if (!value || !Number.isInteger(value.seconds) || !Number.isInteger(value.nanoseconds)) {
    throw new Error('Session counter gate is missing an authoritative updateTime generation.');
  }
  return String(value.seconds) + ':' + String(value.nanoseconds);
}

function verifyMigrationLockSnapshot(snapshot, expected, expectedGeneration) {
  if (!snapshot || !snapshot.exists) throw new Error('Session counter migration lock is missing.');
  const data = snapshot.data() || {};
  if (data.locked !== true || data.lockToken !== expected.lockToken ||
      data.projectId !== expected.projectId || data.targetMode !== expected.targetMode ||
      data.lockedByUid !== expected.adminUid || !exactTimestamp(data.lockedAt)) {
    throw new Error('Session counter migration lock token or target identity is invalid.');
  }
  const evidence = {
    path: LOCK_PATH, locked: true, lockToken: data.lockToken,
    projectId: data.projectId, targetMode: data.targetMode,
    updateTimeGeneration: updateTimeGeneration(snapshot)
  };
  if (expectedGeneration && evidence.updateTimeGeneration !== expectedGeneration) {
    throw new Error('Session counter migration lock generation changed after audit.');
  }
  return evidence;
}

async function acquireSessionCounterMigrationLock({
  db, projectId, targetMode, adminUid, lockToken, serverTimestamp
}) {
  const ref = db.doc(LOCK_PATH);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists && snapshot.data().locked === true) {
      verifyMigrationLockSnapshot(snapshot, { projectId, targetMode, adminUid, lockToken });
      return;
    }
    transaction.set(ref, {
      locked: true, lockToken, projectId, targetMode,
      lockedAt: serverTimestamp(), lockedByUid: adminUid
    });
  });
  return verifyMigrationLockSnapshot(await ref.get(), {
    projectId, targetMode, adminUid, lockToken
  });
}

async function verifySessionCounterMigrationLock({
  db, projectId, targetMode, adminUid, lockToken, expectedGeneration
}) {
  return verifyMigrationLockSnapshot(await db.doc(LOCK_PATH).get(), {
    projectId, targetMode, adminUid, lockToken
  }, expectedGeneration);
}

async function unlockSessionCounterMigrationLock({
  db, projectId, targetMode, adminUid, lockToken, expectedGeneration, serverTimestamp
}) {
  if (!lockToken || !expectedGeneration) throw new Error('Exact lock token and generation are required.');
  const ref = db.doc(LOCK_PATH);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    verifyMigrationLockSnapshot(snapshot, {
      projectId, targetMode, adminUid, lockToken
    }, expectedGeneration);
    transaction.set(ref, {
      ...snapshot.data(), locked: false,
      unlockedAt: serverTimestamp(), unlockedByUid: adminUid
    });
  });
  const snapshot = await ref.get();
  const data = snapshot.data() || {};
  if (data.locked !== false || data.lockToken !== lockToken || data.projectId !== projectId ||
      data.targetMode !== targetMode || data.unlockedByUid !== adminUid ||
      !exactTimestamp(data.unlockedAt)) throw new Error('Session counter migration unlock readback failed.');
  return { ...data, path: LOCK_PATH, updateTimeGeneration: updateTimeGeneration(snapshot) };
}

function verifyGateSnapshot(snapshot, { projectId, targetMode }, expectedGeneration) {
  if (!snapshot || !snapshot.exists) throw new Error('Session counter gate is missing.');
  const data = snapshot.data() || {};
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(GATE_KEYS)) {
    throw new Error('Session counter gate shape is invalid.');
  }
  if (data.complete !== true || data.projectId !== projectId) {
    throw new Error('Session counter gate project identity is invalid.');
  }
  if (data.environment !== targetMode) throw new Error('Session counter gate target mode is invalid.');
  if (data.rulesVersion !== 'session-counters-v1' || data.preflightNonEndedLegacyCount !== 0) {
    throw new Error('Session counter gate preflight is invalid.');
  }
  if (!sameTimestamp(data.verifiedAt, data.updatedAt) || !validUid(data.completedByUid)) {
    throw new Error('Session counter gate Timestamp or administrator identity is invalid.');
  }
  const evidence = {
    path: GATE_PATH, created: true, complete: true,
    projectId: data.projectId, targetMode: data.environment,
    rulesVersion: data.rulesVersion,
    updateTimeGeneration: updateTimeGeneration(snapshot)
  };
  if (expectedGeneration && evidence.updateTimeGeneration !== expectedGeneration) {
    throw new Error('Session counter gate generation changed after readback.');
  }
  return evidence;
}

function inspectSession(sessionId, data, studentDocuments) {
  const studentIds = [];
  const invalidStudents = [];
  for (const document of studentDocuments || []) {
    const studentId = String(document.id || '');
    const student = document.data() || {};
    if (!validUid(studentId) || student.uid !== studentId) invalidStudents.push(studentId);
    else studentIds.push(studentId);
  }
  studentIds.sort();
  const actualCount = studentIds.length;
  const hasCount = Object.prototype.hasOwnProperty.call(data, 'registeredStudentCount');
  const hasRevision = Object.prototype.hasOwnProperty.call(data, 'studentCountRevision');
  const hasLast = Object.prototype.hasOwnProperty.call(data, 'lastStudentUid');
  let issue = '';
  if (invalidStudents.length) issue = 'invalid-student-identity';
  else if (!hasCount && !hasRevision && !hasLast) issue = 'missing-counter';
  else if (!hasCount || !hasRevision ||
      !Number.isSafeInteger(data.registeredStudentCount) || data.registeredStudentCount < 0 ||
      data.studentCountRevision !== data.registeredStudentCount ||
      (data.registeredStudentCount === 0 ? hasLast :
        !validUid(data.lastStudentUid) || !studentIds.includes(data.lastStudentUid))) {
    issue = 'invalid-counter';
  } else if (data.registeredStudentCount !== actualCount) issue = 'counter-mismatch';
  return {
    sessionId, data, actualCount, studentIds, invalidStudents, issue,
    desiredLastStudentUid: actualCount > 0 ? studentIds.at(-1) : ''
  };
}

function buildAudit(records) {
  const audit = {
    totalNonEndedSessions: records.length,
    missingCounterCount: 0,
    invalidCounterCount: 0,
    counterMismatchCount: 0,
    invalidStudentCount: 0,
    issueSessionIds: [],
    preflightNonEndedLegacyCount: 0,
    safe: false
  };
  for (const record of records) {
    if (record.issue === 'missing-counter') audit.missingCounterCount += 1;
    else if (record.issue === 'invalid-counter') audit.invalidCounterCount += 1;
    else if (record.issue === 'counter-mismatch') audit.counterMismatchCount += 1;
    if (record.invalidStudents.length) audit.invalidStudentCount += record.invalidStudents.length;
    if (record.issue) audit.issueSessionIds.push(record.sessionId);
  }
  audit.preflightNonEndedLegacyCount = audit.issueSessionIds.length;
  audit.safe = audit.preflightNonEndedLegacyCount === 0 && audit.invalidStudentCount === 0;
  return audit;
}

async function scanSessions(db) {
  const snapshot = await db.collection('sessions').get();
  const records = [];
  for (const document of snapshot.docs || []) {
    const data = document.data() || {};
    if (!ACTIVE_STATUSES.has(data.status)) continue;
    const students = await db.collection('sessions/' + document.id + '/students').get();
    records.push(inspectSession(document.id, data, students.docs || []));
  }
  return { records, audit: buildAudit(records) };
}

function reportBase({ projectId, targetMode, apply }) {
  return {
    tool: 'session-counter-migration', schemaVersion: 1,
    operation: 'session-counter-backfill-and-gate', projectId, targetMode,
    mode: apply ? 'apply' : 'dry-run', status: apply ? 'running' : 'complete',
    plannedCount: 0, appliedCount: 0, reclassifiedCount: 0,
    concurrentlySkipped: [], concurrentlySkippedCount: 0,
    lock: { path: LOCK_PATH, locked: false },
    gate: { path: GATE_PATH, created: false },
    safeToDeployStrictRules: false
  };
}

async function runSessionCounterMigration({
  db, projectId, targetMode = 'production', adminUid, apply = false,
  confirmProject = '', serverTimestamp, deleteField, lockToken = ''
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('Admin Firestore DB is required.');
  }
  if (!projectId) throw new Error('projectId is required.');
  if (!['production', 'emulator'].includes(targetMode)) throw new Error('targetMode must be production or emulator.');
  if (!validUid(adminUid)) throw new Error('A bounded --admin-uid is required.');
  if (apply && confirmProject !== projectId) throw new Error('Apply requires an exact project confirmation.');
  if (typeof serverTimestamp !== 'function' || typeof deleteField !== 'function') {
    throw new Error('Firestore serverTimestamp and deleteField sentinels are required.');
  }
  const report = reportBase({ projectId, targetMode, apply });
  try {
    const exactLockToken = lockToken || ['session-counter', projectId, targetMode, adminUid].join(':');
    if (apply) {
      report.lock = await acquireSessionCounterMigrationLock({
        db, projectId, targetMode, adminUid, lockToken: exactLockToken, serverTimestamp
      });
    }
    const gateRef = db.doc(GATE_PATH);
    const existingGate = await gateRef.get();
    if (existingGate.exists) {
      const evidence = verifyGateSnapshot(existingGate, { projectId, targetMode });
      const current = await scanSessions(db);
      report.audit = current.audit;
      report.plannedCount = current.records.filter(record => record.issue &&
        record.issue !== 'invalid-student-identity').length;
      report.gate = evidence;
      report.status = 'complete';
      if (apply) {
        report.lock = await verifySessionCounterMigrationLock({
          db, projectId, targetMode, adminUid, lockToken: exactLockToken,
          expectedGeneration: report.lock.updateTimeGeneration
        });
      }
      report.safeToDeployStrictRules = apply && current.audit.safe && report.lock.locked === true;
      if (apply && !current.audit.safe) {
        throw new Error('Completed session counter gate conflicts with authoritative session audit.');
      }
      return report;
    }
    const initial = await scanSessions(db);
    report.audit = initial.audit;
    const planned = initial.records.filter(record => record.issue &&
      record.issue !== 'invalid-student-identity');
    report.plannedCount = planned.length;
    if (!apply) return report;
    for (const item of planned) {
      const result = await db.runTransaction(async transaction => {
        const lockSnapshot = await transaction.get(db.doc(LOCK_PATH));
        verifyMigrationLockSnapshot(lockSnapshot, {
          projectId, targetMode, adminUid, lockToken: exactLockToken
        }, report.lock.updateTimeGeneration);
        const sessionRef = db.doc('sessions/' + item.sessionId);
        const studentsRef = db.collection('sessions/' + item.sessionId + '/students');
        const sessionSnapshot = await transaction.get(sessionRef);
        if (!sessionSnapshot.exists) return { skipped: 'session-deleted-after-scan' };
        const data = sessionSnapshot.data() || {};
        if (!ACTIVE_STATUSES.has(data.status)) return { skipped: 'session-ended-after-scan' };
        const studentsSnapshot = await transaction.get(studentsRef);
        const current = inspectSession(item.sessionId, data, studentsSnapshot.docs || []);
        if (current.invalidStudents.length) return { skipped: 'invalid-student-after-scan' };
        if (!current.issue) return { skipped: 'already-current' };
        const patch = {
          registeredStudentCount: current.actualCount,
          studentCountRevision: current.actualCount,
          lastStudentUid: current.actualCount > 0 ? current.desiredLastStudentUid : deleteField()
        };
        transaction.set(sessionRef, patch, { merge: true });
        return { applied: true, reclassified: current.actualCount !== item.actualCount };
      });
      if (result.applied) report.appliedCount += 1;
      if (result.reclassified) report.reclassifiedCount += 1;
      if (result.skipped && result.skipped !== 'already-current') {
        report.concurrentlySkipped.push({ sessionId: item.sessionId, reason: result.skipped });
      }
    }
    report.concurrentlySkippedCount = report.concurrentlySkipped.length;
    const beforeGate = await scanSessions(db);
    report.audit = beforeGate.audit;
    if (!beforeGate.audit.safe) {
      report.status = 'complete';
      report.safeToDeployStrictRules = false;
      return report;
    }
    await db.runTransaction(async transaction => {
      const lockSnapshot = await transaction.get(db.doc(LOCK_PATH));
      verifyMigrationLockSnapshot(lockSnapshot, {
        projectId, targetMode, adminUid, lockToken: exactLockToken
      }, report.lock.updateTimeGeneration);
      const gateSnapshot = await transaction.get(gateRef);
      if (gateSnapshot.exists) throw new Error('Session counter gate appeared during preflight.');
      const sessionsSnapshot = await transaction.get(db.collection('sessions'));
      let issues = 0;
      for (const document of sessionsSnapshot.docs || []) {
        const data = document.data() || {};
        if (!ACTIVE_STATUSES.has(data.status)) continue;
        const students = await transaction.get(db.collection('sessions/' + document.id + '/students'));
        if (inspectSession(document.id, data, students.docs || []).issue) issues += 1;
      }
      if (issues !== 0) throw new Error('Session counter gate preflight found non-ended legacy sessions.');
      const at = serverTimestamp();
      transaction.set(gateRef, {
        complete: true,
        projectId,
        environment: targetMode,
        rulesVersion: 'session-counters-v1',
        preflightNonEndedLegacyCount: 0,
        verifiedAt: at,
        updatedAt: at,
        completedByUid: adminUid
      });
    });
    const gateReadback = await gateRef.get();
    report.gate = verifyGateSnapshot(gateReadback, { projectId, targetMode });
    const afterGate = await scanSessions(db);
    report.lock = await verifySessionCounterMigrationLock({
      db, projectId, targetMode, adminUid, lockToken: exactLockToken,
      expectedGeneration: report.lock.updateTimeGeneration
    });
    const stableGate = verifyGateSnapshot(
      await gateRef.get(), { projectId, targetMode }, report.gate.updateTimeGeneration
    );
    report.gate = stableGate;
    report.audit = afterGate.audit;
    report.safeToDeployStrictRules = afterGate.audit.safe && report.lock.locked === true;
    report.status = 'complete';
    return report;
  } catch (error) {
    report.concurrentlySkippedCount = report.concurrentlySkipped.length;
    report.status = report.appliedCount > 0 || report.gate.created ? 'partial-failure' : 'failed';
    report.safeToDeployStrictRules = false;
    report.error = String(error && error.message || error);
    if (!report.auditError) report.auditError = report.error;
    error.partialReport = report;
    throw error;
  }
}

module.exports = {
  ACTIVE_STATUSES,
  acquireSessionCounterMigrationLock,
  buildAudit,
  inspectSession,
  runSessionCounterMigration,
  scanSessions,
  updateTimeGeneration,
  unlockSessionCounterMigrationLock,
  verifyMigrationLockSnapshot,
  verifySessionCounterMigrationLock,
  verifyGateSnapshot
};
