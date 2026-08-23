'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  UUID_PATTERN,
  rfc3339Nanoseconds
} = require('./release-evidence-identity.js');

const EVIDENCE_NAMES = Object.freeze([
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
]);

const SHA_PATTERN = /^[0-9a-f]{64}$/;
const R23_PATH_PATTERN = /(?:^|\/)\.release-artifacts\/2026-08-23\/r23-[a-z0-9-]+\.json$/;
const SOURCE_BUDGET = Object.freeze({ bytes: 130000, lines: 2700, functions: 190 });
const EVIDENCE_ROOT =
  'C:\\Users\\user\\Desktop\\영상퀴즈\\.worktrees\\email-auth-public-library\\.release-artifacts\\2026-08-23';
const REQUIRED_INDEX_NAME = 'projects/video-quiz-65798/databases/(default)/' +
  'collectionGroups/published_quiz_sets/indexes/CICAgOjXh4EK';
const REQUIRED_INDEX_FIELDS = Object.freeze([
  Object.freeze({ fieldPath: 'status', order: 'ASCENDING' }),
  Object.freeze({ fieldPath: 'updatedAt', order: 'DESCENDING' }),
  Object.freeze({ fieldPath: '__name__', order: 'DESCENDING' })
]);
const REPORT_IDENTITY_KEYS = Object.freeze([
  'tool', 'schemaVersion', 'projectId', 'targetMode',
  'windowId', 'controlId', 'capturedAt'
]);

function exactObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failEvidence() {
  throw new Error('Restricted R23 evidence is missing, stale, altered, or unsafe.');
}

function assertEvidence(condition) {
  if (!condition) failEvidence();
}

function exactKeys(value, keys) {
  return exactObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validTimestamp(value) {
  return rfc3339Nanoseconds(value) !== null;
}

function timestampNanoseconds(value) {
  const result = rfc3339Nanoseconds(value);
  assertEvidence(result !== null);
  return result;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function boundedIdentity(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 128 && !value.includes('/');
}

function serializedFirestoreTimestamp(value) {
  return exactKeys(value, ['_seconds', '_nanoseconds']) &&
    Number.isInteger(value._seconds) && Number.isInteger(value._nanoseconds) &&
    value._nanoseconds >= 0 && value._nanoseconds < 1_000_000_000;
}

function exactProjectMode(report, contract) {
  assertEvidence(exactObject(report));
  assertEvidence(report.projectId === contract.projectId);
  assertEvidence(report.targetMode === contract.targetMode);
}

function reportKeys(keys) {
  return [...REPORT_IDENTITY_KEYS, ...keys];
}

function validateReportIdentity(report, manifest, contract, entry, tool) {
  exactProjectMode(report, contract);
  assertEvidence(report.tool === tool && report.schemaVersion === 2);
  assertEvidence(report.windowId === manifest.releaseWindow.windowId);
  assertEvidence(report.controlId === manifest.releaseWindow.controlId);
  assertEvidence(report.capturedAt === entry.capturedAt);
}

function zeroFields(value, fields) {
  assertEvidence(exactObject(value));
  for (const field of fields) assertEvidence(value[field] === 0);
}

function emptyArray(value) {
  assertEvidence(Array.isArray(value) && value.length === 0);
}

function validateCompilerProbe(report, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'sourceSha256', 'metrics', 'issueCounts',
    'status', 'safeToCreateRuleset'
  ])));
  validateReportIdentity(
    report, manifest, contract, entry, 'production-rules-compiler-probe'
  );
  assertEvidence(report.sourceSha256 === contract.sourceSha256);
  assertEvidence(report.status === 'complete' && report.safeToCreateRuleset === true);
  assertEvidence(exactKeys(report.metrics, ['bytes', 'lines', 'functions']));
  for (const [key, maximum] of Object.entries(SOURCE_BUDGET)) {
    assertEvidence(nonNegativeInteger(report.metrics[key]) && report.metrics[key] <= maximum);
  }
  assertEvidence(exactKeys(report.issueCounts, ['error', 'warning', 'info', 'unknown']));
  for (const key of ['error', 'warning', 'info', 'unknown']) {
    assertEvidence(nonNegativeInteger(report.issueCounts[key]));
  }
  assertEvidence(report.issueCounts.error === 0 && report.issueCounts.unknown === 0);
}

