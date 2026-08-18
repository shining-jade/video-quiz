#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const migration = require('../legacy-migration-admin.js');

function reserveReport(filePath, initialContents) {
  const descriptor = fs.openSync(filePath, 'wx');
  let closed = false;
  function replace(contents) {
    if (closed) throw new Error('Report reservation is already closed.');
    try {
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, contents, 0, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
      closed = true;
    }
  }
  try {
    fs.writeSync(descriptor, initialContents, 0, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    closed = true;
    try { fs.unlinkSync(filePath); } catch (_) { /* exact file was created only for this reservation */ }
    throw error;
  }
  return { commit: replace };
}

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
    removeLegacyOwner: migration.removeLegacyOwner,
    reserveReport,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function defaultReportPath(report) {
  const timestamp = String(report.generatedAt || new Date().toISOString())
    .replace(/[^0-9A-Za-z.-]/g, '-');
  return path.resolve('legacy-migration-report-' + report.projectId + '-' + timestamp + '.json');
}

function validateTarget(options, environment) {
  const value = environment || {};
  const firestoreHost = String(value.FIRESTORE_EMULATOR_HOST || '');
  const authHost = String(value.FIREBASE_AUTH_EMULATOR_HOST || '');
  const firestoreEmulator = /^(127\.0\.0\.1|localhost):8080$/;
  const authEmulator = /^(127\.0\.0\.1|localhost):9099$/;
  if (!options.emulator && (firestoreHost || authHost)) {
    throw new Error('Emulator environment variables require explicit --emulator mode.');
  }
  if (options.emulator) {
    if (!/^demo-/.test(options.projectId)) {
      throw new Error('--emulator requires a demo-* project ID.');
    }
    if (!firestoreEmulator.test(firestoreHost) || !authEmulator.test(authHost)) {
      throw new Error('--emulator requires the expected local Firestore :8080 and Auth :9099 hosts.');
    }
  }
  return options.emulator ? 'emulator' : 'production';
}

function checksumReport(report) {
  const value = { ...report, auditDigest: '' };
  report.auditDigestKind = 'checksum';
  report.auditDigestAlgorithm = 'sha256';
  value.auditDigestKind = report.auditDigestKind;
  value.auditDigestAlgorithm = report.auditDigestAlgorithm;
  report.auditDigest = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return report;
}

async function main(argv, dependencies) {
  const options = migration.parseCliArgs(argv);
  const runtime = dependencies || productionDependencies();
  const targetMode = validateTarget(options, runtime.environment || process.env);
  const generatedAt = (runtime.now || (() => new Date().toISOString()))();
  const operation = options.removeOwner ? 'remove-owner'
    : options.provisionOwnerEmail ? 'provision-and-migrate' : 'migrate';
  const placeholder = {
    tool: 'legacy-ownership-admin-cli', schemaVersion: 1, projectId: options.projectId,
    mode: options.apply ? 'apply' : 'dry-run', targetMode, operation, generatedAt,
    status: 'reserved-fail-closed', safeToDeployStrictRules: false,
    safeToRemoveOwner: false, auditDigestKind: 'checksum', auditDigestAlgorithm: 'sha256'
  };
  const output = options.output || defaultReportPath(placeholder);
  const reservation = runtime.reserveReport(output, JSON.stringify(placeholder, null, 2) + '\n');
  let report;
  try {
    const services = await runtime.initialize(options.projectId);
    const runner = options.removeOwner ? runtime.removeLegacyOwner : runtime.runLegacyMigration;
    if (typeof runner !== 'function') throw new Error('Selected Admin operator workflow is unavailable.');
    report = await runner({
      db: services.db,
      auth: services.auth,
      projectId: options.projectId,
      ownerUid: options.ownerUid,
      apply: options.apply,
      confirmProject: options.confirmProject,
      provisionOwnerEmail: options.provisionOwnerEmail,
      targetMode
    });
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    const failed = checksumReport({
      tool: 'legacy-ownership-admin-cli', schemaVersion: 1, projectId: options.projectId,
      mode: options.apply ? 'apply' : 'dry-run', targetMode, operation, generatedAt,
      status: 'failed', safeToDeployStrictRules: false, safeToRemoveOwner: false,
      error: String(error && error.message || error), auditDigest: ''
    });
    try { await reservation.commit(JSON.stringify(failed, null, 2) + '\n'); } catch (_) {
      // Preserve the original operator failure when the already-reserved report cannot be rewritten.
    }
    throw error;
  }
  const safe = options.removeOwner ? report.safeToRemoveOwner : report.safeToDeployStrictRules;
  const auditFailures = options.removeOwner
    ? report.migrationAudit && report.migrationAudit.auditFailures || []
    : report.auditFailures || [];
  const remainingLeaks = options.removeOwner
    ? report.migrationAudit && report.migrationAudit.remainingResponseLeakCount || 0
    : report.remainingResponseLeakCount || 0;
  runtime.writeLine([
    'mode=' + report.mode,
    'project=' + report.projectId,
    'target=' + targetMode,
    'operation=' + operation,
    'safe=' + safe,
    'remainingLeaks=' + remainingLeaks,
    'auditFailures=' + auditFailures.length,
    'digest=' + report.auditDigest,
    'report=' + output
  ].join(' '));
  return safe ? 0 : 2;
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

module.exports = { defaultReportPath, main, reserveReport, validateTarget };
