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

test('release runbook probes the exact production Rules source after local verification and before ruleset creation', () => {
  const runbook = read('docs/RELEASE-RUNBOOK.md');
  const localTestIndex = runbook.indexOf('pnpm test');
  const emulatorRulesIndex = runbook.indexOf('pnpm test:rules', localTestIndex);
  const productionProbeIndex = runbook.indexOf(
    'pnpm test:rules:production-source --project video-quiz-65798 --target-mode production --output .release-artifacts/2026-08-22/r17-production-rules-probe.json',
    emulatorRulesIndex
  );
  const rulesetCreateIndex = runbook.indexOf('rulesets.create', productionProbeIndex);

  assert.ok(localTestIndex >= 0, 'local Node verification must be documented');
  assert.ok(emulatorRulesIndex > localTestIndex, 'Firestore Emulator verification must follow local tests');
  assert.ok(productionProbeIndex > emulatorRulesIndex, 'official production-source probe must follow local verification');
  assert.ok(rulesetCreateIndex > productionProbeIndex, 'rulesets.create must follow the read-only production-source probe');
  assert.match(runbook, /r17-production-rules-probe\.json[^\n]*(새|신규)[^\n]*(경로|output)[^\n]*(덮어쓰지|overwrite)/i);
  assert.doesNotMatch(runbook, /pnpm test:rules:production-source -- --project/);
});

test('release runbook stops before mutation on source budget, Rules API, or compiler ERROR failures', () => {
  const runbook = read('docs/RELEASE-RUNBOOK.md');

  assert.match(runbook, /source budget[^\n]*(초과|실패)[^\n]*(즉시 )?중단/i);
  assert.match(runbook, /HTTP 5xx[^\n]*(즉시 )?중단/i);
  assert.match(runbook, /ERROR[^\n]*(0|zero)[^\n]*(아니|실패)[^\n]*(즉시 )?중단/i);
  assert.match(runbook, /safeToCreateRuleset[^\n]*true[^\n]*(아니|없)[^\n]*(즉시 )?중단/);
});

test('release runbook retains the exact rollback ruleset through existing-flow and provider smoke completion', () => {
  const runbook = read('docs/RELEASE-RUNBOOK.md');
  const rollbackRuleset = 'projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4';
  const rulesetIndex = runbook.indexOf(rollbackRuleset);
  const existingSmokeIndex = runbook.indexOf('Google admin', rulesetIndex);
  const providerSmokeIndex = runbook.indexOf('signup', existingSmokeIndex);
  const retentionIndex = runbook.indexOf('smoke 완료까지 보존', providerSmokeIndex);

  assert.ok(rulesetIndex >= 0, 'the exact prior ruleset must be recorded');
  assert.ok(existingSmokeIndex > rulesetIndex, 'existing Google/admin smoke must follow rollback capture');
  assert.ok(providerSmokeIndex > existingSmokeIndex, 'Email/Password smoke must follow existing-flow smoke');
  assert.ok(retentionIndex > providerSmokeIndex, 'rollback ruleset retention must cover all smoke completion');
});

