# 인수인계 프롬프트 (Codex 등 다른 도구에 넘길 때)

> 2026-08-21 이메일·비밀번호 교사 인증은 코드·Rules·자동 검증 뒤에도 Firebase Console 설정, 실제 계정/메일, 배포와 브라우저 인수가 **미실행 운영 gate**입니다. [`docs/EMAIL-TEACHER-AUTH.md`](./docs/EMAIL-TEACHER-AUTH.md)의 authoritative full sequence를 축약하지 말고 그대로 따르십시오: Firebase Password Policy 최소 길이 8·Enforcement `Require` → Node/Emulator 검증 → 호환 head Rules → access exact lock/apply → session join lock/recount/gate → 두 durable 보고서의 `safeToDeployStrictRules: true` 확인 → 잠금을 유지한 strict UID Rules·static app → 같은 generation post-deploy verify → exact unlock → 그 뒤에만 Email/Password 공급자 활성화(Google·Anonymous 유지) → Google 관리자·새 이메일 교사 브라우저 인수. token/updateTime generation이 달라지거나 UID/counter audit가 불완전하면 활성화·unlock을 중단합니다. 인수가 실패하면 Firebase 사용자와 `teacher_allowances`는 그대로 두고 앱과 Rules만 authoritative 롤백 절차로 되돌립니다. 실제 콘솔 변경, 계정 생성·메일 발송, deploy/push는 이 문서 작업에서 수행하지 않았습니다.

> 2026-08-20 교사 개인 계정 권한 신청·수업계획·현황판 전환 준비: 운영 migration/deploy/browser 인수는 미실행입니다. [`docs/TEACHER-ACCESS-CLASS-PLANNING.md`](./docs/TEACHER-ACCESS-CLASS-PLANNING.md)의 backup → Emulator → 호환 head Rules 선배포 → access exact lock/apply → session join lock/recount/gate → strict Rules·static app → 같은 generation verify → exact unlock → 관리자 1명·교사 2명·겹친 수업 2개 smoke 순서를 그대로 따르십시오. 두 apply durable 보고서의 `safeToDeployStrictRules: true`와 두 lock token/updateTime generation이 배포 후 verify 보고서까지 같아야 합니다. 진행 중인 legacy session, counter/UID 불일치, partial audit 또는 generation 변경이 하나라도 있으면 배포를 중단합니다.

> OX·이미지 구현은 **끝났습니다.** 이 문서는 남은 검증과 다듬기를 넘길 때 쓰라고 만든 것입니다.
> 그대로 복사해 붙여넣으면 됩니다.

---

## 붙여넣을 프롬프트

