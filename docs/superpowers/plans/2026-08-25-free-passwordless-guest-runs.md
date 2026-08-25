# Free Passwordless Guest Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let teachers run an operator-owned quiz from an unguessable link without login, password, Cloud Functions, or a paid Firebase plan.

**Architecture:** The operator publishes an allow-listed immutable revision under an unguessable `guest_quiz_shares/{shareId}` path. The guest browser silently signs in with Firebase Anonymous Auth, reads that exact share, and creates UID-isolated ordinary sessions; Firestore Rules deny share enumeration, private-set reads, and cross-guest access.

**Tech Stack:** Static HTML/JavaScript, Firebase compat SDK 10.12.0, Firebase Anonymous Auth, Cloud Firestore, Firestore Security Rules, Node.js test runner, Firebase Emulator Suite, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-25-free-passwordless-guest-runs-design.md`

## Global Constraints

- Firebase Spark free plan only; do not deploy or require Cloud Functions, Cloud Build, or Artifact Registry.
- Keep operator authentication and private `quiz_sets` ownership unchanged.
- The guest route shows no login form, password field, approval flow, or operator navigation.
- Use a cryptographically random 32-byte URL-safe `shareId` as the only link capability.
- Never allow collection listing of `guest_quiz_shares` or anonymous reads of `quiz_sets`.
- Every run gets a new session ID and six-character class code; responses remain session-scoped.
- Revocation blocks new sessions while an already-created owning guest can safely end its session.
- Preserve unrelated uncommitted workspace files and the existing user modification in `index.html`.

---

## File Structure

- Modify `guest-quiz-share-core.js`: simplify route parsing and lifecycle for share-ID-only links.
- Modify `firestore-store.js`: publish/revoke share revisions without token hashes and load active shares directly.
- Modify `firestore.rules`: direct-share read, no enumeration, anonymous UID session isolation, operator derived-session reads.
- Modify `index.html`: remove Functions exchange and render silent Anonymous Auth guest flow.
- Modify `firebase.json`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`: remove Functions deployment/runtime requirements.
- Remove `functions/index.js`, `functions/guest-share-service.js`, `functions/package.json`, `tests/guest-share-service.test.js`.
- Modify `tests/guest-quiz-share-core.test.js`, `tests/firestore-store.test.js`, `tests/firestore-rules.test.js`, `tests/release-copy.test.js`, `tests/firestore-indexes.test.js`.
- Modify `docs/RELEASE-RUNBOOK.md`, `README.md`: document Spark-only deployment and acceptance.

### Task 1: Share-ID-Only Core Contract

**Files:**
- Modify: `guest-quiz-share-core.js`
- Modify: `tests/guest-quiz-share-core.test.js`

**Interfaces:**
- Produces: `randomToken(32, cryptoApi) -> 43-character URL-safe shareId`
- Produces: `parseGuestRoute(shareId, query) -> { shareId } | { invalid: true }`
- Produces: `projectQuizSet(set, images) -> frozen allow-list projection`
- Produces: `nextShareState(current, action, nowValue) -> share lifecycle state without tokenHash`

- [ ] **Step 1: Replace token-route tests with share-ID-only failing tests**

```js
test('guest route accepts one 43-character share id and no query capability', () => {
  const id = 'A'.repeat(43);
  assert.deepEqual(Core.parseGuestRoute(id, ''), { shareId: id });
  assert.deepEqual(Core.parseGuestRoute(id, 'token=legacy'), { invalid: true });
  assert.deepEqual(Core.parseGuestRoute('short', ''), { invalid: true });
});

test('share lifecycle stores no token hash and revoked ids never reactivate', () => {
  const active = Core.nextShareState(null, { type: 'create', shareId: 'A'.repeat(43) }, 10);
  assert.equal(Object.hasOwn(active, 'tokenHash'), false);
  const revoked = Core.nextShareState(active, { type: 'revoke' }, 20);
  assert.throws(() => Core.nextShareState(revoked, { type: 'refresh' }, 30));
});
```

- [ ] **Step 2: Run the core tests and confirm failure**

