# Firestore Rules 운영 컴파일 최적화 설계

## 배경

현재 프로덕션에서 정상 동작하는 Firestore Rules는 약 112KB·2,098줄이다. 이메일 인증과 공개 자료실을 포함한 최종 Rules는 약 181KB·3,467줄·함수 245개이며, 로컬 Firestore Emulator의 505개 규칙 테스트는 통과하지만 Google Rules API의 `projects.test`와 `rulesets.create`가 모두 HTTP 503을 반환한다. 같은 프로젝트·자격증명으로 최소 deny-all 규칙은 `projects.test`에 성공하므로 계정, IAM, API 활성화 또는 Google 전체 장애가 아니라 최종 소스의 운영 컴파일 복잡도가 원인이다.

## 목표

기능과 권한을 완화하지 않고 최종 Rules를 운영 컴파일러가 안정적으로 처리할 수 있는 크기와 구조로 축소한다. 공식 API 비파괴 컴파일, 전체 Node/Emulator 회귀, 프로덕션 readback이 모두 성공한 경우에만 활성 규칙셋을 교체한다.

## 비목표

- Cloud Functions 또는 별도 백엔드 도입
- 공개 자료실, 이메일 교사 인증, 수업계획, 휴지통 기능 축소
- migration gate의 완료 증거 또는 운영 감사 보고서 삭제
- 클라이언트 데이터 스키마 변경 및 프로덕션 데이터 재작성
- 테스트를 규칙에 맞춰 완화하는 작업

## 접근 방식

### 1. 완료된 호환 경로의 영구 strict 전환

프로덕션 감사에서 다음 조건이 이미 증명됐다.

- 모든 quiz set에 유효한 lifecycle 및 authoritative image/collaborator counter가 있다.
- collaborator share index의 누락·고아·불일치가 없다.
- teacher access completion gate는 `complete/strictReady`이며 UID allowance와 legacy mirror가 일치한다.
- non-ended legacy session 및 session counter 불일치가 없다.
- 공개 projection, child schemaVersion, lifecycle lock/gate, PII finding이 모두 0이다.

따라서 완료 gate가 false일 때만 사용하던 legacy fallback과 migration-window write 분기를 최종 배포 Rules에서 제거한다. 완료 gate 문서 자체와 클라이언트 write 차단은 유지한다. 활성 데이터의 strict 경로, 안전 종료, 관리자 정리 경로는 유지한다.

### 2. 반복 검증식 통합

동일한 UID/email/status/role, source lifecycle, public author label, parent-child revision 검증이 여러 helper와 allow branch에서 반복된다. 동일한 pre-state 또는 getAfter-state를 한 helper에서 읽고 boolean tuple 비교로 반환하도록 통합한다. 통합 과정에서 허용 조건의 합집합을 늘리지 않으며, 기존 negative matrix가 하나라도 GREEN에서 RED로 바뀌면 해당 통합을 폐기한다.

### 3. 공개 자료실 상태 전이별 최소 검증

공개 parent의 create/update/delete를 하나의 거대한 분기에서 모두 평가하지 않고, cheap changed-key/status guard로 상태 전이를 먼저 분류한 뒤 해당 전이에 필요한 validator만 평가한다. building/published/moderated/withdrawn/cancelled과 child bind/finalize/copy/lifecycle pair의 exact schema·counter·revision 조건은 유지한다. Firestore의 1,000-expression 제한을 넘기지 않도록 정상 경로별 평가량도 Emulator에서 계속 검증한다.

## 안전 불변조건

- 비승인·미인증·이메일 미인증 사용자는 교사 데이터에 접근하지 못한다.
- password provider는 authoritative UID allowance가 없으면 legacy email mirror로 승인되지 않는다.
- 동일 canonical email은 하나의 UID allowance에만 연결된다.
- 학생은 자기 session/student/response 경로와 공개 live projection만 사용한다.
- private quiz set은 owner/collaborator/admin의 기존 범위를 벗어나지 않는다.
- 공개 projection에는 이메일, UID, review/audit, answer/private source 필드가 들어갈 수 없다.
- 공개 child는 exact revision/schemaVersion/counter marker 없이 생성·조회·최종화되지 않는다.
- trash/suspension/deletion/purge는 공개 철회 및 lifecycle gate와 원자적으로 결합된다.
- migration 및 release gate 문서는 클라이언트가 생성·수정·삭제하지 못한다.

## 파일과 책임

- `firestore.rules`: 중복 helper와 완료된 호환 분기를 제거하고 strict validator를 통합한다.
- `tests/firestore-rules.test.js`: 삭제된 legacy 허용 기대를 영구 strict 거부 기대와 운영 컴파일 계약으로 교체한다. 기존 positive/negative matrix는 유지한다.
- `tests/rules-source-budget.test.js`: UTF-8 byte, line, function 수의 상한과 제거된 legacy helper 재도입을 검출한다.
- `scripts/test-production-rules-source.js`: exact project/target, ADC, read-only `projects.test`를 사용해 실제 운영 컴파일러를 확인하고 배포는 하지 않는다.
- `docs/RELEASE-RUNBOOK.md`: 운영 컴파일 검증과 실패 시 stop 조건을 R9/R10 사이에 추가한다.

## TDD 및 검증

1. 현재 final Rules가 정적 source budget과 공식 API 컴파일 probe에서 실패하는 RED를 기록한다.
2. migration compatibility별 negative/positive Emulator 테스트를 먼저 영구 strict 기대값으로 추가한다.
3. 한 묶음씩 helper/branch를 제거 또는 통합하고 focused Emulator GREEN을 확인한다.
4. 매 묶음 후 source budget을 측정하고 1,000-expression 회귀가 없는지 확인한다.
5. 최종 `pnpm test`, `pnpm test:rules`, syntax/JSON/diff check를 새로 실행한다.
6. 공식 `projects.test`가 issues 0으로 성공해야 배포 후보가 된다.

목표 상한은 UTF-8 150KB 이하, 3,000줄 이하, 함수 210개 이하로 둔다. 이 값은 현재 정상 배포본보다 넉넉하지만 실패 소스보다 충분히 낮고, 향후 무제한 증가를 막는 회귀선이다. 공식 API 성공이 최종 기준이며 정적 상한 통과만으로 배포 성공을 주장하지 않는다.

## 배포와 롤백

1. 현재 운영 ruleset과 logical Firestore backup을 보존한다.
2. 최종 Rules를 `projects.test`로 비파괴 검증한다.
3. 새 immutable ruleset을 생성한다.
4. `cloud.firestore` release를 새 ruleset에 연결하고 exact name을 readback한다.
5. Google admin, Google teacher, anonymous student의 기존 핵심 smoke를 실행한다.
6. 이메일/비밀번호 provider를 활성화하고 signup→email verify→request→admin approval→login/reset smoke를 실행한다.
7. 실패하면 provider를 끄고 release를 기록된 이전 ruleset으로 즉시 되돌린다.

공식 API 5xx, source budget 초과, Emulator 실패, production audit finding, ruleset readback 불일치 중 하나라도 있으면 배포를 중단한다.

## 개인정보와 운영 기록

컴파일 probe stdout에는 project ID, 성공 여부, issue count, source hash/크기만 출력한다. 토큰, 이메일, UID, audit finding 원문은 stdout에 출력하지 않는다. 운영 보고서는 기존 `.release-artifacts` 제한 폴더에 새 이름으로 보관하고 덮어쓰지 않는다.
