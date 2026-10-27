# Progress — docs/superpowers/plans/2026-10-27-session-record-protection.md

Base: 37d5dbcb37bb4c453b8ea6de2344adfa0c183680. Branch: codex/protect-session-records.

Baseline: 899 passed, 0 failed, 108 emulator tests skipped (1007 total), Node v24.22.1.

Root cause: recovery treats an expired live lease as permission to call abortSessionAllocation; rollback then deletes every session child collection without participation checks. An existing test explicitly expects deletion of a live session with students/results, encoding the unsafe behavior.

Ruling: preserve all live sessions, including empty expired ones — status live proves activation and excluding it closes the activation/join race — an abandoned empty live session may need normal termination rather than automatic deletion.

Pre-flight: Task 2 uses the same UI but must not imply the un-deployed local fix has been tested in production.

## Final local verification

- Store/UI regression tests were first run against the unsafe implementation: 22 failed. The expiry-only Firestore abort regressions also failed as expected in the local emulator before the fix.
- Latest full Node run: 1,037 tests, 926 passed, zero failed, 111 skipped. Skips are the emulator-gated tests in this invocation. Evidence: `../../../../session-protection-final-unit.log` in the task root.
- Separate Firestore emulator run: 488 tests, 488 passed, zero failed, zero skipped. It included firestore-rules, legacy-migration-admin-emulator, and public-library-audit-admin-emulator tests, against demo-video-quiz on localhost only. Evidence: `../../../../session-protection-final-emulator.log` in the task root.
- `git diff --check` passed. No production record was used for a destructive test.

## Implemented protection

- Any live/ended or previously activated session is preserved, even if its heartbeat expired and its counters are zero.
- Participant counts/revisions, former participant identity, students, answers, grades, individual scores, aggregate board scores, or question activity prevent rollback. Malformed counters and unknown metadata are treated conservatively.
- Every child collection must be read successfully from the server before changing state. Cached, pending, or failed reads hold cleanup. Other-tab activation and aggregate score changes are rechecked in the transaction.
- Only an empty unactivated allocating/aborted draft can be cleaned up. The final deletion of the parent, code, and inspected child documents is atomic; an oversized draft is retained instead of being split across deletion batches.
- Firestore abort and record-creation rules were narrowed without broadening authentication or access. Normal session termination still preserves results.
- The retry UI explains preservation and does not automatically schedule another destructive attempt for a protected result.

## Independent review and rulings

One independent read-only review found two important issues in the first implementation: an aggregate could arrive between preflight and deletion, and a later collection read failure could occur after the code had already been removed. Both received failing regression tests, then fixes and passing verification. Aggregate documents are now transaction reads, all collection reads precede mutation, and code removal occurs only with final atomic deletion. Rules reject nonempty result metadata for unstarted drafts.

Legacy tests that encoded expiry-only deletion were changed to require retention. The preserved-state copy was also corrected because an already-aborted draft cannot always use normal live-session termination. No second review or production deletion test was needed. Existing deliberate administrator deletion permissions were not expanded or exercised.

## Actual synthetic student QA: not executed

Supported Chrome and in-app browser capabilities were inspected. Chrome exposes viewport/management and the in-app browser visibility/viewport; neither exposes independent authentication profiles/contexts. Three student tabs in one context would share the anonymous Firebase UID and are not a valid three-student test. The student sign-in path can replace teacher authentication, so the existing teacher Chrome context was preserved.

An earlier native Windows action targeting window 463892 had been denied with: "Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy." That action was not retried or bypassed. The supported HTTPS browser route remained readable, but did not supply the missing independent contexts.

No new TEST session, student identity, or answer was created in production during this task, so there is no test session requiring termination or record deletion. Existing session CDK4ZK3H4ZJ9 (code T8WGHC) was not changed. Concurrent entry, actual student timers, duplicate submission, late entry, reconnection, back navigation, and end-to-end scoring remain unexecuted UI checks.

## Delivery boundary

The local branch is codex/protect-session-records, based on 37d5dbcb37bb4c453b8ea6de2344adfa0c183680. The original main checkout and quiz HTMZSSPT are unchanged. No push, merge, rules publication, or GitHub Pages deployment was performed. Source and rules must be published together after explicit deployment authorization before claiming production protection.
