# Firestore 이전 인수인계 프롬프트

> 아래 코드블록 전체를 복사해 Codex(또는 다른 코딩 에이전트)에게 그대로 붙여넣으세요.
> 작업 폴더는 `C:\Users\user\Desktop\영상퀴즈` 입니다.

---

````
# 작업: 영상 퀴즈 도구를 Firebase Realtime Database → Cloud Firestore 로 이전

## 배경 (왜 하는가)

교실용 실시간 퀴즈 웹도구다. 지금 Firebase **Realtime Database**를 쓰는데,
무료(Spark) 요금제의 **동시 접속 100명** 한도에 막힌다.
학교에서 여러 반이 동시에 진행하면 초과분이 연결 거부된다.

같은 Firebase 프로젝트의 **Cloud Firestore** 는 무료 요금제에서 동시 접속 한도가
없다(요금표에 항목 자체가 없음). 대신 하루 읽기 5만 / 쓰기 2만 / 삭제 2만으로 센다.
콘솔에서 Spark 플랜 그대로 [데이터베이스 만들기]가 가능한 것을 확인했다.

**이 이전의 목적은 동시 접속 벽을 없애는 것이다. 화면·사용법은 하나도 바뀌면 안 된다.**

## 현재 상태

- 파일: `index.html` 한 개, 3,893줄. CSS/JS 전부 인라인. 빌드 도구 없음.
- 저장소: https://github.com/shining-jade/video-quiz (public)
- 배포: GitHub Pages — https://shining-jade.github.io/video-quiz/
  `git push` 하면 1~2분 뒤 자동 반영.
- Firebase 프로젝트: `video-quiz-65798` (Spark 무료, 위치 asia-southeast1)
  - Realtime Database: 사용 중 (이전 대상)
  - Authentication: **익명 로그인 사용 설정됨** — 그대로 쓴다
  - Firestore: 아직 안 만듦 — 새로 만들어야 함
- 보안 규칙 원본: `database.rules.json` (RTDB 문법). Firestore 규칙은 문법이 완전히 다르니 새로 써야 한다.

## 코드에서 손댈 지점

모든 DB 접근이 이 헬퍼들을 지나간다. **여기만 갈아끼우면 화면 코드는 거의 안 건드려도 된다.**

```js
function R(path) { return db.ref(path ? 'vq/' + path : 'vq'); }   // 모든 경로의 진입점
function watch(ref, event, cb) { ref.on(event, cb); onCleanup(...); }  // 실시간 구독 10곳
function every(ms, fn) { ... }
```

호출 통계 (grep 결과):
- `R('sessions/...')` 18곳, `R('quiz_sets/...')` 11곳, `R('images/...')` 8곳,
  `R('responses/...')` 6곳, `R('codes/...')` 2곳, `R('config/adminHash')` 2곳
- `watch(...)` 10곳 (실시간 구독), `.once('value')` 21곳 (단발 읽기)
- `.transaction()` 1곳 — 반 코드 중복 방지 (`plStartSession`)
- `R('').update(updates)` 1곳 — 3838번째 줄 근처, 관리자 기간 삭제 (다중 경로 일괄 삭제)

## 현재 데이터 구조 (RTDB)

```
vq/quiz_sets/{setId}
    title, videoId, videoUrl, author, createdAt, updatedAt, archived
    settings: { revealMode: instant|timer|manual|never, limitSec, revealDelaySec, autoPause }
    questions[i]: { type: choice|multi|ox|short|long, t, text, choices[], answer,
                    answers[], accept[], imgUrl, imgUp, explain, limitSec }
vq/images/{setId}/{문항index}   -> data URI 문자열 (최대 40만 자, 이미지 압축본)
vq/codes/{6자리코드}            -> { sessionId, createdAt }
vq/sessions/{sessionId}
    setId, setTitle, label, code, teacher, createdAt, status(live|ended), endedAt
    live: { q, openedAt, revealed, limitSec }        // q = -1 이면 대기
    board: { {학년_반_번호}: 맞힌개수 }               // 교사가 올리는 점수 요약
    students: { {학년_반_번호}: {grade, klass, num, name, joinedAt} }
vq/responses/{sessionId}/{문항index}/{학년_반_번호}
    { c(선택형 보기index), cs("0,2" 복수정답), txt(단답·서술), ok(true/false/없음=미채점), at, ms }
vq/config/adminHash             -> 관리자 비밀번호 SHA-256
```

