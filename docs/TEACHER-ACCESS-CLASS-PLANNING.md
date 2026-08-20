# 교사 권한·수업계획 운영 전환 절차

이 문서는 교사 개인 Google 계정 승인, 수업계획·현황판, 교사 탈퇴와 세션 참여 인원 counter를 운영에 반영하는 순서를 고정합니다. 저장소의 도구와 문서는 준비되었지만, 이 작업에서는 운영 migration, Rules 배포, 정적 앱 배포, 실제 계정 변경과 브라우저 인수 검증을 실행하지 않았습니다.

## 절대 조건

- 모든 CLI는 기본이 dry-run이며 `--apply`에는 정확한 `--confirm-project`가 필요합니다.
- 운영 모드는 Firestore/Auth Emulator 환경 변수가 하나라도 남아 있으면 시작하지 않습니다.
- 출력 JSON과 `.reserved`/`.pending` 파일은 덮어쓰지 않습니다. 실행마다 새 경로를 사용하고 함께 보관합니다.
- `safeToDeployStrictRules: true`는 apply 후 권위 있는 재감사와 서버 gate readback까지 끝났다는 뜻입니다. dry-run 보고서만으로 strict Rules를 배포하지 않습니다.
- 겹침 경고는 수업 준비를 돕는 권고이며 수업 시작을 막지 않습니다. 어떤 동시 인원 숫자도 Firebase 무료 할당량을 보장하지 않습니다.
- 교사 계정 purge는 자동 작업이 아닙니다. 30일, 소유 세트 0건, 진행 세션 0건과 실제 class plan 상태를 다시 확인한 관리자가 별도 CLI로 명시 실행합니다.

## 필수 배포 순서

순서를 바꾸거나 안전하지 않은 보고서를 건너뛰지 않습니다.

1. Firestore와 Firebase Auth 대상 프로젝트를 확인하고 Firestore export/백업 및 현재 Rules 원문을 보존합니다.
2. `pnpm test`와 `pnpm test:rules`를 실행해 Node 전체와 Firestore/Admin Emulator 전체가 통과하는지 확인합니다.
3. **호환 head Firestore Rules를 먼저 배포**합니다. 이 Rules는 legacy 세션의 안전 종료는 허용하지만 counter 없는 신규 join은 이미 거부하고, 두 migration lock이 활성화되면 allowance 관리와 모든 신규 join을 닫습니다. 이 단계를 건너뛰면 join 없는 구간을 증명할 수 없습니다.
4. 교사 승인 migration을 production dry-run하고 durable 보고서를 검토합니다.
5. 예측 불가능한 access lock token을 정한 뒤 새 출력 경로로 교사 승인 migration apply를 실행합니다. post-audit mismatch가 0이고 `safeToDeployStrictRules: true`인지 확인하되 lock은 해제하지 않습니다.
6. 세션 counter maintenance dry-run으로 모든 `allocating|active|live` 세션과 실제 `students` 하위 문서를 스캔합니다.
7. 별도의 예측 불가능한 counter lock token으로 세션 counter apply를 실행합니다. CLI는 `migration_gates/session_counter_migration`을 먼저 잠그고 정확한 updateTime generation에 scan/recount/post-audit를 묶은 뒤에만 completion gate를 기록합니다.
8. 두 보고서의 lock token/generation, session `gate.updateTimeGeneration`, `preflightNonEndedLegacyCount: 0`, `safeToDeployStrictRules: true`를 확인합니다.
9. strict Firestore Rules와 정적 앱을 배포합니다.
10. 배포 직후 두 `--verify-lock`을 실행해 apply 보고서와 **같은 token과 모든 generation**임을 다시 확인합니다. access는 operational lock generation과 완료 `migrationGeneration`, session은 operational lock generation과 별도 completion gate generation이 모두 같아야 합니다. 하나라도 바뀌었으면 사후 audit 뒤 race가 있었으므로 안전을 주장하지 말고 중단합니다.
11. 검증된 access lock과 session lock을 각각 apply 보고서의 정확한 token/generation으로 명시 해제합니다. 두 completion 상태는 삭제하지 않습니다. access unlock은 운영 잠금만 풀며 legacy fallback을 다시 열지 않습니다.
12. 관리자 1명, 일반 교사 2명, 겹치는 수업 2개와 학생 세션 2개로 실제 브라우저 smoke를 수행합니다.
13. rollback commit, 배포 전 Rules, 백업 위치와 모든 migration·verify·unlock 보고서를 같은 운영 기록에 보존합니다.

