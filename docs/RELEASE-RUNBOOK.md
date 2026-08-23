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

```powershell
pnpm test
pnpm test:rules
node --check rules-source-metrics.js
node --check scripts/test-production-rules-source.js
node --check scripts/diagnose-rules-api.js
node --check scripts/adopt-existing-ruleset.js
git diff --check
```

그 다음, 어떤 production mutation보다 먼저 exact production Rules source를 공식 `projects.test` API로 읽기 전용 검증한다.

```powershell
pnpm test:rules:production-source --project video-quiz-65798 --target-mode production --output .release-artifacts/2026-08-23/r23-production-rules-probe.json
```

`r23-production-rules-probe.json`은 새 restricted output 경로여야 하며 `.reserved`와 JSON을 모두 보존하고 기존 파일을 덮어쓰지(overwrite) 않는다. 이 probe는 `rulesets.create` 또는 release update를 절대로 호출하지 않는다. source budget 초과 또는 실패면 즉시 중단한다. Rules API HTTP 5xx이면 즉시 중단한다. `issueCounts.error`가 ERROR 0이 아니면 즉시 중단한다. `issueCounts.unknown`이 0이 아니거나 `status: "complete"`, `safeToCreateRuleset: true`가 아니거나 없으면 즉시 중단한다. report의 SHA-256과 metrics를 manifest의 exact LF-only `firestore.rules` bytes와 다시 대조한다.

같은 R0에서 R1을 시작하기 전에 GET-only R23 Rules API diagnosis를 새 non-overwriting 경로에 실행한다.

```powershell
pnpm diagnose:rules-api --project video-quiz-65798 --target-mode production --expect-sha c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d --output .release-artifacts/2026-08-23/r23-rules-api-diagnosis.json
```

`--expect-sha`가 있으면 `status: "complete"`는 readable exact matching Ruleset이 정확히 하나이고 `writeLanded: true`일 때만 허용된다. 0개, 둘 이상, unreadable 후보, `writeLanded: false | null`은 모두 `indeterminate` 또는 failure이므로 nonzero로 중단한다. 이 진단은 GET만 사용하며 모든 GET에 bounded timeout/abort를 적용한다.

### R1 — exact write-quiescence 시작

정적 앱 배포나 화면 배너를 quiescence로 간주하지 않는다. 별도의 운영 접근 제어로 모든 일반 client의 Firebase 읽기·쓰기를 차단하고, scheduler·Cloud Function·trusted Admin migration·수동 콘솔 쓰기를 중지한다. 현재 change window의 단일 운영자만 아래 명시된 CLI를 직렬 실행한다. 차단 시작 시각, 제어 ID, 중지한 writer 목록을 기록한다. 이 강제 수단이 없거나 다른 writer가 관찰되면 릴리스를 시작하지 않는다.

R1은 strict manual schema의 `r1Quiescence` JSON을 만든다. `tool: "r23-quiescence-evidence"`, `schemaVersion: 1`, `projectId`, `targetMode`, R23 `windowId`/`controlId`, `capturedAt`, exact release/ruleset, release `updateTime`, anonymous 403, Cloud Functions API disabled, trusted writers stopped, `writeCount: 0`, `status: "complete"`를 모두 기록한다. 성공 값을 추정하거나 빈 필드를 채워 넣지 않는다.

deny-all Ruleset barrier는 R10 target PATCH와 뒤이은 strict target Ruleset exact GET readback까지 유지한다. strict readback이 성공하면 deny-all barrier는 끝나며 그 **종료 시각**을 기록한다. 이는 migration lock과 같은 뜻이 아니다. set counter·teacher access·session migration lock과 단일 운영자 직렬 실행은 R13 exact unlock까지 계속되고, 그 **lock/직렬화 종료 시각**을 deny-all 종료 시각과 별도 기록한다. quiescence 중에는 정적 maintenance app을 먼저 배포하지 않는다.

### R2 — lifecycle migration과 전수 감사

