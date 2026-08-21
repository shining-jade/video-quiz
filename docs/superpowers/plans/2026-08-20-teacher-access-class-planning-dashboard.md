# Teacher Access, Class Planning, and Dashboard Implementation Plan

> 운영 주의(2026-08-22): 이 문서는 역사적 설계/구현 기록이다. 아래의 개별 rollout·deploy 순서는 폐기되었고, production 전체 순서는 오직 [`docs/RELEASE-RUNBOOK.md`](../../RELEASE-RUNBOOK.md)의 R0~R15를 따른다.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사가 자기 Google 계정으로 권한을 신청하고 관리자가 승인하며, 승인 교사가 수업 사용계획을 등록하고 메인 현황판에서 겹침·예상/실제 참여 규모를 확인하도록 한다.

**Architecture:** 순수 상태·검증 로직은 작은 CommonJS/브라우저 UMD 모듈로 분리하고, Firestore 저장소 메서드는 `firestore-store.js`, 화면 연결은 `index.html`, 권한 불변식은 `firestore.rules`에서 강제한다. 관리자 원본 계획과 일반 교사용 최소 projection을 별도 컬렉션에 같은 batch/transaction으로 저장해 Firestore가 필드 단위 비공개를 지원하지 않는 한계를 피한다.

**Tech Stack:** Vanilla JavaScript, Firebase Authentication, Cloud Firestore compat SDK, Firestore Security Rules, Node.js built-in test runner, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-08-20-teacher-access-class-planning-dashboard-design.md`

## Global Constraints

- 공용 계정을 만들지 않고 Google 인증 UID마다 하나의 교사 신청과 승인 상태를 사용한다.
- 동시 수업 경고는 수업 시작을 차단하지 않는다.
- 학생과 비로그인 사용자는 신청·계획·현황판 문서를 읽지 못한다.
- 일반 교사용 계획 projection에는 UID, 이메일, 관리자 메모를 저장하지 않는다.
- 모든 시간 판정은 `store.serverNow()` 또는 Firestore `request.time`을 사용한다.
- 탈퇴 완전 삭제는 요청 후 정확히 30일, 소유 세트 0건, 진행 세션 0건을 모두 요구한다.
- 기존 교사·세트·세션은 additive migration 전후에 계속 읽을 수 있어야 하며 strict 규칙 배포 전 audit gate가 필요하다.
- 운영 migration과 purge CLI는 dry-run 기본, 대상 프로젝트 검증, 기존 report 비덮어쓰기, 부분 실패에도 유효한 JSON 보고서를 보장한다.

---

### Task 1: 교사 신청과 승인 상태 순수 코어

**Files:**
- Create: `teacher-access-request-core.js`
- Create: `tests/teacher-access-request-core.test.js`
- Modify: `index.html`

**Interfaces:**
- Consumes: Firebase Google user shape `{uid,email,displayName,emailVerified,providerData}`.
- Produces: `TeacherAccessRequestCore.buildRequest(user, input, nowMs)`, `validateRequest(request)`, `canCancel(request, uid)`, `nextDecision(request, decision, admin, nowMs)`, `teacherStatus(allowance)`.

- [ ] **Step 1: Write failing canonical request tests**

```js
test('verified Google user builds one canonical pending request', () => {
  const request = core.buildRequest({
    uid: 'teacher-a', email: ' Teacher@School.KR ', displayName: '김교사',
    emailVerified: true, providerData: [{ providerId: 'google.com' }]
  }, { organization: '1학년', note: '보건 수업' }, 1_000);
  assert.deepEqual(request, {
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: '김교사',
    organization: '1학년', note: '보건 수업', status: 'pending', revision: 1,
    createdAtMs: 1_000, updatedAtMs: 1_000
  });
});

