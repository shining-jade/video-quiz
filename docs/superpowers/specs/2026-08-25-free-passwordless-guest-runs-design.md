# 무료 비로그인 교사 실행 링크 설계

## 목표

운영자만 기존 교사 계정으로 세트를 제작·수정·삭제하고 실행 기록을 확인한다. 수업을 진행하는 다른 교사는 로그인 화면, 비밀번호, 승인 절차 없이 운영자가 전달한 링크만 열어 자기 반 수업을 시작한다. Firebase Spark 무료 요금제만 사용하며 Cloud Functions와 유료 전환을 요구하지 않는다.

## 범위

- 운영자 인증과 기존 비공개 세트 소유권은 유지한다.
- 일반 교사용 계정 신청·승인·로그인은 공유 실행 흐름에서 제거한다.
- 기존 `#/play/{setId}`는 운영자 전용으로 유지한다.
- 새 `#/guest-play/{shareId}` 링크만 비로그인 실행을 허용한다.
- 학생 참여 링크 `#/join/{code}`와 기존 응답·채점 구조는 유지한다.
- 공개 자료실, 공동 편집, 관리자 계정 관리의 제거는 이번 범위에 포함하지 않는다.

## 무료 보안 모델

Cloud Functions가 없으므로 서버에서 별도 bearer secret을 교환하거나 custom token을 발급하지 않는다. 대신 암호학적으로 추측하기 어려운 32바이트 무작위 `shareId` 자체를 링크의 비밀값으로 사용한다.

- Firestore에는 실행용 허용 목록 projection만 `guest_quiz_shares/{shareId}` 아래에 저장한다.
- projection에는 제목, 영상, 문항, 정답, 해설, 실행 설정, 필요한 이미지만 포함한다.
- 운영자 UID·이메일, 공동 편집자, 관리자 정보, 원본 비공개 경로는 projection에서 제외한다.
- 링크를 가진 사람은 projection을 읽고 새 수업을 시작할 수 있다.
- 링크 유출은 비밀번호 복구가 아니라 공유 해제와 새 `shareId` 발급으로 대응한다.
- Firestore Rules는 원본 `quiz_sets`에 대한 익명 읽기를 계속 금지한다.

이 모델은 링크 전달 대상의 사용 편의성과 무료 운영을 우선한다. 링크를 전달받은 사람이 다시 공유하는 것을 기술적으로 막지는 못한다.

## 데이터 구조

`guest_quiz_shares/{shareId}` 부모 문서는 다음 정보를 가진다.

- `shareId`, `sourceSetId`, `sourceOwnerUid`
- `status`: `active` 또는 `revoked`
- `revision`, `schemaVersion`
- 콘텐츠 개수와 생성·갱신·해제 시각

영상·문항·이미지는 현재 구현의 revision 하위 컬렉션을 재사용한다. 토큰 해시와 custom capability 필드는 제거한다. 원본 세트를 저장하면 활성 공유의 새 revision을 먼저 완성한 뒤 부모 revision을 전환하여 기존 링크가 최신 완성본만 읽게 한다.

익명 실행 세션은 기존 `sessions/{sessionId}` 구조를 재사용하며 다음 provenance를 고정한다.

- `sessionActorType: "guest"`
- `sourceShareId`, `sourceSetId`, `sourceOwnerUid`, `sourceRevision`
- `teacherUid`: 브라우저에서 자동 생성된 Firebase Anonymous Auth UID

각 실행은 독립된 session ID와 6자리 반 코드를 받는다. 같은 공유 링크를 동시에 사용해도 학생·응답·채점은 세션 경로별로 분리된다.

## 화면 흐름

운영자는 세트 목록에서 `비로그인 진행 링크`를 누른다. 활성 링크가 없으면 새 `shareId`와 projection을 만들고 `#/guest-play/{shareId}`를 복사한다. 활성 링크가 있으면 같은 링크를 다시 복사한다. `공유 링크 해제`는 새 실행을 즉시 차단하며 재발급은 완전히 다른 `shareId`를 만든다.

