#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const { describeRulesApiFailure, failureLine } = require('../rules-api-failure.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const API_ROOT = 'https://firebaserules.googleapis.com/v1/';
const PROJECT_ID = 'video-quiz-65798';
const TARGET_MODE = 'production';
const RELEASE_NAME = 'projects/video-quiz-65798/releases/cloud.firestore';
const TARGET_RULESET =
  'projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1';
const EXPECTED_SOURCE_SHA =
  'c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d';
const ROLLBACK_RULESET =
  'projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4';
const QUIESCENCE_RULESET =
  'projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GENERATION_PATTERN = /^[0-9]+:[0-9]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseArguments(argv) {
  const options = {
    projectId: '', targetMode: '', manifestPath: '', rulesetName: '',
    expectSha256: '', outputPath: ''
  };
  const fields = new Map([
    ['--project', 'projectId'],
    ['--target-mode', 'targetMode'],
    ['--manifest', 'manifestPath'],
    ['--ruleset', 'rulesetName'],
    ['--expect-sha', 'expectSha256'],
    ['--output', 'outputPath']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields.get(argument);
    if (!field || index + 1 >= argv.length || options[field]) {
      throw new Error('Unknown, duplicate, or incomplete adoption argument: ' + argument);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  if (options.projectId !== PROJECT_ID) {
    throw new Error('--project must name the fixed production project.');
  }
  if (options.targetMode !== TARGET_MODE) {
    throw new Error('--target-mode production is required.');
  }
  if (!options.manifestPath) throw new Error('--manifest is required.');
  if (options.rulesetName !== TARGET_RULESET) {
    throw new Error('--ruleset must name the fixed existing Ruleset.');
  }
  if (options.expectSha256 !== EXPECTED_SOURCE_SHA) {
    throw new Error('--expect-sha must equal the fixed source SHA-256.');
  }
  if (!options.outputPath) throw new Error('--output is required.');
  return options;
}

function validateProductionEnvironment(environment = process.env) {
  const configuredEmulator = Object.keys(environment).find(key =>
    /(?:^|_)EMULATOR_HOST$/.test(key) && String(environment[key] || '')
  );
  if (configuredEmulator) {
    throw new Error('Production Ruleset adoption refuses emulator variable ' + configuredEmulator + '.');
  }
}

function exactObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertManifest(condition) {
  if (!condition) throw new Error('Restricted manifest is not sealed for exact existing adoption.');
}

function validateSealedManifest(manifest) {
  assertManifest(exactObject(manifest));
  assertManifest(manifest.schemaVersion === 1);
  assertManifest(manifest.projectId === PROJECT_ID);
  assertManifest(manifest.targetMode === TARGET_MODE);

  assertManifest(exactObject(manifest.quiescence));
  assertManifest(manifest.quiescence.mechanism === 'deny-all Firestore Rules');
  assertManifest(manifest.quiescence.rulesetName === QUIESCENCE_RULESET);
  assertManifest(manifest.quiescence.verifiedAnonymousStatus === 403);
  assertManifest(manifest.quiescence.cloudFunctionsApiDisabled === true);

  assertManifest(exactObject(manifest.rollback));
  assertManifest(manifest.rollback.rulesetName === ROLLBACK_RULESET);
  assertManifest(COMMIT_PATTERN.test(manifest.rollback.staticCommit));

  assertManifest(exactObject(manifest.release));
  assertManifest(COMMIT_PATTERN.test(manifest.release.staticCommit));
  assertManifest(manifest.release.firestoreRulesSha256 === EXPECTED_SOURCE_SHA);

  assertManifest(exactObject(manifest.locks));
  assertManifest(exactObject(manifest.locks.setCounters));
  assertManifest(UUID_PATTERN.test(manifest.locks.setCounters.lockId));
  assertManifest(GENERATION_PATTERN.test(manifest.locks.setCounters.updateTimeGeneration));
  assertManifest(exactObject(manifest.locks.teacherAccess));
  assertManifest(UUID_PATTERN.test(manifest.locks.teacherAccess.lockToken));
  assertManifest(GENERATION_PATTERN.test(manifest.locks.teacherAccess.updateTimeGeneration));
  assertManifest(GENERATION_PATTERN.test(manifest.locks.teacherAccess.migrationGeneration));
  assertManifest(exactObject(manifest.locks.sessionCounters));
  assertManifest(UUID_PATTERN.test(manifest.locks.sessionCounters.lockToken));
  assertManifest(GENERATION_PATTERN.test(manifest.locks.sessionCounters.updateTimeGeneration));
  assertManifest(GENERATION_PATTERN.test(manifest.locks.sessionCounters.gateGeneration));

  assertManifest(exactObject(manifest.task4));
  assertManifest(manifest.task4.status === 'ready-for-ruleset-adoption');
  assertManifest(manifest.task4.adoptionMode === 'existing-exact');
  assertManifest(manifest.task4.rulesetName === TARGET_RULESET);
  assertManifest(COMMIT_PATTERN.test(manifest.task4.headCommit));
  assertManifest(manifest.task4.sourceSha256 === EXPECTED_SOURCE_SHA);
  return manifest;
}

function readAndValidateSealedManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error('Restricted manifest must be readable JSON.', { cause: error });
  }
  return validateSealedManifest(manifest);
}

