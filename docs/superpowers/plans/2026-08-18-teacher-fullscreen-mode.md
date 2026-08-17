# Teacher Fullscreen Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사 수업의 영상·문제·정답·순위·QR을 같은 전체화면 컨테이너 안에서 유지하고, 전체화면을 나갔다 다시 들어와도 세션과 플레이어 상태를 보존한다.

**Architecture:** 기존 YouTube 플레이어 DOM을 `#pl-stage` 안에 한 번만 생성하고 Fullscreen API 또는 CSS 대체 확장 모드로 같은 컨테이너를 확대한다. 문제·순위·QR 오버레이도 `#pl-stage`의 자식으로 두며, 드래그 좌표 계산은 별도 순수 모듈로 분리해 브라우저 없이 테스트한다.

**Tech Stack:** HTML, CSS, 바닐라 JavaScript, YouTube IFrame API, Browser Fullscreen API, Pointer Events, Cloud Firestore, Node.js 내장 테스트 러너

## Global Constraints

- `계속 재생`은 문제 오버레이만 닫고 같은 플레이어에서 이어서 재생한다.
- 홈·전체화면 해제·Esc는 세션을 종료하거나 라우팅하지 않는다.
- 진행 종료만 기존 세션 종료 API를 호출한다.
- QR 조작은 영상, 문제 타이머, live 상태, 응답 구독을 변경하지 않는다.
- 기존 자동 문항, 직접 열기, 학생 응답, 정답 공개, 순위, 대시보드 기능을 유지한다.
- QR 위치는 현재 `pl` 수명 동안만 기억하고 Firestore에는 저장하지 않는다.
- 전체화면 진입 거부 또는 미지원 시 CSS 대체 확장 모드로 동작한다.

---

### Task 1: QR 버블 경계 계산 모듈

**Files:**
- Create: `teacher-stage.js`
- Create: `tests/teacher-stage.test.js`

**Interfaces:**
- Consumes: `{ x, y }`, `{ width, height }`, `{ width, height }`, 선택적 `padding`
- Produces: `TeacherStage.clampBubblePosition(position, bubbleSize, stageSize, padding) -> { x, y }`
- Produces: 브라우저의 `window.TeacherStage`와 Node의 `module.exports`

- [ ] **Step 1: 실패하는 위치 보정 테스트 작성**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const TeacherStage = require('../teacher-stage.js');

test('QR 버블 위치를 전체화면 컨테이너 안으로 제한한다', () => {
  assert.deepEqual(
    TeacherStage.clampBubblePosition(
      { x: 980, y: -20 },
      { width: 260, height: 320 },
      { width: 1200, height: 800 },
      16
    ),
    { x: 924, y: 16 }
  );
});

test('컨테이너가 버블보다 작아도 좌표를 음수로 만들지 않는다', () => {
  assert.deepEqual(
    TeacherStage.clampBubblePosition(
      { x: 100, y: 100 },
      { width: 400, height: 400 },
      { width: 300, height: 300 },
      16
    ),
    { x: 16, y: 16 }
  );
});
```

- [ ] **Step 2: 테스트가 모듈 부재로 실패하는지 확인**

Run: `node --test tests/teacher-stage.test.js`

Expected: FAIL with `Cannot find module '../teacher-stage.js'`

- [ ] **Step 3: 최소 순수 모듈 구현**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TeacherStage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clampBubblePosition(position, bubbleSize, stageSize, padding) {
    const gap = Number.isFinite(padding) ? padding : 16;
    const maxX = Math.max(gap, stageSize.width - bubbleSize.width - gap);
    const maxY = Math.max(gap, stageSize.height - bubbleSize.height - gap);
    return {
      x: Math.min(maxX, Math.max(gap, position.x)),
      y: Math.min(maxY, Math.max(gap, position.y))
    };
  }
  return { clampBubblePosition };
});
```

- [ ] **Step 4: 단위 테스트 실행**

Run: `node --test tests/teacher-stage.test.js`

Expected: PASS 2, FAIL 0

- [ ] **Step 5: 커밋**

```bash
git add teacher-stage.js tests/teacher-stage.test.js
git commit -m "QR 버블의 화면 경계 계산을 추가"
```

### Task 2: 전체화면 스테이지와 도구 모음

