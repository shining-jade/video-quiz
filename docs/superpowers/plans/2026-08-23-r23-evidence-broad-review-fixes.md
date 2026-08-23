# R23 Evidence Broad-Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not dispatch subagents for this security-critical fix wave.

**Goal:** Close the final broad-review blockers so R23 evidence, R1 recovery, provider-OFF state, and branch commit binding are authoritative and fail closed.

**Architecture:** Keep each external authority behind an injected bounded transport. R1 becomes an explicit PATCH/reconcile/rollback state machine anchored to a source-verified deny Ruleset and captured immutable prior Ruleset. A separate Auth config GET-only producer is bound into the fresh evidence map and rechecked by adoption before any Rules mutation.

**Tech Stack:** Node.js CommonJS, `node:test`, Firebase Rules REST, Identity Toolkit Admin v2 REST, Git CLI, local Firebase emulator.

**Spec:** `docs/superpowers/specs/2026-08-23-r23-evidence-broad-review-fixes-design.md`

## Global Constraints

- Local implementation and injected tests only; make no live API call.
- Never create/discover a candidate Ruleset, mutate Firestore/Auth data/config, enable a provider, deploy, merge, or push.
- R1 may PATCH only the fixed `cloud.firestore` release to the pinned deny Ruleset or the exact captured pre-PATCH Ruleset for rollback.
- Identity Toolkit access is GET-only and 403/missing/malformed/enabled is fail-closed.
- Preserve ignored restricted evidence/report directories and never stage them.
- Use RED/GREEN TDD for every production behavior.

---

### Task 1: Repair whole-HEAD production commit readback

**Files:**
- Modify: `tests/adopt-existing-ruleset.test.js`
- Modify: `scripts/adopt-existing-ruleset.js`

**Interfaces:**
- Consumes: real worktree Git metadata.
- Produces: `readCurrentCommit(): {sourceCommit: string, staticCommit: string}` with both values equal to HEAD.

- [ ] **Step 1: Write the failing real-default regression**

```js
test('production default commit readback binds source and static to whole HEAD', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.deepEqual(adopt.productionDependencies().readCurrentCommit(), {
    sourceCommit: head, staticCommit: head
  });
});
```

- [ ] **Step 2: Run the named test and verify RED**

Run: `node --test --test-name-pattern "production default commit" tests/adopt-existing-ruleset.test.js`
Expected: `ReferenceError: STATIC_ASSET_PATHS is not defined`.

- [ ] **Step 3: Implement one-read HEAD binding**

Replace the removed allowlist lookup with one exact `git rev-parse HEAD`, validate the lowercase 40-character commit, and return it for both fields.

- [ ] **Step 4: Run the named test and full adoption file; verify GREEN**

Run: `node --test --test-name-pattern "production default commit" tests/adopt-existing-ruleset.test.js`
Run: `node --test tests/adopt-existing-ruleset.test.js`

### Task 2: Source-anchor and reconcile R1 PATCH outcomes

**Files:**
- Modify: `tests/quiescence-evidence.test.js`
- Modify: `scripts/start-r23-quiescence.js`
- Modify: `release-evidence-contract.js`
- Modify: `tests/adopt-existing-ruleset.test.js`

**Interfaces:**
- Produces constants `QUIESCENCE_RULESET_SOURCE_SHA256` and exact success fields `quiescenceRulesetSourceSha256`, `quiescenceRulesetSourceReadbackExact`, `priorReleaseRulesetName`, `priorReleaseUpdateTime`, `priorRulesetSourceSha256`, `releasePatchOutcome`, `mutationOutcomeUnknown`, reconciliation/final-state fields, and rollback fields.
- Successful `releasePatchOutcome` is only `response-success` or `landed-reconciled`.

- [ ] **Step 1: Add RED source-preflight tests**

Add injected cases proving wrong deny name/hash, unreadable deny source, malformed baseline release, and unreadable prior Ruleset all publish failed evidence and make zero PATCH calls.

- [ ] **Step 2: Run the source-preflight tests and verify RED**

Run: `node --test --test-name-pattern "deny source|prior immutable" tests/quiescence-evidence.test.js`
Expected: current R1 reaches PATCH without the required Ruleset GETs.

- [ ] **Step 3: Implement deny and prior immutable readbacks**

Require one readable source file and compute SHA-256. Pin the deny source to `cd5089e4e5116dbb994013dc5fd5e7e411ec348935b8d06d13acd00173cca15b`; capture the exact pre-PATCH release name/ruleset/updateTime and the prior immutable source hash.

- [ ] **Step 4: Add RED reconciliation table tests**

Cover these literal outcomes and side effects:

```js
[
  ['lost response landed', 'landed-reconciled', false, 0],
  ['settled unchanged baseline', 'definitely-not-landed', false, 0],
  ['transport indeterminate', 'mutation-outcome-unknown', true, 0],
  ['known mismatch rollback exact', 'mismatch-rolled-back', false, 1],
  ['known mismatch rollback failed', 'mismatch-rollback-failed', false, 1]
]
```

Assert final report state, `mutationOutcomeUnknown`, exact rollback target/payload, readback status, and absence of contradictory success.

- [ ] **Step 5: Run reconciliation tests and verify RED**

Run: `node --test --test-name-pattern "landed|not landed|indeterminate|mismatch rollback" tests/quiescence-evidence.test.js`

- [ ] **Step 6: Implement the R1 state machine**

Always reconcile after the one target PATCH. Accept exact target readback despite a lost/non-2xx response; classify only settled non-2xx plus exact unchanged baseline as definitely not landed; keep transport non-target outcomes unknown; rollback known settled mismatches only to the captured prior Ruleset and reconcile rollback by GET.

