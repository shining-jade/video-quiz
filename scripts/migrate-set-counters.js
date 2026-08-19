#!/usr/bin/env node
'use strict';

const path = require('node:path');
const migration = require('../counter-migration.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function parseArgs(argv) {
  const result = { projectId: '', apply: false, confirmProject: '', output: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--apply') { result.apply = true; continue; }
    const field = { '--project': 'projectId', '--confirm-project': 'confirmProject', '--output': 'output' }[argument];
    if (!field) throw new Error('Unknown argument: ' + argument);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value.');
    result[field] = value;
  }
  if (!result.projectId) throw new Error('--project is required.');
  if (result.apply && result.confirmProject !== result.projectId) throw new Error('--apply requires an exact --confirm-project.');
  return result;
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
  const output = options.output || path.resolve('set-counter-migration-' + options.projectId + '-' + Date.now() + '.json');
  const reservation = dependencies.reserveReport(output, JSON.stringify({
    tool: 'set-counter-migration-cli', schemaVersion: 1, projectId: options.projectId,
    mode: options.apply ? 'apply' : 'dry-run', operation: 'set-counter-backfill',
    status: 'reserved-fail-closed', safeToDeployStrictRules: false
  }, null, 2) + '\n');
  let services;
  try {
    services = await dependencies.initialize(options.projectId);
    const report = await dependencies.runCounterBackfill({
      db: services.db, projectId: options.projectId, apply: options.apply,
      confirmProject: options.confirmProject
    });
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    dependencies.writeLine(JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    const report = error.partialReport || {
      tool: 'set-counter-migration-cli', schemaVersion: 1, projectId: options.projectId,
      mode: options.apply ? 'apply' : 'dry-run', operation: 'set-counter-backfill',
      status: 'failed', safeToDeployStrictRules: false,
      error: String(error && error.message || error)
    };
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally {
    if (services && services.close) await services.close();
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write('Set counter migration failed: ' + String(error && error.message || error) + '\n');
  process.exitCode = 1;
});

module.exports = { main, parseArgs, productionDependencies };
