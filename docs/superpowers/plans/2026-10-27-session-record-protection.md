# Session Record Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent allocation recovery from deleting classroom participation or results.

**Architecture:** Restrict rollback to unactivated, empty drafts and recheck status/counters in the transaction. Query protected child collections from the server before mutation and stop on uncertainty. Tighten the existing abort rule and retain normal session-ending behavior.

**Tech Stack:** Static JavaScript, Firestore compat API, Node test runner, Firebase emulator.

**Spec:** ../specs/2026-10-27-session-record-protection-design.md

## Global Constraints

- No production destructive tests, permission expansion, public push, or deployment.
- Preserve HTMZSSPT and its eleven questions/settings.
- Test identities use TEST labels only; normally end created test sessions and keep their records.

## Review Focus

- Heartbeat expires after genuine participation: preserve all records and code.
- Zero/malformed counters disagree with child records: child evidence and uncertainty prevent deletion.
- A different tab activates the draft between inspection and transaction: abort must fail closed.
- Server collection read fails or returns cache: no state/code mutation.
- Partial historical cleanup left an aborted parent with answers: stop further deletion.

### Task 1: Guard allocation recovery and describe protected sessions

**Files:** Modify firestore-store.js, index.html, firestore.rules, tests/firestore-store.test.js, tests/firestore-rules.test.js.

**Interfaces:** Keep abortSessionAllocation(sessionId, code, teacherUid, token): Promise<boolean>; extend recoverPendingSessionAllocation result with preserved: true for protected records. UI must report preservation without retrying deletion automatically.

- [x] Add failing store tests for expired live records, all protected collections/counters, cached/failed reads, and concurrent activation; run the targeted tests and observe assertion failures.
- [x] Restrict rollback, query protected evidence using server reads, revalidate transaction state, and retain endSession.
- [x] Add and verify emulator regressions denying expiry-only abort and unsafe aborted-session cleanup while allowing empty draft rollback.
- [x] Update retry UI to explain preserved records; verify protected recovery does not schedule destructive retries.
- [x] Run the full Node suite and emulator suite; capture exact failures or passing counts.
- [x] Review the entire diff independently and address important findings with RED→GREEN tests.
- [x] Commit the local branch without pushing or deploying.

### Task 2: Synthetic classroom QA

**Files:** Record evidence in a task-scoped QA report.

**Interfaces:** Existing teacher/student UI only, synthetic TEST identities, independent authentication contexts.

- [x] Inspect supported browser contexts without repeating or bypassing denied Windows access.
- [ ] If three independent student contexts can be established, create a separate TEST session, test submissions/timers/reconnection, then normally end it and retain its records.
- [x] Otherwise mark actual multi-student QA unexecuted with the exact constraint; never simulate three students through one shared anonymous UID.
- [x] Report local verification separately from production deployment and live QA.
