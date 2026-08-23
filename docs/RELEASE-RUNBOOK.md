# 통합 운영 릴리스 런북

이 문서만 production 릴리스 **전체 순서의 authoritative source**다. 기능별 문서는 데이터 계약과 개별 CLI 인자만 설명하며 별도 배포 순서를 정의하지 않는다. 이 문서 자체는 실행 완료 증거가 아니며, restricted manifest와 각 non-overwriting durable report의 exact readback만 완료 여부를 증명한다.

## 중단 원칙

- exact project ID, Auth/Firestore 환경, 현재 Rules release, static app commit, Firestore export/backup, rollback 대상을 한 change record에 먼저 고정한다.
- 모든 CLI는 새 restricted output path를 사용한다. `.reserved`와 최종 JSON을 보존하고 기존 파일을 덮어쓰지 않는다. 이메일·UID·set ID가 들어갈 수 있는 상세 보고서는 운영 담당자만 읽을 수 있게 보관한다. 일반 stdout은 상태와 count만 기록한다.
- `.release-artifacts/`와 `.release-maintenance/`는 restricted local-only 경로이며 어떤 파일도 stage하지 않는다. 특히 `.release-maintenance/r19-firestore-rules-release.js`는 응답 유실 당시의 격리된 incident evidence일 뿐 non-executable이다. 복구 helper나 운영 명령으로 실행하는 것을 금지한다.
- `complete`, 안전 판정, zero-finding, exact token/generation 가운데 하나라도 없거나 scan이 partial이면 즉시 중단한다. unsafe 보고서를 사람이 “괜찮음”으로 덮어쓰지 않는다.
- legacy의 안전한 한국어 표시 이름은 그대로 허용한다. blank, 이메일 모양, 정규화 owner email, UID와 동일하거나 UID 모양인 공개 표시 이름은 public audit finding이므로 먼저 authoritative allowance를 명시적으로 교정하고 다시 감사한다. 자동 추정·자동 공개 backfill은 하지 않는다.
- 같은 canonical email의 legacy mirror가 다른 UID를 가리키거나 UID가 없는 상태에서 새 승인을 시도하면 자동 병합·덮어쓰기를 하지 않는다. Firebase Auth provider collision을 조사해 기존 로그인 방법을 안내하고, 사람이 exact Auth UID를 결정한 뒤 access migration/audit로 mirror와 `teacher_allowances/{uid}`를 한 identity로 맞춘다.

## 고정 릴리스 순서

아래 `R0`부터 `R15`까지를 순서대로 한 번만 수행한다.

### R0 — 변경 창과 로컬 증거 고정

Password Policy 최소 길이 8·Enforcement `Require`, authorized domain, 이메일 인증/비밀번호 재설정 템플릿을 확인하되 Email/Password provider는 끈 상태로 둔다. backup과 rollback Rules/app를 기록하고 아래 로컬 검증을 순서대로 통과시킨다.

릴리스 시작 전에 서로 다른 lowercase UUID인 `<R23_WINDOW_UUID>`와 `<R23_CONTROL_UUID>`를 생성해 change record에 고정한다. 아래 모든 R0/R2–R8 production evidence CLI에는 두 값을 exact `--window-id`와 `--control-id`로 전달한다. CLI가 실제 실행 시각의 `capturedAt`과 `projectId`, `targetMode`, `tool`, `schemaVersion: 2`를 report 자체에 기록하므로, manifest wrapper만 바꾸거나 과거 report bytes를 복사해서는 새 창의 증거가 될 수 없다. 모든 명령은 exact worktree `C:\Users\user\Desktop\영상퀴즈\.worktrees\email-auth-public-library`에서 실행하고, 모든 R23 output은 그 worktree의 exact restricted root `C:\Users\user\Desktop\영상퀴즈\.worktrees\email-auth-public-library\.release-artifacts\2026-08-23` 바로 아래에 둔다.

```powershell
pnpm test
pnpm test:rules
node --check rules-source-metrics.js
node --check scripts/test-production-rules-source.js
node --check scripts/diagnose-rules-api.js
node --check scripts/read-auth-provider-off.js
node --check scripts/start-r23-quiescence.js
node --check scripts/read-firestore-index-readiness.js
node --check scripts/adopt-existing-ruleset.js
git diff --check
```