활성 legacy 세션, 누락 counter, 학생 문서 UID 불일치, 잘못된 allowance UID/email/role/status/Timestamp, Auth 조회 실패, 부분 스캔, gate generation 변경 또는 `safeToDeployStrictRules !== true`가 하나라도 있으면 즉시 중단합니다.

## 1. 자동 검증

```powershell
pnpm test
pnpm test:rules
node --check scripts/migrate-teacher-access-status.js
node --check scripts/migrate-session-counters.js
node --check scripts/purge-teacher-account.js
```

Emulator 실행은 `demo-video-quiz`만 사용합니다. 운영 자격 증명이나 실제 프로젝트 ID를 Emulator 테스트에 넣지 않습니다.

## 2. 교사 승인 상태 migration

`<ADMIN_UID>`는 현재 운영 admin의 Firebase Authentication UID입니다. 도구는 `teacher_allowlist/{canonicalEmail}`을 Firebase Auth의 검증된 Google 사용자와 일치시키고 `teacher_allowances/{uid}`를 만듭니다. 활성 legacy 문서는 `status: active`, 비활성 문서는 `status: suspended`가 됩니다. UID, canonical email, role, enabled/status, administrative hold와 Firestore Timestamp를 모두 재감사합니다.

Dry-run:

```powershell
pnpm migrate:teacher-access -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --output teacher-access-dry-run.json
```

Apply와 post-audit:

```powershell
pnpm migrate:teacher-access -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --apply --confirm-project video-quiz-65798 --lock-token <ACCESS_LOCK_TOKEN> --output teacher-access-apply.json
```

다음을 모두 확인합니다.

- `status: "complete"`
- `safeToDeployStrictRules: true`
- `audit.invalidLegacyCount`, `missingAuthUserCount`, `invalidAuthIdentityCount`, `missingAllowanceCount`, `allowanceMismatchCount`, `legacyCompatibilityMismatchCount`, `orphanAllowanceCount`가 모두 0
- `concurrentlySkippedCount: 0` 또는 skip 사유를 해결한 새 보고서가 최종적으로 clean
- `lock.locked: true`, `lock.status: "complete"`, `lock.strictReady: true`, 정확한 `lock.lockToken`, 비어 있지 않은 `lock.migrationGeneration`과 `lock.updateTimeGeneration`

Transaction은 초기 scan 뒤 legacy와 allowance를 다시 읽습니다. 그 사이 활성 상태가 바뀌면 현재 값으로 재분류하며 stale 활성 권한을 복원하지 않습니다. 오류 뒤 재시도는 새 출력 경로를 사용합니다.

Clean post-audit 뒤 도구는 잠긴 gate를 `status: "complete"`, `strictReady: true`, exact `migrationGeneration`으로 바꾸고 새 서버 generation을 readback합니다. 그 완료 generation 아래 전수 감사를 한 번 더 실행하고 같은 generation을 재확인해야만 안전을 보고합니다. 이 완료 상태부터 Rules는 UID allowance만 승인 근거로 사용합니다. legacy email 문서는 UID가 포함된 mirror일 뿐이며, admin UI도 동일 transaction에서 authoritative UID allowance가 exact revision으로 바뀌지 않으면 legacy 문서를 쓸 수 없습니다. 명시 unlock은 `locked: false`만 기록하고 완료 상태를 보존하므로 legacy-only 교사나 email-only 변경 경로가 다시 열리지 않습니다.

## 3. 세션 counter maintenance와 completion gate

이 migration은 종료되지 않은 `allocating|active|live` 세션을 전수 읽고 `sessions/{sessionId}/students` 문서를 정확히 셉니다. 학생 문서 ID와 `uid`가 다르면 쓰지 않고 gate를 닫아 둡니다. Apply transaction은 부모와 학생 query를 함께 다시 읽어 동시 join으로 낡은 count를 쓰지 않습니다.

Dry-run maintenance scan:

```powershell
pnpm migrate:session-counters -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --output session-counters-dry-run.json
```