function validateDiagnosis(report, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'mutating', 'status',
    'verdict', 'expectSha256', 'reconciliation', 'release',
    'rulesetInventory', 'rulesetLimit', 'remainingSlots'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'rules-api-503-diagnosis');
  assertEvidence(report.mutating === false && report.status === 'complete');
  assertEvidence(report.expectSha256 === contract.sourceSha256);
  const reconciliation = report.reconciliation;
  assertEvidence(exactKeys(reconciliation, [
    'checked', 'writeLanded', 'matchingRulesetNames', 'candidateCount',
    'inspectedCount', 'unreadableCount', 'listReadable', 'note'
  ]));
  assertEvidence(reconciliation.checked === true && reconciliation.writeLanded === true);
  assertEvidence(reconciliation.listReadable === true && reconciliation.unreadableCount === 0);
  assertEvidence(Array.isArray(reconciliation.matchingRulesetNames));
  assertEvidence(reconciliation.matchingRulesetNames.length === 1 &&
    reconciliation.matchingRulesetNames[0] === contract.targetRuleset);
  assertEvidence(nonNegativeInteger(reconciliation.candidateCount) &&
    reconciliation.candidateCount >= 1);
  assertEvidence(nonNegativeInteger(reconciliation.inspectedCount) &&
    reconciliation.inspectedCount >= 1);
  assertEvidence(reconciliation.inspectedCount === reconciliation.candidateCount);
  assertEvidence(typeof reconciliation.note === 'string' && reconciliation.note.length > 0);
  assertEvidence(exactKeys(report.release, [
    'readable', 'releaseName', 'activeRulesetName', 'updateTime'
  ]) && report.release.readable === true);
  assertEvidence(report.release.releaseName === contract.releaseName);
  assertEvidence(typeof report.release.activeRulesetName === 'string' &&
    report.release.activeRulesetName.startsWith('projects/' + contract.projectId + '/rulesets/'));
  assertEvidence(validTimestamp(report.release.updateTime));
  assertEvidence(exactKeys(report.rulesetInventory, [
    'counted', 'pages', 'truncated', 'oldestCreateTime', 'newestCreateTime',
    'listReadable', 'failure'
  ]));
  assertEvidence(report.rulesetInventory.listReadable === true &&
    report.rulesetInventory.truncated === false);
  assertEvidence(report.rulesetInventory.failure === null);
  assertEvidence(nonNegativeInteger(report.rulesetInventory.counted) &&
    report.rulesetInventory.counted >= 1 && report.rulesetInventory.counted <= 2500);
  assertEvidence(nonNegativeInteger(report.rulesetInventory.pages) &&
    report.rulesetInventory.pages >= 1 && report.rulesetInventory.pages <= 40);
  assertEvidence(validTimestamp(report.rulesetInventory.oldestCreateTime));
  assertEvidence(validTimestamp(report.rulesetInventory.newestCreateTime));
  assertEvidence(timestampNanoseconds(report.rulesetInventory.oldestCreateTime) <=
    timestampNanoseconds(report.rulesetInventory.newestCreateTime));
  assertEvidence(reconciliation.candidateCount === report.rulesetInventory.counted);
  assertEvidence(report.rulesetLimit === 2500);
  assertEvidence(report.remainingSlots === 2500 - report.rulesetInventory.counted);
  const expectedVerdict = report.rulesetInventory.counted >= 2500
    ? 'ruleset-quota-exhausted'
    : report.rulesetInventory.counted >= 2475
      ? 'ruleset-quota-near-limit' : 'ruleset-quota-has-headroom';
  assertEvidence(report.verdict === expectedVerdict);
}

function validateFunctionInventory(value, version) {
  assertEvidence(exactKeys(value, [
    'apiVersion', 'listSucceeded', 'pages', 'unreachable', 'functions'
  ]));
  assertEvidence(value.apiVersion === version && value.listSucceeded === true);
  assertEvidence(nonNegativeInteger(value.pages) && value.pages >= 1);
  emptyArray(value.unreachable);
  emptyArray(value.functions);
}

function validateSchedulerInventory(value, contract) {
  assertEvidence(exactKeys(value, [
    'locationsListSucceeded', 'locationPages', 'locations',
    'jobsListSucceeded', 'jobPages', 'jobs'
  ]));
  assertEvidence(value.locationsListSucceeded === true && value.jobsListSucceeded === true);
  assertEvidence(nonNegativeInteger(value.locationPages) && value.locationPages >= 1);
  assertEvidence(Array.isArray(value.locations) && value.locations.length >= 1);
  for (const location of value.locations) {
    assertEvidence(typeof location === 'string' &&
      location.startsWith('projects/' + contract.projectId + '/locations/'));
  }
  assertEvidence(nonNegativeInteger(value.jobPages) &&
    value.jobPages >= value.locations.length);
  assertEvidence(Array.isArray(value.jobs));
  for (const job of value.jobs) {
    assertEvidence(exactKeys(job, ['name', 'state']));
    assertEvidence(typeof job.name === 'string' && value.locations.some(
      location => job.name.startsWith(location + '/jobs/')
    ));
    assertEvidence(['PAUSED', 'DISABLED'].includes(job.state));
  }
}

