# 공개 퀴즈 자료실 운영 계약

이 문서는 공개 자료실의 배포·운영·복구 기준이다. 여기서 공개란 인터넷 전체 공개가 아니라 **승인 교사만** 접근하는 교사 내부 자료실을 뜻한다. 모든 기존 세트와 새 세트는 **private by default**이며, 소유자가 명시적으로 게시한 항목만 보인다. 기존 세트를 자동 공개하는 **backfill은 하지 않는다**.

## 데이터 경계와 필드 allowlist

- `quiz_sets/{setId}`와 `images/{setId}/q/{key}`는 비공개 원본이다. 공동 편집자는 원본을 편집할 수 있지만 게시·철회·휴지통 이동은 소유자만 한다.
- `published_quiz_sets/{publicationId}`는 비식별 공개 부모다. 허용 필드는 `publicationId`, `sourceSetId`, `status`, `moderationStatus`, `revision`, `title`, `description`, `authorDisplayName`, `revealMode`, `limitSec`, `revealDelaySec`, `autoPause`, `videoCount`, `questionCount`, `imageCount`, `publishedAt`, `updatedAt`뿐이다. `building` 또는 숨김 tombstone인 `cancelled` 동안에만 `buildToken`, `buildVideoCount`, `buildQuestionCount`, `buildImageCount`, `buildMutation`이 추가된다.
- `published_quiz_sets/{publicationId}/videos/{videoKey}`는 `videoKey`, `videoId`, `videoUrl`, `startSec`, `endSec`, `revision`, `buildToken`만 가진다.
- `published_quiz_sets/{publicationId}/questions/{questionKey}`는 `type`, `t`, `text`, `choices`, `answer`, `answers`, `accept`, `imgUp`, `imgUrl`, `explain`, `explainImgUp`, `explainImgUrl`, `limitSec`, `questionKey`, `videoKey`, `revision`, `buildToken`만 가진다. 내부 검토자·학생·소유자 식별 필드는 금지한다.
- `published_quiz_sets/{publicationId}/images/{imageKey}`는 `data`, `revision`, `buildToken`만 가진다.
- `published_quiz_audits/{publicationId}`는 관리자 moderation 감사 기록이며 일반 교사에게 공개하지 않는다.

공개 projection에는 소유자의 **이메일과 UID 비공개** 원칙을 적용한다. 표시 이름만 허용하며 원본 경로의 개인정보, 공동 편집자, 학생 응답, 정답 검토 메타데이터는 복제하지 않는다.

## 게시, 복사, moderation

소유자는 활성 원본의 정확한 `contentRevision`과 활성 `teacher_allowances`를 서버에서 다시 읽은 뒤 `building` projection을 만들고, 모든 평면 child를 결합한 뒤에만 `published`로 전환한다. 중간 build는 목록과 다른 교사의 get/copy에서 보이지 않는다. build 중 원본을 휴지통으로 보내면 부모를 building 모양의 숨김 `cancelled` tombstone으로 바꾼다. 복원은 이를 자동 공개하지 않으며, 소유자가 다시 게시하면 새 build token으로 처음부터 재개해 stale child가 끼지 않는다. 철회는 같은 revision의 `published`를 `withdrawn`으로 바꾸며 child가 남아 있어도 새 조회와 복사는 막힌다.

다른 승인 교사의 복사는 원본에 대한 권한 공유가 아니라 새 UID가 소유하는 **독립 사본**이다. 게시자가 나중에 철회·휴지통·삭제해도 이미 완성된 사본은 유지된다.

관리자는 사유를 포함해 `published → moderated` 처리하고 별도 `published_quiz_audits`에 기록한다. 소유자는 moderated 항목을 재게시하거나 우회 철회할 수 없다. 복구는 관리자만 같은 revision과 감사 기록을 확인해 수행한다.

## 수명주기 fail-closed 계약

