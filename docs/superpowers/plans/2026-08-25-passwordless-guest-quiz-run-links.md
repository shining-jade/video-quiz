# Passwordless Guest Quiz Run Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone holding an owner-issued guest-run link start an isolated quiz session without visible login, while keeping private quiz sets and other guest sessions inaccessible.

**Architecture:** Owners publish a revisioned allow-list projection under `guest_quiz_shares`; a callable Firebase Function validates the bearer secret and issues a short-lived custom token with share claims. Firestore Rules authorize only that claimed projection and bind each new session to the guest UID, while existing session allocation, student, response, grading, and dashboard paths remain the isolation boundary.

**Tech Stack:** Static HTML/JavaScript, Firebase compat SDK 10.12.0, Firebase Authentication, Cloud Functions for Firebase v2, Cloud Firestore, Firestore Security Rules, Node.js test runner, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-08-25-passwordless-guest-quiz-run-links-design.md`

## Global Constraints

- The guest teacher sees no account form, login prompt, approval flow, or share password.
- Existing `#/play/{setId}` links stay approved-teacher-only; only `#/guest-play/{shareId}?token={secret}` enables guest runs.
- Never relax private `quiz_sets` read rules for anonymous users.
- Store only a SHA-256 token hash; never store or log the bearer token.
- A guest can control and inspect only sessions whose `teacherUid` equals that guest UID.
- Every run receives a new session ID and six-character class code; `sourceShareId` is provenance, never an isolation key.
- New sessions pin the current share revision; existing live sessions do not change when the source set changes or the share is revoked.
- Revocation blocks preview refresh and new sessions, but an already-live owned session can be safely ended.
- Projection code uses an explicit allow list and rejects unknown or privacy-sensitive fields.
- Do not stage or overwrite unrelated existing workspace changes.

## File Structure

- Create `guest-quiz-share-core.js`: environment-neutral token, projection, route, lifecycle, and claim validation helpers.
- Create `functions/package.json`: isolated Cloud Functions runtime dependencies and test command.
- Create `functions/index.js`: deployable `exchangeGuestQuizShare` callable wrapper.
- Create `functions/guest-share-service.js`: dependency-injected server token-exchange service.
- Create `tests/guest-quiz-share-core.test.js`: core projection, token, route, and lifecycle unit tests.
- Create `tests/guest-share-service.test.js`: callable service validation and custom-token claim tests.
- Modify `firebase.json`: register Functions source and Auth/Functions emulators without changing Firestore settings.
- Modify `index.html`: load Functions SDK/core, add guest route, owner share controls, guest preview, guest session state, and guest-safe navigation.
- Modify `firestore-store.js`: owner share lifecycle, revision publication/read, guest session allocation, owner-derived-session queries.
- Modify `firestore.rules`: share projection, claimed guest, session provenance, owner/admin visibility, and revocation rules.
- Modify `firestore.indexes.json`: exact owner/source session query index if emulator/query verification requires it.
- Modify `tests/firestore-store.test.js`: store/UI contracts and guest allocation behavior.
- Modify `tests/firestore-rules.test.js`: emulator authorization matrix.
- Modify `tests/release-copy.test.js`: script order, route guard, labels, and private-route regression.
- Modify `docs/RELEASE-RUNBOOK.md`: Functions/Rules/static deployment order and rollback gates.

---

### Task 1: Guest Share Core Contract

**Files:**
- Create: `guest-quiz-share-core.js`
- Create: `tests/guest-quiz-share-core.test.js`

**Interfaces:**
- Produces: `randomToken(byteLength, cryptoApi) -> string`
- Produces: `sha256Hex(value, cryptoApi) -> Promise<string>`
- Produces: `projectQuizSet(set, images) -> { parent, videos, questions, images }`
- Produces: `parseGuestRoute(shareId, query) -> { shareId, token } | { invalid: true }`
- Produces: `guestClaimsValid(claims, shareId, revision, nowSeconds) -> boolean`
- Produces: `nextShareState(current, action, nowValue) -> object`

- [ ] **Step 1: Write failing core tests**