그 다음, 어떤 production mutation보다 먼저 exact production Rules source를 공식 `projects.test` API로 읽기 전용 검증한다.

```powershell
pnpm test:rules:production-source --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-production-rules-probe.json
```

`r23-production-rules-probe.json`은 새 restricted output 경로여야 하며 `.reserved`와 JSON을 모두 보존하고 기존 파일을 덮어쓰지(overwrite) 않는다. 이 probe는 `rulesets.create` 또는 release update를 절대로 호출하지 않는다. source budget 초과 또는 실패면 즉시 중단한다. Rules API HTTP 5xx이면 즉시 중단한다. `issueCounts.error`가 ERROR 0이 아니면 즉시 중단한다. `issueCounts.unknown`이 0이 아니거나 `status: "complete"`, `safeToCreateRuleset: true`가 아니거나 없으면 즉시 중단한다. report의 SHA-256과 metrics를 manifest의 exact LF-only `firestore.rules` bytes와 다시 대조한다.

같은 R0에서 R1을 시작하기 전에 GET-only R23 Rules API diagnosis를 새 non-overwriting 경로에 실행한다.

```powershell
pnpm diagnose:rules-api --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --expect-sha c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d --output .release-artifacts/2026-08-23/r23-rules-api-diagnosis.json
```

`--expect-sha`가 있으면 `status: "complete"`는 readable exact matching Ruleset이 정확히 하나이고 `writeLanded: true`일 때만 허용된다. 0개, 둘 이상, unreadable 후보, `writeLanded: false | null`은 모두 `indeterminate` 또는 failure이므로 nonzero로 중단한다. 이 진단은 GET만 사용하며 모든 GET에 bounded timeout/abort를 적용한다.

마지막 R0 gate로 Identity Toolkit Admin v2의 `GET https://identitytoolkit.googleapis.com/admin/v2/projects/video-quiz-65798/config`를 읽는 전용 도구를 실행한다. 실행 주체에는 read-only IAM permission `firebaseauth.configs.get`이 필요하다.

```powershell
pnpm release:auth-provider-off:r23 --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-auth-provider-off.json
```

`r0AuthProviderOff`는 exact config name, 명시적인 `signIn.email.enabled: false`, `providerStateVerified: true`, `providerStillOff: true`, `writeCount: 0`, `error: null`을 가진 `auth-email-password-off-evidence` schema v2 report여야 한다. 403, missing `enabled`, malformed config/name, enabled provider 결과는 모두 fail-closed다. raw config는 report에 쓰지 않으며 manual provider success JSON 작성은 금지하고 계약 검증에서 거부한다.

### R1 — exact write-quiescence 시작

정적 앱 배포나 화면 배너를 quiescence로 간주하지 않는다. trusted Admin migration과 수동 콘솔 쓰기를 먼저 중지하고 단일 운영자 직렬화를 시작한 뒤 아래 CLI를 한 번 실행한다. 이 강제 수단이 없거나 다른 writer가 관찰되면 릴리스를 시작하지 않는다.

```powershell
pnpm release:quiescence:r23 --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-quiescence.json
```

R1 도구는 Cloud Functions v1/v2 전체 location inventory와 Cloud Scheduler location/job 전체 inventory의 authoritative read가 모두 성공한 뒤에만 진행한다. Cloud Function이 하나라도 있거나 Scheduler job이 `PAUSED`/`DISABLED`가 아니거나, 403·unknown·partial pagination이면 PATCH 전에 fail-closed로 중단한다. 검증 성공 뒤에도 PATCH 전에 fixed deny-all Ruleset source를 GET하고 SHA-256 `cd5089e4e5116dbb994013dc5fd5e7e411ec348935b8d06d13acd00173cca15b`와 exact 일치시킨다. 이어 현재 release와 exact pre-PATCH immutable Ruleset source를 GET해 name, `updateTime`, source SHA를 기록한다. 이 pre-PATCH Ruleset만 rollback target으로 허용한다.

