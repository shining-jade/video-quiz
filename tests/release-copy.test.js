const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = file => fs.readFileSync(file, 'utf8');

test('release docs require Email/Password provider, verification template, reset template, and rollback', () => {
  const emailAuthDocs = read('docs/EMAIL-TEACHER-AUTH.md');

  for (const marker of ['Email/Password', '이메일 인증', '비밀번호 재설정', '승인된 도메인', '롤백']) {
    assert.match(emailAuthDocs, new RegExp(marker));
  }
});

test('email-auth release guide fixes the compatibility-to-strict safety order and account boundaries', () => {
  const emailAuthDocs = read('docs/EMAIL-TEACHER-AUTH.md');
  const deploymentSection = emailAuthDocs.slice(
    emailAuthDocs.indexOf('## 2. 자동 검증과 배포 순서'),
    emailAuthDocs.indexOf('## 3. 운영 전 브라우저 인수')
  );
  const orderedSteps = [
    'Node와 Firestore Emulator 검증',
    '호환 head Rules',
    'migration/lock/apply/verify/unlock gate',
    '엄격한 Firestore Rules',
    '정적 앱',
    '브라우저 인수'
  ];

  let previousIndex = -1;
  for (const step of orderedSteps) {
    const currentIndex = deploymentSection.indexOf(step);
    assert.ok(currentIndex > previousIndex, `release order must contain ${step} after the previous gate`);
    previousIndex = currentIndex;
  }
  assert.match(emailAuthDocs, /Google[\s\S]{0,120}Anonymous/);
  assert.match(emailAuthDocs, /`shining-jade\.github\.io`/);
  assert.match(emailAuthDocs, /Firebase Authentication 사용자[\s\S]{0,120}teacher_allowances[\s\S]{0,120}삭제·재생성·중복 생성하지 않는다/);
  assert.match(emailAuthDocs, /provider 충돌[\s\S]{0,120}allowance가 중복 생성되지 않/);
});

test('README routes teacher approval through verified providers and UID allowances, not direct legacy allowlists', () => {
  const readme = read('README.md');
  const authenticationSettings = readme.slice(
    readme.indexOf('### 1) Firestore 보안 규칙'),
    readme.indexOf('### 3) 기존 데이터 이전')
  );

  assert.match(authenticationSettings, /검증된 Google 또는 Email\/Password 교사/);
  assert.match(authenticationSettings, /UID에 묶인 활성 `teacher_allowances`/);
  assert.match(authenticationSettings, /기존 신청 UI[\s\S]{0,120}승인 UI/);
  assert.doesNotMatch(authenticationSettings, /teacher_allowlist\/\{[^}]+\}/);
});

test('email authentication validation core loads before the application script', () => {
  const html = read('index.html');
  const coreIndex = html.indexOf('<script src="teacher-email-auth-core.js"></script>');
  const applicationIndex = html.indexOf('<script>');

  assert.ok(coreIndex >= 0, 'email authentication validation core must be included');
  assert.ok(coreIndex < applicationIndex, 'email authentication validation core must load before inline application code');
});

test('모든 non-module inline script는 JavaScript로 파싱된다', () => {
  const html = read('index.html');
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=|\btype\s*=\s*["']module["']/i.test(attributes))
    .map(([, , source]) => source);

  assert.ok(inlineScripts.length > 0, '검증할 inline script가 있어야 합니다');
  inlineScripts.forEach((source, index) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: `index-inline-${index}.js` }));
  });
});

test('교사 신청과 관리자 승인 화면의 inline handlers are included in the parsed release script', () => {
  const html = read('index.html');

  ['screenTeacherRequest', 'submitTeacherRequestForm', 'cancelTeacherRequest', 'refreshTeacherRequestStatus',
    'renderAdminTeacherRequests', 'adminDecideTeacherRequest', 'retryAdminTeacherRequests'].forEach(name => {
    assert.match(html, new RegExp('function ' + name + '\\('));
  });
  assert.match(html, /공용 계정을 쓰지 않고/);
});

