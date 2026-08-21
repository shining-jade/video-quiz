const test = require('node:test');
const assert = require('node:assert/strict');

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const emulatorTest = emulatorHost ? test : test.skip;

emulatorTest('Firebase Admin operator dry-runs then atomically migrates only the local demo project', async () => {
  assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):\d+$/);
  const projectId = process.env.GCLOUD_PROJECT || 'demo-video-quiz';
  assert.match(projectId, /^demo-/, 'Admin migration tests must never use a production project ID');

  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const migration = require('../legacy-migration-admin.js');
  const app = initializeApp({ projectId }, 'legacy-migration-emulator-' + process.pid);
  const db = getFirestore(app);
  const auth = {
    async getUser(uid) {
      assert.equal(uid, 'teacher-uid');
      return {
        uid,
        email: 'owner@school.kr',
        emailVerified: true,
        providerData: [{ providerId: 'google.com', email: 'owner@school.kr' }]
      };
    }
  };

  async function clearDemoFirestore() {
    assert.match(projectId, /^demo-/);
    const collections = await db.listCollections();
    for (const collection of collections) await db.recursiveDelete(collection);
  }

  try {
    await clearDemoFirestore();
    await db.doc('teacher_allowlist/owner@school.kr').set({ enabled: true, role: 'teacher' });
    const provisioned = await migration.runLegacyMigration({
      db, auth, projectId, ownerUid: 'teacher-uid', apply: true, confirmProject: projectId,
      provisionOwnerEmail: 'owner@school.kr', targetMode: 'emulator'
    });
    assert.equal(provisioned.ownerConfigAction, 'created');
    assert.deepEqual((await db.doc('config/legacy_owner').get()).data(), {
      uid: 'teacher-uid', email: 'owner@school.kr'
    });

    await Promise.all([
      db.doc('quiz_sets/legacy-set').set({ title: 'Legacy' }),
      db.doc('sessions/legacy-session').set({ setId: 'legacy-set', status: 'ended' }),
      db.doc('sessions/legacy-session/responses/student-1').set({
        uid: 'student-1',
        answers: { 0: { answer: 1, submitted: true, revision: 4, ok: true, score: 1 } }
      })
    ]);

    const dryRun = await migration.runLegacyMigration({
      db, auth, projectId, ownerUid: 'teacher-uid'
    });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.safeToDeployStrictRules, false);
    assert.equal((await db.doc('quiz_sets/legacy-set').get()).data().ownerUid, undefined);

    const applied = await migration.runLegacyMigration({
      db, auth, projectId, ownerUid: 'teacher-uid',
      apply: true, confirmProject: projectId
    });
    const response = (await db.doc('sessions/legacy-session/responses/student-1').get()).data();
    const grade = (await db.doc('sessions/legacy-session/grades/student-1__0').get()).data();
    assert.deepEqual(response, {
      uid: 'student-1', answers: { 0: { answer: 1, submitted: true, revision: 4 } }
    });
    assert.deepEqual(grade, {
      uid: 'student-1', questionIndex: 0, revision: 4, ok: true
    });
    assert.equal(applied.safeToDeployStrictRules, true);
    assert.equal(applied.remainingResponseLeakCount, 0);
    assert.deepEqual(applied.auditFailures, []);

    const retry = await migration.runLegacyMigration({
      db, auth, projectId, ownerUid: 'teacher-uid',
      apply: true, confirmProject: projectId
    });
    assert.equal(retry.safeToDeployStrictRules, true);
    assert.equal(retry.categories.responses.skipped.ids.includes('legacy-session/student-1'), true);
    assert.equal(retry.categories.grades.skipped.ids.includes('legacy-session/student-1__0'), true);

    const removed = await migration.removeLegacyOwner({
      db, auth, projectId, ownerUid: 'teacher-uid', apply: true,
      confirmProject: projectId, targetMode: 'emulator'
    });
    assert.equal(removed.action, 'removed');
    assert.equal(removed.migrationAudit.safeToDeployStrictRules, true);
    assert.equal(removed.postRemovalAudit.safeToDeployStrictRules, true);
    assert.equal(removed.ownerConfigAbsent, true);
    assert.equal((await db.doc('config/legacy_owner').get()).exists, false);
  } finally {
    await clearDemoFirestore();
    await deleteApp(app);
  }
});

