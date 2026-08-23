const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const adopt = require('../scripts/adopt-existing-ruleset.js');

const PROJECT = 'video-quiz-65798';
const RELEASE = 'projects/video-quiz-65798/releases/cloud.firestore';
const TARGET = 'projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1';
const SHA = 'c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d';
const ROLLBACK = 'projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4';
const QUIESCENCE = 'projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466';
const SOURCE_COMMIT = '8a5a888da98c304ba7b103fb5221c41ac2dc412e';
const STATIC_COMMIT = 'c4f3136de2b140de7a98d415dc65ee68c086732f';
const SOURCE = fs.readFileSync(path.resolve('firestore.rules'), 'utf8');
const INDEXES = fs.readFileSync(path.resolve('firestore.indexes.json'));
const ROLLBACK_SOURCE = "rules_version = '2';\nservice cloud.firestore { match /{path=**} { allow read: if true; } }\n";
const ROLLBACK_SHA = sha256(ROLLBACK_SOURCE);
const INDEXES_SHA = sha256(INDEXES);
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const WINDOW_OPENED_AT = '2026-08-23T05:00:00Z';
const QUIESCENCE_STARTED_AT = '2026-08-23T05:05:00Z';
const WINDOW_SEALED_AT = '2026-08-23T06:00:00Z';
const QUIESCENCE_UPDATE_TIME = '2026-08-23T05:05:00.123456Z';
const EVIDENCE_NAMES = [
  'r0ProductionRulesProbe',
  'r0RulesApiDiagnosis',
  'r1Quiescence',
  'r2LifecycleDryBefore',
  'r2LifecycleApply',
  'r2LifecycleDryAfter',
  'r3SharesDryBefore',
  'r3SharesApply',
  'r3SharesDryAfter',
  'r4CounterLock',
  'r4CounterApply',
  'r4CounterAudit',
  'r5TeacherAccessDry',
  'r5TeacherAccessApply',
  'r6SessionCountersDry',
  'r6SessionCountersApply',
  'r7PublicLibraryAudit',
  'r8IndexReadiness'
];

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function zeroLifecycleAudit() {
  return {
    totalSets: 3,
    missingLifecycleState: 0,
    invalidLifecycleState: 0,
    legacyActiveMissing: 0,
    remainingUnclassified: 0,
    lifecycleMismatchCount: 0,
    lifecycleMismatchIds: [],
    lifecycleMismatches: []
  };
}

function zeroShareAudit() {
  return {
    validCollaboratorCount: 2,
    validIndexCount: 2,
    missingIndexCount: 0,
    malformedCollaboratorCount: 0,
    orphanCollaboratorCount: 0,
    malformedIndexCount: 0,
    staleIndexCount: 0,
    findingDetails: [],
    findingDetailsTruncated: false,
    safeToUseShareIndex: true
  };
}

function zeroCounterAudit() {
  return {
    totalSets: 3,
    missingCollaboratorCount: 0,
    missingImageCount: 0,
    invalidCounterCount: 0,
    counterMismatchCount: 0,
    counterMismatchIds: [],
    orphanChildCount: 0,
    orphanCollaboratorCount: 0,
    orphanImageCount: 0,
    orphanChildDetails: [],
    orphanChildDetailsTruncated: false,
    safeToDeployStrictRules: true
  };
}

function zeroTeacherAccessAudit() {
  return {
    totalLegacy: 2,
    totalAllowances: 2,
    invalidLegacyCount: 0,
    missingAuthUserCount: 0,
    invalidAuthIdentityCount: 0,
    missingAllowanceCount: 0,
    allowanceMismatchCount: 0,
    legacyCompatibilityMismatchCount: 0,
    orphanAllowanceCount: 0,
    issues: [],
    safe: true
  };
}

function zeroSessionAudit() {
  return {
    totalNonEndedSessions: 2,
    missingCounterCount: 0,
    invalidCounterCount: 0,
    counterMismatchCount: 0,
    invalidStudentCount: 0,
    issueSessionIds: [],
    preflightNonEndedLegacyCount: 0,
    safe: true
  };
}

