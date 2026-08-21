# 이메일·비밀번호 교사 인증 운영 절차

이 문서는 기존 Google 교사 로그인과 학생 익명 로그인을 유지한 채 Firebase Authentication의 이메일·비밀번호 교사 계정을 운영에 추가하는 **배포 전 gate**다. 이메일 인증은 이메일 소유 확인일 뿐 교사 권한이 아니다. 인증을 마친 사용자는 기존 신청 화면으로 한 번 신청하고, 관리자가 승인한 뒤에만 교사 기능을 사용한다.

이 절차는 Firebase Console 변경, 실제 계정 생성·메일 전송, Rules·정적 앱 배포를 승인하지 않는다. 아래 준비와 자동 검증을 마친 뒤 별도 운영 변경 창에서만 실행한다.

## 1. Firebase Authentication 준비

1. Firebase Console → **Authentication → Sign-in method**에서 **Email/Password**를 사용 설정한다.
2. 이미 사용 중인 **Google**(교사)과 **Anonymous**(학생) 공급자는 끄거나 다시 만들지 않는다. Google 로그인과 익명 학생 입장은 회귀 검증 대상이다.
3. Authentication → **Settings → Authorized domains**에서 `shining-jade.github.io`가 **승인된 도메인**인지 확인한다. 기존 운영 도메인은 삭제하지 않는다.
4. Authentication → **Templates**에서 이메일 인증과 비밀번호 재설정 템플릿을 한국어로 설정한다. 링크의 continue/action URL은 승인된 운영 도메인만 사용하고, 테스트 주소나 비밀 정보를 본문에 넣지 않는다.

권장 한국어 안내는 다음 의미를 포함한다.

- 이메일 인증: “영상 퀴즈 교사 계정의 이메일 인증을 완료해 주세요.”
- 비밀번호 재설정: “영상 퀴즈 교사 계정의 비밀번호 재설정 요청입니다. 본인이 요청하지 않았다면 이 메일을 무시하세요.”

Firebase Authentication이 비밀번호와 재설정 토큰을 처리한다. 관리자, Firestore 문서, 로그와 인수인계에는 비밀번호 원문·해시·재설정 링크를 저장하거나 복사하지 않는다. 재설정 요청 화면은 계정 존재 여부와 관계없이 같은 안내(“입력한 이메일을 확인해 주세요”)를 보여야 한다.

## 2. 자동 검증과 배포 순서

Console을 바꾸거나 배포하기 전에 저장소 루트에서 다음을 모두 통과시킨다.

```powershell
pnpm test
pnpm test:rules
node --check teacher-email-auth-core.js
git diff --check
```

두 테스트 suite가 실패 0인지 확인한다. 그 뒤 기존 데이터 전환 gate를 포함해 다음 순서를 지킨다.

1. Firebase Auth Email/Password, 승인된 도메인, 한국어 이메일 인증·비밀번호 재설정 템플릿을 준비한다.
2. Node와 Firestore Emulator 검증을 통과시킨다.
3. 기존 [`TEACHER-ACCESS-CLASS-PLANNING.md`](./TEACHER-ACCESS-CLASS-PLANNING.md)의 migration/lock gate가 안전한 경우에만 **호환 Firestore Rules**를 먼저 배포한다.
4. 정적 앱을 그 다음에 배포한다.
5. 아래 브라우저 인수를 통과한 뒤에만 운영 전환을 확정한다.

## 3. 운영 전 브라우저 인수

실제 운영 배포본에서 기존 Google 관리자 1명과 새 이메일 주소 1개를 사용한다.

1. 새 이메일 계정으로 가입하고 이메일 인증 링크를 완료한다.
2. 교사 권한을 한 번 신청한다.
3. Google 관리자가 관리자 UI에서 신청을 승인한다.
4. 새 이메일 계정으로 로그인해 보호된 교사 홈에 들어간다.
5. 비밀번호 재설정을 요청하고 새 비밀번호로 다시 로그인한다.
6. 학생 익명 입장과 기존 Google 교사 로그인이 계속 동작하는지 확인한다.
7. 같은 이메일의 Google/Email provider 충돌에서 allowance가 중복 생성되지 않고, 기존 로그인 방식으로 안내되는지 확인한다.
8. 같은 탭에서 앱 및 Firebase 출처 console error가 0인지 확인한다.

이 인수는 실제 이메일 발송·계정·운영 Console 상태가 필요한 pre-deploy gate다. 이 저장소 작업만으로는 실행하거나 통과로 기록하지 않는다.

## 4. 실패 시 롤백과 개인정보 확인

브라우저 인수가 실패하면 이메일·비밀번호 교사 기능을 운영 전환으로 확정하지 않는다. 이미 배포했다면 먼저 정적 앱을 직전 Git 커밋으로 되돌리고, Firebase Console → Firestore Database → Rules → 릴리스 기록에서 직전 Rules를 복원한다. Rules는 호환성·데이터 전환 gate를 무시하고 순서를 바꿔 되돌리지 않는다.

**롤백** 중에도 Firebase Authentication 사용자, `teacher_allowances`와 기존 승인/수업 데이터는 삭제·재생성·중복 생성하지 않는다. 문제 원인을 기록하고, 교사 권한은 인증 상태와 단일 allowance binding을 다시 확인한 뒤 후속 변경 창에서 처리한다.

운영 기록에는 테스트 결과, Rules 릴리스 시각, 앱 커밋, 인수 결과와 console error 수만 남긴다. 이메일 주소, 학생 개인정보, 비밀번호, 재설정 링크는 기록하지 않는다.
