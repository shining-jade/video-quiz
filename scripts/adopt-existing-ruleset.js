#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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
const REQUEST_TIMEOUT_MS = 30_000;
const SET_COUNTERS_PATH = 'migration_gates/set_counters';
const TEACHER_ACCESS_PATH = 'migration_gates/teacher_access_status';
const SESSION_COUNTERS_LOCK_PATH = 'migration_gates/session_counter_migration';
const SESSION_COUNTERS_GATE_PATH = 'migration_gates/session_counters';
const STATIC_ASSET_PATHS = [
  'index.html', 'firestore-core.js', 'class-planning-core.js', 'editor-draft.js',
  'editor-history-core.js', 'playlist-core.js', 'public-author-label-core.js',
  'public-quiz-library-core.js', 'firestore-store.js', 'choice-order-core.js',
  'image-lightbox-core.js', 'quiz-trigger-core.js', 'quiz-preview-core.js',
  'teacher-stage.js', 'auth-core.js', 'teacher-email-auth-core.js',
  'teacher-access-request-core.js', 'teacher-deletion-core.js',
  'collaboration-trash-core.js'
];
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GENERATION_PATTERN = /^[0-9]+:[0-9]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseArguments(argv) {
  const options = {
    projectId: '', targetMode: '', manifestPath: '', rulesetName: '',
    expectSha256: '', expectManifestSha256: '', outputPath: ''
  };
  const fields = new Map([
    ['--project', 'projectId'],
    ['--target-mode', 'targetMode'],
    ['--manifest', 'manifestPath'],
    ['--ruleset', 'rulesetName'],
    ['--expect-sha', 'expectSha256'],
    ['--expect-manifest-sha', 'expectManifestSha256'],
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
  if (!/^[0-9a-f]{64}$/.test(options.expectManifestSha256)) {
    throw new Error('--expect-manifest-sha must be an exact lowercase SHA-256.');
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

function readAndValidateSealedManifest(manifestPath, expectedManifestSha256) {
  let rawManifest;
  try {
    rawManifest = fs.readFileSync(manifestPath);
  } catch (error) {
    throw new Error('Restricted manifest must be readable JSON.', { cause: error });
  }
  const manifestSha256 = crypto.createHash('sha256').update(rawManifest).digest('hex');
  if (manifestSha256 !== expectedManifestSha256) {
    throw new Error('Restricted manifest raw SHA-256 does not match the trusted expectation.');
  }
  let manifest;
  try {
    manifest = JSON.parse(rawManifest.toString('utf8'));
  } catch (error) {
    throw new Error('Restricted manifest must be readable JSON.', { cause: error });
  }
  return { manifest: validateSealedManifest(manifest), manifestSha256 };
}

function timeoutMilliseconds(value) {
  return Number.isInteger(value) && value > 0 && value <= 120_000
    ? value : REQUEST_TIMEOUT_MS;
}

function timeoutError() {
  const error = new Error('Rules API request timed out.');
  error.code = 'ETIMEDOUT';
  return error;
}

function withTimeout(start, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMilliseconds(timeoutMs));
    Promise.resolve().then(start).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function runtimeRequest(runtime, dependency, request) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(timeoutError()),
    timeoutMilliseconds(runtime.requestTimeoutMs)
  );
  try {
    const response = await runtime[dependency]({ ...request, signal: controller.signal });
    if (controller.signal.aborted) throw controller.signal.reason || timeoutError();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function requestJson({ method, url, accessToken, payload, signal }) {
  if (!['GET', 'PATCH'].includes(method)) {
    return Promise.reject(new Error('Existing Ruleset adoption permits GET and PATCH only.'));
  }
  if (!signal || typeof signal.addEventListener !== 'function') {
    return Promise.reject(new Error('Rules API transport requires an AbortSignal.'));
  }
  if (signal.aborted) return Promise.reject(signal.reason || timeoutError());
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const encoded = payload == null ? null : JSON.stringify(payload);
    const headers = { authorization: 'Bearer ' + accessToken };
    if (encoded != null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(encoded, 'utf8');
    }
    let settled = false;
    let pendingError = null;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortRequest);
      complete(value);
    };
    const rejectClosed = error => {
      if (settled) return;
      const failure = error || Object.assign(
        new Error('Rules API transport closed before a complete response.'),
        { code: 'ECONNRESET' }
      );
      if (method === 'PATCH') failure.mutationOutcomeUnknown = true;
      settle(reject, failure);
    };
    const request = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname + endpoint.search,
      method,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => {
        if (settled) return;
        if (!pendingError) pendingError = error;
        request.destroy(pendingError);
      });
      response.on('close', () => {
        if (settled) return;
        if (!pendingError) pendingError = Object.assign(
          new Error('Rules API response closed before completion.'),
          { code: 'ECONNRESET' }
        );
        if (!request.destroyed) request.destroy(pendingError);
        rejectClosed(pendingError);
      });
      response.on('end', () => {
        if (settled || pendingError) return;
        const statusCode = response.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          settle(resolve, { statusCode, body: text ? JSON.parse(text) : {} });
        } catch (error) {
          if (statusCode < 200 || statusCode >= 300) {
            settle(resolve, { statusCode, body: null, rawBody: text });
            return;
          }
          settle(reject, new Error('Rules API returned invalid JSON.', { cause: error }));
        }
      });
    });
    function abortRequest() {
      if (settled) return;
      pendingError = signal.reason || timeoutError();
      request.destroy(pendingError);
    }
    request.on('error', error => {
      if (settled) return;
      if (!pendingError) pendingError = error;
    });
    request.on('close', () => {
      rejectClosed(pendingError);
    });
    signal.addEventListener('abort', abortRequest, { once: true });
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