target PATCH는 한 번만 시도하고 응답 성공·실패·유실과 관계없이 release를 authoritative GET으로 재조정한다. 성공 계약은 2xx와 exact deny readback인 `response-success`, 또는 non-2xx/유실 응답 뒤 exact deny readback인 `landed-reconciled`뿐이다. settled non-2xx와 exact unchanged baseline은 `definitely-not-landed`로 실패하며 rollback하지 않는다. settled known mismatch는 exact pre-PATCH Ruleset으로만 rollback한 뒤 GET으로 `mismatch-rolled-back` 또는 `mismatch-rollback-failed`를 기록한다. target transport loss 뒤 exact deny가 아닌 결과나 unreadable reconciliation은 `mutation-outcome-unknown`이며 speculative rollback을 금지하고 실행하지 않는다. exact deny 상태 뒤 anonymous Firestore GET 403까지 확인되어야 한다. `r1Quiescence`는 `tool: "r23-quiescence-evidence"`, `schemaVersion: 2`, report-authored identity, pinned source/readback, prior source, provider inventory, PATCH/reconciliation/final-state, data write count 0, `error: null`, `status: "complete"`를 기록한다. 사람이 success JSON을 작성하거나 빈 값을 성공으로 채우지 않는다.

deny-all Ruleset barrier는 R10 target PATCH와 뒤이은 strict target Ruleset exact GET readback까지 유지한다. strict readback이 성공하면 deny-all barrier는 끝나며 그 **종료 시각**을 기록한다. 이는 migration lock과 같은 뜻이 아니다. set counter·teacher access·session migration lock과 단일 운영자 직렬 실행은 R13 exact unlock까지 계속되고, 그 **lock/직렬화 종료 시각**을 deny-all 종료 시각과 별도 기록한다. quiescence 중에는 정적 maintenance app을 먼저 배포하지 않는다.

### R2 — lifecycle migration과 전수 감사

`migrate:lifecycle` production dry-run → apply → 새 dry-run 순서로 실행한다. apply durable report는 `status: "complete"`, `safeToDeployStrictRules: true`여야 한다. 마지막 dry-run은 도구의 dry-run fail-closed schema대로 `safeToDeployStrictRules: false`를 유지하되 `status: "complete"`, `appliedCount: 0`, planned count 0, legacy lifecycle 누락·불일치·orphan 0을 별도로 확인한다. `publication_lifecycle_gates/current`와 owner lock이 active/stale/malformed이면 blind delete하지 말고 exact operation 복구 또는 Admin 조사 뒤 paired 상태로 해소한다.

```powershell
pnpm migrate:lifecycle --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-lifecycle-dry-before.json
pnpm migrate:lifecycle --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --apply --confirm-project video-quiz-65798 --output .release-artifacts/2026-08-23/r23-lifecycle-apply.json
pnpm migrate:lifecycle --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-lifecycle-dry-after.json
```

### R3 — collaborator share index 보정

`migrate:collaborator-shares` production dry-run → exact-project apply → 새 dry-run을 직렬 실행한다. 최종 `safeToUseShareIndex: true`, planned write/delete 0, orphan/malformed 0을 요구한다. 상세 이메일/set finding은 restricted durable report에만 남고 stdout에는 비식별 count만 남아야 한다.

```powershell
pnpm migrate:collaborator-shares --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-shares-dry-before.json
pnpm migrate:collaborator-shares --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --apply --confirm-project video-quiz-65798 --output .release-artifacts/2026-08-23/r23-shares-apply.json
pnpm migrate:collaborator-shares --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-shares-dry-after.json
```

### R4 — set counter lock/apply/audit

`migration_gates/set_counters`를 예측 불가능한 `lockId`로 잠그고 server `updateTimeGeneration`을 기록한다. 같은 lock identity 아래 `migrate:counters` apply와 post-audit를 실행해 `safeToDeployStrictRules: true` 및 missing/invalid/mismatch/orphan 0을 확인한다. 잠금은 R13까지 유지한다.

```powershell
pnpm gate:counters --action lock --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --confirm-project video-quiz-65798 --admin-uid <ADMIN_UID> --output .release-artifacts/2026-08-23/r23-counter-lock.json
pnpm migrate:counters --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --apply --confirm-project video-quiz-65798 --gate-id <R4_LOCK_ID> --output .release-artifacts/2026-08-23/r23-counter-apply.json
pnpm migrate:counters --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --gate-id <R4_LOCK_ID> --output .release-artifacts/2026-08-23/r23-counter-audit.json
```

