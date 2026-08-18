# 교사 Google 로그인과 Firestore 권한 강화 설계

## 목표

영상 퀴즈의 학생 참여 흐름은 그대로 유지하면서 교사용 데이터와 학생 개인정보를 Firestore 보안 규칙으로 격리한다. 교사는 승인된 Google 계정으로 로그인하고, 같은 계정이면 어느 컴퓨터에서든 동일한 세트를 수정하고 수업 기록을 확인할 수 있어야 한다. 학생은 Google 로그인 없이 기존과 같이 6자리 반 코드로 참여한다.

## 역할과 인증

### 교사

- Firebase Authentication의 Google 공급자를 사용한다.
- Google 토큰의 `email_verified`가 참이어야 한다.
- `teacher_allowlist/{email}` 문서가 존재해야 교사 권한을 얻는다.
- 승인 문서는 `role: "teacher" | "admin"`을 가진다.
- 승인 목록은 클라이언트에서 목록 조회·생성·변경·삭제할 수 없다. Firebase Console 또는 신뢰할 수 있는 관리자 환경에서만 관리한다.
- 교사는 로그인 상태를 브라우저에 유지하며 다른 컴퓨터에서도 같은 Google 계정으로 접근한다.

### 학생

- 기존 Firebase 익명 인증을 유지한다.
- 반 코드로 세션을 찾은 뒤 자기 익명 UID를 학생 문서에 결합한다.
- 자기 학생 문서와 자기 응답만 읽고 쓸 수 있다.
- 다른 학생의 정보·응답, 원본 세트, 비공개 이미지, 관리자 설정은 읽을 수 없다.

### 관리자

- 기존 클라이언트 관리자 비밀번호와 `config/app.adminHash` 방식을 제거한다.
- 승인 목록에서 `role: "admin"`인 Google 계정만 전체 세션과 전체 학생·응답을 조회하고 보존 기간 삭제를 실행할 수 있다.
- 일반 교사는 자신이 소유한 세트와 자신이 시작한 세션만 관리한다.

## 데이터 모델

### 교사 승인

```text
teacher_allowlist/{verifiedEmail}
  role: "teacher" | "admin"
  enabled: true
  displayName?: string
```

보안 규칙은 `request.auth.token.email`, `email_verified`, 승인 문서의 존재와 `enabled`를 확인한다. 승인 목록 자체의 클라이언트 읽기와 쓰기는 모두 거부한다.

### 퀴즈 세트

```text
quiz_sets/{setId}
  ownerUid: string
  ownerEmail: string
  ...기존 정규화 videos[] 필드
```

- 승인 교사는 모든 공유 세트를 조회하고 수업에 사용하거나 사본을 만들 수 있다.
- 원본 수정·숨김·이미지 교체는 `ownerUid == request.auth.uid`인 소유자만 가능하다.
- 사본은 생성한 교사가 새 `ownerUid`를 가진다.
- 관리자도 일반 세트 수정 권한을 자동으로 얻지 않는다. 관리 역할과 콘텐츠 소유권을 분리한다.

### 세션

```text
sessions/{sessionId}
  teacherUid: string
  teacherEmail: string
  setId: string
  snapshotVersion: 1
  ...기존 세션 필드

sessions/{sessionId}/snapshot/set
sessions/{sessionId}/snapshot_images/{questionKey}
```

- 세션 시작 시 정규화된 세트 구조와 이미지를 한 리비전으로 고정한다.
- `snapshotVersion: 1` 세션은 스냅샷이 없을 때 현재 세트로 조용히 되돌아가지 않고 명시적 오류를 낸다.
- 과거 `snapshotVersion` 없는 세션만 레거시 현재 세트 fallback을 허용한다.
- 세션 시작 중 화면을 떠나면 이미 생성된 코드와 세션을 명시적으로 종료해 고아 세션을 남기지 않는다.

### 학생 공개 데이터

학생은 원본 세트 문서를 읽지 않는다. 교사가 `meta/live`에 현재 문항의 공개 가능한 표현을 기록한다.

