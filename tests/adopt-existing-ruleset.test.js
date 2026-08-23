const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adopt = require('../scripts/adopt-existing-ruleset.js');

const PROJECT = 'video-quiz-65798';
const RELEASE = 'projects/video-quiz-65798/releases/cloud.firestore';
const TARGET = 'projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1';
const SHA = 'c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d';
const ROLLBACK = 'projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4';
const QUIESCENCE = 'projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466';
const SOURCE_COMMIT = '8a5a888da98c304ba7b103fb5221c41ac2dc412e';
const STATIC_COMMIT = 'c4f3136de2b140de7a98d415dc65ee68c086732f';
const SOURCE = fs.readFileSync(path.resolve('firestore.rules'), 'utf8');

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validManifest() {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    targetMode: 'production',
    quiescence: {
      mechanism: 'deny-all Firestore Rules',
      rulesetName: QUIESCENCE,
      verifiedAnonymousStatus: 403,
      cloudFunctionsApiDisabled: true
    },
    rollback: {
      rulesetName: ROLLBACK,
      staticCommit: '62e4e4681025e325380c19026821baceb06a2c64'
    },
    release: {
      staticCommit: STATIC_COMMIT,
      firestoreRulesSha256: SHA
    },
    locks: {
      setCounters: {
        lockId: 'e3d1cef7-6c98-46c1-8ec5-b00dba3098b0',
        updateTimeGeneration: '1787384912:204091000'
      },
      teacherAccess: {
        lockToken: 'd0c5fdb9-7dc9-4912-91e9-546e2ea940be',
        updateTimeGeneration: '1787384983:34189000',
        migrationGeneration: '1787266206:604244000'
      },
      sessionCounters: {
        lockToken: 'f421fdfe-647c-4039-815f-a6745052d20e',
        updateTimeGeneration: '1787385018:993634000',
        gateGeneration: '1787266359:259328000'
      }
    },
    task4: {
      status: 'ready-for-ruleset-adoption',
      adoptionMode: 'existing-exact',
      rulesetName: TARGET,
      headCommit: SOURCE_COMMIT,
      sourceSha256: SHA
    }
  };
}

function currentCommitState() {
  return { sourceCommit: SOURCE_COMMIT, staticCommit: STATIC_COMMIT };
}

function currentGateState() {
  return {
    setCounters: {
      path: 'migration_gates/set_counters', exists: true, locked: true,
      projectId: PROJECT, targetMode: 'production',
      lockId: 'e3d1cef7-6c98-46c1-8ec5-b00dba3098b0',
      updateTimeGeneration: '1787384912:204091000'
    },
    teacherAccess: {
      path: 'migration_gates/teacher_access_status', exists: true, locked: true,
      projectId: PROJECT, targetMode: 'production', status: 'complete', strictReady: true,
      lockToken: 'd0c5fdb9-7dc9-4912-91e9-546e2ea940be',
      updateTimeGeneration: '1787384983:34189000',
      migrationGeneration: '1787266206:604244000'
    },
    sessionCountersLock: {
      path: 'migration_gates/session_counter_migration', exists: true, locked: true,
      projectId: PROJECT, targetMode: 'production',
      lockToken: 'f421fdfe-647c-4039-815f-a6745052d20e',
      updateTimeGeneration: '1787385018:993634000'
    },
    sessionCountersGate: {
      path: 'migration_gates/session_counters', exists: true, complete: true,
      projectId: PROJECT, targetMode: 'production', rulesVersion: 'session-counters-v1',
      preflightNonEndedLegacyCount: 0,
      updateTimeGeneration: '1787266359:259328000'
    }
  };
}

function targetResponse(overrides = {}) {
  return {
    statusCode: 200,
    body: {
      name: TARGET,
      source: { files: [{ name: 'firestore.rules', content: SOURCE }] },
      ...overrides
    }
  };
}

function releaseResponse(rulesetName, statusCode = 200) {
  return {
    statusCode,
    body: statusCode >= 200 && statusCode < 300
      ? { name: RELEASE, rulesetName, updateTime: '2026-08-23T06:00:00Z' }
      : { error: { code: statusCode, status: 'UNAVAILABLE', message: 'secret upstream detail' } }
  };
}

