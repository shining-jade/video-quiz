# Public Quiz Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let approved teachers publish a privacy-safe read-only quiz projection and let other approved teachers create independent private copies.

**Architecture:** Add a dedicated `published_quiz_sets/{setId}` projection with hidden `building` and visible `published` states plus public image children. Owner-only publication and admin moderation use revision-bound Firestore transactions; copying reads only the projection and writes one strict-counter private destination.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Firestore compat SDK, Node test runner, Firestore Rules Emulator.

**Spec:** `docs/superpowers/specs/2026-08-21-email-auth-public-quiz-library-design.md`

## Global Constraints

- New sets, restored sets, imported sets, and copied sets are private by default.
- Only an active owner may publish or withdraw; collaborators cannot change visibility.
- Only active approved teachers and admins may list/get/copy a `published` projection.
- Anonymous users, students, unapproved, suspended, and deletion-pending teachers cannot read the library.
- Public documents never contain owner email, Firebase UID, collaborators, students, responses, scores, sessions, plans, or admin-private audit data.
- Copying never grants edit access to the original and always creates a private independent destination.
- Trash, purge, owner suspension, deletion pending, or moderation stop must fail closed for new reads and copies.
- Existing active sets are private after deployment; no publication backfill runs.

---

### Task 1: Pure publication and provenance model

**Files:**
- Create: `public-quiz-library-core.js`
- Create: `tests/public-quiz-library-core.test.js`
- Modify: `index.html` (script include only)
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Produces: `PublicQuizLibraryCore.buildProjection(set, context) -> projection`
- Produces: `PublicQuizLibraryCore.validateProjection(value) -> {ok, errors}`
- Produces: `PublicQuizLibraryCore.copyPatch(projection) -> provenance/private defaults`
- Produces: `PublicQuizLibraryCore.publicSummary(projection) -> bounded list item`

- [ ] **Step 1: Write failing privacy and default tests**

```js
test('projection contains bounded public content and strips every private identity field', () => {
  const projection = Core.buildProjection(privateSet, {
    setId: 'set-1', authorDisplayName: '홍교사', revision: '10:20', nowMs: 100
  });
  assert.equal(projection.status, 'building');
  assert.equal(projection.authorDisplayName, '홍교사');
  for (const key of ['ownerUid', 'ownerEmail', 'collaborators', 'sessions', 'responses']) {
    assert.equal(key in projection, false);
  }
});

test('copy patch is private and resets collaborators and lifecycle counters', () => {
  assert.deepEqual(Core.copyPatch(projection), {
    publicationId: 'set-1', sourceTitle: projection.title,
    sourceAuthorDisplayName: '홍교사', visibility: 'private',
    collaboratorCount: 0, imageCount: projection.imageCount, lifecycleState: 'active'
  });
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `node --test tests/public-quiz-library-core.test.js tests/release-copy.test.js`

Expected: FAIL because the core and browser script include are missing.

- [ ] **Step 3: Implement strict allowlist projection**

```js
const PUBLIC_KEYS = [
  'publicationId', 'sourceSetId', 'status', 'moderationStatus', 'revision',
  'title', 'description', 'authorDisplayName', 'videos', 'settings',
  'videoCount', 'questionCount', 'imageCount', 'publishedAtMs', 'updatedAtMs'
];

function publicSummary(value) {
  return {
    publicationId: value.publicationId, title: value.title,
    description: value.description, authorDisplayName: value.authorDisplayName,
    videoCount: value.videoCount, questionCount: value.questionCount,
    updatedAtMs: value.updatedAtMs
  };
}
```

Reuse existing quiz normalization and image limits. Reject oversized title/description/author, malformed videos/questions, noncanonical IDs, unknown fields, non-safe counts, and statuses outside `building|published|withdrawn|moderated`.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test tests/public-quiz-library-core.test.js tests/release-copy.test.js`

```powershell
git add public-quiz-library-core.js tests/public-quiz-library-core.test.js index.html tests/release-copy.test.js
git commit -m "공개 퀴즈 projection 모델 추가"
```

### Task 2: Store publication, withdrawal, moderation, and bounded reads

**Files:**
- Modify: `firestore-store.js`
- Test: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `PublicQuizLibraryCore.buildProjection`, `validateProjection`, `copyPatch`
- Produces: `store.publishQuizSet(setId, actor)`
- Produces: `store.withdrawPublishedQuizSet(setId, actor)`
- Produces: `store.adminModeratePublishedQuiz(setId, expectedRevision, reason, admin)`
- Produces: `store.adminRestorePublishedQuiz(setId, expectedRevision, admin)`
- Produces: `store.listPublishedQuizSets({limit, cursor})`
- Produces: `store.getPublishedQuizSet(publicationId)`
- Produces: `store.copyPublishedQuizSet(publicationId, newSetId, actor)`

