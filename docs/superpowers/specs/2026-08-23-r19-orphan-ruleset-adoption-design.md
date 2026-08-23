# R19 응답 유실 Ruleset 안전 채택 설계

## 배경과 확정된 원인

R19의 `rulesets.create` 호출은 클라이언트에 HTTP 503을 반환했지만 서버에는 동일 요청의 Ruleset이 저장됐다. 생성된 Ruleset은 `projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1`이며, 소스 SHA-256은 배포 후보와 같은 `c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d`다. 활성 `cloud.firestore` 릴리스는 기존 rollback Ruleset에 남아 있어 운영 상태와 Email/Password provider는 변경되지 않았다.

문제의 본질은 비멱등 POST의 응답 유실이다. 비성공 HTTP 응답만으로 create의 서버 반영 여부를 판단하면 중복 Ruleset을 만들 수 있다.

## 목표

- 이미 저장된 동일 SHA Ruleset을 새 create 없이 안전하게 채택한다.
- 이전 배포 창의 감사·잠금·매니페스트 증거를 재사용하지 않는다.
- 모든 데이터·권한·개인정보·원자성 검사를 새로운 단일 quiescence 창에서 다시 수행한다.
- release PATCH 직전과 직후에 Ruleset 소스와 활성 release를 exact readback한다.
- 실패하면 Email/Password를 켜지 않고 기존 Ruleset으로 자동 롤백한다.

## 비목표

- 동일 소스의 새 Ruleset 생성
- R18 또는 R19의 감사·generation·lock 증거 재사용
- 기존 Ruleset 자동 채택
- quiescence 없이 R10만 단독 실행
- Email/Password의 조기 활성화

## 코드 구조

### API 실패 증거

`rules-api-failure.js`는 HTTP status, Google API code/status/message/details, issue 수, 비 JSON 응답과 transport error를 보존한다. Bearer 및 `ya29` 토큰을 항상 치환한다. 컴파일 probe와 release helper는 실패 원인을 버리지 않고 restricted report에 저장한다.

### 비멱등 create 대조

`rules-ruleset-reconcile.js`는 create 전 ruleset 목록 또는 create 시각을 기준으로 후보를 고르고 각 후보의 소스를 GET하여 기대 SHA와 비교한다. 결과는 `writeLanded: true | false | null`이다.

- `true`: 동일 소스가 저장됨. create 재시도 금지.
- `false`: 후보를 모두 읽었고 동일 소스가 없음. 새 배포 창에서만 create 가능.
- `null`: 목록/후보 읽기 실패, 후보 과다 또는 판단 불가. 사람이 조사할 때까지 중단.

대조 결과는 자동 채택 권한을 주지 않는다.

### 읽기 전용 진단

`scripts/diagnose-rules-api.js`는 ruleset 수, 활성 release, 기대 SHA의 저장 여부를 GET만으로 보고한다. 모든 출력은 새 non-overwriting restricted 경로를 사용한다.

### R10 채택 방식

새 release helper는 두 모드를 분리한다.

1. `create`: manifest가 새 create를 요구하고 reconciliation이 `writeLanded:false`일 때만 허용한다.
2. `adopt-existing`: manifest가 exact Ruleset 이름과 SHA를 명시하고, helper가 해당 Ruleset을 GET하여 단일 `firestore.rules` 소스 SHA를 재확인한 경우에만 허용한다.

이번 복구는 `adopt-existing`만 사용한다. 대상은 `d55f5b3e-a39d-4eea-b4af-4637afd163e1`로 고정한다. 목록에서 비슷한 후보를 찾아 자동 선택하지 않는다.

## 새 릴리스 순서

1. R0 로컬 전체 검증과 새 official `projects.test` 보고서를 만든다.
2. R1 exact write-quiescence를 시작하고 R14까지 유지한다.
3. R2–R8을 새 non-overwriting 보고서와 새 lock/token/generation으로 다시 수행한다.
4. R9 manifest에 새 증거, 배포 소스 SHA, 기존 rollback Ruleset, 채택할 exact Ruleset 이름을 봉인한다.
5. R10 helper가 manifest, quiescence, gate generation, source SHA를 다시 검증한다.
6. 대상 Ruleset을 GET하고 source SHA가 exact 일치하면 create 없이 `cloud.firestore`만 PATCH한다.
7. 즉시 release GET readback과 Ruleset source 재검증을 수행한다.
8. mismatch 또는 API 실패면 기존 Ruleset으로 PATCH하고 exact rollback readback을 요구한다.
9. R11–R13 정적 앱 배포, 같은 generation 사후 감사, exact unlock을 수행한다.
10. R14 기존 Google admin/teacher 및 anonymous student smoke 후에만 Email/Password를 활성화한다.
11. R15 이메일 인증·승인·로그인·재설정·공개 자료실 복사 smoke 후 quiescence를 종료한다.

## 안전 불변조건

- `rulesets.create`는 이번 채택 흐름에서 호출되지 않는다.
- SHA가 다르거나 Ruleset을 읽을 수 없으면 release PATCH를 호출하지 않는다.
- 이전 배포 창의 R18/R19 보고서는 원인 증거로만 보존하고 배포 승인 근거로 사용하지 않는다.
- quiescence 또는 lock/generation이 변하면 R2부터 다시 시작한다.
- release PATCH/readback 실패 시 provider는 OFF 상태를 유지하고 기존 Ruleset으로 롤백한다.
- 일반 stdout과 커밋에는 이메일, UID, 토큰, private source 또는 상세 finding을 넣지 않는다.
- `.release-artifacts/`와 `.release-maintenance/`는 커밋하지 않는다.

## 테스트와 완료 조건

- API 실패 보존/토큰 치환 단위 테스트
- reconcile의 true/false/null 및 후보 상한/읽기 실패 단위 테스트
- release helper의 adopt-existing RED→GREEN 테스트: exact name/SHA/manifest/quiescence/generation 검증, create 미호출, PATCH exact target, readback, rollback
- 전체 Node 테스트와 Rules Emulator 테스트
- 새 production compiler probe 오류 0 및 `safeToCreateRuleset:true`
- 새 R2–R9 보고서 전부 complete/zero-finding/exact generation
- active release exact readback이 채택 Ruleset과 일치
- 기존 흐름 smoke 및 Email/Password controlled smoke 완료

## 롤백

기존 rollback Ruleset `projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4`를 R15 완료까지 유지한다. release 또는 smoke 실패 시 Email/Password를 끄고 `cloud.firestore`를 해당 Ruleset으로 되돌린 뒤 exact GET readback을 확인한다. 데이터와 이미 생성된 immutable Ruleset은 삭제하지 않는다.