**Files:**
- Modify: `index.html:330-430`
- Modify: `index.html:2148-2400`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `pl.player`, `pl.live`, `pl.students`, `pl.code`, `pl.sessionId`, 기존 `plToggleCC()`, `plEndSession()`
- Produces: `plEnterStageFullscreen()`, `plExitStageFullscreen()`, `plGoHomeFromStage()`, `plToggleMute()`, `plHandleFullscreenChange()`
- Produces: `#pl-stage`, `.pl-stage-tools`, `.pl-stage-status`, `#pl-fs-enter`

- [ ] **Step 1: 실패하는 전체화면 상태 테스트 작성**

`tests/firestore-store.test.js`의 기존 VM 테스트 방식으로 다음 계약을 추가한다.

```js
function loadStageFunctions(names, context) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  names.forEach(name => vm.runInNewContext(extractFunction(html, name), context));
  return context;
}

test('교사 전체화면 진입은 기존 플레이어를 재생성하지 않고 stage만 요청한다', async () => {
  let requested = 0;
  const player = { getCurrentTime() { return 42; } };
  const classes = new Set();
  const stage = {
    requestFullscreen() { requested++; return Promise.resolve(); },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); }
    }
  };
  const ctx = loadStageFunctions(['plEnterStageFullscreen'], {
    pl: { player, stageFallback: false },
    toast() {},
    plClampQrBubble() {},
    document: {
      fullscreenElement: null,
      body: { classList: stage.classList },
      getElementById(id) { return id === 'pl-stage' ? stage : null; }
    }
  });

  await ctx.plEnterStageFullscreen();

  assert.equal(requested, 1);
  assert.equal(ctx.pl.player, player);
  assert.equal(ctx.pl.player.getCurrentTime(), 42);
});

test('홈은 확인 후 전체화면만 해제하고 세션을 종료하거나 이동하지 않는다', async () => {
  let exited = 0, ended = 0, routed = 0;
  const classList = { add() {}, remove() {} };
  const ctx = loadStageFunctions(['plExitStageFullscreen', 'plGoHomeFromStage'], {
    confirm() { return true; },
    document: {
      fullscreenElement: {},
      exitFullscreen() { exited++; return Promise.resolve(); },
      getElementById() { return { classList }; },
      body: { classList }
    },
    store: { endSession() { ended++; } },
    go() { routed++; },
    pl: { sessionId: 'session1' }
  });

  await ctx.plGoHomeFromStage();

  assert.equal(exited, 1);
  assert.equal(ended, 0);
  assert.equal(routed, 0);
  assert.ok(ctx.pl);
});
```

- [ ] **Step 2: 새 테스트가 함수 부재로 실패하는지 확인**

Run: `node --test --test-name-pattern="전체화면 진입|홈은 확인" tests/firestore-store.test.js`

Expected: FAIL because `plEnterStageFullscreen` and `plGoHomeFromStage` do not exist

- [ ] **Step 3: 스테이지 DOM과 상태 필드 추가**

`pl` 초기 상태에 다음 필드를 추가한다.

```js
isStageFullscreen: false,
stageFallback: false,
qrOpen: false,
qrPosition: null,
previousVolume: 100
```

`renderPlayRun()`에서 기존 플레이어 카드 내부를 다음 책임으로 구성한다.

```html
<div id="pl-stage">
  <div class="player-box"><div id="pl-player"></div></div>
  <div class="pl-stage-tools">홈 · QR · 자막 · 음량 · 전체화면 해제 · 진행 종료</div>
  <div class="pl-stage-status">현재 시간 · 다음 문항 · 참여 인원</div>
</div>
```

일반 화면의 도구 영역에는 다음 버튼을 추가한다.

```html
<button class="btn sm primary" id="pl-fs-enter" onclick="plEnterStageFullscreen()">⛶ 전체화면 진행</button>
```

`teacher-stage.js`를 `index.html`에서 `index.html` 본문 스크립트보다 먼저 로드한다.

- [ ] **Step 4: Fullscreen API와 대체 모드 구현**