- [ ] **Step 1: Write failing store contract tests**

```js
test('publish remains hidden while images are building and finalizes only after source reread', async () => {
  const result = await store.publishQuizSet('set-1', owner);
  assert.deepEqual(writeOrder, ['building-parent', 'public-images', 'source-reread', 'published-parent']);
  assert.equal(result.status, 'published');
});

test('copy reads public projection only and writes a private strict-counter destination', async () => {
  await store.copyPublishedQuizSet('set-1', 'copy-1', otherTeacher);
  assert.equal(readPaths.some(path => path === 'quiz_sets/set-1'), false);
  assert.equal(documents['quiz_sets/copy-1'].ownerUid, otherTeacher.uid);
  assert.equal(documents['quiz_sets/copy-1'].visibility, 'private');
});
```

Add rejection tests for collaborator publish, stale source revision, withdrawal during copy, moderated source, trash source, suspended owner, partial image write, destination collision, and retry after ambiguous commit.

- [ ] **Step 2: Run focused store tests and observe RED**

Run: `node --test --test-name-pattern='publish|public projection|copyPublished' tests/firestore-store.test.js`

Expected: FAIL because all publication APIs are missing.

- [ ] **Step 3: Implement resumable publication**

`publishQuizSet` performs:

1. server-read source, owner allowance, and private images;
2. validate active lifecycle, exact owner, counters, content revision, and size preflight;
3. transaction-write a `building` projection with a random `buildToken` and exact source revision;
4. write public image children keyed exactly like private image children and bound to `buildToken`;
5. transaction-reread source, owner allowance, public parent, and image count;
6. set status `published`, remove `buildToken`, and use server timestamps.

`building`, `withdrawn`, and `moderated` states are never returned from the normal list/get methods. A retry with the same source revision resumes its own build; a different token/revision refuses to overwrite.

- [ ] **Step 4: Implement withdrawal and moderation CAS**

Withdrawal transaction validates owner UID, source active lifecycle, `published` status and exact revision, then sets `withdrawn`. Trash transition and teacher suspension/deletion paths call the same state transition in their existing atomic workflow or fail closed before committing.

Admin moderation validates authoritative admin allowance, exact publication revision, bounded reason (1–200 chars), and writes `moderatedByUid`, `moderatedAt`, and `moderationReason`. Restore is admin-only and returns to `published` only while the source and owner remain active.

- [ ] **Step 5: Implement private copy**

Read only `published_quiz_sets/{id}` and its public image children. Before destination commit, server-reread the publication and require the same revision/status. Call the strict-counter destination writer with `copyPatch`, new owner fields, no collaborator mutation, no trash markers, and immutable provenance. Destination parent and every destination image commit atomically within existing document/8 MiB preflight bounds.

- [ ] **Step 6: Run focused and full store tests**

Run:

```powershell
node --test --test-name-pattern="publish|withdraw|moderate|copyPublished" tests/firestore-store.test.js
node --test tests/firestore-store.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit**

```powershell
git add firestore-store.js tests/firestore-store.test.js
git commit -m "공개 세트 게시 철회와 사본 저장 구현"
```

### Task 3: Firestore Rules privacy boundary

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Adds collection: `published_quiz_sets/{setId}`
- Adds children: `published_quiz_sets/{setId}/images/{imageId}`
- Consumes store mutation shapes from Task 2

- [ ] **Step 1: Write failing role and mutation matrix**

```js
rulesTest('only active approved teachers list published projections with an exact bounded query', async () => {
  await assertSucceeds(publishedQuery(owner));
  await assertSucceeds(publishedQuery(otherTeacher));
  await assertFails(getDocs(collection(unapproved, 'published_quiz_sets')));
  await assertFails(getDocs(collection(student, 'published_quiz_sets')));
  await assertFails(getDocs(collection(anonymous, 'published_quiz_sets')));
});

rulesTest('private active original is owner or collaborator only', async () => {
  await assertSucceeds(getDoc(doc(owner, 'quiz_sets/private-set')));
  await assertSucceeds(getDoc(doc(editor, 'quiz_sets/private-set')));
  await assertFails(getDoc(doc(otherTeacher, 'quiz_sets/private-set')));
});
```

Add exact tests for owner publish, collaborator/admin direct content write denial, standalone projection write, stale revision, building list denial, withdrawn/moderated get denial, public image binding, copy destination provenance forge, trash/suspended/deletion-pending source, and direct URL access.

- [ ] **Step 2: Run focused Emulator tests and observe RED**

Run: `firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-name-pattern='published projection|private active original' tests/firestore-rules.test.js"`