function validateQuiescence(report, contract, manifest, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'operation', 'mode', 'phase', 'status', 'mechanism', 'releaseName',
    'rulesetName', 'releaseUpdateTime', 'releasePatchAttempted',
    'releasePatchCount', 'releasePatchHttpStatus', 'releaseReadbackHttpStatus',
    'verifiedAnonymousStatus', 'providerChecksComplete', 'cloudFunctionsStopped',
    'schedulerStopped', 'trustedWritersStopped', 'writerInventory',
    'firestoreDataWriteCount', 'error'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'r23-quiescence-evidence');
  assertEvidence(report.operation === 'begin-quiescence' && report.mode === 'patch-and-verify');
  assertEvidence(report.phase === 'quiescence-established' && report.status === 'complete');
  assertEvidence(report.mechanism === 'deny-all Firestore Rules');
  assertEvidence(report.releaseName === contract.releaseName);
  assertEvidence(report.rulesetName === contract.quiescenceRuleset);
  assertEvidence(report.releaseUpdateTime === manifest.quiescence.releaseUpdateTime);
  assertEvidence(validTimestamp(report.releaseUpdateTime));
  assertEvidence(report.releasePatchAttempted === true && report.releasePatchCount === 1);
  assertEvidence(report.releasePatchHttpStatus >= 200 && report.releasePatchHttpStatus < 300);
  assertEvidence(report.releaseReadbackHttpStatus >= 200 &&
    report.releaseReadbackHttpStatus < 300);
  assertEvidence(report.verifiedAnonymousStatus === 403);
  assertEvidence(report.providerChecksComplete === true &&
    report.cloudFunctionsStopped === true && report.schedulerStopped === true);
  assertEvidence(report.trustedWritersStopped === true);
  assertEvidence(exactKeys(report.writerInventory, [
    'cloudFunctionsV1', 'cloudFunctionsV2', 'cloudScheduler'
  ]));
  validateFunctionInventory(report.writerInventory.cloudFunctionsV1, 'v1');
  validateFunctionInventory(report.writerInventory.cloudFunctionsV2, 'v2');
  validateSchedulerInventory(report.writerInventory.cloudScheduler, contract);
  assertEvidence(report.firestoreDataWriteCount === 0 && report.error === null);
}

function validateLifecycle(report, mode, requireClean, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'mode', 'operation', 'plannedCount',
    'appliedCount', 'skipped', 'concurrentlySkipped',
    'concurrentlySkippedCount', 'status', 'safeToDeployStrictRules', 'audit'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'lifecycle-migration-cli');
  assertEvidence(report.operation === 'lifecycle-backfill' && report.mode === mode);
  assertEvidence(report.status === 'complete');
  assertEvidence(nonNegativeInteger(report.plannedCount) && nonNegativeInteger(report.appliedCount));
  assertEvidence(Array.isArray(report.skipped));
  assertEvidence(report.concurrentlySkippedCount === 0);
  emptyArray(report.concurrentlySkipped);
  if (mode === 'dry-run') assertEvidence(report.appliedCount === 0);
  if (mode === 'apply') assertEvidence(report.safeToDeployStrictRules === true);
  else assertEvidence(report.safeToDeployStrictRules === false);
  assertEvidence(exactKeys(report.audit, [
    'totalSets', 'missingLifecycleState', 'invalidLifecycleState',
    'legacyActiveMissing', 'remainingUnclassified', 'lifecycleMismatchCount',
    'lifecycleMismatchIds', 'lifecycleMismatches'
  ]));
  assertEvidence(nonNegativeInteger(report.audit.totalSets));
  if (requireClean) {
    if (mode === 'dry-run') assertEvidence(report.plannedCount === 0);
    zeroFields(report.audit, [
      'missingLifecycleState', 'invalidLifecycleState', 'legacyActiveMissing',
      'remainingUnclassified', 'lifecycleMismatchCount'
    ]);
    emptyArray(report.audit.lifecycleMismatchIds);
    emptyArray(report.audit.lifecycleMismatches);
  }
}

