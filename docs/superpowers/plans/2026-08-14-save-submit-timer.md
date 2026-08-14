# Quiz Save, Submit, and Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local editor draft recovery and keyboard save, explicit/reversible student submission with deadline auto-submit, teacher participation counts, and synchronized animated timers.

**Architecture:** Keep Firestore as the source of truth for formally saved sets and submitted answers. Put editor draft serialization in a small standalone helper, represent each answer with an explicit `submitted` flag while treating legacy answers without the flag as submitted, and derive both teacher and student timers from the existing server-corrected deadline. The UI remains in `index.html`, while pure state calculations are exported through the existing test hook so they can be exercised in Node VM tests.

**Tech Stack:** Static HTML/CSS/JavaScript, Firebase Auth and Cloud Firestore compat SDK 10.12.0, Node built-in test runner, existing VM/fake Firestore harness.

## Global Constraints

- Firestore formal saves must remain visible on every computer; unsaved drafts stay only in the current browser.
- `Ctrl+S` and `Cmd+S` must prevent the browser page-save dialog and invoke the same formal save path as the save button.
- Selecting an answer must not submit it; the student must press `제출하기` or reach the deadline with a non-empty answer.
- `다시 고르기` is allowed only before reveal, close, or deadline and must immediately remove that answer from the teacher's submitted count.
- Empty choice/text state at the deadline remains unsubmitted.
- Teacher and student countdowns use `serverNow()`, `openedAt`, and `limitSec`; they must agree within one second.
- Before reveal, the teacher may see only participation counts, not correct answers or option distributions.
- Existing response documents without a `submitted` field are backward-compatible and count as submitted.
- Respect `prefers-reduced-motion`; do not add sound, vibration, user accounts, cross-device drafts, or non-submitter names.

---

## File Structure

- Create `editor-draft.js`: pure draft key, freshness, serialization, debounce, and recovery decision helpers.
- Modify `index.html`: load the helper; integrate editor save status and shortcuts; implement student response state machine; render teacher counts and synchronized timer bars.
- Modify `firestore-store.js`: preserve explicit answer submission state and expose one idempotent answer-state write path.
- Modify `tests/firestore-core.test.js`: unit tests for editor draft helpers.
- Modify `tests/firestore-store.test.js`: fake Firestore and VM integration tests for saves, answer state, counts, auto-submit, and timers.
- Modify `README.md`: document keyboard save, local recovery, explicit submission, and timer behavior.

### Task 1: Local editor draft helper

**Files:**
- Create: `editor-draft.js`
- Test: `tests/firestore-core.test.js`

**Interfaces:**
- Consumes: browser-like storage with `getItem`, `setItem`, and `removeItem`.
- Produces: `EditorDraft.key(setId)`, `EditorDraft.snapshot(model, now)`, `EditorDraft.read(storage, setId)`, `EditorDraft.write(storage, setId, model, now)`, `EditorDraft.clear(storage, setId)`, and `EditorDraft.isNewer(draft, savedAt)`.

- [ ] **Step 1: Write failing draft tests**

Append tests that load `editor-draft.js` in a VM and prove new/existing keys differ, transient UI fields are excluded, corrupt JSON returns `null`, and freshness uses the snapshot timestamp.

```js
test('편집 초안은 세트별로 분리하고 저장 시각으로 복구 여부를 정한다', () => {
  const storage = memoryStorage();
  EditorDraft.write(storage, 'set-a', { title: '수정', questions: [], saved: false }, 2000);
  assert.equal(EditorDraft.read(storage, 'set-a').model.title, '수정');
  assert.equal(EditorDraft.read(storage, 'set-a').model.saved, undefined);
  assert.equal(EditorDraft.read(storage, 'set-b'), null);
  assert.equal(EditorDraft.isNewer(EditorDraft.read(storage, 'set-a'), 1000), true);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="편집 초안" tests/firestore-core.test.js
```

Expected: FAIL because `editor-draft.js` or `EditorDraft` does not exist.

- [ ] **Step 3: Implement the pure helper**

Use an IIFE compatible with browser globals and CommonJS tests. Snapshot only `title`, `videoUrl`, `videoId`, `author`, `settings`, `questions`, `createdAt`, and `archived`; deep-clone the value.