function argumentsFor(manifestPath, outputPath, overrides = {}) {
  return [
    '--project', overrides.projectId || PROJECT,
    '--target-mode', overrides.targetMode || 'production',
    '--manifest', manifestPath,
    '--ruleset', overrides.rulesetName || TARGET,
    '--expect-sha', overrides.expectSha256 || SHA,
    '--expect-manifest-sha', overrides.expectManifestSha || 'a'.repeat(64),
    '--output', outputPath
  ];
}

async function invoke(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-existing-ruleset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  const outputPath = path.join(directory, 'report.json');
  fs.writeFileSync(manifestPath, JSON.stringify(options.manifest || validManifest()), 'utf8');

  const calls = [];
  const reports = [];
  let tokenCalls = 0;
  const releases = [...(options.releaseResponses || [
    releaseResponse(QUIESCENCE), releaseResponse(TARGET)
  ])];
  const patches = [...(options.patchResponses || [{
    statusCode: 200, body: { name: RELEASE, rulesetName: TARGET }
  }])];
  let patchCallCount = 0;
  const runtime = {
    environment: options.environment || {},
    requestTimeoutMs: options.requestTimeoutMs || 20,
    reserveReport(output, initialContents) {
      calls.push({ operation: 'reserve', output, initial: JSON.parse(initialContents) });
      if (options.reusedOutput) throw new Error('Report output already exists.');
      return {
        commit(contents) { reports.push(JSON.parse(contents)); },
        failClosedPath: output + '.reserved'
      };
    },
    async acquireAccessToken() {
      tokenCalls += 1;
      return 'test-token';
    },
    async readCurrentCommit() {
      calls.push({ operation: 'read-current-commit' });
      if (options.currentCommitError) throw options.currentCommitError;
      return options.currentCommit || currentCommitState();
    },
    async readCurrentGateState() {
      calls.push({ operation: 'read-current-gate-state' });
      if (options.currentGateError) throw options.currentGateError;
      return options.currentGateState || currentGateState();
    },
    async getJson(request) {
      calls.push({ ...request });
      if (request.url === adopt.API_ROOT + TARGET) {
        return options.target || targetResponse();
      }
      if (request.url === adopt.API_ROOT + RELEASE) {
        assert.ok(releases.length > 0, 'unexpected release GET');
        return releases.shift();
      }
      throw new Error('unexpected GET URL: ' + request.url);
    },
    async patchJson(request) {
      calls.push({ ...request });
      patchCallCount += 1;
      if ((options.neverSettlePatchNumbers || []).includes(patchCallCount)) {
        return new Promise(() => {});
      }
      assert.ok(patches.length > 0, 'unexpected release PATCH');
      return patches.shift();
    },
    writeLine(line) {
      calls.push({ operation: 'write-line', line });
      if (options.writeLineError) throw options.writeLineError;
    }
  };

  const cliOverrides = {
    ...(options.arguments || {}),
    expectManifestSha: options.arguments && options.arguments.expectManifestSha ||
      sha256(fs.readFileSync(manifestPath))
  };
  const result = await adopt.main(argumentsFor(manifestPath, outputPath, cliOverrides), runtime);
  return { calls, outputPath, reports, result, tokenCalls };
}

test('CLI refuses every project or mode except the fixed production target', async () => {
  const runtime = {
    environment: {},
    reserveReport() { throw new Error('must not reserve'); }
  };
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { projectId: 'other-project' }), runtime),
    /project/i
  );
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { targetMode: 'emulator' }), runtime),
    /production/i
  );
});

test('CLI requires the fixed explicit target Ruleset and source SHA', async () => {
  const runtime = {
    environment: {},
    reserveReport() { throw new Error('must not reserve'); }
  };
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { rulesetName: ROLLBACK }), runtime),
    /ruleset/i
  );
  await assert.rejects(
    adopt.main(argumentsFor('manifest.json', 'out.json', { expectSha256: '0'.repeat(64) }), runtime),
    /sha/i
  );
});

