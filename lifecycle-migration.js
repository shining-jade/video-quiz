'use strict';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const markerPresent = (value, key) => own(value, key) && value[key] != null;

function planLifecycleBackfill(records) {
  const planned = [];
  const skipped = [];
  for (const record of records || []) {
    const id = String(record.id || '');
    const data = record.data || record;
    if (!id) {
      skipped.push({ id, reason: 'missing-id' });
    } else if (own(data, 'lifecycleState')) {
      skipped.push({ id, reason: 'already-present', lifecycleState: data.lifecycleState });
    } else if (markerPresent(data, 'trashedAt') || markerPresent(data, 'purgeStartedAt')) {
      skipped.push({ id, reason: 'non-active-state' });
    } else {
      planned.push({ id, patch: { lifecycleState: 'active' } });
    }
  }
  return { planned, skipped };
}

function isFirestoreTimestamp(value) {
  if (!value || typeof value !== 'object' || typeof value.toMillis !== 'function') return false;
  try {
    return Number.isFinite(value.toMillis());
  } catch (_) {
    return false;
  }
}

function lifecycleMismatchReason(data) {
  const hasTrash = markerPresent(data, 'trashedAt');
  const hasPurge = markerPresent(data, 'purgeStartedAt');
  if (data.lifecycleState === 'active') {
    return hasTrash || hasPurge ? 'active-has-lifecycle-marker' : '';
  }
  if (data.lifecycleState === 'trashed') {
    if (!hasTrash || !isFirestoreTimestamp(data.trashedAt)) return 'trashed-needs-timestamp';
    return hasPurge ? 'trashed-has-purge-marker' : '';
  }
  if (data.lifecycleState === 'purging') {
    if (!hasTrash || !isFirestoreTimestamp(data.trashedAt)) return 'purging-needs-trash-timestamp';
    if (!hasPurge || !isFirestoreTimestamp(data.purgeStartedAt)) {
      return 'purging-needs-purge-timestamp';
    }
  }
  return '';
}

function auditLifecycle(records) {
  const audit = {
    totalSets: 0,
    missingLifecycleState: 0,
    invalidLifecycleState: 0,
    legacyActiveMissing: 0,
    remainingUnclassified: 0,
    lifecycleMismatchCount: 0,
    lifecycleMismatchIds: [],
    lifecycleMismatches: [],
  };
  const valid = new Set(['active', 'trashed', 'purging']);
  for (const record of records || []) {
    audit.totalSets += 1;
    const data = record.data || record;
    if (!own(data, 'lifecycleState')) {
      audit.missingLifecycleState += 1;
      if (!markerPresent(data, 'trashedAt') && !markerPresent(data, 'purgeStartedAt')) {
        audit.legacyActiveMissing += 1;
      } else {
        audit.remainingUnclassified += 1;
      }
    } else if (!valid.has(data.lifecycleState)) {
      audit.invalidLifecycleState += 1;
    } else {
      const reason = lifecycleMismatchReason(data);
      if (reason) {
        audit.lifecycleMismatchCount += 1;
        audit.lifecycleMismatchIds.push(String(record.id || ''));
        audit.lifecycleMismatches.push({ id: String(record.id || ''), reason });
      }
    }
  }
  return audit;
}

async function runLifecycleBackfill({ db, projectId, apply = false, confirmProject = '', batchSize = 200 }) {
  if (!db || typeof db.collection !== 'function') throw new Error('Admin Firestore DB is required.');
  if (!projectId) throw new Error('projectId is required.');
  if (apply && confirmProject !== projectId) {
    throw new Error('Apply requires an exact project confirmation.');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error('batchSize must be between 1 and 200.');
  }
  const snapshot = await db.collection('quiz_sets').get();
  const records = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
  const plan = planLifecycleBackfill(records);
  const report = {
    projectId,
    mode: apply ? 'apply' : 'dry-run',
    operation: 'lifecycle-backfill',
    plannedCount: plan.planned.length,
    appliedCount: 0,
    skipped: plan.skipped,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: apply ? 'running' : 'complete',
    safeToDeployStrictRules: false,
    audit: auditLifecycle(records),
  };
  if (!apply) return report;
  try {
    for (let offset = 0; offset < plan.planned.length; offset += batchSize) {
      const chunk = plan.planned.slice(offset, offset + batchSize);
      const result = await db.runTransaction(async transaction => {
        const candidates = await Promise.all(chunk.map(async item => {
          const ref = db.doc('quiz_sets/' + item.id);
          return { item, ref, snapshot: await transaction.get(ref) };
        }));
        const skipped = [];
        let appliedCount = 0;
        for (const candidate of candidates) {
          const current = candidate.snapshot.exists ? candidate.snapshot.data() || {} : null;
          if (current && !own(current, 'lifecycleState') &&
              !markerPresent(current, 'trashedAt') && !markerPresent(current, 'purgeStartedAt')) {
            transaction.update(candidate.ref, candidate.item.patch);
            appliedCount += 1;
          } else {
            skipped.push({ id: candidate.item.id, reason: 'changed-after-scan' });
          }
        }
        return { appliedCount, skipped };
      });
      report.appliedCount += result.appliedCount;
      report.concurrentlySkipped.push(...result.skipped);
      report.concurrentlySkippedCount = report.concurrentlySkipped.length;
    }
  } catch (error) {
    report.status = report.appliedCount > 0 ? 'partial-failure' : 'failed';
    report.safeToDeployStrictRules = false;
    report.error = String(error && error.message || error);
    try {
      const failedAfter = await db.collection('quiz_sets').get();
      report.audit = auditLifecycle(failedAfter.docs.map(doc => ({
        id: doc.id, data: doc.data() || {}
      })));
    } catch (auditError) {
      report.auditError = String(auditError && auditError.message || auditError);
    }
    error.partialReport = report;
    throw error;
  }
  const after = await db.collection('quiz_sets').get();
  report.audit = auditLifecycle(after.docs.map(doc => ({ id: doc.id, data: doc.data() || {} })));
  report.safeToDeployStrictRules = report.audit.missingLifecycleState === 0 &&
    report.audit.invalidLifecycleState === 0 &&
    report.audit.lifecycleMismatchCount === 0;
  report.status = 'complete';
  return report;
}

module.exports = { planLifecycleBackfill, auditLifecycle, runLifecycleBackfill };