test('R19 response-loss recovery is an explicit exact adoption branch with a fresh quiesced evidence window', () => {
  const runbook = read('docs/RELEASE-RUNBOOK.md');
  const r10Start = runbook.indexOf('### R10 — strict Firestore Rules');
  const r11Start = runbook.indexOf('### R11 — static app', r10Start);
  const r10 = runbook.slice(r10Start, r11Start);
  const targetRuleset = 'projects/video-quiz-65798/rulesets/d55f5b3e-a39d-4eea-b4af-4637afd163e1';
  const sourceSha = 'c31ab7395271069cc5be9abe1dca4872fe41ac8e36b6bcb8f52ffabcb760248d';
  const rollbackRuleset = 'projects/video-quiz-65798/rulesets/74e79134-8e2f-48cf-a99c-e621915154d4';
  const denyAllRuleset = 'projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466';

  assert.ok(r10Start >= 0 && r11Start > r10Start, 'R10 must remain a distinct authoritative gate');
  assert.match(r10, /create 응답이 non-2xx[\s\S]*성공 여부를 증명하지 않는다/);
  assert.match(r10, /writeLanded:\s*true[\s\S]*create 재시도 금지/);
  assert.match(r10, /writeLanded:\s*false[\s\S]*create.*권한.*주지 않/);
  assert.match(r10, /writeLanded:\s*null[\s\S]*조사.*중단/);
  assert.match(r10, /create[\s\S]*writeLanded:\s*false[\s\S]*adopt-existing[\s\S]*exact Ruleset[\s\S]*exact SHA/);
  assert.match(r10, new RegExp(targetRuleset));
  assert.match(r10, new RegExp(sourceSha));
  assert.match(r10, new RegExp(rollbackRuleset));
  assert.match(r10, new RegExp(denyAllRuleset));
  assert.match(r10, /사람.*명시.*adopt-existing/);
  assert.match(r10, /후보.*자동 선택.*하지 않/);
  assert.match(r10, /--expect-manifest-sha/);
  assert.match(r10, /현재 로컬 commit[\s\S]*live gate-state/);
  assert.match(r10, /target Ruleset.*GET[\s\S]*source[\s\S]*PATCH/);
  assert.match(r10, /알려진.*PATCH 실패[\s\S]*rollback[\s\S]*exact GET readback/);
  assert.match(r10, /mutation-outcome-unknown[\s\S]*수동 조사[\s\S]*rollback.*주장하지 않/);
  assert.match(r10, /이번 복구[\s\S]*rulesets\.create.*호출하지 않/);
  assert.match(runbook, /R18[\s\S]*R19[\s\S]*원인.*증거[\s\S]*승인.*근거.*사용하지 않/);
  assert.match(runbook, /quiescence.*generation.*변하면[\s\S]*R2부터 새 보고서/);
  assert.match(runbook, /deny-all.*R10 target PATCH.*유지[\s\S]*strict readback.*종료/);
  assert.match(runbook, /migration lock[\s\S]*single-operator.*R13.*계속/);
  assert.match(runbook, /deny-all.*종료 시각[\s\S]*migration lock.*종료 시각.*별도 기록/);
  assert.match(runbook, /commit-bound.*code\/docs[\s\S]*broad final review[\s\S]*merge\/push/);
  assert.match(runbook, /R0~R10[\s\S]*reviewed feature commit/);
  assert.match(runbook, /R11[\s\S]*R12[\s\S]*R13/);
  assert.match(runbook, /unreviewed code change.*하지 않/);
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

test('public quiz library projection core loads after playlist normalization and before store and application scripts', () => {
  const html = read('index.html');
  const playlistIndex = html.indexOf('<script src="playlist-core.js"></script>');
  const coreIndex = html.indexOf('<script src="public-quiz-library-core.js"></script>');
  const storeIndex = html.indexOf('<script src="firestore-store.js"></script>');
  const applicationIndex = html.indexOf('<script>');

  assert.ok(playlistIndex >= 0, 'playlist normalization core must be included');
  assert.ok(coreIndex >= 0, 'public quiz library projection core must be included');
  assert.ok(playlistIndex < coreIndex, 'playlist core must load before public projection core');
  assert.ok(coreIndex < storeIndex, 'public projection core must load before firestore store');
  assert.ok(storeIndex < applicationIndex, 'firestore store must load before inline application code');
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

test('공개 자료실 route controls and mobile accessibility contract are present', () => {
  const html = read('index.html');

  for (const name of [
    'screenPublicQuizLibrary', 'openPublishedQuizPreview',
    'publishQuizSetFromList', 'withdrawQuizSetFromList',
    'copyPublishedQuizSetFromLibrary', 'renderAdminPublishedQuizSets'
  ]) {
    assert.match(html, new RegExp('function ' + name + '\\('));
  }
  assert.match(html, /case 'library':\s*requireTeacher\(screenPublicQuizLibrary\)/);
  assert.match(html, /href="#\/library"[\s\S]{0,160}공개 자료실/);
  assert.match(html, /<label[^>]*for="public-library-search"[^>]*>[^<]*공개 자료 검색/);
  assert.match(html, /id="public-library-search"[^>]*maxlength="200"/);
  assert.match(html, /aria-label="공개 퀴즈 미리보기 닫기"/);
  assert.match(html, /aria-label="내 세트로 복사"/);
  assert.match(html, /@media \(max-width:\s*720px\)[\s\S]*?\.public-library-actions\s*\{[^}]*grid-template-columns:\s*1fr/s);
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
  assert.match(
    rules,
    /match\s+\/students\/\{studentId\}\s*\{[\s\S]*?allow\s+create\s*:\s*if\s+sessionCounterMigrationUnlocked\(\)\s*&&\s*anonymousStudent\(\)/
  );
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