function evidenceReports() {
  const lifecycleBase = {
    projectId: PROJECT,
    targetMode: 'production',
    operation: 'lifecycle-backfill',
    plannedCount: 0,
    appliedCount: 0,
    skipped: [],
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: 'complete',
    safeToDeployStrictRules: false,
    audit: zeroLifecycleAudit()
  };
  const sharesBase = {
    tool: 'collaborator-share-migration',
    schemaVersion: 1,
    projectId: PROJECT,
    targetMode: 'production',
    operation: 'collaborator-share-backfill',
    maxDocuments: 5000,
    plannedUpsertCount: 0,
    plannedDeleteCount: 0,
    appliedUpsertCount: 0,
    appliedDeleteCount: 0,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: 'complete',
    safeToUseShareIndex: true,
    audit: zeroShareAudit()
  };
  const counterBase = {
    projectId: PROJECT,
    targetMode: 'production',
    operation: 'set-counter-backfill',
    plannedCount: 0,
    appliedCount: 0,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: 'complete',
    safeToDeployStrictRules: true,
    gate: {
      path: 'migration_gates/set_counters',
      locked: true,
      lockId: 'e3d1cef7-6c98-46c1-8ec5-b00dba3098b0',
      projectId: PROJECT,
      targetMode: 'production',
      updateTimeGeneration: '1787384912:204091000'
    },
    audit: zeroCounterAudit()
  };
  const accessBase = {
    tool: 'teacher-access-migration',
    schemaVersion: 1,
    operation: 'teacher-access-status-backfill',
    projectId: PROJECT,
    targetMode: 'production',
    plannedCount: 0,
    appliedCount: 0,
    reclassifiedCount: 0,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: 'complete',
    safeToDeployStrictRules: false,
    audit: zeroTeacherAccessAudit()
  };
  const sessionBase = {
    tool: 'session-counter-migration',
    schemaVersion: 1,
    operation: 'session-counter-backfill-and-gate',
    projectId: PROJECT,
    targetMode: 'production',
    plannedCount: 0,
    appliedCount: 0,
    reclassifiedCount: 0,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: 'complete',
    safeToDeployStrictRules: false,
    lock: { path: 'migration_gates/session_counter_migration', locked: false },
    gate: { path: 'migration_gates/session_counters', created: false },
    audit: zeroSessionAudit()
  };
  return {
    r0ProductionRulesProbe: {
      projectId: PROJECT,
      targetMode: 'production',
      sourceSha256: SHA,
      metrics: { bytes: Buffer.byteLength(SOURCE), lines: SOURCE.split('\n').length - 1, functions: 182 },
      issueCounts: { error: 0, warning: 0, info: 0, unknown: 0 },
      status: 'complete',
      safeToCreateRuleset: true
    },
    r0RulesApiDiagnosis: {
      tool: 'rules-api-503-diagnosis',
      schemaVersion: 1,
      projectId: PROJECT,
      targetMode: 'production',
      mutating: false,
      status: 'complete',
      verdict: 'ruleset-quota-has-headroom',
      expectSha256: SHA,
      reconciliation: {
        checked: true,
        writeLanded: true,
        matchingRulesetNames: [TARGET],
        candidateCount: 21,
        inspectedCount: 21,
        unreadableCount: 0,
        listReadable: true,
        note: 'the intended source is already persisted; do not retry the create'
      },
      release: {
        readable: true,
        releaseName: RELEASE,
        activeRulesetName: ROLLBACK,
        updateTime: '2026-08-23T04:59:00Z'
      },
      rulesetInventory: {
        counted: 21,
        pages: 1,
        truncated: false,
        oldestCreateTime: '2026-08-20T00:00:00Z',
        newestCreateTime: '2026-08-23T04:58:00Z',
        listReadable: true,
        failure: null
      },
      rulesetLimit: 2500,
      remainingSlots: 2479
    },
    r1Quiescence: {
      tool: 'r23-quiescence-evidence',
      schemaVersion: 2,
      projectId: PROJECT,
      targetMode: 'production',
      windowId: WINDOW_ID,
      controlId: CONTROL_ID,
      capturedAt: QUIESCENCE_STARTED_AT,
      operation: 'begin-quiescence',
      mode: 'patch-and-verify',
      phase: 'quiescence-established',
      status: 'complete',
      mechanism: 'deny-all Firestore Rules',
      releaseName: RELEASE,
      rulesetName: QUIESCENCE,
      releaseUpdateTime: QUIESCENCE_UPDATE_TIME,
      releasePatchAttempted: true,
      releasePatchCount: 1,
      releasePatchHttpStatus: 200,
      releaseReadbackHttpStatus: 200,
      verifiedAnonymousStatus: 403,
      providerChecksComplete: true,
      cloudFunctionsStopped: true,
      schedulerStopped: true,
      trustedWritersStopped: true,
      writerInventory: {
        cloudFunctionsV1: {
          apiVersion: 'v1', listSucceeded: true, pages: 1,
          unreachable: [], functions: []
        },
        cloudFunctionsV2: {
          apiVersion: 'v2', listSucceeded: true, pages: 1,
          unreachable: [], functions: []
        },
        cloudScheduler: {
          locationsListSucceeded: true, locationPages: 1,
          locations: ['projects/' + PROJECT + '/locations/us-central1'],
          jobsListSucceeded: true, jobPages: 1,
          jobs: [{
            name: 'projects/' + PROJECT + '/locations/us-central1/jobs/nightly',
            state: 'PAUSED'
          }]
        }
      },
      firestoreDataWriteCount: 0,
      error: null
    },
    r2LifecycleDryBefore: { ...clone(lifecycleBase), mode: 'dry-run' },
    r2LifecycleApply: {
      ...clone(lifecycleBase), mode: 'apply', plannedCount: 2, appliedCount: 2,
      safeToDeployStrictRules: true
    },
    r2LifecycleDryAfter: { ...clone(lifecycleBase), mode: 'dry-run' },
    r3SharesDryBefore: { ...clone(sharesBase), mode: 'dry-run' },
    r3SharesApply: {
      ...clone(sharesBase), mode: 'apply', plannedUpsertCount: 2, appliedUpsertCount: 2
    },
    r3SharesDryAfter: { ...clone(sharesBase), mode: 'dry-run' },
    r4CounterLock: {
      tool: 'counter-gate-cli',
      schemaVersion: 1,
      action: 'lock',
      projectId: PROJECT,
      targetMode: 'production',
      lockId: 'e3d1cef7-6c98-46c1-8ec5-b00dba3098b0',
      requestedGeneration: '',
      status: 'complete',
      safeToRunCounterMigration: true,
      gate: {
        ...clone(counterBase.gate),
        exists: true,
        lockedByUid: 'admin-test-uid'
      }
    },
    r4CounterApply: { ...clone(counterBase), mode: 'apply', plannedCount: 2, appliedCount: 2 },
    r4CounterAudit: { ...clone(counterBase), mode: 'dry-run' },
    r5TeacherAccessDry: { ...clone(accessBase), mode: 'dry-run' },
    r5TeacherAccessApply: {
      ...clone(accessBase), mode: 'apply', plannedCount: 2, appliedCount: 2,
      safeToDeployStrictRules: true,
      lock: {
        path: 'migration_gates/teacher_access_status',
        locked: true,
        lockToken: 'd0c5fdb9-7dc9-4912-91e9-546e2ea940be',
        projectId: PROJECT,
        targetMode: 'production',
        status: 'complete',
        strictReady: true,
        updateTimeGeneration: '1787384983:34189000',
        migrationGeneration: '1787266206:604244000',
        completedAt: { _seconds: 1787266206, _nanoseconds: 604244000 },
        completedByUid: 'admin-test-uid'
      }
    },
    r6SessionCountersDry: { ...clone(sessionBase), mode: 'dry-run' },
    r6SessionCountersApply: {
      ...clone(sessionBase), mode: 'apply', plannedCount: 2, appliedCount: 2,
      safeToDeployStrictRules: true,
      lock: {
        path: 'migration_gates/session_counter_migration',
        locked: true,
        lockToken: 'f421fdfe-647c-4039-815f-a6745052d20e',
        projectId: PROJECT,
        targetMode: 'production',
        updateTimeGeneration: '1787385018:993634000'
      },
      gate: {
        path: 'migration_gates/session_counters',
        created: true,
        complete: true,
        projectId: PROJECT,
        targetMode: 'production',
        rulesVersion: 'session-counters-v1',
        updateTimeGeneration: '1787266359:259328000'
      }
    },
    r7PublicLibraryAudit: {
      kind: 'public-quiz-library-privacy-audit',
      projectId: PROJECT,
      targetMode: 'production',
      dryRun: true,
      generatedAt: '2026-08-23T05:50:00Z',
      maxDocuments: 5000,
      scanned: {
        sources: 2,
        locks: 1,
        parents: 2,
        audits: 2,
        videos: 1,
        questions: 3,
        images: 2,
        bindings: 2,
        reads: 15
      },
      complete: true,
      findings: [],
      safeToDeployPublicLibrary: true
    },
    r8IndexReadiness: {
      tool: 'firestore-index-readiness-evidence',
      schemaVersion: 2,
      projectId: PROJECT,
      targetMode: 'production',
      windowId: WINDOW_ID,
      controlId: CONTROL_ID,
      capturedAt: '2026-08-23T05:55:00Z',
      operation: 'exact-index-readback',
      mode: 'get-only',
      status: 'complete',
      indexName: 'projects/video-quiz-65798/databases/(default)/collectionGroups/' +
        'published_quiz_sets/indexes/CICAgOjXh4EK',
      indexState: 'READY',
      indexDefinition: {
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'status', order: 'ASCENDING' },
          { fieldPath: 'updatedAt', order: 'DESCENDING' },
          { fieldPath: '__name__', order: 'DESCENDING' }
        ]
      },
      firestoreIndexesSha256: INDEXES_SHA,
      requiredIndexCount: 1,
      readyIndexCount: 1,
      allRequiredIndexesReady: true,
      pendingCount: 0,
      failedCount: 0,
      writeCount: 0,
      error: null
    }
  };
}

function installEvidence(directory, manifest) {
  const evidenceDirectory = path.join(directory, '.release-artifacts', '2026-08-23');
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const reports = evidenceReports();
  const entries = {};
  const tools = {
    r0ProductionRulesProbe: 'production-rules-compiler-probe',
    r0RulesApiDiagnosis: 'rules-api-503-diagnosis',
    r1Quiescence: 'r23-quiescence-evidence',
    r2LifecycleDryBefore: 'lifecycle-migration-cli',
    r2LifecycleApply: 'lifecycle-migration-cli',
    r2LifecycleDryAfter: 'lifecycle-migration-cli',
    r3SharesDryBefore: 'collaborator-share-migration',
    r3SharesApply: 'collaborator-share-migration',
    r3SharesDryAfter: 'collaborator-share-migration',
    r4CounterLock: 'counter-gate-cli',
    r4CounterApply: 'set-counter-migration-cli',
    r4CounterAudit: 'set-counter-migration-cli',
    r5TeacherAccessDry: 'teacher-access-migration',
    r5TeacherAccessApply: 'teacher-access-migration',
    r6SessionCountersDry: 'session-counter-migration',
    r6SessionCountersApply: 'session-counter-migration',
    r7PublicLibraryAudit: 'public-library-audit-cli',
    r8IndexReadiness: 'firestore-index-readiness-evidence'
  };
  EVIDENCE_NAMES.forEach((name, index) => {
    const reportPath = path.join(
      evidenceDirectory,
      'r23-' + name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()) + '.json'
    );
    const capturedAt = index < 2
      ? ['2026-08-23T05:01:00Z', '2026-08-23T05:02:00Z'][index]
      : index === 2 ? QUIESCENCE_STARTED_AT
        : name === 'r7PublicLibraryAudit' ? '2026-08-23T05:50:00Z'
          : name === 'r8IndexReadiness' ? '2026-08-23T05:55:00Z'
            : new Date(Date.parse('2026-08-23T05:10:00Z') + index * 60_000).toISOString();
    Object.assign(reports[name], {
      tool: tools[name], schemaVersion: 2, projectId: PROJECT,
      targetMode: 'production', windowId: WINDOW_ID, controlId: CONTROL_ID,
      capturedAt
    });
    if (name === 'r7PublicLibraryAudit') reports[name].generatedAt = capturedAt;
    const raw = JSON.stringify(reports[name], null, 2) + '\n';
    fs.writeFileSync(reportPath, raw, 'utf8');
    entries[name] = {
      path: reportPath,
      sha256: sha256(raw),
      windowId: WINDOW_ID,
      controlId: CONTROL_ID,
      capturedAt
    };
  });
  manifest.evidence = entries;
  return { directory: evidenceDirectory, entries, reports };
}

