'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../scripts/migrate-lifecycle-state.js');
const shares = require('../scripts/migrate-collaborator-shares.js');
const counterGate = require('../scripts/manage-counter-gate.js');
const setCounters = require('../scripts/migrate-set-counters.js');
const teacherAccess = require('../scripts/migrate-teacher-access-status.js');
const sessionCounters = require('../scripts/migrate-session-counters.js');
const publicAudit = require('../scripts/audit-public-library.js');
const { parseAuditArguments } = require('../public-library-audit.js');
const {
  validateEvidenceIdentityOptions
} = require('../release-evidence-identity.js');

const PROJECT = 'video-quiz-65798';
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const CAPTURED_AT = '2026-08-23T05:10:00.123456789Z';

function identityArgs() {
  return ['--window-id', WINDOW_ID, '--control-id', CONTROL_ID];
}

function reservationRuntime(overrides) {
  const durable = [];
  return {
    durable,
    runtime: {
      environment: {},
      now: () => CAPTURED_AT,
      reserveReport() {
        return {
          failClosedPath: 'report.json.reserved',
          commit(contents) { durable.push(JSON.parse(contents)); }
        };
      },
      writeLine() {},
      ...overrides
    }
  };
}

function assertIdentity(report, tool) {
  assert.equal(report.tool, tool);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.projectId, PROJECT);
  assert.equal(report.targetMode, 'production');
  assert.equal(report.windowId, WINDOW_ID);
  assert.equal(report.controlId, CONTROL_ID);
  assert.equal(report.capturedAt, CAPTURED_AT);
}

test('every R2-R7 production producer requires report-authored window and control IDs', () => {
  const cases = [
    [lifecycle.parseArgs, ['--project', PROJECT]],
    [shares.parseArgs, ['--project', PROJECT]],
    [counterGate.parseArgs, ['--action', 'status', '--project', PROJECT]],
    [setCounters.parseArgs, ['--project', PROJECT]],
    [teacherAccess.parseArgs, ['--project', PROJECT, '--admin-uid', 'admin-a']],
    [sessionCounters.parseArgs, ['--project', PROJECT, '--admin-uid', 'admin-a']],
    [argv => parseAuditArguments(argv, {}), [
      '--project', PROJECT, '--target-mode', 'production', '--max-documents', '10'
    ]]
  ];
  for (const [parse, argv] of cases) {
    assert.throws(() => parse(argv), /window-id|control-id/i);
  }
});

test('production evidence requires distinct window and control identities', () => {
  assert.throws(() => validateEvidenceIdentityOptions({
    targetMode: 'production', windowId: WINDOW_ID, controlId: WINDOW_ID
  }), /distinct|different/i);
});

test('every R2-R7 producer overwrites returned identity with its immutable CLI capture', async () => {
  {
    const { runtime, durable } = reservationRuntime({
      initialize: async () => ({ db: {}, close() {} }),
      runLifecycleBackfill: async () => ({
        projectId: 'stale-project', targetMode: 'emulator', tool: 'manual',
        schemaVersion: 99, windowId: 'stale', controlId: 'stale', capturedAt: 'stale',
        mode: 'dry-run', operation: 'lifecycle-backfill', status: 'complete'
      })
    });
    const report = await lifecycle.main([
      '--project', PROJECT, ...identityArgs(), '--output', 'lifecycle.json'
    ], runtime);
    assertIdentity(report, 'lifecycle-migration-cli');
    assertIdentity(durable.at(-1), 'lifecycle-migration-cli');
  }
  {
    const { runtime, durable } = reservationRuntime({
      initialize: async () => ({ db: {}, close() {} }),
      runCollaboratorShareMigration: async () => ({
        projectId: PROJECT, targetMode: 'production', mode: 'dry-run',
        operation: 'collaborator-share-backfill', status: 'complete'
      })
    });
    const report = await shares.main([
      '--project', PROJECT, ...identityArgs(), '--output', 'shares.json'
    ], runtime);
    assertIdentity(report, 'collaborator-share-migration');
    assertIdentity(durable.at(-1), 'collaborator-share-migration');
  }
  {
    const { runtime, durable } = reservationRuntime({
      createLockId: () => 'generated-lock',
      initialize: async () => ({ db: {}, serverTimestamp() {}, close() {} }),
      runCounterGateOperation: async () => ({ gate: { locked: true } })
    });
    const report = await counterGate.main([
      '--action', 'lock', '--project', PROJECT, '--confirm-project', PROJECT,
      '--admin-uid', 'admin-a', ...identityArgs(), '--output', 'counter-gate.json'
    ], runtime);
    assertIdentity(report, 'counter-gate-cli');
    assertIdentity(durable.at(-1), 'counter-gate-cli');
  }
  {
    const { runtime, durable } = reservationRuntime({
      initialize: async () => ({ db: {}, close() {} }),
      runCounterBackfill: async () => ({
        projectId: PROJECT, targetMode: 'production', mode: 'dry-run',
        operation: 'set-counter-backfill', status: 'complete'
      })
    });
    const report = await setCounters.main([
      '--project', PROJECT, ...identityArgs(), '--output', 'set-counters.json'
    ], runtime);
    assertIdentity(report, 'set-counter-migration-cli');
    assertIdentity(durable.at(-1), 'set-counter-migration-cli');
  }
  {
    const { runtime, durable } = reservationRuntime({
      initialize: async () => ({ db: {}, auth: {}, serverTimestamp() {}, close() {} }),
      runTeacherAccessMigration: async () => ({
        projectId: PROJECT, targetMode: 'production', mode: 'dry-run',
        operation: 'teacher-access-status-backfill', status: 'complete'
      })
    });
    const report = await teacherAccess.main([
      '--project', PROJECT, '--admin-uid', 'admin-a', ...identityArgs(),
      '--output', 'teacher-access.json'
    ], runtime);
    assertIdentity(report, 'teacher-access-migration');
    assertIdentity(durable.at(-1), 'teacher-access-migration');
  }
  {
    const { runtime, durable } = reservationRuntime({
      initialize: async () => ({
        db: {}, serverTimestamp() {}, deleteField() {}, close() {}
      }),
      runSessionCounterMigration: async () => ({
        projectId: PROJECT, targetMode: 'production', mode: 'dry-run',
        operation: 'session-counter-backfill-and-gate', status: 'complete'
      })
    });
    const report = await sessionCounters.main([
      '--project', PROJECT, '--admin-uid', 'admin-a', ...identityArgs(),
      '--output', 'session-counters.json'
    ], runtime);
    assertIdentity(report, 'session-counter-migration');
    assertIdentity(durable.at(-1), 'session-counter-migration');
  }
  {
    const { runtime, durable } = reservationRuntime({
      initialize: async () => ({ db: {} }),
      auditPublicLibrary: async () => ({
        kind: 'public-quiz-library-privacy-audit', dryRun: true,
        maxDocuments: 10, complete: true, findings: [], safeToDeployPublicLibrary: true
      })
    });
    const { report } = await publicAudit.main([
      '--project', PROJECT, '--target-mode', 'production', '--max-documents', '10',
      ...identityArgs(), '--output', 'public-audit.json'
    ], runtime);
    assertIdentity(report, 'public-library-audit-cli');
    assertIdentity(durable.at(-1), 'public-library-audit-cli');
  }
});
