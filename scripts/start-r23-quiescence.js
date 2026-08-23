#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
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
const QUIESCENCE_RULESET_SOURCE_SHA256 =
  'cd5089e4e5116dbb994013dc5fd5e7e411ec348935b8d06d13acd00173cca15b';
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
    const response = await runtime.requestJson({ ...request, signal: controller.signal });
    if (controller.signal.aborted) {
      throw controller.signal.reason || codedError('provider-read-timeout');
    }
    return response;
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

function patchPayload(rulesetName = QUIESCENCE_RULESET) {
  return {
    release: { name: RELEASE_NAME, rulesetName },
    updateMask: 'rulesetName'
  };
}

function sourceSha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function readRulesetSource(response, expectedName, errorCode) {
  const body = response && response.body;
  const files = body && body.source && body.source.files;
  if (!httpSuccess(response) || !body || body.name !== expectedName ||
      !Array.isArray(files) || files.length !== 1 || !files[0] ||
      typeof files[0].name !== 'string' || !files[0].name ||
      files[0].name.length > 128 || /[\\/]/.test(files[0].name) ||
      typeof files[0].content !== 'string') {
    throw codedError(errorCode, response);
  }
  return {
    httpStatus: response.statusCode,
    fileName: files[0].name,
    sha256: sourceSha256(files[0].content)
  };
}

function readRelease(response, errorCode) {
  const body = response && response.body;
  const projectRulesetPrefix = 'projects/' + PROJECT_ID + '/rulesets/';
  const rulesetId = body && typeof body.rulesetName === 'string'
    ? body.rulesetName.slice(projectRulesetPrefix.length) : '';
  if (!httpSuccess(response) || !body || body.name !== RELEASE_NAME ||
      typeof body.rulesetName !== 'string' ||
      !body.rulesetName.startsWith(projectRulesetPrefix) ||
      !rulesetId || rulesetId.length > 128 || rulesetId.includes('/') ||
      !validCapturedAt(body.updateTime)) {
    throw codedError(errorCode, response);
  }
  return {
    httpStatus: response.statusCode,
    rulesetName: body.rulesetName,
    updateTime: body.updateTime
  };
}