function validateShares(report, mode, requireClean, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'mode', 'operation',
    'maxDocuments', 'plannedUpsertCount', 'plannedDeleteCount',
    'appliedUpsertCount', 'appliedDeleteCount', 'concurrentlySkipped',
    'concurrentlySkippedCount', 'status', 'safeToUseShareIndex', 'audit'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'collaborator-share-migration');
  assertEvidence(report.operation === 'collaborator-share-backfill' && report.mode === mode);
  assertEvidence(report.status === 'complete' && report.concurrentlySkippedCount === 0);
  assertEvidence(nonNegativeInteger(report.maxDocuments) &&
    report.maxDocuments >= 1 && report.maxDocuments <= 10000);
  emptyArray(report.concurrentlySkipped);
  for (const field of [
    'plannedUpsertCount', 'plannedDeleteCount', 'appliedUpsertCount', 'appliedDeleteCount'
  ]) assertEvidence(nonNegativeInteger(report[field]));
  if (mode === 'dry-run') {
    assertEvidence(report.appliedUpsertCount === 0 && report.appliedDeleteCount === 0);
  }
  assertEvidence(exactKeys(report.audit, [
    'validCollaboratorCount', 'validIndexCount', 'missingIndexCount',
    'malformedCollaboratorCount', 'orphanCollaboratorCount',
    'malformedIndexCount', 'staleIndexCount', 'findingDetails',
    'findingDetailsTruncated', 'safeToUseShareIndex'
  ]));
  assertEvidence(nonNegativeInteger(report.audit.validCollaboratorCount));
  assertEvidence(nonNegativeInteger(report.audit.validIndexCount));
  if (requireClean) {
    if (mode === 'dry-run') {
      assertEvidence(report.plannedUpsertCount === 0 && report.plannedDeleteCount === 0);
    }
    assertEvidence(report.safeToUseShareIndex === true);
    zeroFields(report.audit, [
      'missingIndexCount', 'malformedCollaboratorCount', 'orphanCollaboratorCount',
      'malformedIndexCount', 'staleIndexCount'
    ]);
    assertEvidence(report.audit.findingDetailsTruncated === false);
    emptyArray(report.audit.findingDetails);
  }
}

function validateSetCounterGate(gate, manifest, contract) {
  assertEvidence(exactObject(gate));
  assertEvidence(gate.path === 'migration_gates/set_counters');
  assertEvidence(gate.locked === true && gate.projectId === contract.projectId);
  assertEvidence(gate.targetMode === contract.targetMode);
  assertEvidence(gate.lockId === manifest.locks.setCounters.lockId);
  assertEvidence(gate.updateTimeGeneration ===
    manifest.locks.setCounters.updateTimeGeneration);
}

function validateCounterLock(report, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'action', 'lockId',
    'requestedGeneration', 'status', 'safeToRunCounterMigration', 'gate'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'counter-gate-cli');
  assertEvidence(report.action === 'lock' && report.status === 'complete');
  assertEvidence(report.safeToRunCounterMigration === true);
  assertEvidence(report.lockId === manifest.locks.setCounters.lockId);
  assertEvidence(report.requestedGeneration === '');
  assertEvidence(exactKeys(report.gate, [
    'path', 'exists', 'locked', 'lockId', 'projectId', 'targetMode',
    'lockedByUid', 'updateTimeGeneration'
  ]));
  assertEvidence(report.gate.exists === true && boundedIdentity(report.gate.lockedByUid));
  validateSetCounterGate(report.gate, manifest, contract);
}

function validateCounterMigration(report, mode, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'mode', 'operation', 'plannedCount',
    'appliedCount', 'concurrentlySkipped', 'concurrentlySkippedCount',
    'status', 'safeToDeployStrictRules', 'gate', 'audit'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'set-counter-migration-cli');
  assertEvidence(report.operation === 'set-counter-backfill' && report.mode === mode);
  assertEvidence(report.status === 'complete' && report.safeToDeployStrictRules === true);
  assertEvidence(report.gate.lockId === manifest.locks.setCounters.lockId);
  validateSetCounterGate(report.gate, manifest, contract);
  assertEvidence(exactKeys(report.gate, [
    'path', 'locked', 'lockId', 'projectId', 'targetMode', 'updateTimeGeneration'
  ]));
  assertEvidence(nonNegativeInteger(report.plannedCount) &&
    nonNegativeInteger(report.appliedCount));
  if (mode === 'dry-run') {
    assertEvidence(report.appliedCount === 0 && report.plannedCount === 0);
  }
  assertEvidence(report.concurrentlySkippedCount === 0);
  emptyArray(report.concurrentlySkipped);
  assertEvidence(exactKeys(report.audit, [
    'totalSets', 'missingCollaboratorCount', 'missingImageCount',
    'invalidCounterCount', 'counterMismatchCount', 'counterMismatchIds',
    'orphanChildCount', 'orphanCollaboratorCount', 'orphanImageCount',
    'orphanChildDetails', 'orphanChildDetailsTruncated',
    'safeToDeployStrictRules'
  ]));
  assertEvidence(nonNegativeInteger(report.audit.totalSets));
  zeroFields(report.audit, [
    'missingCollaboratorCount', 'missingImageCount', 'invalidCounterCount',
    'counterMismatchCount', 'orphanChildCount', 'orphanCollaboratorCount',
    'orphanImageCount'
  ]);
  emptyArray(report.audit.counterMismatchIds);
  emptyArray(report.audit.orphanChildDetails);
  assertEvidence(report.audit.orphanChildDetailsTruncated === false);
  assertEvidence(report.audit.safeToDeployStrictRules === true);
}

