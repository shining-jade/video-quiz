const { after, before, beforeEach, test } = require('node:test');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require('@firebase/rules-unit-testing');
const {
  collection,
  collectionGroup,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit: queryLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  setLogLevel,
  Timestamp,
  updateDoc,
  where,
  writeBatch
} = require('firebase/firestore');
const { createFirestoreStore } = require('../firestore-store.js');
const PublicQuizLibraryCore = require('../public-quiz-library-core.js');

const projectId = 'demo-video-quiz';
const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const rulesTest = emulatorAvailable ? test : test.skip;
let testEnvironment;

setLogLevel('silent');

function googleContext(uid, email) {
  return testEnvironment.authenticatedContext(uid, {
    email,
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' }
  }).firestore();
}

function anonymousContext(uid) {
  return testEnvironment.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'anonymous' }
  }).firestore();
}

const actors = {
  owner: {
    uid: 'owner-uid',
    email: 'owner@school.kr',
    claims: {
      email: 'owner@school.kr',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' }
    }
  },
  otherTeacher: {
    uid: 'other-teacher-uid',
    email: 'other@school.kr',
    claims: {
      email: 'other@school.kr',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' }
    }
  },
  admin: {
    uid: 'admin-uid',
    email: 'admin@school.kr',
    claims: {
      email: 'admin@school.kr',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' }
    }
  },
  student: {
    uid: 'student-uid',
    claims: { firebase: { sign_in_provider: 'anonymous' } }
  },
  otherStudent: {
    uid: 'other-student-uid',
    claims: { firebase: { sign_in_provider: 'anonymous' } }
  },
  anonymous: {
    uid: 'new-student-uid',
    claims: { firebase: { sign_in_provider: 'anonymous' } }
  },
  unapproved: {
    uid: 'unapproved-uid',
    email: 'blocked@school.kr',
    claims: {
      email: 'blocked@school.kr',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' }
    }
  }
};

const actorNames = Object.keys(actors);
const approvedTeachers = ['owner', 'otherTeacher', 'admin'];

function publicQuestion(number = 1) {
  return {
    number,
    total: 2,
    type: 'mc',
    text: `공개 문항 ${number}`,
    choices: ['A', 'B']
  };
}

function liveQuestion(q = 0, patch = {}) {
  return {
    q,
    openedAt: Timestamp.fromMillis(1),
    limitSec: 30,
    revealed: false,
    publicQuestion: publicQuestion(q + 1),
    ...patch
  };
}

function actorFirestore(actorName) {
  const actor = actors[actorName];
  return testEnvironment.authenticatedContext(actor.uid, actor.claims).firestore();
}

function guestFirestore(uid, shareId = 'share-a', revision = 2, expiresAtOffset = 600) {
  return testEnvironment.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'custom' },
    guestShareId: shareId,
    guestShareRevision: revision,
    guestCapabilityExpiresAt: Math.floor(Date.now() / 1000) + expiresAtOffset
  }).firestore();
}

async function adminWrite(path, value) {
  await testEnvironment.withSecurityRulesDisabled(async context => {
    const reference = doc(context.firestore(), path);
    if (value === undefined) await deleteDoc(reference);
    else await setDoc(reference, value);
  });
}

async function adminRead(path) {
  let value;
  await testEnvironment.withSecurityRulesDisabled(async context => {
    const snapshot = await getDoc(doc(context.firestore(), path));
    value = snapshot.exists() ? snapshot.data() : undefined;
  });
  return value;
}

function compatStoreDb(modularDb, pauseFirstLiveAccess, pauseAccess) {
  let paused = false;
  let pathPaused = false;
  async function pause(path) {
    if (!paused && pauseFirstLiveAccess && path.endsWith('/meta/live')) {
      paused = true;
      await pauseFirstLiveAccess();
    }
    if (!pathPaused && pauseAccess && pauseAccess.path === path) {
      pathPaused = true;
      await pauseAccess.wait();
    }
  }
  function reference(path) {
    const modularReference = doc(modularDb, path);
    return {
      path,
      modularReference,
      async get() {
        const snapshot = await getDoc(modularReference);
        return {
          exists: snapshot.exists(),
          id: snapshot.id,
          data: () => snapshot.data()
        };
      },
      async set(value, options) {
        await pause(path);
        return setDoc(modularReference, value, options);
      }
    };
  }
  return {
    doc: reference,
    runTransaction(updateFunction) {
      return runTransaction(modularDb, transaction => updateFunction({
        async get(ref) {
          const snapshot = await transaction.get(ref.modularReference);
          await pause(ref.path);
          return {
            exists: snapshot.exists(),
            id: snapshot.id,
            data: () => snapshot.data()
          };
        },
        set(ref, value, options) {
          transaction.set(ref.modularReference, value, options);
          return this;
        },
        update(ref, value) {
          transaction.update(ref.modularReference, value);
          return this;
        },
        delete(ref) {
          transaction.delete(ref.modularReference);
          return this;
        }
      }));
    },
    collection(path) {
      const modularCollection = collection(modularDb, path);
      const collectionSnapshot = async target => {
        const snapshot = await getDocs(target);
        return {
          docs: snapshot.docs.map(document => ({
            exists: true,
            id: document.id,
            ref: reference(`${path}/${document.id}`),
            data: () => document.data()
          })),
          empty: snapshot.empty,
          size: snapshot.size
        };
      };
      const queryReference = target => ({
        path,
        get() { return collectionSnapshot(target); },
        where(field, operator, value) {
          return queryReference(query(target, where(field, operator, value)));
        },
        limit(count) {
          return queryReference(query(target, queryLimit(count)));
        },
        orderBy(field, direction) {
          return queryReference(query(target, orderBy(field, direction || 'asc')));
        }
      });
      return queryReference(modularCollection);
    },
    batch() {
      const batch = writeBatch(modularDb);
      return {
        set(ref, value, options) {
          batch.set(ref.modularReference, value, options);
          return this;
        },
        delete(ref) {
          batch.delete(ref.modularReference);
          return this;
        },
        commit() { return batch.commit(); }
      };
    }
  };
}

function emulatorStore(modularDb, pauseFirstLiveAccess, pauseAccess, nowFn = Date.now) {
  return createFirestoreStore(
    compatStoreDb(modularDb, pauseFirstLiveAccess, pauseAccess),
    { serverTimestamp, delete: deleteField },
    nowFn
  );
}

async function expectPermission(allowed, request) {
  if (allowed) await assertSucceeds(request);
  else await assertFails(request);
}

async function seedFirestore() {
  await testEnvironment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'teacher_allowlist/owner@school.kr'), {
        enabled: true,
        role: 'teacher'
      }),
      setDoc(doc(db, 'teacher_allowlist/other@school.kr'), {
        enabled: true,
        role: 'teacher'
      }),
      setDoc(doc(db, 'teacher_allowlist/admin@school.kr'), {
        enabled: true,
        role: 'admin'
      }),
      setDoc(doc(db, 'teacher_allowances/owner-uid'), {
        uid: 'owner-uid', emailCanonical: 'owner@school.kr', displayName: '소유 교사',
        status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
        approvedAt: Timestamp.fromMillis(1), approvedByUid: 'admin-uid',
        updatedAt: Timestamp.fromMillis(1), updatedByUid: 'admin-uid'
      }),
      setDoc(doc(db, 'teacher_allowances/other-teacher-uid'), {
        uid: 'other-teacher-uid', emailCanonical: 'other@school.kr', displayName: '다른 교사',
        status: 'active', enabled: true, role: 'teacher', administrativeHold: false,
        approvedAt: Timestamp.fromMillis(1), approvedByUid: 'admin-uid',
        updatedAt: Timestamp.fromMillis(1), updatedByUid: 'admin-uid'
      }),
      setDoc(doc(db, 'teacher_allowances/admin-uid'), {
        uid: 'admin-uid', emailCanonical: 'admin@school.kr', displayName: '관리자',
        status: 'active', enabled: true, role: 'admin', administrativeHold: false,
        approvedAt: Timestamp.fromMillis(1), approvedByUid: 'admin-uid',
        updatedAt: Timestamp.fromMillis(1), updatedByUid: 'admin-uid'
      }),
      setDoc(doc(db, 'migration_gates/set_counters'), {
        locked: false,
        lockId: 'seed-unlocked-gate',
        projectId,
        targetMode: 'emulator',
        lockedAt: Timestamp.fromMillis(1),
        lockedByUid: 'admin-uid',
        unlockedAt: Timestamp.fromMillis(2),
        unlockedByUid: 'admin-uid'
      }),
      setDoc(doc(db, 'quiz_sets/set1'), {
        ownerUid: 'owner-uid',
        ownerEmail: 'owner@school.kr',
        trashedAt: null,
        purgeStartedAt: null,
        lifecycleState: 'active',
        collaboratorCount: 0,
        imageCount: 1,
        title: '보안 규칙 테스트'
      }),
      setDoc(doc(db, 'quiz_sets/set2'), {
        ownerUid: 'other-teacher-uid',
        ownerEmail: 'other@school.kr',
        trashedAt: null,
        purgeStartedAt: null,
        lifecycleState: 'active',
        collaboratorCount: 0,
        imageCount: 0,
        title: '다른 교사 세트'
      }),
      setDoc(doc(db, 'images/set1/q/0'), { data: 'owner-image' }),
      setDoc(doc(db, 'codes/ABC123'), { sessionId: 's1' }),
      setDoc(doc(db, 'codes/OTHER1'), { sessionId: 's2' }),
      setDoc(doc(db, 'sessions/s1'), {
        teacherUid: 'owner-uid',
        teacherEmail: 'owner@school.kr',
        status: 'live',
        registeredStudentCount: 2,
        studentCountRevision: 2,
        lastStudentUid: 'other-student-uid',
        activationLeaseUntil: Timestamp.fromMillis(Date.now() + 15_000)
      }),
      setDoc(doc(db, 'sessions/s2'), {
        teacherUid: 'other-teacher-uid',
        teacherEmail: 'other@school.kr',
        status: 'live',
        registeredStudentCount: 0,
        studentCountRevision: 0,
        activationLeaseUntil: Timestamp.fromMillis(Date.now() + 15_000)
      }),
      setDoc(doc(db, 'sessions/s1/meta/live'), {
        q: 0,
        openedAt: Timestamp.fromMillis(1),
        limitSec: 30,
        revealed: false,
        publicQuestion: {
          number: 1,
          total: 2,
          type: 'mc',
          text: '공개 문항',
          choices: ['A', 'B']
        }
      }),
      setDoc(doc(db, 'sessions/s1/meta/board'), { scores: {} }),
      setDoc(doc(db, 'sessions/s1/snapshot/set'), { title: '비공개 세트' }),
      setDoc(doc(db, 'sessions/s1/snapshot_images/0'), { data: 'private-image' }),
      setDoc(doc(db, 'sessions/s1/students/student-uid'), {
        uid: 'student-uid',
        grade: 1,
        class: 2,
        number: 3,
        name: '학생'
      }),
      setDoc(doc(db, 'sessions/s1/students/other-student-uid'), {
        uid: 'other-student-uid',
        grade: 1,
        class: 2,
        number: 4,
        name: '다른 학생'
      }),
      setDoc(doc(db, 'sessions/s1/responses/student-uid'), {
        uid: 'student-uid',
        answers: { 0: { answer: 1, submitted: true, revision: 1 } }
      }),
      setDoc(doc(db, 'sessions/s1/responses/other'), {
        uid: 'other',
        answers: { 0: { answer: 2, submitted: true, revision: 1 } }
      }),
      setDoc(doc(db, 'config/app'), { retentionDays: 30 })
    ]);
  });
}

before(async () => {
  if (!emulatorAvailable) return;
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync('firestore.rules', 'utf8')
    }
  });
});

beforeEach(async () => {
  if (!emulatorAvailable) return;
  await testEnvironment.clearFirestore();
  await seedFirestore();
});

after(async () => {
  if (testEnvironment) await testEnvironment.cleanup();
});

function pendingTeacherRequestDocument(uid, emailCanonical, patch = {}) {
  return {
    uid,
    emailCanonical,
    displayName: '신청 교사',
    organization: '1학년',
    note: '보건 수업',
    status: 'pending',
    revision: 1,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...patch
  };
}

const requestAdminIdentity = {
  uid: 'admin-uid', email: 'admin@school.kr', role: 'admin'
};

const publicRulesOwner = {
  ...actors.owner,
  displayName: '소유 교사',
  role: 'teacher'
};

function publicRulesSource(patch = {}) {
  return {
    title: '공개 과학 퀴즈',
    description: '힘과 운동 복습',
    settings: {
      revealMode: 'timer', limitSec: 20, revealDelaySec: 5, autoPause: true
    },
    videos: [{
      videoId: 'dQw4w9WgXcQ',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      startSec: 0,
      endSec: 120,
      questions: [{
        type: 'choice', t: 10, text: '힘의 단위는?', choices: ['N', 'm'], answer: 0,
        imgUp: true
      }]
    }],
    ownerUid: actors.owner.uid,
    ownerEmail: actors.owner.email,
    lifecycleState: 'active',
    collaboratorCount: 0,
    imageCount: 0,
    contentRevision: 'rev-1',
    ...patch
  };
}

function publicRulesFullProjection(publicationId = 'library-set', patch = {}) {
  const source = publicRulesSource();
  return {
    publicationId,
    sourceSetId: publicationId,
    status: 'published',
    moderationStatus: 'clear',
    revision: 'rev-1',
    title: source.title,
    description: source.description,
    authorDisplayName: '소유 교사',
    videos: source.videos,
    settings: source.settings,
    videoCount: 1,
    questionCount: 1,
    imageCount: 0,
    publishedAt: Timestamp.fromMillis(900),
    updatedAt: Timestamp.fromMillis(1_000),
    ...patch
  };
}

function publicRulesFlat(publicationId = 'library-set', patch = {}, buildToken = 'build-token-1') {
  return PublicQuizLibraryCore.flattenProjection(
    publicRulesFullProjection(publicationId, patch), buildToken
  );
}

function publicRulesProjection(publicationId = 'library-set', patch = {}) {
  return publicRulesFlat(publicationId, patch).parent;
}

function publicRulesBuilding(publicationId = 'library-set', patch = {}) {
  return {
    ...publicRulesProjection(publicationId),
    status: 'building',
    publishedAt: null,
    buildToken: 'build-token-1',
    buildVideoCount: 0,
    buildQuestionCount: 0,
    buildImageCount: 0,
    ...patch
  };
}

function publicCopyStart(publicationId, owner = actors.otherTeacher, patch = {}) {
  const projection = publicRulesFullProjection(publicationId);
  return {
    title: `${projection.title} (사본)`,
    description: projection.description,
    videos: projection.videos,
    settings: projection.settings,
    publicationId,
    sourceTitle: projection.title,
    sourceAuthorDisplayName: projection.authorDisplayName,
    visibility: 'private',
    collaboratorCount: 0,
    imageCount: 0,
    sourcePublicationRevision: projection.revision,
    ownerUid: owner.uid,
    ownerEmail: owner.email,
    lifecycleState: 'copying',
    copyStatus: 'building',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    contentRevision: serverTimestamp(),
    ...patch
  };
}

async function seedPublicRulesSource(publicationId = 'library-set', patch = {}, images = {}) {
  await adminWrite(`quiz_sets/${publicationId}`, publicRulesSource(patch));
  for (const [key, data] of Object.entries(images)) {
    await adminWrite(`images/${publicationId}/q/${key}`, { data });
  }
}

async function seedPublishedRulesProjection(publicationId = 'library-set', patch = {}, images = {}) {
  const fullProjection = publicRulesFullProjection(publicationId, {
    imageCount: Object.keys(images).length,
    ...patch
  });
  const flat = PublicQuizLibraryCore.flattenProjection(fullProjection, 'build-token-1');
  const projection = flat.parent;
  await adminWrite(`published_quiz_sets/${publicationId}`, projection);
  for (const [key, value] of Object.entries(flat.videos)) {
    await adminWrite(`published_quiz_sets/${publicationId}/videos/${key}`, value);
  }
  for (const [key, value] of Object.entries(flat.questions)) {
    await adminWrite(`published_quiz_sets/${publicationId}/questions/${key}`, value);
  }
  for (const [key, data] of Object.entries(images)) {
    await adminWrite(`published_quiz_sets/${publicationId}/images/${key}`, {
      data,
      revision: projection.revision,
      schemaVersion: 1,
      buildToken: 'build-token-1'
    });
  }
  return projection;
}

function classPlanDocuments(planId, patch = {}, writeTime = Timestamp.fromMillis(1_000)) {
  const privatePlan = {
    planId,
    ownerUid: 'owner-uid',
    ownerEmailCanonical: 'owner@school.kr',
    ownerDisplayName: '소유 교사',
    setId: 'set1',
    setTitleSnapshot: '보안 규칙 테스트',
    className: '2학년 1반',
    plannedStartAt: Timestamp.fromMillis(10_000),
    plannedEndAt: Timestamp.fromMillis(20_000),
    expectedStudents: 30,
    status: 'planned',
    revision: 1,
    warningLevel: 'caution',
    warningAcknowledgedAt: Timestamp.fromMillis(9_000),
    createdAt: writeTime,
    updatedAt: writeTime,
    ...patch
  };
  const publicPlan = {
    planId: privatePlan.planId,
    setId: privatePlan.setId,
    setTitleSnapshot: privatePlan.setTitleSnapshot,
    className: privatePlan.className,
    plannedStartAt: privatePlan.plannedStartAt,
    plannedEndAt: privatePlan.plannedEndAt,
    expectedStudents: privatePlan.expectedStudents,
    status: privatePlan.status,
    revision: privatePlan.revision,
    warningLevel: privatePlan.warningLevel,
    warningAcknowledgedAt: privatePlan.warningAcknowledgedAt,
    createdAt: privatePlan.createdAt,
    updatedAt: privatePlan.updatedAt
  };
  for (const key of ['sessionId', 'actualStartedAt', 'actualEndedAt', 'actualParticipants']) {
    if (privatePlan[key] !== undefined) publicPlan[key] = privatePlan[key];
  }
  return { privatePlan, publicPlan };
}

async function writeClassPlanPairDisabled(planId, patch = {}) {
  const pair = classPlanDocuments(planId, patch);
  await adminWrite(`class_plans_private/${planId}`, pair.privatePlan);
  await adminWrite(`class_plans_public/${planId}`, pair.publicPlan);
  return pair;
}

function setClassPlanPair(batch, db, planId, pair) {
  batch.set(doc(db, `class_plans_private/${planId}`), pair.privatePlan);
  batch.set(doc(db, `class_plans_public/${planId}`), pair.publicPlan);
}

