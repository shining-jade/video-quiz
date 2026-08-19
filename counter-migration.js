'use strict';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function counterIssue(data, collaboratorActual, imageActual) {
  if (!Number.isInteger(data.collaboratorCount) || data.collaboratorCount < 0 || data.collaboratorCount > 20) {
    return 'invalid-collaborator-count';
  }
  if (!Number.isInteger(data.imageCount) || data.imageCount < 0) return 'invalid-image-count';
  if (data.collaboratorCount !== collaboratorActual) return 'collaborator-count-mismatch';
  if (data.imageCount !== imageActual) return 'image-count-mismatch';
  return '';
}

function auditCounterRecords(records, orphanAudit = {}) {
  const audit = {
    totalSets: 0, missingCollaboratorCount: 0, missingImageCount: 0,
    invalidCounterCount: 0, counterMismatchCount: 0, counterMismatchIds: [],
    orphanChildCount: Number(orphanAudit.orphanChildCount || 0),
    orphanCollaboratorCount: Number(orphanAudit.orphanCollaboratorCount || 0),
    orphanImageCount: Number(orphanAudit.orphanImageCount || 0),
    orphanChildDetails: Array.isArray(orphanAudit.orphanChildDetails)
      ? orphanAudit.orphanChildDetails.slice(0, 100) : [],
    orphanChildDetailsTruncated: orphanAudit.orphanChildDetailsTruncated === true,
    safeToDeployStrictRules: false
  };
  for (const record of records || []) {
    audit.totalSets += 1;
    const data = record.data || record;
    if (!own(data, 'collaboratorCount')) audit.missingCollaboratorCount += 1;
    if (!own(data, 'imageCount')) audit.missingImageCount += 1;
    const issue = counterIssue(data, record.collaboratorActual, record.imageActual);
    if (issue === 'invalid-collaborator-count' || issue === 'invalid-image-count') {
      audit.invalidCounterCount += 1;
    } else if (issue) {
      audit.counterMismatchCount += 1;
      audit.counterMismatchIds.push(String(record.id || ''));
    }
  }
  audit.safeToDeployStrictRules = audit.missingCollaboratorCount === 0 &&
    audit.missingImageCount === 0 && audit.invalidCounterCount === 0 &&
    audit.counterMismatchCount === 0 && audit.orphanChildCount === 0;
  return audit;
}

async function childCount(db, path) {
  const snapshot = await db.collection(path).get();
  return snapshot.size != null ? snapshot.size : (snapshot.docs || []).length;
}

async function scanSets(db) {
  const snapshot = await db.collection('quiz_sets').get();
  const records = [];
  for (const document of snapshot.docs) {
    const data = document.data() || {};
    records.push({
      id: document.id,
      data,
      collaboratorActual: await childCount(db, 'quiz_sets/' + document.id + '/collaborators'),
      imageActual: await childCount(db, 'images/' + document.id + '/q')
    });
  }
  return records;
}

async function scanOrphanChildren(db, records) {
  if (!db || typeof db.collectionGroup !== 'function') {
    throw new Error('Authoritative collectionGroup orphan audit is required.');
  }
  const parentIds = new Set((records || []).map(record => String(record.id || '')));
  const result = {
    orphanChildCount: 0,
    orphanCollaboratorCount: 0,
    orphanImageCount: 0,
    orphanChildDetails: [],
    orphanChildDetailsTruncated: false
  };
  async function scanGroup(group, root, type, countField) {
    const snapshot = await db.collectionGroup(group).get();
    for (const document of snapshot.docs || []) {
      const path = String(document && document.ref && document.ref.path || '');
      const segments = path.split('/');
      if (segments.length !== 4 || segments[0] !== root || segments[2] !== group) continue;
      const setId = segments[1];
      if (parentIds.has(setId)) continue;
      result.orphanChildCount += 1;
      result[countField] += 1;
      if (result.orphanChildDetails.length < 100) {
        result.orphanChildDetails.push({ type, setId, path });
      } else {
        result.orphanChildDetailsTruncated = true;
      }
    }
  }
  await scanGroup('collaborators', 'quiz_sets', 'collaborator', 'orphanCollaboratorCount');
  await scanGroup('q', 'images', 'image', 'orphanImageCount');
  return result;
}

function planCounterBackfill(records) {
  return (records || []).filter(record => {
    const data = record.data || record;
    return counterIssue(data, record.collaboratorActual, record.imageActual) !== '';
  }).map(record => ({
    id: String(record.id || ''),
    patch: { collaboratorCount: record.collaboratorActual, imageCount: record.imageActual }
  }));
}

function updateTimeGeneration(snapshot) {
  const value = snapshot && snapshot.updateTime;
  if (value && Number.isInteger(value.seconds)) {
    return String(value.seconds) + ':' + String(Number(value.nanoseconds || 0));
  }
  throw new Error('Counter migration gate is missing an exact authoritative server updateTime generation.');
}