```js
async function plEnterStageFullscreen() {
  const stage = document.getElementById('pl-stage');
  if (!pl || !stage) return;
  try {
    if (stage.requestFullscreen) await stage.requestFullscreen();
    else throw new Error('unsupported');
    pl.stageFallback = false;
  } catch (e) {
    pl.stageFallback = true;
    stage.classList.add('fullscreen-fallback');
    document.body.classList.add('stage-fallback-open');
    toast('브라우저 전체화면을 사용할 수 없어 화면 확장 모드로 열었습니다');
  }
  pl.isStageFullscreen = true;
  plClampQrBubble();
}

async function plExitStageFullscreen() {
  const stage = document.getElementById('pl-stage');
  if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
  if (stage) stage.classList.remove('fullscreen-fallback');
  document.body.classList.remove('stage-fallback-open');
  if (pl) {
    pl.isStageFullscreen = false;
    pl.stageFallback = false;
  }
}

async function plGoHomeFromStage() {
  if (!confirm('전체화면 진행 화면을 나가시겠습니까?\n수업 세션과 학생 응답은 유지됩니다.')) return;
  await plExitStageFullscreen();
}
```

`fullscreenchange`에서는 `document.fullscreenElement !== stage`일 때 UI 플래그와 클래스만 정리한다. 라우팅, `plEndSession()`, 플레이어 파괴를 호출하지 않는다.

- [ ] **Step 5: 음량과 자막 제어 구현**

```js
function plToggleMute() {
  if (!pl || !pl.player) return;
  try {
    if (pl.player.isMuted()) {
      pl.player.unMute();
      pl.player.setVolume(pl.previousVolume || 100);
    } else {
      pl.previousVolume = pl.player.getVolume ? pl.player.getVolume() : 100;
      pl.player.mute();
    }
    plRenderStageControls();
  } catch (e) {
    console.warn('volume', e);
  }
}
```

자막 버튼은 기존 `plToggleCC()`를 그대로 호출한다. 도구 버튼에는 `title`과 `aria-label`을 설정한다.

- [ ] **Step 6: CSS 구현과 테스트 통과 확인**

전체화면·대체 모드에서 `#pl-stage`를 검정 배경의 전체 화면으로 만들고 플레이어를 16:9 범위에서 최대화한다. 도구는 반투명으로 두고 `:hover`, `:focus-within`, `.controls-active`에서 불투명하게 한다.

Run: `node --test --test-name-pattern="전체화면 진입|홈은 확인" tests/firestore-store.test.js`

Expected: PASS

- [ ] **Step 7: 전체 테스트와 커밋**

Run: `node --test tests/*.test.js`

Expected: all tests PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "교사 전체화면 스테이지와 제어 도구를 추가"
```

### Task 3: 문제와 순위 오버레이를 스테이지에 유지

**Files:**
- Modify: `index.html:2280-2710`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `#pl-stage`, 기존 `plRenderOverlay()`, `plToggleBoard()`, `plCloseQuestion()`
- Produces: `plStageRoot() -> HTMLElement`, 스테이지 내부 `#overlay`, 스테이지 내부 `#board-overlay`

- [ ] **Step 1: 실패하는 오버레이 소유권과 계속 재생 테스트 작성**

```js
test('문제와 순위 오버레이는 전체화면 stage 안에 생성된다', () => {
  const appended = [];
  const stage = { appendChild(node) { appended.push(node); }, classList: { add() {}, remove() {} } };
  const body = { appendChild() { throw new Error('body에 붙이면 안 됨'); } };
  const ctx = loadStageFunctions(['plStageRoot', 'plRenderOverlay', 'plToggleBoard'], {
    pl: {
      live: { q: 0 }, students: {}, responses: {},
      set: { title: '세트', settings: { revealMode: 'manual' }, questions: [{ type: 'choice', text: '문제', choices: ['1', '2'] }] }
    },
    document: {
      body,
      getElementById(id) { return id === 'pl-stage' ? stage : null; },
      createElement() { return { id: '', innerHTML: '', querySelector() { return null; } }; }
    },
    qType() { return 'choice'; }, isTextType() { return false; }, hasImage() { return false; },
    esc(value) { return String(value); }, LETTERS: ['A', 'B'], QTYPES: {},
    plRenderOverlayCounts() {}, plRenderQList() {}, plScoreboard() { return []; }
  });

  ctx.plRenderOverlay();
  ctx.plToggleBoard();

  assert.deepEqual(appended.map(x => x.id), ['overlay', 'board-overlay']);
});

test('계속 재생은 전체화면을 유지하고 같은 플레이어를 재생한다', async () => {
  let writes = 0, played = 0, exits = 0;
  const player = { playVideo() { played++; } };
  const ctx = loadStageFunctions(['plCloseQuestion'], {
    pl: { sessionId: 'session1', player },
    plPushBoard() { return Promise.resolve(); },
    document: { fullscreenElement: {} , exitFullscreen() { exits++; } },
    store: { setLive() { writes++; return Promise.resolve(); } }
  });

  await ctx.plCloseQuestion();

  assert.equal(writes, 1);
  assert.equal(played, 1);
  assert.equal(exits, 0);
  assert.equal(ctx.pl.player, player);
});
```

