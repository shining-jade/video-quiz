# R19 Orphan Ruleset Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely adopt the already-created R19 Firestore Ruleset without another non-idempotent create, using a completely fresh R2–R9 evidence window and exact rollback protection.

**Architecture:** Productionize the read-only failure/reconciliation utilities first, then add a dedicated `adopt-existing` release helper that cannot call `rulesets.create`. Re-enter quiescence with the recorded deny-all Ruleset, regenerate every migration/audit/manifest proof, and patch only `cloud.firestore` after exact target source readback.

**Tech Stack:** Node.js 24, `node:test`, Firebase Admin ADC, Firebase Rules REST API, Firestore migration/audit CLIs, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-23-r19-orphan-ruleset-adoption-design.md`

## Global Constraints

- Do not call `rulesets.create` for source SHA-256 `c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d`.
- Adopt only `projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1` after exact source readback.
- Keep rollback Ruleset `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4` until R15 completes.
- Re-enter write-quiescence with deny-all Ruleset `projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466` and hold it through the R14 existing-flow gate.
- Never reuse R18/R19 migration, lock, generation, or manifest evidence as deployment authorization.
- Every operational report uses a new non-overwriting path under `.release-artifacts/2026-08-23/`.
- Never commit `.release-artifacts/` or `.release-maintenance/`, and never print tokens, email, UID, private source, or raw findings.
- Email/Password remains OFF until exact strict release readback, static deployment, same-generation post-audits/unlocks, and existing Google/anonymous smoke all pass.

---

### Task 1: Productionize Rules API failure and reconciliation evidence

**Files:**
- Create: `rules-api-failure.js`
- Create: `rules-ruleset-reconcile.js`
- Create: `scripts/diagnose-rules-api.js`
- Create: `tests/rules-api-failure.test.js`
- Create: `tests/rules-ruleset-reconcile.test.js`
- Modify: `scripts/test-production-rules-source.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `describeRulesApiFailure(response, error)` and `failureLine(failure)` with token redaction.
- Produces: `reconcileCreate(options): Promise<{writeLanded:true|false|null,...}>`.
- Produces: CLI `pnpm diagnose:rules-api --project <id> --target-mode production --expect-sha <sha> --output <new.json>` using GET only.

- [ ] **Step 1: Run the existing new unit tests as characterization**

```powershell
node --test tests/rules-api-failure.test.js tests/rules-ruleset-reconcile.test.js
```

Expected: 20/20 pass on the inherited uncommitted implementation. If not, preserve the failure as RED and repair only the failing contract.

- [ ] **Step 2: Add diagnosis CLI contract tests**

Add `tests/rules-api-diagnosis.test.js` with injected `getJson`/token/report dependencies. Assert exact project validation, emulator refusal, exclusive output reservation, GET-only transport, 2,500 quota accounting, exact release readback, and `writeLanded` propagation. Include a transport spy that fails if any method other than GET is requested.

```js
assert.deepEqual(methods, ['GET', 'GET', 'GET']);
assert.equal(report.reconciliation.writeLanded, true);
assert.deepEqual(report.reconciliation.matchingRulesetNames, [EXPECTED_RULESET]);
```

- [ ] **Step 3: Run diagnosis RED**

```powershell
node --test tests/rules-api-diagnosis.test.js
```

Expected: FAIL until the diagnosis module exports/injects every required dependency and the package command exists.

- [ ] **Step 4: Complete the minimal reusable implementation**

Export `main`, `productionDependencies`, `readRelease`, `inventoryRulesets`, and `getJson`; add:

```json
"diagnose:rules-api": "node scripts/diagnose-rules-api.js"
```

Keep `writeLanded:null` for list failure, truncated pages, more than 25 candidates, or any unreadable candidate.

- [ ] **Step 5: Run focused and default tests**

```powershell
node --test tests/rules-api-failure.test.js tests/rules-ruleset-reconcile.test.js tests/rules-api-diagnosis.test.js tests/production-rules-source.test.js
pnpm test
git diff --check
```

- [ ] **Step 6: Commit Task 1**

```powershell
git add rules-api-failure.js rules-ruleset-reconcile.js scripts/diagnose-rules-api.js scripts/test-production-rules-source.js tests/rules-api-failure.test.js tests/rules-ruleset-reconcile.test.js tests/rules-api-diagnosis.test.js package.json
git commit -m "Rules API 응답 유실 진단을 보강"
```