function validateTeacherAudit(audit, requireClean) {
  assertEvidence(exactKeys(audit, [
    'totalLegacy', 'totalAllowances', 'invalidLegacyCount',
    'missingAuthUserCount', 'invalidAuthIdentityCount', 'missingAllowanceCount',
    'allowanceMismatchCount', 'legacyCompatibilityMismatchCount',
    'orphanAllowanceCount', 'issues', 'safe'
  ]));
  assertEvidence(nonNegativeInteger(audit.totalLegacy));
  assertEvidence(nonNegativeInteger(audit.totalAllowances));
  for (const field of [
    'invalidLegacyCount', 'missingAuthUserCount', 'invalidAuthIdentityCount',
    'missingAllowanceCount', 'allowanceMismatchCount',
    'legacyCompatibilityMismatchCount', 'orphanAllowanceCount'
  ]) assertEvidence(nonNegativeInteger(audit[field]));
  assertEvidence(Array.isArray(audit.issues));
  assertEvidence(typeof audit.safe === 'boolean');
  if (!requireClean) return;
  zeroFields(audit, [
    'invalidLegacyCount', 'missingAuthUserCount', 'invalidAuthIdentityCount',
    'missingAllowanceCount', 'allowanceMismatchCount',
    'legacyCompatibilityMismatchCount', 'orphanAllowanceCount'
  ]);
  assertEvidence(audit.safe === true);
  emptyArray(audit.issues);
}

function validateTeacherAccess(report, mode, manifest, contract, entry) {
  const keys = reportKeys([
    'operation', 'mode',
    'status', 'plannedCount', 'appliedCount', 'reclassifiedCount',
    'concurrentlySkipped', 'concurrentlySkippedCount',
    'safeToDeployStrictRules', 'audit'
  ]);
  if (mode === 'apply') keys.push('lock');
  assertEvidence(exactKeys(report, keys));
  validateReportIdentity(report, manifest, contract, entry, 'teacher-access-migration');
  assertEvidence(report.operation === 'teacher-access-status-backfill' && report.mode === mode);
  assertEvidence(report.status === 'complete' && nonNegativeInteger(report.plannedCount));
  assertEvidence(nonNegativeInteger(report.appliedCount) &&
    nonNegativeInteger(report.reclassifiedCount));
  assertEvidence(report.concurrentlySkippedCount === 0);
  emptyArray(report.concurrentlySkipped);
  validateTeacherAudit(report.audit, mode === 'apply');
  if (mode === 'dry-run') {
    assertEvidence(report.appliedCount === 0 && report.safeToDeployStrictRules === false);
    return;
  }
  assertEvidence(report.safeToDeployStrictRules === true);
  const lock = report.lock;
  assertEvidence(exactObject(lock) && lock.path === 'migration_gates/teacher_access_status');
  assertEvidence(lock.locked === true && lock.projectId === contract.projectId);
  assertEvidence(lock.targetMode === contract.targetMode && lock.status === 'complete');
  assertEvidence(lock.strictReady === true);
  assertEvidence(lock.lockToken === manifest.locks.teacherAccess.lockToken);
  assertEvidence(lock.updateTimeGeneration ===
    manifest.locks.teacherAccess.updateTimeGeneration);
  assertEvidence(lock.migrationGeneration ===
    manifest.locks.teacherAccess.migrationGeneration);
  assertEvidence(exactKeys(lock, [
    'path', 'locked', 'lockToken', 'projectId', 'targetMode', 'status',
    'strictReady', 'migrationGeneration', 'completedAt', 'completedByUid',
    'updateTimeGeneration'
  ]));
  assertEvidence(serializedFirestoreTimestamp(lock.completedAt));
  assertEvidence(boundedIdentity(lock.completedByUid));
}