- [ ] **Step 7: Tighten the successful R1 evidence contract and fixtures**

Require the pinned source SHA/readback, exact authoritative final deny state, known mutation outcome, no rollback, and one of the two successful outcomes. Update valid adoption evidence and manifest quiescence source binding.

- [ ] **Step 8: Run all R1/adoption focused tests; verify GREEN**

Run: `node --test tests/quiescence-evidence.test.js tests/adopt-existing-ruleset.test.js`

### Task 3: Add fresh authoritative Auth provider-OFF evidence

**Files:**
- Create: `scripts/read-auth-provider-off.js`
- Create: `tests/auth-provider-off-evidence.test.js`
- Modify: `release-evidence-contract.js`
- Modify: `scripts/adopt-existing-ruleset.js`
- Modify: `tests/adopt-existing-ruleset.test.js`
- Modify: `package.json`

**Interfaces:**
- GET endpoint: `https://identitytoolkit.googleapis.com/admin/v2/projects/video-quiz-65798/config`.
- Report tool: `auth-email-password-off-evidence`, schema version 2.
- Evidence key: `r0AuthProviderOff`.
- Manifest gate: `authProvider` with exact config name, `emailPasswordEnabled: false`, `providerStillOff: true`, window/control IDs, and captured time.

- [ ] **Step 1: Write RED producer tests**

Test exact schema-v2 success and separate 403, enabled, missing `signIn.email.enabled`, malformed-name, timeout/transport failure cases. Assert every transport call is GET and failure reports never claim OFF.

- [ ] **Step 2: Run producer tests and verify RED**

Run: `node --test tests/auth-provider-off-evidence.test.js`
Expected: module-not-found.

- [ ] **Step 3: Implement the bounded GET-only CLI**

Reuse shared identity, ADC token, HTTP JSON, and durable reservation helpers. Author only bounded booleans/statuses; never persist the raw Identity Toolkit config.

- [ ] **Step 4: Run producer tests and verify GREEN**

Run: `node --test tests/auth-provider-off-evidence.test.js`

- [ ] **Step 5: Write RED evidence/manifest/adoption tests**

Add `r0AuthProviderOff` to fixture ordering and assert missing/manual/stale/enabled report or mismatched `authProvider` gate stops before credentials/PATCH. Add immediate adoption GET cases for 403, missing, malformed, enabled, and verified OFF; successful adoption must report `providerStateVerified: true` and `providerStillOff: true`.

- [ ] **Step 6: Run contract/adoption tests and verify RED**

Run: `node --test --test-name-pattern "provider|Auth" tests/adopt-existing-ruleset.test.js`

- [ ] **Step 7: Implement contract, manifest, and immediate re-read gates**

Validate 19 exact reports and the exact `authProvider` object. After local evidence/commit/hash/cleanliness/gate validation and token acquisition, GET Auth config before any Rules API operation; failure is pre-PATCH. Carry verified provider fields into success/failure reports without any Auth mutation.

- [ ] **Step 8: Run provider/adoption focused tests; verify GREEN**

Run: `node --test tests/auth-provider-off-evidence.test.js tests/adopt-existing-ruleset.test.js`

### Task 4: Update the authoritative runbook and release-copy contract

**Files:**
- Modify: `docs/RELEASE-RUNBOOK.md`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Documents package command `release:auth-provider-off:r23`, `firebaseauth.configs.get`, R1 source pin/outcomes, immediate adoption provider GET, and whole-HEAD commit binding.

- [ ] **Step 1: Add RED release-copy assertions for required commands and gates**

Assert R0 includes the new CLI before R1, R1 documents the pinned hash/reconciliation/rollback policy, and R10 requires immediate provider OFF re-read plus HEAD binding.

- [ ] **Step 2: Run release-copy test and verify RED**

Run: `node --test tests/release-copy.test.js`

- [ ] **Step 3: Update the runbook and package command documentation**

Keep the existing R0-R15 order and explicitly prohibit manual provider success JSON and speculative rollback on unknown R1 mutation state.

- [ ] **Step 4: Run release-copy and all evidence focused tests; verify GREEN**

Run: `node --test tests/release-copy.test.js tests/auth-provider-off-evidence.test.js tests/quiescence-evidence.test.js tests/adopt-existing-ruleset.test.js`

### Task 5: Final verification, report, and implementation commit

**Files:**
- Create ignored report: `.superpowers/sdd/2026-08-23-r19-orphan-ruleset-adoption/task-3b-broad-review-fix-report.md`
- Commit all scoped tracked implementation/test/runbook/plan files; never stage the ignored report.

- [ ] **Step 1: Run final focused tests**

Run the provider, R1, contract, adoption, producer, transport, and release-copy test files together and record totals.

- [ ] **Step 2: Run full verification**

Run: `pnpm test`
Run: `pnpm test:rules` against local `demo-video-quiz` only.

- [ ] **Step 3: Run syntax and static checks**

Run `node --check` over every changed/new JavaScript file, forbidden create/POST/candidate searches for adoption/R1, forbidden POST/PATCH for Auth/R8, and `git diff --check`.

- [ ] **Step 4: Self-review the final diff and write the ignored report**

Document RED/GREEN evidence, authoritative APIs, outcome truth table, tests, safety boundaries, commits, and the operational fact that real fresh reports remain absent.

- [ ] **Step 5: Stage only scoped tracked files, verify staged diff, and commit**

Commit message: `fix: close R23 evidence review blockers`.
