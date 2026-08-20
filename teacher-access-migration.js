'use strict';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const ALLOWANCE_KEYS = [
  'uid', 'emailCanonical', 'displayName', 'status', 'enabled', 'role',
  'administrativeHold', 'approvedAt', 'approvedByUid', 'updatedAt', 'updatedByUid'
].sort();
const LEGACY_KEYS = ['enabled', 'role', 'updatedAt', 'updatedByUid'].sort();

function canonicalEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+$/.test(email) ? email : '';
}

function timestampValid(value) {
  if (!value || typeof value !== 'object' || typeof value.toMillis !== 'function') return false;
  try { return Number.isFinite(value.toMillis()); } catch (_) { return false; }
}

function validUid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

function validAdminUid(value) {
  if (!validUid(value)) throw new Error('A bounded --admin-uid is required.');
  return value;
}

function validLegacy(emailCanonical, legacy) {
  return canonicalEmail(emailCanonical) === emailCanonical && legacy &&
    typeof legacy.enabled === 'boolean' && ['teacher', 'admin'].includes(legacy.role);
}

function validGoogleUser(user, emailCanonical) {
  return user && validUid(user.uid) && user.emailVerified === true &&
    canonicalEmail(user.email) === emailCanonical &&
    Array.isArray(user.providerData) &&
    user.providerData.some(provider => provider && provider.providerId === 'google.com');
}

function displayNameFor(_legacy, user) {
  const value = typeof (user && user.displayName) === 'string' ? user.displayName.trim() : '';
  if (value.length >= 1 && value.length <= 80) return value;
  throw new Error('A migrated teacher requires a display name between 1 and 80 characters.');
}

function buildAllowance({ emailCanonical, legacy, user, adminUid, at }) {
  if (!validLegacy(emailCanonical, legacy)) throw new Error('Valid canonical legacy allowance required.');
  if (!validGoogleUser(user, emailCanonical)) throw new Error('Exact verified Google Auth identity required.');
  validAdminUid(adminUid);
  if (!at || typeof at !== 'object') {
    throw new Error('A Firestore server Timestamp transform is required.');
  }
  const active = legacy.enabled === true;
  return {
    uid: user.uid,
    emailCanonical,
    displayName: displayNameFor(legacy, user),
    status: active ? 'active' : 'suspended',
    enabled: active,
    role: legacy.role,
    administrativeHold: !active,
    approvedAt: at,
    approvedByUid: adminUid,
    updatedAt: at,
    updatedByUid: adminUid
  };
}