다른 교사가 링크를 열면 앱은 로그인 대화상자를 표시하지 않고 Firebase Anonymous Auth를 백그라운드에서 수행한다. 활성 projection을 읽어 제목·문항 수·설정을 보여주고 선택적 반 이름과 `우리 반 시작하기` 버튼을 표시한다. 시작하면 새 반 코드를 만들고 기존 진행 화면을 guest 모드로 연다.

잘못되었거나 해제된 링크는 `사용할 수 없는 진행 링크입니다. 만든 분에게 새 링크를 요청해 주세요.`만 표시한다. 운영자 메뉴, 세트 편집, 관리자 화면은 노출하지 않는다.

## 권한 규칙

- 활성 공유 projection은 문서 ID를 아는 사용자에게 읽기를 허용한다.
- 목록 조회는 금지하여 공유 ID를 열거할 수 없게 한다.
- 익명 사용자는 활성 공유 revision으로 자기 UID의 guest 세션만 만들 수 있다.
- guest 세션의 provenance, UID, source revision은 생성 후 변경할 수 없다.
- guest 실행자는 자기 세션의 진행·문항 공개·채점·종료만 수행한다.
- 다른 guest UID는 해당 세션과 응답을 읽거나 변경할 수 없다.
- 원본 운영자는 `sourceOwnerUid`로 파생 세션과 학생·응답·점수를 읽을 수 있지만 guest 재생 상태를 변경하지 않는다.
- 링크 해제 후 새 세션 생성은 거부한다. 이미 생성된 자기 세션은 안전한 종료만 허용한다.

## 기존 유료 구현 정리

- `exchangeGuestQuizShare` 호출과 Functions SDK 의존을 제거한다.
- custom token, `guestCapabilityExpiresAt`, token hash 검증을 제거한다.
- `functions/`와 Firebase Functions 설정은 배포 대상에서 제거한다.
- 기존 링크에 `?token=`이 있으면 토큰을 무시하지 않고 잘못된 구형 링크로 안내하여 새 링크 발급을 요구한다.
- 이미 생성된 미배포 개발용 share 문서는 운영 데이터에 없으므로 migration을 실행하지 않는다. 운영에 문서가 발견되면 새 형식과 구분해 읽지 않고 운영자가 새 링크를 발급한다.

## 오류 처리

- Anonymous provider가 꺼져 있으면 일반 교사에게 계정 로그인 대신 공유 링크 준비 실패 안내를 표시한다.
- projection publication이 중간 실패하면 부모를 활성화하지 않아 불완전한 콘텐츠가 노출되지 않는다.
- 원본 저장은 성공하고 공유 revision 갱신만 실패하면 기존 revision을 유지하고 운영자에게 재시도를 안내한다.
- 코드 충돌과 세션 활성화 실패는 기존 allocation 복구·abort 흐름을 재사용한다.

## 검증

- projection에서 개인정보와 원본 소유권 필드가 제외되는 단위 테스트
- 공유 ID direct get 허용, collection list 거부, private set 익명 읽기 거부 Rules 테스트
- 두 anonymous UID가 같은 링크에서 서로 다른 세션과 반 코드를 만들고 교차 접근하지 못하는 Rules 테스트
- 해제 후 새 실행 거부와 기존 실행 안전 종료 테스트
- 기존 `#/play/{setId}`가 계속 운영자 로그인을 요구하고 `#/guest-play/{shareId}`는 요구하지 않는 화면 테스트
- 두 격리 브라우저에서 반별 학생과 응답이 섞이지 않는 인수 테스트
- Cloud Functions 없이 Spark 프로젝트에서 동작하는 배포 검증

## 배포

Functions 배포는 하지 않는다. 배포 순서는 Firestore index 준비 완료, Firestore Rules 배포, GitHub Pages의 최신 정적 앱 반영이다. Firebase Console에서 Anonymous provider가 활성화되어 있어야 한다. 실패 시 먼저 새 공유 링크 생성을 숨기고 직전 Rules와 정적 앱을 복원하며 기존 세션과 응답은 삭제하지 않는다.
