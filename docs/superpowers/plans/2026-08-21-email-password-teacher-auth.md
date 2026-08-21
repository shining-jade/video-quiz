# Email and Password Teacher Authentication Implementation Plan

> 운영 주의(2026-08-22): 이 문서는 역사적 설계/구현 기록이다. 아래의 개별 rollout·deploy 순서는 폐기되었고, production 전체 순서는 오직 [`docs/RELEASE-RUNBOOK.md`](../../RELEASE-RUNBOOK.md)의 R0~R15를 따른다.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Google teacher login and add verified Firebase email/password signup, login, password reset, and the existing one-time admin approval flow.

**Architecture:** Generalize the provider gate in the pure auth/request cores, then add a focused email-auth UI adapter around Firebase Auth compat APIs. Firestore continues to authorize by verified canonical email plus authoritative UID allowance; no password data enters Firestore.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Firebase Auth compat SDK, Firestore compat SDK, Node test runner, Firestore Emulator.

**Spec:** `docs/superpowers/specs/2026-08-21-email-auth-public-quiz-library-design.md`

## Global Constraints

- Keep Google sign-in and anonymous student join behavior unchanged.
- Require `email_verified == true` and an active authoritative `teacher_allowances/{uid}` document before teacher access.
- A verified email/password user submits exactly one existing teacher approval request.
- Never store, log, return, or expose passwords or password-reset tokens.
- Password reset uses one account-neutral success message: `입력한 이메일을 확인해 주세요.`
- Do not automatically merge Google and password accounts that share an email.
- Minimum password length is 8 characters.
- All auth continuations are bound to the current auth generation and UID.

---

### Task 1: Provider-neutral verified teacher identity

**Files:**
- Modify: `auth-core.js`
- Modify: `teacher-access-request-core.js`
- Test: `tests/auth-core.test.js`
- Test: `tests/teacher-access-request-core.test.js`

**Interfaces:**
- Produces: `AuthCore.isSupportedTeacherSignIn(tokenResult) -> boolean`
- Produces: `TeacherAccessRequestCore.isVerifiedTeacherUser(user) -> boolean`
- Consumes: Firebase token claim `claims.firebase.sign_in_provider`

- [ ] **Step 1: Write failing provider matrix tests**

```js
test('Google and password providers are supported but anonymous and custom providers are rejected', () => {
  assert.equal(AuthCore.isSupportedTeacherSignIn(token('google.com')), true);
  assert.equal(AuthCore.isSupportedTeacherSignIn(token('password')), true);
  assert.equal(AuthCore.isSupportedTeacherSignIn(token('custom')), false);
  assert.equal(AuthCore.isSupportedTeacherSignIn(null), false);
});

test('verified password user builds the same bounded approval request', () => {
  const request = Core.buildRequest(passwordUser(), { organization: '학교', note: '' }, 10);
  assert.equal(request.emailCanonical, 'teacher@example.com');
  assert.equal(request.status, 'pending');
});
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `node --test tests/auth-core.test.js tests/teacher-access-request-core.test.js`

Expected: FAIL because `isSupportedTeacherSignIn` is missing and `buildRequest` rejects a password provider.

- [ ] **Step 3: Implement the minimal provider-neutral predicates**

```js
function isSupportedTeacherSignIn(tokenResult) {
  const firebaseClaims = tokenResult && tokenResult.claims && tokenResult.claims.firebase;
  return !!firebaseClaims && ['google.com', 'password'].includes(firebaseClaims.sign_in_provider);
}

function isVerifiedTeacherUser(user) {
  return !!user && user.isAnonymous !== true && user.emailVerified === true &&
    Array.isArray(user.providerData) && user.providerData.some(provider =>
      provider && ['google.com', 'password'].includes(provider.providerId));
}
```

Keep `isGoogleSignIn` as a compatibility alias used by older tests, but switch new authentication routing to `isSupportedTeacherSignIn`.

- [ ] **Step 4: Run focused tests and observe GREEN**

Run: `node --test tests/auth-core.test.js tests/teacher-access-request-core.test.js`

Expected: all tests pass, including existing Google-only regressions.

- [ ] **Step 5: Commit**

```powershell
git add auth-core.js teacher-access-request-core.js tests/auth-core.test.js tests/teacher-access-request-core.test.js
git commit -m "교사 인증 공급자를 이메일 로그인까지 확장"
```

### Task 2: Pure email-auth validation and safe messages

**Files:**
- Create: `teacher-email-auth-core.js`
- Create: `tests/teacher-email-auth-core.test.js`
- Modify: `index.html` (script include only)
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Produces: `TeacherEmailAuthCore.normalizeSignup(input) -> {displayName,email,password}`
- Produces: `TeacherEmailAuthCore.normalizeLogin(input) -> {email,password}`
- Produces: `TeacherEmailAuthCore.safeAuthMessage(operation, error) -> string`
- Produces: `TeacherEmailAuthCore.RESET_SENT_MESSAGE`

- [ ] **Step 1: Write failing validation and information-leak tests**

```js
test('signup canonicalizes email and requires name and 8 character password', () => {
  assert.deepEqual(Core.normalizeSignup({
    displayName: ' 홍교사 ', email: ' Teacher@Example.COM ', password: '12345678'
  }), { displayName: '홍교사', email: 'teacher@example.com', password: '12345678' });
  assert.throws(() => Core.normalizeSignup({ displayName: '', email: 'a@b.co', password: '12345678' }));
  assert.throws(() => Core.normalizeSignup({ displayName: '교사', email: 'a@b.co', password: '1234567' }));
});