### R5 — teacher access exact lock/apply

access migration dry-run 뒤 예측 불가능한 token으로 exact lock/apply를 실행한다. Auth UID, canonical email, role/status, authoritative allowance와 legacy mirror의 single-UID parity를 전수 감사한다. `status: "complete"`, `strictReady: true`, `safeToDeployStrictRules: true`, clean audit, exact `lockToken`, `migrationGeneration`, `updateTimeGeneration`을 기록하고 R13까지 잠근다.

```powershell
pnpm migrate:teacher-access --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --admin-uid <ADMIN_UID> --output .release-artifacts/2026-08-23/r23-teacher-access-dry.json
pnpm migrate:teacher-access --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --admin-uid <ADMIN_UID> --lock-token <R5_LOCK_TOKEN> --apply --confirm-project video-quiz-65798 --output .release-artifacts/2026-08-23/r23-teacher-access-apply.json
```

### R6 — session join lock/recount/completion gate

session counter dry-run 뒤 별도 token으로 join lock/apply를 실행한다. 모든 non-ended session/student를 recount하고 `preflightNonEndedLegacyCount: 0`, invalid student/counter 0, exact operational lock generation과 `migration_gates/session_counters` completion generation, `safeToDeployStrictRules: true`를 확인한다. operational lock은 R13까지 유지한다.

```powershell
pnpm migrate:session-counters --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --admin-uid <ADMIN_UID> --output .release-artifacts/2026-08-23/r23-session-counters-dry.json
pnpm migrate:session-counters --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --admin-uid <ADMIN_UID> --lock-token <R6_LOCK_TOKEN> --apply --confirm-project video-quiz-65798 --output .release-artifacts/2026-08-23/r23-session-counters-apply.json
```

### R7 — public privacy/lifecycle 감사

`audit:public-library` production read-only audit를 bounded budget과 새 restricted output으로 실행한다. `complete: true`, `safeToDeployPublicLibrary: true`, `findings: []`를 요구한다. PII key뿐 아니라 author label의 값-level 안전성, authoritative allowance parity, source lifecycle/revision, child schemaVersion, orphan child/audit/lock/gate를 모두 0으로 확인한다.

```powershell
pnpm audit:public-library --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --max-documents 5000 --output .release-artifacts/2026-08-23/r23-public-library-audit.json
```

### R8 — composite index 배포와 build 대기

검토된 `firestore.indexes.json`의 `published_quiz_sets(status ASC, updatedAt DESC, __name__ DESC)` index를 배포하고 Firebase가 build 완료를 보고할 때까지 기다린다. building/error이면 다음 단계로 가지 않는다. 이 단계는 Rules 또는 static app 배포가 아니다.

build 완료가 예상되면 committed tool로 exact required Firestore index 하나를 GET-only로 읽는다.

```powershell
pnpm release:index-readiness:r23 --project video-quiz-65798 --target-mode production --window-id <R23_WINDOW_UUID> --control-id <R23_CONTROL_UUID> --output .release-artifacts/2026-08-23/r23-index-readiness.json
```

R8 도구는 exact index resource name, `READY`, `COLLECTION`, `status ASC`, `updatedAt DESC`, `__name__ DESC`, local `firestore.indexes.json` raw SHA-256을 모두 확인한 `schemaVersion: 2` report만 성공으로 만든다. 403, building/error/unknown state, name/definition mismatch 또는 GET 실패는 fail-closed이며, `error: null`과 `writeCount: 0`이 아닌 report는 승인 근거가 아니다. 사람이 `r8IndexReadiness` success JSON을 작성하지 않는다.

### R9 — release manifest 봉인

manifest의 `releaseWindow`는 fresh R23 `windowId`, `controlId`, `openedAt`, `quiescenceStartedAt`, `sealedAt`을 고정한다. `evidence` map은 아래 알려진 key를 빠짐없이 정확히 한 번만 포함하며 unknown key를 허용하지 않는다.