Run: `node --test tests/guest-quiz-share-core.test.js`
Expected: FAIL because the current parser requires `token` and lifecycle requires `tokenHash`.

- [ ] **Step 3: Implement exact share-ID-only validation**

Use `SHARE_ID = /^[A-Za-z0-9_-]{43}$/`; reject every query key, remove `sha256Hex`, `guestClaimsValid`, and `tokenHash` lifecycle fields, while preserving projection bounds and deep freezing.

- [ ] **Step 4: Run the core tests**

Run: `node --test tests/guest-quiz-share-core.test.js`
Expected: PASS with privacy projection regressions unchanged.

- [ ] **Step 5: Commit the core simplification**

```powershell
git add guest-quiz-share-core.js tests/guest-quiz-share-core.test.js
git commit -m "refactor: use share id guest capabilities"
```

### Task 2: Free Share Publication Store

**Files:**
- Modify: `firestore-store.js`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Produces: `createGuestQuizShare(setId, projection, actor, shareId) -> { shareId, revision, status }`
- Produces: `refreshGuestQuizShare(setId, projection, actor) -> share`
- Produces: `revokeGuestQuizShare(setId, actor) -> revoked share`
- Produces: `loadActiveGuestQuizShare(shareId) -> { set, images, shareId, revision, sourceSetId, sourceOwnerUid }`
- Preserves: `prepareGuestSession(set, label, guestContext)` and `listOwnedDerivedSessions(setId, actor)`.

- [ ] **Step 1: Write failing store tests for publication without secrets**

```js
test('free guest share publishes an active revision without token material', async () => {
  const result = await store.createGuestQuizShare('set1', projection, owner, 'A'.repeat(43));
  const parent = fake.value('guest_quiz_shares/' + result.shareId);
  assert.equal(parent.status, 'active');
  assert.equal(Object.hasOwn(parent, 'tokenHash'), false);
});

test('active share loader rejects revoked parent before reading children', async () => {
  fake.seed('guest_quiz_shares/' + 'A'.repeat(43), { status: 'revoked', revision: 1 });
  await assert.rejects(() => store.loadActiveGuestQuizShare('A'.repeat(43)), /사용할 수 없는/);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test --test-name-pattern="free guest share|active share loader" tests/firestore-store.test.js`
Expected: FAIL because the current API requires a token hash and claimed revision.

- [ ] **Step 3: Remove token storage and add direct active loader**

Keep the ready-child-then-active-parent publication ordering. `loadActiveGuestQuizShare` must get the exact parent, require `status === 'active'`, read only its current ready revision children, normalize existing playlist keys, and never read `quiz_sets/{sourceSetId}`.

- [ ] **Step 4: Run focused and complete store tests**

Run: `node --test --test-name-pattern="guest share|guest session|derived" tests/firestore-store.test.js`
Expected: PASS.

Run: `node --test tests/firestore-store.test.js`
Expected: PASS with zero failures.

- [ ] **Step 5: Commit the store boundary**

```powershell
git add firestore-store.js tests/firestore-store.test.js
git commit -m "feat: publish free guest run shares"
```

