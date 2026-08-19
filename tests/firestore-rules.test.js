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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
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

async function adminWrite(path, value) {
  await testEnvironment.withSecurityRulesDisabled(async context => {
    const reference = doc(context.firestore(), path);
    if (value === undefined) await deleteDoc(reference);
    else await setDoc(reference, value);
  });
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
      return {
        path,
        async get() {
          const snapshot = await getDocs(modularCollection);
          return {
            docs: snapshot.docs.map(document => ({
              id: document.id,
              ref: reference(`${path}/${document.id}`),
              data: () => document.data()
            }))
          };
        }
      };
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
    { serverTimestamp, delete() { throw new Error('not used'); } },
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
      setDoc(doc(db, 'quiz_sets/set1'), {
        ownerUid: 'owner-uid',
        ownerEmail: 'owner@school.kr',
        title: '보안 규칙 테스트'
      }),
      setDoc(doc(db, 'quiz_sets/set2'), {
        ownerUid: 'other-teacher-uid',
        ownerEmail: 'other@school.kr',
        title: '다른 교사 세트'
      }),
      setDoc(doc(db, 'images/set1/q/0'), { data: 'owner-image' }),
      setDoc(doc(db, 'codes/ABC123'), { sessionId: 's1' }),
      setDoc(doc(db, 'codes/OTHER1'), { sessionId: 's2' }),
      setDoc(doc(db, 'sessions/s1'), {
        teacherUid: 'owner-uid',
        teacherEmail: 'owner@school.kr',
        status: 'live',
        activationLeaseUntil: Timestamp.fromMillis(Date.now() + 15_000)
      }),
      setDoc(doc(db, 'sessions/s2'), {
        teacherUid: 'other-teacher-uid',
        teacherEmail: 'other@school.kr',
        status: 'live',
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

rulesTest('승인 교사는 공유 원본과 이미지를 읽어 자기 소유 사본을 트랜잭션으로 만든다', async () => {
  const teacher = actorFirestore('otherTeacher');
  const sourceReference = doc(teacher, 'quiz_sets/set1');
  const before = await assertSucceeds(getDoc(sourceReference));
  const images = await assertSucceeds(getDocs(collection(teacher, 'images/set1/q')));

  await assertSucceeds(runTransaction(teacher, async transaction => {
    const current = await transaction.get(sourceReference);
    assert.deepEqual(current.data(), before.data());
    transaction.set(doc(teacher, 'quiz_sets/copied-by-other'), {
      ...current.data(),
      ownerUid: actors.otherTeacher.uid,
      ownerEmail: actors.otherTeacher.email,
      title: '공유 사본',
      contentRevision: serverTimestamp()
    });
    images.forEach(image => {
      transaction.set(doc(teacher, `images/copied-by-other/q/${image.id}`), image.data());
    });
  }));

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

rulesTest('부모 contentRevision을 바꾸는 공식 batch는 이미지 create·update·delete를 함께 허용한다', async () => {
  await adminWrite('images/set1/q/delete-me', { data: 'old-delete' });
  const owner = actorFirestore('owner');
  const batch = writeBatch(owner);
  batch.set(doc(owner, 'quiz_sets/set1'), { contentRevision: serverTimestamp() }, { merge: true });
  batch.set(doc(owner, 'images/set1/q/new'), { data: 'batch-create' });
  batch.set(doc(owner, 'images/set1/q/0'), { data: 'batch-update' });
  batch.delete(doc(owner, 'images/set1/q/delete-me'));

  await assertSucceeds(batch.commit());
  assert.equal((await getDoc(doc(owner, 'images/set1/q/new'))).data().data, 'batch-create');
  assert.equal((await getDoc(doc(owner, 'images/set1/q/0'))).data().data, 'batch-update');
  assert.equal((await getDoc(doc(owner, 'images/set1/q/delete-me'))).exists(), false);
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
      teacherEmail: actors.owner.email, status: 'aborted'
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
      teacherEmail: actors.owner.email, status: 'allocating'
    });
    await adminWrite('sessions/new-allocation', {
      code: 'REASN2', setId: 'set1', teacherUid: actors.owner.uid,
      teacherEmail: actors.owner.email, status: 'live'
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

rulesTest('stale activation과 heartbeat는 server-time lease 밖에서 학생 접근을 자동 차단한다', async () => {
  const token = 'lease-token-1234567890';
  let synchronizedNow = Date.now();
  const activationLeaseUntil = synchronizedNow + 15_000;
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
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000)
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
    activationLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000)
  }));

  let reachedRenewRead;
  let releaseRenewRead;
  const atRenewRead = new Promise(resolve => { reachedRenewRead = resolve; });
  const releaseRenew = new Promise(resolve => { releaseRenewRead = resolve; });
  synchronizedNow = Date.now();
  const renewedLeaseUntil = synchronizedNow + 15_000;
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

rulesTest('fix-round-4: ended live projection은 같은 atomic parent 종료에서만 쓸 수 있다', async t => {
  const safeEndedLive = {
    q: -1,
    openedAt: 0,
    revealed: false,
    limitSec: 0,
    status: 'ended'
  };

  await t.test('parent-only 종료는 유지되지만 뒤이은 live-only ended 쓰기를 허용하지 않는다', async () => {
    await resetFirestore();
    const owner = actorFirestore('owner');
    const sessionReference = doc(owner, 'sessions/s1');
    const liveReference = doc(owner, 'sessions/s1/meta/live');

    await assertSucceeds(updateDoc(sessionReference, {
      status: 'ended',
      endedAt: serverTimestamp()
    }));
    assert.equal((await getDoc(liveReference)).data().q, 0);
    await assertFails(setDoc(liveReference, safeEndedLive));
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
  await assertSucceeds(setDoc(studentReference, {
    uid: 'joining-student-uid',
    grade: 1,
    class: 2,
    number: 5,
    name: '신규 학생'
  }));
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
      publicAnswer: { answer: 1, explain: '해설' }
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
    list: db => getDocs(collection(db, 'quiz_sets')),
    get: approvedTeachers,
    listAllowed: approvedTeachers
  },
  {
    name: '이미지',
    getPath: 'images/set1/q/0',
    list: db => getDocs(collection(db, 'images/set1/q')),
    get: approvedTeachers,
    listAllowed: approvedTeachers
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
      title: '새 세트'
    }),
    updateValue: () => ({ title: '변경' }),
    allowed: {
      create: approvedTeachers,
      update: ['owner'],
      delete: ['owner']
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
      activationLeaseUntil: serverTimestamp()
    }),
    updateValue: () => ({ status: 'ended' }),
    allowed: {
      create: approvedTeachers,
      update: ['owner'],
      delete: ['owner', 'admin']
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
    allowed: { create: ['student', 'anonymous'], update: ['student'], delete: ['owner', 'admin'] }
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

rulesTest('승인 문서만으로는 비Google·미검증·비활성 계정에 교사 권한을 주지 않는다', async () => {
  await adminWrite('teacher_allowlist/password@school.kr', { enabled: true, role: 'teacher' });
  await adminWrite('teacher_allowlist/unverified@school.kr', { enabled: true, role: 'teacher' });
  await adminWrite('teacher_allowlist/disabled@school.kr', { enabled: false, role: 'admin' });
  await adminWrite('teacher_allowlist/invalid@school.kr', { enabled: true, role: 'owner' });

  const contexts = [
    testEnvironment.authenticatedContext('password-uid', {
      email: 'password@school.kr',
      email_verified: true,
      firebase: { sign_in_provider: 'password' }
    }).firestore(),
    testEnvironment.authenticatedContext('unverified-uid', {
      email: 'unverified@school.kr',
      email_verified: false,
      firebase: { sign_in_provider: 'google.com' }
    }).firestore(),
    googleContext('disabled-uid', 'disabled@school.kr'),
    googleContext('invalid-uid', 'invalid@school.kr')
  ];

  for (const db of contexts) {
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