emulatorTest('Firebase Admin collaborator share migration backfills legacy pairs and audits repair state', async () => {
  assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):\d+$/);
  const projectId = process.env.GCLOUD_PROJECT || 'demo-video-quiz';
  assert.match(projectId, /^demo-/, 'Admin migration tests must never use a production project ID');

  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const migration = require('../collaborator-share-migration.js');
  const app = initializeApp({ projectId }, 'collaborator-share-emulator-' + process.pid);
  const db = getFirestore(app);

  async function clearDemoFirestore() {
    assert.match(projectId, /^demo-/);
    const collections = await db.listCollections();
    for (const collection of collections) await db.recursiveDelete(collection);
  }

  const collaborator = email => ({
    email,
    addedByUid: 'owner-uid',
    addedAt: Timestamp.fromMillis(1)
  });

  try {
    await clearDemoFirestore();
    await Promise.all([
      db.doc('quiz_sets/legacy').set({ ownerUid: 'owner-uid', lifecycleState: 'active' }),
      db.doc('quiz_sets/legacy/collaborators/teacher@school.kr')
        .set(collaborator('teacher@school.kr')),
      db.doc('quiz_sets/repair').set({ ownerUid: 'owner-uid', lifecycleState: 'trashed' }),
      db.doc('quiz_sets/repair/collaborators/editor@school.kr')
        .set(collaborator('editor@school.kr')),
      db.doc('quiz_set_shares/editor@school.kr/sets/repair').set({
        email: 'editor@school.kr', setId: 'repair', reviewerEmail: 'private@school.kr'
      }),
      db.doc('quiz_set_shares/stale@school.kr/sets/missing-child').set({
        email: 'stale@school.kr', setId: 'missing-child', reviewerEmail: 'private@school.kr'
      })
    ]);

    const dryRun = await migration.runCollaboratorShareMigration({
      db, projectId, targetMode: 'emulator'
    });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.plannedUpsertCount, 2);
    assert.equal(dryRun.plannedDeleteCount, 1);
    assert.equal(dryRun.safeToUseShareIndex, false);
    assert.equal((await db.doc('quiz_set_shares/teacher@school.kr/sets/legacy').get()).exists,
      false);

    const applied = await migration.runCollaboratorShareMigration({
      db,
      projectId,
      targetMode: 'emulator',
      apply: true,
      confirmProject: projectId
    });
    assert.equal(applied.appliedUpsertCount, 2);
    assert.equal(applied.appliedDeleteCount, 1);
    assert.equal(applied.safeToUseShareIndex, true);
    assert.deepEqual((await db.doc(
      'quiz_set_shares/teacher@school.kr/sets/legacy'
    ).get()).data(), { email: 'teacher@school.kr', setId: 'legacy' });
    assert.deepEqual((await db.doc(
      'quiz_set_shares/editor@school.kr/sets/repair'
    ).get()).data(), { email: 'editor@school.kr', setId: 'repair' });
    assert.equal((await db.doc(
      'quiz_set_shares/stale@school.kr/sets/missing-child'
    ).get()).exists, false);

    const retry = await migration.runCollaboratorShareMigration({
      db,
      projectId,
      targetMode: 'emulator',
      apply: true,
      confirmProject: projectId
    });
    assert.equal(retry.plannedUpsertCount, 0);
    assert.equal(retry.plannedDeleteCount, 0);
    assert.equal(retry.safeToUseShareIndex, true);

    await db.doc('quiz_sets/orphan/collaborators/orphan@school.kr')
      .set(collaborator('orphan@school.kr'));
    const orphanAudit = await migration.runCollaboratorShareMigration({
      db, projectId, targetMode: 'emulator'
    });
    assert.equal(orphanAudit.audit.orphanCollaboratorCount, 1);
    assert.equal(orphanAudit.safeToUseShareIndex, false);
    assert.equal((await db.doc(
      'quiz_set_shares/orphan@school.kr/sets/orphan'
    ).get()).exists, false);
    assert.equal(JSON.stringify(orphanAudit).includes('private@school.kr'), false);
  } finally {
    await clearDemoFirestore();
    await deleteApp(app);
  }
});