- [ ] **Step 2: 테스트가 body 부착과 기존 계약 차이로 실패하는지 확인**

Run: `node --test --test-name-pattern="오버레이는 전체화면|계속 재생은 전체화면" tests/firestore-store.test.js`

Expected: FAIL because overlays use `document.body`

- [ ] **Step 3: 오버레이 부모를 스테이지로 변경**

```js
function plStageRoot() {
  return document.getElementById('pl-stage') || document.body;
}
```

`plToggleBoard()`와 `plRenderOverlay()`의 새 요소는 `plStageRoot().appendChild(...)`로 추가한다. 정리 함수는 위치와 관계없이 ID로 찾아 제거한다.

- [ ] **Step 4: 문제 상태 CSS를 스테이지 기준으로 변경**

기존 `body.quiz-open` 규칙을 `#pl-stage.quiz-open` 중심으로 바꾼다. `plRenderOverlay()`는 body가 아니라 stage에 `quiz-open` 클래스를 적용한다. 전체화면에서는 영상과 중앙 문제 카드가 안정적으로 같은 컨테이너 안에 남고, 일반 화면에서는 기존 교사 레이아웃을 유지한다.

- [ ] **Step 5: 계속 재생 계약 확인**

`plCloseQuestion()`은 기존 점수판 기록, live 닫기, `pl.player.playVideo()`만 유지한다. `plExitStageFullscreen()`, `go()`, `renderPlayRun()`, 새 `YT.Player()`를 호출하지 않는다.

- [ ] **Step 6: 테스트와 커밋**

Run: `node --test tests/*.test.js`

Expected: all tests PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "문제와 순위를 전체화면 스테이지 안에 유지"
```

### Task 4: 이동 가능한 QR 버블

**Files:**
- Modify: `index.html:330-430`
- Modify: `index.html:2250-2500`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `TeacherStage.clampBubblePosition`, `pl.code`, `pl.sessionId`, `pl.students`, `linkTo()`
- Produces: `plToggleQrBubble()`, `plRenderQrBubble()`, `plStartQrDrag(event)`, `plMoveQrDrag(event)`, `plEndQrDrag(event)`, `plClampQrBubble()`

- [ ] **Step 1: 실패하는 QR 독립성 테스트 작성**

```js
test('QR 버블 열기와 닫기는 영상과 live 상태를 변경하지 않는다', () => {
  let paused = 0, liveWrites = 0;
  const player = { pauseVideo() { paused++; } };
  const ctx = loadStageFunctions(['plToggleQrBubble'], {
    store: { setLive() { liveWrites++; } },
    pl: { qrOpen: false, player, live: { q: 0, openedAt: 1000 } },
    plRenderQrBubble() {}
  });

  ctx.plToggleQrBubble();
  ctx.plToggleQrBubble();

  assert.equal(paused, 0);
  assert.equal(liveWrites, 0);
  assert.deepEqual(ctx.pl.live, { q: 0, openedAt: 1000 });
});

test('학생 수 변경은 열린 QR 버블의 참여 인원을 갱신한다', () => {
  const count = { textContent: '' };
  const ctx = loadStageFunctions(['plRenderQrBubble'], {
    pl: { students: { a: {}, b: {} }, qrOpen: true, code: 'ABC123' },
    document: { getElementById(id) { return id === 'pl-qr-count' ? count : {}; } },
    linkTo() { return 'https://example/#/join/ABC123'; },
    esc(value) { return String(value); }
  });
  ctx.plRenderQrBubble();
  assert.equal(count.textContent, '참여 2명');
});
```

- [ ] **Step 2: 테스트가 함수 부재로 실패하는지 확인**

Run: `node --test --test-name-pattern="QR 버블|QR 버블의 참여" tests/firestore-store.test.js`

Expected: FAIL because QR bubble functions do not exist

- [ ] **Step 3: QR 버블 렌더링 구현**

`#pl-stage` 안에 다음 구조를 필요할 때 한 번 생성한다.

