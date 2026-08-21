'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fakeDb(initial) {
  const documents = new Map(Object.entries(initial));
  const snapshot = fullPath => ({
    id: fullPath.split('/').at(-1),
    exists: documents.has(fullPath),
    ref: { path: fullPath },
    data: () => documents.get(fullPath)
  });
  function query(paths) {
    return {
      limit(count) {
        return { async get() { return { docs: paths.slice(0, count).map(snapshot) }; } };
      }
    };
  }
  return {
    collection(name) {
      return query([...documents.keys()].filter(key =>
        key.startsWith(name + '/') && key.split('/').length === 2
      ).sort());
    },
    collectionGroup(name) {
      return query([...documents.keys()].filter(key => {
        const parts = key.split('/');
        return parts.length >= 4 && parts.at(-2) === name;
      }).sort());
    },
    doc(fullPath) { return { async get() { return snapshot(fullPath); } }; }
  };
}

function validFixture() {
  const Core = require('../public-quiz-library-core.js');
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
  const full = Core.buildProjection(source, {
    setId: 'set-1', authorDisplayName: '홍교사', revision: 'rev-1', nowMs: 1000
  });
  full.status = 'published';
  full.publishedAt = new Date(900);
  const flat = Core.flattenProjection(full, 'build-token');
  return {
    'quiz_sets/set-1': source,
    'teacher_allowances/owner': {
      uid: 'owner', emailCanonical: 'owner@school.kr', status: 'active',
      enabled: true, role: 'teacher'
    },
    'published_quiz_sets/set-1': flat.parent,
    'published_quiz_sets/set-1/videos/v0': flat.videos.v0,
    'published_quiz_sets/set-1/questions/v0q0': flat.questions.v0q0
  };
}

test('public-library auditor exports bounded read-only target and report contracts', () => {
  const audit = require('../public-library-audit.js');

  assert.equal(typeof audit.parseAuditArguments, 'function');
  assert.equal(typeof audit.auditPublicLibrary, 'function');
  assert.throws(() => audit.parseAuditArguments([]), /project/);
  assert.throws(() => audit.parseAuditArguments([
    '--project', 'real-project', '--target-mode', 'emulator', '--max-documents', '100'
  ], {}), /demo-/);
  assert.throws(() => audit.parseAuditArguments([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator',
    '--max-documents', '0'
  ], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /max-documents/);

  assert.deepEqual(audit.parseAuditArguments([
    '--project', 'demo-video-quiz', '--target-mode', 'emulator',
    '--max-documents', '100', '--output', 'audit.json'
  ], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), {
    projectId: 'demo-video-quiz',
    targetMode: 'emulator',
    maxDocuments: 100,
    outputPath: 'audit.json',
    dryRun: true
  });
});

test('bounded auditor accepts an exact clean graph and fails closed on PII and orphans', async () => {
  const { auditPublicLibrary } = require('../public-library-audit.js');
  const clean = await auditPublicLibrary({ db: fakeDb(validFixture()), maxDocuments: 50 });
  assert.equal(clean.complete, true);
  assert.equal(clean.safeToDeployPublicLibrary, true);
  assert.deepEqual(clean.findings, []);

  const timestampRevision = validFixture();
  timestampRevision['quiz_sets/set-1'].contentRevision = {
    seconds: 1, nanoseconds: 2, toMillis: () => 1000
  };
  timestampRevision['published_quiz_sets/set-1'].revision = '1000:2';
  timestampRevision['published_quiz_sets/set-1/videos/v0'].revision = '1000:2';
  timestampRevision['published_quiz_sets/set-1/questions/v0q0'].revision = '1000:2';
  const timestampReport = await auditPublicLibrary({
    db: fakeDb(timestampRevision), maxDocuments: 50
  });
  assert.equal(timestampReport.safeToDeployPublicLibrary, true);

  const tainted = validFixture();
  tainted['published_quiz_sets/set-1/questions/v0q0'].reviewerEmail = 'private@school.kr';
  tainted['published_quiz_sets/set-1/videos/v0'].revision = 'stale-revision';
  tainted['published_quiz_sets/missing/images/v0q0'] = {
    data: 'data:image/png;base64,AAAA', revision: 'rev-1', buildToken: 'token'
  };
  const report = await auditPublicLibrary({ db: fakeDb(tainted), maxDocuments: 50 });
  assert.equal(report.safeToDeployPublicLibrary, false);
  assert.ok(report.findings.some(item => item.code === 'PUBLIC_PII_KEY'));
  assert.ok(report.findings.some(item => item.code === 'ORPHAN_PUBLIC_CHILD'));
  assert.ok(report.findings.some(item => item.code === 'CHILD_REVISION_MISMATCH'));
});

test('CLI reserves before Admin init and never overwrites a durable report', async () => {
  const { main } = require('../scripts/audit-public-library.js');
  const { reserveReport } = require('../scripts/migrate-legacy-ownership.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-library-audit-'));
  const outputPath = path.join(directory, 'report.json');
  const order = [];
  const dependencies = {
    environment: {}, now: () => '2026-08-22T00:00:00.000Z',
    reserveReport(file, contents) {
      order.push('reserve');
      return reserveReport(file, contents);
    },
    async initialize() { order.push('initialize'); return { db: {} }; },
    async auditPublicLibrary() {
      return {
        kind: 'public-quiz-library-privacy-audit', dryRun: true, complete: true,
        maxDocuments: 10, scanned: {}, findings: [], safeToDeployPublicLibrary: true
      };
    },
    writeLine() {}
  };
  const args = [
    '--project', 'video-quiz-production', '--target-mode', 'production',
    '--max-documents', '10', '--output', outputPath
  ];

  const result = await main(args, dependencies);
  assert.deepEqual(order, ['reserve', 'initialize']);
  assert.equal(result.report.safeToDeployPublicLibrary, true);
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).complete, true);
  await assert.rejects(main(args, dependencies), /already exists/);
});