rulesTest('class-planning: active teacher atomically creates own paired projection and overlaps remain advisory', async () => {
  const owner = actorFirestore('owner');
  const first = classPlanDocuments('plan-owner-a', {
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, serverTimestamp());
  const firstBatch = writeBatch(owner);
  setClassPlanPair(firstBatch, owner, 'plan-owner-a', first);
  await assertSucceeds(firstBatch.commit());

  const second = classPlanDocuments('plan-owner-b', {
    plannedStartAt: Timestamp.fromMillis(15_000),
    plannedEndAt: Timestamp.fromMillis(25_000),
    expectedStudents: 40,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, serverTimestamp());
  const secondBatch = writeBatch(owner);
  setClassPlanPair(secondBatch, owner, 'plan-owner-b', second);
  await assertSucceeds(secondBatch.commit());

  assert.equal((await getDoc(doc(owner, 'class_plans_public/plan-owner-a'))).data().ownerUid, undefined);
  assert.equal((await getDoc(doc(owner, 'class_plans_public/plan-owner-b'))).data().expectedStudents, 40);
});

rulesTest('class-planning: single-sided, forged-owner, and inactive plan writes fail closed', async () => {
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const student = actorFirestore('student');
  const signedOut = testEnvironment.unauthenticatedContext().firestore();
  const unapproved = actorFirestore('unapproved');
  const pair = classPlanDocuments('attack-plan', {
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, serverTimestamp());

  await assertFails(setDoc(doc(owner, 'class_plans_private/attack-plan'), pair.privatePlan));
  await assertFails(setDoc(doc(owner, 'class_plans_public/attack-plan'), pair.publicPlan));

  const forged = classPlanDocuments('forged-plan', {
    ownerUid: 'other-teacher-uid', ownerEmailCanonical: 'other@school.kr',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, serverTimestamp());
  const forgedBatch = writeBatch(owner);
  setClassPlanPair(forgedBatch, owner, 'forged-plan', forged);
  await assertFails(forgedBatch.commit());

  for (const [index, db] of [other, student, signedOut, unapproved].entries()) {
    const denied = classPlanDocuments('denied-' + index, {
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, serverTimestamp());
    const deniedBatch = writeBatch(db);
    setClassPlanPair(deniedBatch, db, denied.privatePlan.planId, denied);
    await assertFails(deniedBatch.commit());
  }

  const otherAllowance = await adminRead('teacher_allowances/other-teacher-uid');
  for (const status of ['suspended', 'deletion_pending']) {
    await adminWrite('teacher_allowances/other-teacher-uid', {
      ...otherAllowance, status, enabled: false
    });
    const denied = classPlanDocuments('inactive-' + status, {
      ownerUid: 'other-teacher-uid', ownerEmailCanonical: 'other@school.kr',
      ownerDisplayName: '다른 교사', createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, serverTimestamp());
    const deniedBatch = writeBatch(other);
    setClassPlanPair(deniedBatch, other, denied.privatePlan.planId, denied);
    await assertFails(deniedBatch.commit());
  }
});

rulesTest('class-planning: public/private get and bounded list follow the role projection matrix', async () => {
  await writeClassPlanPairDisabled('matrix-plan');
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const admin = actorFirestore('admin');
  const denied = [
    actorFirestore('student'), actorFirestore('unapproved'),
    testEnvironment.unauthenticatedContext().firestore()
  ];

  await assertSucceeds(getDoc(doc(owner, 'class_plans_private/matrix-plan')));
  await assertFails(getDoc(doc(other, 'class_plans_private/matrix-plan')));
  await assertSucceeds(getDoc(doc(admin, 'class_plans_private/matrix-plan')));
  await assertSucceeds(getDoc(doc(other, 'class_plans_public/matrix-plan')));
  for (const db of denied) {
    await assertFails(getDoc(doc(db, 'class_plans_private/matrix-plan')));
    await assertFails(getDoc(doc(db, 'class_plans_public/matrix-plan')));
  }

  const boundedPublic = query(
    collection(owner, 'class_plans_public'),
    where('plannedStartAt', '>=', Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)),
    where('plannedStartAt', '<', Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  );
  const boundedPrivate = query(
    collection(admin, 'class_plans_private'),
    where('plannedStartAt', '>=', Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)),
    where('plannedStartAt', '<', Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  );
  await assertSucceeds(getDocs(boundedPublic));
  await assertSucceeds(getDocs(boundedPrivate));
  const transportBoundaryNow = Date.now();
  await assertSucceeds(getDocs(query(
    collection(owner, 'class_plans_public'),
    where('plannedStartAt', '>=', Timestamp.fromMillis(
      transportBoundaryNow - (24 * 60 + 7) * 60 * 1000
    )),
    where('plannedStartAt', '<', Timestamp.fromMillis(transportBoundaryNow + 60 * 60 * 1000)),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  )));
  await assertFails(getDocs(collection(owner, 'class_plans_public')));
  await assertFails(getDocs(query(collection(owner, 'class_plans_public'), queryLimit(20))));
  await assertFails(getDocs(query(
    collection(owner, 'class_plans_public'),
    where('plannedStartAt', '>=', Timestamp.fromMillis(
      Date.now() - (24 * 60 + 9) * 60 * 1000
    )),
    where('plannedStartAt', '<', Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  )));
  await assertFails(getDocs(query(
    collection(owner, 'class_plans_public'),
    where('plannedStartAt', '>=', Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)),
    where('plannedStartAt', '<', Timestamp.fromMillis(Date.now() + 33 * 24 * 60 * 60 * 1000)),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  )));
  await assertFails(getDocs(query(collection(owner, 'class_plans_public'), queryLimit(101))));
  await assertFails(getDocs(query(collection(owner, 'class_plans_private'), queryLimit(20))));
});

rulesTest('class-planning: owner-only bounded private list requires the exact ownerUid query', async () => {
  await writeClassPlanPairDisabled('own-list-plan');
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const start = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const end = Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
  const ownBounded = query(
    collection(owner, 'class_plans_private'),
    where('ownerUid', '==', 'owner-uid'),
    where('plannedStartAt', '>=', start), where('plannedStartAt', '<', end),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  );
  const forgedOwner = query(
    collection(other, 'class_plans_private'),
    where('ownerUid', '==', 'owner-uid'),
    where('plannedStartAt', '>=', start), where('plannedStartAt', '<', end),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  );
  const unscopedOwner = query(
    collection(owner, 'class_plans_private'),
    where('plannedStartAt', '>=', start), where('plannedStartAt', '<', end),
    orderBy('plannedStartAt', 'asc'), queryLimit(20)
  );

  await assertSucceeds(getDocs(ownBounded));
  await assertFails(getDocs(forgedOwner));
  await assertFails(getDocs(unscopedOwner));
});

rulesTest('class-planning: exact pair revision and plan-session identity gate updates and attachment', async () => {
  await writeClassPlanPairDisabled('cas-plan');
  await adminWrite('sessions/plan-session', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'live', createdAt: Timestamp.fromMillis(12_000),
    registeredStudentCount: 1, studentCountRevision: 1, lastStudentUid: 'seed-student',
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 15_000)
  });
  await adminWrite('sessions/wrong-set-session', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set2',
    status: 'live', createdAt: Timestamp.fromMillis(12_000),
    registeredStudentCount: 0, studentCountRevision: 0,
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 15_000)
  });
  await adminWrite('sessions/plan-session/students/seed-student', {
    uid: 'seed-student', name: '첫번째', grade: 1, klass: 1, num: 1
  });
  const owner = actorFirestore('owner');

  const changed = classPlanDocuments('cas-plan', {
    className: '2학년 2반', expectedStudents: 31, revision: 2,
    createdAt: Timestamp.fromMillis(1_000), updatedAt: serverTimestamp()
  });
  const updateBatch = writeBatch(owner);
  setClassPlanPair(updateBatch, owner, 'cas-plan', changed);
  await assertSucceeds(updateBatch.commit());

  await assertFails(updateDoc(doc(owner, 'class_plans_private/cas-plan'), {
    className: 'single-side', revision: 3, updatedAt: serverTimestamp()
  }));
  const stale = classPlanDocuments('cas-plan', {
    className: 'stale', revision: 2,
    createdAt: Timestamp.fromMillis(1_000), updatedAt: serverTimestamp()
  });
  const staleBatch = writeBatch(owner);
  setClassPlanPair(staleBatch, owner, 'cas-plan', stale);
  await assertFails(staleBatch.commit());

  const wrongAttach = classPlanDocuments('cas-plan', {
    className: '2학년 2반', expectedStudents: 31, status: 'live', revision: 3,
    sessionId: 'wrong-set-session', actualStartedAt: Timestamp.fromMillis(12_000),
    createdAt: Timestamp.fromMillis(1_000), updatedAt: serverTimestamp()
  });
  const wrongBatch = writeBatch(owner);
  setClassPlanPair(wrongBatch, owner, 'cas-plan', wrongAttach);
  await assertFails(wrongBatch.commit());

  const attached = classPlanDocuments('cas-plan', {
    className: '2학년 2반', expectedStudents: 31, status: 'live', revision: 3,
    sessionId: 'plan-session', actualStartedAt: Timestamp.fromMillis(12_000),
    createdAt: Timestamp.fromMillis(1_000), updatedAt: serverTimestamp()
  });
  const forgedAttach = writeBatch(owner);
  setClassPlanPair(forgedAttach, owner, 'cas-plan', attached);
  forgedAttach.update(doc(owner, 'sessions/plan-session'), {
    classPlanId: 'cas-plan', classPlanRevision: 3
  });
  await assertFails(forgedAttach.commit());
  attached.publicPlan.actualParticipants = 1;
  const attachBatch = writeBatch(owner);
  setClassPlanPair(attachBatch, owner, 'cas-plan', attached);
  attachBatch.update(doc(owner, 'sessions/plan-session'), {
    classPlanId: 'cas-plan', classPlanRevision: 3
  });
  await assertSucceeds(attachBatch.commit());
  assert.equal((await getDoc(doc(owner, 'class_plans_private/cas-plan'))).data().actualParticipants, undefined);
  assert.equal((await getDoc(doc(owner, 'class_plans_public/cas-plan'))).data().actualParticipants, 1);
  const studentDb = anonymousContext('attach-student-2');
  await emulatorStore(studentDb).joinStudent('plan-session', 'attach-student-2', {
    name: '두번째', grade: 1, klass: 1, num: 2
  });
  assert.equal((await adminRead('sessions/plan-session')).registeredStudentCount, 2);
  assert.equal((await adminRead('class_plans_public/cas-plan')).actualParticipants, 2);
});

rulesTest('class-planning: ended actuals must match the linked authoritative session summary', async () => {
  await writeClassPlanPairDisabled('finish-plan', {
    status: 'live', revision: 2, sessionId: 'finish-session',
    actualStartedAt: Timestamp.fromMillis(12_000)
  });
  await adminWrite('sessions/finish-session', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'ended', createdAt: Timestamp.fromMillis(12_000),
    endedAt: Timestamp.fromMillis(25_000), actualParticipants: 2,
    registeredStudentCount: 2, studentCountRevision: 2, lastStudentUid: 'student-2',
    classPlanId: 'finish-plan', classPlanRevision: 2
  });
  const owner = actorFirestore('owner');

  for (const actualParticipants of [999, 2]) {
    const ended = classPlanDocuments('finish-plan', {
      status: 'ended', revision: 3, sessionId: 'finish-session',
      actualStartedAt: Timestamp.fromMillis(12_000),
      actualEndedAt: Timestamp.fromMillis(25_000), actualParticipants,
      createdAt: Timestamp.fromMillis(1_000), updatedAt: serverTimestamp()
    });
    const batch = writeBatch(owner);
    setClassPlanPair(batch, owner, 'finish-plan', ended);
    batch.update(doc(owner, 'sessions/finish-session'), { classPlanRevision: 3 });
    if (actualParticipants === 2) {
      const forgedPublic = { ...ended, publicPlan: { ...ended.publicPlan, actualParticipants: 999 } };
      const forgedBatch = writeBatch(owner);
      setClassPlanPair(forgedBatch, owner, 'finish-plan', forgedPublic);
      forgedBatch.update(doc(owner, 'sessions/finish-session'), { classPlanRevision: 3 });
      await assertFails(forgedBatch.commit());
      await assertSucceeds(batch.commit());
    } else await assertFails(batch.commit());
  }
});

rulesTest('class-planning: attached live session은 abort와 parent delete로 고아화할 수 없다', async () => {
  await writeClassPlanPairDisabled('protected-plan', {
    status: 'live', revision: 2, sessionId: 'protected-session',
    actualStartedAt: Timestamp.fromMillis(12_000)
  });
  await adminWrite('sessions/protected-session', {
    code: 'PROT12', teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr',
    setId: 'set1', status: 'live', createdAt: Timestamp.fromMillis(12_000),
    activationLeaseUntil: Timestamp.fromMillis(Date.now() - 1_000),
    registeredStudentCount: 0, studentCountRevision: 0,
    classPlanId: 'protected-plan', classPlanRevision: 2
  });
  await adminWrite('sessions/protected-session/meta/allocation', {
    token: 'protected-token-1234', ownerUid: 'owner-uid'
  });
  await adminWrite('codes/PROT12', { sessionId: 'protected-session' });
  const owner = actorFirestore('owner');
  const store = emulatorStore(owner);

  assert.equal(await store.abortSessionAllocation(
    'protected-session', 'PROT12', 'owner-uid', 'protected-token-1234'
  ), false);
  await assertFails(updateDoc(doc(owner, 'sessions/protected-session'), {
    status: 'aborted', abortedAt: serverTimestamp()
  }));
  await assertFails(deleteDoc(doc(owner, 'sessions/protected-session')));
  assert.equal((await getDoc(doc(owner, 'sessions/protected-session'))).data().status, 'live');
});

rulesTest('session student counter는 최초 child create와 exact atomic pair일 때만 증가한다', async () => {
  const student = actorFirestore('anonymous');
  const owner = actorFirestore('owner');
  const parent = doc(student, 'sessions/s1');
  const child = doc(student, 'sessions/s1/students/new-student-uid');
  const profile = { uid: 'new-student-uid', grade: 1, klass: 1, num: 5, name: '신규' };

  await assertFails(setDoc(child, profile));
  await assertFails(updateDoc(parent, {
    registeredStudentCount: 3, studentCountRevision: 3,
    lastStudentUid: 'new-student-uid'
  }));
  const wrongUid = writeBatch(student);
  wrongUid.update(parent, {
    registeredStudentCount: 3, studentCountRevision: 3,
    lastStudentUid: 'other-student-uid'
  });
  wrongUid.set(child, profile);
  await assertFails(wrongUid.commit());

  const paired = writeBatch(student);
  paired.update(parent, {
    registeredStudentCount: 3, studentCountRevision: 3,
    lastStudentUid: 'new-student-uid'
  });
  paired.set(child, profile);
  await assertSucceeds(paired.commit());

  const replay = writeBatch(student);
  replay.update(parent, {
    registeredStudentCount: 4, studentCountRevision: 4,
    lastStudentUid: 'new-student-uid'
  });
  replay.set(child, { ...profile, name: '재가입' });
  await assertFails(replay.commit());
  assert.equal((await getDoc(doc(owner, 'sessions/s1'))).data().registeredStudentCount, 3);
});

rulesTest('teacher-access: teacher request owner may create, server-read, and cancel only the exact own pending request', async () => {
  const unapproved = actorFirestore('unapproved');
  const ownRef = doc(unapproved, 'teacher_access_requests/unapproved-uid');
  await assertSucceeds(setDoc(ownRef, pendingTeacherRequestDocument(
    'unapproved-uid', 'blocked@school.kr'
  )));
  await assertSucceeds(getDoc(ownRef));
  await assertFails(getDoc(doc(unapproved, 'teacher_access_requests/owner-uid')));
  await assertFails(setDoc(doc(unapproved, 'teacher_access_requests/other-uid'),
    pendingTeacherRequestDocument('other-uid', 'blocked@school.kr')));
  await assertFails(updateDoc(ownRef, {
    status: 'approved', revision: 2, updatedAt: serverTimestamp()
  }));
  await assertSucceeds(updateDoc(ownRef, {
    status: 'cancelled', revision: 2, updatedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(ownRef, {
    displayName: '변조', revision: 3, updatedAt: serverTimestamp()
  }));
});

rulesTest('teacher-access: teacher request rejects wrong identity, privileged fields, duplicate overwrite, student, and signed-out access', async () => {
  const unapproved = actorFirestore('unapproved');
  const student = actorFirestore('student');
  const signedOut = testEnvironment.unauthenticatedContext().firestore();
  const ownPath = 'teacher_access_requests/unapproved-uid';

  await assertFails(setDoc(doc(unapproved, ownPath), pendingTeacherRequestDocument(
    'unapproved-uid', 'other@school.kr'
  )));
  await assertFails(setDoc(doc(unapproved, ownPath), pendingTeacherRequestDocument(
    'unapproved-uid', 'blocked@school.kr', { decidedByUid: 'forged-admin' }
  )));
  await assertFails(setDoc(doc(student, 'teacher_access_requests/student-uid'),
    pendingTeacherRequestDocument('student-uid', 'student@school.kr')));
  await assertFails(setDoc(doc(signedOut, 'teacher_access_requests/no-user'),
    pendingTeacherRequestDocument('no-user', 'none@school.kr')));

  await assertSucceeds(setDoc(doc(unapproved, ownPath), pendingTeacherRequestDocument(
    'unapproved-uid', 'blocked@school.kr'
  )));
  await assertFails(setDoc(doc(unapproved, ownPath), pendingTeacherRequestDocument(
    'unapproved-uid', 'blocked@school.kr', { note: 'overwrite' }
  )));
  await assertFails(getDoc(doc(student, ownPath)));
  await assertFails(getDoc(doc(signedOut, ownPath)));

  const owner = actorFirestore('owner');
  await assertFails(setDoc(doc(owner, 'teacher_access_requests/owner-uid'),
    pendingTeacherRequestDocument('owner-uid', 'owner@school.kr')));
  await adminWrite('teacher_allowances/owner-uid', undefined);
  await assertFails(setDoc(doc(owner, 'teacher_access_requests/owner-uid'),
    pendingTeacherRequestDocument('owner-uid', 'owner@school.kr')));
});

rulesTest('teacher-access: authoritative allowance binds the current UID and exact canonical Google email for teacher and admin', async () => {
  await adminWrite('teacher_allowlist/new-owner@school.kr', {
    enabled: true, role: 'teacher'
  });
  await adminWrite('teacher_allowlist/new-admin@school.kr', {
    enabled: true, role: 'admin'
  });
  const changedTeacherEmail = googleContext('owner-uid', 'new-owner@school.kr');
  const changedAdminEmail = googleContext('admin-uid', 'new-admin@school.kr');
  const missingEmail = testEnvironment.authenticatedContext('owner-uid', {
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' }
  }).firestore();
  const missingVerified = testEnvironment.authenticatedContext('owner-uid', {
    email: 'owner@school.kr',
    firebase: { sign_in_provider: 'google.com' }
  }).firestore();
  const missingProvider = testEnvironment.authenticatedContext('admin-uid', {
    email: 'admin@school.kr',
    email_verified: true
  }).firestore();

  await assertFails(getDoc(doc(changedTeacherEmail, 'quiz_sets/set1')));
  await assertFails(getDocs(query(
    collection(changedAdminEmail, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(50)
  )));
  await assertFails(getDoc(doc(missingEmail, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(missingVerified, 'quiz_sets/set1')));
  await assertFails(getDocs(query(
    collection(missingProvider, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(50)
  )));
});

rulesTest('teacher-access: any authoritative lifecycle record or migrated suspended legacy record blocks a new request', async () => {
  const suspendedUid = 'suspended-requester-uid';
  const suspendedEmail = 'suspended-requester@school.kr';
  await adminWrite(`teacher_allowances/${suspendedUid}`, {
    uid: suspendedUid,
    emailCanonical: suspendedEmail,
    displayName: '중지 교사',
    status: 'suspended',
    enabled: false,
    role: 'teacher',
    administrativeHold: true,
    approvedAt: Timestamp.fromMillis(1),
    approvedByUid: 'admin-uid',
    updatedAt: Timestamp.fromMillis(2),
    updatedByUid: 'admin-uid',
    suspendedAt: Timestamp.fromMillis(2),
    suspendedByUid: 'admin-uid',
    suspensionReason: 'leave'
  });
  const suspended = googleContext(suspendedUid, suspendedEmail);
  await assertFails(setDoc(doc(suspended, `teacher_access_requests/${suspendedUid}`),
    pendingTeacherRequestDocument(suspendedUid, suspendedEmail)));

  const legacyUid = 'legacy-suspended-uid';
  const legacyEmail = 'legacy-suspended@school.kr';
  await adminWrite(`teacher_allowlist/${legacyEmail}`, {
    enabled: false, role: 'teacher'
  });
  const legacySuspended = googleContext(legacyUid, legacyEmail);
  await assertFails(setDoc(doc(legacySuspended, `teacher_access_requests/${legacyUid}`),
    pendingTeacherRequestDocument(legacyUid, legacyEmail)));
});

rulesTest('teacher-access: admin approval lists only bounded pending teacher requests and atomically approves or rejects', async () => {
  await adminWrite('teacher_access_requests/pending-a', {
    uid: 'pending-a', emailCanonical: 'pending-a@school.kr', displayName: 'A교사',
    organization: '', note: '', status: 'pending', revision: 3,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('teacher_access_requests/pending-b', {
    uid: 'pending-b', emailCanonical: 'pending-b@school.kr', displayName: 'B교사',
    organization: '', note: '', status: 'pending', revision: 1,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1)
  });
  const admin = actorFirestore('admin');
  const owner = actorFirestore('owner');

  await assertSucceeds(getDocs(query(
    collection(admin, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(50)
  )));
  await assertFails(getDocs(collection(admin, 'teacher_access_requests')));
  await assertFails(getDocs(query(
    collection(admin, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(101)
  )));
  await assertFails(getDocs(query(
    collection(owner, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(50)
  )));
  await assertSucceeds(getDoc(doc(owner, 'teacher_allowances/owner-uid')));
  await assertFails(getDocs(collection(owner, 'teacher_allowances')));

  await assertFails(setDoc(doc(admin, 'teacher_allowances/pending-a'), {
    uid: 'pending-a',
    emailCanonical: 'pending-a@school.kr',
    displayName: 'A교사',
    status: 'active',
    enabled: true,
    role: 'teacher',
    administrativeHold: false,
    approvedAt: serverTimestamp(),
    approvedByUid: 'admin-uid',
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));

  const store = emulatorStore(admin);
  await store.decideTeacherRequest(
    'pending-a', 3, { status: 'approved', reason: 'approved-school' }, requestAdminIdentity
  );
  const approvedRequest = await adminRead('teacher_access_requests/pending-a');
  const approvedAllowance = await adminRead('teacher_allowances/pending-a');
  const approvedLegacy = await adminRead('teacher_allowlist/pending-a@school.kr');
  assert.equal(approvedRequest.status, 'approved');
  assert.equal(approvedRequest.revision, 4);
  assert.equal(approvedAllowance.status, 'active');
  assert.equal(approvedAllowance.uid, 'pending-a');
  assert.equal(approvedAllowance.emailCanonical, 'pending-a@school.kr');
  assert.equal(approvedLegacy.enabled, true);

  await store.decideTeacherRequest(
    'pending-b', 1, { status: 'rejected', reason: 'not-current-staff' }, requestAdminIdentity
  );
  const rejectedRequest = await adminRead('teacher_access_requests/pending-b');
  assert.equal(rejectedRequest.status, 'rejected');
  assert.equal(rejectedRequest.revision, 2);
  assert.equal(await adminRead('teacher_allowances/pending-b'), undefined);
});

rulesTest('teacher-access: admin approval rejects stale, wrong-email, and non-pending mutations without partial allowance writes', async () => {
  await adminWrite('teacher_access_requests/stale-teacher', {
    uid: 'stale-teacher', emailCanonical: 'stale@school.kr', displayName: '교사',
    organization: '', note: '', status: 'pending', revision: 2,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('teacher_access_requests/wrong-email', {
    uid: 'wrong-email', emailCanonical: 'Wrong@School.KR', displayName: '교사',
    organization: '', note: '', status: 'pending', revision: 1,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('teacher_access_requests/already-rejected', {
    uid: 'already-rejected', emailCanonical: 'rejected@school.kr', displayName: '교사',
    organization: '', note: '', status: 'rejected', revision: 2,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1),
    decidedAt: Timestamp.fromMillis(2), decidedByUid: 'admin-uid', decisionReason: ''
  });
  const store = emulatorStore(actorFirestore('admin'));

  await assert.rejects(store.decideTeacherRequest(
    'stale-teacher', 1, { status: 'approved' }, requestAdminIdentity
  ));
  await assert.rejects(store.decideTeacherRequest(
    'wrong-email', 1, { status: 'approved' }, requestAdminIdentity
  ));
  await assert.rejects(store.decideTeacherRequest(
    'already-rejected', 2, { status: 'approved' }, requestAdminIdentity
  ));
  assert.equal((await adminRead('teacher_access_requests/stale-teacher')).status, 'pending');
  assert.equal(await adminRead('teacher_allowances/stale-teacher'), undefined);
  assert.equal(await adminRead('teacher_allowances/wrong-email'), undefined);
  assert.equal(await adminRead('teacher_allowances/already-rejected'), undefined);
});

rulesTest('teacher-access: admin approval lifecycle alone may suspend and restore while authoritative status overrides legacy fallback', async () => {
  const adminStore = emulatorStore(actorFirestore('admin'));
  const ownerStore = emulatorStore(actorFirestore('owner'));
  const owner = actorFirestore('owner');

  await assert.rejects(ownerStore.suspendTeacher(
    'owner-uid', 'forged', { uid: 'owner-uid', email: 'owner@school.kr', role: 'admin' }
  ));
  await assertFails(updateDoc(doc(owner, 'teacher_allowances/owner-uid'), {
    status: 'suspended', enabled: false, updatedAt: serverTimestamp(), updatedByUid: 'owner-uid'
  }));
  const admin = actorFirestore('admin');
  await assertFails(updateDoc(doc(admin, 'teacher_allowances/owner-uid'), {
    status: 'suspended',
    enabled: false,
    suspendedAt: serverTimestamp(),
    suspendedByUid: 'admin-uid',
    suspensionReason: 'standalone',
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));

  await adminStore.suspendTeacher('owner-uid', 'leave', requestAdminIdentity);
  assert.equal((await adminRead('teacher_allowances/owner-uid')).status, 'suspended');
  assert.equal((await adminRead('teacher_allowlist/owner@school.kr')).enabled, false);
  await assertFails(getDoc(doc(owner, 'quiz_sets/set1')));

  await adminWrite('teacher_allowlist/owner@school.kr', { enabled: true, role: 'teacher' });
  await assertFails(getDoc(doc(owner, 'quiz_sets/set1')));

  await adminStore.restoreTeacher('owner-uid', requestAdminIdentity);
  assert.equal((await adminRead('teacher_allowances/owner-uid')).status, 'active');
  await assertSucceeds(getDoc(doc(owner, 'quiz_sets/set1')));

  await adminWrite('teacher_allowances/owner-uid', undefined);
  await assertSucceeds(getDoc(doc(owner, 'quiz_sets/set1')));
});

rulesTest('teacher-access: exact UID email revision admin mutation changes authoritative role atomically', async () => {
  await adminWrite('teacher_allowances/owner-uid', {
    ...(await adminRead('teacher_allowances/owner-uid')), revision: 4
  });
  const adminStore = emulatorStore(actorFirestore('admin'));
  const result = await adminStore.adminUpdateTeacherAllowance({
    uid: 'owner-uid', emailCanonical: 'owner@school.kr', expectedRevision: 4,
    status: 'active', role: 'admin'
  }, requestAdminIdentity);
  assert.equal(result.revision, 5);
  assert.equal((await adminRead('teacher_allowances/owner-uid')).role, 'admin');
  assert.equal((await adminRead('teacher_allowlist/owner@school.kr')).role, 'admin');
  await assert.rejects(adminStore.adminUpdateTeacherAllowance({
    uid: 'owner-uid', emailCanonical: 'owner@school.kr', expectedRevision: 4,
    status: 'suspended', role: 'admin'
  }, requestAdminIdentity));
  await assertSucceeds(getDoc(doc(actorFirestore('owner'), 'quiz_sets/set1')));
});

rulesTest('teacher-access: active migration lock blocks both legacy and UID allowance client mutations', async () => {
  await adminWrite('migration_gates/teacher_access_status', {
    locked: true, lockToken: 'lock-token-1', projectId, targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(1), lockedByUid: 'admin-uid'
  });
  const admin = actorFirestore('admin');
  await assertFails(updateDoc(doc(admin, 'teacher_allowlist/owner@school.kr'), {
    enabled: false, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  }));
  await assertFails(updateDoc(doc(admin, 'teacher_allowances/owner-uid'), {
    status: 'suspended', enabled: false, administrativeHold: true, revision: 1,
    suspendedAt: serverTimestamp(), suspendedByUid: 'admin-uid', suspensionReason: 'hold',
    updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  }));
});

rulesTest('teacher-access: completed exact gate permanently disables fallback and legacy-only writes after unlock', async () => {
  const legacyUid = 'legacy-only-uid';
  const legacyEmail = 'legacy-only@school.kr';
  await adminWrite(`teacher_allowlist/${legacyEmail}`, { enabled: true, role: 'teacher' });
  await adminWrite('quiz_sets/legacy-only-set', {
    ownerUid: legacyUid, ownerEmail: legacyEmail, lifecycleState: 'active',
    collaboratorCount: 0, imageCount: 0
  });
  const legacy = googleContext(legacyUid, legacyEmail);
  await assertSucceeds(getDoc(doc(legacy, 'quiz_sets/legacy-only-set')));
  const admin = actorFirestore('admin');
  await assertSucceeds(setDoc(doc(admin, 'teacher_allowlist/precomplete@school.kr'), {
    enabled: true, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  }));
  await adminWrite('migration_gates/teacher_access_status', {
    locked: false, lockToken: 'completed-token', projectId, targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(1), lockedByUid: 'admin-uid',
    status: 'complete', strictReady: true, migrationGeneration: '7:0',
    completedAt: Timestamp.fromMillis(2), completedByUid: 'admin-uid',
    unlockedAt: Timestamp.fromMillis(3), unlockedByUid: 'admin-uid'
  });
  await assertFails(getDoc(doc(legacy, 'quiz_sets/legacy-only-set')));
  await assertFails(updateDoc(doc(admin, 'teacher_allowlist/owner@school.kr'), {
    enabled: false, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  }));
  await adminWrite('teacher_allowances/owner-uid', {
    ...(await adminRead('teacher_allowances/owner-uid')), revision: 1
  });
  const changed = await emulatorStore(admin).adminUpdateTeacherAllowance({
    uid: 'owner-uid', emailCanonical: 'owner@school.kr', expectedRevision: 1,
    status: 'suspended', role: 'teacher', reason: 'complete-gate'
  }, requestAdminIdentity);
  assert.equal(changed.revision, 2);
  assert.equal((await adminRead('teacher_allowlist/owner@school.kr')).uid, 'owner-uid');
});

rulesTest('teacher-access: owner resubmits rejected and cancelled requests but cannot drift identity or revision', async () => {
  const uid = 'retry-uid';
  const email = 'retry@school.kr';
  const owner = googleContext(uid, email);
  const store = emulatorStore(owner);
  for (const [status, revision] of [['cancelled', 2], ['rejected', 7]]) {
    await adminWrite(`teacher_access_requests/${uid}`, {
      uid, emailCanonical: email, displayName: '재신청 교사', organization: '', note: '',
      status, revision, createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2),
      ...(status === 'rejected' ? {
        decidedAt: Timestamp.fromMillis(2), decidedByUid: 'admin-uid', decisionReason: 'retry'
      } : {})
    });
    const saved = await store.resubmitTeacherRequest(uid, revision, {
      emailCanonical: email, displayName: '재신청 교사', organization: '2학년', note: '재신청'
    });
    assert.equal(saved.status, 'pending');
    const current = await adminRead(`teacher_access_requests/${uid}`);
    assert.equal(current.revision, revision + 1);
    assert.equal(current.decidedAt, undefined);
    await assert.rejects(store.resubmitTeacherRequest(uid, revision, {
      emailCanonical: email, displayName: '재신청 교사', organization: '', note: ''
    }));
  }
  await adminWrite(`teacher_access_requests/${uid}`, {
    uid, emailCanonical: email, displayName: '재신청 교사', organization: '', note: '',
    status: 'cancelled', revision: 20,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2)
  });
  await assert.rejects(store.resubmitTeacherRequest(uid, 20, {
    emailCanonical: 'other@school.kr', displayName: '재신청 교사', organization: '', note: ''
  }));
});

rulesTest('teacher-deletion: own request, immediate denial, safe live end, hold-aware cancellation, and no client purge', async () => {
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const admin = actorFirestore('admin');
  const ownerStore = emulatorStore(owner);
  const adminStore = emulatorStore(admin);

  await adminWrite('teacher_access_requests/owner-uid', {
    uid: 'owner-uid', emailCanonical: 'owner@school.kr', displayName: '소유 교사',
    organization: '', note: '', status: 'approved', revision: 2,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2),
    decidedAt: Timestamp.fromMillis(2), decidedByUid: 'admin-uid', decisionReason: ''
  });
  await writeClassPlanPairDisabled('deletion-plan', {
    status: 'live', revision: 2, sessionId: 'deletion-live',
    actualStartedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('sessions/deletion-live', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'live', registeredStudentCount: 0, studentCountRevision: 0,
    createdAt: Timestamp.fromMillis(1), activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000),
    classPlanId: 'deletion-plan', classPlanRevision: 2
  });
  await adminWrite('sessions/deletion-live/meta/live', liveQuestion(0));

  await assertSucceeds(getDoc(doc(owner, 'teacher_allowances/owner-uid')));
  await assertFails(getDoc(doc(other, 'teacher_allowances/owner-uid')));
  await assertFails(getDocs(collection(owner, 'teacher_allowances')));
  await assertFails(updateDoc(doc(owner, 'teacher_allowances/owner-uid'), {
    status: 'deletion_pending', enabled: false, revision: 99,
    deletionRequestedAt: serverTimestamp(), purgeEligibleAt: serverTimestamp(),
    updatedAt: serverTimestamp(), updatedByUid: 'owner-uid'
  }));

  const requested = await ownerStore.requestTeacherDeletion('owner-uid');
  assert.equal(requested.status, 'deletion_pending');
  const pending = await adminRead('teacher_allowances/owner-uid');
  assert.equal(pending.enabled, false);
  assert.equal(pending.revision, 2);
  assert.equal(pending.purgeEligibleAt.toMillis() - pending.deletionRequestedAt.toMillis(), 30 * 24 * 60 * 60 * 1000);
  assert.equal((await adminRead('teacher_allowlist/owner@school.kr')).enabled, false);

  await assertFails(getDoc(doc(owner, 'quiz_sets/set1')));
  await assertFails(updateDoc(doc(owner, 'quiz_sets/set1'), { title: 'blocked-save' }));
  await assertFails(setDoc(doc(owner, 'sessions/deletion-new'), {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'live', registeredStudentCount: 0, studentCountRevision: 0,
    createdAt: serverTimestamp(), activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000)
  }));
  const readiness = await ownerStore.getTeacherDeletionReadiness('owner-uid');
  assert.equal(readiness.ownedSetCount > 0, true);
  assert.equal(readiness.blockingSessionCount > 0, true);

  await ownerStore.resolveTeacherDeletionSession('owner-uid', 'deletion-live').catch(error => {
    throw new Error('safe reciprocal end stage: ' + error.message, { cause: error });
  });
  assert.equal((await adminRead('sessions/deletion-live')).status, 'ended');
  assert.equal((await adminRead('sessions/deletion-live/meta/live')).status, 'ended');
  assert.equal((await adminRead('class_plans_private/deletion-plan')).status, 'ended');
  assert.equal((await adminRead('class_plans_public/deletion-plan')).status, 'ended');
  assert.equal((await adminRead('sessions/deletion-live')).classPlanRevision, 3);

  await adminStore.suspendTeacher('owner-uid', 'independent-hold', requestAdminIdentity).catch(error => {
    throw new Error('admin-hold stage: ' + error.message, { cause: error });
  });
  const held = await adminRead('teacher_allowances/owner-uid');
  assert.equal(held.status, 'deletion_pending');
  assert.equal(held.administrativeHold, true);
  assert.equal(held.revision, 3);

  const cancelled = await ownerStore.cancelTeacherDeletion('owner-uid').catch(error => {
    throw new Error('cancel stage: ' + error.message, { cause: error });
  });
  assert.equal(cancelled.status, 'suspended');
  assert.equal(cancelled.enabled, false);
  assert.equal(cancelled.administrativeHold, true);
  assert.equal(cancelled.revision, 4);
  assert.equal(Object.hasOwn(cancelled, 'deletionRequestedAt'), false);
  assert.equal(Object.hasOwn(cancelled, 'purgeEligibleAt'), false);

  await assertFails(deleteDoc(doc(owner, 'teacher_allowances/owner-uid')));
  await assertFails(deleteDoc(doc(admin, 'teacher_allowances/owner-uid')));
  await assertFails(deleteDoc(doc(admin, 'teacher_access_requests/owner-uid')));
});

rulesTest('suspended owner may list and safely finish only existing own live session and plan', async () => {
  const now = Date.now();
  await writeClassPlanPairDisabled('suspended-plan', {
    status: 'live', revision: 2, sessionId: 'suspended-session',
    actualStartedAt: Timestamp.fromMillis(now)
  });
  await adminWrite('sessions/suspended-session', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'live', activationLeaseUntil: Timestamp.fromMillis(now + 60_000),
    registeredStudentCount: 0, studentCountRevision: 0,
    classPlanId: 'suspended-plan', classPlanRevision: 2
  });
  await adminWrite('sessions/suspended-session/meta/live', liveQuestion(0));
  const adminStore = emulatorStore(actorFirestore('admin'));
  const ownerStore = emulatorStore(actorFirestore('owner'));
  await adminStore.suspendTeacher('owner-uid', 'hold', requestAdminIdentity);

  const readiness = await ownerStore.getTeacherDeletionReadiness('owner-uid');
  assert.ok(readiness.blockingSessions.some(item => item.sessionId === 'suspended-session'));
  await ownerStore.resolveTeacherDeletionSession('owner-uid', 'suspended-session');
  assert.equal((await adminRead('sessions/suspended-session')).status, 'ended');
  assert.equal((await adminRead('class_plans_public/suspended-plan')).status, 'ended');
  await assertFails(setDoc(doc(actorFirestore('owner'), 'sessions/suspended-new'), {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'live',
    registeredStudentCount: 0, studentCountRevision: 0,
    activationLeaseUntil: Timestamp.fromMillis(now + 60_000)
  }));
});

rulesTest('teacher-deletion: cancellation closes at the exact request.time boundary and rejects malformed revision/timestamps', async () => {
  const uid = 'old-deletion-uid';
  const email = 'old-deletion@school.kr';
  const requestedAt = Timestamp.fromMillis(1);
  const purgeEligibleAt = Timestamp.fromMillis(30 * 24 * 60 * 60 * 1000 + 1);
  await adminWrite(`teacher_allowances/${uid}`, {
    uid, emailCanonical: email, displayName: '기한 경과 교사',
    status: 'deletion_pending', enabled: false, role: 'teacher', administrativeHold: false,
    revision: 2, approvedAt: Timestamp.fromMillis(1), approvedByUid: 'admin-uid',
    deletionRequestedAt: requestedAt, purgeEligibleAt,
    updatedAt: Timestamp.fromMillis(2), updatedByUid: uid
  });
  await adminWrite(`teacher_allowlist/${email}`, { enabled: false, role: 'teacher' });
  const teacher = googleContext(uid, email);

  await assertFails(updateDoc(doc(teacher, `teacher_allowances/${uid}`), {
    status: 'active', enabled: true, revision: 3,
    deletionRequestedAt: deleteField(), purgeEligibleAt: deleteField(),
    updatedAt: serverTimestamp(), updatedByUid: uid
  }));
  await assertFails(updateDoc(doc(teacher, `teacher_allowances/${uid}`), {
    revision: 2.5, updatedAt: serverTimestamp(), updatedByUid: uid
  }));
});

rulesTest('teacher-deletion fix: pending owner safely resolves orphan allocation and admin exact-revision cancellation cannot be forged', async () => {
  const uid = 'deletion-recovery-uid';
  const email = 'deletion-recovery@school.kr';
  const requestedAt = Timestamp.fromMillis(Date.now());
  const purgeEligibleAt = Timestamp.fromMillis(requestedAt.toMillis() + 30 * 24 * 60 * 60 * 1000);
  await adminWrite(`teacher_allowances/${uid}`, {
    uid, emailCanonical: email, displayName: '복구 교사',
    status: 'deletion_pending', enabled: false, role: 'teacher', administrativeHold: false,
    revision: 7, approvedAt: Timestamp.fromMillis(1), approvedByUid: 'admin-uid',
    deletionRequestedAt: requestedAt, purgeEligibleAt,
    updatedAt: requestedAt, updatedByUid: uid
  });
  await adminWrite(`teacher_allowlist/${email}`, { enabled: false, role: 'teacher' });
  await adminWrite('sessions/deletion-orphan', {
    teacherUid: uid, teacherEmail: email, setId: 'set1', code: 'DEL123',
    status: 'allocating', registeredStudentCount: 0, studentCountRevision: 0,
    createdAt: Timestamp.fromMillis(1)
  });
  await adminWrite('codes/DEL123', { sessionId: 'deletion-orphan', createdAt: Timestamp.fromMillis(1) });
  await adminWrite('sessions/deletion-orphan/meta/allocation', {
    token: 'deletion-orphan-allocation-token', ownerUid: uid
  });
  await adminWrite('sessions/deletion-orphan/meta/live', liveQuestion(0));
  await adminWrite('sessions/deletion-orphan/meta/board', { scores: {} });
  await adminWrite('sessions/deletion-expired-live', {
    teacherUid: uid, teacherEmail: email, status: 'live', code: 'OLD123',
    registeredStudentCount: 0, studentCountRevision: 0,
    activationLeaseUntil: Timestamp.fromMillis(1)
  });

  const ownerDb = googleContext(uid, email);
  const ownerStore = emulatorStore(ownerDb);
  const otherStore = emulatorStore(actorFirestore('otherTeacher'));
  const adminStore = emulatorStore(actorFirestore('admin'));
  const readiness = await ownerStore.getTeacherDeletionReadiness(uid);
  assert.deepEqual(readiness.blockingSessions.map(item => [item.sessionId, item.status]).sort(), [
    ['deletion-expired-live', 'live'], ['deletion-orphan', 'allocating']
  ]);
  await assertFails(updateDoc(doc(ownerDb, 'sessions/deletion-expired-live'), {
    status: 'aborted', abortedAt: serverTimestamp()
  }));
  assert.equal(await ownerStore.resolveTeacherDeletionSession(uid, 'deletion-orphan'), true);
  assert.equal((await adminRead('sessions/deletion-orphan')).status, 'aborted');
  assert.equal((await adminRead('codes/DEL123')).sessionId, 'deletion-orphan');

  await assert.rejects(otherStore.adminCancelTeacherDeletion(uid, 7, {
    uid: 'other-uid', email: 'other@school.kr', role: 'admin',
    authGeneration: 1, currentAuthGeneration: 1
  }));
  await assert.rejects(otherStore.cancelTeacherDeletion(uid));
  const pendingList = await adminStore.listDeletionPendingTeachers(50, requestAdminIdentity);
  assert.equal(pendingList[uid].revision, 7);
  await assert.rejects(adminStore.adminCancelTeacherDeletion(uid, 6, requestAdminIdentity));
  const cancelled = await adminStore.adminCancelTeacherDeletion(uid, 7, requestAdminIdentity);
  assert.equal(cancelled.status, 'active');
  assert.equal(cancelled.revision, 8);
  assert.equal(cancelled.updatedByUid, 'admin-uid');

  const heldUid = 'deletion-held-uid';
  const heldEmail = 'deletion-held@school.kr';
  await adminWrite(`teacher_allowances/${heldUid}`, {
    uid: heldUid, emailCanonical: heldEmail, displayName: '중지 유지 교사',
    status: 'deletion_pending', enabled: false, role: 'teacher', administrativeHold: true,
    revision: 4, approvedAt: Timestamp.fromMillis(1), approvedByUid: 'admin-uid',
    deletionRequestedAt: requestedAt, purgeEligibleAt,
    suspendedAt: requestedAt, suspendedByUid: 'admin-uid', suspensionReason: 'hold',
    updatedAt: requestedAt, updatedByUid: 'admin-uid'
  });
  await adminWrite(`teacher_allowlist/${heldEmail}`, { enabled: false, role: 'teacher' });
  const heldCancelled = await adminStore.adminCancelTeacherDeletion(
    heldUid, 4, requestAdminIdentity
  );
  assert.equal(heldCancelled.status, 'suspended');
  assert.equal(heldCancelled.enabled, false);
  assert.equal(heldCancelled.administrativeHold, true);
  assert.equal(heldCancelled.revision, 5);
});

rulesTest('미승인 계정과 학생은 원본 세트를 읽지 못한다', async () => {
  const unapproved = googleContext('unapproved-uid', 'blocked@school.kr');
  const student = anonymousContext('student-uid');
  const owner = googleContext('owner-uid', 'owner@school.kr');

  await assertFails(getDoc(doc(unapproved, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(student, 'quiz_sets/set1')));
  await assertSucceeds(getDoc(doc(owner, 'quiz_sets/set1')));
});

rulesTest('보호된 비존재 문서 프로브는 allowlist를 공개하지 않고 교사와 admin 권한만 구분한다', async () => {
  const owner = actorFirestore('owner');
  const admin = actorFirestore('admin');
  const unapproved = actorFirestore('unapproved');
  const student = actorFirestore('student');
  const teacherProbe = 'quiz_sets/__teacher_allowance_probe__owner%40school.kr';
  const adminProbe = 'config/__admin_allowance_probe__admin%40school.kr';

  await assertSucceeds(getDoc(doc(owner, teacherProbe)));
  await assertSucceeds(getDoc(doc(admin, teacherProbe)));
  await assertFails(getDoc(doc(unapproved, teacherProbe)));
  await assertFails(getDoc(doc(student, teacherProbe)));
  await assertSucceeds(getDoc(doc(admin, adminProbe)));
  await assertFails(getDoc(doc(owner, adminProbe)));
  await assertFails(getDoc(doc(owner, 'teacher_allowlist/owner@school.kr')));
});

rulesTest('config/legacy_owner is completely client denied including admins', async () => {
  await adminWrite('config/legacy_owner', { uid: 'owner-uid', email: 'owner@school.kr' });
  for (const actorName of actorNames) {
    const db = actorFirestore(actorName);
    await assertFails(getDoc(doc(db, 'config/legacy_owner')));
    await assertFails(getDocs(collection(db, 'config')));
    await assertFails(updateDoc(doc(db, 'config/legacy_owner'), { email: 'changed@school.kr' }));
    await assertFails(deleteDoc(doc(db, 'config/legacy_owner')));
  }
  await adminWrite('config/legacy_owner', undefined);
  for (const actorName of actorNames) {
    await assertFails(setDoc(doc(actorFirestore(actorName), 'config/legacy_owner'), {
      uid: actors[actorName].uid, email: actors[actorName].email || 'student@school.kr'
    }));
  }
});

rulesTest('all legacy parent claims and response replacements are client denied', async () => {
  await adminWrite('config/legacy_owner', { uid: 'owner-uid', email: 'owner@school.kr' });
  await adminWrite('quiz_sets/legacy-set', { title: 'Legacy' });
  await adminWrite('sessions/legacy-session', { setId: 'legacy-set', status: 'ended' });
  await adminWrite('sessions/legacy-session/responses/legacy-student', {
    answers: { 0: { answer: 1, submitted: true, revision: 2, ok: true, score: 1 } }
  });
  for (const actorName of ['owner', 'otherTeacher', 'admin']) {
    const db = actorFirestore(actorName);
    await assertFails(updateDoc(doc(db, 'quiz_sets/legacy-set'), {
      ownerUid: actors[actorName].uid, ownerEmail: actors[actorName].email
    }));
    await assertFails(updateDoc(doc(db, 'sessions/legacy-session'), {
      teacherUid: actors[actorName].uid, teacherEmail: actors[actorName].email
    }));
    await assertFails(setDoc(doc(db, 'sessions/legacy-session/responses/legacy-student'), {
      uid: 'legacy-student',
      answers: { 0: { answer: 1, submitted: true, revision: 2 } }
    }));
  }
});

rulesTest('승인 교사는 공유 원본과 이미지를 strict counter 프로토콜로 자기 소유 사본을 만든다', async () => {
  const teacher = actorFirestore('otherTeacher');
  await adminWrite('quiz_sets/set1/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  const sourceReference = doc(teacher, 'quiz_sets/set1');
  const before = await assertSucceeds(getDoc(sourceReference));
  const images = await assertSucceeds(getDocs(collection(teacher, 'images/set1/q')));
  assert.equal(images.size, 1);
  const copiedValue = await emulatorStore(teacher).copyOwnedQuizSet(
    'set1', 'copied-by-other', actors.otherTeacher
  );
  assert.equal(copiedValue.ownerUid, actors.otherTeacher.uid);
  assert.equal(before.data().ownerUid, actors.owner.uid);

  const copied = await assertSucceeds(getDoc(doc(teacher, 'quiz_sets/copied-by-other')));
  assert.equal(copied.data().ownerUid, actors.otherTeacher.uid);
  const copiedImages = await assertSucceeds(getDocs(collection(teacher, 'images/copied-by-other/q')));
  assert.equal(copiedImages.size, 1);
});

rulesTest('이미지 교체 batch의 부모 revision 갱신은 소유 교사에게만 허용된다', async () => {
  const replace = actorName => {
    const db = actorFirestore(actorName);
    const batch = writeBatch(db);
    batch.set(doc(db, 'quiz_sets/set1'), { contentRevision: serverTimestamp() }, { merge: true });
    batch.set(doc(db, 'images/set1/q/0'), { data: `${actorName}-image` });
    return batch.commit();
  };

  await assertFails(replace('otherTeacher'));
  await assertSucceeds(replace('owner'));

  const owner = actorFirestore('owner');
  const source = await assertSucceeds(getDoc(doc(owner, 'quiz_sets/set1')));
  assert.ok(source.data().contentRevision instanceof Timestamp);
  const image = await assertSucceeds(getDoc(doc(owner, 'images/set1/q/0')));
  assert.equal(image.data().data, 'owner-image');
});

rulesTest('소유 교사의 standalone 이미지 create·update·delete는 모두 거부된다', async () => {
  const owner = actorFirestore('owner');

  await assertFails(setDoc(doc(owner, 'images/set1/q/new'), { data: 'standalone-create' }));
  await assertFails(setDoc(doc(owner, 'images/set1/q/0'), { data: 'standalone-update' }));
  await assertFails(deleteDoc(doc(owner, 'images/set1/q/0')));

  const existing = await assertSucceeds(getDoc(doc(owner, 'images/set1/q/0')));
  assert.equal(existing.data().data, 'owner-image');
});

rulesTest('strict counter 저장 API는 이미지 create·update·delete를 함께 허용한다', async () => {
  await adminWrite('images/set1/q/delete-me', { data: 'old-delete' });
  await adminWrite('quiz_sets/set1', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'active', collaboratorCount: 0, imageCount: 2,
    title: '보안 규칙 테스트', contentRevision: Timestamp.fromMillis(1)
  });
  const owner = actorFirestore('owner');
  await emulatorStore(owner).saveQuizSetWithImages('set1', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'active', collaboratorCount: 0, imageCount: 2,
    title: '변경'
  }, { v0q0: 'batch-update', v0q1: 'batch-create' }, actors.owner);
  assert.equal((await getDoc(doc(owner, 'images/set1/q/v0q1'))).data().data, 'batch-create');
  assert.equal((await getDoc(doc(owner, 'images/set1/q/v0q0'))).data().data, 'batch-update');
  assert.equal((await getDoc(doc(owner, 'images/set1/q/0'))).exists(), false);
  assert.equal((await getDoc(doc(owner, 'images/set1/q/delete-me'))).exists(), false);
  assert.equal((await getDoc(doc(owner, 'quiz_sets/set1'))).data().imageCount, 2);
});

rulesTest('allocation abort는 인증 교체·화면 이탈·부분 정리·code 재할당에서 fail closed다', async t => {
  const allocation = (store, sessionId, code) => store.startSession(sessionId, {
    setId: 'set1', setTitle: '세트', teacherUid: actors.owner.uid,
    teacherEmail: actors.owner.email, status: 'live', createdAt: serverTimestamp(),
    setSnapshot: { title: '세트', videos: [{ questions: [] }] },
    snapshotImages: { v0q0: 'image' }
  }, () => code);

  await t.test('auth replacement cannot mutate owner allocation and owner retry removes it', async () => {
    await resetFirestore();
    const ownerStore = emulatorStore(actorFirestore('owner'));
    const replacementStore = emulatorStore(actorFirestore('otherTeacher'));
    await allocation(ownerStore, 'auth-replaced', 'AUTH23');

    await assert.rejects(() => replacementStore.abortSessionAllocation(
      'auth-replaced', 'AUTH23', actors.owner.uid
    ), /정리.*실패/);
    await assertFails(getDoc(doc(actorFirestore('student'), 'sessions/auth-replaced')));
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'sessions/auth-replaced'))).data().status, 'allocating');

    assert.equal(await ownerStore.abortSessionAllocation(
      'auth-replaced', 'AUTH23', actors.owner.uid
    ), true);
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'sessions/auth-replaced'))).exists(), false);
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'codes/AUTH23'))).exists(), false);
  });

  await t.test('route-away cleanup is idempotent', async () => {
    await resetFirestore();
    const ownerStore = emulatorStore(actorFirestore('owner'));
    await allocation(ownerStore, 'route-away', 'ROUTE2');

    assert.equal(await ownerStore.abortSessionAllocation(
      'route-away', 'ROUTE2', actors.owner.uid
    ), true);
    assert.equal(await ownerStore.abortSessionAllocation(
      'route-away', 'ROUTE2', actors.owner.uid
    ), true);
  });

  await t.test('partial cleanup with aborted parent and missing code resumes safely', async () => {
    await resetFirestore();
    await adminWrite('sessions/partial', {
      code: 'PART23', setId: 'set1', teacherUid: actors.owner.uid,
      teacherEmail: actors.owner.email, status: 'aborted',
      registeredStudentCount: 0, studentCountRevision: 0
    });
    await adminWrite('sessions/partial/meta/live', { q: -1, openedAt: 0, revealed: false, limitSec: 0 });
    await adminWrite('sessions/partial/meta/board', { scores: {} });
    await adminWrite('sessions/partial/snapshot/set', { title: '세트', videos: [{ questions: [] }] });

    const ownerStore = emulatorStore(actorFirestore('owner'));
    assert.equal(await ownerStore.abortSessionAllocation(
      'partial', 'PART23', actors.owner.uid
    ), true);
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'sessions/partial'))).exists(), false);
    assert.equal((await getDoc(doc(actorFirestore('admin'), 'sessions/partial/meta/live'))).exists(), false);
  });

  await t.test('reassigned code and newer session are preserved', async () => {
    await resetFirestore();
    await adminWrite('sessions/old-allocation', {
      code: 'REASN2', setId: 'set1', teacherUid: actors.owner.uid,
      teacherEmail: actors.owner.email, status: 'allocating',
      registeredStudentCount: 0, studentCountRevision: 0
    });
    await adminWrite('sessions/new-allocation', {
      code: 'REASN2', setId: 'set1', teacherUid: actors.owner.uid,
      teacherEmail: actors.owner.email, status: 'live',
      registeredStudentCount: 0, studentCountRevision: 0
    });
    await adminWrite('codes/REASN2', { sessionId: 'new-allocation' });

    const ownerStore = emulatorStore(actorFirestore('owner'));
    assert.equal(await ownerStore.abortSessionAllocation(
      'old-allocation', 'REASN2', actors.owner.uid
    ), true);
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'sessions/old-allocation'))).exists(), false);
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'sessions/new-allocation'))).exists(), true);
    assert.equal((await getDoc(doc(actorFirestore('owner'), 'codes/REASN2'))).data().sessionId, 'new-allocation');
  });
});

