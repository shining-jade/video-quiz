'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const cli = require('../scripts/diagnose-rules-api.js');
const { reserveReport } = require('../scripts/migrate-legacy-ownership.js');

const PROJECT = 'video-quiz-65798';
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const CAPTURED_AT = '2026-08-23T05:02:00.123456789Z';
const API_ROOT = cli.API_ROOT;
const RELEASE = {
  name: 'projects/video-quiz-65798/releases/cloud.firestore',
  rulesetName: 'projects/video-quiz-65798/rulesets/active',
  updateTime: '2026-08-22T23:40:00Z'
};

function temporaryOutput(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-api-diagnosis-'));
  return path.join(directory, name);
}

function argumentsFor(output, expectedSha256) {
  return [
    '--project', PROJECT,
    '--target-mode', 'production',
    '--window-id', WINDOW_ID,
    '--control-id', CONTROL_ID,
    '--expect-sha', expectedSha256,
    '--output', output
  ];
}

function strictGetTransport(respond) {
  const calls = [];
  return {
    calls,
    getJson: async request => {
      if (request.method !== 'GET') {
        throw new Error('diagnosis transport must use GET, received ' + String(request.method));
      }
      calls.push(request);
      return respond(request.url);
    }
  };
}

test('Rules API diagnosis validates an exact project and refuses emulator configuration', async () => {
  assert.throws(() => cli.parseArguments([
    '--project', 'Video-quiz-65798', '--target-mode', 'production', '--output', 'diagnosis.json'
  ]), /fixed production project/);
  assert.throws(() => cli.parseArguments([
    '--project', 'other-valid-project', '--target-mode', 'production', '--output', 'diagnosis.json'
  ]), /fixed production project/);
  assert.throws(() => cli.parseArguments([
    '--project', PROJECT, '--target-mode', 'production', '--expect-sha', 'ABC', '--output', 'x'
  ]), /exact lowercase sha256/);
  assert.throws(() => cli.parseArguments([
    '--project', PROJECT, '--target-mode', 'production', '--output', 'x'
  ]), /window-id|control-id/i);
  assert.throws(() => cli.validateProductionEnvironment({
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
  }), /refuses emulator/i);

  const source = 'rules_version = \'2\';\n';
  const output = temporaryOutput('emulator-refused.json');
  await assert.rejects(cli.main(argumentsFor(output, sha256(source)), {
    environment: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
    reserveReport,
    acquireAccessToken: async () => 'private-token',
    getJson: async () => { throw new Error('must not issue a request'); },
    writeLine() {}
  }), /refuses emulator/i);
});

test('Rules API diagnosis reserves one output and propagates exact GET-only readback evidence', async () => {
  const source = 'rules_version = \'2\';\n// recovered ruleset\n';
  const expectedSha256 = sha256(source);
  const output = temporaryOutput('diagnosis.json');
  const recoveredName = 'projects/' + PROJECT + '/rulesets/recovered';
  const transport = strictGetTransport(url => {
    if (url === API_ROOT + 'projects/' + PROJECT + '/releases/cloud.firestore') {
      return { statusCode: 200, body: RELEASE };
    }
    if (url === API_ROOT + 'projects/' + PROJECT + '/rulesets?pageSize=100') {
      return {
        statusCode: 200,
        body: { rulesets: [{ name: recoveredName, createTime: '2026-08-22T23:41:00Z' }] }
      };
    }
    if (url === API_ROOT + recoveredName) {
      return {
        statusCode: 200,
        body: { source: { files: [{ name: 'firestore.rules', content: source }] } }
      };
    }
    throw new Error('unexpected URL ' + url);
  });
  const runtime = {
    environment: {},
    reserveReport,
    acquireAccessToken: async () => 'private-token',
    getJson: transport.getJson,
    now: () => CAPTURED_AT,
    writeLine() {}
  };

  const report = await cli.main(argumentsFor(output, expectedSha256), runtime);

  assert.equal(report.status, 'complete');
  assert.equal(report.tool, 'rules-api-503-diagnosis');
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.windowId, WINDOW_ID);
  assert.equal(report.controlId, CONTROL_ID);
  assert.equal(report.capturedAt, CAPTURED_AT);
  assert.deepEqual(report.release, {
    readable: true,
    releaseName: RELEASE.name,
    activeRulesetName: RELEASE.rulesetName,
    updateTime: RELEASE.updateTime
  });
  assert.equal(report.reconciliation.writeLanded, true);
  assert.deepEqual(report.reconciliation.matchingRulesetNames, [recoveredName]);
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.calls.every(call => call.method === 'GET'), true);
  assert.equal(JSON.stringify(report).includes('private-token'), false);

  await assert.rejects(cli.main(argumentsFor(output, expectedSha256), runtime), /already exists/);
});

test('Rules API diagnosis accounts for the full 2,500-ruleset quota with GET only', async () => {
  const output = temporaryOutput('quota.json');
  const rulesets = Array.from({ length: cli.RULESET_LIMIT }, (_, index) => ({
    name: 'projects/' + PROJECT + '/rulesets/' + index,
    createTime: '2026-08-22T23:41:00Z'
  }));
  const transport = strictGetTransport(url => {
    if (url === API_ROOT + 'projects/' + PROJECT + '/releases/cloud.firestore') {
      return { statusCode: 200, body: RELEASE };
    }
    if (url === API_ROOT + 'projects/' + PROJECT + '/rulesets?pageSize=100') {
      return { statusCode: 200, body: { rulesets } };
    }
    throw new Error('unexpected URL ' + url);
  });

  const report = await cli.main([
    '--project', PROJECT, '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID, '--output', output
  ], {
    environment: {},
    reserveReport,
    acquireAccessToken: async () => 'private-token',
    getJson: transport.getJson,
    now: () => CAPTURED_AT,
    writeLine() {}
  });

  assert.equal(report.rulesetInventory.counted, 2500);
  assert.equal(report.rulesetLimit, 2500);
  assert.equal(report.remainingSlots, 0);
  assert.equal(report.verdict, 'ruleset-quota-exhausted');
  assert.equal(transport.calls.every(call => call.method === 'GET'), true);
});

