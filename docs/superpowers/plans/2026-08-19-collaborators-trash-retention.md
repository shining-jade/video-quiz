# 공동 편집자·휴지통·교사 승인 관리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인 교사 공동 편집, 관리자 교사 승인 관리, 소유자 휴지통과 무료 우선 30일 영구 정리를 기존 영상 퀴즈에 안전하게 추가한다.

**Architecture:** 세트별 `collaborators` 하위 컬렉션으로 편집 권한을 분리하고, 세트 부모의 `trashedAt`·`purgeStartedAt` 상태로 휴지통 수명을 관리한다. Firestore Rules가 모든 저장·수업 시작·정리 쓰기를 서버 시각과 소유자/공동 편집자/admin 권한으로 제한하며, 클라이언트의 idempotent purge 작업이 로그인 때 중단 지점부터 정리를 재개한다.

**Tech Stack:** 정적 HTML/CSS/JavaScript, Firebase Auth 10 compat, Cloud Firestore, Firestore Security Rules, Node.js built-in test runner, `@firebase/rules-unit-testing`, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-08-19-collaborators-trash-retention-design.md`

## Global Constraints

- 세트 소유권은 한 명에게 유지한다.
- 공동 편집자는 콘텐츠 편집과 수업 진행만 가능하고 공동 편집자·소유권·휴지통 상태는 바꾸지 못한다.
- admin 역할만으로 타인 세트를 편집하거나 만료 전에 삭제할 수 없다.
- 휴지통 보관 기간은 서버 시각 기준 30일이며, 무료 우선 방식이라 사이트 접속이 없으면 실제 삭제가 늦어질 수 있다.
- 영구 삭제는 세트 본문, 세트 이미지, 공동 편집자 문서만 삭제하고 기존 세션·스냅샷·학생·응답·점수는 보존한다.
- 세트당 공동 편집자는 최대 20명이다.
- 영구 삭제 batch는 Firestore 500-write 한도보다 작은 200개 이하로 제한한다.
- 현재 로그인한 admin의 자기 비활성화·역할 하향은 UI와 Rules 모두에서 거부한다.
- 기존 `archived` 숨김 상태와 이전 세션 호환성을 유지한다.
- 운영 Rules 배포 전 전체 Node 테스트와 전체 Rules/Admin Emulator 테스트를 통과한다.

## 파일 책임 구조

- Create `collaboration-trash-core.js`: 이메일 정규화, 역할/세트 접근 판정, 30일 만료 계산, purge 단계의 순수 함수.
- Modify `firestore-store.js`: 승인 교사, 공동 편집자, 휴지통, purge 저장소 API와 원자성 경계.
- Modify `firestore.rules`: admin 승인 관리, 공동 편집 권한, 휴지통·만료 purge 권한.
- Modify `index.html`: 관리자 교사 관리, 공동 편집자 dialog, 휴지통 화면, 접근 상실 처리, 로그인 시 정리 조정.
- Modify `README.md`, `docs/HANDOFF-2026-08-14.md`: 운영·권한·복구·무료 정리 문서.
- Create `tests/collaboration-trash-core.test.js`: 순수 정책 경계.
- Modify `tests/firestore-store.test.js`: 저장소 트랜잭션·batch·중단 재개.
- Modify `tests/firestore-rules.test.js`: 실제 Emulator 권한 및 서버 시각 경계.
- Modify `tests/release-copy.test.js`: 사용자 안내와 배포 게이트 문구.

---

### Task 1: 공동 편집·휴지통 순수 정책 모듈

**Files:**
- Create: `collaboration-trash-core.js`
- Create: `tests/collaboration-trash-core.test.js`

**Interfaces:**
- Consumes: teacher auth state `{uid, email, role, enabled}` and normalized set records.
- Produces: `canonicalEmail(value)`, `setAccess(set, auth, collaboratorEmails)`, `trashDeadlineMs(trashedAtMs)`, `trashRetention(set, nowMs)`, `validateCollaboratorChange(input)`, `nextPurgeStep(state)`.

- [ ] **Step 1: Write failing email and access tests**

```js
test('canonical email and set access separate owner, editor, teacher and trashed state', () => {
  assert.equal(Core.canonicalEmail(' Editor@School.KR '), 'editor@school.kr');
  const set = { ownerUid: 'owner', trashedAt: null, purgeStartedAt: null };
  assert.equal(Core.setAccess(set, { uid: 'owner', email: 'o@x.kr', role: 'teacher' }, []).canManage, true);
  assert.equal(Core.setAccess(set, { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, ['editor@school.kr']).canEdit, true);
  assert.equal(Core.setAccess(set, { uid: 'admin', email: 'a@x.kr', role: 'admin' }, []).canEdit, false);
  assert.equal(Core.setAccess({ ...set, trashedAt: 1 }, { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, ['editor@school.kr']).canRead, false);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/collaboration-trash-core.test.js`
Expected: FAIL because `collaboration-trash-core.js` does not exist.

- [ ] **Step 3: Implement canonicalization and access output**

```js
function setAccess(set, auth, collaboratorEmails) {
  const active = !set.trashedAt && !set.purgeStartedAt;
  const owner = !!auth.uid && set.ownerUid === auth.uid;
  const editor = active && collaboratorEmails.includes(canonicalEmail(auth.email));
  return {
    canRead: active && (owner || editor || auth.role === 'teacher' || auth.role === 'admin'),
    canEdit: active && (owner || editor),
    canManage: active && owner,
    canRestore: !!set.trashedAt && !set.purgeStartedAt && owner
  };
}
```

- [ ] **Step 4: Write failing retention and collaborator validation tests**

```js
test('30-day retention uses exact boundary and purge is resumable', () => {
  const deleted = Date.UTC(2026, 7, 1);
  assert.equal(Core.trashRetention({ trashedAt: deleted }, deleted + 30 * 86400000 - 1).expired, false);
  assert.equal(Core.trashRetention({ trashedAt: deleted }, deleted + 30 * 86400000).expired, true);
  assert.equal(Core.nextPurgeStep({ collaboratorsRemaining: 1, imagesRemaining: 2 }), 'children');
  assert.equal(Core.nextPurgeStep({ collaboratorsRemaining: 0, imagesRemaining: 0 }), 'parent');
});

test('collaborator change rejects owner, duplicate, disabled and twenty-first editor', () => {
  assert.equal(Core.validateCollaboratorChange({ ownerEmail: 'a@x.kr', email: 'a@x.kr', enabled: true, existing: [] }).code, 'owner');
  assert.equal(Core.validateCollaboratorChange({ ownerEmail: 'a@x.kr', email: 'b@x.kr', enabled: false, existing: [] }).code, 'unapproved');
  assert.equal(Core.validateCollaboratorChange({ ownerEmail: 'a@x.kr', email: 'b@x.kr', enabled: true, existing: Array(20).fill('x') }).code, 'limit');
});
```

- [ ] **Step 5: Implement exact 30-day and validation functions**

Use `30 * 24 * 60 * 60 * 1000`, require lowercase canonical email, reject owner/duplicate/disabled/limit, and return stable Korean UI error codes rather than throwing display strings.

- [ ] **Step 6: Run focused and existing core tests**

Run: `node --test tests/collaboration-trash-core.test.js tests/auth-core.test.js tests/firestore-core.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add collaboration-trash-core.js tests/collaboration-trash-core.test.js
git commit -m "공동 편집과 휴지통 정책 코어를 추가"
```

---

### Task 2: 관리자 교사 승인 관리 API와 Rules

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: existing `teacherState`, `teacher_allowlist/{canonicalEmail}`.
- Produces: `store.listTeacherAllowances()`, `store.upsertTeacherAllowance(email, role)`, `store.disableTeacherAllowance(email)`, exact allowlist schema `{enabled, role, updatedAt, updatedByUid}`.

- [ ] **Step 1: Write failing store contract tests**

```js
test('admin allowance API canonicalizes email and uses server audit fields', async () => {
  await store.upsertTeacherAllowance(' New@School.KR ', 'teacher');
  assert.deepEqual(writes[0], {
    path: 'teacher_allowlist/new@school.kr',
    merge: true,
    data: { enabled: true, role: 'teacher', updatedAt: serverTimestamp, updatedByUid: 'admin-uid' }
  });
});
```

Also assert invalid role, non-admin caller, empty email, and self-disable are rejected before a write.

- [ ] **Step 2: Run focused store tests and confirm RED**

Run: `node --test --test-name-pattern="allowance API" tests/firestore-store.test.js`
Expected: FAIL because APIs are absent.

- [ ] **Step 3: Implement store APIs with current-admin revalidation**

Before every write, call the existing server-only approval probe for the current user, require `role === 'admin'`, and verify the auth generation still matches. `disableTeacherAllowance` writes `{enabled:false, updatedAt, updatedByUid}` and never deletes the document.

- [ ] **Step 4: Write Emulator RED matrix**

Cover:

```text
admin list/get/create/update: allow
teacher/student/unapproved list/get/write: deny
admin creates exact canonical doc with enabled/role/audit fields: allow
admin writes invalid role, extra key, mismatched document email: deny
admin disables or lowers own email: deny
admin updates another admin to teacher or disabled: allow
disabled admin performs later write: deny
```

- [ ] **Step 5: Implement Rules helpers and match block**

Add `isCurrentAdmin()`, `validAllowanceData(email)`, and require `resource.id != request.auth.token.email` for a transition that disables or lowers the current admin. Preserve verified Google provider and exact token email checks.

- [ ] **Step 6: Migrate existing two admin documents compatibly**

Rules reads must accept the current `{enabled, role}` shape. The first admin update writes all audit fields. Add a store test proving both legacy-minimal and audited documents render correctly.

- [ ] **Step 7: Run focused Node and Emulator tests**

Run: `node --test --test-name-pattern="allowance" tests/firestore-store.test.js`

Run: `firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-concurrency=1 --test-name-pattern=allowance tests/firestore-rules.test.js"`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add firestore-store.js firestore.rules tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "관리자 교사 승인 관리를 추가"
```

---

### Task 3: 공동 편집자 저장소와 Firestore 권한

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: Task 1 `canonicalEmail`, Task 2 allowlist documents.
- Produces: `store.listCollaborators(setId)`, `store.addCollaborator(setId, email)`, `store.removeCollaborator(setId, email)`, `store.canEditQuizSet(setId)`, collaborator-aware `saveQuizSet` and `replaceImages`.

- [ ] **Step 1: Write failing store API tests**

Test owner-only transaction flow: read set, read target allowance, query/count existing collaborators, create exact collaborator document with server timestamp. Test removal refuses non-owner and exact canonical document path.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test --test-name-pattern="collaborator" tests/firestore-store.test.js`
Expected: FAIL on missing APIs.

- [ ] **Step 3: Implement collaborator APIs**

`addCollaborator` transaction requirements:

```js
set.ownerUid === current.uid
!set.trashedAt && !set.purgeStartedAt
allowance.enabled === true
allowance.role in ['teacher', 'admin']
email !== canonicalEmail(set.ownerEmail)
(set.collaboratorCount || 0) < 20
```

Create `{email, addedByUid: current.uid, addedAt: serverTimestamp()}` and update the parent `collaboratorCount` by exactly `+1` in the same transaction. Removal decrements it by exactly `-1`. Existing sets normalize a missing count to 0. Refuse overwrite, underflow, and values above 20.

- [ ] **Step 4: Write Rules RED matrix**

Cover owner add/remove, target disabled, forged parent count, 21st collaborator, self-add, other teacher/admin add, collaborator content update, collaborator owner/trash/count field change, collaborator image revision batch, removed collaborator stale save, and direct collaborator list visibility.

- [ ] **Step 5: Implement Rules helpers**

Add:

```text
collaboratorPath(setId, email)
isActiveSet(setId)
isSetCollaborator(setId)
canEditSet(setId) = ownsSet(setId) || isSetCollaborator(setId)
```

Set update separates content fields from protected fields. `ownerUid`, `ownerEmail`, `trashedAt`, `purgeStartedAt` remain immutable for collaborators. Image create/update/delete batch uses `canEditSetAfter` plus parent `contentRevision` invariants.

- [ ] **Step 6: Update store save and copy/session boundaries**

- `saveQuizSet` and `replaceImages`: owner or current collaborator, active set only.
- `copyOwnedSet`: any approved teacher may still copy an active set; trashed/purging set returns permission error.
- `startSession`: any approved teacher may start an active set, but never a trashed/purging set.
- Collaborator list is visible only to owner and current collaborators; other teachers see no collaborator identities.

- [ ] **Step 7: Run focused suites**

Run: `node --test --test-name-pattern="collaborator|copy|replaceImages|startSession" tests/firestore-store.test.js`

Run: `firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-concurrency=1 --test-name-pattern=collaborator tests/firestore-rules.test.js"`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add firestore-store.js firestore.rules tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "세트별 공동 편집 권한을 구현"
```

---

### Task 4: 휴지통·복원·idempotent purge 저장소와 Rules

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Consumes: Task 1 retention policy, Task 3 ownership/collaborator helpers.
- Produces: `store.moveSetToTrash(setId)`, `store.restoreSet(setId)`, `store.beginSetPurge(setId, mode)`, `store.continueSetPurge(setId)`, `store.listTrash(scope)`, `store.listExpiredTrash(scope, limit)`.

- [ ] **Step 1: Write transaction RED tests for trash and restore**

Assert server Timestamp usage, owner/content revision check, existing `archived` preservation, collaborator denial, restore refusal after `purgeStartedAt`, and active queries excluding trash.

- [ ] **Step 2: Implement move and restore APIs**

Use transactions. `moveSetToTrash` sets `trashedAt` and increments `contentRevision`; `restoreSet` deletes `trashedAt` only when `purgeStartedAt` is absent and increments `contentRevision`.

- [ ] **Step 3: Write purge RED tests**

```js
test('purge deletes child batches before the parent and resumes idempotently', async () => {
  const result1 = await store.continueSetPurge('set-1');
  assert.deepEqual(result1, { done: false, deleted: 200 });
  const result2 = await store.continueSetPurge('set-1');
  assert.equal(result2.parentDeleted, true);
  assert.equal(writes.at(-1).path, 'quiz_sets/set-1');
});
```

Test crash after collaborator batch, crash after image batch, already missing child, new child creation blocked after purge, and parent never deleted while a child remains.

- [ ] **Step 4: Implement purge phases**

- `beginSetPurge`: transaction verifies owner immediate mode, or admin/owner and `trashedAt + 30 days <= serverNow` for expired mode; writes `purgeStartedAt` once.
- `continueSetPurge`: query and delete at most 200 collaborator/image documents; repeatable on missing documents.
- Before parent deletion, query both child collections with `limit(1)`. If both are empty, a transaction re-reads the parent, verifies the captured purge identity, then deletes only the set parent. Rules forbid new collaborator/image creation after purge starts, so no child can appear between the empty queries and parent deletion.
- Never touch `sessions` or descendants.

- [ ] **Step 5: Write Emulator time and authorization matrix**

Cover owner trash/restore/immediate purge; collaborator/other teacher denial; admin denial at 30 days minus 1 ms; admin success at exact 30-day `request.time`; active-set purge denial; purge-state edit/restore/session/copy denial; child delete only during valid purge; parent delete only after empty children.

- [ ] **Step 6: Implement Rules transitions**

Use `request.time` for `trashedAt`/`purgeStartedAt`, allow only exact protected-field transitions, and use `getAfter` for child deletions paired with valid purging parent state where a parent revision write is required. Keep request expression count under the Emulator maximum-bound tests.

- [ ] **Step 7: Run focused Node and Emulator suites**

Run: `node --test --test-name-pattern="trash|restore|purge" tests/firestore-store.test.js tests/collaboration-trash-core.test.js`

Run: `firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-concurrency=1 --test-name-pattern=trash\|purge tests/firestore-rules.test.js"`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add firestore-store.js firestore.rules tests/firestore-store.test.js tests/firestore-rules.test.js
git commit -m "30일 휴지통과 재개 가능한 영구 삭제를 구현"
```

---

### Task 5: 세트 목록·공동 편집자·휴지통 UI

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 store APIs.
- Produces: `screenTrash()`, `openCollaboratorDialog(setId)`, `setMoveToTrash(setId)`, `setRestoreFromTrash(setId)`, `setPurgeNow(setId)`, collaborator-aware `setListRow`.

- [ ] **Step 1: Write failing rendering tests**

Use existing extracted-inline-script harness. Assert:

```text
owner: edit + collaborators + trash
collaborator: edit + collaboration badge, no collaborator/trash controls
other teacher/admin: copy/start only
trashed item: absent from normal list
trash screen: remaining days + restore + typed permanent-delete confirmation
purging item: cleanup-in-progress, no restore
```

- [ ] **Step 2: Run focused UI tests and confirm RED**

Run: `node --test --test-name-pattern="공동 편집|휴지통" tests/firestore-store.test.js`
Expected: FAIL on missing rendering/actions.

- [ ] **Step 3: Implement list state and card actions**

Extend normalized set records with `trashedAt`, `purgeStartedAt`, and computed access. Add top-level `휴지통 (N)` button. Keep `archived` filtering independent.

- [ ] **Step 4: Implement collaborator dialog**

Owner-only dialog loads collaborator list, canonicalizes input, calls `addCollaborator`, renders exact errors for owner/duplicate/unapproved/limit, and supports confirmed removal. Escape every displayed email.

- [ ] **Step 5: Implement trash screen and actions**

- Move: confirmation names the set and explains 30-day retention.
- Restore: available only before purge.
- Immediate purge: requires exact set name input and displays preserved session scope.
- Network failure keeps the current state and offers retry; no optimistic parent removal before store confirmation.

- [ ] **Step 6: Handle live permission loss**

On collaborator listener removal, owner trash transition, or `permission-denied` during save, clear the editor draft only after offering a local JSON export, run editor/player cleanup, and route to the list with a precise message. Do not overwrite the server with stale local state.

- [ ] **Step 7: Run UI-focused and full non-Emulator tests**

Run: `node --test --test-name-pattern="공동 편집|휴지통|permission" tests/firestore-store.test.js`

Run: `node --test tests/*.test.js`

Expected: all non-Emulator tests PASS; Emulator-only tests SKIP outside Emulator.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/firestore-store.test.js
git commit -m "공동 편집자와 휴지통 화면을 추가"
```

---

### Task 6: 관리자 교사 관리 UI와 무료 로그인 정리 조정

**Files:**
- Modify: `index.html`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/collaboration-trash-core.test.js`

**Interfaces:**
- Consumes: Task 2 allowlist APIs, Task 4 expired trash APIs.
- Produces: `admTeacherAccounts()`, `admSaveTeacherAllowance()`, `startTrashMaintenance(authGeneration)`, `stopTrashMaintenance()`, `runTrashMaintenancePage()`.

- [ ] **Step 1: Write admin UI RED tests**

Assert admin sees account tab/list/add/role/disable, teacher does not, current admin self-disable and self-downgrade controls are disabled, canonical email is used, and stale auth generation cannot publish results.

- [ ] **Step 2: Implement teacher account management tab**

Render only after `requireAdmin`. Add canonical email validation, role select, explicit confirmation for disabling another admin, and server-confirmed refresh after writes. Never expose allowlist to non-admin routes.

- [ ] **Step 3: Write maintenance scheduler RED tests**

Cover:

```text
teacher processes only owned expired/purging sets
admin processes all expired/purging sets in pages
one purge in flight at a time
sign-out/account switch stops the loop immediately
failure schedules one bounded retry and shows warning
app entry is not blocked by maintenance failure
no work before server clock and auth approval are current
```

- [ ] **Step 4: Implement login-triggered maintenance**

Start after auth generation, approval, and clock synchronization succeed. Use a chained single-flight loop, page limit 20, one set purge at a time, and stop on screen/auth generation change. Run one normal pass per login and retry only failed/incomplete purge items.

- [ ] **Step 5: Add user-visible retention explanation**

Trash screen copy: “30일은 최소 보관 기간입니다. 무료 운영 방식이라 관리자나 소유자가 접속할 때 자동 정리됩니다.” Admin warning includes failed set ID and retry button without displaying private student data.

- [ ] **Step 6: Run focused and full Node tests**

Run: `node --test --test-name-pattern="교사 계정 관리|trash maintenance|30일" tests/firestore-store.test.js tests/collaboration-trash-core.test.js tests/release-copy.test.js`

Run: `node --test tests/*.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/firestore-store.test.js tests/collaboration-trash-core.test.js
git commit -m "관리자 교사 승인과 무료 휴지통 정리를 연결"
```

---

### Task 7: 문서·전체 검증·실제 브라우저 수용

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF-2026-08-14.md`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: Tasks 1–6 complete application and Rules.
- Produces: 운영 절차, 복구 지침, 실제 두-admin 수용 증거.

- [ ] **Step 1: Update user and operator documentation**

Document collaborator roles, owner-only delete, trash versus archive, 30-day minimum retention, login-triggered cleanup limitation, admin allowance UI, preserved session history, purge retry, and rollback. Remove the old statement that set deletion is impossible.

- [ ] **Step 2: Add release-copy assertions**

Assert README contains `공동 편집자`, `휴지통`, `30일`, `접속할 때 자동 정리`, and `과거 수업 기록은 보존`; assert it no longer says deletion is intentionally disabled.

- [ ] **Step 3: Run full static and Emulator suites**

Run: `pnpm test && pnpm test:rules && git diff --check`
Expected: all PASS.

- [ ] **Step 4: Run local real-browser acceptance with two admin accounts**

Use `jbhealth17@gmail.com` as owner and `ilovewisdom@g.jbedu.kr` as collaborator:

1. Owner adds the second admin as collaborator to a test copy.
2. Both accounts edit distinct fields sequentially and observe synchronization.
3. Owner removes collaborator while second editor is open; second save is denied and private DOM is cleared.
4. Owner moves the set to trash; it disappears from collaborator list/direct start.
5. Owner restores it and verifies content/images.
6. Owner trashes again and performs typed immediate purge; sessions remain visible in admin history.
7. Create an Emulator/test-project fixture at 30 days minus 1 ms and exact 30 days; only the exact-boundary item is purged.
8. Interrupt purge after one child batch and verify next login resumes.
9. Admin adds a teacher, changes role, disables it, and cannot disable self.
10. App/Firestore console warnings and errors are zero; extension-origin messages are recorded separately.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/HANDOFF-2026-08-14.md tests/release-copy.test.js
git commit -m "공동 편집과 휴지통 운영 절차를 문서화"
```

---

### Task 8: 전체 독립 검토와 단계적 운영 배포

**Files:**
- Modify: `collaboration-trash-core.js`
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `index.html`
- Modify: `README.md`
- Modify: `docs/HANDOFF-2026-08-14.md`
- Modify: `tests/collaboration-trash-core.test.js`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: clean Tasks 1–7 branch and verified production project `video-quiz-65798`.
- Produces: reviewed GitHub Pages release and deployed Firestore Rules.

- [ ] **Step 1: Request full-branch independent review**

Review base..HEAD against this plan and spec. Treat unauthorized edit/delete, premature purge, orphan child leakage, last-parent early deletion, auth-generation stale writes, Firestore expression/write limits, and session history deletion as Critical/Important.

- [ ] **Step 2: Fix and scoped re-review all Critical/Important findings**

Use TDD for every fix. One reviewer must confirm each finding addressed and identify no new Critical/Important breakage.

- [ ] **Step 3: Run final merged-tree verification**

Run: `pnpm test && pnpm test:rules && git diff --check && git status --short`
Expected: all tests PASS and tracked worktree clean.

- [ ] **Step 4: Predeploy additive app code**

Fast-forward merge to `main`, rerun tests on merged `main`, push `main`, and verify GitHub Pages loads. Do not deploy new Rules until both admin accounts can still sign in under the current Rules.

- [ ] **Step 5: Verify production compatibility**

Using trusted Admin SDK credentials, count existing sets with `trashedAt`, `purgeStartedAt`, and collaborator children. Expected before first release: zero new-state documents unless created by the acceptance fixture. Verify both current admin allowlist documents are readable by the new admin UI and acquire audit fields on first update without losing roles.

- [ ] **Step 6: Deploy Firestore Rules**

Run: `firebase deploy --only firestore:rules --project video-quiz-65798`
Expected: compile and release succeed.

- [ ] **Step 7: Run production smoke acceptance**

Create a disposable test copy, add/remove the second admin as collaborator, trash/restore it, then typed-delete it. Confirm original sets and all historical sessions remain. Do not manufacture a 30-day production timestamp; exact-boundary purge remains an Emulator/test-project proof.

- [ ] **Step 8: Preserve reports and document final state**

Record commit, Rules deployment timestamp, test counts, disposable set ID, observed browser results, and any plugin/environment-only errors in the handoff report. Keep production migration reports outside git unless the user explicitly approves committing operational identifiers.