rulesTest('session counter migration gate는 legacy 안전 경로만 rollout 동안 열고 완료 뒤 strict로 닫는다', async t => {
  const gatePath = 'migration_gates/session_counters';
  const gateTime = Timestamp.fromMillis(10_000);
  const completeGate = {
    complete: true,
    projectId,
    environment: 'emulator',
    rulesVersion: 'session-counters-v1',
    preflightNonEndedLegacyCount: 0,
    verifiedAt: gateTime,
    updatedAt: gateTime,
    completedByUid: actors.admin.uid
  };
  const seedLegacy = async (sessionId, code, status = 'live') => {
    await adminWrite(`sessions/${sessionId}`, {
      code, setId: 'set1', teacherUid: actors.owner.uid,
      teacherEmail: actors.owner.email, status,
      activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000)
    });
    await adminWrite(`codes/${code}`, { sessionId });
    await adminWrite(`sessions/${sessionId}/meta/live`, {
      q: -1, openedAt: 0, revealed: false, limitSec: 0
    });
    await adminWrite(`sessions/${sessionId}/meta/allocation`, {
      token: `${sessionId}-allocation-token`, ownerUid: actors.owner.uid
    });
  };

  await t.test('gate 전 legacy heartbeat와 safe end는 actual 없이 가능하고 신규 join은 거부된다', async () => {
    await resetFirestore();
    await seedLegacy('legacy-live', 'LEGA12');
    const ownerStore = emulatorStore(actorFirestore('owner'));

    assert.equal(await ownerStore.renewSessionActivationLease(
      'legacy-live', 'LEGA12', actors.owner.uid, 'legacy-live-allocation-token'
    ), true);
    await assertFails(setDoc(doc(actorFirestore('anonymous'),
      'sessions/legacy-live/students/new-student-uid'), {
      uid: 'new-student-uid', grade: 1, klass: 1, num: 1, name: '신규 학생'
    }));
    await ownerStore.endSession('legacy-live');

    const ended = (await getDoc(doc(actorFirestore('owner'), 'sessions/legacy-live'))).data();
    assert.equal(ended.status, 'ended');
    assert.equal(ended.actualParticipants, undefined);
    assert.equal((await getDoc(doc(actorFirestore('owner'),
      'sessions/legacy-live/meta/live'))).data().status, 'ended');
  });

  await t.test('gate 전 legacy allocating recovery는 안전 정리할 수 있다', async () => {
    await resetFirestore();
    await seedLegacy('legacy-allocating', 'LEGA13', 'allocating');
    const ownerStore = emulatorStore(actorFirestore('owner'));
    const result = await ownerStore.recoverPendingSessionAllocation({
      sessionId: 'legacy-allocating', code: 'LEGA13', ownerUid: actors.owner.uid,
      ownerEmail: actors.owner.email, token: 'legacy-allocating-allocation-token'
    });

    assert.deepEqual(result, { complete: true, cleaned: true });
    assert.equal((await getDoc(doc(actorFirestore('owner'),
      'sessions/legacy-allocating'))).exists(), false);

    await seedLegacy('legacy-stale-live', 'LEGA16');
    const stale = await adminRead('sessions/legacy-stale-live');
    await adminWrite('sessions/legacy-stale-live', {
      ...stale, activationLeaseUntil: Timestamp.fromMillis(Date.now() - 1_000)
    });
    assert.deepEqual(await ownerStore.recoverPendingSessionAllocation({
      sessionId: 'legacy-stale-live', code: 'LEGA16', ownerUid: actors.owner.uid,
      ownerEmail: actors.owner.email, token: 'legacy-stale-live-allocation-token'
    }), { complete: true, cleaned: true });
    assert.equal((await getDoc(doc(actorFirestore('owner'),
      'sessions/legacy-stale-live'))).exists(), false);
  });

  await t.test('gate는 client write를 거부하고 exact preflight shape가 아니면 아직 완료로 취급하지 않는다', async () => {
    await resetFirestore();
    for (const actorName of ['owner', 'admin']) {
      await assertFails(setDoc(doc(actorFirestore(actorName), gatePath), completeGate));
    }
    await adminWrite(gatePath, { ...completeGate, preflightNonEndedLegacyCount: 1 });
    await seedLegacy('legacy-malformed-gate', 'LEGA14');
    assert.equal(await emulatorStore(actorFirestore('owner')).renewSessionActivationLease(
      'legacy-malformed-gate', 'LEGA14', actors.owner.uid,
      'legacy-malformed-gate-allocation-token'
    ), true);
  });

  await t.test('gate 완료 뒤 missing counter 경로는 거부하고 migrated session 경로는 유지된다', async () => {
    await resetFirestore();
    await adminWrite(gatePath, completeGate);
    await seedLegacy('legacy-after-gate', 'LEGA15');
    const ownerStore = emulatorStore(actorFirestore('owner'));
    await assert.rejects(ownerStore.renewSessionActivationLease(
      'legacy-after-gate', 'LEGA15', actors.owner.uid,
      'legacy-after-gate-allocation-token'
    ));
    await assert.rejects(ownerStore.endSession('legacy-after-gate'));
    await assert.rejects(ownerStore.abortSessionAllocation(
      'legacy-after-gate', 'LEGA15', actors.owner.uid,
      'legacy-after-gate-allocation-token'
    ), /정리.*실패/);

    await adminWrite('sessions/migrated-after-gate', {
      code: 'MIGR15', setId: 'set1', teacherUid: actors.owner.uid,
      teacherEmail: actors.owner.email, status: 'live',
      registeredStudentCount: 0, studentCountRevision: 0,
      activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000)
    });
    await adminWrite('codes/MIGR15', { sessionId: 'migrated-after-gate' });
    await adminWrite('sessions/migrated-after-gate/meta/live', {
      q: -1, openedAt: 0, revealed: false, limitSec: 0
    });
    await adminWrite('sessions/migrated-after-gate/meta/allocation', {
      token: 'migrated-after-gate-token', ownerUid: actors.owner.uid
    });
    assert.equal(await ownerStore.renewSessionActivationLease(
      'migrated-after-gate', 'MIGR15', actors.owner.uid, 'migrated-after-gate-token'
    ), true);
    await ownerStore.endSession('migrated-after-gate');
    assert.equal((await getDoc(doc(actorFirestore('owner'),
      'sessions/migrated-after-gate'))).data().actualParticipants, 0);
  });
});

rulesTest('stale activation과 heartbeat는 server-time lease 밖에서 학생 접근을 자동 차단한다', async () => {
  const token = 'lease-token-1234567890';
  let synchronizedNow = Date.now();
  const activationLeaseUntil = synchronizedNow + 120_000;
  let reachedRead;
  let releaseRead;
  const atRead = new Promise(resolve => { reachedRead = resolve; });
  const release = new Promise(resolve => { releaseRead = resolve; });
  const ownerStore = emulatorStore(actorFirestore('owner'), null, {
    path: 'sessions/lease-race',
    async wait() {
      reachedRead();
      await release;
    }
  }, () => synchronizedNow);
  const replacementStore = emulatorStore(actorFirestore('otherTeacher'));

  await assertSucceeds(setDoc(doc(actorFirestore('owner'), 'sessions/preseeded-lease'), {
    teacherUid: actors.owner.uid,
    teacherEmail: actors.owner.email,
    status: 'allocating',
    registeredStudentCount: 0,
    studentCountRevision: 0,
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 180_000)
  }));
  await assertFails(updateDoc(
    doc(actorFirestore('owner'), 'sessions/preseeded-lease'), { status: 'live' }
  ));

  await ownerStore.startSession('lease-race', {
    setId: 'set1', setTitle: '세트', teacherUid: actors.owner.uid,
    teacherEmail: actors.owner.email, status: 'live', createdAt: serverTimestamp(),
    allocationToken: token,
    setSnapshot: { title: '세트', videos: [{ questions: [] }] }
  }, () => 'LEASE2');

  const activating = ownerStore.activateSessionAllocation(
    'lease-race', 'LEASE2', actors.owner.uid, token
  );
  await atRead;
  synchronizedNow += 60_000;
  releaseRead();
  assert.equal(await activating, true);
  await assert.rejects(() => replacementStore.abortSessionAllocation(
    'lease-race', 'LEASE2', actors.owner.uid, token
  ), /정리.*실패/);

  const owner = actorFirestore('owner');
  const student = actorFirestore('student');
  const active = await getDoc(doc(owner, 'sessions/lease-race'));
  assert.equal(active.data().status, 'live');
  assert.equal(active.data().activationLeaseUntil.toMillis(), activationLeaseUntil);
  await assertSucceeds(getDoc(doc(student, 'sessions/lease-race')));

  await adminWrite('sessions/lease-race', {
    ...active.data(),
    activationLeaseUntil: Timestamp.fromMillis(Date.now() - 20_000)
  });
  await assertFails(getDoc(doc(student, 'sessions/lease-race')));
  await assertFails(setDoc(doc(student, 'sessions/lease-race/students/student-uid'), {
    uid: 'student-uid', grade: 1, klass: 1, num: 1, name: '학생'
  }));

  await assertFails(updateDoc(doc(owner, 'sessions/lease-race'), {
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 180_000)
  }));

  let reachedRenewRead;
  let releaseRenewRead;
  const atRenewRead = new Promise(resolve => { reachedRenewRead = resolve; });
  const releaseRenew = new Promise(resolve => { releaseRenewRead = resolve; });
  synchronizedNow = Date.now();
  const renewedLeaseUntil = synchronizedNow + 120_000;
  const renewStore = emulatorStore(owner, null, {
    path: 'sessions/lease-race',
    async wait() {
      reachedRenewRead();
      await releaseRenew;
    }
  }, () => synchronizedNow);
  const renewing = renewStore.renewSessionActivationLease(
    'lease-race', 'LEASE2', actors.owner.uid, token
  );
  await atRenewRead;
  synchronizedNow += 60_000;
  releaseRenewRead();
  assert.equal(await renewing, true);
  assert.equal(
    (await getDoc(doc(owner, 'sessions/lease-race'))).data().activationLeaseUntil.toMillis(),
    renewedLeaseUntil
  );
  await assertSucceeds(getDoc(doc(student, 'sessions/lease-race')));
});

rulesTest('등록 학생 live listener는 atomic endSession의 ended projection을 계속 읽는다', async () => {
  const student = actorFirestore('student');
  const ownerStore = emulatorStore(actorFirestore('owner'));
  const liveReference = doc(student, 'sessions/s1/meta/live');
  const now = Date.now();
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    accepting: true,
    responseClosesAt: Timestamp.fromMillis(now + 10_000),
    submitGraceUntil: Timestamp.fromMillis(now + 60_000),
    revealAt: Timestamp.fromMillis(now + 60_000)
  }));
  let initialResolve;
  let endedResolve;
  let initialReject;
  let endedReject;
  const initial = new Promise((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
  });
  const ended = new Promise((resolve, reject) => {
    endedResolve = resolve;
    endedReject = reject;
  });
  const unsubscribe = onSnapshot(liveReference, snapshot => {
    const value = snapshot.data() || {};
    initialResolve(value);
    if (value.status === 'ended') endedResolve(value);
  }, error => {
    initialReject(error);
    endedReject(error);
  });

  let endedLive;
  try {
    await initial;
    await ownerStore.endSession('s1');
    endedLive = await ended;
  } finally {
    unsubscribe();
  }

  assert.deepEqual(endedLive, {
    q: -1,
    openedAt: 0,
    revealed: false,
    limitSec: 0,
    status: 'ended'
  });
  assert.equal((await assertSucceeds(getDoc(doc(student, 'sessions/s1')))).data().status, 'ended');
  assert.equal((await assertSucceeds(getDoc(liveReference))).data().status, 'ended');
  await assertFails(updateDoc(doc(student, 'sessions/s1/students/student-uid'), {
    name: '종료 뒤 변경'
  }));
  await assertFails(updateDoc(doc(student, 'sessions/s1/responses/student-uid'), {
    'answers.0': { answer: 0, submitted: true, revision: 2 }
  }));
  await assertFails(getDoc(doc(actorFirestore('anonymous'), 'sessions/s1/meta/live')));
});

rulesTest('attached session student join atomically mirrors public actual participants and rejects forge or replay', async () => {
  const now = Date.now();
  await writeClassPlanPairDisabled('join-plan', {
    status: 'live', revision: 2, sessionId: 'join-plan-session',
    actualStartedAt: Timestamp.fromMillis(now)
  });
  await adminWrite('sessions/join-plan-session', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'live', activationLeaseUntil: Timestamp.fromMillis(now + 60_000),
    registeredStudentCount: 0, studentCountRevision: 0,
    classPlanId: 'join-plan', classPlanRevision: 2
  });
  await adminWrite('sessions/join-plan-session/meta/live', liveQuestion(0));
  const student = actorFirestore('anonymous');
  const store = emulatorStore(student);

  await store.joinStudent('join-plan-session', 'new-student-uid', {
    name: '신규', grade: 1, klass: 1, num: 1
  });
  assert.equal((await adminRead('sessions/join-plan-session')).registeredStudentCount, 1);
  assert.equal((await adminRead('class_plans_public/join-plan')).actualParticipants, 1);
  assert.equal((await adminRead('class_plans_private/join-plan')).actualParticipants, undefined);

  await assertFails(updateDoc(doc(student, 'class_plans_public/join-plan'), {
    actualParticipants: 99
  }));
  await store.joinStudent('join-plan-session', 'new-student-uid', {
    name: '신규 수정', grade: 1, klass: 1, num: 1
  });
  assert.equal((await adminRead('sessions/join-plan-session')).registeredStudentCount, 1);
  assert.equal((await adminRead('class_plans_public/join-plan')).actualParticipants, 1);
});

rulesTest('session counter migration lock closes every new join until exact server unlock', async () => {
  const now = Date.now();
  await adminWrite('sessions/counter-lock-session', {
    teacherUid: actors.owner.uid, teacherEmail: actors.owner.email, setId: 'set1',
    status: 'live', activationLeaseUntil: Timestamp.fromMillis(now + 60_000),
    registeredStudentCount: 0, studentCountRevision: 0
  });
  await adminWrite('sessions/counter-lock-session/meta/live', liveQuestion(0));
  await adminWrite('migration_gates/session_counter_migration', {
    locked: true, lockToken: 'counter-lock-a', projectId, targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(now), lockedByUid: actors.admin.uid
  });
  const store = emulatorStore(actorFirestore('anonymous'));
  await assert.rejects(store.joinStudent('counter-lock-session', actors.anonymous.uid, {
    name: '잠금 학생', grade: 1, klass: 1, num: 1
  }));
  assert.equal((await adminRead('sessions/counter-lock-session')).registeredStudentCount, 0);

  await adminWrite('migration_gates/session_counter_migration', {
    locked: false, lockToken: 'counter-lock-a', projectId, targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(now), lockedByUid: actors.admin.uid,
    unlockedAt: Timestamp.fromMillis(now + 1), unlockedByUid: actors.admin.uid
  });
  await store.joinStudent('counter-lock-session', actors.anonymous.uid, {
    name: '잠금 해제 학생', grade: 1, klass: 1, num: 1
  });
  assert.equal((await adminRead('sessions/counter-lock-session')).registeredStudentCount, 1);
});

rulesTest('active student deletion cannot invalidate a counter audit and cleanup waits for unlock', async () => {
  const admin = actorFirestore('admin');
  const owner = actorFirestore('owner');
  const studentPath = 'sessions/s1/students/student-uid';

  await assertFails(deleteDoc(doc(admin, studentPath)));
  await assertFails(deleteDoc(doc(owner, studentPath)));
  assert.equal((await adminRead('sessions/s1')).registeredStudentCount, 2);
  assert.equal((await adminRead(studentPath)).uid, 'student-uid');

  await adminWrite('migration_gates/session_counter_migration', {
    locked: true, lockToken: 'counter-lock-delete', projectId, targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(Date.now()), lockedByUid: actors.admin.uid
  });
  await assertFails(deleteDoc(doc(admin, studentPath)));
  const scanAfterDeniedDelete = await assertSucceeds(
    getDocs(collection(admin, 'sessions/s1/students'))
  );
  assert.equal(scanAfterDeniedDelete.size, 2);
  assert.equal((await adminRead(studentPath)).uid, 'student-uid');

  await adminWrite('sessions/s1', {
    ...(await adminRead('sessions/s1')), status: 'ended'
  });
  await assertFails(deleteDoc(doc(admin, studentPath)));
  await adminWrite('migration_gates/session_counter_migration', {
    locked: false, lockToken: 'counter-lock-delete', projectId, targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(1), lockedByUid: actors.admin.uid,
    unlockedAt: Timestamp.fromMillis(2), unlockedByUid: actors.admin.uid
  });
  await assertSucceeds(deleteDoc(doc(admin, studentPath)));
});

