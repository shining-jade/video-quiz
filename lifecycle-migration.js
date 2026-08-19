'use strict';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

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
    } else if (own(data, 'trashedAt') || own(data, 'purgeStartedAt')) {
      skipped.push({ id, reason: 'non-active-state' });
    } else {
      planned.push({ id, patch: { lifecycleState: 'active' } });
    }
  }
  return { planned, skipped };
}

function auditLifecycle(records) {
  const audit = {
    totalSets: 0,
    missingLifecycleState: 0,
    invalidLifecycleState: 0,
    legacyActiveMissing: 0,
    remainingUnclassified: 0,
  };
  const valid = new Set(['active', 'trashed', 'purging']);
  for (const record of records || []) {
    audit.totalSets += 1;
    const data = record.data || record;
    if (!own(data, 'lifecycleState')) {
      audit.missingLifecycleState += 1;
      if (!own(data, 'trashedAt') && !own(data, 'purgeStartedAt')) audit.legacyActiveMissing += 1;
      else audit.remainingUnclassified += 1;
    } else if (!valid.has(data.lifecycleState)) {
      audit.invalidLifecycleState += 1;
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
    safeToDeployStrictRules: false,
    audit: auditLifecycle(records),
  };
  if (!apply) return report;
  for (let offset = 0; offset < plan.planned.length; offset += batchSize) {
    const batch = db.batch();
    plan.planned.slice(offset, offset + batchSize).forEach(item => {
      batch.update(db.doc('quiz_sets/' + item.id), item.patch);
    });
    await batch.commit();
    report.appliedCount += Math.min(batchSize, plan.planned.length - offset);
  }
  const after = await db.collection('quiz_sets').get();
  report.audit = auditLifecycle(after.docs.map(doc => ({ id: doc.id, data: doc.data() || {} })));
  report.safeToDeployStrictRules = report.audit.missingLifecycleState === 0 &&
    report.audit.invalidLifecycleState === 0;
  return report;
}

module.exports = { planLifecycleBackfill, auditLifecycle, runLifecycleBackfill };