test('anonymous, unverified, non-Google and oversized input fail closed', () => {
  assert.throws(() => core.buildRequest({ uid: 'x', emailVerified: false }, {}, 1));
  assert.throws(() => core.buildRequest({
    uid: 'x', email: 'x@example.com', emailVerified: true,
    providerData: [{ providerId: 'password' }]
  }, {}, 1));
  assert.throws(() => core.buildRequest(googleUser, { note: 'x'.repeat(501) }, 1));
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/teacher-access-request-core.test.js`

Expected: FAIL with `Cannot find module '../teacher-access-request-core.js'`.

- [ ] **Step 3: Implement minimal UMD core**

Implement exact bounds: display name 1–80, organization 0–120, note 0–500, canonical lowercase trimmed email, statuses `pending|approved|rejected|cancelled`, and admin decisions that increment `revision` without accepting caller-supplied handler fields.

```js
function nextDecision(request, decision, admin, nowMs) {
  if (!request || request.status !== 'pending') throw new Error('pending request required');
  if (!admin || !admin.uid || !['approved', 'rejected'].includes(decision.status)) {
    throw new Error('valid admin decision required');
  }
  return Object.assign({}, request, {
    status: decision.status,
    revision: request.revision + 1,
    decidedAtMs: nowMs,
    decidedByUid: admin.uid,
    decisionReason: String(decision.reason || '').slice(0, 200),
    updatedAtMs: nowMs
  });
}
```

- [ ] **Step 4: Run GREEN and browser script parse test**

Run: `node --test tests/teacher-access-request-core.test.js tests/release-copy.test.js`

Expected: all tests PASS and every inline script parses.

- [ ] **Step 5: Commit**

```bash
git add teacher-access-request-core.js tests/teacher-access-request-core.test.js index.html
git commit -m "교사 권한 신청 상태 코어 추가"
```

---

### Task 2: 교사 신청·승인 Firestore API와 보안 규칙

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: Task 1 request/decision shapes and existing admin probe/approved-teacher documents.
- Produces: `store.submitTeacherRequest(request)`, `store.getOwnTeacherRequest(uid)`, `store.cancelTeacherRequest(uid, revision)`, `store.listPendingTeacherRequests(limit)`, `store.decideTeacherRequest(uid, expectedRevision, decision, adminIdentity)`, `store.suspendTeacher(uid, reason, adminIdentity)`, `store.restoreTeacher(uid, adminIdentity)`.

- [ ] **Step 1: Write failing store transaction tests**

```js
test('admin approval atomically updates request and allowance', async () => {
  const store = makeStore(seed({
    'teacher_access_requests/teacher-a': pendingRequest({ revision: 3 })
  }));
  await store.decideTeacherRequest('teacher-a', 3, { status: 'approved' }, admin);
  assert.equal(read('teacher_access_requests/teacher-a').status, 'approved');
  assert.deepEqual(read('teacher_allowances/teacher-a'), {
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', status: 'active', enabled: true,
    approvedByUid: 'admin-a'
  });
});

test('stale revision or changed email commits nothing', async () => {
  await assert.rejects(store.decideTeacherRequest('teacher-a', 2, { status: 'approved' }, admin));
  assert.equal(read('teacher_access_requests/teacher-a').status, 'pending');
  assert.equal(read('teacher_allowances/teacher-a'), undefined);
});
```

- [ ] **Step 2: Run store RED**

Run: `node --test --test-name-pattern="teacher request|교사 신청|admin approval" tests/firestore-store.test.js`

Expected: FAIL because the new methods do not exist.

- [ ] **Step 3: Implement Firestore transactions**

Use `runTransaction` for decision/suspend/restore. Re-read request and current allowance, compare exact UID/canonical email/revision, and write server timestamps. Never expose an allowlist collection query to normal teachers.

- [ ] **Step 4: Write failing Emulator authorization matrix**

```js
test('teacher request role matrix', async () => {
  await assertSucceeds(setDoc(doc(unapprovedDb, 'teacher_access_requests/u1'), ownPending));
  await assertFails(getDoc(doc(unapprovedDb, 'teacher_access_requests/u2')));
  await assertFails(updateDoc(doc(unapprovedDb, 'teacher_access_requests/u1'), { status: 'approved' }));
  await assertSucceeds(getDocs(query(collection(adminDb, 'teacher_access_requests'), where('status','==','pending'))));
  await assertFails(getDocs(collection(approvedTeacherDb, 'teacher_access_requests')));
});
```

Also cover atomic approve/reject, stale revision, wrong canonical email, suspend, restore, student/anonymous denial, and owner-only pending cancellation.

- [ ] **Step 5: Run Emulator RED**

Run: `pnpm exec firebase emulators:exec --only firestore "node --test tests/firestore-rules.test.js"`

Expected: new matrix cases FAIL under existing rules.

- [ ] **Step 6: Implement strict rules and run GREEN**

Add helpers `isOwnTeacherRequest(uid)`, `validPendingTeacherRequest(uid)`, `validAdminRequestDecision(uid)`, and extend active teacher checks to accept only `status == 'active'` while retaining migrated legacy compatibility behind the migration gate.

Run:

```bash
node --test tests/firestore-store.test.js
pnpm exec firebase emulators:exec --only firestore "node --test tests/firestore-rules.test.js"
```

Expected: both suites PASS.

- [ ] **Step 7: Commit**

```bash
git add firestore-store.js firestore.rules tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "교사 신청 승인 API와 보안 규칙 구현"
```

---

### Task 3: 신청자 화면과 관리자 승인 화면

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: Task 2 store methods and existing `applyTeacherUser`, protected-route retraction, admin route.
- Produces: `screenTeacherRequest()`, `submitTeacherRequestForm(event)`, `cancelTeacherRequest()`, `renderAdminTeacherRequests()`, `adminDecideTeacherRequest(uid, revision, decision)`.

- [ ] **Step 1: Write failing route and stale-auth UI tests**

Tests must execute extracted functions with deterministic delayed store promises and assert observable DOM state:

```js
test('unapproved Google user sees request form, not protected teacher cards', async () => {
  await context.applyTeacherUser(unapprovedGoogleUser);
  assert.match(app.innerHTML, /교사 권한 신청/);
  assert.doesNotMatch(app.innerHTML, /퀴즈 세트 만들기/);
});

test('stale request load cannot restore A UI after A to B auth switch', async () => {
  const pendingA = context.applyTeacherUser(userA);
  context.onAuthStateChanged(userB);
  resolveA(pendingRequestA);
  await pendingA;
  assert.doesNotMatch(app.innerHTML, /teacher-a@example.com/);
});
```

Add admin approve/reject button disabled-in-flight and permission-denied retraction tests.

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern="권한 신청|request form|admin request|stale request" tests/firestore-store.test.js tests/release-copy.test.js`

Expected: FAIL because the screens and handlers are absent.

- [ ] **Step 3: Implement UI with auth-generation barriers**

Reuse existing durable `appliedTeacherState`/auth generation. Every promise continuation verifies UID, generation, route, and current screen before rendering. Approval success re-fetches server-only allowance; offline cache never upgrades a user.

- [ ] **Step 4: Run focused and full Node GREEN**

Run:

```bash
node --test --test-name-pattern="권한 신청|request form|admin request|stale request" tests/*.test.js
node --test tests/*.test.js
```

Expected: no failures; Emulator-only cases remain explicit skips in the plain Node run.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "교사 권한 신청과 관리자 승인 화면 추가"
```

---

### Task 4: 수업계획·겹침 경고 순수 코어

**Files:**
- Create: `class-planning-core.js`
- Create: `tests/class-planning-core.test.js`
- Modify: `index.html`

**Interfaces:**
- Produces: `ClassPlanningCore.normalizePlan(input, identity, setSnapshot, serverNowMs)`, `overlaps(a,b)`, `summarizeWindow(plans, candidate, thresholds)`, `publicProjection(privatePlan)`, `applyActuals(plan, sessionSummary)`.

- [ ] **Step 1: Write failing boundary tests**

```js
test('touching endpoints do not overlap but intersecting intervals do', () => {
  assert.equal(core.overlaps({ startMs: 1000, endMs: 2000 }, { startMs: 2000, endMs: 3000 }), false);
  assert.equal(core.overlaps({ startMs: 1000, endMs: 2001 }, { startMs: 2000, endMs: 3000 }), true);
});

test('warning sums non-cancelled overlapping expected students without blocking', () => {
  assert.deepEqual(core.summarizeWindow(plans, candidate, { caution: 60, crowded: 120 }), {
    overlappingClasses: 2, expectedConcurrentStudents: 135, level: 'crowded', canProceed: true
  });
});

test('public projection contains no owner identity or admin notes', () => {
  const output = core.publicProjection(privatePlan);
  assert.equal(output.ownerUid, undefined);
  assert.equal(output.ownerEmailCanonical, undefined);
  assert.equal(output.adminNote, undefined);
  assert.equal(output.className, '2학년 1반');
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/class-planning-core.test.js`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement validation and projections**

Enforce class name 1–80, expected students integer 1–500, end strictly after start, maximum duration 24 hours, states `planned|live|ended|cancelled`, and threshold ordering `1 <= caution < crowded`.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/class-planning-core.test.js tests/release-copy.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add class-planning-core.js tests/class-planning-core.test.js index.html
git commit -m "수업계획 겹침과 현황 projection 코어 추가"
```

---

### Task 5: 수업계획 저장소·규칙과 실제 세션 연결

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: Task 4 plan/private/public shapes and existing session allocation/start/end methods.
- Produces: `store.createClassPlan(privatePlan, publicPlan)`, `updateOwnClassPlan(planId, expectedRevision, updates)`, `cancelOwnClassPlan(planId, expectedRevision)`, `listPublicPlans(from, to, limit)`, `listAdminPlans(from, to, limit)`, `attachPlanToSession(planId, sessionId, ownerIdentity)`, `finishClassPlan(planId, sessionId, actuals)`.

- [ ] **Step 1: Write failing atomic dual-document tests**

Create must atomically write `class_plans_private/{id}` and `class_plans_public/{id}` with matching `planId`, revision, interval, class name, counts, status, and set snapshot. Simulate second-write failure and assert neither document exists.

- [ ] **Step 2: Run store RED**

Run: `node --test --test-name-pattern="class plan|수업계획|projection" tests/firestore-store.test.js`

Expected: FAIL because methods are missing.

- [ ] **Step 3: Implement store methods with transactions**

Use exact revision compare-and-set. `attachPlanToSession` re-reads private plan and session, requires active owner, same setId, `planned` status, and writes private/public status `live` plus sessionId atomically. `finishClassPlan` reads authoritative session/student count and writes ended actuals to both documents.

- [ ] **Step 4: Write failing Emulator matrix**

Cover:

- active teacher creates only own valid paired private/public plan;
- parent-only/private-only/public-only writes fail;
- normal teacher lists public projection but cannot get private docs;
- owner gets own private doc; admin lists all private docs;
- student, anonymous, pending, suspended, deletion-pending users get nothing;
- updates preserve identity and matching revision;
- overlapping plans both succeed;
- plan/session owner or set mismatch fails;
- actual count cannot be client-forged.

- [ ] **Step 5: Implement rules and run Emulator GREEN**

Rules use `existsAfter`/`getAfter` to require matching paired writes. Public documents whitelist exactly non-sensitive fields. Query constraints require bounded time windows and limits.

Run:

```bash
node --test tests/firestore-store.test.js
pnpm exec firebase emulators:exec --only firestore "node --test tests/firestore-rules.test.js"
```

Expected: PASS.

- [ ] **Step 6: Integrate `우리 반 시작하기` plan gate**

Before allocation, render a dialog for class name, start/end, expected students. Query overlap window, render level and totals, and require only a local `경고 확인 후 진행` acknowledgment. If overlap query fails, show `현황 확인 불가 — 수업은 진행할 수 있습니다`; never block allocation solely for warning failure.

- [ ] **Step 7: Add failure-ordering tests**

Assert allocation is not attempted before plan write succeeds; failed allocation leaves `planned`; successful allocation attaches exactly one session; session end failure does not fabricate `ended`; retry uses same plan/session identity.

- [ ] **Step 8: Commit**

```bash
git add firestore-store.js firestore.rules index.html tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "수업계획 저장과 세션 연결 구현"
```

---

### Task 6: 메인 교사 현황판

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: `store.listPublicPlans`, `store.listAdminPlans`, Task 4 `summarizeWindow`, current teacher/admin role.
- Produces: `startTeacherDashboard(identity)`, `stopTeacherDashboard()`, `renderTeacherDashboard(plans, identity, isAdmin)`, `retryTeacherDashboard()`.

- [ ] **Step 1: Write failing role-specific dashboard tests**

```js
test('approved teacher dashboard shows schedule and counts without identities', async () => {
  await context.startTeacherDashboard(teacher);
  assert.match(panel.innerHTML, /현재 진행 2개/);
  assert.match(panel.innerHTML, /예상 동시 참여 85명/);
  assert.doesNotMatch(panel.innerHTML, /teacher-b@school.kr|teacher-b-uid/);
});

test('admin dashboard shows teacher identity while student and signed-out home do not render panel', async () => {
  await context.startTeacherDashboard(admin);
  assert.match(panel.innerHTML, /박교사/);
  context.onAuthStateChanged(null);
  assert.equal(document.getElementById('teacher-dashboard'), null);
});
```

Also test auth-generation/route cleanup, query failure retry, today boundary in server-adjusted timezone, and plan status changes.

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern="teacher dashboard|교사 현황판" tests/firestore-store.test.js tests/release-copy.test.js`

Expected: FAIL because dashboard functions and markup are absent.

- [ ] **Step 3: Implement bounded listeners and rendering**

Open one listener for today's public plans plus active plans while a protected teacher home is current. Admin uses private query only on admin dashboard. Stop listeners on route/auth generation changes. Past days use paginated reads, never live listeners.

- [ ] **Step 4: Run focused and full Node GREEN**

Run:

```bash
node --test --test-name-pattern="teacher dashboard|교사 현황판" tests/*.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "메인 교사 수업 현황판 추가"
```

---

### Task 7: 교사 탈퇴 요청·30일 복구·관리자 purge gate

**Files:**
- Create: `teacher-deletion-core.js`
- Create: `tests/teacher-deletion-core.test.js`
- Create: `scripts/purge-teacher-account.js`
- Create: `tests/purge-teacher-account.test.js`
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `index.html`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Produces: `TeacherDeletionCore.request(allowance, serverNowMs)`, `cancel(...)`, `auditEligibility({allowance, ownedSetCount, liveSessionCount}, serverNowMs)`, `store.requestTeacherDeletion(uid)`, `cancelTeacherDeletion(uid)`, and Admin CLI modes `dry-run|apply`.

- [ ] **Step 1: Write failing exact 30-day gate tests**

```js
test('purge is denied one millisecond early and with any owned set or live session', () => {
  const requestedAt = Date.UTC(2026, 7, 20);
  assert.equal(core.auditEligibility({ allowance, ownedSetCount: 0, liveSessionCount: 0 }, requestedAt + DAYS_30 - 1).eligible, false);
  assert.equal(core.auditEligibility({ allowance, ownedSetCount: 1, liveSessionCount: 0 }, requestedAt + DAYS_30).eligible, false);
  assert.equal(core.auditEligibility({ allowance, ownedSetCount: 0, liveSessionCount: 1 }, requestedAt + DAYS_30).eligible, false);
  assert.equal(core.auditEligibility({ allowance, ownedSetCount: 0, liveSessionCount: 0 }, requestedAt + DAYS_30).eligible, true);
});
```

- [ ] **Step 2: Run RED, implement core, run GREEN**

Run: `node --test tests/teacher-deletion-core.test.js`

Expected RED missing module; after implementation all cases PASS. Use exact `30 * 24 * 60 * 60 * 1000` only for report display; Firestore authoritative eligibility uses Timestamp/request.time.

- [ ] **Step 3: Write failing request/cancel Rules tests**

Teacher may transition only own `active → deletion_pending` with server timestamp fields and reverse before eligibility. Pending deletion cannot edit/save/start sessions. Admin can set `administrativeHold:true` during deletion pending; cancellation becomes `suspended` when that hold is present and `active` otherwise. Admin cannot client-delete allowance/request/Auth records.

- [ ] **Step 4: Implement request UI and rules**

UI shows owned set count and blocks confirmation until teacher acknowledges that ownership must be transferred or trashed. Existing sessions expose only safe end action. Cancel restores active only if admin did not place an independent suspension.

- [ ] **Step 5: Write failing Admin purge CLI tests**

Tests invoke the real CLI core against fake Admin adapters and assert:

- dry-run performs no writes;
- wrong project/mode exits before Admin initialization;
- existing report path is never overwritten;
- final audit enumerates owned sets and live sessions authoritatively;
- partial Firestore mutation or Auth deletion ambiguity publishes fail-closed JSON;
- apply refuses if any ownership/session blocker exists;
- successful apply removes/anonymous-marks profile, request and allowance and records non-sensitive audit event.

- [ ] **Step 6: Implement durable Admin purge CLI**

Reuse the repository's exclusive `.reserved/.pending` atomic report publication protocol. Require explicit target project, mode, UID, dry-run default, exact eligibility audit, and post-apply reread. Never delete the user's Google account; delete only the Firebase Auth user for this app.

- [ ] **Step 7: Run focused, full Node and Emulator GREEN**

```bash
node --test tests/teacher-deletion-core.test.js tests/purge-teacher-account.test.js
node --test tests/*.test.js
pnpm exec firebase emulators:exec --only firestore "node --test tests/firestore-rules.test.js"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add teacher-deletion-core.js tests/teacher-deletion-core.test.js scripts/purge-teacher-account.js tests/purge-teacher-account.test.js firestore-store.js firestore.rules index.html tests/firestore-rules.test.js
git commit -m "교사 탈퇴 요청과 30일 정리 gate 구현"
```

---

### Task 8: 승인 상태 migration, 문서, 실제 브라우저 검증과 배포

**Files:**
- Create: `teacher-access-migration.js`
- Create: `scripts/migrate-teacher-access-status.js`
- Create: `tests/teacher-access-migration.test.js`
- Create: `docs/TEACHER-ACCESS-CLASS-PLANNING.md`
- Modify: `README.md`
- Modify: `HANDOFF.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: all previous tasks, existing durable migration report protocol, Firebase Admin SDK test adapter.
- Produces: dry-run/apply migration report with `safeToDeployStrictRules`, operational instructions, release evidence.

- [ ] **Step 1: Write failing migration tests**

Cover legacy `{enabled:true}` → `{enabled:true,status:'active'}`, disabled → suspended, malformed/missing UID/email gate failure, transaction reread race, idempotent apply, final audit failure partial report, wrong project/mode, existing output refusal, and stdout failure after durable publication.

- [ ] **Step 2: Run RED and implement migration**

Run: `node --test tests/teacher-access-migration.test.js`

Expected missing module RED, then GREEN after transaction-based re-read implementation. Audit exact state/email/UID/Timestamp coherence before setting `safeToDeployStrictRules:true`.

- [ ] **Step 3: Add operational documentation**

Document exact order:

1. backup/export;
2. Emulator full suites;
3. production migration dry-run and inspect durable report;
4. production apply and post-audit;
5. deploy strict rules;
6. deploy static app;
7. smoke test admin, two teachers, two concurrent classes, students;
8. retain rollback commit and reports.

Include that overlap warning is advisory, Firebase quota is not guaranteed, and account purge is an explicit admin operation.

- [ ] **Step 4: Run all automated release gates**

```bash
node --test tests/*.test.js
pnpm exec firebase emulators:exec --only firestore "node --test tests/firestore-rules.test.js tests/legacy-migration-admin.test.js"
node --check scripts/migrate-teacher-access-status.js
node --check scripts/purge-teacher-account.js
git diff --check <base-sha> HEAD
```

Expected: zero failures and no diff errors.

- [ ] **Step 5: Browser acceptance**

Using connected browser sessions:

1. Sign in unapproved teacher A, submit and cancel request, resubmit.
2. Admin approves A and verifies protected home/dashboard appears only after server allowance recheck.
3. Teacher B submits; admin approves B.
4. A creates a 40-student plan and B creates an overlapping 50-student plan.
5. Both see warning total 90 and both can start distinct sessions.
6. Join at least one real student per session and verify actual participant totals.
7. Verify normal teacher cannot see other email/UID; admin can see identity.
8. Request A deletion, verify immediate new-session denial, cancel, and restore.
9. Read same-tab app/Firebase console; app-origin errors must be zero.

- [ ] **Step 6: Independent security review gate**

Review exact base..HEAD for Critical/Important findings: auth generation races, projection privacy, query/rules mismatch, plan/session CAS, deletion gate, migration concurrency and durable reports. Fix all Critical/Important findings with new RED→GREEN tests before proceeding.

- [ ] **Step 7: Commit docs and release evidence**

```bash
git add teacher-access-migration.js scripts/migrate-teacher-access-status.js tests/teacher-access-migration.test.js docs/TEACHER-ACCESS-CLASS-PLANNING.md README.md HANDOFF.md package.json
git commit -m "교사 신청과 수업 현황판 운영 절차 완성"
```

- [ ] **Step 8: Merge and deploy only after explicit operational gates**

Fast-forward the reviewed branch into `main`, rerun full Node and Emulator suites on merged main, push `main`, run the documented production migration in dry-run then apply only with the validated project identity/report path, deploy strict Firestore Rules, and verify GitHub Pages contains the release commit. If production migration, Rules deployment, browser acceptance, or console gate cannot be observed, stop and report the exact blocker instead of claiming deployment complete.