## 권장 Firestore 구조

Firestore는 문서 단위로 읽기를 세므로, **자주 바뀌는 것과 통째로 읽는 것을 분리**해야 한다.

```
quiz_sets/{setId}                     문서 1개 (questions 는 배열 필드로 그대로)
images/{setId}                        문서 1개, 필드 {"0": dataURI, "1": ...}
                                      ※ 문서 1MB 한도 주의. 이미지 40만자 × 2~3장이면 초과.
                                      → 이미지는 images/{setId}/q/{i} 하위 컬렉션 권장
codes/{코드}                          { sessionId, createdAt }
sessions/{sessionId}                  setId, setTitle, label, code, teacher, createdAt, status, endedAt
sessions/{sessionId}/meta/live        ★ live 를 별도 문서로 (학생 전원이 구독하는 유일한 문서)
sessions/{sessionId}/meta/board       ★ board 도 별도 문서
sessions/{sessionId}/students/{학번}
sessions/{sessionId}/responses/{학번}  ★ 학생당 문서 1개, 필드에 문항별 답
                                      { "0": {c,ok,at,ms}, "1": {txt,at,ms}, ... }
                                      → 문항마다 문서를 만들면 쓰기가 문항수만큼 늘어난다
config/app                            { adminHash }
```

**이 구조를 고른 이유:**
- `live` 를 세션 문서에서 분리 = 교사가 학생 목록·점수를 갱신해도 학생 200명에게
  읽기가 발생하지 않는다. 문항 열 때만 200 읽기.
- 응답을 학생당 1문서 = 학생이 답할 때 쓰기 1회(merge). 문항별 문서면 같지만
  교사 대시보드가 컬렉션을 구독할 때 문서 수가 적어 유리하다.

## 무료 한도 안에서 돌리기 위한 필수 조치

하루 읽기 5만이 유일한 실질 제약이다. 반드시 지킬 것:

1. **실시간 순위(board) 갱신 주기를 늘려라.** 지금은 응답마다 900ms 디바운스로
   올린다. 학생 200명이 구독하면 board 1회 갱신 = 200 읽기다.
   → **문항이 닫힐 때(계속 재생 누를 때)만** 갱신하도록 바꿔라. 문항당 1회면 충분하다.
2. **학생은 `live` 문서 하나만 구독**한다. 세션 문서·students·responses 를 학생이
   구독하게 만들지 마라 (지금도 그렇게 되어 있으니 유지).
3. **교사 대시보드**는 responses 컬렉션을 구독한다. 교사 수만큼만 읽으므로 괜찮다.
4. 퀴즈 세트는 학생 입장 시 1회 `get()`. 구독(onSnapshot) 하지 마라.
5. 관리자 화면의 전체 조회는 `get()` 만 쓴다.

## Firestore 보안 규칙 (그대로 쓰면 됨)

