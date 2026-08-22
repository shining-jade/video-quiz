'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../scripts/test-production-rules-source.js');
const { reserveReport } = require('../scripts/migrate-legacy-ownership.js');
const { measureRulesSource } = require('../rules-source-metrics.js');

const SMALL_SOURCE = 'rules_version = \'2\';\nservice cloud.firestore {\n  function allowed() { return false; }\n}\n';

function temporaryOutput(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-source-probe-'));
  return path.join(directory, name);
}

function dependencies(overrides = {}) {
  return {
    environment: {},
    readRulesSource: () => SMALL_SOURCE,
    reserveReport,
    acquireAccessToken: async () => 'adc-token-must-not-escape',
    postJson: async () => ({ statusCode: 200, body: { issues: [] } }),
    writeLine() {},
    ...overrides
  };
}

test('Rules source metrics use UTF-8 bytes, physical lines, and declared functions', () => {
  assert.deepEqual(measureRulesSource('function x() {}\n한\n'), {
    bytes: 20,
    lines: 2,
    functions: 1
  });
  assert.deepEqual(measureRulesSource(''), { bytes: 0, lines: 0, functions: 0 });
  assert.throws(() => measureRulesSource(Buffer.from('rules')), /string/);
});

test('production compiler probe requires an exact production target and refuses emulators', async () => {
  assert.throws(() => cli.parseArguments([
    '--project', 'video-quiz-65798', '--target-mode', 'emulator', '--output', 'probe.json'
  ]), /target-mode production/);
  assert.throws(() => cli.parseArguments([
    '--project', 'bad project', '--target-mode', 'production', '--output', 'probe.json'
  ]), /project/);
  assert.throws(() => cli.parseArguments([
    '--project', 'video-quiz-65798', '--target-mode', 'production'
  ]), /output/);
  const args = [
    '--project', 'video-quiz-65798', '--target-mode', 'production',
    '--output', temporaryOutput('refused.json')
  ];
  await assert.rejects(cli.main(args, dependencies({
    environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }
  })), /emulator/i);
  await assert.rejects(cli.main(args, dependencies({
    environment: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }
  })), /emulator/i);
});

test('production compiler probe posts only the supplied Rules source and keeps its ADC token private', async () => {
  const output = temporaryOutput('success.json');
  let request;
  const lines = [];
  const report = await cli.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ], dependencies({
    postJson: async value => {
      request = value;
      return { statusCode: 200, body: { issues: [] } };
    },
    writeLine: line => lines.push(line)
  }));

  assert.equal(request.url, 'https://firebaserules.googleapis.com/v1/projects/video-quiz-65798:test');
  assert.deepEqual(request.payload, {
    source: { files: [{ name: 'firestore.rules', content: SMALL_SOURCE }] }
  });
  assert.equal(request.accessToken, 'adc-token-must-not-escape');
  assert.equal(report.safeToCreateRuleset, true);
  assert.equal(report.status, 'complete');
  assert.deepEqual(Object.keys(report).sort(), [
    'issueCounts', 'metrics', 'projectId', 'safeToCreateRuleset', 'sourceSha256', 'status'
  ]);
  const disclosed = JSON.stringify(report) + '\n' + lines.join('\n');
  assert.equal(disclosed.includes('adc-token-must-not-escape'), false);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).safeToCreateRuleset, true);
});

test('production compiler probe keeps ERROR diagnostics and source-budget violations fail closed', async () => {
  const output = temporaryOutput('diagnostics.json');
  const report = await cli.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ], dependencies({
    postJson: async () => ({
      statusCode: 200,
      body: { issues: [{ severity: 'ERROR' }, { severity: 'WARNING' }] }
    })
  }));
  assert.equal(report.status, 'unsafe');
  assert.equal(report.issueCounts.error, 1);
  assert.equal(report.issueCounts.warning, 1);
  assert.equal(report.safeToCreateRuleset, false);

  const oversizeOutput = temporaryOutput('oversize.json');
  const oversize = await cli.main([
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', oversizeOutput
  ], dependencies({
    readRulesSource: () => 'x'.repeat(150001),
    postJson: async () => ({ statusCode: 200, body: { issues: [] } })
  }));
  assert.equal(oversize.status, 'unsafe');
  assert.equal(oversize.safeToCreateRuleset, false);
});

test('production compiler probe reports HTTP 5xx failures and never overwrites an output', async () => {
  const output = temporaryOutput('failure.json');
  const runtime = dependencies({ postJson: async () => ({ statusCode: 503, body: {} }) });
  const args = [
    '--project', 'video-quiz-65798', '--target-mode', 'production', '--output', output
  ];

  const failed = await cli.main(args, runtime);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.safeToCreateRuleset, false);
  assert.equal(failed.issueCounts.error, 1);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'failed');
  await assert.rejects(cli.main(args, runtime), /already exists/);
});