```
프로젝트: 영상 퀴즈 실시간 진행 도구
저장소: https://github.com/shining-jade/video-quiz  (public, GitHub Pages)
배포 주소: https://shining-jade.github.io/video-quiz/
파일: index.html 한 개 (약 3,000줄, CSS/JS 인라인, 빌드 없음)
백엔드: Firebase Realtime Database (프로젝트 idst-84e4f) + 익명 인증
       모든 데이터는 vq/ 네임스페이스 아래. 같은 프로젝트를 쓰는 다른 도구가
       settings/, rooms/ 를 쓰고 있으니 절대 건드리지 말 것.

[이미 구현되어 있는 것]
- 퀴즈 세트 제작(#/make), 세트 목록·복제·숨기기(#/sets), 교사 재생(#/play/{setId}),
  학생 참여(#/join/{code}), 실시간 대시보드(#/live/{sessionId}), 관리자 조회(#/admin)
- 문항 유형 5종: choice(객관식) / multi(복수 정답) / ox / short(단답, 자동채점) / long(서술, 교사채점)
- 문항 이미지: 파일 업로드(브라우저에서 canvas로 축소·JPEG 압축 후 data URI) + 외부 주소
  이미지는 quiz_sets 가 아니라 vq/images/{setId}/{문항index} 에 따로 저장하고,
  해당 문항이 열릴 때만 loadQuestionImage() 로 내려받는다 (학생 30명 전송량 절약)
- 서술형 채점: 학생 응답에 ok 필드 없이 저장 → 미채점. 대시보드 문항 아코디언에서
  dashGrade(qIdx, studentId, true/false/null) 로 교사가 채점. 정답률 계산은 graded 기준
- 타이머는 Firebase 서버 시각(.info/serverTimeOffset)으로 보정해 기기 간 오차 제거
- 교사 재생 화면은 교실 앞에 투사되므로 공개 전에는 정답 표시와 응답 분포를 모두 감춘다

[데이터 구조]
vq/quiz_sets/{setId}
   settings: {revealMode: instant|timer|manual|never, limitSec, revealDelaySec, autoPause}
   questions[i]: {type, t, text, choices[], answer, answers[], accept[], imgUrl, imgUp, explain, limitSec}
vq/images/{setId}/{i}          -> data URI 문자열 (최대 400,000자)
vq/codes/{CODE}                -> {sessionId}
vq/sessions/{sessionId}
   live: {q, openedAt, revealed, limitSec}   // q=-1 이면 대기
   students/{학년_반_번호}: {grade, klass, num, name, joinedAt}
vq/responses/{sessionId}/{문항index}/{학년_반_번호}
   {c}      선택형 — 보기 index
   {cs}     복수 정답 — "0,2" 형태 문자열
   {txt}    단답형·서술형 — 학생이 쓴 글
   {ok}     true/false. 없으면 미채점(서술형)
   {at, ms} 서버시각, 반응시간(ms)

[남은 일]
1. 아래 시나리오를 실제 배포 주소에서 끝까지 돌려 확인할 것.
   창을 2개 열어 한쪽은 교사(#/play/{setId}), 한쪽은 학생(#/join/{code})으로.
   - 5가지 유형을 한 세트에 담아 저장 → 되불러왔을 때 유형·정답·인정답안이 유지되는가
   - 복수 정답: 일부만 골랐을 때 오답, 정확히 같을 때만 정답
   - 단답형: "손 씻기" 정답일 때 "손씻기", "손씻기." 도 정답 처리되는가
   - 서술형: 학생 화면에 미채점으로 남고, 대시보드 O/X 누르면 점수·정답률에 즉시 반영되는가
   - 이미지: 업로드한 사진이 교사 화면과 학생 폰 양쪽에 뜨는가, 세트 복제 시 그림도 따라오는가
   - CSV 내보내기에 텍스트 답안과 미채점 표시가 제대로 들어가는가
2. 발견되는 문제를 고치고 git push (푸시하면 1~2분 뒤 자동 배포)

[주의]
- 데이터베이스 보안 규칙은 database.rules.json 에 있다. 필드를 추가하면 규칙도 같이
  고쳐 Firebase 콘솔 → Realtime Database → 규칙에 붙여넣고 게시해야 한다.
  게시 전에는 새 필드 쓰기가 permission_denied 로 막힌다.
- quiz_sets 는 규칙으로 삭제가 막혀 있다(다른 교사가 쓰는 세트 보호). 정리는 archived 플래그로 한다.
- 학생 이름·학번을 다루므로 화면에 개인정보가 노출되는 변경은 신중히.
- 커밋 메시지는 한국어로, 무엇을 왜 고쳤는지 쓴다.
```

---

## 지금 상태 요약 (넘기지 않고 직접 이어갈 때)

| 항목 | 상태 |
|---|---|
| 문항 유형 5종 | 구현 완료, 채점 로직 단위 검증 완료 |
| 제작 화면 유형별 UI | 구현 완료, 5종 렌더링·저장 페이로드 검증 완료 |
| 문항 이미지 | 구현 완료, **실제 업로드 왕복은 미검증** |
| 서술형 채점 UI | 구현 완료, **실제 채점 왕복은 미검증** |
| 영상 좌 / 문항 우 배치 | 구현 완료, **실제 화면 확인 필요** |
| 해설 상단 강조 | 구현 완료 |
| DB 규칙 | 파일 갱신 완료, **콘솔 게시 필요** |