rulesTest('class planning thresholds are teacher-readable and exact admin-only server-time writes', async () => {
  await adminWrite('config/class_planning', {
    caution: 60, crowded: 120,
    updatedAt: Timestamp.fromMillis(1), updatedByUid: actors.admin.uid
  });
  await assertSucceeds(getDoc(doc(actorFirestore('owner'), 'config/class_planning')));
  await assertFails(getDoc(doc(actorFirestore('anonymous'), 'config/class_planning')));
  await assertFails(updateDoc(doc(actorFirestore('owner'), 'config/class_planning'), {
    caution: 70, crowded: 140, updatedAt: serverTimestamp(), updatedByUid: actors.owner.uid
  }));
  await assertSucceeds(updateDoc(doc(actorFirestore('admin'), 'config/class_planning'), {
    caution: 70, crowded: 140, updatedAt: serverTimestamp(), updatedByUid: actors.admin.uid
  }));
  await assertFails(updateDoc(doc(actorFirestore('admin'), 'config/class_planning'), {
    caution: 150, crowded: 100, updatedAt: serverTimestamp(), updatedByUid: actors.admin.uid
  }));
});

rulesTest('join/end transaction barrier에서 종료가 이기면 join 재시도는 fail closed되고 live가 stranded되지 않는다', async () => {
  const now = Date.now();
  await adminWrite('sessions/race-session', {
    teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', setId: 'set1',
    status: 'live', activationLeaseUntil: Timestamp.fromMillis(now + 60_000),
    registeredStudentCount: 0, studentCountRevision: 0
  });
  await adminWrite('sessions/race-session/meta/live', liveQuestion(0));
  let reachedParent;
  let releaseParent;
  const reached = new Promise(resolve => { reachedParent = resolve; });
  const release = new Promise(resolve => { releaseParent = resolve; });
  const joiningStore = emulatorStore(actorFirestore('anonymous'), null, {
    path: 'sessions/race-session',
    async wait() { reachedParent(); await release; }
  });
  const ownerStore = emulatorStore(actorFirestore('owner'));

  const joining = joiningStore.joinStudent('race-session', 'new-student-uid', {
    name: '신규', grade: 1, klass: 1, num: 7
  });
  await reached;
  await ownerStore.endSession('race-session');
  releaseParent();
  await assert.rejects(joining);

  const ended = (await getDoc(doc(actorFirestore('owner'), 'sessions/race-session'))).data();
  assert.equal(ended.status, 'ended');
  assert.equal(ended.actualParticipants, 0);
  assert.equal(ended.registeredStudentCount, 0);
  assert.equal((await getDoc(doc(actorFirestore('owner'),
    'sessions/race-session/students/new-student-uid'))).exists(), false);
  assert.equal((await getDoc(doc(actorFirestore('owner'),
    'sessions/race-session/meta/live'))).data().status, 'ended');
});

rulesTest('fix-round-4: ended live projection은 같은 atomic parent 종료에서만 쓸 수 있다', async t => {
  const safeEndedLive = {
    q: -1,
    openedAt: 0,
    revealed: false,
    limitSec: 0,
    status: 'ended'
  };

  await t.test('parent-only forged ended와 actualParticipants는 모두 거부된다', async () => {
    await resetFirestore();
    const owner = actorFirestore('owner');
    const sessionReference = doc(owner, 'sessions/s1');
    const liveReference = doc(owner, 'sessions/s1/meta/live');

    await assertFails(updateDoc(sessionReference, {
      status: 'ended',
      endedAt: serverTimestamp(),
      actualParticipants: 999
    }));
    assert.equal((await getDoc(liveReference)).data().q, 0);
    await assertFails(setDoc(liveReference, safeEndedLive));
    await assertFails(setDoc(doc(owner, 'sessions/forged-ended-create'), {
      teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'ended',
      endedAt: serverTimestamp(), actualParticipants: 999,
      registeredStudentCount: 0, studentCountRevision: 0
    }));
  });

  await t.test('live-only forged ended는 grace가 끝난 뒤에도 거부된다', async () => {
    await resetFirestore();
    const owner = actorFirestore('owner');
    const now = Date.now();
    await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
      accepting: true,
      responseClosesAt: Timestamp.fromMillis(now - 2_000),
      submitGraceUntil: Timestamp.fromMillis(now - 1_000),
      revealAt: Timestamp.fromMillis(now - 1_000)
    }));

    await assertFails(setDoc(doc(owner, 'sessions/s1/meta/live'), safeEndedLive));
  });

  await t.test('다른 교사는 atomic endSession을 사용할 수 없다', async () => {
    await resetFirestore();
    await assertFails(emulatorStore(actorFirestore('otherTeacher')).endSession('s1'));
  });

  const unsafeAtomicLives = [
    ['다른 문항', liveQuestion(1, {
      openedAt: serverTimestamp(),
      accepting: true,
      liveToken: 'forged-ended-q1',
      status: 'ended'
    })],
    ['정답 공개', liveQuestion(0, {
      revealed: true,
      accepting: true,
      publicAnswer: { answer: 1 },
      status: 'ended'
    })],
    ['status 없는 일반 close', {
      q: -1,
      openedAt: 0,
      revealed: false,
      limitSec: 0
    }]
  ];
  for (const [name, unsafeLive] of unsafeAtomicLives) {
    await t.test(`atomic 종료 예외로 ${name} 전환은 허용하지 않는다`, async () => {
      await resetFirestore();
      const owner = actorFirestore('owner');
      const now = Date.now();
      await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
        accepting: true,
        responseClosesAt: Timestamp.fromMillis(now + 10_000),
        submitGraceUntil: Timestamp.fromMillis(now + 60_000),
        revealAt: Timestamp.fromMillis(now + 60_000)
      }));
      const batch = writeBatch(owner);
      batch.set(doc(owner, 'sessions/s1'), {
        status: 'ended',
        endedAt: serverTimestamp()
      }, { merge: true });
      batch.set(doc(owner, 'sessions/s1/meta/live'), unsafeLive);

      await assertFails(batch.commit());
    });
  }
});

rulesTest('expired lease에서도 등록 학생 read/reconnect는 유지되고 join과 모든 학생 write는 닫힌다', async () => {
  const student = actorFirestore('student');
  const unregistered = actorFirestore('anonymous');
  const owner = actorFirestore('owner');
  await adminWrite('sessions/s1/student_scores/student-uid', {
    uid: 'student-uid', visible: true, score: 1
  });
  const currentSession = (await getDoc(doc(owner, 'sessions/s1'))).data();
  await adminWrite('sessions/s1', {
    ...currentSession,
    activationLeaseUntil: Timestamp.fromMillis(Date.now() - 20_000)
  });

  await assertSucceeds(getDoc(doc(student, 'sessions/s1')));
  await assertSucceeds(getDoc(doc(student, 'sessions/s1/meta/live')));
  await assertSucceeds(getDoc(doc(student, 'sessions/s1/students/student-uid')));
  await assertSucceeds(getDoc(doc(student, 'sessions/s1/responses/student-uid')));
  await assertSucceeds(getDoc(doc(student, 'sessions/s1/student_scores/student-uid')));

  await assertFails(getDoc(doc(unregistered, 'sessions/s1')));
  await assertFails(getDoc(doc(unregistered, 'sessions/s1/meta/live')));
  await assertFails(setDoc(doc(unregistered, 'sessions/s1/students/new-student-uid'), {
    uid: 'new-student-uid', name: '신규 학생'
  }));
  await assertFails(updateDoc(doc(student, 'sessions/s1/students/student-uid'), { number: 9 }));
  await assertFails(updateDoc(doc(student, 'sessions/s1/responses/student-uid'), {
    'answers.0': { answer: 2, submitted: true, revision: 2 }
  }));

  let initialResolve;
  let resumedResolve;
  let initialReject;
  let resumedReject;
  const initial = new Promise((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
  });
  const resumed = new Promise((resolve, reject) => {
    resumedResolve = resolve;
    resumedReject = reject;
  });
  const liveReference = doc(student, 'sessions/s1/meta/live');
  const unsubscribe = onSnapshot(liveReference, snapshot => {
    const value = snapshot.data() || {};
    initialResolve(value);
    if (value.publicQuestion && value.publicQuestion.text === '재연결 성공') {
      resumedResolve(value);
    }
  }, error => {
    initialReject(error);
    resumedReject(error);
  });
  await initial;

  await adminWrite('sessions/s1', {
    ...currentSession,
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 15_000)
  });
  await assertSucceeds(updateDoc(doc(owner, 'sessions/s1/meta/live'), {
    'publicQuestion.text': '재연결 성공'
  }));
  assert.equal((await resumed).publicQuestion.text, '재연결 성공');
  unsubscribe();
});

rulesTest('학생은 자기 응답의 허용 필드만 쓴다', async () => {
  const student = anonymousContext('student-uid');
  const own = doc(student, 'sessions/s1/responses/student-uid');

  await adminWrite('sessions/s1/responses/student-uid', undefined);
  await assertSucceeds(setDoc(own, {
    uid: 'student-uid',
    answers: { 0: { answer: 1, submitted: true, revision: 1 } }
  }));
  await assertFails(setDoc(own, {
    answers: { 0: { answer: 1, submitted: true, revision: 2, ok: true } }
  }));
  await assertFails(getDoc(doc(student, 'sessions/s1/responses/other')));

  const snapshot = await assertSucceeds(getDoc(own));
  assert.equal(snapshot.data().answers['0'].revision, 1);
});

rulesTest('fix-round-1: response uid is required, authenticated, and immutable', async t => {
  await t.test('missing uid is denied', async () => {
    await resetFirestore();
    await adminWrite('sessions/s1/responses/student-uid', undefined);
    const own = doc(actorFirestore('student'), 'sessions/s1/responses/student-uid');
    await assertFails(setDoc(own, {
      answers: { 0: { answer: 1, submitted: true, revision: 1 } }
    }));
  });

  await t.test('spoofed uid is denied', async () => {
    await resetFirestore();
    await adminWrite('sessions/s1/responses/student-uid', undefined);
    const own = doc(actorFirestore('student'), 'sessions/s1/responses/student-uid');
    await assertFails(setDoc(own, {
      uid: 'other-student-uid',
      answers: { 0: { answer: 1, submitted: true, revision: 1 } }
    }));
  });

  await t.test('returning uid can revise but cannot change uid', async () => {
    await resetFirestore();
    await adminWrite('sessions/s1/responses/student-uid', {
      uid: 'student-uid',
      answers: { 0: { answer: 1, submitted: true, revision: 1 } }
    });
    const own = doc(actorFirestore('student'), 'sessions/s1/responses/student-uid');
    await assertSucceeds(updateDoc(own, {
      'answers.0': { answer: 1, submitted: false, revision: 2 }
    }));
    await assertFails(updateDoc(own, {
      uid: 'other-student-uid',
      'answers.0': { answer: 1, submitted: true, revision: 3 }
    }));
    const snapshot = await assertSucceeds(getDoc(own));
    assert.equal(snapshot.data().uid, 'student-uid');
    assert.equal(snapshot.data().answers['0'].revision, 2);
  });
});

rulesTest('fix-round-2: teachers and admins cannot mutate student response roots', async t => {
  const responsePath = 'sessions/s1/responses/student-uid';
  const cases = [
    ['owner omits uid', 'owner', { answers: { 0: { answer: 1, submitted: true, revision: 2 } } }],
    ['admin changes uid', 'admin', {
      uid: 'admin-uid', answers: { 0: { answer: 1, submitted: true, revision: 2 } }
    }],
    ['owner adds a root field', 'owner', {
      uid: 'student-uid', answers: { 0: { answer: 1, submitted: true, revision: 2 } }, score: 99
    }],
    ['admin writes malformed answers', 'admin', { uid: 'student-uid', answers: 'broken' }]
  ];

  for (const [name, actorName, value] of cases) {
    await t.test(name, async () => {
      await resetFirestore();
      await assertFails(setDoc(doc(actorFirestore(actorName), responsePath), value));
    });
  }
});

rulesTest('fix-round-2: private revision grades are writable by owner/admin and unreadable to students', async () => {
  const gradePath = 'sessions/s1/grades/student-uid__0';
  const grade = { uid: 'student-uid', questionIndex: 0, revision: 1, ok: true };
  const owner = actorFirestore('owner');
  const admin = actorFirestore('admin');
  const student = actorFirestore('student');

  await assertSucceeds(setDoc(doc(owner, gradePath), grade));
  await assertSucceeds(updateDoc(doc(admin, gradePath), { ok: false }));
  await assertFails(setDoc(doc(actorFirestore('otherTeacher'), gradePath), grade));
  await assertFails(getDoc(doc(student, gradePath)));
  await assertFails(getDocs(collection(student, 'sessions/s1/grades')));
  const ownResponse = await assertSucceeds(getDoc(
    doc(student, 'sessions/s1/responses/student-uid')
  ));
  assert.equal('ok' in ownResponse.data().answers['0'], false);
  await assertSucceeds(getDoc(doc(owner, gradePath)));
  await assertSucceeds(getDocs(collection(admin, 'sessions/s1/grades')));
});

rulesTest('fix-round-1: graded answer can be replaced on reopen, revised, and resubmitted', async () => {
  const student = actorFirestore('student');
  const owner = actorFirestore('owner');
  const own = doc(student, 'sessions/s1/responses/student-uid');
  await adminWrite('sessions/s1/responses/student-uid', undefined);

  await assertSucceeds(setDoc(own, {
    uid: 'student-uid',
    answers: { 0: { answer: 1, submitted: true, revision: 1 } }
  }));
  await assertSucceeds(setDoc(
    doc(owner, 'sessions/s1/grades/student-uid__0'),
    { uid: 'student-uid', questionIndex: 0, revision: 1, ok: true }
  ));
  await assertSucceeds(updateDoc(own, {
    'answers.0': { answer: 1, submitted: false, revision: 2 }
  }));
  await assertSucceeds(updateDoc(own, {
    'answers.0': { answer: 0, submitted: true, revision: 3 }
  }));

  const snapshot = await assertSucceeds(getDoc(own));
  assert.deepEqual(snapshot.data(), {
    uid: 'student-uid',
    answers: { 0: { answer: 0, submitted: true, revision: 3 } }
  });
  const staleGrade = await assertSucceeds(getDoc(
    doc(owner, 'sessions/s1/grades/student-uid__0')
  ));
  assert.equal(staleGrade.data().revision, 1);
});

rulesTest('fix-round-1: aggregate scores are teacher-only and each student reads only own score', async () => {
  await adminWrite('sessions/s1/student_scores/student-uid', {
    uid: 'student-uid', visible: true, score: 2, rank: 1, total: 2
  });
  await adminWrite('sessions/s1/student_scores/other-student-uid', {
    uid: 'other-student-uid', visible: true, score: 1, rank: 2, total: 2
  });
  const student = actorFirestore('student');
  const owner = actorFirestore('owner');
  const otherTeacher = actorFirestore('otherTeacher');
  const admin = actorFirestore('admin');

  await assertFails(getDoc(doc(student, 'sessions/s1/meta/board')));
  const own = await assertSucceeds(getDoc(
    doc(student, 'sessions/s1/student_scores/student-uid')
  ));
  assert.equal(own.data().score, 2);
  await assertFails(getDoc(
    doc(student, 'sessions/s1/student_scores/other-student-uid')
  ));
  await assertFails(getDocs(collection(student, 'sessions/s1/student_scores')));

  await assertSucceeds(getDoc(doc(owner, 'sessions/s1/meta/board')));
  await assertSucceeds(getDocs(collection(owner, 'sessions/s1/student_scores')));
  await assertFails(getDocs(collection(otherTeacher, 'sessions/s1/student_scores')));
  await assertSucceeds(getDocs(collection(admin, 'sessions/s1/student_scores')));

  await assertSucceeds(setDoc(
    doc(owner, 'sessions/s1/student_scores/student-uid'),
    { uid: 'student-uid', visible: false }
  ));
  await assertSucceeds(setDoc(
    doc(owner, 'sessions/s1/student_scores/student-uid'),
    {
      uid: 'student-uid', visible: true, score: 2, graded: 3,
      answered: 4, rank: 1, total: 2
    }
  ));
  await assertFails(setDoc(
    doc(owner, 'sessions/s1/student_scores/student-uid'),
    { uid: 'student-uid', visible: true, score: 2, rank: 1, total: 2 }
  ));
  await assertFails(setDoc(
    doc(student, 'sessions/s1/student_scores/student-uid'),
    { uid: 'student-uid', visible: true, score: 99, rank: 1, total: 2 }
  ));
});

rulesTest('fix-round-1: deadline response and delayed reveal complete without exposing answers during grace', async () => {
  const now = Date.now();
  const closesAt = Timestamp.fromMillis(now + 100);
  const graceUntil = Timestamp.fromMillis(now + 400);
  const revealAt = Timestamp.fromMillis(now + 400);
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    limitSec: 0.1,
    responseClosesAt: closesAt,
    submitGraceUntil: graceUntil,
    revealAt
  }));
  await adminWrite('sessions/s1/responses/student-uid', undefined);
  const student = actorFirestore('student');
  const owner = actorFirestore('owner');

  const deadlineSubmit = assertSucceeds(setDoc(
    doc(student, 'sessions/s1/responses/student-uid'),
    {
      uid: 'student-uid',
      answers: { 0: { answer: 1, submitted: true, revision: 1 } }
    }
  ));
  const delayedReveal = new Promise(resolve => setTimeout(resolve, 500)).then(() =>
    assertSucceeds(updateDoc(doc(owner, 'sessions/s1/meta/live'), {
      revealed: true,
      publicAnswer: { answer: 1 }
    }))
  );

  await Promise.all([deadlineSubmit, delayedReveal]);
  const live = await assertSucceeds(getDoc(doc(student, 'sessions/s1/meta/live')));
  assert.equal(live.data().revealed, true);
  assert.deepEqual(live.data().publicAnswer, { answer: 1 });
});

rulesTest('fix-round-1: timer reveal is denied before revealAt and response is denied after grace', async () => {
  const now = Date.now();
  const owner = actorFirestore('owner');
  const student = actorFirestore('student');
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    responseClosesAt: Timestamp.fromMillis(now + 500),
    submitGraceUntil: Timestamp.fromMillis(now + 1_000),
    revealAt: Timestamp.fromMillis(now + 1_000)
  }));
  await assertFails(updateDoc(doc(owner, 'sessions/s1/meta/live'), {
    revealed: true,
    publicAnswer: { answer: 1 }
  }));
  await assertSucceeds(updateDoc(doc(owner, 'sessions/s1/meta/live'), {
    accepting: false,
    revealed: true,
    publicAnswer: { answer: 1 }
  }));

  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    responseClosesAt: Timestamp.fromMillis(now - 2_000),
    submitGraceUntil: Timestamp.fromMillis(now - 1_000),
    revealAt: Timestamp.fromMillis(now - 1_000)
  }));
  await assertFails(updateDoc(
    doc(student, 'sessions/s1/responses/student-uid'),
    { 'answers.0': { answer: 0, submitted: true, revision: 2 } }
  ));
});

rulesTest('fix-round-2: freeze denies the racing revision and the accepted revision is graded', async () => {
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, { accepting: true }));
  const student = actorFirestore('student');
  const owner = actorFirestore('owner');
  const response = doc(student, 'sessions/s1/responses/student-uid');
  const live = doc(owner, 'sessions/s1/meta/live');

  await assertSucceeds(updateDoc(response, {
    'answers.0': { answer: 0, submitted: true, revision: 2 }
  }));
  let releaseCompetingCommit;
  let markCompetingRead;
  const competingCanCommit = new Promise(resolve => { releaseCompetingCommit = resolve; });
  const competingRead = new Promise(resolve => { markCompetingRead = resolve; });
  let firstAttempt = true;
  const competingRevision = runTransaction(student, async transaction => {
    await transaction.get(response);
    if (firstAttempt) {
      firstAttempt = false;
      markCompetingRead();
      await competingCanCommit;
    }
    transaction.update(response, {
      'answers.0': { answer: 1, submitted: true, revision: 3 }
    });
  });

  await competingRead;
  await assertSucceeds(updateDoc(live, { accepting: false }));
  releaseCompetingCommit();
  await assertFails(competingRevision);

  const accepted = await assertSucceeds(getDoc(
    doc(owner, 'sessions/s1/responses/student-uid')
  ));
  assert.equal(accepted.data().answers['0'].revision, 2);
  await assertSucceeds(setDoc(doc(owner, 'sessions/s1/grades/student-uid__0'), {
    uid: 'student-uid', questionIndex: 0, revision: 2, ok: true
  }));
  await assertSucceeds(setDoc(doc(owner, 'sessions/s1/meta/board'), {
    scores: { 'student-uid': 1 }
  }));
  const board = await assertSucceeds(getDoc(doc(owner, 'sessions/s1/meta/board')));
  assert.equal(board.data().scores['student-uid'], 1);
});

rulesTest('fix-round-2: timer live cannot freeze before submit grace ends', async () => {
  const now = Date.now();
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    accepting: true,
    responseClosesAt: Timestamp.fromMillis(now + 50),
    submitGraceUntil: Timestamp.fromMillis(now + 300),
    revealAt: Timestamp.fromMillis(now + 300)
  }));
  const live = doc(actorFirestore('owner'), 'sessions/s1/meta/live');

  await assertFails(updateDoc(live, { accepting: false }));
  await new Promise(resolve => setTimeout(resolve, 400));
  await assertSucceeds(updateDoc(live, { accepting: false }));
});

rulesTest('fix-round-3: accepting timer live cannot change question before grace', async t => {
  const transitions = [
    ['another question', { q: 1 }],
    ['closed question', { q: -1, openedAt: 0, revealed: false, limitSec: 0 }]
  ];
  for (const [name, change] of transitions) {
    await t.test(name, async () => {
      await resetFirestore();
      const now = Date.now();
      await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
        accepting: true,
        responseClosesAt: Timestamp.fromMillis(now + 100),
        submitGraceUntil: Timestamp.fromMillis(now + 700),
        revealAt: Timestamp.fromMillis(now + 700)
      }));

      const live = doc(actorFirestore('owner'), 'sessions/s1/meta/live');
      const changing = change.q < 0 ? setDoc(live, change) : setDoc(live, liveQuestion(1, {
        liveToken: 'pre-grace-q1',
        openedAt: serverTimestamp(),
        accepting: true
      }));
      await assertFails(changing);
    });
  }
});

rulesTest('fix-round-3: timer live changes question after grace or an accepted freeze', async () => {
  const now = Date.now();
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    accepting: true,
    responseClosesAt: Timestamp.fromMillis(now + 50),
    submitGraceUntil: Timestamp.fromMillis(now + 300),
    revealAt: Timestamp.fromMillis(now + 300)
  }));
  const live = doc(actorFirestore('owner'), 'sessions/s1/meta/live');

  await new Promise(resolve => setTimeout(resolve, 400));
  await assertSucceeds(setDoc(live, liveQuestion(1, {
    liveToken: 'post-grace-q1',
    openedAt: serverTimestamp(),
    accepting: true
  })));

  await adminWrite('sessions/s1/meta/live', liveQuestion(0, { accepting: true }));
  await assertSucceeds(updateDoc(live, { accepting: false }));
  await assertSucceeds(setDoc(live, liveQuestion(1, {
    liveToken: 'post-freeze-q1',
    openedAt: serverTimestamp(),
    accepting: true
  })));
});

rulesTest('fix-round-4: live token is accepted on open and cannot change inside one instance', async () => {
  const owner = actorFirestore('owner');
  const live = doc(owner, 'sessions/s1/meta/live');

  await assertSucceeds(setDoc(live, liveQuestion(1, {
    liveToken: 'live-q1-instance',
    openedAt: serverTimestamp(),
    accepting: true
  })));
  await assertFails(updateDoc(live, { liveToken: 'rewritten-token' }));
  await assertSucceeds(updateDoc(live, { accepting: false }));
});

rulesTest('fix-round-4: stale freeze and final close transactions preserve a newer live instance', async t => {
  for (const method of ['freezeLive', 'closeLive']) {
    await t.test(method, async () => {
      await resetFirestore();
      const q0 = liveQuestion(0, {
        liveToken: 'live-q0-instance',
        openedAt: Timestamp.fromMillis(10_000),
        accepting: true
      });
      await adminWrite('sessions/s1/meta/live', q0);

      let markCaptured;
      let releaseCaptured;
      const captured = new Promise(resolve => { markCaptured = resolve; });
      const release = new Promise(resolve => { releaseCaptured = resolve; });
      const store = emulatorStore(actorFirestore('owner'), async () => {
        markCaptured();
        await release;
      });
      assert.equal(typeof store[method], 'function');
      const staleWrite = store[method]('s1', {
        q: 0, liveToken: 'live-q0-instance', openedAt: 10_000
      });

      await captured;
      await adminWrite('sessions/s1/meta/live', liveQuestion(1, {
        liveToken: 'live-q1-instance',
        openedAt: Timestamp.fromMillis(20_000),
        accepting: true
      }));
      releaseCaptured();

      assert.equal(await staleWrite, false);
      const latest = await assertSucceeds(getDoc(doc(
        actorFirestore('owner'), 'sessions/s1/meta/live'
      )));
      assert.equal(latest.data().q, 1);
      assert.equal(latest.data().liveToken, 'live-q1-instance');
      assert.equal(latest.data().accepting, true);
      assert.equal(latest.data().revealed, false);
    });
  }

  await t.test('normal close', async () => {
    await resetFirestore();
    await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
      liveToken: 'live-q0-normal',
      openedAt: Timestamp.fromMillis(30_000),
      accepting: true
    }));
    const store = emulatorStore(actorFirestore('owner'));
    const identity = {
      q: 0, liveToken: 'live-q0-normal', openedAt: 30_000
    };

    assert.equal(await store.freezeLive('s1', identity), true);
    assert.equal(await store.closeLive('s1', identity), true);
    const closed = await assertSucceeds(getDoc(doc(
      actorFirestore('owner'), 'sessions/s1/meta/live'
    )));
    assert.deepEqual(closed.data(), {
      q: -1, openedAt: 0, revealed: false, limitSec: 0
    });
  });
});

rulesTest('current-live-question response validation', async () => {
  const student = anonymousContext('student-uid');
  const own = doc(student, 'sessions/s1/responses/student-uid');

  await adminWrite('sessions/s1/meta/live', {
    q: 1,
    openedAt: Timestamp.fromMillis(1),
    limitSec: 30,
    revealed: false,
    publicQuestion: {
      number: 2,
      total: 2,
      type: 'mc',
      text: '두 번째 문항',
      choices: ['A', 'B']
    }
  });

  await assertSucceeds(updateDoc(own, {
    answers: {
      0: { answer: 1, submitted: true, revision: 1 },
      1: { answer: 1, submitted: true, revision: 1 }
    }
  }));
  await assertFails(updateDoc(own, {
    answers: {
      0: { answer: 1, submitted: true, revision: 1 },
      1: { answer: 1, submitted: true, revision: 1 },
      2: { answer: 3, submitted: true, revision: 1 }
    }
  }));
});

rulesTest('response answer shape is bounded by the current public question type', async t => {
  const cases = [
    ['choice rejects out of range', { type: 'choice', choices: ['A', 'B'] }, 2],
    ['choice rejects fractional', { type: 'choice', choices: ['A', 'B'] }, 0.5],
    ['multi rejects duplicates', { type: 'multi', choices: ['A', 'B', 'C'] }, [0, 0]],
    ['multi rejects out of range', { type: 'multi', choices: ['A', 'B'] }, [0, 2]],
    ['short rejects oversized', { type: 'short', choices: [] }, 'x'.repeat(101)],
    ['long rejects oversized', { type: 'long', choices: [] }, 'x'.repeat(1001)],
    ['short rejects number', { type: 'short', choices: [] }, 1]
  ];
  for (const [name, question, answer] of cases) {
    await t.test(name, async () => {
      await resetFirestore();
      await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
        publicQuestion: { number: 1, total: 1, text: 'Q', ...question }
      }));
      await assertFails(updateDoc(doc(actorFirestore('student'), 'sessions/s1/responses/student-uid'), {
        answers: { 0: { answer, submitted: true, revision: 2 } }
      }));
    });
  }
  await t.test('normal boundaries succeed', async () => {
    await resetFirestore();
    const response = doc(actorFirestore('student'), 'sessions/s1/responses/student-uid');
    await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
      publicQuestion: { number: 1, total: 1, type: 'multi', text: 'Q', choices: ['A', 'B', 'C'] }
    }));
    await assertSucceeds(updateDoc(response, {
      answers: { 0: { answer: [0, 2], submitted: true, revision: 2 } }
    }));
  });
});

rulesTest('public projection enforces editor-compatible text and image bounds', async () => {
  const live = doc(actorFirestore('owner'), 'sessions/s1/meta/live');
  await assertFails(setDoc(live, liveQuestion(0, {
    publicQuestion: { ...publicQuestion(), text: 'x'.repeat(1001) }
  })));
  await assertFails(setDoc(live, liveQuestion(0, {
    publicQuestion: { ...publicQuestion(), choices: ['x'.repeat(201)] }
  })));
  await assertFails(setDoc(live, liveQuestion(0, {
    publicQuestion: { ...publicQuestion(), image: 'javascript:alert(1)' }
  })));
  await assertSucceeds(setDoc(live, liveQuestion(0, {
    publicQuestion: { ...publicQuestion(), text: 'x'.repeat(1000), choices: ['x'.repeat(200)], image: 'data:image/png;base64,AA==' }
  })));
});

rulesTest('fix-round: teacher code allocation reads unused and foreign collision candidates', async () => {
  const owner = actorFirestore('owner');
  const created = await assertSucceeds(runTransaction(owner, async transaction => {
    const codeReference = doc(owner, 'codes/UNUSED');
    const candidate = await transaction.get(codeReference);
    if (candidate.exists()) return false;

    transaction.set(codeReference, { sessionId: 'created-session' });
    transaction.set(doc(owner, 'sessions/created-session'), {
      teacherUid: 'owner-uid',
      teacherEmail: 'owner@school.kr',
      status: 'live',
      registeredStudentCount: 0,
      studentCountRevision: 0,
      activationLeaseUntil: Timestamp.fromMillis(Date.now() + 10_000)
    });
    transaction.set(doc(owner, 'sessions/created-session/meta/live'), {
      q: -1,
      openedAt: 0,
      limitSec: 0,
      revealed: false
    });
    transaction.set(doc(owner, 'sessions/created-session/meta/board'), { scores: {} });
    return true;
  }));
  assert.equal(created, true);

  const collided = await assertSucceeds(runTransaction(owner, async transaction => {
    const candidate = await transaction.get(doc(owner, 'codes/OTHER1'));
    return candidate.exists();
  }));
  assert.equal(collided, true);
});

rulesTest('fix-round: live session supports read-before-create student join flow', async () => {
  const student = anonymousContext('joining-student-uid');

  const code = await assertSucceeds(getDoc(doc(student, 'codes/ABC123')));
  assert.equal(code.data().sessionId, 's1');
  const session = await assertSucceeds(getDoc(doc(student, 'sessions/s1')));
  assert.equal(session.data().status, 'live');
  const studentReference = doc(student, 'sessions/s1/students/joining-student-uid');
  const missingStudent = await assertSucceeds(getDoc(studentReference));
  assert.equal(missingStudent.exists(), false);
  await emulatorStore(student).joinStudent('s1', 'joining-student-uid', {
    grade: 1, klass: 2, num: 5, name: '신규 학생'
  });
  const missingResponse = await assertSucceeds(getDoc(
    doc(student, 'sessions/s1/responses/joining-student-uid')
  ));
  assert.equal(missingResponse.exists(), false);
});

