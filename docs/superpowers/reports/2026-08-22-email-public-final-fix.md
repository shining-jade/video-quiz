# 이메일 인증·공개 자료실 최종 수정 검증 보고서

작성일: 2026-08-22
대상 브랜치: `codex/email-auth-public-library`

이 보고서는 로컬 구현과 demo Emulator 검증 증거다. production migration, deploy, push, Firebase Console/provider 변경, 실제 계정·메일·브라우저 작업은 수행하지 않았으며 운영 배포 승인으로 사용할 수 없다. production 릴리스는 오직 [`../../RELEASE-RUNBOOK.md`](../../RELEASE-RUNBOOK.md)의 R0~R15를 따른다.

## 완료 범위

- canonical email legacy mirror를 exact single UID에 결합했다. 다른 UID의 승인은 Store와 Rules 모두 거부하고, 승인 after-state가 다른 UID를 쓰는 forged batch도 거부한다. 같은 UID mirror의 멱등 승인은 유지하며, 충돌한 두 번째 신청은 승인 실패 뒤 관리자가 거절할 수 있다.
- `PublicAuthorLabelCore`를 단일 값 검증기로 추가했다. blank, email-shaped, normalized owner email, exact owner UID, UID-like 값을 signup/profile, access request, approval allowance, public projection, Store publish, Rules, UI와 auditor에서 거부한다. 안전한 기존 한국어 표시 이름은 그대로 유효하다.
- 공개 auditor가 `PUBLIC_AUTHOR_LABEL_UNSAFE`와 `PUBLIC_AUTHOR_LABEL_PARITY`를 durable finding으로 기록한다. 공개 collection query는 외부 source/allowance 문서를 임의로 읽어 필터링할 수 없으므로, Rules의 create/direct-get binding과 R7/R12 production 전수 auditor를 함께 release gate로 사용한다.
- collaborator share migration의 stdout은 상태·안전 판정·count만 출력한다. 이메일/set 상세는 restricted durable JSON에만 보존한다.
- 기능별로 충돌하던 rollout 문구를 폐기하고 `docs/RELEASE-RUNBOOK.md` 하나에 exact write-quiescence, lifecycle/share/set-counter/access/session/public/index/provider gate와 R10 Rules → R11 static app 단일 순서를 합쳤다. rollback도 quiescence 아래 Rules를 먼저 복원한다.

## RED → GREEN 증거

- 초기 focused author/mirror Node: 56개 중 49 pass, 7 fail → 구현 뒤 focused Node 600/600 pass.
- 초기 Store focused: 8개 중 1 pass, 7 fail → 구현 뒤 전체 Node에 포함해 pass.
- 초기 full Rules: 502개 중 500 pass, 2 fail(두 UID mirror overwrite, unsafe author) → 최종 Rules/Admin Emulator 505/505 pass.
- self-review에서 두 번째 UID의 안전한 거절까지 추가: RED 0/1(거절도 mirror conflict로 차단) → 승인 분기로 invariant를 한정해 GREEN 1/1.
- release-copy 갱신 중 RED 29 pass/8 fail, 이후 34 pass/3 fail → 최종 37/37 pass.

## 최종 검증

- `node --test tests/*.test.js`: 976 tests, 848 pass, 0 fail, Emulator 전용 128 skip.
- Firestore Emulator에서 `firestore-rules.test.js`, `legacy-migration-admin-emulator.test.js`, `public-library-audit-admin-emulator.test.js`: 505/505 pass, 0 fail.
- `node --check`: 변경 JavaScript 7개 모두 성공.
- Git이 추적하는 JSON 4개 `ConvertFrom-Json`: 모두 성공.
- non-module inline JavaScript parse와 release copy: 37/37 pass.
- `git diff --check`: 성공.

## Self-review 결론

- approval conflict 검사는 승인에만 적용되어 canonical mirror를 보호하면서 운영자가 duplicate request를 거절할 수 있다.
- authoritative legacy mirror lifecycle write는 기존 exact UID 또는 UID가 없던 migration 대상만 허용하고, 다른 UID로의 교체는 거부한다.
- 기존 allowance의 표시 이름을 일괄 무효화하는 write migration은 추가하지 않았다. 공개 시점과 production audit에서만 public-safe/parity gate를 적용하고 unsafe 값은 사람이 authoritative allowance를 명시 교정한다.
- Email/Password provider collision은 자동 병합·mirror overwrite·두 번째 allowance로 처리하지 않고 기존 로그인 안내와 exact Auth UID 조사 후 access migration/audit로 해결하도록 문서화했다.
- production gate는 닫혀 있다. R0~R15 증거가 없으면 `safeToDeployStrictRules` 또는 `safeToDeployPublicLibrary`를 주장하지 않는다.
