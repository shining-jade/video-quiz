'use strict';

const path = require('node:path');
const { auditPublicLibrary, parseAuditArguments } = require('../public-library-audit.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

function defaultOutputPath(projectId, generatedAt) {
  const stamp = generatedAt.replace(/[^0-9A-Za-z.-]/g, '-');
  return path.resolve(`public-library-audit-${projectId}-${stamp}.json`);
}

function productionDependencies() {
  const { applicationDefault, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  return {
    environment: process.env,
    now: () => new Date().toISOString(),
    reserveReport,
    initialize(projectId) {
      const app = initializeApp({ credential: applicationDefault(), projectId });
      return { db: getFirestore(app) };
    },
    auditPublicLibrary,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

async function main(argv, dependencies) {
  const runtime = dependencies || productionDependencies();
  const options = parseAuditArguments(argv, runtime.environment || process.env);
  const generatedAt = (runtime.now || (() => new Date().toISOString()))();
  const outputPath = options.outputPath || defaultOutputPath(options.projectId, generatedAt);
  const placeholder = {
    kind: 'public-quiz-library-privacy-audit',
    projectId: options.projectId,
    targetMode: options.targetMode,
    dryRun: true,
    generatedAt,
    complete: false,
    findings: [{ code: 'AUDIT_NOT_COMPLETED', path: '', detail: 'reserved' }],
    safeToDeployPublicLibrary: false
  };
  const reservation = runtime.reserveReport(
    outputPath, JSON.stringify(placeholder, null, 2) + '\n'
  );
  try {
    const services = await runtime.initialize(options.projectId, options.targetMode);
    const audit = await runtime.auditPublicLibrary({
      db: services.db, maxDocuments: options.maxDocuments
    });
    const report = {
      ...audit,
      projectId: options.projectId,
      targetMode: options.targetMode,
      generatedAt
    };
    reservation.commit(JSON.stringify(report, null, 2) + '\n');
    runtime.writeLine(
      `public-library audit: safe=${report.safeToDeployPublicLibrary} ` +
      `findings=${report.findings.length} report=${outputPath}`
    );
    return { report, outputPath };
  } catch (error) {
    const wrapped = new Error(
      String(error && error.message || error) +
      '; fail-closed report remains at ' + reservation.failClosedPath,
      { cause: error }
    );
    wrapped.failClosedPath = reservation.failClosedPath;
    throw wrapped;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(({ report }) => {
    if (!report.safeToDeployPublicLibrary) process.exitCode = 2;
  }).catch(error => {
    process.stderr.write(String(error && error.stack || error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { defaultOutputPath, main, productionDependencies };