RTDB 규칙과 달리 하위로 상속되지 않으므로 경로마다 명시해야 한다.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }

    match /quiz_sets/{setId} {
      allow read: if signedIn();
      allow create, update: if signedIn();
      allow delete: if false;              // 공유 세트 보호 — 삭제 금지 유지
    }
    match /images/{setId} {
      allow read, write: if signedIn();
      match /q/{i} { allow read, write: if signedIn(); }
    }
    match /codes/{code} {
      allow read, write: if signedIn();
    }
    match /sessions/{sessionId} {
      allow read, write: if signedIn();
      match /{sub=**} { allow read, write: if signedIn(); }
    }
    match /config/{doc} {
      allow read, write: if signedIn();
    }
  }
}
```

## 반드시 유지해야 할 동작 (회귀 금지 목록)

1. **교사 재생 화면은 교실 앞에 투사된다.** 정답 공개 전에는 정답 표시도 응답 분포도
   보이면 안 된다. 제출 인원만 보인다.
2. **타이머는 서버 시각 기준**이다. RTDB의 `.info/serverTimeOffset` 을 쓰고 있는데,
   Firestore에는 없다. → `serverTimestamp()` 로 쓴 `openedAt` 을 되읽어
   로컬 시계와의 차이를 한 번 구해 캐시하는 방식으로 대체하라.
   **이걸 대충 하면 기기마다 카운트다운이 어긋난다. 이 도구에서 가장 중요한 부분이다.**
3. **반 코드 중복 방지**: 지금은 RTDB transaction 으로 선점한다.
   → Firestore `runTransaction` 으로 `codes/{코드}` 존재 확인 후 생성.
4. 학생에게 다른 학생의 응답을 내려보내지 마라 (답 베끼기 방지). 순위는 board 요약만.
5. 서술형은 `ok` 필드 없음 = 미채점. 점수·정답률 계산에서 빼야 한다.
6. 세트 삭제는 막고 `archived: true` 로 숨긴다.
7. 세트 내보내기/가져오기(JSON 파일) 기능이 계속 동작해야 한다.

## 작업 순서 제안

1. Firebase 콘솔 → Firestore → 데이터베이스 만들기 (위치 asia-southeast1, 프로덕션 모드)
2. 위 보안 규칙 게시
3. `index.html` 에 `firebase-firestore-compat.js` 추가 (기존 database-compat 는 당분간 같이 둬도 됨)
4. `R()` / `watch()` 를 Firestore용으로 새로 구현. 화면 코드의 호출 형태를 최대한 유지해
   diff 를 작게 만들 것.
5. 서버 시각 보정 대체 구현
6. 기존 RTDB 데이터 이전: 세트 1개뿐이라 도구 안의
   [📤 파일] 내보내기 → [📥 세트 가져오기] 로 옮기면 된다. 코드로 옮길 필요 없음.
7. 배포 후 아래 검증

## 검증 체크리스트 (배포 주소에서 실제로 할 것)

창을 2개 열어 한쪽 교사(`#/play/{setId}`), 한쪽 학생(`#/join/{코드}`)으로:

- [ ] 세트 제작 → 5가지 유형(객관식/복수정답/O·X/단답형/서술형) 저장 후 재편집 시 그대로인가
- [ ] 이미지 업로드 → 교사 화면과 학생 화면 양쪽에 뜨는가
- [ ] 같은 세트로 창 2개에서 각각 반 시작 → **다른 반 코드**가 나오고 응답이 안 섞이는가
- [ ] 문항 열림이 학생 화면에 1초 안에 뜨는가
- [ ] **두 기기의 남은 시간이 1초 이내로 일치하는가** (서버 시각 보정 확인)
- [ ] 정답 공개 전 교사 화면에 정답/분포가 안 보이는가
- [ ] 단답형 "손 씻기"가 정답일 때 "손씻기", "손씻기." 도 정답 처리되는가
- [ ] 복수 정답이 정확히 일치할 때만 정답인가
- [ ] 서술형이 미채점으로 남고, 대시보드 O/X 채점이 점수에 반영되는가
- [ ] 실시간 순위가 교사 사이드바와 [🏆 크게 보기]에 나오는가
- [ ] 학생 대기 화면에 맞힌 개수·남은 문항·내 순위가 나오는가
- [ ] CSV 내려받기에 텍스트 답안과 미채점 표시가 들어가는가
- [ ] 관리자(`#/admin`, 기본 비번 admin1234) 로그인 → 전 세션 조회·기간 삭제
- [ ] Firebase 콘솔 사용량에서 읽기 횟수를 확인해, 수업 1회당 예상보다 크게 튀지 않는가

## 주의

- 커밋 메시지는 한국어로, 무엇을 왜 고쳤는지 쓴다.
- 학생 이름·학번을 다루므로 화면에 개인정보가 더 노출되는 변경은 하지 마라.
- `database.rules.json` 은 RTDB 시절 규칙이다. Firestore 규칙은 별도 파일
  (`firestore.rules`)로 만들고 README 를 갱신하라.
- 이전이 끝나 안정되면 RTDB 관련 코드와 `database.rules.json` 을 정리하라.
````

---

## 지금 상태 요약 (넘기지 않고 직접 이어갈 때)

| 항목 | 상태 |
|---|---|
| 전용 Firebase 프로젝트 `video-quiz-65798` | ✅ 생성·규칙·익명인증 완료 |
| 현재 동작 | ✅ RTDB 기준으로 정상 (동시 접속 100명 한도) |
| Firestore 데이터베이스 | ⛔ 아직 안 만듦 |
| Firestore 이전 | ⛔ 미착수 — 위 프롬프트대로 진행 |
