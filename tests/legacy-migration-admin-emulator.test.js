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
    await Promise.all([
      db.doc('config/legacy_owner').set({ uid: 'teacher-uid', email: 'owner@school.kr' }),
      db.doc('teacher_allowlist/owner@school.kr').set({ enabled: true, role: 'teacher' }),
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
  } finally {
    await clearDemoFirestore();
    await deleteApp(app);
  }
});
