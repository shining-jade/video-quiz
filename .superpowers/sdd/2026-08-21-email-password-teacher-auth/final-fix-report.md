# 이메일·비밀번호 교사 인증 Final Fix Wave 보고서

작성일: 2026-08-21
대상 브랜치: `codex/email-auth-public-library`

## 상태

- 최종 리뷰의 CRITICAL, IMPORTANT 1~4, MINOR 항목을 모두 코드·Rules·테스트·운영 문서에 반영했다.
- 권한을 완화하지 않았다. authoritative `teacher_allowances/{uid}`는 검증된 Google/Password 계정을 계속 허용하지만, migration-incomplete `teacher_allowlist/{canonicalEmail}` fallback은 `google.com`에만 한정한다.
- 기존 Google 교사 로그인, Anonymous 학생 입장, 동일 이메일 provider collision의 비병합 판정은 유지했다.
- Firebase Console, 실제 계정/메일, production migration, deploy, push는 실행하지 않았다.

## TDD 명령과 RED 증거

### 1. Legacy fallback 권한 상승

명령:

```powershell
firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-concurrency=1 --test-name-pattern='migration-incomplete legacy' tests/firestore-rules.test.js"
```

RED: matching test 0 pass / 1 fail. UID allowance가 없는 verified password teacher가 legacy email allowlist만으로 `quiz_sets/set1`을 읽어 `assertFails`가 실패했다. 동일 원인의 password admin 경로도 함께 테스트에 고정했다.

### 2. 미검증 계정 복구·reset 오류·중복 요청

명령:

```powershell
node --test --test-name-pattern "post-create|observed unverified|password relogin|password reset|verification actions|signup, verification resend" tests/teacher-email-auth-core.test.js tests/firestore-store.test.js
```

RED: 새 matching assertion 17/17 fail. post-create profile/verification 실패 뒤 복구 상태가 없었고, unverified password 재로그인 시 확인 UI가 닫혔으며, reset network/throttle도 성공으로 렌더링했고, signup/resend/reset 중복·cooldown·busy 상태가 없었다.

### 3. 운영 gate와 HANDOFF 순서

명령:

```powershell
node --test --test-name-pattern "Password Policy|deployment lock|HANDOFF preserves" tests/release-copy.test.js
```

RED: 새 release contract 0/3 pass. 서버 Password Policy 최소 8 / Enforcement `Require`, strict UID Rules 이후 provider 활성화, 안전한 HANDOFF 전체 순서가 문서에 없었다.

## GREEN 증거

### Focused

- Rules focused: authoritative password positive matrix, stored UID mismatch negative seed, Google-only legacy fallback password teacher/admin deny를 함께 실행해 3/3 pass.
- Auth focused: post-create profile/verification 재시도, observer/relogin 복구, UID·generation stale 거부, reset 중립/재시도 메시지, in-flight/cooldown/busy 및 비밀 비저장을 실행해 17/17 pass.
- Release contract focused: Password Policy, strict/verify/unlock 이후 provider 활성화, HANDOFF 순서를 실행해 3/3 pass.
- 기존 email-auth/auth-core/request/release focused 회귀도 exit code 0.

### 전체 회귀와 정적 검사

```powershell
pnpm test
pnpm test:rules
node --check teacher-email-auth-core.js
git diff --check
```

- `pnpm test`: 819 tests, 723 pass, 96 skip, 0 fail.
- `pnpm test:rules`: Firestore Rules + Admin Emulator 473/473 pass, 0 skip, 0 fail. Demo project `demo-video-quiz`만 사용했다.
- `node --check teacher-email-auth-core.js`: exit code 0.
- inline application script parsing은 full Node suite에서 통과했다.
- `git diff --check`: exit code 0. LF/CRLF 안내 외 whitespace 오류 없음.

## 변경 사항

1. `validLegacyTeacherAllowance()`에 `sign_in_provider == 'google.com'`을 요구했다. authoritative UID allowance의 verified password teacher/admin 대표 list/write/admin 기능은 계속 허용하며 Emulator로 검증했다.
2. 모든 observed unverified password current user에 UID·auth generation 결합 verification 상태를 재개한다. 가입 생성 뒤 `updateProfile` 또는 `sendEmailVerification`이 실패해도 이름 저장과 인증 메일 발송의 빠진 단계만 재시도할 수 있다.
3. verification resend/confirm은 현재 UID와 generation이 달라지면 네트워크 호출 전에 stale로 거부한다.
4. reset은 성공과 `auth/user-not-found`만 정확히 같은 중립 성공 문구를 사용한다. network와 throttle은 계정 존재 여부를 드러내지 않는 재시도 오류로 구분한다.
5. signup/resend/reset에 in-memory in-flight token, disabled/`aria-busy`, 3초 cooldown을 추가했다. token에는 operation과 시작 시각만 있고 비밀번호·ID token·reset token을 저장하지 않는다. 비밀번호 입력은 요청 시작 직후와 종료/닫기 시 지운다.
6. Firebase Console Password Policy 최소 길이 8 + Enforcement `Require`를 pre-deploy fail-closed operator gate로 문서화했다. strict UID Rules/static 배포, 동일 generation verify, exact unlock 전에는 Email/Password provider를 활성화하지 않는다.
7. HANDOFF를 access lock/apply, session join lock/recount/gate, durable safe 보고서, strict/static, 동일 generation verify, exact unlock, provider 활성화, browser acceptance 순서로 고정했다.
8. README의 승인 데이터 설명을 authoritative UID allowance로 수정하고 password 계정의 legacy allowlist 우회를 금지했다.

## 커밋

- `b3e23d1` — legacy 교사 권한을 Google fallback으로 제한
- `358370d` — 미검증 이메일 인증 복구와 요청 제어 강화
- `eb262c1` — 이메일 인증 활성화 운영 게이트 고정

## 남은 우려와 운영 gate

- Firebase Console Password Policy 최소 길이 8 / Enforcement `Require` 설정 확인과 Email/Password provider 활성화는 미실행이다. 모든 strict UID-compatible Rules migration·배포·동일 generation 검증·exact unlock 증거가 준비되기 전에는 활성화하면 안 된다.
- 실제 이메일 인증/재전송/비밀번호 재설정 메일 전달, 신규 이메일 교사·기존 Google admin·Anonymous 학생·collision 브라우저 smoke는 미실행이다.
- production export/backup, access/session dry-run·lock/apply·verify/unlock, Rules/static deploy, rollback rehearsal, push는 미실행이다.
- UI 복구와 요청 제어는 결정적 Node VM 테스트, 권한은 demo Firestore/Admin Emulator로 검증했다. 실제 Firebase 네트워크·메일 전달 동작은 운영 인수에서 별도로 확인해야 한다.
- 3초 client cooldown은 의도적으로 메모리 안에서만 유지한다. 비밀번호나 인증/reset token을 local/session storage에 저장하지 않으며, 서버 측 Firebase throttling을 대체하지 않는다.
