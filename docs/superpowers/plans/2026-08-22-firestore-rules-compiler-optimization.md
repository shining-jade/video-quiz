# Firestore Rules Compiler Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every current authorization and integrity invariant while reducing the final Firestore Rules source enough for Google’s production compiler to accept and deploy it.

**Architecture:** Permanently close migration-only compatibility paths whose production gates and audits are complete, then collapse duplicated public-library transition validators behind cheap dispatch guards. Add a deterministic source-budget test and a read-only production compiler probe so local Emulator success can never again be mistaken for deployability.

**Tech Stack:** Firebase Firestore Rules v2, Node.js 24, `node:test`, Firebase Rules Unit Testing, Firebase Admin ADC, Firebase Rules REST API.

**Spec:** `docs/superpowers/specs/2026-08-22-firestore-rules-compiler-optimization-design.md`

## Global Constraints

- Do not weaken any positive/negative authorization matrix currently asserted by `tests/firestore-rules.test.js`.
- Do not write production Firestore data from the compiler probe.
- Do not enable Email/Password Auth until the new production ruleset is active and read back exactly.
- Keep rollback ruleset `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4` recorded until final smoke passes.
- Final source must be at most 150,000 UTF-8 bytes, 3,000 lines, and 210 declared functions.
- Official `projects.test` success with zero ERROR issues is required in addition to local tests.

---

### Task 1: Source budget and production compiler probe

**Files:**
- Create: `rules-source-metrics.js`
- Create: `scripts/test-production-rules-source.js`
- Create: `tests/rules-source-budget.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `measureRulesSource(source: string): { bytes: number, lines: number, functions: number }`
- Produces: CLI `pnpm test:rules:production-source --project <id> --target-mode production --output <new.json>`
- The CLI reports only project ID, source SHA-256, metrics, issue counts, status, and `safeToCreateRuleset`; it never creates a ruleset or release.

- [ ] **Step 1: Write the failing source-budget test**

Add a test that reads `firestore.rules`, calls the wished-for `measureRulesSource`, and requires `bytes <= 150000`, `lines <= 3000`, and `functions <= 210`. Assert the current source fails at least the byte and line constraints before implementation work starts.

- [ ] **Step 2: Run the budget test and record RED**

Run:

```powershell
node --test tests/rules-source-budget.test.js
```

Expected: FAIL because `rules-source-metrics.js` is missing; after adding only the metric helper, FAIL with current metrics near 181KB/3,467/245.

- [ ] **Step 3: Add compiler-probe contract tests**

Test exact target validation, refusal of production with emulator environment variables, exclusive non-overwriting output, ADC token non-disclosure, REST payload `{source:{files:[{name:'firestore.rules',content}]}}`, ERROR issue fail-closed behavior, HTTP 5xx failure reporting, and success with `safeToCreateRuleset:true` only when all source budgets and API diagnostics pass.

- [ ] **Step 4: Implement the metric helper and read-only CLI**

Use `crypto.createHash('sha256')`, the existing durable report reservation helper, and dependency injection for token acquisition and HTTPS transport. POST only to `https://firebaserules.googleapis.com/v1/projects/{project}:test`; do not call `rulesets.create` or `releases.patch`.

- [ ] **Step 5: Run focused tests GREEN except the intentional current-size assertion**

Run the probe contract tests separately from the final source-budget threshold so probe behavior is GREEN while the real source remains RED.

- [ ] **Step 6: Commit Task 1**

```powershell
git add rules-source-metrics.js scripts/test-production-rules-source.js tests/rules-source-budget.test.js package.json
git commit -m "Firestore Rules 운영 컴파일 검사를 추가"
```

---