```js
function key(setId) { return 'vq_draft_' + (setId || 'new'); }
function snapshot(model, now) {
  const clean = (({ title, videoUrl, videoId, author, settings, questions, createdAt, archived }) =>
    ({ title, videoUrl, videoId, author, settings, questions, createdAt, archived }))(model);
  return { savedAt: Number(now) || Date.now(), model: JSON.parse(JSON.stringify(clean)) };
}
```

- [ ] **Step 4: Run focused and full core tests**

Run:

```powershell
node --test tests/firestore-core.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add editor-draft.js tests/firestore-core.test.js
git commit -m "편집 중인 퀴즈를 로컬 초안으로 보존"
```

### Task 2: Editor shortcut, recovery, and save status

**Files:**
- Modify: `index.html:780-790,1250-1640`
- Test: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `EditorDraft` from Task 1 and existing `mkSave()`/`saveQuizSet()` flow.
- Produces: `mkMarkDirty()`, `mkPersistDraft()`, `mkClearDraft()`, `mkSetSaveStatus(state, detail)`, and one cleanup-scoped keydown listener.

- [ ] **Step 1: Write failing editor integration tests**

Add VM tests asserting that an input change schedules a local draft, `Ctrl+S` calls `preventDefault()` and `mkSave()` once, successful save clears the draft, failed save retains it, and a newer draft prompts for recovery.

```js
test('Ctrl+S는 브라우저 저장을 막고 기존 정식 저장 경로를 한 번 호출한다', async () => {
  const event = { key: 's', ctrlKey: true, metaKey: false, preventDefault() { this.prevented = true; } };
  await context.mkHandleSaveShortcut(event);
  assert.equal(event.prevented, true);
  assert.equal(saveCalls, 1);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="Ctrl.S|초안|저장 상태" tests/firestore-store.test.js
```

Expected: FAIL because shortcut/status integration functions do not exist.

- [ ] **Step 3: Load the helper and render save status**

Load `editor-draft.js` before the application script. Add `#mk-save-status` beside the save controls and render only these states:

```js
const labels = { dirty: '저장하지 않은 변경', saving: '저장 중…', saved: '저장됨', failed: '저장 실패 · 다시 시도' };
```

Every editor mutation calls `mkMarkDirty()`, which updates the state immediately and debounces `EditorDraft.write(localStorage, mk.id, mk, Date.now())`.

- [ ] **Step 4: Integrate shortcut, recovery, and formal-save lifecycle**

Register the shortcut only while the make screen is active and remove it through `onCleanup`. On entry, compare draft time with the Firestore set's `updatedAt`/`createdAt`; use one confirmation dialog to restore or discard. Await the existing save promise, clear the correct draft key only on success, and preserve it on failure.

- [ ] **Step 5: Run editor tests and the full suite**

Run:

```powershell
node --test tests/*.test.js
```

Expected: all tests PASS and `git diff --check` is silent.

- [ ] **Step 6: Commit**

```powershell
git add index.html tests/firestore-store.test.js
git commit -m "Ctrl+S 저장과 편집 초안 복구를 추가"
```

### Task 3: Explicit reversible answer records

**Files:**
- Modify: `firestore-store.js:180-210`
- Modify: `index.html:2680-3065`
- Test: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `store.mergeAnswer(sessionId, studentId, questionIndex, answer)`.
- Produces: answer records `{ c|cs|txt, ok?, ms, at, submitted, revision }`; `answerIsSubmitted(record)` where missing `submitted` means `true`; `store.setAnswerState(...)` as the single merge entry point.

- [ ] **Step 1: Write failing compatibility and state tests**

Cover legacy answers, draft/cancel records, preservation of other question keys, and monotonic revision values.

```js
assert.equal(answerIsSubmitted({ c: 0 }), true);
assert.equal(answerIsSubmitted({ c: 0, submitted: false }), false);
await store.setAnswerState('s', 'u', 2, { c: 1, submitted: false, revision: 4 });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="제출 상태|레거시 응답|revision" tests/firestore-store.test.js
```

Expected: FAIL because the explicit submission API and predicate do not exist.

- [ ] **Step 3: Implement the idempotent store write**

`setAnswerState` writes only `answers.{questionIndex}` through the existing merge shape. The caller increments `revision`; snapshots with a lower revision are ignored when rebuilding UI state. Keep `mergeAnswer` as a compatibility alias until all call sites move.

```js
function answerIsSubmitted(answer) {
  return !!answer && answer.submitted !== false;
}
```