function requestJson({ method, url, accessToken, payload }) {
  if (!['GET', 'PATCH'].includes(method)) {
    return Promise.reject(new Error('Existing Ruleset adoption permits GET and PATCH only.'));
  }
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const encoded = payload == null ? null : JSON.stringify(payload);
    const headers = { authorization: 'Bearer ' + accessToken };
    if (encoded != null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(encoded, 'utf8');
    }
    const request = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname + endpoint.search,
      method,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const statusCode = response.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode, body: text ? JSON.parse(text) : {} });
        } catch (error) {
          if (statusCode < 200 || statusCode >= 300) {
            resolve({ statusCode, body: null, rawBody: text });
            return;
          }
          reject(new Error('Rules API returned invalid JSON.', { cause: error }));
        }
      });
    });
    request.on('error', reject);
    request.end(encoded == null ? undefined : encoded);
  });
}

function acquireAccessToken() {
  const { applicationDefault } = require('firebase-admin/app');
  return applicationDefault().getAccessToken().then(value => {
    const token = typeof value === 'string' ? value : value && value.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('Application Default Credentials returned no access token.');
    }
    return token;
  });
}

function httpSuccess(response) {
  return Boolean(response) && response.statusCode >= 200 && response.statusCode < 300;
}

function operationFailure(code, response, error) {
  const failure = new Error(code);
  failure.failureCode = code;
  failure.response = response || null;
  failure.transportError = error || null;
  return failure;
}

function patchPayload(rulesetName) {
  return {
    release: { name: RELEASE_NAME, rulesetName },
    updateMask: 'rulesetName'
  };
}

function manifestGateGenerations(manifest) {
  return {
    setCountersUpdateTime: manifest.locks.setCounters.updateTimeGeneration,
    teacherAccessUpdateTime: manifest.locks.teacherAccess.updateTimeGeneration,
    teacherAccessMigration: manifest.locks.teacherAccess.migrationGeneration,
    sessionCountersUpdateTime: manifest.locks.sessionCounters.updateTimeGeneration,
    sessionCountersGate: manifest.locks.sessionCounters.gateGeneration
  };
}

async function rollbackRelease(runtime, accessToken) {
  let patch = null;
  let patchError = null;
  try {
    patch = await runtime.patchJson({
      method: 'PATCH',
      url: API_ROOT + RELEASE_NAME,
      accessToken,
      payload: patchPayload(ROLLBACK_RULESET)
    });
  } catch (error) {
    patchError = error;
  }

  let readback = null;
  let readbackError = null;
  try {
    readback = await runtime.getJson({
      method: 'GET', url: API_ROOT + RELEASE_NAME, accessToken
    });
  } catch (error) {
    readbackError = error;
  }
  const readbackExact = httpSuccess(readback) &&
    readback.body && readback.body.name === RELEASE_NAME &&
    readback.body.rulesetName === ROLLBACK_RULESET;
  return {
    patchHttpStatus: patch && patch.statusCode || 0,
    readbackHttpStatus: readback && readback.statusCode || 0,
    readbackExact,
    exact: httpSuccess(patch) && readbackExact,
    failure: !httpSuccess(patch)
      ? describeRulesApiFailure(patch, patchError)
      : !readbackExact
        ? describeRulesApiFailure(readback, readbackError)
        : null
  };
}

