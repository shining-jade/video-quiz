# 통합 운영 릴리스 런북

이 문서만 production 릴리스 **전체 순서의 authoritative source**다. 기능별 문서는 데이터 계약과 개별 CLI 인자만 설명하며 별도 배포 순서를 정의하지 않는다. 이 문서는 실행 승인서가 아니고, 구현 작업 중 production migration, deploy, push, provider 변경, 실제 계정 또는 브라우저 작업은 수행하지 않았다.

## 중단 원칙

- exact project ID, Auth/Firestore 환경, 현재 Rules release, static app commit, Firestore export/backup, rollback 대상을 한 change record에 먼저 고정한다.
- 모든 CLI는 새 restricted output path를 사용한다. `.reserved`와 최종 JSON을 보존하고 기존 파일을 덮어쓰지 않는다. 이메일·UID·set ID가 들어갈 수 있는 상세 보고서는 운영 담당자만 읽을 수 있게 보관한다. 일반 stdout은 상태와 count만 기록한다.
- `complete`, 안전 판정, zero-finding, exact token/generation 가운데 하나라도 없거나 scan이 partial이면 즉시 중단한다. unsafe 보고서를 사람이 “괜찮음”으로 덮어쓰지 않는다.
- legacy의 안전한 한국어 표시 이름은 그대로 허용한다. blank, 이메일 모양, 정규화 owner email, UID와 동일하거나 UID 모양인 공개 표시 이름은 public audit finding이므로 먼저 authoritative allowance를 명시적으로 교정하고 다시 감사한다. 자동 추정·자동 공개 backfill은 하지 않는다.
- 같은 canonical email의 legacy mirror가 다른 UID를 가리키거나 UID가 없는 상태에서 새 승인을 시도하면 자동 병합·덮어쓰기를 하지 않는다. Firebase Auth provider collision을 조사해 기존 로그인 방법을 안내하고, 사람이 exact Auth UID를 결정한 뒤 access migration/audit로 mirror와 `teacher_allowances/{uid}`를 한 identity로 맞춘다.

## 고정 릴리스 순서

아래 `R0`부터 `R15`까지를 순서대로 한 번만 수행한다.

### R0 — 변경 창과 로컬 증거 고정

Password Policy 최소 길이 8·Enforcement `Require`, authorized domain, 이메일 인증/비밀번호 재설정 템플릿을 확인하되 Email/Password provider는 끈 상태로 둔다. backup과 rollback Rules/app를 기록하고 `pnpm test`, `pnpm test:rules`, syntax/JSON 검증, `git diff --check`를 먼저 통과시킨다.

### R1 — exact write-quiescence 시작

정적 앱 배포나 화면 배너를 quiescence로 간주하지 않는다. 별도의 운영 접근 제어로 모든 일반 client의 Firebase 읽기·쓰기를 차단하고, scheduler·Cloud Function·trusted Admin migration·수동 콘솔 쓰기를 중지한다. 현재 change window의 단일 운영자만 아래 명시된 CLI를 직렬 실행한다. 차단 시작 시각, 제어 ID, 중지한 writer 목록을 기록한다. 이 강제 수단이 없거나 다른 writer가 관찰되면 릴리스를 시작하지 않는다.

R1의 차단은 R14 provider 확인까지 유지한다. migration lock은 quiescence의 대체물이 아니라 추가 CAS 장벽이다. quiescence 중에는 정적 maintenance app을 먼저 배포하지 않는다.

### R2 — lifecycle migration과 전수 감사

`migrate:lifecycle` production dry-run → apply → 새 dry-run 순서로 실행한다. 최종 durable report가 `status: "complete"`, `safeToDeployStrictRules: true`이고 legacy lifecycle 누락·불일치·orphan이 0이어야 한다. `publication_lifecycle_gates/current`와 owner lock이 active/stale/malformed이면 blind delete하지 말고 exact operation 복구 또는 Admin 조사 뒤 paired 상태로 해소한다.

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

검토된 `firestore.indexes.json`의 `published_quiz_sets(status ASC, updatedAt DESC, __name__ DESC)` 및 `sessions(sourceOwnerUid ASC, sourceSetId ASC, createdAt DESC, __name__ DESC)` index를 배포하고 Firebase가 build 완료를 보고할 때까지 기다린다. building/error이면 다음 단계로 가지 않는다. 이 단계는 Rules 또는 static app 배포가 아니다.

### R9 — release manifest 봉인

R2~R8의 restricted report 경로와 SHA-256, exact project/environment, 모든 token/generation, index 완료 증거, tested `firestore.rules` hash와 static app commit을 한 manifest에 기록한다. 기록 뒤 quiescence 또는 gate generation이 변하면 R2부터 새 보고서로 다시 시작한다.

### R10 — strict Firestore Rules 배포