---

### Task 2: Add an adopt-existing release helper

**Files:**
- Create: `scripts/adopt-existing-ruleset.js`
- Create: `tests/adopt-existing-ruleset.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces CLI:

```text
pnpm release:rules:adopt-existing --project video-quiz-65798 --target-mode production --manifest <path> --ruleset projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1 --expect-sha c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d --output <new.json>
```

- The helper may GET the manifest-bound Ruleset/release and PATCH only `projects/video-quiz-65798/releases/cloud.firestore`. It has no POST/create code path.

- [ ] **Step 1: Write adopt-existing RED tests**

Test exact CLI validation and these fail-closed cases: wrong project/mode, emulator set, reused output, manifest not `ready-for-ruleset-adoption`, wrong source SHA/ruleset/rollback/quiescence/generation, unreadable target, multi-file target, hash mismatch, active release changed since manifest, PATCH failure, readback mismatch, rollback PATCH/readback failure.

```js
assert.equal(calls.some(call => call.method === 'POST'), false);
assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
assert.equal(result.releaseReadbackRulesetName, EXPECTED_RULESET);
```

- [ ] **Step 2: Run RED**

```powershell
node --test tests/adopt-existing-ruleset.test.js
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement exact adoption and rollback**

The execution sequence must be:

```js
validateArgsAndEnvironment();
const manifest = readAndValidateSealedManifest();
const target = await getRulesetExact();
assertSha(target, expectedSha256);
const before = await getReleaseExact();
assertExpectedQuiescenceRelease(before, manifest.quiescence.rulesetName);
await patchRelease(expectedRulesetName);
const after = await getReleaseExact();
if (after.rulesetName !== expectedRulesetName) await rollbackAndReadback();
```

The source must not contain `rulesets.create`, `method: 'POST'`, or a fallback that chooses a matching candidate automatically.

- [ ] **Step 4: Run focused GREEN and static mutation-boundary checks**

```powershell
node --test tests/adopt-existing-ruleset.test.js
rg -n "rulesets\.create|method:\s*'POST'" scripts/adopt-existing-ruleset.js
```

Expected: tests pass and `rg` finds nothing.

- [ ] **Step 5: Commit Task 2**

```powershell
git add scripts/adopt-existing-ruleset.js tests/adopt-existing-ruleset.test.js package.json
git commit -m "기존 Ruleset 안전 채택 경로를 추가"
```

---

### Task 3: Update the authoritative release contract

**Files:**
- Modify: `docs/RELEASE-RUNBOOK.md`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes `diagnose:rules-api` and `release:rules:adopt-existing`.
- Produces one authoritative R0–R15 order with create and explicit adoption as mutually exclusive R10 branches.

- [ ] **Step 1: Write runbook RED tests**

Require the runbook to state:

```js
assert.match(r10, /create 응답이 non-2xx.*성공 여부를 증명하지 않는다/);
assert.match(r10, /writeLanded:\s*true[\s\S]*create 재시도 금지/);
assert.match(r10, /adopt-existing[\s\S]*exact Ruleset[\s\S]*exact SHA/);
assert.match(r10, /R1[\s\S]*R2부터 새 보고서/);
```

