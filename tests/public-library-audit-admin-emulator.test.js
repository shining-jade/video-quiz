'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const emulatorTest = emulatorHost ? test : test.skip;

emulatorTest('Admin auditor scans a bounded real Emulator graph without writes', async () => {
  assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):\d+$/);
  const projectId = process.env.GCLOUD_PROJECT || 'demo-video-quiz';
  assert.match(projectId, /^demo-/);
  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const Core = require('../public-quiz-library-core.js');
  const { auditPublicLibrary } = require('../public-library-audit.js');
  const app = initializeApp({ projectId }, 'public-library-audit-' + process.pid);
  const db = getFirestore(app);

  async function clearDemoFirestore() {
    assert.match(projectId, /^demo-/);
    for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
  }

  try {
    await clearDemoFirestore();
    const source = {
      title: '감사 세트', description: '', ownerUid: 'owner', ownerEmail: 'owner@school.kr',
      lifecycleState: 'active', trashedAt: null, purgeStartedAt: null,
      collaboratorCount: 0, imageCount: 0, contentRevision: 'rev-1',
      settings: { revealMode: 'timer', limitSec: 20, revealDelaySec: 5, autoPause: true },
      videos: [{
        videoId: 'dQw4w9WgXcQ', videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
        startSec: 0, endSec: 100,
        questions: [{ type: 'choice', t: 10, text: '답?', choices: ['A', 'B'], answer: 0 }]
      }]
    };
    const projection = Core.buildProjection(source, {
      setId: 'set-1', authorDisplayName: '홍교사', revision: 'rev-1', nowMs: 1000
    });
    projection.status = 'published';
    projection.publishedAt = Timestamp.fromMillis(900);
    projection.updatedAt = Timestamp.fromMillis(1000);
    const flat = Core.flattenProjection(projection, 'audit-build-token');
    await Promise.all([
      db.doc('quiz_sets/set-1').set(source),
      db.doc('teacher_allowances/owner').set({
        uid: 'owner', emailCanonical: 'owner@school.kr', status: 'active',
        enabled: true, role: 'teacher', displayName: '홍교사'
      }),
      db.doc('published_quiz_sets/set-1').set(flat.parent),
      db.doc('published_quiz_sets/set-1/videos/v0').set(flat.videos.v0),
      db.doc('published_quiz_sets/set-1/questions/v0q0').set(flat.questions.v0q0)
    ]);

    const clean = await auditPublicLibrary({ db, maxDocuments: 100 });
    assert.equal(clean.safeToDeployPublicLibrary, true);
    assert.equal(clean.scanned.parents, 1);

    await db.doc('published_quiz_sets/orphan/images/v0q0').set({
      data: 'data:image/png;base64,AAAA', revision: 'rev-1',
      buildToken: 'token', reviewerEmail: 'private@school.kr'
    });
    const unsafe = await auditPublicLibrary({ db, maxDocuments: 100 });
    assert.equal(unsafe.safeToDeployPublicLibrary, false);
    assert.ok(unsafe.findings.some(item => item.code === 'ORPHAN_PUBLIC_CHILD'));
    assert.ok(unsafe.findings.some(item => item.code === 'PUBLIC_PII_KEY'));
  } finally {
    await clearDemoFirestore();
    await deleteApp(app);
  }
});