### Task 2: Permanently close completed migration compatibility paths

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`
- Test: `tests/rules-source-budget.test.js`

**Interfaces:**
- Consumes: completed authoritative `teacher_allowances/{uid}`, `migration_gates/session_counters`, `migration_gates/set_counters`, lifecycle counters, and share indexes.
- Produces: permanent strict teacher identity and session/counter behavior with no pre-completion client fallback.

- [ ] **Step 1: Write strict-gate RED tests**

Replace the rollout expectations that currently allow a Google-only legacy teacher before `teacher_access_status.complete` and allow no-counter legacy heartbeat/end before `session_counters.complete`. New tests must prove missing/malformed/incomplete gate documents fail closed, while authoritative UID teachers and counted sessions continue to work. Keep client writes to every migration gate denied.

- [ ] **Step 2: Run focused RED**

Run the teacher-access and session-counter named tests under the Firestore Emulator. Expected: the new permanent-strict assertions fail because `validLegacyTeacherAllowance`, `legacySessionCounterCompatibilityOpen`, `validLegacySessionEnd`, and `validLegacySessionTransition` still grant rollout compatibility.

- [ ] **Step 3: Remove teacher legacy fallback evaluation**

Make `isApprovedTeacher()` and `isAdmin()` require a valid authoritative `teacher_allowances/{request.auth.uid}` document. Retain exact legacy mirror validation only in the atomic admin approval/update transaction so canonical email uniqueness remains enforced. Remove the read-auth helpers `legacyAllowancePath()` and `validLegacyTeacherAllowance()` once no caller remains.

- [ ] **Step 4: Remove legacy session client transitions**

Delete `legacySessionCounterCompatibilityOpen`, `legacySessionWithoutCounters`, `validLegacySessionEnd`, `validLegacySessionTransition`, and their allow-branch alternatives. Retain strict counted session start/join/end, suspended/deletion-pending safe end for counted sessions, and Admin SDK migration/audit access which bypasses Rules.

- [ ] **Step 5: Remove completed set-counter and lifecycle promotion alternatives**

Keep exact nonnegative counters required on create/update/purge and keep `migration_gates/set_counters` client-denied. Remove only client branches that promote a missing legacy counter/lifecycle field; do not remove orphan prevention, image/collaborator mutation markers, or purge parent-last checks.

- [ ] **Step 6: Run focused and full Emulator GREEN**

Run:

```powershell
pnpm test:rules
```

Expected: every authoritative positive path passes, every legacy/malformed path fails, and no 1,000-expression regression appears.

- [ ] **Step 7: Measure reduction and commit Task 2**

Run `node --test tests/rules-source-budget.test.js`. It may remain RED on the final threshold, but metrics must be lower than the recorded baseline on all three dimensions.

```powershell
git add firestore.rules tests/firestore-rules.test.js tests/rules-source-budget.test.js
git commit -m "완료된 Rules 마이그레이션 호환 경로를 닫음"
```

---

### Task 3: Consolidate public-library transition validators

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`
- Test: `tests/rules-source-budget.test.js`

**Interfaces:**
- Consumes: flat public parent/video/question/image schema and existing exact counter/processed-marker protocol.
- Produces: status-dispatched parent transition checks and one shared child visibility/binding validator without changing stored documents.

- [ ] **Step 1: Add transition-equivalence RED coverage**

For each `building → published`, `published → withdrawn`, `moderated → published`, `building → cancelled`, copy build/finalize, child bind/replace/delete, lifecycle withdraw/restore, and purge path, pair one allowed exact transaction with denied variants for wrong status, revision, buildToken, schemaVersion, count, owner, allowance, source lifecycle, audit side document, and global lifecycle gate.

- [ ] **Step 2: Record focused RED for the intended dispatch interface**

Add static assertions that one parent update dispatcher selects a transition by pre/post status and changed keys, and that image/video/question get/list validators share one revision/schema/source-visibility helper. Expected: FAIL because the current duplicated helpers remain.

- [ ] **Step 3: Introduce cheap transition dispatch**

Refactor `validPublicParentUpdate(setId)` so it evaluates changed top-level keys and the before/after status pair first, then calls only the corresponding transition validator. Preserve exact `getAfter` checks for source, allowance, audit, lock, and gate where the transaction requires commit-state binding.

- [ ] **Step 4: Consolidate public child checks**

Create one helper for visible child read binding `(setId, data, expectedSchemaVersion)` and one helper for build-time child mutation binding `(setId, key, collectionName, countField)`. Keep type-specific video/question/image exact key and value schemas in small leaf validators.

- [ ] **Step 5: Collapse duplicated author/source checks**