function productionDependencies() {
  return {
    environment: process.env,
    reserveReport,
    acquireAccessToken,
    getJson: requestJson,
    patchJson: requestJson,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

async function main(argv, dependencies) {
  const runtime = dependencies || productionDependencies();
  const options = parseArguments(argv);
  validateProductionEnvironment(runtime.environment || process.env);
  const placeholder = {
    tool: 'adopt-existing-firestore-ruleset',
    schemaVersion: 1,
    projectId: PROJECT_ID,
    targetMode: TARGET_MODE,
    releaseName: RELEASE_NAME,
    rulesetName: TARGET_RULESET,
    sourceSha256: EXPECTED_SOURCE_SHA,
    createAttempted: false,
    releasePatchAttempted: false,
    rollbackAttempted: false,
    providerStillOff: true,
    safeForExistingFlowSmoke: false,
    phase: 'reserved-before-manifest-validation',
    status: 'reserved-fail-closed'
  };
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(placeholder, null, 2) + '\n'
  );

  let manifest = null;
  let accessToken = '';
  let phase = 'manifest-validation';
  let releasePatchAttempted = false;
  let releasePatchHttpStatus = 0;
  let releaseReadbackHttpStatus = 0;
  try {
    manifest = readAndValidateSealedManifest(options.manifestPath);
    accessToken = await runtime.acquireAccessToken();

    phase = 'target-ruleset-readback';
    let target;
    try {
      target = await runtime.getJson({
        method: 'GET', url: API_ROOT + TARGET_RULESET, accessToken
      });
    } catch (error) {
      throw operationFailure('target-ruleset-unreadable', null, error);
    }
    if (!httpSuccess(target)) {
      throw operationFailure('target-ruleset-unreadable', target, null);
    }
    const files = target.body && target.body.source && target.body.source.files;
    if (target.body.name !== TARGET_RULESET || !Array.isArray(files) || files.length !== 1 ||
        !files[0] || files[0].name !== 'firestore.rules' ||
        typeof files[0].content !== 'string') {
      throw operationFailure('target-ruleset-source-shape-mismatch', target, null);
    }
    const sourceSha256 = crypto.createHash('sha256').update(files[0].content).digest('hex');
    if (sourceSha256 !== EXPECTED_SOURCE_SHA) {
      throw operationFailure('target-ruleset-source-hash-mismatch', target, null);
    }

    phase = 'immediate-pre-patch-readback';
    let before;
    try {
      before = await runtime.getJson({
        method: 'GET', url: API_ROOT + RELEASE_NAME, accessToken
      });
    } catch (error) {
      throw operationFailure('quiescence-release-unreadable', null, error);
    }
    if (!httpSuccess(before)) {
      throw operationFailure('quiescence-release-unreadable', before, null);
    }
    if (!before.body || before.body.name !== RELEASE_NAME ||
        before.body.rulesetName !== manifest.quiescence.rulesetName) {
      throw operationFailure('quiescence-release-drift', before, null);
    }

    phase = 'release-patch';
    releasePatchAttempted = true;
    let patched;
    try {
      patched = await runtime.patchJson({
        method: 'PATCH',
        url: API_ROOT + RELEASE_NAME,
        accessToken,
        payload: patchPayload(TARGET_RULESET)
      });
    } catch (error) {
      throw operationFailure('target-release-patch-failed', null, error);
    }
    releasePatchHttpStatus = patched && patched.statusCode || 0;
    if (!httpSuccess(patched)) {
      throw operationFailure('target-release-patch-failed', patched, null);
    }

    phase = 'release-readback';
    let after;
    try {
      after = await runtime.getJson({
        method: 'GET', url: API_ROOT + RELEASE_NAME, accessToken
      });
    } catch (error) {
      throw operationFailure('target-release-readback-failed', null, error);
    }
    releaseReadbackHttpStatus = after && after.statusCode || 0;
    if (!httpSuccess(after) || !after.body || after.body.name !== RELEASE_NAME ||
        after.body.rulesetName !== TARGET_RULESET) {
      throw operationFailure('target-release-readback-mismatch', after, null);
    }

    const report = {
      ...placeholder,
      sourceCommit: manifest.task4.headCommit,
      staticCommit: manifest.release.staticCommit,
      rollbackRulesetName: manifest.rollback.rulesetName,
      quiescenceRulesetName: manifest.quiescence.rulesetName,
      gateGenerations: manifestGateGenerations(manifest),
      targetRulesetReadbackExact: true,
      releasePatchAttempted: true,
      releasePatchHttpStatus,
      releaseReadbackHttpStatus,
      releaseReadbackRulesetName: TARGET_RULESET,
      releaseReadbackExact: true,
      rollbackAttempted: false,
      phase: 'release-active-exact-readback',
      status: 'complete',
      safeForExistingFlowSmoke: true
    };
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    runtime.writeLine([
      'project=' + PROJECT_ID,
      'status=complete',
      'ruleset=' + TARGET_RULESET,
      'createAttempted=false',
      'releaseReadbackExact=true',
      'providerStillOff=true'
    ].join(' '));
    return report;
  } catch (error) {
    const failure = describeRulesApiFailure(
      error && error.response, error && error.transportError ||
        (error && !error.failureCode ? error : null)
    );
    let rollback = null;
    if (releasePatchAttempted) rollback = await rollbackRelease(runtime, accessToken);
    const report = {
      ...placeholder,
      sourceCommit: manifest ? manifest.task4.headCommit : null,
      staticCommit: manifest ? manifest.release.staticCommit : null,
      rollbackRulesetName: manifest ? manifest.rollback.rulesetName : null,
      quiescenceRulesetName: manifest ? manifest.quiescence.rulesetName : null,
      gateGenerations: manifest ? manifestGateGenerations(manifest) : null,
      targetRulesetReadbackExact: false,
      releasePatchAttempted,
      releasePatchHttpStatus,
      releaseReadbackHttpStatus,
      releaseReadbackRulesetName: '',
      releaseReadbackExact: false,
      rollbackAttempted: Boolean(rollback),
      rollbackPatchHttpStatus: rollback ? rollback.patchHttpStatus : 0,
      rollbackReadbackHttpStatus: rollback ? rollback.readbackHttpStatus : 0,
      rollbackReadbackExact: rollback ? rollback.readbackExact : false,
      failureCode: error && error.failureCode || 'local-adoption-gate-failed',
      failure,
      rollbackFailure: rollback && !rollback.exact ? rollback.failure : null,
      phase,
      status: rollback && rollback.exact ? 'failed-rolled-back' : 'failed',
      safeForExistingFlowSmoke: false
    };
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    runtime.writeLine([
      'project=' + PROJECT_ID,
      'status=' + report.status,
      'phase=' + phase,
      'rollbackExact=' + String(Boolean(rollback && rollback.exact)),
      failureLine(failure)
    ].join(' '));
    return report;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    report => { process.exitCode = report.status === 'complete' ? 0 : 2; },
    error => {
      process.stderr.write('Existing Ruleset adoption failed before report publication: ' +
        String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  API_ROOT,
  EXPECTED_SOURCE_SHA,
  PROJECT_ID,
  QUIESCENCE_RULESET,
  RELEASE_NAME,
  ROLLBACK_RULESET,
  TARGET_RULESET,
  acquireAccessToken,
  main,
  parseArguments,
  patchPayload,
  productionDependencies,
  readAndValidateSealedManifest,
  requestJson,
  validateProductionEnvironment,
  validateSealedManifest
};
