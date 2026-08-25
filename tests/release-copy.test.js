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

test('email-auth release gate requires Password Policy minimum 8 and Require before provider activation', () => {
  const emailAuthDocs = read('docs/EMAIL-TEACHER-AUTH.md');
  const runbook = read('docs/RELEASE-RUNBOOK.md');
  const policyIndex = runbook.indexOf('Password Policy 최소 길이 8');
  const requireIndex = runbook.indexOf('Enforcement `Require`', policyIndex);
  const providerIndex = runbook.indexOf('### R14 — Email/Password provider gate');

  assert.ok(policyIndex >= 0, 'Password Policy operator gate must be documented');
  assert.ok(requireIndex > policyIndex, 'Require enforcement must be part of the policy gate');
  assert.ok(providerIndex > requireIndex, 'provider activation must happen after the policy gate');
  assert.match(emailAuthDocs, /최소 길이 8[^\n]*Enforcement \`Require\`[^\n]*(확인|검증)[^\n]*(실패|아니면)[^\n]*(중단|활성화하지)/);
});

test('one authoritative runbook composes every gate under quiescence and Rules-before-static order', () => {
  const emailAuthDocs = read('docs/EMAIL-TEACHER-AUTH.md');
  const deploymentSection = read('docs/RELEASE-RUNBOOK.md');
  const orderedSteps = [
    '### R0 —', '### R1 — exact write-quiescence', '### R2 — lifecycle',
    '### R3 — collaborator share', '### R4 — set counter',
    '### R5 — teacher access', '### R6 — session join',
    '### R7 — public privacy', '### R8 — composite index',
    '### R9 — release manifest', '### R10 — strict Firestore Rules',
    '### R11 — static app', '### R12 — 같은 generation post-deploy verify',
    '### R13 — exact unlock', '### R14 — Email/Password provider',
    '### R15 — controlled smoke'
  ];

  let previousIndex = -1;
  for (const step of orderedSteps) {
    const currentIndex = deploymentSection.indexOf(step);
    assert.ok(currentIndex > previousIndex, `release order must contain ${step} after the previous gate`);
    previousIndex = currentIndex;
  }
  assert.match(deploymentSection, /정적 앱 배포나 화면 배너를 quiescence로 간주하지 않는다/);
  assert.match(deploymentSection, /유일한 rollout 순서[\s\S]{0,80}Rules before static app/);
  assert.match(deploymentSection, /롤백도 Rules before static app/);
  for (const satellite of [
    'docs/EMAIL-TEACHER-AUTH.md', 'docs/PUBLIC-QUIZ-LIBRARY.md',
    'docs/COUNTER-MIGRATION.md', 'docs/COLLABORATOR-SHARE-MIGRATION.md',
    'docs/TEACHER-ACCESS-CLASS-PLANNING.md'
  ]) assert.match(read(satellite), /RELEASE-RUNBOOK\.md/);
  assert.match(emailAuthDocs, /Google[\s\S]{0,120}Anonymous/);
  assert.match(emailAuthDocs, /`shining-jade\.github\.io`/);
  assert.match(emailAuthDocs, /Firebase Authentication 사용자[\s\S]{0,120}teacher_allowances[\s\S]{0,120}삭제·재생성·중복 생성하지 않는다/);
  assert.match(emailAuthDocs, /provider 충돌[\s\S]{0,120}allowance가 중복 생성되지 않/);
});

test('HANDOFF preserves the full authoritative email-auth release sequence without an unsafe shortcut', () => {
  const handoff = read('HANDOFF.md');
  const emailAuthBlock = handoff.slice(0, handoff.indexOf('> OX'));
  const ordered = [
    'R1 externally enforced exact write-quiescence', 'R2 lifecycle', 'R3 share',
    'R4 set counter lock/apply', 'R5 access lock/apply',
    'R6 session lock/recount/gate', 'R7 public privacy/author-value audit',
    'R8 index build', 'R10 strict Rules', 'R11 static app',
    'R12 같은-generation verify', 'R13 exact unlock',
    'R14 Email/Password provider', 'R15 controlled smoke'
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = emailAuthBlock.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `HANDOFF email-auth order missing or unsafe: ${marker}`);
    cursor = next;
  }
  assert.match(emailAuthBlock, /docs\/RELEASE-RUNBOOK\.md/);
  assert.match(emailAuthBlock, /다른 UID의 canonical email mirror/);
  assert.match(emailAuthBlock, /unsafe author label\/parity/);
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

test('operator authorization core is cache-busted in the static release', () => {
  const html = read('index.html');

  assert.match(html, /<script src="auth-core\.js\?v=[a-z0-9.-]+"><\/script>/,
    'auth-core.js must carry a release version so browsers do not retain stale authorization logic');
});

test('guest share projection core is cache-busted in the static release', () => {
  const html = read('index.html');

  assert.match(html, /<script src="guest-quiz-share-core\.js\?v=[a-z0-9.-]+"><\/script>/,
    'guest share projection changes must not be hidden by a stale browser cache');
});

test('changed browser runtime cores are cache-busted in the static release', () => {
  const html = read('index.html');

  for (const name of ['editor-history-core', 'firestore-store']) {
    assert.match(html, new RegExp('<script src="' + name + '\\.js\\?v=[a-z0-9.-]+"><\\/script>'));
  }
});

test('collaboration identity core loads before the Firestore store captures it', () => {
  const html = read('index.html');
  const collaborationIndex = html.indexOf('<script src="collaboration-trash-core.js"></script>');
  const storeIndex = html.indexOf('<script src="firestore-store.js');

  assert.ok(collaborationIndex >= 0, 'collaboration identity core must be included');
  assert.ok(collaborationIndex < storeIndex,
    'collaboration identity core must load before the Firestore store factory runs');
});

test('free passwordless guest route uses anonymous auth and never uses the teacher route guard', () => {
  const html = read('index.html');
  const playlistIndex = html.indexOf('<script src="playlist-core.js"></script>');
  const guestCoreIndex = html.indexOf('<script src="guest-quiz-share-core.js');
  const storeIndex = html.indexOf('<script src="firestore-store.js');
  assert.ok(playlistIndex >= 0 && guestCoreIndex > playlistIndex && storeIndex > guestCoreIndex);
  assert.doesNotMatch(html, /firebase-functions-compat\.js/);
  assert.match(html, /case 'guest-play':\s*screenGuestPlay/);
  assert.doesNotMatch(html, /case 'guest-play':\s*requireTeacher/);
  assert.match(html, /signInAnonymously/);
  assert.match(html, /loadActiveGuestQuizShare/);
  assert.doesNotMatch(html, /exchangeGuestQuizShare|signInWithCustomToken|guestOwnerTokenKey/);
  assert.doesNotMatch(html, /guest-play\/[^'"\s]+\?token=/);
  assert.match(html, /비로그인 진행 링크/);
  assert.match(html, /사용할 수 없는 진행 링크입니다\. 만든 분에게 새 링크를 요청해 주세요/);
  assert.match(html, /case 'play':\s*requireTeacher/);
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

test('승인되지 않은 교사 계정에는 신청 폼 대신 비로그인 링크 안내를 보여 준다', () => {
  const html = read('index.html');

  assert.match(html, /function screenTeacherRequest\(/);
  assert.match(html, /function renderTeacherRequest\(/);
  assert.match(html, /퀴즈 세트를 만들 수 있는 계정이 아닙니다/);
  assert.match(html, /비로그인 진행 링크<\/b>를 받아서/);
  assert.doesNotMatch(html, /공용 계정을 쓰지 않고/);
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

test('공개 자료실과 교사 승인 진입점은 릴리스에서 완전히 사라졌다', () => {
  const html = read('index.html');

  for (const name of [
    'screenPublicQuizLibrary', 'openPublishedQuizPreview',
    'publishQuizSetFromList', 'withdrawQuizSetFromList',
    'copyPublishedQuizSetFromLibrary', 'renderAdminPublishedQuizSets',
    'submitTeacherRequestForm', 'cancelTeacherRequest', 'refreshTeacherRequestStatus',
    'renderAdminTeacherRequests', 'adminDecideTeacherRequest'
  ]) {
    assert.doesNotMatch(html, new RegExp('function ' + name + '\\('),
      name + ' must not survive in the guest-only release');
  }
  assert.doesNotMatch(html, /href="#\/library"/, '공개 자료실 링크가 남아 있으면 안 된다');
  assert.doesNotMatch(html, /case 'library':/, '공개 자료실 route가 남아 있으면 안 된다');
  assert.doesNotMatch(html, /공개 자료실에 게시/, '게시 버튼이 남아 있으면 안 된다');
  assert.doesNotMatch(html, /게시 상태 확인 실패/, '게시 상태 배지가 남아 있으면 안 된다');
  assert.doesNotMatch(html, /public-quiz-library-core\.js/, '쓰지 않는 공개 자료실 코어를 싣지 않는다');
  assert.doesNotMatch(html, /teacher-access-request-core\.js/, '쓰지 않는 교사 신청 코어를 싣지 않는다');
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
  assert.match(html, /\.mk-video-left\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(html, /\.mk-question-navigator\s*\{[^}]*position:\s*static/s);
  assert.match(html, /@media \(max-width:\s*1180px\)[\s\S]*?\.mk-video-left\s*\{[^}]*position:\s*static[^}]*max-height:\s*none[^}]*overflow:\s*visible[^}]*scrollbar-gutter:\s*auto/s);
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

test('일반 화면 퀴즈는 영상 높이에 맞춰 문항과 네 보기를 압축하고 전체화면 크기는 보존한다', () => {
  const html = read('index.html');
  const normal = /#pl-stage:not\(:fullscreen\):not\(\.fullscreen-fallback\) #overlay/;

  assert.match(html, normal);
  assert.match(html, /#pl-stage:not\(:fullscreen\):not\(\.fullscreen-fallback\) #overlay\s*\{[^}]*padding:\s*14px 18px[^}]*overflow:\s*hidden/s);
  assert.match(html, /#pl-stage:not\(:fullscreen\):not\(\.fullscreen-fallback\) #overlay \.quiz-body\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(html, /#pl-stage:not\(:fullscreen\):not\(\.fullscreen-fallback\) #overlay \.ov-q\s*\{[^}]*font-size:\s*clamp\(18px,\s*2\.2vw,\s*28px\)[^}]*margin-bottom:\s*10px/s);
  assert.match(html, /#pl-stage:not\(:fullscreen\):not\(\.fullscreen-fallback\) #overlay \.ov-choice\s*\{[^}]*padding:\s*8px 12px[^}]*font-size:\s*clamp\(14px,\s*1\.4vw,\s*18px\)/s);
  assert.match(html, /#pl-stage:not\(:fullscreen\):not\(\.fullscreen-fallback\) #overlay \.ov-actions \.btn\s*\{[^}]*padding:\s*8px 14px[^}]*font-size:\s*14px/s);
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

test('교사 인증 공개 화면은 Google 로그인만 제공하고 중단한 이메일 인증 UI를 숨긴다', () => {
  const html = read('index.html');

  assert.match(html, /<dialog id="teacher-auth-dialog"[^>]*aria-labelledby="teacher-auth-title"/);
  assert.match(html, /const teacherEmailAuthUiEnabled\s*=\s*false/);
  assert.match(html, /function teacherAuthDialogMarkup\(\)\s*\{[\s\S]*?if \(!teacherEmailAuthUiEnabled\)[\s\S]*?Google로 로그인[\s\S]*?return/s);
  assert.match(html, /Google로 로그인/);
  assert.match(html, /function openTeacherAuthDialog\(mode\)/);
  // 재개 가능성을 위해 검증된 이메일 인증 로직은 보관하되 공개 markup에서는 호출하지 않는다.
  assert.match(html, /function submitTeacherEmailSignup\(event\)/);
  assert.match(html, /function submitTeacherEmailLogin\(event\)/);
  assert.match(html, /function sendTeacherVerificationEmail\(\)/);
  assert.match(html, /function confirmTeacherEmailVerification\(\)/);
  assert.match(html, /function sendTeacherPasswordReset\(event\)/);
});

test('counter migration guide defers rollout and fixes R4 lock/apply R12 verify R13 unlock', () => {
  const guide = read('docs/COUNTER-MIGRATION.md');
  const stagedConfig = JSON.parse(read('firebase.counter-migration.json'));
  assert.equal(stagedConfig.firestore.rules, 'firestore.rules');

  const ordered = [
    '## R4 — lock, apply, audit',
    '## R12 — post-deploy verify',
    '## R13 — exact unlock'
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = guide.indexOf(marker);
    assert.ok(next > cursor, `missing or out-of-order: ${marker}`);
    cursor = next;
  }
  assert.match(guide, /RELEASE-RUNBOOK\.md/);
  assert.match(guide, /write-quiescence/);
  assert.match(guide, /--target-mode production[\s\S]*--confirm-project video-quiz-65798[\s\S]*--gate-id <LOCK_ID>/);
  assert.match(guide, /safeToDeployStrictRules[^\n]*true/);
  assert.match(guide, /production migration이나 deploy를 실행하지 않았다/);
  assert.match(guide, /strict Rules가 먼저, static app이 다음/);
  assert.match(guide, /--action unlock[\s\S]*--gate-generation <UPDATE_TIME_GENERATION>/);
});

test('teacher access guide only owns access/session CLI verify and unlock contracts', () => {
  const guide = read('docs/TEACHER-ACCESS-CLASS-PLANNING.md');
  const rules = read('firestore.rules');
  const ordered = [
    '## 2. 교사 승인 상태 migration',
    '## 3. 세션 counter maintenance와 completion gate',
    '## 4. post-deploy 같은-generation verify와 exact 해제'
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = guide.indexOf(marker);
    assert.ok(next > cursor, `missing or out-of-order: ${marker}`);
    cursor = next;
  }
  assert.match(guide, /RELEASE-RUNBOOK\.md/);
  assert.match(guide, /R10 strict Rules → R11 static app/);
  assert.match(guide, /externally enforced write-quiescence[\s\S]*session lock/);
  assert.match(guide, /--apply.*--lock-token <ACCESS_LOCK_TOKEN>/);
  assert.match(guide, /--apply.*--lock-token <COUNTER_LOCK_TOKEN>/);
  assert.match(guide, /--verify-lock.*--expected-generation <ACCESS_LOCK_GENERATION>/);
  assert.match(guide, /--verify-lock.*--expected-migration-generation <ACCESS_MIGRATION_GENERATION>/);
  assert.match(guide, /--verify-lock.*--expected-gate-generation <SESSION_GATE_GENERATION>/);
  assert.match(guide, /--unlock.*--expected-generation <COUNTER_LOCK_GENERATION>/);
  assert.match(guide, /access unlock[^\n]*legacy fallback[^\n]*(허용되지|되살리지)/i);
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
  assert.match(handoff, /RELEASE-RUNBOOK\.md/);
  assert.match(handoff, /R10 strict Rules → R11 static app/);
  assert.match(handoff, /safeToDeployStrictRules/);
});

test('public library release guide fixes privacy lifecycle deployment and rollback contracts', () => {
  const guide = read('docs/PUBLIC-QUIZ-LIBRARY.md');
  const readme = read('README.md');
  const handoff = read('HANDOFF.md');
  const combined = [guide, readme, handoff].join('\n');

  for (const marker of [
    'private by default', 'published_quiz_sets', '승인 교사만',
    '독립 사본', '이메일과 UID 비공개', '롤백'
  ]) {
    assert.match(combined, new RegExp(marker));
  }
  const ordered = [
    'R7 durable audit',
    'R8 composite index build 완료',
    'R10 strict Rules',
    'R11 static app',
    'R12 같은-generation public 재감사',
    'R15 privacy smoke'
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = guide.indexOf(marker);
    assert.ok(next > cursor, `public library release order missing or unsafe: ${marker}`);
    cursor = next;
  }
  for (const actor of [
    '소유자', '공동 편집자', '다른 승인 교사', '관리자',
    '학생', '익명', 'suspended', 'deletion_pending'
  ]) {
    assert.match(guide, new RegExp(actor));
  }
  assert.match(guide, /public image[^\n]*orphan audit/i);
  assert.match(guide, /backfill[^\n]*(하지|없)/i);
});

test('public library release gate documents lifecycle lock indexes legacy audit and durable auditor', () => {
  const guide = read('docs/PUBLIC-QUIZ-LIBRARY.md');
  const runbook = read('docs/RELEASE-RUNBOOK.md');
  const readme = read('README.md');
  const handoff = read('HANDOFF.md');
  for (const phrase of [
    'publication_lifecycle_locks', 'publication_lifecycle_gates/current',
    'cancelled', 'audit:public-library',
    'safeToDeployPublicLibrary', 'lifecycleState 누락'
  ]) assert.match(guide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(runbook, /firestore\.indexes\.json/);
  assert.match(guide, /PUBLIC_AUTHOR_LABEL_UNSAFE/);
  assert.match(guide, /PUBLIC_AUTHOR_LABEL_PARITY/);
  assert.match(readme, /audit:public-library/);
  assert.match(handoff, /safeToDeployPublicLibrary/);
});

test('Spark guest release has no Functions deployment surface', () => {
  const pkg = JSON.parse(read('package.json'));
  const firebaseConfig = JSON.parse(read('firebase.json'));
  const readme = read('README.md');
  const runbook = read('docs/RELEASE-RUNBOOK.md');
  assert.equal(firebaseConfig.functions, undefined);
  assert.equal(pkg.scripts['test:guest-functions'], undefined);
  assert.match(pkg.scripts['test:guest'], /guest-quiz-share-core/);
  assert.doesNotMatch(read('pnpm-workspace.yaml'), /(?:^|\n)\s*-\s*functions\s*(?:\n|$)/);
  assert.equal(fs.existsSync('functions/package.json'), false);
  assert.match(readme, /교사 계정·비밀번호·로그인 화면 없이/);
  assert.match(readme, /서로 다른 6자리 반 코드와 세션/);
  assert.match(runbook, /Spark 요금제/);
  assert.match(runbook, /indexes 완료 → Rules → static app/);
  assert.match(runbook, /43자 공유 ID/);
  assert.match(runbook, /서로 격리된 브라우저 두 개/);
  assert.match(runbook, /기존 세션·학생·응답은 삭제하지 않는다/);
});

test('strict teacher access uses only the authoritative UID allowance on every hot authorization path', () => {
  const rules = read('firestore.rules');
  const approved = rules.match(/function isApprovedTeacher\(\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
  const admin = rules.match(/function isAdmin\(\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';

  assert.match(approved, /verifiedEmail\(\)/);
  assert.match(approved, /validActiveTeacherAllowance\(get\(teacherAllowancePath\(\)\)\.data\)/);
  assert.doesNotMatch(approved, /teacherAccessMigrationComplete|validLegacyTeacherAllowance|legacyAllowancePath/);
  assert.match(admin, /isApprovedTeacher\(\)/);
  assert.match(admin, /get\(teacherAllowancePath\(\)\)\.data\.role\s*==\s*'admin'/);
  assert.doesNotMatch(admin, /teacherAccessMigrationComplete|validLegacyTeacherAllowance|legacyAllowancePath/);
});

test('Spark rules retire client-side teacher account request migration and lifecycle writes', () => {
  const rules = read('firestore.rules');

  assert.doesNotMatch(rules, /match \/teacher_access_requests\/\{uid\}/);
  assert.doesNotMatch(rules, /match \/migration_gates\/teacher_access_status/);
  assert.match(rules, /match \/teacher_allowances\/\{uid\}[\s\S]*?allow create, update, delete: if false;/);
  assert.match(rules, /match \/teacher_allowlist\/\{email\}[\s\S]*?allow read, write: if false;/);
  assert.doesNotMatch(rules, /function validAdminRequestDecision|function validTeacherAllowanceUpdate/);
});

test('Spark guest-first rules close the public library deployment surface', () => {
  const rules = read('firestore.rules');

  assert.doesNotMatch(rules, /match \/published_quiz_sets\/\{setId\}/);
  assert.doesNotMatch(rules, /match \/published_quiz_audits\/\{setId\}/);
  assert.doesNotMatch(rules, /match \/publication_lifecycle_(?:locks|gates)/);
  assert.doesNotMatch(rules, /function publicationPath|function validPrivateCopyStart/);
  assert.doesNotMatch(rules, /allow create: if validPrivateCopyStart/);
  assert.match(rules, /match \/guest_quiz_shares\/\{shareId\}/);
  assert.match(rules, /match \/guest_quiz_share_sources\/\{setId\}/);
});

test('진행 화면의 id는 겹치지 않는다', () => {
  const html = read('index.html');
  const ids = [...html.matchAll(/\bid="(pl-[a-z0-9-]+)"/g)].map(match => match[1]);
  const seen = new Map();
  ids.forEach(id => seen.set(id, (seen.get(id) || 0) + 1));
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  // 같은 id가 둘이면 $()가 첫 번째만 잡아 나머지가 조용히 갱신되지 않는다.
  assert.deepEqual(duplicated, []);
});

test('진행 시작 화면에는 누구에게나 단계별 진행 방법 안내가 있다', () => {
  const html = read('index.html');

  assert.match(html, /onclick="plOpenGuestGuide\(\)">📖 진행 방법/);
  for (const name of [
    'plGuestTourSample', 'plGuestTourSteps', 'plGuestTourTips', 'plGuestGuideDialog',
    'plRenderGuestTour', 'plGuestTourGo', 'plOpenGuestGuide', 'plCloseGuestGuide'
  ]) {
    assert.ok(html.includes('function ' + name + '('), name + ' must exist');
  }
  // 세트를 만든 선생님도 안내를 볼 수 있어야 하므로 guestMode로 감추지 않는다.
  assert.doesNotMatch(html, /guestMode \? plGuestGuideDialog\(\) : ''/);
  // 글만 있는 안내가 아니라 실제 화면을 흉내 낸 그림이 함께 있어야 한다.
  for (const marker of ['tour-run', 'tour-video', 'tour-code-value', 'tour-student', 'tour-quiz']) {
    assert.match(html, new RegExp(marker));
  }
  assert.match(html, /tour-example">예시/);
  assert.match(html, /새로고침해도 괜찮습니다/);
  assert.match(html, /다른 선생님과 섞이지 않습니다/);
});