Read source and authoritative allowance once per parent transition helper, then apply `validPublicAuthorLabel`, exact displayName, source revision, explicit active lifecycle, owner UID/email, and public content equality. Do not replace `getAfter` with `get` on create/finalize or lifecycle-coupled writes.

- [ ] **Step 6: Run focused Emulator after each refactor slice**

Run only the public-library named tests after each helper replacement. A newly allowed negative case or a normal transaction hitting 1,000 expressions requires reverting that slice before continuing.

- [ ] **Step 7: Reach and verify the source budget**

Run:

```powershell
node --test tests/rules-source-budget.test.js
pnpm test:rules
```

Expected: budget test GREEN at or below 150,000 bytes/3,000 lines/210 functions and Rules/Admin Emulator fully GREEN.

- [ ] **Step 8: Commit Task 3**

```powershell
git add firestore.rules tests/firestore-rules.test.js tests/rules-source-budget.test.js
git commit -m "공개 자료실 Rules 검증식을 경량화"
```

---

### Task 4: Release contract, full verification, and controlled deployment

**Files:**
- Modify: `docs/RELEASE-RUNBOOK.md`
- Modify: `tests/release-copy.test.js`
- Modify: `.release-artifacts/2026-08-22/release-manifest.json` (local restricted artifact; do not commit)

**Interfaces:**
- Consumes: compiler probe from Task 1 and optimized Rules from Tasks 2–3.
- Produces: immutable production ruleset name, exact release readback, updated restricted manifest, and a rollback-ready release.

- [ ] **Step 1: Write release-document RED tests**

Require the authoritative runbook to place `test:rules:production-source` after local tests and before `rulesets.create`; require stop conditions for budget/API issues and require the previous ruleset name through smoke completion.

- [ ] **Step 2: Update the runbook and make docs GREEN**

Document the exact command, durable output, zero-ERROR requirement, immutable ruleset creation, exact release readback, provider activation order, and rollback.

- [ ] **Step 3: Run fresh local verification**

Run:

```powershell
pnpm test
pnpm test:rules
node --check rules-source-metrics.js
node --check scripts/test-production-rules-source.js
git diff --check
```

Expected: zero failures and no skipped test beyond explicitly Emulator-only tests in the Node suite.

- [ ] **Step 4: Run the read-only production compiler probe**

Run with exact project `video-quiz-65798`, target mode `production`, and a new non-overwriting restricted output. Require source budgets satisfied, HTTP success, zero ERROR issues, and `safeToCreateRuleset:true`.

- [ ] **Step 5: Re-run production audits before mutation**

Run lifecycle apply with zero writes, collaborator-share dry-run, locked/strict counter status and audits, access/session completion verification as applicable, and public-library audit. Stop on any finding, partial scan, generation mismatch, or unexpected write.

- [ ] **Step 6: Create and activate the immutable ruleset**

Use the official Rules API with the exact probed source hash. Connect `projects/video-quiz-65798/releases/cloud.firestore` only after `rulesets.create` succeeds. GET the release and require its `rulesetName` to equal the newly created immutable ruleset.

- [ ] **Step 7: Run smoke and activate Email/Password**

Verify existing Google admin, Google teacher, and anonymous student flows first. Then have the owner enable Email/Password in Firebase Console and test signup, Korean verification email, verified teacher request, admin approval, login, password reset, and public-library copy without exposing private source data.

- [ ] **Step 8: Finalize or roll back**

On success, update the restricted manifest with hashes, test totals, ruleset name, readback time, and smoke results. On failure, disable Email/Password and PATCH the release back to `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`.

- [ ] **Step 9: Commit release documentation**

```powershell
git add docs/RELEASE-RUNBOOK.md tests/release-copy.test.js
git commit -m "Rules 운영 컴파일 배포 게이트를 문서화"
```

## Plan Self-Review

- Spec coverage: source budget, migration strictness, validator consolidation, privacy, official compile, deployment, rollback are assigned to Tasks 1–4.
- Placeholder scan: no deferred implementation steps or unspecified validation remain.
- Interface consistency: the budget helper and compiler CLI names are identical in Tasks 1 and 4; the same limits are used throughout.
