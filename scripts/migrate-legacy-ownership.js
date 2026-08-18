#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const migration = require('../legacy-migration-admin.js');

function writeFully(fileSystem, descriptor, contents) {
  const buffer = Buffer.from(contents, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fileSystem.writeSync(
      descriptor, buffer, offset, buffer.length - offset, offset
    );
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('Report write made no forward progress.');
    }
    offset += written;
  }
}

function syncDirectory(fileSystem, directory) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'ENOSYS', 'EBADF'].includes(error && error.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function validJson(contents) {
  const value = JSON.parse(contents);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Report artifact must be a JSON object.');
  }
  return value;
}

function reserveReport(filePath, initialContents, fileSystem = fs) {
  const reservedPath = filePath + '.reserved';
  const pendingPath = filePath + '.pending';
  const directory = path.dirname(path.resolve(filePath));
  const initial = validJson(initialContents);
  if (initial.safeToDeployStrictRules === true || initial.safeToRemoveOwner === true) {
    throw new Error('The reservation artifact must be fail-closed.');
  }
  if (fileSystem.existsSync(filePath) || fileSystem.existsSync(pendingPath)) {
    throw new Error('Report output or pending artifact already exists: ' + filePath);
  }
  let descriptor;
  let reservationCreated = false;
  try {
    descriptor = fileSystem.openSync(reservedPath, 'wx');
    reservationCreated = true;
    writeFully(fileSystem, descriptor, initialContents);
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(fileSystem, directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_) { /* preserve original reservation error */ }
    }
    if (reservationCreated) {
      try { fileSystem.unlinkSync(reservedPath); } catch (_) { /* remove only our incomplete reservation */ }
    }
    throw error;
  }

  let published = false;
  function commit(contents) {
    if (published) throw new Error('Report reservation is already published.');
    validJson(contents);
    if (fileSystem.existsSync(filePath)) {
      throw new Error('Report output already exists while reservation is active: ' + filePath);
    }
    let pendingDescriptor;
    try {
      pendingDescriptor = fileSystem.openSync(pendingPath, 'wx');
      writeFully(fileSystem, pendingDescriptor, contents);
      fileSystem.fsyncSync(pendingDescriptor);
      fileSystem.closeSync(pendingDescriptor);
      pendingDescriptor = undefined;
    } catch (error) {
      if (pendingDescriptor !== undefined) {
        try { fileSystem.closeSync(pendingDescriptor); } catch (_) { /* preserve original write error */ }
      }
      try { fileSystem.unlinkSync(pendingPath); } catch (_) { /* companion remains authoritative */ }
      throw error;
    }
    try {
      fileSystem.renameSync(pendingPath, filePath);
      syncDirectory(fileSystem, directory);
      fileSystem.unlinkSync(reservedPath);
      published = true;
    } catch (error) {
      try { fileSystem.unlinkSync(pendingPath); } catch (_) { /* it may already be atomically renamed */ }
      throw error;
    }
  }
  return { commit, failClosedPath: reservedPath, outputPath: filePath, pendingPath };
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
    try {
      await reservation.commit(JSON.stringify(failed, null, 2) + '\n');
    } catch (publicationError) {
      throw new Error(
        String(error && error.message || error) + '; fail-closed report remains at ' +
        (reservation.failClosedPath || output + '.reserved') + '; publication error: ' +
        String(publicationError && publicationError.message || publicationError),
        { cause: error }
      );
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