`migrate:lifecycle` production dry-run → apply → 새 dry-run 순서로 실행한다. apply durable report는 `status: "complete"`, `safeToDeployStrictRules: true`여야 한다. 마지막 dry-run은 도구의 dry-run fail-closed schema대로 `safeToDeployStrictRules: false`를 유지하되 `status: "complete"`, `appliedCount: 0`, planned count 0, legacy lifecycle 누락·불일치·orphan 0을 별도로 확인한다. `publication_lifecycle_gates/current`와 owner lock이 active/stale/malformed이면 blind delete하지 말고 exact operation 복구 또는 Admin 조사 뒤 paired 상태로 해소한다.

### R3 — collaborator share index 보정

`migrate:collaborator-shares` production dry-run → exact-project apply → 새 dry-run을 직렬 실행한다. 최종 `safeToUseShareIndex: true`, planned write/delete 0, orphan/malformed 0을 요구한다. 상세 이메일/set finding은 restricted durable report에만 남고 stdout에는 비식별 count만 남아야 한다.

### R4 — set counter lock/apply/audit

`migration_gates/set_counters`를 예측 불가능한 `lockId`로 잠그고 server `updateTimeGeneration`을 기록한다. 같은 lock identity 아래 `migrate:counters` apply와 post-audit를 실행해 `safeToDeployStrictRules: true` 및 missing/invalid/mismatch/orphan 0을 확인한다. 잠금은 R13까지 유지한다.

### R5 — teacher access exact lock/apply

access migration dry-run 뒤 예측 불가능한 token으로 exact lock/apply를 실행한다. Auth UID, canonical email, role/status, authoritative allowance와 legacy mirror의 single-UID parity를 전수 감사한다. `status: "complete"`, `strictReady: true`, `safeToDeployStrictRules: true`, clean audit, exact `lockToken`, `migrationGeneration`, `updateTimeGeneration`을 기록하고 R13까지 잠근다.

### R6 — session join lock/recount/completion gate

session counter dry-run 뒤 별도 token으로 join lock/apply를 실행한다. 모든 non-ended session/student를 recount하고 `preflightNonEndedLegacyCount: 0`, invalid student/counter 0, exact operational lock generation과 `migration_gates/session_counters` completion generation, `safeToDeployStrictRules: true`를 확인한다. operational lock은 R13까지 유지한다.

### R7 — public privacy/lifecycle 감사

`audit:public-library` production read-only audit를 bounded budget과 새 restricted output으로 실행한다. `complete: true`, `safeToDeployPublicLibrary: true`, `findings: []`를 요구한다. PII key뿐 아니라 author label의 값-level 안전성, authoritative allowance parity, source lifecycle/revision, child schemaVersion, orphan child/audit/lock/gate를 모두 0으로 확인한다.

### R8 — composite index 배포와 build 대기

검토된 `firestore.indexes.json`의 `published_quiz_sets(status ASC, updatedAt DESC, __name__ DESC)` index를 배포하고 Firebase가 build 완료를 보고할 때까지 기다린다. building/error이면 다음 단계로 가지 않는다. 이 단계는 Rules 또는 static app 배포가 아니다.

R8은 committed tool이 아직 직접 만들지 않는 strict manual schema의 `r8IndexReadiness` JSON을 사용한다. exact R23 `windowId`/`controlId`, `capturedAt`, `firestoreIndexesSha256`, required/ready index count, `allRequiredIndexesReady: true`, pending/failed/write count 0, `status: "complete"`를 Firebase readback에서 확인한 값으로만 기록한다. 성공 data를 발명하지 않는다.

### R9 — release manifest 봉인

manifest의 `releaseWindow`는 fresh R23 `windowId`, `controlId`, `openedAt`, `quiescenceStartedAt`, `sealedAt`을 고정한다. `evidence` map은 아래 알려진 key를 빠짐없이 정확히 한 번만 포함하며 unknown key를 허용하지 않는다.

manifest top-level은 `schemaVersion`, `projectId`, `targetMode`, `releaseWindow`, `quiescence`, `rollback`, `release`, `locks`, `task4`, `evidence`만 정확히 허용한다. 각 nested object도 runbook과 helper가 정한 exact field 집합만 허용하며 top-level 또는 nested의 unknown authorization field는 거부한다.

