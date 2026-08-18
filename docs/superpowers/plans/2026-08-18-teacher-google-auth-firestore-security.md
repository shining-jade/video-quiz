# Teacher Google Auth and Firestore Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 교사만 Google 계정으로 교사 데이터에 접근하고, 학생은 기존 반 코드 흐름을 유지하면서 자기 문서와 공개된 현재 문항만 접근하게 한다.

**Architecture:** 인증·역할 판정은 새 UMD 모듈 `auth-core.js`에 격리하고, Firestore 규칙은 비공개 `teacher_allowlist`와 문서 소유권을 기준으로 기본 거부한다. 학생은 원본 세트 대신 세션의 안전한 `meta/live.publicQuestion`을 읽으며, 기존 데이터는 승인된 `legacy_owner`가 멱등 이전한 뒤 엄격한 규칙으로 전환한다.

**Tech Stack:** 정적 HTML/CSS/JavaScript, Firebase Authentication/Firestore compat SDK 10.12.0, Firestore Security Rules, Firebase Emulator Suite, Node.js test runner

**Spec:** `docs/superpowers/specs/2026-08-18-teacher-google-auth-firestore-security-design.md`

## Global Constraints

- 교사는 Firebase Google 로그인과 비공개 승인 목록을 모두 통과해야 한다.
- 학생은 Google 로그인을 요구하지 않고 기존 6자리 반 코드로 입장한다.
- 승인 목록은 클라이언트에서 읽기·쓰기·목록 조회가 모두 금지된다.
- 일반 교사는 자기 세트와 자기 세션만 수정·조회하고, `admin`만 전체 세션을 조회한다.
- 학생은 자기 UID가 결합된 학생·응답 문서만 읽고 쓴다.
- 학생은 정답 공개 전 원본 세트·정답·해설·비공개 이미지를 읽지 않는다.
- 새 `snapshotVersion: 1` 세션은 스냅샷 누락 시 현재 세트로 fallback하지 않는다.
- 기존 로그인 없는 학생 화면, 영상 2개 재생, 전체화면, 퀴즈 타임라인 동작을 보존한다.
- 규칙과 사이트는 Emulator 권한 테스트와 실제 브라우저 수용 검증을 통과한 뒤에만 배포한다.

---

### Task 1: 교사 인증 상태와 Google 로그인 UI

**Files:**
- Create: `auth-core.js`
- Create: `tests/auth-core.test.js`
- Modify: `index.html`

**Interfaces:**
- Produces: `AuthCore.teacherState(user, allowance) -> { status, uid, email, role }`
- Produces: `AuthCore.isTeacher(state) -> boolean`
- Produces: `AuthCore.isAdmin(state) -> boolean`
- Produces: `signInTeacher()`, `signOutTeacher()`, `requireTeacher(next)`
- Consumes: Firebase Auth `GoogleAuthProvider`, `signInWithPopup`, `onAuthStateChanged`

- [ ] **Step 1: 인증 상태 실패 테스트 작성**

```js
test('검증된 Google 계정과 활성 승인 문서가 있어야 교사다', () => {
  assert.equal(core.teacherState(null, null).status, 'signed-out');
  assert.equal(core.teacherState({ uid: 'u1', email: 'a@school.kr', emailVerified: true, isAnonymous: false }, null).status, 'unapproved');
  assert.deepEqual(core.teacherState(
    { uid: 'u1', email: 'a@school.kr', emailVerified: true, isAnonymous: false },
    { enabled: true, role: 'teacher' }
  ), { status: 'teacher', uid: 'u1', email: 'a@school.kr', role: 'teacher' });
});

test('익명 계정과 이메일 미검증 계정은 교사가 아니다', () => {
  assert.equal(core.isTeacher(core.teacherState({ uid: 's', isAnonymous: true }, { enabled: true, role: 'admin' })), false);
  assert.equal(core.isTeacher(core.teacherState({ uid: 'u', email: 'x@y', emailVerified: false }, { enabled: true, role: 'teacher' })), false);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/auth-core.test.js`