test('교사 홈 현황판은 역할별 조회와 재시도 진입점을 포함한다', () => {
  const html = read('index.html');

  ['startTeacherDashboard', 'stopTeacherDashboard', 'renderTeacherDashboard', 'retryTeacherDashboard'].forEach(name => {
    assert.match(html, new RegExp('function ' + name + '\\('));
  });
  assert.match(html, /id="teacher-dashboard"/);
  assert.match(html, /listPublicPlans/);
  assert.match(html, /listAdminPlans/);
  assert.match(html, /probeTeacherAllowance/);
  assert.match(html, /혼잡도는 수업 운영을 돕는 안내/);
});

test('편집기 Ctrl+S는 브라우저 기본 동작 없이 현재 위치에서 저장 완료 알림을 표시한다', () => {
  const html = read('index.html');

  assert.match(html, /function mkHandleSaveShortcut\(event\)[\s\S]*?event\.preventDefault\(\)/);
  assert.match(html, /String\(event\.key\)\.toLowerCase\(\) !== 's'/);
  assert.match(html, /event\.isComposing/);
  assert.match(html, /\.mk-save-toast\s*\{[^}]*position:\s*fixed[\s\S]*?저장 완료/);
  assert.doesNotMatch(html, /function mkSave\(forceNew\)[\s\S]*?mk-save-card[\s\S]*?scrollIntoView/);
});

