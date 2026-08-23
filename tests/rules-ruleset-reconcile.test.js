'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reconcile = require('../rules-ruleset-reconcile.js');

const API_ROOT = 'https://firebaserules.googleapis.com/v1/';
const PROJECT = 'video-quiz-65798';
const INTENDED = 'rules_version = \'2\';\n// intended release source\n';
const OTHER = 'rules_version = \'2\';\n// some other source\n';
const INTENDED_SHA = reconcile.sha256(INTENDED);

function rulesetName(id) {
  return 'projects/' + PROJECT + '/rulesets/' + id;
}

// Serves a fixed project state over the read-only GET shape the module uses.
function serve(rulesets, overrides = {}) {
  const sources = overrides.sources || {};
  const failures = overrides.failures || {};
  const calls = [];
  return {
    calls,
    getJson: async ({ url }) => {
      calls.push(url);
      if (failures[url]) return failures[url];
      if (url.includes('/rulesets?')) {
        if (overrides.listFailure) return overrides.listFailure;
        return { statusCode: 200, body: { rulesets } };
      }
      const name = url.slice(API_ROOT.length);
      if (failures[name]) return failures[name];
      const content = sources[name];
      if (content === undefined) return { statusCode: 404, body: { error: { code: 404 } } };
      return {
        statusCode: 200,
        body: { name, source: { files: [{ name: 'firestore.rules', content }] } }
      };
    }
  };
}

test('a lost create response is reported as a landed write, not a retryable failure', async () => {
  const before = [
    { name: rulesetName('old-1'), createTime: '2026-08-20T22:55:12Z' },
    { name: rulesetName('old-2'), createTime: '2026-08-22T07:40:47Z' }
  ];
  const after = before.concat([
    { name: rulesetName('lost-ack'), createTime: '2026-08-22T23:39:12Z' }
  ]);
  const server = serve(after, {
    sources: {
      [rulesetName('old-1')]: OTHER,
      [rulesetName('old-2')]: OTHER,
      [rulesetName('lost-ack')]: INTENDED
    }
  });

  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: before.map(item => item.name),
    createdAfter: '2026-08-22T23:38:26Z'
  });

  assert.equal(result.writeLanded, true);
  assert.deepEqual(result.matchingRulesetNames, [rulesetName('lost-ack')]);
  assert.equal(result.candidateCount, 1);
  assert.match(result.note, /do not retry/);
});

test('the snapshot keeps the reconciliation from inspecting pre-existing rulesets', async () => {
  const before = [{ name: rulesetName('old-1'), createTime: '2026-08-20T22:55:12Z' }];
  const server = serve(before, { sources: { [rulesetName('old-1')]: INTENDED } });

  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: before.map(item => item.name),
    createdAfter: '2026-08-22T23:38:26Z'
  });

  // The matching source predates the attempt, so it is not evidence of a write.
  assert.equal(result.writeLanded, false);
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(result.matchingRulesetNames, []);
});

test('no matching persisted source does not authorize a create', async () => {
  const existing = [{ name: rulesetName('old-1'), createTime: '2026-08-20T22:55:12Z' }];
  const server = serve(existing, { sources: { [rulesetName('old-1')]: OTHER } });

  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: [],
    createdAfter: '2026-08-22T23:38:26Z'
  });

  assert.equal(result.writeLanded, false);
  assert.match(result.note, /does not authorize a create/);
  assert.equal(Object.hasOwn(result, 'safeToCreateRuleset'), false);
});

test('an unreadable listing leaves the outcome undetermined rather than empty', async () => {
  const server = serve([], {
    listFailure: { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }
  });

  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: [],
    createdAfter: '2026-08-22T23:38:26Z'
  });

  assert.equal(result.writeLanded, null);
  assert.equal(result.listReadable, false);
  assert.match(result.note, /undetermined/);
});

