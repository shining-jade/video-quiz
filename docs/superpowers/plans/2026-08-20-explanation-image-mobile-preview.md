# Explanation Image and Mobile Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional collapsible explanation images and an interactive student-mobile preview while aligning editor controls.

**Architecture:** Extend the existing image-key pipeline with an `e` suffix for explanation uploads and publish the resolved image only through `publicAnswer` after reveal. Reuse the existing preview state machine, changing only presentation mode and result rendering.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Firestore browser store/rules, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-20-explanation-image-mobile-preview-design.md`

## Global Constraints

- Existing question-image keys and legacy numeric keys remain compatible.
- Explanation material is unavailable before answer reveal.
- No new paid service or scheduled backend is introduced.
- All production changes follow RED → GREEN tests.

---

### Task 1: Explanation image storage and public projection

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Produces: normalized image keys `v{vi}q{qi}` and `v{vi}q{qi}e`; `publicAnswer(question, explainImage)`.

- [ ] Write tests proving explanation keys round-trip and `explainImage` appears only in public answers.
- [ ] Run focused tests and confirm failures identify unsupported keys/fields.
- [ ] Extend key normalization, public answer validation, and Rules allowlist/size checks.
- [ ] Run focused Node and Emulator tests.
- [ ] Commit the independently passing storage boundary.

### Task 2: Collapsible editor and payload persistence

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: `v{vi}q{qi}e` image key.
- Produces: `explainImgUrl`, `explainImgUp`, `_explainImg`, expandable editor functions.

- [ ] Write failing editor load/save/upload/URL/clear and collapsed-state tests.
- [ ] Confirm failures occur because explanation image state and UI do not exist.
- [ ] Add normalized fields, generic image preparation handlers, payload collection, and expandable markup.
- [ ] Align explanation/limit rows and q-head control heights.
- [ ] Run focused editor and release tests.
- [ ] Commit the editor deliverable.

### Task 3: Teacher and student result rendering

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: `publicAnswer.explainImage` and session snapshot key `v{vi}q{qi}e`.
- Produces: reveal-only explanation image in teacher and student views.

- [ ] Write failing tests for hidden-before-reveal and visible-after-reveal behavior.
- [ ] Resolve explanation images when opening/revealing a live question.
- [ ] Render the image below explanation text in teacher/student result views.
- [ ] Run focused runtime and Rules tests.
- [ ] Commit the live-screen deliverable.

### Task 4: Interactive student-mobile preview

**Files:**
- Modify: `index.html`
- Modify: `quiz-preview-core.js` only if presentation-neutral state needs an accessor.
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: existing preview select/submit/continue state.
- Produces: teacher/mobile presentation toggle with identical answer behavior.

- [ ] Write failing tests for mode switching, phone frame, selection, result, and explanation image order.
- [ ] Add preview mode state and accessible toggle controls.
- [ ] Render mobile-specific frame without duplicating grading logic.
- [ ] Run focused preview tests and inline-script parse checks.
- [ ] Commit the preview deliverable.

### Task 5: Final verification and deployment

**Files:**
- Modify: `README.md` only if user-facing usage needs clarification.

- [ ] Run all Node tests and full Firestore Emulator tests.
- [ ] Run `git diff --check` and inspect the complete diff.
- [ ] Fast-forward merge to `main` after all gates pass.
- [ ] Push `main` and verify cache-busted GitHub Pages assets contain the new controls.