### Task 3: Spark-Compatible Firestore Rules

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`
- Modify: `firestore.indexes.json`
- Modify: `tests/firestore-indexes.test.js`

**Interfaces:**
- Allows: exact `get` of active share parent/current ready revision and children.
- Denies: share collection listing and all anonymous private-set reads.
- Allows: anonymous-auth guest session create/control only for its exact UID and active share.
- Allows: exact source owner read-only access to derived session children.

- [ ] **Step 1: Replace custom-claim tests with direct-share authorization tests**

```js
const guest = testEnvironment.authenticatedContext('anon-a', {
  firebase: { sign_in_provider: 'anonymous' }
}).firestore();
await assertSucceeds(getDoc(doc(guest, `guest_quiz_shares/${shareId}`)));
await assertFails(getDocs(collection(guest, 'guest_quiz_shares')));
await assertFails(getDoc(doc(guest, 'quiz_sets/set1')));
```

Add two-guest session isolation, revoked-new-session denial, existing-session safe end, source-owner child read, non-owner teacher denial, and immutable provenance cases.

- [ ] **Step 2: Run Rules tests and confirm failure**

Run: `pnpm test:rules`
Expected: direct anonymous share reads FAIL because current Rules require custom claims.

- [ ] **Step 3: Implement share-ID capability Rules**

Replace `guestIdentity` and `guestCapabilityActive` custom-claim checks with anonymous provider checks plus exact parent/revision binding. Parent `allow get` requires active shape; `allow list` remains false. Session create must verify `sourceShareId`, current revision, source fields, counters, lease, and requester UID. Read-only source-owner access extends to students, responses, grades, scores, board, snapshot, and snapshot images without granting writes.

- [ ] **Step 4: Verify the required derived-session index only**

Keep `sessions(sourceOwnerUid ASC, sourceSetId ASC, createdAt DESC, __name__ DESC)` and the existing public-library index. Update the index test to require both exact definitions and reject duplicates.

- [ ] **Step 5: Run complete Rules and index tests**

Run: `pnpm test:rules`
Expected: PASS with zero failures.

Run: `node --test tests/firestore-indexes.test.js`
Expected: PASS.

- [ ] **Step 6: Commit security rules**

```powershell
git add firestore.rules firestore.indexes.json tests/firestore-rules.test.js tests/firestore-indexes.test.js
git commit -m "feat: secure free anonymous guest sessions"
```

### Task 4: Passwordless Guest UI Without Functions

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Produces: owner action `copyGuestRunLink(setId)` using `#/guest-play/{shareId}`.
- Produces: `screenGuestPlay(shareId, queryString)` with silent Anonymous Auth.
- Consumes: `store.loadActiveGuestQuizShare(shareId)` and existing guest session allocation.

- [ ] **Step 1: Write failing static and UI behavior tests**

```js
test('free guest route uses anonymous auth without login or callable exchange', () => {
  assert.match(html, /case 'guest-play':\s*screenGuestPlay/);
  assert.match(html, /signInAnonymously/);
  assert.doesNotMatch(html, /exchangeGuestQuizShare/);
  assert.doesNotMatch(extractFunction(html, 'screenGuestPlay'), /requireTeacher|openTeacherAuthDialog/);
});
```

Add owner-only link controls, no `?token=`, invalid/revoked exact Korean message, guest-safe topbar, unique session creation, and old `play` route teacher-guard regressions.

- [ ] **Step 2: Run UI tests and confirm failure**

Run: `node --test --test-name-pattern="free guest route|passwordless guest|비로그인 진행 링크" tests/firestore-store.test.js tests/release-copy.test.js`
Expected: FAIL because the current UI initializes Functions and exchanges a bearer token.

- [ ] **Step 3: Remove Functions exchange and local token storage**

Remove the Functions compat script, `functions` initialization, `ensureGuestCapability`, token hashing, owner localStorage token keys, and `?token=` link generation. Create a 32-byte random share ID, publish its projection, and copy `linkTo('guest-play/' + shareId)`.

- [ ] **Step 4: Implement silent anonymous guest loading**

`screenGuestPlay` validates the exact route, signs out a non-anonymous non-operator session only within the guest flow, calls `signInAnonymously` when needed, loads the active share, and starts existing guest mode. It must never display the teacher login dialog. Preserve browser-loss guidance and class-name input.

- [ ] **Step 5: Run UI and browser-script regressions**

Run: `node --test tests/release-copy.test.js tests/home-layout.test.js tests/firestore-store.test.js`
Expected: PASS with zero failures.

- [ ] **Step 6: Commit the UI**

```powershell
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "feat: run shared quizzes without teacher login"
```

### Task 5: Remove Paid Functions Runtime

**Files:**
- Remove: `functions/index.js`
- Remove: `functions/guest-share-service.js`
- Remove: `functions/package.json`
- Remove: `tests/guest-share-service.test.js`
- Modify: `firebase.json`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Produces: a Firebase configuration containing Firestore Rules/indexes and emulators only.
- Produces: `test:guest` without Functions tests or dependencies.

