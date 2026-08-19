'use strict';

const GATE_PATH = 'migration_gates/set_counters';
const LOCK_KEYS = [
  'locked', 'lockId', 'projectId', 'targetMode', 'lockedAt', 'lockedByUid'
];

function updateTimeGeneration(snapshot) {
  const updateTime = snapshot && snapshot.updateTime;
  if (updateTime && Number.isInteger(updateTime.seconds)) {
    return String(updateTime.seconds) + ':' + String(Number(updateTime.nanoseconds || 0));
  }
  throw new Error('Counter gate is missing an exact authoritative server updateTime generation.');
}

function exactKeys(value, expected) {
  const keys = Object.keys(value || {}).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected.slice().sort()[index]);
}

function assertTargetIdentity(data, { projectId, targetMode, gateId }) {
  if (data.projectId !== projectId) throw new Error('Counter gate project identity mismatch.');
  if (data.targetMode !== targetMode) throw new Error('Counter gate target mode identity mismatch.');
  if (gateId && data.lockId !== gateId) throw new Error('Counter gate lock identity mismatch.');
}

function gateEvidence(snapshot, previousUpdateTimeGeneration) {
  if (!snapshot || !snapshot.exists) return { path: GATE_PATH, exists: false };
  const data = snapshot.data() || {};
  return {
    path: GATE_PATH,
    exists: true,
    locked: data.locked === true,
    lockId: String(data.lockId || ''),
    projectId: String(data.projectId || ''),
    targetMode: String(data.targetMode || ''),
    lockedByUid: String(data.lockedByUid || ''),
    ...(data.unlockedByUid == null ? {} : { unlockedByUid: String(data.unlockedByUid) }),
    ...(previousUpdateTimeGeneration == null ? {} : { previousUpdateTimeGeneration }),
    updateTimeGeneration: updateTimeGeneration(snapshot)
  };
}

function assertCurrentLocked(snapshot, options) {
  if (!snapshot || !snapshot.exists) throw new Error('Counter gate is missing.');
  const data = snapshot.data() || {};
  if (!exactKeys(data, LOCK_KEYS)) throw new Error('Counter gate locked document shape is invalid.');
  if (data.locked !== true) throw new Error('Counter gate must be currently locked.');
  assertTargetIdentity(data, options);
  if (!data.lockId || !data.lockedByUid || data.lockedAt == null) {
    throw new Error('Counter gate locked identity is incomplete.');
  }
  return { data, generation: updateTimeGeneration(snapshot) };
}

async function runCounterGateOperation({
  db, action, projectId, targetMode, actorUid = '', gateId = '', gateGeneration = '',
  createLockId, serverTimestamp
}) {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('Admin Firestore DB is required.');
  }
  if (!projectId) throw new Error('projectId is required.');
  if (!['production', 'emulator'].includes(targetMode)) {
    throw new Error('targetMode must be production or emulator.');
  }
  if (!['lock', 'status', 'unlock'].includes(action)) {
    throw new Error('action must be lock, status, or unlock.');
  }
  const reference = db.doc(GATE_PATH);
  if (action === 'status') {
    const snapshot = await reference.get();
    const evidence = gateEvidence(snapshot);
    return {
      action, projectId, targetMode, status: 'complete',
      gate: evidence,
      targetMatches: !evidence.exists ||
        (evidence.projectId === projectId && evidence.targetMode === targetMode)
    };
  }
  if (!actorUid) throw new Error('Mutating counter gate operations require an exact admin uid.');
  if (typeof serverTimestamp !== 'function') {
    throw new Error('Authoritative serverTimestamp is required.');
  }

  if (action === 'lock') {
    const nextLockId = gateId || (typeof createLockId === 'function' ? createLockId() : '');
    if (!nextLockId || String(nextLockId).length > 120) {
      throw new Error('A newly generated lock identity is required.');
    }
    await db.runTransaction(async transaction => {
      const current = await transaction.get(reference);
      if (current.exists) {
        const data = current.data() || {};
        if (data.locked === true) throw new Error('Counter gate is already locked.');
        if (data.projectId !== projectId || data.targetMode !== targetMode) {
          throw new Error('Existing counter gate target identity mismatch.');
        }
        if (data.lockId === nextLockId) {
          throw new Error('New lock identity must differ from the prior generation.');
        }
      }
      transaction.set(reference, {
        locked: true,
        lockId: String(nextLockId),
        projectId,
        targetMode,
        lockedAt: serverTimestamp(),
        lockedByUid: actorUid
      });
    });
    const snapshot = await reference.get();
    const current = assertCurrentLocked(snapshot, {
      projectId, targetMode, gateId: String(nextLockId)
    });
    if (current.data.lockedByUid !== actorUid) {
      throw new Error('Counter gate lock readback actor mismatch.');
    }
    return {
      action, projectId, targetMode, status: 'complete',
      gate: gateEvidence(snapshot)
    };
  }

  if (!gateId || !gateGeneration) {
    throw new Error('Unlock requires exact lock id and updateTime generation.');
  }
  let priorGeneration;
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    const current = assertCurrentLocked(snapshot, { projectId, targetMode, gateId });
    if (current.generation !== gateGeneration) {
      throw new Error('Counter gate generation mismatch.');
    }
    priorGeneration = current.generation;
    transaction.set(reference, {
      ...current.data,
      locked: false,
      unlockedAt: serverTimestamp(),
      unlockedByUid: actorUid
    });
  });
  const readback = await reference.get();
  if (!readback.exists) throw new Error('Counter gate unlock readback is missing.');
  const data = readback.data() || {};
  assertTargetIdentity(data, { projectId, targetMode, gateId });
  if (data.locked !== false || data.unlockedByUid !== actorUid) {
    throw new Error('Counter gate unlock readback identity mismatch.');
  }
  const evidence = gateEvidence(readback, priorGeneration);
  if (evidence.updateTimeGeneration === priorGeneration) {
    throw new Error('Counter gate unlock did not create a new authoritative generation.');
  }
  return { action, projectId, targetMode, status: 'complete', gate: evidence };
}

module.exports = {
  GATE_PATH,
  gateEvidence,
  runCounterGateOperation,
  updateTimeGeneration
};