rulesTest('fix-round: code update cannot move ownership across sessions', async () => {
  const owner = actorFirestore('owner');
  await assertFails(updateDoc(doc(owner, 'codes/OTHER1'), { sessionId: 's1' }));
  await assertFails(updateDoc(doc(owner, 'codes/ABC123'), { sessionId: 's2' }));
});

rulesTest('fix-round: live projection rejects private or malformed fields', async t => {
  const cases = [
    ['pre-reveal publicAnswer', {
      ...liveQuestion(),
      publicAnswer: { answer: 1 }
    }],
    ['nested answer', {
      ...liveQuestion(),
      publicQuestion: { ...publicQuestion(), answer: 1 }
    }],
    ['top-level private answers', {
      ...liveQuestion(),
      answers: [1]
    }],
    ['nested private material', {
      ...liveQuestion(),
      publicQuestion: { ...publicQuestion(), privateMaterial: { score: 10 } }
    }],
    ['malformed choices', {
      ...liveQuestion(),
      publicQuestion: { ...publicQuestion(), choices: 'A,B' }
    }],
    ['nested private choice', {
      ...liveQuestion(),
      publicQuestion: { ...publicQuestion(), choices: [{ answer: 1 }] }
    }]
  ];

  for (const [name, value] of cases) {
    await t.test(name, async () => {
      await resetFirestore();
      await assertFails(setDoc(
        doc(actorFirestore('owner'), 'sessions/s1/meta/live'),
        value
      ));
    });
  }

  await t.test('valid pre-reveal and reveal projections', async () => {
    await resetFirestore();
    const live = doc(actorFirestore('owner'), 'sessions/s1/meta/live');
    await assertSucceeds(setDoc(live, liveQuestion()));
    await assertSucceeds(setDoc(live, liveQuestion(0, {
      revealed: true,
      publicAnswer: { answer: 1, explain: '해설', explainImage: 'https://example.com/explain.png' }
    })));
    await assertFails(setDoc(live, liveQuestion(0, {
      revealed: true,
      publicAnswer: { answer: 1, explain: '해설', explainImage: 'javascript:alert(1)' }
    })));
  });
});

async function seedOrphanSession() {
  await testEnvironment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'sessions/orphan/meta/live'), liveQuestion()),
      setDoc(doc(db, 'sessions/orphan/meta/board'), { scores: {} }),
      setDoc(doc(db, 'sessions/orphan/students/student-uid'), {
        uid: 'student-uid',
        grade: 1,
        class: 2,
        number: 3,
        name: '고아 학생'
      }),
      setDoc(doc(db, 'sessions/orphan/responses/student-uid'), {
        uid: 'student-uid',
        answers: { 0: { answer: 1, submitted: true, revision: 1 } }
      })
    ]);
  });
}

rulesTest('fix-round: orphan child documents grant no student access', async t => {
  const cases = [
    ['live get', db => getDoc(doc(db, 'sessions/orphan/meta/live'))],
    ['board get', db => getDoc(doc(db, 'sessions/orphan/meta/board'))],
    ['student get', db => getDoc(doc(db, 'sessions/orphan/students/student-uid'))],
    ['student update', db => updateDoc(
      doc(db, 'sessions/orphan/students/student-uid'),
      { name: '변조 학생' }
    )],
    ['response get', db => getDoc(doc(db, 'sessions/orphan/responses/student-uid'))],
    ['response update', db => updateDoc(
      doc(db, 'sessions/orphan/responses/student-uid'),
      { answers: { 0: { answer: 2, submitted: true, revision: 2 } } }
    )]
  ];

  for (const [name, request] of cases) {
    await t.test(name, async () => {
      await resetFirestore();
      await seedOrphanSession();
      await assertFails(request(actorFirestore('student')));
    });
  }
});

rulesTest('fix-round: response validation rejects stale, closed, and malformed writes', async t => {
  const invalidCases = [
    ['equal revision', async () => {}, {
      answers: { 0: { answer: 2, submitted: true, revision: 1 } }
    }],
    ['decreasing revision', async () => {}, {
      answers: { 0: { answer: 2, submitted: true, revision: 0 } }
    }],
    ['nested ok and score', async () => {}, {
      answers: { 0: { answer: { ok: true, score: 10 }, submitted: true, revision: 2 } }
    }],
    ['nested list answer', async () => {}, {
      answers: { 0: { answer: [{ ok: true }], submitted: true, revision: 2 } }
    }],
    ['invalid submittedAt', async () => {}, {
      answers: { 0: { answer: 2, submitted: true, revision: 2, submittedAt: 'now' } }
    }],
    ['missing live', () => adminWrite('sessions/s1/meta/live', undefined), {
      answers: { 0: { answer: 2, submitted: true, revision: 2 } }
    }],
    ['missing publicQuestion', () => adminWrite('sessions/s1/meta/live', {
      q: 0, openedAt: Timestamp.fromMillis(1), limitSec: 30, revealed: false
    }), {
      answers: { 0: { answer: 2, submitted: true, revision: 2 } }
    }],
    ['closed live', () => adminWrite('sessions/s1/meta/live', liveQuestion(0, {
      revealed: true,
      publicAnswer: { answer: 1 }
    })), {
      answers: { 0: { answer: 2, submitted: true, revision: 2 } }
    }],
    ['ended parent', () => adminWrite('sessions/s1', {
      teacherUid: 'owner-uid', teacherEmail: 'owner@school.kr', status: 'ended'
    }), {
      answers: { 0: { answer: 2, submitted: true, revision: 2 } }
    }]
  ];

  for (const [name, arrange, value] of invalidCases) {
    await t.test(name, async () => {
      await resetFirestore();
      await arrange();
      await assertFails(updateDoc(
        doc(actorFirestore('student'), 'sessions/s1/responses/student-uid'),
        value
      ));
    });
  }

  await t.test('waiting q -1', async () => {
    await resetFirestore();
    await adminWrite('sessions/s1/meta/live', {
      q: -1, openedAt: 0, limitSec: 0, revealed: false
    });
    await adminWrite('sessions/s1/responses/student-uid', undefined);
    await assertFails(setDoc(
      doc(actorFirestore('student'), 'sessions/s1/responses/student-uid'),
      { uid: 'student-uid', answers: { '-1': { answer: 1, submitted: true, revision: 1 } } }
    ));
  });

  await t.test('supported scalar and list answers with timestamp', async () => {
    await resetFirestore();
    const response = doc(actorFirestore('student'), 'sessions/s1/responses/student-uid');
    await assertSucceeds(updateDoc(response, {
      answers: {
        0: {
          answer: 1,
          submitted: true,
          revision: 2,
          submittedAt: Timestamp.fromMillis(2)
        }
      }
    }));
    await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
      publicQuestion: { number: 1, total: 1, type: 'multi', text: 'Q', choices: ['A', 'B', 'C'] }
    }));
    await assertSucceeds(updateDoc(response, {
      answers: {
        0: {
          answer: [1, 2],
          submitted: true,
          revision: 3,
          submittedAt: Timestamp.fromMillis(3)
        }
      }
    }));
  });
});

rulesTest('fix-round: adversarial queries and ownership spoofing stay denied', async () => {
  const owner = actorFirestore('owner');
  const student = actorFirestore('student');

  await assertFails(getDocs(collection(owner, 'codes')));
  await assertFails(getDocs(query(collection(owner, 'codes'), where('sessionId', '==', 's2'))));
  await assertFails(getDocs(query(
    collection(owner, 'sessions'),
    where('teacherUid', '==', 'other-teacher-uid')
  )));
  await assertFails(setDoc(doc(owner, 'quiz_sets/spoofed'), {
    ownerUid: 'other-teacher-uid',
    ownerEmail: 'other@school.kr',
    title: '위조 세트'
  }));
  await assertFails(updateDoc(doc(owner, 'quiz_sets/set1'), {
    ownerUid: 'other-teacher-uid'
  }));
  await assertFails(setDoc(doc(owner, 'sessions/spoofed'), {
    teacherUid: 'other-teacher-uid',
    teacherEmail: 'other@school.kr',
    status: 'live'
  }));
  await assertFails(updateDoc(doc(owner, 'sessions/s1'), {
    teacherUid: 'other-teacher-uid'
  }));
  await assertFails(getDoc(doc(student, 'sessions/s1/students/missing-student-uid')));
});

rulesTest('fix-round-2: publicAnswer accept is bounded and string-only', async t => {
  const cases = [
    ['nested map', [{ answer: 'private' }]],
    ['nested map with list', [{ variants: ['private'] }]],
    ['too many entries', Array.from({ length: 21 }, (_, index) => `answer-${index}`)],
    ['oversized element', ['x'.repeat(101)]]
  ];

  for (const [name, accept] of cases) {
    await t.test(name, async () => {
      await resetFirestore();
      await assertFails(setDoc(
        doc(actorFirestore('owner'), 'sessions/s1/meta/live'),
        liveQuestion(0, {
          publicQuestion: { ...publicQuestion(), type: 'short', choices: [] },
          revealed: true,
          publicAnswer: { accept, explain: '공개 해설' }
        })
      ));
    });
  }

  await t.test('valid string accept list', async () => {
    await resetFirestore();
    const accept = Array.from({ length: 20 }, (_, index) => `answer-${index}`);
    accept[19] = 'x'.repeat(100);
    await assertSucceeds(setDoc(
      doc(actorFirestore('owner'), 'sessions/s1/meta/live'),
      liveQuestion(0, {
        publicQuestion: { ...publicQuestion(), type: 'short', choices: [] },
        revealed: true,
        publicAnswer: { accept, explain: '공개 해설' }
      })
    ));
  });
});

rulesTest('fix-round-2: students cannot read stored malformed live projections', async () => {
  await adminWrite('sessions/s1/meta/live', liveQuestion(0, {
    revealed: true,
    publicAnswer: {
      accept: [{ answer: 'private' }],
      explain: '공개 해설'
    }
  }));

  const path = 'sessions/s1/meta/live';
  await assertFails(getDoc(doc(actorFirestore('student'), path)));
  await assertSucceeds(getDoc(doc(actorFirestore('owner'), path)));
  await assertSucceeds(getDoc(doc(actorFirestore('admin'), path)));
});

rulesTest('공개 문항 이미지는 비공개 문서 참조가 아닌 문자열 projection만 허용한다', async () => {
  const owner = actorFirestore('owner');
  const live = doc(owner, 'sessions/s1/meta/live');

  await assertFails(setDoc(live, liveQuestion(0, {
    publicQuestion: {
      ...publicQuestion(),
      image: doc(owner, 'sessions/s1/snapshot_images/v0q0')
    }
  })));
  await assertSucceeds(setDoc(live, liveQuestion(0, {
    publicQuestion: {
      ...publicQuestion(),
      image: 'data:image/jpeg;base64,current-question'
    }
  })));
});

const readMatrix = [
  {
    name: '세트',
    getPath: 'quiz_sets/set1',
    list: (db, actorName) => getDocs(actorName === 'admin'
      ? query(
          collection(db, 'quiz_sets'),
          where('lifecycleState', '==', 'active')
        )
      : query(
          collection(db, 'quiz_sets'),
          where('lifecycleState', '==', 'active'),
          where('ownerUid', '==', actors[actorName].uid)
        )),
    get: ['owner', 'admin'],
    listAllowed: approvedTeachers
  },
  {
    name: '이미지',
    getPath: 'images/set1/q/0',
    list: db => getDocs(collection(db, 'images/set1/q')),
    get: ['owner', 'admin'],
    listAllowed: ['owner', 'admin']
  },
  {
    name: '코드',
    getPath: 'codes/ABC123',
    list: (db, actorName) => actorName === 'admin'
      ? getDocs(collection(db, 'codes'))
      : getDocs(query(
          collection(db, 'codes'),
          where('sessionId', '==', actorName === 'otherTeacher' ? 's2' : 's1')
        )),
    get: ['owner', 'otherTeacher', 'admin', 'student', 'otherStudent', 'anonymous'],
    listAllowed: approvedTeachers
  },
  {
    name: '세션',
    getPath: 'sessions/s1',
    list: (db, actorName) => actorName === 'admin'
      ? getDocs(collection(db, 'sessions'))
      : getDocs(query(collection(db, 'sessions'), where('teacherUid', '==', actors[actorName].uid))),
    get: ['owner', 'admin', 'student', 'otherStudent', 'anonymous'],
    listAllowed: approvedTeachers
  },
  {
    name: 'live',
    getPath: 'sessions/s1/meta/live',
    list: db => getDocs(collection(db, 'sessions/s1/meta')),
    get: ['owner', 'admin', 'student', 'otherStudent'],
    listAllowed: ['owner', 'admin']
  },
  {
    name: 'board',
    getPath: 'sessions/s1/meta/board',
    list: db => getDocs(collection(db, 'sessions/s1/meta')),
    get: ['owner', 'admin'],
    listAllowed: ['owner', 'admin']
  },
  {
    name: '학생',
    getPath: 'sessions/s1/students/student-uid',
    list: db => getDocs(collection(db, 'sessions/s1/students')),
    get: ['owner', 'admin', 'student'],
    listAllowed: ['owner', 'admin']
  },
  {
    name: '응답',
    getPath: 'sessions/s1/responses/student-uid',
    list: db => getDocs(collection(db, 'sessions/s1/responses')),
    get: ['owner', 'admin', 'student'],
    listAllowed: ['owner', 'admin']
  },
  {
    name: '설정',
    getPath: 'config/app',
    list: db => getDocs(collection(db, 'config')),
    get: ['admin'],
    listAllowed: []
  }
];

rulesTest('역할별 get/list 권한 매트릭스를 지킨다', async t => {
  for (const entry of readMatrix) {
    for (const actorName of actorNames) {
      await t.test(`${entry.name} get · ${actorName}`, async () => {
        const db = actorFirestore(actorName);
        await expectPermission(
          entry.get.includes(actorName),
          getDoc(doc(db, entry.getPath)),
          `${entry.name} get ${actorName}`
        );
      });
      await t.test(`${entry.name} list · ${actorName}`, async () => {
        const db = actorFirestore(actorName);
        await expectPermission(
          entry.listAllowed.includes(actorName),
          entry.list(db, actorName),
          `${entry.name} list ${actorName}`
        );
      });
    }
  }
});

const writeMatrix = [
  {
    name: '세트',
    target: () => 'quiz_sets/set1',
    createTarget: actorName => `quiz_sets/create-${actorName}`,
    createValue: actorName => ({
      ownerUid: actors[actorName].uid,
      ownerEmail: actors[actorName].email || '',
      lifecycleState: 'active',
      collaboratorCount: 0,
      imageCount: 0,
      title: '새 세트'
    }),
    updateValue: () => ({ title: '변경' }),
    allowed: {
      create: approvedTeachers,
      update: ['owner'],
      delete: []
    }
  },
  {
    name: '이미지',
    target: () => 'images/set1/q/0',
    createTarget: actorName => `images/set1/q/create-${actorName}`,
    createValue: () => ({ data: 'new-image' }),
    updateValue: () => ({ data: 'changed-image' }),
    allowed: { create: [], update: [], delete: [] }
  },
  {
    name: '코드',
    target: () => 'codes/ABC123',
    createTarget: actorName => `codes/NEW-${actorName}`,
    createValue: () => ({ sessionId: 's1' }),
    updateValue: () => ({ touched: true }),
    allowed: { create: ['owner'], update: ['owner'], delete: ['owner', 'admin'] }
  },
  {
    name: '세션',
    target: () => 'sessions/s1',
    createTarget: actorName => `sessions/create-${actorName}`,
    createValue: actorName => ({
      teacherUid: actors[actorName].uid,
      teacherEmail: actors[actorName].email || '',
      status: 'live',
      registeredStudentCount: 0,
      studentCountRevision: 0,
      activationLeaseUntil: serverTimestamp()
    }),
    updateValue: () => ({ status: 'ended' }),
    allowed: {
      create: approvedTeachers,
      update: [],
      delete: ['admin']
    }
  },
  {
    name: 'live',
    target: () => 'sessions/s1/meta/live',
    createTarget: () => 'sessions/s1/meta/live',
    beforeCreate: () => adminWrite('sessions/s1/meta/live', undefined),
    createValue: () => liveQuestion(1),
    updateValue: () => ({ revealed: true, publicAnswer: { answer: 1 } }),
    allowed: { create: ['owner'], update: ['owner'], delete: ['owner', 'admin'] }
  },
  {
    name: 'board',
    target: () => 'sessions/s1/meta/board',
    createTarget: () => 'sessions/s1/meta/board',
    beforeCreate: () => adminWrite('sessions/s1/meta/board', undefined),
    createValue: () => ({ scores: {} }),
    updateValue: () => ({ scores: { 'student-uid': 1 } }),
    allowed: { create: ['owner'], update: ['owner'], delete: ['owner', 'admin'] }
  },
  {
    name: '학생',
    target: actorName => actorName === 'anonymous'
      ? 'sessions/s1/students/new-student-uid'
      : 'sessions/s1/students/student-uid',
    createTarget: actorName => actorName === 'anonymous'
      ? 'sessions/s1/students/new-student-uid'
      : 'sessions/s1/students/student-uid',
    beforeCreate: actorName => adminWrite(
      actorName === 'anonymous'
        ? 'sessions/s1/students/new-student-uid'
        : 'sessions/s1/students/student-uid',
      undefined
    ),
    createValue: actorName => ({
      uid: actors[actorName].uid,
      grade: 1,
      class: 2,
      number: 9,
      name: '참여 학생'
    }),
    updateValue: () => ({ number: 10 }),
    allowed: { create: [], update: ['student'], delete: [] }
  },
  {
    name: '응답',
    target: () => 'sessions/s1/responses/student-uid',
    createTarget: actorName => actorName === 'anonymous'
      ? 'sessions/s1/responses/new-student-uid'
      : 'sessions/s1/responses/student-uid',
    beforeCreate: actorName => adminWrite(
      actorName === 'anonymous'
        ? 'sessions/s1/responses/new-student-uid'
        : 'sessions/s1/responses/student-uid',
      undefined
    ),
    createValue: actorName => ({
      uid: actors[actorName].uid,
      answers: { 0: { answer: 1, submitted: true, revision: 1 } }
    }),
    updateValue: actorName => actorName === 'student'
      ? { answers: { 0: { answer: 1, submitted: true, revision: 2 } } }
      : { answers: { 0: { answer: 1, submitted: true, revision: 1, ok: true } } },
    allowed: {
      create: ['student'],
      update: ['student'],
      delete: ['owner', 'admin']
    }
  },
  {
    name: '설정',
    target: () => 'config/app',
    createTarget: () => 'config/app',
    beforeCreate: () => adminWrite('config/app', undefined),
    createValue: () => ({ retentionDays: 60 }),
    updateValue: () => ({ retentionDays: 90 }),
    allowed: { create: ['admin'], update: ['admin'], delete: ['admin'] }
  }
];

async function resetFirestore() {
  await testEnvironment.clearFirestore();
  await seedFirestore();
}

rulesTest('역할별 create/update/delete 권한 매트릭스를 지킨다', async t => {
  for (const entry of writeMatrix) {
    for (const operation of ['create', 'update', 'delete']) {
      for (const actorName of actorNames) {
        await t.test(`${entry.name} ${operation} · ${actorName}`, async () => {
          await resetFirestore();
          const db = actorFirestore(actorName);
          let request;
          if (operation === 'create') {
            if (entry.beforeCreate) await entry.beforeCreate(actorName);
            request = setDoc(
              doc(db, entry.createTarget(actorName)),
              entry.createValue(actorName)
            );
          } else if (operation === 'update') {
            request = updateDoc(
              doc(db, entry.target(actorName)),
              entry.updateValue(actorName)
            );
          } else {
            request = deleteDoc(doc(db, entry.target(actorName)));
          }
          await expectPermission(
            entry.allowed[operation].includes(actorName),
            request,
            `${entry.name} ${operation} ${actorName}`
          );
        });
      }
    }
  }
});

rulesTest('승인 목록은 admin만 읽고 쓰며 다른 클라이언트에는 비공개다', async () => {
  for (const actorName of actorNames) {
    await resetFirestore();
    const db = actorFirestore(actorName);
    const allowed = actorName === 'admin';
    await expectPermission(allowed, getDoc(doc(db, 'teacher_allowlist/owner@school.kr')));
    await expectPermission(allowed, getDocs(collection(db, 'teacher_allowlist')));
    const createRequest = setDoc(doc(db, `teacher_allowlist/new-${actorName}@school.kr`), {
      enabled: true, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: actors[actorName].uid
    });
    await expectPermission(allowed, createRequest);
    await expectPermission(allowed, updateDoc(doc(db, 'teacher_allowlist/owner@school.kr'), {
      enabled: false, updatedAt: serverTimestamp(), updatedByUid: actors[actorName].uid
    }));
    await assertFails(deleteDoc(doc(db, 'teacher_allowlist/owner@school.kr')));
  }
});

rulesTest('소유자 휴지통 전환·복원과 만료 purge만 허용하고 direct parent delete는 닫는다', async () => {
  const owner = actorFirestore('owner');
  const admin = actorFirestore('admin');
  await assertFails(deleteDoc(doc(owner, 'quiz_sets/set1')));
  await assertSucceeds(updateDoc(doc(owner, 'quiz_sets/set1'), {
    trashedAt: serverTimestamp(), purgeStartedAt: null, lifecycleState: 'trashed',
    contentRevision: serverTimestamp()
  }));
  await assertSucceeds(updateDoc(doc(owner, 'quiz_sets/set1'), {
    trashedAt: deleteField(), lifecycleState: 'active',
    contentRevision: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(admin, 'quiz_sets/set1'), {
    trashedAt: serverTimestamp(), purgeStartedAt: null, lifecycleState: 'trashed'
  }));

  await adminWrite('quiz_sets/set1', {
    ownerUid: 'owner-uid', ownerEmail: 'owner@school.kr', lifecycleState: 'trashed',
    trashedAt: Timestamp.fromMillis(Date.now() - 31 * 86400000), purgeStartedAt: null,
    collaboratorCount: 0, imageCount: 1
  });
  await adminWrite('images/set1/q/purge-me', { data: 'image' });
  await assertSucceeds(updateDoc(doc(admin, 'quiz_sets/set1'), {
    purgeStartedAt: serverTimestamp(), lifecycleState: 'purging'
  }));
  const purgeBatch = writeBatch(admin);
  purgeBatch.set(doc(admin, 'quiz_sets/set1'), {
    imageCount: 0, imageMutation: { key: 'purge-me', action: 'purge-remove' }
  }, { merge: true });
  purgeBatch.delete(doc(admin, 'images/set1/q/purge-me'));
  await assertSucceeds(purgeBatch.commit());
  await assertSucceeds(deleteDoc(doc(admin, 'quiz_sets/set1')));
});

rulesTest('purging child reads let the real store finish owner/admin purge and deny other actors', async () => {
  await resetFirestore();
  const expiredAt = Timestamp.fromMillis(Date.now() - 31 * 86400000);
  for (const setId of ['owner-purge-store', 'admin-purge-store', 'denied-purge-store']) {
    await adminWrite(`quiz_sets/${setId}`, {
      ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
      lifecycleState: 'trashed', trashedAt: expiredAt, purgeStartedAt: null,
      collaboratorCount: 1, imageCount: 1, contentRevision: Timestamp.fromMillis(1)
    });
    await adminWrite(`quiz_sets/${setId}/collaborators/other@school.kr`, {
      email: actors.otherTeacher.email, addedByUid: actors.owner.uid, addedAt: Timestamp.fromMillis(1)
    });
    await adminWrite(`quiz_set_shares/other@school.kr/sets/${setId}`, {
      email: actors.otherTeacher.email, setId
    });
    await adminWrite(`images/${setId}/q/v0q0`, { data: 'purge-image' });
  }

  const ownerDb = actorFirestore('owner');
  const ownerStore = emulatorStore(ownerDb);
  await ownerStore.beginSetPurge('owner-purge-store', 'immediate', actors.owner);
  assert.deepEqual(await ownerStore.continueSetPurge('owner-purge-store'), {
    done: false, deleted: 2, parentDeleted: false
  });
  assert.equal(await adminRead(
    'quiz_set_shares/other@school.kr/sets/owner-purge-store'
  ), undefined);
  assert.deepEqual(await ownerStore.continueSetPurge('owner-purge-store'), {
    done: true, deleted: 0, parentDeleted: true
  });

  const adminDb = actorFirestore('admin');
  const adminStore = emulatorStore(adminDb);
  await adminStore.beginSetPurge('admin-purge-store', 'expired', { ...actors.admin, role: 'admin' });
  assert.deepEqual(await adminStore.continueSetPurge('admin-purge-store'), {
    done: false, deleted: 2, parentDeleted: false
  });
  assert.equal(await adminRead(
    'quiz_set_shares/other@school.kr/sets/admin-purge-store'
  ), undefined);
  assert.deepEqual(await adminStore.continueSetPurge('admin-purge-store'), {
    done: true, deleted: 0, parentDeleted: true
  });

  await ownerStore.beginSetPurge('denied-purge-store', 'immediate', actors.owner);
  const other = actorFirestore('otherTeacher');
  await assertFails(getDocs(collection(other, 'quiz_sets/denied-purge-store/collaborators')));
  await assertFails(getDocs(collection(other, 'images/denied-purge-store/q')));
});

rulesTest('counter migration gate is admin-only, stale-safe, and blocks child writes without blocking reads', async () => {
  await resetFirestore();
  const admin = actorFirestore('admin');
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const gatePath = 'migration_gates/set_counters';
  const lockedGate = {
    locked: true,
    lockId: 'round5-gate-1',
    projectId,
    targetMode: 'emulator',
    lockedAt: serverTimestamp(),
    lockedByUid: actors.admin.uid
  };

  await assertFails(setDoc(doc(other, gatePath), {
    ...lockedGate, lockedByUid: actors.otherTeacher.uid
  }));
  await assertSucceeds(setDoc(doc(admin, gatePath), lockedGate));
  await assertFails(getDoc(doc(owner, gatePath)));

  const imageUpdate = writeBatch(owner);
  imageUpdate.set(doc(owner, 'quiz_sets/set1'), { contentRevision: serverTimestamp() }, { merge: true });
  imageUpdate.update(doc(owner, 'images/set1/q/0'), { data: 'locked-update' });
  await assertFails(imageUpdate.commit());

  const imageAdd = writeBatch(owner);
  imageAdd.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 2, imageMutation: { key: 'new', action: 'add' }
  }, { merge: true });
  imageAdd.set(doc(owner, 'images/set1/q/new'), { data: 'locked-add' });
  await assertFails(imageAdd.commit());

  const imageDelete = writeBatch(owner);
  imageDelete.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 0, imageMutation: { key: '0', action: 'remove' }
  }, { merge: true });
  imageDelete.delete(doc(owner, 'images/set1/q/0'));
  await assertFails(imageDelete.commit());

  const collaboratorAdd = writeBatch(owner);
  collaboratorAdd.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 1,
    collaboratorMutation: { email: actors.otherTeacher.email, action: 'add' }
  }, { merge: true });
  collaboratorAdd.set(doc(owner, 'quiz_sets/set1/collaborators/other@school.kr'), {
    email: actors.otherTeacher.email, addedByUid: actors.owner.uid, addedAt: serverTimestamp()
  });
  await assertFails(collaboratorAdd.commit());

  await assertSucceeds(getDoc(doc(owner, 'images/set1/q/0')));
  await assertSucceeds(getDoc(doc(owner, 'sessions/s1')));
  await assertFails(setDoc(doc(admin, gatePath), {
    locked: false,
    lockId: 'stale-gate',
    projectId,
    targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(1),
    lockedByUid: actors.admin.uid,
    unlockedAt: serverTimestamp(),
    unlockedByUid: actors.admin.uid
  }));
  await assertFails(setDoc(doc(other, gatePath), {
    locked: false,
    lockId: 'round5-gate-1',
    projectId,
    targetMode: 'emulator',
    lockedAt: Timestamp.fromMillis(1),
    lockedByUid: actors.admin.uid,
    unlockedAt: serverTimestamp(),
    unlockedByUid: actors.otherTeacher.uid
  }));

  const currentGate = (await getDoc(doc(admin, gatePath))).data();
  await assertSucceeds(setDoc(doc(admin, gatePath), {
    locked: false,
    lockId: currentGate.lockId,
    projectId: currentGate.projectId,
    targetMode: currentGate.targetMode,
    lockedAt: currentGate.lockedAt,
    lockedByUid: currentGate.lockedByUid,
    unlockedAt: serverTimestamp(),
    unlockedByUid: actors.admin.uid
  }));

  const afterUnlock = writeBatch(owner);
  afterUnlock.set(doc(owner, 'quiz_sets/set1'), { contentRevision: serverTimestamp() }, { merge: true });
  afterUnlock.update(doc(owner, 'images/set1/q/0'), { data: 'unlocked-update' });
  await assertSucceeds(afterUnlock.commit());
});

