#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const migration = require('../legacy-migration-admin.js');

function productionDependencies() {
  const { applicationDefault, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  return {
    initialize(projectId) {
      const app = initializeApp({ credential: applicationDefault(), projectId });
      return { db: getFirestore(app), auth: getAuth(app) };
    },
    runLegacyMigration: migration.runLegacyMigration,
    writeFile(filePath, contents) {
      fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
    },
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function defaultReportPath(report) {
  const timestamp = String(report.generatedAt || new Date().toISOString())
    .replace(/[^0-9A-Za-z.-]/g, '-');
  return path.resolve('legacy-migration-report-' + report.projectId + '-' + timestamp + '.json');
}

async function main(argv, dependencies) {
  const options = migration.parseCliArgs(argv);
  const runtime = dependencies || productionDependencies();
  const services = runtime.initialize(options.projectId);
  const report = await runtime.runLegacyMigration({
    db: services.db,
    auth: services.auth,
    projectId: options.projectId,
    ownerUid: options.ownerUid,
    apply: options.apply,
    confirmProject: options.confirmProject,
    provisionOwnerEmail: options.provisionOwnerEmail
  });
  const output = options.output || defaultReportPath(report);
  runtime.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  runtime.writeLine([
    'mode=' + report.mode,
    'project=' + report.projectId,
    'safe=' + report.safeToDeployStrictRules,
    'remainingLeaks=' + report.remainingResponseLeakCount,
    'auditFailures=' + report.auditFailures.length,
    'digest=' + report.auditDigest,
    'report=' + output
  ].join(' '));
  return report.safeToDeployStrictRules ? 0 : 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write('Legacy migration failed: ' + String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = { defaultReportPath, main };