function validateSessionAudit(audit, requireClean) {
  assertEvidence(exactKeys(audit, [
    'totalNonEndedSessions', 'missingCounterCount', 'invalidCounterCount',
    'counterMismatchCount', 'invalidStudentCount', 'issueSessionIds',
    'preflightNonEndedLegacyCount', 'safe'
  ]));
  assertEvidence(nonNegativeInteger(audit.totalNonEndedSessions));
  for (const field of [
    'missingCounterCount', 'invalidCounterCount', 'counterMismatchCount',
    'invalidStudentCount', 'preflightNonEndedLegacyCount'
  ]) assertEvidence(nonNegativeInteger(audit[field]));
  assertEvidence(Array.isArray(audit.issueSessionIds));
  assertEvidence(typeof audit.safe === 'boolean');
  if (!requireClean) return;
  zeroFields(audit, [
    'missingCounterCount', 'invalidCounterCount', 'counterMismatchCount',
    'invalidStudentCount', 'preflightNonEndedLegacyCount'
  ]);
  assertEvidence(audit.safe === true);
  emptyArray(audit.issueSessionIds);
}

function validateSessionCounters(report, mode, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'operation', 'mode',
    'status', 'plannedCount', 'appliedCount', 'reclassifiedCount',
    'concurrentlySkipped', 'concurrentlySkippedCount', 'lock', 'gate',
    'safeToDeployStrictRules', 'audit'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'session-counter-migration');
  assertEvidence(report.operation === 'session-counter-backfill-and-gate' && report.mode === mode);
  assertEvidence(report.status === 'complete' && nonNegativeInteger(report.plannedCount));
  assertEvidence(nonNegativeInteger(report.appliedCount) &&
    nonNegativeInteger(report.reclassifiedCount));
  assertEvidence(report.concurrentlySkippedCount === 0);
  emptyArray(report.concurrentlySkipped);
  const dryGatePlaceholder = exactKeys(report.gate, ['path', 'created']) &&
    report.gate.path === 'migration_gates/session_counters' && report.gate.created === false;
  const dryGateReadback = exactKeys(report.gate, [
    'path', 'created', 'complete', 'projectId', 'targetMode', 'rulesVersion',
    'updateTimeGeneration'
  ]);
  if (mode === 'dry-run') {
    validateSessionAudit(report.audit, false);
    assertEvidence(exactKeys(report.lock, ['path', 'locked']));
    assertEvidence(report.lock.path === 'migration_gates/session_counter_migration');
    assertEvidence(report.lock.locked === false);
    assertEvidence(dryGatePlaceholder || dryGateReadback);
    if (dryGateReadback) {
      assertEvidence(report.gate.created === true && report.gate.complete === true);
      assertEvidence(report.gate.projectId === contract.projectId &&
        report.gate.targetMode === contract.targetMode);
      assertEvidence(report.gate.rulesVersion === 'session-counters-v1');
      assertEvidence(report.gate.updateTimeGeneration ===
        manifest.locks.sessionCounters.gateGeneration);
    }
    assertEvidence(report.appliedCount === 0 && report.safeToDeployStrictRules === false);
    return;
  }
  assertEvidence(report.safeToDeployStrictRules === true);
  validateSessionAudit(report.audit, true);
  const lock = report.lock;
  assertEvidence(exactKeys(lock, [
    'path', 'locked', 'lockToken', 'projectId', 'targetMode',
    'updateTimeGeneration'
  ]) && lock.path ===
    'migration_gates/session_counter_migration');
  assertEvidence(lock.locked === true && lock.projectId === contract.projectId);
  assertEvidence(lock.targetMode === contract.targetMode);
  assertEvidence(lock.lockToken === manifest.locks.sessionCounters.lockToken);
  assertEvidence(lock.updateTimeGeneration ===
    manifest.locks.sessionCounters.updateTimeGeneration);
  const gate = report.gate;
  assertEvidence(exactKeys(gate, [
    'path', 'created', 'complete', 'projectId', 'targetMode', 'rulesVersion',
    'updateTimeGeneration'
  ]) && gate.path === 'migration_gates/session_counters');
  assertEvidence(gate.created === true && gate.complete === true);
  assertEvidence(gate.projectId === contract.projectId && gate.targetMode === contract.targetMode);
  assertEvidence(gate.rulesVersion === 'session-counters-v1');
  assertEvidence(gate.updateTimeGeneration === manifest.locks.sessionCounters.gateGeneration);
}

