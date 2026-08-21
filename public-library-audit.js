'use strict';

const PublicQuizLibraryCore = require('./public-quiz-library-core.js');

const PARENT_KEYS = new Set(PublicQuizLibraryCore.PUBLIC_PARENT_KEYS.concat([
  'buildToken', 'buildVideoCount', 'buildQuestionCount', 'buildImageCount', 'buildMutation'
]));
const VIDEO_KEYS = new Set([
  'videoKey', 'videoId', 'videoUrl', 'startSec', 'endSec', 'revision', 'buildToken'
]);
const QUESTION_KEYS = new Set([
  'type', 't', 'text', 'choices', 'answer', 'answers', 'accept', 'imgUp', 'imgUrl',
  'explain', 'explainImgUp', 'explainImgUrl', 'limitSec',
  'questionKey', 'videoKey', 'revision', 'buildToken'
]);
const IMAGE_KEYS = new Set(['data', 'revision', 'buildToken']);
const AUDIT_KEYS = new Set([
  'publicationId', 'revision', 'status', 'moderatedByUid',
  'moderationReason', 'moderatedAt', 'restoredAt', 'restoredByUid'
]);
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'ownerUid', 'ownerEmail', 'email', 'emailCanonical', 'uid', 'studentUid',
  'reviewerEmail', 'reviewNotes'
]);

function parseAuditArguments(argv, environment = process.env) {
  const result = {
    projectId: '', targetMode: '', maxDocuments: 0, outputPath: '', dryRun: true
  };
  const valueOptions = new Map([
    ['--project', 'projectId'], ['--target-mode', 'targetMode'],
    ['--max-documents', 'maxDocuments'], ['--output', 'outputPath']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') continue;
    if (argument === '--apply') throw new Error('public-library audit is dry-run/read-only only.');
    const field = valueOptions.get(argument);
    if (!field || index + 1 >= argv.length) {
      throw new Error('Unknown or incomplete audit argument: ' + argument);
    }
    result[field] = argv[index + 1];
    index += 1;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (!['production', 'emulator'].includes(result.targetMode)) {
    throw new Error('--target-mode production|emulator is required.');
  }
  result.maxDocuments = Number(result.maxDocuments);
  if (!Number.isSafeInteger(result.maxDocuments) ||
      result.maxDocuments < 1 || result.maxDocuments > 10000) {
    throw new Error('--max-documents must be an integer from 1 to 10000.');
  }
  const firestoreHost = String(environment.FIRESTORE_EMULATOR_HOST || '');
  const authHost = String(environment.FIREBASE_AUTH_EMULATOR_HOST || '');
  if (result.targetMode === 'emulator') {
    if (!/^demo-[A-Za-z0-9_-]+$/.test(result.projectId)) {
      throw new Error('emulator target requires an exact demo-* project ID.');
    }
    if (!/^(127\.0\.0\.1|localhost):8080$/.test(firestoreHost)) {
      throw new Error('emulator target requires FIRESTORE_EMULATOR_HOST on localhost:8080.');
    }
    if (authHost) {
      throw new Error('read-only Firestore audit refuses an unrelated Auth emulator target.');
    }
  } else if (firestoreHost || authHost) {
    throw new Error('production target refuses Firestore/Auth emulator environment variables.');
  }
  return result;
}

function dataOf(snapshot) {
  return snapshot && snapshot.exists === false ? null : snapshot && snapshot.data
    ? snapshot.data() || {} : null;
}

function recursiveForbiddenKeys(value, path = '') {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...recursiveForbiddenKeys(
      item, `${path}[${index}]`
    )));
  } else if (value && typeof value === 'object' &&
      !(value instanceof Date) && typeof value.toMillis !== 'function') {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) findings.push(nextPath);
      findings.push(...recursiveForbiddenKeys(item, nextPath));
    }
  }
  return findings;
}

function unknownKeys(value, allowed) {
  return Object.keys(value || {}).filter(key => !allowed.has(key));
}

