#!/usr/bin/env node
'use strict';

const path = require('node:path');
const migration = require('../collaborator-share-migration.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function parseArgs(argv) {
  const result = {
    projectId: '',
    targetMode: 'production',
    apply: false,
    confirmProject: '',
    output: '',
    maxDocuments: 5000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      result.apply = true;
      continue;
    }
    const field = {
      '--project': 'projectId',
      '--target-mode': 'targetMode',
      '--confirm-project': 'confirmProject',
      '--output': 'output',
      '--max-documents': 'maxDocuments'
    }[argument];
    if (!field) throw new Error('Unknown argument: ' + argument);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value.');
    result[field] = field === 'maxDocuments' ? Number(value) : value;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (!['production', 'emulator'].includes(result.targetMode)) {
    throw new Error('--target-mode must be production or emulator.');
  }
  if (!Number.isInteger(result.maxDocuments) ||
      result.maxDocuments < 1 || result.maxDocuments > 10000) {
    throw new Error('--max-documents must be between 1 and 10000.');
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
    if (!/^demo-/.test(options.projectId)) {
      throw new Error('Emulator mode requires a demo-* project.');
    }
    if (firestoreHost !== '127.0.0.1:8080') {
      throw new Error(
        'Emulator mode requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8080.'
      );
    }
    return { targetMode: 'emulator', firestoreHost };
  }
  if (firestoreHost || authHost) {
    throw new Error('Production mode refuses stale Firestore/Auth emulator environment variables.');
  }
  return { targetMode: 'production', firestoreHost: '' };
}

function productionDependencies() {
  return {
    reserveReport,
    async initialize(projectId) {
      const admin = require('firebase-admin');
      const app = admin.initializeApp({ projectId });
      return { db: admin.firestore(app), close() { return app.delete(); } };
    },
    runCollaboratorShareMigration: migration.runCollaboratorShareMigration,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function nonPiiSummary(report) {
  const value = report || {};
  const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
  return [
    'collaborator-share-migration',
    'status=' + String(value.status || 'unknown'),
    'safeToUseShareIndex=' + String(value.safeToUseShareIndex === true),
    'plannedUpserts=' + count('plannedUpsertCount'),
    'plannedDeletes=' + count('plannedDeleteCount'),
    'appliedUpserts=' + count('appliedUpsertCount'),
    'appliedDeletes=' + count('appliedDeleteCount'),
    'concurrentlySkipped=' + count('concurrentlySkippedCount')
  ].join(' ');
}

async function main(argv = process.argv.slice(2), dependencies = productionDependencies()) {
  const options = parseArgs(argv);
  const target = validateTarget(options, dependencies.environment || process.env);
  const output = options.output || path.resolve(
    'collaborator-share-migration-' + options.projectId + '-' + Date.now() + '.json'
  );
  const reservation = dependencies.reserveReport(output, JSON.stringify({
    tool: 'collaborator-share-migration',
    schemaVersion: 1,
    projectId: options.projectId,
    targetMode: target.targetMode,
    mode: options.apply ? 'apply' : 'dry-run',
    operation: 'collaborator-share-backfill',
    maxDocuments: options.maxDocuments,
    plannedUpsertCount: 0,
    plannedDeleteCount: 0,
    appliedUpsertCount: 0,
    appliedDeleteCount: 0,
    concurrentlySkipped: [],
    concurrentlySkippedCount: 0,
    status: 'reserved-fail-closed',
    safeToUseShareIndex: false
  }, null, 2) + '\n');
  let services;
  try {
    services = await dependencies.initialize(options.projectId);
    const report = await dependencies.runCollaboratorShareMigration({
      db: services.db,
      projectId: options.projectId,
      targetMode: target.targetMode,
      apply: options.apply,
      confirmProject: options.confirmProject,
      maxDocuments: options.maxDocuments
    });
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    try {
      dependencies.writeLine(nonPiiSummary(report));
    } catch (_) {
      // The committed durable report is authoritative.
    }
    return report;
  } catch (error) {
    const report = error.partialReport || {
      tool: 'collaborator-share-migration',
      schemaVersion: 1,
      projectId: options.projectId,
      targetMode: target.targetMode,
      mode: options.apply ? 'apply' : 'dry-run',
      operation: 'collaborator-share-backfill',
      maxDocuments: options.maxDocuments,
      plannedUpsertCount: 0,
      plannedDeleteCount: 0,
      appliedUpsertCount: 0,
      appliedDeleteCount: 0,
      concurrentlySkipped: [],
      concurrentlySkippedCount: 0,
      status: 'failed',
      safeToUseShareIndex: false,
      error: String(error && error.message || error)
    };
    try {
      await reservation.commit(JSON.stringify(report, null, 2) + '\n');
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
    if (services && services.close) await services.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(
      'Collaborator share migration failed: ' + String(error && error.message || error) + '\n'
    );
    process.exitCode = 1;
  });
}

module.exports = { main, nonPiiSummary, parseArgs, productionDependencies, validateTarget };