manifest top-level은 `schemaVersion`, `projectId`, `targetMode`, `releaseWindow`, `authProvider`, `quiescence`, `rollback`, `release`, `locks`, `task4`, `evidence`만 정확히 허용한다. `authProvider`는 exact config name, `emailPasswordEnabled: false`, `providerStillOff: true`, evidence window/control/capturedAt을 `r0AuthProviderOff`와 결합한다. 각 nested object도 runbook과 helper가 정한 exact field 집합만 허용하며 top-level 또는 nested의 unknown authorization field는 거부한다.

- `r0ProductionRulesProbe`, `r0RulesApiDiagnosis`, `r0AuthProviderOff`, `r1Quiescence`
- `r2LifecycleDryBefore`, `r2LifecycleApply`, `r2LifecycleDryAfter`
- `r3SharesDryBefore`, `r3SharesApply`, `r3SharesDryAfter`
- `r4CounterLock`, `r4CounterApply`, `r4CounterAudit`
- `r5TeacherAccessDry`, `r5TeacherAccessApply`
- `r6SessionCountersDry`, `r6SessionCountersApply`
- `r7PublicLibraryAudit`, `r8IndexReadiness`

각 evidence entry는 `path`, `sha256`, `windowId`, `controlId`, `capturedAt` exact field만 가진다. `path`는 exact root `C:\Users\user\Desktop\영상퀴즈\.worktrees\email-auth-public-library\.release-artifacts\2026-08-23` 바로 아래의 absolute `r23-*.json`이어야 한다. helper는 root와 파일의 `realpath`를 다시 구하고 direct regular file만 허용하며 traversal, symlink/reparse alias, alternate absolute root, duplicate realpath, 하위 디렉터리 파일을 모두 거부한 뒤 canonical bytes의 SHA-256을 계산한다.

각 report 자체도 manifest entry와 같은 `windowId`, `controlId`, `capturedAt`, `projectId`, `targetMode`, exact `tool`, `schemaVersion: 2`를 가져야 한다. wrapper metadata만 새로 쓴 과거 bytes나 manual Auth/R1/R8 success object는 거부한다. capture 시각은 최대 nanosecond 정밀도의 RFC3339 UTC 문자열로 전부 strict 증가해야 하며 R0 세 보고서는 R1 시작 전, R1~R8은 quiescence 시작 이후와 manifest 봉인 이전이어야 한다. helper는 각 tool의 exact operation/mode/phase, status/safety/zero-finding/zero-dry-write, generation/token, source/compiler/provider/index schema까지 검사한다. R18/R19 report는 응답 유실의 원인 증거로만 보존하며 배포 승인 근거로 사용하지 않는다. deployment authorization으로 제출하면 거부한다. path나 manifest wrapper에서 현재 window/control이라고 주장하는 것만으로 prior-window evidence를 승인하지 않는다.

rollback Rules는 `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`와 exact `sourceSha256`을 manifest에 고정한다. quiescence에는 deny-all release `releaseUpdateTime`, pinned `rulesetSourceSha256`, `rulesetSourceReadbackExact: true`를 고정하고, release에는 tested `firestore.rules` SHA, `firestore.indexes.json` SHA, static app commit을 기록한다. 기록 뒤 quiescence 또는 gate generation이 변하면, 또는 probe hash와 배포 입력이 다르면 R2부터 새 보고서로 다시 시작한다.

### R10 — strict Firestore Rules 배포

R10은 fresh R0~R9 manifest가 명시한 한 가지 branch만 실행한다. `create`와 `adopt-existing`는 상호 배타적이며, 한 창에서 서로 전환하거나 fallback으로 섞지 않는다. create 응답이 non-2xx인 사실은 서버 write의 성공 여부를 증명하지 않는다. R0에서 R1 전에 만든 GET-only diagnosis를 exact hash로 다시 검증하며 R10에서 새 진단으로 교체하지 않는다.

진단의 reconciliation은 실행 권한이 아니라 응답 유실 대조다.

- `writeLanded: true`는 같은 source가 이미 저장됐다는 뜻이므로 create 재시도 금지다.
- `writeLanded: false`는 읽을 수 있었던 후보에 같은 source가 없다는 관찰일 뿐이며, 단독으로 create 권한을 주지 않는다. 새 create는 manifest가 create를 명시하고 모든 R0~R9 approval이 별도로 다시 확인된 create branch에서만 고려한다.
- `writeLanded: null`은 목록·후보 source·페이지 결과가 불완전하거나 판단할 수 없다는 뜻이다. 사람이 조사할 때까지 중단한다.