```text
sessions/{sessionId}/meta/live
  q: number
  openedAt: timestamp
  limitSec: number
  revealed: boolean
  publicQuestion:
    number: number
    total: number
    type: string
    text: string
    choices: string[]
    image?: string | reference
  publicAnswer?:       # revealed=true일 때만 존재
    answer
    answers
    accept
    explain
```

- 정답 공개 전에는 정답·해설 필드가 존재하지 않아야 한다.
- 정답 공개는 교사만 수행한다.
- 학생용 이미지는 현재 공개 문항에 필요한 자료만 세션 공개 경로에 복사하거나 공개 문항에 안전하게 포함한다.

### 학생과 응답

```text
sessions/{sessionId}/students/{studentUid}
  uid: studentUid
  grade, class, number, name

sessions/{sessionId}/responses/{studentUid}
  answers.{globalQuestionIndex}:
    answer
    submitted
    revision
    submittedAt
```

- 학생 문서 ID와 응답 문서 ID는 인증 UID를 기준으로 한다.
- 학생은 답, 제출 상태, 증가하는 revision만 변경할 수 있다.
- 학생은 `ok`, 점수, 다른 학생 필드를 기록할 수 없다.
- 교사만 정오 판정과 점수판을 기록한다.
- 학생 쓰기는 문항별로 직렬화하고, 실패 결과는 문항이 닫힌 뒤에도 해당 화면 상태에 정확히 반영한다.

## Firestore 규칙 원칙

- 기본값은 모든 경로 거부다.
- `list`와 `get`을 구분해 코드·승인 목록·학생 데이터를 열거하지 못하게 한다.
- 교사 판별은 익명 인증 여부가 아니라 검증된 이메일과 비공개 승인 문서로 수행한다.
- 세트 소유권, 세션 `teacherUid`, 학생 `uid`를 모든 하위 경로에서 재검증한다.
- 학생 응답 쓰기는 허용 필드, 자기 UID, revision 증가, 변경 가능한 키를 검증한다.
- 학생은 정답 공개 전 정답 원본에 도달할 수 없다.
- 관리자 삭제는 `role == "admin"`과 화면에 고정된 300건 이하 결과 집합을 모두 만족해야 한다.
- Emulator 테스트로 승인 교사, 소유 교사, 다른 교사, 관리자, 등록 학생, 다른 학생, 미승인 Google 계정, 익명 미등록 사용자를 각각 검증한다.

## 교사 화면

- 홈의 네 메뉴 구조는 유지한다.
- 교사용 메뉴를 누르면 미로그인 사용자는 Google 로그인 안내를 본다.
- 로그인 후 우측 상단에 이름, 이메일, 로그아웃을 표시한다.
- 미승인 계정에는 데이터 대신 승인 요청 안내를 표시한다.
- 일반 교사는 자기 세트를 편집하고 다른 교사 세트는 수업 사용·사본 만들기만 할 수 있다.
- 관리자 통합 조회는 비밀번호 입력 대신 `admin` 역할을 확인한다.
- 로그인 만료나 네트워크 실패 시 편집 초안을 삭제하지 않는다.

## 학생 화면

- 학생은 Google 로그인 UI를 보지 않는다.
- 기존 6자리 코드, 학년·반·번호·이름 입력 흐름을 유지한다.
- 입장 성공 시 현재 익명 UID를 학생 문서에 결합한다.
- 같은 UID가 아닌 브라우저는 동일 학번을 입력해도 기존 응답을 덮을 수 없다.
- 학생은 공개된 현재 문항과 자기 응답·자기 점수만 읽는다.

## 기존 데이터 이전

### 이전 소유자 지정

- Firebase Console에 승인 교사 이메일과 `legacy_owner` 이메일을 등록한다.
- `legacy_owner`와 일치하는 승인 교사가 로그인한 경우에만 기존 `ownerUid` 없는 세트를 귀속할 수 있다.
- 최초 공개 방문자가 기존 데이터를 선점하는 방식은 금지한다.

### 멱등 이전

