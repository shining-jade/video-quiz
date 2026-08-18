const crypto = require('node:crypto');
const migrationCore = require('./migration-core.js');

const CATEGORY_NAMES = [
  'sets', 'images', 'sessions', 'snapshots', 'students', 'responses', 'grades'
];
const AMBIGUOUS_CODES = new Set([
  'cancelled', 'unknown', 'deadline-exceeded', 'resource-exhausted', 'aborted',
  'internal', 'unavailable', 'data-loss'
]);
const INTERNAL_VERIFIED_IDENTITY = Symbol('internalVerifiedLegacyOwnerIdentity');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function stableValue(value) {
  if (value && typeof value.toMillis === 'function') return ['timestamp', value.toMillis()];
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function parseCliArgs(argv) {
  const result = {
    projectId: '', ownerUid: '', apply: false, confirmProject: '',
    provisionOwnerEmail: '', removeOwner: false, emulator: false, output: ''
  };
  const valueFlags = new Map([
    ['--project', 'projectId'],
    ['--owner-uid', 'ownerUid'],
    ['--confirm-project', 'confirmProject'],
    ['--provision-owner-email', 'provisionOwnerEmail'],
    ['--output', 'output']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      result.apply = true;
      continue;
    }
    if (argument === '--emulator') {
      result.emulator = true;
      continue;
    }
    if (argument === '--remove-owner') {
      result.removeOwner = true;
      continue;
    }
    const field = valueFlags.get(argument);
    if (!field) throw new Error('Unknown argument: ' + argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value.');
    result[field] = value;
    index += 1;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (!result.ownerUid) throw new Error('--owner-uid is required.');
  if (result.apply && !result.confirmProject) {
    throw new Error('--apply requires --confirm-project with the exact project ID.');
  }
  if (result.apply && result.confirmProject !== result.projectId) {
    throw new Error('--confirm-project does not match --project.');
  }
  if (result.provisionOwnerEmail && !result.apply) {
    throw new Error('--provision-owner-email requires --apply.');
  }
  if (result.removeOwner && !result.apply) {
    throw new Error('--remove-owner requires --apply.');
  }
  if (result.removeOwner && result.provisionOwnerEmail) {
    throw new Error('--remove-owner cannot be combined with --provision-owner-email.');
  }
  return result;
}

function attachAuditDigest(report) {
  report.auditDigestKind = 'checksum';
  report.auditDigestAlgorithm = 'sha256';
  report.auditDigest = '';
  report.auditDigest = crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(report)))
    .digest('hex');
  return report;
}

function createReport(projectId, identity, apply, targetMode, now) {
  const categories = Object.fromEntries(CATEGORY_NAMES.map(name => [name, {
    success: { count: 0, ids: [] },
    skipped: { count: 0, ids: [] },
    failed: { count: 0, ids: [] }
  }]));
  const statuses = Object.fromEntries(CATEGORY_NAMES.map(name => [name, new Map()]));
  const errors = {};
  const report = {
    tool: 'legacy-ownership-admin',
    schemaVersion: 1,
    projectId,
    mode: apply ? 'apply' : 'dry-run',
    targetMode,
    generatedAt: now(),
    owner: { uid: identity.uid, email: identity.email },
    categories,
    auditFailures: [],
    ambiguousCommitRereads: [],
    remainingResponseLeakCount: 0,
    remainingResponseLeakIds: [],
    safeToDeployStrictRules: false,
    auditDigestKind: 'checksum',
    auditDigestAlgorithm: 'sha256',
    auditDigest: ''
  };

  function record(category, status, id, error) {
    const previous = statuses[category].get(id);
    if (previous === 'failed' && status !== 'failed') return;
    if (previous === status) return;
    if (previous) {
      const bucket = categories[category][previous];
      bucket.ids = bucket.ids.filter(value => value !== id);
      bucket.count = bucket.ids.length;
    }
    statuses[category].set(id, status);
    const bucket = categories[category][status];
    bucket.ids.push(id);
    bucket.ids.sort();
    bucket.count = bucket.ids.length;
    if (error) errors[category + ':' + id] = String(error && error.message || error);
  }

  function auditFailure(category, id, reason) {
    const key = category + ':' + id + ':' + reason;
    if (report.auditFailures.some(item => item.key === key)) return;
    report.auditFailures.push({ key, category, id, reason });
  }

  return { report, statuses, errors, record, auditFailure };
}

async function readDocument(db, path) {
  const snapshot = await db.doc(path).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function verifiedIdentity(db, auth, ownerUid, expectedEmail) {
  const config = expectedEmail
    ? { uid: ownerUid, email: expectedEmail }
    : await readDocument(db, 'config/legacy_owner');
  if (!config || config.uid !== ownerUid || typeof config.email !== 'string') {
    throw new Error('The Admin-only legacy owner config must match the canonical owner UID.');
  }
  const normalizedConfigEmail = migrationCore.normalizeEmail(config.email);
  if (!normalizedConfigEmail || config.email !== normalizedConfigEmail) {
    throw new Error('The legacy owner config email must already be canonical lowercase with no whitespace.');
  }
  const user = await auth.getUser(ownerUid);
  const normalizedUserEmail = migrationCore.normalizeEmail(user && user.email);
  const googleProvider = (user && user.providerData || []).some(provider =>
    provider && provider.providerId === 'google.com' &&
    migrationCore.normalizeEmail(provider.email || user.email) === normalizedConfigEmail
  );
  if (!user || user.uid !== ownerUid || user.emailVerified !== true || !googleProvider ||
      normalizedUserEmail !== normalizedConfigEmail) {
    throw new Error('The canonical legacy owner must be a verified Google Auth user with the configured email.');
  }
  const allowance = await readDocument(db, 'teacher_allowlist/' + normalizedConfigEmail);
  if (!allowance || allowance.enabled !== true || !['teacher', 'admin'].includes(allowance.role)) {
    throw new Error('The canonical legacy owner must have an enabled teacher allowlist record.');
  }
  return { uid: ownerUid, email: normalizedConfigEmail, role: allowance.role };
}

async function enumerate(db) {
  const result = Object.fromEntries(CATEGORY_NAMES.map(name => [name, new Map()]));
  result.unexpectedPaths = [];
  const add = (category, id, document) => result[category].set(id, {
    id,
    path: document.ref.path,
    documentId: document.id,
    data: document.data()
  });
  const [sets, sessions, images, snapshots, snapshotImages, students, responses, grades] =
    await Promise.all([
      db.collection('quiz_sets').get(),
      db.collection('sessions').get(),
      db.collectionGroup('q').get(),
      db.collectionGroup('snapshot').get(),
      db.collectionGroup('snapshot_images').get(),
      db.collectionGroup('students').get(),
      db.collectionGroup('responses').get(),
      db.collectionGroup('grades').get()
    ]);
  sets.docs.forEach(document => add('sets', document.id, document));
  sessions.docs.forEach(document => add('sessions', document.id, document));
  images.docs.forEach(document => {
    const match = /^images\/([^/]+)\/q\/([^/]+)$/.exec(document.ref.path);
    if (match) add('images', match[1] + '/' + match[2], document);
    else result.unexpectedPaths.push(document.ref.path);
  });
  snapshots.docs.forEach(document => {
    const match = /^sessions\/([^/]+)\/snapshot\/set$/.exec(document.ref.path);
    if (match) add('snapshots', match[1] + '/set', document);
    else result.unexpectedPaths.push(document.ref.path);
  });
  snapshotImages.docs.forEach(document => {
    const match = /^sessions\/([^/]+)\/snapshot_images\/([^/]+)$/.exec(document.ref.path);
    if (match) add('snapshots', match[1] + '/image/' + match[2], document);
    else result.unexpectedPaths.push(document.ref.path);
  });
  for (const [category, snapshot] of [
    ['students', students], ['responses', responses], ['grades', grades]
  ]) {
    snapshot.docs.forEach(document => {
      const match = new RegExp('^sessions/([^/]+)/' + category + '/([^/]+)$').exec(document.ref.path);
      if (match) add(category, match[1] + '/' + match[2], document);
      else result.unexpectedPaths.push(document.ref.path);
    });
  }
  result.unexpectedPaths.sort();
  return result;
}

function errorCode(error) {
  const raw = String(error && error.code != null ? error.code : '').trim();
  const numeric = /^(\d+)(?:\s+.*)?$/.exec(raw);
  const grpcCodes = {
    1: 'cancelled',
    2: 'unknown',
    4: 'deadline-exceeded',
    8: 'resource-exhausted',
    10: 'aborted',
    13: 'internal',
    14: 'unavailable',
    15: 'data-loss'
  };
  if (numeric && grpcCodes[Number(numeric[1])]) return grpcCodes[Number(numeric[1])];
  return raw.toLowerCase().replace(/_/g, '-');
}

function validateNormalizedImages(images) {
  const result = {};
  const errors = [];
  const prototype = images != null && typeof images === 'object'
    ? Object.getPrototypeOf(images) : null;
  if (images != null && (typeof images !== 'object' || Array.isArray(images) ||
      (prototype !== Object.prototype && prototype !== null))) {
    return { images: result, errors: [{ key: '*', reason: 'snapshotImages must be a map.' }] };
  }
  const safeComponent = digits => {
    const value = Number(digits);
    return Number.isSafeInteger(value) && value >= 0 && String(value) === digits
      ? digits : '';
  };
  for (const [key, data] of Object.entries(images || {})) {
    const legacy = /^(0|[1-9]\d*)$/.exec(key);
    const versioned = /^v(0|[1-9]\d*)q(0|[1-9]\d*)$/.exec(key);
    const legacyQuestion = legacy && safeComponent(legacy[1]);
    const videoIndex = versioned && safeComponent(versioned[1]);
    const questionIndex = versioned && safeComponent(versioned[2]);
    const id = legacyQuestion ? 'v0q' + legacyQuestion
      : videoIndex && questionIndex ? 'v' + videoIndex + 'q' + questionIndex : '';
    if (!id) {
      errors.push({ key, reason: 'Snapshot image key is not canonicalizable.' });
    } else if (typeof data !== 'string' || !data) {
      errors.push({ key, reason: 'Snapshot image data must be a nonempty string.' });
    } else if (own(result, id)) {
      errors.push({ key, reason: 'Snapshot image aliases collide at ' + id + '.' });
    } else {
      result[id] = data;
    }
  }
  return { images: result, errors };
}

function gradeValue(grade) {
  return {
    uid: grade.uid,
    questionIndex: grade.questionIndex,
    revision: grade.revision,
    ok: grade.ok
  };
}

function validGrade(id, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (!sameValue(keys, ['ok', 'questionIndex', 'revision', 'uid'])) return false;
  return typeof value.uid === 'string' && value.uid.length > 0 &&
    Number.isSafeInteger(value.questionIndex) && value.questionIndex >= 0 &&
    Number.isSafeInteger(value.revision) && value.revision > 0 &&
    typeof value.ok === 'boolean' && id === value.uid + '__' + value.questionIndex;
}

async function runLegacyMigration(options) {
  const {
    db, auth, projectId, ownerUid, apply = false, confirmProject = '',
    provisionOwnerEmail = '', targetMode = 'production',
    now = () => new Date().toISOString()
  } = options || {};
  if (!db || !auth || !projectId || !ownerUid) {
    throw new Error('db, auth, projectId, and ownerUid are required.');
  }
  if (apply && confirmProject !== projectId) {
    throw new Error('Apply requires an exact project confirmation.');
  }
  const internalIdentity = options && options[INTERNAL_VERIFIED_IDENTITY];
  let identity;
  let ownerConfigAction = '';
  if (internalIdentity) {
    if (apply || provisionOwnerEmail || internalIdentity.uid !== ownerUid) {
      throw new Error('Internal post-removal audit identity is invalid.');
    }
    identity = await verifiedIdentity(db, auth, ownerUid, internalIdentity.email);
  } else if (provisionOwnerEmail) {
    if (!apply) throw new Error('Provisioning the legacy owner requires apply mode.');
    const canonical = migrationCore.normalizeEmail(provisionOwnerEmail);
    if (canonical !== provisionOwnerEmail) {
      throw new Error('The provisioned legacy owner email must be canonical.');
    }
    identity = await verifiedIdentity(db, auth, ownerUid, canonical);
    ownerConfigAction = await db.runTransaction(async transaction => {
      const reference = db.doc('config/legacy_owner');
      const current = await transaction.get(reference);
      if (current.exists) {
        const value = current.data() || {};
        if (value.uid === ownerUid && value.email === canonical) return 'matched';
        throw new Error('The Admin-only legacy owner config already exists with a mismatch.');
      }
      transaction.create(reference, { uid: ownerUid, email: canonical });
      return 'created';
    });
  } else {
    identity = await verifiedIdentity(db, auth, ownerUid);
  }

  const tracker = createReport(projectId, identity, apply, targetMode, now);
  const { report, statuses, errors, record, auditFailure } = tracker;
  if (ownerConfigAction) report.ownerConfigAction = ownerConfigAction;
  function finalizeReport() {
    if (Object.keys(errors).length) report.errors = errors;
    report.auditFailures = report.auditFailures.map(({ key, ...item }) => item);
    const categoryFailureCount = CATEGORY_NAMES.reduce(
      (sum, category) => sum + report.categories[category].failed.count,
      0
    );
    report.safeToDeployStrictRules = categoryFailureCount === 0 &&
      report.auditFailures.length === 0 &&
      report.ambiguousCommitRereads.length === 0 &&
      report.remainingResponseLeakCount === 0;
    return attachAuditDigest(report);
  }
  function auditEnumerationPaths(data) {
    (data.unexpectedPaths || []).forEach(path => {
      auditFailure('enumeration-path', path, 'Unexpected collection-group path.');
    });
  }
  let initial;
  try {
    initial = await enumerate(db);
  } catch (error) {
    auditFailure('enumeration', 'initial', String(error && error.message || error));
    return finalizeReport();
  }
  auditEnumerationPaths(initial);
  const changedParents = { sets: new Set(), sessions: new Set() };

  async function migrateParent(category, item, uidField, emailField) {
    const current = item.data || {};
    if (current[uidField] && current[uidField] !== identity.uid) {
      record(category, 'skipped', item.id);
      return;
    }
    const desired = current[uidField] === identity.uid && current[emailField] === identity.email;
    if (desired) {
      record(category, 'skipped', item.id);
      return;
    }
    if (!apply) {
      record(category, 'success', item.id);
      changedParents[category].add(item.id);
      return;
    }
    try {
      const outcome = await db.runTransaction(async transaction => {
        const fresh = await transaction.get(db.doc(item.path));
        if (!fresh.exists) return 'missing';
        const data = fresh.data() || {};
        if (data[uidField] && data[uidField] !== identity.uid) return 'other-owner';
        if (data[uidField] === identity.uid && data[emailField] === identity.email) return 'done';
        transaction.set(db.doc(item.path), {
          [uidField]: identity.uid,
          [emailField]: identity.email
        }, { merge: true });
        return 'changed';
      });
      if (outcome === 'missing') record(category, 'failed', item.id, new Error('Document disappeared.'));
      else if (outcome === 'other-owner' || outcome === 'done') record(category, 'skipped', item.id);
      else {
        record(category, 'success', item.id);
        changedParents[category].add(item.id);
      }
    } catch (error) {
      const reread = await readDocument(db, item.path).catch(() => null);
      const confirmed = !!reread && reread[uidField] === identity.uid &&
        reread[emailField] === identity.email;
      if (AMBIGUOUS_CODES.has(errorCode(error))) {
        report.ambiguousCommitRereads.push({ category, id: item.id, confirmed, code: errorCode(error) });
      }
      if (confirmed) {
        record(category, 'success', item.id);
        changedParents[category].add(item.id);
      } else record(category, 'failed', item.id, error);
    }
  }

  for (const item of initial.sets.values()) {
    await migrateParent('sets', item, 'ownerUid', 'ownerEmail');
  }
  for (const item of initial.sessions.values()) {
    await migrateParent('sessions', item, 'teacherUid', 'teacherEmail');
  }

  let parentsAfterClaim;
  try {
    parentsAfterClaim = apply ? await enumerate(db) : initial;
  } catch (error) {
    auditFailure('enumeration', 'after-parent-claims', String(error && error.message || error));
    return finalizeReport();
  }
  auditEnumerationPaths(parentsAfterClaim);
  for (const item of initial.images.values()) {
    const setId = item.id.split('/')[0];
    const parent = parentsAfterClaim.sets.get(setId);
    if (!parent) record('images', 'failed', item.id, new Error('Image has no quiz set parent.'));
    else record('images', changedParents.sets.has(setId) ? 'success' : 'skipped', item.id);
  }
  for (const item of initial.students.values()) {
    const sessionId = item.id.split('/')[0];
    const parent = parentsAfterClaim.sessions.get(sessionId);
    if (!parent) record('students', 'failed', item.id, new Error('Student has no session parent.'));
    else record('students', changedParents.sessions.has(sessionId) ? 'success' : 'skipped', item.id);
  }

  for (const item of initial.grades.values()) {
    const gradeId = item.id.slice(item.id.indexOf('/') + 1);
    if (validGrade(gradeId, item.data)) record('grades', 'skipped', item.id);
    else record('grades', 'failed', item.id, new Error('Existing private grade is malformed.'));
  }

  async function createIfMissing(category, id, path, value) {
    let existing;
    try {
      existing = await readDocument(db, path);
    } catch (error) {
      record(category, 'failed', id, error);
      return;
    }
    if (existing) {
      if (sameValue(existing, value)) record(category, 'skipped', id);
      else record(category, 'failed', id, new Error('Existing document conflicts with legacy source.'));
      return;
    }
    if (!apply) {
      record(category, 'success', id);
      return;
    }
    try {
      await db.runTransaction(async transaction => {
        const fresh = await transaction.get(db.doc(path));
        if (fresh.exists) {
          if (!sameValue(fresh.data(), value)) throw new Error('Existing document conflicts with legacy source.');
          return;
        }
        transaction.create(db.doc(path), value);
      });
      record(category, 'success', id);
    } catch (error) {
      const reread = await readDocument(db, path).catch(() => null);
      const confirmed = !!reread && sameValue(reread, value);
      if (AMBIGUOUS_CODES.has(errorCode(error))) {
        report.ambiguousCommitRereads.push({ category, id, confirmed, code: errorCode(error) });
      }
      if (confirmed) record(category, 'success', id);
      else record(category, 'failed', id, error);
    }
  }

  for (const session of parentsAfterClaim.sessions.values()) {
    const sessionId = session.id;
    const sessionData = session.data || {};
    const snapshotId = sessionId + '/set';
    const snapshotPath = 'sessions/' + sessionId + '/snapshot/set';
    const existingSet = initial.snapshots.get(snapshotId);
    const existingImages = [...initial.snapshots.values()].filter(item =>
      item.id.startsWith(sessionId + '/image/')
    );
    const sourceSet = sessionData.setSnapshot;
    const hasSourceSet = !!sourceSet && typeof sourceSet === 'object' && !Array.isArray(sourceSet);
    const imageValidation = validateNormalizedImages(sessionData.snapshotImages);
    if (imageValidation.errors.length) {
      record('snapshots', 'failed', snapshotId,
        new Error('Embedded snapshotImages cannot be preserved losslessly.'));
      imageValidation.errors.forEach(error => record(
        'snapshots', 'failed', sessionId + '/source-image/' + error.key,
        new Error(error.reason)
      ));
      continue;
    }
    if (Object.keys(imageValidation.images).length && !hasSourceSet) {
      record('snapshots', 'failed', snapshotId,
        new Error('Embedded snapshotImages exist without an embedded setSnapshot.'));
      continue;
    }
    if (hasSourceSet) {
      const desiredSet = { ...sourceSet };
      delete desiredSet.id;
      await createIfMissing('snapshots', snapshotId, snapshotPath, desiredSet);
      const sourceImages = imageValidation.images;
      for (const [imageId, data] of Object.entries(sourceImages)) {
        await createIfMissing(
          'snapshots', sessionId + '/image/' + imageId,
          'sessions/' + sessionId + '/snapshot_images/' + imageId,
          { data }
        );
      }
      for (const image of existingImages) {
        if (!own(sourceImages, image.documentId)) record('snapshots', 'skipped', image.id);
      }
    } else {
      if (existingSet) record('snapshots', 'skipped', snapshotId);
      existingImages.forEach(image => record('snapshots', 'skipped', image.id));
    }
    const hasOrWillHaveSet = !!existingSet || hasSourceSet;
    if (hasOrWillHaveSet && sessionData.snapshotVersion != null && sessionData.snapshotVersion !== 1) {
      record('snapshots', 'failed', snapshotId,
        new Error('Unknown existing snapshotVersion must not be overwritten.'));
    } else if (hasOrWillHaveSet && sessionData.snapshotVersion !== 1) {
      if (!apply) record('snapshots', 'success', snapshotId);
      else {
        try {
          await db.runTransaction(async transaction => {
            const parent = await transaction.get(db.doc('sessions/' + sessionId));
            const set = await transaction.get(db.doc(snapshotPath));
            if (!parent.exists || !set.exists) throw new Error('Snapshot set or session is missing.');
            transaction.set(db.doc('sessions/' + sessionId), { snapshotVersion: 1 }, { merge: true });
          });
          record('snapshots', 'success', snapshotId);
        } catch (error) {
          record('snapshots', 'failed', snapshotId, error);
        }
      }
    }
  }

  for (const item of initial.responses.values()) {
    const slash = item.id.indexOf('/');
    const sessionId = item.id.slice(0, slash);
    const studentId = item.id.slice(slash + 1);
    const prepared = migrationCore.prepareLegacyResponse(studentId, item.data);
    if (prepared.status === 'skip') {
      record('responses', 'skipped', item.id);
      continue;
    }
    if (prepared.status === 'failed') {
      record('responses', 'failed', item.id, new Error(prepared.reason));
      continue;
    }
    const desiredGrades = prepared.grades.map(grade => ({
      ...grade,
      reportId: sessionId + '/' + grade.id,
      path: 'sessions/' + sessionId + '/grades/' + grade.id,
      value: gradeValue(grade)
    }));
    const conflicts = [];
    let gradeReadError = null;
    for (const grade of desiredGrades) {
      let current;
      try {
        current = await readDocument(db, grade.path);
      } catch (error) {
        gradeReadError = error;
        record('grades', 'failed', grade.reportId, error);
        break;
      }
      if (current && !sameValue(current, grade.value)) conflicts.push(grade);
    }
    if (gradeReadError) {
      record('responses', 'failed', item.id, gradeReadError);
      continue;
    }
    if (conflicts.length) {
      record('responses', 'failed', item.id, new Error('Existing private grade conflicts with legacy grading.'));
      conflicts.forEach(grade => record('grades', 'failed', grade.reportId,
        new Error('Existing private grade conflicts with legacy grading.')));
      continue;
    }
    if (!apply) {
      record('responses', 'success', item.id);
      desiredGrades.forEach(grade => {
        if (!initial.grades.has(grade.reportId)) record('grades', 'success', grade.reportId);
      });
      continue;
    }
    try {
      await db.runTransaction(async transaction => {
        const responseReference = db.doc(item.path);
        const freshResponse = await transaction.get(responseReference);
        if (!freshResponse.exists) throw new Error('Response disappeared.');
        const freshPrepared = migrationCore.prepareLegacyResponse(studentId, freshResponse.data());
        if (freshPrepared.status === 'skip') return;
        if (freshPrepared.status === 'failed') throw new Error(freshPrepared.reason);
        const freshGrades = freshPrepared.grades.map(grade => ({
          reference: db.doc('sessions/' + sessionId + '/grades/' + grade.id),
          value: gradeValue(grade)
        }));
        const gradeSnapshots = [];
        for (const grade of freshGrades) gradeSnapshots.push(await transaction.get(grade.reference));
        gradeSnapshots.forEach((snapshot, index) => {
          if (snapshot.exists && !sameValue(snapshot.data(), freshGrades[index].value)) {
            throw new Error('Existing private grade conflicts with legacy grading.');
          }
        });
        freshGrades.forEach((grade, index) => {
          if (!gradeSnapshots[index].exists) transaction.create(grade.reference, grade.value);
        });
        transaction.set(responseReference, freshPrepared.response);
      });
      record('responses', 'success', item.id);
      desiredGrades.forEach(grade => {
        if (!initial.grades.has(grade.reportId)) record('grades', 'success', grade.reportId);
      });
    } catch (error) {
      const rereadResponse = await readDocument(db, item.path).catch(() => null);
      let confirmed = !!rereadResponse && sameValue(rereadResponse, prepared.response);
      for (const grade of desiredGrades) {
        const rereadGrade = await readDocument(db, grade.path).catch(() => null);
        confirmed = confirmed && !!rereadGrade && sameValue(rereadGrade, grade.value);
      }
      if (AMBIGUOUS_CODES.has(errorCode(error))) {
        report.ambiguousCommitRereads.push({
          category: 'responses', id: item.id, confirmed, code: errorCode(error)
        });
      }
      if (confirmed) {
        record('responses', 'success', item.id);
        desiredGrades.forEach(grade => {
          if (!initial.grades.has(grade.reportId)) record('grades', 'success', grade.reportId);
        });
      } else record('responses', 'failed', item.id, error);
    }
  }

  // Re-validate identity and immediately re-enumerate before producing the checksummed audit report.
  let finalIdentity;
  try {
    finalIdentity = await verifiedIdentity(
      db, auth, ownerUid, internalIdentity ? identity.email : undefined
    );
  } catch (error) {
    auditFailure('identity', ownerUid, String(error && error.message || error));
    return finalizeReport();
  }
  if (!sameValue(finalIdentity, identity)) {
    auditFailure('identity', ownerUid, 'Authoritative identity changed during migration.');
  }
  let finalData;
  try {
    finalData = await enumerate(db);
  } catch (error) {
    auditFailure('enumeration', 'final', String(error && error.message || error));
    return finalizeReport();
  }
  auditEnumerationPaths(finalData);

  for (const category of CATEGORY_NAMES) {
    for (const id of finalData[category].keys()) {
      if (!statuses[category].has(id)) {
        record(category, 'failed', id, new Error('Final document was not covered by this run.'));
        auditFailure(category, id, 'Final document was not covered by this run.');
      }
    }
    for (const id of statuses[category].keys()) {
      if (!finalData[category].has(id)) {
        auditFailure(category, id, 'Reported document is absent from the final enumeration.');
      }
    }
  }

  for (const item of finalData.sets.values()) {
    const data = item.data || {};
    if (!data.ownerUid) auditFailure('sets', item.id, 'Ownerless quiz set remains.');
    if (data.ownerUid === identity.uid && data.ownerEmail !== identity.email) {
      auditFailure('sets', item.id, 'Canonical owner email metadata does not match.');
    }
  }
  for (const item of finalData.sessions.values()) {
    const data = item.data || {};
    if (!data.teacherUid) auditFailure('sessions', item.id, 'Ownerless session remains.');
    if (data.teacherUid === identity.uid && data.teacherEmail !== identity.email) {
      auditFailure('sessions', item.id, 'Canonical teacher email metadata does not match.');
    }
    const setId = item.id + '/set';
    const set = finalData.snapshots.get(setId);
    const images = [...finalData.snapshots.values()].filter(snapshot =>
      snapshot.id.startsWith(item.id + '/image/')
    );
    if ((data.snapshotVersion != null || images.length) && !set) {
      auditFailure('snapshots', item.id, 'snapshotVersion or snapshot images exist without snapshot/set.');
    }
    if (set && data.snapshotVersion !== 1) {
      auditFailure('snapshots', item.id, 'snapshot/set exists without snapshotVersion 1.');
    }
    const hasEmbeddedSet = !!data.setSnapshot && typeof data.setSnapshot === 'object' &&
      !Array.isArray(data.setSnapshot);
    const imageValidation = validateNormalizedImages(data.snapshotImages);
    imageValidation.errors.forEach(error => {
      const id = item.id + '/source-image/' + error.key;
      record('snapshots', 'failed', id, new Error(error.reason));
      auditFailure('snapshots', id, error.reason);
    });
    if (Object.keys(imageValidation.images).length && !hasEmbeddedSet) {
      record('snapshots', 'failed', item.id + '/set',
        new Error('Embedded snapshotImages exist without an embedded setSnapshot.'));
      auditFailure('snapshots', item.id,
        'Embedded snapshotImages exist without an embedded setSnapshot.');
    }
    if (hasEmbeddedSet) {
      const expectedSet = { ...data.setSnapshot };
      delete expectedSet.id;
      if (!set || !sameValue(set.data, expectedSet)) {
        auditFailure('snapshots', item.id, 'Embedded setSnapshot is not completely preserved.');
      }
      const expectedImages = imageValidation.images;
      for (const [imageId, imageData] of Object.entries(expectedImages)) {
        const image = finalData.snapshots.get(item.id + '/image/' + imageId);
        if (!image || !sameValue(image.data, { data: imageData })) {
          auditFailure('snapshots', item.id + '/image/' + imageId,
            'Embedded snapshot image is not completely preserved.');
        }
      }
    }
  }

  for (const item of finalData.images.values()) {
    const setId = item.id.split('/')[0];
    if (!finalData.sets.has(setId)) {
      record('images', 'failed', item.id, new Error('Image parent quiz set is missing.'));
      auditFailure('images', item.id, 'Image parent quiz set is missing.');
    }
  }
  for (const category of ['snapshots', 'students', 'responses', 'grades']) {
    for (const item of finalData[category].values()) {
      const sessionId = item.id.split('/')[0];
      if (!finalData.sessions.has(sessionId)) {
        record(category, 'failed', item.id, new Error('Session parent is missing.'));
        auditFailure(category, item.id, 'Session parent is missing.');
      }
    }
  }

  const leaks = [];
  for (const item of finalData.responses.values()) {
    if (migrationCore.responseLeakPaths(item.data).length) leaks.push(item.id);
  }
  report.remainingResponseLeakIds = leaks.sort();
  report.remainingResponseLeakCount = report.remainingResponseLeakIds.length;
  for (const item of finalData.grades.values()) {
    const gradeId = item.id.slice(item.id.indexOf('/') + 1);
    if (!validGrade(gradeId, item.data)) {
      auditFailure('grades', item.id, 'Malformed private grade remains.');
    }
  }

  return finalizeReport();
}

async function removeLegacyOwner(options) {
  const {
    db, auth, projectId, ownerUid, apply = false, confirmProject = '',
    targetMode = 'production', now = () => new Date().toISOString()
  } = options || {};
  if (!db || !auth || !projectId || !ownerUid) {
    throw new Error('db, auth, projectId, and ownerUid are required.');
  }
  if (!apply || confirmProject !== projectId) {
    throw new Error('Legacy owner removal requires apply and an exact project confirmation.');
  }
  const identity = await verifiedIdentity(db, auth, ownerUid);
  const preRemovalAudit = await runLegacyMigration({
    db, auth, projectId, ownerUid, apply: false, targetMode, now
  });
  const report = {
    tool: 'legacy-owner-removal-admin',
    schemaVersion: 1,
    projectId,
    mode: 'apply',
    targetMode,
    generatedAt: now(),
    owner: { uid: identity.uid, email: identity.email },
    action: preRemovalAudit.safeToDeployStrictRules ? 'pending-removal' : 'blocked',
    preRemovalAudit,
    postRemovalAudit: null,
    migrationAudit: preRemovalAudit,
    ownerConfigAbsent: false,
    safeToRemoveOwner: false,
    recoveryInstructions: ''
  };
  if (!preRemovalAudit.safeToDeployStrictRules) return attachAuditDigest(report);

  await db.runTransaction(async transaction => {
    const reference = db.doc('config/legacy_owner');
    const current = await transaction.get(reference);
    const value = current.exists ? current.data() || {} : null;
    if (!value || value.uid !== identity.uid || value.email !== identity.email) {
      throw new Error('The Admin-only legacy owner config no longer matches the canonical owner.');
    }
    transaction.delete(reference);
  });

  try {
    report.postRemovalAudit = await runLegacyMigration({
      db, auth, projectId, ownerUid, apply: false, targetMode, now,
      [INTERNAL_VERIFIED_IDENTITY]: identity
    });
    report.migrationAudit = report.postRemovalAudit;
  } catch (error) {
    report.postRemovalAuditError = String(error && error.message || error);
  }
  let ownerConfigReadError = '';
  try {
    report.ownerConfigAbsent = await readDocument(db, 'config/legacy_owner') === null;
  } catch (error) {
    ownerConfigReadError = String(error && error.message || error);
  }
  if (ownerConfigReadError) report.ownerConfigReadError = ownerConfigReadError;
  const postAuditClean = !!report.postRemovalAudit &&
    report.postRemovalAudit.safeToDeployStrictRules === true;
  if (report.ownerConfigAbsent && postAuditClean) {
    report.action = 'removed';
    report.safeToRemoveOwner = true;
  } else {
    report.action = 'removed-post-audit-failed';
    report.recoveryInstructions = 'A trusted Admin operator may re-provision the same exact owner ' +
      'with --provision-owner-email, remediate the reported findings, and rerun migration and removal.';
  }
  return attachAuditDigest(report);
}

module.exports = {
  CATEGORY_NAMES,
  enumerate,
  parseCliArgs,
  removeLegacyOwner,
  runLegacyMigration,
  verifiedIdentity
};