test('Rules API diagnosis persists allowlisted read failures without raw private content', async () => {
  const secret = 'teacher@example.com uid_abc123 private rules source';
  const output = temporaryOutput('safe-failure.json');
  const report = await cli.main([
    '--project', PROJECT, '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID, '--output', output
  ], {
    environment: {},
    reserveReport,
    acquireAccessToken: async () => 'private-token',
    getJson: async ({ method }) => {
      assert.equal(method, 'GET');
      return {
        statusCode: 503,
        rawBody: '<html>' + secret + '</html>',
        body: { error: { code: 503, status: 'UNAVAILABLE', message: secret } }
      };
    },
    now: () => CAPTURED_AT,
    writeLine() {}
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.release.failure.apiStatus, 'UNAVAILABLE');
  assert.equal(report.release.failure.apiMessageCategory, 'API_MESSAGE_OMITTED');
  const persisted = fs.readFileSync(output, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('private-token'), false);
});

test('with --expect-sha only one readable matching Ruleset is determinate success', async t => {
  const source = "rules_version = '2';\n";
  const expectedSha256 = sha256(source);
  const matching = [
    'projects/' + PROJECT + '/rulesets/match-a',
    'projects/' + PROJECT + '/rulesets/match-b'
  ];
  const cases = [
    ['no match', [matching[0]], () => ({
      statusCode: 200,
      body: { source: { files: [{ name: 'firestore.rules', content: source + '// other' }] } }
    })],
    ['unreadable match candidate', [matching[0]], () => ({
      statusCode: 503,
      body: { error: { code: 503, status: 'UNAVAILABLE' } }
    })],
    ['multiple matches', matching, () => ({
      statusCode: 200,
      body: { source: { files: [{ name: 'firestore.rules', content: source }] } }
    })]
  ];

  for (const [name, rulesetNames, sourceResponse] of cases) {
    await t.test(name, async () => {
      const output = temporaryOutput(name.replace(/ /g, '-') + '.json');
      const transport = strictGetTransport(url => {
        if (url === API_ROOT + 'projects/' + PROJECT + '/releases/cloud.firestore') {
          return { statusCode: 200, body: RELEASE };
        }
        if (url === API_ROOT + 'projects/' + PROJECT + '/rulesets?pageSize=100') {
          return {
            statusCode: 200,
            body: { rulesets: rulesetNames.map((rulesetName, index) => ({
              name: rulesetName,
              createTime: '2026-08-23T05:0' + index + ':00Z'
            })) }
          };
        }
        if (rulesetNames.some(rulesetName => url === API_ROOT + rulesetName)) {
          return sourceResponse();
        }
        throw new Error('unexpected URL ' + url);
      });
      const report = await cli.main(argumentsFor(output, expectedSha256), {
        environment: {},
        reserveReport,
        acquireAccessToken: async () => 'private-token',
        getJson: transport.getJson,
        now: () => CAPTURED_AT,
        writeLine() {}
      });

      assert.equal(report.status, 'indeterminate');
      assert.notEqual(report.reconciliation.matchingRulesetNames.length, 1);
    });
  }
});

test('diagnosis applies a bounded deadline to every injected GET', async () => {
  const output = temporaryOutput('bounded-get.json');
  let observedSignal = null;
  const attempted = cli.main([
    '--project', PROJECT,
    '--target-mode', 'production',
    '--window-id', WINDOW_ID,
    '--control-id', CONTROL_ID,
    '--output', output
  ], {
    environment: {},
    requestTimeoutMs: 10,
    reserveReport,
    acquireAccessToken: async () => 'private-token',
    getJson(request) {
      observedSignal = request.signal;
      return new Promise((resolve, reject) => {
        if (request.signal) {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true
          });
        }
      });
    },
    now: () => CAPTURED_AT,
    writeLine() {}
  });
  const report = await Promise.race([
    attempted,
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);

  assert.notEqual(report, 'test-deadline');
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.equal(report.status, 'failed');
});

test('production GET transport destroys the HTTPS request when aborted', async t => {
  const originalRequest = https.request;
  const request = new EventEmitter();
  const events = [];
  request.destroy = error => {
    events.push('destroy:' + error.code);
    request.emit('error', error);
  };
  request.end = () => events.push('end');
  https.request = () => request;
  t.after(() => { https.request = originalRequest; });

  const controller = new AbortController();
  const requested = cli.getJson({
    url: API_ROOT + 'projects/' + PROJECT + '/releases/cloud.firestore',
    accessToken: 'private-token',
    method: 'GET',
    signal: controller.signal
  });
  controller.abort(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }));
  const result = await Promise.race([
    requested.then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);

  assert.notEqual(result, 'test-deadline');
  assert.equal(result.code, 'ETIMEDOUT');
  assert.deepEqual(events, ['end', 'destroy:ETIMEDOUT']);
});

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
