# Firestore 이전 설계

## 목표

영상 퀴즈 도구의 저장소를 Firebase Realtime Database에서 Cloud Firestore로 이전해 Spark 요금제의 동시 접속 100명 제한을 제거한다. 교사·학생·관리자 화면과 사용법은 유지하고, Firestore 무료 할당량에서 읽기 수가 불필요하게 증가하지 않도록 데이터 구조와 구독 범위를 제한한다.

## 범위

- `index.html`의 모든 RTDB 읽기·쓰기·실시간 구독을 Firestore로 교체한다.
- 서버 시각 보정, 방 코드 선점, 점수판 갱신, 관리자 기간 삭제를 Firestore 방식으로 재구현한다.
- `firestore.rules`를 추가하고 Firebase 콘솔에서 데이터베이스를 생성해 규칙을 게시한다.
- README와 이전 안내를 갱신하고, 브라우저 회귀 검증 후 GitHub Pages에 배포한다.
- 기존 세트 데이터는 제품의 JSON 내보내기/가져오기로 옮긴다. 별도 마이그레이션 프로그램은 만들지 않는다.
- 교사 계정, 서버 측 채점, UI 개편은 이번 범위에 포함하지 않는다.

## 선택한 접근

화면 코드에서 RTDB API 전체를 흉내 내는 범용 래퍼를 만들지 않는다. 대신 기존 화면 흐름을 유지하면서 Firestore 문서와 컬렉션의 의미가 드러나는 작은 접근 함수들을 둔다. 이 방식은 변경 지점을 명시적으로 보여 주며, 문서와 컬렉션을 혼동하거나 의도치 않은 대규모 읽기를 만드는 위험을 줄인다.

이중 기록도 하지 않는다. 현재 데이터가 세트 한 개이고 JSON 내보내기/가져오기가 이미 있으므로, 이중 기록이 제공하는 복구 이점보다 데이터 불일치와 검증 부담이 더 크다.

## Firestore 데이터 모델

```text
quiz_sets/{setId}
  title, videoId, videoUrl, author, createdAt, updatedAt, archived,
  settings, questions[]

images/{setId}/q/{questionIndex}
  data: data URI

codes/{code}
  sessionId, createdAt

sessions/{sessionId}
  setId, setTitle, label, code, teacher, createdAt, status, endedAt

sessions/{sessionId}/meta/live
  q, openedAt, revealed, limitSec

sessions/{sessionId}/meta/board
  scores: { studentId: correctCount }

sessions/{sessionId}/students/{studentId}
  grade, klass, num, name, joinedAt

sessions/{sessionId}/responses/{studentId}
  answers: {
    questionIndex: { c | cs | txt, ok?, at, ms }
  }

config/app
  adminHash
```

이미지는 문서의 1 MiB 제한을 피하기 위해 문항마다 별도 문서로 저장한다. 학생별 응답은 한 문서에 병합하며, 다른 학생의 응답은 학생 클라이언트가 읽지 않는다. 서술형 응답은 채점 전 `ok` 필드가 없고 점수·정답률 계산에서 제외된다.

## 접근 계층과 데이터 흐름

DB 접근 함수는 다음 책임으로 나눈다.

- 문서 단발 읽기, 쓰기, 병합, 삭제
- 컬렉션 단발 읽기와 실시간 구독
- 스냅샷을 기존 화면이 사용하는 객체 형태로 변환
- 화면 전환 때 모든 `onSnapshot` 해제 함수를 실행하는 정리 등록
- 서버 시각 보정값 초기화 및 재사용

퀴즈 세트 목록·편집·복제·가져오기·내보내기는 `quiz_sets` 문서와 이미지 하위 컬렉션을 단발로 읽고 쓴다. 학생 입장은 코드, 세션, 세트를 각각 한 번 읽은 뒤 학생 문서를 생성하거나 갱신한다.

학생 화면은 `sessions/{sessionId}/meta/live`만 계속 구독한다. 문항이 바뀌면 해당 이미지와 본인 응답을 단발로 읽으며, 대기 화면에 필요한 board도 문항 종료 후 단발로 읽는다. 세션 문서, 학생 컬렉션, 전체 응답 컬렉션은 구독하지 않는다.

교사 재생 화면과 대시보드는 필요한 학생 및 응답 컬렉션을 구독한다. 교사 수만큼만 읽기가 발생하므로 허용한다. 정답 공개 전 재생 화면에는 제출 인원만 표시하고 정답·분포는 숨긴다.

## 쓰기와 동시성

방 코드는 `runTransaction` 안에서 `codes/{code}`의 존재 여부를 확인하고, 비어 있을 때 코드 문서와 세션 초기 문서를 생성한다. 충돌하면 새 코드를 생성해 다시 시도한다.

학생 응답은 자기 응답 문서의 `answers.{questionIndex}` 필드에 병합한다. 문항별 답 한 번에 Firestore 쓰기 한 번만 발생한다. 서술형 교사 채점도 같은 필드의 `ok` 값만 병합한다.

