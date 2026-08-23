'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { describeRulesApiFailure, failureLine, MAX_MESSAGE } =
  require('../rules-api-failure.js');
const cli = require('../scripts/diagnose-rules-api.js');
const probe = require('../scripts/test-production-rules-source.js');
const { reserveReport } = require('../scripts/migrate-legacy-ownership.js');

const SMALL_SOURCE = 'rules_version = \'2\';\nservice cloud.firestore {\n  function allowed() { return false; }\n}\n';

function temporaryOutput(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-api-failure-'));
  return path.join(directory, name);
}

test('Rules API failure detail keeps the code, status, message, and details', () => {
  const failure = describeRulesApiFailure({
    statusCode: 503,
    body: {
      error: {
        code: 503,
        status: 'UNAVAILABLE',
        message: 'The service is currently unavailable.',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE_UNAVAILABLE',
          domain: 'firebaserules.googleapis.com'
        }]
      }
    }
  }, null);

  assert.equal(failure.httpStatus, 503);
  assert.equal(failure.apiCode, 503);
  assert.equal(failure.apiStatus, 'UNAVAILABLE');
  assert.equal(failure.apiMessage, '');
  assert.equal(failure.apiMessageCategory, 'API_MESSAGE_OMITTED');
  assert.deepEqual(failure.apiDetails, [
    {
      type: 'ERROR_INFO',
      reason: 'SERVICE_UNAVAILABLE',
      domain: 'firebaserules.googleapis.com'
    }
  ]);
  assert.equal(failure.transportError, '');
});

test('Rules API failure detail separates a quota refusal from a server-side stall', () => {
  const quota = describeRulesApiFailure({
    statusCode: 429,
    body: {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'The project has too many rulesets. Delete unused rulesets and retry.'
      }
    }
  }, null);

  assert.equal(quota.apiStatus, 'RESOURCE_EXHAUSTED');
  assert.equal(quota.apiMessageCategory, 'API_MESSAGE_OMITTED');
  assert.notEqual(quota.apiStatus, 'UNAVAILABLE');
});

test('Rules API failure detail records transport errors and non-JSON bodies', () => {
  const transport = describeRulesApiFailure(null, new Error('socket hang up'));
  assert.equal(transport.httpStatus, 0);
  assert.equal(transport.transportError, 'TRANSPORT_FAILURE');

  const html = describeRulesApiFailure({
    statusCode: 503, body: null, rawBody: '<html><title>503 Service Unavailable</title></html>'
  }, null);
  assert.equal(html.httpStatus, 503);
  assert.equal(html.rawBody, '');
  assert.equal(html.rawBodyCategory, 'NON_JSON_BODY_OMITTED');
});

test('Rules API failure detail never discloses a bearer token and stays bounded', () => {
  const leaky = describeRulesApiFailure(null,
    new Error('request failed with authorization Bearer ya29.a0AfB_secret-token-value'));

  assert.equal(leaky.transportError.includes('ya29.a0AfB_secret-token-value'), false);
  assert.equal(leaky.transportError, 'TRANSPORT_FAILURE');

  const huge = describeRulesApiFailure({
    statusCode: 500, body: { error: { message: 'x'.repeat(MAX_MESSAGE + 500) } }
  }, null);
  assert.equal(huge.apiMessage, '');
  assert.equal(huge.apiMessageCategory, 'API_MESSAGE_OMITTED');
});

test('failure reports persist only allowlisted diagnostics, never raw failure content', async () => {
  const secret = 'teacher@example.com uid_abc123 rules_version = \'2\'; private source';
  const failure = describeRulesApiFailure({
    statusCode: 503,
    rawBody: '<html>' + secret + '</html>',
    body: {
      error: {
        code: 503,
        status: 'UNAVAILABLE',
        message: secret,
        details: [{
          '@type': 'type.googleapis.com/private.' + secret,
          reason: secret,
          domain: secret,
          nested: secret
        }]
      }
    }
  }, new Error(secret));

  const serializedFailure = JSON.stringify(failure);
  assert.equal(serializedFailure.includes(secret), false);
  assert.equal(failure.httpStatus, 503);
  assert.equal(failure.apiCode, 503);
  assert.equal(failure.apiStatus, 'UNAVAILABLE');
  assert.equal(failure.rawBody, '');
  assert.equal(failure.transportError, 'TRANSPORT_FAILURE');

  const output = temporaryOutput('safe-persisted-failure.json');
  await probe.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ], {
    environment: {},
    readRulesSource: () => SMALL_SOURCE,
    reserveReport,
    acquireAccessToken: async () => 'adc-token-must-not-escape',
    postJson: async () => ({
      statusCode: 503,
      body: { error: { code: 503, status: 'UNAVAILABLE', message: secret } }
    }),
    writeLine() {}
  });

  const persisted = fs.readFileSync(output, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('adc-token-must-not-escape'), false);
});

test('failure line renders every field the 503 triage needs', () => {
  const line = failureLine(describeRulesApiFailure({
    statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'deadline' } }
  }, null));

  assert.match(line, /httpStatus=503/);
  assert.match(line, /apiStatus=UNAVAILABLE/);
  assert.match(line, /apiMessageCategory=API_MESSAGE_OMITTED/);
});