Also require the exact orphan Ruleset, expected SHA, rollback Ruleset, deny-all quiescence Ruleset, and no-create statement for this recovery.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/release-copy.test.js
```

- [ ] **Step 3: Update R0/R1/R9/R10 and rollback text**

Document three-valued reconciliation, non-idempotent response loss, explicit-human adoption, fresh-window invalidation, and the exact command from Task 2. Keep Rules-before-static and provider-last ordering unchanged.

- [ ] **Step 4: Run docs GREEN and commit**

```powershell
node --test tests/release-copy.test.js
git diff --check
git add docs/RELEASE-RUNBOOK.md tests/release-copy.test.js
git commit -m "응답 유실 Ruleset 채택 절차를 문서화"
```

---

### Task 4: Rebuild R0–R9 evidence in a fresh quiescence window

**Files:**
- Create locally only: `.release-artifacts/2026-08-23/r23-*.json`
- Create locally only: `.release-artifacts/2026-08-23/release-manifest-r23.json`

**Interfaces:**
- Consumes committed Tasks 1–3 and the existing immutable deny-all/rollback/target Rulesets.
- Produces sealed manifest status `ready-for-ruleset-adoption` with exact target Ruleset/SHA and fresh R2–R8 report hashes/generations.

- [ ] **Step 1: Run fresh R0 local verification**

```powershell
pnpm test
pnpm test:rules
node --check rules-source-metrics.js
node --check scripts/test-production-rules-source.js
node --check scripts/adopt-existing-ruleset.js
git diff --check
```

- [ ] **Step 2: Run new read-only compiler and orphan diagnosis reports**

Use `r23-production-rules-probe.json` and `r23-rules-api-diagnosis.json`. Require compiler `safeToCreateRuleset:true`, reconciliation `writeLanded:true`, and the exact single target Ruleset name.

- [ ] **Step 3: Enter R1 quiescence**

PATCH only `cloud.firestore` to the recorded deny-all Ruleset `9a4258c3-12ed-4ee6-82aa-f596645a4466`, then GET exact readback. Record start time/control ID/stopped writers in `r23-quiescence.json`. If readback differs, restore rollback Ruleset and stop.

- [ ] **Step 4: Execute R2–R8 serially with new reports and new random locks**

Generate lock IDs with `crypto.randomUUID()`; never copy R18 values. Run lifecycle dry/apply/dry, share dry/apply/dry, counter lock/apply/audit, teacher access dry/lock/apply, session dry/lock/apply, public audit, and index readiness. Require all exact safe flags and zero findings.

- [ ] **Step 5: Seal R9 manifest**

Include every new report SHA, exact gate generation/token, Git commit, Rules source SHA, quiescence Ruleset, rollback Ruleset, and:

```json
{
  "task4": {
    "status": "ready-for-ruleset-adoption",
    "adoptionMode": "existing-exact",
    "rulesetName": "projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1",
    "sourceSha256": "c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d"
  }
}
```

No repository commit is created for restricted evidence.

---

### Task 5: Adopt, verify, deploy, unlock, and perform controlled Auth smoke

**Files:**
- Modify locally only: `.release-artifacts/2026-08-23/release-manifest-r23.json`
- Create locally only: `.release-artifacts/2026-08-23/r24-*.json`

**Interfaces:**
- Consumes sealed R23 manifest.
- Produces exact active strict Rules readback, deployed static app commit, same-generation post-audits/unlocks, and controlled provider smoke evidence.

- [ ] **Step 1: Run adopt-existing R10 exactly once**

Invoke Task 2 CLI with the sealed manifest, exact target Ruleset, exact SHA, and new `r24-ruleset-adoption.json`. Require `status:complete`, `createAttempted:false`, exact release readback, and target source hash match.

- [ ] **Step 2: Deploy R11 static app**

Only after strict Rules exact readback, merge the reviewed branch, push the shared branch, and deploy the manifest-bound static commit. Verify GitHub Pages serves that commit.

- [ ] **Step 3: Run R12 same-generation audits and R13 exact unlocks**

Verify all three lock/generation identities, repeat lifecycle/share/counter/public audits with new reports, then unlock session/access/counter locks using their exact recorded tokens. Do not end quiescence yet.

- [ ] **Step 4: Perform R14 existing-flow smoke**

Verify Google admin, Google teacher, and anonymous student join/end against the new Rules/static app with console error 0. If interactive account actions cannot be automated, stop with `NEEDS_CONTEXT` while quiescence and provider OFF remain.

- [ ] **Step 5: Enable Email/Password and perform R15 controlled smoke**

After owner activation, test signup, Korean verification email receive/click, verified teacher request, admin approval, login, password reset, and public-library copy/privacy. On any failure, disable provider and restore the rollback Ruleset before ending quiescence.

- [ ] **Step 6: Close the change window**

Record final smoke evidence and manifest hashes, end deny-all quiescence only after R15 succeeds, and retain rollback history plus the orphan Ruleset investigation artifacts.

## Plan Self-Review

- Spec coverage: response-loss diagnostics, three-valued reconciliation, exact adoption, fresh R2–R9 evidence, no-create boundary, rollback, and provider-last smoke are assigned to Tasks 1–5.
- Placeholder scan: runtime-generated UUIDs and report names are generated by explicit code/sequence; no implementation placeholder remains.
- Interface consistency: expected SHA, target Ruleset, rollback Ruleset, and deny-all Ruleset are identical in every task.
- Dirty-worktree protection: inherited diagnostic files are reviewed and committed in Task 1; restricted directories remain uncommitted throughout.