교사 중지·탈퇴 대기처럼 allowance를 바꾸는 작업은 먼저 `publication_lifecycle_locks/{ownerUid}`와 고정 전역 문서 `publication_lifecycle_gates/current`를 한 transaction으로 만든다. 한 번에 한 소유자의 수명주기만 진행하며, lock에는 시작 allowance revision/role/status/enabled, operation ID, actor와 사유를 정확히 기록한다. 공개 목록은 전역 gate가 없고 `status == published`인 bounded query만 허용한다. 개별 get/child/copy는 gate가 없는 것에 더해 원본의 명시적 `lifecycleState == active`, 정확한 활성 allowance, 소유자 lock 부재를 모두 확인한다. 따라서 감사 시작과 allowance 변경 사이에도 publication을 새로 만들거나 읽는 visibility gap이 없다.

최종 allowance 변경은 같은 transaction에서 시작 allowance와 lock/gate identity를 다시 읽고 두 잠금을 함께 소비한다. 실패 복구는 정확히 같은 operation/allowance identity일 때만 기존 잠금을 채택해 재감사하거나 exact release한다. stale, malformed, 다른 actor의 gate는 자동 삭제하지 않고 전체 공개 읽기와 게시를 fail-closed로 유지하며 운영자가 Admin SDK로 원인을 확인한다. 잠금 해제 자체가 실패하면 잠금을 남겨 안전하게 재시도한다.

- 휴지통 이동은 비공개 원본의 `active → trashed`와 보이는 공개 부모의 `published → withdrawn`을 한 transaction에 넣는다. 직접 원본만 휴지통으로 보내는 쓰기는 Rules가 거부한다. 복원은 원본만 `active`로 되돌리고 공개 부모는 `withdrawn`으로 유지한다.
- purge 시작도 보이는 부모가 있으면 같은 transaction에서 먼저 철회한다. 비공개 child를 기존 counter 프로토콜로 정리한 뒤, 공개 이미지를 한 호출 최대 200개씩 삭제한다. 공개 부모가 nonvisible이고 private/public child probe가 모두 비었을 때만 비공개 부모를 삭제한다.
- 교사 중지와 탈퇴 대기는 `withdrawOwnedPublicationsForLifecycle`이 정확한 `ownerUid`로 private source를 50개 이하씩 server-read paging한다. 이 owner 감사는 `lifecycleState 누락` legacy 원본도 포함하며, 누락 상태는 공개에서 active로 간주하지 않는다. 각 항목에서 source/public revision과 lock/gate를 transaction으로 재확인하고, 매 page 및 최종 상태 변경 직전에 시작 allowance의 UID·canonical email·role·revision·status를 다시 확인한다.
- 새 게시와 철회가 경합하면 전체 감사를 다시 시작한다. `remainingVisibleCount === 0`인 정확한 결과가 있어야 `adminUpdateTeacherAllowance` 또는 `requestTeacherDeletion`이 allowance를 바꾼다.
- query, write, allowance revision, auth-generation 또는 route 확인이 실패하면 allowance는 active로 남고 작업은 재개 가능한 오류로 끝난다. 앞 batch에서 이미 withdrawn 된 항목은 안전하게 숨겨진 채 유지한다.

## public image 및 orphan audit

purge 전후에 `published_quiz_sets/{id}/images`를 server source로 bounded 조회한다. public parent가 `published`이면 삭제를 중단한다. public image **orphan audit**에서 하나라도 남으면 private parent 삭제를 금지한다. 운영 점검에서도 부모 없는 공개 이미지, 부모 revision과 다른 이미지, `published` 부모의 source revision 불일치를 모두 0으로 확인한다. 자동 공개 backfill이나 child 추정 복구는 없다.

## 배포 전 체크와 순서

운영 데이터나 실제 계정을 변경하기 전에 로컬 Node와 demo Firestore Emulator에서 다음을 모두 통과시킨다.

```powershell
pnpm test
pnpm test:rules
node --check public-quiz-library-core.js
git diff --check
```

다음 read-only auditor는 exact target과 전체 문서 예산을 필수로 받고 기존 출력 파일을 덮어쓰지 않는다. `.reserved`와 JSON 보고서를 함께 보관한다. production 명령은 운영 승인 뒤 새 파일명으로만 실행하며, 이 구현 작업에서는 실행하지 않았다.