```html
<aside id="pl-qr-bubble" role="dialog" aria-label="학생 참여 QR 코드">
  <div class="pl-qr-head">학생 참여 <button aria-label="QR 닫기">×</button></div>
  <div id="pl-qr-code"></div>
  <strong class="mono">ABC123</strong>
  <div class="pl-qr-url">example/#/join/ABC123</div>
  <div id="pl-qr-count">참여 5명</div>
</aside>
```

기존 오른쪽 코드 패널 QR과 별개로 같은 `joinUrl`을 사용한다. 라이브러리 실패 시 QR 이미지만 생략한다.

- [ ] **Step 4: Pointer Events 드래그 구현**

버블 헤더의 `pointerdown`에서 포인터 ID와 시작 좌표를 저장하고 `setPointerCapture()`를 호출한다. `pointermove`에서 시작 위치와 이동량을 합산한 뒤 `TeacherStage.clampBubblePosition()`으로 보정해 `left`와 `top`을 갱신한다. `pointerup`과 `pointercancel`에서 드래그 상태를 지운다.

```js
pl.qrPosition = TeacherStage.clampBubblePosition(
  { x: drag.startX + event.clientX - drag.pointerX,
    y: drag.startY + event.clientY - drag.pointerY },
  { width: bubble.offsetWidth, height: bubble.offsetHeight },
  { width: stage.clientWidth, height: stage.clientHeight },
  16
);
```

- [ ] **Step 5: 리사이즈와 학생 수 갱신 연결**

`resize`와 `fullscreenchange`에서 `plClampQrBubble()`을 호출한다. `plRenderStudents()` 마지막에는 열린 버블의 `#pl-qr-count`를 현재 학생 수로 갱신한다. cleanup에 이벤트 해제를 등록한다.

- [ ] **Step 6: 테스트와 커밋**

Run: `node --test tests/*.test.js`

Expected: all tests PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "전체화면에 이동 가능한 QR 버블을 추가"
```

### Task 5: 문서, 브라우저 회귀, 배포

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF-2026-08-14.md`

**Interfaces:**
- Consumes: Tasks 1-4의 완성된 전체화면 진행 모드
- Produces: 사용자 안내, 회귀 검증 기록, 공개 GitHub Pages 버전

- [ ] **Step 1: 사용자 문서 갱신**

README 교사 진행 절차에 다음 내용을 추가한다.

```text
전체화면 진행을 누르면 영상·문제·정답·순위가 같은 화면 안에서 이어집니다.
계속 재생은 문제만 닫으며 전체화면과 영상 위치를 유지합니다.
상단 QR 버튼으로 참여 QR을 열고 화면 안에서 드래그할 수 있습니다.
홈과 전체화면 해제는 수업 세션을 종료하지 않습니다.
```

인수인계 문서에는 새 구조, 주요 함수, 테스트 수와 배포 검증 결과를 추가한다.

- [ ] **Step 2: 정적·자동 검증**

Run: `node --test tests/*.test.js`

Expected: all tests PASS

Run: `git diff --check`

Expected: 출력 없음

- [ ] **Step 3: 실제 브라우저 시나리오 검증**

로컬 서버와 인앱 브라우저에서 다음을 확인한다.

1. 교사 세션 생성과 학생 5명 입장
2. 전체화면 진행 진입
3. 영상 재생 위치 기록
4. 첫 문항 자동 또는 직접 열기
5. 제출, 정답 공개, 순위 표시
6. `계속 재생` 후 전체화면 유지와 재생 위치 연속성
7. 영상 재생 중 QR 열기와 마우스 드래그
8. 문제 타이머 중 QR 열기·닫기와 타이머 연속성
9. 가능한 터치 포인터 이벤트를 주입해 같은 드래그 경로 확인
10. 홈 확인 후 일반 교사 화면과 세션·학생·응답 유지
11. 전체화면 재진입 후 같은 플레이어·위치 유지
12. 진행 종료가 기존 확인 후 세션을 종료
13. 콘솔 오류·경고 0건

- [ ] **Step 4: 문서와 구현 커밋**

```bash
git add README.md docs/HANDOFF-2026-08-14.md
git commit -m "교사 전체화면 진행 모드 사용법을 문서화"
```

- [ ] **Step 5: 통합과 공개 배포 검증**

기능 브랜치를 `main`에 병합하고 병합된 트리에서 전체 테스트를 다시 실행한다. `main`을 원격으로 푸시한 뒤 https://shining-jade.github.io/video-quiz/ 에서 전체화면 진입, 문제 종료 후 유지, QR 열기·닫기, 홈 복귀와 콘솔 오류를 재검증한다.