Expected: FAIL with `Cannot find module '../auth-core'`

- [ ] **Step 3: 순수 UMD 인증 모듈 구현**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuthCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function teacherState(user, allowance) {
    if (!user || user.isAnonymous) return { status: 'signed-out', uid: '', email: '', role: '' };
    if (!user.emailVerified) return { status: 'unverified', uid: user.uid, email: user.email || '', role: '' };
    if (!allowance || allowance.enabled !== true) return { status: 'unapproved', uid: user.uid, email: user.email || '', role: '' };
    const role = allowance.role === 'admin' ? 'admin' : 'teacher';
    return { status: role, uid: user.uid, email: user.email || '', role };
  }
  const isTeacher = state => !!state && (state.role === 'teacher' || state.role === 'admin');
  const isAdmin = state => !!state && state.role === 'admin';
  return { teacherState, isTeacher, isAdmin };
});
```

- [ ] **Step 4: 교사 로그인 UI와 학생 익명 인증 분리**

`index.html`에서 앱 시작 즉시 익명 로그인하지 않는다. 학생 참여 경로에서만 `ensureAnonymousStudent()`를 호출한다. 교사 메뉴는 `requireTeacher()`가 Google 팝업과 승인 확인을 수행한 뒤 기존 화면 함수를 실행한다. 우측 상단에는 이름·이메일·로그아웃을 렌더링한다.

- [ ] **Step 5: UI 흐름 테스트와 전체 테스트**

```js
test('학생 참여는 Google 교사 로그인을 요구하지 않는다', () => {
  const html = readIndex();
  assert.match(html, /function ensureAnonymousStudent/);
  assert.match(html, /function requireTeacher/);
  assert.doesNotMatch(extractFunction(html, 'screenJoin'), /signInWithPopup/);
});
```

Run: `node --test tests/auth-core.test.js tests/*.test.js`
Expected: all PASS

- [ ] **Step 6: 커밋**

```bash
git add auth-core.js index.html tests/auth-core.test.js tests/firestore-store.test.js
git commit -m "승인 교사 Google 로그인 흐름을 추가"
```

---

### Task 2: Firestore Emulator와 기본 거부 보안 규칙

**Files:**
- Create: `package.json`
- Create: `firebase.json`
- Create: `.firebaserc`
- Create: `tests/firestore-rules.test.js`
- Modify: `firestore.rules`

**Interfaces:**
- Consumes: Firebase Auth token fields `uid`, `email`, `email_verified`, `firebase.sign_in_provider`
- Produces rules helpers: `isApprovedTeacher()`, `isAdmin()`, `ownsSet()`, `ownsSession()`, `isJoinedStudent()`

- [ ] **Step 1: Emulator 의존성과 명령 정의**

```json
{
  "private": true,
  "scripts": {
    "test": "node --test tests/*.test.js",
    "test:rules": "firebase emulators:exec --only firestore --project demo-video-quiz \"node --test tests/firestore-rules.test.js\""
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "firebase": "^10.12.0",
    "firebase-tools": "^14.0.0"
  }
}
```

Run: `pnpm install`
Expected: lockfile created successfully

- [ ] **Step 2: 권한 실패 테스트 작성**

```js
test('미승인 계정과 학생은 원본 세트를 읽지 못한다', async () => {
  await assertFails(unapproved.firestore().doc('quiz_sets/set1').get());
  await assertFails(student.firestore().doc('quiz_sets/set1').get());
  await assertSucceeds(owner.firestore().doc('quiz_sets/set1').get());
});

test('학생은 자기 응답의 허용 필드만 쓴다', async () => {
  const own = student.firestore().doc('sessions/s1/responses/student-uid');
  await assertSucceeds(own.set({ answers: { 0: { answer: 1, submitted: true, revision: 1 } } }));
  await assertFails(own.set({ answers: { 0: { answer: 1, submitted: true, revision: 2, ok: true } } }));
  await assertFails(student.firestore().doc('sessions/s1/responses/other').get());
});
```

- [ ] **Step 3: RED 확인**

Run: `pnpm test:rules`
Expected: FAIL because current `signedIn()` rules allow global access

- [ ] **Step 4: 기본 거부 규칙과 역할 helpers 구현**

```rules
function verifiedEmail() {
  return request.auth != null && request.auth.token.email_verified == true;
}
function allowance() {
  return get(/databases/$(database)/documents/teacher_allowlist/$(request.auth.token.email));
}
function isApprovedTeacher() {
  return verifiedEmail() && allowance().data.enabled == true &&
    allowance().data.role in ['teacher', 'admin'];
}
function isAdmin() {
  return isApprovedTeacher() && allowance().data.role == 'admin';
}
```

모든 match는 명시적으로 허용하지 않으면 `allow read, write: if false`로 끝낸다. 승인 목록은 규칙 내부 `get/exists`에만 사용하고 직접 클라이언트 접근은 거부한다.

- [ ] **Step 5: 역할별 전체 매트릭스 테스트**

승인 소유 교사, 다른 승인 교사, 관리자, 등록 학생, 다른 학생, 미등록 익명 사용자, 미승인 Google 계정에 대해 세트·이미지·코드·세션·live·board·학생·응답·설정 경로의 get/list/create/update/delete를 표 기반으로 검증한다.

Run: `pnpm test:rules && pnpm test`
Expected: all PASS

- [ ] **Step 6: 커밋**

```bash
git add package.json pnpm-lock.yaml firebase.json .firebaserc firestore.rules tests/firestore-rules.test.js
git commit -m "교사와 학생 Firestore 권한을 격리"
```

---

### Task 3: 세트 소유권과 교사별 화면

**Files:**
- Modify: `firestore-store.js`
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Produces: `saveOwnedQuizSet(setId, value, images, teacher) -> Promise<void>`
- Produces: `copyOwnedQuizSet(sourceId, newId, teacher) -> Promise<QuizSet>`
- Produces: `canEditSet(set, teacherState) -> boolean`

- [ ] **Step 1: 소유권 테스트 작성**

```js
test('새 세트와 사본은 현재 교사를 소유자로 기록한다', async () => {
  await store.saveOwnedQuizSet('s1', { title: 'A', videos: [] }, {}, { uid: 't1', email: 't@school.kr' });
  assert.equal(fake.value('quiz_sets/s1').ownerUid, 't1');
  await store.copyOwnedQuizSet('s1', 's2', { uid: 't2', email: 'other@school.kr' });
  assert.equal(fake.value('quiz_sets/s2').ownerUid, 't2');
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="소유자" tests/firestore-store.test.js`
Expected: FAIL because owned APIs do not exist

- [ ] **Step 3: 저장소와 UI 소유권 구현**

저장 시 클라이언트 입력의 `ownerUid`를 신뢰하지 않고 현재 교사 상태에서 덮어쓴다. 다른 교사의 세트 편집 버튼은 숨기고 `사본 만들기`와 `우리 반 시작하기`만 표시한다. 기존 `ownerUid` 없는 세트는 이전 완료 전 읽기 전용으로 표시한다.

- [ ] **Step 4: 저장·목록·초안 회귀 테스트**

Run: `node --test tests/firestore-store.test.js tests/editor-draft.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add firestore-store.js index.html tests/firestore-store.test.js
git commit -m "퀴즈 세트에 교사 소유권을 적용"
```

---

### Task 4: 학생용 공개 문항과 UID 결합 응답

**Files:**
- Modify: `firestore-store.js`
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Produces: `publicQuestion(flatQuestion, number, total, image) -> object`
- Produces: `publicAnswer(flatQuestion) -> object`
- Produces: `joinStudent(sessionId, authUid, profile) -> Promise<Student>`
- Produces: `writeStudentAnswer(sessionId, authUid, questionIndex, patch) -> Promise<void>`

- [ ] **Step 1: 정답 비공개 projection 테스트**

```js
test('공개 전 문항에는 정답과 해설이 없다', () => {
  const value = publicQuestion({ type: 'mc', text: 'Q', choices: ['A','B'], answer: 1, explain: 'E' }, 1, 2, 'img');
  assert.deepEqual(value, { number: 1, total: 2, type: 'mc', text: 'Q', choices: ['A','B'], image: 'img' });
  assert.equal('answer' in value, false);
  assert.equal('explain' in value, false);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="공개 전 문항|자기 UID" tests/firestore-store.test.js`
Expected: FAIL

- [ ] **Step 3: 교사 live publication 구현**

`plOpenQuestion()`은 `meta/live`에 안전한 `publicQuestion`만 기록한다. `plReveal()`은 `revealed: true`와 `publicAnswer`를 병합한다. 문항 종료 시 공개 답 필드를 제거한다. 학생 화면은 세트와 이미지 경로를 읽지 않고 `live.publicQuestion`만 렌더링한다.

- [ ] **Step 4: 학생 UID 문서와 쓰기 허용 필드 구현**

학생·응답 문서 ID는 익명 Auth UID를 사용하고 학년·반·번호는 프로필 필드로 저장한다. 규칙은 학생이 자기 응답의 `answer/submitted/revision/submittedAt`만 변경하고 `ok/score`를 쓰지 못하게 한다. 교사 채점은 별도 teacher write로 유지한다.

- [ ] **Step 5: 브라우저 계약과 규칙 테스트**

Run: `pnpm test:rules && node --test tests/*.test.js`
Expected: all PASS

- [ ] **Step 6: 커밋**

```bash
git add firestore-store.js firestore.rules index.html tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "학생에게 현재 공개 문항과 자기 응답만 허용"
```

---

### Task 5: 기존 데이터 소유권 이전

**Files:**
- Create: `migration-core.js`
- Create: `tests/migration-core.test.js`
- Modify: `firestore-store.js`
- Modify: `index.html`
- Modify: `firestore.rules`

**Interfaces:**
- Produces: `MigrationCore.planLegacyMigration(sets, sessions, teacher) -> MigrationPlan`
- Produces: `store.migrateLegacyOwnership(plan, onProgress) -> MigrationReport`
- Produces report fields: `{ migrated, skipped, failed, failedIds }`

- [ ] **Step 1: 멱등 이전 계획 테스트**

```js
test('이미 소유자가 있는 문서는 건너뛰고 legacy만 이전한다', () => {
  const plan = core.planLegacyMigration(
    [{ id: 'a' }, { id: 'b', ownerUid: 'old' }],
    [{ id: 'x', setId: 'a' }, { id: 'y', teacherUid: 'old' }],
    { uid: 't1', email: 't@school.kr' }
  );
  assert.deepEqual(plan.setIds, ['a']);
  assert.deepEqual(plan.sessionIds, ['x']);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/migration-core.test.js`
Expected: FAIL with missing module

- [ ] **Step 3: 이전 코어·저장소·진행 UI 구현**

`legacy_owner`와 로그인 이메일이 일치할 때만 이전 화면을 연다. 400개 이하 batch로 세트와 세션을 이전하고 문서별 성공/건너뜀/실패를 누적한다. 재실행 시 `ownerUid/teacherUid`가 있는 문서는 변경하지 않는다.

- [ ] **Step 4: 일부 실패와 재시도 테스트**

```js
test('일부 batch 실패 뒤 재실행은 성공 문서를 중복 변경하지 않는다', async () => {
  const first = await migrateWithFailureAtBatch(2);
  assert.equal(first.failed.length > 0, true);
  const second = await rerunMigration();
  assert.equal(second.duplicated, 0);
});
```

Run: `node --test tests/migration-core.test.js tests/firestore-store.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add migration-core.js tests/migration-core.test.js firestore-store.js firestore.rules index.html
git commit -m "기존 세트와 세션을 승인 교사에게 이전"
```

---

### Task 6: 잔여 무결성과 운영 안전성 보완

**Files:**
- Modify: `firestore-store.js`
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Produces: strict snapshot readers keyed by `snapshotVersion`
- Produces: successful-publication due queue semantics
- Produces: `estimateBatchRequest(set, images) -> { writes, bytes, allowed, reason }`
- Produces: admin rejected-range state that cannot populate purge targets

- [ ] **Step 1: 남은 재검토 실패 경로 테스트 작성**

```js
test('snapshotVersion 1은 snapshot 누락 시 mutable set으로 fallback하지 않는다', async () => {
  await assert.rejects(() => store.getSessionQuizSet({ id: 's1', setId: 'set1', snapshotVersion: 1 }), /스냅샷/);
});

test('live 공개 실패는 due 문항을 제거하거나 fired 처리하지 않는다', async () => {
  await assert.rejects(() => plOpenNextDueQuestion(), /permission-denied/);
  assert.deepEqual(pl.dueQuestions, [1]);
  assert.equal(pl.fired[1], false);
});

test('300건 초과 결과는 탭 전환 뒤에도 purge 대상이 되지 않는다', () => {
  publishRejectedAdminRange(301);
  admRenderBody();
  assert.deepEqual(adm.purgeSessionIds, []);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="snapshotVersion 1|live 공개 실패|300건 초과|10 MiB|고아 세션" tests/firestore-store.test.js`
Expected: relevant tests FAIL

- [ ] **Step 3: strict snapshot과 문항 queue 수정**

새 세션 reader는 snapshot 누락을 오류로 반환한다. `plOpenNextDueQuestion()`은 `store.setLive()` 성공 뒤에만 queue shift와 fired 반영을 수행하고, 수동 공개는 같은 index를 queue에서 제거한다. 실패 시 재시도 UI를 표시하고 재생 정지 상태를 보존한다.

- [ ] **Step 4: 학생 rollback과 고아 세션 정리**

학생 쓰기 rollback은 현재 `live.q`가 달라도 캡처한 state·question·revision이 최신 optimistic revision이면 실행하고 toast를 표시한다. `startSession()` 성공 후 화면 identity가 바뀌면 즉시 `endSession(sessionId)`을 호출한다.

- [ ] **Step 5: Firestore 요청 크기·쓰기 수 사전 계산**

```js
function estimateBatchRequest(set, images) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify(set)).length +
    Object.entries(images || {}).reduce((n, [key, data]) => n + encoder.encode(key).length + encoder.encode(data).length + 64, 0);
  const imageWrites = Object.keys(images || {}).length;
  const transformWrites = 2; // createdAt, updatedAt serverTimestamp
  const writes = 1 + imageWrites + transformWrites;
  return { writes, bytes, allowed: writes <= 500 && bytes <= 9_500_000,
    reason: writes > 500 ? 'writes' : bytes > 9_500_000 ? 'bytes' : '' };
}
```

9.5MB 안전 한도를 넘으면 Firestore 호출 전에 저장을 거부한다. 관리자 거부 범위는 sessions를 publish하지 않고 삭제 snapshot을 항상 빈 배열로 유지한다.

- [ ] **Step 6: 전체 테스트와 커밋**

Run: `node --test tests/*.test.js && git diff --check`
Expected: all PASS, no whitespace errors

```bash
git add firestore-store.js index.html tests/firestore-store.test.js
git commit -m "세션 스냅샷과 운영 경계 조건을 강화"
```

---

### Task 7: 문서와 실제 브라우저 보안 회귀

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF-2026-08-14.md`

**Interfaces:**
- Consumes: Tasks 1–6 complete application and rules
- Produces: verified migration report and browser acceptance evidence

- [ ] **Step 1: 사용자·관리 문서 갱신**

Google 로그인, 승인 이메일 등록, 교사/admin 역할, 다른 교사 세트 사본, 학생 코드 흐름, 이전 실행·재시도, 규칙 롤백 방법을 문서화한다. 기존 관리자 비밀번호 설명을 제거한다.

- [ ] **Step 2: 정적·Emulator 전체 검증**

Run: `pnpm test && pnpm test:rules && git diff --check`
Expected: all PASS

- [ ] **Step 3: 로컬 실제 브라우저 수용 시나리오**

다음을 실제 Firebase 테스트 프로젝트와 브라우저에서 확인한다.

1. 승인 교사가 컴퓨터 A에서 로그인하고 세트 2영상을 연다.
2. 같은 계정으로 컴퓨터 B에서 동일 세트를 수정·저장한다.
3. 다른 승인 교사는 원본 편집이 거부되고 사본 편집은 성공한다.
4. 미승인 Google 계정은 교사 메뉴와 Firestore 원본 세트 접근이 거부된다.
5. 교사 1명과 학생 5명이 영상 2개 수업을 진행한다.
6. 정답 공개 전 학생 탭에서 원본 정답·다른 학생 응답을 읽지 못한다.
7. 제출 1/4→5/0, 3초 전환, 전역 문항 2/2, 완료·순위·대시보드·다시보기·명시적 종료를 확인한다.
8. 이전 전후 세트·이미지·세션·학생·응답 수를 비교한다.
9. 앱·Firestore console warning/error 0을 확인하고 확장 프로그램 로그는 분리한다.

- [ ] **Step 4: 문서 커밋**

```bash
git add README.md docs/HANDOFF-2026-08-14.md
git commit -m "교사 로그인과 보안 이전 절차를 문서화"
```

---

### Task 8: 최종 검토와 단계적 배포

**Files:**
- Modify if needed: files identified by final review

**Interfaces:**
- Consumes: clean Tasks 1–7 branch
- Produces: strict Firestore rules and public GitHub Pages release

- [ ] **Step 1: 전체 브랜치 독립 검토**

설계와 계획을 기준으로 base..HEAD 전체 diff를 가장 강한 검토 모델에 전달한다. 모든 Critical/Important finding을 수정하고 scoped re-review를 통과한다.

- [ ] **Step 2: 최종 자동 검증**

Run: `pnpm test && pnpm test:rules && git diff --check && git status --short`
Expected: all PASS, clean worktree

- [ ] **Step 3: 로그인 UI 선배포와 이전**

기존 규칙 상태에서 로그인 UI와 이전 코드를 배포한다. Firebase Console에서 Google 공급자, 승인 이메일, `legacy_owner`를 설정한다. 승인 교사로 이전을 실행하고 보고된 문서 수를 Firestore Console 수와 대조한다.

- [ ] **Step 4: 엄격한 규칙 배포**

Run: `firebase deploy --only firestore:rules`
Expected: deploy succeeds for configured project

- [ ] **Step 5: 사이트 통합·푸시·공개 검증**

기능 브랜치를 `main`에 fast-forward 병합하고 전체 테스트를 다시 실행한다. `main`을 원격에 push한 뒤 `https://shining-jade.github.io/video-quiz/`에서 Task 7의 교사·학생·권한 시나리오를 다시 확인한다.

- [ ] **Step 6: 롤백 조건 기록**

승인 교사가 로그인하지 못하거나 학생 입장이 권한 거부되면 데이터 문서는 유지하고 Firestore 규칙만 직전 배포 버전으로 되돌린다. 공개 검증 보고서에 배포 커밋, 규칙 버전, 이전 수, 테스트 수, 잔여 우려를 기록한다.

