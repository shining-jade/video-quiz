#!/usr/bin/env node
'use strict';

const {
  EVIDENCE_ARGUMENT_FIELDS, authorEvidenceReport, captureEvidenceIdentity,
  validateEvidenceIdentityOptions, validCapturedAt
} = require('../release-evidence-identity.js');
const { acquireAccessToken, requestJson } = require('../release-http-json.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const PROJECT_ID = 'video-quiz-65798';
const RELEASE_NAME = 'projects/video-quiz-65798/releases/cloud.firestore';
const QUIESCENCE_RULESET =
  'projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466';
const RULES_ROOT = 'https://firebaserules.googleapis.com/v1/';
const FUNCTIONS_ROOT = 'https://cloudfunctions.googleapis.com/';
const SCHEDULER_ROOT = 'https://cloudscheduler.googleapis.com/v1/';
const FUNCTIONS_V1_URL = FUNCTIONS_ROOT + 'v1/projects/' + PROJECT_ID +
  '/locations/-/functions?pageSize=1000';
const FUNCTIONS_V2_URL = FUNCTIONS_ROOT + 'v2/projects/' + PROJECT_ID +
  '/locations/-/functions?pageSize=1000';
const SCHEDULER_LOCATIONS_URL = SCHEDULER_ROOT + 'projects/' + PROJECT_ID +
  '/locations?pageSize=1000';
const ANONYMOUS_PROBE_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
  '/databases/(default)/documents/__r23_quiescence_probe__/deny-all';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;

function parseArguments(argv) {
  const options = {
    projectId: '', targetMode: '', windowId: '', controlId: '', outputPath: ''
  };
  const fields = {
    '--project': 'projectId',
    '--target-mode': 'targetMode',
    '--output': 'outputPath',
    ...EVIDENCE_ARGUMENT_FIELDS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields[argument];
    const value = argv[index + 1];
    if (!field || !value || value.startsWith('--') || options[field]) {
      throw new Error('Unknown, duplicate, or incomplete quiescence argument: ' + argument);
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
  if (configured) throw new Error('R23 quiescence refuses emulator variable ' + configured + '.');
}

function httpSuccess(response) {
  return Boolean(response) && response.statusCode >= 200 && response.statusCode < 300;
}

function timeoutMilliseconds(value) {
  return Number.isInteger(value) && value > 0 && value <= 120_000
    ? value : REQUEST_TIMEOUT_MS;
}

function codedError(code, response) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = response && Number.isInteger(response.statusCode)
    ? response.statusCode : 0;
  return error;
}

async function runtimeRequest(runtime, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(codedError('provider-read-timeout'));
  }, timeoutMilliseconds(runtime.requestTimeoutMs));
  try {
    return await runtime.requestJson({ ...request, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function emptyWriterInventory() {
  return {
    cloudFunctionsV1: {
      apiVersion: 'v1', listSucceeded: false, pages: 0, unreachable: [], functions: []
    },
    cloudFunctionsV2: {
      apiVersion: 'v2', listSucceeded: false, pages: 0, unreachable: [], functions: []
    },
    cloudScheduler: {
      locationsListSucceeded: false, locationPages: 0, locations: [],
      jobsListSucceeded: false, jobPages: 0, jobs: []
    }
  };
}

function pageUrl(base, pageToken) {
  return pageToken ? base + '&pageToken=' + encodeURIComponent(pageToken) : base;
}

function readNextPageToken(body, code, response) {
  if (!Object.prototype.hasOwnProperty.call(body, 'nextPageToken')) return '';
  if (typeof body.nextPageToken !== 'string') throw codedError(code, response);
  return body.nextPageToken;
}

async function listFunctions(runtime, accessToken, url, target) {
  let token = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await runtimeRequest(runtime, {
      method: 'GET', url: pageUrl(url, token), accessToken
    });
    if (!httpSuccess(response) || !response.body || typeof response.body !== 'object') {
      throw codedError('cloud-functions-list-unavailable', response);
    }
    const functions = response.body.functions == null ? [] : response.body.functions;
    const unreachable = response.body.unreachable == null ? [] : response.body.unreachable;
    if (!Array.isArray(functions) || !Array.isArray(unreachable)) {
      throw codedError('cloud-functions-list-malformed', response);
    }
    target.pages += 1;
    target.unreachable.push(...unreachable.map(String));
    for (const value of functions) {
      const name = value && typeof value.name === 'string' ? value.name : '';
      if (!name) throw codedError('cloud-functions-list-malformed', response);
      target.functions.push({ name });
    }
    token = readNextPageToken(
      response.body, 'cloud-functions-list-malformed', response
    );
    if (!token) {
      target.listSucceeded = true;
      if (target.unreachable.length > 0) throw codedError('cloud-functions-list-partial');
      if (target.functions.length > 0) throw codedError('cloud-functions-still-deployed');
      return;
    }
  }
  throw codedError('cloud-functions-list-truncated');
}

async function listSchedulerLocations(runtime, accessToken, target) {
  let token = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await runtimeRequest(runtime, {
      method: 'GET', url: pageUrl(SCHEDULER_LOCATIONS_URL, token), accessToken
    });
    if (!httpSuccess(response) || !response.body || typeof response.body !== 'object') {
      throw codedError('scheduler-locations-unavailable', response);
    }
    const locations = response.body.locations == null ? [] : response.body.locations;
    if (!Array.isArray(locations)) throw codedError('scheduler-locations-malformed', response);
    target.locationPages += 1;
    for (const value of locations) {
      const name = value && typeof value.name === 'string' ? value.name : '';
      if (!name.startsWith('projects/' + PROJECT_ID + '/locations/')) {
        throw codedError('scheduler-locations-malformed', response);
      }
      target.locations.push(name);
    }
    token = readNextPageToken(
      response.body, 'scheduler-locations-malformed', response
    );
    if (!token) {
      if (target.locations.length === 0) throw codedError('scheduler-locations-empty');
      target.locationsListSucceeded = true;
      return;
    }
  }
  throw codedError('scheduler-locations-truncated');
}

async function listSchedulerJobs(runtime, accessToken, target) {
  for (const location of target.locations) {
    const base = SCHEDULER_ROOT + location + '/jobs?pageSize=500';
    let token = '';
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await runtimeRequest(runtime, {
        method: 'GET', url: pageUrl(base, token), accessToken
      });
      if (!httpSuccess(response) || !response.body || typeof response.body !== 'object') {
        throw codedError('scheduler-jobs-unavailable', response);
      }
      const jobs = response.body.jobs == null ? [] : response.body.jobs;
      if (!Array.isArray(jobs)) throw codedError('scheduler-jobs-malformed', response);
      target.jobPages += 1;
      for (const value of jobs) {
        const name = value && typeof value.name === 'string' ? value.name : '';
        const state = value && typeof value.state === 'string' ? value.state : '';
        if (!name.startsWith(location + '/jobs/') || !state) {
          throw codedError('scheduler-jobs-malformed', response);
        }
        target.jobs.push({ name, state });
        if (!['PAUSED', 'DISABLED'].includes(state)) {
          throw codedError('scheduler-job-not-stopped');
        }
      }
      token = readNextPageToken(
        response.body, 'scheduler-jobs-malformed', response
      );
      if (!token) { complete = true; break; }
    }
    if (!complete) throw codedError('scheduler-jobs-truncated');
  }
  target.jobsListSucceeded = true;
}

async function readWriterInventory(runtime, accessToken, inventory) {
  await listFunctions(
    runtime, accessToken, FUNCTIONS_V1_URL, inventory.cloudFunctionsV1
  );
  await listFunctions(
    runtime, accessToken, FUNCTIONS_V2_URL, inventory.cloudFunctionsV2
  );
  await listSchedulerLocations(runtime, accessToken, inventory.cloudScheduler);
  await listSchedulerJobs(runtime, accessToken, inventory.cloudScheduler);
  return inventory;
}

function patchPayload() {
  return {
    release: { name: RELEASE_NAME, rulesetName: QUIESCENCE_RULESET },
    updateMask: 'rulesetName'
  };
}

function safeError(error) {
  return {
    code: typeof (error && error.code) === 'string' && error.code
      ? error.code : 'quiescence-gate-failed',
    httpStatus: Number.isInteger(error && error.httpStatus) ? error.httpStatus : 0
  };
}

function productionDependencies() {
  return {
    environment: process.env,
    now: () => new Date().toISOString(),
    reserveReport,
    acquireAccessToken,
    requestJson,
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
    { tool: 'r23-quiescence-evidence', schemaVersion: 2 },
    runtime.now
  );
  const inventory = emptyWriterInventory();
  const base = authorEvidenceReport({
    operation: 'begin-quiescence', mode: 'patch-and-verify',
    phase: 'reserved-before-provider-readback', status: 'reserved-fail-closed',
    mechanism: 'deny-all Firestore Rules', releaseName: RELEASE_NAME,
    rulesetName: QUIESCENCE_RULESET, releaseUpdateTime: '',
    releasePatchAttempted: false, releasePatchCount: 0,
    releasePatchHttpStatus: 0, releaseReadbackHttpStatus: 0,
    verifiedAnonymousStatus: 0, providerChecksComplete: false,
    cloudFunctionsStopped: false, schedulerStopped: false,
    trustedWritersStopped: false, writerInventory: inventory,
    firestoreDataWriteCount: 0, error: { code: 'not-completed', httpStatus: 0 }
  }, identity);
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(base, null, 2) + '\n'
  );
  let accessToken = '';
  let releasePatchAttempted = false;
  let releasePatchHttpStatus = 0;
  let releaseReadbackHttpStatus = 0;
  let anonymousStatus = 0;
  let providerChecksComplete = false;
  try {
    accessToken = await runtime.acquireAccessToken();
    await readWriterInventory(runtime, accessToken, inventory);
    providerChecksComplete = true;
    releasePatchAttempted = true;
    const patch = await runtimeRequest(runtime, {
      method: 'PATCH', url: RULES_ROOT + RELEASE_NAME, accessToken,
      payload: patchPayload()
    });
    releasePatchHttpStatus = patch && patch.statusCode || 0;
    if (!httpSuccess(patch)) throw codedError('quiescence-patch-failed', patch);
    const release = await runtimeRequest(runtime, {
      method: 'GET', url: RULES_ROOT + RELEASE_NAME, accessToken
    });
    releaseReadbackHttpStatus = release && release.statusCode || 0;
    if (!httpSuccess(release) || !release.body || release.body.name !== RELEASE_NAME ||
        release.body.rulesetName !== QUIESCENCE_RULESET ||
        !validCapturedAt(release.body.updateTime)) {
      throw codedError('quiescence-release-readback-mismatch', release);
    }
    const anonymous = await runtimeRequest(runtime, {
      method: 'GET', url: ANONYMOUS_PROBE_URL, accessToken: ''
    });
    anonymousStatus = anonymous && anonymous.statusCode || 0;
    if (anonymousStatus !== 403) throw codedError('anonymous-denial-not-verified', anonymous);
    const report = authorEvidenceReport({
      operation: 'begin-quiescence', mode: 'patch-and-verify',
      phase: 'quiescence-established', status: 'complete',
      mechanism: 'deny-all Firestore Rules', releaseName: RELEASE_NAME,
      rulesetName: QUIESCENCE_RULESET,
      releaseUpdateTime: release.body.updateTime,
      releasePatchAttempted: true, releasePatchCount: 1,
      releasePatchHttpStatus, releaseReadbackHttpStatus,
      verifiedAnonymousStatus: 403, providerChecksComplete: true,
      cloudFunctionsStopped: true, schedulerStopped: true,
      trustedWritersStopped: true, writerInventory: inventory,
      firestoreDataWriteCount: 0, error: null
    }, identity);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'R23 quiescence status=complete releaseUpdateTime=' +
      report.releaseUpdateTime);
    return report;
  } catch (error) {
    const report = authorEvidenceReport({
      operation: 'begin-quiescence', mode: 'patch-and-verify',
      phase: releasePatchAttempted ? 'quiescence-readback-failed' : 'provider-readback-failed',
      status: 'failed', mechanism: 'deny-all Firestore Rules',
      releaseName: RELEASE_NAME, rulesetName: QUIESCENCE_RULESET,
      releaseUpdateTime: '', releasePatchAttempted,
      releasePatchCount: releasePatchAttempted ? 1 : 0,
      releasePatchHttpStatus, releaseReadbackHttpStatus,
      verifiedAnonymousStatus: anonymousStatus,
      providerChecksComplete: false,
      cloudFunctionsStopped: false, schedulerStopped: false,
      trustedWritersStopped: false, writerInventory: inventory,
      firestoreDataWriteCount: 0, error: safeError(error)
    }, identity);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'R23 quiescence status=failed code=' + report.error.code);
    return report;
  }
}

if (require.main === module) {
  main().then(
    report => { process.exitCode = report.status === 'complete' ? 0 : 2; },
    error => {
      process.stderr.write('R23 quiescence failed before report publication: ' +
        String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  ANONYMOUS_PROBE_URL,
  FUNCTIONS_V1_URL,
  FUNCTIONS_V2_URL,
  PROJECT_ID,
  QUIESCENCE_RULESET,
  RELEASE_NAME,
  RULES_ROOT,
  SCHEDULER_LOCATIONS_URL,
  SCHEDULER_ROOT,
  main,
  parseArguments,
  productionDependencies,
  readWriterInventory,
  validateProductionEnvironment
};
