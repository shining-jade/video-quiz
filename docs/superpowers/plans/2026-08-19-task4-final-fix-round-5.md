# Task 4 Final Fix Round 5 Implementation Plan

> 운영 주의(2026-08-22): 이 문서는 역사적 설계/구현 기록이다. 아래의 개별 rollout·deploy 순서는 폐기되었고, production 전체 순서는 오직 [`docs/RELEASE-RUNBOOK.md`](../../RELEASE-RUNBOOK.md)의 R0~R15를 따른다.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owner/admin purge executable under Rules and make strict-counter migration auditable only under an authoritative global maintenance lock.

**Architecture:** The final strict Rules also serve as the staged gate Rules: a protected `migration_gates/set_counters` document blocks all collaborator/image mutations while locked, avoiding any temporary reintroduction of legacy counter writes. The Admin migration verifies the exact gate identity and update generation before apply, during every transaction, and around the final audit; any mismatch publishes a cumulative fail-closed report.

**Tech Stack:** Static JavaScript, Firebase Admin/client SDK, Firestore Security Rules, Node.js test runner, Firebase Rules Emulator.

**Spec:** `docs/superpowers/plans/2026-08-19-collaborators-trash-retention.md`

## Global Constraints

- No production migration, Rules deployment, or gate mutation is run in this task.
- Existing sessions and reads remain available while the counter gate is locked.
- Only an approved Google admin can lock/unlock; identity fields are immutable while locked and stale unlocks fail.
- `safeToDeployStrictRules` is true only if the final audit is clean and the same server gate generation remains locked.

---

### Task 1: Purging child reads and emulator-backed store purge

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: `canPurgeSet(setId)`, `store.beginSetPurge`, `store.continueSetPurge`.
- Produces: owner-immediate and eligible-admin-expired child get/list access during purging.

- [ ] Add failing Rules/real-store tests for owner and expired admin with nonempty then empty purge, plus other-actor denial.
- [ ] Run the focused Emulator tests and confirm image/collaborator reads fail.
- [ ] Permit purging child `get/list` only through `canPurgeSet(setId)` and add modular `limit()` support to the compat test adapter.
- [ ] Re-run focused Emulator tests to green.

### Task 2: Protected counter-maintenance gate

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`
- Create: `firebase.counter-migration.json`

**Interfaces:**
- Produces: exact `migration_gates/set_counters` lock/unlock protocol and `counterMigrationUnlocked()` write guard.

- [ ] Add failing Emulator tests for admin-only lock, stale unlock denial, locked collaborator/image write denial, and unaffected reads/sessions.
- [ ] Run focused Emulator tests and confirm the unimplemented gate behavior fails.
- [ ] Implement the exact gate schema and guard every collaborator/image create/update/delete; retain the gate in final strict Rules.
- [ ] Add a staged Firebase config pointing to the same fail-closed strict Rules artifact and re-run focused tests.

### Task 3: Gate-bound migration and cumulative failures

**Files:**
- Modify: `counter-migration.js`
- Modify: `scripts/migrate-set-counters.js`
- Modify: `tests/counter-migration.test.js`

**Interfaces:**
- Consumes: `gateId`, `projectId`, `targetMode`, and Admin Firestore gate snapshots.
- Produces: report `gate` evidence and cumulative `plannedCount`, `appliedCount`, `concurrentlySkipped`, and `concurrentlySkippedCount` on every failure.

- [ ] Add failing tests for missing/unlocked/wrong-project/wrong-mode/wrong-id gates, unlock during apply/audit, and final-audit read failure.
- [ ] Confirm RED for missing gate enforcement and missing `partialReport` after final audit failure.
- [ ] Implement server gate snapshot/fingerprint verification before apply, in each transaction, and before/after audit; calculate `safeToDeployStrictRules` only under the unchanged locked generation.
- [ ] Add CLI `--gate-id`, forward target mode/identity, and durably publish cumulative partial reports.
- [ ] Re-run focused Node tests to green.

### Task 4: Testable operator sequence and full verification

**Files:**
- Create: `docs/COUNTER-MIGRATION.md`
- Modify: `tests/release-copy.test.js`
- Modify: `.superpowers/sdd/2026-08-19-collaborators-trash-retention/task-4-report.md` (ignored working report)

**Interfaces:**
- Produces: staged deploy → lock → migrate/audit → strict deploy → identity-matched unlock sequence.

- [ ] Add failing release-copy assertions for all five ordered steps and the no-production-run warning.
- [ ] Document exact production/emulator commands without executing them.
- [ ] Run full Node, full Rules/Admin Emulator, and `git diff --check`.
- [ ] Record Fix Round 5 evidence, commit only intended tracked files, and report the hash and counts.
