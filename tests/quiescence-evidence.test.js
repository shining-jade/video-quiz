'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cli = require('../scripts/start-r23-quiescence.js');

const PROJECT = 'video-quiz-65798';
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const CAPTURED_AT = '2026-08-23T05:05:00.123456789Z';
const UPDATE_TIME = '2026-08-23T05:05:01.987654321Z';
const PRIOR_UPDATE_TIME = '2026-08-23T05:04:00.111222333Z';
const PRIOR_RULESET = 'projects/' + PROJECT + '/rulesets/prior-compatible';
const OTHER_RULESET = 'projects/' + PROJECT + '/rulesets/unexpected';
const PRIOR_SOURCE = "rules_version = '2';\nservice cloud.firestore { match /{path=**} { allow read: if true; } }\n";
const DENY_SOURCE = "rules_version = '2';\n\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if false;\n    }\n  }\n}\n";

function argumentsFor() {
  return [
    '--project', PROJECT, '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID,
    '--output', 'r23-quiescence.json'
  ];
}

function successRuntime(overrides = {}, behavior = {}) {
  const calls = [];
  const reports = [];
  const state = {
    rulesetName: PRIOR_RULESET,
    updateTime: PRIOR_UPDATE_TIME
  };
  return {
    calls,
    reports,
    state,
    runtime: {
      environment: {},
      now: () => CAPTURED_AT,
      reserveReport(_output, initial) {
        reports.push(JSON.parse(initial));
        return {
          failClosedPath: 'r23-quiescence.json.reserved',
          commit(contents) { reports.push(JSON.parse(contents)); }
        };
      },
      acquireAccessToken: async () => 'private-token',
      async requestJson(request) {
        calls.push(request);
        assert.ok(request.signal instanceof AbortSignal);
        if (request.url === cli.FUNCTIONS_V1_URL) {
          return { statusCode: 200, body: { functions: [], unreachable: [] } };
        }
        if (request.url === cli.FUNCTIONS_V2_URL) {
          return { statusCode: 200, body: { functions: [], unreachable: [] } };
        }
        if (request.url === cli.SCHEDULER_LOCATIONS_URL) {
          return { statusCode: 200, body: { locations: [{
            name: 'projects/' + PROJECT + '/locations/us-central1'
          }] } };
        }
        if (request.url === cli.SCHEDULER_ROOT +
            'projects/' + PROJECT + '/locations/us-central1/jobs?pageSize=500') {
          return { statusCode: 200, body: { jobs: [{
            name: 'projects/' + PROJECT + '/locations/us-central1/jobs/nightly',
            state: 'PAUSED'
          }] } };
        }
        if (request.url === cli.RULES_ROOT + cli.QUIESCENCE_RULESET &&
            request.method === 'GET') {
          return behavior.denyRulesetResponse || { statusCode: 200, body: {
            name: cli.QUIESCENCE_RULESET,
            source: { files: [{ name: 'firestore.maintenance.rules', content: DENY_SOURCE }] }
          } };
        }
        if (request.url === cli.RULES_ROOT + PRIOR_RULESET && request.method === 'GET') {
          return behavior.priorRulesetResponse || { statusCode: 200, body: {
            name: PRIOR_RULESET,
            source: { files: [{ name: 'firestore.rules', content: PRIOR_SOURCE }] }
          } };
        }
        if (request.url === cli.RULES_ROOT + cli.RELEASE_NAME && request.method === 'PATCH') {
          const target = request.payload.release.rulesetName;
          if (target === PRIOR_RULESET) {
            if (behavior.rollbackPatchResponse instanceof Error) {
              throw behavior.rollbackPatchResponse;
            }
            if (behavior.rollbackPatchResponse) return behavior.rollbackPatchResponse;
            state.rulesetName = behavior.rollbackReadbackRuleset || PRIOR_RULESET;
            state.updateTime = '2026-08-23T05:05:02.111222333Z';
            return { statusCode: 200, body: {
              name: cli.RELEASE_NAME, rulesetName: PRIOR_RULESET
            } };
          }
          if (behavior.patchMode === 'settled-not-landed') {
            return { statusCode: 409, body: { error: { status: 'ABORTED' } } };
          }
          if (behavior.patchMode === 'settled-mismatch') {
            state.rulesetName = OTHER_RULESET;
            state.updateTime = '2026-08-23T05:05:01.444555666Z';
            return { statusCode: 200, body: {
              name: cli.RELEASE_NAME, rulesetName: cli.QUIESCENCE_RULESET
            } };
          }
          state.rulesetName = cli.QUIESCENCE_RULESET;
          state.updateTime = UPDATE_TIME;
          if (behavior.patchMode === 'transport-landed') {
            throw Object.assign(new Error('connection lost'), {
              code: 'ECONNRESET', mutationOutcomeUnknown: true
            });
          }
          if (behavior.patchMode === 'transport-prior') {
            state.rulesetName = PRIOR_RULESET;
            state.updateTime = PRIOR_UPDATE_TIME;
            throw Object.assign(new Error('connection lost'), {
              code: 'ECONNRESET', mutationOutcomeUnknown: true
            });
          }
          return { statusCode: 200, body: {
            name: cli.RELEASE_NAME, rulesetName: cli.QUIESCENCE_RULESET
          } };
        }
        if (request.url === cli.RULES_ROOT + cli.RELEASE_NAME && request.method === 'GET') {
          if (behavior.releaseReadError) throw behavior.releaseReadError;
          if (behavior.baselineReleaseResponse &&
              !calls.some(call => call.method === 'PATCH')) {
            return behavior.baselineReleaseResponse;
          }
          return { statusCode: 200, body: {
            name: cli.RELEASE_NAME, rulesetName: state.rulesetName,
            updateTime: state.updateTime
          } };
        }
        if (request.url === cli.ANONYMOUS_PROBE_URL) {
          assert.equal(request.accessToken, '');
          return { statusCode: 403, body: {} };
        }
        throw new Error('unexpected URL ' + request.url);
      },
      writeLine() {},
      ...overrides
    }
  };
}