```js
test('projection allow-lists run data and excludes private ownership', () => {
  const output = Core.projectQuizSet({
    id: 'set-1', title: '심폐소생술', ownerUid: 'owner', ownerEmail: 'owner@school.kr',
    settings: { revealMode: 'timer', limitSec: 20, autoPause: true },
    videos: [{ id: 'v1', url: 'https://youtu.be/abc', startSec: 0, endSec: 90,
      questions: [{ type: 'mc', t: 12, text: '문제', choices: ['A', 'B'], answer: 1 }] }]
  }, {});
  assert.equal(output.parent.title, '심폐소생술');
  assert.equal(output.questions[0].answer, 1);
  assert.equal(JSON.stringify(output).includes('owner@school.kr'), false);
  assert.equal(Object.hasOwn(output.parent, 'ownerUid'), false);
});

test('guest claims expire and bind exact share revision', () => {
  const claims = { guestShareId: 'share-a', guestShareRevision: 4, guestCapabilityExpiresAt: 200 };
  assert.equal(Core.guestClaimsValid(claims, 'share-a', 4, 199), true);
  assert.equal(Core.guestClaimsValid(claims, 'share-a', 3, 199), false);
  assert.equal(Core.guestClaimsValid(claims, 'share-a', 4, 200), false);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test tests/guest-quiz-share-core.test.js`
Expected: FAIL because `guest-quiz-share-core.js` does not exist.

- [ ] **Step 3: Implement the UMD core with frozen allow-list projections**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuestQuizShareCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const encoder = new TextEncoder();
  function guestClaimsValid(c, id, revision, now) {
    return !!c && c.guestShareId === id && c.guestShareRevision === revision &&
      Number.isSafeInteger(c.guestCapabilityExpiresAt) && c.guestCapabilityExpiresAt > now;
  }
  return Object.freeze({ randomToken, sha256Hex, projectQuizSet, parseGuestRoute,
    guestClaimsValid, nextShareState });
});
```

Implement each exported function with exact length/type bounds, `crypto.getRandomValues`, SHA-256, playlist normalization-compatible keys, and deep-frozen output. Reject malformed sets, unsupported question types, oversized strings/arrays, and unknown lifecycle actions.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/guest-quiz-share-core.test.js`
Expected: PASS, including privacy, malformed input, token entropy/encoding, route bounds, claim expiry, create/revoke/reissue transitions.

- [ ] **Step 5: Commit the core**

```powershell
git add guest-quiz-share-core.js tests/guest-quiz-share-core.test.js
git commit -m "feat: add guest quiz share core"
```

### Task 2: Server-Side Bearer Exchange

**Files:**
- Create: `functions/package.json`
- Create: `functions/guest-share-service.js`
- Create: `functions/index.js`
- Create: `tests/guest-share-service.test.js`
- Modify: `firebase.json`

**Interfaces:**
- Consumes: `sha256Hex(token)` contract from Task 1, duplicated server-side with Node `crypto` to avoid browser globals.
- Produces: `createGuestShareExchange({ db, auth, clock, hashToken }) -> async ({ auth, data }) => { customToken, shareId, revision, expiresAt }`
- Produces: callable Function `exchangeGuestQuizShare({ shareId, token })`.

- [ ] **Step 1: Write failing service tests with fake Firestore and Auth adapters**

```js
test('exchange binds a short-lived share capability to the anonymous caller uid', async () => {
  const service = createGuestShareExchange(fakeDeps({
    share: { status: 'active', tokenHash: hash('secret'), revision: 7 }
  }));
  const result = await service({
    auth: { uid: 'anon-a', token: { firebase: { sign_in_provider: 'anonymous' } } },
    data: { shareId: 'share-a', token: 'secret' }
  });
  assert.equal(result.shareId, 'share-a');
  assert.equal(result.revision, 7);
  assert.deepEqual(customTokenCalls[0].claims, {
    guestShareId: 'share-a', guestShareRevision: 7, guestCapabilityExpiresAt: now + 900
  });
});
```

Add rejection tests for missing auth, non-anonymous provider, malformed IDs/tokens, wrong token, revoked share, missing revision, disabled source owner, rate-limit exhaustion, and errors that redact token/hash/document paths.