function rewriteEvidence(entry, mutate) {
  const report = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
  mutate(report);
  const raw = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(entry.path, raw, 'utf8');
  entry.sha256 = sha256(raw);
}

function synchronizeLockEvidence(manifest) {
  rewriteEvidence(manifest.evidence.r4CounterLock, report => {
    report.lockId = manifest.locks.setCounters.lockId;
    report.gate.lockId = manifest.locks.setCounters.lockId;
    report.gate.updateTimeGeneration = manifest.locks.setCounters.updateTimeGeneration;
  });
  for (const name of ['r4CounterApply', 'r4CounterAudit']) {
    rewriteEvidence(manifest.evidence[name], report => {
      report.gate.lockId = manifest.locks.setCounters.lockId;
      report.gate.updateTimeGeneration = manifest.locks.setCounters.updateTimeGeneration;
    });
  }
  rewriteEvidence(manifest.evidence.r5TeacherAccessApply, report => {
    report.lock.lockToken = manifest.locks.teacherAccess.lockToken;
    report.lock.updateTimeGeneration = manifest.locks.teacherAccess.updateTimeGeneration;
    report.lock.migrationGeneration = manifest.locks.teacherAccess.migrationGeneration;
  });
  rewriteEvidence(manifest.evidence.r6SessionCountersApply, report => {
    report.lock.lockToken = manifest.locks.sessionCounters.lockToken;
    report.lock.updateTimeGeneration = manifest.locks.sessionCounters.updateTimeGeneration;
    report.gate.updateTimeGeneration = manifest.locks.sessionCounters.gateGeneration;
  });
}

function invalidateEvidenceReport(name, report) {
  const invalidators = {
    r0ProductionRulesProbe(value) { value.issueCounts.error = 1; },
    r0RulesApiDiagnosis(value) { value.reconciliation.matchingRulesetNames.push(ROLLBACK); },
    r1Quiescence(value) { value.trustedWritersStopped = false; },
    r2LifecycleDryBefore(value) { value.appliedCount = 1; },
    r2LifecycleApply(value) { value.safeToDeployStrictRules = false; },
    r2LifecycleDryAfter(value) { value.audit.missingLifecycleState = 1; },
    r3SharesDryBefore(value) { value.appliedUpsertCount = 1; },
    r3SharesApply(value) { value.safeToUseShareIndex = false; },
    r3SharesDryAfter(value) { value.audit.staleIndexCount = 1; },
    r4CounterLock(value) { value.gate.updateTimeGeneration = '1787384912:204091001'; },
    r4CounterApply(value) { value.audit.counterMismatchCount = 1; },
    r4CounterAudit(value) { value.appliedCount = 1; },
    r5TeacherAccessDry(value) { value.appliedCount = 1; },
    r5TeacherAccessApply(value) { value.audit.orphanAllowanceCount = 1; },
    r6SessionCountersDry(value) { value.appliedCount = 1; },
    r6SessionCountersApply(value) { value.audit.preflightNonEndedLegacyCount = 1; },
    r7PublicLibraryAudit(value) { value.findings.push({ code: 'PII_FIELD' }); },
    r8IndexReadiness(value) { value.pendingCount = 1; }
  };
  invalidators[name](report);
}

function validManifest() {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    targetMode: 'production',
    releaseWindow: {
      windowId: WINDOW_ID,
      controlId: CONTROL_ID,
      openedAt: WINDOW_OPENED_AT,
      quiescenceStartedAt: QUIESCENCE_STARTED_AT,
      sealedAt: WINDOW_SEALED_AT
    },
    quiescence: {
      mechanism: 'deny-all Firestore Rules',
      rulesetName: QUIESCENCE,
      releaseUpdateTime: QUIESCENCE_UPDATE_TIME,
      evidenceWindowId: WINDOW_ID,
      controlId: CONTROL_ID,
      verifiedAnonymousStatus: 403,
      providerChecksComplete: true,
      cloudFunctionsStopped: true,
      schedulerStopped: true,
      trustedWritersStopped: true
    },
    rollback: {
      rulesetName: ROLLBACK,
      sourceSha256: ROLLBACK_SHA,
      staticCommit: '62e4e4681025e325380c19026821baceb06a2c64'
    },
    release: {
      staticCommit: STATIC_COMMIT,
      firestoreRulesSha256: SHA,
      firestoreIndexesSha256: INDEXES_SHA
    },
    locks: {
      setCounters: {
        lockId: 'e3d1cef7-6c98-46c1-8ec5-b00dba3098b0',
        updateTimeGeneration: '1787384912:204091000'
      },
      teacherAccess: {
        lockToken: 'd0c5fdb9-7dc9-4912-91e9-546e2ea940be',
        updateTimeGeneration: '1787384983:34189000',
        migrationGeneration: '1787266206:604244000'
      },
      sessionCounters: {
        lockToken: 'f421fdfe-647c-4039-815f-a6745052d20e',
        updateTimeGeneration: '1787385018:993634000',
        gateGeneration: '1787266359:259328000'
      }
    },
    task4: {
      status: 'ready-for-ruleset-adoption',
      adoptionMode: 'existing-exact',
      rulesetName: TARGET,
      headCommit: SOURCE_COMMIT,
      sourceSha256: SHA
    }
  };
}

function currentCommitState() {
  return { sourceCommit: SOURCE_COMMIT, staticCommit: STATIC_COMMIT };
}

function currentDeployInputState() {
  return { rulesSourceSha256: SHA, firestoreIndexesSha256: INDEXES_SHA };
}

function currentGateState() {
  return {
    setCounters: {
      path: 'migration_gates/set_counters', exists: true, locked: true,
      projectId: PROJECT, targetMode: 'production',
      lockId: 'e3d1cef7-6c98-46c1-8ec5-b00dba3098b0',
      updateTimeGeneration: '1787384912:204091000'
    },
    teacherAccess: {
      path: 'migration_gates/teacher_access_status', exists: true, locked: true,
      projectId: PROJECT, targetMode: 'production', status: 'complete', strictReady: true,
      lockToken: 'd0c5fdb9-7dc9-4912-91e9-546e2ea940be',
      updateTimeGeneration: '1787384983:34189000',
      migrationGeneration: '1787266206:604244000'
    },
    sessionCountersLock: {
      path: 'migration_gates/session_counter_migration', exists: true, locked: true,
      projectId: PROJECT, targetMode: 'production',
      lockToken: 'f421fdfe-647c-4039-815f-a6745052d20e',
      updateTimeGeneration: '1787385018:993634000'
    },
    sessionCountersGate: {
      path: 'migration_gates/session_counters', exists: true, complete: true,
      projectId: PROJECT, targetMode: 'production', rulesVersion: 'session-counters-v1',
      preflightNonEndedLegacyCount: 0,
      updateTimeGeneration: '1787266359:259328000'
    }
  };
}