Expected: public collection has no rules and another approved teacher can still read the current active private original.

- [ ] **Step 3: Close private original reads**

Change `quiz_sets` get/list so active approved teachers no longer receive every active set. Allow owner, exact collaborator, and admin as required by current admin tooling. Session creation from another teacher must use their own copy; remove the old path that starts a class directly from another teacher's original. Add matching client list queries so Firestore Rules never act as filters.

- [ ] **Step 4: Add exact public projection rules**

Rules require:

- active approved teacher for visible `status == 'published'` get/list;
- exact query `where('status','==','published').orderBy('updatedAt','desc').limit(<=50)`;
- owner-only building/finalize/withdraw paired with active source and exact revision;
- admin-only moderation fields with exact revision;
- public images readable only when parent is visible and writable only in the matching build transaction/protocol;
- copy destination provenance referencing an existing visible publication with exact revision.

Do not place owner UID/email in public resource data. Use the same document ID to resolve the private source when Rules need to verify ownership.

- [ ] **Step 5: Run focused and full Emulator suites**

Run: `pnpm test:rules`

Expected: the entire Rules/Admin Emulator suite passes with no expression-budget or query-shape failure.

- [ ] **Step 6: Commit**

```powershell
git add firestore.rules tests/firestore-rules.test.js
git commit -m "비공개 원본과 공개 자료실 권한 경계 적용"
```

### Task 4: Owner controls and public library UI

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes all Task 2 store APIs
- Produces: `screenPublicQuizLibrary()`
- Produces: `openPublishedQuizPreview(publicationId)`
- Produces: `publishQuizSetFromList(setId)`
- Produces: `withdrawQuizSetFromList(setId)`
- Produces: `copyPublishedQuizSetFromLibrary(publicationId)`

- [ ] **Step 1: Write failing DOM/runtime tests**

```js
test('owner card defaults private and exposes publish while collaborator card does not', () => {
  assert.match(ownerCard, /비공개/);
  assert.match(ownerCard, /공개 자료실에 게시/);
  assert.doesNotMatch(collaboratorCard, /공개 자료실에 게시/);
});

test('library renders summary only and copy routes to the new private set', async () => {
  await runtime.copyPublication('pub-1');
  assert.equal(runtime.lastRoute, '#/make/copy-1');
  assert.equal(runtime.renderedHtml.includes('owner@example.com'), false);
});
```

Add route/auth generation tests proving A→B/signout synchronously clears library and preview DOM, stale list/copy completions do not rerender, and mobile markup has accessible labels.

- [ ] **Step 2: Run tests and observe RED**

Run: `node --test --test-name-pattern='public library|공개 자료실|owner card defaults' tests/firestore-store.test.js tests/release-copy.test.js`

Expected: FAIL because UI handlers, route, and copy controls are absent.

- [ ] **Step 3: Add owner controls**

Set cards show `비공개`, `공개 중`, or `관리자 공개 중지`. Owner-only buttons open a confirmation dialog listing title, description, author display name, image inclusion, and copyright notice. Disable controls during writes and server-reread the resulting status before success toast.

- [ ] **Step 4: Add library route and responsive screen**

Add `#/library` to teacher-only routing and a `공개 자료실` main menu item. Render bounded search input, 50-item page, title, description, author display name, video/question counts, preview, and `내 세트로 복사`. No email/UID appears in HTML, title attributes, errors, or client logs.

Use a request state `{uid, authGeneration, requestId, cursor}`. Every async continuation checks route, UID, active teacher status, generation, and request ID before rendering.

- [ ] **Step 5: Add admin moderation controls**

Admin published-set panel lists current projection revision and provides bounded reason input. Stop/restore calls exact CAS APIs and removes stale rows only after authoritative server reread.

- [ ] **Step 6: Run focused and full Node suites**

Run:

```powershell
node --test tests/firestore-store.test.js tests/release-copy.test.js tests/public-quiz-library-core.test.js
pnpm test
```

Expected: all tests pass with zero failures and inline scripts parse.

- [ ] **Step 7: Commit**

```powershell
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "공개 퀴즈 자료실과 소유자 게시 UI 구현"
```

