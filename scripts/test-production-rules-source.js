#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { measureRulesSource } = require('../rules-source-metrics.js');
const { describeRulesApiFailure, failureLine } = require('../rules-api-failure.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const SOURCE_BUDGET = Object.freeze({ bytes: 130000, lines: 2700, functions: 190 });

function parseArguments(argv) {
  const options = { projectId: '', targetMode: '', outputPath: '' };
  const fields = new Map([
    ['--project', 'projectId'],
    ['--target-mode', 'targetMode'],
    ['--output', 'outputPath']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields.get(argument);
    if (!field || index + 1 >= argv.length || options[field]) {
      throw new Error('Unknown, duplicate, or incomplete compiler probe argument: ' + argument);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) {
    throw new Error('--project must be an exact Google Cloud project ID.');
  }
  if (options.targetMode !== 'production') {
    throw new Error('--target-mode production is required.');
  }
  if (!options.outputPath) throw new Error('--output is required.');
  return options;
}

function validateProductionEnvironment(environment = process.env) {
  const configuredEmulator = Object.keys(environment).find(key =>
    /(?:^|_)EMULATOR_HOST$/.test(key) && String(environment[key] || '')
  );
  if (configuredEmulator) {
    throw new Error('Production compiler probe refuses emulator environment variable ' + configuredEmulator + '.');
  }
}

function countIssues(issues) {
  if (!Array.isArray(issues)) throw new Error('Rules API response has no valid issues array.');
  const counts = { error: 0, warning: 0, info: 0, unknown: 0 };
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') {
      counts.unknown += 1;
    } else if (issue.severity === 'ERROR') {
      counts.error += 1;
    } else if (issue.severity === 'WARNING') {
      counts.warning += 1;
    } else if (issue.severity === 'INFO') {
      counts.info += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return counts;
}

function sourceMeetsBudget(metrics) {
  return metrics.bytes <= SOURCE_BUDGET.bytes && metrics.lines <= SOURCE_BUDGET.lines &&
    metrics.functions <= SOURCE_BUDGET.functions;
}

function sourceSha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function readRulesSource() {
  return fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8');
}

function acquireAccessToken() {
  const { applicationDefault } = require('firebase-admin/app');
  return applicationDefault().getAccessToken().then(value => {
    const token = typeof value === 'string' ? value : value && value.access_token;
    if (typeof token !== 'string' || !token) throw new Error('Application Default Credentials returned no access token.');
    return token;
  });
}

function postJson({ url, accessToken, payload }) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(payload);
    const endpoint = new URL(url);
    const request = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + accessToken,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded, 'utf8')
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: status, body: JSON.parse(text) });
        } catch (error) {
          // A proxy or frontend can answer a rejected request with HTML. Losing
          // the status code to a parse error would hide which failure it was.
          if (status < 200 || status >= 300) {
            resolve({ statusCode: status, body: null, rawBody: text });
            return;
          }
          reject(new Error('Rules API returned invalid JSON.', { cause: error }));
        }
      });
    });
    request.on('error', reject);
    request.end(encoded);
  });
}

function reportFor({ projectId, source, metrics, issueCounts, status, safeToCreateRuleset }) {
  return {
    projectId,
    sourceSha256: sourceSha256(source),
    metrics,
    issueCounts,
    status,
    safeToCreateRuleset
  };
}

function reportLine(report) {
  return [
    'project=' + report.projectId,
    'sourceSha256=' + report.sourceSha256,
    'bytes=' + report.metrics.bytes,
    'lines=' + report.metrics.lines,
    'functions=' + report.metrics.functions,
    'errors=' + report.issueCounts.error,
    'warnings=' + report.issueCounts.warning,
    'infos=' + report.issueCounts.info,
    'unknown=' + report.issueCounts.unknown,
    'status=' + report.status,
    'safeToCreateRuleset=' + report.safeToCreateRuleset
  ].concat(report.failure ? [failureLine(report.failure)] : []).join(' ');
}

function failClosedReport(projectId, source, metrics, failure) {
  const report = reportFor({
    projectId,
    source,
    metrics,
    issueCounts: { error: 1, warning: 0, info: 0, unknown: 0 },
    status: 'failed',
    safeToCreateRuleset: false
  });
  // Without this the report records only that the probe failed, never why: an
  // HTTP 503 from a server-side deadline and one from a refused request look
  // identical once the response body is dropped.
  report.failure = failure || describeRulesApiFailure(null, null);
  return report;
}

function productionDependencies() {
  return {
    environment: process.env,
    readRulesSource,
    reserveReport,
    acquireAccessToken,
    postJson,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

async function main(argv, dependencies) {
  const runtime = dependencies || productionDependencies();
  const options = parseArguments(argv);
  validateProductionEnvironment(runtime.environment || process.env);
  const source = await runtime.readRulesSource();
  const metrics = measureRulesSource(source);
  const placeholder = reportFor({
    projectId: options.projectId,
    source,
    metrics,
    issueCounts: { error: 1, warning: 0, info: 0, unknown: 0 },
    status: 'reserved-fail-closed',
    safeToCreateRuleset: false
  });
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(placeholder, null, 2) + '\n'
  );
  let report;
  try {
    const accessToken = await runtime.acquireAccessToken();
    const response = await runtime.postJson({
      url: 'https://firebaserules.googleapis.com/v1/projects/' + options.projectId + ':test',
      accessToken,
      payload: { source: { files: [{ name: 'firestore.rules', content: source }] } }
    });
    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      report = failClosedReport(
        options.projectId, source, metrics, describeRulesApiFailure(response, null)
      );
    } else {
      const issueCounts = countIssues(response.body && response.body.issues);
      const safeToCreateRuleset = sourceMeetsBudget(metrics) && issueCounts.error === 0 &&
        issueCounts.unknown === 0;
      report = reportFor({
        projectId: options.projectId,
        source,
        metrics,
        issueCounts,
        status: safeToCreateRuleset ? 'complete' : 'unsafe',
        safeToCreateRuleset
      });
    }
  } catch (error) {
    report = failClosedReport(
      options.projectId, source, metrics, describeRulesApiFailure(null, error)
    );
  }
  reservation.commit(JSON.stringify(report, null, 2) + '\n');
  runtime.writeLine(reportLine(report));
  return report;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    report => { process.exitCode = report.safeToCreateRuleset ? 0 : 2; },
    error => {
      process.stderr.write('Production Rules source probe failed: ' +
        String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  SOURCE_BUDGET,
  acquireAccessToken,
  countIssues,
  main,
  parseArguments,
  postJson,
  productionDependencies,
  reportLine,
  sourceMeetsBudget,
  sourceSha256,
  validateProductionEnvironment
};
