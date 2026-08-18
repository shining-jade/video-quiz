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
        status: 'live'
      }),
      setDoc(doc(db, 'sessions/s2'), {
        teacherUid: 'other-teacher-uid',
        teacherEmail: 'other@school.kr',
        status: 'live'
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
      title: '공유 사본'
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

rulesTest('fix-round-1: graded answer can be replaced on reopen, revised, and resubmitted', async () => {
  const student = actorFirestore('student');
  const owner = actorFirestore('owner');
  const own = doc(student, 'sessions/s1/responses/student-uid');
  await adminWrite('sessions/s1/responses/student-uid', undefined);

  await assertSucceeds(setDoc(own, {
    uid: 'student-uid',
    answers: { 0: { answer: 1, submitted: true, revision: 1 } }
  }));
  await assertSucceeds(updateDoc(
    doc(owner, 'sessions/s1/responses/student-uid'),
    { 'answers.0.ok': true }
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
      1: { answer: 2, submitted: true, revision: 1 }
    }
  }));
  await assertFails(updateDoc(own, {
    answers: {
      0: { answer: 1, submitted: true, revision: 1 },
      1: { answer: 2, submitted: true, revision: 1 },
      2: { answer: 3, submitted: true, revision: 1 }
    }
  }));
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
      status: 'live'
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
          answer: 2,
          submitted: true,
          revision: 2,
          submittedAt: Timestamp.fromMillis(2)
        }
      }
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
    listAllowed: ['admin']
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
    allowed: { create: ['owner'], update: ['owner'], delete: ['owner'] }
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
      status: 'live'
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
      ? { answers: { 0: { answer: 2, submitted: true, revision: 2 } } }
      : { answers: { 0: { answer: 1, submitted: true, revision: 1, ok: true } } },
    allowed: {
      create: ['student'],
      update: ['owner', 'admin', 'student'],
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

rulesTest('승인 목록은 모든 클라이언트의 get/list/create/update/delete를 거부한다', async () => {
  for (const actorName of actorNames) {
    await resetFirestore();
    const db = actorFirestore(actorName);
    await assertFails(getDoc(doc(db, 'teacher_allowlist/owner@school.kr')));
    await assertFails(getDocs(collection(db, 'teacher_allowlist')));
    await assertFails(setDoc(doc(db, `teacher_allowlist/new-${actorName}@school.kr`), {
      enabled: true,
      role: 'teacher'
    }));
    await assertFails(updateDoc(doc(db, 'teacher_allowlist/owner@school.kr'), { enabled: false }));
    await assertFails(deleteDoc(doc(db, 'teacher_allowlist/owner@school.kr')));
  }
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
