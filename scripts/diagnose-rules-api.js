#!/usr/bin/env node
'use strict';

// Read-only diagnosis for the HTTP 503 that blocked `rulesets.create` at R19.
//
// It answers the one question the release report could not: was the create
// refused because the project is out of ruleset slots, or did the request die
// server-side? Only GET requests are sent. It never creates a ruleset, never
// patches the release, and never touches Firestore data or the auth provider.

const https = require('node:https');
const { describeRulesApiFailure, failureLine } = require('../rules-api-failure.js');
const { reconcileCreate } = require('../rules-ruleset-reconcile.js');
const { reserveReport } = require('./migrate-legacy-ownership.js');

const API_ROOT = 'https://firebaserules.googleapis.com/v1/';
const PROJECT_ID = 'video-quiz-65798';
const REQUEST_TIMEOUT_MS = 30_000;
// Documented Cloud Firestore limit: a project keeps at most 2500 rulesets.
const RULESET_LIMIT = 2500;
const PAGE_SIZE = 100;
const MAX_PAGES = 40;

function parseArguments(argv) {
  const options = { projectId: '', targetMode: '', outputPath: '', expectSha256: '' };
  const fields = new Map([
    ['--project', 'projectId'],
    ['--target-mode', 'targetMode'],
    ['--output', 'outputPath'],
    ['--expect-sha', 'expectSha256']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields.get(argument);
    if (!field || index + 1 >= argv.length || options[field]) {
      throw new Error('Unknown, duplicate, or incomplete diagnosis argument: ' + argument);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  if (options.projectId !== PROJECT_ID) {
    throw new Error('--project must name the fixed production project.');
  }
  if (options.targetMode !== 'production') {
    throw new Error('--target-mode production is required.');
  }
  if (!options.outputPath) throw new Error('--output is required.');
  if (options.expectSha256 && !/^[0-9a-f]{64}$/.test(options.expectSha256)) {
    throw new Error('--expect-sha must be an exact lowercase sha256 hex digest.');
  }
  return options;
}

function validateProductionEnvironment(environment = process.env) {
  const configuredEmulator = Object.keys(environment).find(key =>
    /(?:^|_)EMULATOR_HOST$/.test(key) && String(environment[key] || '')
  );
  if (configuredEmulator) {
    throw new Error('Production diagnosis refuses emulator environment variable ' +
      configuredEmulator + '.');
  }
}

function timeoutMilliseconds(value) {
  return Number.isInteger(value) && value > 0 && value <= 120_000
    ? value : REQUEST_TIMEOUT_MS;
}

function timeoutError() {
  const error = new Error('Rules API diagnosis GET timed out.');
  error.code = 'ETIMEDOUT';
  return error;
}

function boundedGetJson(runtime, request) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete(value);
    };
    const timer = setTimeout(() => {
      const error = timeoutError();
      controller.abort(error);
      settle(reject, error);
    }, timeoutMilliseconds(runtime.requestTimeoutMs));
    Promise.resolve().then(() => runtime.getJson({
      ...request, method: 'GET', signal: controller.signal
    })).then(
      response => settle(resolve, response),
      error => settle(reject, error)
    );
  });
}

function getJson({ url, accessToken, method, signal }) {
  if (method !== 'GET') {
    return Promise.reject(new Error('Rules API diagnosis supports GET requests only.'));
  }
  if (signal && signal.aborted) return Promise.reject(signal.reason || timeoutError());
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    let settled = false;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abortRequest);
      complete(value);
    };
    const request = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname + endpoint.search,
      method: 'GET',
      headers: { authorization: 'Bearer ' + accessToken }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => {
        if (!request.destroyed) request.destroy(error);
        settle(reject, error);
      });
      response.on('close', () => {
        if (!settled) settle(reject, Object.assign(
          new Error('Rules API diagnosis response closed before completion.'),
          { code: 'ECONNRESET' }
        ));
      });
      response.on('end', () => {
        const status = response.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          settle(resolve, { statusCode: status, body: text ? JSON.parse(text) : {} });
        } catch (error) {
          if (status < 200 || status >= 300) {
            settle(resolve, { statusCode: status, body: null, rawBody: text });
            return;
          }
          settle(reject, new Error('Rules API returned invalid JSON.', { cause: error }));
        }
      });
    });
    function abortRequest() {
      if (!settled) request.destroy(signal.reason || timeoutError());
    }
    request.on('error', error => settle(reject, error));
    if (signal) signal.addEventListener('abort', abortRequest, { once: true });
    request.end();
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

async function readRelease(runtime, projectId, accessToken) {
  const name = 'projects/' + projectId + '/releases/cloud.firestore';
  const response = await runtime.getJson({ url: API_ROOT + name, accessToken, method: 'GET' });
  if (!httpSuccess(response)) {
    return { readable: false, failure: describeRulesApiFailure(response, null) };
  }
  return {
    readable: true,
    releaseName: String(response.body.name || ''),
    activeRulesetName: String(response.body.rulesetName || ''),
    updateTime: String(response.body.updateTime || '')
  };
}