function sameKeys(value, keys) {
  return value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function allowanceCoherent(value, desired) {
  return sameKeys(value, ALLOWANCE_KEYS) && value.uid === desired.uid &&
    value.emailCanonical === desired.emailCanonical && value.displayName === desired.displayName &&
    value.status === desired.status && value.enabled === desired.enabled &&
    value.role === desired.role && value.administrativeHold === desired.administrativeHold &&
    timestampValid(value.approvedAt) && validUid(value.approvedByUid) &&
    timestampValid(value.updatedAt) && validUid(value.updatedByUid);
}

function legacyCoherent(value, desired) {
  return sameKeys(value, LEGACY_KEYS) && value.enabled === desired.enabled &&
    value.role === desired.role && timestampValid(value.updatedAt) && validUid(value.updatedByUid);
}

async function getAuthUser(auth, emailCanonical) {
  try {
    return { user: await auth.getUserByEmail(emailCanonical) };
  } catch (error) {
    if (error && error.code === 'auth/user-not-found') return { missing: true };
    throw error;
  }
}

async function readCollections(db) {
  const [legacySnapshot, allowanceSnapshot] = await Promise.all([
    db.collection('teacher_allowlist').get(),
    db.collection('teacher_allowances').get()
  ]);
  return {
    legacy: legacySnapshot.docs || [],
    allowances: allowanceSnapshot.docs || []
  };
}

async function scanAccessState({ db, auth, adminUid, at }) {
  const collections = await readCollections(db);
  const allowanceByUid = new Map(collections.allowances.map(document => [
    document.id, document.data() || {}
  ]));
  const representedUids = new Set();
  const planned = [];
  const audit = {
    totalLegacy: collections.legacy.length,
    totalAllowances: collections.allowances.length,
    invalidLegacyCount: 0,
    missingAuthUserCount: 0,
    invalidAuthIdentityCount: 0,
    missingAllowanceCount: 0,
    allowanceMismatchCount: 0,
    legacyCompatibilityMismatchCount: 0,
    orphanAllowanceCount: 0,
    issues: []
  };
  for (const document of collections.legacy) {
    const emailCanonical = document.id;
    const legacy = document.data() || {};
    if (!validLegacy(emailCanonical, legacy)) {
      audit.invalidLegacyCount += 1;
      audit.issues.push({ emailCanonical, reason: 'invalid-legacy' });
      continue;
    }
    const authResult = await getAuthUser(auth, emailCanonical);
    if (authResult.missing) {
      audit.missingAuthUserCount += 1;
      audit.issues.push({ emailCanonical, reason: 'missing-auth-user' });
      continue;
    }
    if (!validGoogleUser(authResult.user, emailCanonical)) {
      audit.invalidAuthIdentityCount += 1;
      audit.issues.push({ emailCanonical, reason: 'invalid-auth-identity' });
      continue;
    }
    let desired;
    try {
      desired = buildAllowance({ emailCanonical, legacy, user: authResult.user, adminUid, at });
    } catch (error) {
      audit.invalidAuthIdentityCount += 1;
      audit.issues.push({ emailCanonical, reason: 'invalid-profile', error: error.message });
      continue;
    }
    representedUids.add(desired.uid);
    const allowance = allowanceByUid.get(desired.uid);
    const allowanceCurrent = allowanceCoherent(allowance, desired);
    const legacyCurrent = legacyCoherent(legacy, desired);
    if (!allowance) audit.missingAllowanceCount += 1;
    else if (!allowanceCurrent) audit.allowanceMismatchCount += 1;
    if (!legacyCurrent) audit.legacyCompatibilityMismatchCount += 1;
    if (!allowance || allowanceCurrent) {
      if (!allowanceCurrent || !legacyCurrent) {
        planned.push({ emailCanonical, user: authResult.user, initialEnabled: legacy.enabled, initialRole: legacy.role });
      }
    } else {
      audit.issues.push({ emailCanonical, uid: desired.uid, reason: 'allowance-mismatch' });
    }
  }
  for (const document of collections.allowances) {
    if (!representedUids.has(document.id)) {
      audit.orphanAllowanceCount += 1;
      audit.issues.push({ uid: document.id, reason: 'orphan-allowance' });
    }
  }
  audit.safe = audit.invalidLegacyCount === 0 && audit.missingAuthUserCount === 0 &&
    audit.invalidAuthIdentityCount === 0 && audit.missingAllowanceCount === 0 &&
    audit.allowanceMismatchCount === 0 && audit.legacyCompatibilityMismatchCount === 0 &&
    audit.orphanAllowanceCount === 0;
  return { planned, audit };
}

async function runTeacherAccessMigration({
  db, auth, projectId, targetMode = 'production', adminUid, apply = false,
  confirmProject = '', serverTimestamp
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('Admin Firestore DB is required.');
  }
  if (!auth || typeof auth.getUserByEmail !== 'function') throw new Error('Admin Auth is required.');
  if (!projectId) throw new Error('projectId is required.');
  if (!['production', 'emulator'].includes(targetMode)) throw new Error('targetMode must be production or emulator.');
  validAdminUid(adminUid);
  if (apply && confirmProject !== projectId) throw new Error('Apply requires an exact project confirmation.');
  if (typeof serverTimestamp !== 'function') throw new Error('Firestore serverTimestamp is required.');
  const report = {
    tool: 'teacher-access-migration', schemaVersion: 1, operation: 'teacher-access-status-backfill',
    projectId, targetMode, mode: apply ? 'apply' : 'dry-run', status: apply ? 'running' : 'complete',
    plannedCount: 0, appliedCount: 0, reclassifiedCount: 0,
    concurrentlySkipped: [], concurrentlySkippedCount: 0,
    safeToDeployStrictRules: false
  };
  try {
    const initialAt = serverTimestamp();
    const initial = await scanAccessState({ db, auth, adminUid, at: initialAt });
    report.plannedCount = initial.planned.length;
    report.audit = initial.audit;
    if (!apply) return report;
    for (const item of initial.planned) {
      const latestAuth = await getAuthUser(auth, item.emailCanonical);
      if (latestAuth.missing || !validGoogleUser(latestAuth.user, item.emailCanonical) ||
          latestAuth.user.uid !== item.user.uid) {
        report.concurrentlySkipped.push({ emailCanonical: item.emailCanonical, reason: 'auth-changed-after-scan' });
        continue;
      }
      const result = await db.runTransaction(async transaction => {
        const legacyRef = db.doc('teacher_allowlist/' + item.emailCanonical);
        const allowanceRef = db.doc('teacher_allowances/' + item.user.uid);
        const legacySnapshot = await transaction.get(legacyRef);
        const allowanceSnapshot = await transaction.get(allowanceRef);
        if (!legacySnapshot.exists) return { skipped: 'legacy-deleted-after-scan' };
        const legacy = legacySnapshot.data() || {};
        if (!validLegacy(item.emailCanonical, legacy)) return { skipped: 'legacy-invalid-after-scan' };
        const at = serverTimestamp();
        const desired = buildAllowance({
          emailCanonical: item.emailCanonical, legacy, user: latestAuth.user, adminUid, at
        });
        const currentAllowance = allowanceSnapshot.exists ? allowanceSnapshot.data() || {} : null;
        if (currentAllowance && !allowanceCoherent(currentAllowance, desired)) {
          return { skipped: 'allowance-changed-after-scan' };
        }
        if (!currentAllowance) transaction.set(allowanceRef, desired);
        if (!legacyCoherent(legacy, desired)) {
          transaction.set(legacyRef, {
            enabled: desired.enabled, role: desired.role, updatedAt: at, updatedByUid: adminUid
          });
        }
        return {
          applied: !currentAllowance || !legacyCoherent(legacy, desired),
          reclassified: legacy.enabled !== item.initialEnabled || legacy.role !== item.initialRole
        };
      });
      if (result.applied) report.appliedCount += 1;
      if (result.reclassified) report.reclassifiedCount += 1;
      if (result.skipped) report.concurrentlySkipped.push({
        emailCanonical: item.emailCanonical, reason: result.skipped
      });
    }
    report.concurrentlySkippedCount = report.concurrentlySkipped.length;
    let final;
    try {
      final = await scanAccessState({ db, auth, adminUid, at: serverTimestamp() });
    } catch (error) {
      report.status = report.appliedCount > 0 ? 'partial-failure' : 'failed';
      report.auditError = String(error && error.message || error);
      report.error = report.auditError;
      error.partialReport = report;
      throw error;
    }
    report.audit = final.audit;
    report.safeToDeployStrictRules = final.audit.safe === true;
    report.status = 'complete';
    return report;
  } catch (error) {
    if (error.partialReport === report) throw error;
    report.concurrentlySkippedCount = report.concurrentlySkipped.length;
    report.status = report.appliedCount > 0 ? 'partial-failure' : 'failed';
    report.safeToDeployStrictRules = false;
    report.error = String(error && error.message || error);
    try {
      const after = await scanAccessState({ db, auth, adminUid, at: serverTimestamp() });
      report.audit = after.audit;
    } catch (auditError) {
      report.auditError = String(auditError && auditError.message || auditError);
    }
    error.partialReport = report;
    throw error;
  }
}

module.exports = {
  allowanceCoherent,
  buildAllowance,
  canonicalEmail,
  legacyCoherent,
  runTeacherAccessMigration,
  scanAccessState
};