function readCurrentCommit() {
  const options = { encoding: 'utf8', timeout: 5_000, windowsHide: true };
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  const staticCommit = execFileSync(
    'git', ['log', '-1', '--format=%H', '--', ...STATIC_ASSET_PATHS], options
  ).trim();
  if (!COMMIT_PATTERN.test(sourceCommit) || !COMMIT_PATTERN.test(staticCommit)) {
    throw new Error('Local Git commit readback is not exact.');
  }
  return { sourceCommit, staticCommit };
}

function snapshotGeneration(snapshot) {
  const updateTime = snapshot && snapshot.updateTime;
  if (!updateTime || !Number.isInteger(updateTime.seconds) ||
      !Number.isInteger(updateTime.nanoseconds)) return '';
  return String(updateTime.seconds) + ':' + String(updateTime.nanoseconds);
}

function gateSnapshot(snapshot, path, fields) {
  if (!snapshot || !snapshot.exists) return { path, exists: false };
  const data = snapshot.data() || {};
  const evidence = { path, exists: true };
  for (const field of fields) evidence[field] = data[field];
  evidence.updateTimeGeneration = snapshotGeneration(snapshot);
  return evidence;
}

async function readCurrentGateState(projectId) {
  const { applicationDefault, deleteApp, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = initializeApp(
    { credential: applicationDefault(), projectId },
    'ruleset-adoption-gates-' + crypto.randomUUID()
  );
  try {
    const db = getFirestore(app);
    const paths = [
      SET_COUNTERS_PATH, TEACHER_ACCESS_PATH,
      SESSION_COUNTERS_LOCK_PATH, SESSION_COUNTERS_GATE_PATH
    ];
    const snapshots = await db.getAll(...paths.map(value => db.doc(value)));
    return {
      setCounters: gateSnapshot(snapshots[0], SET_COUNTERS_PATH, [
        'locked', 'lockId', 'projectId', 'targetMode'
      ]),
      teacherAccess: gateSnapshot(snapshots[1], TEACHER_ACCESS_PATH, [
        'locked', 'lockToken', 'projectId', 'targetMode',
        'status', 'strictReady', 'migrationGeneration'
      ]),
      sessionCountersLock: gateSnapshot(snapshots[2], SESSION_COUNTERS_LOCK_PATH, [
        'locked', 'lockToken', 'projectId', 'targetMode'
      ]),
      sessionCountersGate: (() => {
        const gate = gateSnapshot(snapshots[3], SESSION_COUNTERS_GATE_PATH, [
          'complete', 'projectId', 'environment',
          'rulesVersion', 'preflightNonEndedLegacyCount'
        ]);
        if (gate.exists) {
          gate.targetMode = gate.environment;
          delete gate.environment;
        }
        return gate;
      })()
    };
  } finally {
    await deleteApp(app);
  }
}

function currentCommitExact(current, manifest) {
  return exactObject(current) && current.sourceCommit === manifest.task4.headCommit &&
    current.staticCommit === manifest.release.staticCommit;
}

function currentGateStateExact(current, manifest) {
  if (!exactObject(current)) return false;
  const setCounters = current.setCounters;
  const teacherAccess = current.teacherAccess;
  const sessionLock = current.sessionCountersLock;
  const sessionGate = current.sessionCountersGate;
  return exactObject(setCounters) && setCounters.path === SET_COUNTERS_PATH &&
    setCounters.exists === true && setCounters.locked === true &&
    setCounters.projectId === PROJECT_ID && setCounters.targetMode === TARGET_MODE &&
    setCounters.lockId === manifest.locks.setCounters.lockId &&
    setCounters.updateTimeGeneration === manifest.locks.setCounters.updateTimeGeneration &&
    exactObject(teacherAccess) && teacherAccess.path === TEACHER_ACCESS_PATH &&
    teacherAccess.exists === true && teacherAccess.locked === true &&
    teacherAccess.projectId === PROJECT_ID && teacherAccess.targetMode === TARGET_MODE &&
    teacherAccess.status === 'complete' && teacherAccess.strictReady === true &&
    teacherAccess.lockToken === manifest.locks.teacherAccess.lockToken &&
    teacherAccess.updateTimeGeneration === manifest.locks.teacherAccess.updateTimeGeneration &&
    teacherAccess.migrationGeneration === manifest.locks.teacherAccess.migrationGeneration &&
    exactObject(sessionLock) && sessionLock.path === SESSION_COUNTERS_LOCK_PATH &&
    sessionLock.exists === true && sessionLock.locked === true &&
    sessionLock.projectId === PROJECT_ID && sessionLock.targetMode === TARGET_MODE &&
    sessionLock.lockToken === manifest.locks.sessionCounters.lockToken &&
    sessionLock.updateTimeGeneration === manifest.locks.sessionCounters.updateTimeGeneration &&
    exactObject(sessionGate) && sessionGate.path === SESSION_COUNTERS_GATE_PATH &&
    sessionGate.exists === true && sessionGate.complete === true &&
    sessionGate.projectId === PROJECT_ID && sessionGate.targetMode === TARGET_MODE &&
    sessionGate.rulesVersion === 'session-counters-v1' &&
    sessionGate.preflightNonEndedLegacyCount === 0 &&
    sessionGate.updateTimeGeneration === manifest.locks.sessionCounters.gateGeneration;
}

async function rollbackRelease(runtime, accessToken) {
  let patch = null;
  let patchError = null;
  try {
    patch = await runtimeRequest(runtime, 'patchJson', {
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
    readback = await runtimeRequest(runtime, 'getJson', {
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
    readCurrentCommit,
    readCurrentGateState,
    getJson: requestJson,
    patchJson: requestJson,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function writeLineSafely(runtime, line) {
  try { runtime.writeLine(line); } catch (_) { /* durable report remains authoritative */ }
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
    expectedManifestSha256: options.expectManifestSha256,
    createAttempted: false,
    releasePatchAttempted: false,
    rollbackAttempted: false,
    mutationOutcomeUnknown: false,
    providerStillOff: true,
    safeForExistingFlowSmoke: false,
    phase: 'reserved-before-manifest-validation',
    status: 'reserved-fail-closed'
  };
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(placeholder, null, 2) + '\n'
  );

  let manifest = null;
  let manifestSha256 = '';
  let accessToken = '';
  let phase = 'manifest-validation';
  let releasePatchAttempted = false;
  let releasePatchHttpStatus = 0;
  let releaseReadbackHttpStatus = 0;
  let targetRulesetReadbackExact = false;
  let currentCommitReadbackExact = false;
  let currentGateReadbackExact = false;
  try {
    const sealedManifest = readAndValidateSealedManifest(
      options.manifestPath, options.expectManifestSha256
    );
    manifest = sealedManifest.manifest;
    manifestSha256 = sealedManifest.manifestSha256;
    phase = 'local-commit-readback';
    let currentCommit;
    try {
      currentCommit = await withTimeout(
        () => runtime.readCurrentCommit(), runtime.requestTimeoutMs
      );
    } catch (error) {
      throw operationFailure('local-commit-readback-failed', null, error);
    }
    if (!currentCommitExact(currentCommit, manifest)) {
      throw operationFailure('local-commit-readback-mismatch', null, null);
    }
    currentCommitReadbackExact = true;
    accessToken = await runtime.acquireAccessToken();

    phase = 'target-ruleset-readback';
    let target;
    try {
      target = await runtimeRequest(runtime, 'getJson', {
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
    targetRulesetReadbackExact = true;

    phase = 'current-gate-readback';
    let currentGates;
    try {
      currentGates = await withTimeout(
        () => runtime.readCurrentGateState(PROJECT_ID), runtime.requestTimeoutMs
      );
    } catch (error) {
      throw operationFailure('current-gate-readback-failed', null, error);
    }
    if (!currentGateStateExact(currentGates, manifest)) {
      throw operationFailure('current-gate-readback-mismatch', null, null);
    }
    currentGateReadbackExact = true;

    phase = 'immediate-pre-patch-readback';
    let before;
    try {
      before = await runtimeRequest(runtime, 'getJson', {
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
      patched = await runtimeRequest(runtime, 'patchJson', {
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
      after = await runtimeRequest(runtime, 'getJson', {
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
      manifestSha256,
      rollbackRulesetName: manifest.rollback.rulesetName,
      quiescenceRulesetName: manifest.quiescence.rulesetName,
      gateGenerations: manifestGateGenerations(manifest),
      targetRulesetReadbackExact,
      currentCommitExact: currentCommitReadbackExact,
      currentGateStateExact: currentGateReadbackExact,
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
    writeLineSafely(runtime, [
      'project=' + PROJECT_ID,
      'status=complete',
      'ruleset=' + TARGET_RULESET,
      'createAttempted=false',
      'releaseReadbackExact=true',
      'providerStillOff=true'
    ].join(' '));
    return report;
  } catch (error) {
    const mutationOutcomeUnknown = Boolean(
      error && error.transportError && error.transportError.mutationOutcomeUnknown
    );
    const failure = describeRulesApiFailure(
      error && error.response, error && error.transportError ||
        (error && !error.failureCode ? error : null)
    );
    let rollback = null;
    if (releasePatchAttempted && !mutationOutcomeUnknown) {
      rollback = await rollbackRelease(runtime, accessToken);
    }
    const report = {
      ...placeholder,
      sourceCommit: manifest ? manifest.task4.headCommit : null,
      staticCommit: manifest ? manifest.release.staticCommit : null,
      manifestSha256,
      rollbackRulesetName: manifest ? manifest.rollback.rulesetName : null,
      quiescenceRulesetName: manifest ? manifest.quiescence.rulesetName : null,
      gateGenerations: manifest ? manifestGateGenerations(manifest) : null,
      targetRulesetReadbackExact,
      currentCommitExact: currentCommitReadbackExact,
      currentGateStateExact: currentGateReadbackExact,
      releasePatchAttempted,
      releasePatchHttpStatus,
      releaseReadbackHttpStatus,
      releaseReadbackRulesetName: '',
      releaseReadbackExact: false,
      rollbackAttempted: Boolean(rollback),
      mutationOutcomeUnknown,
      rollbackPatchHttpStatus: rollback ? rollback.patchHttpStatus : 0,
      rollbackReadbackHttpStatus: rollback ? rollback.readbackHttpStatus : 0,
      rollbackReadbackExact: rollback ? rollback.readbackExact : false,
      failureCode: mutationOutcomeUnknown
        ? 'target-release-patch-mutation-outcome-unknown'
        : error && error.failureCode || 'local-adoption-gate-failed',
      failure,
      rollbackFailure: rollback && !rollback.exact ? rollback.failure : null,
      phase,
      status: mutationOutcomeUnknown
        ? 'mutation-outcome-unknown'
        : rollback && rollback.exact ? 'failed-rolled-back' : 'failed',
      safeForExistingFlowSmoke: false
    };
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, [
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
  readCurrentCommit,
  readCurrentGateState,
  readAndValidateSealedManifest,
  requestJson,
  validateProductionEnvironment,
  validateSealedManifest
};