- [ ] **Step 4: Make response readers submission-aware**

When restoring student answers, place submitted records in `myAnswers`; keep a non-submitted current record as editable selection/draft. When teacher and dashboard code reshape response documents, exclude `submitted:false` records from scores, submitted counts, CSV answers, and distributions.

- [ ] **Step 5: Run store and full tests**

Run:

```powershell
node --test tests/firestore-store.test.js
node --test tests/*.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add firestore-store.js index.html tests/firestore-store.test.js
git commit -m "학생 응답의 제출과 다시 고르기 상태를 분리"
```

### Task 4: Student select, submit, revise, and deadline auto-submit

**Files:**
- Modify: `index.html:2610-3085`
- Test: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: Task 3's `answerIsSubmitted` and `store.setAnswerState`.
- Produces: `stHasDraftAnswer()`, `stBuildAnswer()`, `stSubmitCurrent(source)`, `stReviseAnswer()`, and `stDeadlineTick()`.

- [ ] **Step 1: Write failing state-machine tests for all five question types**

Assert choice/OX clicks only update `st.sel`; multi toggles only update `st.multiSel`; text input only updates `st.draft`; `제출하기` writes once; `다시 고르기` writes `submitted:false`; and the deadline submits the latest non-empty draft once.

```js
context.stAnswer(1);
assert.equal(calls.length, 0);
await context.stSubmitCurrent('button');
assert.equal(calls[0][4].submitted, true);
await context.stReviseAnswer();
assert.equal(calls[1][4].submitted, false);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="다시 고르기|자동 제출|선택만|다섯 문항" tests/firestore-store.test.js
```

Expected: current choice behavior submits immediately and tests FAIL.

- [ ] **Step 3: Separate selection from submission in the UI**

Change choice/OX buttons to call a selection-only handler. Render `제출하기` for every type when a non-empty draft exists. After submission, render the submitted answer disabled plus `다시 고르기`; hide revise after deadline, reveal, or close.

- [ ] **Step 4: Implement one submission builder and reversible state**

Build payloads centrally so button and deadline paths cannot diverge:

```js
function stSubmitCurrent(source) {
  const built = stBuildAnswer();
  if (!built) return Promise.resolve(false);
  return stSend({ ...built.payload, submitted: true, revision: ++st.revision, source }, built.local);
}
```

`stReviseAnswer()` preserves the visible answer, sets `submitted:false`, removes it from `myAnswers`, and returns the UI to editable state.

- [ ] **Step 5: Add a one-shot deadline transition**

In `stTick`, detect the first transition from positive time to zero. If not submitted and `stHasDraftAnswer()` is true, call `stSubmitCurrent('timer')` once; otherwise lock as unsubmitted. Guard with question ID/openedAt plus a `deadlineHandled` key so 250ms ticks cannot duplicate writes.

- [ ] **Step 6: Run focused, full, and stale-tab tests**

Run:

```powershell
node --test tests/*.test.js
```

Expected: all tests PASS, including stale subscription/revision cases.

- [ ] **Step 7: Commit**

```powershell
git add index.html tests/firestore-store.test.js
git commit -m "학생 답안을 확인 후 제출하고 마감 때 자동 제출"
```

### Task 5: Teacher counts and synchronized animated timers

**Files:**
- Modify: `index.html:400-470,2420-2620,2785-2910`
- Test: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: server-corrected `serverNow()`, `pl.live`/`st.live`, and submission-aware response maps.
- Produces: `timerView(live, now)` returning `{ left, ratio, phase }`, and `submissionCounts(students, responses, questionIndex)` returning `{ participants, submitted, missing }`.

- [ ] **Step 1: Write failing pure calculation tests**

```js
assert.deepEqual(submissionCounts({a:{},b:{},c:{}}, {a:{0:{submitted:true}},b:{0:{submitted:false}}}, 0),
  { participants: 3, submitted: 1, missing: 2 });
assert.deepEqual(timerView({openedAt:1000,limitSec:15},9000), {left:7,ratio:7/15,phase:'warning'});
```