async function captureRequest(runtime, request) {
  try {
    return { response: await runtimeRequest(runtime, request), error: null };
  } catch (error) {
    return { response: null, error };
  }
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
  const facts = {
    operation: 'begin-quiescence', mode: 'patch-and-verify',
    mechanism: 'deny-all Firestore Rules', releaseName: RELEASE_NAME,
    rulesetName: QUIESCENCE_RULESET, releaseUpdateTime: '',
    releasePatchAttempted: false, releasePatchCount: 0,
    releasePatchHttpStatus: 0, releasePatchOutcome: 'not-attempted',
    mutationOutcomeUnknown: false,
    quiescenceRulesetSourceReadbackHttpStatus: 0,
    quiescenceRulesetSourceFileName: '',
    quiescenceRulesetSourceSha256: '',
    quiescenceRulesetSourceReadbackExact: false,
    priorReleaseReadbackHttpStatus: 0,
    priorReleaseRulesetName: '', priorReleaseUpdateTime: '',
    priorRulesetSourceReadbackHttpStatus: 0,
    priorRulesetSourceFileName: '', priorRulesetSourceSha256: '',
    priorRulesetSourceReadbackExact: false,
    releaseReadbackHttpStatus: 0, releaseReadbackRulesetName: '',
    releaseReadbackUpdateTime: '', releaseReadbackExact: false,
    rollbackAttempted: false, rollbackPatchCount: 0,
    rollbackPatchHttpStatus: 0, rollbackReadbackHttpStatus: 0,
    rollbackReadbackRulesetName: '', rollbackReadbackUpdateTime: '',
    rollbackReadbackExact: false,
    finalReleaseRulesetName: '', finalReleaseUpdateTime: '',
    finalReleaseStateKnown: false,
    verifiedAnonymousStatus: 0, providerChecksComplete: false,
    cloudFunctionsStopped: false, schedulerStopped: false,
    trustedWritersStopped: false, writerInventory: inventory,
    firestoreDataWriteCount: 0
  };
  const makeReport = (phase, status, error) => authorEvidenceReport({
    ...facts, phase, status, error
  }, identity);
  const base = makeReport(
    'reserved-before-provider-readback', 'reserved-fail-closed',
    { code: 'not-completed', httpStatus: 0 }
  );
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(base, null, 2) + '\n'
  );
  const finish = async (phase, status, error) => {
    const report = makeReport(phase, status, error);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'R23 quiescence status=' + status +
      (error ? ' code=' + report.error.code :
        ' releaseUpdateTime=' + report.releaseUpdateTime));
    return report;
  };
  let accessToken = '';
  try {
    accessToken = await runtime.acquireAccessToken();
    await readWriterInventory(runtime, accessToken, inventory);
    facts.providerChecksComplete = true;
    facts.cloudFunctionsStopped = true;
    facts.schedulerStopped = true;
    facts.trustedWritersStopped = true;
  } catch (error) {
    return finish('provider-readback-failed', 'failed', safeError(error));
  }

  let baseline;
  try {
    const denyResponse = await runtimeRequest(runtime, {
      method: 'GET', url: RULES_ROOT + QUIESCENCE_RULESET, accessToken
    });
    facts.quiescenceRulesetSourceReadbackHttpStatus =
      denyResponse && denyResponse.statusCode || 0;
    const denySource = readRulesetSource(
      denyResponse, QUIESCENCE_RULESET, 'quiescence-ruleset-source-unavailable'
    );
    facts.quiescenceRulesetSourceFileName = denySource.fileName;
    facts.quiescenceRulesetSourceSha256 = denySource.sha256;
    if (denySource.sha256 !== QUIESCENCE_RULESET_SOURCE_SHA256) {
      throw codedError('quiescence-ruleset-source-hash-mismatch', denyResponse);
    }
    facts.quiescenceRulesetSourceReadbackExact = true;

    const baselineResponse = await runtimeRequest(runtime, {
      method: 'GET', url: RULES_ROOT + RELEASE_NAME, accessToken
    });
    facts.priorReleaseReadbackHttpStatus =
      baselineResponse && baselineResponse.statusCode || 0;
    baseline = readRelease(
      baselineResponse, 'quiescence-prior-release-unavailable'
    );
    facts.priorReleaseRulesetName = baseline.rulesetName;
    facts.priorReleaseUpdateTime = baseline.updateTime;

    const priorResponse = await runtimeRequest(runtime, {
      method: 'GET', url: RULES_ROOT + baseline.rulesetName, accessToken
    });
    facts.priorRulesetSourceReadbackHttpStatus =
      priorResponse && priorResponse.statusCode || 0;
    const priorSource = readRulesetSource(
      priorResponse, baseline.rulesetName, 'quiescence-prior-ruleset-source-unavailable'
    );
    facts.priorRulesetSourceFileName = priorSource.fileName;
    facts.priorRulesetSourceSha256 = priorSource.sha256;
    facts.priorRulesetSourceReadbackExact = true;
  } catch (error) {
    return finish('ruleset-preflight-failed', 'failed', safeError(error));
  }

  facts.releasePatchAttempted = true;
  facts.releasePatchCount = 1;
  const patchAttempt = await captureRequest(runtime, {
    method: 'PATCH', url: RULES_ROOT + RELEASE_NAME, accessToken,
    payload: patchPayload()
  });
  facts.releasePatchHttpStatus = patchAttempt.response &&
    patchAttempt.response.statusCode || 0;

  const readbackAttempt = await captureRequest(runtime, {
    method: 'GET', url: RULES_ROOT + RELEASE_NAME, accessToken
  });
  facts.releaseReadbackHttpStatus = readbackAttempt.response &&
    readbackAttempt.response.statusCode || 0;
  const rawReadback = readbackAttempt.response && readbackAttempt.response.body;
  if (rawReadback && typeof rawReadback.rulesetName === 'string') {
    facts.releaseReadbackRulesetName = rawReadback.rulesetName;
  }
  if (rawReadback && validCapturedAt(rawReadback.updateTime)) {
    facts.releaseReadbackUpdateTime = rawReadback.updateTime;
  }
  let releaseReadback = null;
  try {
    if (readbackAttempt.error) throw readbackAttempt.error;
    releaseReadback = readRelease(
      readbackAttempt.response, 'quiescence-release-readback-unavailable'
    );
  } catch (_) {
    releaseReadback = null;
  }
  facts.releaseReadbackExact = Boolean(
    releaseReadback && releaseReadback.rulesetName === QUIESCENCE_RULESET
  );

  if (facts.releaseReadbackExact) {
    facts.releasePatchOutcome = httpSuccess(patchAttempt.response)
      ? 'response-success' : 'landed-reconciled';
    facts.mutationOutcomeUnknown = false;
    facts.releaseUpdateTime = releaseReadback.updateTime;
    facts.finalReleaseRulesetName = releaseReadback.rulesetName;
    facts.finalReleaseUpdateTime = releaseReadback.updateTime;
    facts.finalReleaseStateKnown = true;
    const anonymousAttempt = await captureRequest(runtime, {
      method: 'GET', url: ANONYMOUS_PROBE_URL, accessToken: ''
    });
    facts.verifiedAnonymousStatus = anonymousAttempt.response &&
      anonymousAttempt.response.statusCode || 0;
    if (facts.verifiedAnonymousStatus !== 403) {
      const anonymousError = anonymousAttempt.error || codedError(
        'anonymous-denial-not-verified', anonymousAttempt.response
      );
      return finish(
        'anonymous-denial-verification-failed', 'failed', safeError(anonymousError)
      );
    }
    return finish('quiescence-established', 'complete', null);
  }

  if (patchAttempt.error || !releaseReadback) {
    facts.releasePatchOutcome = 'mutation-outcome-unknown';
    facts.mutationOutcomeUnknown = true;
    facts.finalReleaseStateKnown = false;
    return finish(
      'quiescence-mutation-indeterminate', 'mutation-outcome-unknown',
      safeError(codedError('quiescence-mutation-outcome-unknown'))
    );
  }

  const exactUnchangedBaseline = !httpSuccess(patchAttempt.response) &&
    releaseReadback.rulesetName === baseline.rulesetName &&
    releaseReadback.updateTime === baseline.updateTime;
  if (exactUnchangedBaseline) {
    facts.releasePatchOutcome = 'definitely-not-landed';
    facts.finalReleaseRulesetName = releaseReadback.rulesetName;
    facts.finalReleaseUpdateTime = releaseReadback.updateTime;
    facts.finalReleaseStateKnown = true;
    return finish(
      'quiescence-patch-not-landed', 'failed',
      safeError(codedError('quiescence-patch-definitely-not-landed', patchAttempt.response))
    );
  }

  facts.rollbackAttempted = true;
  facts.rollbackPatchCount = 1;
  const rollbackAttempt = await captureRequest(runtime, {
    method: 'PATCH', url: RULES_ROOT + RELEASE_NAME, accessToken,
    payload: patchPayload(baseline.rulesetName)
  });
  facts.rollbackPatchHttpStatus = rollbackAttempt.response &&
    rollbackAttempt.response.statusCode || 0;
  const rollbackReadAttempt = await captureRequest(runtime, {
    method: 'GET', url: RULES_ROOT + RELEASE_NAME, accessToken
  });
  facts.rollbackReadbackHttpStatus = rollbackReadAttempt.response &&
    rollbackReadAttempt.response.statusCode || 0;
  const rawRollback = rollbackReadAttempt.response && rollbackReadAttempt.response.body;
  if (rawRollback && typeof rawRollback.rulesetName === 'string') {
    facts.rollbackReadbackRulesetName = rawRollback.rulesetName;
  }
  if (rawRollback && validCapturedAt(rawRollback.updateTime)) {
    facts.rollbackReadbackUpdateTime = rawRollback.updateTime;
  }
  let rollbackReadback = null;
  try {
    if (rollbackReadAttempt.error) throw rollbackReadAttempt.error;
    rollbackReadback = readRelease(
      rollbackReadAttempt.response, 'quiescence-rollback-readback-unavailable'
    );
  } catch (_) {
    rollbackReadback = null;
  }
  facts.rollbackReadbackExact = Boolean(
    rollbackReadback && rollbackReadback.rulesetName === baseline.rulesetName
  );
  if (facts.rollbackReadbackExact) {
    facts.finalReleaseRulesetName = rollbackReadback.rulesetName;
    facts.finalReleaseUpdateTime = rollbackReadback.updateTime;
    facts.finalReleaseStateKnown = true;
    facts.releasePatchOutcome = 'mismatch-rolled-back';
    return finish(
      'quiescence-mismatch-rolled-back', 'failed-rolled-back',
      safeError(codedError('quiescence-target-mismatch-rolled-back'))
    );
  }

  // A lost rollback response can still arrive after this read. Unless the
  // readback already proves the exact prior release, a different release is
  // only an observation in flight—not a truthful final-state assertion.
  if (rollbackReadback && !rollbackAttempt.error) {
    facts.finalReleaseRulesetName = rollbackReadback.rulesetName;
    facts.finalReleaseUpdateTime = rollbackReadback.updateTime;
    facts.finalReleaseStateKnown = true;
  }

  facts.releasePatchOutcome = 'mismatch-rollback-failed';
  facts.mutationOutcomeUnknown = Boolean(rollbackAttempt.error) ||
    !facts.finalReleaseStateKnown;
  return finish(
    'quiescence-rollback-failed',
    facts.mutationOutcomeUnknown ? 'mutation-outcome-unknown' : 'failed',
    safeError(codedError('quiescence-mismatch-rollback-failed', rollbackAttempt.response))
  );
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
  QUIESCENCE_RULESET_SOURCE_SHA256,
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