test('a pagination truncation leaves the outcome undetermined rather than negative', async () => {
  let calls = 0;
  const result = await reconcile.reconcileCreate({
    getJson: async ({ method }) => {
      assert.equal(method, 'GET');
      calls += 1;
      return { statusCode: 200, body: { rulesets: [], nextPageToken: 'more' } };
    },
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: []
  });

  assert.equal(result.writeLanded, null);
  assert.equal(result.listReadable, false);
  assert.equal(calls, reconcile.MAX_PAGES);
  assert.match(result.note, /undetermined/);
});

test('an unreadable candidate leaves the outcome undetermined rather than negative', async () => {
  const rulesets = [{ name: rulesetName('new-1'), createTime: '2026-08-22T23:39:12Z' }];
  const server = serve(rulesets, {
    failures: { [rulesetName('new-1')]: { statusCode: 500, body: { error: { code: 500 } } } }
  });

  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: [],
    createdAfter: '2026-08-22T23:38:26Z'
  });

  assert.equal(result.writeLanded, null);
  assert.equal(result.unreadableCount, 1);
  assert.match(result.note, /undetermined/);
});

test('reconciliation refuses to guess without an exact expected source hash', async () => {
  const server = serve([]);
  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: 'not-a-sha'
  });

  assert.equal(result.checked, false);
  assert.equal(result.writeLanded, null);
  assert.equal(server.calls.length, 0);
});

test('too many candidates leave the outcome undetermined instead of pulling every source', async () => {
  const many = [];
  for (let index = 0; index < reconcile.MAX_INSPECT + 1; index += 1) {
    many.push({ name: rulesetName('r' + index), createTime: '2026-08-22T23:39:12Z' });
  }
  const server = serve(many);

  const result = await reconcile.reconcileCreate({
    getJson: server.getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: []
  });

  assert.equal(result.writeLanded, null);
  assert.equal(result.inspectedCount, 0);
  assert.match(result.note, /too many candidate/);
});

test('the create-time fallback allows for clock difference and inspects newest first', () => {
  const lowerBound = reconcile.skewedLowerBound('2026-08-22T23:38:26.000Z');
  assert.equal(lowerBound, '2026-08-22T23:28:26.000Z');
  assert.equal(reconcile.skewedLowerBound('not a time'), '');

  const ordered = reconcile.selectCandidates([
    { name: rulesetName('a'), createTime: '2026-08-22T23:00:00Z' },
    { name: rulesetName('c'), createTime: '2026-08-22T23:39:12Z' },
    { name: rulesetName('b'), createTime: '2026-08-22T23:30:00Z' }
  ], { createdAfter: '2026-08-22T23:38:26Z' });

  // The 23:00 entry falls outside even the skewed window.
  assert.deepEqual(ordered.map(item => item.name), [rulesetName('c'), rulesetName('b')]);
});

test('reconciliation only ever issues GET requests', async () => {
  const rulesets = [{ name: rulesetName('new-1'), createTime: '2026-08-22T23:39:12Z' }];
  const methods = [];
  const server = serve(rulesets, { sources: { [rulesetName('new-1')]: INTENDED } });
  const getJson = async options => {
    methods.push(options.method === undefined ? 'GET' : options.method);
    return server.getJson(options);
  };

  const result = await reconcile.reconcileCreate({
    getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: []
  });

  assert.equal(result.writeLanded, true);
  assert.equal(methods.every(method => method === 'GET'), true);
});

test('a ruleset carrying more than one source file never counts as a match', async () => {
  const rulesets = [{ name: rulesetName('multi'), createTime: '2026-08-22T23:39:12Z' }];
  const getJson = async ({ url }) => {
    if (url.includes('/rulesets?')) return { statusCode: 200, body: { rulesets } };
    return {
      statusCode: 200,
      body: {
        name: rulesetName('multi'),
        source: {
          files: [
            { name: 'firestore.rules', content: INTENDED },
            { name: 'extra.rules', content: OTHER }
          ]
        }
      }
    };
  };

  const result = await reconcile.reconcileCreate({
    getJson,
    apiRoot: API_ROOT,
    projectId: PROJECT,
    accessToken: 'token',
    expectedSha256: INTENDED_SHA,
    knownRulesetNames: []
  });

  assert.equal(result.writeLanded, false);
});
