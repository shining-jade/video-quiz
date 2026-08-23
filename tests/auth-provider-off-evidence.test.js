'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PROJECT = 'video-quiz-65798';
const WINDOW_ID = '8f81218d-f1ec-497a-9b33-2b895ef82780';
const CONTROL_ID = '05ff8306-c60d-4a0b-8ffd-a51cd57e8e45';
const CAPTURED_AT = '2026-08-23T05:03:00.123456789Z';

function loadCli() {
  return require('../scripts/read-auth-provider-off.js');
}

function argumentsFor() {
  return [
    '--project', PROJECT, '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID,
    '--output', 'r23-auth-provider-off.json'
  ];
}

function runtimeFor(response, overrides = {}) {
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
        return { commit(contents) { reports.push(JSON.parse(contents)); } };
      },
      acquireAccessToken: async () => 'private-token',
      async getJson(request) {
        calls.push(request);
        assert.equal(request.method, 'GET');
        assert.ok(request.signal instanceof AbortSignal);
        return typeof response === 'function' ? response(request) : response;
      },
      writeLine() {},
      ...overrides
    }
  };
}

test('Auth OFF CLI requires production and report-authored window/control identity', () => {
  const cli = loadCli();
  assert.throws(() => cli.parseArguments([
    '--project', PROJECT, '--target-mode', 'production', '--output', 'auth.json'
  ]), /window-id|control-id/i);
  assert.throws(() => cli.parseArguments([
    '--project', 'other-project', '--target-mode', 'production',
    '--window-id', WINDOW_ID, '--control-id', CONTROL_ID, '--output', 'auth.json'
  ]), /fixed production project/i);
});

test('Auth OFF CLI performs one authoritative GET and reports explicit Email/Password OFF', async () => {
  const cli = loadCli();
  const execution = runtimeFor({ statusCode: 200, body: {
    name: cli.CONFIG_NAME,
    signIn: { email: { enabled: false, passwordRequired: true } }
  } });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.tool, 'auth-email-password-off-evidence');
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.projectId, PROJECT);
  assert.equal(report.targetMode, 'production');
  assert.equal(report.windowId, WINDOW_ID);
  assert.equal(report.controlId, CONTROL_ID);
  assert.equal(report.capturedAt, CAPTURED_AT);
  assert.equal(report.operation, 'email-password-provider-readback');
  assert.equal(report.mode, 'get-only');
  assert.equal(report.status, 'complete');
  assert.equal(report.configName, cli.CONFIG_NAME);
  assert.equal(report.configReadHttpStatus, 200);
  assert.equal(report.emailPasswordEnabled, false);
  assert.equal(report.providerStateVerified, true);
  assert.equal(report.providerStillOff, true);
  assert.equal(report.writeCount, 0);
  assert.equal(report.error, null);
  assert.equal(execution.calls.length, 1);
  assert.equal(execution.calls[0].url, cli.CONFIG_URL);
  assert.equal(JSON.stringify(report).includes('private-token'), false);
  assert.equal(JSON.stringify(report).includes('passwordRequired'), false);
  assert.deepEqual(execution.reports.at(-1), report);
});

test('Auth OFF CLI fails closed on 403, enabled, missing, malformed, or transport failure', async t => {
  const cli = loadCli();
  const cases = [
    ['403', { statusCode: 403, body: {} }],
    ['enabled', { statusCode: 200, body: {
      name: cli.CONFIG_NAME, signIn: { email: { enabled: true } }
    } }],
    ['missing enabled', { statusCode: 200, body: {
      name: cli.CONFIG_NAME, signIn: { email: {} }
    } }],
    ['malformed name', { statusCode: 200, body: {
      name: 'projects/other/config', signIn: { email: { enabled: false } }
    } }],
    ['transport failure', () => {
      throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    }]
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const execution = runtimeFor(response);
      const report = await cli.main(argumentsFor(), execution.runtime);
      assert.equal(report.status, 'failed');
      assert.notEqual(report.providerStillOff, true);
      assert.notEqual(report.emailPasswordEnabled, false);
      assert.equal(report.writeCount, 0);
      assert.equal(typeof report.error.code, 'string');
      assert.equal(report.error.code.length > 0, true);
      assert.equal(execution.calls.every(call => call.method === 'GET'), true);
    });
  }
});

test('Auth OFF CLI bounds a never-settling GET and publishes no OFF claim', async () => {
  const cli = loadCli();
  const execution = runtimeFor(request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }), { requestTimeoutMs: 10 });
  const attempted = cli.main(argumentsFor(), execution.runtime);
  const report = await Promise.race([
    attempted,
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);

  assert.notEqual(report, 'test-deadline');
  assert.equal(report.status, 'failed');
  assert.equal(report.providerStateVerified, false);
  assert.equal(report.providerStillOff, false);
  assert.equal(report.emailPasswordEnabled, null);
  assert.equal(report.error.code, 'auth-config-read-timeout');
});

test('Auth OFF CLI rejects a late OFF response after its deadline', async () => {
  const cli = loadCli();
  const execution = runtimeFor(() => new Promise(resolve => {
    setTimeout(() => resolve({ statusCode: 200, body: {
      name: cli.CONFIG_NAME, signIn: { email: { enabled: false } }
    } }), 25);
  }), { requestTimeoutMs: 10 });
  const report = await cli.main(argumentsFor(), execution.runtime);

  assert.equal(report.status, 'failed');
  assert.equal(report.providerStateVerified, false);
  assert.equal(report.providerStillOff, false);
  assert.equal(report.emailPasswordEnabled, null);
  assert.equal(report.error.code, 'auth-config-read-timeout');
});