- [ ] **Step 1: Add a failing no-paid-runtime configuration test**

```js
test('Spark guest release has no Functions deployment surface', () => {
  const firebaseConfig = JSON.parse(read('firebase.json'));
  assert.equal(firebaseConfig.functions, undefined);
  assert.doesNotMatch(read('pnpm-workspace.yaml'), /functions/);
  assert.equal(fs.existsSync(path.join(ROOT, 'functions')), false);
});
```

- [ ] **Step 2: Run the configuration test and confirm failure**

Run: `node --test --test-name-pattern="no Functions deployment surface" tests/release-copy.test.js`
Expected: FAIL because Functions files and configuration still exist.

- [ ] **Step 3: Remove the Functions workspace and regenerate the lockfile mechanically**

Delete only the four tracked Functions/service test files with `apply_patch`, remove `functions` from `firebase.json` and `pnpm-workspace.yaml`, remove `test:guest-functions`, update `test:guest`, then run:

```powershell
$env:CI='true'; pnpm install --lockfile-only
```

Confirm no Firebase Functions/Admin packages remain solely because of the removed workspace; keep root test dependencies already used by other tooling.

- [ ] **Step 4: Run configuration and guest tests**

Run: `node --test tests/release-copy.test.js`
Expected: PASS.

Run: `pnpm test:guest`
Expected: PASS.

- [ ] **Step 5: Commit runtime removal**

```powershell
git add firebase.json package.json pnpm-workspace.yaml pnpm-lock.yaml tests/release-copy.test.js
git add -u functions tests/guest-share-service.test.js
git commit -m "chore: remove paid guest function runtime"
```

### Task 6: Spark Release Gates and Deployment

**Files:**
- Modify: `docs/RELEASE-RUNBOOK.md`
- Modify: `README.md`
- Modify: `tests/release-copy.test.js`
- Test: complete unit/static and Firestore Emulator suites

**Interfaces:**
- Produces: documented `indexes -> Rules -> GitHub Pages` deployment order.
- Produces: two-browser acceptance and rollback evidence without production data migration.

- [ ] **Step 1: Write failing Spark release-copy assertions**

Require the runbook to state Spark plan, Anonymous provider, no Cloud Functions, exact share-link leak model, index readiness before Rules, Rules before static app, two isolated browsers, different class codes, cross-session denial, revoke/reissue, and rollback preserving sessions/responses.

- [ ] **Step 2: Run release-copy tests and confirm failure**

Run: `node --test --test-name-pattern="Spark passwordless guest release" tests/release-copy.test.js`
Expected: FAIL because the current runbook requires Functions first.

- [ ] **Step 3: Update operator documentation**

Replace the paid Functions guest section with Spark-only instructions. Explicitly say the share URL is a bearer capability, must not appear in public screenshots or reports, and must be revoked/reissued after leakage.

- [ ] **Step 4: Run deterministic verification**

Run: `pnpm test:guest`
Expected: PASS.

Run: `pnpm test`
Expected: PASS with zero failures.

Run: `pnpm test:rules`
Expected: PASS with zero failures.

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 5: Run two-browser emulator acceptance**

Open the same `#/guest-play/{shareId}` in two isolated contexts, verify no teacher dialog, start `3학년 1반` and `3학년 2반`, assert different six-character codes, join one student per code, submit different answers, and verify each guest sees only its own class while the operator sees both derived records. Revoke, verify a third context gets the exact unusable-link message, and end the two existing sessions.

- [ ] **Step 6: Commit release gates**

```powershell
git add docs/RELEASE-RUNBOOK.md README.md tests/release-copy.test.js
git commit -m "docs: add Spark guest run release gates"
```

- [ ] **Step 7: Deploy only after verification**

Confirm `video-quiz-65798` explicitly and Anonymous Auth enabled. Deploy indexes and wait for build completion, deploy Firestore Rules, push the tested static commit to GitHub Pages, and verify the deployed `#/guest-play/{shareId}` route. Do not run `firebase deploy --only functions`.