비로그인 진행 링크를 포함한 릴리스도 Cloud Functions 없이 Spark 요금제에서 운영한다. R8의 index 완료를 확인한 뒤 manifest에 기록한 **strict Rules release를 한 번 배포**하고 적용된 Rules hash/release time을 재확인한다. 호환 head/staged Rules를 별도 순서로 선배포하거나 legacy fallback을 다시 열지 않는다. 즉 새 기능의 고정 순서는 **indexes 완료 → Rules → static app**이다.

### R11 — static app 배포

R10의 strict Rules 적용을 확인한 뒤 manifest의 **static app release를 한 번 배포**한다. 이 런북의 유일한 rollout 순서는 항상 **Rules before static app**이다.

### R12 — 같은 generation post-deploy verify

write-quiescence와 세 lock을 유지한 채 access/session `--verify-lock`을 apply report의 exact token 및 모든 generation으로 실행한다. set counter gate도 같은 `lockId/updateTimeGeneration`인지 server-read하고 새 read-only counter audit가 clean인지 확인한다. lifecycle/share/public audit도 새 output으로 반복하고 R7의 zero-finding privacy 결과를 다시 요구한다. 어떤 generation 또는 Rules/app hash가 달라져도 unlock하지 않는다.

### R13 — exact unlock

R12가 모두 안전할 때만 session operational lock, teacher access operational lock, set counter lock을 각각 apply report의 exact token/generation으로 명시 해제한다. completion 상태는 삭제하지 않고 legacy fallback도 다시 열지 않는다. unlock report와 새 server generation을 보존한다.

### R14 — Email/Password provider gate

Password Policy·domain·template를 다시 확인하고, R10~R13 증거가 모두 같은 manifest에 있을 때만 Email/Password provider를 활성화한다. Google과 Anonymous provider는 유지한다. provider 활성화는 allowance를 만들거나 계정을 자동 병합하지 않는다.

### R15 — controlled smoke와 quiescence 종료

일반 트래픽을 열기 전에 지정된 Google admin, 기존 Google teacher, 새 verified Email/Password teacher와 익명 학생만 허용하는 controlled smoke를 수행한다. 승인 신청/승인, provider collision 안내, 공개 author 비식별 표시, 게시/복사/철회/moderation, 기존 수업 join/end와 console error 0을 확인한다. 성공 증거를 기록한 뒤에만 일반 client 접근과 trusted writers를 연다.

## 비로그인 진행 링크 추가 게이트

- Firebase Authentication의 Anonymous provider가 활성화되어 있어야 한다. 교사용 공유 실행에는 비밀번호나 로그인 화면을 추가하지 않는다.
- 이 기능은 Spark 요금제의 Firestore, Anonymous Authentication, 정적 GitHub Pages만 사용한다. Cloud Functions, Cloud Build, Artifact Registry 배포를 만들지 않는다.
- 43자 공유 ID가 포함된 URL 자체가 진행 권한이다. 공개 게시하거나 검색 가능한 곳에 남기지 않으며, 유출이 의심되면 즉시 링크를 해제하고 새 링크를 발급한다.
- `pnpm test:guest`와 `pnpm test:rules`를 모두 통과시키고, 앱과 배포 설정에 Functions/custom token 교환 경로가 없는지 확인한다.
- 서로 격리된 브라우저 두 개에서 같은 링크를 열어 로그인 안내가 없는지 확인한다. 각각 `3학년 1반`, `3학년 2반`으로 시작해 서로 다른 6자리 반 코드가 발급되고, 학생 한 명씩 서로 다른 답을 제출했을 때 각 실행 화면과 원본 교사의 실행 기록에 자기 반 응답만 나타나야 한다.
- 링크를 해제한 뒤 세 번째 브라우저에는 `사용할 수 없는 진행 링크입니다. 만든 분에게 새 링크를 요청해 주세요.`가 표시되어야 한다. 이미 진행 중인 두 수업은 안전하게 종료할 수 있어야 한다. 새 링크 발급 후 이전 링크가 계속 거부되는지도 확인한다.
- 롤백은 먼저 새 공유 링크 생성을 UI에서 비활성화하고 Rules를 복원한 뒤 static app을 직전 호환 release로 되돌린다. 기존 세션·학생·응답은 삭제하지 않는다.

## 롤백

실패 시 일반 traffic과 trusted writer를 계속 차단하고 provider를 새로 켰다면 먼저 다시 끈다. 데이터, Auth 사용자, allowance, 이미 withdrawn인 publication, 독립 사본은 삭제하거나 역변환하지 않는다. 기록한 직전 호환 **Rules를 먼저 복원**하고 적용을 확인한 뒤 직전 static app commit을 복원한다. 즉 롤백도 Rules before static app 순서를 유지한다. migration/completion gate는 blind delete하지 않고 exact report identity로 재감사한다. rollback smoke까지 통과한 뒤에만 quiescence를 종료한다.