function targetResponse(overrides = {}) {
  return {
    statusCode: 200,
    body: {
      name: TARGET,
      source: { files: [{ name: 'firestore.rules', content: SOURCE }] },
      ...overrides
    }
  };
}

function rollbackResponse(overrides = {}) {
  return {
    statusCode: 200,
    body: {
      name: ROLLBACK,
      source: { files: [{ name: 'firestore.rules', content: ROLLBACK_SOURCE }] },
      ...overrides
    }
  };
}

function releaseResponse(rulesetName, statusCode = 200, updateTime = QUIESCENCE_UPDATE_TIME) {
  return {
    statusCode,
    body: statusCode >= 200 && statusCode < 300
      ? { name: RELEASE, rulesetName, updateTime }
      : { error: { code: statusCode, status: 'UNAVAILABLE', message: 'secret upstream detail' } }
  };
}

function argumentsFor(manifestPath, outputPath, overrides = {}) {
  return [
    '--project', overrides.projectId || PROJECT,
    '--target-mode', overrides.targetMode || 'production',
    '--manifest', manifestPath,
    '--ruleset', overrides.rulesetName || TARGET,
    '--expect-sha', overrides.expectSha256 || SHA,
    '--expect-manifest-sha', overrides.expectManifestSha || 'a'.repeat(64),
    '--output', outputPath
  ];
}

async function invoke(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-existing-ruleset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  const outputPath = path.join(directory, 'report.json');
  const manifest = clone(options.manifest || validManifest());
  const evidence = installEvidence(directory, manifest);
  if (options.mutateEvidence) options.mutateEvidence({ manifest, ...evidence });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  const calls = [];
  const reports = [];
  let tokenCalls = 0;
  const releases = [...(options.releaseResponses || [
    releaseResponse(QUIESCENCE), releaseResponse(TARGET)
  ])];
  const patches = [...(options.patchResponses || [{
    statusCode: 200, body: { name: RELEASE, rulesetName: TARGET }
  }])];
  let patchCallCount = 0;
  const runtime = {
    environment: options.environment || {},
    evidenceRoot: evidence.directory,
    realpathEvidencePath: options.realpathEvidencePath,
    lstatEvidencePath: options.lstatEvidencePath,
    requestTimeoutMs: options.requestTimeoutMs || 20,
    reserveReport(output, initialContents) {
      calls.push({ operation: 'reserve', output, initial: JSON.parse(initialContents) });
      if (options.reusedOutput) throw new Error('Report output already exists.');
      return {
        commit(contents) { reports.push(JSON.parse(contents)); },
        failClosedPath: output + '.reserved'
      };
    },
    async acquireAccessToken() {
      tokenCalls += 1;
      return 'test-token';
    },
    async readCurrentCommit() {
      calls.push({ operation: 'read-current-commit' });
      if (options.currentCommitError) throw options.currentCommitError;
      return options.currentCommit || currentCommitState();
    },
    async readCurrentDeployInputs() {
      calls.push({ operation: 'read-current-deploy-inputs' });
      if (options.currentDeployInputsError) throw options.currentDeployInputsError;
      return options.currentDeployInputs || currentDeployInputState();
    },
    async readGitStatus() {
      calls.push({ operation: 'read-git-status' });
      if (options.gitStatusError) throw options.gitStatusError;
      return options.gitStatus || [];
    },
    async readCurrentGateState() {
      calls.push({ operation: 'read-current-gate-state' });
      if (options.currentGateError) throw options.currentGateError;
      return options.currentGateState || currentGateState();
    },
    async getJson(request) {
      calls.push({ ...request });
      if (options.getJson) return options.getJson(request);
      if (request.url === adopt.API_ROOT + TARGET) {
        return options.target || targetResponse();
      }
      if (request.url === adopt.API_ROOT + ROLLBACK) {
        return options.rollback || rollbackResponse();
      }
      if (request.url === adopt.API_ROOT + RELEASE) {
        assert.ok(releases.length > 0, 'unexpected release GET');
        return releases.shift();
      }
      throw new Error('unexpected GET URL: ' + request.url);
    },
    async patchJson(request) {
      calls.push({ ...request });
      patchCallCount += 1;
      if (options.patchJson) return options.patchJson(request, patchCallCount);
      if ((options.neverSettlePatchNumbers || []).includes(patchCallCount)) {
        return new Promise((resolve, reject) => {
          assert.ok(request.signal, 'injected transport requires an AbortSignal');
          const rejectAbort = () => reject(request.signal.reason);
          if (request.signal.aborted) rejectAbort();
          else request.signal.addEventListener('abort', rejectAbort, { once: true });
        });
      }
      assert.ok(patches.length > 0, 'unexpected release PATCH');
      return patches.shift();
    },
    writeLine(line) {
      calls.push({ operation: 'write-line', line });
      if (options.writeLineError) throw options.writeLineError;
    }
  };

  const cliOverrides = {
    ...(options.arguments || {}),
    expectManifestSha: options.arguments && options.arguments.expectManifestSha ||
      sha256(fs.readFileSync(manifestPath))
  };
  const result = await adopt.main(argumentsFor(manifestPath, outputPath, cliOverrides), runtime);
  return { calls, outputPath, reports, result, tokenCalls };
}

test('CLI refuses every project or mode except the fixed production target', async () => {
  const runtime = {
    environment: {},
    reserveReport() { throw new Error('must not reserve'); }
  };
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { projectId: 'other-project' }), runtime),
    /project/i
  );
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { targetMode: 'emulator' }), runtime),
    /production/i
  );
});

test('CLI requires the fixed explicit target Ruleset and source SHA', async () => {
  const runtime = {
    environment: {},
    reserveReport() { throw new Error('must not reserve'); }
  };
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { rulesetName: ROLLBACK }), runtime),
    /ruleset/i
  );
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { expectSha256: '0'.repeat(64) }), runtime),
    /sha/i
  );
});