rulesTest('missing or locked gate fails closed for counters and stale-zero parent deletion until migration unlock', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  const admin = actorFirestore('admin');
  const gatePath = 'migration_gates/set_counters';
  await adminWrite(gatePath, undefined);

  await adminWrite('quiz_sets/stale-zero', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'purging', trashedAt: Timestamp.fromMillis(1),
    purgeStartedAt: Timestamp.fromMillis(2), collaboratorCount: 0, imageCount: 0
  });
  await adminWrite('images/stale-zero/q/real', { data: 'orphan-risk' });
  await adminWrite('quiz_sets/staged-trash', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'trashed', trashedAt: Timestamp.fromMillis(1), purgeStartedAt: null,
    collaboratorCount: 0, imageCount: 0
  });

  const missingAdd = writeBatch(owner);
  missingAdd.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 2, imageMutation: { key: 'missing-gate', action: 'add' }
  }, { merge: true });
  missingAdd.set(doc(owner, 'images/set1/q/missing-gate'), { data: 'blocked' });
  await assertFails(missingAdd.commit());
  await assertFails(updateDoc(doc(owner, 'quiz_sets/staged-trash'), {
    lifecycleState: 'purging', purgeStartedAt: serverTimestamp()
  }));
  await assertFails(deleteDoc(doc(owner, 'quiz_sets/stale-zero')));
  await assertSucceeds(getDoc(doc(owner, 'images/set1/q/0')));
  await assertSucceeds(getDoc(doc(owner, 'sessions/s1')));

  await adminWrite(gatePath, { locked: false });
  const malformedAdd = writeBatch(owner);
  malformedAdd.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 2, imageMutation: { key: 'malformed-gate', action: 'add' }
  }, { merge: true });
  malformedAdd.set(doc(owner, 'images/set1/q/malformed-gate'), { data: 'blocked' });
  await assertFails(malformedAdd.commit());
  await adminWrite(gatePath, undefined);

  await assertSucceeds(setDoc(doc(admin, gatePath), {
    locked: true,
    lockId: 'round6-gate',
    projectId,
    targetMode: 'emulator',
    lockedAt: serverTimestamp(),
    lockedByUid: actors.admin.uid
  }));
  await assertFails(deleteDoc(doc(owner, 'quiz_sets/stale-zero')));
  await assertFails(updateDoc(doc(owner, 'quiz_sets/staged-trash'), {
    lifecycleState: 'purging', purgeStartedAt: serverTimestamp()
  }));

  await adminWrite('quiz_sets/stale-zero', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'purging', trashedAt: Timestamp.fromMillis(1),
    purgeStartedAt: Timestamp.fromMillis(2), collaboratorCount: 0, imageCount: 1
  });
  const lockedGate = (await getDoc(doc(admin, gatePath))).data();
  await assertSucceeds(setDoc(doc(admin, gatePath), {
    ...lockedGate,
    locked: false,
    unlockedAt: serverTimestamp(),
    unlockedByUid: actors.admin.uid
  }));
  await assertFails(deleteDoc(doc(owner, 'quiz_sets/stale-zero')));

  const ownerStore = emulatorStore(owner);
  assert.deepEqual(await ownerStore.continueSetPurge('stale-zero'), {
    done: false, deleted: 1, parentDeleted: false
  });
  assert.deepEqual(await ownerStore.continueSetPurge('stale-zero'), {
    done: true, deleted: 0, parentDeleted: true
  });
});

rulesTest('FixRound2 collaborator count and discovery index require an exact 3-write batch', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  const target = 'other@school.kr';
  await assertFails(updateDoc(doc(owner, 'quiz_sets/set1'), { collaboratorCount: 1 }));
  const forged = writeBatch(owner);
  forged.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 1,
    collaboratorMutation: { email: target, action: 'add' }
  }, { merge: true });
  await assertFails(forged.commit());

  const missingIndex = writeBatch(owner);
  missingIndex.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 1,
    collaboratorMutation: { email: target, action: 'add' }
  }, { merge: true });
  missingIndex.set(doc(owner, `quiz_sets/set1/collaborators/${target}`), {
    email: target, addedByUid: actors.owner.uid, addedAt: serverTimestamp()
  });
  await assertFails(missingIndex.commit());

  await assertFails(setDoc(doc(owner, `quiz_set_shares/${target}/sets/set1`), {
    email: target, setId: 'set1'
  }));

  const add = writeBatch(owner);
  add.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 1,
    collaboratorMutation: { email: target, action: 'add' }
  }, { merge: true });
  add.set(doc(owner, `quiz_sets/set1/collaborators/${target}`), {
    email: target, addedByUid: actors.owner.uid, addedAt: serverTimestamp()
  });
  add.set(doc(owner, `quiz_set_shares/${target}/sets/set1`), {
    email: target, setId: 'set1'
  });
  await assertSucceeds(add.commit());

  const editor = actorFirestore('otherTeacher');
  await assertSucceeds(updateDoc(doc(editor, 'quiz_sets/set1'), { title: '공동 편집' }));
  await assertFails(updateDoc(doc(editor, 'quiz_sets/set1'), { archived: true }));

  await adminWrite(`quiz_set_shares/${target}/sets/set1`, undefined);
  const missingStoredIndexDelete = writeBatch(owner);
  missingStoredIndexDelete.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 0,
    collaboratorMutation: { email: target, action: 'remove' }
  }, { merge: true });
  missingStoredIndexDelete.delete(doc(owner, `quiz_sets/set1/collaborators/${target}`));
  missingStoredIndexDelete.delete(doc(owner, `quiz_set_shares/${target}/sets/set1`));
  await assertFails(missingStoredIndexDelete.commit());
  await adminWrite(`quiz_set_shares/${target}/sets/set1`, {
    email: target, setId: 'set1'
  });

  const missingIndexDelete = writeBatch(owner);
  missingIndexDelete.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 0,
    collaboratorMutation: { email: target, action: 'remove' }
  }, { merge: true });
  missingIndexDelete.delete(doc(owner, `quiz_sets/set1/collaborators/${target}`));
  await assertFails(missingIndexDelete.commit());

  const remove = writeBatch(owner);
  remove.set(doc(owner, 'quiz_sets/set1'), {
    collaboratorCount: 0,
    collaboratorMutation: { email: target, action: 'remove' }
  }, { merge: true });
  remove.delete(doc(owner, `quiz_sets/set1/collaborators/${target}`));
  remove.delete(doc(owner, `quiz_set_shares/${target}/sets/set1`));
  await assertSucceeds(remove.commit());
  await assertFails(updateDoc(doc(editor, 'quiz_sets/set1'), { title: '제거 후 저장' }));
});

rulesTest('일반 교사 소유자는 Store로 승인 대상만 추가하고 승인 목록은 읽지 못한다', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  const ownerStore = emulatorStore(owner);

  await assertFails(getDoc(doc(owner, 'teacher_allowlist/other@school.kr')));
  await ownerStore.addCollaborator('set1', 'other@school.kr', actors.owner);
  assert.equal((await getDoc(doc(owner,
    'quiz_sets/set1/collaborators/other@school.kr'))).data().email, 'other@school.kr');

  await assert.rejects(ownerStore.addCollaborator(
    'set1', 'blocked@school.kr', actors.owner
  ), /승인된 교사/);
  assert.equal((await getDoc(doc(owner,
    'quiz_sets/set1/collaborators/blocked@school.kr'))).exists(), false);
});

rulesTest('휴지통 원본은 다른 교사의 읽기·새 수업 시작에서 닫힌다', async () => {
  await resetFirestore();
  await adminWrite('quiz_sets/set1', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email, trashedAt: Timestamp.fromMillis(1)
  });
  const other = actorFirestore('otherTeacher');
  await assertFails(getDoc(doc(other, 'quiz_sets/set1')));
  await assertFails(setDoc(doc(other, 'sessions/trash-source'), {
    setId: 'set1', teacherUid: actors.otherTeacher.uid,
    teacherEmail: actors.otherTeacher.email, status: 'active'
  }));
  await assertFails(deleteDoc(doc(actorFirestore('owner'), 'quiz_sets/set1')));
});

rulesTest('purge counters는 marker·parent-only·wrong-target forge를 거부한다', async () => {
  await resetFirestore();
  const admin = actorFirestore('admin');
  await adminWrite('quiz_sets/set1', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email, lifecycleState: 'purging',
    trashedAt: Timestamp.fromMillis(1), purgeStartedAt: Timestamp.fromMillis(2),
    collaboratorCount: 0, imageCount: 1
  });
  await adminWrite('images/set1/q/real', { data: 'image' });
  await assertFails(updateDoc(doc(admin, 'quiz_sets/set1'), { purgeChildrenVerified: true }));
  await assertFails(updateDoc(doc(admin, 'quiz_sets/set1'), { imageCount: 0 }));
  const wrongTarget = writeBatch(admin);
  wrongTarget.set(doc(admin, 'quiz_sets/set1'), {
    imageCount: 0, imageMutation: { key: 'fake', action: 'purge-remove' }
  }, { merge: true });
  wrongTarget.delete(doc(admin, 'images/set1/q/real'));
  await assertFails(wrongTarget.commit());
  await assertFails(deleteDoc(doc(admin, 'quiz_sets/set1')));
});

rulesTest('counter-ready active image add/delete requires one exact parent mutation target', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  await adminWrite('quiz_sets/set1', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email, lifecycleState: 'active',
    trashedAt: null, purgeStartedAt: null, collaboratorCount: 0, imageCount: 1,
    contentRevision: Timestamp.fromMillis(1)
  });
  await adminWrite('images/set1/q/old', { data: 'old' });
  const add = writeBatch(owner);
  add.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 2, imageMutation: { key: 'new', action: 'add' }, contentRevision: serverTimestamp()
  }, { merge: true });
  add.set(doc(owner, 'images/set1/q/new'), { data: 'new' });
  await assertSucceeds(add.commit());
  const forged = writeBatch(owner);
  forged.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 3, imageMutation: { key: 'fake', action: 'add' }
  }, { merge: true });
  await assertFails(forged.commit());
  const remove = writeBatch(owner);
  remove.set(doc(owner, 'quiz_sets/set1'), {
    imageCount: 1, imageMutation: { key: 'new', action: 'remove' }, contentRevision: serverTimestamp()
  }, { merge: true });
  remove.delete(doc(owner, 'images/set1/q/new'));
  await assertSucceeds(remove.commit());
  await assertFails(updateDoc(doc(owner, 'quiz_sets/set1'), { imageCount: 2 }));
});

rulesTest('strict counters reject malformed create, legacy promotion, underflow and purge transitions', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  const base = {
    ownerUid: actors.owner.uid,
    ownerEmail: actors.owner.email,
    lifecycleState: 'active',
    title: '새 세트'
  };

  await assertFails(setDoc(doc(owner, 'quiz_sets/missing-counts'), base));
  await assertFails(setDoc(doc(owner, 'quiz_sets/nonzero-counts'), {
    ...base, collaboratorCount: 1, imageCount: 0
  }));
  await assertFails(setDoc(doc(owner, 'quiz_sets/negative-count'), {
    ...base, collaboratorCount: 0, imageCount: -1
  }));
  await assertFails(setDoc(doc(owner, 'quiz_sets/forged-mutation'), {
    ...base, collaboratorCount: 0, imageCount: 0,
    imageMutation: { key: 'q', action: 'add' }
  }));
  await assertFails(setDoc(doc(owner, 'quiz_sets/forged-trash'), {
    ...base, collaboratorCount: 0, imageCount: 0,
    trashedAt: serverTimestamp()
  }));
  await assertSucceeds(setDoc(doc(owner, 'quiz_sets/valid-empty'), {
    ...base, collaboratorCount: 0, imageCount: 0
  }));

  await adminWrite('quiz_sets/legacy-missing', base);
  const missingAdd = writeBatch(owner);
  missingAdd.set(doc(owner, 'quiz_sets/legacy-missing'), {
    imageCount: 0, imageMutation: { key: 'q', action: 'add' },
    contentRevision: serverTimestamp()
  }, { merge: true });
  missingAdd.set(doc(owner, 'images/legacy-missing/q/q'), { data: 'image' });
  await assertFails(missingAdd.commit());
  await assertFails(updateDoc(doc(owner, 'quiz_sets/legacy-missing'), {
    trashedAt: serverTimestamp(), lifecycleState: 'trashed', contentRevision: serverTimestamp()
  }));

  await adminWrite('quiz_sets/negative-active', {
    ...base, collaboratorCount: 0, imageCount: -1
  });
  const negativeAdd = writeBatch(owner);
  negativeAdd.set(doc(owner, 'quiz_sets/negative-active'), {
    imageCount: 0, imageMutation: { key: 'q', action: 'add' },
    contentRevision: serverTimestamp()
  }, { merge: true });
  negativeAdd.set(doc(owner, 'images/negative-active/q/q'), { data: 'image' });
  await assertFails(negativeAdd.commit());
  await assertFails(updateDoc(doc(owner, 'quiz_sets/negative-active'), {
    trashedAt: serverTimestamp(), lifecycleState: 'trashed', contentRevision: serverTimestamp()
  }));

  await adminWrite('quiz_sets/underflow-active', {
    ...base, collaboratorCount: 0, imageCount: 0
  });
  await adminWrite('images/underflow-active/q/q', { data: 'image' });
  const activeUnderflow = writeBatch(owner);
  activeUnderflow.set(doc(owner, 'quiz_sets/underflow-active'), {
    imageCount: -1, imageMutation: { key: 'q', action: 'remove' },
    contentRevision: serverTimestamp()
  }, { merge: true });
  activeUnderflow.delete(doc(owner, 'images/underflow-active/q/q'));
  await assertFails(activeUnderflow.commit());

  await adminWrite('quiz_sets/negative-trash', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'trashed', trashedAt: Timestamp.fromMillis(1),
    purgeStartedAt: null, collaboratorCount: -1, imageCount: 0
  });
  await assertFails(updateDoc(doc(owner, 'quiz_sets/negative-trash'), {
    lifecycleState: 'active', trashedAt: deleteField(), contentRevision: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(owner, 'quiz_sets/negative-trash'), {
    lifecycleState: 'purging', purgeStartedAt: serverTimestamp()
  }));

  await adminWrite('quiz_sets/underflow-purge', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'purging', trashedAt: Timestamp.fromMillis(1),
    purgeStartedAt: Timestamp.fromMillis(2), collaboratorCount: 0, imageCount: 0
  });
  await adminWrite('images/underflow-purge/q/q', { data: 'image' });
  const purgeUnderflow = writeBatch(owner);
  purgeUnderflow.set(doc(owner, 'quiz_sets/underflow-purge'), {
    imageCount: -1, imageMutation: { key: 'q', action: 'purge-remove' }
  }, { merge: true });
  purgeUnderflow.delete(doc(owner, 'images/underflow-purge/q/q'));
  await assertFails(purgeUnderflow.commit());
});

rulesTest('store create follows strict counter protocol', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  const store = emulatorStore(owner);

  await store.saveOwnedQuizSet('store-new', {
    title: '신규', videos: [], lifecycleState: 'purging',
    collaboratorCount: 9, imageCount: -1,
    imageMutation: { key: 'fake', action: 'add' }
  }, { v0q0: 'new-image' }, actors.owner);
  const created = await assertSucceeds(getDoc(doc(owner, 'quiz_sets/store-new')));
  assert.equal(created.data().lifecycleState, 'active');
  assert.equal(created.data().collaboratorCount, 0);
  assert.equal(created.data().imageCount, 1);
});

rulesTest('store content-plus-image save follows strict counter protocol', async () => {
  await resetFirestore();
  const owner = actorFirestore('owner');
  const store = emulatorStore(owner);
  await adminWrite('quiz_sets/store-existing', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'active', collaboratorCount: 0, imageCount: 0,
    title: '이전', contentRevision: Timestamp.fromMillis(1)
  });
  await store.saveQuizSetWithImages('store-existing', {
    ownerUid: actors.owner.uid, ownerEmail: actors.owner.email,
    lifecycleState: 'active', collaboratorCount: 0, imageCount: 0,
    title: '변경'
  }, { v0q0: 'image' }, actors.owner);
  const saved = await assertSucceeds(getDoc(doc(owner, 'quiz_sets/store-existing')));
  assert.equal(saved.data().title, '변경');
  assert.equal(saved.data().imageCount, 1);
});

rulesTest('private active original은 소유자·공동편집자만 수업에 사용하고 다른 교사 direct start를 거부한다', async () => {
  await resetFirestore();
  const other = actorFirestore('otherTeacher');
  await assertFails(setDoc(doc(other, 'sessions/active-source'), {
    setId: 'set1', teacherUid: actors.otherTeacher.uid,
    teacherEmail: actors.otherTeacher.email, status: 'active',
    registeredStudentCount: 0, studentCountRevision: 0
  }));
  await adminWrite('quiz_sets/set1/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  await assertSucceeds(setDoc(doc(other, 'sessions/collaborator-source'), {
    setId: 'set1', teacherUid: actors.otherTeacher.uid,
    teacherEmail: actors.otherTeacher.email, status: 'active',
    registeredStudentCount: 0, studentCountRevision: 0
  }));
  await assertFails(setDoc(doc(other, 'sessions/missing-source'), {
    setId: 'does-not-exist', teacherUid: actors.otherTeacher.uid,
    teacherEmail: actors.otherTeacher.email, status: 'active',
    registeredStudentCount: 0, studentCountRevision: 0
  }));
  await assertFails(setDoc(doc(other, 'sessions/non-string-source'), {
    setId: 123, teacherUid: actors.otherTeacher.uid,
    teacherEmail: actors.otherTeacher.email, status: 'active',
    registeredStudentCount: 0, studentCountRevision: 0
  }));
});

rulesTest('teacher-access: two pending UIDs sharing one email preserve the first canonical mirror UID', async () => {
  const sharedEmail = 'shared-approval@school.kr';
  for (const [uid, displayName] of [['pending-shared-a', '첫 교사'], ['pending-shared-b', '둘째 교사']]) {
    await adminWrite(`teacher_access_requests/${uid}`, {
      uid, emailCanonical: sharedEmail, displayName,
      organization: '', note: '', status: 'pending', revision: 1,
      createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1)
    });
  }
  const store = emulatorStore(actorFirestore('admin'));

  await store.decideTeacherRequest(
    'pending-shared-a', 1, { status: 'approved' }, requestAdminIdentity
  );
  await assert.rejects(() => store.decideTeacherRequest(
    'pending-shared-b', 1, { status: 'approved' }, requestAdminIdentity
  ));
  await store.decideTeacherRequest(
    'pending-shared-b', 1,
    { status: 'rejected', reason: '동일 이메일의 기존 UID 승인' }, requestAdminIdentity
  );

  assert.equal((await adminRead(`teacher_allowlist/${sharedEmail}`)).uid, 'pending-shared-a');
  assert.equal((await adminRead('teacher_access_requests/pending-shared-b')).status, 'rejected');
  assert.equal(await adminRead('teacher_allowances/pending-shared-b'), undefined);
});

rulesTest('teacher-access: approval after-state cannot assign the canonical mirror to another UID', async () => {
  const uid = 'pending-after-state';
  const email = 'after-state@school.kr';
  await adminWrite(`teacher_access_requests/${uid}`, {
    uid, emailCanonical: email, displayName: '안전 교사',
    organization: '', note: '', status: 'pending', revision: 1,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1)
  });
  const admin = actorFirestore('admin');
  const batch = writeBatch(admin);
  batch.update(doc(admin, `teacher_access_requests/${uid}`), {
    status: 'approved', revision: 2, decidedAt: serverTimestamp(),
    decidedByUid: 'admin-uid', decisionReason: '', updatedAt: serverTimestamp()
  });
  batch.set(doc(admin, `teacher_allowances/${uid}`), {
    uid, emailCanonical: email, displayName: '안전 교사', status: 'active',
    enabled: true, role: 'teacher', administrativeHold: false,
    approvedAt: serverTimestamp(), approvedByUid: 'admin-uid',
    updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  });
  batch.set(doc(admin, `teacher_allowlist/${email}`), {
    uid: 'different-uid', enabled: true, role: 'teacher',
    updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  });

  await assertFails(batch.commit());
  assert.equal((await adminRead(`teacher_access_requests/${uid}`)).status, 'pending');
  assert.equal(await adminRead(`teacher_allowances/${uid}`), undefined);
  assert.equal(await adminRead(`teacher_allowlist/${email}`), undefined);
});

rulesTest('FixRound2 private read and shared discovery use exact quiz_sets paths without collection-group leakage', async () => {
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const admin = actorFirestore('admin');

  await assertSucceeds(getDoc(doc(owner, 'quiz_sets/set1')));
  await assertSucceeds(getDoc(doc(admin, 'quiz_sets/set1')));
  assert.ok((await emulatorStore(admin).listQuizSets({
    role: 'admin', allowAdminAll: true
  })).some(set => set.id === 'set1'));
  await assertFails(getDoc(doc(other, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(other, 'images/set1/q/0')));
  await assertFails(getDocs(query(
    collection(other, 'quiz_sets'),
    where('lifecycleState', '==', 'active')
  )));
  await assertSucceeds(getDocs(query(
    collection(other, 'quiz_sets'),
    where('lifecycleState', '==', 'active'),
    where('ownerUid', '==', actors.otherTeacher.uid)
  )));

  await adminWrite('quiz_sets/set1/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1),
    secret: 'malformed-collaborator-data'
  });
  await assertFails(getDoc(doc(other, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(other, 'images/set1/q/0')));

  await adminWrite('quiz_sets/set1/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('quiz_set_shares/other@school.kr/sets/set1', {
    email: actors.otherTeacher.email,
    setId: 'set1'
  });
  await adminWrite('admin_private/secret/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    secret: 'victim-private-data'
  });
  await assertSucceeds(getDoc(doc(other, 'quiz_sets/set1')));
  await assertSucceeds(getDoc(doc(other, 'images/set1/q/0')));
  await assertSucceeds(getDoc(doc(other, 'quiz_sets/set1/collaborators/other@school.kr')));
  await assertFails(getDoc(doc(other,
    'admin_private/secret/collaborators/other@school.kr')));
  await assertFails(getDocs(query(
    collection(other, 'quiz_set_shares/owner@school.kr/sets'),
    queryLimit(50)
  )));

  const shared = collectionGroup(other, 'collaborators');
  await assertFails(getDocs(query(
    shared,
    where('email', '==', actors.otherTeacher.email),
    queryLimit(50)
  )));
  await assertFails(getDocs(query(shared, queryLimit(50))));
  await assertFails(getDocs(query(
    shared,
    where('email', '==', actors.owner.email),
    queryLimit(50)
  )));

  const discovered = await emulatorStore(other).listSharedQuizSets({
    ...actors.otherTeacher,
    role: 'teacher'
  });
  assert.deepEqual(discovered.map(set => set.id), ['set1']);
});

rulesTest('FixRound3 shared discovery skips one trashed stale parent without hiding active shares', async () => {
  const other = actorFirestore('otherTeacher');
  await adminWrite('quiz_sets/set1/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('quiz_set_shares/other@school.kr/sets/set1', {
    email: actors.otherTeacher.email,
    setId: 'set1'
  });
  await adminWrite('quiz_sets/trashed-shared', {
    ownerUid: actors.owner.uid,
    ownerEmail: actors.owner.email,
    trashedAt: Timestamp.fromMillis(2),
    purgeStartedAt: null,
    lifecycleState: 'trashed',
    collaboratorCount: 1,
    imageCount: 0,
    title: '휴지통 공유 세트'
  });
  await adminWrite('quiz_sets/trashed-shared/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  await adminWrite('quiz_set_shares/other@school.kr/sets/trashed-shared', {
    email: actors.otherTeacher.email,
    setId: 'trashed-shared'
  });

  await assertFails(getDoc(doc(other, 'quiz_sets/trashed-shared')));
  const discovered = await emulatorStore(other).listSharedQuizSets({
    ...actors.otherTeacher,
    role: 'teacher'
  });
  assert.deepEqual(discovered.map(set => set.id), ['set1']);
});

