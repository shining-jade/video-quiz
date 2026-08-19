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

function auditCounterRecords(records) {
  const audit = {
    totalSets: 0, missingCollaboratorCount: 0, missingImageCount: 0,
    invalidCounterCount: 0, counterMismatchCount: 0, counterMismatchIds: [],
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
    audit.counterMismatchCount === 0;
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

function planCounterBackfill(records) {
  return (records || []).filter(record => {
    const data = record.data || record;
    return counterIssue(data, record.collaboratorActual, record.imageActual) !== '';
  }).map(record => ({
    id: String(record.id || ''),
    patch: { collaboratorCount: record.collaboratorActual, imageCount: record.imageActual }
  }));
}

async function runCounterBackfill({ db, projectId, apply = false, confirmProject = '', batchSize = 20 }) {
  if (!db || typeof db.collection !== 'function') throw new Error('Admin Firestore DB is required.');
  if (!projectId) throw new Error('projectId is required.');
  if (apply && confirmProject !== projectId) throw new Error('Apply requires an exact project confirmation.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new Error('batchSize must be between 1 and 20.');
  const initial = await scanSets(db);
  const plan = planCounterBackfill(initial);
  const report = {
    projectId, mode: apply ? 'apply' : 'dry-run', operation: 'set-counter-backfill',
    plannedCount: plan.length, appliedCount: 0, concurrentlySkipped: [],
    concurrentlySkippedCount: 0, status: apply ? 'running' : 'complete',
    safeToDeployStrictRules: false, audit: auditCounterRecords(initial)
  };
  if (!apply) return report;
  try {
    for (let offset = 0; offset < plan.length; offset += batchSize) {
      for (const item of plan.slice(offset, offset + batchSize)) {
        const result = await db.runTransaction(async transaction => {
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
      }
    }
  } catch (error) {
    report.status = report.appliedCount > 0 ? 'partial-failure' : 'failed';
    report.error = String(error && error.message || error);
    report.safeToDeployStrictRules = false;
    error.partialReport = report;
    throw error;
  }
  report.concurrentlySkippedCount = report.concurrentlySkipped.length;
  const after = await scanSets(db);
  report.audit = auditCounterRecords(after);
  report.safeToDeployStrictRules = report.audit.safeToDeployStrictRules;
  report.status = 'complete';
  return report;
}

module.exports = { auditCounterRecords, planCounterBackfill, runCounterBackfill };