test('compiler probe now records why a non-2xx response failed', async () => {
  const output = temporaryOutput('probe-failure.json');
  const report = await probe.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ], {
    environment: {},
    readRulesSource: () => SMALL_SOURCE,
    reserveReport,
    acquireAccessToken: async () => 'adc-token-must-not-escape',
    postJson: async () => ({
      statusCode: 503,
      body: { error: { code: 503, status: 'UNAVAILABLE', message: 'deadline exceeded' } }
    }),
    writeLine() {}
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.safeToCreateRuleset, false);
  assert.equal(report.failure.httpStatus, 503);
  assert.equal(report.failure.apiStatus, 'UNAVAILABLE');
  assert.equal(report.failure.apiMessage, '');
  assert.equal(report.failure.apiMessageCategory, 'API_MESSAGE_OMITTED');

  const persisted = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(persisted.failure.apiMessage, '');
  assert.equal(persisted.failure.apiMessageCategory, 'API_MESSAGE_OMITTED');
  assert.equal(JSON.stringify(persisted).includes('adc-token-must-not-escape'), false);
});

test('Rules API diagnosis requires an exact production target and refuses emulators', () => {
  assert.throws(() => cli.parseArguments([
    '--project', 'video-quiz-65798', '--target-mode', 'emulator', '--output', 'd.json'
  ]), /target-mode production/);
  assert.throws(() => cli.parseArguments([
    '--project', 'video-quiz-65798', '--target-mode', 'production'
  ]), /output/);
  assert.throws(() => cli.validateProductionEnvironment({
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
  }), /emulator/i);
});

test('Rules API diagnosis counts rulesets across pages and reports remaining slots', async () => {
  const output = temporaryOutput('diagnosis.json');
  const urls = [];
  const report = await cli.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ], {
    environment: {},
    reserveReport,
    acquireAccessToken: async () => 'adc-token-must-not-escape',
    getJson: async ({ url }) => {
      urls.push(url);
      if (url.includes('/releases/')) {
        return {
          statusCode: 200,
          body: {
            name: 'projects/video-quiz-65798/releases/cloud.firestore',
            rulesetName: 'projects/video-quiz-65798/rulesets/74e79134',
            updateTime: '2026-08-20T00:00:00Z'
          }
        };
      }
      if (url.includes('pageToken=')) {
        return {
          statusCode: 200,
          body: { rulesets: [{ name: 'r3', createTime: '2026-08-22T00:00:00Z' }] }
        };
      }
      return {
        statusCode: 200,
        body: {
          rulesets: [
            { name: 'r1', createTime: '2026-01-01T00:00:00Z' },
            { name: 'r2', createTime: '2026-05-05T00:00:00Z' }
          ],
          nextPageToken: 'page-2'
        }
      };
    },
    writeLine() {}
  });

  assert.equal(report.status, 'complete');
  assert.equal(report.mutating, false);
  assert.equal(report.rulesetInventory.counted, 3);
  assert.equal(report.rulesetInventory.pages, 2);
  assert.equal(report.rulesetInventory.oldestCreateTime, '2026-01-01T00:00:00Z');
  assert.equal(report.rulesetInventory.newestCreateTime, '2026-08-22T00:00:00Z');
  assert.equal(report.remainingSlots, cli.RULESET_LIMIT - 3);
  assert.equal(report.verdict, 'ruleset-quota-has-headroom');
  assert.equal(report.release.activeRulesetName, 'projects/video-quiz-65798/rulesets/74e79134');
  assert.equal(urls.every(url => url.startsWith(cli.API_ROOT)), true);
  assert.equal(JSON.stringify(report).includes('adc-token-must-not-escape'), false);
});

test('Rules API diagnosis names the quota verdicts that explain a blocked create', () => {
  assert.equal(cli.verdictFor({
    listReadable: true, truncated: false, counted: cli.RULESET_LIMIT
  }), 'ruleset-quota-exhausted');
  assert.equal(cli.verdictFor({
    listReadable: true, truncated: false, counted: cli.RULESET_LIMIT - 1
  }), 'ruleset-quota-near-limit');
  assert.equal(cli.verdictFor({
    listReadable: true, truncated: true, counted: 4000
  }), 'ruleset-quota-unknown-listing-truncated');
  assert.equal(cli.verdictFor({
    listReadable: false, truncated: false, counted: 0
  }), 'ruleset-quota-unknown-list-failed');
});

test('Rules API diagnosis keeps the API failure when the listing is refused', async () => {
  const output = temporaryOutput('diagnosis-refused.json');
  const report = await cli.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ], {
    environment: {},
    reserveReport,
    acquireAccessToken: async () => 'token',
    getJson: async ({ url }) => {
      if (url.includes('/releases/')) {
        return { statusCode: 200, body: { name: 'n', rulesetName: 'r', updateTime: 't' } };
      }
      return {
        statusCode: 403,
        body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'caller lacks access' } }
      };
    },
    writeLine() {}
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.rulesetInventory.listReadable, false);
  assert.equal(report.rulesetInventory.failure.apiStatus, 'PERMISSION_DENIED');
  assert.equal(report.rulesetInventory.failure.httpStatus, 403);
  assert.equal(report.verdict, 'ruleset-quota-unknown-list-failed');
});
