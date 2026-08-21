'use strict';

const EMAIL_PATTERN = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+$/;
const SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DETAIL_LIMIT = 100;

function exactKeys(value, expected) {
  const keys = Object.keys(value || {}).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function validTimestamp(value) {
  return !!value && Number.isInteger(value.seconds) &&
    Number.isInteger(value.nanoseconds);
}

function validCollaborator(data, email, setId) {
  return EMAIL_PATTERN.test(email) && SET_ID_PATTERN.test(setId) &&
    exactKeys(data, ['addedAt', 'addedByUid', 'email']) &&
    data.email === email && typeof data.addedByUid === 'string' &&
    data.addedByUid.length >= 1 && data.addedByUid.length <= 128 &&
    validTimestamp(data.addedAt);
}

function validIndex(data, setId, email) {
  return EMAIL_PATTERN.test(email) && SET_ID_PATTERN.test(setId) &&
    exactKeys(data, ['email', 'setId']) && data.email === email && data.setId === setId;
}

function collaboratorIdentity(path) {
  const parts = String(path || '').split('/');
  return parts.length === 4 && parts[0] === 'quiz_sets' && parts[2] === 'collaborators'
    ? { setId: parts[1], email: parts[3] }
    : null;
}

function indexIdentity(path) {
  const parts = String(path || '').split('/');
  return parts.length === 4 && parts[0] === 'quiz_set_shares' && parts[2] === 'sets'
    ? { setId: parts[3], email: parts[1] }
    : null;
}

function pairKey(setId, email) {
  return JSON.stringify([email, setId]);
}

function indexPath(setId, email) {
  return 'quiz_set_shares/' + email + '/sets/' + setId;
}

async function boundedGroup(db, name, maxDocuments) {
  const query = db.collectionGroup(name);
  if (!query || typeof query.limit !== 'function') {
    throw new Error('Authoritative bounded collectionGroup scan is required.');
  }
  const snapshot = await query.limit(maxDocuments + 1).get();
  const documents = snapshot.docs || [];
  if (documents.length > maxDocuments) {
    throw new Error(name + ' scan exceeds maxDocuments=' + maxDocuments + '.');
  }
  return documents;
}

async function scanState(db, maxDocuments) {
  const collaboratorDocuments = await boundedGroup(db, 'collaborators', maxDocuments);
  const indexDocuments = await boundedGroup(db, 'sets', maxDocuments);
  const collaborators = new Map();
  const indexes = new Map();

  for (const document of collaboratorDocuments) {
    const identity = collaboratorIdentity(document && document.ref && document.ref.path);
    if (!identity) continue;
    const parent = await db.doc('quiz_sets/' + identity.setId).get();
    collaborators.set(pairKey(identity.setId, identity.email), {
      ...identity,
      path: document.ref.path,
      data: document.data() || {},
      parentExists: parent.exists === true
    });
  }
  for (const document of indexDocuments) {
    const identity = indexIdentity(document && document.ref && document.ref.path);
    if (!identity) continue;
    indexes.set(pairKey(identity.setId, identity.email), {
      ...identity,
      path: document.ref.path,
      data: document.data() || {}
    });
  }
  return { collaborators, indexes };
}

function inspectState(state) {
  const audit = {
    validCollaboratorCount: 0,
    validIndexCount: 0,
    missingIndexCount: 0,
    malformedCollaboratorCount: 0,
    orphanCollaboratorCount: 0,
    malformedIndexCount: 0,
    staleIndexCount: 0,
    findingDetails: [],
    findingDetailsTruncated: false,
    safeToUseShareIndex: false
  };
  const expected = new Map();
  const detail = (type, record) => {
    if (audit.findingDetails.length < DETAIL_LIMIT) {
      audit.findingDetails.push({ type, setId: record.setId, email: record.email });
    } else {
      audit.findingDetailsTruncated = true;
    }
  };

  for (const [key, collaborator] of state.collaborators) {
    if (!collaborator.parentExists) {
      audit.orphanCollaboratorCount += 1;
      detail('orphan-collaborator', collaborator);
      continue;
    }
    if (!validCollaborator(collaborator.data, collaborator.email, collaborator.setId)) {
      audit.malformedCollaboratorCount += 1;
      detail('malformed-collaborator', collaborator);
      continue;
    }
    audit.validCollaboratorCount += 1;
    expected.set(key, collaborator);
    const index = state.indexes.get(key);
    if (!index) {
      audit.missingIndexCount += 1;
      detail('missing-index', collaborator);
    }
  }

  for (const [key, index] of state.indexes) {
    const valid = validIndex(index.data, index.setId, index.email);
    if (!valid) {
      audit.malformedIndexCount += 1;
      detail('malformed-index', index);
    }
    if (!expected.has(key)) {
      audit.staleIndexCount += 1;
      detail('stale-index', index);
    } else if (valid) {
      audit.validIndexCount += 1;
    }
  }

  audit.safeToUseShareIndex = audit.missingIndexCount === 0 &&
    audit.malformedCollaboratorCount === 0 && audit.orphanCollaboratorCount === 0 &&
    audit.malformedIndexCount === 0 && audit.staleIndexCount === 0;
  const upserts = [...expected.entries()].filter(([key]) => {
    const index = state.indexes.get(key);
    return !index || !validIndex(index.data, index.setId, index.email);
  }).map(([, value]) => value);
  const deletes = [...state.indexes.entries()].filter(([key]) => !expected.has(key))
    .map(([, value]) => value);
  return { audit, upserts, deletes };
}

async function reconcilePair(db, item) {
  const parentReference = db.doc('quiz_sets/' + item.setId);
  const collaboratorReference = db.doc(
    'quiz_sets/' + item.setId + '/collaborators/' + item.email
  );
  const shareReference = db.doc(indexPath(item.setId, item.email));
  return db.runTransaction(async transaction => {
    const [parent, collaborator, share] = await Promise.all([
      transaction.get(parentReference),
      transaction.get(collaboratorReference),
      transaction.get(shareReference)
    ]);
    const collaboratorData = collaborator.exists ? collaborator.data() || {} : {};
    const authoritative = parent.exists && collaborator.exists &&
      validCollaborator(collaboratorData, item.email, item.setId);
    if (authoritative) {
      if (share.exists && validIndex(share.data() || {}, item.setId, item.email)) {
        return { skipped: 'already-current' };
      }
      transaction.set(shareReference, { email: item.email, setId: item.setId });
      return { action: 'upserted' };
    }
    if (share.exists) {
      transaction.delete(shareReference);
      return { action: 'deleted' };
    }
    return {
      skipped: !parent.exists
        ? 'missing-parent'
        : !collaborator.exists
          ? 'missing-collaborator'
          : 'malformed-collaborator'
    };
  });
}

async function runCollaboratorShareMigration({
  db,
  projectId,
  targetMode = 'production',
  apply = false,
  confirmProject = '',
  maxDocuments = 5000
}) {
  if (!db || typeof db.collectionGroup !== 'function' || typeof db.doc !== 'function') {
    throw new Error('Admin Firestore DB is required.');
  }
  if (!projectId) throw new Error('projectId is required.');
  if (!['production', 'emulator'].includes(targetMode)) {
    throw new Error('targetMode must be production or emulator.');
  }
  if (apply && confirmProject !== projectId) {
    throw new Error('Apply requires an exact project confirmation.');
  }
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 10000) {
    throw new Error('maxDocuments must be between 1 and 10000.');
  }

  const report = {
    tool: 'collaborator-share-migration',
    schemaVersion: 1,
    projectId,
    targetMode,
    mode: apply ? 'apply' : 'dry-run',
    operation: 'collaborator-share-backfill',
    maxDocuments,
    plannedUpsertCount: 0,
    plannedDeleteCount: 0,
    appliedUpsertCount: 0,
    appliedDeleteCount: 0,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: apply ? 'running' : 'complete',
    safeToUseShareIndex: false
  };
  try {
    const inspected = inspectState(await scanState(db, maxDocuments));
    report.audit = inspected.audit;
    report.plannedUpsertCount = inspected.upserts.length;
    report.plannedDeleteCount = inspected.deletes.length;
    if (apply) {
      for (const item of inspected.upserts.concat(inspected.deletes)) {
        const result = await reconcilePair(db, item);
        if (result.action === 'upserted') report.appliedUpsertCount += 1;
        else if (result.action === 'deleted') report.appliedDeleteCount += 1;
        else report.concurrentlySkipped.push({
          setId: item.setId,
          email: item.email,
          reason: result.skipped
        });
        report.concurrentlySkippedCount = report.concurrentlySkipped.length;
      }
      const final = inspectState(await scanState(db, maxDocuments));
      report.audit = final.audit;
      report.safeToUseShareIndex = final.audit.safeToUseShareIndex;
      report.status = 'complete';
      return report;
    }
    report.safeToUseShareIndex = inspected.audit.safeToUseShareIndex;
    return report;
  } catch (error) {
    report.status = report.appliedUpsertCount || report.appliedDeleteCount
      ? 'partial-failure' : 'failed';
    report.error = String(error && error.message || error);
    report.safeToUseShareIndex = false;
    error.partialReport = report;
    throw error;
  }
}

module.exports = {
  inspectState,
  runCollaboratorShareMigration,
  validCollaborator,
  validIndex
};