function contentRevisionToken(value) {
  if (typeof value === 'string') {
    const revision = value.trim();
    return revision && revision.length <= 200 ? revision : '';
  }
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value instanceof Date && Number.isSafeInteger(value.getTime()) && value.getTime() >= 0) {
    return String(value.getTime());
  }
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    if (!Number.isSafeInteger(millis) || millis < 0) return '';
    if (Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 &&
        value.nanoseconds < 1_000_000_000) {
      const revision = `${millis}:${value.nanoseconds}`;
      return revision.length <= 200 ? revision : '';
    }
    return String(millis);
  }
  if (value && Number.isInteger(value.seconds) && value.seconds >= 0 &&
      Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 &&
      value.nanoseconds < 1_000_000_000) {
    const revision = `${value.seconds}:${value.nanoseconds}`;
    return revision.length <= 200 ? revision : '';
  }
  return '';
}

async function auditPublicLibrary(options) {
  const db = options && options.db;
  const maxDocuments = Number(options && options.maxDocuments);
  if (!db || typeof db.collection !== 'function' ||
      !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 10000) {
    throw new Error('auditPublicLibrary requires db and maxDocuments 1..10000.');
  }
  const findings = [];
  const scanned = { parents: 0, audits: 0, videos: 0, questions: 0, images: 0, bindings: 0 };
  let remaining = maxDocuments;
  let complete = true;
  const parentMap = new Map();
  const auditMap = new Map();

  function finding(code, path, detail) {
    findings.push({ code, path, detail: String(detail || '') });
  }

  async function bounded(query, kind) {
    if (remaining < 1) {
      complete = false;
      finding('SCAN_LIMIT_REACHED', kind, 'No document budget remains.');
      return [];
    }
    const requested = remaining + 1;
    const snapshot = await query.limit(requested).get();
    const docs = snapshot.docs || [];
    if (docs.length > remaining) {
      complete = false;
      finding('SCAN_LIMIT_REACHED', kind, `More than ${remaining} documents remain.`);
    }
    const accepted = docs.slice(0, remaining);
    remaining -= accepted.length;
    scanned[kind] += accepted.length;
    return accepted;
  }

  const auditDocs = await bounded(db.collection('published_quiz_audits'), 'audits');
  for (const document of auditDocs) {
    const value = dataOf(document) || {};
    const path = document.ref && document.ref.path || `published_quiz_audits/${document.id}`;
    auditMap.set(document.id, value);
    const extra = unknownKeys(value, AUDIT_KEYS);
    if (extra.length) finding('AUDIT_UNKNOWN_FIELDS', path, extra.join(','));
    if (value.publicationId !== document.id ||
        !['moderated', 'restored'].includes(value.status)) {
      finding('AUDIT_MALFORMED', path, 'publicationId/status mismatch.');
    }
  }

  const parentDocs = await bounded(db.collection('published_quiz_sets'), 'parents');
  const gateSnapshot = await db.doc('publication_lifecycle_gates/current').get();
  scanned.bindings += 1;
  if (gateSnapshot.exists) {
    finding('LIFECYCLE_GATE_ACTIVE', 'publication_lifecycle_gates/current',
      'Public visibility is intentionally fail-closed.');
  }
  for (const document of parentDocs) {
    const value = dataOf(document) || {};
    const path = document.ref && document.ref.path || `published_quiz_sets/${document.id}`;
    parentMap.set(document.id, value);
    const extra = unknownKeys(value, PARENT_KEYS);
    if (extra.length) finding('PARENT_UNKNOWN_FIELDS', path, extra.join(','));
    for (const leaked of recursiveForbiddenKeys(value)) {
      finding('PUBLIC_PII_KEY', path, leaked);
    }
    const parent = Object.fromEntries(PublicQuizLibraryCore.PUBLIC_PARENT_KEYS
      .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    const validation = PublicQuizLibraryCore.validateParent(parent);
    if (!validation.ok || value.publicationId !== document.id || value.sourceSetId !== document.id) {
      finding('PARENT_MALFORMED', path, validation.errors.join(' '));
    }
    if (['building', 'cancelled'].includes(value.status)) {
      if (typeof value.buildToken !== 'string' || !value.buildToken ||
          !['buildVideoCount', 'buildQuestionCount', 'buildImageCount'].every(key =>
            Number.isSafeInteger(value[key]) && value[key] >= 0)) {
        finding('BUILD_TOMBSTONE_MALFORMED', path, 'build token/counters are invalid.');
      }
    }
    const audit = auditMap.get(document.id);
    if (value.status === 'moderated' &&
        (!audit || audit.status !== 'moderated' || audit.revision !== value.revision)) {
      finding('MODERATION_AUDIT_MISSING', path, 'moderated parent lacks exact audit.');
    }
    if (value.status === 'published') {
      if (remaining < 3) {
        complete = false;
        finding('SCAN_LIMIT_REACHED', path, 'Source/allowance/lock binding budget exhausted.');
        continue;
      }
      const sourceSnapshot = await db.doc(`quiz_sets/${document.id}`).get();
      remaining -= 1; scanned.bindings += 1;
      const source = dataOf(sourceSnapshot);
      if (!source || source.lifecycleState !== 'active' || source.trashedAt || source.purgeStartedAt ||
          contentRevisionToken(source.contentRevision) !== value.revision) {
        finding('VISIBLE_SOURCE_INACTIVE', path, 'source is missing, legacy, inactive, or stale.');
        continue;
      }
      const allowanceSnapshot = await db.doc(`teacher_allowances/${source.ownerUid || ''}`).get();
      const lockSnapshot = await db.doc(`publication_lifecycle_locks/${source.ownerUid || ''}`).get();
      remaining -= 2; scanned.bindings += 2;
      const allowance = dataOf(allowanceSnapshot);
      if (!allowance || allowance.uid !== source.ownerUid ||
          allowance.emailCanonical !== source.ownerEmail || allowance.status !== 'active' ||
          allowance.enabled !== true || !['teacher', 'admin'].includes(allowance.role)) {
        finding('VISIBLE_ALLOWANCE_INACTIVE', path, 'source owner allowance is not exact active.');
      }
      if (lockSnapshot.exists) {
        finding('VISIBLE_OWNER_LOCKED', path, 'source owner lifecycle lock exists.');
      }
    }
  }

  for (const [id, audit] of auditMap) {
    const parent = parentMap.get(id);
    if (!parent) finding('ORPHAN_AUDIT', `published_quiz_audits/${id}`, 'parent is missing.');
    else if (audit.status === 'moderated' &&
        (parent.status !== 'moderated' || parent.revision !== audit.revision)) {
      finding('MODERATION_AUDIT_PARITY', `published_quiz_audits/${id}`,
        'moderated audit does not match moderated parent.');
    }
  }

  for (const [collectionName, allowed] of [
    ['videos', VIDEO_KEYS], ['questions', QUESTION_KEYS], ['images', IMAGE_KEYS]
  ]) {
    const docs = await bounded(db.collectionGroup(collectionName), collectionName);
    for (const document of docs) {
      const path = document.ref && document.ref.path || '';
      if (!/^published_quiz_sets\/[^/]+\/(videos|questions|images)\/[^/]+$/.test(path)) {
        continue;
      }
      const value = dataOf(document) || {};
      const parentId = path.split('/')[1];
      const parent = parentMap.get(parentId);
      if (!parent) finding('ORPHAN_PUBLIC_CHILD', path, 'parent is missing.');
      else if (value.revision !== parent.revision) {
        finding('CHILD_REVISION_MISMATCH', path, 'child revision differs from parent.');
      }
      const extra = unknownKeys(value, allowed);
      if (extra.length) finding('CHILD_UNKNOWN_FIELDS', path, extra.join(','));
      for (const leaked of recursiveForbiddenKeys(value)) {
        finding('PUBLIC_PII_KEY', path, leaked);
      }
      if (typeof value.revision !== 'string' || !value.revision ||
          typeof value.buildToken !== 'string' || !value.buildToken) {
        finding('CHILD_BINDING_MALFORMED', path, 'revision/buildToken is invalid.');
      }
    }
  }

  return {
    kind: 'public-quiz-library-privacy-audit',
    dryRun: true,
    maxDocuments,
    scanned,
    complete,
    findings,
    safeToDeployPublicLibrary: complete && findings.length === 0
  };
}

module.exports = { auditPublicLibrary, parseAuditArguments };