- [ ] **Step 2: Run the service tests and confirm failure**

Run: `node --test tests/guest-share-service.test.js`
Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement the dependency-injected service and callable wrapper**

`functions/package.json` must use Node 20 and pin compatible `firebase-admin` and `firebase-functions` dependencies. `functions/index.js` initializes Admin once and exports a v2 `onCall` function in the deployment region. The service transaction reads the fixed share path, constant-time compares SHA-256 hashes, verifies `active` status/current revision/source lifecycle, enforces App Check when production configuration enables it, and creates a token for the caller's existing anonymous UID with a 900-second claim expiry.

- [ ] **Step 4: Register Functions and emulators**

```json
{
  "functions": { "source": "functions", "runtime": "nodejs20" },
  "emulators": {
    "auth": { "host": "127.0.0.1", "port": 9099 },
    "functions": { "host": "127.0.0.1", "port": 5001 },
    "firestore": { "host": "127.0.0.1", "port": 8080 },
    "singleProjectMode": true
  }
}
```

- [ ] **Step 5: Run server and configuration tests**

Run: `node --test tests/guest-share-service.test.js`
Expected: PASS with no raw secret in captured logs or errors.

Run: `node -e "JSON.parse(require('fs').readFileSync('firebase.json','utf8')); JSON.parse(require('fs').readFileSync('functions/package.json','utf8'))"`
Expected: exit 0.

- [ ] **Step 6: Commit the server boundary**

```powershell
git add functions/package.json functions/guest-share-service.js functions/index.js tests/guest-share-service.test.js firebase.json
git commit -m "feat: add guest share token exchange"
```

### Task 3: Owner Share Publication Store

**Files:**
- Modify: `firestore-store.js`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `GuestQuizShareCore.projectQuizSet(set, images)` and token/hash values supplied by the owner UI.
- Produces: `createGuestQuizShare(setId, tokenHash, projection, actor) -> { shareId, revision, status }`
- Produces: `getOwnedGuestQuizShare(setId, actor) -> share | null`
- Produces: `refreshGuestQuizShare(setId, projection, actor) -> share`
- Produces: `revokeGuestQuizShare(setId, actor) -> { shareId, status: 'revoked' }`
- Produces: `listOwnedDerivedSessions(setId, actor) -> Session[]`

- [ ] **Step 1: Add failing store tests**

```js
test('owner publication writes a complete revision before activating the share', async () => {
  const store = createFirestoreStore(fake.firebase, fake.fieldValue);
  const result = await store.createGuestQuizShare('set-1', 'a'.repeat(64), projection, owner);
  assert.equal(result.status, 'active');
  assert.equal(fake.value(`guest_quiz_shares/${result.shareId}`).revision, 1);
  assert.equal(fake.value(`guest_quiz_shares/${result.shareId}/revisions/1`).status, 'ready');
});
```

Cover exact ownership, active lifecycle, stale source revision, partial write cleanup/fail-closed behavior, idempotent re-copy, revision refresh ordering, revoke, never-reactivate-on-reissue, and derived-session exact-owner filtering.

- [ ] **Step 2: Run focused store tests and confirm failure**

Run: `node --test --test-name-pattern="guest quiz share|derived guest session" tests/firestore-store.test.js`
Expected: FAIL because methods are missing.

- [ ] **Step 3: Implement publication lifecycle in the existing store factory**

Use deterministic bounded batches for videos/questions/images, a `building` parent state, a ready revision marker, and a final transaction that re-reads the source owner/lifecycle/content revision before switching the parent to `active`. Store `sourceSetId`, `sourceOwnerUid`, `tokenHash`, revision, counts, timestamps, and no token plaintext. Reuse the public-library publication pattern where its race and cleanup protections apply.

- [ ] **Step 4: Run focused and full store tests**

Run: `node --test --test-name-pattern="guest quiz share|derived guest session" tests/firestore-store.test.js`
Expected: PASS.

Run: `node --test tests/firestore-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit owner publication storage**

```powershell
git add firestore-store.js tests/firestore-store.test.js
git commit -m "feat: publish guest run share revisions"
```

### Task 4: Firestore Guest Capability and Session Rules

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`
- Modify: `firestore.indexes.json`