function verifyGateSnapshot(snapshot, { projectId, targetMode, gateId }, expected) {
  if (!snapshot || !snapshot.exists) throw new Error('Counter migration gate is missing.');
  const data = snapshot.data() || {};
  if (data.locked !== true) throw new Error('Counter migration gate must remain locked.');
  if (data.projectId !== projectId) throw new Error('Counter migration gate project mismatch.');
  if (data.targetMode !== targetMode) throw new Error('Counter migration gate target mode mismatch.');
  if (data.lockId !== gateId) throw new Error('Counter migration gate identity mismatch.');
  const evidence = {
    path: 'migration_gates/set_counters',
    locked: true,
    lockId: data.lockId,
    projectId: data.projectId,
    targetMode: data.targetMode,
    updateTimeGeneration: updateTimeGeneration(snapshot)
  };
  if (expected && evidence.updateTimeGeneration !== expected.updateTimeGeneration) {
    throw new Error('Counter migration gate generation changed.');
  }
  return evidence;
}

async function runCounterBackfill({
  db, projectId, targetMode = 'production', gateId = '',
  apply = false, confirmProject = '', batchSize = 20
}) {
  if (!db || typeof db.collection !== 'function') throw new Error('Admin Firestore DB is required.');
  if (!projectId) throw new Error('projectId is required.');
  if (apply && confirmProject !== projectId) throw new Error('Apply requires an exact project confirmation.');
  if (!['production', 'emulator'].includes(targetMode)) throw new Error('targetMode must be production or emulator.');
  if (apply && !gateId) throw new Error('Apply requires an exact counter migration gate identity.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new Error('batchSize must be between 1 and 20.');
  const report = {
    projectId, targetMode, mode: apply ? 'apply' : 'dry-run', operation: 'set-counter-backfill',
    plannedCount: 0, appliedCount: 0, concurrentlySkipped: [],
    concurrentlySkippedCount: 0, status: apply ? 'running' : 'complete',
    safeToDeployStrictRules: false,
    gate: { path: 'migration_gates/set_counters', locked: false, lockId: gateId || '' }
  };
  try {
    const gateReference = db.doc('migration_gates/set_counters');
    const expectedGate = gateId
      ? verifyGateSnapshot(await gateReference.get(), { projectId, targetMode, gateId })
      : null;
    if (expectedGate) report.gate = expectedGate;
    const initial = await scanSets(db);
    const initialOrphans = await scanOrphanChildren(db, initial);
    const plan = planCounterBackfill(initial);
    report.plannedCount = plan.length;
    report.audit = auditCounterRecords(initial, initialOrphans);
    if (!apply) {
      if (expectedGate) {
        verifyGateSnapshot(await gateReference.get(), { projectId, targetMode, gateId }, expectedGate);
        report.safeToDeployStrictRules = report.audit.safeToDeployStrictRules;
      } else {
        report.safeToDeployStrictRules = false;
      }
      return report;
    }
    for (let offset = 0; offset < plan.length; offset += batchSize) {
      for (const item of plan.slice(offset, offset + batchSize)) {
        const result = await db.runTransaction(async transaction => {
          verifyGateSnapshot(
            await transaction.get(gateReference),
            { projectId, targetMode, gateId },
            expectedGate
          );
          const parentRef = db.doc('quiz_sets/' + item.id);
          const parentSnapshot = await transaction.get(parentRef);
          if (!parentSnapshot.exists) return { skipped: 'missing-parent' };
          const collaboratorSnapshot = await transaction.get(
            db.collection('quiz_sets/' + item.id + '/collaborators')
          );
          const imageSnapshot = await transaction.get(
            db.collection('images/' + item.id + '/q')
          );
          const collaboratorCount = (collaboratorSnapshot.docs || []).length;
          const imageCount = (imageSnapshot.docs || []).length;
          const current = parentSnapshot.data() || {};
          if (counterIssue(current, collaboratorCount, imageCount) === '') return { skipped: 'already-current' };
          transaction.update(parentRef, { collaboratorCount, imageCount });
          return { applied: true };
        });
        if (result.applied) report.appliedCount += 1;
        else report.concurrentlySkipped.push({ id: item.id, reason: result.skipped });
        report.concurrentlySkippedCount = report.concurrentlySkipped.length;
      }
    }
    verifyGateSnapshot(
      await gateReference.get(),
      { projectId, targetMode, gateId },
      expectedGate
    );
    const after = await scanSets(db);
    const afterOrphans = await scanOrphanChildren(db, after);
    verifyGateSnapshot(
      await gateReference.get(),
      { projectId, targetMode, gateId },
      expectedGate
    );
    report.audit = auditCounterRecords(after, afterOrphans);
    report.safeToDeployStrictRules = report.audit.safeToDeployStrictRules;
    report.status = 'complete';
    return report;
  } catch (error) {
    report.concurrentlySkippedCount = report.concurrentlySkipped.length;
    report.status = report.appliedCount > 0 ? 'partial-failure' : 'failed';
    report.error = String(error && error.message || error);
    report.safeToDeployStrictRules = false;
    error.partialReport = report;
    throw error;
  }
}

module.exports = { auditCounterRecords, planCounterBackfill, runCounterBackfill };
