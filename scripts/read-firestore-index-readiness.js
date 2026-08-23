#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EVIDENCE_ARGUMENT_FIELDS, authorEvidenceReport, captureEvidenceIdentity,
  validateEvidenceIdentityOptions
} = require('../release-evidence-identity.js');
const { acquireAccessToken, requestJson } = require('../release-http-json.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const PROJECT_ID = 'video-quiz-65798';
const API_ROOT = 'https://firestore.googleapis.com/v1/';
const REQUIRED_INDEX_NAME = 'projects/video-quiz-65798/databases/(default)/' +
  'collectionGroups/published_quiz_sets/indexes/CICAgOjXh4EK';
const REQUIRED_FIELDS = Object.freeze([
  Object.freeze({ fieldPath: 'status', order: 'ASCENDING' }),
  Object.freeze({ fieldPath: 'updatedAt', order: 'DESCENDING' }),
  Object.freeze({ fieldPath: '__name__', order: 'DESCENDING' })
]);
const REQUEST_TIMEOUT_MS = 30_000;

function parseArguments(argv) {
  const options = {
    projectId: '', targetMode: '', windowId: '', controlId: '', outputPath: ''
  };
  const fields = {
    '--project': 'projectId', '--target-mode': 'targetMode', '--output': 'outputPath',
    ...EVIDENCE_ARGUMENT_FIELDS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields[argument];
    const value = argv[index + 1];
    if (!field || !value || value.startsWith('--') || options[field]) {
      throw new Error('Unknown, duplicate, or incomplete index-readiness argument: ' + argument);
    }
    options[field] = value;
    index += 1;
  }
  if (options.projectId !== PROJECT_ID) {
    throw new Error('--project must name the fixed production project.');
  }
  if (options.targetMode !== 'production') {
    throw new Error('--target-mode production is required.');
  }
  if (!options.outputPath) throw new Error('--output is required.');
  validateEvidenceIdentityOptions(options);
  return options;
}

function validateProductionEnvironment(environment = process.env) {
  const configured = Object.keys(environment).find(key =>
    /(?:^|_)EMULATOR_HOST$/.test(key) && String(environment[key] || '')
  );
  if (configured) throw new Error('Index readiness refuses emulator variable ' + configured + '.');
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function readAndValidateIndexConfig(readFile) {
  const raw = readFile();
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') {
    throw Object.assign(new Error('index-config-unreadable'), { code: 'index-config-unreadable' });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch (_) {
    throw Object.assign(new Error('index-config-malformed'), { code: 'index-config-malformed' });
  }
  const exact = exactKeys(parsed, ['indexes', 'fieldOverrides']) &&
    Array.isArray(parsed.indexes) && parsed.indexes.length === 1 &&
    Array.isArray(parsed.fieldOverrides) && parsed.fieldOverrides.length === 0 &&
    exactKeys(parsed.indexes[0], ['collectionGroup', 'queryScope', 'fields']) &&
    parsed.indexes[0].collectionGroup === 'published_quiz_sets' &&
    parsed.indexes[0].queryScope === 'COLLECTION' &&
    JSON.stringify(parsed.indexes[0].fields) === JSON.stringify(REQUIRED_FIELDS);
  if (!exact) {
    throw Object.assign(new Error('index-config-mismatch'), { code: 'index-config-mismatch' });
  }
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function httpSuccess(response) {
  return Boolean(response) && response.statusCode >= 200 && response.statusCode < 300;
}

function indexReadbackExact(response) {
  return httpSuccess(response) && response.body &&
    response.body.name === REQUIRED_INDEX_NAME &&
    response.body.queryScope === 'COLLECTION' &&
    JSON.stringify(response.body.fields) === JSON.stringify(REQUIRED_FIELDS) &&
    response.body.state === 'READY';
}

function safeError(error, response) {
  return {
    code: typeof (error && error.code) === 'string' && error.code
      ? error.code : response && response.statusCode === 403
        ? 'index-read-permission-denied' : 'index-readback-not-ready',
    httpStatus: response && Number.isInteger(response.statusCode) ? response.statusCode : 0
  };
}

async function boundedGet(runtime, request) {
  const controller = new AbortController();
  const timeoutMs = Number.isInteger(runtime.requestTimeoutMs) && runtime.requestTimeoutMs > 0 &&
    runtime.requestTimeoutMs <= 120_000 ? runtime.requestTimeoutMs : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error('index-read-timeout'), { code: 'index-read-timeout' }
  )), timeoutMs);
  try {
    return await runtime.getJson({ ...request, method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function productionDependencies() {
  return {
    environment: process.env,
    now: () => new Date().toISOString(),
    readIndexesFile: () => fs.readFileSync(path.resolve('firestore.indexes.json')),
    reserveReport,
    acquireAccessToken,
    getJson(request) { return requestJson(request); },
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function writeLineSafely(runtime, line) {
  try { runtime.writeLine(line); } catch (_) { /* durable report is authoritative */ }
}

async function main(argv = process.argv.slice(2), dependencies) {
  const runtime = dependencies || productionDependencies();
  const options = parseArguments(argv);
  validateProductionEnvironment(runtime.environment || process.env);
  const identity = captureEvidenceIdentity(
    options,
    { tool: 'firestore-index-readiness-evidence', schemaVersion: 2 },
    runtime.now
  );
  const base = authorEvidenceReport({
    operation: 'exact-index-readback', mode: 'get-only', status: 'reserved-fail-closed',
    indexName: REQUIRED_INDEX_NAME, indexState: '', firestoreIndexesSha256: '',
    requiredIndexCount: 1, readyIndexCount: 0, allRequiredIndexesReady: false,
    pendingCount: 0, failedCount: 1, writeCount: 0,
    error: { code: 'not-completed', httpStatus: 0 }
  }, identity);
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(base, null, 2) + '\n'
  );
  let response = null;
  let indexSha = '';
  try {
    indexSha = readAndValidateIndexConfig(runtime.readIndexesFile);
    const accessToken = await runtime.acquireAccessToken();
    response = await boundedGet(runtime, {
      url: API_ROOT + REQUIRED_INDEX_NAME, accessToken
    });
    if (!indexReadbackExact(response)) {
      throw Object.assign(new Error('index-readback-not-ready'), {
        code: response && response.statusCode === 403
          ? 'index-read-permission-denied' : 'index-readback-not-ready'
      });
    }
    const report = authorEvidenceReport({
      operation: 'exact-index-readback', mode: 'get-only', status: 'complete',
      indexName: REQUIRED_INDEX_NAME, indexState: 'READY',
      indexDefinition: { queryScope: 'COLLECTION', fields: REQUIRED_FIELDS },
      firestoreIndexesSha256: indexSha, requiredIndexCount: 1, readyIndexCount: 1,
      allRequiredIndexesReady: true, pendingCount: 0, failedCount: 0,
      writeCount: 0, error: null
    }, identity);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'Firestore index readiness status=complete state=READY');
    return report;
  } catch (error) {
    const state = response && response.body && typeof response.body.state === 'string'
      ? response.body.state : '';
    const report = authorEvidenceReport({
      operation: 'exact-index-readback', mode: 'get-only', status: 'failed',
      indexName: REQUIRED_INDEX_NAME, indexState: state,
      indexDefinition: { queryScope: 'COLLECTION', fields: REQUIRED_FIELDS },
      firestoreIndexesSha256: indexSha, requiredIndexCount: 1, readyIndexCount: 0,
      allRequiredIndexesReady: false, pendingCount: state === 'CREATING' ? 1 : 0,
      failedCount: state === 'CREATING' ? 0 : 1, writeCount: 0,
      error: safeError(error, response)
    }, identity);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'Firestore index readiness status=failed code=' +
      report.error.code);
    return report;
  }
}

if (require.main === module) {
  main().then(
    report => { process.exitCode = report.status === 'complete' ? 0 : 2; },
    error => {
      process.stderr.write('Firestore index readiness failed before report publication: ' +
        String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  API_ROOT,
  PROJECT_ID,
  REQUIRED_FIELDS,
  REQUIRED_INDEX_NAME,
  indexReadbackExact,
  main,
  parseArguments,
  productionDependencies,
  readAndValidateIndexConfig,
  validateProductionEnvironment
};
