#!/usr/bin/env node
'use strict';

const path = require('node:path');
const migration = require('../teacher-access-migration.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function parseArgs(argv) {
  const result = {
    projectId: '', targetMode: 'production', adminUid: '', apply: false,
    confirmProject: '', output: '', lockToken: '', expectedGeneration: '',
    expectedMigrationGeneration: '', unlock: false, verifyLock: false
  };
  const fields = {
    '--project': 'projectId', '--target-mode': 'targetMode', '--admin-uid': 'adminUid',
    '--confirm-project': 'confirmProject', '--output': 'output',
    '--lock-token': 'lockToken', '--expected-generation': 'expectedGeneration',
    '--expected-migration-generation': 'expectedMigrationGeneration'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { result.apply = true; continue; }
    if (argument === '--unlock') { result.unlock = true; continue; }
    if (argument === '--verify-lock') { result.verifyLock = true; continue; }
    const field = fields[argument];
    if (!field) throw new Error('Unknown argument: ' + argument);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value.');
    result[field] = value;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (!result.adminUid) throw new Error('--admin-uid is required.');
  if (!['production', 'emulator'].includes(result.targetMode)) {
    throw new Error('--target-mode must be production or emulator.');
  }
  if (result.apply && result.confirmProject !== result.projectId) {
    throw new Error('--apply requires an exact --confirm-project.');
  }
  if ([result.apply, result.unlock, result.verifyLock].filter(Boolean).length > 1) {
    throw new Error('--apply, --unlock and --verify-lock are mutually exclusive.');
  }
  if (result.apply && !result.lockToken) {
    throw new Error('--apply requires an explicit unpredictable --lock-token.');
  }
  if ((result.unlock || result.verifyLock) && (!result.lockToken || !result.expectedGeneration)) {
    throw new Error('--unlock/--verify-lock require exact --lock-token and --expected-generation.');
  }
  if (result.verifyLock && !result.expectedMigrationGeneration) {
    throw new Error('--verify-lock requires exact --expected-migration-generation.');
  }
  if (result.unlock && result.confirmProject !== result.projectId) {
    throw new Error('--unlock requires an exact --confirm-project.');
  }
  return result;
}

function evaluateAccessReleaseVerification(gate, options) {
  return migration.evaluateTeacherAccessReleaseEvidence(gate, options);
}

function validateTarget(options, environment = process.env) {
  const firestoreHost = environment.FIRESTORE_EMULATOR_HOST || '';
  const authHost = environment.FIREBASE_AUTH_EMULATOR_HOST || '';
  if (options.targetMode === 'emulator') {
    if (!/^demo-/.test(options.projectId)) throw new Error('Emulator mode requires a demo-* project.');
    if (firestoreHost !== '127.0.0.1:8080' || authHost !== '127.0.0.1:9099') {
      throw new Error('Emulator mode requires exact Firestore and Auth emulator hosts.');
    }
    return { targetMode: 'emulator', firestoreHost, authHost };
  }
  if (firestoreHost || authHost) {
    throw new Error('Production mode refuses stale Firestore/Auth emulator environment variables.');
  }
  return { targetMode: 'production', firestoreHost: '', authHost: '' };
}

function productionDependencies() {
  return {
    reserveReport,
    async initialize(projectId) {
      const admin = require('firebase-admin');
      const app = admin.initializeApp({ projectId });
      return {
        db: admin.firestore(app), auth: admin.auth(app),
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
        close() { return app.delete(); }
      };
    },
    runTeacherAccessMigration: migration.runTeacherAccessMigration,
    unlockTeacherAccessGate: migration.unlockTeacherAccessGate,
    verifyTeacherAccessGate: migration.verifyTeacherAccessGate,
    verifyTeacherAccessReleaseState: migration.verifyTeacherAccessReleaseState,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function failureReport(options, targetMode, error) {
  if (error && error.partialReport) return {
    ...error.partialReport, targetMode, safeToDeployStrictRules: false
  };
  return {
    tool: 'teacher-access-migration-cli', schemaVersion: 1,
    projectId: options.projectId, targetMode,
    mode: options.unlock ? 'unlock' : options.verifyLock ? 'verify-lock' : options.apply ? 'apply' : 'dry-run',
    operation: options.unlock ? 'teacher-access-status-unlock' :
      options.verifyLock ? 'teacher-access-status-lock-verification' : 'teacher-access-status-backfill',
    status: 'failed', safeToDeployStrictRules: false,
    error: String(error && error.message || error)
  };
}

async function main(argv = process.argv.slice(2), dependencies = productionDependencies()) {
  const options = parseArgs(argv);
  const target = validateTarget(options, dependencies.environment || process.env);
  const output = options.output || path.resolve(
    'teacher-access-migration-' + options.projectId + '-' + Date.now() + '.json'
  );
  const reservation = dependencies.reserveReport(output, JSON.stringify({
    tool: 'teacher-access-migration-cli', schemaVersion: 1,
    projectId: options.projectId, targetMode: target.targetMode,
    mode: options.unlock ? 'unlock' : options.verifyLock ? 'verify-lock' : options.apply ? 'apply' : 'dry-run',
    operation: options.unlock ? 'teacher-access-status-unlock' :
      options.verifyLock ? 'teacher-access-status-lock-verification' : 'teacher-access-status-backfill',
    status: 'reserved-fail-closed', safeToDeployStrictRules: false
  }, null, 2) + '\n');
  let services;
  let report;
  try {
    services = await dependencies.initialize(options.projectId);
    if (options.unlock) {
      const gate = await dependencies.unlockTeacherAccessGate({
        db: services.db, projectId: options.projectId, targetMode: target.targetMode,
        adminUid: options.adminUid, lockToken: options.lockToken,
        expectedGeneration: options.expectedGeneration,
        serverTimestamp: services.serverTimestamp
      });
      report = {
        tool: 'teacher-access-migration-cli', schemaVersion: 1,
        projectId: options.projectId, targetMode: target.targetMode, mode: 'unlock',
        operation: 'teacher-access-status-unlock', status: 'complete',
        safeToDeployStrictRules: false, gate
      };
    } else if (options.verifyLock) {
      const verification = await dependencies.verifyTeacherAccessReleaseState({
        db: services.db, auth: services.auth,
        projectId: options.projectId, targetMode: target.targetMode,
        adminUid: options.adminUid, lockToken: options.lockToken,
        expectedGeneration: options.expectedGeneration,
        expectedMigrationGeneration: options.expectedMigrationGeneration
      });
      report = {
        tool: 'teacher-access-migration-cli', schemaVersion: 1,
        projectId: options.projectId, targetMode: target.targetMode, mode: 'verify-lock',
        operation: 'teacher-access-status-lock-verification', status: verification.status,
        safeToDeployStrictRules: verification.safeToDeployStrictRules,
        verificationReason: verification.verificationReason,
        gate: verification.gate,
        ...(verification.audit ? { audit: verification.audit } : {}),
        ...(verification.auditError ? { auditError: verification.auditError } : {})
      };
    } else {
      report = await dependencies.runTeacherAccessMigration({
        db: services.db, auth: services.auth, projectId: options.projectId,
        targetMode: target.targetMode, adminUid: options.adminUid,
        apply: options.apply, confirmProject: options.confirmProject,
        lockToken: options.lockToken, serverTimestamp: services.serverTimestamp
      });
    }
    report.targetMode = target.targetMode;
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    const failure = failureReport(options, target.targetMode, error);
    try {
      await reservation.commit(JSON.stringify(failure, null, 2) + '\n');
    } catch (publicationError) {
      throw new Error(
        String(error && error.message || error) + '; fail-closed report remains at ' +
        (reservation.failClosedPath || output + '.reserved') + '; publication error: ' +
        String(publicationError && publicationError.message || publicationError),
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (services && typeof services.close === 'function') await services.close();
  }
  dependencies.writeLine(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch(error => {
  process.stderr.write('Teacher access migration failed: ' + String(error && error.message || error) + '\n');
  process.exitCode = 1;
});

module.exports = {
  evaluateAccessReleaseVerification, failureReport, main, parseArgs,
  productionDependencies, reserveReport, validateTarget
};
