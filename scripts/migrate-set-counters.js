#!/usr/bin/env node
'use strict';

const path = require('node:path');
const migration = require('../counter-migration.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function parseArgs(argv) {
  const result = {
    projectId: '', apply: false, confirmProject: '', output: '',
    targetMode: 'production', gateId: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--apply') { result.apply = true; continue; }
    const field = {
      '--project': 'projectId', '--confirm-project': 'confirmProject', '--output': 'output',
      '--target-mode': 'targetMode', '--gate-id': 'gateId'
    }[argument];
    if (!field) throw new Error('Unknown argument: ' + argument);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value.');
    result[field] = value;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (!['production', 'emulator'].includes(result.targetMode)) throw new Error('--target-mode must be production or emulator.');
  if (result.apply && result.confirmProject !== result.projectId) throw new Error('--apply requires an exact --confirm-project.');
  if (result.apply && !result.gateId) throw new Error('--apply requires an exact --gate-id.');
  return result;
}

function validateTarget(options, environment = process.env) {
  const firestoreHost = environment.FIRESTORE_EMULATOR_HOST || '';
  const authHost = environment.FIREBASE_AUTH_EMULATOR_HOST || '';
  if (options.targetMode === 'emulator') {
    if (!/^demo-/.test(options.projectId)) throw new Error('Emulator mode requires a demo-* project.');
    if (firestoreHost !== '127.0.0.1:8080' || authHost !== '127.0.0.1:9099') {
      throw new Error('Emulator mode requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 and FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099.');
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
      return { db: admin.firestore(app), close() { return app.delete(); } };
    },
    runCounterBackfill: migration.runCounterBackfill,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

async function main(argv = process.argv.slice(2), dependencies = productionDependencies()) {
  const options = parseArgs(argv);
  const target = validateTarget(options, dependencies.environment || process.env);
  const output = options.output || path.resolve('set-counter-migration-' + options.projectId + '-' + Date.now() + '.json');
  const reservation = dependencies.reserveReport(output, JSON.stringify({
    tool: 'set-counter-migration-cli', schemaVersion: 1, projectId: options.projectId,
    mode: options.apply ? 'apply' : 'dry-run', operation: 'set-counter-backfill',
    targetMode: target.targetMode, gateId: options.gateId,
    plannedCount: 0, appliedCount: 0, concurrentlySkipped: [], concurrentlySkippedCount: 0,
    status: 'reserved-fail-closed', safeToDeployStrictRules: false
  }, null, 2) + '\n');
  let services;
  try {
    services = await dependencies.initialize(options.projectId);
    const report = await dependencies.runCounterBackfill({
      db: services.db, projectId: options.projectId, apply: options.apply,
      confirmProject: options.confirmProject, targetMode: target.targetMode,
      gateId: options.gateId
    });
    report.targetMode = target.targetMode;
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    try { dependencies.writeLine(JSON.stringify(report, null, 2)); } catch (_) { /* committed report is authoritative */ }
    return report;
  } catch (error) {
    const report = error.partialReport || {
      tool: 'set-counter-migration-cli', schemaVersion: 1, projectId: options.projectId,
      mode: options.apply ? 'apply' : 'dry-run', operation: 'set-counter-backfill',
      targetMode: target.targetMode, gateId: options.gateId,
      plannedCount: 0, appliedCount: 0, concurrentlySkipped: [], concurrentlySkippedCount: 0,
      status: 'failed', safeToDeployStrictRules: false,
      error: String(error && error.message || error)
    };
    report.targetMode = target.targetMode;
    try {
      await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    } catch (publicationError) {
      throw new Error(
        String(error && error.message || error) + '; fail-closed report remains at ' +
        (reservation.failClosedPath || output + '.reserved') + '; publication error: ' +
        String(publicationError && publicationError.message || publicationError), { cause: error }
      );
    }
    throw error;
  } finally {
    if (services && services.close) await services.close();
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write('Set counter migration failed: ' + String(error && error.message || error) + '\n');
  process.exitCode = 1;
});

module.exports = { main, parseArgs, productionDependencies, validateTarget };