**Interfaces:**
- Consumes custom claims: `guestShareId: string`, `guestShareRevision: int`, `guestCapabilityExpiresAt: int`.
- Consumes session fields: `sessionActorType`, `sourceShareId`, `sourceSetId`, `sourceRevision`, `sourceOwnerUid`.
- Produces authorization for projection reads, guest session create/control, source-owner/admin reads, and revoked-live safe end.

- [ ] **Step 1: Add failing emulator authorization tests**

```js
const guest = testEnvironment.authenticatedContext('anon-a', {
  firebase: { sign_in_provider: 'custom' }, guestShareId: 'share-a',
  guestShareRevision: 2, guestCapabilityExpiresAt: Math.floor(Date.now() / 1000) + 600
}).firestore();
await assertSucceeds(getDoc(doc(guest, 'guest_quiz_shares/share-a/revisions/2')));
await assertFails(getDoc(doc(guest, 'guest_quiz_shares/share-b/revisions/2')));
await assertFails(getDoc(doc(guest, 'quiz_sets/set-1')));
```

Add create/update/read tests for exact guest UID, other guest denial, student denial, stale/expired claim denial, revoked share new-session denial, revoked live owned-session safe end, owner/admin derived-session read, non-owner teacher denial, immutable provenance, and collection query constraints.

- [ ] **Step 2: Run Rules tests and confirm failure**

Run: `pnpm test:rules`
Expected: new guest tests FAIL against current Rules.

- [ ] **Step 3: Implement narrowly scoped Rules helpers and matches**

Add `isGuestCapability(shareId, revision)`, `guestOwnsSession`, `sourceOwnerReadsGuestSession`, strict field allow lists, ready-revision checks, immutable provenance, exact query-safe owner fields, and a server-time expiry comparison. Keep existing teacher/student/session-counter invariants intact.

- [ ] **Step 4: Add only the required composite index**

If `listOwnedDerivedSessions` queries `sourceOwnerUid + sourceSetId + createdAt`, add exactly that collection index with `sourceOwnerUid ASC`, `sourceSetId ASC`, `createdAt DESC`, `__name__ DESC`.

- [ ] **Step 5: Run Rules and index tests**

Run: `pnpm test:rules`
Expected: PASS.

Run: `node --test tests/firestore-indexes.test.js`
Expected: PASS and no unused speculative index.

- [ ] **Step 6: Commit security rules**

```powershell
git add firestore.rules firestore.indexes.json tests/firestore-rules.test.js
git commit -m "feat: secure guest quiz sessions"
```

### Task 5: Guest Session Store Allocation

**Files:**
- Modify: `firestore-store.js`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Produces: `loadGuestQuizRevision(shareId, revision) -> QuizSet`
- Produces: `prepareGuestSession(set, label, guestContext) -> PendingSession`
- Reuses: `activateSessionAllocation`, `renewSessionActivationLease`, `abortSessionAllocation`, student/response/grading APIs.

- [ ] **Step 1: Write failing allocation tests**

```js
test('guest allocation pins provenance and creates a unique ordinary session', async () => {
  const pending = await store.prepareGuestSession(projectedSet, '3학년 2반', {
    uid: 'anon-a', shareId: 'share-a', revision: 4, sourceSetId: 'set-1', sourceOwnerUid: 'owner'
  });
  assert.equal(pending.value.teacherUid, 'anon-a');
  assert.equal(pending.value.sessionActorType, 'guest');
  assert.equal(pending.value.sourceRevision, 4);
});
```

Test two guests against one share, double-click recovery, allocation collision, refresh attachment, revoked-before-activation failure, and no access to the other guest's pending/live session.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test --test-name-pattern="guest allocation|guest revision" tests/firestore-store.test.js`
Expected: FAIL because guest APIs are missing.

- [ ] **Step 3: Implement guest adapters around the existing allocation state machine**

Normalize the revision projection into the existing playlist shape, preserve `pl` expectations, pass guest provenance into session creation, and use the same code reservation/heartbeat/abort implementation. Do not fork student, response, grading, or code-allocation storage.

