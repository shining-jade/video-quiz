# Session End Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve explicit cancellation/confirmation while making termination status, failures, and retries observable and testable through the app UI.

**Architecture:** Keep the existing store termination transaction unchanged. Add a DOM dialog controller to `index.html`, reusing existing dialog patterns; keep `plEndSession` as the single termination executor after confirmation.

**Tech Stack:** Existing vanilla HTML/JavaScript, native HTML dialog, Node test runner, existing Firebase emulator.

**Spec:** `docs/superpowers/specs/2026-10-27-session-end-confirmation-design.md` (approved by user at 2026-10-27 22:59 UTC).

## Global Constraints

- Keep cancellation and explicit termination confirmation; do not use browser `confirm` for this flow.
- Preserve termination transactions, ending/ended guards, responses and grades.
- No authentication, security rules, or dependency changes.
- Use only synthetic TEST sessions for production QA; never delete their records.

## Review Focus

- Escape/cancel and route teardown resolve pending confirmation without writes.
- Repeated clicks create one confirmation and one termination flight.
- Store failure leaves visible error and permits a same-session retry.
- A committed session end with failed class-plan finalization remains terminal and retries only idempotent work.
- Ended live notifications and delayed image/timer callbacks cannot reopen a question.

### Task 1: Dialog and termination feedback

**Files:** Modify `index.html`; test `tests/firestore-store.test.js`.

**Interfaces:** `plConfirmSessionEnd(state): Promise<boolean>` displays one dialog; `plEndDialogAnswer(confirmed)` resolves it; `plRenderEndSessionDialog(state, busy, error)` renders feedback; existing `plEndSession()` executes the confirmed termination.

- [ ] Add failing tests for DOM confirmation instead of native confirm, cancel/Escape, duplicate calls, teardown, visible failure/retry, and post-commit finalization failure.
- [ ] Run focused tests and capture failures.
- [ ] Implement dialog lifecycle, accessible controls, busy/error states, existing termination executor integration, and inline caller rejection consumption.
- [ ] Run focused and complete unit tests; fix regressions.

### Task 2: Review, deployment, actual UI verification

**Files:** Same product files plus approved spec/plan; no rules changes.

- [ ] Run complete emulator regressions and an independent code review.
- [ ] Commit only approved changes, compare/fetch current remote, push the existing Pages branch, verify build and public hashes.
- [ ] Fast-forward the clean OneDrive project.
- [ ] In a fresh TEST, verify actual DOM cancel/confirm, distinct answer storage, UI end notification and retained records; report mixed UI/SDK accurately.
- [ ] Normal-end all created TEST sessions and preserve their records.
