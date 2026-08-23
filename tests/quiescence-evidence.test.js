'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cli = require('../scripts/start-r23-quiescence.js');

const PROJECT = 'video-quiz-65798';
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const CAPTURED_AT = '2026-08-23T05:05:00.123456789Z';
const UPDATE_TIME = '2026-08-23T05:05:01.987654321Z';

function argumentsFor() {
  return [
    '--project', PROJECT, '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID,
    '--output', 'r23-quiescence.json'
  ];
}

function successRuntime(overrides = {}) {
  const calls = [];
  const reports = [];
  return {
    calls,
    reports,
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
        if (request.url === cli.RULES_ROOT + cli.RELEASE_NAME && request.method === 'PATCH') {
          return { statusCode: 200, body: {
            name: cli.RELEASE_NAME, rulesetName: cli.QUIESCENCE_RULESET
          } };
        }
        if (request.url === cli.RULES_ROOT + cli.RELEASE_NAME && request.method === 'GET') {
          return { statusCode: 200, body: {
            name: cli.RELEASE_NAME, rulesetName: cli.QUIESCENCE_RULESET,
            updateTime: UPDATE_TIME
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
  assert.equal(JSON.stringify(report).includes('private-token'), false);
  assert.deepEqual(execution.reports.at(-1), report);
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
      assert.equal(report.trustedWritersStopped, false);
      assert.equal(report.error.code.length > 0, true);
    });
  }
});