- [ ] **Step 4: Run focused and session regression tests**

Run: `node --test --test-name-pattern="guest allocation|guest revision|session allocation|heartbeat|student response|grading" tests/firestore-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit guest allocation**

```powershell
git add firestore-store.js tests/firestore-store.test.js
git commit -m "feat: allocate isolated guest quiz sessions"
```

### Task 6: Owner UI and Passwordless Guest Route

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes `GuestQuizShareCore`, `firebase.functions()`, and store APIs from Tasks 3 and 5.
- Produces route `guest-play`, owner actions `copyGuestRunLink(setId)`, `revokeGuestRunLink(setId)`, guest screens `screenGuestPlay(shareId, route)`, `startGuestSession()`.

- [ ] **Step 1: Write failing static/UI contract tests**

```js
test('guest route bypasses teacher dialog but requires a validated bearer exchange', () => {
  assert.match(html, /case 'guest-play':\s*screenGuestPlay/);
  assert.doesNotMatch(extractCase(html, 'guest-play'), /requireTeacher/);
  assert.match(html, /exchangeGuestQuizShare/);
  assert.match(html, /비로그인 진행 링크/);
});
```

Add tests that the old `play` route still calls `requireTeacher`, owner-only link revoke is present, collaborator/non-owner rows do not manage guest links, guest topbar omits edit/admin controls, invalid/revoked copy is exact, and student join links remain `#/join/{code}`.

- [ ] **Step 2: Run UI contract tests and confirm failure**

Run: `node --test --test-name-pattern="guest route|비로그인 진행 링크|guest topbar" tests/firestore-store.test.js tests/release-copy.test.js`
Expected: FAIL because guest UI does not exist.

- [ ] **Step 3: Load dependencies in safe order**

Add `firebase-functions-compat.js` after Auth and before application code; load `guest-quiz-share-core.js` after playlist normalization and before `firestore-store.js`. Initialize `const functions = firebase.functions()` and connect to the local Functions emulator only under the existing localhost/emulator gate.

- [ ] **Step 4: Implement owner controls**

Replace the ambiguous `🔗 링크` with `🔗 비로그인 진행 링크` for exact owners. Generate 32 random bytes, hash locally, publish the share, copy the bearer URL, and retain the plaintext only in owner-device local storage under a key containing the exact owner UID and share ID so the same device can copy the same link again. Remove that local value on revoke, sign-out, or owner mismatch. Firestore, logs, reports, and analytics never receive plaintext. If another owner device sees an active share but has no local plaintext, show `새 링크 발급` rather than pretending the old token can be recovered. Require confirmation before revoke/reissue.

- [ ] **Step 5: Implement guest preview and token exchange**

Parse and bound the route, ensure anonymous auth, call `exchangeGuestQuizShare`, reauthenticate with `signInWithCustomToken`, force-refresh ID token, verify exact claims locally, load the claimed revision, then render title/counts/settings/questions, optional class name, the browser-loss notice, and `우리 반 시작하기`. Render the exact unusable-link message for invalid, revoked, expired, or wrong tokens and never open the teacher dialog.

- [ ] **Step 6: Reuse the player with an explicit guest mode**

Set `pl.actorType = 'guest'`, remove edit/set-list/admin links, keep fullscreen/QR/question/grading/dashboard actions, use guest allocation, and persist only the owned pending/live session ID in browser storage for refresh recovery. Clear bearer token from visible UI and error logs; keep it in the hash route only as required for reopening the share.

- [ ] **Step 7: Run UI and full static tests**

Run: `node --test --test-name-pattern="guest route|비로그인 진행 링크|guest topbar|우리 반 시작하기" tests/firestore-store.test.js tests/release-copy.test.js`
Expected: PASS.

Run: `node --test tests/release-copy.test.js tests/home-layout.test.js`
Expected: PASS.

- [ ] **Step 8: Commit the UI**

```powershell
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "feat: add passwordless guest quiz runner"
```

### Task 7: Derived Session Owner Dashboard and Revocation Edge Cases