function validatePublicAudit(report, manifest, contract, entry) {
  assertEvidence(exactKeys(report, reportKeys([
    'kind', 'dryRun', 'generatedAt',
    'maxDocuments', 'scanned', 'complete', 'findings',
    'safeToDeployPublicLibrary'
  ])));
  validateReportIdentity(report, manifest, contract, entry, 'public-library-audit-cli');
  assertEvidence(report.kind === 'public-quiz-library-privacy-audit');
  assertEvidence(report.dryRun === true && report.complete === true);
  assertEvidence(report.safeToDeployPublicLibrary === true);
  assertEvidence(nonNegativeInteger(report.maxDocuments) &&
    report.maxDocuments >= 1 && report.maxDocuments <= 10000);
  assertEvidence(exactKeys(report.scanned, [
    'sources', 'locks', 'parents', 'audits', 'videos', 'questions', 'images',
    'bindings', 'reads'
  ]));
  for (const value of Object.values(report.scanned)) {
    assertEvidence(nonNegativeInteger(value));
  }
  emptyArray(report.findings);
  assertEvidence(report.generatedAt === entry.capturedAt);
  const generatedAt = timestampNanoseconds(report.generatedAt);
  assertEvidence(generatedAt >= timestampNanoseconds(manifest.releaseWindow.quiescenceStartedAt));
  assertEvidence(generatedAt <= timestampNanoseconds(manifest.releaseWindow.sealedAt));
}

function validateIndexReadiness(report, contract, manifest, entry) {
  const keys = reportKeys([
    'operation', 'mode', 'status', 'indexName', 'indexState', 'indexDefinition',
    'firestoreIndexesSha256', 'requiredIndexCount',
    'readyIndexCount', 'allRequiredIndexesReady', 'pendingCount', 'failedCount',
    'writeCount', 'error'
  ]);
  assertEvidence(exactKeys(report, keys));
  validateReportIdentity(
    report, manifest, contract, entry, 'firestore-index-readiness-evidence'
  );
  assertEvidence(report.operation === 'exact-index-readback' && report.mode === 'get-only');
  assertEvidence(report.status === 'complete' && report.error === null);
  assertEvidence(report.indexName === REQUIRED_INDEX_NAME && report.indexState === 'READY');
  assertEvidence(exactKeys(report.indexDefinition, ['queryScope', 'fields']));
  assertEvidence(report.indexDefinition.queryScope === 'COLLECTION');
  assertEvidence(JSON.stringify(report.indexDefinition.fields) ===
    JSON.stringify(REQUIRED_INDEX_FIELDS));
  assertEvidence(report.firestoreIndexesSha256 === contract.firestoreIndexesSha256);
  assertEvidence(report.requiredIndexCount === 1 && report.readyIndexCount === 1);
  assertEvidence(report.allRequiredIndexesReady === true);
  assertEvidence(report.pendingCount === 0 && report.failedCount === 0 &&
    report.writeCount === 0);
}

function validateReport(name, report, manifest, contract, entry) {
  const validators = {
    r0ProductionRulesProbe: () => validateCompilerProbe(report, manifest, contract, entry),
    r0RulesApiDiagnosis: () => validateDiagnosis(report, manifest, contract, entry),
    r1Quiescence: () => validateQuiescence(report, contract, manifest, entry),
    r2LifecycleDryBefore: () => validateLifecycle(
      report, 'dry-run', false, manifest, contract, entry
    ),
    r2LifecycleApply: () => validateLifecycle(
      report, 'apply', true, manifest, contract, entry
    ),
    r2LifecycleDryAfter: () => validateLifecycle(
      report, 'dry-run', true, manifest, contract, entry
    ),
    r3SharesDryBefore: () => validateShares(
      report, 'dry-run', false, manifest, contract, entry
    ),
    r3SharesApply: () => validateShares(
      report, 'apply', true, manifest, contract, entry
    ),
    r3SharesDryAfter: () => validateShares(
      report, 'dry-run', true, manifest, contract, entry
    ),
    r4CounterLock: () => validateCounterLock(report, manifest, contract, entry),
    r4CounterApply: () => validateCounterMigration(
      report, 'apply', manifest, contract, entry
    ),
    r4CounterAudit: () => validateCounterMigration(
      report, 'dry-run', manifest, contract, entry
    ),
    r5TeacherAccessDry: () => validateTeacherAccess(
      report, 'dry-run', manifest, contract, entry
    ),
    r5TeacherAccessApply: () => validateTeacherAccess(
      report, 'apply', manifest, contract, entry
    ),
    r6SessionCountersDry: () => validateSessionCounters(
      report, 'dry-run', manifest, contract, entry
    ),
    r6SessionCountersApply: () => validateSessionCounters(
      report, 'apply', manifest, contract, entry
    ),
    r7PublicLibraryAudit: () => validatePublicAudit(report, manifest, contract, entry),
    r8IndexReadiness: () => validateIndexReadiness(report, contract, manifest, entry)
  };
  validators[name]();
}

