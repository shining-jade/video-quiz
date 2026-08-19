const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = file => fs.readFileSync(file, 'utf8');

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

test('사용자 안내는 Google 관리자 역할과 세트 소유권을 정확히 설명한다', () => {
  const html = read('index.html');
  const readme = read('README.md');

  assert.match(html, /관리자 통합 조회[\s\S]*?승인된 Google 관리자 계정이 필요합니다/);
  assert.doesNotMatch(html, /관리자 통합 조회[\s\S]{0,200}?비밀번호가 필요합니다/);
  assert.match(html, /부팅 — Google 교사 인증 상태 확인 후 라우팅/);
  assert.doesNotMatch(html, /교사도 학생도 아무것도 로그인하지 않습니다/);
  assert.match(readme, /\| ✏️ 편집 \| 소유자 또는 소유자가 지정한 공동 편집자가 내용을 고칩니다/);
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