test('CLI requires a trusted raw manifest SHA before parsing evidence', async t => {
  const missingManifestSha = argumentsFor('manifest.json', 'out.json');
  missingManifestSha.splice(missingManifestSha.indexOf('--expect-manifest-sha'), 2);
  assert.throws(
    () => adopt.parseArguments(missingManifestSha),
    /manifest.*sha/i
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-manifest-sha-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  const rawManifest = JSON.stringify(validManifest());
  fs.writeFileSync(manifestPath, rawManifest, 'utf8');
  let tokenCalls = 0;
  const args = argumentsFor(manifestPath, path.join(directory, 'report.json'), {
    expectManifestSha: '0'.repeat(64)
  });
  const result = await adopt.main(args, {
    environment: {},
    reserveReport() { return { commit() {} }; },
    async acquireAccessToken() { tokenCalls += 1; },
    writeLine() {}
  });
  assert.equal(result.status, 'failed');
  assert.equal(tokenCalls, 0);
  assert.notEqual(sha256(rawManifest), '0'.repeat(64));
});

test('trusted raw manifest SHA binds an intentionally distinct static commit', async t => {
  const manifest = validManifest();
  manifest.release.staticCommit = '1'.repeat(40);
  const execution = await invoke(t, {
    manifest,
    arguments: { expectManifestSha: sha256(JSON.stringify(validManifest())) }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('production adoption refuses any configured emulator before reserving output', async () => {
  let reserved = false;
  await assert.rejects(adopt.main(
    argumentsFor('manifest.json', 'out.json'),
    {
      environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
      reserveReport() { reserved = true; }
    }
  ), /emulator/i);
  assert.equal(reserved, false);
});

test('an already-used output fails before credentials or Rules API access', async () => {
  let tokenCalls = 0;
  let networkCalls = 0;
  await assert.rejects(adopt.main(
    argumentsFor('manifest.json', 'already-used.json'),
    {
      environment: {},
      reserveReport() { throw new Error('Report output already exists.'); },
      async acquireAccessToken() { tokenCalls += 1; },
      async getJson() { networkCalls += 1; },
      async patchJson() { networkCalls += 1; }
    }
  ), /already exists/i);
  assert.equal(tokenCalls, 0);
  assert.equal(networkCalls, 0);
});

test('the sealed manifest must use every exact adoption identity field', async t => {
  const cases = [
    ['project', manifest => { manifest.projectId = 'other-project'; }],
    ['production mode', manifest => { manifest.targetMode = 'staging'; }],
    ['state', manifest => { manifest.task4.status = 'ready-for-ruleset-create'; }],
    ['adoption mode', manifest => { manifest.task4.adoptionMode = 'automatic'; }],
    ['target ruleset name', manifest => { manifest.task4.rulesetName = ROLLBACK; }],
    ['task source SHA', manifest => { manifest.task4.sourceSha256 = '0'.repeat(64); }],
    ['release source SHA', manifest => { manifest.release.firestoreRulesSha256 = '0'.repeat(64); }],
    ['source commit', manifest => { manifest.task4.headCommit = ''; }],
    ['static release commit', manifest => { manifest.release.staticCommit = 'not-a-commit'; }],
    ['rollback ruleset', manifest => { manifest.rollback.rulesetName = TARGET; }],
    ['rollback static commit', manifest => { manifest.rollback.staticCommit = ''; }],
    ['quiescence mechanism', manifest => { manifest.quiescence.mechanism = 'operator promise'; }],
    ['quiescence ruleset', manifest => { manifest.quiescence.rulesetName = ROLLBACK; }],
    ['quiescence anonymous readback', manifest => { manifest.quiescence.verifiedAnonymousStatus = 200; }],
    ['quiescence trusted-writer gate', manifest => {
      manifest.quiescence.providerChecksComplete = false;
    }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = clone(validManifest());
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('the sealed manifest rejects unknown authorization fields at every contract level', async t => {
  const cases = [
    ['top level', manifest => { manifest.unreviewedAuthorization = true; }],
    ['release window', manifest => { manifest.releaseWindow.unreviewedAuthorization = true; }],
    ['quiescence', manifest => { manifest.quiescence.unreviewedAuthorization = true; }],
    ['rollback', manifest => { manifest.rollback.unreviewedAuthorization = true; }],
    ['release', manifest => { manifest.release.unreviewedAuthorization = true; }],
    ['locks', manifest => { manifest.locks.unreviewedAuthorization = true; }],
    ['set counter lock', manifest => {
      manifest.locks.setCounters.unreviewedAuthorization = true;
    }],
    ['teacher lock', manifest => {
      manifest.locks.teacherAccess.unreviewedAuthorization = true;
    }],
    ['session lock', manifest => {
      manifest.locks.sessionCounters.unreviewedAuthorization = true;
    }],
    ['task identity', manifest => { manifest.task4.unreviewedAuthorization = true; }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = validManifest();
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('all manifest-bound lock identities and current generations are mandatory', async t => {
  const cases = [
    ['set counter lock ID', manifest => { manifest.locks.setCounters.lockId = ''; }],
    ['set counter generation', manifest => { manifest.locks.setCounters.updateTimeGeneration = ''; }],
    ['access lock token', manifest => { manifest.locks.teacherAccess.lockToken = ''; }],
    ['access lock generation', manifest => { manifest.locks.teacherAccess.updateTimeGeneration = 'stale'; }],
    ['access migration generation', manifest => { manifest.locks.teacherAccess.migrationGeneration = null; }],
    ['session lock token', manifest => { manifest.locks.sessionCounters.lockToken = ''; }],
    ['session lock generation', manifest => { manifest.locks.sessionCounters.updateTimeGeneration = 'stale'; }],
    ['session gate generation', manifest => { manifest.locks.sessionCounters.gateGeneration = ''; }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = clone(validManifest());
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('every R0-R8 evidence report is mandatory, hashed, current-window, and R23-only', async t => {
  for (const name of EVIDENCE_NAMES) {
    await t.test(name, async t => {
      const cases = [
        ['missing', ({ manifest }) => { delete manifest.evidence[name]; }],
        ['altered bytes', ({ manifest }) => {
          fs.appendFileSync(manifest.evidence[name].path, 'altered\n', 'utf8');
        }],
        ['stale window', ({ manifest }) => {
          manifest.evidence[name].windowId = '11111111-1111-4111-8111-111111111111';
          manifest.evidence[name].capturedAt = '2026-08-22T05:00:00Z';
        }],
        ['prior R19 path', ({ manifest }) => {
          const current = manifest.evidence[name];
          const priorDirectory = path.join(path.dirname(path.dirname(current.path)), '2026-08-22');
          fs.mkdirSync(priorDirectory, { recursive: true });
          const priorPath = path.join(priorDirectory, 'r19-' + path.basename(current.path));
          fs.copyFileSync(current.path, priorPath);
          current.path = priorPath;
        }]
      ];
      for (const [label, mutateEvidence] of cases) {
        await t.test(label, async t => {
          const execution = await invoke(t, { mutateEvidence });
          assert.equal(execution.result.status, 'failed');
          assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
        });
      }
    });
  }
});

test('unknown evidence and schema-invalid reports fail even when their bytes are freshly hashed', async t => {
  const unknown = await invoke(t, {
    mutateEvidence({ manifest }) {
      manifest.evidence.unreviewedR19Release = clone(manifest.evidence.r1Quiescence);
    }
  });
  assert.equal(unknown.result.status, 'failed');
  assert.equal(unknown.calls.some(call => call.method === 'PATCH'), false);

  for (const name of EVIDENCE_NAMES) {
    await t.test(name, async t => {
      const execution = await invoke(t, {
        mutateEvidence({ manifest }) {
          rewriteEvidence(manifest.evidence[name], report => invalidateEvidenceReport(name, report));
        }
      });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('every known evidence report rejects unknown top-level schema fields', async t => {
  for (const name of EVIDENCE_NAMES) {
    await t.test(name, async t => {
      const execution = await invoke(t, {
        mutateEvidence({ manifest }) {
          rewriteEvidence(manifest.evidence[name], report => {
            report.unreviewedAuthorization = true;
          });
        }
      });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('known nested evidence schemas reject unreviewed authorization fields', async t => {
  const cases = [
    ['compiler metrics', 'r0ProductionRulesProbe', report => {
      report.metrics.unreviewed = 1;
    }],
    ['diagnosis reconciliation', 'r0RulesApiDiagnosis', report => {
      report.reconciliation.unreviewed = true;
    }],
    ['quiescence writer inventory', 'r1Quiescence', report => {
      report.writerInventory.cloudFunctionsV1.unreviewed = true;
    }],
    ['lifecycle audit', 'r2LifecycleDryAfter', report => {
      report.audit.unreviewed = true;
    }],
    ['share audit', 'r3SharesDryAfter', report => {
      report.audit.unreviewed = true;
    }],
    ['counter lock gate', 'r4CounterLock', report => {
      report.gate.unreviewed = true;
    }],
    ['counter audit', 'r4CounterAudit', report => {
      report.audit.unreviewed = true;
    }],
    ['teacher audit', 'r5TeacherAccessApply', report => {
      report.audit.unreviewed = true;
    }],
    ['teacher lock', 'r5TeacherAccessApply', report => {
      report.lock.unreviewed = true;
    }],
    ['session audit', 'r6SessionCountersApply', report => {
      report.audit.unreviewed = true;
    }],
    ['session gate', 'r6SessionCountersApply', report => {
      report.gate.unreviewed = true;
    }],
    ['public scan', 'r7PublicLibraryAudit', report => {
      report.scanned.unreviewed = 1;
    }],
    ['index definition', 'r8IndexReadiness', report => {
      report.indexDefinition.unreviewed = true;
    }]
  ];

  for (const [label, name, mutate] of cases) {
    await t.test(label, async t => {
      const execution = await invoke(t, {
        mutateEvidence({ manifest }) {
          rewriteEvidence(manifest.evidence[name], mutate);
        }
      });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('report-authored timestamps bind to the manifest evidence capture time', async t => {
  const execution = await invoke(t, {
    mutateEvidence({ manifest }) {
      manifest.evidence.r7PublicLibraryAudit.capturedAt = '2026-08-23T05:51:00Z';
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('unchanged old R2 bytes cannot be relabeled with a fresh wrapper capture time', async t => {
  const execution = await invoke(t, {
    mutateEvidence({ manifest }) {
      manifest.evidence.r2LifecycleDryBefore.capturedAt =
        '2026-08-23T05:20:59.999999999Z';
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('manually authored legacy R1 and R8 success objects cannot authorize adoption', async t => {
  const legacyReports = {
    r1Quiescence: {
      tool: 'r23-quiescence-evidence',
      schemaVersion: 1,
      projectId: PROJECT,
      targetMode: 'production',
      windowId: WINDOW_ID,
      controlId: CONTROL_ID,
      capturedAt: QUIESCENCE_STARTED_AT,
      status: 'complete',
      mechanism: 'deny-all Firestore Rules',
      releaseName: RELEASE,
      rulesetName: QUIESCENCE,
      releaseUpdateTime: QUIESCENCE_UPDATE_TIME,
      verifiedAnonymousStatus: 403,
      cloudFunctionsApiDisabled: true,
      trustedWritersStopped: true,
      writeCount: 0
    },
    r8IndexReadiness: {
      tool: 'firestore-index-readiness-evidence',
      schemaVersion: 1,
      projectId: PROJECT,
      targetMode: 'production',
      windowId: WINDOW_ID,
      controlId: CONTROL_ID,
      capturedAt: '2026-08-23T05:55:00Z',
      status: 'complete',
      firestoreIndexesSha256: INDEXES_SHA,
      requiredIndexCount: 1,
      readyIndexCount: 1,
      allRequiredIndexesReady: true,
      pendingCount: 0,
      failedCount: 0,
      writeCount: 0
    }
  };
  for (const [name, legacyReport] of Object.entries(legacyReports)) {
    await t.test(name, async t => {
      const execution = await invoke(t, {
        mutateEvidence({ manifest }) {
          rewriteEvidence(manifest.evidence[name], report => {
            for (const key of Object.keys(report)) delete report[key];
            Object.assign(report, legacyReport);
          });
        }
      });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('the sealed window rejects identical window and control identities in every report', async t => {
  const execution = await invoke(t, {
    mutateEvidence({ manifest }) {
      manifest.releaseWindow.controlId = WINDOW_ID;
      manifest.quiescence.controlId = WINDOW_ID;
      for (const entry of Object.values(manifest.evidence)) {
        entry.controlId = WINDOW_ID;
        rewriteEvidence(entry, report => { report.controlId = WINDOW_ID; });
      }
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('R8 readiness is bound to exactly the one fixed required index', async t => {
  const execution = await invoke(t, {
    mutateEvidence({ manifest }) {
      rewriteEvidence(manifest.evidence.r8IndexReadiness, report => {
        report.requiredIndexCount = 2;
        report.readyIndexCount = 2;
      });
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('full-precision evidence capture ordering rejects a one-nanosecond reversal', async t => {
  const execution = await invoke(t, {
    mutateEvidence({ manifest }) {
      manifest.evidence.r2LifecycleDryBefore.capturedAt =
        '2026-08-23T05:20:00.000000002Z';
      manifest.evidence.r2LifecycleApply.capturedAt =
        '2026-08-23T05:20:00.000000001Z';
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('evidence paths reject traversal and an absolute external root with a valid suffix', async t => {
  const cases = [
    ['lexical traversal', ({ manifest, directory }) => {
      const entry = manifest.evidence.r2LifecycleDryBefore;
      const nested = path.join(directory, 'nested');
      fs.mkdirSync(nested);
      entry.path = nested + path.sep + '..' + path.sep + path.basename(entry.path);
    }],
    ['external absolute suffix root', ({ manifest }) => {
      const entry = manifest.evidence.r2LifecycleDryBefore;
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'external-evidence-root-'));
      const suffix = path.join(outside, '.release-artifacts', '2026-08-23');
      fs.mkdirSync(suffix, { recursive: true });
      const externalPath = path.join(suffix, path.basename(entry.path));
      fs.copyFileSync(entry.path, externalPath);
      entry.path = externalPath;
    }]
  ];
  for (const [name, mutateEvidence] of cases) {
    await t.test(name, async t => {
      const execution = await invoke(t, { mutateEvidence });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('a symlink alias and duplicate realpath cannot stand in for a direct evidence file', async t => {
  let aliasPath = '';
  let sourcePath = '';
  const execution = await invoke(t, {
    mutateEvidence({ manifest, directory }) {
      sourcePath = manifest.evidence.r2LifecycleDryBefore.path;
      aliasPath = path.join(directory, 'r23-duplicate-realpath-alias.json');
      fs.copyFileSync(sourcePath, aliasPath);
      manifest.evidence.r2LifecycleDryAfter.path = aliasPath;
      manifest.evidence.r2LifecycleDryAfter.sha256 = manifest.evidence.r2LifecycleDryBefore.sha256;
    },
    realpathEvidencePath(value) {
      return value === aliasPath ? sourcePath : fs.realpathSync(value);
    },
    lstatEvidencePath(value) {
      if (value === aliasPath) {
        return { isFile: () => true, isSymbolicLink: () => true };
      }
      return fs.lstatSync(value);
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('two evidence entries cannot reuse the same canonical realpath', async t => {
  const execution = await invoke(t, {
    mutateEvidence({ manifest }) {
      manifest.evidence.r2LifecycleDryAfter.path =
        manifest.evidence.r2LifecycleDryBefore.path;
      manifest.evidence.r2LifecycleDryAfter.sha256 =
        manifest.evidence.r2LifecycleDryBefore.sha256;
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('live repository identity rejects valid but stale source and hosted-static commits', async t => {
  const cases = [
    ['source HEAD', manifest => { manifest.task4.headCommit = '1'.repeat(40); }],
    ['hosted static revision', manifest => { manifest.release.staticCommit = '2'.repeat(40); }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = validManifest();
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.result.phase, 'local-commit-readback');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('current gate read failure stops before release mutation', async t => {
  const execution = await invoke(t, {
    currentGateError: Object.assign(new Error('read unavailable'), { code: 'ETIMEDOUT' })
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'current-gate-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
  assert.equal(execution.calls.some(call => call.url === adopt.API_ROOT + RELEASE), false);
});

test('every well-formed manifest lock token and generation must match current readback', async t => {
  const cases = [
    ['set counter lock ID', manifest => { manifest.locks.setCounters.lockId = '11111111-1111-4111-8111-111111111111'; }],
    ['set counter generation', manifest => { manifest.locks.setCounters.updateTimeGeneration = '1787384912:204091001'; }],
    ['teacher access token', manifest => { manifest.locks.teacherAccess.lockToken = '22222222-2222-4222-8222-222222222222'; }],
    ['teacher access update generation', manifest => { manifest.locks.teacherAccess.updateTimeGeneration = '1787384983:34189001'; }],
    ['teacher access migration generation', manifest => { manifest.locks.teacherAccess.migrationGeneration = '1787266206:604244001'; }],
    ['session counter token', manifest => { manifest.locks.sessionCounters.lockToken = '33333333-3333-4333-8333-333333333333'; }],
    ['session lock generation', manifest => { manifest.locks.sessionCounters.updateTimeGeneration = '1787385018:993634001'; }],
    ['session gate generation', manifest => { manifest.locks.sessionCounters.gateGeneration = '1787266359:259328001'; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = validManifest();
      mutate(manifest);
      const execution = await invoke(t, {
        manifest,
        mutateEvidence({ manifest: installedManifest }) {
          synchronizeLockEvidence(installedManifest);
        }
      });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.result.phase, 'current-gate-readback');
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('current gate identity or locked/complete state mismatch stops before release mutation', async t => {
  const state = currentGateState();
  state.teacherAccess.locked = false;
  const execution = await invoke(t, { currentGateState: state });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'current-gate-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('dirty Rules/deploy inputs and untracked deploy-root files stop before credentials or mutation', async t => {
  const cases = [
    ['staged Rules', [{ indexStatus: 'M', worktreeStatus: ' ', path: 'firestore.rules' }]],
    ['unstaged static asset', [{ indexStatus: ' ', worktreeStatus: 'M', path: 'index.html' }]],
    ['staged root CNAME', [{ indexStatus: 'M', worktreeStatus: ' ', path: 'CNAME' }]],
    ['unstaged root 404 page', [{ indexStatus: ' ', worktreeStatus: 'M', path: '404.html' }]],
    ['untracked deploy-root file', [{ indexStatus: '?', worktreeStatus: '?', path: 'debug-release.js' }]],
    ['staged restricted evidence', [{
      indexStatus: 'A', worktreeStatus: ' ',
      path: '.release-maintenance/r19-firestore-rules-release.js'
    }]]
  ];
  for (const [name, gitStatus] of cases) {
    await t.test(name, async t => {
      const execution = await invoke(t, { gitStatus });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('untracked files are allowed only under the two restricted evidence directories', async t => {
  const execution = await invoke(t, {
    gitStatus: [
      { indexStatus: '?', worktreeStatus: '?', path: '.release-artifacts/2026-08-23/r23-local.json' },
      { indexStatus: '?', worktreeStatus: '?', path: '.release-maintenance/r19-firestore-rules-release.js' }
    ]
  });
  assert.equal(execution.result.status, 'complete');
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('an unreadable exact target records allowlisted failure evidence without patching', async t => {
  const execution = await invoke(t, {
    target: {
      statusCode: 403,
      body: {
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          message: 'credential and server internals must not escape'
        }
      }
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.failure.apiStatus, 'PERMISSION_DENIED');
  assert.equal(execution.result.failure.apiMessage, '');
  assert.equal(JSON.stringify(execution.result).includes('credential and server internals'), false);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('the target must be the exact named Ruleset with exactly one firestore.rules file', async t => {
  const cases = [
    ['wrong immutable name', targetResponse({ name: ROLLBACK })],
    ['missing source', { statusCode: 200, body: { name: TARGET } }],
    ['wrong file name', targetResponse({
      source: { files: [{ name: 'other.rules', content: SOURCE }] }
    })],
    ['multiple files', targetResponse({
      source: { files: [
        { name: 'firestore.rules', content: SOURCE },
        { name: 'extra.rules', content: '' }
      ] }
    })]
  ];
  for (const [name, target] of cases) {
    await t.test(name, async t => {
      const execution = await invoke(t, { target });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('a target source hash mismatch stops before reading or patching the release', async t => {
  const execution = await invoke(t, {
    target: targetResponse({
      source: { files: [{ name: 'firestore.rules', content: SOURCE + '\n// changed' }] }
    })
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.calls.filter(call => call.url === adopt.API_ROOT + RELEASE).length, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('immediate pre-PATCH release drift from deny-all quiescence performs no mutation', async t => {
  const execution = await invoke(t, {
    releaseResponses: [releaseResponse(ROLLBACK)]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'immediate-pre-patch-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('an away-and-back quiescence release updateTime drift performs no mutation', async t => {
  const execution = await invoke(t, {
    releaseResponses: [releaseResponse(QUIESCENCE, 200, '2026-08-23T05:06:00Z')]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'immediate-pre-patch-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('an unreadable or source-mismatched rollback Ruleset stops before release mutation', async t => {
  const cases = [
    ['unreadable', { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }],
    ['source mismatch', rollbackResponse({
      source: { files: [{ name: 'firestore.rules', content: ROLLBACK_SOURCE + '// changed\n' }] }
    })]
  ];
  for (const [name, rollback] of cases) {
    await t.test(name, async t => {
      const execution = await invoke(t, { rollback });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('a failed target PATCH immediately restores and exactly reads back rollback', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 503, body: { error: {
        code: 503, status: 'UNAVAILABLE', message: 'sensitive target patch failure'
      } } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  const patches = execution.calls.filter(call => call.method === 'PATCH');
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.targetRulesetReadbackExact, true);
  assert.equal(execution.result.currentCommitExact, true);
  assert.equal(execution.result.currentGateStateExact, true);
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.result.failure.apiStatus, 'UNAVAILABLE');
  assert.equal(JSON.stringify(execution.result).includes('sensitive target patch failure'), false);
  assert.equal(patches.length, 2);
  assert.equal(patches[1].payload.release.rulesetName, ROLLBACK);
});

test('a never-settling target PATCH times out and restores exact rollback readback', async t => {
  const attempted = invoke(t, {
    requestTimeoutMs: 10,
    neverSettlePatchNumbers: [1],
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  const execution = await Promise.race([
    attempted,
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);
  assert.notEqual(execution, 'test-deadline', 'target PATCH must have a bounded settlement');
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.failure.transportError, 'ETIMEDOUT');
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('target PATCH timeout cancels late apply before rollback and remains rolled back', async t => {
  let liveRuleset = QUIESCENCE;
  const events = [];
  const execution = await invoke(t, {
    requestTimeoutMs: 10,
    getJson(request) {
      if (request.url === adopt.API_ROOT + TARGET) return targetResponse();
      if (request.url === adopt.API_ROOT + ROLLBACK) return rollbackResponse();
      assert.equal(request.url, adopt.API_ROOT + RELEASE);
      events.push('release-readback:' + liveRuleset);
      return releaseResponse(liveRuleset);
    },
    patchJson(request, patchNumber) {
      if (patchNumber === 1) {
        events.push('target-started');
        return new Promise((resolve, reject) => {
          const lateApply = setTimeout(() => {
            liveRuleset = TARGET;
            events.push('target-applied-late');
            resolve({ statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } });
          }, 40);
          if (!request.signal) return;
          request.signal.addEventListener('abort', () => {
            events.push('target-abort-received');
            clearTimeout(lateApply);
            setTimeout(() => {
              events.push('target-transport-closed');
              reject(request.signal.reason);
            }, 5);
          }, { once: true });
        });
      }
      events.push('rollback-started');
      liveRuleset = ROLLBACK;
      return { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } };
    }
  });

  assert.equal(execution.result.status, 'failed-rolled-back');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(liveRuleset, ROLLBACK);
  assert.equal(events.includes('target-applied-late'), false);
  assert.equal(releaseResponse(liveRuleset).body.rulesetName, ROLLBACK);
  assert.ok(events.indexOf('target-abort-received') < events.indexOf('target-transport-closed'));
  assert.ok(events.indexOf('target-transport-closed') < events.indexOf('rollback-started'));
});

test('request transport settles abort only after the HTTPS request closes', async t => {
  const originalRequest = https.request;
  const events = [];
  const fakeRequest = new EventEmitter();
  const fakeResponse = new EventEmitter();
  fakeResponse.statusCode = 200;
  fakeRequest.setTimeout = () => {
    events.push('independent-request-timeout');
    return fakeRequest;
  };
  fakeResponse.setTimeout = () => {
    events.push('independent-response-timeout');
    return fakeResponse;
  };
  fakeRequest.destroy = error => {
    events.push('request-destroyed:' + error.code);
    fakeRequest.emit('error', error);
  };
  https.request = (options, respond) => {
    fakeRequest.end = () => {
      events.push('request-ended');
      respond(fakeResponse);
    };
    return fakeRequest;
  };
  t.after(() => { https.request = originalRequest; });

  const controller = new AbortController();
  const timeout = Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' });
  let settlement = 'pending';
  const requested = adopt.requestJson({
    method: 'PATCH',
    url: adopt.API_ROOT + RELEASE,
    accessToken: 'test-token',
    payload: { release: { rulesetName: TARGET } },
    signal: controller.signal
  }).then(
    () => { settlement = 'resolved'; },
    error => { settlement = error; }
  );

  controller.abort(timeout);
  assert.deepEqual(events, ['request-ended', 'request-destroyed:ETIMEDOUT']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settlement, 'pending');
  fakeRequest.emit('close');
  await requested;
  assert.equal(settlement, timeout);
  assert.equal(settlement.mutationOutcomeUnknown, true);
});

test('close before a later transport error settles unknown once without rollback or hang', async t => {
  for (const closeBoundary of ['request', 'response']) {
    await t.test(closeBoundary + ' closes first', async t => {
      const originalRequest = https.request;
      const unhandled = [];
      const lateError = Object.assign(new Error('late transport error'), { code: 'ECONNRESET' });
      const fakeRequest = new EventEmitter();
      const fakeResponse = new EventEmitter();
      const events = [];
      fakeResponse.statusCode = 200;
      fakeRequest.destroy = error => {
        events.push('request-destroyed:' + error.code);
        fakeRequest.emit('error', error);
      };
      https.request = (options, respond) => {
        fakeRequest.end = () => {
          events.push('request-ended');
          if (closeBoundary === 'response') respond(fakeResponse);
          setImmediate(() => {
            events.push(closeBoundary + '-closed');
            (closeBoundary === 'request' ? fakeRequest : fakeResponse).emit('close');
            setTimeout(() => {
              events.push('late-error');
              fakeRequest.emit('error', lateError);
            }, 5);
          });
        };
        return fakeRequest;
      };
      const onUnhandled = error => { unhandled.push(error); };
      process.on('unhandledRejection', onUnhandled);
      t.after(() => {
        process.removeListener('unhandledRejection', onUnhandled);
        https.request = originalRequest;
      });

      const attempted = invoke(t, {
        requestTimeoutMs: 15,
        patchJson: adopt.requestJson
      });
      const execution = await Promise.race([
        attempted,
        new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
      ]);

      assert.notEqual(execution, 'test-deadline', 'close must settle the PATCH transport');
      assert.equal(execution.result.status, 'mutation-outcome-unknown');
      assert.equal(execution.result.mutationOutcomeUnknown, true);
      assert.equal(execution.result.rollbackAttempted, false);
      assert.equal(execution.result.rollbackReadbackExact, false);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(events.includes('late-error'), true);
      assert.equal(execution.reports.length, 1);
      assert.deepEqual(unhandled, []);
      assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 1);
    });
  }
});

test('an ambiguous production PATCH transport stops without rollback claims', async t => {
  let patchCalls = 0;
  const uncertain = Object.assign(new Error('closed after transmit'), {
    code: 'ETIMEDOUT', mutationOutcomeUnknown: true
  });
  const execution = await invoke(t, {
    patchJson() {
      patchCalls += 1;
      throw uncertain;
    }
  });

  assert.equal(execution.result.status, 'mutation-outcome-unknown');
  assert.equal(execution.result.mutationOutcomeUnknown, true);
  assert.equal(execution.result.rollbackAttempted, false);
  assert.equal(execution.result.rollbackReadbackExact, false);
  assert.equal(patchCalls, 1);
});

test('a never-settling rollback PATCH times out and still performs rollback readback', async t => {
  const attempted = invoke(t, {
    requestTimeoutMs: 10,
    neverSettlePatchNumbers: [2],
    patchResponses: [
      { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  const execution = await Promise.race([
    attempted,
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);
  assert.notEqual(execution, 'test-deadline', 'rollback PATCH must have a bounded settlement');
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.rollbackFailure.transportError, 'ETIMEDOUT');
  assert.equal(execution.result.rollbackReadbackExact, true);
});

test('a target readback mismatch restores and exactly reads back rollback', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [
      releaseResponse(QUIESCENCE),
      releaseResponse(QUIESCENCE),
      releaseResponse(ROLLBACK)
    ]
  });
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('rollback PATCH failure remains failed even if rollback appears in readback', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } },
      { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.rollbackPatchHttpStatus, 503);
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.result.safeForStaticDeployment, false);
});

test('rollback readback failure remains failed after a successful rollback PATCH', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [
      releaseResponse(QUIESCENCE),
      releaseResponse(QUIESCENCE),
      releaseResponse(ROLLBACK, 503)
    ]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.rollbackPatchHttpStatus, 200);
  assert.equal(execution.result.rollbackReadbackHttpStatus, 503);
  assert.equal(execution.result.rollbackReadbackExact, false);
});

test('success GETs only exact resources and PATCHes only the release rulesetName once', async t => {
  const execution = await invoke(t);
  const networkCalls = execution.calls.filter(call => call.method);
  const patches = networkCalls.filter(call => call.method === 'PATCH');

  assert.equal(execution.result.status, 'complete');
  assert.equal(execution.result.createAttempted, false);
  assert.equal(execution.result.releaseReadbackRulesetName, TARGET);
  assert.equal(execution.result.releaseReadbackExact, true);
  assert.equal(execution.result.safeForStaticDeployment, true);
  assert.equal(execution.result.providerMutationAttempted, false);
  assert.equal(execution.result.providerStateVerified, false);
  assert.equal(Object.hasOwn(execution.result, 'providerStillOff'), false);
  assert.equal(Object.hasOwn(execution.result, 'safeForExistingFlowSmoke'), false);
  assert.equal(execution.result.rollbackRulesetReadbackExact, true);
  assert.equal(execution.result.postActivationTargetRulesetReadbackExact, true);
  assert.equal(execution.reports.length, 1);
  assert.deepEqual(execution.reports[0], execution.result);
  assert.equal(networkCalls.some(call => call.method === 'POST'), false);
  assert.deepEqual(networkCalls.filter(call => call.method === 'GET').map(call => call.url), [
    adopt.API_ROOT + TARGET,
    adopt.API_ROOT + ROLLBACK,
    adopt.API_ROOT + RELEASE,
    adopt.API_ROOT + RELEASE,
    adopt.API_ROOT + TARGET
  ]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].url, adopt.API_ROOT + RELEASE);
  assert.deepEqual(patches[0].payload, {
    release: { name: RELEASE, rulesetName: TARGET },
    updateMask: 'rulesetName'
  });
});

test('post-activation target source is re-read and a mismatch triggers exact rollback', async t => {
  let targetReads = 0;
  let releaseReads = 0;
  const execution = await invoke(t, {
    getJson(request) {
      if (request.url === adopt.API_ROOT + TARGET) {
        targetReads += 1;
        return targetReads === 1 ? targetResponse() : targetResponse({
          source: { files: [{ name: 'firestore.rules', content: SOURCE + '// changed\n' }] }
        });
      }
      if (request.url === adopt.API_ROOT + ROLLBACK) return rollbackResponse();
      if (request.url === adopt.API_ROOT + RELEASE) {
        releaseReads += 1;
        if (releaseReads === 1) return releaseResponse(QUIESCENCE);
        if (releaseReads === 2) return releaseResponse(TARGET);
        return releaseResponse(ROLLBACK);
      }
      throw new Error('unexpected GET ' + request.url);
    },
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ]
  });
  assert.equal(targetReads, 2);
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.postActivationTargetRulesetReadbackExact, false);
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('stdout failure after success cannot trigger rollback or contradict the durable report', async t => {
  const execution = await invoke(t, {
    writeLineError: new Error('stdout closed'),
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [
      releaseResponse(QUIESCENCE), releaseResponse(TARGET), releaseResponse(ROLLBACK)
    ]
  });
  assert.equal(execution.result.status, 'complete');
  assert.equal(execution.reports.length, 1);
  assert.equal(execution.reports[0].status, 'complete');
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(execution.result.rollbackAttempted, false);
});