board는 응답마다 갱신하지 않는다. 교사가 문항을 닫고 계속 재생할 때 현재 응답으로 점수를 계산해 `meta/board`를 한 번 갱신한다. 학생은 퀴즈 대기 화면으로 돌아온 뒤 이 요약을 읽는다.

관리자 기간 삭제는 선택된 세션의 학생·응답·meta 문서, 세션 문서, 연결된 코드 문서를 batch 단위 제한에 맞춰 나누어 삭제한다. 퀴즈 세트는 삭제하지 않으며 `archived: true`만 사용한다.

## 서버 시각과 타이머

Firestore에는 RTDB의 `.info/serverTimeOffset`이 없으므로 전용 시각 보정 문서를 사용한다. 앱 시작 후 인증이 끝나면 서버 타임스탬프를 문서에 기록하고 완료된 값을 되읽는다. 되읽은 서버 밀리초와 요청 왕복의 로컬 시작·종료 시각 중간값 차이로 오프셋을 계산해 메모리에 캐시한다.

문항을 열 때 `openedAt`은 `serverTimestamp()`로 기록한다. live 스냅샷에 확정된 Timestamp가 도착하면 밀리초로 변환한다. 타이머는 `Date.now() + cachedOffset`을 기준으로 남은 시간을 계산한다. 초기 보정이 실패하면 사용자에게 재시도 가능한 연결 오류를 표시하며, 보정되지 않은 로컬 시각으로 조용히 진행하지 않는다.

## 보안 규칙

모든 경로는 익명 인증을 포함한 Firebase 인증 사용자를 요구한다. `quiz_sets`는 읽기·생성·수정만 허용하고 삭제는 금지한다. 이미지, 코드, 세션과 모든 세션 하위 컬렉션, config 문서는 인증 사용자에게 필요한 읽기·쓰기를 허용한다.

현재 제품은 익명 사용자 사이에서 교사와 학생 권한을 구분하지 못한다. 이번 이전에서는 기존 보안 수준을 유지하며, 사용자 역할 도입을 가장한 불완전한 규칙은 추가하지 않는다.

## 오류 처리

- 인증, 읽기, 쓰기, 구독 실패는 기존 한국어 오류 UI로 전달한다.
- 실시간 구독 오류가 발생하면 화면에 연결 상태를 표시하고 중복 구독 없이 재진입 시 복구한다.
- 방 코드 충돌은 사용자 오류로 노출하지 않고 제한된 횟수만큼 새 코드로 재시도한다.
- 서버 시각 보정 실패는 타이머 정확성을 보장할 수 없으므로 수업 시작을 막고 재시도를 안내한다.
- batch 일부가 실패하면 성공으로 표시하지 않고, 재조회하여 남은 삭제 대상을 다시 처리할 수 있게 한다.

## 테스트와 검증

현재 빌드 시스템이 없는 단일 HTML 앱이므로, Firestore 접근 함수와 순수 변환·채점·시각 계산 코드를 브라우저와 독립적으로 실행할 수 있는 작은 JavaScript 테스트 하네스로 검증한다. 구현은 테스트 우선으로 진행한다.

자동 검증 대상은 경로 매핑, 스냅샷 변환, 학생별 응답 병합, 미채점 서술형 집계 제외, board 계산, 서버 오프셋 계산, 방 코드 충돌 처리, 관리자 삭제 대상 계산이다. 기존 채점 동작도 회귀 테스트에 포함한다.

Firebase Emulator를 사용할 수 있으면 트랜잭션·구독·보안 규칙을 통합 검증한다. 설치되지 않았거나 프로젝트에 없는 도구를 무단으로 추가하지 않으며, 그 경우 실제 Firebase 테스트 세션과 브라우저 검증으로 대체한다.

배포 전에는 Firebase 콘솔에서 Firestore를 `asia-southeast1`, 프로덕션 모드로 생성하고 `firestore.rules`를 게시한다. 로컬 또는 테스트 배포에서 세트 제작·편집·이미지·두 개 반 코드·교사/학생 동기화·타이머·공개 전 정보 은닉·5종 채점·순위·CSV·관리자 삭제를 확인한다. 이후 main에 한국어 커밋을 푸시하고 GitHub Pages 배포 주소에서 핵심 교사/학생 2창 시나리오와 콘솔 오류 유무를 다시 확인한다.

## 완료 조건

- `index.html`에 RTDB 데이터 접근과 `.info/serverTimeOffset` 사용이 남아 있지 않다.
- 학생은 live 문서 하나만 실시간 구독한다.
- board 쓰기는 문항 종료 시 한 번만 발생한다.
- 타이머가 두 기기에서 1초 이내로 일치한다.
- 기존 화면, URL, 문항 유형, 이미지, 가져오기/내보내기, CSV, 관리자 기능이 유지된다.
- Firestore 규칙이 게시되고 실제 배포 주소가 Firestore 데이터로 정상 동작한다.
- GitHub Pages 배포 후 핵심 회귀 시나리오를 통과한다.