test('R1 production CLI requires immutable window/control identity before reservation', async () => {
  assert.throws(() => cli.parseArguments([
    '--project', PROJECT, '--target-mode', 'production', '--output', 'r1.json'
  ]), /window-id|control-id/i);
  assert.throws(() => cli.parseArguments([
    '--project', 'other-project', '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID, '--output', 'r1.json'
  ]), /fixed production project/i);
  await assert.rejects(cli.main(argumentsFor(), {
    environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    reserveReport() { throw new Error('must not reserve'); }
  }), /emulator/i);
});

test('R1 succeeds only after authoritative provider inventory, exact PATCH/readback, and anonymous 403', async () => {
  const execution = successRuntime();
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.tool, 'r23-quiescence-evidence');
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.windowId, WINDOW_ID);
  assert.equal(report.controlId, CONTROL_ID);
  assert.equal(report.capturedAt, CAPTURED_AT);
  assert.equal(report.status, 'complete');
  assert.equal(report.phase, 'quiescence-established');
  assert.equal(report.releaseUpdateTime, UPDATE_TIME);
  assert.equal(cli.QUIESCENCE_RULESET_SOURCE_SHA256,
    'cd5089e4e5116dbb994013dc5fd5e7e411ec348935b8d06d13acd00173cca15b');
  assert.equal(report.quiescenceRulesetSourceSha256,
    'cd5089e4e5116dbb994013dc5fd5e7e411ec348935b8d06d13acd00173cca15b');
  assert.equal(report.quiescenceRulesetSourceReadbackExact, true);
  assert.equal(report.priorReleaseRulesetName, PRIOR_RULESET);
  assert.equal(report.priorReleaseUpdateTime, PRIOR_UPDATE_TIME);
  assert.equal(report.priorRulesetSourceSha256,
    '818d70008059c918f3c12b8cbb6756e3e05af44787554e6d6791c9015a04ef5c');
  assert.equal(report.releasePatchOutcome, 'response-success');
  assert.equal(report.mutationOutcomeUnknown, false);
  assert.equal(report.rollbackAttempted, false);
  assert.equal(report.providerChecksComplete, true);
  assert.equal(report.cloudFunctionsStopped, true);
  assert.equal(report.schedulerStopped, true);
  assert.equal(report.trustedWritersStopped, true);
  assert.equal(report.writerInventory.cloudFunctionsV1.functions.length, 0);
  assert.equal(report.writerInventory.cloudFunctionsV2.functions.length, 0);
  assert.deepEqual(report.writerInventory.cloudScheduler.jobs, [{
    name: 'projects/' + PROJECT + '/locations/us-central1/jobs/nightly',
    state: 'PAUSED'
  }]);
  assert.equal(report.error, null);
  assert.equal(report.firestoreDataWriteCount, 0);
  assert.equal(report.releasePatchCount, 1);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(execution.calls.some(call => call.method === 'POST'), false);
  const denyRead = execution.calls.findIndex(call =>
    call.url === cli.RULES_ROOT + cli.QUIESCENCE_RULESET && call.method === 'GET');
  const priorRead = execution.calls.findIndex(call =>
    call.url === cli.RULES_ROOT + PRIOR_RULESET && call.method === 'GET');
  const targetPatch = execution.calls.findIndex(call => call.method === 'PATCH');
  assert.ok(denyRead >= 0 && denyRead < targetPatch);
  assert.ok(priorRead >= 0 && priorRead < targetPatch);
  assert.equal(JSON.stringify(report).includes('private-token'), false);
  assert.deepEqual(execution.reports.at(-1), report);
});