function pathIdentity(value) {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function lexicalPathSegments(value) {
  return String(value).replace(/\\/g, '/').split('/');
}

function validateEvidenceMap(manifest, contract, accessOptions = {}) {
  const access = typeof accessOptions === 'function'
    ? { readFile: accessOptions } : accessOptions || {};
  const evidenceRoot = access.evidenceRoot || EVIDENCE_ROOT;
  const realpath = typeof access.realpath === 'function'
    ? access.realpath : fs.realpathSync.native;
  const lstat = typeof access.lstat === 'function' ? access.lstat : fs.lstatSync;
  const readFile = typeof access.readFile === 'function' ? access.readFile : fs.readFileSync;
  let realRoot;
  try {
    realRoot = realpath(evidenceRoot);
  } catch (_) {
    failEvidence();
  }
  assertEvidence(pathIdentity(realRoot) === pathIdentity(evidenceRoot));
  assertEvidence(exactObject(manifest.releaseWindow));
  const window = manifest.releaseWindow;
  assertEvidence(UUID_PATTERN.test(window.windowId) && UUID_PATTERN.test(window.controlId));
  assertEvidence(window.windowId !== window.controlId);
  const openedAt = timestampNanoseconds(window.openedAt);
  const quiescenceAt = timestampNanoseconds(window.quiescenceStartedAt);
  const sealedAt = timestampNanoseconds(window.sealedAt);
  assertEvidence(openedAt < quiescenceAt && quiescenceAt < sealedAt);
  assertEvidence(exactObject(manifest.evidence));
  assertEvidence(JSON.stringify(Object.keys(manifest.evidence).sort()) ===
    JSON.stringify([...EVIDENCE_NAMES].sort()));

  const seenPaths = new Set();
  let previousCapturedAt = null;
  for (const name of EVIDENCE_NAMES) {
    const entry = manifest.evidence[name];
    assertEvidence(exactKeys(entry, ['path', 'sha256', 'windowId', 'controlId', 'capturedAt']));
    assertEvidence(typeof entry.path === 'string' && entry.path.length > 0);
    assertEvidence(path.isAbsolute(entry.path));
    const segments = lexicalPathSegments(entry.path);
    assertEvidence(!segments.includes('.') && !segments.includes('..'));
    const resolvedPath = path.resolve(entry.path);
    const normalizedPath = resolvedPath.replace(/\\/g, '/');
    assertEvidence(R23_PATH_PATTERN.test(normalizedPath));
    assertEvidence(pathIdentity(path.dirname(resolvedPath)) === pathIdentity(realRoot));
    let fileState;
    let realPath;
    try {
      fileState = lstat(resolvedPath);
      realPath = realpath(resolvedPath);
    } catch (_) {
      failEvidence();
    }
    assertEvidence(fileState && typeof fileState.isFile === 'function' && fileState.isFile());
    assertEvidence(typeof fileState.isSymbolicLink !== 'function' ||
      fileState.isSymbolicLink() === false);
    assertEvidence(pathIdentity(realPath) === pathIdentity(resolvedPath));
    assertEvidence(pathIdentity(path.dirname(realPath)) === pathIdentity(realRoot));
    const realIdentity = pathIdentity(realPath);
    assertEvidence(!seenPaths.has(realIdentity));
    seenPaths.add(realIdentity);
    assertEvidence(SHA_PATTERN.test(entry.sha256));
    assertEvidence(entry.windowId === window.windowId && entry.controlId === window.controlId);
    const capturedAt = timestampNanoseconds(entry.capturedAt);
    assertEvidence(capturedAt >= openedAt && capturedAt <= sealedAt);
    if (name.startsWith('r0')) assertEvidence(capturedAt < quiescenceAt);
    else assertEvidence(capturedAt >= quiescenceAt);
    if (previousCapturedAt !== null) assertEvidence(capturedAt > previousCapturedAt);
    previousCapturedAt = capturedAt;

    let raw;
    try {
      raw = readFile(realPath);
    } catch (_) {
      failEvidence();
    }
    assertEvidence(Buffer.isBuffer(raw) || typeof raw === 'string');
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    assertEvidence(digest === entry.sha256);
    let report;
    try {
      report = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
    } catch (_) {
      failEvidence();
    }
    validateReport(name, report, manifest, contract, entry);
  }
  return {
    evidenceWindowId: window.windowId,
    controlId: window.controlId,
    reportCount: EVIDENCE_NAMES.length
  };
}

module.exports = { EVIDENCE_NAMES, EVIDENCE_ROOT, validateEvidenceMap };