이번 R19 복구는 create branch가 아니라 사람이 명시적으로 승인한 `adopt-existing` exact Ruleset/exact SHA branch만 쓴다. target `projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1`와 exact SHA `c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d`를 manifest와 CLI에서 모두 고정한다. 목록에서 비슷한 후보를 고르거나 candidate를 자동 선택하지 않는다. 이번 복구에서 `rulesets.create`는 호출하지 않는다.

```powershell
pnpm release:rules:adopt-existing --project video-quiz-65798 --target-mode production --manifest .release-artifacts/2026-08-23/release-manifest-r23.json --ruleset projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1 --expect-sha c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d --expect-manifest-sha <RAW_MANIFEST_SHA256> --output .release-artifacts/2026-08-23/r24-ruleset-adoption.json
```

`<RAW_MANIFEST_SHA256>`은 raw manifest bytes의 trusted lowercase SHA-256이며, 새 non-overwriting output과 `.reserved`를 함께 보존한다. helper는 raw manifest와 모든 fresh evidence, 현재 로컬 commit, LF-only Rules/index hash, clean tracked worktree/index, live gate-state를 다시 검증한다. GitHub Pages는 branch 기반 deploy이므로 `sourceCommit`과 `staticCommit`은 모두 reviewed branch `HEAD`와 exact 같아야 하고 hosted asset allowlist를 쓰지 않는다. repository 전체 tracked worktree와 index가 clean이어야 하며, staged 또는 unstaged tracked 변경이 하나라도 있으면 `CNAME`, `404.html`, 문서 등 파일 종류와 관계없이 중단한다. ignored untracked restricted evidence는 pushed branch input이 아니므로 허용하지만 stage하지 않는다.

helper는 local/gate 검증과 token 획득 뒤 어떤 Rules API operation보다 먼저 immediate pre-PATCH Email/Password config GET을 실행해 exact Identity Toolkit name과 explicit OFF를 재확인한다. 403, missing/malformed/enabled이면 Rules GET/PATCH 전에 중단한다. 그 뒤 target Ruleset을 GET하여 단일 `firestore.rules` source의 exact SHA를 확인하고, rollback Ruleset도 manifest의 exact `sourceSha256`으로 PATCH 전에 GET 검증한다. immediate pre-PATCH release GET은 manifest의 deny-all `projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466`뿐 아니라 quiescence `releaseUpdateTime`과도 exact 일치해야 한다. PATCH 뒤에는 release exact readback을 요구하고 target Ruleset을 다시 GET하여 단일 source SHA를 재검증한다. 이 post-activation GET/SHA와 provider OFF re-read까지 통과한 report만 `safeForStaticDeployment: true`, `providerStateVerified: true`, `providerStillOff: true`다. Auth mutation은 없으므로 `providerMutationAttempted: false`이며 existing-flow smoke readiness를 주장하지 않는다.

알려진 settled PATCH 실패(완전한 실패 응답 또는 target readback mismatch)는 provider를 OFF로 둔 채 recorded rollback `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`으로 자동 rollback하고 exact GET readback을 요구한다. 반대로 PATCH가 전송된 뒤 transport가 끊기거나 timeout되어 `mutation-outcome-unknown`이면 helper는 멈춘다. 이 경우 read-only reconcile과 수동 조사를 수행하고, rollback을 실행하거나 rollback 성공을 주장하지 않는다. 어느 실패도 provider 활성화, legacy fallback 재개, 별도 head/staged Rules 선배포를 허용하지 않는다.

deny-all barrier는 R10 target PATCH를 지나 strict exact readback까지 유지한다. strict readback 직후 deny-all barrier 종료 시각을 기록하지만, migration lock과 single-operator serialization은 R13까지 계속된다. 호환 head/staged Rules를 별도 순서로 선배포하거나 legacy fallback을 다시 열지 않는다.

### R11 — static app 배포

모든 commit-bound code/docs는 merge/push 전에 broad final review를 받는다. R0~R10 operational work는 그 reviewed feature commit을 사용한다. R10의 strict Rules exact readback 뒤, R12/R13 전에만 그 commit을 merge하고 push한 뒤 manifest-bound static app release를 한 번 배포한다. merge/push/deploy 사이에 unreviewed code change를 하지 않는다. 이 런북의 유일한 rollout 순서는 항상 **Rules before static app**이다.