Apply, generation-bound lock, post-audit, completion gate:

```powershell
pnpm migrate:session-counters -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --apply --confirm-project video-quiz-65798 --lock-token <COUNTER_LOCK_TOKEN> --output session-counters-apply.json
```

Apply 내부 순서는 고정되어 있습니다.

1. `migration_gates/session_counter_migration`을 exact token으로 잠그고 서버 `updateTimeGeneration` 기록
2. 같은 lock generation 아래 모든 non-ended session/student scan
3. 매 transaction에서 lock generation 재확인 후 recount/CAS
4. 모든 non-ended session/student post-audit
5. lock generation이 그대로이고 전체 preflight가 0일 때만 `migration_gates/session_counters` 생성
6. completion gate 서버 readback의 정확한 `updateTimeGeneration` 기록
7. 최종 전수 재감사 뒤 lock과 completion gate generation을 모두 재확인

다음을 모두 확인합니다.

- `status: "complete"`
- `audit.preflightNonEndedLegacyCount: 0`
- `audit.invalidStudentCount: 0`
- `gate.created: true`, `gate.projectId: "video-quiz-65798"`, `gate.targetMode: "production"`
- `gate.rulesVersion: "session-counters-v1"`와 비어 있지 않은 `gate.updateTimeGeneration`
- `safeToDeployStrictRules: true`
- `lock.locked: true`, 정확한 `lock.lockToken`, 비어 있지 않은 `lock.updateTimeGeneration`

이미 exact gate가 존재하면 clean 상태에서만 멱등 성공합니다. 다른 project/environment의 gate, invalid gate, gate 이후 발견된 counter 문제는 덮어쓰지 않고 중단합니다.

## 4. strict Rules·정적 앱과 같은-generation 해제

두 apply 보고서가 모두 안전할 때만 아래 운영 단계를 수행합니다. 명령 실행 전 Firebase CLI의 현재 프로젝트와 로그인 계정을 별도 확인합니다.

```powershell
firebase deploy --only firestore:rules --project video-quiz-65798
git push origin main
```

배포 뒤 apply 보고서의 값을 그대로 사용해 lock을 다시 검증합니다.

```powershell
pnpm migrate:teacher-access -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --verify-lock --lock-token <ACCESS_LOCK_TOKEN> --expected-generation <ACCESS_LOCK_GENERATION> --expected-migration-generation <ACCESS_MIGRATION_GENERATION> --output teacher-access-release-verify.json
pnpm migrate:session-counters -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --verify-lock --lock-token <COUNTER_LOCK_TOKEN> --expected-generation <COUNTER_LOCK_GENERATION> --expected-gate-generation <SESSION_GATE_GENERATION> --output session-counter-release-verify.json
```

Access verify는 `migration_gates/teacher_access_status`가 정확한 project/environment/token/updateTime generation을 유지하면서 `status: "complete"`, `strictReady: true`, apply 보고서와 같은 `migrationGeneration`인지 함께 확인합니다. `completedAt`은 실제 Firestore Timestamp여야 하고 `completedByUid`는 현재 검증 admin UID와 일치해야 합니다. 그 뒤 legacy/UID allowance와 Firebase Auth identity를 전수 재감사하고, 같은 gate fields와 updateTime generation을 다시 읽어야만 안전을 보고합니다. Auth/collection read 실패는 partial unsafe 보고서로 남고, operational lock만 맞는 running/false/malformed/stale 상태는 절대 안전으로 판정하지 않습니다.

Session verify는 operational lock인 `migration_gates/session_counter_migration`과 별도 완료 문서 `migration_gates/session_counters`를 모두 읽습니다. 완료 문서는 exact project/environment/rulesVersion/generation, `preflightNonEndedLegacyCount: 0`, Firestore Timestamp인 `verifiedAt`과 `updatedAt`의 완전 일치가 필요합니다. 이어서 모든 non-ended session/student를 다시 감사하고 누락 counter가 0인지 확인한 뒤 두 generation을 다시 readback합니다. 보고서에는 lock과 gate generation, 전수 감사 결과가 함께 남아야 합니다.

