#!/usr/bin/env node
'use strict';

const {
  EVIDENCE_ARGUMENT_FIELDS, authorEvidenceReport, captureEvidenceIdentity,
  validateEvidenceIdentityOptions
} = require('../release-evidence-identity.js');
const { acquireAccessToken, requestJson } = require('../release-http-json.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const PROJECT_ID = 'video-quiz-65798';
const CONFIG_NAME = 'projects/video-quiz-65798/config';
const CONFIG_URL = 'https://identitytoolkit.googleapis.com/admin/v2/' + CONFIG_NAME;
const REQUEST_TIMEOUT_MS = 30_000;

function parseArguments(argv) {
  const options = {
    projectId: '', targetMode: '', windowId: '', controlId: '', outputPath: ''
  };
  const fields = {
    '--project': 'projectId', '--target-mode': 'targetMode', '--output': 'outputPath',
    ...EVIDENCE_ARGUMENT_FIELDS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields[argument];
    const value = argv[index + 1];
    if (!field || !value || value.startsWith('--') || options[field]) {
      throw new Error('Unknown, duplicate, or incomplete Auth-provider argument: ' + argument);
    }
    options[field] = value;
    index += 1;
  }
  if (options.projectId !== PROJECT_ID) {
    throw new Error('--project must name the fixed production project.');
  }
  if (options.targetMode !== 'production') {
    throw new Error('--target-mode production is required.');
  }
  if (!options.outputPath) throw new Error('--output is required.');
  validateEvidenceIdentityOptions(options);
  return options;
}

function validateProductionEnvironment(environment = process.env) {
  const configured = Object.keys(environment).find(key =>
    /(?:^|_)EMULATOR_HOST$/.test(key) && String(environment[key] || '')
  );
  if (configured) {
    throw new Error('Auth-provider evidence refuses emulator variable ' + configured + '.');
  }
}

function httpSuccess(response) {
  return Boolean(response) && response.statusCode >= 200 && response.statusCode < 300;
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function readEmailPasswordEnabled(response) {
  if (!httpSuccess(response)) {
    throw codedError(response && response.statusCode === 403
      ? 'auth-config-read-permission-denied' : 'auth-config-read-unavailable');
  }
  const body = response && response.body;
  const email = body && body.signIn && body.signIn.email;
  if (!body || body.name !== CONFIG_NAME || !email ||
      typeof email.enabled !== 'boolean') {
    throw codedError('auth-config-readback-malformed');
  }
  return email.enabled;
}

function timeoutMilliseconds(value) {
  return Number.isInteger(value) && value > 0 && value <= 120_000
    ? value : REQUEST_TIMEOUT_MS;
}

async function boundedGet(runtime, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    codedError('auth-config-read-timeout')
  ), timeoutMilliseconds(runtime.requestTimeoutMs));
  try {
    const response = await runtime.getJson({
      ...request, method: 'GET', signal: controller.signal
    });
    if (controller.signal.aborted) {
      throw controller.signal.reason || codedError('auth-config-read-timeout');
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function safeError(error, response) {
  return {
    code: typeof (error && error.code) === 'string' && error.code
      ? error.code : 'auth-config-read-failed',
    httpStatus: response && Number.isInteger(response.statusCode)
      ? response.statusCode : 0
  };
}

function productionDependencies() {
  return {
    environment: process.env,
    now: () => new Date().toISOString(),
    reserveReport,
    acquireAccessToken,
    getJson(request) { return requestJson(request); },
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

function writeLineSafely(runtime, line) {
  try { runtime.writeLine(line); } catch (_) { /* durable report is authoritative */ }
}

async function main(argv = process.argv.slice(2), dependencies) {
  const runtime = dependencies || productionDependencies();
  const options = parseArguments(argv);
  validateProductionEnvironment(runtime.environment || process.env);
  const identity = captureEvidenceIdentity(
    options,
    { tool: 'auth-email-password-off-evidence', schemaVersion: 2 },
    runtime.now
  );
  const base = authorEvidenceReport({
    operation: 'email-password-provider-readback', mode: 'get-only',
    status: 'reserved-fail-closed', configName: CONFIG_NAME,
    configReadHttpStatus: 0, emailPasswordEnabled: null,
    providerStateVerified: false, providerStillOff: false,
    writeCount: 0, error: { code: 'not-completed', httpStatus: 0 }
  }, identity);
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(base, null, 2) + '\n'
  );
  let response = null;
  let enabled = null;
  let stateVerified = false;
  try {
    const accessToken = await runtime.acquireAccessToken();
    response = await boundedGet(runtime, { url: CONFIG_URL, accessToken });
    enabled = readEmailPasswordEnabled(response);
    stateVerified = true;
    if (enabled) throw codedError('email-password-provider-enabled');
    const report = authorEvidenceReport({
      operation: 'email-password-provider-readback', mode: 'get-only',
      status: 'complete', configName: CONFIG_NAME,
      configReadHttpStatus: response.statusCode, emailPasswordEnabled: false,
      providerStateVerified: true, providerStillOff: true,
      writeCount: 0, error: null
    }, identity);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'Email/Password provider evidence status=complete off=true');
    return report;
  } catch (error) {
    const report = authorEvidenceReport({
      operation: 'email-password-provider-readback', mode: 'get-only',
      status: 'failed', configName: CONFIG_NAME,
      configReadHttpStatus: response && response.statusCode || 0,
      emailPasswordEnabled: enabled === true ? true : null,
      providerStateVerified: stateVerified,
      providerStillOff: false, writeCount: 0,
      error: safeError(error, response)
    }, identity);
    await reservation.commit(JSON.stringify(report, null, 2) + '\n');
    writeLineSafely(runtime, 'Email/Password provider evidence status=failed code=' +
      report.error.code);
    return report;
  }
}

if (require.main === module) {
  main().then(
    report => { process.exitCode = report.status === 'complete' ? 0 : 2; },
    error => {
      process.stderr.write('Auth-provider evidence failed before report publication: ' +
        String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  CONFIG_NAME,
  CONFIG_URL,
  PROJECT_ID,
  main,
  parseArguments,
  productionDependencies,
  readEmailPasswordEnabled,
  validateProductionEnvironment
};