test('R1 source-verifies the deny target and exact prior immutable Ruleset before PATCH', async t => {
  const cases = [
    ['deny source unavailable', {
      denyRulesetResponse: { statusCode: 403, body: {} }
    }],
    ['deny source hash mismatch', {
      denyRulesetResponse: { statusCode: 200, body: {
        name: cli.QUIESCENCE_RULESET,
        source: { files: [{ name: 'deny.rules', content: DENY_SOURCE + ' ' }] }
      } }
    }],
    ['deny source filename is not bounded evidence', {
      denyRulesetResponse: { statusCode: 200, body: {
        name: cli.QUIESCENCE_RULESET,
        source: { files: [{ name: 'nested/deny.rules', content: DENY_SOURCE }] }
      } }
    }],
    ['baseline release unavailable', {
      releaseReadError: Object.assign(new Error('release unavailable'), { code: 'EHOSTUNREACH' })
    }],
    ['baseline release has no immutable Ruleset ID', {
      baselineReleaseResponse: { statusCode: 200, body: {
        name: cli.RELEASE_NAME,
        rulesetName: 'projects/' + PROJECT + '/rulesets/',
        updateTime: PRIOR_UPDATE_TIME
      } }
    }],
    ['prior immutable source unavailable', {
      priorRulesetResponse: { statusCode: 403, body: {} }
    }],
    ['prior immutable identity mismatch', {
      priorRulesetResponse: { statusCode: 200, body: {
        name: OTHER_RULESET,
        source: { files: [{ name: 'firestore.rules', content: PRIOR_SOURCE }] }
      } }
    }]
  ];
  for (const [name, behavior] of cases) {
    await t.test(name, async () => {
      const execution = successRuntime({}, behavior);
      const report = await cli.main(argumentsFor(), execution.runtime);
      assert.equal(report.status, 'failed');
      assert.equal(report.releasePatchAttempted, false);
      assert.equal(report.providerChecksComplete, true);
      assert.equal(report.trustedWritersStopped, true);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('R1 rejects a late Rules source response after its bounded deadline', async () => {
  const execution = successRuntime({ requestTimeoutMs: 10 });
  const baseRequest = execution.runtime.requestJson;
  execution.runtime.requestJson = request => request.url ===
      cli.RULES_ROOT + cli.QUIESCENCE_RULESET
    ? new Promise(resolve => setTimeout(() => resolve({ statusCode: 200, body: {
      name: cli.QUIESCENCE_RULESET,
      source: { files: [{ name: 'deny.rules', content: DENY_SOURCE }] }
    } }), 25))
    : baseRequest(request);
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'failed');
  assert.equal(report.releasePatchAttempted, false);
  assert.equal(report.error.code, 'provider-read-timeout');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('R1 reconciles a server-landed PATCH whose transport response was lost', async () => {
  const execution = successRuntime({}, { patchMode: 'transport-landed' });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'complete');
  assert.equal(report.releasePatchOutcome, 'landed-reconciled');
  assert.equal(report.releasePatchHttpStatus, 0);
  assert.equal(report.releaseReadbackRulesetName, cli.QUIESCENCE_RULESET);
  assert.equal(report.releaseReadbackExact, true);
  assert.equal(report.mutationOutcomeUnknown, false);
  assert.equal(report.rollbackAttempted, false);
});

test('R1 reports a settled non-2xx with exact unchanged baseline as definitely not landed', async () => {
  const execution = successRuntime({}, { patchMode: 'settled-not-landed' });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'failed');
  assert.equal(report.releasePatchOutcome, 'definitely-not-landed');
  assert.equal(report.releasePatchHttpStatus, 409);
  assert.equal(report.releaseReadbackRulesetName, PRIOR_RULESET);
  assert.equal(report.releaseReadbackUpdateTime, PRIOR_UPDATE_TIME);
  assert.equal(report.finalReleaseStateKnown, true);
  assert.equal(report.mutationOutcomeUnknown, false);
  assert.equal(report.rollbackAttempted, false);
});

test('R1 keeps a non-target transport-loss reconciliation indeterminate without rollback', async () => {
  const execution = successRuntime({}, { patchMode: 'transport-prior' });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'mutation-outcome-unknown');
  assert.equal(report.releasePatchOutcome, 'mutation-outcome-unknown');
  assert.equal(report.releaseReadbackRulesetName, PRIOR_RULESET);
  assert.equal(report.finalReleaseStateKnown, false);
  assert.equal(report.mutationOutcomeUnknown, true);
  assert.equal(report.rollbackAttempted, false);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('R1 rolls a settled target mismatch back to the exact captured prior Ruleset', async () => {
  const execution = successRuntime({}, { patchMode: 'settled-mismatch' });
  const report = await cli.main(argumentsFor(), execution.runtime);
  const patches = execution.calls.filter(call => call.method === 'PATCH');

  assert.equal(report.status, 'failed-rolled-back');
  assert.equal(report.releasePatchOutcome, 'mismatch-rolled-back');
  assert.equal(report.providerChecksComplete, true);
  assert.equal(report.trustedWritersStopped, true);
  assert.equal(report.rollbackAttempted, true);
  assert.equal(report.rollbackReadbackExact, true);
  assert.equal(report.finalReleaseRulesetName, PRIOR_RULESET);
  assert.equal(report.finalReleaseStateKnown, true);
  assert.equal(patches.length, 2);
  assert.equal(patches[1].payload.release.rulesetName, PRIOR_RULESET);
});

test('R1 reports a failed exact-prior rollback without contradictory safety claims', async () => {
  const execution = successRuntime({}, {
    patchMode: 'settled-mismatch',
    rollbackPatchResponse: { statusCode: 503, body: {} }
  });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'failed');
  assert.equal(report.releasePatchOutcome, 'mismatch-rollback-failed');
  assert.equal(report.rollbackAttempted, true);
  assert.equal(report.rollbackPatchHttpStatus, 503);
  assert.equal(report.rollbackReadbackExact, false);
  assert.equal(report.finalReleaseRulesetName, OTHER_RULESET);
  assert.equal(report.finalReleaseStateKnown, true);
  assert.equal(report.mutationOutcomeUnknown, false);
});

test('R1 keeps a lost rollback response unknown unless GET proves exact prior', async () => {
  const execution = successRuntime({}, {
    patchMode: 'settled-mismatch',
    rollbackPatchResponse: Object.assign(new Error('rollback connection lost'), {
      code: 'ECONNRESET', mutationOutcomeUnknown: true
    })
  });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'mutation-outcome-unknown');
  assert.equal(report.releasePatchOutcome, 'mismatch-rollback-failed');
  assert.equal(report.rollbackAttempted, true);
  assert.equal(report.rollbackPatchHttpStatus, 0);
  assert.equal(report.rollbackReadbackRulesetName, OTHER_RULESET);
  assert.equal(report.rollbackReadbackExact, false);
  assert.equal(report.finalReleaseStateKnown, false);
  assert.equal(report.mutationOutcomeUnknown, true);
});

test('R1 fails closed before PATCH on provider 403, partial locations, active functions, or enabled jobs', async t => {
  const cases = [
    ['provider 403', request => request.url === cli.FUNCTIONS_V1_URL
      ? { statusCode: 403, body: {} } : null],
    ['unreachable function location', request => request.url === cli.FUNCTIONS_V2_URL
      ? { statusCode: 200, body: { functions: [], unreachable: ['asia-northeast3'] } } : null],
    ['malformed provider pagination', request => request.url === cli.FUNCTIONS_V1_URL
      ? { statusCode: 200, body: {
        functions: [], unreachable: [], nextPageToken: 7
      } } : null],
    ['active function', request => request.url === cli.FUNCTIONS_V1_URL
      ? { statusCode: 200, body: { functions: [{ name: 'projects/p/locations/r/functions/f' }], unreachable: [] } }
      : null],
    ['enabled scheduler', request => request.url.includes('/jobs?pageSize=500')
      ? { statusCode: 200, body: { jobs: [{ name: 'job-a', state: 'ENABLED' }] } } : null],
    ['wrong scheduler job identity', request => request.url.includes('/jobs?pageSize=500')
      ? { statusCode: 200, body: { jobs: [{
        name: 'projects/other/locations/us-central1/jobs/nightly', state: 'PAUSED'
      }] } } : null]
  ];
  for (const [name, replace] of cases) {
    await t.test(name, async () => {
      const execution = successRuntime();
      const baseRequest = execution.runtime.requestJson;
      execution.runtime.requestJson = async request => replace(request) || baseRequest(request);
      const report = await cli.main(argumentsFor(), execution.runtime);
      assert.equal(report.status, 'failed');
      assert.equal(report.providerChecksComplete, false);
      assert.equal(report.trustedWritersStopped, false);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('R1 never claims success when exact release readback or anonymous denial is unavailable', async t => {
  const cases = [
    ['release drift', request => request.url === cli.RULES_ROOT + cli.RELEASE_NAME &&
      request.method === 'GET' ? { statusCode: 200, body: {
        name: cli.RELEASE_NAME, rulesetName: 'projects/other/rulesets/other', updateTime: UPDATE_TIME
      } } : null],
    ['anonymous unknown', request => request.url === cli.ANONYMOUS_PROBE_URL
      ? { statusCode: 503, body: {} } : null]
  ];
  for (const [name, replace] of cases) {
    await t.test(name, async () => {
      const execution = successRuntime();
      const baseRequest = execution.runtime.requestJson;
      execution.runtime.requestJson = async request => replace(request) || baseRequest(request);
      const report = await cli.main(argumentsFor(), execution.runtime);
      assert.equal(report.status, 'failed');
      assert.equal(report.providerChecksComplete, true);
      assert.equal(report.trustedWritersStopped, true);
      assert.equal(report.error.code.length > 0, true);
    });
  }
});