- 기존 세트에 `ownerUid`, `ownerEmail`을 추가한다.
- 기존 세션에 `teacherUid`, `teacherEmail`과 가능한 세트 스냅샷을 추가한다.
- 이미 이전된 문서는 건너뛴다.
- 세트·이미지·세션·학생·응답의 성공, 건너뜀, 실패 수와 문서 ID를 보고한다.
- 일부 실패 후 같은 이전을 다시 실행해도 중복 세트나 응답을 만들지 않는다.

### 단계적 배포

1. Google 로그인 UI, 새 필드, 이전 화면을 기존 규칙 아래 먼저 배포한다.
2. 승인 이메일과 `legacy_owner`를 Firebase Console에서 등록한다.
3. 승인 교사가 로그인해 이전을 실행하고 문서 수를 대조한다.
4. Firestore Emulator 권한 테스트를 통과시킨다.
5. 엄격한 규칙을 배포한다.
6. 교사 두 컴퓨터, 학생 다섯 명, 영상 두 개로 실제 회귀를 수행한다.
7. 문제가 생기면 데이터는 되돌리지 않고 규칙을 직전 버전으로 롤백한다.

## 남은 데이터 무결성 보완

보안 전환과 함께 최종 검토에서 남은 항목을 해결한다.

- 스냅샷 구조와 이미지를 동일 리비전으로 읽고, 새 세션에서 누락 fallback을 금지한다.
- 문항 대기열은 `setLive()` 성공 뒤에만 항목을 제거하고 수동 공개 시 중복을 제거한다.
- 학생 쓰기 실패는 현재 live 문항이 바뀌어도 상태 소유권과 revision으로 롤백·안내한다.
- 이미지 포함 원자 저장은 Firestore transform 수와 10 MiB 요청 크기를 사전 계산하거나 리비전 staging을 사용한다.
- 관리자 300건 초과 조회는 탭 전환 후에도 삭제 대상으로 다시 만들어지지 않게 한다.
- 화면 이동 중 완료된 세션 시작은 생성된 코드·세션을 즉시 정리한다.

## 오류 처리

- 팝업 차단, Google 로그인 취소, 미승인 이메일, 오프라인, 토큰 만료를 서로 다른 한국어 안내로 표시한다.
- 로그인 실패는 학생 참여 화면을 막지 않는다.
- 권한 거부를 일반 네트워크 오류로 숨기지 않는다.
- 이전 실패는 성공 문서를 되돌리지 않고 실패 문서만 재시도하게 한다.
- 세션·세트 원자 쓰기가 Firestore 크기·쓰기 한도를 넘으면 저장 전에 구체적인 안내를 표시한다.

## 테스트와 완료 조건

- Google 로그인한 승인 교사가 두 컴퓨터에서 같은 세트를 수정할 수 있다.
- 다른 승인 교사는 원본을 수정하지 못하고 사본을 만들어 편집할 수 있다.
- 미승인 Google 계정은 교사 데이터를 읽거나 쓰지 못한다.
- 일반 교사는 다른 교사의 학생·응답·세션을 읽지 못한다.
- 관리자는 전체 조회가 가능하지만 승인 목록 자체는 웹에서 바꾸지 못한다.
- 학생은 자기 학생·응답 문서만 읽고 쓰며 `ok`와 점수를 조작하지 못한다.
- 정답 공개 전 학생은 원본 정답·해설·다른 문항 이미지에 접근하지 못한다.
- 기존 세트·이미지·세션·응답 수가 이전 전후에 일치한다.
- 스냅샷 세션은 이후 원본 세트 편집과 무관하게 동일한 문항·이미지를 표시한다.
- Emulator 권한 테스트와 전체 자동 테스트가 통과한다.
- 교사 한 명, 학생 다섯 명, 영상 두 개의 생성·진행·제출·전환·완료·명시적 종료를 실제 브라우저에서 검증한다.
- 최종 코드 검토에서 Critical/Important finding이 없을 때만 규칙과 사이트를 공개 배포한다.

