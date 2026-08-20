#!/usr/bin/env node
'use strict';

const path = require('node:path');
const migration = require('../session-counter-migration.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function parseArgs(argv) {
  const result = {
    projectId: '', targetMode: 'production', adminUid: '', apply: false,
    confirmProject: '', output: ''
  };
  const fields = {
    '--project': 'projectId', '--target-mode': 'targetMode', '--admin-uid': 'adminUid',
    '--confirm-project': 'confirmProject', '--output': 'output'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { result.apply = true; continue; }
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
  return result;
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
        db: admin.firestore(app),
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
        deleteField: () => admin.firestore.FieldValue.delete(),
        close() { return app.delete(); }
      };
    },
    runSessionCounterMigration: migration.runSessionCounterMigration,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

async function main(argv = process.argv.slice(2), dependencies = productionDependencies()) {
  const options = parseArgs(argv);
  const target = validateTarget(options, dependencies.environment || process.env);
  const output = options.output || path.resolve(
    'session-counter-migration-' + options.projectId + '-' + Date.now() + '.json'
  );
  const reservation = dependencies.reserveReport(output, JSON.stringify({
    tool: 'session-counter-migration-cli', schemaVersion: 1,
    projectId: options.projectId, targetMode: target.targetMode,
    mode: options.apply ? 'apply' : 'dry-run', operation: 'session-counter-backfill-and-gate',
    status: 'reserved-fail-closed', safeToDeployStrictRules: false,
    gate: { path: 'migration_gates/session_counters', created: false }
  }, null, 2) + '\n');
  let services;
  let report;
  try {
    services = await dependencies.initialize(options.projectId);
    report = await dependencies.runSessionCounterMigration({
      db: services.db, projectId: options.projectId, targetMode: target.targetMode,
      adminUid: options.adminUid, apply: options.apply,
      confirmProject: options.confirmProject,
      serverTimestamp: services.serverTimestamp, deleteField: services.deleteField
    });
    report.targetMode = target.targetMode;
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    const failure = error && error.partialReport ? {
      ...error.partialReport, targetMode: target.targetMode, safeToDeployStrictRules: false
    } : {
      tool: 'session-counter-migration-cli', schemaVersion: 1,
      projectId: options.projectId, targetMode: target.targetMode,
      mode: options.apply ? 'apply' : 'dry-run', operation: 'session-counter-backfill-and-gate',
      status: 'failed', safeToDeployStrictRules: false,
      gate: { path: 'migration_gates/session_counters', created: false },
      error: String(error && error.message || error)
    };
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
  process.stderr.write('Session counter migration failed: ' + String(error && error.message || error) + '\n');
  process.exitCode = 1;
});

module.exports = { main, parseArgs, productionDependencies, reserveReport, validateTarget };