- `r0ProductionRulesProbe`, `r0RulesApiDiagnosis`, `r1Quiescence`
- `r2LifecycleDryBefore`, `r2LifecycleApply`, `r2LifecycleDryAfter`
- `r3SharesDryBefore`, `r3SharesApply`, `r3SharesDryAfter`
- `r4CounterLock`, `r4CounterApply`, `r4CounterAudit`
- `r5TeacherAccessDry`, `r5TeacherAccessApply`
- `r6SessionCountersDry`, `r6SessionCountersApply`
- `r7PublicLibraryAudit`, `r8IndexReadiness`

각 evidence entry는 `path`, `sha256`, `windowId`, `controlId`, `capturedAt` exact field만 가지며 `.release-artifacts/2026-08-23/r23-*.json`을 가리킨다. helper는 모든 path를 다시 열어 raw SHA-256을 계산하고 committed tool의 exact project/mode/status/safety/zero-finding/zero-dry-write/generation/source/compiler schema 또는 위에 명시한 R1/R8 strict schema를 검사한다. R0 두 보고서는 R1 시작 전, R1~R8은 quiescence 시작 이후와 manifest 봉인 이전이어야 한다. R18/R19 report는 응답 유실의 원인 증거로만 보존하며 배포 승인 근거로 사용하지 않는다. deployment authorization으로 제출하면 거부한다. path를 R23으로 바꾸거나 manifest에서 현재 window/control이라고 주장하는 것만으로 prior-window evidence를 승인하지 않는다.

rollback Rules는 `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`와 exact `sourceSha256`을 manifest에 고정한다. quiescence에는 deny-all release `releaseUpdateTime`을 고정하고, release에는 tested `firestore.rules` SHA, `firestore.indexes.json` SHA, static app commit을 기록한다. 기록 뒤 quiescence 또는 gate generation이 변하면, 또는 probe hash와 배포 입력이 다르면 R2부터 새 보고서로 다시 시작한다.

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

`<RAW_MANIFEST_SHA256>`은 raw manifest bytes의 trusted lowercase SHA-256이며, 새 non-overwriting output과 `.reserved`를 함께 보존한다. helper는 raw manifest와 모든 fresh evidence, 현재 로컬 commit, LF-only Rules/index hash, clean deploy inputs, live gate-state를 다시 검증한다. staged/unstaged Rules·deploy input이나 두 restricted 경로 밖의 untracked deploy-root 파일이 있으면 중단한다.

helper는 target Ruleset을 GET하여 단일 `firestore.rules` source의 exact SHA를 확인하고, rollback Ruleset도 manifest의 exact `sourceSha256`으로 PATCH 전에 GET 검증한다. immediate pre-PATCH release GET은 manifest의 deny-all `projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466`뿐 아니라 quiescence `releaseUpdateTime`과도 exact 일치해야 한다. PATCH 뒤에는 release exact readback을 요구하고 target Ruleset을 다시 GET하여 단일 source SHA를 재검증한다. 이 post-activation GET/SHA까지 통과한 report만 `safeForStaticDeployment: true`다. helper는 Auth를 읽거나 바꾸지 않으므로 `providerMutationAttempted: false`, `providerStateVerified: false`를 기록하며 existing-flow smoke readiness를 주장하지 않는다.

알려진 settled PATCH 실패(완전한 실패 응답 또는 target readback mismatch)는 provider를 OFF로 둔 채 recorded rollback `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`으로 자동 rollback하고 exact GET readback을 요구한다. 반대로 PATCH가 전송된 뒤 transport가 끊기거나 timeout되어 `mutation-outcome-unknown`이면 helper는 멈춘다. 이 경우 read-only reconcile과 수동 조사를 수행하고, rollback을 실행하거나 rollback 성공을 주장하지 않는다. 어느 실패도 provider 활성화, legacy fallback 재개, 별도 head/staged Rules 선배포를 허용하지 않는다.

deny-all barrier는 R10 target PATCH를 지나 strict exact readback까지 유지한다. strict readback 직후 deny-all barrier 종료 시각을 기록하지만, migration lock과 single-operator serialization은 R13까지 계속된다. 호환 head/staged Rules를 별도 순서로 선배포하거나 legacy fallback을 다시 열지 않는다.

### R11 — static app 배포

