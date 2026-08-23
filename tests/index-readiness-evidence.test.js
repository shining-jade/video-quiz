'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const cli = require('../scripts/read-firestore-index-readiness.js');

const PROJECT = 'video-quiz-65798';
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const CAPTURED_AT = '2026-08-23T05:55:00.123456789Z';
const INDEX_BYTES = fs.readFileSync('firestore.indexes.json');
const INDEX_SHA = crypto.createHash('sha256').update(INDEX_BYTES).digest('hex');

function argumentsFor() {
  return [
    '--project', PROJECT, '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID,
    '--output', 'r23-index-readiness.json'
  ];
}

function indexBody(overrides = {}) {
  return {
    name: cli.REQUIRED_INDEX_NAME,
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'updatedAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' }
    ],
    state: 'READY',
    ...overrides
  };
}

function runtimeFor(response) {
  const calls = [];
  const reports = [];
  return {
    calls,
    reports,
    runtime: {
      environment: {},
      now: () => CAPTURED_AT,
      readIndexesFile: () => INDEX_BYTES,
      reserveReport(_output, initial) {
        reports.push(JSON.parse(initial));
        return { commit(contents) { reports.push(JSON.parse(contents)); } };
      },
      acquireAccessToken: async () => 'private-token',
      async getJson(request) {
        calls.push(request);
        assert.equal(request.method, 'GET');
        assert.ok(request.signal instanceof AbortSignal);
        return typeof response === 'function' ? response(request) : response;
      },
      writeLine() {}
    }
  };
}

test('R8 production CLI requires report-authored window/control identity', () => {
  assert.throws(() => cli.parseArguments([
    '--project', PROJECT, '--target-mode', 'production', '--output', 'r8.json'
  ]), /window-id|control-id/i);
});

test('R8 GETs the one fixed index and records exact READY definition with no error', async () => {
  const execution = runtimeFor({ statusCode: 200, body: indexBody() });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.tool, 'firestore-index-readiness-evidence');
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.windowId, WINDOW_ID);
  assert.equal(report.controlId, CONTROL_ID);
  assert.equal(report.capturedAt, CAPTURED_AT);
  assert.equal(report.operation, 'exact-index-readback');
  assert.equal(report.mode, 'get-only');
  assert.equal(report.indexName, cli.REQUIRED_INDEX_NAME);
  assert.equal(report.indexState, 'READY');
  assert.equal(report.firestoreIndexesSha256, INDEX_SHA);
  assert.equal(report.allRequiredIndexesReady, true);
  assert.equal(report.error, null);
  assert.equal(report.writeCount, 0);
  assert.equal(execution.calls.length, 1);
  assert.equal(execution.calls[0].url, cli.API_ROOT + cli.REQUIRED_INDEX_NAME);
  assert.equal(JSON.stringify(report).includes('private-token'), false);
  assert.deepEqual(execution.reports.at(-1), report);
});

test('R8 fails closed on 403, unknown state, wrong name, or wrong field definition', async t => {
  const cases = [
    ['403', { statusCode: 403, body: {} }],
    ['building', { statusCode: 200, body: indexBody({ state: 'CREATING' }) }],
    ['wrong name', { statusCode: 200, body: indexBody({ name: cli.REQUIRED_INDEX_NAME + '-alias' }) }],
    ['wrong fields', { statusCode: 200, body: indexBody({ fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' }
    ] }) }]
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const execution = runtimeFor(response);
      const report = await cli.main(argumentsFor(), execution.runtime);
      assert.equal(report.status, 'failed');
      assert.equal(report.allRequiredIndexesReady, false);
      assert.equal(report.readyIndexCount, 0);
      assert.equal(report.error.code.length > 0, true);
      assert.equal(report.writeCount, 0);
    });
  }
});