Also test `normal` above 7 seconds, `warning` at 7–4, `urgent` at 3–0, no-limit `null`, and teacher/student equality.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="참여.*제출.*미제출|타이머 단계|동일한 타이머" tests/firestore-store.test.js
```

Expected: FAIL because helpers and three-count display do not exist.

- [ ] **Step 3: Render teacher counts without leaking answers**

Replace `0 / 0 제출` with three labeled values: `참여 N명 · 제출 S명 · 미제출 M명`. Recompute on student subscription and response subscription changes. Keep distribution bars and correct classes gated behind `plRevealed()`.

- [ ] **Step 4: Render the shared timer component**

Use the same DOM shape and `timerView` calculation for teacher and student:

```html
<div class="quiz-timer" data-phase="normal">
  <div class="quiz-timer-track"><i></i></div>
  <strong class="quiz-timer-number">15초</strong>
</div>
```

Animate width linearly, use green/`normal`, orange/`warning`, red/`urgent`, keep the numeric label, and add a `prefers-reduced-motion` rule that removes the width transition.

- [ ] **Step 5: Update tick functions without full rerenders**

Both `plTimerTick` and `stTick` update only width, phase, and text on the existing DOM. They must calculate from `serverNow()` on every tick so background-tab throttling cannot create drift.

- [ ] **Step 6: Run all automated checks**

Run:

```powershell
node --test tests/*.test.js
git diff --check
```

Expected: all tests PASS and no whitespace errors.

- [ ] **Step 7: Commit**

```powershell
git add index.html tests/firestore-store.test.js
git commit -m "교사 제출 현황과 동기화 타이머를 개선"
```

### Task 6: Documentation and real browser regression

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-14-save-submit-timer-design.md` only if verified behavior requires a factual clarification
- Test: `tests/firestore-core.test.js`, `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: operator documentation and browser evidence for deployment readiness.

- [ ] **Step 1: Update user-facing documentation**

Document `Ctrl+S`/`Cmd+S`, local-only recovery, formal Firestore save, explicit submit, revise-before-deadline, automatic deadline submission, and teacher count meanings. State that unsaved drafts do not follow the user to another computer.

- [ ] **Step 2: Run fresh automated verification**

Run:

```powershell
node --test tests/*.test.js
git diff --check
git status --short
```

Expected: all tests PASS; only intended documentation/code/test files are modified.

- [ ] **Step 3: Verify editor behavior in a real browser**

On a disposable test set, modify each field class, confirm draft creation, reload and restore, decline recovery once, verify `Ctrl+S`, verify status transitions, and open another browser context to confirm only the formally saved version follows across computers.

- [ ] **Step 4: Verify two-window class behavior**

Open teacher and student windows. For choice, multi, O/X, short, and long questions verify selection does not submit, button submission increments the teacher count, revise decrements it, resubmission increments it, and deadline auto-submits the latest non-empty value. Verify an empty answer remains missing.

- [ ] **Step 5: Verify timer and privacy behavior**

Confirm both windows show the same seconds within one second, bar widths shrink together, phases change at 7 and 3 seconds, reduced-motion removes smooth animation, and no correct answer/distribution appears before reveal.

- [ ] **Step 6: Commit**

```powershell
git add README.md docs/superpowers/specs/2026-08-14-save-submit-timer-design.md
git commit -m "새 저장과 제출 흐름의 사용법을 문서화"
```

### Task 7: Final review, deployment, and deployed smoke test

**Files:**
- Modify: `README.md` or the design document only to record deployed verification evidence when needed.

**Interfaces:**
- Consumes: reviewed commits from Tasks 1–6.
- Produces: pushed `main` and verified GitHub Pages behavior.

- [ ] **Step 1: Request final code review**

Review the complete feature diff against the approved design. Fix every Critical or Important finding and rerun the affected tests before continuing.

- [ ] **Step 2: Run the completion gate**

```powershell
node --test tests/*.test.js
git diff --check
git status -sb
```

Expected: all tests PASS, no whitespace errors, and a clean worktree.

- [ ] **Step 3: Push main**

```powershell
git push origin main
```

- [ ] **Step 4: Verify GitHub Pages after deployment**

At `https://shining-jade.github.io/video-quiz/`, repeat one editor draft/save flow and one teacher/student flow containing manual submit, revise, resubmit, deadline auto-submit, three teacher counts, synchronized timer phases, and console-error inspection.

- [ ] **Step 5: Record evidence and push the verification note**

Record test count, browser scenarios, observed timer skew, and any transient network issue without marking untested scenarios complete. Commit and push the documentation-only evidence update.
