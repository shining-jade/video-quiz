#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const migration = require('../lifecycle-migration.js');

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

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const app = admin.initializeApp({ projectId: options.projectId });
  try {
    const report = await migration.runLifecycleBackfill({
      db: admin.firestore(), projectId: options.projectId,
      apply: options.apply, confirmProject: options.confirmProject
    });
    const output = options.output || path.resolve(
      'lifecycle-migration-' + options.projectId + '-' + Date.now() + '.json'
    );
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    await app.delete();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('Lifecycle migration failed: ' + String(error && error.message || error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main };