async function inventoryRulesets(runtime, projectId, accessToken) {
  const inventory = {
    counted: 0,
    pages: 0,
    truncated: false,
    oldestCreateTime: '',
    newestCreateTime: '',
    listReadable: true,
    failure: null
  };
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = API_ROOT + 'projects/' + projectId + '/rulesets?pageSize=' + PAGE_SIZE +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const response = await runtime.getJson({ url, accessToken, method: 'GET' });
    if (!httpSuccess(response)) {
      inventory.listReadable = false;
      inventory.failure = describeRulesApiFailure(response, null);
      return inventory;
    }
    inventory.pages += 1;
    const rulesets = Array.isArray(response.body.rulesets) ? response.body.rulesets : [];
    for (const ruleset of rulesets) {
      inventory.counted += 1;
      const createTime = ruleset && typeof ruleset.createTime === 'string'
        ? ruleset.createTime : '';
      if (!createTime) continue;
      if (!inventory.oldestCreateTime || createTime < inventory.oldestCreateTime) {
        inventory.oldestCreateTime = createTime;
      }
      if (!inventory.newestCreateTime || createTime > inventory.newestCreateTime) {
        inventory.newestCreateTime = createTime;
      }
    }
    pageToken = typeof response.body.nextPageToken === 'string' ? response.body.nextPageToken : '';
    if (!pageToken) return inventory;
  }
  inventory.truncated = true;
  return inventory;
}

function verdictFor(inventory) {
  if (!inventory.listReadable) return 'ruleset-quota-unknown-list-failed';
  if (inventory.truncated) return 'ruleset-quota-unknown-listing-truncated';
  if (inventory.counted >= RULESET_LIMIT) return 'ruleset-quota-exhausted';
  if (inventory.counted >= RULESET_LIMIT - 25) return 'ruleset-quota-near-limit';
  return 'ruleset-quota-has-headroom';
}

function exactReconciliation(reconciliation) {
  return Boolean(reconciliation) && reconciliation.checked === true &&
    reconciliation.writeLanded === true && reconciliation.listReadable === true &&
    reconciliation.unreadableCount === 0 &&
    Array.isArray(reconciliation.matchingRulesetNames) &&
    reconciliation.matchingRulesetNames.length === 1;
}

function productionDependencies() {
  return {
    environment: process.env,
    reserveReport,
    acquireAccessToken,
    getJson,
    writeLine(line) { process.stdout.write(line + '\n'); }
  };
}

async function main(argv, dependencies) {
  const runtime = dependencies || productionDependencies();
  const options = parseArguments(argv);
  validateProductionEnvironment(runtime.environment || process.env);

  const placeholder = {
    tool: 'rules-api-503-diagnosis',
    schemaVersion: 1,
    projectId: options.projectId,
    targetMode: 'production',
    mutating: false,
    status: 'reserved-fail-closed',
    verdict: 'unknown'
  };
  const reservation = runtime.reserveReport(
    options.outputPath, JSON.stringify(placeholder, null, 2) + '\n'
  );

  let report;
  try {
    const accessToken = await runtime.acquireAccessToken();
    const boundedRuntime = {
      ...runtime,
      getJson(request) { return boundedGetJson(runtime, request); }
    };
    const release = await readRelease(boundedRuntime, options.projectId, accessToken);
    const inventory = await inventoryRulesets(boundedRuntime, options.projectId, accessToken);
    // With --expect-sha, answer the question a failed create leaves open:
    // is that exact source already persisted as a ruleset?
    const reconciliation = options.expectSha256
      ? await reconcileCreate({
        getJson: boundedRuntime.getJson,
        apiRoot: API_ROOT,
        projectId: options.projectId,
        accessToken,
        expectedSha256: options.expectSha256
      })
      : null;
    const readbackComplete = release.readable && inventory.listReadable && !inventory.truncated;
    const reconciliationComplete = !options.expectSha256 || exactReconciliation(reconciliation);
    report = {
      ...placeholder,
      expectSha256: options.expectSha256 || null,
      reconciliation,
      release,
      rulesetInventory: inventory,
      rulesetLimit: RULESET_LIMIT,
      remainingSlots: inventory.listReadable && !inventory.truncated
        ? Math.max(0, RULESET_LIMIT - inventory.counted) : null,
      status: !readbackComplete ? 'failed'
        : reconciliationComplete ? 'complete' : 'indeterminate',
      verdict: verdictFor(inventory)
    };
  } catch (error) {
    report = {
      ...placeholder,
      status: 'failed',
      verdict: 'unknown',
      failure: describeRulesApiFailure(null, error)
    };
  }

  reservation.commit(JSON.stringify(report, null, 2) + '\n');
  runtime.writeLine([
    'project=' + report.projectId,
    'status=' + report.status,
    'verdict=' + report.verdict,
    'rulesets=' + (report.rulesetInventory ? report.rulesetInventory.counted : 'n/a'),
    'remainingSlots=' + (report.remainingSlots == null ? 'n/a' : report.remainingSlots),
    'activeRuleset=' + ((report.release && report.release.activeRulesetName) || '-'),
    report.reconciliation
      ? 'writeLanded=' + String(report.reconciliation.writeLanded) +
        ' matches=' + (report.reconciliation.matchingRulesetNames.join(',') || '-')
      : '',
    report.failure ? failureLine(report.failure) : ''
  ].filter(Boolean).join(' '));
  return report;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    report => { process.exitCode = report.status === 'complete' ? 0 : 2; },
    error => {
      process.stderr.write('Rules API diagnosis failed: ' +
        String(error && error.message || error) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  API_ROOT, MAX_PAGES, PAGE_SIZE, PROJECT_ID, REQUEST_TIMEOUT_MS, RULESET_LIMIT,
  acquireAccessToken, boundedGetJson, exactReconciliation, getJson, inventoryRulesets, main, parseArguments,
  productionDependencies, readRelease, validateProductionEnvironment, verdictFor
};