```powershell
pnpm audit:public-library -- --project <exact-project-id> --target-mode production --max-documents <bounded-count> --output <new-report>.json
```

보고서가 `complete: true`, `safeToDeployPublicLibrary: true`, `findings: []`가 아니면 배포를 중단한다. 특히 `lifecycleState 누락`, active lifecycle gate/owner lock, PII 필드, orphan child/audit, source revision·allowance 불일치는 모두 실패다. auditor에는 apply 모드가 없다.

1. 백업과 기존 migration gate를 확인하고 `audit:public-library` production dry-run을 새 durable 출력에 실행한다. legacy `lifecycleState` 누락을 포함해 `safeToDeployPublicLibrary`가 false면 자동 수정하지 말고 중단한다.
2. `firebase.json`이 가리키는 `firestore.indexes.json`의 `published_quiz_sets(status ASC, updatedAt DESC, __name__ DESC)` composite index를 먼저 배포하고 build 완료를 확인한다. index가 building/error이면 Rules나 앱 배포를 시작하지 않는다.
3. 테스트된 `firestore.rules`의 해시와 직전 Rules 릴리스를 기록한 뒤 **Rules를 먼저 배포**한다. Emulator 결과 또는 dry-run 감사가 불완전하면 중단한다.
4. 새 Rules가 적용된 것을 재확인한 뒤에만 **정적 앱을 배포**한다. 앱을 먼저 배포하면 lifecycle paired write가 거부되거나 이전 앱이 공개 상태를 남길 수 있다.
5. 아래 actor matrix로 **privacy smoke**를 완료하고 콘솔에서 앱/Firebase origin 오류가 0인지 확인한다.

## privacy smoke actor matrix

| actor | 기대 결과 |
|---|---|
| owner (소유자) | 게시·철회 가능, 휴지통 복원 뒤에는 private 유지 |
| collaborator (공동 편집자) | 원본 편집 가능, 게시·철회 불가 |
| other teacher (다른 승인 교사) | published 목록/get/preview와 독립 복사만 가능 |
| admin (관리자) | 목록·감사·moderation·관리자 복구 가능, 원본 소유권은 없음 |
| student (학생) | 공개 부모와 child 목록/get/copy 모두 거부 |
| anon (익명) | 공개 부모와 child 목록/get/copy 모두 거부 |
| suspended | 공개 자료실 목록/get/copy와 새 게시 모두 거부 |
| deletion_pending | 공개 자료실 목록/get/copy와 새 게시 모두 거부 |

owner A가 질문·해설 이미지를 포함한 세트를 게시하고 teacher B가 이메일/UID를 보지 않은 채 찾아 독립 복사한다. A 철회 뒤 B의 새 복사는 실패하지만 기존 사본은 편집 가능해야 한다. A 재게시 → admin moderation → 소유자 우회 실패 → 휴지통/복원 뒤 private 유지까지 확인한다. 넓은 화면과 모바일 화면의 사용성은 실제 승인 계정 브라우저 인수에서 별도 확인한다.

## 롤백

privacy smoke 또는 수명주기 점검이 실패하면 신규 게시·계정 중지·탈퇴 처리를 중단한다. 데이터나 기존 독립 사본을 되돌리지 않는다. 먼저 정적 앱을 직전 검증 버전으로 롤백하고, 그 앱과 호환되는 직전 Rules 릴리스를 복원한다. 이미 `withdrawn`인 publication은 다시 공개하지 않는다. moderated 항목은 관리자 감사 없이 복구하지 않는다. 실패 batch의 allowance가 active인지, 공개 visible count가 0인지 다시 감사한 후 원인을 수정해 전체 순서를 처음부터 반복한다. `publication_lifecycle_gates/current`가 남으면 공개가 차단된 것이 정상이다. blind delete하지 말고 exact operation 재시도 또는 Admin 조사 뒤 paired lock과 함께 해제한다.

이 구현 작업에서는 production migration, deploy, push, 실제 계정 생성, 메일 발송, 실제 브라우저 인수를 실행하지 않았다.