test('편집기에는 undo/redo와 문항 제목 버블의 드래그·키보드 이동 대체가 있다', () => {
  const html = read('index.html');

  assert.match(html, /function mkUndo\(\)/);
  assert.match(html, /function mkRedo\(\)/);
  assert.match(html, /mk-question-bubble/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /function mkMoveQuestion\(fromVi, fromQi, toVi, toQi\)/);
  assert.match(html, /PlaylistCore\.moveQuestion\(/);
  assert.match(html, /function mkQuestionBubbleKeydown\(event, videoIndex, questionIndex\)/);
  assert.match(html, /이전 영상/);
  assert.match(html, /다음 영상/);
});

test('객관식 보기는 드래그와 버튼으로 순서를 바꾸고 문제 이미지는 기본 접힘이다', () => {
  const html = read('index.html');

  assert.match(html, /choice-order-core\.js/);
  assert.match(html, /function mkMoveChoice\(videoIndex, questionIndex, fromIndex, toIndex\)/);
  assert.match(html, /function mkChoiceDragStart\(event, videoIndex, questionIndex, choiceIndex\)/);
  assert.match(html, /application\/x-video-quiz-choice/);
  assert.match(html, /aria-label="위로 이동"/);
  assert.match(html, /aria-label="아래로 이동"/);
  assert.match(html, /function mkToggleImage\(videoIndex, i\)/);
  assert.match(html, /문제 이미지 추가/);
  assert.match(html, /이미지 보기·변경/);
});

test('문항 제목 목록은 영상 아래 왼쪽 탐색기로 배치되고 긴 목록을 자동 스크롤한다', () => {
  const html = read('index.html');

  assert.match(html, /class="mk-video-left"[\s\S]*?class="mk-question-navigator"[\s\S]*?class="mk-question-editor"/);
  assert.match(html, /\.mk-video-left\s*\{[^}]*position:\s*sticky[^}]*overflow:\s*auto/s);
  assert.match(html, /function mkQuestionNavigatorDragOver\(event\)[\s\S]*?scrollTop/);
  assert.match(html, /onclick="mkFocusQuestion\(/);
  assert.match(html, /function mkFocusQuestion\(videoIndex,\s*(?:questionIndex|i)\)[\s\S]*?scrollIntoView/);
});

test('넓은 화면은 영상과 문항 목록을 왼쪽에 두고 선택 문항 편집기를 오른쪽에 둔다', () => {
  const html = read('index.html');

  assert.match(html, /class="mk-video-body"[\s\S]*?class="mk-video-left"[\s\S]*?class="mk-video-preview"[\s\S]*?class="mk-question-navigator"[\s\S]*?class="mk-question-editor"/);
  assert.match(html, /\.mk-video-body\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\([^)]+\)\s+minmax\([^)]+\)/s);
  assert.match(html, /@media \(max-width:\s*1180px\)[\s\S]*?\.mk-video-body\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('큰 화면 편집기는 가로 공간과 문항 입력 영역을 충분히 사용한다', () => {
  const html = read('index.html');

  assert.match(html, /\.wrap\.editor-wide\s*\{[^}]*max-width:\s*1680px/s);
  assert.match(html, /class="wrap wide editor-wide"/);
  assert.match(html, /\.mk-video-body\s*\{[^}]*grid-template-columns:\s*minmax\(480px,\s*1fr\)\s+minmax\(640px,\s*1\.25fr\)/s);
  assert.match(html, /\.mk-question-editor\s+\.q-card\s*\{[^}]*padding:\s*20px/s);
  assert.match(html, /\.mk-question-editor\s+textarea\s*\{[^}]*min-height:\s*92px[^}]*font-size:\s*15px/s);
  assert.match(html, /@media \(max-width:\s*1180px\)[\s\S]*?\.mk-video-body\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('데스크톱 왼쪽 패널 전체는 문항 편집 스크롤을 따라가고 모바일에서는 고정을 해제한다', () => {
  const html = read('index.html');

  assert.match(html, /\.mk-video-left\s*\{[^}]*position:\s*sticky[^}]*top:\s*68px[^}]*max-height:\s*calc\(100vh - 88px\)[^}]*overflow:\s*auto/s);
  assert.match(html, /\.mk-question-navigator\s*\{[^}]*position:\s*static/s);
  assert.match(html, /@media \(max-width:\s*1180px\)[\s\S]*?\.mk-video-left\s*\{[^}]*position:\s*static[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
});

test('문항 해설은 넓게 쓰고 개별 제한 시간 입력은 160px로 줄인다', () => {
  const html = read('index.html');

  assert.match(html, /class="grid2 mk-explanation-time-grid"[\s\S]*?해설 \(선택\)[\s\S]*?이 문항만 제한 시간 다르게 \(선택\)/);
  assert.match(html, /\.mk-explanation-time-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+160px/s);
  assert.match(html, /@media \(max-width:\s*700px\)[\s\S]*?\.mk-explanation-time-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('해설 편집은 기본 접힘이며 필요할 때 글과 별도 이미지를 펼친다', () => {
  const html = read('index.html');

  assert.match(html, /function mkExplanationField\(q, videoIndex, questionIndex\)/);
  assert.match(html, /＋ 해설 추가/);
  assert.match(html, /해설 이미지 \(선택\)/);
  assert.match(html, /function mkToggleExplanation\(videoIndex, questionIndex\)/);
  assert.match(html, /function mkUploadExplanationImage\(videoIndex, questionIndex, input\)/);
  assert.match(html, /function mkSetExplanationImageUrl\(videoIndex, questionIndex, value\)/);
  assert.match(html, /function mkClearExplanationImage\(videoIndex, questionIndex\)/);
  assert.match(html, /\.mk-explanation-time-grid\s*>\s*\.field\s*\{[^}]*margin-bottom:\s*0/s);
  assert.match(html, /\.q-card\s+\.q-head\s+>\s*\.time-input[^}]*height:\s*42px/s);
});

test('편집 문항은 저장 전 실제 퀴즈 모양 미리보기를 열 수 있다', () => {
  const html = read('index.html');

  assert.match(html, /퀴즈 미리보기/);
  assert.match(html, /function mkOpenQuestionPreview\(videoIndex, questionIndex\)/);
  assert.match(html, /dialog\.id\s*=\s*'mk-question-preview'/);
  assert.match(html, /function mkCloseQuestionPreview\(\)/);
  assert.match(html, /setAttribute\('role',\s*'dialog'\)/);
});

test('문항 미리보기는 영상 3초 전 재생부터 제출·해설·계속 재생까지 실제 흐름을 제공한다', () => {
  const html = read('index.html');

  assert.match(html, /<script src="quiz-preview-core\.js"><\/script>/);
  assert.match(html, /function mkOpenQuestionPreview\(videoIndex, questionIndex\)[\s\S]*?mkPlayer[\s\S]*?seekTo\([\s\S]*?startAt[\s\S]*?playVideo/);
  assert.match(html, /function mkPreviewTick\(\)[\s\S]*?getCurrentTime[\s\S]*?QuizPreviewCore\.advance[\s\S]*?pauseVideo/);
  assert.match(html, /function mkPreviewSubmit\(\)[\s\S]*?QuizPreviewCore\.submit/);
  assert.match(html, /function mkPreviewContinue\(\)[\s\S]*?QuizPreviewCore\.continuePlayback[\s\S]*?playVideo/);
  assert.match(html, /정답입니다|아쉽지만 오답입니다/);
  assert.match(html, /해설/);
});

test('문항 미리보기는 다른 화면으로 이동할 때 남지 않는다', () => {
  const html = read('index.html');
  assert.match(html, /function router\(\) \{[\s\S]*?mkCloseQuestionPreview\(\);[\s\S]*?runCleanups\(\);/);
});

test('정답 공개 화면은 해설 글 아래에 해설 이미지를 표시한다', () => {
  const html = read('index.html');

  assert.match(html, /id="ov-explain-top"[\s\S]*?id="ov-explain-img"/);
  assert.match(html, /publicAnswer\.explain[\s\S]*?publicAnswer\.explainImage/);
  assert.match(html, /class="stu-explain-top"[\s\S]*?class="stu-explain-img"/);
  assert.match(html, /function plExplanationImage\(question, questionIndex\)/);
  assert.match(html, /FirestoreStore\.publicAnswer\(question, explainImage\)/);
});

test('편집기 미리보기는 교사용과 학생 모바일 화면을 나란히 열어 같은 퀴즈를 조작한다', () => {
  const html = read('index.html');

  assert.match(html, /class="mk-preview-grid"/);
  assert.match(html, /교사용 화면/);
  assert.match(html, /학생 모바일 화면/);
  assert.doesNotMatch(html, /function mkPreviewSetMode\(mode\)/);
  assert.match(html, /card\('mobile'\)/);
  assert.match(html, /class="preview-explanation"[\s\S]*?class="preview-explanation-img"/);
  assert.match(html, /\.mk-question-preview-card\.mobile\s*\{[^}]*width:\s*390px/s);
});

test('사용자 안내는 편집 이력, 교차 영상 이동과 seek 재출제 안전 규칙을 설명한다', () => {
  const readme = read('README.md');
  const handoff = read('docs/HANDOFF-2026-08-14.md');

  assert.match(readme, /실행 취소[\s\S]*?Ctrl\+Z/);
  assert.match(readme, /Ctrl\+Shift\+Z[\s\S]*?Ctrl\+Y[\s\S]*?다시 실행/);
  assert.match(readme, /Ctrl\+S[\s\S]*?스크롤[\s\S]*?현재 위치/);
  assert.match(readme, /문항 제목 버블[\s\S]*?다른 영상/);
  assert.match(readme, /상대 위치[\s\S]*?새 영상/);
  assert.match(readme, /1초[\s\S]*?앞[\s\S]*?다시 출제/);
  assert.match(readme, /계속 재생[\s\S]*?같은 문항[\s\S]*?반복/);
  assert.match(handoff, /EditorHistoryCore/);
  assert.match(handoff, /PlaylistCore\.moveQuestion/);
  assert.match(handoff, /QuizTriggerCore/);
  assert.match(handoff, /1초[\s\S]*?재무장/);
});

test('전체화면 퀴즈는 stage 기준의 안전 영역과 본문 내부 스크롤 계약을 가진다', () => {
  const html = read('index.html');

  assert.match(html, /function plLayoutMode\(rect\)/);
  assert.match(html, /function plApplyStageLayout\(\)/);
  assert.match(html, /function plStageTimelineSafeBottom\(stageHeight, timeline\)/);
  assert.match(html, /function plStageUsableQuizRect\(stageRect, timelineRect\)/);
  assert.match(html, /--quiz-safe-bottom/);
  assert.match(html, /--quiz-center-y/);
  assert.match(html, /--quiz-actions-min-h/);
  assert.match(html, /--quiz-max-w:\s*min\(920px,\s*calc\(100% - 32px\)\)/);
  assert.match(html, /--quiz-max-h:\s*calc\(100% - var\(--quiz-safe-bottom\)\)/);
  assert.match(html, /#pl-stage #overlay\s*\{[^}]*width:\s*var\(--quiz-max-w\)[^}]*max-height:\s*var\(--quiz-max-h\)[^}]*overflow:\s*auto/s);
  assert.match(html, /#pl-stage #overlay \.quiz-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
  assert.match(html, /#pl-stage #overlay \.ov-inner\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(html, /window\.addEventListener\('orientationchange', applyLayout\)/);
  assert.match(html, /window\.removeEventListener\('orientationchange', applyLayout\)/);
});

test('편집기 단축키와 경로 종료 처리는 이전 화면의 listener가 남지 않게 정리한다', () => {
  const html = read('index.html');

  assert.match(html, /document\.removeEventListener\('keydown', saveShortcut\)/);
  assert.match(html, /if \(mk !== state\) return/);
  assert.match(html, /editRouteToken/);
});

test('새 세트 Ctrl+S도 저장 뒤 기존 scroll·focus·selection을 복원한다', () => {
  const html = read('index.html');

  assert.match(html, /function mkCaptureEditorView\(\)/);
  assert.match(html, /mkHandleSaveShortcut\(event\)[\s\S]*?mkCaptureEditorView\(\)/);
  assert.match(html, /function mkRestoreEditorView\(view\)/);
  assert.match(html, /if \(isNew\) \{[\s\S]*?renderMake\(\);[\s\S]*?mkRestoreEditorView\(view\)/);
});

test('README는 자동 검증과 아직 닫힌 프로덕션 배포 게이트를 구분한다', () => {
  const readme = read('README.md');

  assert.match(readme, /자동 테스트[^\n]*통과/);
  assert.match(readme, /프로덕션[^\n]*(이전|마이그레이션)[^\n]*(미실행|남아)/);
  assert.match(readme, /엄격한 규칙[^\n]*(게시|배포)[^\n]*(미실행|남아)/);
  assert.match(readme, /실제 브라우저[^\n]*(미검증|남아|차단)/);
  assert.doesNotMatch(readme, /Firebase 콘솔 규칙 게시, 기존 세트 이전[^\n]*검증을 완료했습니다/);
});

test('사용자 안내는 교사 계정 관리자 역할과 세트 소유권을 정확히 설명한다', () => {
  const html = read('index.html');
  const readme = read('README.md');

  assert.match(html, /관리자 통합 조회[\s\S]*?승인된 교사 관리자 계정이 필요합니다/);
  assert.doesNotMatch(html, /관리자 통합 조회[\s\S]{0,200}?비밀번호가 필요합니다/);
  assert.match(html, /부팅 — 교사 계정 인증 상태 확인 후 라우팅/);
  assert.doesNotMatch(html, /교사도 학생도 아무것도 로그인하지 않습니다/);
  assert.match(readme, /\| ✏️ 편집 \| 소유자 또는 소유자가 지정한 공동 편집자가 내용을 고칩니다/);
});

test('교사 인증은 Google과 이메일 흐름을 한 접근 가능한 dialog에 제공한다', () => {
  const html = read('index.html');

  assert.match(html, /<dialog id="teacher-auth-dialog"[^>]*aria-labelledby="teacher-auth-title"/);
  assert.match(html, /Google로 로그인/);
  assert.match(html, /이메일로 로그인/);
  assert.match(html, /이메일로 가입/);
  assert.match(html, /비밀번호 재설정/);
  assert.match(html, /function openTeacherAuthDialog\(mode\)/);
  assert.match(html, /function submitTeacherEmailSignup\(event\)/);
  assert.match(html, /function submitTeacherEmailLogin\(event\)/);
  assert.match(html, /function sendTeacherVerificationEmail\(\)/);
  assert.match(html, /function confirmTeacherEmailVerification\(\)/);
  assert.match(html, /function sendTeacherPasswordReset\(event\)/);
});

test('counter migration 운영 문서는 staged lock migration strict unlock 순서를 고정한다', () => {
  const guide = read('docs/COUNTER-MIGRATION.md');
  const stagedConfig = JSON.parse(read('firebase.counter-migration.json'));
  assert.equal(stagedConfig.firestore.rules, 'firestore.rules');

  const ordered = [
    '1. staged gate Rules 배포',
    '2. migration_gates/set_counters 잠금',
    '3. counter migration 및 audit',
    '4. strict counter Rules 재배포',
    '5. 동일 lockId로 잠금 해제'
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = guide.indexOf(marker);
    assert.ok(next > cursor, `missing or out-of-order: ${marker}`);
    cursor = next;
  }
  assert.match(guide, /--config firebase\.counter-migration\.json --project video-quiz-65798/);
  assert.match(guide, /--target-mode production[\s\S]*--confirm-project video-quiz-65798[\s\S]*--gate-id <LOCK_ID>/);
  assert.match(guide, /safeToDeployStrictRules[^\n]*true/);
  assert.match(guide, /운영 환경에서는 실행하지 않았습니다/);
  assert.match(guide, /staged[^\n]*배포[^\n]*직후[^\n]*즉시[^\n]*잠금/);
  assert.match(guide, /gate가 없거나 잠겨 있으면[^\n]*collaborator\/image[^\n]*parent[^\n]*(거부|차단)/);
});

test('teacher access release guide fixes compatibility-head migration verify unlock order with no join gap', () => {
  const guide = read('docs/TEACHER-ACCESS-CLASS-PLANNING.md');
  const rules = read('firestore.rules');
  const ordered = [
    '호환 head Firestore Rules를 먼저 배포',
    '교사 승인 migration apply',
    '세션 counter apply',
    'strict Firestore Rules와 정적 앱을 배포',
    '두 `--verify-lock`',
    '명시 해제'
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = guide.indexOf(marker);
    assert.ok(next > cursor, `missing or out-of-order: ${marker}`);
    cursor = next;
  }
  assert.match(guide, /--apply.*--lock-token <ACCESS_LOCK_TOKEN>/);
  assert.match(guide, /--apply.*--lock-token <COUNTER_LOCK_TOKEN>/);
  assert.match(guide, /--verify-lock.*--expected-generation <ACCESS_LOCK_GENERATION>/);
  assert.match(guide, /--verify-lock.*--expected-migration-generation <ACCESS_MIGRATION_GENERATION>/);
  assert.match(guide, /--verify-lock.*--expected-gate-generation <SESSION_GATE_GENERATION>/);
  assert.match(guide, /--unlock.*--expected-generation <COUNTER_LOCK_GENERATION>/);
  assert.match(guide, /access unlock[^\n]*legacy fallback[^\n]*(다시 열지|다시 열리지)/i);
  assert.match(guide, /status: "complete"[^\n]*strictReady: true[^\n]*migrationGeneration/);
  assert.match(rules, /allow create: if sessionCounterMigrationUnlocked\(\)[\s\S]{0,100}?anonymousStudent\(\)/);
});

test('공동 편집과 휴지통 공개 문구는 무료 정리의 한계와 보존 범위를 설명한다', () => {
  const readme = read('README.md');
  const handoff = read('docs/HANDOFF-2026-08-14.md');

  assert.match(readme, /공동 편집자/);
  assert.match(readme, /휴지통/);
  assert.match(readme, /30일/);
  assert.match(readme, /접속할 때 자동 정리/);
  assert.match(readme, /과거 수업 기록은 보존/);
  assert.doesNotMatch(readme, /세트 \*\*삭제\*\*는 일부러 막아 두었습니다/);
  assert.match(handoff, /교사 계정 관리/);
  assert.match(handoff, /staged gate Rules 배포/);
  assert.match(handoff, /safeToDeployStrictRules/);
});