test('password reset never discloses whether an account exists', () => {
  assert.equal(Core.safeAuthMessage('reset', { code: 'auth/user-not-found' }), Core.RESET_SENT_MESSAGE);
  assert.equal(Core.safeAuthMessage('reset', null), Core.RESET_SENT_MESSAGE);
});
```

- [ ] **Step 2: Run test and observe RED**

Run: `node --test tests/teacher-email-auth-core.test.js tests/release-copy.test.js`

Expected: FAIL because the module and browser script include do not exist.

- [ ] **Step 3: Implement the UMD core**

```js
const RESET_SENT_MESSAGE = '입력한 이메일을 확인해 주세요.';
function canonicalEmail(value) { return String(value || '').trim().toLowerCase(); }
function normalizeSignup(input) {
  const displayName = String(input.displayName || '').trim();
  const email = canonicalEmail(input.email);
  const password = String(input.password || '');
  if (!displayName || displayName.length > 80) throw new Error('이름은 1~80자여야 합니다.');
  if (!email.includes('@') || email.length > 254) throw new Error('유효한 이메일을 입력해 주세요.');
  if (password.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.');
  return { displayName, email, password };
}
```

Map popup cancellation, wrong password, throttling, network failure, verification resend, and provider collision to bounded Korean UI messages. Reset always returns `RESET_SENT_MESSAGE` after the Firebase call resolves or returns an account-existence error.

- [ ] **Step 4: Load the module before the application script and run GREEN**

Add `<script src="teacher-email-auth-core.js"></script>` beside `auth-core.js`, then run:

`node --test tests/teacher-email-auth-core.test.js tests/release-copy.test.js`

Expected: all tests pass and every non-module inline script still parses.

- [ ] **Step 5: Commit**

```powershell
git add teacher-email-auth-core.js tests/teacher-email-auth-core.test.js index.html tests/release-copy.test.js
git commit -m "이메일 교사 로그인 입력 검증 추가"
```

### Task 3: Signup, verification, login, and reset UI

**Files:**
- Modify: `index.html`
- Test: `tests/firestore-store.test.js`
- Test: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: `TeacherEmailAuthCore.normalizeSignup`, `normalizeLogin`, `safeAuthMessage`
- Produces: `openTeacherAuthDialog(mode)`
- Produces: `submitTeacherEmailSignup(event)`
- Produces: `submitTeacherEmailLogin(event)`
- Produces: `sendTeacherVerificationEmail()`
- Produces: `confirmTeacherEmailVerification()`
- Produces: `sendTeacherPasswordReset(event)`

- [ ] **Step 1: Add failing deterministic VM/DOM tests**

```js
test('email signup creates the user, updates the profile, sends verification, and does not show request UI yet', async () => {
  const result = await runtime.submitSignup('홍교사', 'teacher@example.com', '12345678');
  assert.deepEqual(calls, ['create', 'profile:홍교사', 'verify']);
  assert.equal(result.status, 'verification-sent');
  assert.equal(runtime.teacherRequestRendered, false);
});

test('verification confirmation reloads and force-refreshes the token before applying the user', async () => {
  await runtime.confirmVerification();
  assert.deepEqual(calls, ['reload', 'token:true', 'apply']);
});
```

Also assert reset returns the same text for success and `auth/user-not-found`, provider collision never creates an allowance, closing the dialog clears all password input values, and auth-generation change prevents stale rendering.

- [ ] **Step 2: Run tests and observe RED**

Run: `node --test tests/firestore-store.test.js tests/release-copy.test.js`

Expected: FAIL on missing handlers and old Google-only auth markup.

- [ ] **Step 3: Implement Firebase Auth compat calls**

```js
const credential = await firebase.auth().createUserWithEmailAndPassword(email, password);
await credential.user.updateProfile({ displayName });
await credential.user.sendEmailVerification();

const login = await firebase.auth().signInWithEmailAndPassword(email, password);
await applyTeacherUser(login.user);

await firebase.auth().sendPasswordResetEmail(email);

await firebase.auth().currentUser.reload();
await firebase.auth().currentUser.getIdToken(true);
await applyTeacherUser(firebase.auth().currentUser);
```

Render Google and email choices in one accessible dialog. After signup, replace the password form with verification instructions and resend/confirm buttons. Clear password fields on every success, close, route change, sign-out, and auth-generation change.

- [ ] **Step 4: Generalize routing without weakening authorization**

Change `applyTeacherUser` to use `AuthCore.isSupportedTeacherSignIn(tokenResult)`. Update `teacherAuthMessage`, request identity copy, collaborator placeholder, admin copy, and home copy to say `교사 계정` or `이메일` rather than requiring Google. Keep `teacherStateFromAllowance` and server allowance rechecks unchanged.

- [ ] **Step 5: Run focused and full Node tests**

Run:

```powershell
node --test tests/auth-core.test.js tests/teacher-access-request-core.test.js tests/teacher-email-auth-core.test.js tests/firestore-store.test.js tests/release-copy.test.js
pnpm test
```

Expected: focused and full suites pass with zero failures.

- [ ] **Step 6: Commit**

```powershell
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "이메일 가입 인증과 비밀번호 재설정 UI 구현"
```

### Task 4: Firestore provider parity and security matrix

**Files:**
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: token claims `email`, `email_verified`, `firebase.sign_in_provider`
- Produces: Rules predicate `supportedTeacherProvider()`
- Preserves: authoritative allowance UID/canonical-email/status/role checks

- [ ] **Step 1: Write failing Emulator provider tests**

```js
rulesTest('verified password teacher follows the same allowance matrix as Google', async () => {
  const passwordTeacher = actorFirestore('owner-password', {
    email: 'owner@school.kr', email_verified: true,
    firebase: { sign_in_provider: 'password' }
  });
  await assertSucceeds(getDoc(doc(passwordTeacher, 'quiz_sets/set1')));
});

rulesTest('unverified password, custom provider, and mismatched allowance remain denied', async () => {
  await assertFails(getDoc(doc(unverifiedPassword, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(customProvider, 'quiz_sets/set1')));
  await assertFails(getDoc(doc(wrongUidPassword, 'quiz_sets/set1')));
});
```

- [ ] **Step 2: Run focused Emulator test and observe RED**

Run: `firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-name-pattern='password teacher|unverified password' tests/firestore-rules.test.js"`

Expected: verified password teacher is denied by the current Google-only provider predicate.

- [ ] **Step 3: Implement exact provider predicate**

```rules
function supportedTeacherProvider() {
  return request.auth.token.firebase.sign_in_provider in ['google.com', 'password'];
}

function verifiedEmail() {
  return request.auth != null && request.auth.token.email is string &&
    request.auth.token.email_verified == true && supportedTeacherProvider();
}
```

Retain all existing canonical email, UID allowance, migration completion, status, role, and admin checks. Do not allow `custom`, `anonymous`, `phone`, or missing provider claims.

- [ ] **Step 4: Run focused and full Emulator suites**

Run:

```powershell
pnpm test:rules
```

Expected: all Rules/Admin Emulator tests pass with zero failures and no expression-budget regression.

- [ ] **Step 5: Commit**

```powershell
git add firestore.rules tests/firestore-rules.test.js
git commit -m "이메일 인증 교사에 동일한 Firestore 권한 적용"
```

### Task 5: Configuration, documentation, acceptance, and release gate

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF.md`
- Create: `docs/EMAIL-TEACHER-AUTH.md`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Documents: Firebase Console Email/Password provider enablement and authorized domains
- Documents: email template, reset flow, rollback, and privacy checks

- [ ] **Step 1: Add failing release-contract tests**

```js
test('release docs require Email/Password provider, verification template, reset template, and rollback', () => {
  for (const marker of ['Email/Password', '이메일 인증', '비밀번호 재설정', '승인된 도메인', '롤백']) {
    assert.match(emailAuthDocs, new RegExp(marker));
  }
});
```

- [ ] **Step 2: Run test and observe RED**

Run: `node --test tests/release-copy.test.js`

Expected: FAIL because `docs/EMAIL-TEACHER-AUTH.md` and its required markers are absent.

- [ ] **Step 3: Write exact operator procedure**

Document:

1. enable Firebase Authentication Email/Password without disabling Google or Anonymous;
2. verify authorized domains include the GitHub Pages hostname;
3. configure Korean verification and password-reset templates;
4. run Node and Emulator suites;
5. deploy compatibility Rules, then static app;
6. test Google admin and a new password teacher through approval;
7. rollback app/Rules while leaving Firebase users and allowances intact if acceptance fails.

- [ ] **Step 4: Run full verification**

Run:

```powershell
pnpm test
pnpm test:rules
node --check teacher-email-auth-core.js
git diff --check
```

Expected: every command exits 0 and both suites report zero failures.

- [ ] **Step 5: Perform browser acceptance before production deploy**

Use one existing Google admin and one fresh email address:

1. signup and verify email;
2. submit one teacher request;
3. approve from admin UI;
4. login and enter protected teacher home;
5. request password reset and login with the new password;
6. verify student anonymous join and Google login still work;
7. confirm same-email provider collision does not duplicate allowance;
8. confirm same-tab app/Firebase-origin console errors are zero.

- [ ] **Step 6: Commit**

```powershell
git add README.md HANDOFF.md docs/EMAIL-TEACHER-AUTH.md tests/release-copy.test.js
git commit -m "이메일 교사 인증 운영 절차 문서화"
```
