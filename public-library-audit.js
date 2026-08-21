'use strict';

const PublicQuizLibraryCore = require('./public-quiz-library-core.js');
const PublicAuthorLabelCore = require('./public-author-label-core.js');

const PARENT_KEYS = new Set(PublicQuizLibraryCore.PUBLIC_PARENT_KEYS.concat([
  'buildToken', 'buildVideoCount', 'buildQuestionCount', 'buildImageCount', 'buildMutation'
]));
const VIDEO_KEYS = new Set([
  'videoKey', 'videoId', 'videoUrl', 'startSec', 'endSec',
  'revision', 'schemaVersion', 'buildToken'
]);
const QUESTION_KEYS = new Set([
  'type', 't', 'text', 'choices', 'answer', 'answers', 'accept', 'imgUp', 'imgUrl',
  'explain', 'explainImgUp', 'explainImgUrl', 'limitSec',
  'questionKey', 'videoKey', 'revision', 'schemaVersion', 'buildToken'
]);
const IMAGE_KEYS = new Set(['data', 'revision', 'schemaVersion', 'buildToken']);
const AUDIT_KEYS = new Set([
  'publicationId', 'revision', 'status', 'moderatedByUid',
  'moderationReason', 'moderatedAt', 'restoredAt', 'restoredByUid'
]);
const LIFECYCLE_LOCK_KEYS = new Set([
  'ownerUid', 'ownerEmailCanonical', 'allowanceRevision', 'allowanceRole',
  'allowanceStatus', 'allowanceEnabled', 'reason', 'operationId',
  'initiatedByUid', 'initiatedByRole', 'createdAt'
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
  const scanned = {
    sources: 0, locks: 0, parents: 0, audits: 0,
    videos: 0, questions: 0, images: 0, bindings: 0, reads: 0
  };
  let remaining = maxDocuments;
  let complete = true;
  let limitFindingRecorded = false;
  const sourceMap = new Map();
  const ownerSources = new Map();
  const lockMap = new Map();
  const allowanceMap = new Map();
  const parentMap = new Map();
  const auditMap = new Map();

  function finding(code, path, detail) {
    findings.push({ code, path, detail: String(detail || '') });
  }

  function scanLimit(path, detail) {
    complete = false;
    if (!limitFindingRecorded) {
      limitFindingRecorded = true;
      finding('SCAN_LIMIT_REACHED', path, detail);
    }
  }

  async function bounded(query, kind) {
    if (remaining < 1) {
      scanLimit(kind, 'No document budget remains.');
      return [];
    }
    // Never issue the traditional remaining+1 completeness probe: the probe itself
    // is a document read. An exact boundary therefore fails closed as incomplete.
    const requested = remaining;
    const snapshot = await query.limit(requested).get();
    const docs = snapshot.docs || [];
    remaining -= docs.length;
    scanned[kind] += docs.length;
    scanned.reads += docs.length;
    if (docs.length === requested) {
      scanLimit(kind,
        `Reached the ${requested}-document boundary without an out-of-budget +1 probe.`);
    }
    return docs;
  }

  async function readDocument(path) {
    if (remaining < 1) {
      scanLimit(path, 'No document budget remains for the direct binding read.');
      return null;
    }
    remaining -= 1;
    scanned.bindings += 1;
    scanned.reads += 1;
    return db.doc(path).get();
  }

  function validTimestamp(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime());
    if (!value) return false;
    if (typeof value.toMillis === 'function') {
      try {
        return Number.isFinite(value.toMillis());
      } catch (_) {
        return false;
      }
    }
    return Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds) &&
      value.nanoseconds >= 0 && value.nanoseconds < 1_000_000_000;
  }

  function validLifecycleLock(ownerUid, value) {
    return value && unknownKeys(value, LIFECYCLE_LOCK_KEYS).length === 0 &&
      Object.keys(value).length === LIFECYCLE_LOCK_KEYS.size &&
      value.ownerUid === ownerUid && typeof ownerUid === 'string' && ownerUid.length > 0 &&
      typeof value.ownerEmailCanonical === 'string' &&
      /^[a-z0-9._%+\-]+@[a-z0-9.\-]+$/.test(value.ownerEmailCanonical) &&
      Number.isSafeInteger(value.allowanceRevision) && value.allowanceRevision >= 0 &&
      ['teacher', 'admin'].includes(value.allowanceRole) &&
      ['active', 'suspended'].includes(value.allowanceStatus) &&
      typeof value.allowanceEnabled === 'boolean' &&
      ['teacher-suspension', 'teacher-deletion-pending'].includes(value.reason) &&
      typeof value.operationId === 'string' && value.operationId.length >= 1 &&
      value.operationId.length <= 200 && typeof value.initiatedByUid === 'string' &&
      value.initiatedByUid.length >= 1 && ['teacher', 'admin'].includes(value.initiatedByRole) &&
      validTimestamp(value.createdAt);
  }

  function lifecycleBindingMatchesAllowance(value, allowance) {
    return allowance && allowance.uid === value.ownerUid &&
      allowance.emailCanonical === value.ownerEmailCanonical &&
      (Number.isSafeInteger(allowance.revision) ? allowance.revision : 0) ===
        value.allowanceRevision && allowance.role === value.allowanceRole &&
      allowance.status === value.allowanceStatus &&
      allowance.enabled === value.allowanceEnabled;
  }

  function lifecycleRecordsEqual(left, right) {
    if (!left || !right) return false;
    return [...LIFECYCLE_LOCK_KEYS].every(key => {
      if (key !== 'createdAt') return left[key] === right[key];
      const leftToken = left[key] instanceof Date ? left[key].getTime() :
        left[key] && typeof left[key].toMillis === 'function' ? left[key].toMillis() :
          left[key] && Number.isInteger(left[key].seconds) ?
            `${left[key].seconds}:${left[key].nanoseconds}` : null;
      const rightToken = right[key] instanceof Date ? right[key].getTime() :
        right[key] && typeof right[key].toMillis === 'function' ? right[key].toMillis() :
          right[key] && Number.isInteger(right[key].seconds) ?
            `${right[key].seconds}:${right[key].nanoseconds}` : null;
      return leftToken === rightToken;
    });
  }

  async function allowanceFor(uid) {
    if (allowanceMap.has(uid)) return allowanceMap.get(uid);
    const snapshot = await readDocument(`teacher_allowances/${uid}`);
    const allowance = dataOf(snapshot);
    allowanceMap.set(uid, allowance);
    return allowance;
  }

  const gateSnapshot = await readDocument('publication_lifecycle_gates/current');
  const gate = dataOf(gateSnapshot);
  if (gate) {
    finding('LIFECYCLE_GATE_ACTIVE', 'publication_lifecycle_gates/current',
      'Public visibility is intentionally fail-closed.');
  }

  const sourceDocs = await bounded(db.collection('quiz_sets'), 'sources');
  for (const document of sourceDocs) {
    const value = dataOf(document) || {};
    const path = document.ref && document.ref.path || `quiz_sets/${document.id}`;
    sourceMap.set(document.id, value);
    const owned = ownerSources.get(value.ownerUid) || [];
    if (typeof value.ownerUid === 'string' && value.ownerUid) {
      owned.push(document.id);
      ownerSources.set(value.ownerUid, owned);
    }
    if (!Object.hasOwn(value, 'lifecycleState')) {
      finding('LEGACY_SOURCE_LIFECYCLE_MISSING', path,
        'Source has no explicit lifecycleState and is fail-closed for deployment.');
    } else if (!['active', 'trashed', 'purging', 'copying'].includes(value.lifecycleState)) {
      finding('SOURCE_LIFECYCLE_MALFORMED', path, 'Source lifecycleState is invalid.');
    }
  }

  const lockDocs = await bounded(db.collection('publication_lifecycle_locks'), 'locks');
  for (const document of lockDocs) {
    const value = dataOf(document) || {};
    const path = document.ref && document.ref.path ||
      `publication_lifecycle_locks/${document.id}`;
    lockMap.set(document.id, value);
    if (!validLifecycleLock(document.id, value)) {
      finding('LIFECYCLE_LOCK_MALFORMED', path, 'Lock schema or owner binding is invalid.');
      continue;
    }
    const orphanReasons = [];
    if (!ownerSources.has(document.id)) orphanReasons.push('no globally scanned owner source');
    if (!gate || gate.ownerUid !== document.id) orphanReasons.push('no paired fixed gate');
    if (orphanReasons.length) {
      finding('ORPHAN_LIFECYCLE_LOCK', path, orphanReasons.join('; ') + '.');
    } else if (!lifecycleRecordsEqual(value, gate)) {
      finding('LIFECYCLE_LOCK_STALE', path, 'Lock and fixed lifecycle gate differ.');
    }
    const allowance = await allowanceFor(document.id);
    if (!lifecycleBindingMatchesAllowance(value, allowance)) {
      finding('LIFECYCLE_LOCK_STALE', path, 'Allowance identity or revision binding is stale.');
    }
  }

  if (gate) {
    const gatePath = 'publication_lifecycle_gates/current';
    const gateOwnerUid = typeof gate.ownerUid === 'string' ? gate.ownerUid : '';
    if (!validLifecycleLock(gateOwnerUid, gate)) {
      finding('LIFECYCLE_GATE_MALFORMED', gatePath, 'Gate schema is invalid.');
    }
    const pairedLock = lockMap.get(gateOwnerUid);
    if (!pairedLock) {
      finding('ORPHAN_LIFECYCLE_GATE', gatePath, 'Gate has no globally scanned owner lock.');
    } else if (!lifecycleRecordsEqual(gate, pairedLock)) {
      finding('LIFECYCLE_GATE_STALE', gatePath, 'Gate and owner lock differ.');
    }
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
    if (!PublicAuthorLabelCore.validate(value.authorDisplayName).ok) {
      finding('PUBLIC_AUTHOR_LABEL_UNSAFE', path,
        'Public author label is blank, email-shaped, or UID-like.');
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
      const source = sourceMap.get(document.id);
      if (!source || source.lifecycleState !== 'active' || source.trashedAt || source.purgeStartedAt ||
          contentRevisionToken(source.contentRevision) !== value.revision) {
        finding('VISIBLE_SOURCE_INACTIVE', path, 'source is missing, legacy, inactive, or stale.');
        continue;
      }
      const allowance = await allowanceFor(source.ownerUid || '');
      const publicAuthor = PublicAuthorLabelCore.validate(value.authorDisplayName, {
        emailCanonical: source.ownerEmail,
        uid: source.ownerUid
      });
      if (!publicAuthor.ok) {
        finding('PUBLIC_AUTHOR_LABEL_UNSAFE', path,
          'Public author label exposes the bound owner identity.');
      }
      if (!allowance || allowance.uid !== source.ownerUid ||
          allowance.emailCanonical !== source.ownerEmail || allowance.status !== 'active' ||
          allowance.enabled !== true || !['teacher', 'admin'].includes(allowance.role)) {
        finding('VISIBLE_ALLOWANCE_INACTIVE', path, 'source owner allowance is not exact active.');
      }
      if (allowance) {
        const allowanceAuthor = PublicAuthorLabelCore.validate(allowance.displayName, {
          emailCanonical: source.ownerEmail,
          uid: source.ownerUid
        });
        if (!allowanceAuthor.ok || publicAuthor.value !== allowanceAuthor.value) {
          finding('PUBLIC_AUTHOR_LABEL_PARITY', path,
            'Public author label does not match the public-safe authoritative allowance label.');
        }
      }
      if (lockMap.has(source.ownerUid)) {
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
      if (!Object.hasOwn(value, 'schemaVersion')) {
        finding('CHILD_SCHEMA_VERSION_MISSING', path,
          'Legacy child has no deploy-approved schema marker.');
      } else if (value.schemaVersion !== PublicQuizLibraryCore.PUBLIC_CHILD_SCHEMA_VERSION) {
        finding('CHILD_SCHEMA_VERSION_MALFORMED', path, 'Child schema marker is invalid.');
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