test('CLI requires a trusted raw manifest SHA before parsing evidence', async t => {
  const missingManifestSha = argumentsFor('manifest.json', 'out.json');
  missingManifestSha.splice(missingManifestSha.indexOf('--expect-manifest-sha'), 2);
  assert.throws(
    () => adopt.parseArguments(missingManifestSha),
    /manifest.*sha/i
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-manifest-sha-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  const rawManifest = JSON.stringify(validManifest());
  fs.writeFileSync(manifestPath, rawManifest, 'utf8');
  let tokenCalls = 0;
  const args = argumentsFor(manifestPath, path.join(directory, 'report.json'), {
    expectManifestSha: '0'.repeat(64)
  });
  const result = await adopt.main(args, {
    environment: {},
    reserveReport() { return { commit() {} }; },
    async acquireAccessToken() { tokenCalls += 1; },
    writeLine() {}
  });
  assert.equal(result.status, 'failed');
  assert.equal(tokenCalls, 0);
  assert.notEqual(sha256(rawManifest), '0'.repeat(64));
});

test('trusted raw manifest SHA binds an intentionally distinct static commit', async t => {
  const manifest = validManifest();
  manifest.release.staticCommit = '1'.repeat(40);
  const execution = await invoke(t, {
    manifest,
    arguments: { expectManifestSha: sha256(JSON.stringify(validManifest())) }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.tokenCalls, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('production adoption refuses any configured emulator before reserving output', async () => {
  let reserved = false;
  await assert.rejects(adopt.main(
    argumentsFor('manifest.json', 'out.json'),
    {
      environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
      reserveReport() { reserved = true; }
    }
  ), /emulator/i);
  assert.equal(reserved, false);
});

test('an already-used output fails before credentials or Rules API access', async () => {
  let tokenCalls = 0;
  let networkCalls = 0;
  await assert.rejects(adopt.main(
    argumentsFor('manifest.json', 'already-used.json'),
    {
      environment: {},
      reserveReport() { throw new Error('Report output already exists.'); },
      async acquireAccessToken() { tokenCalls += 1; },
      async getJson() { networkCalls += 1; },
      async patchJson() { networkCalls += 1; }
    }
  ), /already exists/i);
  assert.equal(tokenCalls, 0);
  assert.equal(networkCalls, 0);
});

test('the sealed manifest must use every exact adoption identity field', async t => {
  const cases = [
    ['project', manifest => { manifest.projectId = 'other-project'; }],
    ['production mode', manifest => { manifest.targetMode = 'staging'; }],
    ['state', manifest => { manifest.task4.status = 'ready-for-ruleset-create'; }],
    ['adoption mode', manifest => { manifest.task4.adoptionMode = 'automatic'; }],
    ['target ruleset name', manifest => { manifest.task4.rulesetName = ROLLBACK; }],
    ['task source SHA', manifest => { manifest.task4.sourceSha256 = '0'.repeat(64); }],
    ['release source SHA', manifest => { manifest.release.firestoreRulesSha256 = '0'.repeat(64); }],
    ['source commit', manifest => { manifest.task4.headCommit = ''; }],
    ['static release commit', manifest => { manifest.release.staticCommit = 'not-a-commit'; }],
    ['rollback ruleset', manifest => { manifest.rollback.rulesetName = TARGET; }],
    ['rollback static commit', manifest => { manifest.rollback.staticCommit = ''; }],
    ['quiescence mechanism', manifest => { manifest.quiescence.mechanism = 'operator promise'; }],
    ['quiescence ruleset', manifest => { manifest.quiescence.rulesetName = ROLLBACK; }],
    ['quiescence anonymous readback', manifest => { manifest.quiescence.verifiedAnonymousStatus = 200; }],
    ['quiescence trusted-writer gate', manifest => { manifest.quiescence.cloudFunctionsApiDisabled = false; }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = clone(validManifest());
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('all manifest-bound lock identities and current generations are mandatory', async t => {
  const cases = [
    ['set counter lock ID', manifest => { manifest.locks.setCounters.lockId = ''; }],
    ['set counter generation', manifest => { manifest.locks.setCounters.updateTimeGeneration = ''; }],
    ['access lock token', manifest => { manifest.locks.teacherAccess.lockToken = ''; }],
    ['access lock generation', manifest => { manifest.locks.teacherAccess.updateTimeGeneration = 'stale'; }],
    ['access migration generation', manifest => { manifest.locks.teacherAccess.migrationGeneration = null; }],
    ['session lock token', manifest => { manifest.locks.sessionCounters.lockToken = ''; }],
    ['session lock generation', manifest => { manifest.locks.sessionCounters.updateTimeGeneration = 'stale'; }],
    ['session gate generation', manifest => { manifest.locks.sessionCounters.gateGeneration = ''; }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = clone(validManifest());
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('live repository identity rejects valid but stale source and hosted-static commits', async t => {
  const cases = [
    ['source HEAD', manifest => { manifest.task4.headCommit = '1'.repeat(40); }],
    ['hosted static revision', manifest => { manifest.release.staticCommit = '2'.repeat(40); }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = validManifest();
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.result.phase, 'local-commit-readback');
      assert.equal(execution.tokenCalls, 0);
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('current gate read failure stops before release mutation', async t => {
  const execution = await invoke(t, {
    currentGateError: Object.assign(new Error('read unavailable'), { code: 'ETIMEDOUT' })
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'current-gate-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
  assert.equal(execution.calls.some(call => call.url === adopt.API_ROOT + RELEASE), false);
});

test('every well-formed manifest lock token and generation must match current readback', async t => {
  const cases = [
    ['set counter lock ID', manifest => { manifest.locks.setCounters.lockId = '11111111-1111-4111-8111-111111111111'; }],
    ['set counter generation', manifest => { manifest.locks.setCounters.updateTimeGeneration = '1787384912:204091001'; }],
    ['teacher access token', manifest => { manifest.locks.teacherAccess.lockToken = '22222222-2222-4222-8222-222222222222'; }],
    ['teacher access update generation', manifest => { manifest.locks.teacherAccess.updateTimeGeneration = '1787384983:34189001'; }],
    ['teacher access migration generation', manifest => { manifest.locks.teacherAccess.migrationGeneration = '1787266206:604244001'; }],
    ['session counter token', manifest => { manifest.locks.sessionCounters.lockToken = '33333333-3333-4333-8333-333333333333'; }],
    ['session lock generation', manifest => { manifest.locks.sessionCounters.updateTimeGeneration = '1787385018:993634001'; }],
    ['session gate generation', manifest => { manifest.locks.sessionCounters.gateGeneration = '1787266359:259328001'; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const manifest = validManifest();
      mutate(manifest);
      const execution = await invoke(t, { manifest });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.result.phase, 'current-gate-readback');
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('current gate identity or locked/complete state mismatch stops before release mutation', async t => {
  const state = currentGateState();
  state.teacherAccess.locked = false;
  const execution = await invoke(t, { currentGateState: state });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'current-gate-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('an unreadable exact target records allowlisted failure evidence without patching', async t => {
  const execution = await invoke(t, {
    target: {
      statusCode: 403,
      body: {
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          message: 'credential and server internals must not escape'
        }
      }
    }
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.failure.apiStatus, 'PERMISSION_DENIED');
  assert.equal(execution.result.failure.apiMessage, '');
  assert.equal(JSON.stringify(execution.result).includes('credential and server internals'), false);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('the target must be the exact named Ruleset with exactly one firestore.rules file', async t => {
  const cases = [
    ['wrong immutable name', targetResponse({ name: ROLLBACK })],
    ['missing source', { statusCode: 200, body: { name: TARGET } }],
    ['wrong file name', targetResponse({
      source: { files: [{ name: 'other.rules', content: SOURCE }] }
    })],
    ['multiple files', targetResponse({
      source: { files: [
        { name: 'firestore.rules', content: SOURCE },
        { name: 'extra.rules', content: '' }
      ] }
    })]
  ];
  for (const [name, target] of cases) {
    await t.test(name, async t => {
      const execution = await invoke(t, { target });
      assert.equal(execution.result.status, 'failed');
      assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
    });
  }
});

test('a target source hash mismatch stops before reading or patching the release', async t => {
  const execution = await invoke(t, {
    target: targetResponse({
      source: { files: [{ name: 'firestore.rules', content: SOURCE + '\n// changed' }] }
    })
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.calls.filter(call => call.url === adopt.API_ROOT + RELEASE).length, 0);
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('immediate pre-PATCH release drift from deny-all quiescence performs no mutation', async t => {
  const execution = await invoke(t, {
    releaseResponses: [releaseResponse(ROLLBACK)]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.phase, 'immediate-pre-patch-readback');
  assert.equal(execution.calls.some(call => call.method === 'PATCH'), false);
});

test('a failed target PATCH immediately restores and exactly reads back rollback', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 503, body: { error: {
        code: 503, status: 'UNAVAILABLE', message: 'sensitive target patch failure'
      } } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  const patches = execution.calls.filter(call => call.method === 'PATCH');
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.targetRulesetReadbackExact, true);
  assert.equal(execution.result.currentCommitExact, true);
  assert.equal(execution.result.currentGateStateExact, true);
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.result.failure.apiStatus, 'UNAVAILABLE');
  assert.equal(JSON.stringify(execution.result).includes('sensitive target patch failure'), false);
  assert.equal(patches.length, 2);
  assert.equal(patches[1].payload.release.rulesetName, ROLLBACK);
});

test('a never-settling target PATCH times out and restores exact rollback readback', async t => {
  const attempted = invoke(t, {
    requestTimeoutMs: 10,
    neverSettlePatchNumbers: [1],
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  const execution = await Promise.race([
    attempted,
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);
  assert.notEqual(execution, 'test-deadline', 'target PATCH must have a bounded settlement');
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.failure.transportError, 'ETIMEDOUT');
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('a never-settling rollback PATCH times out and still performs rollback readback', async t => {
  const attempted = invoke(t, {
    requestTimeoutMs: 10,
    neverSettlePatchNumbers: [2],
    patchResponses: [
      { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  const execution = await Promise.race([
    attempted,
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 100))
  ]);
  assert.notEqual(execution, 'test-deadline', 'rollback PATCH must have a bounded settlement');
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.rollbackFailure.transportError, 'ETIMEDOUT');
  assert.equal(execution.result.rollbackReadbackExact, true);
});

test('a target readback mismatch restores and exactly reads back rollback', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [
      releaseResponse(QUIESCENCE),
      releaseResponse(QUIESCENCE),
      releaseResponse(ROLLBACK)
    ]
  });
  assert.equal(execution.result.status, 'failed-rolled-back');
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('rollback PATCH failure remains failed even if rollback appears in readback', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } },
      { statusCode: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }
    ],
    releaseResponses: [releaseResponse(QUIESCENCE), releaseResponse(ROLLBACK)]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.rollbackPatchHttpStatus, 503);
  assert.equal(execution.result.rollbackReadbackExact, true);
  assert.equal(execution.result.safeForExistingFlowSmoke, false);
});

test('rollback readback failure remains failed after a successful rollback PATCH', async t => {
  const execution = await invoke(t, {
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [
      releaseResponse(QUIESCENCE),
      releaseResponse(QUIESCENCE),
      releaseResponse(ROLLBACK, 503)
    ]
  });
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.rollbackPatchHttpStatus, 200);
  assert.equal(execution.result.rollbackReadbackHttpStatus, 503);
  assert.equal(execution.result.rollbackReadbackExact, false);
});

test('success GETs only exact resources and PATCHes only the release rulesetName once', async t => {
  const execution = await invoke(t);
  const networkCalls = execution.calls.filter(call => call.method);
  const patches = networkCalls.filter(call => call.method === 'PATCH');

  assert.equal(execution.result.status, 'complete');
  assert.equal(execution.result.createAttempted, false);
  assert.equal(execution.result.releaseReadbackRulesetName, TARGET);
  assert.equal(execution.result.releaseReadbackExact, true);
  assert.equal(execution.result.safeForExistingFlowSmoke, true);
  assert.equal(execution.reports.length, 1);
  assert.deepEqual(execution.reports[0], execution.result);
  assert.equal(networkCalls.some(call => call.method === 'POST'), false);
  assert.deepEqual(networkCalls.filter(call => call.method === 'GET').map(call => call.url), [
    adopt.API_ROOT + TARGET,
    adopt.API_ROOT + RELEASE,
    adopt.API_ROOT + RELEASE
  ]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].url, adopt.API_ROOT + RELEASE);
  assert.deepEqual(patches[0].payload, {
    release: { name: RELEASE, rulesetName: TARGET },
    updateMask: 'rulesetName'
  });
});

test('stdout failure after success cannot trigger rollback or contradict the durable report', async t => {
  const execution = await invoke(t, {
    writeLineError: new Error('stdout closed'),
    patchResponses: [
      { statusCode: 200, body: { name: RELEASE, rulesetName: TARGET } },
      { statusCode: 200, body: { name: RELEASE, rulesetName: ROLLBACK } }
    ],
    releaseResponses: [
      releaseResponse(QUIESCENCE), releaseResponse(TARGET), releaseResponse(ROLLBACK)
    ]
  });
  assert.equal(execution.result.status, 'complete');
  assert.equal(execution.reports.length, 1);
  assert.equal(execution.reports[0].status, 'complete');
  assert.equal(execution.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(execution.result.rollbackAttempted, false);
});