### R12 — 같은 generation post-deploy verify

migration lock과 single-operator serialization을 유지한 채 access/session `--verify-lock`을 apply report의 exact token 및 모든 generation으로 실행한다. set counter gate도 같은 `lockId/updateTimeGeneration`인지 server-read하고 새 read-only counter audit가 clean인지 확인한다. lifecycle/share/public audit도 새 output으로 반복하고 R7의 zero-finding privacy 결과를 다시 요구한다. 어떤 generation 또는 Rules/app hash가 달라져도 unlock하지 않는다.

### R13 — exact unlock

R12가 모두 안전할 때만 session operational lock, teacher access operational lock, set counter lock을 각각 apply report의 exact token/generation으로 명시 해제한다. completion 상태는 삭제하지 않고 legacy fallback도 다시 열지 않는다. unlock report와 새 server generation을 보존하고, 이때의 lock/직렬화 종료 시각을 R10 strict readback 직후 기록한 deny-all barrier 종료 시각과 별도로 남긴다.

### R14 — Email/Password provider gate

Password Policy·domain·template를 다시 확인하고, R10의 새 Rules exact readback과 R12~R13 증거가 모두 같은 manifest에 있을 때도 provider는 아직 OFF로 유지한다. 먼저 기존 Google admin, 기존 Google teacher, anonymous student의 로그인·권한·수업 join/end smoke를 수행하고 console error 0을 확인한다. 이 existing-flow smoke가 모두 통과한 뒤에만 Email/Password provider를 활성화한다. Google과 Anonymous provider는 유지한다. provider 활성화는 allowance를 만들거나 계정을 자동 병합하지 않는다. 자동화할 수 없는 Firebase Console owner 조작, 실제 inbox 클릭, 또는 admin approval이 필요하면 추정하지 말고 그 지점에서 `NEEDS_CONTEXT`로 중단한다.

### R15 — controlled smoke와 change window 종료

일반 트래픽을 열기 전에 R14에서 통과한 기존 흐름에 이어 Email/Password `signup` → 한국어 verification email 실제 수신·클릭 → verified teacher request → admin approval → login → password reset → public-library copy 순서의 controlled smoke를 수행한다. private source 문서·이메일·UID가 public projection, copy, console, 일반 stdout에 노출되지 않고 console error가 0이어야 한다. provider collision 안내, 공개 author 비식별 표시, 게시/복사/철회/moderation도 확인한다. 성공 증거를 기록한 뒤에만 일반 client 접근과 trusted writers를 열고 전체 change window를 종료한다. 이는 R10 strict exact readback 직후 이미 끝난 deny-all barrier의 종료가 아니다. recorded rollback ruleset은 이 provider smoke 완료까지 보존하며, 모든 smoke 완료 뒤에도 manifest의 rollback history에서 삭제하지 않는다.

## 롤백

알려진 settled PATCH 실패 또는 strict readback mismatch라면 일반 traffic과 trusted writer를 계속 차단하고 provider를 새로 켰다면 먼저 다시 끈다. `projects/video-quiz-65798/releases/cloud.firestore`를 recorded rollback ruleset `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`로 update하고 GET의 exact `rulesetName` readback을 확인한다. 단, 전송된 PATCH의 응답 유실·transport timeout인 `mutation-outcome-unknown`은 settled failure가 아니다. 이 경우 자동 rollback을 시도하거나 rollback됐다고 주장하지 말고, provider OFF·lock·single-operator serialization을 유지한 채 read-only reconciliation과 수동 incident 조사를 한다. 데이터, Auth 사용자, allowance, 이미 withdrawn인 publication, 독립 사본은 삭제하거나 역변환하지 않는다. 기록한 직전 호환 **Rules를 먼저 복원**하고 적용을 확인한 뒤 직전 static app commit을 복원한다. 즉 롤백도 Rules before static app 순서를 유지한다. migration/completion gate는 blind delete하지 않고 exact report identity로 재감사한다. rollback smoke까지 통과한 뒤에만 전체 change window를 종료한다.