rulesTest('FixRound3 Admin-backfilled legacy indexes restore discovery, remove, and purge protocols', async () => {
  const ownerStore = emulatorStore(actorFirestore('owner'));
  const otherStore = emulatorStore(actorFirestore('otherTeacher'));
  const otherActor = { ...actors.otherTeacher, role: 'teacher' };

  await adminWrite('quiz_sets/legacy-shared', {
    ownerUid: actors.owner.uid,
    ownerEmail: actors.owner.email,
    trashedAt: null,
    purgeStartedAt: null,
    lifecycleState: 'active',
    collaboratorCount: 1,
    imageCount: 0,
    title: '기존 공유 세트'
  });
  await adminWrite('quiz_sets/legacy-shared/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });

  assert.equal((await otherStore.listSharedQuizSets(otherActor))
    .some(set => set.id === 'legacy-shared'), false);
  await assert.rejects(ownerStore.removeCollaborator(
    'legacy-shared', actors.otherTeacher.email, actors.owner
  ), error => String(error && error.code || '').includes('permission-denied'));

  // This exact document is the trusted Admin migration's only backfill shape.
  await adminWrite('quiz_set_shares/other@school.kr/sets/legacy-shared', {
    email: actors.otherTeacher.email,
    setId: 'legacy-shared'
  });
  assert.equal((await otherStore.listSharedQuizSets(otherActor))
    .some(set => set.id === 'legacy-shared'), true);
  assert.equal(await ownerStore.removeCollaborator(
    'legacy-shared', actors.otherTeacher.email, actors.owner
  ), true);

  const expiredAt = Timestamp.fromMillis(Date.now() - 31 * 86400000);
  await adminWrite('quiz_sets/legacy-purge', {
    ownerUid: actors.owner.uid,
    ownerEmail: actors.owner.email,
    lifecycleState: 'trashed',
    trashedAt: expiredAt,
    purgeStartedAt: null,
    collaboratorCount: 1,
    imageCount: 0,
    contentRevision: Timestamp.fromMillis(1)
  });
  await adminWrite('quiz_sets/legacy-purge/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  await ownerStore.beginSetPurge('legacy-purge', 'immediate', actors.owner);
  await assert.rejects(ownerStore.continueSetPurge('legacy-purge'), error =>
    String(error && error.code || '').includes('permission-denied')
  );
  await adminWrite('quiz_set_shares/other@school.kr/sets/legacy-purge', {
    email: actors.otherTeacher.email,
    setId: 'legacy-purge'
  });
  assert.deepEqual(await ownerStore.continueSetPurge('legacy-purge'), {
    done: false,
    deleted: 1,
    parentDeleted: false
  });
  assert.deepEqual(await ownerStore.continueSetPurge('legacy-purge'), {
    done: true,
    deleted: 0,
    parentDeleted: true
  });
});

rulesTest('FixRound1 private nested reviewer PII exploit cannot cross the flat public projection boundary', async () => {
  const publicationId = 'pii-boundary';
  await seedPublicRulesSource(publicationId);
  const owner = actorFirestore('owner');
  const sourceReference = doc(owner, `quiz_sets/${publicationId}`);
  const taintedVideos = publicRulesSource().videos;
  taintedVideos[0].questions[0].reviewerEmail = 'reviewer-private@school.kr';
  taintedVideos[0].questions[0].reviewNotes = { studentUid: 'student-secret' };

  // This records the legacy private-schema limitation: arbitrary nested fields are
  // accepted, so the public boundary must never mirror the raw nested source.
  await assertSucceeds(updateDoc(sourceReference, { videos: taintedVideos }));
  await assertFails(setDoc(doc(owner, `published_quiz_sets/${publicationId}`), {
    ...publicRulesBuilding(publicationId),
    videos: taintedVideos,
    updatedAt: serverTimestamp()
  }));

  const sanitized = await emulatorStore(owner).publishQuizSet(publicationId, publicRulesOwner);
  assert.equal(sanitized.videos[0].questions[0].reviewerEmail, undefined);
  const storedQuestion = (await getDoc(doc(owner,
    `published_quiz_sets/${publicationId}/questions/v0q0`))).data();
  assert.equal(storedQuestion.reviewerEmail, undefined);
  assert.equal(storedQuestion.reviewNotes, undefined);

  const childPublicationId = 'pii-child-boundary';
  await seedPublicRulesSource(childPublicationId);
  await adminWrite(`published_quiz_sets/${childPublicationId}`,
    publicRulesBuilding(childPublicationId));
  const forgedQuestion = {
    ...publicRulesFlat(childPublicationId).questions.v0q0,
    reviewerEmail: 'reviewer-private@school.kr',
    reviewNotes: { studentUid: 'student-secret' }
  };
  const forged = writeBatch(owner);
  forged.update(doc(owner, `published_quiz_sets/${childPublicationId}`), {
    buildQuestionCount: 1,
    buildMutation: { collection: 'questions', key: 'v0q0', action: 'bind' }
  });
  forged.set(doc(owner,
    `published_quiz_sets/${childPublicationId}/questions/v0q0`), forgedQuestion);
  await assertFails(forged.commit());
});

rulesTest('FixRound2 actual store publishes a supported legacy single-video source through Rules', async () => {
  const publicationId = 'legacy-flat-publication';
  const source = publicRulesSource();
  const [video] = source.videos;
  delete source.videos;
  source.videoId = video.videoId;
  source.videoUrl = video.videoUrl;
  source.startSec = video.startSec;
  source.endSec = video.endSec;
  source.questions = video.questions;
  await adminWrite(`quiz_sets/${publicationId}`, source);

  const owner = actorFirestore('owner');
  const published = await emulatorStore(owner).publishQuizSet(
    publicationId,
    publicRulesOwner
  );

  assert.equal(published.status, 'published');
  assert.equal(published.videos.length, 1);
  assert.equal(published.videos[0].videoId, 'dQw4w9WgXcQ');
  assert.equal((await getDoc(doc(owner,
    `published_quiz_sets/${publicationId}/videos/v0`))).data().videoId,
    'dQw4w9WgXcQ');

  const adminStore = emulatorStore(actorFirestore('admin'));
  assert.equal((await adminStore.adminModeratePublishedQuiz(
    publicationId,
    'rev-1',
    'legacy lifecycle check',
    requestAdminIdentity
  )).status, 'moderated');
  assert.equal((await adminStore.adminRestorePublishedQuiz(
    publicationId,
    'rev-1',
    requestAdminIdentity
  )).status, 'published');

  for (const [suffix, patch] of [
    ['bad-video-id', { videoId: 'not-canonical' }],
    ['empty-questions', { questions: [] }],
    ['missing-settings', { settings: null }]
  ]) {
    const invalidId = `legacy-${suffix}`;
    await adminWrite(`quiz_sets/${invalidId}`, { ...source, ...patch });
    await assertFails(setDoc(doc(owner, `published_quiz_sets/${invalidId}`), {
      ...publicRulesBuilding(invalidId),
      updatedAt: serverTimestamp()
    }));
  }
});

rulesTest('published projection list requires exact visible status order and bounded limit', async () => {
  await seedPublicRulesSource('library-set');
  await seedPublishedRulesProjection('library-set');
  await adminWrite('published_quiz_sets/library-building', publicRulesBuilding('library-building'));
  await adminWrite('published_quiz_sets/library-withdrawn', publicRulesProjection(
    'library-withdrawn', { status: 'withdrawn' }
  ));
  await adminWrite('published_quiz_sets/library-moderated', publicRulesProjection(
    'library-moderated', { status: 'moderated', moderationStatus: 'moderated' }
  ));

  const exactQuery = db => getDocs(query(
    collection(db, 'published_quiz_sets'),
    where('status', '==', 'published'),
    orderBy('updatedAt', 'desc'),
    queryLimit(50)
  ));
  for (const actorName of approvedTeachers) {
    await assertSucceeds(exactQuery(actorFirestore(actorName)));
  }
  for (const actorName of ['unapproved', 'student', 'anonymous']) {
    await assertFails(exactQuery(actorFirestore(actorName)));
  }
  await assertFails(exactQuery(testEnvironment.unauthenticatedContext().firestore()));

  const other = actorFirestore('otherTeacher');
  await assertFails(getDocs(collection(other, 'published_quiz_sets')));
  await assertFails(getDocs(query(
    collection(other, 'published_quiz_sets'),
    where('status', '==', 'published'),
    queryLimit(50)
  )));
  await assertFails(getDocs(query(
    collection(other, 'published_quiz_sets'),
    where('status', '==', 'published'),
    orderBy('updatedAt', 'asc'),
    queryLimit(50)
  )));
  await assertFails(getDocs(query(
    collection(other, 'published_quiz_sets'),
    where('status', '==', 'published'),
    orderBy('updatedAt', 'desc'),
    queryLimit(51)
  )));
  await assertFails(getDocs(query(
    collection(other, 'published_quiz_sets'),
    where('status', '==', 'building'),
    orderBy('updatedAt', 'desc'),
    queryLimit(50)
  )));

  await assertSucceeds(getDoc(doc(other, 'published_quiz_sets/library-set')));
  for (const id of ['library-building', 'library-withdrawn', 'library-moderated']) {
    await assertFails(getDoc(doc(other, `published_quiz_sets/${id}`)));
  }
});

rulesTest('published projection rejects and hides email-shaped or UID-like author labels at the Rules boundary', async () => {
  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');

  for (const [index, authorDisplayName] of [
    'owner@school.kr', 'AbCDefghijklmnopqrst1234', actors.owner.uid
  ].entries()) {
    const publicationId = `unsafe-author-${index}`;
    await seedPublicRulesSource(publicationId);
    const allowance = await adminRead('teacher_allowances/owner-uid');
    await adminWrite('teacher_allowances/owner-uid', {
      ...allowance, displayName: authorDisplayName
    });
    await assertFails(setDoc(doc(owner, `published_quiz_sets/${publicationId}`), {
      ...publicRulesBuilding(publicationId, { authorDisplayName }),
      updatedAt: serverTimestamp()
    }));
    const unsafeProjection = publicRulesProjection(publicationId, {
      authorDisplayName: '마이그레이션 전 표시명'
    });
    unsafeProjection.authorDisplayName = authorDisplayName;
    await adminWrite(`published_quiz_sets/${publicationId}`, unsafeProjection);
    await assertFails(getDoc(doc(other, `published_quiz_sets/${publicationId}`)));
  }

  const safeId = 'safe-korean-author';
  await seedPublicRulesSource(safeId);
  const allowance = await adminRead('teacher_allowances/owner-uid');
  await adminWrite('teacher_allowances/owner-uid', { ...allowance, displayName: '홍 교사' });
  await assertSucceeds(setDoc(doc(owner, `published_quiz_sets/${safeId}`), {
    ...publicRulesBuilding(safeId, { authorDisplayName: '홍 교사' }),
    updatedAt: serverTimestamp()
  }));
});

rulesTest('FixRound2 publication lifecycle gate deterministically closes list get children and races', async () => {
  const publicationId = 'gate-interleave';
  const image = 'data:image/png;base64,AAAA';
  await seedPublicRulesSource(publicationId, { imageCount: 1 }, { v0q0: image });
  await seedPublishedRulesProjection(publicationId, {}, { v0q0: image });
  const admin = actorFirestore('admin');
  const other = actorFirestore('otherTeacher');
  const owner = actorFirestore('owner');
  const publicQuery = db => getDocs(query(
    collection(db, 'published_quiz_sets'),
    where('status', '==', 'published'),
    orderBy('updatedAt', 'desc'),
    queryLimit(50)
  ));
  const visibleChildren = db => [
    ['videos', 'v0'], ['questions', 'v0q0'], ['images', 'v0q0']
  ].map(([name, key]) => ({
    get: () => getDoc(doc(db,
      `published_quiz_sets/${publicationId}/${name}/${key}`)),
    list: () => getDocs(query(
      collection(db, `published_quiz_sets/${publicationId}/${name}`),
      where('revision', '==', 'rev-1'),
      where('schemaVersion', '==', 1)
    ))
  }));
  await assertSucceeds(publicQuery(other));
  await assertSucceeds(getDoc(doc(other, `published_quiz_sets/${publicationId}`)));
  for (const child of visibleChildren(other)) {
    await assertSucceeds(child.get());
    await assertSucceeds(child.list());
  }

  const lock = {
    ownerUid: actors.owner.uid,
    ownerEmailCanonical: actors.owner.email,
    allowanceRevision: 0,
    allowanceRole: 'teacher',
    allowanceStatus: 'active',
    allowanceEnabled: true,
    reason: 'teacher-suspension',
    operationId: 'deterministic-lifecycle-operation',
    initiatedByUid: actors.admin.uid,
    initiatedByRole: 'admin',
    createdAt: serverTimestamp()
  };
  const acquire = writeBatch(admin);
  acquire.set(doc(admin, `publication_lifecycle_locks/${actors.owner.uid}`), lock);
  acquire.set(doc(admin, 'publication_lifecycle_gates/current'), lock);
  await assertSucceeds(acquire.commit());

  await assertFails(publicQuery(other));
  await assertFails(getDoc(doc(other, `published_quiz_sets/${publicationId}`)));
  await assertFails(getDoc(doc(other,
    `published_quiz_sets/${publicationId}/questions/v0q0`)));
  for (const child of visibleChildren(other)) {
    await assertFails(child.get());
    await assertFails(child.list());
  }
  await assert.rejects(emulatorStore(owner).publishQuizSet(publicationId, publicRulesOwner));
  await assertFails(setDoc(doc(other, 'publication_lifecycle_gates/current'), {
    ...lock, operationId: 'forged', createdAt: serverTimestamp()
  }));

  const release = writeBatch(admin);
  release.delete(doc(admin, `publication_lifecycle_locks/${actors.owner.uid}`));
  release.delete(doc(admin, 'publication_lifecycle_gates/current'));
  await assertSucceeds(release.commit());
  await assertSucceeds(publicQuery(other));

  await adminWrite('publication_lifecycle_gates/current', {
    ownerUid: actors.owner.uid,
    ownerEmailCanonical: actors.owner.email,
    allowanceRevision: 999,
    allowanceRole: 'teacher',
    allowanceStatus: 'active',
    allowanceEnabled: true,
    reason: 'teacher-suspension',
    operationId: 'well-shaped-stale-gate',
    initiatedByUid: actors.admin.uid,
    initiatedByRole: 'admin',
    createdAt: Timestamp.fromMillis(1)
  });
  await assertFails(publicQuery(other));
  for (const child of visibleChildren(other)) {
    await assertFails(child.get());
    await assertFails(child.list());
  }
  await adminWrite('publication_lifecycle_gates/current', undefined);

  await adminWrite('publication_lifecycle_gates/current', {
    ownerUid: actors.owner.uid,
    operationId: 'malformed-stale-gate'
  });
  await assertFails(publicQuery(other));
  for (const child of visibleChildren(other)) {
    await assertFails(child.get());
    await assertFails(child.list());
  }
  await assertFails(deleteDoc(doc(admin, 'publication_lifecycle_gates/current')));
});

rulesTest('FixRound2 legacy malformed children stay outside the schema-bound collection query', async () => {
  const publicationId = 'child-list-schema';
  const image = 'data:image/png;base64,AAAA';
  await seedPublicRulesSource(publicationId, { imageCount: 1 }, { v0q0: image });
  await seedPublishedRulesProjection(publicationId, {}, { v0q0: image });
  const other = actorFirestore('otherTeacher');

  for (const [name, key] of [
    ['videos', 'v0'], ['questions', 'v0q0'], ['images', 'v0q0']
  ]) {
    const path = `published_quiz_sets/${publicationId}/${name}/${key}`;
    const malformed = { ...(await adminRead(path)), reviewerEmail: 'private@school.kr' };
    delete malformed.schemaVersion;
    await adminWrite(path, malformed);
    await assertFails(getDoc(doc(other, path)));
    const hidden = await assertSucceeds(getDocs(query(
      collection(other, `published_quiz_sets/${publicationId}/${name}`),
      where('revision', '==', 'rev-1'),
      where('schemaVersion', '==', 1)
    )));
    assert.equal(hidden.empty, true);
  }
});

rulesTest('FixRound2 global lifecycle gate blocks unrelated publication builds and public copy starts', async () => {
  const other = actorFirestore('otherTeacher');
  const sourceId = 'global-gate-source';
  const buildId = 'global-gate-build';
  const progressId = 'global-gate-progress';
  const finalId = 'global-gate-final';
  const replaceId = 'global-gate-replace';
  const restoreId = 'global-gate-restore';
  await seedPublicRulesSource(sourceId);
  await seedPublishedRulesProjection(sourceId);
  await seedPublicRulesSource(buildId, {
    ownerUid: actors.otherTeacher.uid,
    ownerEmail: actors.otherTeacher.email
  });
  await seedPublicRulesSource(finalId, {
    ownerUid: actors.otherTeacher.uid,
    ownerEmail: actors.otherTeacher.email
  });
  await adminWrite(`published_quiz_sets/${finalId}`, publicRulesBuilding(finalId, {
    authorDisplayName: '다른 교사',
    buildVideoCount: 1,
    buildQuestionCount: 1
  }));
  await seedPublicRulesSource(progressId, {
    ownerUid: actors.otherTeacher.uid,
    ownerEmail: actors.otherTeacher.email
  });
  await adminWrite(`published_quiz_sets/${progressId}`, publicRulesBuilding(progressId, {
    authorDisplayName: '다른 교사'
  }));
  await seedPublicRulesSource(replaceId, {
    ownerUid: actors.otherTeacher.uid,
    ownerEmail: actors.otherTeacher.email
  });
  await seedPublishedRulesProjection(replaceId);
  await seedPublicRulesSource(restoreId);
  await seedPublishedRulesProjection(restoreId, {
    status: 'moderated', moderationStatus: 'moderated'
  });
  await adminWrite(`published_quiz_audits/${restoreId}`, {
    publicationId: restoreId, revision: 'rev-1', status: 'moderated',
    moderatedByUid: actors.admin.uid, moderationReason: 'gate restore check',
    moderatedAt: Timestamp.fromMillis(1_000)
  });
  await assertSucceeds(setDoc(doc(other, 'quiz_sets/global-gate-copy-progress'),
    publicCopyStart(sourceId)));
  await adminWrite('publication_lifecycle_gates/current', {
    ownerUid: 'orphan-owner',
    operationId: 'orphan-malformed-global-gate'
  });

  await assertFails(setDoc(doc(other, `published_quiz_sets/${buildId}`), {
    ...publicRulesBuilding(buildId, { authorDisplayName: '다른 교사' }),
    updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(other, 'quiz_sets/global-gate-copy'),
    publicCopyStart(sourceId)));
  const buildStep = writeBatch(other);
  buildStep.update(doc(other, `published_quiz_sets/${progressId}`), {
    buildVideoCount: 1,
    buildMutation: { collection: 'videos', key: 'v0', action: 'bind' }
  });
  buildStep.set(doc(other, `published_quiz_sets/${progressId}/videos/v0`),
    publicRulesFlat(progressId).videos.v0);
  await assertFails(buildStep.commit());
  await assertFails(setDoc(doc(other, `published_quiz_sets/${finalId}`), {
    ...publicRulesProjection(finalId, { authorDisplayName: '다른 교사' }),
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(other, `published_quiz_sets/${replaceId}`), {
    ...publicRulesBuilding(replaceId, { authorDisplayName: '다른 교사' }),
    publishedAt: Timestamp.fromMillis(900),
    updatedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(other, 'quiz_sets/global-gate-copy-progress'), {
    lifecycleState: 'active', copyStatus: deleteField(),
    updatedAt: serverTimestamp(), contentRevision: serverTimestamp()
  }));
  await assert.rejects(emulatorStore(actorFirestore('admin')).adminRestorePublishedQuiz(
    restoreId, 'rev-1', requestAdminIdentity
  ));

  await adminWrite('publication_lifecycle_gates/current', undefined);
  await assertSucceeds(setDoc(doc(other, `published_quiz_sets/${buildId}`), {
    ...publicRulesBuilding(buildId, { authorDisplayName: '다른 교사' }),
    updatedAt: serverTimestamp()
  }));
  await assertSucceeds(setDoc(doc(other, 'quiz_sets/global-gate-copy'),
    publicCopyStart(sourceId)));
  const resumedBuildStep = writeBatch(other);
  resumedBuildStep.update(doc(other, `published_quiz_sets/${progressId}`), {
    buildVideoCount: 1,
    buildMutation: { collection: 'videos', key: 'v0', action: 'bind' }
  });
  resumedBuildStep.set(doc(other, `published_quiz_sets/${progressId}/videos/v0`),
    publicRulesFlat(progressId).videos.v0);
  await assertSucceeds(resumedBuildStep.commit());
  await assertSucceeds(setDoc(doc(other, `published_quiz_sets/${finalId}`), {
    ...publicRulesProjection(finalId, { authorDisplayName: '다른 교사' }),
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }));
  await assertSucceeds(setDoc(doc(other, `published_quiz_sets/${replaceId}`), {
    ...publicRulesBuilding(replaceId, { authorDisplayName: '다른 교사' }),
    publishedAt: Timestamp.fromMillis(900),
    updatedAt: serverTimestamp()
  }));
  await assertSucceeds(updateDoc(doc(other, 'quiz_sets/global-gate-copy-progress'), {
    lifecycleState: 'active', copyStatus: deleteField(),
    updatedAt: serverTimestamp(), contentRevision: serverTimestamp()
  }));
  await assert.doesNotReject(emulatorStore(actorFirestore('admin')).adminRestorePublishedQuiz(
    restoreId, 'rev-1', requestAdminIdentity
  ));
});

rulesTest('legacy owner audit includes missing lifecycleState but public visibility stays closed', async () => {
  const publicationId = 'legacy-lifecycle-audit';
  const source = publicRulesSource();
  delete source.lifecycleState;
  await adminWrite(`quiz_sets/${publicationId}`, source);
  await adminWrite(`published_quiz_sets/${publicationId}`,
    publicRulesProjection(publicationId));

  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const page = await emulatorStore(owner).auditOwnedPublications(
    actors.owner.uid, 50, null
  );

  assert.deepEqual(page.items, [{
    publicationId, status: 'published', revision: 'rev-1'
  }]);
  await assertFails(getDoc(doc(other, `published_quiz_sets/${publicationId}`)));
  await assert.rejects(emulatorStore(owner).publishQuizSet(publicationId, publicRulesOwner));
});

rulesTest('owner reads only own moderated parent while admin lists the exact bounded moderation status set', async () => {
  await seedPublicRulesSource('owner-moderated');
  await adminWrite('published_quiz_sets/owner-moderated', publicRulesProjection(
    'owner-moderated', { status: 'moderated', moderationStatus: 'moderated' }
  ));
  await adminWrite('published_quiz_audits/owner-moderated', {
    publicationId: 'owner-moderated', revision: 'rev-1', status: 'moderated',
    moderatedByUid: actors.admin.uid, moderationReason: 'private reason',
    moderatedAt: Timestamp.fromMillis(1_000)
  });
  await adminWrite('published_quiz_sets/admin-published', publicRulesProjection('admin-published'));
  await adminWrite('published_quiz_sets/admin-withdrawn', publicRulesProjection(
    'admin-withdrawn', { status: 'withdrawn' }
  ));

  const owner = actorFirestore('owner');
  const other = actorFirestore('otherTeacher');
  const admin = actorFirestore('admin');
  await assertSucceeds(getDoc(doc(owner, 'published_quiz_sets/owner-moderated')));
  await assertFails(getDoc(doc(other, 'published_quiz_sets/owner-moderated')));
  await assertFails(getDoc(doc(owner, 'published_quiz_audits/owner-moderated')));

  const exactAdminQuery = db => getDocs(query(
    collection(db, 'published_quiz_sets'),
    where('status', 'in', ['published', 'moderated']),
    orderBy('updatedAt', 'desc'),
    queryLimit(50)
  ));
  const snapshot = await assertSucceeds(exactAdminQuery(admin));
  assert.deepEqual(snapshot.docs.map(document => document.id).sort(), [
    'admin-published', 'owner-moderated'
  ]);
  const ownerStatus = await emulatorStore(owner).getOwnedPublicationStatus('owner-moderated');
  assert.deepEqual(ownerStatus, {
    publicationId: 'owner-moderated', status: 'moderated', revision: 'rev-1'
  });
  assert.equal(ownerStatus.moderatedByUid, undefined);
  assert.equal(ownerStatus.moderationReason, undefined);
  const adminStore = emulatorStore(admin);
  const adminPage = await adminStore.listAdminPublishedQuizSets({
    limit: 50, admin: requestAdminIdentity
  });
  assert.deepEqual(adminPage.items.map(item => item.publicationId).sort(), [
    'admin-published', 'owner-moderated'
  ]);
  assert.equal(adminPage.nextCursor, null);
  await assertFails(exactAdminQuery(other));
  await assertFails(getDocs(query(
    collection(admin, 'published_quiz_sets'),
    where('status', 'in', ['published', 'moderated', 'withdrawn']),
    orderBy('updatedAt', 'desc'),
    queryLimit(50)
  )));
  await assertFails(getDocs(query(
    collection(admin, 'published_quiz_sets'),
    where('status', 'in', ['published', 'moderated']),
    orderBy('updatedAt', 'desc'),
    queryLimit(51)
  )));
});

rulesTest('published projection owner protocol admits actual building image finalize republish and safety withdrawal shapes', async () => {
  const firstImages = {
    v0q0: 'data:image/png;base64,AAAA',
    v0q0e: 'data:image/png;base64,BBBB'
  };
  await seedPublicRulesSource('library-set', { imageCount: 2 }, firstImages);
  const owner = actorFirestore('owner');
  const store = emulatorStore(owner, undefined, undefined, () => 1_000);

  const first = await store.publishQuizSet('library-set', publicRulesOwner);
  assert.equal(first.status, 'published');
  const firstStored = (await getDoc(doc(owner, 'published_quiz_sets/library-set'))).data();
  assert.equal(firstStored.ownerUid, undefined);
  assert.equal(firstStored.buildToken, undefined);
  const firstPublishedAt = firstStored.publishedAt.toMillis();
  const other = actorFirestore('otherTeacher');
  await adminWrite('quiz_sets/library-set/collaborators/other@school.kr', {
    email: actors.otherTeacher.email,
    addedByUid: actors.owner.uid,
    addedAt: Timestamp.fromMillis(1)
  });
  await assertFails(updateDoc(doc(other, 'published_quiz_sets/library-set'), {
    title: '공동편집자 직접 공개 변경', updatedAt: serverTimestamp()
  }));

  await adminWrite('quiz_sets/library-set', publicRulesSource({
    title: '수정된 공개 과학 퀴즈', imageCount: 2, contentRevision: 'rev-2'
  }));
  await adminWrite('images/library-set/q/v0q0', { data: 'data:image/png;base64,CHANGED' });
  await adminWrite('images/library-set/q/v0q0e', undefined);
  await adminWrite('images/library-set/q/v0q1', { data: 'data:image/png;base64,CCCC' });

  const republished = await store.publishQuizSet('library-set', publicRulesOwner);
  assert.equal(republished.status, 'published');
  const republishedStored = (await getDoc(doc(owner, 'published_quiz_sets/library-set'))).data();
  assert.equal(republishedStored.revision, 'rev-2');
  assert.equal(republishedStored.publishedAt.toMillis(), firstPublishedAt);
  assert.equal(republishedStored.imageCount, 2);

  await adminWrite('quiz_sets/library-set', publicRulesSource({
    title: 'revision 없이 바뀐 비공개 제목', imageCount: -1, contentRevision: 'rev-2'
  }));
  const withdrawn = await store.withdrawPublishedQuizSet('library-set', publicRulesOwner);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.title, '수정된 공개 과학 퀴즈');

  await assertFails(setDoc(doc(other, 'published_quiz_sets/standalone'),
    publicRulesProjection('standalone')));
  await assertFails(updateDoc(doc(actorFirestore('admin'), 'published_quiz_sets/library-set'), {
    title: '관리자 직접 내용 변경', updatedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(owner, 'published_quiz_sets/library-set'), {
    revision: 'forged-revision', updatedAt: serverTimestamp()
  }));
});

rulesTest('publication trash is atomic, restore stays private, and moderated content cannot resurrect', async () => {
  const publicationId = 'lifecycle-trash';
  await seedPublicRulesSource(publicationId);
  await seedPublishedRulesProjection(publicationId);
  const ownerDb = actorFirestore('owner');
  const ownerStore = emulatorStore(ownerDb);

  await assertFails(updateDoc(doc(ownerDb, `quiz_sets/${publicationId}`), {
    lifecycleState: 'trashed', trashedAt: serverTimestamp(),
    purgeStartedAt: null, contentRevision: serverTimestamp()
  }));

  await ownerStore.moveSetToTrash(publicationId, publicRulesOwner).catch(error => {
    throw new Error('published trash stage: ' + error.message, { cause: error });
  });
  assert.equal((await getDoc(doc(ownerDb,
    `published_quiz_sets/${publicationId}`))).data().status, 'withdrawn');
  await ownerStore.restoreSet(publicationId, publicRulesOwner).catch(error => {
    throw new Error('withdrawn restore stage: ' + error.message, { cause: error });
  });
  assert.equal((await getDoc(doc(ownerDb,
    `published_quiz_sets/${publicationId}`))).data().status, 'withdrawn');

  const buildingId = 'lifecycle-building';
  await seedPublicRulesSource(buildingId);
  await adminWrite(`published_quiz_sets/${buildingId}`,
    publicRulesBuilding(buildingId, { buildToken: 'abandoned-build-token' }));
  await ownerStore.moveSetToTrash(buildingId, publicRulesOwner).catch(error => {
    throw new Error('building cancellation stage: ' + error.message, { cause: error });
  });
  const cancelled = await getDoc(doc(ownerDb, `published_quiz_sets/${buildingId}`));
  assert.equal(cancelled.data().status, 'cancelled');
  assert.equal(cancelled.data().buildToken, 'abandoned-build-token');
  await ownerStore.restoreSet(buildingId, publicRulesOwner).catch(error => {
    throw new Error('cancelled restore stage: ' + error.message, { cause: error });
  });
  const republished = await ownerStore.publishQuizSet(buildingId, publicRulesOwner)
    .catch(error => {
      throw new Error('cancelled republish stage: ' + error.message, { cause: error });
    });
  assert.equal(republished.status, 'published');
  assert.equal((await getDoc(doc(ownerDb,
    `published_quiz_sets/${buildingId}`))).data().status, 'published');

  const moderatedId = 'lifecycle-moderated';
  await seedPublicRulesSource(moderatedId);
  await adminWrite(`published_quiz_sets/${moderatedId}`, publicRulesProjection(moderatedId, {
    status: 'moderated', moderationStatus: 'moderated'
  }));
  await adminWrite(`published_quiz_audits/${moderatedId}`, {
    publicationId: moderatedId, revision: 'rev-1', status: 'moderated',
    moderatedByUid: actors.admin.uid, moderationReason: 'hold',
    moderatedAt: Timestamp.fromMillis(1_000)
  });

  await ownerStore.moveSetToTrash(moderatedId, publicRulesOwner).catch(error => {
    throw new Error('moderated trash stage: ' + error.message, { cause: error });
  });
  await ownerStore.restoreSet(moderatedId, publicRulesOwner).catch(error => {
    throw new Error('moderated restore stage: ' + error.message, { cause: error });
  });
  assert.equal((await adminRead(`published_quiz_sets/${moderatedId}`)).status, 'moderated');
  await assertFails(updateDoc(doc(ownerDb, `published_quiz_sets/${moderatedId}`), {
    status: 'published', moderationStatus: 'clear', updatedAt: serverTimestamp()
  }));
});

rulesTest('publication suspension and deletion preflight hide copies before allowance removal', async () => {
  const publicationId = 'lifecycle-suspend';
  const buildingId = 'lifecycle-suspend-building';
  await seedPublicRulesSource(publicationId);
  await seedPublishedRulesProjection(publicationId);
  await seedPublicRulesSource(buildingId);
  await adminWrite(`published_quiz_sets/${buildingId}`,
    publicRulesBuilding(buildingId, { buildToken: 'lifecycle-suspend-build-token' }));
  await adminWrite('teacher_allowances/owner-uid', {
    ...(await adminRead('teacher_allowances/owner-uid')), revision: 1
  });
  const adminStore = emulatorStore(actorFirestore('admin'));

  await adminStore.adminUpdateTeacherAllowance({
    uid: actors.owner.uid, emailCanonical: actors.owner.email, expectedRevision: 1,
    role: 'teacher', status: 'suspended', reason: 'hold'
  }, requestAdminIdentity);

  assert.equal((await adminRead(`published_quiz_sets/${publicationId}`)).status, 'withdrawn');
  assert.equal((await adminRead(`published_quiz_sets/${buildingId}`)).status, 'cancelled');
  assert.equal((await adminRead('teacher_allowances/owner-uid')).status, 'suspended');
  await assert.rejects(() => emulatorStore(actorFirestore('otherTeacher'))
    .copyPublishedQuizSet(publicationId, 'copy-after-suspend', {
      uid: actors.otherTeacher.uid, email: actors.otherTeacher.email, role: 'teacher'
    }), /permission|published|공개|승인|active/i);

  const deletionId = 'lifecycle-delete';
  await adminWrite('teacher_allowances/owner-uid', {
    ...(await adminRead('teacher_allowances/owner-uid')),
    status: 'active', enabled: true, administrativeHold: false, revision: 3
  });
  await adminWrite('teacher_allowlist/owner@school.kr', {
    uid: actors.owner.uid, enabled: true, role: 'teacher',
    updatedAt: Timestamp.fromMillis(1), updatedByUid: actors.admin.uid
  });
  await seedPublicRulesSource(deletionId);
  await seedPublishedRulesProjection(deletionId);
  const ownerStore = emulatorStore(actorFirestore('owner'));

  await ownerStore.requestTeacherDeletion(actors.owner.uid, publicRulesOwner);

  assert.equal((await adminRead(`published_quiz_sets/${deletionId}`)).status, 'withdrawn');
  assert.equal((await adminRead('teacher_allowances/owner-uid')).status, 'deletion_pending');
});

rulesTest('publication purge deletes bounded public images before the private parent', async () => {
  const publicationId = 'lifecycle-purge';
  await seedPublicRulesSource(publicationId, {
    lifecycleState: 'trashed', trashedAt: Timestamp.fromMillis(1),
    purgeStartedAt: null, imageCount: 0
  });
  await seedPublishedRulesProjection(publicationId, {
    status: 'withdrawn', imageCount: 1
  }, { v0q0: 'data:image/png;base64,AAAA' });
  const ownerDb = actorFirestore('owner');
  const ownerStore = emulatorStore(ownerDb);

  await ownerStore.beginSetPurge(publicationId, 'immediate', publicRulesOwner);
  const first = await ownerStore.continueSetPurge(publicationId);
  assert.deepEqual(first, { done: false, deleted: 1, parentDeleted: false });
  assert.equal(await adminRead(
    `published_quiz_sets/${publicationId}/images/v0q0`), undefined);
  assert.notEqual(await adminRead(`quiz_sets/${publicationId}`), undefined);

  const done = await ownerStore.continueSetPurge(publicationId);
  assert.equal(done.parentDeleted, true);
});

rulesTest('published projection public image reads require a visible exact revision binding', async () => {
  await seedPublicRulesSource('image-public', { imageCount: 1 }, {
    v0q0: 'data:image/png;base64,AAAA'
  });
  await seedPublishedRulesProjection('image-public', {}, {
    v0q0: 'data:image/png;base64,AAAA'
  });
  const other = actorFirestore('otherTeacher');
  const currentImages = () => getDocs(query(
    collection(other, 'published_quiz_sets/image-public/images'),
    where('revision', '==', 'rev-1'),
    where('schemaVersion', '==', 1)
  ));
  await assertSucceeds(getDoc(doc(other, 'published_quiz_sets/image-public/images/v0q0')));
  await assertFails(getDocs(collection(other, 'published_quiz_sets/image-public/images')));
  await assertSucceeds(currentImages());

  await adminWrite('published_quiz_sets/image-public/images/v0q0', {
    data: 'data:image/png;base64,AAAA', revision: 'stale',
    schemaVersion: 1, buildToken: 'build-token-1'
  });
  await assertFails(getDoc(doc(other, 'published_quiz_sets/image-public/images/v0q0')));
  await assertSucceeds(currentImages());

  await adminWrite('published_quiz_sets/image-building', publicRulesBuilding('image-building', {
    imageCount: 1, buildImageCount: 1
  }));
  await adminWrite('published_quiz_sets/image-building/images/v0q0', {
    data: 'data:image/png;base64,AAAA', revision: 'rev-1',
    schemaVersion: 1, buildToken: 'build-token-1'
  });
  await assertFails(getDoc(doc(other, 'published_quiz_sets/image-building/images/v0q0')));
  await assertFails(setDoc(doc(actorFirestore('owner'),
    'published_quiz_sets/image-public/images/standalone'), {
    data: 'data:image/png;base64,AAAA', revision: 'rev-1',
    schemaVersion: 1, buildToken: 'build-token-1'
  }));
});

rulesTest('FixRound1 public image list requires the visible parent revision query', async () => {
  await seedPublicRulesSource('image-list-revision', { imageCount: 1 }, {
    v0q0: 'data:image/png;base64,AAAA'
  });
  await seedPublishedRulesProjection('image-list-revision', {}, {
    v0q0: 'data:image/png;base64,AAAA'
  });
  await adminWrite('published_quiz_sets/image-list-revision/images/v0q1', {
    data: 'data:image/png;base64,STALE', revision: 'rev-stale',
    schemaVersion: 1, buildToken: 'old-build'
  });
  const other = actorFirestore('otherTeacher');
  const images = collection(other, 'published_quiz_sets/image-list-revision/images');

  await assertFails(getDocs(images));
  await assertFails(getDocs(query(images, where('revision', '==', 'rev-1'))));
  await assertFails(getDocs(query(images, where('schemaVersion', '==', 1))));
  await assertFails(getDocs(query(
    images,
    where('revision', '==', 'rev-1'),
    where('schemaVersion', '==', 2)
  )));
  const visible = await assertSucceeds(getDocs(query(
    images,
    where('revision', '==', 'rev-1'),
    where('schemaVersion', '==', 1)
  )));
  assert.deepEqual(visible.docs.map(document => document.id), ['v0q0']);
});

rulesTest('FixRound3 malformed public image schemaVersion cannot bind or unlock finalization', async () => {
  const image = 'data:image/png;base64,AAAA';
  const malformedVersions = [2, '1', { version: 1 }];
  const owner = actorFirestore('owner');

  for (const [index, schemaVersion] of malformedVersions.entries()) {
    const publicationId = `image-schema-bind-${index}`;
    await seedPublicRulesSource(publicationId, { imageCount: 1 }, { v0q0: image });
    await adminWrite(`published_quiz_sets/${publicationId}`, publicRulesBuilding(
      publicationId, {
        imageCount: 1,
        buildVideoCount: 1,
        buildQuestionCount: 1,
        buildImageCount: 0
      }
    ));

    const bind = writeBatch(owner);
    bind.update(doc(owner, `published_quiz_sets/${publicationId}`), {
      buildImageCount: 1,
      buildMutation: { collection: 'images', key: 'v0q0', action: 'bind' }
    });
    bind.set(doc(owner, `published_quiz_sets/${publicationId}/images/v0q0`), {
      data: image,
      revision: 'rev-1',
      schemaVersion,
      buildToken: 'build-token-1'
    });
    await assertFails(bind.commit());

    await assertFails(setDoc(doc(owner, `published_quiz_sets/${publicationId}`), {
      ...publicRulesProjection(publicationId, { imageCount: 1 }),
      publishedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
  }

  const validId = 'image-schema-bind-valid';
  await seedPublicRulesSource(validId, { imageCount: 1 }, { v0q0: image });
  await adminWrite(`published_quiz_sets/${validId}`, publicRulesBuilding(validId, {
    imageCount: 1,
    buildVideoCount: 1,
    buildQuestionCount: 1,
    buildImageCount: 0
  }));
  const validBind = writeBatch(owner);
  validBind.update(doc(owner, `published_quiz_sets/${validId}`), {
    buildImageCount: 1,
    buildMutation: { collection: 'images', key: 'v0q0', action: 'bind' }
  });
  validBind.set(doc(owner, `published_quiz_sets/${validId}/images/v0q0`), {
    data: image,
    revision: 'rev-1',
    schemaVersion: 1,
    buildToken: 'build-token-1'
  });
  await assertSucceeds(validBind.commit());
  await assertSucceeds(setDoc(doc(owner, `published_quiz_sets/${validId}`), {
    ...publicRulesProjection(validId, { imageCount: 1 }),
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }));

  const other = actorFirestore('otherTeacher');
  await assertSucceeds(getDoc(doc(other,
    `published_quiz_sets/${validId}/images/v0q0`)));
  const visible = await assertSucceeds(getDocs(query(
    collection(other, `published_quiz_sets/${validId}/images`),
    where('revision', '==', 'rev-1'),
    where('schemaVersion', '==', 1)
  )));
  assert.deepEqual(visible.docs.map(document => document.id), ['v0q0']);
});

rulesTest('FixRound3 direct image get rejects Admin-seeded malformed schemaVersion', async () => {
  const image = 'data:image/png;base64,AAAA';
  const malformedVersions = [2, '1', { version: 1 }];
  const other = actorFirestore('otherTeacher');

  for (const [index, schemaVersion] of malformedVersions.entries()) {
    const publicationId = `image-schema-get-${index}`;
    await seedPublicRulesSource(publicationId, { imageCount: 1 }, { v0q0: image });
    await seedPublishedRulesProjection(publicationId, {}, { v0q0: image });
    await adminWrite(`published_quiz_sets/${publicationId}/images/v0q0`, {
      data: image,
      revision: 'rev-1',
      schemaVersion,
      buildToken: 'build-token-1'
    });
    await assertFails(getDoc(doc(other,
      `published_quiz_sets/${publicationId}/images/v0q0`)));
  }
});

rulesTest('FixRound1 public image processed counter rejects a standalone parent increment', async () => {
  await seedPublicRulesSource('image-parent-only', { imageCount: 1 }, {
    v0q0: 'data:image/png;base64,AAAA'
  });
  await adminWrite('published_quiz_sets/image-parent-only', publicRulesBuilding(
    'image-parent-only', { imageCount: 1, buildImageCount: 0 }
  ));
  await assertFails(updateDoc(doc(actorFirestore('owner'),
    'published_quiz_sets/image-parent-only'), {
    buildImageCount: 1,
    buildMutation: { collection: 'images', key: 'v0q0', action: 'bind' }
  }));
});

rulesTest('FixRound1 one public image parent increment cannot bind two child documents', async () => {
  const images = {
    v0q0: 'data:image/png;base64,AAAA',
    v0q1: 'data:image/png;base64,BBBB'
  };
  await seedPublicRulesSource('image-double-child', { imageCount: 2 }, images);
  await adminWrite('published_quiz_sets/image-double-child', publicRulesBuilding(
    'image-double-child', { imageCount: 2, buildImageCount: 0 }
  ));
  const owner = actorFirestore('owner');
  const batch = writeBatch(owner);
  batch.update(doc(owner, 'published_quiz_sets/image-double-child'), {
    buildImageCount: 1,
    buildMutation: { collection: 'images', key: 'v0q0', action: 'bind' }
  });
  for (const [key, data] of Object.entries(images)) {
    batch.set(doc(owner, `published_quiz_sets/image-double-child/images/${key}`), {
      data, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-token-1'
    });
  }
  await assertFails(batch.commit());
});

rulesTest('FixRound1 public image replacement must consume one exact processed marker', async () => {
  await seedPublicRulesSource('image-replacement', { imageCount: 1 }, {
    v0q0: 'data:image/png;base64,NEW'
  });
  await adminWrite('published_quiz_sets/image-replacement', publicRulesBuilding(
    'image-replacement', { imageCount: 1, buildImageCount: 0 }
  ));
  await adminWrite('published_quiz_sets/image-replacement/images/v0q0', {
    data: 'data:image/png;base64,OLD', revision: 'old-revision',
    schemaVersion: 1, buildToken: 'old-build'
  });
  await assertFails(updateDoc(doc(actorFirestore('owner'),
    'published_quiz_sets/image-replacement/images/v0q0'), {
    data: 'data:image/png;base64,NEW', revision: 'rev-1',
    schemaVersion: 1, buildToken: 'build-token-1'
  }));
});

rulesTest('FixRound1 a public image cannot be rebound while the building parent instantly finalizes', async () => {
  const image = 'data:image/png;base64,AAAA';
  await seedPublicRulesSource('image-instant-finalize', { imageCount: 1 }, { v0q0: image });
  await adminWrite('published_quiz_sets/image-instant-finalize', publicRulesBuilding(
    'image-instant-finalize', {
      imageCount: 1, buildVideoCount: 1, buildQuestionCount: 1, buildImageCount: 0
    }
  ));
  const owner = actorFirestore('owner');
  const batch = writeBatch(owner);
  batch.update(doc(owner, 'published_quiz_sets/image-instant-finalize'), {
    status: 'published', publishedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    buildToken: deleteField(), buildVideoCount: deleteField(),
    buildQuestionCount: deleteField(), buildImageCount: deleteField()
  });
  batch.set(doc(owner, 'published_quiz_sets/image-instant-finalize/images/v0q0'), {
    data: image, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-token-1'
  });
  await assertFails(batch.commit());
});

rulesTest('FixRound1 source revision changed in the finalize batch is evaluated from commit state', async () => {
  await seedPublicRulesSource('finalize-cas');
  await adminWrite('published_quiz_sets/finalize-cas', publicRulesBuilding('finalize-cas', {
    buildVideoCount: 1, buildQuestionCount: 1
  }));
  const owner = actorFirestore('owner');
  const batch = writeBatch(owner);
  batch.update(doc(owner, 'quiz_sets/finalize-cas'), { contentRevision: 'rev-2' });
  batch.update(doc(owner, 'published_quiz_sets/finalize-cas'), {
    status: 'published',
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    buildToken: deleteField(),
    buildVideoCount: deleteField(),
    buildQuestionCount: deleteField(),
    buildImageCount: deleteField()
  });
  await assertFails(batch.commit());
});

rulesTest('FixRound1 building create and image bind use commit-state source revision and allowance', async () => {
  await seedPublicRulesSource('building-create-cas');
  const owner = actorFirestore('owner');
  const createBatch = writeBatch(owner);
  createBatch.update(doc(owner, 'quiz_sets/building-create-cas'), {
    contentRevision: 'rev-2'
  });
  createBatch.set(doc(owner, 'published_quiz_sets/building-create-cas'), {
    ...publicRulesBuilding('building-create-cas'), updatedAt: serverTimestamp()
  });
  await assertFails(createBatch.commit());

  const image = 'data:image/png;base64,AAAA';
  await seedPublicRulesSource('image-bind-cas', { imageCount: 1 }, { v0q0: image });
  await adminWrite('published_quiz_sets/image-bind-cas', publicRulesBuilding(
    'image-bind-cas', { imageCount: 1 }
  ));
  const imageBatch = writeBatch(owner);
  imageBatch.update(doc(owner, 'quiz_sets/image-bind-cas'), { contentRevision: 'rev-2' });
  imageBatch.update(doc(owner, 'published_quiz_sets/image-bind-cas'), {
    buildImageCount: 1,
    buildMutation: { collection: 'images', key: 'v0q0', action: 'bind' }
  });
  imageBatch.set(doc(owner, 'published_quiz_sets/image-bind-cas/images/v0q0'), {
    data: image, revision: 'rev-1', schemaVersion: 1, buildToken: 'build-token-1'
  });
  await assertFails(imageBatch.commit());
});

rulesTest('published projection admin moderation and restore require the exact atomic audit side document', async () => {
  await seedPublicRulesSource('moderation-set');
  await seedPublishedRulesProjection('moderation-set');
  const admin = actorFirestore('admin');
  const owner = actorFirestore('owner');

  await assertFails(updateDoc(doc(admin, 'published_quiz_sets/moderation-set'), {
    status: 'moderated', moderationStatus: 'moderated', updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(admin, 'published_quiz_audits/moderation-set'), {
    publicationId: 'moderation-set', revision: 'rev-1', status: 'moderated',
    moderatedByUid: actors.admin.uid, moderationReason: '독립 감사 위조',
    moderatedAt: serverTimestamp()
  }));

  const store = emulatorStore(admin);
  const moderated = await store.adminModeratePublishedQuiz(
    'moderation-set', 'rev-1', '저작권 확인 필요', requestAdminIdentity
  );
  assert.equal(moderated.status, 'moderated');
  await assertFails(getDoc(doc(owner, 'published_quiz_audits/moderation-set')));
  await assertFails(getDocs(collection(owner, 'published_quiz_audits')));
  await assertSucceeds(getDoc(doc(admin, 'published_quiz_audits/moderation-set')));
  await assertSucceeds(getDocs(collection(admin, 'published_quiz_audits')));
  await assertFails(getDoc(doc(actorFirestore('otherTeacher'),
    'published_quiz_sets/moderation-set')));

  await assertFails(updateDoc(doc(admin, 'published_quiz_sets/moderation-set'), {
    status: 'published', moderationStatus: 'clear', updatedAt: serverTimestamp()
  }));
  const restoreCas = writeBatch(admin);
  restoreCas.update(doc(admin, 'quiz_sets/moderation-set'), { contentRevision: 'rev-2' });
  restoreCas.update(doc(admin, 'published_quiz_sets/moderation-set'), {
    status: 'published', moderationStatus: 'clear', updatedAt: serverTimestamp()
  });
  restoreCas.update(doc(admin, 'published_quiz_audits/moderation-set'), {
    status: 'restored', restoredByUid: actors.admin.uid, restoredAt: serverTimestamp()
  });
  await assertFails(restoreCas.commit());
  const restored = await store.adminRestorePublishedQuiz(
    'moderation-set', 'rev-1', requestAdminIdentity
  );
  assert.equal(restored.status, 'published');
  assert.equal((await getDoc(doc(admin, 'published_quiz_audits/moderation-set')))
    .data().status, 'restored');

  const remoderated = await store.adminModeratePublishedQuiz(
    'moderation-set', 'rev-1', '재검토 필요', requestAdminIdentity
  );
  assert.equal(remoderated.status, 'moderated');
  const rerestored = await store.adminRestorePublishedQuiz(
    'moderation-set', 'rev-1', requestAdminIdentity
  );
  assert.equal(rerestored.status, 'published');

  await assertFails(updateDoc(doc(admin, 'published_quiz_audits/moderation-set'), {
    restoredByUid: actors.owner.uid,
    restoredAt: serverTimestamp()
  }));
});

rulesTest('published projection copy uses exact provenance count-zero increments and final delete sentinels', async () => {
  const image = 'data:image/png;base64,AAAA';
  await seedPublicRulesSource('copy-source', { imageCount: 1 }, { v0q0: image });
  await seedPublishedRulesProjection('copy-source', {}, { v0q0: image });
  const other = actorFirestore('otherTeacher');
  const copyActor = {
    ...actors.otherTeacher,
    displayName: '다른 교사',
    role: 'teacher'
  };
  const store = emulatorStore(other);

  const copied = await store.copyPublishedQuizSet('copy-source', 'copy-destination', copyActor);
  assert.equal(copied.lifecycleState, 'active');
  const storedCopy = (await getDoc(doc(other, 'quiz_sets/copy-destination'))).data();
  assert.equal(storedCopy.imageCount, 1);
  assert.equal(storedCopy.copyStatus, undefined);
  assert.equal(storedCopy.publicationId, 'copy-source');

  const manualRef = doc(other, 'quiz_sets/manual-copy');
  await assertSucceeds(setDoc(manualRef, publicCopyStart('copy-source')));
  await assertFails(updateDoc(manualRef, {
    imageCount: 1,
    imageMutation: { key: 'v0q0', action: 'add' },
    updatedAt: serverTimestamp(),
    contentRevision: serverTimestamp()
  }));
  await assertFails(setDoc(doc(other, 'images/manual-copy/q/v0q0'), { data: image }));

  const wrongTarget = writeBatch(other);
  wrongTarget.set(manualRef, {
    imageCount: 1,
    imageMutation: { key: 'v0q0', action: 'add' },
    updatedAt: serverTimestamp(),
    contentRevision: serverTimestamp()
  }, { merge: true });
  wrongTarget.set(doc(other, 'images/manual-copy/q/v0q1'), { data: image });
  await assertFails(wrongTarget.commit());

  const exactIncrement = writeBatch(other);
  exactIncrement.set(manualRef, {
    imageCount: 1,
    imageMutation: { key: 'v0q0', action: 'add' },
    updatedAt: serverTimestamp(),
    contentRevision: serverTimestamp()
  }, { merge: true });
  exactIncrement.set(doc(other, 'images/manual-copy/q/v0q0'), { data: image });
  await assertSucceeds(exactIncrement.commit());
  await assertSucceeds(updateDoc(manualRef, {
    lifecycleState: 'active',
    copyStatus: deleteField(),
    imageMutation: deleteField(),
    updatedAt: serverTimestamp(),
    contentRevision: serverTimestamp()
  }));

  await assertFails(setDoc(doc(other, 'quiz_sets/nonzero-copy'), publicCopyStart(
    'copy-source', actors.otherTeacher, { imageCount: 1 }
  )));
  await assertFails(setDoc(doc(other, 'quiz_sets/forged-copy'), publicCopyStart(
    'copy-source', actors.otherTeacher, { sourcePublicationRevision: 'forged' }
  )));

  const owner = actorFirestore('owner');
  const visibilityCas = writeBatch(owner);
  visibilityCas.update(doc(owner, 'published_quiz_sets/copy-source'), {
    status: 'withdrawn', updatedAt: serverTimestamp()
  });
  visibilityCas.set(doc(owner, 'quiz_sets/copy-cas-destination'),
    publicCopyStart('copy-source', actors.owner));
  await assertFails(visibilityCas.commit());

  await adminWrite('published_quiz_sets/copy-source', publicRulesProjection(
    'copy-source', { imageCount: 1, status: 'withdrawn' }
  ));
  await assertFails(setDoc(doc(other, 'quiz_sets/hidden-copy'), publicCopyStart('copy-source')));
  await adminWrite('published_quiz_sets/copy-source', publicRulesProjection(
    'copy-source', { imageCount: 1 }
  ));

  await adminWrite('quiz_sets/copy-source', publicRulesSource({
    imageCount: 1, lifecycleState: 'trashed', trashedAt: Timestamp.fromMillis(1)
  }));
  await assertFails(setDoc(doc(other, 'quiz_sets/trashed-source-copy'),
    publicCopyStart('copy-source')));
  await adminWrite('quiz_sets/copy-source', publicRulesSource({ imageCount: 1 }));

  const ownerAllowance = await adminRead('teacher_allowances/owner-uid');
  for (const status of ['suspended', 'deletion_pending']) {
    await adminWrite('teacher_allowances/owner-uid', {
      ...ownerAllowance,
      status,
      enabled: false,
      administrativeHold: status === 'suspended'
    });
    await assertFails(setDoc(doc(other, `quiz_sets/${status}-source-copy`),
      publicCopyStart('copy-source')));
  }
  await adminWrite('teacher_allowances/owner-uid', {
    ...ownerAllowance,
    role: 'owner'
  });
  await assertFails(setDoc(doc(other, 'quiz_sets/invalid-role-source-copy'),
    publicCopyStart('copy-source')));
  await adminWrite('teacher_allowances/owner-uid', ownerAllowance);

  const studentOwner = { uid: actors.student.uid, email: 'student@school.kr' };
  await assertFails(setDoc(doc(actorFirestore('student'), 'quiz_sets/student-copy'),
    publicCopyStart('copy-source', studentOwner)));
});

rulesTest('admin만 승인 교사 목록을 감사 필드와 함께 관리하고 자기 admin은 보호한다', async () => {
  await resetFirestore();
  const admin = actorFirestore('admin');
  await assertSucceeds(getDoc(doc(admin, 'teacher_allowlist/admin@school.kr')));
  await assertSucceeds(getDocs(collection(admin, 'teacher_allowlist')));
  await assertSucceeds(setDoc(doc(admin, 'teacher_allowlist/new@school.kr'), {
    enabled: true,
    role: 'teacher',
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));
  await assertSucceeds(updateDoc(doc(admin, 'teacher_allowlist/new@school.kr'), {
    enabled: false,
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));
  await assertFails(setDoc(doc(admin, 'teacher_allowlist/bad-role@school.kr'), {
    enabled: true,
    role: 'owner',
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));
  await assertFails(setDoc(doc(admin, 'teacher_allowlist/extra@school.kr'), {
    enabled: true,
    role: 'teacher',
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid',
    extra: true
  }));
  await assertFails(setDoc(doc(admin, 'teacher_allowlist/mismatch@school.kr'), {
    enabled: true,
    role: 'teacher',
    updatedAt: serverTimestamp(),
    updatedByUid: 'other-uid'
  }));
  await assertFails(updateDoc(doc(admin, 'teacher_allowlist/admin@school.kr'), {
    enabled: false,
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));
  await assertFails(updateDoc(doc(admin, 'teacher_allowlist/admin@school.kr'), {
    role: 'teacher',
    updatedAt: serverTimestamp(),
    updatedByUid: 'admin-uid'
  }));
  await assertFails(deleteDoc(doc(admin, 'teacher_allowlist/new@school.kr')));
  await assertFails(setDoc(doc(actorFirestore('owner'), 'teacher_allowlist/blocked@school.kr'), {
    enabled: true, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: 'owner-uid'
  }));
});

rulesTest('승인 문서 ID는 소문자 canonical 이메일 경로만 허용한다', async () => {
  await resetFirestore();
  const admin = actorFirestore('admin');
  const audited = { enabled: true, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: 'admin-uid' };
  await assertFails(setDoc(doc(admin, 'teacher_allowlist/Mixed@School.KR'), audited));
  await assertFails(setDoc(doc(admin, 'teacher_allowlist/not-an-email'), audited));
  await assertSucceeds(setDoc(doc(admin, 'teacher_allowlist/canonical@school.kr'), audited));
});

rulesTest('비활성화된 다른 admin은 후속 승인 목록 쓰기를 할 수 없다', async () => {
  await resetFirestore();
  const admin = actorFirestore('admin');
  await assertSucceeds(setDoc(doc(admin, 'teacher_allowlist/other-admin@school.kr'), {
    enabled: true, role: 'admin', updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  }));
  await assertSucceeds(updateDoc(doc(admin, 'teacher_allowlist/other-admin@school.kr'), {
    enabled: false, updatedAt: serverTimestamp(), updatedByUid: 'admin-uid'
  }));
  const disabledAdmin = testEnvironment.authenticatedContext('other-admin-uid', {
    email: 'other-admin@school.kr',
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' }
  }).firestore();
  await assertFails(setDoc(doc(disabledAdmin, 'teacher_allowlist/blocked-after-disable@school.kr'), {
    enabled: true, role: 'teacher', updatedAt: serverTimestamp(), updatedByUid: 'other-admin-uid'
  }));
  await assertFails(updateDoc(doc(disabledAdmin, 'teacher_allowlist/owner@school.kr'), {
    enabled: false, updatedAt: serverTimestamp(), updatedByUid: 'other-admin-uid'
  }));
});

rulesTest('authoritative verified password teacher and admin keep representative list write and admin access', async () => {
  const passwordTeacher = testEnvironment.authenticatedContext('owner-uid', {
    email: 'owner@school.kr',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();
  const passwordAdmin = testEnvironment.authenticatedContext('admin-uid', {
    email: 'admin@school.kr',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  await assertSucceeds(getDoc(doc(passwordTeacher, 'quiz_sets/set1')));
  await assertSucceeds(getDocs(query(
    collection(passwordTeacher, 'quiz_sets'),
    where('lifecycleState', '==', 'active'),
    where('ownerUid', '==', actors.owner.uid)
  )));
  await assertSucceeds(updateDoc(doc(passwordTeacher, 'quiz_sets/set1'), {
    title: 'password owner update'
  }));
  await assertSucceeds(getDocs(query(
    collection(passwordAdmin, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(50)
  )));
});

rulesTest('unverified password, unsupported providers, missing provider, and mismatched allowance remain denied', async () => {
  const verifiedOwnerEmail = {
    email: 'owner@school.kr',
    email_verified: true
  };
  const deniedActors = [
    ['unverified password', 'owner-uid', {
      ...verifiedOwnerEmail,
      email_verified: false,
      firebase: { sign_in_provider: 'password' }
    }],
    ['custom provider', 'owner-uid', {
      ...verifiedOwnerEmail,
      firebase: { sign_in_provider: 'custom' }
    }],
    ['anonymous provider', 'owner-uid', {
      ...verifiedOwnerEmail,
      firebase: { sign_in_provider: 'anonymous' }
    }],
    ['phone provider', 'owner-uid', {
      ...verifiedOwnerEmail,
      firebase: { sign_in_provider: 'phone' }
    }],
    ['missing provider', 'owner-uid', {
      ...verifiedOwnerEmail,
      firebase: {}
    }],
    ['wrong allowance UID', 'other-teacher-uid', {
      ...verifiedOwnerEmail,
      firebase: { sign_in_provider: 'password' }
    }]
  ];

  for (const [label, uid, claims] of deniedActors) {
    const db = testEnvironment.authenticatedContext(uid, claims).firestore();
    await assertFails(getDoc(doc(db, 'quiz_sets/set1'))).catch(error => {
      throw new Error(`${label}: ${error.message}`, { cause: error });
    });
  }
});

rulesTest('stored authoritative allowance UID mismatch denies the matching-path password user', async () => {
  await adminWrite('teacher_allowances/owner-uid', {
    ...(await adminRead('teacher_allowances/owner-uid')),
    uid: 'different-stored-uid'
  });
  const passwordOwner = testEnvironment.authenticatedContext('owner-uid', {
    email: 'owner@school.kr',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  await assertFails(getDoc(doc(passwordOwner, 'quiz_sets/set1')));
});

rulesTest('migration-incomplete legacy teacher and admin fallback is Google-only and denies password', async () => {
  await adminWrite('teacher_allowlist/password@school.kr', { enabled: true, role: 'teacher' });
  await adminWrite('teacher_allowlist/password-admin@school.kr', { enabled: true, role: 'admin' });
  await adminWrite('teacher_allowlist/unverified@school.kr', { enabled: true, role: 'teacher' });
  await adminWrite('teacher_allowlist/disabled@school.kr', { enabled: false, role: 'admin' });
  await adminWrite('teacher_allowlist/invalid@school.kr', { enabled: true, role: 'owner' });

  const passwordTeacher = testEnvironment.authenticatedContext('password-uid', {
    email: 'password@school.kr',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();
  const passwordAdmin = testEnvironment.authenticatedContext('password-admin-uid', {
    email: 'password-admin@school.kr',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();
  await assertFails(getDoc(doc(passwordTeacher, 'quiz_sets/set1')));
  await assertFails(getDocs(query(
    collection(passwordAdmin, 'teacher_access_requests'),
    where('status', '==', 'pending'),
    queryLimit(50)
  )));

  const deniedContexts = [
    testEnvironment.authenticatedContext('unverified-uid', {
      email: 'unverified@school.kr',
      email_verified: false,
      firebase: { sign_in_provider: 'google.com' }
    }).firestore(),
    googleContext('disabled-uid', 'disabled@school.kr'),
    googleContext('invalid-uid', 'invalid@school.kr')
  ];

  for (const db of deniedContexts) {
    await assertFails(getDoc(doc(db, 'quiz_sets/set1')));
  }
});

rulesTest('세션 스냅샷·비공개 이미지는 학생에게 닫고 소유 교사와 admin에게만 연다', async () => {
  for (const path of ['sessions/s1/snapshot/set', 'sessions/s1/snapshot_images/0']) {
    await assertSucceeds(getDoc(doc(actorFirestore('owner'), path)));
    await assertSucceeds(getDoc(doc(actorFirestore('admin'), path)));
    await assertFails(getDoc(doc(actorFirestore('otherTeacher'), path)));
    await assertFails(getDoc(doc(actorFirestore('student'), path)));
  }
});

rulesTest('clock과 알 수 없는 경로도 소유 범위 또는 기본 거부를 벗어나지 않는다', async () => {
  const student = actorFirestore('student');
  const owner = actorFirestore('owner');
  await assertSucceeds(setDoc(doc(student, 'clock/student-uid-sample'), { at: 1 }));
  await assertSucceeds(getDoc(doc(student, 'clock/student-uid-sample')));
  await assertFails(getDoc(doc(owner, 'clock/student-uid-sample')));
  await assertFails(setDoc(doc(student, 'unknown/path'), { open: true }));
  await assertFails(getDoc(doc(student, 'unknown/path')));
});

rulesTest('guest capability는 정확한 활성 share revision만 읽고 private 원본은 읽지 못한다', async () => {
  await adminWrite('guest_quiz_shares/share-a', {
    shareId: 'share-a', sourceSetId: 'set1', sourceOwnerUid: 'owner-uid',
    sourceContentRevision: '3', status: 'active', tokenHash: 'a'.repeat(64), revision: 2,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2), revokedAt: null
  });
  await adminWrite('guest_quiz_shares/share-a/revisions/2', {
    shareId: 'share-a', revision: 2, sourceContentRevision: '3', status: 'ready',
    title: '공유 세트', description: '', revealMode: 'manual', limitSec: 20,
    revealDelaySec: 0, autoPause: true, videoCount: 1, questionCount: 1,
    imageCount: 0, schemaVersion: 1, createdAt: Timestamp.fromMillis(2)
  });
  const guest = guestFirestore('guest-a');
  await assertSucceeds(getDoc(doc(guest, 'guest_quiz_shares/share-a/revisions/2')));
  await assertFails(getDoc(doc(guest, 'guest_quiz_shares/share-a')));
  await assertFails(getDoc(doc(guest, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(guestFirestore('guest-a', 'share-b'),
    'guest_quiz_shares/share-a/revisions/2')));
  await assertFails(getDoc(doc(guestFirestore('guest-a', 'share-a', 1),
    'guest_quiz_shares/share-a/revisions/2')));
  await assertFails(getDoc(doc(guestFirestore('guest-a', 'share-a', 2, -1),
    'guest_quiz_shares/share-a/revisions/2')));
});

rulesTest('같은 share의 두 guest session은 UID별로 생성·조회가 격리된다', async () => {
  await adminWrite('guest_quiz_shares/share-a', {
    shareId: 'share-a', sourceSetId: 'set1', sourceOwnerUid: 'owner-uid',
    sourceContentRevision: '3', status: 'active', tokenHash: 'a'.repeat(64), revision: 2,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2), revokedAt: null
  });
  await adminWrite('guest_quiz_shares/share-a/revisions/2', {
    shareId: 'share-a', revision: 2, sourceContentRevision: '3', status: 'ready',
    title: '공유 세트', description: '', revealMode: 'manual', limitSec: 20,
    revealDelaySec: 0, autoPause: true, videoCount: 1, questionCount: 1,
    imageCount: 0, schemaVersion: 1, createdAt: Timestamp.fromMillis(2)
  });
  const guestA = guestFirestore('guest-a');
  const guestB = guestFirestore('guest-b');
  const session = {
    teacherUid: 'guest-a', teacherEmail: '', sessionActorType: 'guest',
    sourceShareId: 'share-a', sourceSetId: 'set1', sourceRevision: 2,
    sourceOwnerUid: 'owner-uid', status: 'allocating', registeredStudentCount: 0,
    studentCountRevision: 0, createdAt: Timestamp.fromMillis(2)
  };
  await assertSucceeds(setDoc(doc(guestA, 'sessions/guest-session-a'), session));
  await assertSucceeds(getDoc(doc(guestA, 'sessions/guest-session-a')));
  await assertFails(getDoc(doc(guestB, 'sessions/guest-session-a')));
  await assertSucceeds(getDoc(doc(actorFirestore('owner'), 'sessions/guest-session-a')));
  await assertFails(getDoc(doc(actorFirestore('otherTeacher'), 'sessions/guest-session-a')));
  await assertFails(setDoc(doc(guestB, 'sessions/guest-session-b'), { ...session, teacherUid: 'guest-a' }));
});

rulesTest('revoked share는 새 guest session 생성을 막지만 이미 만든 session 읽기는 UID에 묶인다', async () => {
  await adminWrite('guest_quiz_shares/share-a', {
    shareId: 'share-a', sourceSetId: 'set1', sourceOwnerUid: 'owner-uid',
    sourceContentRevision: '3', status: 'revoked', tokenHash: 'a'.repeat(64), revision: 2,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2),
    revokedAt: Timestamp.fromMillis(2)
  });
  await adminWrite('sessions/guest-existing', {
    teacherUid: 'guest-a', teacherEmail: '', sessionActorType: 'guest',
    sourceShareId: 'share-a', sourceSetId: 'set1', sourceRevision: 2,
    sourceOwnerUid: 'owner-uid', status: 'live', registeredStudentCount: 0,
    studentCountRevision: 0, activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60000)
  });
  const guest = guestFirestore('guest-a');
  await assertSucceeds(getDoc(doc(guest, 'sessions/guest-existing')));
  await assertFails(setDoc(doc(guest, 'sessions/guest-new'), {
    teacherUid: 'guest-a', teacherEmail: '', sessionActorType: 'guest',
    sourceShareId: 'share-a', sourceSetId: 'set1', sourceRevision: 2,
    sourceOwnerUid: 'owner-uid', status: 'allocating', registeredStudentCount: 0,
    studentCountRevision: 0
  }));
});