모든 commit-bound code/docs는 merge/push 전에 broad final review를 받는다. R0~R10 operational work는 그 reviewed feature commit을 사용한다. R10의 strict Rules exact readback 뒤, R12/R13 전에만 그 commit을 merge하고 push한 뒤 manifest-bound static app release를 한 번 배포한다. merge/push/deploy 사이에 unreviewed code change를 하지 않는다. 이 런북의 유일한 rollout 순서는 항상 **Rules before static app**이다.

### R12 — 같은 generation post-deploy verify

write-quiescence와 세 lock을 유지한 채 access/session `--verify-lock`을 apply report의 exact token 및 모든 generation으로 실행한다. set counter gate도 같은 `lockId/updateTimeGeneration`인지 server-read하고 새 read-only counter audit가 clean인지 확인한다. lifecycle/share/public audit도 새 output으로 반복하고 R7의 zero-finding privacy 결과를 다시 요구한다. 어떤 generation 또는 Rules/app hash가 달라져도 unlock하지 않는다.

### R13 — exact unlock

R12가 모두 안전할 때만 session operational lock, teacher access operational lock, set counter lock을 각각 apply report의 exact token/generation으로 명시 해제한다. completion 상태는 삭제하지 않고 legacy fallback도 다시 열지 않는다. unlock report와 새 server generation을 보존하고, 이때의 lock/직렬화 종료 시각을 R10 strict readback 직후 기록한 deny-all barrier 종료 시각과 별도로 남긴다.

### R14 — Email/Password provider gate

Password Policy·domain·template를 다시 확인하고, R10의 새 Rules exact readback과 R12~R13 증거가 모두 같은 manifest에 있을 때도 provider는 아직 OFF로 유지한다. 먼저 기존 Google admin, 기존 Google teacher, anonymous student의 로그인·권한·수업 join/end smoke를 수행하고 console error 0을 확인한다. 이 existing-flow smoke가 모두 통과한 뒤에만 Email/Password provider를 활성화한다. Google과 Anonymous provider는 유지한다. provider 활성화는 allowance를 만들거나 계정을 자동 병합하지 않는다. 자동화할 수 없는 Firebase Console owner 조작, 실제 inbox 클릭, 또는 admin approval이 필요하면 추정하지 말고 그 지점에서 `NEEDS_CONTEXT`로 중단한다.

### R15 — controlled smoke와 quiescence 종료

일반 트래픽을 열기 전에 R14에서 통과한 기존 흐름에 이어 Email/Password `signup` → 한국어 verification email 실제 수신·클릭 → verified teacher request → admin approval → login → password reset → public-library copy 순서의 controlled smoke를 수행한다. private source 문서·이메일·UID가 public projection, copy, console, 일반 stdout에 노출되지 않고 console error가 0이어야 한다. provider collision 안내, 공개 author 비식별 표시, 게시/복사/철회/moderation도 확인한다. 성공 증거를 기록한 뒤에만 일반 client 접근과 trusted writers를 연다. recorded rollback ruleset은 이 provider smoke 완료까지 보존하며, 모든 smoke 완료 뒤에도 manifest의 rollback history에서 삭제하지 않는다.

## 롤백

알려진 settled PATCH 실패 또는 strict readback mismatch라면 일반 traffic과 trusted writer를 계속 차단하고 provider를 새로 켰다면 먼저 다시 끈다. `projects/video-quiz-65798/releases/cloud.firestore`를 recorded rollback ruleset `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`로 update하고 GET의 exact `rulesetName` readback을 확인한다. 단, 전송된 PATCH의 응답 유실·transport timeout인 `mutation-outcome-unknown`은 settled failure가 아니다. 이 경우 자동 rollback을 시도하거나 rollback됐다고 주장하지 말고, provider OFF·lock·single-operator serialization을 유지한 채 read-only reconciliation과 수동 incident 조사를 한다. 데이터, Auth 사용자, allowance, 이미 withdrawn인 publication, 독립 사본은 삭제하거나 역변환하지 않는다. 기록한 직전 호환 **Rules를 먼저 복원**하고 적용을 확인한 뒤 직전 static app commit을 복원한다. 즉 롤백도 Rules before static app 순서를 유지한다. migration/completion gate는 blind delete하지 않고 exact report identity로 재감사한다. rollback smoke까지 통과한 뒤에만 quiescence를 종료한다.
