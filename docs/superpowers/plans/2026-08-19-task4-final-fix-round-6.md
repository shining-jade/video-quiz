# Task 4 Final Fix Round 6 Implementation Plan

> 운영 주의(2026-08-22): 이 문서는 역사적 설계/구현 기록이다. 아래의 개별 rollout·deploy 순서는 폐기되었고, production 전체 순서는 오직 [`docs/RELEASE-RUNBOOK.md`](../../RELEASE-RUNBOOK.md)의 R0~R15를 따른다.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a missing/malformed migration gate fail closed and make counter audit detect orphan collaborator/image children with missing parents.

**Architecture:** Rules require one exact persisted unlocked gate shape before any counter-dependent child mutation, trash-to-purge transition, or final parent delete; staged deploy therefore has an intentional read-only maintenance window until an admin creates the locked gate and later unlocks it. The Admin audit scans both parent-owned children and collection groups, records bounded orphan details, and declares safety only under the unchanged locked gate generation.

**Tech Stack:** Firestore Security Rules, Firebase Admin/client SDK, Node.js test runner, Firebase Emulator Suite.

**Spec:** `docs/superpowers/plans/2026-08-19-collaborators-trash-retention.md`

## Global Constraints

- No production migration, Rules deployment, or migration gate mutation is executed.
- Existing reads and sessions remain usable during missing/locked gate maintenance.
- Orphan details are bounded while total orphan counts remain exact.

---

### Task 1: Missing gate and final-delete fail closure

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Produces: `counterMigrationUnlocked()` true only for the exact stored unlocked schema.

- [ ] Add a failing Emulator test that deletes the seeded gate, rejects active image/collaborator writes, trash→purge, and a stale `imageCount: 0` parent delete while a real image child exists; verify admin can still create the locked gate.
- [ ] Run the focused test and confirm the missing gate currently permits a counter write or parent delete.
- [ ] Require an exact unlocked document shape and add `counterMigrationUnlocked()` to trash→purge and parent delete.
- [ ] Seed an exact unlocked gate for existing normal Rules tests and rerun the focused test to green.

### Task 2: Orphan child audit

**Files:**
- Modify: `counter-migration.js`
- Modify: `tests/counter-migration.test.js`

**Interfaces:**
- Produces audit fields `orphanChildCount`, `orphanCollaboratorCount`, `orphanImageCount`, `orphanChildDetails`, and `orphanChildDetailsTruncated`.

- [ ] Add a failing test with `quiz_sets/ghost/collaborators/x` and `images/ghost/q/v0q0` but no `quiz_sets/ghost`; assert safety false and exact counts/details.
- [ ] Run the focused test and confirm the parent-only audit incorrectly returns safety true.
- [ ] Add `collectionGroup('collaborators')` and `collectionGroup('q')` scans between unchanged-gate checks; derive only exact supported paths and cap details at 100.
- [ ] Include orphan counts in `auditCounterRecords` safety and rerun focused counter tests to green.

### Task 3: Staged fail-closed workflow and final verification

**Files:**
- Modify: `docs/COUNTER-MIGRATION.md`
- Modify: `tests/release-copy.test.js`
- Modify: `.superpowers/sdd/2026-08-19-collaborators-trash-retention/task-4-report.md` (ignored working report)

**Interfaces:**
- Produces: documented immediate-lock step and explicit fail-closed interval after staged deploy.

- [ ] Add failing release-copy assertions for “즉시 잠금” and the missing-gate write/delete block.
- [ ] Update the ordered workflow without suggesting any production command was executed.
- [ ] Run full Node, full Rules/Admin Emulator, and `git diff --check`.
- [ ] Record Fix Round 6, commit intended files, and report hash/counts while preserving the worktree.