### Task 5: Lifecycle coupling, documentation, and release acceptance

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`
- Modify: `tests/release-copy.test.js`
- Modify: `README.md`
- Modify: `HANDOFF.md`
- Create: `docs/PUBLIC-QUIZ-LIBRARY.md`

**Interfaces:**
- Couples publication visibility to trash, purge, teacher suspension, deletion pending, and restoration
- Produces: `store.withdrawOwnedPublicationsForLifecycle(ownerUid, expectedAllowanceRevision, reason, actor) -> {withdrawnCount, remainingVisibleCount}`
- Produces: `store.auditOwnedPublications(ownerUid, limit, cursor) -> {items, nextCursor, visibleCount}`
- Consumes: `adminUpdateTeacherAllowance` and `requestTeacherDeletion` only after `remainingVisibleCount === 0`
- Documents deployment, rollback, moderation, and privacy audit

- [ ] **Step 1: Write failing lifecycle barrier tests**

```js
test('trash atomically withdraws a published set and restore remains private', async () => {
  await store.moveSetToTrash('set-1');
  assert.equal(docs['published_quiz_sets/set-1'].status, 'withdrawn');
  await store.restoreSet('set-1');
  assert.equal(docs['published_quiz_sets/set-1'].status, 'withdrawn');
});

test('suspension and deletion pending hide every owned publication before access is removed', async () => {
  await admin.suspend(ownerUid);
  assert.equal(await publicQueryCount(), 0);
});
```

Rules tests must also prove a client cannot race copy against trash/suspension or resurrect a moderated publication.

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```powershell
node --test --test-name-pattern="trash atomically withdraws|suspension.*publication" tests/firestore-store.test.js
firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-name-pattern='publication.*trash|publication.*suspend' tests/firestore-rules.test.js"
```

Expected: current lifecycle methods leave the publication visible or have no paired publication transition.

- [ ] **Step 3: Implement fail-closed lifecycle coupling**

Before trash, purge, suspension, or deletion-pending commit, transaction-read the owned publication. If visible, transition it to `withdrawn` in the same authorized protocol. Because one teacher may own more publications than one transaction can update during suspension, implement `withdrawOwnedPublicationsForLifecycle` as an exact owner-or-admin, server-read paging loop: query at most 50 private source sets by exact `ownerUid`, transaction-read each matching publication and source revision, withdraw visible publications in batches of at most 50, then restart the query and re-audit until `remainingVisibleCount === 0`. Only after that exact result may `adminUpdateTeacherAllowance` or `requestTeacherDeletion` change the allowance. Bind the loop to the starting allowance UID/email/revision and re-read that allowance before every batch and before the final status mutation. Any query, write, allowance revision, auth-generation, or route failure leaves the allowance active and reports a resumable failure; already withdrawn publications remain safely hidden.

Restore leaves publication withdrawn. Purge deletes or tombstones public images only after the parent is nonvisible and uses bounded batches. Orphan public image audit is added to existing purge safety checks.

- [ ] **Step 4: Write operations documentation and static contract test**

`docs/PUBLIC-QUIZ-LIBRARY.md` must specify:

- collection paths and public field allowlist;
- owner publish/withdraw and admin moderation;
- private-default migration behavior;
- suspension/deletion preflight and rollback;
- public image/orphan audit;
- exact Rules-before-app deployment order;
- privacy smoke with owner, collaborator, other teacher, admin, student, anonymous, suspended, and deletion-pending actors.

Add release-copy assertions for `private by default`, `published_quiz_sets`, `승인 교사만`, `독립 사본`, `이메일과 UID 비공개`, and `롤백`.

- [ ] **Step 5: Run all automated gates**

Run:

```powershell
pnpm test
pnpm test:rules
node --check public-quiz-library-core.js
git diff --check
```

Expected: every command exits 0; Node and Emulator suites have zero failures.

- [ ] **Step 6: Complete two-teacher browser acceptance**

1. owner A publishes a set containing question and explanation images;
2. approved teacher B finds it without seeing A email/UID;
3. B previews and creates an independent private copy;
4. B edits the copy while A original remains unchanged;
5. A withdraws and B cannot start a new copy, while B's existing copy remains;
6. A republishes, admin moderates, and A cannot bypass moderation;
7. A trashes and restores the original; it stays private;
8. unapproved, student, anonymous, suspended, and deletion-pending accounts cannot list/get/copy;
9. mobile and wide layouts are usable and app/Firebase-origin console errors are zero.

- [ ] **Step 7: Commit**

```powershell
git add firestore-store.js firestore.rules index.html tests/firestore-store.test.js tests/firestore-rules.test.js tests/release-copy.test.js README.md HANDOFF.md docs/PUBLIC-QUIZ-LIBRARY.md
git commit -m "공개 자료실 수명주기와 운영 절차 완성"
```
