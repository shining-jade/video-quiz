#!/usr/bin/env node
'use strict';

const path = require('node:path');
const migration = require('../lifecycle-migration.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function parseArgs(argv) {
  const result = { projectId: '', apply: false, confirmProject: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { result.apply = true; continue; }
    const fields = new Map([
      ['--project', 'projectId'], ['--confirm-project', 'confirmProject'], ['--output', 'output']
    ]);
    const field = fields.get(argument);
    if (!field) throw new Error('Unknown argument: ' + argument);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value.');
    result[field] = value;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (result.apply && result.confirmProject !== result.projectId) {
    throw new Error('--apply requires an exact --confirm-project.');
  }
  return result;
}

function productionDependencies() {
  return {
    reserveReport,
    initialize(projectId) {
      const admin = require('firebase-admin');
      const app = admin.initializeApp({ projectId });
      return { db: admin.firestore(app), close() { return app.delete(); } };
    },
    runLifecycleBackfill: migration.runLifecycleBackfill,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function failedReport(options, error, partialReport) {
  if (partialReport && typeof partialReport === 'object' && !Array.isArray(partialReport)) {
    return {
      ...partialReport,
      status: partialReport.appliedCount > 0 ? 'partial-failure' : 'failed',
      safeToDeployStrictRules: false,
      error: String(partialReport.error || error && error.message || error)
    };
  }
  return {
    tool: 'lifecycle-migration-cli', schemaVersion: 1,
    projectId: options.projectId, mode: options.apply ? 'apply' : 'dry-run',
    operation: 'lifecycle-backfill', status: 'failed',
    safeToDeployStrictRules: false,
    error: String(error && error.message || error)
  };
}

async function main(argv = process.argv.slice(2), dependencies) {
  const options = parseArgs(argv);
  const runtime = dependencies || productionDependencies();
  const output = options.output || path.resolve(
    'lifecycle-migration-' + options.projectId + '-' + Date.now() + '.json'
  );
  const placeholder = {
    tool: 'lifecycle-migration-cli', schemaVersion: 1,
    projectId: options.projectId, mode: options.apply ? 'apply' : 'dry-run',
    operation: 'lifecycle-backfill', status: 'reserved-fail-closed',
    safeToDeployStrictRules: false
  };
  const reservation = runtime.reserveReport(
    output, JSON.stringify(placeholder, null, 2) + '\n'
  );
  let services;
  try {
    services = await runtime.initialize(options.projectId);
    const report = await runtime.runLifecycleBackfill({
      db: services.db, projectId: options.projectId,
      apply: options.apply, confirmProject: options.confirmProject
    });
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    runtime.writeLine(JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    const failure = failedReport(options, error, error && error.partialReport);
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
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('Lifecycle migration failed: ' + String(error && error.message || error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { failedReport, main, parseArgs, productionDependencies, reserveReport };