문서 누락, `running`, `strictReady: false`, 잘못된 Timestamp/shape, 다른 project/environment, generation 변경 또는 non-ended counter 누락은 durable 보고서를 남기되 `safeToDeployStrictRules: false`이거나 실패여야 합니다. 두 verify 보고서가 complete이고 안전 판정이 true일 때만 exact token/generation으로 명시 해제합니다.

```powershell
pnpm migrate:teacher-access -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --unlock --confirm-project video-quiz-65798 --lock-token <ACCESS_LOCK_TOKEN> --expected-generation <ACCESS_LOCK_GENERATION> --output teacher-access-unlock.json
pnpm migrate:session-counters -- --project video-quiz-65798 --target-mode production --admin-uid <ADMIN_UID> --unlock --confirm-project video-quiz-65798 --lock-token <COUNTER_LOCK_TOKEN> --expected-generation <COUNTER_LOCK_GENERATION> --output session-counter-unlock.json
```

호환 head Rules가 counter migration보다 먼저 배포되므로 counter 없는 legacy session에는 어느 시점에도 신규 학생이 들어갈 수 없습니다. session lock은 이미 counter가 있는 세션의 join까지 유지보수 동안 닫아 scan/apply/post-audit 사이의 틈을 제거합니다.

종료되지 않은 세션의 학생 문서는 admin도 단독 삭제할 수 없습니다. 별도 counted decrement protocol을 도입하기 전까지 학생 삭제는 counter migration lock이 해제된 `ended|aborted` 세션 cleanup에서만 admin 또는 세션 소유자에게 허용됩니다. Lock 중에는 종료된 세션 cleanup도 중단해 verify scan과 삭제가 교차하지 않게 합니다.

Access unlock 뒤에도 `migration_gates/teacher_access_status`의 completion fields를 삭제·초기화하지 않습니다. 재감사 때문에 operational lock을 다시 잡더라도 완료 상태를 보존해야 하며, legacy fallback을 임시로 되살리는 rollback은 허용되지 않습니다.

이 문서는 명령의 승인 자체가 아닙니다. 실제 merge, push, migration apply와 deploy는 독립 보안 검토 및 운영 담당자의 명시 승인 뒤 수행합니다.

## 5. 브라우저 smoke와 개인정보 확인

동일 탭의 앱/Firebase console을 열어 앱 출처 error가 0인지 확인합니다.

1. 미승인 교사 A가 신청→취소→재신청합니다.
2. admin이 A를 승인하고 서버 allowance 재조회 뒤에만 보호 홈/현황판이 나타나는지 확인합니다.
3. 교사 B도 신청하고 admin이 승인합니다.
4. A는 40명, B는 50명의 겹치는 계획을 만듭니다.
5. 두 교사 모두 합계 90 경고를 보고도 서로 다른 세션을 시작할 수 있어야 합니다.
6. 세션마다 실제 학생 1명 이상이 참여하고 actual 참여 합계가 갱신되는지 확인합니다.
7. 일반 교사는 다른 교사의 email/UID를 볼 수 없고 admin만 신원을 보는지 확인합니다.
8. A가 사용 종료를 요청하면 새 세션이 즉시 거부되고, 30일 전 철회 후 올바른 상태로 복구되는지 확인합니다.

실제 계정이나 학생 개인정보를 보고서에 복사하지 않습니다.

## 6. 롤백과 장애 대응

- migration 도중 실패: strict Rules와 앱을 배포하지 말고 `.reserved` 또는 최종 JSON의 누적 결과를 보존합니다. 원인을 해결한 뒤 새 파일명으로 멱등 재시도합니다.
- access apply 뒤 문제: allowance를 임의 삭제하지 말고 기존 Rules/앱을 유지한 채 audit mismatch를 해결합니다.
- session gate 생성 뒤 보고서 실패: gate를 임의 삭제하거나 덮어쓰지 않습니다. 같은 프로젝트에서 migration을 새 출력 경로로 다시 실행해 exact gate generation과 전수 audit를 복구합니다.
- Rules 배포 뒤 문제: 저장해 둔 직전 Rules 릴리스를 복원하고 앱 rollback commit으로 되돌립니다. migration 보고서는 삭제하지 않습니다.
- 계정 purge 실패: `deletion_pending`을 유지하고 소유 세트·진행 세션·class plan과 Firebase Auth 상태를 재감사합니다.
