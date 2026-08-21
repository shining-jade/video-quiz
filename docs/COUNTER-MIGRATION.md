# Authoritative counter migration 운영 절차

이 문서는 `quiz_sets.collaboratorCount`와 `quiz_sets.imageCount`의 lock/apply/audit/unlock 명령 계약만 설명한다. 전체 릴리스 순서는 오직 [`RELEASE-RUNBOOK.md`](./RELEASE-RUNBOOK.md)의 R0~R15가 authoritative하다. 과거의 앱 push → staged Rules → counter 순서는 폐기했다. 이 구현 작업에서는 production migration이나 deploy를 실행하지 않았다.

## 안전 경계

- R1의 externally enforced exact write-quiescence가 확인된 뒤에만 시작한다. counter gate는 다른 client/Admin writer 차단을 대신하지 않는다.
- `migration_gates/set_counters`는 예측 불가능한 `lockId`, exact project/target mode, server `updateTimeGeneration`에 묶인다.
- 모든 output은 새 restricted path를 사용하고 `.reserved`와 최종 JSON을 보존한다.
- apply 전, transaction마다, post-audit 전후에 같은 server gate identity/generation을 확인한다.
- `status: "complete"`, `safeToDeployStrictRules: true`, missing/invalid/mismatch/orphan 0이 아니면 잠금을 유지하고 중단한다.
- R4에서 잠근 gate는 strict Rules → static app → R12 같은-generation verify가 끝날 때까지 유지하고 R13에서만 exact unlock한다.

## R4 — lock, apply, audit

현재 승인 admin UID와 exact project를 별도로 확인한다.

```powershell
pnpm gate:counters -- --action lock --project video-quiz-65798 --target-mode production --confirm-project video-quiz-65798 --admin-uid <ADMIN_UID> --output counter-gate-lock.json
```

보고서의 `status: "complete"`, `gate.locked: true`, 비어 있지 않은 `gate.lockId`, `gate.updateTimeGeneration`을 기록한다. 기존 잠금을 덮어쓰지 않는다.

```powershell
node scripts/migrate-set-counters.js --project video-quiz-65798 --target-mode production --apply --confirm-project video-quiz-65798 --gate-id <LOCK_ID> --output counter-apply.json
```

durable report에서 다음을 모두 요구한다.

- `status: "complete"`
- `safeToDeployStrictRules: true`
- `gate.locked: true`, exact `gate.lockId`, 동일한 `gate.updateTimeGeneration`
- `plannedCount`, `appliedCount`, `concurrentlySkipped`, `concurrentlySkippedCount` 존재
- audit의 missing, invalid, mismatch, orphan child/collaborator/image count 모두 0

오류·partial scan·동시 skip·gate 변경이 있으면 새 output으로 원인을 조사하고 같은 lock 아래 멱등 재실행한다. Rules나 static app을 배포하거나 unlock하지 않는다.

## R12 — post-deploy verify

통합 런북에 따라 strict Rules가 먼저, static app이 다음으로 배포된 뒤에도 write-quiescence와 counter lock을 유지한다. read-only status를 새 보고서로 남기고 apply report의 exact `lockId/updateTimeGeneration`과 비교한다.

```powershell
pnpm gate:counters -- --action status --project video-quiz-65798 --target-mode production --output counter-gate-release-status.json
```

이어 같은 locked gate 아래 새 counter dry-run/audit를 실행해 missing/invalid/mismatch/orphan 0과 안전 판정을 다시 확인한다. identity 또는 generation이 다르면 R13으로 가지 않는다.

## R13 — exact unlock

R12의 전체 release verify가 안전할 때만 apply report의 exact 값을 사용한다.

```powershell
pnpm gate:counters -- --action unlock --project video-quiz-65798 --target-mode production --confirm-project video-quiz-65798 --admin-uid <ADMIN_UID> --gate-id <LOCK_ID> --gate-generation <UPDATE_TIME_GENERATION> --output counter-gate-unlock.json
```

다른 `lockId`, 재작성돼 달라진 generation, 이미 해제된 문서는 모두 거부한다. unlock report에는 이전과 새 server generation을 함께 보존한다. gate 문서를 삭제하거나 완료 증거를 초기화하지 않는다.

## Emulator 검증

Emulator mode는 `demo-*` project와 localhost Firestore/Auth host를 동시에 요구한다. production mode는 Emulator 환경 변수가 남아 있으면 실행 전에 중단한다.

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
node scripts/migrate-set-counters.js --project demo-video-quiz --target-mode emulator --apply --confirm-project demo-video-quiz --gate-id <LOCK_ID> --output <REPORT_PATH>
```