**Files:**
- Modify: `index.html`
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes `listOwnedDerivedSessions(setId, actor)`.
- Produces owner UI `openGuestRunHistory(setId)` and guest-safe `endSession` authorization.

- [ ] **Step 1: Write failing owner/history and revoke-race tests**

Test that the source owner sees sessions from two guest UIDs grouped by class code, cannot mutate live guest playback, can read responses/grades, and that revoke racing session activation allows exactly one of “activation completes from active revision” or “activation fails and reservation aborts.” Test a revoked live session can only transition to ended with immutable content/provenance.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test --test-name-pattern="guest run history|revoked guest session" tests/firestore-store.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement owner history and exact safe-end behavior**

Add an owner-only `실행 기록` action beside the guest link status. Reuse existing per-session dashboard rendering in read-only mode and clearly label class code, class name, started time, status, participants, and source revision. Rules allow the guest owner to end a live session after revoke but prohibit question/reveal/provenance changes.

- [ ] **Step 4: Run focused Rules/store/UI tests**

Run: `pnpm test:rules`
Expected: PASS.

Run: `node --test --test-name-pattern="guest run history|revoked guest session" tests/firestore-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit history and lifecycle edges**

```powershell
git add index.html firestore-store.js firestore.rules tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "feat: add guest run history and safe revocation"
```

### Task 8: Release Gates, Browser Acceptance, and Full Verification

**Files:**
- Modify: `docs/RELEASE-RUNBOOK.md`
- Modify: `package.json`
- Test: all test suites and emulator acceptance paths

**Interfaces:**
- Produces release scripts `test:guest-functions` and `test:guest`.
- Produces a documented Functions → Rules/indexes → static deployment and rollback sequence.

- [ ] **Step 1: Add failing release-copy assertions**

Require the runbook to contain: anonymous provider prerequisite, callable region/name, App Check decision, Functions deployment before Rules/static activation, Rules emulator gate, two-browser concurrency acceptance, secret-redaction check, revoke/reissue check, and rollback that disables new share creation without deleting sessions/responses.

- [ ] **Step 2: Run the release-copy test and confirm failure**

Run: `node --test --test-name-pattern="guest run release" tests/release-copy.test.js`
Expected: FAIL because the runbook section is absent.

- [ ] **Step 3: Add exact verification scripts and release instructions**

```json
{
  "test:guest-functions": "node --test tests/guest-share-service.test.js",
  "test:guest": "node --test tests/guest-quiz-share-core.test.js tests/guest-share-service.test.js tests/firestore-store.test.js tests/release-copy.test.js"
}
```

Document preflight, deploy, same-generation verification, rollback, and the requirement that production secrets never appear in screenshots, reports, shell history, or durable test artifacts.

- [ ] **Step 4: Run deterministic unit/static verification**

Run: `pnpm test:guest-functions`
Expected: PASS.

Run: `pnpm test:guest`
Expected: PASS.

Run: `pnpm test`
Expected: PASS with zero failures.

- [ ] **Step 5: Run emulator verification**

Run: `pnpm test:rules`
Expected: PASS with zero failures.

- [ ] **Step 6: Run two-browser acceptance against emulators**

Use two isolated browser contexts. In each, open the same owner-generated guest link, verify no teacher dialog appears, start classes named `3학년 1반` and `3학년 2반`, assert different six-character codes, join one student per code, submit different answers, and verify each dashboard contains only its own student/response. Revoke the link, assert a third context receives the unusable-link message, then end both existing sessions successfully.

- [ ] **Step 7: Inspect changes and secret leakage**

Run: `git diff --check`
Expected: no whitespace errors.

Run: `rg -n "token=|guestCapability|tokenHash" . -g '!node_modules' -g '!.pnpm-store' -g '!docs/superpowers/**'`
Expected: only intentional code/test identifiers and synthetic fixtures; no real bearer token or production hash.

- [ ] **Step 8: Commit release gates**

```powershell
git add package.json docs/RELEASE-RUNBOOK.md tests/release-copy.test.js
git commit -m "docs: add guest run release gates"
```

- [ ] **Step 9: Record final verification evidence**

Run: `git status --short`
Expected: only unrelated pre-existing user files remain; all guest-run implementation files are committed.
