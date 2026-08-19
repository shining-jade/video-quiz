# Authoritative counter migration 운영 절차

이 문서는 `quiz_sets.collaboratorCount`와 `quiz_sets.imageCount`를 보정할 때 클라이언트 쓰기가 audit와 경합해 잘못된 `safeToDeployStrictRules: true`를 만드는 일을 막기 위한 절차입니다. 이 저장소에서 아래 운영 절차는 문서화와 Emulator 검증만 했으며 **운영 환경에서는 실행하지 않았습니다**.

## 더 안전한 staged 방식

`firebase.counter-migration.json`은 별도의 legacy 허용 Rules를 가리키지 않고 최종 `firestore.rules`를 그대로 사용합니다. 따라서 staged 배포 직후부터 잘못된 legacy counter 쓰기는 fail-closed입니다. gate가 없거나 잠겨 있으면 collaborator/image counter 쓰기와 trash→purge 및 parent 영구 삭제를 모두 거부합니다. 세트·이미지·세션 읽기는 계속 가능합니다.

잠금 문서는 `migration_gates/set_counters` 하나입니다. 승인된 Google `admin`만 Rules를 통해 잠그거나 해제할 수 있습니다. 잠긴 동안 세트·이미지·세션 읽기는 유지되지만 collaborator/image create·update·delete와 purge child delete는 모두 거부됩니다.

## 반드시 지킬 순서

### 1. staged gate Rules 배포

배포 전 현재 프로젝트와 로그인 계정을 별도로 확인합니다.

```powershell
firebase deploy --only firestore:rules --config firebase.counter-migration.json --project video-quiz-65798
```

이 단계는 최종 strict Rules와 같은 파일을 배포하므로 legacy 쓰기 허용 창을 다시 열지 않습니다.

**staged gate Rules 배포 직후 즉시 잠금 단계를 수행해야 합니다.** 배포 성공부터 2단계 잠금 성공까지는 gate가 없는 의도적인 fail-closed 유지보수 구간이며, counter 종속 쓰기와 영구 삭제는 중단됩니다.

### 2. migration_gates/set_counters 잠금

승인된 Google admin의 클라이언트 SDK 세션으로 다음 문서를 `set`하고 서버 성공 응답과 재조회 값을 확인합니다. `<LOCK_ID>`는 이번 작업에만 쓰는 예측 불가능한 새 값이어야 합니다.

```text
migration_gates/set_counters
{
  locked: true,
  lockId: "<LOCK_ID>",
  projectId: "video-quiz-65798",
  targetMode: "production",
  lockedAt: serverTimestamp(),
  lockedByUid: "<CURRENT_ADMIN_UID>"
}
```

다른 교사, 미승인 사용자, stale lock identity, 문서 삭제는 Rules가 거부합니다. 잠긴 문서를 다른 identity로 덮어쓸 수도 없습니다.

### 3. counter migration 및 audit

잠금 재조회가 `locked: true`이고 `lockId`, `projectId`, `targetMode`가 모두 일치할 때만 실행합니다.

```powershell
node scripts/migrate-set-counters.js --project video-quiz-65798 --target-mode production --apply --confirm-project video-quiz-65798 --gate-id <LOCK_ID> --output <REPORT_PATH>
```

도구는 apply 전, 각 transaction, 최종 audit 전후에 같은 서버 gate generation을 확인합니다. 결과 JSON에서 다음을 모두 확인합니다.

```text
status: "complete"
safeToDeployStrictRules: true
gate.locked: true
gate.lockId: <LOCK_ID>
plannedCount / appliedCount / concurrentlySkipped / concurrentlySkippedCount 존재
audit의 missing, invalid, mismatch 수가 모두 0
audit의 orphanChildCount, orphanCollaboratorCount, orphanImageCount가 모두 0
```

오류나 gate 변경이 있으면 `safeToDeployStrictRules`는 false이며, partial report의 누적 수치를 보존합니다. 이때 4단계로 넘어가지 말고 같은 잠금을 유지한 채 원인을 해결하고 다시 audit합니다.

### 4. strict counter Rules 재배포

3단계의 durable report가 `safeToDeployStrictRules: true`일 때만 실행합니다.

```powershell
firebase deploy --only firestore:rules --project video-quiz-65798
```

### 5. 동일 lockId로 잠금 해제

4단계 배포 확인 뒤, 잠근 것과 같은 승인 Google admin 흐름으로 기존 gate를 재조회한 후 정확히 같은 identity를 보존하여 update합니다. gate 문서를 삭제하지 않습니다.

```text
{
  locked: false,
  lockId: "<LOCK_ID>",
  projectId: "video-quiz-65798",
  targetMode: "production",
  lockedAt: <EXISTING_SERVER_TIMESTAMP>,
  lockedByUid: "<EXISTING_ADMIN_UID>",
  unlockedAt: serverTimestamp(),
  unlockedByUid: "<CURRENT_ADMIN_UID>"
}
```

현재 문서와 다른 `lockId`를 사용한 stale unlock 및 일반 교사의 unlock은 거부됩니다.

## Emulator 검증

Emulator mode는 `demo-*` 프로젝트와 고정된 로컬 host를 동시에 요구합니다.

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
node scripts/migrate-set-counters.js --project demo-video-quiz --target-mode emulator --apply --confirm-project demo-video-quiz --gate-id <LOCK_ID> --output <REPORT_PATH>
```

production mode에서 Emulator 환경 변수가 남아 있거나 emulator mode에서 실제 프로젝트 ID를 사용하면 도구가 실행 전에 중단됩니다.
